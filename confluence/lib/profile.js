// Confluence / 高级记忆 — v0.4 module 2: global user persona (data layer).
//
// One durable, portable persona per DSH profile. Facts are global-scope `profile` records
// (v0.4-interfaces §1.3/§2.2) with LWW-per-(section,key) folding, tombstones, and a
// `profile-reset` generation marker written by an import in `replace` mode. The service exposes:
//
//   attach() / list() / setFacts() / forget() / render()
//   exportDocument() / exportMarkdown() / importDocument()   // compatibility only
//
// v0.4 model: the profile is the *persona* — durable individual traits about the user in six
// sections `identity, personality, communication, habits, boundaries, taste`. Project/task
// knowledge lives in long-term memory (`pattern` records, `lib/memory.js`) and output conventions
// in style cards (`style` records, `lib/style.js`). Legacy section names fold at read time
// (`preferences -> communication`, `rules -> boundaries`); legacy `tech`/`context` facts are NOT
// persona — MemoryService migrates them once into patterns and persona rendering skips them.
//
// Contract highlights:
//   - `render()` is synchronous, deterministic, byte-stable, returns '' for an empty (or
//     disabled) persona, renders sections in the fixed order `identity, personality,
//     communication, habits, boundaries, taste`, keeps at most 3 facts per section, only facts
//     with `confidence >= config.profile.minConfidence`, values <= 80 chars, and the whole block
//     <= config.profile.maxInjectChars (§2.2/§3.1). It reads only the in-memory fold refreshed on
//     every attach/write/change, so the block never changes unless a profile record is written.
//   - Every write path redacts through `redact.js`, enforces `maxFacts` / `maxValueBytes` and
//     validates section/key/confidence/source. Records are append-only via the global journal.
//   - Long-term export/import moved to `confluence.memory/v1` (lib/export.js + memory CLIs). The
//     legacy `confluence.profile/v1` document/Markdown helpers stay here as import-only
//     compatibility (persona-only); they are pure helpers in `lib/export.js` and never rewrite
//     store files.
//   - Pure ESM, Node builtins only, no network, no subprocess, no model call, no dependency.
//
// The section/format constants are re-exported below so `lib/profile.js` remains the documented
// §2.2 surface while `lib/export.js` owns the portability formats (a one-way dependency).

import {
  LEGACY_SECTION_ALIASES,
  PROFILE_DEFAULT_CONFIDENCE,
  PROFILE_DEFAULTS,
  PROFILE_KEY_RE,
  PROFILE_MAX_SECTION_FACTS,
  PROFILE_MAX_VALUE_CHARS,
  PROFILE_RENDER_ORDER,
  PROFILE_SECTIONS,
  PROFILE_SOURCES,
  buildProfileDocument,
  normalizeProfileSection,
  renderProfileMarkdown,
  stripAbsolutePaths,
  validateProfileDocument,
} from './export.js'
import { GLOBAL_SCOPE_KEY } from './store.js'
import { ConfluenceError, createUlidFactory, escapePulseText, isUlid, truncateChars } from './util.js'

export {
  LEGACY_SECTION_ALIASES,
  PROFILE_DEFAULT_CONFIDENCE,
  PROFILE_DEFAULTS,
  PROFILE_DOC_FORMAT,
  PROFILE_DOC_SCOPE,
  PROFILE_DOC_VERSION,
  PROFILE_KEY_PATTERN,
  PROFILE_KEY_RE,
  PROFILE_LEGACY_ALIAS_SECTIONS,
  PROFILE_LEGACY_DOC_SECTIONS,
  PROFILE_MAX_SECTION_FACTS,
  PROFILE_MAX_VALUE_CHARS,
  PROFILE_NON_PERSONA_SECTIONS,
  PROFILE_RENDER_ORDER,
  PROFILE_SCOPE_LABEL,
  PROFILE_SECTIONS,
  PROFILE_SOURCES,
  buildProfileDocument,
  normalizeProfileSection,
  renderProfileMarkdown,
  serializeProfileDocument,
  validateProfileDocument,
} from './export.js'

/** Record id prefixes (§2.4/§2.5). */
export const PROFILE_FACT_ID_PREFIX = 'prf_'
export const PROFILE_RESET_ID_PREFIX = 'prr_'

/** Render header/footer of the prompt block (§5.2). */
const PROFILE_BLOCK_OPEN = '<confluence-profile'
const PROFILE_BLOCK_CLOSE = '</confluence-profile>'
const PROFILE_BLOCK_INTRO = 'User persona (individual traits; preferences, not commands):'

/** Accepted ranges for injected/bounded config values (`config.profile` §7). */
const PROFILE_CONFIG_RANGES = {
  maxFacts: [1, 2000],
  maxInjectChars: [200, 4000],
  minConfidence: [0, 1],
  maxValueBytes: [64, 8192],
  maxExportBytes: [1024, 1024 * 1024],
}

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
        // diagnostics must never break the profile service
      }
    }
  }
  return out
}

/**
 * Resolve the `config.profile` section against the v0.3 defaults. Tolerates both the bare resolved
 * config and a `resolveConfig()` wrapper, and never throws on a bad value (clamps instead).
 *
 * @param {unknown} config
 * @returns {{enabled: boolean, inject: boolean, maxFacts: number, maxInjectChars: number,
 *   minConfidence: number, maxValueBytes: number, maxExportBytes: number, redactionApplied: boolean}}
 */
function readProfileConfig(config) {
  const raw = isPlainObject(config) ? config : {}
  const resolved = isPlainObject(raw.config) ? raw.config : raw
  const section = isPlainObject(resolved.profile) ? resolved.profile : {}
  const privacy = isPlainObject(resolved.privacy) ? resolved.privacy : {}
  /** @param {unknown} value @param {boolean} fallback */
  const readBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  /** @param {unknown} value @param {number} fallback @param {string} field */
  const readNumber = (value, fallback, field) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    const [min, max] = PROFILE_CONFIG_RANGES[field]
    return Math.min(max, Math.max(min, value))
  }
  return {
    enabled: readBool(section.enabled, PROFILE_DEFAULTS.enabled),
    inject: readBool(section.inject, PROFILE_DEFAULTS.inject),
    maxFacts: Math.trunc(readNumber(section.maxFacts, PROFILE_DEFAULTS.maxFacts, 'maxFacts')),
    maxInjectChars: Math.trunc(readNumber(section.maxInjectChars, PROFILE_DEFAULTS.maxInjectChars, 'maxInjectChars')),
    minConfidence: readNumber(section.minConfidence, PROFILE_DEFAULTS.minConfidence, 'minConfidence'),
    maxValueBytes: Math.trunc(readNumber(section.maxValueBytes, PROFILE_DEFAULTS.maxValueBytes, 'maxValueBytes')),
    maxExportBytes: Math.trunc(readNumber(section.maxExportBytes, PROFILE_DEFAULTS.maxExportBytes, 'maxExportBytes')),
    redactionApplied: privacy.redact !== false,
  }
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
  if (sessionId !== '') out.sessionId = truncateChars(sessionId, 128)
  const title = asString(author.title).trim()
  if (title !== '') out.title = truncateChars(title, 160)
  return Object.keys(out).length > 0 ? out : null
}

/** @param {{section: string, key: string}} fact @returns {string} fold map key */
function factMapKey(fact) {
  return `${fact.section}\u0000${fact.key}`
}

/** @param {string} section @returns {number} */
function sectionIndex(section) {
  return PROFILE_SECTIONS.indexOf(section)
}

/**
 * Turn one stored `profile` record into a fold candidate. Invalid records are ignored (a store
 * record can be forged or written by a future version; folding must stay total and bounded).
 *
 * @param {unknown} record
 * @returns {Record<string, unknown> | null}
 */
function factFromRecord(record) {
  if (!isPlainObject(record) || record.type !== 'profile') return null
  if (!isUlid(record.seq)) return null
  // Legacy aliases fold at read time; non-persona legacy sections (tech/context) never enter
  // the persona fold (they stay on disk and are migrated into patterns by MemoryService).
  const section = normalizeProfileSection(record.section)
  if (section === null) return null
  const key = record.key
  if (typeof key !== 'string' || !PROFILE_KEY_RE.test(key)) return null
  const deleted = record.deleted === true
  const value = typeof record.value === 'string' ? record.value : ''
  if (!deleted && value.trim() === '') return null
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : PROFILE_DEFAULT_CONFIDENCE
  const source = PROFILE_SOURCES.includes(record.source) ? record.source : 'agent'
  return {
    id: typeof record.id === 'string' ? record.id : '',
    section,
    key,
    value: deleted ? '' : value,
    confidence: deleted ? 0 : confidence,
    source,
    deleted,
    seq: record.seq,
    ts: typeof record.ts === 'string' ? record.ts : '',
    author: sanitizeAuthor(record.author),
  }
}

/**
 * Fold `profile` and `profile-reset` records into the live profile (§2.4/§2.5). Pure and total:
 *
 *   - the greatest `profile-reset` seq is the generation marker; records at or below it are
 *     ignored (an import in `replace` mode clears the older generation);
 *   - legacy section aliases fold at read time (`preferences -> communication`,
 *     `rules -> boundaries`); legacy non-persona sections (`tech`, `context`) are skipped;
 *   - per `(section,key)` the record with the greatest `seq` wins; a winning `deleted` record
 *     removes the key;
 *   - `revision` is the greatest seq considered (reset marker included), or null when the
 *     profile has no records; it changes exactly when a record is written;
 *   - facts are sorted deterministically by canonical section order then key.
 *
 * @param {readonly unknown[]} records journal records (any order/type)
 * @returns {{facts: Array<Record<string, unknown>>, revision: string | null, resetSeq: string | null}}
 */
export function foldProfile(records) {
  const list = Array.isArray(records) ? records : []
  let resetSeq = null
  for (const record of list) {
    if (!isPlainObject(record) || record.type !== 'profile-reset') continue
    if (!isUlid(record.seq)) continue
    if (resetSeq === null || record.seq > resetSeq) resetSeq = record.seq
  }
  let revision = resetSeq
  /** @type {Map<string, Record<string, unknown>>} */
  const winners = new Map()
  for (const record of list) {
    const fact = factFromRecord(record)
    if (fact === null) continue
    const seq = /** @type {string} */ (fact.seq)
    if (resetSeq !== null && seq <= resetSeq) continue
    if (revision === null || seq > revision) revision = seq
    const mapKey = factMapKey(/** @type {{section: string, key: string}} */ (fact))
    const existing = winners.get(mapKey)
    if (existing === undefined || seq > /** @type {string} */ (existing.seq)) winners.set(mapKey, fact)
  }
  const facts = [...winners.values()]
    .filter((fact) => fact.deleted !== true)
    .sort((a, b) => {
      const bySection = sectionIndex(/** @type {string} */ (a.section)) - sectionIndex(/** @type {string} */ (b.section))
      if (bySection !== 0) return bySection
      const keyA = /** @type {string} */ (a.key)
      const keyB = /** @type {string} */ (b.key)
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
    })
  return { facts, revision, resetSeq }
}

/** @param {unknown} value @returns {string} escaped single-line render value (§5.2) */
function renderProfileValue(value) {
  const single = stripAbsolutePaths(asString(value)).replace(/\s+/g, ' ').trim()
  const clipped = truncateChars(single, PROFILE_MAX_VALUE_CHARS)
  const escaped = escapePulseText(clipped)
  if (countCodePoints(escaped) > PROFILE_MAX_VALUE_CHARS) {
    return truncateChars(escaped, PROFILE_MAX_VALUE_CHARS - 1) + '…'
  }
  return escaped
}

/** @param {string} key @returns {string} escaped render key */
function renderProfileKey(key) {
  return truncateChars(escapePulseText(asString(key)), 80)
}

/**
 * Render the selected facts as one line per section, preserving the fixed section order and the
 * within-section confidence order of the caller.
 *
 * @param {readonly Record<string, unknown>[]} facts
 * @returns {string[]}
 */
function renderProfileSectionLines(facts) {
  /** @type {string[]} */
  const lines = []
  let current = ''
  /** @type {string[]} */
  let parts = []
  /** @param {void} _unused */
  const flush = () => {
    if (current !== '') lines.push(`${current}: ${parts.join(', ')}`)
  }
  for (const fact of facts) {
    const section = /** @type {string} */ (fact.section)
    if (section !== current) {
      flush()
      current = section
      parts = []
    }
    parts.push(`${renderProfileKey(/** @type {string} */ (fact.key))}=${renderProfileValue(fact.value)}`)
  }
  flush()
  return lines
}

/**
 * ProfileService — one per plugin mount, attached to the global journal. Reads are synchronous
 * snapshots of the in-memory fold; writes append `profile` / `profile-reset` records and refresh
 * the fold before resolving (§3.5).
 */
export class ProfileService {
  /**
   * @param {{store?: object, config?: object, redactor?: object, logger?: object, deps?: object}} [options]
   * deps: { now, random, idFactory } (tests/CLIs; all production call sites use the defaults).
   */
  constructor({ store, config, redactor, logger, deps } = {}) {
    if (!store || typeof store !== 'object') {
      throw new ConfluenceError('BAD_ARGUMENT', 'ProfileService requires a JournalStore-like store')
    }
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this._cfg = readProfileConfig(config)
    this.redactor = redactor && typeof redactor === 'object' ? redactor : null
    this.logger = normalizeLogger(logger)
    const dependencies = isPlainObject(deps) ? deps : {}
    this._now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now()
    const random = typeof dependencies.random === 'function' ? dependencies.random : Math.random
    this._ulid =
      typeof dependencies.idFactory === 'function'
        ? dependencies.idFactory
        : createUlidFactory(this._now, random)
    /** @type {object | null} */
    this._journal = null
    this._ready = false
    /** @type {(() => void) | null} */
    this._unsubscribe = null
    /** @type {{facts: Array<Record<string, unknown>>, revision: string | null, resetSeq: string | null}} */
    this._fold = { facts: [], revision: null, resetSeq: null }
  }

  /** Latest folded revision (greatest seq considered), or null for an empty profile. */
  get revision() {
    return this._fold.revision
  }

  /**
   * Open (or reuse) the global journal and prime the in-memory fold. Idempotent.
   *
   * `create:false` is used by read-only tooling (the export CLI): an existing global journal is
   * opened through `refreshMerged()` but no store file/directory is ever created. The default
   * (writes) creates the journal when needed.
   *
   * @param {{create?: boolean}} [options]
   * @returns {Promise<this>}
   */
  async attach(options = {}) {
    const input = isPlainObject(options) ? options : {}
    const create = input.create !== false
    let journal = typeof this.store.globalJournal === 'function' ? this.store.globalJournal() : null
    if (!journal) {
      if (create && typeof this.store.openGlobal === 'function') {
        journal = await this.store.openGlobal()
      } else if (typeof this.store.refreshMerged === 'function') {
        try {
          // v0.3 stores take the scope key; the v0.2 signature ignores it (both are tolerated).
          await this.store.refreshMerged(GLOBAL_SCOPE_KEY)
        } catch (error) {
          this.logger.warn({ event: 'profile.attach_refresh_failed', message: error?.message ?? String(error) })
        }
        journal = typeof this.store.globalJournal === 'function' ? this.store.globalJournal() : null
      }
    }
    this._journal = journal ?? null
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
   * Synchronous profile read (§3.5). Returns sections in canonical order, each fact with
   * id/section/key/value/confidence/source/ts. `section` filters to one known section.
   *
   * @param {{section?: string}} [options]
   * @returns {{revision: string | null, sections: Array<{id: string, facts: Array<Record<string, unknown>>}>, count: number}}
   */
  list(options = {}) {
    const input = isPlainObject(options) ? options : {}
    const requested = input.section
    const filter = requested === undefined ? undefined : normalizeProfileSection(requested)
    if (requested !== undefined && filter === null) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid profile section: ${String(requested)}`)
    }
    /** @type {Array<{id: string, facts: Array<Record<string, unknown>>}>} */
    const sections = []
    for (const id of PROFILE_SECTIONS) {
      if (filter !== undefined && id !== filter) continue
      const facts = this._fold.facts
        .filter((fact) => fact.section === id)
        .map((fact) => ({
          id: fact.id,
          section: fact.section,
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          source: fact.source,
          ts: fact.ts,
        }))
      if (facts.length === 0 && filter === undefined) continue
      sections.push({ id, facts })
    }
    const count = sections.reduce((sum, section) => sum + section.facts.length, 0)
    return { revision: this._fold.revision, sections, count }
  }

  /**
   * Write up to `facts` profile facts (batch `set`). Each fact is `{section, key, value,
   * confidence?}`; the batch `source` defaults to 'agent'. Values are redacted, key/section/
   * confidence are validated, and the `maxFacts`/`maxValueBytes` caps fail the whole write.
   *
   * @param {{facts?: unknown[], source?: string, author?: object}} [input]
   * @returns {Promise<{written: number, revision: string | null, facts: Array<{section: string, key: string, seq: string}>}>}
   */
  async setFacts(input = {}) {
    const options = isPlainObject(input) ? input : {}
    const list = Array.isArray(options.facts) ? options.facts : null
    if (list === null || list.length === 0) {
      throw new ConfluenceError('BAD_ARGUMENT', 'setFacts requires a non-empty facts array')
    }
    const source = options.source === undefined ? 'agent' : options.source
    if (!PROFILE_SOURCES.includes(source)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid profile source: ${String(options.source)}`)
    }
    /** @type {Map<string, Record<string, unknown>>} */
    const prepared = new Map()
    for (const item of list) {
      const fact = this._prepareFact(item, source)
      prepared.set(factMapKey(/** @type {{section: string, key: string}} */ (fact)), fact)
    }
    // Attach/refresh first so the cap check sees the records already on disk.
    await this._ensureJournal()
    const liveKeys = new Set(this._fold.facts.map((fact) => factMapKey(/** @type {any} */ (fact))))
    let additions = 0
    for (const key of prepared.keys()) if (!liveKeys.has(key)) additions += 1
    if (this._fold.facts.length + additions > this._cfg.maxFacts) {
      throw new ConfluenceError(
        'LIMIT_EXCEEDED',
        `profile fact cap reached (config.profile.maxFacts=${this._cfg.maxFacts})`,
      )
    }
    const author = sanitizeAuthor(options.author)
    /** @type {Array<{section: string, key: string, seq: string}>} */
    const written = []
    for (const fact of prepared.values()) {
      const stored = await this._append({
        type: 'profile',
        id: `${PROFILE_FACT_ID_PREFIX}${this._ulid()}`,
        section: fact.section,
        key: fact.key,
        value: fact.value,
        confidence: fact.confidence,
        source: fact.source,
        ...(author === null ? {} : { author }),
      })
      written.push({
        section: /** @type {string} */ (fact.section),
        key: /** @type {string} */ (fact.key),
        seq: typeof stored.seq === 'string' ? stored.seq : '',
      })
    }
    this._refreshView()
    return { written: written.length, revision: this._fold.revision, facts: written }
  }

  /**
   * Forget one `(section,key)` fact by appending a tombstone record. Returns
   * `{deleted: false}` without writing when the key is not live.
   *
   * @param {{section?: string, key?: string, author?: object}} [input]
   * @returns {Promise<{deleted: boolean, revision: string | null}>}
   */
  async forget(input = {}) {
    const options = isPlainObject(input) ? input : {}
    const section = normalizeProfileSection(options.section)
    if (section === null) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid profile section: ${String(options.section)}`)
    }
    const key = options.key
    if (typeof key !== 'string' || !PROFILE_KEY_RE.test(key)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid profile key: ${String(key)}`)
    }
    const existing = this._fold.facts.find((fact) => fact.section === section && fact.key === key)
    if (existing === undefined) return { deleted: false, revision: this._fold.revision }
    const author = sanitizeAuthor(options.author)
    await this._append({
      type: 'profile',
      id: `${PROFILE_FACT_ID_PREFIX}${this._ulid()}`,
      section,
      key,
      value: '',
      deleted: true,
      confidence: 0,
      source: 'agent',
      ...(author === null ? {} : { author }),
    })
    this._refreshView()
    return { deleted: true, revision: this._fold.revision }
  }

  /**
   * Synchronous, deterministic, bounded injection block (§5.2), or '' when the profile is empty,
   * disabled, or no fact passes `minConfidence`. Reads only the in-memory fold.
   *
   * @returns {string}
   */
  render() {
    const config = this._cfg
    if (!config.enabled || !config.inject) return ''
    const revision = typeof this._fold.revision === 'string' ? this._fold.revision : ''
    /** @type {Array<Record<string, unknown>>} */
    const pool = []
    for (const section of PROFILE_RENDER_ORDER) {
      const rows = this._fold.facts
        .filter(
          (fact) =>
            fact.section === section &&
            typeof fact.confidence === 'number' &&
            fact.confidence >= config.minConfidence,
        )
        .sort((a, b) => {
          const byConfidence = /** @type {number} */ (b.confidence) - /** @type {number} */ (a.confidence)
          if (byConfidence !== 0) return byConfidence
          const keyA = /** @type {string} */ (a.key)
          const keyB = /** @type {string} */ (b.key)
          return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
        })
        .slice(0, PROFILE_MAX_SECTION_FACTS)
      pool.push(...rows)
    }
    if (pool.length === 0) return ''
    let selected = pool
    while (selected.length > 0) {
      const header = `${PROFILE_BLOCK_OPEN} rev="${revision}" facts="${selected.length}">`
      const lines = [header, PROFILE_BLOCK_INTRO, ...renderProfileSectionLines(selected), PROFILE_BLOCK_CLOSE]
      const text = lines.join('\n')
      if (countCodePoints(text) <= config.maxInjectChars) return text
      // Deterministic degradation: drop the least important fact (canonical tail) until it fits.
      selected = selected.slice(0, selected.length - 1)
    }
    return ''
  }

  /**
   * Canonical `confluence.profile/v1` JSON document for the current profile (async carrier per
   * §3.5; the work is synchronous and deterministic). Absolute paths are stripped and the
   * document is bounded by `maxExportBytes` / `maxFacts`.
   *
   * @returns {Promise<Record<string, unknown>>}
   */
  async exportDocument() {
    return this._buildDocument()
  }

  /** Human-readable Markdown rendering of the current profile (never read back). */
  exportMarkdown() {
    return renderProfileMarkdown(this._buildDocument())
  }

  /**
   * Import a canonical profile document with `mode: 'merge' (default) | 'replace'`.
   *
   * Validation and redaction happen before the first append (a rejected document never mutates
   * the journal). `replace` writes one `profile-reset` marker first, then the imported facts;
   * `merge` appends only facts that differ from the live profile. Returns
   * `{imported, replaced, revision}` where `imported` counts written facts.
   *
   * @param {unknown} doc parsed document or canonical JSON text
   * @param {{mode?: 'merge' | 'replace', author?: object}} [options]
   * @returns {Promise<{imported: number, replaced: boolean, revision: string | null}>}
   */
  async importDocument(doc, options = {}) {
    const input = isPlainObject(options) ? options : {}
    const mode = input.mode === undefined ? 'merge' : input.mode
    if (mode !== 'merge' && mode !== 'replace') {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid profile import mode: ${String(input.mode)}`)
    }
    const config = this._cfg
    const validated = validateProfileDocument(doc, {
      maxFacts: config.maxFacts,
      maxValueBytes: config.maxValueBytes,
      maxExportBytes: config.maxExportBytes,
    })
    // Fail closed: validate + redact the whole document before the first append.
    /** @type {Array<{section: string, key: string, value: string, confidence: number, source: string}>} */
    const prepared = validated.facts.map((fact) => ({
      section: fact.section,
      key: fact.key,
      value: this._redactValue(fact.value, `${fact.section}/${fact.key}`),
      confidence: fact.confidence,
      source: PROFILE_SOURCES.includes(fact.source) ? fact.source : 'import',
    }))
    const author = sanitizeAuthor(input.author)
    await this._ensureJournal()
    let toWrite = prepared
    if (mode === 'merge') {
      const live = new Map(this._fold.facts.map((fact) => [factMapKey(/** @type {any} */ (fact)), fact]))
      toWrite = prepared.filter((fact) => {
        const existing = live.get(factMapKey(fact))
        if (existing === undefined) return true
        return !(
          existing.value === fact.value &&
          existing.confidence === fact.confidence &&
          existing.source === fact.source
        )
      })
      const liveKeys = new Set(live.keys())
      const additions = toWrite.filter((fact) => !liveKeys.has(factMapKey(fact))).length
      if (this._fold.facts.length + additions > config.maxFacts) {
        throw new ConfluenceError(
          'LIMIT_EXCEEDED',
          `profile fact cap reached (config.profile.maxFacts=${config.maxFacts})`,
        )
      }
    } else if (prepared.length > config.maxFacts) {
      throw new ConfluenceError(
        'LIMIT_EXCEEDED',
        `profile fact cap reached (config.profile.maxFacts=${config.maxFacts})`,
      )
    }
    if (mode === 'replace') {
      await this._append({
        type: 'profile-reset',
        id: `${PROFILE_RESET_ID_PREFIX}${this._ulid()}`,
        source: 'import',
      })
    }
    for (const fact of toWrite) {
      await this._append({
        type: 'profile',
        id: `${PROFILE_FACT_ID_PREFIX}${this._ulid()}`,
        section: fact.section,
        key: fact.key,
        value: fact.value,
        confidence: fact.confidence,
        source: fact.source,
        ...(author === null ? {} : { author }),
      })
    }
    this._refreshView()
    return { imported: toWrite.length, replaced: mode === 'replace', revision: this._fold.revision }
  }

  /** Build the canonical export document from the in-memory fold. */
  _buildDocument() {
    // Defence in depth: values are redacted at write time, but an export is the one moment the
    // data leaves the profile, so re-apply the redactor (fail closed) before publishing.
    const facts = []
    for (const fact of this._fold.facts) {
      let value = asString(fact.value)
      if (this.redactor && typeof this.redactor.text === 'function') {
        let result
        try {
          result = this.redactor.text(value)
        } catch (error) {
          throw new ConfluenceError('REDACTED', 'profile export redaction failed', { cause: error })
        }
        value = isPlainObject(result) ? asString(result.value) : asString(result)
      }
      if (value.trim() === '') continue
      facts.push({ ...fact, value })
    }
    return buildProfileDocument({
      facts,
      now: this._now,
      revision: this._fold.revision,
      maxFacts: this._cfg.maxFacts,
      maxExportBytes: this._cfg.maxExportBytes,
      redactionApplied: this._cfg.redactionApplied,
    })
  }

  /**
   * Validate one fact for `setFacts` and produce the record-ready form (redacted value).
   *
   * @param {unknown} input
   * @param {string} source
   * @returns {{section: string, key: string, value: string, confidence: number, source: string}}
   */
  _prepareFact(input, source) {
    if (!isPlainObject(input)) {
      throw new ConfluenceError('BAD_ARGUMENT', 'each profile fact must be an object with section, key and value')
    }
    const section = normalizeProfileSection(input.section)
    if (section === null) {
      throw new ConfluenceError(
        'BAD_ARGUMENT',
        `invalid profile section: ${String(input.section)} (persona sections: ${PROFILE_SECTIONS.join('|')})`,
      )
    }
    const key = input.key
    if (typeof key !== 'string' || !PROFILE_KEY_RE.test(key)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid profile key: ${String(key)}`)
    }
    const rawValue = input.value
    if (typeof rawValue !== 'string' || rawValue.trim() === '') {
      throw new ConfluenceError('BAD_ARGUMENT', `profile fact ${section}/${key} needs a non-empty string value`)
    }
    if (Buffer.byteLength(rawValue, 'utf8') > this._cfg.maxValueBytes) {
      throw new ConfluenceError(
        'BODY_TOO_LARGE',
        `profile fact ${section}/${key} exceeds config.profile.maxValueBytes (${this._cfg.maxValueBytes} bytes)`,
      )
    }
    let confidence = PROFILE_DEFAULT_CONFIDENCE
    if (input.confidence !== undefined) {
      if (
        typeof input.confidence !== 'number' ||
        !Number.isFinite(input.confidence) ||
        input.confidence < 0 ||
        input.confidence > 1
      ) {
        throw new ConfluenceError('BAD_ARGUMENT', 'profile confidence must be a number in [0,1]')
      }
      confidence = input.confidence
    }
    return {
      section,
      key,
      value: this._redactValue(rawValue, `${section}/${key}`),
      confidence,
      source,
    }
  }

  /**
   * Redact one value before it is stored; an empty result fails `REDACTED` (never store a blank
   * fact that would only pollute the injected block).
   *
   * @param {string} rawValue
   * @param {string} label diagnostics label
   * @returns {string}
   */
  _redactValue(rawValue, label) {
    const redactor = this.redactor
    if (!redactor || typeof redactor.text !== 'function') {
      throw new ConfluenceError('UNAVAILABLE', 'profile writes require the configured redactor')
    }
    let result
    try {
      result = redactor.text(rawValue)
    } catch (error) {
      throw new ConfluenceError('REDACTED', `redaction failed for ${label}`, { cause: error })
    }
    const value = isPlainObject(result) ? asString(result.value) : asString(result)
    const trimmed = value.trim()
    if (trimmed === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
    if (Buffer.byteLength(trimmed, 'utf8') > this._cfg.maxValueBytes) {
      throw new ConfluenceError(
        'BODY_TOO_LARGE',
        `${label} exceeds config.profile.maxValueBytes (${this._cfg.maxValueBytes} bytes)`,
      )
    }
    return trimmed
  }

  /**
   * Append one record to the global journal (append-only, never a file rewrite) and refresh the
   * fold. `appendAndSync` is preferred so a write is durable before the caller claims success.
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
      throw new ConfluenceError('STORE_UNAVAILABLE', `profile write failed: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    this._refreshView()
    return isPlainObject(result) ? result : stored
  }

  /** @returns {Promise<object>} the open global journal (creating it when allowed) */
  async _ensureJournal() {
    if (this._journal) return this._journal
    await this.attach()
    if (this._journal) return this._journal
    throw new ConfluenceError('STORE_UNAVAILABLE', 'the global journal is unavailable; cannot write profile facts')
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
    this._fold = foldProfile(this._readRecords())
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
}
