import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { loadConfig } from './config.js';
import { SignalEngine } from './engine.js';
import { Market } from './market.js';
import { Store } from './store.js';
import { dashboard } from './dashboard.js';
import { runDemo } from './demo.js';
import { ValidationGate, REASONS } from './validation.js';
import { CalibrationJob } from './calibration-job.js';

const cfg = loadConfig(), demo = process.argv.includes('--demo'), check = process.argv.includes('--check');
if (demo) { cfg.telegramToken = ''; cfg.telegramChatId = ''; cfg.dataDir = './demo-data'; }
const market = new Market(cfg);

if (check) {
  try {
    const serverTime = await market.serverTime();
    console.log(`REST ${cfg.exchange}: OK; server ${new Date(serverTime).toISOString()}`);
    for (const symbol of cfg.symbols) {
      const bars = await market.candles(symbol, cfg.timeframes[0], serverTime);
      console.log(`${symbol}: ${bars.length} nến đóng; nến mới nhất ${new Date(bars.at(-1).endTime).toISOString()}`);
    }
    console.log('Kiểm tra REST thành công. Chạy npm start để xác minh WebSocket và bảng theo dõi.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
} else {
  const store = new Store(cfg), gate = new ValidationGate(cfg), calibrationJob = new CalibrationJob(cfg), shutdown = new AbortController();
  let engine, socket, offset = 0, stopped = false, status = { phase: demo ? 'DEMO' : 'CONNECTING', error: null, reconnects: 0, connectedAt: null };
  let demoNow = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 12 * 3_600_000;
  const now = () => demo ? demoNow + 1000 : Date.now() + offset;
  const signal = value => {
    if (!demo && !store.reserveCandidate(value)) return;
    value.validation = demo ? { eligible: false, status: 'DEMO', reason: REASONS.DEMO, winRate: null } : gate.assess(value, now());
    if (!demo && !value.validation.eligible) { store.recordCandidate(value); return; }
    if (store.accept(value)) console.log(`${demo ? '[MÔ PHỎNG] ' : ''}${value.layer} ${value.side} ${value.symbol} ${value.timeframe} @ ${value.referencePrice} (${value.branch})`);
  };
  const server = dashboard(cfg, () => ({
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
    stopped = true; shutdown.abort(); socket?.terminate(); calibrationJob.stop(); clearInterval(deliveryTimer); clearInterval(calibrationTimer); server.close(); store.save();
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
      let watchdog, retryAfterMs = 0;
      try {
        status = { ...status, phase: 'CONNECTING', error: null };
        const before = Date.now(), serverTime = await market.serverTime();
        offset = serverTime - (before + Date.now()) / 2;
        if (Math.abs(offset) > 10_000) throw new Error('Đồng hồ máy lệch hơn 10 giây so với sàn. Hãy đồng bộ giờ hệ thống.');
        if (stopped) break;
        let rejectSession;
        const sessionFailure = new Promise((_, reject) => { rejectSession = reject; });
        // Register a handler immediately, including errors during bootstrap.
        sessionFailure.catch(() => {});
        let ready = false, buffered = [];
        const streamTimes = new Map();
        engine = new SignalEngine(cfg, { onSignal: signal, now });
        socket = market.stream(events => {
          try {
            for (const event of events) {
              if (now() - event.eventTime <= cfg.streamStaleMs) streamTimes.set(`${event.symbol}:${event.timeframe}`, Date.now());
              if (ready) engine.ingest(event); else { buffered.push(event); if (buffered.length > 10_000) throw new Error('Bootstrap buffer overflow'); }
            }
          } catch (e) { rejectSession(e); }
        }, () => {});
        socket.on('error', () => rejectSession(new Error('WebSocket không kết nối được hoặc dữ liệu bị lỗi.')));
        socket.on('close', () => rejectSession(new Error('WebSocket đã ngắt; đang đồng bộ lại.')));
        await Promise.race([once(socket, 'open'), sessionFailure]);
        status.phase = 'SYNCING';
        const allTfs = [...new Set([...cfg.timeframes, cfg.htf])];
        await Promise.race([Promise.all(cfg.symbols.flatMap(symbol => allTfs.map(async tf => {
          const candles = await market.candles(symbol, tf, serverTime);
          engine.seed(symbol, tf, candles);
        }))), sessionFailure]);
        engine.refreshRows();
        // Historical bootstrap is deliberately never replayed as a fresh alert.
        buffered.sort((a, b) => a.eventTime - b.eventTime || Number(b.timeframe === cfg.htf) - Number(a.timeframe === cfg.htf));
        for (const event of buffered) engine.ingest(event);
        buffered = []; ready = true; failures = 0;
        const connectedAt = Date.now();
        status = { ...status, phase: 'STREAMING', error: null, connectedAt };
        calibrationJob.tick(gate, { streaming: true, now: now() });
        console.log(`Đang nhận ${cfg.exchange}: ${cfg.symbols.join(', ')} · ${cfg.timeframes.join('/')} · HTF ${cfg.htf}`);
        watchdog = setInterval(() => {
          for (const symbol of cfg.symbols) for (const tf of allTfs) {
            if (Date.now() - (streamTimes.get(`${symbol}:${tf}`) || connectedAt) > cfg.streamStaleMs) rejectSession(new Error(`${symbol} ${tf}: luồng dữ liệu quá hạn; đồng bộ lại.`));
          }
          if (Date.now() - connectedAt > 12 * 3_600_000) rejectSession(new Error('Đồng bộ định kỳ sau 12 giờ.'));
        }, 5000);
        await sessionFailure;
      } catch (e) {
        if (!stopped) {
          failures++; status = { ...status, phase: 'RETRYING', error: e.message || 'Kết nối thất bại', reconnects: status.reconnects + 1 };
          console.error(status.error);
          if ([403, 451].includes(e.httpStatus)) { status.phase = 'BLOCKED'; break; }
          retryAfterMs = Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : 0;
        }
      } finally { clearInterval(watchdog); socket?.terminate(); }
      if (!stopped) await delay(Math.max(retryAfterMs, Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5))), undefined, { signal: shutdown.signal }).catch(() => {});
    }
  }
}
