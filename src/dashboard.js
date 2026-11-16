import http from 'node:http';
import fs from 'node:fs';

export function dashboard(cfg, snapshot, actions = {}) {
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  const server = http.createServer((req, res) => {
    const hostname = (req.headers.host || '').split(':')[0];
    if (['127.0.0.1', 'localhost'].includes(cfg.host) && !['127.0.0.1', 'localhost'].includes(hostname)) { res.writeHead(403); res.end(); return; }
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && Object.hasOwn(actions, pathname)) {
      const expectedHost = req.headers['x-forwarded-host'] || req.headers.host;
      let originHost = null;
      try { originHost = req.headers.origin ? new URL(req.headers.origin).host : null; } catch { originHost = 'invalid'; }
      if (!req.headers['content-type']?.startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site' ||
          (originHost && originHost !== expectedHost)) { res.writeHead(403); res.end(); return; }
      try { actions[pathname](); res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(snapshot())); }
      catch { res.writeHead(500); res.end('Paper action failed'); }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (pathname === '/api/status') { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(snapshot())); return; }
    const asset = assets.get(pathname);
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    res.setHeader('content-type', asset[1]); res.end(fs.readFileSync(new URL(`../ui/${asset[0]}`, import.meta.url)));
  });
  return server;
}

