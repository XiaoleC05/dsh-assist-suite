// Confluence / 高级记忆 — v0.4 output style card (`style`) tests.
//
// Contract: docs/plan/v0.4-interfaces.md §1.2/§2.3/§3.3/§8 and ADR-0009.
// Hermetic: an in-memory global-journal double that validates every appended
// record, plus real JournalStore instances in temp directories for the
// append-only/cross-mount cases.
//
// Coverage map:
//   STY-01  foldStyles: LWW per (channel,key), active/disabled buckets, total on junk
//   STY-02  set: active/enabled record, defaults, channel↔area mapping, validation
//   STY-03  disable: enabled:false LWW, not injected, idempotent, NOT_FOUND
//   STY-04  renderBlock: §3.3 shape, chat then engineering, priority desc/key asc
//   STY-05  renderBlock budgets: per-channel maxInjectChars, deterministic degradation
//   STY-06  caps: maxRules, rule/examples bytes, title/tags/priority bounds
//   STY-07  redaction: secrets in rule/examples are redacted at write time
//   STY-08  importStyle: source=import, enabled flag, overwrite, caps
//   STY-09  real store: append-only records, cross-instance fold, stable render
//   STY-10  attach without a global journal: safe reads, writes fail STORE_UNAVAILABLE

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { createRedactor } from '../lib/redact.js'
import { GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import {
  STYLE_AREAS,
  STYLE_CHANNELS,
  STYLE_DEFAULTS,
  STYLE_DEFAULT_CONFIDENCE,
  STYLE_DEFAULT_PRIORITY,
  STYLE_KEY_RE,
  STYLE_MAX_EXAMPLES,
  STYLE_MAX_EXAMPLE_BYTES,
  STYLE_MAX_RULE_BYTES,
  STYLE_MAX_TITLE_CHARS,
  StyleService,
  foldStyles,
  styleRevision,
} from '../lib/style.js'
import { isUlid } from '../lib/util.js'

const NOW = Date.UTC(2026, 10, 19, 2, 0, 0)
const ISO = (ms) => new Date(ms).toISOString()
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_PREFIX = '01J8Z6Q3M0'
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

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
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'confluence-style-'))
  tempDirs.push(dir)
  return dir
}

/** Resolved config with style overrides (works before/after config.js grows §7). */
function makeConfig(overrides = {}) {
  const config = resolveConfig({}).config
  return {
    ...config,
    style: { ...STYLE_DEFAULTS, ...overrides },
  }
}

function makeRedactor(config = makeConfig()) {
  return createRedactor(config, { logger: silentLogger })
}

/** One stored `style` record (§1.2). */
function styleRecord(seq, fields = {}) {
  return {
    v: 1,
    type: 'style',
    id: `sty_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: ISO(NOW),
    channel: 'chat',
    area: 'tone',
    key: 'tone.base',
    title: 'Title',
    rule: 'rule',
    examples: [],
    tags: [],
    priority: STYLE_DEFAULT_PRIORITY,
    enabled: true,
    confidence: STYLE_DEFAULT_CONFIDENCE,
    source: 'user',
    ...fields,
  }
}

/** Assert the §1.2 write contract on a fake-journal append. */
function validateAppendedRecord(record) {
  assert.equal(record.v, 1)
  assert.equal(record.ws, GLOBAL_SCOPE_KEY, 'style records live only in the global journal')
  assert.equal(record.type, 'style')
  assert.match(record.id, /^sty_[0-9A-Z]{26}$/)
  assert.ok(STYLE_CHANNELS.includes(record.channel))
  assert.ok(STYLE_AREAS.includes(record.area))
  assert.match(record.key, STYLE_KEY_RE)
  assert.equal(typeof record.title, 'string')
  assert.ok(Array.from(record.title).length <= STYLE_MAX_TITLE_CHARS)
  assert.equal(typeof record.rule, 'string')
  assert.ok(Buffer.byteLength(record.rule, 'utf8') <= STYLE_MAX_RULE_BYTES)
  assert.ok(Array.isArray(record.examples) && record.examples.length <= STYLE_MAX_EXAMPLES)
  for (const example of record.examples) {
    if (example.bad !== undefined) assert.ok(Buffer.byteLength(example.bad, 'utf8') <= STYLE_MAX_EXAMPLE_BYTES)
    if (example.good !== undefined) assert.ok(Buffer.byteLength(example.good, 'utf8') <= STYLE_MAX_EXAMPLE_BYTES)
  }
  assert.ok(Array.isArray(record.tags) && record.tags.length <= 8)
  assert.ok(Number.isInteger(record.priority) && record.priority >= 0 && record.priority <= 100)
  assert.equal(typeof record.enabled, 'boolean')
  assert.equal(typeof record.confidence, 'number')
  assert.ok(record.confidence >= 0 && record.confidence <= 1)
  assert.ok(['user', 'agent', 'import'].includes(record.source))
}

/** In-memory global-journal double (append-only, fills seq/ts). */
function createFakeStore({ records = [] } = {}) {
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
      const stored = { ws: GLOBAL_SCOPE_KEY, seq: seqFor(5000 + appended), ts: ISO(NOW), ...record }
      journalRecords.push(stored)
      for (const listener of [...listeners]) listener(true)
      return stored
    },
    async append(record) {
      return await this.appendAndSync(record)
    },
  }
  return {
    rootDir: path.join(tmpdir(), 'fake-style-store'),
    records: journalRecords,
    calls: { openGlobal: 0 },
    async init() {},
    async openGlobal() {
      this.calls.openGlobal += 1
      return journal
    },
    globalJournal() {
      return journal
    },
    async refreshMerged() {
      return true
    },
    viewedRecords() {
      return journalRecords
    },
    async close() {},
  }
}

async function createService(options = {}) {
  const config = options.config ?? makeConfig()
  const store = options.store ?? createFakeStore({ records: options.records ?? [] })
  let counter = 0
  const service = new StyleService({
    store,
    config,
    redactor: options.redactor ?? makeRedactor(config),
    logger: silentLogger,
    deps: { now: () => NOW, idFactory: options.idFactory ?? (() => seqFor(9000 + (counter += 1))) },
  })
  await service.attach(options.attach ?? {})
  return { service, store, config }
}

/** One valid `set()` input. */
function setInput(fields = {}) {
  return {
    channel: 'chat',
    area: 'tone',
    key: 'tone.concise',
    title: 'Concise tone',
    rule: 'Answer briefly and directly.',
    ...fields,
  }
}

/** Read every shipped style record from the real store's global shard. */
async function readShardStyles(root) {
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
// STY-01 — foldStyles
// ---------------------------------------------------------------------------

test('STY-01 foldStyles: LWW per (channel,key), active/disabled buckets, total on junk', () => {
  const records = [
    styleRecord(seqFor(10), { channel: 'chat', key: 'tone.a', rule: 'old', priority: 10 }),
    styleRecord(seqFor(20), { channel: 'chat', key: 'tone.a', rule: 'new', priority: 90 }),
    styleRecord(seqFor(30), { channel: 'engineering', key: 'commit.a', area: 'commit', rule: 'commit rule' }),
    styleRecord(seqFor(40), { channel: 'chat', key: 'tone.gone', rule: 'disabled', enabled: false }),
    styleRecord(seqFor(50), { channel: 'engineering', key: 'docs.a', area: 'docs', rule: 'docs rule', priority: 80 }),
    // invalid records are ignored by the fold
    styleRecord(seqFor(60), { channel: 'unknown' }),
    styleRecord(seqFor(61), { area: 'nope' }),
    styleRecord(seqFor(62), { key: 'Bad Key' }),
    styleRecord(seqFor(63), { rule: '   ' }),
    { type: 'style', ws: GLOBAL_SCOPE_KEY, seq: seqFor(64), ts: ISO(NOW), channel: 'chat', area: 'tone', key: 'no-id', title: 't', rule: 'r', priority: 50, enabled: true, confidence: 0.8, source: 'user' },
    { not: 'a record' },
    null,
    'nope',
  ]
  const folded = foldStyles(records)
  assert.equal(folded.counts.total, 4)
  assert.equal(folded.counts.active, 3)
  assert.equal(folded.counts.disabled, 1)
  assert.deepEqual(folded.counts.byChannel, { chat: 1, engineering: 2 })
  assert.equal(folded.byChannelKey.get('chat\u0000tone.a').rule, 'new', 'the greatest seq wins')
  assert.equal(folded.byChannelKey.get('chat\u0000tone.a').priority, 90)
  assert.deepEqual(
    folded.active.map((style) => `${style.channel}/${style.key}`),
    ['chat/tone.a', 'engineering/docs.a', 'engineering/commit.a'],
    'chat before engineering, then priority desc',
  )
  assert.deepEqual(folded.disabled.map((style) => style.key), ['tone.gone'])

  assert.deepEqual(foldStyles(undefined).counts, {
    total: 0,
    active: 0,
    disabled: 0,
    byChannel: { chat: 0, engineering: 0 },
  })
  assert.equal(styleRevision(records), seqFor(64))
  assert.equal(styleRevision([{ type: 'pattern', seq: seqFor(99) }]), null)
});

// ---------------------------------------------------------------------------
// STY-02 — set
// ---------------------------------------------------------------------------

test('STY-02 set writes an enabled active card: envelope, defaults, mapping and validation', async () => {
  const { service, store } = await createService()
  const created = await service.set(setInput({ examples: [{ bad: 'Sure!', good: 'Done.' }], tags: ['Tone'], priority: 70 }))
  assert.equal(created.channel, 'chat')
  assert.equal(created.key, 'tone.concise')
  assert.ok(isUlid(created.seq))
  assert.equal(created.style.enabled, true, 'set writes an active (enabled) rule')
  assert.equal(created.style.priority, 70)
  assert.equal(created.style.confidence, STYLE_DEFAULT_CONFIDENCE)
  assert.equal(created.style.source, 'user')
  assert.deepEqual(store.records.at(-1).tags, ['tone'], 'tags are normalised and stored')
  assert.deepEqual(Object.keys(created.style).sort(), [
    'area',
    'channel',
    'confidence',
    'enabled',
    'examples',
    'key',
    'priority',
    'rule',
    'source',
    'tags',
    'title',
    'ts',
  ])

  const stored = store.records.at(-1)
  assert.equal(stored.type, 'style')
  assert.equal(stored.ws, GLOBAL_SCOPE_KEY)
  assert.match(stored.id, /^sty_[0-9A-Z]{26}$/)
  assert.equal(stored.priority, 70)

  // list() exposes both channels in the public shape.
  const listed = service.list()
  assert.equal(listed.count, 1)
  assert.equal(listed.revision, created.seq)
  assert.equal(listed.counts.active, 1)
  assert.equal(service.list({ channel: 'chat' }).count, 1)
  assert.equal(service.list({ channel: 'engineering' }).count, 0)
  assert.throws(() => service.list({ channel: 'nope' }), (error) => error.code === 'BAD_ARGUMENT')

  // Channel ↔ area mapping (§1.2): chat covers tone/structure/general, engineering the rest.
  await service.set(setInput({ area: 'structure', key: 'structure.answer' }))
  await service.set(setInput({ channel: 'engineering', area: 'docs', key: 'docs.readme', title: 'Docs', rule: 'Document decisions.' }))
  await assert.rejects(
    () => service.set(setInput({ area: 'commit' })),
    (error) => error.code === 'BAD_ARGUMENT',
    'a commit rule cannot live in the chat channel',
  )
  await assert.rejects(
    () => service.set(setInput({ channel: 'engineering', area: 'tone' })),
    (error) => error.code === 'BAD_ARGUMENT',
  )

  // Field validation.
  await assert.rejects(() => service.set(setInput({ channel: 'nope' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ area: 'nope' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ key: 'Bad Key' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ title: '   ' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ rule: '' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ priority: 101 })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ priority: 1.5 })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ enabled: 'yes' })), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.set(setInput({ confidence: 2 })), (error) => error.code === 'BAD_ARGUMENT')
});

// ---------------------------------------------------------------------------
// STY-03 — disable
// ---------------------------------------------------------------------------

test('STY-03 disable: enabled:false LWW record, not injected, idempotent, NOT_FOUND', async () => {
  const { service, store } = await createService()
  const created = await service.set(setInput())
  assert.match(service.renderBlock(), /chat: - Answer briefly and directly\./)

  const disabled = await service.disable({ channel: 'chat', key: 'tone.concise', author: { sessionId: 'session-1' } })
  assert.equal(disabled.style.enabled, false)
  assert.ok(disabled.seq > created.seq)
  assert.equal(disabled.style.rule, created.style.rule, 'disable keeps the rule content')
  assert.equal(store.records.length, 2, 'one append-only record per change')
  assert.equal(service.list().count, 1, 'the folded card stays visible with enabled:false')
  assert.equal(service.list().counts.disabled, 1)
  assert.equal(service.renderBlock(), '', 'disabled rules are never injected')

  // Idempotent no-op.
  const again = await service.disable({ channel: 'chat', key: 'tone.concise' })
  assert.equal(again.seq, disabled.seq)
  assert.equal(store.records.length, 2)

  // Re-set re-enables with a new record.
  const reEnabled = await service.set(setInput({ rule: 'Be brief.' }))
  assert.equal(reEnabled.style.enabled, true)
  assert.equal(reEnabled.style.rule, 'Be brief.')
  assert.equal(service.list().counts.active, 1)

  await assert.rejects(
    () => service.disable({ channel: 'chat', key: 'missing' }),
    (error) => error.code === 'NOT_FOUND',
  )
  await assert.rejects(() => service.disable({ channel: 'nope', key: 'x' }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(() => service.disable({ channel: 'chat', key: 'Bad Key' }), (error) => error.code === 'BAD_ARGUMENT')
});

// ---------------------------------------------------------------------------
// STY-04 — renderBlock shape/order
// ---------------------------------------------------------------------------

test('STY-04 renderBlock: §3.3 shape, chat then engineering, priority desc then key asc', async () => {
  const { service } = await createService()
  const longRule = 'r'.repeat(600)
  await service.set(setInput({ key: 'tone.z', title: 'Z', rule: 'Z rule', priority: 80 }))
  await service.set(setInput({ key: 'tone.a', title: 'A', rule: 'A rule', priority: 80 }))
  await service.set(setInput({ key: 'tone.low', title: 'Low', rule: 'low rule', priority: 10 }))
  await service.set(setInput({ channel: 'engineering', area: 'commit', key: 'commit.zh', title: 'Commit', rule: 'Write conventional commit subjects.', priority: 60 }))
  await service.set(setInput({ channel: 'engineering', area: 'docs', key: 'docs.en', title: 'Docs', rule: 'Document decisions.', priority: 90 }))
  await service.set(setInput({ channel: 'chat', area: 'general', key: 'general.long', title: 'Long', rule: longRule, priority: 1 }))

  const text = service.renderBlock()
  assert.equal(text, service.renderBlock(), 'same fold => byte-identical block')
  const lines = text.split('\n')
  assert.equal(lines[0], '<confluence-style chat="4" engineering="2">')
  assert.equal(lines[1], 'Output style (apply to answers and engineering artifacts):')
  assert.deepEqual(
    lines.slice(2, -1).map((line) => line.split(': - ')[0] + ':' + line.split(': - ')[1].slice(0, 6)),
    ['chat:A rule', 'chat:Z rule', 'chat:low ru', 'chat:rrrrrr', 'engineering:Docume', 'engineering:Write '],
    'chat rules first (priority desc/key asc), then engineering (priority desc/key asc)',
  )
  assert.equal(lines.at(-1), '</confluence-style>')
  assert.ok(lines[5].startsWith('chat: - '), 'every rule stays one bounded line')
  assert.ok(lines[5].length <= 'chat: - '.length + 241, 'long rules are clipped to one bounded line')

  // Empty style renders nothing at all.
  const { service: blank } = await createService()
  assert.equal(blank.renderBlock(), '')

  // config.style.enabled / inject off.
  const off = await createService({ config: makeConfig({ enabled: false }) })
  assert.equal(off.service.renderBlock(), '')
  const noInject = await createService({ config: makeConfig({ inject: false }) })
  assert.equal(noInject.service.renderBlock(), '')
});

// ---------------------------------------------------------------------------
// STY-05 — per-channel budgets
// ---------------------------------------------------------------------------

test('STY-05 renderBlock budgets: chat/engineering capped independently, deterministic degradation', async () => {
  const records = []
  for (let index = 0; index < 6; index += 1) {
    records.push(
      styleRecord(seqFor(10 + index), {
        channel: 'chat',
        area: 'tone',
        key: `tone.p${index}`,
        rule: `chat rule ${index} ${'x'.repeat(40)}`,
        priority: 90 - index * 10,
      }),
    )
  }
  for (let index = 0; index < 3; index += 1) {
    records.push(
      styleRecord(seqFor(30 + index), {
        channel: 'engineering',
        area: 'commit',
        key: `commit.p${index}`,
        rule: `engineering rule ${index} ${'y'.repeat(40)}`,
        priority: 90 - index * 10,
      }),
    )
  }
  const { service } = await createService({ records, config: makeConfig({ maxInjectCharsChat: 200 }) })
  const text = service.renderBlock()
  const header = text.split('\n')[0]
  assert.match(header, /^<confluence-style chat="\d+" engineering="3">$/, 'chat rules are degraded, engineering rules all fit')
  const chatLines = text.split('\n').filter((line) => line.startsWith('chat: - '))
  const engineeringLines = text.split('\n').filter((line) => line.startsWith('engineering: - '))
  assert.ok(chatLines.length >= 1 && chatLines.length < 6, `only ${chatLines.length} chat rules fit 200 chars`)
  assert.equal(engineeringLines.length, 3)
  const chatBlock = chatLines.join('\n')
  assert.ok(Array.from(chatBlock).length <= 200, 'the chat channel stays inside style.maxInjectCharsChat')
  assert.match(chatLines[0], /chat rule 0 /, 'the highest-priority rule survives')
  assert.match(chatLines[chatLines.length - 1], /chat rule (?!0)[0-9]/, 'degradation drops the lowest priorities last')

  // The engineering budget is independent: a large chat budget does not leak into it.
  const { service: reverse } = await createService({
    records,
    config: makeConfig({ maxInjectCharsChat: 2000, maxInjectCharsEngineering: 100 }),
  })
  const reverseText = reverse.renderBlock()
  const reverseEngineering = reverseText.split('\n').filter((line) => line.startsWith('engineering: - '))
  assert.ok(reverseEngineering.length < 3, 'engineering degrades under its own budget')
  assert.equal(reverseText.split('\n').filter((line) => line.startsWith('chat: - ')).length, 6)
  assert.ok(Array.from(reverseEngineering.join('\n')).length <= 100)

  // Both budgets tight enough for one rule each: each channel stays inside its own budget.
  const { service: tiny } = await createService({
    records,
    config: makeConfig({ maxInjectCharsChat: 100, maxInjectCharsEngineering: 100 }),
  })
  const tinyText = tiny.renderBlock()
  const tinyChatBlock = tinyText.split('\n').filter((line) => line.startsWith('chat: - ')).join('\n')
  const tinyEngineeringBlock = tinyText.split('\n').filter((line) => line.startsWith('engineering: - ')).join('\n')
  assert.equal(tinyChatBlock.split('\n').length, 1)
  assert.equal(tinyEngineeringBlock.split('\n').length, 1)
  assert.ok(Array.from(tinyChatBlock).length <= 100)
  assert.ok(Array.from(tinyEngineeringBlock).length <= 100)
});

// ---------------------------------------------------------------------------
// STY-06 — caps
// ---------------------------------------------------------------------------

test('STY-06 caps: maxRules live cap, rule/examples bytes, title/tags/priority bounds', async () => {
  const { service } = await createService({ config: makeConfig({ maxRules: 1 }) })
  const first = await service.set(setInput({ key: 'tone.one' }))
  await assert.rejects(
    () => service.set(setInput({ key: 'tone.two' })),
    (error) => error.code === 'LIMIT_EXCEEDED',
  )
  // Updating an existing live rule is free.
  await service.set(setInput({ key: 'tone.one', rule: 'Updated rule.' }))
  // Disabling a rule frees a live slot.
  await service.disable({ channel: 'chat', key: first.key })
  await service.set(setInput({ key: 'tone.two' }))

  const { service: loose, store: looseStore } = await createService()

  // Rule cap: 1024 bytes after redaction, never silently truncated.
  await assert.rejects(
    () => loose.set(setInput({ key: 'tone.huge', rule: 'x'.repeat(STYLE_MAX_RULE_BYTES + 1) })),
    (error) => error.code === 'BODY_TOO_LARGE',
  )

  // Title is bounded to 120 chars.
  const longTitle = await loose.set(setInput({ key: 'tone.long-title', title: 't'.repeat(300) }))
  assert.equal(Array.from(longTitle.style.title).length, STYLE_MAX_TITLE_CHARS)

  // Examples: ≤3 entries, each side ≤512 bytes, invalid sides dropped.
  const examples = await loose.set(
    setInput({
      key: 'tone.examples',
      examples: [
        { bad: 'Sure thing!', good: 'Done.' },
        { bad: 'bad only' },
        { good: 'good only' },
        { bad: 'dropped', good: 'dropped' },
        { bad: 7 },
      ],
    }),
  )
  assert.equal(examples.style.examples.length, STYLE_MAX_EXAMPLES)
  assert.deepEqual(examples.style.examples[0], { bad: 'Sure thing!', good: 'Done.' })
  await assert.rejects(
    () => loose.set(setInput({ key: 'tone.big-example', examples: [{ bad: 'x'.repeat(STYLE_MAX_EXAMPLE_BYTES + 1) }] })),
    (error) => error.code === 'BODY_TOO_LARGE',
  )

  // Tags normalised and capped at 8; priorities are integers 0..100.
  await loose.set(
    setInput({ key: 'tone.tags', tags: ['A', 'b', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'Bad Tag', 7] }),
  )
  assert.deepEqual(looseStore.records.at(-1).tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  const priority = await loose.set(setInput({ key: 'tone.priority', priority: 100 }))
  assert.equal(priority.style.priority, 100)
});

// ---------------------------------------------------------------------------
// STY-07 — redaction
// ---------------------------------------------------------------------------

test('STY-07 redaction: secrets in rule/examples are redacted at write time', async () => {
  const { service, store } = await createService()
  await service.set(
    setInput({
      key: 'tone.secret',
      rule: `Use ${leakedKey} for the API.`,
      examples: [{ bad: `token=${leakedKey}`, good: 'no token' }],
    }),
  )
  const record = store.records.at(-1)
  assert.equal(JSON.stringify(record).includes(leakedKey), false, 'raw secrets are never stored')
  assert.match(record.rule, /\[redacted\]/)
  assert.match(record.examples[0].bad, /\[redacted\]/)
  const rendered = service.renderBlock()
  assert.equal(rendered.includes(leakedKey), false)
});

// ---------------------------------------------------------------------------
// STY-08 — importStyle
// ---------------------------------------------------------------------------

test('STY-08 importStyle: source=import, enabled flag honoured, overwrite, caps', async () => {
  const { service, store } = await createService()
  const imported = await service.importStyle({
    channel: 'engineering',
    area: 'commit',
    key: 'commit.imported',
    title: 'Imported commit rule',
    rule: 'Use conventional commit subjects.',
    priority: 70,
    confidence: 0.9,
  })
  assert.equal(imported.style.enabled, true)
  assert.equal(imported.style.source, 'import')
  assert.equal(imported.style.priority, 70)
  assert.equal(store.records.at(-1).source, 'import')
  assert.equal(service.list().counts.active, 1)

  // An import may disable a rule directly (enabled:false is imported as data).
  const disabled = await service.importStyle({
    channel: 'chat',
    area: 'tone',
    key: 'tone.imported',
    title: 'Imported tone rule',
    rule: 'Be formal.',
    enabled: false,
  })
  assert.equal(disabled.style.enabled, false)
  assert.equal(service.renderBlock().includes('Be formal.'), false)

  // Re-importing the same (channel,key) overwrites it and keeps one folded card.
  const updated = await service.importStyle({
    channel: 'engineering',
    area: 'commit',
    key: 'commit.imported',
    title: 'Imported commit rule v2',
    rule: 'Use imperative subjects.',
    priority: 80,
  })
  assert.ok(updated.seq > imported.seq)
  assert.equal(service.list().count, 2)
  assert.equal(service.list({ channel: 'engineering' }).styles[0].title, 'Imported commit rule v2')

  // Cap: a new live key fails at maxRules; overwriting an existing live key is free.
  const capped = await createService({ config: makeConfig({ maxRules: 1 }) })
  await capped.service.importStyle(setInput({ key: 'tone.first', rule: 'first' }))
  await assert.rejects(
    () => capped.service.importStyle(setInput({ key: 'tone.second', rule: 'second' })),
    (error) => error.code === 'LIMIT_EXCEEDED',
  )
  await capped.service.importStyle(setInput({ key: 'tone.first', rule: 'first v2' }))
  assert.equal(capped.service.list().count, 1)
});

// ---------------------------------------------------------------------------
// STY-09 — real store append-only + cross-mount
// ---------------------------------------------------------------------------

test('STY-09 real store: append-only style records, a second mount folds the same cards', async () => {
  const root = await tempRoot()
  const config = {
    ...resolveConfig({}).config,
    store: { ...resolveConfig({}).config.store, dir: root, pollMs: 60_000, watch: false },
    style: { ...STYLE_DEFAULTS },
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

  const writer = makeStore(4301)
  stores.push(writer)
  const writerService = new StyleService({ store: writer, config, redactor: makeRedactor(config), logger: silentLogger, deps: { now: () => NOW } })
  await writerService.attach()
  await writerService.set(setInput({ key: 'tone.one', rule: 'One rule.' }))
  await writerService.set(setInput({ key: 'tone.two', rule: 'Two rule.' }))
  await writerService.disable({ channel: 'chat', key: 'tone.one' })
  await writerService.set(setInput({ channel: 'engineering', area: 'docs', key: 'docs.one', title: 'Docs one', rule: 'Doc it.' }))
  await writer.close()

  const shipped = (await readShardStyles(root)).filter((record) => record.type === 'style')
  assert.equal(shipped.length, 4, 'append-only: every write is a new record, nothing is rewritten')
  assert.deepEqual(shipped.map((record) => record.enabled), [true, true, false, true])
  for (const record of shipped) {
    assert.equal(record.ws, GLOBAL_SCOPE_KEY)
    assert.ok(isUlid(record.seq))
    assert.match(record.id, /^sty_[0-9A-Z]{26}$/)
  }

  const reader = makeStore(4302)
  stores.push(reader)
  const readerService = new StyleService({ store: reader, config, redactor: makeRedactor(config), logger: silentLogger, deps: { now: () => NOW } })
  await readerService.attach({ create: false })
  assert.equal(readerService.list().count, 3)
  assert.equal(readerService.list().counts.active, 2)
  assert.equal(readerService.list().counts.disabled, 1)
  const text = readerService.renderBlock()
  assert.match(text, /^<confluence-style chat="1" engineering="1">/)
  assert.equal(text, writerService.renderBlock(), 'the same fold renders byte-identical blocks across mounts')
  assert.equal((await readShardStyles(root)).filter((record) => record.type === 'style').length, 4, 'a read-only attach never appends')
  await reader.close()
});

// ---------------------------------------------------------------------------
// STY-10 — no global journal / safety
// ---------------------------------------------------------------------------

test('STY-10 attach without a global journal: safe reads, writes STORE_UNAVAILABLE, render never throws', async () => {
  const bareStore = {
    async init() {},
    viewedRecords() {
      return []
    },
    async close() {},
  }
  const service = new StyleService({
    store: bareStore,
    config: makeConfig(),
    redactor: makeRedactor(),
    logger: silentLogger,
    deps: { now: () => NOW },
  })
  await assert.doesNotReject(() => service.attach())
  assert.equal(service.list().count, 0)
  assert.equal(service.renderBlock(), '')
  assert.equal(service.revision, null)
  await assert.rejects(() => service.set(setInput()), (error) => error.code === 'STORE_UNAVAILABLE')
  await assert.rejects(() => service.disable({ channel: 'chat', key: 'x' }), (error) => error.code === 'STORE_UNAVAILABLE')

  // renderBlock is exception-safe even with a corrupted fold.
  service._fold = {
    byChannelKey: new Map([['chat\u0000x', { channel: 'chat', key: 'x' }]]),
    active: [{ channel: 'chat', key: 'x', rule: null, priority: 'high' }],
    disabled: [],
    counts: { total: 1, active: 1, disabled: 0, byChannel: { chat: 1, engineering: 0 } },
  }
  assert.doesNotThrow(() => service.renderBlock())
  assert.equal(typeof service.renderBlock(), 'string')
});
