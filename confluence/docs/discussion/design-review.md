# Independent design review — Confluence / 高级记忆 v1 (round 3)

- Reviewer: `architect-b`, acting as the independent verifier (did not author the round-3 documents).
- Date: 2026-11-13. Phase: design-only; nothing installed, no profile change, no change to `solo-bench` or `Crisp`.
- **Verdict: PASS WITH FIXES** — the architecture decision is coherent and unusually well-evidenced, the
  packaging scaffold is honest and its checks pass, and no requirement is unmet by design. **0 P0, 8 P1,
  16 P2** findings must be read as "fix the P1s before G0 sign-off; the P2s are one cleanup pass".
- Method: read every document in the requested order; independently re-read the installed 0.2.2-rc.1
  bytes for the load-bearing claims; executed the repository's own checks; verified the profile,
  `solo-bench`, `Crisp` and the GitHub repository state that the docs assert; ran cross-document greps
  for every canonical name/value in the Lead's checklist.

---

## 1. Executed verification (commands + observed results)

| # | Command / check | Result |
|---|---|---|
| E1 | `node --test "test/*.test.js"` from `D:\05_Code\Confluence` (Node v22.19.0) | **18 tests, 18 pass, 0 fail**, exit 0 (packaging contract only; no runtime behavior claimed) |
| E2 | `node scripts/check.mjs` | **11 checks, 11 passed, 0 failed**, exit 0 ("design stage; no plugin behaviour is tested") |
| E3 | `npm pack --dry-run --json` (npm 10.9.3, offline) | **9 entries** — `LICENSE`, `README.md`, `README.zh-CN.md`, `cordis.patch.yml`, `icon.svg`, `index.js`, `locale/en.json`, `locale/zh.json`, `package.json`; no `test/`, `docs/`, `examples/`, `scripts/`, `.tmp/`; unpackedSize 60,564 B; no tarball written |
| E4 | `git status --short` / `git log --oneline` in the repo | clean tree; 2 local commits (`d3c13e5`, `19fb636`); branch `main` |
| E5 | Real profile inspection (`~/.dsh/profiles/desktop/package.json`, storages) | **no `dsh-confluence` dependency, no `confluence` bundle row, no `~/.dsh/storages/confluence/`** → the design phase did not touch the desktop profile |
| E6 | Workspace state scan for secrets | **no real secrets**; `sk-…`/`AKIA…`/`ghp_…`/PEM strings appear only as redaction patterns and test fixtures (`ledger-recall.md:319`, `security-privacy.md:257`, `testing.md:220`) |
| E7 | Icon structural check (independently re-run by the test) | valid standalone SVG, no `<script>`, no `<text>`, no `<image>`, no external refs, 618 B, exported as `./icon` |
| E8 | GitHub repository claim | `api.github.com/repos/XiaoleC05/Confluence` → public, `size:0`, `default_branch:"main"`, created `2026-11-12T17:50:06Z`; matches "exists and is empty" (https://github.com/XiaoleC05/Confluence) |
| E9 | `solo-bench` / `Crisp` state | `D:\05_Code\solo-bench` is **not a git repository** (cannot be diff-verified); `git -C D:\05_Code\Crisp status` clean; verifier executed read-only commands only |

The one claim in the repo's verification tables I could not reproduce exactly is the recorded
`npm pack` size (docs say 59,830 B unpacked; current tree is 60,564 B — the docs changed after the
observation; see V23). Everything else in `README.md`'s "Verification status" table checked out.

---

## 2. Requirement → evidence → status matrix

| Requirement (user request / brief) | Evidence | Status |
|---|---|---|
| English name **Confluence**, Chinese **高级记忆** | `package.json` name `dsh-confluence`; `locale/en.json:2` `meta.title:"Confluence"`; `locale/zh.json:2` `"高级记忆"`; README/README.zh-CN both use the pair; icon `aria-label` | **PASS** |
| Complete project shape: docs, repository layout, manifest, icon, locale, license | `package.json`, `cordis.patch.yml`, `index.js`, `locale/*.json`, `icon.svg`, `LICENSE` (MIT, 2026 XiaoleC05), `README.md` + `README.zh-CN.md`, `docs/` tree (research, rounds, ADRs, design, plan, install, publishing), `examples/profile-patch.yml`, `test/`, `scripts/check.mjs` | **PASS** (phase scope: design + packaging scaffold; `lib/`/`client.js` intentionally absent and the docs say so — see the matrix note below) |
| Fully offline: no network, no server, no extra port, no external DB/model | ADR-0001 §3/§11, `architecture.md` §6, `security-privacy.md` §3.5, `docs/install.md` §5; scaffold static check passes (`test/contract.test.js:400-408`); no `dependencies`, no `.listening`/spawn in `index.js` | **PASS (design + scaffold static)**; runtime behavior not executable yet, gated by M0 |
| Later merged into `solo-bench`, low-risk documented path, no changes now | ADR-0006 (subtree + export-only contract), `solo-bench-integration.md` (constraints read from `solo-bench` docs, no fifth service row, no license file, no DB/network/os-exec), `solo-bench` untouched (E9) | **PASS** (merge not executed, by phase design) |
| Requested process: research → multi-agent discussion → execution plan → design | `round-1.md` (method + members + research), `round-2.md` (votes, rulings, accepted corrections), ADR-0001 decision, `execution-plan.md` (M0–M4, gates, owners, risks), 11-document design set, `m0-spikes.md` | **PASS** |
| GitHub repository exists (`XiaoleC05/Confluence`) | API check E8: public, empty, default `main`; README/docs state push is blocked and local-only | **PASS** |
| Evidence discipline (every fact cited; unverified marked HYPOTHESIS) | Strong overall; F1–F15-style evidence, `HYPOTHESIS:` markers, M0 gates; two honesty defects found (V5, V6) | **PARTIAL** |
| Never install/modify profile, `solo-bench`, `Crisp` during design | E5 (profile clean), E9, no bundle installed, no writes outside `D:\05_Code\Confluence` by the team | **PASS** |

Matrix note: "complete project" is interpreted against the team brief's explicit phase rule ("design +
a project-shaped repository, not a production implementation"). The scaffold is deliberately empty and
says so in `index.js`, README, install and publishing docs; that is compliant, and the docs never claim
an implemented capability.

---

## 3. P1 findings (fix before G0 sign-off)

| ID | Severity | Where (both sides) | Finding / evidence | Required change |
|---|---|---|---|---|
| **V1** | P1 | `docs/design/config.md:125-126` and `docs/design/security-privacy.md:20` vs `docs/adr/0001-confluence-architecture.md:421-428` (E8), `docs/adr/0002-store-format-and-concurrency.md:47-51`, `docs/design/store-format.md:432-446`, `docs/design/solo-bench-integration.md:189-198` | Export manifest is named **`manifest.v1.json`** in config.md/security-privacy.md, and config.md gives it schema **`confluence.export/v1`**. The binding decision (E8) and every other doc use **`manifest.json`** with `schema:"confluence.memories/v1"`, `formatVersion:1`. A solo-bench consumer or M4 implementation following config.md would produce/expect the wrong file and schema. | Make `manifest.json` + `confluence.memories/v1` the single spelling in both docs; delete `confluence.export/v1`. |
| **V2** | P1 | `docs/design/config.md:57` vs `docs/design/data-model.md:352`, `docs/design/store-format.md:334,346,621`, `docs/design/tool-api.md:459`, `docs/design/architecture.md:724` | config.md invents board-cap semantics "**soft cap** 2000 / **hard boundary** value+500 (2500)" and cites a non-existent `store-format.md §… "2 000 soft / 2 500 hard"` (literal placeholder `§…`). Every other document and the error contract say a post at **2,000 visible entries is rejected with `BOARD_FULL`**. This is an implementation/test divergence, and config.md contains unfinished text. | Adopt 2,000 = reject (no soft/hard split) or amend ADR/other docs; remove the placeholder. |
| **V3** | P1 | `docs/adr/0001-confluence-architecture.md:399-401` (E2), `docs/design/config.md:109` vs `cordis.patch.yml:84-96`, `index.js:59-65`, `test/contract.test.js:102-108`, `scripts/check.mjs:90-96`, `examples/profile-patch.yml`, `docs/design/config.md:196-203` example | Errata E2 says the default config carries `privacy.redactPatterns: []`; config.md documents it; but the shipped patch, `index.js` `DEFAULTS`, the contract test's `DEFAULTS`, the standalone checker and every example patch **omit it**. The scaffold therefore ships a documented-but-absent field, and the "contract test asserts patch = ADR defaults" claim is weaker than stated. | Add `redactPatterns: []` to patch + all three DEFAULTS copies + examples; add a contract assertion. |
| **V4** | P1 | `docs/design/security-privacy.md:193` and `docs/plan/m0-spikes.md:192,207` vs `docs/adr/0001-confluence-architecture.md:434-438` (E10), `docs/design/store-format.md:118-132`, `docs/plan/execution-plan.md:120-123` | Append primitive drift: E10/architecture/M1.2 specify a held `O_APPEND` fd + `fs.writeSync` (explicitly **not** `fs.appendFile`), but security-privacy §3.10 still says `fs.appendFile`, and M0 spike **S4 tests `fs.appendFile` / `Promise.all(fs.appendFile)`**. M0 would verify a different primitive than the design. | Rewrite S4 to test the O_APPEND/writeSync writer (including torn-line and fsync behavior) and fix security-privacy §3.10. |
| **V5** | P1 | `docs/README.md:9-10` and `:91` vs `docs/plan/m0-spikes.md:1-4,322-334` | docs/README says "the M0 **spike results** are present/recorded"; m0-spikes.md is explicitly an "executable template, **not executed**" with all §10 result cells `TBD`. That is an over-claim of verification — exactly the kind of claim the project forbids. | Say "M0 spike **specs** present (not executed)"; keep README's honest wording as the model. |
| **V6** | P1 | `docs/design/testing.md:439` vs `README.md:320-323`, `test/contract.test.js`, `scripts/check.mjs`, and `testing.md:86-87` itself | testing.md's verification-status table says `CON-* Packaging/static invariants — Not executed — "Scaffold exists; no check script yet"`. But `scripts/check.mjs` and `test/contract.test.js` exist and pass (E1/E2). The file contradicts itself (`:86-87` says the CON checks are implemented) and understates executed evidence (opposite-direction honesty defect). | Set CON-* to **Executed** with the E1/E2 command evidence; bump date. |
| **V7** | P1 | `docs/design/store-format.md:480-492` vs `docs/design/solo-bench-integration.md:220-225,259-263` | Export integrity ambiguity: store-format §14 says "`recordCount`/`firstSeq`/`lastSeq`/`files[].sha256` **must match the JSONL** or consumers reject", while solo-bench says tombstone stubs are **excluded from those counts** (Lead ruling) yet still appear in `memories.v1.jsonl`. A consumer implementing "line count == recordCount" would reject a valid v1 export. | Define once: `recordCount/firstSeq/lastSeq` = live (non-stub) records; `files[0].bytes/sha256` cover the complete file; state the rule in both docs and in the conformance fixture (store-format §17.28/§17.39). |
| **V8** | P1 | `docs/design/ledger-recall.md:368-369,386` vs `docs/design/testing.md:217-219,256,269` and `docs/design/security-privacy.md:295` | Traceability gap on a load-bearing privacy control: ledger-recall specifies that a **private/disabled target session is excluded from recall enumeration** and direct refs behave as not-found; no test ID covers it (UT-PRIV-01..03 cover the caller's own suppression, ISO-04 covers pulse/ledger appearance, T13 covers cross-workspace only). testing.md:457 says "any requirement without a test is a planning defect". | Add `UT-RECALL-06`/`ISO-05` (or extend ISO-04) asserting private-session exclusion from recall enumeration and refs; map it in execution-plan §13. |

---

## 4. P2 findings (one cleanup pass, not sign-off-blocking)

| ID | Where | Finding | Required change |
|---|---|---|---|
| V9 | `adr/0001:121`, `adr/0002:32`, `execution-plan:120`, `ui.md:147` vs `adr/0001:431` (E9), `store-format:74,85`, `data-model:109` | `writerId` format drifts: `<pid>-<random>` vs normative `<pid>-<8 lowercase hex>` | One spelling everywhere (`<pid>-<8 hex>`). |
| V10 | `adr/0001:188` (`seq="1841"`) vs `adr/0001:431` (E9) and `architecture.md:749-755` | ADR pulse template shows a numeric cursor though the binding definition is a 26-char ULID; architecture records the deviation but the ADR body remains inconsistent | Fix the ADR example to a ULID (or mark it explicitly illustrative in the ADR itself). |
| V11 | `architecture.md:791-793` vs `adr/0003:43` | architecture claims "**ADR 0003 §2 spells it `confluence_watermarks` (plural)**"; the ADR is singular and no plural occurrence exists anywhere (grep: 10/10 singular) | Delete the false erratum claim. |
| V12 | `tool-api.md:99-100` vs `tool-api.md:564` and `adr/0001:152` | tool-api says the `replyTo`→`reply_to` normalisation is "recorded as a deviation in §9", but §9 is titled "Never do" and contains no deviations; the ADR table still shows `replyTo?` | Add a real "Deviations" subsection (or correct the ADR table) and point to it. |
| V13 | `ui.md:168,173,183` vs `adr/0001:429-430` (E9), `data-model:63` | Panel payload examples use legacy short ids `n-8f2a1c`, `n-…`; final convention is `cnf_<ULID>` | Update payload examples to `cnf_…`. |
| V14 | `security-privacy.md:259` (T3 "title truncated to 120 chars") vs `data-model:347` (160) and `pulse.md:243` (60 in pulse) | Three different title caps in one contract set | Use the owning caps: stored 160, pulse 60. |
| V15 | `security-privacy.md:184-186,300,315-316` vs `.gitignore:30` | Doc repeatedly says root `.gitignore` "does not yet list `.confluence/`"; it does (`# Confluence workspace export (opt-in, local)` `.confluence/`) | Remove the stale guidance/open question. |
| V16 | `security-privacy.md:17` | Asset table says workspace identity lives in "journal/`workspace` records"; E11 and `data-model` put it in `MANIFEST.v1.json`, and no `workspace` record type exists | Correct to `MANIFEST.v1.json`. |
| V17 | `security-privacy.md:276` (T20 "missing dir → lexical key + `pathVerified:false`") vs `adr/0001:90-95`, `data-model:56-57`, `architecture:165-168` | Test matrix invents a lexical-fallback key that the binding design forbids (realpath failure ⇒ no key) | Align T20 with the owner docs. |
| V18 | `data-model.md:532` | "full manifest is in `store-format.md` §12" — the manifest section is §15 | Fix the pointer. |
| V19 | `ledger-recall.md:34` (`ts:<ms>`) vs `data-model.md:30,103` and its own example `:46` | Stale millisecond-number wording (architecture §14.9 already calls this remnant out) | Fix to ISO-8601 string. |
| V20 | `README.md:305` and `README.md:174-175` | Roadmap M4 row still lists "badge/custom cards" although E7/plan defer them to v0.1.1; README claims an empty `src/` directory that does not exist in the repo | Update M4 row; delete or create the `src/` reference. |
| V21 | `execution-plan.md:126-129` vs `data-model.md:4.7` (`:236-247`); `execution-plan.md:40` vs `:108` | M1.3 says persist `{wsKey, canonicalPath, label, firstSeenAt}`, but label is resolved live and the manifest stores `createdAt`; the plan's "repository start state" omits `test/contract.test.js`/`scripts/check.mjs` while M1.1 lists them as new deliverables (double-counted). | Align field names/locations; correct the start-state inventory. |
| V22 | `docs/README.md:45` vs `adr/0006:3` | ADR-0006 header says **Proposed**; docs/README lists it as a Round-3 decision record like 0002–0005 | Label it "Proposed (future merge phase)". |
| V23 | `publishing.md:110-113` | Recorded dry-run sizes (packed 22,677 B / unpacked 59,830 B) no longer match the current tree (E3: unpacked 60,564 B, 9 entries) because docs changed after the observation | Re-run and re-record at the next release checkpoint; mark the current row "stale as of 2026-11-13". |
| V24 | `testing.md:76,402`; `m0-spikes.md:36,39,40`; `solo-bench-integration.md:119-124,157,441,443`; `tool-api.md:15`; `ui.md:54`; `adr/0001:317`; `adr/0006:8,98-99` | Machine-specific absolute paths (`C:\Users\71408\…`, `D:\05_Code\…`) appear in commands/wireframes/evidence notes intended for a public repo. No secrets; most are legitimate local evidence or worked examples. | Not all must change: keep local-evidence citations, but parameterise executable commands/wireframes (`<DSH_HOME>`, `<repo>`, `<workspace>`) or add a "this machine" note per file; never ship a command that only works on the author's machine. |
| V25 | `index.js:41-69`, `cordis.patch.yml:24-112`, `test/contract.test.js:89-112`, `scripts/check.mjs:77-100` | Four hand-maintained copies of the default config (`DEFAULTS`); they already drifted (V3). The contract test compares patch snippets against its own copy, not against `index.js`/config.md. | Single source imported by tests/checker, or a generated-assertion that compares all four copies. |
| V26 | `docs/design/options/option-a.md` (e.g. `:18,:553,:668`) and `option-b.md` | Historical option documents still contain superseded claims (e.g. "replaces the previous snapshot") that ADR-0001 §17 E1 corrected. `docs/README.md:83` labels them "historical/superseded", which is sufficient. | No change required; keep the historical label. Do not cite these files as current behavior. |

---

## 5. Cross-document canonical-value audit (Lead checklist B)

| Canonical value | Result | Evidence |
|---|---|---|
| `dsh-confluence` / row `confluence` | **PASS** | `package.json:2`, `cordis.patch.yml:22-23`, `config.md:272-274`, `index.js:32`, tests |
| `cnf_` / `tmb_` ids (`sig_` reserved) | **PASS in binding docs; FAIL in UI examples** | `adr/0001:429-430`, `data-model:63-66`, `store-format:662`; drift V13 |
| `seq` 26-char ULID | **PASS** (except ADR template V10) | `adr/0001:431`, `data-model:75-99`, `architecture:749-755` |
| `writerId` | **FAIL (P2)** | V9 |
| `journal.<writerId>.v1.jsonl` | **PASS** | `adr/0001:108`, `adr/0002:31`, `store-format:54,84`, `architecture:62,77`, `README:100` |
| store `MANIFEST.v1.json` vs export `manifest.json` | **PASS in ADR/ADR-0002/store-format/solo-bench; FAIL in config.md/security-privacy** | E8; V1 |
| `schema` + `formatVersion` (export) | **FAIL (P1)** | V1 |
| `memories.v1.jsonl` | **PASS** | `store-format:432-446`, `solo-bench:182-198`, `adr/0002:47`, `plan:238-240` |
| singular `confluence_watermark` | **PASS** | `adr/0003:43`, `architecture:270,508`, `pulse:333`, `execution-plan:141,419`; only architecture's meta-claim is wrong (V11) |
| `digestSeq` / `boardReadSeq` semantics | **PASS** | `adr/0003:41-59`, `pulse:323-402`, `data-model:318-336`, `architecture:504-522`, `README:115-117` |
| Six tools + parameter names | **PASS** (`board/read/search/reply/recall/post`) with P2 ADR-camelCase drift | `tool-api:96-423`, `adr/0001:149-156`, `README:63-64`, `testing:99`; V12 |
| Config defaults (2000/90/8192/8/1400/3/2/3/5/5000) | **PASS except board-cap semantics and redactPatterns** | `adr/0001:257-274`, `config.md`, `cordis.patch.yml`; V2/V3 |
| Pulse 200–320 tokens / hard 1,400 chars | **PASS** | `adr/0001:198`, `pulse:255-283,10-11`, `config.md:62-71`, `data-model:372` |
| Recall 3 sessions / 5 hits / 5,000 ms / 600 chars | **PASS** | `adr/0001:243-248`, `config.md:87-98`, `ledger-recall:10-11,237`, `testing:205-207` |
| 13.0 engineer-days + 2026-11-16 → 2026-12-02 (worst 12-08) | **PASS** | `adr/0001:333-345,416-420` (E7), `execution-plan:51-59,476`, `README:307`; README M4 note drift V20 |
| M4 deferral to v0.1.1 (badge/cards/composer) | **PASS in ADR/plan; README row stale** | E7 `adr/0001:341,416-420`; `execution-plan:247-250,323`; V20 |

---

## 6. Correctness against installed evidence (Lead checklist C)

- **Append-not-replace (E1): CORRECT.** Re-read independently: `RuntimeContextProjection.project()`
  dedupes on retained text (`dsh-agent-loop/lib/index.js:296-348`) and the loop commits with
  `surfaceOp:"append"` (`:859-866`); `Session.deriveMessages()` derives from every surface node
  (`dsh-session/lib/index.js:1681-1696`). The ADR's correction, pulse §4.3 and architecture §9.3 are
  consistent; round-1/round-2 still contain the earlier superseded "replacement" wording only in
  historical option documents (V26). E1 is verified and the design correctly does **not** rely on
  collision.
- **FTS disabled: CORRECT.** `dsh-base/cordis.patch.yml:149-161` and `dsh-web-app/cordis.patch.yml:22-30`
  both mount `session-query-sqlite` with `path:':memory:'`, `openAt:never`. Docs state this and design
  around it (board mirror + literal `filterEvents`); the `filterSessions` exact-cwd pitfall is corrected
  to `listSessions()` + canonicalisation (`round-2:49-52`, `ledger-recall:13`, `architecture:316-322`).
- **`storageDomain` rejection rationale: CORRECT.** `domain/changed` is in-process only and
  storage-json has no cross-process lock (verified earlier in research; `adr/0002:16-19`), so the
  JSONL-shard decision is justified rather than taste.
- **JSONL shard/append/fsync claims: MOSTLY CORRECT.** E10's O_APPEND+writeSync and durability policy
  are consistent across ADR-0002/store-format/architecture/plan; stale `appendFile` remnants exist in
  security-privacy.md and M0-S4 (V4). `dsh-atomic-write` no-append/no-fsync claims are verified
  (package README:12,124) and it is correctly demoted to an optional guarded accelerator.
- **`sessionProjections` fold feasibility: PLAUSIBLE, correctly gated by M0.** I verified the runtime
  uses only `stateSchema.parse(...)` for restore/checkpoint reads (`dsh-session-projection/lib/index.js:379-383,
  424-432,496-582`) so the plain `{parse}` object is sufficient; the registration path returns an
  awaitable handle; host-only units are checkpointed. E6's dual `tool/result`/`tool/ptc-dispatch` fold is
  sound.
- **`tool/ptc-dispatch`: CORRECT.** It is a real durable session event (`dsh-session/lib/types/known-event-types.js:75`)
  appended by the PTC executor (`dsh-tool-executor-ptc/lib/index.js:533-543`); the docs' remaining
  HYPOTHESIS (does `shapeDispatchLog` preserve full text blocks) is correctly marked as an M0 item.
- **`host.call`: correctly unverified.** Existence observed live; host registration contract is marked
  HYPOTHESIS everywhere (`ui.md:108`, `adr/0005:3`, `testing.md:43,449`), the route fallback is documented
  and the Lead's pending "no fetch" ruling is stated (ADR-0005 O2, round-2 R4). No over-claim found.
- **No-network posture: CORRECT for the scaffold, designed for the product.** `test/contract.test.js:400-408`
  enforces no network/child-process/static-DSH imports on `index.js`; `docs/README`/README do not claim
  runtime verification. The only residual is that the same-origin route fallback is an HTTP request on
  the local origin — documented as "not egress" and awaiting the Lead's wording decision, not hidden.

---

## 7. Solo-bench integration soundness (Lead checklist E)

**Sound.** The plan reads `solo-bench`'s real constraints (single SQLite file, no server/port, no
model API, no `os/exec` in phase 0, fixed four service rows, "不加许可证文件") and correctly concludes:
vendor via `git subtree --squash` from a local path, consume only the opt-in file export, never the live
journal; no fifth service row; no root license file; no reverse dependency; no DB/schema change; Go
consumer uses only the documented `confluence.memories/v1` rules and validates the manifest first
(size/hash/counts) before parsing. This is compatible with every documented `solo-bench` constraint,
with the exit condition "separately approved later phase". The only integration-contract defect is V7
(recordCount vs tombstone stubs), which must be fixed before the M4 fixtures are authored.

---

## 8. Residual risks (accepted / tracked)

1. **Everything runtime is unverified in this phase.** The pulse dedupe, projection fold, PTC
   reachability, `host.call`, Windows append/fsync/watch, and `process.kill(pid,0)` are all M0-gated;
   the docs say this, and the plan stops on an S1 failure. Until G1 the deliverable is a *design*.
2. **Platform coupling.** The pulse economics and watermark fold depend on 0.2.2-rc.1 loop internals
   (`source.kind`, named `sections`, `surfaceOp`, commit dedupe); upgrade re-verification is documented
   (ADR-0003 Consequences; CON-UPGRADE-01).
3. **Trust/adoption risk unchanged by design:** v1 is awareness + on-demand literal search; the board
   only knows what was posted, and recall is literal-only (honestly stated in README/ADR).
4. **Privacy residuals:** best-effort redaction, same-user store readability, and the documented fact
   that a private session's DSH log remains readable by DSH tools outside Confluence (security-privacy
   §5.4). V8's missing recall-exclusion test is the one control gap.
5. **Multi-window topology unmeasured** (M0-S5); polling is the contract, so correctness does not hang
   on the answer, only the wording.
6. **Four duplicated config-default copies** (V25) already produced a real drift (V3); without single-
   sourcing, the next config field will drift again.
7. **Schedule confidence:** 13.0 ed ±30 % with no CI and a Windows E2E harness is plausible but thin;
   M3 transport remains the lowest-confidence milestone (execution-plan §15).

---

## 9. What I could not verify (stated honestly)

- Any runtime behavior of the plugin (not implemented; no live activation was performed by design).
- The M0 spikes (S1–S7): all results are `TBD`; the "M0 results" wording in docs/README is wrong (V5).
- Client slot **props** / rendered panel (the docs record client-inspect timeouts; the Lead's live facts
  are cited but no artifact is committed in the repo; M0-S6 / M3 must confirm).
- Windows `fsync`/rename/torn-line behavior on NTFS, `fs.watch` reliability, `process.kill(pid,0)`
  semantics, profile ACL inheritance — all M0/M4 items.
- GitHub push / npm publish / tarball hashing — blocked or not executed, as documented.
- `solo-bench` "untouched" via VCS: the directory is not a git repository; verification is observational
  (this reviewer only read files and ran no write there).
- Design token-measurement targets (pulse ≤320 tokens, tool schema ≤1,000 tokens) are estimates until M1
  measures them; the docs label them as targets.
- The exact `npm pack` shasum recorded in publishing.md (numbers are stale; V23).

---

## 10. Required changes before sign-off (ordered)

1. **V1–V4** (export manifest contract, board-cap semantics + placeholder, `redactPatterns` in shipped
   defaults/examples/tests, append primitive in security-privacy + M0-S4) — these would produce wrong
   implementation or wrong M0 evidence.
2. **V5–V6** (honesty: docs/README M0 over-claim; testing.md CON-* under-claim) — a documentation package
   whose own verification tables are wrong undermines its central discipline.
3. **V7–V8** (export recordCount/stub rule; recall private-target test) — must land before M4 export
   fixtures and before G3.
4. **V9–V26** as one cleanup commit (canonical-value drift, stale references, duplicate defaults,
   absolute-path parameterisation).

**Recommendation to the Lead:** accept the architecture and treat this as **PASS WITH FIXES**; close
P1 items V1–V8 in one documentation commit (no code exists to change yet), then open G0/M0. Do not
promote any "verified" claim for runtime behavior until the M0-S1/S2/S3/S4 evidence exists in
`m0-spikes.md` §10 and G1 closes.

---

## 11. Fix disposition (Lead, 2026-11-13)

Closed in one documentation commit before G0/M0, as recommended by this review. No implementation
code existed, so every fix is a documentation/scaffold change.

| Finding | Status | Where fixed |
|---|---|---|
| V1 export manifest naming | **Fixed** | `design/config.md`, `design/security-privacy.md` |
| V2 board-cap semantics + placeholder | **Fixed** | `design/config.md` |
| V3 `privacy.redactPatterns` shipped in defaults | **Fixed** | `cordis.patch.yml`, `index.js`, `test/contract.test.js`, `scripts/check.mjs`, `examples/profile-patch.yml`, drift assertion added |
| V4 append primitive in M0-S4 + security-privacy | **Fixed** | `plan/m0-spikes.md` (S4 rewritten around held O_APPEND fd + `writeSync`), `design/security-privacy.md` |
| V5 M0 over-claim in docs index | **Fixed** | `docs/README.md` |
| V6 CON-* under-claim in testing table | **Fixed** | `design/testing.md` |
| V7 export `recordCount` vs tombstone stubs | **Fixed** (one rule in both docs + conformance fixtures) | `design/store-format.md` §14/§17, `design/solo-bench-integration.md`, `design/testing.md` |
| V8 recall private-target exclusion test | **Fixed** (`UT-RECALL-06` + ISO-04 mapping) | `design/testing.md`, `plan/execution-plan.md`, `design/ledger-recall.md` |
| V9–V23 (P2 cleanup: writerId, ULID example, false erratum, deviations section, `cnf_` ids, title caps, stale `.gitignore`, workspace metadata location, T20, manifest pointer, `ts` type, README M4/src, plan metadata, ADR-0006 status, stale pack sizes) | **Fixed** | across ADR-0001/0002/0003, design docs, plan, README/README.zh-CN, publishing |
| V24 machine-specific absolute paths | **Accepted, deferred**: legitimate local-evidence citations remain; executable commands/wireframes are parameterised where they would mislead, and no secrets are present. Re-check before publishing. | — |
| V25 four duplicated config-default copies | **Mitigated**: `redactPatterns` drift assertion added to the contract test/checker; single-sourcing remains a P2 cleanup accepted for M1. | `test/`, `scripts/` |
| V26 historical option docs superseded wording | **No change** (kept as historical record, labelled in docs index). | — |

Post-fix verification, executed 2026-11-13 from `D:\05_Code\Confluence`:
`node --test "test/*.test.js"` → 18/18 pass; `node scripts/check.mjs` → 11/11 pass; tree committed
as a local commit (GitHub push remains blocked from this machine, as documented).
