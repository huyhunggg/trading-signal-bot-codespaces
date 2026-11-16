import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { PaperBroker } from './paper-broker.js';
import { dashboard } from './dashboard.js';
import { SignalEngine } from './engine.js';
import { SourceManager } from './source-manager.js';
import { runLiveSession } from './live-session.js';
import { PaperExecution } from './paper-execution.js';

const live = process.argv.includes('--live');
const exchange = process.argv.includes('--binance') ? 'binance' : 'okx';
// Ignore account credentials and Telegram settings in both virtual-only modes.
const cfg = loadConfig({ HOST: process.env.HOST, PORT: process.env.PORT, EXCHANGE: exchange, DATA_SOURCE_MODE: 'fixed' });
const dir = process.env.PAPER_DATA_DIR || `./paper-data/${exchange}`;
if (live) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const broker = new PaperBroker({ mode: live ? 'PAPER_LIVE' : 'PAPER_DEMO', exchange: live ? exchange : null, file: live ? path.join(dir, 'ledger.json') : null });
if (live && broker.state.position && broker.state.position.exchange !== exchange) throw new Error('Paper ledger belongs to another exchange. Choose a separate PAPER_DATA_DIR.');
const execution = live ? new PaperExecution(broker, exchange) : null;
const sources = live ? new SourceManager({ ...cfg, dataDir: dir }) : null;
const controller = new AbortController(), quotes = {};
let rows = [], engine, activeMarket, quoteBusy = false, quoteError = null, stopped = false, tick = 0, generation = Date.now(), nextEntry = 0, entries = 0;
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
  '/api/paper/pause': () => { execution?.clear(); broker.pause(); },
  '/api/paper/resume': () => broker.resume(),
  '/api/paper/reset': () => {
    broker.reset();
    execution?.clear();
    if (!live) { tick = 0; entries = 0; nextEntry = 0; generation = Date.now(); demoTick(); }
  },
};
const server = dashboard(cfg, () => ({
  version: 'paper-2', demo: !live, exchange: live ? cfg.exchange : 'synthetic', sourceMode: live ? cfg.sourceMode : 'offline', sources: sources?.snapshot() || [],
  symbols: cfg.symbols, timeframes: cfg.timeframes, htf: cfg.htf, serverNow: Date.now(), streamStaleMs: cfg.streamStaleMs,
  pinbarEnabled: cfg.pinbarEnabled, status, rows, signals: [], candidates: [], trading: { ...broker.snapshot(), quoteError,
    marketPhase: status.phase, marketError: status.error,
    pendingSignal: execution?.pending ? { symbol: execution.pending.symbol, side: execution.pending.side } : null,
    quoteUpdatedAt: live ? Math.max(0, ...Object.values(execution.quotes).map(q => q.at)) || null : null },
  validation: { status: 'PAPER', reason: live ? 'Giao dịch ảo theo tín hiệu đóng nến; chưa có hiệu quả được kiểm chứng.' : 'Kịch bản tự mua/bán minh họa chạy mỗi giây; không đo tỷ lệ thắng chiến lược.', minSamples: 0, target: 0.8 },
  calibrationJob: { phase: 'DISABLED' }, telegram: { configured: false },
}), actions);
server.on('error', e => { console.error(`Dashboard: ${e.code || 'listen failed'}`); stop(); process.exitCode = 1; });
server.listen(cfg.port, cfg.host, () => console.log(`PAPER ${live ? exchange.toUpperCase() : 'DEMO'} · 10,000 virtual USDT · http://localhost:${cfg.port} · NO ACCOUNT / NO API KEY`));
async function liveTick() {
  if (quoteBusy || !activeMarket || stopped) return;
  quoteBusy = true;
  const market = activeMarket;
  try {
    for (const symbol of cfg.symbols) {
      const quote = await market.quote(symbol);
      if (stopped || market !== activeMarket) return;
      execution.update(quote);
    }
    quoteError = null;
    if (!broker.state.entries.length && !broker.state.position && !execution.pending && !broker.state.paused) {
      broker.reason = `Đã nhận bid/ask ${exchange.toUpperCase()}. Đang chờ tín hiệu RSI Hook / Pin-bar trên nến đóng; bot không tự luân phiên mua/bán.`;
    }
    rows = [...(engine?.rows.values() || [])].map(r => {
      const q = execution.quotes[r.symbol];
      return q ? { ...r, price: q.price, priceKind: 'LAST_PRICE', updatedAt: q.at } : r;
    });
  } catch (e) {
    execution.clear();
    quoteError = { message: e.message, httpStatus: e.httpStatus || null, retryAt: e.retryAt || null };
  } finally { quoteBusy = false; }
}
const timer = setInterval(() => {
  if (!live) demoTick();
  else void liveTick();
}, 1000);
function stop() { if (stopped) return; stopped = true; controller.abort(); clearInterval(timer); broker.save(); server.close(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
if (!live) demoTick();
else {
  while (!stopped) {
    try {
      status = { ...status, phase: 'SELECTING', error: null, retryAt: null };
      const selected = await sources.choose();
      // SourceManager's cfg is separate: keep the signal engine and ledger on its chosen venue.
      cfg.exchange = sources.cfg.exchange;
      execution.clear(); activeMarket = selected.market;
      engine = new SignalEngine(cfg, { now: () => Date.now() + selected.offset, onSignal: signal => {
        execution.enqueue(signal);
      } });
      await runLiveSession({ cfg, market: selected.market, engine, serverTime: selected.serverTime,
        now: () => Date.now() + selected.offset, signal: controller.signal,
        onStatus: patch => { status = { ...status, ...patch }; }, onReady: () => {} });
    } catch (e) {
      if (stopped) break;
      activeMarket = null; execution.clear(); sources.failed(e);
      const health = sources.snapshot().find(s => s.exchange === exchange);
      const httpStatus = e.httpStatus || health?.httpStatus;
      const retryAt = e.retryAt || health?.retryAt || Date.now() + 5000;
      status = { phase: [403, 418, 451].includes(httpStatus) ? 'BLOCKED' : 'RETRYING', httpStatus, retryAt,
        error: `${exchange.toUpperCase()}: ${health?.reason || e.message || 'Chưa nhận được giá công khai.'} Tiền ảo đang chờ dữ liệu.` };
      while (!stopped && Date.now() < retryAt) await delay(Math.min(1000, retryAt - Date.now()), undefined, { signal: controller.signal }).catch(() => {});
    }
  }
}
