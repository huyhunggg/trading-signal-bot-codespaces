import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadConfig, INTERVALS } from '../src/config.js';
import { SignalEngine } from '../src/engine.js';
import { runLiveSession, pollLatest } from '../src/live-session.js';

const T = Date.UTC(2026, 10, 16, 12);
function bars(tf, end = T) { const ms = INTERVALS[tf]; return Array.from({ length: 650 }, (_, i) => ({ openTime: end - (650 - i) * ms, endTime: end - (649 - i) * ms, open: 100 + i / 10, close: 100.05 + i / 10, high: 100.2 + i / 10, low: 99.9 + i / 10, volume: 100, closed: true })); }
function fixture(wsFails = true) {
  const cfg = { ...loadConfig({ SYMBOLS: 'BTCUSDT', TIMEFRAMES: '5m' }), pollIntervalMs: 20 }, stop = new AbortController(), statuses = [];
  const now = () => T + 1000, engine = new SignalEngine(cfg, { now });
  let latestCalls = 0; const socket = new EventEmitter(); socket.terminate = () => { socket.terminated = true; socket.emit('close'); };
  const market = {
    stream: () => { queueMicrotask(() => socket.emit(wsFails ? 'error' : 'open', wsFails ? new Error('mock WS unavailable') : undefined)); return socket; },
    candles: async (_, tf) => bars(tf),
    latest: async (_, tf) => {
      latestCalls++; const prior = bars(tf).at(-1), close = prior.close + 0.1 + latestCalls / 100;
      return [prior, { openTime: T, endTime: T + INTERVALS[tf], open: prior.close, close, high: close + 0.1, low: prior.close - 0.1, volume: 50, closed: false }];
    },
  };
  return { cfg, stop, statuses, now, engine, socket, market, calls: () => latestCalls };
}
test('a failed WebSocket does not block bootstrap or continuing REST price updates', async () => {
  const f = fixture();
  await runLiveSession({ ...f, serverTime: T, signal: f.stop.signal, onStatus: s => f.statuses.push(s), onReady: () => setTimeout(() => f.stop.abort(), 60) });
  assert.ok(f.statuses.some(s => s.phase === 'SYNCING'));
  assert.ok(f.statuses.some(s => s.phase === 'STREAMING' && s.transport === 'REST_POLL'));
  const row = f.engine.rows.get('BTCUSDT:5m'); assert.ok(Number.isFinite(row.price)); assert.equal(row.priceKind, 'LAST_PRICE'); assert.ok(f.calls() >= 4);
  assert.equal(f.socket.terminated, true);
});
test('a connected WebSocket can degrade to REST without losing market rows', async () => {
  const f = fixture(false);
  await runLiveSession({ ...f, serverTime: T, signal: f.stop.signal, onStatus: s => f.statuses.push(s), onReady: () => {
    setTimeout(() => f.socket.emit('error', new Error('disconnected')), 5); setTimeout(() => f.stop.abort(), 1150);
  } });
  assert.ok(f.statuses.some(s => s.transport === 'WEBSOCKET'));
  assert.ok(f.statuses.some(s => s.transport === 'REST_POLL'));
  assert.equal(f.engine.rows.size, 1);
});
test('polling applies closed HTF data before base candles at an hour boundary', async () => {
  const cfg = loadConfig({ SYMBOLS: 'BTCUSDT' }), order = [];
  await pollLatest({ latest: async (_, tf) => { order.push(tf); return []; } }, { ingest: () => {} }, cfg, () => T);
  assert.deepEqual(order, ['1h', '5m', '15m']);
});
test('REST rate bans propagate for source cooldown instead of fabricating prices', async () => {
  const f = fixture(), original = f.market.latest; let started = false;
  f.market.latest = async (...args) => { if (started) throw Object.assign(new Error('IP ban'), { httpStatus: 418 }); return original(...args); };
  await assert.rejects(() => runLiveSession({ ...f, serverTime: T, signal: f.stop.signal, onStatus: () => {}, onReady: () => { started = true; } }), e => e.httpStatus === 418);
  assert.equal(f.socket.terminated, true);
});
