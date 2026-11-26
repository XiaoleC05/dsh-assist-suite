# Confluence configuration contract (v1)

- Status: Round-3 detailed design. Binding once accepted; consistent with ADR-0001 §10 defaults.
- Author: `design-surface`. Target: DSH Desktop 0.2.2-rc.1, profile `desktop`, Windows 11.
- Scope: the plugin row config of `dsh-confluence` (`cordis.patch.yml`), the display metadata the
  Plugin Manager reads, and how profile edits reach a running plugin. Store format, tools and pulse
  content are owned by other design docs; this file owns **names, defaults, ranges, failure
  behavior, presets and the apply path**.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md), delta
> §9).** Two breaking config changes: **`privacy.disabledWorkspaces` is removed** (there is no
> workspace boundary to disable; it now produces `CONFIG_DEPRECATED privacy.disabledWorkspaces` and is
> ignored) and **`ledger.maxSessionsPerWorkspace` is renamed to `ledger.maxSessions`** (default 200,
> range 20–1000; the old name is mapped with `CONFIG_DEPRECATED ledger.maxSessionsPerWorkspace`).
> `store.maxEntriesPerWorkspace` keeps its name and now caps the single global board. `memory.scope`
> does **not** exist: universal is the product. `privacy.privateSessions` is the only session opt-out
> and is unchanged. v0.1.0 config blocks in this document are historical; use
> [`../../examples/profile-patch.yml`](../../examples/profile-patch.yml) and
> [`../upgrade-v0.2.md`](../upgrade-v0.2.md) for the current shape.

> **v0.3 amendment — `bus` / `profile` config sections
> ([ADR 0008](../adr/0008-bus-and-profile.md),
> [binding contract](../plan/v0.3-interfaces.md) §7).** The v0.3 row adds `bus`
> (`context.maxKeys` 200 / `maxValueBytes` 8192; `notes.maxEntries` 2000; `messages.maxStored` 500 /
> `maxBodyBytes` 4096; `pulse.enabled` + `maxChars` 1400 / `maxMessages` 3 / `maxStateKeys` 3 /
> `maxPeers` 2), `profile` (`enabled`, `inject`, `maxFacts` 200, `maxInjectChars` 1200,
> `minConfidence` 0.3, `maxValueBytes` 1024, `maxExportBytes` 65536) and `store.maxOpenWorkspaces`
> (16). Deprecated keys are warned and mapped, not silently dropped: `store.maxEntriesPerWorkspace` →
> `bus.notes.maxEntries` and top-level `pulse.*` → `bus.pulse.*`; `export.*` is ignored with
> `CONFIG_DEPRECATED export`, and `privacy.disabledWorkspaces` stays ignored. `lib/config.js`
> DEFAULTS must deep-equal the `confluence` row in `cordis.patch.yml` (packaging check). Migration
> details: [`../upgrade-v0.3.md`](../upgrade-v0.3.md). Every v0.1.0/v0.2.0 config block quoted below
> is historical.

> **v0.4 amendment — `memory` / `style` sections
> ([ADR 0009](../adr/0009-long-term-memory-persona-style.md),
> [binding contract](../plan/v0.4-interfaces.md) §7).** The row gains two sections with defaults
> `memory: {enabled:true, inject:true, maxPatterns:300, maxInjectPatterns:5, maxInjectChars:1200,
> candidateConfidence:0.5, autoCapture:'candidate'}` and `style: {enabled:true, inject:true,
> maxRules:100, maxInjectCharsChat:600, maxInjectCharsEngineering:900}`. `bus.*` and `profile.*` keep
> their v0.3 names and meaning (the `profile` budgets now bound the persona block only), and there are
> **no new deprecations**. `autoCapture` is a closed enum (`candidate` default, `off`; an unknown value
> falls back with `CONFIG_INVALID_VALUE`), `candidateConfidence` is a float in 0..1, and every new
> integer is range-checked like its v0.3 neighbours (wrong types fall back with a warning; activation
> never fails). Activation adds `MEMORY_BUDGET_RISK` when `memory.maxInjectChars > 2000` and
> `STYLE_BUDGET_RISK` when `maxInjectCharsChat + maxInjectCharsEngineering > 3000`. `lib/config.js`
> DEFAULTS must deep-equal the `confluence` row in `cordis.patch.yml` (packaging check). Migration
> details: [`../upgrade-v0.4.md`](../upgrade-v0.4.md).

## 1. Contract shape and principles

1. **Plain defensive object, not a schemastery `Config` export** (ADR-0001 §10). The row config is
   read as untrusted JSON: every field is defaulted in code, wrong types fall back, unknown fields
   are ignored. This keeps old/new rows loadable, makes partial overrides safe (see §6), and avoids
   a second schema authority beside the ADR. Activation never fails because of config. The shipped
   `cordis.patch.yml` already carries this complete default object and
   `test/contract.test.js` asserts it stays in sync with ADR-0001 §10.
2. **Warnings, not errors.** Every fallback records a deterministic activation warning
   (§3) surfaced through `confluence.ping`/`confluence.overview`, the panel footer, and the debug log.
3. **No environment variables control plugin behavior.** The only env input is the host-level
   `DSH_HOME` used to resolve the default store root; see §2.1. `CONFLUENCE_*` variables are
   deliberately not honored: env is inherited by tools and subprocesses, config is not.
4. **Config is the user-owned control plane.** Board data, watermarks and read cursors are not
   config. The M3/M4 UI never writes board content to config; it may write privacy opt-outs
   through the documented config-editor path (§7).

## 2. Complete field table

`config` is the YAML/JSON object on the bundle row. All keys are optional. Nested objects are merged
one level deep onto the defaults; a wrong-typed nested object falls back whole.

### 2.1 Root

| Field | Type | Default | Range / enum | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `enabled` | bool | `true` | — | Master switch: when `false`, the Host half registers no tools, no pulse context, no store I/O, no ledger, no panel data methods; the client module still loads and shows its disabled state. To remove the left-rail entry entirely, disable the bundle row in Plugin Manager (verify client-graph behavior, spike S-UI8). | warn `CONFIG_INVALID_VALUE`, fallback `true` |

Store root resolution, in order:

1. `store.dir` non-empty absolute path → use it (trailing separators trimmed, `fs.realpath` for
   display only; writes go to the given path).
2. `store.dir` non-empty relative path → resolve under `<DSH_HOME>/storages/confluence/`
   (e.g. `dir: shared` → `<DSH_HOME>/storages/confluence/shared`).
3. `store.dir` empty (`''`) → `<DSH_HOME>/storages/confluence/v1` (ADR-0001 §6).
4. `DSH_HOME` = env `DSH_HOME` if set, else `os.homedir()/.dsh` (host-owned resolution; ADR-0001 §6).

Device paths (`\\?\`, `\\.\`), UNC roots and paths that resolve to an existing file are rejected
→ fallback to (3) + warning. The resolved root is created recursively with the profile's default
ACLs; the panel shows it read-only in the footer.

### 2.2 `store`

| Field | Type | Default | Range | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `dir` | string | `''` | `''` or path, ≤512 chars | Store root (§2.1) | warn + fallback `''` |
| `retentionDays` | int | `90` | 7–3650 | Age cutoff for default board queries and the pulse; entries older than this are hidden from default reads (not deleted in v1; compaction owns deletion, M4). `confluence_read` by exact id still works. | warn + `90` |
| `maxEntriesPerWorkspace` | int | `2000` | 50–20000 | Visible-entry cap for the single **global** board (name kept from v0.1.0; meaning is now profile-wide). At the cap, new `confluence_post`/`confluence_reply` calls are rejected with `BOARD_FULL` and no line is appended; the tool tells the user to tombstone entries or lower retention. Open questions/handoffs count too. Owning rule: `data-model.md` §6 (`MAX_ENTRIES_PER_WORKSPACE`) and `store-format.md` §17 item 23. | warn + `2000` |
| `maxBodyBytes` | int | `8192` | 256–49152 | UTF-8 byte cap for one note body; larger posts are rejected with `CONFLUENCE_INVALID_ARGUMENT`. Must stay well under the journal line cap (64 KiB) to leave JSON/provenance headroom. | warn + `8192` |
| `pollMs` | int | `4000` | 1000–60000 | Host-side store freshness poll (the correctness contract; ADR-0001 §6). `fs.watch` only accelerates it. | warn + `4000` |
| `watch` | bool | `true` | — | Best-effort directory watcher (debounced 300–500 ms). Failure degrades silently to polling with one debug-log line. | warn + `true` |

### 2.3 `pulse`

| Field | Type | Default | Range | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `enabled` | bool | `true` | — | Registers the single global `systemPrompt.context` contribution. `false` = passive awareness off; tools still work. | warn + `true` |
| `maxHeadlines` | int | `3` | 0–5 | Unread headline lines in the pulse (ADR budget intent ≤3). `0` = no headlines, counts only. Values >3 accepted but warn (`PULSE_BUDGET_RISK`). | warn + `3` |
| `maxPeers` | int | `2` | 0–3 | Sanitized presence titles in the pulse (`0` = count only). | warn + `2` |
| `maxChars` | int | `1400` | 400–1400 | Hard rendered-text cap; truncation order is owned by the pulse design. The 1,400-char value is the ADR-0001 §8 hard cap (≤320 tokens). | warn + `1400` |

`pulse` never reads disk during assembly and has no time-varying fields; these are budgets, not
content switches.

### 2.4 `ledger`

| Field | Type | Default | Range | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `enabled` | bool | `true` | — | Session ledger `session` upserts + presence heartbeat files (title, status, turn count, timestamps, effective dir, ≤N relative paths). `false` disables ledger *and* presence: the pulse loses "Here now", the panel loses peers; board is unaffected. | warn + `true` |
| `maxFilesPerSession` | int | `8` | 0–16 | Distinct workspace-relative paths retained per session. `0` = no file hints stored at all (strongest privacy setting short of private sessions). | warn + `8` |
| `maxSessions` | int | `200` | 20–1000 | Ledger rows retained **profile-wide** (newest activity wins). Older cold rows are dropped; the board is unaffected. Renamed from `maxSessionsPerWorkspace` in v0.2.0; the old key is accepted with a `CONFIG_DEPRECATED` warning. | warn + `200` |
| `fileHintsInPulse` | bool | `false` | — | Adds live file hints to the pulse. Off by default (ADR-0001 §8); the panel always shows hints within `maxFilesPerSession` because it is user-initiated. | warn + `false` |

File hints are workspace-relative only, dotfile/secret paths denied by built-in patterns plus
`privacy.denyPathPatterns`, and always phrased "files seen in tool calls (partial)". No file
contents, no command lines, no shell-derived changes.

### 2.5 `recall`

| Field | Type | Default | Range | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `enabled` | bool | `true` | — | Registers `confluence_recall`; when `false` the tool is absent and recall-reference reads fail cleanly. | warn + `true` |
| `maxSessions` | int | `3` | 1–10 | All-session prior sessions read per recall call (profile-wide; no workspace filter, ADR-0007). | warn + `3` |
| `maxHits` | int | `5` | 1–20 | Total literal-match hits returned per call (across sessions). | warn + `5` |
| `timeoutMs` | int | `5000` | 500–30000 | Cooperative time budget; partial results are returned and marked. | warn + `5000` |

Recall is on-demand only: it reads prior session logs when the model explicitly calls the tool and
never runs inside the pulse provider (ADR-0001 §9). The config values are hard ceilings, not
targets.

### 2.6 `privacy`

| Field | Type | Default | Range / format | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `redact` | bool | `true` | — | Applies built-in secret patterns (API keys/tokens, PEM private keys, `password=`-style assignments, authorization headers) to note titles+bodies, recall excerpts, ledger file hints and export. Best effort, labeled as such. | warn + `true` |
| `redactTitles` | bool | `true` | — | Titles are redacted with the same rules (they can contain secrets pasted into a prompt). Turning this off is allowed but the panel shows a privacy-warning banner. | warn + `true` |
| `redactPatterns` | string[] | `[]` | ≤20 regex sources, each ≤200 chars, additive | Canonical in the v1 shape per ADR-0001 errata E2 (promised by §11; absent from the original §10 YAML): user patterns added to the built-ins. Custom regexes applied after built-ins with `giu`; cannot disable built-ins. | invalid regex dropped, warn `CONFIG_PATTERN_INVALID` |
| `denyPathPatterns` | string[] | `["**/.env*", "**/*.pem"]` | ≤32 patterns, each ≤200 chars, `*`/`**` glob only | Extra deny patterns for ledger file hints (added to built-ins: `.ssh/`, `.aws/`, `.git-credentials`, `id_rsa*`, `*.key`, `*.p12`, `*.pfx`, `secrets*`). Additive only; built-ins cannot be removed via config. | drop bad patterns, warn `CONFIG_PATTERN_INVALID` |
| `privateSessions` | string[] | `[]` | session ids, ≤256 entries, each `^[A-Za-z0-9._-]{4,128}$` | User-only per-session opt-out (the **only** opt-out in v0.2.0): no pulse (scoped `suppressRuntimeContext()`), no ledger row, no presence, no Confluence tools for that session. Existing entries stay readable to others in shared memory. | drop invalid ids, warn |

Private state is evaluated once per session at `agent/created` and again on config reload for live
agents (`ctx.agents.list()`), so toggling from the panel reaches running sessions. There is no
workspace-level opt-out in v0.2.0 (ADR 0007 §6).

### 2.7 `ui`

| Field | Type | Default | Range | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `enabled` | bool | `true` | — | Host registers panel data methods; the client half is loaded by the static `dsh.client` manifest regardless, so `false` renders the panel's disabled state and hides data. | warn + `true` |
| `pollMs` | int | `5000` | 2000–30000 | Panel refresh while visible; hidden panels stop polling. The client reads the effective value from `confluence.ping.ui.pollMs` (not hardcoded). UX budget, not a freshness guarantee (ADR-0001 §12). | clamp + warn |

### 2.8 `export` (M4; config accepted in v1)

| Field | Type | Default | Range / format | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `enabled` | bool | `false` | — | Opt-in switch for the `memories.v1.jsonl` + `manifest.json` export. `false`: the export command fails with `CONFLUENCE_EXPORT_DISABLED`. Since v0.2.0 nothing is ever written into a workspace; the default output root is `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`. | warn + `false` |
| `dir` | string | `.confluence/export` | `''` or a relative directory name, no `..`, no drive/UNC prefix, ≤256 chars | **Legacy (v0.1.0) workspace-relative export directory.** v0.2.0 keeps the field for config compatibility but the CLI defaults to the profile-local exports root and accepts `--out`; a rooted/`..` value is rejected. Files: `memories.v1.jsonl` (each line `v:1`, `schema:"confluence.memories/v1"`, global `wsKey`, optional additive `origin`) and `manifest.json` (`scope:"global"`, `formatVersion:1`, written last/atomically); tombstoned entries are exported as content-free `deleted:true` stubs. `store-format.md` §14 is authoritative; `solo-bench-integration.md` §6 is the consumer summary. | warn + default |

### 2.9 `debug`

| Field | Type | Default | Range / format | Effect | Invalid behavior |
|---|---|---|---|---|---|
| `logFile` | string | `''` | `''` or absolute file path | `''` = no debug file. When set, appends bounded JSONL diagnostics (codes, counts, timings, `writerId`, store root, config warnings) at ≤5 MB/rotation×2; never note bodies, recall text, prompts or tool output. Development aid only. | warn + `''` |

## 3. Activation warnings

`normalizeConfig(raw) -> { config, warnings: string[] }` (the shape `architecture.md` §5.2 assumes).
Each warning is a stable, deterministic line `"<CODE> <field>[#<index>]"` — never user content — so
tests and the panel can switch on the code prefix without parsing prose. Capped at 20, sorted by
`(CODE, field, index)`.

| Code | When | Line example |
|---|---|---|
| `CONFIG_INVALID_VALUE` | wrong type/range/enum | `CONFIG_INVALID_VALUE store.pollMs` |
| `CONFIG_UNKNOWN_FIELD` | key not in this contract (ignored) | `CONFIG_UNKNOWN_FIELD store.foo` |
| `CONFIG_DEPRECATED` | removed/renamed v0.1.0 key (value mapped or ignored) | `CONFIG_DEPRECATED privacy.disabledWorkspaces` |
| `CONFIG_PATTERN_INVALID` | bad glob or regex entry | `CONFIG_PATTERN_INVALID privacy.denyPathPatterns#2` |
| `CONFIG_PATH_INVALID` | store/export/debug path unusable | `CONFIG_PATH_INVALID store.dir` |
| `PULSE_BUDGET_RISK` | `pulse.maxHeadlines > 3` | `PULSE_BUDGET_RISK pulse.maxHeadlines` |
| `PRIVACY_TITLES_UNREDACTED` | `privacy.redactTitles: false` | `PRIVACY_TITLES_UNREDACTED privacy.redactTitles` |

Warnings surface in `confluence.ping` (`{ ok, pluginVersion, ui, capabilities, warnings }`), in
`confluence.overview` (`warnings[]`), in the panel footer ("configuration warnings: N"), once in
`ctx.logger?.warn` at activation (defensive optional call; HYPOTHESIS: logger shape mirrors Crisp
`lib/status.js:112-117` usage), and in `debug.logFile` when enabled. They do **not** block
activation and never change plugin state silently.

## 4. Worked example

Repository bundle patch (`cordis.patch.yml`, the file the bundle ships; ADR-0001 §13):

```yaml
- insert:
    - id: confluence
      name: dsh-confluence
      config: {}
```

A user patch layer that pins explicit values (every omitted field keeps its default; a matching
override replaces this row's `config` as a whole at the Loader level — see §6):

```yaml
- id: confluence
  config:
    enabled: true
    store:
      dir: ''
      retentionDays: 30
      maxEntriesPerWorkspace: 1000
      maxBodyBytes: 8192
      pollMs: 4000
      watch: true
    pulse:
      enabled: true
      maxHeadlines: 3
      maxPeers: 2
      maxChars: 1400
    ledger:
      enabled: true
      maxFilesPerSession: 8
      maxSessions: 200
      fileHintsInPulse: false
    recall:
      enabled: true
      maxSessions: 3
      maxHits: 5
      timeoutMs: 5000
    privacy:
      redact: true
      redactTitles: true
      redactPatterns: []
      denyPathPatterns:
        - '**/.env*'
        - '**/*.pem'
      privateSessions: []
    ui:
      enabled: true
      pollMs: 5000
    export:
      enabled: false
      dir: .confluence/export
    debug:
      logFile: ''
```

Because every field is defaulted in code, this minimal user patch is equally valid:

```yaml
- id: confluence
  config:
    privacy:
      privateSessions:
        - 'session-<id-of-the-conversation>'
```

## 5. Recommended presets

| Preset | Intent | Patch fragment |
|---|---|---|
| **default** | ADR-0001 v1 defaults: ambient awareness on, metadata on, file hints off in pulse, export off. | `config: {}` |
| **privacy-first** | Minimum metadata, no passive headlines, one recall session, short retention, nothing written into any workspace. | `store: { retentionDays: 14, maxEntriesPerWorkspace: 500 }` · `pulse: { maxHeadlines: 1, maxPeers: 0 }` · `ledger: { maxFilesPerSession: 0, fileHintsInPulse: false, maxSessions: 50 }` · `recall: { maxSessions: 1, maxHits: 3 }` · `export: { enabled: false }` · plus `privacy.privateSessions` as needed |
| **low-noise** | Quiet pulse, slower polling; board still complete. | `pulse: { maxHeadlines: 1, maxPeers: 0, maxChars: 700 }` · `store: { pollMs: 8000 }` · `ui: { pollMs: 10000 }` · `ledger: { fileHintsInPulse: false }` |
| **debugging** | Fast refresh + diagnostic log; never for daily use. | `store: { pollMs: 1000 }` · `ui: { pollMs: 2000 }` · `debug: { logFile: 'C:\Users\<user>\.dsh\confluence-debug.jsonl' }` |

Presets are documentation, not code paths: the plugin always reads one flat config; a preset is
just a recommended patch. If `enabled: false` / `pulse.enabled: false` is what a user wants long
term, disabling the bundle row is the cleaner equivalent.

## 6. Precedence and how changes apply

**Precedence** (lowest → highest): hardcoded defaults → profile patch row `config` → higher patch
layers that override the same row id. The Loader replaces a matched row's whole `config` with the
higher layer's object; because this plugin defaults every field in code, a partial override is
*technically* safe, but the repository patch, `examples/profile-patch.yml` and the install guide all
recommend copying the complete block (what the shipped `cordis.patch.yml` carries) and editing only
the values you need, so the effective config is readable in one place. There are no environment
overrides and no per-workspace config files in v1.

**Apply semantics:** config is read once per plugin activation. Any edit through the profile patch
or the config editor restarts the plugin row (documented Loader behavior; no `.volatile()` fields
in v1 because there is no schemastery `Config`). Consequences the UI must state:

- A reload re-runs `apply`: store handle, poll timer, watchers, projections, tool registrations and
  the client bundle generation are rebuilt. The panel shows "reloading…" while calls fail, then
  resumes on the next poll; no client-side optimistic state may survive it.
- Live sessions do not need re-creation: activation re-applies `privacy.privateSessions` to
  `ctx.agents.list()` with the scoped `systemPrompt.suppressRuntimeContext()` and tool `when`
  predicates (v0.2.0 has no workspace-level opt-out).
- Watermarks and board data are not config, so a reload never re-notifies or loses entries.

**UI opt-out persistence (M3):** the panel's opt-out control is a user action implemented as one
Host method (`confluence.setOptOut`) that edits `privacy.privateSessions` through
`ctx.get('configEditor').edit(entry, change)`
(signature verified live: `edit(entry, change(current, inherited))`; `entry` from
`ctx.fiber.entry`). If the editor is missing or rejects the write, the method returns
`CONFLUENCE_CONFIG_EDIT_UNAVAILABLE` and the panel shows the exact YAML to paste. HYPOTHESIS: the
editor accepts a row without a schemastery `Config` export — spike S-UI7. Immediate suppression for
the current session is applied before the write so the control is not a no-op while the restart lands.

## 7. Display metadata (Plugin Manager / Settings inventory)

| Item | Value | Source |
|---|---|---|
| npm package | `dsh-confluence` | ADR-0001 §13 |
| version | `0.2.0` (`private: true` until publishing) | ADR-0001 §13; `package.json` |
| bundle row id | `confluence` | ADR-0001 §13 |
| bundle patch | `./cordis.patch.yml` (`dsh.bundle.patch`) — ships the complete default object | packaging; `test/contract.test.js` asserts it |
| client half (M3) | `./client` in `exports` + `files`, and `dsh.client = { platform: 'web', immediately: true, inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout'] }`; the panel is implemented (global timeline, no workspace switcher) and still awaits a recorded visual check. | `package.json`; `client.js` |
| locale files | `locale/en.json`, `locale/zh.json`; exported `./locale/*.json`; both carry `meta` + the panel `ui` object (86 keys, `ui.md` §5) | host reference §Display metadata |
| `meta.title` | en `Confluence`, zh `高级记忆` | shipped locale files |
| `meta.description` | en `One shared memory for every session in this profile, fully offline.`; zh `本配置文件内所有会话共享同一份记忆，完全离线运行。` | this design; ADR 0007 |
| icon | `icon.svg` (converging-flow glyph, original artwork, ≤256 KiB), exported as `./icon`; package-root `"icon": "icon.svg"` takes priority | ADR-0001 §13; shipped `icon.svg`; host reference §Display metadata |
| `engines.dsh` | `>=0.2.2-rc.1` | ADR-0001 §13; shipped `package.json` |
| `engines.node` | `>=22.19.0` (verified runtime; `install.md` states the same) | shipped `package.json`; `docs/install.md:34` |
| exports / `files` | `.`, `./locale/*.json`, `./icon` at v0.1.0; M3 adds `./client`; `files` must cover every runtime file (contract-tested) | ADR-0001 §13; `test/contract.test.js` |
| license | MIT | ADR-0001 §13 |

Display metadata is read by Plugin Manager without activating the plugin; locales must still be
present when the Host half is disabled.

## Spike items

- **S-CFG1** — `configEditor.edit` on a plugin row with **no** schemastery `Config` export: accepted
  or rejected? Determines whether panel opt-out persistence is direct or the documented fallback
  (copy-paste patch). (HYPOTHESIS: accepted as raw JSON.)
- **S-CFG2** — Loader override replacement semantics for a row inserted by a bundle patch then
  overridden by the user layer: confirm a partial override object reaches `apply` with missing keys
  (not merged), and that our defaults handle it.
- **S-CFG3** — `store.dir` on a read-only or network drive: confirm activation warning path and
  degraded store state, not a crash.
- **S-CFG4** — `privacy.redactPatterns` regex compile cost and ReDoS exposure: bound inputs at
  200 chars and test catastrophic patterns; consider a complexity screen or drop the knob if it
  cannot be bounded (Lead decision).
- **S-CFG5** — Whether disabling the bundle row removes the static client module from the client
  graph (`clientModules` service) or leaves a dead panel entry.

## Open questions

1. **Reload behavior of opt-out** — is a full plugin restart on every toggle acceptable UX for M3,
   or should `privacy.privateSessions` become a `.volatile()` config field once a `Config` schema is
   introduced in v2? Restarting the Host half on a toggle also remounts the client module; the panel
   must be idempotent either way.
2. **`store.maxBodyBytes` vs journal line cap** — 49,152 is the proposed ceiling; the journal design
   may want a stricter 32 KiB to keep a merged line safely under 64 KiB. Owner: store design doc.
3. **Retention semantics** — should entries hidden by `retentionDays` still be returned by explicit
   `confluence_read` (proposed yes) and should the panel toggle "show older" exist in M3 or M4?
4. **Naming consistency** — warning prefixes (`CONFIG_*`, `PULSE_*`, `PRIVACY_*`) and error codes
   (`CONFLUENCE_*` per `tool-api.md`) must match the tool-api doc; cross-check before implementation.
