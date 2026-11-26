#!/usr/bin/env node
// Confluence / 高级记忆 — offline E2E assertions for one `scripts/e2e-dsh.ps1` run (v0.4.0).
//
// v0.4.0 (ADR-0009, extends ADR-0008) has three memory layers plus an output side:
//   workspace bus    — per-workspace keyed context + notes + addressed messages,
//                      never merged across workspaces (unchanged).
//   long-term memory — `pattern` records, candidate-first: add → candidate,
//                      promote (after user confirmation) → active.
//   user persona     — `profile` records limited to six persona sections.
//   style cards      — `style` records in two channels (chat / engineering).
// A one-time migration converts v0.3 `tech`/`context` profile facts into patterns.
//
// The harness runs acceptance sessions in TWO directories of one scratch profile:
//   warm-up, A (board post), E (recall), P (persona set), I (legacy document import),
//   M1 (candidate add), M2 (promote + export), T (style set), S (queued notice),
//   D (context set/get) and C (bus list + inbox) in workspace-a;
//   B (no tools: isolation pulse + FOUR prompt blocks) in workspace-b.
//
// This script asserts the user-visible contract from the run directory, the scratch
// DSH_HOME and the committed logs. Exit 0 = all checks passed.
//
// No network, no dependencies.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  MEMORY_CONTEXT_NAME,
  MEMORY_PATTERNS_TAG,
  MEMORY_PULSE_TAG,
  PROFILE_CONTEXT_NAME,
  PULSE_CONTEXT_NAME,
  STYLE_CONTEXT_NAME,
  STYLE_BLOCK_TAG,
  decodeSessionLogFile,
  findSessionFiles,
  inboxSplices,
  memorySnapshots,
  pulseHeader,
  pulseSnapshots,
  profileSnapshots,
  sectionSnapshots,
  styleSnapshots,
  toolCallRecords,
  toolResults,
} from './lib/session-log.mjs'

const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'
const GLOBAL_SCOPE_LABEL = 'All sessions'
const NEW_TOOLS = [
  'confluence_board',
  'confluence_context',
  'confluence_send',
  'confluence_inbox',
  'confluence_profile',
  'confluence_memory',
  'confluence_style',
  'confluence_recall',
]
const RETIRED_TOOLS = ['confluence_post', 'confluence_read', 'confluence_search', 'confluence_reply']

// Artifacts produced by scripts/e2e-dsh.ps1.
const NOTE_TITLE = 'Workspace-bus harness gotcha'
const NOTE_BODY_MARKER = 'Synthetic workspace-bus note'
const NOTICE_BODY = 'Workspace-bus E2E notice from the offline harness.'
const NOTICE_MARKER = 'Workspace-bus E2E notice'
const CONTEXT_KEY = 'e2e.phase'
const CONTEXT_VALUE = 'note-posted'
const PERSONA_SECTION = 'communication'
const PERSONA_KEY = 'e2e.language'
const PERSONA_VALUE = 'mock E2E persona language'
const IMPORTED_PERSONA_KEY = 'e2e.imported'
const IMPORTED_PERSONA_VALUE = 'imported persona fact'
const PATTERN_KEY = 'e2e.windows-retry'
const PATTERN_TITLE = 'Windows rename needs a retry'
const STYLE_KEY = 'e2e.concise'
const STYLE_RULE = 'Keep answers short and structured for the E2E harness.'
const LEGACY_TITLE = 'Legacy workspace note'

const WRITER_FINAL = 'Workspace note accepted'
const RECALL_FINAL = 'Workspace-bus recall confirmed.'
const PROFILE_FINAL = 'Profile fact accepted'
const IMPORT_FINAL = 'Legacy profile document imported.'
const MEMORY_ADD_FINAL = 'Memory candidate accepted'
const MEMORY_PROMOTE_FINAL = 'Memory promoted and exported.'
const STYLE_FINAL = 'Style rule saved and applied.'
const SEND_FINAL = 'Notice queued'
const CONTEXT_FINAL = 'Context state confirmed.'
const BUS_FINAL = 'Workspace bus and inbox confirmed.'
const ISOLATION_FINAL = 'Hello from the Confluence E2E mock model'
const WARMUP_FINAL = 'Warm-up session completed'
const RECALL_QUERY = 'workspace-bus E2E harness gotcha'
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
const SEQ_MARKER_RE = /^[0-9A-Z]{1,26}$/

function parseArgs(argv) {
  const out = { run: '', dshHome: '', workspaceA: '', workspaceB: '', legacySeed: '', memorySeed: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[i]
    }
    if (arg === '--run') out.run = next()
    else if (arg === '--dsh-home') out.dshHome = next()
    else if (arg === '--workspace-a') out.workspaceA = next()
    else if (arg === '--workspace-b') out.workspaceB = next()
    else if (arg === '--legacy-seed') out.legacySeed = next()
    else if (arg === '--memory-seed') out.memorySeed = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.run || !out.dshHome || !out.workspaceA || !out.workspaceB) {
    throw new Error('--run, --dsh-home, --workspace-a and --workspace-b are required')
  }
  if (out.legacySeed === '') out.legacySeed = join(out.run, 'legacy-seed.json')
  if (out.memorySeed === '') out.memorySeed = join(out.run, 'memory-seed.json')
  return out
}

/** @param {string} file @returns {string} */
function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** @param {string} file @returns {any} */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** @param {string} file @returns {object[]} */
function readJsonl(file) {
  return readText(file)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { malformed: true, line }
      }
    })
}

/** @param {string} dir @returns {string[]} */
function walkFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/** @param {string} file @returns {string} */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Canonical directory comparison (scratch dirs are short-lived; fold case like the plugin does). */
function sameDir(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left === '' || right === '') return false
  const canonical = (value) => {
    let full = resolve(value)
    try {
      full = realpathSync(full)
    } catch {
      /* keep the lexical path; the run directory is ours */
    }
    return process.platform === 'win32' ? full.toLowerCase() : full
  }
  return canonical(left) === canonical(right)
}

/** @param {object[]} requests @returns {object[]} task requests (not session-title utility calls) */
function taskRequests(requests) {
  return requests.filter((request) => {
    const system = typeof request.system === 'string' ? request.system : ''
    return !/concise title/i.test(system) && !/nothing/i.test(system)
  })
}

/** @param {object} request @returns {string} concatenated user text (all text blocks) */
function requestText(request) {
  const parts = []
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** @param {unknown} block @returns {string} */
function toolResultBlockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .map((inner) => (inner && typeof inner.text === 'string' ? inner.text : ''))
      .join('\n')
  }
  return typeof block.text === 'string' ? block.text : ''
}

/** @param {object} request @returns {string[]} rendered tool-result texts carried by a request */
function requestToolResults(request) {
  const out = []
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'tool_result') out.push(toolResultBlockText(block))
    }
  }
  return out
}

/** @param {unknown} value @returns {boolean} */
function isUlid(value) {
  return typeof value === 'string' && ULID_RE.test(value)
}

/** @param {object[]} sessions @param {string} needle @returns {object | undefined} */
function sessionWith(sessions, needle) {
  return sessions.find((session) => JSON.stringify(session.events).includes(needle))
}

const checks = []
/** @param {string} id @param {string} label @param {() => void} fn */
function check(id, label, fn) {
  try {
    fn()
    checks.push({ id, label, ok: true })
    process.stdout.write(`PASS    ${id}  ${label}\n`)
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    checks.push({ id, label, ok: false, error: message })
    process.stdout.write(`FAIL    ${id}  ${label}\n        ${message}\n`)
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const args = parseArgs(process.argv.slice(2))
process.stdout.write(`Confluence v0.4 E2E assertions — run ${args.run}\n`)
process.stdout.write(`  scratch dsh home: ${args.dshHome}\n  workspace A:      ${args.workspaceA}\n  workspace B:      ${args.workspaceB}\n`)

// ── load artifacts (safe reads: a missing artifact must surface as a named FAIL) ──
const mockA = readJsonl(join(args.run, 'mock-a.jsonl'))
const mockB = readJsonl(join(args.run, 'mock-b.jsonl'))
const mockC = readJsonl(join(args.run, 'mock-c.jsonl'))
const mockD = readJsonl(join(args.run, 'mock-d.jsonl'))
const mockE = readJsonl(join(args.run, 'mock-e.jsonl'))
const mockI = readJsonl(join(args.run, 'mock-i.jsonl'))
const mockM1 = readJsonl(join(args.run, 'mock-m1.jsonl'))
const mockM2 = readJsonl(join(args.run, 'mock-m2.jsonl'))
const mockP = readJsonl(join(args.run, 'mock-p.jsonl'))
const mockS = readJsonl(join(args.run, 'mock-s.jsonl'))
const mockT = readJsonl(join(args.run, 'mock-t.jsonl'))
const allMocks = [mockA, mockB, mockC, mockD, mockE, mockI, mockM1, mockM2, mockP, mockS, mockT]

let legacySeed = null
try {
  legacySeed = readJson(args.legacySeed)
} catch {
  legacySeed = null
}
let memorySeed = null
try {
  memorySeed = readJson(args.memorySeed)
} catch {
  memorySeed = null
}
const workspaceAKey = legacySeed && typeof legacySeed.wsKey === 'string' ? legacySeed.wsKey : null

const storeRoot = join(args.dshHome, 'storages', 'confluence', 'v1', 'workspaces')
const storeDirs = existsSync(storeRoot) ? readdirSync(storeRoot).filter((name) => /^ws_[0-9a-f]{16}$/.test(name)) : []
const globalDir = join(storeRoot, GLOBAL_SCOPE_KEY)
function journalFiles(dir) {
  return walkFiles(dir).filter((file) => /journal\.[0-9]+-[0-9a-f]{8}\.v1\.jsonl$/.test(file))
}
const globalRecords = journalFiles(globalDir).flatMap(readJsonl)
const workspaceARecords = workspaceAKey === null ? [] : journalFiles(join(storeRoot, workspaceAKey)).flatMap(readJsonl)

const decoded = []
for (const found of findSessionFiles(args.dshHome)) {
  try {
    decoded.push({ ...decodeSessionLogFile(found.file), file: found.file, sessionId: found.sessionId, encodedCwd: found.encodedCwd })
  } catch {
    /* a session log that cannot decode is reported by the checks that need it */
  }
}
const writerSession = sessionWith(decoded, WRITER_FINAL)
const recallSession = sessionWith(decoded, RECALL_FINAL)
const personaSession = sessionWith(decoded, PROFILE_FINAL)
const importSession = sessionWith(decoded, IMPORT_FINAL)
const memoryAddSession = sessionWith(decoded, MEMORY_ADD_FINAL)
const memoryPromoteSession = sessionWith(decoded, MEMORY_PROMOTE_FINAL)
const styleSession = sessionWith(decoded, STYLE_FINAL)
const sendSession = sessionWith(decoded, SEND_FINAL)
const contextSession = sessionWith(decoded, CONTEXT_FINAL)
const busSession = sessionWith(decoded, BUS_FINAL)
const isolationSession = sessionWith(decoded, ISOLATION_FINAL)
const warmupSession = sessionWith(decoded, WARMUP_FINAL)

/** Tool-call names in committed order. */
function callNames(session) {
  return toolCallRecords(session.events).map((call) => call.name)
}

/** Successful tool-result records for a named tool in one session. */
function resultsFor(session, toolName) {
  const ids = new Set(toolCallRecords(session.events).filter((call) => call.name === toolName).map((call) => call.callId))
  return toolResults(session.events).filter((result) => ids.has(result.callId))
}

/** Watermark projection row for one decoded session. */
function watermarkOf(session) {
  if (!session) return null
  const file = join(args.dshHome, 'storages', 'session_projcache', 'sessions', `${session.sessionId}.json`)
  if (!existsSync(file)) return null
  const state = readJson(file)
  const row = state?.record?.rows?.confluence_watermark
  return row && row.val && typeof row.val === 'object' ? row.val : null
}

// ── E2E-01: run artifacts + scratch profile composition ─────────────────
const profileDir = join(args.dshHome, 'profiles', 'confluence-e2e')
check('E2E-01', 'every acceptance session exits 0 and the bundle composes in the scratch profile', () => {
  assert(writerSession, 'writer session log not found')
  assert(recallSession, 'recall session log not found')
  assert(personaSession, 'persona session log not found')
  assert(importSession, 'legacy-import session log not found')
  assert(memoryAddSession, 'memory candidate session log not found')
  assert(memoryPromoteSession, 'memory promote/export session log not found')
  assert(styleSession, 'style session log not found')
  assert(sendSession, 'send session log not found')
  assert(contextSession, 'context session log not found')
  assert(busSession, 'bus reader session log not found')
  assert(isolationSession, 'isolation session log not found')
  assert(warmupSession, 'warm-up session log not found')
  const manifest = readJson(join(profileDir, 'package.json'))
  assert(Array.isArray(manifest.dsh?.profile?.bundles), 'profile bundles missing')
  assert(manifest.dsh.profile.bundles.includes('dsh-confluence'), 'dsh-confluence bundle not selected')
  assert(manifest.dependencies && manifest.dependencies['dsh-confluence'], 'dsh-confluence dependency missing')
})

// ── E2E-02: two-scope store layout ──────────────────────────────────────
check('E2E-02', 'the store keeps per-workspace bus journals plus the profile-global memory journal', () => {
  assert(existsSync(storeRoot), `store root missing: ${storeRoot}`)
  assert(existsSync(globalDir), `global profile journal missing: ${globalDir}`)
  assert(workspaceAKey !== null, 'legacy seed did not record the workspace-a key')
  assert(storeDirs.includes(workspaceAKey), `workspace-a journal directory ${workspaceAKey} missing (dirs: ${storeDirs.join(', ')})`)
  assert(storeDirs.length >= 2, `expected at least the workspace-a and global journals, saw ${storeDirs.join(', ')}`)
  const globalManifest = readJson(join(globalDir, 'MANIFEST.v1.json'))
  assert(globalManifest.format === 'confluence.store/v1' && globalManifest.formatVersion === 1, 'global manifest format is not confluence.store/v1')
  assert(globalManifest.ws === GLOBAL_SCOPE_KEY, `global manifest ws is "${globalManifest.ws}"`)
  assert(globalManifest.workspace && globalManifest.workspace.canonicalPath === '', 'global manifest must carry an empty canonicalPath')
  assert(/^all sessions$/i.test(String(globalManifest.workspace.label ?? '')), `global manifest label is "${globalManifest.workspace.label}"`)
  for (const file of walkFiles(join(args.dshHome, 'storages', 'confluence'))) {
    const stat = statSync(file)
    assert(stat.isFile() && stat.size > 0, `empty store file: ${file}`)
  }
})

// ── E2E-03: bus records live only in the workspace journal ─────────────
check('E2E-03', 'workspace bus records (note, legacy note, message, context) live only in the workspace journal', () => {
  assert(workspaceARecords.length >= 4, `workspace-a journal has ${workspaceARecords.length} records`)
  for (const record of workspaceARecords) {
    assert(record.ws === workspaceAKey, `record ${record.id ?? record.type} carries ws "${record.ws}", expected "${workspaceAKey}"`)
  }
  const entries = workspaceARecords.filter((record) => record.type === 'entry')
  const note = entries.find((record) => record.title === NOTE_TITLE)
  assert(note, `workspace journal has no note titled "${NOTE_TITLE}"`)
  assert(/^cnf_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(note.id)), `bad entry id ${note.id}`)
  assert(typeof note.body === 'string' && note.body.includes(NOTE_BODY_MARKER), 'note body marker missing')
  assert(isUlid(note.seq), 'note seq missing/not a ULID')
  assert(entries.some((record) => record.title === LEGACY_TITLE), `legacy note "${LEGACY_TITLE}" missing from the workspace journal`)
  const messages = workspaceARecords.filter((record) => record.type === 'message')
  assert(messages.length === 1, `expected 1 workspace message, saw ${messages.length}`)
  assert(messages[0].body === NOTICE_BODY, 'queued message body mismatch')
  assert(messages[0].to && messages[0].to.kind === 'workspace', 'queued message must be a workspace broadcast')
  const contexts = workspaceARecords.filter((record) => record.type === 'context')
  const context = contexts.find((record) => record.key === CONTEXT_KEY)
  assert(context, `context key "${CONTEXT_KEY}" missing from the workspace journal`)
  assert(context.value === CONTEXT_VALUE, `context value is "${context.value}"`)
})

// ── E2E-04: the global journal holds the three memory layers ───────────
check('E2E-04', 'the profile-global journal holds persona, patterns, style, migration marker and the ledger — no bus records', () => {
  assert(globalRecords.length > 0, 'global journal has no records')
  for (const record of globalRecords) {
    assert(record.ws === GLOBAL_SCOPE_KEY, `global record carries ws "${record.ws}"`)
    assert(!['entry', 'message', 'context'].includes(record.type), `workspace record type ${record.type} leaked into the profile journal`)
  }
  const persona = globalRecords.filter((record) => record.type === 'profile')
  assert(
    persona.some((record) => record.section === PERSONA_SECTION && record.key === PERSONA_KEY && record.value === PERSONA_VALUE),
    `persona fact ${PERSONA_SECTION}.${PERSONA_KEY} missing`,
  )
  assert(
    persona.some((record) => record.section === 'identity' && record.key === IMPORTED_PERSONA_KEY),
    'imported legacy persona fact missing from the profile journal',
  )
  const patterns = globalRecords.filter((record) => record.type === 'pattern')
  assert(patterns.length >= 3, `expected migrated + candidate + active patterns, saw ${patterns.length}`)
  const styles = globalRecords.filter((record) => record.type === 'style')
  assert(
    styles.some((record) => record.channel === 'chat' && record.key === STYLE_KEY && record.enabled !== false),
    `style rule ${STYLE_KEY} missing from the global journal`,
  )
  const migrations = globalRecords.filter((record) => record.type === 'memory-migration')
  assert(migrations.length === 1, `expected exactly one memory-migration marker, saw ${migrations.length}`)
  assert(migrations[0].version === 1, 'migration marker version must be 1')
  assert(migrations[0].source === 'profile-v03', `migration marker source is "${migrations[0].source}"`)
  const sessions = globalRecords.filter((record) => record.type === 'session')
  assert(sessions.length >= 10, `expected metadata ledger rows for every session, saw ${sessions.length}`)
})

// ── E2E-05: one-time v0.3 → v0.4 migration ──────────────────────────────
check('E2E-05', 'v0.3 profile tech/context facts migrated once into patterns; the seeded journal is untouched', () => {
  assert(memorySeed && Array.isArray(memorySeed.facts), 'memory seed metadata missing')
  const seeded = memorySeed.files.find((file) => file.path.includes('journal.9000'))
  assert(seeded, 'memory seed has no journal file entry')
  const seededFile = join(args.run, seeded.path)
  assert(existsSync(seededFile), `seeded global journal disappeared: ${seeded.path}`)
  assert(sha256(seededFile) === seeded.sha256, 'the seeded v0.3 global journal was modified; migration must be append-only')
  const seededRecords = readJsonl(seededFile)
  assert(seededRecords.length === 3, `seeded journal should still hold 3 profile records, saw ${seededRecords.length}`)
  for (const fact of memorySeed.facts) {
    assert(
      seededRecords.some((record) => record.type === 'profile' && record.section === fact.section && record.key === fact.key),
      `seeded profile fact ${fact.section}.${fact.key} was rewritten/migrated destructively`,
    )
  }
  const migrated = globalRecords.filter((record) => record.type === 'pattern' && record.source === 'migration')
  assert(migrated.length === 2, `expected 2 migrated patterns (tech/context), saw ${migrated.length}`)
  const tech = migrated.find((record) => record.key === 'migrated.tech.project')
  const context = migrated.find((record) => record.key === 'migrated.context.repo')
  assert(tech && tech.category === 'project', 'tech fact must migrate to a project pattern')
  assert(context && context.category === 'domain', 'context fact must migrate to a domain pattern')
  assert(tech.body === memorySeed.facts.find((fact) => fact.section === 'tech').value, 'migrated tech body mismatch')
  assert(tech.status === 'active', 'migrated patterns must be active')
  assert(tech.source === 'migration', 'migrated pattern source must be migration')
})

// ── E2E-06: candidate → promote ────────────────────────────────────────
check('E2E-06', 'long-term memory is candidate-first: add stores a candidate, promote makes it active and injectable', () => {
  assert(memoryAddSession && memoryPromoteSession, 'memory sessions missing')
  assert(JSON.stringify(callNames(memoryAddSession)) === JSON.stringify(['confluence_memory']), `M1 calls: [${callNames(memoryAddSession).join(',')}]`)
  const addCall = toolCallRecords(memoryAddSession.events).find((call) => call.name === 'confluence_memory')
  assert(addCall && addCall.input && addCall.input.action === 'add', 'M1 did not call memory add')
  assert(addCall.input.category === 'pitfall' && addCall.input.key === PATTERN_KEY, 'M1 add arguments mismatch')
  const addResult = resultsFor(memoryAddSession, 'confluence_memory')[0]
  assert(addResult && !addResult.isError, 'memory add returned an error')
  assert(/Stored candidate pattern/i.test(addResult.text), 'add must render a stored candidate')
  assert(/NOT active yet/i.test(addResult.text), 'add must state the candidate is not active')
  assert(JSON.stringify(callNames(memoryPromoteSession)) === JSON.stringify(['confluence_memory', 'confluence_memory']), `M2 calls: [${callNames(memoryPromoteSession).join(',')}]`)
  const promoteCall = toolCallRecords(memoryPromoteSession.events).find((call) => call.name === 'confluence_memory')
  assert(promoteCall && promoteCall.input && promoteCall.input.action === 'promote' && promoteCall.input.key === PATTERN_KEY, 'M2 promote arguments mismatch')
  const promoteResult = resultsFor(memoryPromoteSession, 'confluence_memory')[0]
  assert(promoteResult && !promoteResult.isError, 'memory promote returned an error')
  assert(/Promoted pattern/i.test(promoteResult.text), 'promote must render an activation')
  const patternRecords = globalRecords.filter((record) => record.type === 'pattern' && record.key === PATTERN_KEY)
  assert(patternRecords.length === 2, `expected candidate + active records for ${PATTERN_KEY}, saw ${patternRecords.length}`)
  const statuses = patternRecords.map((record) => record.status).sort()
  assert(JSON.stringify(statuses) === JSON.stringify(['active', 'candidate']), `pattern statuses: ${statuses.join(', ')}`)
  const latest = patternRecords.slice().sort((a, b) => (a.seq < b.seq ? 1 : -1))[0]
  assert(latest.status === 'active', 'the newest pattern record must be active')
  assert(latest.title === PATTERN_TITLE, 'promoted pattern title mismatch')
})

// ── E2E-07: style rule ─────────────────────────────────────────────────
check('E2E-07', 'a style rule set through confluence_style is stored active and injected in another workspace', () => {
  assert(styleSession, 'style session log not found')
  assert(JSON.stringify(callNames(styleSession)) === JSON.stringify(['confluence_style']), `style calls: [${callNames(styleSession).join(',')}]`)
  const styleCall = toolCallRecords(styleSession.events).find((call) => call.name === 'confluence_style')
  assert(styleCall && styleCall.input && styleCall.input.action === 'set', 'style tool was not called with action=set')
  assert(styleCall.input.channel === 'chat' && styleCall.input.key === STYLE_KEY, 'style set arguments mismatch')
  const styleResult = resultsFor(styleSession, 'confluence_style')[0]
  assert(styleResult && !styleResult.isError, 'style set returned an error')
  assert(/Saved style rule/i.test(styleResult.text) && /active/i.test(styleResult.text), 'style set must render an active rule')
  const styleRecords = globalRecords.filter((record) => record.type === 'style')
  assert(styleRecords.some((record) => record.channel === 'chat' && record.key === STYLE_KEY && record.enabled !== false), 'active style record missing')
  const styleText = styleSnapshots(isolationSession.events).map((snapshot) => snapshot.styleText).join('\n')
  assert(styleText.includes(`<${STYLE_BLOCK_TAG}`), 'workspace-B session log has no committed style block')
  assert(styleText.includes(STYLE_RULE), 'the style block does not carry the saved rule')
  assert(/chat="[1-9][0-9]*"/.test(styleText), 'the style block does not report a chat rule count')
})

// ── E2E-08: persona (including legacy alias + imported fact) ───────────
check('E2E-08', 'persona facts (recorded, imported legacy, legacy preferences alias) are injected in another workspace', () => {
  assert(personaSession && importSession, 'persona/import sessions missing')
  assert(JSON.stringify(callNames(personaSession)) === JSON.stringify(['confluence_profile']), `persona calls: [${callNames(personaSession).join(',')}]`)
  const personaCall = toolCallRecords(personaSession.events).find((call) => call.name === 'confluence_profile')
  assert(personaCall && personaCall.input && personaCall.input.action === 'set', 'persona tool was not called with action=set')
  assert(personaCall.input.section === PERSONA_SECTION && personaCall.input.key === PERSONA_KEY, 'persona set arguments mismatch')
  const personaResult = resultsFor(personaSession, 'confluence_profile')[0]
  assert(personaResult && !personaResult.isError, 'persona set returned an error')
  assert(/revision/i.test(personaResult.text), 'persona set result lacks a revision')
  assert(JSON.stringify(callNames(importSession)) === JSON.stringify(['confluence_memory']), `import calls: [${callNames(importSession).join(',')}]`)
  const importCall = toolCallRecords(importSession.events).find((call) => call.name === 'confluence_memory')
  assert(importCall && importCall.input && importCall.input.action === 'import', 'legacy import was not called')
  assert(typeof importCall.input.data === 'string' && importCall.input.data.includes('confluence.profile/v1'), 'legacy import did not carry a confluence.profile/v1 document')
  const importResult = resultsFor(importSession, 'confluence_memory')[0]
  assert(importResult && !importResult.isError, 'legacy profile import returned an error')
  assert(/Imported/i.test(importResult.text), 'legacy import did not render an imported count')
  const profileText = profileSnapshots(isolationSession.events).map((snapshot) => snapshot.profileText).join('\n')
  assert(profileText.includes(`<confluence-profile`), 'workspace-B session log has no committed persona block')
  assert(profileText.includes(PERSONA_KEY), `persona block does not mention "${PERSONA_KEY}"`)
  assert(profileText.includes(PERSONA_VALUE), 'persona block does not carry the recorded persona value')
  assert(profileText.includes(IMPORTED_PERSONA_KEY), 'persona block does not carry the imported legacy fact')
  // The seeded v0.3 `preferences` fact must fold into the persona via the alias.
  assert(profileText.includes('answer.language'), 'legacy preferences fact did not fold into the persona block')
  assert(/rev="[0-9A-HJKMNP-TV-Z]{1,26}"/.test(profileText), 'persona block revision attribute missing')
  assert(!profileText.includes(args.run), 'persona block leaked an absolute scratch path')
})

// ── E2E-09: four prompt blocks in a workspace-B session ────────────────
check('E2E-09', 'workspace-B carries FOUR bounded prompt blocks (persona, long-term memory, style, pulse)', () => {
  assert(isolationSession, 'isolation session log not found')
  assert(sameDir(isolationSession.header?.cwd, args.workspaceB), `isolation session ran in "${isolationSession.header?.cwd}", expected workspace B`)
  const sections = [
    { name: PROFILE_CONTEXT_NAME, tag: '<confluence-profile', max: 1200 },
    { name: MEMORY_CONTEXT_NAME, tag: `<${MEMORY_PATTERNS_TAG}`, max: 1200 },
    { name: STYLE_CONTEXT_NAME, tag: `<${STYLE_BLOCK_TAG}`, max: 600 + 900 },
    { name: PULSE_CONTEXT_NAME, tag: `<${MEMORY_PULSE_TAG} scope="workspace"`, max: 1400 },
  ]
  const bTask = taskRequests(mockB)[0]
  assert(bTask, 'no isolation-session task request captured')
  const wireText = requestText(bTask)
  for (const section of sections) {
    const snapshots = sectionSnapshots(isolationSession.events, section.name)
    assert(snapshots.length >= 1, `workspace-B session log has no committed ${section.name} section`)
    const text = snapshots.map((snapshot) => snapshot.text).join('\n')
    assert(text.includes(section.tag), `${section.name} section lacks ${section.tag}`)
    assert(bounded(text, section.max), `${section.name} block exceeds its budget (${text.length} chars)`)
    // The model-facing request carries the rendered section text (not the internal
    // runtime-context section name), so match the block tag on the wire text.
    assert(wireText.includes(section.tag), `the workspace-B model request lacks the ${section.name} block (${section.tag})`)
    assert(!text.includes(args.run), `${section.name} block leaked an absolute scratch path`)
  }
  const memoryText = memorySnapshots(isolationSession.events).map((snapshot) => snapshot.memoryText).join('\n')
  assert(memoryText.includes(PATTERN_TITLE), 'memory block does not carry the promoted pattern')
  assert(/count="[1-9][0-9]*"/.test(memoryText), 'memory block does not report active patterns')
  assert(/candidates="0"/.test(memoryText), `memory block should report no pending candidates after promotion (got ${/candidates="[0-9]+"/.exec(memoryText)?.[0]})`)
})

// ── E2E-10: same-workspace bus read (headline bus) ─────────────────────
check('E2E-10', 'SAME-WORKSPACE: C lists the writer note + legacy note (through=) and reads the queued notice (inbox=)', () => {
  assert(writerSession && busSession, 'writer or bus-reader session log not found')
  assert(sameDir(writerSession.header?.cwd, args.workspaceA), `writer ran in "${writerSession.header?.cwd}", expected workspace A`)
  assert(sameDir(busSession.header?.cwd, args.workspaceA), `bus reader ran in "${busSession.header?.cwd}", expected workspace A`)
  assert(writerSession.encodedCwd === busSession.encodedCwd, 'writer and bus reader must persist in the same workspace bucket')
  assert(JSON.stringify(callNames(busSession)) === JSON.stringify(['confluence_board', 'confluence_inbox']), `bus reader tool calls: [${callNames(busSession).join(',')}]`)
  const boardResults = resultsFor(busSession, 'confluence_board')
  assert(boardResults.length === 1, `expected one board result, saw ${boardResults.length}`)
  const board = boardResults[0]
  assert(!board.isError, 'confluence_board returned an error')
  assert(board.text.includes(NOTE_TITLE), `board result does not list "${NOTE_TITLE}"`)
  assert(board.text.includes(LEGACY_TITLE), `board result does not list the legacy note "${LEGACY_TITLE}"`)
  assert(/through=[0-9A-HJKMNP-TV-Z]{1,26}/.test(board.text), 'board result lacks the through= watermark marker')
  assert(!board.text.includes(args.run), 'board result leaked an absolute scratch path into model-visible text')
  const inboxResults = resultsFor(busSession, 'confluence_inbox')
  assert(inboxResults.length === 1, `expected one inbox result, saw ${inboxResults.length}`)
  const inbox = inboxResults[0]
  assert(!inbox.isError, 'confluence_inbox returned an error')
  assert(inbox.text.includes(NOTICE_MARKER), `inbox result does not carry the queued notice "${NOTICE_MARKER}"`)
  assert(/inbox=[0-9A-HJKMNP-TV-Z]{1,26}/.test(inbox.text), 'inbox result lacks the inbox= watermark marker')
})

// ── E2E-11: cross-workspace isolation ─────────────────────────────────
check('E2E-11', 'ISOLATION: workspace B never sees workspace-A bus data (pulse, request, store)', () => {
  assert(isolationSession, 'isolation session log not found')
  assert(writerSession && !sameDir(writerSession.header?.cwd, isolationSession.header?.cwd), 'writer and isolation session ran in the same directory; isolation is NOT proven')
  assert(callNames(isolationSession).length === 0, `isolation session must make no tool calls, saw [${callNames(isolationSession).join(',')}]`)
  const pulseText = pulseSnapshots(isolationSession.events).map((snapshot) => snapshot.pulseText).join('\n')
  assert(pulseText.includes('scope="workspace"'), 'isolation session committed no workspace pulse')
  assert(!pulseText.includes(NOTE_TITLE), 'workspace-B pulse contains workspace-A note data')
  assert(!pulseText.includes(LEGACY_TITLE), 'workspace-B pulse contains workspace-A legacy data')
  assert(!pulseText.includes(NOTICE_MARKER), 'workspace-B pulse contains a workspace-A message')
  const bTask = taskRequests(mockB)[0]
  assert(bTask, 'no isolation-session task request captured')
  const wire = JSON.stringify(bTask)
  assert(!wire.includes(NOTE_TITLE), 'the workspace-B model request carries the workspace-A note title')
  assert(!wire.includes(LEGACY_TITLE), 'the workspace-B model request carries the workspace-A legacy note')
  assert(!wire.includes(NOTICE_BODY), 'the workspace-B model request carries the workspace-A message')
  for (const dirName of storeDirs) {
    if (dirName === GLOBAL_SCOPE_KEY || dirName === workspaceAKey) continue
    const records = journalFiles(join(storeRoot, dirName)).flatMap(readJsonl)
    for (const record of records) {
      assert(
        !['entry', 'message', 'context'].includes(record.type),
        `workspace ${dirName} contains a ${record.type} record; bus data must not cross workspaces`,
      )
    }
  }
})

// ── E2E-12: queued delivery, never interrupting ───────────────────────
check('E2E-12', 'messages are delivered by the queue (no interrupt, no inbox splice)', () => {
  assert(sendSession, 'send session log not found')
  assert(JSON.stringify(callNames(sendSession)) === JSON.stringify(['confluence_send']), `send tool calls: [${callNames(sendSession).join(',')}]`)
  const sendCall = toolCallRecords(sendSession.events).find((call) => call.name === 'confluence_send')
  assert(sendCall && sendCall.input && sendCall.input.to === '*', 'confluence_send was not a workspace broadcast')
  const sendResult = resultsFor(sendSession, 'confluence_send')[0]
  assert(sendResult && !sendResult.isError, 'confluence_send did not succeed')
  assert(/queued/i.test(sendResult.text), 'send result does not report queue-based delivery')
  const pluginSplices = []
  for (const session of decoded) {
    for (const splice of inboxSplices(session.events)) {
      const text = JSON.stringify(splice)
      if (text.includes('<confluence-') || text.includes('confluence:pulse')) pluginSplices.push(splice)
    }
  }
  assert(pluginSplices.length === 0, `${pluginSplices.length} Confluence inbox splice(s) present: ${JSON.stringify(pluginSplices[0])}`)
})

// ── E2E-13: shared state pool (bus) ───────────────────────────────────
check('E2E-13', 'the shared state pool round-trips within the workspace (set then get)', () => {
  assert(contextSession, 'context session log not found')
  assert(JSON.stringify(callNames(contextSession)) === JSON.stringify(['confluence_context', 'confluence_context']), `context tool calls: [${callNames(contextSession).join(',')}]`)
  const calls = toolCallRecords(contextSession.events).filter((call) => call.name === 'confluence_context')
  assert(calls[0].input && calls[0].input.action === 'set' && calls[0].input.key === CONTEXT_KEY, 'first context call must be set')
  assert(calls[1].input && calls[1].input.action === 'get' && calls[1].input.key === CONTEXT_KEY, 'second context call must be get')
  const results = resultsFor(contextSession, 'confluence_context')
  assert(results.length === 2, `expected two context results, saw ${results.length}`)
  assert(!results[0].isError && !results[1].isError, 'a context call returned an error')
  assert(results[1].text.includes(CONTEXT_VALUE), 'context get result does not carry the set value')
})

// ── E2E-14: tool surface offered/used is the v0.4 eight ───────────────
check('E2E-14', 'the model is offered the eight v0.4 tools and calls no retired v0.2 tool', () => {
  const taskRequestsAll = allMocks.flatMap((requests) => taskRequests(requests))
  assert(taskRequestsAll.length >= 10, `expected task requests across sessions, saw ${taskRequestsAll.length}`)
  for (const request of taskRequestsAll) {
    if (!Array.isArray(request.tools)) continue
    const confluenceOffered = request.tools.filter((name) => typeof name === 'string' && name.startsWith('confluence_'))
    assert(
      confluenceOffered.length === NEW_TOOLS.length && NEW_TOOLS.every((name) => confluenceOffered.includes(name)),
      `a request offered Confluence tools [${confluenceOffered.join(', ')}], expected the eight v0.4 tools`,
    )
    for (const retired of RETIRED_TOOLS) {
      assert(!request.tools.includes(retired), `a request offered the retired tool ${retired}`)
    }
  }
  for (const session of decoded) {
    for (const call of toolCallRecords(session.events)) {
      assert(!RETIRED_TOOLS.includes(call.name), `a session called the retired tool ${call.name}`)
      const offenders = Object.keys(call.input ?? {}).filter((key) => /^(ws|wsKey|workspace|workspaceId|workspaceKey|scope|scopeKey)$/i.test(key))
      assert(offenders.length === 0, `${call.name} passes forbidden scope argument(s): ${offenders.join(', ')}`)
      assert(!/\bws_[0-9a-f]{16}\b/.test(call.argumentsText), `${call.name} arguments embed a workspace key`)
    }
  }
})

// ── E2E-15: watermarks (unchanged from v0.3) ──────────────────────────
check('E2E-15', 'watermarks: digestSeq commits, boardReadSeq follows the board read, inboxReadSeq the inbox read', () => {
  const writerMark = watermarkOf(writerSession)
  const busMark = watermarkOf(busSession)
  const isolationMark = watermarkOf(isolationSession)
  const recallMark = watermarkOf(recallSession)
  for (const [label, mark] of [['writer', writerMark], ['bus reader', busMark], ['isolation', isolationMark], ['recall', recallMark]]) {
    assert(mark, `${label} watermark projection state missing`)
    assert(SEQ_MARKER_RE.test(String(mark.digestSeq ?? '')), `${label} digestSeq is "${mark.digestSeq}"`)
  }
  assert(writerMark.boardReadSeq === null, `writer only posted but boardReadSeq is "${writerMark.boardReadSeq}"`)
  assert(writerMark.inboxReadSeq === null, `writer did not read inbox but inboxReadSeq is "${writerMark.inboxReadSeq}"`)
  assert(isUlid(busMark.boardReadSeq), `bus reader boardReadSeq is "${busMark.boardReadSeq}" after confluence_board`)
  assert(isUlid(busMark.inboxReadSeq), `bus reader inboxReadSeq is "${busMark.inboxReadSeq}" after confluence_inbox`)
  const boardThrough = /through=([0-9A-HJKMNP-TV-Z]{26})/.exec(resultsFor(busSession, 'confluence_board')[0]?.text ?? '')?.[1]
  assert(boardThrough, 'bus reader committed no through= marker')
  assert(busMark.boardReadSeq === boardThrough, `boardReadSeq "${busMark.boardReadSeq}" != newest through marker "${boardThrough}"`)
  const inboxCursor = /inbox=([0-9A-HJKMNP-TV-Z]{26})/.exec(resultsFor(busSession, 'confluence_inbox')[0]?.text ?? '')?.[1]
  assert(inboxCursor, 'bus reader committed no inbox= marker')
  assert(busMark.inboxReadSeq === inboxCursor, `inboxReadSeq "${busMark.inboxReadSeq}" != inbox marker "${inboxCursor}"`)
  assert(isolationMark.boardReadSeq === null, `isolation session took no board tool but boardReadSeq is "${isolationMark.boardReadSeq}"`)
  assert(recallMark.boardReadSeq === null, `recall does not read the board but boardReadSeq is "${recallMark.boardReadSeq}"`)
})

// ── E2E-16: legacy workspace journal read-as-bus, never rewritten ─────
check('E2E-16', 'the seeded v0.1 workspace shard is read as bus history and stays byte-identical', () => {
  assert(legacySeed, `legacy seed metadata missing: ${args.legacySeed}`)
  assert(Array.isArray(legacySeed.files) && legacySeed.files.length >= 2, 'legacy seed has no file list')
  for (const seeded of legacySeed.files) {
    const file = join(args.run, seeded.path)
    assert(existsSync(file), `seeded legacy file disappeared: ${seeded.path}`)
    assert(sha256(file) === seeded.sha256, `legacy file was modified (hash mismatch): ${seeded.path}`)
  }
  assert(workspaceARecords.some((record) => record.title === LEGACY_TITLE), 'the legacy note was not read into the workspace bus view')
  assert(!globalRecords.some((record) => record.ws === workspaceAKey), 'a workspace record was migrated into the global journal')
})

// ── E2E-17: cross-workspace recall (unchanged) ────────────────────────
check('E2E-17', 'confluence_recall from workspace B finds a literal phrase spoken in a workspace-A session', () => {
  assert(recallSession, 'recall session log not found')
  assert(sameDir(recallSession.header?.cwd, args.workspaceB), `recall session ran in "${recallSession.header?.cwd}", expected workspace B`)
  const results = toolResults(recallSession.events)
  assert(results.length === 1, `expected one committed recall result, saw ${results.length}`)
  const result = results[0]
  assert(!result.isError, 'confluence_recall returned an error')
  const ref = /session:(?:session-)?([0-9a-f-]{36}):(\d+)/.exec(result.text)
  assert(ref, 'recall result carries no session:<id>:<seq> hit ref')
  const recalled = decoded.find((session) => session.sessionId === `session-${ref[1]}`)
  assert(recalled, 'the recalled session is not persisted in the scratch profile')
  assert(sameDir(recalled.header?.cwd, args.workspaceA), 'the recalled session did not run in workspace A')
  assert(new RegExp(RECALL_QUERY, 'i').test(result.text), 'recall excerpt does not contain the queried phrase')
  const call = toolCallRecords(recallSession.events).find((entry) => entry.name === 'confluence_recall')
  assert(call && call.input && call.input.query === RECALL_QUERY, 'confluence_recall was not called with the expected query')
})

// ── E2E-18: memory export call + portable document contract ───────────
check('E2E-18', 'confluence_memory export runs and renders the portable confluence.memory/v1 document handoff', () => {
  assert(memoryPromoteSession, 'memory promote/export session log not found')
  const exportCall = toolCallRecords(memoryPromoteSession.events).find(
    (call) => call.name === 'confluence_memory' && call.input && call.input.action === 'export',
  )
  assert(exportCall, 'M2 did not call confluence_memory action=export')
  const exportResults = resultsFor(memoryPromoteSession, 'confluence_memory')
  assert(exportResults.length === 2, `expected promote + export results, saw ${exportResults.length}`)
  const exportResult = exportResults[1]
  assert(exportResult && !exportResult.isError, 'memory export returned an error')
  assert(/Exported long-term memory as json/i.test(exportResult.text), 'export must render the json document size')
  assert(/exported\.text/i.test(exportResult.text), 'export must point at the structured exported.text (not the prompt)')
  const wire = mockM2.find((request) => requestToolResults(request).some((text) => /Exported long-term memory/i.test(text)))
  assert(wire, 'mock never saw the memory export result')
})

// ── E2E-19: cold-start activation ─────────────────────────────────────
check('E2E-19', 'cold start: the writer first request already offers the eight tools and the workspace pulse', () => {
  const firstTask = taskRequests(mockA)[0]
  assert(firstTask, 'no writer task request captured')
  const offered = Array.isArray(firstTask.tools) ? firstTask.tools.filter((name) => typeof name === 'string' && name.startsWith('confluence_')) : []
  assert(
    offered.length === NEW_TOOLS.length && NEW_TOOLS.every((name) => offered.includes(name)),
    `writer first request offered Confluence tools [${offered.join(', ')}]`,
  )
  // Use the committed pulse snapshot (the first request also carries the persona /
  // memory / style blocks, so a bare tag scan could match the wrong block).
  const pulses = pulseSnapshots(writerSession.events)
  assert(pulses.length >= 1, 'writer session log carries no committed pulse block')
  const pulseText = pulses[0].pulseText
  const header = pulseHeader(pulseText)
  assert(header, 'writer first request carries no pulse block')
  assert(header.attributes.scope === 'workspace', `writer pulse header lacks scope="workspace" (got ${JSON.stringify(header.attributes)})`)
  assert(/workspace-a/i.test(String(header.attributes.name ?? '')), `writer pulse name is "${header.attributes.name}", expected "workspace-a"`)
  const wire = JSON.stringify(firstTask)
  assert(wire.includes('<confluence-memory scope=\\"workspace\\"') || wire.includes('<confluence-memory scope="workspace"'), 'writer request wire lacks the workspace pulse tag')
})

/** True when `text` is within `max` code points. */
function bounded(text, max) {
  return Array.from(text).length <= max
}

const failed = checks.filter((entry) => !entry.ok)
process.stdout.write(`\nConfluence v0.4 E2E — ${checks.length - failed.length}/${checks.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
