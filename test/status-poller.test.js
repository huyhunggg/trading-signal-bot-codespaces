import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshStatus } from '../ui/status-poller.js';

test('render exceptions never claim network/process loss or rerender a cached snapshot', async () => {
  let renders = 0, network = 0, ui = 0;
  const result = await refreshStatus({
    fetcher: async () => ({ ok: true, json: async () => ({ status: { phase: 'STREAMING' } }) }),
    render: () => { renders++; throw new TypeError('invalid view'); },
    onConnectionError: () => network++, onRenderError: error => { assert.equal(error.message, 'invalid view'); ui++; },
  });
  assert.equal(result, 'RENDER_ERROR'); assert.equal(renders, 1); assert.equal(network, 0); assert.equal(ui, 1);
});
test('HTTP and network failures retain diagnostic status and do not render old data as live', async () => {
  for (const fetcher of [async () => ({ ok: false, status: 502 }), async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } })]) {
    let renders = 0, network = 0;
    const result = await refreshStatus({ fetcher, render: () => renders++, onConnectionError: error => {
      network++; if (error.message === 'Status HTTP failure') assert.equal(error.httpStatus, 502);
    }, onRenderError: () => assert.fail('not a render error') });
    assert.equal(result, 'CONNECTION_ERROR'); assert.equal(renders, 0); assert.equal(network, 1);
  }
});
test('a successful refresh renders the latest server snapshot and clears previous error path', async () => {
  const state = { trading: { mode: 'PAPER_LIVE', entries: [] }, status: { phase: 'STREAMING' } };
  const result = await refreshStatus({
    fetcher: async (url, options) => { assert.equal(url, '/api/status'); assert.equal(options.cache, 'no-store'); return { ok: true, json: async () => state }; },
    render: snapshot => assert.equal(snapshot, state), onConnectionError: () => assert.fail('connected'), onRenderError: () => assert.fail('rendered'),
  });
  assert.equal(result, 'OK');
});
