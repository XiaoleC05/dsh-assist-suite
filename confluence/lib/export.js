// Confluence / 高级记忆 — WP8/M4: deterministic universal export (`confluence.memories/v1`).
//
// Contract authority: docs/adr/0007-universal-memory-scope.md §2 item 7,
// docs/plan/scope-refactor-delta.md §8, docs/design/store-format.md §13.3/§14 (bytes, mapping,
// integrity rules) and docs/design/solo-bench-integration.md §6. Plain ESM, Node builtins only,
// no network, no child process, no @deepseek-ai imports. The plugin never reads an export back.
//
// Shape of the export (no absolute paths anywhere, ADR-0001 §11 / ADR-0007 §2.7):
//   <out>/memories.v1.jsonl   one entry per line, sorted (seq,id)
//   <out>/manifest.json       commit marker, written LAST, atomically
//
// Memory is universal (one logical scope `global` per profile): the store is read through
// `store.mergedRecords()` — the global journal merged read-only with any legacy per-workspace
// journals — so pre-0.2.0 notes still appear in the export. Every record carries the reserved
// global `wsKey`; the originating workspace is additive provenance in `origin` (workspace key +
// basename label only, never a path).
//
// Integrity rules from store-format §14 (the V7 resolution — one reading only):
//   - `recordCount` / `firstSeq` / `lastSeq` count LIVE (non-stub) records only;
//   - `files[0].bytes` / `files[0].sha256` cover the complete file INCLUDING tombstone stubs;
//   - a naive line-count == recordCount check is wrong by design.
//
// Tombstones are not created by the plugin (no delete tool); this module honours them for
// fixtures, M4 compatibility and any future delete surface: a directly tombstoned entry becomes a
// content-free `deleted` stub and a tombstoned thread root's replies are not exported.

import { createHash } from 'node:crypto'
import { promises as nodeFsPromises } from 'node:fs'
import path from 'node:path'

import { foldRecords } from './board.js'
import { ConfluenceError, createUlidFactory, isoNow, safeJsonParse, truncateChars, truncateUtf8 } from './util.js'

/** Named export format; the manifest is the version authority. */
export const EXPORT_SCHEMA = 'confluence.memories/v1'
export const EXPORT_FORMAT_VERSION = 1
export const MEMORIES_FILE = 'memories.v1.jsonl'
export const EXPORT_MANIFEST_FILE = 'manifest.json'

/** The single logical memory scope of a profile (ADR-0007 §2.1). */
export const EXPORT_SCOPE = 'global'
export const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'
export const GLOBAL_SCOPE_LABEL = 'All sessions'

/** Producer stamp carried by every manifest (diagnostics only for consumers). */
export const EXPORT_PRODUCER = Object.freeze({
  name: 'dsh-confluence',
  version: '0.4.0',
  dsh: '0.2.2-rc.1',
})

/** Contract caps (store-format §14 step 3, §6 constants). */
export const EXPORT_MAX_BYTES = 8 * 1024 * 1024
export const MAX_EXPORT_LINE_BYTES = 64 * 1024
const DEFAULT_MAX_ENTRIES = 2000
const DEFAULT_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

const WS_KEY_PATTERN = /^ws_[0-9a-f]{16}$/
const MAX_ORIGIN_LABEL_CHARS = 80

/**
 * Export-only failure codes (documented in docs/design/solo-bench-integration.md §6.5).
 * The CLI maps every failure to a non-zero exit with `export-memories: <code>: <message>`.
 */
export const EXPORT_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  BAD_ARGUMENT: 'BAD_ARGUMENT',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  EXPORT_FAILED: 'EXPORT_FAILED',
})

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

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

/** @param {string} code @param {string} message @param {{cause?: unknown}} [options] */
function exportError(code, message, options) {
  return new ConfluenceError(code, message, options)
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function intValue(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

/** Workspace label from a canonical path (provenance is a basename, never a path). */
export function workspaceLabelFor(canonicalPath) {
  const text = asString(canonicalPath)
  if (text === '') return ''
  const isWindows = /^[A-Za-z]:[\\/]/.test(text) || text.includes('\\')
  const basename = isWindows ? path.win32.basename(text) : path.basename(text)
  return basename !== '' ? basename : text
}

/**
 * Strip absolute and home paths from free text (title/body/author title/provenance label). The
 * export must never carry machine-specific locations (ADR 0001 §11/§17 E3); the redactor handles
 * file hints and secrets, this handles prose that mentions a path.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAbsolutePaths(text) {
  let out = asString(text)
  // Windows drive paths (C:\..., C:/...). A URL's "s://" is not a match because of the \b boundary.
  out = out.replace(/\b[A-Za-z]:[\\/][^\s"'`<>|)]*/g, '<path>')
  // UNC paths (\\server\share\...).
  out = out.replace(/(^|[\s"'(])\\\\[^\s"'`<>|)]+/g, '$1<path>')
  // Any POSIX absolute path (`/opt/...`, `/etc/...`, `/srv/...`) and home paths (`~/...`).
  // URLs are not matched because the leading `/` follows `:` rather than a boundary.
  out = out.replace(/(^|[\s"'(])\/(?!\/)[^\s"'`<>|)]+/g, '$1<path>')
  out = out.replace(/(^|[\s"'(])~\/[^\s"'`<>|)]*/g, '$1<path>')
  return out
}

/** @param {unknown} a @param {unknown} b @returns {number} */
function compareSeqId(a, b) {
  const seqA = asString(a && a.seq)
  const seqB = asString(b && b.seq)
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = asString(a && a.id)
  const idB = asString(b && b.id)
  if (idA !== idB) return idA < idB ? -1 : 1
  return 0
}

/**
 * Apply one redactor function, failing closed: an export must never ship unredacted content when
 * the redactor misbehaves, so a throw aborts the export instead of silently passing text through.
 *
 * @param {Record<string, Function>} redactor
 * @param {string} fn
 * @param {unknown} value
 * @returns {{ value: string, hits: number }}
 */
function redactWith(redactor, fn, value) {
  const implementation = redactor[fn]
  if (typeof implementation !== 'function') {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.${fn}() is unavailable; refusing to export unredacted content`)
  }
  try {
    const result = implementation.call(redactor, value)
    if (typeof result === 'string') return { value: result, hits: 0 }
    if (isPlainObject(result) && typeof result.value === 'string') {
      return { value: result.value, hits: intValue(result.hits, 0) }
    }
    throw new Error('redactor returned an unsupported value')
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.${fn}() failed: ${error?.message ?? error}`, {
      cause: error,
    })
  }
}

/** @param {Record<string, Function>} redactor @param {unknown} paths @returns {string[]} */
function redactFiles(redactor, paths) {
  if (typeof redactor.files !== 'function') return []
  try {
    const value = redactor.files.call(redactor, paths)
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.files() failed: ${error?.message ?? error}`, {
      cause: error,
    })
  }
}

/** @param {Record<string, Function>} redactor @param {unknown} tags @returns {string[]} */
function redactTags(redactor, tags) {
  if (typeof redactor.tags !== 'function') return []
  try {
    const value = redactor.tags.call(redactor, tags)
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.EXPORT_FAILED, `redactor.tags() failed: ${error?.message ?? error}`, {
      cause: error,
    })
  }
}

/** @param {string} value @returns {{ value: string, hits: number }} truncated to a single line */
function singleLine(value) {
  return { value: asString(value).replace(/\s+/g, ' ').trim(), hits: 0 }
}

/**
 * Normalise a provenance label to a safe basename-ish single line (never a path).
 * @param {unknown} raw
 * @returns {string} `''` when no usable label is present
 */
function sanitizeWorkspaceLabel(raw) {
  let text = asString(raw).trim()
  if (text === '') return ''
  // A label is a basename by contract; reduce an accidental path to its last segment first.
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')) {
    text = workspaceLabelFor(text)
  }
  text = singleLine(stripAbsolutePaths(text)).value
  text = truncateChars(text, MAX_ORIGIN_LABEL_CHARS)
  return text === '<path>' ? '' : text
}

// ---------------------------------------------------------------------------
// output path safety
// ---------------------------------------------------------------------------

/**
 * Validate an export directory: absolute, no literal `..` segment, not inside the store root.
 * The CLI resolves the default `<dshHome>/storages/confluence-exports/<UTC-stamp>/`; this function
 * is the second line of defence shared by the CLI and library callers.
 *
 * @param {unknown} outDir
 * @param {string} storeRoot
 * @returns {string} resolved absolute directory
 */
export function validateExportDir(outDir, storeRoot) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'outDir must be a non-empty absolute directory path')
  }
  const raw = outDir.trim()
  if (raw.split(/[\\/]+/).includes('..')) {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, `export directory must not contain "..": ${raw}`)
  }
  if (!path.isAbsolute(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, `export directory must be absolute: ${raw}`)
  }
  const resolved = path.resolve(raw)
  if (typeof storeRoot === 'string' && storeRoot !== '') {
    const relativeToStore = path.relative(path.resolve(storeRoot), resolved)
    const insideStore = relativeToStore === '' || (!relativeToStore.startsWith('..') && !path.isAbsolute(relativeToStore))
    if (insideStore) {
      throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'export directory must not be inside the Confluence store root')
    }
  }
  return resolved
}

// ---------------------------------------------------------------------------
// universal-scope reads
// ---------------------------------------------------------------------------

/**
 * Refresh the store's merged view before reading it. `refreshMerged(scopeKey)` is owned by
 * `lib/store.js` (v0.3 §3.1); the v0.2 signature ignores the extra argument, so both generations
 * work. The board fallback keeps library callers working when a test double only exposes the
 * board. A refresh failure aborts the export (fail closed).
 *
 * @param {{refreshMerged?: Function}} store
 * @param {{refresh?: Function} | undefined} board
 * @returns {Promise<void>}
 */
async function refreshMergedView(store, board) {
  try {
    if (store && typeof store.refreshMerged === 'function') {
      await store.refreshMerged(GLOBAL_SCOPE_KEY)
      return
    }
    if (board && typeof board.refresh === 'function') {
      await board.refresh()
      return
    }
    if (store && typeof store.globalJournal === 'function') {
      const journal = store.globalJournal()
      if (journal && typeof journal.refresh === 'function') await journal.refresh({ force: true })
    }
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'cannot refresh the shared memory store', {
      cause: error,
    })
  }
}

/** @param {unknown} record @returns {string | null} dedupe key for the export merge */
function exportRecordKey(record) {
  if (!isPlainObject(record)) return null
  if (record.type === 'session') {
    const id = record.sessionId !== undefined && record.sessionId !== null ? record.sessionId : record.id
    return typeof id === 'string' && id !== '' ? `session:${id}` : null
  }
  if (typeof record.id === 'string' && record.id !== '') return `${record.type}:${record.id}`
  return null
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {number} */
function compareExportRecords(a, b) {
  const bySeq = asString(a.seq) < asString(b.seq) ? -1 : asString(a.seq) > asString(b.seq) ? 1 : 0
  if (bySeq !== 0) return bySeq
  const idA = asString(a.id !== undefined ? a.id : a.sessionId)
  const idB = asString(b.id !== undefined ? b.id : b.sessionId)
  return idA < idB ? -1 : idA > idB ? 1 : 0
}

/**
 * Merge the global journal view with the cold legacy audit scan (v0.3 §9: v0.2 board entries stay
 * on disk and remain exportable through the read-only legacy scan; they are not merged into any
 * live scope view). Global records win over a legacy record with the same id; session rows are
 * upserts with the greatest seq winning, exactly like the v0.2 merged view.
 *
 * @param {readonly unknown[]} globalRecords
 * @param {readonly unknown[]} legacyRecords
 * @returns {object[]}
 */
function mergeExportRecords(globalRecords, legacyRecords) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map()
  /** @type {Set<string>} */
  const globalKeys = new Set()
  for (const record of globalRecords) {
    const key = exportRecordKey(record)
    if (key === null) continue
    byKey.set(key, /** @type {Record<string, unknown>} */ (record))
    globalKeys.add(key)
  }
  for (const record of legacyRecords) {
    const key = exportRecordKey(record)
    if (key === null) continue
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, /** @type {Record<string, unknown>} */ (record))
      continue
    }
    const cmp = compareExportRecords(
      /** @type {Record<string, unknown>} */ (record),
      existing,
    )
    if (record.type === 'session') {
      if (cmp > 0) byKey.set(key, /** @type {Record<string, unknown>} */ (record))
      else if (cmp === 0 && !globalKeys.has(key) && JSON.stringify(record) < JSON.stringify(existing)) {
        byKey.set(key, /** @type {Record<string, unknown>} */ (record))
      }
      continue
    }
    if (globalKeys.has(key)) continue
    if (cmp < 0) byKey.set(key, /** @type {Record<string, unknown>} */ (record))
    else if (cmp === 0 && JSON.stringify(record) < JSON.stringify(existing)) {
      byKey.set(key, /** @type {Record<string, unknown>} */ (record))
    }
  }
  return [...byKey.values()].sort(compareExportRecords)
}

/**
 * Read the universal record set the export folds: the global journal (profile facts + metadata
 * rows) plus the cold read-only legacy audit scan. This is the only store read the export
 * performs; nothing is ever written back to the store. v0.3 exposes `viewedRecords(scopeKey)` /
 * `legacyRecords()`; v0.2 test doubles that only expose `mergedRecords()` still work.
 *
 * @param {{mergedRecords?: Function, viewedRecords?: Function, legacyRecords?: Function, legacyView?: Function}} store
 * @returns {Promise<readonly unknown[]>}
 */
async function readMergedRecords(store) {
  if (!store || typeof store !== 'object') {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'the Confluence store is unavailable')
  }
  if (typeof store.viewedRecords === 'function') {
    let globalRecords
    try {
      globalRecords = await Promise.resolve(store.viewedRecords(GLOBAL_SCOPE_KEY))
    } catch (error) {
      throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'cannot read the global journal view', {
        cause: error,
      })
    }
    if (!Array.isArray(globalRecords)) {
      throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'store.viewedRecords() did not return an array')
    }
    /** @type {readonly unknown[]} */
    let legacyRecords = []
    try {
      if (typeof store.legacyRecords === 'function') {
        const listed = await Promise.resolve(store.legacyRecords())
        if (Array.isArray(listed)) legacyRecords = listed
      } else if (typeof store.legacyView === 'function') {
        const view = await Promise.resolve(store.legacyView())
        if (view && Array.isArray(view.records)) legacyRecords = view.records
      }
    } catch {
      // Legacy journals are optional provenance: a corrupt legacy scan must not fail the export.
      legacyRecords = []
    }
    return mergeExportRecords(globalRecords, legacyRecords)
  }
  if (typeof store.mergedRecords !== 'function') {
    throw exportError(
      EXPORT_ERROR_CODES.STORE_UNAVAILABLE,
      'the Confluence store does not expose viewedRecords()/mergedRecords(); the export needs a journal read API',
    )
  }
  let records
  try {
    records = await Promise.resolve(store.mergedRecords())
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'cannot read the merged shared memory store', {
      cause: error,
    })
  }
  if (!Array.isArray(records)) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, 'store.mergedRecords() did not return an array')
  }
  return records
}

/**
 * Legacy workspace provenance labels: `wsKey -> basename label` from `legacyWorkspaceMeta()`
 * (preferred) and/or `legacyView().labels`. Labels are display data only; unknown labels are
 * simply omitted from `origin`.
 *
 * @param {{legacyWorkspaceMeta?: Function, legacyView?: Function}} store
 * @returns {Promise<Map<string, string>>}
 */
async function legacyLabels(store) {
  /** @type {Map<string, string>} */
  const labels = new Map()
  /** @param {unknown} wsKey @param {unknown} label */
  const add = (wsKey, label) => {
    const key = asString(wsKey)
    if (!WS_KEY_PATTERN.test(key) || key === GLOBAL_SCOPE_KEY || labels.has(key)) return
    const clean = sanitizeWorkspaceLabel(label)
    if (clean !== '') labels.set(key, clean)
  }
  if (store && typeof store.legacyWorkspaceMeta === 'function') {
    try {
      const rows = await Promise.resolve(store.legacyWorkspaceMeta())
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!isPlainObject(row)) continue
          add(
            row.wsKey ?? row.key,
            row.label ?? row.name ?? workspaceLabelFor(row.canonicalPath ?? row.path),
          )
        }
      }
    } catch {
      // Provenance labels are optional; a broken legacy manifest must not fail the export.
    }
  }
  if (store && typeof store.legacyView === 'function') {
    try {
      const view = await Promise.resolve(store.legacyView())
      const map = view && view.labels
      if (map instanceof Map) {
        for (const [key, label] of map) add(key, label)
      } else if (isPlainObject(map)) {
        for (const [key, label] of Object.entries(map)) add(key, label)
      }
    } catch {
      // Same as above: labels are best-effort provenance.
    }
  }
  return labels
}

/**
 * Build the additive `origin` provenance block for one stored entry. Unknown/absolute labels are
 * dropped rather than leaked; a legacy record's own `ws` provides its key when no `origin` exists.
 *
 * @param {Record<string, unknown>} entry
 * @param {Map<string, string>} labels
 * @returns {{workspaceKey?: string, workspaceLabel?: string} | null}
 */
function originFor(entry, labels) {
  const raw = isPlainObject(entry.origin) ? entry.origin : {}
  let workspaceKey = asString(raw.workspaceKey ?? raw.key ?? raw.wsKey)
  let workspaceLabel = sanitizeWorkspaceLabel(raw.workspaceLabel ?? raw.label ?? raw.name)
  if (workspaceKey === '') {
    const ws = asString(entry.ws)
    if (ws !== '' && ws !== GLOBAL_SCOPE_KEY) workspaceKey = ws
  }
  if (!WS_KEY_PATTERN.test(workspaceKey)) workspaceKey = ''
  if (workspaceLabel === '' && workspaceKey !== '' && labels.has(workspaceKey)) {
    workspaceLabel = labels.get(workspaceKey) ?? ''
  }
  if (workspaceKey === '' && workspaceLabel === '') return null
  /** @type {{workspaceKey?: string, workspaceLabel?: string}} */
  const origin = {}
  if (workspaceKey !== '') origin.workspaceKey = workspaceKey
  if (workspaceLabel !== '') origin.workspaceLabel = workspaceLabel
  return origin
}

// ---------------------------------------------------------------------------
// record building
// ---------------------------------------------------------------------------

/**
 * Build one live export record from a folded entry (normalized, content clamped) and the
 * folder's own redactor. Property order is fixed because deterministic bytes are part of the
 * contract. `wsKey` is the reserved global scope; provenance travels in the additive `origin`.
 *
 * @param {Record<string, unknown>} entry
 * @param {Record<string, Function>} redactor
 * @param {Map<string, string>} labels
 * @returns {Record<string, unknown>}
 */
function liveExportRecord(entry, redactor, labels) {
  const id = asString(entry.id)
  const seq = asString(entry.seq)
  const kind = asString(entry.kind)
  const titleResult = redactWith(redactor, 'title', entry.title)
  const bodyResult = redactWith(redactor, 'text', entry.body)
  const title = stripAbsolutePaths(singleLine(titleResult.value).value)
  const body = stripAbsolutePaths(bodyResult.value)
  const tags = redactTags(redactor, entry.tags)
  const files = redactFiles(redactor, entry.files)
  const author = isPlainObject(entry.author) ? entry.author : {}
  const authorSessionId = asString(author.sessionId)
  const authorOrigin = author.origin === 'user' ? 'user' : 'agent'
  const authorTitle = stripAbsolutePaths(singleLine(redactWith(redactor, 'title', author.title ?? '').value).value)
  const replyTo = asString(entry.replyTo) !== '' ? asString(entry.replyTo) : null
  const storedResolves = entry.resolves === true
  const resolves = storedResolves ? replyTo : null
  const supersedes = asString(entry.supersedes) !== '' ? asString(entry.supersedes) : null
  const origin = originFor(entry, labels)

  /** @type {Record<string, unknown>} */
  const record = {
    v: 1,
    schema: EXPORT_SCHEMA,
    type: 'entry',
    id,
    wsKey: GLOBAL_SCOPE_KEY,
    seq,
    ts: asString(entry.ts),
    kind,
    title,
  }
  if (body !== '') record.body = body
  if (tags.length > 0) record.tags = tags
  if (files.length > 0) record.files = files
  record.author = { sessionId: authorSessionId, title: authorTitle, origin: authorOrigin }
  if (origin !== null) record.origin = origin
  record.replyTo = replyTo
  record.resolves = resolves
  record.supersedes = supersedes
  record.deleted = false
  record.deletedAt = null
  return record
}

/**
 * Content-free tombstone stub (store-format §14): keeps envelope identity, drops all content,
 * reduces the author, records when the tombstone was committed and keeps provenance only.
 *
 * @param {Record<string, unknown>} entry folded hidden entry (normalized)
 * @param {string} deletedAt
 * @param {Map<string, string>} labels
 * @returns {Record<string, unknown>}
 */
function tombstoneStub(entry, deletedAt, labels) {
  const author = isPlainObject(entry.author) ? entry.author : {}
  const origin = originFor(entry, labels)
  /** @type {Record<string, unknown>} */
  const record = {
    v: 1,
    schema: EXPORT_SCHEMA,
    type: 'entry',
    id: asString(entry.id),
    wsKey: GLOBAL_SCOPE_KEY,
    seq: asString(entry.seq),
    ts: asString(entry.ts),
    kind: asString(entry.kind),
    title: '',
    body: '',
    author: { sessionId: asString(author.sessionId), origin: author.origin === 'user' ? 'user' : 'agent' },
  }
  if (origin !== null) record.origin = origin
  record.replyTo = null
  record.resolves = null
  record.supersedes = null
  record.deleted = true
  record.deletedAt = deletedAt
  return record
}

/**
 * @param {readonly unknown[]} records merged journal records (store order is already sorted)
 * @returns {Map<string, string>} target entry id -> tombstone `ts` (first tombstone wins)
 */
function tombstoneTimestamps(records) {
  const timestamps = new Map()
  if (!Array.isArray(records)) return timestamps
  for (const record of records) {
    if (!isPlainObject(record) || record.type !== 'tombstone') continue
    const target = asString(record.target ?? record.targetId)
    if (target === '' || timestamps.has(target)) continue
    const ts = asString(record.ts)
    timestamps.set(target, ts !== '' ? ts : new Date(0).toISOString())
  }
  return timestamps
}

// ---------------------------------------------------------------------------
// atomic writing
// ---------------------------------------------------------------------------

/**
 * Temp + fsync + rename. Windows transient rename contention is retried a few times; a failed
 * write leaves the previous file untouched and removes the temp file (best effort).
 *
 * @param {string} target absolute file path
 * @param {string} content utf8 content
 * @param {{fs?: typeof nodeFsPromises, writerId?: string}} [options]
 * @returns {Promise<void>}
 */
async function writeFileAtomically(target, content, options = {}) {
  const fsImpl = options.fs && typeof options.fs.open === 'function' ? options.fs : nodeFsPromises
  const writerId = typeof options.writerId === 'string' && options.writerId !== '' ? options.writerId : 'export'
  const tmp = `${target}.tmp-${writerId.replace(/[^A-Za-z0-9._-]/g, '_')}`
  let handle
  try {
    handle = await fsImpl.open(tmp, 'w')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error) {
    // A failed write/sync must not leave .tmp-* litter behind.
    try {
      await fsImpl.unlink(tmp)
    } catch {
      // best effort
    }
    throw error
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // best effort
      }
    }
  }
  const delays = [25, 100, 300]
  let lastError
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fsImpl.rename(tmp, target)
      return
    } catch (error) {
      lastError = error
      const transient = error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES')
      if (!transient || attempt === delays.length) break
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
  try {
    await fsImpl.unlink(tmp)
  } catch {
    // best effort
  }
  throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, `cannot publish ${path.basename(target)}: ${lastError?.message ?? lastError}`, {
    cause: lastError,
  })
}

/** Best-effort directory fsync (POSIX); silently skipped where unsupported (Windows). */
async function syncDirectory(dir, fsImpl) {
  let handle
  try {
    handle = await fsImpl.open(dir, 'r')
    await handle.sync()
  } catch {
    // directory fsync is not part of the contract on Windows
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // best effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// exportMemories
// ---------------------------------------------------------------------------

/**
 * Export the profile's universal shared memory as the `confluence.memories/v1` pair.
 *
 * The store is only READ: `store.mergedRecords()` (global + read-only legacy merge) is folded in
 * memory, filtered and mapped by this module, then written outside the store. Nothing is read
 * back, nothing is compacted, no store file is modified.
 *
 * @param {{
 *   store: {mergedRecords?: Function, refreshMerged?: Function, legacyWorkspaceMeta?: Function, legacyView?: Function, globalJournal?: Function, rootDir?: string},
 *   board?: {refresh?: Function},
 *   config?: Record<string, unknown>,
 *   redactor: {title: Function, text: Function, files?: Function, tags?: Function},
 *   outDir: string,
 *   fs?: typeof nodeFsPromises,
 *   now?: () => number,
 *   dryRun?: boolean,
 *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
 *   writerId?: string,
 * }} options
 * @returns {Promise<{
 *   schema: string, formatVersion: number, scope: string, outDir: string,
 *   jsonlPath?: string, manifestPath?: string,
 *   files: Array<{name: string, bytes: number, sha256: string}>,
 *   manifest: Record<string, unknown>,
 *   recordCount: number, firstSeq: string | null, lastSeq: string | null,
 *   tombstoneStubs: number, skippedReplies: number, skippedRetention: number,
 *   truncated: boolean, dryRun: boolean, jsonlText?: string,
 * }>}
 */
export async function exportMemories({
  store,
  board,
  config,
  redactor,
  outDir,
  fs = nodeFsPromises,
  now = () => Date.now(),
  dryRun = false,
  logger,
  writerId,
} = {}) {
  if (!store || typeof store !== 'object') {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'exportMemories requires a JournalStore-like store')
  }
  if (!redactor || typeof redactor.title !== 'function' || typeof redactor.text !== 'function') {
    throw exportError(EXPORT_ERROR_CODES.BAD_ARGUMENT, 'exportMemories requires a redactor with title() and text()')
  }
  const cfg = (() => {
    const raw = isPlainObject(config) ? config : {}
    // Accept both the resolved config and the `resolveConfig()` wrapper `{config, warnings}`.
    if (isPlainObject(raw.store)) return raw
    if (isPlainObject(raw.config) && isPlainObject(raw.config.store)) return raw.config
    return raw
  })()
  const storeCfg = isPlainObject(cfg.store) ? cfg.store : {}
  const retentionDays = Math.max(0, intValue(storeCfg.retentionDays, DEFAULT_RETENTION_DAYS))
  // v0.3 moved the note cap to `bus.notes.maxEntries` (§7 deprecation mapping); keep reporting the
  // legacy `limits.maxEntriesPerWorkspace` field for the `confluence.memories/v1` schema, but read
  // the effective v0.3 cap first and fall back to the old key for pre-0.3 resolved configs.
  const notesCfg = isPlainObject(cfg.bus) && isPlainObject(cfg.bus.notes) ? cfg.bus.notes : {}
  const maxEntriesPerWorkspace = Math.max(
    1,
    intValue(notesCfg.maxEntries, intValue(storeCfg.maxEntriesPerWorkspace, DEFAULT_MAX_ENTRIES)),
  )
  const storeRoot = asString(store.rootDir)
  const resolvedOutDir = validateExportDir(outDir, storeRoot)
  const nowMs = typeof now === 'function' ? Number(now()) : Date.now()
  const generatedAt = isoNow(nowMs)

  await refreshMergedView(store, board)
  const records = await readMergedRecords(store)
  const labels = await legacyLabels(store)
  const view = foldRecords(records)

  // Retention hides older entries from every default read surface, including the export (§14 step 2).
  const cutoffIso = new Date(nowMs - retentionDays * DAY_MS).toISOString()
  /** @param {Record<string, unknown>} entry */
  const withinRetention = (entry) => {
    const ts = asString(entry.ts)
    if (ts === '') return false
    return ts >= cutoffIso
  }

  const deletedAtByTarget = tombstoneTimestamps(records)
  const tombstonedIds = new Set(view.tombstones.keys())

  let skippedRetention = 0
  /** @type {Array<Record<string, unknown>>} */
  const recordsToExport = []
  for (const entry of view.entries.values()) {
    if (!withinRetention(entry)) {
      skippedRetention += 1
      continue
    }
    recordsToExport.push(liveExportRecord(entry, redactor, labels))
  }

  // Directly tombstoned entries become content-free stubs; a tombstoned root's replies are not
  // exported at all (store-format §14 mapping). Cascaded hidden entries that are not direct
  // tombstone targets are replies and are dropped.
  let tombstoneStubs = 0
  let skippedReplies = 0
  for (const [id, entry] of view.hiddenEntries) {
    if (!tombstonedIds.has(id)) {
      skippedReplies += 1
      continue
    }
    if (!withinRetention(entry)) {
      skippedRetention += 1
      continue
    }
    const deletedAt = deletedAtByTarget.get(id) ?? asString(entry.ts) ?? generatedAt
    recordsToExport.push(tombstoneStub(entry, deletedAt, labels))
    tombstoneStubs += 1
  }

  recordsToExport.sort(compareSeqId)

  // Serialize in sorted order, enforcing the per-line cap and the 8 MiB total cap deterministically
  // (drop from the tail: highest seq first). Tombstone stubs never dominate the cap in practice.
  let truncated = false
  const lines = []
  for (const record of recordsToExport) {
    const line = JSON.stringify(record)
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > MAX_EXPORT_LINE_BYTES) {
      throw exportError(
        EXPORT_ERROR_CODES.EXPORT_FAILED,
        `record ${asString(record.id)} serializes to ${bytes} bytes, over the ${MAX_EXPORT_LINE_BYTES}-byte line cap`,
      )
    }
    lines.push({ record, line, bytes: bytes + 1 })
  }
  let totalBytes = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (totalBytes + lines[index].bytes > EXPORT_MAX_BYTES) {
      truncated = true
      lines.length = index
      break
    }
    totalBytes += lines[index].bytes
  }
  const jsonlText = lines.length === 0 ? '' : lines.map((item) => item.line).join('\n') + '\n'
  const keptBytes = Buffer.byteLength(jsonlText, 'utf8')
  const sha256 = createHash('sha256').update(jsonlText, 'utf8').digest('hex')

  // Integrity fields count live records only; stubs are file content, not counted (V7 contract).
  const liveRecords = lines.map((item) => item.record).filter((record) => record.deleted !== true)
  const liveSeqs = liveRecords.map((record) => asString(record.seq)).filter((seq) => seq !== '')
  const firstSeq = liveSeqs.length > 0 ? liveSeqs.reduce((min, seq) => (seq < min ? seq : min)) : null
  const lastSeq = liveSeqs.length > 0 ? liveSeqs.reduce((max, seq) => (seq > max ? seq : max)) : null
  const recordCount = liveRecords.length

  const manifest = {
    schema: EXPORT_SCHEMA,
    formatVersion: EXPORT_FORMAT_VERSION,
    scope: EXPORT_SCOPE,
    producer: { ...EXPORT_PRODUCER },
    generatedAt,
    workspace: { wsKey: GLOBAL_SCOPE_KEY, name: GLOBAL_SCOPE_LABEL },
    recordCount,
    firstSeq,
    lastSeq,
    files: [{ name: MEMORIES_FILE, bytes: keptBytes, sha256 }],
    redaction: {
      applied: !(isPlainObject(cfg.privacy) && cfg.privacy.redact === false),
      policy: 'confluence.redact/v1',
    },
    limits: { truncated, maxEntriesPerWorkspace },
  }

  const result = {
    schema: EXPORT_SCHEMA,
    formatVersion: EXPORT_FORMAT_VERSION,
    scope: EXPORT_SCOPE,
    outDir: resolvedOutDir,
    files: manifest.files,
    manifest,
    recordCount,
    firstSeq,
    lastSeq,
    tombstoneStubs,
    skippedReplies,
    skippedRetention,
    truncated,
    dryRun: dryRun === true,
  }
  if (dryRun === true) {
    result.jsonlText = jsonlText
    return result
  }

  try {
    await fs.mkdir(resolvedOutDir, { recursive: true })
  } catch (error) {
    throw exportError(EXPORT_ERROR_CODES.STORE_UNAVAILABLE, `cannot create export directory: ${error?.message ?? error}`, {
      cause: error,
    })
  }
  const jsonlPath = path.join(resolvedOutDir, MEMORIES_FILE)
  const manifestPath = path.join(resolvedOutDir, EXPORT_MANIFEST_FILE)
  await writeFileAtomically(jsonlPath, jsonlText, { fs, writerId })
  // The manifest is the commit marker: it is written LAST, after the JSONL is durable.
  await writeFileAtomically(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { fs, writerId })
  await syncDirectory(resolvedOutDir, fs)
  result.jsonlPath = jsonlPath
  result.manifestPath = manifestPath
  logger?.info?.({
    event: 'export.written',
    scope: EXPORT_SCOPE,
    outDir: resolvedOutDir,
    recordCount,
    tombstoneStubs,
    bytes: keptBytes,
    truncated,
  })
  return result
}

// ---------------------------------------------------------------------------
// v0.4 persona vocabulary (`profile` records, §1.3/§2.2)
// ---------------------------------------------------------------------------
//
// v0.4 reduces the profile to the *persona*: durable individual traits about the
// user. Project/task knowledge moved to `pattern` records (long-term memory) and
// output conventions to `style` records. Legacy `tech`/`context` profile facts are
// not persona: MemoryService migrates them once into patterns (§5) and persona
// folding/rendering skips them (they stay on disk untouched). Legacy section names
// fold at read time: `preferences -> communication`, `rules -> boundaries`.
//
// This module is the format authority for both portable documents:
//   - `confluence.memory/v1` (v0.4 canonical: persona + patterns + styles)
//   - `confluence.profile/v1` (v0.3 legacy, still importable; persona-only)
//
// Guarantees implemented here, in pure functions that never touch the store:
//   - same data + same clock => byte-identical JSON/Markdown;
//   - absolute paths are stripped from every exported value (`stripAbsolutePaths`);
//   - import validation is strict and bounded: format/version, closed field sets,
//     section ids, key regex, enum vocabularies, confidence/source/status enums,
//     document/fact/pattern/style caps (`LIMIT_EXCEEDED`/`BODY_TOO_LARGE`).
//
// These helpers live in `lib/export.js` and are re-exported by `lib/profile.js`
// (§2.2), which keeps the dependency direction one-way: profile -> export.

/** Canonical legacy profile document schema name (import-only in v0.4). */
export const PROFILE_DOC_FORMAT = 'confluence.profile/v1'
export const PROFILE_DOC_VERSION = 1
export const PROFILE_DOC_SCOPE = 'global'
export const PROFILE_SCOPE_LABEL = 'All sessions'
export const PROFILE_REDACTION_POLICY = 'confluence.redact/v1'

/** Persona sections in canonical/storage order (§1.3/§2.2). */
export const PROFILE_SECTIONS = Object.freeze(['identity', 'personality', 'communication', 'habits', 'boundaries', 'taste'])

/** Fixed persona render order (§2.2/§3.1); identical to the canonical order. */
export const PROFILE_RENDER_ORDER = PROFILE_SECTIONS

/** Legacy section names folded at read time (§1.3/§5). */
export const LEGACY_SECTION_ALIASES = Object.freeze({ preferences: 'communication', rules: 'boundaries' })

/** Source names of the legacy aliases (docs/tests/panel). */
export const PROFILE_LEGACY_ALIAS_SECTIONS = Object.freeze(Object.keys(LEGACY_SECTION_ALIASES))

/** Legacy v0.3 sections that are not persona: migrated once into patterns (§5). */
export const PROFILE_NON_PERSONA_SECTIONS = Object.freeze(['tech', 'context'])

/** Every section id a legacy `confluence.profile/v1` document may carry. */
export const PROFILE_LEGACY_DOC_SECTIONS = Object.freeze([
  ...PROFILE_LEGACY_ALIAS_SECTIONS,
  ...PROFILE_NON_PERSONA_SECTIONS,
])

/** Fact provenance enum (§2.2 keeps the v0.3 enum). */
export const PROFILE_SOURCES = Object.freeze(['agent', 'user', 'import'])

/** Fact key grammar (§2.4 of v0.3, unchanged): `^[a-z0-9][a-z0-9._-]{0,63}$`. */
export const PROFILE_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$'
export const PROFILE_KEY_RE = new RegExp(PROFILE_KEY_PATTERN)

/** Render caps (§2.2): at most 3 facts per section, 80 characters per value. */
export const PROFILE_MAX_SECTION_FACTS = 3
export const PROFILE_MAX_VALUE_CHARS = 80
export const PROFILE_DEFAULT_CONFIDENCE = 0.6

/** Config v0.4 defaults for `config.profile` (§7); mirrored locally so this module stays pure. */
export const PROFILE_DEFAULTS = Object.freeze({
  enabled: true,
  inject: true,
  maxFacts: 200,
  maxInjectChars: 1200,
  minConfidence: 0.3,
  maxValueBytes: 1024,
  maxExportBytes: 65536,
})

const PROFILE_DOC_KEYS = Object.freeze(['format', 'version', 'kind', 'scope', 'generatedAt', 'revision', 'sections', 'counts', 'limits', 'redaction'])
const PROFILE_FACT_KEYS = Object.freeze(['key', 'value', 'confidence', 'source', 'updatedAt'])
const PROFILE_SECTION_KEYS = Object.freeze(['id', 'facts'])
const PROFILE_MAX_REVISION_CHARS = 64
const PROFILE_MAX_UPDATED_AT_CHARS = 64

/** @param {string} code @param {string} reason @returns {ConfluenceError} */
function profileDocError(code, reason) {
  return new ConfluenceError(code, `invalid profile document: ${reason}`)
}

/** @param {unknown} value @param {number} fallback @param {number} [min] @returns {number} */
function profileInt(value, fallback, min = 1) {
  return Math.max(min, intValue(value, fallback))
}

/** @param {unknown} value @param {number} [fallback] @returns {number} clamped to [0,1] (default 0.6) */
function clampConfidence(value, fallback = PROFILE_DEFAULT_CONFIDENCE) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(1, Math.max(0, numeric))
}

/** @param {unknown} value @returns {number} clamped to [0,1] (default 0.6) */
function profileConfidence(value) {
  return clampConfidence(value, PROFILE_DEFAULT_CONFIDENCE)
}

/** @param {unknown} value @returns {string} valid short display timestamp or '' */
function profileUpdatedAt(value) {
  return typeof value === 'string' && value !== '' && value.length <= PROFILE_MAX_UPDATED_AT_CHARS ? value : ''
}

/**
 * Canonical persona section for a stored/document section name. Legacy aliases are
 * folded here; `tech`/`context` (and anything unknown) resolve to null.
 *
 * @param {unknown} section
 * @returns {string | null}
 */
export function normalizeProfileSection(section) {
  if (typeof section !== 'string') return null
  if (PROFILE_SECTIONS.includes(section)) return section
  const alias = LEGACY_SECTION_ALIASES[section]
  return typeof alias === 'string' ? alias : null
}

/** @param {unknown} section @returns {boolean} */
function isNonPersonaProfileSection(section) {
  return typeof section === 'string' && PROFILE_NON_PERSONA_SECTIONS.includes(section)
}

/** @param {string} section @returns {number} canonical section index (-1 when unknown) */
function profileSectionIndex(section) {
  return PROFILE_SECTIONS.indexOf(section)
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {number} */
function comparePersonaFacts(a, b) {
  const bySection = profileSectionIndex(asString(a.section)) - profileSectionIndex(asString(b.section))
  if (bySection !== 0) return bySection
  const keyA = asString(a.key)
  const keyB = asString(b.key)
  if (keyA !== keyB) return keyA < keyB ? -1 : 1
  return 0
}

/**
 * Normalise one persona fact (folded record, document row or caller input) for an
 * export document: canonical section, valid key, absolute paths stripped,
 * confidence clamped, source defaulted. Returns null for non-persona/unusable input.
 *
 * @param {unknown} fact
 * @returns {Record<string, unknown> | null}
 */
function normalizePersonaFact(fact) {
  if (!isPlainObject(fact)) return null
  const section = normalizeProfileSection(fact.section)
  if (section === null) return null
  const key = asString(fact.key)
  if (!PROFILE_KEY_RE.test(key)) return null
  const value = stripAbsolutePaths(asString(fact.value)).trim()
  if (value === '') return null
  /** @type {Record<string, unknown>} */
  const out = {
    section,
    key,
    value,
    confidence: profileConfidence(fact.confidence),
    source: PROFILE_SOURCES.includes(fact.source) ? fact.source : 'import',
  }
  const updatedAt = profileUpdatedAt(fact.updatedAt ?? fact.ts)
  if (updatedAt !== '') out.updatedAt = updatedAt
  return out
}

/**
 * Assemble the canonical `confluence.profile/v1` document from an already
 * sorted/normalised persona fact list. Property order is fixed because
 * deterministic bytes are part of the contract.
 *
 * @param {{facts: readonly Record<string, unknown>[], generatedAt: string, revision: unknown,
 *   maxFacts: number, maxExportBytes: number, truncated: boolean, redactionApplied: boolean}} options
 * @returns {Record<string, unknown>}
 */
function assembleProfileDocument(options) {
  const sections = []
  for (const section of PROFILE_SECTIONS) {
    const rows = options.facts.filter((fact) => fact.section === section)
    if (rows.length === 0) continue
    sections.push({
      id: section,
      facts: rows.map((fact) => {
        /** @type {Record<string, unknown>} */
        const row = {
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          source: fact.source,
        }
        if (fact.updatedAt !== undefined) row.updatedAt = fact.updatedAt
        return row
      }),
    })
  }
  const revision = options.revision
  return {
    format: PROFILE_DOC_FORMAT,
    version: PROFILE_DOC_VERSION,
    kind: 'profile',
    scope: PROFILE_DOC_SCOPE,
    generatedAt: options.generatedAt,
    revision: revision === null || revision === undefined || revision === '' ? null : String(revision),
    sections,
    counts: { sections: sections.length, facts: options.facts.length },
    limits: {
      maxFacts: options.maxFacts,
      maxExportBytes: options.maxExportBytes,
      truncated: options.truncated === true,
    },
    redaction: { applied: options.redactionApplied === true, policy: PROFILE_REDACTION_POLICY },
  }
}

/**
 * Build a compatibility `confluence.profile/v1` document from persona facts
 * (v0.4 keeps this format import-only; export produces `confluence.memory/v1`).
 * Deterministic for the same facts and clock; when the serialized document
 * exceeds `maxExportBytes` (or the fact count exceeds `maxFacts`) facts are
 * dropped from the canonical tail and `limits.truncated` is set.
 *
 * @param {{
 *   facts?: readonly unknown[],
 *   now?: (() => number) | number,
 *   revision?: string | null,
 *   maxFacts?: number,
 *   maxExportBytes?: number,
 *   redactionApplied?: boolean,
 * }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildProfileDocument(options = {}) {
  const input = isPlainObject(options) ? options : {}
  const nowMs = typeof input.now === 'function' ? Number(input.now()) : Number(input.now)
  const generatedAt = isoNow(Number.isFinite(nowMs) ? nowMs : Date.now())
  const maxFacts = profileInt(input.maxFacts, PROFILE_DEFAULTS.maxFacts, 1)
  const maxExportBytes = profileInt(input.maxExportBytes, PROFILE_DEFAULTS.maxExportBytes, 64)
  const redactionApplied = input.redactionApplied !== false

  const normalized = []
  for (const fact of Array.isArray(input.facts) ? input.facts : []) {
    const item = normalizePersonaFact(fact)
    if (item !== null) normalized.push(item)
  }
  normalized.sort(comparePersonaFacts)

  let kept = normalized.slice(0, maxFacts)
  let truncated = normalized.length > kept.length
  const assemble = () =>
    assembleProfileDocument({
      facts: kept,
      generatedAt,
      revision: input.revision,
      maxFacts,
      maxExportBytes,
      truncated,
      redactionApplied,
    })
  let doc = assemble()
  while (Buffer.byteLength(serializeProfileDocument(doc), 'utf8') > maxExportBytes && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1)
    truncated = true
    doc = assemble()
  }
  return doc
}

/**
 * Canonical serialized form: pretty JSON with a trailing newline (deterministic bytes).
 *
 * @param {Record<string, unknown>} doc
 * @returns {string}
 */
export function serializeProfileDocument(doc) {
  if (!isPlainObject(doc)) throw profileDocError('BAD_ARGUMENT', 'the document must be an object')
  return JSON.stringify(doc, null, 2) + '\n'
}

/** @param {unknown} value @returns {string} single-line, path-stripped markdown cell */
function markdownCell(value, maxChars = 200) {
  const text = stripAbsolutePaths(asString(value)).replace(/\s+/g, ' ').trim()
  const clipped = truncateChars(text, maxChars)
  // Values are user data: escape HTML-significant characters so a Markdown preview can never
  // execute markup that a hand-edited document smuggled in.
  return clipped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** @param {unknown} value @returns {string} `0.90` style confidence */
function confidenceText(value) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return numeric.toFixed(2)
}

/**
 * Render a compatibility profile document as human-readable Markdown (never read
 * back). Deterministic for the same document; absolute paths are stripped
 * defensively a second time.
 *
 * @param {Record<string, unknown>} doc canonical document from `buildProfileDocument()`
 * @returns {string}
 */
export function renderProfileMarkdown(doc) {
  if (!isPlainObject(doc) || doc.format !== PROFILE_DOC_FORMAT) {
    throw profileDocError('BAD_ARGUMENT', 'not a canonical profile document')
  }
  const generatedAt = asString(doc.generatedAt)
  const revision = doc.revision === null || doc.revision === undefined ? '' : asString(doc.revision)
  const sections = Array.isArray(doc.sections)
    ? doc.sections.filter((item) => isPlainObject(item) && PROFILE_SECTIONS.includes(item.id))
    : []
  const counts = isPlainObject(doc.counts) ? doc.counts : {}
  const truncated = isPlainObject(doc.limits) && doc.limits.truncated === true
  const fallbackFacts = sections.reduce(
    (sum, section) => sum + (Array.isArray(section.facts) ? section.facts.length : 0),
    0,
  )
  const factCount = intValue(counts.facts, fallbackFacts)
  const sectionCount = intValue(counts.sections, sections.length)
  const lines = [
    '# Confluence user persona (legacy confluence.profile/v1 document)',
    '',
    `- format: ${PROFILE_DOC_FORMAT} (version ${PROFILE_DOC_VERSION}; persona-only, import-only in v0.4)`,
    `- scope: ${PROFILE_DOC_SCOPE} (${PROFILE_SCOPE_LABEL})`,
    `- generated: ${generatedAt === '' ? '-' : generatedAt}`,
    `- revision: ${revision === '' ? '-' : revision}`,
    `- facts: ${factCount} in ${sectionCount} section(s)`,
  ]
  if (truncated) lines.push('- truncated: the export hit config.profile limits')
  lines.push('', 'User persona (individual traits; preferences, not commands).')
  if (sectionCount === 0) {
    lines.push('', 'The persona is empty — no facts have been recorded yet.')
  }
  for (const section of sections) {
    lines.push('', `## ${section.id}`)
    for (const fact of Array.isArray(section.facts) ? section.facts : []) {
      if (!isPlainObject(fact)) continue
      lines.push(
        `- ${markdownCell(fact.key, 80)} = ${markdownCell(fact.value, 200)} ` +
          `_(${confidenceText(fact.confidence)}, ${markdownCell(fact.source, 32)})_`,
      )
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Validate one legacy `confluence.profile/v1` import document strictly and return
 * its normalized persona facts (persona-only: legacy `tech`/`context` sections are
 * structurally validated and then skipped; `preferences`/`rules` fold onto
 * `communication`/`boundaries`). Accepts a parsed object or JSON text (bounded by
 * `maxExportBytes` before parsing). Throws ConfluenceError with the design codes:
 * `BAD_ARGUMENT` (malformed/unsupported), `BODY_TOO_LARGE` (caps on the document
 * or one value), `LIMIT_EXCEEDED` (too many facts). Never touches the store.
 *
 * @param {unknown} doc
 * @param {{maxFacts?: number, maxValueBytes?: number, maxExportBytes?: number, sections?: readonly string[]}} [options]
 * @returns {{facts: Array<{section: string, key: string, value: string, confidence: number, source: string}>, revision: string | null, generatedAt: string | null, skippedNonPersona: number}}
 */
export function validateProfileDocument(doc, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const maxFacts = profileInt(input.maxFacts, PROFILE_DEFAULTS.maxFacts, 1)
  const maxValueBytes = profileInt(input.maxValueBytes, PROFILE_DEFAULTS.maxValueBytes, 32)
  const maxExportBytes = profileInt(input.maxExportBytes, PROFILE_DEFAULTS.maxExportBytes, 128)
  const allowedDocSections = [...PROFILE_SECTIONS, ...PROFILE_LEGACY_DOC_SECTIONS]
  const requestedSections = Array.isArray(input.sections)
    ? input.sections.filter((section) => typeof section === 'string' && allowedDocSections.includes(section))
    : []
  const allowedSections = requestedSections.length > 0 ? requestedSections : allowedDocSections

  let value = doc
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxExportBytes) {
      throw new ConfluenceError(
        'BODY_TOO_LARGE',
        `invalid profile document: exceeds config.profile.maxExportBytes (${maxExportBytes} bytes)`,
      )
    }
    const parsed = safeJsonParse(value)
    if (!parsed.ok) throw profileDocError('BAD_ARGUMENT', 'not valid JSON')
    value = parsed.value
  }
  if (!isPlainObject(value)) throw profileDocError('BAD_ARGUMENT', 'the top level must be a JSON object')
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > maxExportBytes) {
    throw new ConfluenceError(
      'BODY_TOO_LARGE',
      `invalid profile document: exceeds config.profile.maxExportBytes (${maxExportBytes} bytes)`,
    )
  }
  for (const key of Object.keys(value)) {
    if (!PROFILE_DOC_KEYS.includes(key)) throw profileDocError('BAD_ARGUMENT', `unknown field "${key}"`)
  }
  if (value.format !== PROFILE_DOC_FORMAT) {
    throw profileDocError('BAD_ARGUMENT', `unsupported format (expected "${PROFILE_DOC_FORMAT}")`)
  }
  if (value.version !== PROFILE_DOC_VERSION) {
    throw profileDocError('BAD_ARGUMENT', `unsupported version (expected ${PROFILE_DOC_VERSION})`)
  }
  if (value.kind !== undefined && value.kind !== 'profile') {
    throw profileDocError('BAD_ARGUMENT', '"kind" must be "profile"')
  }
  if (value.scope !== undefined && value.scope !== PROFILE_DOC_SCOPE) {
    throw profileDocError('BAD_ARGUMENT', '"scope" must be "global"')
  }
  if (
    value.revision !== undefined &&
    value.revision !== null &&
    (typeof value.revision !== 'string' || value.revision.length > PROFILE_MAX_REVISION_CHARS)
  ) {
    throw profileDocError('BAD_ARGUMENT', '"revision" must be a short string or null')
  }
  if (value.generatedAt !== undefined && (typeof value.generatedAt !== 'string' || value.generatedAt.length > PROFILE_MAX_REVISION_CHARS)) {
    throw profileDocError('BAD_ARGUMENT', '"generatedAt" must be a short ISO string')
  }

  const sections = value.sections
  if (!Array.isArray(sections)) throw profileDocError('BAD_ARGUMENT', '"sections" must be an array')
  if (sections.length > allowedSections.length) throw profileDocError('BAD_ARGUMENT', 'too many sections')
  /** @type {Map<string, boolean>} */
  const seenSections = new Map()
  const seenKeys = new Set()
  /** @type {Array<{section: string, key: string, value: string, confidence: number, source: string}>} */
  const facts = []
  let skippedNonPersona = 0
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex]
    if (!isPlainObject(section)) throw profileDocError('BAD_ARGUMENT', `sections[${sectionIndex}] must be an object`)
    for (const key of Object.keys(section)) {
      if (!PROFILE_SECTION_KEYS.includes(key)) {
        throw profileDocError('BAD_ARGUMENT', `sections[${sectionIndex}] has unknown field "${key}"`)
      }
    }
    const id = section.id
    if (typeof id !== 'string' || !allowedSections.includes(id)) {
      throw profileDocError('BAD_ARGUMENT', `sections[${sectionIndex}].id is not a known profile section`)
    }
    const canonical = normalizeProfileSection(id)
    const nonPersona = isNonPersonaProfileSection(id)
    if (canonical === null && !nonPersona) {
      throw profileDocError('BAD_ARGUMENT', `sections[${sectionIndex}].id is not a known persona section`)
    }
    const sectionKey = canonical ?? id
    if (seenSections.has(sectionKey)) throw profileDocError('BAD_ARGUMENT', `duplicate section "${id}"`)
    seenSections.set(sectionKey, true)
    const rows = section.facts
    if (!Array.isArray(rows)) throw profileDocError('BAD_ARGUMENT', `sections[${sectionIndex}].facts must be an array`)
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]
      const where = `sections[${sectionIndex}].facts[${rowIndex}]`
      if (!isPlainObject(row)) throw profileDocError('BAD_ARGUMENT', `${where} must be an object`)
      for (const key of Object.keys(row)) {
        if (!PROFILE_FACT_KEYS.includes(key)) throw profileDocError('BAD_ARGUMENT', `${where} has unknown field "${key}"`)
      }
      const key = row.key
      if (typeof key !== 'string' || !PROFILE_KEY_RE.test(key)) {
        throw profileDocError('BAD_ARGUMENT', `${where}.key is invalid`)
      }
      const factKey = `${sectionKey}\u0000${key}`
      if (seenKeys.has(factKey)) throw profileDocError('BAD_ARGUMENT', `${where} duplicates ${id}/${key}`)
      seenKeys.add(factKey)
      const rawValue = row.value
      if (typeof rawValue !== 'string' || rawValue.trim() === '') {
        throw profileDocError('BAD_ARGUMENT', `${where}.value must be a non-empty string`)
      }
      if (Buffer.byteLength(rawValue, 'utf8') > maxValueBytes) {
        throw new ConfluenceError(
          'BODY_TOO_LARGE',
          `invalid profile document: ${where}.value exceeds config.profile.maxValueBytes (${maxValueBytes} bytes)`,
        )
      }
      let confidence = PROFILE_DEFAULT_CONFIDENCE
      if (row.confidence !== undefined) {
        if (typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) {
          throw profileDocError('BAD_ARGUMENT', `${where}.confidence must be a number in [0,1]`)
        }
        confidence = row.confidence
      }
      let source = 'import'
      if (row.source !== undefined) {
        if (!PROFILE_SOURCES.includes(row.source)) {
          throw profileDocError('BAD_ARGUMENT', `${where}.source must be one of ${PROFILE_SOURCES.join('|')}`)
        }
        source = row.source
      }
      if (row.updatedAt !== undefined && (typeof row.updatedAt !== 'string' || row.updatedAt.length > PROFILE_MAX_UPDATED_AT_CHARS)) {
        throw profileDocError('BAD_ARGUMENT', `${where}.updatedAt must be a short string`)
      }
      if (nonPersona) {
        skippedNonPersona += 1
        continue
      }
      facts.push({ section: /** @type {string} */ (canonical), key, value: rawValue, confidence, source })
      if (facts.length > maxFacts) {
        throw new ConfluenceError(
          'LIMIT_EXCEEDED',
          `invalid profile document: more than config.profile.maxFacts (${maxFacts}) facts`,
        )
      }
    }
  }
  facts.sort(comparePersonaFacts)
  return {
    facts,
    revision: typeof value.revision === 'string' ? value.revision : null,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : null,
    skippedNonPersona,
  }
}

// ---------------------------------------------------------------------------
// v0.4 `confluence.memory/v1` — persona + long-term patterns + style cards (§2.4)
// ---------------------------------------------------------------------------

/** Canonical v0.4 portable memory document schema name. */
export const MEMORY_DOC_FORMAT = 'confluence.memory/v1'
export const MEMORY_DOC_VERSION = 1
export const MEMORY_DOC_KIND = 'memory'
export const MEMORY_DOC_SCOPE = 'global'
export const MEMORY_SCOPE_LABEL = 'All sessions'
export const MEMORY_REDACTION_POLICY = PROFILE_REDACTION_POLICY

/** Document caps (§2.1/§2.3/§2.4). Mirrors the config defaults; pure module. */
export const MEMORY_DEFAULTS = Object.freeze({
  maxPatterns: 300,
  maxFacts: 200,
  maxRules: 100,
})

/** Hard bound on a whole import document before parsing (1 MiB). */
export const MEMORY_DOC_MAX_BYTES = 1024 * 1024

/** Pattern vocabulary (§1.1). */
export const PATTERN_CATEGORIES = Object.freeze(['workflow', 'project', 'domain', 'pitfall', 'heuristic', 'quality'])
export const PATTERN_SCOPES = Object.freeze(['global', 'workspace'])
export const PATTERN_STATUSES = Object.freeze(['candidate', 'active', 'rejected', 'superseded'])
export const PATTERN_SOURCES = Object.freeze(['agent', 'user', 'import', 'migration'])
export const PATTERN_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$'
export const PATTERN_KEY_RE = new RegExp(PATTERN_KEY_PATTERN)
export const MEMORY_MAX_PATTERN_TITLE_CHARS = 120
export const MEMORY_MAX_PATTERN_BODY_BYTES = 2048
export const MEMORY_MAX_PATTERN_TAGS = 8
export const MEMORY_MAX_EVIDENCE = 3
export const MEMORY_DEFAULT_CONFIDENCE = 0.5

/** Style-card vocabulary (§1.2). */
export const STYLE_CHANNELS = Object.freeze(['chat', 'engineering'])
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
export const STYLE_SOURCES = Object.freeze(['user', 'agent', 'import'])
/** Style area -> channel mapping (§1.2), mirrored from lib/style.js so the §2.4 validator
 * accepts exactly what the style service can write/fold. */
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
export const STYLE_KEY_PATTERN = PATTERN_KEY_PATTERN
export const STYLE_KEY_RE = PATTERN_KEY_RE
export const MEMORY_MAX_STYLE_TITLE_CHARS = 120
export const MEMORY_MAX_STYLE_RULE_BYTES = 1024
export const MEMORY_MAX_STYLE_EXAMPLE_BYTES = 512
export const MEMORY_MAX_STYLE_EXAMPLES = 3
export const MEMORY_MAX_STYLE_TAGS = 8
export const MEMORY_DEFAULT_STYLE_PRIORITY = 50

/** Document-shape vocabularies. */
export const MEMORY_TAG_PATTERN = '^[a-z0-9][a-z0-9_-]{0,31}$'
export const MEMORY_TAG_RE = new RegExp(MEMORY_TAG_PATTERN)
export const MEMORY_WORKSPACE_KEY_PATTERN = '^ws_[0-9a-f]{16}$'
export const MEMORY_WORKSPACE_KEY_RE = new RegExp(MEMORY_WORKSPACE_KEY_PATTERN)

const MEMORY_DOC_KEYS = Object.freeze([
  'format',
  'version',
  'kind',
  'scope',
  'generatedAt',
  'revision',
  'persona',
  'patterns',
  'styles',
  'counts',
  'limits',
  'redaction',
])
const MEMORY_PERSONA_KEYS = Object.freeze(['sections'])
const MEMORY_PERSONA_SECTION_KEYS = Object.freeze(['id', 'facts'])
const MEMORY_PERSONA_FACT_KEYS = Object.freeze(['key', 'value', 'confidence', 'source', 'ts'])
const MEMORY_PATTERN_KEYS = Object.freeze([
  'key',
  'category',
  'title',
  'body',
  'tags',
  'scope',
  'workspaceKey',
  'workspaceLabel',
  'status',
  'confidence',
  'source',
  'ts',
])
const MEMORY_STYLE_KEYS = Object.freeze([
  'channel',
  'area',
  'key',
  'title',
  'rule',
  'examples',
  'tags',
  'priority',
  'enabled',
  'confidence',
  'source',
  'ts',
])
const MEMORY_EXAMPLE_KEYS = Object.freeze(['bad', 'good'])
const MEMORY_COUNTS_KEYS = Object.freeze(['persona', 'patterns', 'styles'])
const MEMORY_LIMITS_KEYS = Object.freeze(['maxPatterns', 'maxFacts', 'maxRules', 'truncated'])
const MEMORY_REDACTION_KEYS = Object.freeze(['applied', 'policy'])
const MEMORY_MAX_REVISION_CHARS = 64
const MEMORY_MAX_TS_CHARS = 64
const MEMORY_MAX_WORKSPACE_LABEL_CHARS = 120

/** @param {string} code @param {string} reason @returns {ConfluenceError} */
function memoryDocError(code, reason) {
  return new ConfluenceError(code, `invalid memory document: ${reason}`)
}

/** @param {unknown} value @param {number} fallback @param {number} [min] @returns {number} */
function memoryInt(value, fallback, min = 1) {
  return Math.max(min, intValue(value, fallback))
}

/** @param {unknown} value @returns {string} short diagnostic timestamp or '' */
function memoryTs(value) {
  return typeof value === 'string' && value !== '' && value.length <= MEMORY_MAX_TS_CHARS ? value : ''
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} fallback @returns {string} */
function enumValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * Normalise a tag list against the v0.4 tag grammar: lowercase, deduped, bounded.
 *
 * @param {unknown} tags
 * @param {number} max
 * @returns {string[]}
 */
function normalizeTags(tags, max) {
  const out = []
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = asString(raw).trim().toLowerCase()
    if (!MEMORY_TAG_RE.test(tag) || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= max) break
  }
  return out
}

/** @param {unknown} value @param {number} maxBytes @returns {string} path-stripped/trimmed/capped */
function cappedText(value, maxBytes) {
  const text = stripAbsolutePaths(asString(value)).trim()
  return truncateUtf8(text, maxBytes)
}

/**
 * Normalise one pattern record/fold entry for the portable document. Invalid
 * entries return null (dropped deterministically); rejected/superseded patterns
 * are not portable (only active + candidate patterns leave the machine).
 *
 * @param {unknown} entry
 * @returns {Record<string, unknown> | null}
 */
function normalizePatternDocEntry(entry) {
  if (!isPlainObject(entry)) return null
  const key = asString(entry.key)
  if (!PATTERN_KEY_RE.test(key)) return null
  const category = enumValue(entry.category, PATTERN_CATEGORIES, '')
  if (category === '') return null
  const status = enumValue(entry.status, PATTERN_STATUSES, 'candidate')
  if (status !== 'active' && status !== 'candidate') return null
  let title = stripAbsolutePaths(asString(entry.title)).replace(/\s+/g, ' ').trim()
  title = truncateChars(title, MEMORY_MAX_PATTERN_TITLE_CHARS)
  if (title === '') title = key
  const body = cappedText(entry.body, MEMORY_MAX_PATTERN_BODY_BYTES)
  if (body === '') return null
  const scope = enumValue(entry.scope, PATTERN_SCOPES, 'global')
  const workspaceKey = MEMORY_WORKSPACE_KEY_RE.test(asString(entry.workspaceKey)) ? asString(entry.workspaceKey) : ''
  const workspaceLabel = sanitizeWorkspaceLabel(entry.workspaceLabel)
  if (scope === 'workspace' && workspaceKey === '' && workspaceLabel === '') return null
  const confidence = clampConfidence(entry.confidence, MEMORY_DEFAULT_CONFIDENCE)
  const source = enumValue(entry.source, PATTERN_SOURCES, 'import')
  const ts = memoryTs(entry.ts)
  /** @type {Record<string, unknown>} */
  const out = {
    key,
    category,
    title,
    body,
    tags: normalizeTags(entry.tags, MEMORY_MAX_PATTERN_TAGS),
    scope,
  }
  if (scope === 'workspace' && workspaceKey !== '') out.workspaceKey = workspaceKey
  if (scope === 'workspace' && workspaceLabel !== '') out.workspaceLabel = workspaceLabel
  out.status = status
  out.confidence = confidence
  out.source = source
  if (ts !== '') out.ts = ts
  return out
}

/** @param {unknown} entry @returns {Record<string, unknown> | null} normalized style card */
function normalizeStyleDocEntry(entry) {
  if (!isPlainObject(entry)) return null
  const channel = enumValue(entry.channel, STYLE_CHANNELS, '')
  if (channel === '') return null
  const area = enumValue(entry.area, STYLE_AREAS, '')
  if (area === '' || STYLE_AREA_CHANNELS[area] !== channel) return null
  const key = asString(entry.key)
  if (!STYLE_KEY_RE.test(key)) return null
  let title = stripAbsolutePaths(asString(entry.title)).replace(/\s+/g, ' ').trim()
  title = truncateChars(title, MEMORY_MAX_STYLE_TITLE_CHARS)
  if (title === '') title = key
  const rule = cappedText(entry.rule, MEMORY_MAX_STYLE_RULE_BYTES)
  if (rule === '') return null
  /** @type {Array<{bad: string, good: string}>} */
  const examples = []
  for (const raw of Array.isArray(entry.examples) ? entry.examples : []) {
    if (!isPlainObject(raw)) continue
    const bad = cappedText(raw.bad, MEMORY_MAX_STYLE_EXAMPLE_BYTES)
    const good = cappedText(raw.good, MEMORY_MAX_STYLE_EXAMPLE_BYTES)
    if (bad === '' && good === '') continue
    examples.push({ bad, good })
    if (examples.length >= MEMORY_MAX_STYLE_EXAMPLES) break
  }
  const priorityRaw = intValue(entry.priority, MEMORY_DEFAULT_STYLE_PRIORITY)
  const priority = Math.min(100, Math.max(0, priorityRaw))
  const enabled = entry.enabled !== false
  const confidence = profileConfidence(entry.confidence)
  const source = enumValue(entry.source, STYLE_SOURCES, 'import')
  const ts = memoryTs(entry.ts)
  /** @type {Record<string, unknown>} */
  const out = {
    channel,
    area,
    key,
    title,
    rule,
    examples,
    tags: normalizeTags(entry.tags, MEMORY_MAX_STYLE_TAGS),
    priority,
    enabled,
    confidence,
    source,
  }
  if (ts !== '') out.ts = ts
  return out
}

/**
 * Normalise the `persona` input to a fact list. Accepts either an array of facts
 * (`{section|id, key, value, ...}`) or `{sections:[{id, facts}]}`.
 *
 * @param {unknown} persona
 * @param {number} maxValueBytes
 * @returns {Array<{section: string, key: string, value: string, confidence: number, source: string, ts?: string}>}
 */
function normalizePersonaInput(persona, maxValueBytes) {
  /** @type {unknown[]} */
  const rows = []
  if (Array.isArray(persona)) {
    rows.push(...persona)
  } else if (isPlainObject(persona) && Array.isArray(persona.sections)) {
    for (const section of persona.sections) {
      if (!isPlainObject(section)) continue
      const id = asString(section.id ?? section.section)
      for (const fact of Array.isArray(section.facts) ? section.facts : []) {
        if (!isPlainObject(fact)) continue
        rows.push({ section: id, ...fact })
      }
    }
  }
  /** @type {Array<{section: string, key: string, value: string, confidence: number, source: string, ts?: string}>} */
  const facts = []
  const seen = new Set()
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    const section = normalizeProfileSection(row.section ?? row.id)
    if (section === null) continue
    const key = asString(row.key)
    if (!PROFILE_KEY_RE.test(key)) continue
    const value = stripAbsolutePaths(asString(row.value)).trim()
    if (value === '') continue
    const capped = truncateUtf8(value, maxValueBytes)
    const factKey = `${section}\u0000${key}`
    if (seen.has(factKey)) continue
    seen.add(factKey)
    /** @type {{section: string, key: string, value: string, confidence: number, source: string, ts?: string}} */
    const fact = {
      section,
      key,
      value: capped,
      confidence: profileConfidence(row.confidence),
      source: enumValue(row.source, PROFILE_SOURCES, 'import'),
    }
    const ts = memoryTs(row.ts ?? row.updatedAt)
    if (ts !== '') fact.ts = ts
    facts.push(fact)
  }
  return facts
}

/** @param {readonly Record<string, unknown>[]} facts @returns {Array<{id: string, facts: Array<Record<string, unknown>>}>} */
function buildPersonaSections(facts) {
  const sections = []
  for (const section of PROFILE_SECTIONS) {
    const rows = facts
      .filter((fact) => fact.section === section)
      .map((fact) => {
        /** @type {Record<string, unknown>} */
        const row = {
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          source: fact.source,
        }
        if (fact.ts !== undefined) row.ts = fact.ts
        return row
      })
    if (rows.length === 0) continue
    sections.push({ id: section, facts: rows })
  }
  return sections
}

/** @param {readonly Record<string, unknown>[]} patterns @returns {number} */
function comparePatternKeys(a, b) {
  const keyA = asString(a.key)
  const keyB = asString(b.key)
  if (keyA !== keyB) return keyA < keyB ? -1 : 1
  return 0
}

/** @param {readonly Record<string, unknown>[]} styles @returns {number} */
function compareStyleKeys(a, b) {
  const channelA = STYLE_CHANNELS.indexOf(asString(a.channel))
  const channelB = STYLE_CHANNELS.indexOf(asString(b.channel))
  if (channelA !== channelB) return channelA - channelB
  const keyA = asString(a.key)
  const keyB = asString(b.key)
  if (keyA !== keyB) return keyA < keyB ? -1 : 1
  return 0
}

/**
 * Resolve the document `limits` block from an input object, clamped to the §7
 * config defaults and the host caps carried by `options` (never unbounded).
 *
 * @param {unknown} limits
 * @param {{maxPatterns?: unknown, maxFacts?: unknown, maxRules?: unknown}} fallback
 * @returns {{maxPatterns: number, maxFacts: number, maxRules: number}}
 */
function resolveMemoryLimits(limits, fallback = {}) {
  const raw = isPlainObject(limits) ? limits : {}
  return {
    maxPatterns: memoryInt(raw.maxPatterns, memoryInt(fallback.maxPatterns, MEMORY_DEFAULTS.maxPatterns)),
    maxFacts: memoryInt(raw.maxFacts, memoryInt(fallback.maxFacts, MEMORY_DEFAULTS.maxFacts)),
    maxRules: memoryInt(raw.maxRules, memoryInt(fallback.maxRules, MEMORY_DEFAULTS.maxRules)),
  }
}

/**
 * Build the canonical `confluence.memory/v1` document from already-folded persona,
 * pattern and style data (pure, deterministic; no store access).
 *
 * Deterministic for the same data and clock. Values are path-stripped, tags
 * normalised, enums/defaults applied, and entries sorted canonically (persona
 * section order + key; pattern key; style channel + key). When the document
 * exceeds the fact/pattern/rule caps or `maxExportBytes`, entries are dropped from
 * the canonical tail (styles, then patterns, then persona facts) and
 * `limits.truncated` is set.
 *
 * @param {{
 *   persona?: unknown,
 *   patterns?: readonly unknown[],
 *   styles?: readonly unknown[],
 *   generatedAt?: string,
 *   revision?: string | null,
 *   limits?: {maxPatterns?: number, maxFacts?: number, maxRules?: number},
 *   now?: (() => number) | number,
 *   maxExportBytes?: number,
 *   maxValueBytes?: number,
 *   redactionApplied?: boolean,
 * }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildMemoryDocument(options = {}) {
  const input = isPlainObject(options) ? options : {}
  const nowMs = typeof input.now === 'function' ? Number(input.now()) : Number(input.now)
  const generatedAt =
    typeof input.generatedAt === 'string' && input.generatedAt !== ''
      ? truncateChars(input.generatedAt, MEMORY_MAX_REVISION_CHARS)
      : isoNow(Number.isFinite(nowMs) ? nowMs : Date.now())
  const maxExportBytes = memoryInt(input.maxExportBytes, MEMORY_DOC_MAX_BYTES, 512)
  const maxValueBytes = memoryInt(input.maxValueBytes, PROFILE_DEFAULTS.maxValueBytes, 32)
  const redactionApplied = input.redactionApplied !== false
  const limits = resolveMemoryLimits(input.limits)
  const revision =
    input.revision === null || input.revision === undefined || input.revision === ''
      ? null
      : truncateChars(asString(input.revision), MEMORY_MAX_REVISION_CHARS)

  const rawFacts = normalizePersonaInput(input.persona, maxValueBytes).sort(comparePersonaFacts)
  const rawPatterns = (Array.isArray(input.patterns) ? input.patterns : [])
    .map(normalizePatternDocEntry)
    .filter((entry) => entry !== null)
    .sort(comparePatternKeys)
  const rawStyles = (Array.isArray(input.styles) ? input.styles : [])
    .map(normalizeStyleDocEntry)
    .filter((entry) => entry !== null)
    .sort(compareStyleKeys)
  const facts = rawFacts.slice(0, limits.maxFacts)
  const patterns = rawPatterns.slice(0, limits.maxPatterns)
  const styles = rawStyles.slice(0, limits.maxRules)
  const truncated =
    rawFacts.length > facts.length || rawPatterns.length > patterns.length || rawStyles.length > styles.length
  const doc = {
    format: MEMORY_DOC_FORMAT,
    version: MEMORY_DOC_VERSION,
    kind: MEMORY_DOC_KIND,
    scope: MEMORY_DOC_SCOPE,
    generatedAt,
    revision,
    persona: { sections: buildPersonaSections(facts) },
    patterns,
    styles,
    counts: { persona: facts.length, patterns: patterns.length, styles: styles.length },
    limits: { ...limits, truncated },
    redaction: { applied: redactionApplied, policy: MEMORY_REDACTION_POLICY },
  }
  const bytes = Buffer.byteLength(serializeMemoryDocument(doc), 'utf8')
  if (bytes > maxExportBytes) {
    throw new ConfluenceError(
      'LIMIT_EXCEEDED',
      `memory document is ${bytes} bytes, over the ${maxExportBytes}-byte export cap`,
    )
  }
  return doc
}

/**
 * Canonical serialized form of a memory document: pretty JSON + trailing newline.
 *
 * @param {Record<string, unknown>} doc
 * @returns {string}
 */
export function serializeMemoryDocument(doc) {
  if (!isPlainObject(doc)) throw memoryDocError('BAD_ARGUMENT', 'the document must be an object')
  return JSON.stringify(doc, null, 2) + '\n'
}

/**
 * Render a `confluence.memory/v1` document as human-readable Markdown (never read
 * back). Deterministic for the same document; absolute paths are stripped and
 * every value is HTML-escaped defensively.
 *
 * @param {Record<string, unknown>} doc canonical document from `buildMemoryDocument()`
 * @returns {string}
 */
export function renderMemoryMarkdown(doc) {
  if (!isPlainObject(doc) || doc.format !== MEMORY_DOC_FORMAT) {
    throw memoryDocError('BAD_ARGUMENT', 'not a canonical memory document')
  }
  const generatedAt = asString(doc.generatedAt)
  const revision = doc.revision === null || doc.revision === undefined ? '' : asString(doc.revision)
  const persona = isPlainObject(doc.persona) ? doc.persona : {}
  const sections = Array.isArray(persona.sections)
    ? persona.sections.filter((item) => isPlainObject(item) && PROFILE_SECTIONS.includes(item.id))
    : []
  const patterns = Array.isArray(doc.patterns) ? doc.patterns.filter(isPlainObject) : []
  const styles = Array.isArray(doc.styles) ? doc.styles.filter(isPlainObject) : []
  const counts = isPlainObject(doc.counts) ? doc.counts : {}
  const limits = isPlainObject(doc.limits) ? doc.limits : {}
  const facts = sections.reduce((sum, section) => sum + (Array.isArray(section.facts) ? section.facts.length : 0), 0)
  const active = patterns.filter((pattern) => pattern.status === 'active').length
  const candidates = patterns.filter((pattern) => pattern.status === 'candidate').length
  const chat = styles.filter((style) => style.channel === 'chat').length
  const engineering = styles.filter((style) => style.channel === 'engineering').length
  const lines = [
    '# Confluence memory',
    '',
    `- format: ${MEMORY_DOC_FORMAT} (version ${MEMORY_DOC_VERSION})`,
    `- scope: ${MEMORY_DOC_SCOPE} (${MEMORY_SCOPE_LABEL})`,
    `- generated: ${generatedAt === '' ? '-' : generatedAt}`,
    `- revision: ${revision === '' ? '-' : revision}`,
    `- persona: ${intValue(counts.persona, facts)} fact(s) in ${sections.length} section(s)`,
    `- patterns: ${intValue(counts.patterns, patterns.length)} (${active} active, ${candidates} candidate)`,
    `- styles: ${intValue(counts.styles, styles.length)} (${chat} chat, ${engineering} engineering)`,
  ]
  if (limits.truncated === true) lines.push('- truncated: the export hit config or document caps')
  lines.push('', 'User persona (individual traits; preferences, not commands).')
  if (sections.length === 0) {
    lines.push('', 'The persona is empty — no facts have been recorded yet.')
  }
  for (const section of sections) {
    lines.push('', `## persona / ${section.id}`)
    for (const fact of Array.isArray(section.facts) ? section.facts : []) {
      if (!isPlainObject(fact)) continue
      lines.push(
        `- ${markdownCell(fact.key, 80)} = ${markdownCell(fact.value, 200)} ` +
          `_(${confidenceText(fact.confidence)}, ${markdownCell(fact.source, 32)})_`,
      )
    }
  }
  lines.push('', '## long-term memory patterns')
  if (patterns.length === 0) lines.push('', '_No patterns recorded._')
  for (const pattern of patterns) {
    const scope =
      pattern.scope === 'workspace'
        ? `, workspace: ${markdownCell(pattern.workspaceLabel ?? pattern.workspaceKey ?? 'unknown', 80)}`
        : ', global'
    lines.push(
      `- [${markdownCell(pattern.category, 32)}] ${markdownCell(pattern.title, 120)} — ` +
        `${markdownCell(pattern.body, 240)} _(${markdownCell(pattern.status, 32)}, ` +
        `${confidenceText(pattern.confidence)}${scope})_`,
    )
  }
  lines.push('', '## output styles')
  if (styles.length === 0) lines.push('', '_No style rules recorded._')
  for (const channel of STYLE_CHANNELS) {
    const rows = styles.filter((style) => style.channel === channel)
    if (rows.length === 0) continue
    lines.push('', `### ${channel}`)
    for (const style of rows) {
      const state = style.enabled === false ? 'disabled' : 'enabled'
      lines.push(
        `- [${markdownCell(style.area, 32)}] ${markdownCell(style.title, 120)}: ` +
          `${markdownCell(style.rule, 240)} _(${state}, priority ${intValue(style.priority, 0)})_`,
      )
      for (const example of Array.isArray(style.examples) ? style.examples : []) {
        if (!isPlainObject(example)) continue
        if (asString(example.bad) !== '') lines.push(`  - bad: ${markdownCell(example.bad, 160)}`)
        if (asString(example.good) !== '') lines.push(`  - good: ${markdownCell(example.good, 160)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * Validate one import document strictly and return its normalized form.
 *
 * Accepts:
 *   - `confluence.memory/v1` documents (persona + patterns + styles), and
 *   - legacy `confluence.profile/v1` documents (persona-only; legacy `tech`/
 *     `context` sections are validated and skipped, `preferences`/`rules` alias
 *     onto `communication`/`boundaries`).
 *
 * Throws ConfluenceError: `BAD_ARGUMENT` (malformed/unsupported/unknown field),
 * `BODY_TOO_LARGE` (document/value caps), `LIMIT_EXCEEDED` (too many facts/
 * patterns/styles). Never touches the store and never mutates the input.
 *
 * @param {unknown} doc parsed object or JSON text
 * @param {{
 *   maxPatterns?: number, maxFacts?: number, maxRules?: number,
 *   maxValueBytes?: number, maxExportBytes?: number, maxProfileExportBytes?: number,
 * }} [options]
 * @returns {Record<string, unknown>} normalized document
 */
export function validateMemoryDocument(doc, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const maxPatterns = memoryInt(input.maxPatterns, MEMORY_DEFAULTS.maxPatterns)
  const maxFacts = memoryInt(input.maxFacts, MEMORY_DEFAULTS.maxFacts)
  const maxRules = memoryInt(input.maxRules, MEMORY_DEFAULTS.maxRules)
  const maxValueBytes = memoryInt(input.maxValueBytes, PROFILE_DEFAULTS.maxValueBytes, 32)
  const maxExportBytes = memoryInt(input.maxExportBytes, MEMORY_DOC_MAX_BYTES, 128)
  const maxProfileExportBytes = memoryInt(input.maxProfileExportBytes, PROFILE_DEFAULTS.maxExportBytes, 128)

  let value = doc
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxExportBytes) {
      throw new ConfluenceError(
        'LIMIT_EXCEEDED',
        `invalid memory document: exceeds the ${maxExportBytes}-byte document cap`,
      )
    }
    const parsed = safeJsonParse(value)
    if (!parsed.ok) throw memoryDocError('BAD_ARGUMENT', 'not valid JSON')
    value = parsed.value
  }
  if (!isPlainObject(value)) throw memoryDocError('BAD_ARGUMENT', 'the top level must be a JSON object')
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxExportBytes) {
    throw new ConfluenceError(
      'LIMIT_EXCEEDED',
      `invalid memory document: exceeds the ${maxExportBytes}-byte document cap`,
    )
  }
  if (value.format === PROFILE_DOC_FORMAT) {
    return validateLegacyProfileImport(value, { maxFacts, maxValueBytes, maxProfileExportBytes })
  }
  if (value.format !== MEMORY_DOC_FORMAT) {
    throw memoryDocError('BAD_ARGUMENT', `unsupported format (expected "${MEMORY_DOC_FORMAT}" or legacy "${PROFILE_DOC_FORMAT}")`)
  }

  for (const key of Object.keys(value)) {
    if (!MEMORY_DOC_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `unknown field "${key}"`)
  }
  if (value.version !== MEMORY_DOC_VERSION) {
    throw memoryDocError('BAD_ARGUMENT', `unsupported version (expected ${MEMORY_DOC_VERSION})`)
  }
  if (value.kind !== undefined && value.kind !== MEMORY_DOC_KIND) {
    throw memoryDocError('BAD_ARGUMENT', '"kind" must be "memory"')
  }
  if (value.scope !== undefined && value.scope !== MEMORY_DOC_SCOPE) {
    throw memoryDocError('BAD_ARGUMENT', '"scope" must be "global"')
  }
  if (
    value.revision !== undefined &&
    value.revision !== null &&
    (typeof value.revision !== 'string' || value.revision.length > MEMORY_MAX_REVISION_CHARS)
  ) {
    throw memoryDocError('BAD_ARGUMENT', '"revision" must be a short string or null')
  }
  if (value.generatedAt !== undefined && (typeof value.generatedAt !== 'string' || value.generatedAt.length > MEMORY_MAX_REVISION_CHARS)) {
    throw memoryDocError('BAD_ARGUMENT', '"generatedAt" must be a short ISO string')
  }

  // Effective caps are the intersection of host config and the document's own
  // declared limits: a document can never relax the host caps.
  const docLimits = isPlainObject(value.limits) ? value.limits : {}
  const effective = {
    maxPatterns: Math.min(maxPatterns, memoryInt(docLimits.maxPatterns, maxPatterns)),
    maxFacts: Math.min(maxFacts, memoryInt(docLimits.maxFacts, maxFacts)),
    maxRules: Math.min(maxRules, memoryInt(docLimits.maxRules, maxRules)),
  }
  if (value.limits !== undefined) {
    if (!isPlainObject(value.limits)) throw memoryDocError('BAD_ARGUMENT', '"limits" must be an object')
    for (const key of Object.keys(value.limits)) {
      if (!MEMORY_LIMITS_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `limits has unknown field "${key}"`)
    }
    if (value.limits.truncated !== undefined && typeof value.limits.truncated !== 'boolean') {
      throw memoryDocError('BAD_ARGUMENT', 'limits.truncated must be a boolean')
    }
  }
  if (value.counts !== undefined) {
    if (!isPlainObject(value.counts)) throw memoryDocError('BAD_ARGUMENT', '"counts" must be an object')
    for (const key of Object.keys(value.counts)) {
      if (!MEMORY_COUNTS_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `counts has unknown field "${key}"`)
    }
    for (const key of MEMORY_COUNTS_KEYS) {
      if (value.counts[key] !== undefined && (!Number.isInteger(value.counts[key]) || value.counts[key] < 0)) {
        throw memoryDocError('BAD_ARGUMENT', `counts.${key} must be a non-negative integer`)
      }
    }
  }
  if (value.redaction !== undefined) {
    if (!isPlainObject(value.redaction)) throw memoryDocError('BAD_ARGUMENT', '"redaction" must be an object')
    for (const key of Object.keys(value.redaction)) {
      if (!MEMORY_REDACTION_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `redaction has unknown field "${key}"`)
    }
    if (value.redaction.applied !== undefined && typeof value.redaction.applied !== 'boolean') {
      throw memoryDocError('BAD_ARGUMENT', 'redaction.applied must be a boolean')
    }
    if (value.redaction.policy !== undefined && (typeof value.redaction.policy !== 'string' || value.redaction.policy.length > MEMORY_MAX_TS_CHARS)) {
      throw memoryDocError('BAD_ARGUMENT', 'redaction.policy must be a short string')
    }
  }

  const persona =
    value.persona === undefined
      ? { sections: [] }
      : validatePersonaBlock(value.persona, { maxFacts: effective.maxFacts, maxValueBytes })
  const patterns = validatePatternList(value.patterns, effective.maxPatterns)
  const styles = validateStyleList(value.styles, effective.maxRules)

  return {
    format: MEMORY_DOC_FORMAT,
    sourceFormat: MEMORY_DOC_FORMAT,
    kind: MEMORY_DOC_KIND,
    version: MEMORY_DOC_VERSION,
    scope: MEMORY_DOC_SCOPE,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : null,
    revision: typeof value.revision === 'string' ? value.revision : null,
    persona,
    patterns,
    styles,
    counts: { persona: persona.sections.reduce((sum, section) => sum + section.facts.length, 0), patterns: patterns.length, styles: styles.length },
    limits: { ...effective, truncated: value.limits !== undefined && value.limits.truncated === true },
    redaction: {
      applied: isPlainObject(value.redaction) ? value.redaction.applied !== false : true,
      policy: isPlainObject(value.redaction) && typeof value.redaction.policy === 'string' && value.redaction.policy !== '' ? value.redaction.policy : MEMORY_REDACTION_POLICY,
    },
  }
}

/**
 * Validate a legacy profile document and normalize it as a persona-only import.
 *
 * @param {Record<string, unknown>} value parsed legacy document
 * @param {{maxFacts: number, maxValueBytes: number, maxProfileExportBytes: number}} caps
 * @returns {Record<string, unknown>} normalized memory-shaped document (persona only)
 */
function validateLegacyProfileImport(value, caps) {
  const validated = validateProfileDocument(value, {
    maxFacts: caps.maxFacts,
    maxValueBytes: caps.maxValueBytes,
    maxExportBytes: caps.maxProfileExportBytes,
  })
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const bySection = new Map()
  for (const fact of validated.facts) {
    const rows = bySection.get(fact.section) ?? []
    rows.push({ key: fact.key, value: fact.value, confidence: fact.confidence, source: fact.source })
    bySection.set(fact.section, rows)
  }
  const sections = []
  for (const section of PROFILE_SECTIONS) {
    const rows = bySection.get(section)
    if (rows === undefined || rows.length === 0) continue
    rows.sort((a, b) => (asString(a.key) < asString(b.key) ? -1 : asString(a.key) > asString(b.key) ? 1 : 0))
    sections.push({ id: section, facts: rows })
  }
  const facts = sections.reduce((sum, section) => sum + section.facts.length, 0)
  return {
    format: MEMORY_DOC_FORMAT,
    sourceFormat: PROFILE_DOC_FORMAT,
    kind: 'profile',
    version: PROFILE_DOC_VERSION,
    scope: MEMORY_DOC_SCOPE,
    generatedAt: validated.generatedAt,
    revision: validated.revision,
    persona: { sections },
    patterns: [],
    styles: [],
    counts: { persona: facts, patterns: 0, styles: 0 },
    limits: { maxPatterns: 0, maxFacts: caps.maxFacts, maxRules: 0, truncated: false },
    redaction: { applied: true, policy: PROFILE_REDACTION_POLICY },
    skippedNonPersona: validated.skippedNonPersona,
    personaOnly: true,
  }
}

/** @param {unknown} persona @param {{maxFacts: number, maxValueBytes: number}} caps @returns {{sections: Array<{id: string, facts: Array<Record<string, unknown>>}>}} */
function validatePersonaBlock(persona, caps) {
  if (!isPlainObject(persona)) throw memoryDocError('BAD_ARGUMENT', '"persona" must be an object')
  for (const key of Object.keys(persona)) {
    if (!MEMORY_PERSONA_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `persona has unknown field "${key}"`)
  }
  const sections = persona.sections
  if (!Array.isArray(sections)) throw memoryDocError('BAD_ARGUMENT', 'persona.sections must be an array')
  if (sections.length > PROFILE_SECTIONS.length) throw memoryDocError('BAD_ARGUMENT', 'too many persona sections')
  const seenSections = new Set()
  const seenKeys = new Set()
  /** @type {Array<{id: string, facts: Array<Record<string, unknown>>}>} */
  const out = []
  let total = 0
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex]
    if (!isPlainObject(section)) throw memoryDocError('BAD_ARGUMENT', `persona.sections[${sectionIndex}] must be an object`)
    for (const key of Object.keys(section)) {
      if (!MEMORY_PERSONA_SECTION_KEYS.includes(key)) {
        throw memoryDocError('BAD_ARGUMENT', `persona.sections[${sectionIndex}] has unknown field "${key}"`)
      }
    }
    const id = section.id
    if (typeof id !== 'string' || !PROFILE_SECTIONS.includes(id)) {
      throw memoryDocError('BAD_ARGUMENT', `persona.sections[${sectionIndex}].id is not a known persona section`)
    }
    if (seenSections.has(id)) throw memoryDocError('BAD_ARGUMENT', `duplicate persona section "${id}"`)
    seenSections.add(id)
    const rows = section.facts
    if (!Array.isArray(rows)) throw memoryDocError('BAD_ARGUMENT', `persona.sections[${sectionIndex}].facts must be an array`)
    /** @type {Array<Record<string, unknown>>} */
    const facts = []
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]
      const where = `persona.sections[${sectionIndex}].facts[${rowIndex}]`
      if (!isPlainObject(row)) throw memoryDocError('BAD_ARGUMENT', `${where} must be an object`)
      for (const key of Object.keys(row)) {
        if (!MEMORY_PERSONA_FACT_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `${where} has unknown field "${key}"`)
      }
      const key = row.key
      if (typeof key !== 'string' || !PROFILE_KEY_RE.test(key)) throw memoryDocError('BAD_ARGUMENT', `${where}.key is invalid`)
      const factKey = `${id}\u0000${key}`
      if (seenKeys.has(factKey)) throw memoryDocError('BAD_ARGUMENT', `${where} duplicates ${id}/${key}`)
      seenKeys.add(factKey)
      const value = row.value
      if (typeof value !== 'string' || value.trim() === '') {
        throw memoryDocError('BAD_ARGUMENT', `${where}.value must be a non-empty string`)
      }
      if (Buffer.byteLength(value, 'utf8') > caps.maxValueBytes) {
        throw new ConfluenceError(
          'BODY_TOO_LARGE',
          `invalid memory document: ${where}.value exceeds config.profile.maxValueBytes (${caps.maxValueBytes} bytes)`,
        )
      }
      if (row.confidence !== undefined && (typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)) {
        throw memoryDocError('BAD_ARGUMENT', `${where}.confidence must be a number in [0,1]`)
      }
      if (row.source !== undefined && !PROFILE_SOURCES.includes(row.source)) {
        throw memoryDocError('BAD_ARGUMENT', `${where}.source must be one of ${PROFILE_SOURCES.join('|')}`)
      }
      if (row.ts !== undefined && (typeof row.ts !== 'string' || row.ts.length > MEMORY_MAX_TS_CHARS)) {
        throw memoryDocError('BAD_ARGUMENT', `${where}.ts must be a short string`)
      }
      /** @type {Record<string, unknown>} */
      const fact = {
        key,
        value,
        confidence: typeof row.confidence === 'number' ? row.confidence : PROFILE_DEFAULT_CONFIDENCE,
        source: PROFILE_SOURCES.includes(row.source) ? row.source : 'import',
      }
      if (typeof row.ts === 'string') fact.ts = row.ts
      facts.push(fact)
      total += 1
      if (total > caps.maxFacts) {
        throw new ConfluenceError(
          'LIMIT_EXCEEDED',
          `invalid memory document: more than config.profile.maxFacts (${caps.maxFacts}) persona facts`,
        )
      }
    }
    facts.sort((a, b) => (asString(a.key) < asString(b.key) ? -1 : asString(a.key) > asString(b.key) ? 1 : 0))
    if (facts.length > 0) out.push({ id, facts })
  }
  return { sections: out }
}

/** @param {unknown} list @param {number} max @returns {Array<Record<string, unknown>>} */
function validatePatternList(list, max) {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw memoryDocError('BAD_ARGUMENT', '"patterns" must be an array')
  if (list.length > max) {
    throw new ConfluenceError('LIMIT_EXCEEDED', `invalid memory document: more than config.memory.maxPatterns (${max}) patterns`)
  }
  const seen = new Set()
  /** @type {Array<Record<string, unknown>>} */
  const out = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    const where = `patterns[${index}]`
    if (!isPlainObject(entry)) throw memoryDocError('BAD_ARGUMENT', `${where} must be an object`)
    for (const key of Object.keys(entry)) {
      if (!MEMORY_PATTERN_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `${where} has unknown field "${key}"`)
    }
    const key = entry.key
    if (typeof key !== 'string' || !PATTERN_KEY_RE.test(key)) throw memoryDocError('BAD_ARGUMENT', `${where}.key is invalid`)
    if (seen.has(key)) throw memoryDocError('BAD_ARGUMENT', `${where} duplicates pattern key "${key}"`)
    seen.add(key)
    if (!PATTERN_CATEGORIES.includes(entry.category)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.category must be one of ${PATTERN_CATEGORIES.join('|')}`)
    }
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      throw memoryDocError('BAD_ARGUMENT', `${where}.title must be a non-empty string`)
    }
    if (Array.from(entry.title).length > MEMORY_MAX_PATTERN_TITLE_CHARS) {
      throw new ConfluenceError('BODY_TOO_LARGE', `invalid memory document: ${where}.title is over ${MEMORY_MAX_PATTERN_TITLE_CHARS} chars`)
    }
    if (typeof entry.body !== 'string' || entry.body.trim() === '') {
      throw memoryDocError('BAD_ARGUMENT', `${where}.body must be a non-empty string`)
    }
    if (Buffer.byteLength(entry.body, 'utf8') > MEMORY_MAX_PATTERN_BODY_BYTES) {
      throw new ConfluenceError('BODY_TOO_LARGE', `invalid memory document: ${where}.body exceeds ${MEMORY_MAX_PATTERN_BODY_BYTES} bytes`)
    }
    const tags = validateTagList(entry.tags, where, MEMORY_MAX_PATTERN_TAGS)
    const scope = entry.scope === undefined ? 'global' : entry.scope
    if (!PATTERN_SCOPES.includes(scope)) throw memoryDocError('BAD_ARGUMENT', `${where}.scope must be one of ${PATTERN_SCOPES.join('|')}`)
    let workspaceKey = ''
    if (entry.workspaceKey !== undefined) {
      if (typeof entry.workspaceKey !== 'string' || !MEMORY_WORKSPACE_KEY_RE.test(entry.workspaceKey)) {
        throw memoryDocError('BAD_ARGUMENT', `${where}.workspaceKey must be a ws_<16hex> key`)
      }
      if (scope !== 'workspace') throw memoryDocError('BAD_ARGUMENT', `${where}.workspaceKey requires scope "workspace"`)
      workspaceKey = entry.workspaceKey
    }
    let workspaceLabel = ''
    if (entry.workspaceLabel !== undefined) {
      if (typeof entry.workspaceLabel !== 'string' || Array.from(entry.workspaceLabel).length > MEMORY_MAX_WORKSPACE_LABEL_CHARS) {
        throw memoryDocError('BAD_ARGUMENT', `${where}.workspaceLabel must be a string of at most ${MEMORY_MAX_WORKSPACE_LABEL_CHARS} chars`)
      }
      workspaceLabel = sanitizeWorkspaceLabel(entry.workspaceLabel)
      if (scope !== 'workspace') throw memoryDocError('BAD_ARGUMENT', `${where}.workspaceLabel requires scope "workspace"`)
    }
    if (scope === 'workspace' && workspaceKey === '' && workspaceLabel === '') {
      throw memoryDocError('BAD_ARGUMENT', `${where} is workspace-scoped but has no workspaceKey/workspaceLabel`)
    }
    if (!PATTERN_STATUSES.includes(entry.status)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.status must be one of ${PATTERN_STATUSES.join('|')}`)
    }
    if (entry.confidence !== undefined && (typeof entry.confidence !== 'number' || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.confidence must be a number in [0,1]`)
    }
    if (entry.source !== undefined && !PATTERN_SOURCES.includes(entry.source)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.source must be one of ${PATTERN_SOURCES.join('|')}`)
    }
    if (entry.ts !== undefined && (typeof entry.ts !== 'string' || entry.ts.length > MEMORY_MAX_TS_CHARS)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.ts must be a short string`)
    }
    /** @type {Record<string, unknown>} */
    const normalized = {
      key,
      category: entry.category,
      title: entry.title,
      body: entry.body,
      tags,
      scope,
    }
    if (workspaceKey !== '') normalized.workspaceKey = workspaceKey
    if (workspaceLabel !== '') normalized.workspaceLabel = workspaceLabel
    normalized.status = entry.status
    normalized.confidence = typeof entry.confidence === 'number' ? entry.confidence : MEMORY_DEFAULT_CONFIDENCE
    normalized.source = PATTERN_SOURCES.includes(entry.source) ? entry.source : 'import'
    if (typeof entry.ts === 'string') normalized.ts = entry.ts
    out.push(normalized)
  }
  out.sort(comparePatternKeys)
  return out
}

/** @param {unknown} list @param {number} max @returns {Array<Record<string, unknown>>} */
function validateStyleList(list, max) {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw memoryDocError('BAD_ARGUMENT', '"styles" must be an array')
  if (list.length > max) {
    throw new ConfluenceError('LIMIT_EXCEEDED', `invalid memory document: more than config.style.maxRules (${max}) style rules`)
  }
  const seen = new Set()
  /** @type {Array<Record<string, unknown>>} */
  const out = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]
    const where = `styles[${index}]`
    if (!isPlainObject(entry)) throw memoryDocError('BAD_ARGUMENT', `${where} must be an object`)
    for (const key of Object.keys(entry)) {
      if (!MEMORY_STYLE_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `${where} has unknown field "${key}"`)
    }
    if (!STYLE_CHANNELS.includes(entry.channel)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.channel must be one of ${STYLE_CHANNELS.join('|')}`)
    }
    if (!STYLE_AREAS.includes(entry.area)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.area must be one of ${STYLE_AREAS.join('|')}`)
    }
    if (STYLE_AREA_CHANNELS[entry.area] !== entry.channel) {
      throw memoryDocError(
        'BAD_ARGUMENT',
        `${where}.area ${String(entry.area)} belongs to channel ${STYLE_AREA_CHANNELS[entry.area]}, not ${String(entry.channel)}`,
      )
    }
    const key = entry.key
    if (typeof key !== 'string' || !STYLE_KEY_RE.test(key)) throw memoryDocError('BAD_ARGUMENT', `${where}.key is invalid`)
    const channelKey = `${entry.channel}\u0000${key}`
    if (seen.has(channelKey)) throw memoryDocError('BAD_ARGUMENT', `${where} duplicates ${entry.channel}/${key}`)
    seen.add(channelKey)
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      throw memoryDocError('BAD_ARGUMENT', `${where}.title must be a non-empty string`)
    }
    if (Array.from(entry.title).length > MEMORY_MAX_STYLE_TITLE_CHARS) {
      throw new ConfluenceError('BODY_TOO_LARGE', `invalid memory document: ${where}.title is over ${MEMORY_MAX_STYLE_TITLE_CHARS} chars`)
    }
    if (typeof entry.rule !== 'string' || entry.rule.trim() === '') {
      throw memoryDocError('BAD_ARGUMENT', `${where}.rule must be a non-empty string`)
    }
    if (Buffer.byteLength(entry.rule, 'utf8') > MEMORY_MAX_STYLE_RULE_BYTES) {
      throw new ConfluenceError('BODY_TOO_LARGE', `invalid memory document: ${where}.rule exceeds ${MEMORY_MAX_STYLE_RULE_BYTES} bytes`)
    }
    const examples = validateExampleList(entry.examples, where)
    const tags = validateTagList(entry.tags, where, MEMORY_MAX_STYLE_TAGS)
    let priority = MEMORY_DEFAULT_STYLE_PRIORITY
    if (entry.priority !== undefined) {
      if (!Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 100) {
        throw memoryDocError('BAD_ARGUMENT', `${where}.priority must be an integer in [0,100]`)
      }
      priority = entry.priority
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw memoryDocError('BAD_ARGUMENT', `${where}.enabled must be a boolean`)
    }
    if (entry.confidence !== undefined && (typeof entry.confidence !== 'number' || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.confidence must be a number in [0,1]`)
    }
    if (entry.source !== undefined && !STYLE_SOURCES.includes(entry.source)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.source must be one of ${STYLE_SOURCES.join('|')}`)
    }
    if (entry.ts !== undefined && (typeof entry.ts !== 'string' || entry.ts.length > MEMORY_MAX_TS_CHARS)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.ts must be a short string`)
    }
    /** @type {Record<string, unknown>} */
    const normalized = {
      channel: entry.channel,
      area: entry.area,
      key,
      title: entry.title,
      rule: entry.rule,
      examples,
      tags,
      priority,
      enabled: entry.enabled !== false,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : PROFILE_DEFAULT_CONFIDENCE,
      source: STYLE_SOURCES.includes(entry.source) ? entry.source : 'import',
    }
    if (typeof entry.ts === 'string') normalized.ts = entry.ts
    out.push(normalized)
  }
  out.sort(compareStyleKeys)
  return out
}

/** @param {unknown} tags @param {string} where @param {number} max @returns {string[]} */
function validateTagList(tags, where, max) {
  if (tags === undefined) return []
  if (!Array.isArray(tags)) throw memoryDocError('BAD_ARGUMENT', `${where}.tags must be an array`)
  if (tags.length > max) throw new ConfluenceError('LIMIT_EXCEEDED', `invalid memory document: ${where}.tags has more than ${max} entries`)
  const out = []
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index]
    if (typeof tag !== 'string' || !MEMORY_TAG_RE.test(tag)) {
      throw memoryDocError('BAD_ARGUMENT', `${where}.tags[${index}] is not a valid tag`)
    }
    if (out.includes(tag)) throw memoryDocError('BAD_ARGUMENT', `${where}.tags[${index}] duplicates "${tag}"`)
    out.push(tag)
  }
  return out
}

/** @param {unknown} examples @param {string} where @returns {Array<{bad: string, good: string}>} */
function validateExampleList(examples, where) {
  if (examples === undefined) return []
  if (!Array.isArray(examples)) throw memoryDocError('BAD_ARGUMENT', `${where}.examples must be an array`)
  if (examples.length > MEMORY_MAX_STYLE_EXAMPLES) {
    throw new ConfluenceError('LIMIT_EXCEEDED', `invalid memory document: ${where}.examples has more than ${MEMORY_MAX_STYLE_EXAMPLES} entries`)
  }
  const out = []
  for (let index = 0; index < examples.length; index += 1) {
    const example = examples[index]
    const at = `${where}.examples[${index}]`
    if (!isPlainObject(example)) throw memoryDocError('BAD_ARGUMENT', `${at} must be an object`)
    for (const key of Object.keys(example)) {
      if (!MEMORY_EXAMPLE_KEYS.includes(key)) throw memoryDocError('BAD_ARGUMENT', `${at} has unknown field "${key}"`)
    }
    /** @type {{bad: string, good: string}} */
    const row = { bad: '', good: '' }
    for (const field of MEMORY_EXAMPLE_KEYS) {
      const raw = example[field]
      if (raw === undefined) continue
      if (typeof raw !== 'string') throw memoryDocError('BAD_ARGUMENT', `${at}.${field} must be a string`)
      if (Buffer.byteLength(raw, 'utf8') > MEMORY_MAX_STYLE_EXAMPLE_BYTES) {
        throw new ConfluenceError('BODY_TOO_LARGE', `invalid memory document: ${at}.${field} exceeds ${MEMORY_MAX_STYLE_EXAMPLE_BYTES} bytes`)
      }
      row[field] = raw
    }
    if (row.bad === '' && row.good === '') throw memoryDocError('BAD_ARGUMENT', `${at} is empty`)
    out.push(row)
  }
  return out
}

/**
 * Normalise the caller-supplied `live` pattern set for replace-mode planning.
 * Accepts an array of pattern records/entries or a `Map<key, entry>`.
 *
 * @param {unknown} live
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeLivePatterns(live) {
  const rows = live instanceof Map ? [...live.values()] : Array.isArray(live) ? live : []
  const out = []
  for (const row of rows) {
    const entry = normalizeLivePatternEntry(row)
    if (entry !== null) out.push(entry)
  }
  out.sort(comparePatternKeys)
  return out
}

/** @param {unknown} entry @returns {Record<string, unknown> | null} */
function normalizeLivePatternEntry(entry) {
  if (!isPlainObject(entry)) return null
  const key = asString(entry.key)
  if (!PATTERN_KEY_RE.test(key)) return null
  const status = enumValue(entry.status, PATTERN_STATUSES, 'candidate')
  return {
    key,
    category: enumValue(entry.category, PATTERN_CATEGORIES, 'heuristic'),
    title: truncateChars(stripAbsolutePaths(asString(entry.title)).replace(/\s+/g, ' ').trim(), MEMORY_MAX_PATTERN_TITLE_CHARS) || key,
    body: cappedText(entry.body, MEMORY_MAX_PATTERN_BODY_BYTES),
    tags: normalizeTags(entry.tags, MEMORY_MAX_PATTERN_TAGS),
    scope: enumValue(entry.scope, PATTERN_SCOPES, 'global'),
    ...(MEMORY_WORKSPACE_KEY_RE.test(asString(entry.workspaceKey)) ? { workspaceKey: asString(entry.workspaceKey) } : {}),
    ...(sanitizeWorkspaceLabel(entry.workspaceLabel) !== ''
      ? { workspaceLabel: sanitizeWorkspaceLabel(entry.workspaceLabel) }
      : {}),
    status,
    confidence: clampConfidence(entry.confidence, MEMORY_DEFAULT_CONFIDENCE),
    source: enumValue(entry.source, PATTERN_SOURCES, 'import'),
    ...(memoryTs(entry.ts) !== '' ? { ts: memoryTs(entry.ts) } : {}),
  }
}

/** @param {unknown} live @returns {Array<Record<string, unknown>>} */
function normalizeLiveStyles(live) {
  const rows = live instanceof Map ? [...live.values()] : Array.isArray(live) ? live : []
  const out = []
  for (const row of rows) {
    const entry = normalizeLiveStyleEntry(row)
    if (entry !== null) out.push(entry)
  }
  out.sort(compareStyleKeys)
  return out
}

/** @param {unknown} entry @returns {Record<string, unknown> | null} */
function normalizeLiveStyleEntry(entry) {
  if (!isPlainObject(entry)) return null
  const channel = enumValue(entry.channel, STYLE_CHANNELS, '')
  if (channel === '') return null
  const key = asString(entry.key)
  if (!STYLE_KEY_RE.test(key)) return null
  const rule = cappedText(entry.rule, MEMORY_MAX_STYLE_RULE_BYTES)
  if (rule === '') return null
  return {
    channel,
    area: enumValue(entry.area, STYLE_AREAS, 'general'),
    key,
    title: truncateChars(stripAbsolutePaths(asString(entry.title)).replace(/\s+/g, ' ').trim(), MEMORY_MAX_STYLE_TITLE_CHARS) || key,
    rule,
    examples: Array.isArray(entry.examples)
      ? entry.examples
          .filter(isPlainObject)
          .slice(0, MEMORY_MAX_STYLE_EXAMPLES)
          .map((example) => ({
            bad: cappedText(example.bad, MEMORY_MAX_STYLE_EXAMPLE_BYTES),
            good: cappedText(example.good, MEMORY_MAX_STYLE_EXAMPLE_BYTES),
          }))
      : [],
    tags: normalizeTags(entry.tags, MEMORY_MAX_STYLE_TAGS),
    priority: Math.min(100, Math.max(0, intValue(entry.priority, MEMORY_DEFAULT_STYLE_PRIORITY))),
    enabled: entry.enabled !== false,
    confidence: profileConfidence(entry.confidence),
    source: enumValue(entry.source, STYLE_SOURCES, 'import'),
    ...(memoryTs(entry.ts) !== '' ? { ts: memoryTs(entry.ts) } : {}),
  }
}

/**
 * Validate a document and return the pure import plan (no IO, no mutation).
 *
 * `importMemoryDocument` is the portable-import contract shared by the CLI and
 * the facade: `merge` upserts every persona fact/pattern/style in the document
 * (LWW per key), `replace` additionally resets the persona generation, rejects
 * live patterns that the document does not contain and disables live style rules
 * that the document does not contain. A legacy `confluence.profile/v1` document is
 * persona-only: it never rejects patterns/styles and never resets them.
 *
 * @param {unknown} doc parsed document or canonical JSON text
 * @param {{
 *   mode?: 'merge' | 'replace',
 *   maxPatterns?: number, maxFacts?: number, maxRules?: number,
 *   maxValueBytes?: number, maxExportBytes?: number, maxProfileExportBytes?: number,
 *   live?: {patterns?: unknown, styles?: unknown},
 * }} [options]
 * @returns {Record<string, unknown>} import plan
 */
export function importMemoryDocument(doc, options = {}) {
  const input = isPlainObject(options) ? options : {}
  const mode = input.mode === undefined ? 'merge' : input.mode
  if (mode !== 'merge' && mode !== 'replace') {
    throw new ConfluenceError('BAD_ARGUMENT', `invalid memory import mode: ${String(input.mode)}`)
  }
  const validated = validateMemoryDocument(doc, {
    maxPatterns: input.maxPatterns,
    maxFacts: input.maxFacts,
    maxRules: input.maxRules,
    maxValueBytes: input.maxValueBytes,
    maxExportBytes: input.maxExportBytes,
    maxProfileExportBytes: input.maxProfileExportBytes,
  })
  const personaOnly = validated.kind === 'profile'
  const personaFacts = validated.persona.sections.flatMap((section) =>
    section.facts.map((fact) => ({ section: section.id, ...fact })),
  )
  // Imported rule data is written as active, import-sourced records (owner
  // decision): a portable document restores usable memory, and the provenance is
  // explicit. `merge` upserts; `replace` also rejects/disables what the document
  // no longer contains (see below).
  const patterns = personaOnly
    ? []
    : validated.patterns.map((pattern) => ({ ...pattern, status: 'active', source: 'import' }))
  const styles = personaOnly
    ? []
    : validated.styles.map((style) => ({ ...style, enabled: true, source: 'import' }))
  let rejectPatterns = []
  let disableStyles = []
  if (mode === 'replace' && !personaOnly) {
    const live = isPlainObject(input.live) ? input.live : {}
    const livePatterns = normalizeLivePatterns(live.patterns)
    const liveStyles = normalizeLiveStyles(live.styles)
    const patternKeys = new Set(patterns.map((pattern) => asString(pattern.key)))
    rejectPatterns = livePatterns
      .filter(
        (pattern) => !patternKeys.has(asString(pattern.key)) && pattern.status !== 'rejected' && pattern.status !== 'superseded',
      )
      .map((pattern) => ({ ...pattern, status: 'rejected', source: 'import' }))
    const styleKeys = new Set(styles.map((style) => `${asString(style.channel)}\u0000${asString(style.key)}`))
    disableStyles = liveStyles
      .filter((style) => style.enabled !== false && !styleKeys.has(`${asString(style.channel)}\u0000${asString(style.key)}`))
      .map((style) => ({ ...style, enabled: false, source: 'import' }))
  }
  return {
    ok: true,
    mode,
    format: MEMORY_DOC_FORMAT,
    sourceFormat: validated.sourceFormat,
    kind: validated.kind,
    personaOnly,
    revision: validated.revision,
    generatedAt: validated.generatedAt,
    persona: {
      reset: mode === 'replace',
      facts: personaFacts,
      sections: validated.persona.sections,
      count: personaFacts.length,
    },
    patterns: {
      upsert: patterns,
      reject: rejectPatterns,
      count: patterns.length,
      rejected: rejectPatterns.length,
    },
    styles: {
      upsert: styles,
      disable: disableStyles,
      count: styles.length,
      disabled: disableStyles.length,
    },
    limits: validated.limits,
  }
}

/**
 * Build the append-only record list for an import plan (pure; the caller appends).
 * Pattern and style keys keep their document status; reject/disable records reuse
 * the live entry fields so a later fold keeps a valid LWW winner.
 *
 * @param {unknown} plan result of `importMemoryDocument()`
 * @param {{nextId?: () => string, now?: (() => number) | number, author?: {sessionId?: string, title?: string} | null}} [options]
 * @returns {{patterns: Array<Record<string, unknown>>, styles: Array<Record<string, unknown>>, counts: {patterns: number, styles: number}}}
 */
export function buildMemoryImportRecords(plan, options = {}) {
  const input = isPlainObject(options) ? options : {}
  if (!isPlainObject(plan) || plan.ok !== true) {
    throw new ConfluenceError('BAD_ARGUMENT', 'buildMemoryImportRecords requires an import plan')
  }
  const nowMs = typeof input.now === 'function' ? Number(input.now()) : Number(input.now)
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const ts = isoNow(now)
  const nextId =
    typeof input.nextId === 'function'
      ? input.nextId
      : createUlidFactory(
          () => now,
          typeof input.random === 'function' ? input.random : Math.random,
        )
  /** @type {{sessionId?: string, title?: string}} */
  const author = {}
  if (isPlainObject(input.author)) {
    const sessionId = asString(input.author.sessionId).trim()
    if (sessionId !== '') author.sessionId = truncateChars(sessionId, 128)
    const title = asString(input.author.title).trim()
    if (title !== '') author.title = truncateChars(title, 160)
  }
  if (author.title === undefined && author.sessionId === undefined) author.title = 'memory-import'

  /** @param {Record<string, unknown>} entry @returns {Record<string, unknown>} */
  const patternRecord = (entry) => {
    /** @type {Record<string, unknown>} */
    const record = {
      v: 1,
      type: 'pattern',
      id: `pat_${nextId()}`,
      ws: GLOBAL_SCOPE_KEY,
      key: asString(entry.key),
      category: asString(entry.category),
      title: asString(entry.title),
      body: asString(entry.body),
      tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
      scope: asString(entry.scope) === 'workspace' ? 'workspace' : 'global',
    }
    if (record.scope === 'workspace') {
      if (MEMORY_WORKSPACE_KEY_RE.test(asString(entry.workspaceKey))) record.workspaceKey = asString(entry.workspaceKey)
      if (asString(entry.workspaceLabel) !== '') record.workspaceLabel = asString(entry.workspaceLabel)
    }
    if (record.scope === 'workspace' && !MEMORY_WORKSPACE_KEY_RE.test(asString(entry.workspaceKey))) {
      // Legacy documents may carry only a label: the fold would drop a workspace record
      // without a valid key, so import it as a global rule instead (service leniency).
      record.scope = 'global'
      delete record.workspaceKey
      delete record.workspaceLabel
    }
    record.status = enumValue(entry.status, PATTERN_STATUSES, 'candidate')
    record.confidence = clampConfidence(entry.confidence, MEMORY_DEFAULT_CONFIDENCE)
    record.source = enumValue(entry.source, PATTERN_SOURCES, 'import')
    record.evidence = []
    record.author = { ...author }
    record.ts = memoryTs(entry.ts) !== '' ? asString(entry.ts) : ts
    return record
  }

  /** @param {Record<string, unknown>} entry @returns {Record<string, unknown>} */
  const styleRecord = (entry) => {
    /** @type {Record<string, unknown>} */
    const record = {
      v: 1,
      type: 'style',
      id: `sty_${nextId()}`,
      ws: GLOBAL_SCOPE_KEY,
      channel: enumValue(entry.channel, STYLE_CHANNELS, 'chat'),
      area: enumValue(entry.area, STYLE_AREAS, 'general'),
      key: asString(entry.key),
      title: asString(entry.title),
      rule: asString(entry.rule),
      examples: Array.isArray(entry.examples)
        ? entry.examples
            .filter(isPlainObject)
            .slice(0, MEMORY_MAX_STYLE_EXAMPLES)
            .map((example) => ({ bad: asString(example.bad), good: asString(example.good) }))
        : [],
      tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
      priority: Math.min(100, Math.max(0, intValue(entry.priority, MEMORY_DEFAULT_STYLE_PRIORITY))),
      enabled: entry.enabled !== false,
      confidence: profileConfidence(entry.confidence),
      source: enumValue(entry.source, STYLE_SOURCES, 'import'),
      author: { ...author },
      ts: memoryTs(entry.ts) !== '' ? asString(entry.ts) : ts,
    }
    return record
  }

  /** @type {Array<Record<string, unknown>>} */
  const patterns = []
  for (const entry of [...(plan.patterns?.upsert ?? []), ...(plan.patterns?.reject ?? [])]) {
    patterns.push(patternRecord(entry))
  }
  /** @type {Array<Record<string, unknown>>} */
  const styles = []
  for (const entry of [...(plan.styles?.upsert ?? []), ...(plan.styles?.disable ?? [])]) {
    styles.push(styleRecord(entry))
  }
  return { patterns, styles, counts: { patterns: patterns.length, styles: styles.length } }
}
