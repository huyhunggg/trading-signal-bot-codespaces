import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { getJson, Market, parseRest, parseRows, parseStream } from '../src/market.js';
import { RestQueue, readBackoff } from '../src/provider-health.js';
import { SourceManager } from '../src/source-manager.js';
import { cachedHistory } from '../src/history-cache.js';

function setup(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-provider-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { ...loadConfig(env), dataDir, restIntervalMs: 0 };
}
const ohlc = t => [String(t), '100', '102', '99', '101', '1000', '10', '1010', '1'];
const rateError = (code, retryAfterMs = 0) => Object.assign(new Error(`HTTP ${code}`), { httpStatus: code, retryAfterMs });
test('418 honors both Retry-After and the longer IP ban timestamp without exposing IP text', async () => {
  const now = Date.UTC(2026, 10, 16), until = now + 7200000;
  const fetcher = async () => new Response(JSON.stringify({ code: -1003, msg: `IP(1.2.3.4) banned until ${until}.` }), { status: 418, headers: { 'retry-after': '120' } });
  await assert.rejects(() => getJson('https://example.test', fetcher, now), e => e.httpStatus === 418 && e.retryAfterMs === 7200000 && !e.message.includes('1.2.3.4'));
});
test('429 supports HTTP date Retry-After and OKX rate errors in HTTP 200 responses', async () => {
  const now = Date.UTC(2026, 10, 16);
  await assert.rejects(() => getJson('https://example.test', async () => new Response('{}', { status: 429, headers: { 'retry-after': new Date(now + 180000).toUTCString() } }), now), e => e.retryAfterMs === 180000);
  await assert.rejects(() => getJson('https://example.test', async () => new Response('{"code":"50011","msg":"rate limit"}')), e => e.httpStatus === 429 && e.retryAfterMs >= 60000);
});
test('REST queue serializes work and a second process/client respects an existing ban', async t => {
  const cfg = setup(t, { EXCHANGE: 'binance' }); let active = 0, maxActive = 0;
  const queue = new RestQueue(cfg, async url => { active++; maxActive = Math.max(active, maxActive); await delay(5); active--; return url; });
  assert.deepEqual(await Promise.all(['a', 'b', 'c'].map(s => queue.get(s))), ['a', 'b', 'c']); assert.equal(maxActive, 1);
  const banned = new RestQueue(cfg, async () => { throw rateError(418, 7200000); });
  await assert.rejects(() => banned.get('a'));
  assert.ok(readBackoff(cfg).retryAt > Date.now() + 7100000);
  let requests = 0; const restarted = new RestQueue(cfg, async () => { requests++; return {}; });
  await assert.rejects(() => restarted.get('b'), e => e.cooldown === true); assert.equal(requests, 0);
});
test('automatic source selection skips banned providers and keeps one consistent active venue', async t => {
  const cfg = setup(t, { EXCHANGE: 'binance' }), calls = [];
  const manager = new SourceManager(cfg, c => ({
    serverTime: async () => { calls.push(c.exchange); if (c.exchange === 'binance') throw rateError(418); return Date.now(); },
    latest: async () => [{ close: 100 }],
  }));
  const first = await manager.choose(); assert.equal(cfg.exchange, 'okx'); assert.equal(first.changed, true);
  assert.deepEqual(calls, ['binance', 'okx']);
  const second = await manager.choose(); assert.equal(second.changed, false); assert.deepEqual(calls, ['binance', 'okx', 'okx']);
  assert.equal(manager.snapshot().find(x => x.exchange === 'binance').state, 'COOLDOWN');
});
test('all unavailable sources pause, and fixed mode never silently changes the requested venue', async t => {
  const cfg = setup(t), calls = [];
  const manager = new SourceManager(cfg, c => ({ serverTime: async () => { calls.push(c.exchange); throw rateError(403); } }));
  await assert.rejects(() => manager.choose(), e => e.noSources && e.retryAt > Date.now());
  const count = calls.length; await assert.rejects(() => manager.choose(), e => e.noSources); assert.equal(calls.length, count);
  const fixed = setup(t, { DATA_SOURCE_MODE: 'fixed', EXCHANGE: 'binance' }), attempts = [];
  await assert.rejects(() => new SourceManager(fixed, c => ({ serverTime: async () => { attempts.push(c.exchange); throw rateError(451); } })).choose());
  assert.deepEqual(attempts, ['binance']);
});
test('OKX uses base-currency volume, exact confirmation flags and partial snapshots', () => {
  const rows = [ohlc(0), [...ohlc(300000).slice(0, 8), '0']];
  const closed = parseRest('okx', rows, '5m', 600000);
  assert.equal(closed.length, 1); assert.equal(closed[0].volume, 10);
  const live = parseRows('okx', rows, '5m', 600000); assert.equal(live[1].closed, false);
  const event = parseStream('okx', JSON.stringify({ arg: { channel: 'candle5m', instId: 'BTC-USDT-SWAP' }, data: [ohlc(0)] }), 300001)[0];
  assert.equal(event.symbol, 'BTCUSDT'); assert.equal(event.candle.closed, true); assert.equal(event.eventTime, 300001);
  assert.deepEqual(parseStream('okx', 'pong'), []);
  assert.throws(() => parseStream('okx', '{"event":"error","code":"60012"}'), /60012/);
});
test('OKX history pagination proceeds backwards without missing or duplicate candles', async t => {
  const cfg = setup(t, { EXCHANGE: 'okx' }), requests = [], rows = Array.from({ length: 650 }, (_, i) => ohlc(i * 300000));
  const market = new Market(cfg, async url => {
    const q = new URL(url).searchParams; requests.push(Number(q.get('after')));
    assert.equal(q.get('instId'), 'BTC-USDT-SWAP'); assert.equal(q.get('bar'), '5m');
    return { code: '0', data: rows.filter(r => Number(r[0]) < Number(q.get('after')) && Number(r[0]) > Number(q.get('before'))).reverse().slice(0, 300) };
  });
  const result = await market.candleRange('BTCUSDT', '5m', 0, 650 * 300000);
  assert.equal(result.length, 650); assert.equal(requests.length, 3);
  assert.ok(requests[0] > requests[1] && requests[1] > requests[2]); assert.equal(result[649].endTime, 650 * 300000);
});
test('historical cache refreshes the tail and new data instead of reloading the entire period', async t => {
  const cfg = setup(t), calls = [], market = { candleRange: async (_, tf, start, end) => {
    calls.push({ start, end });
    return Array.from({ length: (end - start) / 300000 }, (_, i) => parseRows('okx', [ohlc(start + i * 300000)], tf, end)[0]);
  } };
  const first = await cachedHistory(market, cfg, 'BTCUSDT', '5m', 0, 10 * 300000);
  const next = await cachedHistory(market, cfg, 'BTCUSDT', '5m', 0, 12 * 300000);
  assert.equal(first.length, 10); assert.equal(next.length, 12); assert.deepEqual(calls[1], { start: 8 * 300000, end: 12 * 300000 });
});
test('corrupted cached history is ignored and replaced only with a complete real-source result', async t => {
  const cfg = setup(t), dir = path.join(cfg.dataDir, 'history'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'okx-BTCUSDT-5m.json'), '{broken'); let calls = 0;
  const market = { candleRange: async () => { calls++; return []; } };
  await assert.rejects(() => cachedHistory(market, cfg, 'BTCUSDT', '5m', 0, 300000), /thiếu dữ liệu/);
  assert.equal(calls, 1);
});
