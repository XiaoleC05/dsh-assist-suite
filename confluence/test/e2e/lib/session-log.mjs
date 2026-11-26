#!/usr/bin/env node
// Confluence / 高级记忆 — offline E2E session-log reader.
//
// DSH persists one logical session as a v4 JSONL file whose records are written
// in **concatenated zstd frames** (one frame per append batch), inside
// `<DSH_HOME>/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd`.
// Node's one-shot zstd decoder stops after the first frame, so this module
// walks the zstd frame headers, decompresses each frame independently, and
// returns the session header plus every committed event.
//
// No dependency, no network, read-only. Used by `scripts/m0-smoke.mjs` and
// `test/e2e/assert-e2e.mjs`; the E2E assertions are the only reason the harness
// needs to read a session log at all.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Prompt-block tag names and runtime-context section names.
 *
 * v0.4.0 (ADR-0009) commits four contributions: `<confluence-profile rev="…" facts="…">`
 * (`confluence:profile`, 1400), `<confluence-memory-patterns …>` (`confluence:memory`,
 * 1410), `<confluence-style …>` (`confluence:style`, 1420) and the workspace pulse
 * `<confluence-memory scope="workspace" …>` (`confluence:pulse`, 1500). v0.2.0 logs
 * carry `<confluence-memory scope="global" …>`; v0.1.0 logs (and inherited snapshots)
 * carry the legacy `<confluence-workspace …>` block. All are valid carriers, so the
 * E2E/smoke checks accept them and report which one they saw.
 */
export const MEMORY_PULSE_TAG = 'confluence-memory'
export const LEGACY_PULSE_TAG = 'confluence-workspace'
export const PROFILE_BLOCK_TAG = 'confluence-profile'
export const MEMORY_PATTERNS_TAG = 'confluence-memory-patterns'
export const STYLE_BLOCK_TAG = 'confluence-style'
export const PULSE_TAG_NAMES = Object.freeze([MEMORY_PULSE_TAG, LEGACY_PULSE_TAG])
export const PROFILE_CONTEXT_NAME = 'confluence:profile'
export const MEMORY_CONTEXT_NAME = 'confluence:memory'
export const STYLE_CONTEXT_NAME = 'confluence:style'
export const PULSE_CONTEXT_NAME = 'confluence:pulse'

/** Opening tag of a pulse block: `\u003c` is accepted defensively (escaped form).
 *  The `(?=\s|>)` lookahead keeps `<confluence-memory-patterns …>` from being
 *  mistaken for the `<confluence-memory …>` workspace pulse. */
const PULSE_HEADER_RE = /(?:\\u003c|<)confluence-(memory|workspace)(?=\s|>)([^>]*)>/i
const PULSE_ATTRIBUTE_RE = /([a-zA-Z_][\w:.-]*)\s*=\s*"([^"]*)"/g

/**
 * Parse the pulse opening tag.
 * @param {unknown} text
 * @returns {{ tag: string, raw: string, attributes: Record<string,string> } | null}
 */
export function pulseHeader(text) {
  if (typeof text !== 'string') return null
  const match = PULSE_HEADER_RE.exec(text)
  if (match === null) return null
  const attributes = {}
  for (const attribute of match[2].matchAll(PULSE_ATTRIBUTE_RE)) attributes[attribute[1]] = attribute[2]
  return { tag: `confluence-${match[1].toLowerCase()}`, raw: match[0], attributes }
}

/**
 * Name of the pulse tag carried by `text` (`confluence-memory` / `confluence-workspace`),
 * or null when the text is not a pulse block. Accepts both generations.
 * @param {unknown} text
 * @returns {string | null}
 */
export function pulseTag(text) {
  return pulseHeader(text)?.tag ?? null
}

/** @param {unknown} text @returns {boolean} */
export function isPulseText(text) {
  return pulseTag(text) !== null
}

/** Opening tag of the profile block: `<confluence-profile rev="…" facts="…">`. */
const PROFILE_HEADER_RE = /(?:\\u003c|<)confluence-profile\b([^>]*)>/i

/**
 * Parse the `<confluence-profile …>` opening tag from a runtime-context profile
 * section, or return null when the text does not carry one.
 *
 * @param {unknown} text
 * @returns {{ tag: string, raw: string, attributes: Record<string,string> } | null}
 */
export function profileHeader(text) {
  if (typeof text !== 'string') return null
  const match = PROFILE_HEADER_RE.exec(text)
  if (match === null) return null
  const attributes = {}
  for (const attribute of match[1].matchAll(PULSE_ATTRIBUTE_RE)) attributes[attribute[1]] = attribute[2]
  return { tag: PROFILE_BLOCK_TAG, raw: match[0], attributes }
}

/**
 * Walk concatenated zstd frames and return their decompressed payloads.
 * Implements only the frame-skipping subset of RFC 8878 needed to find frame
 * boundaries: frame header descriptor, optional window/dictionary/content-size
 * fields, then block headers until the last-block flag.
 *
 * @param {Buffer} raw file bytes
 * @returns {Buffer[]} one decompressed buffer per frame
 */
export function decodeZstdFrames(raw) {
  const frames = []
  let offset = 0
  while (offset + 4 <= raw.length) {
    if (!raw.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) {
      throw new Error(`zstd: no frame magic at offset ${offset} (of ${raw.length})`)
    }
    const fd = raw[offset + 4]
    const fcsFlag = fd >> 6
    const singleSegment = (fd & 0x20) !== 0
    const hasChecksum = (fd & 0x04) !== 0
    const dictFlag = fd & 0x03
    let cursor = offset + 5
    if (!singleSegment) cursor += 1 // Window_Descriptor
    cursor += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    cursor += fcsSize
    if (cursor > raw.length) throw new Error(`zstd: truncated frame header at offset ${offset}`)
    // Blocks.
    let lastBlock = false
    while (!lastBlock) {
      if (cursor + 3 > raw.length) throw new Error(`zstd: truncated block header at offset ${cursor}`)
      const header = raw[cursor] | (raw[cursor + 1] << 8) | (raw[cursor + 2] << 16)
      const blockType = (header >> 1) & 0x03
      const blockSize = header >>> 3
      lastBlock = (header & 0x01) !== 0
      cursor += 3
      if (blockType === 0 || blockType === 2) cursor += blockSize
      else if (blockType === 1) cursor += 1
      else throw new Error(`zstd: reserved block type at offset ${cursor - 3}`)
    }
    if (hasChecksum) cursor += 4
    if (cursor > raw.length) throw new Error(`zstd: frame at offset ${offset} exceeds file`)
    const frame = raw.subarray(offset, cursor)
    try {
      frames.push(zstdDecompressSync(frame))
    } catch (error) {
      // Fall back to "decompress from this frame to the end": some zstd builds
      // tolerate trailing data, and the payload is still correct when they do.
      try {
        frames.push(zstdDecompressSync(raw.subarray(offset, cursor)))
      } catch {
        throw new Error(`zstd: frame at offset ${offset} did not decompress: ${error && error.message}`)
      }
    }
    offset = cursor
  }
  if (offset !== raw.length) throw new Error(`zstd: ${raw.length - offset} trailing bytes after last frame`)
  return frames
}

/**
 * Decode one session log into `{ header, events }`.
 * @param {string} file
 */
export function decodeSessionLogFile(file) {
  const events = []
  for (const frame of decodeZstdFrames(readFileSync(file))) {
    for (const line of frame.toString('utf8').split('\n')) {
      if (line.trim() === '') continue
      events.push(JSON.parse(line))
    }
  }
  const header = events.find((event) => event.type === 'session' && event.version === 4)
  return {
    header,
    events: events.filter((event) => event !== header),
    eventCount: events.length,
    rawBytes: statSync(file).size,
  }
}

/**
 * Find every persisted session under a `DSH_HOME`.
 * @param {string} dshHome
 * @returns {{file:string,dir:string,sessionId:string,encodedCwd:string}[]}
 */
export function findSessionFiles(dshHome) {
  const root = join(dshHome, 'sessions')
  const found = []
  let buckets = []
  try {
    buckets = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return found
  }
  for (const bucket of buckets) {
    const bucketDir = join(root, bucket.name)
    let sessionDirs = []
    try {
      sessionDirs = readdirSync(bucketDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      const dir = join(bucketDir, sessionDir.name)
      const file = join(dir, 'session.v4.jsonl.zstd')
      try {
        if (statSync(file).isFile()) found.push({ file, dir, sessionId: sessionDir.name, encodedCwd: bucket.name })
      } catch {
        /* not a persisted session directory */
      }
    }
  }
  return found.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/** Runtime-context snapshot messages (the loop commits one per changed joined text). */
export function runtimeContextMessages(events) {
  return events.filter(
    (event) => event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'runtime-context',
  )
}

/** Section text from a runtime-context snapshot by section name. */
export function sectionText(snapshotMessage, sectionName) {
  const sections = (snapshotMessage?.data?.source?.sections ?? []).filter((section) => section && typeof section === 'object')
  const match = sections.find((section) => section.name === sectionName)
  if (match === undefined) return undefined
  return typeof match.text === 'string' ? match.text : ''
}

/**
 * Pulse snapshots: runtime-context messages whose sections include `confluence:pulse`
 * and whose text carries a pulse block. New commits use
 * `<confluence-memory scope="workspace" …>`; v0.2.0 logs use `scope="global"` and
 * v0.1.0 logs (or inherited snapshots) use `<confluence-workspace>`.
 *
 * @param {object[]} events
 * @returns {{message: object, pulseText: string, tag: string, header: object}[]}
 */
export function pulseSnapshots(events) {
  return runtimeContextMessages(events)
    .map((message) => {
      const pulseText = sectionText(message, 'confluence:pulse')
      const header = pulseHeader(pulseText)
      return { message, pulseText, tag: header?.tag ?? null, header }
    })
    .filter((entry) => typeof entry.pulseText === 'string' && entry.tag !== null)
}

/**
 * Profile-block snapshots: runtime-context messages whose sections include
 * `confluence:profile` and whose text carries a `<confluence-profile …>` block.
 * Empty profiles render no block, so a missing snapshot is legitimate.
 *
 * @param {object[]} events
 * @returns {{message: object, profileText: string, header: object|null}[]}
 */
export function profileSnapshots(events) {
  return runtimeContextMessages(events)
    .map((message) => {
      const profileText = sectionText(message, PROFILE_CONTEXT_NAME)
      const header = profileHeader(profileText)
      return { message, profileText, header }
    })
    .filter((entry) => typeof entry.profileText === 'string' && entry.header !== null)
}

/**
 * Generic runtime-context section snapshots: every committed runtime-context
 * message whose named section carries a non-empty text. Used for the v0.4
 * `confluence:memory` and `confluence:style` contributions (and for pulse, when a
 * test wants the raw section text rather than a parsed block).
 *
 * @param {object[]} events
 * @param {string} sectionName
 * @returns {{message: object, sectionName: string, text: string}[]}
 */
export function sectionSnapshots(events, sectionName) {
  return runtimeContextMessages(events)
    .map((message) => ({ message, sectionName, text: sectionText(message, sectionName) }))
    .filter((entry) => typeof entry.text === 'string' && entry.text.trim() !== '')
}

/**
 * Long-term memory block snapshots (`<confluence-memory-patterns …>`).
 * @param {object[]} events
 * @returns {{message: object, memoryText: string}[]}
 */
export function memorySnapshots(events) {
  return sectionSnapshots(events, MEMORY_CONTEXT_NAME)
    .filter((entry) => entry.text.includes(`<${MEMORY_PATTERNS_TAG}`))
    .map((entry) => ({ message: entry.message, memoryText: entry.text }))
}

/**
 * Style block snapshots (`<confluence-style …>`).
 * @param {object[]} events
 * @returns {{message: object, styleText: string}[]}
 */
export function styleSnapshots(events) {
  return sectionSnapshots(events, STYLE_CONTEXT_NAME)
    .filter((entry) => entry.text.includes(`<${STYLE_BLOCK_TAG}`))
    .map((entry) => ({ message: entry.message, styleText: entry.text }))
}

/** Full text of a message event (joins text blocks; ignores non-text blocks). */
export function messageText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** All `agent/inbox/spliced` events. Runtime-context must not arrive this way. */
export function inboxSplices(events) {
  return events.filter((event) => event.type === 'agent/inbox/spliced')
}

/** Model-facing tool names recorded in the most recent `request/header`. */
export function toolNames(events) {
  let names = []
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const tools = event?.data?.header?.tools
    if (Array.isArray(tools)) names = tools.map((tool) => tool && tool.name).filter((name) => typeof name === 'string')
  }
  return names
}

/**
 * Assistant `tool/call` records: name plus the decoded arguments object.
 * `arguments` is committed as a JSON string; malformed JSON is surfaced as
 * `parseError` rather than thrown so assertions can name the offending call.
 *
 * @param {object[]} events
 * @returns {{ name: string, callId: string, argumentsText: string, input: object | null, parseError?: string }[]}
 */
export function toolCallRecords(events) {
  const calls = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const name = event?.data?.name ?? event?.data?.call?.name
    if (typeof name !== 'string') continue
    const raw = event?.data?.arguments ?? event?.data?.call?.arguments
    const argumentsText = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
    let input = null
    let parseError
    if (argumentsText !== '') {
      try {
        const parsed = JSON.parse(argumentsText)
        input = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch (error) {
        parseError = String(error && error.message ? error.message : error)
      }
    } else {
      input = {}
    }
    calls.push({
      name,
      callId: typeof event?.data?.callId === 'string' ? event.data.callId : '',
      argumentsText,
      input,
      ...(parseError === undefined ? {} : { parseError }),
    })
  }
  return calls
}

/** Assistant `tool/call` names committed in the session. */
export function toolCalls(events) {
  return toolCallRecords(events).map((call) => call.name)
}

/**
 * Committed tool-result texts (rendered output the model saw).
 * @param {object[]} events
 * @returns {{ callId: string, text: string, isError: boolean }[]}
 */
export function toolResults(events) {
  const results = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const content = event?.data?.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((block) => block && typeof block === 'object' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    }
    results.push({
      callId: typeof event?.data?.message?.toolCallId === 'string' ? event.data.message.toolCallId : '',
      text,
      isError: event?.data?.message?.isError === true,
    })
  }
  return results
}

/** The final answer text from a `--json` headless run (NDJSON on stdout). */
export function finalHeadlessAnswer(stdoutText) {
  let final = null
  for (const line of String(stdoutText).split(/\r?\n/)) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed && parsed.type === 'final') final = parsed
  }
  return final
}

// CLI convenience: `node test/e2e/lib/session-log.mjs <session file>` dumps a
// compact event summary for debugging a failed run.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('session-log.mjs')) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('usage: node test/e2e/lib/session-log.mjs <session.v4.jsonl.zstd>\n')
    process.exit(2)
  }
  const { header, events } = decodeSessionLogFile(file)
  process.stdout.write(`${JSON.stringify({ header, eventCount: events.length }, null, 2)}\n`)
  const pulses = pulseSnapshots(events)
  process.stdout.write(`pulse snapshots: ${pulses.length === 0 ? 'none' : pulses.map((pulse) => pulse.tag).join(', ')}\n`)
  for (const event of events) {
    process.stdout.write(`${String(event.seq ?? '-').padStart(3)} ${event.type}\n`)
  }
}
