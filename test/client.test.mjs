import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeEnsurer, request, command } from '../src/client.mjs';
const config = { port: 47832, clientToken: 'client', browserToken: 'browser' };
const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
const child = () => Object.assign(new EventEmitter(), { unref() {} });

test('concurrent startup calls share a single process and failure does not poison later calls', async () => {
  let starts = 0, probes = 0;
  const ensure = createBridgeEnsurer({ loadConfig: async () => config, wait: async () => {},
    start: () => { starts++; return child(); },
    send: async () => { if (++probes === 1) throw refused(); },
  });
  const values = await Promise.all([ensure(), ensure(), ensure()]);
  assert.equal(starts, 1); assert.deepEqual(values, [config, config, config]);
  await ensure(); assert.equal(starts, 1); assert.equal(probes, 3);
  let fails = true;
  const retry = createBridgeEnsurer({ loadConfig: async () => { if (fails) throw new Error('bad config'); return config; }, send: async () => {} });
  await assert.rejects(retry(), /bad config/); fails = false; assert.equal(await retry(), config);
});
test('authentication failures and health timeouts do not spawn another bridge', async () => {
  let starts = 0;
  for (const failure of [new Error('Unauthorized'), new DOMException('timed out', 'TimeoutError')]) {
    const ensure = createBridgeEnsurer({ loadConfig: async () => config, send: async () => { throw failure; }, start: () => { starts++; return child(); } });
    await assert.rejects(ensure(), error => error === failure);
  }
  assert.equal(starts, 0);
});
test('spawn errors are handled and startup exhaustion identifies the configured port', async () => {
  let emitter;
  const ensure = createBridgeEnsurer({ loadConfig: async () => config, send: async () => { throw refused(); },
    start: () => { emitter = child(); return emitter; }, wait: async () => { emitter.emit('error', new Error('spawn denied')); },
  });
  await assert.rejects(ensure(), /spawn denied/);
  const exhausted = createBridgeEnsurer({ loadConfig: async () => config, send: async () => { throw refused(); }, start: child, wait: async () => {} });
  await assert.rejects(exhausted(), /47832/);
});
test('local HTTP requests reject redirects and unrelated health services', async t => {
  let options;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { options = init; return Response.json({ name: 'another-service', browserConnected: false }); });
  await assert.rejects(request(config, '/health'), /不是预期/);
  assert.equal(options.redirect, 'error');
  globalThis.fetch.mock.mockImplementation(async () => new Response('not json'));
  await assert.rejects(request(config, '/health'), /无效响应/);
  globalThis.fetch.mock.mockImplementation(async () => Response.json(null, { status: 503 }));
  await assert.rejects(request(config, '/command', { action: 'tabs' }), /HTTP 503/);
});
test('caller cancellation reaches HTTP and an already cancelled command never starts work', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = request(config, '/command', { action: 'tabs' }, { signal: controller.signal });
  controller.abort('cancelled by caller');
  await assert.rejects(pending, error => error === 'cancelled by caller');
  await assert.rejects(command({ action: 'tabs' }, { signal: controller.signal }), error => error === 'cancelled by caller');
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});
