# Offline E2E harness (v0.4.0 — three-layer memory + style cards)

This directory backs `../../scripts/e2e-dsh.ps1`: the offline, throwaway-`DSH_HOME`
end-to-end harness for the Confluence v0.4.0 plugin. It proves the product without a
network, a real model or the user's live profile:

- **workspace session bus** — sessions in the same directory share keyed state,
  notes and queued messages; sessions in a different directory never see that data.
- **long-term memory** — `pattern` records are **candidate-first**: `add` stores a
  candidate (never injected), `promote` makes it active and injectable.
- **user persona** — the `profile` record type limited to six persona sections
  (legacy `preferences` → `communication` aliases fold at read time).
- **style cards** — `style` records in two channels (`chat` and `engineering`);
  a `set` rule is injected into later sessions.
- **migration** — the first attach converts v0.3 `tech`/`context` profile facts into
  `pattern` records and writes one `memory-migration` marker (idempotent).
- **portability** — `confluence.memory/v1` export, and legacy `confluence.profile/v1`
  documents still import (persona-only).

The harness creates a fresh scratch profile with `dsh plugin add`, runs real headless
sessions against a local Messages-API mock bound to `127.0.0.1`, then asserts the
store layout, committed session logs and rendered prompt blocks.

## Sessions

| Session | Directory | Scenario | What it proves |
|---|---|---|---|
| seed | — | `New-GlobalMemorySeed` | a v0.3 global journal with profile `tech`/`context`/`preferences` facts exists before the first session (migration fixture) |
| warm-up | `workspace-a` | `warmup.json` | absorbs the first-mount activation race and triggers the one-time migration |
| A | `workspace-a` | `board-post.json` → `confluence_board` post | the workspace-bus note is durably written to the workspace journal |
| E | `workspace-b` | `recall.json` → `confluence_recall` | profile-wide prior-session recall still works across directories |
| P | `workspace-a` | `profile-set.json` → `confluence_profile` set | a persona fact is written to the global journal |
| I | `workspace-a` | `memory-import.json` → `confluence_memory` import | a legacy `confluence.profile/v1` document imports (persona-only) |
| M1 | `workspace-a` | `memory-add.json` → `confluence_memory` add | a new pattern is stored as a **candidate**, not injected |
| M2 | `workspace-a` | `memory-promote-export.json` → promote then export | the confirmed candidate becomes active; the portable `confluence.memory/v1` document is produced |
| T | `workspace-a` | `style-set.json` → `confluence_style` set | an explicit chat rule is stored active |
| S | `workspace-a` | `send-notice.json` → `confluence_send` broadcast | delivery is queued (no interruption/wake) |
| D | `workspace-a` | `context-kv.json` → `confluence_context` set + get | the shared state pool round-trips in one workspace |
| C | `workspace-a` | `board-read.json` → `confluence_board` list + `confluence_inbox` | same-workspace peers see the note, the seeded legacy note (`through=`) and the queued notice (`inbox=`) |
| B | `workspace-b` | `text-answer.json` (no tools) | cross-workspace isolation **and** four committed prompt blocks: persona, long-term memory, style and pulse |

After session A has created the workspace-a journal directory, the harness seeds a
v0.1.0-style per-workspace journal shard into it (`New-LegacySeed`). v0.3/v0.4 reuse
v0.1 workspace directories as the workspace bus, so the legacy note must show up in
the workspace-a view without any migration or rewrite; the seeded shard and the
existing manifest must stay byte-identical. The v0.3 global journal seeded before the
run must equally stay byte-identical (the v0.4 migration is append-only).

## Checks

`scripts/e2e-dsh.ps1` reports its own checks (`E2E-00a..e`, `E2E-01a..m`,
`GUARD-01..03`). `assert-e2e.mjs` then runs the store/log assertion suite:

| Check | Assertion |
|---|---|
| E2E-01 | every acceptance session exits 0; the bundle composes in the scratch profile |
| E2E-02 | two-scope store layout: per-workspace bus journals + `workspaces/ws_0000000000000000/` for persona/patterns/style/ledger |
| E2E-03 | workspace journal holds the note, the legacy note, the queued message and the keyed context — all with the workspace `ws` key |
| E2E-04 | the global journal holds persona facts (recorded + imported), patterns, style records, exactly one migration marker and metadata ledger rows — and **no** bus record type |
| E2E-05 | one-time v0.3→v0.4 migration: `tech`→project, `context`→domain patterns, source `migration`, active; the seeded v0.3 journal is byte-identical and its profile records were not rewritten |
| E2E-06 | candidate-first memory: `add` renders "NOT active yet", `promote` activates; the newest record for the key is `active` |
| E2E-07 | a `confluence_style set` rule is stored active and appears in a workspace-B style block (`chat="N"`) |
| E2E-08 | persona injection: recorded fact, imported legacy fact and the legacy `preferences` alias are all in the persona block of a workspace-B session |
| E2E-09 | four bounded committed prompt blocks in workspace B (`confluence:profile`, `confluence:memory`, `confluence:style`, `confluence:pulse`) with their tags and budgets; memory shows the promoted pattern with `candidates="0"` |
| E2E-10 | same-workspace read: session C lists the note + legacy note (`through=`) and reads the queued notice (`inbox=`) |
| E2E-11 | isolation: workspace B's pulse, model request and store never contain workspace-A bus data |
| E2E-12 | queued delivery: `confluence_send` reports `queued`, no inbox splice/interrupt appears in any session log |
| E2E-13 | shared state pool: `confluence_context` set then get returns the posted value |
| E2E-14 | the model is offered the eight v0.4 tools; no retired v0.2 tool is called; no tool call passes a scope key |
| E2E-15 | watermarks: `digestSeq` commits, `boardReadSeq` follows `through=`, `inboxReadSeq` follows `inbox=` (bus unchanged from v0.3) |
| E2E-16 | the seeded v0.1 workspace shard is read as bus history and stays byte-identical |
| E2E-17 | cross-workspace recall still returns a `session:<id>:<seq>` hit from workspace A |
| E2E-18 | `confluence_memory export` runs and renders the `confluence.memory/v1` handoff (document is in `exported.text`; the document shape itself is covered by the offline unit tests) |
| E2E-19 | cold start: the writer's first request already offers the eight tools and a `scope="workspace"` pulse |

## Files

| File | Purpose |
|---|---|
| `mock-llm.mjs` | deterministic local Messages-API stub (loopback only); logs every request body as JSONL, including the offered tool names |
| `lib/session-log.mjs` | dependency-free zstd-frame reader + pulse/profile/memory/style block parsers (accepts v0.4 tags, the v0.2 global pulse tag and the v0.1 legacy tag) |
| `assert-e2e.mjs` | the assertion suite listed above |
| `scenarios/warmup.json` | throwaway warm-up session |
| `scenarios/board-post.json` | session A: one `confluence_board` post |
| `scenarios/recall.json` | session E: one `confluence_recall` |
| `scenarios/profile-set.json` | session P: one `confluence_profile` set (persona) |
| `scenarios/memory-import.json` | session I: import a legacy `confluence.profile/v1` document |
| `scenarios/memory-add.json` | session M1: one `confluence_memory` add (candidate) |
| `scenarios/memory-promote-export.json` | session M2: promote then export |
| `scenarios/style-set.json` | session T: one `confluence_style` set |
| `scenarios/send-notice.json` | session S: one `confluence_send` broadcast |
| `scenarios/context-kv.json` | session D: `confluence_context` set then get |
| `scenarios/board-read.json` | session C: `confluence_board` list then `confluence_inbox` |
| `scenarios/text-answer.json` | session B: no tools (isolation + four prompt blocks) |

## Running it

```powershell
pwsh -NoProfile -File scripts/e2e-dsh.ps1
```

- Requires Node.js ≥ 22.19.0 and the DSH launcher (default:
  `C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`).
  If the launcher is missing the script prints `SKIPPED` and exits 0.
- Each run creates `.tmp/e2e/run-<stamp>/` (git-ignored) with `summary.json`, the mock
  request logs (`mock-*.jsonl`), session stdout/stderr, the seeded legacy/memory
  fixtures (`legacy-seed.json`, `memory-seed.json`) and the seeded files. It never
  opens the real `~/.dsh` profile; the guards assert the desktop profile files are
  unchanged and the real store contains no trace of the run.
- The result of the last executed run is recorded in
  [`../../docs/plan/implementation-status.md`](../../docs/plan/implementation-status.md).

## Honesty

This harness is **evidence, not proof of release readiness**. A green run does not
cover the real desktop-profile install/restart, the panel's visual rendering, PTC tool
reachability, multi-window freshness, soak/compaction or publishing — all of which are
tracked as not-executed in `docs/plan/implementation-status.md` and `docs/install.md`.
It also uses a mock model: it proves plugin mechanics, not model behaviour. The
`confluence.memory/v1` document **shape** is asserted by the offline unit tests; the
E2E proves the export call/render path on a real store.
