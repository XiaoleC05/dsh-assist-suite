import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, resolveConfig } from '../lib/config.js';

test('defaults match the selected providers', () => {
  const { config, warnings } = resolveConfig({});
  assert.deepEqual(warnings, []);
  assert.equal(config.enabled, true);
  assert.equal(config.apiKey, '');
  assert.equal(config.apiKeyEnvFile, '');
  assert.equal(config.apiKeyEnvName, 'SILICONFLOW_API_KEY');
  assert.equal(config.asrProvider, 'siliconflow');
  assert.equal(config.asrApiBase, 'https://api.siliconflow.cn/v1');
  assert.equal(config.asrModel, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(config.polishModel, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.match(config.capabilityCatalog, /dsh-doc/);
  assert.equal(config.language, 'zh');
  assert.equal(config.defaultMode, 'structure');
  assert.equal(config.maxSeconds, 60);
  assert.equal(config.polish, true);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(DEFAULTS.asrModel, 'Qwen/Qwen3-ASR-1.7B');
});

test('mode aliases are accepted without a warning', () => {
  const { config, warnings } = resolveConfig({ defaultMode: '结构优化' });
  assert.equal(config.defaultMode, 'structure');
  assert.deepEqual(warnings, []);
});

test('an unknown mode falls back to faithful and warns', () => {
  const { config, warnings } = resolveConfig({ defaultMode: 'creative' });
  assert.equal(config.defaultMode, 'structure');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /defaultMode/);
});

test('an insecure endpoint falls back to the provider default', () => {
  const { config, warnings } = resolveConfig({ apiBase: 'http://example.com/v1', asrApiBase: 'http://example.com/asr' });
  assert.equal(config.apiBase, 'https://api.siliconflow.cn/v1/chat/completions');
  assert.equal(config.asrApiBase, 'https://api.siliconflow.cn/v1');
  assert.equal(warnings.length, 2);
});

test('numeric bounds are clamped and booleans accept YAML strings', () => {
  const { config } = resolveConfig({
    enabled: 'false',
    maxSeconds: 1,
    speechTimeoutMs: 1,
    optimizeTimeoutMs: 999999,
    maxPromptChars: 10,
    maxOutputTokens: 99999,
    polish: 'off',
  });
  assert.equal(config.enabled, false);
  assert.equal(config.maxSeconds, 5);
  assert.equal(config.speechTimeoutMs, 15000);
  assert.equal(config.optimizeTimeoutMs, 180000);
  assert.equal(config.maxPromptChars, 200);
  assert.equal(config.maxOutputTokens, 8192);
  assert.equal(config.polish, false);
});

test('an explicit SiliconFlow key is bounded and trimmed', () => {
  const { config } = resolveConfig({ apiKey: '  sk-test  ' });
  assert.equal(config.apiKey, 'sk-test');
});

test('a custom capability catalog is kept', () => {
  const { config } = resolveConfig({ capabilityCatalog: '- Skill custom-skill：测试' });
  assert.equal(config.capabilityCatalog, '- Skill custom-skill：测试');
});

test('an empty env file path stays empty', () => {
  const { config } = resolveConfig({ apiKeyEnvFile: '   ' });
  assert.equal(config.apiKeyEnvFile, '');
});
