// Confluence / 高级记忆 — integration facade (v0.3: workspace bus + global profile).
//
// The facade is the only object the model-facing tools (`lib/tools.js`) and the
// read-only panel routes (`lib/hostui.js`) talk to. v0.3 has TWO scopes:
//
//   workspace — frozen from the session's original cwd (realpath, win32
//               lower-case, `ws_<sha256[:16]>`): shared context, notes, messages.
//   global    — the user profile (facts), plus the metadata-only session ledger
//               and presence heartbeats that stay profile-wide.
//
// It owns: scope resolution + caching, lazy workspace attachment (board/context/
// bus), synchronous bus views for the pulse, the profile APIs, the read-only
// panel payloads, and private-session gating. No network, no DSH imports.
//
// Contract: docs/plan/v0.3-interfaces.md §3.9 and docs/adr/0008-bus-and-profile.md.

import path from 'node:path'
import { ConfluenceError } from './util.js'
import { canonicalizeDir, workspaceKeyFor } from './workspace.js'
import { GLOBAL_SCOPE_KEY } from './store.js'
import { buildMemoryDocument, importMemoryDocument, renderMemoryMarkdown } from './export.js'

/** The global (profile) scope label used by panel/prompt text. */
export const PROFILE_SCOPE = Object.freeze({ key: 'global', label: 'All sessions' })

const WORKSPACE_KEY_RE = /^ws_[0-9a-f]{16}$/
const ENTRY_ID_RE = /^(?:cnf|tmb)_[0-9A-HJKMNP-TV-Z]{26}$/
const MESSAGE_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{4,128}$/
const MAX_PANEL_WORKSPACES = 50
const MAX_PANEL_ROWS = 50
const MAX_PANEL_CONTEXT = 20
const MAX_PANEL_MESSAGES = 20
const MAX_PANEL_PEERS = 8
const MAX_OVERVIEW = 100
const NO_WORKSPACE_LABEL = 'No workspace'

/** @param {unknown} value @returns {string} */
function asString(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

/** @param {unknown} value @returns {number} */
function asNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function boundedString(value, fallback = '') {
  const text = asString(value)
  return text.length > 0 ? text : fallback
}

/** @param {unknown} agent @returns {object | null} */
function sessionOf(agent) {
  if (agent === null || typeof agent !== 'object') return null
  const session = agent.session
  return session !== null && typeof session === 'object' ? session : null
}

/** @param {unknown} session @returns {string | null} */
function idOfSession(session) {
  if (session === null || typeof session !== 'object') return null
  const id = asString(session.id)
  if (id !== '') return id
  const headerId = asString(session.header && session.header.id)
  return headerId !== '' ? headerId : null
}

/** @param {unknown} agent @returns {string | null} */
function sessionIdOf(agent) {
  const session = sessionOf(agent)
  const id = idOfSession(session)
  if (id !== null) return id
  if (agent !== null && typeof agent === 'object') {
    const raw = asString(agent.id)
    if (raw !== '') return raw
  }
  return null
}

/** @param {unknown} value @returns {string | null} */
function titleFrom(value) {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (value === null || typeof value !== 'object') return null
  for (const key of ['title', 'displayTitle', 'label']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

/** @param {unknown} origin @returns {{workspaceKey?: string, workspaceLabel?: string}} */
function normalizeOrigin(origin) {
  const record = origin && typeof origin === 'object' ? origin : {}
  const workspaceKey = asString(record.workspaceKey)
  const workspaceLabel = asString(record.workspaceLabel)
  const out = {}
  if (workspaceKey !== '') out.workspaceKey = workspaceKey
  if (workspaceLabel !== '') out.workspaceLabel = workspaceLabel
  return out
}

/**
 * @param {unknown} entry
 * @returns {{id:string,seq:string,kind:string,title:string,ts:string,status:string,replyTo:string,
 *   authorTitle:string,workspaceLabel:string,deleted:boolean,tags:string[],files:string[],body:string}}
 */
function entrySummary(entry) {
  const record = entry && typeof entry === 'object' ? entry : {}
  const author = record.author && typeof record.author === 'object' ? record.author : {}
  const origin = normalizeOrigin(record.origin)
  return {
    id: asString(record.id),
    seq: asString(record.seq),
    kind: asString(record.kind) || 'warning',
    title: asString(record.title),
    ts: asString(record.ts ?? record.createdAt),
    status: asString(record.status) || 'active',
    replyTo: asString(record.replyTo),
    authorTitle: asString(author.title ?? record.authorTitle ?? record.sessionTitle),
    workspaceLabel: asString(origin.workspaceLabel),
    deleted: record.deleted === true,
    tags: Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === 'string') : [],
    files: Array.isArray(record.files) ? record.files.filter((f) => typeof f === 'string') : [],
    body: asString(record.body),
  }
}

/** @param {string} platform @param {string} canonicalPath @returns {string} */
function basenameFor(canonicalPath, platform) {
  const base = platform === 'win32' ? path.win32.basename(canonicalPath) : path.basename(canonicalPath)
  return base === '' ? '' : base
}

export class ConfluenceFacade {
  /**
   * @param {object} options
   * @param {object} options.config resolved config
   * @param {object} [options.logger] structured logger
   * @param {object} options.store JournalStore
   * @param {object} options.board BoardService (scope-parameterised)
   * @param {object} options.context ContextService
   * @param {object} options.bus MessageBus
   * @param {object} options.profile ProfileService (persona)
   * @param {object} options.memory MemoryService (long-term patterns)
   * @param {object} options.style StyleService (style cards)
   * @param {object} options.presence Presence
   * @param {object} options.watermark WatermarkTracker
   * @param {object} options.redactor createRedactor() result
   * @param {object} [options.recall] RecallService (optional)
   * @param {object | null} [options.sessionQuery] optional host service
   * @param {object | null} [options.sessionTitle] optional host service
   * @param {(name: string) => any} [options.getService] lazy host service lookup
   * @param {object} [options.fs] fs/promises-like (tests)
   * @param {string} [options.platform] process.platform (tests)
   * @param {() => void} [options.onChanged] best-effort change notification
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    this.config = opts.config && typeof opts.config === 'object' ? opts.config : {}
    this.logger = opts.logger
    this.store = opts.store
    this.boardService = opts.board
    this.contextService = opts.context
    this.busService = opts.bus
    this.profileService = opts.profile
    this.memoryService = opts.memory ?? null
    this.styleService = opts.style ?? null
    this.presence = opts.presence
    this.watermark = opts.watermark
    this.redactor = opts.redactor
    this.recallService = opts.recall ?? null
    this.sessionQuery = opts.sessionQuery ?? null
    this.sessionTitle = opts.sessionTitle ?? null
    this.getService = typeof opts.getService === 'function' ? opts.getService : () => undefined
    this.fs = opts.fs ?? null
    this.platform = typeof opts.platform === 'string' ? opts.platform : process.platform
    this.onChanged = typeof opts.onChanged === 'function' ? opts.onChanged : null

    /** @type {Map<string, object>} live Session objects by id */
    this.sessions = new Map()
    /** @type {Map<string, {key: string, label: string, canonicalPath: string}>} scope by session id */
    this.scopes = new Map()
    /** @type {Map<string, {key: string, label: string, canonicalPath?: string}>} known scope labels */
    this.scopeLabels = new Map()
    /** @type {Map<string, string>} session title cache */
    this.titles = new Map()
    /** @type {Map<string, Promise<void>>} per-workspace attachment single-flight */
    this.attachPromises = new Map()
    /** @type {Promise<void> | null} global (persona/memory/style) attachment single-flight */
    this.globalReady = null
    /** @type {Map<string, Promise<string[]>>} pending scope enumeration */
    this.listPromise = null
  }

  // ── session / scope plumbing ────────────────────────────────────────────

  /** @param {object | null} session */
  trackSession(session) {
    const id = idOfSession(session)
    if (id !== null) this.sessions.set(id, session)
  }

  /** @param {string} sessionId @returns {object | null} */
  sessionFor(sessionId) {
    const session = this.sessions.get(sessionId)
    return session === undefined ? null : session
  }

  /**
   * Provenance view for one session (panel/presence); null until resolved.
   * @param {string} sessionId
   * @returns {{workspaceKey: string, workspaceLabel: string} | null}
   */
  originFor(sessionId) {
    const scope = this.scopes.get(sessionId)
    return scope === undefined || scope === null
      ? null
      : { workspaceKey: scope.key, workspaceLabel: scope.label }
  }

  /**
   * Synchronous frozen scope for an agent (used by the pulse provider).
   * @param {object | null} agent
   * @returns {{key: string, label: string} | null}
   */
  scopeForAgent(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === null) return null
    const scope = this.scopes.get(sessionId)
    return scope === undefined || scope === null ? null : { key: scope.key, label: scope.label }
  }

  /**
   * Resolve (once, frozen) the workspace scope of one agent and attach the
   * workspace services. Throws `NO_WORKSPACE` only when the caller asked for a
   * workspace operation (`workspaceFor`); `ensureReady` returns `{scope:null}`.
   *
   * @param {object} agent
   * @returns {Promise<{scope: {key: string, label: string, canonicalPath: string} | null, origin: object | null}>}
   */
  async ensureReady(agent) {
    this.assertSharedMemoryAllowed(agent)
    const session = sessionOf(agent)
    this.trackSession(session)
    const sessionId = sessionIdOf(agent)
    if (sessionId === null) return { scope: null, origin: null }
    if (!this.scopes.has(sessionId)) {
      const scope = await this._resolveScope(agent)
      this.scopes.set(sessionId, scope)
    }
    const scope = this.scopes.get(sessionId) ?? null
    if (scope !== null) {
      await this._attachWorkspace(scope)
      this.scopeLabels.set(scope.key, { key: scope.key, label: scope.label, canonicalPath: scope.canonicalPath })
    } else {
      await this._attachGlobal()
    }
    return { scope, origin: scope === null ? null : { workspaceKey: scope.key, workspaceLabel: scope.label } }
  }

  /**
   * Workspace scope for one agent, without the internal canonical path.
   * @param {object} agent
   * @returns {Promise<{key: string, label: string}>}
   */
  async workspaceScope(agent) {
    const scope = await this.workspaceFor(agent)
    return { key: scope.key, label: scope.label }
  }

  /**
   * Workspace scope for one agent; throws `NO_WORKSPACE` when the session has no
   * resolvable original directory.
   *
   * @param {object} agent
   * @returns {Promise<{key: string, label: string, canonicalPath: string}>}
   */
  async workspaceFor(agent) {
    const { scope } = await this.ensureReady(agent)
    if (scope === null) {
      throw new ConfluenceError(
        'NO_WORKSPACE',
        'this session has no workspace directory, so the workspace session bus is unavailable.',
      )
    }
    return scope
  }

  /**
   * `privacy.privateSessions` opts a session out of every Confluence surface.
   * @param {object} agent
   * @returns {boolean}
   */
  isPrivateSession(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === null) return false
    const privacy = this.config && typeof this.config === 'object' ? this.config.privacy : null
    const list = privacy && Array.isArray(privacy.privateSessions) ? privacy.privateSessions : []
    return list.includes(sessionId)
  }

  /** @param {object} agent */
  assertSharedMemoryAllowed(agent) {
    if (this.isPrivateSession(agent)) {
      throw new ConfluenceError(
        'UNAVAILABLE',
        'this session is listed in privacy.privateSessions; Confluence is disabled for it.',
      )
    }
  }

  /** @param {object} agent @returns {Promise<string>} */
  async titleFor(agent) {
    const session = sessionOf(agent)
    const sessionId = sessionIdOf(agent)
    if (sessionId === null) return ''
    this.trackSession(session)
    const cached = this.titles.get(sessionId)
    if (cached !== undefined) return cached
    let title = null
    try {
      if (this.sessionQuery && typeof this.sessionQuery.readTitle === 'function') {
        title = titleFrom(await Promise.resolve(this.sessionQuery.readTitle(sessionId)))
      }
    } catch {
      title = null
    }
    if (title === null && this.sessionTitle && typeof this.sessionTitle.get === 'function' && session !== null) {
      try {
        title = titleFrom(this.sessionTitle.get(session))
      } catch {
        title = null
      }
    }
    if (title === null && session !== null) title = titleFrom(session.header && session.header.title)
    const value = title === null ? '' : title
    this.titles.set(sessionId, value)
    return value
  }

  // ── workspace bus: notes ────────────────────────────────────────────────

  /**
   * Workspace notes action. `input.action` is one of list|read|post|reply|search.
   * @param {object} agent
   * @param {object} input
   * @returns {Promise<object>}
   */
  async board(agent, input) {
    const scope = await this.workspaceFor(agent)
    const sessionId = sessionIdOf(agent) ?? ''
    const action = asString(input && input.action).toLowerCase()
    const limit = clampLimit(input && input.limit, 10, 1, 20)
    const origin = { workspaceKey: scope.key, workspaceLabel: scope.label }

    if (action === 'post') {
      const author = { sessionId, title: await this.titleFor(agent), origin: 'agent' }
      const posted = await this.boardService.post(
        scope.key,
        {
          kind: input.kind,
          title: input.title,
          body: input.body,
          tags: input.tags,
          files: input.files,
        },
        author,
        origin,
      )
      this.notifyChanged()
      return this._boardResult(action, scope, { entry: withReplyCount(entrySummary(posted), 0), entries: [] })
    }

    if (action === 'reply') {
      const target = asString(input && input.id)
      if (target === '') throw new ConfluenceError('BAD_ARGUMENT', 'id is required.')
      const thread = await this.boardService.thread(scope.key, target)
      if (!thread || thread.notFound || !thread.entry) {
        throw new ConfluenceError('NOT_FOUND', `no workspace note "${target}".`)
      }
      const root = thread.entry.replyTo ? await this.boardService.thread(scope.key, asString(thread.entry.replyTo)) : thread
      const rootEntry = root && root.entry ? root.entry : thread.entry
      const rootId = asString(rootEntry && rootEntry.id) || target
      const kind = asString(rootEntry && rootEntry.kind) || 'warning'
      const body = asString(input && input.body)
      const resolves = input && typeof input.resolves === 'boolean' ? input.resolves : undefined
      if (body.trim() === '' && resolves !== true) {
        throw new ConfluenceError('BAD_ARGUMENT', 'body is required unless resolves is set.')
      }
      const author = { sessionId, title: await this.titleFor(agent), origin: 'agent' }
      const posted = await this.boardService.post(
        scope.key,
        {
          kind: ['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning'].includes(kind) ? kind : 'warning',
          title: `Re: ${asString(rootEntry && rootEntry.title)}`,
          ...(body.trim() === '' ? {} : { body }),
          replyTo: rootId,
          resolves,
        },
        author,
        origin,
      )
      this.notifyChanged()
      return this._boardResult(action, scope, { entry: entrySummary(posted), entries: [] })
    }

    if (action === 'read') {
      const ref = asString(input && input.id)
      if (ref === '') throw new ConfluenceError('BAD_ARGUMENT', 'id is required.')
      const thread = await this.boardService.thread(scope.key, ref)
      if (!thread || thread.notFound || !thread.entry) {
        throw new ConfluenceError('NOT_FOUND', `no workspace note "${ref}".`)
      }
      const replies = (thread.replies || []).map(entrySummary)
      const entry = withReplyCount(entrySummary(thread.entry), replies.length)
      const through = [entry.seq, ...replies.map((reply) => reply.seq)].filter(Boolean).sort().pop() || ''
      return this._boardResult(action, scope, { entry, replies, through })
    }

    if (action === 'search') {
      const q = asString(input && input.q).trim()
      if (q === '') throw new ConfluenceError('BAD_ARGUMENT', 'q is required.')
      const result = await this.boardService.search(scope.key, {
        query: q,
        kind: input && input.kind,
        limit,
      })
      const rows = (result.hits || []).map((hit) => withReplyCount(entrySummary(hit.entry), 0))
      const through = rows.map((row) => row.seq).filter(Boolean).sort().pop() || ''
      return this._boardResult(action, scope, {
        entries: rows,
        truncated: result.truncated === true,
        through,
      })
    }

    // list (default)
    const view = this._safeBoardView(scope.key)
    let roots = Array.isArray(view.roots) ? view.roots.slice() : []
    const kind = asString(input && input.kind)
    if (kind !== '') roots = roots.filter((entry) => asString(entry.kind) === kind)
    const q = asString(input && input.q).trim()
    if (q !== '') {
      const result = await this.boardService.search(scope.key, { query: q, kind: kind === '' ? undefined : kind, limit })
      roots = (result.hits || []).map((hit) => hit.entry)
    }
    const counts = replyCountsFromView(view)
    const rows = roots.slice(-limit).map((root) => withReplyCount(entrySummary(root), counts.get(asString(root && root.id)) ?? 0))
    const through = rows.map((row) => row.seq).filter(Boolean).sort().pop() || ''
    const cursor = this._cursor(sessionId)
    const boardReadSeq = cursor === null ? null : asString(cursor.boardReadSeq) || null
    return this._boardResult(action === '' ? 'list' : action, scope, {
      entries: rows,
      unread: rows.filter((row) => boardReadSeq === null || row.seq > boardReadSeq).length,
      truncated: roots.length > limit,
      through,
      stats: view.stats || {},
    })
  }

  // ── workspace bus: shared state ─────────────────────────────────────────

  /**
   * @param {object} agent
   * @param {{action?: string, key?: string, value?: string, valueType?: string, prefix?: string, limit?: number}} input
   * @returns {Promise<object>}
   */
  async context(agent, input) {
    const scope = await this.workspaceFor(agent)
    const sessionId = sessionIdOf(agent) ?? ''
    const action = asString(input && input.action).toLowerCase() || 'list'
    const limit = clampLimit(input && input.limit, 20, 1, 50)
    const author = { sessionId, title: await this.titleFor(agent) }

    if (action === 'get') {
      const key = asString(input && input.key)
      if (key === '') throw new ConfluenceError('BAD_ARGUMENT', 'key is required.')
      const entry = this.contextService.get(scope.key, key)
      if (entry === null) throw new ConfluenceError('NOT_FOUND', `no shared state "${key}".`)
      return { action, scope: this._scopeRow(scope), entry: contextRow(entry) }
    }

    if (action === 'set') {
      const key = asString(input && input.key)
      const value = asString(input && input.value)
      const valueType = asString(input && input.valueType) || 'text'
      const result = await this.contextService.set(scope.key, { key, value, valueType, author })
      this.notifyChanged()
      return {
        action,
        scope: this._scopeRow(scope),
        entry: { key: result.key, value, valueType, updatedAt: '', authorTitle: author.title ?? '', seq: result.seq },
      }
    }

    if (action === 'delete') {
      const key = asString(input && input.key)
      const result = await this.contextService.delete(scope.key, { key, author })
      this.notifyChanged()
      return { action, scope: this._scopeRow(scope), deleted: result.deleted === true, key: result.key, seq: result.seq }
    }

    if (action !== 'list') throw new ConfluenceError('BAD_ARGUMENT', `unknown action "${action}".`)
    const view = this.contextService.view(scope.key)
    const prefix = asString(input && input.prefix)
    let entries = Array.isArray(view.entries) ? view.entries : []
    if (prefix !== '') entries = entries.filter((entry) => entry.key.startsWith(prefix))
    return {
      action,
      scope: this._scopeRow(scope),
      entries: entries.slice(0, limit).map(contextRow),
      count: entries.length,
      truncated: entries.length > limit,
    }
  }

  // ── workspace bus: peer messages ────────────────────────────────────────

  /**
   * Send one peer message inside this workspace. Delivery is queued: the
   * recipient sees it in its next-step pulse and in `confluence_inbox`.
   *
   * @param {object} agent
   * @param {{to?: string, kind?: string, body?: string, replyTo?: string}} input
   * @returns {Promise<object>}
   */
  async send(agent, input) {
    const scope = await this.workspaceFor(agent)
    const sessionId = sessionIdOf(agent) ?? ''
    const from = { sessionId, title: await this.titleFor(agent) }
    const broadcast = asString(input && input.to) === '*'
    const peers = this._peersFor(scope.key, sessionId)
    let to
    if (broadcast) {
      to = { kind: 'workspace' }
    } else {
      const target = asString(input && input.to)
      if (!SESSION_ID_RE.test(target)) throw new ConfluenceError('BAD_ARGUMENT', 'to must be "*" or a live session id.')
      if (target === sessionId) throw new ConfluenceError('BAD_ARGUMENT', 'a session cannot message itself.')
      const live = peers.find((peer) => peer.sessionId === target)
      if (!live) {
        throw new ConfluenceError(
          'NOT_FOUND',
          'no live session with that id in this workspace; use confluence_inbox to list peers.',
        )
      }
      to = { sessionId: target }
    }
    const result = await this.busService.send(scope.key, {
      from,
      to,
      kind: asString(input && input.kind),
      body: asString(input && input.body),
      replyTo: asString(input && input.replyTo) || undefined,
    })
    this.notifyChanged()
    return {
      id: result.id,
      seq: result.seq,
      to: broadcast ? '*' : to.sessionId,
      kind: result.kind,
      queued: true,
      peers: peers.length,
      scope: this._scopeRow(scope),
    }
  }

  /**
   * Read peer messages addressed to this session (or broadcast). The caller's
   * `inboxReadSeq` cursor is advanced by the committed tool result marker.
   *
   * @param {object} agent
   * @param {{limit?: number, includeRead?: boolean}} input
   * @returns {Promise<object>}
   */
  async inbox(agent, input) {
    const scope = await this.workspaceFor(agent)
    const sessionId = sessionIdOf(agent) ?? ''
    const limit = clampLimit(input && input.limit, 10, 1, 20)
    const includeRead = input && input.includeRead === true
    const view = this.busService.view(scope.key)
    const all = (Array.isArray(view.messages) ? view.messages : []).filter((message) => {
      const to = message.to && typeof message.to === 'object' ? message.to : null
      const addressed = (to !== null && to.kind === 'workspace') || (to !== null && to.sessionId === sessionId)
      if (!addressed) return false
      const from = message.from && typeof message.from === 'object' ? message.from : null
      return from === null || from.sessionId !== sessionId
    })
    const cursor = this._cursor(sessionId)
    const readSeq = cursor === null ? null : asString(cursor.inboxReadSeq) || null
    const unread = all.filter((message) => readSeq === null || asString(message.seq) > readSeq)
    const selected = includeRead ? all.slice(-limit) : unread.slice(0, limit)
    const peers = this._peersFor(scope.key, sessionId)
    return {
      action: 'inbox',
      scope: this._scopeRow(scope),
      messages: selected,
      unread: unread.length,
      peers: peers.map((peer) => ({ sessionId: peer.sessionId, title: peer.title, status: peer.status })),
      throughInbox: selected.map((message) => asString(message.seq)).filter(Boolean).sort().pop() || '',
    }
  }

  // ── user persona (individual traits) ───────────────────────────────────

  /**
   * Persona action: get|list|set|forget. Long-term-memory portability lives in
   * `memory` (§4.2); the persona only records individual traits.
   *
   * @param {object} agent
   * @param {object} input
   * @returns {Promise<object>}
   */
  async profile(agent, input) {
    this.assertSharedMemoryAllowed(agent)
    await this._attachGlobal()
    const action = asString(input && input.action).toLowerCase() || 'list'
    const sessionId = sessionIdOf(agent) ?? ''
    const author = { sessionId, title: await this.titleFor(agent) }
    const scope = { key: PROFILE_SCOPE.key, label: PROFILE_SCOPE.label }

    if (action === 'set') {
      const facts = normalizeFactsInput(input, this.config)
      await this.profileService.setFacts({ facts, source: 'agent', author })
      this.notifyChanged()
      const listed = this.profileService.list({})
      const rows = normalizeProfileSections(listed)
      return { action, revision: asString(listed.revision), count: listed.count, sections: rows, facts: rows.flatMap((row) => row.facts), scope }
    }

    if (action === 'forget') {
      const section = asString(input && input.section)
      const key = asString(input && input.key)
      const result = await this.profileService.forget({ section, key, author })
      this.notifyChanged()
      const listed = this.profileService.list({})
      const rows = normalizeProfileSections(listed)
      return {
        action,
        revision: asString(result.revision ?? listed.revision),
        count: listed.count,
        sections: rows,
        facts: rows.flatMap((row) => row.facts),
        deleted: result.deleted === true,
        scope,
      }
    }

    const section = asString(input && input.section)
    const key = asString(input && input.key)
    const listed = this.profileService.list({ section: section === '' ? undefined : section })
    const rows = normalizeProfileSections(listed)
    const facts = rows.flatMap((row) => row.facts)
    if (action === 'get') {
      if (section === '' || key === '') throw new ConfluenceError('BAD_ARGUMENT', 'get requires section and key.')
      const fact = facts.find((row) => row.section === section && row.key === key)
      if (fact === undefined) throw new ConfluenceError('NOT_FOUND', 'no such profile fact.')
      return { action, revision: asString(listed.revision), count: 1, sections: [{ section, facts: [fact] }], facts: [fact], scope }
    }
    return { action, revision: asString(listed.revision), count: facts.length, sections: rows, facts, scope }
  }

  // ── long-term memory (generalized patterns) ────────────────────────────

  /**
   * Long-term-memory action: list|search|add|promote|reject|update|forget|
   * export|import. New patterns are always candidates until promoted.
   *
   * @param {object} agent
   * @param {object} input
   * @returns {Promise<object>}
   */
  async memory(agent, input) {
    this.assertSharedMemoryAllowed(agent)
    await this._attachGlobal()
    const action = asString(input && input.action).toLowerCase() || 'list'
    const sessionId = sessionIdOf(agent) ?? ''
    const author = { sessionId, title: await this.titleFor(agent) }
    const scope = { key: PROFILE_SCOPE.key, label: PROFILE_SCOPE.label }

    if (action === 'list' || action === 'search') {
      const listed = this.memoryService.list({
        status: input && input.status,
        category: input && input.category,
        query: (input && (input.query ?? input.q)) ?? '',
        limit: input && input.limit,
      })
      return { action, scope, patterns: listed.patterns, count: listed.count }
    }

    if (action === 'add') {
      const patternScope = asString(input && input.scope) === 'workspace' ? 'workspace' : 'global'
      let workspaceKey = asString(input && input.workspaceKey)
      let workspaceLabel = asString(input && input.workspaceLabel)
      if (patternScope === 'workspace' && workspaceKey === '') {
        const current = await this.workspaceFor(agent)
        workspaceKey = current.key
        if (workspaceLabel === '') workspaceLabel = current.label
      }
      const result = await this.memoryService.add({
        key: input && input.key,
        category: input && input.category,
        title: input && input.title,
        body: input && input.body,
        tags: input && input.tags,
        scope: patternScope,
        workspaceKey: patternScope === 'workspace' ? workspaceKey : undefined,
        workspaceLabel: patternScope === 'workspace' ? workspaceLabel : undefined,
        confidence: input && input.confidence,
        evidence: input && input.evidence,
        author,
      })
      this.notifyChanged()
      return { action, scope, pattern: result.pattern, count: 1 }
    }

    if (action === 'promote' || action === 'reject' || action === 'forget' || action === 'update') {
      const key = asString(input && input.key)
      let result
      if (action === 'promote') result = await this.memoryService.promote({ key, author })
      else if (action === 'reject') result = await this.memoryService.reject({ key, author })
      else if (action === 'forget') result = await this.memoryService.forget({ key, author })
      else {
        result = await this.memoryService.update({
          key,
          title: input && input.title,
          body: input && input.body,
          tags: input && input.tags,
          confidence: input && input.confidence,
          author,
        })
      }
      this.notifyChanged()
      return { action, scope, pattern: result.pattern, count: 1 }
    }

    if (action === 'export') {
      const doc = this._buildMemoryDocument()
      const text = JSON.stringify(doc)
      return { action, scope, exported: { format: 'json', text, bytes: Buffer.byteLength(text, 'utf8') } }
    }

    if (action === 'import') {
      const text = asString(input && input.data)
      if (text === '') throw new ConfluenceError('BAD_ARGUMENT', 'data (JSON memory document) is required.')
      let doc
      try {
        doc = JSON.parse(text)
      } catch {
        throw new ConfluenceError('BAD_ARGUMENT', 'data is not valid JSON.')
      }
      const mode = asString(input && input.mode) === 'replace' ? 'replace' : 'merge'
      const livePatterns = this.memoryService.list({ status: 'all', limit: 1000 }).patterns
      const liveStyles = this.styleService.list({}).styles
      const plan = importMemoryDocument(doc, {
        mode,
        maxPatterns: asNumber(this.config.memory?.maxPatterns) || 300,
        maxFacts: asNumber(this.config.profile?.maxFacts) || 200,
        maxRules: asNumber(this.config.style?.maxRules) || 100,
        maxValueBytes: asNumber(this.config.profile?.maxValueBytes) || 1024,
        maxExportBytes: asNumber(this.config.profile?.maxExportBytes) || 65536,
        live: { patterns: livePatterns, styles: liveStyles },
      })
      const applied = await this._applyMemoryImport(plan, author)
      this.notifyChanged()
      return {
        action,
        scope,
        revision: asString(plan.revision),
        imported: {
          mode,
          count: applied.persona + applied.patterns + applied.styles,
          replaced: mode === 'replace',
        },
      }
    }

    throw new ConfluenceError('BAD_ARGUMENT', `unknown memory action "${action}".`)
  }

  /**
   * Synchronous long-term-memory prompt block for the calling agent.
   * @param {object | undefined} agent
   * @returns {string}
   */
  memoryRender(agent) {
    try {
      if (agent !== undefined && this.isPrivateSession(agent)) return ''
      if (this.config.memory && this.config.memory.enabled === false) return ''
      if (this.memoryService === null || typeof this.memoryService.renderBlock !== 'function') return ''
      const scope = agent === undefined ? null : this.scopeForAgent(agent)
      return this.memoryService.renderBlock(scope === null ? {} : { workspaceKey: scope.key })
    } catch {
      return ''
    }
  }

  // ── style cards (output conventions) ────────────────────────────────────

  /**
   * Style action: list|set|remove.
   * @param {object} agent
   * @param {object} input
   * @returns {Promise<object>}
   */
  async style(agent, input) {
    this.assertSharedMemoryAllowed(agent)
    await this._attachGlobal()
    const action = asString(input && input.action).toLowerCase() || 'list'
    const sessionId = sessionIdOf(agent) ?? ''
    const author = { sessionId, title: await this.titleFor(agent) }
    const scope = { key: PROFILE_SCOPE.key, label: PROFILE_SCOPE.label }

    if (action === 'list') {
      const listed = this.styleService.list({ channel: input && input.channel })
      return { action, scope, styles: listed.styles.map(styleRow), count: listed.count }
    }
    if (action === 'set') {
      const result = await this.styleService.set({
        channel: input && input.channel,
        area: input && input.area,
        key: input && input.key,
        title: input && input.title,
        rule: input && input.rule,
        examples: input && input.examples,
        tags: input && input.tags,
        priority: input && input.priority,
        enabled: input && input.enabled,
        author,
      })
      this.notifyChanged()
      return { action, scope, style: styleRow(result.style), count: 1 }
    }
    if (action === 'remove') {
      const result = await this.styleService.disable({
        channel: input && input.channel,
        key: input && input.key,
        author,
      })
      this.notifyChanged()
      return { action, scope, style: styleRow(result.style), count: 1 }
    }
    throw new ConfluenceError('BAD_ARGUMENT', `unknown style action "${action}".`)
  }

  /**
   * Synchronous style-card prompt block.
   * @returns {string}
   */
  styleRender(agent) {
    try {
      if (agent !== undefined && this.isPrivateSession(agent)) return ''
      if (this.config.style && this.config.style.enabled === false) return ''
      return this.styleService === null || typeof this.styleService.renderBlock !== 'function'
        ? ''
        : this.styleService.renderBlock()
    } catch {
      return ''
    }
  }

  // ── legacy recall (prior sessions on this machine) ──────────────────────

  /**
   * @param {object} agent
   * @param {{query?: string, limit?: number}} input
   * @returns {Promise<object>}
   */
  async recall(agent, input) {
    this.assertSharedMemoryAllowed(agent)
    if (this.recallService === null || typeof this.recallService.recall !== 'function' || !this.recallService.enabled()) {
      throw new ConfluenceError('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    }
    return await this.recallService.recall({ agent, query: input && input.query, limit: input && input.limit })
  }

  /**
   * @param {object} agent
   * @param {string} ref `session:<id>:<seq>`
   * @returns {Promise<object>}
   */
  async readRef(agent, ref) {
    this.assertSharedMemoryAllowed(agent)
    if (this.recallService === null || typeof this.recallService.readRef !== 'function' || !this.recallService.enabled()) {
      throw new ConfluenceError('RECALL_UNAVAILABLE', 'session history is not readable in this profile.')
    }
    return await this.recallService.readRef({ agent, ref })
  }

  // ── synchronous read views (pulse / tools) ──────────────────────────────

  /**
   * Synchronous bus view for one workspace scope, used by the pulse provider.
   * Never throws; returns null when the scope has not been attached yet.
   *
   * @param {string} scopeKey
   * @returns {object | null}
   */
  busView(scopeKey) {
    try {
      const key = asString(scopeKey)
      if (!WORKSPACE_KEY_RE.test(key)) return null
      const boardView = this._safeBoardView(key)
      const contextView = this._safeContextView(key)
      const messageView = this._safeMessageView(key)
      const peers = this._peersFor(key, null)
      const roots = Array.isArray(boardView.roots) ? boardView.roots : []
      return {
        state: Array.isArray(contextView.entries) ? contextView.entries : [],
        notes: roots,
        messages: Array.isArray(messageView.messages) ? messageView.messages : [],
        peers,
      }
    } catch {
      return null
    }
  }

  /**
   * Synchronous rendered profile block for the prompt contribution.
   * @returns {string}
   */
  profileRender() {
    try {
      if (this.config.profile && this.config.profile.enabled === false) return ''
      return typeof this.profileService.render === 'function' ? this.profileService.render() : ''
    } catch {
      return ''
    }
  }

  // ── read-only panel payloads ────────────────────────────────────────────

  /**
   * Workspace list for the panel: each known workspace with cheap counts.
   * @returns {Promise<object>}
   */
  async panelWorkspaces() {
    const scopes = await this._listScopes()
    const rows = []
    for (const scope of scopes.slice(0, MAX_PANEL_WORKSPACES)) {
      try {
        await this._attachWorkspace({
          key: scope.key,
          label: scope.label,
          canonicalPath: scope.canonicalPath ?? '',
        })
      } catch {
        continue
      }
      const boardView = this._safeBoardView(scope.key)
      const contextView = this._safeContextView(scope.key)
      const messageView = this._safeMessageView(scope.key)
      const peers = this._peersFor(scope.key, null)
      const entries = Array.isArray(boardView.roots) ? boardView.roots : []
      const messages = Array.isArray(messageView.messages) ? messageView.messages : []
      const stateEntries = Array.isArray(contextView.entries) ? contextView.entries : []
      const latest = [
        ...entries.map((entry) => asString(entry.ts)),
        ...messages.map((message) => asString(message.ts)),
        ...stateEntries.map((entry) => asString(entry.updatedAt)),
      ]
        .filter((ts) => ts !== '')
        .sort()
        .pop()
      rows.push({
        id: scope.key,
        label: scope.label || NO_WORKSPACE_LABEL,
        entries: entries.length,
        state: stateEntries.length,
        messages: messages.length,
        peers: peers.length,
        lastActivity: latest ?? '',
      })
    }
    rows.sort((left, right) => (right.lastActivity > left.lastActivity ? 1 : right.lastActivity < left.lastActivity ? -1 : 0))
    return {
      ok: true,
      profile: { label: PROFILE_SCOPE.label },
      workspaces: rows,
      truncated: scopes.length > MAX_PANEL_WORKSPACES,
    }
  }

  /**
   * One workspace timeline for the panel (context, notes, messages, peers).
   * @param {{ws?: string, q?: string, kind?: string, limit?: number}} [requested]
   * @returns {Promise<object>}
   */
  async panelBus(requested = {}) {
    const ws = asString(requested && requested.ws)
    if (!WORKSPACE_KEY_RE.test(ws)) throw new ConfluenceError('BAD_ARGUMENT', 'ws must be a workspace id.')
    const scope = this.scopeLabels.get(ws) ?? { key: ws, label: this._labelFromStore(ws) }
    let attachError = null
    try {
      await this._attachWorkspace({ key: ws, label: scope.label, canonicalPath: scope.canonicalPath ?? '' })
    } catch (error) {
      attachError = error
    }
    if (attachError !== null) {
      return {
        ok: true,
        workspace: { id: ws, label: scope.label || NO_WORKSPACE_LABEL },
        context: [],
        entries: [],
        messages: [],
        peers: [],
        stats: { context: 0, entries: 0, messages: 0, peers: 0 },
        truncated: false,
        unavailable: true,
      }
    }
    const limit = clampLimit(requested && requested.limit, 20, 1, MAX_PANEL_ROWS)
    const kind = asString(requested && requested.kind)
    const q = asString(requested && requested.q).trim()
    const boardView = this._safeBoardView(ws)
    let roots = Array.isArray(boardView.roots) ? boardView.roots.slice() : []
    if (kind !== '') roots = roots.filter((entry) => asString(entry.kind) === kind)
    if (q !== '') {
      const result = await this.boardService.search(ws, { query: q, kind: kind === '' ? undefined : kind, limit })
      roots = (result.hits || []).map((hit) => hit.entry)
    }
    const rows = roots.slice(-limit).map(entrySummary)
    const contextView = this._safeContextView(ws)
    const contextEntries = (Array.isArray(contextView.entries) ? contextView.entries : [])
      .slice(0, MAX_PANEL_CONTEXT)
      .map((entry) => ({
        key: entry.key,
        value: truncateValue(entry.value, 200),
        valueType: entry.valueType === 'json' ? 'json' : 'text',
        updatedAt: asString(entry.updatedAt ?? entry.ts),
        authorTitle: asString(entry.author && entry.author.title),
      }))
    const messageView = this._safeMessageView(ws)
    const messages = (Array.isArray(messageView.messages) ? messageView.messages : [])
      .slice(-MAX_PANEL_MESSAGES)
      .map((message) => ({
        id: asString(message.id),
        seq: asString(message.seq),
        from: asString(message.from && message.from.title) || 'session',
        kind: MESSAGE_KIND_SET.has(message.kind) ? message.kind : 'notice',
        title: truncateValue(asString(message.body), 120),
        ts: asString(message.ts),
      }))
    const peers = this._peersFor(ws, null)
      .slice(0, MAX_PANEL_PEERS)
      .map((peer) => ({ title: peer.title || 'session', status: peer.status }))
    return {
      ok: true,
      workspace: { id: ws, label: scope.label || NO_WORKSPACE_LABEL },
      context: contextEntries,
      entries: rows,
      messages,
      peers,
      stats: {
        context: Array.isArray(contextView.entries) ? contextView.entries.length : 0,
        entries: Array.isArray(boardView.roots) ? boardView.roots.length : 0,
        messages: Array.isArray(messageView.messages) ? messageView.messages.length : 0,
        peers: this._peersFor(ws, null).length,
      },
      truncated: roots.length > limit,
    }
  }

  /**
   * One note thread for the panel.
   * @param {{ws?: string, id?: string}} [requested]
   * @returns {Promise<object>}
   */
  async panelEntry(requested = {}) {
    const ws = asString(requested && requested.ws)
    const id = asString(requested && requested.id)
    if (!WORKSPACE_KEY_RE.test(ws)) throw new ConfluenceError('BAD_ARGUMENT', 'ws must be a workspace id.')
    if (!ENTRY_ID_RE.test(id)) throw new ConfluenceError('NOT_FOUND', 'entry not found.')
    await this._attachWorkspace({ key: ws, label: this._labelFromStore(ws), canonicalPath: '' })
    const thread = await this.boardService.thread(ws, id)
    if (!thread || thread.notFound || !thread.entry) throw new ConfluenceError('NOT_FOUND', 'entry not found.')
    const summary = entrySummary(thread.entry)
    return {
      ok: true,
      entry: {
        id: summary.id,
        seq: summary.seq,
        kind: summary.kind,
        title: summary.title,
        body: summary.body,
        tags: summary.tags,
        files: summary.files,
        authorTitle: summary.authorTitle,
        ts: summary.ts,
        status: summary.status,
      },
      replies: (thread.replies || []).map((reply) => {
        const row = entrySummary(reply)
        return { id: row.id, seq: row.seq, body: row.body, authorTitle: row.authorTitle, ts: row.ts }
      }),
    }
  }

  /**
   * Persona + style cards for the panel.
   * @returns {Promise<object>}
   */
  async panelProfile() {
    await this._attachGlobal()
    const listed = this.profileService.list({})
    const stylesListed = this.styleService.list({})
    const styles = stylesListed.styles.map((style) => ({
      channel: style.channel,
      area: style.area,
      key: style.key,
      title: style.title,
      rule: style.rule,
      examples: Array.isArray(style.examples) ? style.examples : [],
      enabled: style.enabled !== false,
      priority: asNumber(style.priority),
    }))
    return {
      ok: true,
      revision: listed.revision,
      sections: listed.sections,
      styles,
      stats: { sections: listed.sections.length, facts: listed.count, styles: styles.length },
      truncated: false,
    }
  }

  /**
   * Long-term-memory patterns for the panel (active rules and candidates).
   * @returns {Promise<object>}
   */
  async panelMemory() {
    await this._attachGlobal()
    const listed = this.memoryService.list({ status: 'all', limit: 1000 })
    const patterns = listed.patterns
    const candidates = patterns.filter((pattern) => pattern.status === 'candidate')
    const active = patterns.filter((pattern) => pattern.status === 'active')
    return {
      ok: true,
      revision: listed.revision,
      patterns: active,
      candidates,
      stats: { total: patterns.length, active: active.length, candidates: candidates.length },
      truncated: false,
    }
  }

  /**
   * Full memory document for the panel download route (raw file text, no envelope).
   * @param {{format?: string}} [requested]
   * @returns {Promise<{format: string, text: string, bytes: number}>}
   */
  async panelProfileExport(requested = {}) {
    await this._attachGlobal()
    const format = asString(requested && requested.format) === 'md' ? 'md' : 'json'
    const doc = this._buildMemoryDocument()
    const text = format === 'md' ? renderMemoryMarkdown(doc) : JSON.stringify(doc, null, 2)
    return { format, text, bytes: Buffer.byteLength(text, 'utf8') }
  }

  // ── internals: memory document / import ─────────────────────────────────

  /** @returns {object} canonical confluence.memory/v1 document for this profile */
  _buildMemoryDocument() {
    const persona = this.profileService.list({})
    const patterns = this.memoryService.list({ status: 'all', limit: 1000 }).patterns
    const styles = this.styleService.list({}).styles
    return buildMemoryDocument({
      persona,
      patterns,
      styles,
      revision: persona.revision,
      limits: {
        maxFacts: asNumber(this.config.profile?.maxFacts) || 200,
        maxPatterns: asNumber(this.config.memory?.maxPatterns) || 300,
        maxRules: asNumber(this.config.style?.maxRules) || 100,
      },
      maxExportBytes: asNumber(this.config.profile?.maxExportBytes) || 65536,
      maxValueBytes: asNumber(this.config.profile?.maxValueBytes) || 1024,
      now: Date.now(),
    })
  }

  /**
   * Apply a validated memory import plan (persona, patterns, styles).
   * @param {object} plan result of importMemoryDocument()
   * @param {object} author
   * @returns {Promise<{persona: number, patterns: number, styles: number}>}
   */
  async _applyMemoryImport(plan, author) {
    // The memory document allows a timestamp on persona facts; the profile
    // document schema (which owns the reset/merge semantics) names the same
    // field `updatedAt`. Normalize before validation.
    const personaSections = (Array.isArray(plan.persona.sections) ? plan.persona.sections : []).map((section) => ({
      id: section.id,
      facts: (Array.isArray(section.facts) ? section.facts : []).map((fact) => {
        const row = {
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          source: fact.source,
        }
        const ts = typeof fact.ts === 'string' ? fact.ts : typeof fact.updatedAt === 'string' ? fact.updatedAt : ''
        if (ts !== '') row.updatedAt = ts
        return row
      }),
    }))
    const personaDoc = { format: 'confluence.profile/v1', version: 1, sections: personaSections }
    const personaResult = await this.profileService.importDocument(personaDoc, { mode: plan.mode, author })
    for (const entry of plan.patterns.upsert) await this.memoryService.importPattern(entry)
    for (const entry of plan.patterns.reject) {
      try {
        await this.memoryService.reject({ key: entry.key, author })
      } catch (error) {
        if (!(error instanceof ConfluenceError) || error.code !== 'NOT_FOUND') throw error
      }
    }
    for (const entry of plan.styles.upsert) await this.styleService.importStyle(entry)
    for (const entry of plan.styles.disable) {
      try {
        await this.styleService.disable({ channel: entry.channel, key: entry.key, author })
      } catch (error) {
        if (!(error instanceof ConfluenceError) || error.code !== 'NOT_FOUND') throw error
      }
    }
    return {
      persona: asNumber(personaResult.imported),
      patterns: plan.patterns.count,
      styles: plan.styles.count,
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** @param {object} agent @returns {Promise<{key:string,label:string,canonicalPath:string} | null>} */
  async _resolveScope(agent) {
    const session = sessionOf(agent)
    if (session === null) return null
    let rawDir = ''
    try {
      const headerCwd = session.header && session.header.cwd
      if (typeof headerCwd === 'string' && headerCwd !== '') rawDir = headerCwd
    } catch {
      rawDir = ''
    }
    if (rawDir === '') {
      try {
        const workingDirectory = this.getService('workingDirectory')
        if (workingDirectory && typeof workingDirectory.get === 'function') {
          const effective = workingDirectory.get(session)
          if (typeof effective === 'string' && effective !== '') rawDir = effective
        }
      } catch {
        rawDir = ''
      }
    }
    if (rawDir === '') return null
    let canonicalPath
    try {
      canonicalPath = await canonicalizeDir(rawDir, { fs: this.fs ?? undefined, platform: this.platform })
    } catch {
      canonicalPath = null
    }
    if (canonicalPath === null) return null
    const key = workspaceKeyFor(canonicalPath)
    let label = basenameFor(canonicalPath, this.platform)
    try {
      const registry = this.getService('workspaceRegistry')
      if (registry && typeof registry.resolveByPath === 'function') {
        const workspace = await registry.resolveByPath(canonicalPath)
        const title = workspace && typeof workspace.title === 'string' ? workspace.title.trim() : ''
        if (title !== '') label = title
      }
    } catch {
      // The registry is optional; the basename label is the fallback.
    }
    return { key, label, canonicalPath }
  }

  /** @param {{key:string,label:string,canonicalPath?:string}} scope @returns {Promise<void>} */
  async _attachWorkspace(scope) {
    const key = asString(scope && scope.key)
    if (!WORKSPACE_KEY_RE.test(key)) {
      throw new ConfluenceError('UNAVAILABLE', 'the workspace scope is invalid.')
    }
    const existing = this.attachPromises.get(key)
    if (existing !== undefined) return await existing
    const meta = { canonicalPath: asString(scope.canonicalPath), label: asString(scope.label) }
    const promise = Promise.resolve()
      .then(async () => {
        if (this.boardService && typeof this.boardService.attach === 'function') await this.boardService.attach(key, meta)
        if (this.contextService && typeof this.contextService.attach === 'function') await this.contextService.attach(key, meta)
        if (this.busService && typeof this.busService.attach === 'function') await this.busService.attach(key, meta)
      })
      .catch((error) => {
        this.attachPromises.delete(key)
        throw error instanceof ConfluenceError
          ? error
          : new ConfluenceError('STORE_UNAVAILABLE', 'the workspace store is unavailable.', { cause: error })
      })
    this.attachPromises.set(key, promise)
    await promise
  }

  /** @returns {Promise<void>} */
  async _attachGlobal() {
    if (this.globalReady === null) {
      this.globalReady = Promise.resolve()
        .then(async () => {
          if (this.profileService && typeof this.profileService.attach === 'function') await this.profileService.attach()
          if (this.memoryService && typeof this.memoryService.attach === 'function') await this.memoryService.attach()
          if (this.styleService && typeof this.styleService.attach === 'function') await this.styleService.attach()
        })
        .catch((error) => {
          this.globalReady = null
          throw new ConfluenceError('STORE_UNAVAILABLE', 'the global memory store is unavailable.', { cause: error })
        })
    }
    await this.globalReady
  }

  /** @param {string} scopeKey @returns {object} */
  _safeBoardView(scopeKey) {
    try {
      if (this.boardService && typeof this.boardService.view === 'function') {
        const view = this.boardService.view(scopeKey)
        if (view && typeof view === 'object') return view
      }
    } catch {
      // Read paths degrade to an empty view.
    }
    return { roots: [], entries: new Map(), stats: { entries: 0 } }
  }

  /** @param {string} scopeKey @returns {object} */
  _safeContextView(scopeKey) {
    try {
      if (this.contextService && typeof this.contextService.view === 'function') {
        const view = this.contextService.view(scopeKey)
        if (view && typeof view === 'object') return view
      }
    } catch {
      // Read paths degrade to an empty view.
    }
    return { entries: [], count: 0 }
  }

  /** @param {string} scopeKey @returns {object} */
  _safeMessageView(scopeKey) {
    try {
      if (this.busService && typeof this.busService.view === 'function') {
        const view = this.busService.view(scopeKey)
        if (view && typeof view === 'object') return view
      }
    } catch {
      // Read paths degrade to an empty view.
    }
    return { messages: [], count: 0 }
  }

  /** @param {string} scopeKey @param {string | null} excludeSessionId @returns {Array<object>} */
  _peersFor(scopeKey, excludeSessionId) {
    try {
      if (this.presence && typeof this.presence.peersForWorkspace === 'function') {
        return this.presence.peersForWorkspace(scopeKey, excludeSessionId)
      }
    } catch {
      // Presence is best effort.
    }
    return []
  }

  /** @param {string} sessionId @returns {object | null} */
  _cursor(sessionId) {
    const session = sessionId === '' ? null : this.sessionFor(sessionId)
    if (session === null || this.watermark === null || this.watermark === undefined) return null
    try {
      return typeof this.watermark.get === 'function' ? this.watermark.get(session) : null
    } catch {
      return null
    }
  }

  /** @param {object} scope @returns {{key:string,label:string}} */
  _scopeRow(scope) {
    return { key: asString(scope && scope.key), label: asString(scope && scope.label) || NO_WORKSPACE_LABEL }
  }

  /** @param {string} action @param {object} scope @param {object} extra @returns {object} */
  _boardResult(action, scope, extra) {
    return {
      action,
      scope: this._scopeRow(scope),
      entries: extra.entries ?? [],
      ...(extra.entry === undefined ? {} : { entry: extra.entry }),
      ...(extra.replies === undefined ? {} : { replies: extra.replies }),
      unread: extra.unread ?? 0,
      truncated: extra.truncated === true,
      through: extra.through ?? '',
      ...(extra.stats === undefined ? {} : { stats: extra.stats }),
    }
  }

  /** @returns {Promise<Array<{key:string,label:string,canonicalPath?:string}>>} */
  async _listScopes() {
    const rows = new Map()
    for (const [key, scope] of this.scopeLabels) rows.set(key, { key, label: scope.label, canonicalPath: scope.canonicalPath })
    try {
      if (this.store && typeof this.store.listWorkspaces === 'function') {
        const listed = await this.store.listWorkspaces()
        for (const item of Array.isArray(listed) ? listed : []) {
          const key = asString(item && item.key)
          if (!WORKSPACE_KEY_RE.test(key) || key === GLOBAL_SCOPE_KEY) continue
          const label = asString(item && item.label) || this._labelFromStore(key)
          if (!rows.has(key)) rows.set(key, { key, label, canonicalPath: asString(item && item.canonicalPath) })
        }
      }
    } catch {
      // Enumeration is best effort: live scopes still appear.
    }
    return [...rows.values()]
  }

  /** @param {string} scopeKey @returns {string} */
  _labelFromStore(scopeKey) {
    const known = this.scopeLabels.get(scopeKey)
    if (known !== undefined) return known.label
    return ''
  }

  notifyChanged() {
    try {
      if (this.onChanged !== null) this.onChanged()
    } catch {
      // Notification is best-effort.
    }
  }
}

const MESSAGE_KIND_SET = new Set(['notice', 'instruction', 'query', 'reply'])

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @returns {number} */
function clampLimit(value, fallback, min, max) {
  const n = typeof value === 'number' ? Math.trunc(value) : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** @param {unknown} value @param {number} maxChars @returns {string} */
function truncateValue(value, maxChars) {
  const text = asString(value)
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Normalize the profile `set` input into bounded facts.
 * @param {object} input
 * @param {object} config
 * @returns {Array<{section:string, key:string, value:string, confidence:number}>}
 */
function normalizeFactsInput(input, config) {
  const maxValueBytes = asNumber(config && config.profile && config.profile.maxValueBytes) || 1024
  const rows = []
  const pushOne = (fact) => {
    if (fact === null || typeof fact !== 'object') return
    const section = asString(fact.section)
    const key = asString(fact.key)
    const value = asString(fact.value)
    const confidence = Number.isFinite(fact.confidence) ? Number(fact.confidence) : 0.6
    if (section === '' || key === '' || value === '') return
    if (Buffer.byteLength(value, 'utf8') > maxValueBytes) {
      throw new ConfluenceError('BODY_TOO_LARGE', 'one profile fact value exceeds profile.maxValueBytes.')
    }
    rows.push({ section, key, value, confidence })
  }
  if (Array.isArray(input && input.facts)) {
    for (const fact of input.facts.slice(0, 10)) pushOne(fact)
  } else {
    pushOne({ section: input && input.section, key: input && input.key, value: input && input.value, confidence: input && input.confidence })
  }
  if (rows.length === 0) {
    throw new ConfluenceError('BAD_ARGUMENT', 'section, key and value are required.')
  }
  return rows
}

/** @param {string} id @param {number} count @returns {object} */
function withReplyCount(row, count) {
  return { ...row, replyCount: count }
}

/**
 * Count direct replies per root id from a board view.
 * @param {object} view
 * @returns {Map<string, number>}
 */
function replyCountsFromView(view) {
  const counts = new Map()
  const entries = view && view.entries
  if (entries === null || entries === undefined || typeof entries.values !== 'function') return counts
  try {
    for (const entry of entries.values()) {
      const parent = asString(entry && entry.replyTo)
      if (parent === '') continue
      counts.set(parent, (counts.get(parent) ?? 0) + 1)
    }
  } catch {
    // Counting is best effort.
  }
  return counts
}

/**
 * Normalize one shared-context entry for tool/panel output.
 * @param {object} entry
 * @returns {{key: string, value: string, valueType: string, updatedAt: string, authorTitle: string, seq: string}}
 */
function contextRow(entry) {
  const record = entry && typeof entry === 'object' ? entry : {}
  const author = record.author && typeof record.author === 'object' ? record.author : {}
  return {
    key: asString(record.key),
    value: asString(record.value),
    valueType: asString(record.valueType) === 'json' ? 'json' : 'text',
    updatedAt: asString(record.updatedAt ?? record.ts),
    authorTitle: asString(author.title),
    seq: asString(record.seq),
  }
}

/**
 * Normalize one style card for tool/panel output.
 * @param {object} entry
 * @returns {{channel: string, area: string, key: string, title: string, rule: string, examples: Array<object>, priority: number, enabled: boolean, confidence: number, source: string}}
 */
function styleRow(entry) {
  const record = entry && typeof entry === 'object' ? entry : {}
  return {
    channel: asString(record.channel),
    area: asString(record.area),
    key: asString(record.key),
    title: asString(record.title),
    rule: asString(record.rule),
    examples: Array.isArray(record.examples) ? record.examples.filter((example) => example && typeof example === 'object') : [],
    priority: asNumber(record.priority),
    enabled: record.enabled !== false,
    confidence: Number.isFinite(record.confidence) ? Number(record.confidence) : 0,
    source: asString(record.source),
  }
}

/**
 * Normalize a profile listing into `[{section, facts:[{section,key,value,confidence,source,ts}]}]`.
 * @param {object} listed
 * @returns {Array<{section: string, facts: Array<object>}>}
 */
function normalizeProfileSections(listed) {
  const rows = []
  const sections = listed && Array.isArray(listed.sections) ? listed.sections : []
  for (const section of sections) {
    if (section === null || typeof section !== 'object') continue
    const id = asString(section.section ?? section.id)
    if (id === '') continue
    const facts = (Array.isArray(section.facts) ? section.facts : []).map((fact) => ({
      section: asString(fact && (fact.section ?? id)) || id,
      key: asString(fact && fact.key),
      value: asString(fact && fact.value),
      confidence: Number.isFinite(fact && fact.confidence) ? Number(fact.confidence) : 0.6,
      source: asString(fact && fact.source) || 'agent',
      ts: asString(fact && (fact.ts ?? fact.updatedAt)),
    }))
    rows.push({ section: id, facts })
  }
  return rows
}
