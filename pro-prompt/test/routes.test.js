import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS } from '../lib/config.js';
import { registerRoutes, ROUTE_PREFIX } from '../lib/routes.js';

function mockRequest(method, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    method,
    url: ROUTE_PREFIX,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(text) { if (typeof text === 'string') this.body += text; },
    json() { return JSON.parse(this.body); },
  };
}

function harness(options = {}) {
  const registered = new Map();
  const webServer = {
    register(entry) {
      registered.set(entry.path, entry.handler);
      return () => registered.delete(entry.path);
    },
  };
  const modeCalls = [];
  const voice = options.voice || {
    status: async () => ({
      enabled: true,
      configured: true,
      source: 'env-file',
      sourceLabel: '配置文件',
      asrModel: 'Qwen/Qwen3-ASR-1.7B',
      polishModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
      language: 'zh',
      maxSeconds: 60,
      polish: true,
    }),
    process: async ({ audioBase64, mode }) => ({
      transcript: '你好',
      text: '你好。',
      mode: mode || 'faithful',
      engine: 'siliconflow',
      empty: false,
      audioLength: audioBase64.length,
    }),
  };
  const optimizer = options.optimizer || {
    optimize: async ({ text, mode }) => ({ text: 'OPT(' + text + ')', mode: mode || 'faithful', model: 'deepseek-ai/DeepSeek-V4.1-Flash' }),
  };
  const ctx = {
    get(name) { return name === 'webServer' ? webServer : undefined; },
    effect(fn) { return fn(); },
  };
  const dispose = registerRoutes(ctx, {
    config: { ...DEFAULTS, maxPromptChars: 100 },
    voice,
    optimizer,
    getDefaultMode: () => options.defaultMode || 'faithful',
    setDefaultMode: async (mode) => {
      modeCalls.push(mode);
      return { mode, persisted: false, warning: '当前 profile 不支持写入配置；默认模式已在本次运行生效。' };
    },
    version: '1.4.0',
    log: () => {},
  });
  async function call(method, pathname, body, headers = {}) {
    const handler = registered.get(ROUTE_PREFIX + pathname);
    assert.ok(handler, 'route not registered: ' + pathname);
    const response = mockResponse();
    await handler(mockRequest(method, body, headers), response);
    return response;
  }
  return { registered, call, dispose, modeCalls };
}

test('GET status returns key state, models, modes, and the current default', async () => {
  const h = harness({ defaultMode: 'structure' });
  try {
    const response = await h.call('GET', '/status');
    assert.equal(response.statusCode, 200);
    const data = response.json().data;
    assert.equal(data.configured, true);
    assert.equal(data.defaultMode, 'structure');
    assert.deepEqual(data.modes, [
      { id: 'structure', label: '结构优化' },
      { id: 'faithful', label: '保真润色' },
    ]);
    assert.equal(data.version, '1.4.0');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(JSON.stringify(data).includes('sk-'), false);
  } finally {
    h.dispose();
  }
});

test('POST optimize forwards text and mode', async () => {
  const h = harness();
  try {
    const response = await h.call('POST', '/optimize', { text: '登录 500 修一下', mode: 'structure' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.text, 'OPT(登录 500 修一下)');
    assert.equal(response.json().data.mode, 'structure');
  } finally {
    h.dispose();
  }
});

test('POST voice/process forwards audio and mode', async () => {
  const h = harness();
  try {
    const response = await h.call('POST', '/voice/process', { audio: 'data:audio/wav;base64,AQID', mode: 'faithful' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.text, '你好。');
    assert.equal(response.json().data.audioLength, 'data:audio/wav;base64,AQID'.length);
  } finally {
    h.dispose();
  }
});

test('POST default-mode accepts only the two known modes', async () => {
  const h = harness();
  try {
    const ok = await h.call('POST', '/default-mode', { mode: '结构优化' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().data.mode, 'structure');
    assert.equal(ok.json().data.persisted, false);
    assert.equal(h.modeCalls[0], 'structure');

    const bad = await h.call('POST', '/default-mode', { mode: 'creative' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'MODE_INVALID');
  } finally {
    h.dispose();
  }
});

test('missing text, oversized text, and invalid JSON are rejected', async () => {
  const h = harness();
  try {
    const empty = await h.call('POST', '/optimize', { text: '   ' });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.code, 'TEXT_REQUIRED');

    const large = await h.call('POST', '/optimize', { text: 'x'.repeat(101) });
    assert.equal(large.statusCode, 413);
    assert.equal(large.json().error.code, 'TEXT_TOO_LARGE');

    const invalid = await h.call('POST', '/optimize', '{not json');
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'INVALID_JSON');
  } finally {
    h.dispose();
  }
});

test('method allow-lists and same-origin checks are enforced', async () => {
  const h = harness();
  try {
    const wrongMethod = await h.call('GET', '/optimize');
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.headers.allow, 'POST');

    const foreign = await h.call('GET', '/status', undefined, { origin: 'http://evil.example', host: '127.0.0.1:65001' });
    assert.equal(foreign.statusCode, 403);
    assert.equal(foreign.json().error.code, 'FOREIGN_ORIGIN');

    const same = await h.call('GET', '/status', undefined, { origin: 'http://127.0.0.1:65001', host: '127.0.0.1:65001' });
    assert.equal(same.statusCode, 200);
  } finally {
    h.dispose();
  }
});

test('there is no template or key-save route', () => {
  const h = harness();
  try {
    for (const path of ['/templates', '/voice/config', '/state', '/history']) {
      assert.equal(h.registered.has(ROUTE_PREFIX + path), false, path);
    }
  } finally {
    h.dispose();
  }
});
