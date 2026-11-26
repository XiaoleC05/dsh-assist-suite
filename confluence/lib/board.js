// Confluence / 高级记忆 — workspace note board: records, folds, posting, threads and search.
//
// v0.3.0 (ADR-0008): notes are WORKSPACE-scoped. Every session whose frozen
// workspace key matches writes and reads the same journal under
// `workspaces/<wsKey>/`; another workspace's notes never appear here. The
// storage abstraction stays `lib/store.js` (per-scope journals and views).
// The note record/fold rules are unchanged from v0.1/v0.2:
// docs/design/data-model.md §4 (shapes), §5 (derived status/threads), §6 (caps),
// §7 (merge/order), §8 (validation). Binding contract for the scoped API:
// docs/plan/v0.3-interfaces.md §3.2.
//
// Everything here is plain ESM with Node builtins only, no network, no child process, no
// @deepseek-ai imports. The board never mutates a stored entry: it is append-only. Derived state
// (statuses, threads, stats) is a pure function of the per-workspace record set (`foldRecords`).
//
// Freshness: `view(wsKey)` synchronously folds `store.viewedRecords(wsKey)`. The store invalidates
// that per-scope cache from the journal change feed, and this service also subscribes per scope;
// a cached fold is keyed on the identity of the record list so a swapped list is always picked up.
// A reader never throws on stored data.
//
// Tombstones are not created by the tool surface (no delete tool); the reader honours them for
// export compatibility and fixtures, accepting both the interface shape (`target`) and the
// data-model shape (`targetId`).

import {
  ConfluenceError,
  createUlidFactory,
  isUlid,
  truncateChars,
  truncateUtf8,
} from './util.js'

/**
 * Reserved key of the global memory scope (v0.3 §1). The board writes only to a
 * real workspace journal; the constant stays exported for callers that still
 * import the scope vocabulary from this module. Never a real workspace key.
 * @type {string}
 */
export const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'

const WS_KEY_PATTERN = /^ws_[0-9a-f]{16}$/
const EMPTY_RECORDS = Object.freeze([])

/** Closed write-time kind vocabulary (data-model §3). */
export const KINDS = Object.freeze([
  'finding',
  'decision',
  'gotcha',
  'question',
  'handoff',
  'warning',
])
const KIND_SET = new Set(KINDS)
const ROOT_RESOLVABLE = new Set(['question', 'handoff'])

/** data-model §6 constants enforced by the writer. */
const MAX_TITLE_CHARS = 160
const MAX_TAGS = 8
const MAX_TAG_CHARS = 32
const MAX_FILES = 8
const MAX_PATH_CHARS = 240
const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_MAX_BODY_BYTES = 8192

/** Search ranking weights (title 3, tags 2, body 1). */
const WEIGHT_TITLE = 3
const WEIGHT_TAGS = 2
const WEIGHT_BODY = 1
const SEARCH_MAX_LIMIT = 10
const SEARCH_DEFAULT_LIMIT = 5
const SNIPPET_MAX_CHARS = 200

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

/** @param {unknown} value @returns {number} */
function asFiniteNumber(value, fallback = 0) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

/**
 * @param {unknown} value raw config value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number} clamped integer (config.resolveConfig already clamps; defence in depth)
 */
function clampInt(value, fallback, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(asFiniteNumber(value, fallback))))
}

/**
 * Normalise the optional workspace metadata passed to `store.openWorkspace`.
 * Only the two documented keys survive; an empty block becomes `undefined` so
 * an existing manifest is opened without side effects.
 *
 * @param {unknown} meta
 * @returns {{canonicalPath?: string, label?: string} | undefined}
 */
function normalizeWorkspaceMeta(meta) {
  if (!isPlainObject(meta)) return undefined
  const out = {}
  if (typeof meta.canonicalPath === 'string' && meta.canonicalPath !== '') out.canonicalPath = meta.canonicalPath
  if (typeof meta.label === 'string' && meta.label !== '') out.label = meta.label
  return Object.keys(out).length > 0 ? out : undefined
}

/** @param {unknown} value @param {number} maxItems @param {number} maxItemChars @returns {string[] | undefined} */
function clampStringArray(value, maxItems, maxItemChars) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) continue
    out.push(truncateChars(item, maxItemChars))
    if (out.length >= maxItems) break
  }
  return out.length > 0 ? out : undefined
}

/** @param {string} code @param {string} message @param {{cause?: unknown}} [options] @returns {ConfluenceError} */
function boardError(code, message, options) {
  return new ConfluenceError(code, message, options)
}

/**
 * Reduce an untrusted provenance label to a basename-ish display label. Labels are never paths
 * (data-model privacy rule; delta §0): separators are dropped, `.`/`..` segments removed.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function sanitizeLabel(value) {
  if (typeof value !== 'string') return undefined
  const segments = value
    .trim()
    .split(/[\\/]+/u)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  const last = segments.length > 0 ? segments[segments.length - 1] : ''
  const label = truncateChars(last.trim(), MAX_TITLE_CHARS).trim()
  return label.length > 0 ? label : undefined
}

/**
 * Normalise an untrusted `origin` provenance block. Only a reserved-shape workspace key and a
 * basename-only label survive; everything else is dropped (provenance is optional, never blocking).
 * @param {unknown} raw
 * @returns {{workspaceKey?: string, workspaceLabel?: string} | undefined}
 */
function normalizeOrigin(raw) {
  if (!isPlainObject(raw)) return undefined
  const workspaceKey =
    typeof raw.workspaceKey === 'string' && WS_KEY_PATTERN.test(raw.workspaceKey) ? raw.workspaceKey : undefined
  const workspaceLabel = sanitizeLabel(raw.workspaceLabel)
  if (workspaceKey === undefined && workspaceLabel === undefined) return undefined
  const origin = {}
  if (workspaceKey !== undefined) origin.workspaceKey = workspaceKey
  if (workspaceLabel !== undefined) origin.workspaceLabel = workspaceLabel
  return origin
}

/**
 * Provenance for a reused v0.1 record: the old journal only knows its `ws` key,
 * so the label comes from the store's cold workspace-manifest scan. Best effort:
 * no label means no origin block.
 * @param {Record<string, unknown>} record
 * @param {Map<string, string> | null | undefined} legacyLabels
 * @returns {{workspaceKey?: string, workspaceLabel?: string} | undefined}
 */
function legacyOriginFor(record, legacyLabels) {
  if (!(legacyLabels instanceof Map)) return undefined
  const ws = asString(record.ws)
  if (!WS_KEY_PATTERN.test(ws) || ws === GLOBAL_SCOPE_KEY) return undefined
  const label = sanitizeLabel(legacyLabels.get(ws))
  if (label === undefined) return undefined
  return { workspaceKey: ws, workspaceLabel: label }
}

/**
 * Normalise the author block of an entry: `{ sessionId, title?, origin }` (interface §6).
 * Flat data-model fields are accepted on read for tolerance (older/hand-written records); the
 * record-level `origin` provenance object must never be mistaken for the author's `agent|user`.
 * @param {unknown} raw
 * @returns {{ sessionId: string, title?: string, origin: 'agent' | 'user' }}
 */
function normalizeAuthor(raw) {
  if (!isPlainObject(raw)) return { sessionId: '', origin: 'agent' }
  const sessionId = asString(raw.sessionId ?? raw.authorSessionId)
  const title = typeof raw.title === 'string' ? raw.title : undefined
  const origin = raw.origin === 'user' ? 'user' : 'agent'
  return title === undefined ? { sessionId, origin } : { sessionId, title, origin }
}

/**
 * Normalise one stored `entry` record for the derived view. Reader-side clamping only
 * (data-model §8.2); the original record object is never mutated.
 * @param {Record<string, unknown>} record
 * @param {Map<string, string> | null | undefined} legacyLabels
 * @returns {Record<string, unknown>}
 */
function normalizeEntry(record, legacyLabels) {
  let origin = normalizeOrigin(record.origin)
  const legacyOrigin = legacyOriginFor(record, legacyLabels)
  if (legacyOrigin !== undefined) {
    if (origin === undefined) origin = legacyOrigin
    else if (origin.workspaceLabel === undefined) origin = { ...origin, workspaceLabel: legacyOrigin.workspaceLabel }
  }
  const flatOrigin =
    record.origin === 'agent' || record.origin === 'user' ? record.origin : undefined
  const entry = {
    ...record,
    title: truncateChars(asString(record.title), MAX_TITLE_CHARS),
    author: normalizeAuthor(
      isPlainObject(record.author)
        ? record.author
        : {
            sessionId: record.sessionId,
            title: record.sessionTitle,
            origin: flatOrigin,
          },
    ),
  }
  if (origin !== undefined) entry.origin = origin
  else delete entry.origin
  if (record.body !== undefined) entry.body = truncateUtf8(asString(record.body), DEFAULT_MAX_BODY_BYTES)
  else delete entry.body
  if (record.tags !== undefined) {
    const tags = clampStringArray(record.tags, MAX_TAGS, MAX_TAG_CHARS)
    if (tags === undefined) delete entry.tags
    else entry.tags = tags
  }
  if (record.files !== undefined) {
    const files = clampStringArray(record.files, MAX_FILES, MAX_PATH_CHARS)
    if (files === undefined) delete entry.files
    else entry.files = files
  }
  if (typeof record.replyTo === 'string' && record.replyTo.length > 0) entry.replyTo = record.replyTo
  else delete entry.replyTo
  if (typeof record.resolves === 'boolean') entry.resolves = record.resolves
  else delete entry.resolves
  if (typeof record.supersedes === 'string' && record.supersedes.length > 0) entry.supersedes = record.supersedes
  else delete entry.supersedes
  return entry
}

/**
 * Normalise one stored `session` ledger record for the derived view. No content fields exist on
 * these rows by design (metadata only). Provenance (`origin`) passes through untouched here; the
 * ledger owns its shape.
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
function normalizeSession(record) {
  const sessionId = asString(record.sessionId ?? record.id)
  const row = {
    ...record,
    sessionId,
    status: record.status === 'live' || record.status === 'idle' ? record.status : 'idle',
    turns: Math.max(0, Math.trunc(asFiniteNumber(record.turns, 0))),
  }
  if (typeof record.title === 'string') row.title = truncateChars(record.title, MAX_TITLE_CHARS)
  else delete row.title
  if (typeof record.lastActivityTs === 'string') row.lastActivityTs = record.lastActivityTs
  else delete row.lastActivityTs
  if (typeof record.effectiveDir === 'string') row.effectiveDir = record.effectiveDir
  else delete row.effectiveDir
  const files = clampStringArray(record.files, MAX_FILES, MAX_PATH_CHARS)
  if (files === undefined) delete row.files
  else row.files = files
  return row
}

/**
 * Validate the parts of a record envelope that make it usable for the fold. Invalid lines are
 * skipped (data-model §8.2: a reader never throws on stored data); `v: 2` and unknown types are
 * skipped as unsupported. Any workspace key is accepted: the global view merges every journal.
 * @param {unknown} record
 * @returns {record is Record<string, unknown>}
 */
function isFoldableRecord(record) {
  if (!isPlainObject(record)) return false
  if (record.v !== 1) return false
  if (typeof record.type !== 'string') return false
  if (typeof record.ws !== 'string' || record.ws.length === 0) return false
  if (!isUlid(record.seq)) return false
  return record.type === 'entry' || record.type === 'tombstone' || record.type === 'session'
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {number} */
function compareRecords(a, b) {
  const seqA = asString(a.seq)
  const seqB = asString(b.seq)
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = asString(a.id)
  const idB = asString(b.id)
  if (idA !== idB) return idA < idB ? -1 : 1
  const typeA = asString(a.type)
  const typeB = asString(b.type)
  return typeA === typeB ? 0 : typeA < typeB ? -1 : 1
}

/** @param {Record<string, unknown> | undefined} entry @returns {string} */
function statusOf(entry) {
  return entry && typeof entry.status === 'string' ? entry.status : 'active'
}

/**
 * Pure merge/derive fold over journal records (data-model §7.1, §5). Returns the
 * BoardView used by every synchronous read path and by the pulse. Never throws
 * on malformed input. It never filters on a workspace key: the caller passes the
 * records of exactly one scope (the store's per-scope view), so cross-workspace
 * isolation is a storage guarantee, not a fold rule.
 *
 * - entries: first occurrence of an id wins after the global `seq` sort (immutable facts);
 * - tombstones: union by target, hiding the target and its thread at read time;
 * - sessions: last-wins per session id (ledger upsert stream);
 * - provenance: stored `origin` is sanitised; a reused v0.1 record may derive
 *   `origin.workspaceLabel` from `legacyLabels.get(record.ws)`; unknown types /
 *   v:2 / invalid envelopes are skipped.
 *
 * @param {readonly unknown[]} records
 * @param {Map<string, string> | null} [legacyLabels] `wsKey -> label` for reused v0.1 records
 * @returns {{
 *   entries: Map<string, Record<string, unknown>>,
 *   roots: Array<Record<string, unknown>>,
 *   sessions: Map<string, Record<string, unknown>>,
 *   openQuestions: Array<Record<string, unknown>>,
 *   openHandoffs: Array<Record<string, unknown>>,
 *   questions: Array<Record<string, unknown>>,
 *   handoffs: Array<Record<string, unknown>>,
 *   stats: { entries: number, openQuestions: number, openHandoffs: number, byKind: Record<string, number> },
 *   maxSeq: string,
 *   entryCount: number,
 *   tombstones: Map<string, Record<string, unknown>>,
 *   hiddenEntries: Map<string, Record<string, unknown>>,
 * }}
 */
export function foldRecords(records, legacyLabels) {
  const labels = legacyLabels instanceof Map ? legacyLabels : null
  const valid = []
  if (Array.isArray(records)) {
    for (const record of records) if (isFoldableRecord(record)) valid.push(record)
  }
  valid.sort(compareRecords)

  /** @type {Map<string, Record<string, unknown>>} */
  const entriesById = new Map()
  /** @type {Map<string, Record<string, unknown>>} */
  const tombstones = new Map()
  /** @type {Map<string, Record<string, unknown>>} */
  const sessions = new Map()

  for (const record of valid) {
    if (record.type === 'entry') {
      const id = asString(record.id)
      if (id.length === 0) continue
      if (!entriesById.has(id)) entriesById.set(id, normalizeEntry(record, labels))
    } else if (record.type === 'tombstone') {
      const target = asString(record.target ?? record.targetId)
      if (target.length === 0) continue
      if (!tombstones.has(target)) tombstones.set(target, { id: record.id, seq: record.seq, target })
    } else if (record.type === 'session') {
      const key = asString(record.sessionId ?? record.id)
      if (key.length === 0) continue
      sessions.set(key, normalizeSession(record))
    }
  }

  // Tombstones cascade: a hidden root hides every reply whose `replyTo` chain reaches it
  // (threads are one level in v1, so one pass over the sorted entries suffices; the loop keeps
  // the rule correct even for hand-written multi-level data).
  const hidden = new Set(tombstones.keys())
  let changed = true
  while (changed) {
    changed = false
    for (const [id, entry] of entriesById) {
      if (hidden.has(id)) continue
      const parent = asString(entry.replyTo)
      if (parent.length > 0 && hidden.has(parent)) {
        hidden.add(id)
        changed = true
      }
    }
  }

  const hiddenEntries = new Map()
  for (const id of hidden) {
    const entry = entriesById.get(id)
    if (entry !== undefined) hiddenEntries.set(id, entry)
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const visible = new Map()
  for (const [id, entry] of entriesById) if (!hidden.has(id)) visible.set(id, entry)

  // Replies grouped by their root (one level; replies to replies were re-targeted by the writer).
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const repliesByRoot = new Map()
  const supersededTargets = new Set()
  for (const entry of visible.values()) {
    const replyTo = asString(entry.replyTo)
    if (replyTo.length > 0) {
      const replies = repliesByRoot.get(replyTo)
      if (replies === undefined) repliesByRoot.set(replyTo, [entry])
      else replies.push(entry)
    }
    const supersedes = asString(entry.supersedes)
    if (supersedes.length > 0 && visible.has(supersedes)) supersededTargets.add(supersedes)
  }

  /** @param {Record<string, unknown>} entry @returns {string} */
  function deriveStatus(entry) {
    const id = asString(entry.id)
    const replyTo = asString(entry.replyTo)
    if (replyTo.length > 0) return supersededTargets.has(id) ? 'superseded' : 'active'
    const kind = asString(entry.kind)
    if (ROOT_RESOLVABLE.has(kind)) {
      const replies = repliesByRoot.get(id) ?? []
      let marker
      for (const reply of replies) {
        if (typeof reply.resolves !== 'boolean') continue
        if (marker === undefined || asString(reply.seq) > asString(marker.seq)) marker = reply
      }
      if (marker !== undefined) return marker.resolves === true ? 'resolved' : 'open'
      return 'open'
    }
    return supersededTargets.has(id) ? 'superseded' : 'active'
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const entries = new Map()
  for (const [id, entry] of visible) entries.set(id, { ...entry, status: deriveStatus(entry) })

  const roots = [...entries.values()]
    .filter((entry) => asString(entry.replyTo).length === 0)
    .sort((a, b) => (asString(a.seq) > asString(b.seq) ? -1 : 1))
  const openQuestions = [...entries.values()]
    .filter((entry) => entry.kind === 'question' && statusOf(entry) === 'open')
    .sort((a, b) => (asString(a.seq) < asString(b.seq) ? -1 : 1))
  const openHandoffs = [...entries.values()]
    .filter((entry) => entry.kind === 'handoff' && statusOf(entry) === 'open')
    .sort((a, b) => (asString(a.seq) < asString(b.seq) ? -1 : 1))
  // Convenience lists for callers that need resolved items too (the board tool's
  // `include_resolved` path); the open-only lists above stay the pulse/panel source.
  const questions = [...entries.values()]
    .filter((entry) => entry.kind === 'question')
    .sort((a, b) => (asString(a.seq) > asString(b.seq) ? -1 : 1))
  const handoffs = [...entries.values()]
    .filter((entry) => entry.kind === 'handoff')
    .sort((a, b) => (asString(a.seq) > asString(b.seq) ? -1 : 1))

  const byKind = {}
  for (const entry of entries.values()) {
    const kind = asString(entry.kind)
    byKind[kind] = (byKind[kind] ?? 0) + 1
  }

  const maxSeq = valid.length > 0 ? asString(valid[valid.length - 1].seq) : ''

  return {
    entries,
    roots,
    sessions,
    openQuestions,
    openHandoffs,
    questions,
    handoffs,
    stats: {
      entries: entries.size,
      openQuestions: openQuestions.length,
      openHandoffs: openHandoffs.length,
      byKind,
    },
    maxSeq,
    entryCount: entries.size,
    tombstones,
    hiddenEntries,
  }
}

/**
 * BoardService — one instance per plugin mount; journals and folds are cached per
 * workspace key (`Map<wsKey, {journal, view, ready}>`, v0.3 §3.2).
 *
 * Constructor deps: `{ store, config, redactor, logger, deps }`. `store` is a
 * `JournalStore` with the per-scope surface (`openWorkspace`, `viewedRecords`,
 * `onMergedChange`, `refreshMerged`); tests inject a fake with the same surface.
 * The service opens its own journals: callers only call `attach(wsKey, meta)`.
 *
 * @typedef {{
 *   openWorkspace(wsKey: string, meta?: unknown): Promise<object>,
 *   viewedRecords?: (wsKey: string) => readonly object[],
 *   onMergedChange?: (wsKey: string, callback: (changed: boolean) => void) => (() => void),
 *   refreshMerged?: (wsKey: string) => Promise<boolean>,
 * }} ScopedStore
 */
export class BoardService {
  /**
   * @param {{
   *   store: ScopedStore,
   *   config: Record<string, unknown>,
   *   redactor: { text(s: unknown): {value: string, hits: number}, title(s: unknown): {value: string, hits: number}, files(p: unknown): string[], tags(t: unknown): string[] },
   *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
   *   deps?: {now?: () => number, random?: () => number, pid?: number},
   * }} options
   */
  constructor({ store, config, redactor, logger, deps = {} } = {}) {
    if (!store) throw new TypeError('BoardService requires a store with openWorkspace()')
    if (!redactor) throw new TypeError('BoardService requires a redactor')
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this.redactor = redactor
    this.logger = logger
    this.deps = isPlainObject(deps) ? deps : {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.ulid = createUlidFactory(this.now, this.deps.random ?? Math.random)
    /** @type {Map<string, {journal: object, view: ReturnType<typeof foldRecords> | null, ready: boolean}>} */
    this._scopes = new Map()
    /** @type {Map<string, Promise<void>>} single-flight attach per scope */
    this._opening = new Map()
    /** @type {Map<string, Array<() => void>>} per-scope change-feed unsubscribes */
    this._unsubscribes = new Map()
    const busConfig = isPlainObject(this.config.bus) ? this.config.bus : {}
    const notesConfig = isPlainObject(busConfig.notes) ? busConfig.notes : {}
    const storeConfig = isPlainObject(this.config.store) ? this.config.store : {}
    // v0.3 config: bus.notes.maxEntries; the v0.2 key is a migration fallback
    // (config.resolveConfig maps it with a deprecation warning).
    this.storeMaxEntries = clampInt(
      notesConfig.maxEntries !== undefined ? notesConfig.maxEntries : storeConfig.maxEntriesPerWorkspace,
      DEFAULT_MAX_ENTRIES,
      1,
      20000,
    )
    this.storeMaxBodyBytes = clampInt(storeConfig.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1, 49152)
  }

  /** @param {string} event @param {Record<string, unknown>} [fields] */
  debug(event, fields) {
    try {
      this.logger?.debug?.({ event, ...(fields ?? {}) })
    } catch {
      // Logging must never break a board operation.
    }
  }

  /**
   * @param {unknown} wsKey
   * @returns {string}
   */
  _assertWorkspaceKey(wsKey) {
    if (typeof wsKey !== 'string' || wsKey.length === 0) {
      throw boardError('BAD_ARGUMENT', 'workspace key is required')
    }
    return wsKey
  }

  /**
   * Open (or reuse) one workspace journal, subscribe to its change feed and warm
   * the derived fold. Idempotent per scope and safe under concurrent callers.
   *
   * @param {string} wsKey
   * @param {{canonicalPath?: string, label?: string}} [meta]
   * @returns {Promise<this>}
   */
  async attach(wsKey, meta) {
    this._assertWorkspaceKey(wsKey)
    const state = this._scopes.get(wsKey)
    if (state !== undefined && state.journal && state.journal.isOpen !== false) return this
    const opening = this._opening.get(wsKey)
    if (opening !== undefined) {
      await opening
      return this
    }
    const pending = this._attachOnce(wsKey, normalizeWorkspaceMeta(meta)).finally(() => {
      if (this._opening.get(wsKey) === pending) this._opening.delete(wsKey)
    })
    this._opening.set(wsKey, pending)
    await pending
    return this
  }

  /**
   * @param {string} wsKey
   * @param {object | undefined} meta
   * @returns {Promise<void>}
   */
  async _attachOnce(wsKey, meta) {
    if (typeof this.store.openWorkspace !== 'function') {
      throw boardError('STORE_UNAVAILABLE', 'the store does not support workspace journals')
    }
    const journal = await this.store.openWorkspace(wsKey, meta)
    if (!journal || typeof journal !== 'object') {
      throw boardError('STORE_UNAVAILABLE', 'the workspace journal is unavailable')
    }
    // Replace any stale/closed state for this scope (the store may have evicted
    // and re-opened the journal under the open-journal LRU cap).
    this._detachScope(wsKey)
    this._scopes.set(wsKey, { journal, view: null, ready: true })
    this._subscribeToChanges(wsKey, journal)
    try {
      if (typeof this.store.refreshMerged === 'function') await this.store.refreshMerged(wsKey)
      else if (typeof journal.refresh === 'function') await journal.refresh()
    } catch (error) {
      // A failed warm-up scan must never block workspace memory.
      this.debug('board.attach_refresh_failed', { wsKey, message: String(error) })
    }
    this._invalidate(wsKey)
    // Build the scoped fold once so subsequent synchronous reads are warm.
    this.view(wsKey)
  }

  /**
   * Subscribe to one scope's merged-view changes (store feed first, journal feed
   * as a second source). The board dedupes through `_invalidate`, not here.
   *
   * @param {string} wsKey
   * @param {object} journal
   */
  _subscribeToChanges(wsKey, journal) {
    /** @type {Array<() => void>} */
    const unsubscribes = []
    const track = (unsubscribe) => {
      if (typeof unsubscribe === 'function') unsubscribes.push(unsubscribe)
    }
    try {
      if (typeof this.store.onMergedChange === 'function') {
        track(this.store.onMergedChange(wsKey, () => this._invalidate(wsKey)))
      }
    } catch (error) {
      this.debug('board.subscribe_failed', { wsKey, source: 'store', message: String(error) })
    }
    try {
      if (journal && typeof journal.onChange === 'function') {
        track(journal.onChange(() => this._invalidate(wsKey)))
      }
    } catch (error) {
      this.debug('board.subscribe_failed', { wsKey, source: 'journal', message: String(error) })
    }
    this._unsubscribes.set(wsKey, unsubscribes)
  }

  /**
   * The open journal of one attached scope, or null when it is not attached.
   * @param {string} wsKey
   * @returns {object | null}
   */
  journalFor(wsKey) {
    const state = typeof wsKey === 'string' ? this._scopes.get(wsKey) : undefined
    return state !== undefined && state.journal ? state.journal : null
  }

  /**
   * The open journal of one attached scope, re-opening it when the store evicted
   * it under the LRU cap. Throws STORE_UNAVAILABLE when never attached.
   *
   * @param {string} wsKey
   * @returns {Promise<object>}
   */
  async _attachedJournal(wsKey) {
    const state = this._scopes.get(wsKey)
    if (state === undefined) throw boardError('STORE_UNAVAILABLE', 'workspace store is not attached')
    if (state.journal && state.journal.isOpen !== false) return state.journal
    await this.attach(wsKey)
    const reopened = this._scopes.get(wsKey)
    if (reopened === undefined || !reopened.journal) {
      throw boardError('STORE_UNAVAILABLE', 'workspace store is not attached')
    }
    return reopened.journal
  }

  /** Drop the derived fold of one scope so the next `view(wsKey)` re-reads the store. */
  _invalidate(wsKey) {
    const state = this._scopes.get(wsKey)
    if (state !== undefined) state.view = null
  }

  /**
   * Unsubscribe and drop one scope's board state. The store journal itself is
   * left open: context/bus/pulse may share it and the store LRU owns lifetime.
   * @param {string} wsKey
   */
  _detachScope(wsKey) {
    const unsubscribes = this._unsubscribes.get(wsKey)
    if (unsubscribes !== undefined) {
      this._unsubscribes.delete(wsKey)
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe()
        } catch {
          // ignore a stale unsubscribe
        }
      }
    }
    this._scopes.delete(wsKey)
  }

  /**
   * Detach one workspace scope from this board (no journal close: the store owns
   * journal lifetime so other services on the same scope keep working).
   * @param {string} wsKey
   * @returns {this}
   */
  detach(wsKey) {
    if (typeof wsKey === 'string') this._detachScope(wsKey)
    return this
  }

  /**
   * Synchronous workspace board view derived from `store.viewedRecords(wsKey)`
   * (fresh-friendly cache). An unattached/unknown scope yields an empty fold and
   * never throws.
   *
   * @param {string} wsKey
   * @returns {ReturnType<typeof foldRecords>}
   */
  view(wsKey) {
    const state = typeof wsKey === 'string' ? this._scopes.get(wsKey) : undefined
    if (state === undefined) return foldRecords(EMPTY_RECORDS)
    if (state.view !== null) return state.view
    /** @type {readonly object[]} */
    let records = EMPTY_RECORDS
    try {
      if (typeof this.store.viewedRecords === 'function') {
        const viewed = this.store.viewedRecords(wsKey)
        if (Array.isArray(viewed)) records = viewed
      } else if (state.journal && typeof state.journal.records === 'function') {
        const raw = state.journal.records()
        if (Array.isArray(raw)) records = raw
      }
    } catch (error) {
      // A reader never throws on stored data; an empty board is the safe degraded view.
      this.debug('board.view_failed', { wsKey, message: String(error) })
    }
    const view = foldRecords(records)
    state.view = view
    return view
  }

  /**
   * Rescan one workspace journal (store poll contract) and drop its derived
   * cache. A scope that was never attached is a no-op.
   *
   * @param {string} wsKey
   * @returns {Promise<boolean>} whether the underlying records changed
   */
  async refresh(wsKey) {
    if (typeof wsKey !== 'string') return false
    const state = this._scopes.get(wsKey)
    if (state === undefined) return false
    let changed = false
    try {
      if (typeof this.store.refreshMerged === 'function') {
        changed = (await this.store.refreshMerged(wsKey)) === true
      } else if (state.journal && typeof state.journal.refresh === 'function') {
        changed = (await state.journal.refresh()) === true
      }
    } catch (error) {
      this.debug('board.refresh_failed', { wsKey, message: String(error) })
    } finally {
      this._invalidate(wsKey)
    }
    return changed
  }

  /**
   * Append one entry to this workspace's board. Validation → redaction → cap
   * check → durable append (fsync) → derived status. Validation happens before
   * any write; the record is immutable after this call (data-model §4.1).
   *
   * @param {string} wsKey
   * @param {{kind: string, title: string, body?: string, tags?: string[], files?: string[], replyTo?: string, resolves?: boolean, supersedes?: string}} input
   * @param {{sessionId: string, title?: string, origin?: 'agent'|'user'}} author
   * @param {{workspaceKey?: string, workspaceLabel?: string}} [origin] provenance only
   * @returns {Promise<{id: string, seq: string, kind: string, status: string}>}
   */
  async post(wsKey, input, author, origin) {
    this._assertWorkspaceKey(wsKey)
    const journal = await this._attachedJournal(wsKey)
    if (!isPlainObject(input)) throw boardError('BAD_ARGUMENT', 'post input must be an object')

    const kind = asString(input.kind)
    if (!KIND_SET.has(kind)) throw boardError('BAD_ARGUMENT', `unknown note kind "${kind}"`)

    const titleInput = input.title
    if (typeof titleInput !== 'string' || titleInput.trim().length === 0) {
      throw boardError('BAD_ARGUMENT', 'title is required')
    }
    const titleResult = this.redactor.title(titleInput)
    const title = titleResult.value
    if (title.length === 0) {
      throw titleResult.hits > 0
        ? boardError('REDACTED', 'the title was entirely sensitive and cannot be stored')
        : boardError('BAD_ARGUMENT', 'title is required')
    }

    let body
    if (input.body !== undefined) {
      if (typeof input.body !== 'string') throw boardError('BAD_ARGUMENT', 'body must be a string')
      const bodyResult = this.redactor.text(input.body)
      if (bodyResult.value.trim().length === 0 && input.body.trim().length > 0) {
        throw boardError('REDACTED', 'the body was entirely sensitive and cannot be stored')
      }
      if (Buffer.byteLength(bodyResult.value, 'utf8') > this.storeMaxBodyBytes) {
        throw boardError(
          'BODY_TOO_LARGE',
          `body is ${Buffer.byteLength(bodyResult.value, 'utf8')} bytes; the cap is ${this.storeMaxBodyBytes}`,
        )
      }
      body = bodyResult.value
    }

    const tags = this.redactor.tags(input.tags)
    const files = this.redactor.files(input.files)
    const view = this.view(wsKey)
    if (view.entryCount >= this.storeMaxEntries) {
      throw boardError('BOARD_FULL', `this workspace has reached ${this.storeMaxEntries} notes`)
    }

    const authorRecord = this.normalizePostAuthor(author)
    const originRecord = normalizeOrigin(origin)

    let replyTo
    if (input.replyTo !== undefined) {
      if (typeof input.replyTo !== 'string' || input.replyTo.length === 0) {
        throw boardError('BAD_ARGUMENT', 'replyTo must be a note id')
      }
      const target = view.entries.get(input.replyTo)
      if (target === undefined) throw boardError('UNKNOWN_REF', `no note "${input.replyTo}" in this workspace`)
      // Threads are one level deep: a reply to a reply re-targets the thread root (data-model §5.4).
      const targetParent = asString(target.replyTo)
      if (targetParent.length > 0) {
        const root = view.entries.get(targetParent)
        if (root === undefined) throw boardError('UNKNOWN_REF', `no note "${targetParent}" in this workspace`)
        replyTo = asString(root.id)
      } else {
        replyTo = asString(target.id)
      }
    }

    let resolves
    if (input.resolves !== undefined) {
      if (typeof input.resolves !== 'boolean') throw boardError('BAD_ARGUMENT', 'resolves must be a boolean')
      if (replyTo === undefined) throw boardError('BAD_ARGUMENT', 'resolves requires replyTo')
      const root = view.entries.get(replyTo)
      if (root === undefined || !ROOT_RESOLVABLE.has(asString(root.kind))) {
        throw boardError('BAD_ARGUMENT', 'only questions and handoffs can be resolved')
      }
      resolves = input.resolves
    }

    let supersedes
    if (input.supersedes !== undefined) {
      if (typeof input.supersedes !== 'string' || input.supersedes.length === 0) {
        throw boardError('BAD_ARGUMENT', 'supersedes must be a note id')
      }
      const target = view.entries.get(input.supersedes)
      if (target === undefined) throw boardError('UNKNOWN_REF', `no note "${input.supersedes}" in this workspace`)
      if (asString(target.replyTo).length > 0) {
        throw boardError('BAD_ARGUMENT', 'only root notes can be superseded')
      }
      supersedes = asString(target.id)
    }

    const id = `cnf_${this.ulid()}`
    const record = {
      v: 1,
      type: 'entry',
      id,
      ws: wsKey,
      kind,
      title,
      ...(body !== undefined ? { body } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(files.length > 0 ? { files } : {}),
      author: authorRecord,
      ...(originRecord !== undefined ? { origin: originRecord } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(resolves !== undefined ? { resolves } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    }

    let stored
    try {
      // The journal assigns the durable `seq`/`ts`; the returned record is the stored one.
      stored = await journal.appendAndSync(record)
    } catch (error) {
      throw boardError('STORE_UNAVAILABLE', 'the note could not be persisted', { cause: error })
    }
    this._invalidate(wsKey)
    const status =
      replyTo !== undefined
        ? resolves === true
          ? 'resolved'
          : 'active'
        : ROOT_RESOLVABLE.has(kind)
          ? 'open'
          : 'active'
    return {
      id: asString(stored?.id) || id,
      seq: asString(stored?.seq),
      kind,
      status,
    }
  }

  /**
   * Validate and normalise the posting author. Authority for sessionId comes from the caller
   * (the tool layer passes `exec.agent`), never from model arguments.
   * @param {unknown} author
   * @returns {{sessionId: string, title?: string, origin: 'agent'|'user'}}
   */
  normalizePostAuthor(author) {
    if (!isPlainObject(author)) throw boardError('BAD_ARGUMENT', 'author is required')
    const sessionId = asString(author.sessionId)
    if (sessionId.length === 0) throw boardError('BAD_ARGUMENT', 'author.sessionId is required')
    const origin = author.origin === 'user' ? 'user' : 'agent'
    if (author.title === undefined) return { sessionId, origin }
    if (typeof author.title !== 'string') throw boardError('BAD_ARGUMENT', 'author.title must be a string')
    const title = this.redactor.title(author.title).value
    return title.length > 0 ? { sessionId, title, origin } : { sessionId, origin }
  }

  /**
   * Read one entry plus its replies from one workspace board. Tombstoned entries
   * return a content-free deleted stub (data-model I5); an unknown ref returns
   * `notFound: true` (the tool maps it to NOT_FOUND).
   * @param {string} wsKey
   * @param {string} ref
   * @returns {Promise<{entry: Record<string, unknown> | null, replies: Array<Record<string, unknown>>, resolved: boolean, superseded: boolean, notFound: boolean}>}
   */
  async thread(wsKey, ref) {
    if (typeof ref !== 'string' || ref.length === 0) throw boardError('BAD_ARGUMENT', 'entry ref is required')
    const view = this.view(wsKey)
    const entry = view.entries.get(ref)
    if (entry === undefined) {
      const hidden = view.hiddenEntries?.get(ref)
      if (hidden !== undefined) {
        return {
          entry: { id: ref, type: 'entry', kind: asString(hidden.kind) || 'note', deleted: true },
          replies: [],
          resolved: false,
          superseded: false,
          notFound: false,
        }
      }
      return { entry: null, replies: [], resolved: false, superseded: false, notFound: true }
    }
    const replies = [...view.entries.values()]
      .filter((candidate) => asString(candidate.replyTo) === asString(entry.id))
      .sort((a, b) => (asString(a.seq) < asString(b.seq) ? -1 : 1))
    return {
      entry,
      replies,
      resolved: statusOf(entry) === 'resolved',
      superseded: statusOf(entry) === 'superseded',
      notFound: false,
    }
  }

  /**
   * Case-insensitive literal search over one workspace board with deterministic
   * ranking: title = 3, tags = 2, body = 1; superseded notes are down-ranked by
   * 0.5. Snippet ≤200 chars. Never crosses a workspace boundary: the fold comes
   * from that scope's journal only.
   * @param {string} wsKey
   * @param {{query: string, kind?: string, tag?: string, limit?: number}} [options]
   * @returns {Promise<{hits: Array<{entry: Record<string, unknown>, snippet: string, score: number}>, truncated: boolean}>}
   */
  async search(wsKey, options = {}) {
    if (!isPlainObject(options)) throw boardError('BAD_ARGUMENT', 'search options must be an object')
    const query = asString(options.query).trim()
    if (query.length === 0) throw boardError('BAD_ARGUMENT', 'query is required')
    let kind
    if (options.kind !== undefined) {
      kind = asString(options.kind)
      if (!KIND_SET.has(kind)) throw boardError('BAD_ARGUMENT', `unknown note kind "${kind}"`)
    }
    const tag = options.tag === undefined ? undefined : asString(options.tag).trim().toLowerCase()
    const requestedLimit = Math.trunc(asFiniteNumber(options.limit, SEARCH_DEFAULT_LIMIT))
    const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, requestedLimit))
    const needle = query.toLowerCase()

    const view = this.view(wsKey)
    const ranked = []
    for (const entry of view.entries.values()) {
      if (kind !== undefined && entry.kind !== kind) continue
      if (tag !== undefined) {
        const tags = Array.isArray(entry.tags) ? entry.tags : []
        if (!tags.some((candidate) => asString(candidate).toLowerCase() === tag)) continue
      }
      const title = asString(entry.title).toLowerCase()
      const body = asString(entry.body).toLowerCase()
      const tags = Array.isArray(entry.tags) ? entry.tags.map((candidate) => asString(candidate).toLowerCase()) : []
      let score = 0
      if (title.includes(needle)) score += WEIGHT_TITLE
      if (tags.some((candidate) => candidate.includes(needle))) score += WEIGHT_TAGS
      if (body.includes(needle)) score += WEIGHT_BODY
      if (score === 0) continue
      ranked.push({
        entry,
        snippet: buildSnippet(entry, needle),
        score,
        rank: score - (statusOf(entry) === 'superseded' ? 0.5 : 0),
      })
    }

    ranked.sort((a, b) => b.rank - a.rank || (asString(a.entry.seq) > asString(b.entry.seq) ? -1 : 1))
    const truncated = ranked.length > limit
    return {
      hits: ranked.slice(0, limit).map(({ entry, snippet, score }) => ({ entry, snippet, score })),
      truncated,
    }
  }

  /**
   * Deterministic counts for one workspace board (pulse/panel/tools).
   * @param {string} wsKey
   * @returns {{entries: number, openQuestions: number, openHandoffs: number, byKind: Record<string, number>}}
   */
  stats(wsKey) {
    return this.view(wsKey).stats
  }
}

/**
 * Build a ≤200-character snippet around the first literal match in the body (fallback: title).
 * @param {Record<string, unknown>} entry
 * @param {string} needle already lower-cased query
 * @returns {string}
 */
function buildSnippet(entry, needle) {
  const body = asString(entry.body)
  const title = asString(entry.title)
  const source = body.length > 0 ? body : title
  if (source.length === 0) return ''
  const lower = source.toLowerCase()
  const index = lower.indexOf(needle)
  const chars = [...source]
  // Work in code points so a window never splits a surrogate pair.
  let charIndex = index
  if (index >= 0 && index !== lower.length) {
    charIndex = [...lower.slice(0, index)].length
  } else if (index < 0) {
    charIndex = 0
  }
  const remaining = chars.length - charIndex
  const hasLeadingEllipsis = charIndex > 40
  const hasTrailing = remaining > SNIPPET_MAX_CHARS
  let available = SNIPPET_MAX_CHARS - (hasLeadingEllipsis ? 1 : 0) - (hasTrailing ? 1 : 0)
  available = Math.max(0, available)
  const start = hasLeadingEllipsis ? Math.max(0, charIndex - 40) : Math.max(0, charIndex)
  const window = chars.slice(start, start + available).join('')
  return `${hasLeadingEllipsis ? '…' : ''}${window}${hasTrailing ? '…' : ''}`
}
