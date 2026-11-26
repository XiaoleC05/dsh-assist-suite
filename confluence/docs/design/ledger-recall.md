# Confluence ledger and recall — metadata awareness and on-demand literal search (v1)

- Status: **design deliverable** (implementation-ready), Round 3.
- Binding upstream: ADR 0001 §4, §6, §9, §11; split-watermark decision in
  [`../adr/0003-pulse-and-watermarks.md`](../adr/0003-pulse-and-watermarks.md); recall caps from ADR §10.
- Companions: [`tool-api.md`](tool-api.md) (tool shells, `confluence_read.ref`), [`pulse.md`](pulse.md)
  (watermarks), `config.md`.
- Target: DSH `0.2.2-rc.1`, profile `desktop`, Windows 11, offline. Read-only over session logs: the
  plugin never writes, edits, or deletes a session log or its files.
- Caps: ledger 8 file hints/session, 200 sessions **per profile** (`ledger.maxSessions`), title 160
  chars; recall 3 sessions / 5 hits / 5,000 ms; excerpts ≤ 600 chars; ref window ≤ 3 events; store
  retention 90 days.

**Evidence convention.** `dsh/...` = installed `app.asar/dsh/...`; `:N` = 1-based line in the installed
bundled file, re-read for this document. Unverified behavior is marked `HYPOTHESIS:`.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md), delta
> §5).** The ledger and presence move into the **global** journal: one row set for the whole profile,
> capped by `ledger.maxSessions` (the old `maxSessionsPerWorkspace` name is mapped with a
> `CONFIG_DEPRECATED` warning), and workspace data becomes an optional
> `origin:{workspaceKey, workspaceLabel}` (basename) we add for display. `live()` returns **all** live
> peers with an optional `workspaceLabel`. Recall loses its workspace filter entirely: it enumerates
> every earlier session in the profile, excludes the caller and `privacy.privateSessions`, and keeps
> the same caps (≤3 sessions, ≤5 hits, 5 s, literal `filterEvents`). `privacy.disabledWorkspaces` no
> longer exists. The caps line and v0.1.0 algorithm below are historical where they say
> "per workspace"/"same workspace".

---

## 1. What the ledger is — and is not

The ledger answers "which sessions were working on this machine, when, on what, and how far did they
get" without storing any conversation content. It is **metadata only, live-first** (ADR §9):

| Stored | Never stored |
|---|---|
| session id, `origin` provenance (`workspaceKey`/`workspaceLabel` basename), redacted title (≤ 160 chars), status (`live`/`idle` at write time), `lastActivityTs` (ISO), turn count, `parentSession`, redaction count | user prompts, assistant text, reasoning, tool output, tool call arguments other than allow-listed path fields, command lines, file contents, environment values |
| `effectiveDir` absolute canonical directory only when it differs from the origin directory (never exported, never in the pulse) | anything read from disk during prompt assembly (the pulse never reads the ledger) |
| ≤ 8 distinct relative paths per session, seen in write/edit-style tool calls ("files seen in tool calls (partial)") | file hints for cold sessions backfilled from logs (no cold backfill in v1) |

Two consequences of DSH reality, both encoded in the wording: shell writes are invisible, and under the
default `ptc` preset nested dispatch is logged as `tool/ptc-dispatch`, so every path hint is phrased
**partial** and no feature may claim "this session changed these files" (research F39; position-b §4).

Ledger rows are journal `session` records (ADR §6): `{ v:1, type:'session', id:<sessionId>, ws:<wsKey>,
seq:<ULID>, ts:<ISO-8601/RFC 3339 string>, …ledger fields }` — the envelope is defined by
[`data-model.md`](data-model.md) §2, and `ts` is a **string**, never a millisecond number. They are
**upserts**: readers merge all shards and keep the record
with the greatest `seq` per `(ws, sessionId)`; a newer row for a session replaces the older one in the
read view, and the journal keeps both until retention. No record is ever rewritten in place.

### 1.1 Record shape (the allow-list is the schema)

The record schema is owned by [`data-model.md`](data-model.md) §4.2; this subsection only fixes what
the capture rules fill in. Every field below is stored exactly as data-model defines it.

```json
{
  "v": 1, "type": "session", "id": "session-af98aac6", "ws": "ws_1f3a9c02b7d4e651",
  "seq": "01J8Z6Q3M5", "ts": "2026-11-13T02:41:07.512Z",
  "title": "Auth branch work",
  "status": "live",
  "turns": 7,
  "lastActivityTs": "2026-11-13T02:40:58.101Z",
  "effectiveDir": "D:\\05_Code\\solo-bench\\src\\auth",
  "files": ["src/auth/token.ts", "tests/auth.spec.ts"],
  "parentSession": null,
  "origin": "user",
  "redactions": 0
}
```

- `id` is the session id and the journal's upsert key; `ws` is the workspace key (`data-model.md` §4.2).
  Only the keys above are emitted; the field allow-list test (§8, L1) scans every emitted record and
  fails on any key outside `{v,type,id,ws,seq,ts,title,status,turns,lastActivityTs,effectiveDir,files,
  parentSession,origin,redactions}`.
- `title` is normalized with the `dsh-session-title` rules (`dsh-session-title/lib/index.js:10-26,52-54`:
  strip OSC/CSI/ESC, controls, bidi/invisible; collapse whitespace) and redacted before storage; capped
  at 160 chars. A later `session/title` event rewrites the row title (last-wins by `seq`); the event seq
  is kept only in memory, not stored.
- `status` is the status at the last flush (`live` while a turn is running, `idle` after `turn/end`).
  `cold` is derived at read time, never stored (`data-model.md` §3). Effective display status: presence
  overlay wins; no fresh presence and `lastActivityTs` older than 30 s ⇒ `cold`.
- `lastActivityTs` is the ISO timestamp of the most recent captured event (`event.time` rendered as
  ISO-8601 UTC); it is refreshed in memory on every captured event and written with the coalesced row.
- `effectiveDir` is the absolute canonical directory from `working-directory/change` /
  `ctx.workingDirectory.get(session)`, recorded only when it differs from the workspace canonical path
  (round-2 R1: "the panel can show the session was started in X"). It is never exported and never
  rendered in the pulse (`data-model.md` §4.2); the row does not repeat the workspace path.
- `parentSession` / `origin` are seeded from `session.header` at first observation; `header.createdAt`
  is used only as the recall-ordering fallback and is not stored (`data-model.md` §4.2 has no field for
  it). `agentPreset` is not stored.
- Values are immutable JSON; readers clone before returning (journal records are plain data; the reader
  must not hand out internal objects).

---

## 2. Capture rules from `session/event`

Subscription (Host event `session/event`, post-commit: `ctx.on('session/event', (session, event) => …)`;
`dsh-agent-loop/lib/index.js:318-325` uses the same shape). Every listener callback is pure bookkeeping
into an in-memory accumulator; disk writes are coalesced (§2.3).

| Event | Data read (exact fields) | Ledger effect |
|---|---|---|
| `turn/end` | `{ turn, reason: { kind } }` (`dsh-agent-loop/lib/index.js:817-825`; `kind ∈ completed/max-tokens/error/aborted/interrupted/blocked`) | `turns = max(turns, turn)`, `lastActivityTs = iso(event.time)`, `status = 'idle'`; schedule flush. |
| `turn/start` | `{ turn }` | `status = 'live'` (memory only, no flush) |
| `tool/call` | `{ turn, step, callId, name, arguments }` (`dsh-tools/lib/pipeline.js:185-195`; `arguments` is the raw model JSON **string**) | Accumulate §2.2 path hints only when `name` is write/edit-style; refresh `lastActivityTs` in memory; no argument text stored. |
| `tool/ptc-dispatch` | `{ rootCallId, parentCallId, subCallId, name, arguments, isError, content }` (`dsh-tool-executor-ptc/lib/index.js:533-543`) | Same extraction by `name`; **`content` is never read** (tool output). `isError` is ignored in v1 (no outcome journaling). |
| `tool/result` | `{ turn, step, message, error? }` (`dsh-tools/lib/pipeline.js:196-213`) | Refresh `lastActivityTs` only; `message.content` is **never read**. |
| `session/title` | `{ title, messageSeqs, source }` (`dsh-session-title/lib/index.js:177,188-198`) | Sanitize + redact + cap → `title` (160 chars); schedule a coalesced flush. |
| `working-directory/change` | `data.directory ?? data.cwd ?? data.path` (`HYPOTHESIS:` exact field; verify in M0) | Recompute `effectiveDir` (absolute canonical) only when it differs from the workspace path; never pulse/export; schedule flush at the next coalesced write. |
| `session/flush` / `session/disposed` | — | Flush accumulator; presence deregister. |
| everything else (`user/message`, `assistant/message`, `assistant/attempt`, `step/*`, `request/*`, `compaction/*`, approvals, jobs, team events) | — | **Ignored.** No text is parsed, even transiently. |

Titles have a second source that is synchronous and needs no log read: `ctx.get('sessionTitle')?.get(session)`
folds the latest `session/title` event from the live log (`dsh-session-title/lib/index.js:282-289`), so a
session that already had a title before the plugin mounted is seeded on first observation. The async
`sessionQuery.readTitle(id)` is only a fallback when the optional `sessionTitle` service is absent; it is
never called on the event path. `header.parentSession`, `header.origin` and `header.createdAt` are read
once from `session.header` at first observation (`dsh-internals.md` §1.1), never from event bodies.

### 2.1 Which sessions are captured

- A session is captured **whether or not** its directory resolves; a missing origin only means no
  provenance label (universal memory, ADR 0007). The origin is resolved best-effort at first observation.
- `privacy.privateSessions` (ADR §10, M2): a suppressed session emits no
  ledger row at all; `ctx.systemPrompt.suppressRuntimeContext()` is also scoped for it (pulse §1).
  `privacy.disabledWorkspaces` no longer exists in v0.2.0.
- Subagent sessions: captured like any other session when they have a header `cwd` (their events are
  real work); readers may choose to hide them in the panel (open question 5).

### 2.2 Path-hint extraction (the only content-shaped data)

```js
const PATH_HINT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'create_file'])
const PATH_KEYS = ['file_path', 'path', 'filePath', 'target_path', 'targetPath', 'files', 'paths']

function pathHints(toolName, rawArguments, wsRoot) {
  if (!PATH_HINT_TOOLS.has(toolName)) return []
  let args = rawArguments
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return [] } }
  if (args === null || typeof args !== 'object') return []
  const out = []
  for (const key of PATH_KEYS) {
    const value = args[key]
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) continue
      const rel = workspaceRelative(wsRoot, candidate)      // lexical resolve, containment check, reject absolute-outside
      if (rel !== undefined && !denied(rel)) out.push(rel)   // denyPathPatterns: **/.env*, **/*.pem
    }
  }
  if (toolName === 'apply_patch' && typeof args.patch === 'string') {
    for (const line of args.patch.split(/\r?\n/)) {
      const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
      if (m) { const rel = workspaceRelative(wsRoot, m[1].trim()); if (rel && !denied(rel)) out.push(rel) }
    }
  }
  return [...new Set(out)]                                   // order preserved; cap applied by the accumulator
}
```

- `workspaceRelative` uses `path.resolve(wsRoot, candidate)`, then lexical containment
  (`resolved === wsRoot || resolved.startsWith(wsRoot + path.sep)`); no `realpath` (no I/O on the event
  path, and symlink escape protection is enforced when the hint is rendered/exported as well). Rejected:
  absolute paths outside the workspace, `..` escapes, UNC/device paths, empty strings.
- `denied(rel)` applies `privacy.denyPathPatterns` (default `**/.env*`, `**/*.pem`) plus a hard-coded
  `.ssh/` deny. Denied paths are dropped, never stored.
- Accumulator keeps the **first 8 distinct** paths in observation order (`ledger.maxFilesPerSession: 8`);
  later paths are dropped silently. This is a hint set, not a file-change record.
- Shell tools (`pwsh`/`bash`/`job_*`), reads, searches, and network tools yield no hints; their argument
  text is never stored (command lines excluded by design).

### 2.3 Coalescing, flush, upsert

- Accumulator per session: `{title, status, turns, lastActivityTs, effectiveDir, files[], parentSession,
  origin, dirtySince}` (in-memory only; the stored row is built from it on flush).
- Flush points: `turn/end` (always), `session/flush`, plugin dispose, and a 10 s max-latency timer while
  dirty. One flush = one journal `session` record (≤ 64 KiB; in practice < 2 KiB). This matches the
  architecture's ≤ 1 append / 5 s / session budget ([`architecture.md`](architecture.md) §5.9).
- Rationale: a long turn with 200 tool calls must not append 200 records; a crash before flush loses only
  the last in-memory update (the board is unaffected — ADR §6 durability policy).
- Upsert on read: merge shards sorted by `seq`, keep last per `id`. Because `seq` is a ULID, a record
  written by another window with a larger `seq` wins deterministically; a torn trailing line is ignored
  and recovered on the next poll (ADR §6).
- A ledger write never blocks a tool call: the flush is queued on the plugin's write chain and any error
  is logged at activation/debug level, never surfaced as a tool error.

### 2.4 Caps

- `ledger.maxSessions: 200`: the in-memory index keeps the 200 most recently active sessions
  **profile-wide**; older rows remain in the journal until `store.retentionDays: 90` and are ignored by
  readers, then pruned by M4 compaction. Per-session data is bounded by the fixed field set and 8 paths.
  (The v0.1.0 name `maxSessionsPerWorkspace` is deprecated and mapped with a warning.)
- `ledger.maxFilesPerSession: 8`; title 160 chars; `effectiveDir` is capped defensively at 1,024 chars
  (never rendered in the pulse, never exported).
- The ledger never grows with prompts or turns beyond the turn counter integer.

---

## 3. Presence heartbeat contract

Presence must never touch the journal (ADR §6: "heartbeat files, never journal ops") because it changes
constantly and would churn the board journal and the watermark fold.

- **File:** `$DSH_HOME/storages/confluence/v1/workspaces/ws_0000000000000000/presence/<writerId>.json`,
  one per plugin mount (writer id = `<pid>-<random>` like the journal shard).
- **Shape ([`data-model.md`](data-model.md) §4.6 is authoritative):** `{ v:1, ws:"ws_0000000000000000",
  writerId, pid, plugin:{name,version}, updatedAt:<ISO>, sessions:[<sessionId>…], sessionsMeta?:
  [{sessionId,title?,workspaceLabel?}] }`, ≤ 32 ids, sorted; **no titles in `sessions`** and no status
  (readers join titles from `session` ledger rows; `sessionsMeta` is display help only). Stale after 30 s.
- **Write cadence:** upsert on `turn/end` and at most once per 10 s while this process has live sessions;
  written atomically (temp + rename). On dispose, rewrite the file without this writer's sessions; if it
  becomes empty, delete it best-effort. A file older than 10 minutes may be deleted by any mount
  (TTL cleanup).
- **Read/merge:** readers list `presence/*.json`, ignore invalid/stale files, and union sessions by
  `sessionId` (newest `updatedAt` wins for a session). A heartbeat older than **30 s** means offline
  (ADR §6). Readers retry once on `EBUSY/EPERM/EACCES`, then treat the file as absent.
- **Consumers:** the pulse reads the merged live set (count + ≤ 2 sorted titles joined from the
  `session` ledger rows, no status words); the panel (M3) may show `running`/`idle`; `confluence_board`
  may include a "Here now" line. The ledger's `status` is never authoritative over presence.
- Presence is **profile-wide** and user-only-suppressible: a private session never appears; every live
  peer of the profile is visible to every other session (with an optional workspace label for display).
  M3 shows origin labels as provenance, never as a filter.

---

## 4. Cold sessions (no backfill)

- A cold session is represented by its **last ledger row**: title, `lastActivityTs`, `turns`, `files`
  (≤ 8), `effectiveDir` when it moved. There is no cold backfill in v1: the plugin does not open a cold
  log to build or enrich the ledger (`ctx.sessionQuery` cold reads replay whole logs — research F2;
  ADR §9).
- Readers derive `status:'cold'` when: the session is not in any fresh presence file, and its
  `lastActivityTs` is older than 30 s. No "last seen 3 h ago" recomputation is stored; the panel may
  compute relative display text at render time (a UI concern, never the pulse).
- Cold rows still count as "known sessions" for `confluence_recall` ranking (a title and last
  activity is enough to order candidates); recall itself re-reads logs only on demand, bounded.
- Deliberate limitation: a session that ran before Confluence was installed has no row; it can still be
  found by recall (which enumerates live+persisted logs) but not by the ledger/pulse.

---

## 5. Recall — on-demand literal search

### 5.1 Contract

`confluence_recall` is explicit, read-only, bounded, timed, and partial. It runs only inside the tool
handler — never in the prompt provider, never on a timer, never automatically (ADR §9). It answers "what
did earlier sessions on this machine actually do/decide", not "what did they write on the board".

### 5.2 Algorithm (step by step)

Inputs: `query` (2–200 chars); `limit` (1–10,
default 5); Config `recall.maxSessions:3`, `recall.maxHits:5`, `recall.timeoutMs:5000`. v0.2.0 has **no
workspace filter**: every earlier session in the profile is a candidate except the caller and private
sessions.

1. **Service check.** `const sq = ctx.get('sessionQuery')`; absent ⇒ `RECALL_UNAVAILABLE`
   (the tool is also hidden by `when` in profiles without the service). A throwing `listSessions` maps to
   the same code with the cause appended.
2. **Enumerate.** `records = await sq.listSessions(signal)` — cheap, complete logical corpus, newest
   first, `SessionRecord = { header, live, persisted, formatStatus? }` (`dsh-session-query/lib/index.js:1067-1074`).
3. **Filter.** For each record: skip if `header.id === caller.id`; skip if the session id is in
   `privacy.privateSessions` (or is otherwise marked private). There is **no directory/workspace
   filter** in v0.2.0 — a session started anywhere on this machine is eligible. (Why not
   `filterSessions({kind:'cwd'})`: it compares the raw `header.cwd` string exactly, and it would
   reintroduce the workspace partition the product removed; research fact 24; round-2 §4.)
4. **Recency order.** Sort candidates by the ledger row's `lastActivityTs` (ISO, parsed; journal merge
   already in memory) when known, else `header.createdAt`, descending; tie-break by session id
   ascending (deterministic). Take `min(recall.maxSessions, 3)`.
5. **Literal scan.** For each chosen session, `filterEvents(sessionId, [{kind:'text', text: query}])`
   (`dsh-session-query/lib/index.js:1152-1161`). The filter is literal, case-insensitive and
   whitespace-flexible; regex metacharacters in the query are escaped, so `.*` matches the literal
   `.*` (`:742-752,786-792`). No FTS (`searchSessions` throws `SESSION_QUERY_SEARCH_DISABLED` in this
   profile), no ranking score. Results are semantic documents
   `{ sessionId, seq, type, time, surface, text }` built for first-party event types (user, assistant,
   tool/call, tool/result, todo, turn/end) (`:545-563,614-630`); reasoning blocks are excluded by
   construction (`:578-585`).
6. **Budget + ring buffer.** A cooperative deadline (`start + timeoutMs`) is checked before each
   session load; completed sessions' hits go into a ring buffer capped at `maxHits`, merged
   round-robin across sessions in session-recency order and ascending `seq` within a session, so one
   long session cannot occupy the whole result. On timeout: keep the ring buffer, set `timed_out:true`,
   `partial:true`; if the ring is empty, raise `RECALL_TIMEOUT`. A per-session failure is
   skipped and sets `partial:true`; it never aborts the call.
7. **Order + cap.** Return ≤ `limit` (default 5, hard cap 10) hits; `sessions_searched` counts completed
   scans, `sessions_matched` counts sessions with ≥ 1 hit.
8. **Render.** Untrusted wrapper (`tool-api.md` §1.1), one block per hit:
   `[session:<id>:<seq> <event type>] "<excerpt>"`, truncated at 600 chars with `…`, followed by
   `Open with confluence_read {"ref":"session:<id>:<seq>"}.` and the audit line (§6). Never render raw
   reasoning, never render a tool result body.

```js
// SKETCH — recall with cooperative timeout and a partial-results ring (v0.2.0: universal, no workspace)
async function recall(agent, query, limit, signal) {
  const sq = ctx.get('sessionQuery'); if (sq === undefined) throw conf('RECALL_UNAVAILABLE', '…')
  const privateIds = new Set(config.privacy.privateSessions)
  const deadline = Date.now() + config.recall.timeoutMs           // tool path may use wall clock
  let records; try { records = await sq.listSessions(signal) } catch (e) {
    throw conf('RECALL_UNAVAILABLE', `session history listing failed: ${e.message}`) }
  const candidates = records
    .filter((r) => r.header.id !== agent.id && !privateIds.has(r.header.id))
    .sort((a, b) => recency(b) - recency(a) || (a.header.id < b.header.id ? -1 : 1))
    .slice(0, config.recall.maxSessions)
  const perSession = []; let searched = 0; let failed = 0; let timedOut = false
  for (const record of candidates) {
    if (Date.now() > deadline) { timedOut = true; break }
    try {
      perSession.push({ id: record.header.id, docs: await sq.filterEvents(record.header.id, [{ kind: 'text', text: query }]) })
      searched += 1
    } catch { failed += 1 }
  }
  const ring = roundRobin(perSession, Math.min(limit, config.recall.maxHits))   // deterministic
  if (ring.length === 0 && timedOut) throw conf('RECALL_TIMEOUT', `no hits within ${config.recall.timeoutMs} ms`)
  return { hits: ring.map((doc) => hit(doc)), sessions_searched: searched,
           sessions_matched: perSession.filter((s) => s.docs.length > 0).length,
           partial: timedOut || failed > 0, timed_out: timedOut }
}
```

**Excerpt extraction.** For each document: build the same literal matcher as the service (`escape regex
metacharacters`, join words with `\s+`, flags `iu`), find the first match offset in `doc.text`, take
`text.slice(max(0, start-300), min(len, end+300))`, collapse `\s+` to spaces, prefix/suffix `…` when
clipped, cap 600 chars, then redact (§5.3). If the document text is shorter, take all of it (still
≤ 600). Excerpts are neutralized for injection (no `<`, `&`; controls stripped) before rendering.

**Timeout honesty.** `filterEvents` does not accept an `AbortSignal` (signature:
`filterEvents(sessionId, filters)` — `dsh-session-query/lib/index.js:1152-1154`), so a single cold-log
load can outlive the deadline; the implementation races the in-flight read against the deadline, keeps
whatever the ring already holds, and attaches a no-op catch to the loser. Worst case latency is
`timeoutMs + one log load`; the result is still bounded and marked partial. This is stated in the tool
description ("bounded, partial") and in README.

### 5.3 Redaction (recall and ledger)

Best-effort, applied before storage (titles/paths do not need it, titles do) and again to every excerpt
and `confluence_read` expansion. Replacement `[redacted:<kind>]`, count kept in memory for the audit line.
Patterns (ordered): `sk-[A-Za-z0-9]{20,}`, `ghp_…`/`github_pat_…`, `xox[baprs]-…`,
`AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`, PEM private-key blocks, `Bearer <token>`,
`Basic <base64>`, `(?i)(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+`, connection strings with
credentials, absolute home paths → `$HOME`. Redaction is labeled as best-effort in docs and UI (ADR §11);
a fully-redacted excerpt is replaced by the marker, not dropped silently.

### 5.4 Provenance ref and `confluence_read` expansion

- **Format:** `session:<sessionId>:<seq>`, e.g. `session:session-af98aac6:412`. Grammar
  `^session:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([0-9]{1,9})$`; `seq` is the JSON integer log position.
- **Expansion algorithm** (`confluence_read` when `ref` matches):
  1. Parse; malformed ⇒ `INVALID_REF`.
  2. **Authorize before reading:** a session id equal to the caller is allowed; otherwise the privacy
     filter runs first — a private/opted-out target behaves as **missing** (`NOT_FOUND`, no content, no
     excerpt) and reveals nothing. There is **no workspace comparison** in v0.2.0: any readable session
     in the profile can be opened (single-user local profile; ADR 0007). The decision is cached per
     `(caller, sessionId)` for 60 s (bounded map, ≤ 128 entries). An unknown session returns
     **`NOT_FOUND`** (the same error as a missing id: no existence oracle).
  3. `window = await sq.readEvent({ sessionId, seq, before: 1, after: 1 })` — bounded window
     `before/after ≤ readWindowMax (default 50)`; returns `{session, target, events, startSeq, endSeq}`
     (`dsh-session-query/lib/index.js:1204-1238`). In v1 the window is at most 3 events (target ± 1).
  4. Extract text per event: `user/message` → text blocks; `assistant/message` → text blocks (reasoning
     dropped); `tool/call` → name + arguments (redacted, capped 300 chars); `tool/result` → text blocks
     (redacted); `turn/end` → the reason kind; structural events → type only. The whole render is
     ≤ 1,200 chars with an explicit `(truncated: +N chars)` marker and `(literal excerpt; partial)`.
  5. Render with the untrusted wrapper and no `through=` marker (session reads advance no watermark).
- Never read more than the one bounded window; never replay a whole log on the prompt path. The tool call
  itself is the audit; the M3 panel reads the same committed tool result for its audit line.

### 5.5 Audit line

Every recall/read-session result ends with one deterministic line, e.g.
`(recall: 3 sessions searched, 2 matched, 5 hits shown; literal match only; partial: false)` or
`(read: session-af98aac6 #412 ±1; literal excerpt; partial)`; it is part of the rendered text and thus
committed with the result (the only v1 audit surface; no journal audit record type exists — ADR §6
reserves `signal`/`watermark` only). `redactions:N` is appended when redaction changed the output.

---

## 6. Degradation matrix

| Condition | Behavior |
|---|---|
| `ctx.sessionQuery` absent | `confluence_recall` and session-ref `confluence_read` are hidden by `when`; if invoked (race), `RECALL_UNAVAILABLE` with "session history is not readable in this profile". Board tools unaffected. |
| `listSessions` throws (persistence failure) | `RECALL_UNAVAILABLE` with cause; no partial (nothing was searched). |
| One session's `filterEvents` throws | Skip it, `partial:true`, continue with the rest; the error goes to the debug log with the session id. |
| Timeout | Partial ring returned with `timed_out:true`; zero hits ⇒ `RECALL_TIMEOUT`. Never throws after returning hits. |
| Huge logs | Per-session load is the cost unit: 3 sessions max; if a load exceeds the deadline it is abandoned (result discarded), and the next session is not started. |
| Unresolvable origin | Valid: the session row is still written, with no `origin` block; nothing to recall is impossible — memory is universal (ADR 0007). |
| Private/opted-out caller | Tools hidden/pulse suppressed; recall never runs for it. |
| Private/opted-out *target* | Target sessions are excluded from enumeration (M2 privacy filter applied before recall), and direct refs to them behave as not-found (same as missing). |
| `readEvent` seq out of range / session vanished | `NOT_FOUND`; no retry. |

Nothing in recall can block the pulse, the board, or a turn: the tool handler is the only entry point and
its deadline is the caller's `AbortSignal` plus `recall.timeoutMs`.

---

## 7. Pseudo-code: ledger capture and flush

```js
// SKETCH — accumulator + coalesced journal append (Host plugin code; v0.2.0 universal)
const acc = new Map()   // sessionId -> { origin, title, status, turns, lastActivityTs, effectiveDir,
                        //                 files:[], parentSession, dirty, timer }

ctx.on('session/event', (session, event) => {
  if (isPrivate(session)) return
  // origin is best-effort provenance, never a gate: { workspaceKey?, workspaceLabel? } | null
  const origin = originOfSession(session)
  const row = acc.get(session.id) ?? seedRow(session, origin)
  switch (event.type) {
    case 'turn/start': row.status = 'live'; break
    case 'turn/end':
      row.turns = Math.max(row.turns, event.data.turn)
      row.lastActivityTs = iso(event.time)
      row.status = 'idle'; row.dirty = true; flushSoon(session, row); break
    case 'tool/call':
      for (const rel of pathHints(event.data.name, event.data.arguments, ws.root)) addHint(row, rel)
      row.lastActivityTs = iso(event.time); row.dirty = true; break
    case 'tool/ptc-dispatch':
      for (const rel of pathHints(event.data.name, event.data.arguments, ws.root)) addHint(row, rel)
      row.lastActivityTs = iso(event.time); row.dirty = true; break
    case 'session/title':
      row.title = cap(redact(normalizeTitle(event.data.title)), 160)
      row.dirty = true; flushSoon(session, row); break
    case 'working-directory/change':
      updateEffectiveDir(row, event.data, ws); row.dirty = true; break
    case 'session/disposed':
      flushNow(session, row); acc.delete(session.id); presence.remove(session.id); break
    default: break                                    // all text-bearing events ignored
  }
  acc.set(session.id, row)
})

function addHint(row, rel) {
  if (row.files.length >= config.ledger.maxFilesPerSession) return
  if (!row.files.includes(rel)) row.files.push(rel)
}
```

Journal append is `appendFile` of one complete JSON line to this writer's shard (ADR §6), with the
`{v,type:'session',id:sessionId,ws,seq:ulid(),ts:iso()}` envelope (the envelope is `data-model.md` §2 —
`ts` is an ISO-8601/RFC 3339 string, never a number); fsync batched ~1 s. Read side merge is
per-shard `*.jsonl`, sort by `seq`, last-wins per `id`, cap 200 sessions in the in-memory index.

---

## 8. Conformance tests

Ledger (L):

| # | Test | Assertion |
|---|---|---|
| L1 | Field allow-list | Capture fixtures for every event type above; every emitted record's keys ⊆ the §1.1 allow-list; no key resembling `prompt/assistant/tool-output/content/message/command`; byte-scan the journal for fixture prompt/assistant/tool-output strings ⇒ absent. |
| L2 | Text never stored | Fixture turns with distinctive user/assistant/tool-output strings; grep the journal bytes ⇒ no match (titles and paths only). |
| L3 | Upsert / last-wins | Two flushes for one session ⇒ two records; reader returns the second only; out-of-order seq ⇒ deterministic winner by ULID. |
| L4 | Path hints | `write`/`edit`/`apply_patch` args → up to 8 distinct workspace-relative paths; absolute-outside, `..` escape, `**/.env*`/`**/*.pem` dropped; shell args produce nothing; duplicates collapse; order preserved. |
| L5 | PTC parity | A `tool/ptc-dispatch` nested `edit` yields the same hints as a `tool/call` `edit`; `content` is never parsed (fixture contains a secret in `content` ⇒ absent from journal). |
| L6 | Caps | 300 sessions ⇒ index caps at 200 most recent; 10 files ⇒ 8 kept; 200-char title ⇒ capped at 160 and redacted. |
| L7 | Presence | Heartbeat upsert/delete; 31 s old ⇒ offline; corrupt file ignored; presence never appends a journal record (event count unchanged). |
| L8 | No backfill | A cold session with a log but no ledger row produces no journal write on activation. |

Recall (R):

| # | Test | Assertion |
|---|---|---|
| R1 | Universal candidate set | Sessions in different directories are all included; a session with no `cwd` is still included (no origin); the caller and private sessions are excluded |
| R2 | Caller excluded | The caller's own session never appears in hits. |
| R3 | Literal semantics | Query `a.*b` matches only literal text; whitespace-flexible and case-insensitive matches succeed; no FTS call is made (service spy). |
| R4 | Caps | 5 candidate sessions ⇒ only 3 loaded; 12 hits ⇒ at most 5 returned, round-robin across sessions, deterministic order. |
| R5 | Timeout | Fake `sessionQuery` with a 2 s-per-load delay and 100 ms timeout ⇒ partial result with `timed_out:true`; zero completed hits ⇒ `RECALL_TIMEOUT`; the slow promise's rejection is contained. |
| R6 | Redaction | Excerpt containing `sk-…`, a PEM block, and `password=…` ⇒ `[redacted:…]` markers; raw secret absent from the rendered result. |
| R7 | Ref roundtrip | A recall hit's `ref` expands via `confluence_read` to the same session/seq; malformed ref ⇒ `INVALID_REF`; other-workspace ref ⇒ `NOT_FOUND` (same as missing); window ≤ 3 events; excerpt ≤ 1,200 chars; reasoning absent. |
| R8 | Degradation | `sessionQuery` absent ⇒ tools hidden; forced call ⇒ `RECALL_UNAVAILABLE`; one-session failure ⇒ `partial:true` with the rest returned. |
| R9 | Audit | Every recall/read-session render ends with the audit line; counts match the fixture; `redactions:N` present iff redaction occurred. |
| R10 | No prompt-path use | Instrument the pulse provider: it never touches `sessionQuery`, the ledger reader, or disk during assembly (spy assertions). |

---

## Open questions

1. **`working-directory/change` payload:** exact field name (`directory` vs `cwd` vs `path`) is
   M0 reads one real event. Until then the reader is tolerant and only records `effectiveDir` when the
   value is an absolute path (data-model.md §4.2); otherwise it is omitted.
2. **`tool/ptc-dispatch` `arguments` fidelity:** `normalized.logged` may already be normalized/truncated
   JSON text; verify that `file_path` survives for `write`/`edit` under `run_code` and whether a
   `tool/ptc-dispatch-start` variant is needed for early hints.
3. **Subagent sessions in recall:** include (v1) or exclude to avoid parent/child duplicates? Add
   `recall.includeSubagents` only after an eval shows the duplication cost.
4. **Recall timeout UX:** `filterEvents` cannot be cancelled; is returning partial after
   `timeoutMs + one log load` acceptable for the slowest real profiles, or should recall cap sessions at
   2 when the ledger reports very large logs (a cost hint we could store)?
5. **Redaction precision:** high-entropy token heuristics risk redacting commit hashes; v1 ships only
   known credential shapes and labels redaction best-effort. A stricter mode belongs to Config.
6. **Audit persistence:** the M3 panel audit line must read committed tool results; if a session log is
   compacted, the audit entry may be shadowed. Is a small journal `audit` record worth a reserved record
   type, or is "the log is the audit" sufficient? (v1: sufficient.)
