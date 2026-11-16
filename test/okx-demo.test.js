import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { OkxDemoApi } from '../src/okx-demo-api.js';
import { OkxDemoTrader, demoOptions, planDemoOrder, quantize } from '../src/okx-demo-trader.js';

const clock = Date.UTC(2026, 10, 16, 1, 0, 10);
const options = () => demoOptions({ OKX_DEMO_API_KEY: 'demo-key', OKX_DEMO_SECRET_KEY: 'secret-never-log', OKX_DEMO_PASSPHRASE: 'pass-never-log' });
const signal = (overrides = {}) => ({ id: 'okx:BTC:5m:123:CLOSED:LONG', exchange: 'okx', symbol: 'BTCUSDT', timeframe: '5m', layer: 'CLOSED',
  closed: true, side: 'LONG', candleEndTime: clock - 10000, referencePrice: 65000, sl: 64400, tp1: 65300, ...overrides });
const instrument = { instId: 'BTC-USDT-SWAP', instType: 'SWAP', state: 'live', ctType: 'linear', settleCcy: 'USDT', ctValCcy: 'BTC',
  ctVal: '0.01', ctMult: '1', tickSz: '0.1', lotSz: '0.01', minSz: '0.01' };
const ticker = { last: '65000', ts: String(clock) };

test('all authenticated requests are locked to demo origin/header and signed with exact query/body', async () => {
  const calls = [], credentials = options().credentials;
  const api = new OkxDemoApi(credentials, { now: () => clock, fetcher: async (url, args) => {
    calls.push({ url, args }); return { ok: true, json: async () => ({ code: '0', data: [{ ordId: '123', sCode: '0' }] }) };
  } });
  await api.get('/api/v5/account/balance', { ccy: 'USDT' });
  await api.post('/api/v5/trade/order', { instId: 'BTC-USDT-SWAP', sz: '0.01' });
  for (const { url, args } of calls) {
    assert.equal(new URL(url).origin, 'https://openapi.okx.com'); assert.equal(args.headers['x-simulated-trading'], '1'); assert.equal(args.redirect, 'error');
    const pathname = url.replace('https://openapi.okx.com', '');
    const expected = createHmac('sha256', credentials.secret).update(new Date(clock).toISOString() + args.method + pathname + (args.body || '')).digest('base64');
    assert.equal(args.headers['OK-ACCESS-SIGN'], expected);
  }
});
test('API errors redact server message and network details, reject individual order failures', async () => {
  const api = new OkxDemoApi(options().credentials, { fetcher: async () => ({ ok: true, json: async () => ({ code: '0', data: [{ sCode: '51000', sMsg: 'secret-never-log' }] }) }) });
  await assert.rejects(api.post('/api/v5/trade/order', {}), { message: 'DEMO_API_51000' });
  api.fetcher = async () => { throw new Error('secret-never-log'); };
  await assert.rejects(api.get('/api/v5/account/config'), { message: 'DEMO_NETWORK_UNKNOWN' });
});
test('contract sizing respects lot/minimum, risk and notional; entry includes full TP1 and SL', () => {
  const order = planDemoOrder(signal(), instrument, ticker, options(), clock);
  const base = Number(order.sz) * Number(instrument.ctVal), risk = base * (600 + 65000 * 0.003);
  assert.ok(base * 65000 <= 50); assert.ok(risk <= 1); assert.equal(order.tdMode, 'isolated'); assert.equal(order.posSide, 'net');
  assert.equal(order.attachAlgoOrds[0].slOrdPx, '-1'); assert.equal(order.attachAlgoOrds[0].tpTriggerPx, '65300.0');
  assert.ok(order.clOrdId.length <= 32); assert.ok(order.attachAlgoOrds[0].attachAlgoClOrdId.length <= 32);
  assert.equal(quantize(0.79, '0.25'), '0.75'); assert.equal(quantize(0.79, '0.25', true), '1.00');
  const short = planDemoOrder(signal({ side: 'SHORT', sl: 65600, tp1: 64700 }), instrument, ticker, options(), clock);
  assert.equal(short.side, 'sell');
  assert.throws(() => planDemoOrder(signal(), { ...instrument, minSz: '1' }, ticker, options(), clock), /BELOW_MINIMUM/);
});
test('reject stale/future/wrong-source/impulse data, inverse contracts and moved prices', () => {
  for (const s of [signal({ exchange: 'bybit' }), signal({ layer: 'IMPULSE' }), signal({ closed: false }),
    signal({ candleEndTime: clock - 61000 }), signal({ candleEndTime: clock + 1 }), signal({ referencePrice: NaN })]) {
    assert.throws(() => planDemoOrder(s, instrument, ticker, options(), clock));
  }
  for (const t of [{ last: '66000', ts: String(clock) }, { last: '65000', ts: String(clock - 16000) }]) assert.throws(() => planDemoOrder(signal(), instrument, t, options(), clock));
  assert.throws(() => planDemoOrder(signal(), { ...instrument, ctType: 'inverse' }, ticker, options(), clock));
  assert.throws(() => demoOptions({ OKX_DEMO_MAX_NOTIONAL_USDT: '100000' }));
});

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-demo-'));
  const calls = [], model = { positions: [], pending: [], algos: [], orders: {}, failSubmit: false, equity: 1000, ...overrides };
  const api = {
    async get(endpoint, params) {
      calls.push({ method: 'GET', endpoint, params });
      if (endpoint.endsWith('/config')) return [{ posMode: 'net_mode', uid: 'demo-account-1' }];
      if (endpoint.endsWith('/balance')) return [{ details: [{ ccy: 'USDT', eq: String(model.equity), availEq: '900' }] }];
      if (endpoint.endsWith('/positions')) return model.positions;
      if (endpoint.endsWith('/orders-pending')) return model.pending;
      if (endpoint.endsWith('/orders-algo-pending')) return params.ordType === 'oco' ? model.algos : [];
      if (endpoint.endsWith('/positions-history')) return [];
      if (endpoint.endsWith('/instruments')) return [instrument];
      if (endpoint.endsWith('/ticker')) return [ticker];
      if (endpoint.endsWith('/order')) {
        if (!model.orders[params.clOrdId]) throw new Error('DEMO_API_51603');
        return [model.orders[params.clOrdId]];
      }
      throw new Error(endpoint);
    },
    async post(endpoint, body) {
      calls.push({ method: 'POST', endpoint, body });
      if (endpoint.endsWith('/set-leverage')) return [{ lever: '1' }];
      if (model.failSubmit) throw new Error('DEMO_NETWORK_UNKNOWN');
      model.orders[body.clOrdId] = { state: 'live', avgPx: '', accFillSz: '0' };
      return [{ ordId: '456' }];
    },
  };
  let time = clock;
  const cfg = { dataDir }, trader = new OkxDemoTrader(cfg, options(), { api, now: () => time });
  t.after(() => { trader.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { cfg, trader, calls, model, api, setTime: n => { time = n; } };
}
const placed = calls => calls.filter(c => c.method === 'POST' && c.endpoint.endsWith('/trade/order'));
test('fresh signal submits once, persists intent without secrets, and restart reconciles it', async t => {
  const { cfg, trader, calls, api } = setup(t);
  await trader.tick(); assert.equal(trader.status, 'READY');
  trader.enqueue(signal()); trader.enqueue(signal()); await trader.tick();
  assert.equal(placed(calls).length, 1);
  const journal = fs.readFileSync(trader.file, 'utf8'); assert.ok(!journal.includes('secret-never-log'));
  trader.stop();
  const restarted = new OkxDemoTrader(cfg, options(), { api, now: () => clock });
  try { await restarted.tick(); restarted.enqueue(signal()); await restarted.tick(); assert.equal(placed(calls).length, 1); assert.equal(restarted.status, 'POSITION_OPEN'); }
  finally { restarted.stop(); }
});
test('timeout never resubmits, including after restart; journal keeps uncertainty', async t => {
  const { cfg, trader, calls, api } = setup(t, { failSubmit: true });
  await trader.tick(); trader.enqueue(signal()); await trader.tick(); assert.equal(trader.status, 'HALTED');
  trader.stop(); const restarted = new OkxDemoTrader(cfg, options(), { api, now: () => clock });
  try { await restarted.tick(); restarted.enqueue(signal()); await restarted.tick(); assert.equal(placed(calls).length, 1); assert.equal(restarted.state.entries[0].status, 'UNKNOWN'); }
  finally { restarted.stop(); }
});
test('any existing account position, pending order or exit algo blocks opening another', async t => {
  for (const overrides of [{ positions: [{ instId: 'ETH-USDT-SWAP', pos: '1', upl: '0' }] }, { pending: [{ ordId: 'foreign' }] }, { algos: [{ algoId: 'foreign' }] }]) {
    const { trader, calls } = setup(t, overrides); await trader.tick(); trader.enqueue(signal()); await trader.tick(); assert.equal(placed(calls).length, 0); assert.equal(trader.status, 'POSITION_OPEN');
  }
});
test('daily equity loss and pause-file stop new entries while continuing account sync', async t => {
  const { trader, model, calls } = setup(t); await trader.tick(); trader.enqueue(signal());
  fs.writeFileSync(trader.pauseFile, 'pause'); await trader.tick(); assert.equal(trader.status, 'PAUSED'); assert.equal(placed(calls).length, 0);
  fs.rmSync(trader.pauseFile); await trader.tick(); trader.enqueue(signal()); model.equity = 994;
  await trader.tick(); assert.equal(trader.status, 'HALTED'); assert.equal(placed(calls).length, 0);
});
test('completed order verifies exchange SL/TP and closed position releases slot', async t => {
  const { trader, model, setTime } = setup(t); await trader.tick(); trader.enqueue(signal()); await trader.tick();
  const entry = trader.state.entries[0]; model.orders[entry.clOrdId] = { state: 'filled', avgPx: '65000', accFillSz: entry.body.sz };
  model.positions = [{ instId: entry.instId, pos: entry.body.sz, avgPx: '65000', upl: '0' }];
  model.algos = [{ algoClOrdId: entry.body.attachAlgoOrds[0].attachAlgoClOrdId, instId: entry.instId, slTriggerPx: '64400.0', tpTriggerPx: '65300.0', side: 'sell', sz: entry.body.sz }];
  setTime(clock + 31000); await trader.tick(); assert.equal(trader.state.halted, null); assert.equal(entry.status, 'LIVE');
  model.positions = []; model.algos = []; await trader.tick(); assert.equal(entry.status, 'CLOSED'); assert.equal(trader.status, 'READY');
});
test('missing protection and partial fills cause persistent halt', async t => {
  for (const state of ['filled', 'partially_filled', 'canceled']) {
    const { trader, model, setTime } = setup(t); await trader.tick(); trader.enqueue(signal()); await trader.tick();
    const entry = trader.state.entries[0]; model.orders[entry.clOrdId] = { state, avgPx: '65000', accFillSz: '0.01' };
    model.positions = [{ instId: entry.instId, pos: '0.01', upl: '0' }]; setTime(clock + 31000); await trader.tick(); assert.equal(trader.status, 'HALTED');
  }
});
test('single-process lock prevents starting a second bot with same journal', t => {
  const { cfg, api } = setup(t);
  assert.throws(() => new OkxDemoTrader(cfg, options(), { api }), /already running/);
});
