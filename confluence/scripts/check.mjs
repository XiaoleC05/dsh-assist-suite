#!/usr/bin/env node
// Confluence / 高级记忆 — standalone packaging contract check (v0.4.0: workspace bus + long-term
// memory + user persona + style cards).
//
// Mirrors the packaging checks in test/contract.test.js so CI or a human can run one
// command without the test runner:
//   node scripts/check.mjs
//
// v0.4.0 (ADR 0009, extends ADR 0008) has three global memory layers on top of the
// unchanged workspace bus: `pattern` long-term memory (candidate-confirmed), the
// `profile` persona (six persona sections) and two-channel `style` cards. The global
// layer lives in the reserved journal `ws_0000000000000000`; bus data stays per
// workspace and is never merged. Eight model tools, four prompt contributions
// (profile 1400, memory 1410, style 1420, pulse 1500) and seven read-only panel routes.
//
// Node builtins only; no network, no installs, no profile changes. Exit code 0 means
// every check passed. This script does not run the plugin or test its behaviour —
// behaviour is covered by the per-module tests and test/integration.test.js.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEX_PATH = path.join(ROOT, 'index.js')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')
const ICON_PATH = path.join(ROOT, 'icon.svg')
const LIB_DIR = path.join(ROOT, 'lib')
const DOCS_README = path.join(ROOT, 'docs', 'README.md')

/** The 20 Host modules of v0.4.0 (v0.3.0's 18 + memory/style). */
const LIB_MODULES = [
  'board.js',
  'bus.js',
  'config.js',
  'context.js',
  'export.js',
  'facade.js',
  'hostui.js',
  'ledger.js',
  'memory.js',
  'presence.js',
  'profile.js',
  'pulse.js',
  'recall.js',
  'redact.js',
  'store.js',
  'style.js',
  'tools.js',
  'util.js',
  'watermark.js',
  'workspace.js',
]

const EXPECTED_LIB_EXPORTS = {
  'board.js': ['BoardService', 'GLOBAL_SCOPE_KEY', 'KINDS', 'foldRecords'],
  'bus.js': ['MESSAGE_KINDS', 'MESSAGE_MAX_BODY_BYTES', 'MESSAGE_MAX_STORED', 'MessageBus', 'foldMessages'],
  'config.js': ['DEFAULTS', 'publicConfig', 'resolveConfig'],
  'context.js': [
    'CONTEXT_KEY_RE',
    'CONTEXT_MAX_KEYS',
    'CONTEXT_MAX_VALUE_BYTES',
    'CONTEXT_VALUE_TYPES',
    'ContextService',
    'foldContext',
  ],
  'export.js': [
    'EXPORT_ERROR_CODES',
    'EXPORT_FORMAT_VERSION',
    'EXPORT_MANIFEST_FILE',
    'EXPORT_MAX_BYTES',
    'EXPORT_PRODUCER',
    'EXPORT_SCOPE',
    'GLOBAL_SCOPE_KEY',
    'GLOBAL_SCOPE_LABEL',
    'LEGACY_SECTION_ALIASES',
    'MEMORY_DEFAULTS',
    'MEMORY_DOC_FORMAT',
    'MEMORY_DOC_KIND',
    'MEMORY_DOC_MAX_BYTES',
    'MEMORY_DOC_SCOPE',
    'MEMORY_DOC_VERSION',
    'MEMORY_SCOPE_LABEL',
    'PATTERN_CATEGORIES',
    'PATTERN_KEY_RE',
    'PATTERN_SCOPES',
    'PATTERN_SOURCES',
    'PATTERN_STATUSES',
    'PROFILE_DOC_FORMAT',
    'PROFILE_DOC_VERSION',
    'PROFILE_SCOPE_LABEL',
    'PROFILE_SECTIONS',
    'STYLE_AREAS',
    'STYLE_CHANNELS',
    'buildMemoryDocument',
    'buildProfileDocument',
    'exportMemories',
    'importMemoryDocument',
    'renderMemoryMarkdown',
    'renderProfileMarkdown',
    'serializeMemoryDocument',
    'serializeProfileDocument',
    'stripAbsolutePaths',
    'validateExportDir',
    'validateMemoryDocument',
    'validateProfileDocument',
    'workspaceLabelFor',
  ],
  'facade.js': ['ConfluenceFacade', 'PROFILE_SCOPE'],
  'hostui.js': ['HOSTUI_PREFIX', 'MAX_RESPONSE_BYTES', 'PANEL_SCOPE', 'PLUGIN_NAME', 'PLUGIN_VERSION', 'hostuiInternals', 'registerHostUi'],
  'ledger.js': ['SessionLedger', 'foldSessionRows', 'workspaceKeyFor'],
  'memory.js': [
    'MEMORY_DEFAULTS',
    'MEMORY_LEGACY_SECTION_CATEGORIES',
    'MEMORY_MIGRATION_ID_PREFIX',
    'MEMORY_MIGRATION_SOURCE',
    'MEMORY_MIGRATION_VERSION',
    'MemoryService',
    'PATTERN_CATEGORIES',
    'PATTERN_DEFAULT_CONFIDENCE',
    'PATTERN_KEY_PATTERN',
    'PATTERN_KEY_RE',
    'PATTERN_SCOPES',
    'PATTERN_SOURCES',
    'PATTERN_STATUSES',
    'foldPatterns',
    'hasMigrationMarker',
    'legacyProfileFacts',
    'memoryRevision',
  ],
  'presence.js': ['Presence', 'presenceConstants'],
  'profile.js': [
    'LEGACY_SECTION_ALIASES',
    'PROFILE_DEFAULTS',
    'PROFILE_KEY_RE',
    'PROFILE_LEGACY_ALIAS_SECTIONS',
    'PROFILE_LEGACY_DOC_SECTIONS',
    'PROFILE_NON_PERSONA_SECTIONS',
    'PROFILE_RENDER_ORDER',
    'PROFILE_SECTIONS',
    'PROFILE_SOURCES',
    'ProfileService',
    'buildProfileDocument',
    'foldProfile',
    'normalizeProfileSection',
    'renderProfileMarkdown',
    'serializeProfileDocument',
    'validateProfileDocument',
  ],
  'pulse.js': [
    'MEMORY_CONTEXT_NAME',
    'MEMORY_CONTEXT_ORDER',
    'PROFILE_CONTEXT_NAME',
    'PROFILE_CONTEXT_ORDER',
    'PULSE_CONTEXT_NAME',
    'PULSE_CONTEXT_ORDER',
    'PULSE_DEFAULT_MAX_CHARS',
    'PULSE_DEFAULT_MAX_MESSAGES',
    'PULSE_DEFAULT_MAX_PEERS',
    'PULSE_DEFAULT_MAX_STATE_KEYS',
    'PULSE_MAX_TOKENS',
    'PulseService',
    'STYLE_CONTEXT_NAME',
    'STYLE_CONTEXT_ORDER',
    'buildPulseText',
    'estimateTokens',
    'normalizePulseText',
  ],
  'recall.js': ['RecallService', 'parseSessionRef', 'roundRobin'],
  'redact.js': ['REDACT_POLICY', 'createRedactor'],
  'store.js': ['GLOBAL_SCOPE_KEY', 'GLOBAL_SCOPE_LABEL', 'JournalStore', 'WorkspaceJournal'],
  'style.js': [
    'STYLE_AREAS',
    'STYLE_AREA_CHANNELS',
    'STYLE_CHANNELS',
    'STYLE_DEFAULTS',
    'STYLE_DEFAULT_CONFIDENCE',
    'STYLE_DEFAULT_PRIORITY',
    'STYLE_KEY_PATTERN',
    'STYLE_KEY_RE',
    'STYLE_MAX_EXAMPLES',
    'STYLE_MAX_PRIORITY',
    'STYLE_MAX_RULE_BYTES',
    'STYLE_SOURCES',
    'StyleService',
    'foldStyles',
    'styleRevision',
  ],
  'tools.js': ['createTools', 'registerTools'],
  'util.js': [
    'ConfluenceError',
    'createLogger',
    'createUlidFactory',
    'escapePulseText',
    'isUlid',
    'isoNow',
    'makeWriterId',
    'once',
    'safeJsonParse',
    'sha256Hex',
    'shortHash',
    'truncateChars',
    'truncateUtf8',
  ],
  'watermark.js': [
    'BOARD_READ_TOOLS',
    'INBOX_TOOL',
    'PULSE_SECTION_NAME',
    'PULSE_TAG_NAME',
    'WATERMARK_KEY',
    'WATERMARK_STATE_VERSION',
    'WatermarkTracker',
    'createInitialState',
    'createWatermarkProjectionDefinition',
    'foldWatermarks',
    'isHostOnlyProjectionActive',
    'normalizeWatermarkState',
    'parseDigestMarker',
    'parseInboxMarker',
    'parseThroughMarker',
  ],
  'workspace.js': [
    'canonicalizeDir',
    'createOriginResolver',
    'createWorkspaceResolver',
    'resolveOrigin',
    'resolveWorkspace',
    'workspaceKeyFor',
  ],
}

/** v0.4.0 contract constants (ADR 0009; docs/plan/v0.4-interfaces.md). */
const GLOBAL_SCOPE_KEY = 'ws_0000000000000000'
const GLOBAL_SCOPE_LABEL = 'All sessions'
const PROFILE_SCOPE = { key: 'global', label: GLOBAL_SCOPE_LABEL }
const PULSE_TAG_NAME = 'confluence-memory'
const PROFILE_CONTEXT = { name: 'confluence:profile', order: 1400 }
const MEMORY_CONTEXT = { name: 'confluence:memory', order: 1410 }
const STYLE_CONTEXT = { name: 'confluence:style', order: 1420 }
const PULSE_CONTEXT = { name: 'confluence:pulse', order: 1500 }
const PROMPT_CONTRIBUTIONS = [PROFILE_CONTEXT, MEMORY_CONTEXT, STYLE_CONTEXT, PULSE_CONTEXT]
/** Seven read-only panel routes. */
const PANEL_ROUTE_NAMES = ['ping', 'workspaces', 'bus', 'entry', 'profile', 'memory', 'profile-export']
const PANEL_ROUTE_PATHS = ['ping', 'workspaces', 'bus', 'entry', 'profile', 'memory', 'profile/export']
/** Eight model tools, in registry order. */
const TOOL_NAMES = [
  'confluence_board',
  'confluence_context',
  'confluence_send',
  'confluence_inbox',
  'confluence_profile',
  'confluence_memory',
  'confluence_style',
  'confluence_recall',
]
const PERSONA_SECTIONS = ['identity', 'personality', 'communication', 'habits', 'boundaries', 'taste']
const PATTERN_CATEGORIES = ['workflow', 'project', 'domain', 'pitfall', 'heuristic', 'quality']
const STYLE_CHANNELS = ['chat', 'engineering']
const STYLE_AREAS = ['general', 'tone', 'structure', 'commit', 'comment', 'docs', 'naming', 'error', 'log', 'ui']
/** Global record types: envelope + minimal shape accepted by the store. */
const RECORD_TYPES = ['pattern', 'style', 'memory-migration']
const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

const EXPECTED_DSH_CLIENT = {
  platform: 'web',
  immediately: true,
  inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout'],
}

const EXPECTED_FILES = [
  'index.js',
  'client.js',
  ...LIB_MODULES.map((name) => `lib/${name}`),
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
]

/** v0.4.0 locale inventory: 132 UI keys (three-tab panel), en/zh aligned. */
const REQUIRED_LOCALE_KEYS = [
  'panel',
  'panel.subtitle',
  'scope.global',
  'tab.bus',
  'tab.memory',
  'tab.profile',
  'state.loading',
  'bus.title',
  'bus.context.title',
  'memory.title',
  'memory.stats',
  'memory.candidates.title',
  'memory.candidate.hint',
  'memory.status.active',
  'memory.status.candidate',
  'profile.title',
  'profile.exportJson',
  'profile.exportMd',
  'profile.section.identity',
  'profile.section.boundaries',
  'styles.title',
  'styles.channel.chat',
  'styles.channel.engineering',
]

const REQUIRED_DOCS = [
  'research/dsh-internals.md',
  'research/prior-art.md',
  'research/external-patterns.md',
  'discussion/round-1.md',
  'discussion/round-2.md',
  'discussion/position-a.md',
  'discussion/position-b.md',
  'adr/0001-confluence-architecture.md',
  'adr/0002-store-format-and-concurrency.md',
  'adr/0003-pulse-and-watermarks.md',
  'adr/0004-privacy-and-consent.md',
  'adr/0005-ui-transport.md',
  'adr/0006-solo-bench-integration.md',
  'adr/0007-universal-memory-scope.md',
  'adr/0008-bus-and-profile.md',
  'adr/0009-long-term-memory-persona-style.md',
  'design/architecture.md',
  'design/data-model.md',
  'design/store-format.md',
  'design/tool-api.md',
  'design/pulse.md',
  'design/ledger-recall.md',
  'design/ui.md',
  'design/config.md',
  'design/security-privacy.md',
  'design/testing.md',
  'design/solo-bench-integration.md',
  'plan/execution-plan.md',
  'plan/m0-spikes.md',
  'plan/implementation-interfaces.md',
  'plan/implementation-status.md',
  'plan/v0.3-interfaces.md',
  'plan/v0.4-interfaces.md',
  'plan/scope-refactor-delta.md',
  'upgrade-v0.2.md',
  'upgrade-v0.3.md',
  'upgrade-v0.4.md',
  'publishing.md',
  'install.md',
  'planning/team-brief.md',
]

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, message })
    console.log(`FAIL  ${name}`)
    console.log(`      ${message.replace(/\n/g, '\n      ')}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, message })
    console.log(`FAIL  ${name}`)
    console.log(`      ${message.replace(/\n/g, '\n      ')}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEquals(actual, expected, label) {
  assert(
    Object.is(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

// ---------------------------------------------------------------------------
// dependency-free YAML subset parser (only what cordis.patch.yml needs)
// ---------------------------------------------------------------------------

function stripComment(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#') ? null : line
}

/** @param {string} text @returns {any} */
function parseYamlSubset(text) {
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw)
    if (line === null) continue
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }
  let index = 0

  function parseScalar(raw) {
    if (raw === '[]') return []
    if (raw === '{}') return {}
    if (/^'(.*)'$/.test(raw)) return raw.slice(1, -1)
    if (/^"(.*)"$/.test(raw)) return raw.slice(1, -1)
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^-?\d+$/.test(raw)) return Number(raw)
    if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
    return raw
  }

  function parseBlock(indent) {
    const first = lines[index]
    if (first === undefined || first.indent !== indent) throw new Error(`unexpected YAML at line ${index + 1}`)
    return first.text === '-' || first.text.startsWith('- ') ? parseSequence(indent) : parseMapping(indent)
  }

  function parseValueAfter(indent) {
    const next = lines[index]
    if (next === undefined || next.indent <= indent) return null
    return parseBlock(next.indent)
  }

  function parseMapping(indent) {
    const out = {}
    while (index < lines.length && lines[index].indent === indent) {
      const line = lines[index]
      const match = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/)
      if (match === null) throw new Error(`unexpected YAML mapping entry: ${line.text}`)
      index += 1
      out[match[1]] = match[2] === undefined ? parseValueAfter(indent) : parseScalar(match[2])
    }
    return out
  }

  function parseSequence(indent) {
    const out = []
    while (
      index < lines.length &&
      lines[index].indent === indent &&
      (lines[index].text === '-' || lines[index].text.startsWith('- '))
    ) {
      const rest = lines[index].text === '-' ? '' : lines[index].text.slice(2).trim()
      index += 1
      if (rest === '') {
        out.push(parseValueAfter(indent))
        continue
      }
      const match = rest.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/)
      if (match === null) {
        out.push(parseScalar(rest))
        continue
      }
      const map = {}
      const keyIndent = indent + 2
      map[match[1]] = match[2] === undefined ? parseValueAfter(indent) : parseScalar(match[2])
      while (index < lines.length && lines[index].indent >= keyIndent) {
        const line = lines[index]
        if (line.indent !== keyIndent) throw new Error(`unexpected YAML indentation: ${line.text}`)
        const entry = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/)
        if (entry === null) throw new Error(`unexpected YAML sequence entry: ${line.text}`)
        index += 1
        map[entry[1]] = entry[2] === undefined ? parseValueAfter(keyIndent) : parseScalar(entry[2])
      }
      out.push(map)
    }
    return out
  }

  return parseBlock(0)
}

/** Canonical JSON (sorted object keys) for order-insensitive deep equality. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function deepEqual(actual, expected, label) {
  const a = canonicalJson(actual)
  const b = canonicalJson(expected)
  assert(a === b, `${label} differs:\nactual:   ${a.slice(0, 600)}\nexpected: ${b.slice(0, 600)}`)
}

function markdownLinkTargets(text) {
  const targets = []
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    if (target.startsWith('#')) continue
    targets.push(target.split('#')[0])
  }
  return targets
}

function filesPatternMatches(pattern, relPath) {
  if (pattern === relPath) return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp('^' + escaped + '$').test(relPath)
}

// ---------------------------------------------------------------------------
// shared fixtures (loaded once; no side effects)
// ---------------------------------------------------------------------------

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patchText = readFileSync(PATCH_PATH, 'utf8')
const patch = parseYamlSubset(patchText)
const row = patch[0].insert[0]
const { DEFAULTS } = await import(pathToFileURL(path.join(LIB_DIR, 'config.js')).href)
const indexModule = await import(pathToFileURL(INDEX_PATH).href)
const libModules = {}
for (const name of LIB_MODULES) {
  libModules[name] = await import(pathToFileURL(path.join(LIB_DIR, name)).href)
}
const enLocale = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
const zhLocale = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

check('manifest: v0.4.0 three-layer bundle + declared Web client half', () => {
  assertEquals(packageJson.name, 'dsh-confluence', 'name')
  assertEquals(packageJson.version, '0.4.0', 'version')
  assertEquals(packageJson.private, true, 'private')
  assertEquals(packageJson.type, 'module', 'type')
  assertEquals(packageJson.main, './index.js', 'main')
  assertEquals(packageJson.license, 'MIT', 'license')
  assertEquals(packageJson.engines.node, '>=22.19.0', 'engines.node')
  assertEquals(packageJson.engines.dsh, '>=0.2.2-rc.1', 'engines.dsh')
  assertEquals(packageJson.scripts.test, 'node --test --test-force-exit "test/*.test.js"', 'scripts.test')
  assertEquals(packageJson.scripts.check, 'node scripts/check.mjs', 'scripts.check')
  assertEquals(packageJson.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch')
  deepEqual(packageJson.dsh.client, EXPECTED_DSH_CLIENT, 'dsh.client')
  assert(/workspace session bus/i.test(packageJson.description), 'description must state the workspace session bus')
  assert(/long-term memory/i.test(packageJson.description), 'description must state long-term memory')
  assert(/persona/i.test(packageJson.description), 'description must state the user persona')
  assert(/style/i.test(packageJson.description), 'description must state style cards')
  assert(/offline/i.test(packageJson.description), 'description must state the offline posture')
  assert(!/design-stage/i.test(packageJson.description), 'description must not describe a design-stage scaffold')
  assert(/XiaoleC05/.test(packageJson.author), 'author')
  assert(/github\.com\/XiaoleC05\/Confluence\.git$/.test(packageJson.repository.url), 'repository.url')
  assert(packageJson.keywords.includes('dsh'), 'keywords must include dsh')
  assertEquals(packageJson.dependencies, undefined, 'dependency-free runtime')
  assertEquals(packageJson.devDependencies, undefined, 'dependency-free runtime')
})

check('files/exports: the implemented runtime surface is complete and nothing dev-only ships', () => {
  assertEquals(packageJson.exports['.'], './index.js', 'exports[.]')
  assertEquals(packageJson.exports['./client'], './client.js', 'exports[./client]')
  assertEquals(packageJson.exports['./locale/*.json'], './locale/*.json', 'exports[locale]')
  assertEquals(packageJson.exports['./icon'], './icon.svg', 'exports[icon]')
  assert(packageJson.files.includes('lib/*.js'), 'files must include lib/*.js')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert(packageJson.files.includes(required), `files must include ${required}`)
  }
  for (const relPath of EXPECTED_FILES) {
    assert(existsSync(path.join(ROOT, relPath)), `missing runtime file ${relPath}`)
    assert(
      packageJson.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      `runtime file ${relPath} is not covered by files`,
    )
  }
  for (const relPath of ['test/contract.test.js', 'docs/README.md', 'examples/profile-patch.yml', 'scripts/check.mjs']) {
    assert(!packageJson.files.some((pattern) => filesPatternMatches(pattern, relPath)), `dev file ${relPath} would ship`)
  }
})

check('patch: one confluence row; parsed config deep-equals lib/config.js DEFAULTS', () => {
  assertEquals(patch.length, 1, 'top-level patch entries')
  assert(Array.isArray(patch[0].insert), 'patch must contain insert:')
  assertEquals(patch[0].insert.length, 1, 'insert row count')
  assertEquals(row.id, 'confluence', 'row id')
  assertEquals(row.name, 'dsh-confluence', 'row name')
  assert(!patchText.includes('!!js'), 'patch must not use !!js expressions')
  deepEqual(row.config, DEFAULTS, 'bundle row config vs lib/config.js DEFAULTS')
  // v0.4.0 config shape: three memory layers + unchanged bus/store.
  assert(Array.isArray(row.config.privacy.redactPatterns), 'privacy.redactPatterns default must be an array')
  assert(row.config.bus && typeof row.config.bus === 'object', 'patch must carry the bus section')
  assert(row.config.profile && typeof row.config.profile === 'object', 'patch must carry the profile section')
  assert(row.config.memory && typeof row.config.memory === 'object', 'patch must carry the memory section')
  assert(row.config.style && typeof row.config.style === 'object', 'patch must carry the style section')
  assert(!patchText.includes('disabledWorkspaces'), 'patch must not carry the removed privacy.disabledWorkspaces')
  assert(!patchText.includes('maxSessionsPerWorkspace'), 'patch must use ledger.maxSessions, not the old key')
  assert(!/^\s+maxEntriesPerWorkspace:/m.test(patchText), 'patch must not carry the deprecated note cap name')
  assert(!/^        export:$/m.test(patchText), 'patch must not carry the removed top-level export section')
  assert(!/^        pulse:$/m.test(patchText), 'patch must not carry the removed top-level pulse section')
  assertEquals(row.config.store.maxOpenWorkspaces, 16, 'store.maxOpenWorkspaces default')
  assertEquals(row.config.memory.maxPatterns, 300, 'memory.maxPatterns default')
  assertEquals(row.config.memory.maxInjectPatterns, 5, 'memory.maxInjectPatterns default')
  assertEquals(row.config.memory.candidateConfidence, 0.5, 'memory.candidateConfidence default')
  assertEquals(row.config.memory.autoCapture, 'candidate', 'memory.autoCapture default')
  assertEquals(row.config.style.maxRules, 100, 'style.maxRules default')
  assertEquals(row.config.style.maxInjectCharsChat, 600, 'style.maxInjectCharsChat default')
  assertEquals(row.config.style.maxInjectCharsEngineering, 900, 'style.maxInjectCharsEngineering default')
  assertEquals(row.config.ledger.maxSessions, 200, 'ledger.maxSessions default')
  assertEquals(row.config.privacy.disabledWorkspaces, undefined, 'privacy.disabledWorkspaces must be gone')
})

check('lib modules: exactly the 20 implemented files are present', () => {
  const actual = readdirSync(LIB_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
  deepEqual(actual, LIB_MODULES.slice().sort(), 'lib/ module inventory')
  assertEquals(LIB_MODULES.length, 20, 'expected module count')
})

check('lib modules: every expected public export is present', () => {
  for (const [moduleName, expected] of Object.entries(EXPECTED_LIB_EXPORTS)) {
    const module = libModules[moduleName]
    for (const name of expected) {
      assert(module[name] !== undefined, `lib/${moduleName} is missing export ${name}`)
    }
  }
})

check('index.js: implemented Host entry surface, quiet import, required services declared', () => {
  const quiet = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(INDEX_PATH).href)})`],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
  )
  assertEquals(quiet.status, 0, 'quiet import exit status')
  assertEquals(quiet.stdout.trim(), '', 'quiet import stdout')
  assertEquals(quiet.stderr.trim(), '', 'quiet import stderr')
  assertEquals(indexModule.name, 'confluence', 'exported name')
  assertEquals(typeof indexModule.apply, 'function', 'apply export')
  assertEquals(typeof indexModule.applyWithDeps, 'function', 'applyWithDeps export')
  assertEquals(indexModule.default, undefined, 'must use the apply() export form')
  assertEquals(indexModule.VERSION, '0.4.0', 'VERSION')
  assertEquals(typeof indexModule.DEFAULTS, 'object', 'DEFAULTS export')
  deepEqual(JSON.parse(JSON.stringify(indexModule.DEFAULTS)), DEFAULTS, 'index.js DEFAULTS vs lib/config.js DEFAULTS')
  assert(Array.isArray(indexModule.inject) && indexModule.inject.includes('tools'), "inject must include 'tools'")
})

check('client.js: three-tab read-only panel over the same-origin route adapter', () => {
  const client = readFileSync(CLIENT_PATH, 'utf8')
  assert(/window\.__ModuleLoader__\.load\(\{/.test(client), 'client.js must use window.__ModuleLoader__.load')
  assert(/id:\s*'dsh-confluence'/.test(client), "module id must be 'dsh-confluence'")
  assert(!/^\s*import\s/m.test(client), 'client.js must be a plain browser module')
  assert(!/from\s+['"]@deepseek-ai\//.test(client), 'client.js must not import @deepseek-ai packages')
  assertEquals((client.match(/\bfetch\s*\(/g) ?? []).length, 1, 'exactly one fetch call')
  assert(/fetch\(ROUTE_BASE/.test(client), 'the only fetch must target ROUTE_BASE')
  assert(!/https?:\/\//.test(client), 'client.js must not contain absolute URLs')
  assert(!/\binnerHTML\b|dangerouslySetInnerHTML/.test(client), 'no HTML injection of untrusted text')
  assert(/inject:\s*\[\s*'slots'\s*,\s*'locale'\s*,\s*'layout'\s*\]/.test(client), 'client inject list changed')
  assert(/name:\s*'sidebar\.panellist'[\s\S]{0,160}id:\s*'confluence'[\s\S]{0,160}order:\s*30/.test(client), 'sidebar entry registration changed')
  assert(/name:\s*'main'[\s\S]{0,160}key:\s*'confluence'/.test(client), 'keyed main page registration changed')
  // v0.4.0: three read-only views, seven routes, no retired overview route.
  assert(/高级记忆 \/ Confluence memory/.test(client), 'the panel title must stay the Confluence memory title')
  for (const tab of ['bus', 'memory', 'profile']) {
    assert(client.includes(`t('tab.${tab}')`), `the panel must render the ${tab} tab via t('tab.${tab}')`)
  }
  for (const route of ['/workspaces', '/bus', '/entry', '/profile']) {
    assert(client.includes(`request('${route}'`), `the panel must call the ${route} route`)
  }
  assert(client.includes("request('/memory'"), 'the panel must call the memory route')
  assert(client.includes("'/profile/export?format="), 'the panel must link the profile export download route')
  assert(!/['"]\/overview['"]/.test(client), 'the retired /overview route must not be called')
  assert(!/workspaceKey|workspace_key/.test(client), 'panel requests must not carry a workspace key')
  assert(/ws:\s*options\.ws/.test(client), 'bus/entry requests must pass the opaque ws id')
})

check('offline posture: no network/child-process/DSH imports in index.js or lib/', () => {
  const networkImport =
    /from\s+['"]node:(?:http|https|net|tls|dgram|child_process)['"]|require\(\s*['"]node:(?:http|https|net|tls|dgram|child_process)['"]\s*\)/
  const harnessImport = /from\s+['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\//
  const parserBase = /['"]http:\/\/127\.0\.0\.1['"]/g
  const sources = LIB_MODULES.map((name) => ({ relPath: `lib/${name}`, source: readFileSync(path.join(LIB_DIR, name), 'utf8') }))
  sources.push({ relPath: 'index.js', source: readFileSync(INDEX_PATH, 'utf8') })
  for (const { relPath, source } of sources) {
    assert(!networkImport.test(source), `${relPath} imports a network/child-process module`)
    assert(!harnessImport.test(source), `${relPath} imports a @deepseek-ai package`)
    assert(!/\bfetch\s*\(/.test(source), `${relPath} calls fetch()`)
    assert(!/https?:\/\//.test(source.replace(parserBase, "''")), `${relPath} contains a network URL literal`)
  }
})

check('locale: v0.4 metadata, 132-key inventory and en/zh parity', () => {
  assertEquals(enLocale.meta.title, 'Confluence', 'en meta.title')
  assertEquals(zhLocale.meta.title, '高级记忆', 'zh meta.title')
  assertEquals(
    enLocale.meta.description,
    'Workspace session bus, long-term memory patterns, a portable user persona and style cards, fully offline.',
    'en meta.description',
  )
  assertEquals(
    zhLocale.meta.description,
    '工作区会话总线、长期记忆、可移植用户画像与风格卡，完全离线运行。',
    'zh meta.description',
  )
  const enKeys = Object.keys(enLocale.ui).sort()
  const zhKeys = Object.keys(zhLocale.ui).sort()
  deepEqual(enKeys, zhKeys, 'en/zh UI key parity')
  assertEquals(enKeys.length, 132, 'expected the v0.4.0 inventory (132 keys)')
  for (const key of REQUIRED_LOCALE_KEYS) {
    assert(enLocale.ui[key] !== undefined, `missing en UI string ${key}`)
    assert(zhLocale.ui[key] !== undefined, `missing zh UI string ${key}`)
  }
  assertEquals(enLocale.ui['tab.bus'], 'Workspace bus', 'en tab.bus')
  assertEquals(zhLocale.ui['tab.bus'], '工作区总线', 'zh tab.bus')
  assertEquals(enLocale.ui['tab.memory'], 'Long-term memory', 'en tab.memory')
  assertEquals(zhLocale.ui['tab.memory'], '长期记忆', 'zh tab.memory')
  assertEquals(enLocale.ui['tab.profile'], 'User profile', 'en tab.profile')
  assertEquals(zhLocale.ui['tab.profile'], '用户画像', 'zh tab.profile')
  assertEquals(enLocale.ui['scope.global'], 'All sessions', 'en scope.global')
  assertEquals(zhLocale.ui['scope.global'], '全部会话', 'zh scope.global')
  for (const [key, value] of Object.entries(enLocale.ui)) {
    assert(typeof value === 'string' && value.trim() !== '', `en ui.${key} must be a non-empty string`)
  }
})

check('icon: original, standalone, script-free SVG within limits', () => {
  const buffer = readFileSync(ICON_PATH)
  assert(buffer.length > 200 && buffer.length < 256 * 1024, 'icon size outside 200 B – 256 KiB')
  const svg = buffer.toString('utf8')
  assert(/^<svg\b/.test(svg), 'icon must start with <svg')
  assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'), 'icon must declare the SVG namespace')
  assert(svg.includes('viewBox="'), 'icon must declare a viewBox')
  assert(!/<script/i.test(svg), 'icon must not contain script')
  assert(!/<text/i.test(svg), 'icon must not contain text')
  assert(!/<image\b/i.test(svg), 'icon must not embed raster images')
  assert(!/\b(?:href|src)\s*=\s*["'](?:https?:)?\/\//i.test(svg), 'icon must not reference external URLs')
  assert((svg.match(/<path\b/g) ?? []).length >= 3, 'icon must contain multi-stream geometry')
})

check('docs: READMEs/install/publishing/status keep the v0.4 executed-vs-not-executed honesty', () => {
  const enPath = path.join(ROOT, 'README.md')
  const zhPath = path.join(ROOT, 'README.zh-CN.md')
  assert(existsSync(enPath), 'missing README.md')
  assert(existsSync(zhPath), 'missing README.zh-CN.md')
  const en = readFileSync(enPath, 'utf8')
  const zh = readFileSync(zhPath, 'utf8')
  for (const marker of [
    'Confluence / 高级记忆',
    'v0.4.0',
    'v0.3.0',
    'v0.2.1',
    'v0.1.0',
    'ADR 0009',
    'docs/plan/v0.4-interfaces.md',
    'docs/upgrade-v0.4.md',
    'workspace session bus',
    'long-term memory',
    'persona',
    'style cards',
    'candidate',
    'confluence.memory/v1',
    'confluence-memory-patterns',
    'confluence-style',
    'ws_0000000000000000',
    'All sessions',
    'privateSessions',
    'docs/install.md',
    'docs/publishing.md',
    'docs/plan/implementation-status.md',
    'node --test',
    'MIT',
    'https://github.com/XiaoleC05/Confluence',
  ]) {
    assert(en.includes(marker), `README.md missing: ${marker}`)
  }
  for (const marker of [
    '高级记忆',
    'v0.4.0',
    'v0.3.0',
    '长期记忆',
    '风格卡',
    '256',
    'docs/install.md',
    'docs/publishing.md',
    'docs/upgrade-v0.4.md',
    'node --test',
    'MIT',
  ]) {
    assert(zh.includes(marker), `README.zh-CN.md missing: ${marker}`)
  }
  assert(/not (been )?(installed|verified|executed)/i.test(en), 'README must keep the not-executed claims')
  assert(/panel's rendering/i.test(en), 'README must keep the panel-rendering honesty')
  assert(!/workspace is the consent boundary/i.test(en), 'README must not claim the v0.1.0 privacy boundary')
  assert(existsSync(path.join(ROOT, 'docs', 'plan', 'implementation-status.md')), 'missing implementation-status.md')
  const status = readFileSync(path.join(ROOT, 'docs', 'plan', 'implementation-status.md'), 'utf8')
  for (const marker of ['v0.4.0', 'Executed', 'Not executed', '256']) {
    assert(status.includes(marker), `implementation-status.md missing: ${marker}`)
  }
  const install = readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8').toLowerCase()
  for (const marker of [
    'install_bundle',
    'dsh plugin --profile',
    'not executed',
    'scratch',
    'rollback',
    'restart',
    'memory.maxpatterns',
    'style.maxrules',
    'ws_0000000000000000',
    'confluence-memory',
    'confluence-profile',
    'confluence.memory/v1',
    'memory-export.mjs',
  ]) {
    assert(install.includes(marker), `install.md missing: ${marker}`)
  }
  const publishing = readFileSync(path.join(ROOT, 'docs', 'publishing.md'), 'utf8').toLowerCase()
  for (const marker of ['npm pack', 'checksum', 'nothing was published', 'github', '0.4.0', 'confluence.memory/v1']) {
    assert(publishing.includes(marker), `publishing.md missing: ${marker}`)
  }
  const upgrade = readFileSync(path.join(ROOT, 'docs', 'upgrade-v0.4.md'), 'utf8').toLowerCase()
  for (const marker of ['persona', 'pattern', 'style', 'migration', 'restart', 'rollback', 'read-only', 'confluence.profile/v1']) {
    assert(upgrade.includes(marker), `upgrade-v0.4.md missing: ${marker}`)
  }
})

check('docs index: links resolve and every promised document is named', () => {
  assert(existsSync(DOCS_README), 'missing docs/README.md')
  const text = readFileSync(DOCS_README, 'utf8')
  for (const target of markdownLinkTargets(text)) {
    const resolved = path.resolve(path.join(ROOT, 'docs'), target)
    assert(existsSync(resolved) && statSync(resolved).isFile(), `broken docs/README.md link: ${target}`)
  }
  for (const required of REQUIRED_DOCS) {
    assert(text.includes(required), `docs/README.md must mention ${required}`)
    assert(existsSync(path.join(ROOT, 'docs', required)), `docs/README.md promises a missing doc: ${required}`)
  }
})

// ---------------------------------------------------------------------------
// v0.4.0 prompt contributions and memory layers
// ---------------------------------------------------------------------------

check('v0.4.0 four prompt contributions (profile 1400 / memory 1410 / style 1420 / pulse 1500)', () => {
  const pulse = libModules['pulse.js']
  const actual = [
    { name: pulse.PROFILE_CONTEXT_NAME, order: pulse.PROFILE_CONTEXT_ORDER },
    { name: pulse.MEMORY_CONTEXT_NAME, order: pulse.MEMORY_CONTEXT_ORDER },
    { name: pulse.STYLE_CONTEXT_NAME, order: pulse.STYLE_CONTEXT_ORDER },
    { name: pulse.PULSE_CONTEXT_NAME, order: pulse.PULSE_CONTEXT_ORDER },
  ]
  deepEqual(actual, PROMPT_CONTRIBUTIONS, 'prompt contribution names/orders')
  assertEquals(libModules['watermark.js'].PULSE_TAG_NAME, PULSE_TAG_NAME, 'watermark pulse tag name')
  assertEquals(libModules['watermark.js'].INBOX_TOOL, 'confluence_inbox', 'inbox watermark tool')
  assert(libModules['facade.js'].MEMORY_SCOPE === undefined, 'the retired v0.2 memory-scope constant must stay gone')
  deepEqual({ ...libModules['facade.js'].PROFILE_SCOPE }, PROFILE_SCOPE, 'facade profile scope')
  deepEqual({ ...libModules['hostui.js'].PANEL_SCOPE }, PROFILE_SCOPE, 'panel scope')

  const pulseSource = readFileSync(path.join(LIB_DIR, 'pulse.js'), 'utf8')
  assert(pulseSource.includes("const PULSE_SCOPE_ATTR = 'workspace'"), 'the pulse scope attribute must be workspace')
  assert(pulseSource.includes('<confluence-memory scope="${PULSE_SCOPE_ATTR}"'), 'the pulse must emit the workspace tag')
  const memorySource = readFileSync(path.join(LIB_DIR, 'memory.js'), 'utf8')
  assert(memorySource.includes("'<confluence-memory-patterns'"), 'memory must emit <confluence-memory-patterns>')
  assert(memorySource.includes('candidates="'), 'memory block must carry the candidates attribute')
  const styleSource = readFileSync(path.join(LIB_DIR, 'style.js'), 'utf8')
  assert(styleSource.includes("'<confluence-style'"), 'style must emit <confluence-style>')
  assert(styleSource.includes('chat="'), 'style block must carry the chat attribute')
  const profileSource = readFileSync(path.join(LIB_DIR, 'profile.js'), 'utf8')
  assert(profileSource.includes("'<confluence-profile'"), 'the profile block must emit <confluence-profile>')
  const watermarkSource = readFileSync(path.join(LIB_DIR, 'watermark.js'), 'utf8')
  assert(watermarkSource.includes('confluence-workspace'), 'legacy <confluence-workspace> snapshots must stay parseable')
})

check('persona contract: six sections, legacy aliases, non-persona sections skipped', () => {
  const profile = libModules['profile.js']
  deepEqual(profile.PROFILE_SECTIONS.slice(), PERSONA_SECTIONS, 'persona sections')
  deepEqual(profile.PROFILE_RENDER_ORDER.slice(), PERSONA_SECTIONS, 'persona render order')
  deepEqual(profile.PROFILE_LEGACY_ALIAS_SECTIONS.slice(), ['preferences', 'rules'], 'legacy alias section list')
  deepEqual(
    { ...profile.LEGACY_SECTION_ALIASES },
    { preferences: 'communication', rules: 'boundaries' },
    'legacy alias map',
  )
  deepEqual(profile.PROFILE_NON_PERSONA_SECTIONS.slice(), ['tech', 'context'], 'non-persona sections')
  assertEquals(profile.PROFILE_DOC_FORMAT, 'confluence.profile/v1', 'legacy profile document format kept for import')
  assertEquals(profile.PROFILE_DOC_VERSION, 1, 'legacy profile document version')
  // Fold: legacy preferences fold into communication.
  const facts = profile.foldProfile([
    {
      v: 1,
      type: 'profile',
      id: 'prf_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      ws: GLOBAL_SCOPE_KEY,
      section: 'preferences',
      key: 'answer.language',
      value: 'zh',
      confidence: 0.9,
      source: 'user',
      seq: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      ts: '2026-01-01T00:00:00.000Z',
    },
  ]).facts
  assertEquals(facts.length, 1, 'legacy fact count')
  assertEquals(facts[0].section, 'communication', 'legacy preferences section folds into communication')
})

check('long-term memory + style-card contracts (folds, defaults, vocabularies)', () => {
  const memory = libModules['memory.js']
  const style = libModules['style.js']
  const config = libModules['config.js']
  deepEqual({ ...memory.MEMORY_DEFAULTS }, DEFAULTS.memory, 'memory defaults vs config DEFAULTS.memory')
  deepEqual({ ...style.STYLE_DEFAULTS }, DEFAULTS.style, 'style defaults vs config DEFAULTS.style')
  deepEqual(memory.PATTERN_CATEGORIES.slice(), PATTERN_CATEGORIES, 'pattern categories')
  deepEqual(memory.PATTERN_STATUSES.slice(), ['candidate', 'active', 'rejected', 'superseded'], 'pattern statuses')
  deepEqual(memory.PATTERN_SCOPES.slice(), ['global', 'workspace'], 'pattern scopes')
  deepEqual(memory.PATTERN_SOURCES.slice(), ['agent', 'user', 'import', 'migration'], 'pattern sources')
  deepEqual(style.STYLE_CHANNELS.slice(), STYLE_CHANNELS, 'style channels')
  deepEqual(style.STYLE_AREAS.slice(), STYLE_AREAS, 'style areas')

  const pattern = (seq, fields) => ({
    v: 1,
    type: 'pattern',
    id: `pat_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    confidence: 0.6,
    source: 'agent',
    ...fields,
  })
  const patterns = memory.foldPatterns([
    pattern(ULID_A, { key: 'e2e.retry', category: 'pitfall', title: 'candidate title', body: 'candidate body', status: 'candidate' }),
    pattern(ULID_B, { key: 'e2e.retry', category: 'pitfall', title: 'active title', body: 'active body', status: 'active' }),
  ])
  assertEquals(patterns.counts.total, 1, 'pattern fold dedupes by key')
  assertEquals(patterns.counts.active, 1, 'pattern fold active count')
  assertEquals(patterns.active[0].title, 'active title', 'pattern LWW by seq')

  const styleRecord = (seq, fields) => ({
    v: 1,
    type: 'style',
    id: `sty_${seq}`,
    ws: GLOBAL_SCOPE_KEY,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    confidence: 0.8,
    source: 'user',
    ...fields,
  })
  const styles = style.foldStyles([
    styleRecord(ULID_A, { channel: 'chat', area: 'tone', key: 'answer.zh', title: 'old', rule: 'old rule', priority: 50, enabled: true }),
    styleRecord(ULID_B, { channel: 'chat', area: 'tone', key: 'answer.zh', title: 'new', rule: 'new rule', priority: 80, enabled: true }),
  ])
  assertEquals(styles.active.length, 1, 'style fold dedupes by (channel,key)')
  assertEquals(styles.active[0].title, 'new', 'style LWW by seq')
  void config
})

check('tools: the eight v0.4 tools in registry order with persona/memory/style wording', () => {
  const tools = libModules['tools.js']
  const definitions = tools.createTools({}, {})
  assertEquals(Array.isArray(definitions), true, 'createTools must return an array')
  deepEqual(definitions.map((definition) => definition.name), TOOL_NAMES, 'tool names and registry order')
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const text = (name) => String(byName.get(name).description)
  assert(/workspace/i.test(text('confluence_board')), 'board must state workspace scope')
  assert(/untrusted/i.test(text('confluence_board')), 'board must keep the untrusted-data rule')
  assert(/workspace/i.test(text('confluence_context')), 'context must state workspace scope')
  assert(/untrusted/i.test(text('confluence_context')), 'context must keep the untrusted-data rule')
  assert(/queue/i.test(text('confluence_send')), 'send must state queue-based delivery')
  assert(/untrusted/i.test(text('confluence_inbox')), 'inbox must keep the untrusted peer-content rule')
  assert(/persona/i.test(text('confluence_profile')), 'profile must describe the persona')
  assert(/preferences/i.test(text('confluence_profile')), 'profile must state preference semantics')
  assert(/candidate/i.test(text('confluence_memory')), 'memory must state candidate-first capture')
  assert(/promote/i.test(text('confluence_memory')), 'memory must state the promote confirmation')
  assert(/untrusted/i.test(text('confluence_memory')), 'memory must keep the untrusted-data rule')
  assert(/chat/i.test(text('confluence_style')) && /engineering/i.test(text('confluence_style')), 'style must describe both channels')
  assert(/earlier sessions on this machine/i.test(text('confluence_recall')), 'recall must cover this machine')
  const source = readFileSync(path.join(LIB_DIR, 'tools.js'), 'utf8')
  assert(source.includes('inbox='), 'inbox results must render the inbox= cursor marker')
  assert(source.includes('through='), 'board results must keep the through= cursor marker')
  assert(source.includes('NO_WORKSPACE'), 'bus tools must keep the NO_WORKSPACE error path')
  for (const retired of ['confluence_post', 'confluence_read', 'confluence_search', 'confluence_reply']) {
    assert(!source.includes(`name: '${retired}'`), `retired v0.2 tool must be gone: ${retired}`)
  }
})

check('panel routes: seven read-only routes for the three views', () => {
  const routes = libModules['hostui.js'].hostuiInternals.ROUTES
  deepEqual(routes.map((route) => route.name), PANEL_ROUTE_NAMES, 'panel route names')
  deepEqual(
    routes.map((route) => route.path.replace(`${libModules['hostui.js'].HOSTUI_PREFIX}/`, '')),
    PANEL_ROUTE_PATHS,
    'panel route paths',
  )
  assert(routes.every((route) => typeof route.run === 'function'), 'every route must have a payload builder')
  assertEquals(routes.find((route) => route.name === 'profile-export').download, true, 'profile/export must be a download route')
  assert(!routes.some((route) => route.name === 'overview'), 'the retired overview route must be gone')
  const source = readFileSync(path.join(LIB_DIR, 'hostui.js'), 'utf8')
  assert(source.includes('normalizeWorkspaceId'), 'the panel must normalize workspace ids to opaque hashes')
  assert(!/workspaceKey/.test(source), 'panel payloads must not carry a workspace key')
})

check('config: v0.4 defaults plus the retained v0.3 deprecation mappings', () => {
  const { DEFAULTS: libDefaults, resolveConfig } = libModules['config.js']
  assertEquals(libDefaults.store.maxOpenWorkspaces, 16, 'store.maxOpenWorkspaces default')
  assertEquals(libDefaults.bus.context.maxKeys, 200, 'bus.context.maxKeys default')
  assertEquals(libDefaults.memory.maxPatterns, 300, 'memory.maxPatterns default')
  assertEquals(libDefaults.memory.maxInjectPatterns, 5, 'memory.maxInjectPatterns default')
  assertEquals(libDefaults.memory.candidateConfidence, 0.5, 'memory.candidateConfidence default')
  assertEquals(libDefaults.memory.autoCapture, 'candidate', 'memory.autoCapture default')
  assertEquals(libDefaults.style.maxRules, 100, 'style.maxRules default')
  assertEquals(libDefaults.style.maxInjectCharsChat, 600, 'style.maxInjectCharsChat default')
  assertEquals(libDefaults.style.maxInjectCharsEngineering, 900, 'style.maxInjectCharsEngineering default')
  assertEquals(libDefaults.profile.maxFacts, 200, 'profile.maxFacts default (persona budgets)')
  assertEquals(libDefaults.store.maxEntriesPerWorkspace, undefined, 'the v0.2 note cap name is retired')
  assertEquals(libDefaults.pulse, undefined, 'the v0.2 top-level pulse section is retired')
  assertEquals(libDefaults.export, undefined, 'the v0.2 export section is retired')

  const deprecated = resolveConfig({
    store: { maxEntriesPerWorkspace: 1234 },
    pulse: { enabled: false, maxChars: 900 },
    export: { enabled: true },
  })
  for (const warning of [
    'CONFIG_DEPRECATED store.maxEntriesPerWorkspace',
    'CONFIG_DEPRECATED pulse.enabled',
    'CONFIG_DEPRECATED pulse.maxChars',
    'CONFIG_DEPRECATED export',
  ]) {
    assert(deprecated.warnings.includes(warning), `expected ${warning} in ${JSON.stringify(deprecated.warnings)}`)
  }
  assertEquals(deprecated.config.bus.notes.maxEntries, 1234, 'deprecated note cap must be mapped')
  assertEquals(deprecated.config.bus.pulse.maxChars, 900, 'deprecated pulse.maxChars must be mapped')

  const v02 = resolveConfig({
    privacy: { privateSessions: [], disabledWorkspaces: ['ws_0123456789abcdef'] },
    ledger: { maxSessionsPerWorkspace: 50 },
  })
  assert(v02.warnings.includes('CONFIG_DEPRECATED privacy.disabledWorkspaces'), 'stale workspace opt-out must warn')
  assert(v02.warnings.includes('CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace'), 'old ledger cap must warn')
  assertEquals(v02.config.ledger.maxSessions, 50, 'deprecated ledger cap value must be mapped')

  const clean = resolveConfig({ memory: { maxPatterns: 42 }, style: { maxRules: 7 } })
  assertEquals(clean.warnings.length, 0, 'no warnings for v0.4 keys')
  assertEquals(clean.config.memory.maxPatterns, 42, 'memory override honoured')
  assertEquals(clean.config.style.maxRules, 7, 'style override honoured')
})

check('export portability: confluence.memory/v1 + legacy profile document + producer version', () => {
  const exportModule = libModules['export.js']
  assertEquals(exportModule.MEMORY_DOC_FORMAT, 'confluence.memory/v1', 'memory document format')
  assertEquals(exportModule.MEMORY_DOC_VERSION, 1, 'memory document version')
  assertEquals(exportModule.MEMORY_DOC_KIND, 'memory', 'memory document kind')
  assertEquals(exportModule.MEMORY_DOC_SCOPE, 'global', 'memory document scope')
  assertEquals(exportModule.PROFILE_DOC_FORMAT, 'confluence.profile/v1', 'legacy profile document format')
  assertEquals(exportModule.PROFILE_DOC_VERSION, 1, 'legacy profile document version')
  assertEquals(typeof exportModule.buildMemoryDocument, 'function', 'buildMemoryDocument export')
  assertEquals(typeof exportModule.validateMemoryDocument, 'function', 'validateMemoryDocument export')
  assertEquals(typeof exportModule.importMemoryDocument, 'function', 'importMemoryDocument export')
  assertEquals(typeof exportModule.renderMemoryMarkdown, 'function', 'renderMemoryMarkdown export')
  assertEquals(exportModule.EXPORT_PRODUCER.name, 'dsh-confluence', 'export producer name')
  assertEquals(exportModule.EXPORT_PRODUCER.version, '0.4.0', 'export producer version')
  assertEquals(exportModule.EXPORT_SCOPE, 'global', 'legacy memories export scope')
})

await checkAsync('store: per-scope journals; global memory records never leak into a workspace view', async () => {
  const { JournalStore } = libModules['store.js']
  const root = mkdtempSync(path.join(tmpdir(), 'confluence-check-store-'))
  const wsKey = 'ws_0123456789abcdef'
  try {
    const store = new JournalStore({ config: { store: { dir: root } } })
    const globalJournal = await store.openGlobal()
    assertEquals(globalJournal.wsKey, GLOBAL_SCOPE_KEY, 'global journal scope key')
    deepEqual(
      path.relative(root, globalJournal.dir).split(path.sep),
      ['workspaces', GLOBAL_SCOPE_KEY],
      'global journal directory',
    )
    deepEqual(store.legacyWorkspaceMeta(), [], 'fresh store has no pre-existing workspace metadata')
    deepEqual(store.legacyRecords(), [], 'fresh store has no legacy records')

    // v0.4 global record types are accepted by the store envelope/shape validation.
    const patterns = [
      { v: 1, type: 'pattern', id: `pat_${ULID_A}`, key: 'e2e.retry', category: 'pitfall', title: 't', body: 'b', status: 'active', confidence: 0.8, source: 'user' },
      { v: 1, type: 'style', id: `sty_${ULID_B}`, channel: 'chat', area: 'tone', key: 'e2e.tone', title: 't', rule: 'r', priority: 50, enabled: true, confidence: 0.8, source: 'user' },
      { v: 1, type: 'memory-migration', id: `mig_${ULID_A}`, version: 1, source: 'profile-v03' },
    ]
    for (const record of patterns) {
      const stored = await globalJournal.append(record)
      assertEquals(stored.ws, GLOBAL_SCOPE_KEY, `${record.type} record must use the global scope`)
    }
    const globalTypes = store.viewedRecords(GLOBAL_SCOPE_KEY).map((record) => record.type).sort()
    deepEqual(globalTypes, ['memory-migration', 'pattern', 'style'], 'global view carries the v0.4 memory records')
    for (const type of RECORD_TYPES) {
      assert(globalTypes.includes(type), `global view is missing record type ${type}`)
    }

    const workspaceJournal = await store.openWorkspace(wsKey, { canonicalPath: 'd:\\e2e\\workspace', label: 'e2e' })
    deepEqual(
      path.relative(root, workspaceJournal.dir).split(path.sep),
      ['workspaces', wsKey],
      'workspace journal directory',
    )
    await workspaceJournal.append({ type: 'entry', id: 'cnf_check_workspace', kind: 'finding', title: 'workspace note' })
    assertEquals(store.viewedRecords(wsKey).some((record) => record.id === 'cnf_check_workspace'), true, 'workspace view carries its note')
    for (const type of RECORD_TYPES) {
      assert(
        !store.viewedRecords(wsKey).some((record) => record.type === type),
        `global ${type} records must not leak into a workspace view`,
      )
    }
    assertEquals(store.mergedRecords().length, 3, 'the global alias view carries only the global memory records')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const passed = results.filter((result) => result.ok).length
const failed = results.length - passed
console.log('')
console.log(`Confluence packaging check — ${results.length} checks, ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Repository root: ' + ROOT)
  process.exitCode = 1
} else {
  console.log('All packaging contract checks passed (v0.4.0 three-layer memory + style implementation; behaviour is covered by the test suite).')
}
