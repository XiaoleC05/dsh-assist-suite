# Implementation status (v0.4.0, three-layer memory + style cards) — live coordination record

- Owner: **docs/packaging** (WSF1, `docs-v04` docs pass; packaging pass later in this round). This is
  the coordination record for the build round, not a design document; update it whenever the
  implementation state changes.
- Last updated: **2026-11-27 (v0.4.0 integration gate)** — all v0.4 workstreams landed; the Lead's
  integration gate executed the offline suite (398/398), packaging check (20/20), contract tests
  (25/25), offline scratch-profile E2E (22/22 + 19/19, exit 0, run `20261127-025250`) and
  `npm pack --dry-run` (30 files). The live desktop profile is running v0.4.0 (heartbeat v0.4.0,
  one-time migration marker + migrated pattern in the real store, persona/memory prompt blocks).
  Panel rendering and publish remain not executed. Prior snapshot in history: 2026-11-19 (v0.3.0 packaging/contract closure,
  offline suite 353/353 etc.; kept in §5 as historical evidence for v0.3.0).
- Binding contract: [`v0.4-interfaces.md`](v0.4-interfaces.md) (v0.4.0). Base layer:
  [`v0.3-interfaces.md`](v0.3-interfaces.md) (v0.3.0, historical but still the contract of the
  workspace bus), on top of [`scope-refactor-delta.md`](scope-refactor-delta.md) (v0.2.0) and
  [`implementation-interfaces.md`](implementation-interfaces.md) (v0.1.0 baseline).
  Decision: [`../adr/0009-long-term-memory-persona-style.md`](../adr/0009-long-term-memory-persona-style.md),
  which extends [`../adr/0008-bus-and-profile.md`](../adr/0008-bus-and-profile.md); ADR 0007's scope
  rule stays superseded. Milestones: [`execution-plan.md`](execution-plan.md) (historical M0–M4
  framing). Upgrade notes: [`../upgrade-v0.4.md`](../upgrade-v0.4.md).
- Honesty rule: a row says **Executed** only if the check was actually run on this tree and its output
  is available; everything else is **Pending**, **In progress** or **Not executed**, even when the
  design is complete.

## 1. Verdict

**v0.4.0 is implemented and its offline evidence is green on this tree (2026-11-27).**
ADR 0009 and [v0.4-interfaces.md](v0.4-interfaces.md) define the round: the workspace bus stays as
shipped in v0.3.0, and the product gains **long-term memory** (`pattern` records, candidate-first),
a **user persona** (`profile` reduced to six trait sections, legacy-seeded once into patterns) and
**two-channel style cards** (`style` records), all injected through three bounded prompt blocks and
carried by one portable `confluence.memory/v1` document.

**Executed on this tree (§5):** offline suite **398/398 pass**, packaging check **20/20 checks pass**,
contract tests **25/25 pass**, offline scratch-profile E2E **22/22 harness checks + 19/19 assertion
checks, exit 0** (run `.tmp/e2e/run-20261127-025250`), `npm pack --dry-run` **30 files**
(267,319 B packed / 1,066,162 B unpacked; no tarball). The real desktop profile is running v0.4.0:
presence heartbeat reports 0.4.0, the one-time `memory-migration` marker and the migrated `project`
pattern exist in the real store, and this session receives the persona + patterns prompt blocks.

**Still not executed:** panel rendering / visual verification (never executed in any version),
publish/release (nothing was published, no tarball/SHA-256), PTC `run_code` reachability,
multi-window live freshness, soak/compaction. The formal `install.md` checklist was not re-run; live
activation is evidenced by the running profile state above.

## 2. Workstreams (v0.4.0)

Ownership follows the binding contract §9. "Covered" would mean the offline suite and/or the v0.4 E2E
exercises the area on this tree — **no such coverage exists yet**, so every implementation workstream
below is *in progress* until the Lead's integration gate.

| WS | Owner | Files | Status |
|---|---|---|---|
| **A** memory core | `memory-core` | `lib/memory.js`, `lib/style.js`, `lib/store.js` (record types), `test/memory.test.js`, `test/style.test.js`, `test/store.test.js` | **Done** — pattern/style folds, candidate queue, caps, redaction, migration marker (44/44 module tests green) |
| **B** persona + portability | `persona-portability` | `lib/profile.js`, `lib/export.js`, `scripts/memory-export.mjs`, `scripts/memory-import.mjs`, `test/profile.test.js`, `test/export.test.js` | **Done** — six persona sections + aliases, `confluence.memory/v1` build/validate/render/import, CLI round-trip (41/41), legacy doc import |
| **C** wiring | Lead | `lib/config.js`, `lib/facade.js`, `index.js`, `cordis.patch.yml`, `test/config.test.js`, `test/integration.test.js` | **Done (Lead)** — three prompt blocks, memory/style/persona facade APIs, config/patch parity, migration wiring; integration 9/9 green (incl. private-session suppression and workspace round-trip) |
| **D** tools | `tools-v04` | `lib/tools.js`, `test/tools.test.js` | **Done** — eight tools, memory candidate flow, style rules, closed schemas (37/37 tests, 23/23 real-service smoke) |
| **E** panel | `panel-v04` | `lib/hostui.js`, `client.js`, `locale/*.json`, `test/hostui.test.js` | **Done** — `memory` route, profile+styles payload, three tabs, locale parity (44/44) |
| **F1** docs | `docs-v04` | `README.md`, `README.zh-CN.md`, `docs/README.md`, `docs/upgrade-v0.4.md`, this file, `docs/design/*.md` amendments | **Done (docs pass)** — v0.4 docs rewritten; all v0.4 verification rows left as in progress / not executed for the Lead |
| **F2** packaging/contract | `docs-packaging` | `package.json`, `lib/export.js` producer version, `scripts/check.mjs`, `test/contract.test.js`, `scripts/e2e-dsh.ps1`, `test/e2e/**`, `docs/install.md`, `docs/publishing.md`, `examples/profile-patch.yml` | **Done** — version 0.4.0, checker 20/20, contract 25/25, E2E 22/22 + 19/19, pack 30 files |
| Integration gate | Lead | full diff + gates | **Executed** — checker 20/20, suite 398/398, contract 25/25, E2E exit 0; live profile running v0.4.0; diff reviewed and committed |

Implementation inventory target: **20** `lib/*.js` modules (v0.3.0's 18 + `memory.js`, `style.js`),
`index.js` wiring (three global prompt contributions + the workspace pulse), `client.js` (Dynamic
ModuleLoader id `dsh-confluence`), the **eight** tools, **seven** read-only panel routes, **three**
panel tabs, and two renamed memory CLIs. The actual shipped-file inventory is re-recorded by F2 at the
release checkpoint.

## 3. Milestones (product rounds)

| Round | Scope | Status |
|---|---|---|
| **v0.1.0** | Workspace-scoped shared memory: pulse, board, ledger/recall, panel v1 | **Executed 2026-11-13** (historical; suite 256/256, checker 12/12, scratch E2E 8/8, real-profile install applied) |
| **v0.2.0 / v0.2.1** | Universal memory per DSH profile (ADR 0007): one global board, origin provenance, global panel/export | **Executed 2026-11-16** (historical; suite 291/291, checker 17/17, E2E 15/15 + 12/12); v0.2.1 display-name patch 2026-11-17 |
| **v0.3.0** | Two modules (ADR 0008): workspace session bus + global user profile; queue-based messages; two panel views | **Executed 2026-11-19** (historical; suite 353/353, checker 18/18, contract 24/24, E2E 17/17 + 15/15, run `20261119-032058`); real-profile install and panel rendering still not executed |
| **v0.4.0** | Three layers (ADR 0009): bus (unchanged) + long-term `pattern` memory + persona `profile`; two-channel `style` cards; candidate confirmation; one portable memory document | **Executed 2026-11-27** — suite 398/398, checker 20/20, contract 25/25, E2E 22/22 + 19/19 (run `20261127-025250`), pack 30 files; live desktop profile running v0.4.0; panel rendering and publish still not executed |
| **next** | Optional wake/inject message delivery (requires a new ADR), unread badge, composer, custom tool cards, corpus-distillation tooling | **Not planned / not started** |

## 4. Changes in this round (docs snapshot)

Docs owned by this pass are recorded here; code/config changes are owned by their workstreams and are
not re-stated as verified.

| Area | Change |
|---|---|
| `README.md` / `README.zh-CN.md` | Rewritten around the three layers plus style: **1 workspace task state (bus, unchanged) → 2 long-term memory (generalizable `pattern`, candidate-first) → 3 user persona (identity/personality/communication/habits/boundaries/taste) → two-channel style cards (chat + engineering artifact copy)**. Documents the three injected blocks and their budgets, the `confluence.memory/v1` export and the `memory-export`/`memory-import` CLIs, the three panel views, the candidate confirmation flow, the semi-automatic/offline boundary, and the additive v0.3→v0.4 migration (`tech`/`context` → patterns, `preferences`/`rules` aliases). Historical v0.3.0/v0.2.1/v0.1.0 executed evidence is kept and labelled; every v0.4 verification row is marked in progress / not executed. |
| `docs/upgrade-v0.4.md` | **New** — v0.3.0 → v0.4.0 changes (10 record types, persona six sections, `pattern`/`style` records, eight tools, seven routes, `confluence.memory/v1`, renamed CLIs); additive `memory`/`style` config with budget warnings (`MEMORY_BUDGET_RISK`, `STYLE_BUDGET_RISK`) and no deprecations; automatic one-time migration (legacy `tech`/`context` facts → patterns via `memory-migration`, `preferences`→`communication`, `rules`→`boundaries`); restart requirement; verification checklist; rollback (v0.3 ignores the new record types; back up the store first); the "what this does not prove" note. |
| `docs/README.md` | Index updated: ADR 0009 row, `plan/v0.4-interfaces` (binding), `upgrade-v0.4`, `v0.3-interfaces` marked historical, v0.4 amendments in the design table, updated reading order, and the verification section split into **v0.4 in progress / not executed** vs historical v0.3/v0.2/v0.1 executed evidence. |
| `docs/design/*.md` | **v0.4 amendment** blocks added to `architecture` (three layers, `memory`/`style` modules, three prompt contributions, migration wiring), `data-model` (`pattern`/`style`/`memory-migration`, per-key folds, six persona sections + aliases), `store-format` (new record types in the global journal, LWW-per-key folds, no new files, nothing rewritten), `tool-api` (eight tools, persona-only profile, memory candidate flow, style set/remove), `pulse` (three global blocks 1400/1410/1420 + pulse 1500, selection/sort/caps, candidate headline), `ui` (three views, seven routes, profile payload + styles), `config` (`memory`/`style` sections, budget-risk warnings, no deprecations), `security-privacy` (candidates untrusted until promoted, patterns/styles in prompts, memory export/import gates). `ledger-recall`, `testing` and `solo-bench-integration` keep their earlier amendments. |
| This file | Rewritten as the v0.4.0 round record; v0.4 rows are **in progress / not executed** with the final gate numbers reserved for the Lead, while the historical v0.3/v0.2/v0.1 tables are preserved. |

Docs that still need a real-profile/visual update and are **not** part of this offline docs pass:
`docs/install.md` and `docs/publishing.md` (owned by the later packaging pass), real desktop-profile
install + DSH restart (Lead), panel rendering verification (no browser control), and publish/release.
`locale/*.json` is owned by the panel workstream; `cordis.patch.yml` by the Lead.

## 5. Verification: executed vs not executed

**v0.4.0 — executed on this tree (2026-11-27):**

| Check | Status |
|---|---|
| Freeze of ADR 0009 + [v0.4 interface contract](v0.4-interfaces.md) | **Available** — decision + binding contract written (not a runtime check) |
| Versioning/packaging closure | **Executed** — `package.json` 0.4.0, `lib/export.js` producer 0.4.0, checker/contract/E2E updated, `npm pack --dry-run` = 30 files (267,319 B packed / 1,066,162 B unpacked; no tarball) |
| Offline test suite v0.4.0 — `node --test --test-force-exit "test/*.test.js"` | **Executed — 398/398 pass** |
| Standalone packaging check v0.4.0 — `node scripts/check.mjs` | **Executed — 20/20 checks pass** |
| Contract tests v0.4.0 — `test/contract.test.js` | **Executed — 25/25 pass** |
| Offline scratch-profile E2E v0.4.0 — `pwsh -NoProfile -File scripts/e2e-dsh.ps1` | **Executed — 22/22 harness checks, 0 fail, exit 0; `test/e2e/assert-e2e.mjs` 19/19 checks** — run `.tmp/e2e/run-20261127-025250` |
| Memory candidate flow acceptance | **Executed in the suite/E2E** — `add` is always `candidate`, the prompt only announces it (bounded headline), `promote` turns it into a rule, `reject`/`forget` retire it |
| Three prompt blocks + unchanged workspace pulse | **Executed in the suite/E2E** — persona 1400, patterns 1410, style 1420, pulse 1500; each bounded, empty-safe, byte-stable; private sessions get none |
| One-time migration (`tech`/`context` → `pattern`, marker, idempotent; aliases) | **Executed in the suite/E2E and observed in the live profile** — real store now contains one `memory-migration` marker and the migrated `project` pattern |
| `confluence.memory/v1` build/validate/render/import (merge + replace; legacy profile document import) | **Executed in the suite/E2E** — deterministic document, workspace-target preservation, legacy `confluence.profile/v1` import still works |
| Renamed CLIs `memory-export` / `memory-import` round-trip | **Executed** — temporary-DSH_HOME round-trip in the module suite |
| Panel three views / seven routes in a live GUI | **Not executed — panel rendering has never been visually verified** |
| Real desktop-profile install + DSH restart for v0.4.0 | **Executed (observed live)** — the desktop profile is running v0.4.0 from the repo link; formal `install.md` checklist not re-run |
| Publish/release | **Not executed — nothing was published** |

**v0.3.0 — historical, executed on that tree (2026-11-19):**

| Check | Status |
|---|---|
| Freeze of ADR 0008 + [v0.3 interface contract](v0.3-interfaces.md) | **Available** — decision + binding contract written (not a runtime check) |
| Versioning/packaging closure | **Executed** — `package.json` 0.3.0, `lib/export.js` producer 0.3.0, checker/contract/E2E updated, `npm pack --dry-run` = 28 files (199,159 B packed / 780,797 B unpacked; no tarball) |
| Offline test suite v0.3.0 | **Executed — 353/353 pass** (module, integration, panel/tools/profile and packaging-contract tests) |
| Standalone packaging check v0.3.0 | **Executed — 18/18 checks pass** |
| Contract tests v0.3.0 | **Executed — 24/24 pass** |
| Offline scratch-profile E2E v0.3.0 | **Executed — 17/17 harness checks, 0 fail, exit 0; `test/e2e/assert-e2e.mjs` 15/15 checks** — run `.tmp/e2e/run-20261119-032058` |
| Same-workspace bus acceptance (context/notes/messages shared in one directory) | **Executed in the E2E** — session C (workspace-a) lists the writer note + legacy note (`through=`), reads the queued notice (`inbox=`), context set/get round-trips |
| Cross-workspace isolation (bus data not merged across workspaces) | **Executed in the E2E** — session B (workspace-b) pulse/request/store contain no workspace-A bus data |
| Profile injection (and the empty-profile onboarding nudge) | **Executed in the E2E** — the writer session (before any fact) carries the bounded `status="empty"` nudge; workspace-B session carries `<confluence-profile rev facts>` with the recorded fact |
| Queue-based message delivery observed in another session (pulse/inbox at next step) | **Executed in the E2E** — `confluence_send` reports queued; the notice appears in a same-workspace session's `confluence_inbox`/pulse; no inbox splice/interrupt |
| Legacy v0.1 workspace journal read as bus history, byte-identical | **Executed in the E2E** — seeded shard + manifest hashes unchanged |
| Watermarks (`digestSeq` / `boardReadSeq` / `inboxReadSeq`) | **Executed in the E2E** — cursors match the committed `through=`/`inbox=` markers; post-only sessions stay null |
| Panel two views (workspace bus / user profile) in a live GUI | **Not executed — panel rendering has never been visually verified** |
| Real desktop-profile install + DSH restart for v0.3.0 | **Not executed** (Lead-owned) |
| Publish/release | **Not executed — nothing was published** |

**v0.2.0/v0.2.1 — historical, executed on that tree (2026-11-16; display-name patch 2026-11-17):**

| Check | Result |
|---|---|
| Offline test suite | **Executed — 291/291 pass** |
| Standalone packaging check | **Executed — 17/17 checks pass** |
| M0 smoke — `node scripts/m0-smoke.mjs` | **Executed — 14 pass / 0 fail / 1 blocked** (optional `@deepseek-ai/dsh-atomic-write` probe; native lease is the shipped path) |
| Offline scratch-profile cross-directory E2E | **Executed — 15/15 PowerShell checks, 0 fail, exit 0; `test/e2e/assert-e2e.mjs` 12/12 checks** — run `.tmp/e2e/run-20261116-203730` |
| Cross-directory memory, global store, legacy read-only merge, watermarks, cold-start activation | **Executed in that E2E** (details and evidence link in [`../discussion/v0.2-e2e-evidence.md`](../discussion/v0.2-e2e-evidence.md)) |
| Locale parity (86 panel strings) and universal copy | **Pass** (contract checks of that round) |
| Panel global timeline | Implemented and contract-tested; **rendering not visually verified** |
| Real-profile reinstall + DSH restart for v0.2.x | **Not executed** |

**v0.1.0 — historical (2026-11-13):** offline suite **256/256 pass**, packaging check **12/12**,
M0 smoke 14 pass / 1 blocked, scratch-profile E2E 8/8, real desktop-profile `install_bundle`
applied, export CLI + `solo-bench` Go consumer green.

**Not executed for any version:** panel rendering / visual verification, PTC preset (`run_code`) tool
reachability, multi-window live freshness measurement, soak/compaction and long-run retention,
tarball + publish/release.

## 6. Remaining not-executed items and next steps

1. **Offline gates for v0.4.0 — executed** (`check.mjs` 20/20, suite 398/398, contract 25/25, E2E
   22/22 + 19/19, run `20261127-025250`). Re-run all four after any further tree change.
2. **Packaging pass — executed** (version 0.4.0, checker/contract/E2E rewritten for 20 modules / eight
   tools / seven routes / `memory`+`style` config, install/publishing/example updated, pack = 30 files).
3. **Real-profile install + DSH restart — observed live** (desktop profile runs v0.4.0; heartbeat 0.4.0,
   migration marker + pattern in the real store, persona/memory blocks injected). The formal
   `install.md` checklist was not re-run.
4. **Panel visual verification** (three tabs, memory candidates, persona + styles, export link, en/zh,
   light/dark, no console crash) — never done in any round.
5. **Release checkpoint** (Lead-owned): re-run `npm pack --dry-run --json` on the final tree, record
   contents/sizes/checksum in `../publishing.md`, then commit/tag/push. Nothing has been published.
6. **Residual capabilities not exercised by any offline E2E:** PTC preset (`run_code`) tool
   reachability, multi-window live freshness, soak/compaction and long-run retention — still open from
   earlier rounds.

## 7. How to update this file

Change the "Last updated" line, re-scan the tree, update the workstream/verification tables from what
was actually executed, and never mark a row Executed without the command and its output behind it.
For v0.4.0 specifically: keep the v0.4 rows in §5 as **in progress / not executed** until the Lead's
integration gate runs them; then replace each row with the executed command and its measured number.
Keep the historical v0.3.0/v0.2/v0.1 tables intact — they are evidence for those versions only.
