import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { PaperBroker } from './paper-broker.js';
import { dashboard } from './dashboard.js';
import { SignalEngine } from './engine.js';
import { SourceManager } from './source-manager.js';
import { runLiveSession } from './live-session.js';

const live = process.argv.includes('--live');
// Ignore account credentials and Telegram settings in both virtual-only modes.
const cfg = loadConfig({ HOST: process.env.HOST, PORT: process.env.PORT });
cfg.sourceMode = 'fixed'; cfg.sourceOrder = ['okx'];
const dir = process.env.PAPER_DATA_DIR || './paper-data';
if (live) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const broker = new PaperBroker({ mode: live ? 'PAPER_LIVE' : 'PAPER_DEMO', file: live ? path.join(dir, 'ledger.json') : null });
const controller = new AbortController(), quotes = {};
let rows = [], engine, stopped = false, tick = 0, generation = Date.now(), nextEntry = 0, entries = 0;
let status = { phase: live ? 'SELECTING' : 'DEMO', transport: live ? null : 'OFFLINE', error: null };
const base = { BTCUSDT: 70000, ETHUSDT: 2500, SOLUSDT: 150 };
function demoTick() {
  const now = Date.now();
  rows = cfg.symbols.flatMap((symbol, i) => {
    const price = base[symbol] * (1 + 0.008 * Math.sin(tick / 6 + i));
    quotes[symbol] = { price, at: now, exchange: 'synthetic' };
    return cfg.timeframes.map(timeframe => ({ symbol, timeframe, price, updatedAt: now, priceKind: 'LAST_PRICE', htf: 'NEUTRAL', closedChecks: [] }));
  });
  const hadPosition = !!broker.state.position;
  broker.mark(quotes);
  if (hadPosition && !broker.state.position) nextEntry = tick + 3;
  if (!broker.state.position && tick >= nextEntry && !broker.state.paused) {
    const symbol = cfg.symbols[entries % cfg.symbols.length], price = quotes[symbol].price, side = entries % 2 ? 'SHORT' : 'LONG', sign = side === 'LONG' ? 1 : -1;
    if (broker.open({ id: `showcase:${generation}:${entries}`, symbol, exchange: 'synthetic', side, layer: 'DEMO_SCRIPT', observedAt: now,
      sl: price * (1 - sign * 0.004), tp1: price * (1 + sign * 0.004) }, quotes[symbol])) entries++;
  }
  tick++;
}
const actions = {
  '/api/paper/pause': () => broker.pause(),
  '/api/paper/resume': () => broker.resume(),
  '/api/paper/reset': () => {
    broker.reset();
    if (!live) { tick = 0; entries = 0; nextEntry = 0; generation = Date.now(); demoTick(); }
  },
};
const server = dashboard(cfg, () => ({
  version: 'paper-1', demo: !live, exchange: live ? cfg.exchange : 'synthetic', sourceMode: live ? cfg.sourceMode : 'offline', sources: [],
  symbols: cfg.symbols, timeframes: cfg.timeframes, htf: cfg.htf, serverNow: Date.now(), streamStaleMs: cfg.streamStaleMs,
  pinbarEnabled: false, status, rows, signals: [], candidates: [], trading: broker.snapshot(),
  validation: { status: 'PAPER', reason: live ? 'Giao dịch ảo theo tín hiệu đóng nến; chưa có hiệu quả được kiểm chứng.' : 'Kịch bản tự mua/bán minh họa chạy mỗi giây; không đo tỷ lệ thắng chiến lược.', minSamples: 0, target: 0.8 },
  calibrationJob: { phase: 'DISABLED' }, telegram: { configured: false },
}), actions);
server.on('error', e => { console.error(`Dashboard: ${e.code || 'listen failed'}`); stop(); process.exitCode = 1; });
server.listen(cfg.port, cfg.host, () => console.log(`PAPER ${live ? 'LIVE' : 'DEMO'} · 10,000 virtual USDT · http://localhost:${cfg.port} · NO ACCOUNT / NO API KEY`));
const timer = setInterval(() => {
  if (!live) demoTick();
  else {
    rows = [...(engine?.rows.values() || [])];
    for (const r of rows) if (r.priceKind === 'LAST_PRICE' && (!quotes[r.symbol] || r.updatedAt >= quotes[r.symbol].at)) quotes[r.symbol] = { price: r.price, at: r.updatedAt, exchange: cfg.exchange };
    broker.mark(quotes);
  }
}, 1000);
function stop() { if (stopped) return; stopped = true; controller.abort(); clearInterval(timer); broker.save(); server.close(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
if (!live) demoTick();
else {
  const sources = new SourceManager({ ...cfg, dataDir: dir });
  while (!stopped) {
    try {
      const selected = await sources.choose();
      // SourceManager's cfg is separate: keep the signal engine and ledger on its chosen venue.
      cfg.exchange = sources.cfg.exchange;
      for (const key of Object.keys(quotes)) delete quotes[key];
      engine = new SignalEngine(cfg, { now: () => Date.now() + selected.offset, onSignal: signal => {
        // A candle close is an observed price; the next tick will update the position.
        if (signal.layer === 'CLOSED') broker.open(signal, { price: signal.referencePrice, at: Date.now(), exchange: signal.exchange });
      } });
      await runLiveSession({ cfg, market: selected.market, engine, serverTime: selected.serverTime,
        now: () => Date.now() + selected.offset, signal: controller.signal,
        onStatus: patch => { status = { ...status, ...patch }; }, onReady: () => {} });
    } catch (e) {
      if (stopped) break;
      sources.failed(e); status = { phase: 'RETRYING', error: 'Chưa nhận được giá công khai. Đang thử lại; không dùng giá giả.' };
      await delay(5000, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
}
