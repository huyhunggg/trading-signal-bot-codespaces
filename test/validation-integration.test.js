import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { ...loadConfig({}), dataDir: dir, telegramToken: 'TEST_TOKEN_NEVER_SENT', telegramChatId: '123' };
  return { cfg, store: new Store(cfg) };
}
const signal = (i = 0) => ({ id: 'candidate:' + i, exchange: 'binance', symbol: 'BTCUSDT', timeframe: '5m', layer: 'CLOSED', side: i === 1 ? 'SHORT' : 'LONG', branch: 'RSI_HOOK', candleOpenTime: i * 300000, candleEndTime: (i + 1) * 300000, observedAt: (i + 1) * 300000 + 1, validation: { eligible: false, winRate: null } });

test('unverified candidates stay visible without entering the Telegram queue and survive restart', t => {
  const { cfg, store } = setup(t), s = signal();
  assert.equal(store.recordCandidate(s), true); assert.equal(store.state.pending.length, 0); assert.equal(store.state.recent.length, 0);
  assert.equal(new Store(cfg).state.watchlist[0].validation.winRate, null);
  assert.equal(store.recordCandidate(s), false);
  assert.equal(store.accept({ ...s, validation: { eligible: true } }), true);
  assert.equal(store.state.watchlist.length, 0); assert.equal(store.state.pending.length, 1);
});
test('raw-signal cooldown applies even to rejected candidates, matching backtest sampling', t => {
  const { cfg, store } = setup(t);
  assert.equal(store.reserveCandidate(signal(0)), true);
  assert.equal(new Store(cfg).reserveCandidate({ ...signal(3), branch: 'PINBAR_RECLAIM' }), false);
  assert.equal(store.reserveCandidate(signal(4)), true);
});
test('delivery gate drops legacy or newly ineligible queued alerts before sending', async t => {
  const { cfg, store } = setup(t), old = signal(0), good = { ...signal(1), validation: { eligible: true } };
  store.accept(old); store.accept(good); const sent = [];
  await store.flush(good.observedAt + 1, async (_, s) => sent.push(s.id), s => s.validation?.eligible === true);
  assert.deepEqual(sent, [good.id]); assert.equal(store.state.delivery.unverifiedRemoved, 1);
  assert.equal(new Store(cfg).state.pending.length, 0);
});
test('actual demo process serves six visible rows and unknown rates without claiming validation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-process-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), '--demo'], {
    cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODESPACE_NAME: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } fs.rmSync(dir, { recursive: true, force: true }); });
  let data;
  for (let i = 0; i < 100; i++) {
    try { data = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json(); if (data.rows.length === 6) break; } catch {}
    if (child.exitCode !== null) break;
    await delay(50);
  }
  assert.ok(data, output); assert.equal(data.rows.length, 6); assert.equal(data.validation.status, 'DEMO');
  assert.equal(data.validation.target, 0.8); assert.equal(data.telegram.configured, false);
  assert.ok(data.signals.length > 0); assert.ok(data.signals.every(s => s.validation.eligible === false && s.validation.winRate === null));
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(page, /Kiểm chứng trước khi thông báo/); assert.match(page, /Cơ hội chưa đạt vẫn hiển thị/);
  assert.match(output, new RegExp('Dashboard: http://127.0.0.1:' + port));
});
