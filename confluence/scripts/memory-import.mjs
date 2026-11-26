#!/usr/bin/env node
// Confluence / 高级记忆 — offline memory import CLI (`confluence.memory/v1`).
//
//   node scripts/memory-import.mjs --dsh-home <dir> --from <file> [--mode merge|replace]
//                                   [--json] [--dry-run]
//
// Validates a portable memory document strictly, then imports it into the global
// journal as append-only records. Two document formats are accepted:
//   - `confluence.memory/v1` (v0.4: persona + long-term patterns + style cards),
//   - legacy `confluence.profile/v1` (v0.3, persona-only: legacy `tech`/`context`
//     facts are skipped, `preferences`/`rules` fold onto `communication`/`boundaries`).
//
// Semantics (v0.4-interfaces §2.4):
//   - `merge` (default): LWW per persona (section,key), pattern key and
//     (channel,key) style key; imported patterns/styles are written `active` with
//     `source:"import"`; nothing is rejected or disabled.
//   - `replace`: the persona gets one `profile-reset` generation marker followed by
//     the imported persona facts; live patterns missing from the document become
//     `rejected`, live style rules missing from the document become `enabled:false`.
//   - a legacy profile document is persona-only: it never rejects/disables pattern
//     or style records (patterns/styles are simply not touched).
//
// Validation happens before the first append (a rejected document creates no store
// side effect); every write is an append. `--dry-run` validates and summarizes only.
// Exit codes: 0 success; 1 runtime failure (missing/unreadable file, invalid
// document, IO, store failure); 2 usage error. No network, no dependency, no child
// process. The CLI may create the store under a fresh DSH_HOME (portability), but it
// never guesses a home directory. Hermetic tests call the exported run().

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
  PROFILE_DOC_FORMAT,
  buildMemoryImportRecords,
  importMemoryDocument,
} from '../lib/export.js'
import { ProfileService } from '../lib/profile.js'
import { createRedactor } from '../lib/redact.js'
import { GLOBAL_SCOPE_KEY, JournalStore } from '../lib/store.js'
import { ConfluenceError } from '../lib/util.js'

export const USAGE = `Usage: node scripts/memory-import.mjs --dsh-home <dir> --from <file> [options]

Import a canonical confluence.memory/v1 document (or a legacy confluence.profile/v1 document,
persona-only) into the global Confluence memory. Records are appended to the journal (never
rewritten): merge (default) upserts persona facts, patterns and style cards; replace resets the
persona generation, then rejects patterns and disables style rules that the document no longer
contains.

Required:
  --dsh-home <dir>      DSH_HOME that contains (or will contain) storages/confluence/v1
  --from <file>         canonical memory JSON document to import

Options:
  --mode <merge|replace>  import mode, default merge
  --json                  print one JSON summary object to stdout instead of the human summary
  --dry-run               validate and summarize only; write nothing (no store needed)
  -h, --help              show this help

Examples:
  node scripts/memory-import.mjs --dsh-home "$env:DSH_HOME" --from memory.json
  node scripts/memory-import.mjs --dsh-home .tmp/e2e/dsh-home --from memory.json --mode replace --dry-run
`

/** @param {string} message */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'USAGE'
  }
}

const MODES = ['merge', 'replace']

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function intValue(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

/**
 * Parse argv (without the node/script entries).
 * @param {readonly string[]} argv
 * @returns {{dshHome: string, from: string, mode: string, json: boolean, dryRun: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const parsed = { dshHome: '', from: '', mode: 'merge', json: false, dryRun: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    /** @returns {string} */
    const next = () => {
      if (index + 1 >= argv.length) throw new UsageError(`${arg} requires a value`)
      index += 1
      return argv[index]
    }
    if (arg === '--dsh-home') parsed.dshHome = next()
    else if (arg === '--from') parsed.from = next()
    else if (arg === '--mode') parsed.mode = next()
    else if (arg === '--json') parsed.json = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new UsageError(`unknown argument: ${arg}`)
  }
  if (parsed.help) return parsed
  if (parsed.dshHome.trim() === '') throw new UsageError('--dsh-home is required (the store is never guessed)')
  if (parsed.from.trim() === '') throw new UsageError('--from is required')
  if (!MODES.includes(parsed.mode)) throw new UsageError(`--mode must be one of ${MODES.join('|')}`)
  return parsed
}

/**
 * Read the import document with a hard pre-read size cap (never parse an unbounded
 * file). The memory document cap is 1 MiB (a larger file fails LIMIT_EXCEEDED).
 *
 * @param {string} fromPath
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readImportDocument(fromPath, maxBytes) {
  const resolved = path.resolve(fromPath)
  let stat
  try {
    stat = await fs.stat(resolved)
  } catch (error) {
    throw Object.assign(new Error(`cannot read --from file: ${fromPath} (${error?.message ?? error})`), {
      code: 'NOT_FOUND',
    })
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error(`--from must be a regular file: ${fromPath}`), { code: 'BAD_ARGUMENT' })
  }
  if (stat.size > maxBytes) {
    throw Object.assign(
      new Error(`--from file is ${stat.size} bytes, over the ${maxBytes}-byte memory document cap`),
      { code: 'LIMIT_EXCEEDED' },
    )
  }
  try {
    return await fs.readFile(resolved, 'utf8')
  } catch (error) {
    throw Object.assign(new Error(`cannot read --from file: ${error?.message ?? error}`), { code: 'STORE_UNAVAILABLE' })
  }
}

/**
 * Read the global journal records without writing anything.
 *
 * @param {object} store
 * @returns {Promise<readonly unknown[]>}
 */
async function readGlobalRecords(store) {
  try {
    if (store && typeof store.refreshMerged === 'function') await store.refreshMerged(GLOBAL_SCOPE_KEY)
  } catch {
    // A refresh failure is not fatal for the live pre-image; the cache is still usable.
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
 * Default pure folds (same contract as the export CLI): dynamic import of the
 * memory/style fold functions, never their attach/write surface; empty fallback.
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

/** @param {readonly unknown[]} records @param {Function | null} foldPatterns @returns {Array<Record<string, unknown>>} */
function collectPatternEntries(records, foldPatterns) {
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

/** @param {readonly unknown[]} records @param {Function | null} foldStyles @returns {Array<Record<string, unknown>>} */
function collectStyleEntries(records, foldStyles) {
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

/**
 * Effective caps for one import run: host config + the hard document cap.
 *
 * @param {Record<string, unknown>} config resolved config
 * @returns {{maxPatterns: number, maxFacts: number, maxRules: number, maxValueBytes: number, maxExportBytes: number, maxProfileExportBytes: number}}
 */
export function importCaps(config) {
  const profile = isPlainObject(config) && isPlainObject(config.profile) ? config.profile : {}
  const memory = isPlainObject(config) && isPlainObject(config.memory) ? config.memory : {}
  const style = isPlainObject(config) && isPlainObject(config.style) ? config.style : {}
  return {
    maxPatterns: Math.max(1, intValue(memory.maxPatterns, MEMORY_DEFAULTS.maxPatterns)),
    maxFacts: Math.max(1, intValue(profile.maxFacts, PROFILE_DEFAULTS.maxFacts)),
    maxRules: Math.max(1, intValue(style.maxRules, MEMORY_DEFAULTS.maxRules)),
    maxValueBytes: Math.max(32, intValue(profile.maxValueBytes, PROFILE_DEFAULTS.maxValueBytes)),
    maxExportBytes: Math.min(
      MEMORY_DOC_MAX_BYTES,
      Math.max(128, intValue(profile.maxExportBytes, PROFILE_DEFAULTS.maxExportBytes)),
    ),
    maxProfileExportBytes: Math.max(128, intValue(profile.maxExportBytes, PROFILE_DEFAULTS.maxExportBytes)),
  }
}

/** @param {Record<string, Function>} redactor @param {unknown} value @param {string} label @returns {string} */
function redactText(redactor, value, label) {
  if (!redactor || typeof redactor.text !== 'function') {
    throw new ConfluenceError('UNAVAILABLE', 'memory import requires the configured redactor')
  }
  let result
  try {
    result = redactor.text(value)
  } catch (error) {
    throw new ConfluenceError('REDACTED', `redaction failed for ${label}`, { cause: error })
  }
  const text = typeof result === 'string' ? result : isPlainObject(result) ? String(result.value ?? '') : ''
  if (text.trim() === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
  return text.trim()
}

/** @param {Record<string, Function>} redactor @param {unknown} value @param {string} label @returns {string} */
function redactOptionalText(redactor, value, label) {
  if (String(value ?? '').trim() === '') return ''
  return redactText(redactor, value, label)
}

/** @param {Record<string, Function>} redactor @param {unknown} value @param {string} label @returns {string} */
function redactTitle(redactor, value, label) {
  if (!redactor || typeof redactor.title !== 'function') return redactText(redactor, value, label)
  let result
  try {
    result = redactor.title(value)
  } catch (error) {
    throw new ConfluenceError('REDACTED', `redaction failed for ${label}`, { cause: error })
  }
  const text = typeof result === 'string' ? result : isPlainObject(result) ? String(result.value ?? '') : ''
  if (text.trim() === '') throw new ConfluenceError('REDACTED', `${label} is empty after redaction`)
  return text.trim()
}

/**
 * Apply redaction to one pattern entry before it is appended.
 *
 * @param {Record<string, unknown>} entry
 * @param {Record<string, Function>} redactor
 * @returns {Record<string, unknown>}
 */
function redactPatternEntry(entry, redactor) {
  const label = `pattern ${String(entry.key)}`
  const out = { ...entry }
  out.title = redactTitle(redactor, entry.title, `${label} title`)
  out.body = redactOptionalText(redactor, entry.body, `${label} body`)
  if (Array.isArray(entry.tags) && typeof redactor.tags === 'function') {
    try {
      out.tags = redactor.tags(entry.tags)
    } catch (error) {
      throw new ConfluenceError('REDACTED', `redaction failed for ${label} tags`, { cause: error })
    }
  }
  return out
}

/**
 * Apply redaction to one style entry before it is appended.
 *
 * @param {Record<string, unknown>} entry
 * @param {Record<string, Function>} redactor
 * @returns {Record<string, unknown>}
 */
function redactStyleEntry(entry, redactor) {
  const label = `style ${String(entry.channel)}/${String(entry.key)}`
  const out = { ...entry }
  out.title = redactTitle(redactor, entry.title, `${label} title`)
  out.rule = redactText(redactor, entry.rule, `${label} rule`)
  if (Array.isArray(entry.examples)) {
    out.examples = entry.examples
      .filter((example) => isPlainObject(example))
      .map((example, index) => ({
        bad: redactOptionalText(redactor, example.bad, `${label} example ${index} bad`),
        good: redactOptionalText(redactor, example.good, `${label} example ${index} good`),
      }))
  }
  return out
}

/**
 * Build the append-only write set for one import plan: a persona-only legacy
 * profile document (applied through ProfileService) and the pattern/style records.
 * Everything is computed before the first append (fail closed).
 *
 * @param {Record<string, unknown>} plan
 * @param {{redactor: Record<string, Function>, nextId: () => string, now: () => number}} options
 * @returns {{profileDocument: Record<string, unknown>, records: {patterns: Array<Record<string, unknown>>, styles: Array<Record<string, unknown>>}}}
 */
export function buildImportWriteSet(plan, options) {
  const sections = Array.isArray(plan?.persona?.sections) ? plan.persona.sections : []
  const profileDocument = {
    format: PROFILE_DOC_FORMAT,
    version: 1,
    kind: 'profile',
    scope: 'global',
    generatedAt: typeof plan?.generatedAt === 'string' ? plan.generatedAt : undefined,
    revision: null,
    sections: sections.map((section) => ({
      id: section.id,
      facts: section.facts.map((fact) => {
        /** @type {Record<string, unknown>} */
        const row = {
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          source: fact.source,
        }
        if (typeof fact.ts === 'string') row.updatedAt = fact.ts
        return row
      }),
    })),
    counts: { sections: sections.length, facts: sections.reduce((sum, section) => sum + section.facts.length, 0) },
    limits: { maxFacts: plan?.limits?.maxFacts ?? PROFILE_DEFAULTS.maxFacts, maxExportBytes: PROFILE_DEFAULTS.maxExportBytes, truncated: false },
    redaction: { applied: true, policy: 'confluence.redact/v1' },
  }
  if (profileDocument.generatedAt === undefined) delete profileDocument.generatedAt
  const redactedPlan = {
    ...plan,
    patterns: {
      upsert: (plan?.patterns?.upsert ?? []).map((entry) => redactPatternEntry(entry, options.redactor)),
      reject: (plan?.patterns?.reject ?? []).map((entry) => redactPatternEntry(entry, options.redactor)),
    },
    styles: {
      upsert: (plan?.styles?.upsert ?? []).map((entry) => redactStyleEntry(entry, options.redactor)),
      disable: (plan?.styles?.disable ?? []).map((entry) => redactStyleEntry(entry, options.redactor)),
    },
  }
  const records = buildMemoryImportRecords(redactedPlan, {
    nextId: options.nextId,
    now: options.now,
    author: { title: 'memory-import' },
  })
  return { profileDocument, records: { patterns: records.patterns, styles: records.styles } }
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
 *   nextId?: () => string,
 * }} options
 * @returns {Promise<number>} process exit code
 */
export async function run({
  argv,
  io = {},
  now = () => Date.now(),
  createStore,
  loadFolds,
  profileServiceFactory,
  nextId,
} = {}) {
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

  const config = resolveConfig({}).config
  const caps = importCaps(config)
  const silent = { debug() {}, info() {}, warn() {}, error() {} }
  /** @type {object | null} */
  let store = null
  try {
    const text = await readImportDocument(args.from, caps.maxExportBytes)
    // Fail closed: validate the whole document before creating the store.
    const preflight = importMemoryDocument(text, { mode: args.mode, ...caps })
    if (args.dryRun === true) {
      const summary = {
        ok: true,
        format: MEMORY_DOC_FORMAT,
        version: MEMORY_DOC_VERSION,
        sourceFormat: preflight.sourceFormat,
        mode: args.mode,
        dryRun: true,
        personaOnly: preflight.personaOnly === true,
        imported: {
          persona: preflight.persona.count,
          patterns: preflight.patterns.count,
          styles: preflight.styles.count,
        },
        rejected: preflight.patterns.rejected,
        disabled: preflight.styles.disabled,
        document: {
          persona: preflight.persona.count,
          patterns: preflight.patterns.count,
          styles: preflight.styles.count,
        },
        documentRevision: preflight.revision,
      }
      if (args.json) {
        stdout(JSON.stringify(summary, null, 2) + '\n')
      } else {
        stdout(
          [
            'Confluence memory import — confluence.memory/v1 (dry-run: nothing written)',
            `  source:     ${summary.sourceFormat}${summary.personaOnly ? ' (persona-only)' : ''}`,
            `  mode:       ${args.mode}`,
            `  persona:    ${summary.imported.persona} fact(s)`,
            `  patterns:   ${summary.imported.patterns} (${summary.rejected} to reject)`,
            `  styles:     ${summary.imported.styles} (${summary.disabled} to disable)`,
            `  revision:   ${summary.documentRevision ?? '-'}`,
          ].join('\n') + '\n',
        )
      }
      return 0
    }

    const dshHome = path.resolve(args.dshHome)
    if (existsSync(dshHome)) {
      let stat = null
      try {
        stat = await fs.stat(dshHome)
      } catch {
        stat = null
      }
      if (stat !== null && !stat.isDirectory()) {
        throw Object.assign(new Error(`--dsh-home is not a directory: ${args.dshHome}`), { code: 'BAD_ARGUMENT' })
      }
    }
    const makeStore = typeof createStore === 'function' ? createStore : (options) => new JournalStore(options)
    store = makeStore({ config, logger: silent, deps: { env: { DSH_HOME: dshHome } } })
    if (store && typeof store.init === 'function') await store.init()
    const redactor = createRedactor(config, { logger: silent })
    const makeProfile =
      typeof profileServiceFactory === 'function' ? profileServiceFactory : (options) => new ProfileService(options)
    const profile = makeProfile({ store, config, redactor, logger: silent, deps: { now } })
    await profile.attach()
    const folds = typeof loadFolds === 'function' ? await loadFolds() : await loadDefaultFolds()
    const records = await readGlobalRecords(store)
    const live = {
      patterns: collectPatternEntries(records, folds?.foldPatterns ?? null),
      styles: collectStyleEntries(records, folds?.foldStyles ?? null),
    }
    const plan = importMemoryDocument(text, { mode: args.mode, ...caps, live })
    const writes = buildImportWriteSet(plan, {
      redactor,
      now,
      nextId: typeof nextId === 'function' ? nextId : undefined,
    })
    // Apply: persona first (profile-reset + facts), then the pattern/style records.
    const personaResult = await profile.importDocument(writes.profileDocument, {
      mode: args.mode,
      author: { title: 'memory-import' },
    })
    const appended = [...writes.records.patterns, ...writes.records.styles]
    if (appended.length > 0) {
      const journal =
        typeof store.globalJournal === 'function' ? store.globalJournal() : null
      const target = journal ?? (typeof store.openGlobal === 'function' ? await store.openGlobal() : null)
      if (!target || (typeof target.appendAndSync !== 'function' && typeof target.append !== 'function')) {
        throw new ConfluenceError('STORE_UNAVAILABLE', 'the global journal does not support appending records')
      }
      for (const record of appended) {
        try {
          if (typeof target.appendAndSync === 'function') await target.appendAndSync(record)
          else await target.append(record)
        } catch (error) {
          if (error instanceof ConfluenceError) throw error
          throw new ConfluenceError('STORE_UNAVAILABLE', `memory import append failed: ${error?.message ?? error}`, {
            cause: error,
          })
        }
      }
    }
    const list = profile.list()
    const summary = {
      ok: true,
      format: MEMORY_DOC_FORMAT,
      version: MEMORY_DOC_VERSION,
      sourceFormat: plan.sourceFormat,
      mode: args.mode,
      dryRun: false,
      personaOnly: plan.personaOnly === true,
      imported: {
        persona: personaResult.imported,
        patterns: writes.records.patterns.length,
        styles: writes.records.styles.length,
        rejected: plan.patterns.rejected,
        disabled: plan.styles.disabled,
      },
      document: {
        persona: plan.persona.count,
        patterns: plan.patterns.count,
        styles: plan.styles.count,
      },
      persona: { count: list.count, sections: list.sections.length },
      revision: list.revision,
      storeRoot: typeof store?.rootDir === 'string' ? store.rootDir : '',
    }
    if (args.json) {
      stdout(JSON.stringify(summary, null, 2) + '\n')
    } else {
      stdout(
        [
          'Confluence memory import — confluence.memory/v1 (persona + patterns + styles)',
          `  source:     ${summary.sourceFormat}${summary.personaOnly ? ' (persona-only)' : ''}`,
          `  mode:       ${args.mode}${personaResult.replaced ? ' (persona replaced)' : ''}`,
          `  persona:    ${summary.imported.persona} fact(s) imported (${list.count} live)`,
          `  patterns:   ${summary.imported.patterns} written, ${summary.imported.rejected} rejected`,
          `  styles:     ${summary.imported.styles} written, ${summary.imported.disabled} disabled`,
          `  revision:   ${summary.revision ?? '-'}`,
        ].join('\n') + '\n',
      )
    }
    return 0
  } catch (error) {
    if (error && (error.name === 'UsageError' || error.code === 'USAGE')) {
      stderr(`${error.message}\n\n${USAGE}`)
      return 2
    }
    const code = error && typeof error.code === 'string' ? error.code : 'IMPORT_FAILED'
    stderr(`memory-import: ${code}: ${error?.message ?? String(error)}\n`)
    return 1
  } finally {
    if (store && typeof store.close === 'function') {
      try {
        await store.close()
      } catch {
        // best effort cleanup; the import result is already decided
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
      process.stderr.write(`memory-import: IMPORT_FAILED: ${error?.stack ?? String(error)}\n`)
      process.exitCode = 1
    })
}
