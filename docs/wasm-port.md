# WiiCompiled → WebAssembly: port map

Source surveyed: `wiicompiled/` @ f3df63b (2026-10-09), GPLv3.

## How WiiCompiled is built

| Part | Language / size | Role |
|---|---|---|
| `translator/` | C# (.NET 8), ~34k lines in Core | DOL/REL → IR/SSA → **C++**. Game-agnostic; driven by `projects/mkwii/recomp.yml` + `MAP.txt` (29.8k symbols). |
| `runtime/` | C++, ~30k own lines (+ cryptopp, pugixml, libco, toml11) | HLE of Wii OS/GX/AX/DVD/NAND/net, memory, fibers, input, settings overlay. |
| `aurora-main/` | C++, vendored fork of encounter/aurora | GX → WebGPU (Dawn) renderer, SDL3 windowing/input. |
| `Launcher/` | C# + PowerShell/sh | Disc extraction (nod), drives translate + CMake/Ninja/Clang build. |

Pipeline: `translate-recursive 0x800060A4` → `generate-data-init` → `emit-build-shards` → CMake+Clang.

## Wasm readiness, subsystem by subsystem

### Good news
- **Indirect calls** go through `InvokeIndirectCpu` (`runtime/include/abi_bridge.h:639`) → a registry lookup by guest address. Portable, and maps to `call_indirect`.
- **Memory has a software path.** Every emitted access goes through `memory_access.h` helpers, which already branch on `GuestFlat::RequiresCheckedAccess()` to a page-table + `Memory::Read*/Write*` path (1 MiB pages, MMIO in software). For wasm, make it a compile-time `true` → no mmap, no page protection, no signal handlers.
- **Renderer speaks WebGPU + WGSL** (`aurora-main/lib/webgpu/gpu.cpp`, `lib/gx/shader.cpp`). The `wgpu::` C++ API is what Emscripten's emdawnwebgpu port exposes.
- **Guest threading is cooperative** (`fiber_manager.h`): guest threads switch only at OS yield points. Context switching is isolated in `runtime/src/host_context.cpp` (Win32 fibers / libco / custom asm) → one place to add a wasm backend.
- **Paired singles** use clang `ext_vector_type`, which lowers to wasm SIMD128.

### Blockers / real work
1. **Flat 4 GiB guest space** (`guest_flat_memory.h`): fixed host base, page protections, fault-trap for MMIO, EFB deferred reads and exec-write guard. Has `#error` for unknown archs. → Use checked mode only; replace the trap-based EFB read with explicit checks in the slow path.
2. **Host-arch intrinsics**: `ppc_isa_config.h`, `ppc_isa_float.h`, `ppc_isa_fpenv.h`, `ppc_isa_quantized.h`, `ax_mix_kernels.h` include `<immintrin.h>`/`<arm_neon.h>` and `#error` otherwise. Need a wasm branch (`wasm_simd128.h` or generic vectors).
3. **FPSCR[NI] via MXCSR FTZ/DAZ**: wasm has no FP-mode control and always keeps denormals. If MKW enables NI, flushing must be done in software at the hot paths. Matters for physics determinism (ghosts, online sync). Verify whether MKW sets NI at all before investing.
4. **Fibers**: libco/Win32 fibers don't exist in wasm. Options:
   - Emscripten fibers (Asyncify): simplest, but Asyncify on millions of lines of generated code bloats it and slows it down. Must restrict the instrumented set.
   - JSPI / stack-switching: cleanest when browser support is enough.
   - **One Web Worker per guest thread + baton handoff** (pthreads + SharedArrayBuffer). Fits the cooperative model because only one runs at a time. Needs COOP/COEP headers. Probably the most robust option today.
5. **Host threads**: `ax_mix.cpp` mix worker, `network_deferred.cpp`, `music_attenuation.cpp` (drop it), and stdout pipes in `main.cpp`. Needs pthreads build or restructuring.
6. **Synchronous GPU readback**: `aurora.cpp:571` uses `WaitAny` with a timeout, and the `TimedWaitAny` instance feature is required (`gpu.cpp:525`). Browsers can't block on `mapAsync`. EFB→RAM copies (`efb_ram_copy`, `depth_peek`) need a frame-latency or yield-based design. Dawn-only features (`DawnTogglesDescriptor`, `ImplicitDeviceSynchronization`, IOSurface/MetalFX) must be guarded.
7. **Networking** (`hle/net/*`, mbedtls): no raw sockets → WebSocket relay for Wiimmfi/RWFC. Leave this for last.
8. **Fault/SEH handlers** in `main.cpp` and `guest_flat_memory.cpp`: compile out.
9. **Disc/NAND/config I/O**: needs OPFS (or Emscripten WasmFS on OPFS). The pipeline cache DB is sqlite.

## Distribution constraint
You can't host a translated build. The translator is C# and the backend is a full Clang build. Options for in-browser translation:
- (a) Run the .NET translator in the browser (.NET wasm) and ship clang-in-wasm. Heavy (hundreds of MB, minutes of compile).
- (b) **New backend: IR → wasm bytecode directly** (in Rust or C#), with the runtime precompiled to wasm once (it contains no Nintendo code). The game module is generated client-side and linked against the runtime via imports and a shared memory/table. This is where a Rust rewrite actually pays off: rewrite the *translator backend*, not the game.

## Suggested order
1. Local proof of concept (private, never distributed): get the existing translator output + runtime building with Emscripten.
   1. Make `RequiresCheckedAccess()` a compile-time `true` for `__wasm__` and stub out `GuestFlat`.
   2. Add `__wasm__` branches to the ISA headers; software NI.
   3. Add a `host_context` backend (start with Asyncify fibers just to boot).
   4. Build aurora against emdawnwebgpu; make readback async-tolerant.
   5. Target: title screen.
2. Measure fps. If acceptable, design the IR→wasm backend for real distribution.

## Status (2026-10-11)

The port runs the full game in Chrome/Edge: boot, menus, Grand Prix races, saves (IndexedDB),
audio (AudioWorklet), keyboard and gamepads. Build with `web/build-web.sh`, serve with
`node web/serve.mjs` (localhost only; `/game` serves your own extracted disc).

### Performance (this machine, Luigi Circuit 50cc, 12 karts)
- Menus, title, attract movies: locked 60 fps.
- Racing: 60 fps once the pack spreads out; the bunched start runs ~110 frames per 2 s
  (p95 ~23 ms) at ~16 ms of CPU per frame. The rest is translated guest code at wasm speed
  (flat profile, no single hot spot); the graphics FIFO path is ~11%, audio DSP ~5%.
- VI pacing slips instead of quantizing (`vi.cpp`, `guestBusy`): a frame that needs 18 ms
  takes 18 ms, not 33 ms. Scene loads at race start still take 200-250 ms on the main guest
  thread (on hardware too, behind a fade); audio keeps running through them.
- Things tried that did not help: `-O3` for translated shards (no change), a larger
  indirect-dispatch memo (kept, small), texture decode (negligible, ~5 ms per race start).

### Dev aids (localhost only)
- `?autorace[=seconds][&profile=seconds]`: in-page autopilot into a Grand Prix, holds
  accelerate, optional JS self-profile written to `web-stream.log`. Uses its own save store.
- `?autowfc`, `?autokeys=x,down,...`, `?online`, `?stream`; `web-run.log` mirrors the console.
- `Module._mkw_debug_dump_threads()`, `Module._mkw_debug_read32(addr)`.
- Spike lines (`[web-spike]`) attribute each slow frame: DVD waits, pipeline compiles, the
  longest guest slice and its thread, interrupt services, texture decodes.

### Online play
- Transport works: guest sockets go through `MkwNet` → one WebSocket → `web/net-gateway.mjs`
  (TCP + UDP, real DNS). With `?online` the game reaches `naswii.nintendowifi.net`, completes
  TCP and TLS, and fails certificate verification, as a real Wii does today (error 20100).
- Server side is the open problem. WiiLink WFC requires its client payload (`wl:ver`,
  `wl:sig`); unpatched Wii clients are patched by an exploit that injects PowerPC code, which
  a recompiled game cannot run. Upstream's supported route is Retro Rewind (its payload is
  translated with the game) on Retro WFC. Options: Retro Rewind on the web build, or a native
  port of the WiiLink payload agreed with WiiLink. Claiming the payload version without its
  patches would misrepresent the client to their service, so that is not done.
- The gateway must run where it can reach the internet (`node web/serve.mjs` in a normal
  terminal); a public deployment would need a hosted gateway with abuse limits.
