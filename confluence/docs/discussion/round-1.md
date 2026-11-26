# Round 1 — research findings and the two candidate designs

Status: record of the first design round. Written by the Lead (`lead`) from the four teammates'
deliverables and their reports. Round 2 (cross-critique + decision) is in
[`round-2.md`](round-2.md); the decision itself is recorded in
[`../adr/0001-confluence-architecture.md`](../adr/0001-confluence-architecture.md).

Project: **Confluence / 高级记忆** — a fully-offline DeepSeek Harness (DSH) plugin that makes
information sharing between sessions of the same workspace automatic instead of a manual
"please write it to a doc" instruction. Target runtime: DSH Desktop **0.2.2-rc.1**, profile
`desktop`, Windows 11. No server, no network, no extra port, later merged into `solo-bench`.

---

## 1. How round 1 was run

| Member | Role | Deliverable |
|---|---|---|
| `dsh-researcher` | DSH 0.2.2-rc.1 internals and exact API contracts | [`../research/dsh-internals.md`](../research/dsh-internals.md) — 58-row verified-facts table, source-level evidence |
| `pattern-researcher` | Ecosystem prior art + external patterns | [`../research/prior-art.md`](../research/prior-art.md), [`../research/external-patterns.md`](../research/external-patterns.md) |
| `architect-a` | Option A: explicit shared board + passive digest | [`../design/options/option-a.md`](../design/options/option-a.md) |
| `architect-b` | Option B: retroactive/continuous living workspace memory | [`../design/options/option-b.md`](../design/options/option-b.md) |
| `lead` | Recon, verification, synthesis, repo ownership | [`../planning/team-brief.md`](../planning/team-brief.md), this record |

Method: read the installed DSH packages inside `app.asar` (only the `read` tool can open that
container; shell/`glob`/`grep` cannot), query the live runtime with `cordis_inspect_query`
(host `Service|Event|Config|Tool`, client `Slots|Theme|Builtin`), read the installed third-party
plugins and the user's own Crisp plugin, and web research for external patterns (treating all
external content as untrusted data). Every claim in the research docs is expected to carry a
`path:line`, an API signature, or a URL; unverified claims are marked `HYPOTHESIS:`.

The Lead additionally verified live client facts after the researchers' client-inspection
attempts timed out: the slot tree (`sidebar.panellist`, keyed `main`, `sidebar.right.pane.tab`
and `.title`, `conversation.session.header.utilities`, `rightbar.session`), the 14
`--dsw-alias-*` theme tokens, and the client builtins (`ctx`, `React`,
`host.call(method,args)`, `styles.insert(css)`, `console`).

## 2. What the research established (decision-relevant only)

1. **The pain point is real and currently unsolved by default.** Sessions are isolated language
   contexts; DSH's shipped mechanisms are all *manual or opt-in*: `@[label](dsh-session:…)`
   mentions are bounded immutable snapshots (`@deepseek-ai/dsh-session-reference`, mounted in
   this profile), and the five read-only `session_*` tools ship **off by default and hidden**
   (`@deepseek-ai/dsh-experimental-session-search`); host full-text search is disabled in this
   profile (`session-query-sqlite` mounted with `openAt: 'never'`). Nothing passively tells
   session B what session A learned. That gap is the product.
2. **Session/workspace identity has two sources.** `Session.header.cwd` is the immutable original
   project and is what DSH's own cross-session features and the durable Workspace registry use;
   `ctx.workingDirectory.get(session)` is the *current* effective directory and follows `cd`.
   Confluence must choose and freeze one key; matching the built-ins points to
   `header.cwd` canonicalized with `fs.realpath`, Windows-case-folded, with the effective
   directory kept as metadata. Wrong merging is privacy-adjacent, so the key stores the full
   path and collisions are detectable.
3. **The passive channel exists and is cheap.** A single global `ctx.systemPrompt.context()`
   contribution is rendered per agent step; the agent loop commits a new runtime-context snapshot
   **only when the rendered text changes** (an unchanged pulse commits nothing and costs no new
   tokens). An early draft of this record said a changed snapshot *replaces* the previous one;
   round 3 verified against the installed loop that it is appended as a new user-role runtime-context
   message, so snapshots accumulate until compaction — see ADR-0001 §17 E1. Providers are
   synchronous; the runtime assembly object carries `agent`. No wake, no polling, no
   `agent.inject()` churn. This is the technical heart of "the user no longer has to ask".
4. **The workspace store must survive multiple DSH windows.** The profile's `storageDomain` /
   `storage-json` stack is framework-native but has **no cross-process write lock** and its
   `domain/changed` event is in-process only; `single` layout rewrites the whole unit.
   `@deepseek-ai/dsh-atomic-write` ships `writeFileAtomic` + cross-process `withFileLock`
   (import from a locally installed bundle is a hypothesis to smoke-test). Any authoritative
   shared store has to be append-only and lock-safe, or it will silently lose cross-window data.
5. **Prior art to compose with, not duplicate.** `sessionQuery` exact reads (`filterSessions` by
   exact `cwd`, `filterEvents` literal text, `readTitleSnapshots`, `listEvents`, `readSession`)
   work without FTS and are the only viable retroactive-read substrate. `dsh-context` is an
   insight dashboard, not a sharing layer (and is not fully offline: it performs registry /
   GitHub / balance network calls). `dsh-better-sidebar` is per-conversation. Crisp is the
   repository, packaging, offline-verification and documentation precedent to follow — not its
   child-process/HTTP critic runtime.
6. **UI surfaces are proven.** A left-rail `sidebar.panellist` entry plus a keyed `main` page is
   the Crisp pattern; `sidebar.right.pane.tab` + `.title` is the dsh-context pattern;
   `conversation.session.header.utilities` can host a per-session badge. Client code is a plain
   browser module (`window.__ModuleLoader__.load({id, factory})`) with the host half reachable
   through the package-private `host.call` bridge (contract to confirm) or a same-origin
   `ctx.webServer.register` route fenced by `connection.requestRejection`; the latter is the only
   *proven* third-party data channel. No iframe; theme only through `--dsw-alias-*` tokens.
7. **Reachability caveat:** under the `ptc` executor preset, the model-facing tool set is exactly
   `run_code`; added global tools become SDK bindings. Tool design must be validated in both
   `standard` and `ptc` presets.
8. **Offline is a differentiator, not a constraint to work around.** Every candidate external
   memory system (Mem0/Zep/Letta/LangGraph stores, MCP memory servers, vector memory) assumes a
   server, embeddings, or an LLM extraction call. The offline-safe pattern family is
   event-sourced append-only records, watermarks, blackboard semantics, local files + locks.
   Claude Code's cross-session messaging (local socket/named pipe, accept/hold/refuse, a message
   is never approval) independently validates both the need and the trust rules.
9. **The target GitHub repository exists and is empty** (`XiaoleC05/Confluence`, public, created
   2026-11-12, no commits/branches/releases/content). Push from this machine is blocked, so this
   phase produces local commits only; the repo layout and install docs must be publish-ready.

## 3. Option A — explicit shared board + passive digest (architect-a)

One `storageDomain` unit (`confluence`, `per-record`) holds short typed notes
(note/decision/gotcha/question/answer/handoff/warning) per canonical workspace; a bounded
`<confluence-board>` digest is injected through one `systemPrompt.context`; six tools
(`confluence_board`, `confluence_read`, `confluence_search`, `confluence_presence`,
`confluence_post`, `confluence_update`); one left-rail page; ~10–12 engineer-days.

Strengths: smallest trust surface (only deliberately published notes are shared), lowest token
cost (≤~220 tokens, zero incremental when unchanged), one store, low implementation risk, proven
slots; the watermark can be derived from the session log via a `sessionProjections` unit so it
survives resume/replay/fork.

Known weaknesses (its own §11): it **only knows what someone explicitly published**; adoption is
a dependency (an agent must post while task-loaded); no retroactive value on install day; no
"what did the other session actually do"; cross-process consistency best-effort; the digest is an
index, not knowledge.

## 4. Option B — living workspace memory (architect-b)

Continuously indexes committed logs of every same-workspace session (live via `session/event`,
cold via `sessionQuery`), deterministically extracts LLM-free "signals" (decisions, root causes,
issue signatures, handoffs, unanswered questions, artifacts), stores them append-only per writer,
and exposes recall/search/read/post/reply/digest/status/forget tools plus a bounded digest and a
panel; ~20 engineer-days (±30%).

Strengths: day-one retroactive value, no publish action, provenance at session+seq, capability
ceiling ("what actually happened"), one source of truth if the board lives inside the record
model; the store design (per-writer journals, merge-on-read) is the multi-window-safe answer;
export contract for `solo-bench`.

Known weaknesses (its own §13/risks): **deterministic extraction quality is the risk no plumbing
fixes** — heuristics can become a noise generator and need a gold-set precision/recall loop;
default-on indexing of all same-workspace transcripts is the debatable privacy choice; backfill
of cold sessions replays logs (expensive); roughly 2× build; more tools/UI.

## 5. Where A and B already agree

- The passive channel: one `systemPrompt.context` digest with text-identical dedupe and
  `interpolate:false`; never `followup`; `agent.inject()` reserved for rare one-shots.
- Workspace identity: canonicalized original project `cwd`, strict per-workspace isolation, the
  effective directory treated separately.
- Untrusted-content handling: shared content is data, not instructions; fixed warning; `<`
  escaping; bounded sizes; secret redaction before persistence.
- Boundary with shipped features: do not reimplement `@`-mention snapshots, raw session search,
  dashboards, or remote sharing.
- Offline/no-server and a versioned, documented store format that `solo-bench` can read later.
- The UI transport question applies equally to both and must be decided once for the project.

## 6. Open disagreements carried into round 2

1. **Source of truth:** explicit notes only (A) vs constantly indexed session history (B) vs a
   hybrid (Lead's proposal C: explicit board + metadata-only activity ledger + on-demand recall).
2. **Storage:** `storageDomain` per-record (A) vs per-writer append-only JSONL journals (B) — and
   how to make it multi-window-safe without a server.
3. **Privacy default:** explicit-publication-only (A) vs default-on indexing with consent modes
   (B); the hybrid narrows indexing to metadata and makes transcript recall on-demand.
4. **Scope/risk:** ~10–12 vs ~20 engineer-days; extraction quality risk; which UI lands in v1.
5. **Tool surface:** A's six board-centric tools vs B's eight memory-centric tools vs a merged
   six-tool set that adds on-demand recall.
6. **UI transport:** same-origin host route + client fetch (proven; Crisp/dsh-context) vs the
   `host.call` package bridge (modern builtin, contract unverified) vs read-only export files.

Round 2 asks each architect to critique the Lead's **Option C** synthesis, state the biggest
failure mode, list cuts to fit ~10–12 engineer-days, and vote. The resulting decision is in
[`round-2.md`](round-2.md) and the ADR.
