import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureConfig, readConfig, validateConfig, validateCommand } from '../src/config.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moonlight-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'config.json');
}
test('configuration is created privately once and reused without credential rotation', async t => {
  const file = await fixture(t);
  const first = await ensureConfig(file);
  assert.notEqual(first.clientToken, first.browserToken);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await ensureConfig(file), first);
  assert.deepEqual(await readConfig(file), first);
});
test('malformed existing configuration is diagnosed and never overwritten', async t => {
  const file = await fixture(t);
  await ensureConfig(file);
  const invalid = '{this is not json';
  await writeFile(file, invalid);
  await assert.rejects(ensureConfig(file), /JSON/);
  assert.equal(await readFile(file, 'utf8'), invalid);
  await writeFile(file, JSON.stringify({ port: 0, clientToken: 'same', browserToken: 'same' }));
  await assert.rejects(ensureConfig(file), /配置无效/);
});
test('configuration rejects invalid ports, header injection and shared credentials', () => {
  const valid = { port: 47831, clientToken: 'client-secret', browserToken: 'browser-secret' };
  for (const port of [0, -1, 65536, 1.5, '47831']) assert.throws(() => validateConfig({ ...valid, port }));
  for (const clientToken of ['', 'abc\r\nInjected: yes', 'browser-secret']) assert.throws(() => validateConfig({ ...valid, clientToken }));
  assert.equal(validateConfig(valid), valid);
});
test('direct bridge commands have the same library and identifier bounds as MCP tools', () => {
  for (const maxPages of [0, -1, 21, 1.5, '2', Infinity]) assert.throws(() => validateCommand({ action: 'library', tabId: 1, maxPages }));
  for (const query of [null, {}, 'x'.repeat(501)]) assert.throws(() => validateCommand({ action: 'library', tabId: 1, query }));
  assert.throws(() => validateCommand({ action: 'paper', tabId: -1 }));
  assert.throws(() => validateCommand({ action: 'pages', tabId: 1, startPage: 2 ** 53, endPage: 2 ** 53 }));
  assert.throws(() => validateCommand({ action: 'ai_submit', tabId: 1, requestId: ['a'.repeat(32)] }));
  assert.throws(() => validateCommand({ action: 'open_paper', paperId: ['11111111-1111-4111-8111-111111111111'] }));
  assert.doesNotThrow(() => validateCommand({ action: 'library', tabId: 0, query: '', maxPages: 20 }));
});
