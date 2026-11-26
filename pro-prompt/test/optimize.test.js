import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS } from '../lib/config.js';
import { Optimizer } from '../lib/optimize.js';

function client(overrides = {}) {
  const calls = [];
  return {
    calls,
    optimize: async (text, mode) => {
      calls.push({ text, mode });
      if (overrides.error) throw overrides.error;
      return { text: '## 任务\n' + text, mode, model: 'deepseek-ai/DeepSeek-V4.1-Flash' };
    },
  };
}

test('optimizer validates empty and oversized input', async () => {
  const optimizer = new Optimizer({ config: { ...DEFAULTS, maxPromptChars: 10 }, client: client() });
  await assert.rejects(() => optimizer.optimize({ text: '   ' }), (error) => error.code === 'TEXT_REQUIRED');
  await assert.rejects(() => optimizer.optimize({ text: 'x'.repeat(11) }), (error) => error.code === 'TEXT_TOO_LARGE');
});

test('optimizer forwards the selected mode and returns the cleaned model result', async () => {
  const fake = client();
  const optimizer = new Optimizer({ config: { ...DEFAULTS, defaultMode: 'faithful' }, client: fake });
  const result = await optimizer.optimize({ text: '  登录 500 修一下  ', mode: 'structure' });
  assert.equal(fake.calls[0].text, '登录 500 修一下');
  assert.equal(fake.calls[0].mode, 'structure');
  assert.equal(result.mode, 'structure');
  assert.match(result.text, /登录 500 修一下/);
  assert.ok(result.elapsedMs >= 0);
});

test('optimizer uses the configured default mode when none is passed', async () => {
  const fake = client();
  const optimizer = new Optimizer({ config: { ...DEFAULTS, defaultMode: 'structure' }, client: fake });
  const result = await optimizer.optimize({ text: '任务' });
  assert.equal(fake.calls[0].mode, 'structure');
  assert.equal(result.mode, 'structure');
});
