// Confluence / 高级记忆 — redaction and input normalisation (WP2).
//
// Design contract: docs/plan/implementation-interfaces.md §4, docs/design/security-privacy.md
// §3.1–§3.3 (R2/R3), docs/design/data-model.md §6 (MAX_TITLE_CHARS 160, MAX_TAGS 8/32,
// MAX_ENTRY_FILES 8, MAX_PATH_CHARS 240), docs/design/config.md §2.6.
//
// Everything here is synchronous, pure and dependency-free (Node builtins only — actually no
// imports at all, so the module is trivially unit-testable and cannot pull the store in by
// accident). Redaction is BEST EFFORT and labeled as such in docs/UI: a secret without a
// recognisable pattern is stored; over-redaction of code is a stated limit.
//
// Stable policy id included on exported/rendered content where a version marker is needed.
export const REDACT_POLICY = 'confluence.redact/v1'

/** Maximum replacements per field (security-privacy §3.2). */
const MAX_REPLACEMENTS = 50

/** Maximum stored title length in Unicode code points (data-model §6). */
const MAX_TITLE_CHARS = 160

/** Maximum tags / tag length / file hints / path length (data-model §6). */
const MAX_TAGS = 8
const MAX_TAG_CHARS = 32
const MAX_FILES = 8
const MAX_PATH_CHARS = 240

/** Uniform replacement token (security-privacy §3.2: replacement `[redacted]`). */
const REDACTED = '[redacted]'

/**
 * Built-in pattern families (security-privacy §3.2). Each entry is a fresh RegExp per call so
 * `lastIndex` state can never leak between calls; `keep` is the replacement template.
 * Order matters: PEM blocks are removed before assignment heuristics so key material never
 * partially matches a `something=` rule.
 */
const BUILTIN_PATTERNS = [
  {
    name: 'pem',
    source: '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----',
    flags: 'g',
    keep: REDACTED,
  },
  { name: 'api-key', source: '\\bsk-[A-Za-z0-9_-]{16,}', flags: 'g', keep: REDACTED },
  { name: 'github-token', source: '\\bgh[pousr]_[A-Za-z0-9]{20,}', flags: 'g', keep: REDACTED },
  { name: 'aws-key-id', source: '\\bAKIA[0-9A-Z]{16}\\b', flags: 'g', keep: REDACTED },
  { name: 'slack-token', source: '\\bxox[baprs]-[A-Za-z0-9-]{10,}', flags: 'g', keep: REDACTED },
  {
    name: 'jwt',
    source: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    flags: 'g',
    keep: REDACTED,
  },
  {
    name: 'bearer',
    source: '\\bBearer\\s+[A-Za-z0-9._~+/=-]{8,}',
    flags: 'gi',
    keep: 'Bearer ' + REDACTED,
  },
  {
    // Credentialed connection strings: keep scheme+user, redact the password (security-privacy
    // §3.2). The match stops before the `@` so host/database detail survives in context.
    name: 'connection-string',
    source:
      '(\\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|redis|amqps?|mssql|sqlserver|ftp|sftp)://[^\\s:/@]+:)[^\\s@/]+(?=@)',
    flags: 'gi',
    keep: '$1' + REDACTED,
    captureKeep: 1,
  },
  {
    // Absolute Windows home paths leak the local user name; never store them in shared text.
    name: 'home-path-windows',
    source: '[A-Za-z]:\\\\Users\\\\[^\\\\\\s"\'<>]+(?:\\\\[^\\\\\\s"\'<>]+)*',
    flags: 'gi',
    keep: REDACTED,
  },
  {
    // POSIX home paths, keeping the separating quote/space that introduced them.
    name: 'home-path-posix',
    source: '([\\s"\'(])/(?:home|Users)/[^\\s/\'"<>]+(?:/[^\\s/\'"<>]+)*',
    flags: 'gi',
    keep: '$1' + REDACTED,
    captureKeep: 1,
  },
  {
    name: 'assignment',
    // Keep the key and the separator, redact the value. `password:` with no value is NOT a
    // match (needs 4+ non-space characters), so empty assignments survive (T1 negative).
    source:
      '(?<![A-Za-z0-9_])((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|client[_-]?secret)\\s*[:=]\\s*)(\\S{4,})',
    flags: 'gi',
    keep: '$1' + REDACTED,
    captureKeep: 1,
  },
]

/** Control characters and bidi/invisible controls that must never reach a title or a path. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g
const WHITESPACE_RUN = /\s+/gu

/** Built-in deny patterns for file hints (security-privacy §3.3; cannot be removed by config). */
const BUILTIN_DENY_PATTERNS = [
  '.ssh/**',
  '.aws/**',
  '.git-credentials',
  '.netrc',
  'id_rsa*',
  '*.key',
  '*.p12',
  '*.pfx',
  'secrets*',
  '**/.env*',
  '**/*.pem',
]

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Truncate a string to `maxChars` Unicode code points without splitting a surrogate pair.
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function truncateCodePoints(value, maxChars) {
  let out = ''
  let count = 0
  for (const ch of value) {
    if (count >= maxChars) break
    out += ch
    count += 1
  }
  return out
}

/**
 * Normalise a title into one trimmed line, stripping control/bidi characters and collapsing
 * whitespace (data-model §4.1: no newlines, no leading/trailing spaces, ≤160 chars).
 * @param {string} value
 * @returns {string}
 */
function normalizeTitle(value) {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
}

/**
 * Compile one built-in pattern definition for a single call.
 * @param {{source: string, flags: string, keep: string, captureKeep?: number}} pattern
 * @returns {RegExp}
 */
function compilePattern(pattern) {
  return new RegExp(pattern.source, pattern.flags)
}

/**
 * Apply a list of patterns with one shared per-field replacement budget.
 * Returns the new value and the number of replacements actually performed; once the budget is
 * exhausted the remaining matches are left untouched (never throws, never loops).
 * @param {string} input
 * @param {Array<{name: string, regex: RegExp, keep: string, captureKeep?: number}>} patterns
 * @param {number} budget
 * @returns {{ value: string, hits: number }}
 */
function applyPatterns(input, patterns, budget) {
  let value = input
  let hits = 0
  for (const pattern of patterns) {
    if (hits >= budget) break
    const regex = pattern.regex
    regex.lastIndex = 0
    value = value.replace(regex, (match, ...args) => {
      if (hits >= budget) return match
      hits += 1
      const keep = pattern.keep
      if (pattern.captureKeep !== undefined) {
        const group = args[pattern.captureKeep - 1]
        return typeof group === 'string' ? keep.replace('$1', group) : keep
      }
      return keep
    })
  }
  return { value, hits }
}

/**
 * Compile the configured custom patterns. Invalid regex sources are dropped (never throw on
 * activation); config.resolveConfig already filters most bad values, this is defence in depth.
 * @param {unknown} sources
 * @param {{debug?: Function}} [logger]
 * @returns {Array<{name: string, regex: RegExp, keep: string}>}
 */
function compileCustomPatterns(sources, logger) {
  if (!Array.isArray(sources)) return []
  const compiled = []
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]
    if (typeof source !== 'string' || source.length === 0 || source.length > 400) continue
    let regex
    try {
      regex = new RegExp(source, 'giu')
    } catch {
      try {
        regex = new RegExp(source, 'gi')
      } catch (error) {
        try {
          logger?.debug?.({ event: 'redact.custom_pattern_invalid', index, message: String(error) })
        } catch {
          // Diagnostics are best-effort.
        }
        continue
      }
    }
    compiled.push({ name: `custom-${index}`, regex, keep: REDACTED })
  }
  return compiled
}

/**
 * Convert one raw path to a stored workspace-relative path, or `undefined` when it must be
 * dropped. Strips drive letters, UNC server/share prefixes and leading separators; rejects
 * NUL bytes, `..` segments, empty results and over-long paths (security-privacy §3.3).
 * @param {unknown} raw
 * @returns {string | undefined}
 */
function toWorkspaceRelative(raw) {
  if (typeof raw !== 'string') return undefined
  let value = raw.trim()
  if (value.length === 0 || value.includes('\u0000')) return undefined

  value = value.replace(/\\/g, '/')

  if (value.startsWith('//')) {
    // UNC: //server/share/rest -> rest (the share name itself is not a workspace path).
    value = value.replace(/^\/\/[^/]+\/[^/]+\/?/, '')
  } else {
    value = value.replace(/^[A-Za-z]:/, '')
  }
  value = value.replace(/^\/+/, '')

  const segments = value.split('/')
  if (segments.some((segment) => segment === '..')) return undefined

  const cleaned = segments.filter((segment) => segment !== '' && segment !== '.')
  if (cleaned.length === 0) return undefined

  const relative = cleaned.join('/')
  if (relative.length > MAX_PATH_CHARS) return undefined
  return relative
}

/**
 * Convert one deny glob (`*`, `**`, `?`) to an anchored RegExp. Patterns without a slash are
 * treated as basename patterns (matched at any depth); others are anchored to the stored path,
 * with a leading double-star-slash segment added when the pattern does not start at the root.
 * @param {string} pattern
 * @returns {RegExp | undefined}
 */
function denyGlobToRegExp(pattern) {
  let source = pattern.trim().replace(/\\/g, '/')
  if (source.length === 0) return undefined
  if (!source.includes('/')) source = '**/' + source
  if (!source.startsWith('**/')) source = '**/' + source

  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*' && source[index + 1] === '*') {
      if (source[index + 2] === '/') {
        out += '(?:.*/)?'
        index += 2
      } else {
        out += '.*'
        index += 1
      }
    } else if (char === '*') {
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  try {
    return new RegExp('^' + out + '$', 'i')
  } catch {
    return undefined
  }
}

/**
 * Create the redactor for one resolved config.
 *
 * @param {Record<string, unknown>} config resolved config (uses `privacy` only)
 * @param {{logger?: {debug?: Function}, deps?: object}} [options]
 * @returns {{
 *   text(s: unknown): {value: string, hits: number},
 *   title(s: unknown): {value: string, hits: number},
 *   files(paths: unknown): string[],
 *   tags(tags: unknown): string[],
 * }}
 */
export function createRedactor(config, options = {}) {
  const privacy = isPlainObject(config?.privacy) ? config.privacy : {}
  const redactEnabled = privacy.redact !== false
  const redactTitles = privacy.redactTitles !== false
  const logger = isPlainObject(options) ? options.logger : undefined

  const builtins = BUILTIN_PATTERNS.map((pattern) => ({
    ...pattern,
    regex: compilePattern(pattern),
  }))
  const custom = compileCustomPatterns(privacy.redactPatterns, logger)
  const patterns = [...builtins, ...custom]

  const denyMatchers = [
    ...BUILTIN_DENY_PATTERNS,
    ...(Array.isArray(privacy.denyPathPatterns) ? privacy.denyPathPatterns : []),
  ]
    .map((pattern) => (typeof pattern === 'string' ? denyGlobToRegExp(pattern) : undefined))
    .filter((matcher) => matcher !== undefined)

  /** @param {string} relative @returns {boolean} */
  function isDenied(relative) {
    return denyMatchers.some((matcher) => matcher.test(relative))
  }

  /** @param {unknown} input @returns {{value: string, hits: number}} */
  function redactText(input) {
    if (!redactEnabled) return { value: typeof input === 'string' ? input : String(input ?? ''), hits: 0 }
    const source = typeof input === 'string' ? input : String(input ?? '')
    return applyPatterns(source, patterns, MAX_REPLACEMENTS)
  }

  return {
    /**
     * Redact one free-text field (body, excerpt, author title). Does not normalize whitespace —
     * callers that store a title use `title()`.
     * @param {unknown} value
     */
    text(value) {
      return redactText(value)
    },

    /**
     * Redact, one-line-normalise and cap a title (160 code points).
     * @param {unknown} value
     */
    title(value) {
      const redacted = redactEnabled && redactTitles
        ? redactText(value)
        : { value: typeof value === 'string' ? value : String(value ?? ''), hits: 0 }
      let normalized = normalizeTitle(redacted.value)
      normalized = truncateCodePoints(normalized, MAX_TITLE_CHARS)
      return { value: normalized, hits: redacted.hits }
    },

    /**
     * Normalise file hints to ≤8 stored workspace-relative paths (deduped, deny-checked).
     * @param {unknown} paths
     * @returns {string[]}
     */
    files(paths) {
      if (!Array.isArray(paths)) return []
      const out = []
      for (const raw of paths) {
        const relative = toWorkspaceRelative(raw)
        if (relative === undefined || isDenied(relative)) continue
        if (out.includes(relative)) continue
        out.push(relative)
        if (out.length >= MAX_FILES) break
      }
      return out
    },

    /**
     * Normalise tags to ≤8 lowercase labels matching `^[a-z0-9][a-z0-9_-]*$`, each ≤32 chars.
     * @param {unknown} tags
     * @returns {string[]}
     */
    tags(tags) {
      if (!Array.isArray(tags)) return []
      const out = []
      for (const raw of tags) {
        if (typeof raw !== 'string') continue
        const label = raw.trim().toLowerCase()
        if (label.length === 0 || label.length > MAX_TAG_CHARS) continue
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(label)) continue
        if (out.includes(label)) continue
        out.push(label)
        if (out.length >= MAX_TAGS) break
      }
      return out
    },
  }
}
