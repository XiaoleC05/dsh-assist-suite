// Confluence / 高级记忆 — WP8/M4 universal-memory export tests (`confluence.memories/v1`, v0.2.0).
//
// Contract: docs/adr/0007-universal-memory-scope.md §2 item 7, docs/plan/scope-refactor-delta.md
// §8, docs/design/store-format.md §13.3/§14 (authoritative bytes + integrity rules) and
// docs/design/solo-bench-integration.md §6. Hermetic: an in-memory store double that implements
// the delta §2 surface (`mergedRecords()` / `refreshMerged()` / `legacyWorkspaceMeta()`), a real
// temp directory for the files, no DSH runtime, no network, no child process (the CLI's exported
// run() is called in-process with an injected store factory).
//
// Coverage map:
//   EXP-01  universal manifest (scope/producer/global wsKey) + v1 record mapping
//   EXP-02  legacy journals merged in with provenance origin; no paths, no raw ws field
//   EXP-03  live-only counts, tombstone stubs, retention, skipped replies, deterministic order
//   EXP-04  file hash/bytes cover the whole file; recordCount/firstSeq/lastSeq cover live only
//   EXP-05  redaction re-applied, absolute paths stripped, file hints relative
//   EXP-06  determinism (byte-identical JSONL; manifest differs only in generatedAt)
//   EXP-07  store is only read; dry run writes nothing; no read-back
//   EXP-08  failure modes fail closed (unsupported store, unsafe outDir, throwing redactor)
//   EXP-09  atomic publish order: JSONL first, manifest LAST; a failed manifest leaves no commit
//   EXP-10  caps: 8 MiB deterministic tail truncation with limits.truncated
//   EXP-11  CLI run(): global scope, default <dsh-home>/storages/confluence-exports/<stamp>,
//           --out, --json, --dry-run, no --workspace flag, exit codes 0/1/2
//   EXP-12  pure helpers (labels, path stripping, outDir validation, args, default dir)
//   EXP-13  real JournalStore: the delta surface merges the global journal with a legacy journal,
//           the CLI leaves every store byte untouched, provenance labels are basenames
//   EXP-14  upgrade path: a v0.1 store with only legacy journals exports them and creates no
//           global scope directory (no migration writes)
//   MEM-01..09  v0.4 memory portability: `confluence.memory/v1` vocabulary, canonical JSON and
//           Markdown snapshots, determinism, absolute-path stripping, caps, strict validation,
//           pure merge/replace import plans, legacy profile/v1 document import (persona-only)
//   MEM-10..11  memory CLI contract (args/defaults/formats/dry-run/exit codes) and
//           export -> import -> export round-trips (fake store incl. patterns/styles, and a
//           real temporary DSH_HOME for the persona).

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { createRedactor } from '../lib/redact.js'
import { resolveConfig } from '../lib/config.js'
import { GLOBAL_SCOPE_KEY as STORE_GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_FILE,
  EXPORT_MAX_BYTES,
  EXPORT_SCHEMA,
  GLOBAL_SCOPE_KEY,
  GLOBAL_SCOPE_LABEL,
  MEMORIES_FILE,
  PROFILE_DEFAULTS,
  LEGACY_SECTION_ALIASES,
  MEMORY_DEFAULTS,
  MEMORY_DOC_FORMAT,
  MEMORY_DOC_KIND,
  MEMORY_DOC_MAX_BYTES,
  MEMORY_DOC_SCOPE,
  MEMORY_DOC_VERSION,
  MEMORY_TAG_RE,
  PATTERN_CATEGORIES,
  PATTERN_KEY_RE,
  PATTERN_SCOPES,
  PATTERN_SOURCES,
  PATTERN_STATUSES,
  PROFILE_DOC_FORMAT,
  PROFILE_DOC_VERSION,
  PROFILE_KEY_RE,
  PROFILE_RENDER_ORDER,
  PROFILE_SECTIONS,
  PROFILE_SOURCES,
  STYLE_AREAS,
  STYLE_CHANNELS,
  buildMemoryDocument,
  buildMemoryImportRecords,
  buildProfileDocument,
  exportMemories,
  importMemoryDocument,
  renderMemoryMarkdown,
  renderProfileMarkdown,
  serializeMemoryDocument,
  serializeProfileDocument,
  stripAbsolutePaths,
  validateExportDir,
  validateMemoryDocument,
  validateProfileDocument,
  workspaceLabelFor,
} from '../lib/export.js'
import { ProfileService } from '../lib/profile.js'
import { USAGE, defaultExportDir, parseArgs, run, utcStamp, validateOutArg } from '../scripts/export-memories.mjs'
import {
  USAGE as EXPORT_USAGE,
  defaultExportFile,
  parseArgs as parseExportArgs,
  run as runExport,
} from '../scripts/memory-export.mjs'
import {
  USAGE as IMPORT_USAGE,
  parseArgs as parseImportArgs,
  run as runImport,
} from '../scripts/memory-import.mjs'

/** Build a synthetic credential from fragments so the committed source never holds a credential-shaped literal. */
const secret = (...parts) => parts.join('')
const leakedKey = secret('sk-fixture', '123456789012345678901234')

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const ISO = (ms) => new Date(ms).toISOString()
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_PREFIX = '01J8Z6Q3M0'

/** Two real workspace keys used only as provenance (never as a partition). */
const ORIGIN_KEY = 'ws_1111111111111111'
const LEGACY_KEY = 'ws_2222222222222222'
const LEGACY_SESSION_ID = 'session-legacy-ledger'

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

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
/** @type {string[]} */
const tempDirs = []

after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot(label = 'confluence-export-') {
  const dir = await fs.mkdtemp(path.join(tmpdir(), label))
  tempDirs.push(dir)
  return dir
}

function makeConfig(storeOverrides = {}) {
  return resolveConfig({ store: { retentionDays: 90, ...storeOverrides } }).config
}

/**
 * Store double implementing the v0.2.0 delta §2 surface the export needs. It exposes no write
 * method at all: the export must only read.
 */
function createFakeStore({ records = [], legacyMeta = [], rootDir = path.join(tmpdir(), 'fake-store-root') } = {}) {
  const calls = { refreshMerged: 0, mergedRecords: 0, legacyWorkspaceMeta: 0, legacyView: 0 }
  return {
    rootDir,
    calls,
    async init() {},
    async refreshMerged() {
      calls.refreshMerged += 1
      return true
    },
    mergedRecords() {
      calls.mergedRecords += 1
      return records
    },
    legacyWorkspaceMeta() {
      calls.legacyWorkspaceMeta += 1
      return legacyMeta
    },
    async close() {},
  }
}

function entryRecord(seq, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: ISO(NOW - 60 * 60 * 1000),
    kind: 'gotcha',
    title: `note ${seq.slice(-4)}`,
    body: 'body',
    author: { sessionId: 'session-author', title: 'Auth work', origin: 'agent' },
    ...overrides,
  }
}

/** Seed the export fixture: global entries + a pre-0.2.0 legacy journal + tombstones/retention. */
function seed() {
  const seqs = {
    legacy: seqFor(5),
    legacySession: seqFor(6),
    gotcha: seqFor(10),
    question: seqFor(20),
    reply: seqFor(21),
    tombstoned: seqFor(30),
    tombstone1: seqFor(31),
    deletedRoot: seqFor(40),
    deletedReply: seqFor(41),
    tombstone2: seqFor(42),
    old: seqFor(50),
    session: seqFor(60),
    superseding: seqFor(70),
    minimal: seqFor(80),
  }
  const questionId = `cnf_${seqs.question}`
  const deletedRootId = `cnf_${seqs.deletedRoot}`

  const legacyRecord = entryRecord(seqs.legacy, {
    ws: LEGACY_KEY,
    kind: 'decision',
    title: 'Legacy decision from a pre-0.2.0 workspace',
    body: 'Written before the universal scope existed.',
    author: { sessionId: 'session-legacy', origin: 'user' },
  })
  const legacySession = {
    v: 1,
    type: 'session',
    ws: LEGACY_KEY,
    seq: seqs.legacySession,
    ts: ISO(NOW - 30 * 60 * 1000),
    sessionId: LEGACY_SESSION_ID,
    title: 'Legacy ledger only',
    status: 'idle',
  }

  const gotcha = entryRecord(seqs.gotcha, {
    kind: 'gotcha',
    title: 'Windows rename retries wrap in EPERM',
    body:
      'A scanner holds the handle so the API key ' + leakedKey + ' must never ship. ' +
      'Opened C:\\Users\\mockuser\\project\\src\\fs\\rename.ts on the user machine.',
    tags: ['Windows', 'fs', 'not a tag'],
    files: ['src/fs/rename.ts', 'C:\\Users\\mockuser\\project\\.env', '..\\escape\\x.ts'],
    origin: { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' },
  })
  const question = entryRecord(seqs.question, {
    kind: 'question',
    title: 'Which index rebuild strategy?',
    body: 'Choose one before the migration.',
    tags: ['index'],
    author: { sessionId: 'session-asker', origin: 'agent' },
  })
  const reply = entryRecord(seqs.reply, {
    kind: 'gotcha',
    title: 'Reply: use the native lock',
    body: 'Resolved with the native lease.',
    replyTo: questionId,
    resolves: true,
    author: { sessionId: 'session-answerer', title: 'Data migration', origin: 'agent' },
  })
  const tombstoned = entryRecord(seqs.tombstoned, {
    kind: 'finding',
    title: 'A note that will be forgotten',
    body: 'content that must not be exported',
    tags: ['gone'],
    files: ['src/gone.ts'],
  })
  const tombstone1 = {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqs.tombstone1}`,
    ws: GLOBAL_SCOPE_KEY,
    seq: seqs.tombstone1,
    ts: ISO(NOW - 2 * 60 * 60 * 1000),
    target: `cnf_${seqs.tombstoned}`,
  }
  const deletedRoot = entryRecord(seqs.deletedRoot, {
    kind: 'question',
    title: 'Deleted root question',
    body: 'root body',
    author: { sessionId: 'session-deleted-root', origin: 'user' },
  })
  const deletedReply = entryRecord(seqs.deletedReply, {
    kind: 'gotcha',
    title: 'Reply under a deleted root',
    body: 'this reply must not be exported',
    replyTo: deletedRootId,
    author: { sessionId: 'session-replier', origin: 'agent' },
  })
  const tombstone2 = {
    v: 1,
    type: 'tombstone',
    id: `tmb_${seqs.tombstone2}`,
    ws: GLOBAL_SCOPE_KEY,
    seq: seqs.tombstone2,
    ts: ISO(NOW - 3 * 60 * 60 * 1000),
    target: deletedRootId,
  }
  const old = entryRecord(seqs.old, {
    kind: 'decision',
    title: 'Old decision hidden by retention',
    ts: ISO(NOW - 200 * 24 * 60 * 60 * 1000),
  })
  const session = {
    v: 1,
    type: 'session',
    ws: GLOBAL_SCOPE_KEY,
    seq: seqs.session,
    ts: ISO(NOW - 5 * 60 * 1000),
    sessionId: 'session-ledger-only',
    title: 'Ledger only',
    status: 'idle',
    turns: 4,
    lastActivityTs: ISO(NOW - 6 * 60 * 1000),
    files: ['src/ledger.ts'],
  }
  const superseding = entryRecord(seqs.superseding, {
    kind: 'decision',
    title: 'Pin dependencies to 0.2.x',
    body: 'Supersedes the open question about strategy.',
    supersedes: questionId,
    author: { sessionId: 'session-decider', title: 'Planner', origin: 'agent' },
  })
  const minimal = entryRecord(seqs.minimal, {
    kind: 'warning',
    title: 'Minimal record without optional fields',
    body: undefined,
    tags: undefined,
    files: undefined,
    author: { sessionId: 'session-minimal', origin: 'agent' },
  })

  // Deliberately unsorted (the store contract sorts; the export must not rely on it).
  const records = [
    legacySession,
    old,
    gotcha,
    minimal,
    tombstone1,
    reply,
    session,
    deletedReply,
    tombstone2,
    question,
    legacyRecord,
    superseding,
    deletedRoot,
    tombstoned,
  ]
  const legacyMeta = [{ wsKey: LEGACY_KEY, canonicalPath: 'D:\\work\\old-repo' }]
  return {
    records,
    legacyMeta,
    ids: {
      legacy: `cnf_${seqs.legacy}`,
      gotcha: `cnf_${seqs.gotcha}`,
      question: questionId,
      reply: `cnf_${seqs.reply}`,
      tombstoned: `cnf_${seqs.tombstoned}`,
      deletedRoot: deletedRootId,
      deletedReply: `cnf_${seqs.deletedReply}`,
      old: `cnf_${seqs.old}`,
      superseding: `cnf_${seqs.superseding}`,
      minimal: `cnf_${seqs.minimal}`,
      session: 'session-ledger-only',
    },
    seqs,
    legacyKey: LEGACY_KEY,
    originKey: ORIGIN_KEY,
  }
}

async function readExport(outDir) {
  const jsonl = await fs.readFile(path.join(outDir, MEMORIES_FILE), 'utf8')
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, EXPORT_MANIFEST_FILE), 'utf8'))
  const lines = jsonl === '' ? [] : jsonl.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { jsonl, manifest, lines, records: lines.map((line) => JSON.parse(line)) }
}

async function exportFixture(options = {}) {
  const store = options.store ?? createFakeStore({
    records: options.records ?? [],
    legacyMeta: options.legacyMeta ?? [],
    rootDir: options.rootDir,
  })
  const config = options.config ?? makeConfig()
  const outDir = options.outDir ?? path.join(await tempRoot(), 'export')
  const result = await exportMemories({
    store,
    board: options.board,
    config,
    redactor: options.redactor ?? createRedactor(config, { logger: silentLogger }),
    outDir,
    fs: options.fs,
    now: options.now ?? (() => NOW),
    dryRun: options.dryRun === true,
  })
  return { result, store, outDir: result.outDir, config }
}

// ---------------------------------------------------------------------------
// EXP-01 — universal manifest + v1 record mapping
// ---------------------------------------------------------------------------

test('EXP-01 export writes a universal manifest and v1 records with the global wsKey', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { records, manifest } = await readExport(result.outDir)

  assert.equal(result.schema, EXPORT_SCHEMA)
  assert.equal(result.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(result.scope, 'global')
  assert.equal(manifest.schema, EXPORT_SCHEMA)
  assert.equal(manifest.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(manifest.scope, 'global')
  assert.deepEqual(manifest.producer, { name: 'dsh-confluence', version: '0.4.0', dsh: '0.2.2-rc.1' })
  assert.equal(manifest.generatedAt, ISO(NOW))
  assert.deepEqual(manifest.workspace, { wsKey: GLOBAL_SCOPE_KEY, name: GLOBAL_SCOPE_LABEL })
  assert.equal(manifest.workspace.name, 'All sessions')
  assert.equal(manifest.recordCount, 6)
  assert.equal(manifest.firstSeq, fixture.seqs.legacy)
  assert.equal(manifest.lastSeq, fixture.seqs.minimal)
  assert.equal(manifest.files.length, 1)
  assert.equal(manifest.files[0].name, MEMORIES_FILE)
  assert.ok(manifest.files[0].bytes > 0)
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(manifest.redaction, { applied: true, policy: 'confluence.redact/v1' })
  assert.deepEqual(manifest.limits, { truncated: false, maxEntriesPerWorkspace: 2000 })
  assert.deepEqual(result.files, manifest.files)

  assert.equal(records.length, 8, 'six live records plus two tombstone stubs')
  for (const record of records) {
    assert.equal(record.wsKey, GLOBAL_SCOPE_KEY, 'every record carries the reserved global wsKey')
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'ws'), false, 'the raw workspace field never leaks')
    assert.equal(record.v, 1)
    assert.equal(record.schema, EXPORT_SCHEMA)
    assert.equal(record.type, 'entry')
  }

  const byId = new Map(records.map((record) => [record.id, record]))
  const gotcha = byId.get(fixture.ids.gotcha)
  assert.ok(gotcha)
  assert.equal(gotcha.kind, 'gotcha')
  assert.equal(gotcha.deleted, false)
  assert.equal(gotcha.deletedAt, null)
  assert.equal(gotcha.replyTo, null)
  assert.equal(gotcha.resolves, null)
  assert.equal(gotcha.supersedes, null)
  assert.deepEqual(gotcha.author, { sessionId: 'session-author', title: 'Auth work', origin: 'agent' })
  assert.deepEqual(gotcha.origin, { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' })

  const reply = byId.get(fixture.ids.reply)
  assert.equal(reply.replyTo, fixture.ids.question)
  assert.equal(reply.resolves, fixture.ids.question, 'resolves boolean must map to the replyTo entry id')
  assert.equal(reply.supersedes, null)

  const superseding = byId.get(fixture.ids.superseding)
  assert.equal(superseding.supersedes, fixture.ids.question)

  const minimal = byId.get(fixture.ids.minimal)
  assert.equal(minimal.kind, 'warning')
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'body'), false, 'absent body must stay absent')
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'tags'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'files'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(minimal, 'origin'), false, 'unknown provenance stays absent')
});

// ---------------------------------------------------------------------------
// EXP-02 — legacy merge + provenance
// ---------------------------------------------------------------------------

test('EXP-02 legacy journals are merged read-only and carried as origin provenance', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { jsonl, records } = await readExport(result.outDir)
  const byId = new Map(records.map((record) => [record.id, record]))

  const legacy = byId.get(fixture.ids.legacy)
  assert.ok(legacy, 'a pre-0.2.0 legacy record must appear in the universal export')
  assert.equal(legacy.wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(legacy.origin, { workspaceKey: fixture.legacyKey, workspaceLabel: 'old-repo' })
  assert.equal(legacy.title, 'Legacy decision from a pre-0.2.0 workspace')
  assert.equal(legacy.author.origin, 'user')

  assert.equal(records.some((record) => record.id === fixture.ids.session), false, 'global session rows are not exported')
  assert.equal(records.some((record) => record.id === LEGACY_SESSION_ID), false, 'legacy session rows are not exported')
  assert.equal(records.some((record) => record.kind === 'session'), false)
  assert.equal(records.every((record) => record.type === 'entry'), true, 'only entry records may be exported')

  // No absolute paths anywhere: neither the legacy canonical path nor the redacted body survives.
  assert.equal(jsonl.includes('D:\\work\\old-repo'), false, 'the legacy canonical path must not leak')
  assert.equal(jsonl.includes('C:\\Users\\mockuser'), false, 'no absolute home path may survive')
  assert.equal(/[A-Za-z]:\\\\/.test(jsonl), false, 'no Windows drive path may appear in JSON text')
  assert.equal(JSON.stringify(records).includes('mockuser'), false)
});

// ---------------------------------------------------------------------------
// EXP-03 — counts, tombstone stubs, retention, order
// ---------------------------------------------------------------------------

test('EXP-03 live-only counts, tombstone stubs, retention and (seq,id) order', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { records, manifest, lines } = await readExport(result.outDir)

  const stubs = records.filter((record) => record.deleted === true)
  const live = records.filter((record) => record.deleted !== true)
  assert.equal(stubs.length, 2, 'two directly tombstoned entries become stubs')
  assert.equal(live.length, 6, 'six live records remain (legacy 5, 10, 20, 21, 70, 80)')
  assert.equal(manifest.recordCount, 6)
  assert.equal(result.recordCount, 6)
  assert.equal(result.tombstoneStubs, 2)
  assert.equal(result.skippedReplies, 1, 'a reply under a tombstoned root is not exported')
  assert.equal(result.skippedRetention, 1, 'an entry older than retentionDays is hidden from the export')
  assert.equal(manifest.firstSeq, fixture.seqs.legacy)
  assert.equal(manifest.lastSeq, fixture.seqs.minimal)
  assert.equal(lines.length, records.length)

  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]
    const current = records[index]
    assert.ok(
      previous.seq < current.seq || (previous.seq === current.seq && previous.id <= current.id),
      `records not sorted at line ${index + 1}: ${previous.seq} then ${current.seq}`,
    )
  }

  const tombstoned = stubs.find((record) => record.id === fixture.ids.tombstoned)
  assert.ok(tombstoned)
  assert.equal(tombstoned.wsKey, GLOBAL_SCOPE_KEY)
  assert.equal(tombstoned.title, '')
  assert.equal(tombstoned.body, '')
  assert.equal(Object.prototype.hasOwnProperty.call(tombstoned, 'tags'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(tombstoned, 'files'), false)
  assert.deepEqual(tombstoned.author, { sessionId: 'session-author', origin: 'agent' }, 'stub author is reduced')
  assert.equal(tombstoned.deletedAt, ISO(NOW - 2 * 60 * 60 * 1000))
  assert.equal(tombstoned.replyTo, null)
  assert.equal(tombstoned.resolves, null)
  assert.equal(tombstoned.supersedes, null)

  const deletedRoot = stubs.find((record) => record.id === fixture.ids.deletedRoot)
  assert.ok(deletedRoot)
  assert.equal(deletedRoot.author.origin, 'user')
  assert.equal(records.some((record) => record.id === fixture.ids.deletedReply), false, 'reply under a tombstoned root must be absent')
  assert.equal(records.some((record) => record.id === fixture.ids.old), false, 'retention-hidden entry must be absent')
});

// ---------------------------------------------------------------------------
// EXP-04 — file integrity (V7 single reading)
// ---------------------------------------------------------------------------

test('EXP-04 manifest hashes/bytes cover the whole file while counts cover live records only', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const file = path.join(result.outDir, MEMORIES_FILE)
  const bytes = await fs.readFile(file)
  const manifest = JSON.parse(await fs.readFile(path.join(result.outDir, EXPORT_MANIFEST_FILE), 'utf8'))

  assert.equal(manifest.files.length, 1)
  assert.equal(manifest.files[0].name, MEMORIES_FILE)
  assert.equal(manifest.files[0].bytes, bytes.length)
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.files[0].sha256, manifest.files[0].sha256)
  assert.equal(result.files[0].bytes, manifest.files[0].bytes)

  const lines = bytes.toString('utf8').split('\n').filter((line) => line.length > 0)
  assert.equal(manifest.recordCount, lines.filter((line) => JSON.parse(line).deleted !== true).length)
  assert.equal(manifest.recordCount < lines.length, true, 'tombstone stubs are file content but not counted')
  assert.ok(lines.every((line) => Buffer.byteLength(line, 'utf8') <= 64 * 1024), 'per-line 64 KiB cap')
  assert.ok(bytes.length <= EXPORT_MAX_BYTES)
});

// ---------------------------------------------------------------------------
// EXP-05 — redaction + relative file hints
// ---------------------------------------------------------------------------

test('EXP-05 export re-applies redaction, strips absolute paths and keeps file hints relative', async () => {
  const fixture = seed()
  const { result } = await exportFixture(fixture)
  const { jsonl, records } = await readExport(result.outDir)

  assert.equal(jsonl.includes(leakedKey), false, 'API key must be redacted from title/body')
  assert.equal(jsonl.includes('mockuser'), false, 'no absolute home path may survive')
  assert.equal(jsonl.includes('..\\escape'), false, 'no escaping relative path may survive')

  const gotcha = records.find((record) => record.id === fixture.ids.gotcha)
  assert.ok(gotcha)
  assert.deepEqual(gotcha.files, ['src/fs/rename.ts'], 'only the relative, non-denied hint survives')
  assert.deepEqual(gotcha.tags, ['windows', 'fs'], 'tags are normalised to lowercase valid labels')
  assert.equal(gotcha.title.includes(leakedKey), false)
  assert.equal(gotcha.body.includes(leakedKey), false)
  assert.equal(gotcha.body.includes('[redacted]'), true, 'the secret is redacted and reported')
});

// ---------------------------------------------------------------------------
// EXP-06 — determinism
// ---------------------------------------------------------------------------

test('EXP-06 repeated exports are byte-identical; only generatedAt may differ between runs', async () => {
  const fixture = seed()
  const first = await exportFixture(fixture)
  const second = await exportFixture(fixture)
  const later = await exportFixture({ ...fixture, now: () => NOW + 60_000 })

  const a = await readExport(first.result.outDir)
  const b = await readExport(second.result.outDir)
  const c = await readExport(later.result.outDir)
  assert.equal(a.jsonl, b.jsonl, 'same store + same clock must produce identical JSONL bytes')
  assert.equal(a.manifest.files[0].sha256, b.manifest.files[0].sha256)
  assert.deepEqual({ ...a.manifest, generatedAt: null }, { ...b.manifest, generatedAt: null })

  assert.equal(a.jsonl, c.jsonl, 'JSONL stays byte-identical when only the clock advances')
  assert.notEqual(a.manifest.generatedAt, c.manifest.generatedAt)
  assert.deepEqual({ ...a.manifest, generatedAt: null }, { ...c.manifest, generatedAt: null })
});

// ---------------------------------------------------------------------------
// EXP-07 — read-only store + dry run
// ---------------------------------------------------------------------------

test('EXP-07 export only reads mergedRecords(); dry run writes nothing; no read-back', async () => {
  const fixture = seed()
  const store = createFakeStore(fixture)
  const config = makeConfig()
  const dryDir = path.join(await tempRoot(), 'dry')
  const dry = await exportMemories({
    store,
    config,
    redactor: createRedactor(config, { logger: silentLogger }),
    outDir: dryDir,
    now: () => NOW,
    dryRun: true,
  })
  assert.equal(dry.dryRun, true)
  assert.equal(typeof dry.jsonlText, 'string')
  assert.ok(dry.jsonlText.length > 0)
  assert.equal(existsSync(dryDir), false, 'dry run must not create the export directory')
  assert.equal(store.calls.refreshMerged, 1)
  assert.equal(store.calls.mergedRecords, 1)
  assert.equal(typeof store.appendAndSync, 'undefined', 'the export has no store write path')
  assert.equal(typeof store.openWorkspace, 'undefined', 'the export never opens/creates a workspace journal')
  assert.equal(typeof store.writePresence, 'undefined')

  const real = await exportFixture({ ...fixture, store })
  assert.ok(existsSync(path.join(real.outDir, MEMORIES_FILE)))
  assert.ok(existsSync(path.join(real.outDir, EXPORT_MANIFEST_FILE)))
  // No read-back: a second export from an unchanged store yields identical bytes.
  const again = await exportFixture({ ...fixture, store })
  assert.equal((await readExport(real.outDir)).jsonl, (await readExport(again.outDir)).jsonl)
  assert.equal(store.calls.mergedRecords, 3, 'one mergedRecords read per export (plus the dry run)')
});

// ---------------------------------------------------------------------------
// EXP-08 — failure modes (fail closed)
// ---------------------------------------------------------------------------

test('EXP-08 unsupported store, unsafe outDir and a throwing redactor fail closed', async () => {
  const fixture = seed()
  const config = makeConfig()
  const redactor = createRedactor(config, { logger: silentLogger })
  const cleanOut = path.join(await tempRoot(), 'clean')

  await assert.rejects(
    () => exportMemories({ store: { rootDir: path.join(tmpdir(), 'fake-store-root') }, config, redactor, outDir: cleanOut }),
    (error) => error.code === 'STORE_UNAVAILABLE',
    'a store generation without mergedRecords() is refused, not silently exported empty',
  )

  await assert.rejects(
    () => exportMemories({ store: createFakeStore(fixture), config, redactor: {}, outDir: cleanOut }),
    (error) => error.code === 'BAD_ARGUMENT',
  )

  const storeRoot = path.join(tmpdir(), 'fake-store-root')
  const unsafeDirs = [
    path.join(storeRoot, 'workspaces', GLOBAL_SCOPE_KEY),
    `${path.join(tmpdir(), 'escape')}\\..\\still-escape`,
    '.confluence/export',
  ]
  for (const unsafe of unsafeDirs) {
    await assert.rejects(
      () => exportMemories({ store: createFakeStore({ ...fixture, rootDir: storeRoot }), config, redactor, outDir: unsafe }),
      (error) => error.code === 'BAD_ARGUMENT',
      `expected BAD_ARGUMENT for ${unsafe}`,
    )
  }

  const throwingRedactor = {
    title() {
      throw new Error('boom')
    },
    text: redactor.text,
    files: redactor.files,
    tags: redactor.tags,
  }
  const failOut = path.join(await tempRoot(), 'fail')
  await assert.rejects(
    () => exportMemories({ store: createFakeStore(fixture), config, redactor: throwingRedactor, outDir: failOut }),
    (error) => error.code === 'EXPORT_FAILED',
  )
  assert.equal(existsSync(failOut), false, 'a failed export must not publish a partial pair')

  const brokenStore = createFakeStore(fixture)
  brokenStore.refreshMerged = async () => {
    throw new Error('EACCES: permission denied')
  }
  await assert.rejects(
    () => exportMemories({ store: brokenStore, config, redactor, outDir: cleanOut }),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  assert.equal(existsSync(cleanOut), false)
});

// ---------------------------------------------------------------------------
// EXP-09 — atomic publish order (manifest LAST)
// ---------------------------------------------------------------------------

function recordingFs(onRename) {
  const renames = []
  return {
    renames,
    fs: {
      open: (...args) => fs.open(...args),
      mkdir: (...args) => fs.mkdir(...args),
      unlink: (...args) => fs.unlink(...args),
      rename: async (from, to) => {
        renames.push(path.basename(to))
        if (typeof onRename === 'function') await onRename(from, to)
        return fs.rename(from, to)
      },
    },
  }
}

async function tempFiles(dir) {
  try {
    return (await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))
  } catch {
    return []
  }
}

test('EXP-09 JSONL is published first and manifest.json LAST; a failed manifest leaves no commit marker', async () => {
  const fixture = seed()
  const config = makeConfig()
  const recorder = recordingFs()
  const outDir = path.join(await tempRoot(), 'atomic')
  await exportMemories({
    store: createFakeStore(fixture),
    config,
    redactor: createRedactor(config, { logger: silentLogger }),
    outDir,
    fs: recorder.fs,
    now: () => NOW,
  })
  assert.deepEqual(recorder.renames, [MEMORIES_FILE, EXPORT_MANIFEST_FILE], 'manifest must be renamed last')
  assert.equal(existsSync(path.join(outDir, MEMORIES_FILE)), true)
  assert.equal(existsSync(path.join(outDir, EXPORT_MANIFEST_FILE)), true)
  assert.deepEqual(await tempFiles(outDir), [], 'no temp files may remain after a successful publish')

  const failing = recordingFs(async (_from, to) => {
    if (path.basename(to) === EXPORT_MANIFEST_FILE) {
      const error = new Error('simulated rename failure')
      error.code = 'EPERM'
      throw error
    }
  })
  const failedOut = path.join(await tempRoot(), 'atomic-failed')
  await assert.rejects(
    () =>
      exportMemories({
        store: createFakeStore(fixture),
        config,
        redactor: createRedactor(config, { logger: silentLogger }),
        outDir: failedOut,
        fs: failing.fs,
        now: () => NOW,
      }),
    (error) => error.code === 'STORE_UNAVAILABLE',
  )
  assert.equal(existsSync(path.join(failedOut, MEMORIES_FILE)), true, 'the JSONL may exist without a commit marker')
  assert.equal(existsSync(path.join(failedOut, EXPORT_MANIFEST_FILE)), false, 'never publish a manifest without its JSONL update')
  assert.deepEqual(await tempFiles(failedOut), [], 'a failed publish removes its temp file')
});

// ---------------------------------------------------------------------------
// EXP-10 — caps (8 MiB deterministic tail truncation)
// ---------------------------------------------------------------------------

function bigRecords(count) {
  const records = []
  for (let index = 0; index < count; index += 1) {
    const seq = seqFor(1000 + index)
    records.push({
      v: 1,
      type: 'entry',
      id: `cnf_${seq}`,
      ws: GLOBAL_SCOPE_KEY,
      seq,
      ts: ISO(NOW - 1000),
      kind: 'finding',
      title: `large record ${index}`,
      body: 'b'.repeat(8192),
      author: { sessionId: 'session-big', origin: 'agent' },
    })
  }
  return records
}

test('EXP-10 the 8 MiB cap truncates deterministically from the tail and is recorded in limits', async () => {
  const records = bigRecords(1100)
  // v0.3 config: the note cap is `bus.notes.maxEntries` (the deprecated store key maps onto it).
  const config = resolveConfig({ bus: { notes: { maxEntries: 300 } } }).config
  const { result } = await exportFixture({ records, config, dryRun: true })

  assert.equal(result.truncated, true)
  assert.equal(result.manifest.limits.truncated, true)
  assert.equal(result.manifest.limits.maxEntriesPerWorkspace, 300, 'the global entry cap is reported verbatim')
  assert.ok(result.files[0].bytes <= EXPORT_MAX_BYTES)
  assert.equal(Buffer.byteLength(result.jsonlText, 'utf8'), result.files[0].bytes)
  assert.ok(result.recordCount < records.length, 'the tail (highest seq) is dropped')

  const lines = result.jsonlText.trimEnd().split('\n')
  assert.equal(lines.length, result.recordCount)
  const last = JSON.parse(lines[lines.length - 1])
  assert.ok(last.seq < records[records.length - 1].seq, 'the last emitted record is before the dropped tail')
  // Deterministic: the same input reproduces the same truncation point.
  const again = await exportFixture({ records, config, dryRun: true })
  assert.equal(again.result.jsonlText, result.jsonlText)
  assert.deepEqual(again.result.files, result.files)
});

// ---------------------------------------------------------------------------
// EXP-11 — CLI run() (in-process; no child_process)
// ---------------------------------------------------------------------------

function captureIo() {
  const stdout = []
  const stderr = []
  return {
    out: stdout,
    err: stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  }
}

async function makeDshHome() {
  const root = await tempRoot('confluence-export-cli-')
  const dshHome = path.join(root, 'dsh-home')
  const storeRoot = path.join(dshHome, 'storages', 'confluence', 'v1')
  await fs.mkdir(storeRoot, { recursive: true })
  return { root, dshHome, storeRoot }
}

function cliStoreFactory({ records, legacyMeta, rootDir }) {
  return () => createFakeStore({ records, legacyMeta, rootDir })
}

test('EXP-11 CLI exports the universal scope to the default dsh-home stamp directory', async () => {
  const fixture = seed()
  const { root, dshHome, storeRoot } = await makeDshHome()

  const json = captureIo()
  const code = await run({
    argv: ['--dsh-home', dshHome, '--json'],
    io: json.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(code, 0, `CLI failed: ${json.err.join('')}`)
  const summary = JSON.parse(json.out.join(''))
  assert.equal(summary.ok, true)
  assert.equal(summary.schema, EXPORT_SCHEMA)
  assert.equal(summary.formatVersion, EXPORT_FORMAT_VERSION)
  assert.equal(summary.scope, 'global')
  assert.equal(summary.recordCount, 6)
  assert.equal(summary.tombstoneStubs, 2)
  assert.equal(summary.firstSeq, fixture.seqs.legacy)
  assert.equal(summary.lastSeq, fixture.seqs.minimal)
  assert.equal(summary.dryRun, false)
  const expectedOut = path.join(dshHome, 'storages', 'confluence-exports', utcStamp(NOW))
  assert.equal(summary.outDir, expectedOut)
  assert.equal(existsSync(path.join(expectedOut, MEMORIES_FILE)), true)
  assert.equal(existsSync(path.join(expectedOut, EXPORT_MANIFEST_FILE)), true)

  const customOut = path.join(root, 'custom-out')
  const human = captureIo()
  const humanCode = await run({
    argv: ['--dsh-home', dshHome, '--out', customOut],
    io: human.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(humanCode, 0, human.err.join(''))
  const text = human.out.join('')
  assert.match(text, /Confluence export — confluence\.memories\/v1/)
  assert.match(text, /scope:\s+global\s+\(All sessions\)/)
  assert.match(text, /records:\s+6 live, 2 tombstone stub/)
  assert.equal(existsSync(path.join(customOut, EXPORT_MANIFEST_FILE)), true)

  const dryOut = path.join(root, 'dry-out')
  const dry = captureIo()
  const dryCode = await run({
    argv: ['--dsh-home', dshHome, '--out', dryOut, '--dry-run', '--json'],
    io: dry.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(dryCode, 0, dry.err.join(''))
  assert.equal(JSON.parse(dry.out.join('')).dryRun, true)
  assert.equal(existsSync(dryOut), false)

  // Exit 1: missing home, missing store, unsupported store generation, unsafe --out.
  for (const argv of [
    ['--dsh-home', path.join(root, 'nope')],
    ['--dsh-home', path.join(root, 'empty-home')],
  ]) {
    await fs.mkdir(path.join(root, 'empty-home'), { recursive: true })
    const capture = captureIo()
    const failure = await run({ argv, io: capture.io, now: () => NOW, createStore: () => createFakeStore(fixture) })
    assert.equal(failure, 1)
    assert.match(capture.err.join(''), /STORE_UNAVAILABLE/)
  }

  const unsupported = captureIo()
  const unsupportedCode = await run({
    argv: ['--dsh-home', dshHome],
    io: unsupported.io,
    now: () => NOW,
    createStore: () => ({ rootDir: storeRoot, async init() {}, async close() {} }),
  })
  assert.equal(unsupportedCode, 1)
  assert.match(unsupported.err.join(''), /STORE_UNAVAILABLE/)

  const insideStore = captureIo()
  const insideCode = await run({
    argv: ['--dsh-home', dshHome, '--out', path.join(storeRoot, 'export')],
    io: insideStore.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(insideCode, 1)
  assert.match(insideStore.err.join(''), /BAD_ARGUMENT/)

  // Exit 2: usage errors — no --workspace flag exists in v0.2.0.
  const noWorkspace = captureIo()
  const noWorkspaceCode = await run({
    argv: ['--dsh-home', dshHome, '--workspace', root],
    io: noWorkspace.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(noWorkspaceCode, 2)
  assert.match(noWorkspace.err.join(''), /unknown argument: --workspace/)

  const escapeOut = captureIo()
  const escapeCode = await run({
    argv: ['--dsh-home', dshHome, '--out', '..\\escape'],
    io: escapeOut.io,
    now: () => NOW,
    createStore: cliStoreFactory({ ...fixture, rootDir: storeRoot }),
  })
  assert.equal(escapeCode, 2)
  assert.match(escapeOut.err.join(''), /must not contain/)

  const usage = captureIo()
  assert.equal(await run({ argv: [], io: usage.io }), 2)
});

// ---------------------------------------------------------------------------
// EXP-12 — pure helpers
// ---------------------------------------------------------------------------

test('EXP-12 helper contracts: labels, path stripping, outDir validation, args, default dir', () => {
  assert.equal(workspaceLabelFor('D:\\work\\my-repo'), 'my-repo')
  assert.equal(workspaceLabelFor('/home/u/my-repo'), 'my-repo')
  assert.equal(workspaceLabelFor(''), '')

  assert.equal(stripAbsolutePaths('open C:\\Users\\u\\x.ts now'), 'open <path> now')
  assert.equal(stripAbsolutePaths('see /home/u/project/x.ts'), 'see <path>')
  assert.equal(stripAbsolutePaths('see /opt/secret/config.yml'), 'see <path>')
  assert.equal(stripAbsolutePaths('open /etc/passwd now'), 'open <path> now')
  assert.equal(stripAbsolutePaths('list /srv/data'), 'list <path>')
  assert.equal(stripAbsolutePaths('read ~/notes.txt'), 'read <path>')
  assert.equal(stripAbsolutePaths('https://example.com/a/b'), 'https://example.com/a/b')
  assert.equal(stripAbsolutePaths('https://example.com/a is a URL'), 'https://example.com/a is a URL')
  assert.equal(stripAbsolutePaths('relative/path.ts untouched'), 'relative/path.ts untouched')

  const storeRoot = path.join(tmpdir(), 'fake-store-root')
  const okDir = validateExportDir(path.join(tmpdir(), 'export-out'), storeRoot)
  assert.equal(path.isAbsolute(okDir), true)
  assert.throws(() => validateExportDir('.confluence/export', storeRoot), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => validateExportDir(path.join(storeRoot, 'inside'), storeRoot), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => validateExportDir(`${tmpdir()}\\..\\escape`, storeRoot), (error) => error.code === 'BAD_ARGUMENT')

  assert.equal(validateOutArg('exports/memories'), path.resolve('exports/memories'))
  assert.equal(validateOutArg('C:\\abs\\export'), path.resolve('C:\\abs\\export'))
  assert.throws(() => validateOutArg('../escape'), /must not contain/)
  assert.throws(() => validateOutArg(''), /non-empty/)
  assert.throws(() => validateOutArg('   '), /non-empty/)

  assert.equal(utcStamp(NOW), '20261113T120000Z')
  const dshHome = path.join(tmpdir(), 'dsh-home')
  assert.equal(
    defaultExportDir(dshHome, NOW),
    path.join(dshHome, 'storages', 'confluence-exports', '20261113T120000Z'),
  )

  assert.deepEqual(parseArgs(['--dsh-home', 'h']), { dshHome: 'h', out: '', json: false, dryRun: false, help: false })
  assert.deepEqual(parseArgs(['--dsh-home', 'h', '--out', 'o', '--json', '--dry-run']), {
    dshHome: 'h',
    out: 'o',
    json: true,
    dryRun: true,
    help: false,
  })
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs([]), /--dsh-home is required/)
  assert.throws(() => parseArgs(['--dsh-home', 'h', '--workspace', 'w']), /unknown argument: --workspace/)
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/)
  assert.match(USAGE, /--dsh-home/)
  assert.doesNotMatch(USAGE, /--workspace/)
});

// ---------------------------------------------------------------------------
// EXP-13 — real JournalStore integration: delta surface + read-only contract
// ---------------------------------------------------------------------------

/** Files under `dir` as sorted `{rel, bytes, sha256}` records (directories excluded). */
async function snapshotTree(dir) {
  const out = []
  async function walk(current, prefix) {
    const dirents = await fs.readdir(current, { withFileTypes: true })
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of dirents) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
      const full = path.join(current, dirent.name)
      if (dirent.isDirectory()) {
        await walk(full, rel)
      } else if (dirent.isFile()) {
        const bytes = await fs.readFile(full)
        out.push({ rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  await walk(dir, '')
  return out
}

test('EXP-13 real JournalStore: global + legacy journals merge, store files stay byte-identical', async () => {
  assert.equal(STORE_GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_KEY, 'one reserved global scope key across modules')

  const root = await tempRoot('confluence-export-real-')
  const dshHome = path.join(root, 'dsh-home')
  const storeRoot = path.join(dshHome, 'storages', 'confluence', 'v1')
  const legacyDir = path.join(root, 'old-repo')
  await fs.mkdir(legacyDir, { recursive: true })

  const storeConfig = resolveConfig({ store: { dir: storeRoot, pollMs: 50, watch: false } }).config
  const store = new JournalStore({
    config: storeConfig,
    logger: silentLogger,
    deps: { env: { DSH_HOME: dshHome }, pid: 9001, now: () => NOW, random: () => 0.25 },
  })
  await store.init()
  const globalJournal = await store.openGlobal()
  await globalJournal.appendAndSync({
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(1)}`,
    ws: GLOBAL_SCOPE_KEY,
    seq: seqFor(1),
    ts: ISO(NOW - 60_000),
    kind: 'decision',
    title: 'Universal note from session A',
    body: 'shared memory',
    author: { sessionId: 'session-a', title: 'Session A', origin: 'agent' },
    origin: { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' },
  })
  const legacyJournal = await store.openWorkspace(LEGACY_KEY, { canonicalPath: legacyDir })
  await legacyJournal.appendAndSync({
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(2)}`,
    ws: LEGACY_KEY,
    seq: seqFor(2),
    ts: ISO(NOW - 120_000),
    kind: 'gotcha',
    title: 'Legacy note from v0.1',
    body: 'still visible',
    author: { sessionId: 'session-old', origin: 'agent' },
  })
  await store.close()

  const before = await snapshotTree(storeRoot)
  assert.ok(before.length > 0, 'the store must have on-disk files to compare')

  const capture = captureIo()
  const code = await run({
    argv: ['--dsh-home', dshHome, '--json'],
    io: capture.io,
    now: () => NOW,
  })
  assert.equal(code, 0, `CLI failed: ${capture.err.join('')}`)
  const summary = JSON.parse(capture.out.join(''))
  assert.equal(summary.scope, 'global')
  assert.equal(summary.recordCount, 2, 'global and legacy entries both export')
  assert.equal(summary.outDir, path.join(dshHome, 'storages', 'confluence-exports', utcStamp(NOW)))

  const { records, manifest } = await readExport(summary.outDir)
  assert.deepEqual(manifest.workspace, { wsKey: GLOBAL_SCOPE_KEY, name: 'All sessions' })
  const byId = new Map(records.map((record) => [record.id, record]))
  const universal = byId.get(`cnf_${seqFor(1)}`)
  assert.equal(universal.wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(universal.origin, { workspaceKey: ORIGIN_KEY, workspaceLabel: 'repo-a' })
  const legacy = byId.get(`cnf_${seqFor(2)}`)
  assert.equal(legacy.wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(legacy.origin, { workspaceKey: LEGACY_KEY, workspaceLabel: 'old-repo' }, 'legacy label is the manifest basename')

  const after = await snapshotTree(storeRoot)
  assert.deepEqual(after, before, 'the export must not create, append or rewrite any store file')
});

test('EXP-14 a pre-0.2.0 store without a global journal exports legacy memory and creates nothing', async () => {
  const legacyOnlyKey = 'ws_4444444444444444'
  const root = await tempRoot('confluence-export-legacy-only-')
  const dshHome = path.join(root, 'dsh-home')
  const storeRoot = path.join(dshHome, 'storages', 'confluence', 'v1')
  const legacyDir = path.join(root, 'legacy-only-project')
  await fs.mkdir(legacyDir, { recursive: true })

  const storeConfig = resolveConfig({ store: { dir: storeRoot, pollMs: 50, watch: false } }).config
  const store = new JournalStore({
    config: storeConfig,
    logger: silentLogger,
    deps: { env: { DSH_HOME: dshHome }, pid: 9002, now: () => NOW },
  })
  await store.init()
  const legacyJournal = await store.openWorkspace(legacyOnlyKey, { canonicalPath: legacyDir })
  await legacyJournal.appendAndSync({
    v: 1,
    type: 'entry',
    id: `cnf_${seqFor(1)}`,
    ws: legacyOnlyKey,
    seq: seqFor(1),
    ts: ISO(NOW - 1000),
    kind: 'decision',
    title: 'Only legacy memory exists',
    author: { sessionId: 'session-v01', origin: 'agent' },
  })
  await store.close()

  const workspacesDir = path.join(storeRoot, 'workspaces')
  const workspacesBefore = (await fs.readdir(workspacesDir)).sort()
  assert.equal(workspacesBefore.includes(GLOBAL_SCOPE_KEY), false)
  const before = await snapshotTree(storeRoot)

  const capture = captureIo()
  const code = await run({ argv: ['--dsh-home', dshHome, '--json'], io: capture.io, now: () => NOW })
  assert.equal(code, 0, `CLI failed: ${capture.err.join('')}`)
  const summary = JSON.parse(capture.out.join(''))
  assert.equal(summary.scope, 'global')
  assert.equal(summary.recordCount, 1)

  const { records, manifest } = await readExport(summary.outDir)
  assert.deepEqual(manifest.workspace, { wsKey: GLOBAL_SCOPE_KEY, name: 'All sessions' })
  assert.equal(records.length, 1)
  assert.equal(records[0].wsKey, GLOBAL_SCOPE_KEY)
  assert.deepEqual(records[0].origin, { workspaceKey: legacyOnlyKey, workspaceLabel: 'legacy-only-project' })

  assert.deepEqual((await fs.readdir(workspacesDir)).sort(), workspacesBefore, 'no global scope directory may be created by an export')
  assert.deepEqual(await snapshotTree(storeRoot), before, 'legacy journals stay byte-identical')
});

// ===========================================================================
// v0.4 WSB — `confluence.memory/v1` portability (persona + patterns + styles)
// ===========================================================================
//
// Format authority: lib/export.js. These tests pin deterministic document bytes,
// path stripping, strict/bounded validation, the pure import plan (merge/replace),
// legacy `confluence.profile/v1` document import (persona-only), and the two memory
// CLIs end-to-end (in-process `run()`, no child process).

const MEM_NOW = Date.UTC(2026, 10, 27, 2, 0, 0)
const MEM_ISO = '2026-11-27T02:00:00.000Z'
const MEM_ORIGIN_KEY = 'ws_1111111111111111'

/** Canonical snapshot inputs (deliberately unsorted where order must not matter). */
function memorySnapshotInput() {
  return {
    now: () => MEM_NOW,
    revision: '01J8Z6Q3M00000000000000004',
    persona: [
      { section: 'identity', key: 'name', value: 'Ada', confidence: 0.95, source: 'user', ts: MEM_ISO },
      { section: 'communication', key: 'lang', value: '中文', confidence: 0.9, source: 'user' },
      // Non-persona legacy section: must be dropped from the portable persona.
      { section: 'tech', key: 'stack', value: 'node' },
    ],
    patterns: [
      {
        key: 'windows.path-retry',
        category: 'pitfall',
        title: 'Retry path renames',
        body: 'rename may fail with EPERM; retry.',
        tags: ['Windows', 'fs'],
        scope: 'global',
        status: 'active',
        confidence: 0.8,
        source: 'user',
        ts: MEM_ISO,
      },
      {
        key: 'api.error-envelope',
        category: 'project',
        title: 'API errors use the envelope',
        body: 'Return {code,message}.',
        tags: ['api'],
        scope: 'workspace',
        workspaceLabel: 'repo-a',
        workspaceKey: MEM_ORIGIN_KEY,
        status: 'candidate',
        confidence: 0.5,
        source: 'agent',
      },
    ],
    styles: [
      {
        channel: 'chat',
        area: 'tone',
        key: 'tone.direct',
        title: 'Direct tone',
        rule: 'Answer directly.',
        examples: [{ bad: 'Sure! I can help.', good: 'Done.' }],
        tags: ['tone'],
        priority: 60,
        enabled: true,
        confidence: 0.8,
        source: 'user',
        ts: MEM_ISO,
      },
      {
        channel: 'engineering',
        area: 'commit',
        key: 'commit.zh-conventional',
        title: 'Conventional commits',
        rule: 'Use conventional commit prefixes with a Chinese subject.',
        examples: [],
        tags: ['commit'],
        priority: 50,
        enabled: true,
        confidence: 0.7,
        source: 'user',
      },
    ],
  }
}

const MEMORY_JSON_SNAPSHOT = `{
  "format": "confluence.memory/v1",
  "version": 1,
  "kind": "memory",
  "scope": "global",
  "generatedAt": "2026-11-27T02:00:00.000Z",
  "revision": "01J8Z6Q3M00000000000000004",
  "persona": {
    "sections": [
      {
        "id": "identity",
        "facts": [
          {
            "key": "name",
            "value": "Ada",
            "confidence": 0.95,
            "source": "user",
            "ts": "2026-11-27T02:00:00.000Z"
          }
        ]
      },
      {
        "id": "communication",
        "facts": [
          {
            "key": "lang",
            "value": "中文",
            "confidence": 0.9,
            "source": "user"
          }
        ]
      }
    ]
  },
  "patterns": [
    {
      "key": "api.error-envelope",
      "category": "project",
      "title": "API errors use the envelope",
      "body": "Return {code,message}.",
      "tags": [
        "api"
      ],
      "scope": "workspace",
      "workspaceKey": "ws_1111111111111111",
      "workspaceLabel": "repo-a",
      "status": "candidate",
      "confidence": 0.5,
      "source": "agent"
    },
    {
      "key": "windows.path-retry",
      "category": "pitfall",
      "title": "Retry path renames",
      "body": "rename may fail with EPERM; retry.",
      "tags": [
        "windows",
        "fs"
      ],
      "scope": "global",
      "status": "active",
      "confidence": 0.8,
      "source": "user",
      "ts": "2026-11-27T02:00:00.000Z"
    }
  ],
  "styles": [
    {
      "channel": "chat",
      "area": "tone",
      "key": "tone.direct",
      "title": "Direct tone",
      "rule": "Answer directly.",
      "examples": [
        {
          "bad": "Sure! I can help.",
          "good": "Done."
        }
      ],
      "tags": [
        "tone"
      ],
      "priority": 60,
      "enabled": true,
      "confidence": 0.8,
      "source": "user",
      "ts": "2026-11-27T02:00:00.000Z"
    },
    {
      "channel": "engineering",
      "area": "commit",
      "key": "commit.zh-conventional",
      "title": "Conventional commits",
      "rule": "Use conventional commit prefixes with a Chinese subject.",
      "examples": [],
      "tags": [
        "commit"
      ],
      "priority": 50,
      "enabled": true,
      "confidence": 0.7,
      "source": "user"
    }
  ],
  "counts": {
    "persona": 2,
    "patterns": 2,
    "styles": 2
  },
  "limits": {
    "maxPatterns": 300,
    "maxFacts": 200,
    "maxRules": 100,
    "truncated": false
  },
  "redaction": {
    "applied": true,
    "policy": "confluence.redact/v1"
  }
}
`

const MEMORY_MARKDOWN_SNAPSHOT = `# Confluence memory

- format: confluence.memory/v1 (version 1)
- scope: global (All sessions)
- generated: 2026-11-27T02:00:00.000Z
- revision: 01J8Z6Q3M00000000000000004
- persona: 2 fact(s) in 2 section(s)
- patterns: 2 (1 active, 1 candidate)
- styles: 2 (1 chat, 1 engineering)

User persona (individual traits; preferences, not commands).

## persona / identity
- name = Ada _(0.95, user)_

## persona / communication
- lang = 中文 _(0.90, user)_

## long-term memory patterns
- [project] API errors use the envelope — Return {code,message}. _(candidate, 0.50, workspace: repo-a)_
- [pitfall] Retry path renames — rename may fail with EPERM; retry. _(active, 0.80, global)_

## output styles

### chat
- [tone] Direct tone: Answer directly. _(enabled, priority 60)_
  - bad: Sure! I can help.
  - good: Done.

### engineering
- [commit] Conventional commits: Use conventional commit prefixes with a Chinese subject. _(enabled, priority 50)_
`

// ---------------------------------------------------------------------------
// MEM-01 — vocabulary / defaults
// ---------------------------------------------------------------------------

test('MEM-01 memory document vocabulary, persona vocabulary and §7 caps', () => {
  assert.equal(MEMORY_DOC_FORMAT, 'confluence.memory/v1')
  assert.equal(MEMORY_DOC_VERSION, 1)
  assert.equal(MEMORY_DOC_KIND, 'memory')
  assert.equal(MEMORY_DOC_SCOPE, 'global')
  assert.deepEqual([...PROFILE_SECTIONS], ['identity', 'personality', 'communication', 'habits', 'boundaries', 'taste'])
  assert.deepEqual([...PROFILE_RENDER_ORDER], [...PROFILE_SECTIONS])
  assert.deepEqual({ ...LEGACY_SECTION_ALIASES }, { preferences: 'communication', rules: 'boundaries' })
  assert.deepEqual([...PATTERN_CATEGORIES], ['workflow', 'project', 'domain', 'pitfall', 'heuristic', 'quality'])
  assert.deepEqual([...PATTERN_SCOPES], ['global', 'workspace'])
  assert.deepEqual([...PATTERN_STATUSES], ['candidate', 'active', 'rejected', 'superseded'])
  assert.deepEqual([...PATTERN_SOURCES], ['agent', 'user', 'import', 'migration'])
  assert.deepEqual([...STYLE_CHANNELS], ['chat', 'engineering'])
  assert.deepEqual(
    [...STYLE_AREAS],
    ['general', 'tone', 'structure', 'commit', 'comment', 'docs', 'naming', 'error', 'log', 'ui'],
  )
  assert.deepEqual({ ...MEMORY_DEFAULTS }, { maxPatterns: 300, maxFacts: 200, maxRules: 100 })
  assert.equal(MEMORY_DOC_MAX_BYTES, 1024 * 1024)
  for (const key of ['a', 'windows.path-retry', 'a_b-c.9', '0zero', 'a'.repeat(64)]) {
    assert.equal(PATTERN_KEY_RE.test(key), true, `valid pattern key: ${key}`)
    assert.equal(PROFILE_KEY_RE.test(key), true, `valid persona key: ${key}`)
  }
  for (const key of ['', 'A', '-x', 'x y', 'a'.repeat(65), 'ümlaut', '.dot']) {
    assert.equal(PATTERN_KEY_RE.test(key), false, `invalid pattern key: ${key}`)
  }
  for (const tag of ['windows', 'fs', 'a_b-c', '0tag']) assert.equal(MEMORY_TAG_RE.test(tag), true, tag)
  for (const tag of ['Windows', '', 'a b', '-x', 'a'.repeat(33)]) assert.equal(MEMORY_TAG_RE.test(tag), false, tag)
});

// ---------------------------------------------------------------------------
// MEM-02 — canonical JSON snapshot
// ---------------------------------------------------------------------------

test('MEM-02 buildMemoryDocument emits the canonical confluence.memory/v1 JSON bytes', () => {
  const doc = buildMemoryDocument(memorySnapshotInput())
  assert.equal(serializeMemoryDocument(doc), MEMORY_JSON_SNAPSHOT)
  assert.equal(doc.format, MEMORY_DOC_FORMAT)
  assert.equal(doc.version, 1)
  assert.equal(doc.kind, 'memory')
  assert.equal(doc.scope, 'global')
  assert.equal(doc.generatedAt, MEM_ISO)
  assert.equal(doc.revision, '01J8Z6Q3M00000000000000004')
  assert.deepEqual(doc.counts, { persona: 2, patterns: 2, styles: 2 })
  assert.deepEqual(doc.limits, { maxPatterns: 300, maxFacts: 200, maxRules: 100, truncated: false })
  assert.deepEqual(doc.redaction, { applied: true, policy: 'confluence.redact/v1' })
  assert.deepEqual(doc.persona.sections.map((section) => section.id), ['identity', 'communication'])
  const workspacePattern = doc.patterns.find((pattern) => pattern.key === 'api.error-envelope')
  assert.equal(workspacePattern.workspaceKey, MEM_ORIGIN_KEY, 'workspace-scoped patterns keep their targeting key')
  assert.equal(workspacePattern.workspaceLabel, 'repo-a')
  assert.deepEqual(doc.styles[0].examples, [{ bad: 'Sure! I can help.', good: 'Done.' }])
  assert.equal(doc.styles[1].channel, 'engineering')
  // Pure JSON-compatible data (no live objects/prototypes/exceptions).
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc)
  // The document validates against its own strict validator.
  const validated = validateMemoryDocument(doc)
  assert.deepEqual(validated.counts, doc.counts)
  assert.equal(validated.sourceFormat, MEMORY_DOC_FORMAT)
  assert.equal(validated.kind, 'memory')
});

// ---------------------------------------------------------------------------
// MEM-03 — determinism and bounds
// ---------------------------------------------------------------------------

test('MEM-03 same data + clock => byte-identical JSON; order and clock do not leak', () => {
  const first = buildMemoryDocument(memorySnapshotInput())
  const shuffled = memorySnapshotInput()
  shuffled.persona = [...shuffled.persona].reverse()
  shuffled.patterns = [...shuffled.patterns].reverse()
  shuffled.styles = [...shuffled.styles].reverse()
  const second = buildMemoryDocument(shuffled)
  assert.equal(serializeMemoryDocument(second), serializeMemoryDocument(first), 'input order must not matter')

  const later = buildMemoryDocument({ ...memorySnapshotInput(), now: () => MEM_NOW + 60_000 })
  assert.notEqual(later.generatedAt, first.generatedAt)
  assert.deepEqual({ ...later, generatedAt: first.generatedAt }, first, 'only generatedAt depends on the clock')

  const invalid = memorySnapshotInput()
  invalid.persona.push(
    { section: 'nowhere', key: 'k', value: 'v' },
    { section: 'identity', key: 'Bad Key', value: 'v' },
    { section: 'identity', key: 'empty', value: '   ' },
    null,
    'nope',
  )
  invalid.patterns.push(
    { key: 'Bad Key', category: 'pitfall', title: 't', body: 'b' },
    { key: 'bad-category', category: 'nope', title: 't', body: 'b' },
    null,
  )
  invalid.styles.push(
    { channel: 'nope', area: 'tone', key: 'k', title: 't', rule: 'r' },
    { channel: 'chat', area: 'nope', key: 'k', title: 't', rule: 'r' },
    null,
  )
  assert.equal(
    serializeMemoryDocument(buildMemoryDocument(invalid)),
    serializeMemoryDocument(first),
    'invalid entries are dropped deterministically',
  );

  // Values are normalised: tags lowercased/deduped, title trimmed, workspace label is a
  // sanitized single line, and an unknown status defaults to candidate (never a rule).
  const normalized = buildMemoryDocument({
    now: () => MEM_NOW,
    patterns: [
      { key: 'a.b', category: 'pitfall', title: '  spaced  ', body: 'b', tags: ['Windows', 'windows', 'x y'], status: 'nope', scope: 'workspace', workspaceLabel: 'D:\\work\\repo-a' },
    ],
  })
  assert.equal(normalized.patterns[0].status, 'candidate')
  assert.deepEqual(normalized.patterns[0].tags, ['windows'])
  assert.equal(normalized.patterns[0].title, 'spaced')
  assert.equal(normalized.patterns[0].workspaceLabel, 'repo-a')
  assert.equal(normalized.patterns[0].scope, 'workspace')

  // A workspace-scoped pattern without any label/key is unusable and dropped.
  const droppable = buildMemoryDocument({
    now: () => MEM_NOW,
    patterns: [{ key: 'a.b', category: 'pitfall', title: 't', body: 'b', scope: 'workspace' }],
  })
  assert.deepEqual(droppable.patterns, [])
});

// ---------------------------------------------------------------------------
// MEM-04 — Markdown snapshot
// ---------------------------------------------------------------------------

test('MEM-04 renderMemoryMarkdown emits a deterministic human-readable document', () => {
  const doc = buildMemoryDocument(memorySnapshotInput())
  assert.equal(renderMemoryMarkdown(doc), MEMORY_MARKDOWN_SNAPSHOT)
  assert.equal(renderMemoryMarkdown(JSON.parse(JSON.stringify(doc))), MEMORY_MARKDOWN_SNAPSHOT)
  assert.equal(MEMORY_MARKDOWN_SNAPSHOT.includes('\r'), false)
  assert.doesNotMatch(MEMORY_MARKDOWN_SNAPSHOT, /"format":/)
  assert.throws(() => renderMemoryMarkdown({ format: 'something/else' }), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => renderMemoryMarkdown(null), (error) => error.code === 'BAD_ARGUMENT')
  // Empty document: every section is present with an explicit "empty" line.
  const empty = buildMemoryDocument({ now: () => MEM_NOW })
  const markdown = renderMemoryMarkdown(empty)
  assert.match(markdown, /The persona is empty/)
  assert.match(markdown, /_No patterns recorded\._/)
  assert.match(markdown, /_No style rules recorded\._/)
});

// ---------------------------------------------------------------------------
// MEM-05 — absolute path stripping / redaction marker
// ---------------------------------------------------------------------------

test('MEM-05 exported values never carry absolute or home paths; redaction is marked', () => {
  const doc = buildMemoryDocument({
    now: () => MEM_NOW,
    persona: [
      { section: 'identity', key: 'home', value: 'lives at C:\\Users\\mockuser\\project' },
      { section: 'communication', key: 'posix', value: 'edited /home/u/project/x.ts today' },
      { section: 'habits', key: 'tilde', value: 'notes in ~/notes.txt' },
    ],
    patterns: [
      {
        key: 'paths.leak',
        category: 'pitfall',
        title: 'open C:\\Users\\mockuser\\project\\src\\x.ts',
        body: 'see /opt/secret/config.yml and https://example.com/a/b',
        tags: ['Paths'],
        status: 'active',
        scope: 'workspace',
        workspaceLabel: 'D:\\work\\repo-a',
        workspaceKey: MEM_ORIGIN_KEY,
      },
    ],
    styles: [
      {
        channel: 'engineering',
        area: 'comment',
        key: 'comment.paths',
        title: 'No absolute paths',
        rule: 'never write D:\\work\\repo-a in comments; link relatively',
        examples: [{ bad: 'see C:\\Users\\mockuser\\x.ts', good: 'see src/x.ts' }],
        tags: ['docs'],
        priority: 70,
      },
    ],
    redactionApplied: true,
  })
  const json = serializeMemoryDocument(doc)
  const markdown = renderMemoryMarkdown(doc)
  for (const leaked of ['mockuser', '/home/u', '/opt/secret', '~/notes']) {
    assert.equal(json.includes(leaked), false, `JSON must not leak ${leaked}`)
    assert.equal(markdown.includes(leaked), false, `Markdown must not leak ${leaked}`)
  }
  assert.equal(json.includes('<path>'), true, 'paths are replaced with an obvious marker')
  assert.equal(doc.patterns[0].workspaceLabel, 'repo-a', 'a workspace label is a basename, never a path')
  assert.equal(json.includes('https://example.com/a/b'), true, 'URLs are not mistaken for paths')
  assert.equal(json.includes('C:\\\\'), false, 'no Windows drive path survives JSON escaping')
  assert.deepEqual(doc.redaction, { applied: true, policy: 'confluence.redact/v1' })
  const unredacted = buildMemoryDocument({ now: () => MEM_NOW, redactionApplied: false })
  assert.deepEqual(unredacted.redaction, { applied: false, policy: 'confluence.redact/v1' })
});

// ---------------------------------------------------------------------------
// MEM-06 — caps
// ---------------------------------------------------------------------------

test('MEM-06 memory document caps: count truncation is marked, byte cap fails LIMIT_EXCEEDED', () => {
  const input = memorySnapshotInput()
  const capped = buildMemoryDocument({ ...input, limits: { maxPatterns: 1, maxFacts: 1, maxRules: 1 } })
  assert.deepEqual(capped.counts, { persona: 1, patterns: 1, styles: 1 })
  assert.equal(capped.limits.truncated, true)
  assert.deepEqual(
    buildMemoryDocument({ ...input, limits: { maxPatterns: 1, maxFacts: 1, maxRules: 1 } }),
    capped,
    'count-cap truncation is deterministic',
  );
  // Document limits may never relax the host caps passed by the caller.
  const tightHost = buildMemoryDocument({ ...input, limits: { maxPatterns: 1, maxFacts: 1, maxRules: 1 } })
  assert.equal(tightHost.patterns.length, 1)

  // Byte cap: the document is rejected, never silently truncated.
  assert.throws(
    () => buildMemoryDocument({ ...input, maxExportBytes: 512 }),
    (error) => error.code === 'LIMIT_EXCEEDED' && /export cap/.test(error.message),
  )

  // Empty document: valid, empty counts, no limits truncation.
  const empty = buildMemoryDocument({ now: () => MEM_NOW })
  assert.deepEqual(empty.persona.sections, [])
  assert.deepEqual(empty.counts, { persona: 0, patterns: 0, styles: 0 })
  assert.equal(empty.revision, null)
  assert.equal(empty.limits.truncated, false)
  assert.deepEqual(validateMemoryDocument(empty).counts, empty.counts)
});

// ---------------------------------------------------------------------------
// MEM-07 — strict validation
// ---------------------------------------------------------------------------

test('MEM-07 validateMemoryDocument accepts our export and rejects malformed/oversized documents', () => {
  const doc = buildMemoryDocument(memorySnapshotInput())
  const fromObject = validateMemoryDocument(doc)
  assert.deepEqual(fromObject.patterns.map((pattern) => pattern.key), ['api.error-envelope', 'windows.path-retry'])
  assert.deepEqual(fromObject.styles.map((style) => style.key), ['tone.direct', 'commit.zh-conventional'])
  assert.equal(fromObject.revision, doc.revision)
  const fromText = validateMemoryDocument(serializeMemoryDocument(doc))
  assert.deepEqual(fromText.counts, fromObject.counts, 'canonical JSON text is accepted exactly like an object')

  const bad = [
    [{}, 'BAD_ARGUMENT'],
    [null, 'BAD_ARGUMENT'],
    ['null', 'BAD_ARGUMENT'],
    ['not json', 'BAD_ARGUMENT'],
    [{ format: 'confluence.memory/v2', version: 1 }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 2 }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: '1' }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, extra: true }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, kind: 'board' }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, scope: 'workspace' }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, revision: 'x'.repeat(65) }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, persona: { sections: [{ id: 'preferences', facts: [] }] } }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, persona: { sections: [{ id: 'identity', facts: [{ key: 'k', value: '' }] }] } }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, persona: { sections: [{ id: 'identity', facts: [{ key: 'Bad', value: 'v' }] }] } }, 'BAD_ARGUMENT'],
    [{ format: MEMORY_DOC_FORMAT, version: 1, persona: { sections: [{ id: 'identity', facts: [{ key: 'k', value: 'v', extra: 1 }] }] } }, 'BAD_ARGUMENT'],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        patterns: [{ key: 'a.b', category: 'pitfall', title: 't', body: 'b', status: 'active', extra: 1 }],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        patterns: [{ key: 'a.b', category: 'pitfall', title: 't', body: 'b', status: 'active', scope: 'workspace' }],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        patterns: [{ key: 'a.b', category: 'pitfall', title: 't', body: '   ', status: 'active' }],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        styles: [{ channel: 'chat', area: 'commit', key: 'k', title: 't', rule: 'r' }],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        patterns: [{ key: 'a.b', category: 'pitfall', title: 't', body: 'b', status: 'active', workspaceKey: 'nope' }],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        patterns: [
          { key: 'a.b', category: 'pitfall', title: 't', body: 'b', status: 'active' },
          { key: 'a.b', category: 'pitfall', title: 't2', body: 'b', status: 'active' },
        ],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        styles: [{ channel: 'chat', area: 'tone', key: 'k', title: 't', rule: 'r', extra: 1 }],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        styles: [{ channel: 'chat', area: 'tone', key: 'k', title: 't', rule: 'r', priority: 101 }],
      },
      'BAD_ARGUMENT',
    ],
    [
      {
        format: MEMORY_DOC_FORMAT,
        version: 1,
        styles: [
          { channel: 'chat', area: 'tone', key: 'k', title: 't', rule: 'r' },
          { channel: 'chat', area: 'tone', key: 'k', title: 't2', rule: 'r2' },
        ],
      },
      'BAD_ARGUMENT',
    ],
  ]
  for (const [value, code] of bad) {
    assert.throws(
      () => validateMemoryDocument(value),
      (error) => error.code === code,
      `expected ${code} for ${JSON.stringify(value)?.slice(0, 90)}`,
    )
  }

  // Caps: host limits and the document's own limits are both enforced.
  const threePatterns = {
    format: MEMORY_DOC_FORMAT,
    version: 1,
    patterns: ['a', 'b', 'c'].map((key) => ({ key, category: 'pitfall', title: key, body: 'b', status: 'active' })),
  }
  assert.throws(() => validateMemoryDocument(threePatterns, { maxPatterns: 2 }), (error) => error.code === 'LIMIT_EXCEEDED')
  assert.throws(
    () => validateMemoryDocument({ ...threePatterns, limits: { maxPatterns: 2 } }),
    (error) => error.code === 'LIMIT_EXCEEDED',
  )
  // A document cannot relax the host caps with a larger limits block.
  assert.throws(() => validateMemoryDocument({ ...threePatterns, limits: { maxPatterns: 99 } }, { maxPatterns: 2 }), (error) => error.code === 'LIMIT_EXCEEDED')
  assert.throws(
    () =>
      validateMemoryDocument({
        format: MEMORY_DOC_FORMAT,
        version: 1,
        patterns: [{ key: 'big', category: 'pitfall', title: 't', body: 'x'.repeat(2049), status: 'active' }],
      }),
    (error) => error.code === 'BODY_TOO_LARGE',
  )
  assert.throws(
    () => validateMemoryDocument('x'.repeat(1024 * 1024 + 1)),
    (error) => error.code === 'LIMIT_EXCEEDED',
    'an oversized raw document is rejected before parsing',
  )
});

// ---------------------------------------------------------------------------
// MEM-08 — pure import plan (merge/replace) and record building
// ---------------------------------------------------------------------------

test('MEM-08 importMemoryDocument returns a pure merge/replace plan; records are import-sourced and active', () => {
  const doc = buildMemoryDocument(memorySnapshotInput())
  const live = {
    patterns: [
      { key: 'windows.path-retry', category: 'pitfall', title: 'old', body: 'old', status: 'active', source: 'user' },
      { key: 'legacy.to-reject', category: 'domain', title: 'old', body: 'old', status: 'active', source: 'agent' },
      { key: 'already-rejected', category: 'domain', title: 'old', body: 'old', status: 'rejected', source: 'user' },
    ],
    styles: [
      { channel: 'chat', area: 'tone', key: 'tone.direct', title: 'old', rule: 'old', enabled: true },
      { channel: 'engineering', area: 'commit', key: 'commit.legacy', title: 'old', rule: 'old', enabled: true },
      { channel: 'engineering', area: 'docs', key: 'docs.disabled', title: 'old', rule: 'old', enabled: false },
    ],
  }
  const merge = importMemoryDocument(doc, { mode: 'merge', live })
  assert.equal(merge.ok, true)
  assert.equal(merge.mode, 'merge')
  assert.equal(merge.sourceFormat, MEMORY_DOC_FORMAT)
  assert.equal(merge.kind, 'memory')
  assert.equal(merge.persona.reset, false)
  assert.equal(merge.persona.count, 2)
  assert.equal(merge.patterns.count, 2)
  assert.equal(merge.patterns.rejected, 0, 'merge never rejects')
  assert.equal(merge.styles.count, 2)
  assert.equal(merge.styles.disabled, 0, 'merge never disables')
  for (const pattern of merge.patterns.upsert) {
    assert.equal(pattern.source, 'import', 'imported patterns are import-sourced')
    assert.equal(pattern.status, 'active', 'imported patterns are written active')
  }
  for (const style of merge.styles.upsert) assert.equal(style.source, 'import')

  const replace = importMemoryDocument(doc, { mode: 'replace', live })
  assert.equal(replace.persona.reset, true)
  assert.equal(replace.patterns.rejected, 1)
  assert.deepEqual(replace.patterns.reject.map((pattern) => pattern.key), ['legacy.to-reject'])
  assert.equal(replace.patterns.reject[0].status, 'rejected')
  assert.equal(replace.patterns.reject[0].source, 'import')
  assert.equal(replace.styles.disabled, 1)
  assert.deepEqual(
    replace.styles.disable.map((style) => `${style.channel}/${style.key}`),
    ['engineering/commit.legacy'],
  )
  assert.equal(replace.styles.disable[0].enabled, false)
  assert.equal(replace.styles.disable[0].source, 'import')

  // Records are complete append bodies with ids/ws/author and import provenance.
  let counter = 0
  const records = buildMemoryImportRecords(replace, {
    now: () => MEM_NOW,
    nextId: () => seqFor(1000 + counter++),
    author: { title: 'memory-import' },
  })
  assert.equal(records.counts.patterns, 3, '2 upserts + 1 reject')
  assert.equal(records.counts.styles, 3, '2 upserts + 1 disable')
  for (const record of records.patterns) {
    assert.equal(record.v, 1)
    assert.equal(record.ws, GLOBAL_SCOPE_KEY)
    assert.match(record.id, /^pat_[0-9A-Z]{26}$/)
    assert.equal(record.type, 'pattern')
    assert.equal(record.source, 'import')
    assert.equal(record.ts, MEM_ISO)
    assert.deepEqual(record.evidence, [])
    assert.deepEqual(record.author, { title: 'memory-import' })
  }
  for (const record of records.styles) {
    assert.equal(record.type, 'style')
    assert.equal(record.source, 'import')
    assert.match(record.id, /^sty_[0-9A-Z]{26}$/)
    assert.ok(typeof record.priority === 'number' && record.enabled === (record.key !== 'commit.legacy'))
  }
  const upsertPattern = records.patterns.find((record) => record.key === 'api.error-envelope')
  assert.equal(upsertPattern.status, 'active')
  assert.equal(upsertPattern.workspaceKey, MEM_ORIGIN_KEY, 'workspace targeting survives the plan')
  assert.equal(upsertPattern.workspaceLabel, 'repo-a')

  // A legacy workspace-scoped pattern that only carries a label imports as a global rule
  // (the fold cannot target a workspace without the key; same leniency as the memory service).
  const labelOnlyPlan = importMemoryDocument(
    {
      format: MEMORY_DOC_FORMAT,
      version: 1,
      patterns: [
        {
          key: 'legacy.label-only',
          category: 'project',
          title: 'Legacy label only',
          body: 'Body.',
          scope: 'workspace',
          workspaceLabel: 'repo-a',
          status: 'candidate',
        },
      ],
    },
    { mode: 'merge' },
  )
  const labelOnlyRecords = buildMemoryImportRecords(labelOnlyPlan, { now: () => MEM_NOW, nextId: () => seqFor(5) })
  assert.equal(labelOnlyRecords.patterns.length, 1)
  assert.equal(labelOnlyRecords.patterns[0].scope, 'global')
  assert.equal(labelOnlyRecords.patterns[0].workspaceKey, undefined)
  assert.equal(labelOnlyRecords.patterns[0].workspaceLabel, undefined)

  assert.throws(() => importMemoryDocument(doc, { mode: 'overwrite' }), (error) => error.code === 'BAD_ARGUMENT')
  assert.throws(() => buildMemoryImportRecords({ ok: false }), (error) => error.code === 'BAD_ARGUMENT')
});

// ---------------------------------------------------------------------------
// MEM-09 — legacy `confluence.profile/v1` document import (persona-only)
// ---------------------------------------------------------------------------

function legacyProfileSnapshot() {
  // A hand-written v0.3 document: the six v0.3 sections, including the non-persona tech/context
  // facts that v0.4 imports structurally validate and then skip.
  return {
    format: PROFILE_DOC_FORMAT,
    version: 1,
    kind: 'profile',
    scope: 'global',
    generatedAt: MEM_ISO,
    revision: '01J8Z6Q3M00000000000000003',
    sections: [
      { id: 'identity', facts: [{ key: 'name', value: 'Ada', confidence: 0.95, source: 'user', updatedAt: MEM_ISO }] },
      { id: 'preferences', facts: [{ key: 'lang', value: '中文', confidence: 0.9, source: 'user' }] },
      { id: 'rules', facts: [{ key: 'ask', value: 'always ask', confidence: 0.8, source: 'agent' }] },
      { id: 'tech', facts: [{ key: 'stack', value: 'node', confidence: 0.9, source: 'agent' }] },
      { id: 'context', facts: [{ key: 'repo', value: 'app', confidence: 0.9, source: 'agent' }] },
    ],
    counts: { sections: 5, facts: 5 },
    limits: { maxFacts: 200, maxExportBytes: 65536, truncated: false },
    redaction: { applied: true, policy: 'confluence.redact/v1' },
  }
}

test('MEM-09 legacy profile/v1 documents stay importable as persona-only imports', () => {
  const doc = legacyProfileSnapshot()
  assert.equal(doc.format, PROFILE_DOC_FORMAT)
  const validated = validateMemoryDocument(doc)
  assert.equal(validated.sourceFormat, PROFILE_DOC_FORMAT)
  assert.equal(validated.kind, 'profile')
  assert.equal(validated.personaOnly, true)
  assert.equal(validated.skippedNonPersona, 2, 'tech/context are validated but never persona-imported')
  assert.deepEqual(validated.persona.sections.map((section) => section.id), ['identity', 'communication', 'boundaries'])
  assert.deepEqual(validated.patterns, [])
  assert.deepEqual(validated.styles, [])

  const live = {
    patterns: [{ key: 'keep.me', category: 'domain', title: 'keep', body: 'b', status: 'active' }],
    styles: [{ channel: 'chat', area: 'tone', key: 'keep.me', title: 'keep', rule: 'r', enabled: true }],
  }
  const plan = importMemoryDocument(doc, { mode: 'replace', live })
  assert.equal(plan.personaOnly, true)
  assert.equal(plan.persona.reset, true)
  assert.equal(plan.persona.count, 3)
  assert.deepEqual(plan.patterns, { upsert: [], reject: [], count: 0, rejected: 0 }, 'a legacy document never touches patterns')
  assert.deepEqual(plan.styles, { upsert: [], disable: [], count: 0, disabled: 0 })
  const records = buildMemoryImportRecords(plan, { now: () => MEM_NOW, nextId: () => seqFor(1) })
  assert.deepEqual(records.counts, { patterns: 0, styles: 0 })
});

// ---------------------------------------------------------------------------
// MEM-10 — memory CLI contract (args / defaults / formats / dry-run / exit codes)
// ---------------------------------------------------------------------------

/** Deterministic pattern fold (the memory service's pure header, mirrored for CLI tests). */
function foldPatternsForTest(records) {
  const byKey = new Map()
  for (const record of records) {
    if (!record || record.type !== 'pattern' || typeof record.key !== 'string') continue
    const existing = byKey.get(record.key)
    if (existing === undefined || String(record.seq) > String(existing.seq)) byKey.set(record.key, record)
  }
  const active = []
  const candidates = []
  for (const record of byKey.values()) {
    if (record.status === 'active') active.push(record)
    else if (record.status === 'candidate') candidates.push(record)
  }
  return { byKey, active, candidates, counts: { total: byKey.size, active: active.length, candidates: candidates.length } }
}

/** Deterministic style fold (per (channel,key), greatest seq wins; enabled only). */
function foldStylesForTest(records) {
  const byChannelKey = new Map()
  for (const record of records) {
    if (!record || record.type !== 'style' || typeof record.key !== 'string') continue
    const mapKey = `${record.channel}\u0000${record.key}`
    const existing = byChannelKey.get(mapKey)
    if (existing === undefined || String(record.seq) > String(existing.seq)) byChannelKey.set(mapKey, record)
  }
  const active = []
  for (const record of byChannelKey.values()) if (record.enabled !== false) active.push(record)
  return { byChannelKey, active, counts: { total: byChannelKey.size, active: active.length } }
}

/** In-memory store double for the memory CLIs (implements the read + append surfaces). */
function createMemoryFakeStore({ records = [], rootDir = path.join(tmpdir(), 'fake-memory-store'), now = () => MEM_NOW } = {}) {
  const journalRecords = [...records]
  let appended = 0
  const journal = {
    records: () => journalRecords,
    async appendAndSync(record) {
      appended += 1
      const stored = {
        v: 1,
        ws: GLOBAL_SCOPE_KEY,
        seq: seqFor(7000 + appended),
        ts: ISO(typeof now === 'function' ? now() : MEM_NOW),
        ...record,
      }
      journalRecords.push(stored)
      return stored
    },
    async append(record) {
      return await this.appendAndSync(record)
    },
  }
  return {
    rootDir,
    records: journalRecords,
    journal,
    calls: { init: 0, refreshMerged: 0 },
    async init() {
      this.calls.init += 1
    },
    async openGlobal() {
      return journal
    },
    globalJournal() {
      return journal
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
}

function patternRecord(seq, fields = {}) {
  return {
    v: 1,
    type: 'pattern',
    id: `pat_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: MEM_ISO,
    evidence: [],
    author: { title: 'fixture' },
    ...fields,
  }
}

function styleRecord(seq, fields = {}) {
  return {
    v: 1,
    type: 'style',
    id: `sty_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: MEM_ISO,
    examples: [],
    author: { title: 'fixture' },
    ...fields,
  }
}

test('MEM-10 memory CLI contract: args, defaults, formats, dry-run and exit codes 0/1/2', async () => {
  assert.match(EXPORT_USAGE, /--dsh-home/)
  assert.match(EXPORT_USAGE, /--format/)
  assert.match(IMPORT_USAGE, /--from/)
  assert.match(IMPORT_USAGE, /--mode/)

  assert.deepEqual(parseExportArgs(['--dsh-home', 'h']), {
    dshHome: 'h',
    out: '',
    format: 'json',
    json: false,
    dryRun: false,
    help: false,
  })
  assert.throws(() => parseExportArgs([]), /--dsh-home is required/)
  assert.throws(() => parseExportArgs(['--dsh-home', 'h', '--format', 'yaml']), /--format/)
  assert.throws(() => parseExportArgs(['--dsh-home', 'h', '--out']), /requires a value/)
  assert.throws(() => parseExportArgs(['--workspace', 'w']), /unknown argument/)
  assert.equal(utcStamp(MEM_NOW), '20261127T020000Z')
  const home = path.resolve('/x/dsh-home')
  assert.equal(
    defaultExportFile('/x/dsh-home', MEM_NOW, 'json'),
    path.join(home, 'storages', 'confluence-exports', 'memory-20261127T020000Z.json'),
  )
  assert.equal(
    defaultExportFile('/x/dsh-home', MEM_NOW, 'md'),
    path.join(home, 'storages', 'confluence-exports', 'memory-20261127T020000Z.md'),
  )

  assert.deepEqual(parseImportArgs(['--dsh-home', 'h', '--from', 'f']), {
    dshHome: 'h',
    from: 'f',
    mode: 'merge',
    json: false,
    dryRun: false,
    help: false,
  })
  assert.throws(() => parseImportArgs(['--from', 'f']), /--dsh-home is required/)
  assert.throws(() => parseImportArgs(['--dsh-home', 'h']), /--from is required/)
  assert.throws(() => parseImportArgs(['--dsh-home', 'h', '--from', 'f', '--mode', 'upsert']), /--mode/)

  // Usage errors => exit 2 (nothing executed).
  const emptyExport = captureIo()
  assert.equal(await runExport({ argv: [], io: emptyExport.io }), 2)
  const emptyImport = captureIo()
  assert.equal(await runImport({ argv: [], io: emptyImport.io }), 2)
  const help = captureIo()
  assert.equal(await runExport({ argv: ['--help'], io: help.io }), 0)
  assert.match(help.out.join(''), /Usage: node scripts\/memory-export\.mjs/)
  const importHelp = captureIo()
  assert.equal(await runImport({ argv: ['--help'], io: importHelp.io }), 0)
  assert.match(importHelp.out.join(''), /Usage: node scripts\/memory-import\.mjs/)

  // Runtime errors => exit 1: missing home/store, missing --from file, unsafe --out.
  const missingHome = captureIo()
  assert.equal(await runExport({ argv: ['--dsh-home', path.join(tmpdir(), 'confluence-nope-home')], io: missingHome.io }), 1)
  assert.match(missingHome.err.join(''), /STORE_UNAVAILABLE/)

  const { dshHome, storeRoot, root } = await makeDshHome()
  const missingStore = captureIo()
  assert.equal(await runExport({ argv: ['--dsh-home', path.join(tmpdir(), 'confluence-nope-store')], io: missingStore.io }), 1)

  const missingFrom = captureIo()
  assert.equal(
    await runImport({ argv: ['--dsh-home', dshHome, '--from', path.join(tmpdir(), 'confluence-nope-doc.json')], io: missingFrom.io }),
    1,
  )
  assert.match(missingFrom.err.join(''), /NOT_FOUND/)

  // A rejected document creates no store side effect (validation happens before any write path).
  const badDocPath = path.join(root, 'bad-doc.json')
  await fs.writeFile(badDocPath, '{"format":"wrong","version":1}', 'utf8')
  const freshHome = path.join(root, 'fresh-home')
  const badDoc = captureIo()
  assert.equal(await runImport({ argv: ['--dsh-home', freshHome, '--from', badDocPath], io: badDoc.io }), 1)
  assert.match(badDoc.err.join(''), /BAD_ARGUMENT/)
  assert.equal(existsSync(freshHome), false, 'a rejected import never creates the DSH_HOME/store')

  // Unsafe --out: ".." is a usage error, store containment is a runtime error.
  const escapeOut = captureIo()
  assert.equal(
    await runExport({
      argv: ['--dsh-home', dshHome, '--out', '..\\escape.json'],
      io: escapeOut.io,
      now: () => MEM_NOW,
      createStore: () => createMemoryFakeStore({ rootDir: storeRoot }),
      loadFolds: async () => ({ foldPatterns: foldPatternsForTest, foldStyles: foldStylesForTest }),
    }),
    2,
  )
  const insideStore = captureIo()
  assert.equal(
    await runExport({
      argv: ['--dsh-home', dshHome, '--out', path.join(storeRoot, 'export.json')],
      io: insideStore.io,
      now: () => MEM_NOW,
      createStore: () => createMemoryFakeStore({ rootDir: storeRoot }),
      loadFolds: async () => ({ foldPatterns: foldPatternsForTest, foldStyles: foldStylesForTest }),
    }),
    1,
  );
  assert.match(insideStore.err.join(''), /BAD_ARGUMENT/)

  // Dry run on a fresh home: exit 0, no store and no file created.
  const dryHome = path.join(root, 'dry-home')
  const emptyDocPath = path.join(root, 'empty-memory.json')
  await fs.writeFile(emptyDocPath, serializeMemoryDocument(buildMemoryDocument({ now: () => MEM_NOW })), 'utf8')
  const importDry = captureIo()
  assert.equal(
    await runImport({ argv: ['--dsh-home', dryHome, '--from', emptyDocPath, '--dry-run', '--json'], io: importDry.io, now: () => MEM_NOW }),
    0,
  )
  assert.equal(JSON.parse(importDry.out.join('')).dryRun, true)
  assert.equal(existsSync(dryHome), false, 'a dry-run import writes nothing and creates no store')
});

// ---------------------------------------------------------------------------
// MEM-11 — CLI export -> import -> export round-trips
// ---------------------------------------------------------------------------

test('MEM-11 CLI export -> import -> export round-trip (fake store incl. patterns/styles)', async () => {
  const first = await makeDshHome()
  const profileSeed = [
    {
      v: 1,
      type: 'profile',
      id: `prf_${seqFor(1)}`,
      ws: GLOBAL_SCOPE_KEY,
      seq: seqFor(1),
      ts: MEM_ISO,
      section: 'identity',
      key: 'name',
      value: 'Ada',
      confidence: 0.95,
      source: 'user',
    },
    {
      v: 1,
      type: 'profile',
      id: `prf_${seqFor(2)}`,
      ws: GLOBAL_SCOPE_KEY,
      seq: seqFor(2),
      ts: MEM_ISO,
      section: 'preferences',
      key: 'lang',
      value: '中文',
      confidence: 0.9,
      source: 'user',
    },
  ]
  const patternSeed = [
    patternRecord(seqFor(10), {
      key: 'windows.path-retry',
      category: 'pitfall',
      title: 'Retry path renames',
      body: 'Rename may fail with EPERM; retry.',
      tags: ['windows', 'fs'],
      scope: 'global',
      status: 'active',
      confidence: 0.8,
      source: 'user',
    }),
    patternRecord(seqFor(11), {
      key: 'api.error-envelope',
      category: 'project',
      title: 'API errors use the envelope',
      body: 'Return {code,message}.',
      tags: ['api'],
      scope: 'global',
      status: 'candidate',
      confidence: 0.5,
      source: 'agent',
    }),
  ]
  const styleSeed = [
    styleRecord(seqFor(12), {
      channel: 'chat',
      area: 'tone',
      key: 'tone.direct',
      title: 'Direct tone',
      rule: 'Answer directly.',
      tags: ['tone'],
      priority: 60,
      enabled: true,
      confidence: 0.8,
      source: 'user',
    }),
    styleRecord(seqFor(13), {
      channel: 'engineering',
      area: 'commit',
      key: 'commit.conventional',
      title: 'Conventional commits',
      rule: 'Use conventional commit prefixes.',
      tags: ['commit'],
      priority: 50,
      enabled: true,
      confidence: 0.7,
      source: 'user',
    }),
  ]
  const storeA = createMemoryFakeStore({
    records: [...profileSeed, ...patternSeed, ...styleSeed],
    rootDir: first.storeRoot,
  })
  const outFile = path.join(first.root, 'memory.json')
  const exportRun = captureIo()
  const exportCode = await runExport({
    argv: ['--dsh-home', first.dshHome, '--out', outFile, '--json'],
    io: exportRun.io,
    now: () => MEM_NOW,
    createStore: () => storeA,
    loadFolds: async () => ({ foldPatterns: foldPatternsForTest, foldStyles: foldStylesForTest }),
  })
  assert.equal(exportCode, 0, exportRun.err.join(''))
  const exportSummary = JSON.parse(exportRun.out.join(''))
  assert.equal(exportSummary.persona, 2)
  assert.equal(exportSummary.patterns, 2)
  assert.equal(exportSummary.styles, 2)
  assert.equal(exportSummary.folds.patterns, 'available')
  assert.equal(exportSummary.truncated, false)
  assert.equal(exportSummary.revision, seqFor(13))
  const exportedText = await fs.readFile(outFile, 'utf8')
  assert.equal(exportedText.includes(first.dshHome.replace(/\\/g, '\\\\')), false, 'the store path never leaks into the document')
  const exportedDoc = JSON.parse(exportedText)
  assert.equal(exportedDoc.format, MEMORY_DOC_FORMAT)
  assert.deepEqual(exportedDoc.persona.sections.map((section) => section.id), ['identity', 'communication'])
  assert.equal(exportedDoc.patterns.find((pattern) => pattern.key === 'api.error-envelope').status, 'candidate')

  // Import into a second fresh home, then export again: the persona survives, patterns and
  // styles come back active/import-sourced, and the document stays structurally identical.
  const second = await makeDshHome()
  const storeB = createMemoryFakeStore({ rootDir: second.storeRoot })
  const importRun = captureIo()
  const importCode = await runImport({
    argv: ['--dsh-home', second.dshHome, '--from', outFile, '--mode', 'replace', '--json'],
    io: importRun.io,
    now: () => MEM_NOW,
    createStore: () => storeB,
    loadFolds: async () => ({ foldPatterns: foldPatternsForTest, foldStyles: foldStylesForTest }),
  })
  assert.equal(importCode, 0, importRun.err.join(''))
  const importSummary = JSON.parse(importRun.out.join(''))
  assert.equal(importSummary.imported.persona, 2)
  assert.equal(importSummary.imported.patterns, 2)
  assert.equal(importSummary.imported.styles, 2)
  assert.equal(importSummary.imported.rejected, 0)
  assert.equal(importSummary.imported.disabled, 0)
  assert.equal(importSummary.mode, 'replace')

  const againFile = path.join(second.root, 'again.json')
  const exportAgain = captureIo()
  const againCode = await runExport({
    argv: ['--dsh-home', second.dshHome, '--out', againFile, '--json'],
    io: exportAgain.io,
    now: () => MEM_NOW,
    createStore: () => storeB,
    loadFolds: async () => ({ foldPatterns: foldPatternsForTest, foldStyles: foldStylesForTest }),
  })
  assert.equal(againCode, 0, exportAgain.err.join(''))
  const roundTripped = JSON.parse(await fs.readFile(againFile, 'utf8'))
  assert.deepEqual(roundTripped.persona.sections, exportedDoc.persona.sections, 'persona survives export -> import -> export')
  assert.deepEqual(
    roundTripped.patterns.map((pattern) => [pattern.key, pattern.status, pattern.source, pattern.confidence]),
    exportedDoc.patterns.map((pattern) => [pattern.key, 'active', 'import', pattern.confidence]),
    'patterns re-enter as active import-sourced rules',
  )
  assert.deepEqual(
    roundTripped.styles.map((style) => [style.channel, style.key, style.enabled, style.source]),
    exportedDoc.styles.map((style) => [style.channel, style.key, true, 'import']),
    'styles re-enter as enabled import-sourced rules',
  )
  assert.deepEqual(roundTripped.counts, exportedDoc.counts)

  // A second replace import of the same document is idempotent for the persona and does
  // not grow the live pattern/style set in a way that changes the exported document.
  const replaceRun = captureIo()
  assert.equal(
    await runImport({
      argv: ['--dsh-home', second.dshHome, '--from', againFile, '--mode', 'replace', '--json'],
      io: replaceRun.io,
      now: () => MEM_NOW,
      createStore: () => storeB,
      loadFolds: async () => ({ foldPatterns: foldPatternsForTest, foldStyles: foldStylesForTest }),
    }),
    0,
    replaceRun.err.join(''),
  )
  const finalFile = path.join(second.root, 'final.json')
  assert.equal(
    await runExport({
      argv: ['--dsh-home', second.dshHome, '--out', finalFile, '--json'],
      io: captureIo().io,
      now: () => MEM_NOW,
      createStore: () => storeB,
      loadFolds: async () => ({ foldPatterns: foldPatternsForTest, foldStyles: foldStylesForTest }),
    }),
    0,
  )
  const finalDoc = JSON.parse(await fs.readFile(finalFile, 'utf8'))
  assert.deepEqual(finalDoc.patterns, roundTripped.patterns, 're-importing an exported document is stable')
  assert.deepEqual(finalDoc.styles, roundTripped.styles)
});

test('MEM-11b CLI round-trip over a real temporary DSH_HOME (persona-only document)', async () => {
  const first = await makeDshHome()
  // Seed the persona through the real JournalStore + ProfileService (append-only records on disk).
  const seedConfig = resolveConfig({ store: { dir: first.storeRoot, pollMs: 50, watch: false } }).config
  const seedStore = new JournalStore({
    config: seedConfig,
    logger: silentLogger,
    deps: { env: { DSH_HOME: first.dshHome }, pid: 9701, now: () => MEM_NOW, random: () => 0.3 },
  })
  await seedStore.init()
  const seedProfile = new ProfileService({
    store: seedStore,
    config: seedConfig,
    redactor: createRedactor(seedConfig, { logger: silentLogger }),
    logger: silentLogger,
    deps: { now: () => MEM_NOW },
  })
  await seedProfile.attach()
  await seedProfile.setFacts({
    facts: [
      { section: 'identity', key: 'name', value: 'Ada', confidence: 0.95 },
      { section: 'preferences', key: 'lang', value: '中文', confidence: 0.9 },
    ],
  })
  await seedStore.close()

  const exportFile = path.join(first.root, 'memory-real.json')
  const exportRun = captureIo()
  const exportCode = await runExport({ argv: ['--dsh-home', first.dshHome, '--out', exportFile, '--json'], io: exportRun.io, now: () => MEM_NOW })
  assert.equal(exportCode, 0, exportRun.err.join(''))
  const exportSummary = JSON.parse(exportRun.out.join(''))
  assert.equal(exportSummary.persona, 2)
  assert.equal(exportSummary.patterns, 0)
  const exportedDoc = JSON.parse(await fs.readFile(exportFile, 'utf8'))
  assert.deepEqual(exportedDoc.persona.sections.map((section) => section.id), ['identity', 'communication'])

  const second = await makeDshHome()
  const importRun = captureIo()
  const importCode = await runImport({
    argv: ['--dsh-home', second.dshHome, '--from', exportFile, '--mode', 'replace', '--json'],
    io: importRun.io,
    now: () => MEM_NOW,
    createStore: (options) =>
      new JournalStore({
        ...options,
        deps: { ...options.deps, now: () => MEM_NOW, pid: 9801, random: () => 0.3 },
      }),
  })
  assert.equal(importCode, 0, importRun.err.join(''))
  const importSummary = JSON.parse(importRun.out.join(''))
  assert.equal(importSummary.imported.persona, 2)
  assert.equal(importSummary.sourceFormat, MEMORY_DOC_FORMAT)

  const againFile = path.join(second.root, 'again-real.json')
  const againRun = captureIo()
  assert.equal(
    await runExport({ argv: ['--dsh-home', second.dshHome, '--out', againFile, '--json'], io: againRun.io, now: () => MEM_NOW }),
    0,
    againRun.err.join(''),
  )
  const roundTripped = JSON.parse(await fs.readFile(againFile, 'utf8'))
  assert.deepEqual(roundTripped.persona.sections, exportedDoc.persona.sections, 'real-store persona round-trip')
  assert.deepEqual(roundTripped.patterns, [])
  assert.deepEqual(roundTripped.styles, [])

  // The exported document is a valid memory document and a valid import document.
  const validated = validateMemoryDocument(roundTripped)
  assert.deepEqual(validated.counts, roundTripped.counts)

  // An invalid document is rejected without creating a store under the target home.
  const badPath = path.join(second.root, 'bad.json')
  await fs.writeFile(badPath, '{"format":"confluence.memory/v1","version":1,"persona":{"sections":[{"id":"nope","facts":[]}]}}', 'utf8')
  const thirdHome = path.join(second.root, 'third-home')
  const badRun = captureIo()
  assert.equal(
    await runImport({ argv: ['--dsh-home', thirdHome, '--from', badPath, '--json'], io: badRun.io, now: () => MEM_NOW }),
    1,
  );
  assert.match(badRun.err.join(''), /BAD_ARGUMENT/)
  assert.equal(existsSync(thirdHome), false);
});
