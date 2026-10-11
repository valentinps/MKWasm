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
  mkw_web_start_prefetch__deps: ['$MkwDisc', '$MkwNet'],
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

  // Online play. A page has no raw sockets, so every guest TCP/UDP socket is multiplexed over
  // one WebSocket to the network gateway (web/net-gateway.mjs, which documents the wire
  // format). This replaces the SOCKFS WebSocket backend, which maps each connection to its
  // own ws://host:port URL and cannot receive UDP from peers it never sent to. The C side
  // keeps using plain BSD sockets.
  $MkwNet__deps: ['$SOCKFS', '$FS', '$DNS'],
  $MkwNet__postset: () => { addAtInit('MkwNet.install();'); },
  $MkwNet: {
    ws: null,
    ready: false,
    outbox: [],
    nextId: 1,
    sockets: new Map(),  // gateway id -> sock

    install() {
      SOCKFS.websocket_sock_ops = MkwNet.ops;
    },

    url() {
      if (Module['mkwNetUrl']) return Module['mkwNetUrl'];
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__net`;
    },

    gateway() {
      if (MkwNet.ws) return;
      const ws = new WebSocket(MkwNet.url());
      ws.binaryType = 'arraybuffer';
      MkwNet.ws = ws;
      ws.onopen = () => {
        MkwNet.ready = true;
        for (const message of MkwNet.outbox) ws.send(message);
        MkwNet.outbox = [];
      };
      ws.onmessage = (event) => MkwNet.receive(new Uint8Array(event.data));
      ws.onclose = ws.onerror = () => {
        if (MkwNet.ws !== ws) return;
        err('[net] gateway connection lost');
        MkwNet.ws = null;
        MkwNet.ready = false;
        MkwNet.outbox = [];
        for (const sock of MkwNet.sockets.values()) MkwNet.fail(sock, {{{ cDefs.ECONNRESET }}});
        MkwNet.sockets.clear();
      };
    },

    send(opcode, id, ...parts) {
      let length = 5;
      for (const part of parts) length += part.length;
      const message = new Uint8Array(length);
      message[0] = opcode;
      new DataView(message.buffer).setUint32(1, id);
      let offset = 5;
      for (const part of parts) {
        message.set(part, offset);
        offset += part.length;
      }
      MkwNet.gateway();
      if (MkwNet.ready) MkwNet.ws.send(message);
      else MkwNet.outbox.push(message);
    },

    u16(value) {
      return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
    },

    host(name) {
      const bytes = new TextEncoder().encode(String(name)).subarray(0, 255);
      const out = new Uint8Array(bytes.length + 1);
      out[0] = bytes.length;
      out.set(bytes, 1);
      return out;
    },

    // Guest-visible addresses are dotted IPv4; names map to the stable fake addresses
    // Emscripten's resolver already handed the guest for them.
    guestAddress(name) {
      return /^\d+\.\d+\.\d+\.\d+$/.test(name) ? name : DNS.lookup_name(name);
    },

    register(sock) {
      if (!sock.mkwId) {
        sock.mkwId = MkwNet.nextId++;
        MkwNet.sockets.set(sock.mkwId, sock);
      }
      return sock.mkwId;
    },

    notify(sock, event) {
      if (sock.stream) SOCKFS.emit(event, sock.stream.fd);
    },

    fail(sock, errno) {
      if (errno) sock.error = errno;
      sock.state = 'closed';
      MkwNet.notify(sock, 'close');
    },

    openUdp(sock, port) {
      if (sock.udpOpen) return;
      sock.udpOpen = true;
      MkwNet.send(0x04, MkwNet.register(sock), MkwNet.u16(port || 0));
    },

    receive(message) {
      if (message.length < 5) return;
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const sock = MkwNet.sockets.get(view.getUint32(1));
      if (!sock) return;
      switch (message[0]) {
        case 0x81:  // TCP_OPEN
          sock.state = 'open';
          sock.sport = view.getUint16(5);
          MkwNet.notify(sock, 'open');
          break;
        case 0x82:  // TCP_DATA
          sock.recv_queue.push({addr: sock.daddr, port: sock.dport, data: message.slice(5)});
          MkwNet.notify(sock, 'message');
          break;
        case 0x83:  // CLOSED
          MkwNet.sockets.delete(sock.mkwId);
          MkwNet.fail(sock, view.getInt32(5));
          break;
        case 0x84:  // UDP_OPENED
          if (!sock.sport) sock.sport = view.getUint16(5);
          break;
        case 0x85: {  // UDP_DATA
          const port = view.getUint16(5);
          const hostLength = message[7];
          const host = new TextDecoder().decode(message.subarray(8, 8 + hostLength));
          sock.recv_queue.push({addr: MkwNet.guestAddress(host), port, data: message.slice(8 + hostLength)});
          MkwNet.notify(sock, 'message');
          break;
        }
      }
    },

    ops: {
      poll(sock) {
        let mask = 0;
        if (sock.error) mask |= {{{ cDefs.POLLERR }}};
        if (sock.type === {{{ cDefs.SOCK_DGRAM }}}) {
          mask |= {{{ cDefs.POLLOUT }}};
          if (sock.recv_queue.length) mask |= {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDNORM }}};
          return mask;
        }
        if (sock.recv_queue.length) mask |= {{{ cDefs.POLLIN }}} | {{{ cDefs.POLLRDNORM }}};
        if (sock.state === 'open') mask |= {{{ cDefs.POLLOUT }}};
        if (sock.state === 'closed') {
          // A failed non-blocking connect reports writable; the caller reads SO_ERROR.
          mask |= sock.error ? {{{ cDefs.POLLOUT }}} : ({{{ cDefs.POLLIN }}} | {{{ cDefs.POLLHUP }}} | {{{ cDefs.POLLRDHUP }}});
        }
        return mask;
      },
      ioctl(sock, request, arg) {
        switch (request) {
          case {{{ cDefs.FIONREAD }}}:
            {{{ makeSetValue('arg', '0', 'sock.recv_queue.length ? sock.recv_queue[0].data.length : 0', 'i32') }}};
            return 0;
          case {{{ cDefs.FIONBIO }}}:
            if ({{{ makeGetValue('arg', '0', 'i32') }}}) sock.stream.flags |= {{{ cDefs.O_NONBLOCK }}};
            else sock.stream.flags &= ~{{{ cDefs.O_NONBLOCK }}};
            return 0;
          default:
            return {{{ cDefs.EINVAL }}};
        }
      },
      close(sock) {
        if (sock.mkwId && MkwNet.sockets.has(sock.mkwId)) {
          MkwNet.send(0x03, sock.mkwId);
          MkwNet.sockets.delete(sock.mkwId);
        }
        sock.state = 'closed';
        return 0;
      },
      bind(sock, addr, port) {
        if (sock.saddr !== undefined || sock.sport !== undefined) throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
        sock.saddr = addr;
        sock.sport = port;
        if (sock.type === {{{ cDefs.SOCK_DGRAM }}}) MkwNet.openUdp(sock, port);
      },
      connect(sock, addr, port) {
        if (sock.type === {{{ cDefs.SOCK_DGRAM }}}) {
          sock.daddr = addr;
          sock.dport = port;
          MkwNet.openUdp(sock, 0);
          return;
        }
        if (sock.state === 'connecting') throw new FS.ErrnoError({{{ cDefs.EALREADY }}});
        if (sock.state === 'open') throw new FS.ErrnoError({{{ cDefs.EISCONN }}});
        sock.daddr = addr;
        sock.dport = port;
        sock.state = 'connecting';
        sock.error = null;
        MkwNet.send(0x01, MkwNet.register(sock), MkwNet.u16(port), MkwNet.host(addr));
        // The gateway answers asynchronously; poll() reports writable once it has.
        if (sock.stream.flags & {{{ cDefs.O_NONBLOCK }}}) throw new FS.ErrnoError({{{ cDefs.EINPROGRESS }}});
      },
      listen(sock, backlog) {
        throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
      },
      accept(sock) {
        throw new FS.ErrnoError({{{ cDefs.EOPNOTSUPP }}});
      },
      getname(sock, peer) {
        if (peer) {
          if (sock.daddr === undefined) throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
          return {addr: sock.daddr, port: sock.dport};
        }
        return {addr: sock.saddr || 0, port: sock.sport || 0};
      },
      sendmsg(sock, buffer, offset, length, addr, port) {
        if (ArrayBuffer.isView(buffer)) {
          offset += buffer.byteOffset;
          buffer = buffer.buffer;
        }
        const data = new Uint8Array(buffer, offset, length).slice();
        if (sock.type === {{{ cDefs.SOCK_DGRAM }}}) {
          if (addr === undefined || port === undefined) {
            addr = sock.daddr;
            port = sock.dport;
          }
          if (addr === undefined || port === undefined) throw new FS.ErrnoError({{{ cDefs.EDESTADDRREQ }}});
          MkwNet.openUdp(sock, 0);
          MkwNet.send(0x05, sock.mkwId, MkwNet.u16(port), MkwNet.host(addr), data);
          return length;
        }
        if (sock.state === 'closed') throw new FS.ErrnoError(sock.daddr === undefined ? {{{ cDefs.ENOTCONN }}} : {{{ cDefs.EPIPE }}});
        if (sock.state !== 'connecting' && sock.state !== 'open') throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
        // Writes while still connecting are buffered by the gateway's socket until it connects.
        MkwNet.send(0x02, sock.mkwId, data);
        return length;
      },
      recvmsg(sock, length, flags) {
        const queued = sock.recv_queue[0];
        if (!queued) {
          if (sock.type === {{{ cDefs.SOCK_STREAM }}}) {
            if (sock.state === 'closed') {
              if (sock.error) {
                const errno = sock.error;
                sock.error = null;
                throw new FS.ErrnoError(errno);
              }
              return null;  // orderly end of stream
            }
            if (sock.state !== 'connecting' && sock.state !== 'open') throw new FS.ErrnoError({{{ cDefs.ENOTCONN }}});
          }
          throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});
        }
        const bytes = Math.min(length, queued.data.length);
        const result = {buffer: queued.data.subarray(0, bytes), addr: queued.addr, port: queued.port};
        if (flags & {{{ cDefs.MSG_PEEK }}}) return result;
        if (sock.type === {{{ cDefs.SOCK_STREAM }}} && bytes < queued.data.length) {
          queued.data = queued.data.subarray(bytes);  // the rest stays queued
        } else {
          sock.recv_queue.shift();  // datagrams beyond `length` are truncated, as POSIX does
        }
        return result;
      },
    },
  },
});
