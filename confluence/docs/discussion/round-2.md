# Round 2 — cross-critique and architecture decision

Status: decision record of the second design round. Round 1 (research + candidate options) is in
[`round-1.md`](round-1.md); the binding decision is in
[`../adr/0001-confluence-architecture.md`](../adr/0001-confluence-architecture.md).

Participants: `architect-a` (Option A author), `architect-b` (Option B author), Lead (`lead`).
Both architects reviewed each other's option documents and then received the Lead's "Option C"
synthesis (a hybrid: explicit board + metadata-only activity ledger + on-demand recall of prior
same-workspace sessions, with the passive runtime-context pulse). Their written positions are
[`position-a.md`](position-a.md) and [`position-b.md`](position-b.md).

## 1. Votes

| Member | Vote | Conditions / headline |
|---|---|---|
| `architect-a` | **C-with-amendments** | A1 (log-derived, split watermark; drop `brief`-only advance) and A2 (scope cuts to ~12 eng-days) are conditions; otherwise A-first is safer. Failure mode: "scope-induced mediocrity → trust collapse". |
| `architect-b` | **C-with-amendments** | A1–A8; adds a 1.5–2 day deterministic **lite-capture** stretch to avoid a "cockpit without content". Failure mode: awareness without the unposted fact. |
| `lead` | **C-with-amendments, as amended below** | Adopt both amendment sets except two rulings (workspace key, reply merge); lite-capture deferred to v2 behind a precision/recall eval gate. |

No member rejected the hybrid. The disagreement is about risk allocation: A wants determinism and
a smaller surface, B wants content in the pulse. The Lead's decision keeps A's risk posture for
v1 and keeps B's content engine as the documented v2 step (with B's record schema retained, so
there is no migration).

## 2. Where both positions agreed (adopted wholesale)

1. **Storage:** per-writer sharded, append-only JSONL journals; `fs.appendFile` on the hot path;
   no `storageDomain` for the board (verified in-process-only change event and no cross-process
   lock); `writeFileAtomic` cannot append and does not `fsync`, so it is not the append primitive;
   native `fs.open(path,'wx')` lease for the rare locking operations (compaction/export), optional
   dynamic import of `@deepseek-ai/dsh-atomic-write` only as an accelerator; torn trailing-line
   tolerance; per-line schema version; unknown record types ignored; 3–5 s **poll is the
   freshness contract**, `fs.watch` is a best-effort optimization; compaction deferred to M4;
   export must be a derived, deterministically sorted, redacted snapshot — never the live journal.
2. **Watermark:** a brief-only watermark is a correctness bug ("unread forever"). Split it into
   `digestSeq` (advances when a digest snapshot is committed) and `boardReadSeq` (advances when
   the board/entry is actually read). Prefer deriving both from the committed session log via a
   `sessionProjections` unit — no watermark files needed, fork/resume inherit through log copying,
   provider stays pure.
3. **Digest discipline:** byte-stable text; no wall-clock times, ages or running/idle status words
   in the pulse; presence = count + ≤2 sanitized titles; ≤3 unread headlines; fixed untrusted-data
   warning; `<`/`&`/U+2028 escaped; `interpolate:false`, `required:false`; return `''` when there
   is nothing new; measured (not guessed) token budget with a written split.
4. **Ledger is metadata-only and live-first:** title, session id, timestamps, turn counts, status,
   and ≤8 workspace-relative paths observed in tool calls; **no prompts, assistant text, tool
   outputs, reasoning, or command lines**; shell writes are invisible and PTC nested dispatch is
   log-only, so hints are always phrased as partial. No cold backfill in v1.
5. **Recall is explicit, capped, read-only, literal:** `listSessions` (not `filterSessions`, whose
   `cwd` filter is an exact raw-string match) → canonicalize each session's `header.cwd` → filter
   to the workspace → bounded reads (≤3 sessions, ≤5 hits, ~5 s) → every hit carries provenance
   and is expandable with `confluence_read`; never inside the synchronous prompt provider.
6. **Privacy guardrails:** workspace is the consent boundary; default-on **metadata** but
   default-off file hints in the pulse; title redaction (titles come from prompts); a journal
   field allow-list test; scoped `suppressRuntimeContext()` for private/opted-out sessions; recall
   output gets the same redaction/untrusted framing as board text; export opt-in only; docs must
   state both what is stored and what recall reads on demand.
7. **PTC reality:** parse `tool/call` **and** `tool/ptc-dispatch` for the ledger; validate tool
   availability and digest presentation in both `standard` and `ptc` presets (this profile's
   default is `ptc`).
8. **Boundaries with shipped DSH features:** `@`-mention snapshots stay the user-driven
   one-session reference; `session_*` tools (if enabled later) stay raw transcript search;
   Confluence owns the workspace-scoped ambient layer and the curated board. Do not call v1
   "retroactive recall": it is **awareness + on-demand literal search**.

## 3. Lead rulings on the open disagreements

### R1 — Workspace key: canonical **original project** (`header.cwd`), frozen per session

`architect-a` said `header.cwd` (matches DSH built-ins); `architect-b` said the effective
directory for live sessions (privacy: a session moved with `cd` should not keep leaking into its
old workspace). Decision: **`header.cwd`, canonicalized (`fs.realpath`, Windows case-folded),
frozen at first observation; fall back to the effective directory only when the header has no
`cwd`.** Reasons: (1) DSH's own Workspace registry, workspace UI and cross-session features group
sessions by `header.cwd`; matching them means "same workspace" means the same thing in the UI, in
recall authorization, and in Confluence. (2) The inverse silent migration is worse: an effective-
directory key would let a session that `cd`s elsewhere silently gain read access to that
location's notes mid-session. (3) Recall needs the built-in session grouping anyway.
Compromise mandated by B: the ledger records the effective directory as metadata; the panel can
show "session was started in X"; a moved session stays in its original workspace and cannot
inject notes into the new one. Revisit only with a user-facing "move session to workspace"
feature (out of scope).

### R2 — Tools: six tools, reply kept separate, `read` must expand recall references

`architect-b` proposed merging `reply` into `post` (5 tools) and renaming `read`→`entry`,
`search`→`find`. Decision: **six tools**, because threaded Q&A is the core collaboration verb and
a separate `confluence_reply` makes the verb obvious; `confluence_board` absorbs the old `brief`
(its only unique job, watermark advance, disappeared with the log-derived watermark);
`confluence_read`'s `ref` accepts **both** board ids and `session:<id>:<seq>` recall references
(fixes A's dead-end hole); names stay verb-conventional (`read`, `search`) with descriptions
stating "board only, not session history". Tool result renders carry the `through=` marker that
the projection folds for `boardReadSeq`.

### R3 — Lite-capture: deferred to v2, but pre-designed

`architect-b` wants a 1.5–2 day deterministic capture that extracts ≤2 decision/gotcha lines per
turn into the pulse. `architect-a` warns this re-introduces the extraction-quality risk that can
destroy trust in the pulse. Decision: **v1 ships without lite-capture**; the v2 record schema
(option-b §4.2), journal operation vocabulary and `memories.v1.jsonl` export contract are kept
verbatim as the extension substrate, and v2 is gated on a gold-set precision/recall benchmark
(≥90 % precision on decision/gotcha lines, measured on the user's own sessions). The v1 pulse is
still populated on install day by the welcome digest (recent open questions/handoffs/notes) and
by the live ledger.

### R4 — UI scope: read-only panel in v1, transport decided by an M3 spike

Read-only panel (timeline, search, entry/thread read, presence, mark-read, user opt-out controls);
no composer/thread screen and no per-session badge in v1 (badge M4). Writes from the UI are M4,
through the existing command surface (`ctx.remote.commands.execute('/confluence …')`), not a
second write channel. Transport: M3 spike decides between the verified client builtin
`host.call(method,args)` (host-side registration contract to confirm) and the proven same-origin
`ctx.webServer.register` route used by Crisp/dsh-context; both are local-only, add no port and do
no network egress; the fallback is pre-built behind one interface. No iframe. The earlier claim
that `connection.requestRejection` fencing is a documented precedent is retracted — it is a
spike item, not an assumption.

### R5 — Storage layout and export

Per-writer shards `journal.<writerId>.v1.jsonl` inside
`$DSH_HOME/storages/confluence/v1/workspaces/<wsKey>/`, presence heartbeats in
`presence/<writerId>.json` (never journal ops), compaction/export under the native lease to
`snapshot.<gen>.v1.jsonl` + `MANIFEST.v1.json`. The `memories.v1.jsonl` export is written only by
an explicit user command/action (M4) into `<workspace>/.confluence/export/`, is deterministic,
redacted, absolute-path-free, excludes raw ops (or marks `deleted`), and is the only file
`solo-bench` is expected to consume. Export never feeds back into the plugin.

## 4. Corrections accepted into the design

- `filterSessions({kind:'cwd'})` matches the raw `header.cwd` string exactly → recall enumerates
  with `listSessions()` + canonicalization in code (B).
- Cold `sessionQuery` reads replay whole logs and cannot run in the synchronous provider → ledger
  is live-only in v1; recall is on-demand (both).
- `writeFileAtomic` neither appends nor `fsync`s → `appendFile` + shards + a stated durability
  policy (B).
- `tool/call`-only ledger is empty under the default `ptc` preset → also parse `tool/ptc-dispatch`
  (A).
- `~200-token` pulse estimate was optimistic → budget 200–320 tokens with a measured split; hard
  cap 320 (A).
- `fs.watch` is not a freshness guarantee → polling is the contract (both).
- A global optional context is user-suppressible → private/opt-out sessions need the scoped
  suppressor (B).
- `host.call` vs route fencing claims corrected as in R4 (A, B).

## 5. Consequence

The final design ("Confluence / 高级记忆 v1") is a three-pillar hybrid with A's risk posture and B's
storage/watermark rigour, plus B's record schema reserved for v2. It is documented in
[`../adr/0001-confluence-architecture.md`](../adr/0001-confluence-architecture.md); round 3
produces the detailed design documents, execution plan, repository packaging and an independent
review.
