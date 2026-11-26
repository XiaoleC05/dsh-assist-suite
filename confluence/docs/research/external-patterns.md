# External patterns: cross-session and shared memory for local-first coding agents

**Executive summary.** Surveying 20+ external mechanisms shows a clear split: the patterns that survive
Confluence's **fully-offline, no-server, no-extra-port** constraint are *file/log-centric and
single-writer* (Markdown conventions, JSONL append logs, SQLite/FTS5 indexes, durable event streams with
watermarks, blackboard-style shared boards), while the patterns that dominate agent frameworks
(LangGraph stores, Mem0, Zep/Graphiti, Letta, CrewAI, AutoGen vector stores) assume **a database server,
an embedding model, an LLM extraction call, or all three** and therefore do *not* fit a no-network DSH
plugin without new runtime services. The strongest proven "cross-session information sharing" design in
a local-first coding tool is currently **Claude Code's cross-session messaging**: plain-text messages
between live sessions over a per-session Unix domain socket / Windows named pipe (never through vendor
servers for same-machine delivery), with inbound accept/hold/refuse controls, size caps, burst
throttling, loop throttling, and "a message never counts as user approval". That validates the user's
pain point and suggests Confluence's lowest-risk mechanism is **a durable local board + explicit
message/handoff records + bounded passive digest**, not a memory database. Recommendation: adopt
event-sourced append-only board + watermarks + DSH storage domains + durable-event subscriptions +
markdown inspectability; adapt blackboard semantics and mail/handoff records; defer CRDT and vector
search; avoid any external memory server, embedding pipeline, or network dependency.
`https://github.com/XiaoleC05/Confluence` exists but is **empty**; the local repo has no commits.
Unverified or unretrievable claims are marked `HYPOTHESIS:` or flagged inline.

---

## 1. Verified facts

### 1.1 Target repository status (exactly as observed, 2026-11-13)

| Query | Result |
|---|---|
| `GET https://api.github.com/repos/XiaoleC05/Confluence` | HTTP 200: `private:false`, `created_at:2026-11-12T17:50:06Z`, `updated_at:2026-11-12T17:50:08Z`, `default_branch:"main"`, `size:0`, `description:null`, `license:null`, `stargazers_count:0`, `forks_count:0`, `has_issues:true`, `has_wiki:true`, `has_discussions:false`, `homepage:null`, `topics:[]` |
| `GET …/branches` | `[]` |
| `GET …/releases` | `[]` |
| `GET …/commits` | HTTP 409 `{"message":"Git Repository is empty."}` |
| `GET …/contents/` | HTTP 404 `{"message":"This repository is empty."}` |
| HTML page `https://github.com/XiaoleC05/Confluence` | could not be fetched from this machine (fetch failed); API above is authoritative |
| Local `D:\05_Code\Confluence` | git initialized, branch `main`, `origin` set to the GitHub URL, **no commits**, only `docs/planning/team-brief.md` |

**Conclusion: the repo exists and is empty.** Any claim that it already contains design material is wrong.

### 1.2 DSH public documentation and plugin-publishing guidance (authoritative)

- Official source repository: `https://github.com/deepseek-ai/deepseek-harness` — MIT, default branch
  `master`, public (`GET https://api.github.com/repos/deepseek-ai/deepseek-harness`; observed
  279,693 stars/34,437 forks at query time — counts are volatile).
- Official docs site mirror of subsystem references and the developer tutorial:
  - **Package and install a plugin** (bundle vs profile manifests, `dsh plugin --profile <name> add
    ./hello-plugin` links a checkout locally, `pnpm pack` tarball install, GitHub-install
    build-script caveat and `allowBuilds`, `engines.dsh` requirements, load order:
    bundles → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays):
    https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish.md
  - **Session-reference subsystem** (canonical `dsh-session:` URIs, `SessionReferenceInput`/`Candidate`,
    prepared messages, `capturedThroughSeq`, error codes):
    https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-reference.md
  - **Session-query subsystem** (`SessionRecord`, `SessionSurfaceSnapshot`, filters, FTS pages, lineage,
    bounded event reads):
    https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-query.md
- Product page confirms the user-facing `@`-mention of sessions is marketed: "Describe what you want to
  build, / commands, @ files or sessions" — https://www.deepseek.com/en/harness/
- First-party package versions in the installed runtime are all `0.2.2-rc.1`; upstream docs describe a
  *lower bound*, not the installed build (see prior-art doc §1.1 for the shipped package list).
- `HYPOTHESIS:` the docs site is generated from `docs/` in the same repo, so doc text and installed code
  can drift by rc; treat the installed package READMEs as higher authority (prior-art doc does).

### 1.3 Retrieval limits for this section (honesty note)

- `web_fetch` on GitHub HTML and `raw.githubusercontent.com` failed from this machine; `api.github.com`
  and `cdn.jsdelivr.net` worked. Wikipedia's REST/raw endpoints and `en.wikipedia.org` failed; the
  blackboard/Linda descriptions below therefore summarize the canonical definitions and cite the
  article URLs, **not** quoted text.
- Letta and Yjs doc pages returned their navigation but not the article body (JS-rendered); claims about
  them are limited to page titles/structure plus well-established definitions, and marked
  `HYPOTHESIS:` where they go beyond that.
- Zep's Graphiti quick-start returned its table of contents only; see §2.D5 for the limited claim.

---

## 2. Pattern survey

Format per pattern: **Mechanism** (2–3 sentences) · **Offline viability in a DSH plugin** ·
**Strengths** · **Failure modes** · **Applicability to Confluence**.

### A. Shared-instruction / notes conventions

#### A1. `CLAUDE.md` / `AGENTS.md` hierarchical instruction files

**Mechanism.** Agents load Markdown instruction files from a fixed search path at session start and
treat them as context, not configuration: Claude Code loads managed/user/project/local `CLAUDE.md` from
the working directory upward, concatenated root→cwd, plus subdirectory files on demand, with `@path`
imports expanded up to four hops; `AGENTS.md` is an open cross-tool alternative with nested
nearest-file-wins semantics, used by 60k+ open-source projects and stewarded by the Linux Foundation.
Sources: https://code.claude.com/docs/en/memory ,
https://agents.md/ .
**Offline viability.** Perfect: plain files, read by the agent runtime; no services, no network. DSH has
`@deepseek-ai/dsh-agent-instructions` shipped (dsh runtime `package.json:19`) and skill-file
conventions; a plugin could reuse the same idea but must not rely on `AGENTS.md` being loaded unless the
host package is active.
**Strengths.** Human-editable, diffable, versionable, trivially inspectable; users already understand
"README for agents"; hierarchy gives scoping for free.
**Failure modes.** Static (no learned state), grows without bound (Claude Code warns past ~200 lines /
4 MiB skip), conflicts between two files are resolved arbitrarily, no provenance, no freshness, easy to
leak secrets into a committed file.
**Applicability.** High as a *rendering/export* choice for Confluence (write a human-readable
workspace board file), low as the primary mechanism (no write-back semantics, no watermarks).

#### A2. `.cursor/rules` (`.mdc` with frontmatter)

**Mechanism.** Cursor supports project rules as `.mdc` files under `.cursor/rules` with frontmatter
controlling application (`alwaysApply`, `globs`, `description`, or manual `@`-mention); rules are
version-controlled and merged with user/team rules; `AGENTS.md` is offered as the simple alternative.
Source: https://cursor.com/docs/rules .
**Offline viability.** Perfect (local files). DSH's own `skills` and `.dsh` prompts occupy the same
conceptual space, so Confluence should not create a third instruction-file format.
**Strengths.** Scoping by path, explicit application mode, team-shareable.
**Failure modes.** Conflicting rules, stale copies, no runtime state, user-editable only.
**Applicability.** Low/optional: only as a *documented convention* if Confluence mirrors its board to a
Markdown file users can also read/edit (then reconcile edits with a checksum/watermark).

#### A3. "Memory bank" / shared-notes directory (community convention)

**Mechanism.** A community pattern (Cline/other tools' "memory bank") keeps a small set of Markdown files
in the repo (project brief, architecture, progress, decisions) that the agent reads and updates across
sessions; it is a convention over plain files, not a spec.
**Offline viability.** Excellent, but it has no authoritative spec and no enforcement; `HYPOTHESIS:`
many variants exist and users must be taught the layout.
**Strengths.** Cheapest possible shared memory; inspectable; works with any agent.
**Failure modes.** Unbounded stale prose, no watermarks, no dedupe, no provenance, overwriting races when
two sessions edit; quality depends entirely on prompt discipline.
**Applicability.** Medium: Confluence can adopt the *shape* (a small, curated, workspace-level Markdown
view) while making it a **derived, regenerated** artifact of structured board data — never the source of
truth (avoid two writers to one prose file).

### B. Local-first stores

#### B1. MCP knowledge-graph memory server (`@modelcontextprotocol/server-memory`)

**Mechanism.** A local MCP server stores a knowledge graph of entities (name, entityType, observations)
and directed relations in a **JSONL file** (`memory.jsonl`, configurable via `MEMORY_FILE_PATH`), exposes
tools `create_entities`, `create_relations`, `add_observations`, `delete_*`, `read_graph`,
`search_nodes`, `open_nodes`, and a `memory://knowledge-graph` resource whose mutations emit resource
update notifications. Saves are **atomic** (write temp file in same directory, rename over), and
concurrent writers are serialized with a **lock file** `<memory file>.lock` (exclusive creation, stale
lock broken after 30 s; a write that cannot lock within 60 s fails rather than overwriting).
Source: https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md (MIT).
**Offline viability.** High — it is exactly a local process + local file. In a DSH plugin the MCP server
would be redundant: the plugin itself is in-process and can implement the same file discipline with no
extra process/port.
**Strengths.** Proven simple format; atomicity + cross-process locking is the right level of rigor for a
multi-window desktop app; entities/observations/relations is a serviceable minimal schema; read_graph vs
search_nodes separation keeps token cost controllable.
**Failure modes.** Whole-graph rewrite per write (O(n) I/O and O(n) token reads if misused), no
watermarks/provenance, search is substring-ish (no ranking beyond name/type/observation match),
unbounded graph growth, no per-item budget/redaction, secrets can land in observations.
**Applicability.** **High for mechanism, low for format**: copy atomic-rename + lock-file + JSONL
discipline; keep Confluence's items typed and bounded rather than a free graph.

#### B2. Basic Memory (Markdown source of truth + SQLite index + MCP)

**Mechanism.** "File-first architecture": all knowledge is standard Markdown documents (entities,
`- [category] observation`, `- relation [[Other]]`), a local database is a secondary index and full-text/
semantic search layer, a file watcher keeps them in sync, and an MCP server exposes read/write tools to AI
clients. Local-first, no cloud dependency required; licensed AGPL-3.0.
Sources: https://docs.basicmemory.com/raw/welcome.md ,
https://docs.basicmemory.com/raw/reference/technical-information.md .
**Offline viability.** High for the file-first half; the semantic layer is optional. `HYPOTHESIS:` the
sync/watcher and DB engine make a direct port heavy; the *architecture* (files authoritative, index
derived and rebuildable) maps 1:1 onto DSH's "session log is source of truth, plugin state is derived
cache" rule.
**Strengths.** Knowledge is owned/inspectable/edit-in-any-editor; index can be rebuilt; provenance via
file paths; git-friendly.
**Failure modes.** Two writers to Markdown → merge pain; AGPL-3.0 is incompatible with a permissive
Confluence license unless the code is not copied (pattern only); semantic search needs embeddings; sync
drift.
**Applicability.** **High as architecture inspiration** (derived index over authoritative files), low as
a dependency (license + scope).

#### B3. Plain Markdown / Obsidian vault

**Mechanism.** A directory of Markdown files with `[[wikilinks]]`, YAML frontmatter and folders; the
vault is the source of truth and any tool that can read files can participate. Obsidian itself adds no
required server.
Source: (well-established; vault format is plain files — no authoritative spec fetched here).
**Offline viability.** Perfect for a DSH plugin: the workspace is already a directory; a `.confluence/`
folder or a single board file needs no service.
**Strengths.** Zero dependency, human-readable, editable, works with existing tools, trivially exportable.
**Failure modes.** Concurrency/merge conflicts, no schema validation, no atomic multi-item update, no
index, users can break the format, secret leakage into repo files, no dedupe/watermark.
**Applicability.** High for the **user-facing mirror/export** of the board; risky as the only store when
multiple DSH windows write concurrently.

#### B4. SQLite / FTS5

**Mechanism.** SQLite is an in-file relational database; FTS5 is a virtual-table module providing
full-text indexing and `MATCH` queries with BM25 ranking (`bm25()`, `rank`), prefix/phrase/NEAR queries,
tokenizer configuration, and contentless/external-content tables. FTS5 has shipped in the SQLite
amalgamation since 3.9.0 (2015). Source: https://sqlite.org/fts5.html .
DSH itself uses this shape: `@deepseek-ai/dsh-session-query-sqlite` is installed
(installed runtime `package.json:249`; live config row `include:session-query-sqlite`), and the
experimental session-search bundle opens an isolated `:memory:` index lazily on first search
(`...\dsh-experimental-session-search\cordis.patch.yml:1-14`).
**Offline viability.** High: a single local file, no server. A third-party plugin can either use the
host's `sessionQuery` service (best) or open its own DB. `HYPOTHESIS:` the Node runtime in DSH Desktop
exposes a usable SQLite binding (`node:sqlite` or better-sqlite3 transitively) and a plugin may not be
able to add native deps offline; verify in round 2 (dsh-researcher). Prefer storage-domain + linear scans
for the board unless scale proves otherwise.
**Strengths.** Real concurrency semantics (WAL), transactional multi-row updates, real FTS ranking,
bounded queries, crash-safe.
**Failure modes.** Schema/migration drift; opaque to humans (needs an export); file locking on network
drives; overkill for a few hundred board items; plugin build/native-module risk.
**Applicability.** **Medium**: reuse DSH's `sessionQuery` instead of adding DBs; an FTS index over the
board is a later optimization, not a v1 requirement.

#### B5. JSONL append-only log

**Mechanism.** One JSON object per line appended to a file; readers tail/scan and tolerate malformed
lines; compaction is a separate rewrite. Trivially language/version tolerant.
DSH itself uses JSONL session logs (`session.v4.jsonl.zstd`) and Crisp's status page reads a bounded
tail of its own JSONL log (`lib/status.js:98-128`, `:281-288`).
**Offline viability.** Perfect; no services; append is cheap; works across processes with `O_APPEND`
semantics for small writes `HYPOTHESIS:` atomicity across multiple DSH windows must be tested.
**Strengths.** Simplest durable event-sourced substrate; tolerant parsing; cheap appends; easy to ship
and debug; good fit for watermarks (`lastSeq`).
**Failure modes.** Unbounded growth (needs compaction/rotation), no indexed queries, partial lines on
crash, duplicate/reordered writes across processes, whole-file rewrites for edits, no built-in schema.
**Applicability.** **Highest** for Confluence's board/event record: append-only, per-workspace file behind
a lock; entries are typed, timestamped, provenance-tagged; watermarks per reader; compacted into a
snapshot file when large.

#### B6. CRDT libraries (Yjs, Automerge)

**Mechanism.** Yjs exposes shared types (Map/Array/Text/XML) as CRDTs that merge automatically across
clients offline; Automerge is described as "a local-first sync engine for multiplayer apps that works
offline, prevents conflicts" — documents are JSON-like data plus commit history, repositories manage
storage/networking, and any two documents can always be merged.
Sources: https://docs.yjs.dev/getting-started/working-with-shared-types (nav verified),
https://automerge.org/llms.txt , https://automerge.org/docs/reference/concepts/ .
**Offline viability.** Mechanically yes (pure JS, files), but a DSH plugin would have to add a CRDT
runtime, its binary document format, and a sync/storage adapter — new dependencies and a new data model
in a plugin that is supposed to stay small.
**Strengths.** True concurrent multi-writer merge without coordination; good for text/board co-editing;
automatic conflict resolution.
**Failure modes.** Complexity and debugging cost; binary/opaque state (poor inspectability); sync
protocol or at least a document-store discipline needed; merge semantics are not "latest decision wins"
business logic; bundle size; DSH multi-window may be one process anyway, making CRDT overkill.
**Applicability.** **Avoid in v1.** Revisit only if real multi-window concurrent co-editing of the board
is required and file-lock+watermark proves insufficient.

### C. Multi-agent coordination patterns

#### C1. Blackboard architecture

**Mechanism.** Independent specialist "knowledge sources" read and write a shared data structure (the
blackboard) and a control component decides which source acts next; coordination happens through the
shared state rather than direct messages. Canonical description:
https://en.wikipedia.org/wiki/Blackboard_system (article body could not be fetched here; definition
summarized).
**Offline viability.** Ideal for Confluence: the board is a local data structure; no messaging fabric.
**Strengths.** Decouples producers/consumers (sessions need not know each other); naturally workspace-
scoped; supports heterogeneous item types; easy to explain.
**Failure modes.** Without a control component, everyone dumps into the board and it becomes noise;
stale items; no awareness of "who is acting now"; requires ranking/budgeting.
**Applicability.** **Adopt the semantics** (typed blackboard items + a "digest/control" layer that decides
what enters a prompt) without a literal blackboard framework.

#### C2. Linda tuple spaces

**Mechanism.** A shared associative memory of tuples; agents `out`/`in`/`rd`/`inp` tuples matched by
pattern, decoupling in space and time. Shifts coordination from messages to shared data.
Canonical description: https://en.wikipedia.org/wiki/Linda_%28coordination_language%29 (body could not be
fetched here; definition summarized).
**Offline viability.** Implementable as an in-memory/file-backed store, but it is a full coordination
substrate — too much for a plugin whose goal is sharing notes, and DSH already has agent messaging.
**Strengths.** Elegant producer/consumer handoffs; expressive matching; time-decoupled.
**Failure modes.** Opaque to users; hard to bound token cost; no provenance/trust model; overkill.
**Applicability.** **Adapt only for handoff/work-queue records** (typed items with claim/status), not as a
general runtime.

#### C3. Publish/subscribe event bus

**Mechanism.** Producers publish typed events; subscribers receive them; the bus decouples and can be
durable or ephemeral. DSH exposes exactly this at host level: `session/event`, `session/created`,
`agent/status`, `domain/changed`, `tools/result`, `workspace/session-stop`, `turn/end`-class durable
events (catalog verified via `Event.listEvents`; see prior-art doc §1.1).
**Offline viability.** **Native**: no network transport needed inside one host process; `ctx.on(...)` /
`ctx.effect` for lifecycle.
**Strengths.** Already the runtime's coordination mechanism; durable events give ordering; no polling.
**Failure modes.** Live-only (nothing across processes unless DSH shares one host); fire-and-forget
`session/event` can be missed by a late subscriber; event floods; must choose durable events
(`turn/end`, `assistant/message`, `tool/result`) per DSH `practices.md`.
**Applicability.** **Adopt**: feed board updates/digest invalidation from durable host events; never poll.

#### C4. Mailbox / actor messaging

**Mechanism.** Each agent has an inbox; senders enqueue messages; the receiver processes them later,
with serialization per recipient. DSH has concrete equivalents: `agent.inject()` (does not wake),
`agent.followup()` (wakes the agent), `ctx.subagents.sendMessage(...)`,
`ctx.agentTeams.sendMessage(...)`; Claude Code implements cross-session messaging as plain text over a
**per-session Unix domain socket** (macOS/Linux) or **named pipe** (native Windows), never through
Anthropic servers for same-machine delivery, with `ListAgents`/`SendMessage` tools, inbound
`accept | hold | refuse`, ~1M-character size cap, burst refusal, rate-limiting/identical-repeat drops and
a "a message never counts as approval" rule.
Sources: DSH service signatures (prior-art doc §1.1); Claude Code docs
https://code.claude.com/docs/en/cross-session-messaging.md .
**Offline viability.** For Claude Code: same-machine delivery is local IPC — offline in the network sense.
For a DSH plugin: within one host process, `agent.inject/followup` is trivially offline; across DSH
windows, a named pipe/socket or a shared file mailbox is needed (a local IPC endpoint is not a network
port, but the team brief says "no extra listening port" — see risks).
**Strengths.** Immediate steering/notification; exact recipient; proven UX in Claude Code (dim one-line
preview, expand to full text); explicit inbound controls solve trust.
**Failure modes.** Messages are not durable state (no searchable memory), loops, bursts, spam, attention
cost, cross-process transport complexity, ambiguity between "message" and "shared knowledge".
**Applicability.** **Adapt for live "notify/handoff" only**, backed by durable board items so a missed
message is still discoverable; do not build a chat bus as the core.

#### C5. Event sourcing + watermarks

**Mechanism.** Every state change is captured as an event appended to a log; current state is a
projection of the log, rebuildable and replayable; consumers track a position/cursor ("watermark") to
process each event once. Sources: https://martinfowler.com/eaaDev/EventSourcing.html ; DSH's own
projection/cache design follows the same shape (prior-art doc §1.1, §1.5).
**Offline viability.** **Native**: files + cursor integers; no services.
**Strengths.** Exact dedupe ("did this session already get item X?"), deterministic digests, restart
recovery, rebuildable derived views, auditability; aligns with DSH's "session log is source of truth"
principle.
**Failure modes.** Log growth/compaction; projection bugs; event schema evolution (need tolerant readers);
watermark loss causes re-injection; events from other sessions may be incomplete (a session can be
archived/deleted).
**Applicability.** **Adopt as the core discipline**: every board mutation is an event; each session keeps
a `lastSeenSeq` watermark per workspace; the digest is a pure function of (events, watermark, budget).

#### C6. Work queue / handoff

**Mechanism.** Durable items with status (`todo|claimed|done`), owner, and timestamps; consumers claim
atomically (compare-and-set), enabling handoff between workers without direct messaging. DSH's
`agentTeams` task board is exactly this within a session family (`createTask`, `updateTask`,
`getTask`, `waitForChange` signatures verified; see prior-art doc §1.1).
**Offline viability.** Native (a table/file + CAS); DSH storage-domain `update` can provide CAS
`HYPOTHESIS:` verify exact atomic semantics in round 2.
**Strengths.** Human-visible, survives restarts, no live recipient needed, provenance natural.
**Failure modes.** Stale claims/leases; UI needed to inspect; not every shared fact is a task.
**Applicability.** **Adopt a light version**: board item types `decision | finding | change | warning |
handoff`, with `status`/`owner`/`updatedAt`; do not build a full scheduler.

### D. Agent frameworks' cross-session memory

#### D1. LangGraph checkpointer + long-term store

**Mechanism.** LangGraph separates per-thread persistence (checkpointers: full graph state scoped to one
thread) from cross-thread long-term memory (stores: namespaced key-value data accessible from any
thread, e.g. namespace `(user_id, "memories")`, `put`/`search` with limit; `InMemoryStore` for dev and
`PostgresStore`/`MongoDBStore`/`RedisStore`/`UpstashStore` for production; semantic search requires
configuring an embedding model).
Source: https://docs.langchain.com/oss/javascript/langgraph/stores.md ,
https://docs.langchain.com/oss/javascript/langgraph/checkpointers.md .
**Offline viability.** The *concept* is perfect (namespace + put/search); the *implementations* are
server/DB-backed by default. `InMemoryStore` is not durable; a plugin could implement a file-backed
store with the same API shape.
**Strengths.** Clean separation of "conversation state" vs "shared memory"; namespaces map naturally to
workspace scoping; explicit limits.
**Failure modes.** Backend-required durability, embedding dependency for semantic mode, silent truncation
past `limit` (documented), ordering differs per backend.
**Applicability.** **Adapt the interface idea** (workspace namespace + bounded search), implement over
local files/DSH storage, never add their backends.

#### D2. CrewAI unified memory

**Mechanism.** One `Memory` class replaces short/long/entity memory: `remember()` uses an LLM to infer
scope/categories/importance, stores in a hierarchical scope tree (`/project/alpha`,
`/agent/researcher`), `recall()` ranks by composite semantic+recency+importance score, consolidates
near-duplicates via LLM decisions; default backend LanceDB under `./.crewai/memory`; supports Ollama for
fully local LLM+embedder (explicitly documented).
Source: https://docs.crewai.com/v1.15.22/en/concepts/memory.md .
**Offline viability.** Only if both LLM and embedder are local (Ollama) and storage is local; the default
path calls OpenAI and requires an embedding model — incompatible with "no network, no extra service"
unless DSH supplies a local model, which it does not as an embedding service (`HYPOTHESIS:` no embedding
service in the installed profile; verified service list has no embedding service).
**Strengths.** Rich scoping and consolidation; good vocabulary for per-agent private vs shared memory;
explicit privacy note (content goes to the configured LLM).
**Failure modes.** LLM/embedding dependency, cost/latency, consolidation mistakes erasing facts, opaque
database, model-bound nondeterminism.
**Applicability.** **Avoid**: too heavy and network-shaped; borrow only `scope/read-only slice` framing
(workspace shared vs session private).

#### D3. AutoGen `Memory` protocol

**Mechanism.** A small protocol — `add`, `query`, `update_context`, `clear`, `close` — implemented by
`ListMemory` (chronological list appended to model context), `ChromaDBVectorMemory` (persistent local
Chroma), `RedisMemory` (server), and a Mem0 integration; retrieved memories are inserted as a system
message before the model step.
Source: https://microsoft.github.io/autogen/stable/_sources/user-guide/agentchat-user-guide/memory.ipynb.txt .
**Offline viability.** `ListMemory` yes; ChromaDB local yes-ish (new dependency + local persistence);
Redis no.
**Strengths.** Tiny, comprehensible interface; chronological inject is deterministic and cheap.
**Failure modes.** Chroma persistence/schema churn; vector search requires embedding calls (the notebook
uses SentenceTransformer locally — feasible but heavy); memory is per-agent unless shared explicitly.
**Applicability.** **Adapt the interface shape** for Confluence's optional tool API, not the backends.

#### D4. Mem0 Open Source

**Mechanism.** Same memory engine as the hosted product, runnable as a library (`pip/npm mem0ai`,
`Memory()`) or a self-hosted server stack; library defaults are OpenAI `gpt-5-mini` + OpenAI embeddings
+ local Qdrant at `/tmp/qdrant` + SQLite history at `~/.mem0/history.db`; server defaults use
Postgres+pgvector.
Source: https://docs.mem0.ai/open-source/overview.md .
**Offline viability.** The *library with local components* can be offline if the LLM/embedder are local,
but by default it calls OpenAI; the server mode is out of scope. `HYPOTHESIS:` a fully local Mem0
configuration is possible but adds an embedding model + vector store + extraction LLM to a DSH plugin.
**Strengths.** Extraction/dedupe pipeline is valuable prior art; local vector store option.
**Failure modes.** LLM extraction is nondeterministic and costly; defaults require network; data is
opaque; overkill for bounded board items.
**Applicability.** **Avoid in v1.** Copy the *idea* of importance/recency scoring only if digest ranking
needs it (deterministic rules preferred).

#### D5. Zep / Graphiti

**Mechanism.** Zep is presented as "agent memory at enterprise scale", with Graphiti as its graph-based
memory layer; the Graphiti quick start documents installation, environment variables and graph/search
workflows (page TOC verified: Installation, Alternative LLM Providers, Environment Variables, Getting
Started with Graphiti, Adding Episodes, Search recipes).
Source: https://help.getzep.com/v3/graphiti/getting-started/quick-start .
**Offline viability.** `HYPOTHESIS:` self-hosted Zep requires its own service deployment and a graph
database, and Graphiti extraction uses an LLM; this is architecturally the opposite of an in-process,
no-server DSH plugin. (The rendered page body was not retrievable here; only the structure was.)
**Strengths.** Temporal knowledge graph, episode ingestion, provenance, enterprise features.
**Failure modes.** Deployment/ops burden, external DB, LLM calls, no offline story for a desktop plugin.
**Applicability.** **Avoid.** Its "episodes + temporal validity" vocabulary is worth noting for board
item lifecycle (superseded/when-valid) but not its stack.

#### D6. Letta

**Mechanism.** Letta's docs organize persistent agent state around **memory blocks** (core memory),
**archival memory**, **shared memory** and a **context hierarchy** — i.e., server-side stateful agents
whose memory is edited through the platform's tools/API rather than files in the user's workspace.
Verified: docs navigation/page titles at
https://docs.letta.com/v1-sdk/memory/memory-blocks ,
https://docs.letta.com/v1-sdk/memory/shared-memory ,
https://docs.letta.com/v1-sdk/memory/context-hierarchy (article bodies not retrievable here; mechanism
therefore `HYPOTHESIS:`-limited).
**Offline viability.** The published product is a server/runtime for stateful agents; not a drop-in
pattern for a DSH plugin without that runtime (out of the "DSH provides everything locally" constraint).
**Strengths.** Clear separation of always-in-context blocks vs archived memory vs shared blocks; good
vocabulary and UI ideas.
**Failure modes.** Requires the Letta runtime/store; agent memory lives outside the user's workspace
(inspectability, portability); no natural workspace scoping.
**Applicability.** **Adapt vocabulary** ("blocks" ≈ digest sections; "shared" vs "private" scopes), avoid
the runtime.

#### D7. Claude Code: CLAUDE.md + auto memory + subagents + cross-session messaging

**Mechanism.** Four mechanisms coexist: (a) `CLAUDE.md` hierarchy loaded every session; (b) **auto
memory** — Claude writes its own Markdown notes to `~/.claude/projects/<project>/memory/` with a
`MEMORY.md` index (first 200 lines/25 KB loaded each session), machine-local, shared across worktrees of
the same git repository, subagents do **not** get the main auto memory; (c) subagents run in a fresh,
isolated context window (they *do* get CLAUDE.md files and a sibling roster, but not the main
conversation or its auto memory); (d) **cross-session messaging** — `ListAgents`+`SendMessage` over a
local Unix socket/named pipe, plain text only, inbound `accept|hold|refuse`, size/burst/loop limits.
Sources: https://code.claude.com/docs/en/memory ,
https://code.claude.com/docs/en/sub-agents.md ,
https://code.claude.com/docs/en/cross-session-messaging.md .
**Offline viability.** All four are local-first; even cross-session messaging is same-machine local IPC
(one socket/named pipe per session), never a cloud round trip for local targets.
**Strengths.** Validates the exact pain point at industry scale: sessions can *warn each other* about
breaking changes, hand over findings, coordinate parallel worktrees; auto memory demonstrates
agent-written, human-inspectable memory with an index and a hard load budget; isolation-by-default for
subagents.
**Failure modes.** Messages are text, not durable searchable memory; auto memory is machine-local and
per-repo (not per-workspace in DSH's sense); main memory is not shared with subagents; plain text only;
sockets add a transport surface.
**Applicability.** **High**: it independently confirms (i) cross-session sharing is a real, generic need;
(ii) `message` is not the same as `shared memory`; (iii) trust rules matter (a message is not user
approval); (iv) a bounded `MEMORY.md`-style index is a proven token discipline. Confluence should not
copy the socket transport; inside one DSH host, host events + shared durable board are simpler and safer.

#### D8. DSH's own session-reference

**Mechanism.** Exact-read, bounded, immutable cross-session snapshots injected as untrusted context after
a user `@`-mention; titles/cwd for candidate discovery; `capturedThroughSeq` provenance; fixed
no-instructions warning (see prior-art doc §1.2 and
https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-reference.md ).
**Offline viability.** Native, already in the profile.
**Strengths.** Proven trust framing, byte budgets, immutability, provenance.
**Failure modes.** User-triggered only, per-message, no durable shared state, text-only, ≤3 references.
**Applicability.** **Complement, do not duplicate**: Confluence's digest should reuse the untrusted
framing and provenance vocabulary, and link items back to source sessions rather than inlining whole
transcripts.

---

## 3. Applicability matrix (decision-oriented)

Legend: **Adopt** = use now; **Adapt** = use the idea with different plumbing; **Defer** = optional later;
**Avoid** = do not use for Confluence.

| # | Pattern | Offline fit in a DSH plugin | Workspace-scope fit | Multi-window/concurrency fit | Token cost | Verdict |
|---|---|---|---|---|---|---|
| 1 | JSONL append-only board + atomic rename + lock file (MCP-memory discipline) | High — files only | High (one file per workspace key) | Medium — needs lock protocol; proven local precedent | Controllable (tail/scan) | **Adopt** |
| 2 | Event sourcing + per-session watermarks | High — integers + files | High | High — readers independent | Excellent (dedupe) | **Adopt** |
| 3 | DSH storage domains (`storageDomain`) for config/watermarks/board index | High — runtime service | High (workspace id key) | **No cross-process lock; `domain/changed` is in-process only** (teammate `docs/research/dsh-internals.md` §3.3) → treat as derived cache, not the authoritative log | Low | **Adopt** (plus `dsh-atomic-write` lock for the log) |
| 4 | Durable host-event subscriptions (`turn/end`, `assistant/message`, `tool/result`, `domain/changed`) | High — in-process | High | Good within one host | Low | **Adopt** |
| 5 | Bounded passive digest via `systemPrompt.context` | High | High | N/A | Hard-capped (≤400–800 tok) | **Adopt** |
| 6 | Untrusted-context framing + provenance labels (session-reference) | High | High | N/A | Fixed small cost | **Adopt** |
| 7 | Blackboard semantics (typed items, status, owner, control/digest layer) | High | High | Good | Low | **Adopt** |
| 8 | Mailbox/notify (`agent.inject`/`followup`; local IPC if cross-process) | High (per process); IPC adds surface | Medium | Medium | Low per event | **Adapt** (notify only, durable fallback) |
| 9 | Work queue / handoff items with claim/CAS | High | High | Good (CAS risk) | Low | **Adapt** (light) |
| 10 | Markdown mirror/export for inspectability (CLAUDE.md/AGENTS.md/memory-bank style) | High | High | Low (derived artifact, avoid two writers) | Low | **Adapt** |
| 11 | SQLite/FTS5 board index | High if a binding is available; host `sessionQuery` exists for exact reads but its FTS is disabled (`openAt: 'never'`) in the default profile | High | Good | Medium | **Defer** (board is small; reuse `sessionQuery` exact reads; FTS only if needed) |
| 12 | Vector/embedding memory (RAG; CrewAI/Mem0/AutoGen Chroma/LangGraph semantic) | Low — needs embedding model/service | Medium | Medium | High (embedding + retrieval) | **Avoid** |
| 13 | External memory servers (Mem0 server, Zep/Graphiti, Letta runtime, LangGraph Postgres/Redis stores) | None — servers required | N/A | N/A | N/A | **Avoid** |
| 14 | CRDT co-editing (Yjs/Automerge) | Medium — pure JS but new runtime/format | Medium | High (true merge) | Low | **Avoid in v1 / Defer** |
| 15 | Full Linda tuple space | Medium — custom substrate | Low | Medium | Medium | **Avoid** |
| 16 | Cross-session chat/messaging transport (Claude Code sockets) | High only as local IPC; adds a listening endpoint | Medium | High | Low | **Avoid in v1** (constraint: no extra port; host events first) |
| 17 | Static instruction conventions (`CLAUDE.md`/`.cursor/rules`/`AGENTS.md`) | High | High | Low (human-edited) | Medium (loaded every session) | **Adapt** (documentation/mirror only) |

---

## 4. Recommendation (prioritized)

### P0 — Adopt now (core design)

1. **Event-sourced workspace board.** One append-only log per canonical workspace key
   (`.dsh/storages/confluence/<workspace-key>/board.jsonl` or a DSH storage-domain table), each record
   `{seq, ts, type: decision|finding|change|warning|handoff|note, text, provenance:{sessionId, sessionTitle,
   turn, eventSeq}, status, owner?, supersedes?, redacted?}`. Writes go behind **`withFileLock` from
   `dsh-atomic-write`** (a sibling `.lock` file with holder PID and dead-process takeover — the shipped
   cross-process primitive the internals research verified; see `docs/research/dsh-internals.md` §3.3),
   and derived snapshots are published with `writeFileAtomic`. No server, no port.
2. **Watermarks as the dedupe/read model.** Each session stores `lastSeenSeq` per workspace; the passive
   digest is a pure, deterministic function of (board records > watermark, budget, ranker). This is the
   only way to satisfy the team brief's "avoid repeated identical injections" requirement.
3. **Durable host events as the update trigger.** Subscribe only to durable outcomes documented in DSH
   `practices.md` (`turn/end`, `assistant/message`, `tool/result`, `domain/changed`, `session/disposed`);
   never poll; never rely on `session/event` for correctness (its emit mode can be missed).
4. **Bounded passive digest via `ctx.systemPrompt.context`** with a synchronous `text(ctx)` provider (the
   API shape verified in the team brief; runtime `AssembleContext` details in
   `docs/research/dsh-internals.md` §2.1) plus a hard token/byte cap (default 400–800 tokens), section
   headings, and untrusted-background framing copied conceptually from session-reference. Make the digest
   **byte-deterministic** so identical text is not re-committed (host behavior verified by the internals
   research) and include source session labels/ids so the model can ask for more and a future UI can open
   the source.
5. **DSH storage domain for plugin config/watermarks/index metadata** (versioned `DomainSpec`, tolerant
   readers, `domain/changed` for same-process notification). Keep the append log as the human-debuggable
   source of truth; the domain holds derived state only — it has no cross-process write lock and its
   change event does not cross processes (`docs/research/dsh-internals.md` §3.3), so it cannot be the
   sole authority for multi-instance safety.
6. **Markdown/report mirror (optional but recommended).** Render the board to a human-readable Markdown
   document on demand (or on every N events) for inspectability, git diffing and export — derived, never
   the source of truth; avoid a second writer.

### P1 — Adapt (bounded scope)

7. **Blackboard "control layer" = digest ranker.** Not everything on the board enters prompts: rank by
   type priority (decision/warning first), recency, and explicit `pin`/`important`; cap per type. This is
   the blackboard control component, implemented as deterministic rules (no LLM call).
8. **Handoff/queue records.** `handoff` items with `status: open|claimed|done`, claim CAS via storage
   domain `update` (verify atomicity) or lock file; a tool for the model to claim/complete. This covers
   the "work queue" use case without a scheduler.
9. **Explicit share/capture tool.** A model-facing tool (e.g. `confluence_share`) that appends a typed
   record with the same schema as passive detection. This is the deliberate, user-visible path; passive
   detection should be conservative.
10. **Notify, not chat.** For live awareness use `agent.inject()` (does not wake) or `agent.followup()`
    only for genuinely actionable handoffs, sourced from durable board records so a missed notification
    is never lost. Do not build a general cross-session chat transport in v1 (no extra port; host events
    suffice while one host process serves the windows — `HYPOTHESIS:` confirm with dsh-researcher).
11. **Optional UI later:** `/confluence` client slash command via `inputTriggers` (dsh-context pattern) →
    `main`+`sidebar.panellist` page (Crisp pattern) → `betterSidebar.registerTab` when present. Any host
    route must sit on the existing `webServer` behind `connection.requestRejection` (Crisp precedent).

### P2 — Defer / optional

12. **FTS/vector over the board.** Defer: a few hundred bounded items are cheap to scan linearly. If it
    grows, add SQLite FTS (or delegate search to `ctx.sessionQuery` for session history, which already
    exists). Vector/embedding search: no.
13. **CRDT co-editing** only if multi-window concurrent editing of a rich board becomes a real
    requirement and the lock+watermark design demonstrably fails.
14. **Rich UI dashboards:** do not compete with `dsh-context`; contribute data, not another insights page.

### Avoid

15. Any memory server, database server, message broker, external vector DB or graph DB (Mem0 server,
    Zep/Graphiti, Letta runtime, LangGraph Postgres/Redis stores, Redis memory).
16. LLM/embedding-based extraction, consolidation, importance scoring or relevance ranking in the hot
    path — it violates determinism, offline assumptions, and token economics. Deterministic ranking only.
17. Network calls of any kind, child processes, extra listening ports, or an iframe-served page.
18. Re-implementing session-reference, session search, transcript browsing, or remote sharing.

---

## 5. Open questions / risks

- **Resolved by teammate internals research** (`docs/research/dsh-internals.md` §3.3): multi-window is
  *not* automatically multi-process safe — `storage-json` has no cross-process write lock (last-completion
  wins), `domain/changed` is in-process only, and a second process's domain handle keeps its own
  in-memory snapshot until reopened. DSH ships `dsh-atomic-write` (`writeFileAtomic`,
  cross-process `withFileLock` with dead-PID takeover), so the design must put the authoritative board
  behind `withFileLock` and make entries append-only/idempotent. **Remaining unknown:** whether one
  Desktop app instance is always one Host process (internals doc marks topology as `HYPOTHESIS:`); design
  for separate processes anyway.
- **Resolved by teammate internals research** (`docs/research/dsh-internals.md` §2.1/§7): a
  `systemPrompt.context` provider runs at assembly time and its snapshot message is **not re-committed
  when the text is identical** (`dsh-agent-loop/lib/index.js:333-348`), which the internals doc calls out
  as built-in dedupe. Design consequence: make the digest byte-deterministic so unchanged digests cost no
  extra messages; still cache the fold (derive on write/event) rather than recomputing expensive state on
  every request. The exact `AssembleContext` shape (`{agent, scope: agent, signal, modelSelection,
  toolSet}`) is documented there — the per-session watermark must be resolved from `agent`/scope
  explicitly, not assumed to be a bare session id.
- `HYPOTHESIS:` no first-party embedding service exists in the installed profile: the live service
  directory returned by `Service.listService` was truncated (53 KB omitted) so absence was not proven —
  dsh-researcher should confirm before any local semantic search is considered. The current recommendation
  does not depend on this: deterministic ranking avoids the question entirely.
- Risk: **prompt injection via shared items.** Cross-session text is attacker-influenced content. Copy the
  session-reference stance: fixed untrusted warning, no permission claims, no tool requests, and never
  let board content trigger side effects. `HYPOTHESIS:` deterministic redaction (regex for keys/tokens)
  is sufficient only as a backstop; explicit publish should be the default for content-bearing items.
- Risk: **privacy.** Workspace sessions may contain secrets; the board must be local-only, bounded, and
  default to metadata-level items (decisions, file paths, warnings) rather than transcripts. Never
  auto-include file contents in a passive digest.
- Risk: **unbounded growth & compaction.** Need rotation/compaction policy (snapshot + truncate with
  `supersedes` links), and a cap on total board bytes per workspace; otherwise the digest/read path and
  the markdown mirror degrade.
- Risk: **watermark loss/staleness.** A deleted/archived source session leaves orphan provenance; a
  wiped watermark re-injects everything. Design idempotent injection (stable item ids, dedupe by id
  before seq) and tolerant handling of missing source sessions.
- Risk: **schema evolution.** Readers must tolerate unknown record types/fields (append-only JSONL with a
  `v` field; `DomainSpec.version`/`compatibleVersions` for storage-domain data). Unknown record types are
  skipped, not fatal — mirroring DSH's own unknown-event tolerance.
- Risk: **security boundary of UI routes.** If a read-only board page is added, reuse the
  `connection.requestRejection` fence and never expose other sessions' transcripts; the Crisp status
  route is the verified precedent (`lib/status.js:290-338`).
- Risk: **CLAUDE.md-style mirror becomes a second source of truth.** Users will edit it. Mitigate by
  regenerating with a header ("generated; edits are ignored/overwritten") or by importing user edits
  through explicit typed records only.
- `HYPOTHESIS:` Claude Code's cross-session messaging and DSH's session-reference are the two closest
  external validations of the need; neither provides durable, searchable, workspace-scoped shared
  knowledge — which is precisely the niche Confluence can own without duplicating them.
