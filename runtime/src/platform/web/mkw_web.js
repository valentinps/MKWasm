// Browser host services for the WiiCompiled web build (linked with --js-library).

addToLibrary({
  // Guest fibers on JSPI. Every fiber is a wasm stack parked on its own promise;
  // switching resolves the target's promise and parks the caller. A fiber that has not
  // run yet is started on a fresh stack through a promising trampoline export.
  $MkwFibers: {
    parked: new Map(),
    trampoline: null,
  },

  mkw_fiber_switch__deps: ['$MkwFibers', '$stackRestore'],
  mkw_fiber_switch__async: true,
  mkw_fiber_switch: (source, target, stackTop) => {
    // Park the caller first: the target may switch straight back before we return.
    const parked = new Promise((resolve) => MkwFibers.parked.set(source, resolve));
    if (stackTop) {
      if (!MkwFibers.trampoline) {
        MkwFibers.trampoline = WebAssembly.promising(wasmExports['mkw_fiber_trampoline']);
      }
      // The caller's shadow-stack pointer is restored by HostContext::Switch on resume.
      stackRestore(stackTop);
      MkwFibers.trampoline(target).catch((e) => {
        err(`guest fiber ${target} terminated: ${e?.stack ?? e}`);
        Module['onAbort']?.(e);
      });
    } else {
      const resume = MkwFibers.parked.get(target);
      if (!resume) {
        abort(`mkw_fiber_switch: fiber ${target} is not parked`);
      }
      MkwFibers.parked.delete(target);
      resume();
    }
    return parked;
  },

  // DVD reads (DvdReadContract::ReadExact). Paths under Module.mkwDvdRoot are served from
  // Module.mkwGameUrl with HTTP range requests; the guest fiber is suspended meanwhile.
  mkw_web_read_file__async: true,
  mkw_web_read_file: async (pathPtr, offset, length, destination) => {
    const path = UTF8ToString(pathPtr);
    const root = Module['mkwDvdRoot'] ?? '/dvd';
    if (!path.startsWith(root + '/')) {
      err(`mkw_web_read_file: ${path} is outside the DVD root ${root}`);
      return -1;
    }
    if (length === 0) {
      return 0;
    }
    const url = `${Module['mkwGameUrl'] ?? 'game'}/${path.slice(root.length + 1)}`;
    let response;
    try {
      response = await fetch(url, {headers: {Range: `bytes=${offset}-${offset + length - 1}`}});
    } catch (e) {
      err(`mkw_web_read_file: ${url}: ${e}`);
      return -1;
    }
    if (response.status === 404) return -1;
    if (response.status === 416) return -2;
    if (!response.ok) {
      err(`mkw_web_read_file: ${url}: HTTP ${response.status}`);
      return -1;
    }
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200) {
      // The server ignored Range and sent the whole file.
      if (offset >= bytes.length) return -2;
      bytes = bytes.subarray(offset, offset + length);
    }
    HEAPU8.set(bytes, destination);
    return bytes.length;
  },
});
