# Upgrading to v0.3.0 — workspace session bus + global user profile

- Applies to: `dsh-confluence` **v0.2.1 → v0.3.0** (DSH Desktop 0.2.2-rc.1, profile `desktop`,
  Windows 11), fully offline.
- Decision: [ADR 0008](adr/0008-bus-and-profile.md) (supersedes the scope rule of
  [ADR 0007](adr/0007-universal-memory-scope.md); ADR 0007's other guarantees carry over).
  Binding interface contract: [plan/v0.3-interfaces.md](plan/v0.3-interfaces.md).
- Read this before restarting DSH. The upgrade is **not** triggered by copying files: the installed
  bundle is a local link (`link:D:/05_Code/Confluence`), so DSH must be restarted to load the new Host
  module generation.
- v0.3.0 is a **breaking minor** (v0.2 → v0.3). The product surface, the store scope model, the tool
  names and the config shape all change. Read §2 (config) and §3 (legacy data) before starting.

## 1. What changed

v0.3.0 retires the v0.2 "one global board for every session" framing and delivers two modules instead:
**workspace session bus** (same-workspace context + notes + messages) and **global user profile**
(durable facts injected into every session, portable via JSON/Markdown). The product decision is
[ADR 0008](adr/0008-bus-and-profile.md); the exact interfaces are the binding
[v0.3 contract](plan/v0.3-interfaces.md).

| Area | v0.2.1 (universal memory) | v0.3.0 (workspace bus + user profile) |
|---|---|---|
| Product framing | one global shared board per profile | module 1 workspace session bus + module 2 global user profile |
| Memory scopes | one global scope `ws_0000000000000000` ("All sessions") | **two scopes**: one journal per workspace `ws_<16hex>` (bus data) + the global scope (profile facts, ledger, presence) |
| Workspace role | provenance label only | **bus identity**: sessions with the same frozen `session.header.cwd` share context/notes/messages; data is never merged across workspaces |
| Board | one global board, all sessions | notes are per workspace (`confluence_board`, same actions) |
| Keyed state pool | not present | **new** `confluence_context`: `list/get/set/delete` per-workspace keys |
| Messages | not present | **new** `confluence_send` + `confluence_inbox`: addressed, durable, **queue-based** delivery |
| Profile | not present; the global board carried background | **new** `confluence_profile` (get/list/set/forget/export/import) in the global journal |
| Prompt | one `<confluence-memory scope="global" …>` pulse | `<confluence-memory scope="workspace" …>` pulse (order 1500) **+** `<confluence-profile rev="…" facts="…">` block (order 1400) |
| Tools | six: `confluence_board/post/read/search/reply/recall` | six: `confluence_board`, `confluence_context`, `confluence_send`, `confluence_inbox`, `confluence_profile`, `confluence_recall` (order fixed) |
| Panel | one global timeline (`ping`/`overview`/`entry`) | two read-only views: **工作区总线** + **用户画像** (`ping`/`workspaces`/`bus`/`entry`/`profile`/`profile/export`) |
| Export | opt-in memories export (`confluence.memories/v1`) | unchanged legacy producer kept for tooling; **new** profile JSON/Markdown export/import (tool + CLI + panel download) |
| Config | `store`/`pulse`/`ledger`/`recall`/`privacy`/`export`/`ui`/`debug` | new `bus` + `profile` sections; deprecated keys mapped/warned (§2) |
| Version | 0.2.1 | **0.3.0** |

Unchanged on purpose: fully-offline posture (no network, no extra port, no subprocess, no model call),
append-only JSONL store with per-writer shards, bounded prompt text, untrusted shared content,
metadata-only ledger, best-effort redaction, `privacy.privateSessions` invisibility, read-only
same-origin panel transport.

## 2. Config migration (breaking)

The v0.3 defaults are in `cordis.patch.yml` (§7 of the binding contract:
[plan/v0.3-interfaces.md](plan/v0.3-interfaces.md#7-config-v03-libconfigjs-defaults--cordispatchyml-row)).
A user patch that replaces the **whole** row config must be re-copied from the new
[`examples/profile-patch.yml`](../examples/profile-patch.yml), because the Loader replaces the complete
`config` object instead of deep-merging. (The file is being updated by the packaging workstream; use
`cordis.patch.yml` in this repository as the authoritative block until then.)

Deprecation mapping — each old key produces a deterministic warning and is honoured by mapping, not
silently dropped:

1. **`store.maxEntriesPerWorkspace` → `bus.notes.maxEntries`** (default `2000`). Warning:
   `CONFIG_DEPRECATED store.maxEntriesPerWorkspace`.
2. **top-level `pulse.*` → `bus.pulse.*`** (`enabled`, `maxChars` 1400, `maxMessages` 3,
   `maxStateKeys` 3, `maxPeers` 2). The v0.2.1 `pulse` block keeps working via mapping; rename the
   keys to silence the warning.
3. **`export.*` is ignored** (`CONFIG_DEPRECATED export`). There is no runtime memories-export config
   in v0.3.0; the legacy `scripts/export-memories.mjs` producer is a tooling script, and the new
   profile export/import has its own tool/CLI/panel paths.
4. **`privacy.disabledWorkspaces` stays ignored** (removed already in v0.2.0; there is still no
   per-directory sharing switch — the workspace only decides which bus a session sees).
5. **Unchanged:** `ledger.*` (including `maxSessions`), `recall.*`, `privacy.*` (including
   `privateSessions`), `ui.*`, `debug.*`, `enabled`.
6. **New:** `bus.enabled`, `bus.context.*`, `bus.notes.*`, `bus.messages.*`, `bus.pulse.*`,
   `profile.*`, `store.maxOpenWorkspaces` (16).

Minimal example of the changed sections — in practice copy the whole block and change only what you
need, because the Loader replaces the row `config` instead of deep-merging it:

```yaml
- id: confluence
  config:
    store:
      maxOpenWorkspaces: 16
    bus:
      enabled: true
      context:
        maxKeys: 200
        maxValueBytes: 8192
      notes:
        maxEntries: 2000
      messages:
        maxStored: 500
        maxBodyBytes: 4096
      pulse:
        enabled: true
        maxChars: 1400
        maxMessages: 3
        maxStateKeys: 3
        maxPeers: 2
    profile:
      enabled: true
      inject: true
      maxFacts: 200
      maxInjectChars: 1200
      minConfidence: 0.3
      maxValueBytes: 1024
      maxExportBytes: 65536
    privacy:
      privateSessions: []
```

Check the composed row before trusting it:

```powershell
dsh --profile desktop --dump-config | Select-String 'confluence' -Context 0,80
```

Look for `bus:` and `profile:` sections and for the **absence** of `maxEntriesPerWorkspace:` and a
top-level `pulse:`; if an old key remains, the activation warning names it. The field-by-field rules
are in [design/config.md](design/config.md); `lib/config.js` DEFAULTS must deep-equal the patch row.

## 3. Legacy data: preserved read-only, never migrated

- **v0.2.1 global board entries** live in `workspaces/ws_0000000000000000/`. v0.3.0 leaves those files
  **byte-for-byte untouched** and does **not** merge them into any workspace view: there is no reliable
  workspace attribution for every row, and the global "all sessions board" view is retired. They stay
  on disk as a historical record; the opt-in export tooling (`lib/export.js`) can still read them
  read-only, with no migration. Do not expect them in the v0.3 panel or in `confluence_board`.
- **v0.1.0 per-workspace journals** (`workspaces/ws_<16hex>/`) are simply the v0.3 journal directories
  of those workspaces: when the workspace is opened, their records are read as-is and old notes appear
  in that workspace's bus. No file is rewritten, moved or migrated; new writes append new shard files
  in the same directory.
- **Profile starts empty.** Nothing is inferred from the old board or from session logs. The user (or
  an agent on request) can create facts with `confluence_profile set`, import a profile JSON document,
  or use the CLI. There is no automatic migration from v0.2 notes to profile facts.
- **Mixed versions are harmless.** A writer process still running v0.2.1 appends only to the global
  journal; v0.3 ignores unknown-in-scope records. The reserved global key
  `ws_0000000000000000` must never collide with a real workspace key (reserved by contract).

## 4. Restart and verify

1. Reinstall if the profile is pinned by version: Plugin Manager `install_bundle` from
   `D:\05_Code\Confluence` (or `dsh plugin --profile desktop add 'D:\05_Code\Confluence'`).
2. **Restart DSH Desktop.** A config edit alone only reloads the plugin row; the linked bundle needs a
   new Host module generation, so the old code staying resident is expected until restart.
3. Verify (details in [install.md](install.md); that guide's v0.3 checklist is being updated by the
   packaging workstream):
   - the composed row has `bus:` and `profile:` sections, no `maxEntriesPerWorkspace:` and no
     top-level `pulse:`;
   - six `confluence_*` tools are present in a session: `confluence_board`, `confluence_context`,
     `confluence_send`, `confluence_inbox`, `confluence_profile`, `confluence_recall`;
   - a session in a directory renders a `<confluence-memory scope="workspace" name="…">` pulse; snapshots
     committed before the restart may still carry the v0.2.1 `scope="global"` tag in the session log —
     the watermark parser keeps reading their `seq` and they are not re-rendered as new pulses;
   - with at least one profile fact, every session also gets a bounded
     `<confluence-profile rev="…" facts="…">` block; an empty profile renders one bounded onboarding
     nudge (`status="empty"`, gone after the first fact) instead;
   - write a key with `confluence_context set` in session A and read it with `confluence_context get`
     in session B **in the same directory** — the headline module-1 check;
   - `confluence_send to:"*"` in A becomes visible in B at B's next step (pulse/inbox), never as an
     interruption;
   - a session in a **different** directory does not see that workspace's context/notes (module-1
     isolation) while `confluence_profile get` shows the same profile everywhere;
   - the panel opens with two tabs (工作区总线 / 用户画像); workspace ids are `ws_<16hex>` and no
     absolute path appears;
   - store files: bus records under `workspaces/ws_<16hex>/`, profile/ledger/presence under
     `workspaces/ws_0000000000000000/`;
   - `privacy.privateSessions` still removes a session from every surface;
   - no network, extra port or child process appears (the panel is same-origin GET only).

## 5. Rollback

The upgrade writes nothing into the old data and does not rewrite any journal, so rollback is a code
revert, not a data restore:

1. Point the profile back at the v0.2.1 commit (`c7c93f0`) and restart DSH.
2. The v0.3 workspace journals and the global journal stay on disk. v0.2.1 does not understand the
   new record types (`context`, `message`, `profile`, `profile-reset`) and ignores them; it will treat
   the v0.3 workspace directories as legacy per-workspace journals and merge their `entry` records
   read-only into its global board view. If you do not want that, **back up**
   `$DSH_HOME/storages/confluence/v1/` first and move the v0.3 workspace directories aside before
   reverting.
3. The v0.2.1 store, its config keys and its panel routes come back unchanged; bus and profile
   features disappear with the code.

Rollback does not lose data. It does lose the v0.3 features, because that is the point of the version.

## 6. What this upgrade does not prove

- The v0.3.0 offline test suite, packaging check, contract tests and offline E2E **have not been
  executed at the time this note is written**; the v0.3.0 verification results are recorded by the
  Lead in [plan/implementation-status.md](plan/implementation-status.md). Use the checklist in §4 on
  your host.
- The panel's **visual rendering** has not been verified in any version, including v0.3.0.
- The real-profile install/restart for v0.3.0 has not been executed in this repository round; the
  evidence for v0.2.1 is historical and does not transfer.
- Nothing is published to npm or GitHub Releases, and `"private": true` stays.
