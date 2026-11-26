# DSH 0.2.2-rc.1 internals — verified facts the Confluence / 高级记忆 design depends on

Status: research deliverable (Round 1, `dsh-researcher`). Design-only: no plugin was installed,
no profile state was changed, `solo-bench` and `Crisp` were not modified.

**Citation convention.** `dsh/...` means
`C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\...`.
Line numbers are 1-based lines of the installed file named. `inspect:` means a live
`cordis_inspect_query` result from this running profile (`desktop`, DSH 0.2.2-rc.1).
Knowledge of the installed packages was obtained with the Host `read` tool (which can open
`app.asar`) and, for searching, by extracting the archive's `dsh/node_modules/@deepseek-ai/**`
text files to a temporary directory outside the repo; every quoted fact below was re-read from
the installed bytes, not recalled.

---

## Executive summary (what the Lead needs)

1. **Session effective directory is a projection, not the header.** `Session.header.cwd` is the
   immutable *original project*; the *current* directory lives in the `workingDirectory` session
   projection and changes via `working-directory/change` events. `ctx.workingDirectory.get(session)`
   returns the current value without I/O (`app.asar/dsh/node_modules/@deepseek-ai/dsh-working-directory/lib/index.js:34-51,80-82`).
2. **Built-in cross-session features scope by `SessionHeader.cwd`, not by the effective directory**
   (`dsh-tool-session-query/lib/index.js:471-495`), and the durable Workspace registry also attaches
   sessions by `header.cwd` (`dsh-workspace/lib/index.js:111-129`). Confluence must pick its workspace
   key explicitly; matching the built-ins means "original project", not "where the session is now".
3. **A Host tool at execution time has everything needed for scoping**: `exec.agent` (optional),
   `exec.agent.id === SessionId`, `exec.agent.session`, `exec.agent.ctx`, `exec.agent.status`,
   plus `ctx.workingDirectory.get(agent.session)` for the effective directory and
   `ctx.sessionQuery.readTitle(agent.id)` for the title. No extra plumbing is required.
4. **Passive context injection is cheap and deduplicated if you use `ctx.systemPrompt.context()`.**
   Context contributions are rendered into one runtime-context snapshot; the loop commits a new
   `user/message` only when the rendered snapshot text *differs* from the retained one
   (`dsh-agent-loop/lib/index.js:296-348`), so unchanged content costs zero new messages/tokens.
5. **`agent.inject()` is durable and does not wake the model.** It splices a message into the
   `next-step` inbox and logs one `agent/inbox/spliced` session event
   (`dsh-agent-loop/lib/index.js:570-578,190-201`). Injected context waits until the next step or
   next user turn. There is **no framework-level dedupe** — the plugin must keep its own watermark.
6. **Storage: the profile already has a working domain stack** — `storage-json` root
   `$DSH_HOME/storages`, routed backend `json` (`dsh-base/cordis.patch.yml:175-190`), verified on
   disk (`C:\Users\71408\.dsh\storages\workspace.json`). A new plugin can call
   `ctx.storageDomain.open(spec)` with a unique domain name and **needs no profile config change**.
   Domain names are global per profile (`already-open`), lowercase snake_case only.
   **`single` layout rewrites the whole unit file per write and has no cross-process lock**
   (`dsh-storage-json/README.md:32,142-144`).
7. **Full-text session search is DISABLED in this profile.** `session-query-sqlite` is mounted with
   `path: ':memory:'`, `openAt: 'never'` in both the base and web layers
   (`dsh-base/cordis.patch.yml:149-161`, `dsh-web-app/cordis.patch.yml:22-30`), so
   `searchSessions`/`searchEvents` throw `SESSION_QUERY_SEARCH_DISABLED`. **Exact reads do work**:
   `listSessions`, `filterSessions`, `listEvents`, `filterEvents` (including a literal-text filter),
   `readSession`, `readTitleSnapshots`, `readSurface`, `traceSession`. Do not design on FTS.
8. **Existing prior art to extend, not duplicate:** (a) `ctx.sessionQuery` — exact/filter reads,
   titles, lineage; (b) `@deepseek-ai/dsh-session-reference` — **mounted** in the web layer, prepares
   bounded immutable cross-session snapshots for `@[label](dsh-session:…)` mentions (manual,
   host-driven, per message); (c) `@deepseek-ai/dsh-tool-session-query` — five model-facing tools
   (`session_search`, `session_event_search`, `session_trace`, `session_event_trace`,
   `session_event_read`) that are workspace-scoped by `header.cwd`, but **not mounted** in this
   profile because they need FTS; (d) `dsh-experimental-liveshare` — network sharing through an
   external Liveshare server, opt-in and not selected, irrelevant to a fully offline design.
9. **Tool registration: global `ctx.tools.register()` tools are visible to every agent** unless a
   preset/agent scope restricts them; conditional visibility is `options.when(context)` evaluated
   once per step; per-agent removal is `agent.ctx.tools.restrict({deny:[...]})`. Under the `ptc`
   executor the model sees only `run_code` and the other tools are SDK bindings
   (`dsh-tool-executor-ptc/lib/index.js:1738-1741`). Naming is snake_case, verb/noun
   (`todo_write`, `working_directory`, `session_search`); `run_code` is reserved.
10. **UI: the `main` + `sidebar.panellist` (left sidebar page) pattern is proven by two installed
    plugins** (Crisp and dsh-context), with locale dictionaries and same-origin Host routes for data.
    The right sidebar exposes `sidebar.right.pane.tab` / `.title`. **However the live Client inspect
    provider timed out** (no connected page responded in this session), so slot props could not be
    introspected — UI should be Round-2 optional, not on the MVP critical path.

---

## Verification method and limits

- Host services, events, configs and tools: `cordis_inspect_query` (`Service`, `Event`, `Config`,
  `Tool`) against the live profile. Output is authoritative for this profile.
- Package source/types: the installed packages ship bundled `lib/**/*.js` with JSDoc (the `.d.ts`
  files are not packed). READMEs ship and were read.
- Client `Slots.listSubTree`, `Theme.listTokens`, `Builtin.listBuiltins`: **all timed out**
  (`Client inspect query … timed out after 10000ms`). No live DOM/slot tree was available.
  Client facts below come from installed client bundles and two working third-party plugins.
- No disposable install was performed (design-only constraint), so the following remain
  hypotheses: a third-party bundle importing `@deepseek-ai/*` packages at runtime, a new global tool
  appearing inside a live `ptc` session, and the exact multi-window process topology.

---

## Verified facts

| # | Fact | Evidence | Confidence |
|---|---|---|---|
| 1 | `AssembleContext` runtime object is `{ agent, scope: agent, signal, modelSelection, toolSet }` | `dsh-agent/lib/index.js:407-413`; `dsh-agent-loop/lib/index.js:679-683` | High |
| 2 | `AssembleContext` *declared* fields are only `{ scope?: ScopeKey; signal?: AbortSignal }`; `agent`/`modelSelection`/`toolSet` are added by other packages | `inspect host Service systemPrompt` referencedTypes | High |
| 3 | Only caller of `ctx.systemPrompt.assemble()` in the installed tree is the agent loop | grep of installed `dsh/node_modules/@deepseek-ai/**/*.js`: 1 match, `dsh-agent-loop/lib/index.js:679` | High |
| 4 | Prompt `text` functions and variable providers are called synchronously and must return a string/undefined | `dsh-system-prompt/lib/index.js:186-192,363-364,386-394` | High |
| 5 | Global prompt registrations apply to every agent; `agent.ctx` registrations shadow same names for that agent | `dsh-system-prompt/lib/index.js:358-413`; README "Scoping" | High |
| 6 | The runtime-context snapshot is committed only when its rendered text changes | `dsh-agent-loop/lib/index.js:333-348` | High |
| 7 | `agent.inject(msg)` = durable `next-step` inbox splice, **no wake**; `steer` wakes for next step; `followup` wakes for next turn | `dsh-agent-loop/lib/index.js:564-578` | High |
| 8 | Inbox splice event shape: `{ target: 'next-turn'\|'next-step', start, removedCount?, inserted: UserMessage[], outcome?: 'canceled' }` | `dsh-agent-loop/lib/index.js:190-201`; projection `26-62` | High |
| 9 | `agent/inbox/spliced` is a known session event type, durable and replayable | `dsh-session/lib/types/known-event-types.js:23` | High |
| 10 | `Agent` runtime fields: `id, session, ctx, status ('idle'\|'running'), model, inbox, followup, steer, inject, cancel, whenIdle` | `dsh-agent-loop/lib/index.js:511-556,570-585,634-639` | High |
| 11 | The declared `Agent` interface exported to inspection projects only `{ id: SessionId }`; the full contract is in `dsh-agent`'s unshipped `src/runtime-types.ts` and documented in its README | `inspect host Service agents`; `dsh-agent/README.md:58,74`; `api-catalog.js:5418` | High |
| 12 | `whenIdle()` loops until the whole agent is quiescent; it does not mean "one follow-up finished" | `dsh-agent-loop/lib/index.js:634-639`; `practices.md:28` | High |
| 13 | `Session.header.cwd` is creation metadata; `workingDirectory` is a session projection seeded from `header.cwd` and changed by `working-directory/change` | `dsh-working-directory/lib/index.js:33-44` | High |
| 14 | `workingDirectory.get(session)` returns the committed projection value or `defaultDirectory`, no I/O | `dsh-working-directory/lib/index.js:75-82` | High |
| 15 | The working-directory model context is a **required** system-prompt context `working-directory:current`, and `system-prompt/assemble` is prepended to refresh it | `dsh-working-directory/lib/index.js:45-69` | High |
| 16 | Workspace membership and `attachSession` validate against `header.cwd` and `fs.realpath` canonicalization | `dsh-workspace/lib/index.js:111-129,48-50` | High |
| 17 | `workspaceRegistry.resolveByPath(path)` canonicalizes via realpath; missing paths **reject**, unowned existing dirs return `undefined` | `dsh-workspace/lib/index.js:632-641`; README `:73` | High |
| 18 | Session log folder key is lossy by design: separators collapse to `-`, unsafe code units → `~XXXX`, truncated to 251 chars, wrapped `--…--` | `dsh-session-persistence-jsonl/lib/index.js:871-899` | High |
| 19 | Session directory under project dir uses injective `encodeSegment` (safe `[A-Za-z0-9._-]`, else `~XXXX`) | `dsh-session-persistence-jsonl/lib/index.js:847-869,907-921` | High |
| 20 | Persisted log file name is `session.v4.jsonl.zstd` in `$DSH_HOME/sessions/<projectKey>/<sessionId>/` | filesystem: `C:\Users\71408\.dsh\sessions\--D-05_Code-solo-bench--\session-23da…\session.v4.jsonl.zstd`; base patch `:141` | High |
| 21 | Session log writer uses a Windows named lock keyed by `sha256(resolve(path).toLowerCase())` | `dsh-session-persistence-jsonl/lib/index.js:563` | High |
| 22 | `sessionQuery` exact reads are backend-independent; `searchSessions`/`searchEvents` need the SQLite backend | `inspect host Service sessionQuery` description; `dsh-session-query/…/README.md` not needed | High |
| 23 | This profile disables FTS: `path: ':memory:'`, `openAt: 'never'` | `dsh-base/cordis.patch.yml:149-161`; `dsh-web-app/cordis.patch.yml:22-30` | High |
| 24 | `filterSessions([{kind:'cwd', values:[…]}])` compares **exact string** `record.header.cwd` | `dsh-session-query/lib/index.js:753-767` | High |
| 25 | `filterEvents(sessionId, [{kind:'text', text}])` exists and is provider-independent (literal, case-insensitive, whitespace-flexible regex) | `dsh-session-query/lib/index.js:742-752,786-789`; `inspect host Service sessionQuery` method list | High |
| 26 | Titles are folded from `session/title` events: `readTitle`, `readTitleSnapshot(s)` | `inspect host Service sessionQuery`; `known-event-types.js:57` | High |
| 27 | `ctx.sessionQuery` is optional (`ctx.get('sessionQuery')`); `ctx.storageDomain` likewise | `inspect host Service` access blocks | High |
| 28 | `defineDomain` validates name (`^[a-z][a-z0-9_]*$`), non-negative integer version, `layout` ∈ {single, per-record}, `invalidRecords: 'backup-and-skip'`, and a global schema that must not accept `null` | `dsh-storage-domain/lib/index.js:46-76`; `dsh-storage/lib/index.js:80` | High |
| 29 | A domain's backend route is `routes[domain] ?? config.backend`; profile live value is backend `json`, so a new domain needs **no** profile config | `dsh-storage-domain/lib/index.js:338-341,385-388`; `dsh-base/cordis.patch.yml:182-190` | High |
| 30 | Domain names are single-open per profile process; duplicate open → `DomainError('already-open')` | `dsh-storage-domain/lib/index.js:381-383` | High |
| 31 | Domain writes are serialized on one chain per domain; reads are synchronous from memory; `domain/changed` is emitted in-process only after durability | `dsh-storage-domain/lib/index.js:184-243`; README "Known limitations" | High |
| 32 | `storage-json` `single` layout rewrites the whole `<unit>.json`; **no cross-process write locking**, last-completion wins | `dsh-storage-json/README.md:32,142-144` | High |
| 33 | `dsh-atomic-write` ships with DSH: `writeFileAtomic(file, content, {mode, dirMode})` and cross-process `withFileLock(file, op, {waitMs, signal})` with dead-PID takeover and Windows rename retries | `dsh-atomic-write/lib/index.js:62-78,189-218` | High |
| 34 | Zod-like schemas need only `.parse()` (and `.safeParse(null)` when a global is declared); a plain object with `parse`/`safeParse` satisfies the domain and projection registries | `dsh-storage-domain/lib/index.js:74,397,409`; `dsh-session-projection/lib/index.js:379-383,424-432` | High |
| 35 | `ctx.tools.register(definition, options)` accepts raw JSON-Schema `parameters`; `defineTool()` accepts a shorter author DSL and adds strict argument validation | `dsh-tools/lib/index.js:310-359,433-445` | High |
| 36 | `options.when(context: ToolActivationContext)` is evaluated per step in `tools.resolve({agent, modelSelection, signal})` | `dsh-tools/lib/index.js:542-558`; `api-catalog.js:9446,9558` | High |
| 37 | Global tools are visible in every scope; scope restrictions intersect; scoped tools shadow globals | `dsh-tools/lib/index.js:477-508` | High |
| 38 | `run_code` is reserved and cannot be registered/shadowed | `dsh-tools/lib/index.js:440` | High |
| 39 | Under the PTC executor the model-facing schema set is exactly `run_code`; other tools become SDK bindings | `dsh-tool-executor-ptc/lib/index.js:1738-1741,1639-1664` | High |
| 40 | Tool result shape entering the model: `output.schema` + `output.render(args,value) → ContentBlock[]`; errors throw | `api-catalog.js:9482,9546`; `dsh-tool-todo/lib/index.js:122-195` | High |
| 41 | `exec.deferContext(msg)` appends to the `next-step` inbox; the loop also splices `result.additionalContexts` there | `dsh-tool-executor-ptc/lib/index.js:587-592`; `dsh-agent-loop/lib/index.js:972` | High |
| 42 | `exec.concludeTurn()` ends the turn after the step; a tool result's `concludesTurn` is data, not a listener | `api-catalog.js:4726`; `dsh-tool-executor-ptc/lib/index.js:535` | High |
| 43 | `ToolRunContext` = `ToolExecutionInput {callId, rootCallId?, name, schema?, arguments, agent?, toolSet?, parent?, signal}` + `{rootCallId, token}` + `deferContext`, `concludeTurn` | `api-catalog.js:9494,9502,9582` | High |
| 44 | The live profile mounts `@deepseek-ai/dsh-session-reference` in the web layer | `dsh-web-app/cordis.patch.yml:90-91` | High |
| 45 | `tool-session-query` is only mounted by the opt-in `dsh-experimental-session-search` bundle, which this profile does not include | `dsh-experimental-session-search/cordis.patch.yml:1-14`; `profiles/desktop/package.json` bundle list | High |
| 46 | This agent's visible tools include no `session_search`/`session_query` tool | `inspect host Tool.listTools` for this session | High |
| 47 | Client module format: `window.__ModuleLoader__.load({ id, factory(require){ const React = require('react'); return {inject, apply(ctx)} } })` | `Crisp/integrations/dsh-plugin-crisp/client.js:10-22`; templates/decoration/client.js | High |
| 48 | Proven UI surfaces: `main` (page, `key`) + `sidebar.panellist` (left-rail entry, `id`, `order`, `label`) | Crisp `client.js:515-546`; dsh-context `lib/client.js` (observed registration strings) | High |
| 49 | Right sidebar slots exist: `rightbar`, `rightbar.session`, `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`, `conversation.session.header.corner` | `dsh-client-ui-sidebar-right/lib/client.js:5667-5763`; dsh-context registers `sidebar.right.pane.tab` | High |
| 50 | Chat-adjacent slots: `conversation.header`, `conversation.session.header`, `conversation.composer.bar`, `conversation.input.dock`, `conversation.chat.node`, `conversation.content` | `dsh-client-ui-conversation/lib/client.js:22865-23103,19937`; `conversation.*.dock` registrations | High |
| 51 | Theme tokens are `--dsw-alias-*`; core set includes bg-base, bg-layer-1/2, bg-overlay, border-l1/l2, brand-primary, label-primary/secondary, state-{error,idle,success,warn}-primary | `dsh-client-ui-theme/lib/client.js:1778-1869` | High |
| 52 | `ctx.layout.selectPanel(panelId \| null)` switches the main panel; it throws for an unregistered panel id | `dsh-client-ui-layout/lib/client.js:505-543` | High |
| 53 | Client data channels used by installed plugins: same-origin Host HTTP route (`ctx.webServer.register({kind:'exact', path, handler})`) fetched by the client, and a client `remote` service injection | Crisp `index.js:98-119`, `client.js:4-5`; dsh-context host route `/api/dsh-context/overview` + client `fetch('api/dsh-context/backfill')` | High |
| 54 | HMR: profile/package recomposition reloads plugins; a replaced package needs the loader entry restarted; browser bundles have their own reload path | `dsh-hmr/README.md:27-49`; `host-plugin.md:83` | High |
| 55 | Session format is v4; `eventAt`/`snapshotEvents`/`ownEvents` are deprecated for new production calls | `dsh-session/README.md:64`; `known-event-types.js` header | High |
| 56 | A fork copies an inclusive event prefix, sets `inheritedEventCount`, closes the open tail with `forked` reason; copied `cwd`/`isSeeded` come from the source | `dsh-session/README.md:82`; `inspect host Service sessions` `fork()` | High |
| 57 | Multi-window ≠ automatic multi-process safety: storage has no cross-process lock, and `domain/changed` is in-process only | `dsh-storage-json/README.md:142-144`; `dsh-storage-domain/README.md:146` | High (doc), process topology: HYPOTHESIS |
| 58 | Full-text search can be enabled by a later patch layer (`openAt: first-search`) but this would be a **profile change**, out of scope this phase | `dsh-base/cordis.patch.yml:149-156` | High |

---

## 1. Session ↔ workspace resolution

### 1.1 The live object surface at tool-execution time

`ToolDefinition.execute(args, exec)` receives `ToolRunContext`. Relevant fields
(`api-catalog.js:9494,9502,9582`):

```ts
interface ToolExecutionInput {
  readonly callId: ToolCallId
  readonly rootCallId?: ToolCallId
  readonly name: string
  readonly schema?: ToolSchema
  readonly arguments: unknown
  readonly agent?: Agent          // absent for non-agent callers (e.g. some UI paths)
  readonly toolSet?: ResolvedToolSet
  readonly parent?: ToolExecutionToken
  readonly signal: AbortSignal
}
interface ToolRunContext extends ToolExecution {   // + rootCallId, token
  deferContext(context: UserMessage): void
  concludeTurn(): void
}
```

The concrete `Agent` created by the default driver (`dsh-agent-loop/lib/index.js:511-553`) has:

| Member | Evidence | Semantics |
|---|---|---|
| `id` | `:513` | `SessionId` of the shared session |
| `session` | `:515` | the live `Session` (header, append, sqlite-independent) |
| `ctx` | `:522` | the agent-scoped Cordis context for per-agent registrations |
| `status` | `:554-556` | `'idle' | 'running'`; do not poll (event `agent/status` instead) |
| `followup(input)` | `:570-572` | splice into `next-turn` + wake driver |
| `steer(input)` | `:573-575` | splice into `next-step` + wake driver |
| `inject(input)` | `:576-578` | splice into `next-step`, **no wake** |
| `cancel(cause, {keepInbox})` | `:579-585` | aborts; clears inbox by default |
| `whenIdle()` | `:634-639` | resolves after full quiescence |
| `model`, `inbox` | `:516-517` | model selection API; structural inbox |

A Host tool can therefore resolve, synchronously and cheaply:

```js
// inside ToolDefinition.execute
const agent = exec.agent
if (agent === undefined) throw new Error('requires an agent session')
const sessionId = agent.id
const session = agent.session
const originalCwd = session.header.cwd            // immutable project
const effectiveCwd = ctx.workingDirectory.get(session)  // current directory, no I/O
const preset = session.header.agentPreset         // optional
const live = ctx.sessions.get(sessionId) !== undefined // live store membership
// title is async and folded from session/title events:
const title = (await ctx.get('sessionQuery')?.readTitle(sessionId))?.title
```

`ctx.sessions.get/list`, `ctx.agents.get/list/roots` come from `inspect host Service sessions|agents`.
The `Session` class surface exposed by inspection is:

```ts
class Session {
  readonly header: SessionHeader
  get id(): SessionId
  readonly inheritedEventCount: SessionLogOffset
  get seq(): SessionLogOffset
  requestHeader(): EpochHeader | undefined
  requestContext(): RequestContext | undefined
  deriveMessages(): Message[]
  deriveEventMessage(event): Message | null
  append<T>(type, data, opts?): SessionEvent<T>
}
interface SessionHeader {
  version, id, createdAt, cwd?, parentSession?, isSeeded,
  origin?: 'subagent', delegationDepth?, agentPreset?
}
```

### 1.2 workingDirectory vs workspaceRegistry vs session header

Three different things, often conflated in design docs:

1. **`SessionHeader.cwd`** — immutable creation metadata, validated absolute, also the key for
   session-log folder layout. It is what the durable Workspace registry validates and what the
   built-in cross-session tooling authorizes against.
2. **Working directory projection** (`ctx.workingDirectory.get(session)`) — the *effective* current
   directory. A `cd` appends a `working-directory/change` event
   (`dsh-working-directory/lib/index.js:138-143`), injects a notice into the session
   (`:144-155`), and on the next assembly the required prompt context
   `Current working directory: "<abs>".` reflects the new value (`:45-51,125-127`).
3. **Durable Workspace registry** (`ctx.workspaceRegistry`) — user-facing "projects": ordered
   records `{path, title, sessionIds, createdAt, updatedAt}`, canonical `fs.realpath` paths,
   session ownership by `header.cwd` (`dsh-workspace/lib/index.js:111-129`, spec `:204-215`).
   `resolveByPath(path)` = realpath-canonicalize and look up; **throws** if the path does not
   resolve, returns `undefined` if the directory exists but is unowned (`:632-641`).

So `workingDirectory.get(session)` and `workspaceRegistry.resolveByPath(...)` only coincide when the
user never `cd`s. The design must decide explicitly.

### 1.3 What happens when the user switches cwd mid-session

Verified behaviour:

- The session log gains `working-directory/change`; the header does **not** change.
- The Workspace registry keeps the session attached to the project of the **original** `header.cwd`
  (attach/validate uses `header.cwd` only; a `cd` does not migrate ownership).
- The built-in cross-session authorization helper computes
  `header.cwd === caller.header.cwd` (`dsh-tool-session-query/lib/index.js:471-474`) and then
  filters with `{kind:'cwd', values:[caller.header.cwd]}` (`:773-776`). It also treats a session
  with no `cwd` as unauthorized for cross-session search (`:750-751`).
- If the effective directory disappears, `workingDirectory.ensure()` restores the original project
  when available and commits a recovery change (`dsh-working-directory/lib/index.js:91-107`).

**Recommendation (design choice, not a verified DSH behaviour):** key shared space by the
**canonical original project** (`header.cwd` realpath) so Confluence agrees with the built-in
workspace grouping and the built-in search authorization; additionally expose the *current*
directory in the UI/injection text when it differs, and do not re-scope a session when it `cd`s.
Freeze the workspace key at first observation per session (a projection or a map), because
`resolveByPath` is filesystem- and network-path-dependent and can change between steps
(path deleted, symlink retargeted). Alternative "follow the cwd" can double-count a session in two
workspaces and disagrees with the built-ins — record this as an explicit decision in the ADR.

### 1.4 Session folders on disk: casing, symlinks, Unicode

- Path segment encoding is `encodeSegment` (injective, `~XXXX` escapes) for session ids and
  `projectKey` for directories. `projectKey` is deliberately **lossy**:
  `/` `\` `:` runs → single `-`, then `--…--`, truncated to 251 chars
  (`dsh-session-persistence-jsonl/lib/index.js:871-899`). Two distinct cwds can map to one folder
  (e.g. `C:\a\b` and `C:/a-b` both → `--C-a-b--`); listing still works per-session because each
  session has its own subdirectory and header, but per-project directory grouping is not a stable
  identity.
- **Case:** `projectKey` does not normalize case, so `D:\05_Code\x` and `d:\05_code\x` are distinct
  directories on disk. Windows NTFS is case-insensitive and Node's `realpath` preserves the spelling
  it was given, so two sessions started with different case spellings can live in different
  project folders yet refer to the same directory. Any canonical key design must compare
  case-insensitively on Windows (and ideally use the same realpath spelling consistently).
- **Symlinks:** the workspace registry's canon is `fs.realpath` (`:48-50`), so a symlinked path
  collides with its target — this is the correct canonicalization to reuse.
- **Unicode:** safe code units stay literal (`[A-Za-z0-9._-]`); everything else, including CJK and
  `~`, becomes uppercase `~XXXX` (UTF-16 code unit, surrogate-preserving). Real CJK cwd names
  therefore appear as long `~4F20~667A…` folders (observed live).
- **Session-log writer lock:** `Local\dsh-session-lock-<sha256(resolve(path).toLowerCase())>`
  (`dsh-session-persistence-jsonl/lib/index.js:563`) — case-insensitive on Windows, one writer per
  log file. Do not attempt to append to `session.v4.jsonl.zstd` yourself.

---

## 2. Prompt injection

### 2.1 AssembleContext, scoping, synchronicity

Declared shape (`inspect host Service systemPrompt`): `{ scope?: ScopeKey; signal?: AbortSignal }`.
The loop builds the runtime context with a helper that sets the agent and scope together:

```js
function assembleContextFor(agent, signal) {
  return { agent, scope: agent, ...(signal === undefined ? {} : { signal }) }
}
// dsh-agent/lib/index.js:407-413
```

and passes it augmented with the step selection and admitted tool set
(`dsh-agent-loop/lib/index.js:679-683`):

```js
const assembly = await this.loopCtx.systemPrompt.assemble({
  ...assembleContextFor(this, signal),
  modelSelection: selection,
  toolSet,
})
```

Therefore a `PromptContext.text` / `PromptSection.text` function receives a context object where
`context.agent`, `context.scope`, `context.signal`, `context.modelSelection`, `context.toolSet`
exist at runtime (the declared interface only mentions `scope`/`signal`; other packages augment it —
this is a type-level detail, JS sees all fields). The working-directory plugin relies on exactly
this: `text: (context) => context.agent === undefined ? "" : …`
(`dsh-working-directory/lib/index.js:45-51`).

Scoping rules (`dsh-system-prompt/lib/index.js`):

- `ctx.systemPrompt.section/context/variable/tools` register into the layer of the **calling
  context's scope**; global when unscoped (`:255-315`).
- `assemble()` merges global + scope-chain layers; scoped names shadow globals
  (`:358-413`).
- Registration and disposal emit `system-prompt/change` (`:223-225`).
- **A globally registered `ctx.systemPrompt.context()` provider participates in every agent's
  assembly** and is invoked once per `assemble()` call with that agent in `context.agent` — i.e.
  once per proposed step, not once per agent creation.
- `refreshContext(assembly, context)` is called later in the same step, after `agent/pre-step` and
  route preparation, and re-runs **context** providers only (not sections/tools/variables)
  (`:316-348`; call site `dsh-agent-loop/lib/index.js:843-845`). Budget for context `text`
  functions being evaluated up to twice per step.

Prompt-section and context `text` functions must be synchronous; returning a Promise would
serialize a Promise into the prompt. Only `assemble()` overall and the
`system-prompt/assemble` waterfall are async.

### 2.2 Mounting globally vs per agent

- **Global (recommended for passive workspace digest):** register once in `apply(ctx)`:
  `ctx.systemPrompt.context({ name:'confluence:digest', order:<any finite>, required:false, text:(c)=>... })`.
  Because the context provider is a plain function, it can return per-agent text by reading
  `context.agent`, and return `""` when there is nothing new. Keep it bounded and deterministic.
- **Per-agent (needed only when a plugin must be removed/shadows another contribution):** in an
  `agent/created` listener, `agent.ctx` is available, and registrations on it unwind when the
  agent is disposed. The pattern (from `practices.md:19`) is: wrap in one `agent.ctx.effect()`,
  also keep the disposer in the plugin's own effect, keyed by agent:

```js
// SKETCH — per-agent registration lifecycle
export function apply(ctx) {
  const disposers = new Map()
  ctx.on('agent/created', ({ agent }) => {
    const dispose = agent.ctx.effect(() => {
      const off = agent.ctx.systemPrompt.context({ name: 'confluence:agent-digest', order: 9000, text: () => buildDigest(agent) })
      return () => off()
    }, 'confluence:agent-digest')
    disposers.set(agent.id, dispose)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = disposers.get(agent.id)
    disposers.delete(agent.id)
    dispose?.()
  })
  ctx.effect(() => () => { for (const dispose of disposers.values()) dispose(); disposers.clear() })
}
```

`agent/created` is `serial`: listeners are awaited before creation resolves; do not await
`agent.whenIdle()` or your own disposal there (`dsh-agent/README.md:207`).

### 2.3 `agent.inject()` and `agent/inbox/spliced`

- `inject(input)` → `send(input, 'next-step', false)` (`dsh-agent-loop/lib/index.js:564-578`), which
  splices into the live inbox projection and appends one `agent/inbox/spliced` event
  (`:190-201`).
- Splice payload: `{ target, start, removedCount?, inserted: UserMessage[], outcome? }`.
  Insertions must be unique by `message.id` across both pending lists (`:41-45`), so the same
  `UserMessage` object cannot be injected twice.
- The message object should come from `createUserMessage({ content, source })`
  (`dsh-llm/lib/index.js:37-64`); it assigns a fresh UUID and deep-freezes the message. A
  hand-built object lacking a stable `id` risks duplicate-identity rejection; prefer the helper.
- Delivery semantics (verified by reading the loop): at a turn boundary the loop claims all
  `next-step` input plus one queued `next-turn` message (`:103-111`), then runs
  `agent/pre-step` with the claimed batch. Injected input therefore appears in the **next admitted
  step** — including the next user turn — and never starts a turn by itself.
- Injection is durable: the message can be replayed from the log; inbox projection reconstruction
  rejects invalid splice coordinates (`dsh-agent/README.md:100-104`).
- No dedupe exists: injecting identical text twice produces two messages. Keep a per-session
  watermark (see §2.5).
- A tool can inject too: `exec.deferContext(msg)` / returning `additionalContexts` from
  `tools/post-execute`, both land in `next-step` (`dsh-tool-executor-ptc/lib/index.js:587-592`;
  `dsh-agent-loop/lib/index.js:972`).

### 2.4 Can a `systemPrompt.context` provider be called with no agent?

In this version, **no installed code calls `assemble()` without a scope**: the only caller is the
agent loop, and it always supplies `agent` (`grep` result and `dsh-agent-loop/lib/index.js:679`).
Title generation (`dsh-session-title*`), telemetry, and compaction use their own LLM paths and do
not assemble the system prompt. Nevertheless write providers defensively
(`if (!context.agent) return ''`) — the `assemble(context = {})` default exists, and this is the
pattern the working-directory package uses. Treat the assembly waterfall as scoped to the agent
(`ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', …)`,
`dsh-system-prompt/lib/index.js:401`).

### 2.5 Avoiding duplicate/repeated injections

DSH gives three distinct mechanisms with different token behaviour:

| Mechanism | When the model sees it | Dedupe | Persistence |
|---|---|---|---|
| `systemPrompt.section` (global or scoped) | every request, as system prompt text | none (fixed text) | rendered `system/message` node 0 on each series start |
| `systemPrompt.context` | next request, as one runtime-context snapshot message | **text-identical snapshots are not re-committed** (`dsh-agent-loop/lib/index.js:333-348`) | snapshot is a durable user message with `source.kind:'runtime-context'` |
| `agent.inject` / `exec.deferContext` | next admitted step | none | durable `agent/inbox/spliced` then `user/message` |

Consequences for Confluence:

- Use `systemPrompt.context` for everything passive. Build the digest string deterministically from
  (a) the workspace board's monotonically increasing `seq` and (b) the session's own last-consumed
  `seq`/`asOf` watermark; render `""` when `boardSeq <= consumedSeq`. Unchanged digest ⇒ zero
  messages. Changed digest ⇒ exactly one new runtime-context snapshot message per change.
  **Correction (round 3, verified against `dsh-agent-loop/lib/index.js:859-866` and
  `dsh-session/lib/index.js:1681-1696`):** the changed snapshot is **appended** as a new user-role
  `runtime-context` surface node; it does not replace/shadows the previous snapshot, and
  `deriveMessages()` keeps every surface node, so repeated changes accumulate messages until
  compaction. Consequence: keep pulse changes infrequent and byte-stable, measure snapshot count
  vs session length (M0 spike S1), and prefer coalesced changes; a near-static pulse is the
  fallback if accumulation is material.
- Persist the watermark **in the session log**, not only in memory, or it is lost on resume/fork.
  There is no plugin-owned event type available (see §8), so derive the watermark from the
  snapshot's presence: the runtime-context snapshot message contains the board seq you emitted;
  on replay, the last retained snapshot message tells you what was already delivered. That keeps
  the log as the only source of truth and survives restart.
- Use `agent.inject` only for explicit one-shot events (e.g. "another session posted a decision you
  are waiting on") and only when you know it has not been injected before (dedupe set keyed by
  `(sessionId, entryId)` persisted in the board, or check the session's tail events for the same
  entry id).
- Do not use `systemPrompt.section` for dynamic content: it is static per registration, participates
  in every request (token cost) and changes would require re-registration + `system-prompt/change`.

---

## 3. Offline persistence

### 3.1 Live storage stack (this profile)

`dsh-base/cordis.patch.yml:175-190` composes the storage rows:

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

On disk: `C:\Users\71408\.dsh\storages\workspace.json` (domain `workspace`, single layout, version 2)
and `C:\Users\71408\.dsh\storages\session_projcache\sessions\<sessionId>.json` (per-record layout) —
observed. So:

- **Root:** `$DSH_HOME/storages` (`DSH_HOME` = `C:\Users\71408\.dsh` here).
- **Default route:** `json`. `routes` in `storage-domain` config is empty, so every domain uses
  `json` unless the profile adds a route.
- **File layout:** a spec with `layout: 'single'` (default) → `<root>/<domain>.json`; with
  `layout: 'per-record'` → `<root>/<domain>/<table>/<key>.json` (+ optional `global.json`)
  (`dsh-storage-json/README.md:78-90`).
- **Domain names are global per profile process** (one `DomainFacility`; duplicate open rejects),
  and must match `^[a-z][a-z0-9_]*$` (`dsh-storage/lib/index.js:80`). Pick e.g. `confluence`
  (reserve names now: `confluence` is free — no such unit on disk).

A new plugin needs **no profile config** to open a new domain name: it just calls
`await ctx.storageDomain.open(spec)` (or `ctx.get('storageDomain')` if optional). A profile change
would only be needed to route this domain to SQLite (`routes: { confluence: sqlite }`) or change the
root.

### 3.2 `defineDomain` contract and versioning

`dsh-storage-domain/lib/index.js:46-76`:

```js
const spec = defineDomain({
  name: 'confluence',            // required, lowercase snake_case
  version: 1,                    // non-negative integer
  layout: 'single',              // or 'per-record' (optional; default single)
  compatibleVersions: [],        // older versions the current decoder admits
  invalidRecords: 'backup-and-skip', // optional; per-record backends only
  global: { initial: {...}, schema: zodLikeSchema },   // optional; schema must reject null
  tables: { entries: domainTable(zodLikeRecordSchema), /* ... */ },
})
const domain = await ctx.storageDomain.open(spec)
```

- `defineDomain` is only validation/typing sugar; `open(spec)` re-derives everything from the spec
  object (`descriptorOf`, `:82-91`), so a plugin can pass a hand-built spec object if it cannot
  import the package.
- Records are validated at open (every stored record) and at write; failures are `DomainError` with
  stable codes: `already-open`, `facet-unsupported`, `invalid-record`, `missing-key`, `closed`;
  backend codes pass through (`version-mismatch`, `malformed-medium`).
- Writes: `table.put/delete/deleteMany/update`, `global.get/set`. One write chain per domain; reads
  are synchronous from memory; every write resolves only after the backend acknowledged durability;
  `domain/changed {domain, table, key, operation, value}` is emitted in write order
  (`:184-243`).
- Schema dialect: `valueSchema.parse(value)` is the only call the domain layer makes; the
  projection registry similarly uses `.parse`. **A zod-like object with a `parse` method is
  sufficient** — verified by reading both packages. Real zod (v4.4.3) is also available in this
  profile: it is hoisted at `profiles/desktop/node_modules/zod/index.cjs` (because `dsh-context`
  depends on it) and resolvable from a profile-installed package; `dsh-storage-domain`'s own
  dependency is zod too. Recommendation: declare `zod` in the bundle's `package.json` dependencies
  **or** use minimal hand-written validators to keep the bundle dependency-free.

### 3.3 Multi-window / multi-process write behaviour

- `storage-json` `single`: each write rewrites the complete `<unit>.json` atomically (temp + rename
  + POSIX dir fsync); **no cross-process write locking**; two processes writing the same unit can
  interleave replacements, last-completion wins (`dsh-storage-json/README.md:32,142-144`).
- `per-record`: each write replaces one document; safer blast radius, still no lock across
  processes. Batch deletes are not crash-atomic.
- `domain/changed` is an **in-process** event; another window/process will not see updates until it
  rereads the storage (`dsh-storage-domain/README.md:146`). In practice each process's domain handle
  holds an in-memory snapshot loaded at open, so a second process (or a second DSH instance) will
  **not** observe the first's writes at all until the domain is closed/reopened. This is the single
  biggest storage hazard for a "multi-window" feature and must be designed around.
- DSH has a correct cross-process primitive: `dsh-atomic-write`:
  - `writeFileAtomic(filename, content, {mode, dirMode})` — temp write + `MoveFileExW`-style
    rename with bounded retries on transient Windows errors (`EACCES/EBUSY/EPERM`).
  - `withFileLock(filename, operation, {waitMs, signal})` — `wx`-created `<file>.lock` sibling with
    holder PID and dead-process takeover; readers stay lock-free.
  (`dsh-atomic-write/lib/index.js:62-78,189-218`)

  HYPOTHESIS: a profile-installed bundle can import this package from the DSH installation. The
  stronger workaround that needs no import: keep the append-only journal model so lost updates are
  benign (see §9 patterns), and treat the domain as a derived cache with the session logs as truth.

- HYPOTHESIS (process topology): DSH Desktop likely runs one Host process per app instance and
  renders multiple BrowserWindows from it; two app instances are two Host processes. Multi-window
  *within* one instance is therefore safe (one domain instance), while two app instances are not.
  Verify before promising cross-window live sync; design so that "last writer wins per entry, and
  entries are immutable+append-only" degrades gracefully.

### 3.4 If `storageDomain` is absent

`storageDomain` is optional (inspect access block). Fallbacks, in order of preference:

1. `ctx.get('storageDomain')` and degrade to in-memory + prompt-only mode (the plugin still works,
   nothing persists).
2. Own JSON file under `$DSH_HOME/storages/confluence/…` written with
   `writeFileAtomic`/`withFileLock` (Node `fs` is available to Host plugin code — plugins run in the
   Host Node process; `dsh-context` writes its own `overview-cache.v1.json` and spawns a worker).
   This is allowed by the offline constraint (local files only) but bypasses the harness storage
   contract; keep it as a clearly-labelled fallback.
3. Never write into the session log with a custom event type (see §8).

---

## 4. Cross-session reads — what already exists

### 4.1 `ctx.sessionQuery` (exact reads; optional service)

From `inspect host Service sessionQuery` (authoritative for this profile):

| Method | Works without FTS? | Notes |
|---|---|---|
| `listSessions(signal?)` | yes | complete logical corpus, newest-first `SessionRecord[]` = `{header, live, persisted, formatStatus?}` |
| `filterSessions(filters, signal?)` | yes | ANDed `SessionResultFilter` clauses: `id`, **`cwd`**, `created-at`, `parent`, `availability` (`dsh-session-query/lib/index.js:676-704,753-767`) |
| `readSession(id)` | yes | full replay-validated log snapshot, does not make it live |
| `listEvents(id)` | yes | `SessionEventRecord[]` light log records |
| `filterEvents(id, filters)` | yes | semantic documents; supports `seq`, `time`, `type`, `surface`, **literal `text`** (`:742-752,768-792`) |
| `readTitle` / `readTitleSnapshot(s)` | yes | folded `session/title` events |
| `readEvent({sessionId, seq, before?, after?})` | yes | full event + window |
| `readSurface(id)` | yes | current model surface + capturedThroughSeq |
| `traceSession` / `traceEvent` | yes | lineage / replacement chain |
| `searchSessions` / `searchEvents` | **NO** | throws `SESSION_QUERY_SEARCH_DISABLED` in this profile (`openAt:'never'`) |

`readSession`, `readEvent`, `traceSession` etc. are `SessionQueryEngine` concrete methods; the
SQLite package only implements FTS observation/ranking. Access with
`ctx.get('sessionQuery')` if you declare it optional.

**Practical consequence:** Confluence can implement workspace-scoped recall **without enabling
FTS** by `filterSessions([{kind:'cwd', values:[workspaceKey]}])` + `listEvents`/`filterEvents`
(which read logs). This is I/O-heavy — budget it (on-demand tool, cached digests), never per step.

### 4.2 SQLite index path and indexing

- `dsh-session-query-sqlite` config: `path` (required), `openAt: 'startup'|'first-search'|'never'`
  (default startup), `journalMode` default `wal`, `defaultLimit 20`, `maxLimit 100`,
  `snippetChars 240`, `readWindowMax`, read concurrency, prepared-session cache
  (`dsh-session-query-sqlite/lib/index.js:466-497`).
- In this profile: `path: ':memory:'`, `openAt: 'never'` → the index is ephemeral/in-memory even
  when enabled, and here it is never opened. **There is no persistent FTS file on disk**; a
  `searchSessions` would reconcile from the session-persistence corpus each session start.
- To enable content search the profile would need `openAt: first-search|startup` (a profile change;
  out of scope this phase). Even then, migrating to a durable `path` is a deployment decision.

### 4.3 Agent-facing tools that exist vs are mounted

- `@deepseek-ai/dsh-tool-session-query` registers **five** tools
  (`dsh-tool-session-query/lib/index.js:954-1020`): `session_search`, `session_event_search`,
  `session_trace`, `session_event_trace`, `session_event_read`; plus a prompt section
  `tool:session-query` at order 2300 (`:945-953`). They are **workspace-authorized by
  `header.cwd`** (`:471-495`) and `session_search` forces `{kind:'cwd', values:[cwd]}` and excludes
  the caller itself (`:748-787`). They are mounted only by the opt-in
  `dsh-experimental-session-search` bundle, which this profile does not include. `Tool.listTools`
  for this agent confirms no such tools are visible.
- `@deepseek-ai/dsh-session-reference` — **mounted** (`dsh-web-app/cordis.patch.yml:90-91`). It is a
  host service + `agent/pre-step` listener that turns explicit `@[label](dsh-session:…)` mentions
  into a bounded, immutable, untrusted `## Referenced sessions` snapshot message right after the
  citing user message. `listCandidates(agent, query?, limit?)` filters/ranks **other sessions by
  working-directory affinity** (it compares the sessions' working directories) and titles. It
  consumes `ctx.sessionQuery` for surface reads, needs no FTS, and exposes a client Remote
  (`ctx.remote.sessionReferenceResolver.candidates`). It does not auto-share anything, and it does
  not write to the source session.
- `@deepseek-ai/dsh-experimental-liveshare` (+ protocol) — sharing through a **separate Liveshare
  server** (OAuth, relay, external database). Opt-in, default Web profile excludes it. Not offline,
  not relevant except as a source of prior art for viewer surfaces.
- `@deepseek-ai/dsh-experimental-session-search` — a 1-patch opt-in bundle that mounts an isolated
  `sessionQuery` group with `session-query-sqlite` (`openAt: first-search`) + `tool-session-query`.
- `dsh-context` (installed third-party) — context/token insight dashboard, not cross-session
  sharing. Writes its own cache under `$DSH_HOME/storages/dsh-context/overview-cache.v1.json` and
  serves `/api/dsh-context/*`.

### 4.4 What Confluence would add (precise gap statement)

Already provided by the platform:

1. Exact historical reads of any session (including persisted-but-cold) with cwd/time/type/text
   filters and title folding.
2. Manual, user-driven cross-session context injection via `@session` mentions.
3. An opt-in FTS-backed agent search tool with cwd-based authorization (not mounted here).
4. A Workspace registry mapping canonical directories to sessions with user-facing titles.

Genuinely missing (Confluence's contribution):

1. **Automatic** workspace-scoped sharing: no user action, no mention syntax.
2. A **curated shared space** (decisions, gotchas, file-intent, ownership) rather than raw transcript
   search or whole-message snapshots.
3. **Passive, bounded per-step digest** injected into every same-workspace session (≤400–800 tokens),
   deduplicated, with explicit privacy/budget controls.
4. A **write path** that is safe for concurrent sessions (append-only entries with provenance).
5. Optional **offline retroactive indexing** of same-workspace logs using exact reads (no FTS), which
   the platform does not do automatically.
6. A **UI surface** (workspace-level board) that the platform has no equivalent of.

---

## 5. Tool registration patterns

### 5.1 Two shapes

`ctx.tools.register(definition, options?)` (`dsh-tools/lib/index.js:433-445`) requires
`{ name, description, parameters (raw JSON Schema object), output: { schema, render } }`, with
optional `execute`, `presentCall`, `presentResult`, `isConcurrencySafe`, `timeoutMs`,
`projectContent`, `finalizeContent`. It validates the raw schema (`assertSupportedJsonSchema`), so
`parameters` must be a complete JSON Schema (`type:'object'`, `properties`, `required` array).

`defineTool(options)` (`:310-359`) is the ergonomic wrapper used by every shipped tool: its
`parameters` is an **author DSL map** — `{ <paramName>: { type, required?: true, description, enum?,
const?, items?, properties?, additionalProperties?, oneOf?, default?, examples? } }` — compiled to
JSON Schema; `output.schema` is the same DSL for a JSON-value root; `execute` runs after strict
argument validation (`ToolArgsError` on bad model args). `type:'json'` means "any JSON value".

### 5.2 Small real implementations

Working-directory tool — the minimal shape (`dsh-tool-working-directory/lib/index.js:16-42`):

```js
export const inject = ['tools', 'workingDirectory']
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'working_directory',
    description: 'Read the current working directory, or change it with cd. …',
    parameters: { cd: { type: 'string', description: 'Existing directory to enter. Omit to read the current directory.' } },
    output: {
      schema: { type: 'object', additionalProperties: false,
                properties: { cwd: { type: 'string', required: true, description: 'Current absolute working directory.' } } },
      render: (_args, value) => [{ type: 'text', text: value.cwd }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('working_directory requires an agent Session')
      return { cwd: args.cd === undefined
        ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        : await ctx.workingDirectory.set(exec.agent, args.cd, exec.signal) }
    },
  }))
}
```

`todo_write` (`dsh-tool-todo/lib/index.js:97-195`) adds: a session projection (`key:'todos'`, zod
wire schema), `exec.agent.session.append('todo/write', …)`, `presentCall` card metadata, and a
render summary. Errors: plain `throw` inside `execute` → error tool result; argument violations
throw `ToolArgsError` before `execute`.

Result path into model context: `execute` value → validated against `output.schema` (executor) →
`output.render(args, value)` → `ContentBlock[]` → tool-role result message → next request. The
canonical shapes are `ToolExecutionSuccess { isError:false, value, content, meta?,
additionalContexts?, concludesTurn? }` (`api-catalog.js:9510`).

### 5.3 Activation, scope, presets

- `register(definition, { when })`: `when(context: {agent, modelSelection, signal})` is resolved
  once per proposed step by `tools.resolve()`; a throwing condition is a `ToolActivationError`
  (`dsh-tools/lib/index.js:542-558`; `api-catalog.js:9446,9558`). Use it to hide a tool when the
  session has no workspace or no board.
- Global registration (`ctx.tools.register` in `apply`) is visible to **all agents**. A preset or
  agent scope can:
  - shadow by registering the same name on `agent.ctx` / preset ctx (scoped wins, `:477-508`),
  - remove global tools for that agent: `agent.ctx.tools.restrict({ deny: ['confluence_write'] })`
  - (restrict requires a scoped ctx; `allow`/`deny` names are validated against the pre-restriction
    global names, `:453-468`).
- Presets (`dsh-agent-preset`) are compositions mounted per session; the live `selectedDefault` is
  `ptc` (`profiles/desktop/cordis.patch.yml:47-51`). Presets used here register their own tool rows
  (e.g. `presets/cordis.patch.yml:24-138`) but do not restrict globals. Under the `ptc` executor the
  model-facing tool set is exactly `run_code`; every visible tool becomes a binding inside the
  generated SDK docs (`dsh-tool-executor-ptc/lib/index.js:1639-1664,1738-1741`). **So a global
  Confluence tool will be reachable in a `ptc` session only through `run_code`, with its schema
  rendered into the run_code SDK instructions.** Verify visually in both preset types before
  promising UI affordances.
- Naming convention observed: snake_case, verb- or domain-first — `todo_write`, `working_directory`,
  `session_search`, `session_event_read`, `load_workspace_dependencies`, `job_output`. `run_code` is
  reserved (`dsh-tools/lib/index.js:440`). Name Confluence tools `confluence_*` to avoid colliding
  with the built-ins that may be mounted in other profiles.

---

## 6. Client UI surface

### 6.1 Manifest and loader (verified from installed plugins + template)

`package.json` of a dual-half bundle (Crisp, template):

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js",
               "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

`client.js` is a plain browser module — no imports of Harness client packages
(`Crisp/.../client.js:7-13`):

```js
window.__ModuleLoader__.load({
  id: '@local/my-plugin',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('confluence', { zh, en }))
        const t = ctx.locale.bind('confluence')
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: 'confluence', locale: 'confluence',
                                     inject: () => ({ t, closePanel: () => ctx.layout.selectPanel(null) }) },
                                   Page)
        })
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'confluence', order: 30,
                               locale: 'confluence', label: () => t('panel') }, Icon))
      },
    }
  },
})
```

### 6.2 Slot tree relevant to a workspace/session panel

Client inspection timed out, so this is assembled from installed registrations (all verified in
client bundles):

| Slot key | Kind | Occupants/usage | Fit for Confluence |
|---|---|---|---|
| `main` | page (pass `key`) | Conversation default; Crisp and dsh-context register a page | **Best MVP page surface** |
| `sidebar.panellist` | left-rail entry (`id`, `order`, `label`) | Crisp, dsh-context | **Best MVP entry point** (opens `main`) |
| `sidebar.right.pane.tab`, `.title` | right-panel tabs | UI `sidebar-right`, dsh-context, better-sidebar | Good secondary; props not introspected here |
| `rightbar`, `rightbar.session` | right track seats | registered by `dsh-client-ui-sidebar-right` | Avoid (track/widget protocol) |
| `conversation.header` / `conversation.session.header` / `….corner` | chat header | host chat UI | small action buttons only |
| `conversation.composer.bar` / `conversation.input.dock` / `conversation.composer.dock` | composer dock | queue/todo docks, template decoration | hint/badge only, not a panel |
| `conversation.chat.node` | chat rows (`kind` = renderer key) | via `ctx.uiConversation.events.register()` | chat rows for write confirmations |
| `settings.general.item` | settings list item | conversation settings | settings page section |
| `contextMenu.icon` / `contextMenu.content` | right-sidebar context menus | sidebar-right | not a panel |

Layout API: `ctx.layout.selectPanel(panelId | null)` (throws for unregistered ids),
`ctx.layout.toggleSidebar()`, `ctx.layout.openRightbar/closeRightbar` (presentation only) —
`dsh-client-ui-layout/lib/client.js:505-547`. A page opened from `sidebar.panellist` should call
`selectPanel(null)` to return to the conversation (Crisp pattern).

### 6.3 How the client gets host data

Three working patterns, in increasing cost:

1. **Same-origin Host route + `fetch`** (Crisp; dsh-context): Host
   `ctx.webServer.register({ kind:'exact', path:'/crisp/status', handler })`
   (`Crisp/.../index.js:98-119`), client `fetch('/crisp/status')`. dsh-context uses
   `/api/dsh-context/overview` etc. through a `connection`-based helper. No new port and no external
   network, but it *is* a fetch — the brief's "no fetch" constraint must be interpreted as "no
   network egress"; confirm with the Lead.
2. **Typert Remote namespace** — the harness's first-party transport (services decorated with
   `@Remote`; client injects `remote`/`remote.session` services). dsh-context client injects
   `['remote','remote.session']`; DSH's own services expose `@Remote` methods. Third-party
   registration of a Remote namespace is **unverified** for 0.2.2-rc.1; better-sidebar lists
   `./client/service` exports, implying a supported path, but the exact API is not documented in the
   installed skill references. Defer.
3. **Client event stream** from host via the existing connection — not investigated further.

### 6.4 Theme, locale, icon

- Theme: use only `--dsw-alias-*` tokens (list at `dsh-client-ui-theme/lib/client.js:1778-1869`:
  `--dsw-alias-bg-base`, `-bg-layer-1/2`, `-bg-overlay`, `-border-l1/l2`, `-brand-primary`,
  `-label-primary/secondary`, `-state-{error,idle,success,warn}-primary`, …). Literal colors only for
  artwork.
- Locale: exported JSON files `locale/en.json`, `locale/zh.json` with
  `{ "meta": { "title": "...", "description": "..." } }` for the Plugin Manager/Settings inventory
  (`host-plugin.md:31-43`), plus client-side dictionaries registered with
  `ctx.locale.register(ns, {en, zh})` and read through `ctx.locale.bind(ns)` (Crisp
  `client.js:518-519`). `meta.title`/`meta.description` are mandatory display resources even for a
  Host-only bundle.
- Icon: `./icon` export (package-root `icon` field takes priority), SVG/PNG/JPEG/WebP ≤256 KiB,
  must stay inside the package (`host-plugin.md:51`).

### 6.5 MVP recommendation

- **MVP (Round-2 implementation):** Host-only. No client half. Deliver: workspace key resolver,
  storage domain, 1–2 tools (`confluence_write`, `confluence_read`), passive digest via
  `systemPrompt.context`. This is the highest value/lowest risk and is fully verifiable from the
  Host side.
- **Second step (same phase if time permits):** a left-rail entry + `main` page
  (`sidebar.panellist` + `main`) reading a same-origin route, exactly like Crisp — copy that shape,
  no Harness client imports, tokens only. This is proven in this exact DSH version.
- **Defer:** right-panel tab, chat rows, settings pages, Remote transport, live cross-window sync,
  write actions from UI (read-only board first).

---

## 7. Packaging minimums for a bundle (this installed version)

`host-plugin.md` is accurate for 0.2.2-rc.1. Concretely:

```
confluence/
  package.json          name, version, private:true, type:module,
                        exports { ".", "./client" (optional), "./locale/*.json", "./icon" },
                        files [ runtime files, cordis.patch.yml, locale/*.json, icon.svg ],
                        dsh.bundle.patch = "./cordis.patch.yml",
                        dsh.client = { platform:"web", immediately:true, inject:[...] }   (optional)
  cordis.patch.yml      - insert: [ { id: confluence, name: '@local/confluence', config: {...} } ]
  index.js              export function apply(ctx, config) {} ; optional export const inject=[] ; optional export const Config
  client.js             (optional) window.__ModuleLoader__.load({ id, factory })
  locale/en.json, zh.json  { "meta": { "title", "description" }, ...client strings }
  icon.svg
```

- Host `Config` is schemastery (`@deepseek-ai/schemastery`): `export const Config = z.object({...})`,
  validated when the row activates; the loader row's `config:` must satisfy it
  (`host-plugin.md:57-64`). Tunables belong in `Config` because the user's patch layer survives
  upgrades (`practices.md:22`).
- **Install by link vs packed directory:** local directory installation links the checkout, so
  `files` does not filter what is present; a packed/published bundle is filtered by `files`. Verify
  the packed list before publishing (`host-plugin.md:35`).
- Differences/nuances observed beyond the skill docs:
  - Third-party plugins also use `dsh.client.inject` with package ids of client modules and
    `dsh.client.immediately`; `dsh.manifestVersion: 1` appears in better-sidebar (not documented in
    `host-plugin.md`).
  - `dsh-context` declares `dsh.compatibility.dshReleases` and `engines.dsh`; better-sidebar uses
    `engines.node`. Not required, but a version guard is cheap and protects upgrade stability.
  - The busiest third-party plugins (dsh-context, better-sidebar) keep **all** their data in their
    own files/routes and declare `@deepseek-ai/*` packages as **peerDependencies** — confirming the
    convention that DSH-shipped packages resolve from the installation, and that a bundle should
    declare only what it really imports.
  - Installing a new bundle can activate via HMR; **replacing an already-installed package requires
    a restart** to load a fresh module generation; never infer browser-code updates from an
    unchanged slot id (`host-plugin.md:83`).

---

## 8. Operational risks

1. **HMR/restart.** Source and profile changes are reconciled in one queue
   (`dsh-hmr/README.md:27-49`). A replaced plugin is stopped then re-started; registrations made on
   `agent.ctx` are **not** disposed by plugin unload alone — `practices.md:19` requires keeping your
   own disposers keyed by agent. A reload changes later request prefixes; it never rewrites history
   (`dsh-hmr/README.md:102`). Expect `domain` handles to be closed by the facility on unload and be
   prepared to reopen on activation.
2. **Multiple DSH windows/instances writing storage.** No cross-process lock in `storage-json`;
   `domain/changed` is in-process. Design for convergence: immutable append-only entries with
   UUIDs + timestamps, tombstone/compaction explicitly, never `update()` a shared counter as the
   only ordering signal; or use `withFileLock`/`writeFileAtomic` for a small plugin-owned index.
   HYPOTHESIS: single Host process per app instance, so intra-instance windows are safe; verify
   before claiming live cross-window sync.
3. **Missing optional services.** `sessionQuery`, `storageDomain`, `webServer`, `workingDirectory`,
   `sessionReferenceResolver` can each be absent in other profiles. Declare them optional
   (`inject`/`ctx.inject([...])` or `ctx.get()` and undefined-check) so the plugin stays inactive
   rather than throwing (`practices.md:20`).
4. **Session log replay and fork.** A fork copies the source prefix and re-derives history; plugin
   state must be re-derivable from the log. Per-session watermarks stored only in plugin memory are
   lost on restart; a fork child starts with `inheritedEventCount` and copies all source events —
   including any runtime-context snapshots and injected messages. Therefore:
   - key watermarks by **session id**, re-seed them from the last retained snapshot in the log on
     `agent/created`/resume;
   - do not assume a child session shares the parent's board membership beyond its copied
     `header.cwd` (fork copies `cwd`, `isSeeded`, `inheritedEventCount`; `parentSession` may name the
     source — `dsh-session/README.md:82`);
   - the board should record provenance (`sessionId`, `entryUri`) so a fork's copied context is
     explainable and non-duplicating.
5. **Never do (practices.md):**
   - never append a session event with a new `type` (readers reject unknown non-`ignorable` events;
     live `append()` cannot set `ignorable`; `appendPluginRecord()` is reserved for DSH experimental
     packages) — derive state from existing events or keep it in storage (`practices.md:21`);
   - never listen to `system-prompt/assemble` to add/remove tools or text (use
     `.section()`/`.context()`/`tools()`);
   - never poll `agent/status`; wait on durable events (`turn/end`, `assistant/message`,
     `tool/result`) and use `agent/assistant-stream` for live tokens (`practices.md:28`);
   - never write DOM outside a component, never append to `document.body`, never serve an iframe
     page from the Host (no theme/locale inside) (`practices.md:33-36`, `ui-plugin.md:13`);
   - never mutate values returned by domain reads (they are the stored objects)
     (`dsh-storage-domain/README.md` "Records are plain immutable data");
   - do not import another plugin's DOM/styles/components; do not `require` Harness client packages
     in a plain-JS client half (`practices.md:35`);
   - do not build on FTS in this profile; do not try to write the session log files yourself.
6. **No extra network/listening port.** A Host route on the existing web server is same-origin and
   adds no port; an external database/server or a `fetch` to a non-DSH URL is forbidden. Remote
   Liveshare-style sharing is explicitly out of scope.
7. **Secrets/privacy.** Session logs can contain secrets. The board must be a curated subset, with
   per-workspace budgets, redaction of obvious secret patterns, and a user-visible "what was
   shared" view; never send content outside the machine.

---

## 9. Recommended implementation patterns (sketches)

> All code below is a **sketch** for the architects, not production code. It uses only ctx services
> and Node builtins. `HYPOTHESIS` marks unverified runtime assumptions.

### 9.1 Workspace key resolution (canonical, Windows-safe)

```js
// SKETCH — resolve a stable workspace key at tool/assembly time
async function resolveWorkspaceKey(ctx, session) {
  const headerCwd = session.header.cwd
  if (headerCwd === undefined) return undefined
  const wd = ctx.get('workingDirectory')
  const registry = ctx.get('workspaceRegistry')
  let key
  if (registry) {
    try {
      const workspace = await registry.resolveByPath(headerCwd)   // realpath canon; throws if missing
      key = workspace ? `ws:${workspace.id}` : `path:${headerCwd}`
    } catch { key = `path:${headerCwd}` }
  } else {
    key = `path:${headerCwd}`
  }
  // Windows comparisons are case-insensitive in practice
  return process.platform === 'win32' ? key.toLowerCase() : key
}
// Cache per session id (freeze on first observation); invalidate on session/disposed.
```

Decision to record: use `header.cwd` (matches Workspace + built-in session search) vs
`workingDirectory.get(session)` (follows `cd`). Recommendation: `header.cwd`, with the current
directory shown as metadata.

### 9.2 Passive digest via a global required=false context

```js
// SKETCH — one global context, per-agent scoped text, auto-deduped by the loop
ctx.systemPrompt.context({
  name: 'confluence:digest',
  order: 9000,                 // any finite external order; must not collide with own names
  interpolate: false,          // board text may contain {{ }} and JSON braces
  required: false,             // optional context: suppressed when runtime context is off
  text: (context) => {
    const agent = context.agent
    if (agent === undefined) return ''
    const snap = digestCache.get(agent.id)      // synchronous read from an in-memory mirror
    return snap?.text ?? ''                     // '' when boardSeq <= consumedSeq
  },
})
```

Cache/mirror strategy: keep the board in memory (refreshed by `domain/changed` and a low-frequency
`fs.watch`/timer for cross-process changes), compute each session's digest text synchronously during
assembly, and include `(seq N)` in the text so the next step can detect what the session already saw.

### 9.3 Watermark that survives replay/fork

```js
// SKETCH — derive the consumed board seq from the session's own log, not plugin memory
const MARK = /^\[confluence\] board seq (\d+)/m
function consumedSeq(session) {
  for (const event of session.snapshotEvents().toReversed()) {   // reader is deprecated for prod;
    if (event.type !== 'user/message') continue                   // use projections in production
    const text = event.data.content.find(b => b.type === 'text')?.text ?? ''
    const m = MARK.exec(text)
    if (m) return Number(m[1])
  }
  return 0
}
```

Production alternative (preferred by `practices.md`): register a `ctx.sessionProjections` unit whose
`apply` folds runtime-context messages into `{ lastBoardSeq }`, with a zod-like `stateSchema`
(`{ parse(v){...} }` is sufficient — see fact 34) and `writeVersion` bumps when semantics change.
Read it with `stateOf(session)`; it replays the tail from the checkpoint cache, so resume/fork costs
O(tail).

### 9.4 Tool pair

```js
// SKETCH — names, parameters DSL, activation, output
ctx.tools.register(defineTool({
  name: 'confluence_write',
  description: 'Append one durable shared note (decision, gotcha, file intent) to this workspace\'s Confluence board. Other sessions in the same workspace will see it in their next context digest.',
  parameters: {
    kind: { type: 'string', required: true, enum: ['decision', 'gotcha', 'file-intent', 'handoff', 'note'] },
    text: { type: 'string', required: true, description: 'One self-contained statement; no secrets.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Optional workspace-relative paths this note is about.' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false,
              properties: { id: { type: 'string', required: true },
                            workspaceSeq: { type: 'integer', required: true } } },
    render: (_a, v) => [{ type: 'text', text: `Recorded on the workspace board (seq ${v.workspaceSeq}).` }],
  },
  async execute(args, exec) {
    if (exec.agent === undefined) throw new Error('confluence_write requires an agent session')
    const ws = await resolveWorkspaceKey(ctx, exec.agent.session)
    if (!ws) throw new Error('this session has no workspace directory')
    return board.append({ workspaceKey: ws, kind: args.kind, text: args.text,
                          files: args.files ?? [], sessionId: exec.agent.id })
  },
}))

ctx.tools.register(defineTool({
  name: 'confluence_search',
  description: 'Search this workspace\'s Confluence board and (optionally) prior same-workspace session logs.',
  parameters: { query: { type: 'string', required: true },
                scope: { type: 'string', enum: ['board', 'logs', 'both'] } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  async execute(args, exec) {
    if (exec.agent === undefined) throw new Error('requires an agent session')
    return searchWorkspace(ctx, await resolveWorkspaceKey(ctx, exec.agent.session), args.query, args.scope ?? 'board')
  },
}))
```

`when:` activation should return false when the session has no resolvable workspace
(`options.when = ({agent}) => agent !== undefined && hasKnownWorkspace(agent)`).

### 9.5 Storage domain sketch

```js
// SKETCH — append-only board; per-record layout keeps writes small
const spec = {
  name: 'confluence',
  version: 1,
  layout: 'per-record',
  tables: {
    entries: { valueSchema: { parse(v) { /* validate plain object shape, else throw */ return v } } },
    sessions: { valueSchema: { parse(v) { return v } } },
  },
  global: { initial: { seq: 0, version: 1 },
            schema: { parse(v) { return v }, safeParse(v) { return { success: v !== null } } } },
}
const domain = await ctx.storageDomain.open(spec)
// entry key: `${workspaceKey}/${ulid}` -> { id, workspaceKey, seq, kind, text, files, sessionId, at }
// never update an entry in place; only append + a separate "archived" flag if needed.
```

If `storageDomain` is missing, fall back to an in-memory board + a single JSON file under
`$DSH_HOME/storages/confluence/board.v1.json` written through a lazily-imported
`@deepseek-ai/dsh-atomic-write` (`writeFileAtomic` + `withFileLock`) — HYPOTHESIS that this import
resolves; otherwise degrade to memory-only.

### 9.6 One-shot injections (rare)

```js
// SKETCH — only for explicit events; dedupe by entry id persisted on the board
if (!board.wasInjectedTo(entryId, agent.id)) {
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: `[confluence] Another session in this workspace recorded: ${entry.text}` }],
    source: { kind: 'confluence', form: 'notice' },
  }))
  board.markInjectedTo(entryId, agent.id)
}
```

`createUserMessage` comes from `@deepseek-ai/dsh-llm` (shipped with DSH; import it if the
HYPOTHESIS about shipped-package resolution holds, otherwise construct a plain object with a UUID
`id`, `role:'user'`, `content`, `source` — verify with a smoke test in Round 2).

---

## 10. Open questions / unknowns

1. **Client slot tree/props unverified** — Client inspect timed out three times. Before any UI work,
   open the Harness page and query `Slots.listSubTree` (especially `main`, `sidebar.panellist`,
   `sidebar.right.pane.tab`, `rightbar.session`) and `Theme.listTokens`.
2. **Multi-instance topology** — is a second DSH Desktop window a second Host process? If yes,
   `storageDomain` alone cannot provide live cross-window sync; decide whether Confluence needs a
   file-lock-based refresh or accepts per-process snapshots.
3. **Third-party import of `@deepseek-ai/*`** (dsh-llm, dsh-storage-domain, dsh-atomic-write) from a
   locally installed bundle: strong indirect evidence (dsh-context imports `dsh-session`), but not
   directly tested. A 30-minute smoke test with a throwaway bundle in Round 2 settles it.
4. **PTC preset presentation** of a newly added global tool: the executor's `describe()` returns
   only `run_code`, so the tool must be usable through the generated SDK docs. Verify in a real
   `ptc` session (and in `standard`).
5. **Session-reference interaction**: `@deepseek-ai/dsh-session-reference` is mounted. Does its
   `listCandidates`/mention UI conflict with a Confluence board UI naming (`@`-mention vs board)?
   Likely complementary; record the boundary.
6. **Domain `invalidRecords` backup location** for `per-record` and `single` layouts on a corrupt
   record: behavior is documented at a high level (`backup-and-skip`), but the exact file location is
   backend-specific; test before relying on it for migration.
7. **Title availability for cold sessions**: `readTitle` folds from the log; sessions persisted
   before the title feature may have no title. Digest labels must be optional.
8. **`Session.append()` of existing event types from a plugin** — technically possible
   (e.g. `todo/write` is a known type owned by another package), but ownership semantics
   (`registerMessageProjection` throws on duplicate owner) make it wrong. No plugin-owned event type
   is available to non-experimental packages; confirm the final design stores state in
   `storageDomain` only.

---

## Appendix: exact signatures (as installed)

Host services (from `inspect host Service`):

```ts
// ctx.workingDirectory
readonly defaultDirectory: string
get(session: Session): string
ensure(agent: Agent, signal?: AbortSignal): Promise<string>
set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>

// ctx.workspaceRegistry
async create(path: string, title?: string): Promise<Workspace>
initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined>
get(id: WorkspaceId): Workspace | undefined
list(): Workspace[]
delete(id: WorkspaceId): Promise<boolean>
insertBefore(id, beforeId?): Promise<readonly WorkspaceId[]>
archiveSession(sessionId, options?): Promise<void>            // + unarchive/pin/unpin
async resolveByPath(path: string): Promise<Workspace | undefined>

// ctx.sessions
create(id?, options?): Session
prepare(id?, options?): Session
enter(session): () => void
announce(session): void
async flush(session): Promise<boolean>
get(id: SessionId): Session | undefined
list(): Session[]
fork(source: Session | SessionId, boundary?: SessionSeq, childSessionId?: SessionId): Session

// ctx.agents
turnBoundaryOf(session): TurnBoundaryProjection
currentInitiator(): Agent | undefined ; requireInitiator(): Agent
withInitiator<T>(agent, op: () => T): T ; withoutInitiator<T>(op: () => T): T
setFactory(factory: AgentFactory): () => void
async create(options: CreateAgentOptions): Promise<AgentHandle>
async resume(options: ResumeAgentOptions): Promise<AgentHandle>
register(agent): ReturnType<Context['effect']>
enter(agent, owner: Agent | undefined): () => void
async announce(agent, source: SessionStartSource, signal?): Promise<void>
get(id: SessionId): Agent | undefined ; isOwnedBy(id, owner): boolean
list(): Agent[] ; roots(): Agent[]

// ctx.sessionQuery (optional)
observeSession(sessionId, options?): Promise<SessionObservation>
abstract searchSessions(request: SessionSearchRequest, exec?): Promise<SessionSearchPage<SessionSearchHit>>
abstract searchEvents(request: SessionEventSearchRequest, exec?): Promise<SessionEventSearchPage>
listSessions(signal?): Promise<SessionRecord[]>
async readSession(sessionId): Promise<SessionLogSnapshot>
async filterSessions(filters: readonly SessionResultFilter[], signal?): Promise<SessionRecord[]>
async readTitle(sessionId, signal?): Promise<SessionTitleSnapshot | undefined>
async readTitleSnapshot(sessionId, signal?): Promise<SessionTitleObservation>
async readTitleSnapshots(sessionIds, signal?): Promise<SessionTitleObservationResult[]>
async listEvents(sessionId): Promise<SessionEventRecord[]>
async filterEvents(sessionId, filters: readonly SessionEventResultFilter[]): Promise<SessionEventSearchDocument[]>
async readSurface(sessionId): Promise<SessionSurfaceSnapshot>
async traceSession(sessionId, signal?): Promise<SessionLineageTrace>
async traceEvent(request: SessionEventTraceRequest, signal?): Promise<SessionEventTraceObservation>
async readEvent(request: SessionEventReadRequest, signal?): Promise<SessionEventWindow>

// Types
interface SessionSearchRequest { /* query + sessionFilters + eventFilters + limit + cursor */ } // exact
                                  // shape not projected by inspection; filters are SessionResultFilter /
                                  // SessionEventResultFilter as listed in SessionQuery service types
type SessionResultFilter =
  | { kind:'id'; values: readonly SessionId[] }
  | { kind:'cwd'; values: readonly (string | null)[] }
  | ({ kind:'created-at' } & { from?: number; to?: number })
  | { kind:'parent'; values: readonly (SessionId | null)[] }
  | { kind:'availability'; values: readonly ('live'|'persisted')[] }
type SessionEventResultFilter =
  | ({ kind:'seq'|'time' } & { from?: number; to?: number })
  | { kind:'type'; values: readonly SessionEventType[] }
  | { kind:'surface'; values: readonly ('current'|'shadowed'|'log-only')[] }
  | { kind:'text'; text: string }
interface SessionSearchPage<T> { items: readonly T[]; nextCursor?: SessionSearchCursor }
interface SessionRecord { header: SessionHeader; live: boolean; persisted: boolean; formatStatus?: 'current'|'migration-required' }
interface SessionHeader { readonly version; readonly id; readonly createdAt; readonly cwd?;
  readonly parentSession?; readonly isSeeded; readonly origin?: 'subagent'; readonly delegationDepth?;
  readonly agentPreset? }

// ctx.storageDomain
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
get(name: string): DomainImpl | undefined
async closeAll(): Promise<void>

interface DomainSpec { name: string; version: number;
  layout?: 'single' | 'per-record'; compatibleVersions?: number[];
  invalidRecords?: 'backup-and-skip';
  global?: { initial: unknown; schema: { safeParse(v): { success: boolean } } };
  tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }> }
interface Domain<S> {
  readonly name: string
  readonly global: { get(): unknown; set(v: unknown): Promise<void> }
  table<N>(name: N): { get(k): unknown; entries(): IterableIterator<[string, unknown]>;
    keys(): IterableIterator<string>; readonly size: number; put(k, v): Promise<void>;
    delete(k): Promise<boolean>; deleteMany(keys): Promise<number>; update(k, fn): Promise<unknown> }
  close(): Promise<void>
}
defineDomain(spec): spec            // validates name/version/layout/invalidRecords/global
domainTable(schema): { valueSchema: schema }

// ctx.systemPrompt
section(section: PromptSection): () => void
getSectionOrder(name: PromptSectionOrderName): number
getContextOrder(name: PromptContextOrderName): number
context(context: PromptContext): () => void
suppressRuntimeContext(): () => void
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void
refreshContext(assembly: PromptAssembly, context?: AssembleContext): PromptAssembly
async assemble(context?: AssembleContext): Promise<PromptAssembly>

interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }
// runtime (loop): { agent: Agent; scope: Agent; signal: AbortSignal;
//                   modelSelection: Readonly<ModelSelection>; toolSet: ResolvedToolSet }
interface PromptSection { name: string; order: number;
  text: string | ((context: AssembleContext) => string);
  interpolate?: boolean; complete?: boolean }
interface PromptContext { name: string; order: number;
  text: string | ((context: AssembleContext) => string);
  interpolate?: boolean; required?: boolean }
interface PromptPresentation { sections; contexts; variables }
interface PromptAssembly extends PromptPresentation { tools: ToolSchema[] }

// ctx.tools
register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void
restrict(filter: { allow?: string[]; deny?: string[] }): () => void   // requires scoped ctx
get(name, scope?, toolSet?): ToolDefinition | undefined
executable(name, scope?, toolSet?): ToolDefinition | undefined
async resolve(context: ToolActivationContext): Promise<ResolvedToolSet>
definitions(scope?, toolSet?): readonly ToolDefinition[]
schemas(scope?, toolSet?): ToolSchema[]
setExecutor(executor): () => void
async execute(input: ToolBatchInput): Promise<ToolBatchResult>
guard(guard: ToolGuard): () => void
checkGuards(exec): string | undefined

interface ToolRegistrationOptions { readonly when?: (context: ToolActivationContext) => boolean | Promise<boolean> }
interface ToolActivationContext { readonly agent: Agent; readonly modelSelection: Readonly<ModelSelection>;
  readonly signal: AbortSignal }
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  projectContent?(...): ContentBlock[] | undefined
  finalizeContent?(...): ContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }
interface ToolOutputDefinition { readonly schema: JsonSchemaNode;
  render(args: unknown, value: JsonValue): ContentBlock[]; presentationMeta?(...): JsonValue }
interface ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void; concludeTurn(): void }
interface ToolExecutionInput { callId; rootCallId?; name; schema?; arguments; agent?;
  toolSet?; parent?; signal }
interface ToolExecutionSuccess { isError:false; value; content; error?:never; meta?;
  additionalContexts?; concludesTurn? }
interface ToolExecutionFailure { isError:true; error; value?:never; content; meta?;
  additionalContexts?; concludesTurn?:never }

// ctx.sessions projections (for derived per-session state)
ctx.sessionProjections.register({
  key, stateVersion, stateSchema, init(header, inheritedEventCount),
  apply(state, event),                      // pure+synchronous, same reference if ignored
  wire: { viewSchema, view(state), summary? },
})
stateOf(session): State

// events relevant to Confluence (host, from inspect host Event)
'agent/created'  : serial   { agent, source, signal? }
'agent/disposed' : emit     { agent }
'agent/status'   : emit     { agent, status: 'idle'|'running' }
'agent/inbox/spliced' : (durable session event, not a host event) { target, start, removedCount?, inserted, outcome? }
'agent/turn-stopping' : serial { agent, turn, signal }
'session/created' / 'session/disposed' / 'session/event' / 'session/flush'
'domain/changed' : emit     { domain, table, key, operation, value? }
'system-prompt/assemble' : waterfall (presentation only — do not add/remove tools/text)
'workspace/session-activity' : waterfall ; 'workspace/session-stop' : parallel

// dsh-session known event types (v4) — includes 'session/title', 'working-directory/change',
// 'agent/inbox/spliced', 'todo/write', 'compaction/*', 'request/header', 'request/context',
// 'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/call',
// 'tool/result', 'turn/start', 'turn/end', 'step/start', 'step/end', 'model/selection', ...
// full list: dsh-session/lib/types/known-event-types.js:21-84

// Client (from installed plugins; Client inspection unavailable)
window.__ModuleLoader__.load({ id, factory(require) { const React = require('react')
  return { inject: ['slots','locale','layout'], apply(ctx) {} } } })
ctx.slots.inject(key, () => ctx.slots.register({ name, key | id, order?, locale?, label?,
  inject?: () => props }, Component))
ctx.locale.register(ns, { en, zh }) ; ctx.locale.bind(ns)
ctx.layout.selectPanel(panelId | null) ; ctx.layout.toggleSidebar()
css tokens: --dsw-alias-bg-base, -bg-layer-1, -bg-layer-2, -bg-overlay, -border-l1, -border-l2,
  -brand-primary, -label-primary, -label-secondary,
  -state-error-primary, -state-idle-primary, -state-success-primary, -state-warn-primary
```
