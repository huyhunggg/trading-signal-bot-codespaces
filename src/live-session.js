import { setTimeout as delay } from 'node:timers/promises';
import { INTERVALS } from './config.js';

export async function pollLatest(market, engine, cfg, now) {
  for (const symbol of cfg.symbols) for (const timeframe of [...new Set([cfg.htf, ...cfg.timeframes])]) {
    const candles = await market.latest(symbol, timeframe, now());
    for (const candle of candles) engine.ingest({ symbol, timeframe, candle, eventTime: now() });
  }
}

// REST bootstrap proceeds even when WebSocket is unavailable. A read-only REST
// snapshot remains a usable, explicitly slower transport, not synthetic prices.
export async function runLiveSession({ cfg, market, engine, serverTime, now, signal, onStatus, onReady, checkConnection }) {
  let socket, ready = false, wsOpen = false, wsBroken = false, pendingError = null, transport = 'PENDING';
  const buffered = [], seen = new Map(), allTfs = [...new Set([cfg.htf, ...cfg.timeframes])];
  const ingest = events => {
    try {
      for (const event of events) {
        if (!ready) { if (buffered.length < 10000) buffered.push(event); continue; }
        if (transport === 'WEBSOCKET' && engine.ingest(event)) seen.set(`${event.symbol}:${event.timeframe}`, Date.now());
      }
    } catch (e) { pendingError = e; }
  };
  try {
    try {
      socket = market.stream(ingest);
      socket.on('open', () => { wsOpen = true; });
      socket.on('error', () => { wsBroken = true; }); socket.on('close', () => { wsBroken = true; });
    } catch { wsBroken = true; }
    let loaded = 0;
    const total = cfg.symbols.length * allTfs.length;
    for (const symbol of cfg.symbols) for (const timeframe of allTfs) {
      if (signal.aborted) return;
      const candles = await market.candles(symbol, timeframe, serverTime);
      engine.seed(symbol, timeframe, candles); engine.refreshRows(); loaded++;
      onStatus({ phase: 'SYNCING', loaded, total, transport: 'BOOTSTRAP', message: `Đang tải ${symbol} ${timeframe} (${loaded}/${total}).` });
    }
    if (signal.aborted) return;
    // Reconcile any final candles closed while history was loading, HTF first.
    await pollLatest(market, engine, cfg, now);
    transport = wsOpen && !wsBroken ? 'WEBSOCKET' : 'REST_POLL';
    if (transport === 'WEBSOCKET') {
      buffered.sort((a, b) => a.eventTime - b.eventTime || (INTERVALS[b.timeframe] - INTERVALS[a.timeframe]));
      for (const event of buffered) if (engine.ingest(event)) seen.set(`${event.symbol}:${event.timeframe}`, Date.now());
    } else socket?.terminate();
    buffered.length = 0; ready = true;
    const connectedAt = Date.now();
    const publish = () => onStatus({ phase: 'STREAMING', connectedAt, transport, error: null,
      pollIntervalMs: cfg.pollIntervalMs,
      message: transport === 'REST_POLL' ? `WebSocket chưa khả dụng. Đang lấy giá thật qua REST, chu kỳ mục tiêu ${cfg.pollIntervalMs / 1000} giây.` : null });
    publish(); onReady();
    while (!signal.aborted && Date.now() - connectedAt < 12 * 3600000) {
      checkConnection?.();
      if (pendingError) throw pendingError;
      if (transport === 'WEBSOCKET' && (wsBroken || cfg.symbols.some(s => allTfs.some(tf => Date.now() - (seen.get(`${s}:${tf}`) || connectedAt) > cfg.streamStaleMs)))) {
        transport = 'REST_POLL'; socket?.terminate(); publish();
      }
      const start = Date.now();
      if (transport === 'REST_POLL') await pollLatest(market, engine, cfg, now);
      await delay(transport === 'REST_POLL' ? Math.max(100, cfg.pollIntervalMs - (Date.now() - start)) : 1000, undefined, { signal }).catch(() => {});
    }
  } finally { ready = false; socket?.terminate(); }
}

