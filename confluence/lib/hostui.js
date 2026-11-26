// Confluence / 高级记忆 — Web panel Host half (v0.4.0, read-only).
//
// Three read-only views over the same-origin data routes (v0.4-interfaces.md §6):
//   M1 — 工作区会话总线: workspace list → workspace bus detail (state/notes/messages/peers)
//        and one note thread.
//   M2 — 长期记忆: folded long-term `pattern` records — active patterns plus the
//        candidate queue (candidates are confirmed conversationally, never here).
//   M3 — 用户画像: persona sections + facts and the two-channel style cards, plus a
//        deterministic JSON/Markdown file download of the full `confluence.memory/v1`
//        document (never a JSON envelope).
//
// Plain ESM, Node builtins only, no `@deepseek-ai/*` imports, no network listeners.
// The panel reads through the facade the plugin entry injects (panelWorkspaces /
// panelBus / panelEntry / panelProfile / panelMemory / panelProfileExport); this
// module never touches the store, the session log or the config.
//
// Privacy/security posture (unchanged from v0.1.0/v0.2.0):
//   - GET/HEAD only, no mutating route, no POST/PUT/DELETE handling;
//   - `cache-control: no-store`, `x-content-type-options: nosniff`;
//   - response body hard-capped at 64 KiB (truncation explicit, never a silent cut);
//   - list views never carry note bodies or message bodies (only the single-entry
//     route carries a note body, where the user explicitly opened that note);
//     the memory route carries one `body`/`rule` field per structural row and never
//     a nested note-body list;
//   - workspace ids are opaque `ws_<16hex>` hashes; a label is reduced to its final
//     path segment, so no absolute path can ever reach the panel payload;
//   - peer/message authors appear as display titles only, never as session ids;
//   - pattern/style authors and evidence are not emitted at all (no session ids);
//   - file hints are workspace-relative only (drive letters, UNC roots and `..`
//     segments are removed) and errors carry no filesystem paths;
//   - the optional `connection.requestRejection(req)` fence is applied first when
//     the service exists (Crisp `lib/status.js:290-305` precedent);
//   - a present foreign `Origin` or a cross-site `Sec-Fetch-Site` is rejected.

/** Route prefix owned by this module (exact routes, one per page area). */
export const HOSTUI_PREFIX = '/confluence/panel'

/** Panel protocol/plugin version reported by the ping route. */
export const PLUGIN_VERSION = '0.4.0'

/** Plugin package name reported by the ping route. */
export const PLUGIN_NAME = 'dsh-confluence'

/**
 * Fallback label for the global profile scope (`PROFILE_SCOPE` in lib/facade.js).
 * The profile payload's `profile.label` is only a display label; this constant is
 * what the panel shows when the facade supplies none.
 */
export const PANEL_SCOPE = Object.freeze({ key: 'global', label: 'All sessions' })

/** Hard response ceiling for every JSON panel route and the profile download. */
export const MAX_RESPONSE_BYTES = 64 * 1024

const MAX_WORKSPACES = 50
const MAX_CONTEXT_KEYS = 50
const MAX_ENTRIES = 50
const MAX_MESSAGES = 30
const MAX_REPLIES = 50
const MAX_PEERS = 8
const MAX_FILES = 8
const MAX_TAGS = 8
const MAX_PROFILE_FACTS = 200
const MAX_PATTERNS = 100
const MAX_PATTERN_CANDIDATES = 50
const MAX_STYLES = 100
const DEFAULT_BUS_LIMIT = 20
const MAX_QUERY_CHARS = 200
const MAX_TITLE_CHARS = 200
const MAX_PATTERN_TITLE_CHARS = 120
const MAX_PATTERN_BODY_CHARS = 2048
const MAX_STYLE_RULE_CHARS = 1024
const MAX_STYLE_EXAMPLE_CHARS = 240
const MAX_STYLE_EXAMPLES = 2
const MAX_LABEL_CHARS = 120
const MAX_TS_CHARS = 40
const MAX_SEQ_CHARS = 64
const MAX_CONTEXT_VALUE_CHARS = 4096
const MAX_REPLY_BODY_CHARS = 4096
const MAX_REVISION_CHARS = 64

const WS_ID_RE = /^ws_[0-9a-f]{16}$/i
const ENTRY_ID_RE = /^cnf_[0-9A-Za-z_-]{6,64}$/
const MESSAGE_ID_RE = /^msg_[0-9A-Za-z_-]{6,64}$/
const FACT_ID_RE = /^prf_[0-9A-Za-z_-]{6,64}$/
const CONTEXT_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KIND_VALUES = new Set(['finding', 'decision', 'gotcha', 'question', 'handoff', 'warning'])
const ENTRY_STATUS_VALUES = new Set(['active', 'open', 'resolved', 'superseded'])
const MESSAGE_KIND_VALUES = new Set(['notice', 'instruction', 'query', 'reply'])
const PEER_STATUS_VALUES = new Set(['running', 'idle', 'cold', 'unknown'])
const PROFILE_SOURCE_VALUES = new Set(['agent', 'user', 'import'])
const PATTERN_CATEGORY_VALUES = new Set(['workflow', 'project', 'domain', 'pitfall', 'heuristic', 'quality'])
const PATTERN_STATUS_VALUES = new Set(['candidate', 'active', 'rejected', 'superseded'])
const PATTERN_SCOPE_VALUES = new Set(['global', 'workspace'])
const PATTERN_SOURCE_VALUES = new Set(['agent', 'user', 'import', 'migration'])
const STYLE_CHANNEL_VALUES = Object.freeze(['chat', 'engineering'])
const STYLE_AREA_VALUES = new Set(['general', 'tone', 'structure', 'commit', 'comment', 'docs', 'naming', 'error', 'log', 'ui'])
/**
 * Persona sections in the fixed v0.4 render order (§1.3). `tech`/`context` are no
 * longer persona (their facts migrate to `pattern` records) and are skipped here.
 */
const PROFILE_SECTION_ORDER = Object.freeze(['identity', 'personality', 'communication', 'habits', 'boundaries', 'taste'])
/** Legacy persona section aliases, folded at read time (§1.3). */
const PROFILE_SECTION_ALIASES = Object.freeze({ preferences: 'communication', rules: 'boundaries' })
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const NEWLINE_RE = /\r\n?/g

const ROUTES = [
  { name: 'ping', path: `${HOSTUI_PREFIX}/ping`, run: pingPayload },
  { name: 'workspaces', path: `${HOSTUI_PREFIX}/workspaces`, run: workspacesPayload },
  { name: 'bus', path: `${HOSTUI_PREFIX}/bus`, run: busPayload },
  { name: 'entry', path: `${HOSTUI_PREFIX}/entry`, run: entryPayload },
  { name: 'profile', path: `${HOSTUI_PREFIX}/profile`, run: profilePayload },
  { name: 'memory', path: `${HOSTUI_PREFIX}/memory`, run: memoryPayload },
  { name: 'profile-export', path: `${HOSTUI_PREFIX}/profile/export`, run: profileExportPayload, download: true },
]

// ---------------------------------------------------------------------------
// small defensive helpers
// ---------------------------------------------------------------------------

/** Bound logger that can never throw and never receives user content. */
function safeLogger(logger) {
  const noop = () => {}
  const bind = (name) => {
    const fn = logger !== null && typeof logger === 'object' ? logger[name] : undefined
    if (typeof fn !== 'function') return noop
    return (...args) => {
      try {
        fn(...args)
      } catch {
        // Diagnostics are best-effort; the panel must keep working.
      }
    }
  }
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') }
}

/** Run `fn` once, tolerating a throwing cleanup run. */
function once(fn) {
  let ran = false
  return (...args) => {
    if (ran) return undefined
    ran = true
    return fn(...args)
  }
}

/** Read the optional web-server service defensively (Crisp `getWebServer` shape). */
function getService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined) return value
    }
  } catch {
    // Optional service lookup must never break activation.
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/** JSON byte length of one payload (UTF-8). */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Object guard that rejects arrays and null. */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Array guard. */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** Single-line text sanitizer: control chars to spaces, newlines collapsed, capped. */
function cleanLine(value, maxChars) {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(NEWLINE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}

/** Multi-line text sanitizer for note bodies: keeps \n and \t, strips the rest. */
function cleanBody(value, maxChars) {
  if (typeof value !== 'string') return ''
  const cleaned = value.replace(CONTROL_CHARS_RE, ' ').replace(NEWLINE_RE, '\n').trim()
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}

/** Coerce to int inside [min, max]; non-finite → fallback. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  const truncated = Math.trunc(number)
  if (truncated < min) return min
  if (truncated > max) return max
  return truncated
}

/** Coerce to a finite float inside [min, max]; non-finite → fallback. */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  if (number < min) return min
  if (number > max) return max
  return number
}

/** ISO-8601 timestamp kept only when parseable; otherwise dropped (empty string). */
function cleanTimestamp(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TS_CHARS) return ''
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? trimmed : ''
}

/**
 * Workspace-relative file hint. Absolute forms lose their root, any `..` segment
 * drops the entry, and separators normalize to `/` for display. Returns '' when the
 * path is unusable (the caller drops it).
 */
function cleanRelativePath(value) {
  if (typeof value !== 'string') return ''
  let text = value.replace(CONTROL_CHARS_RE, '').trim()
  if (text.length === 0) return ''
  if (text.startsWith('\\\\') || text.startsWith('//')) return '' // UNC: not displayable as relative
  text = text.replace(/^[A-Za-z]:[\\/]+/, '')
  text = text.replace(/^[\\/]+/, '')
  const parts = text.split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) return ''
  const relative = parts.join('/')
  return relative.length > MAX_TITLE_CHARS ? '' : relative
}

/**
 * Display label: basename only. A facade that accidentally forwards a path is
 * reduced to its final segment; no absolute path can reach the panel.
 */
function cleanProvenanceLabel(value) {
  const line = cleanLine(typeof value === 'string' ? value : '', MAX_LABEL_CHARS)
  if (line === '') return ''
  const parts = line.split(/[\\/]+/).filter((part) => part !== '' && part !== '.' && part !== '..')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * Display title of an author/sender. Accepts a plain string or the record's
 * `{title, sessionTitle, ...}` author object; session ids are never emitted.
 */
function cleanAuthorTitle(value) {
  if (typeof value === 'string') return cleanLine(value, MAX_LABEL_CHARS)
  const record = asObject(value)
  if (record === null) return ''
  return cleanLine(
    record.title ?? record.sessionTitle ?? record.authorTitle ?? record.name ?? '',
    MAX_LABEL_CHARS,
  )
}

/** Error message for JSON: single line, capped, no stack. */
function cleanMessage(error) {
  const raw = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : ''
  const cleaned = raw.replace(CONTROL_CHARS_RE, ' ').replace(NEWLINE_RE, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 300 ? cleaned.slice(0, 300) : cleaned
}

/** Extract a stable error code from a facade rejection. */
function errorCode(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code
  return ''
}

/**
 * Map a facade rejection to an HTTP status + error envelope. Facade errors use the
 * design's bare codes (v0.3-interfaces.md §8); anything unknown is a 500 with no
 * internal detail beyond a single-line message.
 */
function mapError(error) {
  const code = errorCode(error)
  const message = cleanMessage(error)
  const payload = (panelCode, fallbackMessage) => ({
    ok: false,
    error: { code: panelCode, message: message.length > 0 ? message : fallbackMessage },
  })
  switch (code) {
    case 'BAD_ARGUMENT':
    case 'CONFLUENCE_INVALID_ARGUMENT':
    case 'NO_WORKSPACE':
      return { status: 400, payload: payload('CONFLUENCE_INVALID_ARGUMENT', 'invalid panel argument') }
    case 'NOT_FOUND':
    case 'UNKNOWN_REF':
    case 'CONFLUENCE_NOT_FOUND':
      return { status: 404, payload: payload('CONFLUENCE_NOT_FOUND', 'not found') }
    case 'STORE_UNAVAILABLE':
      return { status: 503, payload: payload('CONFLUENCE_STORE_UNAVAILABLE', 'shared memory storage unavailable') }
    default:
      return { status: 500, payload: payload('CONFLUENCE_INTERNAL', 'panel request failed') }
  }
}

/** Header value as a trimmed lowercase string. */
function headerValue(req, name) {
  const headers = req !== null && typeof req === 'object' ? req.headers : undefined
  if (headers === null || typeof headers !== 'object') return ''
  const value = headers[name]
  if (typeof value === 'string') return value.trim().toLowerCase()
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim().toLowerCase()
  return ''
}

/**
 * Same-origin guard. Rejects an explicitly cross-site `Sec-Fetch-Site` and a present
 * `Origin` whose host differs from the request's own Host. Missing headers are
 * accepted (local tools and older browsers); the check adds defense in depth, not
 * the primary boundary.
 */
function originProblem(req, webServer) {
  const secFetchSite = headerValue(req, 'sec-fetch-site')
  if (secFetchSite !== '' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
  }
  const origin = req !== null && typeof req === 'object' && req.headers !== null && typeof req.headers === 'object'
    ? typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
    : ''
  if (origin === '') return null
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
  }
  const host = headerValue(req, 'host')
  if (host !== '') {
    if (originHost !== host) return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
    return null
  }
  try {
    const expected = typeof webServer?.getOrigin === 'function' ? new URL(webServer.getOrigin()) : undefined
    if (expected !== undefined && originHost === expected.host) return null
  } catch {
    // getOrigin can throw before the listener binds; fall through to rejection.
  }
  return { status: 403, code: 'CONFLUENCE_FOREIGN_ORIGIN' }
}

/** Optional connection fence; returns true when the request was answered. */
function rejectedByConnection(ctx, req, res) {
  let connection
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (connection === null || typeof connection !== 'object') return false
  if (typeof connection.requestRejection !== 'function') return false
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    return false
  }
  if (rejection === undefined || rejection === null || rejection === false) return false
  const status = typeof rejection === 'number' ? rejection : typeof rejection.status === 'number' ? rejection.status : 403
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.end()
  return true
}

// ---------------------------------------------------------------------------
// payload normalization (facade shape → panel payload, allow-list only)
// ---------------------------------------------------------------------------

/** Canonical opaque workspace id (`ws_<16hex>`), lowercase; '' when invalid. */
function normalizeWorkspaceId(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!WS_ID_RE.test(raw)) return ''
  return raw.toLowerCase()
}

/** Non-negative bounded counter. */
function cleanCount(value, fallback = 0) {
  return clampInt(value, 0, 1_000_000, fallback)
}

/** Normalize one row of the workspace list (counts/metadata only, no content). */
function normalizeWorkspaceSummary(item) {
  const record = asObject(item)
  if (record === null) return null
  const id = normalizeWorkspaceId(record.id ?? record.ws ?? record.key)
  if (id === '') return null
  return {
    id,
    label: cleanProvenanceLabel(record.label ?? record.title ?? record.name),
    entries: cleanCount(record.entries),
    messages: cleanCount(record.messages),
    peers: cleanCount(record.peers),
    lastActivity: cleanTimestamp(record.lastActivity ?? record.lastActivityAt ?? record.ts ?? ''),
  }
}

/** Normalize one workspace-scoped note row (no body, no preview, no provenance label). */
function normalizeBusEntry(item) {
  const record = asObject(item)
  if (record === null) return null
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!ENTRY_ID_RE.test(id)) return null
  return {
    id,
    seq: cleanLine(record.seq, MAX_SEQ_CHARS),
    kind: KIND_VALUES.has(record.kind) ? record.kind : 'warning',
    title: cleanLine(record.title, MAX_TITLE_CHARS),
    authorTitle: cleanAuthorTitle(record.authorTitle ?? record.author),
    ts: cleanTimestamp(record.ts ?? record.createdAt ?? ''),
    status: ENTRY_STATUS_VALUES.has(record.status) ? record.status : 'active',
    replyCount: clampInt(record.replyCount, 0, 100_000, 0),
  }
}

/** Normalize one context (keyed state) row. */
function normalizeContextEntry(item, maxValueChars) {
  const record = asObject(item)
  if (record === null) return null
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  if (!CONTEXT_KEY_RE.test(key)) return null
  return {
    key,
    value: cleanLine(record.value, maxValueChars),
    valueType: record.valueType === 'json' ? 'json' : 'text',
    updatedAt: cleanTimestamp(record.updatedAt ?? record.ts ?? ''),
    authorTitle: cleanAuthorTitle(record.authorTitle ?? record.author),
  }
}

/** Normalize one addressed-message row (headline only; never the body). */
function normalizeMessage(item) {
  const record = asObject(item)
  if (record === null) return null
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!MESSAGE_ID_RE.test(id)) return null
  let title = cleanLine(record.title ?? record.headline ?? '', MAX_TITLE_CHARS)
  // The v0.3 record has no title field; the facade may hand back the body so the
  // panel can show a one-line headline. Only the first line, capped, ever survives.
  if (title === '') {
    const firstLine = typeof record.body === 'string' ? record.body.split(/\r\n?|\n/)[0] : ''
    title = cleanLine(firstLine, MAX_TITLE_CHARS)
  }
  return {
    id,
    seq: cleanLine(record.seq, MAX_SEQ_CHARS),
    from: cleanAuthorTitle(record.from ?? record.fromTitle),
    kind: MESSAGE_KIND_VALUES.has(record.kind) ? record.kind : 'notice',
    title,
    ts: cleanTimestamp(record.ts),
  }
}

/** Normalize one live-peer row (display title + status only). */
function normalizePeer(item) {
  const record = asObject(item)
  if (record === null) return null
  const title = cleanAuthorTitle(record.title ?? record.sessionTitle ?? record.name)
  if (title === '') return null
  return {
    title,
    status: PEER_STATUS_VALUES.has(record.status) ? record.status : 'unknown',
  }
}

/** Normalize the peers list with the shared cap. */
function normalizePeers(item) {
  const peers = []
  const seen = new Set()
  for (const entry of asArray(item)) {
    const peer = normalizePeer(entry)
    if (peer === null) continue
    const key = peer.title + '\u0000' + peer.status
    if (seen.has(key)) continue
    seen.add(key)
    peers.push(peer)
    if (peers.length >= MAX_PEERS) break
  }
  return peers
}

/** Normalize one note reply row (workspace-scoped: no provenance label). */
function normalizeReply(item) {
  const record = asObject(item)
  if (record === null) return null
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!ENTRY_ID_RE.test(id)) return null
  return {
    id,
    seq: cleanLine(record.seq, MAX_SEQ_CHARS),
    body: cleanBody(record.body, MAX_REPLY_BODY_CHARS),
    authorTitle: cleanAuthorTitle(record.authorTitle ?? record.author),
    ts: cleanTimestamp(record.ts ?? record.createdAt ?? ''),
  }
}

/** Normalize one note detail row (single-entry route only; body allowed here). */
function normalizeEntryDetail(item, maxBodyChars) {
  const row = normalizeBusEntry(item)
  if (row === null) return null
  const record = asObject(item)
  const tags = []
  for (const tag of asArray(record.tags)) {
    const cleaned = cleanLine(typeof tag === 'string' ? tag : '', 32).toLowerCase()
    if (cleaned !== '' && !tags.includes(cleaned) && tags.length < MAX_TAGS) tags.push(cleaned)
  }
  const files = []
  for (const file of asArray(record.files)) {
    const relative = cleanRelativePath(file)
    if (relative !== '' && !files.includes(relative) && files.length < MAX_FILES) files.push(relative)
  }
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    title: row.title,
    body: cleanBody(record.body, maxBodyChars),
    tags,
    files,
    authorTitle: row.authorTitle,
    ts: row.ts,
    status: row.status,
  }
}

/** Normalize the bus `stats` object; falls back to the emitted page lengths. */
function normalizeBusStats(item, lengths) {
  const record = asObject(item)
  const read = (key) => (record !== null && record[key] !== undefined ? cleanCount(record[key], lengths[key]) : lengths[key])
  return {
    context: read('context'),
    entries: read('entries'),
    messages: read('messages'),
    peers: read('peers'),
  }
}

/** Normalize the profile `stats` object; falls back to the emitted counts. */
function normalizeProfileStats(item, sections, facts, styles) {
  const record = asObject(item)
  const read = (key, fallback) => (record !== null && record[key] !== undefined ? cleanCount(record[key], fallback) : fallback)
  return {
    sections: read('sections', sections),
    facts: read('facts', facts),
    styles: read('styles', styles),
  }
}

/** Resolve a persona section id, folding the v0.3 legacy aliases (§1.3). */
function personaSectionId(value) {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (PROFILE_SECTION_ORDER.includes(raw)) return raw
  const alias = PROFILE_SECTION_ALIASES[raw]
  return typeof alias === 'string' ? alias : ''
}

/** Normalize one profile fact row. */
function normalizeProfileFact(item, sectionId, maxValueChars) {
  const record = asObject(item)
  if (record === null) return null
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!FACT_ID_RE.test(id)) return null
  const section = personaSectionId(record.section) || personaSectionId(sectionId)
  if (section === '') return null
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  if (!CONTEXT_KEY_RE.test(key)) return null
  return {
    id,
    section,
    key,
    value: cleanLine(record.value, maxValueChars),
    confidence: clampNumber(record.confidence, 0, 1, 0.6),
    source: PROFILE_SOURCE_VALUES.has(record.source) ? record.source : 'agent',
    ts: cleanTimestamp(record.ts),
  }
}

/**
 * Normalize persona sections. Accepts either the sectioned facade shape
 * (`sections:[{id, facts:[...]}]`) or a flat `facts[]` array; the v0.3 legacy
 * aliases (`preferences`/`rules`) fold into their v0.4 persona section and the now
 * non-persona sections (`tech`/`context`) are dropped. Emits sections in the fixed
 * §1.3 order, only non-empty ones, and never more than MAX_PROFILE_FACTS.
 */
function normalizeProfileSections(item, maxValueChars) {
  const record = asObject(item) ?? {}
  const sections = []
  let factsTotal = 0
  let dropped = false
  const build = (id, factsRaw) => {
    const facts = []
    const seen = new Set()
    for (const entry of asArray(factsRaw)) {
      const fact = normalizeProfileFact(entry, id, maxValueChars)
      if (fact === null || seen.has(fact.id) || fact.section !== id) {
        dropped = true
        continue
      }
      seen.add(fact.id)
      if (factsTotal >= MAX_PROFILE_FACTS) {
        dropped = true
        continue
      }
      facts.push(fact)
      factsTotal += 1
    }
    if (facts.length > 0) sections.push({ id, facts })
  }
  const byId = new Map()
  if (Array.isArray(record.sections)) {
    for (const entry of record.sections) {
      const section = asObject(entry)
      const id = section !== null ? personaSectionId(section.id) : ''
      if (id === '' || byId.has(id)) {
        dropped = true
        continue
      }
      byId.set(id, section.facts)
    }
  } else if (Array.isArray(record.facts)) {
    for (const entry of record.facts) {
      const row = asObject(entry)
      const id = row !== null ? personaSectionId(row.section) : ''
      if (id === '') {
        dropped = true
        continue
      }
      if (!byId.has(id)) byId.set(id, [])
      byId.get(id).push(entry)
    }
  }
  for (const id of PROFILE_SECTION_ORDER) {
    if (byId.has(id)) build(id, byId.get(id))
  }
  return { sections, facts: factsTotal, dropped }
}

/** Normalize one long-term `pattern` row (v0.4-interfaces.md §1.1 allow-list). */
function normalizePattern(item, defaultStatus) {
  const record = asObject(item)
  if (record === null) return null
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  if (!CONTEXT_KEY_RE.test(key)) return null
  const tags = []
  for (const tag of asArray(record.tags)) {
    const cleaned = cleanLine(typeof tag === 'string' ? tag : '', 32).toLowerCase()
    if (cleaned !== '' && !tags.includes(cleaned) && tags.length < MAX_TAGS) tags.push(cleaned)
  }
  const scope = PATTERN_SCOPE_VALUES.has(record.scope) ? record.scope : 'global'
  const status = PATTERN_STATUS_VALUES.has(record.status) ? record.status : defaultStatus
  return {
    key,
    category: PATTERN_CATEGORY_VALUES.has(record.category) ? record.category : 'heuristic',
    title: cleanLine(record.title, MAX_PATTERN_TITLE_CHARS),
    body: cleanBody(record.body, MAX_PATTERN_BODY_CHARS),
    tags,
    scope,
    workspaceLabel: scope === 'workspace' ? cleanProvenanceLabel(record.workspaceLabel) : '',
    status,
    confidence: clampNumber(record.confidence, 0, 1, 0.5),
    source: PATTERN_SOURCE_VALUES.has(record.source) ? record.source : 'agent',
    ts: cleanTimestamp(record.ts),
  }
}

/**
 * True when a facade pattern row exceeds a display bound, so the payload can flag
 * `truncated: true` instead of silently shortening the row.
 */
function patternRowOverflowed(record) {
  if (record === null) return false
  if (typeof record.body === 'string' && record.body.length > MAX_PATTERN_BODY_CHARS) return true
  if (typeof record.title === 'string' && record.title.length > MAX_PATTERN_TITLE_CHARS) return true
  return asArray(record.tags).length > MAX_TAGS
}

/**
 * Collect normalized pattern rows: de-duplicated by key, capped, and reporting
 * whether anything was dropped or shortened (the payload then sets `truncated: true`).
 */
function normalizePatterns(rows, defaultStatus, limit) {
  const patterns = []
  const seen = new Set()
  let dropped = false
  for (const item of asArray(rows)) {
    const record = asObject(item)
    const row = normalizePattern(item, defaultStatus)
    if (row === null || seen.has(row.key)) {
      dropped = true
      continue
    }
    seen.add(row.key)
    if (patternRowOverflowed(record)) dropped = true
    if (patterns.length >= limit) {
      dropped = true
      continue
    }
    patterns.push(row)
  }
  return { patterns, dropped }
}

/** Normalize the memory `stats` object; falls back to the emitted row counts. */
function normalizeMemoryStats(item, lengths) {
  const record = asObject(item)
  const read = (key) => (record !== null && record[key] !== undefined ? cleanCount(record[key], lengths[key]) : lengths[key])
  return {
    total: read('total'),
    active: read('active'),
    candidates: read('candidates'),
  }
}

/** Normalize the bounded `examples` summary of one style card (§6 addition). */
function normalizeStyleExamples(item) {
  const examples = []
  for (const entry of asArray(item)) {
    const record = asObject(entry)
    if (record === null) continue
    const bad = cleanLine(record.bad, MAX_STYLE_EXAMPLE_CHARS)
    const good = cleanLine(record.good, MAX_STYLE_EXAMPLE_CHARS)
    if (bad === '' && good === '') continue
    examples.push({ bad, good })
    if (examples.length >= MAX_STYLE_EXAMPLES) break
  }
  return examples
}

/**
 * Normalize one style-card row (v0.4-interfaces.md §1.2 allow-list, plus the
 * optional bounded `examples` summary the client renders as the example excerpt).
 */
function normalizeStyle(item) {
  const record = asObject(item)
  if (record === null) return null
  const channel = typeof record.channel === 'string' ? record.channel.trim() : ''
  if (!STYLE_CHANNEL_VALUES.includes(channel)) return null
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  if (!CONTEXT_KEY_RE.test(key)) return null
  const row = {
    channel,
    area: STYLE_AREA_VALUES.has(record.area) ? record.area : 'general',
    key,
    title: cleanLine(record.title, MAX_PATTERN_TITLE_CHARS),
    rule: cleanBody(record.rule, MAX_STYLE_RULE_CHARS),
    enabled: record.enabled !== false,
    priority: clampInt(record.priority, 0, 100, 50),
  }
  const examples = normalizeStyleExamples(record.examples)
  if (examples.length > 0) row.examples = examples
  return row
}

/**
 * True when a facade style row exceeds a display bound, so the payload can flag
 * `truncated: true` instead of silently shortening the card.
 */
function styleRowOverflowed(record) {
  if (record === null) return false
  if (typeof record.rule === 'string' && record.rule.length > MAX_STYLE_RULE_CHARS) return true
  if (typeof record.title === 'string' && record.title.length > MAX_PATTERN_TITLE_CHARS) return true
  const examples = asArray(record.examples)
  if (examples.length > MAX_STYLE_EXAMPLES) return true
  return examples.some((entry) => {
    const row = asObject(entry)
    return row !== null && (
      (typeof row.bad === 'string' && row.bad.length > MAX_STYLE_EXAMPLE_CHARS)
      || (typeof row.good === 'string' && row.good.length > MAX_STYLE_EXAMPLE_CHARS)
    )
  })
}

/** Collect normalized style rows: de-duplicated by (channel,key), capped. */
function normalizeStyles(rows, limit) {
  const styles = []
  const seen = new Set()
  let dropped = false
  for (const item of asArray(rows)) {
    const record = asObject(item)
    const row = normalizeStyle(item)
    if (row === null) {
      dropped = true
      continue
    }
    const identity = row.channel + '\u0000' + row.key
    if (seen.has(identity)) {
      dropped = true
      continue
    }
    seen.add(identity)
    if (styleRowOverflowed(record)) dropped = true
    if (styles.length >= limit) {
      dropped = true
      continue
    }
    styles.push(row)
  }
  return { styles, dropped }
}

// ---------------------------------------------------------------------------
// route payloads (read-only over the facade)
// ---------------------------------------------------------------------------

/** Ping payload: fixed shape, no data access. */
function pingPayload() {
  return { ok: true, name: PLUGIN_NAME, version: PLUGIN_VERSION }
}

/** Call one facade read method; a missing method is an explicit degraded state. */
async function callFacade(facade, method, ...args) {
  if (facade === null || typeof facade !== 'object' || typeof facade[method] !== 'function') {
    throw facadeError('STORE_UNAVAILABLE', 'panel data source unavailable')
  }
  return await facade[method](...args)
}

/** Build a facade-style error with a stable code. */
function facadeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Workspace list payload: opaque workspace ids, display labels and counts only.
 * No note body, no message body, no filesystem path can be emitted here.
 */
async function workspacesPayload({ facade }) {
  const raw = await callFacade(facade, 'panelWorkspaces')
  if (asObject(raw) === null) throw facadeError('STORE_UNAVAILABLE', 'panel data source unavailable')
  const profile = asObject(raw.profile)
  const profileLabel = cleanProvenanceLabel(profile !== null ? profile.label : '')
  const rows = asArray(raw.workspaces)
  const workspaces = []
  const seen = new Set()
  for (const item of rows) {
    const row = normalizeWorkspaceSummary(item)
    if (row === null || seen.has(row.id)) continue
    seen.add(row.id)
    workspaces.push(row)
    if (workspaces.length >= MAX_WORKSPACES) break
  }
  return {
    ok: true,
    profile: { label: profileLabel === '' ? PANEL_SCOPE.label : profileLabel },
    workspaces,
    truncated: raw.truncated === true || rows.length > workspaces.length,
  }
}

/** Parse the required opaque `ws` query parameter. */
function parseWorkspaceId(url) {
  const raw = url.searchParams.get('ws')
  const id = normalizeWorkspaceId(raw)
  if (id === '') throw facadeError('BAD_ARGUMENT', 'missing or invalid workspace id')
  return id
}

/** Trimmed, capped free-text search query (empty means "no filter"). */
function parseQuery(url) {
  const raw = url.searchParams.get('q')
  if (typeof raw !== 'string') return ''
  const trimmed = raw.replace(CONTROL_CHARS_RE, ' ').trim()
  return trimmed.length > MAX_QUERY_CHARS ? trimmed.slice(0, MAX_QUERY_CHARS) : trimmed
}

/** Optional kind filter; unknown values are ignored (not an error). */
function parseKind(url, log) {
  const raw = url.searchParams.get('kind')
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const kind = raw.trim()
  if (KIND_VALUES.has(kind)) return kind
  log.debug({ event: 'confluence.hostui.unknown-kind' })
  return undefined
}

/** Parse the optional bus page size (1..MAX_ENTRIES). */
function parseLimit(url) {
  const raw = url.searchParams.get('limit')
  if (raw === null || raw.trim() === '') return DEFAULT_BUS_LIMIT
  return clampInt(raw, 1, MAX_ENTRIES, DEFAULT_BUS_LIMIT)
}

/**
 * Workspace bus payload: shared state, notes (rows only), message headlines and
 * live peers of exactly one workspace. The workspace id is validated as an opaque
 * hash and forwarded to the facade; labels stay display-only.
 */
async function busPayload({ facade, url, config, log }) {
  const ws = parseWorkspaceId(url)
  const requested = {
    ws,
    q: parseQuery(url),
    kind: parseKind(url, log),
    limit: parseLimit(url),
  }
  const raw = await callFacade(facade, 'panelBus', requested)
  if (asObject(raw) === null) throw facadeError('STORE_UNAVAILABLE', 'panel data source unavailable')
  const maxValueBytes = clampInt(config?.bus?.context?.maxValueBytes, 256, 65_536, 8192)
  const maxValueChars = clampInt(maxValueBytes, 256, MAX_CONTEXT_VALUE_CHARS, MAX_CONTEXT_VALUE_CHARS)

  const workspaceRaw = asObject(raw.workspace)
  const workspace = {
    id: ws,
    label: cleanProvenanceLabel(workspaceRaw !== null ? workspaceRaw.label : ''),
  }

  const context = []
  const contextRows = asArray(raw.context)
  const seenKeys = new Set()
  for (const item of contextRows) {
    const row = normalizeContextEntry(item, maxValueChars)
    if (row === null || seenKeys.has(row.key)) continue
    seenKeys.add(row.key)
    context.push(row)
    if (context.length >= MAX_CONTEXT_KEYS) break
  }

  const entries = []
  const entryRows = asArray(raw.entries)
  const seenEntries = new Set()
  for (const item of entryRows) {
    const row = normalizeBusEntry(item)
    if (row === null || seenEntries.has(row.id)) continue
    seenEntries.add(row.id)
    entries.push(row)
    if (entries.length >= requested.limit) break
  }

  const messages = []
  const messageRows = asArray(raw.messages)
  const seenMessages = new Set()
  for (const item of messageRows) {
    const row = normalizeMessage(item)
    if (row === null || seenMessages.has(row.id)) continue
    seenMessages.add(row.id)
    messages.push(row)
    if (messages.length >= MAX_MESSAGES) break
  }

  const peerRows = asArray(raw.peers)
  const peers = normalizePeers(peerRows)

  return {
    ok: true,
    workspace,
    context,
    entries,
    messages,
    peers,
    stats: normalizeBusStats(raw.stats, {
      context: context.length,
      entries: entries.length,
      messages: messages.length,
      peers: peers.length,
    }),
    truncated: raw.truncated === true
      || contextRows.length > context.length
      || entryRows.length > entries.length
      || messageRows.length > messages.length
      || peerRows.length > peers.length,
  }
}

/** Parse and validate the `id` query parameter of the entry route. */
function parseEntryId(url) {
  const raw = url.searchParams.get('id')
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (id === '') throw facadeError('BAD_ARGUMENT', 'missing entry id')
  if (!ENTRY_ID_RE.test(id)) throw facadeError('NOT_FOUND', 'entry not found')
  return id
}

/**
 * Single-entry payload: one workspace note body + one level of replies. This is the
 * only route that carries a note body (the user explicitly opened that note).
 */
async function entryPayload({ facade, url, config, log }) {
  const ws = parseWorkspaceId(url)
  const id = parseEntryId(url)
  const maxBodyBytes = clampInt(config?.store?.maxBodyBytes, 256, 1_500_000, 8192)
  // Character budget stays well under the byte cap for UTF-8 bodies.
  const maxBodyChars = clampInt(Math.floor(maxBodyBytes / 4), 4096, 200_000, 4096)
  const raw = await callFacade(facade, 'panelEntry', { ws, id })
  const rawEntry = asObject(raw) !== null ? asObject(raw.entry) : null
  if (rawEntry === null) throw facadeError('NOT_FOUND', 'entry not found')
  const entry = normalizeEntryDetail({ ...rawEntry, id: rawEntry.id ?? id }, maxBodyChars)
  if (entry === null) throw facadeError('NOT_FOUND', 'entry not found')
  const replies = []
  for (const item of asArray(raw.replies)) {
    const reply = normalizeReply(item)
    if (reply === null) continue
    replies.push(reply)
    if (replies.length >= MAX_REPLIES) break
  }
  log.debug({ event: 'confluence.hostui.entry', bytes: byteLength(JSON.stringify(entry)) })
  return { ok: true, entry, replies }
}

/**
 * Profile payload: persona sections in the fixed §1.3 order, facts with confidence
 * and source, and the two-channel style cards. No English sentences are returned by
 * the host; the client owns all copy.
 */
async function profilePayload({ facade, config }) {
  const raw = await callFacade(facade, 'panelProfile')
  if (asObject(raw) === null) throw facadeError('STORE_UNAVAILABLE', 'panel data source unavailable')
  const maxValueBytes = clampInt(config?.profile?.maxValueBytes, 256, 65_536, 1024)
  const maxValueChars = clampInt(maxValueBytes, 256, 65_536, 1024)
  const revisionRaw = typeof raw.revision === 'number' ? String(raw.revision) : raw.revision
  const revision = cleanLine(revisionRaw, MAX_REVISION_CHARS)
  const normalized = normalizeProfileSections(raw, maxValueChars)
  const styleRows = normalizeStyles(raw.styles, MAX_STYLES)
  return {
    ok: true,
    revision,
    sections: normalized.sections,
    styles: styleRows.styles,
    stats: normalizeProfileStats(raw.stats, normalized.sections.length, normalized.facts, styleRows.styles.length),
    truncated: raw.truncated === true || normalized.dropped || styleRows.dropped,
  }
}

/**
 * Long-term memory payload (v0.4-interfaces.md §6): the active `pattern` records and
 * the candidate queue, plus fold counts. There is no write path here — candidates
 * are confirmed conversationally with the Agent.
 *
 * `patterns` carries active rows and `candidates` carries candidate rows; a facade
 * that returns one flat `patterns` list (no `candidates` array) is split by status.
 */
async function memoryPayload({ facade }) {
  const raw = await callFacade(facade, 'panelMemory')
  if (asObject(raw) === null) throw facadeError('STORE_UNAVAILABLE', 'panel data source unavailable')
  const revisionRaw = typeof raw.revision === 'number' ? String(raw.revision) : raw.revision
  const revision = cleanLine(revisionRaw, MAX_REVISION_CHARS)
  const patternRows = asArray(raw.patterns)
  const candidatesGiven = Array.isArray(raw.candidates)
  const activeSource = candidatesGiven ? patternRows : patternRows.filter((row) => asObject(row)?.status !== 'candidate')
  const candidateSource = candidatesGiven ? raw.candidates : patternRows.filter((row) => asObject(row)?.status === 'candidate')
  const activeRows = normalizePatterns(activeSource, 'active', MAX_PATTERNS)
  const candidateRows = normalizePatterns(candidateSource, 'candidate', MAX_PATTERN_CANDIDATES)
  const emitted = activeRows.patterns.length + candidateRows.patterns.length
  return {
    ok: true,
    revision,
    patterns: activeRows.patterns,
    candidates: candidateRows.patterns,
    stats: normalizeMemoryStats(raw.stats, {
      total: emitted,
      active: activeRows.patterns.length,
      candidates: candidateRows.patterns.length,
    }),
    truncated: raw.truncated === true
      || activeRows.dropped
      || candidateRows.dropped
      || patternRows.length + (candidatesGiven ? asArray(raw.candidates).length : 0) > emitted,
  }
}

/** Sanitize a download filename to a conservative ASCII token. */
function cleanFilename(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '')
  if (cleaned === '') return fallback
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned
}

/**
 * Profile export payload: a raw file download, never a JSON envelope. The facade
 * returns the already-rendered complete `confluence.memory/v1` document (JSON or
 * Markdown, persona + patterns + styles); the host only picks the content
 * type/filename and enforces the response cap.
 */
async function profileExportPayload({ facade, url }) {
  const rawFormat = url.searchParams.get('format')
  const format = rawFormat === null || rawFormat.trim() === '' ? 'json' : rawFormat.trim().toLowerCase()
  if (format !== 'json' && format !== 'md') throw facadeError('BAD_ARGUMENT', 'format must be json or md')
  const raw = await callFacade(facade, 'panelProfileExport', { format })
  if (asObject(raw) === null) throw facadeError('STORE_UNAVAILABLE', 'profile export unavailable')
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (format === 'json') {
    return {
      body: text,
      contentType: 'application/json; charset=utf-8',
      filename: cleanFilename('confluence-profile.json', 'confluence-profile.json'),
    }
  }
  return {
    body: text,
    contentType: 'text/markdown; charset=utf-8',
    filename: cleanFilename('confluence-profile.md', 'confluence-profile.md'),
  }
}

// ---------------------------------------------------------------------------
// payload fitting (64 KiB cap, explicit truncated flag)
// ---------------------------------------------------------------------------

/**
 * Fit a payload under the response cap by dropping the least important content and
 * marking `truncated: true`. Never silently cuts bytes; a payload that cannot fit
 * (only possible for the download route, which is handled separately) is left for
 * `sendJson` to answer with the explicit too-large error.
 */
function fitPayload(routeName, payload) {
  const initial = JSON.stringify(payload)
  if (byteLength(initial) <= MAX_RESPONSE_BYTES) return { payload, size: byteLength(initial) }
  const fit = (candidate) => {
    const serialized = JSON.stringify(candidate)
    return byteLength(serialized) <= MAX_RESPONSE_BYTES ? { payload: candidate, size: byteLength(serialized) } : null
  }

  if (routeName === 'workspaces' && Array.isArray(payload.workspaces)) {
    const workspaces = payload.workspaces.slice()
    while (workspaces.length > 0) {
      workspaces.pop()
      const fitted = fit({ ...payload, workspaces, truncated: true })
      if (fitted !== null) return fitted
    }
  }

  if (routeName === 'bus') {
    const bus = {
      ...payload,
      context: Array.isArray(payload.context) ? payload.context.slice() : [],
      entries: Array.isArray(payload.entries) ? payload.entries.slice() : [],
      messages: Array.isArray(payload.messages) ? payload.messages.slice() : [],
      peers: Array.isArray(payload.peers) ? payload.peers.slice() : [],
    }
    // Degradation order: message headlines → shared state → peers → note rows.
    for (const key of ['messages', 'context', 'peers', 'entries']) {
      while (bus[key].length > 0) {
        bus[key].pop()
        const fitted = fit({ ...bus, truncated: true })
        if (fitted !== null) return fitted
      }
    }
  }

  if (routeName === 'entry' && payload.entry !== undefined && payload.entry !== null) {
    const entry = { ...payload.entry }
    const replies = Array.isArray(payload.replies) ? payload.replies.slice() : []
    const currentBody = typeof entry.body === 'string' ? entry.body : ''
    const bodyLimits = []
    for (const limit of [4096, 1024, 256, 0]) {
      if (limit < currentBody.length) bodyLimits.push(limit)
    }
    bodyLimits.push(0)
    for (const limit of bodyLimits) {
      entry.body = currentBody.length > limit ? currentBody.slice(0, limit) : currentBody
      while (replies.length > 0) {
        const fitted = fit({ ...payload, entry, replies: replies.slice(), truncated: true })
        if (fitted !== null) return fitted
        replies.pop()
      }
      const fitted = fit({ ...payload, entry, replies: [], truncated: true })
      if (fitted !== null) return fitted
    }
  }

  if (routeName === 'memory') {
    const memory = {
      ...payload,
      patterns: (Array.isArray(payload.patterns) ? payload.patterns : []).map((row) => ({ ...row })),
      candidates: (Array.isArray(payload.candidates) ? payload.candidates : []).map((row) => ({ ...row })),
    }
    const attempt = () => fit({ ...memory, truncated: true })
    // Degradation order: pattern bodies (the largest content) → candidate rows →
    // active pattern rows. Candidate rows are the short confirm queue, so they go
    // after the bodies but before the active rules they refer to.
    const bodies = memory.patterns.map((row) => (typeof row.body === 'string' ? row.body : ''))
    for (const limit of [512, 256, 96, 0]) {
      for (let index = 0; index < memory.patterns.length; index += 1) {
        memory.patterns[index].body = bodies[index].length > limit ? bodies[index].slice(0, limit) : bodies[index]
      }
      const fitted = attempt()
      if (fitted !== null) return fitted
    }
    while (memory.candidates.length > 0) {
      memory.candidates.pop()
      const fitted = attempt()
      if (fitted !== null) return fitted
    }
    while (memory.patterns.length > 0) {
      memory.patterns.pop()
      const fitted = attempt()
      if (fitted !== null) return fitted
    }
  }

  if (routeName === 'profile') {
    const sections = (Array.isArray(payload.sections) ? payload.sections : []).map((section) => ({
      ...section,
      facts: Array.isArray(section.facts) ? section.facts.slice() : [],
    }))
    const styles = (Array.isArray(payload.styles) ? payload.styles : []).map((row) => ({ ...row }))
    const attempt = () => fit({
      ...payload,
      sections: sections.filter((section) => section.facts.length > 0),
      styles: styles.map((row) => ({ ...row })),
      truncated: true,
    })
    // Degradation order: example excerpts → rule text → style rows → facts.
    for (const row of styles) delete row.examples
    let fitted = attempt()
    if (fitted !== null) return fitted
    const rules = styles.map((row) => (typeof row.rule === 'string' ? row.rule : ''))
    for (const limit of [512, 256, 96, 0]) {
      for (let index = 0; index < styles.length; index += 1) {
        styles[index].rule = rules[index].length > limit ? rules[index].slice(0, limit) : rules[index]
      }
      fitted = attempt()
      if (fitted !== null) return fitted
    }
    while (styles.length > 0) {
      styles.pop()
      fitted = attempt()
      if (fitted !== null) return fitted
    }
    while (true) {
      let target = -1
      for (let index = sections.length - 1; index >= 0; index -= 1) {
        if (sections[index].facts.length > 0) {
          target = index
          break
        }
      }
      if (target < 0) break
      sections[target].facts.pop()
      fitted = attempt()
      if (fitted !== null) return fitted
    }
    fitted = attempt()
    if (fitted !== null) return fitted
  }

  return { payload, size: byteLength(JSON.stringify(payload)) }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** Send one JSON response honoring HEAD and the hard size cap. */
function sendJson(res, req, status, payload) {
  let serialized = JSON.stringify(payload)
  let currentStatus = status
  if (byteLength(serialized) > MAX_RESPONSE_BYTES) {
    currentStatus = 500
    serialized = JSON.stringify({
      ok: false,
      error: {
        code: 'CONFLUENCE_RESPONSE_TOO_LARGE',
        message: 'panel response exceeded the 64 KiB limit',
      },
    })
  }
  const size = byteLength(serialized)
  res.statusCode = currentStatus
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-length', String(size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(serialized)
}

/** Respond with an error envelope (used before a route runs). */
function sendError(res, req, status, code, message) {
  sendJson(res, req, status, { ok: false, error: { code, message } })
}

/**
 * Send a raw file download (profile export). Deliberately NOT a JSON envelope:
 * `content-disposition: attachment` with the rendered JSON/Markdown body and the
 * same no-store/nosniff/64 KiB posture as the JSON routes.
 */
function sendDownload(res, req, download) {
  const body = typeof download.body === 'string' ? download.body : ''
  const size = byteLength(body)
  if (size > MAX_RESPONSE_BYTES) {
    sendError(res, req, 500, 'CONFLUENCE_RESPONSE_TOO_LARGE', 'panel response exceeded the 64 KiB limit')
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', download.contentType)
  res.setHeader('content-disposition', `attachment; filename="${download.filename}"`)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-length', String(size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

/**
 * Create the Node request handler for one exact route. The returned function may be
 * awaited by tests; the real web server accepts either a value or a promise.
 */
function createRouteHandler(context, route) {
  return function handleRequest(req, res) {
    return dispatch(context, route, req, res).catch((error) => {
      context.log.error({ event: 'confluence.hostui.dispatch-failed', message: cleanMessage(error) })
      try {
        sendError(res, req, 500, 'CONFLUENCE_INTERNAL', 'panel request failed')
      } catch {
        // The response is already gone; nothing else can be done.
      }
    })
  }
}

/** Dispatch one request through the guards, route and response cap. */
async function dispatch(context, route, req, res) {
  if (req === null || typeof req !== 'object' || res === null || typeof res !== 'object') return
  if (rejectedByConnection(context.ctx, req, res)) return
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, HEAD')
    res.setHeader('cache-control', 'no-store')
    res.end()
    return
  }
  const origin = originProblem(req, context.webServer)
  if (origin !== null) {
    sendError(res, req, origin.status, origin.code, 'cross-origin panel request rejected')
    return
  }
  let url
  try {
    url = new URL(typeof req.url === 'string' && req.url.length > 0 ? req.url : '/', 'http://127.0.0.1')
  } catch {
    sendError(res, req, 400, 'CONFLUENCE_INVALID_ARGUMENT', 'invalid request url')
    return
  }
  let payload
  try {
    payload = await route.run({ ...context, req, url })
  } catch (error) {
    const mapped = mapError(error)
    sendJson(res, req, mapped.status, mapped.payload)
    return
  }
  if (payload === null || typeof payload !== 'object') {
    sendError(res, req, 500, 'CONFLUENCE_INTERNAL', 'panel request failed')
    return
  }
  if (route.download === true) {
    sendDownload(res, req, payload)
    return
  }
  const fitted = fitPayload(route.name, payload)
  sendJson(res, req, 200, fitted.payload)
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Register the read-only panel data routes on the optional `webServer` service.
 *
 * @param {object} ctx Cordis plugin context (only `get`/`effect`/`logger` are used).
 * @param {object} options `{ facade, config, logger }`.
 * @returns {() => void} disposer; a no-op when the UI is disabled or cannot mount.
 */
/**
 * Register the read-only panel routes on the optional `webServer` service.
 *
 * The Web runtime may not be mounted yet when this plugin row applies (Cordis
 * activates rows asynchronously), so a one-shot `ctx.get('webServer')` at
 * activation can silently miss the service and leave every panel route
 * unregistered — the sidebar page then shows 404 / "panel request failed".
 * The preferred path therefore waits for the optional service through
 * `ctx.inject(['webServer'], …)`, exactly like the other profile plugins; the
 * one-shot registration stays as the fallback for older hosts and tests.
 *
 * @param {object} ctx Cordis plugin context
 * @param {{ facade?: object, config?: object, logger?: object }} [options]
 * @returns {() => void} disposer (never throws)
 */
export function registerHostUi(ctx, options = {}) {
  const log = safeLogger(options.logger)
  const noop = () => {}
  if (options.config?.ui?.enabled === false) {
    log.debug({ event: 'confluence.hostui.disabled' })
    return noop
  }
  if (options.facade === null || typeof options.facade !== 'object') {
    log.warn({ event: 'confluence.hostui.no-facade' })
    return noop
  }
  const baseContext = {
    ctx,
    webServer: null,
    facade: options.facade,
    config: options.config !== null && typeof options.config === 'object' ? options.config : {},
    log,
  }
  const disposers = []
  let mounted = false
  const disposeAll = once(() => {
    for (const dispose of disposers.splice(0)) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        log.warn({ event: 'confluence.hostui.dispose-failed', message: cleanMessage(error) })
      }
    }
  })

  /**
   * Register every route on one concrete web server instance.
   * @param {object | undefined} webServer
   * @param {object} scopeCtx context whose effect scope owns the registrations
   * @returns {boolean} whether at least one route registered
   */
  const registerOn = (webServer, scopeCtx) => {
    if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return false
    const context = { ...baseContext, webServer, ctx: scopeCtx ?? ctx }
    let registered = 0
    for (const route of ROUTES) {
      const handler = createRouteHandler(context, route)
      const register = () => webServer.register({ kind: 'exact', path: route.path, handler })
      try {
        const disposer =
          scopeCtx && typeof scopeCtx.effect === 'function'
            ? scopeCtx.effect(register, `confluence:hostui:${route.name}`)
            : register()
        if (typeof disposer === 'function') disposers.push(disposer)
        registered += 1
      } catch (error) {
        log.warn({ event: 'confluence.hostui.route-register-failed', path: route.path, message: cleanMessage(error) })
      }
    }
    if (registered > 0) mounted = true
    return registered > 0
  }

  // Preferred path: wait for the optional service (cold-start race).
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (childCtx) => {
        const webServer =
          childCtx !== null && typeof childCtx === 'object'
            ? childCtx.webServer ?? (typeof childCtx.get === 'function' ? childCtx.get('webServer') : undefined)
            : undefined
        if (!registerOn(webServer, childCtx !== null && typeof childCtx === 'object' ? childCtx : ctx)) {
          log.warn({ event: 'confluence.hostui.no-web-server' })
        } else {
          log.info({ event: 'confluence.hostui.ready', routes: ROUTES.length })
        }
      })
      return disposeAll
    } catch (error) {
      log.warn({ event: 'confluence.hostui.inject-failed', message: cleanMessage(error) })
      // Fall through to the one-shot path below.
    }
  }

  // Fallback: the service is already available (older hosts, tests, embedders).
  const webServer = getService(ctx, 'webServer')
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    log.debug({ event: 'confluence.hostui.no-web-server' })
    return noop
  }
  if (!registerOn(webServer, ctx)) {
    log.warn({ event: 'confluence.hostui.no-routes' })
    return noop
  }
  log.info({ event: 'confluence.hostui.ready', routes: ROUTES.length })
  return disposeAll
}

// Internal helpers exported for the unit tests only (not used by the plugin entry).
export const hostuiInternals = {
  cleanLine,
  cleanBody,
  cleanRelativePath,
  cleanProvenanceLabel,
  cleanAuthorTitle,
  normalizeWorkspaceId,
  normalizeWorkspaceSummary,
  normalizeBusEntry,
  normalizeContextEntry,
  normalizeMessage,
  normalizePeer,
  normalizePeers,
  normalizeReply,
  normalizeEntryDetail,
  normalizeBusStats,
  normalizeProfileFact,
  normalizeProfileSections,
  normalizeProfileStats,
  normalizePattern,
  normalizePatterns,
  normalizeMemoryStats,
  normalizeStyle,
  normalizeStyles,
  normalizeStyleExamples,
  fitPayload,
  mapError,
  PROFILE_SECTION_ORDER,
  PROFILE_SECTION_ALIASES,
  PATTERN_CATEGORY_VALUES,
  STYLE_CHANNEL_VALUES,
  STYLE_AREA_VALUES,
  ROUTES,
}
