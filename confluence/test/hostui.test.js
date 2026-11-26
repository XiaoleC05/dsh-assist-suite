// Confluence / 高级记忆 — v0.4.0 tests: Web panel Host routes (lib/hostui.js) and the
// Web panel client half (client.js): workspace bus view + long-term memory view +
// persona/style-card user profile view.
// Dependency-free: node:test + node:assert/strict + node:vm.
//
// Coverage:
//   HOSTUI-01..40  registration, seven read-only routes, guards (method/same-origin/
//                  connection fence/HEAD), payload shapes and allow-lists for
//                  workspaces/bus/entry/profile/memory/profile-export, persona
//                  section aliases, style cards + example excerpts, candidate queue,
//                  provenance/path/session-id scrubbing, caps and 64 KiB degradation,
//                  facade method set, no-body leakage, error mapping
//   UI-01..14      client ModuleLoader contract, three-tab page, single fetch, static
//                  read-only/offline scan, three-way locale parity, locale coverage,
//                  and seeded pure renders of the list/bus/memory/profile/error/empty
//                  states
//
// Run from the repository root: node --test --test-force-exit "test/hostui.test.js"

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  HOSTUI_PREFIX,
  MAX_RESPONSE_BYTES,
  PANEL_SCOPE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  hostuiInternals,
  registerHostUi,
} from '../lib/hostui.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_PATH = path.join(ROOT, 'client.js')
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const EN_LOCALE = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
const ZH_LOCALE = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))

const ROUTE_PATHS = {
  ping: `${HOSTUI_PREFIX}/ping`,
  workspaces: `${HOSTUI_PREFIX}/workspaces`,
  bus: `${HOSTUI_PREFIX}/bus`,
  entry: `${HOSTUI_PREFIX}/entry`,
  profile: `${HOSTUI_PREFIX}/profile`,
  memory: `${HOSTUI_PREFIX}/memory`,
  'profile-export': `${HOSTUI_PREFIX}/profile/export`,
}
const ROUTE_NAMES = ['ping', 'workspaces', 'bus', 'entry', 'profile', 'memory', 'profile-export']
const DATA_ROUTE_NAMES = ROUTE_NAMES.filter((name) => name !== 'ping')
const WS_KEY = 'ws_0123456789abcdef'
const OTHER_WS = 'ws_fedcba9876543210'
const ENTRY_ID = 'cnf_01JBQ8Z4K1H9T2R6N4X7C0W8FD'
const MSG_ID = 'msg_01JBQ8Z4K1H9T2R6N4X7C0W8FD'
const FACT_ID = 'prf_01JBQ8Z4K1H9T2R6N4X7C0W8FD'
const ISO_TS = '2026-11-13T03:55:00.000Z'
const PATTERN_KEY = 'windows.path-rename-retry'
const CANDIDATE_KEY = 'server.error-envelope'
const STYLE_KEY = 'commit.zh-conventional'

// ---------------------------------------------------------------------------
// fake Host environment
// ---------------------------------------------------------------------------

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value)
    },
    end(chunk) {
      this.ended = true
      if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
  }
}

function createReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers }
}

function createWebServer() {
  const routes = new Map()
  return {
    routes,
    register({ kind, path: routePath, handler }) {
      assert.equal(kind, 'exact')
      assert.equal(typeof handler, 'function')
      assert.equal(routes.has(routePath), false, `duplicate route ${routePath}`)
      routes.set(routePath, handler)
      return () => routes.delete(routePath)
    },
    getOrigin() {
      return 'http://127.0.0.1:53074'
    },
  }
}

function createLogger() {
  const lines = []
  const record = (level) => (...args) => lines.push({ level, args })
  return { lines, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
}

function createCtx({ webServer, connection, logger } = {}) {
  const effects = []
  const ctx = {
    webServer,
    effects,
    logger: logger ?? createLogger(),
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
    effect(fn, label) {
      effects.push(label)
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  return ctx
}

function emptyBus(requested) {
  return {
    workspace: { id: requested.ws, label: 'demo' },
    context: [],
    entries: [],
    messages: [],
    peers: [],
    stats: { context: 0, entries: 0, messages: 0, peers: 0 },
    truncated: false,
  }
}

/** Fake facade exposing only the six read-only panel methods + forbidden traps. */
function createFacade(data = {}) {
  const calls = []
  const has = (key) => Object.prototype.hasOwnProperty.call(data, key)
  const facade = {
    calls,
    async panelWorkspaces() {
      calls.push(['panelWorkspaces'])
      return has('panelWorkspaces') ? data.panelWorkspaces : { profile: { label: 'All sessions' }, workspaces: [], truncated: false }
    },
    async panelBus(requested) {
      calls.push(['panelBus', requested])
      return has('panelBus') ? data.panelBus : emptyBus(requested)
    },
    async panelEntry(requested) {
      calls.push(['panelEntry', requested])
      return has('panelEntry') ? data.panelEntry : null
    },
    async panelProfile() {
      calls.push(['panelProfile'])
      return has('panelProfile')
        ? data.panelProfile
        : { revision: '', sections: [], styles: [], stats: { sections: 0, facts: 0, styles: 0 }, truncated: false }
    },
    async panelMemory() {
      calls.push(['panelMemory'])
      return has('panelMemory')
        ? data.panelMemory
        : { revision: '', patterns: [], candidates: [], stats: { total: 0, active: 0, candidates: 0 }, truncated: false }
    },
    async panelProfileExport(requested) {
      calls.push(['panelProfileExport', requested])
      return has('panelProfileExport')
        ? data.panelProfileExport
        : { format: requested.format, text: requested.format === 'json' ? '{"format":"confluence.memory/v1"}' : '# memory' }
    },
  }
  // v0.2 / write surface that the read-only panel must never call.
  for (const method of [
    'overview', 'entry', 'board', 'context', 'send', 'inbox', 'profile', 'memory', 'style',
    'post', 'set', 'delete', 'listWorkspaces',
  ]) {
    facade[method] = (...args) => {
      calls.push([method, ...args])
      throw new Error('forbidden facade method called: ' + method)
    }
  }
  return facade
}

function routeHandler(webServer, routePath) {
  const handler = webServer.routes.get(routePath)
  assert.equal(typeof handler, 'function', `route not registered: ${routePath}`)
  return handler
}

async function invoke(webServer, routePath, { method = 'GET', headers = {}, query } = {}) {
  const handler = routeHandler(webServer, routePath)
  const search = query === undefined ? '' : new URLSearchParams(query).toString()
  const req = createReq({ method, url: routePath + (search === '' ? '' : '?' + search), headers })
  const res = createRes()
  await handler(req, res)
  const contentType = res.headers['content-type'] ?? ''
  const json = contentType.startsWith('application/json') && res.body !== '' ? JSON.parse(res.body) : null
  return { res, json }
}

function mount(data, { connection, logger, config, facade } = {}) {
  const webServer = createWebServer()
  const ctx = createCtx({ webServer, connection, logger })
  const usedFacade = facade ?? createFacade(data)
  const dispose = registerHostUi(ctx, {
    facade: usedFacade,
    config: config ?? { ui: { enabled: true } },
    logger: logger ?? ctx.logger,
  })
  return { webServer, ctx, facade: usedFacade, dispose }
}

function summaryKeys(entry) {
  return Object.keys(entry).sort()
}

function makeEntryId(index) {
  return `cnf_${String(index).padStart(26, '0')}`
}

function makeMsgId(index) {
  return `msg_${String(index).padStart(26, '0')}`
}

function makeFactId(index) {
  return `prf_${String(index).padStart(26, '0')}`
}

function makeWsId(index) {
  return 'ws_' + index.toString(16).padStart(16, '0')
}

function bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** One long-term memory pattern row as the facade may hand it back. */
function makePattern(overrides = {}) {
  return {
    key: PATTERN_KEY,
    category: 'workflow',
    title: 'Windows path rename needs a retry',
    body: 'A rename over an existing path retries once on Windows.',
    tags: ['windows', 'fs'],
    scope: 'global',
    workspaceLabel: '',
    status: 'active',
    confidence: 0.8,
    source: 'agent',
    ts: ISO_TS,
    ...overrides,
  }
}

/** One style card row as the facade may hand it back. */
function makeStyle(overrides = {}) {
  return {
    channel: 'chat',
    area: 'tone',
    key: STYLE_KEY,
    title: 'Chinese conventional commit style',
    rule: 'Use conventional commit prefixes in Chinese.',
    examples: [{ bad: 'fix stuff', good: 'fix(panel): render memory tab' }],
    enabled: true,
    priority: 60,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// HOSTUI: registration and guards
// ---------------------------------------------------------------------------

test('HOSTUI-01 registerHostUi returns a no-op disposer when webServer is absent', () => {
  const ctx = createCtx({ webServer: undefined })
  const facade = createFacade()
  const dispose = registerHostUi(ctx, { facade, config: { ui: { enabled: true } }, logger: ctx.logger })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
  assert.doesNotThrow(() => dispose())
  assert.deepEqual(ctx.effects, [])
  assert.equal(ctx.logger.lines.some((line) => line.level === 'debug'), true)
})

test('HOSTUI-01b registration waits for a late webServer service (cold-start race)', () => {
  const webServer = createWebServer()
  let injectCallback = null
  const ctx = {
    logger: createLogger(),
    get() {
      return undefined
    },
    effect(fn) {
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      injectCallback = callback
    },
  }
  const dispose = registerHostUi(ctx, {
    facade: createFacade(),
    config: { ui: { enabled: true } },
    logger: ctx.logger,
  })
  assert.equal(typeof dispose, 'function')
  assert.equal(webServer.routes.size, 0, 'nothing may be registered before the service exists')
  assert.equal(typeof injectCallback, 'function', 'the optional service must be awaited')
  // The web-runtime row activates later; the inject callback registers then.
  const childCtx = {
    webServer,
    logger: ctx.logger,
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    effect(fn) {
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  injectCallback(childCtx)
  assert.equal(webServer.routes.size, 7, 'all seven panel routes register once the service appears')
  dispose()
  assert.equal(webServer.routes.size, 0, 'the disposer removes every route')
})

test('HOSTUI-02 registerHostUi returns a no-op without a facade', () => {
  const webServer = createWebServer()
  const ctx = createCtx({ webServer })
  const dispose = registerHostUi(ctx, { config: { ui: { enabled: true } }, logger: ctx.logger })
  assert.equal(typeof dispose, 'function')
  assert.equal(webServer.routes.size, 0)
  dispose()
})

test('HOSTUI-03 registerHostUi mounts nothing when ui.enabled is false', () => {
  const mounted = mount({}, { config: { ui: { enabled: false } } })
  assert.equal(mounted.webServer.routes.size, 0)
  assert.doesNotThrow(() => mounted.dispose())
})

test('HOSTUI-04 registers exactly the seven read-only routes and disposes them idempotently', () => {
  const mounted = mount({})
  assert.deepEqual([...mounted.webServer.routes.keys()].sort(), Object.values(ROUTE_PATHS).sort())
  assert.equal(mounted.ctx.effects.length, 7)
  assert.deepEqual(hostuiInternals.ROUTES.map((route) => route.name), ROUTE_NAMES)
  assert.deepEqual(
    hostuiInternals.ROUTES.map((route) => route.path),
    ROUTE_NAMES.map((name) => ROUTE_PATHS[name]),
  )
  assert.equal(hostuiInternals.ROUTES.length, 7)
  assert.equal(hostuiInternals.ROUTES.some((route) => route.name === 'overview'), false, 'the v0.2 overview route must be gone')
  assert.equal(hostuiInternals.ROUTES.some((route) => route.name === 'memory'), true, 'v0.4 adds the long-term memory route')
  assert.equal(hostuiInternals.ROUTES.every((route) => typeof route.run === 'function'), true)
  mounted.dispose()
  assert.equal(mounted.webServer.routes.size, 0)
  assert.doesNotThrow(() => mounted.dispose())
})

test('HOSTUI-05 ping keeps its fixed shape, no-store JSON and HEAD support', async () => {
  const mounted = mount({})
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.ping)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.deepEqual(json, { ok: true, name: PLUGIN_NAME, version: PLUGIN_VERSION })
  assert.equal(json.version, '0.4.0')

  const head = await invoke(mounted.webServer, ROUTE_PATHS.ping, { method: 'HEAD' })
  assert.equal(head.res.statusCode, 200)
  assert.equal(head.res.body, '')
  assert.equal(head.res.headers['cache-control'], 'no-store')
  assert.equal(Number(head.res.headers['content-length']) > 0, true)
  mounted.dispose()
})

test('HOSTUI-06 rejects non-GET/HEAD methods on every data route with 405 and an Allow header', async () => {
  const mounted = mount({})
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const name of DATA_ROUTE_NAMES) {
      const { res } = await invoke(mounted.webServer, ROUTE_PATHS[name], { method })
      assert.equal(res.statusCode, 405, `${method} must be rejected on ${ROUTE_PATHS[name]}`)
      assert.equal(res.headers.allow, 'GET, HEAD')
      assert.equal(res.ended, true)
    }
  }
  assert.equal(mounted.facade.calls.length, 0, 'guarded requests must not touch the facade')
  mounted.dispose()
})

test('HOSTUI-07 the optional connection fence answers before routing', async () => {
  const connection = { requestRejection: (req) => (req.headers['x-fence'] === '1' ? 403 : undefined) }
  const mounted = mount({}, { connection })
  const fenced = await invoke(mounted.webServer, ROUTE_PATHS.workspaces, { headers: { 'x-fence': '1' } })
  assert.equal(fenced.res.statusCode, 403)
  assert.equal(mounted.facade.calls.length, 0)
  const allowed = await invoke(mounted.webServer, ROUTE_PATHS.ping)
  assert.equal(allowed.res.statusCode, 200)
  mounted.dispose()
})

test('HOSTUI-08 rejects foreign Origin and cross-site Sec-Fetch-Site on data routes', async () => {
  const mounted = mount({})
  for (const name of ['workspaces', 'bus', 'profile', 'memory', 'profile-export', 'ping']) {
    const foreign = await invoke(mounted.webServer, ROUTE_PATHS[name], {
      query: name === 'bus' ? { ws: WS_KEY } : undefined,
      headers: { origin: 'https://evil.example', host: '127.0.0.1:53074' },
    })
    assert.equal(foreign.res.statusCode, 403, `${name} must reject a foreign Origin`)
    assert.equal(foreign.json.error.code, 'CONFLUENCE_FOREIGN_ORIGIN')

    const crossSite = await invoke(mounted.webServer, ROUTE_PATHS[name], {
      query: name === 'bus' ? { ws: WS_KEY } : undefined,
      headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:53074' },
    })
    assert.equal(crossSite.res.statusCode, 403, `${name} must reject a cross-site Sec-Fetch-Site`)
  }
  const sameOrigin = await invoke(mounted.webServer, ROUTE_PATHS.workspaces, {
    headers: { origin: 'http://127.0.0.1:53074', host: '127.0.0.1:53074', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(sameOrigin.res.statusCode, 200)
  mounted.dispose()
})

// ---------------------------------------------------------------------------
// HOSTUI: workspaces payload
// ---------------------------------------------------------------------------

test('HOSTUI-09 workspaces serves opaque ids, basename labels and counts only', async () => {
  const mounted = mount({
    panelWorkspaces: {
      profile: { label: 'D:\\dsh\\profiles\\desktop', extra: 'SECRET_PROFILE' },
      workspaces: [
        {
          id: 'ws_0123456789ABCDEF',
          label: 'D:\\05_Code\\solo-bench',
          name: 'ignored',
          entries: '42',
          messages: 7.9,
          peers: -3,
          lastActivity: ISO_TS,
          body: 'SECRET_NOTE_BODY',
          preview: 'SECRET_PREVIEW',
          path: 'C:\\secret\\workspace',
        },
        { id: OTHER_WS, label: 'auth-service', entries: 1, messages: 2, peers: 3, lastActivity: 'not-a-date' },
        { id: WS_KEY, label: 'duplicate row must be dropped' },
        { id: 'ws_short', label: 'invalid id must be dropped' },
        { id: 'not-a-workspace', label: 'invalid id must be dropped' },
      ],
      truncated: false,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.workspaces)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(summaryKeys(json), ['ok', 'profile', 'truncated', 'workspaces'])
  assert.deepEqual(json.profile, { label: 'desktop' })
  assert.equal(json.workspaces.length, 2)
  assert.deepEqual(json.workspaces[0], {
    id: 'ws_0123456789abcdef',
    label: 'solo-bench',
    entries: 42,
    messages: 7,
    peers: 0,
    lastActivity: ISO_TS,
  })
  assert.deepEqual(summaryKeys(json.workspaces[0]), ['entries', 'id', 'label', 'lastActivity', 'messages', 'peers'])
  assert.deepEqual(json.workspaces[1], {
    id: OTHER_WS,
    label: 'auth-service',
    entries: 1,
    messages: 2,
    peers: 3,
    lastActivity: '',
  })
  assert.equal(json.truncated, true, 'dropped rows must be explicit')
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes('SECRET'), false)
  assert.equal(serialized.includes('solo-bench\\'), false, 'labels are basenames only')
  assert.equal(serialized.includes('C:'), false, 'no absolute path may leak')
  assert.equal(serialized.includes('D:'), false, 'no absolute path may leak')
  assert.equal(serialized.includes('"body"'), false, 'the workspace list must carry no note body')
  assert.deepEqual(mounted.facade.calls, [['panelWorkspaces']])
  mounted.dispose()
})

test('HOSTUI-10 workspaces caps rows at 50 and degrades missing/broken facades', async () => {
  const workspaces = []
  for (let index = 0; index < 60; index += 1) {
    workspaces.push({ id: makeWsId(index), label: 'ws-' + String(index), entries: index, messages: 0, peers: 0, lastActivity: ISO_TS })
  }
  const mounted = mount({ panelWorkspaces: { profile: { label: 'All sessions' }, workspaces, truncated: false } })
  const { json } = await invoke(mounted.webServer, ROUTE_PATHS.workspaces)
  assert.equal(json.workspaces.length, 50)
  assert.equal(json.truncated, true)

  const nullFacade = createFacade()
  nullFacade.panelWorkspaces = async () => null
  const nullMounted = mount({}, { facade: nullFacade })
  const nullResult = await invoke(nullMounted.webServer, ROUTE_PATHS.workspaces)
  assert.equal(nullResult.res.statusCode, 503)
  assert.equal(nullResult.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  const missingFacade = createFacade()
  delete missingFacade.panelWorkspaces
  const missing = mount({}, { facade: missingFacade })
  const missingResult = await invoke(missing.webServer, ROUTE_PATHS.workspaces)
  assert.equal(missingResult.res.statusCode, 503)

  mounted.dispose()
  nullMounted.dispose()
  missing.dispose()
})

// ---------------------------------------------------------------------------
// HOSTUI: workspace bus payload
// ---------------------------------------------------------------------------

test('HOSTUI-11 bus forwards filters with the opaque ws id and emits allow-listed rows', async () => {
  const mounted = mount({
    panelBus: {
      workspace: { id: 'WS_0123456789ABCDEF', label: 'D:\\05_Code\\solo-bench', path: 'C:\\secret' },
      context: [
        {
          key: 'task.progress',
          value: 'done: api',
          valueType: 'json',
          updatedAt: ISO_TS,
          author: { sessionId: 'session-x', title: 'Auth work' },
          extra: 'SECRET_CONTEXT',
        },
        { key: 'Bad Key!', value: 'dropped by key regex', valueType: 'text' },
        { key: 'task.progress', value: 'duplicate key must be dropped', valueType: 'text' },
        { key: 'notes', value: 'v', valueType: 'weird', authorTitle: 'Data migration', updatedAt: 'nope' },
      ],
      entries: [
        {
          id: ENTRY_ID,
          seq: '01JBQ8Z4K1',
          kind: 'gotcha',
          title: 'Windows rename retries',
          authorTitle: 'Auth work',
          ts: ISO_TS,
          status: 'open',
          replyCount: 2,
          body: 'SECRET_NOTE_BODY',
          preview: 'SECRET_PREVIEW',
          workspaceLabel: 'C:\\work\\auth-service',
        },
        { id: ENTRY_ID, seq: 'dup', kind: 'finding', title: 'duplicate entry must be dropped' },
        { id: 'tmb_01JBQ8Z4K1H9T2R6N4X7C0W8FD', kind: 'finding', title: 'invalid entry id must be dropped' },
        {
          id: makeEntryId(2),
          seq: '01JBQ8Z4K2',
          kind: 'not-a-kind',
          title: 'unknown kind',
          author: { sessionId: 'session-x' },
          ts: 'bad',
          status: 'weird',
          replyCount: -5,
        },
      ],
      messages: [
        {
          id: MSG_ID,
          seq: '01JBQ8Z4K3',
          from: { sessionId: 'session-x', title: 'Data migration' },
          kind: 'instruction',
          body: 'first line headline\nSECRET_MESSAGE_TAIL',
          ts: '2026-11-13T03:56:00.000Z',
        },
        { id: 'not-a-message', kind: 'notice', body: 'dropped by id' },
        { id: makeMsgId(2), from: 'Docs', kind: 'weird', title: 'Explicit title', ts: 'bad' },
        { id: makeMsgId(2), title: 'duplicate message must be dropped' },
      ],
      peers: [
        { title: 'Auth work', status: 'running', sessionId: 'session-x', workspaceLabel: 'C:\\work' },
        { title: 'Docs', status: 'weird' },
        { title: '' },
        { title: 'Auth work', status: 'running' },
      ],
      stats: { context: 12, entries: 34, messages: 56, peers: 3 },
      truncated: false,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.bus, {
    query: { ws: 'WS_0123456789ABCDEF', q: '  rename  ', kind: 'not-a-kind', limit: '10' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(summaryKeys(json), ['context', 'entries', 'messages', 'ok', 'peers', 'stats', 'truncated', 'workspace'])
  assert.deepEqual(json.workspace, { id: WS_KEY, label: 'solo-bench' })
  assert.deepEqual(summaryKeys(json.workspace), ['id', 'label'])

  assert.equal(json.context.length, 2)
  assert.deepEqual(json.context[0], {
    key: 'task.progress',
    value: 'done: api',
    valueType: 'json',
    updatedAt: ISO_TS,
    authorTitle: 'Auth work',
  })
  assert.deepEqual(summaryKeys(json.context[0]), ['authorTitle', 'key', 'updatedAt', 'value', 'valueType'])
  assert.deepEqual(json.context[1], {
    key: 'notes',
    value: 'v',
    valueType: 'text',
    updatedAt: '',
    authorTitle: 'Data migration',
  })

  assert.equal(json.entries.length, 2)
  assert.deepEqual(json.entries[0], {
    id: ENTRY_ID,
    seq: '01JBQ8Z4K1',
    kind: 'gotcha',
    title: 'Windows rename retries',
    authorTitle: 'Auth work',
    ts: ISO_TS,
    status: 'open',
    replyCount: 2,
  })
  assert.deepEqual(summaryKeys(json.entries[0]), ['authorTitle', 'id', 'kind', 'replyCount', 'seq', 'status', 'title', 'ts'])
  assert.equal(json.entries[1].kind, 'warning')
  assert.equal(json.entries[1].status, 'active')
  assert.equal(json.entries[1].authorTitle, '')
  assert.equal(json.entries[1].ts, '')
  assert.equal(json.entries[1].replyCount, 0)

  assert.equal(json.messages.length, 2)
  assert.deepEqual(json.messages[0], {
    id: MSG_ID,
    seq: '01JBQ8Z4K3',
    from: 'Data migration',
    kind: 'instruction',
    title: 'first line headline',
    ts: '2026-11-13T03:56:00.000Z',
  })
  assert.deepEqual(summaryKeys(json.messages[0]), ['from', 'id', 'kind', 'seq', 'title', 'ts'])
  assert.equal(json.messages[1].from, 'Docs')
  assert.equal(json.messages[1].kind, 'notice')
  assert.equal(json.messages[1].title, 'Explicit title')
  assert.equal(json.messages[1].ts, '')

  assert.deepEqual(json.peers, [
    { title: 'Auth work', status: 'running' },
    { title: 'Docs', status: 'unknown' },
  ])
  assert.deepEqual(json.stats, { context: 12, entries: 34, messages: 56, peers: 3 })
  assert.equal(json.truncated, true)

  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes('SECRET'), false)
  assert.equal(serialized.includes('session-x'), false, 'session ids must never reach the panel')
  assert.equal(serialized.includes('C:'), false, 'no absolute path may leak')
  assert.equal(serialized.includes('D:'), false, 'no absolute path may leak')
  assert.equal(serialized.includes('"body"'), false, 'list views must not carry note bodies')
  assert.equal(serialized.includes('"preview"'), false)
  assert.equal(serialized.includes('workspaceLabel'), false, 'a bus row needs no provenance chip')
  assert.deepEqual(mounted.facade.calls[0], [
    'panelBus',
    { ws: WS_KEY, q: 'rename', kind: undefined, limit: 10 },
  ])
  mounted.dispose()
})

test('HOSTUI-12 bus caps context/messages/peers/entries and falls back to emitted stats', async () => {
  const context = []
  const entries = []
  const messages = []
  const peers = []
  for (let index = 0; index < 200; index += 1) {
    context.push({ key: 'k.' + String(index), value: 'v' + String(index), valueType: 'text', updatedAt: ISO_TS, authorTitle: 's' })
    entries.push({ id: makeEntryId(index), seq: '01JBQ8Z4K1', kind: 'finding', title: 't' + String(index), authorTitle: 's', ts: ISO_TS, status: 'active', replyCount: 0 })
    messages.push({ id: makeMsgId(index), seq: '01JBQ8Z4K1', from: 's', kind: 'notice', title: 'm' + String(index), ts: ISO_TS })
    peers.push({ title: 'peer-' + String(index), status: 'running' })
  }
  const mounted = mount({
    panelBus: { workspace: { id: WS_KEY, label: 'demo' }, context, entries, messages, peers, truncated: false },
  })
  const { json } = await invoke(mounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY } })
  assert.equal(json.context.length, 50)
  assert.equal(json.entries.length, 20, 'the default page size is 20')
  assert.equal(json.messages.length, 30)
  assert.equal(json.peers.length, 8)
  assert.deepEqual(json.stats, { context: 50, entries: 20, messages: 30, peers: 8 })
  assert.equal(json.truncated, true)
  assert.deepEqual(mounted.facade.calls[0], ['panelBus', { ws: WS_KEY, q: '', kind: undefined, limit: 20 }])

  const capped = await invoke(mounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY, limit: '9999' } })
  assert.equal(capped.json.entries.length, 50)
  assert.deepEqual(mounted.facade.calls[1], ['panelBus', { ws: WS_KEY, q: '', kind: undefined, limit: 50 }])

  const floor = await invoke(mounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY, limit: '0' } })
  assert.equal(floor.json.entries.length, 1)
  assert.deepEqual(mounted.facade.calls[2], ['panelBus', { ws: WS_KEY, q: '', kind: undefined, limit: 1 }])
  mounted.dispose()
})

test('HOSTUI-13 bus requires a well-formed opaque workspace id', async () => {
  const mounted = mount({})
  const missing = await invoke(mounted.webServer, ROUTE_PATHS.bus)
  assert.equal(missing.res.statusCode, 400)
  assert.equal(missing.json.error.code, 'CONFLUENCE_INVALID_ARGUMENT')

  for (const ws of ['ws_short', 'not-a-workspace', WS_KEY.toUpperCase().replace('WS_', 'ws_') + 'x']) {
    const invalid = await invoke(mounted.webServer, ROUTE_PATHS.bus, { query: { ws } })
    assert.equal(invalid.res.statusCode, 400, `invalid ws must be rejected: ${ws}`)
  }
  assert.equal(mounted.facade.calls.length, 0, 'invalid requests must not reach the facade')
  mounted.dispose()
})

test('HOSTUI-14 bus rejects missing/broken facade payloads with stable errors', async () => {
  const nullFacade = createFacade()
  nullFacade.panelBus = async () => null
  const nullMounted = mount({}, { facade: nullFacade })
  const nullResult = await invoke(nullMounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY } })
  assert.equal(nullResult.res.statusCode, 503)
  assert.equal(nullResult.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  const arrayFacade = createFacade()
  arrayFacade.panelBus = async () => []
  const arrayMounted = mount({}, { facade: arrayFacade })
  const arrayResult = await invoke(arrayMounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY } })
  assert.equal(arrayResult.res.statusCode, 503)

  const unavailableFacade = createFacade()
  unavailableFacade.panelBus = async () => {
    const error = new Error('store is unavailable')
    error.code = 'STORE_UNAVAILABLE'
    throw error
  }
  const unavailable = mount({}, { facade: unavailableFacade })
  const unavailableResult = await invoke(unavailable.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY } })
  assert.equal(unavailableResult.res.statusCode, 503)
  assert.equal(unavailableResult.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  nullMounted.dispose()
  arrayMounted.dispose()
  unavailable.dispose()
})

// ---------------------------------------------------------------------------
// HOSTUI: entry payload
// ---------------------------------------------------------------------------

test('HOSTUI-15 entry is a workspace-scoped note read with a body, relative files and bounded replies', async () => {
  const replies = []
  for (let index = 0; index < 60; index += 1) {
    replies.push({
      id: makeEntryId(index),
      seq: '01JBQ8Z4K2',
      body: 'reply ' + String(index),
      authorTitle: 'Data migration',
      ts: '2026-11-13T03:56:00.000Z',
      workspaceLabel: 'C:\\work\\auth-service',
    })
  }
  const mounted = mount({
    panelEntry: {
      workspace: { id: WS_KEY, label: 'solo-bench' },
      entry: {
        id: ENTRY_ID,
        seq: '01JBQ8Z4K1',
        kind: 'finding',
        title: 'Index retries',
        body: 'Body\u0000text\nsecond line',
        tags: ['windows', 'WINDOWS', 'io', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
        files: ['D:\\work\\src\\win\\rename.ts', '\\\\server\\share\\x.ts', '../escape.ts', 'src/auth/index.ts'],
        authorTitle: 'Auth work',
        workspaceLabel: 'C:\\work\\auth-service',
        ts: ISO_TS,
        status: 'active',
        author: { sessionId: 'session-x' },
        replyCount: 3,
      },
      replies,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(summaryKeys(json), ['entry', 'ok', 'replies'])
  assert.deepEqual(summaryKeys(json.entry), [
    'authorTitle', 'body', 'files', 'id', 'kind', 'seq', 'status', 'tags', 'title', 'ts',
  ])
  assert.equal(json.entry.body.includes('\u0000'), false, 'control characters must be stripped from the body')
  assert.equal(json.entry.body.includes('\n'), true, 'note bodies keep their line breaks')
  assert.deepEqual(json.entry.tags, ['windows', 'io', 'a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(json.entry.files, ['work/src/win/rename.ts', 'src/auth/index.ts'])
  assert.equal(json.entry.workspaceLabel, undefined)
  assert.equal(json.replies.length, 50)
  assert.deepEqual(summaryKeys(json.replies[0]), ['authorTitle', 'body', 'id', 'seq', 'ts'])
  assert.deepEqual(mounted.facade.calls[0], ['panelEntry', { ws: WS_KEY, id: ENTRY_ID }])
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes(WS_KEY), false, 'the entry payload recaps no workspace id')
  assert.equal(serialized.includes('C:'), false)
  assert.equal(serialized.includes('session-x'), false)
  mounted.dispose()
})

test('HOSTUI-16 entry route reports missing/malformed/absent notes with 400/404', async () => {
  const mounted = mount({})
  const missingWs = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { id: ENTRY_ID } })
  assert.equal(missingWs.res.statusCode, 400)

  const missingId = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY } })
  assert.equal(missingId.res.statusCode, 400)

  const malformed = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: 'nope' } })
  assert.equal(malformed.res.statusCode, 404)

  const absent = await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  assert.equal(absent.res.statusCode, 404)
  assert.equal(absent.json.error.code, 'CONFLUENCE_NOT_FOUND')

  const badEntryFacade = createFacade()
  badEntryFacade.panelEntry = async () => ({ entry: 'not-an-object', replies: [] })
  const badEntry = mount({}, { facade: badEntryFacade })
  const badEntryResult = await invoke(badEntry.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  assert.equal(badEntryResult.res.statusCode, 404)

  mounted.dispose()
  badEntry.dispose()
})

// ---------------------------------------------------------------------------
// HOSTUI: profile payload
// ---------------------------------------------------------------------------

test('HOSTUI-17 profile emits persona sections with allow-listed facts', async () => {
  const mounted = mount({
    panelProfile: {
      revision: 42,
      sections: [
        {
          id: 'communication',
          facts: [
            { id: FACT_ID, section: 'communication', key: 'answer.language', value: '中文', confidence: 0.9, source: 'user', ts: ISO_TS, extra: 'SECRET' },
            { id: makeFactId(2), section: 'communication', key: 'length', value: 'concise', confidence: 1.7, source: 'weird', ts: 'bad' },
            { id: 'bad-id', section: 'communication', key: 'x', value: 'dropped by id' },
            { id: makeFactId(3), section: 'communication', key: 'Bad Key!', value: 'dropped by key' },
          ],
        },
        {
          id: 'personality',
          facts: [{ id: makeFactId(4), section: 'personality', key: 'curiosity', value: 'high', confidence: '0.5', source: 'import' }],
        },
        { id: 'boundaries', facts: [] },
        // v0.4: tech/context facts are no longer persona (they migrate to patterns).
        { id: 'tech', facts: [{ id: makeFactId(5), section: 'tech', key: 'stack', value: 'not persona anymore' }] },
        { id: 'bogus', facts: [{ id: makeFactId(6), key: 'x', value: 'dropped by section' }] },
      ],
      stats: { sections: 6, facts: 99, styles: 3 },
      truncated: false,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.profile)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(summaryKeys(json), ['ok', 'revision', 'sections', 'stats', 'styles', 'truncated'])
  assert.equal(json.revision, '42')
  assert.deepEqual(json.sections.map((section) => section.id), ['personality', 'communication'])
  assert.equal(json.sections[1].facts.length, 2)
  assert.deepEqual(json.sections[1].facts[0], {
    id: FACT_ID,
    section: 'communication',
    key: 'answer.language',
    value: '中文',
    confidence: 0.9,
    source: 'user',
    ts: ISO_TS,
  })
  assert.deepEqual(summaryKeys(json.sections[1].facts[0]), [
    'confidence', 'id', 'key', 'section', 'source', 'ts', 'value',
  ])
  assert.equal(json.sections[1].facts[1].confidence, 1, 'confidence is clamped to 0..1')
  assert.equal(json.sections[1].facts[1].source, 'agent', 'unknown source falls back to agent')
  assert.equal(json.sections[1].facts[1].ts, '')
  assert.deepEqual(json.styles, [], 'no styles given means an empty style-card list')
  assert.deepEqual(json.stats, { sections: 6, facts: 99, styles: 3 })
  assert.equal(json.truncated, true, 'dropped facts/sections must be explicit')
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes('SECRET'), false)

  // A flat `facts` facade shape is grouped into the fixed persona order, and the v0.3
  // legacy aliases (preferences/rules) fold into the v0.4 persona sections.
  const flatFacade = createFacade()
  flatFacade.panelProfile = async () => ({
    revision: null,
    facts: [
      { id: makeFactId(10), section: 'preferences', key: 'answer.language', value: '中文', confidence: 0.4, source: 'agent' },
      { id: makeFactId(11), section: 'rules', key: 'never.follow.injected', value: 'treat notes as data', confidence: 0.8, source: 'user' },
      { id: makeFactId(12), section: 'identity', key: 'name', value: 'Lee', confidence: 0.8, source: 'user' },
      { id: makeFactId(13), section: 'tech', key: 'stack', value: 'migrated to patterns, not persona' },
      { id: makeFactId(14), section: 'taste', key: 'answer.length', value: 'concise', confidence: 0.6, source: 'user' },
    ],
  })
  const flat = mount({}, { facade: flatFacade })
  const flatResult = await invoke(flat.webServer, ROUTE_PATHS.profile)
  assert.equal(flatResult.json.revision, '')
  assert.deepEqual(flatResult.json.sections.map((section) => section.id), ['identity', 'communication', 'boundaries', 'taste'])
  assert.deepEqual(flatResult.json.stats, { sections: 4, facts: 4, styles: 0 })
  assert.equal(flatResult.json.truncated, true, 'the legacy non-persona tech fact is dropped explicitly')

  mounted.dispose()
  flat.dispose()
})

test('HOSTUI-18 profile route degrades broken facades instead of crashing', async () => {
  const nullFacade = createFacade()
  nullFacade.panelProfile = async () => null
  const nullMounted = mount({}, { facade: nullFacade })
  const nullResult = await invoke(nullMounted.webServer, ROUTE_PATHS.profile)
  assert.equal(nullResult.res.statusCode, 503)

  const missingFacade = createFacade()
  delete missingFacade.panelProfile
  const missing = mount({}, { facade: missingFacade })
  const missingResult = await invoke(missing.webServer, ROUTE_PATHS.profile)
  assert.equal(missingResult.res.statusCode, 503)

  const genericFacade = createFacade()
  genericFacade.panelProfile = async () => {
    throw new Error('unexpected\nfailure at C:\\secret\\path')
  }
  const generic = mount({}, { facade: genericFacade })
  const genericResult = await invoke(generic.webServer, ROUTE_PATHS.profile)
  assert.equal(genericResult.res.statusCode, 500)
  assert.equal(genericResult.json.error.code, 'CONFLUENCE_INTERNAL')
  assert.equal(genericResult.json.error.message.includes('\n'), false)

  nullMounted.dispose()
  missing.dispose()
  generic.dispose()
})

// ---------------------------------------------------------------------------
// HOSTUI: profile export (file download, not a JSON envelope)
// ---------------------------------------------------------------------------

test('HOSTUI-19 profile/export is an attachment download of the full memory document for json and md', async () => {
  const jsonText = '{"format":"confluence.memory/v1","version":1,"kind":"memory","patterns":[],"styles":[]}'
  const facade = createFacade()
  facade.panelProfileExport = async (requested) => {
    facade.calls.push(['panelProfileExport', requested])
    if (requested.format === 'md') return { format: 'md', text: '# memory', bytes: bytes('# memory') }
    return { format: 'json', text: jsonText, bytes: bytes(jsonText) }
  }
  const mounted = mount({}, { facade })
  const def = await invoke(mounted.webServer, ROUTE_PATHS['profile-export'])
  assert.equal(def.res.statusCode, 200)
  assert.equal(def.res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(def.res.headers['content-disposition'], 'attachment; filename="confluence-profile.json"')
  assert.equal(def.res.headers['cache-control'], 'no-store')
  assert.equal(def.res.headers['x-content-type-options'], 'nosniff')
  assert.equal(def.res.body, jsonText, 'the body is the raw confluence.memory/v1 document')
  assert.equal(def.json.ok, undefined, 'the export must not be a JSON envelope')
  assert.equal(JSON.parse(def.res.body).format, 'confluence.memory/v1')

  const md = await invoke(mounted.webServer, ROUTE_PATHS['profile-export'], { query: { format: 'md' } })
  assert.equal(md.res.statusCode, 200)
  assert.equal(md.res.headers['content-type'], 'text/markdown; charset=utf-8')
  assert.equal(md.res.headers['content-disposition'], 'attachment; filename="confluence-profile.md"')
  assert.equal(md.res.body, '# memory')

  const head = await invoke(mounted.webServer, ROUTE_PATHS['profile-export'], { method: 'HEAD' })
  assert.equal(head.res.statusCode, 200)
  assert.equal(head.res.body, '')
  assert.equal(head.res.headers['content-disposition'], 'attachment; filename="confluence-profile.json"')
  assert.equal(head.res.headers['content-length'], String(bytes(jsonText)))

  assert.deepEqual(mounted.facade.calls, [
    ['panelProfileExport', { format: 'json' }],
    ['panelProfileExport', { format: 'md' }],
    ['panelProfileExport', { format: 'json' }],
  ])
  mounted.dispose()
})

test('HOSTUI-20 profile/export validates format, maps errors and enforces the 64 KiB cap', async () => {
  const invalidFacade = createFacade()
  const invalid = mount({}, { facade: invalidFacade })
  for (const format of ['yaml', 'xml']) {
    const result = await invoke(invalid.webServer, ROUTE_PATHS['profile-export'], { query: { format } })
    assert.equal(result.res.statusCode, 400)
    assert.equal(result.json.error.code, 'CONFLUENCE_INVALID_ARGUMENT')
  }
  assert.equal(invalidFacade.calls.length, 0, 'an invalid format must not reach the facade')

  const unavailableFacade = createFacade()
  unavailableFacade.panelProfileExport = async () => null
  const unavailable = mount({}, { facade: unavailableFacade })
  const unavailableResult = await invoke(unavailable.webServer, ROUTE_PATHS['profile-export'])
  assert.equal(unavailableResult.res.statusCode, 503)

  const oversized = mount({ panelProfileExport: { format: 'json', text: 'x'.repeat(MAX_RESPONSE_BYTES + 1), bytes: MAX_RESPONSE_BYTES + 1 } })
  const oversizedResult = await invoke(oversized.webServer, ROUTE_PATHS['profile-export'])
  assert.equal(oversizedResult.res.statusCode, 500)
  assert.equal(oversizedResult.json.error.code, 'CONFLUENCE_RESPONSE_TOO_LARGE')
  assert.ok(bytes(oversizedResult.res.body) <= MAX_RESPONSE_BYTES)

  invalid.dispose()
  unavailable.dispose()
  oversized.dispose()
})

// ---------------------------------------------------------------------------
// HOSTUI: caps, degradation, leakage and facade discipline
// ---------------------------------------------------------------------------

test('HOSTUI-21 an oversized bus payload is degraded explicitly under 64 KiB', async () => {
  const context = []
  for (let index = 0; index < 50; index += 1) {
    context.push({ key: 'k.' + String(index), value: 'v'.repeat(4096), valueType: 'text', updatedAt: ISO_TS, authorTitle: 's' })
  }
  const mounted = mount({
    panelBus: {
      workspace: { id: WS_KEY, label: 'demo' },
      context,
      entries: [{ id: ENTRY_ID, seq: 's', kind: 'finding', title: 'note', authorTitle: 's', ts: ISO_TS, status: 'active', replyCount: 0 }],
      messages: [],
      peers: [],
      truncated: false,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY } })
  assert.equal(res.statusCode, 200)
  assert.ok(bytes(res.body) <= MAX_RESPONSE_BYTES, 'the response must stay under the cap')
  assert.equal(json.ok, true)
  assert.equal(json.truncated, true)
  assert.ok(json.context.length < 50, 'context rows must be dropped to fit')
  assert.equal(json.entries.length, 1, 'note rows are dropped last')
  mounted.dispose()
})

test('HOSTUI-22 fitPayload degradation branches cover every new route', () => {
  // workspaces: drop rows from the end.
  const workspaces = { ok: true, profile: { label: 'All sessions' }, truncated: false, workspaces: [] }
  for (let index = 0; index < 50; index += 1) {
    workspaces.workspaces.push({ id: makeWsId(index), label: 'x'.repeat(4000), entries: index, messages: 0, peers: 0, lastActivity: ISO_TS })
  }
  const fittedWorkspaces = hostuiInternals.fitPayload('workspaces', workspaces)
  assert.ok(bytes(JSON.stringify(fittedWorkspaces.payload)) <= MAX_RESPONSE_BYTES)
  assert.equal(fittedWorkspaces.payload.truncated, true)
  assert.ok(fittedWorkspaces.payload.workspaces.length < 50)

  // bus: message headlines go first, note rows last.
  const bus = {
    ok: true,
    workspace: { id: WS_KEY, label: 'demo' },
    context: [{ key: 'a', value: 'x', valueType: 'text', updatedAt: '', authorTitle: '' }],
    entries: Array.from({ length: 50 }, (_, index) => ({
      id: makeEntryId(index), seq: 's', kind: 'finding', title: 'note ' + String(index), authorTitle: 'a', ts: '', status: 'active', replyCount: 0,
    })),
    messages: Array.from({ length: 30 }, (_, index) => ({
      id: makeMsgId(index), seq: 's', from: 'a', kind: 'notice', title: 'y'.repeat(5000) + String(index), ts: '',
    })),
    peers: [{ title: 'p', status: 'running' }],
    stats: { context: 1, entries: 50, messages: 30, peers: 1 },
    truncated: false,
  }
  const fittedBus = hostuiInternals.fitPayload('bus', bus)
  assert.ok(bytes(JSON.stringify(fittedBus.payload)) <= MAX_RESPONSE_BYTES)
  assert.equal(fittedBus.payload.truncated, true)
  assert.equal(fittedBus.payload.entries.length, 50, 'notes are dropped only after messages/state/peers')
  assert.ok(fittedBus.payload.messages.length < 30 || fittedBus.payload.context.length === 0)

  // profile: style example excerpts and rule text go first, then style rows, then facts.
  const profile = {
    ok: true,
    revision: '42',
    stats: { sections: 6, facts: 200, styles: 100 },
    truncated: false,
    sections: [],
    styles: Array.from({ length: 100 }, (_, index) => ({
      channel: index % 2 === 0 ? 'chat' : 'engineering',
      area: 'general',
      key: 'k.' + String(index),
      title: 'style ' + String(index),
      rule: 'r'.repeat(1024),
      examples: [{ bad: 'b'.repeat(240), good: 'g'.repeat(240) }],
      enabled: true,
      priority: 50,
    })),
  }
  for (let index = 0; index < 200; index += 1) {
    profile.sections.push({
      id: 'identity',
      facts: [{
        id: makeFactId(index), section: 'identity', key: 'k.' + String(index), value: 'v'.repeat(2000), confidence: 0.6, source: 'agent', ts: '',
      }],
    })
  }
  const fittedProfile = hostuiInternals.fitPayload('profile', profile)
  assert.ok(bytes(JSON.stringify(fittedProfile.payload)) <= MAX_RESPONSE_BYTES)
  assert.equal(fittedProfile.payload.truncated, true)
  const factCount = fittedProfile.payload.sections.reduce((sum, section) => sum + section.facts.length, 0)
  assert.ok(factCount < 200)
  assert.ok(Array.isArray(fittedProfile.payload.styles))
  const fittedRules = fittedProfile.payload.styles.every((row) => row.rule.length < 1024)
  const fittedExamples = fittedProfile.payload.styles.every((row) => row.examples === undefined)
  // Either the example excerpts or the rule text are degraded before rows are dropped.
  assert.equal(fittedRules || fittedExamples, true, 'style content is degraded before style rows disappear')

  // memory: pattern bodies are shortened first, then candidate rows, then active rows.
  const memory = {
    ok: true,
    revision: '7',
    stats: { total: 200, active: 100, candidates: 100 },
    truncated: false,
    patterns: Array.from({ length: 100 }, (_, index) => makePattern({
      key: 'pat.active-' + String(index),
      body: 'b'.repeat(2048),
      status: 'active',
    })),
    candidates: Array.from({ length: 100 }, (_, index) => makePattern({
      key: 'pat.candidate-' + String(index),
      body: 'c'.repeat(2048),
      status: 'candidate',
    })),
  }
  const fittedMemory = hostuiInternals.fitPayload('memory', memory)
  assert.ok(bytes(JSON.stringify(fittedMemory.payload)) <= MAX_RESPONSE_BYTES)
  assert.equal(fittedMemory.payload.truncated, true)
  assert.equal(fittedMemory.payload.patterns.length, 100, 'active rows are dropped only after bodies/candidates')
  assert.ok(
    fittedMemory.payload.candidates.length < 100
      || fittedMemory.payload.patterns.every((row) => row.body.length < 2048),
    'candidate rows or pattern bodies must be degraded to fit',
  )

  // entry: body is shortened / replies dropped.
  const entry = {
    ok: true,
    entry: {
      id: ENTRY_ID, seq: 's', kind: 'finding', title: 't', body: 'b'.repeat(120_000), tags: [], files: [], authorTitle: 'a', ts: ISO_TS, status: 'active',
    },
    replies: Array.from({ length: 50 }, (_, index) => ({
      id: makeEntryId(index), seq: 's', body: 'r'.repeat(4096), authorTitle: 'a', ts: '',
    })),
  }
  const fittedEntry = hostuiInternals.fitPayload('entry', entry)
  assert.ok(bytes(JSON.stringify(fittedEntry.payload)) <= MAX_RESPONSE_BYTES)
  assert.equal(fittedEntry.payload.truncated, true)
  assert.ok(fittedEntry.payload.entry.body.length < 120_000)
  assert.equal(hostuiInternals.ROUTES.length, 7)
})

test('HOSTUI-23 list routes never leak note/message bodies, session ids or paths', async () => {
  const mounted = mount({
    panelWorkspaces: {
      profile: { label: 'All sessions' },
      workspaces: [{ id: WS_KEY, label: 'solo', entries: 1, messages: 1, peers: 1, lastActivity: ISO_TS, body: 'SECRET_NOTE_BODY' }],
      truncated: false,
    },
    panelBus: {
      workspace: { id: WS_KEY, label: 'solo' },
      context: [{ key: 'task.progress', value: 'done', valueType: 'text', updatedAt: ISO_TS, authorTitle: 'Auth', body: 'SECRET_CONTEXT_BODY' }],
      entries: [{ id: ENTRY_ID, seq: 's', kind: 'finding', title: 'note', authorTitle: 'a', ts: ISO_TS, status: 'active', replyCount: 0, body: 'SECRET_NOTE_BODY' }],
      messages: [{ id: MSG_ID, seq: 's', from: 'a', kind: 'notice', body: 'headline\n' + 'SECRET_MESSAGE_BODY', ts: ISO_TS }],
      peers: [{ title: 'p', status: 'running' }],
      stats: {},
      truncated: false,
    },
    panelProfile: {
      revision: '1',
      sections: [{ id: 'identity', facts: [{ id: FACT_ID, section: 'identity', key: 'name', value: 'Lee', confidence: 0.9, source: 'user', ts: ISO_TS, author: { sessionId: 'session-secret' } }] }],
      styles: [{
        channel: 'chat',
        area: 'tone',
        key: STYLE_KEY,
        title: 't',
        rule: 'be direct',
        enabled: true,
        priority: 50,
        author: { sessionId: 'session-secret' },
        workspaceLabel: 'C:\\secret\\workspace',
      }],
      stats: { sections: 1, facts: 1, styles: 1 },
      truncated: false,
    },
    panelMemory: {
      revision: '9',
      patterns: [makePattern({ body: 'PATTERN_BODY_IS_ALLOWED', workspaceLabel: 'C:\\secret\\workspace', author: { sessionId: 'session-secret' }, evidence: [{ sessionId: 'session-secret', note: 'SECRET_EVIDENCE' }] })],
      candidates: [makePattern({ key: CANDIDATE_KEY, status: 'candidate', body: 'CANDIDATE_BODY_IS_ALLOWED', workspaceLabel: 'D:\\other\\repo' })],
      stats: { total: 2, active: 1, candidates: 1 },
      truncated: false,
    },
  })
  const workspaces = await invoke(mounted.webServer, ROUTE_PATHS.workspaces)
  const bus = await invoke(mounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY } })
  const profile = await invoke(mounted.webServer, ROUTE_PATHS.profile)
  const memory = await invoke(mounted.webServer, ROUTE_PATHS.memory)
  for (const [name, result] of [['workspaces', workspaces], ['bus', bus], ['profile', profile], ['memory', memory]]) {
    const serialized = JSON.stringify(result.json)
    assert.equal(serialized.includes('SECRET_NOTE_BODY'), false, `${name} leaked a note body`)
    assert.equal(serialized.includes('SECRET_MESSAGE_BODY'), false, `${name} leaked a message body`)
    assert.equal(serialized.includes('SECRET_CONTEXT_BODY'), false, `${name} leaked a context body field`)
    assert.equal(serialized.includes('SECRET_EVIDENCE'), false, `${name} leaked pattern evidence`)
    assert.equal(serialized.includes('session-secret'), false, `${name} leaked a session id`)
    assert.equal(serialized.includes('C:\\'), false, `${name} leaked an absolute path`)
    assert.equal(serialized.includes('D:\\'), false, `${name} leaked an absolute path`)
  }
  assert.equal(JSON.stringify(workspaces.json).includes('"body"'), false)
  assert.equal(JSON.stringify(bus.json).includes('"body"'), false)
  // The memory route carries exactly one structural `body` field per pattern row.
  assert.equal(JSON.stringify(memory.json).includes('"body"'), true, 'pattern bodies are structural fields')
  assert.equal(JSON.stringify(memory.json).includes('"author"'), false, 'pattern authors are not emitted')
  assert.equal(JSON.stringify(memory.json).includes('"evidence"'), false, 'pattern evidence is not emitted')
  mounted.dispose()
})

test('HOSTUI-24 the panel calls only the six read-only panel facade methods', async () => {
  const mounted = mount({})
  await invoke(mounted.webServer, ROUTE_PATHS.ping)
  await invoke(mounted.webServer, ROUTE_PATHS.workspaces)
  await invoke(mounted.webServer, ROUTE_PATHS.bus, { query: { ws: WS_KEY } })
  await invoke(mounted.webServer, ROUTE_PATHS.entry, { query: { ws: WS_KEY, id: ENTRY_ID } })
  await invoke(mounted.webServer, ROUTE_PATHS.profile)
  await invoke(mounted.webServer, ROUTE_PATHS.memory)
  await invoke(mounted.webServer, ROUTE_PATHS['profile-export'])
  const methods = new Set(mounted.facade.calls.map((call) => call[0]))
  assert.deepEqual([...methods].sort(), [
    'panelBus', 'panelEntry', 'panelMemory', 'panelProfile', 'panelProfileExport', 'panelWorkspaces',
  ])
  mounted.dispose()
})

test('HOSTUI-25 logger failures never break a response', async () => {
  const throwingLogger = {
    debug() {
      throw new Error('logger exploded')
    },
    info() {
      throw new Error('logger exploded')
    },
    warn() {
      throw new Error('logger exploded')
    },
    error() {
      throw new Error('logger exploded')
    },
  }
  const mounted = mount({}, { logger: throwingLogger })
  for (const name of ROUTE_NAMES) {
    const { res } = await invoke(mounted.webServer, ROUTE_PATHS[name], {
      query: name === 'bus' ? { ws: WS_KEY } : name === 'entry' ? { ws: WS_KEY, id: ENTRY_ID } : undefined,
    })
    assert.equal(res.statusCode >= 200 && res.statusCode < 500, true, `${name} must answer without throwing`)
  }
  mounted.dispose()
})

test('HOSTUI-26 helpers keep labels as basenames and normalize ids/errors', () => {
  assert.equal(hostuiInternals.cleanRelativePath('D:\\work\\src\\a.ts'), 'work/src/a.ts')
  assert.equal(hostuiInternals.cleanRelativePath('/work/src/b.ts'), 'work/src/b.ts')
  assert.equal(hostuiInternals.cleanRelativePath('\\\\server\\share\\c.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('../d.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('src\\..\\e.ts'), '')
  assert.equal(hostuiInternals.cleanRelativePath('src/f.ts'), 'src/f.ts')

  assert.equal(hostuiInternals.cleanProvenanceLabel('C:\\work\\auth-service'), 'auth-service')
  assert.equal(hostuiInternals.cleanProvenanceLabel('/home/me/solo-bench'), 'solo-bench')
  assert.equal(hostuiInternals.cleanProvenanceLabel('solo-bench'), 'solo-bench')
  assert.equal(hostuiInternals.cleanProvenanceLabel(''), '')
  assert.equal(hostuiInternals.cleanProvenanceLabel('..'), '')

  assert.equal(hostuiInternals.cleanAuthorTitle('  Auth work  '), 'Auth work')
  assert.equal(hostuiInternals.cleanAuthorTitle({ sessionId: 'session-x', title: 'Data migration' }), 'Data migration')
  assert.equal(hostuiInternals.cleanAuthorTitle({ sessionId: 'session-x' }), '')
  assert.equal(hostuiInternals.cleanAuthorTitle(undefined), '')

  assert.equal(hostuiInternals.normalizeWorkspaceId('WS_0123456789ABCDEF'), WS_KEY)
  assert.equal(hostuiInternals.normalizeWorkspaceId('ws_short'), '')
  assert.equal(hostuiInternals.normalizeWorkspaceId(WS_KEY + 'x'), '')
  assert.equal(hostuiInternals.normalizeWorkspaceId(undefined), '')

  assert.deepEqual({ ...PANEL_SCOPE }, { key: 'global', label: 'All sessions' })
  assert.equal(MAX_RESPONSE_BYTES, 64 * 1024)
  assert.deepEqual(hostuiInternals.mapError(Object.assign(new Error('bad'), { code: 'BAD_ARGUMENT' })), {
    status: 400,
    payload: { ok: false, error: { code: 'CONFLUENCE_INVALID_ARGUMENT', message: 'bad' } },
  })
  assert.equal(hostuiInternals.mapError(Object.assign(new Error('x'), { code: 'NOT_FOUND' })).status, 404)
  assert.equal(hostuiInternals.mapError(Object.assign(new Error('x'), { code: 'STORE_UNAVAILABLE' })).status, 503)
  assert.equal(hostuiInternals.mapError(new Error('x')).status, 500)
})

// ---------------------------------------------------------------------------
// HOSTUI v0.4: long-term memory route, style cards and new degradation branches
// ---------------------------------------------------------------------------

test('HOSTUI-27 memory serves active patterns and the candidate queue with allow-listed fields', async () => {
  const mounted = mount({
    panelMemory: {
      revision: 7,
      patterns: [
        makePattern({ scope: 'workspace', workspaceLabel: 'D:\\work\\solo-bench', tags: ['windows', 'WINDOWS', 'fs', 'a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
        makePattern({ key: 'project.env-envelope', category: 'project', title: 't'.repeat(300), body: 'b'.repeat(5000), confidence: 2.4, source: 'migration', ts: 'bad' }),
        makePattern({ key: 'Bad Key!', title: 'dropped by key' }),
        makePattern({ title: 'duplicate must be dropped' }),
      ],
      candidates: [
        makePattern({ key: CANDIDATE_KEY, status: 'candidate', confidence: 0.2, source: 'user' }),
        makePattern({ key: 'candidate.unknown', status: 'weird', category: 'nonsense', title: 'unknown fields fall back' }),
        makePattern({ key: CANDIDATE_KEY, title: 'duplicate candidate must be dropped' }),
      ],
      stats: { total: 5, active: 2, candidates: 2 },
      truncated: false,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.memory)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(summaryKeys(json), ['candidates', 'ok', 'patterns', 'revision', 'stats', 'truncated'])
  assert.equal(json.revision, '7')
  assert.equal(json.patterns.length, 2)
  assert.deepEqual(summaryKeys(json.patterns[0]), [
    'body', 'category', 'confidence', 'key', 'scope', 'source', 'status', 'tags', 'title', 'ts', 'workspaceLabel',
  ])
  assert.deepEqual(json.patterns[0], {
    key: PATTERN_KEY,
    category: 'workflow',
    title: 'Windows path rename needs a retry',
    body: 'A rename over an existing path retries once on Windows.',
    tags: ['windows', 'fs', 'a', 'b', 'c', 'd', 'e', 'f'],
    scope: 'workspace',
    workspaceLabel: 'solo-bench',
    status: 'active',
    confidence: 0.8,
    source: 'agent',
    ts: ISO_TS,
  })
  assert.equal(json.patterns[1].title.length, 120)
  assert.equal(json.patterns[1].body.length, 2048)
  assert.equal(json.patterns[1].confidence, 1, 'confidence is clamped to 0..1')
  assert.equal(json.patterns[1].source, 'migration')
  assert.equal(json.patterns[1].ts, '')
  assert.equal(json.patterns[1].workspaceLabel, '', 'a global pattern carries no workspace label')
  assert.equal(json.candidates.length, 2)
  assert.equal(json.candidates[0].status, 'candidate')
  assert.equal(json.candidates[0].confidence, 0.2)
  assert.equal(json.candidates[0].source, 'user')
  assert.equal(json.candidates[1].status, 'candidate')
  assert.equal(json.candidates[1].category, 'heuristic', 'unknown category falls back')
  assert.deepEqual(json.stats, { total: 5, active: 2, candidates: 2 })
  assert.equal(json.truncated, true, 'dropped rows must be explicit')
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes('D:\\'), false, 'the workspace label is a basename only')
  assert.equal(serialized.includes('"author"'), false)
  assert.deepEqual(mounted.facade.calls, [['panelMemory']])

  // A hostile oversized row is shortened and flagged instead of silently cut.
  const oversizedFacade = createFacade()
  oversizedFacade.panelMemory = async () => ({
    revision: '',
    patterns: [makePattern({ body: 'b'.repeat(5000) })],
    candidates: [],
  })
  const oversized = mount({}, { facade: oversizedFacade })
  const oversizedResult = await invoke(oversized.webServer, ROUTE_PATHS.memory)
  assert.equal(oversizedResult.json.patterns[0].body.length, 2048)
  assert.equal(oversizedResult.json.truncated, true, 'a shortened pattern row must set the truncation flag')

  mounted.dispose()
  oversized.dispose()
})

test('HOSTUI-28 memory caps rows, splits a flat patterns list and degrades broken facades', async () => {
  const patterns = []
  for (let index = 0; index < 150; index += 1) patterns.push(makePattern({ key: 'pat.active-' + String(index), tags: [] }))
  const candidates = []
  for (let index = 0; index < 80; index += 1) candidates.push(makePattern({ key: 'pat.candidate-' + String(index), status: 'candidate' }))
  const mounted = mount({
    panelMemory: {
      revision: '9',
      patterns,
      candidates,
      stats: { total: 230, active: 150, candidates: 80 },
      truncated: false,
    },
  })
  const capped = await invoke(mounted.webServer, ROUTE_PATHS.memory)
  assert.equal(capped.json.patterns.length, 100)
  assert.equal(capped.json.candidates.length, 50)
  assert.deepEqual(capped.json.stats, { total: 230, active: 150, candidates: 80 })
  assert.equal(capped.json.truncated, true)

  // A flat `patterns` list (no `candidates` array) is split by status.
  const flatFacade = createFacade()
  flatFacade.panelMemory = async () => ({
    revision: null,
    patterns: [
      makePattern({ key: 'pat.flat-active', status: 'active' }),
      makePattern({ key: 'pat.flat-candidate', status: 'candidate' }),
    ],
  })
  const flat = mount({}, { facade: flatFacade })
  const flatResult = await invoke(flat.webServer, ROUTE_PATHS.memory)
  assert.equal(flatResult.json.revision, '')
  assert.equal(flatResult.json.patterns.length, 1)
  assert.equal(flatResult.json.candidates.length, 1)
  assert.deepEqual(flatResult.json.stats, { total: 2, active: 1, candidates: 1 })
  assert.equal(flatResult.json.truncated, false)

  const nullFacade = createFacade()
  nullFacade.panelMemory = async () => null
  const nullMounted = mount({}, { facade: nullFacade })
  assert.equal((await invoke(nullMounted.webServer, ROUTE_PATHS.memory)).res.statusCode, 503)

  const missingFacade = createFacade()
  delete missingFacade.panelMemory
  const missing = mount({}, { facade: missingFacade })
  const missingResult = await invoke(missing.webServer, ROUTE_PATHS.memory)
  assert.equal(missingResult.res.statusCode, 503)
  assert.equal(missingResult.json.error.code, 'CONFLUENCE_STORE_UNAVAILABLE')

  const unavailableFacade = createFacade()
  unavailableFacade.panelMemory = async () => {
    const error = new Error('global journal unavailable')
    error.code = 'STORE_UNAVAILABLE'
    throw error
  }
  const unavailable = mount({}, { facade: unavailableFacade })
  assert.equal((await invoke(unavailable.webServer, ROUTE_PATHS.memory)).res.statusCode, 503)

  mounted.dispose()
  flat.dispose()
  nullMounted.dispose()
  missing.dispose()
  unavailable.dispose()
})

test('HOSTUI-29 profile serves both style channels with allow-listed cards and example excerpts', async () => {
  const mounted = mount({
    panelProfile: {
      revision: 3,
      sections: [{ id: 'identity', facts: [{ id: FACT_ID, section: 'identity', key: 'name', value: 'Lee', confidence: 0.9, source: 'user', ts: ISO_TS }] }],
      styles: [
        makeStyle({
          channel: 'chat',
          area: 'tone',
          key: 'chat.tone-direct',
          priority: 70,
          author: { sessionId: 'session-secret' },
          workspaceLabel: 'C:\\secret\\workspace',
          examples: [
            { bad: 'b'.repeat(400), good: 'g'.repeat(400) },
            { bad: 'be wordy', good: 'be direct' },
            { bad: 'third example must be dropped', good: '' },
          ],
        }),
        makeStyle({ channel: 'engineering', area: 'commit', key: STYLE_KEY, enabled: false, priority: 300, examples: [] }),
        makeStyle({ channel: 'engineering', area: 'weird', key: 'commit.area-fallback', examples: [] }),
        makeStyle({ channel: 'nonsense', key: 'chat.dropped-channel' }),
        makeStyle({ channel: 'chat', key: 'Bad Key!' }),
        makeStyle({ channel: 'chat', area: 'tone', key: 'chat.tone-direct', title: 'duplicate must be dropped' }),
      ],
      stats: { sections: 1, facts: 1, styles: 3 },
      truncated: false,
    },
  })
  const { res, json } = await invoke(mounted.webServer, ROUTE_PATHS.profile)
  assert.equal(res.statusCode, 200)
  assert.equal(json.styles.length, 3)
  assert.deepEqual(json.styles.map((style) => style.channel), ['chat', 'engineering', 'engineering'])
  assert.deepEqual(json.styles.map((style) => style.enabled), [true, false, true])
  assert.deepEqual(summaryKeys(json.styles[0]), ['area', 'channel', 'enabled', 'examples', 'key', 'priority', 'rule', 'title'])
  assert.equal(json.styles[0].examples.length, 2, 'at most two example excerpts per card')
  assert.equal(json.styles[0].examples[0].bad.length, 240)
  assert.equal(json.styles[0].examples[0].good.length, 240)
  assert.deepEqual(json.styles[1], {
    channel: 'engineering',
    area: 'commit',
    key: STYLE_KEY,
    title: 'Chinese conventional commit style',
    rule: 'Use conventional commit prefixes in Chinese.',
    enabled: false,
    priority: 100,
  })
  assert.equal(json.styles[1].examples, undefined, 'an empty example list is omitted')
  assert.equal(json.styles[2].area, 'general', 'an unknown area falls back to general')
  assert.equal(json.styles[2].priority, 60)
  assert.deepEqual(json.stats, { sections: 1, facts: 1, styles: 3 })
  assert.equal(json.truncated, true, 'dropped style rows must be explicit')
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes('nonsense'), false)
  assert.equal(serialized.includes('session-secret'), false, 'style authors never reach the panel')
  assert.equal(serialized.includes('C:\\'), false, 'no absolute path may leak')

  // A hostile oversized rule is shortened and flagged instead of silently cut.
  const oversizedFacade = createFacade()
  oversizedFacade.panelProfile = async () => ({
    revision: '',
    sections: [],
    styles: [makeStyle({ rule: 'r'.repeat(2000), examples: [] })],
  })
  const oversized = mount({}, { facade: oversizedFacade })
  const oversizedResult = await invoke(oversized.webServer, ROUTE_PATHS.profile)
  assert.equal(oversizedResult.json.styles[0].rule.length, 1024)
  assert.equal(oversizedResult.json.truncated, true, 'a shortened style rule must set the truncation flag')

  mounted.dispose()
  oversized.dispose()
})

test('HOSTUI-30 oversized memory and profile payloads are degraded explicitly under 64 KiB', async () => {
  const patterns = Array.from({ length: 100 }, (_, index) => makePattern({ key: 'pat.' + String(index), body: 'b'.repeat(2048), tags: [] }))
  const candidates = Array.from({ length: 30 }, (_, index) => makePattern({ key: 'cand.' + String(index), status: 'candidate', body: 'c'.repeat(2048), tags: [] }))
  const memoryMounted = mount({
    panelMemory: { revision: '1', patterns, candidates, stats: { total: 130, active: 100, candidates: 30 }, truncated: false },
  })
  const memory = await invoke(memoryMounted.webServer, ROUTE_PATHS.memory)
  assert.equal(memory.res.statusCode, 200)
  assert.ok(bytes(memory.res.body) <= MAX_RESPONSE_BYTES, 'the response must stay under the cap')
  assert.equal(memory.json.ok, true)
  assert.equal(memory.json.truncated, true)
  assert.equal(memory.json.patterns.length, 100, 'active rows are dropped only after bodies/candidates')
  assert.equal(memory.json.patterns.some((row) => row.body.length < 2048), true, 'pattern bodies are shortened')

  const styles = Array.from({ length: 100 }, (_, index) => makeStyle({
    channel: index % 2 === 0 ? 'chat' : 'engineering',
    key: 'k.' + String(index),
    rule: 'r'.repeat(1024),
  }))
  const sections = [{
    id: 'identity',
    facts: Array.from({ length: 200 }, (_, index) => ({
      id: makeFactId(index), section: 'identity', key: 'k.' + String(index), value: 'v'.repeat(1000), confidence: 0.6, source: 'agent', ts: '',
    })),
  }]
  const profileMounted = mount({
    panelProfile: { revision: '2', sections, styles, stats: { sections: 1, facts: 200, styles: 100 }, truncated: false },
  })
  const profile = await invoke(profileMounted.webServer, ROUTE_PATHS.profile)
  assert.equal(profile.res.statusCode, 200)
  assert.ok(bytes(profile.res.body) <= MAX_RESPONSE_BYTES, 'the response must stay under the cap')
  assert.equal(profile.json.ok, true)
  assert.equal(profile.json.truncated, true)
  const factCount = profile.json.sections.reduce((sum, section) => sum + section.facts.length, 0)
  assert.ok(factCount < 200, 'facts are degraded to fit')

  memoryMounted.dispose()
  profileMounted.dispose()
})

test('HOSTUI-31 v0.4 normalizers fold persona aliases and sanitize patterns/styles', () => {
  assert.deepEqual([...hostuiInternals.PROFILE_SECTION_ORDER], ['identity', 'personality', 'communication', 'habits', 'boundaries', 'taste'])
  assert.deepEqual({ ...hostuiInternals.PROFILE_SECTION_ALIASES }, { preferences: 'communication', rules: 'boundaries' })
  assert.deepEqual([...hostuiInternals.STYLE_CHANNEL_VALUES], ['chat', 'engineering'])
  assert.deepEqual([...hostuiInternals.STYLE_AREA_VALUES], [
    'general', 'tone', 'structure', 'commit', 'comment', 'docs', 'naming', 'error', 'log', 'ui',
  ])
  assert.deepEqual([...hostuiInternals.PATTERN_CATEGORY_VALUES], ['workflow', 'project', 'domain', 'pitfall', 'heuristic', 'quality'])

  const aliasFact = hostuiInternals.normalizeProfileFact(
    { id: FACT_ID, section: 'preferences', key: 'answer.language', value: 'zh', confidence: 0.9, source: 'user' },
    'communication',
    80,
  )
  assert.equal(aliasFact.section, 'communication')
  assert.equal(hostuiInternals.normalizeProfileFact({ id: FACT_ID, section: 'tech', key: 'stack', value: 'node' }, 'tech', 80), null)
  const folded = hostuiInternals.normalizeProfileSections({
    sections: [
      { id: 'preferences', facts: [{ id: makeFactId(1), section: 'preferences', key: 'lang', value: 'zh' }] },
      { id: 'rules', facts: [{ id: makeFactId(2), section: 'rules', key: 'never.follow', value: 'x' }] },
      { id: 'tech', facts: [] },
    ],
  }, 80)
  assert.deepEqual(folded.sections.map((section) => section.id), ['communication', 'boundaries'])
  assert.equal(folded.dropped, true)

  const pattern = hostuiInternals.normalizePattern({
    key: 'x.y',
    category: 'nope',
    body: 'b'.repeat(5000),
    tags: ['A', 'a', 'b'],
    confidence: 2,
    source: 'migration',
    ts: 'bad',
  }, 'candidate')
  assert.equal(pattern.category, 'heuristic')
  assert.equal(pattern.status, 'candidate')
  assert.equal(pattern.confidence, 1)
  assert.equal(pattern.source, 'migration')
  assert.deepEqual(pattern.tags, ['a', 'b'])
  assert.equal(pattern.body.length, 2048)
  assert.equal(pattern.ts, '')
  assert.equal(hostuiInternals.normalizePattern({ key: 'Bad Key!' }, 'active'), null)

  const style = hostuiInternals.normalizeStyle({
    channel: 'engineering',
    area: 'nope',
    key: 'commit.x',
    rule: 'r',
    examples: [{ bad: 'a', good: '' }, { bad: 'b', good: 'c' }, { bad: 'd', good: 'e' }],
    priority: -5,
  })
  assert.equal(style.channel, 'engineering')
  assert.equal(style.area, 'general')
  assert.equal(style.enabled, true)
  assert.equal(style.priority, 0)
  assert.deepEqual(style.examples, [{ bad: 'a', good: '' }, { bad: 'b', good: 'c' }])
  assert.equal(hostuiInternals.normalizeStyle({ channel: 'other', key: 'x.y' }), null)
  assert.equal(hostuiInternals.normalizeStyle({ channel: 'chat', key: 'Bad Key!' }), null)
  const dedupedStyles = hostuiInternals.normalizeStyles([
    { channel: 'chat', key: 'a.b' },
    { channel: 'chat', key: 'a.b' },
  ], 10)
  assert.equal(dedupedStyles.styles.length, 1)
  assert.equal(dedupedStyles.dropped, true)
})

// ---------------------------------------------------------------------------
// UI: client module contract
// ---------------------------------------------------------------------------

function loadClientDefinition() {
  const captured = {}
  const window = { __ModuleLoader__: { load: (definition) => { captured.definition = definition } } }
  const sandbox = {
    window,
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Error,
    RegExp,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
  }
  runInContext(CLIENT_SOURCE, createContext(sandbox), { filename: 'client.js' })
  assert.ok(captured.definition !== undefined, 'client.js must call window.__ModuleLoader__.load')
  return captured.definition
}

function createClientHarness() {
  const registered = []
  const injectedOwners = []
  const localeRegistrations = []
  const effectLabels = []
  const panelSelections = []
  const ctx = {
    slots: {
      inject(ownerKey, factory) {
        injectedOwners.push(ownerKey)
        const value = factory()
        if (value !== null && typeof value === 'object' && typeof value.next === 'function') value.next()
        return () => {}
      },
      register(definition, component) {
        const record = { definition, component }
        registered.push(record)
        return record
      },
    },
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
      bind: () => (key) => (key === 'panel' ? 'Confluence' : key),
    },
    layout: {
      selectPanel(id) {
        panelSelections.push(id)
      },
    },
    effect(fn, label) {
      effectLabels.push(label)
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
  const reactShim = {
    // Render nested function components like React would; host elements keep the
    // inspectable `{ type: 'element', args: [tag, props, ...children] }` shape.
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') {
        return type({ ...(props !== null && typeof props === 'object' ? props : {}), children })
      }
      return { type: 'element', args: [type, props, ...children] }
    },
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  }
  return { ctx, registered, injectedOwners, localeRegistrations, effectLabels, panelSelections, reactShim }
}

test('UI-01 client.js loads through the ModuleLoader and registers locale + both slots', () => {
  const definition = loadClientDefinition()
  assert.equal(definition.id, 'dsh-confluence')
  assert.equal(typeof definition.factory, 'function')

  const harness = createClientHarness()
  const moduleValue = definition.factory((name) => {
    assert.equal(name, 'react')
    return harness.reactShim
  })
  // Values cross the VM realm boundary, so compare copied host-realm arrays.
  assert.deepEqual([...moduleValue.inject], ['slots', 'locale', 'layout'])
  assert.equal(typeof moduleValue.apply, 'function')
  moduleValue.apply(harness.ctx)

  assert.deepEqual(harness.injectedOwners.sort(), ['main', 'sidebar.panellist'])
  assert.equal(harness.registered.length, 2)

  const rail = harness.registered.find((record) => record.definition.name === 'sidebar.panellist')
  assert.ok(rail !== undefined)
  assert.equal(rail.definition.id, 'confluence')
  assert.equal(rail.definition.order, 30)
  assert.equal(rail.definition.locale, 'confluence')
  assert.equal(rail.definition.label(), 'Confluence')

  const main = harness.registered.find((record) => record.definition.name === 'main')
  assert.ok(main !== undefined)
  assert.equal(main.definition.key, 'confluence')
  assert.equal(main.definition.locale, 'confluence')
  const injectedProps = main.definition.inject()
  assert.equal(typeof injectedProps.t, 'function')
  assert.equal(typeof injectedProps.closePanel, 'function')
  injectedProps.closePanel()
  assert.deepEqual(harness.panelSelections, [null])

  assert.equal(harness.localeRegistrations.length, 1)
  assert.equal(harness.localeRegistrations[0].namespace, 'confluence')
  assert.equal(typeof harness.localeRegistrations[0].dictionaries.en, 'object')
  assert.equal(typeof harness.localeRegistrations[0].dictionaries.zh, 'object')
  assert.deepEqual(harness.effectLabels, ['dsh-confluence:locale'])
})

test('UI-02 client.js is a single-fetch, read-only three-tab panel over the seven routes', () => {
  const source = CLIENT_SOURCE
  // The real call site (anchored; comments may mention the loader without calling it).
  assert.equal((source.match(/^window\.__ModuleLoader__\.load\(/gm) ?? []).length, 1)
  assert.equal(source.includes("id: 'dsh-confluence'"), true)
  // Exactly one fetch call site; it is the single relative route adapter (polling).
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1)
  assert.equal(source.includes('fetch(ROUTE_BASE'), true)
  assert.equal(source.includes("credentials: 'same-origin'"), true)
  assert.equal(source.includes("cache: 'no-store'"), true)
  assert.equal(source.includes("method: 'GET'"), true)
  assert.equal(source.includes("method: 'POST'"), false)
  assert.match(source, /const ROUTE_BASE = '\/confluence\/panel'/)
  assert.match(source, /const POLL_MS = 5000/)
  assert.match(source, /visibilityState/)
  // The v0.4 three-tab page reads exactly the workspace bus, memory and profile routes.
  for (const route of ["'/workspaces'", "'/bus'", "'/entry'", "'/profile'", "'/memory'"]) {
    assert.equal(source.includes(route), true, `client.js must call the ${route} route`)
  }
  assert.equal(source.includes("'/overview'"), false, 'the v0.2 overview route must be gone')
  assert.equal(source.includes('/profile/export?format=json'), true)
  assert.equal(source.includes('/profile/export?format=md'), true)
  assert.equal(source.includes("download: 'confluence-profile.json'"), true)
  assert.equal(source.includes("download: 'confluence-profile.md'"), true)
  // Three tabs, bilingual chrome, no workspace switcher, no absolute path request.
  assert.equal((source.match(/tabButton\(/g) ?? []).length, 3, 'exactly three tab buttons render')
  for (const tab of ['bus', 'memory', 'profile']) {
    assert.equal(source.includes("tabButton('" + tab + "'"), true, `the ${tab} tab must be registered`)
  }
  assert.equal(source.includes('tab.bus'), true)
  assert.equal(source.includes('tab.memory'), true)
  assert.equal(source.includes('tab.profile'), true)
  assert.equal(source.includes('工作区总线'), true)
  assert.equal(source.includes('长期记忆'), true)
  assert.equal(source.includes('用户画像'), true)
  assert.equal(source.includes('workspaceKey'), false)
  assert.equal(source.includes('workspace_key'), false)
  for (const forbidden of [
    'http://',
    'https://',
    '<iframe',
    'innerHTML',
    'dangerouslySetInnerHTML',
    'document.write',
    'document.body',
    'postMessage',
    'WebSocket',
    'EventSource',
    'XMLHttpRequest',
    "require('@deepseek-ai/",
    'require("@deepseek-ai/',
    'localStorage',
  ]) {
    assert.equal(source.includes(forbidden), false, `client.js must not contain ${forbidden}`)
  }
  assert.doesNotMatch(source, /^\s*import\s/m, 'client.js must be a plain browser module, not ESM imports')
  // Every CSS custom property is a verified theme token.
  const variables = [...source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((match) => match[1])
  assert.ok(variables.length > 10)
  for (const variable of variables) assert.match(variable, /^--dsw-alias-/, `unexpected theme variable ${variable}`)
  // No literal colors; artwork uses currentColor.
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'client.js must not contain literal colors')
  assert.doesNotMatch(source, /\b(?:rgb|hsl)a?\(/)
  assert.equal(source.includes('currentColor'), true)
})

test('UI-03 locale dictionaries are identical across inline en/zh and the shipped locale files', () => {
  const harness = createClientHarness()
  const definition = loadClientDefinition()
  definition.factory(() => harness.reactShim).apply(harness.ctx)
  const dictionaries = harness.localeRegistrations[0].dictionaries
  const enKeys = Object.keys(dictionaries.en).sort()
  const zhKeys = Object.keys(dictionaries.zh).sort()
  assert.deepEqual(enKeys, zhKeys, 'inline en/zh dictionaries must expose the same keys')
  assert.ok(enKeys.length >= 120, 'the three-tab panel needs a meaningful string inventory')
  assert.deepEqual(enKeys, Object.keys(EN_LOCALE.ui).sort(), 'inline en must match locale/en.json ui keys')
  assert.deepEqual(zhKeys, Object.keys(ZH_LOCALE.ui).sort(), 'inline zh must match locale/zh.json ui keys')
  for (const key of enKeys) {
    assert.equal(dictionaries.en[key], EN_LOCALE.ui[key], `en copy drift for ${key}`)
    assert.equal(dictionaries.zh[key], ZH_LOCALE.ui[key], `zh copy drift for ${key}`)
    assert.equal(typeof dictionaries.en[key], 'string')
    assert.notEqual(dictionaries.en[key].trim(), '')
    assert.notEqual(dictionaries.zh[key].trim(), '')
  }

  // Every translated key used by the component exists in all dictionaries.
  const rawKeys = [...CLIENT_SOURCE.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1])
  const dynamicPrefixes = {
    'kind.': ['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning'],
    'msg.kind.': ['notice', 'instruction', 'query', 'reply'],
    'peer.status.': ['running', 'idle', 'cold', 'unknown'],
    'valueType.': ['text', 'json'],
    'profile.section.': ['identity', 'personality', 'communication', 'habits', 'boundaries', 'taste'],
    'profile.source.': ['agent', 'user', 'import'],
    'memory.category.': ['workflow', 'project', 'domain', 'pitfall', 'heuristic', 'quality'],
    'memory.scope.': ['global', 'workspace'],
    'memory.status.': ['active', 'candidate', 'rejected', 'superseded'],
    'memory.source.': ['agent', 'user', 'import', 'migration'],
    'styles.channel.': ['chat', 'engineering'],
    'styles.area.': ['general', 'tone', 'structure', 'commit', 'comment', 'docs', 'naming', 'error', 'log', 'ui'],
  }
  const usedKeys = new Set()
  for (const key of rawKeys) {
    if (/^[A-Za-z][A-Za-z0-9.-]*$/.test(key) === false) continue
    if (Object.prototype.hasOwnProperty.call(dynamicPrefixes, key)) {
      for (const suffix of dynamicPrefixes[key]) usedKeys.add(key + suffix)
      continue
    }
    if (key.endsWith('.')) continue
    usedKeys.add(key)
  }
  assert.ok(usedKeys.size > 100, 'expected the panel to translate a meaningful set of strings')
  const missingEn = [...usedKeys].filter((key) => typeof dictionaries.en[key] !== 'string' || dictionaries.en[key] === '')
  const missingZh = [...usedKeys].filter((key) => typeof dictionaries.zh[key] !== 'string' || dictionaries.zh[key] === '')
  assert.deepEqual(missingEn, [], 'missing English strings: ' + missingEn.join(', '))
  assert.deepEqual(missingZh, [], 'missing Chinese strings: ' + missingZh.join(', '))

  // Placeholder consistency: the same parameters exist in en and zh.
  const placeholders = (template) => [...String(template).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort()
  for (const key of enKeys) {
    assert.deepEqual(placeholders(dictionaries.en[key]), placeholders(dictionaries.zh[key]), `placeholder drift for ${key}`)
  }
  // The three-tab copy is the v0.4 product framing.
  assert.equal(dictionaries.en['tab.bus'], 'Workspace bus')
  assert.equal(dictionaries.zh['tab.bus'], '工作区总线')
  assert.equal(dictionaries.en['tab.memory'], 'Long-term memory')
  assert.equal(dictionaries.zh['tab.memory'], '长期记忆')
  assert.equal(dictionaries.en['tab.profile'], 'User profile')
  assert.equal(dictionaries.zh['tab.profile'], '用户画像')
  // Candidate rows explain the read-only confirmation flow with the key placeholder.
  assert.equal(dictionaries.en['memory.candidate.hint'].includes('{key}'), true)
  assert.equal(dictionaries.zh['memory.candidate.hint'].includes('确认候选'), true)
  assert.equal(dictionaries.zh['memory.candidate.hint'].includes('{key}'), true)
  // Style cards are two-channel and carry the example excerpt labels.
  assert.equal(dictionaries.en['styles.channel.chat'], 'Chat')
  assert.equal(dictionaries.en['styles.channel.engineering'], 'Engineering')
  assert.equal(dictionaries.zh['styles.channel.chat'], '对话')
  assert.equal(dictionaries.zh['styles.channel.engineering'], '工程')
  assert.equal(dictionaries.en['styles.example.bad'], 'Bad')
  assert.equal(dictionaries.en['styles.example.good'], 'Good')
  // The shipped locale metadata is the v0.4 product framing too.
  assert.equal(EN_LOCALE.meta.title, 'Confluence')
  assert.equal(ZH_LOCALE.meta.title, '高级记忆')
  assert.ok(EN_LOCALE.meta.description.trim().length >= 20)
  assert.ok(ZH_LOCALE.meta.description.trim().length >= 20)
  assert.equal(EN_LOCALE.meta.description.includes('long-term memory'), true)
  assert.equal(ZH_LOCALE.meta.description.includes('长期记忆'), true)
})

test('UI-04 client.js parses in the ModuleLoader sandbox and tolerates missing slots', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const moduleValue = definition.factory(() => harness.reactShim)
  assert.doesNotThrow(() => moduleValue.apply({ locale: undefined, layout: undefined, slots: undefined, effect: undefined }))
  assert.doesNotThrow(() => moduleValue.apply({}))
})

/**
 * Render the registered main page in the shim with a seeded state. The seed lets the
 * test reach the ready/error render branches without a browser (no effects run), so
 * every data view is exercised as a pure renderer.
 */
function renderMainPage(definition, harness, initialData) {
  definition.factory(() => harness.reactShim).apply(harness.ctx)
  const main = harness.registered.find((record) => record.definition.name === 'main')
  const dictionaries = harness.localeRegistrations[0].dictionaries.en
  const t = (key, params) => {
    let text = typeof dictionaries[key] === 'string' ? dictionaries[key] : key
    if (params !== null && typeof params === 'object') {
      for (const [name, value] of Object.entries(params)) {
        text = text.split('{' + name + '}').join(String(value))
      }
    }
    return text
  }
  const tree = main.component({ t, closePanel: () => {}, initialData })
  return { tree, serialized: JSON.stringify(tree) }
}

test('UI-06 the workspace list renders labels, opaque ids and counts', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const { serialized } = renderMainPage(definition, harness, {
    phase: 'ready',
    workspaces: {
      ok: true,
      profile: { label: 'solo-bench' },
      truncated: false,
      workspaces: [
        { id: WS_KEY, label: 'solo-bench', entries: 12, messages: 3, peers: 2, lastActivity: ISO_TS },
        { id: OTHER_WS, label: 'auth-service', entries: 1, messages: 0, peers: 0, lastActivity: '' },
      ],
    },
  })
  assert.equal(serialized.includes('Workspaces'), true)
  assert.equal(serialized.includes('solo-bench'), true)
  assert.equal(serialized.includes('auth-service'), true)
  assert.equal(serialized.includes(WS_KEY), true)
  assert.equal(serialized.includes(OTHER_WS), true)
  assert.equal(serialized.includes('12 notes · 3 messages · 2 sessions'), true)
  assert.equal(serialized.includes('Some content was shortened'), false)
  assert.equal(serialized.includes('<select'), false, 'there is no workspace switcher control')
})

test('UI-07 the workspace bus renders state, notes, message headlines and peers', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const { serialized } = renderMainPage(definition, harness, {
    phase: 'ready',
    selectedWs: WS_KEY,
    selectedId: ENTRY_ID,
    entryView: {
      ok: true,
      entry: {
        id: ENTRY_ID,
        seq: '01JBQ8Z4K1',
        kind: 'gotcha',
        title: 'Windows rename retries',
        body: 'untrusted body <b>not html</b>',
        tags: ['win32'],
        files: ['src/win/rename.ts'],
        authorTitle: 'Auth work',
        ts: ISO_TS,
        status: 'open',
      },
      replies: [{
        id: makeEntryId(2),
        seq: '01JBQ8Z4K2',
        body: 'reply body',
        authorTitle: 'Data migration',
        ts: ISO_TS,
      }],
    },
    bus: {
      ok: true,
      workspace: { id: WS_KEY, label: 'solo-bench' },
      context: [{ key: 'task.progress', value: 'done: api', valueType: 'json', updatedAt: ISO_TS, authorTitle: 'Auth work' }],
      entries: [{
        id: ENTRY_ID,
        seq: '01JBQ8Z4K1',
        kind: 'gotcha',
        title: 'Windows rename retries',
        authorTitle: 'Auth work',
        ts: ISO_TS,
        status: 'open',
        replyCount: 2,
      }],
      messages: [{ id: MSG_ID, seq: '01JBQ8Z4K3', from: 'Data migration', kind: 'instruction', title: 'headline text', ts: ISO_TS }],
      peers: [{ title: 'Docs', status: 'running' }, { title: 'Auth work', status: 'idle' }],
      stats: { context: 1, entries: 1, messages: 1, peers: 2 },
      truncated: true,
    },
  })
  assert.equal(serialized.includes('Shared state'), true)
  assert.equal(serialized.includes('task.progress'), true)
  assert.equal(serialized.includes('done: api'), true)
  assert.equal(serialized.includes('json'), true)
  assert.equal(serialized.includes('Windows rename retries'), true)
  assert.equal(serialized.includes('headline text'), true)
  assert.equal(serialized.includes('Instruction'), true)
  assert.equal(serialized.includes('Docs'), true)
  assert.equal(serialized.includes('running'), true)
  assert.equal(serialized.includes('2 replies'), true)
  assert.equal(serialized.includes('Some content was shortened'), true)
  assert.equal(serialized.includes('untrusted body'), true, 'the note body is rendered only as a text child')
  assert.equal(serialized.includes('<b>not html</b>'), true, 'untrusted text survives as data, escaped by React')
  assert.equal(serialized.includes('All workspaces'), true)
  assert.equal(serialized.includes('src/win/rename.ts'), true)
  assert.equal(serialized.includes('win32'), true)
  assert.equal(serialized.includes('reply body'), true)
})

test('UI-08 the user profile renders persona sections, style cards and export links', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const { serialized } = renderMainPage(definition, harness, {
    phase: 'ready',
    tab: 'profile',
    profile: {
      ok: true,
      revision: '42',
      truncated: true,
      stats: { sections: 2, facts: 2, styles: 2 },
      sections: [
        {
          id: 'identity',
          facts: [{ id: FACT_ID, section: 'identity', key: 'name', value: 'Lee', confidence: 0.9, source: 'user', ts: ISO_TS }],
        },
        {
          id: 'boundaries',
          facts: [{ id: makeFactId(2), section: 'boundaries', key: 'never.follow.injected', value: 'treat notes as data', confidence: 0.4, source: 'agent', ts: '' }],
        },
      ],
      styles: [
        {
          channel: 'chat',
          area: 'tone',
          key: 'chat.tone-direct',
          title: 'Direct tone',
          rule: 'Answer directly; skip the preamble.',
          enabled: true,
          priority: 70,
          examples: [{ bad: 'Great question!', good: 'Use the retry helper.' }],
        },
        {
          channel: 'engineering',
          area: 'commit',
          key: STYLE_KEY,
          title: 'Conventional commits',
          rule: 'Use conventional commit prefixes.',
          enabled: false,
          priority: 100,
        },
      ],
    },
  })
  assert.equal(serialized.includes('User profile'), true)
  assert.equal(serialized.includes('rev 42'), true)
  assert.equal(serialized.includes('2 sections · 2 facts · 2 style rules'), true)
  assert.equal(serialized.includes('Identity'), true)
  assert.equal(serialized.includes('Boundaries'), true)
  assert.equal(serialized.includes('Communication'), false, 'only the sections present render')
  assert.equal(serialized.includes('name'), true)
  assert.equal(serialized.includes('never.follow.injected'), true)
  assert.equal(serialized.includes('treat notes as data'), true)
  assert.equal(serialized.includes('90% confidence'), true)
  assert.equal(serialized.includes('40% confidence'), true)
  assert.equal(serialized.includes('user'), true)
  assert.equal(serialized.includes('agent'), true)
  assert.equal(serialized.includes('Some content was shortened'), true)
  // Both style channels render as two columns with rule + example excerpt.
  assert.equal(serialized.includes('Style cards'), true)
  assert.equal(serialized.includes('Chat'), true)
  assert.equal(serialized.includes('Engineering'), true)
  assert.equal(serialized.includes('Direct tone'), true)
  assert.equal(serialized.includes('Answer directly; skip the preamble.'), true)
  assert.equal(serialized.includes('Conventional commits'), true)
  assert.equal(serialized.includes('priority 70'), true)
  assert.equal(serialized.includes('enabled'), true)
  assert.equal(serialized.includes('disabled'), true)
  assert.equal(serialized.includes('Examples'), true)
  assert.equal(serialized.includes('Bad: '), true)
  assert.equal(serialized.includes('Great question!'), true)
  assert.equal(serialized.includes('Good: '), true)
  assert.equal(serialized.includes('Use the retry helper.'), true)
  // Export is a plain relative download link, never a fetch call.
  assert.equal(serialized.includes('"/confluence/panel/profile/export?format=json"'), true)
  assert.equal(serialized.includes('"/confluence/panel/profile/export?format=md"'), true)
  assert.equal(serialized.includes('confluence-profile.json'), true)
  assert.equal(serialized.includes('confluence-profile.md'), true)
})

test('UI-11 the long-term memory tab renders active patterns and the candidate queue', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const { serialized } = renderMainPage(definition, harness, {
    phase: 'ready',
    tab: 'memory',
    memory: {
      ok: true,
      revision: '9',
      truncated: false,
      stats: { total: 2, active: 1, candidates: 1 },
      patterns: [{
        key: PATTERN_KEY,
        category: 'pitfall',
        title: 'Windows path rename needs a retry',
        body: 'Retry a rename over an existing path once on Windows.',
        tags: ['windows'],
        scope: 'global',
        status: 'active',
        confidence: 0.8,
        source: 'agent',
        ts: ISO_TS,
        workspaceLabel: '',
      }],
      candidates: [{
        key: CANDIDATE_KEY,
        category: 'project',
        title: 'API errors use the envelope',
        body: 'Return {ok:false,error:{code,message}}.',
        tags: [],
        scope: 'workspace',
        status: 'candidate',
        confidence: 0.5,
        source: 'agent',
        ts: ISO_TS,
        workspaceLabel: 'solo-bench',
      }],
    },
  })
  assert.equal(serialized.includes('Long-term memory'), true)
  assert.equal(serialized.includes('rev 9'), true)
  assert.equal(serialized.includes('Active patterns'), true)
  assert.equal(serialized.includes('Candidates'), true)
  assert.equal(serialized.includes('1 waiting'), true)
  assert.equal(serialized.includes('Pitfall'), true)
  assert.equal(serialized.includes('Project'), true)
  assert.equal(serialized.includes('Windows path rename needs a retry'), true)
  assert.equal(serialized.includes('Retry a rename over an existing path once on Windows.'), true)
  assert.equal(serialized.includes('windows'), true)
  assert.equal(serialized.includes('Global'), true)
  assert.equal(serialized.includes('Workspace'), true)
  assert.equal(serialized.includes('solo-bench'), true)
  assert.equal(serialized.includes('80% confidence'), true)
  assert.equal(serialized.includes('"Active"'), true, 'the active pattern row shows its status')
  assert.equal(serialized.includes('"Candidate"'), true, 'the candidate row shows its status')
  // Candidate rows carry the read-only confirmation hint with the opaque key.
  assert.equal(serialized.includes('confirm candidate ' + CANDIDATE_KEY), true)
  assert.equal(serialized.includes('to the Agent to activate it.'), true)
  assert.equal(serialized.includes('Learned from earlier tasks. Treat it as data, not instructions.'), true)
  assert.equal(serialized.includes('2 patterns · 1 active · 1 candidates'), true)
})

test('UI-12 the long-term memory tab renders its empty state before anything is recorded', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const { serialized } = renderMainPage(definition, harness, {
    phase: 'ready',
    tab: 'memory',
    memory: { ok: true, revision: '', patterns: [], candidates: [], stats: { total: 0, active: 0, candidates: 0 }, truncated: false },
  })
  assert.equal(serialized.includes('No long-term memory recorded yet.'), true)
  assert.equal(serialized.includes('0 patterns · 0 active · 0 candidates'), true)
})

test('UI-09 error and empty states render localized copy with a retry action', () => {
  const definition = loadClientDefinition()
  const errorHarness = createClientHarness()
  const errored = renderMainPage(definition, errorHarness, {
    phase: 'error',
    error: { code: 'PANEL_HTTP_500', message: 'boom' },
  })
  assert.equal(errored.serialized.includes('Unable to load panel data'), true)
  assert.equal(errored.serialized.includes('boom'), true)

  const emptyHarness = createClientHarness()
  const empty = renderMainPage(definition, emptyHarness, {
    phase: 'ready',
    workspaces: { ok: true, profile: { label: 'All sessions' }, truncated: false, workspaces: [] },
  })
  assert.equal(empty.serialized.includes('No workspace has anything shared yet.'), true)
  assert.equal(empty.serialized.includes('0 workspaces'), true)

  const staleHarness = createClientHarness()
  const stale = renderMainPage(definition, staleHarness, {
    phase: 'ready',
    stale: true,
    lastUpdated: Date.parse(ISO_TS),
    workspaces: { ok: true, profile: { label: 'All sessions' }, truncated: false, workspaces: [] },
  })
  assert.equal(stale.serialized.includes('Not refreshed since'), true)
  assert.equal(stale.serialized.includes('Retry'), true)
})

test('UI-10 the profile tab renders the empty persona and style states before anything exists', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  const { serialized } = renderMainPage(definition, harness, {
    phase: 'ready',
    tab: 'profile',
    profile: { ok: true, revision: '', sections: [], styles: [], stats: { sections: 0, facts: 0, styles: 0 }, truncated: false },
  })
  assert.equal(serialized.includes('No persona facts recorded yet.'), true)
  assert.equal(serialized.includes('No style rules yet.'), true)
  assert.equal(serialized.includes('Export JSON'), true)
  assert.equal(serialized.includes('Export Markdown'), true)
  assert.equal(serialized.includes('0 sections · 0 facts · 0 style rules'), true)
})

test('UI-05 the registered page renders the three-tab chrome without data requests', () => {
  const definition = loadClientDefinition()
  const harness = createClientHarness()
  definition.factory(() => harness.reactShim).apply(harness.ctx)
  const main = harness.registered.find((record) => record.definition.name === 'main')
  assert.equal(typeof main.component, 'function')

  // No effects run in the shim, so this is the loading phase: header, tabs and footer
  // render without any data request (the single fetch stays in effects).
  const tree = main.component({
    t: (key) => 'T:' + key,
    closePanel: () => {},
  })
  assert.equal(tree.type, 'element')
  assert.equal(tree.args[0], 'section')
  const serialized = JSON.stringify(tree)
  assert.equal(serialized.includes('高级记忆 / Confluence memory'), true)
  assert.equal(serialized.includes('T:panel.subtitle'), true)
  assert.equal(serialized.includes('T:tab.bus'), true)
  assert.equal(serialized.includes('T:tab.memory'), true)
  assert.equal(serialized.includes('T:tab.profile'), true)
  assert.equal(serialized.includes('T:action.refresh'), true)
  assert.equal(serialized.includes('T:nav.back'), true)
  assert.equal(serialized.includes('T:state.loading'), true)
  assert.equal(serialized.includes('T:scope.global'), true)
  assert.equal(serialized.includes('<select'), false, 'there is no workspace switcher control')
  assert.equal(serialized.includes('aria-busy'), true)

  // The profile and memory tabs start on their pane when the host asks for it.
  const profileTree = main.component({ t: (key) => 'T:' + key, closePanel: () => {}, initialTab: 'profile' })
  const profileSerialized = JSON.stringify(profileTree)
  assert.equal(profileSerialized.includes('T:state.loading'), true)
  assert.equal(profileSerialized.includes('T:tab.profile'), true)

  const memoryTree = main.component({ t: (key) => 'T:' + key, closePanel: () => {}, initialTab: 'memory' })
  const memorySerialized = JSON.stringify(memoryTree)
  assert.equal(memorySerialized.includes('T:state.loading'), true)
  assert.equal(memorySerialized.includes('T:tab.memory'), true)
})
