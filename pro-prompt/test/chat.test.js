import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS } from '../lib/config.js';
import { SiliconFlowChatClient, extractMessageText } from '../lib/chat.js';
import { SPEECH_PROMPTS } from '../lib/prompts.js';

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function config(overrides = {}) {
  return { ...DEFAULTS, optimizeTimeoutMs: 3000, speechTimeoutMs: 3000, ...overrides };
}

function clientWith(fetchImpl, overrides = {}) {
  const keyResolver = {
    async resolve() { return { key: 'sk-test-123456', source: 'config' }; },
    async status() { return { configured: true, source: 'config', sourceLabel: '插件配置' }; },
  };
  return new SiliconFlowChatClient({ config: config(overrides), keyResolver, fetchImpl });
}

test('structure optimize generates then reviews with the capability catalog', async () => {
  const calls = [];
  const client = clientWith(async (url, options) => {
    calls.push({ url, options });
    return json({ choices: [{ message: { content: '```markdown\n优化后的提示词：\n## 任务\n修复登录 500\n```' } }] });
  });
  const result = await client.optimize('登录 500 修一下', 'structure');
  assert.equal(result.text, '## 任务\n修复登录 500');
  assert.equal(result.mode, 'structure');
  assert.equal(result.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(result.reviewed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, DEFAULTS.apiBase);
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-test-123456');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens, DEFAULTS.maxOutputTokens);
  assert.match(body.messages[0].content, /dsh-doc/);
  assert.match(body.messages[0].content, /完整提示词/);
  assert.doesNotMatch(body.messages[0].content, /\{\{CAPABILITIES\}\}/);
  assert.match(body.messages[1].content, /登录 500 修一下/);
  const reviewBody = JSON.parse(calls[1].options.body);
  assert.match(reviewBody.messages[0].content, /质量审查员/);
  assert.match(reviewBody.messages[1].content, /--- BEGIN CANDIDATE ---/);
});

test('structure review repairs placeholders from the first draft', async () => {
  const calls = [];
  const client = clientWith(async (url, options) => {
    calls.push({ url, options });
    const content = calls.length === 1
      ? '## 任务\n修复登录 500\n## 验收\n【待补充：验收标准】'
      : '## 任务\n修复登录 500\n## 验收\n- 登录页返回 200，原有测试通过。';
    return json({ choices: [{ message: { content } }] });
  });
  const result = await client.optimize('登录 500 修一下', 'structure');
  assert.equal(calls.length, 2);
  assert.doesNotMatch(result.text, /待补充/);
  assert.match(result.text, /验收标准|原有测试/);
});

test('voice polish uses the verbatim built-in faithful speech prompt', async () => {
  const calls = [];
  const client = clientWith(async (url, options) => {
    calls.push({ url, options });
    return json({ choices: [{ message: { content: '昨天说过的那件事。' } }] });
  });
  const polished = await client.polish('那个就是昨天说的那件事', 'faithful');
  assert.equal(polished, '昨天说过的那件事。');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.messages[0].content, SPEECH_PROMPTS.faithful);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 512);
});

test('an empty or refusal answer is a visible optimization failure', async () => {
  const empty = clientWith(async () => json({ choices: [{ message: { content: '' } }] }));
  await assert.rejects(() => empty.optimize('写清楚', 'faithful'), (error) => error.code === 'EMPTY_OUTPUT');

  const refusal = clientWith(async () => json({ choices: [{ message: { content: '无实质内容' } }] }));
  await assert.rejects(() => refusal.optimize('写清楚', 'faithful'), (error) => error.code === 'EMPTY_OUTPUT');
});

test('a missing key is reported before any HTTP request', async () => {
  let called = false;
  const keyResolver = {
    async resolve() { return { key: '', source: 'none' }; },
    async status() { return { configured: false, source: 'none', sourceLabel: '未配置' }; },
  };
  const client = new SiliconFlowChatClient({
    config: config(),
    keyResolver,
    fetchImpl: async () => { called = true; return json({}); },
  });
  await assert.rejects(() => client.optimize('test', 'faithful'), (error) => error.code === 'KEY_MISSING');
  assert.equal(called, false);
});

test('upstream failures map to actionable codes without echoing the key', async () => {
  const auth = clientWith(async () => json({ error: { message: 'invalid key sk-test-123456' } }, 401));
  await assert.rejects(() => auth.optimize('test', 'faithful'), (error) => {
    assert.equal(error.code, 'AUTH');
    assert.equal(error.message.includes('sk-test-123456'), false);
    return true;
  });

  const rate = clientWith(async () => json({ error: { message: 'quota' } }, 429));
  await assert.rejects(() => rate.optimize('test', 'faithful'), (error) => error.code === 'RATE_LIMIT');

  const bad = clientWith(async () => json({ error: { message: 'bad model' } }, 400));
  await assert.rejects(() => bad.optimize('test', 'faithful'), (error) => error.code === 'BAD_REQUEST');

  const network = clientWith(async () => { throw new Error('ECONNRESET'); });
  await assert.rejects(() => network.optimize('test', 'faithful'), (error) => error.code === 'NETWORK');
});

test('extractMessageText accepts native response shapes', () => {
  assert.equal(extractMessageText({ output: { choices: [{ message: { content: [{ text: '甲' }, { text: '乙' }] } }] } }), '甲乙');
  assert.equal(extractMessageText({ output: { text: '丙' } }), '丙');
});
