import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, INTERVALS } from '../src/config.js';
import { parseRest, parseStream, validateCandle } from '../src/market.js';
import { SignalEngine } from '../src/engine.js';
import { runDemo } from '../src/demo.js';

const cfg = loadConfig({});
const T = Date.UTC(2026, 10, 15, 12);
function bars(tf, count, end) {
  const ms = INTERVALS[tf];
  return Array.from({ length: count }, (_, i) => ({ openTime: end - (count - i) * ms, endTime: end - (count - i - 1) * ms, open: 100 + i / 10, close: 100.05 + i / 10, high: 100.2 + i / 10, low: 99.9 + i / 10, volume: 10, closed: true }));
}
test('REST adapters normalize ordering, exclusive end times, and remove unfinished candles', () => {
  const rows = [['0','100','102','99','101','3'],['300000','101','102','100','101','4']];
  const binance = parseRest('binance', rows, '5m', 300000);
  assert.equal(binance.length, 1); assert.equal(binance[0].endTime, 300000);
  assert.deepEqual(parseRest('bybit', [...rows].reverse(), '5m', 300000), binance);
  assert.throws(() => validateCandle({ ...binance[0], high: 99 }, '5m'));
});
test('WebSocket adapters respect final flags on both exchanges', () => {
  const b = parseStream('binance', JSON.stringify({ data: { E: 300001, k: { s: 'BTCUSDT', i: '5m', t: 0, o: '100', h: '102', l: '99', c: '101', v: '3', x: true } } }))[0];
  const y = parseStream('bybit', JSON.stringify({ topic: 'kline.5.BTCUSDT', ts: 300001, data: [{ start: 0, open: '100', high: '102', low: '99', close: '101', volume: '3', confirm: false }] }))[0];
  assert.equal(b.candle.closed, true); assert.equal(y.candle.closed, false); assert.equal(y.timeframe, '5m');
});
test('HTF selection uses only the candle that was closed at the base timestamp', () => {
  const e = new SignalEngine(cfg, { now: () => T + 1000 });
  e.seed('BTCUSDT', '1h', bars('1h', 650, T + INTERVALS['1h']));
  assert.equal(e.htfFor('BTCUSDT', T - 1).endTime, T - INTERVALS['1h']);
  assert.equal(e.htfFor('BTCUSDT', T).endTime, T);
});
test('at an H1 boundary the engine waits for the final H1 event', () => {
  const e = new SignalEngine(cfg, { now: () => T + 1000 });
  e.seed('BTCUSDT', '1h', bars('1h', 650, T - INTERVALS['1h']));
  e.seed('BTCUSDT', '5m', bars('5m', 650, T - INTERVALS['5m']));
  const final = bars('5m', 1, T)[0];
  e.ingest({ symbol: 'BTCUSDT', timeframe: '5m', candle: final, eventTime: T });
  assert.equal(e.pending.size, 1); assert.equal(e.closedEvaluated.size, 0);
  e.ingest({ symbol: 'BTCUSDT', timeframe: '1h', candle: bars('1h', 1, T)[0], eventTime: T + 500 });
  assert.equal(e.pending.size, 0); assert.equal(e.closedEvaluated.get('BTCUSDT:5m'), final.openTime);
});
test('live HTF lookup uses event time rather than the future base candle end', () => {
  const e = new SignalEngine(cfg, { now: () => T - 1000 });
  e.seed('BTCUSDT', '1h', bars('1h', 650, T - INTERVALS['1h']));
  e.seed('BTCUSDT', '5m', bars('5m', 650, T - INTERVALS['5m']));
  const partial = { ...bars('5m', 1, T)[0], closed: false };
  e.ingest({ symbol: 'BTCUSDT', timeframe: '5m', candle: partial, eventTime: T - 1000 });
  assert.equal(e.rows.get('BTCUSDT:5m').htfEndTime, T - INTERVALS['1h']);
});
test('history gaps, mutated final candles, stale events and bootstrap are handled safely', () => {
  let signals = 0;
  const e = new SignalEngine(cfg, { now: () => T + 1000, onSignal: () => signals++ });
  const history = bars('5m', 650, T);
  e.seed('BTCUSDT', '5m', history); e.seed('BTCUSDT', '1h', bars('1h', 650, T)); e.refreshRows();
  assert.equal(signals, 0);
  const event = candle => ({ symbol: 'BTCUSDT', timeframe: '5m', candle, eventTime: T });
  e.ingest(event(history.at(-1))); assert.equal(signals, 0);
  assert.throws(() => e.ingest(event({ ...history.at(-1), close: 999 })), /sửa dữ liệu/);
  assert.throws(() => e.ingest(event(bars('5m', 1, T + 900000)[0])), /khoảng trống/);
  e.ingest({ ...event(bars('5m', 1, T + 300000)[0]), eventTime: T - cfg.streamStaleMs - 1 });
  assert.equal(e.series('BTCUSDT', '5m').at(-1).endTime, T);
  assert.throws(() => e.seed('BTCUSDT', '5m', history.filter((_, i) => i !== 50)), /không liên tục/);
});
test('synthetic end-to-end demo produces both LONG/SHORT and both alert layers', () => {
  const now = Math.floor(Date.now() / 86400000) * 86400000 + 12 * 3600000 + 1000;
  const signals = [], e = new SignalEngine(cfg, { now: () => now, onSignal: s => signals.push(s) });
  runDemo(e, cfg);
  assert.equal(e.rows.size, 6);
  for (const layer of ['CLOSED', 'IMPULSE']) for (const side of ['LONG', 'SHORT']) assert.ok(signals.some(s => s.layer === layer && s.side === side));
  assert.equal(e.pending.size, 0);
});
test('configuration rejects unsupported symbols, intervals and incomplete credentials', () => {
  for (const env of [{ EXCHANGE: 'spot' }, { SYMBOLS: 'BAD' }, { TIMEFRAMES: '1m' }, { HTF: '15m' }, { TELEGRAM_BOT_TOKEN: 'fake' }, { PINBAR_ENABLED: 'yes' }]) assert.throws(() => loadConfig(env));
});
