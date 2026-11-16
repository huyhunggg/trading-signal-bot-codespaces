import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PaperBroker } from '../src/paper-broker.js';

const sig = (side = 'LONG', id = 'one') => ({ id, symbol: 'BTCUSDT', exchange: 'okx', side, layer: 'DEMO_SCRIPT', observedAt: 100000,
  sl: side === 'LONG' ? 98 : 102, tp1: side === 'LONG' ? 102 : 98 });
test('paper long and short debit entry/exit fees and reconcile equity to net trade PnL', () => {
  for (const side of ['LONG', 'SHORT']) {
    let now = 100000;
    const broker = new PaperBroker({ now: () => now });
    assert.equal(broker.open(sig(side), { price: 100, at: now }), true);
    assert.ok(broker.snapshot().balance < 10000); assert.equal(broker.snapshot().positions.length, 1);
    now += 1000; broker.mark({ BTCUSDT: { price: side === 'LONG' ? 103 : 97, at: now } });
    const s = broker.snapshot(), trade = s.trades[0];
    assert.equal(s.positions.length, 0); assert.equal(trade.reason, 'TP'); assert.ok(trade.pnl > 0);
    assert.ok(Math.abs(s.equity - 10000 - trade.pnl) < 1e-9);
    assert.ok(Math.abs(s.totalFees - trade.entryFee - trade.exitFee) < 1e-9);
    assert.ok(Math.abs(s.realizedPnl - trade.pnl) < 1e-9);
  }
});
test('paper stop gaps use observed adverse price and stale ticks cannot close a position', () => {
  let now = 100000; const b = new PaperBroker({ now: () => now });
  b.open(sig(), { price: 100, at: now }); now += 20000;
  b.mark({ BTCUSDT: { price: 97, at: 100000 } }); assert.equal(b.snapshot().trades.length, 0);
  b.mark({ BTCUSDT: { price: 95, at: now } });
  assert.equal(b.snapshot().trades[0].reason, 'SL'); assert.ok(b.snapshot().trades[0].exit < 95); assert.ok(b.snapshot().trades[0].pnl < 0);
});
test('paper pause prevents new entries, keeps exits active; reset clears only virtual account', () => {
  let now = 100000; const b = new PaperBroker({ now: () => now });
  b.pause(); assert.equal(b.open(sig(), { price: 100, at: now }), false);
  b.resume(); assert.equal(b.open(sig(), { price: 100, at: now }), true);
  b.pause(); now += 1000; b.mark({ BTCUSDT: { price: 103, at: now } }); assert.equal(b.snapshot().trades.length, 1);
  b.reset(); assert.equal(b.snapshot().balance, 10000); assert.equal(b.snapshot().trades.length, 0); assert.equal(b.snapshot().paused, false);
});
test('virtual ledger survives restart and rejects duplicate/stale/unfinished signals or wrong-venue ticks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ledger-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json'); let now = 100000;
  let b = new PaperBroker({ file, now: () => now, mode: 'PAPER_LIVE' });
  assert.equal(b.open({ ...sig(), layer: 'IMPULSE' }, { price: 100, at: now }), false);
  assert.equal(b.open({ ...sig(), observedAt: 0 }, { price: 100, at: now }), false);
  assert.equal(b.open({ ...sig(), layer: 'CLOSED', closed: false }, { price: 100, at: now }), false);
  b.open(sig(), { price: 100, at: now });
  b = new PaperBroker({ file, now: () => now, mode: 'PAPER_LIVE' }); assert.equal(b.snapshot().positions.length, 1);
  now += 1000; b.mark({ BTCUSDT: { price: 103, at: now, exchange: 'bybit' } }); assert.equal(b.snapshot().trades.length, 0);
  b.mark({ BTCUSDT: { price: 103, at: now, exchange: 'okx' } }); assert.equal(b.snapshot().trades.length, 1);
  assert.equal(b.open(sig(), { price: 100, at: now }), false);
});
test('actual offline demo immediately opens a virtual position without credentials/network and automatically closes it', { timeout: 15000 }, async t => {
  const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_FORBIDDEN")}', 'src/paper-main.js'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), OKX_DEMO_API_KEY: '', OKX_DEMO_SECRET_KEY: '', OKX_DEMO_PASSPHRASE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } });
  const url = `http://127.0.0.1:${port}`;
  let snapshot;
  for (let i = 0; i < 40; i++) {
    try { snapshot = await (await fetch(url + '/api/status')).json(); break; } catch { await delay(100); }
  }
  assert.ok(snapshot, logs); assert.equal(snapshot.trading.mode, 'PAPER_DEMO'); assert.equal(snapshot.trading.initialBalance, 10000);
  assert.equal(snapshot.trading.positions.length, 1); assert.equal(snapshot.trading.entries.length, 1);
  assert.equal(snapshot.telegram.configured, false);
  for (let i = 0; i < 60; i++) {
    snapshot = await (await fetch(url + '/api/status')).json(); if (snapshot.trading.trades.length) break; await delay(100);
  }
  assert.equal(snapshot.trading.trades.length, 1); assert.equal(snapshot.trading.trades[0].reason, 'TP');
  assert.equal((await fetch(url + '/api/paper/reset', { method: 'POST', headers: { 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await fetch(url + '/api/paper/reset', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })).status, 403);
  const post = action => fetch(url + '/api/paper/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const paused = await (await post('pause')).json(); assert.equal(paused.trading.paused, true);
  const reset = await (await post('reset')).json(); assert.equal(reset.trading.trades.length, 0); assert.equal(reset.trading.positions.length, 1);
  assert.ok(!logs.includes('NETWORK_FORBIDDEN'), logs);
});
