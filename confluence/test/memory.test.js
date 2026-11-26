// Confluence / 高级记忆 — v0.4 long-term memory (`pattern`) tests.
//
// Contract: docs/plan/v0.4-interfaces.md §1.1/§1.4/§2.1/§3.2/§5/§8 and
// ADR-0009. Hermetic: an in-memory global-journal double that mimics the
// append surface and validates every appended record, plus real JournalStore
// instances in temp directories for the migration/append-only/read-only cases.
//
// Coverage map:
//   MEM-01  foldPatterns: LWW per key (status included), counts, total on junk
//   MEM-02  add: always candidate, derived keys, envelope, duplicate key refused
//   MEM-03  promote/reject/forget: status transitions, NOT_FOUND, no-op churn-free
//   MEM-04  update: same stable key, new seq, status preserved
//   MEM-05  caps: maxPatterns, body bytes, title/tags/evidence bounds
//   MEM-06  redaction: body/title/evidence secrets, path stripping at render
//   MEM-07  activeFor: global + matching workspace, confidence/seq order
//   MEM-08  renderBlock: §3.2 shape, candidates headline, budgets, escaping, safety
//   MEM-09  list: status/category/query/limit filters and validation
//   MEM-10  importPattern: active/source=import, overwrite, caps
//   MEM-11  migration: tech/context facts -> active patterns, marker, idempotent
//   MEM-12  migration: no legacy facts => no marker; existing keys never rewritten
//   MEM-13  attach without a global journal: empty reads, writes fail STORE_UNAVAILABLE
//   MEM-14  real store: append-only records on disk, no record rewrite
//   MEM-15  real store: read-only attach creates nothing; cross-instance fold persists

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import {
  MEMORY_DEFAULTS,
  MEMORY_MIGRATION_SOURCE,
  MEMORY_MIGRATION_VERSION,
  MemoryService,
  PATTERN_DEFAULT_CONFIDENCE,
  PATTERN_KEY_RE,
  PATTERN_MAX_BODY_BYTES,
  PATTERN_MAX_EVIDENCE,
  PATTERN_MAX_TAGS,
  PATTERN_MAX_TITLE_CHARS,
  foldPatterns,
  hasMigrationMarker,
  legacyProfileFacts,
  memoryRevision,
} from '../lib/memory.js'
import { createRedactor } from '../lib/redact.js'
import { GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import { createUlidFactory, isUlid } from '../lib/util.js'

const NOW = Date.UTC(2026, 10, 19, 2, 0, 0)
const ISO = (ms) => new Date(ms).toISOString()
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_PREFIX = '01J8Z6Q3M0'
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const WS_A = 'ws_aaaaaaaaaaaaaaaa'
const WS_B = 'ws_bbbbbbbbbbbbbbbb'

/** Deterministic 26-char Crockford ULID-like value, ordered by n. */
function seqFor(n) {
  let value = Math.max(0, Math.trunc(n))
  let rest = ''
  for (let index = 0; index < 16; index += 1) {
    rest = CROCKFORD[value % 32] + rest
    value = Math.floor(value / 32)
  }
  return ULID_PREFIX + rest
}

/** Build a credential from fragments so the committed source holds no token literal. */
const secret = (...parts) => parts.join('')
const leakedKey = secret('sk-fixture', '123456789012345678901234')

/** @type {string[]} */
const tempDirs = []
/** @type {JournalStore[]} */
const stores = []

after(async () => {
  for (const store of stores) await store.close().catch(() => {})
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'confluence-memory-'))
  tempDirs.push(dir)
  return dir
}

/** Resolved config with memory overrides (works before/after config.js grows §7). */
function makeConfig(overrides = {}) {
  const config = resolveConfig({}).config
  return {
    ...config,
    memory: { ...MEMORY_DEFAULTS, ...overrides },
  }
}

function makeRedactor(config = makeConfig()) {
  return createRedactor(config, { logger: silentLogger })
}

/** One stored `pattern` record (§1.1). */
function patternRecord(seq, fields = {}) {
  return {
    v: 1,
    type: 'pattern',
    id: `pat_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: ISO(NOW),
    key: 'k',
    category: 'workflow',
    title: 'title',
    body: 'body',
    tags: [],
    scope: 'global',
    status: 'candidate',
    confidence: PATTERN_DEFAULT_CONFIDENCE,
    source: 'agent',
    ...fields,
  }
}

/** One stored v0.3 `profile` record (legacy migration input). */
function profileRecord(seq, fields = {}) {
  return {
    v: 1,
    type: 'profile',
    id: `prf_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: ISO(NOW),
    section: 'tech',
    key: 'fact',
    value: 'value',
    confidence: 0.6,
    source: 'agent',
    ...fields,
  }
}

/** One `memory-migration` marker (§1.4). */
function markerRecord(seq, fields = {}) {
  return {
    v: 1,
    type: 'memory-migration',
    id: `mig_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: ISO(NOW),
    version: MEMORY_MIGRATION_VERSION,
    source: MEMORY_MIGRATION_SOURCE,
    ...fields,
  }
}

/** Assert the §1.1 write contract on a fake-journal append. */
function validateAppendedRecord(record) {
  assert.equal(record.v, 1)
  assert.equal(record.ws, GLOBAL_SCOPE_KEY, 'memory records live only in the global journal')
  if (record.type === 'pattern') {
    assert.match(record.id, /^pat_[0-9A-Z]{26}$/)
    assert.match(record.key, PATTERN_KEY_RE)
    assert.ok(['workflow', 'project', 'domain', 'pitfall', 'heuristic', 'quality'].includes(record.category))
    assert.ok(['candidate', 'active', 'rejected', 'superseded'].includes(record.status))
    assert.ok(['global', 'workspace'].includes(record.scope))
    assert.ok(['agent', 'user', 'import', 'migration'].includes(record.source))
    assert.equal(typeof record.title, 'string')
    assert.equal(typeof record.body, 'string')
    assert.ok(Buffer.byteLength(record.body, 'utf8') <= PATTERN_MAX_BODY_BYTES)
    assert.ok(Array.from(record.title).length <= PATTERN_MAX_TITLE_CHARS)
    assert.ok(Array.isArray(record.tags) && record.tags.length <= PATTERN_MAX_TAGS)
    if (record.evidence !== undefined) assert.ok(Array.isArray(record.evidence) && record.evidence.length <= PATTERN_MAX_EVIDENCE)
    assert.equal(typeof record.confidence, 'number')
    assert.ok(record.confidence >= 0 && record.confidence <= 1)
    if (record.scope === 'workspace') assert.match(record.workspaceKey, /^ws_[0-9a-f]{16}$/)
    return
  }
  if (record.type === 'memory-migration') {
    assert.match(record.id, /^mig_[0-9A-Z]{26}$/)
    assert.equal(record.version, MEMORY_MIGRATION_VERSION)
    assert.equal(record.source, MEMORY_MIGRATION_SOURCE)
    return
  }
  throw new Error(`unexpected appended record type ${record.type}`)
}

/**
 * In-memory global-journal double: `appendAndSync` fills `seq`/`ts` (after any
 * seeded records), validates the shape and notifies `onChange` listeners.
 */
function createFakeStore({ records = [], now = () => NOW, withJournal = true } = {}) {
  const journalRecords = [...records]
  const listeners = new Set()
  let appended = 0
  const journal = {
    records: () => journalRecords,
    onChange(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    async appendAndSync(record) {
      validateAppendedRecord(record)
      appended += 1
      const stored = {
        ws: GLOBAL_SCOPE_KEY,
        seq: seqFor(5000 + appended),
        ts: ISO(typeof now === 'function' ? now() : NOW),
        ...record,
      }
      journalRecords.push(stored)
      for (const listener of [...listeners]) listener(true)
      return stored
    },
    async append(record) {
      return await this.appendAndSync(record)
    },
  }
  const store = {
    rootDir: path.join(tmpdir(), 'fake-memory-store'),
    records: journalRecords,
    calls: { openGlobal: 0, refreshMerged: 0 },
    async init() {},
    async openGlobal() {
      this.calls.openGlobal += 1
      return journal
    },
    globalJournal() {
      return withJournal ? journal : null
    },
    async refreshMerged() {
      this.calls.refreshMerged += 1
      return true
    },
    viewedRecords() {
      return journalRecords
    },
    async close() {},
  }
  return store
}

/** Build an attached service over a fake store (or a caller-supplied one). */
async function createService(options = {}) {
  const config = options.config ?? makeConfig()
  const store = options.store ?? createFakeStore({ records: options.records ?? [], now: options.now })
  let counter = 0
  const service = new MemoryService({
    store,
    config,
    redactor: options.redactor ?? makeRedactor(config),
    logger: silentLogger,
    deps: {
      now: options.now ?? (() => NOW),
      idFactory: options.idFactory ?? (() => seqFor(9000 + (counter += 1))),
    },
  })
  await service.attach(options.attach ?? {})
  return { service, store, config }
}

/** One valid add() input. */
function addInput(fields = {}) {
  return {
    category: 'workflow',
    title: 'Retry file rename',
    body: 'Retry a failed rename once after closing the handle.',
    ...fields,
  }
}

/**
 * Seed a real store with records through the global journal (append-only) and
 * attach a fresh MemoryService to it.
 */
async function createRealService(options = {}) {
  const root = options.root ?? (await tempRoot())
  const config = {
    ...resolveConfig({}).config,
    store: { ...resolveConfig({}).config.store, dir: root, pollMs: 60_000, watch: false },
    memory: { ...MEMORY_DEFAULTS, ...(options.memory ?? {}) },
  }
  let tick = 1_700_000_000_000
  const store = new JournalStore({
    config,
    logger: silentLogger,
    deps: {
      pid: 4101,
      platform: 'win32',
      random: (() => {
        let state = 7
        return () => {
          state = (state * 9301 + 49297) % 233280
          return state / 233280
        }
      })(),
      now: () => {
        tick += 1000
        return tick
      },
      retryDelays: [0, 0, 0],
    },
  })
  stores.push(store)
  await store.init()
  const journal = await store.openGlobal()
  for (const record of options.records ?? []) await journal.append(record)
  const service = new MemoryService({
    store,
    config,
    redactor: makeRedactor(config),
    logger: silentLogger,
    deps: { now: () => NOW },
  })
  await service.attach(options.attach ?? {})
  return { service, store, root, config, journal }
}

/** Read every shipped pattern record from the real store's global shard. */
async function readShardPatterns(root) {
  const dir = path.join(root, 'workspaces', GLOBAL_SCOPE_KEY)
  const names = (await fs.readdir(dir)).filter((name) => /^journal\..*\.jsonl$/.test(name)).sort()
  const records = []
  for (const name of names) {
    const raw = await fs.readFile(path.join(dir, name), 'utf8')
    for (const line of raw.split('\n')) {
      if (line === '') continue
      records.push(JSON.parse(line))
    }
  }
  return records
}

// ---------------------------------------------------------------------------
// MEM-01 — foldPatterns
// ---------------------------------------------------------------------------

test('MEM-01 foldPatterns: per-key LWW (status included), deterministic buckets, total on junk', () => {
  const records = [
    patternRecord(seqFor(10), { key: 'a', status: 'candidate', confidence: 0.9, body: 'candidate body' }),
    patternRecord(seqFor(20), { key: 'a', status: 'active', confidence: 0.9, body: 'active body' }),
    patternRecord(seqFor(30), { key: 'a', status: 'rejected', confidence: 0.9, body: 'rejected body' }),
    patternRecord(seqFor(5), { key: 'b', status: 'active', confidence: 0.4 }),
    patternRecord(seqFor(6), { key: 'c', status: 'active', confidence: 0.8 }),
    patternRecord(seqFor(7), { key: 'd', status: 'candidate' }),
    {
      type: 'style',
      id: 'sty_1',
      ws: GLOBAL_SCOPE_KEY,
      seq: seqFor(8),
      ts: ISO(NOW),
      channel: 'chat',
      area: 'tone',
      key: 'x',
      title: 'x',
      rule: 'y',
      priority: 50,
      enabled: true,
      confidence: 0.8,
      source: 'user',
    },
    // invalid pattern records are ignored by the fold
    patternRecord(seqFor(9), { key: 'Bad Key', status: 'active' }),
    patternRecord(seqFor(11), { key: 'bad-status', status: 'live' }),
    patternRecord(seqFor(12), { key: 'bad-category', category: 'unknown' }),
    patternRecord(seqFor(13), { key: 'no-body', body: '   ' }),
    { type: 'pattern', ws: GLOBAL_SCOPE_KEY, seq: seqFor(14), ts: ISO(NOW), key: 'no-id', category: 'workflow', title: 't', body: 'b', status: 'active' },
    { type: 'pattern', id: 'pat_x', ws: GLOBAL_SCOPE_KEY, seq: 'not-a-ulid', ts: ISO(NOW), key: 'bad-seq', category: 'workflow', title: 't', body: 'b', status: 'active' },
    { not: 'a record' },
    null,
    'nope',
  ]
  const folded = foldPatterns(records)
  assert.equal(folded.counts.total, 4)
  assert.equal(folded.counts.active, 2)
  assert.equal(folded.counts.candidates, 1)
  assert.equal(folded.counts.rejected, 1)
  assert.equal(folded.counts.superseded, 0)
  assert.equal(folded.byKey.get('a').status, 'rejected', 'the greatest seq wins, status included')
  assert.equal(folded.byKey.get('a').body, 'rejected body')
  assert.deepEqual(
    folded.active.map((pattern) => pattern.key),
    ['c', 'b'],
    'active injection pool: confidence desc then seq desc',
  )
  assert.deepEqual(folded.candidates.map((pattern) => pattern.key), ['d'])
  assert.equal(folded.byKey.size, 4)

  // Total on missing/garbage input.
  assert.deepEqual(foldPatterns(undefined).counts, { total: 0, active: 0, candidates: 0, rejected: 0, superseded: 0 })
  assert.deepEqual(foldPatterns([]).byKey.size, 0)

  // revision covers pattern + migration markers only (never style records).
  assert.equal(memoryRevision(records), seqFor(30))
  assert.equal(memoryRevision([{ type: 'style', seq: seqFor(99) }]), null)
  assert.equal(
    memoryRevision([patternRecord(seqFor(3)), markerRecord(seqFor(40))]),
    seqFor(40),
    'a migration marker advances the memory revision',
  )
  assert.equal(hasMigrationMarker(records), false)
  assert.equal(hasMigrationMarker([markerRecord(seqFor(40))]), true)
});

// ---------------------------------------------------------------------------
// MEM-02 — add(): candidate-only writes
// ---------------------------------------------------------------------------

test('MEM-02 add always writes a candidate: derived keys, envelope, defaults, duplicate refused', async () => {
  const { service, store } = await createService()
  const added = await service.add(addInput({ title: 'Retry file rename after EBUSY' }))
  assert.equal(added.status, 'candidate', 'add NEVER writes active (owner decision)')
  assert.equal(added.key, 'retry-file-rename-after-ebusy', 'the key is derived from the title when omitted')
  assert.ok(isUlid(added.seq))
  assert.deepEqual(Object.keys(added.pattern).sort(), [
    'body',
    'category',
    'confidence',
    'key',
    'scope',
    'source',
    'status',
    'tags',
    'title',
    'ts',
  ])
  assert.equal(added.pattern.confidence, MEMORY_DEFAULTS.candidateConfidence)
  assert.equal(added.pattern.source, 'agent')
  assert.equal(added.pattern.scope, 'global')

  const stored = store.records.at(-1)
  assert.equal(stored.type, 'pattern')
  assert.equal(stored.ws, GLOBAL_SCOPE_KEY)
  assert.match(stored.id, /^pat_[0-9A-Z]{26}$/)
  assert.equal(stored.status, 'candidate')
  assert.equal(stored.key, added.key)
  assert.equal(stored.ts, ISO(NOW))

  // Non-latin titles still yield a deterministic valid key.
  const derived = await service.add(addInput({ title: '中文标题：重试路径重命名' }))
  assert.match(derived.key, PATTERN_KEY_RE)
  assert.ok(derived.key.startsWith('pattern-'))

  // list() sees candidates; the injected rule is still empty.
  assert.equal(service.list().count, 2)
  assert.equal(service.list({ status: 'candidate' }).count, 2)
  assert.equal(service.list({ status: 'active' }).count, 0)
  assert.equal(service.pendingCount(), 2)
  assert.match(
    service.renderBlock(),
    /^<confluence-memory-patterns count="0" candidates="2">/,
    'candidate-only memory still renders a bounded headline',
  )

  // Duplicate stable key: refused, use update/promote (an active rule is never demoted).
  await assert.rejects(
    () => service.add(addInput({ key: added.key, title: 'same key' })),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  await assert.rejects(
    () => service.add(addInput({ title: 'Retry file rename after EBUSY' })),
    (error) => error.code === 'BAD_ARGUMENT',
    'the same title derives the same key',
  );

  // Unknown / invalid inputs fail closed.
  await assert.rejects(() => service.add(addInput({ category: 'unknown' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.add(addInput({ key: 'Bad Key' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.add(addInput({ title: '   ' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.add(addInput({ body: '' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.add(addInput({ confidence: 2 })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.add(addInput({ scope: 'workspace' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(
    () => service.add(addInput({ scope: 'workspace', workspaceKey: 'not-a-ws' })),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  const scoped = await service.add(
    addInput({ title: 'Scoped rename', scope: 'workspace', workspaceKey: WS_A, workspaceLabel: 'alpha' }),
  )
  assert.equal(scoped.pattern.scope, 'workspace')
  assert.equal(scoped.pattern.workspaceLabel, 'alpha')
  assert.equal(scoped.pattern.workspaceKey, WS_A, 'the opaque workspace id survives for portability (§2.4)')
});

// ---------------------------------------------------------------------------
// MEM-03 — promote / reject / forget
// ---------------------------------------------------------------------------

test('MEM-03 candidate lifecycle: promote -> active, reject/forget -> rejected, churn-free no-ops', async () => {
  const { service, store } = await createService()
  const first = await service.add(addInput({ key: 'a', title: 'A' }))
  const second = await service.add(addInput({ key: 'b', title: 'B' }))
  const third = await service.add(addInput({ key: 'c', title: 'C' }))

  const promoted = await service.promote({ key: 'a', author: { sessionId: 'session-1', title: 'Confirm' } })
  assert.equal(promoted.status, 'active')
  assert.ok(promoted.seq > first.seq)
  assert.equal(promoted.pattern.status, 'active')
  assert.equal(promoted.pattern.title, 'A', 'promote keeps the content')
  assert.equal(service.list({ status: 'active' }).count, 1)
  assert.equal(service.list({ status: 'candidate' }).count, 2)
  assert.equal(service.pendingCount(), 2)
  const afterPromote = store.records.length

  // Promote is idempotent: no record churn once active.
  const again = await service.promote({ key: 'a' })
  assert.equal(again.seq, promoted.seq)
  assert.equal(store.records.length, afterPromote)

  const rejected = await service.reject({ key: second.key })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.pattern.body, second.pattern.body)
  const forgotten = await service.forget({ key: third.key })
  assert.equal(forgotten.status, 'rejected')
  assert.equal(service.list({ status: 'rejected' }).count, 2)
  assert.equal(service.pendingCount(), 0)

  // Unknown keys and invalid keys fail with the documented codes.
  await assert.rejects(() => service.promote({ key: 'missing' }), (error) => error.code === 'NOT_FOUND')
  await assert.rejects(() => service.reject({ key: 'missing' }), (error) => error.code === 'NOT_FOUND')
  await assert.rejects(() => service.forget({ key: 'missing' }), (error) => error.code === 'NOT_FOUND')
  await assert.rejects(() => service.promote({ key: 'Bad Key' }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.promote({}), (error) => error.code === 'BAD_ARGUMENT')

  // A rejected pattern can be revived only by an explicit promote (not by add).
  const revived = await service.promote({ key: second.key })
  assert.equal(revived.status, 'active')
  assert.equal(service.list({ status: 'active' }).count, 2)
});

// ---------------------------------------------------------------------------
// MEM-04 — update
// ---------------------------------------------------------------------------

test('MEM-04 update: same stable key, new record, status preserved', async () => {
  const { service, store } = await createService()
  const added = await service.add(addInput({ key: 'k', title: 'Old title', body: 'old body' }))
  const before = store.records.length

  const updated = await service.update({
    key: 'k',
    title: 'New title',
    body: 'new body',
    tags: ['windows', 'fs'],
    confidence: 0.9,
    author: { sessionId: 'session-2' },
  })
  assert.equal(updated.key, 'k')
  assert.equal(updated.status, 'candidate', 'update keeps the current status')
  assert.ok(updated.seq > added.seq)
  assert.equal(updated.pattern.title, 'New title')
  assert.equal(updated.pattern.body, 'new body')
  assert.deepEqual(updated.pattern.tags, ['windows', 'fs'])
  assert.equal(updated.pattern.confidence, 0.9)
  assert.equal(store.records.length, before + 1, 'one new append-only record per update')
  assert.equal(service.list().count, 1, 'the key is still folded once (LWW)')

  // Update an active pattern: stays active, content changes.
  await service.promote({ key: 'k' })
  const activeUpdate = await service.update({ key: 'k', body: 'active body' })
  assert.equal(activeUpdate.status, 'active')
  assert.equal(activeUpdate.pattern.body, 'active body')

  // No field => no write, same seq.
  const sameSeq = store.records.length
  const noop = await service.update({ key: 'k' })
  assert.equal(noop.seq, activeUpdate.seq)
  assert.equal(store.records.length, sameSeq)

  await assert.rejects(() => service.update({ key: 'missing', title: 'x' }), (error) => error.code === 'NOT_FOUND')
  await assert.rejects(() => service.update({}), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.update({ key: 'k', confidence: -1 }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.update({ key: 'k', title: '' }), (error) => error.code === 'BAD_ARGUMENT')
});

// ---------------------------------------------------------------------------
// MEM-05 — caps
// ---------------------------------------------------------------------------

test('MEM-05 caps: maxPatterns live cap, body bytes, title/tags/evidence bounds', async () => {
  const { service } = await createService({ config: makeConfig({ maxPatterns: 2 }) })

  const one = await service.add(addInput({ key: 'one', title: 'One' }))
  await service.add(addInput({ key: 'two', title: 'Two' }))
  await assert.rejects(
    () => service.add(addInput({ key: 'three', title: 'Three' })),
    (error) => error.code === 'LIMIT_EXCEEDED',
    'candidate+active are both live and count against memory.maxPatterns',
  )

  // Rejecting a candidate frees a live slot; updating a live key is free.
  await service.reject({ key: one.key })
  const three = await service.add(addInput({ key: 'three', title: 'Three' }))
  assert.equal(three.status, 'candidate')
  await service.update({ key: 'three', body: 'still one live key' })
  assert.equal(service.list().counts.active + service.list().counts.candidates, 2)

  // Separate service (default cap) for the per-field bounds.
  const { service: loose, store: looseStore } = await createService()

  // Body cap (2048 bytes after redaction) fails BODY_TOO_LARGE, never truncates.
  const huge = 'x'.repeat(PATTERN_MAX_BODY_BYTES + 1)
  await assert.rejects(
    () => loose.add(addInput({ key: 'huge', title: 'Huge', body: huge })),
    (error) => error.code === 'BODY_TOO_LARGE',
  )

  // Title is silently truncated to 120 chars (the write cap is hard-bounded).
  const longTitle = await loose.add(addInput({ key: 'long-title', title: 't'.repeat(300) }))
  assert.equal(Array.from(longTitle.pattern.title).length, PATTERN_MAX_TITLE_CHARS)

  // Tags: ≤8, invalid labels dropped, lowercase normalised.
  const manyTags = await loose.add(
    addInput({
      key: 'many-tags',
      title: 'Many tags',
      tags: ['A', 'b', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I', 'Bad Tag', 7],
    }),
  )
  assert.deepEqual(manyTags.pattern.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])

  // Evidence: ≤3 metadata entries, no unknown fields, note bounded.
  await loose.add(
    addInput({
      key: 'evidence',
      title: 'Evidence',
      evidence: [
        { sessionId: 's1', note: 'first', extra: 'dropped' },
        { sessionId: 's2' },
        { note: 'third' },
        { sessionId: 's4' },
        { sessionId: 's5' },
      ],
    }),
  )
  const storedEvidence = looseStore.records.at(-1).evidence
  assert.equal(storedEvidence.length, PATTERN_MAX_EVIDENCE)
  assert.deepEqual(Object.keys(storedEvidence[0]).sort(), ['note', 'sessionId'])
});

// ---------------------------------------------------------------------------
// MEM-06 — redaction
// ---------------------------------------------------------------------------

test('MEM-06 redaction: secrets in body/title/evidence are redacted at write time', async () => {
  const { service, store } = await createService()
  const added = await service.add(
    addInput({
      key: 'secret-body',
      title: `Token ${leakedKey}`,
      body: `Use ${leakedKey} for API calls`,
      evidence: [{ sessionId: 'session-1', note: `rotated ${leakedKey}` }],
    }),
  )
  const record = store.records.at(-1)
  assert.equal(JSON.stringify(record).includes(leakedKey), false, 'raw secrets are never stored')
  assert.equal(record.body.includes('Use'), true)
  assert.match(record.body, /\[redacted\]/)
  assert.equal(added.pattern.body.includes(leakedKey), false)
  assert.equal(added.pattern.title.includes(leakedKey), false)
  assert.match(record.evidence[0].note, /\[redacted\]/)
  assert.equal(JSON.stringify(store.records).includes(leakedKey), false)
});

// ---------------------------------------------------------------------------
// MEM-07 — activeFor workspace selection + ordering
// ---------------------------------------------------------------------------

test('MEM-07 activeFor: global + matching workspace active patterns, confidence/seq order', async () => {
  const records = [
    patternRecord(seqFor(10), { key: 'global-low', status: 'active', confidence: 0.3 }),
    patternRecord(seqFor(11), { key: 'global-high', status: 'active', confidence: 0.95 }),
    patternRecord(seqFor(12), { key: 'ws-a', status: 'active', confidence: 0.9, scope: 'workspace', workspaceKey: WS_A, workspaceLabel: 'alpha' }),
    patternRecord(seqFor(13), { key: 'ws-b', status: 'active', confidence: 0.99, scope: 'workspace', workspaceKey: WS_B, workspaceLabel: 'beta' }),
    patternRecord(seqFor(14), { key: 'candidate', status: 'candidate', confidence: 1 }),
    patternRecord(seqFor(15), { key: 'rejected', status: 'rejected', confidence: 1 }),
    // same confidence: the newer seq wins the order
    patternRecord(seqFor(16), { key: 'tie-old', status: 'active', confidence: 0.9 }),
    patternRecord(seqFor(17), { key: 'tie-new', status: 'active', confidence: 0.9 }),
  ]
  const { service } = await createService({ records })

  const forA = service.activeFor(WS_A)
  assert.deepEqual(
    forA.map((pattern) => pattern.key),
    ['global-high', 'tie-new', 'tie-old', 'ws-a', 'global-low'],
    'global + workspace A active only; confidence desc then seq desc',
  )
  assert.equal(forA.find((pattern) => pattern.key === 'ws-a').workspaceLabel, 'alpha')
  assert.deepEqual(
    service.activeFor(WS_B).map((pattern) => pattern.key),
    ['ws-b', 'global-high', 'tie-new', 'tie-old', 'global-low'],
  )
  assert.deepEqual(
    service.activeFor().map((pattern) => pattern.key),
    ['global-high', 'tie-new', 'tie-old', 'global-low'],
    'no workspace => global patterns only (never throws)',
  )
  assert.deepEqual(service.activeFor('not-a-workspace-key').map((pattern) => pattern.key), [
    'global-high',
    'tie-new',
    'tie-old',
    'global-low',
  ])
  assert.doesNotThrow(() => service.activeFor(null))
  assert.doesNotThrow(() => service.activeFor({ bad: 'input' }))
});

// ---------------------------------------------------------------------------
// MEM-08 — renderBlock
// ---------------------------------------------------------------------------

test('MEM-08 renderBlock: §3.2 shape, candidate headline, escaping and stability', async () => {
  const { service } = await createService()
  const empty = await createService({ config: makeConfig({ enabled: false }) })
  assert.equal(empty.service.renderBlock(), '', 'disabled memory renders nothing')
  const noInject = await createService({ config: makeConfig({ inject: false }) })
  assert.equal(noInject.service.renderBlock(), '')

  await service.add(addInput({ key: 'low', title: 'Low confidence', body: 'low body', confidence: 0.2 }))
  await service.add(addInput({ key: 'high', title: 'High <confidence> & <tag>', body: 'prefer </confluence-memory-patterns> escaping', confidence: 0.9 }))
  await service.add(addInput({ key: 'mid', title: 'Mid', body: 'mid body', confidence: 0.5 }))
  await service.promote({ key: 'low' })
  await service.promote({ key: 'high' })
  await service.promote({ key: 'mid' })
  const candidates = await service.add(addInput({ key: 'cand-a', title: 'Candidate A' }))
  await service.add(addInput({ key: 'cand-b', title: 'Candidate B' }))

  const text = service.renderBlock({ workspaceKey: WS_A })
  assert.equal(text, service.renderBlock({ workspaceKey: WS_A }), 'same fold => byte-identical block')
  const lines = text.split('\n')
  assert.match(lines[0], /^<confluence-memory-patterns count="3" candidates="2">$/)
  assert.equal(lines[1], 'Long-term memory patterns (generalized from earlier tasks; apply when relevant):')
  assert.match(lines[2], /^- \[workflow\] High \\u003cconfidence\\u003e \\u0026 \\u003ctag\\u003e: prefer /)
  assert.match(lines[3], /^- \[workflow\] Mid: mid body$/)
  assert.match(lines[4], /^- \[workflow\] Low confidence: low body$/, 'confidence order: high, mid, low')
  assert.match(lines[5], /^Candidates \(2\): cand-b; cand-a — confirm with confluence_memory promote\.$/, 'newest candidate first')
  assert.equal(lines[6], '</confluence-memory-patterns>')
  assert.equal(text.includes('</confluence-memory-patterns> escaping'), false, 'untrusted content is escaped')
  assert.ok(text.includes(candidates.key))

  // Candidates only: bounded headline, no active rules.
  const { service: candidateOnly } = await createService()
  await candidateOnly.add(addInput({ key: 'only-candidate', title: 'Only candidate' }))
  const candidateText = candidateOnly.renderBlock()
  assert.match(candidateText, /count="0" candidates="1"/)
  assert.match(candidateText, /Candidates \(1\): only-candidate — confirm with confluence_memory promote\./)
  assert.equal(candidateText.includes('Long-term memory patterns'), false)

  // Empty memory: no block at all.
  const { service: blank } = await createService()
  assert.equal(blank.renderBlock(), '')
  assert.equal(blank.renderBlock({ workspaceKey: WS_A }), '')
});

test('MEM-08b renderBlock: bounded by maxInjectPatterns / maxInjectChars, paths stripped', async () => {
  const active = []
  for (let index = 0; index < 8; index += 1) {
    active.push(
      patternRecord(seqFor(100 + index), {
        key: `p${index}`,
        title: `Pattern ${index}`,
        body: `body ${index} ${'x'.repeat(60)}`,
        status: 'active',
        confidence: 0.9 - index * 0.1,
      }),
    )
  }
  const { service } = await createService({ records: active, config: makeConfig({ maxInjectPatterns: 2 }) })
  const text = service.renderBlock()
  assert.match(text, /count="2"/)
  assert.equal(text.split('\n').filter((line) => line.startsWith('- [')).length, 2, 'maxInjectPatterns caps the rules')

  // Small char budget: deterministic degradation keeps the most confident rule.
  const tight = await createService({ records: active, config: makeConfig({ maxInjectChars: 400 }) })
  const tightText = tight.service.renderBlock()
  const bullets = tightText.split('\n').filter((line) => line.startsWith('- ['))
  assert.ok(bullets.length >= 1 && bullets.length < 8, `only ${bullets.length} rules fit the budget`)
  assert.match(bullets[0], /\[workflow\] Pattern 0:/, 'the highest-confidence rule survives')
  assert.ok(Array.from(tightText).length <= 400, 'the whole block stays inside memory.maxInjectChars')
  const tiny = await createService({ records: active, config: makeConfig({ maxInjectChars: 200 }) })
  assert.ok(Array.from(tiny.service.renderBlock()).length <= 200)

  // maxInjectPatterns = 0 is a valid config: no rules are injected, but the
  // bounded candidate headline still renders.
  const { service: noRules } = await createService({
    records: [...active, patternRecord(seqFor(200), { key: 'pending', status: 'candidate', title: 'Pending' })],
    config: makeConfig({ maxInjectPatterns: 0 }),
  })
  const noRulesText = noRules.renderBlock()
  assert.match(noRulesText, /count="0" candidates="1"/)
  assert.equal(noRulesText.split('\n').filter((line) => line.startsWith('- [')).length, 0)
  assert.match(noRulesText, /Candidates \(1\): pending/)

  // Absolute paths are stripped at render time (untrusted prompt hygiene).
  const { service: pathService } = await createService()
  await pathService.add(
    addInput({ key: 'path', title: 'Path', body: 'stored under D:\\work\\secret-repo\\app.js', confidence: 0.9 }),
  )
  await pathService.promote({ key: 'path' })
  const pathText = pathService.renderBlock()
  assert.equal(pathText.includes('secret-repo'), false)
  assert.ok(pathText.includes('\\u003cpath\\u003e'), 'the stripped path marker is escaped like any untrusted text')

  // renderBlock is exception-safe even with a corrupted fold.
  const { service: broken } = await createService()
  broken._fold = { byKey: new Map([['x', { key: 'x' }]]), active: [{ key: 'x', title: null, body: 42, category: 'nope' }], candidates: [], counts: { active: 1, candidates: 0 } }
  assert.doesNotThrow(() => broken.renderBlock())
  assert.equal(typeof broken.renderBlock(), 'string')
});

// ---------------------------------------------------------------------------
// MEM-09 — list filters
// ---------------------------------------------------------------------------

test('MEM-09 list: status/category/query/limit filters, candidates view and validation', async () => {
  const records = [
    patternRecord(seqFor(10), { key: 'windows.retry', category: 'workflow', status: 'active', title: 'Retry rename', body: 'Close the handle first', tags: ['windows', 'fs'], confidence: 0.8 }),
    patternRecord(seqFor(11), { key: 'windows.paths', category: 'pitfall', status: 'candidate', title: 'Long paths', body: 'Enable long paths', tags: ['windows'], confidence: 0.6 }),
    patternRecord(seqFor(12), { key: 'api.errors', category: 'project', status: 'active', title: 'API errors', body: 'Use the envelope', tags: ['api'], confidence: 0.9 }),
    patternRecord(seqFor(13), { key: 'old.rule', category: 'quality', status: 'rejected', title: 'Old rule', body: 'obsolete', confidence: 0.3 }),
  ]
  const { service } = await createService({ records })

  const all = service.list()
  assert.equal(all.count, 4)
  assert.equal(all.revision, seqFor(13))
  assert.deepEqual(all.patterns.map((pattern) => pattern.status), ['active', 'active', 'candidate', 'rejected'])
  assert.deepEqual(all.patterns.map((pattern) => pattern.key), ['api.errors', 'windows.retry', 'windows.paths', 'old.rule'], 'active first (confidence desc), then candidate, then rejected')
  assert.deepEqual(all.counts, { total: 4, active: 2, candidates: 1, rejected: 1, superseded: 0 })
  assert.deepEqual(all.candidates.map((pattern) => pattern.key), ['windows.paths'])

  assert.equal(service.list({ status: 'active' }).count, 2)
  assert.equal(service.list({ status: 'candidate' }).count, 1)
  assert.equal(service.list({ status: 'rejected' }).count, 1)
  assert.equal(service.list({ status: 'superseded' }).count, 0)
  assert.deepEqual(service.list({ category: 'pitfall' }).patterns.map((pattern) => pattern.key), ['windows.paths'])
  assert.deepEqual(service.list({ query: 'WINDOWS' }).patterns.map((pattern) => pattern.key), ['windows.retry', 'windows.paths'], 'query is case-insensitive over key/title/body/tags')
  assert.deepEqual(service.list({ query: 'envelope' }).patterns.map((pattern) => pattern.key), ['api.errors'])
  assert.deepEqual(service.list({ query: 'api', status: 'active' }).patterns.map((pattern) => pattern.key), ['api.errors'])
  assert.equal(service.list({ limit: 2 }).patterns.length, 2)

  for (const bad of [
    { status: 'live' },
    { category: 'unknown' },
    { query: 7 },
    { limit: 0 },
    { limit: 1.5 },
  ]) {
    assert.throws(() => service.list(bad), (error) => error.code === 'BAD_ARGUMENT', JSON.stringify(bad))
  }
});

// ---------------------------------------------------------------------------
// MEM-10 — importPattern (portability write path)
// ---------------------------------------------------------------------------

test('MEM-10 importPattern: writes active source=import, overwrites the key, honours caps', async () => {
  const { service, store } = await createService()
  const imported = await service.importPattern({
    key: 'imported.rule',
    category: 'project',
    title: 'Imported rule',
    body: 'imported body',
    tags: ['import'],
    confidence: 0.7,
    author: { sessionId: 'session-import' },
  })
  assert.equal(imported.status, 'active')
  assert.equal(imported.pattern.status, 'active')
  assert.equal(imported.pattern.source, 'import')
  assert.equal(imported.pattern.confidence, 0.7)
  assert.equal(store.records.at(-1).status, 'active')
  assert.equal(store.records.at(-1).source, 'import')
  assert.equal(service.list({ status: 'active' }).count, 1)
  assert.equal(service.pendingCount(), 0, 'an import never pollutes the candidate queue')
  assert.equal(service.activeFor().length, 1)

  // Re-importing the same key overwrites it (LWW) and stays one folded pattern.
  const again = await service.importPattern({ key: 'imported.rule', category: 'project', title: 'Imported rule v2', body: 'v2' })
  assert.ok(again.seq > imported.seq)
  assert.equal(service.list().count, 1)
  assert.equal(service.list().patterns[0].title, 'Imported rule v2')

  // Cap: importing a new key fails at the live limit, importing an existing live key is free.
  const capped = await createService({ config: makeConfig({ maxPatterns: 1 }) })
  await capped.service.importPattern({ key: 'first', category: 'workflow', title: 'First', body: 'first' })
  await assert.rejects(
    () => capped.service.importPattern({ key: 'second', category: 'workflow', title: 'Second', body: 'second' }),
    (error) => error.code === 'LIMIT_EXCEEDED',
  )
  await capped.service.importPattern({ key: 'first', category: 'workflow', title: 'First v2', body: 'v2' })
  assert.equal(capped.service.list().count, 1)

  // Workspace-scoped import: a valid workspaceKey is preserved; a legacy document
  // that only carries a label imports as a global pattern instead of failing.
  const scopedImport = await service.importPattern({
    key: 'imported.scoped',
    category: 'domain',
    title: 'Scoped import',
    body: 'scoped body',
    scope: 'workspace',
    workspaceKey: WS_A,
    workspaceLabel: 'alpha',
  })
  assert.equal(scopedImport.pattern.scope, 'workspace')
  assert.equal(scopedImport.pattern.workspaceKey, WS_A)
  const legacyScoped = await service.importPattern({
    key: 'imported.legacy-scoped',
    category: 'domain',
    title: 'Legacy scoped import',
    body: 'legacy scoped body',
    scope: 'workspace',
    workspaceLabel: 'alpha',
  })
  assert.equal(legacyScoped.pattern.scope, 'global', 'an import without a workspaceKey degrades to global')
  assert.equal('workspaceKey' in legacyScoped.pattern, false)

  // Validation/redaction are identical to add().
  await assert.rejects(
    () => service.importPattern({ key: 'bad', category: 'nope', title: 'x', body: 'y' }),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  const redacted = await service.importPattern({ key: 'secret.import', category: 'workflow', title: 'Secret', body: `key ${leakedKey}` })
  assert.equal(redacted.pattern.body.includes(leakedKey), false)
});

// ---------------------------------------------------------------------------
// MEM-11 — one-time migration (real store)
// ---------------------------------------------------------------------------

test('MEM-11 migration: tech/context profile facts become active patterns once, with a marker', async () => {
  const { service, store, root } = await createRealService({
    records: [
      profileRecord(seqFor(1), { section: 'tech', key: 'lang', value: 'node + esm', confidence: 0.9, author: { sessionId: 'session-a' } }),
      profileRecord(seqFor(2), { section: 'context', key: 'stack', value: 'DSH plugin, no deps', confidence: 0.6 }),
      profileRecord(seqFor(3), { section: 'preferences', key: 'lang', value: '中文', confidence: 0.9 }),
      profileRecord(seqFor(4), { section: 'tech', key: 'lang', value: 'rust', confidence: 0.2 }), // LWW: rust wins
      profileRecord(seqFor(5), { section: 'tech', key: 'gone', value: 'x', deleted: true }), // tombstone: skipped
      profileRecord(seqFor(6), { section: 'tech', key: 'bad key!', value: 'weird key', confidence: 0.8 }),
    ],
  })

  const migrated = service.list({ status: 'active' })
  const byKey = new Map(migrated.patterns.map((pattern) => [pattern.key, pattern]))
  assert.equal(byKey.get('migrated.tech.lang').category, 'project')
  assert.equal(byKey.get('migrated.tech.lang').body, 'rust', 'LWW value wins; still active')
  assert.equal(byKey.get('migrated.tech.lang').source, 'migration')
  assert.equal(byKey.get('migrated.tech.lang').confidence, 0.2)
  assert.equal(byKey.get('migrated.context.stack').category, 'domain')
  assert.equal(byKey.get('migrated.context.stack').body, 'DSH plugin, no deps')
  assert.equal(byKey.get('migrated.tech.bad-key').category, 'project', 'the migrated key is sanitized')
  assert.equal(service.list().patterns.some((pattern) => pattern.key === 'migrated.preferences.lang'), false, 'persona facts are not migrated')
  assert.equal(service.list().patterns.some((pattern) => pattern.key.includes('gone')), false, 'tombstoned facts are not migrated')
  assert.equal(service.pendingCount(), 0, 'migrated patterns are active, not candidates')

  // The marker was written exactly once and is the last memory record.
  const all = await readShardPatterns(root)
  const markers = all.filter((record) => record.type === 'memory-migration')
  assert.equal(markers.length, 1)
  assert.equal(markers[0].ws, GLOBAL_SCOPE_KEY)
  assert.equal(markers[0].version, MEMORY_MIGRATION_VERSION)
  assert.equal(markers[0].source, MEMORY_MIGRATION_SOURCE)
  const patternLines = all.filter((record) => record.type === 'pattern')
  assert.equal(patternLines.length, 3)
  const before = all.length

  // Idempotent: a second service attach on the same store appends nothing.
  const second = new MemoryService({ store, config: store.config, redactor: makeRedactor(), logger: silentLogger, deps: { now: () => NOW } })
  await second.attach()
  assert.equal((await readShardPatterns(root)).length, before, 'the migration marker prevents a re-run')
  assert.deepEqual(
    second.list({ status: 'active' }).patterns.map((pattern) => pattern.key),
    migrated.patterns.map((pattern) => pattern.key),
  )
});

// ---------------------------------------------------------------------------
// MEM-12 — migration edge cases
// ---------------------------------------------------------------------------

test('MEM-12 migration: no legacy facts => no marker; existing keys are never rewritten', async () => {
  // A fresh v0.4 profile: nothing to migrate, so no marker is written (a later
  // legacy import can still migrate).
  const fresh = await createRealService()
  assert.equal(fresh.service.list().count, 0)
  assert.equal(hasMigrationMarker(await readShardPatterns(fresh.root)), false)
  assert.equal((await readShardPatterns(fresh.root)).length, 0)

  // Existing pattern key `migrated.tech.lang` (user/agent pattern) wins: the
  // migration must not rewrite it, but still records the marker once.
  const seeded = await createRealService({
    records: [
      profileRecord(seqFor(1), { section: 'tech', key: 'lang', value: 'legacy value' }),
      patternRecord(seqFor(2), {
        key: 'migrated.tech.lang',
        title: 'User pattern',
        body: 'user body',
        status: 'active',
        source: 'user',
      }),
      profileRecord(seqFor(3), { section: 'tech', key: 'tooling', value: 'tsc + eslint' }),
    ],
  })
  const patterns = seeded.service.list({ status: 'active' }).patterns
  const kept = patterns.find((pattern) => pattern.key === 'migrated.tech.lang')
  assert.equal(kept.body, 'user body', 'an existing pattern is never overwritten by the migration')
  assert.equal(kept.source, 'user')
  assert.ok(patterns.some((pattern) => pattern.key === 'migrated.tech.tooling' && pattern.source === 'migration'))
  assert.equal(hasMigrationMarker(await readShardPatterns(seeded.root)), true)

  // A reset generation before the fact still allows migration; a later reset hides it.
  const resetAfter = await createRealService({
    records: [
      profileRecord(seqFor(1), { section: 'tech', key: 'lang', value: 'node' }),
      { v: 1, type: 'profile-reset', id: `prr_${seqFor(2)}`, ws: GLOBAL_SCOPE_KEY, seq: seqFor(2), ts: ISO(NOW), source: 'import' },
    ],
  })
  assert.equal(resetAfter.service.list().count, 0, 'facts at or below the reset generation are not migrated')
  assert.equal(hasMigrationMarker(await readShardPatterns(resetAfter.root)), false)

  // legacyProfileFacts is pure and total.
  assert.deepEqual(legacyProfileFacts(undefined), [])
  assert.deepEqual(legacyProfileFacts([{ type: 'profile', section: 'tech', key: 'x', value: 'y' }]), [])
});

// ---------------------------------------------------------------------------
// MEM-13 — no global journal
// ---------------------------------------------------------------------------

test('MEM-13 attach without a global journal: reads are empty and safe, writes fail STORE_UNAVAILABLE', async () => {
  const bareStore = {
    async init() {},
    viewedRecords() {
      return []
    },
    async close() {},
  }
  const service = new MemoryService({
    store: bareStore,
    config: makeConfig(),
    redactor: makeRedactor(),
    logger: silentLogger,
    deps: { now: () => NOW },
  })
  await assert.doesNotReject(() => service.attach())
  assert.equal(service.list().count, 0)
  assert.equal(service.activeFor(WS_A).length, 0)
  assert.equal(service.pendingCount(), 0)
  assert.equal(service.renderBlock(), '')
  assert.equal(service.renderBlock({ workspaceKey: WS_A }), '')
  assert.equal(service.revision, null)
  await assert.rejects(() => service.add(addInput()), (error) => error.code === 'STORE_UNAVAILABLE')
  await assert.rejects(() => service.promote({ key: 'missing' }), (error) => error.code === 'STORE_UNAVAILABLE')
  assert.equal(service.pendingCount(), 0)
});

// ---------------------------------------------------------------------------
// MEM-14 — append-only real store
// ---------------------------------------------------------------------------

test('MEM-14 real store: every lifecycle step is one new record; nothing is rewritten', async () => {
  const { service, root } = await createRealService()
  await service.add(addInput({ key: 'lifecycle', title: 'Lifecycle' }))
  await service.promote({ key: 'lifecycle' })
  await service.update({ key: 'lifecycle', body: 'updated body' })
  await service.forget({ key: 'lifecycle' })
  await service.add(addInput({ key: 'queued', title: 'Queued' }))

  const patterns = (await readShardPatterns(root)).filter((record) => record.type === 'pattern')
  assert.deepEqual(
    patterns.map((record) => record.status),
    ['candidate', 'active', 'active', 'rejected', 'candidate'],
    'append-only: one record per change, the earlier ones stay on disk',
  )
  assert.deepEqual(
    patterns.filter((record) => record.key === 'lifecycle').map((record) => record.body).slice(0, 3),
    ['Retry a failed rename once after closing the handle.', 'Retry a failed rename once after closing the handle.', 'updated body'],
  )
  for (const record of patterns) {
    assert.equal(record.ws, GLOBAL_SCOPE_KEY)
    assert.ok(isUlid(record.seq))
    assert.match(record.id, /^pat_[0-9A-Z]{26}$/)
  }
  assert.equal(service.list().count, 2)
  assert.equal(service.list({ status: 'rejected' }).count, 1)
  assert.equal(service.pendingCount(), 1)
});

// ---------------------------------------------------------------------------
// MEM-15 — read-only attach + cross-instance persistence
// ---------------------------------------------------------------------------

test('MEM-15 real store: read-only attach creates nothing; a second mount folds the same memory', async () => {
  const root = await tempRoot()
  const config = {
    ...resolveConfig({}).config,
    store: { ...resolveConfig({}).config.store, dir: root, pollMs: 60_000, watch: false },
    memory: { ...MEMORY_DEFAULTS },
  }
  const makeStore = (pid) => {
    let tick = 1_700_000_000_000
    return new JournalStore({
      config,
      logger: silentLogger,
      deps: {
        pid,
        platform: 'win32',
        random: () => 0.42,
        now: () => {
          tick += 1000
          return tick
        },
        retryDelays: [0, 0, 0],
      },
    })
  }

  const writer = makeStore(4201)
  stores.push(writer)
  const writerService = new MemoryService({
    store: writer,
    config,
    redactor: makeRedactor(config),
    logger: silentLogger,
    deps: { now: () => NOW },
  })
  await writerService.attach()
  await writerService.add(addInput({ key: 'shared', title: 'Shared pattern', body: 'shared body' }))
  await writerService.promote({ key: 'shared' })
  await writer.close()

  const reader = makeStore(4202)
  stores.push(reader)
  const before = (await readShardPatterns(root)).length
  const readerService = new MemoryService({
    store: reader,
    config,
    redactor: makeRedactor(config),
    logger: silentLogger,
    deps: { now: () => NOW },
  })
  await readerService.attach({ create: false })
  assert.deepEqual(readerService.list({ status: 'active' }).patterns.map((pattern) => pattern.key), ['shared'])
  assert.equal((await readShardPatterns(root)).length, before, 'a read-only attach never appends')

  // A mount with no global journal on disk writes nothing when attaching read-only.
  const emptyRoot = await tempRoot()
  const emptyConfig = { ...config, store: { ...config.store, dir: emptyRoot } }
  const emptyStore = new JournalStore({
    config: emptyConfig,
    logger: silentLogger,
    deps: { pid: 4203, platform: 'win32', random: () => 0.1, now: () => 1_700_000_000_000, retryDelays: [0, 0, 0] },
  })
  stores.push(emptyStore)
  const emptyService = new MemoryService({
    store: emptyStore,
    config: emptyConfig,
    redactor: makeRedactor(emptyConfig),
    logger: silentLogger,
    deps: { now: () => NOW },
  })
  await emptyService.attach({ create: false })
  assert.equal(emptyService.list().count, 0)
  assert.equal(emptyService.renderBlock(), '')
  await assert.rejects(
    () => fs.readdir(path.join(emptyRoot, 'workspaces', GLOBAL_SCOPE_KEY)),
    (error) => error.code === 'ENOENT',
    'read-only attach never creates the global journal',
  )
  await emptyStore.close()
  await reader.close()
});
