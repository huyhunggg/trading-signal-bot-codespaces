import fs from 'node:fs';
import path from 'node:path';
import { INTERVALS } from './config.js';
import { validationText } from './validation.js';

export class Store {
  constructor(cfg) {
    this.cfg = cfg; fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(cfg.dataDir, 'state.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, seen: {}, cooldowns: {}, recent: [], pending: [], delivery: {} };
    if (this.state.version !== 1 || !Array.isArray(this.state.pending) || !Array.isArray(this.state.recent) || !this.state.seen || !this.state.cooldowns) throw new Error('state.json không hợp lệ; cần khôi phục bản sao trước khi chạy.');
    if (!Array.isArray(this.state.watchlist)) this.state.watchlist = [];
    if (!this.state.candidateCooldowns) this.state.candidateCooldowns = {};
    this.busy = false;
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file);
  }
  accept(signal) {
    const { state, cfg } = this;
    if (state.seen[signal.id]) return false;
    const key = [signal.exchange, signal.symbol, signal.timeframe, signal.layer, signal.side].join(':');
    const previous = state.cooldowns[key];
    if (signal.layer === 'CLOSED' && previous !== undefined && signal.candleOpenTime - previous < cfg.rules.barsGap * INTERVALS[signal.timeframe]) return false;
    state.seen[signal.id] = signal.observedAt;
    if (signal.layer === 'CLOSED') state.cooldowns[key] = signal.candleOpenTime;
    state.recent.unshift(signal); state.recent = state.recent.slice(0, 100);
    state.watchlist = state.watchlist.filter(s => s.id !== signal.id);
    if (cfg.telegramToken) state.pending.push({ signal, attempts: 0, nextAttempt: 0 });
    for (const [id, t] of Object.entries(state.seen)) if (signal.observedAt - t > 7 * 86_400_000) delete state.seen[id];
    this.save();
    fs.appendFileSync(path.join(cfg.dataDir, 'signals.jsonl'), JSON.stringify(signal) + '\n', { mode: 0o600 });
    return true;
  }
  recordCandidate(signal) {
    if (this.state.seen[signal.id] || this.state.watchlist.some(s => s.id === signal.id)) return false;
    this.state.watchlist.unshift(signal); this.state.watchlist = this.state.watchlist.slice(0, 100);
    this.save(); return true;
  }
  reserveCandidate(signal) {
    if (this.state.seen[signal.id] || this.state.watchlist.some(s => s.id === signal.id)) return false;
    if (signal.layer !== 'CLOSED') return true;
    const key = [signal.exchange, signal.symbol, signal.timeframe, signal.side].join(':');
    const last = this.state.candidateCooldowns[key];
    if (last !== undefined && signal.candleOpenTime - last < this.cfg.rules.barsGap * INTERVALS[signal.timeframe]) return false;
    this.state.candidateCooldowns[key] = signal.candleOpenTime; this.save(); return true;
  }
  async flush(now = Date.now(), sender = sendTelegram, canSend = () => true) {
    if (this.busy || !this.cfg.telegramToken) return;
    this.busy = true;
    try {
      const { state } = this;
      const blocked = [], allowed = [];
      for (const pending of state.pending) (canSend(pending.signal) ? allowed : blocked).push(pending);
      if (blocked.length) state.delivery.unverifiedRemoved = (state.delivery.unverifiedRemoved || 0) + blocked.length;
      state.pending = allowed;
      const tooOld = p => now - (p.signal.layer === 'CLOSED' ? p.signal.candleEndTime : p.signal.observedAt) > this.cfg.maxSignalAgeMs;
      const expired = state.pending.filter(tooOld);
      if (expired.length) state.delivery.expired = (state.delivery.expired || 0) + expired.length;
      state.pending = state.pending.filter(p => !tooOld(p));
      const pending = state.pending[0];
      if (pending && pending.nextAttempt <= now) {
        try {
          await sender(this.cfg, pending.signal);
          state.pending.shift(); state.delivery.lastSuccessAt = now; state.delivery.lastError = null;
        } catch (e) {
          pending.attempts++;
          pending.nextAttempt = now + Math.max(Math.min(60_000, 2000 * 2 ** Math.min(5, pending.attempts - 1)), e.retryAfterMs || 0);
          state.delivery.lastError = 'Gửi Telegram thất bại; sẽ thử lại trong giới hạn thời gian tín hiệu.';
        }
      }
      if (pending || expired.length || blocked.length) this.save();
    } finally { this.busy = false; }
  }
}

const price = x => Number(x).toLocaleString('en-US', { maximumFractionDigits: 8 });
export function telegramText(s) {
  const time = new Date(s.observedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  return [
    s.layer === 'CLOSED' ? '✅ TÍN HIỆU ĐÓNG NẾN' : '⚡ CẢNH BÁO XUNG LỰC — NẾN CHƯA ĐÓNG',
    `${s.symbol} · ${s.side} · ${s.timeframe} · ${s.exchange.toUpperCase()} USDT perpetual`,
    `Nhánh: ${s.branch} · H1/H4 đã đóng lúc ${new Date(s.htfEndTime).toISOString()}`,
    `Giá tham khảo: ${price(s.referencePrice)}`, `SL tham khảo: ${price(s.sl)}`,
    `TP1 tham khảo: ${price(s.tp1)}${s.tp2 !== null ? ` · TP2: ${price(s.tp2)}` : ''}`,
    validationText(s.validation),
    s.validation?.policy ? `Mô phỏng: vào đầu nến kế tiếp, bỏ qua khi đã vượt SL/TP1; giữ tối đa ${s.validation.policy.maxHoldBars} nến. Phí ${s.validation.policy.feeBps} bps + trượt giá ${s.validation.policy.slippageBps} bps mỗi lần khớp.` : '',
    s.validation?.dataThrough ? `Dữ liệu kiểm chứng đến: ${new Date(s.validation.dataThrough).toISOString()} · Thắng = tổng lãi/lỗ sau chi phí giả định dương.` : 'Chưa có xác suất thắng riêng cho lệnh này.',
    s.note, 'Các mức chưa tính phí, trượt giá, funding; SL tại entry vẫn có thể lỗ sau phí.',
    `Thời điểm phát hiện (UTC+7): ${time}`, `ID: ${s.id}`,
  ].join('\n');
}

export async function sendTelegram(cfg, signal) {
  // Never log the request URL: it contains the bot token.
  const response = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text: telegramText(signal), disable_web_page_preview: true }),
  });
  let json; try { json = await response.json(); } catch { throw new Error('Telegram response invalid'); }
  if (!response.ok || !json.ok) {
    const error = new Error(`Telegram HTTP ${response.status}`);
    error.retryAfterMs = Math.min(600_000, Number(json.parameters?.retry_after || 0) * 1000);
    throw error;
  }
}
