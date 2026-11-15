import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { evaluateClosed, evaluateImpulse, makeSignal, htfTrend } from '../src/strategy.js';

const cfg = loadConfig({ PINBAR_ENABLED: 'false' });
const long = { closed: true, open: 100.8, close: 101, high: 101.2, low: 100.5, ema21: 102, ema50: 95, ema200: 90, vwap: 102, rsi: 20, atr: 1 };
const prev = { closed: true, rsi: 10 };
const htf = { closed: true, close: 110, ema21: 108, ema50: 105, ema200: 100 };
const passed = (c = long, p = prev, h = htf, config = cfg) => evaluateClosed(c, p, h, config).filter(x => x.passed);
function mirror(c) {
  const out = { ...c };
  for (const k of ['open', 'close', 'ema21', 'ema50', 'ema200', 'vwap']) if (k in out) out[k] = 200 - out[k];
  if ('high' in c) { out.high = 200 - c.low; out.low = 200 - c.high; }
  if ('rsi' in c) out.rsi = 100 - c.rsi;
  return out;
}
test('Hook supports symmetric LONG/SHORT with all conditions', () => {
  assert.equal(passed()[0].branch, 'RSI_HOOK');
  assert.equal(passed(mirror(long), mirror(prev), mirror(htf))[0].side, 'SHORT');
});
test('a partial base candle or partial HTF never qualifies as closed-candle entry', () => {
  assert.equal(passed({ ...long, closed: false }).length, 0);
  assert.equal(passed(long, prev, { ...htf, closed: false }).length, 0);
  assert.equal(htfTrend({ ...htf, close: htf.ema21 }), 'NEUTRAL');
});
test('each Hook constraint blocks independently', () => {
  for (const changes of [{ ema50: 89 }, { vwap: 100 }, { ema21: 100 }, { rsi: 9 }, { open: 101 }, { open: 100.1 }, { atr: 0 }, { vwap: null }]) assert.equal(passed({ ...long, ...changes }).length, 0, JSON.stringify(changes));
  assert.equal(passed(long, { ...prev, rsi: 15 }).length, 0);
  assert.equal(passed(long, prev, { ...htf, close: 99 }).length, 0);
});
test('pin-bar alternative uses wick-zone and reclaim, independently of Hook', () => {
  const c = { ...long, open: 102, close: 103, high: 103.2, low: 100, ema21: 102.5, vwap: 101, atr: 2, rsi: 50 };
  const config = { ...cfg, pinbarEnabled: true };
  const result = passed(c, { ...prev, rsi: 50 }, htf, config)[0];
  assert.equal(result.branch, 'PINBAR_RECLAIM'); assert.equal(result.checks.discount, false); assert.equal(result.checks.hook, false);
  assert.equal(passed(c, prev).length, 0);
  assert.equal(passed({ ...c, low: 102 }, prev, htf, config).length, 0);
  assert.equal(passed({ ...c, atr: 1 }, prev, htf, config).length, 0);
  assert.equal(passed(mirror(c), mirror(prev), mirror(htf), config)[0].side, 'SHORT');
});
test('impulse uses previous closed ATR/EMA and inclusive 1.25 ATR threshold', () => {
  const live = { closed: false, open: 100, close: 102.5, atr: 999 };
  const base = { closed: true, atr: 2, ema200: 90 };
  assert.equal(evaluateImpulse(live, base, 101, htf, cfg).atr, 2);
  assert.equal(evaluateImpulse({ ...live, close: 102.49 }, base, 101, htf, cfg), null);
  assert.equal(evaluateImpulse({ ...live, closed: true }, base, 101, htf, cfg), null);
  assert.equal(evaluateImpulse(live, base, null, htf, cfg), null);
  assert.equal(evaluateImpulse(live, base, 103, htf, cfg), null);
  assert.equal(evaluateImpulse(mirror(live), { ...base, ema200: 110 }, 99, mirror(htf), cfg).side, 'SHORT');
});
test('ATR target distances mirror correctly; alerts do not claim orders executed', () => {
  const signal = makeSignal({ result: { side: 'SHORT', atr: 10, branch: 'RSI_HOOK' }, candle: { openTime: 0, endTime: 300000, close: 100 }, symbol: 'BTCUSDT', timeframe: '5m', cfg, observedAt: 300001, htfEndTime: 0, layer: 'CLOSED' });
  assert.equal(signal.sl, 118); assert.equal(signal.tp1, 92); assert.equal(signal.tp2, 82);
  assert.match(signal.note, /chưa đặt lệnh/);
});
