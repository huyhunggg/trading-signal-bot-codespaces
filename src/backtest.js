import { createHash } from 'node:crypto';
import { INTERVALS } from './config.js';
import { ema, rsi, atr, vwap } from './indicators.js';
import { evaluateClosed, makeSignal } from './strategy.js';
import { groupKey, strategyHash, simulationPolicy } from './validation.js';
import { validateCandle } from './market.js';

// Compute just the causal inputs used by the strategy, using the SAME rolling
// history/SMA seed as the live engine. ADX/RVOL do not participate in entry rules.
export function recentFrames(candles) {
  const closes = candles.map(c => c.close), e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const rs = rsi(closes), at = atr(candles), vw = vwap(candles);
  return candles.slice(-2).map((c, j) => {
    const i = candles.length - Math.min(2, candles.length) + j;
    return { ...c, ema21: e21[i], ema50: e50[i], ema200: e200[i], rsi: rs[i], atr: at[i], vwap: vw[i] };
  });
}

export function simulateTrade(signal, future, policy) {
  const sign = signal.side === 'LONG' ? 1 : -1;
  if (!future.length) return { status: 'UNRESOLVED' };
  const slip = policy.slippageBps / 10000, fee = policy.feeBps / 10000;
  const entry = future[0].open * (1 + sign * slip), initialRisk = sign * (entry - signal.sl);
  if (sign * (future[0].open - signal.sl) <= 0 || sign * (signal.tp1 - future[0].open) <= 0 || initialRisk <= 0 || sign * (signal.tp1 - entry) <= 0) return { status: 'NOT_ENTERED' };
  let remaining = 1, stop = signal.sl, net = -entry * fee, tp1 = false, tp2 = false, ambiguous = false;
  const entryTime = future[0].openTime;
  let exitTime = entryTime, reason = null;
  const exit = (quantity, rawPrice) => {
    const fill = rawPrice * (1 - sign * slip);
    net += quantity * (sign * (fill - entry) - fill * fee); remaining -= quantity;
  };
  for (let i = 0; i < Math.min(future.length, policy.maxHoldBars); i++) {
    const c = future[i];
    exitTime = c.endTime;
    // The open is chronologically known. A gap through TP executes before later
    // intrabar lows; a gap through a stop fills at the worse open price.
    if (sign * (c.open - stop) <= 0) {
      exitTime = c.openTime; exit(remaining, c.open); reason = tp1 ? 'BREAK_EVEN_STOP' : 'STOP'; break;
    }
    if (!tp1 && sign * (c.open - signal.tp1) >= 0) {
      tp1 = true;
      if (signal.tp2 === null) { exitTime = c.openTime; exit(remaining, signal.tp1); reason = 'TP1'; break; }
      exit(0.5, signal.tp1); stop = entry;
    }
    if (tp1 && sign * (c.open - signal.tp2) >= 0) {
      tp2 = true; exitTime = c.openTime; exit(remaining, signal.tp2); reason = 'TP2'; break;
    }
    net -= remaining * entry * policy.fundingBpsPer8h / 10000 * (c.endTime - c.openTime) / 28_800_000;
    const stopHit = sign === 1 ? c.low <= stop : c.high >= stop;
    const target = tp1 ? signal.tp2 : signal.tp1;
    const targetHit = target !== null && (sign === 1 ? c.high >= target : c.low <= target);
    if (stopHit) {
      if (targetHit) ambiguous = true;
      exit(remaining, sign === 1 ? Math.min(c.open, stop) : Math.max(c.open, stop));
      reason = tp1 ? 'BREAK_EVEN_STOP' : 'STOP'; break;
    }
    if (!tp1 && targetHit) {
      tp1 = true;
      if (signal.tp2 === null) { exit(remaining, signal.tp1); reason = 'TP1'; break; }
      exit(0.5, signal.tp1); stop = entry;
      // Within one OHLC candle the ordering after TP1 is unknowable. Use the
      // adverse feasible path rather than inventing a favorable tick sequence.
      const beHit = sign === 1 ? c.low <= stop : c.high >= stop;
      const tp2Hit = sign === 1 ? c.high >= signal.tp2 : c.low <= signal.tp2;
      if (beHit) { ambiguous = true; exit(remaining, stop); reason = 'BREAK_EVEN_STOP'; break; }
      if (tp2Hit) { tp2 = true; exit(remaining, signal.tp2); reason = 'TP2'; break; }
    } else if (tp1 && targetHit) { tp2 = true; exit(remaining, signal.tp2); reason = 'TP2'; break; }
    if (i + 1 === policy.maxHoldBars) { exit(remaining, c.close); reason = 'TIME_EXIT'; }
  }
  if (remaining > 1e-9) return { status: 'UNRESOLVED' };
  return { status: 'RESOLVED', won: net > 1e-10, netPnl: net, netR: net / initialRisk,
    entry, entryTime, exitTime, tp1, tp2, reason, ambiguous };
}

export function checkSeries(candles, tf) {
  if (!Array.isArray(candles) || candles.length < 500) throw new Error(`${tf}: cần ít nhất 500 nến lịch sử.`);
  candles.forEach((c, i) => {
    validateCandle(c, tf);
    if (!c.closed || (i && c.openTime - candles[i - 1].openTime !== INTERVALS[tf])) throw new Error(`${tf}: dữ liệu không liên tục hoặc có nến chưa đóng.`);
  });
}

export function backtestSeries({ cfg, symbol, timeframe, candles, htfCandles, evaluationStart, dataThrough, onTrade = () => {} }) {
  checkSeries(candles, timeframe); checkSeries(htfCandles, cfg.htf);
  const policy = simulationPolicy(cfg), groups = new Map(), lastSignal = new Map(), htfCache = new Map();
  let hi = -1, candidates = 0, skipped = 0, unresolved = 0;
  for (let i = cfg.historyBars - 1; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.endTime < evaluationStart - cfg.rules.barsGap * INTERVALS[timeframe]) continue;
    // Embargo the entire final horizon, even if some fast outcomes are known,
    // so recent fast wins are not selected while slower outcomes are censored.
    if (i + policy.maxHoldBars >= candles.length || candles[i + policy.maxHoldBars].endTime > dataThrough) break;
    while (hi + 1 < htfCandles.length && htfCandles[hi + 1].endTime <= candle.endTime) hi++;
    if (hi < cfg.historyBars - 1 || htfCandles[hi].endTime !== Math.floor(candle.endTime / INTERVALS[cfg.htf]) * INTERVALS[cfg.htf]) continue;
    if (!htfCache.has(hi)) htfCache.set(hi, recentFrames(htfCandles.slice(hi - cfg.historyBars + 1, hi + 1)).at(-1));
    const [prev, current] = recentFrames(candles.slice(i - cfg.historyBars + 1, i + 1));
    const results = evaluateClosed(current, prev, htfCache.get(hi), cfg).filter(r => r.passed);
    for (const result of results) {
      if (i - (lastSignal.get(result.side) ?? -Infinity) < cfg.rules.barsGap) continue;
      lastSignal.set(result.side, i);
      if (candle.endTime < evaluationStart) continue;
      candidates++;
      const signal = makeSignal({ result, candle, symbol, timeframe, cfg, observedAt: candle.endTime, htfEndTime: htfCandles[hi].endTime, layer: 'CLOSED' });
      const trade = simulateTrade(signal, candles.slice(i + 1, i + 1 + policy.maxHoldBars), policy);
      onTrade({ id: signal.id, symbol, timeframe, side: signal.side, branch: signal.branch, signalTime: candle.endTime,
        referencePrice: signal.referencePrice, sl: signal.sl, tp1: signal.tp1, tp2: signal.tp2, ...trade });
      if (trade.status === 'NOT_ENTERED') { skipped++; continue; }
      if (trade.status !== 'RESOLVED') { unresolved++; continue; }
      const key = groupKey(signal);
      const g = groups.get(key) || { key, symbol, timeframe, side: signal.side, branch: signal.branch, layer: 'CLOSED', samples: 0, wins: 0,
        sumNetR: 0, positiveNetR: 0, negativeNetR: 0, ambiguous: 0, timeExits: 0, tp1Hits: 0, tp2Hits: 0 };
      g.samples++; if (trade.won) g.wins++;
      g.sumNetR += trade.netR; g.positiveNetR += Math.max(0, trade.netR); g.negativeNetR += Math.max(0, -trade.netR);
      if (trade.ambiguous) g.ambiguous++; if (trade.reason === 'TIME_EXIT') g.timeExits++;
      if (trade.tp1) g.tp1Hits++; if (trade.tp2) g.tp2Hits++;
      groups.set(key, g);
    }
  }
  return { groups: [...groups.values()], candidates, skipped, unresolved };
}

export function buildReport(cfg, dataset, onProgress = () => {}, onTrade = () => {}) {
  if (dataset.exchange !== cfg.exchange || !Number.isFinite(dataset.startTime) || !Number.isFinite(dataset.endTime) || dataset.endTime <= dataset.startTime) throw new Error('Dataset sai sàn hoặc khoảng thời gian.');
  const evaluationStart = dataset.startTime + (dataset.endTime - dataset.startTime) * 0.7;
  const groups = [], totals = { candidates: 0, skipped: 0, unresolved: 0 };
  for (const symbol of cfg.symbols) for (const timeframe of cfg.timeframes) {
    const candles = dataset.series?.[`${symbol}:${timeframe}`], htfCandles = dataset.series?.[`${symbol}:${cfg.htf}`];
    const result = backtestSeries({ cfg, symbol, timeframe, candles, htfCandles, evaluationStart, dataThrough: dataset.endTime, onTrade });
    groups.push(...result.groups);
    for (const key of Object.keys(totals)) totals[key] += result[key];
    onProgress({ symbol, timeframe, ...totals, groups: groups.length });
  }
  const digest = createHash('sha256').update(JSON.stringify({ version: 'ohlcv-v1', exchange: dataset.exchange, start: dataset.startTime, end: dataset.endTime }));
  // Hash incrementally: avoid a second full copy of months of OHLCV in RAM.
  for (const key of Object.keys(dataset.series).sort()) {
    digest.update('\n' + key + '\n');
    for (const c of dataset.series[key]) digest.update([c.openTime, c.endTime, c.open, c.high, c.low, c.close, c.volume, c.closed ? 1 : 0].join(',') + '\n');
  }
  return { schemaVersion: 1, kind: 'historical-validation', strategyHash: strategyHash(cfg), exchange: cfg.exchange,
    generatedAt: Math.max(Date.now(), dataset.endTime), dataThrough: dataset.endTime,
    evaluation: { startTime: evaluationStart, endTime: dataset.endTime, fraction: 0.3, purgedHorizon: true },
    source: { kind: dataset.source?.kind || 'unverified', provider: dataset.exchange,
      sha256: digest.digest('hex'), hashAlgorithm: 'sha256-ohlcv-v1' },
    policy: simulationPolicy(cfg), groups, totals,
    limitation: 'Tần suất thắng lịch sử của nhóm tương tự, không phải xác suất riêng của lệnh mới. Giữ nguyên quy tắc; không tự tối ưu trên tập kiểm chứng. OHLC không xác định chính xác thứ tự trong nến; dùng đường đi bất lợi. Xung lực chưa được kiểm chứng.' };
}
