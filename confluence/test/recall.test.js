// WP3c tests — universal recall: enumeration across the whole profile, caller/private exclusion,
// caps/ordering/deadline/partial behaviour, redacted excerpts, source session titles, readRef.
// Contract: docs/adr/0007-universal-memory-scope.md §2.4; docs/plan/scope-refactor-delta.md §5;
// docs/design/ledger-recall.md §5–§6, §8 R1–R10.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RecallService, parseSessionRef, roundRobin } from '../lib/recall.js'

const CALLER_ID = 'session-caller'
const CWD_A = process.platform === 'win32' ? 'D:\\WS-A' : '/ws-a'
const CWD_B = process.platform === 'win32' ? 'D:\\WS-B' : '/ws-b'
const CWD_C = process.platform === 'win32' ? 'D:\\WS-C' : '/ws-c'

/** The agent shape only needs identity now: recall never derives a workspace from cwd. */
function agentFor(id = CALLER_ID, cwd) {
  const header = cwd === undefined ? { id } : { id, cwd }
  return { id, session: { id, header } }
}

function record(id, cwd, createdAt = '2026-11-13T01:00:00.000Z') {
  const header = { id, createdAt }
  if (cwd !== undefined) header.cwd = cwd
  return { header, live: false, persisted: true }
}

function doc(sessionId, seq, text, type = 'assistant/message') {
  return { sessionId, seq, type, time: '2026-11-13T01:00:00.000Z', text }
}

function fakeRedactor() {
  return {
    text: (input) => {
      const source = typeof input === 'string' ? input : String(input ?? '')
      const value = source.replace(/\bsk-[A-Za-z0-9]{6,}\b/g, '[redacted:secret]')
      return { value, hits: value === source ? 0 : 1 }
    },
    title: (input) => ({ value: String(input ?? ''), hits: 0 }),
  }
}

/**
 * Fake `ctx.sessionQuery`. `readEvent` throws for an unknown session id, like the real service
 * does for a ref that cannot be read (readRef maps that to NOT_FOUND).
 * @param {object} options { records, eventsById, readEventsById, titles, listDelayMs }
 */
function makeSessionQuery(options = {}) {
  const calls = { listSessions: 0, filterEvents: [], readEvent: [] }
  const knownReads = options.readEventsById ?? {}
  const sq = {
    calls,
    async listSessions() {
      calls.listSessions += 1
      if (options.listDelayMs) await new Promise((resolve) => setTimeout(resolve, options.listDelayMs))
      if (typeof options.listSessions === 'function') return options.listSessions(calls.listSessions)
      return options.records ?? []
    },
    async filterEvents(sessionId, filters) {
      calls.filterEvents.push({ sessionId, filters })
      const value = options.eventsById?.[sessionId]
      if (typeof value === 'function') return value()
      return Array.isArray(value) ? value : []
    },
    async readEvent(request) {
      calls.readEvent.push(request)
      if (!(request.sessionId in knownReads)) throw new Error(`unknown session ${request.sessionId}`)
      const value = knownReads[request.sessionId]
      if (typeof value === 'function') return value(request)
      return value
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({ id, title: options.titles?.[id] ?? `Title ${id}` }))
    },
    async readTitle(id) {
      return options.titles?.[id] ?? `Title ${id}`
    },
  }
  return sq
}

function createRecall(options = {}) {
  return new RecallService({
    config: { recall: { maxSessions: 3, maxHits: 5, timeoutMs: options.timeoutMs ?? 5000 }, ...options.config },
    logger: { warn() {}, debug() {} },
    deps: {
      sessionQuery: options.sessionQuery,
      redactor: options.redactor ?? fakeRedactor(),
      ...options.deps,
    },
  })
}

// ---------------------------------------------------------------------------
// enabled / degradation
// ---------------------------------------------------------------------------

test('CON-R8 absent sessionQuery: enabled() false and forced call throws RECALL_UNAVAILABLE', async () => {
  const recall = createRecall({ sessionQuery: undefined })
  assert.equal(recall.enabled(), false)
  await assert.rejects(() => recall.recall({ agent: agentFor(), query: 'fixture' }), (error) => {
    assert.equal(error.code, 'RECALL_UNAVAILABLE')
    return true
  })
  await assert.rejects(
    () => recall.readRef({ agent: agentFor(), ref: 'session:session-x:1' }),
    (error) => error.code === 'RECALL_UNAVAILABLE',
  )
})

test('CON-R8 listSessions failure maps to RECALL_UNAVAILABLE with cause', async () => {
  const sq = makeSessionQuery({
    listSessions: () => {
      throw new Error('persistence offline')
    },
  })
  const recall = createRecall({ sessionQuery: sq })
  await assert.rejects(() => recall.recall({ agent: agentFor(), query: 'fixture' }), (error) => {
    assert.equal(error.code, 'RECALL_UNAVAILABLE')
    assert.match(error.message, /persistence offline/)
    return true
  })
})

// ---------------------------------------------------------------------------
// headline: cross-workspace recall + caller/private exclusion
// ---------------------------------------------------------------------------

test('CON-X2 recall finds text from a session with a DIFFERENT cwd (universal memory)', async () => {
  const sq = makeSessionQuery({
    records: [
      record(CALLER_ID, CWD_A),
      record('session-other-workspace', CWD_B),
      record('session-no-cwd'),
      record('session-private', CWD_C),
      record('session-third', CWD_C),
    ],
    eventsById: {
      'session-other-workspace': [doc('session-other-workspace', 11, 'the fixture timeout fix lives here')],
      'session-no-cwd': [doc('session-no-cwd', 12, 'timeout notes without a directory')],
      'session-private': [doc('session-private', 13, 'timeout secret')],
      'session-third': [doc('session-third', 14, 'another timeout mention')],
      'session-caller': [doc('session-caller', 15, 'caller timeout text')],
    },
  })
  const recall = createRecall({
    sessionQuery: sq,
    config: { privacy: { privateSessions: ['session-private'] } },
  })
  // The caller is in CWD_A; the matching session lives in CWD_B and another has no cwd at all.
  const result = await recall.recall({ agent: agentFor(CALLER_ID, CWD_A), query: 'fixture timeout' })
  const searchedIds = sq.calls.filterEvents.map((call) => call.sessionId)
  assert.equal(searchedIds.includes('session-other-workspace'), true, 'different cwd is searched')
  assert.equal(searchedIds.includes('session-no-cwd'), true, 'a session without cwd is searched')
  assert.equal(searchedIds.includes(CALLER_ID), false, 'caller dropped')
  assert.equal(searchedIds.includes('session-private'), false, 'private target excluded')
  assert.deepEqual(
    result.hits.map((hit) => hit.sessionId).sort(),
    ['session-no-cwd', 'session-other-workspace', 'session-third'],
    'literal matches from every eligible session are returned regardless of cwd',
  )
  const otherWorkspaceHit = result.hits.find((hit) => hit.sessionId === 'session-other-workspace')
  assert.match(otherWorkspaceHit.excerpt, /fixture timeout/)
  assert.equal(result.sessions_searched, 3, 'three eligible sessions were scanned (≤3 cap)')
  assert.equal(result.eligible_sessions, 3)
})

test('UT-RECALL-01 caller identity works without any cwd and no workspace key is accepted', async () => {
  const sq = makeSessionQuery({
    records: [record('session-a'), record('session-b', CWD_B)],
    eventsById: { 'session-b': [doc('session-b', 1, 'needle in b')] },
  })
  const recall = createRecall({ sessionQuery: sq })
  // No header.cwd anywhere, and a stray legacy workspaceKey argument must not matter.
  const agent = { id: CALLER_ID, session: { id: CALLER_ID, header: {} }, workspaceKey: CWD_A }
  const result = await recall.recall({ agent, query: 'needle', workspaceKey: CWD_A })
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].sessionId, 'session-b')
  assert.deepEqual(
    sq.calls.filterEvents.map((call) => call.sessionId).sort(),
    ['session-a', 'session-b'],
    'both profile sessions are scanned even without any cwd',
  )
})

test('UT-RECALL-02 private caller is refused', async () => {
  const sq = makeSessionQuery({ records: [record('session-a')] })
  const recall = createRecall({
    sessionQuery: sq,
    config: { privacy: { privateSessions: [CALLER_ID] } },
  })
  await assert.rejects(() => recall.recall({ agent: agentFor(), query: 'needle' }), (error) => {
    assert.equal(error.code, 'RECALL_UNAVAILABLE')
    return true
  })
  assert.equal(sq.calls.listSessions, 0, 'a private caller never enumerates anything')
})

// ---------------------------------------------------------------------------
// caps / ordering / round-robin
// ---------------------------------------------------------------------------

test('CON-R4 caps: ≤3 sessions loaded, ≤5 hits round-robin, deterministic order', async () => {
  const records = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e'].map(
    (id, index) =>
      record(id, [CWD_A, CWD_B, CWD_C][index % 3], new Date(1_700_000_000_000 + (5 - index) * 1000).toISOString()),
  )
  const eventsById = {
    'session-a': Array.from({ length: 10 }, (_, index) => doc('session-a', index + 1, `a${index} needle`)),
    'session-b': [doc('session-b', 1, 'b0 needle'), doc('session-b', 2, 'b1 needle')],
    'session-c': [doc('session-c', 1, 'c0 needle')],
    'session-d': [doc('session-d', 1, 'd0 needle')],
    'session-e': [doc('session-e', 1, 'e0 needle')],
  }
  const sq = makeSessionQuery({ records, eventsById })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.recall({ agent: agentFor(CALLER_ID, CWD_A), query: 'needle', limit: 5 })
  assert.equal(sq.calls.filterEvents.length, 3, 'only three sessions are loaded')
  assert.equal(result.hits.length, 5)
  assert.equal(result.sessions_searched, 3)
  assert.equal(result.sessions_matched, 3)
  // A first (10 docs), B second, C third => A0 B0 C0 A1 B1 by round-robin.
  assert.deepEqual(
    result.hits.map((hit) => hit.ref),
    [
      'session:session-a:1',
      'session:session-b:1',
      'session:session-c:1',
      'session:session-a:2',
      'session:session-b:2',
    ],
  )
  assert.equal(result.truncated, true)
  assert.equal(result.hits[0].session_id, 'session-a')
})

test('UT-RECALL-03 recency order + deterministic id tie-break from header.createdAt', async () => {
  const records = [
    record('session-old', CWD_A, '2026-11-13T00:00:00.000Z'),
    record('session-new', CWD_B, '2026-11-13T02:00:00.000Z'),
    record('session-tie-b', CWD_C, '2026-11-13T01:00:00.000Z'),
    record('session-tie-a', undefined, '2026-11-13T01:00:00.000Z'),
  ]
  const sq = makeSessionQuery({
    records,
    eventsById: {
      'session-old': [doc('session-old', 1, 'needle old')],
      'session-new': [doc('session-new', 1, 'needle new')],
      'session-tie-b': [doc('session-tie-b', 1, 'needle b')],
      'session-tie-a': [doc('session-tie-a', 1, 'needle a')],
    },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.recall({ agent: agentFor(), query: 'needle' })
  assert.deepEqual(
    result.hits.map((hit) => hit.sessionId),
    ['session-new', 'session-tie-a', 'session-tie-b'],
  )
})

test('UT-RECALL-03b optional ledger view supplies recency', async () => {
  const sq = makeSessionQuery({
    records: [record('session-old', CWD_A, '2026-11-13T05:00:00.000Z'), record('session-active', CWD_B)],
    eventsById: { 'session-active': [doc('session-active', 1, 'needle active')] },
  })
  const ledgerRows = new Map([['session-active', { lastActivityTs: '2026-11-13T06:00:00.000Z' }]])
  const recall = createRecall({
    sessionQuery: sq,
    deps: { ledger: { ledger: () => ledgerRows } },
  })
  const result = await recall.recall({ agent: agentFor(), query: 'needle' })
  assert.equal(result.hits[0].sessionId, 'session-active', 'ledger recency wins over createdAt')
})

// ---------------------------------------------------------------------------
// deadline / partial
// ---------------------------------------------------------------------------

test('CON-R5 timeout: partial hits returned, timed_out true, losing promise rejection contained', async () => {
  const records = [
    record('session-fast', CWD_A, '2026-11-13T02:00:00.000Z'),
    record('session-slow', CWD_B, '2026-11-13T01:00:00.000Z'),
  ]
  const sq = makeSessionQuery({
    records,
    eventsById: {
      'session-fast': [doc('session-fast', 1, 'needle fast')],
      'session-slow': () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('late log load failure')), 1200)
        }),
    },
  })
  const recall = createRecall({ sessionQuery: sq, timeoutMs: 500 })
  const started = Date.now()
  const result = await recall.recall({ agent: agentFor(), query: 'needle' })
  const elapsed = Date.now() - started
  assert.equal(result.timed_out, true)
  assert.equal(result.partial, true)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].sessionId, 'session-fast')
  assert.ok(elapsed < 2000, 'deadline is cooperative, not the slow promise latency')
  // The abandoned load's rejection must not surface as an unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 1300))
})

test('CON-R5 zero hits + timeout raises RECALL_TIMEOUT', async () => {
  const sq = makeSessionQuery({
    records: [record('session-slow', CWD_A)],
    eventsById: {
      'session-slow': () => new Promise((resolve) => setTimeout(() => resolve([]), 1500)),
    },
  })
  const recall = createRecall({ sessionQuery: sq, timeoutMs: 500 })
  await assert.rejects(() => recall.recall({ agent: agentFor(), query: 'needle' }), (error) => {
    assert.equal(error.code, 'RECALL_TIMEOUT')
    return true
  })
  await new Promise((resolve) => setTimeout(resolve, 1600))
})

test('UT-RECALL-04 one-session failure is skipped and marked partial', async () => {
  const records = [record('session-a', CWD_A, '2026-11-13T02:00:00.000Z'), record('session-b', CWD_B)]
  const sq = makeSessionQuery({
    records,
    eventsById: {
      'session-a': () => {
        throw new Error('corrupt log')
      },
      'session-b': [doc('session-b', 1, 'needle survived')],
    },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.recall({ agent: agentFor(), query: 'needle' })
  assert.equal(result.partial, true)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].sessionId, 'session-b')
})

// ---------------------------------------------------------------------------
// excerpts / redaction / literal matching
// ---------------------------------------------------------------------------

test('CON-R6 redaction + neutralisation of excerpts; literal whitespace-flexible matching', async () => {
  const sq = makeSessionQuery({
    records: [record('session-a', CWD_A)],
    eventsById: {
      'session-a': [doc('session-a', 7, 'deploy sk-ABCDEFGHIJ token then foo   bar <b>bold</b>')],
    },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.recall({ agent: agentFor(), query: 'foo bar' })
  const excerpt = result.hits[0].excerpt
  assert.equal(excerpt.includes('sk-ABCDEFGHIJ'), false, 'secret redacted')
  assert.match(excerpt, /\[redacted:secret\]/)
  assert.equal(excerpt.includes('<'), false, '< neutralised for untrusted rendering')
  assert.match(excerpt, /foo bar/, 'whitespace collapsed after matching "foo   bar"')
  assert.ok([...excerpt].length <= 600)
})

test('UT-RECALL-05 literal query semantics: regex metacharacters are data', async () => {
  const sq = makeSessionQuery({
    records: [record('session-a', CWD_A)],
    eventsById: { 'session-a': [doc('session-a', 1, 'pattern a.*b literal and aXXb is not')] },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.recall({ agent: agentFor(), query: 'a.*b' })
  assert.equal(result.hits.length, 1)
  assert.match(result.hits[0].excerpt, /a\.\*b/)
})

test('UT-RECALL-06 excerpt cap and long-text clipping', async () => {
  const long = 'x '.repeat(4000) + 'needle' + ' y'.repeat(4000)
  const sq = makeSessionQuery({
    records: [record('session-a', CWD_B)],
    eventsById: { 'session-a': [doc('session-a', 1, long)] },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.recall({ agent: agentFor(), query: 'needle' })
  assert.ok([...result.hits[0].excerpt].length <= 600)
  assert.match(result.hits[0].excerpt, /needle/)
})

test('UT-RECALL-07 query validation and hit caps', async () => {
  const sq = makeSessionQuery({ records: [] })
  const recall = createRecall({ sessionQuery: sq })
  await assert.rejects(() => recall.recall({ agent: agentFor(), query: 'x' }), (error) => error.code === 'BAD_ARGUMENT')
  await assert.rejects(
    () => recall.recall({ agent: agentFor(), query: 'x'.repeat(201) }),
    (error) => error.code === 'BAD_ARGUMENT',
  )
  const limited = createRecall({ sessionQuery: sq, config: { recall: { maxHits: 2 } } })
  const result = await limited.recall({ agent: agentFor(), query: 'needle', limit: 9 })
  assert.equal(result.hits.length, 0)
})

test('UT-RECALL-08 hits include the source session title', async () => {
  const sq = makeSessionQuery({
    records: [record('session-a', CWD_B)],
    eventsById: { 'session-a': [doc('session-a', 3, 'needle')] },
    titles: { 'session-a': 'Auth branch work' },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.recall({ agent: agentFor(), query: 'needle' })
  assert.equal(result.hits[0].title, 'Auth branch work')
})

// ---------------------------------------------------------------------------
// readRef
// ---------------------------------------------------------------------------

function readWindowEvents() {
  return {
    events: [
      {
        seq: 411,
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'why does the fixture time out?' }] },
      },
      {
        seq: 412,
        type: 'assistant/message',
        data: {
          content: [
            { type: 'text', text: 'Run with TZ=UTC.' },
            { type: 'reasoning', text: 'SECRET_REASONING_TEXT' },
          ],
        },
      },
      {
        seq: 413,
        type: 'tool/result',
        data: { message: { content: [{ type: 'text', text: 'tests passed sk-ABCDEFGHIJ' }] } },
      },
    ],
    startSeq: 411,
    endSeq: 413,
  }
}

test('CON-R7 ref roundtrip: expands a ref from a DIFFERENT cwd, roles mapped, reasoning absent, redacted', async () => {
  const sq = makeSessionQuery({
    records: [record(CALLER_ID, CWD_A), record('session-target', CWD_B)],
    readEventsById: { 'session-target': readWindowEvents() },
    titles: { 'session-target': 'Auth branch work' },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.readRef({ agent: agentFor(CALLER_ID, CWD_A), ref: 'session:session-target:412' })
  assert.equal(result.sessionId, 'session-target')
  assert.equal(result.title, 'Auth branch work')
  assert.equal(result.events.length, 3)
  assert.deepEqual(
    result.events.map((event) => event.role),
    ['user', 'assistant', 'tool-result'],
  )
  assert.equal(result.events[1].text, 'Run with TZ=UTC.', 'reasoning block dropped')
  assert.equal(JSON.stringify(result).includes('SECRET_REASONING_TEXT'), false)
  assert.equal(JSON.stringify(result).includes('sk-ABCDEFGHIJ'), false, 'read window redacted')
  assert.equal(result.truncated, false)
  assert.equal(sq.calls.listSessions, 0, 'authority is session readability, not a workspace lookup')
})

test('CON-R7 readRef authority: malformed, unknown and private targets behave safely', async () => {
  const sq = makeSessionQuery({
    records: [record(CALLER_ID, CWD_A), record('session-private', CWD_B)],
    readEventsById: { 'session-private': readWindowEvents() },
  })
  const recall = createRecall({
    sessionQuery: sq,
    config: { privacy: { privateSessions: ['session-private'] } },
  })
  await assert.rejects(
    () => recall.readRef({ agent: agentFor(), ref: 'not-a-ref' }),
    (error) => error.code === 'INVALID_REF',
  )
  await assert.rejects(
    () => recall.readRef({ agent: agentFor(), ref: 'session:session-private:5' }),
    (error) => error.code === 'NOT_FOUND',
  )
  await assert.rejects(
    () => recall.readRef({ agent: agentFor(), ref: 'session:session-missing:5' }),
    (error) => error.code === 'NOT_FOUND',
  )
  assert.equal(sq.calls.readEvent.length, 1, 'only the missing-target probe reached readEvent; private never did')
})

test('CON-R7 readRef text cap: bounded total, truncated flag; missing window => NOT_FOUND', async () => {
  const big = 'x'.repeat(2000)
  const sq = makeSessionQuery({
    records: [record(CALLER_ID, CWD_A), record('session-big', CWD_B), record('session-empty', CWD_C)],
    readEventsById: {
      'session-big': () => ({
        events: [
          { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: big }] } },
          { seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: big }] } },
          { seq: 3, type: 'tool/result', data: { content: [{ type: 'text', text: big }] } },
        ],
      }),
      'session-empty': () => null,
    },
  })
  const recall = createRecall({ sessionQuery: sq })
  const result = await recall.readRef({ agent: agentFor(), ref: 'session:session-big:2' })
  const total = result.events.reduce((sum, event) => sum + event.text.length, 0)
  assert.ok(total <= 1200 + 3, 'whole render bounded by the 1,200-char cap')
  assert.equal(result.truncated, true)
  await assert.rejects(
    () => recall.readRef({ agent: agentFor(), ref: 'session:session-empty:2' }),
    (error) => error.code === 'NOT_FOUND',
  )
})

test('parseSessionRef grammar and roundRobin helper', () => {
  assert.deepEqual(parseSessionRef('session:session-abc:412'), { sessionId: 'session-abc', seq: 412 })
  assert.equal(parseSessionRef('session::1'), null)
  assert.equal(parseSessionRef('session:abc'), null)
  assert.equal(parseSessionRef('cnf_01JBQZ4K1H9T2R6N4X7C0W8FD'), null)
  const ring = roundRobin(
    [
      { sessionId: 'a', docs: [doc('a', 2, 'two'), doc('a', 1, 'one')] },
      { sessionId: 'b', docs: [doc('b', 1, 'b-one')] },
    ],
    3,
  )
  assert.deepEqual(
    ring.map((item) => `${item.sessionId}:${item.seq}`),
    ['a:1', 'b:1', 'a:2'],
  )
})
