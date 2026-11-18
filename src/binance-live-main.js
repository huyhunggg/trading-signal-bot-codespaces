import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { dashboard } from './dashboard.js';
import { SignalEngine } from './engine.js';
import { SourceManager } from './source-manager.js';
import { runLiveSession } from './live-session.js';
import { BinanceLiveTrader, liveOptions, accountPollMs } from './binance-live-trader.js';
import { seedBackoff } from './provider-health.js';

const cfg = loadConfig({ HOST: process.env.HOST, PORT: process.env.PORT, EXCHANGE: 'binance', DATA_SOURCE_MODE: 'fixed', SYMBOLS: 'BTCUSDT,ETHUSDT' });
cfg.dataDir = process.env.LIVE_DATA_DIR || './live-data';
cfg.dashboardUser = process.env.DASHBOARD_USER || 'bot'; cfg.dashboardPassword = process.env.DASHBOARD_PASSWORD || '';
if (cfg.dashboardPassword.length < 8) throw new Error('Set DASHBOARD_PASSWORD to at least 8 characters before starting real-account mode');
if (process.env.BINANCE_RETRY_NOT_BEFORE) {
  const until = Date.parse(process.env.BINANCE_RETRY_NOT_BEFORE);
  if (!Number.isFinite(until) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(process.env.BINANCE_RETRY_NOT_BEFORE)) throw new Error('BINANCE_RETRY_NOT_BEFORE must be an ISO date with timezone');
  seedBackoff(cfg, until);
}
const trader = new BinanceLiveTrader(cfg, liveOptions()), sources = new SourceManager(cfg), abort = new AbortController();
let engine, market = null, stopped = false, status = { phase: 'SELECTING', error: null };
const server = dashboard(cfg, () => ({
  version: 'binance-live-3', demo: false, exchange: 'binance', sourceMode: 'fixed', sources: sources.snapshot(),
  symbols: cfg.symbols, timeframes: cfg.timeframes, htf: cfg.htf, pinbarEnabled: cfg.pinbarEnabled,
  serverNow: Date.now(), streamStaleMs: cfg.streamStaleMs, rows: [...(engine?.rows.values() || [])],
  status, signals: [], candidates: [], trading: trader.snapshot(), validation: null, calibrationJob: { phase: 'DISABLED' }, telegram: { configured: false },
}), { '/api/live/pause': () => trader.pause(), '/api/live/resume': () => trader.resume(), '/api/live/settings': data => trader.setControls(data) });
server.on('error', e => { console.error(`Dashboard: ${e.code || 'failed'}`); stop(); process.exitCode = 1; });
server.listen(cfg.port, cfg.host, () => console.log(`BINANCE REAL ACCOUNT · orders ${trader.options.enabled ? 'ENABLED' : 'DISABLED'} · dashboard login required · /healthz`));
let nextAccountPoll = 0, lastPollMode = '';
function pollAccount() {
  if (stopped || trader.busy) return;
  const mode = [trader.options.enabled, trader.state.paused, trader.state.halt, status.phase].join(':');
  if (mode !== lastPollMode) { lastPollMode = mode; nextAccountPoll = 0; }
  if (Date.now() < nextAccountPoll) return;
  nextAccountPoll = Date.now() + accountPollMs(trader);
  void trader.tick(status.phase === 'STREAMING' ? market : null);
}
const tradingTimer = setInterval(pollAccount, 5000);
function stop() { if (stopped) return; stopped = true; abort.abort(); clearInterval(tradingTimer); trader.stop(); server.close(); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
while (!stopped) {
  try {
    status = { phase: 'SELECTING', error: null };
    const selected = await sources.choose(); market = selected.market; trader.api.offset = selected.offset;
    engine = new SignalEngine(cfg, { now: () => Date.now() + selected.offset, onSignal: signal => trader.enqueue(signal) });
    await runLiveSession({ cfg, market, engine, serverTime: selected.serverTime, now: () => Date.now() + selected.offset,
      signal: abort.signal, onStatus: patch => { status = { ...status, ...patch }; }, onReady: pollAccount });
  } catch (e) {
    if (stopped) break;
    market = null; trader.pending = null; sources.failed(e);
    const health = sources.snapshot()[0], retryAt = e.retryAt || health?.retryAt || Date.now() + 10000;
    status = { phase: [403, 418, 451].includes(e.httpStatus || health?.httpStatus) ? 'BLOCKED' : 'RETRYING', error: e.message, retryAt };
    console.error('BINANCE DATA', status.phase, e.message);
    while (!stopped && Date.now() < retryAt) await delay(Math.min(1000, retryAt - Date.now()), undefined, { signal: abort.signal }).catch(() => {});
  }
}
