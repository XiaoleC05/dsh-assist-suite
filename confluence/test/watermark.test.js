// UT-WM / CON-WM — split watermark fold tests (WP4, v0.2.0 universal scope).
//
// Synthetic committed events only; no DSH runtime, no filesystem, no network.
// Contract: docs/adr/0007-universal-memory-scope.md,
// docs/plan/scope-refactor-delta.md §4, docs/plan/implementation-interfaces.md §8,
// docs/design/pulse.md §8 (tag superseded by the new <confluence-memory> tag;
// legacy <confluence-workspace> snapshots stay readable).
//
// Run: node --test "test/watermark.test.js"

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BOARD_READ_TOOLS,
  PULSE_SECTION_NAME,
  PULSE_TAG_NAME,
  WATERMARK_KEY,
  WATERMARK_STATE_VERSION,
  WatermarkTracker,
  createInitialState,
  createWatermarkProjectionDefinition,
  foldWatermarks,
  parseDigestMarker,
  parseThroughMarker,
} from '../lib/watermark.js'
import { buildPulseText } from '../lib/pulse.js'

const SEQ_A = '01J8Z6Q3M5AAAAAAAAAAAAAAAA'
const SEQ_B = '01J8Z6Q3M5BBBBBBBBBBBBBBBB'
const SEQ_C = '01J8Z6Q3M5CCCCCCCCCCCCCCCC'

/** @param {string} type @param {unknown} data @param {number} [seq] */
function ev(type, data, seq = 1) {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

/** @param {string} text @param {string} [sectionName] @param {boolean} [sections] */
function userRuntimeContext(text, sectionName = PULSE_SECTION_NAME, sections = true) {
  const data = {
    id: 'msg_1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: sections
      ? { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: 'cwd' }, { name: sectionName, text }] }
      : { kind: 'runtime-context' },
  }
  return ev('user/message', data, 10)
}

/** v0.2.0 pulse block: `<confluence-memory scope="global" …>`. */
function pulseBlock(seq, { welcome = false } = {}) {
  return [
    `<confluence-memory scope="global" peers="0" unread="0" seq="${seq}"${welcome ? ' welcome="1"' : ''}>`,
    'Shared memory for all sessions on this machine.',
    '</confluence-memory>',
  ].join('\n')
}

/** v0.1.0 pulse block committed by an older plugin version (legacy tag). */
function legacyPulseBlock(seq, { welcome = false, label = 'solo-bench' } = {}) {
  return [
    `<confluence-workspace name="${label}" peers="0" unread="0" seq="${seq}"${welcome ? ' welcome="1"' : ''}>`,
    'Background memory shared by sessions in this workspace.',
    '</confluence-workspace>',
  ].join('\n')
}

/** @param {string} callId @param {string} name @param {number} seq */
function toolCall(callId, name, seq = 20) {
  return ev('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' }, seq)
}

/** @param {string} callId @param {string} text @param {number} seq */
function toolResult(callId, text, seq = 21) {
  return ev(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: `m_${seq}`,
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
      },
    },
    seq,
  )
}

/** @param {string} subCallId @param {string} name @param {number} seq */
function ptcStart(subCallId, name, seq = 30) {
  return ev('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'parent', subCallId, name, arguments: '{}' }, seq)
}

/** @param {string} name @param {string} text @param {number} seq */
function ptcDispatch(name, text, seq = 31, subCallId = 'root:ptc:1') {
  return ev('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'parent', subCallId, name, arguments: '{}', isError: false, content: [{ type: 'text', text }] }, seq)
}

/** Fold a list of events from the initial state. */
function foldAll(events) {
  let state = createInitialState()
  for (const event of events) state = foldWatermarks(state, event)
  return state
}

/**
 * Minimal Cordis-like context for attach()/fallback tests.
 *
 * @param {object} [services]
 */
function makeCtx(services = {}) {
  const listeners = new Map()
  const ctx = {
    services,
    listeners,
    get(name) {
      return services[name]
    },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(fn)
        if (index >= 0) current.splice(index, 1)
      }
    },
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
    },
  }
  return ctx
}

/**
 * Fake projection service whose register() resolves a handle over mutable state.
 *
 * @param {{ fail?: 'throw' | 'reject' | false, stateRef?: object }} [options]
 */
function makeProjectionService({ fail = false, stateRef = { digestSeq: null, boardReadSeq: null, pending: {} } } = {}) {
  const calls = { register: 0, disposed: 0 }
  let definition = null
  const service = {
    register(candidate) {
      calls.register += 1
      definition = candidate
      if (fail === 'throw') throw new Error('projection registry exploded')
      const handle = {
        stateOf() {
          return stateRef
        },
        async dispose() {
          calls.disposed += 1
        },
      }
      if (fail === 'reject') return Promise.reject(new Error('projection registry rejected'))
      return Object.assign(() => Promise.resolve(), { then: (resolve) => Promise.resolve(handle).then(resolve) })
    },
  }
  return { service, calls, definition: () => definition }
}

// ── definition / state shape ────────────────────────────────────────────────

test('UT-WM-1 definition is one host-only projection unit with a plain parse schema', () => {
  const definition = createWatermarkProjectionDefinition()
  assert.equal(definition.key, WATERMARK_KEY)
  assert.equal(definition.key, 'confluence_watermark')
  assert.equal(definition.stateVersion, WATERMARK_STATE_VERSION)
  assert.equal(definition.stateVersion, 1)
  assert.equal(typeof definition.stateSchema.parse, 'function')
  assert.equal(typeof definition.init, 'function')
  assert.equal(typeof definition.apply, 'function')
  // Host-only: no wire view means the state is checkpointed but never sent to clients.
  assert.ok(!Object.hasOwn(definition, 'wire'))
})

test('UT-WM-2 stateSchema.parse tolerates garbage and normalizes only known fields', () => {
  const { stateSchema } = createWatermarkProjectionDefinition()
  for (const garbage of [undefined, null, 0, 'x', [], {}, { digestSeq: 5 }]) {
    const state = stateSchema.parse(garbage)
    assert.deepEqual(state, { digestSeq: null, boardReadSeq: null, inboxReadSeq: null, pending: {} })
  }
  const parsed = stateSchema.parse({
    digestSeq: SEQ_A,
    boardReadSeq: SEQ_B,
    pending: { c1: 'confluence_board', c2: 'other_tool', c3: 'confluence_read' },
  })
  assert.deepEqual(parsed, {
    digestSeq: SEQ_A,
    boardReadSeq: SEQ_B,
    inboxReadSeq: null,
    pending: { c1: 'confluence_board', c3: 'confluence_read' },
  })
})

test('UT-WM-3 init returns a fresh null-cursor state per call', () => {
  const { init } = createWatermarkProjectionDefinition()
  const first = init({}, 0)
  const second = init({}, 0)
  assert.deepEqual(first, { digestSeq: null, boardReadSeq: null, inboxReadSeq: null, pending: {} })
  assert.notEqual(first, second)
  assert.notEqual(first.pending, second.pending)
})

test('UT-WM-4 PULSE_TAG_NAME is the universal tag', () => {
  assert.equal(PULSE_TAG_NAME, 'confluence-memory')
  assert.equal(PULSE_SECTION_NAME, 'confluence:pulse')
})

// ── digestSeq fold ──────────────────────────────────────────────────────────

test('CON-WM-1 digestSeq folds the <confluence-memory …> header seq attribute', () => {
  const state = foldAll([userRuntimeContext(pulseBlock(SEQ_A))])
  assert.equal(state.digestSeq, SEQ_A)
  assert.equal(state.boardReadSeq, null)
})

test('CON-WM-2 digestSeq folds the sentinel seq="0" (empty-board welcome)', () => {
  const state = foldAll([userRuntimeContext(pulseBlock('0', { welcome: true }))])
  assert.equal(state.digestSeq, '0')
})

test('CON-WM-3 digestSeq accepts the escaped tag/quote form defensively', () => {
  const escaped = [
    '\\u003cconfluence-memory scope=\\u0022global\\u0022 peers=\\u00220\\u0022 unread=\\u00220\\u0022 seq=\\u0022' + SEQ_B + '\\u0022\\u003e',
    'body',
  ].join('\n')
  const state = foldAll([userRuntimeContext(escaped)])
  assert.equal(state.digestSeq, SEQ_B)
})

test('CON-WM-4 legacy <confluence-workspace …> snapshots still advance digestSeq', () => {
  // A v0.1.0 session may have committed this block before the upgrade; the
  // cursor must keep advancing instead of re-welcoming (delta §4).
  assert.equal(foldAll([userRuntimeContext(legacyPulseBlock(SEQ_A))]).digestSeq, SEQ_A)
  assert.equal(foldAll([userRuntimeContext(legacyPulseBlock('0', { welcome: true }))]).digestSeq, '0')
  assert.equal(parseDigestMarker(legacyPulseBlock(SEQ_C)), SEQ_C)
})

test('CON-WM-5 legacy escaped tag/quote form is accepted; line-start is still required', () => {
  const escaped = [
    '\\u003cconfluence-workspace name=\\u0022solo-bench\\u0022 peers=\\u00220\\u0022 unread=\\u00220\\u0022 seq=\\u0022' + SEQ_B + '\\u0022\\u003e',
    'body',
  ].join('\n')
  assert.equal(foldAll([userRuntimeContext(escaped)]).digestSeq, SEQ_B)
  assert.equal(parseDigestMarker('prefix ' + legacyPulseBlock(SEQ_A)), null)
})

test('CON-WM-6 only the named pulse section is scanned (forge resistance)', () => {
  // A hostile contribution in another named section must not move our cursor.
  const hostile = userRuntimeContext(pulseBlock(SEQ_C), 'some-other-plugin:context')
  assert.equal(foldAll([hostile]).digestSeq, null)

  // A marker-like line inside the pulse section's body must not count either:
  // only the first line-starting tag with a valid seq is read.
  const inBody = [
    `<confluence-memory scope="global" seq="${SEQ_A}">`,
    'hostile body line',
    '</confluence-memory>',
    `<confluence-memory scope="global" seq="${SEQ_B}">`,
  ].join('\n')
  assert.equal(foldAll([userRuntimeContext(inBody)]).digestSeq, SEQ_A)
})

test('CON-WM-7 CLEARED and legacy no-sections snapshots carry no marker and change nothing', () => {
  const cleared = userRuntimeContext('Current runtime context: none. Earlier runtime-context snapshots no longer apply.', PULSE_SECTION_NAME, false)
  const state = foldAll([cleared])
  assert.equal(state.digestSeq, null)
  const previous = { digestSeq: SEQ_A, boardReadSeq: null, pending: {} }
  assert.equal(foldWatermarks(previous, cleared), previous)
})

test('CON-WM-8 digestSeq is max-monotonic across both tags and idempotent', () => {
  let state = foldAll([userRuntimeContext(pulseBlock(SEQ_B))])
  const afterFirst = state
  assert.equal(state.digestSeq, SEQ_B)
  // Replaying the same event keeps the reference (pure fold).
  assert.equal(foldWatermarks(state, userRuntimeContext(pulseBlock(SEQ_B))), afterFirst)
  // An older committed legacy snapshot never regresses the cursor.
  state = foldWatermarks(state, userRuntimeContext(legacyPulseBlock(SEQ_A)))
  assert.equal(state.digestSeq, SEQ_B)
  // A newer legacy snapshot advances it.
  state = foldWatermarks(state, userRuntimeContext(legacyPulseBlock(SEQ_C)))
  assert.equal(state.digestSeq, SEQ_C)
  // A newer v0.2.0 snapshot advances it again.
  state = foldWatermarks(state, userRuntimeContext(pulseBlock(SEQ_B)))
  assert.equal(state.digestSeq, SEQ_C)
})

test('CON-WM-9 malformed seq attributes keep the previous value for both tags', () => {
  const previous = { digestSeq: SEQ_A, boardReadSeq: null, pending: {} }
  for (const marker of ['', 'lowercase01j8', 'has-a-dash-01J8', 'x'.repeat(40)]) {
    const current = `<confluence-memory scope="global" peers="0" unread="0" seq="${marker}">`
    const legacy = `<confluence-workspace name="w" peers="0" unread="0" seq="${marker}">`
    assert.equal(foldWatermarks(previous, userRuntimeContext(current)), previous)
    assert.equal(foldWatermarks(previous, userRuntimeContext(legacy)), previous)
  }
})

test('CON-WM-10 digest fold never throws on garbage events', () => {
  const previous = { digestSeq: SEQ_A, boardReadSeq: null, pending: {} }
  const garbage = [
    null,
    undefined,
    42,
    {},
    { type: 'user/message' },
    { type: 'user/message', data: null },
    { type: 'user/message', data: { content: null, source: null } },
    { type: 'user/message', data: { content: 'text', source: { kind: 'runtime-context', sections: 'nope' } } },
    { type: 'user/message', data: { content: [null, 1, { type: 'text', text: 7 }], source: { kind: 'runtime-context' } } },
  ]
  for (const event of garbage) {
    assert.equal(foldWatermarks(previous, event), previous)
  }
})

// ── boardReadSeq fold ───────────────────────────────────────────────────────

test('CON-WM-11 boardReadSeq folds a through= marker only for Our tools', () => {
  const call = toolCall('c1', 'confluence_board')
  const result = toolResult('c1', 'Board:\n- note\nthrough=' + SEQ_A)
  const state = foldAll([call, result])
  assert.equal(state.boardReadSeq, SEQ_A)
  assert.deepEqual(state.pending, {})
})

test('CON-WM-12 another tool result carrying through= never advances the cursor', () => {
  const call = toolCall('c2', 'some_other_tool')
  const result = toolResult('c2', 'through=' + SEQ_C)
  const state = foldAll([call, result])
  assert.equal(state.boardReadSeq, null)
  // The pending map only tracks our tools (bounded).
  assert.deepEqual(state.pending, {})
})

test('CON-WM-13 a result without a marker leaves the cursor and clears the pending call', () => {
  const state = foldAll([toolCall('c3', 'confluence_read'), toolResult('c3', 'Error: NOT_FOUND')])
  assert.equal(state.boardReadSeq, null)
  assert.deepEqual(state.pending, {})
})

test('CON-WM-14 malformed through values keep the previous cursor', () => {
  const previous = { digestSeq: null, boardReadSeq: SEQ_A, pending: { c4: 'confluence_board' } }
  for (const marker of ['', 'lower01j8', 'x'.repeat(30)]) {
    const state = foldWatermarks(previous, toolResult('c4', 'body\nthrough=' + marker))
    assert.equal(state.boardReadSeq, SEQ_A)
  }
})

test('CON-WM-15 ptc-dispatch result advances the cursor and start events feed the pending map', () => {
  let state = foldAll([ptcStart('root:ptc:1', 'confluence_board')])
  assert.deepEqual(state.pending, { 'root:ptc:1': 'confluence_board' })
  state = foldWatermarks(state, ptcDispatch('confluence_board', 'Board:\nthrough=' + SEQ_B))
  assert.equal(state.boardReadSeq, SEQ_B)
  assert.deepEqual(state.pending, {})
  // A non-Confluence dispatch does nothing.
  const previous = state
  assert.equal(foldWatermarks(previous, ptcDispatch('read', 'through=' + SEQ_C)), previous)
})

test('CON-WM-16 the pending call map is bounded to 16 entries', () => {
  let state = createInitialState()
  for (let index = 0; index < 20; index += 1) state = foldWatermarks(state, toolCall(`call-${index}`, 'confluence_board'))
  assert.equal(Object.keys(state.pending).length, 16)
  assert.equal(state.pending['call-0'], undefined)
  assert.equal(state.pending['call-19'], 'confluence_board')
})

test('CON-WM-17 both cursors are independent and replay is order-insensitive (max)', () => {
  const events = [
    userRuntimeContext(pulseBlock(SEQ_A)),
    toolCall('c1', 'confluence_board'),
    toolResult('c1', 'through=' + SEQ_B),
  ]
  const forward = foldAll(events)
  const replayTwice = foldAll([...events, ...events])
  assert.deepEqual(forward, replayTwice)
  assert.equal(forward.digestSeq, SEQ_A)
  assert.equal(forward.boardReadSeq, SEQ_B)
})

test('CON-WM-18 apply does not mutate the previous state object', () => {
  const previous = createInitialState()
  const snapshot = JSON.parse(JSON.stringify(previous))
  foldWatermarks(previous, toolCall('c1', 'confluence_board'))
  foldWatermarks(previous, userRuntimeContext(pulseBlock(SEQ_A)))
  assert.deepEqual(previous, snapshot)
})

test('CON-WM-19 forked/copied prefix folds deterministically from init', () => {
  const inheritedPrefix = [userRuntimeContext(pulseBlock(SEQ_A)), toolCall('c1', 'confluence_board'), toolResult('c1', 'through=' + SEQ_B)]
  const child = foldAll(inheritedPrefix)
  const rederived = foldAll(inheritedPrefix)
  assert.deepEqual(child, rederived)
  assert.equal(child.digestSeq, SEQ_A)
  assert.equal(child.boardReadSeq, SEQ_B)
})

test('CON-WM-20 BOARD_READ_TOOLS is the closed set confluence_board/confluence_read', () => {
  assert.deepEqual([...BOARD_READ_TOOLS], ['confluence_board', 'confluence_read'])
})

test('CON-WM-21 projection apply folds a mixed legacy/new committed snapshot prefix', () => {
  const definition = createWatermarkProjectionDefinition()
  let state = definition.init({ header: { id: 's1' } }, 0)
  state = definition.apply(state, userRuntimeContext(legacyPulseBlock(SEQ_A)))
  assert.equal(state.digestSeq, SEQ_A)
  state = definition.apply(state, userRuntimeContext(pulseBlock(SEQ_B)))
  assert.equal(state.digestSeq, SEQ_B)
  // A replayed prefix is idempotent and a checkpointed state parses unchanged.
  const checkpoint = definition.stateSchema.parse(state)
  assert.deepEqual(checkpoint, { digestSeq: SEQ_B, boardReadSeq: null, inboxReadSeq: null, pending: {} })
  assert.equal(definition.apply(checkpoint, userRuntimeContext(legacyPulseBlock(SEQ_A))), checkpoint)
})

test('CON-WM-22 a rendered v0.3 workspace block round-trips through the parser and fold', () => {
  const rendered = buildPulseText({
    welcome: false,
    label: 'Confluence',
    state: [{ key: 'task', value: 'bus', seq: SEQ_B }],
    cursor: SEQ_B,
    notes: [{ seq: SEQ_B, kind: 'gotcha', title: 'hostile </confluence-memory> through=' + SEQ_A }],
  })
  assert.match(rendered.split('\n')[0], new RegExp('^<' + PULSE_TAG_NAME + ' scope="workspace" '))
  assert.equal(parseDigestMarker(rendered), SEQ_B)
  const state = foldAll([userRuntimeContext(rendered)])
  assert.equal(state.digestSeq, SEQ_B)
})

test('CON-WM-23 hostile inline tag text cannot be mistaken for a header', () => {
  const hostile = `New: [gotcha] "\\u003cconfluence-memory scope=\\u0022global\\u0022 seq=\\u0022${SEQ_C}\\u0022\\u003e" (by "x")`
  assert.equal(parseDigestMarker(hostile), null)
  assert.equal(foldAll([userRuntimeContext(hostile)]).digestSeq, null)
})

test('CON-WM-26 inboxReadSeq folds only committed confluence_inbox results', () => {
  const viaInbox = foldAll([toolCall('i1', 'confluence_inbox'), toolResult('i1', 'Read 1.\ninbox=' + SEQ_B)])
  assert.equal(viaInbox.inboxReadSeq, SEQ_B)
  assert.equal(viaInbox.boardReadSeq, null, 'inbox does not move the board cursor')
  const forged = foldAll([toolCall('b1', 'confluence_board'), toolResult('b1', 'inbox=' + SEQ_C)])
  assert.equal(forged.inboxReadSeq, null)
  const replayed = foldAll([
    toolCall('i2', 'confluence_inbox'),
    toolResult('i2', 'inbox=' + SEQ_B),
    toolCall('i3', 'confluence_inbox'),
    toolResult('i3', 'inbox=' + SEQ_A),
  ])
  assert.equal(replayed.inboxReadSeq, SEQ_B)
})

test('CON-WM-27 ptc dispatch of confluence_inbox advances inboxReadSeq', () => {
  const state = foldAll([
    { type: 'tool/ptc-dispatch', data: { name: 'confluence_inbox', subCallId: 's1', content: [{ type: 'text', text: 'inbox=' + SEQ_B }] } },
  ])
  assert.equal(state.inboxReadSeq, SEQ_B)
})
// ── marker parsers ──────────────────────────────────────────────────────────

test('UT-WM-5 parseDigestMarker requires a line-starting tag and a valid seq', () => {
  assert.equal(parseDigestMarker(pulseBlock(SEQ_A)), SEQ_A)
  assert.equal(parseDigestMarker(legacyPulseBlock(SEQ_B)), SEQ_B)
  assert.equal(parseDigestMarker('prefix ' + pulseBlock(SEQ_A)), null)
  assert.equal(parseDigestMarker(`<confluence-memory seq="notaseq">`), null)
  assert.equal(parseDigestMarker(''), null)
  assert.equal(parseDigestMarker(null), null)
  // Lowercase / non-uppercase alphabets are not our wire alphabet.
  assert.equal(parseDigestMarker('<confluence-memory scope="global" seq="01j8z6q3m5">'), null)
  assert.equal(parseDigestMarker('<confluence-workspace name="w" seq="01j8z6q3m5">'), null)
})

test('UT-WM-6 parseThroughMarker reads the marker inside the rendered tool result', () => {
  assert.equal(parseThroughMarker('a\nthrough=' + SEQ_A), SEQ_A)
  assert.equal(parseThroughMarker('a\nthrough=' + SEQ_A + '\n\n'), SEQ_A)
  // Real tool results wrap the marker: closing tag lines follow it (v0.2.0 bugfix).
  assert.equal(
    parseThroughMarker('a\nthrough=' + SEQ_A + '\n</confluence-board>\n</confluence-result>'),
    SEQ_A,
  )
  // Renderer text after the marker does not hide it; the last valid marker wins.
  assert.equal(parseThroughMarker('through=' + SEQ_A + '\nmore text'), SEQ_A)
  assert.equal(parseThroughMarker('through=' + SEQ_A + '\nthrough=' + SEQ_B), SEQ_B)
  assert.equal(parseThroughMarker('through=bad-value!'), null)
  assert.equal(parseThroughMarker(''), null)
})

// ── tracker lifecycle: projection path ──────────────────────────────────────

test('UT-WM-7 attach awaits registration, retains the handle and reads stateOf', async () => {
  const stateRef = { digestSeq: SEQ_A, boardReadSeq: SEQ_B, pending: {} }
  const { service, calls, definition } = makeProjectionService({ stateRef })
  const ctx = makeCtx({ sessionProjections: service })
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: { now: () => 0 } })
  await tracker.attach(ctx)

  assert.equal(calls.register, 1)
  assert.equal(definition().key, WATERMARK_KEY)
  assert.equal(definition().stateVersion, 1)
  const session = { id: 's1', header: { id: 's1' } }
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: SEQ_B, inboxReadSeq: null })
  // Only the two public cursors are exposed, never the internal pending map.
  assert.deepEqual(Object.keys(tracker.get(session)).sort(), ['boardReadSeq', 'digestSeq', 'inboxReadSeq'])

  await tracker.dispose()
  assert.equal(calls.disposed, 1)
})

test('UT-WM-8 attach degrades when sessionProjections is absent or broken', async () => {
  for (const options of [{}, { service: { register() { throw new Error('boom') } } }, makeProjectionService({ fail: 'reject' }).service]) {
    const services = options.service ? { sessionProjections: options.service } : {}
    const ctx = makeCtx(services)
    const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
    await assert.doesNotReject(() => tracker.attach(ctx))
    assert.deepEqual(tracker.get({ id: 's1', header: { id: 's1' } }), { digestSeq: null, boardReadSeq: null, inboxReadSeq: null })
    await tracker.dispose()
  }
})

test('UT-WM-9 a throwing stateOf falls back to the degraded map', async () => {
  const service = {
    register() {
      const handle = { stateOf() { throw new Error('no session') }, async dispose() {} }
      return Object.assign(() => Promise.resolve(), { then: (resolve) => Promise.resolve(handle).then(resolve) })
    },
  }
  const ctx = makeCtx({ sessionProjections: service })
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  tracker.observeDigestCommit('s1', SEQ_A)
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: null, inboxReadSeq: null })
  await tracker.dispose()
})

// ── tracker lifecycle: degraded fallback ────────────────────────────────────

test('CON-WM-24 without projections a session/event listener keeps in-memory cursors', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  ctx.emit('session/event', session, userRuntimeContext(pulseBlock(SEQ_A)))
  ctx.emit('session/event', session, toolCall('c1', 'confluence_board'))
  ctx.emit('session/event', session, toolResult('c1', 'through=' + SEQ_B))
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: SEQ_B, inboxReadSeq: null })
  await tracker.dispose()
})

test('CON-WM-25 the agent/created replay seeds cursors from a bounded reverse scan', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  // The newest committed user snapshot is a v0.1.0 legacy block: it must still
  // seed the digest cursor instead of forcing a re-welcome.
  const events = [userRuntimeContext(pulseBlock(SEQ_C)), userRuntimeContext(legacyPulseBlock(SEQ_A)), toolCall('c1', 'confluence_board'), toolResult('c1', 'through=' + SEQ_B)]
  const session = { id: 's1', header: { id: 's1' }, snapshotEvents: () => events }
  ctx.emit('agent/created', { agent: { session } })
  assert.deepEqual(tracker.get(session), { digestSeq: SEQ_A, boardReadSeq: SEQ_B, inboxReadSeq: null })
  await tracker.dispose()
})

test('CON-WM-26 session/disposed drops degraded state and observeDigestCommit is monotonic', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  tracker.observeDigestCommit('s1', SEQ_B)
  tracker.observeDigestCommit('s1', SEQ_A)
  assert.equal(tracker.get(session).digestSeq, SEQ_B)
  tracker.observeDigestCommit('s1', 'garbage')
  assert.equal(tracker.get(session).digestSeq, SEQ_B)
  ctx.emit('session/disposed', session)
  assert.equal(tracker.get(session).digestSeq, null)
  await tracker.dispose()
})

test('UT-WM-10 dispose is idempotent and removes listeners', async () => {
  const ctx = makeCtx({})
  const tracker = new WatermarkTracker({ config: {}, logger: null, deps: {} })
  await tracker.attach(ctx)
  const session = { id: 's1', header: { id: 's1' } }
  await tracker.dispose()
  await tracker.dispose()
  ctx.emit('session/event', session, userRuntimeContext(pulseBlock(SEQ_A)))
  assert.equal(tracker.get(session).digestSeq, null)
})
