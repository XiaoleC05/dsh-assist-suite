# ADR 0003 — Pulse channel, split watermark, and welcome digest

- Status: **Accepted** (design decision for v1; implementation starts at M1)
- Date: 2026-11-13
- Round: 3 (design documents). Binding upstream: [ADR 0001](0001-confluence-architecture.md) §8/§8.1;
  source decisions: [`../discussion/round-2.md`](../discussion/round-2.md) §2.2–3, positions
  [`position-a.md`](../discussion/position-a.md) §4/§5 and [`position-b.md`](../discussion/position-b.md) §4;
  detailed design: [`../design/pulse.md`](../design/pulse.md), [`../design/tool-api.md`](../design/tool-api.md),
  [`../design/ledger-recall.md`](../design/ledger-recall.md).
- Target runtime: DSH Desktop `0.2.2-rc.1`, profile `desktop`, fully offline. Design-only phase.

## Context

ADR 0001 fixed the three-pillar architecture and left four implementation questions that determine
whether the ambient layer is trustworthy: (a) which mechanism carries the passive digest, (b) how
"unread" is tracked without watermark files, (c) what a brand-new session sees on install day, and
(d) what the digest may contain without churning the prompt. Round 2 rejected a brief-only watermark
("unread forever") and `agent.inject()` as the passive channel (no dedupe, durable inbox growth). The
remaining options are only resolvable against the installed loop, which was re-read for this ADR.

## Decision

### 1. The passive channel is one `ctx.systemPrompt.context()` contribution

- Registered once as `confluence:pulse`, `order: 1500`, `required: false`, `interpolate: false`, with a
  synchronous, side-effect-free `text(assembleContext)` that reads only an in-memory board/presence
  mirror plus the session's watermark projection. Built-in context orders are 100–210
  (`dsh-system-prompt/lib/index.js:46-54`), so 1500 sorts deterministically after them; `required:false`
  makes the contribution removable by `suppressRuntimeContext()` for private/opted-out sessions.
- The loop renders all contexts into one runtime-context snapshot and commits it as a durable user
  message **only when the joined text differs** from the retained one
  (`dsh-agent-loop/lib/index.js:296-348`; snapshot preamble
  `dsh-system-prompt/lib/index.js:138-142`). Unchanged text therefore costs **zero** new tokens and
  emits no new message; the design goal "0 new tokens when unchanged" is a literal property of the
  loop, not an approximation.
- The provider is invoked up to twice per step (`assemble` + `refreshContext`) and must be idempotent
  and pure. Forge-resistance: the pulse block is identified by its **named section**
  (`source.sections[].name === 'confluence:pulse'`) in the committed message; only that section's text is
  parsed for the cursor. No wall clock, no status words, no disk reads, no asynchronous services.

### 2. The watermark is split and derived from the committed log

One `ctx.sessionProjections` unit `confluence_watermark` holds `{ digestSeq, boardReadSeq }`; no
watermark files are written (ADR 0001 §15.4 rejects the brief-only design).

- **`digestSeq`** folds from committed `user/message` events with `source.kind:'runtime-context'`: the
  `seq="<ULID>"` attribute of the `confluence:pulse` section. It proves which pulse block was delivered
  and drives welcome/steady decisions; `max`-monotonic, malformed ⇒ keep previous value.
- **`boardReadSeq`** folds from committed tool results that carry a `through=<ULID>` marker line —
  `tool/result` under the `standard` preset (`dsh-tools/lib/pipeline.js:196-213`) and
  `tool/ptc-dispatch` under the `ptc` preset (`dsh-tool-executor-ptc/lib/index.js:533-543`). It advances
  only when `confluence_board`/`confluence_read` results are committed.
- Fork/resume/replay inherit cursors through the copied/replayed log; the projection cache checkpoints
  state, and a missing/mismatched checkpoint refolds from seq 0. If `sessionProjections` is unavailable,
  the plugin degrades to an in-memory per-session fold (lost on restart, forks do not inherit) rather
  than blocking activation.
- Naming alignment: the projection key and cursor fields above match `../design/architecture.md` §5.10;
  session/entry record fields are owned by `../design/data-model.md` §4.2; model-facing error codes are
  the bare codes in `../design/tool-api.md` §4 (internal writers may use their `E_` variants).

### 3. "New" headlines are unread headlines; welcome is bounded and one-time

- `New:` lines list entries with `seq > boardReadSeq` (≤ 3, newest first), and the `unread` header count
  is the same set. This yields **one committed snapshot per real state change** instead of two
  (deliver + settle), which is the dominant cost/noise control.
- A session whose `digestSeq` is unset (`null`; first step, never delivered a pulse) gets one bounded **welcome
  digest**: up to 3 newest entries, every open question/handoff capped to 2+2 titles, counts, peers,
  guide — then the normal steady block. A fork inherits the parent's snapshot and is not re-welcomed.
- Empty workspaces get a one-time onboarding line, then silence (`''` when there is nothing to show).

### 4. Documented correction to ADR 0001 §8

ADR 0001 says a changed pulse snapshot replaces "the previous one in the request history". Verified in
the installed bytes: the loop **appends** a new `user/message` with `surfaceOp:'append'`
(`dsh-agent-loop/lib/index.js:859-866`), and `deriveMessages()` derives from every surface node
(`dsh-session/lib/index.js:1681-1696`); no collapse was found. Consequence: every text change keeps its
tokens in history until compaction, so byte-stability (§3) and the measured 320-token cap are stricter
requirements, not wording. `HYPOTHESIS:` a future request layer may collapse superseded snapshots; M0
measures `deriveMessages()` after three changes. The design does not rely on either behavior.

## Rejected alternatives

1. **Brief-only / tool-advanced watermark** — "unread" becomes permanently stale when the model never
   calls the tool; unread counts lie (round-2 §2.2; ADR 0001 §15.4). Replaced by the split, log-derived
   cursors.
2. **`agent.inject()` / `followup` / timers as the passive channel** — no framework dedupe, durable inbox
   growth, wakes or delayed delivery, a second copy of content in history; reserved for a possible M4
   explicit-mention feature and out of scope (ADR 0001 §8, §15.5).
3. **Wall-clock pulses, ages, running/idle status** — churn the snapshot every step, teach agents to
   ignore it; status is low-value and a privacy leak; counts + titles only (position-a §4).
4. **`systemPrompt.section()` static text** — participates in every request with fixed content, cannot be
   deduped or cleared, and re-registration would churn the system prompt and prefix cache.
5. **Watermark JSON files** — single-writer assumptions break after window migration, and they duplicate
   the log as a source of truth (position-a A1); the projection derives it instead.
6. **Per-agent context registration** — unnecessary here: one global contribution with per-agent text
   from `context.agent` covers all agents; `agent.ctx` registration is reserved for future per-agent
   suppression.

## Consequences and risks

- **Positive:** zero-cost steady state, bounded 320-token block (measured split in `pulse.md` §6),
  forge-resistant cursor parsing, fork/resume by construction, no watermark files, no timers, no wake.
- **Snapshot accumulation** (correction §4): every change adds history tokens; mitigations are the
  single-commit rule, the welcome settle budgeted once per session, and M4 compaction. M1 must measure
  snapshot count vs. session length in a two-session scenario.
- **DSH-version coupling:** the design depends on (i) the loop's text-diff commit semantics and snapshot
  preamble, (ii) `source.kind === 'runtime-context'` plus `source.sections`, (iii) the
  `sessionProjections.register/stateOf` contract, (iv) `tool/result`/`tool/ptc-dispatch` shapes,
  (v) built-in context orders < 1500, (vi) `config` flags in ADR 0001 §10. Re-verify all six on every
  DSH upgrade and record in `docs/plan/m0-spikes.md`; tolerant parsing keeps the pulse and cursors
  fail-safe (repeat/duplicate at worst, never lost board notes).
- **Trust risk:** a wrong/stale/noisy pulse twice teaches agents to ignore it (ADR §16). Acceptance gate
  T1–T13 in `pulse.md` §11 must pass before M2, including the zero-new-token and forgery tests.
- **PTC preset:** the watermark fold must cover `tool/ptc-dispatch` as well; verify the dispatch
  `content` shape in M0 (HYPOTHESIS). If it is lossy, the cursor falls back to an approximation and the
  pulse stays fail-safe (duplicate reads at worst).
