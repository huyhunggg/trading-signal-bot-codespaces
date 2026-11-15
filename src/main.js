import { setTimeout as delay } from 'node:timers/promises';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { SignalEngine } from './engine.js';
import { SourceManager } from './source-manager.js';
import { runLiveSession } from './live-session.js';
import { Store } from './store.js';
import { dashboard } from './dashboard.js';
import { runDemo } from './demo.js';
import { ValidationGate, REASONS } from './validation.js';
import { CalibrationJob } from './calibration-job.js';

const cfg = loadConfig(), demo = process.argv.includes('--demo'), check = process.argv.includes('--check');
if (demo) { cfg.telegramToken = ''; cfg.telegramChatId = ''; cfg.dataDir = './demo-data'; }
const sources = new SourceManager(cfg);

if (check) {
  try {
    const { market, serverTime } = await sources.choose();
    console.log(`REST ${cfg.exchange}: OK; server ${new Date(serverTime).toISOString()}`);
    for (const symbol of cfg.symbols) {
      const bars = await market.candles(symbol, cfg.timeframes[0], serverTime);
      console.log(`${symbol}: ${bars.length} nến đóng; nến mới nhất ${new Date(bars.at(-1).endTime).toISOString()}`);
    }
    console.log('Kiểm tra REST thành công. Chạy npm start để xác minh WebSocket và bảng theo dõi.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
} else {
  const store = new Store(cfg), gate = new ValidationGate(cfg), calibrationJob = new CalibrationJob(cfg), shutdown = new AbortController();
  let engine, offset = 0, stopped = false, status = { phase: demo ? 'DEMO' : 'SELECTING', error: null, reconnects: 0, connectedAt: null };
  let demoNow = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 12 * 3_600_000;
  const now = () => demo ? demoNow + 1000 : Date.now() + offset;
  const signal = value => {
    if (!demo && !store.reserveCandidate(value)) return;
    value.validation = demo ? { eligible: false, status: 'DEMO', reason: REASONS.DEMO, winRate: null } : gate.assess(value, now());
    if (!demo && !value.validation.eligible) { store.recordCandidate(value); return; }
    if (store.accept(value)) console.log(`${demo ? '[MÔ PHỎNG] ' : ''}${value.layer} ${value.side} ${value.symbol} ${value.timeframe} @ ${value.referencePrice} (${value.branch})`);
  };
  const server = dashboard(cfg, () => ({
    version: packageJson.version, sourceMode: cfg.sourceMode, sources: sources.snapshot(),
    demo, exchange: cfg.exchange, symbols: cfg.symbols, timeframes: cfg.timeframes, htf: cfg.htf,
    pinbarEnabled: cfg.pinbarEnabled, serverNow: now(), streamStaleMs: cfg.streamStaleMs,
    status, rows: [...(engine?.rows.values() || [])], signals: store.state.recent,
    candidates: store.state.watchlist,
    validation: demo ? { ...gate.summary(now()), status: 'DEMO', reason: REASONS.DEMO } : gate.summary(now()),
    calibrationJob: { ...calibrationJob.status, phase: demo ? 'DEMO' : calibrationJob.status.phase },
    telegram: { configured: !!cfg.telegramToken, pending: store.state.pending.length, ...store.state.delivery },
  }));
  server.on('error', e => { console.error(`Dashboard: ${e.code || 'listen failed'}`); stop(); process.exitCode = 1; });
  server.listen(cfg.port, cfg.host, () => {
    const url = process.env.CODESPACE_NAME
      ? `https://${process.env.CODESPACE_NAME}-${cfg.port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`
      : `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
    console.log(`Dashboard: ${url}${demo ? ' · DỮ LIỆU MÔ PHỎNG, TELEGRAM TẮT' : ''}`);
  });
  const deliveryTimer = setInterval(() => store.flush(now(), undefined,
    s => !demo && s.validation?.eligible === true && gate.assess(s, now()).eligible
  ).catch(() => console.error('Không lưu được trạng thái gửi tin; kiểm tra ổ đĩa.')), 1000);
  const calibrationTimer = setInterval(() => calibrationJob.tick(gate, { streaming: status.phase === 'STREAMING', demo, now: now() }), 60_000);
  function stop() {
    if (stopped) return;
    stopped = true; shutdown.abort(); calibrationJob.stop(); clearInterval(deliveryTimer); clearInterval(calibrationTimer); server.close(); store.save();
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (!cfg.telegramToken && !demo) console.log('Telegram chưa cấu hình: tín hiệu vẫn được lưu và hiển thị cục bộ.');
  if (!demo) console.log(`Bộ lọc lịch sử: cận dưới Wilson 95% ≥${cfg.validation.target * 100}%, tối thiểu ${cfg.validation.minSamples} lệnh/nhóm. Chưa đủ dữ liệu chỉ hiển thị quan sát.`);
  if (demo) {
    engine = new SignalEngine(cfg, { onSignal: signal, now });
    demoNow = runDemo(engine, cfg);
    console.log('Dữ liệu tổng hợp để kiểm tra phần mềm; không phản ánh cơ hội giao dịch thực tế.');
  } else {
    let failures = 0;
    while (!stopped) {
      let waitMs = 2000;
      try {
        status = { ...status, phase: 'SELECTING', error: null, retryAt: null, message: 'Đang kiểm tra nguồn dữ liệu khả dụng.' };
        const selected = await sources.choose(exchange => {
          status = { ...status, checkingExchange: exchange, message: `Đang kiểm tra ${exchange.toUpperCase()}...` };
        });
        if (stopped) break;
        offset = selected.offset;
        if (selected.changed) { calibrationJob.cancel(); gate.lastRead = -Infinity; }
        engine = new SignalEngine(cfg, { onSignal: signal, now });
        status = { ...status, phase: 'SYNCING', exchange: cfg.exchange, checkingExchange: null, loaded: 0, total: cfg.symbols.length * (cfg.timeframes.length + 1) };
        await runLiveSession({ cfg, market: selected.market, engine, serverTime: selected.serverTime, now, signal: shutdown.signal,
          onStatus: patch => { status = { ...status, ...patch }; },
          onReady: () => { failures = 0; calibrationJob.tick(gate, { streaming: true, now: now() });
            console.log(`Đang nhận ${cfg.exchange}: ${status.transport} · ${cfg.symbols.join(', ')} · ${cfg.timeframes.join('/')} · HTF ${cfg.htf}`); },
        });
      } catch (e) {
        if (!stopped) {
          sources.failed(e); failures++;
          waitMs = e.noSources ? Math.max(1000, e.retryAt - Date.now()) : Math.min(60000, 2000 * 2 ** Math.min(failures - 1, 5));
          status = { ...status, phase: e.noSources ? 'PAUSED' : 'RETRYING', error: e.message || 'Kết nối thất bại',
            retryAt: Date.now() + waitMs, message: null, reconnects: status.reconnects + 1 };
          console.error(status.error);
        }
      }
      if (!stopped) await delay(waitMs, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  }
}
