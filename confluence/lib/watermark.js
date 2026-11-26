// Confluence / 高级记忆 — split watermark for the passive pulse (WP4).
//
// Both cursors are derived from the COMMITTED session log; no watermark files
// are written (ADR 0003 §2, docs/design/pulse.md §8, docs/plan/implementation-interfaces.md §8):
//
//   digestSeq     newest `seq="<ULID>"` attribute of OUR named
//                 `confluence:pulse` section in a committed runtime-context
//                 `user/message` snapshot. It proves which pulse block was
//                 actually delivered and gates the one-time welcome digest.
//                 v0.2.0 blocks open with `<confluence-memory …>` (universal
//                 scope); snapshots committed by v0.1.0 use the legacy
//                 `<confluence-workspace …>` tag and stay readable through the
//                 same parser (delta §4, ADR 0007 §2.3).
//   boardReadSeq  newest `through=<ULID>` marker in a committed tool result of
//                 `confluence_board` / `confluence_read` (standard preset:
//                 `tool/result`; ptc preset: `tool/ptc-dispatch`). It is the
//                 unread cursor: entries `seq > boardReadSeq` are "new".
//
// The durable state is ONE host-only `ctx.sessionProjections` unit
// (`confluence_watermark`, stateVersion 1): `init()` seeds every session/fork,
// the registry folds it eagerly and checkpoints it, and PulseService reads it
// through the retained handle's synchronous `stateOf(session)`.
//
// Degraded fallback (profiles without `sessionProjections`): an in-memory
// per-session fold maintained from `session/event`, seeded once at
// `agent/created` by a bounded reverse scan of the committed log. State is lost
// on restart (a session re-welcomes once) and forks do not inherit cursors.
//
// Constraints: pure/synchronous `apply`, never throws, tolerant parsing keeps
// the previous value on garbage (duplicate headline at worst, never a lost
// note). Contract: docs/plan/implementation-interfaces.md §8.
// Runtime evidence: docs/plan/m0-notes-watermark.md.

/** Projection key. Host-only: not a member of `SessionProjectionMap`. */
export const WATERMARK_KEY = 'confluence_watermark'

/** Projection state schema version; bump when the fold semantics change. */
export const WATERMARK_STATE_VERSION = 1

/** The named runtime-context section this plugin contributes (pulse.md §1). */
export const PULSE_SECTION_NAME = 'confluence:pulse'

/** Opening HTML-like tag of the pulse block (delta §4; universal scope). */
export const PULSE_TAG_NAME = 'confluence-memory'

/** Legacy v0.1.0 tag, still accepted when folding already-committed snapshots. */
const LEGACY_PULSE_TAG_NAME = 'confluence-workspace'

/** Tools whose committed results may advance `boardReadSeq` (tool-api.md §5). */
export const BOARD_READ_TOOLS = Object.freeze(['confluence_board', 'confluence_read'])

/** The inbox tool whose committed result advances `inboxReadSeq` (v0.3 module 1). */
export const INBOX_TOOL = 'confluence_inbox'

const BOARD_READ_TOOL_SET = new Set(BOARD_READ_TOOLS)
const READ_TOOL_SET = new Set([...BOARD_READ_TOOLS, INBOX_TOOL])

/** Bounded `(callId → toolName)` map (pulse.md §8.2 step 1). */
const MAX_PENDING_CALLS = 16

/** Bounded number of sessions kept in the degraded in-memory map. */
const MAX_FALLBACK_SESSIONS = 512

/** Bounded reverse scan used to seed a fallback session (events from the newest end). */
const FALLBACK_SCAN_LIMIT = 4000

/**
 * A pulse marker line starts with the literal or escaped opening tag. The new
 * `<confluence-memory …>` tag is ours; the legacy `<confluence-workspace …>`
 * tag is accepted so pre-v0.2.0 committed snapshots keep advancing the digest
 * cursor (delta §4). The escaped form (`\u003cconfluence-memory …`) is accepted
 * defensively; it is never produced by this plugin (values are escaped, the tag
 * is a constant).
 */
const DIGEST_LINE_START_RE = new RegExp(`^(?:<|\\\\u003c)(?:${PULSE_TAG_NAME}|${LEGACY_PULSE_TAG_NAME})\\b`)

/** `seq="<ULID>"`, or the attribute-quote-escaped `seq=\u0022<ULID>\u0022`. */
const SEQ_ATTR_RE = /seq=(?:"|\\u0022)([0-9A-Z]{1,26})(?:"|\\u0022)/

/** `through=<ULID>` as the last body line (tool-api.md §5 / line 163 tolerance). */
const THROUGH_LINE_RE = /^through=([0-9A-Z]{1,26})$/

/** `inbox=<ULID>` marker rendered by `confluence_inbox` (v0.3 module 1). */
const INBOX_LINE_RE = /^inbox=([0-9A-Z]{1,26})$/

/** A seq-shaped watermark value: our ULID alphabet/sentinel `0`. */
const SEQ_RE = /^[0-9A-Z]{1,26}$/

/** `user/message` content/source shape constants (verified: m0-notes-watermark.md). */
const RUNTIME_CONTEXT_SOURCE = 'runtime-context'

/**
 * @returns {{ digestSeq: string | null, boardReadSeq: string | null, inboxReadSeq: string | null, pending: Record<string, string> }}
 *   a fresh initial state; cursors are `null` until a marker commits.
 */
export function createInitialState() {
  return { digestSeq: null, boardReadSeq: null, inboxReadSeq: null, pending: {} }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * Normalize any stored/checkpointed value into the plain JSON state shape.
 * Tolerates `undefined`, older shapes, and garbage; never throws. `inboxReadSeq`
 * is additive (v0.3) and stays `null` for pre-v0.3 checkpoints.
 *
 * @param {unknown} value
 * @returns {{ digestSeq: string | null, boardReadSeq: string | null, inboxReadSeq: string | null, pending: Record<string, string> }}
 */
export function normalizeWatermarkState(value) {
  const source = value && typeof value === 'object' ? value : {}
  const digestSeq = normalizeSeq(source.digestSeq)
  const boardReadSeq = normalizeSeq(source.boardReadSeq)
  const inboxReadSeq = normalizeSeq(source.inboxReadSeq)
  const pending = {}
  const rawPending = source.pending && typeof source.pending === 'object' ? source.pending : null
  if (rawPending !== null) {
    for (const key of Object.keys(rawPending)) {
      if (Object.keys(pending).length >= MAX_PENDING_CALLS) break
      const name = rawPending[key]
      if (isNonEmptyString(key) && READ_TOOL_SET.has(name)) pending[key] = name
    }
  }
  return { digestSeq, boardReadSeq, inboxReadSeq, pending }
}

/**
 * @param {unknown} value
 * @returns {string | null} the seq when it matches the watermark alphabet, else null
 */
function normalizeSeq(value) {
  return typeof value === 'string' && SEQ_RE.test(value) ? value : null
}

/**
 * Lexicographic maximum; `null` sorts below every seq. ULIDs sort by code unit
 * (tool-api.md §5). Returns `next` only when it actually advances.
 *
 * @param {string | null} current
 * @param {string | null} next
 * @returns {string | null}
 */
function maxSeq(current, next) {
  if (next === null) return current
  if (current === null) return next
  return next > current ? next : current
}

/**
 * Parse `seq="<ULID>"` from the header line of a committed pulse block. Only a
 * line that STARTS with an opening pulse tag is considered, so hostile note
 * titles can never move the digest cursor (pulse.md §8.2, §10.6). Both the
 * current `<confluence-memory …>` tag and the legacy `<confluence-workspace …>`
 * tag of old committed snapshots are accepted (delta §4). Values in the block
 * are escaped, so even the (defensive) escaped tag form is accepted only as a
 * whole-line prefix.
 *
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function parseDigestMarker(text) {
  if (typeof text !== 'string' || text === '') return null
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!DIGEST_LINE_START_RE.test(line)) continue
    const match = SEQ_ATTR_RE.exec(line)
    return match === null ? null : match[1]
  }
  return null
}

/**
 * Parse the `through=<ULID>` marker from a rendered tool-result text block.
 *
 * The tool renderer appends the marker inside the untrusted wrapper, followed by
 * closing tag lines (`</confluence-board>` / `</confluence-result>`), so the
 * marker is no longer the last line of the text. Real newlines are only emitted
 * by the renderer (note text is JSON-escaped, so an injected `through=` stays
 * inside a single line as a literal `\nthrough=` sequence); scanning every
 * newline for a line-anchored marker therefore cannot be forged by shared note
 * content. The last valid marker wins.
 *
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function parseThroughMarker(text) {
  if (typeof text !== 'string' || text === '') return null
  let found = null
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = THROUGH_LINE_RE.exec(line)
    if (match !== null) found = match[1]
  }
  return found
}

/**
 * Parse the `inbox=<ULID>` marker rendered by `confluence_inbox`. Same
 * line-anchored, last-wins rule as `through=`: real newlines come only from the
 * renderer, so shared message text cannot forge the cursor.
 *
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function parseInboxMarker(text) {
  if (typeof text !== 'string' || text === '') return null
  let found = null
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = INBOX_LINE_RE.exec(line)
    if (match !== null) found = match[1]
  }
  return found
}

/**
 * Extract the text body of a committed content-block array. The last text block
 * is the marker carrier for our tools (`output.render` returns one block);
 * joining is a defensive fallback for unusual shapes.
 *
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n')
}

/**
 * @param {unknown} source
 * @returns {string} the `confluence:pulse` section text, or ''
 */
function pulseSectionText(source) {
  if (!source || typeof source !== 'object') return ''
  const sections = source.sections
  if (!Array.isArray(sections)) return ''
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue
    if (section.name !== PULSE_SECTION_NAME) continue
    return typeof section.text === 'string' ? section.text : ''
  }
  return ''
}

/**
 * @param {{ digestSeq: string | null, boardReadSeq: string | null, pending: Record<string, string> }} state
 * @param {unknown} data `user/message` payload (a UserMessage)
 * @returns {object} next state (same reference when nothing changed)
 */
function foldDigest(state, data) {
  const message = data && typeof data === 'object' ? data : null
  if (message === null) return state
  const source = message.source && typeof message.source === 'object' ? message.source : null
  if (source === null || source.kind !== RUNTIME_CONTEXT_SOURCE) return state
  const sections = Array.isArray(source.sections) ? source.sections : null
  // Forge resistance: a multi-context snapshot is scanned ONLY through its
  // named pulse section; other contributions' text is never examined.
  const text = sections !== null ? pulseSectionText(source) : contentText(message.content)
  if (text === '') return state
  const marker = parseDigestMarker(text)
  if (marker === null) return state
  const next = maxSeq(state.digestSeq, marker)
  if (next === state.digestSeq) return state
  return { ...state, digestSeq: next }
}

/**
 * Remember one of our tool calls in the bounded `(callId → name)` map.
 *
 * @param {{ pending: Record<string, string> }} state
 * @param {unknown} callId
 * @param {unknown} name
 * @returns {object} next state (same reference when nothing changed)
 */
function rememberCall(state, callId, name) {
  if (!isNonEmptyString(callId) || !READ_TOOL_SET.has(name)) return state
  if (state.pending[callId] === name) return state
  const pending = { ...state.pending }
  delete pending[callId]
  pending[callId] = name
  const keys = Object.keys(pending)
  for (let index = 0; index < keys.length - MAX_PENDING_CALLS; index += 1) delete pending[keys[index]]
  return { ...state, pending }
}

/**
 * @param {{ pending: Record<string, string> }} state
 * @param {unknown} callId
 * @returns {{ pending: Record<string, string> } | null} next pending map, or null when unchanged
 */
function forgetCall(state, callId) {
  if (!isNonEmptyString(callId) || state.pending[callId] === undefined) return null
  const pending = { ...state.pending }
  delete pending[callId]
  return pending
}

/**
 * Fold `tool/result` (standard preset). The tool name is recovered from the
 * tracked `tool/call` pair, so a committed result of any other tool can never
 * advance the cursor (tool-api.md §5, defense in depth).
 *
 * @param {object} state
 * @param {unknown} data
 * @returns {object}
 */
function foldToolResult(state, data) {
  const payload = data && typeof data === 'object' ? data : null
  if (payload === null) return state
  const message = payload.message && typeof payload.message === 'object' ? payload.message : null
  if (message === null) return state
  const callId = isNonEmptyString(message.toolCallId)
    ? message.toolCallId
    : message.source && isNonEmptyString(message.source.callId)
      ? message.source.callId
      : null
  if (callId === null) return state
  const name = state.pending[callId]
  if (name === undefined) return state
  const pending = forgetCall(state, callId)
  const text = contentText(message.content)
  if (name === INBOX_TOOL) {
    const inboxReadSeq = maxSeq(state.inboxReadSeq ?? null, parseInboxMarker(text))
    return {
      ...state,
      inboxReadSeq,
      pending: pending === null ? state.pending : pending,
    }
  }
  const marker = parseThroughMarker(text)
  const boardReadSeq = maxSeq(state.boardReadSeq, marker)
  return { ...state, boardReadSeq, pending: pending === null ? state.pending : pending }
}

/**
 * Fold `tool/ptc-dispatch` (ptc preset). The dispatch payload carries the tool
 * name and the text blocks directly; `tool/ptc-dispatch-start` still feeds the
 * bounded pending map defensively (m0-notes-watermark.md).
 *
 * @param {object} state
 * @param {unknown} data
 * @returns {object}
 */
function foldPtcDispatch(state, data) {
  const payload = data && typeof data === 'object' ? data : null
  if (payload === null) return state
  const name = payload.name
  if (!READ_TOOL_SET.has(name)) return state
  const subCallId = payload.subCallId
  const pending = forgetCall(state, subCallId)
  const text = contentText(payload.content)
  if (name === INBOX_TOOL) {
    const inboxReadSeq = maxSeq(state.inboxReadSeq ?? null, parseInboxMarker(text))
    return {
      ...state,
      inboxReadSeq,
      pending: pending === null ? state.pending : pending,
    }
  }
  const marker = parseThroughMarker(text)
  const boardReadSeq = maxSeq(state.boardReadSeq, marker)
  return { ...state, boardReadSeq, pending: pending === null ? state.pending : pending }
}

/**
 * Pure, synchronous fold of one committed session event. Unknown types and
 * malformed payloads leave the state untouched (same reference) and never throw.
 *
 * @param {unknown} state previous state (normalized defensively)
 * @param {unknown} event SessionEvent
 * @returns {{ digestSeq: string | null, boardReadSeq: string | null, pending: Record<string, string> }}
 */
export function foldWatermarks(state, event) {
  const previous = state && typeof state === 'object' ? state : createInitialState()
  try {
    if (!event || typeof event !== 'object') return previous
    switch (event.type) {
      case 'user/message':
        return foldDigest(previous, event.data)
      case 'tool/call': {
        const payload = event.data && typeof event.data === 'object' ? event.data : null
        return payload === null ? previous : rememberCall(previous, payload.callId, payload.name)
      }
      case 'tool/ptc-dispatch-start': {
        const payload = event.data && typeof event.data === 'object' ? event.data : null
        return payload === null ? previous : rememberCall(previous, payload.subCallId, payload.name)
      }
      case 'tool/result':
        return foldToolResult(previous, event.data)
      case 'tool/ptc-dispatch':
        return foldPtcDispatch(previous, event.data)
      default:
        return previous
    }
  } catch {
    return previous
  }
}

/**
 * Build the Cordis projection definition for the watermark unit.
 * Host-only: no `wire` view (state is checkpointed but never sent to clients).
 *
 * @returns {{
 *   key: string,
 *   stateVersion: number,
 *   stateSchema: { parse: (value: unknown) => object },
 *   init: (header: unknown, inheritedEventCount: unknown) => object,
 *   apply: (state: unknown, event: unknown) => object,
 * }}
 */
export function createWatermarkProjectionDefinition() {
  return {
    key: WATERMARK_KEY,
    stateVersion: WATERMARK_STATE_VERSION,
    // The projection registry only requires a zod-like `.parse()` here; a plain
    // object is accepted at runtime (verified: m0-notes-watermark.md).
    stateSchema: { parse: (value) => normalizeWatermarkState(value) },
    init: () => createInitialState(),
    apply: (state, event) => foldWatermarks(state, event),
  }
}

/**
 * @param {unknown} session
 * @returns {string | null} session id when available
 */
function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return null
  if (isNonEmptyString(session.id)) return session.id
  if (session.header && isNonEmptyString(session.header.id)) return session.header.id
  return null
}

/**
 * Resolve an optional Cordis service without assuming it is mounted.
 *
 * @param {object | null | undefined} ctx
 * @param {string} name
 * @returns {any}
 */
function getService(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    }
  } catch {
    // An absent optional service may throw through the service proxy.
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** @param {unknown} logger @param {'debug'|'info'|'warn'|'error'} level @param {object} record */
function log(logger, level, record) {
  try {
    const fn = logger && typeof logger[level] === 'function' ? logger[level] : null
    if (fn !== null) fn(record)
  } catch {
    // Logging must never break the plugin.
  }
}

/**
 * Split watermark tracker: one host-only projection unit (or a degraded
 * in-memory fold), a synchronous cursor reader for the pulse provider, and an
 * idempotent lifecycle.
 */
export class WatermarkTracker {
  /**
   * @param {{
   *   config?: object,
   *   logger?: { debug: Function, info: Function, warn: Function, error: Function },
   *   deps?: { now?: () => number },
   * }} [options]
   */
  constructor({ config = {}, logger = null, deps = {} } = {}) {
    this.config = config || {}
    this.logger = logger
    this.deps = deps || {}
    /** @type {{ dispose?: Function, stateOf: Function } | null} */
    this._handle = null
    /** @type {Function | null} registration/effect disposer (hybrid thenable) */
    this._registration = null
    /** @type {Array<Function>} */
    this._disposers = []
    /** @type {Map<string, object>} degraded per-session fold */
    this._fallback = new Map()
    this._attached = false
    this._disposed = false
  }

  /**
   * Register the projection unit (awaited) and the degraded fallback listener.
   * Never throws: a missing or broken `sessionProjections` degrades to the
   * in-memory fold and logs one warning.
   *
   * @param {object} ctx Cordis context
   * @returns {Promise<void>}
   */
  async attach(ctx) {
    if (this._attached || this._disposed) return
    this._attached = true
    this._ctx = ctx

    // Fallback listeners are installed always: they are cheap, bounded, and let
    // get() work when the projection service is absent or throws for a session.
    try {
      if (ctx && typeof ctx.on === 'function') {
        const offEvent = ctx.on('session/event', (session, event) => {
          try {
            this._foldFallback(session, event)
          } catch {
            // The fallback fold is best-effort only.
          }
        })
        if (typeof offEvent === 'function') this._disposers.push(offEvent)

        const offCreated = ctx.on('agent/created', (payload) => {
          if (this._handle !== null) return
          try {
            this._replayFallback(payload && payload.agent ? payload.agent.session : undefined)
          } catch {
            // Best-effort seeding only.
          }
        })
        if (typeof offCreated === 'function') this._disposers.push(offCreated)

        const offDisposed = ctx.on('session/disposed', (session) => {
          const id = sessionIdOf(session)
          if (id !== null) this._fallback.delete(id)
        })
        if (typeof offDisposed === 'function') this._disposers.push(offDisposed)
      }
    } catch {
      // Optional listeners only.
    }

    const projections = getService(ctx, 'sessionProjections')
    if (projections && typeof projections.register === 'function') {
      try {
        const registration = projections.register(createWatermarkProjectionDefinition())
        const handle =
          registration && typeof registration.then === 'function' ? await registration : registration
        if (handle && typeof handle.stateOf === 'function') {
          this._handle = handle
          this._registration = typeof registration === 'function' ? registration : null
        } else {
          log(this.logger, 'warn', {
            event: 'confluence.watermark.projection-unavailable',
            reason: 'register() did not resolve a handle with stateOf()',
          })
        }
      } catch (error) {
        log(this.logger, 'warn', {
          event: 'confluence.watermark.projection-unavailable',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      log(this.logger, 'debug', {
        event: 'confluence.watermark.fallback',
        reason: 'sessionProjections service not mounted',
      })
    }

    // Seed already-live sessions when running degraded: agent/created fired
    // before this plugin activated for them.
    if (this._handle === null) {
      try {
        const agents = getService(ctx, 'agents')
        if (agents && typeof agents.list === 'function') {
          for (const agent of agents.list() || []) this._replayFallback(agent && agent.session)
        }
      } catch {
        // Best-effort seeding only.
      }
    }
  }

  /**
   * Read the committed cursors for one session. Synchronous and side-effect
   * free; unknown sessions read as
   * `{ digestSeq: null, boardReadSeq: null, inboxReadSeq: null }`.
   *
   * @param {unknown} session live Session object (or an object with `{id}`/`{header}`)
   * @returns {{ digestSeq: string | null, boardReadSeq: string | null, inboxReadSeq: string | null }}
   */
  get(session) {
    if (this._handle !== null) {
      try {
        const state = normalizeWatermarkState(this._handle.stateOf(session))
        return { digestSeq: state.digestSeq, boardReadSeq: state.boardReadSeq, inboxReadSeq: state.inboxReadSeq }
      } catch {
        // Fall through to the degraded map.
      }
    }
    const id = sessionIdOf(session)
    const state = id !== null ? normalizeWatermarkState(this._fallback.get(id)) : createInitialState()
    return { digestSeq: state.digestSeq, boardReadSeq: state.boardReadSeq, inboxReadSeq: state.inboxReadSeq }
  }

  /**
   * Degraded-mode hint used when a pulse commit cannot be folded from the log
   * (the projection/fallback path is always preferred). Never decreases and
   * never throws.
   *
   * @param {unknown} sessionId
   * @param {unknown} seq
   * @returns {void}
   */
  observeDigestCommit(sessionId, seq) {
    try {
      if (!isNonEmptyString(sessionId)) return
      const marker = normalizeSeq(seq)
      if (marker === null) return
      const id = sessionId
      const current = normalizeWatermarkState(this._fallback.get(id))
      const digestSeq = maxSeq(current.digestSeq, marker)
      if (digestSeq === current.digestSeq) return
      this._fallback.set(id, { ...current, digestSeq })
      this._trimFallback()
    } catch {
      // Best-effort hint only.
    }
  }

  /**
   * Release the projection reference and listeners. Idempotent; never throws.
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this._disposed) return
    this._disposed = true
    for (const dispose of this._disposers.splice(0).reverse()) {
      try {
        await dispose()
      } catch {
        // Disposal must not throw.
      }
    }
    const handle = this._handle
    this._handle = null
    this._registration = null
    if (handle && typeof handle.dispose === 'function') {
      try {
        await handle.dispose()
      } catch {
        // Disposal must not throw.
      }
    }
    this._fallback.clear()
  }

  // ── degraded fallback internals ──────────────────────────────────────────

  /**
   * Fold one committed event into the degraded per-session map.
   *
   * @param {unknown} session
   * @param {unknown} event
   * @returns {void}
   */
  _foldFallback(session, event) {
    const id = sessionIdOf(session)
    if (id === null) return
    const current = normalizeWatermarkState(this._fallback.get(id))
    const next = foldWatermarks(current, event)
    if (next === current) return
    this._fallback.set(id, next)
    this._trimFallback()
  }

  /**
   * Seed one degraded session by reverse-scanning its committed log (bounded).
   * Newest marker per cursor wins because the scan is newest-first.
   *
   * @param {unknown} session
   * @returns {void}
   */
  _replayFallback(session) {
    const id = sessionIdOf(session)
    if (id === null || this._fallback.has(id)) return
    let events
    try {
      if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
      else if (typeof session.ownEvents === 'function') events = session.ownEvents()
    } catch {
      return
    }
    if (!Array.isArray(events)) return
    const state = createInitialState()
    let first = null
    let firstRead = null
    let scanned = 0
    for (let index = events.length - 1; index >= 0 && scanned < FALLBACK_SCAN_LIMIT; index -= 1, scanned += 1) {
      const event = events[index]
      if (!event || typeof event !== 'object') continue
      try {
        if (first === null && event.type === 'user/message') {
          const marker = digestMarkerOf(event.data)
          if (marker !== null) first = marker
        } else if (firstRead === null && event.type === 'tool/result') {
          const message = event.data && event.data.message ? event.data.message : null
          if (message !== null) {
            const marker = parseThroughMarker(contentText(message.content))
            if (marker !== null) firstRead = marker
          }
        }
      } catch {
        // Tolerant scan.
      }
      if (first !== null && firstRead !== null) break
    }
    if (first !== null || firstRead !== null) {
      state.digestSeq = first
      state.boardReadSeq = firstRead
    }
    this._fallback.set(id, state)
    this._trimFallback()
  }

  /** Bound the degraded session map (oldest insertion evicted first). */
  _trimFallback() {
    while (this._fallback.size > MAX_FALLBACK_SESSIONS) {
      const oldest = this._fallback.keys().next()
      if (oldest.done) break
      this._fallback.delete(oldest.value)
    }
  }
}

/**
 * Marker extraction shared by the fallback scan (no pending bookkeeping).
 *
 * @param {unknown} data `user/message` payload
 * @returns {string | null}
 */
function digestMarkerOf(data) {
  const message = data && typeof data === 'object' ? data : null
  if (message === null) return null
  const source = message.source && typeof message.source === 'object' ? message.source : null
  if (source === null || source.kind !== RUNTIME_CONTEXT_SOURCE) return null
  const sections = Array.isArray(source.sections) ? source.sections : null
  const text = sections !== null ? pulseSectionText(source) : contentText(message.content)
  return parseDigestMarker(text)
}

/**
 * True when the projection unit is active (host-only, awaited).
 *
 * @returns {boolean}
 */
export function isHostOnlyProjectionActive(tracker) {
  return Boolean(tracker && tracker._handle && typeof tracker._handle.stateOf === 'function')
}
