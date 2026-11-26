// Confluence / 高级记忆 — configuration contract (v3).
//
// v0.3 splits the configuration into the two product modules:
//   bus      — workspace session bus (context pool, notes, messages, pulse)
//   profile  — global user profile (facts, injection, portability)
// plus the unchanged store/ledger/presence/recall/privacy/ui/debug families.
//
// The Loader row config is untrusted JSON: every field is defaulted here, bad
// values fall back with a stable warning line, and resolveConfig never throws.
// Warning format: "<CODE> <field>[#<index>]", sorted by (CODE, field, index),
// capped at 20. DEFAULTS must deep-equal the bundle row config in
// cordis.patch.yml (packaging contract test asserts it).
//
// Deprecations carried from v0.2:
//   store.maxEntriesPerWorkspace -> bus.notes.maxEntries
//   pulse.*                      -> bus.pulse.*
//   export.*                     -> ignored (profile portability is tool/CLI)
//   ledger.maxSessionsPerWorkspace -> ledger.maxSessions
//   privacy.disabledWorkspaces   -> ignored

const RAW_DEFAULTS = {
  enabled: true,
  store: {
    dir: '',
    retentionDays: 90,
    maxBodyBytes: 8192,
    pollMs: 4000,
    watch: true,
    maxOpenWorkspaces: 16,
  },
  bus: {
    enabled: true,
    context: {
      maxKeys: 200,
      maxValueBytes: 8192,
    },
    notes: {
      maxEntries: 2000,
    },
    messages: {
      maxStored: 500,
      maxBodyBytes: 4096,
    },
    pulse: {
      enabled: true,
      maxChars: 1400,
      maxMessages: 3,
      maxStateKeys: 3,
      maxPeers: 2,
    },
  },
  profile: {
    enabled: true,
    inject: true,
    maxFacts: 200,
    maxInjectChars: 1200,
    minConfidence: 0.3,
    maxValueBytes: 1024,
    maxExportBytes: 65536,
  },
  memory: {
    enabled: true,
    inject: true,
    maxPatterns: 300,
    maxInjectPatterns: 5,
    maxInjectChars: 1200,
    candidateConfidence: 0.5,
    autoCapture: 'candidate',
  },
  style: {
    enabled: true,
    inject: true,
    maxRules: 100,
    maxInjectCharsChat: 600,
    maxInjectCharsEngineering: 900,
  },
  ledger: {
    enabled: true,
    maxFilesPerSession: 8,
    maxSessions: 200,
    fileHintsInPulse: false,
  },
  recall: { enabled: true, maxSessions: 3, maxHits: 5, timeoutMs: 5000 },
  privacy: {
    redact: true,
    redactTitles: true,
    denyPathPatterns: ['**/.env*', '**/*.pem'],
    privateSessions: [],
    redactPatterns: [],
  },
  ui: { enabled: true, pollMs: 5000 },
  debug: { logFile: '' },
}

/** @param {unknown} value */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    return Object.freeze(value)
  }
  return value
}

/** Complete v3 defaults (frozen, shared). */
export const DEFAULTS = deepFreeze(RAW_DEFAULTS)

const MAX_WARNINGS = 20

/**
 * Ordered schema of the config tree. `fields` is either a leaf descriptor or a
 * nested `{ fields }` object. Leaves: kind bool|int|float|string|array.
 */
const SCHEMA = {
  enabled: { kind: 'bool' },
  store: {
    fields: {
      dir: { kind: 'string', maxChars: 512, path: 'store' },
      retentionDays: { kind: 'int', range: [7, 3650] },
      maxBodyBytes: { kind: 'int', range: [256, 49152] },
      pollMs: { kind: 'int', range: [1000, 60000], clamp: true },
      watch: { kind: 'bool' },
      maxOpenWorkspaces: { kind: 'int', range: [1, 64] },
    },
  },
  bus: {
    fields: {
      enabled: { kind: 'bool' },
      context: {
        fields: {
          maxKeys: { kind: 'int', range: [1, 2000] },
          maxValueBytes: { kind: 'int', range: [64, 32768] },
        },
      },
      notes: {
        fields: {
          maxEntries: { kind: 'int', range: [50, 20000] },
        },
      },
      messages: {
        fields: {
          maxStored: { kind: 'int', range: [20, 5000] },
          maxBodyBytes: { kind: 'int', range: [128, 16384] },
        },
      },
      pulse: {
        fields: {
          enabled: { kind: 'bool' },
          maxChars: { kind: 'int', range: [400, 1400] },
          maxMessages: { kind: 'int', range: [0, 5] },
          maxStateKeys: { kind: 'int', range: [0, 5] },
          maxPeers: { kind: 'int', range: [0, 3] },
        },
      },
    },
  },
  profile: {
    fields: {
      enabled: { kind: 'bool' },
      inject: { kind: 'bool' },
      maxFacts: { kind: 'int', range: [1, 1000] },
      maxInjectChars: { kind: 'int', range: [200, 4000] },
      minConfidence: { kind: 'float', range: [0, 1] },
      maxValueBytes: { kind: 'int', range: [64, 8192] },
      maxExportBytes: { kind: 'int', range: [1024, 262144] },
    },
  },
  memory: {
    fields: {
      enabled: { kind: 'bool' },
      inject: { kind: 'bool' },
      maxPatterns: { kind: 'int', range: [1, 5000] },
      maxInjectPatterns: { kind: 'int', range: [0, 20] },
      maxInjectChars: { kind: 'int', range: [200, 6000] },
      candidateConfidence: { kind: 'float', range: [0, 1] },
      autoCapture: { kind: 'string', values: ['candidate', 'off'] },
    },
  },
  style: {
    fields: {
      enabled: { kind: 'bool' },
      inject: { kind: 'bool' },
      maxRules: { kind: 'int', range: [1, 2000] },
      maxInjectCharsChat: { kind: 'int', range: [100, 4000] },
      maxInjectCharsEngineering: { kind: 'int', range: [100, 4000] },
    },
  },
  ledger: {
    fields: {
      enabled: { kind: 'bool' },
      maxFilesPerSession: { kind: 'int', range: [0, 16] },
      maxSessions: { kind: 'int', range: [20, 1000] },
      fileHintsInPulse: { kind: 'bool' },
    },
  },
  recall: {
    fields: {
      enabled: { kind: 'bool' },
      maxSessions: { kind: 'int', range: [1, 10] },
      maxHits: { kind: 'int', range: [1, 20] },
      timeoutMs: { kind: 'int', range: [500, 30000] },
    },
  },
  ui: {
    fields: {
      enabled: { kind: 'bool' },
      pollMs: { kind: 'int', range: [2000, 30000], clamp: true },
    },
  },
  debug: {
    fields: {
      logFile: { kind: 'string', maxChars: 512, path: 'absolute' },
    },
  },
}

/** Accepted-but-removed top-level families (warned, ignored). */
const REMOVED_TOP_LEVEL = ['export', 'pulse']
const TOP_LEVEL_KEYS = ['enabled', ...Object.keys(SCHEMA).slice(1), 'privacy', ...REMOVED_TOP_LEVEL]

/** Keys accepted for the v0.2 migration but not part of the v3 schema. */
const SECTION_DEPRECATED_KEYS = {
  store: new Set(['maxEntriesPerWorkspace']),
  ledger: new Set(['maxSessionsPerWorkspace']),
}
const PRIVACY_KEYS = ['redact', 'redactTitles', 'denyPathPatterns', 'privateSessions', 'redactPatterns']

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clonePlain(item)
    return out
  }
  return value
}

/** @param {unknown} value @returns {boolean} windows device path (\\.\ or \\?\) */
function isDevicePath(value) {
  return typeof value === 'string' && /^\\\\[.?]\\/.test(value)
}

/** @param {unknown} value @returns {boolean} windows UNC path (\\server\share) */
function isUncPath(value) {
  return typeof value === 'string' && /^\\\\[^\\]/.test(value)
}

/** @param {unknown} value @returns {boolean} rooted path on either platform */
function isRootedPath(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || isUncPath(value) || isDevicePath(value))
  )
}

/** @param {string} pattern @returns {boolean} simple `*`/`**` glob only */
function isGlobPattern(pattern) {
  return (
    typeof pattern === 'string' &&
    pattern.length > 0 &&
    pattern.length <= 200 &&
    /^[A-Za-z0-9._\-/\\*]+$/.test(pattern)
  )
}

/** @param {unknown} value @returns {boolean} valid regex source */
function isRegexSource(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false
  try {
    // eslint-disable-next-line no-new
    new RegExp(value, 'giu')
    return true
  } catch {
    return false
  }
}

/** @param {unknown} field @returns {boolean} */
function isValidPrivateSessionId(field) {
  return typeof field === 'string' && /^[A-Za-z0-9._-]{4,128}$/.test(field)
}

/**
 * Resolve the Loader row config against the v3 defaults.
 *
 * @param {unknown} raw untrusted row config (possibly absent)
 * @returns {{ config: object, warnings: string[] }}
 */
export function resolveConfig(raw) {
  /** @type {{code: string, field: string, index: number | null}[]} */
  const collected = []
  const add = (code, field, index = null) => {
    collected.push({ code: String(code), field: String(field), index })
  }

  try {
    if (raw !== undefined && raw !== null && !isPlainObject(raw)) add('CONFIG_INVALID_VALUE', 'config')
    const source = isPlainObject(raw) ? raw : {}

    for (const key of Object.keys(source)) {
      if (!TOP_LEVEL_KEYS.includes(key)) add('CONFIG_UNKNOWN_FIELD', key)
    }

    /** @type {object} */
    const config = { enabled: true }
    config.enabled = readBool(source, 'enabled', DEFAULTS.enabled, 'enabled', add)

    for (const [section, descriptor] of Object.entries(SCHEMA)) {
      if (section === 'enabled') continue
      if (!('fields' in descriptor)) continue
      config[section] = resolveObject(
        isPlainObject(source[section]) ? source[section] : {},
        DEFAULTS[section],
        descriptor.fields,
        section,
        add,
        source[section] !== undefined && !isPlainObject(source[section]) ? true : false,
        SECTION_DEPRECATED_KEYS[section],
      )
    }

    // --- v0.2 deprecations: map the old families onto v0.3 ---
    const rawStore = isPlainObject(source.store) ? source.store : {}
    const rawBus = isPlainObject(source.bus) ? source.bus : {}
    const rawPulse = isPlainObject(source.pulse) ? source.pulse : {}
    const rawExport = isPlainObject(source.export) ? source.export : {}

    if (Object.prototype.hasOwnProperty.call(rawStore, 'maxEntriesPerWorkspace')) {
      const hasNew = isPlainObject(rawBus.notes) && Object.prototype.hasOwnProperty.call(rawBus.notes, 'maxEntries')
      if (!hasNew) {
        const mapped = readInt(rawStore, 'maxEntriesPerWorkspace', DEFAULTS.bus.notes.maxEntries, 'store.maxEntriesPerWorkspace', [50, 20000], add)
        config.bus.notes.maxEntries = mapped
      }
      add('CONFIG_DEPRECATED', 'store.maxEntriesPerWorkspace')
    }
    if (Object.keys(rawPulse).length > 0) {
      const pulseMap = [
        ['enabled', 'enabled'],
        ['maxHeadlines', 'maxMessages'],
        ['maxPeers', 'maxPeers'],
        ['maxChars', 'maxChars'],
      ]
      for (const [oldKey, newKey] of pulseMap) {
        if (!Object.prototype.hasOwnProperty.call(rawPulse, oldKey)) continue
        const hasNew = isPlainObject(rawBus.pulse) && Object.prototype.hasOwnProperty.call(rawBus.pulse, newKey)
        if (!hasNew) {
          const descriptor = SCHEMA.bus.fields.pulse.fields[newKey]
          const fallback = DEFAULTS.bus.pulse[newKey]
          const field = `pulse.${oldKey}`
          if (descriptor.kind === 'bool') config.bus.pulse[newKey] = readBool(rawPulse, oldKey, fallback, field, add)
          else if (descriptor.kind === 'int') config.bus.pulse[newKey] = readInt(rawPulse, oldKey, fallback, field, descriptor.range, add, { clamp: descriptor.clamp })
        }
        add('CONFIG_DEPRECATED', `pulse.${oldKey}`)
      }
    }
    if (Object.keys(rawExport).length > 0) add('CONFIG_DEPRECATED', 'export')

    // --- v0.2 ledger rename (kept from the previous contract) ---
    // (handled here rather than in the generic resolver for a stable warning)
    const rawLedger = isPlainObject(source.ledger) ? source.ledger : {}
    if (Object.prototype.hasOwnProperty.call(rawLedger, 'maxSessionsPerWorkspace')) {
      if (!Object.prototype.hasOwnProperty.call(rawLedger, 'maxSessions')) {
        config.ledger.maxSessions = readInt(
          rawLedger,
          'maxSessionsPerWorkspace',
          DEFAULTS.ledger.maxSessions,
          'ledger.maxSessionsPerWorkspace',
          [20, 1000],
          add,
        )
      }
      add('CONFIG_DEPRECATED', 'ledger.maxSessionsPerWorkspace')
      if (Object.prototype.hasOwnProperty.call(config.ledger, 'maxSessionsPerWorkspace')) delete config.ledger.maxSessionsPerWorkspace
    }

    // --- privacy (arrays + deprecations) ---
    const privacyRaw = isPlainObject(source.privacy) ? source.privacy : {}
    if (source.privacy !== undefined && !isPlainObject(source.privacy)) {
      add('CONFIG_INVALID_VALUE', 'privacy')
    }
    const privacy = config.privacy ?? clonePlain(DEFAULTS.privacy)
    for (const key of Object.keys(privacyRaw)) {
      if (key === 'disabledWorkspaces') {
        add('CONFIG_DEPRECATED', 'privacy.disabledWorkspaces')
        continue
      }
      if (!PRIVACY_KEYS.includes(key)) add('CONFIG_UNKNOWN_FIELD', `privacy.${key}`)
    }
    privacy.redact = readBool(privacyRaw, 'redact', DEFAULTS.privacy.redact, 'privacy.redact', add)
    privacy.redactTitles = readBool(privacyRaw, 'redactTitles', DEFAULTS.privacy.redactTitles, 'privacy.redactTitles', add)
    if (typeof privacyRaw.redactTitles === 'boolean' && privacyRaw.redactTitles === false) {
      add('PRIVACY_TITLES_UNREDACTED', 'privacy.redactTitles')
    }
    privacy.denyPathPatterns = readArray(
      privacyRaw.denyPathPatterns,
      DEFAULTS.privacy.denyPathPatterns,
      'privacy.denyPathPatterns',
      { maxItems: 32, isValid: isGlobPattern, invalidCode: 'CONFIG_PATTERN_INVALID' },
      add,
    )
    privacy.privateSessions = readArray(
      privacyRaw.privateSessions,
      DEFAULTS.privacy.privateSessions,
      'privacy.privateSessions',
      { maxItems: 256, isValid: isValidPrivateSessionId, invalidCode: 'CONFIG_INVALID_VALUE' },
      add,
    )
    privacy.redactPatterns = readArray(
      privacyRaw.redactPatterns,
      DEFAULTS.privacy.redactPatterns,
      'privacy.redactPatterns',
      { maxItems: 20, isValid: isRegexSource, invalidCode: 'CONFIG_PATTERN_INVALID' },
      add,
    )
    config.privacy = privacy

    // --- semantic path checks (syntactic only; the store resolves roots) ---
    if (isDevicePath(config.store.dir) || isUncPath(config.store.dir)) {
      add('CONFIG_PATH_INVALID', 'store.dir')
      config.store.dir = DEFAULTS.store.dir
    }
    if (config.debug.logFile !== '' && !isRootedPath(config.debug.logFile)) {
      add('CONFIG_PATH_INVALID', 'debug.logFile')
      config.debug.logFile = DEFAULTS.debug.logFile
    }

    if (config.bus.pulse.maxMessages > 3) add('PULSE_BUDGET_RISK', 'bus.pulse.maxMessages')
    if (config.profile.maxInjectChars > 1600) add('PROFILE_BUDGET_RISK', 'profile.maxInjectChars')
    if (config.memory.maxInjectChars > 2000) add('MEMORY_BUDGET_RISK', 'memory.maxInjectChars')
    if (config.style.maxInjectCharsChat + config.style.maxInjectCharsEngineering > 3000) {
      add('STYLE_BUDGET_RISK', 'style.maxInjectChars...')
    }

    return { config, warnings: formatWarnings(collected) }
  } catch {
    // Absolute safety net: this function must never throw on a bad config.
    add('CONFIG_INVALID_VALUE', 'config')
    return { config: clonePlain(DEFAULTS), warnings: formatWarnings(collected) }
  }
}

/**
 * Resolve one object level of the schema.
 *
 * @param {Record<string, unknown>} source
 * @param {object} defaults
 * @param {Record<string, object>} fields
 * @param {string} prefix
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @param {boolean} invalidSection
 * @param {Set<string>} [deprecatedKeys]
 * @returns {object}
 */
function resolveObject(source, defaults, fields, prefix, add, invalidSection, deprecatedKeys) {
  if (invalidSection) add('CONFIG_INVALID_VALUE', prefix)
  for (const key of Object.keys(source)) {
    if (!(key in fields) && !(deprecatedKeys !== undefined && deprecatedKeys.has(key))) {
      add('CONFIG_UNKNOWN_FIELD', `${prefix}.${key}`)
    }
  }
  /** @type {object} */
  const out = {}
  for (const [key, descriptor] of Object.entries(fields)) {
    const field = `${prefix}.${key}`
    const fallback = defaults[key]
    if ('fields' in descriptor) {
      const rawChild = source[key]
      const validChild = rawChild === undefined || isPlainObject(rawChild)
      if (!validChild) add('CONFIG_INVALID_VALUE', field)
      out[key] = resolveObject(
        isPlainObject(rawChild) ? rawChild : {},
        fallback,
        descriptor.fields,
        field,
        add,
        rawChild !== undefined && !isPlainObject(rawChild),
      )
      continue
    }
    out[key] = readLeaf(source, key, fallback, field, descriptor, add)
  }
  return out
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {unknown} fallback
 * @param {string} field
 * @param {object} descriptor
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @returns {unknown}
 */
function readLeaf(source, key, fallback, field, descriptor, add) {
  if (!(key in source)) return fallback
  const value = source[key]
  switch (descriptor.kind) {
    case 'bool':
      return readBool(source, key, fallback, field, add)
    case 'int':
      return readInt(source, key, fallback, field, descriptor.range, add, { clamp: descriptor.clamp === true })
    case 'float':
      return readFloat(source, key, fallback, field, descriptor.range, add)
    case 'string': {
      if (Array.isArray(descriptor.values)) return readEnum(source, key, fallback, field, descriptor.values, add)
      const value2 = readString(source, key, fallback, field, add, descriptor.maxChars)
      if (descriptor.path === 'absolute' && value2 !== '' && typeof value2 === 'string' && !isRootedPath(value2)) {
        add('CONFIG_PATH_INVALID', field)
        return fallback
      }
      return value2
    }
    default:
      return fallback
  }
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {boolean} fallback
 * @param {string} field
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @returns {boolean}
 */
function readBool(source, key, fallback, field, add) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value === 'boolean') return value
  add('CONFIG_INVALID_VALUE', field)
  return fallback
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {number} fallback
 * @param {string} field
 * @param {[number, number] | undefined} range
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @param {{ clamp?: boolean }} [options]
 * @returns {number}
 */
function readInt(source, key, fallback, field, range, add, options = {}) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    add('CONFIG_INVALID_VALUE', field)
    return fallback
  }
  if (!range) return value
  const [min, max] = range
  if (value < min || value > max) {
    add('CONFIG_INVALID_VALUE', field)
    if (options.clamp) return Math.min(max, Math.max(min, value))
    return fallback
  }
  return value
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {number} fallback
 * @param {string} field
 * @param {[number, number] | undefined} range
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @returns {number}
 */
function readFloat(source, key, fallback, field, range, add) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    add('CONFIG_INVALID_VALUE', field)
    return fallback
  }
  if (!range) return value
  const [min, max] = range
  if (value < min || value > max) {
    add('CONFIG_INVALID_VALUE', field)
    return fallback
  }
  return value
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} fallback
 * @param {string} field
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @param {number | undefined} maxChars
 * @returns {string}
 */
function readString(source, key, fallback, field, add, maxChars) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value !== 'string' || (maxChars !== undefined && value.length > maxChars)) {
    add('CONFIG_INVALID_VALUE', field)
    return fallback
  }
  return value
}

/**
 * Read a string restricted to a closed set (unknown values fall back with a warning).
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string} fallback
 * @param {string} field
 * @param {readonly string[]} values
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @returns {string}
 */
function readEnum(source, key, fallback, field, values, add) {
  if (!(key in source)) return fallback
  const value = source[key]
  if (typeof value === 'string' && values.includes(value)) return value
  add('CONFIG_INVALID_VALUE', field)
  return fallback
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fallback
 * @param {string} field
 * @param {{maxItems: number, isValid: (item: unknown) => boolean, invalidCode: string}} options
 * @param {(code: string, field: string, index?: number | null) => void} add
 * @returns {string[]}
 */
function readArray(value, fallback, field, options, add) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    add('CONFIG_INVALID_VALUE', field)
    return [...fallback]
  }
  const out = []
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i]
    if (out.length >= options.maxItems) {
      add('CONFIG_INVALID_VALUE', field)
      break
    }
    if (!options.isValid(item)) {
      add(options.invalidCode, field, i)
      continue
    }
    out.push(item)
  }
  return out
}

/**
 * Sort/dedupe/cap warning records and render stable `"CODE field[#index]"` lines.
 *
 * @param {{code: string, field: string, index: number | null}[]} collected
 * @returns {string[]}
 */
function formatWarnings(collected) {
  const unique = new Map()
  for (const item of collected) {
    const line = item.index === null || item.index === undefined ? `${item.code} ${item.field}` : `${item.code} ${item.field}#${item.index}`
    unique.set(line, item)
  }
  const list = [...unique.values()]
  list.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    if (a.field !== b.field) return a.field < b.field ? -1 : 1
    const ai = a.index ?? -1
    const bi = b.index ?? -1
    return ai - bi
  })
  return list.slice(0, MAX_WARNINGS).map((item) =>
    item.index === null || item.index === undefined ? `${item.code} ${item.field}` : `${item.code} ${item.field}#${item.index}`,
  )
}

/**
 * Sanitized view of a resolved config for UI/status output: pattern lists and
 * private session ids are reduced to counts so a panel/ping payload can never
 * leak them.
 *
 * @param {object} config resolved config (from resolveConfig)
 * @returns {object}
 */
export function publicConfig(config) {
  const value = isPlainObject(config) ? config : DEFAULTS
  const privacy = isPlainObject(value.privacy) ? value.privacy : DEFAULTS.privacy
  const count = (list) => (Array.isArray(list) ? list.length : 0)
  const int = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  return {
    enabled: value.enabled !== false,
    store: {
      dir: typeof value.store?.dir === 'string' ? value.store.dir : '',
      retentionDays: int(value.store?.retentionDays, DEFAULTS.store.retentionDays),
      maxBodyBytes: int(value.store?.maxBodyBytes, DEFAULTS.store.maxBodyBytes),
      pollMs: int(value.store?.pollMs, DEFAULTS.store.pollMs),
      watch: value.store?.watch !== false,
      maxOpenWorkspaces: int(value.store?.maxOpenWorkspaces, DEFAULTS.store.maxOpenWorkspaces),
    },
    bus: {
      enabled: value.bus?.enabled !== false,
      context: {
        maxKeys: int(value.bus?.context?.maxKeys, DEFAULTS.bus.context.maxKeys),
        maxValueBytes: int(value.bus?.context?.maxValueBytes, DEFAULTS.bus.context.maxValueBytes),
      },
      notes: { maxEntries: int(value.bus?.notes?.maxEntries, DEFAULTS.bus.notes.maxEntries) },
      messages: {
        maxStored: int(value.bus?.messages?.maxStored, DEFAULTS.bus.messages.maxStored),
        maxBodyBytes: int(value.bus?.messages?.maxBodyBytes, DEFAULTS.bus.messages.maxBodyBytes),
      },
      pulse: {
        enabled: value.bus?.pulse?.enabled !== false,
        maxChars: int(value.bus?.pulse?.maxChars, DEFAULTS.bus.pulse.maxChars),
        maxMessages: int(value.bus?.pulse?.maxMessages, DEFAULTS.bus.pulse.maxMessages),
        maxStateKeys: int(value.bus?.pulse?.maxStateKeys, DEFAULTS.bus.pulse.maxStateKeys),
        maxPeers: int(value.bus?.pulse?.maxPeers, DEFAULTS.bus.pulse.maxPeers),
      },
    },
    profile: {
      enabled: value.profile?.enabled !== false,
      inject: value.profile?.inject !== false,
      maxFacts: int(value.profile?.maxFacts, DEFAULTS.profile.maxFacts),
      maxInjectChars: int(value.profile?.maxInjectChars, DEFAULTS.profile.maxInjectChars),
      minConfidence: typeof value.profile?.minConfidence === 'number' ? value.profile.minConfidence : DEFAULTS.profile.minConfidence,
      maxValueBytes: int(value.profile?.maxValueBytes, DEFAULTS.profile.maxValueBytes),
      maxExportBytes: int(value.profile?.maxExportBytes, DEFAULTS.profile.maxExportBytes),
    },
    memory: {
      enabled: value.memory?.enabled !== false,
      inject: value.memory?.inject !== false,
      maxPatterns: int(value.memory?.maxPatterns, DEFAULTS.memory.maxPatterns),
      maxInjectPatterns: int(value.memory?.maxInjectPatterns, DEFAULTS.memory.maxInjectPatterns),
      maxInjectChars: int(value.memory?.maxInjectChars, DEFAULTS.memory.maxInjectChars),
      candidateConfidence: typeof value.memory?.candidateConfidence === 'number' ? value.memory.candidateConfidence : DEFAULTS.memory.candidateConfidence,
      autoCapture: value.memory?.autoCapture === 'off' ? 'off' : 'candidate',
    },
    style: {
      enabled: value.style?.enabled !== false,
      inject: value.style?.inject !== false,
      maxRules: int(value.style?.maxRules, DEFAULTS.style.maxRules),
      maxInjectCharsChat: int(value.style?.maxInjectCharsChat, DEFAULTS.style.maxInjectCharsChat),
      maxInjectCharsEngineering: int(value.style?.maxInjectCharsEngineering, DEFAULTS.style.maxInjectCharsEngineering),
    },
    ledger: {
      enabled: value.ledger?.enabled !== false,
      maxFilesPerSession: int(value.ledger?.maxFilesPerSession, DEFAULTS.ledger.maxFilesPerSession),
      maxSessions: int(value.ledger?.maxSessions, DEFAULTS.ledger.maxSessions),
      fileHintsInPulse: value.ledger?.fileHintsInPulse === true,
    },
    recall: {
      enabled: value.recall?.enabled !== false,
      maxSessions: int(value.recall?.maxSessions, DEFAULTS.recall.maxSessions),
      maxHits: int(value.recall?.maxHits, DEFAULTS.recall.maxHits),
      timeoutMs: int(value.recall?.timeoutMs, DEFAULTS.recall.timeoutMs),
    },
    privacy: {
      redact: privacy.redact !== false,
      redactTitles: privacy.redactTitles !== false,
      denyPathPatternsCount: count(privacy.denyPathPatterns),
      privateSessionsCount: count(privacy.privateSessions),
      redactPatternsCount: count(privacy.redactPatterns),
    },
    ui: {
      enabled: value.ui?.enabled !== false,
      pollMs: int(value.ui?.pollMs, DEFAULTS.ui.pollMs),
    },
    debug: { logFileEnabled: typeof value.debug?.logFile === 'string' && value.debug.logFile !== '' },
  }
}
