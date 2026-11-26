import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_CONSTRAINTS as HOST_CONSTRAINTS } from '../lib/prompts.js';

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { captured = definition; },
  },
  isSecureContext: true,
  localStorage: { removeItem() {} },
};
await import('../client.js');

const ReactStub = { Fragment: Symbol('Fragment'), createElement() { return null; } };
const ReactDomStub = { createPortal() { return null; } };
const plugin = captured.factory(function requireStub(name) {
  if (name === 'react') return ReactStub;
  if (name === 'react-dom') return ReactDomStub;
  throw new Error('unexpected module: ' + name);
});
const browser = plugin.__test;

test('the browser half is named pro-prompt and exposes Chinese copy', () => {
  assert.equal(captured.id, 'pro-prompt');
  assert.equal(browser.STRINGS.panelTitle, '输入增强');
  assert.equal(browser.STRINGS.tabGuideTitle, '输入增强');
  assert.equal(browser.MODES[0].name, '结构优化');
  assert.equal(browser.MODES[1].name, '保真润色');
  assert.equal(browser.AGENT_CONSTRAINTS.length, 9);
  assert.deepEqual(
    browser.AGENT_CONSTRAINTS.map(function (item) { return item[0]; }),
    HOST_CONSTRAINTS.map(function (item) { return item.title; }),
    'client and host constraint titles must stay in sync',
  );
});

test('encodeWav emits a canonical 16 kHz mono PCM16 header', () => {
  const wav = browser.encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000);
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 44 + 8);
  assert.equal(String.fromCharCode(...new Uint8Array(wav, 0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...new Uint8Array(wav, 8, 4)), 'WAVE');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
});

test('formatElapsed renders a compact timer', () => {
  assert.equal(browser.formatElapsed(0), '0:00');
  assert.equal(browser.formatElapsed(65_400), '1:05');
});

test('applyComposerText replaces, inserts at the cursor, and falls back to appending', () => {
  const replaced = [];
  assert.equal(browser.applyComposerText({ setDraft(value) { replaced.push(value); } }, 'old', 'new prompt', 'replace'), true);
  assert.deepEqual(replaced, ['new prompt']);

  const inserted = [];
  const cursorActions = {
    setDraft(value) { inserted.push(value); },
    captureInsertion() { return { start: 2, end: 2 }; },
    insertText(text, span) { inserted.push(text + '@' + span.start); return true; },
  };
  assert.equal(browser.applyComposerText(cursorActions, 'old', 'voice', 'insert'), true);
  assert.deepEqual(inserted, ['voice@2']);

  const appended = [];
  assert.equal(browser.applyComposerText({ setDraft(value) { appended.push(value); } }, 'old', 'voice', 'insert'), true);
  assert.deepEqual(appended, ['old\n\nvoice']);
  assert.equal(browser.applyComposerText(null, 'old', 'x', 'insert'), false);

  const busy = {
    setDraft() {},
    captureInsertion() { return { start: 0, end: 0 }; },
    insertText() { return false; },
  };
  assert.equal(browser.applyComposerText(busy, 'old', 'voice', 'insert'), false);
  assert.equal(browser.applyComposerText(busy, 'old', 'voice', 'replace'), true);
});

test('the studio loads the server default mode and only treats explicit changes as touched', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const body = String(url).endsWith('/status')
      ? { ok: true, data: { configured: true, defaultMode: 'structure', asrConfigured: true, asrModel: 'Qwen/Qwen3-ASR-1.7B', asrProvider: 'SiliconFlow', asrSource: 'config', asrSourceLabel: 'SiliconFlow', polishModel: 'deepseek-ai/DeepSeek-V4.1-Flash', language: 'zh', maxSeconds: 60, sourceLabel: 'SiliconFlow' } }
      : { ok: true, data: { mode: 'faithful', persisted: true } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const studio = browser.createStudio({ openSidebar: () => ({ ok: true }) });
  await studio.ensureLoaded();
  let state = studio.getSnapshot();
  assert.equal(state.status, 'ready');
  assert.equal(state.server.configured, true);
  assert.equal(state.server.asrConfigured, true);
  assert.equal(state.server.asrModel, 'Qwen/Qwen3-ASR-1.7B');
  assert.equal(state.server.asrProvider, 'SiliconFlow');
  assert.equal(state.server.defaultMode, 'structure');
  assert.equal(state.mode, 'structure');

  studio.setMode('faithful');
  state = studio.getSnapshot();
  assert.equal(state.mode, 'faithful');

  const saved = await studio.setDefaultMode('faithful');
  assert.equal(saved.persisted, true);
  state = studio.getSnapshot();
  assert.equal(state.defaultMode, 'faithful');
  assert.equal(state.server.defaultMode, 'faithful');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[1].options.method, 'POST');
  assert.match(String(calls[1].options.body), /faithful/);
});

test('apply registers the left-sidebar entry, main page, right tab, and composer controls without throwing', async () => {
  globalThis.document = {
    querySelector() { return null; },
    createElement() { return { dataset: {}, textContent: '' }; },
    head: { appendChild() {} },
  };
  const tabs = [];
  const registrations = [];
  const injections = [];
  const ctx = {
    locale: { register() {}, bind() { return function () { return undefined; }; } },
    slots: {
      inject(key, callback) {
        injections.push(key);
        const result = callback();
        // The main-area slot takes a generator so it can yield one or more
        // registrations; drain it the way the client slot runtime does.
        if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
          let step = result.next();
          while (step.done !== true) step = result.next();
        }
        return result;
      },
      register(definition, component) {
        registrations.push({ definition, component });
        return function () {};
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabs.push(definition);
        return function () {};
      },
    },
    sidebarRight: { openTabIn() {}, openTab() {} },
    effect(callback) { return callback(); },
  };
  await plugin.apply(ctx);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 'pro-prompt');
  assert.equal(tabs[0].kind, 'proPrompt');
  assert.equal(tabs[0].title(), '增强');
  assert.deepEqual(injections, ['sidebar.panellist', 'main', 'sidebar.right.pane.tab', 'conversation.input.left']);
  assert.equal(registrations.length, 4);
  assert.equal(registrations[0].definition.name, 'sidebar.panellist');
  assert.equal(registrations[0].definition.id, 'pro-prompt');
  assert.equal(registrations[0].definition.order, 35);
  assert.equal(typeof registrations[0].definition.label, 'function');
  assert.equal(registrations[1].definition.name, 'main');
  assert.equal(registrations[1].definition.key, 'pro-prompt');
  assert.equal(typeof registrations[1].definition.inject, 'function');
  assert.equal(registrations[2].definition.key, 'pro-prompt');
  assert.equal(registrations[3].definition.id, 'pro-prompt');
  assert.equal(registrations[3].definition.order, 20);
});

test('apply registers the left sidebar and main page without the right-tab service', async () => {
  globalThis.document = {
    querySelector() { return null; },
    createElement() { return { dataset: {}, textContent: '' }; },
    head: { appendChild() {} },
  };
  const registrations = [];
  const injections = [];
  const ctx = {
    locale: { register() {}, bind() { return function () { return undefined; }; } },
    slots: {
      inject(key, callback) {
        injections.push(key);
        const result = callback();
        if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
          let step = result.next();
          while (step.done !== true) step = result.next();
        }
        return result;
      },
      register(definition, component) {
        registrations.push({ definition, component });
        return function () {};
      },
    },
    get() { throw new Error('service not injected'); },
    effect(callback) { return callback(); },
  };
  await plugin.apply(ctx);
  assert.deepEqual(injections, ['sidebar.panellist', 'main', 'conversation.input.left']);
  assert.equal(registrations.length, 3);
  assert.equal(registrations[0].definition.name, 'sidebar.panellist');
  assert.equal(registrations[0].definition.id, 'pro-prompt');
  assert.equal(registrations[1].definition.name, 'main');
  assert.equal(registrations[1].definition.key, 'pro-prompt');
  assert.equal(registrations[2].definition.name, 'conversation.input.left');
  assert.equal(registrations[2].definition.id, 'pro-prompt');
  assert.equal(registrations[2].definition.order, 20);
});
