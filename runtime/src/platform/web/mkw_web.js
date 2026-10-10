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
  // Module.mkwGameUrl with HTTP range requests, through a block cache with read-ahead.
  //
  // A guest DVD read suspends the whole module (JSPI) until it completes, while on a Wii the
  // game keeps running during reads. Streamed data (THP movies, BRSTM music) issues many small
  // sequential reads, so uncached round trips stalled every frame. Cached reads return a plain
  // number, which a Suspending import passes through without suspending at all.
  $MkwDisc: {
    blockSize: 1 << 20,
    maxBytes: 512 << 20,
    blocks: new Map(),   // `${url}#${index}` -> {bytes, promise, used}
    sizes: new Map(),    // url -> file size, learned from Content-Range
    missing: new Set(),  // urls that returned 404
    cachedBytes: 0,
    clock: 0,

    key(url, index) { return `${url}#${index}`; },

    evict() {
      if (MkwDisc.cachedBytes <= MkwDisc.maxBytes) return;
      const entries = [...MkwDisc.blocks.entries()].filter(([, b]) => b.bytes).sort((a, b) => a[1].used - b[1].used);
      for (const [key, block] of entries) {
        if (MkwDisc.cachedBytes <= MkwDisc.maxBytes * 0.8) break;
        MkwDisc.cachedBytes -= block.bytes.length;
        MkwDisc.blocks.delete(key);
      }
    },

    store(url, index, bytes) {
      const key = MkwDisc.key(url, index);
      const block = MkwDisc.blocks.get(key) ?? {};
      block.bytes = bytes;
      block.promise = null;
      block.used = ++MkwDisc.clock;
      MkwDisc.blocks.set(key, block);
      MkwDisc.cachedBytes += bytes.length;
    },

    fetchBlock(url, index) {
      const key = MkwDisc.key(url, index);
      const existing = MkwDisc.blocks.get(key);
      if (existing) return existing.bytes ?? existing.promise;
      const size = MkwDisc.sizes.get(url);
      const start = index * MkwDisc.blockSize;
      if (size !== undefined && start >= size) return null;
      const promise = (async () => {
        const end = start + MkwDisc.blockSize - 1;
        let response;
        try {
          response = await fetch(url, {headers: {Range: `bytes=${start}-${end}`}});
        } catch (e) {
          err(`mkw_web_read_file: ${url}: ${e}`);
          MkwDisc.blocks.delete(key);
          return null;
        }
        if (response.status === 404) {
          MkwDisc.missing.add(url);
          MkwDisc.blocks.delete(key);
          return null;
        }
        if (response.status === 416) {
          const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
          if (total) MkwDisc.sizes.set(url, Number(total[1]));
          MkwDisc.blocks.delete(key);
          return null;
        }
        if (!response.ok) {
          err(`mkw_web_read_file: ${url}: HTTP ${response.status}`);
          MkwDisc.blocks.delete(key);
          return null;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (response.status === 200) {
          // The server ignored Range and sent the whole file: split it into blocks.
          MkwDisc.sizes.set(url, bytes.length);
          MkwDisc.blocks.delete(key);
          for (let i = 0; i * MkwDisc.blockSize < bytes.length; i++) {
            MkwDisc.store(url, i, bytes.subarray(i * MkwDisc.blockSize, (i + 1) * MkwDisc.blockSize));
          }
          MkwDisc.evict();
          return MkwDisc.blocks.get(key)?.bytes ?? null;
        }
        const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
        if (total) MkwDisc.sizes.set(url, Number(total[1]));
        MkwDisc.store(url, index, bytes);
        MkwDisc.evict();
        return bytes;
      })();
      MkwDisc.blocks.set(key, {bytes: null, promise, used: ++MkwDisc.clock});
      return promise;
    },

    // Copies a fully cached range into the heap: the byte count, -2 past the end, or
    // undefined when some block is not cached yet.
    tryCopy(url, offset, length, destination) {
      const size = MkwDisc.sizes.get(url);
      if (size === undefined) return undefined;
      if (offset >= size) return -2;
      const end = Math.min(offset + length, size);
      const first = Math.floor(offset / MkwDisc.blockSize);
      const last = Math.floor((end - 1) / MkwDisc.blockSize);
      for (let i = first; i <= last; i++) {
        if (!MkwDisc.blocks.get(MkwDisc.key(url, i))?.bytes) return undefined;
      }
      let written = 0;
      for (let i = first; i <= last; i++) {
        const block = MkwDisc.blocks.get(MkwDisc.key(url, i));
        block.used = ++MkwDisc.clock;
        const blockStart = i * MkwDisc.blockSize;
        const from = Math.max(offset, blockStart) - blockStart;
        const to = Math.min(end, blockStart + block.bytes.length) - blockStart;
        HEAPU8.set(block.bytes.subarray(from, to), destination + written);
        written += to - from;
      }
      return written;
    },

    // Background warm-up of whole files the game reads at random offsets (the sound archive
    // is read in ~30 scattered pieces when a race starts). Two blocks in flight at a time so
    // foreground reads never queue behind it.
    async prefetchFile(url) {
      if (!MkwDisc.sizes.has(url)) {
        await MkwDisc.fetchBlock(url, 0);
      }
      const size = MkwDisc.sizes.get(url);
      if (size === undefined) return;
      const blocks = Math.ceil(size / MkwDisc.blockSize);
      let next = 0;
      const worker = async () => {
        while (next < blocks) {
          const index = next++;
          await MkwDisc.fetchBlock(url, index);
        }
      };
      await Promise.all([worker(), worker()]);
    },

    // Streaming access is sequential: keep the next block warming while this one is used.
    readAhead(url, offset, length) {
      const next = Math.floor((offset + length) / MkwDisc.blockSize) + 1;
      for (const index of [next - 1, next]) MkwDisc.fetchBlock(url, index);
    },
  },

  // Called once from main(): warms Module.mkwPrefetch (paths relative to the DVD root).
  mkw_web_start_prefetch__deps: ['$MkwDisc'],
  mkw_web_start_prefetch: () => {
    const base = Module['mkwGameUrl'] ?? 'game';
    for (const path of Module['mkwPrefetch'] ?? []) {
      MkwDisc.prefetchFile(`${base}/${path}`).catch((e) => err(`prefetch ${path}: ${e}`));
    }
  },

  mkw_web_read_file__deps: ['$MkwDisc'],
  mkw_web_read_file__async: true,
  mkw_web_read_file: (pathPtr, offset, length, destination) => {
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
    if (MkwDisc.missing.has(url)) return -1;
    const cached = MkwDisc.tryCopy(url, offset, length, destination);
    if (cached !== undefined) {
      if (cached > 0) MkwDisc.readAhead(url, offset, length);
      return cached;
    }
    return (async () => {
      const first = Math.floor(offset / MkwDisc.blockSize);
      const last = Math.floor((offset + length - 1) / MkwDisc.blockSize);
      const pending = [];
      for (let i = first; i <= last; i++) pending.push(MkwDisc.fetchBlock(url, i));
      await Promise.all(pending);
      if (MkwDisc.missing.has(url)) return -1;
      const copied = MkwDisc.tryCopy(url, offset, length, destination);
      if (copied === undefined) {
        err(`mkw_web_read_file: ${url}: read ${offset}+${length} failed`);
        return -1;
      }
      if (copied > 0) MkwDisc.readAhead(url, offset, length);
      return copied;
    })();
  },

  // Spin watchdog (include/platform/web_watchdog.h). `free` is refreshed by a heartbeat that
  // only runs while the main thread is idle, so now - free is how long the page has gone
  // without a turn of its event loop.
  $MkwWatchdog: {
    free: 0,
    started: false,
    reported: false,
  },

  mkw_web_watchdog__deps: ['$MkwWatchdog', '$MkwYield'],
  mkw_web_watchdog__async: true,
  mkw_web_watchdog: () => {
    const now = performance.now();
    if (!MkwWatchdog.started) {
      MkwWatchdog.started = true;
      MkwWatchdog.free = now;
      setInterval(() => {
        MkwWatchdog.free = performance.now();
        MkwWatchdog.reported = false;
      }, 5);
      return 0;
    }
    const stalled = now - MkwWatchdog.free;
    if (stalled < 50) {
      return 0;
    }
    if (stalled > 1000 && !MkwWatchdog.reported) {
      MkwWatchdog.reported = true;
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      err(`[web-watchdog] page busy for ${stalled | 0} ms without yielding; forcing a yield at:\n${new Error().stack}`);
      Error.stackTraceLimit = limit;
    }
    return MkwYield.now().then(() => {
      MkwWatchdog.free = performance.now();
      return 0;
    });
  },

  // Precise yields. Nested setTimeout calls are clamped to >= 4 ms, so the guest's 1 ms VI
  // polling overslept every retrace. A MessageChannel task is not clamped: it lets the event
  // loop run (input, audio, GPU callbacks, compositing) and comes straight back.
  $MkwYield: {
    channel: null,
    waiters: [],
    now() {
      if (!MkwYield.channel) {
        MkwYield.channel = new MessageChannel();
        MkwYield.channel.port1.onmessage = () => MkwYield.waiters.shift()?.();
      }
      return new Promise((resolve) => {
        MkwYield.waiters.push(resolve);
        MkwYield.channel.port2.postMessage(0);
      });
    },
  },

  // Sleeps until `ms` from now with sub-millisecond accuracy: a coarse timer for the bulk,
  // then unclamped yields until the deadline.
  mkw_web_sleep__deps: ['$MkwYield'],
  mkw_web_sleep__async: true,
  mkw_web_sleep: async (ms) => {
    const deadline = performance.now() + ms;
    if (ms > 5) {
      await new Promise((resolve) => setTimeout(resolve, ms - 4));
    }
    do {
      await MkwYield.now();
    } while (performance.now() < deadline);
    return 0;
  },

  // Audio output on an AudioWorklet (see audio_backend.cpp). The processor keeps its own
  // queue on the audio rendering thread, so main-thread stalls no longer starve playback.
  // Queue depth = frames posted - frames the worklet reports as consumed.
  $MkwAudio: {
    ctx: null,
    node: null,
    gainNode: null,
    pending: [],
    posted: 0,
    consumed: 0,
    channels: 2,
    gain: 1,
    processorSource: `
      class MkwPlayer extends AudioWorkletProcessor {
        constructor(options) {
          super();
          this.channels = options.processorOptions.channels;
          this.prebuffer = Math.round(sampleRate * 0.06);
          this.queue = [];
          this.offset = 0;
          this.queued = 0;
          this.consumed = 0;
          this.playing = false;
          this.ticks = 0;
          this.port.onmessage = (e) => { this.queue.push(e.data); this.queued += e.data.length / this.channels; };
        }
        process(inputs, outputs) {
          const out = outputs[0];
          const frames = out[0].length;
          if (!this.playing && this.queued >= this.prebuffer) this.playing = true;
          let i = 0;
          if (this.playing) {
            for (; i < frames && this.queue.length; i++) {
              const buf = this.queue[0];
              for (let c = 0; c < out.length; c++) out[c][i] = buf[this.offset + Math.min(c, this.channels - 1)];
              this.offset += this.channels;
              if (this.offset >= buf.length) { this.queue.shift(); this.offset = 0; }
            }
            this.queued -= i;
            this.consumed += i;
            if (!this.queue.length) this.playing = false;  // underrun: rebuild the prebuffer
          }
          for (; i < frames; i++) for (let c = 0; c < out.length; c++) out[c][i] = 0;
          if ((++this.ticks & 7) === 0) this.port.postMessage(this.consumed);
          return true;
        }
      }
      registerProcessor('mkw-player', MkwPlayer);`,

    async start(rate, channels) {
      const ctx = new AudioContext({sampleRate: rate, latencyHint: 'interactive'});
      MkwAudio.ctx = ctx;
      MkwAudio.channels = channels;
      // Debug aid: window.Module.mkwAudioState() from the console.
      Module['mkwAudioState'] = () => ({
        state: ctx.state, rate: ctx.sampleRate, posted: MkwAudio.posted, consumed: MkwAudio.consumed,
        queuedMs: Math.round(1000 * (MkwAudio.posted - MkwAudio.consumed) / ctx.sampleRate),
      });
      const resume = () => { if (ctx.state !== 'running') ctx.resume(); };
      for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, resume, {capture: true});
      resume();
      const url = URL.createObjectURL(new Blob([MkwAudio.processorSource], {type: 'text/javascript'}));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'mkw-player', {
        numberOfInputs: 0, outputChannelCount: [channels], processorOptions: {channels},
      });
      node.port.onmessage = (e) => { MkwAudio.consumed = e.data; };
      const gainNode = ctx.createGain();
      gainNode.gain.value = MkwAudio.gain;
      node.connect(gainNode).connect(ctx.destination);
      MkwAudio.gainNode = gainNode;
      MkwAudio.node = node;
      for (const block of MkwAudio.pending) node.port.postMessage(block, [block.buffer]);
      MkwAudio.pending = [];
    },
  },

  mkw_web_audio_open__deps: ['$MkwAudio'],
  mkw_web_audio_open: (rate, channels) => {
    if (MkwAudio.ctx) return;
    MkwAudio.start(rate, channels).catch((e) => err(`audio worklet: ${e}`));
  },

  mkw_web_audio_push__deps: ['$MkwAudio'],
  mkw_web_audio_push: (samplesPtr, frames) => {
    const count = frames * MkwAudio.channels;
    const block = new Float32Array(count);
    const src = HEAP16.subarray(samplesPtr >> 1, (samplesPtr >> 1) + count);
    for (let i = 0; i < count; i++) block[i] = src[i] / 32768;
    MkwAudio.posted += frames;
    if (MkwAudio.node) MkwAudio.node.port.postMessage(block, [block.buffer]);
    else MkwAudio.pending.push(block);
  },

  mkw_web_audio_queued_frames__deps: ['$MkwAudio'],
  mkw_web_audio_queued_frames: () => Math.max(0, MkwAudio.posted - MkwAudio.consumed),

  mkw_web_audio_set_gain__deps: ['$MkwAudio'],
  mkw_web_audio_set_gain: (gain) => {
    MkwAudio.gain = gain;
    if (MkwAudio.gainNode) MkwAudio.gainNode.gain.value = gain;
  },
});
