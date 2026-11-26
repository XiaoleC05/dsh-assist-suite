import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS } from '../lib/config.js';
import { VoiceError, VoiceService, decodeAudioBase64, parseWav } from '../lib/voice.js';

function makeWav(durationMs = 1000, options = {}) {
  const sampleRate = options.sampleRate || 16000;
  const channels = options.channels || 1;
  const bitsPerSample = options.bitsPerSample || 16;
  const frames = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const dataSize = frames * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function audio(durationMs = 1000, options) {
  return 'data:audio/wav;base64,' + makeWav(durationMs, options).toString('base64');
}

function fakeAsr(overrides = {}) {
  return {
    status: async () => ({
      configured: true,
      source: 'config',
      sourceLabel: '插件配置',
      provider: 'SiliconFlow',
      asrModel: 'Qwen/Qwen3-ASR-1.7B',
    }),
    transcribe: async () => ({
      text: overrides.transcript === undefined ? '你好，这是测试。' : overrides.transcript,
      model: 'Qwen/Qwen3-ASR-1.7B',
      provider: 'SiliconFlow',
    }),
  };
}

function fakeChat(overrides = {}) {
  return {
    status: async () => ({
      configured: true,
      source: 'env-file',
      sourceLabel: '配置文件',
      polishModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
    }),
    polish: async () => {
      if (overrides.polishError) throw overrides.polishError;
      return overrides.polished === undefined ? '你好，这是测试。' : overrides.polished;
    },
  };
}

function service(asr = fakeAsr(), chat = fakeChat(), overrides = {}) {
  return new VoiceService({
    config: { ...DEFAULTS, ...overrides },
    asr,
    chat,
  });
}

test('parseWav accepts only canonical 16 kHz mono PCM16', () => {
  const parsed = parseWav(makeWav(1200));
  assert.equal(parsed.durationMs, 1200);
  assert.throws(() => parseWav(makeWav(1000, { sampleRate: 44100 })), (error) => error.code === 'VOICE_INVALID_AUDIO');
  assert.throws(() => parseWav(makeWav(1000, { channels: 2 })), (error) => error.code === 'VOICE_INVALID_AUDIO');
  assert.throws(() => parseWav(Buffer.from('not a wav')), (error) => error.code === 'VOICE_INVALID_AUDIO');
});

test('decodeAudioBase64 accepts a data URI and rejects an empty payload', () => {
  const buffer = decodeAudioBase64(audio(600));
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.throws(() => decodeAudioBase64(''), (error) => error.code === 'VOICE_AUDIO_REQUIRED');
});

test('process returns the polished chat result and timing metadata', async () => {
  const voice = service(fakeAsr(), fakeChat({ polished: '你好，这是测试。' }));
  const result = await voice.process({ audioBase64: audio(1200), mode: 'faithful' });
  assert.equal(result.transcript, '你好，这是测试。');
  assert.equal(result.text, '你好，这是测试。');
  assert.equal(result.mode, 'faithful');
  assert.equal(result.engine, 'siliconflow');
  assert.equal(result.empty, false);
  assert.equal(result.durationMs, 1200);
  assert.equal(result.asrModel, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(result.asrProvider, 'SiliconFlow');
  assert.equal(result.polishModel, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.ok(result.timings.asrMs >= 0);
});

test('a filler-only transcript returns an empty result without calling polish', async () => {
  let polished = 0;
  const asr = fakeAsr({ transcript: '嗯嗯 那个 然后 就是' });
  const chat = fakeChat();
  const original = chat.polish;
  chat.polish = async () => { polished += 1; return original(); };
  const result = await service(asr, chat).process({ audioBase64: audio(800) });
  assert.equal(result.empty, true);
  assert.equal(result.text, '');
  assert.equal(polished, 0);
});

test('a polish failure keeps the transcript and reports a warning', async () => {
  const result = await service(fakeAsr(), fakeChat({ polishError: new Error('upstream down') }))
    .process({ audioBase64: audio(800) });
  assert.equal(result.text, '你好，这是测试。');
  assert.equal(result.engine, 'asr');
  assert.match(result.warning, /upstream down/);
});

test('an empty polish answer keeps the recognized transcript and explains why', async () => {
  const result = await service(fakeAsr(), fakeChat({ polished: '' })).process({ audioBase64: audio(800) });
  assert.equal(result.empty, false);
  assert.equal(result.text, '你好，这是测试。');
  assert.equal(result.engine, 'asr');
  assert.match(result.warning, /润色未返回有效内容/);
});

test('duration bounds use the speech minimum and the configured maximum', async () => {
  await assert.rejects(
    () => service().process({ audioBase64: audio(200) }),
    (error) => error instanceof VoiceError && error.code === 'VOICE_TOO_SHORT',
  );
  await assert.rejects(
    () => service(fakeAsr(), fakeChat(), { maxSeconds: 5 }).process({ audioBase64: audio(6500) }),
    (error) => error.code === 'VOICE_TOO_LONG',
  );
});

test('status reports separate ASR and chat key states', async () => {
  const status = await service().status();
  assert.equal(status.configured, true);
  assert.equal(status.source, 'env-file');
  assert.equal(status.asrConfigured, true);
  assert.equal(status.asrSource, 'config');
  assert.equal(status.asrModel, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(status.asrProvider, 'SiliconFlow');
  assert.equal(status.polishModel, 'deepseek-ai/DeepSeek-V4.1-Flash');
  assert.equal(status.defaultMode, 'structure');
});
