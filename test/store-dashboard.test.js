import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { Store, telegramText } from '../src/store.js';
import { dashboard } from '../src/dashboard.js';

function setup(t, telegram = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { ...loadConfig({}), dataDir: dir, telegramToken: telegram ? 'TEST_TOKEN_NEVER_SENT' : '', telegramChatId: telegram ? '123' : '' };
  return { cfg, store: new Store(cfg) };
}
function signal(openTime = 300000, side = 'LONG', layer = 'CLOSED') {
  return { id: `${openTime}:${side}:${layer}`, exchange: 'binance', symbol: 'BTCUSDT', timeframe: '5m', side, layer, candleOpenTime: openTime, candleEndTime: openTime + 300000, observedAt: openTime + 300001, htfEndTime: 0, referencePrice: 100, sl: 98.2, tp1: 100.8, tp2: 101.8, branch: 'RSI_HOOK', note: 'chưa đặt lệnh' };
}
test('persisted deduplication and directional four-bar gap survive restart', t => {
  const { cfg, store } = setup(t);
  assert.equal(store.accept(signal()), true); assert.equal(new Store(cfg).accept(signal()), false);
  assert.equal(store.accept(signal(300000 * 4)), false);
  assert.equal(store.accept(signal(300000 * 5)), true);
  assert.equal(store.accept(signal(300000 * 2, 'SHORT')), true);
  assert.equal(fs.readFileSync(path.join(cfg.dataDir, 'signals.jsonl'), 'utf8').trim().split('\n').length, 3);
});
test('impulse deduplicates by side/candle and remains independent of official entry gap', t => {
  const { store } = setup(t);
  assert.equal(store.accept(signal()), true);
  assert.equal(store.accept(signal(300000, 'LONG', 'IMPULSE')), true);
  assert.equal(store.accept(signal(300000, 'LONG', 'IMPULSE')), false);
  assert.equal(store.accept(signal(600000, 'LONG', 'IMPULSE')), true);
});
test('outbox persists failures, honors retry timing, then removes delivered alert', async t => {
  const { cfg, store } = setup(t, true), s = signal(); store.accept(s);
  await store.flush(s.observedAt, async () => { throw new Error('injected failure'); });
  assert.equal(store.state.pending[0].attempts, 1);
  const restarted = new Store(cfg); let calls = 0;
  await restarted.flush(s.observedAt + 1000, async () => calls++); assert.equal(calls, 0);
  await restarted.flush(s.observedAt + 2001, async () => calls++); assert.equal(calls, 1);
  assert.equal(restarted.state.pending.length, 0);
  assert.ok(!fs.readFileSync(restarted.file, 'utf8').includes(cfg.telegramToken));
});
test('stale closed-candle alerts expire from candle end, not late detection time', async t => {
  const { store } = setup(t, true), s = signal();
  s.observedAt = s.candleEndTime + 119000; store.accept(s);
  let calls = 0; await store.flush(s.candleEndTime + 121000, async () => calls++);
  assert.equal(calls, 0); assert.equal(store.state.pending.length, 0); assert.equal(store.state.delivery.expired, 1);
});
test('Telegram message distinguishes early alert and displays timezone and costs', () => {
  const text = telegramText(signal(300000, 'LONG', 'IMPULSE'));
  assert.match(text, /NẾN CHƯA ĐÓNG/); assert.match(text, /UTC\+7/); assert.match(text, /funding/);
});
test('dashboard HTTP handler exposes read-only status/assets with CSP and rejects foreign Host', async t => {
  const cfg = loadConfig({}), server = dashboard(cfg, () => ({ demo: true, rows: [], telegram: { configured: false } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(url + '/api/status'); assert.equal(res.status, 200); assert.equal((await res.json()).demo, true);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await (await fetch(url)).text(), /Crypto Signal Monitor/);
  assert.match(await (await fetch(url)).text(), /src="\/app.js" type="module"/);
  const poller = await fetch(url + '/status-poller.js');
  assert.equal(poller.status, 200); assert.match(poller.headers.get('content-type'), /javascript/);
  assert.match(await poller.text(), /refreshStatus/);
  assert.equal((await fetch(url + '/.env')).status, 404);
  assert.equal((await fetch(url + '/api/status', { method: 'POST' })).status, 405);
  // Node fetch normalizes Host; verify the handler with the actual HTTP client.
  const http = await import('node:http');
  const foreign = await new Promise(resolve => http.get(url, { headers: { Host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }));
  assert.equal(foreign, 403);
});

