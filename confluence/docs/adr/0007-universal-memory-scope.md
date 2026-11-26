# ADR 0007 — Universal memory scope (v0.2.0): the profile, not the workspace, is the memory boundary

- Status: **Accepted** (supersedes ADR-0001 §5 and the workspace-scoped parts of §8/§9/§12)
- Date: 2026-11-16
- Builds on: [ADR-0001](0001-confluence-architecture.md) (three-pillar architecture, storage, pulse,
  privacy), [ADR-0002](0002-store-format-and-concurrency.md), [ADR-0003](0003-pulse-and-watermarks.md),
  [ADR-0004](0004-privacy-and-consent.md)
- Target: DSH Desktop 0.2.2-rc.1, fully offline; plugin version **0.2.0**

## 1. Context

v0.1.0 implemented the original brief literally: sessions share memory **inside one workspace**, keyed
by the canonical `session.header.cwd`. The user has clarified the product intent:

> "这个插件更像是一个长对话和便捷共享记忆插件，这个是通用的，而不是单独给某一个工作区设置的。"

i.e. Confluence is a **universal, long-conversation + convenient shared-memory plugin**. The memory
belongs to the user's DSH profile and applies to every session; the workspace is incidental. Scoping
memory per project directory makes the plugin feel like a project tool, fragments memory across
directories, and hides prior context from a new conversation started in another folder.

## 2. Decision

**One universal memory space per DSH profile.** Every session, in every workspace, reads and writes the
same shared memory. Workspace and session are *provenance metadata* on memory entries, never a
partition, filter barrier, or permission boundary.

Concretely:

1. **Scope.** A single logical scope `global` (`GLOBAL_SCOPE_KEY = "ws_0000000000000000"`, label
   `"All sessions"`). `lib/workspace.js` is reduced to an **origin resolver** used for provenance only:
   it still canonicalizes `header.cwd`, but the result becomes
   `origin = { workspaceKey, workspaceLabel }` attached to entries/ledger rows/presence. No tool, pulse,
   recall, panel or export is conditioned on the workspace.
2. **Storage.** Keep the v1 on-disk family, but write only to the reserved global scope
   (`$DSH_HOME/storages/confluence/v1/workspaces/ws_0000000000000000/`). Legacy per-workspace journals
   (`workspaces/ws_<16hex>/`) remain on disk untouched and are **merged read-only** into every view
   (their `ws` + manifest canonical path provide provenance labels). No destructive migration, no data
   deletion; a legacy writer process from an older plugin version would still append to its own shard
   (harmless, merged on read).
3. **Pulse.** One global digest injected into every session: unread shared notes (any session),
   open questions/handoffs, and **all live peers**, with the tag renamed to
   `<confluence-memory scope="global" …>`. Per-session split watermarks (`digestSeq`, `boardReadSeq`)
   are unchanged in mechanism but now track the global sequence.
4. **Tools.** The same six tools, now universal: `confluence_board/post/read/search/reply/recall`.
   `confluence_recall` searches **all earlier sessions in the profile** (not only the caller's cwd);
   only the caller itself and `privacy.privateSessions` are excluded, with the same caps
   (≤3 sessions, ≤5 hits, 5 s, literal match). Tool descriptions stop saying "this workspace".
5. **Panel.** One global timeline, "高级记忆 / Confluence memory": entries, a kind filter and free-text
   search (search matches titles, bodies and tags; there is no separate tag-facet control in v0.2.0),
   provenance chip showing the originating workspace label, live peers. No workspace switcher.
6. **Config (breaking).** Remove `privacy.disabledWorkspaces` (there is no workspace boundary to
   disable). Rename `ledger.maxSessionsPerWorkspace` → `ledger.maxSessions` (global cap). Keep
   `privacy.privateSessions`, redaction, caps, pulse budgets, poll, UI, export, debug. `memory.scope` is
   **not** configurable in v0.2.0: universal is the product.
7. **Export / solo-bench.** Export remains the `confluence.memories/v1` contract so the Go consumer
   keeps working unchanged: manifest gains an additive `"scope": "global"` and reports
   `workspace: { wsKey: "ws_0000000000000000", name: "All sessions" }`; every record uses the global
   `wsKey`; optional additive `origin: { workspaceKey, workspaceLabel }` carries provenance (unknown
   fields are ignored by v1 consumers). CLI drops `--workspace`; default output is
   `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`, `--out` may override.
8. **Privacy.** The profile/machine is the sharing boundary (single-user local workbench). Within one
   profile, shared memory is readable by every session by design; `privacy.privateSessions` opts a
   session out of ledger/pulse/tools entirely. README/docs/UI state this plainly; export stays opt-in
   and redacted.

## 3. Consequences

- Existing v0.1.0 memories are not lost: they appear in the global timeline/pulse/export through the
  read-only legacy merge; their provenance labels come from the old manifests.
- A new conversation in any directory immediately sees the user's shared memory — the actual pain point.
- Cross-workspace information now flows by default; docs must sell the privacy model honestly and keep
  redaction/opt-outs/export gates.
- v0.1.0 configs with `privacy.disabledWorkspaces` / `ledger.maxSessionsPerWorkspace` get activation
  warnings and defaults; upgrade notes required.
- Panel and E2E must be re-verified; the cross-workspace E2E (session A in one directory, session B in a
  different directory, same profile) becomes the headline acceptance test.
- Version bump to 0.2.0; the installed link bundle requires a DSH restart to load the new Host module
  generation.

## 4. Rejected alternatives

- **Workspace mode with a global toggle** — keeps the wrong default and doubles the state model.
- **Destructive migration of legacy journals** — risk without benefit; read-only merge is enough.
- **Per-project opt-in isolation** — reintroduces the fragmentation the user rejected; `privateSessions`
  covers the narrow secret-session case.
- **Bumping the export schema to v2** — unnecessary; additive fields keep the solo-bench Go consumer
  compatible today.

## 5. Compatibility promise

- Scope: universal from v0.2.0 onward. There is no supported configuration that partitions memory by
  workspace; a future per-topic grouping must be a *view*, not an isolation boundary.
- Export: `confluence.memories/v1` field contract stays valid; `scope` and `origin` are additive.
- Legacy store layout stays readable; global scope directory is reserved and must never collide with a
  real workspace path.
