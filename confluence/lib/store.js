// Confluence / 高级记忆 — append-only JSONL journal store.
//
// v0.3.0 (ADR-0008): two coexisting scopes over the unchanged directory layout:
//   <rootDir>/workspaces/<wsKey>/MANIFEST.v1.json
//   <rootDir>/workspaces/<wsKey>/journal.<writerId>.v1.jsonl
//   <rootDir>/workspaces/<wsKey>/presence/<writerId>.json
//
// - workspace scope (`ws_<16hex>`): the M1 session bus — keyed context records,
//   note entries and addressed messages. Never merged across workspaces.
// - global scope (`GLOBAL_SCOPE_KEY`, `ws_0000000000000000`): M2 profile facts
//   plus the unchanged metadata-only session ledger and presence heartbeats.
//   v0.4 adds the three global memory record types (`pattern`, `style`,
//   `memory-migration`); their folds and caps live in lib/memory.js and
//   lib/style.js — the store only validates the envelope and minimal shape.
//
// v0.1 per-workspace journals are reused as-is: opening that workspace key reads
// its old records (nothing is migrated or rewritten). v0.2 global-board entries
// stay on disk untouched and are never attributed to a workspace view. The v0.2
// legacy→global read merge is REMOVED from every read path; `legacyRecords()` is
// a separate cold, read-only scan for tooling/export only.
//
// One writer per shard: this process holds one O_APPEND fd and writes complete
// UTF-8 lines with fs.writeSync (≤64 KiB each). Readers merge all shards, sort
// by `seq` and dedupe: immutable event ids (entries, tombstones, context,
// message, profile, profile-reset) first-by-seq wins, session rows max-seq wins.
// Torn trailing lines are ignored and their byte offset remembered. Polling is
// the freshness contract; fs.watch is a best-effort accelerator.
//
// Merged views are cached per scope key (`_mergedRecords: Map<wsKey, records>`)
// and invalidated by that journal's change feed. `openWorkspace` keeps at most
// `config.store.maxOpenWorkspaces` journals open (LRU; the global scope is
// pinned) and `closeWorkspace` closes one explicitly.
//
// Contract: docs/plan/v0.3-interfaces.md §2 and §3.1 (binding), docs/adr/0008.

import nodeFs from 'node:fs'
import nodeFsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ConfluenceError,
  createLogger,
  createUlidFactory,
  isUlid,
  isoNow,
  makeWriterId,
  safeJsonParse,
} from './util.js'

const FORMAT = 'confluence.store/v1'
const FORMAT_VERSION = 1
const MAX_LINE_BYTES = 65536
const MANIFEST_NAME = 'MANIFEST.v1.json'
const SHARD_PATTERN = /^journal\.([0-9]{1,10}-[0-9a-f]{8})\.v1\.jsonl$/
const PRESENCE_FILE_PATTERN = /^([0-9]{1,10}-[0-9a-f]{8})\.json$/
const WS_KEY_PATTERN = /^ws_[0-9a-f]{16}$/
/**
 * Closed record-type vocabulary (v0.3 §2 + v0.4 §1). The three sync points are
 * `KNOWN_RECORD_TYPES`, `isValidKnownRecord()` and `dedupeKeyFor()`.
 */
const KNOWN_RECORD_TYPES = new Set([
  'entry',
  'session',
  'tombstone',
  'context',
  'message',
  'profile',
  'profile-reset',
  'pattern',
  'style',
  'memory-migration',
])

/**
 * Reserved global memory-scope key (ADR-0008). Holds the user profile facts and
 * the metadata-only ledger/presence rows. It can never collide with a real
 * workspace because it is reserved by contract. It is pinned in the open-journal
 * LRU: the global journal is the profile's home and is never evicted.
 */
export const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'

/** Human-readable label of the global scope (UI/pulse/tool wording). */
export const GLOBAL_SCOPE_LABEL = 'All sessions'
const DEFAULT_RETRY_DELAYS = [50, 150, 400]
const WATCH_DEBOUNCE_MS = 400
const MAX_PRESENCE_SCAN = 256
const MAX_POLL_MS = 10 * 60 * 1000
const DEFAULT_MAX_OPEN_WORKSPACES = 16
const MAX_OPEN_WORKSPACES = 128
const EMPTY_RECORDS = Object.freeze([])

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/** @param {string} a @param {string} b @returns {number} */
function compareStrings(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => {
    if (!(ms > 0)) setImmediate(resolve)
    else setTimeout(resolve, ms)
  })
}

/** @param {unknown} error @returns {boolean} */
function isTransientError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EMFILE' || code === 'ENFILE'
}

/**
 * @param {unknown} logger
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function normalizeLogger(logger) {
  const silent = createLogger(false)
  if (!logger || typeof logger !== 'object') return silent
  const out = {}
  for (const level of ['debug', 'info', 'warn', 'error']) {
    const fn = typeof logger[level] === 'function' ? logger[level] : null
    out[level] = (record) => {
      if (!fn) return
      try {
        fn.call(logger, record)
      } catch {
        // never let diagnostics break storage
      }
    }
  }
  return Object.freeze(out)
}

/**
 * Dedupe key of one record for the merged view. Session rows are upserts keyed by
 * session id; every other known type is an immutable, unique-id event, so its own
 * id is the key (a re-read line can never shadow a newer event and LWW folds such
 * as context/message/profile keep every record they need).
 *
 * @param {Record<string, unknown>} record
 * @returns {string | null}
 */
function dedupeKeyFor(record) {
  if (record.type === 'session') {
    const id = record.sessionId !== undefined && record.sessionId !== null ? record.sessionId : record.id
    return typeof id === 'string' && id !== '' ? `session:${id}` : null
  }
  // v0.4 global memory records (`pattern`/`style`/`memory-migration`) are
  // immutable append-only events: an update is a NEW record with a new id, so
  // the id dedupes a re-read line while the owning service folds LWW per key.
  if (record.type === 'pattern' || record.type === 'style' || record.type === 'memory-migration') {
    return typeof record.id === 'string' && record.id !== '' ? `${record.type}:${record.id}` : null
  }
  if (typeof record.id === 'string' && record.id !== '') return `${record.type}:${record.id}`
  return null
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {number} */
function compareRecords(a, b) {
  const bySeq = compareStrings(String(a.seq ?? ''), String(b.seq ?? ''))
  if (bySeq !== 0) return bySeq
  const aId = a.id !== undefined ? a.id : a.sessionId
  const bId = b.id !== undefined ? b.id : b.sessionId
  return compareStrings(String(aId ?? ''), String(bId ?? ''))
}

/** @param {unknown} value @returns {boolean} */
function looksLikeId(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * @param {unknown} record
 * @returns {boolean} envelope-valid known record (type-specific minimal shape)
 */
function isValidKnownRecord(record) {
  if (record.v !== 1) return false
  if (!isUlid(record.seq)) return false
  if (typeof record.ts !== 'string' || record.ts === '') return false
  if (record.type === 'entry') return looksLikeId(record.id)
  if (record.type === 'session') return looksLikeId(record.sessionId) || looksLikeId(record.id)
  if (record.type === 'tombstone') return looksLikeId(record.target) || looksLikeId(record.id)
  // v0.3 record types. The store validates the envelope/shape only; caps and
  // vocabularies are enforced by the owning services (context, bus, profile).
  if (record.type === 'context') {
    if (!looksLikeId(record.id) || !isNonEmptyString(record.key)) return false
    if (record.deleted === true) return true
    if (typeof record.value !== 'string') return false
    if (record.valueType !== undefined && record.valueType !== 'text' && record.valueType !== 'json') return false
    return true
  }
  if (record.type === 'message') {
    if (!looksLikeId(record.id) || !isNonEmptyString(record.kind)) return false
    if (typeof record.body !== 'string') return false
    if (!isPlainObject(record.from) || !isNonEmptyString(record.from.sessionId)) return false
    if (!isPlainObject(record.to)) return false
    if (record.to.kind === 'workspace') return true
    return isNonEmptyString(record.to.sessionId)
  }
  if (record.type === 'profile') {
    if (!looksLikeId(record.id) || !isNonEmptyString(record.section) || !isNonEmptyString(record.key)) return false
    if (record.deleted === true) return true
    return typeof record.value === 'string'
  }
  if (record.type === 'profile-reset') return looksLikeId(record.id)
  // v0.4 global memory types. Envelope + minimal shape only here: categories,
  // statuses, caps and redaction are enforced by lib/memory.js / lib/style.js
  // (a forged record is ignored by their folds, never by the store).
  if (record.type === 'pattern') return looksLikeId(record.id) && isNonEmptyString(record.key)
  if (record.type === 'style') {
    return looksLikeId(record.id) && isNonEmptyString(record.key) && isNonEmptyString(record.channel)
  }
  if (record.type === 'memory-migration') return looksLikeId(record.id)
  return false
}

/**
 * Validate a v1 manifest for one workspace key. An empty `workspace.canonicalPath`
 * is accepted only for the reserved global scope key (ADR-0007); every real
 * workspace manifest must carry its canonical directory.
 *
 * @param {unknown} manifest
 * @param {string} wsKey expected workspace key
 * @returns {boolean}
 */
function isValidManifest(manifest, wsKey) {
  if (!isPlainObject(manifest)) return false
  if (manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION) return false
  if (manifest.ws !== wsKey) return false
  if (!isPlainObject(manifest.workspace)) return false
  const canonicalPath = manifest.workspace.canonicalPath
  if (typeof canonicalPath !== 'string') return false
  if (canonicalPath === '') return wsKey === GLOBAL_SCOPE_KEY
  return true
}

/**
 * Sort + dedupe a record list with the v1 journal rules: immutable ids
 * (entries/tombstones) first-by-seq wins, session rows max-seq win.
 *
 * @param {object[]} records
 * @returns {object[]}
 */
function mergeRecordList(records) {
  const all = [...records].sort(compareRecords)
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map()
  for (const record of all) {
    const key = dedupeKeyFor(record)
    if (key === null) continue
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, record)
      continue
    }
    const cmp = compareStrings(String(record.seq ?? ''), String(existing.seq ?? ''))
    if (record.type === 'session') {
      if (cmp > 0) byKey.set(key, record)
      else if (cmp === 0 && JSON.stringify(record) < JSON.stringify(existing)) byKey.set(key, record)
    } else if (cmp < 0) {
      byKey.set(key, record)
    } else if (cmp === 0 && JSON.stringify(record) < JSON.stringify(existing)) {
      byKey.set(key, record)
    }
  }
  return [...byKey.values()].sort(compareRecords)
}

/**
 * Parse a complete legacy shard read from disk: whole LF-terminated lines only
 * (a torn trailing line is ignored exactly like the live journal reader).
 *
 * @param {string} raw shard bytes decoded as UTF-8
 * @param {string} wsKey legacy workspace key the shard belongs to
 * @returns {object[]}
 */
function parseLegacyShard(raw, wsKey) {
  const records = []
  const text = typeof raw === 'string' ? raw : String(raw)
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // The final split element is the unterminated tail ('' when the shard ends
    // with LF): never a complete record.
    if (line === '' || index === lines.length - 1) continue
    if (Buffer.byteLength(line, 'utf8') + 1 > MAX_LINE_BYTES) continue
    const parsed = safeJsonParse(line)
    if (!parsed.ok || !isPlainObject(parsed.value)) continue
    const record = parsed.value
    if (record.ws !== wsKey) continue
    if (typeof record.type !== 'string' || !KNOWN_RECORD_TYPES.has(record.type)) continue
    if (!isValidKnownRecord(record)) continue
    records.push(record)
  }
  return records
}

/**
 * Parse the new bytes of one shard. Complete lines become records; an
 * unterminated trailing line is left unconsumed (its offset is remembered by
 * the caller for the next refresh).
 *
 * @param {Buffer} chunk bytes starting at the previous consumed offset
 * @param {string} wsKey expected workspace key
 * @param {{invalid: number, unsupported: number}} stats
 * @returns {{records: object[], consumedBytes: number}}
 */
function parseShardChunk(chunk, wsKey, stats) {
  const records = []
  let lineStart = 0
  let lastNewline = -1
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] !== 0x0a) continue
    processLine(chunk.subarray(lineStart, index))
    lastNewline = index
    lineStart = index + 1
  }
  const tailBytes = chunk.length - (lastNewline + 1)
  // A tail that has grown absurdly large can never become a valid line; drop it
  // instead of retaining unbounded garbage (store-format.md §6).
  if (tailBytes > MAX_LINE_BYTES * 4) {
    stats.invalid += 1
    return { records, consumedBytes: chunk.length }
  }
  return { records, consumedBytes: lastNewline + 1 }

  /** @param {Buffer} lineBuffer */
  function processLine(lineBuffer) {
    if (lineBuffer.length === 0) {
      stats.invalid += 1
      return
    }
    if (lineBuffer.length + 1 > MAX_LINE_BYTES) {
      stats.invalid += 1
      return
    }
    const parsed = safeJsonParse(lineBuffer.toString('utf8'))
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      stats.invalid += 1
      return
    }
    const record = parsed.value
    if (record.ws !== wsKey) {
      stats.invalid += 1
      return
    }
    if (typeof record.type !== 'string') {
      stats.invalid += 1
      return
    }
    if (!KNOWN_RECORD_TYPES.has(record.type)) {
      stats.unsupported += 1
      return
    }
    if (!isValidKnownRecord(record)) {
      stats.invalid += 1
      return
    }
    records.push(record)
  }
}

/**
 * JournalStore — one per plugin mount. Owns the writer id, the store root and
 * the per-workspace journals (merged read caches).
 */
export class JournalStore {
  /**
   * @param {{config?: object, logger?: object, deps?: object}} [options]
   * deps: { fs, fsSync, now, random, pid, env, homedir, platform, watch, retryDelays }
   */
  constructor({ config, logger, deps } = {}) {
    this.config = isPlainObject(config) ? config : {}
    this.logger = normalizeLogger(logger)
    this.deps = isPlainObject(deps) ? deps : {}

    this._fsp = this.deps.fs && typeof this.deps.fs.readFile === 'function' ? this.deps.fs : nodeFsPromises
    this._fsSync = this.deps.fsSync && typeof this.deps.fsSync.openSync === 'function' ? this.deps.fsSync : nodeFs
    this._now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this._random = typeof this.deps.random === 'function' ? this.deps.random : Math.random
    this._retryDelays = Array.isArray(this.deps.retryDelays) ? this.deps.retryDelays.slice() : DEFAULT_RETRY_DELAYS.slice()
    this._platform = typeof this.deps.platform === 'string' ? this.deps.platform : process.platform
    this._watchImpl =
      typeof this.deps.watch === 'function'
        ? this.deps.watch
        : typeof this.deps.watchImpl === 'function'
          ? this.deps.watchImpl
          : nodeFs.watch

    const env = isPlainObject(this.deps.env) ? this.deps.env : process.env
    this._dshHome =
      typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : this._defaultDshHome()
    this._defaultRootDir = path.join(this._dshHome, 'storages', 'confluence', 'v1')
    this._rootDir = this._resolveRootDir(this.config.store && this.config.store.dir)

    this.writerId = makeWriterId(this.deps.pid !== undefined ? this.deps.pid : process.pid, this._random)
    this._ulid = createUlidFactory(this._now, this._random)

    /** @type {Map<string, WorkspaceJournal>} */
    this._journals = new Map()
    /** @type {Map<string, Promise<WorkspaceJournal>>} single-flight opens by key */
    this._opening = new Map()
    /** @type {Map<string, {wsKey: string, canonicalPath: string, createdAt: string | null}>} */
    this._meta = new Map()
    /** @type {readonly object[] | null} cold read-only legacy scan (tooling/export only) */
    this._legacyRecords = null
    /**
     * Per-scope merged view cache (v0.3 §3.1): the deduped+ordered records of
     * exactly that scope's journal, invalidated by its change feed. Values are
     * the frozen record arrays returned by `viewedRecords()`.
     * @type {Map<string, readonly object[]>}
     */
    this._mergedRecords = new Map()
    /** @type {Map<string, Set<(changed: boolean) => void>>} */
    this._mergedListeners = new Map()
    /** @type {Map<string, () => void>} journal change-feed unsubscribe per scope */
    this._mergedBridges = new Map()
    /** @type {Map<string, number>} scope key -> last-use tick (LRU order) */
    this._lru = new Map()
    this._lruTick = 0
    this._maxOpenWorkspaces = this._intConfig(
      this.config.store && this.config.store.maxOpenWorkspaces,
      DEFAULT_MAX_OPEN_WORKSPACES,
      // The global scope is pinned and can never be evicted, so the effective
      // floor is 2 (global + one workspace journal).
      2,
      MAX_OPEN_WORKSPACES,
    )
    this._inited = false
    this._closed = false
  }

  /**
   * Read an integer config value with bounds fallback (config.resolveConfig
   * already clamps; this is defence in depth for hand-built configs in tests).
   *
   * @param {unknown} value
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  _intConfig(value, fallback, min, max) {
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.max(min, Math.min(max, Math.trunc(numeric)))
  }

  /** Resolved store root (`<DSH_HOME>/storages/confluence/v1` by default). */
  get rootDir() {
    return this._rootDir
  }

  /** @returns {string} */
  _defaultDshHome() {
    try {
      const homedir = typeof this.deps.homedir === 'function' ? this.deps.homedir : os.homedir
      return path.join(homedir(), '.dsh')
    } catch {
      return path.join(process.cwd(), '.dsh')
    }
  }

  /**
   * @param {unknown} dir config.store.dir
   * @returns {string}
   */
  _resolveRootDir(dir) {
    if (typeof dir === 'string' && dir.trim() !== '') {
      const trimmed = dir.replace(/[\\/]+$/, '')
      if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
        if (/^\\\\[.?]\\/.test(trimmed)) return this._defaultRootDir
        return trimmed
      }
      const cleaned = trimmed.replace(/^[\\/]+/, '')
      return path.join(this._dshHome, 'storages', 'confluence', cleaned)
    }
    return this._defaultRootDir
  }

  /** @param {() => Promise<any>} operation @returns {Promise<any>} retry on transient Windows errors */
  async _retry(operation) {
    let lastError
    for (let attempt = 0; attempt <= this._retryDelays.length; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (!isTransientError(error) || attempt === this._retryDelays.length) throw error
        await delay(this._retryDelays[attempt])
      }
    }
    throw lastError
  }

  /**
   * Prepare the store root. Idempotent; safe to call before any other method.
   * @returns {Promise<this>}
   */
  async init() {
    if (this._inited) return this
    if (this._closed) throw new ConfluenceError('STORE_UNAVAILABLE', 'store is closed')
    try {
      const stat = await this._fsp.stat(this._rootDir).catch((error) => {
        if (error && error.code === 'ENOENT') return null
        throw error
      })
      if (stat && !stat.isDirectory()) {
        this.logger.warn({ event: 'store.root_is_file', rootDir: this._rootDir })
        this._rootDir = this._defaultRootDir
      }
      await this._fsp.mkdir(this._rootDir, { recursive: true })
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `cannot prepare store root: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    this._inited = true
    // A cold legacy audit started before the root existed must be re-run; live
    // per-scope views are unaffected (no legacy record enters a v0.3 view).
    this._legacyRecords = null
    return this
  }

  /**
   * Open (or reuse) one workspace journal. Scopes share one journal instance via
   * single-flight: board, context, bus, ledger and presence for the same key get
   * the same fd/timer/watcher and appends can never lag the merged view.
   *
   * A canonical path is mandatory when creating a NEW non-global manifest; the
   * global scope key is the only manifest allowed to carry an empty path. An
   * existing manifest (including a reused v0.1 workspace directory) may still be
   * opened by key without a path; its files are never rewritten.
   *
   * At most `config.store.maxOpenWorkspaces` journals stay open; the least
   * recently used non-global scope is closed. The global scope is pinned.
   *
   * @param {string} wsKey `ws_` + 16 hex
   * @param {{canonicalPath?: string, label?: string}} [meta]
   * @returns {Promise<WorkspaceJournal>}
   */
  async openWorkspace(wsKey, meta = {}) {
    if (typeof wsKey !== 'string' || !WS_KEY_PATTERN.test(wsKey)) {
      throw new ConfluenceError('BAD_ARGUMENT', `invalid workspace key: ${String(wsKey)}`)
    }
    if (this._closed) throw new ConfluenceError('STORE_UNAVAILABLE', 'store is closed')
    await this.init()
    const existing = this._journals.get(wsKey)
    if (existing !== undefined) {
      this._touch(wsKey)
      return existing
    }

    const opening = this._opening.get(wsKey)
    if (opening !== undefined) {
      const journal = await opening
      this._touch(wsKey)
      return journal
    }
    const pending = this._openWorkspaceOnce(wsKey, meta)
    this._opening.set(wsKey, pending)
    try {
      const journal = await pending
      this._touch(wsKey)
      return journal
    } finally {
      if (this._opening.get(wsKey) === pending) this._opening.delete(wsKey)
    }
  }

  /** Mark a scope as most recently used (LRU order). @param {string} wsKey */
  _touch(wsKey) {
    this._lruTick += 1
    this._lru.set(wsKey, this._lruTick)
  }

  /**
   * Close least-recently-used non-global journals until the open cap holds.
   * The global scope is pinned: the profile/ledger/presence home must never be
   * evicted from under its long-lived services.
   * @returns {Promise<void>}
   */
  async _enforceLruCap() {
    while (this._journals.size > this._maxOpenWorkspaces) {
      let victim = null
      for (const key of this._journals.keys()) {
        if (key === GLOBAL_SCOPE_KEY) continue
        if (victim === null) {
          victim = key
          continue
        }
        if ((this._lru.get(key) ?? 0) < (this._lru.get(victim) ?? 0)) victim = key
      }
      if (victim === null) break
      await this.closeWorkspace(victim)
    }
  }

  /**
   * Close one scope journal explicitly (flush + close fd, stop timer/watcher,
   * drop change-feed subscription). The last merged snapshot is retained so
   * synchronous reads of the scope stay coherent until it is re-opened; the
   * snapshot is replaced by the fresh journal view on the next open. Idempotent.
   *
   * @param {string} wsKey
   * @returns {Promise<boolean>} true when a journal was open and is now closed
   */
  async closeWorkspace(wsKey) {
    if (typeof wsKey !== 'string' || !WS_KEY_PATTERN.test(wsKey)) return false
    const journal = this._journals.get(wsKey)
    if (journal === undefined) return false
    this._journals.delete(wsKey)
    this._lru.delete(wsKey)
    try {
      const records = journal.records()
      if (Array.isArray(records)) {
        this._mergedRecords.set(wsKey, Object.isFrozen(records) ? records : Object.freeze(records))
      }
    } catch (error) {
      this.logger.debug({ event: 'store.close_snapshot_failed', wsKey, message: error?.message })
    }
    const unsubscribe = this._mergedBridges.get(wsKey)
    if (unsubscribe !== undefined) {
      this._mergedBridges.delete(wsKey)
      try {
        unsubscribe()
      } catch {
        // ignore a stale unsubscribe
      }
    }
    try {
      await journal.close()
    } catch (error) {
      this.logger.warn({ event: 'store.close_workspace_failed', wsKey, message: error?.message })
    }
    this.logger.debug({ event: 'store.workspace_closed', wsKey })
    return true
  }

  /**
   * Create one workspace journal (single-flight; callers go through `openWorkspace`).
   * @param {string} wsKey
   * @param {object} meta
   * @returns {Promise<WorkspaceJournal>}
   */
  async _openWorkspaceOnce(wsKey, meta) {
    const requested = isPlainObject(meta) ? meta : {}
    const isGlobal = wsKey === GLOBAL_SCOPE_KEY
    const effectiveMeta = isGlobal
      ? {
          canonicalPath: '',
          label: isNonEmptyString(requested.label) ? requested.label : GLOBAL_SCOPE_LABEL,
        }
      : requested

    const dir = path.join(this._rootDir, 'workspaces', wsKey)
    // Only the workspace directory here: `presence/` is created lazily by
    // writePresence, so opening an existing legacy journal for reading does not
    // add files to it (ADR-0007 legacy files stay untouched).
    await this._fsp.mkdir(dir, { recursive: true })
    const manifest = await this._loadOrCreateManifest(wsKey, dir, effectiveMeta)
    const canonicalPath = manifest.workspace.canonicalPath
    const createdAt = typeof manifest.workspace.createdAt === 'string' ? manifest.workspace.createdAt : null
    this._meta.set(wsKey, Object.freeze({ wsKey, canonicalPath, createdAt }))

    const journal = new WorkspaceJournal({
      store: this,
      wsKey,
      dir,
      config: this.config,
      deps: this.deps,
      fsp: this._fsp,
      fsSync: this._fsSync,
      logger: this.logger,
      ulid: this._ulid,
      now: this._now,
    })
    await journal.refresh({ force: true })
    journal.start()
    this._journals.set(wsKey, journal)
    // Every scope gets its own merged-view bridge: a journal change invalidates
    // exactly that scope's cached records and notifies that scope's listeners.
    this._invalidateMerged(wsKey)
    this._attachMergedBridge(wsKey, journal)
    this._touch(wsKey) // the newly opened scope is the most recently used
    this.logger.debug({ event: 'store.workspace_opened', wsKey })
    await this._enforceLruCap()
    return journal
  }

  /**
   * @param {string} wsKey
   * @param {string} dir
   * @param {{canonicalPath?: string, label?: string}} meta
   * @returns {Promise<object>} manifest
   */
  async _loadOrCreateManifest(wsKey, dir, meta) {
    const file = path.join(dir, MANIFEST_NAME)
    const isGlobal = wsKey === GLOBAL_SCOPE_KEY
    const canonicalPath = typeof meta.canonicalPath === 'string' ? meta.canonicalPath : ''
    const label = isNonEmptyString(meta.label) ? meta.label : isGlobal ? GLOBAL_SCOPE_LABEL : ''

    if (!isGlobal && canonicalPath === '') {
      // No path supplied: this can only be an existing legacy journal. Never
      // create a pathless manifest for a real workspace (validation rejects it).
      let exists = true
      try {
        await this._fsp.stat(file)
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw new ConfluenceError('STORE_UNAVAILABLE', `cannot stat store manifest: ${error?.message ?? error}`, {
            cause: error,
          })
        }
        exists = false
      }
      if (!exists) {
        throw new ConfluenceError(
          'BAD_ARGUMENT',
          `canonicalPath is required to create the workspace journal for ${wsKey}`,
        )
      }
      return await this._readManifest(file, wsKey)
    }

    const createdAt = isoNow(this._now())
    /** @type {Record<string, unknown>} */
    const workspace = { key: wsKey, canonicalPath, createdAt }
    if (label !== '') workspace.label = label
    const initial = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      ws: wsKey,
      workspace,
      generation: 0,
      snapshot: null,
      shards: [],
      seqRange: { min: null, max: null },
      updatedAt: createdAt,
    }
    try {
      const fd = this._fsSync.openSync(file, 'wx', 0o600)
      try {
        this._fsSync.writeSync(fd, JSON.stringify(initial))
        this._fsSync.fsyncSync(fd)
      } finally {
        this._fsSync.closeSync(fd)
      }
      return initial
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw new ConfluenceError('STORE_UNAVAILABLE', `cannot create store manifest: ${error?.message ?? error}`, {
          cause: error,
        })
      }
    }

    const manifest = await this._readManifest(file, wsKey)
    if (
      typeof meta.canonicalPath === 'string' &&
      meta.canonicalPath !== '' &&
      manifest.workspace.canonicalPath !== '' &&
      manifest.workspace.canonicalPath !== meta.canonicalPath
    ) {
      throw new ConfluenceError(
        'STORE_UNAVAILABLE',
        `workspace key collision: ${wsKey} is already bound to another canonical path`,
      )
    }
    return manifest
  }

  /**
   * Read and validate an existing manifest. Throws STORE_UNAVAILABLE when the
   * file is unreadable or not a valid v1 manifest for `wsKey`.
   *
   * @param {string} file
   * @param {string} wsKey
   * @returns {Promise<object>}
   */
  async _readManifest(file, wsKey) {
    let raw
    try {
      raw = await this._retry(() => this._fsp.readFile(file, 'utf8'))
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `cannot read store manifest: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    const parsed = safeJsonParse(raw)
    const manifest = parsed.ok ? parsed.value : null
    if (!isValidManifest(manifest, wsKey)) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `invalid store manifest for ${wsKey}`)
    }
    return manifest
  }

  /**
   * List every valid workspace manifest under the store root, for the facade /
   * panel workspace list. Tolerant: one bad directory/manifest never fails the
   * listing. Shape: `{ key, label, canonicalPath?, createdAt }` where `key` is
   * the opaque `ws_<16hex>` id and `canonicalPath` is internal only (never put a
   * raw path in a panel payload; `label` is basename/registry title only).
   *
   * @returns {Promise<{key: string, label: string, canonicalPath?: string, createdAt: string | null}[]>}
   */
  async listWorkspaces() {
    await this.init()
    const out = []
    let dirents
    try {
      dirents = await this._fsp.readdir(path.join(this._rootDir, 'workspaces'), { withFileTypes: true })
    } catch {
      return out
    }
    for (const dirent of dirents) {
      if (!dirent || typeof dirent.isDirectory !== 'function' || !dirent.isDirectory()) continue
      const wsKey = dirent.name
      if (typeof wsKey !== 'string' || !WS_KEY_PATTERN.test(wsKey)) continue
      try {
        const raw = await this._retry(() =>
          this._fsp.readFile(path.join(this._rootDir, 'workspaces', wsKey, MANIFEST_NAME), 'utf8'),
        )
        const parsed = safeJsonParse(raw)
        const manifest = parsed.ok ? parsed.value : null
        if (!isValidManifest(manifest, wsKey)) continue
        const canonicalPath = manifest.workspace.canonicalPath
        const createdAt =
          typeof manifest.workspace.createdAt === 'string' ? manifest.workspace.createdAt : null
        /** @type {{key: string, label: string, canonicalPath?: string, createdAt: string | null}} */
        const item = {
          key: wsKey,
          label: this._manifestLabel(manifest, wsKey, canonicalPath),
          createdAt,
        }
        if (canonicalPath !== '') item.canonicalPath = canonicalPath
        this._meta.set(wsKey, Object.freeze({ wsKey, canonicalPath, createdAt }))
        out.push(item)
      } catch {
        // tolerant by contract: skip the bad workspace only
      }
    }
    out.sort((a, b) => compareStrings(a.key, b.key))
    return out
  }

  /**
   * Cached workspace metadata from the manifest read at open/list time.
   *
   * @param {string} wsKey
   * @returns {{wsKey: string, canonicalPath: string, createdAt: string | null} | null}
   */
  workspaceMeta(wsKey) {
    if (typeof wsKey !== 'string') return null
    const cached = this._meta.get(wsKey)
    if (!cached) return null
    return { wsKey: cached.wsKey, canonicalPath: cached.canonicalPath, createdAt: cached.createdAt }
  }

  /**
   * The open global journal, or null before `openGlobal()`.
   *
   * @returns {WorkspaceJournal | null}
   */
  globalJournal() {
    const journal = this._journals.get(GLOBAL_SCOPE_KEY)
    return journal === undefined ? null : journal
  }

  /**
   * Open (or reuse) the global scope journal (profile + ledger/presence rows).
   * Idempotent; the manifest carries an empty canonical path by contract
   * (ADR-0008).
   *
   * @returns {Promise<WorkspaceJournal>}
   */
  async openGlobal() {
    return await this.openWorkspace(GLOBAL_SCOPE_KEY, {
      canonicalPath: '',
      label: GLOBAL_SCOPE_LABEL,
    })
  }

  /**
   * Workspace manifests still present on disk, as labels/provenance metadata for
   * cold tooling/export scans. Read-only synchronous scan; never writes. Excludes
   * the global key (v0.1 never wrote it).
   *
   * @returns {{wsKey: string, canonicalPath: string, label: string}[]}
   */
  legacyWorkspaceMeta() {
    return this._scanLegacyWorkspaces().map((meta) => ({
      wsKey: meta.wsKey,
      canonicalPath: meta.canonicalPath,
      label: meta.label,
    }))
  }

  /**
   * Cold, read-only scan of every per-workspace journal directory on disk (v0.1
   * workspace directories are reused as workspace journals in v0.3). This is a
   * tooling/export-only audit surface: it is NOT part of any live read path and
   * its records are never merged into a scope view. Sorted by seq and deduped by
   * the journal rules; corrupt manifests/lines are skipped, never thrown. The
   * result is cached for the process once the store root exists.
   *
   * @returns {readonly object[]}
   */
  legacyRecords() {
    if (this._legacyRecords !== null) return this._legacyRecords
    /** @type {object[]} */
    const all = []
    for (const meta of this._scanLegacyWorkspaces()) {
      let names = []
      try {
        names = this._fsSync.readdirSync(meta.dir)
      } catch {
        names = []
      }
      if (!Array.isArray(names)) names = []
      names = names.filter((name) => typeof name === 'string' && SHARD_PATTERN.test(name)).sort()
      for (const name of names) {
        try {
          const raw = this._fsSync.readFileSync(path.join(meta.dir, name), 'utf8')
          for (const record of parseLegacyShard(raw, meta.wsKey)) all.push(record)
        } catch (error) {
          this.logger.debug({
            event: 'store.legacy_shard_skipped',
            wsKey: meta.wsKey,
            file: name,
            message: error?.message,
          })
        }
      }
    }
    const records = Object.freeze(mergeRecordList(all))
    // Only cache after the store root is prepared: a pre-init scan cannot see
    // the profile's journals and must not poison the one-time audit read.
    if (this._inited) this._legacyRecords = records
    return records
  }

  /**
   * Compatibility alias for the global scope view (`viewedRecords(GLOBAL_SCOPE_KEY)`).
   * The v0.2 legacy→global merge is gone: this returns only the global journal's
   * records (profile facts plus the metadata ledger/presence rows) and nothing
   * from any workspace journal.
   *
   * @returns {readonly object[]}
   */
  mergedRecords() {
    return this.viewedRecords(GLOBAL_SCOPE_KEY)
  }

  /**
   * Subscribe to merged-view changes of one scope. The per-scope cache is
   * invalidated before listeners run. Safe to call before the scope is opened.
   *
   * The one-argument form (`onMergedChange(cb)`) is kept as a tolerant
   * compatibility shim for v0.2 global-scope callers.
   *
   * @param {string | ((changed: boolean) => void)} scopeKey
   * @param {(changed: boolean) => void} [callback]
   * @returns {() => void} unsubscribe
   */
  onMergedChange(scopeKey, callback) {
    if (typeof scopeKey === 'function' && callback === undefined) {
      callback = scopeKey
      scopeKey = GLOBAL_SCOPE_KEY
    }
    if (typeof scopeKey !== 'string' || !WS_KEY_PATTERN.test(scopeKey)) return () => {}
    if (typeof callback !== 'function') return () => {}
    let listeners = this._mergedListeners.get(scopeKey)
    if (listeners === undefined) {
      listeners = new Set()
      this._mergedListeners.set(scopeKey, listeners)
    }
    listeners.add(callback)
    return () => {
      const current = this._mergedListeners.get(scopeKey)
      if (current === undefined) return
      current.delete(callback)
      if (current.size === 0) this._mergedListeners.delete(scopeKey)
    }
  }

  /**
   * Refresh one scope's merged view: rescan its journal and invalidate the cached
   * records when they changed. When a journal exists on disk but was not opened
   * by this mount (tooling/export), it is opened read-only; a scope with no
   * manifest on disk is never created by this call. Returns whether anything
   * changed (or a journal was opened). Never throws on a read path.
   *
   * @param {string} scopeKey
   * @returns {Promise<boolean>}
   */
  async refreshMerged(scopeKey) {
    if (typeof scopeKey !== 'string' || !WS_KEY_PATTERN.test(scopeKey)) return false
    if (this._closed) return false
    let journal = this._journals.get(scopeKey)
    let opened = false
    if (journal === undefined) {
      try {
        if (!(await this._scopeManifestExists(scopeKey))) return false
        journal = await this.openWorkspace(scopeKey)
        opened = true
      } catch (error) {
        this.logger.warn({ event: 'store.scope_open_failed', wsKey: scopeKey, message: error?.message })
        return false
      }
    }
    let changed = false
    try {
      changed = await journal.refresh()
    } catch (error) {
      this.logger.warn({ event: 'store.scope_refresh_failed', wsKey: scopeKey, message: error?.message })
      return opened
    }
    if (changed) this._invalidateMerged(scopeKey)
    return changed || opened
  }

  /**
   * Read-only existence probe for one scope manifest. Used by `refreshMerged` so
   * a read never creates a scope as a side effect.
   *
   * @param {string} scopeKey
   * @returns {Promise<boolean>}
   */
  async _scopeManifestExists(scopeKey) {
    try {
      const stat = await this._retry(() =>
        this._fsp.stat(path.join(this._rootDir, 'workspaces', scopeKey, MANIFEST_NAME)),
      )
      return stat !== null && stat !== undefined
    } catch {
      return false
    }
  }

  /**
   * Synchronous per-scope merged view (v0.3 §3.1): the deduped+ordered records of
   * exactly that scope's journal and nothing else. Safe on any read path: an
   * unknown/never-opened scope yields a frozen empty array, never a throw. The
   * last snapshot of a closed scope stays cached until it is re-opened.
   *
   * @param {string} scopeKey
   * @returns {readonly object[]}
   */
  viewedRecords(scopeKey) {
    if (typeof scopeKey !== 'string' || !WS_KEY_PATTERN.test(scopeKey)) return EMPTY_RECORDS
    const journal = this._journals.get(scopeKey)
    const cached = this._mergedRecords.get(scopeKey)
    if (journal === undefined) return cached !== undefined ? cached : EMPTY_RECORDS
    this._touch(scopeKey)
    if (cached !== undefined) return cached
    /** @type {readonly object[]} */
    let records = EMPTY_RECORDS
    try {
      const current = journal.records()
      if (Array.isArray(current)) records = Object.isFrozen(current) ? current : Object.freeze(current)
    } catch (error) {
      this.logger.warn({ event: 'store.viewed_records_failed', wsKey: scopeKey, message: error?.message })
    }
    this._mergedRecords.set(scopeKey, records)
    return records
  }

  /** @param {unknown} canonicalPath @returns {string} basename only ('' when none) */
  _basenameOf(canonicalPath) {
    if (typeof canonicalPath !== 'string' || canonicalPath === '') return ''
    const basename =
      this._platform === 'win32' ? path.win32.basename(canonicalPath) : path.basename(canonicalPath)
    return basename === '' ? '' : basename
  }

  /**
   * Provenance label for one manifest: explicit label first (v0.2 manifests),
   * then the basename of the canonical path, then the workspace key. A raw path
   * is never exposed.
   *
   * @param {unknown} manifest
   * @param {string} wsKey
   * @param {string} canonicalPath
   * @returns {string}
   */
  _manifestLabel(manifest, wsKey, canonicalPath) {
    const workspace = isPlainObject(manifest) && isPlainObject(manifest.workspace) ? manifest.workspace : null
    const label = workspace && isNonEmptyString(workspace.label) ? workspace.label : ''
    if (label !== '') return label
    if (wsKey === GLOBAL_SCOPE_KEY) return GLOBAL_SCOPE_LABEL
    const basename = this._basenameOf(canonicalPath)
    return basename !== '' ? basename : wsKey
  }

  /**
   * Synchronous scan of legacy per-workspace manifests. Tolerant: a missing
   * `workspaces/` directory, unreadable manifest or invalid shape is skipped.
   *
   * @returns {{wsKey: string, canonicalPath: string, label: string, dir: string}[]}
   */
  _scanLegacyWorkspaces() {
    const out = []
    const fsSync = this._fsSync
    if (!fsSync || typeof fsSync.readdirSync !== 'function' || typeof fsSync.readFileSync !== 'function') return out
    const workspacesDir = path.join(this._rootDir, 'workspaces')
    let dirents
    try {
      dirents = fsSync.readdirSync(workspacesDir, { withFileTypes: true })
    } catch {
      return out
    }
    if (!Array.isArray(dirents)) return out
    for (const dirent of dirents) {
      try {
        if (!dirent || typeof dirent.isDirectory !== 'function' || !dirent.isDirectory()) continue
        const wsKey = dirent.name
        if (typeof wsKey !== 'string' || !WS_KEY_PATTERN.test(wsKey) || wsKey === GLOBAL_SCOPE_KEY) continue
        const dir = path.join(workspacesDir, wsKey)
        const raw = fsSync.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')
        const parsed = safeJsonParse(raw)
        if (!parsed.ok || !isValidManifest(parsed.value, wsKey)) continue
        const manifest = parsed.value
        const canonicalPath = manifest.workspace.canonicalPath
        out.push(
          Object.freeze({
            wsKey,
            canonicalPath,
            label: this._manifestLabel(manifest, wsKey, canonicalPath),
            dir,
          }),
        )
      } catch {
        // tolerant: one corrupt legacy manifest never hides the others
      }
    }
    out.sort((a, b) => compareStrings(a.wsKey, b.wsKey))
    return out
  }

  /**
   * Bridge one scope journal's change feed into that scope's merged view. One
   * bridge per scope; listeners registered via `onMergedChange(scopeKey, cb)` are
   * notified after the cache invalidation.
   *
   * @param {string} wsKey
   * @param {WorkspaceJournal} journal
   */
  _attachMergedBridge(wsKey, journal) {
    if (!journal || typeof journal.onChange !== 'function') return
    const previous = this._mergedBridges.get(wsKey)
    if (previous !== undefined) {
      try {
        previous()
      } catch {
        // ignore a stale unsubscribe
      }
      this._mergedBridges.delete(wsKey)
    }
    const unsubscribe = journal.onChange((changed) => {
      const didChange = changed !== false
      if (didChange) this._invalidateMerged(wsKey)
      const listeners = this._mergedListeners.get(wsKey)
      if (listeners === undefined) return
      for (const listener of [...listeners]) {
        try {
          listener(didChange)
        } catch (error) {
          this.logger.warn({ event: 'store.merged_listener_failed', wsKey, message: error?.message })
        }
      }
    })
    this._mergedBridges.set(wsKey, typeof unsubscribe === 'function' ? unsubscribe : () => {})
  }

  /**
   * Drop the cached merged view of one scope (or all scopes when omitted). The
   * next `viewedRecords(scopeKey)` rebuilds it from the journal's record cache.
   *
   * @param {string} [scopeKey]
   */
  _invalidateMerged(scopeKey) {
    if (typeof scopeKey === 'string') {
      this._mergedRecords.delete(scopeKey)
      return
    }
    this._mergedRecords.clear()
  }

  /** Close every open journal (flush + close fds) and stop timers/watchers. */
  async close() {
    if (this._closed) return
    this._closed = true
    this._opening.clear()
    for (const unsubscribe of this._mergedBridges.values()) {
      try {
        unsubscribe()
      } catch {
        // ignore a stale unsubscribe
      }
    }
    this._mergedBridges.clear()
    for (const journal of this._journals.values()) {
      try {
        await journal.close()
      } catch (error) {
        this.logger.warn({ event: 'store.close_failed', message: error?.message })
      }
    }
    this._journals.clear()
    this._lru.clear()
    this._mergedRecords.clear()
    this._mergedListeners.clear()
  }
}

/**
 * One workspace's journal: this process's append fd plus the merged read cache
 * over all shards in the directory.
 */
export class WorkspaceJournal {
  /** @param {object} options */
  constructor({ store, wsKey, dir, config, deps, fsp, fsSync, logger, ulid, now }) {
    this.store = store
    this.wsKey = wsKey
    this.dir = dir
    this.config = config
    this.deps = deps
    this._fsp = fsp
    this._fsSync = fsSync
    this.logger = logger
    this._ulid = ulid
    this._now = now
    this._shardPath = path.join(dir, `journal.${store.writerId}.v1.jsonl`)
    this._presenceDir = path.join(dir, 'presence')
    this._fd = null
    this._open = true
    this._closed = false
    /** @type {Map<string, {consumedBytes: number, records: object[], size: number, mtimeMs: number}>} */
    this._fileStates = new Map()
    this._records = EMPTY_RECORDS
    this._signature = ''
    /** @type {Set<(viewChanged: boolean) => void>} */
    this._listeners = new Set()
    this._timer = null
    this._watcher = null
    this._debounce = null
    this._refreshPromise = null
    this._presenceCounter = 0
    this._stats = { invalid: 0, unsupported: 0 }
    this._retryDelays = Array.isArray(deps.retryDelays) ? deps.retryDelays : DEFAULT_RETRY_DELAYS
    const pollCandidate = Number(config && config.store ? config.store.pollMs : 4000)
    this._pollMs = Number.isFinite(pollCandidate) && pollCandidate > 0 ? Math.min(MAX_POLL_MS, pollCandidate) : 4000
    this._watchEnabled = !(config && config.store && config.store.watch === false)
  }

  /** True while the journal is open (append/poll/watch active). */
  get isOpen() {
    return this._open && !this._closed
  }

  /** @param {() => Promise<any>} operation @returns {Promise<any>} shared transient-error retry */
  async _retry(operation) {
    return this.store._retry(operation)
  }

  /** Merged records, sorted by seq: entries first-by-seq, sessions max-seq, tombstones kept. */
  records() {
    return this._records
  }

  /** Synchronous alias of records() for the facade's board folds. */
  view() {
    return this._records
  }

  /** @param {(viewChanged: boolean) => void} callback @returns {() => void} */
  onChange(callback) {
    if (typeof callback !== 'function') return () => {}
    this._listeners.add(callback)
    return () => {
      this._listeners.delete(callback)
    }
  }

  /** @param {boolean} changed */
  _emit(changed) {
    for (const listener of [...this._listeners]) {
      try {
        listener(changed)
      } catch (error) {
        this.logger.warn({ event: 'store.change_listener_failed', message: error?.message })
      }
    }
  }

  /** Start polling (and fs.watch when enabled and available). Called once by the store. */
  start() {
    if (!this.isOpen || this._timer || this._closed) return
    this._timer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.logger.debug({ event: 'store.poll_failed', message: error?.message })
      })
    }, this._pollMs)
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()

    if (!this._watchEnabled) return
    try {
      const watcher = this.store._watchImpl(this.dir, { persistent: false }, () => this._scheduleWatchRefresh())
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (error) => {
          this.logger.warn({ event: 'store.watch_error', message: error?.message })
          try {
            watcher.close()
          } catch {
            // ignore close failures
          }
          if (this._watcher === watcher) this._watcher = null
        })
      }
      this._watcher = watcher
    } catch (error) {
      this.logger.warn({ event: 'store.watch_unavailable', message: error?.message ?? String(error) })
      this._watcher = null
    }
  }

  _scheduleWatchRefresh() {
    if (!this.isOpen || this._debounce) return
    this._debounce = setTimeout(() => {
      this._debounce = null
      void this.refresh().catch((error) => {
        this.logger.debug({ event: 'store.watch_refresh_failed', message: error?.message })
      })
    }, WATCH_DEBOUNCE_MS)
    if (this._debounce && typeof this._debounce.unref === 'function') this._debounce.unref()
  }

  /**
   * Rescan changed shard tails and rebuild the merged view.
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<boolean>} true when the merged view changed
   */
  async refresh({ force = false } = {}) {
    if (!this.isOpen) return false
    if (this._refreshPromise) return this._refreshPromise
    this._refreshPromise = this._doRefresh(force).finally(() => {
      this._refreshPromise = null
    })
    return this._refreshPromise
  }

  /** @param {boolean} force @returns {Promise<boolean>} */
  async _doRefresh(force) {
    let names
    try {
      names = (await this._retry(() => this._fsp.readdir(this.dir))).filter((name) => SHARD_PATTERN.test(name))
    } catch (error) {
      this.logger.warn({ event: 'store.readdir_failed', message: error?.message })
      return false
    }
    names.sort()
    const present = new Set(names)
    let dirty = false
    for (const name of [...this._fileStates.keys()]) {
      if (!present.has(name)) {
        this._fileStates.delete(name)
        dirty = true
      }
    }
    for (const name of names) {
      const changed = await this._refreshShard(name, force)
      if (changed) dirty = true
    }
    if (!dirty) return false
    const changed = this._rebuild()
    if (changed) this._emit(true)
    return changed
  }

  /**
   * @param {string} name shard basename
   * @param {boolean} force
   * @returns {Promise<boolean>} whether this shard contributed new/changed records
   */
  async _refreshShard(name, force) {
    const filePath = path.join(this.dir, name)
    let stat
    try {
      stat = await this._retry(() => this._fsp.stat(filePath))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._fileStates.delete(name)
        return true
      }
      this.logger.warn({ event: 'store.shard_stat_failed', file: name, message: error?.message })
      return false
    }
    let state = this._fileStates.get(name)
    if (state && !force && state.size === stat.size && state.mtimeMs === stat.mtimeMs) return false

    let buffer
    try {
      buffer = await this._retry(() => this._fsp.readFile(filePath))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._fileStates.delete(name)
        return true
      }
      this.logger.warn({ event: 'store.shard_read_failed', file: name, message: error?.message })
      return false
    }
    if (!state) state = { consumedBytes: 0, records: [], size: -1, mtimeMs: -1 }
    if (buffer.length < state.consumedBytes) {
      // The file shrank (compaction/prune or replacement): rebuild from byte 0.
      state.consumedBytes = 0
      state.records = []
    }
    const before = state.records.length
    const chunk = buffer.subarray(state.consumedBytes)
    if (chunk.length > 0) {
      const parsed = parseShardChunk(chunk, this.wsKey, this._stats)
      if (parsed.records.length > 0) state.records.push(...parsed.records)
      state.consumedBytes += parsed.consumedBytes
    }
    state.size = stat.size
    state.mtimeMs = stat.mtimeMs
    this._fileStates.set(name, state)
    return force || state.records.length !== before
  }

  /**
   * Fold shard records into the merged view. Pure with respect to the record
   * set: deterministic for any traversal order.
   *
   * @returns {boolean} whether the view changed
   */
  _rebuild() {
    const all = []
    for (const name of [...this._fileStates.keys()].sort()) {
      const state = this._fileStates.get(name)
      if (state && state.records.length > 0) all.push(...state.records)
    }
    const merged = mergeRecordList(all)
    const signature = merged
      .map((record) => `${String(record.seq)}|${String(record.type)}|${String(record.id ?? record.sessionId ?? '')}`)
      .join(';')
    const changed = signature !== this._signature
    this._records = Object.freeze(merged)
    this._signature = signature
    return changed
  }

  /** Ensure the held O_APPEND fd exists. */
  async _ensureFd() {
    if (this._fd !== null) return
    try {
      await this._fsp.mkdir(this.dir, { recursive: true })
      this._fd = this._fsSync.openSync(this._shardPath, 'a', 0o600)
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `cannot open journal shard: ${error?.message ?? error}`, {
        cause: error,
      })
    }
  }

  /**
   * Append one record to this process's shard. Assigns `v/ws/seq/ts` when absent.
   * One complete UTF-8 line per write; rejects an encoded line over 64 KiB.
   *
   * @param {object} record
   * @returns {Promise<object>} stored record
   */
  async append(record) {
    if (!this.isOpen) throw new ConfluenceError('STORE_UNAVAILABLE', 'journal is closed')
    if (!isPlainObject(record) || typeof record.type !== 'string' || record.type === '') {
      throw new ConfluenceError('BAD_ARGUMENT', 'record must be an object with a type')
    }
    const stored = { ...record }
    if (stored.v === undefined) stored.v = 1
    if (stored.ws === undefined) stored.ws = this.wsKey
    if (stored.ws !== this.wsKey) {
      // Contract: a record's `ws` must equal the journal key it lands in.
      throw new ConfluenceError(
        'BAD_ARGUMENT',
        `record ws ${String(stored.ws)} does not match the journal key ${this.wsKey}`,
      )
    }
    if (stored.seq === undefined) stored.seq = this._ulid()
    if (stored.ts === undefined) stored.ts = isoNow(this._now())

    const line = `${JSON.stringify(stored)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > MAX_LINE_BYTES) {
      throw new ConfluenceError(
        'BODY_TOO_LARGE',
        `record serialization is ${bytes} bytes; the journal line cap is ${MAX_LINE_BYTES}`,
      )
    }
    await this._ensureFd()
    try {
      this._fsSync.writeSync(this._fd, line)
    } catch (error) {
      throw new ConfluenceError('STORE_UNAVAILABLE', `journal append failed: ${error?.message ?? error}`, {
        cause: error,
      })
    }
    const name = path.basename(this._shardPath)
    let state = this._fileStates.get(name)
    if (!state) state = { consumedBytes: 0, records: [], size: -1, mtimeMs: -1 }
    state.consumedBytes += bytes
    state.records.push(stored)
    state.size = -1
    state.mtimeMs = -1
    this._fileStates.set(name, state)
    if (this._rebuild()) this._emit(true)
    return stored
  }

  /**
   * Board-post durability: append, then fsync before resolving. Throws
   * STORE_UNAVAILABLE when the fsync fails (the caller must not claim success).
   *
   * @param {object} record
   * @returns {Promise<object>}
   */
  async appendAndSync(record) {
    const stored = await this.append(record)
    await this.flush()
    return stored
  }

  /** fsync the held shard fd. No-op when nothing was written yet. */
  async flush() {
    if (this._fd === null) return
    try {
      this._fsSync.fsyncSync(this._fd)
    } catch (error) {
      this.logger.warn({ event: 'store.fsync_failed', wsKey: this.wsKey, message: error?.message })
      throw new ConfluenceError('STORE_UNAVAILABLE', `journal fsync failed: ${error?.message ?? error}`, {
        cause: error,
      })
    }
  }

  /**
   * Atomically rewrite this writer's presence heartbeat file.
   *
   * @param {object} data e.g. { sessions: [{sessionId, title, wsKey, status}] }
   * @returns {Promise<void>}
   */
  async writePresence(data) {
    if (!this.isOpen) return
    const body = { ...(isPlainObject(data) ? data : {}) }
    body.writerId = this.store.writerId
    body.updatedAt =
      isPlainObject(data) && typeof data.updatedAt === 'string' && data.updatedAt !== ''
        ? data.updatedAt
        : isoNow(this._now())
    const target = path.join(this._presenceDir, `${this.store.writerId}.json`)
    this._presenceCounter += 1
    const tmp = path.join(this._presenceDir, `.tmp-${this.store.writerId}-${this._presenceCounter}.json`)
    try {
      await this._fsp.mkdir(this._presenceDir, { recursive: true })
      await this._fsp.writeFile(tmp, JSON.stringify(body), 'utf8')
      await this._renameWithRetry(tmp, target)
    } catch (error) {
      try {
        this._fsSync.unlinkSync(tmp)
      } catch {
        // best effort cleanup
      }
      this.logger.warn({ event: 'store.presence_write_failed', wsKey: this.wsKey, message: error?.message })
    }
  }

  /** @param {string} from @param {string} to @returns {Promise<void>} */
  async _renameWithRetry(from, to) {
    let lastError
    for (let attempt = 0; attempt <= this._retryDelays.length; attempt += 1) {
      try {
        await this._fsp.rename(from, to)
        return
      } catch (error) {
        lastError = error
        if (!isTransientError(error) || attempt === this._retryDelays.length) break
        await delay(this._retryDelays[attempt])
      }
    }
    throw lastError
  }

  /**
   * Read every valid presence heartbeat in this workspace.
   *
   * @returns {Promise<Record<string, object>>}
   */
  async readPresence() {
    const out = {}
    let names
    try {
      names = await this._fsp.readdir(this._presenceDir)
    } catch {
      return out
    }
    names.sort()
    let seen = 0
    for (const name of names) {
      if (!PRESENCE_FILE_PATTERN.test(name)) continue
      seen += 1
      if (seen > MAX_PRESENCE_SCAN) break
      try {
        const raw = await this._retry(() => this._fsp.readFile(path.join(this._presenceDir, name), 'utf8'))
        const parsed = safeJsonParse(raw)
        if (!parsed.ok || !isPlainObject(parsed.value)) continue
        out[name.slice(0, -'.json'.length)] = parsed.value
      } catch {
        // ignore one unreadable heartbeat
      }
    }
    return out
  }

  /** @returns {Promise<{shards: number, bytes: number, entries: number}>} */
  async sizeInfo() {
    let shards = 0
    let bytes = 0
    try {
      const names = (await this._fsp.readdir(this.dir)).filter((name) => SHARD_PATTERN.test(name))
      shards = names.length
      for (const name of names) {
        try {
          const stat = await this._fsp.stat(path.join(this.dir, name))
          bytes += Number(stat.size) || 0
        } catch {
          // ignore a vanished shard
        }
      }
    } catch {
      // unreadable directory: report zeros
    }
    let entries = 0
    for (const record of this._records) if (record.type === 'entry') entries += 1
    return { shards, bytes, entries }
  }

  /** Flush, close the shard fd, stop timers/watchers. Idempotent. */
  async close() {
    if (this._closed) return
    this._open = false
    this._closed = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._debounce) {
      clearTimeout(this._debounce)
      this._debounce = null
    }
    if (this._watcher) {
      try {
        this._watcher.close()
      } catch {
        // ignore
      }
      this._watcher = null
    }
    if (this._fd !== null) {
      try {
        this._fsSync.fsyncSync(this._fd)
      } catch (error) {
        this.logger.debug({ event: 'store.close_fsync_failed', message: error?.message })
      }
      try {
        this._fsSync.closeSync(this._fd)
      } catch (error) {
        this.logger.debug({ event: 'store.close_fd_failed', message: error?.message })
      }
      this._fd = null
    }
  }
}
