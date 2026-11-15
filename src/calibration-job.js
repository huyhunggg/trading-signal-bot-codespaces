import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBackoff } from './provider-health.js';

export class CalibrationJob {
  constructor(cfg, spawnProcess = spawn) {
    this.cfg = cfg; this.spawnProcess = spawnProcess; this.child = null; this.closed = false;
    this.lastAttempt = -Infinity; this.status = { phase: cfg.validation.autoCalibrate ? 'WAITING' : 'MANUAL', startedAt: null, completedAt: null, error: null };
  }
  tick(gate, { streaming, demo = false, now = Date.now() }) {
    if (this.lastExchange !== this.cfg.exchange) this.lastAttempt = -Infinity;
    if (this.closed || demo || !streaming || !this.cfg.validation.autoCalibrate || this.child || now - this.lastAttempt < 3600000) return false;
    const paused = readBackoff(this.cfg);
    if (paused?.retryAt > now) { this.status = { ...this.status, phase: 'DELAYED', retryAt: paused.retryAt, error: 'Nguồn dữ liệu yêu cầu tạm dừng tải lịch sử.' }; return false; }
    try {
      const retry = JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'calibration-retry-after.json'), 'utf8'));
      if (Number.isFinite(retry.retryAt) && retry.retryAt > now) {
        this.status = { ...this.status, phase: 'DELAYED', retryAt: retry.retryAt, error: 'Sàn yêu cầu đợi trước khi tải lại lịch sử.' }; return false;
      }
    } catch {}
    const status = gate.reportStatus(now);
    if (status === 'READY' && now - gate.report.dataThrough < 86400000) return false;
    this.lastAttempt = now; this.lastExchange = this.cfg.exchange;
    let fd;
    try {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(path.join(this.cfg.dataDir, 'calibration.log'), 'a', 0o600);
      const child = this.spawnProcess(process.execPath, [`--max-old-space-size=${this.cfg.validation.heapMb}`, '--use-env-proxy', '--env-file-if-exists=.env', fileURLToPath(new URL('../scripts/calibrate.js', import.meta.url))],
        { cwd: process.cwd(), env: { ...process.env, DATA_DIR: this.cfg.dataDir, EXCHANGE: this.cfg.exchange, DATA_SOURCE_MODE: 'fixed' }, stdio: ['ignore', fd, fd, 'ipc'] });
      this.child = child; this.status = { phase: 'RUNNING', exchange: this.cfg.exchange, startedAt: now, completedAt: null, error: null };
      let failure = null;
      child.on('message', message => {
        if (message?.type === 'progress' && typeof message.detail === 'string') {
          this.status = { ...this.status, progress: message.detail.slice(0, 300), updatedAt: Date.now() };
        }
        if (message?.type === 'failure' && typeof message.detail === 'string') failure = message.detail.slice(0, 300);
      });
      let finished = false;
      const finish = (ok, signal) => {
        if (finished) return; finished = true; this.child = null;
        this.status = { ...this.status, phase: ok ? 'COMPLETED' : 'FAILED', completedAt: Date.now(),
          error: ok ? null : failure || (signal ? `Tiến trình kiểm chứng dừng (${signal}); cần kiểm tra giới hạn bộ nhớ và nhật ký máy chủ.` : 'Chưa kiểm chứng được lịch sử. Xem data/calibration.log; không gán tỷ lệ thắng giả.') };
        gate.lastRead = -Infinity;
      };
      child.once('exit', (code, signal) => finish(code === 0, signal)); child.once('error', () => finish(false));
      return true;
    } catch {
      this.status = { phase: 'FAILED', startedAt: now, completedAt: Date.now(), error: 'Không khởi động được kiểm chứng lịch sử.' }; return false;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  stop() { this.closed = true; this.child?.kill('SIGTERM'); }
  cancel() { this.child?.kill('SIGTERM'); this.lastAttempt = -Infinity; }
}
