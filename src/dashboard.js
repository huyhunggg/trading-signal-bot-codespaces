import http from 'node:http';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0, settled = false;
    const fail = (status, publicMessage) => { if (settled) return; settled = true; clearTimeout(timer); reject(Object.assign(new Error(publicMessage), { status, publicMessage })); };
    const timer = setTimeout(() => fail(408, 'Yêu cầu hết thời gian. Thử lại.'), 5000);
    req.on('data', chunk => { size += chunk.length; if (size > 4096) { fail(413, 'Cấu hình quá lớn.'); return; } if (!settled) body += chunk; });
    req.on('aborted', () => fail(400, 'Yêu cầu bị gián đoạn.'));
    req.on('error', () => fail(400, 'Không đọc được yêu cầu.'));
    req.on('end', () => {
      if (settled) return;
      try { const data = body ? JSON.parse(body) : {}; settled = true; clearTimeout(timer); resolve(data); }
      catch { fail(400, 'Nội dung cấu hình phải là JSON hợp lệ.'); }
    });
  });
}

export function dashboard(cfg, snapshot, actions = {}) {
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/status-poller.js', ['status-poller.js', 'text/javascript; charset=utf-8']],
    ['/live-desk.js', ['live-desk.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/healthz' && req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
    if (cfg.dashboardPassword) {
      const expected = 'Basic ' + Buffer.from((cfg.dashboardUser || 'bot') + ':' + cfg.dashboardPassword).toString('base64');
      const hash = value => createHash('sha256').update(value || '').digest();
      if (!timingSafeEqual(hash(req.headers.authorization), hash(expected))) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Trading dashboard", charset="UTF-8"' }); res.end('Authentication required'); return; }
    }
    const hostname = (req.headers.host || '').split(':')[0];
    if (['127.0.0.1', 'localhost'].includes(cfg.host) && !['127.0.0.1', 'localhost'].includes(hostname)) { res.writeHead(403); res.end(); return; }
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.method === 'POST' && Object.hasOwn(actions, pathname)) {
      const expectedHost = req.headers['x-forwarded-host'] || req.headers.host;
      let originHost = null;
      try { originHost = req.headers.origin ? new URL(req.headers.origin).host : null; } catch { originHost = 'invalid'; }
      if (!req.headers['content-type']?.startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site' ||
          (originHost && originHost !== expectedHost)) { res.writeHead(403); res.end(); return; }
      try { const data = await jsonBody(req); await actions[pathname](data); res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(snapshot())); }
      catch (e) { res.writeHead(e.status || 500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: e.publicMessage || 'Chưa thực hiện được thao tác. Kiểm tra trạng thái bot.' })); }
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

