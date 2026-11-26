import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { apply, resolveDshHome } from '../index.js';

function mockRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url: '/',
    headers: {},
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
  const edits = [];
  const ctx = {
    fiber: { entry: { id: 'pro-prompt' } },
    get(name) {
      if (name === 'webServer') return webServer;
      if (name === 'configEditor' && options.editor !== false) {
        return {
          async edit(entry, change) {
            edits.push({ entry, next: change({ enabled: true, defaultMode: 'faithful' }) });
          },
        };
      }
      return undefined;
    },
    effect(fn) { return fn(); },
    logger: { info() {}, warn() {}, error() {} },
  };
  async function call(method, pathname, body) {
    const handler = registered.get(pathname);
    assert.ok(handler, 'route not registered: ' + pathname);
    const response = mockResponse();
    await handler(mockRequest(method, body), response);
    return response;
  }
  return { registered, call, ctx, edits };
}

test('resolveDshHome prefers DSH_HOME and falls back to the home directory', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\tmp\\dsh-home' }, () => 'C:\\Users\\x'), 'D:\\tmp\\dsh-home');
  assert.equal(resolveDshHome({}, () => 'C:\\Users\\x'), path.join('C:\\Users\\x', '.dsh'));
});

test('apply registers only the pro-prompt routes and reads the reference .env', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-prompt-host-'));
  const envFile = path.join(home, '.env');
  await fs.writeFile(envFile, 'SILICONFLOW_API_KEY=sk-host-test-123456\n', 'utf8');
  try {
    const h = harness();
    await apply(h.ctx, {
      apiKeyEnvFile: envFile,
      defaultMode: 'structure',
    });
    assert.equal(h.registered.has('/pro-prompt/status'), true);
    assert.equal(h.registered.has('/pro-prompt/optimize'), true);
    assert.equal(h.registered.has('/pro-prompt/voice/process'), true);
    assert.equal(h.registered.has('/pro-prompt/default-mode'), true);
    assert.equal(h.registered.has('/prompt-studio/state'), false);
    assert.equal(h.registered.has('/pro-prompt/templates'), false);

    const status = await h.call('GET', '/pro-prompt/status');
    assert.equal(status.statusCode, 200);
    const data = status.json().data;
    assert.equal(data.configured, true);
    assert.equal(data.source, 'env-file');
    assert.equal(data.asrConfigured, true);
    assert.equal(data.defaultMode, 'structure');
    assert.equal(data.defaultPersisted, true);
    assert.equal(JSON.stringify(data).includes('sk-host-test'), false);

    await fs.access(path.join(home, 'storages')).then(
      () => assert.fail('the plugin must not create a storage directory'),
      () => {},
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('the default-mode route falls back to the current run when no config editor exists', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-prompt-host-'));
  const envFile = path.join(home, '.env');
  await fs.writeFile(envFile, 'SILICONFLOW_API_KEY=sk-host-test-123456\n', 'utf8');
  try {
    const h = harness({ editor: false });
    await apply(h.ctx, { apiKeyEnvFile: envFile });
    const response = await h.call('POST', '/pro-prompt/default-mode', { mode: 'structure' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.mode, 'structure');
    assert.equal(response.json().data.persisted, false);
    assert.match(response.json().data.warning, /本次运行/);
    const status = await h.call('GET', '/pro-prompt/status');
    assert.equal(status.json().data.defaultPersisted, false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('the default-mode route persists through the profile config editor when present', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-prompt-host-'));
  const envFile = path.join(home, '.env');
  await fs.writeFile(envFile, 'SILICONFLOW_API_KEY=sk-host-test-123456\n', 'utf8');
  try {
    const h = harness();
    await apply(h.ctx, { apiKeyEnvFile: envFile });
    const response = await h.call('POST', '/pro-prompt/default-mode', { mode: 'structure' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.persisted, true);
    assert.equal(h.edits.length, 1);
    assert.equal(h.edits[0].next.defaultMode, 'structure');
    assert.equal(h.edits[0].next.enabled, true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('a disabled plugin registers nothing', async () => {
  const h = harness();
  await apply(h.ctx, { enabled: false });
  assert.equal(h.registered.size, 0);
});
