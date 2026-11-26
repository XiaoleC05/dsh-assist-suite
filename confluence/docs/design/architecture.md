# Confluence architecture — expanded technical design (v1)

Status: design document for M1–M4, binding within the design set. It expands
[ADR 0001](../adr/0001-confluence-architecture.md) into component contracts, module layout,
dependency rules, lifecycle, data flows and failure containment; it does not re-open the ADR's
decisions. Records are defined in [`data-model.md`](data-model.md), the on-disk contract in
[`store-format.md`](store-format.md), and the storage decision is recorded in
[ADR 0002](../adr/0002-store-format-and-concurrency.md).

Evidence cited as `dsh-internals.md §n` / `fact n` refers to
[`../research/dsh-internals.md`](../research/dsh-internals.md); `practices.md` / `host-plugin.md`
refer to the loaded `cordis-plugin-development` skill references. Unverified claims are marked
`HYPOTHESIS:`.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md)).**
> This document was written for the v0.1.0 workspace-scoped design. From v0.2.0 the **profile is the
> memory boundary**: one global scope `ws_0000000000000000` ("All sessions") replaces per-workspace
> partitions, `WorkspaceResolver` becomes an **origin resolver** used for provenance only, and legacy
> v0.1.0 workspace journals are merged read-only into every view. Where this document says
> "workspace-scoped", "per workspace", "same workspace", or shows `workspaces/<wsKey>/` paths, read the
> single global scope and treat a workspace as `origin:{workspaceKey, workspaceLabel}` metadata. The
> rest of the architecture (three pillars, process model, module boundaries, poll freshness, watermark
> fold, no-egress posture) is unchanged. Binding interface delta:
> [`../plan/scope-refactor-delta.md`](../plan/scope-refactor-delta.md).

> **v0.3 amendment — workspace session bus + global user profile
> ([ADR 0008](../adr/0008-bus-and-profile.md),
> [binding contract](../plan/v0.3-interfaces.md)).** ADR 0008 supersedes the single-global-scope rule of
> ADR 0007: v0.3 restores **two coexisting scopes**. *Workspace* (`ws_<16hex>`, hashed from the frozen
> realpath of `session.header.cwd`) holds module 1 — keyed context (`lib/context.js`), notes
> (`lib/board.js`) and addressed messages (`lib/bus.js`); *global* (`ws_0000000000000000`) holds module 2
> — profile facts (`lib/profile.js`) plus the unchanged metadata-only ledger and presence heartbeats.
> `lib/workspace.js` resolves the workspace key and display label (labels only; absolute paths never
> enter records, prompts or payloads), and `lib/store.js` keeps one merged cache per scope with an LRU
> cap of `store.maxOpenWorkspaces` (16) open journals. Two independent byte-stable prompt contributions
> replace the single v0.2 one: `confluence:profile` (order 1400) and `confluence:pulse` (order 1500,
> workspace digest). The panel becomes two read-only views (workspace bus, user profile). The offline
> posture, append-only store, untrusted-content framing, metadata-only ledger and poll freshness model
> are unchanged. The "three pillars" below remain the component inventory, but their scope assignment
> changes: board/pulse are workspace-scoped (module 1), ledger/recall stay profile-wide, and profile is
> the new global layer (module 2). Where this document describes one global board or one global pulse,
> read the two-module model of the binding contract.

> **v0.4 amendment — three layers, two new modules
> ([ADR 0009](../adr/0009-long-term-memory-persona-style.md),
> [binding contract](../plan/v0.4-interfaces.md)).** ADR 0009 adds two durable global layers beside the
> v0.3 bus: `lib/memory.js` (`MemoryService`: pattern fold, candidate queue,
> `activeFor(workspaceKey)`, one-time migration, bounded render) and `lib/style.js` (`StyleService`:
> two-channel style fold, `set`/`disable`, two bounded renders); `lib/profile.js` becomes the persona
> (six trait sections plus legacy aliases) and `lib/export.js` gains the `confluence.memory/v1`
> document (build/validate/render/import). Both services attach to the **global** journal
> `workspaces/ws_0000000000000000/`, prime their folds from the existing per-scope merged view, perform
> no IO while rendering, and are surfaced through the facade, the tools and the panel. `index.js`
> registers **three** global `systemPrompt.context()` contributions — `confluence:profile` (1400),
> `confluence:memory` (1410), `confluence:style` (1420) — alongside the unchanged workspace pulse
> (1500), and the panel serves three views over seven read-only routes. The bus, store mechanics,
> offline posture, untrusted-content rules, metadata-only ledger and poll freshness model are
> unchanged.

## 1. Architecture at a glance

Three pillars, one plugin mount, no new process, no server, no network, no model call:

1. **Board** — append-only typed notes in per-writer JSONL shards under
   `$DSH_HOME/storages/confluence/v1/`; v0.2.0 writes only the single global scope
   (`workspaces/ws_0000000000000000/`) and merges legacy per-workspace journals read-only.
2. **Pulse** — one global `ctx.systemPrompt.context()` contribution, rendered synchronously from a
   precomputed in-memory view; byte-stable, so the agent loop commits a runtime-context snapshot
   only when the text actually changes (fact 6).
3. **Ledger + recall** — metadata-only ledger from committed `session/event`s, plus the explicit,
   bounded `confluence_recall` read path over `ctx.sessionQuery`.

Ownership rule: the session log is the only source of truth (practices.md:7). The store is a
derived, disposable cache of deliberate shared facts; plugin memory (mirror, pulse view, cursors)
is derived cache too. Nothing the model sees is invented by the plugin: board text comes from other
sessions' deliberate posts; recall text comes from the platform's own session logs.

Process model: DSH Desktop likely runs one Host process per app instance with multiple windows
(`HYPOTHESIS:`, research fact 57); the design is correct in both topologies because correctness
never relies on in-process events between writers — it relies on poll + per-writer shards. Each
plugin mount is one writer (`writerId = <pid>-<8 lowercase hex>`) with its own shard files (ADR 0001 §6).

## 2. Components and owned responsibilities

| Component | Owns | Does not own |
|---|---|---|
| `OriginResolver` | canonical path, basename label, best-effort provenance per session (never a partition) | tool authorization, scoping, path policy inside the workspace |
| `JournalWriter` | own shard append, line encoding, batched fsync, close | merge, tombstones, retention |
| `StoreMirror` | directory scan, shard/snapshot/presence read, merge, poll/watch, change notification | writes, repairs, repairs-after-corruption |
| `RecordCodec` | validation, record builders (pure) | I/O, redaction policy details |
| `BoardService` | entry/reply append semantics, derived threads/status, queries, board render, `through=` marker | recall, pulse formatting |
| `SessionLedger` | `session/event` fold, ledger rows, file hints, presence heartbeat | pulse rendering, recall |
| `WatermarkUnit` | `sessionProjections` host-only unit, cursor parsing/folding | delivering text, store access |
| `PulseProvider` | synchronous byte-stable pulse text from precomputed view + cursors | I/O of any kind, store access, recall |
| `RecallService` | session enumeration, literal search, bounded reads, excerpt render, timeouts | storing results, auto-injection |
| `Tools` | six model-facing tool definitions, error mapping, workspace authority from `exec.agent` | business logic (delegates) |
| `Redactor` | best-effort secret/path redaction, deny patterns | guarantees (labeled best-effort) |
| `HostBridge` (M3) | panel data channel (`host.call` or same-origin route) | write path (writes go through commands/tools) |
| `Panel` (M3) | read-only React page in `sidebar.panellist` + keyed `main` | any write except M4 commands |
| `Exporter` (M4) | lease-guarded deterministic `memories.v1.jsonl` + manifest | reading exports back |

## 3. Component diagram

```text
┌───────────────────────────── DSH Host process (profile desktop) ─────────────────────────────┐
│ index.js — apply(ctx, config): config normalize, wiring, lifecycle, no business logic        │
│                                                                                              │
│  session/event ──► SessionLedger ──► JournalWriter ──────────────► journal.<writerId>.v1.jsonl│
│  agent/created ──► WorkspaceResolver (freeze key)                    │  (append + batched fsync)
│  agent/created ──► WatermarkUnit (sessionProjections)                │                        │
│  tools (6) ──────► BoardService ─────────────────────────────────────┘                        │
│                        ▲                                                                     │
│                        │ queries (in-memory)                                                 │
│  fs.watch + poll ──► StoreMirror (scan/merge shards + presence) ──► PulseView (precomputed)   │
│                        │                                                  │                  │
│                        └──────────────► BoardService / Panel data ◄────────┘                  │
│                                                                          ▼                   │
│                                              ctx.systemPrompt.context (pure, synchronous)    │
└───────────────────────────────┬───────────────────────────────┬──────────────────────────────┘
                                │ files                         │ M3 host bridge / slots
                                ▼                               ▼
      $DSH_HOME/storages/confluence/v1/                  client.js (plain browser module)
        workspaces/ws_0000000000000000/journal.*.v1.jsonl  read-only panel: global board,
        workspaces/ws_0000000000000000/presence/*.json     search, presence, mark-read
        (legacy workspaces/ws_<16hex>/ merged read-only)   poll host 5 s while visible
```

## 4. Module and file layout

Package root is the eventual repository `dsh-confluence` (ADR 0001 §13). Plain ESM, no build step.

```text
index.js                 # apply(ctx, config): wiring + lifecycle only (host-plugin.md:61)
lib/
  runtime.js             # dependency bundle creation (fs, clock, random, logger, env) — no logic
  config.js              # DEFAULTS, normalizeConfig(raw) — pure, defensive
  constants.js           # caps/enums/regex from data-model §6 and store-format §3
  ids.js                 # ULID factory (monotonic per writer), ids, writerId, wsKey
  records.js             # record builders + validateRecord (pure); field allow-list constants
  workspace.js           # canonicalizePath, makeWsKey, createResolver
  journal.js             # encodeLine/decodeLines (pure), createJournalWriter (sync append/fsync)
  store.js               # createStore, WorkspaceMirror, foldRecords/parseLines (pure core)
  board.js               # createBoard, deriveIndex/entryStatus/threadOf/selectHeadlines (pure core)
  ledger.js              # createLedger, extractFileHints/nextLedgerRow (pure core)
  pulse.js               # buildPulseView, renderPulse (pure/sync)
  watermark.js           # cursor parsers (pure) + createWatermarkUnit (projection definition)
  recall.js              # createRecall, excerptAround/rankSessions (pure core)
  redact.js              # redactText, isDeniedPath, toWorkspaceRelative
  log.js                 # rate-limited debug logger; must never throw
  host.js                # (M3) registerHostBridge: host.call methods or same-origin route
client.js                # (M3) single browser module: slots, locale, theme tokens, fetch/host.call
locale/en.json, locale/zh.json, icon.svg, cordis.patch.yml, package.json
```

Rules: `index.js` may import `lib/*`; `lib/*` never imports `index.js`; no import cycles; the
pulse/watermark/record modules import no I/O-capable module (`journal.js`, `store.js`, `recall.js`,
`ledger.js`, `host.js`) at all (enforced by review + the purity test in store-format §17.33).
`client.js` imports nothing from `lib/` (server code) and no Harness client packages
(practices.md:35; host-plugin.md:61).

## 5. Public module contracts

Signatures are design-level (JSDoc-style); the exact argument shapes are pinned by the
implementation and by `docs/design/tool-api.md` / `docs/design/config.md`. `deps` is the injected
environment from `lib/runtime.js`: `{ fs, fsPromises, clock, random, logger, env, pid }`. Every
module that touches the outside world takes `deps` explicitly — that is the test seam.

### 5.1 `lib/runtime.js`

```js
createRuntime(overrides = {}) -> deps   // real fs/clock/random/logger; tests pass fakes
```
Invariant: no module captures `process.env`/`Date.now`/`crypto` directly; all go through `deps`.

### 5.2 `lib/config.js`

```js
DEFAULTS: Readonly<Config>                       // ADR 0001 §10 shape; [`config.md`](config.md) owns defaults/ranges
normalizeConfig(raw) -> { config: Config, warnings: string[] }   // pure; bad values fall back
```
Invariants: pure and total; never throws; every field defaulted; unknown keys ignored with a warning;
`export.dir` validated later against the workspace path (needs I/O).

### 5.3 `lib/ids.js`

```js
createIds({ clock, random }) -> {
  ulid(): string,                         // 26-char Crockford base32, strictly monotonic per writer
  entryId(): string,                      // "cnf_" + ULID (solo-bench export id format)
  tombstoneId(): string,                  // "tmb_" + ULID
  makeWriterId(): string,                 // <pid>-<8 lowercase hex> (pid passed in)
  wsKey(canonicalPath): string            // "ws_" + sha256(lowercased/utf8).slice(0,16)
}
```
Invariants: given the same injected clock/random, deterministic; monotonic per instance; no I/O.

### 5.4 `lib/workspace.js`

```js
canonicalizePath(raw, { fsImpl }) -> Promise<string>       // fs.realpath + win32 lowercase
makeWsKey(canonicalPath) -> string                          // pure
createResolver({ deps, workingDirectory, workspaceRegistry, logger }) -> {
  ensure(session): Promise<string | undefined>,             // first call freezes; later calls cached
  keyFor(sessionId): string | undefined,                    // synchronous, no I/O (pulse/tools fast path)
  pathFor(wsKey): string | undefined,                       // frozen canonical path map
  labelFor(wsKey): string | undefined,                      // registry title or basename (may be async warm)
  isPrivate(sessionId): boolean,                            // from privacy config / user opt-out set
  dispose(): void
}
```
Invariants: `ensure` is idempotent and freezes on first success; failure (no cwd, realpath error) is
cached as `undefined` for the session lifetime; `keyFor` performs no I/O and returns `undefined` for
unknown sessions (callers then take the "no workspace" path); a second different canonical path for
an already-frozen `wsKey` is a collision and is reported as `E_WS_COLLISION` (never a silent merge).
Effective directory is recorded only as ledger metadata (ADR 0001 R1).

### 5.5 `lib/journal.js`

```js
encodeLine(record) -> string                     // JSON + "\n"; throws E_LINE_TOO_LARGE
decodeLines(buffer) -> { records: Record[], consumedBytes: number, tailBytes: number }
createJournalWriter({ storeRoot, wsKey, writerId, deps }) -> {
  append(record): { seq: string },               // validates size, one writeSync to its own shard
  flush(force = false): void,                    // dirty -> fsyncSync (always when force)
  close(): void,                                 // flush(true) + closeSync; idempotent
  lastError(): Error | undefined
}
```
Invariants: one writer per shard; append is synchronous and either writes the whole line or throws
(`E_STORE_WRITE`); never writes a failed or over-cap record; `flush(true)` before a board tool
returns success; `close` is idempotent and refuses further appends (`E_DISPOSED`); the writer never
touches another writer's shard or any non-shard file.

### 5.6 `lib/store.js`

```js
parseLines(buffer, fromByte, limits) -> { records, consumedBytes, tailBytes, invalid }   // pure
foldRecords(validRecords) -> StoreView          // pure: sort by seq, first-wins entry, last-wins session
createStore({ storeRoot, deps, config }) -> {
  mirrorFor(wsKey): WorkspaceMirror,
  registerPresenceReader(wsKey) -> PresenceView,
  release(wsKey): void,                          // stop watching/polling
  onChange(fn): () => void,                      // (wsKey) => void, change feed for pulse snapshots
  close(): void
}
WorkspaceMirror = {
  refresh({ force = false }): Promise<boolean>,  // true iff the effective view changed
  view(): StoreView,                             // { entries, sessions, tombstones, headSeq, counts }
  presence(): PresenceView,                      // live session ids of peers + writer ids
  diagnostics(): { invalidLines, invalidFiles, unsupported, shardCount, generation }
  dispose(): Promise<void>
}
```
Invariants: `refresh` never throws (skips/retries per store-format §9.1, §16); the view is a pure
function of valid lines; a missing/corrupt manifest or snapshot cannot fail a refresh; change fires
at most once per refresh and only when `viewToken` changed; no store writes on any read path.

### 5.7 `lib/records.js`

```js
validateRecord(record, { wsKey, config }) -> { ok: true } | { ok: false, code, message }  // pure
buildEntry(input, { wsKey, ids, clock, config, redact }) -> entryRecord                    // pure
buildSessionRow(input, env) -> sessionRecord                                               // pure
buildTombstone(input, env) -> tombstoneRecord                                              // pure
FIELD_ALLOWLIST: Record<type, readonly string[]>       // data-model §8.3
```
Invariants: builders only construct (no I/O); validation enforces every cap and cross-reference
rule from data-model §8.1; a record is either fully valid or has a stable error code; builders never
truncate silently.

### 5.8 `lib/board.js`

```js
createBoard({ mirrors, journalFor, resolver, ids, deps, config }) -> {
  post(args, caller): Promise<{ id, seq, warnings }>,      // caller = {sessionId, wsKey, title}
  reply(args, caller): Promise<{ id, seq, warnings }>,     // body + replyTo + resolves?
  read(ref, caller): Promise<ReadResult>,                  // board id or session:<id>:<seq>
  search(query, caller): Promise<SearchResult>,
  board(args, caller): Promise<BoardView>,                 // unread/open/peers/recent
  viewFor(wsKey): StoreView                                // synchronous, for panel/pulse
}
deriveIndex(records) -> Index                    // pure
entryStatus(entry, index) -> 'active'|'open'|'resolved'|'superseded'|'deleted'   // pure
threadOf(rootId, index) -> { root, replies }     // pure, capped at MAX_THREAD_RENDER
selectHeadlines(view, cursors, config) -> Headline[]                              // pure
withThroughMarker(rendered, cursorSeq) -> string // appends "\nthrough=<seq>" line
```
Invariants: workspace comes from `caller` (resolver), never from tool arguments; every read filters
by `wsKey` first and applies tombstones/retention after; append validates target existence before
writing; the `through=` marker is the max visible `seq` rendered, not the store head; a board read
never includes another workspace even through an id.

### 5.9 `lib/ledger.js`

```js
createLedger({ deps, resolver, journalFor, mirrors, config, sessionQuery }) -> {
  onSessionEvent(session, event): void,          // emit-mode listener body (must be cheap & sync)
  onAgentCreated(agent): void,
  onAgentDisposed(agent): void,
  tick(): void,                                  // 5 s flush + 10 s heartbeat driver
  dispose(): void
}
extractFileHints(toolName, argsJson, cwd, config) -> string[]   // pure; write/edit-style tools only
nextLedgerRow(prev, event, ctx) -> sessionRecord | undefined     // pure fold per event kind
```
Subscribed event kinds: `turn/end` (turn count/status), `tool/call` and `tool/ptc-dispatch`
(file hints; under the `ptc` preset nested dispatch is log-only — ADR 0001 §9, round-2 §2.7,
research fact 39), and title lookup through `sessionQuery.readTitle` (fact 26). Invariants: the listener never throws and never awaits on the event path; it updates
in-memory rows only; flushes are coalesced (≤1 append/5 s/session); private sessions produce no rows;
hints are workspace-relative, deny-pattern-checked, capped at 8, and always labeled partial.

### 5.10 `lib/watermark.js`

```js
createWatermarkUnit({}) -> ProjectionDefinition {
  key: 'confluence_watermark', stateVersion: 1,
  stateSchema: { parse(v) { ... } },            // zod-like parse-only object (research fact 34)
  init(header, inheritedEventCount) -> { digestSeq: null, boardReadSeq: null },
  apply(state, event) -> state                  // pure; same reference when unchanged
}
parseDigestCursor(text) -> string | null        // seq="<ULID>" header attribute (pure)
parseThroughMarker(text) -> string | null       // "\nthrough=<ULID>" line (pure)
```
Invariants: `apply` is pure/synchronous and returns the same reference for ignored events
(practices.md:26). `digestSeq` folds only from a committed `user/message` with
`source.kind === 'runtime-context'`: prefer the named section `source.sections[].name ===
'confluence:pulse'` (forge-resistant); fall back to an anchored header match on the whole text. It
folds only when that snapshot is *committed* (ADR 0003 §4 — the loop appends, not replaces).
`boardReadSeq` folds from committed `tool/result` **and** `tool/ptc-dispatch` results whose call name
was `confluence_board`/`confluence_read` (tracked through a bounded `callId → name` map) and whose
last text block ends with the marker line. Both cursors are `null` until first folded, `"0"` for the
delivered empty-board welcome, and 26-char ULIDs otherwise; comparisons are lexicographic and
max-monotonic. Garbage markers keep the previous value; the unit never writes files, never calls the
store, and never inspects the provider (full spec: [`pulse.md`](pulse.md) §8).

### 5.11 `lib/pulse.js`

```js
buildPulseView(storeView, presence, config, now) -> PulseView   // precomputed off the prompt path
renderPulse({ agent, view, cursors, config }) -> string          // PURE, synchronous, no I/O
renderWelcome({ agent, view, config }) -> string                 // PURE, synchronous, no I/O
```
`PulseView` mirrors the shape frozen in [`pulse.md`](pulse.md) §2: workspace `{key,label}`, `headSeq`
(newest visible seq, `''` when empty), active-note count, open question/handoff counts, `unread`
(entries with `seq > boardReadSeq`, newest first, ≤8 precomputed with kind/title/authorTitle/stale),
`openItems` (≤8 oldest-first), peers `{count, titles}`, and a `digest` of the inputs used for change
detection. It contains no times and no status words. Invariants: output depends only on
`view` + `cursors` + config; byte-stable (no wall clock, ages, status words, file hints, or
map-iteration order); deterministic peer/headline ordering; escaped `<`, `&`, U+2028/2029; `''` when
nothing new and no peers; ≤ `PULSE_MAX_CHARS` (1 400).

### 5.12 `lib/recall.js`

```js
createRecall({ sessionQuery, resolver, deps, config }) -> {
  recall({ query, limit }, caller): Promise<RecallResult>,
  readRef(ref, caller): Promise<ReadResult>       // ref = "session:<id>:<seq>"
}
rankSessions(records, wsKey, callerId, max) -> SessionRecord[]     // pure
excerptAround(text, query, maxChars) -> string                     // pure
```
Invariants: optional service — if `sessionQuery` is absent the tool returns a clear error (ADR 0001
§9); enumeration uses `listSessions()` + code-side canonicalization filter (not the raw-string
`cwd` filter — dsh-internals §4.1 correction); caller session excluded; caps 3 sessions/5 hits; a
cooperative deadline (`recall.timeoutMs`, checked between sessions/hits and passed as a signal only
to methods that accept one — `filterEvents` takes no signal); every hit carries
`session:<id>:<seq>` provenance; output is redacted, untrusted-framed, marked "literal match, partial
coverage"; no writes; never called from the pulse provider.

### 5.13 `lib/redact.js`, `lib/log.js`

```js
redactText(text, config) -> { text, count }      // pure; best-effort, labeled
isDeniedPath(relPath, patterns) -> boolean       // pure
toWorkspaceRelative(absPath, wsPath) -> string | undefined   // pure; undefined => drop hint
createLogger({ deps, config }) -> { debug, info, warn, error, once(key, msg) }   // never throws
```

### 5.14 `lib/host.js` (M3) and `client.js` (M3)

```js
registerHostBridge({ ctx, board, config, deps }) -> { dispose(): void }
```
One Host method surface (`overview`, `entry`, `search`, `markRead`, `setOptOut`) exposed through
`host.call(method, args)` when the client bridge is confirmed, else a same-origin route registered
on the optional `webServer` service (both local-only, no port — ADR 0001 §12, round-2 R4). The
bridge is read-only in v1 plus mark-read/opt-out; M4 user writes go through
`ctx.remote.commands.execute('/confluence …')` and reuse `BoardService`, never a second write path.
`client.js` registers `sidebar.panellist` + keyed `main`, polls the bridge 5 s while visible, uses
only `--dsw-alias-*` tokens and `ctx.locale`; no iframe, no DOM outside the component.

## 6. Dependency rules

- Host code: plain ESM, Node builtins only (`node:fs`, `node:path`, `node:crypto`, `node:os`,
  `node:process`). No hard `import` of any `@deepseek-ai/*` package (ADR 0001 §4). The only allowed
  external import is a **guarded dynamic** `await import('@deepseek-ai/dsh-atomic-write')` used as
  an optional accelerator for compaction/export; failure falls back to the native lease
  (`HYPOTHESIS:` the import resolves from a profile-installed bundle — research fact 33; not on the
  critical path).
- Forbidden in the production bundle: `node:http`/`node:https`/`node:net`/`node:dgram`/`node:tls`/
  `node:http2`, `fetch`/`WebSocket`, `node:child_process`, `node:worker_threads`, any model call.
  `node:crypto` is used for hashing/ids only. The no-egress static test (store-format §17.32)
  enforces this.
- Client half: one plain browser module loaded via `window.__ModuleLoader__.load({id, factory})`
  (Crisp precedent, dsh-internals §6); React comes from the loader (`require('react')`); no Harness
  client package imports (practices.md:35); theme tokens only; locale via `ctx.locale`.
- Data dependency direction: `index.js → lib/*`; `lib/pulse.js` and `lib/watermark.js` import only
  pure helpers (`redact`, `constants`, `records` types); nothing in `lib/` reads `process.env`
  directly (`deps.env` only).

## 7. Activation: initialization order

`apply(ctx, config)` runs inside the plugin's effect scope; each numbered step registers its own
cleanup. If an optional service is absent the plugin still activates in its degraded mode.

1. **Normalize config** (`normalizeConfig`) → `{config, warnings}`; record warnings for the
   activation summary. Never throw on bad user config (ADR 0001 §10).
2. **Create runtime deps** (`createRuntime`) and the logger (`debug.logFile` optional).
3. **Resolve the store root**: `$DSH_HOME` from `deps.env` → `homedir()/.dsh`; apply
   `config.store.dir`; probe writability/readability lazily (no write at activation beyond
   `mkdir -p` best-effort). Failure → degraded mode flag, warning, continue.
4. **Mint `writerId`** and `JournalWriter` factory (one writer, lazily opened for the global scope).
5. **Register the watermark projection unit** and keep its handle:
   `handle = await ctx.sessionProjections.register(createWatermarkUnit())` — the host-only
   registration form (`cordis_inspect_query` Service `sessionProjections`): checkpointed, not
   client-visible, requires a `stateSchema`. Registration is awaited before the pulse provider is
   published (Service docs: "await registration before publishing consumers"). If
   `sessionProjections` is absent → in-memory per-session cursor map on the same `session/event`
   listener (degraded, documented).
6. **Create the store/mirror manager** and change feed; load nothing eagerly (workspaces are lazy).
7. **Create BoardService, SessionLedger, RecallService** (all take deps; no I/O yet).
8. **Subscribe events**: `ctx.on('session/event', ledger.onSessionEvent)`,
   `ctx.on('agent/created', …)` (resolve the workspace key eagerly, awaited by DSH; keep the promise
   cache), `ctx.on('agent/disposed', …)`, `ctx.on('session/created', …)` if a title prefetch is
   wanted. Listeners are cheap and never throw; `agent/created` is `serial` — do only the realpath
   resolution there, never `whenIdle()`/disposal waits (dsh-internals §2.2).
9. **Register the pulse context** (global, once) — see §10. It is safe to register before mirrors
   are warm: it returns `''` when its workspace view is not ready yet.
10. **Register the six tools** with `options.when` requiring a known workspace key
    (`keyFor(agent.id) !== undefined`) so a session with no resolvable key gets no Confluence tools
    (ADR 0001 §5); all tools resolve the workspace from `exec.agent`, never from arguments.
11. **Start maintenance timers** inside one `ctx.effect`: poll/watch drivers are started lazily per
    active workspace by the ledger on first session event; the 1 s fsync flusher, 5 s ledger flush
    and 10 s heartbeat driver are single intervals cleared on dispose.
12. **M3 only**: register the host bridge / route; the client half is loaded by the loader when a
    page runs.
13. **Report activation summary** (mode, store root, warnings) through the logger and, if
    available, an activation warning list. No user-visible UI at activation.

If step 5 fails hard (projection API shape mismatch), the plugin continues with the in-memory
watermark fallback; if step 7 cannot build a store (read-only root), the plugin runs read-only
(tools `post`/`reply` return `E_STORE_WRITE`, board reads/pulse still work from memory). Failing
activation entirely is reserved for "no `tools`/`systemPrompt` service", which the declared hard
`inject` already prevents.

## 8. Deactivation and reload lifecycle

`ctx.effect` rules (practices.md:8,19,29; host-plugin.md:64):

| Resource | Ownership | Cleanup |
|---|---|---|
| Tool registrations, prompt context, `ctx.on` listeners | plugin `ctx` | automatic when the fiber disposes; nothing to do |
| `sessionProjections` handle | plugin `ctx` | `handle.dispose()` (release reference) in the effect |
| Interval timers (fsync/flush/heartbeat/poll/watch/debounce) | plugin `ctx` | `clearInterval`/`clearTimeout` + `watcher.close()` in the effect |
| Per-agent registrations/opt-out suppressor | `agent.ctx` **and** plugin map | `agent.ctx.effect(...)` disposer kept in a `Map`, invoked by the plugin effect too (double ownership) |
| Journal fd | plugin `ctx` | `writer.close()` = `flush(true)` + `closeSync`; synchronous, idempotent |
| Presence file | plugin `ctx` | `unlinkSync` best-effort; a leftover is stale after 30 s and TTL-cleaned after 10 min |
| Snapshot/mirror memory | plugin `ctx` | drop references; no writes |
| Host bridge (M3) | plugin `ctx` | `dispose()` returned by the registration |

Ordering on dispose (LIFO of effects is the framework's job; the plugin's own single effect does):

1. set `state = 'disposed'` (pulse provider returns `''`, tools fail with `E_DISPOSED`);
2. stop timers and the watcher;
3. drop the pulse view reference;
4. flush + fsync dirty ledger rows and the local shard, then `close()` the fd (bounded: skip rows on
   write failure, never throw out of cleanup);
5. remove own presence file;
6. dispose the projection handle (fire-and-forget with a logged catch);
7. clear caches/maps.

Rules: cleanup never throws and never logs at error level for expected conditions; an in-flight tool
call that finishes after dispose gets `E_DISPOSED` (no writes); a cleanup longer than ~1 s is
logged but not awaited; the framework may not await async cleanup, so cleanup is synchronous or
fire-and-forget (`HYPOTHESIS:` disposer await semantics — design assumes they are not awaited).

Reload: unload disposes as above; the reloaded instance mints a new `writerId` (new shard, new
presence file), reloads the mirrors, re-registers the projection unit (it refolds cursors from the
session log — no duplicate pulse, because the rendered text is identical and the loop dedupes
identical snapshots, fact 6). The old shard remains readable and is pruned only by M4 compaction.

## 9. Data flows

### 9.1 Session event → ledger

```text
session/event (emit, post-commit; signature verified via inspect:
  (session, event: SessionEvent) => void, dsh-internals §2.1)
  └─ ledger.onSessionEvent (synchronous, cheap, never throws)
       ├─ resolve wsKey from the resolver cache (no I/O; unresolved ⇒ drop the event)
       ├─ switch event.type:
       │    turn/end        → turns = data.turn, status = 'idle', lastActivityTs = event.time
       │    turn/start      → status = 'live' (memory only, no flush)
       │    tool/call       → collect write/edit-style paths from data.name + data.arguments (JSON)
       │    tool/ptc-dispatch → same, for nested PTC dispatch (ptc preset is the default)
       │    session/title   → sanitize + redact title (titleSeq kept in memory only)
       │    working-directory/change → moved/effectiveDir relative metadata
       │    session/flush|session/disposed → flush now / presence deregister
       │    user/message, assistant/message, tool/result, step/*, request/* → ignored (no text)
       └─ mark the session row dirty; flush coalesced by the 5 s ticker / turn end
  └─ JournalWriter.append(session record)  (last-wins per session id; no prompts, no outputs)
```

### 9.2 Tool → board → journal

```text
confluence_post / confluence_reply (execute)
  ├─ workspace from exec.agent (resolver.ensure) — never from arguments
  ├─ BoardService validates (records.validateRecord: caps, refs, resolves rules, redaction)
  ├─ build entry record (ids + clock), append via this process's JournalWriter
  ├─ flush(true) before returning success (board posts are rare; durable before "recorded")
  ├─ apply the record to the local mirror immediately (own append is known-good)
  └─ render result text: confirmation + "\nthrough=<max visible seq>" marker
```

### 9.3 Journal → poll → in-memory snapshot → pulse provider

```text
other writers' append  ──►  fs.watch event (debounced 400 ms)  or  POLL_MS tick
  └─ StoreMirror.refresh(): stat/read changed shards, fold, recompute viewToken
       └─ if viewToken changed:
            ├─ buildPulseView(mirror.view, presence, config, now)   // precomputed, sanitized
            ├─ store in PulseSnapshot keyed by wsKey
            └─ fire onChange(wsKey)
  next systemPrompt.assemble()
    └─ pulse.text(assembleCtx) = renderPulse(view, cursors)        // pure, sync, no I/O
         └─ if text differs from the last committed runtime-context snapshot
              the loop APPENDS one new snapshot; else zero tokens, zero messages
```

**Append-not-replace (ADR 0001 §17 E1; supersedes the first §8 wording).** Verified in the installed
loop (`dsh-agent-loop/lib/index.js:859-866`) and session surface assembly
(`dsh-session/lib/index.js:1681-1696`): a changed pulse is a new appended user-role
`runtime-context` message; earlier snapshots stay in request history until compaction, so they are
not shadowed or collapsed. Design consequences: pulse changes must be **infrequent and coalesced**
(one commit per real state change, no wall-clock/status churn — §10), the 1 400-char cap and the
measured token budget are strict, and M0 measures snapshot count vs session length; the documented
fallback if accumulation is material is a near-static pulse (ADR 0003 §4 / pulse.md §4.3).

### 9.4 Committed log → projection watermark

```text
committed session events ──► sessionProjections drive (eager, per registered unit)
  └─ confluence_watermark.apply(state, event)  (pure, same reference when unchanged)
       ├─ user/message with source.kind === 'runtime-context', committed snapshot
       │     named section "confluence:pulse" header seq="<ULID>" → digestSeq = max(digestSeq, seq)
       └─ tool/result OR tool/ptc-dispatch for confluence_board/confluence_read
             last text block line "through=<ULID>" → boardReadSeq = max(boardReadSeq, marker)
  consumer: handle.stateOf(session) → { digestSeq, boardReadSeq }   (synchronous retained read)
  resume/fork inherit the state through the copied log prefix; a fork keeps the parent's cursors.
  unread / pulse "New:" = visible entries with seq > boardReadSeq; digestSeq only gates the welcome.
```

The provider never advances a cursor: it only reads the state. Advancement happens when the loop
commits the message (digest) or when the tool result is committed (board read) — the two events that
mean the model actually saw the content. This is the fix for the "unread forever" failure recorded in
round-2 §2.2. Garbage parsing keeps the previous value: worst case one duplicated headline, never a
lost note.

### 9.5 Cross-window and heartbeat paths

- Presence: `turn/end` → `ledger.heartbeat()` → atomic replace of
  `presence/<writerId>.json`; the 10 s ticker repeats it while this process has live sessions.
- Another window's heartbeat/posts are noticed by the same poll/watch refresh; the presence view is
  recomputed on every refresh and only triggers a pulse change if the rendered text would differ
  (peer count/titles in the view). Presence changes never append journal lines (ADR 0001 §6).

## 10. Purity and synchronicity: the pulse provider contract

Registered once at activation (ADR 0001 §8):

```js
ctx.systemPrompt.context({
  name: 'confluence:pulse',
  order: 1500,                // ADR 0001 §8; final collision check in M0 against live registrations
  required: false,            // user-suppressible (suppressRuntimeContext)
  interpolate: false,         // board text may contain {{ }} and JSON braces
  text: (assembleCtx) => deps.pulse.textFor(assembleCtx.agent),   // synchronous, pure
})
```

Hard rules (M1 acceptance):

1. **Synchronous.** Never returns a Promise; the prompt pipeline serializes only strings (fact 4).
2. **Side-effect free.** No fs, no store access, no logging side effects, no projection registration,
   no timers, no randomness, no `Date.now()` (time is used in the off-provider view builder only).
3. **No I/O.** It may call `watermarkHandle.stateOf(session)` — a synchronous retained read of the
   projection cache (inspect: `ProjectionHandle.stateOf(session): S`); on the first touch the cache
   folds the in-memory log tail, which is CPU, not I/O. It never calls `ctx.sessionQuery`,
   `ctx.agents`, or the store.
4. **Total.** Never throws: every branch is guarded; unknown agent/session/origin, disabled pulse,
   private session, unready view → `''`.
5. **Byte-stable and bounded.** Text is a pure function of the precomputed view + cursors; identical
   inputs render identical bytes; ≤1 400 chars; target 200–320 tokens measured in M1 (ADR 0001 §8).
   No wall-clock times, ages, running/idle words, file hints, or per-assembly recomputation of
   anything expensive.
6. **Escaping.** `<`, `&`, U+2028 and U+2029 in any interpolated text become `\uXXXX`; note text can
   never close or forge the `<confluence-memory …>` wrapper (v0.1.0 snapshots used
   `<confluence-workspace …>`, still parsed for compatibility).
7. **Welcome digest.** `digestSeq === null` (no pulse was ever committed for this session) → one
   bounded welcome view: ≤3 newest unread entries, every open question/handoff capped to 2+2 titles,
   counts, peers, guide; the header cursor is the rendered head (or `seq="0"` on an empty board), so
   a fresh session gets value on install day without a backlog flood. After the loop commits, the
   projection folds `digestSeq` and the next render is the steady block; a fork inherits the parent's
   snapshot and is not re-welcomed (ADR 0003 §3, [`pulse.md`](pulse.md) §7).
8. **No wake, no injection.** No `agent.inject`, `followup`, `steer`, timers that wake agents, or
   deferred contexts on the pulse path (ADR 0001 §8 "Never").
9. **Suppression.** A user `suppressRuntimeContext()` (global opt-out) or a scoped one for a private
   session removes the pulse without plugin code — the plugin must not depend on always being shown
   (round-2 §4 correction).

## 11. Sequence flows (text)

### F1. First session, empty profile (v0.2.0: no workspace needed)

1. DSH creates a session with `header.cwd`; `agent/created` fires (serial). The **origin resolver**
   runs `fs.realpath` + case-fold for provenance (`origin:{workspaceKey, workspaceLabel}`),
   best-effort: failure leaves `origin` absent and never blocks memory. The memory scope itself is
   the constant global scope.
2. Store setup is lazy: nothing exists on disk yet. The mirror for the global scope starts empty
   (welcome state: `digestSeq = null`).
3. Pulse renders `''` because there are no entries, no open items, and no peers — zero tokens.
4. The agent calls `confluence_post`; the board validates, appends
   `journal.<writerId>.v1.jsonl` under `workspaces/ws_0000000000000000/` (creating dirs, manifest at
   first mount), `fsync`s, and returns `Published <id> [kind] in shared memory (seq <ULID>)` plus
   `through=` line. Its own entry is excluded from its own unread count.
5. On the next step the pulse renders the welcome digest (1 newest entry, counts) with
   `seq="<head ULID>"`; the loop commits the runtime-context snapshot; the projection folds
   `digestSeq = head`. Step 6 sees the identical text → zero new tokens.
6. Turn end writes a ledger row and a presence heartbeat.

### F2. Second session in another directory sees the same memory

1. `agent/created` → the origin resolver canonicalizes its `header.cwd` (a different directory is
   fine); the global mirror is shared, so no per-directory lookup is involved.
2. The second session's pulse at its first step is a welcome digest (its own `digestSeq = null`)
   containing F1's note and the open items; it commits `digestSeq = head` and stops repeating.
3. Its presence heartbeat appears in the global store; within one poll the first session's pulse
   changes peer count → one new snapshot.
4. Both sessions keep distinct writer ids, shards, and presence files; entries carry different
   `origin` labels.

### F3. Session A posts; session B sees the pulse

1. A: tool append → own shard → `fsync` → result `through=<seq>`.
2. A's in-process mirror applies the record immediately; A's pulse view is rebuilt; A's next
   assembly may include the new headline (its own entry excluded from its unread headlines).
3. B: directory watcher fires (debounce 400 ms; if watch is unavailable, ≤4 s poll) → mirror
   refresh → new record folded → view changes → `onChange(wsKey)` → precomputed pulse view updated.
4. B's next `systemPrompt.assemble()` renders different text → the loop commits exactly one new
   runtime-context snapshot, appended to history (ADR 0003 §4: the installed loop appends, it does
   not collapse superseded snapshots) → `digestSeq` folds when committed. B's next step renders
   byte-identical text → zero new tokens; byte-stability is therefore a strict requirement, not a
   nicety.
5. If B does not run (idle session), nothing happens: no wake, no injection. B sees it when it next
   runs.

### F4. Cross-window update

1. Two DSH instances/windows are two mounts; each has its own `writerId`, shard, presence file and
   poll/watch driver. No shared memory, no cross-process lock on the hot path.
2. W1 posts: its shard grows. W2's poll notices the new file/bytes within `POLL_MS` (watch usually
   faster) and merges; W2's pulse updates.
3. Simultaneous posts: two independent shards, no conflict; both records appear in every reader
   ordered by `seq`. Identical timestamps are ordered deterministically by ULID randomness.
4. Duplicate directory events, rename-over, and coalesced watch events are no-ops (view hash).

### F5. Recall + read

1. The model calls `confluence_recall({query})`. `ctx.sessionQuery` must exist, else a one-line
   error. There is no workspace filter in v0.2.0: every earlier session in the profile is eligible.
2. `listSessions()` (not the raw-string `cwd` filter — dsh-internals §4.1 correction) → drop the
   caller and `privacy.privateSessions` targets → sort by recency → take 3.
3. For each session, `filterEvents(sessionId, [{kind:'text', text: query}])` (literal,
   case-insensitive, no FTS — fact 24) under a cooperative 5 s deadline (checked between
   sessions/hits); collect ≤5 hits total; redact, excerpt ≤600 chars, frame as untrusted, add
   "literal match, partial coverage" and `session:<id>:<seq>` provenance.
4. The model calls `confluence_read({ref:'session:<id>:<seq>'})`; the tool performs one
   `sessionQuery.readEvent` window (≤3 neighbouring events), renders a bounded excerpt; no journal
   write, no full-log replay.
5. Board reads via `confluence_board`/`confluence_read(<board id>)` append `through=<max visible seq>`
   to the rendered text; when that tool result commits, the projection folds `boardReadSeq` — later
   board views show those entries as read.

### F6. Private / opt-out session

1. Configuration `privacy.privateSessions` (user-owned) or the M3 panel opt-out marks a session
   private before its first agent step (by session id).
2. `agent/created`: the plugin registers a scoped suppressor on `agent.ctx`
   (`suppressRuntimeContext()` — `HYPOTHESIS:` exact method name per round-2 correction) inside
   `agent.ctx.effect`, keeps the disposer in its own map, and records the session id as private.
3. Consequences: the pulse provider returns `''` for that session; `tools.resolve` hides the six
   tools (`options.when` false — design choice, stronger than ADR's minimum: a private session
   cannot post either); the ledger emits no `session` rows and the presence file omits the session
   id; recall excludes it.
4. Rows written before the opt-out are append-only and remain (the panel marks the session
   "previously shared"); M4 provides a tombstone path for a user deletion. Nothing is ever deleted
   from the session log (DSH owns it).
5. v0.2.0: there is **no workspace-level opt-out** — `privacy.disabledWorkspaces` was removed with
   the workspace boundary (ADR 0007 §6); the profile-wide scope is the product.

### F7. Plugin unload / reload

1. Dispose (LIFO): state → disposed; timers/watcher stopped; pulse returns `''`; dirty ledger rows
   and shard flushed + closed synchronously; own presence file removed; projection handle released;
   caches dropped. No write may happen after dispose.
2. Reload (HMR): new instance, new `writerId`, new shard/presence; mirrors re-read existing shards;
   the watermark unit re-registers and refolds cursors from the session log/checkpoint.
3. The rebuilt pulse text equals the pre-reload text for the same data → the loop does not commit a
   duplicate snapshot (fact 6). No user-visible discontinuity.
4. Old shards remain (append-only); M4 compaction merges them later. Old presence files are stale
   after 30 s and TTL-cleaned after 10 min.

### F8. DSH restart

1. The process dies without guaranteed dispose: at most the last ≤1 s of appends per writer can be
   lost, an unterminated tail may exist, and presence files go stale after 30 s (G2/store-format).
2. New process: sessions are restored by DSH from their logs; the plugin activates, mints a new
   writer id, loads the workspace mirrors by scanning shards (and a snapshot if a manifest publishes
   one), ignores stale presence, and resumes polling.
3. Cursors survive via the session log: resume/fork replay includes the committed runtime-context
   snapshots and tool results, so `digestSeq`/`boardReadSeq` refold to the same values (ADR 0001
   §8.1). The first post-restart assembly renders the same text → no duplicate snapshot.
4. Torn tails are ignored forever (the crashed writer is gone); no repair writes.

### F9. Malformed store recovery

1. Activation: best-effort `mkdir -p`; optionally read/validate `MANIFEST.v1.json` (absent/corrupt →
   ignored). Then each workspace mirror scans shard files; every invalid line is skipped and counted;
   unreadable files are retried and skipped (store-format §9.1).
2. The view is built from the valid subset; the pulse renders from it; the board result text appends
   a degraded line (`store=degraded lines=2 files=1`) so the model knows the view is partial.
3. The plugin never repairs, truncates or rewrites a shard; corruption is contained, logged, and
   surfaced (store-format §16). Persistent fsync failures mark `durability: degraded`; a read-only
   root runs the plugin read-only (post/reply return `E_STORE_WRITE`, reads still work).
4. If the workspace key collides with a different canonical path (manifest mismatch), the workspace
   is refused (`E_WS_COLLISION`): tools return a clear error, pulse `''`, nothing leaks across
   paths.

## 12. Failure and containment table

| Failure | Detection | Containment | Model/user-visible |
|---|---|---|---|
| Store root unwritable | write/`mkdir` fails | read-only or in-memory mode | `post`/`reply` error line; board/pulse still work |
| Shard write fails (ENOSPC/EIO) | write throws | fail the call, no partial line | "could not record"; store marked degraded |
| Shard read fails (EBUSY/EACCES) | open/read throws | retry 3×, skip file this refresh | temporarily stale view; warning logged |
| Torn tail / malformed line | parser | ignore/quarantine; never repair | one record hidden; count surfaced |
| Missing/corrupt manifest | validate | ignore manifest, scan shards | none (reads fine) |
| Corrupt snapshot | validate | ignore snapshot, read shards | none (slower refresh) |
| `fs.watch` throws | try/catch | disable watch, poll only | freshness ≤4 s instead of <1 s |
| Poll refresh fails repeatedly | consecutive failures | backoff to 30 s, keep last view | stale pulse; warning rate-limited |
| `sessionProjections` absent | `ctx.get`/inject | in-memory cursor map (degraded) | duplicate headline possible, no lost note |
| `sessionQuery` absent | `ctx.get` | recall returns clear error | recall unavailable, board unaffected |
| `workingDirectory` missing | `ctx.get` | fall back to `header.cwd` only | effective-dir metadata absent |
| `realpath` fails (deleted cwd) | resolver | session has no workspace key | no tools/pulse for that session |
| wsKey collision | manifest path mismatch | refuse workspace mount | clear error, no cross-path leakage |
| PTC preset (tool/call absent) | tool/ptc-dispatch parsing | ledger still records hints | hints may be partial (labeled) |
| Private session | opt-out config/panel | no pulse, no tools, no ledger, no presence | session is invisible to peers |
| Agent disposed mid-tool | `exec.agent`/disposed flag | tool fails `E_DISPOSED`; no write after dispose | one error result |
| Duplicate plugin mount (HMR overlap) | pulse name collision / writer ids differ | each mount writes its own shard; identical text dedupes | no duplicate snapshots; old shards merge |
| Store grows past shard cap | count >64 | merge newest 64, warn | older notes hidden until compaction |
| Board cap reached | visible count ≥ `store.maxEntriesPerWorkspace` (default 2 000) | reject new post (`E_BOARD_FULL`→`BOARD_FULL`) | actionable error, no silent loss |

## 13. Test seams and determinism

- Every module takes `deps` (fs, clock, random, logger, env, pid) — no hidden globals. Tests import
  `lib/*` directly with fakes (`node --test`, no network, temp dirs under `os.tmpdir()`).
- Pure seams (unit-testable without I/O): `records.validateRecord`, `ids` given clock/random,
  `store.parseLines/foldRecords`, `board.deriveIndex/entryStatus/threadOf/selectHeadlines`,
  `ledger.extractFileHints/nextLedgerRow`, `pulse.buildPulseView/renderPulse`, `watermark.*`,
  `recall.rankSessions/excerptAround`, `redact.*`, `config.normalizeConfig`.
- Async seams with fakes: `WorkspaceMirror.refresh` with an injected fs that throws EBUSY/EPERM or
  returns a torn tail; `JournalWriter` with an injected fs counting writes/fsyncs; `createStore`
  with fake timers for poll/watch debounce; `RecallService` with a fake `sessionQuery`.
- Two-writer conformance uses real child processes only in `test/` (store-format §17.6, §17.24):
  the production bundle contains no `child_process` import (static test §17.32).
- Determinism: injected clock and deterministic random make emitted records byte-comparable; the
  pulse text is compared against golden fixtures; a fixture store generator writes canonical stores.
- The pulse purity test stubs fs to throw and calls the provider (store-format §17.33).

## 14. Deviations and open issues

These are conscious clarifications/decisions relative to ADR 0001. Item 5 is the Lead's ruling on
plan deviation (b), item 10 reflects ADR 0001 §17 E1, and items 1 and 3 are the errata-adjacent
clarifications already recorded; the rest are implementation clarifications.

1. **`seq` representation (ADR §8 example vs §6).** ADR §6 defines `seq` as a 26-char time-sortable
   ULID string; the pulse template in ADR §8 (and §8.1's "seq attribute") illustrates it as
   `seq="1841"`, a number. This design follows the binding definition in §6: cursors
   (`seq="<ULID>"`, `through=<ULID>`) are ULID strings, with `null` = unset, `"0"` = delivered
   empty-board welcome, and an empty `through=` tolerated (ADR 0003 §3; pulse.md §8). The rendered
   shape of the pulse is unchanged apart from the cursor's value; M1 measures and freezes the final
   template.
2. **`fs.appendFile` → held `O_APPEND` fd + `fs.writeSync`.** ADR §6 names `fs.appendFile`; the
   design uses an append-mode fd with synchronous single-line writes so the stated batched-fsync
   policy is implementable and deactivation can flush/close deterministically (ADR 0002 records
   this refinement). Append semantics (one complete line, one writer, no interleaving) are
   preserved; board posts force an fsync before acknowledging (stricter than ADR's minimum).
3. **Workspace metadata location.** ADR requires "the full canonical path is stored in workspace
   metadata" but names no file. It is stored in `MANIFEST.v1.json.workspace` (data-model §4.7), the
   only workspace-level metadata file in the ADR tree; it is created at first mount and preserved by
   M4 compaction. No extra file is introduced.
4. **v2 vocabulary.** Only `signal` and `watermark` types are reserved (ADR §6). Option B's
   `note`/`thread`/`reply` operation names are not introduced: `entry` + `kind` + `replyTo` covers
   them, and unknown types are ignored by readers, so a v2 that wants them can add them without
   migration. `signal`'s field names are reserved verbatim (data-model §4.4).
5. **Export contract naming (Lead ruling, plan deviation (b)).** The deterministic export is
   `memories.v1.jsonl` plus `manifest.json` with
   `{"schema":"confluence.memories/v1","formatVersion":1,...}`; the export is workspace-relative
   only (ADR 0001 §17 E3). The store's internal `MANIFEST.v1.json` is a different file with a
   different purpose. This design's store-format §13.3/§14 are authoritative for the exact bytes and
   field set; ADR 0006 / [`solo-bench-integration.md`](solo-bench-integration.md) §6 carry the
   consumer narrative. The plugin still only promises the export, never the live journal, to
   `solo-bench`.
6. **`session.status` stored vs derived.** ADR §9 lists status values `live`/`idle`/`cold`; a
   last-wins row cannot become cold without a write. Rows store the observed `live`/`idle`; `cold`
   is derived at read time when no fresh presence and `lastActivityTs` is older than 30 s
   (data-model §5.6). Semantics the ADR intends are preserved; no extra writes.
7. **Private sessions get no Confluence tools.** ADR §11 requires a scoped suppressor and no ledger
   rows; this design also hides the tools (a private session must not be able to post into the
   shared board). Matches `config.md` §2.6 and the privacy design; stronger privacy, slightly less
   convenience.
8. **Watermark fallback.** ADR permits an in-memory fallback when `sessionProjections` is absent;
   the fallback is specified here (in-memory cursor map driven by the same committed event listener,
   advanced only on committed events). Degraded: cursors may reset on restart; never loses notes.
9. **Cross-document alignment settled in round 3.** Journal `ts` is an ISO-8601 UTC string (the
   ledger-recall example follows it; a `ts:<ms>` remnant in its §1 intro is stale). Board ids are
   `cnf_` + 26-char ULID and tombstones `tmb_` + 26-char ULID (Lead ruling on plan O3; the export
   reuses board ids unchanged). The projection unit key is the singular `confluence_watermark`, as
   registered in [`pulse.md`](pulse.md) §8.1 and stated consistently in ADR 0003 §2 and the execution
   plan. `New:`/`unread` mean `seq > boardReadSeq`; `digestSeq` only gates the welcome
   (ADR 0003 §3, ADR 0001 §17 E5).
10. **Append-not-replace for pulse snapshots (ADR 0001 §17 E1).** The installed loop appends a new
   runtime-context snapshot per changed pulse text and does not replace or shadow earlier ones, so
   snapshots accumulate until compaction. This architecture and the pulse design already require
   byte-stable, coalesced text with one commit per real state change (§9.3, §10); the added
   consequence is that pulse flapping is a history-growth cost, not only a token cost. M0 measures
   snapshot count vs session length; the documented fallback is a near-static pulse (ADR 0003 §4,
   pulse.md §4.3). No implementation change was needed beyond the corrected wording.

## 15. Open questions

1. **M0 spike items that gate this architecture:** (a) commit-dedupe of identical runtime-context
   snapshots end-to-end; (b) projection-handle `stateOf` synchronous read and the plain
   `{parse}` `stateSchema`; (c) the object form of `inject` (`{required, optional}`) and optional
   service acquisition; (d) `agent.ctx.systemPrompt.suppressRuntimeContext()` existence/scope;
   (e) multi-window process topology and `host.call` contract; (f) Windows `process.kill(pid,0)`,
   `fsyncSync` on appended NTFS data, and `fs.watch` behavior under rename.
2. **Pulse budget:** ADR targets 200–320 tokens, hard cap 1 400 chars; the template and measured
   split are frozen in [`pulse.md`](pulse.md) §3/§6 (owned by the pulse design); this architecture
   only requires the provider to stay within that cap.
3. **Compaction trigger:** automatic hourly vs explicit command only is an M4 product decision
   (ADR 0002 open question 1); the mechanics are ready either way.
4. **Recall cost:** literal `filterEvents` cost on large histories is bounded only by the 3-session
   cap and the 5 s cooperative timeout; M2 measures p95 on the real profile.
