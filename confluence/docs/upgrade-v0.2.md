# Upgrading to v0.2.0 — universal memory

- Applies to: `dsh-confluence` v0.1.0 → **v0.2.0** (DSH Desktop 0.2.2-rc.1, profile `desktop`,
  Windows 11), fully offline.
- Decision: [ADR 0007](adr/0007-universal-memory-scope.md). Interface delta:
  [plan/scope-refactor-delta.md](plan/scope-refactor-delta.md).
- Read this before restarting DSH. The upgrade is **not** triggered by copying files: the installed
  bundle is a local link (`link:D:/05_Code/Confluence`), so DSH must be restarted to load the new Host
  module generation.
- **v0.2.1 display-name patch:** if you already run v0.2.0, no config/data action is needed — v0.2.1
  only changes the Chinese display name from **汇流** to **高级记忆**; restart DSH and refresh the Web
  panel to show it. Scope, store format, tool API and export contract are unchanged.

## 1. What changed

| Area | v0.1.0 | v0.2.0 |
|---|---|---|
| Memory scope | One memory space **per workspace** (`header.cwd`) | **One memory space per profile** — every session, every directory |
| Scope key | `ws_<16hex>` per workspace | Reserved global key `ws_0000000000000000`, label "All sessions" |
| Workspace role | Partition + filter + consent boundary | **Provenance only** (`origin.workspaceLabel` on entries, ledger rows, peers) |
| Store writes | `workspaces/<per-workspace-key>/` | `workspaces/ws_0000000000000000/` only; legacy dirs read-only |
| Pulse | `<confluence-workspace name="…">` | `<confluence-memory scope="global" …>` (legacy tags still parsed) |
| Tools | Six tools scoped to the caller's workspace; `NO_WORKSPACE` error | Same six tools, universal wording; recall covers all earlier sessions; error code no longer used |
| Panel | Workspace switcher + per-workspace board | One global timeline, provenance chips, no workspace switcher; `/workspaces` route removed |
| Export | `--workspace`, manifest per workspace | `scope:"global"`, global `wsKey`, `origin` additive field, no `--workspace` |
| Config | `privacy.disabledWorkspaces`, `ledger.maxSessionsPerWorkspace` | **Removed** / **renamed** (see §2) |

Unchanged on purpose: `confluence.memories/v1` export field contract (additive only), the six tool
names and parameter schemas, the pulse budget, redaction, caps, `privacy.privateSessions`, the
offline/no-egress posture, and the `store` / `pulse` / `recall` / `ui` / `export` / `debug` config
sections.

## 2. Config migration (breaking)

Two keys change. Everything else in an existing override keeps working, but a user patch that replaces
the **whole** row config must be re-copied from the new
[`examples/profile-patch.yml`](../examples/profile-patch.yml) because the Loader replaces the complete
`config` object.

1. **Removed — `privacy.disabledWorkspaces`.** There is no workspace boundary to disable. At
   activation a profile that still sets it logs a deterministic warning
   `CONFIG_DEPRECATED privacy.disabledWorkspaces` and ignores the value. If you used it to keep a specific
   conversation out of shared memory, the replacement is `privacy.privateSessions`
   (per session id, not per directory): a private session gets no pulse, no ledger row, no presence
   and no Confluence tools.
2. **Renamed — `ledger.maxSessionsPerWorkspace` → `ledger.maxSessions`.** Same meaning, now a global
   cap (default `200`, range `20–1000`). The old key is still accepted with a
   `CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace` warning and mapped to the new key; rename it to
   silence the warning.
3. **Kept but re-scoped — `store.maxEntriesPerWorkspace`.** The name is unchanged on purpose; it now
   caps the single global board (default `2000`).
4. **Not configurable — the scope.** There is no `memory.scope` switch in v0.2.0. Universal is the
   product; a future per-topic grouping, if it ever exists, must be a view, not an isolation boundary.

Minimal edit for a typical v0.1.0 override:

```yaml
- id: confluence
  config:
    # … keep your store / pulse / recall / ui / export / debug values …
    ledger:
      enabled: true
      maxFilesPerSession: 8
      maxSessions: 200          # was maxSessionsPerWorkspace
      fileHintsInPulse: false
    privacy:
      redact: true
      redactTitles: true
      redactPatterns: []
      denyPathPatterns:
        - '**/.env*'
        - '**/*.pem'
      privateSessions: []       # no disabledWorkspaces
```

Check the composed row before trusting it:

```powershell
dsh --profile desktop --dump-config | Select-String 'confluence' -Context 0,20
```

Look for `maxSessions:` and the absence of `disabledWorkspaces:`; the full default block is in
[`../cordis.patch.yml`](../cordis.patch.yml) and the field-by-field rules in
[design/config.md](design/config.md).

## 3. Legacy memory: merged read-only, never migrated

- v0.1.0 journals under
  `$DSH_HOME/storages/confluence/v1/workspaces/ws_<16hex>/` are **not rewritten, moved or deleted**.
  New writes go only to `workspaces/ws_0000000000000000/`.
- On read, the global view (board, pulse, panel, export) is the merge of the global journal plus every
  legacy workspace journal. Legacy records keep their original `ws` field; their provenance label
  comes from the old `MANIFEST.v1.json` (basename of the canonical path).
- Consequence: old memories show up with a provenance chip, appear in recall/pulse/export, and cannot
  be written to any more. There is no destructive migration step to run and no data to import.
- A writer process still running an older plugin version would keep appending to its own legacy shard;
  that is harmless — the files are only merged on read.
- The reserved global directory must never collide with a real workspace key
  (`ws_0000000000000000` is reserved by contract).

## 4. Restart and verify

1. Remove/reinstall if the profile is pinned by version: Plugin Manager `install_bundle` from
   `D:\05_Code\Confluence` (or `dsh plugin --profile desktop add 'D:\05_Code\Confluence'`).
2. **Restart DSH Desktop.** A config edit alone only reloads the plugin row; the linked bundle needs a
   new Host module generation, so the old code staying resident is expected until restart.
3. Verify (details in [install.md](install.md) §6):
   - the composed row has `ledger.maxSessions` and no `privacy.disabledWorkspaces`;
   - activation warnings show `CONFIG_DEPRECATED privacy.disabledWorkspaces` only if you left the old key in;
   - six `confluence_*` tools are present in a session;
   - the first pulse uses `<confluence-memory scope="global" …>` (a legacy
     `<confluence-workspace …>` tag is only expected from snapshots committed before the upgrade);
   - write a note in session A (directory X) and read it with `confluence_board` in session B
     (directory Y, same profile) — this is the headline acceptance check;
   - old notes appear in the panel with a provenance label; no workspace switcher is present;
   - `node scripts/export-memories.mjs --dsh-home <dir> --dry-run` reports `scope: "global"` and the
     global `wsKey`, with no `--workspace` argument.

## 5. Rollback

The upgrade writes nothing to the old store, so rollback is a code revert, not a data restore:

1. Reinstall/point the profile back at the v0.1.0 commit (`4d76227`) and restart DSH.
2. Remove `workspaces/ws_0000000000000000/` only if you do **not** want the v0.2.0 global notes to be
   read by v0.1.0 later (v0.1.0 ignores unknown scope directories, so leaving it is safe and keeps
   the data for a future re-upgrade).
3. Your v0.1.0 journals are untouched and become writable again.

Rollback does not lose data. It does lose the cross-directory behaviour, because that is the point of
the version.

## 6. What the upgrade does not fix

- The panel's **visual rendering** is still unverified (new page needed after restart).
- The real-profile v0.2.0 install/restart has **not** been executed in this repository round; the
  offline scratch-profile evidence *is* green (E2E 15/15 + 12/12, run `.tmp/e2e/run-20261116-203730`).
  The evidence table lives in [plan/implementation-status.md](plan/implementation-status.md).
- Nothing is published to npm or GitHub Releases, and `"private": true` stays.
