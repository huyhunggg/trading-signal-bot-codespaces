import WebSocket from 'ws';
import { ProxyAgent } from 'proxy-agent';
import { INTERVALS } from './config.js';

const ROOT = { binance: 'https://fapi.binance.com', bybit: 'https://api.bybit.com' };
const BYBIT_TF = { '5m': '5', '15m': '15', '1h': '60', '4h': '240' };

export async function getJson(url) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('Không kết nối được dịch vụ dữ liệu; kiểm tra mạng/proxy.'); }
  if (!response.ok) {
    const reason = [403, 451].includes(response.status) ? ' Dịch vụ có thể giới hạn khu vực hoặc quyền truy cập.' : response.status === 429 ? ' Quá giới hạn yêu cầu; cần đợi trước khi thử lại.' : '';
    const error = new Error(`Market API HTTP ${response.status}.${reason}`);
    error.httpStatus = response.status;
    const retry = response.headers.get('retry-after');
    error.retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
    throw error;
  }
  const json = await response.json();
  if (json.retCode !== undefined && json.retCode !== 0) throw new Error(`Bybit API code ${json.retCode}`);
  return json;
}

export function validateCandle(c, timeframe) {
  const ms = INTERVALS[timeframe];
  if (!ms || !Number.isInteger(c.openTime) || c.openTime % ms !== 0 || c.endTime !== c.openTime + ms ||
    ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) || c.low <= 0 || c.volume < 0 ||
    c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low) throw new Error('Invalid OHLCV candle');
  return c;
}

export function parseRest(exchange, rows, timeframe, serverTime) {
  const ms = INTERVALS[timeframe];
  return rows.map(row => {
    const [t, o, h, l, c, v] = row.map(Number);
    return validateCandle({ openTime: t, endTime: t + ms, open: o, high: h, low: l, close: c, volume: v, closed: t + ms <= serverTime }, timeframe);
  }).sort((a, b) => a.openTime - b.openTime).filter(c => c.closed);
}

export function parseStream(exchange, raw) {
  const msg = JSON.parse(raw.toString());
  if (exchange === 'binance') {
    const data = msg.data || msg, k = data.k;
    if (!k) return [];
    const candle = validateCandle({ openTime: Number(k.t), endTime: Number(k.t) + INTERVALS[k.i], open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: k.x === true }, k.i);
    return [{ symbol: k.s, timeframe: k.i, candle, eventTime: Number(data.E) }];
  }
  if (!msg.topic?.startsWith('kline.') || !Array.isArray(msg.data)) return [];
  const [, interval, symbol] = msg.topic.split('.'), timeframe = Object.keys(BYBIT_TF).find(key => BYBIT_TF[key] === interval);
  if (!timeframe) return [];
  return msg.data.map(k => ({ symbol, timeframe, eventTime: Number(msg.ts), candle: validateCandle({ openTime: +k.start, endTime: +k.start + INTERVALS[timeframe], open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume, closed: k.confirm === true }, timeframe) }));
}

export class Market {
  constructor(cfg) { this.cfg = cfg; }
  async serverTime() {
    const { exchange } = this.cfg;
    const json = await getJson(ROOT[exchange] + (exchange === 'binance' ? '/fapi/v1/time' : '/v5/market/time'));
    return exchange === 'binance' ? json.serverTime : Number(json.result.timeSecond) * 1000;
  }
  async candles(symbol, timeframe, serverTime) {
    const { exchange, historyBars } = this.cfg;
    const query = new URLSearchParams(exchange === 'binance' ? { symbol, interval: timeframe, limit: String(historyBars) } : { category: 'linear', symbol, interval: BYBIT_TF[timeframe], limit: String(historyBars) });
    const json = await getJson(`${ROOT[exchange]}${exchange === 'binance' ? '/fapi/v1/klines' : '/v5/market/kline'}?${query}`);
    return parseRest(exchange, exchange === 'binance' ? json : json.result.list, timeframe, serverTime);
  }
  stream(onEvents, onMessage) {
    const { exchange, symbols, timeframes, htf } = this.cfg;
    const allTfs = [...new Set([...timeframes, htf])];
    const streams = symbols.flatMap(symbol => allTfs.map(tf => `${symbol.toLowerCase()}@kline_${tf}`));
    const url = exchange === 'binance' ? `wss://fstream.binance.com/market/stream?streams=${streams.join('/')}` : 'wss://stream.bybit.com/v5/public/linear';
    const ws = new WebSocket(url, { agent: new ProxyAgent(), handshakeTimeout: 15_000 });
    ws.on('open', () => {
      if (exchange === 'bybit') {
        const args = symbols.flatMap(symbol => allTfs.map(tf => `kline.${BYBIT_TF[tf]}.${symbol}`));
        for (let i = 0; i < args.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 10) }));
      }
    });
    ws.on('message', raw => {
      onMessage();
      try {
        const json = JSON.parse(raw.toString());
        if (json.success === false) throw new Error('Subscription rejected');
        onEvents(parseStream(exchange, raw));
      } catch { ws.emit('error', new Error('Không đọc được dữ liệu WebSocket hoặc đăng ký bị từ chối.')); }
    });
    const heartbeat = setInterval(() => { if (exchange === 'bybit' && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' })); }, 20_000);
    ws.on('close', () => clearInterval(heartbeat));
    return ws;
  }
}
