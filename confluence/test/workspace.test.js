// WP1 unit tests — lib/workspace.js
//
// v0.2.0 (ADR-0007): a workspace is provenance only. These tests cover the
// legacy canonicalization/key helpers (still exported for old tests), the new
// `resolveOrigin` / `createOriginResolver` contract from
// docs/plan/scope-refactor-delta.md §1, and the "never leak an absolute path"
// rule. No real filesystem access: `fs.realpath` is injected and deterministic.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalizeDir,
  createOriginResolver,
  createWorkspaceResolver,
  resolveOrigin,
  resolveWorkspace,
  workspaceKeyFor,
} from '../lib/workspace.js'
import { sha256Hex } from '../lib/util.js'

const WIN32 = { platform: 'win32' }

/** @param {Record<string, string>} mapping @param {{errorFor?: string[], calls?: string[]}} [options] */
function fakeFs(mapping, options = {}) {
  const calls = options.calls ?? []
  const errorFor = options.errorFor ?? []
  return {
    calls,
    async realpath(rawPath) {
      calls.push(rawPath)
      if (errorFor.includes(rawPath)) {
        const error = new Error(`ENOENT: no such file or directory, realpath '${rawPath}'`)
        error.code = 'ENOENT'
        throw error
      }
      if (!(rawPath in mapping)) {
        const error = new Error(`ENOENT: ${rawPath}`)
        error.code = 'ENOENT'
        throw error
      }
      return mapping[rawPath]
    },
  }
}

// ---------------------------------------------------------------------------
// legacy helpers (kept exported for old callers/tests)
// ---------------------------------------------------------------------------

test('UT-WS-01 legacy canonicalization: realpath + win32 lowercase fold; spellings converge', async () => {
  const fs = fakeFs({
    'C:\\Repo\\Sub\\..': 'C:\\Repo',
    'c:/repo/': 'C:\\Repo',
    'C:\\Repo': 'C:\\Repo',
  })
  const a = await canonicalizeDir('C:\\Repo\\Sub\\..', { fs, ...WIN32 })
  const b = await canonicalizeDir('c:/repo/', { fs, ...WIN32 })
  const c = await canonicalizeDir('C:\\Repo', { fs, ...WIN32 })
  assert.equal(a, 'c:\\repo')
  assert.equal(b, 'c:\\repo')
  assert.equal(c, 'c:\\repo')
  assert.equal(workspaceKeyFor(a), workspaceKeyFor(b))
  assert.equal(workspaceKeyFor(a), workspaceKeyFor(c))
})

test('UT-WS-02 legacy key shape: "ws_" + sha256(canonicalPath).slice(0,16)', async () => {
  const canonical = 'd:\\05_code\\solo-bench'
  const key = workspaceKeyFor(canonical)
  assert.match(key, /^ws_[0-9a-f]{16}$/)
  assert.equal(key, `ws_${sha256Hex(canonical).slice(0, 16)}`)
  assert.equal(key.length, 19)
  assert.throws(() => workspaceKeyFor(''), TypeError)
})

test('UT-WS-03 legacy resolveWorkspace keeps header.cwd first, fallback, basename label', async () => {
  const fs = fakeFs({ 'C:\\Proj': 'C:\\Proj', 'C:\\Other': 'C:\\Other' })
  const workingDirectory = { get: () => 'C:\\Proj' }
  const fallback = await resolveWorkspace({ fs, workingDirectory, ...WIN32 }, { id: 's1', header: {} })
  assert.equal(fallback.canonicalPath, 'c:\\proj')
  assert.equal(fallback.key, workspaceKeyFor('c:\\proj'))
  assert.equal(fallback.label, 'proj', 'labels follow the canonical (lower-cased) path')

  const headerWins = await resolveWorkspace(
    { fs, workingDirectory, ...WIN32 },
    { id: 's2', header: { cwd: 'C:\\Other' } },
  )
  assert.equal(headerWins.label, 'other')
})

test('UT-WS-04 legacy createWorkspaceResolver freezes the first resolution per session', async () => {
  const fs = fakeFs({ 'C:\\A': 'C:\\A', 'C:\\B': 'C:\\B' })
  const resolver = createWorkspaceResolver({ fs, ...WIN32 })
  const first = await resolver.resolve({ id: 'session-freeze', header: { cwd: 'C:\\A' } })
  const second = await resolver.resolve({ id: 'session-freeze', header: { cwd: 'C:\\B' } })
  assert.equal(first.key, second.key)
  assert.equal(second.canonicalPath, 'c:\\a')
  assert.equal(fs.calls.length, 1, 'resolution happens once per session id')
})

// ---------------------------------------------------------------------------
// resolveOrigin — provenance only (delta §1)
// ---------------------------------------------------------------------------

test('UT-ORIGIN-01 different directories => different keys and basename labels, never a path', async () => {
  const fs = fakeFs({
    'C:\\a\\proj': 'C:\\a\\proj',
    'D:\\b\\other': 'D:\\b\\other',
  })
  const one = await resolveOrigin({ fs, ...WIN32 }, { id: 's1', header: { cwd: 'C:\\a\\proj' } })
  const two = await resolveOrigin({ fs, ...WIN32 }, { id: 's2', header: { cwd: 'D:\\b\\other' } })
  assert.deepEqual(one, { workspaceKey: workspaceKeyFor('c:\\a\\proj'), workspaceLabel: 'proj' })
  assert.deepEqual(two, { workspaceKey: workspaceKeyFor('d:\\b\\other'), workspaceLabel: 'other' })
  assert.notEqual(one.workspaceKey, two.workspaceKey)
  assert.notEqual(one.workspaceLabel, two.workspaceLabel)
  assert.deepEqual(Object.keys(one).sort(), ['workspaceKey', 'workspaceLabel'])
  assert.ok(Object.isFrozen(one))
  const serialized = JSON.stringify([one, two]).toLowerCase()
  assert.ok(!serialized.includes('c:\\\\a\\\\proj'), 'the canonical path never leaks into the origin')
  assert.ok(!serialized.includes('d:\\\\b\\\\other'), 'the canonical path never leaks into the origin')
})

test('UT-ORIGIN-02 same basename in different directories => same label, different key', async () => {
  const fs = fakeFs({
    'C:\\a\\proj': 'C:\\a\\proj',
    'D:\\b\\proj': 'D:\\b\\proj',
    'C:\\link\\proj': 'C:\\real\\proj',
    'C:\\other-link': 'C:\\real\\proj',
  })
  const one = await resolveOrigin({ fs, ...WIN32 }, { id: 's1', header: { cwd: 'C:\\a\\proj' } })
  const two = await resolveOrigin({ fs, ...WIN32 }, { id: 's2', header: { cwd: 'D:\\b\\proj' } })
  assert.equal(one.workspaceLabel, 'proj')
  assert.equal(two.workspaceLabel, 'proj')
  assert.notEqual(one.workspaceKey, two.workspaceKey, 'labels are display-only; keys stay distinct')

  // Symlinks/junctions to one target converge on the same provenance origin.
  const link = await resolveOrigin({ fs, ...WIN32 }, { id: 's3', header: { cwd: 'C:\\link\\proj' } })
  const junction = await resolveOrigin({ fs, ...WIN32 }, { id: 's4', header: { cwd: 'C:\\other-link' } })
  assert.deepEqual(link, junction)
  assert.equal(link.workspaceLabel, 'proj')
})

test('UT-ORIGIN-03 realpath failure => null (no lexical fallback, no throw)', async () => {
  const fs = fakeFs({}, { errorFor: ['C:\\Gone'] })
  assert.equal(await resolveOrigin({ fs, ...WIN32 }, { id: 's1', header: { cwd: 'C:\\Gone' } }), null)
  assert.equal(await resolveOrigin({ fs, ...WIN32 }, { id: 's2', header: {} }), null, 'no cwd => no origin')

  const throwing = {
    realpath() {
      throw new Error('EACCES')
    },
  }
  assert.equal(await resolveOrigin({ fs: throwing, ...WIN32 }, { id: 's3', header: { cwd: 'C:\\Any' } }), null)
  assert.equal(await canonicalizeDir('C:\\Any', { fs: throwing, ...WIN32 }), null)
  assert.equal(await canonicalizeDir('', { fs: throwing, ...WIN32 }), null)
  assert.equal(await canonicalizeDir(undefined, { fs: throwing, ...WIN32 }), null)
})

test('UT-ORIGIN-04 workingDirectory fallback; header.cwd wins when present', async () => {
  const fallbackFs = fakeFs({ 'C:\\Proj': 'C:\\Proj' })
  const workingDirectory = { get: () => 'C:\\Proj' }
  const fallback = await resolveOrigin(
    { fs: fallbackFs, workingDirectory, ...WIN32 },
    { id: 's1', header: {} },
  )
  assert.equal(fallback.workspaceLabel, 'proj')
  assert.equal(fallback.workspaceKey, workspaceKeyFor('c:\\proj'))
  assert.deepEqual(fallbackFs.calls, ['C:\\Proj'], 'the effective directory is what gets realpath-ed')

  const headerFs = fakeFs({ 'C:\\Header': 'C:\\Header', 'C:\\Effective': 'C:\\Effective' })
  const header = await resolveOrigin(
    { fs: headerFs, workingDirectory: { get: () => 'C:\\Effective' }, ...WIN32 },
    { id: 's2', header: { cwd: 'C:\\Header' } },
  )
  assert.equal(header.workspaceLabel, 'header')
  assert.deepEqual(headerFs.calls, ['C:\\Header'])
})

test('UT-ORIGIN-05 resolveOrigin never throws on broken sessions/deps', async () => {
  assert.equal(await resolveOrigin(undefined, null), null)
  assert.equal(await resolveOrigin(null, undefined), null)
  assert.equal(await resolveOrigin({}, {}), null)
  assert.equal(
    await resolveOrigin(
      { workingDirectory: { get: () => { throw new Error('boom') } }, ...WIN32 },
      { id: 's1', header: {} },
    ),
    null,
  )
  assert.equal(
    await resolveOrigin(
      { fs: fakeFs({}), ...WIN32 },
      {
        get header() {
          throw new Error('broken getter')
        },
      },
    ),
    null,
  )
  assert.equal(
    await resolveOrigin(
      { fs: { realpath: () => { throw null } }, ...WIN32 },
      { id: 's2', header: { cwd: 'C:\\x' } },
    ),
    null,
    'non-Error throws are swallowed too',
  )
  assert.equal(
    await resolveOrigin(
      { fs: fakeFs({}), workingDirectory: { get: () => 42 }, ...WIN32 },
      { id: 's3', header: { cwd: 7 } },
    ),
    null,
    'non-string cwd is ignored',
  )
})

test('UT-ORIGIN-06 filesystem root has a canonical key but an empty (never absolute) label', async () => {
  const fs = fakeFs({ 'C:\\': 'C:\\', '/': '/' })
  const win = await resolveOrigin({ fs, ...WIN32 }, { id: 's1', header: { cwd: 'C:\\' } })
  assert.equal(win.workspaceKey, workspaceKeyFor('c:\\'))
  assert.equal(win.workspaceLabel, '')
  assert.ok(!JSON.stringify(win).toLowerCase().includes('c:\\\\'), 'no drive path in the origin')

  const posix = await resolveOrigin({ fs, platform: 'linux' }, { id: 's2', header: { cwd: '/' } })
  assert.equal(posix.workspaceKey, workspaceKeyFor('/'))
  assert.equal(posix.workspaceLabel, '')
})

test('UT-ORIGIN-07 createOriginResolver caches per session id; cached() is synchronous', async () => {
  const fs = fakeFs({ 'C:\\A': 'C:\\A', 'C:\\B': 'C:\\B' })
  const resolver = createOriginResolver({ fs, ...WIN32 })
  const first = await resolver.resolve({ id: 'session-1', header: { cwd: 'C:\\A' } })
  assert.equal(resolver.cached('session-1'), first, 'the resolved origin is readable synchronously')
  assert.equal(resolver.cached('session-unknown'), null)
  assert.equal(resolver.cached(undefined), null)
  assert.equal(resolver.cached(null), null)

  const second = await resolver.resolve({ id: 'session-1', header: { cwd: 'C:\\B' } })
  assert.equal(second, first, 'a later cd cannot move provenance')
  assert.equal(fs.calls.length, 1, 'one realpath per session id')

  // A failed lookup is cached as "no origin" and never retried/thrown.
  assert.equal(await resolver.resolve({ id: 'session-gone', header: { cwd: 'C:\\Gone' } }), null)
  assert.equal(resolver.cached('session-gone'), null)
  assert.equal(fs.calls.length, 2)
  assert.equal(
    await resolver.resolve({
      get header() {
        throw new Error('broken session')
      },
    }),
    null,
  )
})

test('UT-ORIGIN-08 createOriginResolver without a session id does not cache but stays safe', async () => {
  const fs = fakeFs({ 'C:\\A': 'C:\\A' })
  const resolver = createOriginResolver({ fs, ...WIN32 })
  const session = { header: { cwd: 'C:\\A' } }
  const one = await resolver.resolve(session)
  const two = await resolver.resolve(session)
  assert.deepEqual(one, two)
  assert.equal(fs.calls.length, 2, 'no id => no cache key')
  assert.equal(resolver.cached('anything'), null)
})
