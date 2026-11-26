# Confluence / 高级记忆

> **Sessions in one workspace work as a team; your long-term memory, persona and style follow you everywhere.**
> **同工作区的会话一起工作，你的长期记忆、画像与风格跟着你走。**

**Status: v0.4.0 target — three layers (workspace bus, long-term memory, user persona) + two-channel
style cards.** v0.4.0 is a breaking round defined by
[ADR 0009](docs/adr/0009-long-term-memory-persona-style.md), which extends
[ADR 0008](docs/adr/0008-bus-and-profile.md) (two scopes, queue-based messages) and keeps the scope
rule of [ADR 0007](docs/adr/0007-universal-memory-scope.md) superseded. The binding interface contract
is [docs/plan/v0.4-interfaces.md](docs/plan/v0.4-interfaces.md). The v0.4.0 offline evidence was
**executed on this tree (2026-11-27)**: offline suite **398/398 pass**, packaging contract **20/20
checks pass**, contract tests **25/25 pass**, offline scratch-profile E2E **22/22 harness checks +
19/19 assertion checks, exit 0** (run `.tmp/e2e/run-20261127-025250`), and `npm pack --dry-run` = 30
files. The real desktop profile is running v0.4.0 (heartbeat plus the persona/memory prompt blocks are
observable; the legacy `tech` persona fact has migrated into a long-term pattern). The evidence below
is **historical for its own versions**: v0.3.0 (2026-11-19, offline suite **353/353 pass**, packaging
**18/18 checks pass**, offline scratch-profile E2E **17/17 harness checks + 15/15 assertion checks,
exit 0**, run `.tmp/e2e/run-20261119-032058`); v0.2.1 (2026-11-16, **291/291**, **17/17**, E2E
**15/15 + 12/12**, run `.tmp/e2e/run-20261116-203730`; evidence in
[docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md)); v0.1.0 (2026-11-13,
**256/256**, **12/12**, E2E **8/8**). Still not executed in any version: the panel's rendering, the
real desktop-profile install/restart, and publish — nothing has been published.

Confluence (Chinese name **高级记忆**, "advanced memory") is a **fully offline** DeepSeek Harness (DSH)
plugin for one DSH profile. It delivers three layers, plus style as an output side: a **workspace
session bus** so sessions running in the same directory share task state, notes and addressed
messages; a **long-term memory** of generalizable patterns that survives tasks and workspaces; a
**user persona** (individual traits only) injected into every session; and **style cards** for how
answers and engineering artifacts should read. No server, no network calls, no extra port, no child
processes, no model calls, no vector store.

- Target host: DSH Desktop **0.2.2-rc.1** (declared minimum `>=0.2.2-rc.1`), profile `desktop`.
- Package: `dsh-confluence` **v0.4.0** target (the manifest/version switch is part of the v0.4.0
  packaging workstream), `private: true`, MIT, no runtime dependencies.
- Repository: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Upgrading from v0.3.x? Read [docs/upgrade-v0.4.md](docs/upgrade-v0.4.md) first — the record types,
  tools, export document and config changed, old profile facts are migrated once into patterns, and
  the linked bundle needs a DSH restart.

---

## The problem

DSH sessions are isolated language contexts. Three failures follow:

1. **Task state is trapped per session.** Two windows or two agents on the same project cannot see
   each other's decisions, findings or next steps, so investigation is repeated and hand-offs happen
   by copy-pasting files.
2. **Knowledge learned in one task does not survive to the next.** A pitfall discovered while renaming
   files on Windows, a project convention about error envelopes, a domain fact about a service — all
   of it is re-learned in every new conversation.
3. **Style is not yours.** Answers, commit messages, code comments, README prose, error text, logs and
   UI microcopy default to generic model style, whatever the user prefers.

v0.1.0 scoped memory per workspace (too narrow); v0.2.0 over-corrected with one universal layer
([ADR 0007](docs/adr/0007-universal-memory-scope.md), now superseded); v0.3.0 split the product into a
workspace bus and a global user profile ([ADR 0008](docs/adr/0008-bus-and-profile.md)) but let the
"profile" mix personal traits with stack/project facts. v0.4.0 fixes the model
([ADR 0009](docs/adr/0009-long-term-memory-persona-style.md)):

> 三层记忆：**工作区任务态（总线）**→ **长期记忆（可泛化 pattern，候选确认制）**→ **用户画像**（个性子集）。
> 独立一条输出侧：**双域风格卡**（对话文风 + 工程产物文案）。

The persona is the "about the user" subset. Task-derived knowledge never enters the persona; it
becomes a long-term pattern. Styles are long-term output conventions: stored like memory, injected
like memory, exported with it.

---

## The three layers (plus style)

| Layer | Contents | Records | Scope | Lifetime |
|---|---|---|---|---|
| **1. Workspace task state** (v0.3, unchanged) | task state, notes, addressed messages | `context`, `entry`, `message` | one workspace | task-scoped |
| **2. Long-term memory** (new) | generalizable patterns abstracted from tasks | `pattern` | global, tagged (`global`/`workspace`) | durable, portable |
| **3. User persona** (refactor of v0.3 profile) | individual traits: identity, personality, communication, habits, boundaries, taste | `profile` | global | durable, portable |
| **Style side** (new) | chat tone/structure + engineering-artifact copy rules | `style` (two channels) | global | durable, portable |

All three global records live in the reserved global scope `ws_0000000000000000` and are injected
through **bounded prompt blocks**. The workspace bus is untouched by v0.4.0.

---

## Layer 1 — workspace session bus (v0.3, unchanged)

Sessions whose working directory resolves to the same workspace share a live bus, so multi-window and
multi-agent work no longer needs manual file passing.

- **Workspace identity.** The key is `ws_<sha256(canonical header.cwd realpath, win32 lower-case)[:16]>`,
  frozen on first observation from `session.header.cwd` (a later `cd` does not move it). Sessions with
  the same key share the bus; different keys never do. No `cwd` ⇒ `NO_WORKSPACE` for bus calls (empty
  views; the global layers still work). Labels are basenames/registry titles, display-only: **absolute
  paths never enter records, prompts or panel payloads**.
- **Shared state pool** (`confluence_context`). Keyed values per workspace
  (`^[a-z0-9][a-z0-9._-]{0,63}$`, `valueType` `text` or `json`); last writer wins by `seq`, `delete`
  writes a tombstone. Caps: `bus.context.maxKeys` 200 live keys, `bus.context.maxValueBytes` 8192.
- **Note board** (`confluence_board`). Append-only typed notes — `finding`, `decision`, `gotcha`,
  `question`, `handoff`, `warning` — with threads, `resolves`/`supersedes`, tags and files. Actions:
  `list`, `read`, `post`, `reply`, `search`; results render `through=<seq>`. Per-workspace cap
  `bus.notes.maxEntries` 2000.
- **Session messages** (`confluence_send`, `confluence_inbox`). To the whole workspace (`to:"*"`) or one
  exact session id; kinds `notice`, `instruction`, `query`, `reply`; immutable. Caps: `maxStored` 500
  live messages, `maxBodyBytes` 4096 per body.
- **Passive pulse.** A bounded
  `<confluence-memory scope="workspace" name="<label>" unread="<n>" peers="<m>" seq="<maxSeq>">`
  digest per step: a few shared state keys, unread message headlines, peers here now, and a guide to
  the bus tools. Caps `bus.pulse.maxChars` 1400, `maxMessages` 3, `maxStateKeys` 3, `maxPeers` 2,
  fixed degradation order; byte-stable and absent when there is nothing to say.

Bus data lives **only** in that workspace's journal: it is never merged across workspaces, never
exported into another workspace and never injected into another workspace's session.

---

## Layer 2 — long-term memory (patterns, candidate-first)

`pattern` records hold **generalizable patterns abstracted from tasks** so they can be reused across
tasks and workspaces. The plugin does not learn by itself: the Agent proposes a pattern in normal
conversation and the user confirms it.

- **Shape.** `key` (`^[a-z0-9][a-z0-9._-]{0,63}$`, stable across updates), `category`
  (`workflow`, `project`, `domain`, `pitfall`, `heuristic`, `quality`), `title` (≤120 chars),
  `body` (≤2048 bytes), `tags` (≤8), `scope` (`global` default, or `workspace` with
  `workspaceKey`/`workspaceLabel`), `status` (`candidate|active|rejected|superseded`), `confidence`
  (0..1, default 0.5), `source` (`agent|user|import|migration`), up to 3 metadata-only `evidence`
  entries and an `author`. Records are append-only: an update is a new record with the same `key`, the
  greatest `seq` wins.
- **Candidate-first writes.** `confluence_memory add` **always** writes `status:"candidate"`. A
  candidate is never injected as a rule. The user confirms → the Agent calls `promote` (→ `active`);
  the user rejects → `reject`/`forget` (→ `rejected`); editing keeps the status and appends a new
  revision. Only `active` patterns are injected, plus a bounded candidate headline (count + up to two
  keys/titles) so the user/Agent can review pending proposals.
- **Selection at injection time.** Active patterns whose `scope` is `global` plus
  `workspace`-scoped patterns matching the calling session's workspace; sorted by `confidence` desc
  then `seq` desc; capped by `memory.maxInjectPatterns` 5 and `memory.maxInjectChars` 1200; each line
  rendered as `[category] title: body`.
- **Caps and safety.** `memory.maxPatterns` 300 live patterns (candidates + active), body/title/tags/
  evidence bounds, all text redacted at write time, all pattern text treated as untrusted data in the
  prompt.
- **Semi-automatic.** No background extraction, no prompt scraping, no LLM extraction, no embeddings or
  vector search. Abstraction happens in the Agent's normal conversation; distilling a whole document
  corpus into style cards is a separate, explicit content task (Agent/CLI-assisted), never a hidden
  runtime pass.

---

## Layer 3 — user persona (individual traits only)

One durable, portable persona per DSH profile, injected into every session regardless of workspace.

- **What it stores.** Facts in **six trait sections** — `identity`, `personality`, `communication`,
  `habits`, `boundaries`, `taste` — each a `(section, key)` pair with a value, `confidence` (0..1,
  default 0.6) and `source` (`agent`, `user`, `import`); last writer wins per key, `forget` writes a
  tombstone. Caps: `profile.maxFacts` 200 live facts, `profile.maxValueBytes` 1024.
- **Legacy aliases and migration.** v0.3's `preferences` facts fold as `communication` and `rules` facts
  fold as `boundaries` at read time. v0.3's `tech`/`context` facts are **not persona**: they are
  migrated once into `pattern` records (categories `project`/`domain`, source `migration`) by a
  one-time `memory-migration` marker, and no longer render in the persona block.
- **Injected everywhere.** `<confluence-profile rev="<seq>" facts="<n>">` renders the six sections in
  the fixed order `identity, personality, communication, habits, boundaries, taste`, only facts with
  `confidence >= profile.minConfidence`, at most 3 per section, values ≤ 80 chars, total ≤
  `profile.maxInjectChars` 1200. When the persona has no facts the registered contribution emits one
  bounded onboarding nudge (`<confluence-profile status="empty" facts="0">`) that tells the agent to
  record durable traits — gone after the first fact.
- **Semi-automatic.** The agent records a trait with `confluence_profile set` when the user reveals
  something durable; the user can ask explicitly; imports are deterministic. No hidden model passes.
- **Persona tools.** `confluence_profile` is **persona only** now: `get`, `list`, `set`, `forget`.
  Export/import moved to `confluence_memory` (`confluence.memory/v1` also covers patterns and styles).

---

## Style cards (two channels)

`style` records are the output side of the same durable layer: deterministic, portable output
conventions, not fine-tuning.

- **Channels and areas.** `channel: chat` covers `general`, `tone`, `structure` (answer prose);
  `channel: engineering` covers `commit`, `comment`, `docs`, `naming`, `error`, `log`, `ui` — commit
  messages, comments/docstrings, README/docs, PR/issue copy, error messages, logs, naming and UI
  microcopy.
- **Shape.** `key` (stable, `^[a-z0-9][a-z0-9._-]{0,63}$`), `title` (≤120), `rule` (≤1024 bytes), up
  to 3 `examples` of `{bad, good}` (≤512 bytes each), tags (≤8), `priority` 0..100 (default 50, higher
  first), `enabled`, `confidence`, `source` (`user|agent|import`); folded last-write-wins per
  `(channel, key)`.
- **Writes are active by design.** `confluence_style set` writes an active rule — the user is
  explicitly stating the style, so there is no candidate queue here. `confluence_style remove` writes
  `enabled:false`.
- **Injected boundedly.** `<confluence-style chat="<n>" engineering="<m>">` renders `chat` rules first,
  then `engineering`; priority desc then key; one bounded line per rule; `enabled:false` skipped; chat
  total ≤ `style.maxInjectCharsChat` 600, engineering ≤ `style.maxInjectCharsEngineering` 900.
  `style.maxRules` 100 live rules across both channels.
- **Semi-automatic.** Style rules come from the user stating them or from an explicit offline
  distillation task performed by the Agent/CLI from material the user provides — the plugin itself
  never invokes a model.

---

## The three injected blocks and their budgets

All four rows below are `ctx.systemPrompt.context()` contributions rendered synchronously from
in-memory folds: no IO, byte-stable, exception-safe, bounded. `index.js` registers the three v0.4
blocks; the workspace pulse is the v0.3 contribution, unchanged.

| Name | Order | Block | Budget |
|---|---|---|---|
| `confluence:profile` | 1400 | `<confluence-profile rev="…" facts="…">` persona (six trait sections) | ≤3 facts/section, value ≤80 chars, total `profile.maxInjectChars` 1200 |
| `confluence:memory` | 1410 | `<confluence-memory-patterns count="N" candidates="M">` active patterns + candidate headline | `memory.maxInjectPatterns` 5, `memory.maxInjectChars` 1200 |
| `confluence:style` | 1420 | `<confluence-style chat="N" engineering="M">` chat then engineering rules | `style.maxInjectCharsChat` 600 + `maxInjectCharsEngineering` 900 |
| `confluence:pulse` | 1500 | `<confluence-memory scope="workspace" …>` workspace digest (v0.3, unchanged) | `bus.pulse.maxChars` 1400 |

An empty layer renders `''` and contributes nothing (the persona contributes its bounded onboarding
nudge while empty). Every block is **passive text** in the prompt — not a message, not a command — and
pattern/style/persona content is treated as untrusted background data.

---

## Candidate confirmation flow (explicit, conversational)

Learning is deliberately not automatic in an offline plugin, and the owner chose a candidate queue:

1. After a task, the Agent proposes a generalizable pattern with `confluence_memory add` (always
   `candidate`, with `evidence` metadata and a `confidence`).
2. The prompt shows only the bounded candidate headline — candidates are **never rules** until
   confirmed.
3. The user confirms in conversation (or asks to discard it). The Agent calls
   `confluence_memory promote` on confirmation, `reject`/`forget` to discard, `update` to correct the
   pattern (same key, new revision, status preserved).
4. The panel stays **read-only**: it lists patterns/candidates and tells the user to confirm with the
   Agent — there is no write path from the UI.
5. Styles bypass the queue because `set` is the user explicitly stating a rule; `remove` disables it.

`memory.autoCapture: off` tells the Agent not to propose patterns automatically at all (the tools and
the queue remain available). The plugin itself never decides what to remember.

---

## Semi-automatic and offline boundaries

- **No hidden model calls.** Confluence makes no network request, no model call, no prompt scraping,
  no background extraction, no embeddings/vector store. Abstraction and distillation are the Agent's
  normal conversation or an explicit user-run CLI task.
- **Deterministic portability.** Export/import is deterministic and validated; the same document
  produces the same records.
- **Explicit writes only.** Patterns arrive through `confluence_memory add` (Agent) or import;
  styles through `confluence_style set` or import; persona facts through `confluence_profile set` or
  import. There is no silent capture path.
- **User control.** The candidate queue, the read-only panel and `privacy.privateSessions` are the
  control surfaces; private sessions are invisible to every layer.

---

## Portability — `confluence.memory/v1` and the memory CLIs

One canonical document now carries the whole durable memory:

```json
{
  "format": "confluence.memory/v1", "version": 1, "kind": "memory", "scope": "global",
  "generatedAt": "ISO", "revision": "ULID|null",
  "persona": { "sections": [{ "id": "communication", "facts": [{"key","value","confidence","source","ts"}] }] },
  "patterns": [{"key","category","title","body","tags","scope","workspaceKey?","workspaceLabel","status","confidence","source","ts"}],
  "styles":   [{"channel","area","key","title","rule","examples","tags","priority","enabled","confidence","source","ts"}],
  "counts": {"persona": 3, "patterns": 12, "styles": 6},
  "limits": {"maxPatterns": 300, "maxFacts": 200, "maxRules": 100},
  "redaction": {"applied": true, "policy": "confluence.redact/v1"}
}
```

- **Export:** `confluence_memory export` (structured output; `exported.text` stays in the tool result,
  never in the prompt), the panel's `/confluence/panel/profile/export?format=json|md` download, or the
  CLI. Output is redacted, path-free and bounded by `profile.maxExportBytes` 65536.
- **Import:** `confluence_memory import` / the CLI in `merge` (default; last-writer-wins per
  key/section-key) or `replace` (patterns/styles absent from the document become `rejected`; persona
  gets a `profile-reset` generation marker first). Strictly validated, size-capped, never throws raw
  errors. A legacy `confluence.profile/v1` document is accepted as **persona only**.
- **CLIs (renamed in v0.4.0):** `scripts/memory-export.mjs` and `scripts/memory-import.mjs` replace
  `scripts/profile-export.mjs`/`profile-import.mjs`. They keep the v0.3 offline CLI shape:
  `node scripts/memory-export.mjs --dsh-home <dir> [--format json|md] [--out <file>] [--dry-run]` and
  `node scripts/memory-import.mjs --dsh-home <dir> --from <file> [--mode merge|replace] [--dry-run]`.
  `--dsh-home` is mandatory; nothing falls back to the real home directory.

The durable journals live in the global scope `ws_0000000000000000` (scope label "All sessions"),
together with the unchanged metadata-only ledger and presence heartbeats. It is a **profile** scope,
not a board — there is still no global note view.

---

## Messages are queued — never interrupting, never waking

A hard product rule inherited from v0.3.0 ([ADR 0008](docs/adr/0008-bus-and-profile.md) §3), unchanged
in v0.4.0: DSH 0.2.2-rc.5 has no silent cross-session notice channel, and every active channel forges
a user-role message, can wake an idle session and spends an LLM call.

- `confluence_send` writes a durable `message` record; it does not touch the recipient's session.
- A running recipient sees it at its **next model step**, in the next-step workspace pulse and in
  `confluence_inbox` (seconds, not instant); an idle recipient sees it on its **next turn**.
- The read cursor (`inboxReadSeq`) advances only from a committed `confluence_inbox` result — never
  from a UI action or a pulse render.
- v0.4.0 never interrupts, steers, wakes or prompts a session, and never spends a model call on
  delivery. Optional wake/inject delivery is **out of scope** and would require a new ADR.

The pulse and the three memory/persona/style blocks follow the same honesty: they are **passive text**
in the prompt, not messages and not commands.

---

## How it works (architecture)

```text
┌──────────────────── DSH Desktop (one Host per app instance) ─────────────────────┐
│  Session A — workspace X        Session B — workspace X      Session C — workspace Y
│  prompt: profile (1400)         prompt: profile (1400)       prompt: profile (1400)
│        + memory (1410)                + memory (1410)              + memory (1410)
│        + style (1420)                 + style (1420)               + style (1420)
│        + workspace pulse (1500)       + workspace pulse (1500)     (no workspace bus)
│  tools: confluence_* × 8         tools: confluence_* × 8      tools: confluence_* × 8
│            │                          │                          │
│            ▼                          ▼                          ▼
│  ┌────────── Confluence Host plugin (plain ESM, Node builtins only) ──────────┐
│  │ facade.js: workspace resolution + private-session gate + lazy attach       │
│  │ store.js (per-scope journals + merged cache) · board · context · bus       │
│  │ profile (persona) · memory (patterns) · style (cards) · pulse · watermark  │
│  │ presence · ledger · recall · tools · hostui · export · config · workspace  │
│  │ redact · util                                                              │
│  └──────────────────────────────────┬────────────────────────────────────────┘
│                                     │
│  $DSH_HOME/storages/confluence/v1/                                            │
│    workspaces/ws_<16hex>/             L1 bus: context + notes + messages       │
│    workspaces/ws_0000000000000000/    L2 patterns + L3 persona + styles        │
│                                       + metadata-only ledger + presence        │
│    (v0.2.1 global board files stay here, untouched, not attributed)           │
│                                                                               │
│  Web panel: three read-only same-origin views; no new port, no writes         │
└───────────────────────────────────────────────────────────────────────────────┘
```

Key boundaries:

- **Two scopes.** Workspace journals hold bus data and are isolated; the global journal holds
  patterns, persona facts, style rules, the metadata-only ledger and presence. Cross-workspace
  knowledge flows only through the global durable layers.
- **The session log stays the source of truth.** Watermarks (`digestSeq`, `boardReadSeq`,
  `inboxReadSeq`) are derived from committed session events; plugin state is a derived cache.
- **Shared and learned content is untrusted data.** Notes, state values, peer messages, patterns and
  style rules carry fixed warnings, escaped framing (`<`, `&`, U+2028/2029), are never followed as
  instructions and never trigger a tool call by themselves. Persona facts are user background applied
  as preferences; style rules are user-stated output conventions.
- **Offline and bounded.** No `fetch`, network module, socket, child process or model call in the Host
  half; the panel's only request is a relative same-origin GET. Per-writer append-only JSONL, every
  new write path redacted, all sizes capped (`REDACTED` when a value redacts to empty).
- **Legacy data is preserved.** v0.3 profile facts stay on disk (additive migration only); v0.2.1
  global board entries stay untouched and are not merged into workspace views; a v0.1.0 workspace
  directory is simply the journal of that workspace. No file is rewritten or deleted by v0.4.0.

---

## The eight model tools

All tools are `confluence_*`, described in English, registered in a fixed order, with closed output
schemas and untrusted-content rendering.

| Tool | Scope | What it does |
|---|---|---|
| `confluence_board` | workspace | Notes: `list`, `read`, `post`, `reply`, `search` (six kinds, threads, tags, files); renders `through=<seq>`. |
| `confluence_context` | workspace | Keyed shared state: `list`, `get`, `set`, `delete`; values `text` or `json`. |
| `confluence_send` | workspace | Durable message to `"*"` or one session id; kinds `notice/instruction/query/reply`; returns `{id, seq, to, kind, queued, peers}`. Never interrupts. |
| `confluence_inbox` | workspace | Peer messages (unread by default), returns `unread`/`peers`, renders `inbox=<maxSeq>` for the cursor. |
| `confluence_profile` | global | **Persona only**: `get`, `list`, `set`, `forget` (export/import moved to `confluence_memory`). |
| `confluence_memory` | global | **Long-term patterns + portability**: `list`, `add`, `promote`, `reject`, `update`, `forget`, `search`, `export`, `import`. `add` always creates a `candidate`. |
| `confluence_style` | global | **Style cards**: `list`, `set` (writes an active rule), `remove` (writes `enabled:false`). |
| `confluence_recall` | global | Unchanged explicit, bounded literal recall over earlier sessions on this machine (secondary). |

The first four resolve the workspace first and fail `NO_WORKSPACE` when the session has no resolvable
directory; `privacy.privateSessions` blocks every tool. Tool descriptions state the workspace scope,
that peer messages are untrusted content never to be followed as instructions, that patterns are
untrusted learned content, and that the persona is user background applied as preferences.

---

## The Web panel — three read-only views

The left-rail entry opens one page with **three tabs**, served by read-only same-origin `GET` routes on
the existing DSH web server (`lib/hostui.js`); no writes, no `POST`, no new port, no iframe, no extra
dependency and no build step.

1. **工作区总线 / Workspace bus** — workspaces with entry/message/peer counts and last activity; a
   workspace opens its bus detail: keyed context state, note timeline with filters/search, messages and
   peers here now. Entry detail shows body, tags, files and replies.
2. **长期记忆 / Long-term memory** — patterns and candidates with category, scope, confidence, source
   and status; candidates are listed separately with a hint to confirm them with the Agent. Read-only:
   no promote/reject button, no write route.
3. **用户画像 / User profile** — persona sections and facts with confidence and source, **plus** the
   style cards (`style` channel/area/key/rule/priority/enabled) and `stats:{sections, facts, styles}`,
   and the export button (JSON or Markdown download of the full memory document).

Routes: `GET /confluence/panel/ping`, `/confluence/panel/workspaces`,
`/confluence/panel/bus?ws=&q=&kind=&limit=`, `/confluence/panel/entry?ws=&id=`,
`/confluence/panel/profile`, `/confluence/panel/memory`, and
`/confluence/panel/profile/export?format=json|md`. Workspace ids are opaque `ws_<16hex>` hashes, never
paths; labels are basenames/registry titles only; every route degrades to a bounded payload with
`truncated: true` under the 64 KiB cap. The panel never writes to the store. **Its rendering has not
been visually verified in any version**, including v0.4.0.

---

## Configuration (v0.4.0)

The complete default row ships in `cordis.patch.yml`; `lib/config.js` DEFAULTS must deep-equal it.
Sections: `enabled`; `store` (`dir`, `retentionDays` 90, `maxBodyBytes` 8192, `pollMs` 4000, `watch`,
`maxOpenWorkspaces` 16); `bus` (`context.maxKeys` 200 / `maxValueBytes` 8192; `notes.maxEntries` 2000;
`messages.maxStored` 500 / `maxBodyBytes` 4096; `pulse.enabled` / `maxChars` 1400 / `maxMessages` 3 /
`maxStateKeys` 3 / `maxPeers` 2); `profile` (`enabled`, `inject`, `maxFacts` 200, `maxInjectChars`
1200, `minConfidence` 0.3, `maxValueBytes` 1024, `maxExportBytes` 65536 — persona budgets);
`memory` (`enabled`, `inject`, `maxPatterns` 300, `maxInjectPatterns` 5, `maxInjectChars` 1200,
`candidateConfidence` 0.5, `autoCapture` `candidate|off`); `style` (`enabled`, `inject`, `maxRules`
100, `maxInjectCharsChat` 600, `maxInjectCharsEngineering` 900); `ledger`, `recall`, `privacy`
(`redact`, `redactTitles`, `denyPathPatterns`, `privateSessions`, `redactPatterns`), `ui` (`enabled`,
`pollMs`), `debug` (`logFile`). v0.4 adds `memory`/`style` with **no deprecations** (v0.3 keys keep
their names and meaning); upgrading from v0.3 requires re-copying a whole-row override and a DSH
restart — the config delta, the automatic data migration, the restart requirement, the verification
checklist and rollback are in **[docs/upgrade-v0.4.md](docs/upgrade-v0.4.md)**.

---

## What v0.4.0 does not do

- no automatic learning: no background extraction, prompt scraping, LLM extraction, embeddings or
  vector search — patterns are Agent-proposed and user-confirmed, style distillation is an explicit
  user-run content task;
- no writes from the panel (including the candidate queue: confirmation is conversational);
- no fine-tuning or model training — style cards are deterministic prompt rules;
- no wake/interrupt/steer/"instant push" delivery — messages are queued and surface at the recipient's
  next step/turn (a future opt-in decision, requiring a new ADR);
- no cross-workspace merge of bus data (only the durable global layers cross workspaces) and no global
  "all sessions" board view;
- no server, network call, additional listening port, external database, child process or model call;
- no sync of memory/persona/style across machines beyond explicit JSON/Markdown export/import;
- no note edit/delete UI, composer, custom tool cards or per-session unread badge (deferred); no
  remote/LAN collaboration, no Liveshare, no git automation;
- not a replacement for `@`-mention snapshots or raw session search — it composes alongside them.

---

## Implementation reality (this repository today)

| Claim | Reality |
|---|---|
| Three-layer decision (ADR 0009) + binding v0.4 interface contract | **Available** — frozen for this round |
| Host plugin v0.4.0 (20 `lib/*.js` modules: v0.3.0's 18 + `memory`/`style`) | **In progress this round** — target inventory; not yet verified by a v0.4 gate |
| Eight v0.4 tools, three global prompt blocks + workspace pulse, seven panel routes / three tabs | **In progress this round** — design frozen, implementation under the workstreams; no v0.4 gate executed |
| Web panel (`client.js`, Dynamic ModuleLoader id `dsh-confluence`) | **In progress** (three tabs / seven read-only routes); **never visually verified in any version** |
| Offline unit + integration suite | v0.1.0: 256/256; v0.2.1 tree: **291/291 pass** (2026-11-16); v0.3.0 tree: **353/353 pass** (2026-11-19); **v0.4.0: not executed** |
| Packaging contract (manifest/patch/locales/icon/entry) | v0.1.0: 12/12; v0.2.1 tree: **17/17**; v0.3.0 tree: **18/18** (2026-11-19); **v0.4.0: not executed** |
| Offline scratch-profile E2E | v0.1.0: 8/8; v0.2.1: **15/15 + 12/12** (run `20261116-203730`); v0.3.0: **17/17 + 15/15, exit 0** (run `20261119-032058`); **v0.4.0: not executed** |
| Installed into a scratch profile | **Executed in the v0.3.0 offline E2E** (throwaway `DSH_HOME`, `dsh plugin add` + `--dump-config`) |
| Installed into the real desktop profile | v0.1.0 **executed** (`install_bundle` → applied); v0.2.x, v0.3.0 and v0.4.0 reinstall/restart **not executed** |
| Panel rendering in a live GUI / npm pack / publish | Panel rendering **not executed** (no browser control); v0.3.0 pack dry-run executed (28 files, no tarball); **no v0.4.0 pack claim yet**; no release or publication |

The repository does **not** claim v0.4.0 is installed into the real desktop profile, that its gates are
green, or that the panel was visually verified. Historical E2E evidence was acquired inside a
throwaway scratch profile, not the user's live profile, and the E2E model is a local mock.

---

## Repository layout

```text
D:\05_Code\Confluence\
  index.js                   Host entry: wires the lib modules onto the Cordis context
  client.js                  Web panel: plain Dynamic ModuleLoader module (id 'dsh-confluence')
  lib/                       Host modules (plain ESM, Node builtins only):
    util.js config.js workspace.js redact.js store.js board.js watermark.js pulse.js
    ledger.js presence.js recall.js tools.js hostui.js facade.js export.js
    context.js bus.js profile.js          (v0.3.0: state pool, peer messages, user profile)
    memory.js style.js                   (v0.4.0: long-term patterns, style cards — in progress)
  package.json               bundle manifest: dsh-confluence, private, MIT, no dependencies
  cordis.patch.yml           inserts the single `confluence` row with the complete default config
  locale/en.json, zh.json    display metadata + panel strings (en/zh aligned)
  icon.svg                   original icon: three streams merging into one channel
  examples/profile-patch.yml commented user override examples (v0.4 update owned by packaging)
  scripts/check.mjs          standalone packaging check (dependency-free)
    e2e-dsh.ps1              offline scratch-profile E2E harness
    export-memories.mjs      opt-in legacy memories export producer (tooling)
    memory-export.mjs / memory-import.mjs   v0.4 memory CLIs (renamed from the v0.3 profile CLIs)
  test/                      unit tests per module, integration test, e2e scaffolding, fixtures
  docs/                      design, research, decisions, plans, status, install/publishing guides
```

There is no build step: the Host half is plain ESM and the panel is a plain browser module.

---

## Documentation

Start with the [documentation index](docs/README.md) for the full map and reading order.

- **Binding for v0.4.0:** [ADR 0009](docs/adr/0009-long-term-memory-persona-style.md) (three layers,
  candidate-first writes, three prompt blocks, portability, migration) and the
  [v0.4 interface contract](docs/plan/v0.4-interfaces.md) (records, services, tools, prompt blocks,
  routes, config, migration, workstreams).
- **v0.3.0 base:** [ADR 0008](docs/adr/0008-bus-and-profile.md) (two scopes, queue-based messages,
  semi-automatic profile, panel transport, legacy policy) —
  [ADR 0007](docs/adr/0007-universal-memory-scope.md)'s scope rule stays superseded, the rest carries
  over.
- **History:** [ADR 0007](docs/adr/0007-universal-memory-scope.md) ·
  [ADR 0001](docs/adr/0001-confluence-architecture.md) ·
  [ADR 0002](docs/adr/0002-store-format-and-concurrency.md) ·
  [ADR 0003](docs/adr/0003-pulse-and-watermarks.md) ·
  [ADR 0004](docs/adr/0004-privacy-and-consent.md) ·
  [ADR 0005](docs/adr/0005-ui-transport.md) ·
  [ADR 0006](docs/adr/0006-solo-bench-integration.md) (proposed) ·
  [Round 1](docs/discussion/round-1.md) · [Round 2](docs/discussion/round-2.md) ·
  [Position A](docs/discussion/position-a.md) · [Position B](docs/discussion/position-b.md)
- **Status and plans:** [implementation status](docs/plan/implementation-status.md) (live v0.4.0 round
  record; final verification numbers Lead-owned), historical
  [v0.3 interface contract](docs/plan/v0.3-interfaces.md),
  [scope delta](docs/plan/scope-refactor-delta.md) and
  [implementation interfaces](docs/plan/implementation-interfaces.md),
  [execution plan](docs/plan/execution-plan.md), [M0 spikes](docs/plan/m0-spikes.md).
- **Design documents (v0.4 amendments):** [architecture](docs/design/architecture.md) ·
  [data model](docs/design/data-model.md) · [store format](docs/design/store-format.md) ·
  [tool API](docs/design/tool-api.md) · [pulse](docs/design/pulse.md) ·
  [ledger + recall](docs/design/ledger-recall.md) · [panel](docs/design/ui.md) ·
  [config](docs/design/config.md) · [security & privacy](docs/design/security-privacy.md) ·
  [testing](docs/design/testing.md) · [solo-bench](docs/design/solo-bench-integration.md).
- **Operations:** [upgrade to v0.4.0](docs/upgrade-v0.4.md) (record/migration/config changes,
  restart, verification, rollback) · [upgrade to v0.3.0 (historical)](docs/upgrade-v0.3.md) ·
  [upgrade to v0.2.0 (historical)](docs/upgrade-v0.2.md) ·
  [install guide](docs/install.md) (v0.4 checklist update owned by packaging) ·
  [publishing](docs/publishing.md) ("nothing was published" stands).
- Tests: `test/*.test.js` (module + packaging) and `test/integration.test.js`.

---

## Offline and privacy guarantees

- no `fetch`, outbound socket, network module, child process or model call in the Host half; no
  additional listening port and no server (the panel only makes relative same-origin GETs); no external
  database — profile-local files under `$DSH_HOME/storages/confluence/v1/`; no telemetry, no crash
  reporting, no update check; no prompt scraping.

Privacy model for v0.4.0 — three visibility tiers, plus the untrusted-data and redaction rules:

- **The workspace key decides who sees bus data.** Sessions whose frozen `header.cwd` key matches share
  the context pool, notes and messages; other workspaces never see them. A visibility boundary, not a
  per-directory consent toggle: `privacy.disabledWorkspaces` stays removed and ignored.
- **The durable global layers are profile-wide by design.** Patterns, persona facts and style rules
  (plus the metadata-only ledger and presence heartbeats) are profile-global and injected into every
  session — that is the product. `workspace`-scoped patterns are stored globally but injected only
  into sessions of the matching workspace. Nothing crosses profiles, OS users or machines except
  explicit export/import files.
- **`privacy.privateSessions` remains the session opt-out:** a private session is invisible to every
  Confluence surface — no bus, no persona/memory/style tools, no prompt blocks, no ledger, no presence,
  no recall.
- **Candidates are untrusted until confirmed.** Agent-proposed patterns are untrusted data, never rules;
  only `active` patterns are injected as guidance, and the user confirms promotion.
- **Metadata-first ledger.** Titles, session ids, timestamps, turn counts, status and ≤8
  workspace-relative paths; no prompts, assistant text, tool outputs or command lines. Prior session
  logs are read only on an explicit `confluence_recall`, and only bounded excerpts are returned.
- **Best-effort redaction on every write**, configurable deny paths/patterns. Notes, state values,
  messages, patterns and style rules are untrusted data (fixed warnings, escaped framing, never
  instructions); the memory export is explicit, redacted, path-free and bounded, and import is
  validated/bounded.

These guarantees are enforced by static contract checks and privacy unit tests; they are not a claim
that a live host was audited, and never protect against other tools in the same profile.

---

## Upgrading from v0.3.x

v0.4.0 is a breaking minor. Full guide: **[docs/upgrade-v0.4.md](docs/upgrade-v0.4.md)**.

- **Surface:** the user profile becomes the **persona** (six trait sections); new long-term memory
  (`pattern`, candidate-first) and two-channel style cards (`style`); tools go from six to eight;
  panel from two to three tabs / seven routes.
- **Data:** automatic one-time migration — legacy `tech`/`context` facts become `pattern` records
  (source `migration`); `preferences`/`rules` fold as `communication`/`boundaries`. No record is
  rewritten or deleted; patterns/styles otherwise start empty; back up the store before rolling back.
- **Export:** new canonical document `confluence.memory/v1`; legacy `confluence.profile/v1` documents
  remain importable (persona only); CLIs renamed to `memory-export`/`memory-import`.
- **Config:** new `memory.*` and `style.*` sections with no deprecations; `bus.*`/`profile.*` keep
  their names and meaning. A whole-row override must be re-copied.
- **Restart required:** the installed bundle is a local link, so DSH must be restarted (or the bundle
  row toggled) to load the new Host module generation. A config edit alone reloads the plugin row, not
  the module code.

---

## Install status

> **Not installed or reinstalled for v0.4.0.** v0.1.0 was installed into the real desktop profile
> (`install_bundle` → applied); v0.2.x/v0.3.0/v0.4.0 reinstall/restart have not been executed. The
> v0.3.0 scratch-profile E2E (2026-11-19) is historical evidence for that version only.

Procedure: [docs/install.md](docs/install.md) (v0.4 checklist update owned by packaging). Install via
Plugin Manager `install_bundle` (or `dsh plugin --profile <scratch> add <path>`), confirm the composed
row has `memory`/`style` plus `bus`/`profile` and no replaced keys, restart DSH, then verify the eight
tools, the three global blocks (+ workspace pulse), the candidate confirmation flow, same-workspace
sharing vs cross-workspace isolation, queued delivery without interruption, the three panel tabs and
no network/port/subprocess. Rollback: remove the bundle and restart; data-aware path in
[docs/upgrade-v0.4.md](docs/upgrade-v0.4.md) §5.

---

## Development

Requirements: **Node.js ≥ 22.19.0**; DSH Desktop **0.2.2-rc.1** for real activation later. No
dependencies and no build step.

```powershell
# from the repository root
node --test --test-force-exit "test/*.test.js"   # all offline tests (unit + integration + packaging)
node scripts/check.mjs                            # standalone packaging check (dependency-free)
npm pack --dry-run --json                         # inspect the shipped file list (offline)
```

`npm pack --dry-run` reported 24 shipped files for the v0.1.0 tree and 28 for the v0.3.0 tree; the
v0.4.0 tree adds `lib/memory.js`, `lib/style.js` and renames the CLI scripts, so inventory, sizes and
checksum must be re-recorded at the release checkpoint — no v0.4.0 pack claim is made yet.

| Script | Purpose |
|---|---|
| `node scripts/check.mjs` | Dependency-free packaging/contract checker. |
| `node scripts/m0-smoke.mjs` | M0 evidence suite: ULID, redaction corpus, pulse caps, journal append/torn-tail/two-writer, native lease, offline scan. |
| `pwsh -File scripts/e2e-dsh.ps1` | Offline scratch-profile E2E: fresh `DSH_HOME` + headless profile + local Messages-API mock. **v0.3.0 run** 17/17 checks + 15/15 assertions (`20261119-032058`); **v0.4.0 re-run not executed**. |
| `node scripts/export-memories.mjs --dsh-home <dir> [--json] [--dry-run]` | Opt-in legacy memories export producer (tooling; unrelated to the v0.4 memory export). |
| `node scripts/memory-export.mjs --dsh-home <dir> [--format json\|md] [--out <file>] [--dry-run]` | v0.4 memory export CLI (canonical `confluence.memory/v1` JSON or Markdown). |
| `node scripts/memory-import.mjs --dsh-home <dir> --from <file> [--mode merge\|replace] [--dry-run]` | v0.4 memory import CLI (validated, append-only, dry-run supported). |

---

## Verification status

**v0.4.0 — this round: implementation in progress, verification not executed.**

| Check | Status |
|---|---|
| ADR 0009 + v0.4 interface contract | **Available** — frozen binding documents (not a runtime check) |
| Host plugin v0.4.0 (20 `lib/*.js` modules, eight tools, three global blocks, seven routes) | **In progress** — design frozen; implementation under the workstreams |
| Offline suite (`node --test --test-force-exit "test/*.test.js"`) | **Not executed for v0.4.0** — final number Lead-owned |
| Packaging check (`node scripts/check.mjs`) | **Not executed for v0.4.0** — final number Lead-owned |
| Packaging contract tests (`test/contract.test.js`) | **Not executed for v0.4.0** — final number Lead-owned |
| Offline scratch-profile E2E (`pwsh -NoProfile -File scripts/e2e-dsh.ps1`) | **Not executed for v0.4.0** |
| Panel rendering (three tabs) / real desktop-profile install + DSH restart | **Not executed** — rendering never visually verified; v0.4.0 install/restart not executed |
| npm pack / publish | **Not executed for v0.4.0**; no release or publication in any version |

The Lead updates these rows — and only with an executed command and its output — in
[docs/plan/implementation-status.md](docs/plan/implementation-status.md).

**v0.3.0 (historical, executed on this tree 2026-11-19):** offline suite **353/353 pass**; packaging
check **18/18 checks pass**; packaging contract tests **24/24 pass**; offline scratch-profile E2E
**17/17 harness checks + 15/15 assertion checks, exit 0** (run `.tmp/e2e/run-20261119-032058`);
`npm pack --dry-run` executed (28 files, 199,159 B packed — no tarball); panel rendering not executed;
real-profile install/restart not executed.

**v0.2.0 / v0.2.1 (historical, executed 2026-11-16, unchanged by the 2026-11-17 display-name patch):**
offline suite **291/291 pass**; packaging contract **17/17 checks pass**; M0 smoke **14 pass / 0 fail /
1 blocked** (optional atomic-write probe; native lease shipped); offline scratch-profile
cross-directory E2E **15/15 PowerShell checks, exit 0; 12/12 assertion checks** (run
`.tmp/e2e/run-20261116-203730`; evidence:
[docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md)). Real-profile
reinstall/restart for v0.2.x: **not executed**.

**v0.1.0 (historical, executed 2026-11-13):** offline suite **256/256 pass**, packaging check **12/12
checks**, scratch-profile E2E **8/8 checks**, real desktop-profile `install_bundle` applied, export
producer + `solo-bench` Go consumer green.

**Not executed for any version:** panel rendering / visual verification, PTC preset (`run_code`) tool
reachability, multi-window live freshness measurement, soak/compaction and long-run retention,
tarball/SHA-256 + publish/release.

---

## License

[MIT](LICENSE) © 2026 XiaoleC05 and Confluence / 高级记忆 contributors.

## Links

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Crisp plugin precedent (local checkout): `D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
