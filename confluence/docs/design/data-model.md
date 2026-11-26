# Confluence data model (v1)

Status: design document for milestone M1/M2, binding within the design set. It defines the record
types, fields, identifiers, enums, caps, ordering rules and invariants shared by
[`architecture.md`](architecture.md) and [`store-format.md`](store-format.md). It implements the
decision in [`../adr/0001-confluence-architecture.md`](../adr/0001-confluence-architecture.md)
(§5 workspace identity, §6 store format, §9 ledger); it does not re-open that decision.

Where ADR 0001 leaves a number open, this document chooses a conservative value and marks it
**(chosen here)**. The same value is used in the other two design documents. User-facing defaults
(and their config keys) are owned by [`config.md`](config.md); the constants below are the
underlying values those defaults lower to.

Record lines are appended to per-writer JSONL shards; the file-level contract, encoding, durability
and merge algorithm are in [`store-format.md`](store-format.md). Everything here is about *what* a
line means.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md)).**
> Records are written to **one global scope** (`ws_0000000000000000`, label "All sessions"); the `ws`
> envelope field carries that constant for new records, while legacy v0.1.0 records keep their
> original per-workspace key and are merged read-only. Workspace data becomes provenance: an entry or
> `session` row may carry a top-level
> `origin: { workspaceKey?, workspaceLabel? }` object (labels are basenames only; never absolute
> paths) — distinct from the pre-existing `author.origin` / `record.origin` enum (`agent`/`user`).
> `MAX_LEDGER_SESSIONS` is fed by the renamed config key `ledger.maxSessions`; the global board cap is
> still named `maxEntriesPerWorkspace` (config key kept, meaning global). Cross-workspace ids are no
> longer special: every id lives in the one board. Binding delta:
> [`../plan/scope-refactor-delta.md`](../plan/scope-refactor-delta.md).

> **v0.3 amendment — four new record types, two scopes ([ADR 0008](../adr/0008-bus-and-profile.md),
> [binding contract](../plan/v0.3-interfaces.md) §2).** `KNOWN_RECORD_TYPES` grows from
> `entry|session|tombstone` to `entry|session|tombstone|context|message|profile|profile-reset` (three
> sync points: `KNOWN_RECORD_TYPES`, `isValidKnownRecord`, `dedupeKeyFor`); the envelope stays
> `{v:1,type,id,ws,seq,ts}` and `ws` must equal the journal key. `context` (`ctx_`) is M1 workspace
> keyed state (greatest `seq` per key wins, `deleted:true` removes; `maxKeys` 200,
> `maxValueBytes` 8192). `entry` keeps the existing note shape but is folded **per workspace**.
> `message` (`msg_`) is M1 immutable peer mail (`to` = workspace broadcast or a session id;
> `maxStored` 500, `maxBodyBytes` 4096). `profile` (`prf_`) is M2 last-writer-wins per
> `(section,key)` with `confidence` and `source` (`maxFacts` 200); `profile-reset` (`prr_`) is the
> import-replace barrier (records older than the newest reset are ignored). Bus records are never
> merged across workspaces; profile facts never leave the global journal. Legacy: v0.2 global `entry`
> rows stay on disk untouched and are **not** folded into workspace views; a v0.1 workspace directory
> is the v0.3 journal of that workspace (read as-is, nothing migrated).

> **v0.4 amendment — three new record types, persona sections, per-key folds
> ([ADR 0009](../adr/0009-long-term-memory-persona-style.md),
> [binding contract](../plan/v0.4-interfaces.md) §1–§2).** `KNOWN_RECORD_TYPES` grows to
> `entry|session|tombstone|context|message|profile|profile-reset|pattern|style|memory-migration` (same
> three sync points: `KNOWN_RECORD_TYPES`, `isValidKnownRecord`, `dedupeKeyFor`); the new records are
> append-only in the global scope `ws_0000000000000000`, and an update is a new record with the same
> stable `key` (folds are last-write-wins per key). `pattern` (`pat_`) is long-term memory: `key`
> `^[a-z0-9][a-z0-9._-]{0,63}$`, `category` `workflow|project|domain|pitfall|heuristic|quality`,
> `title` ≤120, `body` ≤2048 B, `tags` ≤8, `scope` `global|workspace` (+`workspaceKey`/`workspaceLabel`),
> `status` `candidate|active|rejected|superseded`, `confidence` 0..1 (default 0.5), `source`
> `agent|user|import|migration`, `evidence` ≤3 metadata-only entries, `author`. Fold per `key` (greatest
> `seq` wins, status included); live = `active`, candidates are listed separately and **never injected
> as rules**. `style` (`sty_`) is an output style card: `channel` `chat|engineering`, `area`
> `general|tone|structure|commit|comment|docs|naming|error|log|ui`, `key`, `title` ≤120, `rule` ≤1024 B,
> `examples` ≤3 `{bad,good}` (≤512 B each), `tags` ≤8, `priority` 0..100 (default 50, higher first),
> `enabled`, `confidence`, `source` `user|agent|import`; fold per `(channel,key)` and `enabled:false`
> means disabled. `profile` keeps its envelope and fold mechanics, but the section set becomes the six
> persona sections `identity|personality|communication|habits|boundaries|taste`; `preferences`/`rules`
> are **read-time aliases** of `communication`/`boundaries`, and legacy `tech`/`context` facts are no
> longer persona (they are converted once into `pattern` records, contract §5). `memory-migration`
> (`mig_`, `version:1`, `source:'profile-v03'`) is the one-time marker for that migration. Caps now
> include `memory.maxPatterns` 300 and `style.maxRules` 100 plus the body/title/tags/evidence/examples
> bounds above. Patterns and rules are untrusted data in prompts; nothing is rewritten or deleted.

## 1. Envelope

Every journal line is exactly one JSON object with these envelope fields
(cf. ADR 0001 §6: `{ v: 1, type, id?, ws, seq, ts, ... }`):

| Field | Type | Required | Rule |
|---|---|---|---|
| `v` | integer | yes | Per-line record schema version. Exactly `1` in v1. |
| `type` | string | yes | One of `entry`, `session`, `tombstone`, or reserved `signal`, `watermark`. |
| `id` | string | yes for emitted types | Stable identity; see §2. |
| `ws` | string | yes | Workspace key `ws_<16 lowercase hex>`; must equal the directory key. v0.2.0 writes the global constant `ws_0000000000000000`; legacy merged records keep their original key. |
| `seq` | string | yes | 26-char Crockford base32 ULID, uppercase; the total order key (§2.3). |
| `ts` | string | yes | ISO-8601 UTC with milliseconds and `Z`: `YYYY-MM-DDTHH:MM:SS.sssZ`. |
| … | any | per type | Type-specific fields, §4. Unknown fields are preserved/ignored (§8). |

JSON is serialized UTF-8, one object per line, no BOM, field order is not significant to readers.
Numbers are finite JSON numbers; `NaN`/`Infinity` are forbidden by `JSON.stringify` (they become
`null`), so writers must not use them. Strings are normalized Unicode: no lone surrogates, NFC not
required, control characters escaped by JSON.

Invariant: a line is self-describing. A reader that knows only this table can classify and, if it
knows the type, validate the line without consulting any other file.

## 2. Identifiers

### 2.1 Scope key and origin `wsKey` (ADR 0001 §5 → ADR 0007 §2)

v0.2.0 has **one scope key** and keeps the v1 derivation only for provenance labels and legacy reads:

```text
GLOBAL_SCOPE_KEY   = "ws_0000000000000000"        # reserved; never a real workspace key
GLOBAL_SCOPE_LABEL = "All sessions"

# origin (provenance only, best effort; may be absent and never blocks memory)
canonicalPath = realpath(session.header.cwd)               # fs.realpath, one spelling
on win32:      canonicalPath = canonicalPath.toLowerCase() # case-insensitive filesystem
workspaceKey   = "ws_" + lowerHex(sha256(utf8(canonicalPath))).slice(0, 16)
workspaceLabel = basename(canonicalPath)                   # never the full path
origin         = { workspaceKey, workspaceLabel }
```

- New records use `GLOBAL_SCOPE_KEY` as `ws`. Records from v0.1.0 journals keep their original
  per-workspace key and are merged read-only; `origin.workspaceLabel` for those is derived at fold time
  from the legacy `MANIFEST.v1.json` path (basename), never from the raw record.
- `origin` is optional on entries, `session` rows and live-session descriptors. A missing origin is
  valid: the record is global memory that simply has no workspace hint.
- v0.1.0 froze a workspace key per session and used it as a partition/filter. v0.2.0 resolves the
  origin best-effort (realpath failure → no origin) and **never** scopes a read or write by it; the
  historical freeze/collision rules below belong to the legacy resolver kept for v0.1.0 data only.

### 2.2 Record ids

| Record | `id` form | Generation | Collision policy |
|---|---|---|---|
| `entry` | `cnf_` + 26-char ULID (`cnf_01JBQ8Z4K2V7R3N5T6X1Y8M0PQ`) | `crypto` ULID, same monotonic factory | Duplicate id in the merged view → first by `seq` wins; content mismatch logged, never re-written. |
| `tombstone` | `tmb_` + 26-char ULID (`tmb_01JBQ8Z4K6D3E1G4J8F5X9Q7S2`) | `crypto` ULID | Same as entry; tombstones are idempotent by effect. |
| `session` | the DSH `SessionId` verbatim (`session-<uuid>` observed on disk, `dsh-internals.md` fact 20) | provided by DSH | Keyed by id; last-wins (§7.2). |
| `signal` (reserved) | `sig_` + 26-char ULID | v2 | Reserved, not emitted by v1. |

**Id convention (Lead ruling, plan O3):** a board id is `<prefix>_<26-char ULID>` — `cnf_` for
entries, `tmb_` for tombstones, reserved `sig_` for v2 signals. The ULID inside an id is generated
when the record is created and is independent of the record's `seq`. Character class:
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$`; ids are opaque to readers, and the prefix is the only
structural hint. The export reuses board ids unchanged, so `cnf_…` ids appear in
`memories.v1.jsonl` as well.

### 2.3 `seq` — time-sortable ULID

- 26 Crockford base32 characters, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O`, `U`).
- `seq = ulid(nowMs, randomBytes)`: 10 chars of 48-bit millisecond timestamp + 16 chars of 80-bit
  randomness. Each writer enforces **strict monotonicity**: if the generated value is not greater
  than that writer's previous value (same millisecond), it increments the random component (standard
  monotonic ULID factory), so one writer's shard is strictly ordered.
- Ordering is lexicographic on the 26-character string. This approximates time order globally: a
  record generated in a later millisecond always sorts later, regardless of writer. Two writers
  generating records in the *same millisecond* are ordered arbitrarily but deterministically by
  their random components — every reader agrees on the order because the key is total.
- Because all writers of a profile share one machine clock, cross-writer skew is not a practical
  concern. The bounded edge — writer B appends a record in the same millisecond whose random part
  sorts below writer A's cursor already consumed by a session — is accepted: the record stays
  visible to `confluence_board`/`confluence_search`; it can miss one pulse headline. A lost *note*
  is never possible (discoverability is not cursor-filtered; ADR 0001 §8.1).
- Cursor semantics use strings only, never a clock: `null` means "no cursor yet" (a fresh session),
  `"0"` is the delivered empty-board sentinel (the welcome snapshot of an empty board), and a
  26-char ULID is a real board cursor. Lexicographic comparison gives `null < "0" < every ULID`;
  "new since" means `record.seq > cursor` lexicographically. Readers accept any
  `[0-9A-Za-z]{1,26}` token from a marker/cursor; writers emit exactly 26 characters for real
  cursors (the `"0"` empty-board sentinel and an empty `through=` are the only exceptions).
- The board-read marker line is `through=<cursor>`; an empty-board read may emit `through=` with no
  value (meaning "no cursor"), which readers ignore. The pulse header attribute is
  `seq="<cursor>"`; the empty-board sentinel is `seq="0"` (pulse design).

### 2.4 `ts`

ISO-8601 UTC string with milliseconds, e.g. `2026-11-13T02:41:07.512Z`. `ts` is for humans,
retention windows and export, never for ordering (order is `seq`). Readers compare `ts` only after
parsing it; an unparseable `ts` makes the line invalid (§8).

### 2.5 Writer id

`writerId = <pid>-<8 lowercase hex>`, e.g. `24188-9f3ac210`. One writer id per plugin mount
(unique per process instance), safe as a filename component: `^[0-9]{1,10}-[0-9a-f]{8}$`.
A process must never append to a shard whose `writerId` it did not mint; after restart a fresh
`writerId` starts a fresh shard (ADR 0001 §6).

## 3. Enumerations

```json
kind:      ["finding", "decision", "gotcha", "question", "handoff", "warning"]
origin:    ["agent", "user"]
status:    ["live", "idle", "cold"]          // session ledger stored value: live | idle only
entryStatus: ["active", "open", "resolved", "superseded"]   // derived, never stored
type:      ["entry", "session", "tombstone", "signal", "watermark"]
tombstoneReason: ["user", "retention"]
```

Rules: unknown `kind` values are invalid in an `entry` written by v1 (writers validate against the
closed enum); a v1 reader that meets an unknown `kind` renders it as `[note]` and never treats it
specially. `status` stored on a `session` row is the status observed at write time (`live` or
`idle`); `cold` is a derived read-state (§5.6). `entryStatus` is always derived (§5).

## 4. Record types

### 4.1 `entry` — a board note (ADR 0001 §2)

| Field | Type | Req | Rule |
|---|---|---|---|
| `v`,`type`,`id`,`ws`,`seq`,`ts` | — | yes | §1; `type = "entry"`. |
| `kind` | string | yes | §3 enum. |
| `origin` | string | yes | `agent` (posted through a tool) or `user` (posted through an M4 user action/command). |
| `title` | string | yes | 1–160 chars after redaction and whitespace collapse; no newlines, no leading/trailing spaces; may not contain the pulse/tag framing characters after escaping (escaping happens at render, not storage). |
| `body` | string | no | ≤8192 UTF-8 bytes (`store.maxBodyBytes`); newlines allowed; redacted before append. |
| `tags` | string[] | no | ≤8 items, each 1–32 chars `^[a-z0-9][a-z0-9_-]*$`; lowercased/deduped by the writer. |
| `files` | string[] | no | ≤8 workspace-relative paths, each 1–240 chars, `/` separators; no drive letter, no UNC, no leading `/`, no `..` segment, no NUL; deny-pattern checked (`privacy.denyPathPatterns`). |
| `origin` (v0.2.0) | object | no | Provenance of the writing session: `{ workspaceKey?, workspaceLabel? }`, label = basename only. Optional; never used as a filter. Distinct from the author enum below. |
| `replyTo` | string | no | An existing `entry` id in shared memory, not tombstoned, and not itself a reply (threads are one level deep; a reply to a reply is re-targeted to the root by the writer). Mutually exclusive with `replyTo`-cycle. |
| `resolves` | boolean | no | Only on a reply (`replyTo` present). `true` resolves the root question/handoff; `false` reopens it (last marker by `seq` wins, §5.2). |
| `supersedes` | string | no | An existing non-reply `entry` id in shared memory. Marks the target `superseded` (§5.3); the new entry is independent and remains active. |
| `sessionId` | string | yes | Author session id (for `origin = "user"` this is the invoking session, or the literal `user` — never anonymous to the reader, see §5.5). |
| `sessionTitle` | string | no | Snapshot of the author's title at post time, ≤160 chars, redacted. Missing if unknown; readers fall back to the ledger title or `"a session"`. |
| `redactions` | integer | no | Count of redaction replacements applied before append (0 omitted). Never content. |

Append-only: an `entry` never changes after append. Corrections are a new entry (`supersedes`) or a
reply. There is no edit/delete tool; a user deletion (M4) appends a `tombstone`.

### 4.2 `session` — session ledger row (ADR 0001 §9)

Metadata only. No prompts, assistant text, tool outputs, reasoning, or command lines (enforced by
the field allow-list test, §8.3).

| Field | Type | Req | Rule |
|---|---|---|---|
| `v`,`type`,`id`,`ws`,`seq`,`ts` | — | yes | §1; `type = "session"`, `id` = session id. |
| `title` | string | no | Session title folded from `session/title`, redacted, ≤160 chars. Absent until known. |
| `status` | string | yes | `live` or `idle` at write time. |
| `turns` | integer | no | Completed turn count observed (monotonic, ≤1 000 000). |
| `lastActivityTs` | string | no | ISO timestamp of the event that caused the row. |
| `effectiveDir` | string | no | Absolute canonical directory the session was actually working in when it differed from the workspace path; recorded once per change. Never exported, never in the pulse. |
| `files` | string[] | no | ≤8 distinct workspace-relative paths observed in write/edit-style tool calls; cumulative, deduped, oldest dropped. Always rendered with the phrase "files seen in tool calls (partial)". |
| `parentSession` | string | no | Fork lineage from `header.parentSession`. |
| `origin` | object | no | v0.2.0 provenance: `{ workspaceKey?, workspaceLabel? }` (basename label). Replaces the v1 `subagent` string marker; legacy rows carrying a string are normalized to no origin. Never scoped/filtered on. |
| `redactions` | integer | no | As §4.1. |

Exactly one effective row per session id: readers keep the row with the greatest `seq` (last-wins,
§7.2). All rows live in the global scope; a session may write a row with no origin at all (missing
directory is not a failure). Legacy v0.1.0 rows keep their original `ws` and gain a display label from
their old manifest.

### 4.3 `tombstone` — deletion marker (ADR 0001 §6/§11)

| Field | Type | Req | Rule |
|---|---|---|---|
| `v`,`type`,`id`,`ws`,`seq`,`ts` | — | yes | §1; `type = "tombstone"`. |
| `targetId` | string | yes | An `entry` id in the global board (legacy merged ids qualify too). |
| `targetType` | string | yes | `"entry"` in v1 (reserved for future `"session"`/`"workspace"`). |
| `reason` | string | yes | `"user"` (M4 explicit action); `"retention"` reserved for compaction policy. |
| `origin` | string | yes | `"user"`. |

Tombstones win at read time over their target (§5.1). They are retained for audit and are never
removed while the workspace exists (they are tiny; cap in §6). A tombstone is idempotent: duplicates
have no additional effect. A tombstone of a root cascades to its thread at read time (§5.1).

### 4.4 `signal` — RESERVED for v2, never emitted by v1

Round-2 R3 keeps option B's v2 record schema verbatim as the extension substrate. In v1 the type is
reserved: readers ignore `signal` lines entirely; writers never emit them. The v2 shape (field names
reserved now so v2 needs no migration):

```json
{"v":1,"type":"signal","id":"sig_01JBQ8Z4KAH9T2R6N4X7C0W8FD","ws":"ws_3f9a1c7e2b4d8061",
 "seq":"01JBQ8Z4K2V7R3N5T6X1Y8M0PQ","ts":"2026-11-13T02:41:07.512Z",
 "kind":"decision","origin":"auto","text":"[…]","summary":"[…]","status":"accepted",
 "source":{"sessionId":"session-23da4b81-7f0e-4c2a-9d55-1e8f0a6b7c91","sessionTitle":"[…]",
           "seq":412,"turn":7,"eventTypes":["assistant/message"],"createdAt":"2026-11-13T02:12:03.000Z"},
 "provenance":{"trust":"auto-derived","extractionVersion":1,"score":0.82},
 "entityKeys":["path:docs/event-store.md","topic:sqlite"],"occurrences":1,
 "firstSeenAt":"…","lastSeenAt":"…","redactions":0,"deleted":false}
```

Reserved names (v1 must not repurpose): types `signal`, `watermark`; id prefix `sig_`; field names
`text`, `summary`, `source`, `provenance`, `entityKeys`, `simhash64`, `occurrences`, `firstSeenAt`,
`lastSeenAt`, `deleted`, `rev`, `groupId`, `conflictWith`, `suppressed`; kinds read from the same
§3 enum. Adding a *new record type* and new optional fields is the only forward-compatible change
(§8.4); changing the meaning of an existing v1 field requires `v: 2` and a new line schema.

### 4.5 `watermark` — RESERVED, never emitted

ADR 0001 §8.1 derives watermarks from the committed session log (projection state), not from store
files. The type name is reserved so a future explicit watermark record does not collide; v1 readers
ignore it and v1 writers never emit it.

### 4.6 Presence heartbeat (not a journal line)

One file per writer: `presence/<writerId>.json`, overwritten atomically (temp + rename). Not a
record type, not part of the merge/order space, never exported.

```json
{"v":1,"ws":"ws_0000000000000000","writerId":"24188-9f3ac210","pid":24188,
 "plugin":{"name":"dsh-confluence","version":"0.2.0"},
 "updatedAt":"2026-11-16T02:41:07.512Z",
 "sessions":["session-23da4b81-7f0e-4c2a-9d55-1e8f0a6b7c91"],
 "sessionsMeta":[{"sessionId":"session-23da…","title":"Auth work","workspaceLabel":"solo-bench"}]}
```

Rules: `sessions` ≤32 ids, sorted, only live/idle non-private sessions of this process;
`sessionsMeta` is optional title/workspaceLabel help (basenames only). Titles never appear in
`sessions`; the pulse joins titles from `session` rows. Written on turn end
and at most once per 10 s per mount while the process has live sessions; deleted best-effort on
deactivation. Stale after 30 s (ADR 0001 §6). A heartbeat file older than 10 minutes may be deleted
by any mount (TTL cleanup, §store-format).

### 4.7 Global scope metadata (inside `MANIFEST.v1.json`)

```json
{"key":"ws_0000000000000000","canonicalPath":"","label":"All sessions","createdAt":"2026-11-16T02:16:51.000Z"}
```

v0.2.0 writes exactly one such manifest for the global scope: `canonicalPath` is empty **only** for
`GLOBAL_SCOPE_KEY` (manifest validation must accept that), and `label` is `"All sessions"`. Legacy
per-workspace manifests keep their original `canonicalPath` and are never rewritten; their basename is
the provenance label for their records. `createdAt` is the first-mount timestamp; the first writer to
create the manifest wins (`wx` create, §store-format).

### 4.8 `MANIFEST.v1.json`

Full file schema is owned by [`store-format.md`](store-format.md) §15. The data-model-relevant part:
`format: "confluence.store/v1"`, `formatVersion: 1`, `ws`, `workspace` (§4.7), `generation: 0` in
v1-core (compaction increments it in M4), `snapshot: null` in v1-core, `shards`/`seqRange` advisory
only (directory listing is authoritative), `updatedAt`. There is exactly one global manifest; legacy
workspace manifests exist as read-only history and must never prevent reading shards.

## 5. Derived state

All derived state is a pure function of the merged record set (plus presence files for liveness).
Nothing derived is ever stored back except a new record (ADR 0001 §2).

### 5.1 Tombstones

- An `entry` is *visible* iff no valid `tombstone` with `targetId == entry.id` exists.
- A tombstoned root cascades: every entry whose `replyTo` chain resolves to it is also invisible.
- Direct reference (`confluence_read` with a board id) to an invisible entry returns a bounded
  `deleted` stub (`id`, `kind`, `deleted:true`, no title/body) — never the content.
- Tombstones affect every read surface: board, search, pulse, recall result refs, panel, export.
- Retention (`RETENTION_DAYS`, 90) hides older entries from **default** reads (board, search, pulse,
  export) but is not a tombstone: `confluence_read` by exact id still resolves the entry (config.md
  retention semantics). Raw shards retain it until M4 compaction prunes.

### 5.2 Question/handoff resolution

Effective status is derived, first-match:

1. `deleted` if tombstoned;
2. for `kind ∈ {question, handoff}`: look at all *visible* replies (`replyTo == root.id`) that
   carry a `resolves` boolean; take the one with the greatest `seq`. `resolves:true` → `resolved`,
   `false` → `open`; no such reply → `open`.
3. for other kinds: `superseded` if some visible entry has `supersedes == entry.id`, else `active`.

A resolution is append-only: `resolves:false` on a later reply re-opens without touching earlier
records. Only questions/handoffs can be resolved; a reply with `resolves` to another kind is
rejected at write time (`E_BAD_RESOLVE`).

### 5.3 Supersede

`entry.supersedes = X` marks X `superseded` (for `decision` it reads as "replaced", for other kinds
as "stale"). The superseding entry is active and independent. Chains are allowed
(A supersedes B supersedes C); the effective status only reports the direct marker. Supersede does
not hide the old entry from history; it down-ranks it in `confluence_search` and excludes it from
the "current shared memory" section of the pulse.

### 5.4 Threads

One level deep: a root entry plus replies whose `replyTo == root.id`. The writer re-targets a reply
to a reply at the root (tool API detail in [`tool-api.md`](tool-api.md)). A thread renders in
`seq` order. Thread size is capped by the global entry cap; the board/read renders at most 20
replies and states `+N more`.

### 5.5 Provenance

Every entry carries `origin` + `sessionId` (+ `sessionTitle` when known). Provenance is display
metadata and a trust label ("posted by a session" vs "posted by the user"). It never promotes
content to instructions: all board text is untrusted data (ADR 0001 §11) and every render carries
the fixed warning.

### 5.6 Presence and effective session status

- Presence view (global) = union of `sessions` arrays of all presence files with
  `updatedAt` within 30 s and matching `ws`, minus the reading session itself.
- A ledger row's effective status: `cold` when no presence entry mentions the session **and** its
  `lastActivityTs` is older than 30 s (the presence staleness window; display only); `live` if
  presence mentions it and its last row says `live`; otherwise `idle`.
- Status words never enter the pulse (ADR 0001 §8); they are for `confluence_board`/panel only.

### 5.7 Read/unread cursors

Two cursor values per session, both derived from the committed session log (ADR 0001 §8.1,
ADR 0003, [`architecture.md`](architecture.md) "committed log → projection watermark"), never stored
in the store:

- `digestSeq` — the greatest pulse cursor actually committed for this session: the `seq="…"`
  attribute of the `confluence:pulse` section in a committed `user/message` runtime-context
  snapshot. `null` before the first committed pulse (welcome gate); `"0"` after an empty-board
  welcome.
- `boardReadSeq` — the greatest `through=` marker folded from a committed `confluence_board` /
  `confluence_read` tool result (both presets). `null` before the first board read.

**`New:` lines and the `unread` count are the unread set**: visible entries with
`seq > boardReadSeq` (all entries when `null`), newest first, excluding entries authored by the
reading session. `digestSeq` is *not* an unread cursor; it only answers "has this session ever been
welcomed?" so the welcome digest is rendered exactly once and a fork/resume never re-welcomes
(ADR 0003 §3). Items leave `New:` only when a board read commits or the retention/staleness window
hides them; this is what makes one committed snapshot per real change instead of two.

## 6. Caps and quantities

All caps are enforced **at append** (reject, never silent truncate) except where marked *render*.
`(chosen here)` = ADR 0001 leaves the exact number open; it is fixed by this document.

| Constant | Value | Applies to | Source |
|---|---|---|---|
| `FORMAT_VERSION` | 1 | line `v`, manifest | ADR §6 |
| `MAX_LINE_BYTES` | 65 536 | one encoded line incl. `\n` | ADR §6 |
| `MAX_TITLE_CHARS` | 160 | entry title and session-ledger title (both redacted) | chosen here |
| `MAX_BODY_BYTES` | 8 192 (config range 256–49 152) | entry body; the encoded-line cap 65 536 is binding regardless — worst-case 49 152 + provenance stays under it | ADR config `maxBodyBytes` + [`config.md`](config.md) |
| `MAX_TAGS` / `MAX_TAG_CHARS` | 8 / 32 | entry tags | chosen here |
| `MAX_ENTRY_FILES` | 8 | entry `files` | chosen here |
| `MAX_PATH_CHARS` | 240 | any stored workspace-relative path | chosen here |
| `MAX_ENTRIES_PER_WORKSPACE` | 2 000 (config range 50–20 000) | visible entries in the one global board; at the cap new `post`/`reply` fail `BOARD_FULL`. The config key keeps its v0.1.0 name (`store.maxEntriesPerWorkspace`), meaning global | ADR config `maxEntriesPerWorkspace`; [`config.md`](config.md) §2.2 |
| `RETENTION_DAYS` | 90 | entries/session rows hidden from default reads (exact-id read still works) | ADR config `retentionDays` |
| `MAX_LEDGER_SESSIONS` | 200 | newest session rows considered, **profile-wide** | ADR config `ledger.maxSessions` (renamed from `maxSessionsPerWorkspace` in v0.2.0) |
| `MAX_FILES_PER_SESSION` | 8 | ledger file hints | ADR config `maxFilesPerSession` |
| `MAX_TOMBSTONES_TRACKED` | 4 096 | tombstone ids in the memory mirror; beyond → re-scan shards for tombstones | chosen here |
| `PRESENCE_HEARTBEAT_MS` | 10 000 | heartbeat cadence | ADR §6 |
| `PRESENCE_STALE_MS` | 30 000 | peer counted offline; also the `cold` display threshold | ADR §6 |
| `PRESENCE_TTL_MS` | 600 000 | stale file may be deleted | chosen here |
| `PRESENCE_MAX_SESSIONS` | 32 | ids per heartbeat file | chosen here |
| `COLD_AFTER_MS` | 30 000 | alias of `PRESENCE_STALE_MS`: derived `cold` display status | chosen here |
| `PULSE_STALE_AFTER_DAYS` | 7 | entries older than this may not enter `New:`/`Open items:` (still on the board) | pulse design (T8) |
| `POLL_MS` | 4 000 | freshness contract | ADR config `pollMs` |
| `WATCH_DEBOUNCE_MS` | 400 | fs.watch debounce | ADR §6 |
| `FSYNC_INTERVAL_MS` | 1 000 | batched fsync | ADR §6 |
| `LEDGER_FLUSH_MS` | 5 000 | max delay before a ledger row is appended | chosen here |
| `LEASE_STALE_MS` | 120 000 | lock takeover | chosen here |
| `MAX_SHARDS_READ` | 64 | newest shards merged per refresh; more → warn + compaction | chosen here |
| `MAX_SNAPSHOT_ENTRIES` | 512 | newest entries kept in the in-memory mirror | chosen here |
| `MAX_QUERY_RESULTS` | 50 | internal cap for board/search views | chosen here |
| `MAX_THREAD_RENDER` | 20 | replies rendered per read (*render*) | chosen here |
| `PULSE_MAX_CHARS` | 1 400 | rendered pulse (*render*) | ADR config `maxChars` |
| `PULSE_MAX_HEADLINES` / `PULSE_MAX_PEERS` | 3 / 2 | pulse (*render*) | ADR config |
| `RECALL_MAX_SESSIONS` / `RECALL_MAX_HITS` | 3 / 5 | recall | ADR config |
| `RECALL_EXCERPT_CHARS` | 600 | one recall excerpt (*render*) | ADR §9 |
| `EXPORT_MAX_BYTES` | 8 388 608 | `memories.v1.jsonl` warn threshold | chosen here |

## 7. Ordering, dedupe and last-wins

### 7.1 Merge order

`foldRecords(allLines)` is a pure function: parse valid lines, then sort by `seq` lexicographically
(tie-break `id`, then type name — ties are practically impossible) and fold:

- `entry`: first occurrence of an `id` wins; later duplicates are ignored (a crash-retried append
  produces byte-identical lines; differing content is logged and the first wins).
- `tombstone`: union by `(targetId)`; the tuple is idempotent.
- `session`: **last-wins** by `id` — keep the row with the greatest `seq`.
- `signal`/`watermark`/unknown: ignored by v1 readers; counted in `unsupported` diagnostics only.
- Lines failing validation (§8) are skipped before folding; they never participate in ordering.

The effective view therefore depends only on the set of valid lines, not on file enumeration order,
read timing, or which process reads (invariant I17).

### 7.2 Why first-wins for entries and last-wins for sessions

Entries are immutable facts; a duplicate id is either an identical retry or an anomaly, and picking
the earliest copy is deterministic at the data level. Ledger rows are an upsert stream: the newest
observation is the truth. Both rules are applied after the global `seq` sort so the outcome does not
depend on local shard order.

### 7.3 Unread/`new` selection

Given the unread cursor (`boardReadSeq`), candidates are visible entries with
`seq > boardReadSeq`, **not filtered by origin** and not authored by the reading session. Ordering is
`seq` descending (newest first). Selection for the pulse `New:` line: ≤3 headlines, preferring open
`question`/`handoff` then `gotcha`/`decision` then the remaining kinds, at most one headline per
kind; entries older than `PULSE_STALE_AFTER_DAYS` (7) are skipped here (`confluence_board` still
returns them within retention). This is deterministic for a given record set and cursor
(ADR 0003 §3).

## 8. Validation

### 8.1 Writer-side (reject, report)

A writer builds a record via `lib/records.js`, which validates: envelope types/formats; `ws` equals the
global scope constant for new records (legacy records keep their own key); enum membership; every cap in
§6; id/`replyTo`/`supersedes`
target existence and kind rules (`E_UNKNOWN_REF`, `E_BAD_RESOLVE`, `E_THREAD_TOO_DEEP`); path rules;
redaction applied. Failures return stable internal codes; the tool handler maps
them 1:1 to the authoritative model-facing codes in [`tool-api.md`](tool-api.md) §4
(`E_BOARD_FULL`→`BOARD_FULL`, `E_BODY_TOO_LARGE`→`BODY_TOO_LARGE`, `E_STORE_WRITE`→
`STORE_UNAVAILABLE`, …). A record that fails validation is never serialized.

### 8.2 Reader-side (skip or clamp, never throw)

Readers must never throw on stored data (ADR §16 tolerance). For each line: if JSON parse fails, or
the envelope is invalid, or `ws`/`v`/`type` is not understood, **skip the line** and count it. If
the line is valid but a text field exceeds a cap (e.g. produced by a future writer or hand-edited),
**clamp for rendering** (title 160, body 8 192 bytes, files 8, tags 8) and mark `clamped:true` in
the internal view; never clamp `seq`/`id`/`ws`/`ts` (invalid values make the line invalid).

### 8.3 Field allow-list

The journal field allow-list test scans every line the plugin emits and fails if any field name or
value shape matches content that must never be stored: prompts, assistant messages, tool outputs,
reasoning, command lines, file contents. The complete allow-list is the union of §4.1–§4.3 fields
plus `v/type/id/ws/seq/ts`. The only absolute paths allowed are `session.effectiveDir` and
`manifest.workspace.canonicalPath` (both profile-local, excluded from export and pulse); the test
names those two fields explicitly and rejects any other path-like absolute string.

### 8.4 Forward compatibility

- Unknown **record types** → ignored (v1 readers ignore `signal`/`watermark` too).
- Unknown **fields** → ignored on read; never re-serialized by the plugin (append-only stores are
  never rewritten except by M4 compaction, which preserves unknown fields verbatim in snapshots).
- New **enum values** (e.g. a future `kind`) are the exception: v1 validates `kind` against the
  closed set on write but on read maps unknown kinds to a neutral `[note]` rendering. This is a
  display degradation, never a security decision.
- A line with `v: 2` is skipped by v1 readers (counted as unsupported) — never partially applied.
- Adding an optional field is compatible within `v: 1`; changing a field's type or meaning requires
  a new `v`.

### 8.5 Migration rules

- There is no in-place migration of v1 data. A v2 store is a **new root** (`.../confluence/v2/`) or
  a new line schema read alongside v1 by a v2 plugin; v1 files are never rewritten in place.
- `MANIFEST.v1.json.formatVersion` is bumped only when the *store-level* directory layout or file
  naming changes (not for a new record type). The line-level version is `v`.
- Compaction (M4) preserves the original `seq`, `id`, `ts` and unknown fields; it only removes
  tombstones/entries per retention policy after publishing the snapshot (§store-format §13).
- Export format is versioned independently (`confluence.memories/v1`); an export bump is additive
  and announced in its manifest. Readers ignore unknown export fields/kinds.

## 9. Invariants

I1. Every emitted line has `v: 1`, a valid `ws`, a 26-char `seq`, a parseable `ts`, and a known type.
I2. A line's `ws` equals the directory key it lives in; mismatched lines never enter the view.
I3. An `entry` never changes after append; its id is `cnf_` + ULID, a `tombstone` id is `tmb_` + ULID,
    and an id appears at most once in the effective view.
I4. A `session` id has at most one effective row: the one with the greatest `seq`.
I5. A tombstone wins over its entry at read time; a tombstoned entry and its thread never appear in
    board/search/pulse/export results, and a direct read returns a deleted stub without content.
I6. One global scope: every new record's `ws` is the global constant, and origin is provenance only
    (a session may write records with no origin; nothing is partitioned or filtered by it).
I7. `seq` is strictly increasing per writer; merged order is lexicographic `seq` order and is
    identical for every reader.
I8. Duplicate lines are idempotent: identical retries change nothing; differing duplicates never
    change the effective view (first-wins/entry, max-seq/session).
I9. All board and ledger text is untrusted data; no stored field is ever executed, followed, or
    treated as an instruction.
I10. No record stores prompts, assistant text, tool outputs, reasoning, command lines or file
     contents; session titles are the sole prompt-derived field and are redacted, capped, and
     labeled.
I11. Stored workspace-relative paths stay workspace-relative; the only absolute-path fields are the
     two named in §8.3, both excluded from every render and export.
I12. Caps are enforced before append (reject); reader-side clamping is rendering-only and visible.
I13. Derived state (entry status, threads, unread, presence, cold) is a pure function of valid lines
     plus presence files; no record mutates another record.
I14. A reader never throws, blocks, or writes because of stored data; malformed input is skipped.
I15. A line is one JSON object, UTF-8, `\n`-terminated, ≤64 KiB; a partial trailing line is ignored.
I16. The effective view is independent of file enumeration order, process identity, and read timing.
I17. Retention hides records from reads; it does not mutate them (only M4 compaction may prune).
I18. Only the process's own `writerId` shard is appended to; readers never write shards.
I19. v1 never emits `signal`/`watermark`; v2 changes are additive (new type/optional field) or a new
     line schema version — never a reinterpretation of a v1 field.
I20. The export is derived: it contains no tombstoned entries, no absolute paths, only redacted
     text, is deterministic except for its manifest `generatedAt`, and is never read back.
I21. Presence heartbeats contain session ids and liveness metadata only — no titles, bodies, or
     prompts.
I22. `digestSeq`/`boardReadSeq` are derived only from committed session events, start at `null`, are
     max-monotonic, and are never advanced by a render or a provider call; `unread`/`New:` mean
     `seq > boardReadSeq`, while `digestSeq` only gates the one-time welcome (ADR 0003 §3).

## 10. Worked examples (valid lines, one per line)

An entry posted by a session:

```json
{"v":1,"type":"entry","id":"cnf_01JBQ8Z4K1H9T2R6N4X7C0W8FD","ws":"ws_3f9a1c7e2b4d8061","seq":"01JBQ8Z4K2V7R3N5T6X1Y8M0PQ","ts":"2026-11-13T02:41:07.512Z","kind":"gotcha","origin":"agent","title":"Windows rename retries wrap in EPERM","body":"spawnSync rename throws EPERM when a scanner holds the handle; retry with backoff 3x before failing.","tags":["windows","fs"],"files":["src/fs/rename.ts","test/rename.test.ts"],"sessionId":"session-23da4b81-7f0e-4c2a-9d55-1e8f0a6b7c91","sessionTitle":"Auth work"}
```

A question, then a reply that resolves it:

```json
{"v":1,"type":"entry","id":"cnf_01JBQ8Z4K5M2C8F1D6R9N3X7VW","ws":"ws_3f9a1c7e2b4d8061","seq":"01JBQ8Z4K3A9F2D7H5C0W6G4RT","ts":"2026-11-13T02:43:11.004Z","kind":"question","origin":"agent","title":"Does the fixture suite need TZ=UTC on CI?","body":"Local passes, CI fails on date assertions.","sessionId":"session-23da4b81-7f0e-4c2a-9d55-1e8f0a6b7c91","sessionTitle":"Auth work"}
{"v":1,"type":"entry","id":"cnf_01JBQ8Z4K7P3E6G2J5M8T1C4RZ","ws":"ws_3f9a1c7e2b4d8061","seq":"01JBQ8Z4K4B1C8E2G6D3V7N5QZ","ts":"2026-11-13T02:47:55.120Z","kind":"finding","origin":"agent","title":"TZ=UTC needed for fixture suite","body":"Set TZ=UTC in the test step; the dates are local-time formatted.","replyTo":"cnf_01JBQ8Z4K5M2C8F1D6R9N3X7VW","resolves":true,"sessionId":"session-5c1b0e7a-3d44-4b8f-a0c2-7e9d1f6b8a34","sessionTitle":"Test triage"}
```

A ledger row (second observation of the same session — last-wins over the earlier one):

```json
{"v":1,"type":"session","id":"session-23da4b81-7f0e-4c2a-9d55-1e8f0a6b7c91","ws":"ws_3f9a1c7e2b4d8061","seq":"01JBQ8Z4K5C2D9F3H7E4W8P6R1","ts":"2026-11-13T02:49:02.887Z","title":"Auth work","status":"idle","turns":7,"lastActivityTs":"2026-11-13T02:49:02.887Z","effectiveDir":"D:\\05_Code\\solo-bench","files":["src/auth/login.ts","test/auth.test.ts"],"redactions":1}
```

A tombstone for the question (cascades to its reply at read time):

```json
{"v":1,"type":"tombstone","id":"tmb_01JBQ8Z4K9Q4F7H3K6N1V5T8XW","ws":"ws_3f9a1c7e2b4d8061","seq":"01JBQ8Z4K6D3E1G4J8F5X9Q7S2","ts":"2026-11-13T03:02:40.006Z","targetId":"cnf_01JBQ8Z4K5M2C8F1D6R9N3X7VW","targetType":"entry","reason":"user","origin":"user"}
```

A presence heartbeat (`presence/24188-9f3ac210.json`) and the workspace metadata block of a
manifest are shown in §4.6/§4.7; the full manifest is in [`store-format.md`](store-format.md) §15.

## 11. Open questions

1. **Session title source and redaction.** Titles are prompt-derived; `ctx.sessionQuery.readTitle`
   may return a title generated before redaction patterns were configured. M2 must decide whether
   to re-redact historical titles on read (cheap) or only at write (current design) — the field is
   capped and labeled either way.
2. **`origin = "user"` session id.** A user action through the panel may not be attached to a
   session; the placeholder `user` is defined but the panel transport (M3) must state whether a
   session id is always available. No schema change either way.
3. **Same-millisecond cross-writer cursor edge** (§2.3) is accepted in v1. If M0 measures it, a
   future "delivered set" watermark would remove it; not worth a schema change now.
4. **`supersedes` on questions/handoffs.** Currently treated as "resolved"; if the tool API wants
   distinct semantics, the record field stays the same and only the derived rule changes.
