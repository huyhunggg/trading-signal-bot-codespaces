import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, atr, adx, vwap, features } from '../src/indicators.js';

test('SMA-seeded EMA and Wilder RSI handle warm-up, flat and monotonic prices', () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(rsi([1, 1, 1, 1]), [null, null, 50, 50]);
  assert.equal(rsi([1, 2, 3, 4]).at(-1), 100);
  assert.equal(rsi([4, 3, 2, 1]).at(-1), 0);
});
test('ATR includes overnight/gap range and Wilder smoothing', () => {
  const a = atr([{ high: 11, low: 9, close: 10 }, { high: 15, low: 14, close: 15 }, { high: 16, low: 14, close: 15 }], 2);
  assert.deepEqual(a, [null, 3.5, 2.75]);
});
test('VWAP resets at UTC midnight and rejects incomplete initial sessions', () => {
  const start = Date.UTC(2026, 10, 15), c = (openTime, p, volume) => ({ openTime, high: p, low: p, close: p, volume });
  assert.deepEqual(vwap([c(start - 300000, 10, 2), c(start, 20, 1), c(start + 300000, 30, 3)]), [null, 20, 27.5]);
  assert.equal(vwap([c(start, 10, 0)])[0], null);
});
test('ADX reaches 100 on monotonic price movement after correct warm-up', () => {
  const bars = Array.from({ length: 50 }, (_, i) => ({ high: 100 + i, low: 99 + i, close: 99.5 + i }));
  const values = adx(bars);
  assert.equal(values[26], null); assert.equal(values[27], 100); assert.equal(values.at(-1), 100);
});
test('adding future candles never changes past features; RVOL excludes current volume', () => {
  const start = Date.UTC(2026, 10, 10);
  const bars = Array.from({ length: 400 }, (_, i) => ({ openTime: start + i * 300000, open: 100 + i / 10, close: 100.1 + i / 10, high: 101 + i / 10, low: 99 + i / 10, volume: i === 300 ? 100 : 10, closed: true }));
  assert.deepEqual(features(bars).slice(0, 300), features(bars.slice(0, 300)));
  assert.equal(features(bars)[300].rvol, 10);
});
