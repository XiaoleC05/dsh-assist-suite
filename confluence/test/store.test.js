// WP1 unit tests — lib/store.js (v0.3 multi-scope + v0.4 global memory record types)
//
// Covers the retained v1 journal contract (append/merge/dedupe/torn tail,
// manifest validation, presence, root resolution, single-flight opens) plus the
// v0.3 delta from docs/plan/v0.3-interfaces.md §2 and §3.1:
//   - the v0.3 known record types (entry/session/tombstone/context/message/
//     profile/profile-reset) and their minimal shape validation,
//   - per-scope merged views: isolation, ordering, dedupe, caching, change feeds,
//   - refreshMerged(scopeKey) opening an on-disk scope read-only (never creating),
//   - the removal of the v0.2 legacy→global read merge; legacyRecords() is a cold
//     tooling/export scan only,
//   - open-journal LRU cap + closeWorkspace (global scope pinned),
//   - listWorkspaces()'s panel/facade shape,
//   - the v0.4 global record types (pattern/style/memory-migration, §1.1/§1.2/§1.4):
//     envelope parsing, both-immutable-events retention per stable key and the
//     minimal shape validation (vocabularies/caps live in lib/memory.js/style.js).
//
// All store instances use deterministic deps (fixed pid/clock/random) and
// per-test temp roots. A "workspace directory" here is exactly what v0.3 opens
// for a real workspace (v0.1 directories are reused as-is).

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_LABEL, JournalStore } from '../lib/store.js'
import { createUlidFactory, isUlid } from '../lib/util.js'
import { DEFAULTS } from '../lib/config.js'

// Reserved determinism: fixed keys/paths/clock, no ambient process state.
const WS_A = 'ws_aaaaaaaaaaaaaaaa'
const WS_B = 'ws_bbbbbbbbbbbbbbbb'
const WS_C = 'ws_cccccccccccccccc'
const WS_D = 'ws_dddddddddddddddd'
const WS_E = 'ws_eeeeeeeeeeeeeeee'
const WS_F = 'ws_ffffffffffffffff'
const PATH_A = 'D:\\05_Code\\alpha'
const PATH_B = 'D:\\05_Code\\beta'
const PATH_C = 'D:\\05_Code\\gamma'
const TS = '2026-11-16T12:00:00.000Z'

/** @type {JournalStore[]} */
const stores = []
/** @type {string[]} */
const tempDirs = []

after(async () => {
  for (const store of stores) {
    try {
      await store.close()
    } catch {
      // ignore cleanup failures
    }
  }
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'confluence-store-'))
  tempDirs.push(dir)
  return dir
}

function seededRandom(seed = 0.42) {
  let state = Math.floor(seed * 1_000_000) + 1
  return () => {
    state = (state * 9301 + 49297) % 233280
    return state / 233280
  }
}

/**
 * @param {{root?: string, pid?: number, seed?: number, pollMs?: number, watch?: boolean, logger?: object, retryDelays?: number[], maxOpenWorkspaces?: number}} [options]
 */
async function newStore(options = {}) {
  const root = options.root ?? (await tempRoot())
  let tick = 1_700_000_000_000
  /** @type {Record<string, unknown>} */
  const storeConfig = {
    ...DEFAULTS.store,
    dir: root,
    pollMs: options.pollMs ?? 50,
    watch: options.watch ?? false,
  }
  if (options.maxOpenWorkspaces !== undefined) storeConfig.maxOpenWorkspaces = options.maxOpenWorkspaces
  const config = { store: storeConfig }
  const store = new JournalStore({
    config,
    logger: options.logger,
    deps: {
      pid: options.pid ?? 4001,
      platform: 'win32', // deterministic basename semantics for Windows-style manifests
      random: seededRandom(options.seed ?? 0.42),
      now: () => {
        tick += 1000
        return tick
      },
      retryDelays: options.retryDelays ?? [0, 0, 0],
    },
  })
  stores.push(store)
  await store.init()
  return { store, root }
}

function seqFactory(seed = 0.7, startMs = 1_700_000_000_000) {
  let tick = startMs
  return createUlidFactory(
    () => {
      tick += 1
      return tick
    },
    seededRandom(seed),
  )
}

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {string} id
 * @param {Record<string, unknown>} [overrides]
 */
function entry(wsKey, seq, id, overrides = {}) {
  return {
    v: 1,
    type: 'entry',
    id,
    ws: wsKey,
    seq,
    ts: TS,
    kind: 'finding',
    title: `title-${id}`,
    author: { sessionId: 'session-author', origin: 'agent' },
    ...overrides,
  }
}

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {string} sessionId
 * @param {Record<string, unknown>} [overrides]
 */
function sessionRow(wsKey, seq, sessionId, overrides = {}) {
  return {
    v: 1,
    type: 'session',
    ws: wsKey,
    seq,
    ts: TS,
    sessionId,
    turns: 1,
    lastActivityTs: TS,
    status: 'idle',
    ...overrides,
  }
}

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {string} key
 * @param {Record<string, unknown>} [overrides]
 */
function contextRecord(wsKey, seq, key, overrides = {}) {
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

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {Record<string, unknown>} [overrides]
 */
function messageRecord(wsKey, seq, overrides = {}) {
  return {
    v: 1,
    type: 'message',
    id: `msg_${seq}`,
    ws: wsKey,
    seq,
    ts: TS,
    from: { sessionId: 'session-author' },
    to: { kind: 'workspace' },
    kind: 'notice',
    body: 'hello',
    ...overrides,
  }
}

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {Record<string, unknown>} [overrides]
 */
function profileRecord(wsKey, seq, overrides = {}) {
  return {
    v: 1,
    type: 'profile',
    id: `prf_${seq}`,
    ws: wsKey,
    seq,
    ts: TS,
    section: 'identity',
    key: 'name',
    value: 'Ada',
    confidence: 0.9,
    source: 'agent',
    ...overrides,
  }
}

/**
 * @param {string} wsKey
 * @param {string} seq
 * @param {Record<string, unknown>} [overrides]
 */
function profileResetRecord(wsKey, seq, overrides = {}) {
  return {
    v: 1,
    type: 'profile-reset',
    id: `prr_${seq}`,
    ws: wsKey,
    seq,
    ts: TS,
    source: 'import',
    ...overrides,
  }
}

/**
 * v0.4 long-term-memory record (§1.1); every status change is a new record with
 * the same stable key, so the journal keeps both immutable events.
 *
 * @param {string} wsKey
 * @param {string} seq
 * @param {string} key
 * @param {Record<string, unknown>} [overrides]
 */
function patternRecord(wsKey, seq, key, overrides = {}) {
  return {
    v: 1,
    type: 'pattern',
    id: `pat_${seq}`,
    ws: wsKey,
    seq,
    ts: TS,
    key,
    category: 'workflow',
    title: `title-${key}`,
    body: 'reusable body',
    tags: ['windows'],
    scope: 'global',
    status: 'candidate',
    confidence: 0.5,
    source: 'agent',
    ...overrides,
  }
}

/**
 * v0.4 output-style record (§1.2).
 *
 * @param {string} wsKey
 * @param {string} seq
 * @param {string} channel
 * @param {string} key
 * @param {Record<string, unknown>} [overrides]
 */
function styleRecord(wsKey, seq, channel, key, overrides = {}) {
  return {
    v: 1,
    type: 'style',
    id: `sty_${seq}`,
    ws: wsKey,
    seq,
    ts: TS,
    channel,
    area: channel === 'chat' ? 'tone' : 'commit',
    key,
    title: `title-${key}`,
    rule: 'write concisely',
    examples: [],
    tags: ['style'],
    priority: 50,
    enabled: true,
    confidence: 0.8,
    source: 'user',
    ...overrides,
  }
}

/**
 * v0.4 one-time migration marker (§1.4).
 *
 * @param {string} wsKey
 * @param {string} seq
 * @param {Record<string, unknown>} [overrides]
 */
function memoryMigrationRecord(wsKey, seq, overrides = {}) {
  return {
    v: 1,
    type: 'memory-migration',
    id: `mig_${seq}`,
    ws: wsKey,
    seq,
    ts: TS,
    version: 1,
    source: 'profile-v03',
    ...overrides,
  }
}

/**
 * Seed a workspace directory by hand (manifest + shards). v0.3 opens such a
 * directory as the journal of that workspace, exactly like a reused v0.1 dir.
 *
 * @param {string} root
 * @param {string} wsKey
 * @param {{canonicalPath?: string, label?: string, shards?: Record<string, object[] | string>, rawManifest?: string}} spec
 */
async function seedWorkspace(root, wsKey, spec = {}) {
  const dir = path.join(root, 'workspaces', wsKey)
  await mkdir(dir, { recursive: true })
  const manifest =
    spec.rawManifest ??
    JSON.stringify({
      format: 'confluence.store/v1',
      formatVersion: 1,
      ws: wsKey,
      workspace: {
        key: wsKey,
        canonicalPath: spec.canonicalPath ?? PATH_A,
        ...(spec.label === undefined ? {} : { label: spec.label }),
        createdAt: TS,
      },
      generation: 0,
    })
  await writeFile(path.join(dir, 'MANIFEST.v1.json'), manifest, 'utf8')
  for (const [writerId, records] of Object.entries(spec.shards ?? {})) {
    const content =
      typeof records === 'string' ? records : records.map((record) => `${JSON.stringify(record)}\n`).join('')
    await writeFile(path.join(dir, `journal.${writerId}.v1.jsonl`), content, 'utf8')
  }
  return dir
}

/** Recursive directory snapshot (files -> exact bytes, dirs -> nested snapshot). */
async function snapshotFiles(dir) {
  const out = {}
  let dirents = []
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name)
    if (dirent.isDirectory()) out[`${dirent.name}/`] = await snapshotFiles(full)
    else if (dirent.isFile()) out[dirent.name] = await readFile(full, 'utf8')
  }
  return out
}

// ---------------------------------------------------------------------------
// retained v1 journal contract
// ---------------------------------------------------------------------------

test('UT-STORE-01 a record line round-trips: envelope assigned, one LF-terminated JSON object', async () => {
  const { store, root } = await newStore()
  const journal = await store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  const stored = await journal.append({ type: 'entry', id: 'cnf_roundtrip', kind: 'finding', title: 'hello' })

  assert.equal(stored.v, 1)
  assert.equal(stored.ws, WS_A)
  assert.ok(isUlid(stored.seq))
  assert.match(stored.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const shardPath = path.join(root, 'workspaces', WS_A, `journal.${store.writerId}.v1.jsonl`)
  const raw = await readFile(shardPath, 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.equal(raw.split('\n').filter((line) => line !== '').length, 1, 'exactly one record line')
  assert.deepEqual(JSON.parse(raw.trim()), stored)

  await journal.refresh({ force: true })
  assert.deepEqual(journal.records(), [stored])

  // A record can never be written under another journal key.
  await assert.rejects(
    () => journal.append({ type: 'entry', id: 'cnf_wrong', ws: WS_B, kind: 'finding', title: 'x' }),
    (error) => error.code === 'BAD_ARGUMENT',
  )
})

test('UT-STORE-02 journal dedupe: entry first-by-seq wins, session rows max-seq win', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const low = seqs()
  const high = seqs()
  const entryId = `cnf_${low}`
  await seedWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: {
      '7001-aaaaaaaa': [entry(WS_A, low, entryId, { title: 'first' }), sessionRow(WS_A, low, 'session-1', { turns: 1 })],
      '7002-bbbbbbbb': [entry(WS_A, high, entryId, { title: 'second' }), sessionRow(WS_A, high, 'session-1', { turns: 2 })],
    },
  })
  const journal = await store.openWorkspace(WS_A) // existing manifest, no meta required
  const records = journal.records()
  assert.equal(records.find((record) => record.type === 'entry').title, 'first')
  assert.equal(records.find((record) => record.type === 'session').turns, 2)
  assert.equal(records.length, 2)
})

test('UT-STORE-03 torn trailing line is ignored; complete prefix reads cleanly', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory()
  const complete = entry(WS_A, seqs(), 'cnf_torn_ok')
  await seedWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: { '9001-aaaaaaaa': `${JSON.stringify(complete)}\n{"v":1,"type":"entry","id":"cnf_trunc` },
  })
  const journal = await store.openWorkspace(WS_A)
  assert.equal(journal.records().length, 1)
  assert.equal(journal.records()[0].id, complete.id)
  await assert.doesNotReject(() => journal.refresh({ force: true }))
})

// ---------------------------------------------------------------------------
// manifest validation + global scope
// ---------------------------------------------------------------------------

test('UT-STORE-10 empty canonicalPath is valid only for the global scope key', async () => {
  const { store, root } = await newStore()

  // A non-global manifest with an empty canonical path is invalid...
  await mkdir(path.join(root, 'workspaces', WS_E), { recursive: true })
  await writeFile(
    path.join(root, 'workspaces', WS_E, 'MANIFEST.v1.json'),
    JSON.stringify({
      format: 'confluence.store/v1',
      formatVersion: 1,
      ws: WS_E,
      workspace: { key: WS_E, canonicalPath: '', createdAt: TS },
      generation: 0,
    }),
    'utf8',
  )
  await assert.rejects(
    () => store.openWorkspace(WS_E),
    (error) => error && error.code === 'STORE_UNAVAILABLE',
  )

  // ...and creating a brand-new non-global journal without a path is refused.
  await assert.rejects(
    () => store.openWorkspace(WS_F),
    (error) => error && error.code === 'BAD_ARGUMENT',
  )

  // An existing manifest with a path still opens by key without meta and is
  // never rewritten (v0.1 workspace directories are reused as-is).
  const dirA = await seedWorkspace(root, WS_A, { canonicalPath: PATH_A })
  const manifestText = await readFile(path.join(dirA, 'MANIFEST.v1.json'), 'utf8')
  const journal = await store.openWorkspace(WS_A)
  assert.equal(journal.wsKey, WS_A)
  assert.equal(await readFile(path.join(dirA, 'MANIFEST.v1.json'), 'utf8'), manifestText)

  // A normal new workspace is created with its canonical path.
  const created = await store.openWorkspace(WS_B, { canonicalPath: PATH_B, label: 'beta' })
  const createdManifest = JSON.parse(
    await readFile(path.join(root, 'workspaces', WS_B, 'MANIFEST.v1.json'), 'utf8'),
  )
  assert.equal(createdManifest.workspace.canonicalPath, PATH_B)
  assert.equal(createdManifest.workspace.label, 'beta')
  assert.equal(created.wsKey, WS_B)
})

test('UT-STORE-11 global scope: manifest shape, empty canonicalPath, idempotent open, presence', async () => {
  const { store, root } = await newStore()
  assert.equal(store.globalJournal(), null, 'no global journal before openGlobal()')

  const journal = await store.openGlobal()
  const globalDir = path.join(root, 'workspaces', GLOBAL_SCOPE_KEY)
  assert.equal(journal.wsKey, GLOBAL_SCOPE_KEY)
  assert.equal(journal.dir, globalDir)
  assert.equal(store.globalJournal(), journal)

  const manifestPath = path.join(globalDir, 'MANIFEST.v1.json')
  const manifestText = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.format, 'confluence.store/v1')
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.ws, GLOBAL_SCOPE_KEY)
  assert.equal(manifest.workspace.key, GLOBAL_SCOPE_KEY)
  assert.equal(manifest.workspace.canonicalPath, '')
  assert.equal(manifest.workspace.label, GLOBAL_SCOPE_LABEL)
  assert.match(manifest.workspace.createdAt, /^\d{4}-\d{2}-\d{2}T/)

  // Idempotent: same journal instance, manifest bytes untouched.
  const second = await store.openGlobal()
  assert.equal(second, journal)
  assert.equal(await readFile(manifestPath, 'utf8'), manifestText)

  const stored = await journal.append({ type: 'entry', id: 'cnf_global_1', kind: 'finding', title: 'shared' })
  assert.equal(stored.ws, GLOBAL_SCOPE_KEY, 'records default to the global scope key')
  assert.deepEqual(store.viewedRecords(GLOBAL_SCOPE_KEY).map((record) => record.id), ['cnf_global_1'])
  assert.deepEqual(store.mergedRecords().map((record) => record.id), ['cnf_global_1'], 'global alias view')
  assert.ok(Object.isFrozen(store.viewedRecords(GLOBAL_SCOPE_KEY)))

  // Presence lives in the global journal and uses the existing atomic writer.
  await journal.writePresence({ sessions: [{ sessionId: 'session-1', title: 'Auth work', status: 'live' }] })
  const presenceFiles = await readdir(path.join(globalDir, 'presence'))
  assert.deepEqual(presenceFiles, [`${store.writerId}.json`])
  const presence = await journal.readPresence()
  assert.deepEqual(presence[store.writerId].sessions, [
    { sessionId: 'session-1', title: 'Auth work', status: 'live' },
  ])
})

// ---------------------------------------------------------------------------
// v0.3 known record types
// ---------------------------------------------------------------------------

test('UT-STORE-12 all ten known record types parse; invalid new-type shapes are skipped', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory(0.37)
  const q = Array.from({ length: 32 }, () => seqs())
  const valid = [
    entry(WS_A, q[0], 'cnf_valid_entry'),
    sessionRow(WS_A, q[1], 'session-valid'),
    { v: 1, type: 'tombstone', id: `tmb_${q[2]}`, ws: WS_A, seq: q[2], ts: TS, target: 'cnf_gone' },
    contextRecord(WS_A, q[3], 'task.progress'),
    contextRecord(WS_A, q[4], 'task.removed', { deleted: true }),
    contextRecord(WS_A, q[5], 'task.json', { value: '{"n":1}', valueType: 'json' }),
    messageRecord(WS_A, q[6]),
    messageRecord(WS_A, q[7], { to: { sessionId: 'session-recipient' }, replyTo: `msg_${q[6]}` }),
    profileRecord(WS_A, q[8]),
    profileRecord(WS_A, q[9], { key: 'gone', deleted: true }),
    profileResetRecord(WS_A, q[10]),
    // v0.4 global memory types: two immutable events for one stable pattern key
    // are both retained (the service folds LWW per key, the journal never drops).
    patternRecord(WS_A, q[11], 'windows.path-retry', { status: 'candidate' }),
    patternRecord(WS_A, q[12], 'windows.path-retry', { status: 'active', body: 'reusable body v2' }),
    styleRecord(WS_A, q[13], 'chat', 'tone.concise'),
    memoryMigrationRecord(WS_A, q[14]),
  ]
  const invalid = [
    // context: no key / no value / bad valueType / bad envelope version
    { v: 1, type: 'context', id: `ctx_${q[15]}`, ws: WS_A, seq: q[15], ts: TS, value: 'x' },
    { v: 1, type: 'context', id: `ctx_${q[16]}`, ws: WS_A, seq: q[16], ts: TS, key: 'k' },
    { v: 1, type: 'context', id: `ctx_${q[17]}`, ws: WS_A, seq: q[17], ts: TS, key: 'k', value: 'x', valueType: 'binary' },
    { v: 2, type: 'context', id: `ctx_${q[18]}`, ws: WS_A, seq: q[18], ts: TS, key: 'k', value: 'x' },
    // message: no from.sessionId / no to
    { v: 1, type: 'message', id: `msg_${q[19]}`, ws: WS_A, seq: q[19], ts: TS, from: {}, to: { kind: 'workspace' }, kind: 'notice', body: 'x' },
    { v: 1, type: 'message', id: `msg_${q[20]}`, ws: WS_A, seq: q[20], ts: TS, from: { sessionId: 's' }, kind: 'notice', body: 'x' },
    // profile: no value
    { v: 1, type: 'profile', id: `prf_${q[21]}`, ws: WS_A, seq: q[21], ts: TS, section: 'identity', key: 'k' },
    // profile-reset: usable id required
    { v: 1, type: 'profile-reset', ws: WS_A, seq: q[22], ts: TS, source: 'import' },
    // pattern: no id / no key; style: no id / no channel; migration: no id
    { v: 1, type: 'pattern', ws: WS_A, seq: q[23], ts: TS, key: 'no-id' },
    { v: 1, type: 'pattern', id: `pat_${q[24]}`, ws: WS_A, seq: q[24], ts: TS },
    { v: 1, type: 'style', ws: WS_A, seq: q[25], ts: TS, channel: 'chat', key: 'no-id' },
    { v: 1, type: 'style', id: `sty_${q[26]}`, ws: WS_A, seq: q[26], ts: TS, key: 'no-channel' },
    { v: 1, type: 'memory-migration', ws: WS_A, seq: q[27], ts: TS, version: 1, source: 'profile-v03' },
    // unknown type / bad seq / wrong journal key
    { v: 1, type: 'signal', id: 'sig_1', ws: WS_A, seq: q[28], ts: TS },
    { v: 1, type: 'context', id: `ctx_${q[29]}`, ws: WS_A, seq: 'not-a-ulid', ts: TS, key: 'k', value: 'x' },
    entry(WS_B, q[30], 'cnf_wrong_ws'),
    'x'.repeat(66000), // over the 64 KiB per-line cap
    '{not json',
  ]
  await seedWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    shards: { '1201-aaaaaaaa': [...valid, ...invalid] },
  })
  const journal = await store.openWorkspace(WS_A)
  const records = journal.records()
  assert.deepEqual(
    records.map((record) => record.id ?? record.sessionId),
    valid.map((record) => record.id ?? record.sessionId),
    'every valid known record is retained (ordered by seq), every invalid line is skipped',
  )
  assert.equal(records.filter((record) => record.type === 'context').length, 3)
  assert.equal(records.filter((record) => record.type === 'message').length, 2)
  assert.equal(records.filter((record) => record.type === 'profile').length, 2)
  assert.equal(records.filter((record) => record.type === 'profile-reset').length, 1)
  assert.equal(records.filter((record) => record.type === 'pattern').length, 2)
  assert.equal(records.filter((record) => record.type === 'style').length, 1)
  assert.equal(records.filter((record) => record.type === 'memory-migration').length, 1)
  assert.deepEqual(
    records.filter((record) => record.type === 'pattern').map((record) => record.status),
    ['candidate', 'active'],
    'two immutable events of one stable key are both kept (append-only, fold owns LWW)',
  )
  assert.ok(records.some((record) => record.type === 'context' && record.deleted === true))
  assert.ok(!records.some((record) => record.id === 'sig_1'))
  assert.ok(!records.some((record) => record.id === 'cnf_wrong_ws'))
  assert.ok(!records.some((record) => record.type === 'pattern' && record.key === 'no-id'))
  assert.ok(!records.some((record) => record.type === 'style' && record.key === 'no-channel'))
})

test('UT-STORE-13 per-scope views are isolated, ordered, deduped and cached per journal', async () => {
  const { store } = await newStore({ pollMs: 60_000 })
  const seqs = seqFactory(0.61)
  const q = Array.from({ length: 16 }, () => seqs())
  const journalA = await store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  const journalB = await store.openWorkspace(WS_B, { canonicalPath: PATH_B, label: 'beta' })
  await journalA.append(entry(WS_A, q[0], 'cnf_a1'))
  await journalB.append(entry(WS_B, q[1], 'cnf_b1'))

  const viewA = store.viewedRecords(WS_A)
  const viewB = store.viewedRecords(WS_B)
  assert.deepEqual(viewA.map((record) => record.id), ['cnf_a1'])
  assert.deepEqual(viewB.map((record) => record.id), ['cnf_b1'])
  assert.equal(store.viewedRecords(WS_A), viewA, 'the per-scope view is cached until that journal changes')
  assert.deepEqual(store.viewedRecords(GLOBAL_SCOPE_KEY), [], 'workspace records never leak into the global view')
  assert.deepEqual(store.mergedRecords(), [], 'the global alias view carries no workspace record')

  // The change feed is per scope.
  const changesA = []
  const changesB = []
  const unsubscribeA = store.onMergedChange(WS_A, (changed) => changesA.push(changed))
  const unsubscribeB = store.onMergedChange(WS_B, (changed) => changesB.push(changed))
  assert.equal(typeof unsubscribeA, 'function')
  await journalA.append(entry(WS_A, q[2], 'cnf_a2'))
  assert.deepEqual(changesA, [true])
  assert.deepEqual(changesB, [], 'the other scope listener is not notified')
  assert.deepEqual(store.viewedRecords(WS_A).map((record) => record.id), ['cnf_a1', 'cnf_a2'])

  // Append-only events of one key are all retained (the fold picks the winner);
  // each new known type keeps its own id and is retained too.
  await journalA.append(contextRecord(WS_A, q[3], 'task.progress', { value: 'old' }))
  await journalA.append(contextRecord(WS_A, q[4], 'task.progress', { value: 'new' }))
  await journalA.append(messageRecord(WS_A, q[5]))
  const contextEvents = store.viewedRecords(WS_A).filter((record) => record.type === 'context')
  assert.deepEqual(contextEvents.map((record) => record.value), ['old', 'new'])
  assert.equal(store.viewedRecords(WS_A).filter((record) => record.type === 'message').length, 1)

  // Junk/never-opened scopes read as the frozen empty array, never a throw.
  assert.deepEqual(store.viewedRecords('not-a-workspace-key'), [])
  assert.deepEqual(store.viewedRecords(undefined), [])
  assert.deepEqual(store.viewedRecords(WS_F), [])
  assert.ok(Object.isFrozen(store.viewedRecords(WS_F)))

  // Unsubscribed listeners stop receiving the feed.
  unsubscribeA()
  unsubscribeB()
  const countBeforeUnsubscribe = changesA.length
  await journalA.append(entry(WS_A, q[6], 'cnf_a3'))
  assert.equal(changesA.length, countBeforeUnsubscribe, 'the unsubscribed callback is no longer called')
})

// ---------------------------------------------------------------------------
// refreshMerged(scopeKey) + read-only open
// ---------------------------------------------------------------------------

test('UT-STORE-14 refreshMerged(scope) opens an on-disk journal read-only and never creates one', async () => {
  const root = await tempRoot()
  const one = await newStore({ root, pid: 7001, seed: 0.11, pollMs: 60_000 })
  const seeded = await one.store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  await seeded.append(entry(WS_A, seqFactory(0.21)(), 'cnf_on_disk'))
  await one.store.close()
  const before = await snapshotFiles(path.join(root, 'workspaces'))

  const two = await newStore({ root, pid: 7002, seed: 0.93, pollMs: 60_000 })
  const changes = []
  two.store.onMergedChange(WS_A, (changed) => changes.push(changed))
  assert.equal(two.store.viewedRecords(WS_A).length, 0, 'not opened yet => empty view')
  assert.equal(await two.store.refreshMerged(WS_A), true, 'the on-disk journal is opened read-only')
  assert.deepEqual(two.store.viewedRecords(WS_A).map((record) => record.id), ['cnf_on_disk'])
  assert.equal(await two.store.refreshMerged(WS_A), false, 'nothing changed => false')
  assert.deepEqual(changes, [], 'opening a scope is not a content change')
  assert.deepEqual(await snapshotFiles(path.join(root, 'workspaces')), before, 'read-only refresh writes nothing')

  // A scope with no manifest on disk is never created by a read.
  const fresh = await newStore()
  assert.equal(await fresh.store.refreshMerged(WS_B), false)
  await assert.rejects(
    () => readdir(path.join(fresh.root, 'workspaces', WS_B)),
    (error) => error && error.code === 'ENOENT',
  )
  assert.equal(await fresh.store.refreshMerged('nope'), false)
})

test('UT-STORE-15 onMergedChange(scope)/refreshMerged(scope) follow one scope across mounts', async () => {
  const root = await tempRoot()
  const one = await newStore({ root, pid: 7001, seed: 0.11, pollMs: 60_000 })
  const two = await newStore({ root, pid: 7002, seed: 0.93, pollMs: 60_000 })
  const seqsOne = seqFactory(0.21)
  const seqsTwo = seqFactory(0.71)

  const changesGlobal = []
  const changesA = []
  one.store.onMergedChange(GLOBAL_SCOPE_KEY, (changed) => changesGlobal.push(changed))
  one.store.onMergedChange(WS_A, (changed) => changesA.push(changed))

  const globalOne = await one.store.openGlobal()
  await globalOne.append(entry(GLOBAL_SCOPE_KEY, seqsOne(), 'cnf_global'))
  assert.deepEqual(changesGlobal, [true], 'the global subscriber fires on a global append')
  assert.deepEqual(changesA, [], 'a workspace subscriber is not notified by the global journal')
  assert.equal(await one.store.refreshMerged(GLOBAL_SCOPE_KEY), false, 'nothing changed => false')

  const journalA = await one.store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  assert.equal(journalA.isOpen, true)

  // Another mount (different writer id) appends to the same workspace journal.
  const journalTwo = await two.store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  await journalTwo.append(entry(WS_A, seqsTwo(), 'cnf_a_remote'))
  assert.equal(await one.store.refreshMerged(WS_A), true)
  assert.deepEqual(changesA, [true], 'the workspace scope listener fires for its own journal only')
  assert.deepEqual(changesGlobal, [true])
  assert.deepEqual(one.store.viewedRecords(WS_A).map((record) => record.id), ['cnf_a_remote'])
  assert.deepEqual(one.store.mergedRecords().map((record) => record.id), ['cnf_global'], 'global view stays isolated')
})

test('UT-STORE-16 refreshMerged(global) opens an existing global scope read-only and merges nothing else', async () => {
  const root = await tempRoot()
  const seeded = await newStore({ root, pid: 6001, seed: 0.31 })
  const seededJournal = await seeded.store.openGlobal()
  await seededJournal.append(entry(GLOBAL_SCOPE_KEY, seqFactory(0.44)(), 'cnf_seeded_global'))
  await seeded.store.close()
  await seedWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    label: 'alpha',
    shards: { '1601-aaaaaaaa': [entry(WS_A, seqFactory(0.55)(), 'cnf_seeded_workspace')] },
  })
  const before = await snapshotFiles(path.join(root, 'workspaces'))

  const { store } = await newStore({ root, pid: 6002, seed: 0.77, pollMs: 60_000 })
  assert.equal(store.globalJournal(), null, 'not opened by init()')
  assert.equal(await store.refreshMerged(GLOBAL_SCOPE_KEY), true, 'the on-disk global journal is opened and merged')
  assert.ok(store.globalJournal() !== null)
  assert.deepEqual(store.viewedRecords(GLOBAL_SCOPE_KEY).map((record) => record.id), ['cnf_seeded_global'])
  assert.deepEqual(store.mergedRecords().map((record) => record.id), ['cnf_seeded_global'])
  assert.equal(store.legacyRecords().length, 1, 'the cold scan still sees the workspace journal for tooling')
  assert.deepEqual(await snapshotFiles(path.join(root, 'workspaces')), before, 'read-only refresh writes nothing')

  // A profile with workspace journals but no global scope never gets one created.
  const fresh = await newStore()
  assert.equal(await fresh.store.refreshMerged(GLOBAL_SCOPE_KEY), false)
  await assert.rejects(
    () => readdir(path.join(fresh.root, 'workspaces', GLOBAL_SCOPE_KEY)),
    (error) => error && error.code === 'ENOENT',
  )
})

// ---------------------------------------------------------------------------
// legacy data: cold scan only, never merged into a v0.3 view
// ---------------------------------------------------------------------------

test('UT-STORE-17 legacyRecords() is a cold read-only scan and legacyView() is gone', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory(0.37)
  const q = Array.from({ length: 8 }, () => seqs())
  await seedWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    label: 'alpha',
    shards: {
      '1201-aaaaaaaa': [
        entry(WS_A, q[1], 'cnf_old_a'),
        entry(WS_A, q[3], 'cnf_cross', { title: 'cross A' }),
        entry(WS_A, q[4], 'cnf_dup', { title: 'older duplicate' }),
      ],
    },
  })
  await seedWorkspace(root, WS_B, {
    canonicalPath: PATH_B,
    label: 'beta',
    shards: {
      '1202-bbbbbbbb': [
        entry(WS_B, q[2], 'cnf_old_b'),
        entry(WS_B, q[5], 'cnf_cross', { title: 'cross B' }),
      ],
    },
  })
  const global = await store.openGlobal()
  await global.append(entry(GLOBAL_SCOPE_KEY, q[6], 'cnf_global'))
  await global.append(entry(GLOBAL_SCOPE_KEY, q[7], 'cnf_dup', { title: 'global wins' }))

  assert.equal(typeof store.legacyView, 'undefined', 'the v0.2 legacy view merge is removed')
  const legacy = store.legacyRecords()
  assert.ok(Object.isFrozen(legacy))
  assert.equal(store.legacyRecords(), legacy, 'the cold scan is cached for the process')
  assert.deepEqual(
    legacy.map((record) => record.id),
    ['cnf_old_a', 'cnf_old_b', 'cnf_cross', 'cnf_dup'],
    'workspace journals are merged/deduped for tooling only: earliest seq wins for one id',
  )
  assert.equal(legacy.find((record) => record.id === 'cnf_cross').ws, WS_A)
  assert.equal(legacy.find((record) => record.id === 'cnf_dup').title, 'older duplicate')

  // Nothing from the cold scan enters a live view.
  assert.deepEqual(store.viewedRecords(GLOBAL_SCOPE_KEY).map((record) => record.id), ['cnf_global', 'cnf_dup'])
  assert.equal(store.viewedRecords(GLOBAL_SCOPE_KEY).find((record) => record.id === 'cnf_dup').title, 'global wins')
  assert.deepEqual(store.viewedRecords(WS_A), [], 'a closed workspace scope is not a read path')
  assert.deepEqual(store.legacyWorkspaceMeta().map((meta) => [meta.wsKey, meta.label]), [
    [WS_A, 'alpha'],
    [WS_B, 'beta'],
  ])
})

test('UT-STORE-18 legacy scans are read-only: no workspace file is modified, created or deleted', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory(0.61)
  const dirA = await seedWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    label: 'alpha',
    shards: { '1101-aaaaaaaa': [entry(WS_A, seqs(), 'cnf_ro_a')] },
  })
  const dirB = await seedWorkspace(root, WS_B, {
    canonicalPath: PATH_B,
    label: 'beta',
    shards: { '2202-bbbbbbbb': [entry(WS_B, seqs(), 'cnf_ro_b')] },
  })
  const beforeA = await snapshotFiles(dirA)
  const beforeB = await snapshotFiles(dirB)

  const journal = await store.openGlobal()
  await journal.append(entry(GLOBAL_SCOPE_KEY, seqs(), 'cnf_global_ro'))
  await store.refreshMerged(GLOBAL_SCOPE_KEY)
  assert.equal(store.legacyWorkspaceMeta().length, 2)
  assert.equal(store.legacyRecords().length, 2)
  assert.equal(store.viewedRecords(GLOBAL_SCOPE_KEY).length, 1)
  await store.listWorkspaces()

  assert.deepEqual(await snapshotFiles(dirA), beforeA, 'workspace A is byte-identical')
  assert.deepEqual(await snapshotFiles(dirB), beforeB, 'workspace B is byte-identical')
  assert.deepEqual(
    (await readdir(dirA)).sort(),
    ['MANIFEST.v1.json', 'journal.1101-aaaaaaaa.v1.jsonl'],
    'no writer shard/presence directory is added to a cooled workspace',
  )
  assert.ok(!(await readdir(path.join(root, 'workspaces'))).includes('presence'))
})

test('UT-STORE-19 corrupt manifests and journal lines are tolerated, never thrown', async () => {
  const { store, root } = await newStore()
  const seqs = seqFactory(0.83)
  const q = Array.from({ length: 8 }, () => seqs())

  const validOne = entry(WS_D, q[1], 'cnf_valid_1')
  const validTwo = entry(WS_D, q[3], 'cnf_valid_2')
  const rawShard = [
    JSON.stringify(validOne),
    'x'.repeat(66000), // over the 64 KiB per-line cap
    '{not json',
    JSON.stringify({ v: 1, type: 'signal', ws: WS_D, seq: q[4], ts: TS }),
    JSON.stringify(entry(WS_A, q[5], 'cnf_wrong_ws')),
    JSON.stringify(validTwo),
    '{"v":1,"type":"entry","id":"cnf_torn', // torn tail, no LF
  ].join('\n')
  await seedWorkspace(root, WS_D, {
    canonicalPath: PATH_C,
    label: 'gamma',
    shards: { '1401-dddddddd': rawShard },
  })
  // Corrupt manifest: the workspace cannot be labelled, so it is skipped.
  await seedWorkspace(root, WS_C, {
    rawManifest: '{not json',
    shards: { '1402-cccccccc': [entry(WS_C, q[2], 'cnf_corrupt_manifest')] },
  })
  // Shard with no manifest at all.
  await mkdir(path.join(root, 'workspaces', WS_E), { recursive: true })
  await writeFile(
    path.join(root, 'workspaces', WS_E, 'journal.1403-eeeeeeee.v1.jsonl'),
    `${JSON.stringify(entry(WS_E, q[6], 'cnf_no_manifest'))}\n`,
    'utf8',
  )

  assert.doesNotThrow(() => store.legacyWorkspaceMeta())
  assert.deepEqual(
    store.legacyWorkspaceMeta().map((item) => [item.wsKey, item.label]),
    [[WS_D, 'gamma']],
  )
  assert.deepEqual(store.legacyRecords().map((record) => record.id), ['cnf_valid_1', 'cnf_valid_2'])
  assert.doesNotThrow(() => store.viewedRecords(WS_D))
  assert.equal(await store.refreshMerged(WS_D), true, 'a corrupt corpus never fails a read refresh')
  assert.deepEqual(store.viewedRecords(WS_D).map((record) => record.id), ['cnf_valid_1', 'cnf_valid_2'])
  const list = await store.listWorkspaces()
  assert.deepEqual(list.map((item) => item.key), [WS_D], 'a corrupt manifest is skipped in the listing')
})

test('UT-STORE-20 a pre-init cold scan is not cached: init() rebinds the real corpus', async () => {
  const base = await tempRoot()
  const root = path.join(base, 'not-yet-created') // init() owns creating the root
  const config = { store: { ...DEFAULTS.store, dir: root, pollMs: 60_000, watch: false } }
  const store = new JournalStore({
    config,
    deps: { pid: 8001, platform: 'win32', random: seededRandom(0.5), now: () => 1_700_000_000_000, retryDelays: [0, 0, 0] },
  })
  stores.push(store)
  assert.deepEqual(store.viewedRecords(GLOBAL_SCOPE_KEY), [], 'no root yet => empty view (and no throw)')
  assert.deepEqual(store.legacyRecords(), [], 'no root yet => no cold records')
  await store.init()
  await seedWorkspace(root, WS_A, {
    canonicalPath: PATH_A,
    label: 'alpha',
    shards: { '1801-aaaaaaaa': [entry(WS_A, seqFactory(0.27)(), 'cnf_late_root')] },
  })
  assert.deepEqual(store.legacyRecords().map((record) => record.id), ['cnf_late_root'])
})

// ---------------------------------------------------------------------------
// open-journal LRU + closeWorkspace
// ---------------------------------------------------------------------------

test('UT-STORE-21 open journals are capped by LRU; the global scope is pinned and closeWorkspace is explicit', async () => {
  const { store } = await newStore({ maxOpenWorkspaces: 2, pollMs: 60_000 })
  const seqs = seqFactory(0.33)
  const global = await store.openGlobal()
  const journalA = await store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  const journalB = await store.openWorkspace(WS_B, { canonicalPath: PATH_B, label: 'beta' })

  assert.equal(journalA.isOpen, false, 'the least recently used workspace is closed when the cap is reached')
  assert.equal(journalB.isOpen, true)
  assert.equal(global.isOpen, true, 'the global scope is pinned and never evicted')
  assert.equal(store.globalJournal(), global)

  // Open one more workspace: the LRU non-global scope is evicted, not the global.
  const journalC = await store.openWorkspace(WS_C, { canonicalPath: PATH_C, label: 'gamma' })
  assert.equal(journalB.isOpen, false)
  assert.equal(journalC.isOpen, true)
  assert.equal(global.isOpen, true)

  // A closed scope keeps its last merged snapshot; a re-open refreshes it.
  await journalC.append(entry(WS_C, seqs(), 'cnf_c'))
  assert.deepEqual(store.viewedRecords(WS_C).map((record) => record.id), ['cnf_c'])
  assert.equal(await store.closeWorkspace(WS_C), true)
  assert.equal(journalC.isOpen, false)
  assert.deepEqual(store.viewedRecords(WS_C).map((record) => record.id), ['cnf_c'], 'snapshot stays readable')
  assert.equal(await store.closeWorkspace(WS_C), false, 'closeWorkspace is idempotent')
  assert.equal(await store.closeWorkspace('not-a-workspace-key'), false)
  const reopenedC = await store.openWorkspace(WS_C)
  assert.equal(reopenedC.isOpen, true)
  assert.equal(await store.closeWorkspace(WS_C), true)

  // Explicit global close is possible and the scope can be re-opened.
  assert.equal(await store.closeWorkspace(GLOBAL_SCOPE_KEY), true)
  assert.equal(store.globalJournal(), null)
  const reopenedGlobal = await store.openGlobal()
  assert.equal(reopenedGlobal.isOpen, true)
})

test('UT-STORE-22 listWorkspaces returns opaque ids/labels/createdAt and skips corrupt dirs', async () => {
  const { store, root } = await newStore()
  await store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' })
  await store.openWorkspace(WS_B, { canonicalPath: PATH_B }) // no explicit label => basename
  await store.openGlobal()
  await mkdir(path.join(root, 'workspaces', WS_C), { recursive: true })
  await writeFile(path.join(root, 'workspaces', WS_C, 'MANIFEST.v1.json'), '{nope', 'utf8')

  const rows = await store.listWorkspaces()
  assert.deepEqual(rows.map((row) => row.key), [GLOBAL_SCOPE_KEY, WS_A, WS_B])
  const byKey = new Map(rows.map((row) => [row.key, row]))
  assert.deepEqual(Object.keys(byKey.get(WS_A)).sort(), ['canonicalPath', 'createdAt', 'key', 'label'])
  assert.equal(byKey.get(WS_A).label, 'alpha')
  assert.equal(byKey.get(WS_A).canonicalPath, PATH_A)
  assert.match(byKey.get(WS_A).createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(Object.keys(byKey.get(GLOBAL_SCOPE_KEY)).sort(), ['createdAt', 'key', 'label'])
  assert.equal(byKey.get(GLOBAL_SCOPE_KEY).label, GLOBAL_SCOPE_LABEL)
  assert.equal(byKey.get(WS_B).label, 'beta', 'a missing manifest label falls back to the path basename')
  assert.equal('wsKey' in byKey.get(WS_A), false, 'the v0.2 wsKey field is renamed to key')
  assert.equal(store.workspaceMeta(WS_A).canonicalPath, PATH_A, 'internal metadata keeps the path for callers')
})

// ---------------------------------------------------------------------------
// root resolution + concurrent opens (retained)
// ---------------------------------------------------------------------------

test('UT-STORE-23 root resolution order: config.store.dir, DSH_HOME env, homedir fallback', async () => {
  const home = await tempRoot()
  const envHome = path.join(home, 'env-home')

  const fallback = new JournalStore({
    config: { store: { dir: '' } },
    deps: { env: {}, homedir: () => home, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(fallback.rootDir, path.join(home, '.dsh', 'storages', 'confluence', 'v1'))

  const fromEnv = new JournalStore({
    config: { store: { dir: '' } },
    deps: {
      env: { DSH_HOME: envHome },
      homedir: () => path.join(home, 'ignored'),
      random: seededRandom(0.1),
      pid: 1,
    },
  })
  assert.equal(fromEnv.rootDir, path.join(envHome, 'storages', 'confluence', 'v1'))

  const relative = new JournalStore({
    config: { store: { dir: 'shared' } },
    deps: { env: { DSH_HOME: envHome }, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(relative.rootDir, path.join(envHome, 'storages', 'confluence', 'shared'))

  const absolute = await tempRoot()
  const absoluteStore = new JournalStore({
    config: { store: { dir: `${absolute}${path.sep}` } },
    deps: { env: { DSH_HOME: envHome }, random: seededRandom(0.1), pid: 1 },
  })
  assert.equal(absoluteStore.rootDir, absolute, 'absolute config dir wins (trailing separator trimmed)')
})

test('UT-STORE-24 concurrent opens share one live journal per key', async () => {
  const { store, root } = await newStore()
  const [first, second] = await Promise.all([store.openGlobal(), store.openGlobal()])
  assert.equal(first, second, 'concurrent opens must return the same journal instance')
  assert.equal(store.globalJournal(), first)
  const [a1, a2] = await Promise.all([
    store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' }),
    store.openWorkspace(WS_A, { canonicalPath: PATH_A, label: 'alpha' }),
  ])
  assert.equal(a1, a2)
  assert.equal(await readFile(path.join(root, 'workspaces', WS_A, 'MANIFEST.v1.json'), 'utf8').then((raw) => JSON.parse(raw).ws), WS_A)
  assert.deepEqual(store.legacyWorkspaceMeta().map((meta) => meta.wsKey), [WS_A])
  await store.close()
  assert.equal(first.isOpen, false, 'close() must close the canonical journal')
  assert.equal(a1.isOpen, false)
})
