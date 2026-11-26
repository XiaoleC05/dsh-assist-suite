# Confluence / 高级记忆 — test strategy

Status: **design-phase test specification, with executed v0.2.0 evidence.** The specification itself
is the design contract; the v0.2.0 implementation ships the suites and the harness it describes. The
offline suite is **291/291 pass**, the packaging check **17/17**, the M0 smoke **14 pass / 1 blocked**
and the offline scratch-profile cross-directory E2E **15/15 PowerShell checks + 12/12 assertions,
exit 0** (run `.tmp/e2e/run-20261116-203730`, 2026-11-16; §9a and
[../discussion/v0.2-e2e-evidence.md](../discussion/v0.2-e2e-evidence.md)). The §14 table keeps the
design-phase rows as history and appends the executed v0.2.0 rows. Binding requirements:
[ADR 0001](../adr/0001-confluence-architecture.md); the v0.2.0 scope amendment is
[ADR 0007](../adr/0007-universal-memory-scope.md); test IDs are referenced by
[execution-plan.md](../plan/execution-plan.md) §13 and [m0-spikes.md](../plan/m0-spikes.md).

Test IDs: `CON-*` contract/static, `UT-*` unit, `IT-*` integration (fake ctx / real filesystem),
`ISO-*` isolation, `E2E-*` scratch-profile end-to-end, `SEC-*` security, `UI-*` panel,
`PERF-*` performance, `EXP-*` export, `REL-*` release checks, `DOC-*` documentation, `GOCON-*`
future Go-consumer conformance. This taxonomy plus §15 is the traceability contract.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md)).**
> The headline acceptance test changes from "two sessions in the same workspace" to **"two sessions
> in different directories of the same profile"**: session A in directory X posts, session B in
> directory Y sees it in the pulse, `confluence_board`, the panel and the export, and B's
> `confluence_recall` can find text spoken in A. `ISO-01/ISO-02` (same/different directory) become
> provenance and cross-directory-visibility tests instead of isolation tests; `disabledWorkspaces`
> tests become deprecation-warning tests; `privateSessions` remains load-bearing. The legacy read-only
> merge (v0.1.0 per-workspace journals appear with labels, files byte-identical) is a new required
> test. The workspace-isolation wording below is the v0.1.0 plan; read "workspace isolation" as
> "profile-boundary + provenance correctness" for v0.2.0.

---

## 1. What the tests must prove (and for whom)

The design promises three things; tests exist only to make those promises checkable:

1. **Awareness is free and stable.** The pulse reaches every step, is byte-stable, bounded, escaped,
   and produces **zero** new tokens/messages when nothing changed (the central product claim).
2. **Memory is shared, bounded and safe.** Board notes, ledger metadata and recall hits are
   profile-wide (by design), append-only, redacted, capped, off the prompt path, and never
   auto-injected; `privateSessions` removes a session completely.
3. **The system is offline and upgrade-tolerant.** No network, no port, no child process, no model
   call; optional DSH services degrade instead of crashing; unknown records/events are tolerated.

Constraints that shape the strategy: Windows 11, Node.js 22.19, DSH 0.2.2-rc.1, **no CI** and no
network-dependent tooling; tests must run locally with `node --test` and one PowerShell harness.
Zero runtime dependencies means `node --test` is the whole test framework — no test libraries, no
network installs.

## 2. What CANNOT be verified in a design-only repository

This table is the **design-phase** record (2026-11-13). For the v0.2.0 tree, §9a and the §14 v0.2.0
rows carry the executed offline evidence; the rows below stay as the honest baseline of what was
unknown when the specification was written.

| Claim / area | Status in this phase | Why | What would verify it later |
|---|---|---|---|
| Any runtime behavior of Confluence | **Not executed** | No M1–M4 source exists yet; the scaffold only validates config | M1+ test suites + gates G2–G5 |
| Agent-loop runtime-context dedupe (zero-token pulse) | **Source-read only** (`dsh-agent-loop` commit logic) + `HYPOTHESIS:` | No plugin was installed; no live step observed | M0-S1 + E2E-02 |
| `sessionProjections` fold across resume/fork/compaction | **Source-read only** | Service exists; no unit registered/executed | M0-S2 + UT-WM-05/E2E-05 |
| PTC presentation / `tool/ptc-dispatch` shape | **Source-read only** | Default preset claim from package source | M0-S3 + E2E-07 |
| Client `host.call` host registration contract | **Unverified** — client inspect provider timed out (10 s) during the design session on 2026-11-13 (`Builtin.listBuiltins`), and no live page was connected | Client inspection unavailable; builtin known from design-session facts only | M0-S6; otherwise UI-05 uses the proven webServer fallback |
| Client slot props / rendered panel | **Unverified** | Same client-inspection limitation; slot names come from installed bundles + Crisp/dsh-context registrations | M3 UI verification + M0-S6 |
| Multi-window process topology | **`HYPOTHESIS:`** | Not measured | M0-S5 |
| Performance budgets (pulse/append/merge/recall) | **Unknown** | No code to measure | PERF-01..04 at M1/M4 |
| Multi-process store behavior on this machine | **Unknown** | No store yet | IT-01/IT-08 + M0-S4 |
| Windows network-drive / non-NTFS degradation | **Unknown, untested** | No such drive in the design-time environment | Manual checklist at M4 if the user has one |
| Real-model tool adoption and prompt-injection resistance | **Not automatable** | Stubs only; model behavior with real content is a dogfood/trust question | Manual dogfood review + hostile fixtures as *content* tests |
| User trust / "is quiet enough to keep enabled" | **Not verifiable before dogfood** | Product-level judgment | Post-release dogfood survey/notes; v2 gate |
| Other DSH versions, non-Windows, non-Node-22 | **Out of scope for v1** | Single target pinned in the ADR | Re-run M0-S1/S2 on upgrade (CON-UPGRADE-01) |
| `solo-bench` consumption of the export | **Not executed (future)** | Merge is out of scope this phase | GOCON-* after the merge phase; fixtures shipped in M4 |

Corollary: in the verification-status table (§14), every runtime test is `Not executed` until its
milestone runs; only design-time evidence (source reads, inspect queries) may be `Executed`.

## 3. Test layers and where they run

| Layer | Runtime needed | Speed | What it anchors |
|---|---|---|---|
| Contract/static (`CON-*`, `SEC-04`, `DOC-*`) | Node only, no DSH | ms | Packaging, manifest, no-imports/no-network invariants, docs claims |
| Unit (`UT-*`) | Node only, hermetic | seconds | Pure logic: store merge, records, pulse rendering, folds, redaction, schemas, config |
| Integration (`IT-*`, `ISO-*`, `SEC-*`) | Node + temp dirs; two child processes for multi-writer | seconds–minutes | Real `fs` behavior, two-process merge, isolation, hostile fixtures, fake-ctx tool execution |
| Scratch E2E (`E2E-*`) | Installed DSH launcher + scratch profile + local mock provider | 2–10 min | The real loop: committed pulse, dedupe, activation, no injections, no egress |
| UI (`UI-*`) | Real Harness page (web) | minutes | Slots, panel render, transport, tokens/locale, read-only behavior |
| Performance/soak (`PERF-*`) | Node (+ E2E for some) | minutes–30 min | Budgets and stability at caps |
| Export/consumer (`EXP-*`, `GOCON-*`) | Node; Go later | seconds | Export determinism + future reader conformance |

Rule: a behavior that runs inside the agent loop MUST have at least one `E2E-*` assertion; a behavior
that only produces bytes (`renderPulse`, merge, export) may be proven by `UT-*` alone.

## 4. Environment isolation (applies to every executable test)

| Rule | Concrete requirement |
|---|---|
| Scratch `DSH_HOME` only | `$env:DSH_HOME` set to `.tmp\<suite>\dsh-home` (gitignored) before any DSH process; assert the real `C:\Users\71408\.dsh` is **not** opened/modified (spot-check mtimes of `profiles/desktop/package.json` and `storages/`, and assert no scratch profile dir appears under the real home). |
| Scratch profile only | `dsh --profile <scratch> --from-default-profile headless --dump-config`; never `desktop` (Electron-managed, rejects `--dump-config`). |
| No network | Tests use only loopback (`127.0.0.1`) local mocks; no external URL is contacted; no package installs (zero deps); `SEC-04` statically forbids network modules/URLs in runtime files. |
| No real user data | Fixtures are synthetic; no session logs from the real profile are read into tests; evidence files contain no prompts/answers/secrets. |
| Determinism | Unit/integration tests use fixed clocks injected as `now()` parameters where order matters; no sleeps longer than the poll contract; Windows process tests use bounded waits with explicit timeouts. |
| Cleanup | Tests create temp dirs under the OS temp dir or `.tmp/` and remove them in `finally`; failed E2E runs preserve artifacts under `.tmp/e2e/.../logs` and print the path. |
| Node version guard | Tests assert `process.version` major ≥ 22 when `engines` says so (CON-07); render/pulse byte tests pin `\n`, UTF-8, no locale-dependent formatting. |

## 5. Contract and static tests (`CON-*`)

Run against the repository, not the runtime. Implemented in `test/contract.test.js` +
`scripts/check.mjs`.

| ID | Assertion |
|---|---|
| CON-01 | `package.json`: `name: dsh-confluence`, `version` semver, `private:true`, `type:"module"`, `main`/`exports` resolve to existing files, `dsh.bundle.patch` points at an existing YAML file |
| CON-02 | Runtime host files (`.js` under package root/`lib/`) are plain ESM and contain **no static** `@deepseek-ai/*` imports (`import ... from '@deepseek-ai/…'` / `require`) — optional dynamic imports behind `try/catch` are allowed and enumerated |
| CON-03 | Client `client.js` is a plain `window.__ModuleLoader__.load({id, factory})` module, imports no Harness client package and returns `{inject, apply}` |
| CON-04 | `cordis.patch.yml` parses; contains exactly one `insert` row with id `confluence`; its `config` has exactly the documented v1 default keys (no missing/extra top-level sections) |
| CON-05 | `locale/en.json` + `locale/zh.json` parse; both have non-empty `meta.title`/`meta.description`; every key used by panel/tool-facing UI strings exists in both; no template copy |
| CON-06 | `files` + `exports` cover every runtime file (index, client, lib/**/*.js, patch, locale, icon) — checked by walking the package tree |
| CON-07 | `engines.dsh` is `>=0.2.2-rc.1`; `engines.node` present; activation emits a warning when the running version is outside the declared range (code path test via injected version) |
| CON-DATA-01 | Journal record fixtures validate the documented line schema: `v`, `type`, `ws`, `seq`, `ts` required; known types restricted to the documented set; unknown types in a fixture are ignored by the parser |
| CON-TOOL-01..06 | One test per model-facing tool (`confluence_board`, `post`, `read`, `search`, `reply`, `recall`): name is snake_case + unique, description states purpose + the untrusted-data rule, parameter schema has correct required/optional/enum fields, output render returns text blocks |
| CON-PULSE-01 | Pulse registration options are exactly `{name:'confluence:pulse', order:1500, required:false, interpolate:false}` (static AST/regex check on the source; M1 uses this as a regression guard) |
| CON-PULSE-02 | Runtime pulse sources contain no `Date`/`Date.now`/timers/`agent.inject`/`followup`/disk reads on the assembly path (static scan + a unit-time fs monkeypatch that throws) |
| CON-UI-01 | Manifest `dsh.client` has `platform:"web"`, `immediately:true`, a valid `inject` list; panel registration ids/keys are the documented ones |
| CON-UPGRADE-01 | A documented DSH-upgrade checklist exists (re-run M0-S1/S2, re-run E2E, record versions); checked at release — **manual check, not a runtime test** |
| DOC-01 | Every relative Markdown link in `README.md`/`docs/**` resolves to an existing file (offline link check; no network) |
| DOC-02 | Documentation claims match the verification-status table: nothing claimed as working is marked `Not executed`/`Blocked`; v1 is described as "awareness + on-demand literal search", not automatic retroactive indexing |
| DOC-03 | Privacy statements exist for stored-vs-read content, redaction limits, opt-outs, and export opt-in |

## 6. Unit tests (`UT-*`)

All hermetic: fake DSH `ctx` helpers or pure functions, temp directories, no DSH process. Each unit
test must be fast (<100 ms typical) and deterministic. In §6.1–§6.9 the section heading names the ID
range and each table row is the numbered test in order (row `02` in §6.4 = `UT-PULSE-02`).

### 6.1 Store conformance — `UT-STORE-01..12`

| ID | Assertion |
|---|---|
| 01 | A valid record line round-trips: parse → object → serialize → byte-identical canonical fields |
| 02 | Unknown record types are ignored by the reader; unknown fields are preserved in memory and on re-serialize |
| 03 | `seq` ULIDs are lexicographically time-sortable and unique across writers; two records at the same ms still sort deterministically |
| 04 | Shard naming `journal.<writerId>.v1.jsonl`; writer id is `<pid>-<random>` and stable per mount |
| 05 | Append writes complete lines only (a record whose serialization exceeds the 64 KiB line cap is rejected before writing) |
| 06 | Merge across N shards yields global `seq` order; deterministic on repeated reads |
| 07 | Dedupe: duplicate board entry ids collapse **first-by-`seq` wins** (content mismatch logged, never rewritten); `session` records last-wins per session id |
| 08 | Multi-writer synthetic shards (fixture files) merge to the expected merged snapshot (golden file) |
| 09 | Torn trailing line (no `\n`) is ignored; all complete prior records are returned |
| 10 | After a later complete append, the formerly torn tail is still ignored and the new record is visible |
| 11 | Crash simulation: truncated final record + valid prefix reads cleanly; no exception escapes |
| 12 | Poll refresh: mtime/size change triggers re-read; `fs.watch` throwing/unsupported degrades to polling with one warning, never crashes |

### 6.2 Origin keys — `UT-WS-01..06` (v0.2.0: provenance, not a scope)

| ID | Assertion |
|---|---|
| 01 | Canonicalization: `header.cwd` → `fs.realpath` → win32 lower-case fold (path with `.`/`..`, trailing separator, mixed case all map to one key) |
| 02 | `wsKey = "ws_" + sha256(canonicalPath).slice(0,16)` with the full canonical path stored in workspace metadata (collision detectable) |
| 03 | Caching: a session's origin is resolved once for display purposes; a later `cd` does not rewrite existing records (origin is provenance, never a scope) |
| 04 | Fallback: `header.cwd` absent → effective directory from `ctx.workingDirectory.get(session)` resolved once |
| 05 | Unresolvable directory → no key → no tools, no pulse text, ledger row absent (no throw) |
| 06 | Distinct directories that share a basename → distinct keys; symlink/junction to the same target → same key |

### 6.3 Board records — `UT-BOARD-01..06`

| ID | Assertion |
|---|---|
| 01 | All six kinds accepted; unknown kind rejected; caps enforced (`maxBodyBytes` 8192, title/tags/files limits) |
| 02 | Entries are immutable: no code path mutates a stored entry; corrections require new entries/tombstones |
| 03 | `reply_to` links a reply to a parent (and thread rendering shows both); `resolves` closes a question/handoff; `supersedes` marks the superseded id |
| 04 | Queries: unread count, open questions/handoffs, counts line are deterministic for a seeded fixture and independent of scan order |
| 05 | `maxEntriesPerWorkspace` (2000) is enforced at the boundary (write rejected with a clear tool error, or oldest are dropped per the frozen store rule — the rule must be stated in `store-format.md`) |
| 06 | Provenance (`sessionId`, session title, origin) is written from `exec.agent` only; a hostile `files`/`tags` value cannot spoof another session id |

### 6.4 Pulse determinism and budget — `UT-PULSE-01..07`

| ID | Assertion |
|---|---|
| 01 | Template: opening/closing tag with attributes (`name`, `peers`, `unread`, `seq`), fixed untrusted warning, `New:` headlines, `Open:` counts, `Here now:` peers, guide line — in the documented order |
| 02 | Byte-stability: same snapshot → byte-identical string across 1 000 calls and across two processes with different wall clocks; no timestamps/ages/status words appear |
| 03 | Escaping: `<`, `&`, U+2028/2029 in any field are `\uXXXX`-escaped; a note containing `</confluence-memory>` cannot forge the closing tag |
| 04 | Caps: ≤3 headlines, ≤2 peers, names/headlines truncated deterministically (same input → same truncation), empty sections omitted, counts line always consistent |
| 05 | Hard cap: rendered length ≤1 400 chars for adversarial fixtures; measured chars/bytes recorded in the test output as the budget evidence |
| 06 | Welcome digest: a fresh session gets ≤3 newest entries + every open question/handoff up to the cap, with the `seq` cursor set to the rendered head (later steps see only newer items) |
| 07 | Empty state: nothing new and no peers → exactly `''`; the fixed warning appears only when text is non-empty |

### 6.5 Watermarks — `UT-WM-01..07`

| ID | Assertion |
|---|---|
| 01 | `digestSeq` folds from the `seq="…"` attribute of the `confluence:pulse` **named section** (`source.sections[].name`) inside a committed runtime-context `user/message` (synthetic event stream; ADR 0003 §2) |
| 02 | `boardReadSeq` folds from the `through=<cursor>` marker line in committed tool results — `tool/result` under `standard`, `tool/ptc-dispatch` under `ptc` |
| 03 | The two cursors are independent: reading the board advances only `boardReadSeq`; a pulse commit advances only `digestSeq` |
| 04 | Resume: replaying the committed events reproduces the same states without plugin memory |
| 05 | Fork: child state starts from the copied prefix's cursors (synthetic child session with `inheritedEventCount`) |
| 06 | Garbage/truncated marker keeps the previous value; unknown/compaction events do not reset state; `apply` is pure (same reference when ignored) |
| 07 | `sessionProjections` unavailable → in-memory per-agent fallback produces the same rendered pulse for the current process (documented degraded mode, not silent) |

### 6.6 Tools — `UT-TOOL-01..09`

| ID | Assertion |
|---|---|
| 01 | `confluence_board`: `limit` 1–10 validation, `include_resolved` honored, result contains unread headlines/open items/peers/recent sessions and a `through=` marker; marks read |
| 02 | `confluence_post`: kind enum, title required, body/tags/files validated, caps enforced, result id + seq; appends exactly one entry |
| 03 | `confluence_read` board ref: returns entry + thread, `through=`; unknown id → clear tool error |
| 04 | `confluence_read` `session:<id>:<seq>` ref: bounded ≤3-event window, untrusted framing, no whole-log replay; unknown ref → clear error |
| 05 | `confluence_search`: text/kind/tag/limit filters; board only (never session logs); empty result text is explicit |
| 06 | `confluence_reply`: appends a reply; resolves/reopens only questions/handoffs; cannot resolve a `finding` |
| 07 | `confluence_recall`: schema, provenance ref format, "literal match only; partial" framing, caps, timeout marking |
| 08 | Activation `when`: only a private session hides the tools; a session with no resolvable directory still gets all six (universal memory, origin optional) |
| 09 | Universal authority: arguments cannot set/override a scope or workspace; a crafted `ref`/id that does not exist (`NOT_FOUND`, no oracle); a tool call without `exec.agent` throws the clear "requires an agent session" error |

### 6.7 Ledger — `UT-LEDGER-01..04`

| ID | Assertion |
|---|---|
| 01 | `turn/end`, `tool/call`, `tool/ptc-dispatch` fold into one session row (turn count, last activity, status) — including the ptc-only case where `tool/call` is absent |
| 02 | Path extraction: only write/edit-style tool calls contribute; ≤8 distinct paths; workspace-relative; `..`/absolute/UNC/device paths rejected; deny patterns filtered; symlink escapes denied |
| 03 | Title comes from `sessionQuery.readTitle` when available, redacted; a missing title falls back deterministically and never breaks the row |
| 04 | Metadata-only field allow-list: the emitted `session` record contains no prompt/assistant/tool-output/reasoning/command-line content (partner to SEC-02) |

### 6.8 Recall — `UT-RECALL-01..06`

| ID | Assertion |
|---|---|
| 01 | Enumerates via `listSessions()`, excludes the caller and `privacy.privateSessions`; **no directory/workspace filtering** — a session in a different directory is eligible |
| 02 | Caps: ≤`recall.maxSessions` (3) sessions and ≤`recall.maxHits` (5) hits total; selection order is recency-deterministic |
| 03 | Each hit is ≤600 chars, carries `session:<id>:<seq>` provenance, and the output says "literal match only; partial" |
| 04 | Cooperative timeout (`recall.timeoutMs` 5000): slow fake `sessionQuery` returns partial results marked as timed out, no throw, no unhandled rejection |
| 05 | Read-only: recall never appends to the journal, never calls `agent.inject`, never runs inside the pulse provider, and never replays a whole cold log (fake records calls) |
| 06 | **Private-target exclusion (load-bearing privacy control):** a target session listed in `privateSessions` is excluded from recall enumeration even when it matches the literal text; `confluence_read` on a `session:<id>:<seq>` ref to such a session behaves as not-found (clear error, no content, no excerpt). The removed `disabledWorkspaces` key only yields a deprecation warning (v0.2.0). Covers ledger-recall §6.3/§8.2 and security-privacy §5.4 |

### 6.9 Config, privacy, redaction, paths, degradation, export

| ID | Assertion |
|---|---|
| UT-CONFIG-01 | Defaults exactly match ADR §10 (all sections/fields/values); object is frozen |
| UT-CONFIG-02 | Bad values (wrong type, out-of-range, unknown enum) fall back to defaults and appear in activation warnings; never throw during activation |
| UT-CONFIG-03 | Unknown config keys are ignored; a user override replaces the whole config object (documented loader behavior) and still yields complete defaults |
| UT-PRIV-01 | `privateSessions` → no ledger row, no pulse mention, scoped `suppressRuntimeContext()`; store writes for that session are skipped |
| UT-PRIV-02 | `privateSessions` → no tools, no pulse, no ledger/presence for that session only; the removed `disabledWorkspaces` key yields `CONFIG_DEPRECATED privacy.disabledWorkspaces` and is ignored |
| UT-PRIV-03 | Opt-out/opt-in is reversible in-session; toggling does not corrupt existing board data or cursors |
| UT-REDACT-01 | API-key patterns (`sk-…`, `ghp_…`, `AKIA…`, `xox…`) are redacted in bodies/titles/paths |
| UT-REDACT-02 | PEM private key blocks, JWTs, and `password=`/`token=` assignments are redacted; redaction is labeled "best effort" in docs |
| UT-REDACT-03 | `redactTitles:true` redacts titles; `false` leaves them (documented tradeoff) |
| UT-REDACT-04 | Recall excerpts are re-redacted after extraction |
| UT-REDACT-05 | Export output is redacted and contains no absolute/home path strings |
| UT-REDACT-06 | Redaction never mangles already-clean content (false-positive guard on a benign corpus) |
| UT-PATH-01 | All store writes stay under the configured store root (realpath containment check) |
| UT-PATH-02 | Workspace-relative validation rejects `../x`, `C:\x`, `\\server\share`, `\\.\device`, empty, and over-long paths |
| UT-PATH-03 | Deny-dotfile patterns and symlink-out-of-workspace hints are filtered; a junction pointing outside the workspace is refused |
| UT-DEGRADE-01 | `sessionQuery` absent → recall disabled with a clear tool error; board/pulse/ledger still work |
| UT-DEGRADE-02 | `sessionProjections` absent → in-memory watermark fallback (UT-WM-07) |
| UT-DEGRADE-03 | `webServer`/`workingDirectory`/`workspaceRegistry` absent → plugin stays active, feature-gated, one warning; never throws at activation |
| UT-EXP-01 | Compaction lease: acquire via `wx`, stale-PID takeover, release; a concurrent compactor backs off without corrupting the store |
| UT-EXP-02 | Snapshot merge is deterministic; `MANIFEST.v1.json` is published atomically (temp + rename); a crash before publish leaves the old manifest valid |
| UT-EXP-03 | Retention/prune removes only eligible generations; readers never fail on a pruned generation they already listed |

## 7. Integration tests (`IT-*`), isolation (`ISO-*`) and security fixtures (`SEC-*`)

Integration tests use a **fake Cordis ctx** (`test/helpers/fake-ctx.mjs`) that implements only
documented service surfaces (`get`, `on`, `effect`, `systemPrompt.context`, `tools.register`,
`sessionProjections.register`, `workingDirectory.get`, `sessions`, `agents`, a fake `sessionQuery`),
plus real temp-directory stores. If the fake and the real API diverge, the E2E suite is the tie-breaker.

| ID | What it does / asserts |
|---|---|
| IT-01 | **Scratch smoke (G2):** install the bundle in a scratch profile, boot one headless run against the local stub; assert activation log line, pulse registration present, store files created under the scratch `DSH_HOME`, no crash, real profile untouched; fast path used at the M1 gate before the full E2E exists |
| IT-02 | **Poll freshness:** writer A appends via a second process; reader observes within `pollMs` + slack; with `fs.watch` disabled it still works through polling; stale reader never crashes |
| IT-03 | **Cross-directory share (two sessions, the v0.2.0 headline):** session A in directory X posts; session B in directory Y (same profile) renders the entry (pulse or `confluence_board`); no workspace key is passed; ordering/seq monotone |
| IT-04 | **Pulse content:** seeded snapshot renders the scope label ("All sessions"), unread headlines, peers, counts within caps; the same seeded data yields the golden pulse file byte-for-byte |
| IT-05 | **Welcome digest:** a fresh session sees the bounded welcome set and the cursor head; a second render does not repeat it |
| IT-06 | **Recall plumbing:** fake `sessionQuery` with synthetic sessions from several directories plus a private one; hits come from all eligible sessions, private excluded, caps and provenance honored, run count of `filterEvents` bounded |
| IT-07 | **Optional-service absence:** run the suite with `sessionProjections`/`sessionQuery`/`webServer` removed from the fake ctx; plugin activates, features degrade with warnings (UT-DEGRADE cross-check) |
| IT-08 | **Two-writer merge:** spawn two real Node writer processes (test harness only) × 1 000 lines each into one store; merge has zero loss/duplication/malformed lines; repeated merge byte-identical (M0-S4 promoted) |
| IT-09 | **Legacy read-only merge (v0.2.0):** a seeded v0.1.0 `workspaces/ws_<16hex>/` journal appears in the global view/pulse/export with its manifest label as provenance; its files are byte-identical after the run (mtime/content) |
| ISO-01 | Same directory via different spellings/case/trailing slash → the same `origin` label; both sessions share one global board |
| ISO-02 | Different directories (including the same basename in different parents) → **shared board/pulse/recall**, distinct provenance labels; nothing is isolated by directory |
| ISO-03 | Junction/symlink to a target resolves the origin via realpath; a hint path that escapes via junction is refused |
| ISO-04 | `privateSessions` isolation: a private session's activity never appears in another session's pulse or ledger output; recall enumeration excludes private target sessions and refs to them are not-found (UT-RECALL-06) |

**Security fixtures (`SEC-*`)** — content/security tests, not model-behavior tests:

| ID | Assertion |
|---|---|
| SEC-01 | Fixed untrusted-data warning present in the pulse and in tool results that carry shared text; no shared text is rendered as instructions/system content |
| SEC-02 | Journal field allow-list: drive every write path with content markers and scan all emitted records — markers must appear only in the allow-listed `entry.title/body/tags` and `session.title` fields, never in metadata records |
| SEC-03 | Redaction end-to-end: for the secret corpus, the on-disk journal bytes, `confluence_board` render, recall output and export contain no raw secret match |
| SEC-04 | No-egress static scan: runtime files import none of `node:http|https|net|dgram|tls|dns`, contain no `fetch(`/`XMLHttpRequest`, no non-loopback URL literals, no `child_process`, no listening server; `scripts/check.mjs` fails the build if any appears |
| SEC-05 | Hostile path fixtures (UNC, device names, `..` traversal, reserved Windows names like `CON`, very long paths) are rejected or ignored without crash |
| SEC-06 | Panel data channel: same-origin/fenced (or `host.call` contract with its authorization), `cache-control: no-store`, payload bounded, no prompts/assistant text/secrets/absolute paths in the payload |

## 8. Hostile-note / prompt-injection fixtures

Shared memory is untrusted input by definition. Fixtures live in
`test/fixtures/hostile/` (JSON entries fed to the board/journal/pulse/recall code paths):

| Fixture | Content | Expected behavior (automated) |
|---|---|---|
| `close-tag.json` | `</confluence-memory>`, `<confluence-memory …>`, `</confluence-workspace>` (legacy), nested fake tags in title/body | escaped as `\u003c…`; rendered pulse still has exactly one real closing tag |
| `instructions.json` | "ignore previous instructions", "you are now…", fake tool requests, fake system prompts, fake permission claims | rendered only as data with the fixed warning; no tool execution path treats it as instruction (the model's behavior is **not** automatable — manual dogfood only) |
| `control-chars.json` | U+2028/2029, NUL, ANSI escape, bidi RTL override, zero-width chars, lone surrogates | deterministic escaping/sanitization; no control character reaches the prompt or terminal/log output |
| `structure.json` | `{{var}}`, `{seq:1}`, JSON that looks like a runtime-context snapshot or a `through=` marker, fake `session:<id>:<seq>` refs, markdown code fences | does not confuse the projection fold or recall ref parsing; markers only count from their documented event positions |
| `size.json` | 100 KB title, 1 MB body, 10 000 tags | rejected/clipped at caps; no exception; journal line stays ≤64 KiB |
| `secrets.json` | API keys/JWTs/PEM/passwords in title/body/tags | redacted before persistence and before render (SEC-03) |
| `unicode.json` | CJK, emoji, combining marks, RTL text | UTF-8 preserved; truncation never splits a surrogate pair; byte/char caps use documented units |

Manual (dogfood, not automatable): after M2, run a session where a hostile note is deliberately
posted between two benign sessions and review whether the agent (a) treats it as data, (b) does not
execute instructions from it, (c) still uses the board. Record observations in the dogfood notes; do
not encode a pass/fail for model behavior in CI-less tests.

## 9. Offline E2E harness design (mirrors Crisp's `scripts/e2e-dsh.ps1`)

**Files**

```text
scripts/e2e-dsh.ps1                 # orchestrator (PowerShell 7), mirrors Crisp scripts/e2e-dsh.ps1
test/e2e/mock-provider/server.mjs   # local loopback Messages/OpenAI-compatible SSE stub + request recorder
test/e2e/scenarios/*.json           # scripted responses + expectations per scenario
test/e2e/fixtures/dirs/…           # synthetic project dirs (alpha, beta, case-variant) for provenance
test/e2e/run-summary.schema.json    # shape of summary.json (optional)
```

**Flow** (adapt Crisp §6.1 steps; reuse its postmortem lessons, not its Go code):

1. Find the `dsh` launcher: explicit `-DshPath`, then `PATH`, then the known install
   `…\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`. If not found, print `SKIPPED`, write
   `summary.json`, exit **0**.
2. Create an isolated `DSH_HOME` and a scratch profile from the shipped `headless` template under
   `.tmp/e2e/dsh/run-<stamp>/`; assert no scratch profile appears in the real `~/.dsh`.
3. Register the bundle: `dsh plugin --profile <scratch> add <repo>`; assert the profile manifest
   contains the linked package and `--dump-config` shows the `confluence` row.
4. Seed synthetic project dirs: `alpha/` (session 1), `beta/` (session 2 — must share the same memory
   in v0.2.0), case/traversal variants (provenance labels only); seed a board store with 2–3 entries
   for the pulse scenario (or drive them via a first session).
5. Start `node test/e2e/mock-provider/server.mjs` on `127.0.0.1:<ephemeral>`; it writes every
   request body to `logs/mock-provider.jsonl` and answers from the scenario queue (text-only and,
   where available, scripted tool calls). Point the headless run at it via the env routing Crisp
   proved (`DEEPSEEK_BASE_URL` + key/model vars; `HYPOTHESIS:` same for 0.2.2-rc.1).
6. Write a `--patch` overlay that points `store.dir`/`debug.logFile` into the run artifacts and
   keeps `pulse.enabled:true`; run the scenarios sequentially with bounded timeouts
   (`-ScenarioTimeoutSec`, default 240).
7. Assert (see below), write `summary.json` (dsh/node versions, bundle path, scenario results,
   artifact paths), keep logs, clean up processes/env in `finally`.
8. Exit codes: **0** all checks passed or skipped, **1** any check failed.

**Assertions** (each is a named E2E check):

| Check | Assertion |
|---|---|
| E2E-00 | Install/activation: scratch profile created; bundle registered; row composes via `--dump-config`; activation log line written; real profile untouched |
| E2E-01 | First request body contains the pulse text (`<confluence-memory scope="global" …>`, entries, fixed warning); the text is committed as a runtime-context snapshot whose section name identifies the pulse |
| E2E-02 | Dedupe: a second step/turn with an unchanged board does **not** add another snapshot (request bodies show the same single snapshot; debug log shows `pulse_skipped_unchanged`); changed-text append behavior matches ADR 0003 §4 (history grows per change — assert the design does not rely on collapse) |
| E2E-03 | **Cross-directory share (the v0.2.0 headline):** session 1 in `alpha/` posts a note via `confluence_post`; session 2 in `beta/` (same profile, different directory) receives it in its pulse and sees it with `confluence_board`; `confluence_recall` in session 2 finds text spoken in session 1; no workspace key appears in any request |
| E2E-04 | No `agent/inject`/`followup`/inbox splice: zero `agent/inbox/spliced` events, no injected user message in the request bodies, plugin debug log has zero injection records |
| E2E-05 | Resume/fork cursor continuation (if headless resume exists; otherwise partial: `IT` covers the fold and the E2E check is recorded as `BLOCKED` with reason) |
| E2E-06 | Zero egress: mock receives only the expected provider calls; static scan clean; no listening port for the plugin; no child process; run fails if any unexpected request/connection is observed |
| E2E-07 | `ptc` preset: a Confluence tool is reachable through `run_code` SDK bindings (or the scenario is recorded `BLOCKED` with M0-S3's outcome); under `standard`, a direct tool call returns a result with `through=` |

**How network is avoided:** the mock binds to `127.0.0.1` only; every workspace/DSH path is under
`.tmp/`; no package installation or registry access happens; the model provider env is the loopback
mock; `CON-02`/`SEC-04` scan the runtime for network imports/URLs; the harness records all sockets
it sees. Residual honesty: the plugin's own socket behavior cannot be perfectly instrumented
without a debugger — the release claim rests on static scan + design review + the loopback-only
provider, stated as such in `docs/verification.md`.

**If tool-call scripting in the mock is infeasible** (schedule risk R11): keep E2E-01..06 as the
required release path (pulse is the product claim) and prove tool execution through `IT`/`UT` fake
contexts; mark the tool-call E2E (`E2E-03`/`E2E-07`) `BLOCKED — model stub limitation` and record
the residual risk. Do not fake a tool call by editing the session log.

### 9a. Executed evidence — v0.2.0 offline E2E (2026-11-16)

Command (from the repository root, PowerShell 7, Node 22.19.0, DSH 0.2.2-rc.1):

```powershell
pwsh -NoProfile -File scripts/e2e-dsh.ps1
```

Run directory: `.tmp/e2e/run-20261116-203730` (kept as evidence; artifact list in
[`test/e2e/README.md`](../../test/e2e/README.md)). Full record:
[`../discussion/v0.2-e2e-evidence.md`](../discussion/v0.2-e2e-evidence.md).

| Evidence | Result |
|---|---|
| `scripts/e2e-dsh.ps1` check table (`summary.json`) | **15/15 PASS, 0 FAIL, exit 0** (E2E-00a..E2E-02 + GUARD-01..03) |
| `test/e2e/assert-e2e.mjs`, re-run against the recorded run | **12/12 checks pass, exit 0** (E2E-01..E2E-12); output persisted at `<run>/assert-e2e.out.txt` |
| Offline suite | `node --test --test-force-exit "test/*.test.js"` → **291/291 pass** |
| Packaging contract | `node scripts/check.mjs` → **17/17 pass** |
| M0 smoke | `node scripts/m0-smoke.mjs` → **14 pass / 0 fail / 1 blocked** (optional `@deepseek-ai/dsh-atomic-write` probe) |

Post-review fixes (R-01..R-14, see [implementation status](../plan/implementation-status.md) §4.2)
landed after the initial run; the evidence above is the post-fix re-run `20261116-203730`. The suite
grew to **291** with `UT-STORE-19` (concurrent single-flight open), `CON-PL-18b` (ledger-head changes
never churn the pulse), `INT-07` (private sessions gated on all six tools), plus the `/opt`, `/etc`,
`/srv`, `~/` cases added to `EXP-12`.

What the run establishes, from committed session logs and mock request bodies (no edited artifacts):

- Session A in `<run>/workspace-a` posted one note; it is in the global journal under
  `dsh-home/storages/confluence/v1/workspaces/ws_0000000000000000/`.
- Session B in `<run>/workspace-b` (different cwd) made no tool calls and received A's note in its
  committed pulse `<confluence-memory scope="global" …>`; C's `confluence_board` listed A's note and
  the seeded legacy note; D's `confluence_read` returned A's note body; E's `confluence_recall`
  returned a `session:<id>:<seq>` hit from a workspace-A session.
- The seeded legacy workspace `ws_1a2b3c4d5e6f7081` (`legacy-alpha`) was merged read-only; its files
  are byte-identical (sha256) and no record was migrated.
- `boardReadSeq` advanced after the board/read sessions and stayed `null` for post-only/pulse-only
  sessions; `digestSeq` committed for readers.
- The real `~/.dsh` profile was unchanged: the pre-existing real store (15 files) contained no run
  artifact and no scratch profile leaked in.
- `summary.json.writerAttempts` = 1; the cold-start writer's first request headers already carried all
  six Confluence tools + the pulse.

Three product bugs surfaced by this run and fixed in the same round (details in
[the evidence note](../discussion/v0.2-e2e-evidence.md)):

1. `parseThroughMarker` accepted the marker only as the last rendered line, so `boardReadSeq` never
   advanced; it now scans every line (`lib/watermark.js:182`).
2. Cold-start activation registered tools/pulse/routes only after the first `await`, so the first
   request missed them; registration is now synchronous before the async store/board/watermark
   attach (`index.js:328-366`).
3. `sessionQuery` was captured eagerly (~150 ms before the service registered), making
   `confluence_recall` permanently unavailable on a cold headless boot; it is now resolved lazily via
   `deps.getSessionQuery` (`lib/recall.js:283`, `index.js:161`).

Still not covered by this evidence: real desktop-profile install + DSH restart (and any real-profile
live smoke), panel rendering, PTC (`run_code`) reachability, multi-window freshness, soak/compaction,
tarball/SHA-256 and publish.

## 10. Performance budgets and measurement

Method: `node:perf_hooks.performance.now()`, 100 warmup iterations, ≥1 000 measured iterations,
report median/p95/p99 in test output and in the release evidence. Fixtures are generated once at
caps: 2 000 board entries, 200 ledger sessions, 3 shards. Timing tests are opt-in
(`CONFLUENCE_PERF=1`) but mandatory at gate G2 (pulse/append) and G5 (soak).

| ID | Budget | Failure policy |
|---|---|---|
| PERF-01 | Pulse assembly (pure render from an in-memory snapshot; 2 000 entries / 200 sessions): **p95 <5 ms, p99 <15 ms**; the provider must do no disk I/O (fs patched to throw) | investigate at G2; >2× budget blocks the gate |
| PERF-02 | Append: **p95 <10 ms** per 1–4 KiB line over 200 sequential appends on local NTFS (fsync batching excluded, measured separately); merge 3 shards × 2 000 records **p95 <30 ms** | same; if the machine contradicts M0-S4, record disk evidence |
| PERF-03 | Recall: with `timeoutMs:5000`, a slow fake store returns in **≤5.6 s** wall with partial results marked; normal recall caps at 3 sessions × 5 hits | hard gate: timeout must never hang the tool |
| PERF-04 | Soak (M4): 30 min, two writer processes, 4 s poll churn, periodic torn lines and view assembly — zero loss/duplication, RSS growth without bound fails, no unhandled rejections | release blocker |

## 11. Test data and fixtures (`test/fixtures/`)

| Path | Content |
|---|---|
| `journal/valid.v1.jsonl`, `unknown-types.v1.jsonl`, `dup-ids.v1.jsonl`, `torn.v1.jsonl`, `oversized.v1.jsonl` | Store parser/merge fixtures (synthetic only) |
| `pulse/golden/*.txt` | Byte-exact expected pulse renders (seeded snapshots: first-run, unread, peers, welcome, empty) |
| `pulse/budget.json` | Measured chars/bytes/token estimates per template section (updated at M1, frozen) |
| `hostile/*.json` | §8 content-injection/control/size/unsecret fixtures |
| `redaction/corpus.jsonl` | Secret→expected-redacted pairs, plus benign false-positive corpus |
| `dirs/{alpha,beta,alpha-case,nested-alpha}/` | Synthetic project dirs (created by the harness at run time, not committed with content); all share one memory space, directories differ only in the provenance label |
| `export/memories.v1.jsonl`, `export/manifest.json` | Export conformance fixtures shared with the future Go consumer (`GOCON-*`); `schema:"confluence.memories/v1"`, `formatVersion:1`, `cnf_` ids, tombstone stubs (store-format.md §14) |
| `export/integrity-stubs/` | **V7 export-integrity fixture:** 2 live entries + 1 tombstone stub; manifest `recordCount:2`, `firstSeq`/`lastSeq` from live records only, `files[0].bytes`/`sha256` over the **complete** file (stub line included); the conformance test asserts the consumer order: verify bytes/hash → parse lines → non-stub line count == `recordCount` (stub lines are valid but counted out) |
| `sessions/synthetic-events.jsonl` | Minimal session-event streams for projection/fold tests (runtime-context snapshots, tool results, unknown events) |
| `config/cases.json` | Default/override/bad-value matrices for UT-CONFIG |
| `notes/benign.jsonl` | Realistic benign notes for false-positive/determinism tests |

Rules: no real user session content, no API keys (fake patterns only, clearly non-working), no
absolute paths from this machine in committed fixtures, small files only (fixtures are bytes tests,
not data sets).

## 12. CI-less local run commands

From the repository root (PowerShell 7; Node 22.19+):

```powershell
# contract + static invariants (also what a release must always run)
node scripts/check.mjs

# fast hermetic suite (unit + contract), no DSH process, no network
node --test "test/*.test.js"
node --test "test/store/*.test.js" "test/tools/*.test.js" "test/pulse/*.test.js" "test/integration/*.test.js"

# performance budgets (opt-in, non-hermetic timings; run on the release machine)
$env:CONFLUENCE_PERF = '1'; node --test "test/perf/*.test.js"

# two-writer stress (real processes, temp dirs)
node test/stress/two-writers.mjs --entries 1000 --shards 2

# scratch-profile offline E2E (real dsh launcher; local loopback mock; SKIPs with exit 0 if dsh missing)
pwsh -File scripts/e2e-dsh.ps1
pwsh -File scripts/e2e-dsh.ps1 -DshPath 'C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

# inspect the latest E2E run
Get-ChildItem .tmp\e2e\dsh -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  ForEach-Object { Get-Content (Join-Path $_.FullName 'summary.json') }
```

No `npm install` is required or allowed (zero dependencies); no test needs network; the E2E's local
mock is the only "server" and binds loopback only.

## 13. Test ownership and gate mapping

| Gate | Required before the gate can pass | Owner |
|---|---|---|
| G2 (M1 core) | ALL M1 `UT-*` + `CON-*` green; `IT-01`; PERF-01 measured; pulse budget recorded | E1 + V |
| G3 (M2 behavior) | E2E-00..06 (07 if PTC path available); ISO-01..04; UT-RECALL/REDACT/LEDGER; SEC-02/03/04; IT-08 | E2 + V |
| G4 (M3 UI) | UI-01..06; SEC-06; CON-UI-01; no-egress remains green | E3 + V |
| G5 (M4 release) | UT-EXP/EXP-01..05; PERF-02..04; REL-01..04; DOC-01..03; full E2E re-run with the final build | V + Lead |

Release and future-consumer checks:

| ID | Check |
|---|---|
| REL-01 | Contract/static suite green on the release commit (`scripts/check.mjs` + `test/contract.test.js`) |
| REL-02 | Scratch-profile install + activation + mock-model E2E evidence recorded (E2E-00..06); real profile untouched |
| REL-03 | No-egress / no-port / no-child-process audit (SEC-04 + source review) recorded |
| REL-04 | Docs and verification-status table complete; ADR deviations listed |
| GOCON-01..03 | **Future, after the solo-bench merge:** a valid export (`schema`/`formatVersion` + `files[0]` hash/bytes + `recordCount`/`firstSeq`/`lastSeq`) parses; malformed/hash-mismatch/unknown-`formatVersion` exports are rejected with clear errors; tombstone stubs are validated, filtered and excluded from counts. Fixtures: `test/fixtures/export/`; definition: [solo-bench-integration.md](solo-bench-integration.md) §9 |

## 14. Verification-status table (template and current state)

Rules: statuses are exactly `Executed`, `Partial`, `Not executed`, `Blocked`. `Executed` requires a
command and an artifact path/commit. "Documented" is never `Executed`. Fill one row per gate; keep
the old rows (history) rather than overwrite. The v0.2.0 rows appended below are dated 2026-11-16.

| ID | Requirement | Status (2026-11-13, design phase) | Evidence (command + artifact) | Date | Notes |
|---|---|---|---|---|---|
| CON-* | Packaging/static invariants | **Executed** | `node --test "test/*.test.js"` → 18/18 pass; `node scripts/check.mjs` → 11/11 pass | 2026-11-13 | Packaging contract only; no runtime behavior claimed |
| UT-* | Unit suite | **Not executed** | — | — | No M1+ code exists |
| IT-* / ISO-* | Integration/isolation | **Not executed** | — | — | No store/tools exist |
| E2E-* | Scratch-profile offline E2E | **Not executed** | — | — | No harness yet; design only |
| UI-* | Panel | **Not executed** | — | — | No client half yet |
| PERF-* | Performance budgets | **Not executed** | — | — | Planned for M1/M4 |
| EXP-* / GOCON-* | Export + future Go consumer | **Not executed** | — | — | M4 / future merge |
| Design fact: loop commit-only-on-change | Source-read | **Partial** | `docs/research/dsh-internals.md` fact 6 (`dsh-agent-loop/lib/index.js:333-348`) | 2026-11-13 | M0-S1 makes it Executed or fallback |
| Design fact: projection service surface | Inspect query | **Executed** | `docs/research/dsh-internals.md` §10 (`cordis_inspect_query` host Service `sessionProjections`) | 2026-11-13 | Live profile; signatures recorded |
| Design fact: client builtin list | Inspect query | **Blocked** | `Builtin.listBuiltins` timed out after 10 s (design session, 2026-11-13) | 2026-11-13 | M0-S6 retries with page open |
| Design fact: `host.call` host contract | Source | **Blocked / HYPOTHESIS** | — | — | M0-S6 |
| Design fact: multi-window topology | Process measurement | **Not executed** | — | — | M0-S5 |
| Release checklist REL-01..04 | Release evidence | **Not executed** | — | — | G5 |

**v0.2.0 rows (appended 2026-11-16):**

| ID | Requirement | Status | Evidence (command + artifact) | Date | Notes |
|---|---|---|---|---|---|
| CON-* | Packaging/static invariants (v0.2.0) | **Executed** | `node --test --test-force-exit "test/*.test.js"` → 291/291; `node scripts/check.mjs` → 17/17 | 2026-11-16 | Contract tests now 23; checker 17 checks |
| UT-* | Unit suite (v0.2.0) | **Executed** | part of the 291/291 run (module suites: store/workspace/board/pulse/watermark/ledger/presence/recall/tools/export/hostui) | 2026-11-16 | — |
| IT-* / ISO-* | Integration/isolation (v0.2.0) | **Executed** | part of the 291/291 run (`test/integration.test.js`, isolation fixtures) | 2026-11-16 | — |
| E2E-* | Scratch-profile offline E2E (v0.2.0) | **Executed** | `pwsh -NoProfile -File scripts/e2e-dsh.ps1` → 15/15 checks + `assert-e2e.mjs` 12/12, exit 0; run `.tmp/e2e/run-20261116-203730` | 2026-11-16 | Cross-directory headline gate passed; see §9a |
| UI-* | Panel (v0.2.0) | **Not executed** | — | — | Contract-tested only; no browser rendering |
| PERF-* | Performance budgets (v0.2.0) | **Not executed** | — | — | Not measured in this round |
| GOCON-* / REL-01..04 | Export consumer / release evidence | **Partial** | Go consumer re-checked for the global export; REL-02 scratch E2E evidence recorded | 2026-11-16 | Tarball/SHA-256, publish and real-profile install still open |

## 15. Traceability

The authoritative requirement→test matrix is [execution-plan.md](../plan/execution-plan.md) §13.
This document defines the test semantics; the plan maps ADR §2–§16 requirements onto the IDs above.
Any new test ID must be added here first; any requirement without a test is a planning defect.

## 16. Test-validity risks

- **Fake-ctx drift:** the fake Cordis ctx can diverge from the real runtime (e.g. event payload
  shapes). Mitigation: E2E is mandatory for loop-visible behavior; fakes implement documented
  signatures only; M0 findings feed the fakes.
- **Timing tests are non-hermetic** (Windows, anti-virus, other DSH windows). Mitigation: opt-in perf
  suite, multiple runs, report distribution not a single number, record hardware.
- **Mock model fidelity:** the stub's request/response shape is a hypothesis reused from Crisp; a
  headless provider-routing change would make the E2E SKIP/fail for environmental reasons. Mitigation:
  the harness prints the exact env/route and fails with a diagnostic, not a silent skip.
- **Session-log decoding** is not a required assertion path (Crisp's precedent); assertions use mock
  request bodies + the plugin debug log (no content) instead. Optional decoder imports of
  `@deepseek-ai/dsh-session-persistence-jsonl` are HYPOTHESIS-only.
- **Design-phase assumptions:** every test here encodes an ADR claim; if M0 changes a claim (S1/S2/S3/S6),
  update the affected test specs *before* writing the test (docs are the contract).
- **Injection resistance is a model property**, not a code property: automated fixtures only prove
  safe *content handling*; the manual dogfood review covers behavior, and its outcome is recorded as
  a note, not a green check.

## Open questions

1. Do we require a zstd session-log decode helper in the test harness, or are mock request bodies +
   the plugin debug log sufficient for every E2E assertion? (Current plan: sufficient; decoder is a
   bonus.)
2. Can the mock provider emit scripted tool calls in 0.2.2-rc.1's headless path with the same fidelity
   as Crisp's text-only mock? If not, E2E-03/E2E-07 downgrade to `BLOCKED` and `IT` carries tools.
3. Should `PERF-*` and `PERF-04` soak be release-blocking on any Windows machine, or only on the
   release machine where the user actually runs DSH? (Proposed: release machine only.)
4. Who owns the manual injection dogfood review, and against what prompt rubric?
5. How do we test the panel without a scratch Web-capable profile? (M0-S6 must answer; fallback is
   documented as "rendered display unverified" per the plugin-development skill's verification rule.)
