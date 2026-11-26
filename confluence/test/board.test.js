// Confluence / 高级记忆 — workspace board unit tests (v0.3.0).
//
// v0.3.0 (ADR-0008): notes are WORKSPACE-scoped. These tests pin the scoped API
// (`attach/view/post/thread/search/stats/refresh/detach` with a `wsKey`), the
// per-workspace entry record shape (`ws` = the journal key), cross-workspace
// isolation, per-workspace caps, threads/statuses, tombstones, search ranking,
// redaction and the synchronous empty-view degradation.
// Hermetic: a fake per-scope store/journal seam, no DSH runtime, no disk, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BoardService, KINDS, foldRecords } from '../lib/board.js'
import { createRedactor } from '../lib/redact.js'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')

const ULID_TIME = '01J8Z6Q3M0'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TS = '2026-11-16T00:00:00.000Z'

/** Deterministic 26-char Crockford ULID-like sequence value. */
function seqFor(n) {
  let value = Math.max(0, Math.trunc(n))
  let random = ''
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD[value % 32] + random
    value = Math.floor(value / 32)
  }
  return ULID_TIME + random
}

const WS_A = 'ws_aaaaaaaaaaaaaaaa'
const WS_B = 'ws_bbbbbbbbbbbbbbbb'
const WS_C = 'ws_cccccccccccccccc'
/** Reused v0.1 1 records name their original journal in `ws`; the fold is pure over records. */
const REUSED_WS_A = 'ws_1111111111111111'
const REUSED_WS_B = 'ws_2222222222222222'

function baseConfig(overrides = {}) {
  const bus = overrides.bus ?? {}
  return {
    store: {
      maxBodyBytes: 8192,
      ...(overrides.store ?? {}),
    },
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

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b */
function compareSeq(a, b) {
  const seqA = String(a.seq ?? '')
  const seqB = String(b.seq ?? '')
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = String(a.id ?? a.sessionId ?? '')
  const idB = String(b.id ?? b.sessionId ?? '')
  return idA === idB ? 0 : idA < idB ? -1 : 1
}

/**
 * Fake per-scope `JournalStore` + workspace journals with the v0.3 store surface:
 * `openWorkspace(wsKey, meta)`, `viewedRecords(wsKey)`, `onMergedChange(wsKey,cb)`,
 * `refreshMerged(wsKey)`.
 *
 * `appended(wsKey)` keeps the *raw* records the board handed to `appendAndSync`
 * (before the journal fills `v`/`ws`/`seq`/`ts`), so record-shape assertions
 * cannot be masked by the fake. `externalAppend(wsKey, record)` simulates another
 * writer/mount appending to the same journal.
 */
function fakeScopedStore() {
  let sequence = 500
  const scopes = new Map()
  const mergedListeners = new Map()
  const counters = { openCalls: [], openByKey: new Map(), refreshMerged: [] }
  const nextSeq = () => {
    sequence += 1
    return seqFor(sequence)
  }

  function notifyScope(scope, changed = true) {
    for (const listener of [...scope.listeners]) {
      try {
        listener(changed)
      } catch {
        // a listener must not break the store
      }
    }
    const listeners = mergedListeners.get(scope.wsKey)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener(changed)
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
        const stored = { ...copy }
        if (stored.v === undefined) stored.v = 1
        if (stored.ws === undefined) stored.ws = wsKey
        if (stored.seq === undefined) stored.seq = nextSeq()
        if (stored.ts === undefined) stored.ts = TS
        records.push(stored)
        notifyScope(scope, true)
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

  return {
    counters,
    scopes,
    async openWorkspace(wsKey, meta) {
      counters.openCalls.push(wsKey)
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
      return false
    },
    /** raw records the board appended for one scope */
    appended(wsKey) {
      const scope = scopes.get(wsKey)
      return scope === undefined ? [] : scope.raw
    },
    /** stored records of one scope (fake journal view) */
    records(wsKey) {
      const scope = scopes.get(wsKey)
      return scope === undefined ? [] : [...scope.records]
    },
    /** simulate another writer/mount appending to a scope journal */
    externalAppend(wsKey, record) {
      let scope = scopes.get(wsKey)
      if (scope === undefined) {
        scope = createScope(wsKey)
        scopes.set(wsKey, scope)
      }
      scope.isOpen = true
      const stored = { v: 1, ws: wsKey, seq: nextSeq(), ts: TS, ...record }
      scope.records.push(stored)
      notifyScope(scope, true)
      return stored
    },
    /** simulate the store LRU/close closing a scope journal */
    closeScope(wsKey) {
      const scope = scopes.get(wsKey)
      if (scope !== undefined) scope.isOpen = false
    },
  }
}

const AUTHOR = { sessionId: 'session-author', title: 'Auth work', origin: 'agent' }

/**
 * @param {{store?: ReturnType<typeof fakeScopedStore>, config?: object}} [options]
 * @returns {Promise<{board: BoardService, store: ReturnType<typeof fakeScopedStore>, cfg: object}>}
 */
async function makeBoard({ store, config: overrides = {} } = {}) {
  const cfg = baseConfig(overrides)
  const fake = store ?? fakeScopedStore()
  const board = new BoardService({
    store: fake,
    config: cfg,
    redactor: createRedactor(cfg),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deps: { now: () => 1700000000000, random: () => 0.5 },
  })
  return { board, store: fake, cfg }
}

/** Raw per-workspace entry record helper for pure fold tests. */
function entryRecord(n, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(1000 + n)}`,
    ws: WS_A,
    seq: seqFor(n),
    ts: TS,
    kind: 'finding',
    title: `note ${n}`,
    author: { sessionId: 'session-a', title: 'Auth work', origin: 'agent' },
    ...overrides,
  }
}

function tombstoneRecord(n, target, overrides = {}) {
  return {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqFor(2000 + n)}`,
    ws: WS_A,
    seq: seqFor(n),
    ts: TS,
    target,
    ...overrides,
  }
}

function sessionRecord(n, overrides = {}) {
  return {
    v: 1,
    type: 'session',
    id: 'session-ledger',
    ws: WS_A,
    seq: seqFor(n),
    ts: TS,
    sessionId: 'session-ledger',
    status: 'idle',
    turns: n,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// foldRecords — merge, order, derived status, threads, tombstones, provenance
// ---------------------------------------------------------------------------

test('UT-BOARD-00 foldRecords(fold) tolerates junk and never filters on a workspace', () => {
  const scopedEntry = entryRecord(5)
  const reusedA = entryRecord(6, { ws: REUSED_WS_A })
  const reusedB = entryRecord(7, { ws: REUSED_WS_B })
  const view = foldRecords([
    null,
    undefined,
    42,
    'nope',
    {},
    { v: 2, type: 'entry', id: 'x', ws: WS_A, seq: seqFor(9) },
    { v: 1, type: 'signal', id: 'sig_1', ws: WS_A, seq: seqFor(8) },
    { v: 1, type: 'entry', id: 'bad-seq', ws: WS_A, seq: 'not-a-ulid' },
    { v: 1, type: 'context', id: 'ctx_1', ws: WS_A, seq: seqFor(10), key: 'k', value: 'v' },
    scopedEntry,
    reusedA,
    reusedB,
  ])
  assert.equal(view.entryCount, 3, 'entries fold whatever journal wrote them; non-entry types are ignored')
  assert.equal(view.entries.get(scopedEntry.id).title, scopedEntry.title)
  assert.equal(view.entries.get(reusedA.id).title, reusedA.title)
  assert.equal(view.entries.get(reusedB.id).title, reusedB.title)
  assert.equal(view.maxSeq, [scopedEntry.seq, reusedA.seq, reusedB.seq].sort().at(-1))
  assert.deepEqual(foldRecords(undefined).stats, {
    entries: 0,
    openQuestions: 0,
    openHandoffs: 0,
    byKind: {},
  })
})

test('UT-BOARD-01 foldRecords orders by seq, entry first-wins, session last-wins', () => {
  const duplicateLow = entryRecord(1, { title: 'first copy' })
  const duplicateHigh = entryRecord(2, { id: duplicateLow.id, title: 'second copy' })
  const older = sessionRecord(3, { title: 'older title', turns: 1 })
  const newer = sessionRecord(4, { title: 'newer title', turns: 7 })
  for (const records of [
    [duplicateHigh, newer, duplicateLow, older],
    [older, duplicateLow, duplicateHigh, newer],
  ]) {
    const view = foldRecords(records)
    assert.equal(view.entries.size, 1)
    assert.equal(view.entries.get(duplicateLow.id).title, 'first copy', 'first by seq wins')
    assert.equal(view.sessions.size, 1)
    assert.equal(view.sessions.get('session-ledger').title, 'newer title', 'last by seq wins')
    assert.equal(view.sessions.get('session-ledger').turns, 7)
  }
})

test('UT-BOARD-02 foldRecords derives active/open/resolved/superseded and open lists', () => {
  const question = entryRecord(10, { kind: 'question', title: 'Which index?' })
  const resolution = entryRecord(11, {
    kind: 'finding',
    title: 'Use rebuild-once',
    replyTo: question.id,
    resolves: true,
  })
  const reopened = entryRecord(12, {
    kind: 'finding',
    title: 'Actually not resolved',
    replyTo: question.id,
    resolves: false,
  })
  const decisionOld = entryRecord(13, { kind: 'decision', title: 'Pin 0.3.x' })
  const decisionNew = entryRecord(14, {
    kind: 'decision',
    title: 'Pin 0.3.y',
    supersedes: decisionOld.id,
  })
  const handoff = entryRecord(15, { kind: 'handoff', title: 'Continue panel' })
  const gotcha = entryRecord(16, { kind: 'gotcha', title: 'EPERM retries' })

  const view = foldRecords([question, resolution, reopened, decisionOld, decisionNew, handoff, gotcha])
  assert.equal(view.entries.get(question.id).status, 'open', 'latest resolves:false reopens')
  assert.equal(view.entries.get(resolution.id).status, 'active')
  assert.equal(view.entries.get(decisionOld.id).status, 'superseded')
  assert.equal(view.entries.get(decisionNew.id).status, 'active')
  assert.equal(view.entries.get(gotcha.id).status, 'active')
  assert.deepEqual(
    view.openQuestions.map((entry) => entry.id),
    [question.id],
  )
  assert.deepEqual(
    view.openHandoffs.map((entry) => entry.id),
    [handoff.id],
  )
  assert.deepEqual(view.questions.map((entry) => entry.id), [question.id])
  assert.deepEqual(view.handoffs.map((entry) => entry.id), [handoff.id])
  assert.deepEqual(view.stats, {
    entries: 7,
    openQuestions: 1,
    openHandoffs: 1,
    byKind: { question: 1, finding: 2, decision: 2, handoff: 1, gotcha: 1 },
  })
  assert.equal(view.roots.length, 5, 'two replies are not roots')
})

test('UT-BOARD-03 foldRecords tombstone hides the entry and cascades to its thread', () => {
  const root = entryRecord(20, { kind: 'question', title: 'Deleted question' })
  const reply = entryRecord(21, { kind: 'finding', title: 'Reply', replyTo: root.id })
  const survivor = entryRecord(22, { kind: 'finding', title: 'Visible note' })
  const tomb = tombstoneRecord(23, root.id)

  const view = foldRecords([root, reply, survivor, tomb])
  assert.equal(view.entries.has(root.id), false)
  assert.equal(view.entries.has(reply.id), false, 'thread cascades')
  assert.equal(view.entries.has(survivor.id), true)
  assert.equal(view.entryCount, 1)
  assert.equal(view.tombstones.has(root.id), true)
  assert.deepEqual(
    view.hiddenEntries.get(root.id)?.title,
    'Deleted question',
    'hidden original kept for the deleted stub only',
  )
})

test('UT-BOARD-03b foldRecords attaches reused-v0.1 provenance labels (basenames only, ws untouched)', () => {
  const labels = new Map([
    [REUSED_WS_A, 'alpha'],
    [REUSED_WS_B, 'D:\\work\\beta'],
  ])
  const newEntry = entryRecord(30, {
    origin: { workspaceKey: REUSED_WS_A, workspaceLabel: 'alpha' },
  })
  const reusedA = entryRecord(31, { ws: REUSED_WS_A })
  const reusedB = entryRecord(32, { ws: REUSED_WS_B })
  const unknownReused = entryRecord(33, { ws: 'ws_3333333333333333', seq: seqFor(2100) })
  const noOrigin = entryRecord(34)
  const filled = entryRecord(35, { ws: REUSED_WS_A, origin: { workspaceKey: REUSED_WS_A } })
  const hostile = entryRecord(36, {
    ws: REUSED_WS_A,
    origin: { workspaceKey: '../../evil', workspaceLabel: 'C:\\Users\\me\\project' },
  })

  const view = foldRecords(
    [newEntry, reusedA, reusedB, unknownReused, noOrigin, filled, hostile],
    labels,
  )
  assert.deepEqual(view.entries.get(newEntry.id).origin, {
    workspaceKey: REUSED_WS_A,
    workspaceLabel: 'alpha',
  })
  assert.deepEqual(view.entries.get(reusedA.id).origin, {
    workspaceKey: REUSED_WS_A,
    workspaceLabel: 'alpha',
  })
  assert.equal(view.entries.get(reusedA.id).ws, REUSED_WS_A, 'reused records keep their stored ws')
  assert.deepEqual(
    view.entries.get(reusedB.id).origin,
    { workspaceKey: REUSED_WS_B, workspaceLabel: 'beta' },
    'an absolute label is reduced to its basename',
  )
  assert.equal(view.entries.get(unknownReused.id).origin, undefined, 'no label -> no origin block')
  assert.equal(view.entries.get(noOrigin.id).origin, undefined, 'a scoped entry derives no provenance')
  assert.equal(view.entries.get(filled.id).origin.workspaceLabel, 'alpha', 'missing label is filled in')
  assert.deepEqual(
    view.entries.get(hostile.id).origin,
    { workspaceLabel: 'project' },
    'invalid workspace key dropped and path reduced to a basename',
  )
  for (const entry of view.entries.values()) {
    if (entry.origin === undefined) continue
    assert.ok(!/[\\/]/.test(String(entry.origin.workspaceLabel ?? '')), 'never a raw path')
  }
  assert.equal(foldRecords([reusedA]).entries.get(reusedA.id).origin, undefined, 'best-effort without labels')
})

// ---------------------------------------------------------------------------
// BoardService — scoped API, record shape, caps, threads, search
// ---------------------------------------------------------------------------

test('UT-BOARD-04 every kind posts to its workspace journal with provenance origin and the v1 shape', async () => {
  const { board, store } = await makeBoard()
  await board.attach(WS_A, { canonicalPath: 'D:\\05_Code\\alpha', label: 'alpha' })
  const origin = { workspaceKey: REUSED_WS_A, workspaceLabel: 'alpha' }
  let last
  for (const kind of KINDS) {
    last = await board.post(WS_A, { kind, title: `note ${kind}`, body: 'body' }, AUTHOR, origin)
    assert.equal(last.kind, kind)
    assert.equal(last.status, kind === 'question' || kind === 'handoff' ? 'open' : 'active')
    assert.equal(typeof last.id, 'string')
    assert.ok(last.id.startsWith('cnf_'))
    assert.equal(last.seq.length, 26)
  }
  const raw = store.appended(WS_A).at(-1)
  assert.equal(raw.v, 1)
  assert.equal(raw.type, 'entry')
  assert.equal(raw.ws, WS_A, 'the entry record names the workspace journal key')
  assert.deepEqual(raw.origin, origin, 'provenance comes from the caller argument')
  assert.equal(raw.author.sessionId, AUTHOR.sessionId)
  assert.equal(raw.author.origin, 'agent')
  assert.equal('replyTo' in raw, false)
  assert.equal('resolves' in raw, false)

  const stored = store.records(WS_A).find((record) => record.id === raw.id)
  assert.equal(stored.seq, last.seq)
  assert.ok(stored.ts.length > 0)
  assert.equal(board.view(WS_A).entries.get(raw.id).origin.workspaceLabel, 'alpha')
  assert.equal(board.view(WS_B).entryCount, 0, 'notes are isolated to their workspace')

  const plain = await board.post(WS_A, { kind: 'finding', title: 'plain' }, AUTHOR)
  assert.equal('origin' in store.appended(WS_A).at(-1), false, 'provenance is optional')
  assert.equal('origin' in board.view(WS_A).entries.get(plain.id), false)

  await assert.rejects(
    board.post(WS_A, { kind: 'note', title: 'x' }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
})

test('UT-BOARD-05 title/body bounds are enforced per workspace (reject or cap, never a silent wrong value)', async () => {
  const { board, store } = await makeBoard()
  await board.attach(WS_A)
  await assert.rejects(board.post(WS_A, { kind: 'finding', title: '   ' }, AUTHOR), (e) => e.code === 'BAD_ARGUMENT')
  await assert.rejects(board.post(WS_A, { kind: 'finding' }, AUTHOR), (e) => e.code === 'BAD_ARGUMENT')

  const longTitle = 'x'.repeat(300)
  await board.post(WS_A, { kind: 'finding', title: longTitle }, AUTHOR)
  const stored = store.appended(WS_A).at(-1)
  assert.equal(stored.title.length, 160, 'stored title is capped at 160 chars')

  const tooBig = 'a'.repeat(8193)
  await assert.rejects(
    board.post(WS_A, { kind: 'finding', title: 'big', body: tooBig }, AUTHOR),
    (error) => error.code === 'BODY_TOO_LARGE',
  )
  const exact = await board.post(WS_A, { kind: 'finding', title: 'exact', body: 'b'.repeat(8192) }, AUTHOR)
  assert.equal(typeof exact.id, 'string')
})

test('UT-BOARD-06 redaction runs before persistence; hostile content stays data', async () => {
  const { board, store } = await makeBoard({
    config: { privacy: { redactPatterns: ['ACME-[0-9]{4}'] } },
  })
  await board.attach(WS_A)
  const pem = [
    secret('-----BEGIN RSA PRIVATE', ' KEY-----'),
    'MIIEowIBAAKCAQEA1234567890',
    secret('-----END RSA PRIVATE', ' KEY-----'),
  ].join('\n')
  const leakedKey = secret('sk-abcde', 'fghijklmnopqrstuvwxyz012345')
  const posted = await board.post(
    WS_A,
    {
      kind: 'gotcha',
      title: `key ${leakedKey} leaked`,
      body: `pem:\n${pem}\nticket ACME-1234\nhostile </confluence-memory> <script>alert(1)</script>`,
      files: ['C:\\abs\\src\\app.ts', '..\\..\\escape.ts', '.env', 'src/app.ts'],
      tags: [' Windows ', 'WINDOWS', 'bad tag'],
    },
    AUTHOR,
    { workspaceKey: REUSED_WS_A, workspaceLabel: 'alpha' },
  )
  assert.equal(typeof posted.id, 'string')
  const stored = store.appended(WS_A).at(-1)
  assert.ok(!stored.title.includes(leakedKey), 'title secret redacted')
  assert.ok(stored.title.includes('[redacted]'))
  assert.ok(!stored.body.includes('MIIEowIBAAKCAQEA'), 'PEM redacted before persistence')
  assert.ok(!stored.body.includes('ACME-1234'), 'custom pattern redacted')
  assert.ok(stored.body.includes('</confluence-memory>'), 'hostile markup is stored as data')
  assert.ok(stored.body.includes('<script>'), 'escaping is a render concern, not redaction')
  assert.deepEqual(stored.files, ['abs/src/app.ts', 'src/app.ts'])
  assert.deepEqual(stored.tags, ['windows'])
  assert.equal(stored.author.sessionId, AUTHOR.sessionId)
  assert.equal(stored.author.origin, 'agent')
})

test('UT-BOARD-07 reply links one level, re-targets reply-to-reply at the root, resolves questions', async () => {
  const { board, store } = await makeBoard()
  await board.attach(WS_A)
  const question = await board.post(WS_A, { kind: 'question', title: 'CI timezone?' }, AUTHOR)
  const reply = await board.post(
    WS_A,
    { kind: 'finding', title: 'TZ=UTC', body: 'Set TZ=UTC in the test step.', replyTo: question.id },
    { sessionId: 'session-b', title: 'Test triage', origin: 'agent' },
    { workspaceKey: REUSED_WS_B, workspaceLabel: 'beta' },
  )
  const second = await board.post(
    WS_A,
    { kind: 'finding', title: 'Confirmed', replyTo: reply.id, resolves: true },
    AUTHOR,
  )
  assert.equal(second.status, 'resolved')
  const records = store.appended(WS_A)
  assert.equal(records.find((record) => record.id === reply.id).replyTo, question.id)
  assert.equal(records.find((record) => record.id === second.id).replyTo, question.id, 're-targeted to root')
  assert.equal(records.find((record) => record.id === reply.id).origin.workspaceLabel, 'beta')

  const thread = await board.thread(WS_A, question.id)
  assert.equal(thread.entry.status, 'resolved')
  assert.equal(thread.resolved, true)
  assert.deepEqual(
    thread.replies.map((note) => note.id),
    [reply.id, second.id],
    'replies render in seq order',
  )

  // Another workspace cannot read this thread.
  assert.equal((await board.thread(WS_B, question.id)).notFound, true)

  // Re-open is append-only and wins by seq.
  await board.post(WS_A, { kind: 'finding', title: 'Wrong, reopened', replyTo: question.id, resolves: false }, AUTHOR)
  const reopenedThread = await board.thread(WS_A, question.id)
  assert.equal(reopenedThread.entry.status, 'open')
  assert.equal(reopenedThread.resolved, false)

  await assert.rejects(
    board.post(WS_A, { kind: 'finding', title: 'bad', replyTo: 'cnf_nope' }, AUTHOR),
    (error) => error.code === 'UNKNOWN_REF',
  )
  await assert.rejects(
    board.post(WS_A, { kind: 'finding', title: 'bad', resolves: true }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
})

test('UT-BOARD-07b resolves is rejected on non-question/handoff roots; supersedes marks the target', async () => {
  const { board } = await makeBoard()
  await board.attach(WS_A)
  const finding = await board.post(WS_A, { kind: 'finding', title: 'A finding' }, AUTHOR)
  await assert.rejects(
    board.post(WS_A, { kind: 'finding', title: 'reply', replyTo: finding.id, resolves: true }, AUTHOR),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  const replacement = await board.post(
    WS_A,
    { kind: 'decision', title: 'Replacement decision', supersedes: finding.id },
    AUTHOR,
  )
  assert.equal(replacement.status, 'active')
  const thread = await board.thread(WS_A, finding.id)
  assert.equal(thread.superseded, true)
  await assert.rejects(
    board.post(WS_A, { kind: 'decision', title: 'bad', supersedes: 'cnf_nope' }, AUTHOR),
    (error) => error.code === 'UNKNOWN_REF',
  )
})

test('UT-BOARD-08 thread returns a content-free deleted stub for a tombstoned note', async () => {
  const { board, store } = await makeBoard()
  await board.attach(WS_A)
  const posted = await board.post(WS_A, { kind: 'gotcha', title: 'Will be removed', body: 'secret body' }, AUTHOR)
  // No delete tool exists; append a tombstone through the journal to exercise the reader.
  store.externalAppend(WS_A, {
    type: 'tombstone',
    id: `tmb_${seqFor(999)}`,
    target: posted.id,
  })
  const thread = await board.thread(WS_A, posted.id)
  assert.equal(thread.notFound, false)
  assert.equal(thread.entry.deleted, true)
  assert.equal(thread.entry.id, posted.id)
  assert.equal('title' in thread.entry, false, 'deleted stub has no content')
  assert.equal('body' in thread.entry, false)
  assert.deepEqual(thread.replies, [])

  const missing = await board.thread(WS_A, 'cnf_missing')
  assert.equal(missing.notFound, true)
  assert.equal(missing.entry, null)
})

test('UT-BOARD-09 search ranks title > tag > body within one workspace, filters and truncates', async () => {
  const { board } = await makeBoard()
  await board.attach(WS_A)
  await board.attach(WS_B)
  const titleMatch = await board.post(WS_A, { kind: 'decision', title: 'Windows rename retries', body: 'x' }, AUTHOR)
  const tagMatch = await board.post(
    WS_A,
    { kind: 'gotcha', title: 'Other trap', body: 'unrelated', tags: ['windows'] },
    AUTHOR,
  )
  const bodyMatch = await board.post(
    WS_A,
    { kind: 'finding', title: 'Something else', body: `${'y'.repeat(300)} windows ${'z'.repeat(300)}` },
    AUTHOR,
  )
  const supersededTitle = await board.post(WS_A, { kind: 'decision', title: 'Windows decision old' }, AUTHOR)
  const newDecision = await board.post(
    WS_A,
    { kind: 'decision', title: 'Windows decision new', supersedes: supersededTitle.id },
    AUTHOR,
  )
  const otherWorkspaceNote = await board.post(WS_B, { kind: 'finding', title: 'Windows note in another workspace' }, AUTHOR)

  const all = await board.search(WS_A, { query: 'WINDOWS' })
  assert.equal(all.truncated, false)
  assert.equal(all.hits.length, 5, 'the other workspace note is not searched')
  const rankedIds = all.hits.map((hit) => hit.entry.id)
  assert.ok(rankedIds.includes(titleMatch.id))
  assert.ok(rankedIds.includes(newDecision.id))
  assert.ok(
    Math.max(rankedIds.indexOf(titleMatch.id), rankedIds.indexOf(newDecision.id)) <
      rankedIds.indexOf(tagMatch.id),
    'title weight 3 beats tag/body',
  )
  assert.ok(
    rankedIds.indexOf(supersededTitle.id) < rankedIds.indexOf(tagMatch.id),
    'superseded title (rank 2.5) still beats a tag-only match',
  )
  assert.ok(rankedIds.indexOf(tagMatch.id) < rankedIds.indexOf(bodyMatch.id), 'tag weight 2 beats body 1')
  for (const hit of all.hits) {
    assert.ok([...hit.snippet].length <= 200, 'snippet ≤ 200 chars')
    assert.ok(hit.score > 0)
  }

  const limited = await board.search(WS_A, { query: 'windows', limit: 2 })
  assert.equal(limited.hits.length, 2)
  assert.equal(limited.truncated, true)

  const byKind = await board.search(WS_A, { query: 'windows', kind: 'gotcha' })
  assert.deepEqual(
    byKind.hits.map((hit) => hit.entry.id),
    [tagMatch.id],
  )
  const byTag = await board.search(WS_A, { query: 'windows', tag: 'WINDOWS' })
  assert.deepEqual(
    byTag.hits.map((hit) => hit.entry.id),
    [tagMatch.id],
  )
  assert.deepEqual(
    (await board.search(WS_B, { query: 'windows' })).hits.map((hit) => hit.entry.id),
    [otherWorkspaceNote.id],
    'a workspace search only sees its own notes',
  )
  await assert.rejects(board.search(WS_A, { query: '   ' }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(board.search(WS_A, { query: 'x', kind: 'nope' }), (error) => error.code === 'BAD_ARGUMENT')
})

test('UT-BOARD-10 the note cap is enforced per workspace (bus.notes.maxEntries + v0.2 fallback)', async () => {
  const { board } = await makeBoard({ config: { bus: { notes: { maxEntries: 3 } } } })
  await board.attach(WS_A)
  await board.attach(WS_B)
  await board.post(WS_A, { kind: 'finding', title: 'a1' }, AUTHOR)
  await board.post(WS_A, { kind: 'finding', title: 'a2' }, AUTHOR)
  await board.post(WS_A, { kind: 'finding', title: 'a3' }, AUTHOR)
  await assert.rejects(
    board.post(WS_A, { kind: 'finding', title: 'a4' }, AUTHOR),
    (error) => error.code === 'BOARD_FULL' && /this workspace/.test(error.message),
  )
  assert.deepEqual(board.stats(WS_A).entries, 3)
  // Another workspace has its own cap.
  await board.post(WS_B, { kind: 'finding', title: 'b1' }, AUTHOR)
  assert.equal(board.stats(WS_B).entries, 1)

  // The deprecation-mapped v0.2 key still caps the board when bus.notes is absent.
  const fallback = await makeBoard({ config: { store: { maxEntriesPerWorkspace: 2 } } })
  await fallback.board.attach(WS_A)
  await fallback.board.post(WS_A, { kind: 'finding', title: 'f1' }, AUTHOR)
  await fallback.board.post(WS_A, { kind: 'finding', title: 'f2' }, AUTHOR)
  await assert.rejects(
    fallback.board.post(WS_A, { kind: 'finding', title: 'f3' }, AUTHOR),
    (error) => error.code === 'BOARD_FULL',
  )
})

test('UT-BOARD-11 attach/view/refresh/detach are per-workspace, idempotent and never throw on reads', async () => {
  const cfg = baseConfig()
  const store = fakeScopedStore()
  const board = new BoardService({
    store,
    config: cfg,
    redactor: createRedactor(cfg),
    deps: { now: () => 1700000000000, random: () => 0.5 },
  })
  await assert.rejects(
    board.post(WS_A, { kind: 'finding', title: 'x' }, AUTHOR),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  assert.equal(board.view(WS_A).entryCount, 0, 'an unattached view is safely empty')
  assert.deepEqual(board.stats(WS_A).byKind, {})
  assert.equal((await board.thread(WS_A, 'cnf_x')).notFound, true)
  assert.deepEqual((await board.search(WS_A, { query: 'x' })).hits, [])
  await assert.rejects(board.attach(''), (error) => error.code === 'BAD_ARGUMENT')

  await board.attach(WS_A, { canonicalPath: 'D:\\05_Code\\alpha', label: 'alpha' })
  await Promise.all([board.attach(WS_A), board.attach(WS_A)])
  await board.attach(WS_A)
  assert.equal(store.counters.openByKey.get(WS_A), 1, 'one journal per scope')
  assert.equal(store.scopes.get(WS_A).meta.label, 'alpha', 'attach forwards the workspace metadata')
  await board.attach(WS_B, { canonicalPath: 'D:\\05_Code\\beta', label: 'beta' })
  assert.equal(store.counters.openByKey.get(WS_B), 1)

  await board.post(WS_A, { kind: 'finding', title: 'x' }, AUTHOR)
  assert.equal(board.view(WS_A).entryCount, 1)
  assert.equal(board.view(WS_B).entryCount, 0, 'each scope has its own fold')
  await board.refresh(WS_A)
  assert.ok(store.counters.refreshMerged.filter((key) => key === WS_A).length >= 2, 'attach + explicit refresh')
  assert.equal(board.view(WS_A).entryCount, 1, 'refresh keeps the same records')

  // A store-evicted journal is re-opened by the next write (LRU hand-off).
  store.closeScope(WS_B)
  await board.post(WS_B, { kind: 'finding', title: 'after eviction' }, AUTHOR)
  assert.equal(store.counters.openByKey.get(WS_B), 2, 'the write re-opens the evicted journal')
  assert.equal(board.view(WS_B).entryCount, 1)

  // detach drops this board's scope state; the store journal stays open for other services.
  board.detach(WS_A)
  assert.equal(board.view(WS_A).entryCount, 0)
  assert.equal(store.scopes.get(WS_A).isOpen, true, 'detach never closes the shared store journal')
  await assert.rejects(
    board.post(WS_A, { kind: 'finding', title: 'x' }, AUTHOR),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )

  const unsupported = new BoardService({ store: {}, config: cfg, redactor: createRedactor(cfg) })
  await assert.rejects(unsupported.attach(WS_A), (error) => error.code === 'STORE_UNAVAILABLE')
})

test('UT-BOARD-12 append-only; author is caller-supplied; origin cannot spoof a path or key', async () => {
  const { board, store } = await makeBoard()
  await board.attach(WS_A)
  const first = await board.post(WS_A, { kind: 'finding', title: 'one', body: 'immutable' }, AUTHOR)
  const countBefore = store.appended(WS_A).length
  await board.post(WS_A, { kind: 'finding', title: 'two' }, AUTHOR)
  assert.equal(store.appended(WS_A).length, countBefore + 1, 'one append per post')
  assert.equal(store.records(WS_A).find((record) => record.id === first.id).body, 'immutable')

  const spoof = await board.post(
    WS_A,
    { kind: 'finding', title: 'spoof', files: ['session-victim/author'] },
    { sessionId: 'session-attacker', title: 'Attacker', origin: 'user' },
    { workspaceKey: '../../etc/passwd', workspaceLabel: 'C:\\Users\\me\\secret project' },
  )
  const raw = store.appended(WS_A).at(-1)
  assert.equal(raw.author.sessionId, 'session-attacker')
  assert.equal(raw.author.origin, 'user')
  assert.equal(raw.ws, WS_A, 'the caller cannot redirect the journal via origin')
  assert.deepEqual(raw.files, ['session-victim/author'])
  assert.deepEqual(raw.origin, { workspaceLabel: 'secret project' }, 'invalid key dropped, label basename only')
  assert.equal(raw.origin.workspaceLabel.includes('\\'), false)
  assert.equal(board.view(WS_A).entries.get(spoof.id).origin.workspaceLabel, 'secret project')

  const keyOnly = await board.post(
    WS_A,
    { kind: 'finding', title: 'key only' },
    AUTHOR,
    { workspaceKey: REUSED_WS_A },
  )
  assert.deepEqual(store.appended(WS_A).at(-1).origin, { workspaceKey: REUSED_WS_A })
  assert.equal('workspaceLabel' in board.view(WS_A).entries.get(keyOnly.id).origin, false)
})

test('UT-BOARD-13 stats/view expose deterministic per-workspace counts', async () => {
  const { board } = await makeBoard()
  await board.attach(WS_A)
  const question = await board.post(WS_A, { kind: 'question', title: 'q1' }, AUTHOR)
  await board.post(WS_A, { kind: 'handoff', title: 'h1' }, AUTHOR)
  await board.post(WS_A, { kind: 'finding', title: 'f1' }, AUTHOR)
  await board.post(WS_A, { kind: 'finding', title: 'answer', replyTo: question.id, resolves: true }, AUTHOR)
  const stats = board.stats(WS_A)
  assert.equal(stats.entries, 4)
  assert.equal(stats.openQuestions, 0)
  assert.equal(stats.openHandoffs, 1)
  assert.deepEqual(stats.byKind, { question: 1, handoff: 1, finding: 2 })
  const view = board.view(WS_A)
  assert.equal(view.entryCount, 4)
  assert.equal(view.roots.length, 3)
  assert.equal(view.maxSeq, view.entries.get([...view.entries.keys()].at(-1)).seq)
  assert.equal(board.view(WS_A), view, 'an unchanged store returns the cached fold')
})

test('UT-BOARD-14 one workspace board; a note from another writer appears, other workspaces stay empty', async () => {
  const { board, store } = await makeBoard()
  await board.attach(WS_A)
  await board.attach(WS_B)
  const posted = await board.post(
    WS_A,
    { kind: 'finding', title: 'Windows scanner holds the handle', body: 'retry with backoff' },
    AUTHOR,
    { workspaceKey: REUSED_WS_A, workspaceLabel: 'alpha' },
  )
  assert.equal(board.view(WS_A).entryCount, 1)
  assert.equal(board.view(WS_B).entryCount, 0)

  // A note written by another session/writer in the same workspace appears via the change feed.
  const remote = store.externalAppend(WS_A, {
    type: 'entry',
    id: `cnf_${seqFor(777)}`,
    kind: 'decision',
    title: 'Pinned 0.3.0',
    author: { sessionId: 'session-other', title: 'Other work', origin: 'agent' },
  })
  const refreshed = board.view(WS_A)
  assert.equal(refreshed.entries.size, 2, 'a journal change invalidates the derived cache')
  assert.equal(refreshed.entries.get(remote.id).title, 'Pinned 0.3.0')
  assert.equal(board.view(WS_B).entryCount, 0, 'the other workspace never sees it')
  assert.deepEqual(
    (await board.search(WS_A, { query: 'windows' })).hits.map((hit) => hit.entry.id),
    [posted.id],
  )
  assert.deepEqual((await board.search(WS_B, { query: 'windows' })).hits, [])
})

test('UT-BOARD-15 a journal-only store surface still folds (transitional seam)', async () => {
  const records = []
  let sequence = 0
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
  const store = {
    async openWorkspace(wsKey) {
      assert.equal(wsKey, WS_A)
      return journal
    },
  }
  const cfg = baseConfig()
  const board = new BoardService({ store, config: cfg, redactor: createRedactor(cfg) })
  await board.attach(WS_A)
  assert.equal(board.journalFor(WS_A), journal)
  const posted = await board.post(WS_A, { kind: 'finding', title: 'fallback works' }, AUTHOR)
  assert.equal(board.stats(WS_A).entries, 1)
  assert.equal(board.view(WS_A).entries.get(posted.id).title, 'fallback works')
  await board.refresh(WS_A)
  assert.equal(board.view(WS_A).entryCount, 1)
})
