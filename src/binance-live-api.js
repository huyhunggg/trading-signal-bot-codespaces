import { createHmac } from 'node:crypto';

const ROOT = 'https://fapi.binance.com';
const READS = new Set(['/fapi/v3/account', '/fapi/v3/positionRisk', '/fapi/v1/accountConfig', '/fapi/v1/symbolConfig', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders', '/fapi/v1/order', '/fapi/v1/algoOrder']);
const WRITES = new Set(['POST /fapi/v1/order', 'DELETE /fapi/v1/order', 'POST /fapi/v1/algoOrder', 'DELETE /fapi/v1/algoOrder', 'POST /fapi/v1/marginType', 'POST /fapi/v1/leverage']);
export class BinanceLiveApi {
  constructor({ key, secret, enabled }, { fetcher = fetch, now = Date.now } = {}) {
    this.key = key; this.secret = secret; this.enabled = enabled === true; this.fetcher = fetcher; this.now = now; this.offset = 0; this.retryAt = 0;
  }
  async request(method, endpoint, params = {}) {
    if (method === 'GET' ? !READS.has(endpoint) : !WRITES.has(method + ' ' + endpoint)) throw new Error('API_ENDPOINT_NOT_ALLOWED');
    if (method !== 'GET' && !this.enabled) throw new Error('LIVE_TRADING_DISABLED');
    if (!this.key || !this.secret) throw new Error('MISSING_BINANCE_KEYS');
    if (this.now() < this.retryAt) throw new Error('BINANCE_COOLDOWN');
    const query = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Math.round(this.now() + this.offset)) }).toString();
    const signature = createHmac('sha256', this.secret).update(query).digest('hex');
    const signed = query + '&signature=' + signature;
    let response, body;
    try {
      response = await this.fetcher(ROOT + endpoint + (method === 'POST' ? '' : '?' + signed), {
        method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'X-MBX-APIKEY': this.key, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: signed } : {}),
      });
      const text = await response.text();
      body = JSON.parse(text.replace(/("(?:orderId|algoId|actualOrderId)"\s*:\s*)(\d{16,})/g, '$1"$2"'));
    } catch { const e = new Error('BINANCE_REQUEST_UNKNOWN'); e.uncertain = true; throw e; }
    if (!response.ok || (typeof body?.code === 'number' && body.code < 0)) {
      const code = Number.isInteger(body?.code) && body.code < 0 ? body.code : response.status;
      const e = new Error(`BINANCE_${code}`); e.code = code; e.httpStatus = response.status;
      e.uncertain = response.status >= 500 || [-1006, -1007].includes(code);
      if ([403, 418, 429, 451].includes(response.status)) {
        const value = response.headers.get('retry-after');
        const wait = /^\d+$/.test(value || '') ? Number(value) * 1000 : Date.parse(value || '') - this.now();
        this.retryAt = this.now() + Math.max(Number.isFinite(wait) ? wait : 0, response.status === 429 ? 60000 : 3600000);
      }
      throw e;
    }
    return body;
  }
  get(endpoint, params) { return this.request('GET', endpoint, params); }
  post(endpoint, params) { return this.request('POST', endpoint, params); }
  delete(endpoint, params) { return this.request('DELETE', endpoint, params); }
}
