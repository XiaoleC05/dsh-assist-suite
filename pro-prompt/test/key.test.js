import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULTS } from '../lib/config.js';
import { KeyResolver, parseEnvValue } from '../lib/key.js';

test('parseEnvValue handles export, quotes, comments, CRLF, and BOM', () => {
  const text = '\uFEFF# comment\r\nexport SILICONFLOW_API_KEY="sk-test-123"  # trailing\r\n';
  assert.equal(parseEnvValue(text, 'SILICONFLOW_API_KEY'), 'sk-test-123');
  assert.equal(parseEnvValue("SILICONFLOW_API_KEY='sk-single'\n", 'SILICONFLOW_API_KEY'), 'sk-single');
  assert.equal(parseEnvValue('SILICONFLOW_API_KEY=sk-plain # note\n', 'SILICONFLOW_API_KEY'), 'sk-plain');
  assert.equal(parseEnvValue('OTHER=1\n', 'SILICONFLOW_API_KEY'), '');
});

test('the resolver reads the env file and never exposes the key in status', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-prompt-key-'));
  const file = path.join(directory, '.env');
  await fs.writeFile(file, 'SILICONFLOW_API_KEY=sk-file-test-123456\n', 'utf8');
  try {
    const resolver = new KeyResolver({
      config: { ...DEFAULTS, apiKey: '', apiKeyEnvFile: file },
      home: directory,
      env: { SILICONFLOW_API_KEY: 'sk-env-test-123456' },
    });
    const resolved = await resolver.resolve();
    assert.equal(resolved.key, 'sk-file-test-123456');
    assert.equal(resolved.source, 'env-file');
    const status = await resolver.status();
    assert.equal(status.configured, true);
    assert.equal(status.source, 'env-file');
    assert.equal(status.sourceLabel, '配置文件');
    assert.equal(JSON.stringify(status).includes('sk-file-test'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an explicit config key wins, then the process env, then none', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-prompt-key-'));
  try {
    const fromConfig = new KeyResolver({
      config: { ...DEFAULTS, apiKey: 'sk-config-123456', apiKeyEnvFile: path.join(directory, 'missing.env') },
      home: directory,
      env: { SILICONFLOW_API_KEY: 'sk-env-123456' },
    });
    assert.deepEqual(await fromConfig.resolve(), { key: 'sk-config-123456', source: 'config' });

    const fromEnv = new KeyResolver({
      config: { ...DEFAULTS, apiKey: '', apiKeyEnvFile: path.join(directory, 'missing.env') },
      home: directory,
      env: { SILICONFLOW_API_KEY: ' sk-env-123456 ' },
    });
    assert.deepEqual(await fromEnv.resolve(), { key: 'sk-env-123456', source: 'env' });

    const none = new KeyResolver({
      config: { ...DEFAULTS, apiKey: '', apiKeyEnvFile: path.join(directory, 'missing.env') },
      home: directory,
      env: {},
    });
    assert.deepEqual(await none.resolve(), { key: '', source: 'none' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a JSON key file is accepted as a compatibility fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-prompt-key-'));
  const file = path.join(directory, 'voice.json');
  await fs.writeFile(file, JSON.stringify({ siliconflowApiKey: 'sk-json-123456' }), 'utf8');
  try {
    const resolver = new KeyResolver({
      config: { ...DEFAULTS, apiKey: '', apiKeyEnvFile: file },
      home: directory,
      env: {},
    });
    assert.deepEqual(await resolver.resolve(), { key: 'sk-json-123456', source: 'env-file' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
