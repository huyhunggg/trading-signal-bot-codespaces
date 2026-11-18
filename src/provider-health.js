import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function backoffFile(cfg) { return path.join(cfg.dataDir, `provider-backoff-${cfg.exchange}.json`); }
export function readBackoff(cfg) {
  try { const value = JSON.parse(fs.readFileSync(backoffFile(cfg), 'utf8')); return Number.isFinite(value.retryAt) ? value : null; } catch { return null; }
}
export function retryAfterMs(response, body = '', now = Date.now()) {
  const retry = response.headers.get('retry-after');
  const header = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now) : 0;
  const match = String(body).match(/(?:banned|ban)[\s\S]{0,80}?until\s+(\d{10,16})/i);
  const until = match ? Number(match[1]) * (match[1].length <= 10 ? 1000 : 1) : 0;
  return Math.max(0, Number.isFinite(header) ? header : 0, until - now,
    response.status === 418 && !retry && !match ? 3600000 : 0,
    response.status === 429 && !retry ? 60000 : 0);
}
function persistBackoff(cfg, state) {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const tmp = backoffFile(cfg) + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, backoffFile(cfg));
  } catch {}
  return state;
}
export function seedBackoff(cfg, until, now = Date.now()) {
  if (!Number.isFinite(until)) throw new Error('Invalid Binance retry deadline');
  const previous = readBackoff(cfg);
  if (until <= now || previous?.retryAt >= until) return previous;
  return persistBackoff(cfg, { exchange: cfg.exchange, httpStatus: 418, retryAt: until,
    reason: 'Đang chờ đến hạn Binance đã cấu hình; không gọi API trong thời gian này.', updatedAt: now });
}
export function saveBackoff(cfg, error, now = Date.now()) {
  const fallback = error.httpStatus === 418 ? 3600000 : [403, 451].includes(error.httpStatus) ? 3600000 : error.httpStatus === 429 ? 60000 : 30000;
  const retryAt = Math.max(now + fallback, now + (Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0), readBackoff(cfg)?.retryAt || 0);
  const state = { exchange: cfg.exchange, httpStatus: error.httpStatus || null, retryAt, reason: error.message, updatedAt: now };
  return persistBackoff(cfg, state);
}
export function coolingError(state) {
  const e = new Error(state.reason || 'Nguồn dữ liệu đang yêu cầu chờ trước khi thử lại.');
  e.httpStatus = state.httpStatus; e.retryAt = state.retryAt; e.retryAfterMs = Math.max(0, state.retryAt - Date.now()); e.cooldown = true;
  return e;
}
export class RestQueue {
  constructor(cfg, request) { this.cfg = cfg; this.raw = request; this.queue = Promise.resolve(); this.nextAt = 0; this.interval = cfg.restIntervalMs ?? 350; this.localBackoff = null; }
  pause() { const saved = readBackoff(this.cfg); return (saved?.retryAt || 0) >= (this.localBackoff?.retryAt || 0) ? saved : this.localBackoff; }
  get(url) {
    const task = async () => {
      const state = this.pause();
      if (state?.retryAt > Date.now()) throw coolingError(state);
      const wait = this.nextAt - Date.now(); if (wait > 0) await delay(wait);
      // A calibration worker may have received a ban while this request waited.
      const latest = this.pause();
      if (latest?.retryAt > Date.now()) throw coolingError(latest);
      try { return await this.raw(url); }
      catch (e) {
        if ([403, 418, 429, 451].includes(e.httpStatus)) this.localBackoff = saveBackoff(this.cfg, e);
        throw e;
      } finally { this.nextAt = Date.now() + this.interval; }
    };
    const result = this.queue.then(task); this.queue = result.catch(() => {}); return result;
  }
}

