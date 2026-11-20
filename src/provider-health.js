import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function backoffFile(cfg) { return path.join(cfg.dataDir, `provider-backoff-${cfg.exchange}.json`); }
const failedWrites = new Map();
export function readBackoff(cfg) {
  const file = backoffFile(cfg);
  if (failedWrites.has(file)) return failedWrites.get(file);
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Number.isFinite(value.retryAt) ? value : null; } catch { return null; }
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
  const file = backoffFile(cfg);
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    const tmp = file + `.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file);
    failedWrites.delete(file);
  } catch { failedWrites.set(file, state); }
  return state;
}
export function markRecovery(cfg, required, previous = readBackoff(cfg)) {
  if (!previous) return null;
  return persistBackoff(cfg, { ...previous, manualRecovery: required });
}
export function requestsPaused(state, now = Date.now()) {
  return !!state && (state.retryAt > now || state.manualRecovery === true);
}
export function seedBackoff(cfg, until, now = Date.now()) {
  if (!Number.isFinite(until)) throw new Error('Invalid Binance retry deadline');
  const previous = readBackoff(cfg);
  if (previous?.retryAt >= until || (until <= now && (!cfg.manualBanRecovery || previous))) return previous;
  return persistBackoff(cfg, { exchange: cfg.exchange, httpStatus: 418, retryAt: until,
    reason: 'Mốc chờ được cấu hình trên máy chủ.', updatedAt: now, requestKind: 'configured',
    manualRecovery: cfg.manualBanRecovery === true });
}
export function saveBackoff(cfg, error, now = Date.now()) {
  const fallback = error.httpStatus === 418 ? 3600000 : [403, 451].includes(error.httpStatus) ? 3600000 : error.httpStatus === 429 ? 60000 : 30000;
  const previous = readBackoff(cfg);
  const deadline = Number.isFinite(error.retryAt) ? error.retryAt
    : now + (Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0);
  const retryAt = Math.max(now + fallback, deadline, previous?.retryAt || 0);
  const state = { exchange: cfg.exchange, httpStatus: error.httpStatus || (previous?.manualRecovery ? previous.httpStatus : null),
    retryAt, reason: error.message, updatedAt: now, requestKind: error.requestKind || null,
    manualRecovery: previous?.manualRecovery === true || (cfg.manualBanRecovery === true && error.httpStatus === 418) };
  return persistBackoff(cfg, state);
}
export function coolingError(state) {
  const e = new Error(state.reason || 'Nguồn dữ liệu đang yêu cầu chờ trước khi thử lại.');
  e.httpStatus = state.httpStatus; e.retryAt = state.retryAt; e.retryAfterMs = Math.max(0, state.retryAt - Date.now()); e.cooldown = true;
  return e;
}
export class RestQueue {
  constructor(cfg, request) { this.cfg = cfg; this.raw = request; this.queue = Promise.resolve(); this.nextAt = 0; this.interval = cfg.restIntervalMs ?? 350; this.localBackoff = null; }
  pause() { const saved = readBackoff(this.cfg); return saved || this.localBackoff; }
  get(url) {
    const task = async () => {
      const state = this.pause();
      if (requestsPaused(state)) throw coolingError(state);
      const wait = this.nextAt - Date.now(); if (wait > 0) await delay(wait);
      // A calibration worker may have received a ban while this request waited.
      const latest = this.pause();
      if (requestsPaused(latest)) throw coolingError(latest);
      try { return await this.raw(url); }
      catch (e) {
        if ([403, 418, 429, 451].includes(e.httpStatus)) {
          e.requestKind = 'market';
          this.localBackoff = saveBackoff(this.cfg, e);
          // The caller can display this already-saved deadline without re-saving it.
          e.retryAt = this.localBackoff.retryAt;
          e.cooldown = true;
        }
        throw e;
      } finally { this.nextAt = Date.now() + this.interval; }
    };
    const result = this.queue.then(task); this.queue = result.catch(() => {}); return result;
  }
}

