# ADR 0004 — Privacy and consent for workspace memory

- Status: **Round 3 — decision record** (design phase; binding once accepted). Refines
  [ADR 0001](0001-confluence-architecture.md) §11/§12; does not supersede it.
- Date: 2026-11-13. Author: `design-surface`.
- Inputs: ADR-0001 §11; [round-2](../discussion/round-2.md) R2/R5 and "corrections accepted"
  (title redaction, allow-list test, scoped suppressor); [option-b](../design/options/option-b.md)
  §7; detail in [`security-privacy.md`](../design/security-privacy.md) and
  [`config.md`](../design/config.md).
- Target: DSH Desktop 0.2.2-rc.1, single OS user, Windows 11, fully offline.

## Context

Within one workspace, sessions are the same user's own conversations in the same project directory.
The promise — "your sessions remember together" — requires board notes and bounded session metadata
to be shared automatically; per-note or per-session consent *at capture time* would either interrupt
every session or capture nothing until the user predicts the future (the "opt-in-at-first-use"
failure). Across workspaces, sharing would be a real privacy breach. The store is plain text in the
user profile; `confluence_recall` reads prior DSH logs on demand; the panel shows the board to the
user. ADR-0001 fixed the *default* (metadata on, file hints off) but not the consent model.

## Decision

1. **Workspace = consent boundary.** Sessions resolve to one canonical workspace key; within it,
   board notes and metadata are shared by default and are the product. Nothing crosses a workspace
   key at any boundary (tool, pulse, recall, panel, export). Different directories are different
   consent domains.
2. **Default-on metadata, default-off file hints in the pulse.** Board, session titles/counts and
   presence are on; `ledger.fileHintsInPulse: false`, file hints capped at 8 workspace-relative
   paths, deny-listed (`.env*`, `*.pem`, `.ssh/`, keys, credentials), phrased "files seen in tool
   calls (partial)". No prompts, assistant text, reasoning, tool outputs or command lines are stored.
3. **Recall is explicit, on-demand, bounded.** `confluence_recall` reads prior same-workspace logs
   only when a model explicitly calls it; ≤3 sessions / ≤5 literal excerpts (≤600 chars), redacted,
   untrusted-framed, provenance-linked; never in the pulse provider, never auto-injected.
4. **User-only opt-outs at every boundary.** `privacy.privateSessions` / `privacy.disabledWorkspaces`
   are user-only config lists, toggled from the M3 panel through the config editor. A private session
   gets no pulse (a **scoped** `suppressRuntimeContext()` on `agent.ctx`), no ledger row, no presence,
   no tools; a disabled workspace is silent and hidden. Opt-out never deletes records; M4
   tombstone/forget is separate and states that DSH logs are not modified.
5. **Redaction before persistence, best effort and labeled.** Built-in secret patterns apply to
   titles and bodies, ledger hints, recall excerpts and export; re-applied at render. Docs, UI and
   tool output say "best effort, not a guarantee"; users must not paste secrets.
6. **Store inside the user profile.** Default root `$DSH_HOME/storages/confluence/v1`, never inside a
   repository; workspace writes only via explicit opt-in export (`export.enabled: false` default):
   deterministic, redacted, workspace-relative-path-only, with a generated `.gitignore` and
   git-commit-risk guidance.
7. **Transparency without telemetry.** The panel states what is stored versus read on demand, shows
   recall activity (live-process audit line in v1), and surfaces config warnings. No network, no
   additional port, no model call, nothing leaves the machine.
8. **Honest limits are stated.** A private session's DSH log still exists and is readable by DSH's
   own log tools; opt-out removes Confluence's collection/sharing, not DSH-owned data. Prompt
   injection is mitigated, not eliminated; DSH approval policy stays the real gate for actions.

## Rejected alternatives

1. **Default-off / opt-in-at-first-use.** Fails the zero-effort promise and consent at first use is
   uninformed; opt-outs give retrospective control instead.
2. **Per-note ACLs / per-entry permissions.** No accounts, identity model or admin UI in v1
   (ADR-0001 §3); inside one OS user this adds complexity without reducing the threat.
3. **Encryption at rest.** Key management without a server is a fake secret next to the ciphertext or
   a passphrase prompt on every start; it protects only against an attacker who can already read the
   profile, i.e. the same-user boundary that owns the session logs. Revisit only for multi-user or
   shared storage.
4. **Global transcript capture with consent modes** (option-b's `mode` enum + continuous indexing):
   changes the privacy default materially and adds extraction-quality risk; deferred to v2's
   eval-gated lite-capture with these boundaries unchanged.
5. **Workspace-local canonical store** (`<repo>/.confluence/` as primary): pollutes diffs, fails on
   read-only/shared checkouts, leaks notes to repo readers; kept only as the opt-in export artifact.
6. **Cross-workspace search or a "global memory" view.** It turns the consent boundary into a
   suggestion.

## Consequences

- Honest trade-off: useful by default inside a project, silent outside it.
- Every boundary needs a workspace-filter test; the journal needs a field allow-list test (encoded
  in `security-privacy.md` §6: T4/T6/T10/T11).
- The panel carries privacy copy and two confirmed controls; the README reuses the stored-vs-recall
  box (`security-privacy.md` §4).
- Residual risks are documented: best-effort redaction, same-user store readability, literal-only
  recall, live-only panel audit, no automatic capture.
- Revisit if multi-user storage appears, DSH ships an identity/permission layer, a v2 capture path
  changes what is stored, or the panel needs a store-layout addition for audit/forget.

## Open questions

1. Should first run show a one-time "memory is on for this workspace" notice with a direct opt-out?
   (No blocking flow; consistent with this ADR.)
2. Persisted recall audit (`audit/<writerId>.jsonl`) in M4, or is live-only transparency enough?
3. Is the "private session still leaves DSH logs readable" wording strong enough at the toggle, or
   does it need an explicit first-time acknowledgement?
