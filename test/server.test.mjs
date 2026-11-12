import test from 'node:test';
import assert from 'node:assert/strict';
process.env.MOONLIGHT_TEST_IMPORT = '1';
const { toolError } = await import('../src/server.mjs');

test('string cancellation reasons and non-Error failures produce valid MCP text content', () => {
  const reason = 'user cancelled';
  assert.equal(toolError(reason).content[0].text, reason);
  for (const error of [new Error('failure'), reason, null, undefined, {}, '']) {
    const result = toolError(error);
    assert.equal(result.isError, true);
    assert.equal(typeof result.content[0].text, 'string');
    assert.ok(result.content[0].text.length > 0);
    assert.equal(JSON.parse(JSON.stringify(result)).content[0].type, 'text');
  }
});
