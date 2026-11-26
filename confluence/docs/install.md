# Install and verification guide (v0.4.0, three-layer memory + style cards)

- Status: **v0.1.0 was installed and activated on the real `desktop` profile on 2026-11-13** (Plugin
  Manager `install_bundle` → `application: applied`). **v0.2.x, v0.3.0 and v0.4.0 have not been
  installed into the real `desktop` profile or restarted there** — the linked bundle needs a DSH
  restart to load a new Host module generation. The v0.3.0 offline evidence is recorded in
  [`plan/implementation-status.md`](plan/implementation-status.md); the v0.4.0 gates are recorded by
  the Lead there. Treat every real-profile row below as pending until it is executed and recorded.
- Bundle: `dsh-confluence` **v0.4.0** (`private: true`), row id `confluence`, bundle patch
  `./cordis.patch.yml` (complete v0.4 default config: `memory` + `style` sections on top of the v0.3
  `store`/`bus`/`profile` row; no `maxEntriesPerWorkspace`, no top-level `pulse`/`export`).
- Target: DSH Desktop **0.2.2-rc.1** (minimum declared through `engines.dsh` `>=0.2.2-rc.1`), profile
  `desktop`, Windows 11. A scratch profile is used first.
- Upgrading from v0.3.x? The record types, tools, export document, config and the one-time
  `tech`/`context` → pattern migration are described in [upgrade-v0.4.md](upgrade-v0.4.md); this guide
  covers install and verification.
- Context: [ADR 0009](adr/0009-long-term-memory-persona-style.md), the binding
  [v0.4 interface contract](plan/v0.4-interfaces.md), [UI design](design/ui.md),
  [config contract](design/config.md).

> **Verification record.** v0.1.0 executed (2026-11-13): offline suite 256/256, packaging check 12/12,
> scratch-profile E2E 8/8, real-profile `install_bundle` applied. v0.2.0 executed (2026-11-16): offline
> suite 291/291, packaging check 17/17, M0 smoke 14 pass / 1 blocked, offline cross-directory E2E
> 15/15 + 12/12. v0.3.0 executed (2026-11-19): offline suite **353/353**, packaging check **18/18**,
> contract tests 24/24, offline scratch-profile E2E **17/17 harness checks + 15/15 assertion checks,
> exit 0** (run `.tmp/e2e/run-20261119-032058`). **v0.4.0: the offline gates are executed by the
> packaging workstream and recorded in [`plan/implementation-status.md`](plan/implementation-status.md);
> do not claim a v0.4.0 real-profile install, restart or panel rendering before those rows are
> recorded.** The panel's rendering has never been visually verified in any version.

---

## 1. What installation does

Installing a bundle performs three things:

1. adds the package as a profile dependency (a local link when installing from this checkout);
2. appends the bundle to `dsh.profile.bundles` in the profile manifest;
3. applies `cordis.patch.yml`, which inserts the single `confluence` Loader row with the complete
   default configuration.

Installing does **not** start a server, open a listening port, call a model, or write outside
`$DSH_HOME/storages/confluence/v1/` (plus the export files the user explicitly creates). It needs no
network access; the package has no dependencies.

Because this checkout is linked into the profile, **installing or upgrading requires a DSH restart** to
load a new Host module generation. A config edit only reloads the plugin row.

## 2. What the v0.4.0 host registers when it activates

Documented from the binding contract (§2–§7); the offline E2E evidence is recorded in
[`plan/implementation-status.md`](plan/implementation-status.md):

| Registration | Behaviour | Verification step |
|---|---|---|
| Eight model tools | `confluence_board`, `confluence_context`, `confluence_send`, `confluence_inbox`, `confluence_profile`, `confluence_memory`, `confluence_style`, `confluence_recall` (fixed order). The five v0.3 bus/recall tools are unchanged; `confluence_profile` is persona-only; `confluence_memory` captures candidates and exports/imports the portable document; `confluence_style` writes two-channel cards | tool list contains the eight names; a same-directory sibling sees a note/state key, a different directory does not |
| Four prompt contributions | `confluence:profile` (order 1400) persona block `<confluence-profile rev="…" facts="…">`; `confluence:memory` (1410) `<confluence-memory-patterns count="…" candidates="…">`; `confluence:style` (1420) `<confluence-style chat="…" engineering="…">`; `confluence:pulse` (1500) workspace digest `<confluence-memory scope="workspace" …>`. Caps: `profile.maxInjectChars`, `memory.maxInjectPatterns` / `memory.maxInjectChars` (`memory.maxPatterns` for the live store), `style.maxInjectCharsChat` / `style.maxInjectCharsEngineering` (`style.maxRules` for the live store) | a session with persona facts, promoted patterns and style rules shows all four blocks, each bounded; empty layers render nothing (profile substitutes the onboarding nudge) |
| Store: two scopes, ten record types | per-workspace journals `workspaces/<wsKey>/` for bus data; the global journal `workspaces/ws_0000000000000000/` for persona (`profile`), `profile-reset`, `pattern`, `style`, `memory-migration`, ledger rows and presence. v0.2/v0.3 files stay in place, untouched | workspace dirs appear per working directory; global memory records appear once the first pattern/style/fact is written |
| One-time migration | the first `MemoryService.attach()` converts legacy `profile` facts with section `tech`/`context` into `pattern` records (`source:'migration'`), then writes one `memory-migration` marker; idempotent, nothing rewritten | after the first session the global journal contains migrated patterns + exactly one marker; legacy profile records remain |
| Panel | read-only left-rail page with **three tabs** (工作区总线 / 长期记忆 / 用户画像) over seven same-origin GET routes: `ping`, `workspaces`, `bus`, `entry`, `profile`, `memory`, `profile/export` | rail entry opens the page; `GET /confluence/panel/ping` returns `{ok:true,…}`; workspace ids are opaque `ws_<16hex>`, never paths |
| Activation warnings | deterministic `CODE field` lines for invalid config (never user content); no new v0.4 deprecations, the v0.3 mappings still work | host log warning lines match the codes in [design/config.md](design/config.md); a leftover `store.maxEntriesPerWorkspace` logs `CONFIG_DEPRECATED store.maxEntriesPerWorkspace` and maps to `bus.notes.maxEntries` |

Expected negative results (the plugin must remain offline and quiet):

- no network egress, no additional listening port, no child process, no model call, no vector store;
- no writes inside any workspace directory;
- no `.jsonl.zstd` parsing: recall goes through `ctx.sessionQuery` only.

## 3. Prerequisites

- DSH Desktop 0.2.2-rc.1 (or a matching `dsh` CLI) with the `desktop` profile available.
- Node.js ≥ 22.19.0 (see `engines` in `package.json`).
- The repository checked out locally, e.g. `D:\05_Code\Confluence`.
- A disposable scratch profile (`$DSH_HOME` pointed at a temp directory) for the CLI path.

## 4. Path A — Plugin Manager `install_bundle`

This is the shipped DSH plugin-management path. The manager performs package installation and bundle
selection; do not reproduce it by hand-editing the profile.

1. Open **Plugins → Add plugin** in DSH Desktop, or call the `plugin_manager` tool with
   `action: "install_bundle"` and the absolute repository path as `target`.
2. Target: `D:\05_Code\Confluence`.
3. Confirm the bundle `dsh-confluence` appears and the `confluence` row is enabled.
4. **Restart DSH Desktop** so the linked checkout's new Host modules load.
5. Read the host log: activation warnings must be `CODE field` lines only — with a default config there
   are none; a stale v0.2/v0.3 override may log `CONFIG_DEPRECATED store.maxEntriesPerWorkspace`,
   `CONFIG_DEPRECATED pulse.*` or `CONFIG_DEPRECATED export`.
6. Run the verification checklist in §6.
7. When finished, remove the bundle (`remove_bundle` / Plugins UI), restart, and confirm the row
   disappears.

Status: **not executed on the real desktop profile for v0.2.x/v0.3.0/v0.4.0** (v0.1.0 install executed
2026-11-13). The same bundle path is exercised in the offline scratch-profile E2E; that does not
re-verify the real profile. Do not write "installed and verified" in release notes until this path is
executed and recorded here.

## 5. Path B — CLI into a scratch profile

Reproducible verification without touching the user's desktop profile.

```powershell
# A throwaway DSH_HOME: no real profile is opened.
$env:DSH_HOME = 'D:\05_Code\Confluence\.tmp\dsh-home'

# 1. Create a scratch profile from a shipped template and print the composed config.
dsh --profile confluence-scratch --from-default-profile headless --dump-config

# 2. Install this checkout as a linked local package
dsh plugin --profile confluence-scratch add 'D:\05_Code\Confluence'

# 3. Inspect the composed layer; the confluence row must be present with the full default config
#    (memory + style sections; no maxEntriesPerWorkspace / top-level pulse / export).
dsh --profile confluence-scratch --dump-config | Select-String 'confluence' -Context 0,80

# 4. Boot the scratch profile and check the activation warnings.
dsh --profile confluence-scratch
```

Expected composed layer (the `confluence` row from `cordis.patch.yml`):

```yaml
# == dsh-confluence
- id: confluence
  name: dsh-confluence
  config:
    enabled: true
    store: { dir: '', retentionDays: 90, maxBodyBytes: 8192, pollMs: 4000, watch: true, maxOpenWorkspaces: 16 }
    bus: { ... }
    profile: { enabled: true, inject: true, maxFacts: 200, maxInjectChars: 1200, minConfidence: 0.3, maxValueBytes: 1024, maxExportBytes: 65536 }
    memory:
      enabled: true
      inject: true
      maxPatterns: 300
      maxInjectPatterns: 5
      maxInjectChars: 1200
      candidateConfidence: 0.5
      autoCapture: candidate
    style:
      enabled: true
      inject: true
      maxRules: 100
      maxInjectCharsChat: 600
      maxInjectCharsEngineering: 900
    ...
```

If `dsh` is not on `PATH`, the Desktop installation ships one under
`<DeepSeek Harness install>\resources\runtime\cli\bin\dsh.cmd`.

## 6. Verification checklist (v0.4.0 round)

Run in the scratch profile first, then (only after sign-off) in the real desktop profile, and restart
DSH after installing.

| # | Check | Expected | Status |
|---|---|---|---|
| 1 | `--dump-config` contains `# == dsh-confluence` with the full v0.4 default config | row composes; `memory`+`style` present; no `maxEntriesPerWorkspace`, no top-level `pulse`/`export` | **Not executed on the real profile**; the offline E2E composes the scratch row |
| 2 | Bundle is listed and can be toggled | enabled, no `failed`/`overridden` | **Not executed** |
| 3 | Host log shows only `CODE field` activation warnings (none with defaults) | zero warnings with defaults | **Not executed** on the real profile |
| 4 | Tool list contains the eight v0.4 `confluence_*` tools | `board`, `context`, `send`, `inbox`, `profile`, `memory`, `style`, `recall` present | **Not executed on the real profile**; the offline suite/E2E cover registration |
| 5 | Four prompt blocks render bounded: persona, `<confluence-memory-patterns>`, `<confluence-style>`, workspace pulse | each bounded/byte-stable; empty layers render nothing (persona substitutes the onboarding nudge) | **Not executed on the real profile** |
| 6 | Candidate flow: a new pattern is stored as `candidate`, is not injected, and becomes `active` after `confluence_memory promote` | candidate visible via list/inbox-style reads; promoted rule appears in the memory block | **Not executed on the real profile** |
| 7 | Style flow: `confluence_style set` writes an active rule and it appears in the style block (chat and/or engineering) | rule injected in later sessions | **Not executed on the real profile** |
| 8 | Portability: `confluence_memory export` returns the `confluence.memory/v1` document; import merge/replace round-trips; legacy `confluence.profile/v1` documents still import (persona-only) | document validates, CLI `memory-export.mjs`/`memory-import.mjs` round-trip | **Not executed on the real profile**; covered by the offline suite |
| 9 | Migration: legacy persona `tech`/`context` facts become `pattern` records once, with a `memory-migration` marker; legacy records stay on disk | idempotent on restart | **Not executed on the real profile** |
| 10 | **Workspace bus unchanged:** same-directory sessions share notes/state/messages; another workspace never sees them | isolation preserved | **Not executed on the real profile** |
| 11 | Queued delivery unchanged: `confluence_send` appears at the recipient's next step, no interrupt/wake | `inbox=` cursor advances | **Not executed on the real profile** |
| 12 | Store: bus records under `workspaces/ws_<16hex>/`, global memory records under `workspaces/ws_0000000000000000/` | two-scope layout, no migration writes to old files | **Not executed on the real profile** |
| 13 | `privacy.privateSessions` makes a session invisible to every surface (bus, persona, memory, style, pulse, ledger, presence, recall) | no rows, no text | **Not executed on the real profile** |
| 14 | Panel: rail entry, three tabs, workspace bus detail, long-term memory (active + candidates), persona + style cards, export link, no absolute paths | opens, read-only, rendering verified | **Not executed** (no browser control) |
| 15 | No network egress, no new listening port, no child process, no model call | none | **Partially** — static contract scan passes; no network-disabled install run |
| 16 | Uninstall removes the row and leaves no plugin state | clean removal after restart | **Not executed** |

## 7. Offline guarantees for the install path

- The bundle declares **no dependencies**, so a local link install should not need registry access.
- `HYPOTHESIS:` pnpm may still contact its configured registry for unrelated profile bookkeeping even
  on a link install; verify with the network disabled and record the result. Do not claim
  "verified offline install" before that run.
- The plugin performs no network calls at runtime (contract-tested static scan).
- No additional listening port: the panel data channel is a route on the existing web server; it opens
  no port.

## 8. Rollback

```powershell
# Remove the bundle and its profile dependency, then restart DSH.
dsh plugin --profile <profile-name> remove dsh-confluence

# Scratch profile: delete the throwaway tree instead of touching any real profile.
Remove-Item -Recurse -Force 'D:\05_Code\Confluence\.tmp\dsh-home'

# Plugin data is separate from install state; delete only if you intend to lose the data:
#   Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\storages\confluence"
```

Rollback is a code revert, not a data restore: v0.4.0 never rewrites v0.1–v0.3 journals. A v0.3 build
ignores the new `pattern`/`style`/`memory-migration` record types (they stay on disk, unread) and the
workspace bus is unchanged. Back up `$DSH_HOME/storages/confluence/v1/` first if you want to preserve
the v0.4 memory for a later re-upgrade. See [upgrade-v0.4.md](upgrade-v0.4.md). Do not claim rollback
verified until it is executed.

## 9. What remains unexecuted

Everything below is still open; the offline evidence must be recorded before the first release
checkpoint can cite installation as verified.

- `plugin_manager install_bundle` of v0.4.0 into the **real desktop profile**, and the DSH restart that
  loads it (the linked bundle needs the restart; a config edit is not enough).
- Any real-profile live smoke (the E2E runs against a throwaway `DSH_HOME` so the user's live profile is
  never written).
- Panel rendering / visual verification in a live GUI (no browser control in this round).
- PTC preset (`run_code`) tool reachability; multi-window live freshness measurement.
- Soak/compaction stress and long-run retention.
- Uninstall/rollback executed end-to-end.
- Offline install with the network disabled.

## 10. Verification status (authoritative)

| Check | Status |
|---|---|
| Packaging/contract checks | v0.3.0: **executed — 18/18**. **v0.4.0: not executed yet** — run `node scripts/check.mjs` on the frozen tree; the result is recorded by the Lead in `plan/implementation-status.md` |
| Module + integration tests (`node --test --test-force-exit "test/*.test.js"`) | v0.3.0: **executed — 353/353**. **v0.4.0: not executed yet** — recorded by the Lead after the integration gate |
| Offline scratch-profile E2E (`scripts/e2e-dsh.ps1`) | v0.3.0: **executed — 17/17 + 15/15, run `.tmp/e2e/run-20261119-032058`**. **v0.4.0: fixtures updated for the v0.4 surface; result recorded by the Lead** |
| Same-workspace bus + cross-workspace isolation | v0.3.0 executed in the E2E; preserved by v0.4.0 (no bus changes) |
| Candidate → promote, style injection, memory export, migration | **v0.4.0:** covered by the offline suite; the E2E run result is recorded by the Lead |
| `install_bundle` into the real desktop profile (v0.4.0) + DSH restart | **Not executed** (Lead-owned) |
| CLI install into a scratch profile | **Covered by the offline E2E** (`dsh plugin add` into the throwaway profile) |
| Activation in a live desktop host (warnings, eight tools, four blocks, store) | **Not executed on the real profile** |
| Panel rendering / transport behaviour | **Not executed** (never visually verified) |
| Offline install (network disabled) | **Not executed** (hypothesis in §7) |
| Uninstall / rollback | **Not executed** |
