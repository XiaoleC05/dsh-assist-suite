// WP1 unit tests — lib/util.js
// Covers the util contract (implementation-interfaces.md §1) and the shared
// primitives the rest of the plugin depends on (ULID monotonicity, escaping).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ConfluenceError,
  createLogger,
  createUlidFactory,
  escapePulseText,
  isUlid,
  isoNow,
  makeWriterId,
  once,
  safeJsonParse,
  sha256Hex,
  shortHash,
  truncateChars,
  truncateUtf8,
} from '../lib/util.js'

/** Deterministic random source that walks a fixed list (last value sticks). */
function sequence(values) {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)]
    index += 1
    return value
  }
}

test('UT-UTIL-01 ULID: 26 uppercase Crockford characters, validates with isUlid', () => {
  const ulid = createUlidFactory(
    () => 1_700_000_000_000,
    () => 0.5,
  )()
  assert.match(ulid, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.equal(ulid.length, 26)
  assert.equal(isUlid(ulid), true)
  assert.equal(isUlid(ulid.toLowerCase()), false, 'lowercase is not the wire form')
  assert.equal(isUlid(ulid.slice(1)), false)
  assert.equal(isUlid(undefined), false)
  assert.equal(isUlid(123), false)
  assert.equal(isUlid('01JBQ8Z4K2V7R3N5T6X1Y8M0P'), false, '25 chars is invalid')
})

test('UT-UTIL-02 ULID: deterministic and strictly monotonic within one millisecond', () => {
  const make = () =>
    createUlidFactory(
      () => 1_700_000_000_000,
      () => 0.42,
    )
  const a = make()
  const b = make()
  const aValues = Array.from({ length: 5 }, () => a())
  const bValues = Array.from({ length: 5 }, () => b())
  assert.deepEqual(aValues, bValues, 'same clock/random => same sequence')
  for (let i = 1; i < aValues.length; i += 1) {
    assert.ok(aValues[i] > aValues[i - 1], `same-ms ULID must increase: ${aValues[i - 1]} < ${aValues[i]}`)
  }
  assert.equal(new Set(aValues).size, aValues.length)
})

test('UT-UTIL-03 ULID: later timestamps sort later and a backwards clock stays monotonic', () => {
  let now = 1_700_000_000_000
  const ulid = createUlidFactory(() => now, sequence([0.1, 0.2, 0.3, 0.4]))
  const first = ulid()
  now += 1
  const second = ulid()
  assert.ok(second > first, 'later millisecond sorts later')
  now -= 500 // clock goes backwards
  const third = ulid()
  assert.ok(third > second, 'clock skew never produces a smaller seq')
})

test('UT-UTIL-04 makeWriterId: `<pid>-<8 lowercase hex>`', () => {
  const writerId = makeWriterId(1234, () => 0.5)
  assert.match(writerId, /^1234-[0-9a-f]{8}$/)
  assert.equal(makeWriterId(1234, () => 0.5), writerId, 'deterministic input => same id')
  assert.notEqual(makeWriterId(4321, () => 0.5), writerId, 'pid is part of the id')
  assert.notEqual(makeWriterId(1234, () => 0.25), writerId, 'random is part of the id')
})

test('UT-UTIL-05 hashing: sha256Hex known vector, shortHash prefix', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  const short = shortHash('abc', 16)
  assert.equal(short.length, 16)
  assert.ok(sha256Hex('abc').startsWith(short))
  assert.equal(shortHash('abc'), short, 'default length is 16')
})

test('UT-UTIL-06 isoNow: ISO-8601 UTC with milliseconds', () => {
  assert.equal(isoNow(0), '1970-01-01T00:00:00.000Z')
  assert.equal(isoNow(1_700_000_000_123), '2023-11-14T22:13:20.123Z')
  assert.match(isoNow(Date.now()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('UT-UTIL-07 truncateUtf8: byte bound without splitting a code point', () => {
  assert.equal(truncateUtf8('abc', 10), 'abc')
  assert.equal(truncateUtf8('😀', 3), '', '4-byte emoji does not fit in 3 bytes')
  assert.equal(truncateUtf8('😀', 4), '😀')
  assert.equal(truncateUtf8('a😀b', 5), 'a😀')
  assert.equal(truncateUtf8('a😀b', 4), 'a')
  assert.equal(truncateUtf8('a😀b', 1), 'a')
  assert.equal(truncateUtf8('héllo', 2), 'h')
  assert.equal(truncateUtf8('abc', 0), '')
  for (const [text, limit] of [
    ['héllo wörld', 7],
    ['日本語テキスト', 6],
    ['😀😀😀', 8],
  ]) {
    const out = truncateUtf8(text, limit)
    assert.ok(Buffer.byteLength(out, 'utf8') <= limit)
    assert.ok([...out].every((char) => text.includes(char)), 'no split/replacement characters')
  }
})

test('UT-UTIL-08 truncateChars: code-point bound (emoji count as one)', () => {
  assert.equal(truncateChars('abc', 2), 'ab')
  assert.equal(truncateChars('abc', 10), 'abc')
  assert.equal(truncateChars('😀😀😀', 2), '😀😀')
  assert.equal(truncateChars('😀😀😀', 0), '')
  assert.equal(truncateChars('', 5), '')
})

test('UT-UTIL-09 safeJsonParse: ok/error union, never throws', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { ok: true, value: { a: 1 } })
  const bad = safeJsonParse('{nope')
  assert.equal(bad.ok, false)
  assert.ok(bad.error instanceof Error)
  assert.equal(safeJsonParse('').ok, false)
})

test('UT-UTIL-10 escapePulseText: & < > U+2028/2029 become literal \\uXXXX', () => {
  const input = `<confluence-workspace> & "x" \u2028 \u2029`
  const escaped = escapePulseText(input)
  assert.ok(escaped.includes('\\u003c'))
  assert.ok(escaped.includes('\\u003e'))
  assert.ok(escaped.includes('\\u0026'))
  assert.ok(escaped.includes('\\u2028'))
  assert.ok(escaped.includes('\\u2029'))
  assert.ok(!/[<>&]/.test(escaped), 'no raw framing characters survive')
  assert.ok(!escaped.includes('\u2028') && !escaped.includes('\u2029'))
  assert.equal(escapePulseText(null), '')
  assert.equal(escapePulseText(undefined), '')
})

test('UT-UTIL-11 createLogger: disabled is silent, enabled forwards, a broken sink never throws', () => {
  const calls = []
  const sink = {
    debug: (record) => calls.push(['debug', record]),
    info: (record) => calls.push(['info', record]),
    warn: (record) => calls.push(['warn', record]),
    error: (record) => calls.push(['error', record]),
  }
  const off = createLogger(false, sink)
  off.warn({ event: 'x' })
  assert.equal(calls.length, 0, 'disabled logger must not call the sink')

  const on = createLogger(true, sink)
  on.warn({ event: 'test', n: 1 })
  assert.deepEqual(calls, [['warn', { event: 'test', n: 1 }]])

  const exploding = createLogger(true, {
    warn: () => {
      throw new Error('sink down')
    },
  })
  assert.doesNotThrow(() => exploding.warn({ event: 'still safe' }))
  const partial = createLogger(true, {})
  assert.doesNotThrow(() => partial.debug({ event: 'no method' }))
})

test('UT-UTIL-12 once: invokes once and returns the first result', () => {
  let calls = 0
  const fn = once((value) => {
    calls += 1
    return value * 2
  })
  assert.equal(fn(2), 4)
  assert.equal(fn(99), 4)
  assert.equal(calls, 1)
})

test('UT-UTIL-13 ConfluenceError: carries a bare code, message and optional cause', () => {
  const cause = new Error('root cause')
  const error = new ConfluenceError('STORE_UNAVAILABLE', 'cannot write', { cause })
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'ConfluenceError')
  assert.equal(error.code, 'STORE_UNAVAILABLE')
  assert.equal(error.message, 'cannot write')
  assert.equal(error.cause, cause)
  const plain = new ConfluenceError('NO_WORKSPACE', 'no workspace')
  assert.equal(plain.code, 'NO_WORKSPACE')
  assert.equal(plain.cause, undefined)
})
