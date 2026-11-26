# ADR 0008 — Workspace session bus + global user profile (v0.3)

- Status: **accepted** (supersedes the scope rule of ADR 0007; other ADR 0007
  guarantees carry over).
- Date: 2026-11-19
- Product: Confluence 高级记忆 v0.3.0
- Related: `docs/plan/v0.3-interfaces.md` (binding), `docs/adr/0007-universal-memory-scope.md`
  (superseded only where this ADR says so), `docs/research/dsh-internals.md`.

## Context

ADR 0007 made memory universal per DSH profile: one global board, workspace as
provenance only, no workspace isolation. The product owner has since restated
the intent: the plugin exists to deliver **two** things —

1. **模块一 — 工作区会话总线**: sessions that share a workspace share a live
   context pool, a note board and addressed messages, so multi-window /
   multi-agent work no longer needs manual file passing.
2. **模块二 — 全局用户画像**: one durable, portable profile of the user
   (identity, stack, communication preferences, habits, rules), injected into
   every new session regardless of workspace, importable/exportable across
   machines.

The new requirements conflict with ADR 0007's "memory boundary is the profile,
never the workspace" rule. The owner decided the newest requirements win.

## Decision

1. **Two coexisting scopes.**
   - *workspace* — keyed by the canonical original `session.header.cwd`
     (realpath, win32 lower-case, `ws_<sha256[:16]>`), stored under
     `workspaces/<wsKey>/`. Holds the M1 bus: keyed context, notes, messages.
     Not merged across workspaces.
   - *global* — `GLOBAL_SCOPE_KEY = ws_0000000000000000`. Holds M2 profile
     facts, plus the unchanged metadata-only session ledger and presence
     heartbeats.
   ADR 0007's single-global-scope rule is superseded. ADR 0007's other
   guarantees remain in force: profile-local storage, offline (no network /
   port / subprocess / model call), append-only JSONL, bounded prompt text,
   untrusted shared content, metadata-only ledger, best-effort redaction,
   `privacy.privateSessions` invisibility.

2. **The product surface is the two modules.** The global "shared board for
   every session" framing is retired. Notes become workspace-scoped; a new
   global profile replaces the old global-board role. `confluence_recall`
   (prior-session literal search) stays as a secondary capability because it is
   orthogonal and already verified.

3. **Delivery of peer messages is queue-based, never interrupting.**
   DSH 0.2.2-rc.5 has no silent cross-session notice channel. Every active
   channel (`sessionController.prompt`, `agent.followup/steer`, `ctx.schedule`)
   forges a user-role message, can wake an idle session and spends an LLM call.
   v0.3.0 therefore writes a durable `message` record and surfaces it:
   - in the recipient's **next-step pulse** (`<confluence-memory scope="workspace">`),
   - and in the explicit `confluence_inbox` tool (advancing an `inboxReadSeq`
     cursor derived from the session log, like the existing board cursor).
   A message sent to a running session becomes visible at that session's next
   step (seconds); an idle session sees it on its next turn. Optional
   wake/inject delivery is explicitly out of scope for v0.3.0 and remains a
   future, opt-in decision requiring a new ADR.

4. **The user profile is semi-automatic.** The plugin performs no extra model
   calls and no prompt scraping. The agent maintains the profile through
   `confluence_profile` when the user reveals durable facts (the tool
   description and the profile block instruct it to), the user can ask
   explicitly, and files/CLI/panel allow deterministic import/export. Profile
   facts are LWW per `(section,key)` with source and confidence; injection is
   one additional bounded, byte-stable `systemPrompt.context` contribution.

5. **Panel becomes two read-only views** (workspace bus, user profile) served
   by the existing same-origin GET routes; no writes, no new port, no new
   dependency, no build step. Workspace ids in payloads are opaque hashes;
   labels are basenames/registry titles only.

6. **Legacy data is preserved read-only.** v0.2 global board entries stay on
   disk untouched and are not attributed into workspace views (no reliable
   attribution for every row). A v0.1 workspace directory, when it exists, is
   simply the journal directory of that workspace in v0.3 — old notes appear in
   that workspace's bus without migration. Nothing is rewritten or migrated.

7. **Breaking version 0.3.0** with documented config migration
   (`store.maxEntriesPerWorkspace` → `bus.notes.maxEntries`, `pulse.*` →
   `bus.pulse.*`, `export.*` ignored) and a full upgrade note.

## Consequences

- Memory is now two-tiered: same-workspace collaboration is fast and isolated;
  cross-workspace knowledge flows only through the deliberate profile layer.
- A workspace without a resolvable `header.cwd` gets no bus (`NO_WORKSPACE`);
  the profile still works. This mirrors DSH's own workspace semantics.
- Message "instant" means "next model step", not "interrupt". This is honest,
  safe, and offline; the alternative would forge user messages and cost tokens.
- Profile facts are user-controlled local data; export is explicit and
  redacted, import is validated and bounded.
- v0.2 global-board users keep their data on disk but lose the global board
  view; this is an accepted product trade-off recorded here.
