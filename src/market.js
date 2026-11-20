import WebSocket from 'ws';
import { ProxyAgent } from 'proxy-agent';
import { INTERVALS } from './config.js';
import { RestQueue, retryAfterMs } from './provider-health.js';

const ROOT = { binance: 'https://fapi.binance.com', bybit: 'https://api.bybit.com', okx: 'https://www.okx.com' };
const BYBIT_TF = { '5m': '5', '15m': '15', '1h': '60', '4h': '240' };
const OKX_TF = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H' };
export const okxInstrument = symbol => symbol.replace(/USDT$/, '-USDT-SWAP');

export async function getJson(url, fetcher = fetch, now) {
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(15_000) }); }
  catch { const e = new Error('Không kết nối được dịch vụ dữ liệu.'); e.network = true; throw e; }
  if (!response.ok) {
    let body = ''; try { body = (await response.text()).slice(0, 4096); } catch {}
    now ??= Date.now();
    const reason = [403, 451].includes(response.status) ? ' Dịch vụ giới hạn quyền truy cập hoặc khu vực.' : response.status === 418 ? ' Sàn tạm khóa IP; dừng gọi API đến khi hết thời hạn.' : response.status === 429 ? ' Quá giới hạn yêu cầu; đang chờ trước khi thử lại.' : '';
    const error = new Error(`Market API HTTP ${response.status}.${reason}`);
    error.httpStatus = response.status;
    error.retryAfterMs = retryAfterMs(response, body, now);
    error.retryAt = now + error.retryAfterMs;
    throw error;
  }
  let json; try { json = await response.json(); } catch { const e = new Error('Nguồn giá trả dữ liệu không hợp lệ.'); e.httpStatus = 502; throw e; }
  if (Number(json.code) === -1003) {
    now ??= Date.now();
    const e = new Error('Binance yêu cầu dừng gọi API do giới hạn tần suất/IP.');
    const body = JSON.stringify(json);
    e.httpStatus = /\bban(?:ned)?\b/i.test(body) ? 418 : 429;
    e.retryAfterMs = Math.max(retryAfterMs(response, body, now), e.httpStatus === 418 ? 3600000 : 60000);
    e.retryAt = now + e.retryAfterMs; throw e;
  }
  if (json.retCode !== undefined && json.retCode !== 0) throw new Error(`Bybit API code ${json.retCode}`);
  if (json.code !== undefined && String(json.code) !== '0') {
    const e = new Error(`OKX API code ${json.code}`);
    if (['50011', '50040'].includes(String(json.code))) { e.httpStatus = 429; e.retryAfterMs = 60000; }
    throw e;
  }
  return json;
}

export function validateCandle(c, timeframe) {
  const ms = INTERVALS[timeframe];
  if (!ms || !Number.isInteger(c.openTime) || c.openTime % ms !== 0 || c.endTime !== c.openTime + ms ||
    ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) || c.low <= 0 || c.volume < 0 ||
    c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.high < c.low) throw new Error('Invalid OHLCV candle');
  return c;
}

export function parseRows(exchange, rows, timeframe, serverTime) {
  const ms = INTERVALS[timeframe];
  return rows.map(row => {
    const [t, o, h, l, c] = row.map(Number), volume = Number(row[exchange === 'okx' ? 6 : 5]);
    return validateCandle({ openTime: t, endTime: t + ms, open: o, high: h, low: l, close: c, volume,
      closed: t + ms <= serverTime && (exchange !== 'okx' || String(row[8]) === '1') }, timeframe);
  }).sort((a, b) => a.openTime - b.openTime);
}
export const parseRest = (exchange, rows, timeframe, serverTime) => parseRows(exchange, rows, timeframe, serverTime).filter(c => c.closed);

export function parseStream(exchange, raw, receivedAt = Date.now()) {
  if (raw.toString() === 'pong') return [];
  const msg = JSON.parse(raw.toString());
  if (exchange === 'binance') {
    const data = msg.data || msg, k = data.k;
    if (!k) return [];
    const candle = validateCandle({ openTime: Number(k.t), endTime: Number(k.t) + INTERVALS[k.i], open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: k.x === true }, k.i);
    return [{ symbol: k.s, timeframe: k.i, candle, eventTime: Number(data.E) }];
  }
  if (exchange === 'okx') {
    if (msg.event === 'error') throw new Error(`OKX WebSocket code ${msg.code}`);
    if (!msg.arg?.channel?.startsWith('candle') || !Array.isArray(msg.data)) return [];
    const timeframe = Object.keys(OKX_TF).find(k => 'candle' + OKX_TF[k] === msg.arg.channel);
    const symbol = msg.arg.instId?.replace(/-USDT-SWAP$/, 'USDT');
    if (!timeframe || !/^[A-Z0-9]+USDT$/.test(symbol)) return [];
    return parseRows('okx', msg.data, timeframe, Infinity).map(candle => ({ symbol, timeframe, candle, eventTime: receivedAt }));
  }
  if (!msg.topic?.startsWith('kline.') || !Array.isArray(msg.data)) return [];
  const [, interval, symbol] = msg.topic.split('.'), timeframe = Object.keys(BYBIT_TF).find(key => BYBIT_TF[key] === interval);
  if (!timeframe) return [];
  return msg.data.map(k => ({ symbol, timeframe, eventTime: Number(msg.ts), candle: validateCandle({ openTime: +k.start, endTime: +k.start + INTERVALS[timeframe], open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume, closed: k.confirm === true }, timeframe) }));
}

export class Market {
  constructor(cfg, request = getJson) { this.cfg = { ...cfg }; this.client = new RestQueue(this.cfg, request); this.request = url => this.client.get(url); }
  async quote(symbol, now) {
    const { exchange } = this.cfg;
    if (!this.cfg.symbols.includes(symbol) || !['binance', 'okx'].includes(exchange)) throw new Error('Unsupported paper quote');
    const endpoint = exchange === 'binance'
      ? `${ROOT.binance}/fapi/v1/ticker/bookTicker?${new URLSearchParams({ symbol })}`
      : `${ROOT.okx}/api/v5/market/ticker?${new URLSearchParams({ instId: okxInstrument(symbol) })}`;
    const json = await this.request(endpoint), row = exchange === 'binance' ? json : json.data?.[0];
    now ??= Date.now();
    const bid = Number(exchange === 'binance' ? row?.bidPrice : row?.bidPx);
    const ask = Number(exchange === 'binance' ? row?.askPrice : row?.askPx);
    const at = Number(exchange === 'binance' ? row?.time : row?.ts);
    const expected = exchange === 'binance' ? row?.symbol === symbol : row?.instId === okxInstrument(symbol);
    if (!expected || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid ||
        !Number.isFinite(at) || now - at > 15000 || at > now + 1000) throw new Error('Quote is missing, stale or invalid');
    return { symbol, exchange, bid, ask, price: (bid + ask) / 2, at };
  }
  async serverTime() {
    const { exchange } = this.cfg;
    const json = await this.request(ROOT[exchange] + (exchange === 'binance' ? '/fapi/v1/time' : exchange === 'bybit' ? '/v5/market/time' : '/api/v5/public/time'));
    return exchange === 'binance' ? json.serverTime : exchange === 'bybit' ? Number(json.result.timeSecond) * 1000 : Number(json.data[0].ts);
  }
  async candles(symbol, timeframe, serverTime) {
    const { exchange, historyBars } = this.cfg;
    if (exchange === 'okx') {
      const end = Math.floor(serverTime / INTERVALS[timeframe]) * INTERVALS[timeframe];
      return this.candleRange(symbol, timeframe, end - historyBars * INTERVALS[timeframe], end);
    }
    const query = new URLSearchParams(exchange === 'binance' ? { symbol, interval: timeframe, limit: String(historyBars) } : { category: 'linear', symbol, interval: BYBIT_TF[timeframe], limit: String(historyBars) });
    const json = await this.request(`${ROOT[exchange]}${exchange === 'binance' ? '/fapi/v1/klines' : '/v5/market/kline'}?${query}`);
    return parseRest(exchange, exchange === 'binance' ? json : json.result.list, timeframe, serverTime);
  }
  async latest(symbol, timeframe, serverTime = Date.now()) {
    const { exchange } = this.cfg;
    const params = exchange === 'binance' ? { symbol, interval: timeframe, limit: '2' }
      : exchange === 'bybit' ? { category: 'linear', symbol, interval: BYBIT_TF[timeframe], limit: '2' }
        : { instId: okxInstrument(symbol), bar: OKX_TF[timeframe], limit: '2' };
    const endpoint = exchange === 'binance' ? '/fapi/v1/klines' : exchange === 'bybit' ? '/v5/market/kline' : '/api/v5/market/candles';
    const json = await this.request(`${ROOT[exchange]}${endpoint}?${new URLSearchParams(params)}`);
    return parseRows(exchange, exchange === 'binance' ? json : exchange === 'bybit' ? json.result.list : json.data, timeframe, serverTime);
  }
  async candleRange(symbol, timeframe, startTime, endTime) {
    const ms = INTERVALS[timeframe], { exchange } = this.cfg;
    if (!ms || !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) throw new Error('Khoảng lịch sử không hợp lệ.');
    if (exchange === 'okx') {
      const start = Math.floor(startTime / ms) * ms, end = Math.floor(endTime / ms) * ms, found = new Map(); let cursor = end;
      while (cursor > start) {
        const params = { instId: okxInstrument(symbol), bar: OKX_TF[timeframe], after: String(cursor), before: String(start - 1), limit: '300' };
        const json = await this.request(`${ROOT.okx}/api/v5/market/history-candles?${new URLSearchParams(params)}`);
        const page = parseRest('okx', json.data, timeframe, end).filter(c => c.openTime >= start && c.openTime < cursor);
        if (!page.length) throw new Error(`${symbol} ${timeframe}: lịch sử OKX bị thiếu.`);
        for (const c of page) found.set(c.openTime, c);
        cursor = page[0].openTime;
      }
      const result = [...found.values()].sort((a, b) => a.openTime - b.openTime);
      if (result[0]?.openTime !== start || result.at(-1)?.endTime !== end || result.some((c, i) => i && c.openTime !== result[i - 1].endTime)) throw new Error(`${symbol} ${timeframe}: lịch sử OKX không liên tục.`);
      return result;
    }
    const out = []; let cursor = Math.floor(startTime / ms) * ms;
    while (cursor + ms <= endTime) {
      const blockEnd = Math.min(endTime, cursor + 1000 * ms);
      const params = exchange === 'binance'
        ? { symbol, interval: timeframe, startTime: String(cursor), endTime: String(blockEnd - 1), limit: '1000' }
        : { category: 'linear', symbol, interval: BYBIT_TF[timeframe], start: String(cursor), end: String(blockEnd - 1), limit: '1000' };
      const json = await this.request(`${ROOT[exchange]}${exchange === 'binance' ? '/fapi/v1/klines' : '/v5/market/kline'}?${new URLSearchParams(params)}`);
      const rows = exchange === 'binance' ? json : json.result.list;
      const page = parseRest(exchange, rows, timeframe, endTime).filter(c => c.openTime >= cursor && c.endTime <= blockEnd);
      if (!page.length || page[0].openTime !== cursor || page.some((c, i) => i && c.openTime !== page[i - 1].endTime)) throw new Error(`${symbol} ${timeframe}: lịch sử bị thiếu; không tạo báo cáo tỷ lệ thắng.`);
      out.push(...page); cursor = page.at(-1).endTime;
    }
    return out;
  }
  stream(onEvents, onMessage = () => {}) {
    const { exchange, symbols, timeframes, htf } = this.cfg;
    const allTfs = [...new Set([...timeframes, htf])];
    const streams = symbols.flatMap(symbol => allTfs.map(tf => `${symbol.toLowerCase()}@kline_${tf}`));
    const url = exchange === 'binance' ? `wss://fstream.binance.com/market/stream?streams=${streams.join('/')}` : exchange === 'bybit' ? 'wss://stream.bybit.com/v5/public/linear' : 'wss://ws.okx.com:8443/ws/v5/business';
    const ws = new WebSocket(url, { agent: new ProxyAgent(), handshakeTimeout: 15_000 });
    ws.on('open', () => {
      if (exchange === 'bybit') {
        const args = symbols.flatMap(symbol => allTfs.map(tf => `kline.${BYBIT_TF[tf]}.${symbol}`));
        for (let i = 0; i < args.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 10) }));
      }
      if (exchange === 'okx') ws.send(JSON.stringify({ op: 'subscribe', args: symbols.flatMap(symbol => allTfs.map(tf => ({ channel: 'candle' + OKX_TF[tf], instId: okxInstrument(symbol) }))) }));
    });
    ws.on('message', raw => {
      onMessage();
      if (raw.toString() === 'pong') return;
      try {
        const json = JSON.parse(raw.toString());
        if (json.success === false) throw new Error('Subscription rejected');
        onEvents(parseStream(exchange, raw));
      } catch { ws.emit('error', new Error('Không đọc được dữ liệu WebSocket hoặc đăng ký bị từ chối.')); }
    });
    const heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) { if (exchange === 'bybit') ws.send(JSON.stringify({ op: 'ping' })); if (exchange === 'okx') ws.send('ping'); } }, 20_000);
    ws.on('close', () => clearInterval(heartbeat));
    return ws;
  }
}

