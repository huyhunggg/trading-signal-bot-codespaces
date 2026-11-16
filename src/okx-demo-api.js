import { createHmac } from 'node:crypto';

// Deliberately no live switch, custom host, retries or withdrawal methods.
const ORIGIN = 'https://openapi.okx.com';
export class OkxDemoApi {
  constructor(credentials, { fetcher = fetch, now = Date.now } = {}) {
    this.credentials = credentials; this.fetcher = fetcher; this.now = now;
  }
  async request(method, pathname, payload) {
    if (!['GET', 'POST'].includes(method) || !pathname.startsWith('/api/v5/')) throw new Error('Invalid demo API request');
    const { key, secret, passphrase } = this.credentials;
    if (![key, secret, passphrase].every(x => typeof x === 'string' && x.trim())) throw new Error('NEED_DEMO_KEYS');
    const timestamp = new Date(this.now()).toISOString();
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const sign = createHmac('sha256', secret).update(timestamp + method + pathname + body).digest('base64');
    let response, result;
    try {
      response = await this.fetcher(ORIGIN + pathname, {
        method, redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'content-type': 'application/json', 'x-simulated-trading': '1',
          'OK-ACCESS-KEY': key, 'OK-ACCESS-SIGN': sign,
          'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': passphrase },
        ...(body ? { body } : {}),
      });
      result = await response.json();
    } catch { throw new Error('DEMO_NETWORK_UNKNOWN'); }
    // Never expose response messages or raw network exceptions: may contain secrets.
    const failed = result?.data?.find?.(row => row.sCode !== undefined && String(row.sCode) !== '0');
    if (!response.ok || String(result?.code) !== '0' || failed || !Array.isArray(result.data)) {
      const code = String(failed?.sCode ?? result?.code ?? response.status);
      throw new Error(`DEMO_API_${/^\d+$/.test(code) ? code : 'INVALID'}`);
    }
    return result.data;
  }
  get(pathname, params = {}) { return this.request('GET', pathname + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '')); }
  post(pathname, payload) { return this.request('POST', pathname, payload); }
}
