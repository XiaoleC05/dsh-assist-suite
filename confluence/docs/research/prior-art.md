# Prior art: what the DSH ecosystem already does for cross-session information sharing

**Executive summary.** The local DSH 0.2.2-rc.1 installation already contains *two* working answers
to parts of the Confluence problem and one adjacent network product, so Confluence must be scoped
carefully instead of re-inventing them. (1) `@deepseek-ai/dsh-session-reference` is shipped, mounted
and live in this profile: users can `@`-mention another session and the model receives a bounded,
immutable, explicitly-untrusted snapshot as follow-up context. (2) `@deepseek-ai/dsh-experimental-session-search`
ships a bundle that gives the model five read-only, workspace-scoped tools to search/read earlier
sessions, but it is **switched off by default and hidden**; the underlying `ctx.sessionQuery` +
`dsh-session-query-sqlite` services are installed. (3) `dsh-experimental-liveshare` is a
server-mediated remote-share product, unusable offline and explicitly out of scope. The installed
third-party plugins (`dsh-context`, `dsh-better-sidebar`) are *insight/UI* products: they read many
sessions and prove the data access, storage, UI-slot and packaging patterns Confluence needs, but
neither shares information between sessions. Local plugin `@local/crisp-quality-gate` is the
precedent to copy for repo layout, host+client split, offline local install, tests and docs.
**The gap is precise and still real:** nothing in this ecosystem provides *automatic, passive,
workspace-scoped, bounded* sharing of what other sessions in the same workspace learned, decided,
changed or are doing; every existing mechanism is either user-triggered (`@` mention), model-triggered
(search tools), insight-only (dashboards), or requires a server/LAN and network. Confluence should own
that gap and must not duplicate `@`-mentions, session search, or transcript dashboards.
`https://github.com/XiaoleC05/Confluence` exists, is public, and is **empty** (no commits, branches,
releases or contents; created 2026-11-12T17:50:06Z). Every non-verified claim below is marked
`HYPOTHESIS:`.

---

## 1. Verified facts

### 1.1 Runtime and profile wiring

| Fact | Evidence |
|---|---|
| DSH Desktop runtime is `@deepseek-ai/dsh-desktop-runtime` **0.2.2-rc.1**, with every first-party package at `0.2.2-rc.1` | `...\app.asar\dsh\package.json:2-5`, `:13-335` |
| Relevant shipped first-party packages are dependencies of this runtime: `dsh-session-reference` (`:250`), `dsh-experimental-session-search` (`:156`), `dsh-experimental-liveshare` + protocol (`:151-152`), `dsh-tool-session-query` (`:300`), `dsh-session-query-sqlite` (`:249`), `dsh-storage-domain`/`dsh-storage-json` (`:269-271`) | `...\app.asar\dsh\package.json:151-300` |
| Profile `desktop` links `@local/crisp-quality-gate` (local dir), and installs `dsh-context` 0.83.1, `dshmarket` 1.73.17, `dsh-better-sidebar` 0.31.1; bundle order is base → web-app → experimental voice/inspector/agent-team/plugin-market → crisp → dsh-context → dshmarket → dsh-better-sidebar | `C:\Users\71408\.dsh\profiles\desktop\package.json:4-25` |
| Durable storage layout observed: JSON storage domains live under `C:\Users\71408\.dsh\storages\<domain>\` (`workspace.json`, `session_projcache\sessions\*.json`, `dsh-context\overview-cache.v1.json`); session logs live under `C:\Users\71408\.dsh\sessions\<encoded-cwd>\<session-id>\session.v4.jsonl.zstd` | directory listing of `C:\Users\71408\.dsh\storages` and `C:\Users\71408\.dsh\sessions`; team-brief `docs/planning/team-brief.md:39-41` |
| The durable workspace registry is a JSON storage domain: `unit={name:"workspace",version:2}`, `global={initialized,defaultWorkspaceId,workspaceIds[],archivedSessionIds[],pinnedSessionIds[]}`, `tables.workspaces.<id>={path,title,sessionIds[],createdAt,updatedAt}` | observed file `C:\Users\71408\.dsh\storages\workspace.json` |
| Live host services verified with `cordis_inspect_query` (`Service.listService`): `sessionQuery` (listSessions, readSession, readTitle, readSurface, traceSession, readEvent, …), `sessionReferenceResolver`, `sessionPersistence`, `sessionProjections`, `sessionProjectionCache`, `sessions`, `workingDirectory`, `workspaceRegistry`, `storageDomain`, `connection` (with `fetch`, `requestRejection`), `webServer`, `systemPrompt`, `tools`, `agentTeams`, `subagents` | Inspect query output archived by the harness at `C:\Users\71408\AppData\Local\Temp\dsh-spill-phbRRb\session-a0f26e7b91bf\39f9d4659ade-cordis_inspect_query.txt` (`"key": "sessionQuery"` etc.) |
| Host event catalog (verified): `session/created|event|disposed|flush`, `agent/created|disposed|status`, `api-session/added|removed|status|activity`, `tools/*`, `domain/changed`, `system-prompt/assemble|change`, `workspace/session-activity|session-stop`, `connection/request`, `webserver/index-inject`; dispatch modes include emit / serial / parallel / waterfall | `cordis_inspect_query` `Event.listEvents` (host) |
| Sample fixture for "many sessions in one workspace": `D:\05_Code\solo-bench` has a session folder, `D:\05_Code\Crisp` has one, etc. A workspace entry can carry multiple `sessionIds` (e.g. `11f246c1-…` lists 6 sessions) | observed `workspace.json` |

### 1.2 Built-in `@deepseek-ai/dsh-session-reference` (the closest existing feature — read this loudly)

- Purpose: "lets a conversation reference other sessions: a host turns a `@label` mention into a
  canonical URI, and the service prepares a bounded, read-only snapshot of each referenced session as
  durable, untrusted background context for the model." Candidate discovery "ranks other sessions by
  working-directory affinity and labels them with their latest titles."
  — `...\node_modules\@deepseek-ai\dsh-session-reference\README.md:10-12`
- Mention syntax `@[label](dsh-session:<base64url-id>)` or bare `dsh-session:` URI; snapshot arrives as
  a second user-role message immediately after the citing message, with a fixed warning forbidding
  instructions/permission claims/tool requests inside it.
  — README.md:30-38
- Boundaries: ≤3 distinct sessions per message (`maxReferences`), auto byte budget
  `max(65536, floor(contextWindow × 4 × referenceContextFraction))` per source, default
  `referenceContextFraction` 0.2; text-only projection; snapshots immutable after capture; no live link,
  fork, subscription or source mutation; no body discovery (titles only).
  — README.md:36-53, `:125-137`; config schema `Config.listConfigs` entry `include:session-reference`
  (`maxReferences` default 3, `candidateLimit` 50, `referenceContextFraction` 0.2)
- It is mounted in this live profile: `Config.listConfigs` returns entry `include:session-reference`
  with `packageDir=…\dsh-session-reference`, and the live service `sessionReferenceResolver` exposes
  `listCandidates`, `prepare`, and the Remote `candidates` method.
- Public reference doc: `https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-reference.md`
  (canonical URIs, `SessionReferenceInput`/`Candidate` types, `capturedThroughSeq`, error codes).

**Implication for Confluence:** the user-facing `@`-mention case is *solved* and should be treated as a
complement, not a competitor. Anything Confluence injects must be distinguishable from a session
reference, and Confluence should not re-implement @-mention candidate discovery by scanning logs.

### 1.3 Built-in `@deepseek-ai/dsh-experimental-session-search` / `@deepseek-ai/dsh-tool-session-query`

- Session search is a bundle of five **read-only global model tools**: `session_search`,
  `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read`; workspace
  authority is conservative — cross-session access requires **exact-string `cwd` equality** between the
  target session and the caller, and a caller without `cwd` sees only itself; search always excludes the
  caller session — `...\dsh-tool-session-query\README.md:10-12`, `:43-57`, `:163-172`.
- It is opt-in and **off by default**: "The bundle ships switched off in Web and Desktop and is hidden
  from the default plugin lists." — `...\dsh-experimental-session-search\README.md:10-12`; enabling path
  is documented at `:28-32`.
- Its patch inserts an isolated group with a lazy `:memory:` SQLite FTS index opened on first search,
  plus the tool row — `...\dsh-experimental-session-search\cordis.patch.yml:1-14`; package manifest
  declares `"listedByDefault": false` and depends on `dsh-session-query-sqlite` +
  `dsh-tool-session-query` — `...\dsh-experimental-session-search\package.json:36-45`.
- The live profile does **not** enable this bundle (not in `desktop\package.json` bundles list
  `:12-22`), but the non-`experimental` `ctx.sessionQuery` + `session-query-sqlite` services *are*
  mounted (service list, `Config.listConfigs` rows `include:session-query-sqlite`). The teammate
  internals research additionally reports that the live host's `sessionQuery.searchSessions` /
  `searchEvents` throw `SESSION_QUERY_SEARCH_DISABLED` because its provider is opened with
  `openAt: 'never'` — the experimental bundle works by mounting its own isolated `:memory:` provider
  (`docs/research/dsh-internals.md` §4.1, line 584). Confluence must therefore not assume full-text
  session search is available in the default profile.
- Public reference: `https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-query.md`
  plus `README.md` for the tools.
- **Honest assessment:** if a user only needs "let the model search previous sessions in this
  workspace", DSH already ships that; the missing part is that it is (a) off by default, (b) manual
  (the model must decide to call a tool), (c) full-text search, not passive awareness, (d) unavailable
  in profiles where the bundle is not enabled.

### 1.4 Built-in `@deepseek-ai/dsh-experimental-liveshare` (adjacent, not offline)

- Shares a Session through "a separate Liveshare server, with verified owner sign-in, viewer controls,
  and bounded execution"; the server's OAuth/database/routing/deployment "are not part of this package";
  owner, viewer and server must use matching protocol versions; the bundle is not selected by shipped
  profiles — `...\dsh-experimental-liveshare\README.md:10-12`, `:30-60`.
- Limitations include server dependency, per-share tiers, viewer confinement, and a list of unresolved
  items — README.md:151-167.

**Implication:** Liveshare proves DSH cares about cross-session sharing, but it is *networked
collaboration between humans*, not local workspace memory; it cannot be a dependency or a template for
Confluence's runtime.

### 1.5 Installed third-party `dsh-context` 0.83.1 (bowenliang123, Apache-2.0)

- What it does: context insight/management — a cross-session **Context Insights page** (KPI bar, 7-day
  token/cost chart, activity heatmap, composition donut, filterable session cards), a per-session
  **Context tab** (stats, token breakdown, timing, current context, trend, browser, events, file
  activity, command executions), a **Fleet tab** (agent network + collaboration timeline + team tasks),
  a right-sidebar panel, and a `/context` command — README.md:15-24, `:52-100`.
- Packaging: plain npm package `dsh-context` 0.83.1, `type: module`, `main: lib/index.js` (built
  bundle), exports `.`/`./client`/`./package.json`/`./locale/*.json`, `dsh.bundle.patch` +
  `dsh.client` (inject list, `platform: "web"`), `engines.dsh: ">=0.2.0-rc.2 || …"`, one runtime dep
  (`zod`), peers on cordis/dsh-session/schemastery/react — `package.json:2-4`, `:16-30`, `:56-99`.
  Bundle patch is a single row insert — `cordis.patch.yml:1-6`. Locale files carry only
  `meta.title`/`meta.description` (UI strings live in the client bundle) — `locale/en.json:1-6`,
  `locale/zh.json:1-6`.
- Data access (all through public services, no direct file reads for session content):
  - `ctx.inject(['sessionQuery','sessionProjectionCache','sessionPersistence','sessions'], …)` for
    overview/heads/facts routes; calls `sessionQuery.listSessions()`, `observeSession()`,
    `sessionProjectionCache.cachedSnapshot()/coldSnapshot()`, `sessionPersistence.open()/stat()`,
    `sessions.get()` — grep tokens in `lib/index.js` (minified single-line bundle: `sessionQuery`,
    `listSessions`, `coldSnapshot`, `sessionPersistence`, `inject([\`sessionQuery\``, …).
  - It also reads DSH's **own projection cache** as a storage domain: `ctx.get('storageDomain')` →
    `get('session_projcache')` → `table('sessions')`, and sweeps rows whose `rows.contextTimeline.ver`
    equals 36 (`lib/index.js` token `session_projcache`, `contextTimeline`).
  - Workspace grouping: `workspaceRegistry.list()` (`lib/index.js` token `workspaceRegistry`).
  - System prompt: registers `dsh-context:prompt-prefix` / `dsh-context:prompt-suffix` sections with
    `interpolate:false` via `ctx.inject(['systemPrompt'], …)` (token `dsh-context:prompt-`).
- HTTP surface: registers POST routes under `/api/dsh-context/*` (`version`, `backfill`, `heads`,
  `facts`, `attachment`, `balance`, `commands`, `fleet`) by calling
  `ctx.get('connection').fetch.register({path, methods:['POST'], requestBody:'buffered', fetch})`;
  helper guards every registration with `e.effect(...)` (`lib/index.js`, tokens
  `/api/dsh-context/` and `requestBody:\`buffered\``).
- Storage of its own derived data: a **plain JSON file**, not a storage domain —
  `$DSH_HOME/storages/dsh-context/overview-cache.v1.json` (falls back to `~/.dsh`); path built in
  `lib/index.js` (tokens `storages`,`dsh-context`,`overview-cache.v1.json`, `DSH_HOME`). Observed file:
  207,379 bytes, `{format:1, savedAt, sessions:[{session:{id,title,updatedAt,blank,signature},
  timeline:{…}}]}`; each `signature` embeds id+updatedAt+source+log path+size and is used to skip
  unchanged sessions. It is a **derived summary cache**, never session content.
- UI: client bundle uses `window.__ModuleLoader__.load({id:'dsh-context', factory(require){…}})` and
  React from the module table; registers `main` page + `sidebar.panellist` (order 20) +
  `sidebar.right.pane.tab`/`.title` + `conversation.view` (`id:'fleet'`, order 30); `/context` is a
  client slash command via `ctx.inject(['inputTriggers'])` →
  `inputTriggers.registerSource({trigger:'/', name:'context', …})`; locale dictionaries are embedded in
  the client bundle and registered with `ctx.locale.register(...)`; navigation uses
  `uiWorkspace.openSession`; client fetches `api/dsh-context/<route>` same-origin with plain `fetch`
  (tokens in `lib/client.js`).
- Token accounting insight: its data model (visible in `lib/index.d.ts:17-137`, `:161-500`) is a
  projection-derived per-session fold (`contextTimeline`, `contextHeaders`, `contextActivity`) with
  hard bounds (`DEFAULT_BOUNDS`, `index.d.ts:491-500`: maxRequestSteps/maxKeptTurns/maxEvents/
  maxNodes/maxArchiveNodes/maxFileOps/maxCommands/maxCommandChars) and a worker-thread fold path for
  large logs. This is the pattern to copy for bounded digests: cache *summaries* per session + a
  signature for invalidation, and re-fold details on demand.
- **Network use (important anti-pattern for Confluence):** dsh-context is *not* fully offline. Its host
  half queries `https://registry.npmjs.org/dsh-context/latest` (and the npmmirror fallback) for the
  version row, fetches `raw.githubusercontent.com/bowenliang123/dsh-context/main/data/recoms.json` (with
  proxy/gh-proxy fallbacks) for its recommendations route, and its `balance` route calls
  `https://api.deepseek.com/user/balance` with a Bearer token (all verified as URL literals in
  `lib/index.js`; the client bundle also references `https://cdn.simpleicons.org/deepseek`). These
  features have fallbacks and degrade, but they prove that an installed, popular ecosystem plugin can
  violate "no network" while remaining accepted. Confluence must not copy this and should be auditable
  for zero network calls.
- **Overlap with Confluence:** it already provides a cross-session overview UI, already reads every
  session's metadata/projections, already has a first-class sidebar entry and a session tab, and already
  owns the "insight" mental model. Confluence adding a *second* cross-session dashboard would compete for
  the same slots and confuse users. **Non-overlap:** it never writes to another session, never injects
  workspace context into a model prompt (its prefix/suffix is static text, not session-derived), never
  shares decisions/state, and has no shared board. It is a read-only mirror, not a bridge.
- **Conflicts to watch:** both plugins would open `session_projcache` rows and call heavy
  `coldSnapshot`/`listSessions` sweeps; both would badge the same sidebar area; both add startup work.
  A Confluence implementation should not touch `session_projcache` rows at all (read-only at most) and
  should not duplicate the Insights page.

### 1.6 Installed third-party `dsh-better-sidebar` 0.31.1 (MIT)

- Scope: "A dual workbench for DSH: native right sidebar + self-drawn bottom panel, with the
  `ctx.betterSidebar` service open to every plugin" — files/git/editor/previews/tasks/side-chat/terminal
  — README.md:3-29.
- Packaging: single npm package with host + client halves (`main: lib/index.js`, `./client`,
  `./client/service`, `./client/api` all point at built client code), `dsh.bundle.patch`,
  `dsh.client.inject` (locale/slots/conversation/sidebar-right/modules), `manifestVersion:1`,
  MIT license, peer deps pinned to `^0.2.2-rc.1` — `package.json:2-4`, `:13-55`, `:56-105`,
  `:217-232`.
- Host half: a `/sidebar` JSON API plus media/HTML/bundle routes and three WebSocket upgrades, all
  **conversation-scoped** ("requests carry a sessionId and the session's authoritative cwd comes from
  the session store"); routes are registered with `ctx.webServer.register(...)` and
  `ctx.webServer.registerUpgrade(...)` and delegate admission to the same `connection` fence as `/api`
  — `src/index.ts:1-12`, route registrations at `:1630-1921`, upgrade registrations at `:1980-2034`.
- Cold reads: `sessionPersistence.open(id, 'read')` "never takes write ownership (so it works while the
  session is live in another process)", then `handle.read()` and `handle.close()` — `src/session-store.ts:1-43`.
  This is the closest verified pattern for reading another live session's log safely.
- Cross-session behaviour that exists: none of it is cross-session sharing. It renders *this*
  conversation's sidebar, this session's subagent topology/tasks, and side chats (which inherit the
  parent context and can be promoted to a top-level session) — README.md:26-27, `:228`. Its Teams board
  reads the Lead Session's `agentTeam` projection (a session-tree board), and writes tasks through
  `ctx.agentTeams` — `src/team-routes.ts:1-25`, `src/client/team-projection.ts:1-30`; that is
  intra-family coordination, not workspace-wide memory.
- Extension mechanism: `ctx.provide('betterSidebar', service)` with `registerTab`,
  `registerFileViewer`, `registerFileIcon`, `registerFileAction`, `registerTabAction`; docs
  `docs/external-plugin-guide.md`; 30+ ecosystem plugins listed — README.md:117-129.
- Packaging/ops lessons: exact-version pinning to a host line, a `!!js` double-mount guard in the bundle
  patch so an aggregate bundle that also mounts the package backs this row off — `cordis.patch.yml:1-40`;
  `scripts/check-profile-host-tree.mjs` + install scripts to diagnose profile/host tree mismatches;
  the FAQ documents a real failure mode where profile-local `@deepseek-ai/dsh-*` copies break a plugin
  host-side — README.md:85-99.
- **Overlap with Confluence:** it occupies the right sidebar, the bottom panel, the Tasks page and the
  Side card settings section; any Confluence panel placed there competes for space. Its
  `ctx.betterSidebar.registerTab` is the *integration path* to prefer when it is present (a
  "Confluence" tab rather than a new sidebar), and its per-session scope shows why a workspace-scoped
  panel must be explicit about scope (it is not "another per-conversation tab").

### 1.7 Installed third-party `dshmarket` 1.73.17 (brief)

- It is the in-app plugin market and also publishes a plugin-market index format (README.md:12-14);
  install paths: app UI, `dsh plugin --profile <name> add dshmarket`, GitHub/tarball installs
  (README.md:20-46); host requirements are versioned; it writes hot-disable rows into the profile's
  `cordis.patch.yml` via the official patch layer (README.md:83) and stores its own state in the
  profile (`state.json`, README.md:73-75).
- **Conventions to copy for Confluence's published form:** bundle declared via `dsh.bundle.patch`;
  host-aware compatibility via `engines.dsh` or lockstep `@deepseek-ai/dsh-*` peers; prebuilt artifacts
  for no-build installs; local state under the profile, not under the package; one `package.json` for
  host + client halves. Desktop caveat: installing with `dsh plugin --profile web …` lands in
  `profiles/web`, not the Desktop profile (README.md:43-46).
- `HYPOTHESIS:` dshmarket's catalog/registry does not validate arbitrary local directory installs; a
  Confluence GitHub repo without npm publish must be installed from a local checkout or tarball
  (verify in round 2 packaging).

### 1.8 Local precedent: `@local/crisp-quality-gate` (the layout/licensing/docs template to follow)

Repo: `D:\05_Code\Crisp\integrations\dsh-plugin-crisp` (linked into the desktop profile as
`"@local/crisp-quality-gate": "link:D:/05_Code/Crisp/integrations/dsh-plugin-crisp"` —
`desktop\package.json:5`).

- **Bundle structure (flat, no build):** plain ESM `package.json` (`private:true`, `type:"module"`,
  `main:"./index.js"`, exports `.`/`./client`/`./locale/*.json`/`./icon`, `files` list, `engines`,
  `scripts.test = node --test "test/*.test.js"`, `license: MIT`, `dsh.bundle.patch`, `dsh.client`
  `{platform:"web", immediately:true, inject:[ui-sidebar, ui-layout]}`) — `package.json:1-48`.
  Bundle patch inserts the single row with default config — `cordis.patch.yml:1-46`.
  Locale files only carry `meta.title`/`meta.description` — `locale/en.json:1-6` (+ zh).
- **Host + client split:** `index.js` exports `apply(ctx, config)` (`name`, no static DSH imports; a
  test-visible `applyWithDeps` seam); registers `llm/stream`, `session/event`, `session/disposed` and
  the status route; every registration is wrapped in `ctx.effect`; optional services are resolved with
  `ctx.get(...)` and degrade — `index.js:14-119`.
- **Status route/panel pattern (directly reusable):** `GET /crisp/status` served by
  `ctx.get('webServer').register({kind:'exact', path, handler})` only when `webServer` exists; handler
  checks `ctx.get('connection').requestRejection(req)` (Host/Origin/session-cookie fence), returns
  `cache-control: no-store`, supports GET/HEAD, bounded 1.5 MB tail read of its own JSONL log, never
  returns answer text or credentials — `lib/status.js:19`, `:98-128`, `:281-338`; docs
  `docs/integrations/deepseek-harness.md:502-527`. Client half is a plain
  `window.__ModuleLoader__.load({id, factory(require){…}})` module with no Harness client imports;
  registers a `sidebar.panellist` entry (order 2) and a keyed `main` page, `ctx.locale.register`,
  `ctx.layout.selectPanel(null)` to go back, `--dsw-alias-*` tokens only, 5 s visible-tab polling —
  `client.js:10-12`, `:515-548`, `:228-270`.
- **Test style:** hermetic `node:test` tests (109 tests per docs) including a contract test that asserts
  manifest shape, display resources/files coverage, one uniquely-named patch row, locale metadata in
  both languages, SVG validity/limits, `apply` export form, and **no static `@deepseek-ai/*` imports**
  in runtime files — `test/contract.test.js:11-120`.
- **Offline install precedent:** the integration doc records `install_bundle` as the documented path
  (framed as "not executed here", `docs/integrations/deepseek-harness.md:198-215`), a scratch-profile CLI
  path that *was* executed (`:217-263`), and the real desktop-profile link install (`:265+`). It also
  documents verification, E2E harness, and an explicit "what remains unverified" table
  (`:772-783`) plus limitation notes (`:787-833`). This is the evidence standard Confluence should
  match.
- **What NOT to copy:** Crisp's runtime spawns an external Go binary and can call an external HTTP
  critic — both violate Confluence's fully-offline, no-child-process constraint. Only its structure,
  split, fence, tests and docs are precedent.

### 1.9 Local repo and target GitHub repo status

- Local `D:\05_Code\Confluence`: git initialized, branch `main`, `origin` =
  `https://github.com/XiaoleC05/Confluence.git`, **no commits yet**, only file is
  `docs/planning/team-brief.md` (`git status`, `git log` in the repo).
- Remote exists: `GET https://api.github.com/repos/XiaoleC05/Confluence` → `public:true`,
  `created_at:2026-11-12T17:50:06Z`, `default_branch:"main"`, `size:0`, `description:null`,
  `license:null`, `stargazers_count:0`, `has_issues:true`. `branches` → `[]`; `releases` → `[]`;
  `commits` → HTTP 409 `"Git Repository is empty."`; `contents/` → HTTP 404 `"This repository is
  empty."` (queries executed 2026-11-13). **Report: the repo exists but contains nothing yet.**
- Ecosystem context (GitHub API): `bowenliang123/dsh-context` — Apache-2.0, TypeScript, ~5,009 stars,
  default branch `main`; `omdsh-dev/DSH-better-sidebar` — MIT, ~5,116 stars, ~486 forks, default branch
  `main`; `deepseek-ai/deepseek-harness` — MIT, default branch `master`. (Counts observed at query
  time and may move.)

---

## 2. Design/analysis

### 2.1 How to read session/workspace data (pattern, not code)

| Need | Verified source | Notes |
|---|---|---|
| Enumerate sessions | `ctx.sessionQuery.listSessions(signal)` / `filterSessions(filters)` with `{kind:'cwd'}` | Live-preferred corpus; `SessionRecord.header.cwd`; exact-string cwd authority (tool-session-query README:171) |
| Titles for labels | `ctx.sessionQuery.readTitle(sessionId)`, `readTitleSnapshots([...])` | Cheap, projection cache backed; the resolver labels with latest title (session-reference README:42-53) |
| Read *current* model-visible content of another session | `ctx.sessionQuery.readSurface(sessionId)` returns `SessionSurfaceSnapshot{events,session,capturedThroughSeq}` | Same primitive session-reference uses; text-only projection |
| Read a complete cold log | `ctx.sessionPersistence.open(id, 'read')` → `handle.read()` → `handle.close()` | Never takes write ownership; works while live elsewhere (better-sidebar `session-store.ts:1-43`) |
| Read from a live session | `ctx.sessions.get(id)` / `ctx.sessionQuery.observeSession(id)` | Live-preferred; choose explicitly |
| Group by durable workspace | `ctx.workspaceRegistry.list()` → `{id,path,title,sessionIds[]}`; `resolveByPath(path)` | Observed shape in `workspace.json`; avoids inventing a grouping |
| Register derived per-session state | `ctx.sessionProjections.register(...)` with `SessionProjectionMap` augmentation | dsh-context declares 3 projections (`index.d.ts:126-137`); `apply(state,event)` pure; wire to client via `wire.view` |
| Persist plugin-own data | `ctx.storageDomain.open(defineDomain(...))`, tables get/put/update/delete, `domain/changed` event | Versioned/typed and runtime-resolved; **but** `storage-json` has no cross-process write lock and `domain/changed` is in-process only (`docs/research/dsh-internals.md` §3.3, lines 523-544). Use it as the derived index/config store; use `dsh-atomic-write`'s `writeFileAtomic`/`withFileLock` for the authoritative append log when several app instances can write |
| Per-workspace keying | canonical path. Target plugins use exact-string `cwd` equality; `dsh-util-workspace-path` exists in the installation (dsh package.json:321) | Windows case/`\`/symlink normalization is unsolved in first-party code; Confluence must define it explicitly |
| Discover "who else is in this workspace" cheaply | `ctx.workspaceRegistry.list()` + live `ctx.sessions.list()`/`api-session/*` events | Workspace registry is durable and already lists session ids |

**Token accounting lesson:** dsh-context shows both directions — passive sums derived from projections
(`contextTimeline`) and a hard-bounded per-request detail model with default caps. Confluence's passive
digest should borrow the *bounds discipline* (`<= 400–800` tokens per the team brief; per-item caps;
dedupe by watermark) but must not read or re-implement the full token breakdown.

**Bounded-injection lesson:** session-reference proves the shape of safe cross-session context: a
bounded, immutable snapshot, a fixed untrusted warning, per-source byte budget, labels from titles, and
a durable source record (`capturedThroughSeq`) so replay is stable. Confluence's digest should adopt
those four properties even though it is a different mechanism (aggregate vs single reference).

### 2.2 Overlap / conflict matrix

| Capability | session-reference | session-search bundle | dsh-context | better-sidebar | Confluence (proposed) |
|---|---|---|---|---|---|
| Cross-session awareness | user-triggered `@` mention, per message | model-triggered read-only tools (off by default) | dashboard insight across sessions | none (per-conversation) | **automatic workspace digest + live events** |
| Writes information into a session | snapshot message, user-initiated | tool results, model-initiated | none (only static prompt prefix/suffix) | none | passive context + explicit tool + optional user op |
| Shared durable artifact between sessions | no (snapshots only) | no | no | session-tree tasks only | **yes: workspace board** |
| Live notification | no | no | no (poll/read) | pushes within one session's UI | **yes (proposed)** |
| Offline, no server | yes | yes | yes | yes | must be |
| UI surface | composer mention | none | Insights page, Context tab, Fleet tab, sidebar panel | right sidebar, bottom panel, Tasks page | optional panel; prefer host slots / betterSidebar tab |
| Storage | writes into target log (context messages) | none (in-memory FTS index) | `$DSH_HOME/storages/dsh-context/overview-cache.v1.json` + reads `session_projcache` | profile settings + localStorage per session | own storage domain |
| Existing conflict risk | Confluence digest could duplicate/overlap semantics — distinguish wording and mark provenance | enabling it competes for "prior session" mental model — don't require it | UI competition + heavy `listSessions`/cache sweeps | sidebar real estate; integrate via `registerTab` when present | — |

### 2.3 Patterns worth copying (concrete, no code copied)

1. **Bundle shape** (Crisp + dsh-context): one `package.json` declaring `dsh.bundle.patch` +
   `dsh.client`; `index.js` ESM with `apply(ctx, config)` and optional `applyWithDeps`; locale JSON with
   `meta.title/description`; original `icon.svg`; no build step for v1.
2. **Optional-service discipline** (Crisp `index.js:41-64`, better-sidebar `ctx.get(...)` usage): resolve
   `connection`, `webServer`, `sessionProjections`, `agentTeam` lazily; degrade structurally when absent.
3. **Connection fence for read-only routes** (Crisp `lib/status.js:290-305`): same-origin route on the
   existing `webServer`, `requestRejection` check, `no-store`, no secrets/content beyond what the page
   needs. No extra port, no second server.
4. **Cache by signature** (dsh-context `overview-cache` + `signature`): derive a compact per-session
   summary; invalidate by a signature composed of id + updatedAt + log size/mtime; never store content.
5. **Cold/live read split** (better-sidebar `session-store.ts`): read through
   `sessionPersistence.open(id,'read')` for cold sessions, `sessionQuery.observeSession` for live ones.
6. **Workspace grouping from the registry** (observed `workspace.json`): use
   `workspaceRegistry.list()`/`resolveByPath()` instead of re-deriving grouping from logs.
7. **UI integration ladder:** (a) no UI in v1; (b) `/confluence` slash command via client
   `inputTriggers` (dsh-context pattern); (c) `sidebar.panellist` + `main` page (Crisp pattern);
   (d) `ctx.betterSidebar.registerTab` when better-sidebar is mounted (its documented extension point);
   (e) never a second app root or iframe (per `practices.md`/`ui-plugin.md`).
8. **Version/peer declaration** (dsh-better-sidebar `package.json:77-105`): declare the host line
   explicitly; pin in docs; do not assume a 0.x range spans host minors.
9. **Docs/tests discipline** (Crisp `test/contract.test.js`, `docs/integrations/deepseek-harness.md`):
   contract tests for manifest/patch/locale/icon/no-static-DSH-imports; a verification doc with
   "what remains unverified".
10. **Per-workspace panel must state its scope** (lesson from better-sidebar being per-conversation):
    a workspace-global panel inside a per-conversation sidebar needs a scope row (workspace path,
    session count) or users will read it as this-conversation data.

---

## 3. Gap analysis

### 3.1 The pain point, restated precisely

Two sessions in the same workspace (same effective cwd) start with **no knowledge of each other**.
A user must manually ask one session to write a file and the other to read it, or `@`-mention one from
the other, or ask the model to search prior sessions. There is no first-class, mostly-automatic,
workspace-scoped shared space; no passive awareness ("another session already decided X / is editing
Y / hit warning Z"); no durable shared board with typed entries and watermarks; and no live cross-session
notification. This is exactly what the team brief calls the mission
(`docs/planning/team-brief.md:6-25`).

### 3.2 What existing tools cover (honestly)

| User need | Covered today? | By what | Manual? |
|---|---|---|---|
| Pull another session's context into this conversation | **Yes** | `dsh-session-reference` `@`-mention snapshot | user must know the session and type a mention |
| Find earlier work in this workspace | **Yes, if enabled** | `dsh-experimental-session-search` tools (`session_search`, …) | model must decide to search; bundle off by default |
| See what sessions exist / token usage / file activity | **Yes** | `dsh-context` insights + tabs | user opens the dashboard |
| Per-session files/git/terminal/side chat/task topology | **Yes** | `dsh-better-sidebar` | per-conversation UI |
| Share a session with another person remotely | **Yes, but networked** | `dsh-experimental-liveshare` (needs server + sign-in) | out of scope offline |
| **Automatic workspace digest in every new session** | **No** | — | — |
| **Durable shared board scoped to workspace with watermarks** | **No** (session-reference snapshots are not a board; agentTeam tasks are a session-family board) | — | — |
| **Live "other session did X" awareness** | **No** | — | — |
| **Cross-session handoff / work queue** | **No** | — | — |
| **Safe, redacted, budgeted, user-controllable sharing defaults** | **No** | — | — |

### 3.3 Concrete differentiators Confluence should own

1. **Passive, bounded workspace digest** injected into every session (or on demand), derived from the
   workspace's sessions, deterministic, ≤ 400–800 tokens by default, with de-duplication via watermarks,
   and provenance labels (which session/time). This is the thing no installed component does.
2. **Durable workspace board** with typed items (decision / finding / change / warning / handoff),
   explicit provenance and status, workspace-scoped by canonical path, stored in a versioned DSH storage
   domain and surviving restarts. Snapshot-based session-reference cannot do this; dsh-context does not
   persist user-level shared state.
3. **Live same-workspace signal**, not polling: durable outcomes (`turn/end`, `assistant/message`,
   `tool/result`, `domain/changed`) feed board updates and an optional injection queue.
4. **Safety defaults:** untrusted-background framing (copy session-reference's warning idea), redaction
   rules, per-item and per-injection budgets, user-visible toggles, never auto-exfiltrate, no network.
5. **Explicit user/tool surface for deliberate sharing** (a tool like `confluence_share` / a capture
   command) so the model can publish when the user wants, with the same storage path as passive items.
6. **Honest non-goals:** do not re-implement `@`-mention snapshots, session FTS search, transcript
   dashboards, or remote sharing. Integrate: label digest items with source session ids so a host could
   later offer "open source session" via `uiWorkspace.openSession`; use `sessionQuery` rather than
   parsing zstd logs; if session-search is mounted, delegate "search deep history" to it.

---

## 4. Open questions / risks

- `HYPOTHESIS:` `session-reference` is enabled by default in the Web/Desktop presets (the live composer
  has its `include:session-reference` config row; the landing page markets "@ files or sessions"), so a
  Confluence digest would coexist with it and must be clearly distinguished in wording. Re-verify on a
  clean profile in round 2.
- `HYPOTHESIS:` client-side inspection was unavailable during this research
  (`Slots.listSubTree` timed out after 10 s: "Open or reconnect the Harness page"). Slot names used in
  this doc (`main`, `sidebar.panellist`, `sidebar.right.pane.tab`, `conversation.view`,
  `inputTriggers`) are verified from installed plugin bundles, not from a live slot query — re-verify
  with `cordis_inspect_query` before implementing UI.
- **Resolved by the internals research (see `docs/research/dsh-internals.md` §3.3):** cross-process
  storage safety is *not* automatic. `storage-json` rewrites the whole unit file, has **no cross-process
  write lock** (last-completion wins), and `domain/changed` is in-process only; a second process's
  domain handle keeps its own in-memory snapshot until reopened. DSH ships the correct primitives —
  `writeFileAtomic` and cross-process `withFileLock` (lock sibling, holder PID, dead-process takeover) in
  `dsh-atomic-write`. Confluence's design must therefore make the authoritative board **append-only with
  idempotent items** so lost-update races are benign, and put every mutation behind `withFileLock` when
  more than one app instance can write. Remaining unknown: the exact number of Host processes per app
  instance (internals doc marks multi-window topology as `HYPOTHESIS:`); design for the worst case.
- `HYPOTHESIS:` `dsh-context`'s raw-file cache uses `DSH_HOME` from `process.env` with a `~/.dsh`
  fallback; with a non-default profile/home the fallback may write to the wrong home. Confluence should
  prefer the storage-domain service, which is resolved by the runtime, rather than re-deriving paths.
- `HYPOTHESIS:` exact-string cwd equality (first-party choice) will under-share for Windows users who
  open the same workspace via different path spellings/case/symlinks. Confluence needs a documented
  canonicalization rule; first-party code deliberately leaves this open (tool-session-query
  README:182-185 dev note).
- `HYPOTHESIS:` reading `sessionSurface` of another session for a digest has token/time costs that
  appear only on real long sessions; dsh-context's worker-fold and bounded caches are evidence this is
  non-trivial. Plan a bounded, async, cached derivation rather than synchronous prompt-time reads.
- Risk: **duplication/confusion** — three products (session-reference, session-search, Confluence) offer
  "other sessions' info". The README and prompt text must teach the difference; otherwise users will
  expect search to find the board or the board to be exhaustive.
- Risk: **privacy** — workspace sessions may contain credentials/PII (session logs in this profile include
  a config comment about a local API key, and agents can read local secret files). Any passive digest
  must default to low-risk item types, require explicit publish for content-bearing items, redact
  patterns, and stay local.
- Risk: **UI real estate** — dsh-context and better-sidebar already occupy the sidebar/tabs; a new
  first-class page needs a clear reason and should be optional/off by default (or a `/` command first).
- Risk: **host-version drift** — both installed third-party plugins pin exact host lines and document
  breakage when profile-local `@deepseek-ai/dsh-*` copies shadow the installation (better-sidebar
  README:85-99). Confluence must declare `engines.dsh`/peers and test against 0.2.2-rc.1 only.
- Risk: **fabricated prior art** — dsh-context's README claims, marketplace listings and `dshmarket`
  behavior were not independently validated beyond the installed code/docs; treat vendor claims in this
  doc as claims, not verified runtime behavior.

---

## 5. Recommendation (for the architects)

**Do not duplicate; own the passive + durable layer.**

1. **Position Confluence as the workspace's shared memory/board layer**, complementing DSH's existing
   manual mechanisms: `@`-mention session references (pull), session-search tools (search), dsh-context
   (insight), better-sidebar (per-session workbench). State this explicitly in the README and in the
   model-facing prompt text.
2. **Build the repo exactly like Crisp, not like dsh-context's TS build**: flat plain-ESM bundle,
   `index.js`/`client.js`/`lib/*.js`, `cordis.patch.yml`, `locale/{en,zh}.json`, `icon.svg`,
   `node:test` contract+unit tests, `docs/` including an integration/verification doc and a
   "what remains unverified" table. Install path for users: local directory link / tarball, documented
   and offline (the Crisp doc records the scratch-profile CLI path that was actually executed).
3. **Data plan:** an append-only, lock-protected board as the authoritative record (use
   `dsh-atomic-write`'s `withFileLock`/`writeFileAtomic`, which ship with DSH — see teammate
   `docs/research/dsh-internals.md` §3.3) plus a versioned storage domain for derived index/watermarks;
   derive per-session summaries from `sessionQuery`/projections; read with
   `sessionQuery.listSessions`/`readTitle`/`readSurface` and
   `sessionPersistence.open(id,'read')` for cold logs; **never** parse `.jsonl.zstd` directly; **never**
   mutate `session_projcache` rows.
4. **Injection plan:** a bounded, byte-deterministic workspace digest through
   `systemPrompt.context` (identical text is not re-committed by the host) or `agent.inject()` for
   event-driven updates, with watermark de-duplication, untrusted framing, provenance labels,
   ≤ 400–800 tokens.
5. **UI plan:** v1 no UI (prompt + tool + docs only); v2 optional `/confluence` command via client
   `inputTriggers`; v3 optional `main`+`sidebar.panellist` panel or `betterSidebar.registerTab` when
   present; any data route on the existing `webServer` with the `connection.requestRejection` fence —
   never a second server/port.
6. **Differentiate in one sentence:** "DSH lets you *ask* another session or *search* old ones;
   Confluence makes the workspace *remember together* by default."
