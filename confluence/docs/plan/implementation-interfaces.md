# Implementation interfaces (v0.1.0) — binding for the build round

Status: implementation contract for the code round. Derived from ADR-0001, `docs/design/*`,
`docs/design/store-format.md`. If code and this file disagree, this file + the ADR win; flag
deviations to the Lead. All modules are plain ESM JavaScript under `D:\05_Code\Confluence\lib\`,
Node builtins only (`node:fs`, `node:path`, `node:crypto`, `node:os`), no network, no child process,
no `@deepseek-ai/*` imports.

## 0. Conventions

- Files: `lib/util.js`, `lib/config.js`, `lib/workspace.js`, `lib/redact.js`, `lib/store.js`,
  `lib/board.js`, `lib/watermark.js`, `lib/pulse.js`, `lib/ledger.js`, `lib/presence.js`,
  `lib/recall.js`, `lib/tools.js`, `lib/hostui.js`, `lib/facade.js`, `lib/export.js`, `scripts/export-memories.mjs`, `client.js`, `index.js`.
- Every service takes one options object with injectable seams:
  `{ config, logger, now = () => Date.now(), random, pid = process.pid, fs = nodeFsPromises }`.
  `now()` returns epoch ms; `random()` returns `[0,1)`; tests inject deterministic values.
- `logger` = `{ debug, info, warn, error }` bound functions (never throws). Keep records
  structured (`{event, ...fields}`), never include note bodies, prompts or secrets.
- Errors: `class ConfluenceError extends Error { constructor(code, message, {cause}={}) }` in
  `lib/util.js`; codes are the design's bare codes (`NO_WORKSPACE`, `STORE_UNAVAILABLE`,
  `BOARD_FULL`, `BODY_TOO_LARGE`, `UNKNOWN_REF`, `RECALL_UNAVAILABLE`, `RECALL_TIMEOUT`,
  `NOT_FOUND`, `BAD_ARGUMENT`, `REDACTED`). Tool executors `throw`; the executor renders the
  error.
- Time: store `ts` as ISO-8601 UTC string (`new Date(ms).toISOString()`); `createdAt` only in
  the store manifest; ULID `seq` strings sort lexicographically.
- All async except the pulse text function (synchronous, pure, reads only in-memory snapshot).
- No writes outside `config.store.dir` (or workspace export dir). Never read the export back.

## 1. `lib/util.js` (owner: design-core)

```js
export class ConfluenceError extends Error { code; }
export function createUlidFactory(now, random) -> () => string   // 26-char uppercase Crockford, monotonic per process
export function isUlid(s) -> boolean
export function sha256Hex(s) -> string
export function shortHash(s, n=16) -> string
export function isoNow(ms) -> string
export function truncateUtf8(s, maxBytes) -> string
export function truncateChars(s, maxChars) -> string
export function safeJsonParse(s) -> { ok:true, value } | { ok:false, error }
export function createLogger(configEnabled, sink = console) -> logger
export function makeWriterId(pid, random) -> string  // `${pid}-${8 lowercase hex}`
export function escapePulseText(s) -> string         // & < > U+2028/2029 → \uXXXX
export function once(fn) -> fn
```

## 2. `lib/config.js` (owner: design-core)

```js
export const DEFAULTS = /* exact object; must match cordis.patch.yml row config and design/config.md */;
export function resolveConfig(raw) -> { config, warnings } // warnings: ['CODE field', ...]; merges defaults,
  // clamps ints, validates enums/paths; never throws for a bad value (safe default + warning)
export function publicConfig(config) -> object // sanitized for UI/status output (no patterns list contents)
```

`DEFAULTS` includes `privacy.redactPatterns: []`. The row config in `cordis.patch.yml` must
deep-equal `DEFAULTS` (packaging contract test asserts it).

## 3. `lib/workspace.js` (owner: design-core)

```js
export function canonicalizeDir(rawPath, deps) -> Promise<string|null> // fs.realpath + win32 lowercase
export function workspaceKeyFor(canonicalPath) -> string               // 'ws_' + sha256Hex(canonicalPath).slice(0,16)
export async function resolveWorkspace(deps, session) -> { key, canonicalPath, label } | null
// deps: { workingDirectory?: service, fs, platform }; header.cwd first (immutable original project),
// then workingDirectory.get(session); realpath failure => null (no lexical fallback); label = basename or header title
export function createWorkspaceResolver(deps) -> { resolve(session) } // per-session cached by id
```

## 4. `lib/redact.js` (owner: design-behavior)

```js
export const REDACT_POLICY = 'confluence.redact/v1';
export function createRedactor(config, deps) -> {
  text(s) -> { value, hits },     // API keys (sk-, ghp_, AKIA, xox*-), Bearer tokens, PEM blocks, password=, custom patterns
  title(s) -> { value, hits },    // same + 160-char cap
  files(paths) -> string[],       // workspace-relative only: strip drive/UNC/leading slash, drop .., NUL, deny dotfile patterns; <=8
  tags(tags) -> string[],         // lowercase [a-z0-9_-], <=8
}
```

## 5. `lib/store.js` (owner: design-core)

```js
export class JournalStore {
  constructor({ config, logger, deps })   // deps: fs, now, random, pid
  readonly rootDir: string               // config.store.dir or $DSH_HOME/storages/confluence/v1
  readonly writerId: string
  async init() -> this
  async openWorkspace(wsKey, meta) -> WorkspaceJournal   // mkdir -p workspaces/<wsKey>/, create MANIFEST.v1.json (wx, tolerate EEXIST),
                                                         // validate manifest version/ws; cache handles
  async close()
  // M4: async exportWorkspace(wsKey, destDir, { redactor }) -> { files: [...], recordCount, ... }
}
export class WorkspaceJournal {
  readonly wsKey; readonly dir
  async append(record) -> storedRecord            // assigns v/ws/seq/ts if absent; held O_APPEND fd + writeSync whole line + optional fsync
  records() -> readonly object[]                  // merged view cache (sorted by seq, dedupe by id: entry first-wins, session max-seq)
  async refresh({ force=false } = {}) -> boolean  // rescan shard tails, merge; true when changed
  onChange(cb) -> unsubscribe                     // cb(viewChanged:boolean)
  async writePresence(data) -> void               // presence/<writerId>.json atomic rewrite
  async readPresence() -> { [writerId]: data }    // tolerate invalid/absent files
  async appendAndSync(record) -> storedRecord     // board posts: fsync before resolve
  async flush() -> void                           // fsync ledger/presence batches
  async sizeInfo() -> { shards, bytes, entries }
}
```

Manifest/format follows `docs/design/store-format.md` §13/§15; record envelopes follow
`data-model.md` §2. Unknown record types/fields are preserved/ignored. Torn tail: ignore an
incomplete trailing line and remember offset. Poll: `config.store.pollMs` is the contract;
`fs.watch` optional/best-effort, wrapped in try/catch, never required. Cap: `maxEntriesPerWorkspace`
is enforced by board, not store. Durability policy: board append resolves after fsync; session
ledger/presence may batch fsync.

## 6. `lib/board.js` (owner: design-behavior)

```js
export class BoardService {
  constructor({ store, config, redactor, logger, deps })
  async attach(wsKey, meta) -> this                  // opens journal + subscribes refresh
  view(wsKey) -> BoardView                          // synchronous from merged records cache
  async post(wsKey, input, author) -> { id, seq, kind, status }   // append-only; fsync before resolve; caps + redaction;
                                                    // kind enum: finding|decision|gotcha|question|handoff|warning
                                                    // input: { kind, title, body?, tags?, files?, replyTo?, resolves?, supersedes? }
  async thread(wsKey, ref) -> { entry, replies, resolved, superseded, notFound }
  async search(wsKey, { query, kind, tag, limit }) -> { hits: [{entry, snippet, score}], truncated }
  stats(wsKey) -> { entries, openQuestions, openHandoffs, byKind }
  async refresh(wsKey) -> void
}
export function foldRecords(records) -> BoardView  // pure, unit-testable
// BoardView = { entries: Map<id, Entry>, roots: Entry[], sessions: Map<sessionId, LedgerRow>,
//   openQuestions: Entry[], openHandoffs: Entry[], stats, maxSeq, entryCount }
```

Entry record (journal): `{ v:1, type:'entry', id:'cnf_<ULID>', ws:<wsKey>, seq, ts, kind, title,
body?, tags?, files?, author:{sessionId,title,origin:'agent'|'user'}, replyTo?, resolves?:boolean,
supersedes?, deleted?:false }`. Tombstone: `{ v:1, type:'tombstone', id:'tmb_<ULID>', ws, seq, ts,
target:<entry id> }`. Session ledger row: `{ v:1, type:'session', ws, seq, ts, sessionId, title?,
effectiveDir?, turns, lastActivityTs, status:'live'|'idle'|'cold', files?: [...] }` (last-wins per
sessionId). Validation/limits from `data-model.md` §4 and `config.md`.

## 7. `lib/ledger.js` + `lib/presence.js` (owner: design-surface)

```js
export class SessionLedger {
  constructor({ store, config, logger, deps })       // deps: workingDirectory, workspaceResolver, sessions?
  attach(ctx) -> void                                 // subscribe session/event: turn/end, tool/call, tool/ptc-dispatch, tool/result (names only)
  async flush(wsKey?) -> void                         // coalesced `session` upsert records (max 1/5s per session)
  ledger(wsKey) -> Map<sessionId, LedgerRow>          // from store merged records (board folds it, or read store)
  static extractFilesFromToolCall(name, argsJson) -> string[]   // write/edit-style tools only; workspace-relative best effort
  static extractFilesFromPtcDispatch(event) -> string[]         // HYPOTHESIS shape; defensive, [] on unknown
}
export class Presence {
  constructor({ store, config, logger, deps })
  attach(ctx, listLiveSessions) -> void               // heartbeat every 10s + on turn/end; presence/<writerId>.json {writerId, updatedAt, sessions:[{sessionId,title,wsKey,status}]}
  live(wsKey) -> [{ sessionId, title, writerId, updatedAt }]   // read via store.readPresence(), filter stale >30s
}
```

Ledger is metadata only: no prompts, no assistant/tool text, no command lines.

## 8. `lib/watermark.js` (owner: dsh-researcher)

```js
export class WatermarkTracker {
  constructor({ config, logger, deps })               // deps: now
  async attach(ctx) -> void                            // prefer ctx.sessionProjections.register({key:'confluence_watermark', stateSchema:{parse}, init, apply, stateVersion:1})
                                                       // host-only unit; await registration; on failure fall back to in-memory + session/event fold
  get(session) -> { digestSeq: string|null, boardReadSeq: string|null }  // sync, from ready handle stateOf(session) or fallback map
  observeDigestCommit(sessionId, seq) -> void          // fallback only (called by Pulse after assembly? no: prefer log fold)
  dispose() -> Promise<void>
}
// Fold rules (log-derived, verified design): digestSeq = max seq parsed from committed user/message
// runtime-context snapshots of section `confluence:pulse` (`seq="<ULID>"` attr, escaped);
// boardReadSeq = max seq parsed from committed tool results of confluence_board/confluence_read
// (`through=<ULID>` marker) and from tool/ptc-dispatch log copies. init() folds inherited prefix too.
```

## 9. `lib/pulse.js` (owner: dsh-researcher)

```js
export function buildPulseText(input) -> string        // pure; input: { workspaceLabel, newEntries, openQuestions, openHandoffs,
                                                       //   peers, welcome, cursor, maxChars, escape }
export class PulseService {
  constructor({ board, watermark, presence, workspaceResolver, config, logger, deps })
  attach(ctx) -> void                                  // ONE global ctx.systemPrompt.context({name:'confluence:pulse', order:1500,
                                                       //   required:false, interpolate:false, text: ctx => this.textFor(ctx.agent)})
  textFor(agent) -> string                             // synchronous; '' when nothing new (or service disabled); never throws
  invalidate(workspaceKey?) -> void
  async refresh(wsKey?) -> void                        // recompute in-memory snapshot off the prompt path
  dispose() -> void
}
```

Welcome digest: first assembly with no cursor shows up to 3 newest entries + open questions/handoffs
(capped) with `welcome="1"`, cursor = rendered head. Steady state: only entries `seq > boardReadSeq`
(max 3 headlines) + counts + presence; byte-stable, no wall clock/ages/status words; hard cap
320 estimated tokens / 1400 chars; escape untrusted text. Marks nothing itself.

## 10. `lib/recall.js` (owner: design-surface)

```js
export class RecallService {
  constructor({ config, logger, deps })                // deps: sessionQuery, workspaceResolver, redactor, now, signal?
  enabled() -> boolean                                 // false when sessionQuery absent
  async recall({ agent, query, limit }) -> { hits: [{ sessionId, title, seq, excerpt, ref }], truncated, tookMs }
  async readRef({ agent, ref, limit }) -> { sessionId, title, events: [{ seq, role, text }], truncated }
  // enforcement: listSessions() -> canonicalize each header.cwd -> caller workspace only -> drop caller ->
  // recency sort -> <=3 sessions, <=5 hits total, 5s cooperative deadline, excerpts <=600 chars redacted.
}
```

## 11. `lib/tools.js` (owner: planner)

```js
export function createTools({ board, pulse, watermark, recall, workspaceResolver, redactor, config, logger }) -> ToolDefinition[]
export function registerTools(ctx, tools) -> () => void
// Six tools exactly as docs/design/tool-api.md: confluence_board, confluence_post, confluence_read,
// confluence_search, confluence_reply, confluence_recall. Raw ToolDefinition: {name, description,
// parameters: JSON Schema object (type:'object', properties, required), output:{schema, render(args,value)->[{type:'text',text}]},
// execute(args, exec)}. exec.agent may be undefined -> throw NO_WORKSPACE. All results text blocks;
// board/read results include a final line `through=<ULID>` (the max rendered seq) for the watermark fold.
// Tool errors: throw ConfluenceError / Error with a short human message.
```

`registerTools` uses `ctx.tools.register(def, { when })`; `when = ({agent}) => agent && workspaceResolver.resolve(agent.session)` can be sync? `when` may be async — use cached resolver (sync `hasWorkspace(agent)` after warm cache; on cold call `resolve` lazily and return false, warming cache via `agent/created` listener). Keep it simple: register globally; tools throw `NO_WORKSPACE` when unresolved (design allows; document deviation if `when` is not used).

## 12. `lib/hostui.js` + `client.js` (owner: architect-a)

```js
// hostui.js — M3 read-only data channel, proven webServer route path (host.call deferred)
export function registerHostUi(ctx, { board, presence, workspaceResolver, config, logger }) -> () => void
// ctx.get('webServer') optional: if absent, return noop disposer.
// Routes (kind:'exact', handler(req,res)) or resource routes, read-only, JSON, no-store:
//   GET /confluence/panel/ping      -> {ok:true,name:'dsh-confluence',version}
//   GET /confluence/panel/workspaces -> {workspaces:[{key,label,canonicalPath,entries,openQuestions,live}]}
//   GET /confluence/panel/overview?ws=<key>&q=&kind= -> {workspace, entries:[...], stats, peers:[...]}
//   GET /confluence/panel/entry?ws=<key>&id=<cnf_...> -> {entry, replies}
// Guards: method GET/HEAD only, no-store, max 64KiB response, no absolute paths, no bodies in list view.
// No mutating routes in v0.1.0.
// client.js — plain browser module: window.__ModuleLoader__.load({id:'dsh-confluence', factory(require){
//   const React = require('react'); return { inject: [...], apply(ctx) {...} } }})
// Registers: ctx.slots.inject/register into 'sidebar.panellist' (id 'confluence', order 30, label from
// locale) and keyed 'main' page; panel fetches the routes with same-origin fetch, polls 5s while visible;
// theme only --dsw-alias-* tokens; en/zh locale via ctx.locale; no iframe; no writes.
```

## 13. `index.js` (owner: Lead)

Wires config → workspace resolver → store → board → ledger/presence → watermark → pulse → recall →
tools → hostui. `export const name = 'confluence'`; `export const inject = ['tools', 'systemPrompt']`
(optional services via `ctx.get`); `export function apply(ctx, rawConfig)` registers everything with
`ctx.effect`/`ctx.on` and returns nothing. Also `export { DEFAULTS } from './lib/config.js'`.
Expose `export async function applyWithDeps(ctx, rawConfig, deps)` for hermetic tests (same behavior,
injected services). Activation must never throw for a missing optional service: degrade with a warning.

## 14. Test conventions

- `node:test` + `node:assert/strict`, ESM `.test.js` files under `test/`, no dependencies, no
  network, temp dirs per test (`fs.mkdtemp(os.tmpdir())`), deterministic deps.
- Every module owner writes `test/<module>.test.js` covering its contract plus the relevant
  conformance rows from `docs/design/testing.md` (name tests `UT-*`, `CON-*` where mapped).
- `test/contract.test.js` stays packaging-owned (may be extended for new files/exports).
- Run from repo root: `node --test "test/*.test.js"`; all tests must pass offline.

## 15. Milestone order and ownership summary

| Work package | Owner | Files |
|---|---|---|
| WP1 util/config/workspace/store | design-core | `lib/util.js`, `lib/config.js`, `lib/workspace.js`, `lib/store.js`, `test/{util,config,workspace,store}.test.js` |
| WP2 redact/board | design-behavior | `lib/redact.js`, `lib/board.js`, `test/{redact,board}.test.js` |
| WP3 ledger/presence/recall | design-surface | `lib/ledger.js`, `lib/presence.js`, `lib/recall.js`, `test/{ledger,presence,recall}.test.js` |
| WP4 watermark/pulse | dsh-researcher | `lib/watermark.js`, `lib/pulse.js`, `test/{watermark,pulse}.test.js` |
| WP5 tools | planner | `lib/tools.js`, `test/tools.test.js` |
| WP6 UI | architect-a | `lib/hostui.js`, `client.js`, `test/hostui.test.js` |
| WP7 E2E harness + adversarial tests | architect-b | `scripts/e2e-dsh.ps1`, `test/e2e/*`, `test/fixtures/*`, `scripts/m0-*.mjs` |
| WP8 packaging/contract/docs status | pattern-researcher | `test/contract.test.js`, `scripts/check.mjs`, `README*.md`, `docs/**`, `locale/*.json` (UI keys) |
| Integration/index | Lead | `index.js`, `lib/config.js` wiring, M0 spikes, install/verify, commit/tag/push, solo-bench merge |
