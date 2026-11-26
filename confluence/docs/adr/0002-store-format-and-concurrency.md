# ADR 0002 — Store format and concurrency: per-writer JSONL shards under profile storage

- Status: **Accepted** (design phase; implemented at M1, compaction/export at M4)
- Date: 2026-11-13
- Depends on: [ADR 0001 — Confluence architecture](0001-confluence-architecture.md) (§5 identity,
  §6 store/durability, §10 config, §13 export). This ADR records the storage decision that ADR 0001
  adopted in round 2; it does not restate the architecture.
- Detail: [`../design/store-format.md`](../design/store-format.md),
  [`../design/data-model.md`](../design/data-model.md)
- Target: DSH Desktop 0.2.2-rc.1, profile `desktop`, Windows 11. Fully offline.

## Context

The board must be written by several DSH windows/processes, read by all of them, be inspectable and
exportable by a future offline Go consumer (`solo-bench`), survive crashes without corrupting
existing memory, and never require a server, database, port or network. Verified constraints:
`storageDomain` change events are in-process only and a domain handle is a snapshot-at-open with no
cross-process lock (`dsh-storage-domain/README.md:146`, `dsh-storage-json/README.md:142-144`);
`writeFileAtomic` cannot append and does not `fsync` (`dsh-atomic-write/README.md:12,124`);
`fs.watch` is not a freshness guarantee on Windows. Details in
[`../research/dsh-internals.md`](../research/dsh-internals.md) §3 and round-2
([`../discussion/round-2.md`](../discussion/round-2.md) §2).

## Decision

1. **Location:** `$DSH_HOME/storages/confluence/v1/workspaces/<wsKey>/` — profile storage, never
   inside a repository by default (export is the only workspace file, and it is opt-in).
2. **Format:** append-only JSONL, one JSON record per line, UTF-8, no BOM, `\n`-terminated, ≤64 KiB.
   Each line carries schema version `v`, a type, the workspace key, a time-sortable ULID `seq` and
   an ISO timestamp (ADR 0001 §6; [`data-model.md`](../design/data-model.md)).
3. **Concurrency:** one writer per shard. `journal.<writerId>.v1.jsonl` per plugin mount
   (`writerId = <pid>-<8 lowercase hex>`), appended via an `O_APPEND` fd; no lock on the hot path.
   Readers merge all shards, sort by `seq`, dedupe by id (`entry` first-wins, `session` last-wins). A
   mount always mints a new writer id, so a crashed writer's shard is sealed and never appended to
   again.
4. **Durability:** batched fsync at ~1 s and at session events; board posts force an fsync before
   acknowledging. A process crash may lose the last ≤1 s of appends; an OS crash may lose appends
   since the last fsync. Torn trailing lines are ignored by readers and never repaired.
5. **Freshness:** 3–5 s polling (default 4 000 ms) is the correctness contract; `fs.watch` only
   lowers latency and degrades to polling on any error. On Windows, EBUSY/EPERM/EACCES retries are
   part of the read protocol, not an error path.
6. **Deletion:** tombstones are journal records (append-only, audited), applied at read time; no
   record is edited in place. Retention *hides* records at read time; only lease-protected M4
   compaction physically prunes.
7. **Locking:** the only cross-process lock is a native `fs.open(path,'wx')` lease with dead-pid/
   age takeover, used exclusively by compaction/export. No hard `@deepseek-ai/*` dependency; the
   shipped atomic-write package is an optional guarded accelerator only.
8. **Export:** a derived, deterministic, redacted `memories.v1.jsonl` plus the `manifest.json` commit
   marker (`{"schema":"confluence.memories/v1","formatVersion":1,...}`), written by an explicit user
   action into `<workspace>/.confluence/export/` (workspace-relative only, ADR 0001 §17 E3); never
   read back and never a second source of truth (ADR 0001 §13). The store's own
   `MANIFEST.v1.json` is a different file with a different purpose.

## Guarantees this decision commits to

- No lost posts from concurrent writers: a returned append is visible to every reader within two
  poll intervals.
- No corruption from crashes: at most the last second of one writer's appends is lost; a partial
  line is never exposed as data.
- Containment: a malformed line/file hides only itself; readers never throw, never write, never
  repair.
- Deterministic views: the same valid lines produce the same merged view and export on every
  reader, regardless of file order or timing.
- Offline and independent of upstream: plain files, Node builtins only, no schema owned by DSH,
  readable by any line-oriented tool.

The full contract and its conformance tests are in [`store-format.md`](../design/store-format.md)
§1 and §17.

## Alternatives rejected

1. **`storageDomain` board** (option A): in-process-only change events and a snapshot-at-open domain
   handle make cross-window readers silently stale; no cross-process write lock; `single` layout
   rewrites the whole unit per write; opaque to a future Go consumer. Kept only as an optional
   fallback for preferences (ADR 0001 §15.1).
2. **Single shared journal + `withFileLock` per append** (C draft): `writeFileAtomic` cannot append
   and does not fsync; a lock on every post puts lock-recovery edges (default 2 s wait, incomplete
   lock records) on the hot path. Per-writer shards remove the lost-post class entirely.
3. **Database / SQLite**: adds a dependency and a persistent database format for a small
   append-only log; FTS is disabled in this profile; SQLite writer semantics would need the same
   crash/torn-line analysis. Rejected for v1; the *session* log remains DSH's own store.
4. **Plugin records in the session log:** `Session.append` refuses unknown non-`ignorable` event
   types on reopen, and `appendPluginRecord` is reserved for DSH's experimental packages
   (practices.md:21). Session logs are not plugin storage.
5. **One mutable `board.json` per workspace:** rewrites the whole file per post, a crash loses the
   whole update, concurrent writers last-write-win, no merge story.
6. **Per-session watermark/board files** (C draft): single-writer is not guaranteed after a session
   migrates windows, and a brief-only watermark makes "unread" permanently stale. Replaced by the
   split, log-derived cursors (ADR 0001 §8.1).

## Consequences

Positive: cross-window correctness without a server or a hot-path lock; crash loss bounded and
documented instead of silent corruption; one format readable by the plugin, `solo-bench` and
`git diff`; deterministic export; the store is disposable (derived from deliberate posts), so a
delete-and-rebuild is always safe.

Negative / accepted risks: (a) compaction has a bounded prune race with a writer whose presence
heartbeat is >30 s stale (store-format §13.4) — accepted for M4, closed only by writer cooperation
if it ever bites; (b) freshness is poll-bound (≤4 s, watch usually faster); (c) up to ~1 s of
appends can be lost on a process crash (board posts are exempt: fsync before acknowledge); (d) old
shards accumulate until M4 compaction, bounded by the entry cap and retention; (e) polling costs
one `stat` per shard per 4 s per active workspace — negligible at the capped sizes.

Follow-ups: M0 verifies Windows fsync/rename/`process.kill(pid,0)`/`fs.watch` behaviour; M1
implements the append/merge/encoding conformance tests; M4 implements compaction, the lease and
export, and measures the store footprint. Revisit this ADR only if the multi-window topology
changes or a future DSH version ships a cross-process-safe storage primitive that also exports
plain files.

## Open questions

1. Whether compaction runs automatically (hourly maintenance tick) or only by explicit user action;
   the lease protocol supports either (M4 product decision).
2. Network-drive/OneDrive roots: polling remains correct but watch and rename semantics vary; warn
   and disable watching when `store.dir` is a UNC path (M0).
