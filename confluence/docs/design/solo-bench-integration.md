# solo-bench × Confluence — integration and export-consumer design

Status: **merge + consumer are for a later phase; the export producer is implemented in v0.1.0.**
No changes to `solo-bench` or to the DSH profile happen in this phase. This document is the complete
merge plan and the contract that lets `solo-bench` (the personal offline Go workbench) read
Confluence's shared memory **without** depending on DSH, the plugin runtime, or any live process.
Binding decisions: [ADR 0006](../adr/0006-solo-bench-integration.md) (Proposed for the merge; the
producer side is implemented — see §6.5); context:
[ADR 0001](../adr/0001-confluence-architecture.md) §6/§13/§14, [testing.md](testing.md) §11, and the
`Crisp` precedent
([`Crisp/docs/integrations/deepseek-harness.md`](../../../Crisp/docs/integrations/deepseek-harness.md) §4,
[`Crisp/integrations/dsh-plugin-crisp/`](../../../Crisp/integrations/dsh-plugin-crisp/)).

One-paragraph summary: Confluence is vendored into `solo-bench/integrations/dsh-plugin-confluence/`
with `git subtree`, so the workbench repository carries a self-contained copy of the plugin and its
docs. `solo-bench` never imports DSH or the plugin; it gains (in a separately approved later phase) a
small **read-only Go parser** for the plugin's opt-in export — `manifest.json`
plus `memories.v1.jsonl` under the `confluence.memories/v1` format. The export is deterministic,
redacted, relative-path and file-only, which is exactly what a single-user, no-server,
no-model, no-subprocess workbench can consume offline.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md), delta
> §8).** The `confluence.memories/v1` field contract is unchanged (additive only), so the Go consumer
> keeps working. The manifest gains `"scope":"global"` and reports
> `workspace:{wsKey:"ws_0000000000000000", name:"All sessions"}`; **every record uses the global
> `wsKey`**, and an optional additive `origin:{workspaceKey?, workspaceLabel?}` carries the workspace
> the note came from (unknown fields are ignored by v1 consumers). The export is now profile-local by
> default: `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`, with `--out` to override; the
> `--workspace` CLI flag is gone and the producer function is `exportMemories()`. Older v0.1.0 exports
> remain valid v1 files with a per-workspace `wsKey`. Binding delta:
> [`../plan/scope-refactor-delta.md`](../plan/scope-refactor-delta.md) §8.

---

## 1. Non-negotiable constraints of the merge target (`solo-bench`)

Read from `D:\05_Code\solo-bench\README.md`, `main.go`, `internal/store/schema.sql` (2026-11-13):

| Constraint | Consequence for this design |
|---|---|
| Single-user local Go CLI, one SQLite file (`solo-bench.db`, WAL), one writer process | Consumer must be a pure file parser; no DB write path is added in phase 0 |
| No web server, no listening port, no message queue | Confluence must not require the workbench to host anything; export is a file in the workspace |
| No model API, no `os/exec` in phase 0; later capabilities are local subprocesses called by solo-bench | This consumer is **not** a capability/subprocess; it is a read-only parser, so it needs no service row and no invocation record |
| Fixed four service rows (`prompt-optimizer`, `model-discuss`, `spec-review`, `crisp`), all `SKIPPED` | Do **not** add a fifth `confluence` service row. A row would imply a callable capability; the export parser is data access |
| Project path is stored as a string; phase 0 does not read project directories or scan code | A future `confluence` command may read **one explicit export file** under a project path only in a newly approved phase; it must not scan directories |
| "不加许可证文件" (no license file added to solo-bench) | Never add/change a repo-root `LICENSE`; the vendored subtree keeps its own upstream `LICENSE` (decision O2 in the execution plan, ADR 0006) |
| Fully offline, no network, no package publishing | Subtree from the local Confluence clone (`D:\05_Code\Confluence`), never a network fetch; plugin install is a local path |
| Documentation in Chinese is the repo's idiom; code identifiers/output follow existing conventions | The consumer command name/help follows `solo-bench` CLI conventions (Chinese help), the export schema stays English |

## 2. Repository layout after the merge (later)

Mirrors the Crisp precedent (`solo-bench` is to Confluence what `Crisp` is to its plugin): the whole
Confluence repository is vendored into one integration directory, because in the Confluence repository
the plugin package **is** the repository root.

```text
solo-bench/
  main.go                      # unchanged
  internal/...                 # unchanged in phase 0; the consumer lands in a later phase
    confluenceexport/          # future: read-only export parser (no DSH, no network)
      export.go                # structs + manifest/JSONL parsing rules
      export_test.go
      testdata/confluence/…    # small conformance fixtures copied at merge time (see §9)
    cli/
      confluence.go            # future: `solo-bench confluence …` commands
  integrations/
    dsh-plugin-confluence/     # git subtree mirror of D:\05_Code\Confluence (plugin package + docs)
      package.json             # name dsh-confluence, dsh.bundle.patch, dsh.client (M3)
      cordis.patch.yml         # one row: id confluence
      index.js  lib/…  client.js  locale/…  icon.svg
      test/…  scripts/e2e-dsh.ps1
      docs/…                   # design + ADR + plan travel with the subtree
  .gitignore                   # later: add /integrations/dsh-plugin-confluence/node_modules/ and
                               # possibly /.confluence/ (export output) — see prerequisites §10
```

Rules: no changes inside `integrations/dsh-plugin-confluence/` outside upstream commits (the subtree
is a mirror; local edits would be overwritten/conflict on the next pull). The workbench's own consumer
code lives outside the subtree, in `internal/`. The plugin never knows `solo-bench` exists.

## 3. `git subtree` merge mechanics

Why subtree, not submodule/copy: `solo-bench` must stay a single self-contained offline repository
whose checkout does not need a second repository, a network fetch, or submodule init; the plugin must
be versioned together with the workbench that uses it. `git subtree --squash` gives one clean commit
per vendor update and a reproducible update path.

Prerequisites (one-time, later phase): Confluence repo has release tag `v0.1.0`; `solo-bench` tree is
clean; the merge is approved in the workbench's own phase plan.

```powershell
# run in D:\05_Code\solo-bench
git remote add confluence D:\05_Code\Confluence        # local path remote: fully offline
# (alternative form if a local path remote misbehaves:)
# git remote add confluence file:///D:/05_Code/Confluence
git fetch confluence main --tags

# vendor the whole Confluence repository under integrations/
git subtree add --prefix=integrations/dsh-plugin-confluence confluence main --squash \
  -m "vendor(confluence): import dsh-confluence v0.1.0 as a git subtree"

# later: update after a new Confluence release
git fetch confluence main --tags
git subtree pull --prefix=integrations/dsh-plugin-confluence confluence main --squash \
  -m "vendor(confluence): update to <tag/commit>"

# optional: send a workbench-side fix back upstream (avoid; fixes belong in Confluence)
git subtree push --prefix=integrations/dsh-plugin-confluence confluence <branch>
```

Verification after add/pull: `git log --oneline -3 -- integrations/dsh-plugin-confluence` shows one
squashed vendor commit; the subtree directory contains `package.json` with `dsh.bundle.patch`; the
`package.json` name/version match the Confluence release tag; `node --test` can run inside the
subtree; the vendored `scripts/e2e-dsh.ps1` still points only to relative in-tree paths.

### 3.1 Alternatives and tradeoffs

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **git subtree (whole repo, squash)** | Self-contained checkout; one commit per update; offline local remote works; histories stay simple; mirrors the Crisp `integrations/` precedent | Squashed history (loses per-commit Confluence history inside the workbench); occasional subtree merge conflicts if local edits are made in the subtree (forbidden here); adds ~1 vendored copy in history | **Chosen** |
| git submodule | Clean separation; exact commit pin; no vendored bytes | Requires a second repo to be present/cloned; `.gitmodules` network URL; offline users break; not self-contained; unlike Crisp | Rejected |
| Plain copy (no VCS link) | Simplest | No update path, no provenance, silent drift from upstream | Rejected |
| npm dependency / registry install | Version ranges, tooling | Violates fully-offline and no-publish constraints; adds a dependency on npm/registry; plugin is `private:true` | Rejected |
| Publish plugin and `dsh plugin add` from npm | Clean install path | Network + package publishing blocked/out of scope; still needs the source for an offline workbench | Rejected for the merge |

## 4. Profile bundle row wiring (later phase; documented, not executed now)

The DSH profile is a user environment, not part of `solo-bench`. The merged checkout is installed as a
**linked local bundle** (the same mechanism Crisp used, §4.2/4.3 of its integration doc):

```powershell
$dsh = 'C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$plugin = 'D:\05_Code\solo-bench\integrations\dsh-plugin-confluence'

# 1. back up the profile layer (outside the repository)
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
$backup  = 'D:\05_Code\solo-bench\.tmp\dsh-install-<stamp>'
New-Item -ItemType Directory -Force $backup | Out-Null
Copy-Item "$profile\package.json", "$profile\cordis.patch.yml" $backup

# 2. install the local package: saves the profile dependency and appends the bundle
& $dsh plugin --profile desktop add $plugin

# 3. verify the composition without booting the app (scratch copy of the profile patch)
& $dsh --profile desktop --dump-config | Select-String 'confluence' -Context 0,15
```

Expected wiring (same shape the Confluence scaffold already declares, verified in a scratch profile
when that phase runs): profile `dependencies` gains
`"dsh-confluence": "link:…/solo-bench/integrations/dsh-plugin-confluence"`; `dsh.profile.bundles`
gains `dsh-confluence`; composing the profile shows the single row

```yaml
- id: confluence
  name: dsh-confluence
  config: { … complete v1 defaults … }   # overrides in the profile patch replace the whole object
```

Notes and caveats to record in that phase's verification doc:

- **HMR/restart:** adding a new bundle can activate through HMR; *replacing* an installed package
  requires a restart (fresh JavaScript module generation). Browser halves need a page refresh.
- **No real-profile install without explicit user request.** This design phase installs nothing; the
  merge phase's verification should use a scratch `DSH_HOME`/profile first, exactly like Confluence's
  own E2E (execution plan §5 / Crisp §4.2).
- **Rollback:** restore the two backed-up profile files, then
  `& $dsh plugin --profile desktop remove dsh-confluence`; remove the dependency line if it remains.
- The workbench repo does not check in the profile; only `integrations/` ships.
- If the user prefers not to vendor the plugin, the same install command can point at the standalone
  `D:\05_Code\Confluence` checkout; the export contract is identical. Subtree is for provenance, not
  for runtime necessity.

## 5. Why `solo-bench` consumes the **export**, not the live journal

1. **The journal is a private cache with internal semantics.** It is per-writer sharded
   (`journal.<writerId>.v1.jsonl`), merge-on-read by lexicographic `seq`, has tombstones, compaction
   generations and a manifest/lease protocol meant for the plugin's own readers. A Go consumer would
   have to reimplement the plugin's merge rules and would break on every store-format change (which
   the ADR explicitly permits: per-line schema version, unknown types, compaction in M4).
2. **The journal can be mid-write or pruned.** Polling readers tolerate torn lines by design; a
   workbench snapshot must not. The export is written under the native lease and published manifest-last,
   so a consumer can reject an interrupted export deterministically.
3. **The export is the public, redacted, absolute-path-free surface.** The journal legitimately holds
   more metadata (writer ids, presence-adjacent rows, session ids, path hints) that the workbench must
   not need. ADR §6/§11 defines export as the *only* contract `solo-bench` is expected to consume.
4. **Decoupling.** File contract = no live IPC, no named pipes, no sockets, no shared process, no DSH
   install required for the Go binary, and it works when DSH is closed. A reverse dependency (plugin
   importing workbench concepts, or workbench importing DSH) is explicitly forbidden (ADR 0006).
5. **Versioning.** The export has a named format (`confluence.memories/v1`, `formatVersion` 1) and
   compatibility rules; the journal has only internal schema versions and no compatibility promise
   to third parties.
6. **No feedback loop.** The plugin never reads its own export back, so the workbench cannot corrupt
   live memory by accident; the read direction is one-way.

## 6. Export contract: files, manifest and JSONL

The contract itself is owned by [`store-format.md`](store-format.md) §14 (and ADR 0002 item 8); this
section is the **consumer view** and must not diverge from it. Output location (opt-in, explicit user
action): `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/` by default; `--out <dir>` may override
it. The plugin never reads these files back.

```text
$DSH_HOME/storages/confluence-exports/<UTC-stamp>/   # default root; --out may override
  memories.v1.jsonl     # one entry record per line; UTF-8, no BOM, "\n", ≤64 KiB per line
  manifest.json         # version/pointer envelope; written LAST, atomically
```

Only `memories.v1.jsonl` is promised; `manifest.json` is its version/integrity envelope (architecture
Q5); the store's own `MANIFEST.v1.json` (store-format §15) is a different, profile-local, never-exported file.

### 6.1 `manifest.json` (schema authority: `confluence.memories/v1`)

```json
{
  "schema": "confluence.memories/v1",
  "formatVersion": 1,
  "scope": "global",
  "producer": { "name": "dsh-confluence", "version": "0.2.0", "dsh": "0.2.2-rc.1" },
  "generatedAt": "2026-11-16T03:10:00.000Z",
  "workspace": { "wsKey": "ws_0000000000000000", "name": "All sessions" },
  "recordCount": 38,
  "firstSeq": "01JBQ8Z4K2V7R3N5T6X1Y8M0PQ",
  "lastSeq": "01JBQ8Z4K6D3E1G4J8F5X9Q7S2",
  "files": [ { "name": "memories.v1.jsonl", "bytes": 18422, "sha256": "<64 hex>" } ],
  "redaction": { "applied": true, "policy": "confluence.redact/v1" },
  "limits": { "truncated": false, "maxEntriesPerWorkspace": 2000 }
}
```

| Field | Consumer rule |
|---|---|
| `schema` / `formatVersion` | Validate **first**: accept only `schema == "confluence.memories/v1"` and `formatVersion == 1`; reject other versions with a clear upgrade message |
| `scope` | v0.2.0 additive field: `"global"`. **Ignore it** unless you specifically want to distinguish a universal export from a v0.1.0 per-workspace one (then treat a missing `scope` as the legacy per-workspace form) |
| `producer` | Diagnostics only (`name`, `version`, `dsh`); never feature-gate on version strings |
| `workspace.wsKey` / `name` | v0.2.0 reports the reserved global key `ws_0000000000000000` and name `All sessions`. **No absolute/home paths anywhere in the export** (ADR §11); the consumer knows which export directory it opened, so the label need not identify a folder |
| `generatedAt` | RFC 3339 UTC; the only non-deterministic manifest field (see §6.3); surface it as "export age" |
| `recordCount` / `firstSeq` / `lastSeq` | Cover **live (non-stub) records only**; tombstone stubs are excluded from these counts (Lead ruling) and validated separately. Consumer rule: count non-stub lines after parsing and require equality with `recordCount` |
| `files[0]` (`name`/`bytes`/`sha256`) | Exactly `memories.v1.jsonl`; `bytes`/`sha256` cover the **complete file including tombstone stubs** — verify before parsing |
| `redaction.applied` / `policy` | `true` = best-effort redaction ran (`confluence.redact/v1`); a marker, never a guarantee of safety |
| `limits.truncated` / `maxEntriesPerWorkspace` | `truncated:true` iff a cap prevented a complete export; `maxEntriesPerWorkspace` is the 2000 cap. Surface truncation to the user |

### 6.2 `memories.v1.jsonl` record (`type: "entry"`)

One JSON object per line, sorted ascending by `(seq, id)`; each line carries `"v":1` and
`"schema":"confluence.memories/v1"` (the manifest is the version authority). Unknown fields are
additive and ignored by readers; repeated exports of an unchanged store are byte-identical except the
manifest `generatedAt`/`files[].sha256`.

```json
{"v":1,"schema":"confluence.memories/v1","type":"entry","id":"cnf_01JBQ8Z4K1H9T2R6N4X7C0W8FD","wsKey":"ws_0000000000000000","seq":"01JBQ8Z4K2V7R3N5T6X1Y8M0PQ","ts":"2026-11-16T02:41:07.512Z","kind":"gotcha","title":"Windows rename retries wrap in EPERM","body":"spawnSync rename throws EPERM when a scanner holds the handle.","tags":["windows","fs"],"files":["src/fs/rename.ts"],"author":{"sessionId":"session-23da…","title":"Auth work","origin":"agent"},"origin":{"workspaceKey":"ws_3f9a1c7e2b4d8061","workspaceLabel":"solo-bench"},"replyTo":null,"resolves":null,"supersedes":null,"deleted":false,"deletedAt":null}
```

| Field | Type | Req | Rule |
|---|---|---|---|
| `v` | number | yes | `1` (line schema version) |
| `schema` | string | yes | `confluence.memories/v1`; the manifest is the version authority |
| `type` | string | yes | `"entry"` in v1; unknown types skipped by consumers |
| `id` | string | yes | Board id unchanged: `cnf_` + 26-char ULID (opaque; monitor for duplicates per file) |
| `wsKey` | string | yes | Must equal `manifest.workspace.wsKey` (the global constant in v0.2.0; a per-workspace key in v0.1.0 exports) |
| `origin` | object | no | v0.2.0 additive provenance `{workspaceKey?, workspaceLabel?}` (basename label, never a path). Ignore unknown fields |
| `seq` | string | yes | ULID string; export order and sort key |
| `ts` | string | yes | RFC 3339 UTC |
| `kind` | string | yes | `finding`, `decision`, `gotcha`, `question`, `handoff`, `warning` |
| `title` | string | yes | Redacted, whitespace-collapsed, 1–160 chars (`""` only on tombstone stubs) |
| `body` | string | no | Redacted, ≤8192 UTF-8 bytes; **omitted when empty** |
| `tags` | array[string] | no | ≤8, lowercased `^[a-z0-9][a-z0-9_-]*$`, redacted |
| `files` | array[string] | no | ≤8 workspace-relative paths, `/` separators, no drive/UNC/`..`/NUL; display-only, never resolved |
| `author.sessionId` / `title` / `origin` | string / string / string | yes / no / yes | Provenance; `origin` ∈ `agent`, `user`; title is redacted/capped (`""`/absent on stubs) |
| `replyTo` | string \| null | yes | Parent entry id; one-level threads (a reply-to-reply is re-targeted to the root) |
| `resolves` | string \| null | yes | The entry this reply resolves. Stored boolean mapped: `true` → the root entry id, `false`/absent → `null` |
| `supersedes` | string \| null | yes | Entry id this entry supersedes, else `null` |
| `deleted` | bool | yes | `false` for live entries; `true` for tombstone stubs |
| `deletedAt` | string \| null | yes | RFC 3339 when tombstoned, else `null` |

**Tombstone stubs.** A tombstoned entry is still exported, as a content-free stub: `deleted:true`,
`deletedAt` set, `title:""`, `body:""`, no `tags`/`files`, `author` reduced to `{sessionId, origin}`.
Stubs are sorted in the same stream but excluded from `recordCount`/`firstSeq`/`lastSeq` and from all
consumer views/counts (the workbench can show removal history without recovering removed text; replies
under a tombstoned thread root are not exported). Export v1 contains only `entry` records: no ledger
rows, no presence/status, no prompts, no assistant/tool text, no store metadata.

**Integrity rule (single definition, mirrored by store-format §14/§17):** `files[0].bytes`/`sha256`
cover the complete `memories.v1.jsonl` **including tombstone stubs**; `recordCount`/`firstSeq`/`lastSeq`
cover live records only. A consumer verifies bytes/hash first, then parses lines, then requires
non-stub line count == `recordCount` (stub lines are valid lines, just counted out). Never use a raw
line count as `recordCount`.

### 6.3 Determinism and atomicity rules

- Order: ascending `seq` then `id`. Repeated exports of an unchanged store produce **byte-identical**
  `memories.v1.jsonl`; `manifest.json` differs only in `generatedAt` and (if content changed)
  `files[0].sha256`/`bytes`/`recordCount`/`firstSeq`/`lastSeq`.
- Redaction: title/body/tags/files/author title pass the board's best-effort redaction on export
  (`data-model.md` §8.3 allow-list re-check); absolute/home paths never appear.
- Tombstones: exported only as content-free stubs (above); retention-hidden entries are excluded.
  Caps: `EXPORT_MAX_BYTES` 8 MiB (refuse/warn + `limits.truncated`), ≤2000 live entries.
- Atomic publish: write `memories.v1.jsonl.tmp-<writerId>` → fsync → rename; then write
  `manifest.json.tmp-<writerId>` → fsync → rename **last**. An interrupted export leaves either no
  manifest or one whose `files[0].sha256`/`bytes`/`recordCount` no longer match the JSONL — both detectable.
- The export never feeds back into the plugin; the plugin never reads `.confluence/export/`.

### 6.4 Compatibility and versioning rules

| Rule | Producer (plugin) | Consumer (`solo-bench`) |
|---|---|---|
| Unknown fields | May add optional fields within v1 | Ignore silently (no `DisallowUnknownFields`) |
| Unknown record types | v1 writes only `entry` | Skip and count; do not fail the whole export |
| Field meaning | Never change a v1 field's meaning; additive only | Never reinterpret a field; read what is documented |
| Breaking change | Bump `formatVersion` (2), add `memories.v2.jsonl` and a `manifest.json` with `formatVersion:2`; keep the v1 writer ≥1 minor release | Check `schema`/`formatVersion` first; implement v1 only until updated; clear upgrade message otherwise |
| Producer version | Diagnostics only | Never feature-gate on the version string |
| Invalid/incomplete export | Never publish a manifest that does not match its JSONL | Verify `files[0]` size/hash and `recordCount`/`firstSeq`/`lastSeq`; refuse with a clear error; never partially import |

A future `solo-bench` consumer implements `confluence.memories/v1` only until it is updated. The
Confluence repo's M4 fixtures (`test/fixtures/export/`) are the conformance examples both sides test
against; the authoritative rules are [`store-format.md`](store-format.md) §14.

### 6.5 Implementation status — producer side, executed 2026-11-13

The **producer** half of this contract is implemented in v0.1.0 and tested; the subtree merge and the
Go consumer remain future phases ([ADR 0006](../adr/0006-solo-bench-integration.md) stays
**Proposed**).

| Piece | Path | Status / evidence |
|---|---|---|
| Export library | `lib/export.js` (`exportMemories`, `validateExportDir`, `stripAbsolutePaths`, `workspaceLabelFor`, `EXPORT_SCOPE`) | Implemented. Reads merged journal records through `JournalStore`, folds them with `foldRecords`, writes the pair outside the store, never reads it back. v0.2.0 rebuilds it around the global scope. |
| CLI | `scripts/export-memories.mjs` (`run()` exported for in-process tests) | Implemented. `node scripts/export-memories.mjs --dsh-home <dir> [--out <dir>] [--json] [--dry-run]` — **no `--workspace` flag**. Default output `<dsh-home>/storages/confluence-exports/<UTC-stamp>/`. Exit 0 success; 1 runtime failure (`export-memories: <CODE>: <message>`, codes `BAD_ARGUMENT`, `EXPORT_FAILED`, `STORE_UNAVAILABLE`); 2 usage error. |
| Tests | `test/export.test.js` | Re-run against the v0.2.0 global exporter (mapping/order, global `wsKey`, additive `origin`, manifest `scope`, tombstone stubs, redaction/absolute-path stripping, determinism, store read-only + dry run, CLI run() paths). |
| Integrity rule (V7) | `lib/export.js` manifest builder | Unchanged: `files[0].bytes`/`sha256` cover the complete JSONL **including tombstone stubs**; `recordCount`/`firstSeq`/`lastSeq` count **live** records only. |
| Caps | `lib/export.js` | Per-line 64 KiB enforced; total file capped at 8 MiB by deterministic tail truncation with `limits.truncated: true`; `maxEntriesPerWorkspace` recorded in `limits`. |
| E2E proof | v0.2.0 run artifacts | **To re-record** after the refactor: the CLI exported the global store (scope `global`, global `wsKey`) with a deterministic hash and `--dry-run` writing nothing. The v0.1.0 evidence (per-workspace export of `ws_35ca2d7650a1831a`, 564-byte JSONL, sha256 `39d0ffe9…4247`) is historical. |
| UI/tool surface | — | **Not implemented:** no panel "Export now" button and no model-facing export tool; the CLI *is* the explicit user action. |
| Go consumer, subtree merge, fixtures | — | **Not started** (separate approved phase). `test/fixtures/export/` conformance fixtures land together with the consumer and must be regenerated from the v0.2.0 CLI (`real/` fixtures are global exports). |

Implementation notes / deviations from the design sketch (all reviewed, none contract-breaking):

1. `exportWorkspace()` accepts optional test seams (`now`, `fs`, `writerId`, `dryRun`) in addition to
   the agreed `{store, board?, config, redactor, workspaceKey, outDir, logger}` call; production
   callers pass only the agreed fields. `dryRun` is what the CLI's `--dry-run` uses.
2. The CLI lives in `scripts/` (a repository tool like `scripts/check.mjs`), not in the published
   package `files` list; `config.export.enabled` stays `false` by default, so nothing is exported
   unless the user runs the CLI (an explicit action equivalent to the designed "Export now").
3. Retention hides older entries from the export (design §13.3 step 2) and is reported as
   `skippedRetention` in the CLI summary; it is not `limits.truncated` (retention is a documented
   filter, not a cap).
4. A redactor failure aborts the export with `EXPORT_FAILED` **before** any file is written (fail
   closed); the pair is never partially published.

## 7. Read-only Go consumer design (later phase; nothing implemented now)

### 7.1 Package and types (proposed)

`internal/confluenceexport/` — stdlib only (`encoding/json`, `bufio`, `crypto/sha256`, `os`,
`time`), no network, no `os/exec`, no DSH import:

```go
// export.go — types are a projection of the contract (store-format.md §14), not a redefinition.
type Manifest struct {
    Schema        string    `json:"schema"`        // "confluence.memories/v1"
    FormatVersion int       `json:"formatVersion"` // 1
    Producer      Producer  `json:"producer"`
    GeneratedAt   time.Time `json:"generatedAt"`
    Workspace     Workspace `json:"workspace"`
    RecordCount   int       `json:"recordCount"` // live entries only; tombstone stubs excluded
    FirstSeq      string    `json:"firstSeq"`
    LastSeq       string    `json:"lastSeq"`
    Files         []File    `json:"files"`
    Redaction     Redaction `json:"redaction"`
    Limits        Limits    `json:"limits"`
}
type Producer struct{ Name, Version, DSH string }
type Workspace struct{ WsKey, Name string }
type File struct{ Name string; Bytes int64; SHA256 string }
type Redaction struct{ Applied bool; Policy string }
type Limits struct{ Truncated bool; MaxEntriesPerWorkspace int }

type Entry struct {
    V          int        `json:"v"`          // 1
    Schema     string     `json:"schema"`     // "confluence.memories/v1"
    Type       string     `json:"type"`       // "entry" in v1
    ID         string     `json:"id"`         // cnf_<26-char ULID>, opaque
    WSKey      string     `json:"wsKey"`      // == manifest.Workspace.WsKey
    Seq        string     `json:"seq"`        // ULID string
    TS         time.Time  `json:"ts"`         // RFC 3339 UTC
    Kind       string     `json:"kind"`       // closed six-value set
    Title      string     `json:"title"`
    Body       string     `json:"body"`       // omitted when empty
    Tags       []string   `json:"tags"`       // omitted when absent
    Files      []string   `json:"files"`      // omitted when absent; display-only
    Author     Author     `json:"author"`
    ReplyTo    *string    `json:"replyTo"`    // null when absent
    Resolves   *string    `json:"resolves"`   // resolved entry id; null when absent/false
    Supersedes *string    `json:"supersedes"` // null when absent
    Deleted    bool       `json:"deleted"`
    DeletedAt  *time.Time `json:"deletedAt"` // null when live
}
type Author struct{ SessionID, Title, Origin string }
```

### 7.2 Parsing rules (strict where the contract is authoritative, tolerant where it says so)

1. Locate the export directory: the default `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`
   (profile-local) or an explicit `--export-dir` the user passes (v0.2.0 no longer writes into a
   workspace by default).
   for tests); **read-only**, no directory scanning beyond that one known path.
2. Read the manifest with a size cap (e.g. 64 KiB) and `json.Decoder`; **ignore unknown fields**;
   validate `schema == "confluence.memories/v1"`, `formatVersion == 1`, non-empty `workspace.wsKey`,
   exactly one `files[0]` named `memories.v1.jsonl`, and `recordCount >= 0`.
3. Open `memories.v1.jsonl` read-only; verify exact `bytes` and `sha256` against `files[0]` **before**
   parsing. Cap the file at `min(files[0].bytes, EXPORT_MAX_BYTES = 8 MiB)`; a larger file or a
   hash/size mismatch is a hard error ("incomplete or corrupt export").
4. Scan lines with `bufio.Scanner` and an enlarged buffer (64 KiB + margin; contract says ≤64 KiB per
   line). For each line: `json.Unmarshal` into `Entry` (unknown fields ignored); on parse error fail
   with the line number (a manifest-committed export should be complete — a bad line is corruption).
5. Validate per record: `v == 1`; `schema == "confluence.memories/v1"`; `type == "entry"` (skip and
   count unknown types); `wsKey == manifest.workspace.wsKey`; `id` non-empty and unique; `seq` a valid
   ULID string; `kind` in the six-value set; `ts` parses RFC 3339; `author.sessionId`/`author.origin`
   present. `replyTo`/`resolves`/`supersedes` are `null` or an id string.
6. Tombstone handling: for `deleted:true` records require `deletedAt` set, `title`/`body` empty, and
   no `tags`/`files` (content-free stub); exclude them from lists and counts by default. For
   `deleted:false` require a non-empty `title` and `deletedAt == null`.
7. Integrity against the manifest (single rule, see §6.2): `files[0].bytes`/`sha256` cover the complete
   file including stubs (verified in step 3); number of **live** (`deleted:false`) records ==
   `recordCount`; `firstSeq`/`lastSeq` equal the min/max `seq` among live records (skip when
   `recordCount == 0`); stub lines are valid lines but counted out — never compare the raw line count to
   `recordCount`. Records sorted by `(seq, id)` (if not, sort defensively and report the discrepancy);
   `limits.truncated`/`redaction.applied` are surfaced, never trusted as complete/safe. Any mismatch
   refuses the export.
8. Render: human table (kind, short id, title clipped, author/session title, `ts`) and `--json` mode
   matching the existing solo-bench convention; `--include-deleted` shows tombstone stubs (title empty,
   marked deleted); body previews clipped (e.g. 120 chars) unless `show`; `files`/`tags` are
   display-only, never resolved as filesystem paths.
9. Never write: no DB rows, no files, no cache, no logs; errors go to stderr with a non-zero exit
   code, like every other solo-bench command.

### 7.3 Proposed command surface (future phase, not implemented now)

```text
solo-bench confluence list --project <id> [--kind decision] [--json]
solo-bench confluence show <entry-id> --project <id> [--json]
solo-bench confluence status --project <id> [--json]
```

- `--project <id>` resolves to the stored project path; the command reads one explicit export
  directory: `--export-dir <dir>`, else the profile-local default
  `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/` the user names. It never scans the disk.
- The command is **read-only** and needs no DB schema change, no migration, no invocation row, and no
  service registry entry. If a future phase adds caching, that is a separate schema-versioned decision.
- Help text states: "Reads Confluence's exported memory; export it from DSH first. Works offline."
- `status` prints `workspace.wsKey`/`name` (global in v0.2.0), `scope` when present, `recordCount` and
  the live `firstSeq`/`lastSeq` range, `files[0]` bytes/`sha256`, `formatVersion`, `limits.truncated`,
  producer version and `generatedAt` — enough to detect a stale/absent/truncated export.

### 7.4 Why not a `solo-bench service` row or subprocess

The service table models **callable local capabilities** (subprocesses with ALLOWED/BLOCKED/FAIL_OPEN
semantics). Reading a JSON file is not an invocation, has no allow/deny decision, no fail-open
behavior and no external program; adding a fifth fixed-row service would break the documented
"fixed four" invariant and imply runtime coupling that does not exist. The consumer stays a command.

## 8. Non-goals (explicit, for both sides)

- No live IPC: no named pipes, UNIX sockets, loopback HTTP, shared memory, or "just read the journal
  while DSH runs".
- No reading of `<DSH_HOME>/storages/confluence/**` (journal shards, presence files, snapshots).
- No import of DSH packages, plugin internals, or Cordis in Go; no JavaScript runtime in `solo-bench`.
- No reverse dependency: the Confluence plugin must not import, invoke, detect, or write `solo-bench`
  code or its SQLite file. The only shared artifact is the export directory.
- No server, no model call, no `os/exec`, no extra listening port, no network on either side.
- No DB schema change / migration / new table / new service row in `solo-bench` phase 0; the consumer
  is gated behind a separate, explicitly approved later phase.
- No automatic discovery: the consumer never scans the disk for `.confluence` dirs or profiles; the
  user names the export directory.
- No writing to the export directory; no "sync", no merge, no dedupe across exports (one export
  directory per invocation).
  per invocation, by explicit project/export path).
- No new license file at the `solo-bench` root; the vendored subtree keeps its upstream `LICENSE`.
- No subtree push automation or CI; updates are a manual, reviewed command.

## 9. Testing and conformance (producer executed; consumer later)

Confluence side (implemented and executed 2026-11-13): `EXP-01..10` in `test/export.test.js` prove
record mapping/ordering, live-only `recordCount`/`firstSeq`/`lastSeq`, tombstone stubs, manifest
`files[0]` hash/byte coverage over the complete file, redaction/no-absolute-path output,
determinism (byte-identical JSONL), store read-only + no read-back + dry run, fail-closed failure
modes, the CLI `run()` paths, and the helper contracts. Command:
`node --test --test-force-exit "test/export.test.js"` → **10/10 pass**. The V7 integrity rule
(hash/bytes over the complete file, counts over live records only, stub lines valid but counted out)
is implemented exactly; the end-to-end CLI proof against the E2E scratch store is recorded in §6.5.

Conformance fixtures `test/fixtures/export/` are **not committed yet**: they land with the approved
Go-consumer phase so that the Go side copies frozen fixtures into its `testdata/` instead of reading
this repository at test runtime (`schema:"confluence.memories/v1"`, `formatVersion:1`, `cnf_` ids).

`solo-bench` side (future phase): table-driven Go tests against small `testdata/confluence/` fixtures
copied from the Confluence fixtures at merge time (vendored subtree paths are not stable test inputs):
valid export; unknown fields; unknown record type (skipped); tombstone stubs validated and filtered;
`files[0]` hash/bytes or `recordCount`/`firstSeq`/`lastSeq` mismatch (rejected); future
`formatVersion` (rejected with a clear message); malformed line (line-numbered error); oversized file
(cap error); absent optional fields (`body`, `tags`, `files`, null refs) accepted. Fixtures contain
synthetic data only, no real session content, no secrets.

Cross-check (optional): a Confluence-side test hashes the committed fixtures; the Go side compares the
same hashes at development time. No runtime coupling, no CI.

## 10. Merge execution checklist (later phase — do not run now)

1. Preconditions: Confluence `v0.1.0` tagged and its release checklist done; export contract frozen
   (`EXP-01..10` green — executed 2026-11-13, see §6.5/§9); `solo-bench` phase explicitly approved by
   the user; clean worktree; `D:\05_Code\Confluence` present locally.
2. Back up the DSH profile layer (outside both repos). Do not touch `~/.dsh` otherwise.
3. `git remote add confluence D:\05_Code\Confluence`; fetch; `git subtree add … --squash` (§3).
4. Add the minimal `.gitignore` entries for the merge: `integrations/dsh-plugin-confluence/node_modules/`
   and, if the user's DSH workspace is `solo-bench` itself, `/.confluence/` (the export dir is
   gitignored by design/errata; the Confluence repo already ignores `.confluence/`). These are the only
   `solo-bench` file changes in phase 0 besides `go.mod`/commands in the approved consumer phase.
   No license file, no README rewrite.
5. Install the vendored plugin into a **scratch** DSH profile and run its E2E; only then, on the user's
   explicit request, wire the real profile row (§4).
6. Implement the Go consumer in a separate approved phase: `internal/confluenceexport` + CLI command +
   Go tests + fixtures; `go test ./...` must stay green; no network/no exec/DB changes.
7. Update `solo-bench/README.md` with a short "Confluence export" section linking into
   `integrations/dsh-plugin-confluence/docs/` and stating the offline/read-only boundary.
8. Commit with messages naming the Confluence tag/commit and the reviewed contract version; tag if the
   user wants a workbench release.
9. Rollback: revert the merge commit(s); remove the profile dependency/row if installed; restore the
   profile backup files; the export directory (if created inside the workspace) is untracked and can be
   deleted or ignored.

## 11. Risks and mitigations

| Risk | L | I | Mitigation |
|---|---|---|---|
| Subtree drift: local edits inside `integrations/` make future pulls conflict | M | M | Rule "no edits in the subtree"; fixes go upstream to Confluence; review diffs on every `subtree pull` |
| Export format changes break the future Go reader | L | M | Frozen `confluence.memories/v1`; additive-only; hash/byte/count checks; fixtures both sides |
| The workbench implicitly depends on DSH being installed/running | L | H | Consumer reads only `<workspace>/.confluence/export/`; no DSH paths, no IPC; tests run without DSH |
| Profile installation accidentally performed during merge verification | L | H | Scratch `DSH_HOME` first; real profile only on explicit user request; backups; documented rollback |
| License/contract concern from vendoring MIT code into a license-free workbench | L | L | Subtree retains its upstream `LICENSE`; no root license added; user confirm at merge (O2) |
| Export grows beyond a workbench-readable size | L | M | `maxEntriesPerWorkspace` 2000 + `EXPORT_MAX_BYTES` 8 MiB export cap + consumer size cap surfaced as a clear error |
| Users expect live sync from a file export | M | M | Docs state "export is an explicit snapshot; re-export to refresh"; `status` shows `generatedAt` |

## Open questions

1. **O1** Should the vendored subtree be the whole Confluence repository (docs included, proposed) or
   only a package subdirectory after restructuring upstream? Whole-repo is simpler today but carries
   design docs into the workbench; a split keeps `solo-bench` lean but changes the Confluence repo layout.
2. **O2** Keep `integrations/dsh-plugin-confluence/LICENSE` (upstream MIT, needed for a clean
   redistribution copy) while adding no root license to `solo-bench` — confirm this reading of
   "不加许可证文件".
3. **O3 (resolved by Lead ruling)** — entry/tombstone ids are `cnf_` / `tmb_` + 26-char ULID
   (`data-model.md` §2.2); export reuses board ids unchanged. Consumers treat ids as opaque.
4. **O4** Should a v1 consumer expose tombstone stubs in `list --include-deleted`, or hide removals
   entirely? Proposed: show stubs only with the explicit flag (contract exports them for removal history).
5. **O5** Is a `solo-bench confluence` command worth a separate phase, or should the workbench simply
   document "use the export with jq"? A command is small (≈1–2 ed) but touches the CLI contract and
   project-path rule; the user decides.
6. **O6** Where should the export live when the DSH workspace is the `solo-bench` repo itself — inside
   the repo (`.confluence/export/`, ignored) or outside via `export.dir`? Proposed: configurable,
   default outside tracked paths if the user dislikes untracked dirs.
