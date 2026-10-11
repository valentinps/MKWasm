// Network gateway for the WiiCompiled web build. A page has no raw sockets, so the runtime's
// socket layer (MkwNet in runtime/src/platform/web/mkw_web.js) multiplexes every guest TCP
// and UDP socket over one WebSocket to this gateway, which owns the real sockets.
//
// Wire format: binary WebSocket messages, big-endian, first byte an opcode.
//   page -> gateway
//     0x01 TCP_CONNECT  id:u32 port:u16 hostLen:u8 host
//     0x02 TCP_SEND     id:u32 data
//     0x03 CLOSE        id:u32
//     0x04 UDP_OPEN     id:u32 port:u16            (0 = any port)
//     0x05 UDP_SENDTO   id:u32 port:u16 hostLen:u8 host data
//   gateway -> page
//     0x81 TCP_OPEN     id:u32 localPort:u16
//     0x82 TCP_DATA     id:u32 data
//     0x83 CLOSED       id:u32 errno:i32           (0 = orderly end of stream)
//     0x84 UDP_OPENED   id:u32 port:u16
//     0x85 UDP_DATA     id:u32 port:u16 hostLen:u8 host data
//
// UDP_DATA names the sender by the host string the page used to reach it, when it is a peer
// the page sent to (so a guest that resolved a name sees replies from that same name), and by
// its dotted IPv4 address otherwise.
//
// Errno values are the musl/Emscripten ones (ECONNREFUSED 14, ...), since the page hands them
// straight to the guest-facing socket layer.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

const ERRNO = {ECONNREFUSED: 14, ECONNRESET: 15, EHOSTUNREACH: 23, ETIMEDOUT: 73, ENETUNREACH: 40, EIO: 29};
const errnoFor = (error) => ({
  ECONNREFUSED: ERRNO.ECONNREFUSED,
  ECONNRESET: ERRNO.ECONNRESET,
  EPIPE: ERRNO.ECONNRESET,
  ETIMEDOUT: ERRNO.ETIMEDOUT,
  ENOTFOUND: ERRNO.EHOSTUNREACH,
  EAI_AGAIN: ERRNO.EHOSTUNREACH,
  EHOSTUNREACH: ERRNO.EHOSTUNREACH,
  ENETUNREACH: ERRNO.ENETUNREACH,
}[error?.code] ?? ERRNO.EIO);

// --- Minimal RFC 6455 server side (binary messages, no extensions). ---------------------

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function encodeFrame(payload, opcode = 0x2) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

class WebSocketConnection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.parse(onMessage);
    });
    const close = () => {
      if (this.closed) return;
      this.closed = true;
      onClose();
    };
    socket.on('close', close);
    socket.on('error', close);
  }

  parse(onMessage) {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        length = Number(b.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (b.length < offset + length) return;
      const payload = Buffer.from(b.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskOffset + (i & 3)];
      }
      this.buffer = b.subarray(offset + length);
      if (opcode === 0x8) {  // close
        this.socket.end(encodeFrame(Buffer.alloc(0), 0x8));
        return;
      }
      if (opcode === 0x9) {  // ping
        this.socket.write(encodeFrame(payload, 0xa));
        continue;
      }
      if (opcode === 0xa) continue;  // pong
      this.fragments.push(payload);
      if (!fin) continue;
      const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
      this.fragments = [];
      onMessage(message);
    }
  }

  send(payload) {
    if (!this.closed) this.socket.write(encodeFrame(payload));
  }
}

// --- Gateway session: one per page connection. ------------------------------------------

function hostBytes(host) {
  const bytes = Buffer.from(host, 'latin1');
  return bytes.length > 255 ? bytes.subarray(0, 255) : bytes;
}

class GatewaySession {
  constructor(ws, log) {
    this.ws = ws;
    this.log = log;
    this.sockets = new Map();  // id -> {kind: 'tcp'|'udp', socket, peers?: Map<'ip:port', host>}
  }

  reply(opcode, id, ...parts) {
    const head = Buffer.alloc(5);
    head[0] = opcode;
    head.writeUInt32BE(id >>> 0, 1);
    this.ws.send(Buffer.concat([head, ...parts]));
  }

  u16(value) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value & 0xffff);
    return b;
  }

  i32(value) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value | 0);
    return b;
  }

  onMessage(message) {
    if (message.length < 5) return;
    const opcode = message[0];
    const id = message.readUInt32BE(1);
    switch (opcode) {
      case 0x01: {  // TCP_CONNECT
        const port = message.readUInt16BE(5);
        const host = message.subarray(8, 8 + message[7]).toString('latin1');
        this.log(`tcp ${id} connect ${host}:${port}`);
        const socket = net.connect({host, port});
        socket.setNoDelay(true);
        this.sockets.set(id, {kind: 'tcp', socket});
        socket.on('connect', () => this.reply(0x81, id, this.u16(socket.localPort ?? 0)));
        socket.on('data', (data) => this.reply(0x82, id, data));
        let reported = false;
        socket.on('error', (error) => {
          if (reported) return;
          reported = true;
          this.log(`tcp ${id} ${host}:${port} error ${error.code ?? error.message}`);
          this.reply(0x83, id, this.i32(errnoFor(error)));
          this.sockets.delete(id);
        });
        socket.on('close', () => {
          if (reported) return;
          reported = true;
          this.reply(0x83, id, this.i32(0));
          this.sockets.delete(id);
        });
        break;
      }
      case 0x02: {  // TCP_SEND
        const entry = this.sockets.get(id);
        if (entry?.kind === 'tcp') entry.socket.write(message.subarray(5));
        break;
      }
      case 0x03: {  // CLOSE
        const entry = this.sockets.get(id);
        this.sockets.delete(id);
        if (entry?.kind === 'tcp') entry.socket.destroy();
        if (entry?.kind === 'udp') entry.socket.close();
        break;
      }
      case 0x04: {  // UDP_OPEN
        const port = message.readUInt16BE(5);
        const socket = dgram.createSocket('udp4');
        const entry = {kind: 'udp', socket, peers: new Map()};
        this.sockets.set(id, entry);
        socket.on('message', (data, rinfo) => {
          const host = entry.peers.get(`${rinfo.address}:${rinfo.port}`) ?? rinfo.address;
          const name = hostBytes(host);
          this.reply(0x85, id, this.u16(rinfo.port), Buffer.from([name.length]), name, data);
        });
        socket.on('error', (error) => this.log(`udp ${id} error ${error.code ?? error.message}`));
        const bound = () => {
          this.log(`udp ${id} bound :${socket.address().port}`);
          this.reply(0x84, id, this.u16(socket.address().port));
        };
        socket.once('error', () => {
          // The requested port is taken (or privileged): fall back to any port, as the
          // console's own IP stack would hand out an ephemeral one behind NAT anyway.
          if (port !== 0) socket.bind(0, bound);
        });
        socket.bind(port, bound);
        break;
      }
      case 0x05: {  // UDP_SENDTO
        const entry = this.sockets.get(id);
        if (entry?.kind !== 'udp') break;
        const port = message.readUInt16BE(5);
        const hostLength = message[7];
        const host = message.subarray(8, 8 + hostLength).toString('latin1');
        const data = message.subarray(8 + hostLength);
        const send = (address) => {
          entry.peers.set(`${address}:${port}`, host);
          entry.socket.send(data, port, address);
        };
        if (net.isIPv4(host)) {
          send(host);
        } else {
          dns.lookup(host, {family: 4}, (error, address) => {
            if (!error) send(address);
            else this.log(`udp ${id} resolve ${host} failed: ${error.code}`);
          });
        }
        break;
      }
    }
  }

  close() {
    for (const entry of this.sockets.values()) {
      try {
        if (entry.kind === 'tcp') entry.socket.destroy();
        else entry.socket.close();
      } catch {}
    }
    this.sockets.clear();
  }
}

// Handles `upgrade` requests for `path` on an http.Server. The gateway opens arbitrary
// outbound connections on the caller's behalf, so browsers may only reach it from the page's
// own origin: a browser always sends Origin, which keeps other websites out. Clients without
// one are local programs, which could open those sockets themselves anyway.
export function attachNetGateway(server, {path = '/__net', log = () => {}, allowOrigin} = {}) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    const host = req.headers.host;
    const sameOrigin = !origin || (host && (origin === `http://${host}` || origin === `https://${host}`));
    if (url.pathname !== path || !(sameOrigin || (allowOrigin && allowOrigin(origin)))) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                 `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    let session = null;
    const ws = new WebSocketConnection(socket, (message) => session.onMessage(message), () => {
      log('page disconnected');
      session.close();
    });
    session = new GatewaySession(ws, log);
    log('page connected');
  });
}
