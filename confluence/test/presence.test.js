// WP3b tests — universal presence: one global heartbeat per mount listing all live sessions,
// sessionsMeta provenance/title/status, synchronous live() cache, stale filtering, privacy.
// Contract: docs/adr/0007-universal-memory-scope.md; docs/plan/scope-refactor-delta.md §5;
// docs/design/ledger-recall.md §3; docs/design/data-model.md §4.6.
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Presence, presenceConstants } from '../lib/presence.js'

const GLOBAL_WS = 'ws_0000000000000000'
const LEGACY_WS = 'ws_1111111111111111'

function makeClock(start = 1_700_000_000_000) {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
      return value
    },
  }
}

function makeJournal(wsKey) {
  const files = {}
  const records = []
  return {
    wsKey,
    dir: path.join(os.tmpdir(), 'confluence-fake-presence', wsKey),
    files,
    records: () => records.slice(),
    async append(record) {
      records.push(record)
      return record
    },
    async refresh() {
      return false
    },
    async writePresence(data) {
      files[data.writerId] = JSON.parse(JSON.stringify(data))
    },
    async readPresence() {
      return JSON.parse(JSON.stringify(files))
    },
    async deletePresence(writerId) {
      delete files[writerId]
    },
  }
}

/** Fake JournalStore: exactly one global journal owns the presence directory. */
function makeStore() {
  const journal = makeJournal(GLOBAL_WS)
  const legacyRecords = []
  return {
    writerId: '4242-abcdef01',
    journal,
    legacyRecords,
    async openGlobal() {
      return journal
    },
    mergedRecords() {
      return [...journal.records(), ...legacyRecords]
    },
    onMergedChange() {
      return () => {}
    },
    async refreshMerged() {
      return false
    },
  }
}

function makeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(type, handler) {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    emit(type, ...args) {
      const handler = handlers.get(type)
      return handler ? handler(...args) : undefined
    },
  }
}

function makeTimers() {
  const intervals = []
  let nextId = 1
  const setIntervalFn = (fn, ms) => {
    const entry = { id: nextId, fn, ms, cleared: false, unref() {} }
    nextId += 1
    intervals.push(entry)
    return entry
  }
  const clearIntervalFn = (entry) => {
    if (entry && typeof entry === 'object') entry.cleared = true
  }
  return { intervals, setIntervalFn, clearIntervalFn }
}

function createPresence(options = {}) {
  const clock = options.clock ?? makeClock()
  const store = options.store ?? makeStore()
  const timers = options.timers ?? makeTimers()
  const ctx = options.ctx ?? makeCtx()
  const presence = new Presence({
    store,
    config: options.config ?? {},
    logger: options.logger ?? { warn() {}, debug() {} },
    deps: {
      now: clock.now,
      setInterval: timers.setIntervalFn,
      clearInterval: timers.clearIntervalFn,
      plugin: { name: 'dsh-confluence', version: '0.1.0' },
      pid: 4242,
    },
  })
  return { presence, clock, store, timers, ctx }
}

/** Host descriptors per the Lead's integration contract: `{id, sessionId, title, workspaceLabel, status}`. */
function descriptors(...items) {
  return () =>
    items.map((item) => ({
      id: item.sessionId,
      sessionId: item.sessionId,
      title: item.title,
      workspaceLabel: item.workspaceLabel,
      status: item.status ?? 'live',
    }))
}

const iso = (clock, offsetMs = 0) => new Date(clock.now() - offsetMs).toISOString()

async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// heartbeat file
// ---------------------------------------------------------------------------

test('CON-P1 one global heartbeat: ALL live sessions + sessionsMeta, no per-workspace files', async () => {
  const { presence, store, ctx } = createPresence()
  const disposer = presence.attach(
    ctx,
    descriptors(
      { sessionId: 'session-b', title: 'B title', workspaceLabel: 'project-b', status: 'idle' },
      { sessionId: 'session-a', title: 'A title', workspaceLabel: 'project-a', status: 'live' },
    ),
  )
  await presence.writeHeartbeat()
  const files = store.journal.files
  assert.deepEqual(Object.keys(files), ['4242-abcdef01'], 'exactly one heartbeat file for the whole profile')
  const file = files['4242-abcdef01']
  assert.equal(file.v, 1)
  assert.equal(file.ws, GLOBAL_WS, 'heartbeat lives under the global journal')
  assert.equal(file.writerId, '4242-abcdef01')
  assert.equal(file.pid, 4242)
  assert.deepEqual(file.plugin, { name: 'dsh-confluence', version: '0.1.0' })
  assert.match(file.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(file.sessions, ['session-a', 'session-b'], 'all live session ids, sorted')
  assert.deepEqual(file.sessionsMeta, {
    'session-a': { title: 'A title', workspaceLabel: 'project-a', status: 'live' },
    'session-b': { title: 'B title', workspaceLabel: 'project-b', status: 'idle' },
  })
  // Presence never appends journal records.
  assert.equal(store.journal.records().length, 0)
  await presence.dispose()
  disposer()
})

test('UT-PRESENCE-01 live() is synchronous and returns titles/status/workspaceLabel for all peers', async () => {
  const { presence, ctx } = createPresence()
  presence.attach(
    ctx,
    descriptors(
      { sessionId: 'session-a', title: 'Auth work', workspaceLabel: 'project-a', status: 'live' },
      { sessionId: 'session-b', title: 'Data work', workspaceLabel: 'project-b', status: 'idle' },
    ),
  )
  await presence.writeHeartbeat()
  await presence.refreshPresence()
  const live = presence.live()
  assert.equal(Array.isArray(live), true)
  assert.deepEqual(
    live.map((entry) => ({
      sessionId: entry.sessionId,
      title: entry.title,
      status: entry.status,
      workspaceLabel: entry.workspaceLabel,
    })),
    [
      { sessionId: 'session-a', title: 'Auth work', status: 'live', workspaceLabel: 'project-a' },
      { sessionId: 'session-b', title: 'Data work', status: 'idle', workspaceLabel: 'project-b' },
    ],
  )
  // A v0.1.0 workspace argument is accepted and ignored: the view is universal.
  assert.equal(presence.live(LEGACY_WS).length, 2)
  await presence.dispose()
})

test('UT-PRESENCE-02 heartbeats older than 30 s are offline (live filter + refresh filter)', async () => {
  const { presence, clock } = await setupWithRemoteHeartbeat(5000)
  assert.equal(presence.live().length, 1)
  clock.advance(20_000)
  assert.equal(presence.live().length, 1, '25 s old is still fresh')
  clock.advance(6000)
  assert.equal(presence.live().length, 0, 'stale after 30 s, without another refresh')
  await presence.dispose()
})

test('UT-PRESENCE-03 remote sessionsMeta joins title/status/workspaceLabel across writers', async () => {
  const clock = makeClock()
  const store = makeStore()
  store.journal.files['777-aaaaaaaa'] = {
    v: 1,
    ws: GLOBAL_WS,
    writerId: '777-aaaaaaaa',
    pid: 777,
    plugin: { name: 'dsh-confluence', version: '0.1.0' },
    updatedAt: iso(clock, 4000),
    sessions: ['session-remote'],
    sessionsMeta: {
      'session-remote': { title: 'Remote work', workspaceLabel: 'project-remote', status: 'idle' },
    },
  }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence()
  const live = presence.live()
  assert.equal(live.length, 1)
  assert.equal(live[0].sessionId, 'session-remote')
  assert.equal(live[0].title, 'Remote work')
  assert.equal(live[0].status, 'idle')
  assert.equal(live[0].workspaceLabel, 'project-remote')
  assert.equal(live[0].writerId, '777-aaaaaaaa')
  await presence.dispose()
})

test('UT-PRESENCE-03b missing sessionsMeta falls back to merged ledger rows (legacy heartbeat)', async () => {
  const clock = makeClock()
  const store = makeStore()
  store.journal.records = () => [
    {
      v: 1,
      type: 'session',
      id: 'session-remote',
      ws: GLOBAL_WS,
      seq: '01J00000000000000000000A',
      ts: iso(clock, 4000),
      title: 'Remote work',
      status: 'idle',
      turns: 2,
      lastActivityTs: iso(clock, 4000),
      origin: { workspaceKey: LEGACY_WS, workspaceLabel: 'D:\\legacy\\project-remote' },
    },
  ]
  // A v0.1.0-style heartbeat: ids only, no sessionsMeta.
  store.journal.files['777-aaaaaaaa'] = {
    v: 1,
    ws: LEGACY_WS,
    writerId: '777-aaaaaaaa',
    updatedAt: iso(clock, 4000),
    sessions: ['session-remote'],
  }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence()
  const live = presence.live()
  assert.equal(live.length, 1)
  assert.equal(live[0].title, 'Remote work')
  assert.equal(live[0].status, 'idle')
  assert.equal(live[0].workspaceLabel, 'project-remote', 'ledger origin label is basename-only')
  await presence.dispose()
})

test('UT-PRESENCE-04 corrupt/absent presence files are ignored, never throw', async () => {
  const clock = makeClock()
  const store = makeStore()
  store.journal.files['111-aaaaaaaa'] = 'not an object'
  store.journal.files['222-bbbbbbbb'] = { v: 1, updatedAt: 'not-a-date', sessions: ['session-x'] }
  store.journal.files['333-cccccccc'] = { v: 1, updatedAt: iso(clock), sessions: 'not-an-array' }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence()
  assert.deepEqual(presence.live(), [])
  // readPresence throwing is tolerated too.
  store.journal.readPresence = async () => {
    throw new Error('EBUSY')
  }
  await presence.refreshPresence()
  assert.deepEqual(presence.live(), [])
  await presence.dispose()
})

test('UT-PRESENCE-05 private sessions never appear (local write and remote read)', async () => {
  const { presence, ctx, store, clock } = createPresence({
    config: { privacy: { privateSessions: ['session-private'] } },
  })
  presence.attach(
    ctx,
    descriptors(
      { sessionId: 'session-a', title: 'A', workspaceLabel: 'project-a' },
      { sessionId: 'session-private', title: 'Secret', workspaceLabel: 'secret-project' },
    ),
  )
  await presence.writeHeartbeat()
  const file = store.journal.files['4242-abcdef01']
  assert.deepEqual(file.sessions, ['session-a'])
  assert.deepEqual(Object.keys(file.sessionsMeta), ['session-a'])
  // A remote writer advertising the private session is filtered on read too.
  store.journal.files['999-aaaaaaaa'] = {
    v: 1,
    updatedAt: iso(clock),
    sessions: ['session-private'],
    sessionsMeta: { 'session-private': { title: 'Secret', workspaceLabel: 'secret-project' } },
  }
  await presence.refreshPresence()
  assert.deepEqual(
    presence.live().map((entry) => entry.sessionId),
    ['session-a'],
  )
  await presence.dispose()
})

test('UT-PRESENCE-06 heartbeat is removed when the mount loses all live sessions', async () => {
  const { presence, ctx, store } = createPresence()
  let current = [{ id: 'session-a', sessionId: 'session-a', title: 'A', workspaceLabel: 'project-a' }]
  presence.attach(ctx, () => current)
  await presence.writeHeartbeat()
  assert.ok(store.journal.files['4242-abcdef01'])
  current = []
  await presence.writeHeartbeat()
  assert.equal(store.journal.files['4242-abcdef01'], undefined)
  await presence.dispose()
})

test('UT-PRESENCE-07 attach registers heartbeat 10 s + poll config.store.pollMs timers and turn/end hook', async () => {
  const { presence, ctx, timers, store } = createPresence({ config: { store: { pollMs: 4000 } } })
  presence.attach(ctx, descriptors({ sessionId: 'session-a', title: 'A', workspaceLabel: 'project-a' }))
  const intervals = timers.intervals.map((entry) => entry.ms).sort((a, b) => a - b)
  assert.deepEqual(intervals, [4000, presenceConstants.HEARTBEAT_INTERVAL_MS])
  assert.ok(ctx.handlers.has('session/event'), 'subscribed to session/event for turn/end')
  ctx.emit('session/event', {}, { type: 'turn/end' })
  await settle()
  assert.ok(store.journal.files['4242-abcdef01'], 'turn/end triggered a heartbeat+refresh cycle')
  await presence.dispose()
  assert.ok(timers.intervals.every((entry) => entry.cleared), 'dispose clears both timers')
  assert.equal(presence.live().length, 0, 'dispose clears the cache')
})

test('UT-PRESENCE-08 refreshPresence(ignoredScope, writerId) filters to one writer', async () => {
  const clock = makeClock()
  const store = makeStore()
  store.journal.files['111-aaaaaaaa'] = { v: 1, updatedAt: iso(clock), sessions: ['session-a'] }
  store.journal.files['222-bbbbbbbb'] = { v: 1, updatedAt: iso(clock), sessions: ['session-b'] }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence(LEGACY_WS, '222-bbbbbbbb')
  assert.deepEqual(
    presence.live().map((entry) => entry.writerId),
    ['222-bbbbbbbb'],
  )
  await presence.refreshPresence()
  assert.equal(presence.live().length, 2, 'the legacy workspace scope never filters peers')
  await presence.dispose()
})

/** helper: a remote heartbeat written into the global journal at `ageMs` before now */
async function setupWithRemoteHeartbeat(ageMs) {
  const clock = makeClock()
  const store = makeStore()
  store.journal.files['777-aaaaaaaa'] = {
    v: 1,
    ws: GLOBAL_WS,
    writerId: '777-aaaaaaaa',
    updatedAt: iso(clock, ageMs),
    sessions: ['session-remote'],
    sessionsMeta: { 'session-remote': { title: 'Remote', workspaceLabel: 'project-remote' } },
  }
  const { presence } = createPresence({ store, clock })
  await presence.refreshPresence()
  return { presence, clock }
}

test('UT-PRESENCE-09 heartbeat caps live ids at 32 and keeps sessionsMeta in sync', async () => {
  const { presence, ctx, store } = createPresence()
  const many = Array.from({ length: 40 }, (_, index) => ({
    sessionId: `session-${String(index).padStart(2, '0')}`,
    title: `T${index}`,
    workspaceLabel: 'project-a',
  }))
  presence.attach(ctx, descriptors(...many))
  await presence.writeHeartbeat()
  const file = store.journal.files['4242-abcdef01']
  assert.equal(file.sessions.length, presenceConstants.MAX_SESSIONS_PER_FILE)
  assert.deepEqual(file.sessions, [...file.sessions].sort(), 'ids stay sorted')
  assert.deepEqual(Object.keys(file.sessionsMeta).sort(), file.sessions)
  await presence.dispose()
})

test('presence constants keep the 10 s/30 s/32-session contract', () => {
  assert.equal(presenceConstants.HEARTBEAT_INTERVAL_MS, 10_000)
  assert.equal(presenceConstants.PRESENCE_STALE_MS, 30_000)
  assert.equal(presenceConstants.MAX_SESSIONS_PER_FILE, 32)
})
