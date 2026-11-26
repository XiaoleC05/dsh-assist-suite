# Confluence / 高级记忆 — documentation index

This is the reading map for the repository. The project is a **fully-offline DeepSeek Harness
plugin** that, from v0.4.0, delivers **three memory layers plus an output side**: a **workspace
session bus** (same-workspace keyed context, notes and addressed messages), **long-term memory**
(generalizable `pattern` records, candidate-first), a **user persona** (individual traits only), and
**two-channel style cards** (`chat` answer prose + `engineering` artifact copy). The binding decision
is [ADR 0009](adr/0009-long-term-memory-persona-style.md), which extends
[ADR 0008](adr/0008-bus-and-profile.md) (two scopes, queue-based messages) and keeps the scope rule of
[ADR 0007](adr/0007-universal-memory-scope.md) superseded. The binding interface contract for this
round is [plan/v0.4-interfaces.md](plan/v0.4-interfaces.md).

**Status: v0.4.0 target — three-layer memory + style cards; implementation and gates in progress.**
ADR 0009 and the v0.4 interface contract are the binding documents; the v0.4 implementation, packaging
and the docs rewrite are **in progress on this tree**, and **no v0.4.0 verification result has been
executed yet** — every v0.4 row below is **in progress / not executed**, and the final numbers are
recorded by the Lead in [plan/implementation-status.md](plan/implementation-status.md). The executed
evidence in this page is **historical for its own versions**: v0.3.0 (2026-11-19): offline suite
**353/353**, packaging check **18/18**, contract tests **24/24**, offline scratch-profile E2E
**17/17 harness checks + 15/15 assertions, exit 0** (run `.tmp/e2e/run-20261119-032058`); v0.2.1
(2026-11-16): **291/291**, **17/17**, E2E **15/15 PowerShell checks + 12/12 assertions, exit 0** (run
`.tmp/e2e/run-20261116-203730`; evidence: [discussion/v0.2-e2e-evidence.md](discussion/v0.2-e2e-evidence.md));
v0.1.0 (2026-11-13): **256/256**, **12/12**, E2E **8/8**. Still not executed in any version: the
panel's rendering (never visually verified), the real desktop-profile install/restart, and publish —
nothing has been published. Upgrading from v0.3? Start with [upgrade-v0.4.md](upgrade-v0.4.md).

Verification honesty: documents state what was **executed** and what was not. Numbers in the docs are
design targets unless explicitly recorded as measured results. Unverified claims are marked
`HYPOTHESIS:`. A v0.4.0 row may only be marked *executed* when the command and its output are behind
it; until then it is **in progress** or **not executed**.

---

## 1. Reading order

1. [Project README](../README.md) — the three layers, the two style channels, the promise, the status,
   the repository layout.
2. [Upgrade to v0.4.0](upgrade-v0.4.md) — what changed, the new `memory`/`style` config sections, the
   automatic one-time data migration (`tech`/`context` → patterns, `preferences`/`rules` aliases), the
   `confluence.memory/v1` export, renamed CLIs, restart, verification checklist, rollback (read this
   first if you run v0.3.x).
3. [ADR 0009 — three-layer memory: workspace bus, long-term patterns, user persona](adr/0009-long-term-memory-persona-style.md)
   — the binding v0.4 decision: three layers plus style cards, candidate-first writes, three bounded
   prompt blocks, portability, migration, breaking surface.
4. [v0.4 interface contract (binding)](plan/v0.4-interfaces.md) — record shapes (`pattern`, `style`,
   `memory-migration`, persona sections), services, the eight tools, the three prompt blocks and their
   budgets, seven panel routes, config v0.4, migration, errors, workstreams, integration gate.
5. The round-3 design documents below — the implementable detail; each carries a **v0.4 amendment** (on
   top of its v0.3/v0.2 amendment) note. Then the live status in §6 and packaging/install in §7.
6. Historical context: [ADR 0008](adr/0008-bus-and-profile.md) (v0.3.0 base: two scopes, queue-based
   messages), [ADR 0007](adr/0007-universal-memory-scope.md) (universal memory; its scope rule stays
   superseded, the rest carries over), the [v0.3 contract](plan/v0.3-interfaces.md), the
   [v0.2.0 scope delta](plan/scope-refactor-delta.md),
   [ADR 0001](adr/0001-confluence-architecture.md) and the round-2 discussion.

Read the two [research](research/dsh-internals.md) documents when you need the raw evidence: DSH
internals for exact APIs/behaviour, prior art and external patterns for what to compose with and what
to avoid.

---

## 2. Decision records (ADR)

| ADR | Status | One-line description |
|---|---|---|
| [ADR 0001 — Confluence / 高级记忆 architecture](adr/0001-confluence-architecture.md) | **Accepted** (design phase); workspace-scoped parts **superseded by ADR 0007/0008** | v1 architecture: three-pillar hybrid, workspace identity, append-only sharded journal, six tools, pulse/watermark contract, config, privacy, milestones. |
| [ADR 0002 — store format and concurrency](adr/0002-store-format-and-concurrency.md) | Accepted (round 3); mechanics unchanged | Storage/journal format, sharding, merge-on-read and the multi-window concurrency model. |
| [ADR 0003 — pulse and watermarks](adr/0003-pulse-and-watermarks.md) | Accepted (round 3); mechanics unchanged | Passive pulse rendering and log-derived watermark mechanics. |
| [ADR 0004 — privacy and consent](adr/0004-privacy-and-consent.md) | Accepted (round 3); boundary re-stated by 0008/0009 | Privacy, consent boundaries, redaction and opt-out decisions. |
| [ADR 0005 — UI transport](adr/0005-ui-transport.md) | Accepted (round 3) | M3 panel and the host→client data-channel decision (read-only same-origin GET). |
| [ADR 0006 — solo-bench integration](adr/0006-solo-bench-integration.md) | **Proposed** (future merge phase; not a decided record) | The `memories.v1.jsonl` export contract and the low-risk merge path into the `solo-bench` workbench. |
| [ADR 0007 — universal memory scope](adr/0007-universal-memory-scope.md) | **Accepted** (v0.2.0); **scope rule superseded by ADR 0008**, other guarantees carry over | One memory space per profile (`ws_0000000000000000`, "All sessions"); workspaces as provenance; legacy journals merged read-only; breaking config rename. |
| [ADR 0008 — workspace session bus + global user profile](adr/0008-bus-and-profile.md) | **Accepted** (v0.3.0; base layer of v0.4) | Two coexisting scopes: per-workspace bus (context/notes/messages, never merged) + profile-global user profile; queue-based messages; semi-automatic profile; two read-only panel views; v0.2 legacy data preserved read-only. |
| [ADR 0009 — three-layer memory: workspace bus, long-term patterns, user persona + style cards](adr/0009-long-term-memory-persona-style.md) | **Accepted** (v0.4.0; **binding**) | Three layers (bus unchanged; `pattern` long-term memory; `profile` reduced to persona traits) plus two-channel `style` cards; candidate-first writes; three bounded prompt blocks; one portable `confluence.memory/v1` document; one-time additive migration of `tech`/`context` facts into patterns; profile aliases. |

## 3. Research (round 1, frozen)

| Document | One-line description |
|---|---|
| [DSH internals (0.2.2-rc.1)](research/dsh-internals.md) | 58-row verified-facts table: APIs, events, projections, storage behavior, multi-process hazards, prompt-assembly facts. |
| [Prior art in the DSH ecosystem](research/prior-art.md) | What already exists (session-reference, session search, dsh-context, better-sidebar, Crisp), what overlaps, and the honest gap analysis. |
| [External patterns](research/external-patterns.md) | Survey of memory/coordination patterns and a decision-oriented applicability matrix for an offline plugin. |

## 4. Discussion records (rounds 1–2 and independent review)

| Document | One-line description |
|---|---|
| [Round 1 — research findings and candidate designs](discussion/round-1.md) | What the research established, Option A and Option B summaries, and the open disagreements carried into round 2. |
| [Round 2 — cross-critique and architecture decision](discussion/round-2.md) | Votes, adopted agreements, Lead rulings (workspace key, six tools, lite-capture deferral, UI scope, storage layout), corrections accepted. |
| [Position A](discussion/position-a.md) | Architect A's written position on the hybrid option and its conditions. |
| [Position B](discussion/position-b.md) | Architect B's written position on the hybrid option and its conditions. |
| [Independent design review](discussion/design-review.md) | Independent verifier verdict (PASS WITH FIXES), executed checks, 8 P1 / 16 P2 findings, requirement matrix and fix dispositions. |
| [v0.2.0 offline E2E evidence](discussion/v0.2-e2e-evidence.md) | Executed evidence record: exact command, run directory, check tables (15/15 + 12/12), observed cross-directory behaviour and the three product bugs found and fixed. Historical for v0.2.1. |

## 5. Design documents (round 3, with v0.4 amendments)

These are the implementable detail behind ADR-0001; the v0.4 amendments (pointing at
[ADR 0009](adr/0009-long-term-memory-persona-style.md) and
[v0.4-interfaces](plan/v0.4-interfaces.md)) override the scope statements of the v0.1.0/v0.2.0/v0.3.0
text. All documents listed here are present; the repository contract tests require every link on this
page to resolve.

| Document | One-line description | Status |
|---|---|---|
| [design/architecture.md](design/architecture.md) | Components, boundaries, lifecycle, ownership, and how host/client halves split. | **Available** + v0.4 amendment (three layers, `memory`/`style` modules, three global prompt contributions, migration wiring) |
| [design/data-model.md](design/data-model.md) | Record model, invariants, caps, threading and resolution semantics. | **Available** + v0.4 amendment (`pattern`/`style`/`memory-migration`, per-key folds, six persona sections + aliases) |
| [design/store-format.md](design/store-format.md) | Per-writer JSONL journal format, shards, merge-on-read, torn-line tolerance, compaction, export manifest. | **Available** + v0.4 amendment (new record types in the global journal, LWW-per-key folds, no new files, nothing rewritten) |
| [design/tool-api.md](design/tool-api.md) | The model-facing tools: schemas, descriptions, result rendering, cursor markers. | **Available** + v0.4 amendment (eight tools; persona-only profile; memory candidate flow; style set/remove) |
| [design/pulse.md](design/pulse.md) | Passive digest template, byte-stability rules, budget split, escaping, watermark mechanics, onboarding. | **Available** + v0.4 amendment (three global blocks: persona 1400, patterns 1410, style 1420, pulse 1500; candidate headline) |
| [design/ledger-recall.md](design/ledger-recall.md) | Metadata-only live ledger, presence heartbeats, on-demand literal recall, refs. | **Available** + v0.2.0 amendment (profile-wide); v0.3/v0.4 leave ledger/recall unchanged |
| [design/ui.md](design/ui.md) | Read-only panel: slots, locale dictionaries, theme tokens, data channel. | **Available** + v0.4 amendment (three views: workspace bus / long-term memory / user persona + styles; seven routes) |
| [design/config.md](design/config.md) | Every configuration field, default, validation/fallback rule and user override semantics. | **Available** + v0.4 amendment (`memory`/`style` sections, budget-risk warnings, no deprecations) |
| [design/security-privacy.md](design/security-privacy.md) | Trust model, untrusted-content framing, redaction, opt-outs, no-egress guarantees, filesystem safety. | **Available** + v0.4 amendment (candidates untrusted until promoted; patterns/styles in prompts; memory export/import gates) |
| [design/testing.md](design/testing.md) | Acceptance criteria, unit/integration/E2E test plan, no-egress and field-allow-list tests. | **Available** + v0.2.0 amendment + executed v0.2.0 evidence (E2E 15/15 + 12/12, 2026-11-16); v0.3/v0.4 plans pending |
| [design/solo-bench-integration.md](design/solo-bench-integration.md) | `memories.v1.jsonl` export contract and the low-risk merge path into `solo-bench`. | **Available** + v0.2.0 amendment; v0.4 memory export is separate, merge still a future phase |

Historical option proposals (superseded by ADR-0001, kept for the decision record):
[Option A](design/options/option-a.md) and [Option B](design/options/option-b.md).

## 6. Implementation plan and status

| Document | One-line description | Status |
|---|---|---|
| [plan/v0.4-interfaces.md](plan/v0.4-interfaces.md) | **Binding** v0.4.0 interface contract: record shapes, services, eight tools, three prompt blocks, seven panel routes, config, migration, errors, workstreams and integration gate. | **Available** (frozen; Lead-owned) |
| [plan/v0.3-interfaces.md](plan/v0.3-interfaces.md) | v0.3.0 interface contract: two scopes, record types, six tools, prompt blocks, panel routes, config. **Historical base** for the v0.4 contract. | **Available** (historical; still the base of the bus layer) |
| [plan/implementation-status.md](plan/implementation-status.md) | Live **v0.4.0** coordination record: workstream state, files, executed-vs-not-executed verification (v0.4 rows start in progress / not executed), blockers. | **Available** — implementation in progress; final verification results Lead-owned |
| [plan/scope-refactor-delta.md](plan/scope-refactor-delta.md) | Binding v0.2.0 interface delta (universal memory). **Historical**: its scope rule is superseded by ADR 0008. | **Available** (historical) |
| [plan/implementation-interfaces.md](plan/implementation-interfaces.md) | Binding module contracts, exports, ownership and test conventions for the v0.1.0 build. **Historical baseline**. | **Available** (historical) |
| [plan/execution-plan.md](plan/execution-plan.md) | Milestone plan (M0–M4), owners, dependencies, acceptance gates and risk checkpoints. | **Available** (v0.1.0/v0.2-era plan) |
| [plan/m0-spikes.md](plan/m0-spikes.md) | M0 spike **specs** (method/protocol for S1–S7, spike→milestone map) and the executed results in §10. | **Available** (historical evidence) |

## 7. Packaging and operations

| Document | One-line description |
|---|---|
| [Upgrade to v0.4.0 (three layers + style cards)](upgrade-v0.4.md) | What changed (records, tools, export document, renamed CLIs, seven routes), additive `memory`/`style` config, the automatic one-time migration (`tech`/`context` → `pattern`, `preferences`/`rules` aliases), restart, verification checklist, rollback. |
| [Upgrade to v0.3.0 (workspace bus + user profile)](upgrade-v0.3.md) | **Historical** v0.2.1 → v0.3.0 note: breaking config mapping (`store.maxEntriesPerWorkspace` → `bus.notes.maxEntries`, `pulse.*` → `bus.pulse.*`, `export.*` ignored), legacy read-only policy, restart. |
| [Upgrade to v0.2.0 (universal memory)](upgrade-v0.2.md) | **Historical** v0.1.0 → v0.2.0 note (`privacy.disabledWorkspaces` removed, `ledger.maxSessions`); kept for the record. |
| [Install and verification guide](install.md) | How the bundle is installed and verified: Plugin Manager `install_bundle`, scratch-profile CLI path, offline guarantees, checklists, rollback. **Its v0.4 checklist update is owned by the packaging workstream and pending.** |
| [Publishing and release process](publishing.md) | Versioning, offline pack inspection and checksums, release steps, channel state, and the "nothing was published" honesty note. **v0.4.0 version/pack re-record pending.** |

## 8. Planning

| Document | One-line description |
|---|---|
| [Team brief (round 1)](planning/team-brief.md) | Mission, verified environment facts, scope and constraints for the research rounds. |

## 9. Verification status

**v0.4.0 (three-layer memory + style cards) — this round: implementation and gates in progress; nothing
executed yet.**

| Area | Status |
|---|---|
| [ADR 0009](adr/0009-long-term-memory-persona-style.md) + [v0.4 interface contract](plan/v0.4-interfaces.md) | **Available** — frozen binding documents for the round |
| Host plugin v0.4.0 (target 20 `lib/*.js` modules: v0.3.0's 18 + `memory`/`style`) | **In progress** — target inventory, not yet verified |
| Eight tools (`board/context/send/inbox/profile/memory/style/recall`), three global prompt blocks + pulse, three panel views / seven routes | **In progress** — design frozen; implementation under the workstreams |
| Product docs (READMEs, this index, upgrade note, design amendments) | **Updated for v0.4** in this round; every v0.4 verification row below stays **not executed** until the Lead records a command and its output |
| Offline test suite v0.4.0 (`node --test --test-force-exit "test/*.test.js"`) | **Not executed for v0.4.0** — final number Lead-owned |
| Packaging check v0.4.0 (`node scripts/check.mjs`) | **Not executed for v0.4.0** — final number Lead-owned |
| Packaging contract tests (`test/contract.test.js`) | **Not executed for v0.4.0** — final number Lead-owned |
| Offline scratch-profile E2E v0.4.0 (candidate flow + three blocks + memory/style round-trip + three views) | **Not executed for v0.4.0** |
| `npm pack --dry-run` (offline) | **Not executed for v0.4.0**; v0.3.0 recorded 28 files, 199,159 B packed / 780,797 B unpacked, no tarball |
| Panel rendering / visual verification | **Not executed — never visually verified in any version** |
| Real desktop-profile install + DSH restart | **Not executed** (v0.1.0 was installed historically; v0.2/v0.3/v0.4 not) |
| Publish/release | **Not executed — nothing was published** |

**v0.3.0 (workspace bus + user profile) — historical, executed on the v0.3 tree (2026-11-19):**

| Area | Status |
|---|---|
| [ADR 0008](adr/0008-bus-and-profile.md) + [v0.3 interface contract](plan/v0.3-interfaces.md) | **Available** — frozen binding documents for that round |
| Host plugin v0.3.0 (18 `lib/*.js` modules) and six tools / two prompt contributions / two panel views | **Implemented** — covered by that round's suite and E2E |
| Offline test suite | **Executed — 353/353 pass** |
| Packaging check | **Executed — 18/18 checks pass** |
| Packaging contract tests | **Executed — 24/24 pass** |
| Offline scratch-profile E2E | **Executed — 17/17 harness checks + 15/15 assertion checks, exit 0** — run `.tmp/e2e/run-20261119-032058` |
| `npm pack --dry-run` (offline) | **Executed — 28 files, 199,159 B packed / 780,797 B unpacked**; no tarball written |
| Panel rendering / real-profile install + restart / publish | **Not executed** |

**v0.2.0/v0.2.1 (universal memory) — historical, executed 2026-11-16; unchanged by the 2026-11-17
display-name patch:**

| Area | Status |
|---|---|
| Offline test suite on the final tree | **Executed — 291/291 pass** |
| Packaging contract (`node scripts/check.mjs`) | **Executed — 17/17 checks pass** |
| M0 smoke (`node scripts/m0-smoke.mjs`) | **Executed — 14 pass / 0 fail / 1 blocked** (optional atomic-write probe) |
| Offline scratch-profile cross-directory E2E (`scripts/e2e-dsh.ps1`) | **Executed — 15/15 PowerShell checks, exit 0; `assert-e2e.mjs` 12/12 checks** — run `.tmp/e2e/run-20261116-203730`; evidence: [discussion/v0.2-e2e-evidence.md](discussion/v0.2-e2e-evidence.md) |
| Legacy read-only merge / global store / watermarks / cold-start activation | **Executed in that E2E** (details in [plan/implementation-status.md](plan/implementation-status.md)) |
| Locale parity (86 panel strings) and universal copy | **Executed by the contract checks** of that round |
| Panel global timeline | **Implemented and contract-tested; rendering still not visually verified** |
| Real-profile reinstall + DSH restart for v0.2.x | **Not executed** |

**v0.1.0 (historical, executed 2026-11-13):**

| Check | Result |
|---|---|
| Offline test suite | **Executed — 256/256 pass** |
| Packaging contract (`node scripts/check.mjs`) | **Executed — 12/12 checks pass** |
| Offline scratch-profile E2E (`scripts/e2e-dsh.ps1`) | **Executed — 8/8 checks** (same-workspace sessions) |
| Real desktop-profile install via Plugin Manager `install_bundle` | **Executed** — applied; six tools live; pulse rendered; store created |
| Export producer + `solo-bench` Go consumer | **Executed** |

**Not executed for any version:** panel rendering / visual verification, PTC preset (`run_code`) tool
reachability, multi-window live freshness measurement, soak/compaction and long-run retention,
tarball/SHA-256 + publish/release.

## 10. Documentation conventions

- Every factual claim carries evidence: a `file:line` reference, an API signature from
  `cordis_inspect_query`, or a URL. Unverified claims are prefixed `HYPOTHESIS:`.
- Links are relative and must resolve in the repository; a document is added to this index when it
  exists.
- Numbers are design targets unless explicitly recorded as measured results.
- The project never claims a capability it has not implemented. v0.4.0 differences from v0.3.0 are
  tracked in [ADR 0009](adr/0009-long-term-memory-persona-style.md),
  [plan/v0.4-interfaces.md](plan/v0.4-interfaces.md) and [upgrade-v0.4.md](upgrade-v0.4.md); the
  executed-vs-not-executed tables stay explicit, and **v0.4.0 rows may not be recorded as executed
  without the command and its output**.
- Historical text stays where it is marked as history; new rules are added as a "v0.3/v0.4 amendment"
  note rather than silently rewriting the decision record. The v0.2.0 and v0.3 amendments remain in
  place as the historical record.
