import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BinanceLiveApi } from './binance-live-api.js';
import { quantize } from './okx-demo-trader.js';

export function liveOptions(env = process.env) {
  const number = (name, fallback, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  return { key: env.BINANCE_API_KEY || '', secret: env.BINANCE_API_SECRET || '', enabled: env.BINANCE_LIVE_ENABLED === 'true',
    maxNotional: number('BINANCE_MAX_NOTIONAL_USDT', 25, 100), maxRisk: number('BINANCE_MAX_RISK_USDT', 1, 2), maxDailyLoss: number('BINANCE_MAX_DAILY_LOSS_USDT', 5, 10) };
}
export function liveLimits(options, equity) {
  return { notional: Math.min(options.maxNotional, equity * 0.05), risk: Math.min(options.maxRisk, equity * 0.0025), daily: Math.min(options.maxDailyLoss, equity * 0.01) };
}
export function planLiveOrder(signal, spec, quote, options, equity, now) {
  if (signal.exchange !== 'binance' || signal.layer !== 'CLOSED' || !signal.closed || !['LONG', 'SHORT'].includes(signal.side) ||
      !Number.isFinite(signal.candleEndTime) || now - signal.candleEndTime > 60000 || signal.candleEndTime > now ||
      !Number.isFinite(quote.at) || now - quote.at > 5000 || quote.at > now + 1000 || quote.exchange !== 'binance' || quote.symbol !== signal.symbol ||
      ![quote.bid, quote.ask].every(v => Number.isFinite(v) && v > 0) || quote.ask < quote.bid) throw new Error('STALE_SIGNAL_OR_QUOTE');
  if (spec?.symbol !== signal.symbol || spec.contractType !== 'PERPETUAL' || spec.quoteAsset !== 'USDT' || spec.marginAsset !== 'USDT' || spec.status !== 'TRADING') throw new Error('UNSUPPORTED_MARKET');
  const filters = Object.fromEntries(spec.filters.map(f => [f.filterType, f]));
  const lot = filters.MARKET_LOT_SIZE, normal = filters.LOT_SIZE, priceFilter = filters.PRICE_FILTER;
  if (!lot || !normal || !priceFilter || !filters.MIN_NOTIONAL) throw new Error('MISSING_EXCHANGE_FILTERS');
  const long = signal.side === 'LONG', price = long ? quote.ask : quote.bid;
  if (!(signal.referencePrice > 0) || Math.abs(price / signal.referencePrice - 1) > 0.003 || (quote.ask - quote.bid) / price > 0.001) throw new Error('PRICE_MOVED_OR_SPREAD');
  const sl = quantize(signal.sl, priceFilter.tickSize, long), tp = quantize(signal.tp1, priceFilter.tickSize, !long);
  if (!(long ? Number(sl) < price && price < Number(tp) : Number(tp) < price && price < Number(sl))) throw new Error('PRICE_PAST_STOP_TARGET');
  const limits = liveLimits(options, equity), riskUnit = Math.abs(price - Number(sl)) + price * 0.003;
  const step = Number(lot.stepSize) > 0 ? lot.stepSize : normal.stepSize;
  const qty = quantize(Math.min(limits.notional / (price * 1.003), limits.risk / riskUnit, Number(lot.maxQty), Number(normal.maxQty)), step);
  const quantity = Number(qty);
  if (quantity < Math.max(Number(lot.minQty), Number(normal.minQty)) || quantity <= 0 || quantity * price < Number(filters.MIN_NOTIONAL.notional) * 1.01) throw new Error('BELOW_BINANCE_MINIMUM');
  if (Number(quantize(quantity, normal.stepSize)) !== quantity) throw new Error('INCOMPATIBLE_LOT_STEP');
  const id = 'bl' + createHash('sha256').update(signal.id).digest('hex').slice(0, 26);
  return { entry: { symbol: signal.symbol, side: long ? 'BUY' : 'SELL', positionSide: 'BOTH', type: 'MARKET', quantity: qty, newClientOrderId: id, newOrderRespType: 'RESULT' },
    sl: { algoType: 'CONDITIONAL', symbol: signal.symbol, side: long ? 'SELL' : 'BUY', positionSide: 'BOTH', type: 'STOP_MARKET', triggerPrice: sl,
      closePosition: 'true', workingType: 'CONTRACT_PRICE', clientAlgoId: id + 's' },
    tp: { algoType: 'CONDITIONAL', symbol: signal.symbol, side: long ? 'SELL' : 'BUY', positionSide: 'BOTH', type: 'TAKE_PROFIT_MARKET', triggerPrice: tp,
      closePosition: 'true', workingType: 'CONTRACT_PRICE', clientAlgoId: id + 't' }, limits };
}

export class BinanceLiveTrader {
  constructor(cfg, options, { api, now = Date.now } = {}) {
    this.cfg = cfg; this.options = options; this.now = now; this.api = api || new BinanceLiveApi(options, { now });
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(cfg.dataDir, 'binance-live.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, entries: [], day: null, baseline: null, halt: null, paused: false };
    if (this.state.version !== 1 || !Array.isArray(this.state.entries)) throw new Error('Invalid live journal; do not delete it to bypass a halt');
    const identity = options.key ? createHash('sha256').update(options.key).digest('hex') : null;
    if (identity && this.state.identity && this.state.identity !== identity) throw new Error('API key changed: reconcile the journal before using another key');
    if (identity) this.state.identity = identity;
    // OS-backed SQLite lock is released after crashes and works across PID
    // reuse/container restarts. Never use a persistent PID file for this.
    this.lockDb = new DatabaseSync(path.join(cfg.dataDir, 'binance-live-lock.sqlite'));
    try { this.lockDb.exec('BEGIN IMMEDIATE'); }
    catch { this.lockDb.close(); throw new Error('A live trader is already using this journal'); }
    this.busy = false; this.stopped = false; this.pending = null; this.positions = []; this.equity = null; this.available = null;
    this.status = 'STARTING'; this.reason = 'Đang kiểm tra tài khoản Binance Futures thật.'; this.lastSync = null;
    this.save();
  }
  save() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  releaseLock() { if (this.lockDb) { this.lockDb.close(); this.lockDb = null; } }
  stop() { this.stopped = true; this.pending = null; if (!this.busy) this.releaseLock(); }
  pause() { this.pending = null; this.state.paused = true; this.save(); }
  resume() { this.state.paused = false; this.save(); }
  halt(reason) { this.pending = null; this.state.halt = reason; this.save(); this.status = 'HALTED'; this.reason = reason; }
  enqueue(signal) {
    if (this.status === 'READY' && !this.state.paused && !this.state.halt && !this.pending && signal.layer === 'CLOSED' && signal.exchange === 'binance' &&
        !this.state.entries.some(e => e.signalId === signal.id)) this.pending = { ...signal, receivedAt: this.now() };
  }
  snapshot() {
    return { mode: 'BINANCE_LIVE', status: this.status, reason: this.reason, enabled: this.options.enabled, paused: this.state.paused,
      configured: !!this.options.key && !!this.options.secret, equity: this.equity, available: this.available, lastSync: this.lastSync,
      limits: this.equity ? liveLimits(this.options, this.equity) : null,
      unrealizedPnl: this.positions.reduce((sum, p) => sum + Number(p.unRealizedProfit || 0), 0),
      positions: this.positions.map(p => ({ symbol: p.symbol, quantity: p.positionAmt, entry: p.entryPrice, mark: p.markPrice, pnl: p.unRealizedProfit })),
      entries: this.state.entries.slice(-20).reverse().map(e => ({ symbol: e.plan.entry.symbol, side: e.plan.entry.side, quantity: e.plan.entry.quantity, status: e.status, createdAt: e.createdAt,
        sl: e.plan.sl.triggerPrice, tp: e.plan.tp.triggerPrice, fillPrice: e.fillPrice, id: e.plan.entry.newClientOrderId })) };
  }
  async sync() {
    const config = await this.api.get('/fapi/v1/accountConfig');
    if (config.dualSidePosition !== false || config.multiAssetsMargin !== false) throw new Error('REQUIRE_ONEWAY_SINGLE_ASSET');
    const account = await this.api.get('/fapi/v3/account');
    const usdt = account.assets?.find(a => a.asset === 'USDT');
    this.equity = Number(usdt?.walletBalance) + Number(usdt?.unrealizedProfit); this.available = Number(usdt?.availableBalance);
    if (config.canTrade !== true || !Number.isFinite(this.equity) || this.equity <= 0 || !Number.isFinite(this.available)) throw new Error('ACCOUNT_NOT_READY');
    this.positions = (await this.api.get('/fapi/v3/positionRisk')).filter(p => Number(p.positionAmt) !== 0);
    if (this.positions.some(p => !Number.isFinite(Number(p.positionAmt)))) throw new Error('INVALID_POSITIONS');
    this.orders = await this.api.get('/fapi/v1/openOrders'); this.algos = await this.api.get('/fapi/v1/openAlgoOrders');
    if (!Array.isArray(this.orders) || !Array.isArray(this.algos)) throw new Error('INVALID_OPEN_ORDERS');
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.state.day !== day) { this.state.day = day; this.state.baseline = this.equity; this.save(); }
    if (this.equity <= this.state.baseline - liveLimits(this.options, this.state.baseline).daily) this.halt('Chạm giới hạn giảm vốn ngày UTC. Dừng mở thêm; SL/TP trên sàn vẫn hoạt động.');
    this.lastSync = this.now();
  }
  async cleanup(entry) {
    for (const item of ['sl', 'tp']) {
      const id = entry.plan[item].clientAlgoId;
      if (this.algos.some(a => a.clientAlgoId === id)) await this.api.delete('/fapi/v1/algoOrder', { clientAlgoId: id });
    }
  }
  async flatten(entry, reason) {
    // Only reduce a position belonging to an entry this journal has submitted.
    this.halt(reason);
    if (entry.exitSent) return;
    const pos = (await this.api.get('/fapi/v3/positionRisk', { symbol: entry.plan.entry.symbol })).find(p => Number(p.positionAmt) !== 0);
    if (!pos) { entry.status = 'RECONCILING'; this.save(); return; }
    const amount = Number(pos.positionAmt), long = entry.plan.entry.side === 'BUY';
    if (!Number.isFinite(amount) || (amount > 0) !== long || Math.abs(amount) > Number(entry.plan.entry.quantity) * 1.01) throw new Error('POSITION_CHANGED_EXTERNALLY');
    entry.exitSent = true; entry.status = 'EXIT_UNKNOWN'; this.save();
    // No retry after any response/transport ambiguity. Query this ID on later ticks.
    await this.api.post('/fapi/v1/order', { symbol: entry.plan.entry.symbol, side: long ? 'SELL' : 'BUY', positionSide: 'BOTH', type: 'MARKET',
      quantity: String(Math.abs(amount)), reduceOnly: 'true', newClientOrderId: entry.plan.entry.newClientOrderId + 'x', newOrderRespType: 'RESULT' });
  }
  async protect(entry) {
    for (const kind of ['sl', 'tp']) {
      const intended = entry.plan[kind];
      let algo;
      if (entry[kind + 'Sent']) algo = await this.api.get('/fapi/v1/algoOrder', { clientAlgoId: intended.clientAlgoId });
      else {
        entry[kind + 'Sent'] = true; this.save();
        await this.api.post('/fapi/v1/algoOrder', intended);
        algo = await this.api.get('/fapi/v1/algoOrder', { clientAlgoId: intended.clientAlgoId });
      }
      if (algo.clientAlgoId !== intended.clientAlgoId || algo.symbol !== intended.symbol || algo.side !== intended.side || algo.orderType !== intended.type ||
          algo.workingType !== intended.workingType || algo.positionSide !== 'BOTH' || Number(algo.triggerPrice) !== Number(intended.triggerPrice) || ![true, 'true'].includes(algo.closePosition) || algo.algoStatus !== 'NEW') throw new Error('PROTECTION_NOT_CONFIRMED');
    }
    entry.status = 'PROTECTED'; this.save();
  }
  async reconcile() {
    for (const e of this.state.entries.filter(e => !['CLOSED', 'REJECTED'].includes(e.status))) {
      let order;
      try { order = await this.api.get('/fapi/v1/order', { symbol: e.plan.entry.symbol, origClientOrderId: e.plan.entry.newClientOrderId }); }
      catch { this.halt('Chưa xác nhận được lệnh đã gửi. Không gửi lại; kiểm tra client ID trên Binance.'); continue; }
      if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
        // Cancel is idempotent intent; entry POST is never retried. Re-query next
        // tick after an ambiguous cancel rather than marking the entry closed.
        e.cancelSent = true; this.save(); await this.api.delete('/fapi/v1/order', { symbol: e.plan.entry.symbol, origClientOrderId: e.plan.entry.newClientOrderId });
        await this.flatten(e, 'Lệnh market chưa khớp đủ. Đã yêu cầu hủy và đóng phần vị thế đã khớp; kiểm tra Binance.'); continue;
      }
      const position = this.positions.find(p => p.symbol === e.plan.entry.symbol);
      if (!position) {
        if (order.status === 'FILLED' || ['CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(order.status)) {
          await this.cleanup(e); e.status = 'CLOSED'; this.save(); continue;
        }
        this.halt('Trạng thái lệnh chưa xác định. Kiểm tra lịch sử Binance.'); continue;
      }
      if (order.status !== 'FILLED') { await this.flatten(e, 'Lệnh kết thúc nhưng còn vị thế khớp một phần. Đang yêu cầu đóng để kiểm tra.'); continue; }
      e.fillPrice = order.avgPrice;
      if (e.exitSent) { this.halt('Đã gửi lệnh đóng khẩn cấp; vẫn còn vị thế. Kiểm tra Binance ngay, bot không gửi lại tự động.'); continue; }
      try { await this.protect(e); }
      catch { await this.flatten(e, 'Không xác nhận đủ SL/TP trên sàn. Đã yêu cầu đóng vị thế và dừng mở thêm; kiểm tra Binance.'); }
    }
  }
  async tick(market) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (!this.options.key || !this.options.secret) { this.status = 'NEED_KEYS'; this.reason = 'Nhập BINANCE_API_KEY và BINANCE_API_SECRET trong Render Environment.'; return; }
      await this.sync();
      if (this.options.enabled) await this.reconcile();
      if (!this.options.enabled) { this.status = 'DISABLED'; this.reason = 'Đã kết nối tài khoản. Chế độ chỉ đọc; đặt BINANCE_LIVE_ENABLED=true để cho phép giao dịch thật.'; return; }
      if (this.state.halt) { this.status = 'HALTED'; this.reason = this.state.halt; return; }
      if (this.stopped || this.state.paused) { this.status = 'PAUSED'; this.reason = 'Tạm dừng mở thêm. Vị thế và SL/TP hiện có vẫn được kiểm tra.'; return; }
      if (this.positions.length || this.orders.length || this.algos.length || this.state.entries.some(e => e.status !== 'CLOSED' && e.status !== 'REJECTED')) {
        this.pending = null; this.status = 'POSITION_OPEN'; this.reason = 'Có vị thế hoặc lệnh trên tài khoản. Không mở thêm.'; return;
      }
      if (!market) { this.status = 'WAITING_DATA'; this.reason = 'Chờ nguồn Binance kết nối để nhận tín hiệu mới.'; return; }
      this.status = 'READY'; this.reason = 'Giao dịch thật đã bật. Chờ tín hiệu đóng nến mới và báo giá hợp lệ.';
      const signal = this.pending; this.pending = null;
      if (!signal || this.state.entries.some(e => e.signalId === signal.id)) return;
      const info = await market.request('https://fapi.binance.com/fapi/v1/exchangeInfo');
      const quote = await market.quote(signal.symbol);
      if (quote.at < signal.receivedAt) { this.reason = 'Bỏ qua: chưa có báo giá mới sau tín hiệu.'; return; }
      let plan;
      try { plan = planLiveOrder(signal, info.symbols?.find(s => s.symbol === signal.symbol), quote, this.options, this.equity, this.now()); }
      catch (e) { this.reason = e.message === 'BELOW_BINANCE_MINIMUM' ? 'Bỏ qua: khối lượng theo giới hạn vốn thấp hơn mức tối thiểu Binance.' : 'Bỏ qua: tín hiệu, spread, giá hoặc quy tắc khối lượng không còn hợp lệ.'; return; }
      if (this.available < Number(plan.entry.quantity) * quote.ask * 1.01) { this.reason = 'USDT khả dụng không đủ dự phòng.'; return; }
      try { await this.api.post('/fapi/v1/marginType', { symbol: signal.symbol, marginType: 'ISOLATED' }); }
      catch (e) { if (e.code !== -4046) throw e; }
      const leverage = await this.api.post('/fapi/v1/leverage', { symbol: signal.symbol, leverage: '1' });
      const [config] = await this.api.get('/fapi/v1/symbolConfig', { symbol: signal.symbol });
      if (leverage.leverage !== 1 || Number(config?.leverage) !== 1 || config.marginType !== 'ISOLATED') throw new Error('ISOLATED_1X_NOT_CONFIRMED');
      if (this.stopped || this.state.paused || this.now() - quote.at > 5000 || this.now() - signal.candleEndTime > 60000) return;
      const entry = { signalId: signal.id, plan, status: 'ENTRY_UNKNOWN', createdAt: this.now() };
      this.state.entries.push(entry); this.save();
      try {
        const ack = await this.api.post('/fapi/v1/order', plan.entry);
        if (ack.status === 'FILLED' && Number(ack.executedQty) > 0) {
          entry.fillPrice = ack.avgPrice;
          try { await this.protect(entry); }
          catch { await this.flatten(entry, 'Không xác nhận được SL/TP sau khi khớp. Đã yêu cầu đóng vị thế; kiểm tra Binance.'); }
        }
        await this.sync(); await this.reconcile();
      } catch {
        this.halt('Lệnh hoặc bước bảo vệ chưa được xác nhận. Không gửi lại lệnh vào; đang đối chiếu tài khoản. Kiểm tra Binance.');
        try {
          const recovered = await this.api.get('/fapi/v1/order', { symbol: plan.entry.symbol, origClientOrderId: plan.entry.newClientOrderId });
          if (recovered.status === 'FILLED' && !entry.exitSent) {
            try { await this.protect(entry); }
            catch { await this.flatten(entry, 'Lệnh khớp sau gián đoạn nhưng không xác nhận được SL/TP. Đang yêu cầu đóng; kiểm tra Binance.'); }
          }
        } catch { /* Keep unresolved intent durable; never send the entry again. */ }
        // Reconciliation continues on subsequent ticks, even while halted.
      }
    } catch (e) {
      this.pending = null; this.status = 'ERROR';
      this.reason = ({ REQUIRE_ONEWAY_SINGLE_ASSET: 'Cần One-way và Single-Asset Mode trong Binance Futures.', ACCOUNT_NOT_READY: 'Tài khoản Futures chưa sẵn sàng, không có USDT hoặc chưa có quyền trade.',
        BINANCE_COOLDOWN: 'Binance yêu cầu chờ do giới hạn API/khu vực.', BINANCE_REQUEST_UNKNOWN: 'Không xác nhận được phản hồi Binance. Không mở thêm lệnh.',
      })[e.message] || (/^BINANCE_-?\d+$/.test(e.message) ? `Binance từ chối yêu cầu (${e.message}). Kiểm tra quyền Futures, IP và API.` : 'Chưa đồng bộ được tài khoản/SL/TP. Không mở thêm; kiểm tra vị thế trực tiếp trên Binance.');
    } finally { this.busy = false; if (this.stopped) this.releaseLock(); }
  }
}
