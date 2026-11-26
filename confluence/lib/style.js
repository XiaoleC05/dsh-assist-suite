// Confluence / 高级记忆 — v0.4 output style cards (`style` records).
//
// One durable, portable style layer per DSH profile, split into two channels:
//   - `chat`        — conversational answers (tone / structure / general);
//   - `engineering` — the copy a coding task produces (commit messages,
//     comments/docstrings, README/docs, naming, error messages, logs, UI microcopy).
//
// Style cards are global-scope `style` records (v0.4-interfaces §1.2) and are
// explicit configuration-like rules: `set()` writes them `enabled:true`
// directly (the user explicitly stated the style, ADR-0009 §2), `disable()` /
// the tool's `remove` writes `enabled:false`. Every write is redacted and
// capped; the fold is LWW per `(channel,key)`.
//
// `renderBlock()` is synchronous, deterministic, byte-stable, exception-safe and
// bounded per channel by `config.style.maxInjectCharsChat` /
// `maxInjectCharsEngineering` (§3.3). It reads only the in-memory fold; no IO,
// never throws.
//
// Pure ESM, Node builtins only, no network, no subprocess, no model call, no
// dependency.
//
// Contract: docs/plan/v0.4-interfaces.md §1.2/§2.3/§3.3 and ADR-0009.

import { GLOBAL_SCOPE_KEY } from './store.js'
import {
  ConfluenceError,
  createUlidFactory,
  escapePulseText,
  isUlid,
  truncateChars,
  truncateUtf8,
} from './util.js'

/** The two style channels, in render order (§1.2/§3.3). */
export const STYLE_CHANNELS = Object.freeze(['chat', 'engineering'])

/** Style areas (§1.2); each area belongs to exactly one channel. */
export const STYLE_AREAS = Object.freeze([
  'general',
  'tone',
  'structure',
  'commit',
  'comment',
  'docs',
  'naming',
  'error',
  'log',
  'ui',
])

/** Area → channel mapping (§1.2): `chat` covers tone/structure/general. */
export const STYLE_AREA_CHANNELS = Object.freeze({
  general: 'chat',
  tone: 'chat',
  structure: 'chat',
  commit: 'engineering',
  comment: 'engineering',
  docs: 'engineering',
  naming: 'engineering',
  error: 'engineering',
  log: 'engineering',
  ui: 'engineering',
})

/** Stable style key grammar (§1.2, same as pattern keys): `^[a-z0-9][a-z0-9._-]{0,63}$`. */
export const STYLE_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$'
export const STYLE_KEY_RE = new RegExp(STYLE_KEY_PATTERN)

/** Style record id prefix. */
export const STYLE_ID_PREFIX = 'sty_'

/** Style record vocabulary/defaults (§1.2). */
export const STYLE_SOURCES = Object.freeze(['user', 'agent', 'import'])
export const STYLE_DEFAULT_PRIORITY = 50
export const STYLE_MAX_PRIORITY = 100
export const STYLE_DEFAULT_CONFIDENCE = 0.8

/** Write caps (§1.2). */
export const STYLE_MAX_TITLE_CHARS = 120
export const STYLE_MAX_RULE_BYTES = 1024
export const STYLE_MAX_EXAMPLES = 3
export const STYLE_MAX_EXAMPLE_BYTES = 512
export const STYLE_MAX_TAGS = 8

/** Config defaults for `config.style` (§7); mirrored locally so this module stays pure. */
export const STYLE_DEFAULTS = Object.freeze({
  enabled: true,
  inject: true,
  maxRules: 100,
  maxInjectCharsChat: 600,
  maxInjectCharsEngineering: 900,
})

/** Accepted ranges for resolved/bounded config values (`config.style` §7). */
const STYLE_CONFIG_RANGES = {
  maxRules: [1, 2000],
  maxInjectCharsChat: [100, 4000],
  maxInjectCharsEngineering: [100, 4000],
}

/** Prompt block framing (§3.3). */
const STYLE_BLOCK_OPEN = '<confluence-style'
const STYLE_BLOCK_CLOSE = '</confluence-style>'
const STYLE_BLOCK_INTRO = 'Output style (apply to answers and engineering artifacts):'
const STYLE_RENDER_RULE_CHARS = 240

const AUTHOR_SESSION_CHARS = 128
const AUTHOR_TITLE_CHARS = 160

/** Control/bidi characters that must never reach a rendered prompt line. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g
const WHITESPACE_RUN = /\s+/g

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string} */
function asString(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/** @param {string} text @returns {number} Unicode code points */
function countCodePoints(text) {
  return Array.from(text).length
}

/** @param {unknown} logger @returns {{debug: Function, info: Function, warn: Function, error: Function}} */
function normalizeLogger(logger) {
  const out = {}
  for (const level of ['debug', 'info', 'warn', 'error']) {
    const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null
    out[level] = (record) => {
      if (!fn) return
      try {
        fn(record)
      } catch {
        // diagnostics must never break the style service
      }
    }
  }
  return out
}

/** @param {unknown} value @returns {number} clamped [0,1] confidence */
function confidenceValue(value, fallback = STYLE_DEFAULT_CONFIDENCE) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(1, Math.max(0, numeric))
}

/** @param {unknown} value @returns {number} integer priority clamped to 0..100 */
function priorityValue(value, fallback = STYLE_DEFAULT_PRIORITY) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(STYLE_MAX_PRIORITY, Math.trunc(numeric)))
}

/**
 * Strip absolute and home paths from a rendered line (defence in depth: writes
 * are already redacted, but a prompt block must never echo machine paths).
 *
 * @param {string} text
 * @returns {string}
 */
function stripAbsolutePathsText(text) {
  let out = asString(text)
  out = out.replace(/\b[A-Za-z]:[\\/][^\s"'`<>|)]*/g, '<path>')
  out = out.replace(/(^|[\s"'(])\\\\[^\s"'`<>|)]+/g, '$1<path>')
  out = out.replace(/(^|[\s"'(])\/(?!\/)[^\s"'`<>|)]+/g, '$1<path>')
  out = out.replace(/(^|[\s"'(])~\/[^\s"'`<>|)]*/g, '$1<path>')
  return out
}

/**
 * Normalise one stored/rendered value to a single bounded line.
 *
 * @param {unknown} value
 * @returns {string}
 */
function singleLineText(value) {
  return asString(value)
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
}

/**
 * Normalise one stored author block (display metadata only, bounded).
 *
 * @param {unknown} author
 * @returns {{sessionId?: string, title?: string} | null}
 */
function sanitizeAuthor(author) {
  if (!isPlainObject(author)) return null
  /** @type {{sessionId?: string, title?: string}} */
  const out = {}
  const sessionId = asString(author.sessionId).trim()
  if (sessionId !== '') out.sessionId = truncateChars(sessionId, AUTHOR_SESSION_CHARS)
  const title = asString(author.title).trim()
  if (title !== '') out.title = truncateChars(title, AUTHOR_TITLE_CHARS)
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Normalise stored tags to the closed grammar (≤8, lowercase labels).
 *
 * @param {unknown} tags
 * @returns {string[]}
 */
function storedTags(tags) {
  if (!Array.isArray(tags)) return []
  const out = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const label = raw.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(label)) continue
    if (out.includes(label)) continue
    out.push(label)
    if (out.length >= STYLE_MAX_TAGS) break
  }
  return out
}

/**
 * Normalise stored good/bad examples (≤3, each side ≤512 bytes).
 *
 * @param {unknown} examples
 * @returns {Array<{bad?: string, good?: string}>}
 */
function storedExamples(examples) {
  if (!Array.isArray(examples)) return []
  const out = []
  for (const item of examples) {
    if (!isPlainObject(item)) continue
    /** @type {{bad?: string, good?: string}} */
    const entry = {}
    const bad = truncateUtf8(asString(item.bad), STYLE_MAX_EXAMPLE_BYTES).trim()
    if (bad !== '') entry.bad = bad
    const good = truncateUtf8(asString(item.good), STYLE_MAX_EXAMPLE_BYTES).trim()
    if (good !== '') entry.good = good
    if (Object.keys(entry).length === 0) continue
    out.push(entry)
    if (out.length >= STYLE_MAX_EXAMPLES) break
  }
  return out
}

/**
 * Turn one stored `style` record into a fold candidate. Invalid records are
 * ignored (append-only journals can contain forged/future lines; folds stay
 * total, bounded and deterministic). The read path is lenient about the
 * area↔channel mapping (only writes enforce it).
 *
 * @param {unknown} record
 * @returns {Record<string, any> | null}
 */
function styleFromRecord(record) {
  if (!isPlainObject(record) || record.type !== 'style') return null
  if (typeof record.id !== 'string' || record.id === '') return null
  if (!isUlid(record.seq)) return null
  const channel = STYLE_CHANNELS.includes(record.channel) ? record.channel : null
  if (channel === null) return null
  const area = STYLE_AREAS.includes(record.area) ? record.area : null
  if (area === null) return null
  const key = typeof record.key === 'string' ? record.key : ''
  if (!STYLE_KEY_RE.test(key)) return null
  const rule = truncateUtf8(asString(record.rule), STYLE_MAX_RULE_BYTES).trim()
  if (rule === '') return null
  let title = truncateChars(singleLineText(record.title), STYLE_MAX_TITLE_CHARS)
  if (title === '') title = key
  const source = STYLE_SOURCES.includes(record.source) ? record.source : 'user'
  return {
    id: asString(record.id),
    seq: /** @type {string} */ (record.seq),
    ts: asString(record.ts),
    channel,
    area,
    key,
    title,
    rule,
    examples: storedExamples(record.examples),
    tags: storedTags(record.tags),
    priority: priorityValue(record.priority),
    enabled: record.enabled !== false,
    confidence: confidenceValue(record.confidence),
    source,
    author: sanitizeAuthor(record.author),
  }
}

/** @param {Record<string, any>} a @param {Record<string, any>} b @returns {number} */
function compareStrings(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Render order within one channel: priority desc, then key asc (§3.3). */
function comparePriorityKey(a, b) {
  const byPriority = Number(b.priority) - Number(a.priority)
  if (byPriority !== 0) return byPriority
  return compareStrings(asString(a.key), asString(b.key))
}

/** List order: channel order, priority desc, key asc. */
function compareStyleListOrder(a, b) {
  const channelA = STYLE_CHANNELS.indexOf(a.channel)
  const channelB = STYLE_CHANNELS.indexOf(b.channel)
  if (channelA !== channelB) return channelA - channelB
  return comparePriorityKey(a, b)
}

/**
 * Fold `style` records into the live style cards (§1.2). Pure and total:
 *   - per `(channel,key)` the record with the greatest `seq` wins;
 *   - `active` = winners with `enabled !== false`, in render order;
 *   - `disabled` = winners with `enabled:false`;
 *   - `counts` summarises the winners (plus active counts per channel).
 *
 * @param {readonly unknown[]} records journal records (any order/type)
 * @returns {{byChannelKey: Map<string, Record<string, any>>, active: Array<Record<string, any>>, disabled: Array<Record<string, any>>, counts: {total: number, active: number, disabled: number, byChannel: {chat: number, engineering: number}}}}
 */
export function foldStyles(records) {
  const list = Array.isArray(records) ? records : []
  /** @type {Map<string, Record<string, any>>} */
  const byChannelKey = new Map()
  for (const record of list) {
    const style = styleFromRecord(record)
    if (style === null) continue
    const mapKey = `${style.channel}\u0000${style.key}`
    const existing = byChannelKey.get(mapKey)
    if (existing === undefined || compareStrings(asString(style.seq), asString(existing.seq)) > 0) {
      byChannelKey.set(mapKey, style)
    }
  }
  const winners = [...byChannelKey.values()]
  const active = winners.filter((style) => style.enabled).sort(compareStyleListOrder)
  const disabled = winners.filter((style) => !style.enabled).sort(compareStyleListOrder)
  const byChannel = { chat: 0, engineering: 0 }
  for (const style of active) byChannel[style.channel] += 1
  return {
    byChannelKey,
    active,
    disabled,
    counts: { total: winners.length, active: active.length, disabled: disabled.length, byChannel },
  }
}

/**
 * Greatest `style` seq of the journal (the style revision), or null. Never throws.
 *
 * @param {readonly unknown[]} records
 * @returns {string | null}
 */
export function styleRevision(records) {
  let revision = null
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record) || record.type !== 'style') continue
    if (!isUlid(record.seq)) continue
    if (revision === null || /** @type {string} */ (record.seq) > revision) revision = /** @type {string} */ (record.seq)
  }
  return revision
}

/**
 * Resolve the `config.style` section against the v0.4 defaults. Tolerates both
 * the bare resolved config and a `resolveConfig()` wrapper, and never throws.
 *
 * @param {unknown} config
 * @returns {{enabled: boolean, inject: boolean, maxRules: number, maxInjectCharsChat: number, maxInjectCharsEngineering: number}}
 */
function readStyleConfig(config) {
  const raw = isPlainObject(config) ? config : {}
  const resolved = isPlainObject(raw.config) ? raw.config : raw
  const section = isPlainObject(resolved.style) ? resolved.style : {}
  /** @param {unknown} value @param {boolean} fallback */
  const readBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  /** @param {unknown} value @param {number} fallback @param {string} field */
  const readNumber = (value, fallback, field) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    const [min, max] = STYLE_CONFIG_RANGES[field]
    return Math.min(max, Math.max(min, value))
  }
  return {
    enabled: readBool(section.enabled, STYLE_DEFAULTS.enabled),
    inject: readBool(section.inject, STYLE_DEFAULTS.inject),
    maxRules: Math.trunc(readNumber(section.maxRules, STYLE_DEFAULTS.maxRules, 'maxRules')),
    maxInjectCharsChat: Math.trunc(
      readNumber(section.maxInjectCharsChat, STYLE_DEFAULTS.maxInjectCharsChat, 'maxInjectCharsChat'),
    ),
    maxInjectCharsEngineering: Math.trunc(
      readNumber(section.maxInjectCharsEngineering, STYLE_DEFAULTS.maxInjectCharsEngineering, 'maxInjectCharsEngineering'),
    ),
  }
}

/** @param {Record<string, any>} style @returns {Record<string, unknown>} §4.3 public shape */
function publicStyle(style) {
  return {
    channel: style.channel,
    area: style.area,
    key: style.key,
    title: style.title,
    rule: style.rule,
    examples: style.examples.map((entry) => ({ ...entry })),
    tags: [...style.tags],
    priority: style.priority,
    enabled: style.enabled,
    confidence: style.confidence,
    source: style.source,
    ts: style.ts,
  }
}

/**
 * Copy the content fields of a folded style (used by `disable`).
 *
 * @param {Record<string, any>} style
 * @returns {Record<string, any>}
 */
function contentFieldsOf(style) {
  return {
    channel: style.channel,
    area: style.area,
    key: style.key,
    title: style.title,
    rule: style.rule,
    examples: style.examples.map((entry) => ({ ...entry })),
    tags: [...style.tags],
    priority: style.priority,
    enabled: style.enabled,
    confidence: style.confidence,
    source: style.source,
    author: style.author === null ? null : { ...style.author },
  }
}

/** @param {Record<string, any>} style @returns {string} one bounded rendered rule line (§3.3) */
function renderStyleRule(style) {
  const escaped = escapePulseText(stripAbsolutePathsText(singleLineText(style.rule)))
  const clipped =
    countCodePoints(escaped) > STYLE_RENDER_RULE_CHARS
      ? `${truncateChars(escaped, STYLE_RENDER_RULE_CHARS - 1)}…`
      : escaped
  return clipped === '' ? singleLineText(style.title) : clipped
}

/**
 * StyleService — one per plugin mount, attached to the global journal. Reads are
 * synchronous snapshots of the in-memory fold; writes append `style` records and
 * refresh the fold before resolving.
 */
export class StyleService {
  /**
   * @param {{store?: object, config?: object, redactor?: object, logger?: object, deps?: object}} [options]
   * deps: { now, random, idFactory } (tests/CLIs; production uses the defaults).
   */
  constructor({ store, config, redactor, logger, deps } = {}) {
    if (!store || typeof store !== 'object') {
      throw new ConfluenceError('BAD_ARGUMENT', 'StyleService requires a JournalStore-like store')
    }
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this._cfg = readStyleConfig(config)
    this.redactor = redactor && typeof redactor === 'object' ? redactor : null
    this.logger = normalizeLogger(logger)
    const dependencies = isPlainObject(deps) ? deps : {}
    this._now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now()
    const random = typeof dependencies.random === 'function' ? dependencies.random : Math.random
    this._ulid =
      typeof dependencies.idFactory === 'function' ? dependencies.idFactory : createUlidFactory(this._now, random)
    /** @type {object | null} */
    this._journal = null
    this._ready = false
    /** @type {(() => void) | null} */
    this._unsubscribe = null
    this._fold = foldStyles([])
    /** @type {string | null} */
    this._revision = null
  }

  /** Latest folded style revision (greatest style seq), or null. */
  get revision() {
    return this._revision
  }

  /**
   * Open (or reuse) the global journal and prime the in-memory fold. Idempotent.
   * `create:false` opens an existing journal read-only (tooling/CLI) and never
   * creates store files.
   *
   * @param {{create?: boolean}} [options]
   * @returns {Promise<this>}
   */
  async attach(options = {}) {
    const input = isPlainObject(options) ? options : {}
    this._journal = await this._resolveJournal(input.create !== false)
    this._subscribe()
    this._refreshView()
    this._ready = true
    return this
  }

  /** Stop listening for external journal changes (idempotent). */
  detach() {
    if (typeof this._unsubscribe === 'function') {
      try {
        this._unsubscribe()
      } catch {
        // a stale unsubscribe is harmless
      }
    }
    this._unsubscribe = null
    this._journal = null
    this._ready = false
  }

  /**
   * Synchronous style read (§2.3). `channel` filters to one known channel.
   *
   * @param {{channel?: string}} [options]
   * @returns {{revision: string | null, styles: Array<Record<string, unknown>>, count: number,
   *   counts: {total: number, active: number, disabled: number, byChannel: {chat: number, engineering: number}}}}
   */
  list(options = {}) {
    const input = isPlainObject(options) ? options : {}
    const channel = input.channel
    if (channel !== undefined && channel !== null && !STYLE_CHANNELS.includes(channel)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid style channel: ${String(input.channel)}`)
    }
    let styles = [...this._fold.byChannelKey.values()].sort(compareStyleListOrder)
    if (channel !== undefined && channel !== null) styles = styles.filter((style) => style.channel === channel)
    return {
      revision: this._revision,
      styles: styles.map(publicStyle),
      count: styles.length,
      counts: { ...this._fold.counts, byChannel: { ...this._fold.counts.byChannel } },
    }
  }

  /**
   * Write one style card as `enabled:true` (§2.3: an explicit user statement).
   * `channel` and `area` must agree (§1.2 mapping).
   *
   * @param {{channel: string, area: string, key: string, title: string, rule: string, examples?: object[],
   *   tags?: string[], priority?: number, enabled?: boolean, confidence?: number, source?: string, author?: object}} input
   * @returns {Promise<{channel: string, key: string, seq: string, style: Record<string, unknown>}>}
   */
  async set(input = {}) {
    const prepared = this._prepareStyleInput(input, { source: 'user' })
    await this._ensureJournal()
    const mapKey = `${prepared.channel}\u0000${prepared.key}`
    this._assertStyleCapacity(this._fold.byChannelKey.get(mapKey), prepared.enabled)
    const stored = await this._append(this._styleRecord(prepared))
    return this._writeResult(stored)
  }

  /**
   * Disable one style card by appending a `enabled:false` record (the record
   * stays on disk; it is never injected again).
   *
   * @param {{channel?: string, key?: string, author?: object}} [input]
   * @returns {Promise<{channel: string, key: string, seq: string, style: Record<string, unknown>}>}
   */
  async disable(input = {}) {
    const options = isPlainObject(input) ? input : {}
    const channel = this._requireChannel(options.channel)
    const key = this._requireKey(options.key)
    await this._ensureJournal()
    const existing = this._fold.byChannelKey.get(`${channel}\u0000${key}`)
    if (existing === undefined) throw new ConfluenceError('NOT_FOUND', `style not found: ${channel}/${key}`)
    if (!existing.enabled) {
      return { channel, key, seq: existing.seq, style: publicStyle(existing) }
    }
    const author = sanitizeAuthor(options.author)
    const fields = contentFieldsOf(existing)
    const stored = await this._append(
      this._styleRecord({ ...fields, enabled: false, author: author ?? existing.author }),
    )
    return this._writeResult(stored)
  }

  /**
   * Portability write path (used by `confluence_memory import`): write one style
   * card with `source:'import'` and the requested `enabled` flag. Unlike `set`, an
   * existing `(channel,key)` is updated (imports win in a merge, ADR-0009 §4).
   *
   * @param {object} entry same fields as `set`
   * @returns {Promise<{channel: string, key: string, seq: string, style: Record<string, unknown>}>}
   */
  async importStyle(entry = {}) {
    const prepared = this._prepareStyleInput(entry, { source: 'import' })
    await this._ensureJournal()
    const mapKey = `${prepared.channel}\u0000${prepared.key}`
    this._assertStyleCapacity(this._fold.byChannelKey.get(mapKey), prepared.enabled)
    const stored = await this._append(this._styleRecord(prepared))
    return this._writeResult(stored)
  }

  /**
   * Synchronous, deterministic, bounded style prompt block (§3.3), or '' when
   * disabled/empty. Reads only the in-memory fold; never throws.
   *
   * @returns {string}
   */
  renderBlock() {
    try {
      const config = this._cfg
      if (!config.enabled || !config.inject) return ''
      const chat = this._selectForBudget(
        this._fold.active.filter((style) => style.channel === 'chat'),
        config.maxInjectCharsChat,
      )
      const engineering = this._selectForBudget(
        this._fold.active.filter((style) => style.channel === 'engineering'),
        config.maxInjectCharsEngineering,
      )
      if (chat.length === 0 && engineering.length === 0) return ''
      const lines = [
        `${STYLE_BLOCK_OPEN} chat="${chat.length}" engineering="${engineering.length}">`,
        STYLE_BLOCK_INTRO,
      ]
      for (const style of chat) lines.push(`chat: - ${renderStyleRule(style)}`)
      for (const style of engineering) lines.push(`engineering: - ${renderStyleRule(style)}`)
      lines.push(STYLE_BLOCK_CLOSE)
      return lines.join('\n')
    } catch (error) {
      this.logger.warn({ event: 'style.render_failed', message: error?.message ?? String(error) })
      return ''
    }
  }

  /**
   * Deterministic degradation: keep the highest priority/earliest keys until the
   * channel block fits its budget.
   *
   * @param {Array<Record<string, any>>} rules
   * @param {number} budget
   * @returns {Array<Record<string, any>>}
   */
  _selectForBudget(rules, budget) {
    let chosen = [...rules].sort(comparePriorityKey)
    while (chosen.length > 0) {
      const text = chosen.map((style) => `${style.channel}: - ${renderStyleRule(style)}`).join('\n')
      if (countCodePoints(text) <= budget) return chosen
      chosen = chosen.slice(0, chosen.length - 1)
    }
    return chosen
  }

  // -------------------------------------------------------------------------
  // writes — one append-only `style` record per change
  // -------------------------------------------------------------------------

  /**
   * @param {Record<string, any>} fields
   * @returns {Record<string, unknown>}
   */
  _styleRecord(fields) {
    /** @type {Record<string, unknown>} */
    const record = {
      type: 'style',
      id: `${STYLE_ID_PREFIX}${this._ulid()}`,
      channel: fields.channel,
      area: fields.area,
      key: fields.key,
      title: fields.title,
      rule: fields.rule,
      examples: fields.examples,
      tags: [...fields.tags],
      priority: fields.priority,
      enabled: fields.enabled,
      confidence: fields.confidence,
      source: fields.source,
    }
    if (fields.author !== null && fields.author !== undefined) record.author = fields.author
    return record
  }

  /** @param {Record<string, unknown>} stored @returns {{channel: string, key: string, seq: string, style: Record<string, unknown>}} */
  _writeResult(stored) {
    const style = styleFromRecord(stored)
    if (style === null) {
      throw new ConfluenceError('STORE_UNAVAILABLE', 'the written style could not be read back')
    }
    return { channel: style.channel, key: style.key, seq: style.seq, style: publicStyle(style) }
  }

  /**
   * Enforce `style.maxRules` live rules (enabled). Updating an already-enabled
   * rule, or keeping a rule disabled, is free.
   *
   * @param {Record<string, any> | undefined} existing current folded style for the key
   * @param {boolean} willBeEnabled enabled flag of the record being written
   */
  _assertStyleCapacity(existing, willBeEnabled) {
    const live = this._fold.counts.active
    const becomesLive = willBeEnabled && (existing === undefined || !existing.enabled)
    if (becomesLive && live >= this._cfg.maxRules) {
      throw new ConfluenceError('LIMIT_EXCEEDED', `style rule cap reached (config.style.maxRules=${this._cfg.maxRules})`)
    }
  }

  /**
   * Validate + redact one style input for `set`/`importStyle`.
   *
   * @param {unknown} input
   * @param {{source: string}} options
   * @returns {Record<string, any>}
   */
  _prepareStyleInput(input, { source }) {
    if (!isPlainObject(input)) {
      throw new ConfluenceError('BAD_ARGUMENT', 'style input must be an object')
    }
    const channel = this._requireChannel(input.channel)
    const area = this._requireArea(input.area, channel)
    const key = this._requireKey(input.key)
    const title = this._prepareTitle(input.title, 'style title')
    const rule = this._prepareRule(input.rule, 'style rule')
    const examples = this._prepareExamples(input.examples)
    const tags = this._prepareTags(input.tags)
    const priority =
      input.priority === undefined || input.priority === null
        ? STYLE_DEFAULT_PRIORITY
        : this._preparePriority(input.priority)
    let enabled = true
    if (input.enabled !== undefined && input.enabled !== null) {
      if (typeof input.enabled !== 'boolean') {
        throw new ConfluenceError('BAD_ARGUMENT', 'style enabled must be a boolean')
      }
      enabled = input.enabled
    }
    let confidence = STYLE_DEFAULT_CONFIDENCE
    if (input.confidence !== undefined && input.confidence !== null) {
      if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
        throw new ConfluenceError('BAD_ARGUMENT', 'style confidence must be a number in [0,1]')
      }
      confidence = input.confidence
    }
    const requestedSource = input.source === undefined ? source : input.source
    const effectiveSource = STYLE_SOURCES.includes(requestedSource) ? requestedSource : source
    return {
      channel,
      area,
      key,
      title,
      rule,
      examples,
      tags,
      priority,
      enabled,
      confidence,
      source: effectiveSource,
      author: sanitizeAuthor(input.author),
    }
  }

  /** @param {unknown} value @returns {string} */
  _requireChannel(value) {
    if (typeof value !== 'string' || !STYLE_CHANNELS.includes(value)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid style channel: ${String(value)}`)
    }
    return value
  }

  /** @param {unknown} value @param {string} channel @returns {string} */
  _requireArea(value, channel) {
    if (typeof value !== 'string' || !STYLE_AREAS.includes(value)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid style area: ${String(value)}`)
    }
    if (STYLE_AREA_CHANNELS[value] !== channel) {
      throw new ConfluenceError(
        'BAD_ARGUMENT',
        `style area ${value} belongs to channel ${STYLE_AREA_CHANNELS[value]}, not ${channel}`,
      )
    }
    return value
  }

  /** @param {unknown} value @returns {string} */
  _requireKey(value) {
    if (typeof value !== 'string' || !STYLE_KEY_RE.test(value)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid style key: ${String(value)}`)
    }
    return value
  }

  /** @param {unknown} raw @param {string} label @returns {string} */
  _prepareTitle(raw, label) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ConfluenceError('BAD_ARGUMENT', `${label} must be a non-empty string`)
    }
    const redactor = this._requireRedactor(label)
    let result
    try {
      result = redactor.title(raw)
    } catch (error) {
      throw new ConfluenceError('REDACTED', `redaction failed for ${label}`, { cause: error })
    }
    const normalized = singleLineText(isPlainObject(result) ? asString(result.value) : asString(result))
    const clipped = truncateChars(stripAbsolutePathsText(normalized), STYLE_MAX_TITLE_CHARS).trim()
    if (clipped === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
    return clipped
  }

  /** @param {unknown} raw @param {string} label @returns {string} */
  _prepareRule(raw, label) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ConfluenceError('BAD_ARGUMENT', `${label} must be a non-empty string`)
    }
    const trimmed = this._redactText(raw, label).trim()
    if (trimmed === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
    if (Buffer.byteLength(trimmed, 'utf8') > STYLE_MAX_RULE_BYTES) {
      throw new ConfluenceError('BODY_TOO_LARGE', `${label} exceeds the ${STYLE_MAX_RULE_BYTES}-byte style rule cap`)
    }
    return trimmed
  }

  /** @param {unknown} examples @returns {Array<{bad?: string, good?: string}>} */
  _prepareExamples(examples) {
    if (examples === undefined || examples === null) return []
    if (!Array.isArray(examples)) throw new ConfluenceError('BAD_ARGUMENT', 'style examples must be an array')
    const out = []
    for (const item of examples) {
      if (!isPlainObject(item)) continue
      /** @type {{bad?: string, good?: string}} */
      const entry = {}
      for (const side of ['bad', 'good']) {
        const raw = item[side]
        if (typeof raw !== 'string' || raw.trim() === '') continue
        const redacted = this._redactText(raw, `style example ${side}`)
        if (Buffer.byteLength(redacted, 'utf8') > STYLE_MAX_EXAMPLE_BYTES) {
          throw new ConfluenceError(
            'BODY_TOO_LARGE',
            `style example ${side} exceeds the ${STYLE_MAX_EXAMPLE_BYTES}-byte cap`,
          )
        }
        entry[side] = redacted.trim()
      }
      if (Object.keys(entry).length === 0) continue
      out.push(entry)
      if (out.length >= STYLE_MAX_EXAMPLES) break
    }
    return out
  }

  /** @param {unknown} tags @returns {string[]} */
  _prepareTags(tags) {
    if (tags === undefined || tags === null) return []
    const redactor = this.redactor
    if (redactor && typeof redactor.tags === 'function') {
      try {
        const normalized = redactor.tags(tags)
        if (Array.isArray(normalized)) return normalized.slice(0, STYLE_MAX_TAGS)
      } catch {
        // fall through to the local normaliser
      }
    }
    return storedTags(tags)
  }

  /** @param {unknown} value @returns {number} */
  _preparePriority(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > STYLE_MAX_PRIORITY) {
      throw new ConfluenceError('BAD_ARGUMENT', `style priority must be an integer in [0,${STYLE_MAX_PRIORITY}]`)
    }
    return value
  }

  /** @param {string} label @returns {object} */
  _requireRedactor(label) {
    const redactor = this.redactor
    if (!redactor || typeof redactor.text !== 'function') {
      throw new ConfluenceError('UNAVAILABLE', `style writes require the configured redactor (${label})`)
    }
    return redactor
  }

  /** @param {unknown} raw @param {string} label @returns {string} */
  _redactText(raw, label) {
    const redactor = this._requireRedactor(label)
    let result
    try {
      result = redactor.text(raw)
    } catch (error) {
      throw new ConfluenceError('REDACTED', `redaction failed for ${label}`, { cause: error })
    }
    return isPlainObject(result) ? asString(result.value) : asString(result)
  }

  // -------------------------------------------------------------------------
  // journal plumbing (mirrors MemoryService; read paths never throw)
  // -------------------------------------------------------------------------

  /**
   * @param {boolean} create create the global journal when it does not exist
   * @returns {Promise<object | null>}
   */
  async _resolveJournal(create) {
    let journal = typeof this.store.globalJournal === 'function' ? this.store.globalJournal() : null
    if (journal) return journal
    if (create && typeof this.store.openGlobal === 'function') {
      try {
        return await this.store.openGlobal()
      } catch (error) {
        this.logger.warn({ event: 'style.attach_open_failed', message: error?.message ?? String(error) })
        return null
      }
    }
    if (typeof this.store.refreshMerged === 'function') {
      try {
        await this.store.refreshMerged(GLOBAL_SCOPE_KEY)
      } catch (error) {
        this.logger.warn({ event: 'style.attach_refresh_failed', message: error?.message ?? String(error) })
      }
    }
    return typeof this.store.globalJournal === 'function' ? this.store.globalJournal() : null
  }

  /** Read the global journal records through whichever store surface is available. */
  _readRecords() {
    const journal = this._journal
    if (journal && typeof journal.records === 'function') return journal.records()
    if (journal && typeof journal.view === 'function') return journal.view()
    if (typeof this.store.viewedRecords === 'function') return this.store.viewedRecords(GLOBAL_SCOPE_KEY)
    if (typeof this.store.mergedRecords === 'function') {
      try {
        const records = this.store.mergedRecords(GLOBAL_SCOPE_KEY)
        return Array.isArray(records) ? records : []
      } catch {
        return []
      }
    }
    return []
  }

  /** Recompute the in-memory fold from the current journal records. */
  _refreshView() {
    const records = this._readRecords()
    this._fold = foldStyles(records)
    this._revision = styleRevision(records)
  }

  /** Follow external journal changes so the injected block stays current without polling. */
  _subscribe() {
    if (typeof this._unsubscribe === 'function') {
      try {
        this._unsubscribe()
      } catch {
        // ignore a stale unsubscribe
      }
    }
    this._unsubscribe = null
    const journal = this._journal
    if (journal && typeof journal.onChange === 'function') {
      this._unsubscribe = journal.onChange(() => this._refreshView())
      return
    }
    if (typeof this.store.onMergedChange === 'function') {
      try {
        const off = this.store.onMergedChange(GLOBAL_SCOPE_KEY, () => this._refreshView())
        this._unsubscribe = typeof off === 'function' ? off : null
      } catch {
        this._unsubscribe = null
      }
    }
  }

  /**
   * Append one record to the global journal (append-only) and refresh the fold.
   *
   * @param {Record<string, unknown>} record
   * @returns {Promise<Record<string, unknown>>}
   */
  async _append(record) {
    const journal = await this._ensureJournal()
    const stored = { v: 1, ws: GLOBAL_SCOPE_KEY, ...record }
    let result
    try {
      if (typeof journal.appendAndSync === 'function') result = await journal.appendAndSync(stored)
      else if (typeof journal.append === 'function') result = await journal.append(stored)
      else throw new ConfluenceError('UNAVAILABLE', 'the global journal does not support appending records')
    } catch (error) {
      if (error instanceof ConfluenceError) throw error
      throw new ConfluenceError('STORE_UNAVAILABLE', `style write failed: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    this._refreshView()
    return isPlainObject(result) ? result : stored
  }

  /** @returns {Promise<object>} the open global journal (creating it when needed) */
  async _ensureJournal() {
    if (this._journal && this._ready) return this._journal
    await this.attach()
    if (this._journal) return this._journal
    throw new ConfluenceError('STORE_UNAVAILABLE', 'the global journal is unavailable; cannot write style records')
  }
}
