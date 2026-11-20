import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { dashboard } from './dashboard.js';
import { SignalEngine } from './engine.js';
import { SourceManager } from './source-manager.js';
import { runLiveSession } from './live-session.js';
import { BinanceLiveTrader, liveOptions, accountPollMs } from './binance-live-trader.js';
import { getJson } from './market.js';
import { controlError } from './live-controls.js';
import { coolingError, markRecovery, readBackoff, requestsPaused, saveBackoff, seedBackoff } from './provider-health.js';

const cfg = loadConfig({ HOST: process.env.HOST, PORT: process.env.PORT, EXCHANGE: 'binance', DATA_SOURCE_MODE: 'fixed', SYMBOLS: 'BTCUSDT,ETHUSDT' });
cfg.dataDir = process.env.LIVE_DATA_DIR || './live-data';
cfg.manualBanRecovery = true;
cfg.localPc = process.argv.includes('--local-pc');
cfg.dashboardUser = process.env.DASHBOARD_USER || 'bot'; cfg.dashboardPassword = process.env.DASHBOARD_PASSWORD || '';
if (cfg.dashboardPassword.length < 8) throw new Error('Set DASHBOARD_PASSWORD to at least 8 characters before starting real-account mode');
const trader = new BinanceLiveTrader(cfg, liveOptions()), sources = new SourceManager(cfg), abort = new AbortController();
if (cfg.localPc) trader.pause();
if (process.env.BINANCE_RETRY_NOT_BEFORE) {
  const until = Date.parse(process.env.BINANCE_RETRY_NOT_BEFORE);
  if (!Number.isFinite(until) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(process.env.BINANCE_RETRY_NOT_BEFORE)) throw new Error('BINANCE_RETRY_NOT_BEFORE must be an ISO date with timezone');
  seedBackoff(cfg, until);
}
const previousBackoff = readBackoff(cfg);
if (previousBackoff?.httpStatus === 418 && previousBackoff.manualRecovery === undefined) markRecovery(cfg, true, previousBackoff);
trader.api.retryAt = Math.max(trader.api.retryAt, previousBackoff?.retryAt || 0);
let engine, market = null, stopped = false, status = { phase: 'SELECTING', error: null };
let checkingConnection = false;

function showBackoff(state) {
  const waiting = state.retryAt > Date.now();
  const message = state.manualRecovery
    ? waiting ? 'Bot đã ngừng gọi API. Hết hạn chờ, dùng nút Kiểm tra kết nối Binance.' : 'Đã hết hạn chờ. Bot đang đợi bạn bấm Kiểm tra kết nối Binance.'
    : state.reason;
  if (status.phase !== 'BLOCKED' || status.retryAt !== state.retryAt) {
    console.warn('BINANCE COOLDOWN', state.httpStatus, new Date(state.retryAt).toJSON(),
      state.requestKind || 'saved/configured', state.manualRecovery ? 'manual check required' : 'automatic retry');
  }
  status = { phase: 'BLOCKED', error: message, retryAt: state.retryAt, httpStatus: state.httpStatus,
    recoveryRequired: !!state.manualRecovery, configuredDeadline: state.requestKind === 'configured' };
}

async function checkBinanceConnection() {
  const state = readBackoff(cfg);
  if (!state?.manualRecovery || status.phase !== 'BLOCKED') throw controlError('Bot không ở trạng thái chờ kiểm tra Binance.', 409);
  if (state.retryAt > Date.now()) throw controlError('Chưa hết hạn Binance yêu cầu chờ.', 409);
  if (trader.options.enabled) throw controlError(cfg.localPc
    ? 'Mở lại bot và chọn 1 (Chỉ đọc) trước khi kiểm tra kết nối.'
    : 'Đặt BINANCE_LIVE_ENABLED=false trước khi kiểm tra kết nối.', 409);
  if (checkingConnection || trader.busy) throw controlError('Đang xử lý kết nối. Thử lại sau.', 409);
  checkingConnection = true;
  try {
    // One official public request after the saved deadline. No account key or order request.
    const before = Date.now();
    const { serverTime } = await getJson('https://fapi.binance.com/fapi/v1/time',
      (url, options) => fetch(url, { ...options, redirect: 'error' }));
    if (!Number.isFinite(serverTime) || Math.abs(serverTime - (before + Date.now()) / 2) > 10000) {
      throw new Error('Binance chưa trả về giờ máy chủ hợp lệ.');
    }
    markRecovery(cfg, false);
    status = { phase: 'SELECTING', error: null, message: 'Kiểm tra công khai thành công. Đang nạp lại dữ liệu Binance.' };
    console.info('BINANCE CONNECTION CHECK passed');
  } catch (error) {
    error.requestKind = 'connection-check';
    showBackoff(saveBackoff(cfg, error));
    throw controlError('Chưa kết nối được Binance. Dashboard đã cập nhật thời gian chờ.', 409);
  } finally {
    checkingConnection = false;
  }
}

const server = dashboard(cfg, () => ({
  version: 'binance-live-4', demo: false, localPc: cfg.localPc, exchange: 'binance', sourceMode: 'fixed', sources: sources.snapshot(),
  symbols: cfg.symbols, timeframes: cfg.timeframes, htf: cfg.htf, pinbarEnabled: cfg.pinbarEnabled,
  serverNow: Date.now(), streamStaleMs: cfg.streamStaleMs, rows: [...(engine?.rows.values() || [])],
  status: { ...status, checkingConnection }, signals: [], candidates: [], trading: trader.snapshot(), validation: null,
  calibrationJob: { phase: 'DISABLED' }, telegram: { configured: false },
}), { '/api/live/pause': () => trader.pause(), '/api/live/resume': () => trader.resume(), '/api/live/settings': data => trader.setControls(data),
  '/api/live/check-connection': checkBinanceConnection });
server.on('error', e => { console.error(`Dashboard: ${e.code || 'failed'}`); stop(); process.exitCode = 1; });
server.listen(cfg.port, cfg.host, () => console.log(`BINANCE REAL ACCOUNT · orders ${trader.options.enabled ? 'ENABLED' : 'DISABLED'} · dashboard login required · /healthz`));
let nextAccountPoll = 0, lastPollMode = '';
function pollAccount() {
  if (stopped || trader.busy || requestsPaused(readBackoff(cfg))) return;
  // When reconnecting an idle account, confirm public market data before sending signed requests.
  if (status.phase !== 'STREAMING' && !trader.positions.length && !trader.state.entries.some(e => !['CLOSED', 'REJECTED'].includes(e.status))) return;
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
  const backoff = readBackoff(cfg);
  if (requestsPaused(backoff)) {
    showBackoff(backoff);
    await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
    continue;
  }
  try {
    status = { phase: 'SELECTING', error: null };
    const selected = await sources.choose(); market = selected.market; trader.api.offset = selected.offset;
    engine = new SignalEngine(cfg, { now: () => Date.now() + selected.offset, onSignal: signal => trader.enqueue(signal) });
    await runLiveSession({ cfg, market, engine, serverTime: selected.serverTime, now: () => Date.now() + selected.offset,
      signal: abort.signal, onStatus: patch => { status = { ...status, ...patch }; }, onReady: pollAccount,
      checkConnection: () => {
        const current = readBackoff(cfg);
        if (requestsPaused(current)) throw coolingError(current);
      } });
  } catch (e) {
    if (stopped) break;
    market = null; trader.pending = null; sources.failed(e);
    if (requestsPaused(readBackoff(cfg))) continue;
    const health = sources.snapshot()[0], retryAt = e.retryAt || health?.retryAt || Date.now() + 10000;
    status = { phase: [403, 418, 451].includes(e.httpStatus || health?.httpStatus) ? 'BLOCKED' : 'RETRYING', error: e.message, retryAt };
    console.error('BINANCE DATA', status.phase, e.message);
    while (!stopped && Date.now() < retryAt) await delay(Math.min(1000, retryAt - Date.now()), undefined, { signal: abort.signal }).catch(() => {});
  }
}
