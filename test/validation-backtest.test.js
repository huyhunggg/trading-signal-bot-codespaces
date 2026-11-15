import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, INTERVALS } from '../src/config.js';
import { ValidationGate, strategyHash, simulationPolicy, groupKey, wilson, validationText } from '../src/validation.js';
import { simulateTrade, recentFrames, backtestSeries, buildReport } from '../src/backtest.js';
import { features } from '../src/indicators.js';
import { SignalEngine } from '../src/engine.js';
import { runDemo } from '../src/demo.js';
import { Market } from '../src/market.js';

const NOW = Date.UTC(2026, 10, 16, 12);
const baseSignal = () => ({ exchange: 'binance', symbol: 'BTCUSDT', timeframe: '15m', side: 'LONG', branch: 'RSI_HOOK', layer: 'CLOSED', observedAt: NOW,
  referencePrice: 100, sl: 98.2, tp1: 100.8, tp2: 101.8, atr: 1 });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-validation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { ...loadConfig({}), dataDir: dir }, gate = new ValidationGate(cfg);
  return { cfg, gate };
}
function report(cfg, changes = {}) {
  const samples = changes.samples ?? 100, wins = changes.wins ?? 90;
  return { schemaVersion: 1, kind: 'historical-validation', strategyHash: strategyHash(cfg), exchange: cfg.exchange,
    generatedAt: NOW - 1000, dataThrough: NOW - 3600000,
    evaluation: { startTime: NOW - 30 * 86400000, purgedHorizon: true }, source: { kind: 'exchange-ohlcv' },
    groups: [{ key: groupKey(baseSignal()), samples, wins, sumNetR: 20, positiveNetR: 30, negativeNetR: 10 }], ...changes };
}
function write(gate, r) { fs.writeFileSync(gate.file, JSON.stringify(r)); gate.lastRead = -Infinity; }
const policy = { ...simulationPolicy(loadConfig({})), feeBps: 0, slippageBps: 0, fundingBpsPer8h: 0, maxHoldBars: 3 };
const bar = (open, high, low, close, i = 0) => ({ open, high, low, close, openTime: i * 900000, endTime: (i + 1) * 900000, volume: 1, closed: true });

test('Wilson uncertainty rejects 80/100 as evidence of a minimum 80% rate', () => {
  assert.ok(wilson(80, 100).lower < 0.8);
  assert.ok(wilson(90, 100).lower > 0.8);
  assert.ok(wilson(5, 5).lower < 0.8);
  assert.equal(wilson(0, 0), null); assert.equal(wilson(101, 100), null);
});
test('missing reports produce unknown rate and never qualify', t => {
  const { gate } = setup(t), v = gate.assess(baseSignal(), NOW);
  assert.equal(v.status, 'MISSING_PROFILE'); assert.equal(v.winRate, null); assert.equal(v.eligible, false);
  assert.match(validationText(v), /chưa đủ dữ liệu/);
});
test('the gate requires minimum sample size, the lower confidence bound and positive net expectancy', t => {
  const { cfg, gate } = setup(t);
  write(gate, report(cfg, { wins: 80 }));
  assert.equal(gate.assess(baseSignal(), NOW).status, 'BELOW_THRESHOLD');
  write(gate, report(cfg, { wins: 40, samples: 40 }));
  assert.equal(gate.assess(baseSignal(), NOW).status, 'INSUFFICIENT_SAMPLES');
  write(gate, report(cfg)); const v = gate.assess(baseSignal(), NOW);
  assert.equal(v.eligible, true); assert.equal(v.winRate, 0.9); assert.equal(v.samples, 100);
  assert.match(validationText(v), /90\.0%/); assert.match(validationText(v), /Wilson 95%/);
  const negative = report(cfg); Object.assign(negative.groups[0], { sumNetR: -10, positiveNetR: 10, negativeNetR: 20 });
  write(gate, negative); assert.equal(gate.assess(baseSignal(), NOW).status, 'NEGATIVE_EXPECTANCY');
});
test('groups cannot borrow rates across coins, direction, timeframe, branch or intrabar layer', t => {
  const { cfg, gate } = setup(t); write(gate, report(cfg));
  for (const change of [{ symbol: 'ETHUSDT' }, { side: 'SHORT' }, { timeframe: '5m' }, { branch: 'PINBAR_RECLAIM' }]) {
    const v = gate.assess({ ...baseSignal(), ...change }, NOW); assert.equal(v.eligible, false); assert.equal(v.winRate, null);
  }
  assert.equal(gate.assess({ ...baseSignal(), layer: 'IMPULSE' }, NOW).status, 'UNSUPPORTED_LAYER');
});
test('future, stale, synthetic and incompatible reports fail closed', t => {
  const { cfg, gate } = setup(t);
  write(gate, report(cfg));
  assert.equal(gate.assess({ ...baseSignal(), observedAt: NOW - 7200000 }, NOW).status, 'FUTURE_DATA');
  write(gate, report(cfg, { generatedAt: NOW + 2000 })); assert.equal(gate.assess(baseSignal(), NOW).status, 'FUTURE_DATA');
  write(gate, report(cfg, { dataThrough: NOW - 8 * 86400000 })); assert.equal(gate.assess(baseSignal(), NOW).status, 'STALE');
  write(gate, report(cfg, { source: { kind: 'synthetic' } })); assert.equal(gate.assess(baseSignal(), NOW).status, 'SYNTHETIC');
  write(gate, report(cfg, { strategyHash: 'other-rules' })); assert.equal(gate.assess(baseSignal(), NOW).status, 'INCOMPATIBLE');
  assert.notEqual(strategyHash(cfg), strategyHash({ ...cfg, validation: { ...cfg.validation, feeBps: 7 } }));
});
test('corrupt statistics invalidate the report, including after a previously valid load', t => {
  const { cfg, gate } = setup(t); write(gate, report(cfg)); assert.equal(gate.assess(baseSignal(), NOW).eligible, true);
  const bad = report(cfg); bad.groups[0].wins = 200; write(gate, bad);
  assert.equal(gate.assess(baseSignal(), NOW).status, 'INVALID_PROFILE');
  fs.writeFileSync(gate.file, '{bad json'); gate.lastRead = -Infinity;
  assert.equal(gate.summary(NOW).status, 'INVALID_PROFILE');
});
test('same-bar SL and TP is a loss under the conservative ordering', () => {
  const r = simulateTrade(baseSignal(), [bar(100, 102, 98, 101)], policy);
  assert.equal(r.reason, 'STOP'); assert.equal(r.won, false); assert.equal(r.tp1, false); assert.equal(r.ambiguous, true);
  assert.ok(Math.abs(r.netPnl + 1.8) < 1e-9);
});
test('TP1 followed by entry stop is NOT automatically a net win after fees', () => {
  const r = simulateTrade(baseSignal(), [bar(100, 101, 99.8, 100.9)], { ...policy, feeBps: 30 });
  assert.equal(r.tp1, true); assert.equal(r.reason, 'BREAK_EVEN_STOP'); assert.equal(r.won, false); assert.ok(r.netPnl < 0);
});
test('split TP1/TP2 gives 1.3 ATR before costs and mirrors correctly for shorts', () => {
  const future = [bar(100, 100.4, 99.9, 100.2), bar(100.3, 101, 100.1, 100.9, 1), bar(101, 102, 100.7, 101.8, 2)];
  const long = simulateTrade(baseSignal(), future, policy);
  assert.equal(long.reason, 'TP2'); assert.ok(Math.abs(long.netPnl - 1.3) < 1e-9);
  const s = { ...baseSignal(), side: 'SHORT', sl: 101.8, tp1: 99.2, tp2: 98.2 };
  const short = simulateTrade(s, future.map(c => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high })), policy);
  assert.equal(short.reason, 'TP2'); assert.ok(Math.abs(short.netPnl - long.netPnl) < 1e-9);
});
test('adverse gaps worsen stops, crossed entry targets are skipped, and incomplete outcomes stay unresolved', () => {
  const loss = simulateTrade(baseSignal(), [bar(97, 97.5, 96, 97)], policy);
  assert.equal(loss.status, 'NOT_ENTERED');
  const gap = simulateTrade(baseSignal(), [bar(100, 100.2, 99.8, 100), bar(97, 98, 96, 97, 1)], policy);
  assert.equal(gap.reason, 'STOP'); assert.ok(Math.abs(gap.netPnl + 3) < 1e-9);
  assert.equal(simulateTrade(baseSignal(), [bar(101, 101.2, 100.9, 101)], policy).status, 'NOT_ENTERED');
  assert.equal(simulateTrade(baseSignal(), [bar(100, 100.2, 99.8, 100.1)], policy).status, 'UNRESOLVED');
  assert.equal(simulateTrade(baseSignal(), [bar(100, 100.2, 99.8, 100.1)], { ...policy, maxHoldBars: 1 }).reason, 'TIME_EXIT');
});
test('fees, slippage and funding all reduce simulated net result', () => {
  const future = [bar(100, 100.4, 99.9, 100.2), bar(100.3, 101, 100.1, 100.9, 1), bar(101, 102, 100.7, 101.8, 2)];
  const raw = simulateTrade(baseSignal(), future, policy);
  for (const costs of [{ feeBps: 6 }, { slippageBps: 2 }, { fundingBpsPer8h: 10 }]) assert.ok(simulateTrade(baseSignal(), future, { ...policy, ...costs }).netPnl < raw.netPnl);
});
test('known opening gaps through profit targets are honored before later intrabar stops', () => {
  const future = [bar(100, 100.3, 99.8, 100.1), bar(102, 103, 97, 100, 1)];
  const r = simulateTrade(baseSignal(), future, policy);
  assert.equal(r.reason, 'TP2'); assert.equal(r.won, true); assert.ok(Math.abs(r.netPnl - 1.3) < 1e-9);
  const partial = simulateTrade(baseSignal(), [future[0], bar(101, 101.1, 97, 99, 1)], policy);
  assert.equal(partial.tp1, true); assert.equal(partial.reason, 'BREAK_EVEN_STOP');
  assert.ok(Math.abs(partial.netPnl - 0.4) < 1e-9);
});
test('backtest rolling inputs exactly match the live indicator implementation', () => {
  const start = Date.UTC(2026, 10, 10), candles = Array.from({ length: 650 }, (_, i) => ({ ...bar(100 + i / 10, 101 + i / 10, 99 + i / 10, 100.1 + i / 10, i), openTime: start + i * 900000, endTime: start + (i + 1) * 900000 }));
  const expected = features(candles).slice(-2), actual = recentFrames(candles);
  for (let i = 0; i < 2; i++) for (const key of ['ema21', 'ema50', 'ema200', 'rsi', 'atr', 'vwap']) assert.equal(actual[i][key], expected[i][key]);
});
test('the entire final holding horizon is purged instead of selecting only fast known wins', () => {
  const cfg = { ...loadConfig({ SYMBOLS: 'BTCUSDT', TIMEFRAMES: '15m' }) };
  const now = Math.floor(Date.now() / 86400000) * 86400000 + 12 * 3600000 + 1000;
  const engine = new SignalEngine(cfg, { now: () => now }); runDemo(engine, cfg);
  const candles = engine.series('BTCUSDT', '15m'), htfCandles = engine.series('BTCUSDT', '1h'), end = candles.at(-1).endTime;
  const options = { cfg, symbol: 'BTCUSDT', timeframe: '15m', candles, htfCandles, evaluationStart: end - 1, dataThrough: end };
  assert.equal(backtestSeries(options).candidates, 0);
  const last = candles.at(-1).close;
  const future = Array.from({ length: 48 }, (_, i) => ({ openTime: end + i * 900000, endTime: end + (i + 1) * 900000, open: last, high: last + 1, low: last - 1, close: last, volume: 100, closed: true }));
  const result = backtestSeries({ ...options, candles: [...candles, ...future], dataThrough: end + 48 * 900000 });
  assert.equal(result.candidates, 1); assert.equal(result.groups[0].samples, 1);
  const dataset = { exchange: cfg.exchange, startTime: end - 7200000, endTime: end + 48 * 900000, source: { kind: 'synthetic' }, series: { 'BTCUSDT:15m': [...candles, ...future], 'BTCUSDT:1h': htfCandles } };
  const r = buildReport(cfg, dataset); assert.equal(r.source.kind, 'synthetic'); assert.equal(r.evaluation.purgedHorizon, true);
});
test('historical download paginates without overlaps for Binance and reversed Bybit responses', async () => {
  for (const exchange of ['binance', 'bybit']) {
    const cfg = loadConfig({ EXCHANGE: exchange }); let requests = 0;
    const market = new Market(cfg, async url => {
      requests++; const q = new URL(url).searchParams;
      const from = Number(q.get(exchange === 'binance' ? 'startTime' : 'start'));
      const until = Number(q.get(exchange === 'binance' ? 'endTime' : 'end'));
      const rows = [];
      for (let t = from; t <= until; t += 300000) rows.push([String(t), '100', '102', '99', '101', '10']);
      return exchange === 'binance' ? rows : { result: { list: rows.reverse() } };
    });
    const rows = await market.candleRange('BTCUSDT', '5m', 0, 1001 * 300000);
    assert.equal(requests, 2); assert.equal(rows.length, 1001); assert.equal(rows[1000].openTime, 1000 * 300000);
  }
});
test('missing historical pages fail instead of reporting an inflated or partial win rate', async () => {
  const market = new Market(loadConfig({}), async () => []);
  await assert.rejects(() => market.candleRange('BTCUSDT', '5m', 0, INTERVALS['5m']), /lịch sử bị thiếu/);
});
