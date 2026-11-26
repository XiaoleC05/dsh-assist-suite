// Confluence / 高级记忆 — end-to-end wiring test (v0.4: bus + long-term memory +
// user persona + style cards).
//
// Drives the real plugin modules through a fake Cordis context + fake host
// services (tools, systemPrompt, webServer, agents, sessionTitle, sessionQuery)
// with the real filesystem under a temp directory. Acceptance:
//
//   * activation registers 8 tools, 4 prompt contributions, 7 panel routes;
//   * the workspace bus still isolates workspaces (v0.3 behaviour);
//   * persona facts are global, injected, and editable from any workspace;
//   * long-term patterns are candidate-first, promotable, workspace-taggable;
//   * style cards render chat + engineering channels;
//   * confluence.memory/v1 export/import round-trips;
//   * v0.3 profile facts (tech/context) migrate once into long-term patterns;
//   * privacy.privateSessions opts a session out of every tool.
//
// Offline: no network, no DSH packages, Node builtins only.

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { applyWithDeps } from '../index.js'
import { GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import { resolveConfig } from '../lib/config.js'

/** @type {{dir: string, projectA: string, projectB: string, store: string}} */
const paths = { dir: '', projectA: '', projectB: '', store: '' }

/** @type {object | null} */
let services = null
/** @type {object} */
const captured = {
  tools: new Map(),
  routes: new Map(),
  prompts: new Map(),
  listeners: new Map(),
  disposers: [],
}
/** @type {object[]} */
const liveAgents = []

/** Fake Cordis context: captures registrations and provides fake host services. */
function createFakeCtx() {
  const host = {
    tools: {
      register(definition) {
        captured.tools.set(definition.name, definition)
        return () => captured.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      context(definition) {
        captured.prompts.set(definition.name, definition)
        return () => captured.prompts.delete(definition.name)
      },
      section() {
        return () => {}
      },
    },
    webServer: {
      getOrigin() {
        return 'http://127.0.0.1:0'
      },
      register(route) {
        captured.routes.set(route.path, route)
        return () => captured.routes.delete(route.path)
      },
    },
    agents: { list: () => [...liveAgents] },
    workingDirectory: { get: () => undefined },
    sessionQuery: {
      async listSessions() {
        return []
      },
      async readTitle(sessionId) {
        return { title: `title:${sessionId}` }
      },
      async filterEvents() {
        return []
      },
      async readEvent() {
        return { events: [] }
      },
    },
    sessionTitle: {
      get(session) {
        return { title: `title:${session && session.id}` }
      },
    },
    workspaceRegistry: { resolveByPath: async () => undefined },
  }
  const ctx = {
    get(name) {
      return host[name]
    },
    tools: host.tools,
    systemPrompt: host.systemPrompt,
    webServer: host.webServer,
    agents: host.agents,
    workingDirectory: host.workingDirectory,
    sessionQuery: host.sessionQuery,
    sessionTitle: host.sessionTitle,
    on(type, listener) {
      const list = captured.listeners.get(type) ?? []
      list.push(listener)
      captured.listeners.set(type, list)
      return () => {
        const current = captured.listeners.get(type) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(callback) {
      const disposer = callback()
      captured.disposers.push(() => {
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          // ignore
        }
      })
      return () => {}
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { ctx, host }
}

/** @param {string} id @param {string} [cwd] @returns {object} */
function fakeSession(id, cwd) {
  return {
    id,
    header: { id, cwd, isSeeded: false },
    snapshotEvents() {
      return []
    },
    seq: 0,
  }
}

/** @param {object} session @param {string} [id] @returns {object} */
function fakeAgent(session, id = session.id) {
  return { id, session, status: 'idle' }
}

/** @param {string} type @param {...any} args */
function emit(type, ...args) {
  for (const listener of captured.listeners.get(type) ?? []) {
    try {
      listener(...args)
    } catch {
      // Event listeners must not break the test flow.
    }
  }
}

/** @param {string} name @returns {object} */
function tool(name) {
  const definition = captured.tools.get(name)
  assert.ok(definition, `tool ${name} was registered`)
  return definition
}

/** @param {string} name @param {object} agent @param {object} args */
async function exec(name, agent, args) {
  return await tool(name).execute(args, {
    agent,
    callId: `call-${Math.random()}`,
    signal: AbortSignal.timeout(5000),
    deferContext() {},
    concludeTurn() {},
  })
}

/** @param {string} promptName @param {object} agent @returns {string} */
function promptText(promptName, agent) {
  const definition = captured.prompts.get(promptName)
  assert.ok(definition, `prompt ${promptName} was registered`)
  return definition.text({ agent })
}

/** Seed one v0.3 profile record with a legacy non-persona section. */
async function seedLegacyProfile() {
  const config = resolveConfig({ store: { dir: paths.store } }).config
  const deps = { now: () => Date.now(), random: Math.random, pid: 12345 }
  const store = new JournalStore({ config, logger: null, deps })
  await store.init()
  const journal = await store.openGlobal()
  await journal.append({
    v: 1,
    type: 'profile',
    id: 'prf_01JBQ8Z4K7F1G2H3J4K5M6N7P8',
    ws: GLOBAL_SCOPE_KEY,
    section: 'tech',
    key: 'project',
    value: 'Legacy project fact from v0.3',
    confidence: 0.8,
    source: 'agent',
    author: { sessionId: 'session-legacy', title: 'Legacy session' },
    ts: '2026-01-01T00:00:00.000Z',
  })
  await journal.append({
    v: 1,
    type: 'profile',
    id: 'prf_01JBQ8Z4K7F1G2H3J4K5M6N7P9',
    ws: GLOBAL_SCOPE_KEY,
    section: 'context',
    key: 'environment',
    value: 'Legacy environment fact from v0.3',
    confidence: 0.7,
    source: 'agent',
    author: { sessionId: 'session-legacy', title: 'Legacy session' },
    ts: '2026-01-01T00:00:01.000Z',
  })
  await store.close()
}

/** @param {string} id @param {string} [cwd] @returns {object} */
async function readyAgent(id, cwd) {
  const agent = fakeAgent(fakeSession(id, cwd))
  liveAgents.push(agent)
  emit('agent/created', { agent })
  await services.services.facade.ensureReady(agent)
  await services.services.presence.writeHeartbeat()
  await services.services.presence.refreshPresence()
  return agent
}

before(async () => {
  paths.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-v04-'))
  paths.projectA = path.join(paths.dir, 'project-a')
  paths.projectB = path.join(paths.dir, 'project-b')
  paths.store = path.join(paths.dir, 'store')
  await fs.mkdir(paths.projectA, { recursive: true })
  await fs.mkdir(paths.projectB, { recursive: true })

  await seedLegacyProfile()

  const { ctx } = createFakeCtx()
  services = await applyWithDeps(
    ctx,
    { store: { dir: paths.store, pollMs: 4000 }, privacy: { privateSessions: ['session-private'] } },
    {},
  )
})

after(async () => {
  try {
    if (services && typeof services.disposeAsync === 'function') {
      await Promise.race([services.disposeAsync(), new Promise((resolve) => setTimeout(resolve, 3000))])
    }
  } catch {
    // Teardown is best-effort.
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  try {
    if (paths.dir !== '') await fs.rm(paths.dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup.
  }
})

test('INT-V4-01 activation registers 8 tools, 4 prompt contributions and 7 panel routes', () => {
  assert.deepEqual(
    [...captured.tools.keys()],
    ['confluence_board', 'confluence_context', 'confluence_send', 'confluence_inbox', 'confluence_profile', 'confluence_memory', 'confluence_style', 'confluence_recall'],
  )
  assert.deepEqual([...captured.prompts.keys()].sort(), [
    'confluence:memory',
    'confluence:profile',
    'confluence:pulse',
    'confluence:style',
  ])
  for (const definition of captured.prompts.values()) {
    assert.equal(definition.required, false)
    assert.equal(definition.interpolate, false)
    assert.equal(typeof definition.text, 'function')
  }
  assert.deepEqual([...captured.routes.keys()].sort(), [
    '/confluence/panel/bus',
    '/confluence/panel/entry',
    '/confluence/panel/memory',
    '/confluence/panel/ping',
    '/confluence/panel/profile',
    '/confluence/panel/profile/export',
    '/confluence/panel/workspaces',
  ])
  assert.equal(services.globalScopeKey, GLOBAL_SCOPE_KEY)
})

test('INT-V4-02 the workspace bus still isolates workspaces', async () => {
  const agentA = await readyAgent('session-a', paths.projectA)
  const agentB = await readyAgent('session-b', paths.projectB)
  const posted = await exec('confluence_board', agentA, {
    action: 'post',
    kind: 'gotcha',
    title: 'Bus note A',
    body: 'Only project-a sees this.',
  })
  assert.match(posted.entry.id, /^cnf_/)
  const boardB = await exec('confluence_board', agentB, { action: 'list', limit: 5 })
  assert.ok(!boardB.entries.some((row) => row.title === 'Bus note A'), 'workspace B must not see A notes')
  const boardA = await exec('confluence_board', agentA, { action: 'list', limit: 5 })
  assert.ok(boardA.entries.some((row) => row.title === 'Bus note A'))
})

test('INT-V4-03 persona is global, injected and editable from any workspace', async () => {
  const agentA = await readyAgent('session-a2', paths.projectA)
  const agentB = await readyAgent('session-b2', paths.projectB)
  const set = await exec('confluence_profile', agentA, {
    action: 'set',
    facts: [
      { section: 'communication', key: 'lang', value: '中文', confidence: 0.9 },
      { section: 'personality', key: 'style', value: '直接、少寒暄', confidence: 0.8 },
    ],
  })
  assert.equal(set.count, 2)
  const personaA = promptText('confluence:profile', agentA)
  assert.match(personaA, /<confluence-profile /)
  assert.match(personaA, /communication: lang=中文/)
  const personaB = promptText('confluence:profile', agentB)
  assert.equal(personaB, personaA, 'the same persona block is injected in another workspace')
  const listB = await exec('confluence_profile', agentB, { action: 'list' })
  assert.ok(listB.facts.some((fact) => fact.key === 'style'), 'another workspace can read the persona')
})

test('INT-V4-04 long-term patterns are candidate-first, promotable and workspace-taggable', async () => {
  const agentA = await readyAgent('session-a3', paths.projectA)
  const agentB = await readyAgent('session-b3', paths.projectB)

  const added = await exec('confluence_memory', agentA, {
    action: 'add',
    category: 'pitfall',
    key: 'windows.path-rename-retry',
    title: 'Windows 路径重命名要重试',
    body: 'rename 可能因占用返回 EPERM，需要重试。',
    tags: ['windows', 'fs'],
    confidence: 0.7,
  })
  assert.equal(added.pattern.status, 'candidate')
  const candidateBlock = promptText('confluence:memory', agentA)
  assert.match(candidateBlock, /candidates="1"/)
  assert.match(candidateBlock, /confirm with confluence_memory promote/)
  assert.ok(!/^- \[pitfall\] Windows 路径重命名要重试/m.test(candidateBlock), 'candidates are not injected as rule lines')

  const promoted = await exec('confluence_memory', agentA, { action: 'promote', key: 'windows.path-rename-retry' })
  assert.equal(promoted.pattern.status, 'active')
  const activeBlockA = promptText('confluence:memory', agentA)
  assert.match(activeBlockA, /\[pitfall\] Windows 路径重命名要重试/)

  const workspacePattern = await exec('confluence_memory', agentA, {
    action: 'add',
    category: 'project',
    key: 'project-a.convention',
    title: 'A 工作区专属约定',
    body: '仅 A 工作区生效。',
    scope: 'workspace',
  })
  assert.equal(workspacePattern.pattern.scope, 'workspace')
  await exec('confluence_memory', agentA, { action: 'promote', key: 'project-a.convention' })
  const scopedA = promptText('confluence:memory', agentA)
  assert.match(scopedA, /A 工作区专属约定/, 'workspace-scoped pattern is injected in its workspace')
  const scopedB = promptText('confluence:memory', agentB)
  assert.ok(!scopedB.includes('A 工作区专属约定'), 'workspace-scoped pattern is not injected elsewhere')
  assert.match(scopedB, /\[pitfall\] Windows 路径重命名要重试/, 'global patterns reach every workspace')
})

test('INT-V4-05 style cards render both channels', async () => {
  const agent = await readyAgent('session-a4', paths.projectA)
  await exec('confluence_style', agent, {
    action: 'set',
    channel: 'chat',
    area: 'tone',
    key: 'chat.tone',
    title: '回答先结论',
    rule: '先给结论，再展开；少寒暄，不用"好问题"。',
    priority: 80,
  })
  await exec('confluence_style', agent, {
    action: 'set',
    channel: 'engineering',
    area: 'commit',
    key: 'commit.zh',
    title: '提交信息规范',
    rule: 'commit 用中文，首行动词开头，不超过 60 字。',
    examples: [{ bad: 'update code', good: '修复面板路由未注册' }],
    priority: 70,
  })
  const block = promptText('confluence:style', agent)
  assert.match(block, /<confluence-style chat="\d+" engineering="\d+">/)
  assert.match(block, /chat:/)
  assert.match(block, /engineering:/)
  assert.match(block, /先给结论/)
  assert.match(block, /commit 用中文/)
})

test('INT-V4-06 memory export/import round-trips through the tools', async () => {
  const agent = await readyAgent('session-a5', paths.projectA)
  const exported = await exec('confluence_memory', agent, { action: 'export' })
  assert.equal(exported.exported.format, 'json')
  const doc = JSON.parse(exported.exported.text)
  assert.equal(doc.format, 'confluence.memory/v1')
  assert.ok(doc.counts.persona >= 2)
  assert.ok(doc.counts.patterns >= 2)
  assert.ok(doc.counts.styles >= 2)

  const before = await exec('confluence_memory', agent, { action: 'list', status: 'all' })
  const imported = await exec('confluence_memory', agent, { action: 'import', data: exported.exported.text, mode: 'merge' })
  assert.equal(imported.imported.mode, 'merge')
  assert.ok(imported.imported.count >= 1)
  const afterList = await exec('confluence_memory', agent, { action: 'list', status: 'all' })
  assert.ok(afterList.patterns.length >= before.patterns.length, 'merge never loses patterns')
  // Tool rows deliberately omit workspaceKey; check the storage-facing facade
  // shape (the portability document must preserve the workspace target).
  const facadeListed = await services.services.facade.memory(agent, { action: 'list', status: 'all' })
  const scoped = facadeListed.patterns.find((pattern) => pattern.key === 'project-a.convention')
  assert.ok(scoped, 'workspace-scoped pattern survives the round-trip')
  assert.equal(scoped.scope, 'workspace', 'the imported pattern keeps its workspace scope')
  assert.match(scoped.workspaceKey ?? '', /^ws_[0-9a-f]{16}$/, 'the workspace key is restored from the document')
})

test('INT-V4-07 v0.3 profile facts migrate once into long-term patterns', async () => {
  const agent = await readyAgent('session-a6', paths.projectA)
  const listed = await exec('confluence_memory', agent, { action: 'list', status: 'all', limit: 100 })
  const project = listed.patterns.find((pattern) => pattern.title === 'project')
  const environment = listed.patterns.find((pattern) => pattern.title === 'environment')
  assert.ok(project, 'tech profile fact migrated to a project pattern')
  assert.equal(project.category, 'project')
  // The export/import test may have re-imported the migrated pattern (source "import");
  // what proves the migration is the legacy body and the project category.
  assert.ok(['migration', 'import'].includes(project.source), 'migration provenance is preserved')
  assert.match(project.body, /Legacy project fact from v0\.3/)
  assert.ok(environment, 'context profile fact migrated to a domain pattern')
  assert.equal(environment.category, 'domain')
  const persona = promptText('confluence:profile', agent)
  assert.ok(!persona.includes('Legacy project fact'), 'non-persona facts must not render as persona')
})

test('INT-V4-08 panel serves memory patterns, persona + styles and the memory export', async () => {
  const memoryRoute = captured.routes.get('/confluence/panel/memory')
  const memory = await callRoute(memoryRoute, '/confluence/panel/memory')
  assert.equal(memory.ok, true)
  assert.ok(Array.isArray(memory.patterns))
  assert.ok(Array.isArray(memory.candidates))
  assert.ok(memory.patterns.some((pattern) => pattern.key === 'windows.path-rename-retry'))
  assert.ok(memory.patterns.some((pattern) => pattern.key === 'project-a.convention'), 'promoted pattern was injected as active')
  assert.ok(!memory.candidates.some((pattern) => pattern.key === 'project-a.convention'), 'promoted pattern is no longer a candidate')

  const profileRoute = captured.routes.get('/confluence/panel/profile')
  const profile = await callRoute(profileRoute, '/confluence/panel/profile')
  assert.equal(profile.ok, true)
  assert.ok(profile.sections.some((section) => section.id === 'communication'))
  assert.ok(Array.isArray(profile.styles))
  assert.ok(profile.styles.some((style) => style.channel === 'chat'))
  assert.ok(profile.styles.some((style) => style.channel === 'engineering'))

  const exportRoute = captured.routes.get('/confluence/panel/profile/export')
  const exported = await callRouteRaw(exportRoute, '/confluence/panel/profile/export?format=json')
  assert.equal(exported.status, 200)
  assert.match(exported.headers['content-disposition'], /attachment/)
  assert.equal(JSON.parse(exported.body).format, 'confluence.memory/v1')
})

test('INT-V4-09 privacy.privateSessions opts a session out of every tool', async () => {
  const privateAgent = fakeAgent(fakeSession('session-private', paths.projectA))
  liveAgents.push(privateAgent)
  emit('agent/created', { agent: privateAgent })
  await services.services.facade.ensureReady(privateAgent).catch(() => {})

  const calls = [
    ['confluence_board', { action: 'list', limit: 5 }],
    ['confluence_context', { action: 'list' }],
    ['confluence_send', { to: '*', kind: 'notice', body: 'nope' }],
    ['confluence_inbox', { limit: 5 }],
    ['confluence_profile', { action: 'list' }],
    ['confluence_memory', { action: 'list' }],
    ['confluence_style', { action: 'list' }],
    ['confluence_recall', { query: 'anything' }],
  ]
  for (const [name, args] of calls) {
    await assert.rejects(
      () => exec(name, privateAgent, args),
      (error) => error && error.code === 'UNAVAILABLE',
      `${name} must be disabled`,
    )
  }
  assert.equal(promptText('confluence:memory', privateAgent), '', 'no memory block for a private session')
  assert.equal(promptText('confluence:profile', privateAgent), '', 'no persona block for a private session')
  assert.equal(promptText('confluence:style', privateAgent), '', 'no style block for a private session')
  assert.equal(promptText('confluence:pulse', privateAgent), '', 'no workspace pulse for a private session')
})

// ── fake HTTP route invocation ───────────────────────────────────────────

/** @param {{handler: Function}} route @param {string} url @returns {Promise<any>} */
async function callRoute(route, url) {
  const response = await callRouteRaw(route, url)
  return JSON.parse(response.body)
}

/**
 * @param {{handler: Function}} route
 * @param {string} url
 * @returns {Promise<{status: number, headers: Record<string,string>, body: string}>}
 */
async function callRouteRaw(route, url) {
  const parsed = new URL(url, 'http://127.0.0.1')
  const req = {
    method: 'GET',
    url: `${parsed.pathname}${parsed.search}`,
    headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const chunks = []
  const headers = {}
  let statusCode = 200
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(value) {
      statusCode = value
    },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value)
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body))
    },
    write(body) {
      chunks.push(Buffer.from(body))
    },
  }
  await route.handler(req, res)
  return { status: statusCode, headers, body: Buffer.concat(chunks).toString('utf8') }
}
