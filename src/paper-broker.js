import fs from 'node:fs';

// Virtual ledger only. This module has no exchange client or order API.
export class PaperBroker {
  constructor({ now = Date.now, file = null, mode = 'PAPER_DEMO' } = {}) {
    this.now = now; this.file = file; this.mode = mode;
    this.state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : this.empty();
    if (this.state.version !== 1 || !Number.isFinite(this.state.balance) || !Array.isArray(this.state.trades) || !Array.isArray(this.state.entries)) throw new Error('Invalid paper ledger');
    this.reason = 'Đang chờ giá để giao dịch bằng tiền ảo.'; this.lastSync = null;
  }
  empty() { return { version: 1, initialBalance: 10000, balance: 10000, position: null, trades: [], entries: [], paused: false, totalFees: 0, seen: [] }; }
  save() {
    if (!this.file) return;
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file);
  }
  reset() { this.state = this.empty(); this.reason = 'Đã bắt đầu lại với 10.000 USDT ảo.'; this.save(); }
  pause() { this.state.paused = true; this.reason = 'Đã tạm dừng mở vị thế ảo; vẫn theo dõi SL/TP của vị thế hiện có.'; this.save(); }
  resume() { this.state.paused = false; this.reason = 'Đang tự giao dịch bằng tiền ảo.'; this.save(); }
  open(signal, quote) {
    const s = this.state, now = this.now(), long = signal.side === 'LONG';
    if (s.paused || s.position || s.seen.includes(signal.id)) return false;
    if (!['LONG', 'SHORT'].includes(signal.side) || !['DEMO_SCRIPT', 'CLOSED'].includes(signal.layer) ||
        !Number.isFinite(quote?.price) || quote.price <= 0 || !Number.isFinite(quote.at) || now - quote.at > 15000 || quote.at > now + 1000 ||
        !Number.isFinite(signal.observedAt) || now - signal.observedAt > 60000 || signal.observedAt > now + 1000 ||
        (signal.layer === 'CLOSED' && (!signal.closed || !Number.isFinite(signal.candleEndTime) || now - signal.candleEndTime > 60000 || signal.candleEndTime > now))) return false;
    const price = quote.price * (long ? 1.0002 : 0.9998), sl = Number(signal.sl), tp = Number(signal.tp1);
    if (!(long ? sl > 0 && sl < price && price < tp : tp > 0 && tp < price && price < sl)) return false;
    const quantity = Math.min(1000 / price, 10 / (Math.abs(price - sl) + price * 0.0012));
    const margin = quantity * price, fee = margin * 0.0006;
    if (!Number.isFinite(quantity) || quantity <= 0 || s.balance < margin + fee) return false;
    const position = { id: signal.id, symbol: signal.symbol, exchange: signal.exchange, side: signal.side, quantity,
      entry: price, mark: quote.price, sl, tp, margin, entryFee: fee, openedAt: now, source: signal.layer, maxHoldMs: signal.layer === 'DEMO_SCRIPT' ? 20000 : 48 * (signal.timeframe === '15m' ? 900000 : 300000) };
    s.balance -= fee; s.totalFees += fee; s.position = position;
    s.entries.unshift({ ...position }); s.entries = s.entries.slice(0, 100);
    s.seen.push(signal.id); s.seen = s.seen.slice(-10000);
    this.reason = `Đã tự mở ${signal.side} ${signal.symbol} bằng tiền ảo.`; this.save(); return true;
  }
  mark(quotes) {
    const p = this.state.position, now = this.now();
    if (!p) return;
    const quote = quotes[p.symbol];
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(quote.at) || quote.at < p.openedAt || now - quote.at > 15000 || quote.at > now + 1000 ||
        (this.mode === 'PAPER_LIVE' && quote.exchange !== p.exchange)) return;
    p.mark = quote.price; this.lastSync = now;
    const long = p.side === 'LONG';
    const stop = long ? quote.price <= p.sl : quote.price >= p.sl;
    const profit = long ? quote.price >= p.tp : quote.price <= p.tp;
    const timeout = now - p.openedAt >= p.maxHoldMs;
    if (!stop && !profit && !timeout) return;
    // Observed ticks, not assumed OHLC paths. Gaps fill at observed price with adverse slippage.
    const exit = quote.price * (long ? 0.9998 : 1.0002), fee = p.quantity * exit * 0.0006;
    const gross = (exit - p.entry) * p.quantity * (long ? 1 : -1), net = gross - p.entryFee - fee;
    this.state.balance += gross - fee; this.state.totalFees += fee;
    this.state.trades.unshift({ ...p, exit, exitFee: fee, pnl: net, closedAt: now, reason: stop ? 'SL' : profit ? 'TP' : 'TIME_EXIT' });
    this.state.trades = this.state.trades.slice(0, 200); this.state.position = null;
    this.reason = `Đã tự đóng ${p.symbol} tại ${stop ? 'SL' : profit ? 'TP' : 'giới hạn thời gian'} · ${net.toFixed(2)} USDT ảo sau phí.`;
    this.save();
  }
  snapshot() {
    const s = this.state, p = s.position;
    const unrealized = p ? (p.mark - p.entry) * p.quantity * (p.side === 'LONG' ? 1 : -1) : 0;
    return { mode: this.mode, status: s.paused ? 'PAUSED' : p ? 'POSITION_OPEN' : 'READY', reason: this.reason,
      initialBalance: s.initialBalance, balance: s.balance, equity: s.balance + unrealized, unrealizedPnl: unrealized,
      realizedPnl: s.balance - s.initialBalance + (p?.entryFee || 0), totalFees: s.totalFees,
      available: s.balance - (p?.margin || 0), positions: p ? [{ ...p }] : [], entries: s.entries,
      trades: s.trades, wins: s.trades.filter(t => t.pnl > 0).length, losses: s.trades.filter(t => t.pnl <= 0).length,
      lastSync: this.lastSync, paused: s.paused };
  }
}
