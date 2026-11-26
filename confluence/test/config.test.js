// WP1 unit tests — lib/config.js (v0.3)
// Covers DEFAULTS == shipped cordis.patch.yml row config, deterministic
// warnings, never-throwing resolution, sanitized public view, and the v0.2
// deprecation mappings of the v0.3 config families (bus/profile).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, publicConfig, resolveConfig } from '../lib/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH_PATH = path.join(ROOT, 'cordis.patch.yml')

// ---------------------------------------------------------------------------
// Minimal YAML-subset reader for the one bundle patch file (test-local only;
// the plugin itself carries no YAML dependency).
// ---------------------------------------------------------------------------

/** @param {string} line */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** @param {string} raw */
function parseScalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null') return null
  if (raw === '[]') return []
  if (raw === '{}') return {}
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1)
  }
  return raw
}

/** @param {{indent: number, text: string}[]} lines @param {number} index @param {number} indent */
function parseMapping(lines, index, indent) {
  const value = {}
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) {
      i += 1
      continue
    }
    if (line.text.startsWith('- ')) break
    const colon = line.text.indexOf(':')
    if (colon < 0) {
      i += 1
      continue
    }
    const key = line.text.slice(0, colon).trim()
    const rest = line.text.slice(colon + 1).trim()
    if (rest !== '') {
      value[key] = parseScalar(rest)
      i += 1
      continue
    }
    if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const child = parseNode(lines, i + 1, lines[i + 1].indent)
      value[key] = child.value
      i = child.next
    } else {
      value[key] = null
      i += 1
    }
  }
  return { value, next: i }
}

/** @param {{indent: number, text: string}[]} lines @param {number} index @param {number} indent */
function parseSequence(lines, index, indent) {
  const value = []
  let i = index
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent !== indent || !line.text.startsWith('- ')) break
    const rest = line.text.slice(2).trim()
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const child = parseNode(lines, i + 1, lines[i + 1].indent)
        value.push(child.value)
        i = child.next
      } else {
        value.push(null)
        i += 1
      }
      continue
    }
    if (/^[^:'"]+:/.test(rest) && !rest.startsWith("'") && !rest.startsWith('"')) {
      const virtual = [{ indent: indent + 2, text: rest }, ...lines.slice(i + 1)]
      const child = parseMapping(virtual, 0, indent + 2)
      value.push(child.value)
      i += child.next
      continue
    }
    value.push(parseScalar(rest))
    i += 1
  }
  return { value, next: i }
}

/** @param {{indent: number, text: string}[]} lines @param {number} index @param {number} indent */
function parseNode(lines, index, indent) {
  return lines[index].text.startsWith('- ') ? parseSequence(lines, index, indent) : parseMapping(lines, index, indent)
}

/** @param {string} source */
function parseYamlSubset(source) {
  const lines = []
  for (const raw of source.split(/\r?\n/)) {
    const stripped = stripComment(raw)
    if (stripped.trim() === '') continue
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() })
  }
  const root = parseNode(lines, 0, lines[0].indent)
  assert.equal(root.next, lines.length, 'test YAML reader must consume the whole patch file')
  return root.value
}

/** @returns {object} the bundle row config from cordis.patch.yml */
function readPatchRowConfig() {
  const parsed = parseYamlSubset(readFileSync(PATCH_PATH, 'utf8'))
  assert.ok(Array.isArray(parsed) && parsed.length === 1, 'patch has one top-level list')
  const insert = parsed[0].insert
  assert.ok(Array.isArray(insert) && insert.length === 1, 'patch inserts one row')
  assert.equal(insert[0].id, 'confluence')
  return insert[0].config
}

// ---------------------------------------------------------------------------
// defaults / patch parity
// ---------------------------------------------------------------------------

test('UT-CONFIG-01 DEFAULTS deep-equal the shipped cordis.patch.yml row config and are frozen', () => {
  const patchConfig = readPatchRowConfig()
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULTS)), patchConfig)
  assert.ok(Object.isFrozen(DEFAULTS), 'DEFAULTS must be frozen')
  for (const section of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[section] === 'object' && DEFAULTS[section] !== null) {
      assert.ok(Object.isFrozen(DEFAULTS[section]), `${section} must be frozen`)
    }
  }
  assert.ok(Object.isFrozen(DEFAULTS.privacy.denyPathPatterns))
  assert.ok(Object.isFrozen(DEFAULTS.privacy.redactPatterns))
  assert.deepEqual(DEFAULTS.privacy.redactPatterns, [], 'redactPatterns ships as []')
  // v0.3 families
  assert.equal(DEFAULTS.bus.context.maxKeys, 200)
  assert.equal(DEFAULTS.bus.messages.maxStored, 500)
  assert.equal(DEFAULTS.bus.pulse.maxMessages, 3)
  assert.equal(DEFAULTS.profile.maxFacts, 200)
  assert.equal(DEFAULTS.profile.minConfidence, 0.3)
  assert.equal(DEFAULTS.memory.maxPatterns, 300)
  assert.equal(DEFAULTS.memory.maxInjectPatterns, 5)
  assert.equal(DEFAULTS.memory.autoCapture, 'candidate')
  assert.equal(DEFAULTS.style.maxRules, 100)
  assert.equal(DEFAULTS.style.maxInjectCharsChat, 600)
  assert.equal(DEFAULTS.style.maxInjectCharsEngineering, 900)
  assert.equal('maxEntriesPerWorkspace' in DEFAULTS.store, false, 'v0.3 moved the note cap under bus.notes')
  assert.equal('pulse' in DEFAULTS, false, 'v0.3 moved the pulse caps under bus.pulse')
  assert.equal('export' in DEFAULTS, false, 'v0.3 removed the export config family')
})

// ---------------------------------------------------------------------------
// invalid values / warnings
// ---------------------------------------------------------------------------

test('UT-CONFIG-02 bad values fall back with stable sorted warnings and never throw', () => {
  const raw = {
    enabled: 'yes',
    store: { retentionDays: 3, maxBodyBytes: 'big', pollMs: 5, watch: 'no', dir: 123 },
    bus: { context: { maxKeys: 0 }, pulse: { maxChars: 2000, maxMessages: 9 } },
    ledger: { maxFilesPerSession: 99 },
    recall: { timeoutMs: 10 },
    privacy: { redactTitles: false, denyPathPatterns: ['**/*.pem', 'bad['], redactPatterns: ['(', 'ok.*'] },
    ui: { pollMs: 999999 },
    debug: { logFile: 'relative.txt' },
  }
  const { config, warnings } = resolveConfig(raw)

  assert.equal(config.enabled, true)
  assert.equal(config.store.retentionDays, 90)
  assert.equal(config.store.maxBodyBytes, 8192)
  assert.equal(config.store.pollMs, 1000, 'store.pollMs is clamped to the documented minimum')
  assert.equal(config.store.watch, true)
  assert.equal(config.store.dir, '')
  assert.equal(config.bus.context.maxKeys, 200)
  assert.equal(config.bus.pulse.maxChars, 1400)
  assert.equal(config.bus.pulse.maxMessages, 3)
  assert.equal(config.ledger.maxFilesPerSession, 8)
  assert.equal(config.recall.timeoutMs, 5000)
  assert.equal(config.profile.maxFacts, 200, 'untouched sections keep their defaults')
  assert.equal(config.privacy.redactTitles, false, 'false is accepted (documented tradeoff)')
  assert.deepEqual(config.privacy.denyPathPatterns, ['**/*.pem'], 'bad glob dropped')
  assert.deepEqual(config.privacy.redactPatterns, ['ok.*'], 'bad regex dropped')
  assert.equal(config.ui.pollMs, 30000, 'ui.pollMs is clamped, not reset')
  assert.equal(config.debug.logFile, '')

  const expected = [
    'CONFIG_INVALID_VALUE bus.context.maxKeys',
    'CONFIG_INVALID_VALUE bus.pulse.maxChars',
    'CONFIG_INVALID_VALUE bus.pulse.maxMessages',
    'CONFIG_INVALID_VALUE enabled',
    'CONFIG_INVALID_VALUE ledger.maxFilesPerSession',
    'CONFIG_INVALID_VALUE recall.timeoutMs',
    'CONFIG_INVALID_VALUE store.dir',
    'CONFIG_INVALID_VALUE store.maxBodyBytes',
    'CONFIG_INVALID_VALUE store.pollMs',
    'CONFIG_INVALID_VALUE store.retentionDays',
    'CONFIG_INVALID_VALUE store.watch',
    'CONFIG_INVALID_VALUE ui.pollMs',
    'CONFIG_PATH_INVALID debug.logFile',
    'CONFIG_PATTERN_INVALID privacy.denyPathPatterns#1',
    'CONFIG_PATTERN_INVALID privacy.redactPatterns#0',
    'PRIVACY_TITLES_UNREDACTED privacy.redactTitles',
  ].sort()
  assert.deepEqual([...warnings].sort(), expected)
  for (const line of warnings) assert.match(line, /^[A-Z_]+ [a-z][A-Za-z0-9.#]*$/)
  assert.deepEqual(warnings, [...warnings].sort(), 'warnings are sorted by (CODE, field, index)')
})

test('UT-CONFIG-02b out-of-range/unknown-typed values never throw and stay capped at 20 warnings', () => {
  const raw = { store: 'not-an-object', privacy: ['no'], bus: { pulse: { maxMessages: 4 } } }
  const invalidBus = resolveConfig({ bus: 'nope' })
  const { config, warnings } = resolveConfig(raw)
  assert.equal(config.store.pollMs, DEFAULTS.store.pollMs)
  assert.equal(config.bus.pulse.maxMessages, 4, '4 is in range and accepted')
  assert.ok(warnings.includes('PULSE_BUDGET_RISK bus.pulse.maxMessages'))
  assert.ok(warnings.includes('CONFIG_INVALID_VALUE store'))
  assert.ok(warnings.includes('CONFIG_INVALID_VALUE privacy'))
  assert.ok(invalidBus.warnings.includes('CONFIG_INVALID_VALUE bus'))

  const many = {}
  for (let i = 0; i < 30; i += 1) many[`unknown${i}`] = i
  const capped = resolveConfig(many)
  assert.equal(capped.warnings.length, 20, 'warnings are capped at 20')
  assert.ok(capped.warnings.every((line) => line.startsWith('CONFIG_UNKNOWN_FIELD')))

  for (const weird of [undefined, null, 'nope', 42, [], { store: null }, { privacy: { denyPathPatterns: 'x' } }]) {
    assert.doesNotThrow(() => resolveConfig(weird))
    const result = resolveConfig(weird)
    assert.equal(typeof result.config, 'object')
    assert.ok(Array.isArray(result.warnings))
  }
})

test('UT-CONFIG-02c memory/style invalid values fall back with warnings', () => {
  const { config, warnings } = resolveConfig({
    memory: {
      enabled: 'yes',
      inject: 1,
      maxPatterns: 0,
      maxInjectPatterns: 99,
      maxInjectChars: 10,
      candidateConfidence: 2,
      autoCapture: 'bogus',
    },
    style: { enabled: 'yes', inject: 1, maxRules: 0, maxInjectCharsChat: 1, maxInjectCharsEngineering: 1 },
  })
  assert.equal(config.memory.enabled, true)
  assert.equal(config.memory.inject, true)
  assert.equal(config.memory.maxPatterns, 300)
  assert.equal(config.memory.maxInjectPatterns, 5)
  assert.equal(config.memory.maxInjectChars, 1200)
  assert.equal(config.memory.candidateConfidence, 0.5)
  assert.equal(config.memory.autoCapture, 'candidate')
  assert.equal(config.style.enabled, true)
  assert.equal(config.style.inject, true)
  assert.equal(config.style.maxRules, 100)
  assert.equal(config.style.maxInjectCharsChat, 600)
  assert.equal(config.style.maxInjectCharsEngineering, 900)
  const expected = [
    'CONFIG_INVALID_VALUE memory.autoCapture',
    'CONFIG_INVALID_VALUE memory.candidateConfidence',
    'CONFIG_INVALID_VALUE memory.enabled',
    'CONFIG_INVALID_VALUE memory.inject',
    'CONFIG_INVALID_VALUE memory.maxInjectChars',
    'CONFIG_INVALID_VALUE memory.maxInjectPatterns',
    'CONFIG_INVALID_VALUE memory.maxPatterns',
    'CONFIG_INVALID_VALUE style.enabled',
    'CONFIG_INVALID_VALUE style.inject',
    'CONFIG_INVALID_VALUE style.maxInjectCharsChat',
    'CONFIG_INVALID_VALUE style.maxInjectCharsEngineering',
    'CONFIG_INVALID_VALUE style.maxRules',
  ].sort()
  assert.deepEqual([...warnings].sort(), expected)
})

test('UT-CONFIG-03 unknown keys are ignored; a whole-object override still yields complete defaults', () => {
  const { config, warnings } = resolveConfig({ foo: 1, store: { bar: 2 }, bus: { baz: 3 } })
  assert.ok(warnings.includes('CONFIG_UNKNOWN_FIELD foo'))
  assert.ok(warnings.includes('CONFIG_UNKNOWN_FIELD store.bar'))
  assert.ok(warnings.includes('CONFIG_UNKNOWN_FIELD bus.baz'))
  assert.deepEqual(JSON.parse(JSON.stringify(config)), JSON.parse(JSON.stringify(DEFAULTS)))

  const partial = { store: { pollMs: 8000 }, privacy: { denyPathPatterns: ['**/secret*'] } }
  const resolved = resolveConfig(partial).config
  assert.equal(resolved.store.pollMs, 8000)
  assert.equal(resolved.store.maxBodyBytes, 8192)
  assert.deepEqual(resolved.privacy.denyPathPatterns, ['**/secret*'])
  assert.equal(resolved.recall.maxHits, 5)
  assert.equal(resolved.bus.pulse.maxChars, 1400)
})

test('UT-CONFIG-04 boundary values are accepted without warnings', () => {
  const raw = {
    store: { retentionDays: 7, maxBodyBytes: 49152, pollMs: 1000, dir: 'D:\\stores\\confluence', maxOpenWorkspaces: 1 },
    bus: {
      context: { maxKeys: 2000, maxValueBytes: 32768 },
      notes: { maxEntries: 50 },
      messages: { maxStored: 20, maxBodyBytes: 128 },
      pulse: { maxChars: 400, maxMessages: 0, maxStateKeys: 0, maxPeers: 0 },
    },
    profile: { maxFacts: 1, maxInjectChars: 1600, minConfidence: 0, maxValueBytes: 64, maxExportBytes: 1024 },
    memory: { maxPatterns: 5000, maxInjectPatterns: 20, maxInjectChars: 6000, candidateConfidence: 1, autoCapture: 'off' },
    style: { maxRules: 2000, maxInjectCharsChat: 4000, maxInjectCharsEngineering: 4000 },
    ledger: { maxFilesPerSession: 0, maxSessions: 20 },
    recall: { maxSessions: 10, maxHits: 20, timeoutMs: 30000 },
    ui: { pollMs: 2000 },
  }
  const { config, warnings } = resolveConfig(raw)
  // Maximum per-block budgets are accepted but flagged as budget risks.
  assert.deepEqual(
    [...warnings].sort(),
    ['MEMORY_BUDGET_RISK memory.maxInjectChars', 'STYLE_BUDGET_RISK style.maxInjectChars...'],
  )
  assert.equal(config.store.retentionDays, 7)
  assert.equal(config.store.maxBodyBytes, 49152)
  assert.equal(config.store.pollMs, 1000)
  assert.equal(config.bus.context.maxValueBytes, 32768)
  assert.equal(config.bus.pulse.maxMessages, 0)
  assert.equal(config.memory.maxPatterns, 5000)
  assert.equal(config.memory.autoCapture, 'off')
  assert.equal(config.style.maxRules, 2000)
  assert.equal(config.style.maxInjectCharsEngineering, 4000)
  assert.equal(config.profile.minConfidence, 0)
  assert.equal(config.ui.pollMs, 2000)
})

test('UT-CONFIG-05 privacy lists: valid session ids accepted, invalid dropped; per-workspace opt-out is deprecated', () => {
  const { config, warnings } = resolveConfig({
    privacy: {
      privateSessions: ['session-abc-123', 'x', 'ok_id-2'],
      disabledWorkspaces: ['ws_0123456789abcdef', 'D:\\05_Code\\scratch'],
    },
  })
  assert.deepEqual(config.privacy.privateSessions, ['session-abc-123', 'ok_id-2'])
  assert.equal('disabledWorkspaces' in config.privacy, false, 'v0.2.0 has no per-workspace boundary')
  assert.ok(warnings.includes('CONFIG_INVALID_VALUE privacy.privateSessions#1'))
  assert.ok(warnings.includes('CONFIG_DEPRECATED privacy.disabledWorkspaces'))
})

test('UT-CONFIG-05b v0.2 keys are mapped with deprecation warnings', () => {
  const ledger = resolveConfig({ ledger: { maxSessionsPerWorkspace: 50 } })
  assert.equal(ledger.config.ledger.maxSessions, 50)
  assert.ok(ledger.warnings.includes('CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace'))
  const modern = resolveConfig({ ledger: { maxSessions: 50, maxSessionsPerWorkspace: 900 } })
  assert.equal(modern.config.ledger.maxSessions, 50, 'new key wins when both are present')

  const notes = resolveConfig({ store: { maxEntriesPerWorkspace: 123 } })
  assert.equal(notes.config.bus.notes.maxEntries, 123)
  assert.ok(notes.warnings.includes('CONFIG_DEPRECATED store.maxEntriesPerWorkspace'))
  const notesNew = resolveConfig({ store: { maxEntriesPerWorkspace: 123 }, bus: { notes: { maxEntries: 456 } } })
  assert.equal(notesNew.config.bus.notes.maxEntries, 456, 'bus.notes.maxEntries wins')

  const pulse = resolveConfig({ pulse: { enabled: false, maxHeadlines: 2, maxPeers: 1, maxChars: 600 } })
  assert.equal(pulse.config.bus.pulse.enabled, false)
  assert.equal(pulse.config.bus.pulse.maxMessages, 2)
  assert.equal(pulse.config.bus.pulse.maxPeers, 1)
  assert.equal(pulse.config.bus.pulse.maxChars, 600)
  for (const key of ['pulse.enabled', 'pulse.maxHeadlines', 'pulse.maxPeers', 'pulse.maxChars']) {
    assert.ok(pulse.warnings.includes(`CONFIG_DEPRECATED ${key}`))
  }

  const legacyExport = resolveConfig({ export: { enabled: true, dir: 'x' } })
  assert.ok(legacyExport.warnings.includes('CONFIG_DEPRECATED export'))
  assert.equal('export' in legacyExport.config, false)
})

test('UT-CONFIG-06 publicConfig strips list contents to counts', () => {
  const { config } = resolveConfig({
    privacy: {
      privateSessions: ['session-super-secret'],
      redactPatterns: ['secret-pattern-.*'],
      denyPathPatterns: ['**/*.pem'],
    },
    debug: { logFile: 'C:\\Users\\someone\\debug.jsonl' },
  })
  const safe = publicConfig(config)
  const serialized = JSON.stringify(safe)
  assert.ok(!serialized.includes('session-super-secret'))
  assert.ok(!serialized.includes('secret-pattern'))
  assert.ok(!serialized.includes('Users'))
  assert.equal(safe.privacy.privateSessionsCount, 1)
  assert.equal(safe.privacy.redactPatternsCount, 1)
  assert.equal(safe.privacy.denyPathPatternsCount, 1)
  assert.equal('disabledWorkspacesCount' in safe.privacy, false)
  assert.equal(safe.debug.logFileEnabled, true)
  assert.equal(safe.bus.pulse.maxMessages, 3)
  assert.equal(safe.profile.maxFacts, 200)
  assert.equal(safe.memory.maxPatterns, 300)
  assert.equal(safe.memory.autoCapture, 'candidate')
  assert.equal(safe.style.maxInjectCharsChat, 600)
  assert.doesNotThrow(() => publicConfig(undefined))
})
