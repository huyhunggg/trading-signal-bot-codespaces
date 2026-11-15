import { INTERVALS } from './config.js';
import { features } from './indicators.js';
import { evaluateClosed, evaluateImpulse, htfTrend, makeSignal } from './strategy.js';

export class SignalEngine {
  constructor(cfg, { onSignal, now = Date.now } = {}) {
    this.cfg = cfg; this.onSignal = onSignal || (() => {}); this.now = now;
    this.histories = new Map(); this.pending = new Map(); this.rows = new Map();
    this.lastEvent = new Map(); this.closedEvaluated = new Map(); this.cache = new Map();
  }
  key(symbol, tf) { return `${symbol}:${tf}`; }
  seed(symbol, tf, candles) {
    const ms = INTERVALS[tf];
    if (candles.length < 500 || candles.some((c, i) => !c.closed || (i > 0 && c.openTime - candles[i - 1].openTime !== ms))) throw new Error(`${symbol} ${tf}: lịch sử thiếu hoặc không liên tục; tạm dừng để đồng bộ lại.`);
    this.histories.set(this.key(symbol, tf), candles.slice(-this.cfg.historyBars));
    this.cache.delete(this.key(symbol, tf));
  }
  series(symbol, tf, until = Infinity) { return (this.histories.get(this.key(symbol, tf)) || []).filter(c => c.endTime <= until); }
  calculated(symbol, tf) {
    const key = this.key(symbol, tf);
    if (!this.cache.has(key)) this.cache.set(key, features(this.histories.get(key) || []));
    return this.cache.get(key);
  }
  htfFor(symbol, cutoff) {
    const expected = Math.floor(cutoff / INTERVALS[this.cfg.htf]) * INTERVALS[this.cfg.htf];
    const c = this.calculated(symbol, this.cfg.htf).findLast(c => c.endTime <= cutoff);
    return c?.endTime === expected ? c : null;
  }
  ingest({ symbol, timeframe: tf, candle: c, eventTime }) {
    if (!this.cfg.symbols.includes(symbol) || ![...this.cfg.timeframes, this.cfg.htf].includes(tf)) return false;
    const now = this.now(), key = this.key(symbol, tf), bars = this.histories.get(key);
    if (!bars?.length) throw new Error('Stream received before history bootstrap');
    if (!Number.isFinite(eventTime) || eventTime > now + 10_000) throw new Error('Timestamp dữ liệu không hợp lệ; cần kiểm tra đồng hồ.');
    if (now - eventTime > this.cfg.streamStaleMs) return false;
    if (eventTime < (this.lastEvent.get(key) || 0)) return false;
    this.lastEvent.set(key, eventTime);
    const last = bars.at(-1), ms = INTERVALS[tf];
    if (c.openTime < last.openTime || c.openTime === last.openTime && !c.closed) return false;
    // A closed candle is immutable; a repeated final event cannot change history.
    if (c.openTime === last.openTime) {
      if (['open', 'high', 'low', 'close', 'volume'].some(k => c[k] !== last[k])) throw new Error('Sàn sửa dữ liệu nến đã đóng; đồng bộ lại trước khi phát tín hiệu.');
      return false;
    }
    if (c.openTime !== last.openTime + ms) throw new Error(`${symbol} ${tf}: phát hiện khoảng trống dữ liệu.`);
    if (c.closed) {
      if (c.endTime > now + 1000) throw new Error('Candle marked closed before its end');
      bars.push(c); if (bars.length > this.cfg.historyBars) bars.shift(); this.cache.delete(key);
      if (tf === this.cfg.htf) { this.flushPending(symbol); return true; }
      this.pending.set(`${key}:${c.openTime}`, { symbol, tf, candle: c });
      this.flushPending(symbol);
    } else if (this.cfg.timeframes.includes(tf)) {
      this.intrabar(symbol, tf, c, eventTime);
    }
    return true;
  }
  flushPending(symbol) {
    for (const [key, item] of this.pending) {
      if (item.symbol !== symbol) continue;
      if (this.now() - item.candle.endTime > this.cfg.maxSignalAgeMs) { this.pending.delete(key); continue; }
      const htf = this.htfFor(symbol, item.candle.endTime);
      if (!htf) continue; // At an H1 boundary, wait for its final event rather than use the previous H1.
      this.closed(item.symbol, item.tf, item.candle, htf);
      this.pending.delete(key);
    }
  }
  closed(symbol, tf, candle, htf) {
    const key = this.key(symbol, tf);
    if ((this.closedEvaluated.get(key) || 0) >= candle.openTime) return;
    const frames = this.calculated(symbol, tf), index = frames.findIndex(c => c.openTime === candle.openTime);
    if (index < 1) return;
    const c = frames[index], results = evaluateClosed(c, frames[index - 1], htf, this.cfg);
    this.closedEvaluated.set(key, candle.openTime);
    this.updateRow(symbol, tf, c, htf, results);
    for (const result of results.filter(r => r.passed)) this.onSignal(makeSignal({ result, candle, symbol, timeframe: tf, cfg: this.cfg, observedAt: this.now(), htfEndTime: htf.endTime, layer: 'CLOSED' }));
  }
  intrabar(symbol, tf, live, eventTime) {
    // Partial candle end lies in the future: HTF cutoff MUST be current event time, not that end.
    const htf = this.htfFor(symbol, eventTime), baseline = this.calculated(symbol, tf).at(-1);
    if (!htf) { this.rows.set(this.key(symbol, tf), { symbol, timeframe: tf, price: live.close, updatedAt: this.now(), waiting: 'Đợi H1/H4 đóng và đồng bộ', htf: null }); return; }
    const closedBars = this.histories.get(this.key(symbol, tf));
    const sameDay = closedBars.filter(c => Math.floor(c.openTime / 86_400_000) === Math.floor(live.openTime / 86_400_000));
    let vw = null;
    if ((sameDay[0]?.openTime ?? live.openTime) % 86_400_000 === 0) {
      let pv = 0, vol = 0;
      for (const c of [...sameDay, live]) { pv += (c.high + c.low + c.close) / 3 * c.volume; vol += c.volume; }
      if (vol > 0) vw = pv / vol;
    }
    const results = evaluateClosed(baseline, this.calculated(symbol, tf).at(-2), htf, this.cfg);
    this.updateRow(symbol, tf, baseline, htf, results, live.close);
    const result = evaluateImpulse(live, baseline, vw, htf, this.cfg);
    if (result) this.onSignal(makeSignal({ result, candle: live, symbol, timeframe: tf, cfg: this.cfg, observedAt: this.now(), htfEndTime: htf.endTime, layer: 'IMPULSE' }));
  }
  updateRow(symbol, tf, c, htf, results, livePrice) {
    this.rows.set(this.key(symbol, tf), {
      exchange: this.cfg.exchange, symbol, timeframe: tf, price: livePrice ?? c.close, priceKind: livePrice === undefined ? 'CLOSED_CANDLE' : 'LAST_PRICE', updatedAt: this.now(), lastClosedAt: c.endTime,
      htf: htfTrend(htf), htfEndTime: htf.endTime, rsi: c.rsi, atr: c.atr, vwap: c.vwap,
      adx: c.adx, rvol: c.rvol, ema21: c.ema21, ema50: c.ema50, ema200: c.ema200,
      // These checks describe the last closed candle. Live price is displayed separately.
      closedChecks: results.map(r => ({ side: r.side, checks: r.checks, branch: r.branch, passed: r.passed })),
    });
  }
  refreshRows() {
    for (const symbol of this.cfg.symbols) for (const tf of this.cfg.timeframes) {
      const frames = this.calculated(symbol, tf), c = frames.at(-1), htf = c && this.htfFor(symbol, c.endTime);
      if (c && htf) this.updateRow(symbol, tf, c, htf, evaluateClosed(c, frames.at(-2), htf, this.cfg));
    }
  }
}
