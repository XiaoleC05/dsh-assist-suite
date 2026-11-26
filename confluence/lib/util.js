// Confluence / 高级记忆 — small shared utilities.
//
// Node builtins only. Everything here is pure except createLogger (which writes
// to the injected sink) and createUlidFactory (which keeps monotonic state).
// Contract: docs/plan/implementation-interfaces.md §1.

import { createHash } from 'node:crypto'

/** Error with one of the design's bare codes (NO_WORKSPACE, STORE_UNAVAILABLE, ...). */
export class ConfluenceError extends Error {
  /**
   * @param {string} code bare design code
   * @param {string} message short human message (model-facing when thrown from a tool)
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    if (options && options.cause !== undefined) super(message, { cause: options.cause })
    else super(message)
    this.name = 'ConfluenceError'
    this.code = String(code)
  }
}

// Crockford base32 (no I, L, O, U), uppercase: the ULID wire alphabet.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_TIME_LEN = 10
const ULID_RANDOM_LEN = 16
const ULID_RANDOM_BITS = 80n
const ULID_RANDOM_MASK = (1n << ULID_RANDOM_BITS) - 1n

/** @param {number} ms @returns {string} 10-char base32 timestamp */
function encodeUlidTime(ms) {
  let value = Math.max(0, Math.floor(Number(ms) || 0))
  let out = ''
  for (let i = 0; i < ULID_TIME_LEN; i += 1) {
    out = CROCKFORD[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

/** @param {bigint} value 80-bit random part @returns {string} 16-char base32 */
function encodeUlidRandom(value) {
  let v = value & ULID_RANDOM_MASK
  let out = ''
  for (let i = 0; i < ULID_RANDOM_LEN; i += 1) {
    out = CROCKFORD[Number(v & 31n)] + out
    v >>= 5n
  }
  return out
}

/** @param {() => number} random @returns {bigint} 80 random bits from 10 draws */
function drawUlidRandom(random) {
  let value = 0n
  for (let i = 0; i < 10; i += 1) {
    const raw = Number(random())
    const byte = Number.isFinite(raw) ? Math.floor(Math.abs(raw) * 256) & 0xff : 0
    value = (value << 8n) | BigInt(byte)
  }
  return value & ULID_RANDOM_MASK
}

/**
 * Monotonic ULID factory: 26 uppercase Crockford base32 chars, time-sortable,
 * strictly increasing within one process (same-millisecond calls increment the
 * random component; a backwards clock keeps the last timestamp).
 *
 * @param {() => number} [now] epoch ms
 * @param {() => number} [random] [0, 1)
 * @returns {() => string}
 */
export function createUlidFactory(now = () => Date.now(), random = Math.random) {
  let lastTime = -1
  let lastRandom = 0n
  return function ulid() {
    let time = Math.floor(Number(now()))
    if (!Number.isFinite(time) || time < 0) time = 0
    if (time < lastTime) time = lastTime // clock went backwards: stay monotonic
    let value
    if (time === lastTime) {
      value = lastRandom + 1n
      if (value > ULID_RANDOM_MASK) {
        time = lastTime + 1
        value = 0n
      }
    } else {
      value = drawUlidRandom(random)
    }
    lastTime = time
    lastRandom = value
    return encodeUlidTime(time) + encodeUlidRandom(value)
  }
}

/** @param {unknown} value @returns {boolean} */
export function isUlid(value) {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}

/** @param {string} value @returns {string} lowercase hex SHA-256 */
export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** @param {string} value @param {number} [length] @returns {string} */
export function shortHash(value, length = 16) {
  return sha256Hex(value).slice(0, Math.max(0, Math.min(64, Math.floor(length) || 0)))
}

/** @param {number} ms epoch ms @returns {string} ISO-8601 UTC with milliseconds */
export function isoNow(ms) {
  return new Date(Number(ms)).toISOString()
}

/**
 * Truncate a string to at most maxBytes UTF-8 bytes without splitting a code
 * point. Returns the original string when it already fits.
 *
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(value, maxBytes) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = Math.floor(Number(maxBytes))
  if (!Number.isFinite(limit) || limit <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (used + bytes > limit) break
    out += char
    used += bytes
  }
  return out
}

/**
 * Truncate a string to at most maxChars Unicode code points.
 *
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateChars(value, maxChars) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = Math.floor(Number(maxChars))
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const chars = Array.from(text)
  return chars.length <= limit ? text : chars.slice(0, limit).join('')
}

/** @param {string} text @returns {{ok: true, value: unknown} | {ok: false, error: unknown}} */
export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(String(text)) }
  } catch (error) {
    return { ok: false, error }
  }
}

const NOOP = () => {}

/**
 * Create a non-throwing structured logger.
 *
 * @param {boolean} [enabled] false returns no-op functions that are never called
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [sink]
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
export function createLogger(enabled = true, sink = console) {
  if (!enabled) return Object.freeze({ debug: NOOP, info: NOOP, warn: NOOP, error: NOOP })
  const logger = {}
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (record) => {
      try {
        const fn = sink && typeof sink[level] === 'function' ? sink[level] : undefined
        if (fn) fn.call(sink, record)
      } catch {
        // Logging must never break a caller.
      }
    }
  }
  return Object.freeze(logger)
}

/**
 * Mint a per-mount writer id: `<pid>-<8 lowercase hex>`.
 *
 * @param {number} pid
 * @param {() => number} random [0, 1)
 * @returns {string}
 */
export function makeWriterId(pid, random = Math.random) {
  const numericPid = Number.isFinite(Number(pid)) && Number(pid) >= 0 ? Math.trunc(Number(pid)) : process.pid
  let hex = ''
  for (let i = 0; i < 4; i += 1) {
    const raw = Number(random())
    const byte = Number.isFinite(raw) ? Math.floor(Math.abs(raw) * 256) & 0xff : 0
    hex += byte.toString(16).padStart(2, '0')
  }
  return `${numericPid}-${hex}`
}

/**
 * Escape untrusted text for the pulse template: `&`, `<`, `>` and the line
 * separators U+2028/U+2029 become literal `\uXXXX` sequences.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapePulseText(value) {
  return String(value ?? '')
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Wrap a function so it runs at most once; later calls return the first result.
 *
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @returns {F}
 */
export function once(fn) {
  let called = false
  let result
  return function onceWrapper(...args) {
    if (!called) {
      called = true
      result = fn.apply(this, args)
    }
    return result
  }
}
