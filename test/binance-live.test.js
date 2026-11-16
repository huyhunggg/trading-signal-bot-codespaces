import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { BinanceLiveApi } from '../src/binance-live-api.js';
import { BinanceLiveTrader, liveOptions, liveLimits, planLiveOrder } from '../src/binance-live-trader.js';
import { dashboard } from '../src/dashboard.js';

const time = Date.UTC(2026, 10, 16, 2, 0, 10);
const options = () => liveOptions({ BINANCE_API_KEY: 'FAKE_KEY_TEST_ONLY', BINANCE_API_SECRET: 'FAKE_SECRET_TEST_ONLY', BINANCE_LIVE_ENABLED: 'true' });
const signal = (overrides = {}) => ({ id: 'binance:SOLUSDT:5m:123:CLOSED:LONG', symbol: 'SOLUSDT', exchange: 'binance', side: 'LONG', layer: 'CLOSED', closed: true,
  candleEndTime: time - 10000, observedAt: time, receivedAt: time, referencePrice: 100, sl: 98, tp1: 101, ...overrides });
const quote = { symbol: 'SOLUSDT', exchange: 'binance', bid: 99.99, ask: 100, price: 99.995, at: time };
const spec = { symbol: 'SOLUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT', filters: [
  { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
  { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '10000', stepSize: '0.001' },
  { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'MIN_NOTIONAL', notional: '5' },
] };

test('live API signs exact form/query, sends only key header, forbids withdrawals and blocks all mutations while disabled', async () => {
  const calls = [], o = options();
  const api = new BinanceLiveApi(o, { now: () => time, fetcher: async (url, args) => { calls.push({ url, args }); return new Response('{"orderId":1234567890123456789}', { status: 200 }); } });
  const answer = await api.post('/fapi/v1/order', { symbol: 'SOLUSDT', side: 'BUY', type: 'MARKET', quantity: '0.1' });
  assert.equal(answer.orderId, '1234567890123456789');
  await api.get('/fapi/v3/account');
  for (const { url, args } of calls) {
    assert.equal(new URL(url).origin, 'https://fapi.binance.com'); assert.equal(args.redirect, 'error');
    const encoded = args.body || new URL(url).search.slice(1), unsigned = encoded.split('&signature=')[0];
    assert.equal(new URLSearchParams(encoded).get('signature'), createHmac('sha256', o.secret).update(unsigned).digest('hex'));
    assert.equal(args.headers['X-MBX-APIKEY'], o.key); assert.ok(!encoded.includes(o.secret));
  }
  await assert.rejects(api.post('/sapi/v1/capital/withdraw/apply', {}), /NOT_ALLOWED/);
  api.enabled = false;
  for (const [method, endpoint] of [['POST', '/fapi/v1/order'], ['POST', '/fapi/v1/algoOrder'], ['POST', '/fapi/v1/leverage'], ['DELETE', '/fapi/v1/algoOrder']]) await assert.rejects(api.request(method, endpoint, {}), /DISABLED/);
  assert.equal(calls.length, 2);
});
test('private API redacts messages/URLs, does not retry uncertain submissions and honors regional/rate cooldown', async () => {
  let calls = 0;
  const api = new BinanceLiveApi(options(), { now: () => time, fetcher: async () => { calls++; throw new Error('FAKE_SECRET_TEST_ONLY'); } });
  await assert.rejects(api.post('/fapi/v1/order', {}), e => e.uncertain && e.message === 'BINANCE_REQUEST_UNKNOWN'); assert.equal(calls, 1);
  api.fetcher = async () => { calls++; return new Response('{"code":-1003,"msg":"FAKE_SECRET_TEST_ONLY"}', { status: 429, headers: { 'retry-after': '120' } }); };
  await assert.rejects(api.get('/fapi/v3/account'), { message: 'BINANCE_-1003' }); assert.equal(api.retryAt, time + 120000);
  await assert.rejects(api.get('/fapi/v3/account'), /COOLDOWN/); assert.equal(calls, 2);
});
test('live sizing caps exposure and loss by equity, honors exchange filters and never rounds up to force minimum size', () => {
  const p = planLiveOrder(signal(), spec, quote, options(), 1000, time);
  assert.ok(Number(p.entry.quantity) * quote.ask <= 25); assert.ok(Number(p.entry.quantity) * (2 + 100 * .003) <= 1);
  assert.equal(p.entry.positionSide, 'BOTH'); assert.equal(p.sl.closePosition, 'true'); assert.equal(p.sl.type, 'STOP_MARKET'); assert.equal(p.tp.type, 'TAKE_PROFIT_MARKET');
  assert.ok(!('quantity' in p.sl)); assert.ok(!('reduceOnly' in p.sl));
  assert.deepEqual(liveLimits(options(), 100), { notional: 5, risk: .25, daily: 1 });
  assert.throws(() => planLiveOrder(signal(), spec, quote, options(), 20, time), /MINIMUM/);
  const expensive = { ...spec, filters: [...spec.filters.filter(f => f.filterType !== 'MIN_NOTIONAL'), { filterType: 'MIN_NOTIONAL', notional: '100' }] };
  assert.throws(() => planLiveOrder(signal(), expensive, quote, options(), 1000, time), /MINIMUM/);
  for (const q of [{ ...quote, at: time - 5001 }, { ...quote, bid: 99, ask: 100 }, { ...quote, exchange: 'okx' }]) assert.throws(() => planLiveOrder(signal(), spec, q, options(), 1000, time));
  assert.throws(() => planLiveOrder(signal({ closed: false }), spec, quote, options(), 1000, time));
  assert.throws(() => liveOptions({ BINANCE_MAX_NOTIONAL_USDT: '10000' }));
});

function setup(t, changes = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binance-live-'));
  const model = { equity: 1000, positions: [], orders: {}, algos: {}, foreignOrders: [], foreignAlgos: [], failEntry: null, failProtection: false, partial: false, ...changes };
  const calls = [], o = options();
  const api = {
    async get(endpoint, params = {}) {
      calls.push({ method: 'GET', endpoint, params });
      if (endpoint.endsWith('/accountConfig')) return { canTrade: true, dualSidePosition: false, multiAssetsMargin: false };
      if (endpoint.endsWith('/account')) return { assets: [{ asset: 'USDT', walletBalance: String(model.equity), unrealizedProfit: '0', availableBalance: '900' }] };
      if (endpoint.endsWith('/positionRisk')) return model.positions;
      if (endpoint.endsWith('/openOrders')) return model.foreignOrders;
      if (endpoint.endsWith('/openAlgoOrders')) return [...model.foreignAlgos, ...Object.values(model.algos).filter(a => a.algoStatus === 'NEW')];
      if (endpoint.endsWith('/symbolConfig')) return [{ symbol: 'SOLUSDT', leverage: 1, marginType: 'ISOLATED' }];
      if (endpoint.endsWith('/algoOrder')) { if (!model.algos[params.clientAlgoId]) throw new Error('missing algo'); return model.algos[params.clientAlgoId]; }
      if (endpoint.endsWith('/order')) { if (!model.orders[params.origClientOrderId]) throw new Error('missing order'); return model.orders[params.origClientOrderId]; }
      throw new Error('Unexpected read ' + endpoint);
    },
    async post(endpoint, body) {
      calls.push({ method: 'POST', endpoint, body });
      if (endpoint.endsWith('/marginType')) return { code: 200 };
      if (endpoint.endsWith('/leverage')) return { leverage: 1 };
      if (endpoint.endsWith('/algoOrder')) {
        if (model.failProtection) throw new Error('protection rejected');
        const result = { ...body, orderType: body.type, algoStatus: 'NEW', algoId: '123', closePosition: true };
        model.algos[body.clientAlgoId] = result; return result;
      }
      if (endpoint.endsWith('/order')) {
        if (body.reduceOnly === 'true') {
          model.positions = []; const result = { status: 'FILLED', executedQty: body.quantity, avgPrice: '100' }; model.orders[body.newClientOrderId] = result; return result;
        }
        if (model.failEntry === 'absent') throw new Error('unknown response');
        const quantity = model.partial ? Number(body.quantity) / 2 : Number(body.quantity);
        const result = { status: model.partial ? 'PARTIALLY_FILLED' : 'FILLED', executedQty: String(quantity), avgPrice: '100' };
        model.orders[body.newClientOrderId] = result;
        model.positions = [{ symbol: body.symbol, positionAmt: String(quantity * (body.side === 'BUY' ? 1 : -1)), entryPrice: '100', markPrice: '100', unRealizedProfit: '0' }];
        if (model.failEntry === 'accepted') throw new Error('response lost after exchange accepted');
        return result;
      }
      throw new Error('Unexpected mutation ' + endpoint);
    },
    async delete(endpoint, params) {
      calls.push({ method: 'DELETE', endpoint, params });
      if (endpoint.endsWith('/algoOrder')) { delete model.algos[params.clientAlgoId]; return {}; }
      if (endpoint.endsWith('/order')) { model.orders[params.origClientOrderId].status = 'CANCELED'; return model.orders[params.origClientOrderId]; }
      throw new Error('Unexpected delete');
    },
  };
  const cfg = { dataDir }, trader = new BinanceLiveTrader(cfg, o, { api, now: () => time });
  const market = { request: async () => ({ symbols: [spec] }), quote: async () => quote };
  t.after(() => { trader.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { cfg, o, trader, api, calls, model, market };
}
const entries = calls => calls.filter(c => c.method === 'POST' && c.endpoint.endsWith('/order') && c.body.reduceOnly !== 'true');
test('real execution sends one entry, installs/verifies SL first and TP, and persists no credentials', async t => {
  const { trader, market, calls } = setup(t); await trader.tick(market); assert.equal(trader.status, 'READY');
  trader.enqueue(signal()); trader.enqueue(signal()); await trader.tick(market);
  assert.equal(entries(calls).length, 1); assert.equal(trader.state.entries[0].status, 'PROTECTED');
  const algos = calls.filter(c => c.method === 'POST' && c.endpoint.endsWith('/algoOrder'));
  assert.deepEqual(algos.map(c => c.body.type), ['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
  const journal = fs.readFileSync(trader.file, 'utf8'); assert.ok(!journal.includes('FAKE_KEY_TEST_ONLY')); assert.ok(!journal.includes('FAKE_SECRET_TEST_ONLY'));
  await trader.tick(market); assert.equal(entries(calls).length, 1);
});
test('read-only activation state makes no mutations, including leverage/margin changes', async t => {
  const { trader, market, calls } = setup(t); trader.options.enabled = false;
  await trader.tick(market); trader.enqueue(signal()); await trader.tick(market);
  assert.equal(trader.status, 'DISABLED'); assert.ok(calls.every(c => c.method === 'GET'));
});
test('ambiguous entry is never resubmitted; accepted-but-lost acknowledgment gets protection and persists halt after restart', async t => {
  for (const failEntry of ['absent', 'accepted']) {
    const { trader, cfg, o, api, market, calls } = setup(t, { failEntry });
    await trader.tick(market); trader.enqueue(signal()); await trader.tick(market); assert.ok(trader.state.halt);
    trader.stop(); const restarted = new BinanceLiveTrader(cfg, o, { api, now: () => time });
    try { await restarted.tick(market); restarted.enqueue(signal()); await restarted.tick(market); assert.equal(entries(calls).length, 1);
      if (failEntry === 'accepted') assert.equal(restarted.state.entries[0].status, 'PROTECTED');
    } finally { restarted.stop(); }
  }
});
test('failed protection attempts a reduce-only emergency close, halts and never duplicates that close', async t => {
  const { trader, market, calls, model } = setup(t, { failProtection: true });
  await trader.tick(market); trader.enqueue(signal()); await trader.tick(market); await trader.tick(market);
  const close = calls.filter(c => c.method === 'POST' && c.body.reduceOnly === 'true');
  assert.equal(close.length, 1); assert.equal(close[0].body.side, 'SELL'); assert.equal(model.positions.length, 0); assert.ok(trader.state.halt);
  assert.equal(entries(calls).length, 1);
});
test('partial fill cancels remaining entry and closes only the actual filled quantity', async t => {
  const { trader, market, calls } = setup(t, { partial: true });
  await trader.tick(market); trader.enqueue(signal()); await trader.tick(market);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.endpoint.endsWith('/order')));
  const entry = entries(calls)[0], close = calls.find(c => c.method === 'POST' && c.body.reduceOnly === 'true');
  assert.equal(Number(close.body.quantity), Number(entry.body.quantity) / 2); assert.ok(trader.state.halt);
});
test('daily account loss and any foreign position or pending order block new entries', async t => {
  const { trader, market, model, calls } = setup(t); await trader.tick(market); trader.enqueue(signal()); model.equity = 994; await trader.tick(market);
  assert.equal(entries(calls).length, 0); assert.equal(trader.status, 'HALTED');
  for (const change of [{ positions: [{ symbol: 'ETHUSDT', positionAmt: '1' }] }, { foreignOrders: [{ orderId: 'foreign' }] }, { foreignAlgos: [{ clientAlgoId: 'foreign' }] }]) {
    const s = setup(t, change); await s.trader.tick(s.market); s.trader.enqueue(signal()); await s.trader.tick(s.market); assert.equal(entries(s.calls).length, 0);
  }
});
test('closed positions remove only their own sibling algos, and pause does not abandon protection', async t => {
  const { trader, market, calls, model } = setup(t); await trader.tick(market); trader.enqueue(signal()); await trader.tick(market);
  trader.pause(); await trader.tick(market); assert.equal(trader.status, 'PAUSED'); assert.equal(trader.state.entries[0].status, 'PROTECTED');
  model.positions = []; model.foreignAlgos = [{ clientAlgoId: 'do-not-cancel' }]; await trader.tick(market);
  const deleted = calls.filter(c => c.method === 'DELETE' && c.endpoint.endsWith('/algoOrder')).map(c => c.params.clientAlgoId);
  assert.equal(deleted.length, 2); assert.ok(!deleted.includes('do-not-cancel')); assert.equal(trader.state.entries[0].status, 'CLOSED');
});
test('live SQLite process lock prevents duplicate workers and permits restart without stale PID files', async t => {
  const { trader, cfg, o, api } = setup(t);
  assert.throws(() => new BinanceLiveTrader(cfg, o, { api }), /already using/);
  trader.stop(); const next = new BinanceLiveTrader(cfg, o, { api }); next.stop();
});
test('live dashboard protects account status, assets and controls; public health reveals no financial data', async t => {
  const cfg = { host: '127.0.0.1', dashboardUser: 'bot', dashboardPassword: 'test-password-12345678' };
  let paused = 0; const server = dashboard(cfg, () => ({ balance: 12345 }), { '/api/live/pause': () => paused++ });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`, headers = { authorization: 'Basic ' + Buffer.from('bot:' + cfg.dashboardPassword).toString('base64') };
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { ok: true });
  for (const endpoint of ['/', '/api/status', '/app.js']) assert.equal((await fetch(url + endpoint)).status, 401);
  assert.equal((await fetch(url + '/api/live/pause', { method: 'POST', headers: { 'content-type': 'application/json' } })).status, 401); assert.equal(paused, 0);
  assert.equal((await fetch(url + '/api/status', { headers })).status, 200);
  assert.equal((await fetch(url + '/api/live/pause', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } })).status, 200); assert.equal(paused, 1);
});
