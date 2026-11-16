import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Market, getJson } from '../src/market.js';
import { loadConfig } from '../src/config.js';
import { PaperBroker } from '../src/paper-broker.js';
import { PaperExecution } from '../src/paper-execution.js';

const now = 1800000000000;
const signal = (side = 'LONG') => ({ id: 'binance:BTCUSDT:5m:123:' + side, exchange: 'binance', symbol: 'BTCUSDT',
  layer: 'CLOSED', closed: true, timeframe: '5m', side, referencePrice: 100,
  observedAt: now, candleEndTime: now - 1000, sl: side === 'LONG' ? 98 : 102, tp1: side === 'LONG' ? 102 : 98 });
const quote = (at = now, bid = 100, ask = 100.1) => ({ symbol: 'BTCUSDT', exchange: 'binance', price: (bid + ask) / 2, bid, ask, at });

test('Binance paper quote uses only the official public bookTicker endpoint and validates response timestamps/venue', async () => {
  const urls = [], cfg = { ...loadConfig({ EXCHANGE: 'binance', DATA_SOURCE_MODE: 'fixed' }), restIntervalMs: 0 };
  let response = { symbol: 'BTCUSDT', bidPrice: '100', askPrice: '100.1', time: now };
  const market = new Market(cfg, async url => { urls.push(url); return response; });
  const q = await market.quote('BTCUSDT', now);
  assert.equal(q.bid, 100); assert.equal(q.ask, 100.1); assert.equal(q.exchange, 'binance');
  assert.equal(urls[0], 'https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT');
  for (const bad of [{ ...response, time: now - 16000 }, { ...response, time: now + 1001 }, { ...response, askPrice: '99' }, { ...response, symbol: 'ETHUSDT' }, { ...response, bidPrice: 'NaN' }]) {
    response = bad; await assert.rejects(market.quote('BTCUSDT', now), /Quote/);
  }
  await assert.rejects(market.quote('FOOUSDT', now), /Unsupported/);
  assert.ok(urls.every(url => !/signature|apiKey|\/order/.test(url)));
});

test('live paper waits for a post-signal quote and uses executable ask/bid with fees and slippage', () => {
  let time = now; const b = new PaperBroker({ now: () => time, mode: 'PAPER_LIVE', exchange: 'binance' });
  const executor = new PaperExecution(b, 'binance', { now: () => time });
  assert.equal(executor.enqueue(signal()), true);
  executor.update(quote(now - 1)); assert.equal(b.snapshot().positions.length, 0);
  time += 1000; executor.update(quote(time, 100.5, 100.6));
  assert.equal(b.snapshot().positions.length, 1);
  assert.ok(Math.abs(b.state.position.entry - 100.6 * 1.0002) < 1e-12);
  assert.notEqual(b.state.position.entry, signal().referencePrice);
  // Midpoint is above stop, but bid crosses it: selling the long must stop.
  time += 1000; executor.update(quote(time, 97.9, 98.5));
  assert.equal(b.state.trades[0].reason, 'SL'); assert.ok(Math.abs(b.state.trades[0].exit - 97.9 * 0.9998) < 1e-12);
  assert.ok(Math.abs(b.snapshot().balance - 10000 - b.state.trades[0].pnl) < 1e-9);
});
test('short fills at bid and covers at ask; quotes from another exchange and unfinished/stale signals cannot enter', () => {
  let time = now; const b = new PaperBroker({ now: () => time, mode: 'PAPER_LIVE', exchange: 'binance' });
  const e = new PaperExecution(b, 'binance', { now: () => time });
  for (const s of [{ ...signal(), exchange: 'okx' }, { ...signal(), layer: 'IMPULSE' }, { ...signal(), closed: false }, { ...signal(), candleEndTime: now - 61000 }]) assert.equal(e.enqueue(s), false);
  e.enqueue(signal('SHORT')); e.update({ ...quote(), exchange: 'okx' }); assert.equal(b.state.position, null);
  e.update(quote()); assert.ok(Math.abs(b.state.position.entry - 100 * 0.9998) < 1e-12);
  time += 1000; e.update(quote(time, 97.7, 98.1)); assert.equal(b.state.trades.length, 0);
  time += 1000; e.update(quote(time, 97.6, 97.9)); assert.equal(b.state.trades[0].reason, 'TP');
  assert.ok(Math.abs(b.state.trades[0].exit - 97.9 * 1.0002) < 1e-12);
});
test('disconnect clears pending signals; missed or stale quotes never invent a fill', () => {
  let time = now; const b = new PaperBroker({ now: () => time, mode: 'PAPER_LIVE', exchange: 'binance' });
  const e = new PaperExecution(b, 'binance', { now: () => time });
  e.enqueue(signal()); e.clear(); e.update(quote()); assert.equal(b.state.position, null);
  e.enqueue(signal()); time += 61000; e.update(quote(time)); assert.equal(b.state.position, null); assert.equal(e.pending, null);
  assert.equal(b.open({ ...signal(), observedAt: time, candleEndTime: time }, { ...quote(time), exchange: 'okx' }), false);
});

test('HTTP 451 from Binance is surfaced instead of returning simulated prices', async () => {
  await assert.rejects(getJson('https://fapi.binance.com/fapi/v1/time', async () => new Response('{"code":0,"msg":"restricted"}', { status: 451 })), err => err.httpStatus === 451 && /khu vực/.test(err.message));
});

async function startProcess(t, blocked) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binance-paper-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const preload = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(preload, `
import { EventEmitter } from 'node:events';
import { Market } from ${JSON.stringify(new URL('../src/market.js', import.meta.url).href)};
Market.prototype.stream = function() { const socket = new EventEmitter(); socket.terminate=()=>{}; queueMicrotask(()=>socket.emit('close')); return socket; };
globalThis.fetch = async (url, opts={}) => {
  const u = new URL(url);
  if (u.origin !== 'https://fapi.binance.com' || (opts.method && opts.method !== 'GET') || opts.headers || u.searchParams.has('signature')) throw new Error('UNEXPECTED_NETWORK_OR_PRIVATE_API');
  const now = Date.now();
  if (${blocked}) return new Response('{"code":0,"msg":"restricted"}', {status:451});
  let payload;
  if (u.pathname === '/fapi/v1/time') payload={serverTime:now};
  else if (u.pathname === '/fapi/v1/ticker/bookTicker') payload={symbol:u.searchParams.get('symbol'),bidPrice:'100',askPrice:'100.1',time:now};
  else if (u.pathname === '/fapi/v1/klines') {
    const tf={'5m':300000,'15m':900000,'1h':3600000}[u.searchParams.get('interval')];
    const count=Number(u.searchParams.get('limit')),end=Math.floor(now/tf)*tf;
    payload=Array.from({length:count},(_,i)=>[count===2?end+(i-1)*tf:end-(count-i)*tf,'100','100.1','99.9','100','100']);
  } else throw new Error('UNEXPECTED_NETWORK_OR_PRIVATE_API');
  return new Response(JSON.stringify(payload),{status:200});
};
`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'src/paper-main.js', '--live', '--binance'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PAPER_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } fs.rmSync(dir, { recursive: true, force: true }); });
  const get = async () => (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  let s;
  for (let i = 0; i < 150; i++) {
    try { s = await get(); if (blocked ? s.status.phase === 'BLOCKED' : s.status.phase === 'STREAMING' && s.rows.length === 6 && s.trading.quoteUpdatedAt) break; } catch {}
    await delay(100);
  }
  return { snapshot: s, logs, dir };
}

test('Binance runner boots with public-only fixture, six market rows and a separate real-price virtual ledger', { timeout: 25000 }, async t => {
  const { snapshot: s, logs, dir } = await startProcess(t, false);
  assert.ok(s, logs); assert.equal(s.exchange, 'binance'); assert.equal(s.sourceMode, 'fixed'); assert.equal(s.demo, false);
  assert.equal(s.status.phase, 'STREAMING'); assert.equal(s.rows.length, 6); assert.ok(s.trading.quoteUpdatedAt);
  assert.equal(s.trading.exchange, 'binance'); assert.equal(s.trading.initialBalance, 10000); assert.equal(s.trading.entries.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'ledger.json')) === false); // No virtual entry/reset yet.
  assert.ok(!logs.includes('UNEXPECTED_NETWORK_OR_PRIVATE_API'), logs);
});
test('Binance runner exposes region denial and preserves untouched virtual funds without switching venues', { timeout: 10000 }, async t => {
  const { snapshot: s, logs } = await startProcess(t, true);
  assert.ok(s, logs); assert.equal(s.status.phase, 'BLOCKED'); assert.equal(s.status.httpStatus, 451);
  assert.equal(s.exchange, 'binance'); assert.deepEqual(s.sources.map(p => p.exchange), ['binance']);
  assert.equal(s.trading.balance, 10000); assert.equal(s.trading.entries.length, 0); assert.equal(s.trading.quoteUpdatedAt, null);
  assert.match(s.status.error, /451/);
});
