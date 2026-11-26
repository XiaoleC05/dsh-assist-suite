// Confluence / 高级记忆 — M1 workspace keyed context pool (v0.3.0).
//
// A workspace bus state entry: `type:'context'` records live in the workspace
// journal (one journal per frozen workspace key, `lib/store.js`). The fold is a
// last-writer-wins keyed map: per key the record with the greatest `seq` wins and
// a winning record with `deleted:true` removes the key (append-only tombstone).
//
// Record shape (binding: docs/plan/v0.3-interfaces.md §2.1):
//   { v:1, type:'context', id:'ctx_<ULID>', ws:'ws_<16hex>', key, value,
//     valueType:'text'|'json', author:{sessionId,title?}, deleted?:true, seq, ts }
//
// Plain ESM + Node builtins only: no network, no child process, no dependency,
// no @deepseek-ai import. Shared content is untrusted data: values are redacted
// with `lib/redact.js` before they are persisted, and every read path degrades to
// an empty view instead of throwing on malformed records.
//
// Caps (config.bus.context): `maxKeys` live keys per workspace on the write path
// (`LIMIT_EXCEEDED` for a new key at the cap; overwriting an existing key stays
// allowed) and `maxValueBytes` per redacted value (`BODY_TOO_LARGE`).

import {
  ConfluenceError,
  createUlidFactory,
  isUlid,
  safeJsonParse,
} from './util.js'

/** Closed key grammar: lowercase start, then lowercase/digit/dot/dash/underscore. */
export const CONTEXT_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Default live-key cap per workspace (interface §2.1). */
export const CONTEXT_MAX_KEYS = 200

/** Default value byte cap (config.bus.context.maxValueBytes). */
export const CONTEXT_MAX_VALUE_BYTES = 8192

/** Closed value-type vocabulary. `json` stores a JSON-encoded string. */
export const CONTEXT_VALUE_TYPES = Object.freeze(['text', 'json'])

const EMPTY_RECORDS = Object.freeze([])

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

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @returns {number} */
function clampInt(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value)
  const effective = Number.isFinite(numeric) ? numeric : fallback
  return Math.max(min, Math.min(max, Math.trunc(effective)))
}

/** @param {string} code @param {string} message @param {{cause?: unknown}} [options] @returns {ConfluenceError} */
function contextError(code, message, options) {
  return new ConfluenceError(code, message, options)
}

/**
 * Order two records by `seq` then `id` (deterministic tie-break).
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {number}
 */
function compareRecords(a, b) {
  const seqA = asString(a.seq)
  const seqB = asString(b.seq)
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = asString(a.id)
  const idB = asString(b.id)
  return idA === idB ? 0 : idA < idB ? -1 : 1
}

/**
 * Envelope/shape check for one stored record. Unknown types, v:2, invalid
 * envelopes and keys outside the grammar are skipped (a reader never throws).
 * @param {unknown} record
 * @returns {record is Record<string, unknown>}
 */
function isFoldableContext(record) {
  if (!isPlainObject(record)) return false
  if (record.v !== 1) return false
  if (record.type !== 'context') return false
  if (typeof record.ws !== 'string' || record.ws.length === 0) return false
  if (!isUlid(record.seq)) return false
  if (typeof record.key !== 'string' || !CONTEXT_KEY_RE.test(record.key)) return false
  if (record.deleted === true) return true
  return typeof record.value === 'string'
}

/**
 * @param {unknown} raw
 * @returns {{sessionId: string, title?: string}}
 */
function normalizeAuthor(raw) {
  if (!isPlainObject(raw)) return { sessionId: '' }
  const sessionId = asString(raw.sessionId)
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : undefined
  return title === undefined ? { sessionId } : { sessionId, title }
}

/**
 * Pure fold of `context` records: per key the greatest `seq` wins, a winning
 * `deleted:true` removes the key. Used by tests and by the service cache.
 *
 * Entries are frozen `{key, value, valueType, updatedAt, author, seq}` rows where
 * `updatedAt` is the winning record's `ts`. `maxSeq` is the greatest seq across
 * every valid context record (deletes included) and is the cursor surface for
 * panel/pulse consumers.
 *
 * @param {readonly unknown[]} records
 * @returns {{entries: Map<string, {key: string, value: string, valueType: 'text'|'json', updatedAt: string, author: {sessionId: string, title?: string}, seq: string}>, count: number, maxSeq: string}}
 */
export function foldContext(records) {
  /** @type {Record<string, unknown>[]} */
  const valid = []
  if (Array.isArray(records)) {
    for (const record of records) {
      if (isFoldableContext(record)) valid.push(record)
    }
  }
  valid.sort(compareRecords)
  /** @type {Map<string, {key: string, value: string, valueType: 'text'|'json', updatedAt: string, author: {sessionId: string, title?: string}, seq: string}>} */
  const entries = new Map()
  let maxSeq = ''
  for (const record of valid) {
    const key = asString(record.key)
    const seq = asString(record.seq)
    if (seq > maxSeq) maxSeq = seq
    if (record.deleted === true) {
      entries.delete(key)
      continue
    }
    const valueType = record.valueType === 'json' ? 'json' : 'text'
    entries.set(
      key,
      Object.freeze({
        key,
        value: asString(record.value),
        valueType,
        updatedAt: asString(record.ts),
        author: Object.freeze(normalizeAuthor(record.author)),
        seq,
      }),
    )
  }
  return { entries, count: entries.size, maxSeq }
}

/** @returns {{entries: [], count: 0, maxSeq: ''}} a fresh empty service view */
function emptyView() {
  return Object.freeze({ entries: Object.freeze([]), count: 0, maxSeq: '' })
}

/**
 * ContextService — one instance per plugin mount; `Map<wsKey, state>` keeps the
 * journal, the folded live keys and the synchronous view per workspace scope.
 *
 * Constructor deps: `{ store, config, redactor, logger, deps }`. `store` is a
 * `JournalStore` with the per-scope surface (`openWorkspace`, `viewedRecords`,
 * `onMergedChange`, `refreshMerged`); tests inject a fake with the same surface.
 *
 * @typedef {{
 *   openWorkspace(wsKey: string, meta?: unknown): Promise<object>,
 *   viewedRecords?: (wsKey: string) => readonly object[],
 *   onMergedChange?: (wsKey: string, callback: (changed: boolean) => void) => (() => void),
 *   refreshMerged?: (wsKey: string) => Promise<boolean>,
 * }} ScopedStore
 */
export class ContextService {
  /**
   * @param {{
   *   store: ScopedStore,
   *   config: Record<string, unknown>,
   *   redactor: { text(s: unknown): {value: string, hits: number}, title(s: unknown): {value: string, hits: number} },
   *   logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function},
   *   deps?: {now?: () => number, random?: () => number, pid?: number},
   * }} options
   */
  constructor({ store, config, redactor, logger, deps = {} } = {}) {
    if (!store) throw new TypeError('ContextService requires a store with openWorkspace()')
    if (!redactor) throw new TypeError('ContextService requires a redactor')
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this.redactor = redactor
    this.logger = logger
    this.deps = isPlainObject(deps) ? deps : {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.ulid = createUlidFactory(this.now, this.deps.random ?? Math.random)
    const busConfig = isPlainObject(this.config.bus) ? this.config.bus : {}
    const contextConfig = isPlainObject(busConfig.context) ? busConfig.context : {}
    this.maxKeys = clampInt(contextConfig.maxKeys, CONTEXT_MAX_KEYS, 1, 2000)
    this.maxValueBytes = clampInt(contextConfig.maxValueBytes, CONTEXT_MAX_VALUE_BYTES, 1, 65536)
    /**
     * @type {Map<string, {
     *   wsKey: string,
     *   journal: object,
     *   fold: ReturnType<typeof foldContext> | null,
     *   view: {entries: object[], count: number, maxSeq: string} | null,
     * }>}
     */
    this._scopes = new Map()
    /** @type {Map<string, Promise<void>>} single-flight attach per scope */
    this._opening = new Map()
    /** @type {Map<string, Array<() => void>>} per-scope change-feed unsubscribes */
    this._unsubscribes = new Map()
  }

  /** @param {string} event @param {Record<string, unknown>} [fields] */
  debug(event, fields) {
    try {
      this.logger?.debug?.({ event, ...(fields ?? {}) })
    } catch {
      // Logging must never break a context operation.
    }
  }

  /** @param {unknown} wsKey @returns {string} */
  _assertWorkspaceKey(wsKey) {
    if (typeof wsKey !== 'string' || wsKey.length === 0) {
      throw contextError('BAD_ARGUMENT', 'workspace key is required')
    }
    return wsKey
  }

  /**
   * Open (or reuse) one workspace journal, subscribe to its change feed and warm
   * the folded state. Idempotent per scope and safe under concurrent callers.
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
    const pending = this._attachOnce(wsKey, meta).finally(() => {
      if (this._opening.get(wsKey) === pending) this._opening.delete(wsKey)
    })
    this._opening.set(wsKey, pending)
    await pending
    return this
  }

  /**
   * @param {string} wsKey
   * @param {{canonicalPath?: string, label?: string}} [meta]
   * @returns {Promise<void>}
   */
  async _attachOnce(wsKey, meta) {
    if (typeof this.store.openWorkspace !== 'function') {
      throw contextError('STORE_UNAVAILABLE', 'the store does not support workspace journals')
    }
    const journal = await this.store.openWorkspace(wsKey, meta)
    if (!journal || typeof journal !== 'object') {
      throw contextError('STORE_UNAVAILABLE', 'the workspace journal is unavailable')
    }
    this._detachScope(wsKey)
    /** @type {{wsKey: string, journal: object, fold: ReturnType<typeof foldContext> | null, view: {entries: object[], count: number, maxSeq: string} | null}} */
    const state = { wsKey, journal, fold: null, view: null }
    this._scopes.set(wsKey, state)
    this._subscribeToChanges(wsKey, journal)
    try {
      if (typeof this.store.refreshMerged === 'function') await this.store.refreshMerged(wsKey)
      else if (typeof journal.refresh === 'function') await journal.refresh()
    } catch (error) {
      this.debug('context.attach_refresh_failed', { wsKey, message: String(error) })
    }
    this._invalidate(wsKey)
    this._viewOf(state)
  }

  /**
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
      this.debug('context.subscribe_failed', { wsKey, source: 'store', message: String(error) })
    }
    try {
      if (journal && typeof journal.onChange === 'function') {
        track(journal.onChange(() => this._invalidate(wsKey)))
      }
    } catch (error) {
      this.debug('context.subscribe_failed', { wsKey, source: 'journal', message: String(error) })
    }
    this._unsubscribes.set(wsKey, unsubscribes)
  }

  /** @param {string} wsKey */
  _invalidate(wsKey) {
    const state = this._scopes.get(wsKey)
    if (state !== undefined) {
      state.fold = null
      state.view = null
    }
  }

  /** @param {string} wsKey */
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
   * Detach one workspace scope (the store journal stays open: board/bus/pulse may
   * share it; the store LRU owns journal lifetime).
   * @param {string} wsKey
   * @returns {this}
   */
  detach(wsKey) {
    if (typeof wsKey === 'string') this._detachScope(wsKey)
    return this
  }

  /**
   * The attached state of one scope, re-opening the journal when the store
   * evicted it (LRU). Throws STORE_UNAVAILABLE when the scope was never attached.
   *
   * @param {string} wsKey
   * @returns {Promise<object>}
   */
  async _attachedState(wsKey) {
    const state = this._scopes.get(wsKey)
    if (state === undefined) throw contextError('STORE_UNAVAILABLE', 'the workspace context store is not attached')
    if (state.journal && state.journal.isOpen !== false) return state
    await this.attach(wsKey)
    const reopened = this._scopes.get(wsKey)
    if (reopened === undefined) throw contextError('STORE_UNAVAILABLE', 'the workspace context store is not attached')
    return reopened
  }

  /**
   * Records of one attached scope from the store's per-scope view, falling back
   * to the journal's own record cache for fake/legacy store seams. Never throws.
   * @param {object} state
   * @returns {readonly object[]}
   */
  _records(state) {
    try {
      if (typeof this.store.viewedRecords === 'function') {
        const records = this.store.viewedRecords(state.wsKey)
        if (Array.isArray(records)) return records
      }
      if (state.journal && typeof state.journal.records === 'function') {
        const records = state.journal.records()
        if (Array.isArray(records)) return records
      }
    } catch (error) {
      this.debug('context.records_failed', { wsKey: state.wsKey, message: String(error) })
    }
    return EMPTY_RECORDS
  }

  /**
   * @param {object} state
   * @returns {ReturnType<typeof foldContext>}
   */
  _foldOf(state) {
    if (state.fold === null) state.fold = foldContext(this._records(state))
    return state.fold
  }

  /**
   * @param {object} state
   * @returns {{entries: object[], count: number, maxSeq: string}}
   */
  _viewOf(state) {
    const fold = this._foldOf(state)
    if (state.view === null) {
      const entries = [...fold.entries.values()].sort((a, b) => {
        if (a.seq !== b.seq) return a.seq > b.seq ? -1 : 1
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
      })
      state.view = Object.freeze({ entries: Object.freeze(entries), count: fold.count, maxSeq: fold.maxSeq })
    }
    return state.view
  }

  /**
   * Synchronous workspace context view: live keys sorted newest-update-first
   * (ties by key). An unattached/unknown scope yields `{entries:[],count:0,maxSeq:''}`
   * and never throws.
   *
   * @param {string} wsKey
   * @returns {{entries: {key: string, value: string, valueType: 'text'|'json', updatedAt: string, author: {sessionId: string, title?: string}, seq: string}[], count: number, maxSeq: string}}
   */
  view(wsKey) {
    const state = typeof wsKey === 'string' ? this._scopes.get(wsKey) : undefined
    if (state === undefined) return emptyView()
    try {
      return this._viewOf(state)
    } catch (error) {
      this.debug('context.view_failed', { wsKey, message: String(error) })
      return emptyView()
    }
  }

  /**
   * Synchronous single-key read from the in-memory fold (freshest after the last
   * change feed). An unknown key/scope or malformed key yields null.
   *
   * @param {string} wsKey
   * @param {string} key
   * @returns {{key: string, value: string, valueType: 'text'|'json', updatedAt: string, author: {sessionId: string, title?: string}, seq: string} | null}
   */
  get(wsKey, key) {
    if (typeof key !== 'string' || !CONTEXT_KEY_RE.test(key)) return null
    const state = typeof wsKey === 'string' ? this._scopes.get(wsKey) : undefined
    if (state === undefined) return null
    try {
      const entry = this._foldOf(state).entries.get(key)
      return entry === undefined ? null : entry
    } catch (error) {
      this.debug('context.get_failed', { wsKey, key, message: String(error) })
      return null
    }
  }

  /**
   * Append one live value record. Validation → redaction → caps → durable append
   * (fsync). The previous value for the key (if live) is overwritten by seq.
   *
   * @param {string} wsKey
   * @param {{key: string, value: string, valueType?: 'text'|'json', author: {sessionId: string, title?: string}}} input
   * @returns {Promise<{key: string, seq: string, overwritten: boolean}>}
   */
  async set(wsKey, input) {
    this._assertWorkspaceKey(wsKey)
    if (!isPlainObject(input)) throw contextError('BAD_ARGUMENT', 'set input must be an object')
    const key = input.key
    if (typeof key !== 'string' || !CONTEXT_KEY_RE.test(key)) {
      throw contextError('BAD_ARGUMENT', `invalid context key: ${JSON.stringify(String(key))}`)
    }
    const valueType = input.valueType === undefined ? 'text' : input.valueType
    if (valueType !== 'text' && valueType !== 'json') {
      throw contextError('BAD_ARGUMENT', `unknown context valueType "${String(valueType)}"`)
    }
    if (typeof input.value !== 'string') throw contextError('BAD_ARGUMENT', 'value must be a string')
    if (valueType === 'json' && !safeJsonParse(input.value).ok) {
      throw contextError('BAD_ARGUMENT', 'a json value must be a JSON-encoded string')
    }
    const redacted = this.redactor.text(input.value)
    if (redacted.value === '' && input.value !== '') {
      throw contextError('REDACTED', 'the value was entirely sensitive and cannot be stored')
    }
    let value = redacted.value
    if (valueType === 'json' && redacted.hits > 0 && !safeJsonParse(value).ok) {
      throw contextError('REDACTED', 'the value became invalid JSON after redaction')
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > this.maxValueBytes) {
      throw contextError(
        'BODY_TOO_LARGE',
        `value is ${bytes} bytes; the context cap is ${this.maxValueBytes}`,
      )
    }
    const author = this._normalizeAuthor(input.author)
    const state = await this._attachedState(wsKey)
    const fold = this._foldOf(state)
    const overwritten = fold.entries.has(key)
    if (!overwritten && fold.count >= this.maxKeys) {
      throw contextError(
        'LIMIT_EXCEEDED',
        `this workspace has reached ${this.maxKeys} context keys; delete one before adding "${key}"`,
      )
    }
    const record = {
      v: 1,
      type: 'context',
      id: `ctx_${this.ulid()}`,
      ws: wsKey,
      key,
      value,
      valueType,
      author,
    }
    let stored
    try {
      stored = await state.journal.appendAndSync(record)
    } catch (error) {
      throw contextError('STORE_UNAVAILABLE', 'the context value could not be persisted', { cause: error })
    }
    this._invalidate(wsKey)
    return { key, seq: asString(stored?.seq), overwritten }
  }

  /**
   * Append a tombstone record for one live key (append-only delete). A key that
   * is not live fails NOT_FOUND; the record is removed from every subsequent fold.
   *
   * @param {string} wsKey
   * @param {{key: string, author: {sessionId: string, title?: string}}} input
   * @returns {Promise<{key: string, seq: string, deleted: true}>}
   */
  async delete(wsKey, input) {
    this._assertWorkspaceKey(wsKey)
    if (!isPlainObject(input)) throw contextError('BAD_ARGUMENT', 'delete input must be an object')
    const key = input.key
    if (typeof key !== 'string' || !CONTEXT_KEY_RE.test(key)) {
      throw contextError('BAD_ARGUMENT', `invalid context key: ${JSON.stringify(String(key))}`)
    }
    const author = this._normalizeAuthor(input.author)
    const state = await this._attachedState(wsKey)
    if (!this._foldOf(state).entries.has(key)) {
      throw contextError('NOT_FOUND', `no context key "${key}" in this workspace`)
    }
    const record = {
      v: 1,
      type: 'context',
      id: `ctx_${this.ulid()}`,
      ws: wsKey,
      key,
      deleted: true,
      author,
    }
    let stored
    try {
      stored = await state.journal.appendAndSync(record)
    } catch (error) {
      throw contextError('STORE_UNAVAILABLE', 'the context delete could not be persisted', { cause: error })
    }
    this._invalidate(wsKey)
    return { key, seq: asString(stored?.seq), deleted: true }
  }

  /**
   * Rescan one workspace journal and drop its folded cache.
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
      this.debug('context.refresh_failed', { wsKey, message: String(error) })
    } finally {
      this._invalidate(wsKey)
    }
    return changed
  }

  /**
   * Validate and normalise the writing author (`{sessionId, title?}`); the title
   * is redacted and dropped when empty. Authority for sessionId is the caller.
   *
   * @param {unknown} author
   * @returns {{sessionId: string, title?: string}}
   */
  _normalizeAuthor(author) {
    if (!isPlainObject(author)) throw contextError('BAD_ARGUMENT', 'author is required')
    const sessionId = asString(author.sessionId)
    if (sessionId === '') throw contextError('BAD_ARGUMENT', 'author.sessionId is required')
    if (author.title === undefined) return { sessionId }
    if (typeof author.title !== 'string') throw contextError('BAD_ARGUMENT', 'author.title must be a string')
    const title = this.redactor.title(author.title).value
    return title === '' ? { sessionId } : { sessionId, title }
  }
}
