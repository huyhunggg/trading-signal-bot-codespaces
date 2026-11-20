import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinanceLiveApi } from '../src/binance-live-api.js';
import { RestQueue, readBackoff, saveBackoff, seedBackoff, markRecovery } from '../src/provider-health.js';
import { accountPollMs } from '../src/binance-live-trader.js';
import { getJson } from '../src/market.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const options = { key: 'FAKE_KEY', secret: 'FAKE_SECRET', enabled: true };
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binance-cooldown-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, exchange: 'binance', restIntervalMs: 0 };
}
test('public ban blocks signed reads and writes, including a client created before and after the ban', async t => {
  const cfg = setup(t); let calls = 0;
  const before = new BinanceLiveApi(options, { backoffCfg: cfg, fetcher: async () => { calls++; return new Response('{}'); } });
  const until = Date.now() + 48 * 3600000;
  saveBackoff(cfg, Object.assign(new Error('HTTP 418'), { httpStatus: 418, retryAfterMs: until - Date.now() }));
  const restarted = new BinanceLiveApi(options, { backoffCfg: cfg, fetcher: async () => { calls++; return new Response('{}'); } });
  for (const client of [before, restarted]) {
    await assert.rejects(client.get('/fapi/v3/account'), e => e.cooldown && e.retryAt >= until && e.httpStatus === 418);
    await assert.rejects(client.post('/fapi/v1/order', {}), /COOLDOWN/);
  }
  assert.equal(calls, 0);
});
test('signed ban parses full ban-until from body, persists it and stops public requests without exposing IP/secrets', async t => {
  const cfg = setup(t), until = Date.now() + 48 * 3600000;
  let calls = 0;
  const client = new BinanceLiveApi(options, { backoffCfg: cfg, fetcher: async () => {
    calls++; return new Response(JSON.stringify({ code: -1003, msg: `IP 1.2.3.4 FAKE_SECRET banned until ${until}` }), { status: 418, headers: { 'retry-after': '120' } });
  } });
  await assert.rejects(client.get('/fapi/v3/account'), /BINANCE_-1003/);
  assert.ok(client.retryAt >= until); assert.ok(readBackoff(cfg).retryAt >= until);
  const text = fs.readFileSync(path.join(cfg.dataDir, 'provider-backoff-binance.json'), 'utf8');
  assert.ok(!text.includes('1.2.3.4')); assert.ok(!text.includes('FAKE_SECRET'));
  const queue = new RestQueue(cfg, async () => { calls++; return {}; });
  await assert.rejects(queue.get('https://fapi.binance.com/fapi/v1/time'), e => e.cooldown === true);
  const restarted = new BinanceLiveApi(options, { backoffCfg: cfg, fetcher: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(restarted.get('/fapi/v3/account'), /COOLDOWN/); assert.equal(calls, 1);
});
test('HTML/non-JSON HTTP denials still start a cooldown instead of repeated unknown-error polling', async t => {
  for (const status of [403, 418, 429, 451]) {
    const cfg = setup(t); let calls = 0;
    const client = new BinanceLiveApi(options, { backoffCfg: cfg, fetcher: async () => { calls++; return new Response('<html>denied</html>', { status }); } });
    await assert.rejects(client.get('/fapi/v3/account'), e => e.httpStatus === status);
    await assert.rejects(client.get('/fapi/v3/account'), /COOLDOWN/);
    assert.equal(calls, 1); assert.equal(readBackoff(cfg).httpStatus, status);
  }
});
test('an explicit not-before deadline seeds both clients without contacting Binance and cannot shorten a longer ban', async t => {
  const cfg = setup(t), now = Date.now(), until = now + 600000;
  assert.equal(seedBackoff(cfg, until, now).retryAt, until); // Do not inflate the deadline by a one-hour fallback.
  assert.equal(seedBackoff(cfg, now + 1000, now).retryAt, until);
  let calls = 0;
  const api = new BinanceLiveApi(options, { backoffCfg: cfg, now: () => now, fetcher: async () => { calls++; return new Response('{}'); } });
  await assert.rejects(api.get('/fapi/v3/account'), /COOLDOWN/);
  const queue = new RestQueue(cfg, async () => { calls++; return {}; });
  await assert.rejects(queue.get('unused'), e => e.cooldown === true); assert.equal(calls, 0);
});
test('signed retry resumes only at or after the longest saved deadline, with no automatic request replay', async t => {
  const cfg = setup(t); let now = Date.now(), calls = 0;
  const until = now + 300000; seedBackoff(cfg, until, now);
  const api = new BinanceLiveApi(options, { backoffCfg: cfg, now: () => now, fetcher: async () => { calls++; return new Response('{}'); } });
  now = until - 1; await assert.rejects(api.get('/fapi/v3/account'), /COOLDOWN/); assert.equal(calls, 0);
  now = until; await api.get('/fapi/v3/account'); assert.equal(calls, 1);
});

test('live-mode 418 still blocks both clients after expiry and restart until a connection check clears the hold', async t => {
  const cfg = { ...setup(t), manualBanRecovery: true };
  const now = Date.now();
  saveBackoff(cfg, Object.assign(new Error('HTTP 418'), { httpStatus: 418 }), now - 7200000);
  let calls = 0;
  const api = new BinanceLiveApi(options, { backoffCfg: cfg, fetcher: async () => { calls++; return new Response('{}'); } });
  const market = new RestQueue(cfg, async () => { calls++; return {}; });
  await assert.rejects(api.get('/fapi/v3/account'), /COOLDOWN/);
  await assert.rejects(market.get('unused'), e => e.cooldown === true);
  assert.equal(calls, 0);
  markRecovery(cfg, false);
  await api.get('/fapi/v3/account'); await market.get('unused');
  assert.equal(calls, 2);
});
test('account standby uses 60 seconds, while active trading or existing positions retain 5-second management', () => {
  const trader = { positions: [], options: { enabled: false }, state: { entries: [], paused: true, halt: null } };
  assert.equal(accountPollMs(trader), 60000);
  trader.options.enabled = true; trader.state.paused = false; assert.equal(accountPollMs(trader), 5000);
  trader.state.paused = true; trader.state.entries = [{ status: 'PROTECTED' }]; assert.equal(accountPollMs(trader), 5000);
  trader.state.entries = [{ status: 'CLOSED' }]; assert.equal(accountPollMs(trader), 60000);
  trader.positions = [{ symbol: 'ETHUSDT' }]; assert.equal(accountPollMs(trader), 5000);
});
test('public parser and private parser respect the same longer header/body deadline', async t => {
  const cfg = setup(t), now = Date.now(), until = now + 7200000;
  const response = () => new Response(JSON.stringify({ code: -1003, msg: `IP banned until ${until}` }), { status: 418, headers: { 'retry-after': '120' } });
  let publicWait;
  await assert.rejects(getJson('https://example.test', async () => response(), now), e => { publicWait = e.retryAfterMs; return e.httpStatus === 418; });
  const api = new BinanceLiveApi(options, { backoffCfg: cfg, now: () => now, fetcher: async () => response() });
  await assert.rejects(api.get('/fapi/v3/account'), e => e.retryAfterMs === publicWait);
});

test('Binance -1003 rate/ban payloads also stop both clients when HTTP status is unexpectedly 200', async t => {
  for (const banned of [true, false]) {
    const cfg = setup(t), now = Date.now(), until = now + 7200000;
    const response = () => new Response(JSON.stringify({ code: -1003, msg: banned ? `IP banned until ${until}` : 'Too many requests' }), { status: 200 });
    const api = new BinanceLiveApi(options, { backoffCfg: cfg, now: () => now, fetcher: async () => response() });
    await assert.rejects(api.get('/fapi/v3/account'), e => e.httpStatus === (banned ? 418 : 429));
    await assert.rejects(api.get('/fapi/v3/account'), /COOLDOWN/);
    await assert.rejects(getJson('https://example.test', async () => response(), now), e => e.httpStatus === (banned ? 418 : 429));
  }
});

test('real runner with a pinned deadline makes zero public/private requests, including after restart with a fresh temporary filesystem', { timeout: 25000 }, async t => {
  for (let turn = 0; turn < 2; turn++) {
    const cfg = setup(t), trace = path.join(cfg.dataDir, 'network-trace.txt'), preload = path.join(cfg.dataDir, 'preload.mjs');
    fs.writeFileSync(preload, `import fs from 'node:fs';globalThis.fetch=async()=>{fs.appendFileSync(${JSON.stringify(trace)},'REQUEST\\n');throw Error('NETWORK_FORBIDDEN')};`);
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const until = Date.now() + 120000;
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'src/binance-live-main.js'], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LIVE_DATA_DIR: cfg.dataDir,
        DASHBOARD_PASSWORD: 'testpass', BINANCE_API_KEY: 'FAKE_KEY', BINANCE_API_SECRET: 'FAKE_SECRET', BINANCE_LIVE_ENABLED: 'false', BINANCE_RETRY_NOT_BEFORE: new Date(until).toISOString() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = ''; child.stdout.on('data', s => logs += s); child.stderr.on('data', s => logs += s);
    const headers = { authorization: 'Basic ' + Buffer.from('bot:testpass').toString('base64') };
    try {
      const url = `http://127.0.0.1:${port}/api/status`; let state;
      for (let i = 0; i < 50; i++) { try { state = await (await fetch(url, { headers })).json(); break; } catch { await delay(100); } }
      assert.ok(state, logs); assert.equal(state.status.phase, 'BLOCKED'); assert.equal(state.sources[0].retryAt, until);
      await delay(turn === 0 ? 5600 : 100); // Include an actual account polling tick.
      state = await (await fetch(url, { headers })).json();
      assert.equal(state.trading.accountRetryAt, until); assert.equal(state.trading.entries.length, 0);
      assert.equal(fs.existsSync(trace), false, logs); assert.equal(readBackoff({ ...cfg }).retryAt, until);
    } finally { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } }
  }
});

test('dashboard recovery after expiry sends one public read and stores the new 418 deadline without repeated requests', { timeout: 12000 }, async t => {
  const cfg = setup(t), trace = path.join(cfg.dataDir, 'trace.txt'), preload = path.join(cfg.dataDir, 'preload.mjs');
  const until = Date.now() + 36 * 3600000;
  fs.writeFileSync(preload, `import fs from 'node:fs';
    globalThis.fetch = async (url, opts) => {
      fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({url, auth: !!opts.headers}) + '\\n');
      await new Promise(resolve => setTimeout(resolve, 150));
      return new Response('IP banned until ${until}', { status: 418 });
    };`);
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'src/binance-live-main.js'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LIVE_DATA_DIR: cfg.dataDir,
      DASHBOARD_PASSWORD: 'testpass', BINANCE_API_KEY: 'FAKE_KEY', BINANCE_API_SECRET: 'FAKE_SECRET', BINANCE_LIVE_ENABLED: 'false',
      BINANCE_RETRY_NOT_BEFORE: new Date(Date.now() - 60000).toISOString() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', s => logs += s); child.stderr.on('data', s => logs += s);
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } });
  const headers = { authorization: 'Basic ' + Buffer.from('bot:testpass').toString('base64'), 'content-type': 'application/json' };
  const url = `http://127.0.0.1:${port}/api`; let state;
  for (let i = 0; i < 50; i++) { try { state = await (await fetch(url + '/status', { headers })).json(); break; } catch { await delay(100); } }
  assert.ok(state, logs); assert.equal(state.status.recoveryRequired, true); assert.ok(state.status.retryAt < Date.now());
  await delay(1100);
  assert.equal(fs.existsSync(trace), false, logs);
  const check = () => fetch(url + '/live/check-connection', { method: 'POST', headers, body: '{}' });
  const responses = await Promise.all([check(), check()]);
  assert.deepEqual(responses.map(response => response.status), [409, 409]);
  assert.equal((await check()).status, 409);
  state = await (await fetch(url + '/status', { headers })).json();
  assert.equal(state.status.retryAt, until);
  assert.equal(state.status.recoveryRequired, true);
  assert.equal(readBackoff(cfg).requestKind, 'connection-check');
  assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse), [
    { url: 'https://fapi.binance.com/fapi/v1/time', auth: false },
  ]);
});
