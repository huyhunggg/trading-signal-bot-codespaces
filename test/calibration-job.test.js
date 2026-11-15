import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../src/config.js';
import { CalibrationJob } from '../src/calibration-job.js';

function setup(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-job-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const cfg = { ...loadConfig(env), dataDir }, children = [], calls = [];
  const job = new CalibrationJob(cfg, (...args) => {
    calls.push(args); const child = new EventEmitter(); child.kill = () => { child.killed = true; child.emit('exit', null); };
    children.push(child); return child;
  });
  const gate = { reportStatus: () => 'MISSING_PROFILE', report: null, lastRead: 0 };
  return { job, gate, calls, children, cfg };
}
test('automatic calibration starts only with a live stream, never for demo or manual mode', t => {
  const { job, gate, calls } = setup(t);
  assert.equal(job.tick(gate, { streaming: false, now: 1000000 }), false);
  assert.equal(job.tick(gate, { streaming: true, demo: true, now: 1000000 }), false);
  assert.equal(calls.length, 0);
  assert.equal(job.tick(gate, { streaming: true, now: 1000000 }), true);
  assert.equal(job.status.phase, 'RUNNING');
  const manual = setup(t, { AUTO_CALIBRATE: 'false' });
  assert.equal(manual.job.tick(manual.gate, { streaming: true, now: 1000000 }), false);
});
test('a running calibration is not duplicated and successful exit invalidates the report cache', t => {
  const { job, gate, children, calls, cfg } = setup(t);
  assert.equal(job.tick(gate, { streaming: true, now: 1000000 }), true);
  assert.equal(job.tick(gate, { streaming: true, now: 5000000 }), false);
  assert.equal(calls.length, 1); assert.equal(calls[0][2].env.DATA_DIR, cfg.dataDir);
  assert.ok(calls[0][1].at(-1).endsWith('/scripts/calibrate.js'));
  children[0].emit('exit', 0);
  assert.equal(job.status.phase, 'COMPLETED'); assert.equal(gate.lastRead, -Infinity);
});
test('a fresh report skips downloads, failure retries at most hourly, and shutdown stops the worker', t => {
  const { job, gate, children } = setup(t), now = 100000000;
  gate.reportStatus = () => 'READY'; gate.report = { dataThrough: now - 1000 };
  assert.equal(job.tick(gate, { streaming: true, now }), false);
  gate.reportStatus = () => 'MISSING_PROFILE';
  assert.equal(job.tick(gate, { streaming: true, now }), true);
  children[0].emit('error', new Error('injected failure')); assert.equal(job.status.phase, 'FAILED');
  assert.equal(job.tick(gate, { streaming: true, now: now + 3599999 }), false);
  assert.equal(job.tick(gate, { streaming: true, now: now + 3600000 }), true);
  job.stop(); assert.equal(children[1].killed, true);
  assert.equal(job.tick(gate, { streaming: true, now: now + 7200000 }), false);
});
test('automatic downloads honor a server retry-after longer than the hourly retry interval', t => {
  const { job, gate, calls, cfg } = setup(t), now = 1000000;
  fs.writeFileSync(path.join(cfg.dataDir, 'calibration-retry-after.json'), JSON.stringify({ retryAt: now + 7200000 }));
  assert.equal(job.tick(gate, { streaming: true, now }), false);
  assert.equal(job.status.phase, 'DELAYED'); assert.equal(calls.length, 0);
  assert.equal(job.tick(gate, { streaming: true, now: now + 7200001 }), true);
});
