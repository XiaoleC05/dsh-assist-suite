# Confluence / 高级记忆 — Team brief (Round 1)

Status: shared bootstrap note for all teammates. Maintained by the Lead. Do not edit;
if a fact here is wrong, report it to the Lead instead of silently diverging.

## 1. Mission (what the user asked for)

Design a DeepSeek Harness (DSH) plugin that removes a real pain point: **sessions in the
same workspace cannot share information**. Today the only workaround is to ask an agent
explicitly to write/read documents or files. The plugin ("Confluence", Chinese name
"高级记忆") must make workspace-scoped cross-session information sharing a first-class,
mostly-automatic capability.

User requirements:

1. Research first; then multiple sub-agents discuss; then decide an execution plan; then
   produce the complete design. **This phase is design + a project-shaped repository**,
   not a production implementation. Do not install anything into the DSH profile.
2. The plugin must be a **complete project**: English name **Confluence**, Chinese name
   **高级记忆**, documentation, GitHub repository `https://github.com/XiaoleC05/Confluence.git`.
3. **Fully offline, no server**: no network calls at runtime, no extra listening port, no
   external service/database. It may only use what DSH itself provides locally.
4. The plugin will **later be merged into `D:\05_Code\solo-bench`** (a personal offline Go
   workbench skeleton). The design must include a concrete, low-risk merge path, but we
   must NOT modify solo-bench in this phase.

Local repo already exists at `D:\05_Code\Confluence` (git initialized, branch `main`,
remote `origin` set to the GitHub URL). GitHub push is currently not possible from this
machine (connection reset, no credentials); that is expected and fine — local commits only.

## 2. Environment facts (verified)

- DSH Desktop runtime version: **0.2.2-rc.1**. Implementation checkout:
  `C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\`.
- Profile: `desktop`; `DSH_PROFILE_DIR=C:\Users\71408\.dsh\profiles\desktop`.
- Profile already installs third-party plugins (`dsh-context` 0.83.1,
  `dsh-better-sidebar` 0.31.1, `dshmarket`, `@local/crisp-quality-gate` linked from
  `D:\05_Code\Crisp\integrations\dsh-plugin-crisp`). These are the closest prior art.
- Persistent storage areas: `C:\Users\71408\.dsh\storages\` (e.g. `dsh-context`,
  `session_projcache`, `workspace.json`). Session logs:
  `C:\Users\71408\.dsh\sessions\<encoded-cwd>\<session-id>\session.v4.jsonl.zstd`
  (one folder per workspace cwd).
- **File-reading rule:** the DSH installation lives inside Electron's `app.asar`. The
  `read` tool (Host-side) CAN read `...\app.asar\dsh\...` files; shell commands, `glob`
  and `grep` (native processes) CANNOT. Use `read` / `grep` only on normal paths, and
  `read` for app.asar. Alternatively query live APIs with `cordis_inspect_query`.
- Live API discovery: `cordis_inspect_list` then `cordis_inspect_query`
  (`platform: host|client`, provider `Service|Event|Config|Tool|Slots|Theme`).
  `Config.listConfigs` returns live entries incl. package name; querying an `entry`
  returns its `packageDir` (where `README.md`, `lib/index.js`, `lib/**/*.d.ts` live).
- DSH plugin-development skill references (readable with `read`):
  `C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\references\host-plugin.md`
  plus `ui-plugin.md`, `practices.md`, `user-actions.md`, `verification.md` in the same
  folder. Also load the `cordis-plugin-development` skill (and `agent-experience` when
  designing tool definitions). Bundle/patch dialect: `cordis-composition-reference` skill.

## 3. Verified DSH host APIs relevant to this plugin

Via `cordis_inspect_query` on this live profile (re-verify anything you rely on):

- `ctx.tools.register(definition: ToolDefinition, options?)` — global or per-agent-scope
  tools. `ToolDefinition` = `{ name, description, parameters (JSON Schema), output:
  { schema, render(args, value) }, execute(args, exec), timeoutMs?, presentCall?,
  presentResult? }`; `execute` receives `ToolRunContext` with `agent?`, `callId`,
  `signal`, `deferContext()`, `concludeTurn()`. Tool results are JSON values rendered by
  `output.render`.
- `ctx.systemPrompt.section(section)` / `.context(context)` — global prompt text or
  dynamic runtime context; `PromptContext.text` may be a **synchronous** function of
  `AssembleContext = { scope?: ScopeKey, signal?: AbortSignal }` (scope is the agent's
  scope object). `ctx.systemPrompt.tools(provider)` adds schema-only declarations.
  `ctx.systemPrompt.variable(name, provider)`.
- `ctx.storageDomain.open(defineDomain(spec))` → `Domain` with `global` (`get/set`) and
  `table(name)` (`get/entries/keys/size/put/delete/deleteMany/update`); persisted per
  profile under `.dsh/storages/<domain-name>/` through the `storage-json` backend.
  `DomainSpec = { name, version, layout?, compatibleVersions?, invalidRecords?, global?,
  tables: { [name]: { valueSchema: ZodType } } }`. Zod is available to plugins.
- `ctx.workingDirectory` — `defaultDirectory`, `get(session)`, `ensure(agent)`,
  `set(agent, path)`; one owner of each Session's effective directory.
- `ctx.workspaceRegistry` — durable workspaces: `list()`, `get(id)`, `create(path)`,
  `resolveByPath(path)`, session pin/archive helpers. Events: `workspace/...`.
- `ctx.sessions` — in-memory session store: `get(id)`, `list()`, `create`, `enter`,
  `announce`, `flush`, `fork`.
- `ctx.agents` — live agents: `list()`, `roots()`, `get(id)`, `currentInitiator()`,
  plus per-agent helpers in other packages (inject/followup live on the real Agent object;
  confirm exact shape in `@deepseek-ai/dsh-agent`).
- `ctx.sessionQuery` — cross-session search/read: `searchSessions(request)`,
  `searchEvents(request)`, `listSessions()`, `readSession(id)`, `readEvent`, etc. Backed
  by `@deepseek-ai/dsh-session-query-sqlite`; installed in this profile.
- Events (host): `session/created`, `session/event`, `session/disposed`,
  `agent/created`, `agent/disposed`, `agent/status`, `api-session/added|removed|status`,
  `tools/*`, `system-prompt/change|assemble`, `domain/changed`, `workspace/*`.
  Modes: emit/serial/parallel/waterfall — read exact signatures via `Event.listEvents`.
- `ctx.commands.register(...)` — human `/command` registry (optional UI).
- Client side: slots (`ctx.slots.inject/register`), theme tokens `--dsw-alias-*`, locale
  JSON `locale/en.json` + `locale/zh.json` with `meta.title`/`meta.description`, icon
  `icon.svg`; client module declared in `package.json` `dsh.client` and implemented as a
  plain-JS module (no React imports from host packages; may use React provided by the
  client runner — confirm with `ui-plugin.md` and the Crisp plugin example).
- Host plugin package form: ESM `index.js` exporting `apply(ctx, config)` (and optional
  `inject`, `Config`), or a Service class default export; `package.json` declares
  `dsh.bundle.patch` pointing at `cordis.patch.yml`; bundle installed into a profile only
  via Plugin Manager `install_bundle` (NOT in this phase).
- There is built-in prior art for parts of the problem: `@deepseek-ai/dsh-session-reference`
  ("exact-read consumer that prepares immutable cross-session message context"),
  `dsh-tool-session-query`, `dsh-experimental-liveshare`, and an installed `dsh-context`
  plugin (context insight dashboard). Understand exactly what already exists so the design
  does not duplicate or conflict.

## 4. Repository layout (shared write areas)

```
D:\05_Code\Confluence\
  docs\planning\team-brief.md         (Lead; read-only for teammates)
  docs\research\dsh-internals.md      (dsh-researcher)
  docs\research\prior-art.md          (pattern-researcher)
  docs\research\external-patterns.md  (pattern-researcher)
  docs\design\options\option-a.md     (architect-a)
  docs\design\options\option-b.md     (architect-b)
  docs\discussion\*                   (Lead; critiques later by architects)
  docs\design\*                       (round 2, assigned by Lead)
  docs\adr\* , docs\plan\*            (Lead)
  README*.md, package.json, cordis.patch.yml, locale/, icon.svg, LICENSE,
  src/, test/                          (packaging round 2, packaging teammate)
```

Only write files inside your own assigned scope. Never edit another teammate's file;
send the Lead a message instead. All docs are Markdown, English by default (Chinese
allowed for concept/user-facing naming debate), with this shape:

1. `# Title` + one-paragraph executive summary (what decision/useful fact, for the Lead)
2. `## Verified facts` — each with evidence (API signature from cordis_inspect_query,
   file path:line, or URL)
3. `## Design/analysis`
4. `## Open questions / risks` — explicitly mark unverified claims `HYPOTHESIS:`.
5. `## Recommendation` (for architects) with decision criteria.

No fabricated APIs, package names, versions, benchmarks or URLs. If you could not verify,
say so. Cite line numbers for files in the DSH installation or installed plugin dirs.

## 5. Hard design constraints to respect

- Offline: no `fetch`, no network, no child process pulling data, no extra port. Only local
  file/SQLite/DSH storage. Optional UI must work through DSH's existing web server.
- Workspace scoping: sessions are grouped by effective working directory; two sessions of
  the same workspace must see the same shared space; different workspaces must be isolated
  by default. Consider symlinks/case/relative paths on Windows; decide a canonical key.
- Multi-window/multi-process safety: several DSH windows can be open; storage may be
  written concurrently. Decide transaction/concurrency model.
- Privacy/safety: session contents may contain secrets; design explicit budgets,
  redaction, user-visible controls, and never auto-exfiltrate outside the machine.
- Upgrade stability: unknown event types, older readers, tolerant parsing, versioned
  domain schema (DomainSpec.version/compatibleVersions), graceful degradation if optional
  services are absent (`inject` optional deps).
- Token economics: passive context must be bounded (e.g. <= 400–800 tokens default),
  deterministic, and avoid repeated identical injections. Session log remains source of
  truth; plugin state is a derived cache.
- No plugin-manager/profile changes in this phase; the deliverable is source + docs.

## 6. Round-1 roles

- `dsh-researcher`: DSH internals and exact API contracts; write `docs/research/dsh-internals.md`.
  Answer the question list the Lead sends. Ground every claim in the installed version.
- `pattern-researcher`: prior art (installed plugins + public web; GitHub repo status for
  XiaoleC05/Confluence) and cross-session/agent memory patterns; write
  `docs/research/prior-art.md` and `docs/research/external-patterns.md`.
- `architect-a`: propose **Option A** (incremental, host-first shared board + passive
  digest) in `docs/design/options/option-a.md`; make it concrete enough to build.
- `architect-b`: propose **Option B** (deeper, retroactive/continuous indexing of all
  same-workspace session logs + live subscription + file mirror) in
  `docs/design/options/option-b.md`; make it concrete, and include a section that
  critiques Option A's likely failure modes.

Round 2 (after Lead collects round 1): architects exchange docs, write cross-critiques
(`docs/discussion/critique-a.md`, `critique-b.md`), then the Lead decides and assigns the
final design sections; a packaging teammate turns the design into the real repo skeleton
(README EN/ZH, package.json, patch, locale, icon, LICENSE, docs); a reviewer verifies.

Report back to the Lead with: files written, headline recommendation, biggest unknowns,
and anything that blocks you. Keep messages short; the Lead reads them and the docs.
