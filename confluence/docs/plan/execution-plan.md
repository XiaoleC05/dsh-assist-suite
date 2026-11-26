# Confluence / 高级记忆 — execution plan (M0 → M4, v2 gate)

Status: **execution plan for the accepted architecture** in
[ADR 0001](../adr/0001-confluence-architecture.md). Still the design-only phase: nothing is installed
into a real DSH profile, `solo-bench` and `Crisp` are untouched, and dates are working-day targets
starting **after design sign-off (planned 2026-11-13)**.

Companions: [M0 spike specs](m0-spikes.md), [testing strategy](../design/testing.md) (test IDs used
below), [solo-bench integration](../design/solo-bench-integration.md) and
[ADR 0006](../adr/0006-solo-bench-integration.md) (later merge); round-3 design set in `docs/design/`
(`architecture.md`, `store-format.md`, `pulse.md`, `tool-api.md`, `config.md`, plus surface docs).

Conventions: `HYPOTHESIS:` marks anything not source- or runtime-verified; 1 ed ≈ 6 focused hours and
includes that WP's tests. Test IDs (`UT-*`, `IT-*`, `E2E-*`, `CON-*`, `SEC-*`, `PERF-*`, `ISO-*`,
`UI-*`, `EXP-*`, `GOCON-*`) are defined in [testing.md](../design/testing.md); §13 maps ADR → tests.

---

## 1. How to use this plan

1. **M0 is a blocking gate.** No M1 code beyond the existing scaffold lands until every blocking
   spike in §4 passes or its fallback is accepted in writing by the Lead (decision log entry).
2. **Milestones are review gates, not dates.** A milestone is complete when its exit criteria and
   the definition of done (§11) are evidenced; dates are forecasts, re-baselined at gates.
3. **Never touch the real profile or `solo-bench`.** Runtime verification uses a scratch `DSH_HOME` +
   scratch profile under `.tmp/` (gitignored), per the Crisp discipline in
   [`Crisp/docs/integrations/deepseek-harness.md`](../../../Crisp/docs/integrations/deepseek-harness.md) §4.2.
4. **Design documents are the contract.** Code comments cite the ADR/design section implemented; an
   ADR 0001 deviation needs a new/amended ADR before merge — not a silent change.
5. **Evidence, not claims.** Every gate artifact states Executed / Not executed / Blocked with the
   command and artifact path (template in testing.md §14).

## 2. Planning basis and constraints

| Input | Fact used by this plan |
|---|---|
| Target runtime | DSH Desktop **0.2.2-rc.1**, profile `desktop`, Windows 11, Node.js 22.19.0 (verified in `docs/research/dsh-internals.md`) |
| Architecture | Three pillars: explicit Board, passive Pulse via one `systemPrompt.context`, metadata-only Ledger + on-demand Recall (ADR §2) |
| Hard runtime constraints | Fully offline: no server, no listening port, no network call, no child process, no model call, no external DB; plain ESM + Node builtins only; client is one plain browser module using `--dsw-alias-*` tokens only (ADR §3, §4) |
| Repository start state | `main` has design docs plus a design-stage scaffold: `package.json` (`dsh-confluence` 0.1.0, `dsh.bundle.patch`), `cordis.patch.yml` (one row, id `confluence`), `index.js` (activation-only), `locale/{en,zh}.json`, `icon.svg`, `examples/profile-patch.yml`, `.gitignore` (`.tmp/` ignored), and the **existing, passing** contract checks `scripts/check.mjs` (11 checks) + `test/contract.test.js` (18 tests). M1 extends this scaffold; it does not restart it. |
| Existing lifecycle | M0 evidence lives in `docs/plan/m0-spikes.md`; M1 code lives in `lib/`; M3 client in `client.js`; M4 docs in `README.md` / `docs/install.md` / the verification doc |
| Verification style | Crisp precedent: hermetic `node --test`, scratch-profile E2E with local stdlib mocks, a filled "what remains unverified" table, and no real-profile mutation during verification |
| Estimate basis | 13 engineer-days total for v1 (±30 %), matching ADR §14; M0 = 1, M1 = 4, M2 = 3.5, M3 = 2.5, M4 = 2.0 |

## 3. Target schedule

Assumptions: design sign-off 2026-11-13 (Fri); start 2026-11-16 (Mon); one primary implementation
engineer (E1) plus part-time independent verifier (V) and the Lead; no public holidays; review time is
inside the milestone. Slip policy in §3.2.

| Milestone | Scope | Effort | Target working days | Calendar target | Gate |
|---|---|---|---|---|---|
| **M0** Spikes | 7 blocking/decision spikes (S1–S7), no production code | 1.0 ed | Tue 11-16 … Tue 11-16 | **2026-11-16** | G1 spike gate |
| **M1** Core | JournalStore, WorkspaceResolver, board records, 3 tools, pulse + welcome digest, watermark projection, unit tests | 4.0 ed | Tue 11-17 … Fri 11-20 | **2026-11-20** | G2 core gate |
| **M2** Collaboration | Ledger + presence, reply/search/recall, redaction/privacy, scratch-profile offline E2E, two-writer/isolation tests | 3.5 ed | Mon 11-23 … Thu 11-26 (halves) | **2026-11-26** | G3 behavior gate |
| **M3** Panel | Transport decision outcome, read-only panel, locale/i18n, mark-read/opt-out, UI + no-egress verification | 2.5 ed | Thu 11-26 (half) … Mon 11-30 | **2026-11-30** | G4 UI gate |
| **M4** Hardening | Compaction + manifest, `memories.v1` export, docs/publishing/install verification, soak/concurrency/perf, release | 2.0 ed | Tue 12-01 … Wed 12-02 | **2026-12-02 = v0.1.0** | G5 acceptance + release |
| **v2** (not in v1) | Gated lite-capture + continuous-index evaluation; schema already reserved | 2 ed + eval | after ≥2 weeks dogfood → review **2026-12-16** | — | v2 go/no-go |
| | **Total v1** | **13.0 ed** | 13 working days | ±30 %: **2026-11-26 … 2026-12-08** | |

### 3.1 Compression scenario (optional second engineer)

A second implementation engineer (E2) only shortens M1/M2/M4; M0, the pulse/watermark interface and
M3's UI dependency stay serial. Realistic compression: ~10 working days (finish ~2026-11-27) with E2
on M1+M2. Do **not** plan <10 days — cross-milestone dependencies dominate (§7).

**Dependency graph:** M0 → M1 → M2 → M3 → M4 → v0.1.0; S1/S2/S4 block M1; S3/S5 block M2/M4 claims; S6 blocks M3's transport; S7 is accelerator-only.

### 3.2 Slip and cut policy

- Any spike > timebox ⇒ stop, record `INCONCLUSIVE`, accept its documented fallback; no day-2 spike work.
- Milestone slip ≤1 working day: absorb in the next milestone's contiguity; do not cut tests.
- Slip >1 working day at a gate: Lead re-baselines dates, publishes a decision-log entry, and applies
  the trim order: (1) M4 stretch, (2) M3 secondary UI affordances (keep timeline + mark-read),
  (3) M4 badge/custom cards (defer to v0.1.1), (4) **never** M0 gates, store, pulse determinism,
  isolation, or no-egress tests.
- If the total reaches >16.9 ed (worst case) without a release, stop and re-scope with the Lead
  rather than silently expanding v1.

## 4. M0 — blocking spikes (gate G1)

Full specs (method, evidence format, pass/fail, fallback, timebox) in
[M0 spike specs](m0-spikes.md). This table is the plan-level gate; total timebox **1.0 day**.

| ID | Spike | Blocks | Pass condition (short) | Fallback if fail |
|---|---|---|---|---|
| **S1** | Runtime-context snapshot dedupe (and append-vs-replace) end-to-end | M1.6, M1.7, whole pulse concept | Unchanged pulse text produces no new `user/message` runtime-context snapshot; a changed text commits exactly one new snapshot, append/replace semantics measured per ADR 0003 §4 (design must not rely on collapse); three-change history cost measured; verified in a scratch profile + mock model | Keep pulse but make it a `systemPrompt.section`-static overview + push content into `confluence_board`; escalate to Lead as ADR amendment |
| **S2** | Projection marker fold across resume/fork/compaction | M1.7, M2.3 | `sessionProjections` unit re-derives `digestSeq`/`boardReadSeq` after process restart, in a fork child (inherited prefix), and when compaction events exist; garbage marker keeps the previous value | In-memory watermarks reseeded by scanning the last retained snapshot at `agent/created`; documented degraded, no data loss |
| **S3** | PTC presentation + `tool/ptc-dispatch` shape | M2.1, M2.3, docs claims | In the `ptc` preset the six tools are visible as `run_code` SDK bindings (schema/description present) and the dispatch event is observable; in `standard` the tools are directly callable | Support `standard` preset explicitly; under `ptc` document `run_code` access; ledger parses both event shapes tolerantly; escalate tool-surface wording |
| **S4** | Journal append / torn line on Windows | M1.2 | Two processes append complete lines to their own shards with zero corruption over 2 × 1k lines; a torn trailing line is ignored and recovery works; p95 append <10 ms on local NTFS | Add per-append `fsync` and a post-append length check; if a network/USB drive is detected, open the store read-only with a visible warning |
| **S5** | Multi-window process topology | M2/M4 claims, docs | Documented truth: one Host process per DSH instance (intra-instance windows share memory) vs. one process per window; cross-process visibility measured at poll latency | No design change needed (polling is the contract; shards are lock-free); constrain docs to "poll-bounded, not instant" |
| **S6** | Client `host.call` host contract | M3.1 transport choice | Host-side registration method, client call signature, and fence/authorization behavior documented from installed bytes and exercised once from a live page | Use the proven same-origin `ctx.webServer.register` route + `connection.requestRejection` (Crisp/dsh-context precedent); pre-build behind one interface |
| **S7** | Optional `@deepseek-ai/dsh-atomic-write` import | Nothing (accelerator only) | Throwaway bundle resolves the package from the installation and `withFileLock` works cross-process | Native `fs.open(lease,'wx')` + stale-PID takeover (already the primary compaction/export design) |

**Gate G1 rule:** every blocking spike is PASS or FALLBACK-ACCEPTED in the decision log; evidence
summaries are committed in `m0-spikes.md` under "Results". If S1 fails without an accepted fallback,
**stop the plan** — the passive pulse is the product's reason to exist; return to design.

## 5. Work packages by milestone

### 5.1 M1 — core awareness loop (4.0 ed)

Exit gate G2: unit suite green, contract/static check green, scratch smoke IT-01 green (activation,
empty pulse, store writable), pulse budget measured and recorded, and no real-profile writes.

| WP | Effort | Deliverables (files) | Depends on |
|---|---|---|---|
| M1.1 Scaffold extension + contract/static check | 0.5 | `package.json` (`exports`/`files` grow to `lib/`), extend `scripts/check.mjs` + `test/contract.test.js` (both already exist and pass), `lib/index.js` (apply wiring with `ctx.effect`), `lib/config.js` | — |
| M1.2 JournalStore (append, merge, torn line, poll/watch) | 0.75 | `lib/store/journal.js`, `lib/store/ids.js` (ULID, writerId), `lib/store/merge.js`, `test/store/*.test.js` | M1.1 |
| M1.3 WorkspaceResolver | 0.5 | `lib/workspace.js`, `test/workspace.test.js` | M1.1 |
| M1.4 Board model / records / caps | 0.5 | `lib/board.js`, `lib/records.js`, `test/board.test.js` | M1.2 |
| M1.5 Tools `confluence_board` / `confluence_post` / `confluence_read` | 0.75 | `lib/tools/index.js`, `lib/tools/board.js`, `lib/tools/post.js`, `lib/tools/read.js`, `test/tools/*.test.js` | M1.3, M1.4 |
| M1.6 PulseProvider + welcome digest | 0.5 | `lib/pulse.js`, `lib/pulse-template.js`, `test/pulse/*.test.js`, measured budget note in `docs/design/pulse.md` | M1.2–M1.5 |
| M1.7 Watermark projection (`digestSeq`, `boardReadSeq`) | 0.5 | `lib/watermark.js`, `lib/projection.js`, `test/watermark.test.js` | M1.2, M1.6 |

- **M1.1** Extend the existing scaffold (not replace); add `lib/` to `exports`/`files`; extend the
  existing `scripts/check.mjs` and `test/contract.test.js` (manifest/patch row/locale/icon checks, no
  static DSH imports, no network modules or URL literals in runtime files); `apply()` validates config
  and registers nothing else.
- **M1.2** `writerId = <pid>-<8 lowercase hex>` per mount; one shard `journal.<writerId>.v1.jsonl`;
  append complete lines ≤64 KiB through a held `O_APPEND` fd + `fs.writeSync`; `seq` = time-sortable
  ULID; merge all `*.jsonl` sorted lexicographically, dedupe by `id` (**entry first-wins, `session`
  last-wins**), ignore a trailing line without `\n`; batched `fsync` ~1 s + at session events, and a
  board post forces fsync before acknowledging; poll `store.pollMs` (4000); `fs.watch` debounced
  300–500 ms, try/catch-wrapped; `EACCES/EBUSY/EPERM` or a network path → polling + warning, never crash.
- **M1.3** `header.cwd` → `fs.realpath` → win32 lower-case fold → `sha256` → `ws_<16 hex>`; freeze the
  key per session id at first observation; fall back to `ctx.workingDirectory.get(session)` only when
  the header has no `cwd`; first mount creates `MANIFEST.v1.json.workspace` =
  `{key, canonicalPath, createdAt}` (`wx`, data-model §4.7); `label` is resolved live at render and
  never stored; unresolved → no key (no tools via `options.when`, no pulse text).
- **M1.4** Entry shapes `finding|decision|gotcha|question|handoff|warning`; title/body/tags/files
  validation + caps (`maxBodyBytes` 8192, `maxEntriesPerWorkspace` 2000); `reply_to`, `resolves`,
  `supersedes`; unread/open-question/handoff/count queries; never edit in place.
- **M1.5** Author `defineTool` schemas (strict), `options.when` = resolvable workspace; workspace from
  `exec.agent.session`, never arguments; untrusted framing + machine-readable `through=<seq>` line in
  `board`/`read` text renders; no card presentation in v1.
- **M1.6** One global `ctx.systemPrompt.context({name:'confluence:pulse', order:1500,
  required:false, interpolate:false, text})`; synchronous/pure over an in-memory snapshot (no disk
  I/O); byte-stable template (final text frozen in `docs/design/pulse.md`); escape `<`, `&`,
  U+2028/2029 as `\uXXXX`; ≤1400-char hard cap; empty string when nothing new; welcome digest for a
  fresh session; measured budget split recorded (token-estimate method in testing.md).
- **M1.7** `ctx.sessionProjections.register` unit `confluence_watermark` (ADR 0003 §2) folding the
  committed runtime-context message's `confluence:pulse` section (`source.sections[].name`) `seq`
  attribute → `digestSeq`, and `through=<cursor>` markers in committed `tool/result` (standard) /
  `tool/ptc-dispatch` (ptc) → `boardReadSeq`; `apply` pure/synchronous, `max`-monotonic, malformed
  markers keep the previous value; in-memory per-agent fallback when the service is absent (lost on
  restart — documented degraded mode, ADR 0003 §2).

Out of scope for M1: presence, ledger, reply/search/recall, UI, compaction/export, redaction engine
(M1 only has the redaction hook stub; the corpus tests land in M2).

### 5.2 M2 — collaboration, recall, privacy (3.5 ed)

Exit gate G3: E2E-01..06 + ISO-01..04 + UT-RECALL/REDACT/LEDGER green in a scratch `DSH_HOME`;
hostile-note corpus passes; verification-status table has real "Executed" rows; two-writer and
isolation evidence committed.

| WP | Effort | Deliverables (files) | Depends on |
|---|---|---|---|
| M2.1 SessionLedger | 0.75 | `lib/ledger.js`, `lib/titles.js`, `test/ledger.test.js` | M1.2, M1.3 |
| M2.2 Presence heartbeat | 0.5 | `lib/presence.js`, `lib/store/presence.js`, `test/presence.test.js` | M1.2 |
| M2.3 `reply` / `search` / `recall` + `read` session refs | 1.0 | `lib/tools/reply.js`, `lib/tools/search.js`, `lib/tools/recall.js`, `lib/recall.js`, `test/recall.test.js` | M1.5, M1.7 |
| M2.4 Redaction + privacy opt-outs | 0.75 | `lib/redact.js`, `lib/privacy.js`, `test/redact.test.js`, `test/privacy.test.js` | M1.4 |
| M2.5 Scratch E2E harness + multi-writer/isolation tests | 0.5 | `scripts/e2e-dsh.ps1`, `test/e2e/mock-provider/server.mjs`, `test/e2e/scenarios/*.json`, `test/integration/*.test.js` | M1.1, M2.1–M2.4 |

- **M2.1** Subscribe to `session/event`; recognize `turn/end`, `tool/call`, `tool/ptc-dispatch` and
  tool-result names; per session store `{sessionId,title,status,turnCount,lastActivity,paths[≤8],dir}`;
  paths only from write/edit-style tool arguments, workspace-relative, deny/symlink-escape filtered;
  **no prompts, assistant text, tool output, reasoning, or command lines** (SEC-02 allow-list test);
  upsert as `session` record (last-wins), cap 200/workspace; title from `sessionQuery.readTitle` when
  available, else a redacted/truncated first user-message line.
- **M2.2** `presence/<writerId>.json` upsert at turn end and every 10 s; stale >30 s = offline; peers =
  live same-workspace sessions (count + ≤2 sanitized titles, stable ordering); hearts are never journal records.
- **M2.3** `confluence_reply` appends a reply or `resolves`/reopens; `confluence_search` filters by
  text/tag/kind/limit; `confluence_recall` = `listSessions()` → canonicalize each `header.cwd` → same
  workspace, caller excluded → `filterEvents(id, [{kind:'text', text}])` → ≤3 sessions, ≤5 hits,
  ≤600-char excerpts, provenance `session:<id>:<seq>`, "literal match only; partial", cooperative 5 s
  timeout with partial marking; `confluence_read` expands `session:<id>:<seq>` via `readEvent` (≤3
  events); private/disabled targets excluded and refs not-found (UT-RECALL-06); never in the pulse provider.
- **M2.4** Redaction patterns (API keys/tokens/PEM/password assignments/JWT/known prefixes) from
  `privacy.redactPatterns`/defaults over titles, bodies, tags, paths and recall output; `redactTitles`
  true by default; `privateSessions` → scoped `suppressRuntimeContext()` + no ledger rows;
  `disabledWorkspaces` → no pulse/tools/ledger; bad config values fall back + activation warning.
- **M2.5** E2E harness: find the `dsh` launcher → `.tmp/e2e/dsh/run-<stamp>` scratch `DSH_HOME` +
  `--from-default-profile headless` profile → `dsh plugin --profile <scratch> add <repo>` → local
  stdlib mock model (loopback only) → scripted headless turns → assert pulse commitment, dedupe, board
  sharing, isolation, no `agent/inbox/spliced`, cleanup. Two-writer simulation spawns two Node writer
  processes (test harness only — the plugin never spawns) and asserts no lost records. No external network.

Out of scope for M2: UI, compaction/export, human write path via commands, custom cards.

### 5.3 M3 — read-only panel (2.5 ed)

Exit gate G4: UI-01..06 green (slot registered, panel renders in a real page, no console errors,
light/dark token use, back-to-chat, bounded payload + fence, no iframe/no DOM outside the component);
panel data path adds no port; no-egress check still green.

| WP | Effort | Deliverables (files) | Depends on |
|---|---|---|---|
| M3.1 Transport outcome + host data adapter | 0.5 | `lib/panel-data.js` (single interface), transport chosen from M0-S6 (`host.call` registration or `ctx.webServer.register` route with `connection.requestRejection` fence), `test/panel-data.test.js` | M0-S6, M2.5 |
| M3.2 Client panel | 1.0 | `client.js`, `lib/client/*` (plain module loader, React from loader), `sidebar.panellist` + keyed `main`, 5 s visible polling, mark-read, opt-out controls, audit line | M3.1 |
| M3.3 Display resources + locales | 0.25 | `locale/{en,zh}.json` (already seeded), `icon.svg`, `dsh.client` manifest fields | M3.2 |
| M3.4 Panel verification | 0.5 | `docs/verification.md` UI section filled (slot/console/theme evidence), screenshots optional | M3.2 |
| M3.5 Panel security + no-egress tests | 0.25 | `SEC-06`, `UI-05`, payload-bound tests | M3.1 |

- **M3.1** One internal read model (`getPanelSnapshot()`) with bounded payload (≤64 KiB; board page
  ≤50 entries, counts, peers, open items, last recall audit line); primary = client `host.call` if
  M0-S6 found the contract; fallback = same-origin route fenced by `connection.requestRejection`,
  `cache-control: no-store`, GET/HEAD only; no new port.
- **M3.2** `client.js` as `window.__ModuleLoader__.load(...)`; inject `slots`, `locale`, `layout`;
  `ctx.effect` every registration; tokens only; no iframe; no DOM writes outside the component;
  "back to chat" via `ctx.layout.selectPanel(null)`.
- **M3.3** Verify both locales' `meta.title`/`meta.description`, `./icon` export, `files` coverage,
  and `dsh.client` `{platform:"web", immediately:true}`; the UI stays optional (`ui.enabled`).
- **M3.4** Manual + automated checks: entry appears, page opens, no console errors, theme renders in
  light/dark, no data beyond board/metadata in the payload; record what remains unverified.
- **M3.5** Static scan (SEC-04), route/fence tests, payload bounds (no secrets, no prompts), degrade
  with a warning when `webServer`/transport is absent (plugin stays active).

Out of scope for M3: composer, thread editor, human writes beyond mark-read/opt-out, per-session
badge, custom cards (all M4 stretch / v0.1.1).

### 5.4 M4 — hardening, export, release (2.0 ed)

Exit gate G5: release checklist §14 complete; compaction/export tests green; 30-min soak clean;
perf budgets met or documented; docs and verification table complete; v0.1.0 tagged locally.

| WP | Effort | Deliverables (files) | Depends on |
|---|---|---|---|
| M4.1 Compaction + manifest | 0.5 | `lib/store/compact.js`, `lib/store/lease.js`, `test/compact.test.js` | M1.2, M0-S4/S7 |
| M4.2 Export `memories.v1` | 0.5 | `lib/export.js`, `test/export.test.js`, `test/fixtures/export/*` | M4.1, M2.4 |
| M4.3 Docs / publishing / install verification | 0.5 | `README.md` (EN + ZH section or `README.zh-CN.md`), `docs/install.md`, `docs/verification.md` (filled statuses), CHANGELOG/release notes | M1–M3 |
| M4.4 Soak/concurrency/perf + v0.1.0 release | 0.5 | `test/soak/*` scripts, perf evidence, `v0.1.0` local tag, release checklist result | all |

- **M4.1** Native lease `fs.open(<workspace>/lease,'wx')` + stale-PID takeover; merge shards into
  `snapshot.<gen>.v1.jsonl`; publish `MANIFEST.v1.json` atomically (temp + rename, Windows retries);
  prune old generations; abandon the lease on timeout; a crash leaves the old manifest valid.
- **M4.2** Export command/action only (opt-in `export.enabled`); deterministic order (`seq,id`),
  redacted, workspace-relative paths; live entries plus content-free tombstone stubs; JSONL first,
  then `manifest.json` last (`schema:"confluence.memories/v1"`, `formatVersion:1`, `recordCount`/
  `firstSeq`/`lastSeq`, `files[0].sha256`/`bytes`) per `docs/design/store-format.md` §14; never read back.
- **M4.3** README EN (+ 中文 section), install doc covering `install_bundle` and the CLI scratch path
  (documented vs executed marked honestly), privacy statement ("what is stored" vs "what recall
  reads"), release notes, filled verification matrix.
- **M4.4** 30-min soak: 2 processes × 2 000 entries, 4 s poll churn, injected torn lines, view
  assembly; perf budgets recorded; release checklist; tag `v0.1.0` (GitHub push is out of scope —
  blocked on this machine).
- **M4 stretch (Lead approval + ≥0.5 ed remaining only):** per-session unread badge
  (`conversation.session.header.utilities`), custom in-chat cards, human mark-read/write via
  `ctx.remote.commands.execute('/confluence …')`. Default: deferred to **v0.1.1** — a deliberate
  deviation from ADR §12/§14's M4 wish-list, recorded in the decision log at G5 (open question O1).

### 5.5 v2 gate (outside v1)

After v0.1.0 and at least two weeks of real dogfooding (target review **2026-12-16**), decide on
v2 (deterministic lite-capture of ≤2 decision/gotcha lines per turn + continuous-index evaluation).
Entry: ≥20 user sessions across ≥3 workspaces; gold set of decision/gotcha lines extracted from the
user's own sessions; measured precision ≥90 % (per ADR §11/round-2 R3); scoped `signal`/`watermark`
records and export schema versioning plan. Exit: new ADR (0007+) and a separate estimate (≈2 ed + eval);
v2 code does not start before that decision.

## 6. Explicit out of scope (whole v1)

Continuous transcript indexing, LLM extraction, embeddings/vector search, FTS enablement, any network/
server/port/external DB/child process/model call, cross-workspace sharing, editor/host takeover, board
editing/deletion tools, accounts/permissions/admin UI, replacement of `@`-mention snapshots or
`session_*` search, remote liveshare, git automation, npm/GitHub publishing (push is blocked), and any
change to `solo-bench` or `Crisp` during this phase.

## 7. Team, ownership and parallelization

### 7.1 Design phase (now)

| Member | Owns | Parallel-safe? |
|---|---|---|
| `lead` | ADR 0001, round discussion records, packaging scaffold, final sign-off | writes its own files only |
| `design-core` | `docs/design/architecture.md`, `data-model.md`, `store-format.md` | parallel with behavior/surface; no shared file |
| `design-behavior` | `docs/design/tool-api.md`, `pulse.md`, `ledger-recall.md` | parallel; interfaces referenced from ADR |
| `design-surface` | `docs/design/ui.md`, `config.md`, `security-privacy.md` | parallel; references behavior's tool contracts |
| `planner` | `docs/plan/execution-plan.md`, `docs/plan/m0-spikes.md`, `docs/design/testing.md`, `docs/design/solo-bench-integration.md`, `docs/adr/0006-solo-bench-integration.md` | parallel; reads others' drafts only |
| independent reviewer | cross-document consistency (ADR ↔ design ↔ plan ↔ tests), no product code | after drafts; may only comment, not edit |

Rules: one writer per file; cross-document inconsistencies go to the Lead (or the owning writer),
never edited silently. This design phase ends at gate G0 (§10).

### 7.2 Implementation phase

Staffing: E1 (core/store), E2 (behavior/tools, optional), E3 (client panel, M3 only), V (independent
verifier/test author, ~0.5 ed spread), Lead (gate chair, reviews, release). The baseline schedule
assumes E1 + V + Lead; E2 compresses it (§3.1).

Write scopes (disjoint except the serialized list): E1 → `lib/store/*`, `lib/workspace.js`,
`lib/board.js`, `lib/records.js`, `lib/export.js`; E2 → `lib/ledger.js`, `lib/presence.js`,
`lib/recall.js`, `lib/redact.js`, `lib/privacy.js`, `lib/tools/*` (except `index.js`);
E3 → `client.js`, `lib/client/*`; V → `test/e2e/*`, `test/integration/*`, `test/fixtures/*`;
Lead → `package.json`, `cordis.patch.yml`, `README.md`, `docs/install.md`, `docs/verification.md`.

Interface freezes (change after freeze = decision-log row + re-test): F1 end of M1.2 journal record
schema; F2 end of M1.5 board shapes + tool result envelopes; F3 end of M1.6 pulse template +
`PulseSnapshot`; F4 end of M2.5 panel data interface. Shared files serialized on the task board:
`package.json`, `cordis.patch.yml`, `index.js`, `lib/tools/index.js`, `locale/*.json`. Concurrent-safe:
M2.1 ‖ M2.2, M2.3 ‖ M2.4 after F2, M3.1 ‖ end of M2.3/M2.4 (interface stub), M4.1 ‖ M4.3 (code vs docs).

## 8. Risk register

Likelihood/impact: H/M/L. Owner is the accountable role. Trigger = observable early warning.

| ID | Risk | L | I | Mitigation | Owner | Trigger |
|---|---|---|---|---|---|---|
| R1 | Pulse wrong/stale/noisy → users and agents learn to ignore it ("trust collapse", ADR §16) | M | H | byte-stable deterministic text, log-derived watermarks, no wall-clock/status churn, measured budget, welcome digest, determinism tests, dogfood review | E1/Lead | any "pulse shows wrong/unread forever" report; dedupe test flake |
| R2 | Runtime coupling to 0.2.2-rc.1 breaks pulse/watermark on a DSH upgrade | M | H | source-verified M0; tolerant parsing; projection fallback; `engines.dsh` guard + activation warning; re-run M0-S1/S2 on upgrade | E1 | DSH version change; snapshot format change |
| R3 | Multi-window/multi-process store divergence or lost notes | M | H | per-writer shards, append-only, no rewrite, poll contract, torn-line tolerance, S5 measurement, soak test | E1 | second window shows a missing note; soak duplicate/loss count >0 |
| R4 | `host.call` contract unusable → M3 blocked | M | M | S6 in M0; webServer route fallback pre-built behind one interface | E3/Lead | S6 INCONCLUSIVE; client builtin list lacks host call |
| R5 | Tools unreachable under the default `ptc` preset (only `run_code`) | H | M | M0-S3; descriptions designed for both surfaces; E2E-07 ptc scenario | E2 | model never calls a confluence tool in ptc dogfood |
| R6 | Workspace mis-scoping (case/symlink/`cd`) → cross-workspace leak | L | H | canonical realpath + win32 fold, frozen key, isolation fixtures ISO-01..04, no argument-supplied paths | E1 | any recall/pulse hit from another workspace in tests |
| R7 | Secret leaked into journal/pulse/export via notes or titles | M | H | redaction corpus, title redaction, journal field allow-list, export redaction test, deny path patterns | E2 | SEC-02/SEC-03 failure; user report |
| R8 | Prompt injection via board content manipulates an agent | M | H | untrusted framing, `\uXXXX` escaping, never render as instructions, tests hostile fixtures; accepted residual risk documented | E2/Lead | agent acts on note content in dogfood |
| R9 | Adoption/content emptiness (board only knows what is posted) | M | M | pulse advertises board + guide line, onboarding tool descriptions, welcome digest, M2 acceptance scenario | Lead | dogfood sessions with zero posts after a week |
| R10 | Performance/scale: merge or pulse assembly too slow at caps | L | M | caps (2000 entries/ws, 200 sessions), in-memory mirror, PERF budgets, soak | E1 | PERF-01/02/03 fail twice |
| R11 | E2E harness flaky (headless model stub, tool-call scripting, Windows process timing) | M | M | text-only pulse E2E as the required path, tool-call E2E optional, generous bounded timeouts, `summary.json` artifacts | V | same scenario passes/fails nondeterministically |
| R12 | Scope creep (lite-capture, FTS, UI writes) into v1 | M | M | explicit non-goals, gate cut order (§3.2), v2 gate | Lead | new tool/schema idea appears in a PR |
| R13 | Verification accidentally touches the real profile/`~/.dsh` | L | H | scratch `DSH_HOME` under `.tmp/`, assert real home untouched, no `install_bundle` in this phase, Crisp discipline | V | real profile mtime change; test reads `~/.dsh` |
| R14 | Export contract drifts before the future solo-bench consumer | L | M | freeze `confluence.memories/v1` in M4 with conformance fixtures; version rule: additive v1 only, breaking = v2 file | Lead | manifest/schema field change after M4 |
| R15 | ADR deviation: M4 listed more scope (badge/cards/composer) than 2 ed supports | H | L | explicitly deferred to v0.1.1 with Lead sign-off at G5 (§5.4, O1) | Lead | G5 checklist catches missing item |
| R16 | License/merge wrinkle in `solo-bench` ("不加许可证文件") | L | L | no root license added; vendored subtree keeps its own MIT file (decision in ADR 0006 / O2) | Lead | user objects at merge time |

## 9. Verification strategy (summary)

Full strategy, fixtures, budgets and commands: [testing.md](../design/testing.md). Summary:

| Layer | What it proves | Representative IDs | Runs at |
|---|---|---|---|
| Contract/static | manifest, patch row, locale/icon, no DSH imports, no network modules/URLs, `files` coverage | CON-01..07, SEC-04 | every WP |
| Unit (hermetic `node --test`) | store conformance, torn lines, merge, workspace keys, records/caps, digest determinism, escaping, redaction, projection fold, config defaults | UT-* | M1–M4 |
| Integration (fake ctx / two Node writer processes) | multi-writer merge, recall caps/timeout, isolation, optional-service degradation | IT-*, ISO-* | M1.2+, M2 |
| Scratch-profile E2E (offline, local mock model) | committed runtime-context text, dedupe, board sharing, no injections, zero egress, install/activation | E2E-* | M2–M4 |
| UI | slot registration, panel render, tokens/locale, fence, no iframe | UI-* | M3 |
| Export/consumer | determinism, redaction, manifest hashes; Go-reader conformance fixtures (future) | EXP-*, GOCON-* | M4 / later |
| Performance/soak | pulse p95 <5 ms, append p95 <10 ms, merge/recall bounds, 30-min soak | PERF-* | M1 (pulse), M4 (soak) |

Gate evidence rule: a gate cannot pass on "unit tests pass" alone when the milestone touches runtime
behavior — it must show a scratch-profile artifact for M1 (IT-01), M2 (E2E-01..06), M3 (UI-01..06),
M4 (release checklist + soak).

## 10. Phase-gate review process

Reviewers: **V** (independent verifier, did not write the code under review) + **Lead** (chair).
Architecture-level decisions need Lead + one more reviewer; privacy/security-affecting changes
(redaction, isolation, egress, export) need V explicitly signed.

| Gate | When | Entry criteria | Artifacts required | Decision options |
|---|---|---|---|---|
| **G0** Design review | end of this phase | ADR 0001 accepted; all round-3 docs drafted | design docs, this plan, `testing.md`, `m0-spikes.md`, integration/ADR 0006; cross-doc consistency report | go / conditional (fix list, re-review) / stop |
| **G1** M0 spike gate | end of M0 day | 7 spike specs executed or timed out | filled `m0-spikes.md` results, evidence paths, fallback decisions | go / go-with-fallbacks / stop (if S1 fails) |
| **G2** M1 core gate | end of M1 | all M1 WPs done; tests green; IT-01 evidence | unit/contract/perf logs, IT-01 artifact, pulse budget measurement, code review | go / conditional / rollback WP |
| **G3** M2 behavior gate | end of M2 | E2E-01..06, ISO, security corpora green | E2E `summary.json`, verification-status rows, two-writer logs, code review | go / conditional / stop |
| **G4** M3 UI gate | end of M3 | M3 verification evidence; UI tests green | slot/console/theme evidence, payload/fence tests, static no-egress | go / conditional (UI optional) |
| **G5** Acceptance + release | end of M4 | release checklist; soak; docs; verification table | release checklist result, soak/perf logs, docs, filled "what remains unverified" | release v0.1.0 / conditional / defer |

Procedure per gate (30–45 min): author demos exit criteria → V walks the evidence table and re-runs
1–2 commands → open ADR deviations/risks reviewed → decision logged with owner/date → Lead signs.
**A gate cannot be "passed by promise"; missing evidence is a conditional, not a pass.** No code
merges to `main` from a failed/conditional gate without the Lead's written exception.

## 11. Definition of Done

**Work package:** code + tests committed; `node --test` and `node scripts/check.mjs` green; no static
DSH imports/network modules; comments cite ADR/design sections; new config fields documented in
`docs/design/config.md`; strings in both locales; write scope respected; reviewed by V (or Lead for docs).

**Milestone:** all WPs done; exit criteria evidenced; gate decision logged; verification-status table
updated; ADR deviations/fallbacks recorded; risks re-scored; release notes draft updated.

**Release v0.1.0:** §14 complete; nothing the release notes claim as working is `Not executed`; no
secrets in repo/logs/fixtures; no profile changes beyond installing the bundle; docs describe v1 as
"awareness + on-demand literal search", not "retroactive indexing".

## 12. Decision log template and change control

Append-only log at `docs/plan/decision-log.md` (created at G0). One row per execution-level decision;
architecture-level changes are new ADRs instead.

```markdown
| ID | Date | Decision | Alternatives considered | Rationale | Author | Affects (milestone/files) | Status |
|----|------|----------|------------------------|-----------|--------|---------------------------|--------|
| D-001 | 2026-11-13 | ... | ... | ... | lead | ... | Accepted |
```

Change control: (1) an ADR 0001 deviation needs a new/amended ADR accepted by the Lead; (2) a frozen
interface change (F1–F4) needs a decision-log row + re-run of affected tests; (3) dependency changes
beyond Node builtins need an explicit ADR — v1 has zero runtime dependencies; (4) new model-facing
tools or record types need an ADR amendment (contracts with agents/future readers).

## 13. Verification matrix (ADR requirement → test)

Test IDs refer to [testing.md](../design/testing.md); level: U=unit, I=integration/scratch, E=E2E,
C=contract/static, S=security, P=perf, UI=UI. `M` column = milestone where the test must be green.

| ADR § | Requirement | Test(s) | Level | M |
|---|---|---|---|---|
| 2.1 | Board: append-only typed notes, threads, resolution, provenance | UT-BOARD-01..06, IT-03 | U,I | M1/M2 |
| 2.2 | Pulse reaches every agent step with no user/agent action | E2E-01, IT-04 | E,I | M2 |
| 2.2 | Pulse costs zero tokens when unchanged (no new messages) | UT-PULSE-02, E2E-02 | U,E | M1/M2 |
| 2.3 | Ledger is metadata-only; recall is on-demand, read-only, literal, excludes private/disabled targets | UT-LEDGER-01..04, UT-RECALL-01..06, IT-06 | U,I | M2 |
| 4 | Component ownership: plain ESM + Node builtins; no hard `@deepseek-ai/*` imports; client plain module | CON-02, CON-03 | C | M1/M3 |
| 5 | Workspace key = canonical `header.cwd`, win32 fold, frozen, fallback | UT-WS-01..06, ISO-01 | U,I | M1 |
| 5 | Absolute per-workspace isolation; no-key sessions get no tools/pulse | ISO-01..04, UT-TOOL-08 | I,U | M2 |
| 6 | Store layout, line schema/version, unknown types ignored | UT-STORE-01..04, CON-DATA-01 | U,C | M1 |
| 6 | Per-writer shards, append path, merge-on-read, dedupe | UT-STORE-05..08, IT-01 | U,I | M1 |
| 6 | Durability: torn line tolerated; crash loses at most last record | UT-STORE-09..11 | U | M1 |
| 6 | Freshness: polling contract; `fs.watch` optional and degradable | UT-STORE-12, IT-02 | U,I | M1/M2 |
| 6 | Compaction/export under native lease; atomic manifest | UT-EXP-01..03 | U | M4 |
| 6 | Export: opt-in, deterministic, redacted, relative paths, live entries + tombstone stubs, manifest `schema`/`formatVersion`/`files[0]` hash | EXP-01..05 | U | M4 |
| 7 | Six tools: schemas, activation `when`, workspace-authoritative, untrusted framing | CON-TOOL-01..06, UT-TOOL-01..09 | C,U | M1/M2 |
| 7 | `through=<seq>` marker in results and its fold | UT-WM-02, E2E-03 | U,E | M1/M2 |
| 8 | Pulse template, caps, escaping, order/required/interpolate, byte stability | UT-PULSE-01..07, CON-PULSE-01 | U,C | M1 |
| 8 | Budget ≤1400 chars / ≤320 tokens, measured split | UT-PULSE-05, PERF-01 | U,P | M1 |
| 8 | Welcome digest for fresh session | UT-PULSE-06, IT-05 | U,I | M1/M2 |
| 8 | Never `agent.inject`/timers/wall-clock churn in v1 | E2E-04, CON-PULSE-02 | E,C | M2 |
| 8.1 | Split log-derived watermarks (`confluence_watermark`: pulse section `seq` + `through=` markers) survive resume/fork/garbage | UT-WM-01..06, E2E-05 | U,E | M1/M2 |
| 8.1 | Fallback watermark when `sessionProjections` absent | UT-WM-07, IT-07 | U,I | M2 |
| 9 | Ledger live-first: turn/tool/PTC parsed; ≤8 paths; no content | UT-LEDGER-01..04 | U | M2 |
| 9 | Recall caps: ≤3 sessions, ≤5 hits, ≤600 chars, 5 s cooperative timeout; private/disabled target exclusion (UT-RECALL-06) | UT-RECALL-01..06, PERF-03 | U,P | M2 |
| 10 | Config: defensive defaults, bad values fall back + warning | UT-CONFIG-01..03 | U | M1 |
| 11 | Workspace is the consent boundary; private/disabled opt-outs (incl. recall target exclusion) | ISO-04, UT-PRIV-01..03, UT-RECALL-06 | I,U | M2 |
| 11 | Best-effort redaction stored/rendered/recall/export | UT-REDACT-01..06, SEC-03 | U,S | M2/M4 |
| 11 | Journal field allow-list (no prompts/assistant/tool output) | SEC-02 | U,S | M2 |
| 11 | No egress: no network modules/URLs/sockets; no extra port | SEC-04, E2E-06 | C,E | M3/M4 |
| 11 | Filesystem safety: store root only; no symlink escape; deny patterns | UT-PATH-01..03, SEC-05 | U,S | M2 |
| 12 | Panel slots/locale/tokens/no iframe; read-only | UI-01..06, CON-UI-01 | UI,C | M3 |
| 12 | Transport local-only + fence (or `host.call` contract) | UI-05, SEC-06 | UI,S | M3 |
| 13 | Package manifest, patch row, exports, `files`, `engines.dsh`, locale meta, icon | CON-01..07 | C | M1/M3 |
| 13 | Offline install path verified in scratch profile | E2E-00, REL-02 | E | M2/M4 |
| 13 | solo-bench merge plan + export contract documented, no live coupling | DOC-02, GOCON-01 (future) | docs | M4/later |
| 16 | Re-check runtime coupling on DSH upgrade | CON-UPGRADE-01 (checklist) | C | post-release |
| 16 | Optional services absent → plugin stays active, degrades | UT-DEGRADE-01..03, IT-08 | U,I | M2 |

## 14. Release checklist — v0.1.0

1. `package.json`: `name: dsh-confluence`, `version: 0.1.0`, `private: true`, `type: module`,
   `engines.dsh: ">=0.2.2-rc.1"`, `dsh.bundle.patch`, `exports` (`.`, `./client` if M3 shipped,
   `./locale/*.json`, `./icon`), `files` covers every runtime file.
2. `cordis.patch.yml`: exactly one uniquely named row `confluence`, complete default config, no
   commented-out secrets.
3. `locale/en.json` + `locale/zh.json` with meaningful `meta.title`/`meta.description` and all UI
   strings used by the panel; no template copy.
4. Original `icon.svg`, valid, ≤256 KiB, exported as `./icon`.
5. `node --test` full suite green (unit + integration); contract/static check green.
6. Scratch-profile E2E (`scripts/e2e-dsh.ps1`) green or `SKIPPED` only if no `dsh` launcher, with
   `summary.json` artifacts; real `~/.dsh` untouched (asserted).
7. Soak run (30 min) clean: no lost/duplicated notes, no unhandled rejection, no poll growth.
8. Perf budgets recorded: pulse assembly p95 <5 ms, append p95 <10 ms, merge/recall within caps
   (or documented deviation approved at G5).
9. No-egress audit: static scan (no `http|https|net|dgram|fetch` in runtime files), no non-loopback
   URL literals, no listening port, no child process, no `@deepseek-ai/*` static import.
10. Privacy audit: SEC-02/03 green; README states exactly what is stored vs read on demand; export
    is opt-in and redacted.
11. Docs: README EN (+ 中文), `docs/install.md` (install_bundle + scratch CLI path, marked
    documented/executed), `docs/verification.md` complete with the "what remains unverified" table.
12. Verification matrix filled: every ADR requirement is Executed/Partial/Blocked with evidence.
13. `CHANGELOG.md`/release notes: v1 = awareness + on-demand literal search; explicit non-goals.
14. License MIT (repo already declares it; no change to `solo-bench` licensing).
15. Git: clean tree, tag `v0.1.0` locally, commit message references this plan; **no GitHub push**
    (blocked on this machine) — release notes say local-only.
16. Rollback tested conceptually: uninstall bundle → plugin absent; store untouched; post-release:
    dogfood log template + v2 gate checklist opened.

## 15. Estimate summary and confidence

| Milestone | ed | Confidence | Main uncertainty |
|---|---|---|---|
| M0 | 1.0 | Medium | S1/S3 runtime behavior; S6 contract |
| M1 | 4.0 | Medium-high | store/merge edge cases on Windows; determinism polish |
| M2 | 3.5 | Medium | E2E mock scripting; recall timeout behavior |
| M3 | 2.5 | Low-medium | UI slot verification + transport outcome |
| M4 | 2.0 | Medium | compaction crash-safety; doc/fix tail |
| **Total** | **13.0** | ±30 % (9.1–16.9) | two unverified runtime contracts (S1/S6) and cross-process behavior |

## 16. HYPOTHESIS and open questions

- `HYPOTHESIS:` unchanged runtime-context text really produces zero new `user/message` snapshots in
  the installed 0.2.2-rc.1 loop (source-read only, fact 6 in `docs/research/dsh-internals.md`); M0-S1
  must confirm before M1.6/M1.7 close.
- `HYPOTHESIS:` `sessionProjections` survives resume/fork/compaction as designed (M0-S2); `host.call`
  has a usable host registration contract (M0-S6, fallback = proven same-origin route); two DSH
  Desktop windows are one Host process (M0-S5, polling is the contract either way); the Node 22.19
  `node --test` glob form works like Crisp's suite (else `node --test test/`).

## Open questions

1. **O1 — M4 scope:** ADR §12/§14 list badge, custom cards, composer and human write under M4, but 2 ed
   realistically covers only compaction/export/docs/soak. This plan defers the rest to v0.1.1 and needs
   explicit Lead sign-off at G5.
2. **O2 — License in the vendored subtree:** no repo-root license in `solo-bench`
   ("不加许可证文件"); `integrations/dsh-plugin-confluence/LICENSE` (upstream MIT) stays inside the subtree per ADR 0006.
3. **O3 (resolved by Lead ruling)** — record ids are `cnf_`/`tmb_` + 26-char ULID
   (`data-model.md` §2.2); the export reuses board ids; consumers treat them as opaque.
4. **O4 — Reviewer independence:** who is V for gates G2–G5 (one person independent of the code reviewed)?
5. **O5 — Model stub fidelity:** must the E2E mock script tool calls, or is the text-only pulse path enough for the release gate (tool behavior carried by IT)? Proposed: text-only mandatory.
6. **O6 — Start date:** 2026-11-16 assumes sign-off on 2026-11-13; if it slips, shift all dates by the slip (schedule is relative working days).
