import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OkxDemoApi } from './okx-demo-api.js';

export function demoOptions(env = process.env) {
  const limit = (name, fallback, max) => {
    const n = Number(env[name] || fallback);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${name}: expected >0 and <=${max}`);
    return n;
  };
  return { credentials: { key: env.OKX_DEMO_API_KEY, secret: env.OKX_DEMO_SECRET_KEY, passphrase: env.OKX_DEMO_PASSPHRASE },
    maxNotional: limit('OKX_DEMO_MAX_NOTIONAL_USDT', 50, 100),
    risk: limit('OKX_DEMO_RISK_USDT', 1, 2), dailyLoss: limit('OKX_DEMO_DAILY_LOSS_USDT', 5, 10) };
}

// Exact decimal increments, including contract lots such as 0.01 or 0.25.
export function quantize(value, step, ceil = false) {
  if (!(Number(value) > 0) || !/^\d+(\.\d+)?$/.test(String(step)) || !(Number(step) > 0)) throw new Error('Invalid precision');
  const places = (String(step).split('.')[1] || '').length, scale = 10 ** places;
  const units = Math.round(Number(step) * scale);
  const count = (ceil ? Math.ceil : Math.floor)(Number(value) * scale / units + (ceil ? -1e-9 : 1e-9));
  return (count * units / scale).toFixed(places);
}

export function planDemoOrder(signal, instrument, ticker, options, now) {
  const instId = signal.symbol.replace(/USDT$/, '-USDT-SWAP'), long = signal.side === 'LONG';
  const price = Number(ticker.last), ts = Number(ticker.ts), reference = Number(signal.referencePrice);
  if (!['LONG', 'SHORT'].includes(signal.side) || signal.exchange !== 'okx' || signal.layer !== 'CLOSED' ||
      !signal.closed || !Number.isFinite(signal.candleEndTime) || now < signal.candleEndTime || now - signal.candleEndTime > 60000 ||
      !Number.isFinite(ts) || now - ts > 15000 || ts > now + 1000 || !(price > 0) || !(reference > 0) || Math.abs(price / reference - 1) > 0.005) throw new Error('STALE_OR_MOVED_PRICE');
  if (instrument.instId !== instId || instrument.instType !== 'SWAP' || instrument.state !== 'live' ||
      instrument.ctType !== 'linear' || instrument.settleCcy !== 'USDT' || instrument.ctValCcy !== signal.symbol.slice(0, -4)) throw new Error('UNSUPPORTED_CONTRACT');
  const basePerContract = Number(instrument.ctVal) * Number(instrument.ctMult || 1);
  if (!(basePerContract > 0) || !Number.isFinite(basePerContract)) throw new Error('UNSUPPORTED_CONTRACT');
  const sl = quantize(signal.sl, instrument.tickSz, !long), tp = quantize(signal.tp1, instrument.tickSz, long);
  if (!(long ? Number(sl) < price && price < Number(tp) : Number(tp) < price && price < Number(sl))) throw new Error('PRICE_PAST_SL_TP');
  // Leave room for fees/slippage; SL is a trigger, not a guaranteed execution price.
  const lossPerBase = Math.abs(price - Number(sl)) + price * 0.003;
  const sz = quantize(Math.min(options.maxNotional / (price * 1.005 * basePerContract), options.risk / (lossPerBase * basePerContract)), instrument.lotSz);
  if (!(Number(sz) >= Number(instrument.minSz)) || !(Number(sz) > 0)) throw new Error('BELOW_MINIMUM_SIZE');
  const id = 'cd' + createHash('sha256').update(signal.id).digest('hex').slice(0, 28);
  return { instId, tdMode: 'isolated', posSide: 'net', side: long ? 'buy' : 'sell', ordType: 'market', sz, clOrdId: id,
    attachAlgoOrds: [{ attachAlgoClOrdId: id + 'a', tpTriggerPx: tp, tpOrdPx: '-1',
      slTriggerPx: sl, slOrdPx: '-1', tpTriggerPxType: 'last', slTriggerPxType: 'last' }] };
}

const utcDay = now => new Date(now).toISOString().slice(0, 10);
export class OkxDemoTrader {
  constructor(cfg, options, { api, now = Date.now } = {}) {
    this.cfg = cfg; this.options = options; this.now = now;
    this.api = api || new OkxDemoApi(options.credentials, { now });
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(cfg.dataDir, 'okx-demo-trades.json');
    this.pauseFile = path.join(cfg.dataDir, 'STOP-OKX-DEMO');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { version: 1, seen: {}, entries: [], day: null, startEquity: null, halted: null };
    if (this.state.version !== 1 || !Array.isArray(this.state.entries) || !this.state.seen || typeof this.state.seen !== 'object') throw new Error('Invalid OKX demo journal');
    this.status = 'STARTING'; this.reason = 'Đang kiểm tra tài khoản OKX Demo.';
    this.queue = []; this.busy = false; this.stopped = false; this.positions = []; this.equity = null; this.upl = null;
    this.lastSync = null; this.lastHistory = 0; this.closedPnl = null; this.fills = [];
    this.keysReady = Object.values(options.credentials).every(v => typeof v === 'string' && v.trim());
    this.lockFile = path.join(cfg.dataDir, 'okx-demo.lock');
    try {
      fs.writeFileSync(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid demo lock; inspect running processes');
      try { process.kill(pid, 0); throw new Error('OKX Demo bot is already running'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
      fs.unlinkSync(this.lockFile);
      fs.writeFileSync(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
    }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file);
  }
  releaseLock() { fs.rmSync(this.lockFile, { force: true }); }
  stop() { this.stopped = true; this.queue.length = 0; if (!this.busy) this.releaseLock(); }
  halt(reason) { this.state.halted = reason; this.save(); this.status = 'HALTED'; this.reason = reason; }
  enqueue(signal) {
    if (this.stopped || !this.keysReady || this.state.halted || this.status !== 'READY' || signal.exchange !== 'okx' || signal.layer !== 'CLOSED' || !signal.closed) return;
    if (this.state.seen[signal.id] || this.queue.some(s => s.id === signal.id)) return;
    if (this.queue.length < 5) this.queue.push({ ...signal });
  }
  snapshot() {
    return { mode: 'OKX_DEMO', status: this.status, reason: this.reason, configured: this.keysReady,
      maxNotional: this.options.maxNotional, risk: this.options.risk, dailyLoss: this.options.dailyLoss,
      equity: this.equity, unrealizedPnl: this.upl, closedPnl: this.closedPnl, fills: this.fills,
      lastSync: this.lastSync, positions: this.positions, entries: this.state.entries.slice(-20).reverse(),
      entryPolicy: 'EXPERIMENTAL_CLOSED_SIGNALS', exitPolicy: 'FULL_TP1_OR_SL',
      dayChange: this.equity !== null && this.state.startEquity !== null ? this.equity - this.state.startEquity : null };
  }
  async sync() {
    const [config] = await this.api.get('/api/v5/account/config');
    if (config?.posMode !== 'net_mode') throw new Error('SET_NET_MODE');
    if (!config.uid) throw new Error('INVALID_ACCOUNT');
    const account = createHash('sha256').update(String(config.uid)).digest('hex');
    if (this.state.account && this.state.account !== account) { this.halt('API thuộc tài khoản Demo khác với nhật ký. Không mở lệnh; cần kiểm tra cấu hình.'); return; }
    this.state.account = account;
    const [balance] = await this.api.get('/api/v5/account/balance', { ccy: 'USDT' });
    const usdt = balance?.details?.find(d => d.ccy === 'USDT');
    this.equity = Number(usdt?.eq); this.available = Number(usdt?.availEq);
    if (!usdt || !Number.isFinite(this.equity) || !Number.isFinite(this.available) || this.equity <= 0) throw new Error('NEED_DEMO_USDT');
    const raw = await this.api.get('/api/v5/account/positions', { instType: 'SWAP' });
    this.positions = raw.filter(p => Number(p.pos) !== 0).map(p => ({ instId: p.instId, size: p.pos, entry: p.avgPx, mark: p.markPx, upl: p.upl }));
    if (this.positions.some(p => !Number.isFinite(Number(p.size)) || !Number.isFinite(Number(p.upl)))) throw new Error('INVALID_POSITION');
    this.upl = this.positions.reduce((sum, p) => sum + Number(p.upl), 0);
    this.pending = await this.api.get('/api/v5/trade/orders-pending', { instType: 'SWAP' });
    this.algos = [];
    for (const ordType of ['oco', 'conditional']) this.algos.push(...await this.api.get('/api/v5/trade/orders-algo-pending', { ordType, instType: 'SWAP' }));
    const now = this.now(), day = utcDay(now);
    if (this.state.day !== day) { this.state.day = day; this.state.startEquity = this.equity; this.save(); }
    if (this.equity <= this.state.startEquity - this.options.dailyLoss) this.halt('Đã chạm giới hạn lỗ ngày theo vốn USDT. Không mở lệnh mới; kiểm tra vị thế trong OKX Demo.');
    for (const entry of this.state.entries.filter(e => ['SUBMITTING', 'UNKNOWN', 'ACCEPTED', 'LIVE'].includes(e.status))) {
      let order;
      try { [order] = await this.api.get('/api/v5/trade/order', { instId: entry.instId, clOrdId: entry.clOrdId }); }
      catch (e) {
        if (e.message === 'DEMO_API_51603' && ['SUBMITTING', 'UNKNOWN'].includes(entry.status)) {
          this.halt('Không xác nhận được lệnh sau gián đoạn. Không gửi lại; kiểm tra lịch sử OKX Demo.'); continue;
        }
        throw e;
      }
      if (!order || !['live', 'partially_filled', 'filled', 'canceled', 'mmp_canceled'].includes(order.state)) throw new Error('UNKNOWN_ORDER_STATE');
      entry.orderState = order.state; entry.fillPrice = order.avgPx; entry.filledSize = order.accFillSz; entry.updatedAt = now;
      if (order.state === 'filled') {
        entry.status = this.positions.some(p => p.instId === entry.instId) ? 'LIVE' : 'CLOSED';
        if (entry.status === 'LIVE') {
          const expected = entry.body.attachAlgoOrds[0];
          const protection = this.algos.find(a => a.algoClOrdId === expected.attachAlgoClOrdId && a.instId === entry.instId &&
            Number(a.slTriggerPx) === Number(expected.slTriggerPx) && Number(a.tpTriggerPx) === Number(expected.tpTriggerPx) &&
            a.side === (entry.body.side === 'buy' ? 'sell' : 'buy') && Number(a.sz) >= Number(order.accFillSz));
          if (!protection && now - entry.createdAt > 30000) this.halt('Chưa xác nhận đủ SL/TP trên sàn sau khi khớp. Kiểm tra hoặc đóng vị thế trong OKX Demo.');
        }
      } else if (['canceled', 'mmp_canceled'].includes(order.state)) {
        entry.status = Number(order.accFillSz) > 0 ? 'PARTIAL_CANCELED' : 'CANCELED';
        if (Number(order.accFillSz) > 0) this.halt('Lệnh bị hủy sau khi khớp một phần. Kiểm tra SL/TP và vị thế trên OKX Demo.');
      } else {
        entry.status = 'ACCEPTED';
        if (now - entry.createdAt > 30000) this.halt('Lệnh market chưa khớp hoàn toàn sau 30 giây. Kiểm tra lệnh trên OKX Demo.');
      }
    }
    this.save(); this.lastSync = now;
    if (now - this.lastHistory > 30000) {
      const history = await this.api.get('/api/v5/account/positions-history', { instType: 'SWAP', limit: '20' });
      this.closedPnl = history.filter(p => p.mgnMode === 'isolated' && p.instId?.endsWith('-USDT-SWAP')).reduce((sum, p) => sum + (Number(p.realizedPnl) || 0), 0);
      this.fills = history.slice(0, 10).map(p => ({ instId: p.instId, pnl: p.realizedPnl, closedAt: Number(p.uTime) }));
      this.lastHistory = now;
    }
  }
  async tick() {
    if (this.busy || this.stopped) return;
    if (!this.keysReady) { this.status = 'NEED_KEYS'; this.reason = 'Chạy npm run okx:demo:setup trong Terminal để nhập API của OKX Demo.'; return; }
    this.busy = true;
    try {
      await this.sync();
      if (this.stopped) return;
      if (this.state.halted) { this.status = 'HALTED'; this.reason = this.state.halted; this.queue.length = 0; return; }
      if (fs.existsSync(this.pauseFile)) { this.status = 'PAUSED'; this.reason = 'Đã tạm dừng mở lệnh. SL/TP trên sàn tiếp tục hoạt động.'; this.queue.length = 0; return; }
      const unresolved = this.state.entries.some(e => ['SUBMITTING', 'UNKNOWN', 'ACCEPTED', 'LIVE', 'PARTIAL_CANCELED'].includes(e.status));
      if (this.positions.length || this.pending.length || this.algos.length || unresolved) {
        this.status = 'POSITION_OPEN'; this.reason = 'Đang có vị thế/lệnh. Chờ đóng hết trước khi mở lệnh tiếp theo.'; this.queue.length = 0; return;
      }
      this.status = 'READY'; this.reason = 'Sẵn sàng tự đặt lệnh OKX Demo khi có tín hiệu đóng nến mới. Không cần bộ lọc lịch sử 80% để thử nghiệm.';
      const signal = this.queue.shift(); this.queue.length = 0;
      if (!signal || this.state.seen[signal.id]) return;
      // Fresh account sync above is required before every attempted entry.
      const instId = signal.symbol.replace(/USDT$/, '-USDT-SWAP');
      const [instrument] = await this.api.get('/api/v5/account/instruments', { instType: 'SWAP', instId });
      const [ticker] = await this.api.get('/api/v5/market/ticker', { instId });
      let body;
      try { body = planDemoOrder(signal, instrument || {}, ticker || {}, this.options, this.now()); }
      catch (e) { this.reason = `Bỏ qua tín hiệu: ${e.message}`; return; }
      if (this.available < this.options.maxNotional * 1.02) { this.reason = 'USDT khả dụng chưa đủ dự phòng cho hạn mức lệnh.'; return; }
      await this.api.post('/api/v5/account/set-leverage', { instId, lever: '1', mgnMode: 'isolated' });
      if (this.stopped || fs.existsSync(this.pauseFile) || this.now() - signal.candleEndTime > 60000) return;
      const entry = { signalId: signal.id, instId, clOrdId: body.clOrdId, body, createdAt: this.now(), status: 'SUBMITTING' };
      this.state.seen[signal.id] = true; this.state.entries.push(entry); this.save();
      try {
        const [ack] = await this.api.post('/api/v5/trade/order', body);
        if (!ack?.ordId) throw new Error('DEMO_ACK_UNKNOWN');
        entry.ordId = ack.ordId; entry.status = 'ACCEPTED'; this.save();
        this.status = 'ORDER_SENT'; this.reason = 'Đã gửi lệnh OKX Demo kèm SL/TP; đang chờ xác nhận khớp.';
      } catch (e) {
        entry.status = 'UNKNOWN'; this.save();
        this.halt('Gửi lệnh chưa được xác nhận. Bot không tự gửi lại. Kiểm tra lệnh trên OKX Demo trước khi tiếp tục.');
      }
    } catch (e) {
      this.queue.length = 0; this.status = 'ERROR';
      this.reason = ({ SET_NET_MODE: 'Chọn chế độ vị thế One-way / Net trong cài đặt OKX Demo.',
        NEED_DEMO_USDT: 'Cần số dư USDT khả dụng trên tài khoản giao dịch OKX Demo.',
        DEMO_API_50101: 'API không khớp môi trường. Tạo key trong mục Demo Trading API.',
        DEMO_API_50113: 'Chữ ký API không hợp lệ. Kiểm tra lại secret và passphrase.',
        DEMO_API_50102: 'Đồng hồ lệch hoặc yêu cầu hết hạn. Kiểm tra thời gian máy.',
      })[e.message] || (/^DEMO_API_\d+$/.test(e.message) ? `OKX Demo từ chối yêu cầu (${e.message}). Kiểm tra API và quyền giao dịch.` : 'Chưa đồng bộ được OKX Demo. Tạm ngừng mở lệnh và thử đọc lại sau.');
    } finally { this.busy = false; if (this.stopped) this.releaseLock(); }
  }
}
