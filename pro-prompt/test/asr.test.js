import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS } from '../lib/config.js';
import { SiliconFlowAsrClient, extractTranscript } from '../lib/asr.js';

function config(overrides = {}) {
  return {
    ...DEFAULTS,
    apiKey: 'sk-sf-test',
    asrApiBase: 'https://api.siliconflow.cn/v1',
    asrModel: 'Qwen/Qwen3-ASR-1.7B',
    speechTimeoutMs: 3000,
    ...overrides,
  };
}

function keyResolver(overrides = {}) {
  return {
    async resolve() { return overrides.resolve || { key: 'sk-sf-test', source: 'config' }; },
    async status() { return overrides.status || { configured: true, source: 'config', sourceLabel: '插件配置' }; },
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('transcribe sends a multipart form to SiliconFlow with the selected model', async () => {
  const calls = [];
  const client = new SiliconFlowAsrClient({
    config: config(),
    keyResolver: keyResolver(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json({ text: '这是一个语音识别测试。', language: 'Chinese', usage: { seconds: 6 } });
    },
  });
  const result = await client.transcribe(Buffer.from('fake-wav').toString('base64'), 'zh');
  assert.equal(result.text, '这是一个语音识别测试。');
  assert.equal(result.model, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(result.provider, 'SiliconFlow');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/audio/transcriptions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-sf-test');
  const body = calls[0].options.body;
  assert.equal(body.get('model'), 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(body.get('language'), 'zh');
  const file = body.get('file');
  assert.ok(file !== null);
  assert.equal(file.size, 8);
});

test('a missing ASR key is reported before any HTTP request', async () => {
  let called = false;
  const client = new SiliconFlowAsrClient({
    config: config({ apiKey: '' }),
    keyResolver: keyResolver({ resolve: { key: '', source: 'none' } }),
    fetchImpl: async () => { called = true; return json({}); },
  });
  await assert.rejects(() => client.transcribe('AQID', 'zh'), (error) => error.code === 'ASR_KEY_MISSING');
  assert.equal(called, false);
});

test('SiliconFlow auth and parameter failures are mapped without leaking the key', async () => {
  const auth = new SiliconFlowAsrClient({
    config: config(),
    keyResolver: keyResolver(),
    fetchImpl: async () => json({ error: { message: 'invalid key sk-sf-test' } }, 401),
  });
  await assert.rejects(() => auth.transcribe('AQID', 'zh'), (error) => {
    assert.equal(error.code, 'ASR_AUTH');
    assert.equal(error.message.includes('sk-sf-test'), false);
    return true;
  });

  const bad = new SiliconFlowAsrClient({
    config: config(),
    keyResolver: keyResolver(),
    fetchImpl: async () => json({ error: { message: 'model not found' } }, 400),
  });
  await assert.rejects(() => bad.transcribe('AQID', 'zh'), (error) => error.code === 'ASR_BAD_REQUEST');
});

test('an empty transcript is a visible no-speech failure', async () => {
  const client = new SiliconFlowAsrClient({
    config: config(),
    keyResolver: keyResolver(),
    fetchImpl: async () => json({ text: '' }),
  });
  await assert.rejects(() => client.transcribe('AQID', 'zh'), (error) => error.code === 'VOICE_NO_SPEECH');
});

test('filler-only text is returned for VoiceService to handle', async () => {
  const client = new SiliconFlowAsrClient({
    config: config(),
    keyResolver: keyResolver(),
    fetchImpl: async () => json({ text: '嗯嗯 那个 然后' }),
  });
  const result = await client.transcribe('AQID', 'zh');
  assert.equal(result.text, '嗯嗯 那个 然后');
});

test('status reports the ASR key source and selected model', async () => {
  const client = new SiliconFlowAsrClient({
    config: config(),
    keyResolver: keyResolver({ status: { configured: true, source: 'config', sourceLabel: '插件配置' } }),
  });
  const status = await client.status();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'config');
  assert.equal(status.provider, 'SiliconFlow');
  assert.equal(status.asrModel, 'Qwen/Qwen3-ASR-1.7B');
});

test('extractTranscript accepts the common response shapes', () => {
  assert.equal(extractTranscript({ text: ' 甲 ' }), '甲');
  assert.equal(extractTranscript({ output: { text: '乙' } }), '乙');
  assert.equal(extractTranscript({ result: { text: '丙' } }), '丙');
  assert.equal(extractTranscript({ data: { text: '丁' } }), '丁');
  assert.equal(extractTranscript(null), '');
});
