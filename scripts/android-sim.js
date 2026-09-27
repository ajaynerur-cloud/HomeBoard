/*
 * Stands in for the APK, so you can check the mobile build's behaviour without
 * building one. It serves the bundled app on its own origin — the way Capacitor
 * serves it from https://localhost — and points it at the API cross-origin,
 * through a proxy that plays dead for the first few requests like a sleeping
 * free-tier host.
 *
 *   # terminal 1
 *   APP_ORIGIN=http://localhost:3200 PORT=3100 npm start
 *   # terminal 2
 *   SLEEPY=3 node scripts/android-sim.js
 *   # then open http://localhost:3200
 *
 * You should see HomeBoard's own waking screen, never a holding page, and
 * signup should succeed once the proxy stops playing dead.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

const API = 'http://localhost:3100';
const STATIC_PORT = 3200;
const PROXY_PORT = 3300;

// ---- static host for the bundled app (the APK's own origin) ----
const TYPES = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  if (p === '/config.js') {
    res.writeHead(200, {'Content-Type':'text/javascript'});
    return res.end(`window.HOMEBOARD_API = "http://localhost:${PROXY_PORT}";\n`);
  }
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
}).listen(STATIC_PORT, () => console.log(`bundled app on :${STATIC_PORT}`));

// ---- proxy that plays dead for the first N requests, like a sleeping host ----
let sleepy = Number(process.env.SLEEPY || 0);
http.createServer((req, res) => {
  if (sleepy > 0) {
    sleepy--;
    console.log(`  [proxy] playing dead (${sleepy} left) for ${req.method} ${req.url}`);
    res.writeHead(503, {'Content-Type':'text/html'});
    return res.end('<html><body><h1>Service waking up ...</h1></body></html>');
  }
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const upstream = http.request(API + req.url, {
      method: req.method,
      headers: { ...req.headers, host: 'localhost:3100' },
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    upstream.end(Buffer.concat(body));
  });
}).listen(PROXY_PORT, () => console.log(`sleepy proxy on :${PROXY_PORT} (playing dead ${sleepy}x)`));
