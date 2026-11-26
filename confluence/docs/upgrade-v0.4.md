# Upgrading to v0.4.0 — long-term memory, user persona, style cards

- Applies to: `dsh-confluence` **v0.3.0 → v0.4.0** (DSH Desktop 0.2.2-rc.1, profile `desktop`,
  Windows 11), fully offline.
- Decision: [ADR 0009](adr/0009-long-term-memory-persona-style.md) (extends
  [ADR 0008](adr/0008-bus-and-profile.md); ADR 0008's two-scope model and the queue-based delivery
  rule stay in force). Binding interface contract:
  [plan/v0.4-interfaces.md](plan/v0.4-interfaces.md).
- Read this before restarting DSH. The upgrade is **not** triggered by copying files: the installed
  bundle is a local link (`link:D:/05_Code/Confluence`), so DSH must be restarted to load the new Host
  module generation.
- v0.4.0 is a **breaking minor** (v0.3 → v0.4): the product surface, the record types, the model
  tools, the export document and the config shape all change. Existing data is **not** deleted or
  rewritten — the only data change is an automatic, additive one-time migration (§3).

## 1. What changed

v0.3.0 shipped two modules: a workspace session bus and a global "user profile" that mixed personal
traits with project/stack facts. v0.4.0 refines that into **three layers plus an output side**
([ADR 0009](adr/0009-long-term-memory-persona-style.md)):

1. **workspace task state** — the v0.3 bus, unchanged (per-workspace context, notes, queued messages);
2. **long-term memory** — new `pattern` records: generalizable patterns abstracted from tasks
   (workflow, project, domain, pitfall, heuristic, quality), global and tagged, **candidate-first**;
3. **user persona** — the v0.3 `profile` reduced to individual traits
   (`identity | personality | communication | habits | boundaries | taste`);
4. **style cards** — new `style` records in **two channels**: `chat` (answer tone/structure) and
   `engineering` (commit messages, comments/docstrings, docs/README, PR/issue text, error messages,
   logs, naming, UI microcopy).

| Area | v0.3.0 (bus + user profile) | v0.4.0 (three layers + style cards) |
|---|---|---|
| Product framing | two modules: workspace bus + global user profile | workspace bus + **long-term patterns** + **persona slice** + **two-channel style cards** |
| Record types (`KNOWN_RECORD_TYPES`) | `entry\|session\|tombstone\|context\|message\|profile\|profile-reset` | + `pattern`, `style`, `memory-migration` (10 types) |
| Profile sections | `identity, tech, preferences, habits, rules, context` | `identity, personality, communication, habits, boundaries, taste`; legacy `preferences`/`rules` fold as aliases, `tech`/`context` are migrated once into patterns |
| Long-term memory | not present | **`confluence_memory`**: `list/add/promote/reject/update/forget/search/export/import`; `add` always writes a **candidate** |
| Style control | not present | **`confluence_style`**: `list/set/remove`; `set` writes an active rule (the user stated it), `remove` writes `enabled:false` |
| `confluence_profile` | get/list/set/forget/export/import | **persona only**: get/list/set/forget (export/import moved to `confluence_memory`) |
| Tools | six (`board/context/send/inbox/profile/recall`) | **eight**, fixed order `board, context, send, inbox, profile, memory, style, recall` |
| Prompt contributions | `<confluence-profile>` (1400) + workspace pulse (1500) | **three global blocks**: `<confluence-profile>` (1400), `<confluence-memory-patterns>` (1410), `<confluence-style>` (1420), plus the unchanged workspace pulse (1500) |
| Export document | `confluence.profile/v1` (persona-like facts) | **`confluence.memory/v1`**: persona + patterns + styles; legacy `confluence.profile/v1` stays importable |
| Export CLIs | `scripts/profile-export.mjs` / `profile-import.mjs` | **renamed** `scripts/memory-export.mjs` / `memory-import.mjs` (same offline CLI shape: `--dsh-home`-based, JSON/Markdown, `merge`/`replace`, `--dry-run`) |
| Panel | two views / six routes (`ping`, `workspaces`, `bus`, `entry`, `profile`, `profile/export`) | **three views / seven routes** (adds `memory`): 工作区总线 / 长期记忆 / 用户画像; `profile` payload gains `styles`; `profile/export` downloads the full memory document |
| Config | `bus`, `profile` sections | adds **`memory`** and **`style`** sections; `profile.*` keep their meaning (persona budgets); no deprecations in v0.4 |
| Version | 0.3.0 | **0.4.0** |

Unchanged on purpose: fully-offline posture (no network, no extra port, no subprocess, no model call,
no vector store), append-only JSONL store with per-writer shards, bounded prompt text, untrusted shared
content (now including agent-proposed patterns), metadata-only ledger, best-effort redaction,
`privacy.privateSessions` invisibility, queue-based message delivery, read-only same-origin panel
transport.

## 2. Config migration (additive, breaking only for parsers that reject unknown keys)

The v0.4 default row is in `cordis.patch.yml`; `lib/config.js` DEFAULTS must deep-equal it. A user
patch that replaces the **whole** row config must be re-copied from the new
[`examples/profile-patch.yml`](../examples/profile-patch.yml), because the Loader replaces the complete
`config` object instead of deep-merging it. (That file is owned by the packaging workstream; use
`cordis.patch.yml` in this repository as the authoritative block until it is updated.)

**New sections (all defaults on):**

```yaml
- id: confluence
  config:
    memory:
      enabled: true
      inject: true
      maxPatterns: 300          # live patterns (candidates + active)
      maxInjectPatterns: 5      # patterns rendered per step
      maxInjectChars: 1200      # hard cap for the rendered patterns block
      candidateConfidence: 0.5  # advisory: propose rather than trust below this
      autoCapture: candidate    # candidate | off
    style:
      enabled: true
      inject: true
      maxRules: 100             # live style rules (both channels)
      maxInjectCharsChat: 600
      maxInjectCharsEngineering: 900
```

- **No deprecations in v0.4.** Nothing is renamed or removed: `bus.*` and `profile.*` keep their v0.3
  names and meaning (the `profile` budgets now bound the *persona* block only).
- **`memory.autoCapture`** is advisory for the model: `candidate` (default) means new patterns wait
  for user confirmation; `off` tells the Agent not to record patterns automatically at all. The plugin
  still makes no extraction of its own — see §3 of the binding contract.
- **Budget guards.** Activation warns `MEMORY_BUDGET_RISK` when `memory.maxInjectChars > 2000` and
  `STYLE_BUDGET_RISK` when `maxInjectCharsChat + maxInjectCharsEngineering > 3000`. The defaults stay
  inside the prompt budget; raise them deliberately.
- `privacy.privateSessions` continues to remove a session from every surface, including the two new
  tool families and both new prompt blocks.
- The field-by-field rules (ranges, fallback, warnings) are in [design/config.md](design/config.md);
  `lib/config.js` DEFAULTS must deep-equal the patch row, which the packaging check asserts.

Check the composed row before trusting it:

```powershell
dsh --profile desktop --dump-config | Select-String 'confluence' -Context 0,110
```

Look for `memory:` and `style:` sections, and confirm `bus:` and `profile:` are still present unchanged.

## 3. Data migration (v0.3 → v0.4): automatic, one-time, additive

No record is rewritten, moved or deleted. The only write is a one-time, best-effort migration on the
first `MemoryService.attach()` when no `memory-migration` marker exists in the global journal:

1. **Legacy non-persona facts become patterns.** For every global `profile` fact whose `section` is
   `tech` or `context`, the service appends one `pattern` record:
   - `key`: `migrated.<section>.<sanitized-key>` (the original key, sanitized to the pattern key grammar);
   - `category`: `project` for `tech`, `domain` for `context`;
   - `title`: the original fact key; `body`: the fact value;
   - `scope: global`, `status: active` (the user already stated these facts, so they are not
     candidates), `source: migration`, `confidence`: the fact confidence, else `0.6`;
   - `evidence`: the originating session id when the fact carries one (metadata only).
2. **A marker is appended once.** `{type:'memory-migration', version:1, source:'profile-v03'}` makes the
   migration idempotent: it never runs twice, even across restarts. It is best effort — a fact that
   cannot be converted is skipped, never fatal.
3. **Persona folding aliases.** Existing `preferences` facts fold as `communication` and `rules` facts
   fold as `boundaries` at read time. The records stay on disk with their original section; only the
   rendered persona and `confluence_profile list` show the alias target. Other legacy sections
   (`tech`, `context`) no longer render in the persona block — their content now lives in patterns by
   step 1.
4. **Patterns and styles otherwise start empty.** v0.3 had neither; nothing is inferred from notes,
   session logs or the old export. The Agent proposes patterns in normal conversation (candidate
   queue), and the user sets style rules explicitly.
5. **Old export documents still import.** A v0.3 `confluence.profile/v1` document is accepted by
   `confluence_memory import` and the import CLI as a **persona-only** document; export now produces
   `confluence.memory/v1`.

After restart you can confirm the migration ran:

- `confluence_memory list status=all` returns the migrated patterns with `source: migration`;
- the panel's 长期记忆 view lists them as active, and the persona view shows only the six trait
  sections (with `preferences`/`rules` folded into `communication`/`boundaries`);
- `$DSH_HOME/storages/confluence/v1/workspaces/ws_0000000000000000/` contains a
  `memory-migration` record line and new `pattern` lines — all appended, no file rewritten.

## 4. Restart and verify

1. Reinstall if the profile is pinned by version: Plugin Manager `install_bundle` from
   `D:\05_Code\Confluence` (or `dsh plugin --profile desktop add 'D:\05_Code\Confluence'`).
2. **Restart DSH Desktop.** A config edit alone only reloads the plugin row; the linked bundle needs a
   new Host module generation, so the old code staying resident is expected until restart.
3. Verify (details in [install.md](install.md); that guide's v0.4 checklist is owned by the packaging
   workstream):
   - the composed row has `memory:` and `style:` sections, and `bus:`/`profile:` are unchanged;
   - eight `confluence_*` tools are present in a session, in order: `confluence_board`,
     `confluence_context`, `confluence_send`, `confluence_inbox`, `confluence_profile`,
     `confluence_memory`, `confluence_style`, `confluence_recall`;
   - a session renders three global blocks when they have content — `<confluence-profile rev="…"
     facts="…">` (or the bounded onboarding nudge when the persona is empty),
     `<confluence-memory-patterns count="…" candidates="…">` and `<confluence-style chat="…"
     engineering="…">` — plus the unchanged `<confluence-memory scope="workspace" …>` pulse;
   - the candidate flow works conversationally: `confluence_memory add` reports
     `status:"candidate"` and the pattern does **not** appear as a rule in the prompt beyond the
     bounded candidate headline; after the user confirms, `confluence_memory promote` injects it as an
     active pattern;
   - `confluence_style set` writes an active rule and the next step's `<confluence-style>` block shows
     it; `confluence_style remove` disables it (`enabled:false`);
   - `confluence_memory export` returns the full `confluence.memory/v1` document (persona + patterns +
     styles); importing it with the CLI round-trips;
   - `confluence_profile export/import` are **gone** (moved to `confluence_memory`); old persona-only
     documents still import;
   - `privacy.privateSessions` still removes that session from every surface;
   - the panel opens with three tabs (工作区总线 / 长期记忆 / 用户画像); the memory view is read-only and
     candidate rows show a "confirm with the Agent" hint; workspace ids are `ws_<16hex>` and no
     absolute path appears;
   - store files: patterns/styles live in the global journal
     `workspaces/ws_0000000000000000/`; bus records stay in `workspaces/ws_<16hex>/`;
   - no network, extra port or child process appears (the panel is same-origin GET only).

## 5. Rollback

The upgrade never rewrites or deletes existing records, so rollback is a code revert, not a data
restore:

1. Point the profile back at the v0.3.0 tree (the commit before the v0.4 round; `f164446` at the time
   of writing) and restart DSH.
2. The v0.4 `pattern`, `style` and `memory-migration` records stay on disk in the global journal. v0.3
   does not know those record types and ignores them; its persona fold reads the six v0.3 sections, so
   the *rendered* profile after rollback is the v0.3 view (with `preferences`/`rules` back under their
   own names). **Back up** `$DSH_HOME/storages/confluence/v1/` before reverting: a later v0.4 reinstall
   picks the same records up again, but a mistaken manual edit would not be recoverable.
3. The v0.3 tools, prompt blocks, panel routes and `confluence.profile/v1` export come back unchanged;
   memory/style features disappear with the code. Do not point the v0.3 CLI at a v0.4 export document —
   it validates the old format only.

Rollback does not lose data. It does lose the v0.4 features, because that is the point of the version.

## 6. What this upgrade does not prove

- The v0.4.0 offline test suite, packaging check, contract tests and offline E2E **have not been
  executed at the time this note is written** — the v0.4 implementation, packaging and verification
  gates are in progress in the same round. Final numbers are recorded by the Lead in
  [plan/implementation-status.md](plan/implementation-status.md); every v0.4 row there starts as
  **in progress / not executed**. Use the checklist in §4 on your host.
- The panel's **visual rendering** has not been verified in any version, including v0.4.0.
- The real-profile install/restart for v0.4.0 has not been executed in this repository round; the
  executed evidence for v0.3.0 is historical and does not transfer.
- Nothing is published to npm or GitHub Releases, and `"private": true` stays.
