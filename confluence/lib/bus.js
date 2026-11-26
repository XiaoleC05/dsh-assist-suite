// Confluence / 高级记忆 — M1 workspace addressed messages (v0.3.0).
//
// Queue-based peer messaging for sessions that share a workspace: a `message`
// record is appended to the workspace journal and surfaces in the recipient's
// next-step pulse and in the explicit inbox tool. v0.3.0 never wakes or
// interrupts another session (no forged user message, no LLM call).
//
// Record shape (binding: docs/plan/v0.3-interfaces.md §2.3):
//   { v:1, type:'message', id:'msg_<ULID>', ws:'ws_<16hex>',
//     from:{sessionId,title?}, to:{kind:'workspace'}|{sessionId},
//     kind:'notice'|'instruction'|'query'|'reply', body, replyTo?:'msg_<ULID>',
//     seq, ts }
//
// Messages are immutable: there is no edit and no delete path. The read cursor
// (`readSeq`, an inbox `seq` ULID) is owned by the caller (watermark/facade): the
// bus never writes a read marker, so `inbox()` is a pure synchronous read.
//
// Plain ESM + Node builtins only: no network, no child process, no dependency,
// no @deepseek-ai import. Message bodies are untrusted peer content: they are
// redacted before persistence and returned as data (never interpreted here).
//
// Caps (config.bus.messages): `maxStored` live messages per workspace on the
// write path (`LIMIT_EXCEEDED`) and `maxBodyBytes` per redacted body
// (`BODY_TOO_LARGE`).

import {
  ConfluenceError,
  createUlidFactory,
  isUlid,
} from './util.js'

/** Closed message-kind vocabulary (interface §2.3). */
export const MESSAGE_KINDS = Object.freeze(['notice', 'instruction', 'query', 'reply'])
const MESSAGE_KIND_SET = new Set(MESSAGE_KINDS)

/** Default live-message cap per workspace (config.bus.messages.maxStored). */
export const MESSAGE_MAX_STORED = 500

/** Default body byte cap (config.bus.messages.maxBodyBytes). */
export const MESSAGE_MAX_BODY_BYTES = 4096

const MESSAGE_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const DEFAULT_INBOX_LIMIT = 10
const MAX_INBOX_LIMIT = 20
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
function busError(code, message, options) {
  return new ConfluenceError(code, message, options)
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b @returns {number} */
function compareRecords(a, b) {
  const seqA = asString(a.seq)
  const seqB = asString(b.seq)
  if (seqA !== seqB) return seqA < seqB ? -1 : 1
  const idA = asString(a.id)
  const idB = asString(b.id)
  return idA === idB ? 0 : idA < idB ? -1 : 1
}

/**
 * Normalise an untrusted recipient to the record form:
 * `{kind:'workspace'}` (broadcast, tool `to:'*'`) or `{sessionId}`.
 * Returns null for anything else (the caller maps it to BAD_ARGUMENT).
 *
 * @param {unknown} raw
 * @returns {{kind: 'workspace'} | {sessionId: string} | null}
 */
function normalizeRecipient(raw) {
  if (typeof raw === 'string') {
    if (raw === '*') return Object.freeze({ kind: 'workspace' })
    return SESSION_ID_RE.test(raw) ? Object.freeze({ sessionId: raw }) : null
  }
  if (!isPlainObject(raw)) return null
  if (raw.kind === 'workspace') return Object.freeze({ kind: 'workspace' })
  const sessionId = asString(raw.sessionId)
  return SESSION_ID_RE.test(sessionId) ? Object.freeze({ sessionId }) : null
}

/**
 * @param {unknown} raw
 * @returns {{sessionId: string, title?: string}}
 */
function normalizeFrom(raw) {
  if (!isPlainObject(raw)) return { sessionId: '' }
  const sessionId = asString(raw.sessionId)
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : undefined
  return title === undefined ? { sessionId } : { sessionId, title }
}

/**
 * Envelope/shape check for one stored record. Unknown types, v2, invalid
 * envelopes, unknown kinds or recipients are skipped (a reader never throws).
 * @param {unknown} record
 * @returns {record is Record<string, unknown>}
 */
function isFoldableMessage(record) {
  if (!isPlainObject(record)) return false
  if (record.v !== 1) return false
  if (record.type !== 'message') return false
  if (typeof record.ws !== 'string' || record.ws.length === 0) return false
  if (!isUlid(record.seq)) return false
  if (typeof record.id !== 'string' || record.id === '') return false
  if (!MESSAGE_KIND_SET.has(asString(record.kind))) return false
  if (typeof record.body !== 'string') return false
  if (!isPlainObject(record.from) || !SESSION_ID_RE.test(asString(record.from.sessionId))) return false
  return normalizeRecipient(record.to) !== null
}

/**
 * Pure fold of `message` records: immutable messages ordered oldest-first
 * (newest last), deduped by id (first by seq). `maxSeq` is the greatest seq of
 * any valid message and is the cursor surface for the inbox watermark.
 *
 * @param {readonly unknown[]} records
 * @returns {{messages: Array<{id: string, seq: string, from: {sessionId: string, title?: string}, to: {kind: 'workspace'} | {sessionId: string}, kind: string, body: string, replyTo?: string, ts: string}>, maxSeq: string}}
 */
export function foldMessages(records) {
  /** @type {Record<string, unknown>[]} */
  const valid = []
  if (Array.isArray(records)) {
    for (const record of records) {
      if (isFoldableMessage(record)) valid.push(record)
    }
  }
  valid.sort(compareRecords)
  /** @type {Map<string, object>} */
  const byId = new Map()
  let maxSeq = ''
  for (const record of valid) {
    const seq = asString(record.seq)
    if (seq > maxSeq) maxSeq = seq
    const id = asString(record.id)
    if (byId.has(id)) continue
    const to = normalizeRecipient(record.to)
    if (to === null) continue
    const replyTo = typeof record.replyTo === 'string' && record.replyTo !== '' ? record.replyTo : undefined
    /** @type {Record<string, unknown>} */
    const message = {
      id,
      seq,
      from: Object.freeze(normalizeFrom(record.from)),
      to,
      kind: asString(record.kind),
      body: asString(record.body),
      ts: asString(record.ts),
    }
    if (replyTo !== undefined) message.replyTo = replyTo
    byId.set(id, Object.freeze(message))
  }
  const messages = [...byId.values()].sort(compareRecords)
  return { messages: Object.freeze(messages), maxSeq }
}

/**
 * @param {object} message folded message
 * @param {string} sessionId
 * @returns {boolean}
 */
function isAddressedTo(message, sessionId) {
  const to = isPlainObject(message.to) ? message.to : {}
  if (to.kind === 'workspace') return true
  return to.sessionId === sessionId
}

/** @returns {{messages: [], maxSeq: '', count: 0}} a fresh empty service view */
function emptyView() {
  return Object.freeze({ messages: Object.freeze([]), maxSeq: '', count: 0 })
}

/**
 * MessageBus — one instance per plugin mount; `Map<wsKey, state>` keeps the
 * journal, the folded message list and the synchronous snapshot per workspace.
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
export class MessageBus {
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
    if (!store) throw new TypeError('MessageBus requires a store with openWorkspace()')
    if (!redactor) throw new TypeError('MessageBus requires a redactor')
    this.store = store
    this.config = isPlainObject(config) ? config : {}
    this.redactor = redactor
    this.logger = logger
    this.deps = isPlainObject(deps) ? deps : {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.ulid = createUlidFactory(this.now, this.deps.random ?? Math.random)
    const busConfig = isPlainObject(this.config.bus) ? this.config.bus : {}
    const messagesConfig = isPlainObject(busConfig.messages) ? busConfig.messages : {}
    this.maxStored = clampInt(messagesConfig.maxStored, MESSAGE_MAX_STORED, 1, 5000)
    this.maxBodyBytes = clampInt(messagesConfig.maxBodyBytes, MESSAGE_MAX_BODY_BYTES, 1, 49152)
    /**
     * @type {Map<string, {
     *   wsKey: string,
     *   journal: object,
     *   fold: ReturnType<typeof foldMessages> | null,
     *   view: {messages: object[], maxSeq: string, count: number} | null,
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
      // Logging must never break a message operation.
    }
  }

  /** @param {unknown} wsKey @returns {string} */
  _assertWorkspaceKey(wsKey) {
    if (typeof wsKey !== 'string' || wsKey.length === 0) {
      throw busError('BAD_ARGUMENT', 'workspace key is required')
    }
    return wsKey
  }

  /**
   * Open (or reuse) one workspace journal, subscribe to its change feed and warm
   * the folded message list. Idempotent per scope and safe under concurrent callers.
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
      throw busError('STORE_UNAVAILABLE', 'the store does not support workspace journals')
    }
    const journal = await this.store.openWorkspace(wsKey, meta)
    if (!journal || typeof journal !== 'object') {
      throw busError('STORE_UNAVAILABLE', 'the workspace journal is unavailable')
    }
    this._detachScope(wsKey)
    /** @type {{wsKey: string, journal: object, fold: ReturnType<typeof foldMessages> | null, view: {messages: object[], maxSeq: string, count: number} | null}} */
    const state = { wsKey, journal, fold: null, view: null }
    this._scopes.set(wsKey, state)
    this._subscribeToChanges(wsKey, journal)
    try {
      if (typeof this.store.refreshMerged === 'function') await this.store.refreshMerged(wsKey)
      else if (typeof journal.refresh === 'function') await journal.refresh()
    } catch (error) {
      this.debug('bus.attach_refresh_failed', { wsKey, message: String(error) })
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
      this.debug('bus.subscribe_failed', { wsKey, source: 'store', message: String(error) })
    }
    try {
      if (journal && typeof journal.onChange === 'function') {
        track(journal.onChange(() => this._invalidate(wsKey)))
      }
    } catch (error) {
      this.debug('bus.subscribe_failed', { wsKey, source: 'journal', message: String(error) })
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
   * Detach one workspace scope (the store journal stays open: board/context/pulse
   * may share it; the store LRU owns journal lifetime).
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
    if (state === undefined) throw busError('STORE_UNAVAILABLE', 'the workspace message bus is not attached')
    if (state.journal && state.journal.isOpen !== false) return state
    await this.attach(wsKey)
    const reopened = this._scopes.get(wsKey)
    if (reopened === undefined) throw busError('STORE_UNAVAILABLE', 'the workspace message bus is not attached')
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
      this.debug('bus.records_failed', { wsKey: state.wsKey, message: String(error) })
    }
    return EMPTY_RECORDS
  }

  /**
   * @param {object} state
   * @returns {ReturnType<typeof foldMessages>}
   */
  _foldOf(state) {
    if (state.fold === null) state.fold = foldMessages(this._records(state))
    return state.fold
  }

  /**
   * @param {object} state
   * @returns {{messages: object[], maxSeq: string, count: number}}
   */
  _viewOf(state) {
    const fold = this._foldOf(state)
    if (state.view === null) {
      state.view = Object.freeze({ messages: fold.messages, maxSeq: fold.maxSeq, count: fold.messages.length })
    }
    return state.view
  }

  /**
   * Synchronous workspace message snapshot for pulse/panel: every valid message
   * oldest-first plus `maxSeq`. An unattached/unknown scope yields
   * `{messages:[],maxSeq:'',count:0}` and never throws.
   *
   * @param {string} wsKey
   * @returns {{messages: object[], maxSeq: string, count: number}}
   */
  view(wsKey) {
    const state = typeof wsKey === 'string' ? this._scopes.get(wsKey) : undefined
    if (state === undefined) return emptyView()
    try {
      return this._viewOf(state)
    } catch (error) {
      this.debug('bus.view_failed', { wsKey, message: String(error) })
      return emptyView()
    }
  }

  /**
   * Append one addressed message. Validation → redaction → cap check → durable
   * append (fsync). Messages are immutable; there is no edit/delete path.
   *
   * @param {string} wsKey
   * @param {{
   *   from: {sessionId: string, title?: string},
   *   to: string | {kind: 'workspace'} | {sessionId: string},
   *   kind: string,
   *   body: string,
   *   replyTo?: string,
   * }} input `to` accepts the tool form (`'*'` broadcast or a session id) or the record form.
   * @returns {Promise<{id: string, seq: string, to: {kind: 'workspace'} | {sessionId: string}, kind: string}>}
   */
  async send(wsKey, input) {
    this._assertWorkspaceKey(wsKey)
    if (!isPlainObject(input)) throw busError('BAD_ARGUMENT', 'send input must be an object')
    const from = this._normalizeFrom(input.from)
    const kind = asString(input.kind)
    if (!MESSAGE_KIND_SET.has(kind)) throw busError('BAD_ARGUMENT', `unknown message kind "${kind}"`)
    const to = normalizeRecipient(input.to)
    if (to === null) {
      throw busError('BAD_ARGUMENT', 'to must be "*" (broadcast) or an exact session id')
    }
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      throw busError('BAD_ARGUMENT', 'body is required')
    }
    let replyTo
    if (input.replyTo !== undefined) {
      if (typeof input.replyTo !== 'string' || !MESSAGE_ID_RE.test(input.replyTo)) {
        throw busError('BAD_ARGUMENT', 'replyTo must be a msg_ id')
      }
      replyTo = input.replyTo
    }
    const redacted = this.redactor.text(input.body)
    if (redacted.value.trim() === '' && input.body.trim() !== '') {
      throw busError('REDACTED', 'the body was entirely sensitive and cannot be stored')
    }
    const bytes = Buffer.byteLength(redacted.value, 'utf8')
    if (bytes > this.maxBodyBytes) {
      throw busError('BODY_TOO_LARGE', `body is ${bytes} bytes; the message cap is ${this.maxBodyBytes}`)
    }
    const state = await this._attachedState(wsKey)
    const fold = this._foldOf(state)
    if (fold.messages.length >= this.maxStored) {
      throw busError('LIMIT_EXCEEDED', `this workspace has reached ${this.maxStored} stored messages`)
    }
    const id = `msg_${this.ulid()}`
    /** @type {Record<string, unknown>} */
    const record = {
      v: 1,
      type: 'message',
      id,
      ws: wsKey,
      from,
      to,
      kind,
      body: redacted.value,
    }
    if (replyTo !== undefined) record.replyTo = replyTo
    let stored
    try {
      stored = await state.journal.appendAndSync(record)
    } catch (error) {
      throw busError('STORE_UNAVAILABLE', 'the message could not be persisted', { cause: error })
    }
    this._invalidate(wsKey)
    return { id: asString(stored?.id) || id, seq: asString(stored?.seq), to, kind }
  }

  /**
   * Synchronous inbox read. Returns messages addressed to `sessionId` (directly
   * or via a workspace broadcast), oldest-first with the newest last. `readSeq`
   * is the caller-owned cursor: messages with `seq > readSeq` are unread and are
   * filtered out unless `includeRead`. The bus never writes a read marker.
   *
   * `maxSeq` is the greatest seq of any valid workspace message so the caller can
   * advance its cursor past messages not addressed to this session.
   *
   * @param {string} wsKey
   * @param {{sessionId?: string, readSeq?: string | null, limit?: number, includeRead?: boolean}} [options]
   * @returns {{messages: object[], unread: number, maxSeq: string}}
   */
  inbox(wsKey, options = {}) {
    /** @type {{messages: object[], unread: number, maxSeq: string}} */
    const empty = { messages: [], unread: 0, maxSeq: '' }
    const sessionId = isPlainObject(options) ? asString(options.sessionId) : ''
    if (sessionId === '') return empty
    const state = typeof wsKey === 'string' ? this._scopes.get(wsKey) : undefined
    if (state === undefined) return empty
    try {
      const fold = this._foldOf(state)
      const cursor = isPlainObject(options) && typeof options.readSeq === 'string' ? options.readSeq : ''
      const includeRead = isPlainObject(options) && options.includeRead === true
      const limit = clampInt(
        isPlainObject(options) ? options.limit : undefined,
        DEFAULT_INBOX_LIMIT,
        1,
        MAX_INBOX_LIMIT,
      )
      /** @type {object[]} */
      const addressed = []
      let unread = 0
      for (const message of fold.messages) {
        if (!isAddressedTo(message, sessionId)) continue
        const isUnread = cursor === '' || asString(message.seq) > cursor
        if (isUnread) unread += 1
        if (!includeRead && !isUnread) continue
        addressed.push(message)
      }
      const messages = addressed.length > limit ? addressed.slice(-limit) : addressed
      return { messages, unread, maxSeq: fold.maxSeq }
    } catch (error) {
      this.debug('bus.inbox_failed', { wsKey, message: String(error) })
      return empty
    }
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
      this.debug('bus.refresh_failed', { wsKey, message: String(error) })
    } finally {
      this._invalidate(wsKey)
    }
    return changed
  }

  /**
   * Validate and normalise the sending author. Authority for sessionId comes from
   * the caller (the facade/tools pass the real session), never from model data.
   *
   * @param {unknown} from
   * @returns {{sessionId: string, title?: string}}
   */
  _normalizeFrom(from) {
    if (!isPlainObject(from)) throw busError('BAD_ARGUMENT', 'from is required')
    const sessionId = asString(from.sessionId)
    if (!SESSION_ID_RE.test(sessionId)) throw busError('BAD_ARGUMENT', 'from.sessionId is required')
    if (from.title === undefined) return { sessionId }
    if (typeof from.title !== 'string') throw busError('BAD_ARGUMENT', 'from.title must be a string')
    const title = this.redactor.title(from.title).value
    return title === '' ? { sessionId } : { sessionId, title }
  }
}
