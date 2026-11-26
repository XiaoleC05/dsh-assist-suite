# Confluence store format and concurrency contract (v1)

Status: design document, binding within the design set. It fixes the on-disk contract, durability
and freshness guarantees, reader/writer algorithms, the compaction/export lease, corruption
containment and the export schema. It implements ADR 0001 §6 and §10 (storage, durability,
freshness, export) and the record semantics in [`data-model.md`](data-model.md). Where ADR 0001
leaves a number open, the value chosen here is the same one used in `data-model.md` §6; the file is
marked **(chosen here)**.

Scope: `v1` directory layout. The M4 surface (compaction, export) is specified here so M1 can be
built against it, but it is implemented last. No server, no network, no child process, no database:
Node builtins (`node:fs`, `node:path`, `node:crypto`, `node:os`) only.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md),
> delta §2).** The file family and merge algorithm are unchanged, but new writes go to **one reserved
> global scope** `workspaces/ws_0000000000000000/` (label "All sessions"); the manifest's
> `workspace.canonicalPath` is empty **only** for that key. Legacy v0.1.0 per-workspace journals
> remain on disk byte-for-byte and are **merged read-only** into every view (`legacyWorkspaceMeta()`,
> `legacyView()`, `mergedRecords()`); there is no migration writer and no deletion. A legacy writer
> process from an older plugin version still appends to its own shard — harmless, merged on read. The
> export no longer lives inside a workspace: it defaults to
> `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/` and is written outside the store root. Where
> this document says "per workspace", "workspace directory" or `<wsKey>`, read "the global scope" for
> writes and "a legacy scope, read-only" for older data. Binding delta:
> [`../plan/scope-refactor-delta.md`](../plan/scope-refactor-delta.md).

> **v0.3 amendment — per-scope journals, per-scope view
> ([ADR 0008](../adr/0008-bus-and-profile.md),
> [binding contract](../plan/v0.3-interfaces.md) §2–§3.1).** The file family (`MANIFEST.v1.json`,
> per-writer `.v1.jsonl` shards, presence heartbeats) and the merge algorithm are unchanged, but views
> are now **per journal scope**: `viewedRecords(scopeKey)` folds exactly that journal,
> `refreshMerged(scopeKey)` / `onMergedChange(scopeKey, cb)` maintain one merged cache per scope, and
> the LRU keeps at most `store.maxOpenWorkspaces` (16) journals open (`closeWorkspace`). Workspace
> journals live under `workspaces/<wsKey>/` and hold `context`/`entry`/`message`; the global journal
> `workspaces/ws_0000000000000000/` holds `profile`/`profile-reset` plus the ledger `session` rows and
> presence heartbeats. The v0.2 global legacy merge into every view is **removed**: `legacyView()`
> becomes `legacyRecords()`, a cold read-only scan for tooling/export that is not on any read path.
> New record types must pass the store's shape/envelope validation; record caps stay enforced by the
> owning services. Nothing is migrated or rewritten by the upgrade; a v0.1 workspace directory is
> simply the v0.3 journal directory of that workspace.

> **v0.4 amendment — new record types in the global journal, per-key folds
> ([ADR 0009](../adr/0009-long-term-memory-persona-style.md),
> [binding contract](../plan/v0.4-interfaces.md) §1/§5).** The file family (manifest, per-writer
> `.v1.jsonl` shards, presence heartbeats) and the merge algorithm are unchanged. `pattern`, `style`
> and `memory-migration` records are appended to the existing **global** journal
> `workspaces/ws_0000000000000000/` next to `profile`/`profile-reset`, the ledger `session` rows and
> the presence heartbeats — no new directory and no new file kind. The services fold from the merged
> per-scope view: patterns per `key`, styles per `(channel,key)`, both last-write-wins on the greatest
> `seq` (status/enabled included), so an update is an append and never an in-place rewrite.
> `MemoryService.attach()` appends the one-time `memory-migration` marker (contract §5) and then never
> repeats it; the conversion is idempotent and best effort. Nothing is compacted, rewritten or deleted
> by the upgrade, and the portable `confluence.memory/v1` document is built from the folds at export
> time (it is not a store file). A reader that does not know the new record types simply ignores those
> lines, so a v0.4 journal remains readable by v0.3 with no repair.

## 1. Guarantees (the contract)

The store promises, and the conformance tests in §16 encode:

| Id | Guarantee |
|---|---|
| **G1** | **No lost posts under concurrency.** A record whose append call returned successfully is visible in every writer's merged view within `2 × POLL_MS` (≤8 s), unless hidden by retention or tombstoned. Per-writer shards remove the lost-update class entirely (ADR 0001 §15.3). |
| **G2** | **Bounded crash loss, never corruption.** A process crash may lose at most the appends of the last `FSYNC_INTERVAL_MS` (≤1 s) of that writer; an OS crash may lose at most appends since the last fsync. A crash can never expose a half-written line as data: readers ignore an unterminated tail. |
| **G3** | **Containment.** A malformed line, unparseable file or bad manifest can only hide itself; every other valid record stays readable and the plugin never throws from a read path. |
| **G4** | **Deterministic merge.** The effective view is a pure function of the set of valid lines: independent of shard enumeration order, of which process reads, and of read timing. |
| **G5** | **No cross-process lock on the hot path.** Appends take no lock; each shard has exactly one writer process instance. Locks are used only by compaction/export (§13). |
| **G6** | **Readers never write.** Read paths perform no writes to the store (no repair, no marker files); all non-journal files are written only under a lease, and only by M4 operations and presence heartbeats. |

Freshness is **poll-first**: `POLL_MS` (4000) polling is the correctness contract; `fs.watch` is a
latency optimization only (ADR 0001 §6). Presence is a heartbeat file, never a journal operation.

## 2. Root resolution

```text
$DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')       # ADR 0001 §6

storeDir = config.store.dir absolute path         # 1. used as-is (device/UNC/file rejected)
         | <DSH_HOME>/storages/confluence/<dir>    # 2. relative store.dir (e.g. "shared")
         | <DSH_HOME>/storages/confluence/v1       # 3. default (dir '')
```

Resolution order, path validation and fallback warnings are owned by [`config.md`](config.md) §2.1;
the store receives an already-resolved root and treats it as authoritative (`$DSH_HOME` is resolved
once at activation). The root is created lazily (`mkdir {recursive:true}`) on the first write. A
resolved root that is a file, device path or unwritable is rejected at activation with a warning; the
plugin then runs degraded (read-only if readable) rather than failing activation. `export.dir` is
workspace-relative only (config.md §2.8, ADR 0001 §17 E3); a rooted value is rejected (§14).

## 3. Directory tree

```text
$DSH_HOME/storages/confluence/v1/
  workspaces/
    ws_0000000000000000/                 # v0.2.0: THE global scope (reserved, never a real workspace key)
      MANIFEST.v1.json                   # written at first mount; label "All sessions"
      journal.<writerId>.v1.jsonl        # append-only shard, one writer per file
      snapshot.<gen>.v1.jsonl            # M4 only: compacted sorted records, gen >= 1
      presence/
        <writerId>.json                  # heartbeat file, replaced atomically
        .tmp-<writerId>.json             # transient during a replace; ignored by readers
    ws_<16hex>/                          # v0.1.0 legacy scopes: NEVER written or modified in v0.2.0,
      ...                                # only scanned and merged read-only (data-model §2.1)
  leases/                                # transient control files, M4; never data, never merged
    <wsKey>.compact.lock
    <wsKey>.export.lock
  .tmp/                                  # only transient temp files, always writer-suffixed and ignored by readers
```

The export never lives under the store root and (v0.2.0) never inside a workspace either: its default
root is `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/` (§14); `--out` may override it.

Rules:

- No other files are created. Readers **ignore every unknown file** (including `.tmp-*`,
  `*.jsonl.tmp-*`, editor droppings) — they are never merged, never deleted by readers.
- File and directory names are ASCII and case-sensitive by contract; on Windows NTFS
  case-insensitivity is tolerated because all generated names already use a single casing.
- `writerId = <pid>-<8 lowercase hex>` (data-model §2.5). A process appends only to the shard whose
  name contains its own writer id, and mints a new writer id per mount (ADR 0001 §6).
- Modes: files `0o600`, directories `0o700` on POSIX; mode is best-effort on Windows.
- The store is profile-local presentation-independent data, never inside a repository by default.
  In v0.2.0 the plugin creates no files inside any workspace at all (only the opt-in export, whose
  default root is under `$DSH_HOME`).

Naming regexes:

| Kind | Pattern |
|---|---|
| shard | `^journal\.([0-9]{1,10}-[0-9a-f]{8})\.v1\.jsonl$` |
| snapshot | `^snapshot\.([1-9][0-9]*)\.v1\.jsonl$` |
| manifest | `^MANIFEST\.v1\.json$` |
| presence | `^([0-9]{1,10}-[0-9a-f]{8})\.json$` |
| lease | `^(ws_[0-9a-f]{16})\.(compact|export)\.lock$` |
| workspace dir | `^ws_[0-9a-f]{16}$` |

## 4. Line encoding

Every shard and snapshot line is:

1. **One JSON object**, UTF-8, **no BOM**, terminated by exactly one `\n` (0x0A). `\r` is never
   emitted; readers strip a trailing `\r` defensively.
2. Serialized compactly (`JSON.stringify`), no trailing whitespace; field order is not significant
   but writers keep the data-model field order for human diffability.
3. ≤ `MAX_LINE_BYTES` = 65 536 bytes **including** the newline. Writers measure `Buffer.byteLength`
   after serialization and reject over-cap records before writing.
4. Appended as one complete line in one write call (§5). `JSON.stringify` cannot emit `NaN`/
   `Infinity` (they become `null`); writers must validate numeric fields themselves.
5. The file is opened in append mode only; a line is never modified or removed in place.
6. The body cap (`config.store.maxBodyBytes`, default 8 192, range 256–49 152) is enforced before
   serialization; the 64 KiB line cap remains the binding limit and a worst-case 49 152-byte body
   plus provenance/JSON overhead stays safely below it. This answers `config.md` open question 3:
   no stricter body ceiling is needed, but the line check always runs last.

Readers: decode as UTF-8 (replacement characters tolerated; the line then fails JSON parse and is
skipped), split on `\n`, ignore the final empty string, and treat a non-empty remainder as an
incomplete tail (§6).

## 5. Write path and durability policy

### 5.1 Writer lifecycle

- First append lazily: `mkdir -p workspaces/ws_0000000000000000/presence`, open
  `journal.<writerId>.v1.jsonl` with `fs.openSync(path, 'a')` (`O_APPEND`), keep the fd.
- All appends for the global scope go through the same fd, sequentially on the JS thread. Because the
  file is opened `O_APPEND`, each `fs.writeSync(fd, line)` is one append at the current EOF; a
  complete line is written by one call (≤64 KiB), so lines never interleave even if another writer
  somehow shared the name.
- A write of a complete line never happens before the record passed validation (`data-model.md`
  §8.1); failed validation costs no I/O.
- `writerId` is minted once per plugin mount; the same shard receives all appends from this process
  for this universal scope. On restart a new writer id starts a new shard.

Refinement of ADR 0001 §6 (`fs.appendFile`): a held `O_APPEND` fd + `fs.writeSync` is the same
append semantics, but it lets the plugin batch `fsync` (§5.2) and close the fd synchronously during
plugin deactivation (§7). Writes are small and rare (board posts, ≤1 ledger row per 5 s), so a
synchronous write is the safer trade (no unbounded promise queue, cleanup is deterministic). The
alternative (async `appendFile` per line) is rejected for v1; see ADR 0002.

### 5.2 Batched fsync (durability policy)

- After a successful write the shard is marked dirty.
- A 1 s scheduler calls `fs.fsyncSync(fd)` when dirty; a `turn/end` session event schedules an
  immediate flush (still off the event's synchronous path, `setImmediate`).
- **Board post durability:** `confluence_post`/`confluence_reply` force `fsyncSync` before returning
  success. Posts are rare, the fsync costs single-digit ms on local SSD, and a "recorded" answer the
  user can trust is worth more than the last-second loss ADR 0001 permits.
- Ledger rows (`session`) and tombstones are not force-flushed (batch policy applies).
- `fsync` failure (ENOSPC, EIO, EPERM) does not roll back the write (already in page cache); it
  marks the store `durability: degraded`, logs once per minute, and surfaces an activation warning.
  "Accepted but not yet synced" is honest and bounded by 1 s; persistent fsync failure is visible.
- No directory fsync is required for appends (the file already exists and is not renamed); where
  POSIX allows it, the first-create directory fsync is performed best-effort and failure ignored.

### 5.3 Write errors

| Error | Behavior |
|---|---|
| `EBUSY`/`EPERM`/`EACCES` (AV scanner, indexing, backup) | Retry the same write up to 3 times at 50/150/400 ms; then fail the call with `E_STORE_WRITE`. |
| `ENOSPC`/`EIO`/`EROFS` | No retry loop. Board tool throws `E_STORE_WRITE` with a one-line explanation; ledger/presence updates are dropped (logged, retried next tick); store is marked `read-only-degraded`. |
| `EDISPOSED` (after deactivation) | Throw; nothing is written after the plugin is disposed. |

Internal `E_*` codes are the writer's stable codes; model-facing spellings are owned by
[`tool-api.md`](tool-api.md) §4 and map 1:1 (`E_STORE_WRITE`→`STORE_UNAVAILABLE`,
`E_BOARD_FULL`→`BOARD_FULL`, `E_BODY_TOO_LARGE`→`BODY_TOO_LARGE`).

A write failure is never silent and never corrupts the shard: only complete lines are written, and a
failed `writeSync` is either fully absent or produces a torn tail that readers ignore (§6).

### 5.4 Ordering

Per writer: records are appended in the order they are created and `seq` is strictly increasing
(monotonic ULID), so within a shard `seq` order equals offset order. Across shards no order is
assumed; merge sorts (§8).

## 6. Torn-write and partial-line recovery

A crash (or a kill) can leave a final line without its `\n`, or with only part of the bytes. Readers
must never expose it and must keep reading later lines once they appear.

```text
parseShard(bytes):
  lines = split(bytes, b'\n')                 // last element = tail (no newline)
  complete = lines[0..-2]
  tail = last element
  for line in complete: yield parseRecord(line)   // failures are quarantined, not fatal
  if tail is non-empty: return {consumedBytes: len(bytes) - len(tail), tailBytes: len(tail)}
  return {consumedBytes: len(bytes)}
```

Rules:

- A non-empty tail is ignored and remembered by byte offset; the next refresh re-reads from
  `consumedBytes` (so if the writer later completes the line, it is parsed as one complete line).
  This matters only in tests/fixtures: in production the writer that created the torn tail has
  exited (new mount = new writer id = new shard), so the tail stays ignored forever.
- A tail longer than `MAX_LINE_BYTES` cannot become a valid line: search forward up to 1 MiB for the
  next `\n`, skip to it, log `E_PARTIAL_OVERSIZE` once, and continue with the following line. If no
  newline is found within 1 MiB, treat the rest of the file as unusable for this refresh (keep the
  valid prefix) and warn.
- Torn tails are never repaired, truncated or rewritten; the file stays append-only (G3).
- A complete line that fails JSON parse/schema validation is quarantined for the session (skipped,
  counted, logged once per file+line hash); it cannot affect other lines.

## 7. Concurrent-writer model

- **One writer per shard.** Shards are never shared; `writerId` includes the pid and 32 random bits.
  Collision (pid reuse + same random) is treated as impossible; if a mount finds an existing
  non-empty shard under its freshly minted id (fixture/restore edge), it mints a new id
  (`E_WRITER_ID_REUSED` warning) rather than appending across generations.
- **Readers merge all shards.** No reader ever writes. There is no redo, no WAL, no lock.
- **Append vs prune.** Only M4 compaction removes shards, under the lease in §13, and only after the
  shard's coverage is sealed in a snapshot. The residual race is documented in §13.4.
- **Presence is separate.** Heartbeats are `presence/<writerId>.json` files (atomic replace), not
  journal lines: they must not churn the journal or the merged order (ADR 0001 §6).

## 8. Merge algorithm

The reader keeps one `WorkspaceMirror` per active workspace. State: per-file `{size, mtimeMs,
consumedBytes}`, a `Map<id, record>` fold, a lazily sorted `seq` index, tombstone set, and a
`viewToken` hash of the visible view (used to suppress no-op pulse changes).

```text
refresh():
  entries = readdir(workspaces/<wsKey>)
  shards  = entries matching shard regex          (cap: newest 64 by mtime; more -> warn)
  snapshots = entries matching snapshot regex
  manifest = read + validate MANIFEST.v1.json     (optional; invalid => ignore)
  if manifest.snapshot && manifest.generation > loadedGeneration:
      load snapshot.<gen>.v1.jsonl first; set snapshotWatermark = manifest.snapshot.watermark
  for file in snapshots + shards:
      st = statWithRetry(file)
      if st missing: mark deleted (pruned) and force rebuild
      if known && st.size == known.size && st.mtimeMs == known.mtimeMs: continue
      if known && st.size < known.size: force full rebuild
      bytes = readWithRetry(file, known ? known.consumedBytes : 0)
      fold parsed append-only lines into state (skip lines with seq <= snapshotWatermark for shards)
  if rebuilt or any fold changed: rebuild seq index, tombstone set, view; update viewToken
  presence = readPresence(wsKey)                  // §9
  return {changed, view, presence}
```

Fold rules are exactly [`data-model.md`](data-model.md) §7.1: after the global `seq` sort, `entry`
first-wins by id, `session` last-wins by id, `tombstone` accumulates by target id, unknown/
unsupported types ignored. Duplicate identical lines (crash-retried appends) are absorbed by the
same rules.

Sorting: `seq` strings compare lexicographically (ULIDs are fixed-width ASCII); tie-break by `id`
then `type`. The reader never trusts directory enumeration order (G4).

Costs: full load is bounded by the workspace cap (≤ `maxEntriesPerWorkspace` = 2 000 entries +
≤200 session rows + tombstones, well under ~20 MB); steady-state refresh is `stat` on ≤64 shards plus
a tail read. This is why the cap on visible entries exists (§12).

## 9. Poll and watch (freshness)

The freshness contract is **polling**; watching only lowers latency.

```text
activateWorkspace(wsKey):
  refresh(force)                         // warm start
  pollTimer = every POLL_MS: refresh()
  try: watcher = fs.watch(workspaceDir, {persistent: false}, onEvent)
  catch: watcher = none; log once; poll-only

onEvent():                               // duplicate, coalesced, rename events are all expected
  if debounceTimer exists: return
  debounceTimer = after WATCH_DEBOUNCE_MS: clear; refresh()

onRefreshFailure(e):
  consecutiveFailures++; log rate-limited
  if consecutiveFailures >= 3: pollInterval = min(POLL_MS * 2^k, 30_000)  // backoff, cap 30 s
  on success: reset interval to POLL_MS, consecutiveFailures = 0
```

- `fs.watch` is created on the **workspace directory** (not recursive); it exists only to wake the
  poll sooner. A missing event (AV rename, network drive, directory moved) degrades to `POLL_MS`,
  never to staleness beyond it (ADR 0001 §6).
- Watching is started only for workspaces that have a live session in this process (lazy, bounded by
  the number of windows).
- Windows reality: `fs.watch` may throw (`ENOSPC` inotify-equivalents, `EPERM` on virtual folders) —
  wrapped in `try/catch`, failure is logged once and the watcher disabled; rename-over/duplicate
  events are tolerated; no assumption is made that a change produces exactly one event.
- Every refresh recomputes the view hash; a change fires `onChange(wsKey)` at most once per refresh.

### 9.1 Windows retry policy for reads

| Failure | Detection | Action |
|---|---|---|
| `EBUSY` on `open`/`read`/`stat` | file locked by AV/indexer/rename | retry 3× at 50/150/400 ms, then skip this file for this refresh (keep last state) |
| `EPERM`/`EACCES` | permissions, AV, still-writing | retry 3×; then skip file, warn once per file per hour |
| `ENOENT` on `stat` | shard pruned/deleted by compaction | drop the file from state; force a full rebuild next refresh |
| `ENOENT` on `read` | race with delete | treat as pruned; continue |
| `EMFILE`/`ENFILE` | fd exhaustion | close idle handles, retry next tick; poll backs off |
| `EIO`/`ENOSPC` on read | disk problem | skip file, warn; never throw out of the refresh |

Retries never block the event loop long: total worst-case added latency is ~600 ms, well under the
poll interval; the refresh is skipped if a previous one is still running (single-flight guard).

## 10. Presence protocol

- Each plugin instance maintains one heartbeat file for the universal shared-memory scope (not one per
  workspace): `presence/<writerId>.json` under `workspaces/ws_0000000000000000/` (schema in
  data-model §4.6).
- Cadence: on every `turn/end` and at least every `PRESENCE_HEARTBEAT_MS` (10 s) while active.
  Content: writer id, pid, plugin version, `updatedAt`, sorted session ids. Never titles, bodies,
  file paths or prompts.
- Atomic replace: write `presence/.tmp-<writerId>.json` then `fs.renameSync` over the target
  (retry on `EPERM`/`EBUSY`; fall back to a single in-place `writeFileSync` — readers tolerate a
  torn JSON file by ignoring it for that refresh). No leasing: a file has exactly one writer
  (the same rule as shards).
- On deactivation: `fs.unlinkSync` the file, ignoring errors.
- Any mount may delete presence files whose `updatedAt` is older than `PRESENCE_TTL_MS` (10 min)
  during its own startup — best-effort, errors ignored, never deleting a file modified after its
  `stat`.
- Reader: files whose `updatedAt` is older than `PRESENCE_STALE_MS` (30 s) are ignored; malformed
  files are ignored; missing `presence/` is an empty presence set. Presence never participates in
  merge order, retention or export.

## 11. Tombstones

- Tombstones are ordinary journal records (`data-model.md` §4.3) and therefore merge like any other
  record; they are not a separate file.
- At read time the tombstone set hides its target and the target's thread (cascade,
  `data-model.md` §5.1). A direct reference returns a `deleted` stub without content.
- Tombstones are retained for audit; they are never removed while their target's workspace exists.
  They are excluded from normal queries. The export never leaks a deleted note: a tombstoned entry
  appears only as a content-free stub (`deleted:true`, `deletedAt`, id/wsKey/seq/ts/kind/author id)
  so the workbench can show removal history without recovering the removed text (§14).
- A tombstone is idempotent and append-only; there is no undelete. Deleting more entries of the same
  thread is allowed and cheap (each is one line).
- If the memory mirror tracks more than `MAX_TOMBSTONES_TRACKED` = 4 096 tombstones, it stops
  adding new ids to the fast set and marks `tombstones: scanMode`; reads then keep the full picture
  only after the next full reload (bounded by the workspace cap). This is a degraded-mode guard, not
  an expected path.

## 12. Retention and caps enforcement

| Rule | Writer (append) | Reader (query) | Compaction (M4) |
|---|---|---|---|
| Entry count ≤ `config.store.maxEntriesPerWorkspace` (default 2 000) | count from mirror; at the cap → reject `BOARD_FULL`, no line appended | renders visible set only | prunes oldest beyond the cap |
| Retention 90 days | not enforced | hides older entries/session rows from board/search/pulse/export; `confluence_read` by exact id still resolves | deletes pruned records |
| Session rows ≤200 | not enforced | only 200 newest considered | prunes older |
| Tombstones | capped by workspace growth | full set | retained |
| Presence files | one per writer | stale >30 s ignored | TTL cleanup only |
| Shards ≤64 per refresh | one per writer | newest 64 by mtime, warn | merges all into one snapshot |
| Line ≤64 KiB | reject | skip/clamp | skip |
| `EXPORT_MAX_BYTES` 8 MiB | — | — | export refuses/warns and sets `limits.truncated` |

Retention hides, never mutates (invariant I17): the raw shards keep the records until M4 compaction
prunes them, which is why a user can always see the true history via direct file inspection. The cap
is enforced at append because an unbounded "warn only" board is a silent resource leak: at
`maxEntriesPerWorkspace` the next post fails with `BOARD_FULL` and the tool tells the user what to do
(tombstone stale notes via the M4 user action, raise the cap, or run compaction).

## 13. Lease protocol (M4 compaction and export only)

The only cross-process lock in the design. It exists for operations that write files shared by all
readers (`snapshot.*`, `MANIFEST.v1.json`); the hot path never waits for it.

### 13.1 Acquire

```text
acquire(wsKey, op):
  path = store/leases/<wsKey>.<op>.lock
  for attempt in 1..3:
    try:
      fd = fs.openSync(path, 'wx', 0o600)      // exclusive create
      token = uuid()
      write  {pid, token, startedAt, writerId, op}
      close(fd); return {path, token}
    catch EEXIST:
      body = readJsonWithRetry(path)
      if body && pidAlive(body.pid) && age(body.startedAt) < LEASE_STALE_MS: return null  // busy
      // stale: dead pid or too old -> take over
      try unlink(path); catch ENOENT: pass
      continue
  return null
release(lease):  // only if the on-disk token still equals ours
  body = readJsonWithRetry(lease.path)
  if body && body.token == lease.token: unlink(path)
```

- `pidAlive(pid)`: `process.kill(pid, 0)` — success → alive; `ESRCH` → dead; `EPERM` → alive (another
  user/process). `HYPOTHESIS:` Node's `process.kill(pid, 0)` on Windows reports existence for
  processes of the same user; verify in M0. A dead pid or `LEASE_STALE_MS` (120 s) age makes the
  lease stale.
- The lock file content is a housekeeping record, never data. Missing/invalid body → treated as
  stale (takeover) only after one retry.
- Hold time is bounded: compaction and export each target <5 s for a capped workspace; if a step
  exceeds 60 s the worker aborts and releases, leaving temp files that readers ignore.

### 13.2 Compaction steps (M4)

1. `acquire(wsKey, 'compact')`; if busy, skip this round (retry on the next explicit command or the
   next hourly maintenance tick; never block a user action on it).
2. `flush(true)` the local shard, then merge all shards + the current snapshot (§8) into the full
   record set; apply retention/caps from §12; keep unknown fields verbatim.
3. Derive `newGen = currentGen + 1`, `watermark = max(seq)` of the merged set, `createdAt`.
4. Write `snapshot.<newGen>.v1.jsonl.tmp-<writerId>` containing records sorted by `seq` (one JSON
   object per line, same encoding), `fsync` it, then `rename` to `snapshot.<newGen>.v1.jsonl`.
5. Write `MANIFEST.v1.json.tmp-<writerId>` (generation = newGen, snapshot = {gen, file, watermark,
   bytes, sha256}, workspace block preserved, shard list = stat snapshot at publish time),
   `fsync`, `rename` over `MANIFEST.v1.json` (atomic publish — readers see old or new, never half).
6. Prune shards: for each shard in the published list, re-`stat` it; delete it only if (a) its
   current size and mtime still equal the published values, (b) its last record seq ≤ watermark, and
   (c) its writer's presence heartbeat is stale (>30 s) or absent. Writers created after the
   snapshot are not in the list and are never touched. A writer that is actively appending is
   therefore retained until a later generation.
7. `release(lease)`; ignore temp files (a later compaction overwrites/cleans them).

Residual prune race: specified and accepted in §13.4.

### 13.3 Export steps (M4)

1. `acquire(wsKey, 'export')`; if busy, return a "busy, try again" result to the user command.
   v0.2.0 acquires on the global scope key.
2. Merge (not compact; export never writes into the store) + filter: visible entries (tombstoned ones
   become content-free `deleted` stubs), retention window, redacted title/body/tags, relative file
   hints, `origin`/author provenance, derived `status`.
3. Sort by `(seq, id)`; build `memories.v1.jsonl` in memory; refuse (or set `limits.truncated`) if
   > `EXPORT_MAX_BYTES` (8 MiB).
4. Resolve the output directory: default `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`, or the
   explicit `--out` value; reject a target inside the store root and refuse to overwrite an unrelated
   non-empty directory. `mkdir -p`.
5. Write `memories.v1.jsonl.tmp-<writerId>`, `fsync`, `rename` over `memories.v1.jsonl`; build
   `manifest.json` with the schema, file hash/bytes/counts/seq range, then write
   `manifest.json.tmp-<writerId>`, `fsync`, `rename` over `manifest.json` **last** (the manifest is
   the commit marker: an interrupted export is detectable).
6. `release(lease)`. Export is never read back and never merged into the store (ADR 0001 §13).

### 13.4 Residual prune race (accepted)

A foreign or crashed writer could append between the last `stat` of a shard and its `unlink`
(§13.2 step 6). Mitigation: only shards whose writer has no fresh presence heartbeat (>30 s) and
whose size/mtime/last-record-seq still match the published snapshot are pruned; a live writer's
shard is retained until a later generation. The window is one syscall on an idle shard, and the
loss would be a record whose writer had been silent for over 30 s. Accepted and recorded as the
compaction risk; conformance test §17.27 simulates it (append after publish → record survives).

## 14. Export contract: `memories.v1.jsonl` + `manifest.json` (`confluence.memories/v1`)

The export is the only contract `solo-bench` is expected to consume (ADR 0001 §13). Final naming is
the Lead ruling on plan deviation (b): the export is `memories.v1.jsonl` plus `manifest.json` with
`{"schema":"confluence.memories/v1","formatVersion":1,...}`. The store's own `MANIFEST.v1.json` (§15)
is a different file with a different purpose. **v0.2.0:** the export is global — the manifest adds
`scope:"global"`, reports the reserved global `wsKey`, and every record uses that key; the optional
additive `origin:{workspaceKey?, workspaceLabel?}` carries provenance (unknown fields are ignored by
v1 consumers). Default output: `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`; `--out` may
override it. Everything stays inside the profile.

```text
$DSH_HOME/storages/confluence-exports/<UTC-stamp>/   # default; --out may override
  memories.v1.jsonl                  # one record per line, UTF-8, LF, ≤64 KiB per line
  manifest.json                      # commit marker: written last, atomically
```

`manifest.json`:

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

`memories.v1.jsonl` — one JSON object per line, sorted ascending by `(seq, id)`; each line carries
`"v":1` and `"schema":"confluence.memories/v1"` (the manifest is the version authority); unknown
fields are additive and ignored by readers; repeated exports of an unchanged store are byte-identical
except for the manifest `generatedAt`/`files[].sha256`:

```json
{"v":1,"schema":"confluence.memories/v1","type":"entry","id":"cnf_01JBQ8Z4K1H9T2R6N4X7C0W8FD","wsKey":"ws_0000000000000000","seq":"01JBQ8Z4K2V7R3N5T6X1Y8M0PQ","ts":"2026-11-16T02:41:07.512Z","kind":"gotcha","title":"Windows rename retries wrap in EPERM","body":"spawnSync rename throws EPERM when a scanner holds the handle.","tags":["windows","fs"],"files":["src/fs/rename.ts"],"author":{"sessionId":"session-23da4b81-7f0e-4c2a-9d55-1e8f0a6b7c91","title":"Auth work","origin":"agent"},"origin":{"workspaceKey":"ws_3f9a1c7e2b4d8061","workspaceLabel":"solo-bench"},"replyTo":null,"resolves":null,"supersedes":null,"deleted":false,"deletedAt":null}
```

Mapping from stored records to export records:

- `entry` → one export record: board id unchanged (`cnf_…`, data-model §2.2), `wsKey` = the **global**
  constant for every record, `origin` = optional additive provenance `{workspaceKey?, workspaceLabel?}`
  (labels are basenames, never paths; unknown fields are ignored by v1 consumers);
  stored ISO `ts` → RFC 3339 `ts`; flat `sessionId`/`sessionTitle`/`origin` → the `author` object;
  `resolves:true` (boolean, stored per data-model §4.1) → `resolves: <replyTo id>` (the entry it
  resolves); `resolves:false` → `resolves: null`; absent `replyTo`/`supersedes` → `null`.
- A tombstoned entry → content-free stub: `deleted:true`, `deletedAt`, `title:""`, `body:""`, no
  `tags`/`files`, `author` reduced to `{sessionId, origin}`. The hit is not recoverable and the
  workbench can show removal history. The stub line is part of the file and of
  `files[0].bytes`/`sha256`, but **excluded** from `recordCount`/`firstSeq`/`lastSeq` (integrity
  contract below). A tombstoned thread root's replies are not exported.
- Only `entry` records are exported in v1: no ledger rows, no presence, no store metadata, no
  prompts, no assistant/tool text, no absolute paths. The redaction/allow-list pass runs again on
  export (`data-model.md` §8.3).

Determinism/atomicity rules: `generatedAt` is the only non-deterministic manifest field;
`memories.v1.jsonl` is written temp+fsync+rename, then `manifest.json` temp+fsync+rename **last**;
`limits.truncated` is `true` iff a cap prevented a complete export; `redaction.applied` is a marker,
never a guarantee of safety. The plugin never reads the export back. Within `confluence.memories/v1`,
additive optional fields only; a breaking change bumps `formatVersion` and the file names
(`memories.v2.jsonl`, `manifest.json` with `formatVersion:2`).

**Export integrity contract (V7 resolution — canonical, one reading only).**

- `recordCount` = number of **live (non-stub)** entry records in `memories.v1.jsonl`.
- `firstSeq`/`lastSeq` = min/max `seq` among those live records only (`null` when the live set is
  empty).
- `files[0].bytes` and `files[0].sha256` cover the **complete file, including tombstone stubs**.
- Consumer verification order: (1) validate `schema`/`formatVersion`; (2) verify `files[0]` size and
  SHA-256 over the whole file; (3) parse every line (stub lines are valid records with
  `deleted:true`); (4) check that the non-stub line count equals `recordCount` and that the live-set
  `seq` range equals `firstSeq`/`lastSeq`. A mismatch invalidates the export.
- A naive `line count == recordCount` check is **wrong by design**; tombstone stubs are valid file
  content but are not counted or sequenced in the manifest. A tombstone-free export has
  `recordCount == line count`, which is the only case where the naive check happens to pass.

## 15. Manifest `MANIFEST.v1.json` (store metadata, not export)

This is the store's internal workspace manifest, distinct from the export commit marker
`manifest.json` in the workspace (§14).

```json
{
  "format": "confluence.store/v1",
  "formatVersion": 1,
  "ws": "ws_3f9a1c7e2b4d8061",
  "workspace": { "key": "ws_3f9a1c7e2b4d8061", "canonicalPath": "D:\\05_Code\\solo-bench",
                 "createdAt": "2026-11-13T02:16:51.000Z" },
  "generation": 0,
  "snapshot": null,
  "shards": [ { "writerId": "24188-9f3ac210", "file": "journal.24188-9f3ac210.v1.jsonl",
                "seqMax": "01JBQ8Z4K6D3E1G4J8F5X9Q7S2", "bytes": 4201 } ],
  "seqRange": { "min": "01JBQ8Z4K2V7R3N5T6X1Y8M0PQ", "max": "01JBQ8Z4K6D3E1G4J8F5X9Q7S2" },
  "updatedAt": "2026-11-13T03:10:00.000Z"
}
```

- Written lazily at first mount by the first writer (exclusive create `wx`); if it exists, the
  existing workspace block wins. Created with a ready-to-use single write; a torn creation is
  tolerated (readers ignore an invalid manifest and fall back to the directory scan).
- Compaction (M4) rewrites it atomically preserving `workspace` (and `createdAt`) and bumping
  `generation`/`snapshot`/`shards`/`seqRange`/`updatedAt`.
- `shards` and `seqRange` are **advisory**: the authoritative shard set is the directory listing.
  Readers must not fail when the list is stale.
- A manifest with a different `ws`, or `formatVersion` > 1, is ignored for v1 reads (shards still
  read); when both exist, the directory's `wsKey` is authoritative over the manifest.
- A corrupt/absent manifest is a normal degraded state, not an error (G3).

## 16. Corruption containment

| Symptom | Detection | Containment | Visible effect |
|---|---|---|---|
| Malformed JSON line | parse error | skip line, count, log once | one note missing; other notes intact |
| Line >64 KiB | byte length | skip line, log | that record hidden |
| Torn tail (no `\n`) | parse remainder | ignore tail, remember offset; never repair | at most last record of a crashed writer hidden |
| Invalid `ws` in line | envelope check | skip line | record cannot leak into another workspace |
| Unknown `v` (e.g. 2) | envelope check | skip line (unsupported count) | future data ignored by v1 |
| Unknown record type | type check | skip (ignored) | reserved v2 data ignored |
| Duplicate id, differing content | fold compare | first-wins (entry) / max-seq (session), log | deterministic view, no crash |
| Unreadable shard (EACCES/EBUSY) | open/read retry | retry then skip this refresh; keep last state | temporarily stale board; never blocked UI |
| Shard size shrank | stat | full reload (compaction/prune) | no duplication; view rebuilt |
| Invalid manifest | parse/validate | ignore manifest; read shards; degrade to no publish metadata | reads unaffected; `generation` lost |
| Invalid snapshot | parse/validate | ignore snapshot; fall back to shards | reads unaffected (slower) |
| Invalid presence file | parse | ignore file this refresh | peer count under-reported |
| Store root wrong/unwritable | activation probe | degraded mode: read-only or in-memory; warning | tools error with one line; pulse from memory only |
| Disk full / EIO | write/fsync error | board write fails loudly (`E_STORE_WRITE`); ledger/presence drop | "could not record" surfaced; no silent loss claim |
| Clock jumped backwards | monotonic ULID factory | seq stays monotonic per writer; `ts` may look older | order still seq-based; retention may delay hiding |
| wsKey collision (same key, different path) | resolver cache: manifest workspace.canonicalPath mismatch | refuse to mount that workspace (`E_WS_COLLISION`) | tools return clear error; no cross-path leakage |
| Foreign temp files (`.tmp-*`) | filename filter | never merged, never deleted by readers | none |
| More shards than `MAX_SHARDS_READ` | count | newest 64 merged, warn; prompt compaction | older notes temporarily hidden (warn surfaced) |

Every row above must be covered by a test in §17 or an M0 spike; none may throw out of a tool, the
pulse, or the panel refresh path.

## 17. Conformance tests

An implementation can encode these against `node --test` with a temp `DSH_HOME`. "Two-writer"
tests may use `node:child_process` **in tests only** (the production bundle has no child_process
import; the no-egress/static test below enforces that).

**Encoding and caps**

1. `encodeLine` produces UTF-8 without BOM, exactly one `\n` at the end, one JSON object; split
   twice yields identical objects.
2. A record whose line exceeds 65 536 bytes is rejected (`E_LINE_TOO_LARGE`), nothing is written.
3. Caps: title >160 chars, body >8 192 bytes, 9 tags, 32+-char tag, 9 files, absolute path,
   `..` path, drive-letter path — each rejected with a stable code; 65 535-byte line accepted.
4. `seq` is 26 chars of Crockford base32; with an injected clock, 1 000 calls produce strictly
   increasing strings; two writers in the same injected millisecond still produce a deterministic
   global order after merge.

**Append and merge**

5. Append 3 records → a fresh reader sees exactly those 3, in `seq` order.
6. Two-writer byte-level simulation: two real appender processes each append 100 records to their
   own shard in the same universal scope (fixture clock/random make the bytes predictable). Assert on
   bytes: every shard file consists only of complete `\n`-terminated lines; no line is ever split or
   interleaved with another writer's bytes (per-writer file + one write per complete line makes
   intra-line interleaving impossible by construction); and the merged view equals the 200-record
   `seq` sort. A second variant appends a torn final line per writer (§12) to prove the merge
   tolerates it without byte repair.
7. Same `entry` id written by two shards with different titles → view equals first‑by‑`seq`
   deterministically regardless of file visit order (test both orders).
8. Same `session` id written 3× across shards → last-wins row equals max-`seq` row.
9. Identical duplicate line appended twice (retry simulation) → view unchanged.
10. Tombstone hides its entry at read (`confluence_board`/search/pulse views), cascades to the reply,
    a direct read returns a content-free deleted stub, and the export contains only a `deleted` stub
    without title/body/tags/files.
11. Unknown type line (`signal`) and unknown field are ignored; a v:2 line is skipped; valid lines
    around them still fold.

**Crash and torn writes**

12. Simulate a crash after writing a partial line (write 40 bytes of a 120-byte line, no `\n`) →
    reader ignores the tail; a second, complete line appended later parses; both complete lines
    intact.
13. Partial tail >64 KiB followed by a complete line → reader skips the garbage, parses the complete
    line, logs `E_PARTIAL_OVERSIZE` once.
14. Crash before fsync (kill after `write` returns, before flush) → reopened store loses at most the
    last record; every earlier record is readable; no partially visible record.
15. Malformed JSON line between two valid lines → exactly one record skipped, quarantine counted,
    no throw.
16. Read-only shard (POSIX chmod / Windows ACL fixture in a test temp dir) → refresh skips it,
    reader serves the rest, error rate-limited, no unhandled rejection.

**Freshness**

17. Writer appends; a reader with `POLL_MS=4000` sees the record within `POLL_MS + 500 ms` (real
    timers, generous bound) and the mirror fires exactly one change callback.
18. Watch path: N rapid appends inside the debounce window produce one debounced refresh and one
    change event; duplicate/coalesced events do not break the view.
19. `fs.watch` throwing is caught; polling still delivers the record; only one warning is logged.
20. Injected `EBUSY` on the first two `stat`/`open` calls then success → refresh succeeds on retry
    and never surfaces an error.

**Presence, retention, caps**

21. Heartbeat written at turn end; stale (>30 s) file not counted as a peer; TTL cleanup removes a
    10-minute-old file; malformed heartbeat ignored.
22. Entry older than 90 days is hidden from board/search/pulse/export but its raw line is still on
    disk and `confluence_read` by exact id still resolves it; session rows keep only the newest 200.
23. Entry count: at `config.store.maxEntriesPerWorkspace` (default 2 000) the next `post`/`reply`
    fails `BOARD_FULL` with no line appended. Tombstoning entries reduces the *visible* count (they
    are omitted from views), so a post succeeds once the visible count is below the cap.

**Leases, compaction, export**

24. Two contenders acquire the same lease → exactly one wins; releasing lets the second in; a stale
    pid is taken over; a live pid blocks; a deleted lock is not mistaken for ownership.
25. Compaction writes snapshot + manifest atomically (manifest old or new, never partial), readers
    merging snapshot+shards see each record exactly once (by id/seq), and a shard written after the
    snapshot is not pruned.
26. Compaction kill between snapshot rename and manifest rename → old manifest points at old state;
    reader still correct from shards; next compaction cleans up.
27. Prune safety: a shard whose size changed after the published snapshot is not deleted (simulated
    append after publish) — record survives.
28. Export integrity with tombstones (V7): build a store with N live entries and ≥1 tombstoned
    entry → `memories.v1.jsonl` contains N live lines plus content-free stubs; `recordCount == N`;
    `firstSeq`/`lastSeq` span only the N live records; `files[0].bytes`/`sha256` hash the **complete**
    file (stubs included); the §14 verify-then-parse-then-count procedure accepts the export, while a
    naive `line count == recordCount` check would reject it — the test asserts the procedure, never
    the naive check. Also: export twice over an unchanged store → identical bytes; `manifest.json`
    differs only in `generatedAt`/`files[0].sha256`; ordering `(seq,id)`; paths workspace-relative;
    field allow-list holds.
29. Export writes only outside the store root (default
    `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`; v0.2.0 no longer writes into a workspace),
    refuses to write inside the store root, and never writes partial files (temp+rename verified; a
    kill between the two renames leaves no new manifest or a mismatched one, both detectable). The
    manifest carries `scope:"global"` and the global `wsKey`; records may carry additive `origin`.
30. Store `MANIFEST.v1.json` missing/corrupt → reader works from shards; invalid snapshot ignored;
    `generation` treated as unknown. The export `manifest.json` is a different file (§14).

**Contracts and statics**

31. Journal field allow-list: every emitted record's keys ⊆ data-model §8.3 allow-list; no value
    resembles prompt/assistant/tool output; absolute paths only in the two named fields.
32. No network/child-process/model modules in the production bundle (`import` scan of `index.js`,
    `lib/**`, `client.js`): no `node:http(s)`, `node:net`, `node:dgram`, `node:child_process`,
    `fetch`, `WebSocket`, `node:worker_threads`; `@deepseek-ai/*` imports only inside guarded
    dynamic `import()` blocks.
33. Pulse provider purity: stub the injected `fs` to throw on any call and call the provider — it
    returns a string and throws nothing (the provider never touches the store).
34. Determinism: same fixture store, two readers started independently and reading shards in
    shuffled order produce byte-identical effective views and byte-identical pulse text.
35. Restart: writer A appends, process restarts, writer B appends → fresh reader sees both; new
    writer id, new shard, no appends to the old shard.
36. Workspace isolation: two `wsKey` directories with the same entry titles → every read surface is
    scoped to the caller's key; an entry from the other workspace never appears (including through
    recall refs).
37. Ids: an entry id is `cnf_` + 26-char ULID, a tombstone id is `tmb_` + ULID; `replyTo`/`supersedes`
    point at ids in the same shared-memory scope (the whole profile in v0.2.0); a duplicate id is
    deterministic (first-wins).
38. Cursor tolerance: `through=` (empty) is ignored; `through=<26-char ULID>` folds to
    `boardReadSeq`; the empty-board sentinel `seq="0"` marks the session welcomed without unread
    entries; `New:`/`unread` equal visible entries with `seq > boardReadSeq`.
39. Export-schema fixture test: `manifest.json` carries `schema:"confluence.memories/v1"` and
    `formatVersion:1`; every `memories.v1.jsonl` line carries `v:1` + `schema:"confluence.memories/v1"`,
    the optional-null field set, `cnf_` board ids, `author` provenance, and no absolute paths —
    validated against the consumer rules for `confluence.memories/v1`. The fixture includes one
    tombstone stub and asserts the V7 split: `recordCount` counts only non-stub records, while
    `files[0].bytes`/`sha256` cover the whole file including the stub.
40. V7 regression guard: an export with at least one tombstone stub fails a bare
    `line count == recordCount` assertion and passes the §14 verify→parse→count procedure; a future
    edit that redefines `recordCount` to line count, or hashes only live lines, fails this test.

## 18. Open questions

1. **`process.kill(pid, 0)` on Windows** is a `HYPOTHESIS:` for cross-user/AV edge cases; M0 must
   confirm and, if unreliable, fall back to a heartbeat field inside the lease (timestamp age only).
2. **Compaction prune race** (§13.4) is bounded but not closed. A design that closes it fully needs
   writer cooperation (writers check the lease before appending), which trades hot-path latency for
   safety; v1 keeps the simple rule and documents the residual.
3. **Network drives / OneDrive roots** are out of scope for correctness (polling still works, but
   `fs.watch` and atomic rename semantics vary). If `store.dir` resolves to a UNC path, activation
   should warn and disable watching; M0 spike.
4. **`fsync` on Windows** (`fs.fsyncSync`) semantics for appended data are file-system dependent;
   the policy is stated per contract (G2), and the M0 spike records measured behaviour on NTFS.
