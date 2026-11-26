#!/usr/bin/env node
// Confluence / 高级记忆 — offline memory export CLI (`confluence.memory/v1`).
//
//   node scripts/memory-export.mjs --dsh-home <dir> [--out <file>] [--format json|md]
//                                  [--json] [--dry-run]
//
// Explicitly exports the full portable memory document — user persona + long-term
// patterns + style cards — from one DSH_HOME. The export is: explicit, redacted,
// path-free, deterministic for the same data and clock, and written outside the
// Confluence store (never read back). The store is only read: the global journal is
// folded in memory, no journal file/directory is created, no migration is triggered
// (the memory/style services' folds are pure functions; their `attach()` never runs
// here). The default output is
// `<dsh-home>/storages/confluence-exports/memory-<UTC stamp>.{json,md}`; `--out`
// overrides the exact file path.
//
// Exit codes: 0 success; 1 runtime failure (missing home/store, unsafe path, IO,
// over-cap document); 2 usage error. No network, no dependency, no child process,
// no model call. The CLI never falls back to the real ~/.dsh: `--dsh-home` is
// mandatory. Hermetic tests call the exported run().

import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import {
  MEMORY_DEFAULTS,
  MEMORY_DOC_FORMAT,
  MEMORY_DOC_MAX_BYTES,
  MEMORY_DOC_VERSION,
  PROFILE_DEFAULTS,
  buildMemoryDocument,
  renderMemoryMarkdown,
  serializeMemoryDocument,
  validateExportDir,
} from '../lib/export.js'
import { ProfileService } from '../lib/profile.js'
import { createRedactor } from '../lib/redact.js'
import { GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import { ConfluenceError, isUlid } from '../lib/util.js'

export const USAGE = `Usage: node scripts/memory-export.mjs --dsh-home <dir> [options]

Export the full Confluence memory as a canonical confluence.memory/v1 document (user persona +
long-term memory patterns + style cards), as JSON or a human-readable Markdown rendering. The
export is explicit, redacted, free of absolute paths and written outside the store; the store is
only read (no journal is created, no migration is triggered).

Required:
  --dsh-home <dir>      DSH_HOME that contains storages/confluence/v1 (never guessed)

Options:
  --out <file>          exact output file path (absolute or relative to the current directory).
                        Default: <dsh-home>/storages/confluence-exports/memory-<UTC-stamp>.json|md
  --format <json|md>    output format, default json
  --json                print one JSON summary object to stdout instead of the human summary
  --dry-run             compute and validate the export, print the summary, write nothing
  -h, --help            show this help

Examples:
  node scripts/memory-export.mjs --dsh-home "$env:DSH_HOME" --format md --out .tmp/memory.md
  node scripts/memory-export.mjs --dsh-home .tmp/e2e/run/dsh-home --json
`

/** @param {string} message */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'USAGE'
  }
}

const FORMATS = ['json', 'md']

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function intValue(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/**
 * UTC file stamp, e.g. `20261127T023342Z` (filesystem-safe, sortable, no host zone).
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
 * Default output file path for one run.
 * @param {string} dshHome DSH_HOME directory
 * @param {number} ms epoch milliseconds (UTC stamp)
 * @param {string} format `json` | `md`
 * @returns {string}
 */
export function defaultExportFile(dshHome, ms, format = 'json') {
  const ext = format === 'md' ? 'md' : 'json'
  return path.join(path.resolve(dshHome), 'storages', 'confluence-exports', `memory-${utcStamp(ms)}.${ext}`)
}

/**
 * Parse argv (without the node/script entries).
 * @param {readonly string[]} argv
 * @returns {{dshHome: string, out: string, format: string, json: boolean, dryRun: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const parsed = { dshHome: '', out: '', format: 'json', json: false, dryRun: false, help: false }
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
    else if (arg === '--format') parsed.format = next()
    else if (arg === '--json') parsed.json = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new UsageError(`unknown argument: ${arg}`)
  }
  if (parsed.help) return parsed
  if (parsed.dshHome.trim() === '') throw new UsageError('--dsh-home is required (the store is never guessed)')
  if (!FORMATS.includes(parsed.format)) throw new UsageError(`--format must be one of ${FORMATS.join('|')}`)
  return parsed
}

/**
 * Resolve `--out` to an absolute file path. Literal ".." segments and empty values
 * are usage errors; store containment is checked later by `validateExportDir()`.
 *
 * @param {string} value
 * @param {{dshHome: string, nowMs: number, format: string}} defaults
 * @returns {string} absolute file path
 */
export function resolveOutFile(value, defaults) {
  if (typeof value !== 'string' || value.trim() === '') {
    return defaultExportFile(defaults.dshHome, defaults.nowMs, defaults.format)
  }
  const raw = value.trim()
  if (raw.split(/[\\/]+/).includes('..')) {
    throw new UsageError(`--out must not contain "..": ${raw}`)
  }
  // `--out dir/` means "the default file name inside that directory".
  if (/[\\/]$/.test(raw)) {
    return path.join(path.resolve(raw), path.basename(defaultExportFile(defaults.dshHome, defaults.nowMs, defaults.format)))
  }
  return path.resolve(raw)
}

/**
 * Read the global journal records without creating anything. v0.3 stores expose
 * `viewedRecords(scopeKey)` / `refreshMerged(scopeKey)`; a store double may expose
 * only `globalJournal().records()`.
 *
 * @param {object} store
 * @returns {Promise<readonly unknown[]>}
 */
async function readGlobalRecords(store) {
  try {
    if (store && typeof store.refreshMerged === 'function') await store.refreshMerged(GLOBAL_SCOPE_KEY)
  } catch {
    // A refresh failure is not fatal for the fold; the cached view is still usable.
  }
  if (store && typeof store.viewedRecords === 'function') {
    try {
      const rows = await Promise.resolve(store.viewedRecords(GLOBAL_SCOPE_KEY))
      if (Array.isArray(rows)) return rows
    } catch {
      // fall through to the journal surface
    }
  }
  const journal = store && typeof store.globalJournal === 'function' ? store.globalJournal() : null
  if (journal && typeof journal.records === 'function') {
    try {
      const rows = journal.records()
      if (Array.isArray(rows)) return rows
    } catch {
      return []
    }
  }
  return []
}

/**
 * Default pure folds: the memory/style services own the fold logic, but their
 * modules may not exist in an older build. Import them dynamically (never their
 * write/attach surface) and fall back to empty sets; a v0.3 store has no pattern or
 * style records anyway.
 *
 * @returns {Promise<{foldPatterns: Function | null, foldStyles: Function | null}>}
 */
async function loadDefaultFolds() {
  /** @type {{foldPatterns: Function | null, foldStyles: Function | null}} */
  const folds = { foldPatterns: null, foldStyles: null }
  try {
    const memory = await import('../lib/memory.js')
    if (typeof memory.foldPatterns === 'function') folds.foldPatterns = memory.foldPatterns
  } catch {
    // memory.js is not part of this build yet: nothing on disk is a pattern.
  }
  try {
    const style = await import('../lib/style.js')
    if (typeof style.foldStyles === 'function') folds.foldStyles = style.foldStyles
  } catch {
    // style.js is not part of this build yet: nothing on disk is a style card.
  }
  return folds
}

/**
 * Collect portable pattern entries from the pure fold (active + candidates).
 * Rejected/superseded patterns are not portable.
 *
 * @param {readonly unknown[]} records
 * @param {Function | null} foldPatterns
 * @returns {Array<Record<string, unknown>>}
 */
export function collectPatternEntries(records, foldPatterns) {
  if (typeof foldPatterns !== 'function') return []
  let folded
  try {
    folded = foldPatterns(records)
  } catch {
    return []
  }
  const list = []
  if (isPlainObject(folded)) {
    if (Array.isArray(folded.active)) list.push(...folded.active)
    if (Array.isArray(folded.candidates)) list.push(...folded.candidates)
    if (list.length === 0 && folded.byKey instanceof Map) {
      for (const entry of folded.byKey.values()) {
        if (isPlainObject(entry) && entry.status !== 'rejected' && entry.status !== 'superseded') list.push(entry)
      }
    }
  }
  return list
}

/**
 * Collect portable style entries from the pure fold (active/live rules).
 *
 * @param {readonly unknown[]} records
 * @param {Function | null} foldStyles
 * @returns {Array<Record<string, unknown>>}
 */
export function collectStyleEntries(records, foldStyles) {
  if (typeof foldStyles !== 'function') return []
  let folded
  try {
    folded = foldStyles(records)
  } catch {
    return []
  }
  if (!isPlainObject(folded)) return []
  if (Array.isArray(folded.active)) return folded.active
  if (folded.byChannelKey instanceof Map) {
    const out = []
    for (const entry of folded.byChannelKey.values()) if (isPlainObject(entry)) out.push(entry)
    return out
  }
  return []
}

/** @param {Record<string, Function> | null} redactor @param {unknown} value @param {string} label @returns {string} */
function redactText(redactor, value, label) {
  if (!redactor || typeof redactor.text !== 'function') return String(value ?? '')
  try {
    const result = redactor.text(value)
    const text = typeof result === 'string' ? result : isPlainObject(result) ? String(result.value ?? '') : ''
    if (text.trim() === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
    return text
  } catch (error) {
    if (error instanceof ConfluenceError) throw error
    throw new ConfluenceError('EXPORT_FAILED', `redaction failed for ${label}`, { cause: error })
  }
}

/** @param {Record<string, Function> | null} redactor @param {unknown} value @param {string} label @returns {string} */
function redactTitle(redactor, value, label) {
  if (!redactor || typeof redactor.title !== 'function') return String(value ?? '')
  try {
    const result = redactor.title(value)
    const text = typeof result === 'string' ? result : isPlainObject(result) ? String(result.value ?? '') : ''
    if (text.trim() === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
    return text
  } catch (error) {
    if (error instanceof ConfluenceError) throw error
    throw new ConfluenceError('EXPORT_FAILED', `redaction failed for ${label}`, { cause: error })
  }
}

/**
 * Re-apply redaction to the portable pattern fields (defence in depth: services
 * already redact on write, but the export is the moment data leaves the machine).
 *
 * @param {readonly Record<string, unknown>[]} entries
 * @param {object} redactor
 * @returns {Array<Record<string, unknown>>}
 */
export function redactPatternEntries(entries, redactor) {
  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) return entry
    const label = `pattern ${String(entry.key ?? index)}`
    const out = { ...entry }
    out.title = redactTitle(redactor, entry.title, `${label} title`)
    out.body = redactText(redactor, entry.body, `${label} body`)
    if (Array.isArray(entry.tags)) {
      try {
        out.tags = redactor && typeof redactor.tags === 'function' ? redactor.tags(entry.tags) : entry.tags
      } catch (error) {
        throw new ConfluenceError('EXPORT_FAILED', `redaction failed for ${label} tags`, { cause: error })
      }
    }
    return out
  })
}

/**
 * Re-apply redaction to the portable style fields.
 *
 * @param {readonly Record<string, unknown>[]} entries
 * @param {object} redactor
 * @returns {Array<Record<string, unknown>>}
 */
export function redactStyleEntries(entries, redactor) {
  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) return entry
    const label = `style ${String(entry.key ?? index)}`
    const out = { ...entry }
    out.title = redactTitle(redactor, entry.title, `${label} title`)
    out.rule = redactText(redactor, entry.rule, `${label} rule`)
    if (Array.isArray(entry.examples)) {
      out.examples = entry.examples
        .filter((example) => isPlainObject(example))
        .map((example, exampleIndex) => ({
          bad: redactText(redactor, example.bad, `${label} example ${exampleIndex} bad`),
          good: redactText(redactor, example.good, `${label} example ${exampleIndex} good`),
        }))
    }
    return out
  })
}

/** @param {readonly unknown[]} records @returns {string | null} greatest journal seq or null */
export function latestSeq(records) {
  let latest = null
  for (const record of records) {
    if (!isPlainObject(record) || !isUlid(record.seq)) continue
    if (latest === null || record.seq > latest) latest = record.seq
  }
  return latest
}

/** @param {{privacy?: {redact?: boolean}}} config @returns {boolean} */
function redactionEnabled(config) {
  return !(isPlainObject(config) && isPlainObject(config.privacy) && config.privacy.redact === false)
}

/**
 * Run the CLI. Exported for hermetic tests (no child process needed): inject
 * stdout/stderr collectors, a clock, a store factory and the pure fold functions.
 *
 * @param {{
 *   argv: readonly string[],
 *   io?: {stdout?: (text: string) => void, stderr?: (text: string) => void},
 *   now?: () => number,
 *   createStore?: (options: object) => object,
 *   loadFolds?: () => Promise<{foldPatterns: Function | null, foldStyles: Function | null}>,
 *   profileServiceFactory?: (options: object) => object,
 * }} options
 * @returns {Promise<number>} process exit code
 */
export async function run({ argv, io = {}, now = () => Date.now(), createStore, loadFolds, profileServiceFactory } = {}) {
  const stdout = typeof io.stdout === 'function' ? io.stdout : (text) => process.stdout.write(text)
  const stderr = typeof io.stderr === 'function' ? io.stderr : (text) => process.stderr.write(text)
  let args
  try {
    args = parseArgs(argv)
    if (args.help) {
      stdout(USAGE)
      return 0
    }
  } catch (error) {
    stderr(`${error.message}\n\n${USAGE}`)
    return 2
  }

  /** @type {object | null} */
  let store = null
  try {
    const nowMs = typeof now === 'function' ? Number(now()) : Date.now()
    const dshHome = path.resolve(args.dshHome)
    if (!existsSync(dshHome)) {
      const error = new Error(`DSH_HOME directory not found: ${args.dshHome}`)
      error.code = 'STORE_UNAVAILABLE'
      throw error
    }
    const storeRootCandidate = path.join(dshHome, 'storages', 'confluence', 'v1')
    if (!existsSync(storeRootCandidate)) {
      const error = new Error(`no Confluence store under ${dshHome} (expected storages/confluence/v1)`)
      error.code = 'STORE_UNAVAILABLE'
      throw error
    }
    const outFile = resolveOutFile(args.out, { dshHome, nowMs, format: args.format })
    const config = resolveConfig({}).config
    const silent = { debug() {}, info() {}, warn() {}, error() {} }
    const makeStore = typeof createStore === 'function' ? createStore : (options) => new JournalStore(options)
    store = makeStore({ config, logger: silent, deps: { env: { DSH_HOME: dshHome } } })
    if (store && typeof store.init === 'function') await store.init()
    const storeRoot = typeof store?.rootDir === 'string' && store.rootDir !== '' ? store.rootDir : storeRootCandidate
    // The document must be published outside the store: validate the parent directory.
    validateExportDir(path.dirname(outFile), storeRoot)

    const redactor = createRedactor(config, { logger: silent })
    const makeProfile =
      typeof profileServiceFactory === 'function'
        ? profileServiceFactory
        : (options) => new ProfileService(options)
    const profile = makeProfile({ store, config, redactor, logger: silent, deps: { now: () => nowMs } })
    // Read-only attach: an export never creates the global journal as a side effect.
    await profile.attach({ create: false })
    const personaDocument = await profile.exportDocument()
    const persona = { sections: Array.isArray(personaDocument?.sections) ? personaDocument.sections : [] }

    const records = await readGlobalRecords(store)
    const folds =
      typeof loadFolds === 'function' ? await loadFolds() : await loadDefaultFolds()
    const patternSource = collectPatternEntries(records, folds?.foldPatterns ?? null)
    const styleSource = collectStyleEntries(records, folds?.foldStyles ?? null)
    const patterns = redactPatternEntries(patternSource, redactor)
    const styles = redactStyleEntries(styleSource, redactor)

    const doc = buildMemoryDocument({
      persona,
      patterns,
      styles,
      now: () => nowMs,
      revision: latestSeq(records),
      limits: {
        maxPatterns: intValue(config?.memory?.maxPatterns, MEMORY_DEFAULTS.maxPatterns),
        maxFacts: intValue(config?.profile?.maxFacts, PROFILE_DEFAULTS.maxFacts),
        maxRules: intValue(config?.style?.maxRules, MEMORY_DEFAULTS.maxRules),
      },
      maxExportBytes: Math.min(
        MEMORY_DOC_MAX_BYTES,
        intValue(config?.profile?.maxExportBytes, PROFILE_DEFAULTS.maxExportBytes),
      ),
      maxValueBytes: intValue(config?.profile?.maxValueBytes, PROFILE_DEFAULTS.maxValueBytes),
      redactionApplied: redactionEnabled(config),
    })
    const text = args.format === 'md' ? renderMemoryMarkdown(doc) : serializeMemoryDocument(doc)
    const bytes = Buffer.byteLength(text, 'utf8')
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
    if (args.dryRun !== true) {
      await fs.mkdir(path.dirname(outFile), { recursive: true })
      await fs.writeFile(outFile, text, 'utf8')
    }
    const counts = isPlainObject(doc.counts) ? doc.counts : {}
    const limits = isPlainObject(doc.limits) ? doc.limits : {}
    const summary = {
      ok: true,
      format: MEMORY_DOC_FORMAT,
      version: MEMORY_DOC_VERSION,
      scope: 'global',
      outputFormat: args.format,
      out: outFile,
      bytes,
      sha256,
      persona: intValue(counts.persona, 0),
      patterns: intValue(counts.patterns, 0),
      styles: intValue(counts.styles, 0),
      revision: typeof doc.revision === 'string' ? doc.revision : null,
      generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : '',
      truncated: limits.truncated === true,
      dryRun: args.dryRun === true,
      folds: {
        patterns: typeof folds?.foldPatterns === 'function' ? 'available' : 'unavailable',
        styles: typeof folds?.foldStyles === 'function' ? 'available' : 'unavailable',
      },
    }
    if (args.json) {
      stdout(JSON.stringify(summary, null, 2) + '\n')
    } else {
      stdout(
        [
          'Confluence memory export — confluence.memory/v1 (persona + patterns + styles)',
          `  format:     ${args.format === 'md' ? 'markdown' : 'json'}`,
          `  output:     ${outFile}${summary.dryRun ? '  [dry-run: not written]' : ''}`,
          `  persona:    ${summary.persona} fact(s)`,
          `  patterns:   ${summary.patterns}`,
          `  styles:     ${summary.styles}`,
          `  revision:   ${summary.revision ?? '-'}`,
          `  bytes:      ${bytes}`,
          `  sha256:     ${sha256}`,
          `  truncated:  ${summary.truncated}`,
        ].join('\n') + '\n',
      )
    }
    return 0
  } catch (error) {
    if (error && (error.name === 'UsageError' || error.code === 'USAGE')) {
      stderr(`${error.message}\n\n${USAGE}`)
      return 2
    }
    const code = error && typeof error.code === 'string' ? error.code : 'EXPORT_FAILED'
    stderr(`memory-export: ${code}: ${error?.message ?? String(error)}\n`)
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
      process.stderr.write(`memory-export: EXPORT_FAILED: ${error?.stack ?? String(error)}\n`)
      process.exitCode = 1
    })
}
