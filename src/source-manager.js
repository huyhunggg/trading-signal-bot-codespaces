import { Market } from './market.js';
import { readBackoff, saveBackoff } from './provider-health.js';

export class SourceManager {
  constructor(cfg, factory = c => new Market(c)) { this.cfg = cfg; this.factory = factory; this.active = null; this.health = new Map(); }
  snapshot() {
    return this.cfg.sourceOrder.map(exchange => {
      const saved = readBackoff({ ...this.cfg, exchange }), current = this.health.get(exchange);
      return { exchange, ...(current || {}), ...(saved?.retryAt > Date.now() ? { state: 'COOLDOWN', retryAt: saved.retryAt, httpStatus: saved.httpStatus, reason: saved.reason } : {}) };
    });
  }
  async choose(onAttempt = () => {}) {
    const order = [...new Set([...(this.active ? [this.active] : []), ...this.cfg.sourceOrder])];
    let earliest = Infinity;
    for (const exchange of order) {
      const candidate = { ...this.cfg, exchange }, pause = readBackoff(candidate);
      if (pause?.retryAt > Date.now()) { earliest = Math.min(earliest, pause.retryAt); continue; }
      onAttempt(exchange);
      const market = this.factory(candidate);
      try {
        const before = Date.now(), serverTime = await market.serverTime(), offset = serverTime - (before + Date.now()) / 2;
        if (Math.abs(offset) > 10000) throw new Error('Đồng hồ máy lệch hơn 10 giây so với nguồn giá.');
        const probe = await market.latest(this.cfg.symbols[0], this.cfg.timeframes[0], Date.now() + offset);
        if (!probe.length) throw new Error('Nguồn giá chưa trả được nến thị trường.');
        this.health.set(exchange, { state: 'AVAILABLE', checkedAt: Date.now(), reason: null, httpStatus: null });
        const changed = this.active !== exchange; this.active = exchange; this.cfg.exchange = exchange;
        return { market, serverTime, offset, changed };
      } catch (e) {
        const state = e.cooldown ? { retryAt: e.retryAt, httpStatus: e.httpStatus, reason: e.message } : saveBackoff(candidate, e);
        this.health.set(exchange, { state: 'COOLDOWN', ...state }); earliest = Math.min(earliest, state.retryAt);
      }
    }
    const error = new Error('Các nguồn dữ liệu hiện đang bị giới hạn hoặc chưa kết nối được. Bot đang chờ đúng thời hạn trước khi thử lại.');
    error.retryAt = Number.isFinite(earliest) ? earliest : Date.now() + 60000; error.noSources = true; throw error;
  }
  failed(error) {
    if (!this.active || (!error.httpStatus && !error.network)) return;
    const state = error.cooldown ? { retryAt: error.retryAt, httpStatus: error.httpStatus, reason: error.message } : saveBackoff({ ...this.cfg, exchange: this.active }, error);
    this.health.set(this.active, { state: 'COOLDOWN', ...state });
  }
}
