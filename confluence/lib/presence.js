// Confluence / 高级记忆 — WP3b: universal presence heartbeat + synchronous live-peer cache.
//
// Contract: docs/adr/0007-universal-memory-scope.md §2.3; docs/plan/scope-refactor-delta.md §5;
// docs/design/ledger-recall.md §3; docs/design/data-model.md §4.6 (heartbeat), amended by
// ADR-0007: the heartbeat now lives in the GLOBAL journal and `sessionsMeta` carries the
// title/workspaceLabel/status used for rendering.
//
// One heartbeat file per plugin mount: `presence/<writerId>.json` under the global journal. It
// lists ALL live session ids in this profile (`sessions`) plus a private-free `sessionsMeta` map
// `{sessionId: {title?, workspaceLabel?, status?}}`. Presence never touches the journal's record
// space (heartbeat files only) because it changes constantly and would churn the board journal and
// the watermark fold. Private sessions (`privacy.privateSessions`) appear in neither field.
//
// `live()` is SYNCHRONOUS: it reads an in-memory snapshot refreshed by a poll timer and on
// turn/end; `refreshPresence()` is the async refresh seam for polls/tests. Heartbeat writes stay
// async. Heartbeats older than 30 s mean offline and are filtered on read, not cached as live.
//
// The profile/machine is the privacy boundary (single-user local workbench, ADR-0007 §2.8): there
// is exactly one presence namespace, so `live()` takes no workspace scope. A v0.1.0 `live(wsKey)`
// argument is accepted and ignored for compatibility; `refreshPresence(wsKey?, writerId?)` keeps
// its shapes and ignores the workspace argument.
import path from 'node:path'
import * as nodeFs from 'node:fs/promises'

/** Heartbeat cadence while this process has live sessions (ADR-0001 §6). */
const HEARTBEAT_INTERVAL_MS = 10000
/** A heartbeat older than this means offline (ADR-0001 §6). */
const PRESENCE_STALE_MS = 30000
/** Poll interval fallback when config.store.pollMs is absent. */
const DEFAULT_POLL_MS = 5000
const MIN_POLL_MS = 1000
const MAX_POLL_MS = 30000
/** Hard cap on session ids per heartbeat file (data-model §4.6). */
const MAX_SESSIONS_PER_FILE = 32
const PLUGIN_NAME = 'dsh-confluence'
const PLUGIN_VERSION = '0.4.0'

/**
 * Reserved universal scope (scope-refactor-delta §0). Mirrors `lib/store.js` `GLOBAL_SCOPE_KEY`;
 * local so this module stays unit-testable without importing the store. Used only as the
 * heartbeat's informational `ws` field — it never scopes a read or a write.
 */
const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'

/** Provenance labels are basenames only (delta §0); anything else is reduced or dropped. */
const LABEL_MAX_CHARS = 120
/** Render titles are bounded like ledger titles (data-model §4.2). */
const TITLE_MAX_CHARS = 160
/** Workspace scope keys are `ws_` + 16 hex characters (store.js §GLOBAL_SCOPE_KEY shape). */
const WORKSPACE_KEY_RE = /^ws_[0-9a-f]{16}$/

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** @param {number} ms @returns {string} */
function isoFromMs(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** @param {unknown} value @returns {number} */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

/**
 * Basename-only provenance label: strip controls, collapse whitespace, reduce a path to its
 * basename and cap the length. Absent/invalid labels are dropped (provenance is optional).
 * @param {unknown} value
 * @returns {string | undefined}
 */
function labelOnly(value) {
  if (typeof value !== 'string') return undefined
  let label = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (label.length === 0) return undefined
  if (/[\\/]/.test(label)) {
    try {
      label = path.basename(label.replace(/[\\/]+$/, ''))
    } catch {
      return undefined
    }
  }
  label = label.trim()
  if (label.length === 0 || label === '.' || label === '..') return undefined
  return [...label].slice(0, LABEL_MAX_CHARS).join('')
}

/**
 * Validate a workspace scope key carried by a descriptor/heartbeat/ledger row.
 * Invalid values are dropped: the key is an opaque `ws_<16hex>`, never a path.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function workspaceKeyOnly(value) {
  return typeof value === 'string' && WORKSPACE_KEY_RE.test(value) ? value : undefined
}

/**
 * Normalise the heartbeat `sessions` field: v1 writers store `[sessionId, …]` (data-model §4.6);
 * readers tolerate an object form defensively so a future/older writer cannot crash a refresh.
 * @param {unknown} value
 * @returns {string[]}
 */
function sessionIdsOf(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      ids.push(entry)
      continue
    }
    if (isPlainObject(entry)) {
      const id =
        optionalString(entry.sessionId) ?? optionalString(entry.session_id) ?? optionalString(entry.id)
      if (id !== undefined) ids.push(id)
    }
  }
  return [...new Set(ids)]
}

export class Presence {
  /**
   * @param {object} options
   * @param {object} options.store JournalStore with `openGlobal()` (delta §2/§5)
   * @param {object} [options.config] resolved config
   * @param {object} [options.logger] structured logger
   * @param {object} [options.deps] { now, writerId, pid, plugin, fs, setInterval, clearInterval }
   */
  constructor({ store, config, logger, deps } = {}) {
    if (!store || typeof store.openGlobal !== 'function') {
      throw new TypeError('Presence requires a store with openGlobal()')
    }
    this.store = store
    this.config = config ?? {}
    this.logger = logger
    this.deps = deps ?? {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.fs = this.deps.fs ?? nodeFs
    this.setIntervalFn = typeof this.deps.setInterval === 'function' ? this.deps.setInterval : setInterval
    this.clearIntervalFn =
      typeof this.deps.clearInterval === 'function' ? this.deps.clearInterval : clearInterval
    this.writerId =
      optionalString(this.deps.writerId) ??
      optionalString(this.store.writerId) ??
      `${typeof this.deps.pid === 'number' ? this.deps.pid : process.pid}-00000000`
    this.pid = typeof this.deps.pid === 'number' ? this.deps.pid : process.pid
    this.plugin = isPlainObject(this.deps.plugin)
      ? this.deps.plugin
      : { name: PLUGIN_NAME, version: PLUGIN_VERSION }
    this.pollMs = clampInt(this.config?.store?.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS)
    this.global = null // the one global journal (presence dir lives here)
    this.globalPromise = null
    this.written = false // this writer has a heartbeat file under the global journal
    this.localDescriptors = [] // descriptor snapshot from listLiveSessionsFn (async-refreshed)
    /** @type {{at: number, entries: Array<object>}} synchronous live-peer snapshot */
    this.snapshot = { at: 0, entries: [] }
    this.pollTimer = null
    this.heartbeatTimer = null
    this.disposers = []
    this.disposed = false
  }

  /**
   * Attach to the host: subscribe to turn/end for an immediate heartbeat+refresh, start the
   * heartbeat (10 s) and presence-poll timers, and seed the cache. Call inside the plugin effect;
   * the returned function stops everything (also `dispose()`).
   *
   * @param {object} ctx Cordis plugin context
   * @param {() => Array<object> | Promise<Array<object>>} listLiveSessionsFn returns the host's
   *   current live session descriptors `{ id|sessionId, title?, workspaceLabel?, status? }`
   * @returns {() => void}
   */
  attach(ctx, listLiveSessionsFn) {
    this.listLiveSessionsFn = typeof listLiveSessionsFn === 'function' ? listLiveSessionsFn : () => []
    if (ctx && typeof ctx.on === 'function') {
      try {
        const off = ctx.on('session/event', (session, event) => {
          const type = optionalString(event?.type)
          if (type === 'turn/end' || type === 'session/flush') void this.tick()
        })
        if (typeof off === 'function') this.disposers.push(off)
      } catch {
        // Optional host event in restricted contexts.
      }
      try {
        const offDisposed = ctx.on('session/disposed', () => void this.tick())
        if (typeof offDisposed === 'function') this.disposers.push(offDisposed)
      } catch {
        // Optional event.
      }
    }
    this.heartbeatTimer = this.setIntervalFn(() => void this.tick(), HEARTBEAT_INTERVAL_MS)
    this.pollTimer = this.setIntervalFn(() => void this.refreshPresence(), this.pollMs)
    for (const timer of [this.heartbeatTimer, this.pollTimer]) {
      if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    }
    void this.tick()
    return () => this.dispose()
  }

  /** One heartbeat + poll refresh cycle (also the turn/end hook). */
  async tick() {
    if (this.disposed) return
    try {
      await this.writeHeartbeat()
    } catch (error) {
      this.warn({ event: 'presence.heartbeat_failed', error: String(error) })
    }
    try {
      await this.refreshPresence()
    } catch (error) {
      this.warn({ event: 'presence.refresh_failed', error: String(error) })
    }
  }

  /**
   * Write this mount's ONE heartbeat file under the global journal. It lists every live,
   * non-private session in the profile and their render metadata; when no live session remains,
   * the file is removed. Content:
   * `{v:1, ws:'ws_0000000000000000', writerId, pid, plugin, updatedAt,
   *   sessions:[sessionId…], sessionsMeta:{[sessionId]: {title?, workspaceLabel?, status?}}}`
   * @returns {Promise<void>}
   */
  async writeHeartbeat() {
    if (this.disposed) return
    const descriptors = await this.resolveDescriptors()
    const live = descriptors.filter((descriptor) => !this.isSuppressed(descriptor.sessionId))
    const sessions = [...new Set(live.map((descriptor) => descriptor.sessionId))]
      .sort()
      .slice(0, MAX_SESSIONS_PER_FILE)
    const allowed = new Set(sessions)
    const sessionsMeta = {}
    for (const descriptor of live) {
      if (!allowed.has(descriptor.sessionId)) continue
      const meta = {}
      const title = optionalString(descriptor.title)
      if (title !== undefined) meta.title = [...title].slice(0, TITLE_MAX_CHARS).join('')
      const workspaceLabel = labelOnly(descriptor.workspaceLabel)
      if (workspaceLabel !== undefined) meta.workspaceLabel = workspaceLabel
      const workspaceKey = workspaceKeyOnly(descriptor.workspaceKey)
      if (workspaceKey !== undefined) meta.workspaceKey = workspaceKey
      const status = optionalString(descriptor.status)
      if (status !== undefined) meta.status = status
      sessionsMeta[descriptor.sessionId] = meta
    }
    const journal = await this.openGlobalJournal()
    if (journal === null) return
    if (sessions.length === 0) {
      if (this.written) {
        await this.removeHeartbeat(journal)
        this.written = false
      }
      return
    }
    const data = {
      v: 1,
      ws: GLOBAL_SCOPE_KEY,
      writerId: this.writerId,
      pid: this.pid,
      plugin: { name: this.plugin.name ?? PLUGIN_NAME, version: this.plugin.version ?? PLUGIN_VERSION },
      updatedAt: isoFromMs(this.now()),
      sessions,
      sessionsMeta,
    }
    try {
      await journal.writePresence(data)
      this.written = true
    } catch (error) {
      this.warn({ event: 'presence.write_failed', error: String(error) })
    }
  }

  /**
   * Refresh the synchronous live-peer snapshot from the global journal's heartbeat files.
   * Tolerant of absent/corrupt files; joins title/status/workspaceLabel from `sessionsMeta`, then
   * the host descriptors, then the merged ledger `session` rows (newest `seq` wins). Also used
   * directly by tests and the poll timer.
   *
   * @param {string | {writerId?: string}} [scope] v0.1.0 workspace key (ignored) or `{writerId}`
   * @param {string} [writerId] restrict to one heartbeat writer (tests/diagnostics)
   * @returns {Promise<Array<object>>} the refreshed snapshot entries
   */
  async refreshPresence(scope, writerId) {
    if (this.disposed) return []
    const filter =
      optionalString(writerId) ??
      (isPlainObject(scope) ? optionalString(scope.writerId) : undefined)
    const journal = await this.openGlobalJournal()
    if (journal === null) {
      this.snapshot = { at: this.now(), entries: [] }
      return []
    }
    const descriptors = await this.resolveDescriptors()
    const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.sessionId, descriptor]))
    const rows = this.sessionRows()
    let files
    try {
      files = await journal.readPresence()
    } catch (error) {
      this.warn({ event: 'presence.read_failed', error: String(error) })
      files = {}
    }
    const nowMs = this.now()
    const bySession = new Map()
    for (const [otherWriter, data] of Object.entries(isPlainObject(files) ? files : {})) {
      if (filter !== undefined && otherWriter !== filter) continue
      if (!isPlainObject(data)) continue
      const updatedAt = optionalString(data.updatedAt)
      const updatedMs = toMillis(updatedAt)
      if (!Number.isFinite(updatedMs)) continue
      if (nowMs - updatedMs > PRESENCE_STALE_MS) continue
      const metaMap = isPlainObject(data.sessionsMeta) ? data.sessionsMeta : {}
      for (const sessionId of sessionIdsOf(data.sessions)) {
        if (this.isSuppressed(sessionId)) continue
        const previous = bySession.get(sessionId)
        if (previous !== undefined && previous.updatedMs >= updatedMs) continue
        const meta = isPlainObject(metaMap[sessionId]) ? metaMap[sessionId] : {}
        const local = descriptorById.get(sessionId)
        const row = rows.get(sessionId)
        const workspaceLabel =
          labelOnly(optionalString(meta.workspaceLabel)) ??
          labelOnly(optionalString(local?.workspaceLabel)) ??
          labelOnly(optionalString(row?.workspaceLabel))
        const workspaceKey =
          workspaceKeyOnly(optionalString(meta.workspaceKey)) ??
          workspaceKeyOnly(optionalString(local?.workspaceKey)) ??
          workspaceKeyOnly(optionalString(row?.workspaceKey))
        bySession.set(sessionId, {
          sessionId,
          title: optionalString(meta.title) ?? optionalString(local?.title) ?? optionalString(row?.title) ?? '',
          status:
            optionalString(meta.status) ?? optionalString(local?.status) ?? optionalString(row?.status) ?? 'idle',
          workspaceLabel: workspaceLabel ?? '',
          workspaceKey: workspaceKey ?? '',
          writerId: otherWriter,
          updatedAt,
          updatedMs,
        })
      }
    }
    const entries = [...bySession.values()]
      .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
      .map(({ updatedMs, ...entry }) => entry)
    this.snapshot = { at: nowMs, entries }
    return entries
  }

  /**
   * SYNCHRONOUS live-peer view for the whole profile, from the in-memory snapshot cache, filtered
   * to heartbeats younger than 30 s. Safe to call from the pulse provider (never touches disk).
   * The v0.1.0 `live(wsKey)` argument is accepted and ignored: memory is universal.
   * @param {unknown} [ignored] legacy workspace key
   * @returns {Array<{sessionId: string, title: string, status: string, workspaceLabel: string,
   *   writerId: string, updatedAt: string}>}
   */
  live(ignored) {
    void ignored
    const nowMs = this.now()
    const out = []
    for (const entry of this.snapshot.entries) {
      const updatedMs = toMillis(entry.updatedAt)
      if (!Number.isFinite(updatedMs) || nowMs - updatedMs >= PRESENCE_STALE_MS) continue
      out.push({
        sessionId: entry.sessionId,
        title: entry.title,
        status: entry.status,
        workspaceLabel: entry.workspaceLabel,
        workspaceKey: entry.workspaceKey,
        writerId: entry.writerId,
        updatedAt: entry.updatedAt,
      })
    }
    return out
  }

  /**
   * Live peers that belong to one workspace (v0.3 module 1). Never throws; the
   * caller's own session is excluded.
   *
   * @param {string} workspaceKey `ws_<16hex>` scope key
   * @param {string | null} [excludeSessionId]
   * @returns {Array<{sessionId: string, title: string, status: string, workspaceLabel: string, workspaceKey: string}>}
   */
  peersForWorkspace(workspaceKey, excludeSessionId = null) {
    const key = workspaceKeyOnly(workspaceKey)
    if (key === undefined) return []
    return this.live()
      .filter((peer) => peer.workspaceKey === key && peer.sessionId !== excludeSessionId)
      .map((peer) => ({
        sessionId: peer.sessionId,
        title: peer.title,
        status: peer.status,
        workspaceLabel: peer.workspaceLabel,
        workspaceKey: peer.workspaceKey,
      }))
  }

  /** Resolve the host's live-session descriptors (sync array or Promise; both tolerated). */
  async resolveDescriptors() {
    const fn = this.listLiveSessionsFn
    if (typeof fn !== 'function') return []
    let raw
    try {
      raw = await fn()
    } catch (error) {
      this.warn({ event: 'presence.list_live_failed', error: String(error) })
      return this.localDescriptors
    }
    const descriptors = []
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!isPlainObject(item)) continue
      const sessionId =
        optionalString(item.sessionId) ?? optionalString(item.session_id) ?? optionalString(item.id)
      if (sessionId === undefined) continue
      descriptors.push({
        sessionId,
        title: optionalString(item.title),
        status: optionalString(item.status),
        workspaceLabel:
          optionalString(item.workspaceLabel) ??
          optionalString(item.workspace_label) ??
          optionalString(item.label),
        workspaceKey:
          optionalString(item.workspaceKey) ??
          optionalString(item.workspace_key) ??
          optionalString(item.wsKey),
      })
    }
    this.localDescriptors = descriptors
    return descriptors
  }

  /**
   * Merged global-scope `session` rows for the whole profile: id ->
   * {title, status, workspaceLabel, workspaceKey} (last-wins by seq).
   * @returns {Map<string, {title: string, status: string, workspaceLabel?: string, workspaceKey?: string}>}
   */
  sessionRows() {
    let records = []
    const globalRecords = (() => {
      try {
        if (typeof this.store.viewedRecords === 'function') return this.store.viewedRecords(GLOBAL_SCOPE_KEY)
        if (typeof this.store.mergedRecords === 'function') return this.store.mergedRecords()
      } catch {
        return undefined
      }
      return undefined
    })()
    if (Array.isArray(globalRecords)) {
      records = globalRecords
    } else {
      const journal = this.global
      if (journal !== null && typeof journal.records === 'function') {
        try {
          const rows = journal.records()
          if (Array.isArray(rows)) records = rows
        } catch {
          records = []
        }
      }
    }
    const latest = new Map()
    for (const record of records) {
      if (!isPlainObject(record) || record.type !== 'session') continue
      const id = optionalString(record.id) ?? optionalString(record.sessionId)
      if (id === undefined) continue
      const previous = latest.get(id)
      if (previous === undefined || String(record.seq ?? '') > String(previous.seq ?? '')) {
        const origin = isPlainObject(record.origin) ? record.origin : {}
        latest.set(id, {
          title: optionalString(record.title) ?? '',
          status: optionalString(record.status) ?? 'idle',
          workspaceLabel: optionalString(origin.workspaceLabel),
          workspaceKey: optionalString(origin.workspaceKey),
        })
      }
    }
    return latest
  }

  /** Open (once) and cache the one global journal. */
  async openGlobalJournal() {
    if (this.global !== null) return this.global
    if (this.globalPromise !== null) return this.globalPromise
    const promise = Promise.resolve()
      .then(() => this.store.openGlobal())
      .then((journal) => {
        if (journal && typeof journal === 'object') this.global = journal
        return this.global
      })
      .catch((error) => {
        this.warn({ event: 'presence.open_global_failed', error: String(error) })
        return null
      })
      .finally(() => {
        this.globalPromise = null
      })
    this.globalPromise = promise
    return promise
  }

  /** Remove this writer's heartbeat file best-effort (no live sessions or dispose). */
  async removeHeartbeat(journal) {
    try {
      if (typeof journal.deletePresence === 'function') {
        await journal.deletePresence(this.writerId)
        return
      }
      const dir = typeof journal.dir === 'string' ? journal.dir : undefined
      if (dir === undefined) return
      const file = path.join(dir, 'presence', `${this.writerId}.json`)
      await this.fs.unlink(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warn({ event: 'presence.delete_failed', error: String(error) })
      }
    }
  }

  /**
   * Private-session opt-out only: `privacy.privateSessions` keeps a session out of presence.
   * `privacy.disabledWorkspaces` no longer exists (ADR-0007 §2.6/§2.8).
   * @param {string} sessionId
   * @returns {boolean}
   */
  isSuppressed(sessionId) {
    const privacy = isPlainObject(this.config.privacy) ? this.config.privacy : {}
    return Array.isArray(privacy.privateSessions) && privacy.privateSessions.includes(sessionId)
  }

  /** Stop timers/listeners, remove the heartbeat file and clear the cache. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const timer of [this.pollTimer, this.heartbeatTimer]) {
      if (timer !== null) {
        try {
          this.clearIntervalFn(timer)
        } catch {
          // ignore
        }
      }
    }
    this.pollTimer = null
    this.heartbeatTimer = null
    for (const off of this.disposers.splice(0)) {
      try {
        off()
      } catch {
        // ignore
      }
    }
    if (this.written && this.global !== null) {
      await this.removeHeartbeat(this.global)
      this.written = false
    }
    this.snapshot = { at: 0, entries: [] }
    this.localDescriptors = []
  }

  /** @param {object} record */
  warn(record) {
    try {
      this.logger?.warn?.(record)
    } catch {
      // Logging is best-effort and never throws.
    }
  }
}

export const presenceConstants = Object.freeze({
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_STALE_MS,
  DEFAULT_POLL_MS,
  MAX_SESSIONS_PER_FILE,
  PLUGIN_NAME,
  PLUGIN_VERSION,
})
