# ADR 0009 — Three-layer memory: workspace bus, long-term patterns, user persona (v0.4)

- Status: **accepted**. Extends ADR 0008; does not change the v0.3 privacy/offline guarantees.
- Date: 2026-11-27. Product: Confluence 高级记忆 v0.4.0.
- Binding contract: `docs/plan/v0.4-interfaces.md`.

## Context

v0.3 shipped two modules: a workspace session bus and a global "user profile"
(keyed facts injected into every session). The owner refined the product model:

1. Style control must cover **both** conversational answers and the copy a
   coding task produces (commit messages, comments/docstrings, README/docs,
   PR/issue text, error messages, logs, naming, UI microcopy).
2. The **user profile is a slice of long-term memory**: it records the
   user's *individual traits* (personality, communication style, habits,
   boundaries, taste), not project or task facts.
3. **Long-term memory** holds *generalizable patterns abstracted from tasks*
   (workflow heuristics, project conventions, domain knowledge, pitfalls,
   quality rules) so they can be reused across tasks and workspaces.
4. Learning from a large corpus cannot be fully automatic in an offline
   plugin: patterns and styles are proposed by the Agent (or distilled once
   from the corpus by the user/Agent), never by a hidden model call, and the
   owner chose a **candidate queue**: proposals stay `candidate` until the
   user confirms.
5. Long-term memory is **global with tags** (workspace / stack / project),
   selected by relevance at injection time.

## Decision

### 1. Three layers (plus styles as an output side)

| Layer | Contents | Scope | Lifetime |
|---|---|---|---|
| workspace bus (v0.3, unchanged) | task state, notes, addressed messages | one workspace | task-scoped |
| **long-term memory** (new) | `pattern` records: generalizable patterns abstracted from tasks | global, tagged | durable, portable |
| **user persona** (refactor of v0.3 profile) | `profile` records reduced to individual traits: identity, personality, communication, habits, boundaries, taste | global | durable, portable |
| **style cards** (new) | `style` records: chat tone/structure and engineering-artifact copy rules, with good/bad examples | global, two channels | durable, portable |

Styles are long-term output conventions: they are stored like memory, injected
like memory, and exported with it. The persona is the "about the user" subset;
task-derived knowledge never enters the persona.

### 2. Writes are candidate-first (owner decision)

- `confluence_memory add` always writes a **candidate** (`status:"candidate"`).
- Injection shows only `active` patterns (plus a bounded candidate count/headline so
  the user/Agent can review).
- The user confirms → the Agent calls `promote`; reject → `reject`/`forget`.
- Styles are explicit configuration-like rules and are written active directly
  by `confluence_style set` (the user is explicitly stating the style).
- The plugin still makes **no model calls, no network, no vector store**; the
  Agent does the abstraction in normal conversation, and corpus → style card
  distillation is a separate, explicit content task (CLI/Agent-assisted).

### 3. Injection: three bounded global blocks

`systemPrompt.context()` contributions, all sync, byte-stable, exception-safe:

| name | order | block |
|---|---|---|
| `confluence:profile` | 1400 | `<confluence-profile>` persona (individual traits) |
| `confluence:memory` | 1410 | `<confluence-memory-patterns>` relevant active patterns + candidate count |
| `confluence:style` | 1420 | `<confluence-style>` chat + engineering rules |
| `confluence:pulse` | 1500 | workspace bus digest (unchanged) |

Pattern selection: global patterns + workspace-scoped patterns whose
`workspaceKey` matches the calling session; active only; highest confidence
then newest; capped by `memory.maxInjectPatterns` / `memory.maxInjectChars`.

### 4. Portability

One canonical document `confluence.memory/v1` containing persona + patterns +
styles; JSON/Markdown export, validated merge/replace import; old
`confluence.profile/v1` documents remain importable (persona only). CLI scripts
become `scripts/memory-export.mjs` / `memory-import.mjs`.

### 5. Migration from v0.3

On first attach with v0.3 data, a one-time `memory-migration` marker is written
and persona facts with legacy non-persona sections (`tech`, `context`) are
converted into `pattern` records (category `project`/`domain`, source
`migration`). Old records are never rewritten or deleted. Persona renders only
the six trait sections; legacy `preferences`/`rules` fold as
`communication`/`boundaries` aliases.

### 6. Breaking surface (v0.4.0)

- Tools: 8 (`confluence_memory`, `confluence_style` added; `confluence_profile`
  becomes persona-only, export/import moves to `confluence_memory`).
- Panel: 7 read-only routes (adds `memory`); profile payload gains `styles`;
  the export route downloads the full memory document.
- Export format `confluence.memory/v1`; scripts renamed.
- Config gains `memory.*` and `style.*`; existing `profile.*` keys keep their
  meaning (persona budgets).

## Consequences

- The agent can learn reusable engineering patterns without polluting the
  user's persona; the user stays in control through the candidate queue.
- Style control is deterministic and portable (no fine-tuning), and covers
  both answer prose and engineering copy.
- The memory document becomes the single backup/transfer artifact.
- Costs: one more global block in the prompt (bounded), candidate review needs
  a conversational confirmation step (panel stays read-only).
