// WP3a tests — universal session ledger: global journal writes, provenance origin, metadata-only
// capture, coalescing, file hints, global cap, merged/all-session read view.
// Contract: docs/adr/0007-universal-memory-scope.md; docs/plan/scope-refactor-delta.md §5;
// docs/design/ledger-recall.md §2, §6, §8 L1–L6.
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SessionLedger, foldSessionRows, workspaceKeyFor } from '../lib/ledger.js'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')

const GLOBAL_WS = 'ws_0000000000000000'
const WS_A = 'ws_1111111111111111'
const WS_B = 'ws_2222222222222222'
const LEGACY_WS = 'ws_0123456789abcdef'

const DIR_A = path.resolve(os.tmpdir(), 'confluence-ledger-project-a')
const DIR_B = path.resolve(os.tmpdir(), 'confluence-ledger-project-b')
const ABS_INSIDE = path.join(DIR_A, 'src', 'inside.ts')
const ABS_OUTSIDE = path.resolve(os.tmpdir(), 'confluence-ledger-outside', 'x.ts')

const ALLOWED_SESSION_KEYS = new Set([
  'v',
  'type',
  'id',
  'ws',
  'seq',
  'ts',
  'title',
  'status',
  'turns',
  'lastActivityTs',
  'effectiveDir',
  'files',
  'parentSession',
  'origin',
  'redactions',
])

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
  const records = []
  const presence = {}
  let seqCounter = 0
  const journal = {
    wsKey,
    dir: path.join(os.tmpdir(), 'confluence-fake-journal', wsKey),
    records: () => records.slice(),
    async append(record) {
      seqCounter += 1
      const stored = {
        v: 1,
        seq: '01J' + String(seqCounter).padStart(23, '0'),
        ts: new Date().toISOString(),
        ...record,
        ws: record.ws ?? wsKey,
      }
      records.push(stored)
      return stored
    },
    async refresh() {
      return false
    },
    async writePresence(data) {
      presence[data.writerId] = JSON.parse(JSON.stringify(data))
    },
    async readPresence() {
      return JSON.parse(JSON.stringify(presence))
    },
    async deletePresence(writerId) {
      delete presence[writerId]
    },
  }
  return journal
}

/**
 * Fake JournalStore: one global journal (memory) + a read-only legacy record array. Sessions are
 * never partitioned by workspace; `mergedRecords()` is the universal read source.
 */
function makeStore() {
  const journal = makeJournal(GLOBAL_WS)
  const legacyRecords = []
  const legacyLabels = new Map([[LEGACY_WS, 'project-old']])
  const opens = { global: 0 }
  return {
    writerId: '4242-abcdef01',
    journal,
    legacyRecords,
    legacyLabels,
    opens,
    async openGlobal() {
      opens.global += 1
      return journal
    },
    mergedRecords() {
      return [...journal.records(), ...legacyRecords]
    },
    legacyView() {
      return { records: [], labels: legacyLabels }
    },
    onMergedChange() {
      return () => {}
    },
    async refreshMerged() {
      return false
    },
  }
}

/** Deterministic canonicalizer: resolve + win32 fold, no filesystem I/O. */
function canonical(pathValue) {
  let value = path.resolve(pathValue).replace(/[\\/]+$/, '')
  if (process.platform === 'win32') value = value.toLowerCase()
  return value
}

/** Provenance resolver shaped like lib/workspace.js `createOriginResolver()`. */
function makeOriginResolver(bySessionId = {}) {
  return {
    async resolve(session) {
      const id = session?.id ?? session?.header?.id
      return bySessionId[id] ?? null
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
      if (handler) return handler(...args)
      return undefined
    },
  }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const DEFAULT_ORIGINS = {
  'session-a': { workspaceKey: WS_A, workspaceLabel: 'project-a' },
  'session-b': { workspaceKey: WS_B, workspaceLabel: 'project-b' },
  'session-q': { workspaceKey: WS_A, workspaceLabel: 'project-a' },
}

function createLedger(options = {}) {
  const clock = options.clock ?? makeClock()
  const store = options.store ?? makeStore()
  const ledger = new SessionLedger({
    store,
    config: options.config ?? {},
    logger: options.logger ?? { warn() {}, debug() {} },
    deps: {
      now: clock.now,
      originResolver: options.originResolver ?? makeOriginResolver(DEFAULT_ORIGINS),
      canonicalizeDir: canonical,
      redactor: options.redactor,
    },
  })
  return { ledger, clock, store }
}

function session(id = 'session-a', header = {}) {
  return { id, header: { id, cwd: DIR_A, ...header } }
}

async function feed(ledger, targetSession, events) {
  for (const event of events) ledger.onSessionEvent(targetSession, event)
  await settle()
}

const writeCall = (filePath, turn = 1) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: filePath }) },
})

// ---------------------------------------------------------------------------
// CON-L1/L2 — global journal, provenance, field allow-list, no text stored
// ---------------------------------------------------------------------------

test('CON-L1/L2 universal capture: one global row, origin provenance, no prompt/assistant/tool text', async () => {
  const { ledger, store } = createLedger()
  const target = session('session-a')
  await feed(ledger, target, [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'PROMPT_SECRET_XYZ' }] } },
    { ...writeCall('src/auth/token.ts'), data: { name: 'write', arguments: '{"file_path":"src/auth/token.ts"}', turn: 1 } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'ASSISTANT_SECRET_XYZ' }] } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'TOOL_OUTPUT_SECRET_XYZ' }] } } },
    { type: 'session/title', data: { title: 'Auth  branch\twork' } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ])
  await ledger.flush()

  const records = store.journal.records().filter((record) => record.type === 'session')
  assert.equal(records.length, 1, 'one coalesced row in the single global journal')
  const record = records[0]
  for (const key of Object.keys(record)) {
    assert.ok(ALLOWED_SESSION_KEYS.has(key), `record field "${key}" is outside the allow-list`)
  }
  assert.equal(record.id, 'session-a')
  assert.equal(record.ws, GLOBAL_WS, 'session rows are written to the reserved global scope')
  assert.deepEqual(record.origin, { workspaceKey: WS_A, workspaceLabel: 'project-a' })
  assert.equal(record.status, 'idle')
  assert.equal(record.turns, 3)
  assert.equal(record.title, 'Auth branch work')
  assert.match(record.lastActivityTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(record.files, ['src/auth/token.ts'])
  const bytes = JSON.stringify(records)
  for (const leaked of ['PROMPT_SECRET_XYZ', 'ASSISTANT_SECRET_XYZ', 'TOOL_OUTPUT_SECRET_XYZ']) {
    assert.equal(bytes.includes(leaked), false, `journal must not contain ${leaked}`)
  }
})

test('CON-L1 no-origin session still writes a row (universal memory never blocks on provenance)', async () => {
  const { ledger, store } = createLedger({ originResolver: makeOriginResolver({}) })
  const noDir = { id: 'session-nowhere', header: { id: 'session-nowhere' } }
  await feed(ledger, noDir, [{ type: 'session/title', data: { title: 'No cwd' } }, { type: 'turn/end', data: { turn: 1 } }])
  await ledger.flush()
  const records = store.journal.records().filter((record) => record.type === 'session')
  assert.equal(records.length, 1)
  assert.equal(records[0].id, 'session-nowhere')
  assert.equal('origin' in records[0], false, 'missing origin is valid and absent')
  assert.equal(records[0].ws, GLOBAL_WS)
})

test('CON-L1 tool-reasoning and command lines are never captured', async () => {
  const { ledger, store } = createLedger()
  await feed(ledger, session(), [
    { type: 'assistant/attempt', data: { reasoning: 'REASONING_SECRET' } },
    { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command: 'echo SECRET_CMD' }) } },
    { type: 'user/message', data: { text: 'USER_TEXT_SECRET' } },
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger.flush()
  const bytes = JSON.stringify(store.journal.records())
  for (const leaked of ['REASONING_SECRET', 'SECRET_CMD', 'USER_TEXT_SECRET']) {
    assert.equal(bytes.includes(leaked), false, `journal must not contain ${leaked}`)
  }
})

// ---------------------------------------------------------------------------
// headline: cross-workspace memory
// ---------------------------------------------------------------------------

test('CON-X1 cross-workspace: sessions from different cwds share the one global journal', async () => {
  const { ledger, store } = createLedger()
  await feed(ledger, session('session-a', { cwd: DIR_A }), [
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await feed(ledger, session('session-b', { cwd: DIR_B }), [
    { type: 'turn/end', data: { turn: 2 } },
  ])
  await ledger.flush()

  const rows = store.journal.records().filter((record) => record.type === 'session')
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((row) => [row.id, row.ws, row.origin.workspaceLabel]).sort(),
    [
      ['session-a', GLOBAL_WS, 'project-a'],
      ['session-b', GLOBAL_WS, 'project-b'],
    ],
    'both rows land in global scope with their own provenance label',
  )

  const view = ledger.ledger()
  assert.equal(view.size, 2, 'ledger() returns all sessions regardless of workspace')
  assert.equal(view.get('session-a').origin.workspaceKey, WS_A)
  assert.equal(view.get('session-b').origin.workspaceKey, WS_B)
  // A v0.1.0 workspace argument is tolerated and ignored: still the universal view.
  assert.equal(ledger.ledger(WS_A).size, 2)
})

// ---------------------------------------------------------------------------
// coalescing / forced flush
// ---------------------------------------------------------------------------

test('UT-LEDGER-01 coalesces many events into one append; turn/end forces a flush; flush() is global', async () => {
  const { ledger, store } = createLedger()
  const target = session()
  const events = []
  for (let index = 0; index < 20; index += 1) events.push(writeCall(`src/f${index}.ts`, 1))
  events.push({ type: 'turn/end', data: { turn: 1 } })
  await feed(ledger, target, events)
  await ledger.flush()
  assert.equal(store.journal.records().length, 1, '20 tool calls + turn/end append exactly one coalesced row')

  // A second dirty batch appends exactly one more row (upsert, not one per event).
  await feed(ledger, target, [writeCall('src/late.ts', 2), { type: 'turn/end', data: { turn: 2 } }])
  await ledger.flush('ws_ignored_legacy_argument')
  assert.equal(store.journal.records().length, 2)
})

// ---------------------------------------------------------------------------
// CON-L4 file hints
// ---------------------------------------------------------------------------

test('CON-L4 extractFilesFromToolCall: relative/absolute/apply_patch, deny + escape rules', () => {
  const extract = (name, args) => SessionLedger.extractFilesFromToolCall(name, args, DIR_A)
  assert.deepEqual(extract('write', JSON.stringify({ file_path: 'src/a.ts' })), ['src/a.ts'])
  assert.deepEqual(extract('edit', '{"path":"src\\\\b.ts"}'), ['src/b.ts'])
  assert.deepEqual(extract('create_file', { file_path: ABS_INSIDE }), ['src/inside.ts'])
  assert.deepEqual(extract('write', { path: ABS_OUTSIDE }), [], 'absolute outside the origin dir')
  assert.deepEqual(extract('write', { path: '../escape.ts' }), [], '.. escape')
  assert.deepEqual(extract('write', { path: '.env' }), [], 'deny .env')
  assert.deepEqual(extract('write', { path: 'config/.env.local' }), [], 'deny .env*')
  assert.deepEqual(extract('write', { path: 'keys/server.pem' }), [], 'deny *.pem')
  assert.deepEqual(extract('read', { path: 'src/a.ts' }), [], 'non-hint tool')
  assert.deepEqual(extract('write', 'not json'), [], 'invalid JSON')
  assert.deepEqual(extract('write', { file_path: 'C:\\\\Windows\\\\system.ini' }), [])
  const many = { files: Array.from({ length: 10 }, (_, index) => `src/f${index}.ts`) }
  assert.equal(extract('write', many).length, 8, '≤8 distinct paths')
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.ts',
    '+export const x = 1',
    '*** Update File: src/old.ts',
    '@@',
    '*** End Patch',
  ].join('\n')
  assert.deepEqual(extract('apply_patch', { patch }), ['src/new.ts', 'src/old.ts'])
  assert.deepEqual(extract('write', { files: ['src/a.ts', 'src/a.ts'] }), ['src/a.ts'], 'deduped, order kept')
})

test('CON-L5 tool/ptc-dispatch extraction parity; content is never parsed', () => {
  const direct = SessionLedger.extractFilesFromToolCall(
    'edit',
    JSON.stringify({ file_path: 'src/ptc.ts' }),
    DIR_A,
  )
  const dispatch = SessionLedger.extractFilesFromPtcDispatch(
    { data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/ptc.ts' }), content: 'SECRET_CONTENT' } },
    DIR_A,
  )
  assert.deepEqual(dispatch, direct)
  assert.deepEqual(SessionLedger.extractFilesFromPtcDispatch({ data: { name: 'unknown' } }, DIR_A), [])
})

test('CON-L6 caps: 8 file hints, redacted+160-char title', async () => {
  const { ledger, store } = createLedger({ config: { ledger: { maxFilesPerSession: 20 } } })
  const leakedKey = secret('sk-abcde', 'fghijklmnopqrstuvwx')
  await feed(ledger, session(), [
    { type: 'session/title', data: { title: 'x '.repeat(200) + leakedKey } },
    ...Array.from({ length: 12 }, (_, index) => writeCall(`src/hint-${index}.ts`)),
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger.flush()
  const record = store.journal.records()[0]
  assert.equal(record.files.length, 8, 'configured cap clamps to the data-model hard cap of 8')
  assert.ok([...record.title].length <= 160)
  assert.equal(record.title.includes(leakedKey), false, 'title redacted')
})

// ---------------------------------------------------------------------------
// suppression
// ---------------------------------------------------------------------------

test('CON-L7 private sessions write no rows; the removed disabledWorkspaces key no longer suppresses', async () => {
  const { ledger, store } = createLedger({
    config: { privacy: { privateSessions: ['session-p'], disabledWorkspaces: [WS_A] } },
  })
  await feed(ledger, session('session-p'), [writeCall('src/a.ts'), { type: 'turn/end', data: { turn: 1 } }])
  await feed(ledger, session('session-q'), [writeCall('src/b.ts'), { type: 'turn/end', data: { turn: 1 } }])
  await ledger.flush()
  const records = store.journal.records()
  assert.equal(records.length, 1, 'only the non-private session is captured')
  assert.equal(records[0].id, 'session-q')
})

// ---------------------------------------------------------------------------
// read view / upsert / legacy merge / effective dir
// ---------------------------------------------------------------------------

test('CON-L3 universal ledger view: last-wins by seq, most recent first, merged legacy rows', async () => {
  const { ledger, store } = createLedger({ config: { ledger: { maxSessions: 20 } } })
  await feed(ledger, session(), [{ type: 'turn/end', data: { turn: 1 } }])
  await ledger.flush()
  const journal = store.journal
  assert.equal(ledger.ledger().size, 1)

  // Manually append an older and a newer row for other sessions (same global journal).
  await journal.append({
    type: 'session',
    id: 'session-old',
    ws: GLOBAL_WS,
    seq: '01J000000000000000000000A',
    title: 'old',
    status: 'idle',
    turns: 1,
    lastActivityTs: '2026-11-13T00:00:00.000Z',
  })
  await journal.append({
    type: 'session',
    id: 'session-new',
    ws: GLOBAL_WS,
    seq: '01J000000000000000000000B',
    title: 'new',
    status: 'idle',
    turns: 2,
    lastActivityTs: '2026-11-13T01:00:00.000Z',
  })
  await journal.append({
    type: 'session',
    id: 'session-new',
    ws: GLOBAL_WS,
    seq: '01J000000000000000000000C',
    title: 'newest',
    status: 'live',
    turns: 3,
    lastActivityTs: '2026-11-13T02:00:00.000Z',
  })
  // A read-only legacy per-workspace row is merged into the universal view unchanged; its
  // manifest label becomes the provenance label of the derived origin.
  store.legacyRecords.push({
    type: 'session',
    id: 'session-legacy',
    ws: LEGACY_WS,
    seq: '01J000000000000000000000D',
    title: 'legacy',
    status: 'idle',
    lastActivityTs: '2026-11-13T01:30:00.000Z',
  })
  const merged = ledger.ledger()
  assert.equal(merged.get('session-new').title, 'newest')
  assert.equal(merged.get('session-new').status, 'live')
  assert.equal([...merged.keys()][0], 'session-new', 'most recently active first')
  assert.equal(merged.get('session-legacy').title, 'legacy', 'legacy rows are visible in universal memory')
  assert.equal(merged.get('session-legacy').ws, LEGACY_WS, 'legacy provenance is not rewritten')
  assert.deepEqual(
    merged.get('session-legacy').origin,
    { workspaceKey: LEGACY_WS, workspaceLabel: 'project-old' },
    'legacy manifest labels supply a basename-only origin',
  )
  // Reader clones: mutating the returned row never mutates the journal record.
  merged.get('session-new').title = 'tampered'
  assert.equal(ledger.ledger().get('session-new').title, 'newest')
})

test('foldSessionRows is pure, has no workspace filter and caps at maxSessions', () => {
  const records = Array.from({ length: 30 }, (_, index) => ({
    type: 'session',
    id: `session-${index}`,
    ws: index % 2 === 0 ? GLOBAL_WS : LEGACY_WS,
    seq: `01J${String(index).padStart(23, '0')}`,
    lastActivityTs: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }))
  const view = foldSessionRows(records, 20)
  assert.equal(view.size, 20)
  assert.ok(view.has('session-29'), 'newest kept')
  assert.equal(view.has('session-0'), false, 'oldest dropped by the global cap')
  assert.equal(foldSessionRows(records, 100).size, 30, 'no workspace filtering: all rows are candidates')
})

test('ledger cap: config.ledger.maxSessions, default 200, old maxSessionsPerWorkspace tolerated', async () => {
  const configs = [
    [{ ledger: { maxSessions: 25 } }, 25],
    [{ ledger: { maxSessionsPerWorkspace: 30 } }, 30],
    [{}, 200],
    [{ ledger: { maxSessions: 5 } }, 20],
    [{ ledger: { maxSessions: 5000 } }, 1000],
  ]
  for (const [config, expected] of configs) {
    const { ledger } = createLedger({ config })
    assert.equal(ledger.maxSessions, expected, `cap for ${JSON.stringify(config)}`)
  }

  // The configured cap shapes the universal view, not a per-workspace slice.
  const { ledger, store } = createLedger({ config: { ledger: { maxSessions: 20 } } })
  for (let index = 0; index < 25; index += 1) {
    await store.journal.append({
      type: 'session',
      id: `session-${index}`,
      ws: GLOBAL_WS,
      lastActivityTs: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    })
  }
  const view = ledger.ledger()
  assert.equal(view.size, 20)
  assert.ok(view.has('session-24'), 'newest kept')
  assert.equal(view.has('session-0'), false, 'oldest dropped')
})

test('working-directory/change records effectiveDir only when it differs from the session origin dir', async () => {
  const { ledger, store } = createLedger()
  const moved = path.join(DIR_A, 'src', 'auth')
  await feed(ledger, session('session-a'), [
    { type: 'working-directory/change', data: { directory: moved } },
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger.flush()
  assert.equal(store.journal.records()[0].effectiveDir, moved)

  const { ledger: ledger2, store: store2 } = createLedger()
  await feed(ledger2, session('session-b', { cwd: DIR_B }), [
    { type: 'working-directory/change', data: { cwd: DIR_B } },
    { type: 'turn/end', data: { turn: 1 } },
  ])
  await ledger2.flush()
  assert.equal(store2.journal.records()[0].effectiveDir, undefined)
})

test('attach subscribes to session/event and dispose flushes pending rows', async () => {
  const { ledger, store } = createLedger()
  const ctx = makeCtx()
  const disposer = ledger.attach(ctx)
  ctx.emit('session/event', session(), { type: 'session/title', data: { title: 'Titled' } })
  await settle()
  await ledger.dispose()
  disposer()
  const records = store.journal.records()
  assert.equal(records.length, 1)
  assert.equal(records[0].title, 'Titled')
  assert.equal(records[0].ws, GLOBAL_WS)
})

test('workspace key helper matches the origin provenance derivation', () => {
  assert.match(workspaceKeyFor('D:\\\\05_Code\\\\solo-bench'), /^ws_[0-9a-f]{16}$/)
  assert.equal(workspaceKeyFor('same'), workspaceKeyFor('same'))
  assert.notEqual(workspaceKeyFor('same'), workspaceKeyFor('other'))
})
