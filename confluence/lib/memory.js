// Confluence / 高级记忆 — v0.4 long-term memory (`pattern` records).
//
// One durable, portable long-term-memory layer per DSH profile. Patterns are
// generalizable facts abstracted from earlier tasks (workflow heuristics,
// project conventions, domain knowledge, pitfalls, quality rules) and are
// global-scope `pattern` records (v0.4-interfaces §1.1) tagged with a scope:
//   - `scope:'global'` patterns apply to every session;
//   - `scope:'workspace'` patterns only apply to sessions of their workspaceKey.
//
// Contract highlights:
//   - Append-only: an update/status change is a NEW record with the same stable
//     `key`; `foldPatterns()` keeps the greatest `seq` per key (LWW).
//   - Candidate queue: `add()` ALWAYS writes `status:'candidate'`; only `active`
//     patterns are injected as rules, candidates are announced with a bounded
//     headline so the user/Agent can confirm (`promote`) or reject them.
//     `importPattern()` is the explicit portability path that writes active.
//   - `renderBlock()` is synchronous, deterministic, byte-stable, exception-safe
//     and bounded by `config.memory.maxInjectPatterns` / `maxInjectChars`
//     (§3.2). It reads only the in-memory fold; no IO, never throws.
//   - Every write path redacts through `redact.js` and enforces the caps
//     (body 2048 bytes, title 120 chars, tags ≤8, evidence ≤3, maxPatterns).
//   - One-time v0.3 migration: on attach, when no `memory-migration` marker
//     exists and the global profile still holds `tech`/`context` facts, those
//     facts become `active` global patterns (`source:'migration'`) and a marker
//     record is appended. Idempotent; never rewrites an existing record/key.
//   - Pure ESM, Node builtins only, no network, no subprocess, no model call,
//     no dependency.
//
// Contract: docs/plan/v0.4-interfaces.md §1.1/§1.4/§2.1/§3.2/§5 and ADR-0009.

import { GLOBAL_SCOPE_KEY } from './store.js'
import {
  ConfluenceError,
  createUlidFactory,
  escapePulseText,
  isUlid,
  sha256Hex,
  truncateChars,
  truncateUtf8,
} from './util.js'

/** Pattern category vocabulary (§1.1). */
export const PATTERN_CATEGORIES = Object.freeze([
  'workflow',
  'project',
  'domain',
  'pitfall',
  'heuristic',
  'quality',
])

/** Pattern status vocabulary (§1.1). `superseded` is reserved for imports/tooling. */
export const PATTERN_STATUSES = Object.freeze(['candidate', 'active', 'rejected', 'superseded'])

/** Pattern relevance scope (§1.1). */
export const PATTERN_SCOPES = Object.freeze(['global', 'workspace'])

/** Pattern provenance vocabulary (§1.1). */
export const PATTERN_SOURCES = Object.freeze(['agent', 'user', 'import', 'migration'])

/** Stable pattern key grammar (§1.1): `^[a-z0-9][a-z0-9._-]{0,63}$`. */
export const PATTERN_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$'
export const PATTERN_KEY_RE = new RegExp(PATTERN_KEY_PATTERN)

/** Tag grammar (§1.1): `^[a-z0-9][a-z0-9_-]{0,31}$`, at most 8 tags. */
export const PATTERN_TAG_PATTERN = '^[a-z0-9][a-z0-9_-]{0,31}$'
const PATTERN_TAG_RE = new RegExp(PATTERN_TAG_PATTERN)
export const PATTERN_MAX_TAGS = 8

/** Confidence default for a new candidate / imported pattern (`.memory.candidateConfidence`). */
export const PATTERN_DEFAULT_CONFIDENCE = 0.5

/** Id prefixes (record ids are never reused for the same key). */
export const PATTERN_ID_PREFIX = 'pat_'
export const MEMORY_MIGRATION_ID_PREFIX = 'mig_'

/** v0.3 → v0.4 migration marker fields (§1.4/§5). */
export const MEMORY_MIGRATION_VERSION = 1
export const MEMORY_MIGRATION_SOURCE = 'profile-v03'

/** Legacy non-persona profile sections migrated once into patterns (§5). */
export const MEMORY_LEGACY_SECTION_CATEGORIES = Object.freeze({ tech: 'project', context: 'domain' })

/** Write caps (§1.1). */
export const PATTERN_MAX_TITLE_CHARS = 120
export const PATTERN_MAX_BODY_BYTES = 2048
export const PATTERN_MAX_EVIDENCE = 3
export const PATTERN_MAX_EVIDENCE_NOTE_CHARS = 200
export const PATTERN_MAX_WORKSPACE_LABEL_CHARS = 120
export const PATTERN_MAX_QUERY_CHARS = 200
export const PATTERN_MAX_LIST_LIMIT = 1000

/** Config defaults for `config.memory` (§7); mirrored locally so this module stays pure. */
export const MEMORY_DEFAULTS = Object.freeze({
  enabled: true,
  inject: true,
  maxPatterns: 300,
  maxInjectPatterns: 5,
  maxInjectChars: 1200,
  candidateConfidence: 0.5,
  autoCapture: 'candidate',
})

/** Accepted ranges for resolved/bounded config values (`config.memory` §7). */
const MEMORY_CONFIG_RANGES = {
  maxPatterns: [1, 5000],
  maxInjectPatterns: [0, 20],
  maxInjectChars: [200, 6000],
}

/** Prompt block framing (§3.2). */
const PATTERN_BLOCK_OPEN = '<confluence-memory-patterns'
const PATTERN_BLOCK_CLOSE = '</confluence-memory-patterns>'
const PATTERN_BLOCK_INTRO = 'Long-term memory patterns (generalized from earlier tasks; apply when relevant):'
const PATTERN_CANDIDATE_PROMOTE_HINT = 'confirm with confluence_memory promote.'
const PATTERN_CANDIDATE_KEYS = 2
const PATTERN_CANDIDATE_KEY_CHARS = 48
const PATTERN_RENDER_BODY_CHARS = 200
const PATTERN_RENDER_LINE_CHARS = 360

/** Local copy of the v0.3 store key grammar (a pattern never lives in a workspace journal). */
const WS_KEY_PATTERN = /^ws_[0-9a-f]{16}$/
const AUTHOR_SESSION_CHARS = 128
const AUTHOR_TITLE_CHARS = 160

/** Status display order for `list()` (active rules first, newest proposals last). */
const STATUS_RANK = Object.freeze({ active: 0, candidate: 1, superseded: 2, rejected: 3 })

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
        // diagnostics must never break the memory service
      }
    }
  }
  return out
}

/** @param {unknown} value @returns {number} clamped [0,1] confidence */
function confidenceValue(value, fallback = PATTERN_DEFAULT_CONFIDENCE) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(1, Math.max(0, numeric))
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
 * Normalise one stored/rendered value to a single bounded line (no control
 * characters, no bidi controls, no newlines).
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
 * Normalise one stored evidence list (metadata only, ≤3 entries).
 *
 * @param {unknown} evidence
 * @returns {Array<{sessionId?: string, note?: string}>}
 */
function storedEvidence(evidence) {
  if (!Array.isArray(evidence)) return []
  const out = []
  for (const item of evidence) {
    if (!isPlainObject(item)) continue
    /** @type {{sessionId?: string, note?: string}} */
    const entry = {}
    const sessionId = asString(item.sessionId).trim()
    if (sessionId !== '') entry.sessionId = truncateChars(sessionId, AUTHOR_SESSION_CHARS)
    const note = singleLineText(item.note)
    if (note !== '') entry.note = truncateChars(note, PATTERN_MAX_EVIDENCE_NOTE_CHARS)
    if (Object.keys(entry).length === 0) continue
    out.push(entry)
    if (out.length >= PATTERN_MAX_EVIDENCE) break
  }
  return out
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
    if (!PATTERN_TAG_RE.test(label)) continue
    if (out.includes(label)) continue
    out.push(label)
    if (out.length >= PATTERN_MAX_TAGS) break
  }
  return out
}

/** @param {unknown} value @returns {string} deterministic slug for a derived key */
function derivePatternKey(title) {
  const slug = asString(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const clipped = truncateChars(slug, 64).replace(/-+$/g, '')
  if (clipped === '') return `pattern-${sha256Hex(asString(title)).slice(0, 8)}`
  return clipped
}

/**
 * Turn one stored `pattern` record into a fold candidate. Invalid records are
 * ignored (append-only journals can contain forged/future lines; folds stay
 * total, bounded and deterministic).
 *
 * @param {unknown} record
 * @returns {Record<string, any> | null}
 */
function patternFromRecord(record) {
  if (!isPlainObject(record) || record.type !== 'pattern') return null
  if (typeof record.id !== 'string' || record.id === '') return null
  if (!isUlid(record.seq)) return null
  const key = typeof record.key === 'string' ? record.key : ''
  if (!PATTERN_KEY_RE.test(key)) return null
  const category = PATTERN_CATEGORIES.includes(record.category) ? record.category : null
  if (category === null) return null
  const status = PATTERN_STATUSES.includes(record.status) ? record.status : null
  if (status === null) return null
  const body = truncateUtf8(asString(record.body), PATTERN_MAX_BODY_BYTES).trim()
  if (body === '') return null
  let title = truncateChars(singleLineText(record.title), PATTERN_MAX_TITLE_CHARS)
  if (title === '') title = key
  const scope = PATTERN_SCOPES.includes(record.scope) ? record.scope : 'global'
  /** @type {string | null} */
  let workspaceKey = null
  let workspaceLabel = ''
  if (scope === 'workspace') {
    if (typeof record.workspaceKey !== 'string' || !WS_KEY_PATTERN.test(record.workspaceKey)) return null
    workspaceKey = record.workspaceKey
    workspaceLabel = truncateChars(singleLineText(record.workspaceLabel), PATTERN_MAX_WORKSPACE_LABEL_CHARS)
  }
  const source = PATTERN_SOURCES.includes(record.source) ? record.source : 'agent'
  return {
    id: asString(record.id),
    seq: /** @type {string} */ (record.seq),
    ts: asString(record.ts),
    key,
    category,
    title,
    body,
    tags: storedTags(record.tags),
    scope,
    workspaceKey,
    workspaceLabel,
    status,
    confidence: confidenceValue(record.confidence),
    source,
    evidence: storedEvidence(record.evidence),
    author: sanitizeAuthor(record.author),
  }
}

/** @param {Record<string, any>} a @param {Record<string, any>} b @returns {number} */
function compareStrings(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Newest first, then stable key order. @param {Record<string,any>} a @param {Record<string,any>} b */
function compareSeqDesc(a, b) {
  const bySeq = compareStrings(asString(b.seq), asString(a.seq))
  if (bySeq !== 0) return bySeq
  return compareStrings(asString(a.key), asString(b.key))
}

/** Injection order: confidence desc, then seq desc (§3.2). */
function compareByConfidence(a, b) {
  const byConfidence = Number(b.confidence) - Number(a.confidence)
  if (byConfidence !== 0) return byConfidence
  return compareSeqDesc(a, b)
}

/** List order: status display rank, confidence desc, seq desc. */
function compareListOrder(a, b) {
  const rankA = STATUS_RANK[a.status] ?? 9
  const rankB = STATUS_RANK[b.status] ?? 9
  if (rankA !== rankB) return rankA - rankB
  return compareByConfidence(a, b)
}

/**
 * Fold `pattern` records into the live long-term memory (§1.1).
 *
 * Pure and total:
 *   - per `key`, the record with the greatest `seq` wins (status included);
 *   - `active` = winners with status `active` (injection pool), sorted
 *     confidence desc then seq desc;
 *   - `candidates` = winners with status `candidate`, newest first;
 *   - `byKey` keeps every winning pattern (all statuses);
 *   - `counts` summarises the winners. Invalid records are ignored.
 *
 * @param {readonly unknown[]} records journal records (any order/type)
 * @returns {{byKey: Map<string, Record<string, any>>, active: Array<Record<string, any>>, candidates: Array<Record<string, any>>, counts: {total: number, active: number, candidates: number, rejected: number, superseded: number}}}
 */
export function foldPatterns(records) {
  const list = Array.isArray(records) ? records : []
  /** @type {Map<string, Record<string, any>>} */
  const byKey = new Map()
  for (const record of list) {
    const pattern = patternFromRecord(record)
    if (pattern === null) continue
    const existing = byKey.get(pattern.key)
    if (existing === undefined || compareStrings(asString(pattern.seq), asString(existing.seq)) > 0) {
      byKey.set(pattern.key, pattern)
    }
  }
  const winners = [...byKey.values()]
  const active = winners.filter((pattern) => pattern.status === 'active').sort(compareByConfidence)
  const candidates = winners.filter((pattern) => pattern.status === 'candidate').sort(compareSeqDesc)
  const counts = {
    total: winners.length,
    active: active.length,
    candidates: candidates.length,
    rejected: winners.filter((pattern) => pattern.status === 'rejected').length,
    superseded: winners.filter((pattern) => pattern.status === 'superseded').length,
  }
  return { byKey, active, candidates, counts }
}

/**
 * Greatest `pattern`/`memory-migration` seq of the journal (the memory revision),
 * or null when no memory record exists. Never throws.
 *
 * @param {readonly unknown[]} records
 * @returns {string | null}
 */
export function memoryRevision(records) {
  let revision = null
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record)) continue
    if (record.type !== 'pattern' && record.type !== 'memory-migration') continue
    if (!isUlid(record.seq)) continue
    if (revision === null || /** @type {string} */ (record.seq) > revision) revision = /** @type {string} */ (record.seq)
  }
  return revision
}

/** @param {readonly unknown[]} records @returns {boolean} a migration marker exists */
export function hasMigrationMarker(records) {
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record) || record.type !== 'memory-migration') continue
    if (isUlid(record.seq)) return true
  }
  return false
}

/**
 * Live v0.3 profile facts of the legacy non-persona sections (`tech`/`context`).
 * Respects `profile-reset` generations and per-`(section,key)` LWW tombstones;
 * ordering is deterministic (seq asc, key asc) so a migration is reproducible.
 *
 * @param {readonly unknown[]} records
 * @returns {Array<{section: string, key: string, value: string, confidence: number, sessionId: string}>}
 */
export function legacyProfileFacts(records) {
  const list = Array.isArray(records) ? records : []
  let resetSeq = null
  for (const record of list) {
    if (!isPlainObject(record) || record.type !== 'profile-reset') continue
    if (!isUlid(record.seq)) continue
    if (resetSeq === null || /** @type {string} */ (record.seq) > resetSeq) resetSeq = /** @type {string} */ (record.seq)
  }
  /** @type {Map<string, Record<string, any>>} */
  const winners = new Map()
  for (const record of list) {
    if (!isPlainObject(record) || record.type !== 'profile') continue
    if (!isUlid(record.seq)) continue
    const seq = /** @type {string} */ (record.seq)
    if (resetSeq !== null && seq <= resetSeq) continue
    const section = record.section
    if (!Object.prototype.hasOwnProperty.call(MEMORY_LEGACY_SECTION_CATEGORIES, section)) continue
    const key = typeof record.key === 'string' ? record.key : ''
    if (key === '') continue
    const mapKey = `${section}\u0000${key}`
    const existing = winners.get(mapKey)
    if (existing === undefined || compareStrings(seq, asString(existing.seq)) > 0) winners.set(mapKey, record)
  }
  const facts = []
  for (const record of [...winners.values()]) {
    if (record.deleted === true) continue
    const value = typeof record.value === 'string' ? record.value : ''
    if (value.trim() === '') continue
    const sessionId = isPlainObject(record.author) ? asString(record.author.sessionId).trim() : ''
    facts.push({
      section: /** @type {string} */ (record.section),
      key: /** @type {string} */ (record.key),
      value,
      confidence: confidenceValue(record.confidence, 0.6),
      sessionId: truncateChars(sessionId, AUTHOR_SESSION_CHARS),
    })
  }
  facts.sort((a, b) => {
    const bySeq = compareStrings(asString(winners.get(`${a.section}\u0000${a.key}`)?.seq), asString(winners.get(`${b.section}\u0000${b.key}`)?.seq))
    if (bySeq !== 0) return bySeq
    const bySection = compareStrings(a.section, b.section)
    if (bySection !== 0) return bySection
    return compareStrings(a.key, b.key)
  })
  return facts
}

/** @param {string} section @param {string} rawKey @returns {string} un-disambiguated migrated key */
function migratedKeyBase(section, rawKey) {
  const prefix = `migrated.${section}.`
  const budget = Math.max(1, 64 - prefix.length)
  let clean = asString(rawKey)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
  clean = truncateChars(clean, budget).replace(/[-._]+$/g, '')
  if (clean === '') clean = 'fact'
  return prefix + clean
}

/**
 * Claim a unique migrated key: when another fact already claimed the same
 * sanitized key, append a deterministic digest suffix (still ≤64 chars).
 *
 * @param {string} baseKey
 * @param {Set<string>} used already claimed keys
 * @returns {string}
 */
function uniqueMigratedKey(baseKey, used) {
  if (!used.has(baseKey)) {
    used.add(baseKey)
    return baseKey
  }
  const dot = baseKey.lastIndexOf('.')
  const prefix = baseKey.slice(0, dot + 1)
  const stem = baseKey.slice(dot + 1)
  const digest = sha256Hex(baseKey).slice(0, 8)
  let attempt = 1
  while (true) {
    const suffix = attempt === 1 ? `-${digest}` : `-${digest}-${attempt}`
    const room = Math.max(1, 64 - prefix.length - suffix.length)
    const candidate = prefix + truncateChars(stem, room).replace(/[-._]+$/g, '') + suffix
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
    attempt += 1
    if (attempt > 50) {
      // Practically unreachable; keep the contract total with a bounded counter.
      used.add(baseKey)
      return baseKey
    }
  }
}

/**
 * Resolve the `config.memory` section against the v0.4 defaults. Tolerates both
 * the bare resolved config and a `resolveConfig()` wrapper, and never throws on
 * a bad value (clamps instead).
 *
 * @param {unknown} config
 * @returns {{enabled: boolean, inject: boolean, maxPatterns: number, maxInjectPatterns: number,
 *   maxInjectChars: number, candidateConfidence: number, autoCapture: 'candidate' | 'off'}}
 */
function readMemoryConfig(config) {
  const raw = isPlainObject(config) ? config : {}
  const resolved = isPlainObject(raw.config) ? raw.config : raw
  const section = isPlainObject(resolved.memory) ? resolved.memory : {}
  /** @param {unknown} value @param {boolean} fallback */
  const readBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  /** @param {unknown} value @param {number} fallback @param {string} field */
  const readNumber = (value, fallback, field) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    const [min, max] = MEMORY_CONFIG_RANGES[field]
    return Math.min(max, Math.max(min, value))
  }
  return {
    enabled: readBool(section.enabled, MEMORY_DEFAULTS.enabled),
    inject: readBool(section.inject, MEMORY_DEFAULTS.inject),
    maxPatterns: Math.trunc(readNumber(section.maxPatterns, MEMORY_DEFAULTS.maxPatterns, 'maxPatterns')),
    maxInjectPatterns: Math.trunc(
      readNumber(section.maxInjectPatterns, MEMORY_DEFAULTS.maxInjectPatterns, 'maxInjectPatterns'),
    ),
    maxInjectChars: Math.trunc(readNumber(section.maxInjectChars, MEMORY_DEFAULTS.maxInjectChars, 'maxInjectChars')),
    candidateConfidence: Math.min(
      1,
      Math.max(
        0,
        typeof section.candidateConfidence === 'number' && Number.isFinite(section.candidateConfidence)
          ? section.candidateConfidence
          : MEMORY_DEFAULTS.candidateConfidence,
      ),
    ),
    autoCapture: section.autoCapture === 'off' ? 'off' : 'candidate',
  }
}

/** @param {Record<string, any>} pattern @returns {Record<string, unknown>} §4.2 public shape */
function publicPattern(pattern) {
  /** @type {Record<string, unknown>} */
  const out = {
    key: pattern.key,
    category: pattern.category,
    title: pattern.title,
    body: pattern.body,
    tags: [...pattern.tags],
    scope: pattern.scope,
    status: pattern.status,
    confidence: pattern.confidence,
    source: pattern.source,
    ts: pattern.ts,
  }
  if (pattern.scope === 'workspace') {
    // Portability needs the opaque workspace id to survive an export/import
    // round-trip (contract §2.4 amended); labels alone cannot re-target it.
    if (typeof pattern.workspaceKey === 'string' && WS_KEY_PATTERN.test(pattern.workspaceKey)) {
      out.workspaceKey = pattern.workspaceKey
    }
    if (pattern.workspaceLabel !== '') out.workspaceLabel = pattern.workspaceLabel
  }
  return out
}

/**
 * Copy the content fields of a folded pattern (used by status changes/updates,
 * whose stable key keeps its identity).
 *
 * @param {Record<string, any>} pattern
 * @returns {Record<string, any>}
 */
function contentFieldsOf(pattern) {
  return {
    key: pattern.key,
    category: pattern.category,
    title: pattern.title,
    body: pattern.body,
    tags: [...pattern.tags],
    scope: pattern.scope,
    workspaceKey: pattern.workspaceKey,
    workspaceLabel: pattern.workspaceLabel,
    confidence: pattern.confidence,
    source: pattern.source,
    evidence: pattern.evidence.map((entry) => ({ ...entry })),
    author: pattern.author === null ? null : { ...pattern.author },
  }
}

/** @param {unknown} value @returns {string} one bounded rendered pattern line (§3.2) */
function renderPatternLine(pattern) {
  const category = PATTERN_CATEGORIES.includes(pattern.category) ? pattern.category : 'heuristic'
  const title = truncateChars(singleLineText(escapePulseText(pattern.title)), PATTERN_MAX_TITLE_CHARS)
  const rawBody = stripAbsolutePathsText(singleLineText(pattern.body))
  const escapedBody = escapePulseText(rawBody)
  const body =
    countCodePoints(escapedBody) > PATTERN_RENDER_BODY_CHARS
      ? `${truncateChars(escapedBody, PATTERN_RENDER_BODY_CHARS - 1)}…`
      : escapedBody
  const line = `- [${category}] ${title}: ${body}`
  if (countCodePoints(line) <= PATTERN_RENDER_LINE_CHARS) return line
  return `${truncateChars(line, PATTERN_RENDER_LINE_CHARS - 1)}…`
}

/** @param {Array<Record<string, any>>} candidates @returns {string} bounded candidate headline (§3.2) */
function renderCandidateLine(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return ''
  const keys = candidates
    .slice(0, PATTERN_CANDIDATE_KEYS)
    .map((pattern) => truncateChars(escapePulseText(asString(pattern.key)), PATTERN_CANDIDATE_KEY_CHARS))
  return `Candidates (${candidates.length}): ${keys.join('; ')} — ${PATTERN_CANDIDATE_PROMOTE_HINT}`
}

/**
 * MemoryService — one per plugin mount, attached to the global journal. Reads are
 * synchronous snapshots of the in-memory fold; writes append `pattern` records
 * (and the one-time `memory-migration` marker) and refresh the fold before
 * resolving.
 */
export class MemoryService {
  /**
   * @param {{store?: object, config?: object, redactor?: object, logger?: object, deps?: object}} [options]
   * deps: { now, random, idFactory } (tests/CLIs; production uses the defaults).
   */
  constructor({ store, config, redactor, logger, deps } = {}) {
    if (!store || typeof store !== 'object') {
      throw new ConfluenceError('BAD_ARGUMENT', 'MemoryService requires a JournalStore-like store')
    }
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this._cfg = readMemoryConfig(config)
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
    this._fold = foldPatterns([])
    /** @type {string | null} */
    this._revision = null
    this._migrationApplied = false
  }

  /** Latest folded memory revision (greatest pattern/migration seq), or null. */
  get revision() {
    return this._revision
  }

  /**
   * Open (or reuse) the global journal, prime the in-memory fold and run the
   * one-time v0.3 migration. Idempotent.
   *
   * `create:false` is used by read-only tooling: an existing global journal is
   * opened through `refreshMerged()` but no store file/directory is created, and
   * no migration is attempted.
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
    if (this._journal !== null && input.create !== false) {
      try {
        await this._runMigration()
      } catch (error) {
        // Best effort by contract: a failed migration never blocks the plugin.
        this.logger.warn({ event: 'memory.migration_failed', message: error?.message ?? String(error) })
      }
    }
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
   * Synchronous long-term-memory read (§2.1). `status` defaults to all statuses;
   * `query` is a case-insensitive substring match over key/title/body/tags.
   *
   * @param {{status?: string, category?: string, query?: string, limit?: number}} [options]
   * @returns {{revision: string | null, patterns: Array<Record<string, unknown>>, count: number,
   *   counts: {total: number, active: number, candidates: number, rejected: number, superseded: number},
   *   candidates: Array<Record<string, unknown>>}}
   */
  list(options = {}) {
    const input = isPlainObject(options) ? options : {}
    const status = input.status === undefined || input.status === null ? 'all' : input.status
    if (status !== 'all' && !PATTERN_STATUSES.includes(status)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid pattern status: ${String(input.status)}`)
    }
    const category = input.category
    if (category !== undefined && category !== null && !PATTERN_CATEGORIES.includes(category)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid pattern category: ${String(input.category)}`)
    }
    let query = ''
    if (input.query !== undefined && input.query !== null) {
      if (typeof input.query !== 'string') {
        throw new ConfluenceError('BAD_ARGUMENT', 'pattern query must be a string')
      }
      query = truncateChars(input.query.trim().toLowerCase(), PATTERN_MAX_QUERY_CHARS)
    }
    let limit = null
    if (input.limit !== undefined && input.limit !== null) {
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1) {
        throw new ConfluenceError('BAD_ARGUMENT', 'pattern limit must be a positive integer')
      }
      limit = Math.min(input.limit, PATTERN_MAX_LIST_LIMIT)
    }
    const effectiveCategory = category === undefined || category === null ? null : category
    /** @param {Record<string, any>} pattern */
    const matches = (pattern) => {
      if (effectiveCategory !== null && pattern.category !== effectiveCategory) return false
      if (query === '') return true
      const haystack = `${pattern.key}\n${pattern.title}\n${pattern.body}\n${pattern.tags.join(' ')}`.toLowerCase()
      return haystack.includes(query)
    }
    const all = [...this._fold.byKey.values()]
    let patterns =
      status === 'all' ? all.filter(matches) : all.filter((pattern) => pattern.status === status).filter(matches)
    patterns = patterns.sort(compareListOrder)
    if (limit !== null) patterns = patterns.slice(0, limit)
    const candidates = this._fold.candidates.filter(matches).map(publicPattern)
    return {
      revision: this._revision,
      patterns: patterns.map(publicPattern),
      count: patterns.length,
      counts: { ...this._fold.counts },
      candidates,
    }
  }

  /**
   * Active patterns relevant to one workspace: every global pattern plus the
   * workspace-scoped patterns whose `workspaceKey` matches. Sorted confidence
   * desc then seq desc (§3.2). Synchronous and exception-safe (never throws).
   *
   * @param {string} [workspaceKey]
   * @returns {Array<Record<string, unknown>>}
   */
  activeFor(workspaceKey) {
    try {
      const key = typeof workspaceKey === 'string' ? workspaceKey : ''
      const selected = this._fold.active.filter(
        (pattern) => pattern.scope === 'global' || (pattern.scope === 'workspace' && key !== '' && pattern.workspaceKey === key),
      )
      return selected.sort(compareByConfidence).map(publicPattern)
    } catch (error) {
      this.logger.warn({ event: 'memory.active_for_failed', message: error?.message ?? String(error) })
      return []
    }
  }

  /**
   * Number of patterns waiting for confirmation. Synchronous; never throws.
   *
   * @returns {number}
   */
  pendingCount() {
    try {
      return this._fold.counts.candidates
    } catch {
      return 0
    }
  }

  /**
   * Propose a NEW pattern: always writes `status:'candidate'` (owner decision,
   * ADR-0009 §2). The stable key is either supplied or derived from the title.
   * A key that already exists is refused (use `update`/`promote`) so an active
   * rule can never be silently demoted to a candidate.
   *
   * @param {{key?: string, category: string, title: string, body: string, tags?: string[],
   *   scope?: string, workspaceKey?: string, workspaceLabel?: string, confidence?: number,
   *   evidence?: Array<{sessionId?: string, note?: string}>, author?: object}} input
   * @returns {Promise<{key: string, status: string, seq: string, pattern: Record<string, unknown>}>}
   */
  async add(input = {}) {
    const prepared = this._preparePatternInput(input, { status: 'candidate', source: 'agent' })
    await this._ensureJournal()
    if (this._fold.byKey.has(prepared.key)) {
      throw new ConfluenceError(
        'BAD_ARGUMENT',
        `pattern already exists: ${prepared.key} (use update to change it or promote to activate it)`,
      )
    }
    this._assertPatternCapacity(undefined)
    const stored = await this._append(this._patternRecord(prepared))
    return this._writeResult(stored)
  }

  /**
   * Confirm a candidate: writes the same content as `active`. Already-active
   * patterns are not rewritten.
   *
   * @param {{key?: string, author?: object}} [input]
   * @returns {Promise<{key: string, status: string, seq: string, pattern: Record<string, unknown>}>}
   */
  async promote(input = {}) {
    return await this._setStatus(input, 'active')
  }

  /**
   * Reject a candidate: writes the same content as `rejected`.
   *
   * @param {{key?: string, author?: object}} [input]
   * @returns {Promise<{key: string, status: string, seq: string, pattern: Record<string, unknown>}>}
   */
  async reject(input = {}) {
    return await this._setStatus(input, 'rejected')
  }

  /**
   * Forget a pattern (`rejected`, append-only: the record stays on disk but is
   * never injected again).
   *
   * @param {{key?: string, author?: object}} [input]
   * @returns {Promise<{key: string, status: string, seq: string, pattern: Record<string, unknown>}>}
   */
  async forget(input = {}) {
    return await this._setStatus(input, 'rejected')
  }

  /**
   * Update the content of an existing pattern with the same stable key; the
   * current status is preserved (§2.1).
   *
   * @param {{key?: string, title?: string, body?: string, tags?: string[], confidence?: number, author?: object}} [input]
   * @returns {Promise<{key: string, status: string, seq: string, pattern: Record<string, unknown>}>}
   */
  async update(input = {}) {
    const options = isPlainObject(input) ? input : {}
    const key = this._requireKey(options.key)
    await this._ensureJournal()
    const existing = this._fold.byKey.get(key)
    if (existing === undefined) throw new ConfluenceError('NOT_FOUND', `pattern not found: ${key}`)
    const fields = contentFieldsOf(existing)
    let changed = false
    if (options.title !== undefined) {
      fields.title = this._prepareTitle(options.title, `pattern ${key} title`)
      changed = true
    }
    if (options.body !== undefined) {
      fields.body = this._prepareBody(options.body, `pattern ${key} body`)
      changed = true
    }
    if (options.tags !== undefined) {
      fields.tags = this._prepareTags(options.tags)
      changed = true
    }
    if (options.confidence !== undefined) {
      fields.confidence = this._prepareConfidence(options.confidence, existing.confidence)
      changed = true
    }
    if (!changed) return { key, status: existing.status, seq: existing.seq, pattern: publicPattern(existing) }
    const author = sanitizeAuthor(options.author)
    const stored = await this._append(
      this._patternRecord({ ...fields, status: existing.status, author: author ?? existing.author }),
    )
    return this._writeResult(stored)
  }

  /**
   * Portability write path (used by `confluence_memory import`): write one
   * `active` pattern with `source:'import'`. Unlike `add`, an existing key is
   * updated (imports win in a merge, ADR-0009 §4) and the status is active.
   *
   * @param {object} entry same fields as `add`
   * @returns {Promise<{key: string, status: string, seq: string, pattern: Record<string, unknown>}>}
   */
  async importPattern(entry = {}) {
    const prepared = this._preparePatternInput(entry, { status: 'active', source: 'import' })
    await this._ensureJournal()
    this._assertPatternCapacity(this._fold.byKey.get(prepared.key))
    const stored = await this._append(this._patternRecord(prepared))
    return this._writeResult(stored)
  }

  /**
   * Synchronous, deterministic, bounded long-term-memory prompt block (§3.2), or
   * '' when disabled/empty. Reads only the in-memory fold; never throws.
   *
   * @param {{workspaceKey?: string}} [options]
   * @returns {string}
   */
  renderBlock(options = {}) {
    try {
      const config = this._cfg
      if (!config.enabled || !config.inject) return ''
      const input = isPlainObject(options) ? options : {}
      const candidates = this._fold.candidates
      const pool = this.activeFor(input.workspaceKey)
      let selected = pool.slice(0, config.maxInjectPatterns)
      while (true) {
        const candidateLine = renderCandidateLine(candidates)
        /** @type {string[]} */
        const body = []
        if (selected.length > 0) {
          body.push(PATTERN_BLOCK_INTRO)
          for (const pattern of selected) body.push(renderPatternLine(pattern))
        }
        if (candidateLine !== '') body.push(candidateLine)
        if (body.length === 0) return ''
        const header = `${PATTERN_BLOCK_OPEN} count="${selected.length}" candidates="${candidates.length}">`
        const text = [header, ...body, PATTERN_BLOCK_CLOSE].join('\n')
        if (countCodePoints(text) <= config.maxInjectChars) return text
        // Deterministic degradation: drop the least important active rule first;
        // a lone candidate headline that cannot fit renders nothing.
        if (selected.length > 0) {
          selected = selected.slice(0, selected.length - 1)
          continue
        }
        return ''
      }
    } catch (error) {
      this.logger.warn({ event: 'memory.render_failed', message: error?.message ?? String(error) })
      return ''
    }
  }

  // -------------------------------------------------------------------------
  // writes — one append-only `pattern` record per change
  // -------------------------------------------------------------------------

  /**
   * Append one pattern record built from prepared fields (the caller owns the id
   * and status semantics; the same helper serves candidate/active/rejected).
   *
   * @param {Record<string, any>} fields
   * @returns {Record<string, unknown>}
   */
  _patternRecord(fields) {
    /** @type {Record<string, unknown>} */
    const record = {
      type: 'pattern',
      id: `${PATTERN_ID_PREFIX}${this._ulid()}`,
      key: fields.key,
      category: fields.category,
      title: fields.title,
      body: fields.body,
      tags: [...fields.tags],
      scope: fields.scope,
      status: fields.status,
      confidence: fields.confidence,
      source: fields.source,
    }
    if (fields.scope === 'workspace') {
      record.workspaceKey = fields.workspaceKey
      if (fields.workspaceLabel !== '') record.workspaceLabel = fields.workspaceLabel
    }
    if (Array.isArray(fields.evidence) && fields.evidence.length > 0) record.evidence = fields.evidence
    if (fields.author !== null && fields.author !== undefined) record.author = fields.author
    return record
  }

  /**
   * Common status transition (`promote`/`reject`/`forget`). A no-op when the
   * pattern is already in the target status.
   *
   * @param {unknown} input
   * @param {string} status target status
   * @returns {Promise<{key: string, status: string, seq: string, pattern: Record<string, unknown>}>}
   */
  async _setStatus(input, status) {
    const options = isPlainObject(input) ? input : {}
    const key = this._requireKey(options.key)
    await this._ensureJournal()
    const existing = this._fold.byKey.get(key)
    if (existing === undefined) throw new ConfluenceError('NOT_FOUND', `pattern not found: ${key}`)
    if (existing.status === status) {
      return { key, status, seq: existing.seq, pattern: publicPattern(existing) }
    }
    const author = sanitizeAuthor(options.author)
    const fields = contentFieldsOf(existing)
    const stored = await this._append(this._patternRecord({ ...fields, status, author: author ?? existing.author }))
    return this._writeResult(stored)
  }

  /** @param {Record<string, unknown>} stored @returns {{key: string, status: string, seq: string, pattern: Record<string, unknown>}} */
  _writeResult(stored) {
    const pattern = patternFromRecord(stored)
    if (pattern === null) {
      throw new ConfluenceError('STORE_UNAVAILABLE', 'the written pattern could not be read back')
    }
    return { key: pattern.key, status: pattern.status, seq: pattern.seq, pattern: publicPattern(pattern) }
  }

  /**
   * Enforce `memory.maxPatterns` live patterns (candidate+active). A write that
   * does not change a pattern's liveness (update of a live pattern) is free.
   *
   * @param {Record<string, any> | undefined} existing current folded pattern for the key
   */
  _assertPatternCapacity(existing) {
    const live = this._fold.counts.active + this._fold.counts.candidates
    const becomesLive = existing === undefined || (existing.status !== 'active' && existing.status !== 'candidate')
    if (becomesLive && live >= this._cfg.maxPatterns) {
      throw new ConfluenceError(
        'LIMIT_EXCEEDED',
        `pattern cap reached (config.memory.maxPatterns=${this._cfg.maxPatterns})`,
      )
    }
  }

  /**
   * Validate + redact one pattern input for `add`/`importPattern`/migration.
   *
   * @param {unknown} input
   * @param {{status: string, source: string}} options
   * @returns {Record<string, any>}
   */
  _preparePatternInput(input, { status, source }) {
    if (!isPlainObject(input)) {
      throw new ConfluenceError('BAD_ARGUMENT', 'pattern input must be an object')
    }
    const title = this._prepareTitle(input.title, 'pattern title')
    const body = this._prepareBody(input.body, 'pattern body')
    const category = input.category
    if (typeof category !== 'string' || !PATTERN_CATEGORIES.includes(category)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid pattern category: ${String(input.category)}`)
    }
    let key
    if (input.key === undefined || input.key === null || input.key === '') {
      key = derivePatternKey(title)
    } else {
      if (typeof input.key !== 'string' || !PATTERN_KEY_RE.test(input.key)) {
        throw new ConfluenceError('BAD_ARGUMENT', `invalid pattern key: ${String(input.key)}`)
      }
      key = input.key
    }
    const tags = this._prepareTags(input.tags)
    let scope = input.scope === undefined || input.scope === null ? 'global' : input.scope
    if (!PATTERN_SCOPES.includes(scope)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid pattern scope: ${String(input.scope)}`)
    }
    /** @type {string | null} */
    let workspaceKey = null
    let workspaceLabel = ''
    if (scope === 'workspace') {
      if (typeof input.workspaceKey !== 'string' || !WS_KEY_PATTERN.test(input.workspaceKey)) {
        // Portability leniency: a document exported before the workspaceKey
        // field existed may only carry a label. Import it as a global pattern
        // instead of failing the whole import (the fold stays valid/bounded).
        if (source === 'import') scope = 'global'
        else {
          throw new ConfluenceError(
            'BAD_ARGUMENT',
            'a workspace-scoped pattern requires a valid workspaceKey (ws_<16hex>)',
          )
        }
      } else {
        workspaceKey = input.workspaceKey
        if (input.workspaceLabel !== undefined && input.workspaceLabel !== null) {
          workspaceLabel = this._prepareTitle(input.workspaceLabel, 'pattern workspaceLabel')
        }
      }
    }
    const confidence =
      input.confidence === undefined || input.confidence === null
        ? this._cfg.candidateConfidence
        : this._prepareConfidence(input.confidence, this._cfg.candidateConfidence)
    return {
      key,
      category,
      title,
      body,
      tags,
      scope,
      workspaceKey,
      workspaceLabel,
      confidence,
      status,
      source,
      evidence: this._prepareEvidence(input.evidence),
      author: sanitizeAuthor(input.author),
    }
  }

  /**
   * Validate + redact a non-empty one-line title (≤120 chars after path
   * stripping), or fail `REDACTED` when nothing usable remains.
   *
   * @param {unknown} raw
   * @param {string} label diagnostics label
   * @returns {string}
   */
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
    const clipped = truncateChars(stripAbsolutePathsText(normalized), PATTERN_MAX_TITLE_CHARS).trim()
    if (clipped === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
    return clipped
  }

  /**
   * Validate + redact a non-empty body (≤2048 bytes after redaction). A body
   * over the cap fails `BODY_TOO_LARGE` rather than being silently truncated.
   *
   * @param {unknown} raw
   * @param {string} label diagnostics label
   * @returns {string}
   */
  _prepareBody(raw, label) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ConfluenceError('BAD_ARGUMENT', `${label} must be a non-empty string`)
    }
    const redacted = this._redactText(raw, label)
    const trimmed = redacted.trim()
    if (trimmed === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
    if (Buffer.byteLength(trimmed, 'utf8') > PATTERN_MAX_BODY_BYTES) {
      throw new ConfluenceError(
        'BODY_TOO_LARGE',
        `${label} exceeds the ${PATTERN_MAX_BODY_BYTES}-byte pattern body cap`,
      )
    }
    return trimmed
  }

  /**
   * Normalise tags through the redactor (≤8 validated lowercase labels).
   *
   * @param {unknown} tags
   * @returns {string[]}
   */
  _prepareTags(tags) {
    if (tags === undefined || tags === null) return []
    const redactor = this.redactor
    if (redactor && typeof redactor.tags === 'function') {
      try {
        const normalized = redactor.tags(tags)
        if (Array.isArray(normalized)) return normalized.slice(0, PATTERN_MAX_TAGS)
      } catch {
        // fall through to the local normaliser
      }
    }
    return storedTags(tags)
  }

  /**
   * Validate + redact evidence metadata (≤3 entries, metadata only).
   *
   * @param {unknown} evidence
   * @returns {Array<{sessionId?: string, note?: string}>}
   */
  _prepareEvidence(evidence) {
    if (evidence === undefined || evidence === null) return []
    if (!Array.isArray(evidence)) throw new ConfluenceError('BAD_ARGUMENT', 'pattern evidence must be an array')
    const out = []
    for (const item of evidence) {
      if (!isPlainObject(item)) continue
      /** @type {{sessionId?: string, note?: string}} */
      const entry = {}
      const sessionId = asString(item.sessionId).trim()
      if (sessionId !== '') entry.sessionId = truncateChars(sessionId, AUTHOR_SESSION_CHARS)
      if (typeof item.note === 'string' && item.note.trim() !== '') {
        const note = this._redactText(item.note, 'pattern evidence note')
        entry.note = truncateChars(singleLineText(note), PATTERN_MAX_EVIDENCE_NOTE_CHARS)
      }
      if (Object.keys(entry).length === 0) continue
      out.push(entry)
      if (out.length >= PATTERN_MAX_EVIDENCE) break
    }
    return out
  }

  /** @param {unknown} value @returns {number} validated confidence in [0,1] */
  _prepareConfidence(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new ConfluenceError('BAD_ARGUMENT', 'pattern confidence must be a number in [0,1]')
    }
    return value
  }

  /** @param {string} label @returns {object} */
  _requireRedactor(label) {
    const redactor = this.redactor
    if (!redactor || typeof redactor.text !== 'function') {
      throw new ConfluenceError('UNAVAILABLE', `memory writes require the configured redactor (${label})`)
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

  /** @param {unknown} value @returns {string} validated stable pattern key */
  _requireKey(value) {
    if (typeof value !== 'string' || !PATTERN_KEY_RE.test(value)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid pattern key: ${String(value)}`)
    }
    return value
  }

  // -------------------------------------------------------------------------
  // v0.3 → v0.4 migration (§5)
  // -------------------------------------------------------------------------

  /**
   * One-time migration (idempotent, best effort, append-only):
   * `tech` → category `project`, `context` → category `domain`, key
   * `migrated.<section>.<sanitized-key>`, title = original key, body = value,
   * active global pattern with `source:'migration'`. A `memory-migration`
   * marker is appended once the migration ran; existing keys are never
   * rewritten (they are skipped), and `memory.maxPatterns` is respected.
   *
   * @returns {Promise<boolean>} whether a migration ran in this call
   */
  async _runMigration() {
    if (this._journal === null || this._migrationApplied) return false
    const records = this._readRecords()
    if (hasMigrationMarker(records)) {
      this._migrationApplied = true
      return false
    }
    const facts = legacyProfileFacts(records)
    if (facts.length === 0) return false
    const existingKeys = new Set(this._fold.byKey.keys())
    const used = new Set(existingKeys)
    const live = this._fold.counts.active + this._fold.counts.candidates
    let capacity = Math.max(0, this._cfg.maxPatterns - live)
    let written = 0
    let skipped = 0
    for (const fact of facts) {
      if (capacity <= 0) {
        skipped += 1
        continue
      }
      const baseKey = migratedKeyBase(fact.section, fact.key)
      if (existingKeys.has(baseKey)) {
        // Never rewrite an existing pattern (a user/agent pattern wins).
        skipped += 1
        continue
      }
      const key = uniqueMigratedKey(baseKey, used)
      const record = this._migrationRecord(fact, key)
      if (record === null) {
        skipped += 1
        continue
      }
      await this._append(record)
      written += 1
      capacity -= 1
    }
    await this._append({
      type: 'memory-migration',
      id: `${MEMORY_MIGRATION_ID_PREFIX}${this._ulid()}`,
      version: MEMORY_MIGRATION_VERSION,
      source: MEMORY_MIGRATION_SOURCE,
    })
    this._migrationApplied = true
    this.logger.info({
      event: 'memory.migration_applied',
      facts: facts.length,
      patterns: written,
      skipped,
    })
    return true
  }

  /**
   * Build one migrated pattern record, or null when the legacy fact cannot be
   * stored (empty after redaction / over the caps). Best effort by contract.
   *
   * @param {{section: string, key: string, value: string, confidence: number, sessionId: string}} fact
   * @param {string} key
   * @returns {Record<string, unknown> | null}
   */
  _migrationRecord(fact, key) {
    let title
    try {
      title = this._prepareTitle(fact.key, 'migrated pattern title')
    } catch {
      title = truncateChars(singleLineText(fact.key), PATTERN_MAX_TITLE_CHARS)
    }
    let body
    try {
      body = this._prepareBody(fact.value, 'migrated pattern body')
    } catch (error) {
      this.logger.debug({ event: 'memory.migration_fact_skipped', key, message: error?.message })
      return null
    }
    if (title === '') title = key
    const author = fact.sessionId === '' ? null : { sessionId: fact.sessionId }
    return this._patternRecord({
      key,
      category: MEMORY_LEGACY_SECTION_CATEGORIES[/** @type {keyof typeof MEMORY_LEGACY_SECTION_CATEGORIES} */ (fact.section)],
      title,
      body,
      tags: [],
      scope: 'global',
      workspaceKey: null,
      workspaceLabel: '',
      status: 'active',
      confidence: fact.confidence,
      source: 'migration',
      evidence: author === null ? [] : [author],
      author,
    })
  }

  // -------------------------------------------------------------------------
  // journal plumbing (mirrors ProfileService; read paths never throw)
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
        this.logger.warn({ event: 'memory.attach_open_failed', message: error?.message ?? String(error) })
        return null
      }
    }
    if (typeof this.store.refreshMerged === 'function') {
      try {
        // v0.3 stores take the scope key; a v0.2 signature ignores it (tolerated).
        await this.store.refreshMerged(GLOBAL_SCOPE_KEY)
      } catch (error) {
        this.logger.warn({ event: 'memory.attach_refresh_failed', message: error?.message ?? String(error) })
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
    this._fold = foldPatterns(records)
    this._revision = memoryRevision(records)
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
   * Append one record to the global journal (append-only, never a file rewrite)
   * and refresh the fold. `appendAndSync` is preferred so a write is durable
   * before the caller claims success.
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
      throw new ConfluenceError('STORE_UNAVAILABLE', `memory write failed: ${error?.message ?? error}`, {
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
    throw new ConfluenceError('STORE_UNAVAILABLE', 'the global journal is unavailable; cannot write memory records')
  }
}
