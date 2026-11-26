#!/usr/bin/env node
// Confluence / 高级记忆 — test-harness child writer for M0-S4 concurrency evidence.
//
// The PLUGIN never spawns processes; only the harness does. This helper writes
// one shard from one process using the normative primitive from ADR-0001 E10:
// a held `O_APPEND` fd plus a single `fs.writeSync` per LF-terminated line,
// with the returned byte count asserted. When `lib/store.js` exists, `--mode
// store` exercises the real JournalStore writer instead of the reference one.
//
// Output: one JSON result file (no stdio pipes, so the harness also works under
// a sandboxed parent that forbids pipe capture).
//
// CLI:
//   node test/e2e/lib/m0-journal-child.mjs --file <shard> --writer <id>
//        --lines <n> [--min-bytes 64] [--max-bytes 1024] [--out <result.json>]
//        [--mode append|store] [--ws <wsKey>]

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const out = { file: '', writer: 'w', lines: 100, minBytes: 64, maxBytes: 1024, out: '', mode: 'append', ws: 'ws_3f9a1c7e2b4d8061', root: '', base: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`)
      i += 1
      return argv[i]
    }
    if (arg === '--file') out.file = next()
    else if (arg === '--writer') out.writer = next()
    else if (arg === '--lines') out.lines = Number(next())
    else if (arg === '--min-bytes') out.minBytes = Number(next())
    else if (arg === '--max-bytes') out.maxBytes = Number(next())
    else if (arg === '--out') out.out = next()
    else if (arg === '--mode') out.mode = next()
    else if (arg === '--ws') out.ws = next()
    else if (arg === '--root') out.root = next()
    else if (arg === '--base') out.base = Number(next())
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.file) throw new Error('--file is required')
  if (!Number.isInteger(out.lines) || out.lines < 1) throw new Error('--lines must be a positive integer')
  if (out.mode === 'store' && !out.root) throw new Error('--root is required in store mode')
  return out
}

/** Stable per-writer base so two writers never mint identical ids. */
function writerBase(args) {
  if (Number.isFinite(args.base) && args.base > 0) return args.base
  let hash = 0
  for (const ch of String(args.writer)) hash = (hash * 31 + ch.codePointAt(0)) % 0x7fffffff
  return 1794000000000 + (hash % 1000) * 1000000
}

// Deterministic ULID-shaped seq: timestamp prefix + per-process counter keeps
// lexicographic order within one writer. Cross-writer order is not asserted by
// the fixture; the merge sorts by the full seq string.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulidAt(ms, counter) {
  let time = ''
  let n = ms
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[n % 32] + time
    n = Math.floor(n / 32)
  }
  let rest = ''
  let c = counter
  for (let i = 0; i < 16; i += 1) {
    rest = CROCKFORD[c % 32] + rest
    c = Math.floor(c / 32)
  }
  return time + rest
}

function padToBytes(text, minBytes, maxBytes, marker) {
  let body = text
  const target = minBytes + (body.length % Math.max(1, maxBytes - minBytes))
  while (Buffer.byteLength(body, 'utf8') < target) body += 'x'
  return `${body} ${marker}`
}

async function writeReference(args) {
  mkdirSync(dirname(args.file), { recursive: true })
  const fd = openSync(args.file, 'a')
  const base = writerBase(args)
  let bytesWritten = 0
  const durations = []
  try {
    for (let i = 0; i < args.lines; i += 1) {
      const record = {
        v: 1,
        type: 'entry',
        id: `cnf_${ulidAt(base, i)}`,
        ws: args.ws,
        seq: ulidAt(base + i, 0),
        ts: new Date(base + i).toISOString(),
        kind: 'note',
        title: padToBytes(`shard ${args.writer} line ${i}`, args.minBytes, args.maxBytes, args.writer),
        body: `synthetic m0-s4 writer line ${i} from ${args.writer}`,
        author: { sessionId: `session-m0-${args.writer}`, title: 'M0 writer', origin: 'agent' },
      }
      const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8')
      const t0 = process.hrtime.bigint()
      const written = writeSync(fd, line)
      const t1 = process.hrtime.bigint()
      durations.push(Number(t1 - t0) / 1e6)
      if (written !== line.length) throw new Error(`short write: ${written} of ${line.length}`)
      bytesWritten += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  durations.sort((a, b) => a - b)
  return {
    mode: 'append',
    file: args.file,
    writer: args.writer,
    lines: args.lines,
    bytesWritten,
    p50Ms: Number((durations[Math.floor(durations.length * 0.5)] ?? 0).toFixed(3)),
    p95Ms: Number((durations[Math.floor(durations.length * 0.95)] ?? 0).toFixed(3)),
    maxMs: Number((durations.at(-1) ?? 0).toFixed(3)),
  }
}

async function writeRealStore(args) {
  const storeModuleUrl = pathToFileURL(join(process.cwd(), 'lib', 'store.js')).href
  const module = await import(storeModuleUrl)
  if (typeof module.JournalStore !== 'function') throw new Error('lib/store.js has no JournalStore export')
  const root = args.root
  const store = await new module.JournalStore({
    config: { store: { dir: root, pollMs: 4000, watch: false } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }).init()
  const journal = await store.openWorkspace(args.ws, { canonicalPath: process.cwd(), createdAt: new Date().toISOString() })
  const base = writerBase(args)
  for (let i = 0; i < args.lines; i += 1) {
    await journal.append({
      v: 1,
      type: 'entry',
      id: `cnf_${ulidAt(base, i)}`,
      ws: args.ws,
      kind: 'note',
      title: `store ${args.writer} line ${i}`,
      body: `synthetic m0-s4 JournalStore line ${i} from ${args.writer}`,
      author: { sessionId: `session-m0-${args.writer}`, title: 'M0 writer', origin: 'agent' },
    })
  }
  await journal.flush?.()
  await store.close?.()
  return { mode: 'store', writer: args.writer, lines: args.lines }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const started = Date.now()
  let result
  try {
    result = args.mode === 'store' ? await writeRealStore(args) : await writeReference(args)
    result.ok = true
  } catch (error) {
    result = { ok: false, mode: args.mode, error: error && error.stack ? error.stack : String(error) }
    if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8')
    process.exitCode = 1
    return
  }
  result.elapsedMs = Date.now() - started
  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8')
}

main().catch((error) => {
  process.stderr.write(`m0-journal-child: ${error && error.stack ? error.stack : String(error)}\n`)
  process.exit(1)
})
