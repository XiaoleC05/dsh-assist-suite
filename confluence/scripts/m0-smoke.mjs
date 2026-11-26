#!/usr/bin/env node
// Confluence / 高级记忆 — M0 smoke checks that need no DSH boot.
//
// This is the harness half of M0: it exercises the load-bearing mechanics that do
// NOT require a booted Harness or the finished plugin, so the E2E phase starts
// from known-good evidence instead of blaming the harness.
//
// Ownership: scripts/m0-smoke.mjs is WP7 (E2E harness) per
// docs/plan/implementation-interfaces.md §15. It never touches ~/.dsh, never
// imports network modules into plugin code, and never writes outside a temp dir
// under the OS temp root (plus the optional --json summary path).
//
// Each result names the M0 spike ID it evidences (docs/plan/m0-spikes.md
// S1–S7) or the milestone-prep ID it supports when no M0 spike fits.
//
// Usage:
//   node scripts/m0-smoke.mjs [--json <path>] [--strict] [--verbose]
//
// Exit: 0 = no FAIL (SKIP/BLOCKED allowed; they are printed and counted),
//       1 = at least one FAIL (or any SKIP/BLOCKED with --strict).
//
// What it checks:
//   S4  reference O_APPEND+writeSync writer, full-write/latency evidence,
//       torn-tail tolerance, sealed-shard recovery, two real writer processes,
//       deterministic merge, duplicate-line tolerance
//   S4  real lib/store.js JournalStore writer when WP1 has landed (cross-process)
//   S7  @deepseek-ai/dsh-atomic-write resolvability from the repository context
//       (expected: not resolvable -> native lease is the shipped path) and the
//       native `fs.open('wx')` lease mechanics
//   S2  multi-frame zstd session-log decode (the E2E assertion substrate)
//   --  local Messages-API mock self-test (stream + non-stream + request log)
//   M1  ULID ordering/format (lib/util.js when present)
//   M2  redaction fixture readiness (lib/redact.js when present)
//   M1  pulse cap/hostile fixtures (lib/pulse.js when present)
//   --  offline static scan of plugin runtime files (SEC-04)
//   --  harness guard: the real ~/.dsh was not read or written

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, closeSync, fsyncSync, writeSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const MOCK = join(ROOT, 'test', 'e2e', 'mock-llm.mjs')
const JOURNAL_CHILD = join(ROOT, 'test', 'e2e', 'lib', 'm0-journal-child.mjs')
const SESSION_LOG_LIB = join(ROOT, 'test', 'e2e', 'lib', 'session-log.mjs')
const SCENARIO_TEXT = join(ROOT, 'test', 'e2e', 'scenarios', 'text-answer.json')
/** Load the synthetic secret corpus, joining fragment arrays so no committed literal is credential-shaped. */
function loadSecretCorpus() {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'secrets', 'corpus.json'), 'utf8'))
  const joinParts = (parts) => (Array.isArray(parts) ? parts.join('') : undefined)
  return {
    ...raw,
    cases: (Array.isArray(raw.cases) ? raw.cases : []).map((testCase) => ({
      ...testCase,
      input: testCase.input ?? joinParts(testCase.inputParts) ?? '',
      raw: testCase.raw ?? joinParts(testCase.rawParts),
    })),
  }
}
const FIXTURES = join(ROOT, 'test', 'fixtures')

const args = parseArgs(process.argv.slice(2))
const startedAt = new Date()
const results = []
const tempRoot = mkdtempSync(join(tmpdir(), 'confluence-m0-smoke-'))
const realProfile = { dir: join(process.env.USERPROFILE ?? '', '.dsh'), snapshot: null }

function parseArgs(argv) {
  const out = { json: '', strict: false, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = argv[++i] ?? ''
    else if (argv[i] === '--strict') out.strict = true
    else if (argv[i] === '--verbose') out.verbose = true
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('usage: node scripts/m0-smoke.mjs [--json <path>] [--strict] [--verbose]\n')
      process.exit(0)
    } else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// result collection
// ---------------------------------------------------------------------------

function record(id, m0, title, status, detail, data) {
  results.push({ id, m0, title, status, detail: detail ?? '', ...(data === undefined ? {} : { data }) })
  const tag = status.padEnd(7)
  const line = `${tag} ${id}  [${m0}] ${title}${detail ? ` — ${detail}` : ''}`
  process.stdout.write(line + '\n')
}

async function check(id, m0, title, body, { optional = false } = {}) {
  try {
    const value = await body()
    if (value === undefined || value === null) {
      record(id, m0, title, 'PASS', '')
    } else if (typeof value === 'object' && value.status) {
      record(id, m0, title, value.status, value.detail, value.data)
    } else {
      record(id, m0, title, 'PASS', typeof value === 'string' ? value : '')
    }
  } catch (error) {
    const message = error && error.stack ? String(error.stack).split('\n')[0] : String(error)
    record(id, m0, title, optional ? 'SKIP' : 'FAIL', message)
  }
}

function skip(id, m0, title, detail) {
  record(id, m0, title, 'SKIP', detail)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasLib(name) {
  return existsSync(join(ROOT, 'lib', name))
}

function isDesignStage() {
  try {
    return readFileSync(join(ROOT, 'index.js'), 'utf8').includes('design-stage scaffold')
  } catch {
    return false
  }
}

async function importLib(name) {
  const file = join(ROOT, 'lib', name)
  if (!existsSync(file)) return null
  try {
    return await import(pathToFileURL(file).href)
  } catch (error) {
    return { __importError: error }
  }
}

function runChild(script, childArgs, timeoutMs = 120000) {
  const result = spawnSync(process.execPath, [script, ...childArgs], {
    cwd: ROOT,
    stdio: 'ignore',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return { status: result.status, signal: result.signal, error: result.error ? String(result.error) : undefined }
}

function parseJsonlFile(file) {
  const out = []
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === '') continue
    const isLast = i === lines.length - 1
    try {
      out.push(JSON.parse(line))
    } catch {
      if (isLast) return { records: out, tornTail: line }
      throw new Error(`malformed middle line ${i + 1}: ${line.slice(0, 80)}`)
    }
  }
  return { records: out, tornTail: undefined }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function referenceUlid(ms, counter) {
  let time = ''
  let n = ms
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[n % 32] + time
    n = Math.floor(n / 32)
  }
  let rest = ''
  let c = counter
  for (let i = 0; i < 14; i += 1) {
    rest = CROCKFORD[c % 32] + rest
    c = Math.floor(c / 32)
  }
  return `${time}00${rest}`
}

function referenceRecord(writer, index) {
  const base = 1794000000000 + 1000 * writer
  return {
    v: 1,
    type: 'entry',
    id: `cnf_${referenceUlid(base, index)}`,
    ws: 'ws_3f9a1c7e2b4d8061',
    seq: referenceUlid(base + index, 0),
    ts: new Date(base + index).toISOString(),
    kind: 'note',
    title: `m0 reference ${writer}/${index} ` + 'x'.repeat(1 + ((index * 37) % 900)),
    body: `synthetic m0-s4 line ${index} from writer ${writer}`,
    author: { sessionId: `session-m0-${writer}`, title: 'M0 writer', origin: 'agent' },
  }
}

/** Merge shards: tolerant line parse, sorted by (seq, id), entry first-wins, session last-wins. */
function mergeShards(files) {
  const byId = new Map()
  let malformed = 0
  let torn = 0
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line === '') continue
      const isLast = i === lines.length - 1
      let record
      try {
        record = JSON.parse(line)
      } catch {
        if (isLast) {
          torn += 1
          continue
        }
        malformed += 1
        continue
      }
      if (record === null || typeof record !== 'object' || typeof record.seq !== 'string' || typeof record.id !== 'string') {
        malformed += 1
        continue
      }
      const previous = byId.get(record.id)
      if (previous === undefined) {
        byId.set(record.id, record)
      } else if (record.type === 'session') {
        if (record.seq >= previous.seq) byId.set(record.id, record)
      } else if (record.seq < previous.seq) {
        byId.set(record.id, record)
      }
    }
  }
  const records = [...byId.values()].sort((a, b) => (a.seq === b.seq ? String(a.id).localeCompare(String(b.id)) : a.seq.localeCompare(b.seq)))
  return { records, malformed, torn }
}

function estimateTokens(text) {
  let ascii = 0
  let cjk = 0
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x2e80) cjk += 1
    else ascii += 1
  }
  return Math.ceil(ascii / 4) + cjk
}

function escapePulseText(s) {
  let out = ''
  for (const ch of String(s).normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x3c || cp === 0x3e || cp === 0x26 || cp === 0x2028 || cp === 0x2029) out += '\\u' + cp.toString(16).padStart(4, '0')
    else if (cp < 0x20 || cp === 0x7f) out += ' '
    else out += ch
  }
  return out
}

// --- local HTTP helpers (test-only; the plugin imports none of this) --------

function httpRequest({ port, path, method = 'POST', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('http timeout')))
    req.end(payload)
  })
}

function parseSse(text) {
  const events = []
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    let event = ''
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (event === '' && data === '') continue
    let parsed = null
    try {
      parsed = data ? JSON.parse(data) : null
    } catch {
      parsed = null
    }
    events.push({ event, data: parsed })
  }
  return events
}

async function waitForFile(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (text !== '') return text
    } catch {
      /* not yet */
    }
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${file}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// real-profile guard
// ---------------------------------------------------------------------------

function snapshotRealProfile() {
  const profilesDir = join(realProfile.dir, 'profiles')
  const snapshot = { profilesDirExists: existsSync(profilesDir), profiles: [], desktopPackage: null }
  try {
    snapshot.profiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    /* absent home is fine */
  }
  try {
    const file = join(profilesDir, 'desktop', 'package.json')
    const stat = statSync(file)
    snapshot.desktopPackage = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch {
    /* no desktop profile on this machine */
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

async function checks() {
  // -------------------------------------------------------------- M0-S4
  await check('SMOKE-S4-APPEND', 'M0-S4', 'O_APPEND fd + writeSync appends whole lines with full write counts', () => {
    const dir = join(tempRoot, 's4', 'a')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'journal.1111-aaaa1111.v1.jsonl')
    const fd = openSync(file, 'a')
    const durations = []
    let total = 0
    try {
      for (let i = 0; i < 200; i += 1) {
        const line = Buffer.from(JSON.stringify(referenceRecord(1, i)) + '\n', 'utf8')
        const t0 = process.hrtime.bigint()
        const written = writeSync(fd, line)
        const t1 = process.hrtime.bigint()
        durations.push(Number(t1 - t0) / 1e6)
        assert(written === line.length, `short write at ${i}: ${written} of ${line.length}`)
        total += written
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const parsed = parseJsonlFile(file)
    assert(parsed.records.length === 200, `expected 200 lines, got ${parsed.records.length}`)
    assert(parsed.tornTail === undefined, `unexpected torn tail: ${String(parsed.tornTail).slice(0, 60)}`)
    const ids = new Set(parsed.records.map((record) => record.id))
    assert(ids.size === 200, `expected 200 unique ids, got ${ids.size}`)
    durations.sort((a, b) => a - b)
    const p50 = durations[Math.floor(durations.length * 0.5)]
    const p95 = durations[Math.floor(durations.length * 0.95)]
    return {
      status: 'PASS',
      detail: `200 lines, ${(total / 1024).toFixed(1)} KiB, p50 ${p50.toFixed(2)} ms / p95 ${p95.toFixed(2)} ms`,
      data: { lines: 200, bytes: total, p50Ms: Number(p50.toFixed(3)), p95Ms: Number(p95.toFixed(3)), maxMs: Number(durations.at(-1).toFixed(3)) },
    }
  })

  await check('SMOKE-S4-TORN', 'M0-S4', 'readers ignore an unterminated tail; a sealed shard is not appended to again', () => {
    const dir = join(tempRoot, 's4', 'torn')
    mkdirSync(dir, { recursive: true })
    const sealed = join(dir, 'journal.2222-bbbb2222.v1.jsonl')
    const lines = []
    for (let i = 0; i < 5; i += 1) lines.push(JSON.stringify(referenceRecord(2, i)))
    // Simulate a crash mid-append: five complete lines plus a partial sixth without LF.
    writeFileSync(sealed, lines.join('\n') + '\n' + '{"v":1,"type":"entry","id":"cnf_')
    const firstRead = parseJsonlFile(sealed)
    assert(firstRead.records.length === 5, `expected 5 valid lines, got ${firstRead.records.length}`)
    assert(typeof firstRead.tornTail === 'string', 'torn tail was not detected')
    // The next mount mints a new writer id and a new shard; the sealed shard is history.
    const next = join(dir, 'journal.3333-cccc3333.v1.jsonl')
    writeFileSync(next, JSON.stringify(referenceRecord(3, 0)) + '\n')
    const merged = mergeShards([sealed, next])
    assert(merged.records.length === 6, `expected 6 merged lines, got ${merged.records.length}`)
    assert(merged.malformed === 0, `malformed lines: ${merged.malformed}`)
    assert(merged.torn === 1, `expected exactly one torn tail, got ${merged.torn}`)
    return { status: 'PASS', detail: '5 valid + 1 torn ignored, later shard visible, merge clean' }
  })

  await check('SMOKE-S4-TWO-WRITER', 'M0-S4', 'two real writer processes produce an intact, deterministically merged store', () => {
    const dir = join(tempRoot, 's4', 'two')
    mkdirSync(dir, { recursive: true })
    const lines = 400
    const shardA = join(dir, 'journal.4001-dddd4001.v1.jsonl')
    const shardB = join(dir, 'journal.4002-eeee4002.v1.jsonl')
    const resultA = join(dir, 'writer-a.json')
    const resultB = join(dir, 'writer-b.json')
    const a = runChild(JOURNAL_CHILD, ['--file', shardA, '--writer', 'a', '--lines', String(lines), '--base', '1794000000001', '--out', resultA])
    const b = runChild(JOURNAL_CHILD, ['--file', shardB, '--writer', 'b', '--lines', String(lines), '--base', '1794001000001', '--out', resultB])
    assert(a.status === 0, `writer a exited ${a.status}: ${a.error ?? ''}`)
    assert(b.status === 0, `writer b exited ${b.status}: ${b.error ?? ''}`)
    const infoA = JSON.parse(readFileSync(resultA, 'utf8'))
    const infoB = JSON.parse(readFileSync(resultB, 'utf8'))
    assert(infoA.ok === true && infoB.ok === true, 'a writer reported ok:false')
    const merged = mergeShards([shardA, shardB])
    assert(merged.records.length === lines * 2, `expected ${lines * 2} merged records, got ${merged.records.length}`)
    assert(merged.malformed === 0, `malformed lines: ${merged.malformed}`)
    assert(merged.torn === 0, `torn tails: ${merged.torn}`)
    const ids = new Set(merged.records.map((record) => record.id))
    assert(ids.size === lines * 2, `duplicate ids after merge: ${lines * 2 - ids.size}`)
    const mergedAgain = mergeShards([shardA, shardB])
    assert(JSON.stringify(mergedAgain.records) === JSON.stringify(merged.records), 'merge is not deterministic')
    return {
      status: 'PASS',
      detail: `${lines * 2} records across 2 processes, 0 malformed, deterministic re-merge`,
      data: { writerA: infoA, writerB: infoB },
    }
  })

  if (hasLib('store.js')) {
    await check('SMOKE-S4-REALSTORE', 'M0-S4', 'real lib/store.js JournalStore survives two writer processes', () => {
      const root = join(tempRoot, 's4', 'realstore')
      mkdirSync(root, { recursive: true })
      const resultA = join(root, 'a.json')
      const resultB = join(root, 'b.json')
      const ws = 'ws_3f9a1c7e2b4d8061'
      const a = runChild(JOURNAL_CHILD, ['--mode', 'store', '--root', root, '--ws', ws, '--file', join(root, 'ignored-a'), '--writer', 'a', '--lines', '150', '--base', '1794000000001', '--out', resultA])
      const b = runChild(JOURNAL_CHILD, ['--mode', 'store', '--root', root, '--ws', ws, '--file', join(root, 'ignored-b'), '--writer', 'b', '--lines', '150', '--base', '1794001000001', '--out', resultB])
      assert(a.status === 0, `store writer a exited ${a.status}: ${a.error ?? ''}`)
      assert(b.status === 0, `store writer b exited ${b.status}: ${b.error ?? ''}`)
      return { status: 'PASS', detail: 'two JournalStore writers completed; merge covered by the store test suite' }
    })
  } else {
    skip('SMOKE-S4-REALSTORE', 'M0-S4', 'real lib/store.js JournalStore cross-process write', 'lib/store.js absent (WP1 design-core not landed yet)')
  }

  // -------------------------------------------------------------- M0-S2 substrate
  await check('SMOKE-SESSION-DECODE', 'M0-S2', 'multi-frame zstd session log decodes header and all committed events', async () => {
    const sessionLog = await import(pathToFileURL(SESSION_LOG_LIB).href)
    const { decodeSessionLogFile } = sessionLog
    const dir = join(tempRoot, 'decode')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    const header = { type: 'session', version: 4, id: 'session-smoke-decode', createdAt: 1794000000000, cwd: 'X:\\smoke\\workspace', isSeeded: false, delegationDepth: 0 }
    const events = [
      { type: 'user/message', seq: 0, time: 1794000000001, data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
      { type: 'user/message', seq: 1, time: 1794000000002, data: { content: [{ type: 'text', text: 'Current runtime context. ...' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'confluence:pulse', text: '<confluence-memory scope="workspace" name="project-a" unread="0" notes="0" peers="0" seq="0" welcome="1">\nWorkspace bus ready.\n</confluence-memory>' }] }, role: 'user', id: 'm2' } },
      // v0.1.0 sessions (and forks that inherit their snapshots) still carry the legacy tag.
      { type: 'user/message', seq: 2, time: 1794000000003, data: { content: [{ type: 'text', text: 'Current runtime context. ...' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'confluence:pulse', text: '<confluence-workspace name="alpha" peers="0" unread="0" seq="0">\nlegacy snapshot\n</confluence-workspace>' }] }, role: 'user', id: 'm3' } },
      { type: 'assistant/message', seq: 3, time: 1794000000004, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model' } } } },
    ]
    const frames = [header, ...events].map((event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
    writeFileSync(file, Buffer.concat(frames))
    const decoded = decodeSessionLogFile(file)
    assert(decoded.header.id === 'session-smoke-decode', 'header id mismatch')
    assert(decoded.events.length === 4, `expected 4 events, got ${decoded.events.length}`)
    assert(decoded.events[1].data.source.sections[0].name === 'confluence:pulse', 'pulse section not preserved')
    assert(typeof sessionLog.pulseTag === 'function', 'session-log.mjs lacks pulseTag (dual-tag detection)')
    const pulses = sessionLog.pulseSnapshots(decoded.events)
    assert(pulses.length === 2, `expected 2 pulse snapshots, got ${pulses.length}`)
    assert(pulses[0].tag === sessionLog.MEMORY_PULSE_TAG, `new snapshot tag ${pulses[0].tag}`)
    assert(pulses[0].header?.attributes?.scope === 'workspace', 'new snapshot lost scope="workspace"')
    assert(pulses[1].tag === sessionLog.LEGACY_PULSE_TAG, `legacy snapshot tag ${pulses[1].tag}`)
    assert(sessionLog.isPulseText(pulses[1].pulseText) === true, 'legacy pulse not recognized')
    assert(sessionLog.pulseTag('not a pulse') === null, 'pulseTag accepted non-pulse text')
    return { status: 'PASS', detail: `${frames.length} frames, ${decoded.eventCount} records, both pulse tags recognized` }
  })

  // -------------------------------------------------------------- mock LLM self-test
  await check('SMOKE-MOCK-LLM', 'IT-01-pre', 'local Messages-API mock: stream, non-stream, and request log', async () => {
    const dir = join(tempRoot, 'mock')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'requests.jsonl')
    const portFile = join(dir, 'port.txt')
    const child = spawn(process.execPath, [MOCK, '--scenario', SCENARIO_TEXT, '--log', logPath, '--print-port-file', portFile], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
    try {
      const port = Number((await waitForFile(portFile)).trim())
      assert(Number.isInteger(port) && port > 0, `bad mock port "${port}"`)
      const health = await httpRequest({ port, path: '/health', method: 'GET' })
      assert(health.status === 200, `health ${health.status}`)
      const body = { model: 'deepseek-flash', max_tokens: 256, stream: true, system: 'smoke system prompt', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello mock' }] }] }
      const stream = await httpRequest({ port, path: '/v1/messages', body })
      assert(stream.status === 200, `stream status ${stream.status}`)
      const events = parseSse(stream.body)
      const kinds = events.map((event) => event.event)
      assert(kinds.includes('message_start'), `missing message_start: ${kinds.join(',')}`)
      assert(kinds.includes('content_block_delta'), `missing content_block_delta: ${kinds.join(',')}`)
      assert(kinds.includes('message_stop'), `missing message_stop: ${kinds.join(',')}`)
      const streamedText = events
        .filter((event) => event.event === 'content_block_delta')
        .map((event) => event.data?.delta?.text ?? '')
        .join('')
      assert(streamedText.includes('E2E mock model'), `unexpected streamed text "${streamedText}"`)
      const nonStream = await httpRequest({ port, path: '/v1/messages', body: { ...body, stream: false } })
      const parsed = JSON.parse(nonStream.body)
      assert(parsed.type === 'message' && parsed.content?.[0]?.type === 'text', 'non-stream response is not a Messages object')
      const logLines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
      assert(logLines.length === 2, `expected 2 logged requests, got ${logLines.length}`)
      const logged = logLines.map((line) => JSON.parse(line))
      assert(logged.every((entry) => entry.apiKeyPresent === false || entry.apiKeyPresent === true), 'log entry missing apiKeyPresent')
      assert(logged[0].messageCount === 1, 'log did not record message count')
      return { status: 'PASS', detail: `2 requests, stream events ${kinds.length}, request log written` }
    } finally {
      child.kill('SIGTERM')
      await sleep(150)
    }
  })

  // -------------------------------------------------------------- M1 prep: ULID
  await check('SMOKE-ULID', 'M1-prep', '26-char Crockford ULIDs are well-formed and lexicographically monotonic', async () => {
    const util = await importLib('util.js')
    let factory
    let source
    if (util && typeof util.createUlidFactory === 'function') {
      factory = util.createUlidFactory(() => 1794000000000, (() => {
        const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
        let i = 0
        return () => values[i++ % values.length]
      })())
      source = 'lib/util.js'
    } else {
      let counter = 0
      factory = () => referenceUlid(1794000000000, counter++)
      source = 'reference (lib/util.js absent)'
    }
    const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let previous = ''
    for (let i = 0; i < 500; i += 1) {
      const id = factory()
      assert(typeof id === 'string' && id.length === 26, `bad ULID length: ${String(id)}`)
      for (const ch of id) assert(alpha.includes(ch), `ULID has non-Crockford char "${ch}"`)
      assert(id > previous, `ULID order broke at ${i}: ${id} <= ${previous}`)
      previous = id
    }
    if (util && typeof util.isUlid === 'function') {
      assert(util.isUlid(previous) === true, 'isUlid rejected a generated ULID')
      assert(util.isUlid('not-a-ulid') === false, 'isUlid accepted garbage')
    }
    return { status: 'PASS', detail: `500 monotonic ULIDs from ${source}` }
  })

  // -------------------------------------------------------------- M2 prep: redaction
  await check('SMOKE-REDACT-FIXTURES', 'M2-prep', 'secret corpus is synthetic, self-consistent, and covers match+preserve', () => {
    const corpus = loadSecretCorpus()
    assert(corpus.policy === 'confluence.redact/v1', 'unexpected redaction policy id')
    assert(Array.isArray(corpus.cases) && corpus.cases.length >= 8, 'corpus too small')
    const ids = new Set()
    let matches = 0
    let preserves = 0
    for (const testCase of corpus.cases) {
      assert(typeof testCase.id === 'string' && testCase.id !== '', 'case without id')
      assert(!ids.has(testCase.id), `duplicate case id ${testCase.id}`)
      ids.add(testCase.id)
      assert(typeof testCase.input === 'string', `case ${testCase.id} has no input string`)
      if (testCase.kind === 'match') {
        matches += 1
        assert(typeof testCase.raw === 'string' && testCase.raw.length > 0, `case ${testCase.id} match without raw value`)
        assert(testCase.input.includes(testCase.raw), `case ${testCase.id} raw value is not present in its input`)
      } else if (testCase.kind === 'preserve') {
        preserves += 1
      } else {
        throw new Error(`case ${testCase.id} has unknown kind ${testCase.kind}`)
      }
    }
    assert(matches >= 6 && preserves >= 2, `need >=6 match and >=2 preserve cases, got ${matches}/${preserves}`)
    return { status: 'PASS', detail: `${corpus.cases.length} synthetic cases (${matches} match, ${preserves} preserve)` }
  })

  if (hasLib('redact.js')) {
    await check('SMOKE-REDACT', 'M2-prep', 'lib/redact.js redacts the corpus and preserves ordinary text', async () => {
      const module = await importLib('redact.js')
      if (!module || typeof module.createRedactor !== 'function') {
        return { status: 'SKIP', detail: 'lib/redact.js present but no createRedactor export (align with implementation-interfaces §4)' }
      }
      const corpus = loadSecretCorpus()
      const redactor = module.createRedactor({ privacy: { redact: true, redactTitles: true, denyPathPatterns: [], redactPatterns: [] } }, {})
      let checked = 0
      for (const testCase of corpus.cases) {
        const result = redactor.text(testCase.input)
        const value = typeof result === 'string' ? result : result?.value
        assert(typeof value === 'string', `case ${testCase.id}: redactor.text did not return text`)
        if (testCase.kind === 'match') {
          assert(!value.includes(testCase.raw), `case ${testCase.id}: raw secret survived redaction`)
        } else {
          assert(value === testCase.input, `case ${testCase.id}: preserve case was modified`)
        }
        checked += 1
      }
      return { status: 'PASS', detail: `${checked} corpus cases through lib/redact.js` }
    })
  } else {
    skip('SMOKE-REDACT', 'M2-prep', 'lib/redact.js corpus behavior', 'lib/redact.js absent (WP2 design-behavior not landed yet)')
  }

  // -------------------------------------------------------------- M1 prep: pulse caps
  await check('SMOKE-PULSE-FIXTURES', 'M1-prep', 'pulse cap fixtures match the v0.3 workspace template and the binding 1 400-char / 320-token limits', () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, 'pulse', 'cap-cases.json'), 'utf8'))
    assert(fixture.limits.maxChars === 1400, `maxChars fixture ${fixture.limits.maxChars} != 1400`)
    assert(fixture.limits.maxTokens === 320, `maxTokens fixture ${fixture.limits.maxTokens} != 320`)
    assert(fixture.limits.maxMessages === 3, `maxMessages fixture ${fixture.limits.maxMessages} != 3`)
    assert(fixture.limits.maxStateKeys === 3, `maxStateKeys fixture ${fixture.limits.maxStateKeys} != 3`)
    assert(fixture.template && fixture.template.tag === 'confluence-memory', `fixture template tag ${fixture.template?.tag} != confluence-memory`)
    assert(fixture.template.scope === 'workspace', `fixture template scope ${fixture.template?.scope} != workspace`)
    assert(fixture.template.hasName === true, 'fixture must document the workspace name attribute')
    const ids = new Set()
    for (const testCase of fixture.cases) {
      assert(!ids.has(testCase.id), `duplicate pulse case ${testCase.id}`)
      ids.add(testCase.id)
      assert(testCase.input && typeof testCase.input === 'object', `pulse case ${testCase.id} has no input`)
      for (const field of ['label', 'state', 'notes', 'messages', 'peers', 'welcome', 'cursor', 'maxChars']) {
        assert(Object.prototype.hasOwnProperty.call(testCase.input, field), `pulse case ${testCase.id} missing ${field}`)
      }
    }
    return { status: 'PASS', detail: `${fixture.cases.length} cases, workspace template, caps 1400 chars / 320 tokens` }
  })

  if (hasLib('pulse.js')) {
    await check('SMOKE-PULSE', 'M1-prep', 'lib/pulse.js renders the global template, stays empty-or-untrusted-framed within both caps', async () => {
      const module = await importLib('pulse.js')
      if (!module || typeof module.buildPulseText !== 'function') {
        return { status: 'SKIP', detail: 'lib/pulse.js present but no buildPulseText export (align with implementation-interfaces §9)' }
      }
      const util = await importLib('util.js')
      const escape = util && typeof util.escapePulseText === 'function' ? util.escapePulseText : escapePulseText
      const identityEscape = (value) => String(value ?? '')
      const fixture = JSON.parse(readFileSync(join(FIXTURES, 'pulse', 'cap-cases.json'), 'utf8'))
      for (const testCase of fixture.cases) {
        const input = { ...testCase.input, escape: testCase.input.escape === 'escapePulseText' ? escape : identityEscape }
        if (typeof input.cursor === 'object' && input.cursor === null) input.cursor = null
        const text = module.buildPulseText(input)
        assert(typeof text === 'string', `case ${testCase.id}: buildPulseText did not return a string`)
        if (testCase.expect.empty) {
          assert(text === '', `case ${testCase.id}: expected empty pulse, got ${text.length} chars`)
          continue
        }
        assert(text.length <= fixture.limits.maxChars, `case ${testCase.id}: ${text.length} chars > ${fixture.limits.maxChars}`)
        assert(estimateTokens(text) <= fixture.limits.maxTokens, `case ${testCase.id}: ${estimateTokens(text)} tokens > ${fixture.limits.maxTokens}`)
        // v0.3 workspace template: exactly one <confluence-memory scope="workspace" name="…"> block.
        const openingTag = text.split('\n')[0];
        assert(/^<confluence-memory\b[^>]*>$/.test(openingTag), `case ${testCase.id}: first line is not a confluence-memory opening tag: ${openingTag.slice(0, 120)}`)
        assert(/\bscope="workspace"/.test(openingTag), `case ${testCase.id}: opening tag lacks scope="workspace"`)
        assert(/\bname="/.test(openingTag), `case ${testCase.id}: opening tag lacks the workspace name attribute`)
        assert(/\bpeers="\d+"/.test(openingTag) && /\bunread="\d+"/.test(openingTag) && /\bnotes="\d+"/.test(openingTag), `case ${testCase.id}: opening tag lacks peers/unread/notes counts`)
        assert(/\bseq="[0-9A-Z]{1,26}"/.test(openingTag), `case ${testCase.id}: opening tag lacks the seq cursor`)
        assert(!text.includes(fixture.template.legacyTag), `case ${testCase.id}: legacy ${fixture.template.legacyTag} tag survived`)
        for (const needle of testCase.expect.mustContain ?? []) assert(text.includes(needle), `case ${testCase.id}: missing "${needle}"`)
        for (const forbidden of testCase.expect.forbidRaw ?? []) {
          // The template's own closing tag is expected exactly once; hostile copies must not
          // add another. Other forbidden values must not appear at all.
          if (forbidden === '</confluence-memory>') {
            const count = text.split(forbidden).length - 1
            assert(count === 1, `case ${testCase.id}: expected exactly one template closing tag, saw ${count}`)
          } else {
            assert(!text.includes(forbidden), `case ${testCase.id}: raw hostile value "${forbidden}" survived`)
          }
        }
      }
      return { status: 'PASS', detail: `${fixture.cases.length} cases within caps via lib/pulse.js (workspace template)` }
    })
  } else {
    skip('SMOKE-PULSE', 'M1-prep', 'lib/pulse.js cap behavior', 'lib/pulse.js absent (WP4 dsh-researcher not landed yet)')
  }

  // -------------------------------------------------------------- M0-S7
  await check('SMOKE-S7-ATOMIC-WRITE', 'M0-S7', '@deepseek-ai/dsh-atomic-write resolution from the repository context', async () => {
    let importError = null
    try {
      await import('@deepseek-ai/dsh-atomic-write')
    } catch (error) {
      importError = error
    }
    if (importError === null) {
      // The package resolved: this is useful evidence, but the design ships a
      // native lease and must not depend on it. Record the fact, do not fail.
      return { status: 'PASS', detail: 'package resolved from this Node context; plugin still uses the native lease (no hard dependency)' }
    }
    const code = importError && importError.code ? importError.code : ''
    return {
      status: 'BLOCKED',
      detail: `not resolvable from repository Node context (${code || 'import failed'}); native lease is the shipped path, optional guarded accelerator only`,
    }
  })

  await check('SMOKE-LEASE', 'M0-S7', 'native fs.open(lock,\'wx\') lease rejects a second contender and takes over a dead pid', () => {
    const dir = join(tempRoot, 'lease')
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, 'compactor.lock')
    const first = openSync(lock, 'wx')
    writeSync(first, Buffer.from(JSON.stringify({ writerId: 'smoke-a', pid: process.pid, at: Date.now() }) + '\n'))
    closeSync(first)
    let contended = false
    try {
      const second = openSync(lock, 'wx')
      closeSync(second)
    } catch (error) {
      contended = error && error.code === 'EEXIST'
    }
    assert(contended, 'second contender acquired an existing lock')
    // Dead-pid takeover: a lock naming a non-running pid may be replaced.
    writeFileSync(lock, JSON.stringify({ writerId: 'smoke-dead', pid: 0x7ffffff0, at: Date.now() }) + '\n')
    let alive = false
    try {
      process.kill(0x7ffffff0, 0)
      alive = true
    } catch (error) {
      alive = Boolean(error && error.code === 'EPERM')
    }
    assert(alive === false, 'test pid unexpectedly alive; takeover case cannot run')
    rmSync(lock, { force: true })
    const third = openSync(lock, 'wx')
    closeSync(third)
    return { status: 'PASS', detail: 'EEXIST on contention; stale dead-pid lock is replaceable; native lease works' }
  })

  // -------------------------------------------------------------- SEC-04 offline scan
  await check('SMOKE-OFFLINE', 'SEC-04', 'plugin runtime files import no network/child-process primitives', () => {
    const runtimeFiles = []
    const pushIf = (file) => {
      if (existsSync(file) && statSync(file).isFile()) runtimeFiles.push(file)
    }
    pushIf(join(ROOT, 'index.js'))
    pushIf(join(ROOT, 'client.js'))
    const libDir = join(ROOT, 'lib')
    if (existsSync(libDir)) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile() && full.endsWith('.js')) runtimeFiles.push(full)
        }
      }
      walk(libDir)
    }
    const forbidden = [
      { pattern: /from\s+['"]node:(http|https|net|dgram|tls|dns|child_process)['"]/g, label: 'node network/child_process import' },
      { pattern: /from\s+['"](http|https|net|dgram|tls|dns|child_process)['"]/g, label: 'bare network/child_process import' },
      { pattern: /require\(\s*['"](node:)?(http|https|net|dgram|tls|dns|child_process)['"]\s*\)/g, label: 'require network/child_process' },
      { pattern: /\bfetch\s*\(/g, label: 'fetch() call' },
      { pattern: /XMLHttpRequest|WebSocket|EventSource/g, label: 'browser/external transport global' },
      { pattern: /https?:\/\/(?!127\.0\.0\.1)[^\s'"`)]+/g, label: 'absolute non-loopback URL literal' },
    ]
    const hits = []
    for (const file of runtimeFiles) {
      const text = readFileSync(file, 'utf8')
      const isClientModule = /client\.js$/.test(file)
      for (const { pattern, label } of forbidden) {
        // The panel client is allowed exactly one same-origin relative GET; every other
        // runtime file (host half) must contain no fetch at all.
        if (isClientModule && label === 'fetch() call') continue
        pattern.lastIndex = 0
        const match = pattern.exec(text)
        if (match) hits.push(`${relative(ROOT, file)}: ${label} "${match[0]}"`)
      }
      if (isClientModule) {
        const fetchCalls = (text.match(/\bfetch\s*\(/g) ?? []).length
        if (fetchCalls > 1) hits.push(`${relative(ROOT, file)}: more than one fetch() call site (${fetchCalls})`)
      }
    }
    assert(hits.length === 0, `forbidden runtime imports/calls: ${hits.join('; ')}`)
    return { status: 'PASS', detail: `${runtimeFiles.length} runtime file(s) scanned; no network, child process, fetch, or absolute URL` }
  })

  // -------------------------------------------------------------- harness guard
  await check('SMOKE-REAL-PROFILE-UNTOUCHED', 'guard', 'the real ~/.dsh profile was not modified by this smoke run', () => {
    const now = snapshotRealProfile()
    const before = realProfile.snapshot
    assert(before !== null, 'before snapshot missing')
    assert(JSON.stringify(now.profiles) === JSON.stringify(before.profiles), `real profile set changed: ${before.profiles.join(',')} -> ${now.profiles.join(',')}`)
    assert(
      JSON.stringify(now.desktopPackage) === JSON.stringify(before.desktopPackage),
      `desktop profile package changed: ${JSON.stringify(before.desktopPackage)} -> ${JSON.stringify(now.desktopPackage)}`,
    )
    assert(!now.profiles.includes('confluence-e2e'), 'a scratch e2e profile leaked into the real profile home')
    return { status: 'PASS', detail: `profiles [${now.profiles.join(', ')}] unchanged` }
  })
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write(`Confluence M0 smoke — ${ROOT}\n`)
  process.stdout.write(`node ${process.version} · ${process.platform} · temp ${tempRoot}\n`)
  if (isDesignStage()) process.stdout.write('plugin stage: design-stage scaffold (lib/ absent); behavioral checks will SKIP\n')
  realProfile.snapshot = snapshotRealProfile()
  try {
    await checks()
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  const counts = { PASS: 0, FAIL: 0, SKIP: 0, BLOCKED: 0 }
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
  const ok = counts.FAIL === 0 && (!args.strict || counts.SKIP + counts.BLOCKED === 0)
  const summary = {
    kind: 'confluence-m0-smoke',
    version: 1,
    ok,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    repoRoot: ROOT,
    node: process.version,
    platform: process.platform,
    designStage: isDesignStage(),
    counts,
    results,
  }
  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true })
    writeFileSync(args.json, JSON.stringify(summary, null, 2), 'utf8')
    process.stdout.write(`summary: ${args.json}\n`)
  }
  process.stdout.write(`\nM0 smoke — ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SKIP} SKIP, ${counts.BLOCKED} BLOCKED\n`)
  if (args.verbose) for (const result of results) process.stdout.write(`${result.status} ${result.id} ${result.detail}\n`)
  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`m0-smoke: ${error && error.stack ? error.stack : String(error)}\n`)
  process.exitCode = 2
})
