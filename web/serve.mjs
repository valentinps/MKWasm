// Local dev server for the WiiCompiled web build. Localhost only: /game serves your own
// extracted disc and must never be exposed.
//   /        -> web/
//   /build/  -> web-build/ (WiiCompiled.js/.wasm/.data)
//   /game/   -> $MKW_GAME_DIR, default ../game/disc next to the repo (extracted DATA: sys/, files/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const gameDir = path.resolve(process.env.MKW_GAME_DIR ?? path.join(root, '..', 'game', 'disc'));
const mounts = [
  ['/build/', path.join(root, 'web-build')],
  ['/game/', gameDir],
  ['/', here],
];
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};
const port = Number(process.env.PORT ?? 8080);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/__log') {
    // Debug aid: the page posts window.mkwLog here; it lands in web-run.log at the repo root.
    const out = fs.createWriteStream(path.join(root, 'web-run.log'));
    req.pipe(out);
    out.on('finish', () => res.writeHead(204).end());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__logline') {
    // Debug aid: beacons survive a page whose main thread never yields again.
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.appendFileSync(path.join(root, 'web-stream.log'), Buffer.concat(chunks));
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__logreset') {
    fs.writeFileSync(path.join(root, 'web-stream.log'), '');
    res.writeHead(204).end();
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const mount = mounts.find(([prefix]) => pathname.startsWith(prefix));
  const file = path.resolve(mount[1], '.' + pathname.slice(mount[0].length - 1));
  if (!file.startsWith(mount[1])) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || end < start) {
        res.writeHead(416, {'Content-Range': `bytes */${stat.size}`}).end();
        return;
      }
      res.writeHead(206, {...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                          'Content-Length': end - start + 1});
      fs.createReadStream(file, {start, end}).pipe(res);
      return;
    }
    res.writeHead(200, {...headers, 'Content-Length': stat.size});
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log(`MKWasm dev server: http://localhost:${port}/`));
