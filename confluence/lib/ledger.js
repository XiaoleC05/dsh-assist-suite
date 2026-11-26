// Confluence / 高级记忆 — WP3a: metadata-only session ledger (ADR-0001 §9, ADR-0007 universal scope).
//
// Contract: docs/adr/0007-universal-memory-scope.md; docs/plan/scope-refactor-delta.md §5;
// docs/design/ledger-recall.md §1–§3, §6 (degradation), §8 L1–L6; docs/design/data-model.md §4.2
// (record shape / field allow-list, with `origin` now a provenance object and the cap global).
//
// Memory is UNIVERSAL: every session row is appended to the one GLOBAL journal
// (`store.openGlobal()`). Workspace/session directory is provenance only — rows carry an optional
// `origin: { workspaceKey?, workspaceLabel? }` and nothing is ever scoped or filtered by workspace.
// A session with no resolvable directory still writes a row (missing origin is valid).
//
// Metadata ONLY. The listener reads exact event fields and never stores prompt, assistant or
// tool-output text, reasoning, command lines or file contents:
//   turn/start               -> status 'live' (memory only)
//   turn/end                 -> turns = max(turns, turn), lastActivityTs, status 'idle', FLUSH NOW
//   tool/call                -> allow-listed path hints from write/edit-style tool arguments only
//   tool/ptc-dispatch        -> same extraction (defensive shape; HYPOTHESIS, `content` never read)
//   tool/result              -> lastActivityTs only (`message.content` / message text never read)
//   session/title            -> sanitized + redacted + capped title (160 code points)
//   working-directory/change -> effectiveDir only when it differs from the session's origin dir
//
// Writes are coalesced journal `session` upsert records (≤1 flush / 5 s / session, forced at
// turn/end and on dispose), appended through the injected store's GLOBAL journal. Readers keep the
// record with the greatest `seq` per session id and return every session in the profile; the view
// is capped at `ledger.maxSessions` (200 default; the old `maxSessionsPerWorkspace` key is
// tolerated as a fallback). No event callback ever throws.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRedactor } from './redact.js'

/** Coalescing window: at most one journal append per session per this interval. */
const FLUSH_MIN_INTERVAL_MS = 5000
/** Fallback caps from config.md §2.4 / data-model §6 (config may lower, never exceed). */
const DEFAULT_MAX_FILES = 8
const MAX_FILES_CEILING = 8
const DEFAULT_MAX_SESSIONS = 200
const MAX_SESSIONS_CEILING = 1000
const MIN_SESSIONS = 20
const TITLE_MAX_CHARS = 160
const LABEL_MAX_CHARS = 120
const EFFECTIVE_DIR_MAX_CHARS = 1024
const MAX_PATH_CHARS = 240
const MAX_ARGUMENT_HINT_CHARS = 512
const MAX_TURNS = 1_000_000

/**
 * Reserved universal scope (scope-refactor-delta §0). Mirrors `lib/store.js` `GLOBAL_SCOPE_KEY`;
 * duplicated locally so this module stays unit-testable without importing the store (the module
 * never uses it to *scope* anything — rows simply land in the one global journal).
 */
const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'

/** Provenance keys must look like real workspace keys; anything else is dropped, never stored. */
const WORKSPACE_KEY_PATTERN = /^ws_[0-9a-f]{16}$/

/** Tool names whose arguments may carry file-path hints (ledger-recall §2.2). */
const PATH_HINT_TOOLS = new Set([
  'write',
  'edit',
  'create_file',
  'apply_patch',
  'multi_edit',
  'str_replace_editor',
  'str_replace_based_edit_tool',
])

/** Argument keys that may carry one path or a list of paths (ledger-recall §2.2). */
const PATH_KEYS = Object.freeze([
  'file_path',
  'filePath',
  'path',
  'target_path',
  'targetPath',
  'files',
  'paths',
])

/**
 * Hard-coded deny globs for file hints (security-privacy §3.3; never removable by config).
 * Mirrors lib/redact.js's built-ins so the static extractor is safe without a config object.
 */
const BUILTIN_DENY_GLOBS = Object.freeze([
  '.ssh/**',
  '.aws/**',
  '.git-credentials',
  '.netrc',
  'id_rsa*',
  '*.key',
  '*.p12',
  '*.pfx',
  'secrets*',
  '**/.env*',
  '**/*.pem',
])

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g
const OSC_SEQUENCE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g
const CSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g
const ESC_SEQUENCE = /\u001B[()#][A-Z0-9]/g
const WHITESPACE_RUN = /\s+/gu

/** Session record fields readers may return (data-model §4.2 allow-list). */
const SESSION_ROW_FIELDS = Object.freeze([
  'v',
  'type',
  'id',
  'ws',
  'seq',
  'ts',
  'title',
  'status',
  'turns',
  'lastActivityTs',
  'effectiveDir',
  'files',
  'parentSession',
  'origin',
  'redactions',
])

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Truncate to `maxChars` Unicode code points without splitting a surrogate pair. */
function truncateCodePoints(value, maxChars) {
  let out = ''
  let count = 0
  for (const char of value) {
    if (count >= maxChars) break
    out += char
    count += 1
  }
  return out
}

/** One-line normalize a title: strip terminal controls/bidi, collapse whitespace, trim. */
function normalizeTitle(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
}

/**
 * Basename-only provenance label (delta §0: labels are basenames, never absolute paths).
 * Anything containing separators is reduced to its basename; unusable values are dropped.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function labelOnly(value) {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeTitle(value)
  if (normalized.length === 0) return undefined
  let label = normalized
  if (/[\\/]/.test(label)) {
    try {
      label = path.basename(label.replace(/[\\/]+$/, ''))
    } catch {
      return undefined
    }
  }
  label = label.trim()
  if (label.length === 0 || label === '.' || label === '..') return undefined
  return truncateCodePoints(label, LABEL_MAX_CHARS)
}

/**
 * Normalise an `origin` provenance block: `{workspaceKey?, workspaceLabel?}`. The key must look
 * like a real workspace key; the label is basename-only. Returns null when nothing valid remains
 * (missing origin is always valid — provenance never blocks memory).
 * @param {unknown} value
 * @returns {{workspaceKey?: string, workspaceLabel?: string} | null}
 */
function originOf(value) {
  if (!isPlainObject(value)) return null
  const rawKey = optionalString(value.workspaceKey) ?? optionalString(value.key)
  const rawLabel = optionalString(value.workspaceLabel) ?? optionalString(value.label)
  const origin = {}
  if (rawKey !== undefined && WORKSPACE_KEY_PATTERN.test(rawKey)) origin.workspaceKey = rawKey
  const label = labelOnly(rawLabel)
  if (label !== undefined) origin.workspaceLabel = label
  return Object.keys(origin).length > 0 ? origin : null
}

/** Convert one deny glob into an anchored RegExp (`**\/` may match zero leading segments). */
function denyGlobToRegExp(pattern) {
  let source = pattern.trim().replace(/\\/g, '/')
  if (source.length === 0) return undefined
  if (!source.includes('/')) source = '**/' + source
  if (!source.startsWith('**/')) source = '**/' + source
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*' && source[index + 1] === '*') {
      if (source[index + 2] === '/') {
        out += '(?:.*/)?'
        index += 2
      } else {
        out += '.*'
        index += 1
      }
    } else if (char === '*') {
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  try {
    return new RegExp('^' + out + '$', 'i')
  } catch {
    return undefined
  }
}

const BUILTIN_DENY_MATCHERS = BUILTIN_DENY_GLOBS.map(denyGlobToRegExp).filter(Boolean)

/** @param {string} relative @returns {boolean} */
function isBuiltinDenied(relative) {
  return BUILTIN_DENY_MATCHERS.some((matcher) => matcher.test(relative))
}

/** @param {string} value @returns {string} */
function foldPath(value) {
  const trimmed = value.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Lexically resolve a candidate against the workspace root and return the stored
 * workspace-relative form, or `undefined` when it is outside the workspace, uses a device/UNC
 * root, contains `..`/NUL, is empty or deny-listed. No filesystem I/O (ledger-recall §2.2).
 * @param {string | undefined} wsRoot absolute canonical workspace path
 * @param {unknown} candidate
 * @returns {string | undefined}
 */
function workspaceRelative(wsRoot, candidate) {
  if (typeof wsRoot !== 'string' || wsRoot.length === 0) return undefined
  if (typeof candidate !== 'string') return undefined
  const raw = candidate.trim()
  if (raw.length === 0 || raw.length > MAX_ARGUMENT_HINT_CHARS) return undefined
  if (raw.includes('\u0000')) return undefined
  if (/^(?:\\\\|\/\/)/.test(raw)) return undefined // UNC/device root: not a workspace-relative path

  let root
  let resolved
  try {
    root = path.resolve(wsRoot).replace(/[\\/]+$/, '')
    resolved = path.resolve(root, raw).replace(/[\\/]+$/, '')
  } catch {
    return undefined
  }
  const foldedRoot = foldPath(root)
  const foldedResolved = foldPath(resolved)
  if (foldedResolved !== foldedRoot && !foldedResolved.startsWith(foldedRoot + path.sep)) return undefined

  let relative
  try {
    relative = path.relative(root, resolved)
  } catch {
    return undefined
  }
  if (relative.length === 0 || path.isAbsolute(relative)) return undefined
  const segments = relative.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) return undefined
  const stored = segments.filter((segment) => segment !== '' && segment !== '.').join('/')
  if (stored.length === 0 || stored.length > MAX_PATH_CHARS) return undefined
  if (isBuiltinDenied(stored)) return undefined
  return stored
}

/**
 * Path-hint candidates from one tool call. Accepts the raw model JSON string or an already-parsed
 * object; returns ≤`maxFiles` distinct paths in observation order; never retains argument text.
 * @param {unknown} name
 * @param {unknown} rawArguments
 * @param {string | undefined} wsRoot
 * @param {number} maxFiles
 * @returns {string[]}
 */
function hintsFromArguments(name, rawArguments, wsRoot, maxFiles) {
  if (typeof name !== 'string' || !PATH_HINT_TOOLS.has(name)) return []
  let args = rawArguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return []
    }
  }
  if (!isPlainObject(args)) return []
  const out = []
  const add = (relative) => {
    if (relative === undefined || out.length >= maxFiles) return
    if (!out.includes(relative)) out.push(relative)
  }
  for (const key of PATH_KEYS) {
    const value = args[key]
    for (const candidate of Array.isArray(value) ? value : [value]) {
      add(workspaceRelative(wsRoot, candidate))
      if (out.length >= maxFiles) break
    }
  }
  // Codex-style patches carry file paths inside the patch body; only header lines are read and
  // the patch text is never stored.
  if (name === 'apply_patch' && typeof args.patch === 'string' && out.length < maxFiles) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
    let match = header.exec(args.patch)
    while (match !== null && out.length < maxFiles) {
      add(workspaceRelative(wsRoot, match[1].trim()))
      match = header.exec(args.patch)
    }
  }
  return out
}

/**
 * Path-hint candidates from one `tool/ptc-dispatch` event.
 * HYPOTHESIS (ledger-recall open question 2 / M0): the event may be flat (`{name, arguments}`) or
 * wrapped (`{data:{…}}`), and `arguments` may be normalized/truncated JSON text. Unknown shapes
 * yield `[]`; `content` / `isError` are never read.
 * @param {unknown} event
 * @param {unknown} wsRoot
 * @param {number} [maxFiles]
 * @returns {string[]}
 */
function hintsFromPtcDispatch(event, wsRoot, maxFiles = DEFAULT_MAX_FILES) {
  if (!isPlainObject(event)) return []
  const data = isPlainObject(event.data) ? event.data : event
  const name =
    optionalString(data.name) ??
    optionalString(data.toolName) ??
    optionalString(data.tool) ??
    optionalString(data.rootName)
  let args = data.arguments
  if (args === undefined) args = data.args
  if (args === undefined && isPlainObject(data.call)) args = data.call.arguments
  if (args === undefined && isPlainObject(data.normalized)) args = data.normalized.arguments
  return hintsFromArguments(name, args, typeof wsRoot === 'string' ? wsRoot : undefined, maxFiles)
}

/** @param {unknown} value @returns {number} milliseconds, or NaN */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

/** @param {number} ms @returns {string} */
function isoFromMs(ms) {
  if (!Number.isFinite(ms)) return new Date(0).toISOString()
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * `ws_` + first 16 hex chars of sha256(utf8(canonicalPath)) (data-model §2.1). Local so this
 * module is unit-testable without the workspace module. In v0.2.0 this is a PROVENANCE-only
 * helper for `origin.workspaceKey`; it is never used to scope, filter or gate memory.
 * @param {string} canonicalPath
 * @returns {string}
 */
export function workspaceKeyFor(canonicalPath) {
  return 'ws_' + createHash('sha256').update(String(canonicalPath), 'utf8').digest('hex').slice(0, 16)
}

/**
 * Fold merged journal records into the last-wins universal ledger view: greatest `seq` per
 * session id across the global journal and merged legacy journals (provenance-only `ws` values),
 * most recently active first, capped at `maxSessions`. No workspace filter exists by design.
 * @param {readonly object[]} records
 * @param {number} [maxSessions]
 * @returns {Map<string, object>}
 */
export function foldSessionRows(records, maxSessions = DEFAULT_MAX_SESSIONS) {
  const cap = Number.isFinite(maxSessions) ? Math.max(0, Math.floor(maxSessions)) : DEFAULT_MAX_SESSIONS
  const byId = new Map()
  for (const record of records) {
    if (!isPlainObject(record) || record.type !== 'session') continue
    const id = optionalString(record.id) ?? optionalString(record.sessionId)
    if (id === undefined) continue
    const previous = byId.get(id)
    if (previous === undefined || String(record.seq ?? '') > String(previous.seq ?? '')) byId.set(id, record)
  }
  const rows = [...byId.values()]
    .sort((a, b) => {
      const at = toMillis(a.lastActivityTs ?? a.ts)
      const bt = toMillis(b.lastActivityTs ?? b.ts)
      const delta = (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0)
      if (delta !== 0) return delta
      return String(b.seq ?? '').localeCompare(String(a.seq ?? ''))
    })
    .slice(0, cap)
  const view = new Map()
  for (const row of rows) {
    const clone = {}
    for (const key of SESSION_ROW_FIELDS) {
      if (row[key] === undefined) continue
      if (key === 'origin') {
        const origin = originOf(row[key])
        if (origin !== null) clone.origin = origin
        continue
      }
      clone[key] = Array.isArray(row[key]) ? row[key].slice() : row[key]
    }
    view.set(row.id ?? row.sessionId, clone)
  }
  return view
}

export class SessionLedger {
  /**
   * @param {object} options
   * @param {object} options.store JournalStore with `openGlobal()` + `mergedRecords()` (delta §2/§5)
   * @param {object} [options.config] resolved config
   * @param {object} [options.logger] structured logger
   * @param {object} [options.deps] { now, originResolver, workspaceResolver (legacy fallback),
   *   redactor, canonicalizeDir, sessionTitle, getService, setTimeout, clearTimeout }
   */
  constructor({ store, config, logger, deps } = {}) {
    if (!store || typeof store.openGlobal !== 'function') {
      throw new TypeError('SessionLedger requires a store with openGlobal()')
    }
    this.store = store
    this.config = config ?? {}
    this.logger = logger
    this.deps = deps ?? {}
    this.now = typeof this.deps.now === 'function' ? this.deps.now : () => Date.now()
    this.setTimeoutFn = typeof this.deps.setTimeout === 'function' ? this.deps.setTimeout : setTimeout
    this.clearTimeoutFn = typeof this.deps.clearTimeout === 'function' ? this.deps.clearTimeout : clearTimeout
    this.maxFiles = Math.min(
      clampInt(this.config?.ledger?.maxFilesPerSession, DEFAULT_MAX_FILES, 0, 16),
      MAX_FILES_CEILING,
    )
    // Global cap: `ledger.maxSessions`; the v0.1.0 key is tolerated as a fallback during upgrade.
    const configuredSessions =
      this.config?.ledger?.maxSessions ?? this.config?.ledger?.maxSessionsPerWorkspace
    this.maxSessions = clampInt(configuredSessions, DEFAULT_MAX_SESSIONS, MIN_SESSIONS, MAX_SESSIONS_CEILING)
    this.slots = new Map() // sessionId -> slot
    this.global = null // the one global journal (all memory lives here)
    this.globalPromise = null
    this.disposers = []
    this.disposed = false
    this.redactor =
      this.deps.redactor && typeof this.deps.redactor.title === 'function'
        ? this.deps.redactor
        : createRedactor(this.config, { logger: this.logger })
  }

  /**
   * Subscribe to the Host session event stream. Call inside the plugin effect; the returned
   * function removes the listeners (also `dispose()`).
   * @param {object} ctx Cordis plugin context
   * @returns {() => void}
   */
  attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') throw new TypeError('SessionLedger.attach requires ctx.on')
    const offSession = ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    if (typeof offSession === 'function') this.disposers.push(offSession)
    try {
      const offDisposed = ctx.on('session/disposed', (payload) => this.onSessionDisposed(payload))
      if (typeof offDisposed === 'function') this.disposers.push(offDisposed)
    } catch {
      // Optional host event in restricted contexts.
    }
    return () => this.dispose()
  }

  /** @param {unknown} session @param {unknown} event */
  onSessionEvent(session, event) {
    if (this.disposed) return
    try {
      if (!isPlainObject(session) || !isPlainObject(event)) return
      const sessionId = optionalString(session.id) ?? optionalString(session.header?.id)
      if (sessionId === undefined) return
      let slot = this.slots.get(sessionId)
      if (slot === undefined) {
        slot = {
          sessionId,
          ready: false,
          dead: false,
          queue: [],
          acc: null,
          journal: null,
          origin: null, // provenance only: { workspaceKey?, workspaceLabel? }
          rootDir: undefined, // session origin dir for lexical file-hint containment
          timer: null,
          inFlight: null,
        }
        this.slots.set(sessionId, slot)
        void this.bootstrap(slot, session)
      }
      if (slot.ready) this.applyEvent(slot, event)
      else slot.queue.push(event)
    } catch (error) {
      this.warn({ event: 'ledger.event_error', error: String(error) })
    }
  }

  /**
   * Open the one GLOBAL journal, resolve provenance (best-effort) and seed the accumulator.
   * Only a private session is suppressed; a missing directory/origin never blocks a row.
   * @param {object} slot @param {unknown} session
   */
  async bootstrap(slot, session) {
    try {
      if (this.isSuppressed(slot.sessionId)) {
        slot.dead = true
        return
      }
      const journal = await this.openGlobalJournal()
      if (journal === null) {
        slot.dead = true
        return
      }
      const header = isPlainObject(session.header) ? session.header : {}
      const provenance = await this.resolveProvenance(session)
      let title
      let redactions = 0
      const seededTitle = this.liveTitleFor(session)
      if (seededTitle !== undefined) {
        const redacted = this.redactor.title(seededTitle)
        title = redacted.value
        redactions += redacted.hits
      }
      slot.journal = journal
      slot.origin = provenance.origin
      slot.rootDir = provenance.rootDir
      slot.acc = {
        title,
        redactions,
        status: 'live',
        turns: 0,
        lastActivityMs: this.now(),
        effectiveDir: undefined,
        files: [],
        parentSession: optionalString(header.parentSession) ?? optionalString(header.parent_session),
        dirty: false,
      }
      this.enforceSessionCap()
    } catch (error) {
      slot.dead = true
      this.warn({ event: 'ledger.bootstrap_error', error: String(error) })
    } finally {
      slot.ready = true
      const queue = slot.queue
      slot.queue = []
      if (slot.dead) {
        this.slots.delete(slot.sessionId)
      } else {
        for (const event of queue) {
          try {
            this.applyEvent(slot, event)
          } catch (error) {
            this.warn({ event: 'ledger.event_error', error: String(error) })
          }
        }
      }
    }
  }

  /** Pure bookkeeping for one committed session event (no I/O; writes are coalesced). */
  applyEvent(slot, event) {
    const type = optionalString(event.type)
    if (type === undefined || slot.dead || slot.acc === null) return
    const data = isPlainObject(event.data) ? event.data : {}
    const acc = slot.acc
    switch (type) {
      case 'turn/start': {
        acc.status = 'live'
        acc.lastActivityMs = this.now()
        break
      }
      case 'turn/end': {
        const turn = Number.isInteger(data.turn) ? data.turn : Number.parseInt(data.turn, 10)
        if (Number.isInteger(turn) && turn >= 0) acc.turns = Math.max(acc.turns, Math.min(turn, MAX_TURNS))
        acc.status = 'idle'
        acc.lastActivityMs = this.eventMillis(event)
        this.markDirty(slot, true)
        break
      }
      case 'tool/call': {
        this.addHints(slot, hintsFromArguments(data.name, data.arguments, slot.rootDir, this.maxFiles))
        acc.lastActivityMs = this.eventMillis(event)
        this.markDirty(slot, false)
        break
      }
      case 'tool/ptc-dispatch': {
        this.addHints(slot, hintsFromPtcDispatch(event, slot.rootDir, this.maxFiles))
        acc.lastActivityMs = this.eventMillis(event)
        this.markDirty(slot, false)
        break
      }
      case 'tool/result': {
        // Never read `message.content`, `error` text or any tool output; names/status only.
        acc.lastActivityMs = this.eventMillis(event)
        this.markDirty(slot, false)
        break
      }
      case 'session/title': {
        const normalized = normalizeTitle(data.title)
        if (normalized.length > 0) {
          const redacted = this.redactor.title(normalized)
          acc.title = truncateCodePoints(redacted.value, TITLE_MAX_CHARS)
          acc.redactions += redacted.hits
        }
        acc.lastActivityMs = this.eventMillis(event)
        this.markDirty(slot, false)
        break
      }
      case 'working-directory/change': {
        // HYPOTHESIS: the data field is `directory`, `cwd` or `path` (ledger-recall §2 open q.1).
        // Only an absolute path is recorded, and only when it differs from the session's origin dir.
        const candidate =
          optionalString(data.directory) ?? optionalString(data.cwd) ?? optionalString(data.path)
        if (candidate !== undefined && path.isAbsolute(candidate)) {
          let resolved
          try {
            resolved = path.resolve(candidate)
          } catch {
            resolved = undefined
          }
          if (
            resolved !== undefined &&
            resolved.length <= EFFECTIVE_DIR_MAX_CHARS &&
            !this.samePath(resolved, slot.rootDir)
          ) {
            acc.effectiveDir = resolved
          }
        }
        acc.lastActivityMs = this.eventMillis(event)
        this.markDirty(slot, false)
        break
      }
      case 'session/flush': {
        this.markDirty(slot, true)
        break
      }
      default:
        // All text-bearing and unrelated events are ignored; no text is parsed, even transiently.
        break
    }
  }

  /** Mark dirty and schedule (or force) a flush. */
  markDirty(slot, force) {
    if (slot.acc === null || this.disposed) return
    slot.acc.dirty = true
    if (force) {
      if (slot.timer !== null) {
        this.clearTimeoutFn(slot.timer)
        slot.timer = null
      }
      void this.flushSlot(slot)
      return
    }
    if (slot.timer !== null || slot.inFlight !== null) return
    slot.timer = this.setTimeoutFn(() => {
      slot.timer = null
      void this.flushSlot(slot)
    }, FLUSH_MIN_INTERVAL_MS)
    if (slot.timer !== null && typeof slot.timer === 'object' && typeof slot.timer.unref === 'function') {
      slot.timer.unref()
    }
  }

  /** Append one `session` upsert record from the accumulator. Never throws. */
  async flushSlot(slot) {
    if (slot.dead || slot.acc === null) return
    if (slot.inFlight !== null) await slot.inFlight.catch(() => {})
    if (slot.dead || slot.acc === null || !slot.acc.dirty || slot.inFlight !== null) return
    const acc = slot.acc
    const record = {
      type: 'session',
      id: slot.sessionId,
      ws: GLOBAL_SCOPE_KEY,
      status: acc.status === 'live' ? 'live' : 'idle',
      turns: acc.turns,
      lastActivityTs: isoFromMs(acc.lastActivityMs),
    }
    if (acc.title !== undefined && acc.title.length > 0) record.title = acc.title
    if (Number.isInteger(acc.redactions) && acc.redactions > 0) record.redactions = acc.redactions
    if (acc.effectiveDir !== undefined) record.effectiveDir = acc.effectiveDir
    if (acc.files.length > 0) record.files = acc.files.slice(0, this.maxFiles)
    if (acc.parentSession !== undefined) record.parentSession = acc.parentSession
    if (slot.origin !== null) record.origin = { ...slot.origin }
    acc.dirty = false
    const write = (async () => {
      try {
        await slot.journal.append(record)
      } catch (error) {
        acc.dirty = true
        this.warn({ event: 'ledger.flush_failed', sessionId: slot.sessionId, error: String(error) })
      }
    })()
    slot.inFlight = write
    try {
      await write
    } finally {
      slot.inFlight = null
    }
    if (acc.dirty && !this.disposed && slot.timer === null) this.markDirty(slot, false)
  }

  /**
   * Flush every dirty accumulator to the global journal and await queued writes. The v0.1.0
   * `flush(wsKey)` argument is accepted and ignored: there is only one memory space.
   * @param {unknown} [ignored]
   */
  async flush(ignored) {
    void ignored
    for (const slot of [...this.slots.values()]) {
      if (slot.dead || slot.acc === null) continue
      if (slot.inFlight !== null) await slot.inFlight.catch(() => {})
      if (slot.acc.dirty) await this.flushSlot(slot)
    }
  }

  /**
   * Universal ledger view: every session in the profile (global + merged legacy journals),
   * last-wins by seq, most recently active first, capped at `ledger.maxSessions`. Synchronous
   * from the in-process merged cache (implementation-interfaces §7; the pulse/facade call it
   * synchronously). A v0.1.0 workspace argument is accepted and ignored.
   * @param {unknown} [ignored]
   * @returns {Map<string, object>}
   */
  ledger(ignored) {
    void ignored
    const view = foldSessionRows(this.readableRecords(), this.maxSessions)
    // Legacy v1 session rows carry no `origin`; their manifest label is the provenance label
    // (ADR-0007 §2.2: legacy journals are merged read-only into every view with labels).
    const labels = this.legacyLabels()
    if (labels.size > 0) {
      for (const row of view.values()) {
        if (row.origin !== undefined || typeof row.ws !== 'string' || row.ws === GLOBAL_SCOPE_KEY) continue
        const label = labels.get(row.ws)
        if (label === undefined) continue
        row.origin = { workspaceKey: row.ws, workspaceLabel: label }
      }
    }
    return view
  }

  /**
   * Provenance labels for merged legacy workspaces (never a path): from the store's legacy view
   * when available, else its manifest scan. Read-only; unknown labels are simply absent.
   * @returns {Map<string, string>}
   */
  legacyLabels() {
    const labels = new Map()
    const remember = (wsKey, value) => {
      if (typeof wsKey !== 'string' || !WORKSPACE_KEY_PATTERN.test(wsKey)) return
      const label = labelOnly(value)
      if (label !== undefined) labels.set(wsKey, label)
    }
    try {
      if (typeof this.store.legacyView === 'function') {
        const view = this.store.legacyView()
        if (view && view.labels instanceof Map) {
          for (const [wsKey, value] of view.labels) remember(wsKey, value)
          return labels
        }
      }
      if (typeof this.store.legacyWorkspaceMeta === 'function') {
        for (const meta of this.store.legacyWorkspaceMeta() ?? []) {
          if (!isPlainObject(meta)) continue
          remember(meta.wsKey, meta.label ?? path.basename(String(meta.canonicalPath ?? '')))
        }
      }
    } catch (error) {
      this.warn({ event: 'ledger.legacy_labels_failed', error: String(error) })
    }
    return labels
  }

  /** Async variant that opens the global journal first (tests / facade warm-up). */
  async readLedger() {
    const journal = await this.openGlobalJournal()
    if (journal === null) return new Map()
    return this.ledger()
  }

  /** Refresh the global journal + merged legacy view (poll/watch driver hook). */
  async refresh() {
    const journal = await this.openGlobalJournal()
    if (journal !== null && typeof journal.refresh === 'function') {
      try {
        await journal.refresh({ force: false })
      } catch (error) {
        this.warn({ event: 'ledger.refresh_failed', error: String(error) })
      }
    }
    if (typeof this.store.refreshMerged === 'function') {
      try {
        await this.store.refreshMerged()
      } catch (error) {
        this.warn({ event: 'ledger.refresh_merged_failed', error: String(error) })
      }
    }
  }

  /**
   * Synchronous record source for the universal view: the store's merged (global + legacy)
   * records when the store exposes them, else this journal's cache (unit-test seams).
   * @returns {readonly object[]}
   */
  readableRecords() {
    if (typeof this.store.mergedRecords === 'function') {
      try {
        const merged = this.store.mergedRecords()
        if (Array.isArray(merged)) return merged
      } catch (error) {
        this.warn({ event: 'ledger.merged_read_failed', error: String(error) })
      }
    }
    const journal = this.global
    if (journal !== null && typeof journal.records === 'function') {
      try {
        const records = journal.records()
        if (Array.isArray(records)) return records
      } catch {
        // fall through to empty
      }
    }
    return []
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
        this.warn({ event: 'ledger.open_global_failed', error: String(error) })
        return null
      })
      .finally(() => {
        this.globalPromise = null
      })
    this.globalPromise = promise
    return promise
  }

  /**
   * Best-effort provenance for one session: `origin = {workspaceKey?, workspaceLabel?}` plus the
   * origin directory used only for lexical file-hint containment. Never throws, never blocks a
   * row: an unresolved origin is valid (universal memory has no workspace requirement).
   * @param {unknown} session
   * @returns {Promise<{origin: {workspaceKey?: string, workspaceLabel?: string} | null, rootDir: string | undefined}>}
   */
  async resolveProvenance(session) {
    const header = isPlainObject(session?.header) ? session.header : {}
    const headerCwd = optionalString(header.cwd)
    let origin = null
    let rootDir
    const resolver = this.deps.originResolver ?? this.deps.workspaceResolver
    if (resolver && typeof resolver.resolve === 'function') {
      try {
        const resolved = await resolver.resolve(session)
        if (isPlainObject(resolved)) {
          origin = originOf(resolved)
          const canonicalPath = optionalString(resolved.canonicalPath) ?? optionalString(resolved.path)
          if (canonicalPath !== undefined) rootDir = canonicalPath
        }
      } catch (error) {
        this.warn({ event: 'ledger.origin_failed', error: String(error) })
      }
    }
    if (rootDir === undefined && headerCwd !== undefined) {
      const canonical = await this.canonicalize(headerCwd)
      if (canonical !== null) {
        rootDir = canonical
        if (origin === null) {
          origin = originOf({
            workspaceKey: workspaceKeyFor(canonical),
            workspaceLabel: path.basename(canonical),
          })
        }
      }
    }
    // Lexical fallback for hint containment only; never persisted, never a partition.
    if (rootDir === undefined && headerCwd !== undefined && path.isAbsolute(headerCwd)) {
      try {
        rootDir = path.resolve(headerCwd)
      } catch {
        rootDir = undefined
      }
    }
    return { origin, rootDir }
  }

  /** @param {unknown} raw @returns {Promise<string | null>} */
  async canonicalize(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null
    const injected = this.deps.canonicalizeDir
    if (typeof injected === 'function') {
      try {
        const value = await injected(raw)
        return typeof value === 'string' && value.length > 0 ? foldPath(value) : null
      } catch {
        return null
      }
    }
    try {
      const { realpath } = await import('node:fs/promises')
      return foldPath(await realpath(raw))
    } catch {
      return null
    }
  }

  /** @param {unknown} left @param {unknown} right @returns {boolean} */
  samePath(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false
    try {
      return foldPath(path.resolve(left)) === foldPath(path.resolve(right))
    } catch {
      return false
    }
  }

  /** @param {unknown} session @returns {string | undefined} */
  liveTitleFor(session) {
    const services = isPlainObject(this.deps.services) ? this.deps.services : null
    const service = services?.sessionTitle ?? this.callGetService('sessionTitle')
    if (!service || typeof service.get !== 'function') return undefined
    try {
      const value = service.get(session)
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /** @param {string} name */
  callGetService(name) {
    if (typeof this.deps.getService !== 'function') return undefined
    try {
      return this.deps.getService(name)
    } catch {
      return undefined
    }
  }

  /**
   * Private-session opt-out only: `privacy.privateSessions` removes a session from memory
   * (ledger/presence/tools). `privacy.disabledWorkspaces` no longer exists in v0.2.0 — the
   * profile/machine is the privacy boundary (ADR-0007 §2.8).
   * @param {string} sessionId
   */
  isSuppressed(sessionId) {
    const privacy = isPlainObject(this.config.privacy) ? this.config.privacy : {}
    return Array.isArray(privacy.privateSessions) && privacy.privateSessions.includes(sessionId)
  }

  /** Add extracted hints (session-origin-relative) to the accumulator. */
  addHints(slot, hints) {
    if (slot.acc === null || !Array.isArray(hints)) return
    let accepted = hints
    if (this.redactor && typeof this.redactor.files === 'function') {
      try {
        accepted = this.redactor.files(hints)
      } catch {
        accepted = hints
      }
    }
    for (const relative of accepted) {
      if (typeof relative !== 'string' || relative.length === 0) continue
      if (slot.acc.files.length >= this.maxFiles) return
      if (!slot.acc.files.includes(relative)) slot.acc.files.push(relative)
    }
  }

  /** Evict the least-recently-active accumulators when the global index exceeds the cap. */
  enforceSessionCap() {
    const slots = [...this.slots.values()].filter((slot) => !slot.dead)
    if (slots.length <= this.maxSessions) return
    slots.sort((a, b) => (a.acc?.lastActivityMs ?? 0) - (b.acc?.lastActivityMs ?? 0))
    for (const slot of slots) {
      if (slots.length <= this.maxSessions) break
      if (slot.timer !== null || slot.inFlight !== null || slot.acc?.dirty) continue
      this.slots.delete(slot.sessionId)
      slots.splice(slots.indexOf(slot), 1)
    }
  }

  /** @param {unknown} payload */
  onSessionDisposed(payload) {
    try {
      const session = isPlainObject(payload?.session) ? payload.session : payload
      const sessionId = optionalString(session?.id) ?? optionalString(session?.header?.id)
      if (sessionId === undefined) return
      const slot = this.slots.get(sessionId)
      if (slot === undefined) return
      if (slot.timer !== null) {
        this.clearTimeoutFn(slot.timer)
        slot.timer = null
      }
      void this.flushSlot(slot).finally(() => this.slots.delete(sessionId))
    } catch (error) {
      this.warn({ event: 'ledger.dispose_event_error', error: String(error) })
    }
  }

  /** @param {object} event @returns {number} */
  eventMillis(event) {
    const ms = toMillis(event?.time)
    return Number.isFinite(ms) ? ms : this.now()
  }

  /** Flush everything, clear timers and dispose listeners. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const slot of this.slots.values()) {
      if (slot.timer !== null) this.clearTimeoutFn(slot.timer)
      slot.timer = null
    }
    try {
      await this.flush()
    } catch {
      // Dispose is best-effort.
    }
    for (const off of this.disposers.splice(0)) {
      try {
        off()
      } catch {
        // ignore
      }
    }
  }

  // -------------------------------------------------------------------------
  // static extractors (unit-testable without a store)
  // -------------------------------------------------------------------------

  /**
   * Map one tool call's arguments to session-origin-relative file-hint candidates. Write/edit-style
   * tools only; ≤8 distinct paths in observation order; paths outside the origin dir, `..`
   * escapes and deny-listed files are dropped. Argument text is never retained.
   * @param {unknown} name
   * @param {unknown} argsJson raw model JSON string or parsed object
   * @param {string} [wsRoot] absolute origin directory (needed for containment; provenance only)
   * @param {number} [maxFiles]
   * @returns {string[]}
   */
  static extractFilesFromToolCall(name, argsJson, wsRoot, maxFiles = DEFAULT_MAX_FILES) {
    return hintsFromArguments(name, argsJson, wsRoot, Math.min(clampInt(maxFiles, DEFAULT_MAX_FILES, 0, 16), MAX_FILES_CEILING))
  }

  /**
   * Map one `tool/ptc-dispatch` event to file-hint candidates (same rules as tool/call).
   * `HYPOTHESIS:` dispatch `arguments` may be normalized/truncated JSON text; unknown shapes
   * yield `[]`; `content` is never read.
   * @param {unknown} event
   * @param {string} [wsRoot]
   * @param {number} [maxFiles]
   * @returns {string[]}
   */
  static extractFilesFromPtcDispatch(event, wsRoot, maxFiles = DEFAULT_MAX_FILES) {
    return hintsFromPtcDispatch(event, wsRoot, Math.min(clampInt(maxFiles, DEFAULT_MAX_FILES, 0, 16), MAX_FILES_CEILING))
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
