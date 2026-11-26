// Confluence / 高级记忆 — workspace identity resolution.
//
// v0.2.0 (ADR-0007): memory is UNIVERSAL per DSH profile. A workspace is no
// longer a partition, only PROVENANCE: the origin resolver turns a session's
// original directory into `{ workspaceKey, workspaceLabel }` for entries,
// ledger rows and presence. It never returns or stores an absolute path —
// the label is a basename only.
//
// Canonical workspace key (provenance / legacy journal selection):
//   session.header.cwd (immutable) -> fs.realpath -> win32 lower-case fold
//   -> "ws_" + sha256(canonicalPath).slice(0,16)
//
// `ctx.workingDirectory.get(session)` is a fallback only when the header has no
// cwd (ADR 0001 §5, round-2 R1). A realpath failure means "no origin" —
// provenance is optional and must never block memory. `resolveWorkspace` and
// `createWorkspaceResolver` are kept for legacy unit tests / callers that still
// need the canonical path; the v0.2.0 facade uses `createOriginResolver`.
// Contract: docs/plan/implementation-interfaces.md §3 and
// docs/plan/scope-refactor-delta.md §1.

import path from 'node:path'
import { realpath as fsRealpath } from 'node:fs/promises'
import { sha256Hex } from './util.js'

const DEFAULT_FS = { realpath: fsRealpath }

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asDeps(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

/**
 * Session id used as the origin-resolver cache key.
 *
 * @param {unknown} session
 * @returns {string | null}
 */
function sessionIdOf(session) {
  if (session === null || typeof session !== 'object') return null
  const direct = session.id
  if (nonEmptyString(direct)) return direct
  const header = session.header
  if (header !== null && typeof header === 'object' && nonEmptyString(header.id)) return header.id
  return null
}

/**
 * The original directory a session was started in: `header.cwd` first, the
 * effective working directory only as a fallback. Never throws.
 *
 * @param {Record<string, any>} deps
 * @param {unknown} session
 * @returns {string | null}
 */
function sessionDir(deps, session) {
  let headerCwd
  try {
    headerCwd = session !== null && typeof session === 'object' && session.header ? session.header.cwd : undefined
  } catch {
    headerCwd = undefined
  }
  if (nonEmptyString(headerCwd)) return headerCwd

  const workingDirectory = deps.workingDirectory
  if (workingDirectory && typeof workingDirectory.get === 'function') {
    try {
      const effective = workingDirectory.get(session)
      if (nonEmptyString(effective)) return effective
    } catch {
      return null
    }
  }
  return null
}

/**
 * Canonicalize a directory path: fs.realpath then win32 lower-case fold.
 * Returns null when the path is unusable (bad input, missing directory, error).
 *
 * @param {unknown} rawPath
 * @param {{ fs?: {realpath?: Function}, platform?: string }} [deps]
 * @returns {Promise<string | null>}
 */
export async function canonicalizeDir(rawPath, deps = {}) {
  if (!nonEmptyString(rawPath)) return null
  const options = asDeps(deps)
  const fsImpl = options.fs && typeof options.fs.realpath === 'function' ? options.fs : DEFAULT_FS
  let resolved
  try {
    resolved = await fsImpl.realpath(rawPath)
  } catch {
    return null
  }
  if (!nonEmptyString(resolved)) return null
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * @param {string} canonicalPath
 * @returns {string} workspace key
 */
export function workspaceKeyFor(canonicalPath) {
  if (!nonEmptyString(canonicalPath)) throw new TypeError('workspaceKeyFor requires a canonical path')
  return `ws_${sha256Hex(canonicalPath).slice(0, 16)}`
}

/**
 * Basename of a canonical path. Provenance labels are basenames only: when the
 * path has no basename (a drive/filesystem root) the label is `''` rather than
 * the path, so an absolute path can never leak into stored memory.
 *
 * @param {string} canonicalPath
 * @param {string} platform
 * @returns {string}
 */
function labelFor(canonicalPath, platform) {
  const basename = platform === 'win32' ? path.win32.basename(canonicalPath) : path.basename(canonicalPath)
  return nonEmptyString(basename) ? basename : ''
}

/**
 * Resolve a session's provenance origin: `{ workspaceKey, workspaceLabel }`.
 * Best-effort by design — any failure (no cwd, realpath error, broken deps)
 * returns null and is never thrown to the caller. The canonical path itself is
 * consumed here and never included in the result.
 *
 * @param {{ workingDirectory?: {get?: Function}, fs?: {realpath?: Function}, platform?: string }} deps
 * @param {{ id?: unknown, header?: {cwd?: unknown} }} session
 * @returns {Promise<{ workspaceKey: string, workspaceLabel: string } | null>}
 */
export async function resolveOrigin(deps = {}, session) {
  try {
    const options = asDeps(deps)
    const rawDir = sessionDir(options, session)
    if (rawDir === null) return null
    const canonicalPath = await canonicalizeDir(rawDir, options)
    if (canonicalPath === null) return null
    const platform = typeof options.platform === 'string' ? options.platform : process.platform
    return Object.freeze({
      workspaceKey: workspaceKeyFor(canonicalPath),
      workspaceLabel: labelFor(canonicalPath, platform),
    })
  } catch {
    return null
  }
}

/**
 * Per-session cached origin resolver. The first resolution is frozen for the
 * session's lifetime (a later `cd` cannot move a session's provenance).
 *
 * `resolve(session)` is async and never throws (null on failure).
 * `cached(sessionId)` is the synchronous cache read used by callers that only
 * need provenance for an already-resolved session; it returns null when the
 * session has not been resolved yet (or resolved to no origin).
 *
 * @param {object} [deps] passed through to resolveOrigin (workingDirectory, fs, platform)
 * @returns {{
 *   resolve: (session: object) => Promise<{workspaceKey: string, workspaceLabel: string} | null>,
 *   cached: (sessionId: unknown) => {workspaceKey: string, workspaceLabel: string} | null,
 * }}
 */
export function createOriginResolver(deps = {}) {
  /** @type {Map<unknown, Promise<{workspaceKey: string, workspaceLabel: string} | null>>} */
  const pending = new Map()
  /** @type {Map<unknown, {workspaceKey: string, workspaceLabel: string} | null>} */
  const resolved = new Map()
  const cacheKey = (session) => {
    const id = sessionIdOf(session)
    return id === null ? null : id
  }
  return {
    async resolve(session) {
      let key = null
      try {
        key = cacheKey(session)
        if (key !== null && resolved.has(key)) return resolved.get(key)
        if (key !== null && pending.has(key)) return await pending.get(key)
        const promise = resolveOrigin(deps, session).catch(() => null)
        if (key !== null) pending.set(key, promise)
        const origin = await promise
        if (key !== null) {
          pending.delete(key)
          resolved.set(key, origin)
        }
        return origin
      } catch {
        if (key !== null) pending.delete(key)
        return null
      }
    },
    cached(sessionId) {
      if (sessionId === undefined || sessionId === null) return null
      const origin = resolved.get(sessionId)
      return origin === undefined ? null : origin
    },
  }
}

/**
 * Resolve a session's workspace including its canonical path. Legacy v0.1
 * behavior, kept for old unit tests and callers that still need the path; the
 * facade uses `resolveOrigin` (provenance only) instead.
 *
 * @param {{ workingDirectory?: {get?: Function}, fs?: {realpath?: Function}, platform?: string }} deps
 * @param {{ id?: unknown, header?: {cwd?: unknown} }} session
 * @returns {Promise<{ key: string, canonicalPath: string, label: string } | null>}
 */
export async function resolveWorkspace(deps = {}, session) {
  const options = asDeps(deps)
  const rawDir = sessionDir(options, session)
  if (rawDir === null) return null
  const canonicalPath = await canonicalizeDir(rawDir, options)
  if (canonicalPath === null) return null
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const basename = platform === 'win32' ? path.win32.basename(canonicalPath) : path.basename(canonicalPath)
  return {
    key: workspaceKeyFor(canonicalPath),
    canonicalPath,
    label: nonEmptyString(basename) ? basename : canonicalPath,
  }
}

/**
 * Per-session cached resolver. The first successful resolution is frozen for
 * the session's lifetime (a later `cd` cannot move a session's workspace).
 *
 * @param {object} [deps] passed through to resolveWorkspace (workingDirectory, fs, platform)
 * @returns {{ resolve: (session: object) => Promise<{key: string, canonicalPath: string, label: string} | null> }}
 */
export function createWorkspaceResolver(deps = {}) {
  /** @type {Map<unknown, Promise<{key: string, canonicalPath: string, label: string} | null>>} */
  const cache = new Map()
  return {
    async resolve(session) {
      const id = session && (session.id !== undefined ? session.id : session.header && session.header.id)
      if (id !== undefined && id !== null && cache.has(id)) return cache.get(id)
      const pending = resolveWorkspace(deps, session).catch(() => null)
      if (id !== undefined && id !== null) cache.set(id, pending)
      return pending
    },
  }
}
