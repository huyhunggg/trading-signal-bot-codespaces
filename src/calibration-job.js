import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class CalibrationJob {
  constructor(cfg, spawnProcess = spawn) {
    this.cfg = cfg; this.spawnProcess = spawnProcess; this.child = null; this.closed = false;
    this.lastAttempt = -Infinity; this.status = { phase: cfg.validation.autoCalibrate ? 'WAITING' : 'MANUAL', startedAt: null, completedAt: null, error: null };
  }
  tick(gate, { streaming, demo = false, now = Date.now() }) {
    if (this.closed || demo || !streaming || !this.cfg.validation.autoCalibrate || this.child || now - this.lastAttempt < 3600000) return false;
    try {
      const retry = JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'calibration-retry-after.json'), 'utf8'));
      if (Number.isFinite(retry.retryAt) && retry.retryAt > now) {
        this.status = { ...this.status, phase: 'DELAYED', retryAt: retry.retryAt, error: 'Sàn yêu cầu đợi trước khi tải lại lịch sử.' }; return false;
      }
    } catch {}
    const status = gate.reportStatus(now);
    if (status === 'READY' && now - gate.report.dataThrough < 86400000) return false;
    this.lastAttempt = now;
    let fd;
    try {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(path.join(this.cfg.dataDir, 'calibration.log'), 'a', 0o600);
      const child = this.spawnProcess(process.execPath, ['--use-env-proxy', '--env-file-if-exists=.env', fileURLToPath(new URL('../scripts/calibrate.js', import.meta.url))],
        { cwd: process.cwd(), env: { ...process.env, DATA_DIR: this.cfg.dataDir }, stdio: ['ignore', fd, fd] });
      this.child = child; this.status = { phase: 'RUNNING', startedAt: now, completedAt: null, error: null };
      let finished = false;
      const finish = ok => {
        if (finished) return; finished = true; this.child = null;
        this.status = { ...this.status, phase: ok ? 'COMPLETED' : 'FAILED', completedAt: Date.now(),
          error: ok ? null : 'Chưa kiểm chứng được lịch sử. Xem data/calibration.log; không gán tỷ lệ thắng giả.' };
        gate.lastRead = -Infinity;
      };
      child.once('exit', code => finish(code === 0)); child.once('error', () => finish(false));
      return true;
    } catch {
      this.status = { phase: 'FAILED', startedAt: now, completedAt: Date.now(), error: 'Không khởi động được kiểm chứng lịch sử.' }; return false;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  stop() { this.closed = true; this.child?.kill('SIGTERM'); }
}
