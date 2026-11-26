// Confluence / 高级记忆 — dependency-free packaging contract tests (v0.4.0 implementation).
//
// These tests verify the *packaging and entry-point contract* of the implemented plugin:
// bundle manifest/patch, runtime file coverage, locales, icon, the Host entry surface,
// the v0.4 three-layer constants, the four prompt contributions, the eight tools, the
// seven panel routes, the Web client module identity and the offline posture.
// Behaviour is covered by the per-module tests and test/integration.test.js. The standalone
// mirror of these checks is scripts/check.mjs.
//
// v0.4.0 (ADR 0009, extends ADR 0008) keeps the per-workspace bus and adds three global
// memory layers in the reserved global journal `ws_0000000000000000`: `pattern` long-term
// memory (candidate-confirmed), the `profile` persona (six persona sections) and
// two-channel `style` cards.
//
// Run from the repository root:
//   node --test --test-force-exit "test/*.test.js"
//
// Node builtins only. Nothing here touches the network or the user's DSH profile.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_DIR = ROOT
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const INDEX_PATH = path.join(ROOT, 'index.js')
const CLIENT_PATH = path.join(ROOT, 'client.js')
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')
const ICON_PATH = path.join(ROOT, 'icon.svg')
const DOCS_README = path.join(ROOT, 'docs', 'README.md')
const LIB_DIR = path.join(ROOT, 'lib')

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

/** Runtime/display files that must be covered by package.json "files". */
const EXPECTED_FILES = [
  'index.js',
  'client.js',
  ...LIB_MODULES.map((name) => `lib/${name}`),
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
]

/** Declared Web-client manifest (client.js is the module id below). */
const EXPECTED_DSH_CLIENT = {
  platform: 'web',
  immediately: true,
  inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout'],
}

/** v0.4.0 locale inventory: 132 UI keys; these must exist in both locales. */
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
const RECORD_TYPES = ['pattern', 'style', 'memory-migration']
const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

/** Docs the index must name (design package + implementation docs). */
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
  'upgrade-v0.2.md',
  'upgrade-v0.3.md',
  'upgrade-v0.4.md',
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
  'publishing.md',
  'install.md',
  'planning/team-brief.md',
]

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {string} pattern @param {string} relPath */
function filesPatternMatches(pattern, relPath) {
  if (pattern === relPath) return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp('^' + escaped + '$').test(relPath)
}

/** Markdown link targets in a document, excluding absolute URLs and anchors. */
function markdownLinkTargets(text) {
  const targets = []
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http:, https:, mailto:
    if (target.startsWith('#')) continue
    targets.push(target.split('#')[0])
  }
  return targets
}

/** Lines in a text file (trailing newline does not add a line). */
function lineCount(file) {
  const text = readFileSync(file, 'utf8')
  if (text === '') return 0
  const lines = text.split(/\r?\n/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** Import a module in a fresh Node process and require it to stay silent. */
function importQuietly(importUrl) {
  const code = `await import(${JSON.stringify(importUrl)})`
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  })
}

/** Read every lib module plus index.js as `{ relPath, source }`. */
function hostSources() {
  const sources = LIB_MODULES.map((name) => ({
    relPath: `lib/${name}`,
    source: readFileSync(path.join(LIB_DIR, name), 'utf8'),
  }))
  sources.push({ relPath: 'index.js', source: readFileSync(INDEX_PATH, 'utf8') })
  return sources
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
  assert.equal(canonicalJson(actual), canonicalJson(expected), label)
}

/** Dependency-free YAML subset parser (same rules as scripts/check.mjs). */
function parseYamlSubset(text) {
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    lines.push({ indent: raw.length - raw.trimStart().length, text: trimmed })
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
    assert.ok(first !== undefined && first.indent === indent, `unexpected YAML at line ${index + 1}`)
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
      assert.ok(match !== null, `unexpected YAML mapping entry: ${line.text}`)
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
        assert.equal(line.indent, keyIndent, `unexpected YAML indentation: ${line.text}`)
        const entry = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/)
        assert.ok(entry !== null, `unexpected YAML sequence entry: ${line.text}`)
        index += 1
        map[entry[1]] = entry[2] === undefined ? parseValueAfter(keyIndent) : parseScalar(entry[2])
      }
      out.push(map)
    }
    return out
  }
  return parseBlock(0)
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test('package.json is a private ESM v0.4.0 three-layer bundle manifest with the Web client half', () => {
  assert.equal(PACKAGE_JSON.name, 'dsh-confluence')
  assert.equal(PACKAGE_JSON.version, '0.4.0')
  assert.equal(PACKAGE_JSON.private, true)
  assert.equal(PACKAGE_JSON.type, 'module')
  assert.equal(PACKAGE_JSON.main, './index.js')
  assert.equal(PACKAGE_JSON.license, 'MIT')
  assert.match(PACKAGE_JSON.description, /workspace session bus/i)
  assert.match(PACKAGE_JSON.description, /long-term memory/i)
  assert.match(PACKAGE_JSON.description, /persona/i)
  assert.match(PACKAGE_JSON.description, /style/i)
  assert.match(PACKAGE_JSON.description, /offline/i)
  assert.doesNotMatch(PACKAGE_JSON.description, /design-stage/i)
  assert.match(PACKAGE_JSON.author, /XiaoleC05/i)
  assert.match(PACKAGE_JSON.repository.url, /github\.com\/XiaoleC05\/Confluence\.git$/)
  assert.equal(PACKAGE_JSON.homepage, 'https://github.com/XiaoleC05/Confluence#readme')
  assert.match(PACKAGE_JSON.bugs.url, /github\.com\/XiaoleC05\/Confluence\/issues$/)
  assert.deepEqual(PACKAGE_JSON.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.deepEqual(PACKAGE_JSON.dsh.client, EXPECTED_DSH_CLIENT)
})

test('package.json exports and files cover exactly the implemented runtime surface', () => {
  const exports = PACKAGE_JSON.exports
  assert.equal(exports['.'], './index.js')
  assert.equal(exports['./client'], './client.js')
  assert.equal(exports['./locale/*.json'], './locale/*.json')
  assert.equal(exports['./icon'], './icon.svg')
  assert.deepEqual(Object.keys(exports).sort(), ['.', './client', './icon', './locale/*.json'])

  assert.ok(Array.isArray(PACKAGE_JSON.files))
  assert.ok(PACKAGE_JSON.files.includes('lib/*.js'), 'files must cover the Host modules')
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(PACKAGE_JSON.files.includes(required), `files must include ${required}`)
  }
  for (const relPath of EXPECTED_FILES) {
    assert.ok(existsSync(path.join(PACKAGE_DIR, relPath)), `missing runtime file ${relPath}`)
    assert.ok(
      PACKAGE_JSON.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      `runtime file ${relPath} is not covered by package.json files`,
    )
  }
  // Nothing shipped may be pulled in from development-only trees.
  for (const relPath of ['test/contract.test.js', 'docs/README.md', 'examples/profile-patch.yml', 'scripts/check.mjs', 'scripts/memory-export.mjs']) {
    assert.equal(
      PACKAGE_JSON.files.some((pattern) => filesPatternMatches(pattern, relPath)),
      false,
      `files must not cover development file ${relPath}`,
    )
  }
})

test('package.json engines, scripts and dependency-free posture are honest', () => {
  assert.equal(PACKAGE_JSON.engines.node, '>=22.19.0')
  assert.equal(PACKAGE_JSON.engines.dsh, '>=0.2.2-rc.1')
  assert.equal(PACKAGE_JSON.scripts.test, 'node --test --test-force-exit "test/*.test.js"')
  assert.equal(PACKAGE_JSON.scripts.check, 'node scripts/check.mjs')
  assert.ok(Array.isArray(PACKAGE_JSON.keywords))
  assert.ok(PACKAGE_JSON.keywords.includes('dsh'))
  assert.equal(PACKAGE_JSON.dependencies, undefined)
  assert.equal(PACKAGE_JSON.devDependencies, undefined)
  assert.equal(PACKAGE_JSON.peerDependencies, undefined)
})

// ---------------------------------------------------------------------------
// bundle patch
// ---------------------------------------------------------------------------

test('cordis.patch.yml inserts exactly one confluence row without !!js', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.equal((patch.match(/^\s*-\s*id:\s*confluence\s*$/gm) ?? []).length, 1)
  assert.equal((patch.match(/^\s*name:\s*['"]?dsh-confluence['"]?\s*$/gm) ?? []).length, 1)
  assert.match(patch, /^\s*config:$/m)
  assert.equal(patch.includes('!!js'), false, 'the bundle patch must not use !!js expressions')
})

test('cordis.patch.yml carries the complete v0.4.0 default configuration', () => {
  const patch = readFileSync(PATCH_PATH, 'utf8')
  for (const section of ['store', 'bus', 'profile', 'memory', 'style', 'ledger', 'recall', 'privacy', 'ui', 'debug']) {
    assert.match(patch, new RegExp(`^        ${section}:$`, 'm'), `missing config section ${section}`)
  }
  assert.match(patch, /^        enabled: true$/m)
  const expectedSnippets = [
    "dir: ''",
    'retentionDays: 90',
    'maxOpenWorkspaces: 16',
    'maxFacts: 200',
    'maxInjectChars: 1200',
    'maxPatterns: 300',
    'maxInjectPatterns: 5',
    'candidateConfidence: 0.5',
    'autoCapture: candidate',
    'maxRules: 100',
    'maxInjectCharsChat: 600',
    'maxInjectCharsEngineering: 900',
    'maxHits: 5',
    'timeoutMs: 5000',
    'redact: true',
    'privateSessions: []',
    'redactPatterns: []',
    "logFile: ''",
  ]
  for (const snippet of expectedSnippets) {
    assert.ok(patch.includes(snippet), `patch is missing default config value: ${snippet}`)
  }
  assert.ok(!patch.includes('disabledWorkspaces'), 'the patch must not carry the removed privacy.disabledWorkspaces')
  assert.ok(!patch.includes('maxSessionsPerWorkspace'), 'the patch must use ledger.maxSessions, not the old key')
  assert.ok(!/^\s+maxEntriesPerWorkspace:/m.test(patch), 'the patch must not carry the deprecated note cap name')
  assert.ok(!/^        export:$/m.test(patch), 'the patch must not carry the removed export section')
  assert.ok(!/^        pulse:$/m.test(patch), 'the patch must not carry the removed top-level pulse section')

  // Patch ↔ lib/config.js DEFAULTS deep equality (same parser as scripts/check.mjs).
  const parsed = parseYamlSubset(patch)
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].insert.length, 1)
  assert.equal(parsed[0].insert[0].id, 'confluence')
  assert.equal(parsed[0].insert[0].name, 'dsh-confluence')
  return import(pathToFileURL(path.join(LIB_DIR, 'config.js')).href).then(({ DEFAULTS }) => {
    deepEqual(parsed[0].insert[0].config, DEFAULTS, 'bundle row config vs lib/config.js DEFAULTS')
  })
})

// ---------------------------------------------------------------------------
// locale resources
// ---------------------------------------------------------------------------

test('locale resources parse and carry meaningful v0.4 display metadata', () => {
  for (const locale of ['en', 'zh']) {
    const file = path.join(ROOT, 'locale', `${locale}.json`)
    assert.ok(existsSync(file), `missing locale ${locale}`)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof parsed.meta?.title, 'string')
    assert.ok(parsed.meta.title.trim().length >= 2, `${locale} meta.title is too short`)
    assert.equal(typeof parsed.meta?.description, 'string')
    assert.ok(parsed.meta.description.trim().length >= 20, `${locale} meta.description is too short`)
  }
  const en = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))
  assert.equal(en.meta.title, 'Confluence')
  assert.equal(zh.meta.title, '高级记忆')
  assert.equal(
    en.meta.description,
    'Workspace session bus, long-term memory patterns, a portable user persona and style cards, fully offline.',
  )
  assert.equal(zh.meta.description, '工作区会话总线、长期记忆、可移植用户画像与风格卡，完全离线运行。')
})

test('locale UI key sets are aligned and keep the three-tab panel strings', () => {
  const en = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(path.join(ROOT, 'locale', 'zh.json'), 'utf8'))
  const enKeys = Object.keys(en.ui).sort()
  const zhKeys = Object.keys(zh.ui).sort()
  assert.deepEqual(enKeys, zhKeys, 'en/zh UI key sets must be identical')
  assert.equal(enKeys.length, 132, 'v0.4.0 ships 132 UI keys for the three-tab panel')
  const keys = new Set(enKeys)
  for (const key of REQUIRED_LOCALE_KEYS) {
    assert.ok(keys.has(key), `missing panel string ${key}`)
    assert.ok(typeof en.ui[key] === 'string' && en.ui[key].trim() !== '', `empty en string ${key}`)
    assert.ok(typeof zh.ui[key] === 'string' && zh.ui[key].trim() !== '', `empty zh string ${key}`)
  }
  assert.equal(en.ui['tab.bus'], 'Workspace bus')
  assert.equal(zh.ui['tab.bus'], '工作区总线')
  assert.equal(en.ui['tab.memory'], 'Long-term memory')
  assert.equal(zh.ui['tab.memory'], '长期记忆')
  assert.equal(en.ui['tab.profile'], 'User profile')
  assert.equal(zh.ui['tab.profile'], '用户画像')
  assert.equal(en.ui['scope.global'], 'All sessions')
  assert.equal(zh.ui['scope.global'], '全部会话')
  for (const [key, value] of Object.entries(en.ui)) {
    assert.equal(typeof value, 'string', `en ui.${key} must be a string`)
    assert.ok(value.trim() !== '', `en ui.${key} must be non-empty`)
  }
})

// ---------------------------------------------------------------------------
// icon
// ---------------------------------------------------------------------------

test('icon.svg is an original, self-contained, script-free vector', () => {
  const buffer = readFileSync(ICON_PATH)
  assert.ok(buffer.length > 200, 'icon.svg is suspiciously small')
  assert.ok(buffer.length < 256 * 1024, 'icon.svg exceeds the 256 KiB limit')
  const svg = buffer.toString('utf8')
  assert.match(svg, /^<svg\b/)
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /viewBox="/)
  assert.doesNotMatch(svg, /<script/i)
  assert.doesNotMatch(svg, /<text/i, 'design requires text-free artwork')
  assert.doesNotMatch(svg, /<image\b/i)
  assert.doesNotMatch(svg, /\b(?:href|src)\s*=\s*["'](?:https?:)?\/\//i, 'no external references allowed')
  assert.doesNotMatch(svg, /xlink:href/i)
  assert.ok((svg.match(/<path\b/g) ?? []).length >= 3, 'expected multi-stream geometry')
})

// ---------------------------------------------------------------------------
// Host entry
// ---------------------------------------------------------------------------

test('index.js imports cleanly and has no import side effects', () => {
  const result = importQuietly(pathToFileURL(INDEX_PATH).href)
  assert.equal(result.error, undefined, `spawn failed: ${result.error?.message}`)
  assert.equal(result.status, 0, `import failed:\n${result.stderr}`)
  assert.equal(result.stdout.trim(), '', 'importing index.js must not write to stdout')
  assert.equal(result.stderr.trim(), '', 'importing index.js must not write to stderr')
})

test('index.js exports the implemented Host entry surface', async () => {
  const module = await import(pathToFileURL(INDEX_PATH).href)
  const { DEFAULTS } = await import(pathToFileURL(path.join(LIB_DIR, 'config.js')).href)
  assert.equal(module.name, 'confluence')
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.applyWithDeps, 'function', 'applyWithDeps must be exported for hermetic tests')
  assert.equal(module.default, undefined, 'must use the apply(ctx, config) export form')
  assert.equal(module.VERSION, '0.4.0')
  assert.equal(typeof module.DEFAULTS, 'object')
  assert.equal(Object.isFrozen(module.DEFAULTS), true, 'DEFAULTS must stay frozen')
  assert.ok(Array.isArray(module.inject), 'inject must be an array')
  assert.ok(module.inject.includes('tools'), "inject must include 'tools'")
  assert.deepEqual(JSON.parse(JSON.stringify(module.DEFAULTS)), DEFAULTS)
})

// ---------------------------------------------------------------------------
// v0.4.0 prompt contributions and memory layers
// ---------------------------------------------------------------------------

test('v0.4.0 four prompt contributions (profile 1400 / memory 1410 / style 1420 / pulse 1500)', async () => {
  const pulse = await import(pathToFileURL(path.join(LIB_DIR, 'pulse.js')).href)
  const watermark = await import(pathToFileURL(path.join(LIB_DIR, 'watermark.js')).href)
  const facade = await import(pathToFileURL(path.join(LIB_DIR, 'facade.js')).href)
  const hostui = await import(pathToFileURL(path.join(LIB_DIR, 'hostui.js')).href)
  const actual = [
    { name: pulse.PROFILE_CONTEXT_NAME, order: pulse.PROFILE_CONTEXT_ORDER },
    { name: pulse.MEMORY_CONTEXT_NAME, order: pulse.MEMORY_CONTEXT_ORDER },
    { name: pulse.STYLE_CONTEXT_NAME, order: pulse.STYLE_CONTEXT_ORDER },
    { name: pulse.PULSE_CONTEXT_NAME, order: pulse.PULSE_CONTEXT_ORDER },
  ]
  assert.deepEqual(actual, PROMPT_CONTRIBUTIONS)
  assert.equal(watermark.PULSE_TAG_NAME, PULSE_TAG_NAME)
  assert.equal(watermark.INBOX_TOOL, 'confluence_inbox')
  assert.equal(facade.MEMORY_SCOPE, undefined, 'the retired v0.2 memory-scope constant must stay gone')
  assert.deepEqual({ ...facade.PROFILE_SCOPE }, PROFILE_SCOPE)
  assert.deepEqual({ ...hostui.PANEL_SCOPE }, PROFILE_SCOPE)

  const pulseSource = readFileSync(path.join(LIB_DIR, 'pulse.js'), 'utf8')
  assert.ok(pulseSource.includes("const PULSE_SCOPE_ATTR = 'workspace'"), 'the pulse scope attribute must be workspace')
  assert.ok(pulseSource.includes('<confluence-memory scope="${PULSE_SCOPE_ATTR}"'), 'the pulse must emit the workspace tag')
  const memorySource = readFileSync(path.join(LIB_DIR, 'memory.js'), 'utf8')
  assert.ok(memorySource.includes("'<confluence-memory-patterns'"), 'memory must emit <confluence-memory-patterns>')
  assert.ok(memorySource.includes('candidates="'), 'memory block must carry the candidates attribute')
  const styleSource = readFileSync(path.join(LIB_DIR, 'style.js'), 'utf8')
  assert.ok(styleSource.includes("'<confluence-style'"), 'style must emit <confluence-style>')
  assert.ok(styleSource.includes('chat="'), 'style block must carry the chat attribute')
  const profileSource = readFileSync(path.join(LIB_DIR, 'profile.js'), 'utf8')
  assert.ok(profileSource.includes("'<confluence-profile'"), 'the profile block must emit <confluence-profile>')
  const watermarkSource = readFileSync(path.join(LIB_DIR, 'watermark.js'), 'utf8')
  assert.ok(watermarkSource.includes('confluence-workspace'), 'legacy <confluence-workspace> snapshots must stay parseable')
})

test('persona contract: six sections, legacy aliases, non-persona sections skipped', async () => {
  const profile = await import(pathToFileURL(path.join(LIB_DIR, 'profile.js')).href)
  assert.deepEqual(profile.PROFILE_SECTIONS.slice(), PERSONA_SECTIONS)
  assert.deepEqual(profile.PROFILE_RENDER_ORDER.slice(), PERSONA_SECTIONS)
  assert.deepEqual(profile.PROFILE_LEGACY_ALIAS_SECTIONS.slice(), ['preferences', 'rules'])
  assert.deepEqual({ ...profile.LEGACY_SECTION_ALIASES }, { preferences: 'communication', rules: 'boundaries' })
  assert.deepEqual(profile.PROFILE_NON_PERSONA_SECTIONS.slice(), ['tech', 'context'])
  assert.equal(profile.PROFILE_DOC_FORMAT, 'confluence.profile/v1', 'legacy profile document format kept for import')
  assert.equal(profile.PROFILE_DOC_VERSION, 1)
  const facts = profile.foldProfile([
    {
      v: 1,
      type: 'profile',
      id: `prf_${ULID_A}`,
      ws: GLOBAL_SCOPE_KEY,
      section: 'preferences',
      key: 'answer.language',
      value: 'zh',
      confidence: 0.9,
      source: 'user',
      seq: ULID_A,
      ts: '2026-01-01T00:00:00.000Z',
    },
  ]).facts
  assert.equal(facts.length, 1)
  assert.equal(facts[0].section, 'communication', 'legacy preferences section folds into communication')
})

test('long-term memory + style-card contracts (folds, defaults, vocabularies)', async () => {
  const memory = await import(pathToFileURL(path.join(LIB_DIR, 'memory.js')).href)
  const style = await import(pathToFileURL(path.join(LIB_DIR, 'style.js')).href)
  const { DEFAULTS } = await import(pathToFileURL(path.join(LIB_DIR, 'config.js')).href)
  assert.deepEqual({ ...memory.MEMORY_DEFAULTS }, DEFAULTS.memory)
  assert.deepEqual({ ...style.STYLE_DEFAULTS }, DEFAULTS.style)
  assert.deepEqual(memory.PATTERN_CATEGORIES.slice(), PATTERN_CATEGORIES)
  assert.deepEqual(memory.PATTERN_STATUSES.slice(), ['candidate', 'active', 'rejected', 'superseded'])
  assert.deepEqual(memory.PATTERN_SCOPES.slice(), ['global', 'workspace'])
  assert.deepEqual(memory.PATTERN_SOURCES.slice(), ['agent', 'user', 'import', 'migration'])
  assert.deepEqual(style.STYLE_CHANNELS.slice(), STYLE_CHANNELS)
  assert.deepEqual(style.STYLE_AREAS.slice(), STYLE_AREAS)

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
  assert.equal(patterns.counts.total, 1, 'pattern fold dedupes by key')
  assert.equal(patterns.counts.active, 1)
  assert.equal(patterns.active[0].title, 'active title', 'pattern LWW by seq')

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
  assert.equal(styles.active.length, 1, 'style fold dedupes by (channel,key)')
  assert.equal(styles.active[0].title, 'new', 'style LWW by seq')
})

// ---------------------------------------------------------------------------
// tools and panel routes
// ---------------------------------------------------------------------------

test('the eight v0.4 tools are registered in order with persona/memory/style wording', async () => {
  const { createTools } = await import(pathToFileURL(path.join(LIB_DIR, 'tools.js')).href)
  const definitions = createTools({}, {})
  assert.ok(Array.isArray(definitions))
  assert.deepEqual(definitions.map((definition) => definition.name), TOOL_NAMES)
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  const description = (name) => String(byName.get(name).description)
  assert.match(description('confluence_board'), /workspace/i)
  assert.match(description('confluence_board'), /untrusted/i)
  assert.match(description('confluence_context'), /workspace/i)
  assert.match(description('confluence_context'), /untrusted/i)
  assert.match(description('confluence_send'), /queue/i)
  assert.match(description('confluence_send'), /interrupt|wake/i)
  assert.match(description('confluence_inbox'), /untrusted/i)
  assert.match(description('confluence_profile'), /persona/i)
  assert.match(description('confluence_profile'), /preferences/i)
  assert.match(description('confluence_memory'), /candidate/i)
  assert.match(description('confluence_memory'), /promote/i)
  assert.match(description('confluence_memory'), /untrusted/i)
  assert.match(description('confluence_style'), /chat/i)
  assert.match(description('confluence_style'), /engineering/i)
  assert.match(description('confluence_recall'), /earlier sessions on this machine/i)

  const source = readFileSync(path.join(LIB_DIR, 'tools.js'), 'utf8')
  assert.match(source, /inbox=/, 'the inbox result must render the inbox= cursor marker')
  assert.match(source, /through=/, 'board/read results must keep the through= marker')
  assert.match(source, /NO_WORKSPACE/, 'bus tools must keep the NO_WORKSPACE error path')
  for (const retired of ['confluence_post', 'confluence_read', 'confluence_search', 'confluence_reply']) {
    assert.doesNotMatch(source, new RegExp(`name: '${retired}'`), `retired v0.2 tool must be gone: ${retired}`)
  }
})

test('the panel exposes exactly seven read-only routes for the three views', async () => {
  const hostui = await import(pathToFileURL(path.join(LIB_DIR, 'hostui.js')).href)
  const routes = hostui.hostuiInternals.ROUTES
  assert.deepEqual(routes.map((route) => route.name), PANEL_ROUTE_NAMES)
  assert.deepEqual(
    routes.map((route) => route.path.replace(`${hostui.HOSTUI_PREFIX}/`, '')),
    PANEL_ROUTE_PATHS,
  )
  assert.ok(routes.every((route) => typeof route.run === 'function'), 'every route must build a payload')
  assert.equal(routes.find((route) => route.name === 'profile-export').download, true, 'profile/export must be a download')
  assert.ok(!routes.some((route) => route.name === 'overview'), 'the retired overview route must be gone')
  const source = readFileSync(path.join(LIB_DIR, 'hostui.js'), 'utf8')
  assert.match(source, /normalizeWorkspaceId/, 'the panel must normalize workspace ids to opaque hashes')
  assert.doesNotMatch(source, /workspaceKey/, 'panel payloads must not carry a workspace key')
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('v0.4.0 config defaults and the retained v0.3 deprecation mappings', async () => {
  const { DEFAULTS: LIB_DEFAULTS, resolveConfig } = await import(pathToFileURL(path.join(LIB_DIR, 'config.js')).href)
  assert.equal(LIB_DEFAULTS.store.maxOpenWorkspaces, 16)
  assert.equal(LIB_DEFAULTS.memory.maxPatterns, 300)
  assert.equal(LIB_DEFAULTS.memory.maxInjectPatterns, 5)
  assert.equal(LIB_DEFAULTS.memory.candidateConfidence, 0.5)
  assert.equal(LIB_DEFAULTS.memory.autoCapture, 'candidate')
  assert.equal(LIB_DEFAULTS.style.maxRules, 100)
  assert.equal(LIB_DEFAULTS.style.maxInjectCharsChat, 600)
  assert.equal(LIB_DEFAULTS.style.maxInjectCharsEngineering, 900)
  assert.equal(LIB_DEFAULTS.profile.maxFacts, 200)
  assert.equal(LIB_DEFAULTS.store.maxEntriesPerWorkspace, undefined, 'the v0.2 note cap name is retired')
  assert.equal(LIB_DEFAULTS.pulse, undefined, 'the v0.2 top-level pulse section is retired')
  assert.equal(LIB_DEFAULTS.export, undefined, 'the v0.2 export section is retired')

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
    assert.ok(deprecated.warnings.includes(warning), `expected ${warning} in ${JSON.stringify(deprecated.warnings)}`)
  }
  assert.equal(deprecated.config.bus.notes.maxEntries, 1234, 'the deprecated note cap must be mapped')
  assert.equal(deprecated.config.bus.pulse.maxChars, 900, 'the deprecated pulse.maxChars must be mapped')

  const v02 = resolveConfig({
    privacy: { privateSessions: [], disabledWorkspaces: ['ws_0123456789abcdef'] },
    ledger: { maxSessionsPerWorkspace: 50 },
  })
  assert.ok(v02.warnings.includes('CONFIG_DEPRECATED privacy.disabledWorkspaces'))
  assert.ok(v02.warnings.includes('CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace'))
  assert.equal(v02.config.ledger.maxSessions, 50)

  const clean = resolveConfig({ memory: { maxPatterns: 42 }, style: { maxRules: 7 } })
  assert.deepEqual(clean.warnings, [])
  assert.equal(clean.config.memory.maxPatterns, 42)
  assert.equal(clean.config.style.maxRules, 7)
})

test('export portability: confluence.memory/v1, legacy profile document and producer version', async () => {
  const exportModule = await import(pathToFileURL(path.join(LIB_DIR, 'export.js')).href)
  assert.equal(exportModule.MEMORY_DOC_FORMAT, 'confluence.memory/v1')
  assert.equal(exportModule.MEMORY_DOC_VERSION, 1)
  assert.equal(exportModule.MEMORY_DOC_KIND, 'memory')
  assert.equal(exportModule.MEMORY_DOC_SCOPE, 'global')
  assert.equal(exportModule.PROFILE_DOC_FORMAT, 'confluence.profile/v1', 'legacy document format kept for import compatibility')
  assert.equal(exportModule.PROFILE_DOC_VERSION, 1)
  assert.equal(typeof exportModule.buildMemoryDocument, 'function')
  assert.equal(typeof exportModule.validateMemoryDocument, 'function')
  assert.equal(typeof exportModule.importMemoryDocument, 'function')
  assert.equal(typeof exportModule.renderMemoryMarkdown, 'function')
  assert.equal(exportModule.EXPORT_PRODUCER.name, 'dsh-confluence')
  assert.equal(exportModule.EXPORT_PRODUCER.version, '0.4.0', 'the export producer version must match the package')
  assert.equal(exportModule.EXPORT_SCOPE, 'global')
})

// ---------------------------------------------------------------------------
// per-scope store
// ---------------------------------------------------------------------------

test('the store keeps per-scope journals and accepts the v0.4 global record types', async () => {
  const { JournalStore } = await import(pathToFileURL(path.join(LIB_DIR, 'store.js')).href)
  const root = mkdtempSync(path.join(tmpdir(), 'confluence-contract-store-'))
  const wsKey = 'ws_0123456789abcdef'
  try {
    const store = new JournalStore({ config: { store: { dir: root } } })
    const globalJournal = await store.openGlobal()
    assert.equal(globalJournal.wsKey, GLOBAL_SCOPE_KEY)
    assert.equal(
      path.relative(root, globalJournal.dir),
      path.join('workspaces', GLOBAL_SCOPE_KEY),
      'the global journal must live under workspaces/ws_0000000000000000',
    )
    assert.deepEqual(store.legacyWorkspaceMeta(), [], 'a fresh store has no pre-existing workspace metadata')
    assert.deepEqual(store.legacyRecords(), [], 'a fresh store has no legacy records')

    const records = [
      { v: 1, type: 'pattern', id: `pat_${ULID_A}`, key: 'e2e.retry', category: 'pitfall', title: 't', body: 'b', status: 'active', confidence: 0.8, source: 'user' },
      { v: 1, type: 'style', id: `sty_${ULID_B}`, channel: 'chat', area: 'tone', key: 'e2e.tone', title: 't', rule: 'r', priority: 50, enabled: true, confidence: 0.8, source: 'user' },
      { v: 1, type: 'memory-migration', id: `mig_${ULID_A}`, version: 1, source: 'profile-v03' },
    ]
    for (const record of records) {
      const stored = await globalJournal.append(record)
      assert.equal(stored.ws, GLOBAL_SCOPE_KEY, `${record.type} must use the global scope`)
    }
    const globalTypes = store.viewedRecords(GLOBAL_SCOPE_KEY).map((record) => record.type).sort()
    assert.deepEqual(globalTypes, ['memory-migration', 'pattern', 'style'])
    for (const type of RECORD_TYPES) assert.ok(globalTypes.includes(type), `global view is missing ${type}`)

    const workspaceJournal = await store.openWorkspace(wsKey, { canonicalPath: 'd:\\e2e\\workspace', label: 'e2e' })
    assert.equal(
      path.relative(root, workspaceJournal.dir),
      path.join('workspaces', wsKey),
      'the workspace journal must live under workspaces/<wsKey>',
    )
    await workspaceJournal.append({ type: 'entry', id: 'cnf_contract_workspace', kind: 'finding', title: 'workspace note' })
    assert.ok(
      store.viewedRecords(wsKey).some((record) => record.id === 'cnf_contract_workspace'),
      'the workspace view must carry its own note',
    )
    for (const type of RECORD_TYPES) {
      assert.equal(
        store.viewedRecords(wsKey).some((record) => record.type === type),
        false,
        `global ${type} records must not leak into a workspace view`,
      )
    }
    assert.equal(store.mergedRecords().length, 3, 'the global alias view carries only the global memory records')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// offline posture and client half
// ---------------------------------------------------------------------------

test('production host code stays offline and the client half is a read-only same-origin module', () => {
  const networkImport = /from\s+['"]node:(?:http|https|net|tls|dgram|child_process)['"]|require\(\s*['"]node:(?:http|https|net|tls|dgram|child_process)['"]\s*\)/
  const harnessImport = /from\s+['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\//
  const fetchCall = /\bfetch\s*\(/
  // `new URL(relative, 'http://127.0.0.1')` is a parser base, not an egress target.
  const parserBase = /['"]http:\/\/127\.0\.0\.1['"]/g
  for (const { relPath, source } of hostSources()) {
    assert.doesNotMatch(source, networkImport, `${relPath} must not import network/child-process modules`)
    assert.doesNotMatch(source, harnessImport, `${relPath} must not import @deepseek-ai packages`)
    assert.doesNotMatch(source, fetchCall, `${relPath} must not call fetch()`)
    const withoutParserBase = source.replace(parserBase, "''")
    assert.doesNotMatch(withoutParserBase, /https?:\/\//, `${relPath} must not contain network URL literals`)
  }

  const client = readFileSync(CLIENT_PATH, 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/, 'client.js must use the Dynamic ModuleLoader')
  assert.match(client, /id:\s*'dsh-confluence'/, "client.js module id must be 'dsh-confluence'")
  assert.doesNotMatch(client, /^\s*import\s/m, 'client.js is a plain browser module, not an ESM import graph')
  assert.doesNotMatch(client, harnessImport, 'client.js must not import @deepseek-ai packages')
  const fetchCalls = client.match(/\bfetch\s*\(/g) ?? []
  assert.equal(fetchCalls.length, 1, 'client.js must have exactly one fetch call (the relative panel GET)')
  assert.match(client, /fetch\(ROUTE_BASE/, 'the only fetch must target the relative panel route base')
  assert.doesNotMatch(client, /https?:\/\//, 'client.js must not contain absolute URLs')
  assert.doesNotMatch(client, /\binnerHTML\b|dangerouslySetInnerHTML/, 'panel must render untrusted text as React children')
  assert.doesNotMatch(client, /<iframe|createElement\(['"]iframe/, 'no iframe transport is allowed')
  assert.match(client, /inject:\s*\[\s*'slots'\s*,\s*'locale'\s*,\s*'layout'\s*\]/, 'client inject list changed')
  assert.match(client, /name:\s*'sidebar\.panellist'[\s\S]{0,120}id:\s*'confluence'[\s\S]{0,120}order:\s*30/)
  assert.match(client, /name:\s*'main'[\s\S]{0,120}key:\s*'confluence'/)
  // v0.4.0: three read-only views, seven routes, no retired overview route.
  assert.match(client, /高级记忆 \/ Confluence memory/, 'the panel title must stay the Confluence memory title')
  for (const tab of ['bus', 'memory', 'profile']) {
    assert.match(client, new RegExp(`t\\('tab\\.${tab}'\\)`), `the panel must render the ${tab} tab`)
  }
  for (const route of ['/workspaces', '/bus', '/entry', '/profile']) {
    assert.match(client, new RegExp(`request\\('${route.replace('/', '\\/')}'`), `the panel must call the ${route} route`)
  }
  assert.match(client, /request\('\/memory'/, 'the panel must call the memory route')
  assert.match(client, /'\/profile\/export\?format=/, 'the panel must link the profile export download')
  assert.doesNotMatch(client, /'\/overview'/, 'the retired /overview route must not be called')
  assert.doesNotMatch(client, /workspaceKey|workspace_key/, 'panel requests must not carry a workspace key')
  assert.match(client, /ws:\s*options\.ws/, 'bus/entry requests must pass the opaque ws id')
})

// ---------------------------------------------------------------------------
// repository documentation
// ---------------------------------------------------------------------------

test('README.md and README.zh-CN.md describe the v0.4.0 state honestly', () => {
  const en = path.join(ROOT, 'README.md')
  const zh = path.join(ROOT, 'README.zh-CN.md')
  assert.ok(existsSync(en), 'missing README.md')
  assert.ok(existsSync(zh), 'missing README.zh-CN.md')
  const enText = readFileSync(en, 'utf8')
  const zhText = readFileSync(zh, 'utf8')
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
    assert.ok(enText.includes(marker), `README.md is missing required content: ${marker}`)
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
    assert.ok(zhText.includes(marker), `README.zh-CN.md is missing required content: ${marker}`)
  }
  assert.match(enText.replace(/\s+/g, ' '), /not (been )?(installed|verified|executed)/i, 'README must keep the not-executed claims')
  assert.match(enText, /panel's rendering/i, 'README must keep the panel-rendering honesty')
  assert.doesNotMatch(enText.replace(/\s+/g, ' '), /design-stage scaffold/i, 'README must no longer describe a design-stage scaffold as current state')
  assert.doesNotMatch(enText, /workspace is the consent boundary/i, 'README must not claim the v0.1.0 privacy boundary')
  for (const [file, text] of [['README.md', enText], ['README.zh-CN.md', zhText]]) {
    const lines = lineCount(path.join(ROOT, file))
    assert.ok(lines >= 200 && lines <= 800, `${file} must be 200–800 lines (found ${lines})`)
  }
})

test('docs/README.md exists, links resolve, and names every promised document', () => {
  assert.ok(existsSync(DOCS_README), 'missing docs/README.md')
  const text = readFileSync(DOCS_README, 'utf8')
  for (const target of markdownLinkTargets(text)) {
    const resolved = path.resolve(path.join(ROOT, 'docs'), target)
    assert.ok(
      existsSync(resolved) && statSync(resolved).isFile(),
      `docs/README.md link target does not exist: ${target}`,
    )
  }
  for (const required of REQUIRED_DOCS) {
    assert.ok(text.includes(required), `docs/README.md must mention ${required}`)
  }
})

test('documents promised by docs/README.md exist and are non-empty Markdown', () => {
  for (const required of REQUIRED_DOCS) {
    const file = path.join(ROOT, 'docs', required)
    assert.ok(existsSync(file), `docs/README.md promises a missing doc: ${required}`)
    assert.ok(statSync(file).size > 200, `doc ${required} is suspiciously empty`)
    assert.match(readFileSync(file, 'utf8'), /^#\s/m, `doc ${required} must start with a Markdown heading`)
  }
})

test('install, publishing and upgrade-v0.4 docs keep the v0.4 executed/not-executed honesty', () => {
  const install = path.join(ROOT, 'docs', 'install.md')
  const publishing = path.join(ROOT, 'docs', 'publishing.md')
  const upgrade = path.join(ROOT, 'docs', 'upgrade-v0.4.md')
  assert.ok(existsSync(install), 'missing docs/install.md')
  assert.ok(existsSync(publishing), 'missing docs/publishing.md')
  assert.ok(existsSync(upgrade), 'missing docs/upgrade-v0.4.md')
  const installText = readFileSync(install, 'utf8')
  const publishingText = readFileSync(publishing, 'utf8')
  const upgradeText = readFileSync(upgrade, 'utf8')
  for (const marker of [
    'install_bundle',
    'dsh plugin --profile',
    'Not executed',
    'scratch',
    'rollback',
    'restart',
    'memory.maxPatterns',
    'style.maxRules',
    'ws_0000000000000000',
    'confluence-memory',
    'confluence-profile',
    'confluence.memory/v1',
    'memory-export.mjs',
  ]) {
    assert.ok(installText.includes(marker), `install.md is missing: ${marker}`)
  }
  for (const marker of ['npm pack', 'version', 'checksum', 'nothing was published', 'GitHub', '0.4.0', 'confluence.memory/v1']) {
    assert.ok(publishingText.toLowerCase().includes(marker.toLowerCase()), `publishing.md is missing: ${marker}`)
  }
  for (const marker of [
    'persona',
    'pattern',
    'style',
    'migration',
    'Restart',
    'Rollback',
    'read-only',
    'confluence.profile/v1',
  ]) {
    assert.ok(upgradeText.includes(marker), `upgrade-v0.4.md is missing: ${marker}`)
  }
})

// ---------------------------------------------------------------------------
// shipped file set
// ---------------------------------------------------------------------------

test('the shipped runtime surface is exactly the implemented Host modules, client and resources', () => {
  const actualLib = readdirSync(LIB_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
  assert.deepEqual(actualLib, LIB_MODULES.slice().sort(), 'lib/ module set changed without a packaging update')
  assert.equal(LIB_MODULES.length, 20, 'the v0.4.0 Host has exactly 20 lib modules')
  assert.ok((PACKAGE_JSON.files ?? []).includes('lib/*.js'), 'files must ship lib/*.js')
  for (const relPath of EXPECTED_FILES) {
    assert.ok(existsSync(path.join(ROOT, relPath)), `missing shipped file ${relPath}`)
  }
  const indexSource = readFileSync(INDEX_PATH, 'utf8')
  assert.match(indexSource, /from '\.\/lib\//, 'index.js must import the Host modules')
})

// ---------------------------------------------------------------------------
// standalone checker
// ---------------------------------------------------------------------------

test('scripts/check.mjs runs standalone and passes', () => {
  const checker = path.join(ROOT, 'scripts', 'check.mjs')
  assert.ok(existsSync(checker), 'missing scripts/check.mjs')
  const result = spawnSync(process.execPath, ['scripts/check.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(result.error, undefined, `checker spawn failed: ${result.error?.message}`)
  assert.equal(result.status, 0, `scripts/check.mjs failed:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  assert.match(result.stdout, /passed/i)
})
