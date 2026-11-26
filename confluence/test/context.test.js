// Confluence / 高级记忆 — workspace context pool unit tests (v0.3.0).
//
// Pins the pure `foldContext()` fold (per-key LWW by seq, tombstones remove) and
// the `ContextService` write/read surface of docs/plan/v0.3-interfaces.md §2.1
// and §3.3: key grammar, maxKeys/maxValueBytes caps, redaction, tombstone delete,
// per-workspace isolation, the synchronous read-path degradation and the
// caller-supplied author. Hermetic: a fake per-scope store/journal seam.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTEXT_KEY_RE,
  CONTEXT_MAX_KEYS,
  CONTEXT_VALUE_TYPES,
  ContextService,
  foldContext,
} from '../lib/context.js'
import { createRedactor } from '../lib/redact.js'

const ULID_TIME = '01J8Z6Q3M0'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TS = '2026-11-16T00:00:00.000Z'
const WS_A = 'ws_aaaaaaaaaaaaaaaa'
const WS_B = 'ws_bbbbbbbbbbbbbbbb'

function seqFor(n) {
  let value = Math.max(0, Math.trunc(n))
  let random = ''
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD[value % 32] + random
    value = Math.floor(value / 32)
  }
  return ULID_TIME + random
}

function contextRec(wsKey, seq, key, overrides = {}) {
  return {
    v: 1,
    type: 'context',
    id: `ctx_${seq}`,
    ws: wsKey,
    seq,
    ts: TS,
    key,
    value: 'value',
    valueType: 'text',
    author: { sessionId: 'session-author' },
    ...overrides,
  }
}

function baseConfig(overrides = {}) {
  const bus = overrides.bus ?? {}
  return {
    store: { maxBodyBytes: 8192, ...(overrides.store ?? {}) },
    bus: {
      notes: { ...(bus.notes ?? {}) },
      context: { ...(bus.context ?? {}) },
      messages: { ...(bus.messages ?? {}) },
    },
    privacy: {
      redact: true,
      redactTitles: true,
      denyPathPatterns: ['**/.env*', '**/*.pem'],
      privateSessions: [],
      redactPatterns: [],
      ...(overrides.privacy ?? {}),
    },
  }
}

function compareSeq(a, b) {
  const seqA = String(a.seq ?? '')
  const seqB = String(b.seq ?? '')
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = String(a.id ?? '')
  const idB = String(b.id ?? '')
  return idA === idB ? 0 : idA < idB ? -1 : 1
}

/**
 * Fake per-scope store/journal seam with the v0.3 surface the service uses:
 * `openWorkspace(wsKey, meta)`, `viewedRecords(wsKey)`, `onMergedChange(wsKey,cb)`,
 * `refreshMerged(wsKey)`. `appended(wsKey)` keeps the raw records handed to the
 * journal; `externalAppend` simulates another session/mount writing the same scope.
 */
function fakeScopedStore() {
  let sequence = 500
  const scopes = new Map()
  const mergedListeners = new Map()
  const counters = { openByKey: new Map(), refreshMerged: [] }

  function notifyScope(scope) {
    for (const listener of [...scope.listeners]) {
      try {
        listener(true)
      } catch {
        // a listener must not break the store
      }
    }
    const listeners = mergedListeners.get(scope.wsKey)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener(true)
      } catch {
        // a listener must not break the store
      }
    }
  }

  function createScope(wsKey) {
    const records = []
    const raw = []
    const listeners = new Set()
    const scope = { wsKey, records, raw, listeners, isOpen: true, meta: undefined, journal: null }
    scope.journal = {
      wsKey,
      get isOpen() {
        return scope.isOpen
      },
      records() {
        return [...records].sort(compareSeq)
      },
      async appendAndSync(record) {
        const copy = { ...record }
        raw.push(copy)
        sequence += 1
        const stored = { ...copy }
        if (stored.v === undefined) stored.v = 1
        if (stored.ws === undefined) stored.ws = wsKey
        if (stored.seq === undefined) stored.seq = seqFor(sequence)
        if (stored.ts === undefined) stored.ts = TS
        records.push(stored)
        notifyScope(scope)
        return { ...stored }
      },
      async refresh() {
        return false
      },
      onChange(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async close() {
        scope.isOpen = false
      },
    }
    return scope
  }

  const store = {
    counters,
    scopes,
    refreshResult: false,
    async openWorkspace(wsKey, meta) {
      counters.openByKey.set(wsKey, (counters.openByKey.get(wsKey) ?? 0) + 1)
      let scope = scopes.get(wsKey)
      if (scope === undefined) {
        scope = createScope(wsKey)
        scopes.set(wsKey, scope)
      } else if (!scope.isOpen) {
        scope.isOpen = true
      }
      scope.meta = meta
      return scope.journal
    },
    viewedRecords(wsKey) {
      const scope = scopes.get(wsKey)
      if (scope === undefined) return Object.freeze([])
      return Object.freeze([...scope.records].sort(compareSeq))
    },
    onMergedChange(wsKey, listener) {
      let listeners = mergedListeners.get(wsKey)
      if (listeners === undefined) {
        listeners = new Set()
        mergedListeners.set(wsKey, listeners)
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async refreshMerged(wsKey) {
      counters.refreshMerged.push(wsKey)
      return store.refreshResult
    },
    appended(wsKey) {
      const scope = scopes.get(wsKey)
      return scope === undefined ? [] : scope.raw
    },
    externalAppend(wsKey, record) {
      let scope = scopes.get(wsKey)
      if (scope === undefined) {
        scope = createScope(wsKey)
        scopes.set(wsKey, scope)
      }
      sequence += 1
      const stored = { v: 1, ws: wsKey, seq: seqFor(sequence), ts: TS, ...record }
      scope.records.push(stored)
      notifyScope(scope)
      return stored
    },
    closeScope(wsKey) {
      const scope = scopes.get(wsKey)
      if (scope !== undefined) scope.isOpen = false
    },
  }
  return store
}

const AUTHOR = { sessionId: 'session-author', title: 'Auth work' }

/**
 * @param {{store?: object, config?: object}} [options]
 */
function makeService({ store, config: overrides = {} } = {}) {
  const cfg = baseConfig(overrides)
  const fake = store ?? fakeScopedStore()
  const service = new ContextService({
    store: fake,
    config: cfg,
    redactor: createRedactor(cfg),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deps: { now: () => 1700000000000, random: () => 0.5 },
  })
  return { service, store: fake, cfg }
}

// ---------------------------------------------------------------------------
// pure fold
// ---------------------------------------------------------------------------

test('UT-CTX-00 foldContext: greatest seq wins per key, tombstones remove, junk is skipped', () => {
  const q = Array.from({ length: 12 }, (_value, index) => seqFor(index + 1))
  const records = [
    contextRec(WS_A, q[0], 'task.progress', { value: 'a', ts: '2026-11-16T00:00:00.000Z' }),
    contextRec(WS_A, q[1], 'task.progress', { value: 'b', ts: '2026-11-16T00:00:01.000Z' }),
    contextRec(WS_A, q[2], 'task.done', { value: 'ok' }),
    null,
    undefined,
    'nope',
    {},
    contextRec(WS_A, q[3], 'task.done', { deleted: true, value: undefined }),
    { v: 2, type: 'context', key: 'task.v2', value: 'x', seq: q[4], ws: WS_A, ts: TS },
    contextRec(WS_A, q[5], 'Bad Key', { value: 'x' }),
    contextRec(WS_A, q[6], 'task.no-value', { value: undefined }),
    { v: 1, type: 'entry', id: 'cnf_1', ws: WS_A, seq: q[7], ts: TS, key: 'task.entry' },
  ]
  const first = foldContext(records)
  const second = foldContext([...records].reverse())
  assert.deepEqual([...first.entries.keys()], ['task.progress'])
  assert.deepEqual([...second.entries.keys()], ['task.progress'], 'fold is order-independent')
  assert.equal(first.count, 1)
  assert.equal(first.entries.get('task.progress').value, 'b')
  assert.equal(first.entries.get('task.progress').valueType, 'text')
  assert.equal(first.entries.get('task.progress').updatedAt, '2026-11-16T00:00:01.000Z')
  assert.deepEqual(first.entries.get('task.progress').author, { sessionId: 'session-author' })
  assert.equal(first.maxSeq, q[3], 'maxSeq covers every valid context record, tombstones included')
  assert.ok(Object.isFrozen(first.entries.get('task.progress')))

  const empty = foldContext(undefined)
  assert.equal(empty.count, 0)
  assert.equal(empty.maxSeq, '')
  assert.equal(empty.entries.size, 0)
  assert.equal(foldContext([]).count, 0)
})

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

test('UT-CTX-01 read paths degrade to an empty view; writes need an attached scope', async () => {
  const { service } = makeService()
  await assert.rejects(
    service.set(WS_A, { key: 'task.progress', value: 'x', author: AUTHOR }),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  await assert.rejects(
    service.delete(WS_A, { key: 'task.progress', author: AUTHOR }),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  assert.deepEqual(service.view(WS_A), { entries: [], count: 0, maxSeq: '' })
  assert.deepEqual(service.view(undefined), { entries: [], count: 0, maxSeq: '' })
  assert.equal(service.get(WS_A, 'task.progress'), null)
  assert.equal(service.get(undefined, 'task.progress'), null)
  assert.equal(service.get(WS_A, 'Bad Key'), null, 'a malformed key is a null read, never a throw')
  assert.equal(service.get(WS_A, 42), null)
  await assert.rejects(service.attach(''), (error) => error.code === 'BAD_ARGUMENT')
})

test('UT-CTX-02 set/get/view: last writer wins, overwritten is reported, record shape is exact', async () => {
  const { service, store } = makeService()
  await service.attach(WS_A, { canonicalPath: 'D:\\05_Code\\alpha', label: 'alpha' })
  await service.attach(WS_A)
  assert.equal(store.counters.openByKey.get(WS_A), 1, 'attach is idempotent per scope')
  assert.equal(store.scopes.get(WS_A).meta.label, 'alpha', 'attach forwards the workspace metadata')

  const first = await service.set(WS_A, {
    key: 'task.progress',
    value: 'done: api',
    author: { sessionId: 'session-1', title: 'Auth work' },
  })
  assert.equal(first.key, 'task.progress')
  assert.equal(first.overwritten, false)
  assert.equal(first.seq.length, 26)
  const raw = store.appended(WS_A).at(-1)
  assert.deepEqual(Object.keys(raw).sort(), ['author', 'id', 'key', 'type', 'v', 'value', 'valueType', 'ws'])
  assert.equal(raw.v, 1)
  assert.equal(raw.type, 'context')
  assert.equal(raw.ws, WS_A, 'the record names the workspace journal key')
  assert.ok(raw.id.startsWith('ctx_'))
  assert.equal(raw.key, 'task.progress')
  assert.equal(raw.value, 'done: api')
  assert.equal(raw.valueType, 'text')
  assert.deepEqual(raw.author, { sessionId: 'session-1', title: 'Auth work' })
  assert.equal('deleted' in raw, false)

  const second = await service.set(WS_A, { key: 'task.progress', value: 'done: web', author: AUTHOR })
  assert.equal(second.overwritten, true)
  assert.equal(service.get(WS_A, 'task.progress').value, 'done: web')
  const view = service.view(WS_A)
  assert.equal(view.count, 1)
  assert.equal(view.maxSeq, second.seq)
  assert.deepEqual(
    view.entries.map((entry) => entry.key),
    ['task.progress'],
  )
  assert.equal(service.view(WS_A), view, 'the view is cached until the journal changes')
})

test('UT-CTX-03 valueType json stores a validated JSON-encoded string', async () => {
  const { service, store } = makeService()
  await service.attach(WS_A)

  const ok = await service.set(WS_A, {
    key: 'task.matrix',
    value: '{"phase":1,"items":["a"]}',
    valueType: 'json',
    author: AUTHOR,
  })
  assert.equal(ok.key, 'task.matrix')
  const raw = store.appended(WS_A).at(-1)
  assert.equal(raw.valueType, 'json')
  assert.equal(raw.value, '{"phase":1,"items":["a"]}')
  assert.equal(service.get(WS_A, 'task.matrix').valueType, 'json')

  await assert.rejects(
    service.set(WS_A, { key: 'task.matrix', value: '{not json', valueType: 'json', author: AUTHOR }),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  await assert.rejects(
    service.set(WS_A, { key: 'task.matrix', value: 'x', valueType: 'binary', author: AUTHOR }),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  await assert.rejects(
    service.set(WS_A, { key: 'task.matrix', value: 42, author: AUTHOR }),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  assert.deepEqual(CONTEXT_VALUE_TYPES, ['text', 'json'])
  assert.equal(service.get(WS_A, 'task.matrix').value, '{"phase":1,"items":["a"]}', 'failed writes change nothing')
})

test('UT-CTX-04 key grammar and caller-supplied author are enforced', async () => {
  const { service } = makeService()
  await service.attach(WS_A)
  assert.ok(CONTEXT_KEY_RE.test('task.progress'))
  assert.ok(CONTEXT_KEY_RE.test('a'))
  assert.ok(CONTEXT_KEY_RE.test('x'.repeat(64)))
  for (const key of ['', 'Task', '.dot', 'with space', 'x'.repeat(65), '-dash', '中文', 'a/b', undefined, 42]) {
    await assert.rejects(
      service.set(WS_A, { key, value: 'x', author: AUTHOR }),
      (error) => error.code === 'BAD_ARGUMENT',
      `key ${String(key)} must be rejected`,
    )
    await assert.rejects(
      service.delete(WS_A, { key, author: AUTHOR }),
      (error) => error.code === 'BAD_ARGUMENT',
      `delete key ${String(key)} must be rejected`,
    )
  }
  assert.equal((await service.set(WS_A, { key: 'x'.repeat(64), value: 'v', author: AUTHOR })).key, 'x'.repeat(64))

  await assert.rejects(service.set(WS_A, { key: 'k', value: 'v' }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(
    service.set(WS_A, { key: 'k', value: 'v', author: { sessionId: '' } }),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  await assert.rejects(service.set(WS_A, 'nope'), (error) => error.code === 'BAD_ARGUMENT')
})

test('UT-CTX-05 caps: maxKeys on new keys (LIMIT_EXCEEDED) and maxValueBytes (BODY_TOO_LARGE)', async () => {
  const { service } = makeService({ config: { bus: { context: { maxKeys: 2, maxValueBytes: 16 } } } })
  await service.attach(WS_A)
  await service.set(WS_A, { key: 'k.one', value: 'a', author: AUTHOR })
  await service.set(WS_A, { key: 'k.two', value: 'b', author: AUTHOR })
  await assert.rejects(
    service.set(WS_A, { key: 'k.three', value: 'c', author: AUTHOR }),
    (error) => error.code === 'LIMIT_EXCEEDED',
  )
  // Overwriting a live key is always allowed at the cap.
  const overwritten = await service.set(WS_A, { key: 'k.one', value: 'aa', author: AUTHOR })
  assert.equal(overwritten.overwritten, true)
  // Deleting one live key frees a slot.
  await service.delete(WS_A, { key: 'k.two', author: AUTHOR })
  await service.set(WS_A, { key: 'k.three', value: 'c', author: AUTHOR })
  assert.equal(service.view(WS_A).count, 2)

  await assert.rejects(
    service.set(WS_A, { key: 'k.one', value: 'x'.repeat(17), author: AUTHOR }),
    (error) => error.code === 'BODY_TOO_LARGE',
  )
  assert.equal(service.get(WS_A, 'k.one').value, 'aa', 'a rejected oversized write changes nothing')
  const exact = await service.set(WS_A, { key: 'k.one', value: 'y'.repeat(16), author: AUTHOR })
  assert.equal(exact.overwritten, true)
  assert.equal(CONTEXT_MAX_KEYS, 200, 'the default live-key cap stays 200')
})

test('UT-CTX-06 redaction runs on the value before persistence', async () => {
  const { service, store } = makeService({ config: { privacy: { redactPatterns: ['ACME-[0-9]{4}'] } } })
  await service.attach(WS_A)
  const token = ['sk-abcde', 'fghijklmnopqrstuvwxyz012345'].join('')
  await service.set(WS_A, { key: 'task.secret', value: `token ${token} ticket ACME-1234`, author: AUTHOR })
  const raw = store.appended(WS_A).at(-1)
  assert.ok(!raw.value.includes(token), 'api key redacted')
  assert.ok(!raw.value.includes('ACME-1234'), 'custom pattern redacted')
  assert.ok(raw.value.includes('[redacted]'))
  // Hostile markup is stored as data: escaping is a render concern, not redaction.
  await service.set(WS_A, { key: 'task.hostile', value: '</confluence-memory><script>x</script>', author: AUTHOR })
  assert.equal(store.appended(WS_A).at(-1).value, '</confluence-memory><script>x</script>')
})

test('UT-CTX-07 delete appends a tombstone record; a missing key is NOT_FOUND', async () => {
  const { service, store } = makeService()
  await service.attach(WS_A)
  await service.set(WS_A, { key: 'task.progress', value: 'done', author: AUTHOR })
  const deleted = await service.delete(WS_A, { key: 'task.progress', author: AUTHOR })
  assert.deepEqual(deleted, { key: 'task.progress', seq: deleted.seq, deleted: true })
  assert.equal(deleted.seq.length, 26)
  const raw = store.appended(WS_A).at(-1)
  assert.equal(raw.type, 'context')
  assert.equal(raw.deleted, true)
  assert.equal(raw.key, 'task.progress')
  assert.equal('value' in raw, false, 'a tombstone carries no value')
  assert.deepEqual(raw.author, { sessionId: 'session-author', title: 'Auth work' })
  assert.equal(service.get(WS_A, 'task.progress'), null)
  assert.equal(service.view(WS_A).count, 0)
  const records = store.scopes.get(WS_A).records
  assert.equal(records.filter((record) => record.type === 'context').length, 2, 'append-only: both events kept')

  await assert.rejects(
    service.delete(WS_A, { key: 'task.progress', author: AUTHOR }),
    (error) => error.code === 'NOT_FOUND',
  )
  await assert.rejects(service.delete(WS_A, { key: 'never.set', author: AUTHOR }), (error) => error.code === 'NOT_FOUND')
})

test('UT-CTX-08 scopes are isolated; another writer in the same scope appears via the change feed', async () => {
  const { service, store } = makeService()
  await service.attach(WS_A)
  await service.attach(WS_B)
  await service.set(WS_A, { key: 'task.progress', value: 'A', author: AUTHOR })
  await service.set(WS_B, { key: 'task.progress', value: 'B', author: AUTHOR })
  assert.equal(service.get(WS_A, 'task.progress').value, 'A')
  assert.equal(service.get(WS_B, 'task.progress').value, 'B')
  assert.deepEqual(
    service.view(WS_A).entries.map((entry) => entry.value),
    ['A'],
  )

  const remote = store.externalAppend(WS_A, {
    type: 'context',
    id: `ctx_${seqFor(900)}`,
    key: 'task.remote',
    value: 'from another session',
    valueType: 'text',
    author: { sessionId: 'session-other' },
  })
  const view = service.view(WS_A)
  assert.equal(view.count, 2, 'the scoped change feed invalidates the fold')
  assert.equal(view.maxSeq, remote.seq)
  assert.equal(service.get(WS_A, 'task.remote').value, 'from another session')
  assert.equal(service.view(WS_B).count, 1, 'the other workspace never sees it')

  // A remote tombstone removes the key too.
  store.externalAppend(WS_A, {
    type: 'context',
    id: `ctx_${seqFor(901)}`,
    key: 'task.remote',
    deleted: true,
    author: { sessionId: 'session-other' },
  })
  assert.equal(service.get(WS_A, 'task.remote'), null)
})

test('UT-CTX-09 refresh rescans the scope; an evicted journal is re-opened by the next write', async () => {
  const { service, store } = makeService()
  await service.attach(WS_A)
  assert.equal(service.view(WS_A).count, 0)

  store.refreshResult = true
  assert.equal(await service.refresh(WS_A), true)
  assert.equal(await service.refresh(''), false)
  assert.equal(await service.refresh('ws_not_attached_scope'), false)

  store.closeScope(WS_A)
  const set = await service.set(WS_A, { key: 'task.after-evict', value: 'x', author: AUTHOR })
  assert.equal(set.overwritten, false)
  assert.equal(store.counters.openByKey.get(WS_A), 2, 'the write re-opens the evicted journal')
  assert.equal(service.get(WS_A, 'task.after-evict').value, 'x')

  service.detach(WS_A)
  assert.deepEqual(service.view(WS_A), { entries: [], count: 0, maxSeq: '' })
  assert.equal(store.scopes.get(WS_A).isOpen, true, 'detach never closes the shared store journal')
})

test('UT-CTX-10 a journal-only store surface still folds (transitional seam)', async () => {
  const records = [
    contextRec(WS_A, seqFor(1), 'task.progress', { value: 'fallback' }),
    contextRec(WS_A, seqFor(2), 'task.progress', { value: 'fallback-new' }),
  ]
  let sequence = 10
  const journal = {
    isOpen: true,
    records() {
      return records.slice()
    },
    async appendAndSync(record) {
      sequence += 1
      const stored = { v: 1, ws: WS_A, seq: seqFor(sequence), ts: TS, ...record }
      records.push(stored)
      return { ...stored }
    },
  }
  const cfg = baseConfig()
  const service = new ContextService({
    store: {
      async openWorkspace(wsKey) {
        assert.equal(wsKey, WS_A)
        return journal
      },
    },
    config: cfg,
    redactor: createRedactor(cfg),
  })
  await service.attach(WS_A)
  assert.equal(service.view(WS_A).count, 1)
  assert.equal(service.get(WS_A, 'task.progress').value, 'fallback-new')
  await service.set(WS_A, { key: 'task.progress', value: 'written', author: AUTHOR })
  assert.equal(service.view(WS_A).entries[0].value, 'written')
})

test('UT-CTX-11 view is deterministic: newest update first, ties by key, no cross-scope rows', async () => {
  const { service } = makeService()
  await service.attach(WS_A)
  await service.set(WS_A, { key: 'b.second', value: '2', author: AUTHOR })
  await service.set(WS_A, { key: 'a.first', value: '1', author: AUTHOR })
  await service.set(WS_A, { key: 'b.second', value: '2b', author: AUTHOR })
  const view = service.view(WS_A)
  assert.deepEqual(
    view.entries.map((entry) => entry.key),
    ['b.second', 'a.first'],
    'most recently updated first',
  )
  assert.equal(view.entries[0].value, '2b')
  assert.deepEqual(Object.keys(view).sort(), ['count', 'entries', 'maxSeq'])
  assert.deepEqual(Object.keys(view.entries[0]).sort(), ['author', 'key', 'seq', 'updatedAt', 'value', 'valueType'])
})
