#!/usr/bin/env node
// Confluence / 高级记忆 — offline universal-memory export CLI (`confluence.memories/v1`).
//
//   node scripts/export-memories.mjs --dsh-home <dir> [--out <dir>] [--json] [--dry-run]
//
// Reads the profile's merged universal memory (global journal + read-only legacy journals) from a
// scratch or real DSH_HOME (read-only), writes the deterministic, redacted `memories.v1.jsonl` +
// `manifest.json` pair outside the store, and prints a short summary. This is the only supported
// way a later `solo-bench` phase learns about Confluence memory: the export is a snapshot, never a
// live channel (ADR 0006, ADR-0007 §2.7).
//
// The CLI is deliberately explicit about --dsh-home: it never falls back to the real ~/.dsh, so a
// verification run can only touch the store it names. The default output is
// `<dshHome>/storages/confluence-exports/<UTC-stamp>/`; `--out` may override it (a rooted or
// cwd-relative directory; literal ".." segments and any directory inside the store are refused).
// There is no workspace selector: memory is universal.
//
// Exit codes: 0 success; 1 runtime failure (missing store, unsupported store generation, unsafe
// path, IO); 2 usage error. No network, no dependency, no child process. Hermetic tests call the
// exported run().

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JournalStore } from '../lib/store.js'
import { createRedactor } from '../lib/redact.js'
import { resolveConfig } from '../lib/config.js'
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_FILE,
  EXPORT_SCHEMA,
  MEMORIES_FILE,
  exportMemories,
} from '../lib/export.js'

export const USAGE = `Usage: node scripts/export-memories.mjs --dsh-home <dir> [options]

Export the profile's universal Confluence memory as the offline confluence.memories/v1 pair
(memories.v1.jsonl + manifest.json). Every session on this machine shares one memory space, so
there is no workspace selector. The store is only read; the export is written outside it and
never read back.

Required:
  --dsh-home <dir>      DSH_HOME that contains storages/confluence/v1 (scratch homes are fine;
                        the real ~/.dsh is never assumed)

Options:
  --out <dir>           export directory (absolute or relative to the current directory).
                        Default: <dsh-home>/storages/confluence-exports/<UTC-stamp>/
  --json                print one JSON summary object to stdout instead of the human summary
  --dry-run             compute and validate, print the summary, write nothing
  -h, --help            show this help

Examples:
  node scripts/export-memories.mjs --dsh-home .tmp/e2e/run-20261116-120000/dsh-home --json
  node scripts/export-memories.mjs --dsh-home "$env:DSH_HOME" --dry-run
`

/** @param {string} message */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'USAGE'
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/**
 * UTC export-directory stamp, e.g. `20261116T120143Z` (filesystem-safe, sortable, no host zone).
 * @param {number} ms epoch milliseconds
 * @returns {string}
 */
export function utcStamp(ms) {
  const date = new Date(Number(ms))
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/**
 * Default output directory for one run.
 * @param {string} dshHome absolute DSH_HOME
 * @param {number} ms epoch milliseconds (UTC stamp)
 * @returns {string}
 */
export function defaultExportDir(dshHome, ms) {
  return path.join(path.resolve(dshHome), 'storages', 'confluence-exports', utcStamp(ms))
}

/**
 * Parse argv (without the node/script entries). There is intentionally no `--workspace`.
 * @param {readonly string[]} argv
 * @returns {{dshHome: string, out: string, json: boolean, dryRun: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const parsed = { dshHome: '', out: '', json: false, dryRun: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    /** @returns {string} */
    const next = () => {
      if (index + 1 >= argv.length) throw new UsageError(`${arg} requires a value`)
      index += 1
      return argv[index]
    }
    if (arg === '--dsh-home') parsed.dshHome = next()
    else if (arg === '--out') parsed.out = next()
    else if (arg === '--json') parsed.json = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new UsageError(`unknown argument: ${arg}`)
  }
  if (parsed.help) return parsed
  if (parsed.dshHome.trim() === '') throw new UsageError('--dsh-home is required (the store is never guessed)')
  return parsed
}

/**
 * Resolve `--out`: absolute paths are kept, relative paths resolve against the current directory.
 * Literal ".." segments and empty values are usage errors; store containment is checked later by
 * `validateExportDir()`.
 * @param {string} value
 * @returns {string} absolute directory
 */
export function validateOutArg(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError('--out must be a non-empty directory')
  }
  const raw = value.trim()
  if (raw.split(/[\\/]+/).includes('..')) {
    throw new UsageError(`--out must not contain "..": ${raw}`)
  }
  return path.resolve(raw)
}

/**
 * Run the CLI. Exported for hermetic tests (no child process needed): inject stdout/stderr
 * collectors, a clock, and a store factory; everything else is the real code path.
 *
 * @param {{
 *   argv: readonly string[],
 *   io?: {stdout?: (text: string) => void, stderr?: (text: string) => void},
 *   now?: () => number,
 *   createStore?: (options: object) => object,
 * }} options
 * @returns {Promise<number>} process exit code
 */
export async function run({ argv, io = {}, now = () => Date.now(), createStore } = {}) {
  const stdout = typeof io.stdout === 'function' ? io.stdout : (text) => process.stdout.write(text)
  const stderr = typeof io.stderr === 'function' ? io.stderr : (text) => process.stderr.write(text)
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    stderr(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    stdout(USAGE)
    return 0
  }

  let store = null
  try {
    const logger = { debug() {}, info() {}, warn() {}, error() {} }
    if (!existsSync(args.dshHome)) {
      const error = new Error(`DSH_HOME directory not found: ${args.dshHome}`)
      error.code = 'STORE_UNAVAILABLE'
      throw error
    }
    const dshHome = path.resolve(args.dshHome)
    const storeRootCandidate = path.join(dshHome, 'storages', 'confluence', 'v1')
    if (!existsSync(storeRootCandidate)) {
      const error = new Error(`no Confluence store under ${dshHome} (expected storages/confluence/v1)`)
      error.code = 'STORE_UNAVAILABLE'
      throw error
    }

    const nowMs = typeof now === 'function' ? Number(now()) : Date.now()
    const outDir = args.out !== '' ? validateOutArg(args.out) : defaultExportDir(dshHome, nowMs)

    const config = resolveConfig({}).config
    const makeStore = typeof createStore === 'function'
      ? createStore
      : (options) => new JournalStore(options)
    store = makeStore({ config, logger, deps: { env: { DSH_HOME: dshHome } } })
    if (store && typeof store.init === 'function') await store.init()
    const redactor = createRedactor(config, { logger })

    const result = await exportMemories({
      store,
      config,
      redactor,
      outDir,
      logger,
      now: () => nowMs,
      dryRun: args.dryRun,
    })

    const summary = {
      ok: true,
      schema: EXPORT_SCHEMA,
      formatVersion: EXPORT_FORMAT_VERSION,
      scope: result.scope,
      storeRoot: typeof store?.rootDir === 'string' ? store.rootDir : storeRootCandidate,
      outDir: result.outDir,
      dryRun: result.dryRun,
      files: result.files,
      recordCount: result.recordCount,
      firstSeq: result.firstSeq,
      lastSeq: result.lastSeq,
      tombstoneStubs: result.tombstoneStubs,
      skippedReplies: result.skippedReplies,
      skippedRetention: result.skippedRetention,
      truncated: result.truncated,
    }
    if (args.json) {
      stdout(JSON.stringify(summary, null, 2) + '\n')
    } else {
      const lines = [
        'Confluence export — confluence.memories/v1 (universal memory)',
        `  scope:      ${result.scope}  (All sessions)`,
        `  store:      ${summary.storeRoot}`,
        `  output:     ${result.outDir}${result.dryRun ? '  [dry-run: not written]' : ''}`,
        `  records:    ${result.recordCount} live, ${result.tombstoneStubs} tombstone stub(s), ` +
          `${result.skippedReplies} reply line(s) skipped, ${result.skippedRetention} hidden by retention`,
        `  seq range:  ${result.firstSeq ?? '-'} .. ${result.lastSeq ?? '-'}`,
        `  truncated:  ${result.truncated}`,
      ]
      for (const file of result.files) {
        lines.push(`  file:       ${file.name}  ${file.bytes} bytes  sha256:${file.sha256}`)
      }
      if (!result.dryRun) {
        lines.push(`  manifest:   ${path.join(result.outDir, EXPORT_MANIFEST_FILE)}`)
        lines.push(`  jsonl:      ${path.join(result.outDir, MEMORIES_FILE)}`)
      }
      stdout(lines.join('\n') + '\n')
    }
    return 0
  } catch (error) {
    if (error && (error.name === 'UsageError' || error.code === 'USAGE')) {
      stderr(`${error.message}\n\n${USAGE}`)
      return 2
    }
    const code = error && typeof error.code === 'string' ? error.code : 'EXPORT_FAILED'
    stderr(`export-memories: ${code}: ${error?.message ?? String(error)}\n`)
    return 1
  } finally {
    if (store && typeof store.close === 'function') {
      try {
        await store.close()
      } catch {
        // best effort cleanup; the export result is already decided
      }
    }
  }
}

/** True when this file is the process entry point (Windows paths included). */
function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMainModule()) {
  run({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`export-memories: EXPORT_FAILED: ${error?.stack ?? String(error)}\n`)
      process.exitCode = 1
    })
}
