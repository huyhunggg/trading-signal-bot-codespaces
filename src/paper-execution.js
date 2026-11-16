// Signal generation and simulated execution are separate: fills must use a fresh
// public quote received after the signal, never the historical candle close.
export class PaperExecution {
  constructor(broker, exchange, { now = Date.now } = {}) {
    this.broker = broker; this.exchange = exchange; this.now = now; this.pending = null; this.quotes = {};
  }
  enqueue(signal) {
    const now = this.now();
    if (signal.exchange !== this.exchange || signal.layer !== 'CLOSED' || !signal.closed || this.broker.state.paused || this.broker.state.position ||
        this.pending || !Number.isFinite(signal.observedAt) || signal.observedAt > now + 1000 || now - signal.observedAt > 60000 ||
        !Number.isFinite(signal.candleEndTime) || signal.candleEndTime > now || now - signal.candleEndTime > 60000) return false;
    this.pending = { ...signal, receivedAt: now }; return true;
  }
  update(quote) {
    const now = this.now();
    if (quote.exchange !== this.exchange || !Number.isFinite(quote.at) || now - quote.at > 15000 || quote.at > now + 1000) return;
    this.quotes[quote.symbol] = quote;
    this.broker.mark({ [quote.symbol]: quote });
    const s = this.pending;
    if (!s) return;
    if (this.broker.state.paused || now - s.candleEndTime > 60000) { this.pending = null; return; }
    if (quote.symbol !== s.symbol || quote.at < s.receivedAt) return;
    this.pending = null;
    if (!this.broker.open(s, quote)) this.broker.reason = 'Bỏ qua tín hiệu: giá/khối lượng không còn phù hợp. Chờ tín hiệu mới.';
  }
  clear() { this.pending = null; this.quotes = {}; }
}
