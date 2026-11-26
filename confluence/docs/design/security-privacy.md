# Confluence security and privacy design (v1)

- Status: Round-3 detailed design. Binding once accepted; implements ADR-0001 §11 and round-2 R2/R5.
- Author: `design-surface`. Target: DSH Desktop 0.2.2-rc.1, profile `desktop`, Windows 11, single OS
  user, fully offline.
- Companion docs: `config.md` (knobs), `ui.md` (panel), `../adr/0004-privacy-and-consent.md`
  (consent decision), `../adr/0005-ui-transport.md` (channel controls), `../adr/0002-store-format-and-concurrency.md`
  (durability/merge), `../adr/0003-pulse-and-watermarks.md` (what reaches model context).

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md)).** The
> sharing boundary moves from the **workspace** to the **DSH profile/machine**. Within one profile,
> shared memory is readable by every session by design; `privacy.privateSessions` is the only session
> opt-out and `privacy.disabledWorkspaces` is gone. Workspace data (canonical path, key) is provenance,
> not a confidentiality boundary, and is never rendered as a raw path — only a basename label. The
> threat "cross-workspace leakage" becomes "cross-profile leakage / provenance leakage"; R17
> (workspace rename merge) is obsolete. Redaction, untrusted framing, caps, opt-outs, no-egress and
> export gates are unchanged. The v0.1.0 assets/boundaries/controls below remain as the historical
> record; read "workspace boundary" as "profile boundary" where the control still applies.

> **v0.3 amendment — workspace bus + profile visibility
> ([ADR 0008](../adr/0008-bus-and-profile.md),
> [binding contract](../plan/v0.3-interfaces.md) §1/§8).** Visibility is two-tiered. Bus data (keyed
> context, notes, messages) is readable only by sessions whose frozen workspace key matches and is
> **never merged across workspaces**; the workspace is a visibility boundary for bus data, not a
> per-directory consent switch (`privacy.disabledWorkspaces` stays removed). Profile facts, like the
> ledger and presence, remain **profile-global** and are injected into every session; the global
> journal also keeps the ledger rows and presence heartbeats. `privacy.privateSessions` keeps v0.2
> semantics and is enforced on every surface — bus, profile, pulse, ledger, presence, recall — by the
> facade. Every new write path applies `redact.js` (value/body/title); a value that redacts to empty
> fails `REDACTED`. Peer messages and notes/context values are untrusted data (wrapped, escaped,
> never followed as instructions); profile facts are user background applied as preferences. Profile
> export (JSON/Markdown) is explicit, redacted and never contains absolute paths; import is
> validated, bounded and `profile-reset`-barriered. Offline posture unchanged: no network, no extra
> port, no subprocess, no model call, no prompt scraping. The v0.2.0 statement that "everything is
> readable by every session" now applies to profile/ledger data only.

> **v0.4 amendment — learned layers: candidates untrusted until promoted
> ([ADR 0009](../adr/0009-long-term-memory-persona-style.md),
> [binding contract](../plan/v0.4-interfaces.md) §2–§3/§8).** Long-term memory and style rules are
> **profile-global** like the persona: patterns — including `workspace`-scoped ones, which are still
> stored in and readable from the global journal — and style rules are injected into matching sessions
> by design. The new trust rule: an Agent-proposed `pattern` is a **candidate** and untrusted content —
> it is never injected as a rule (only a bounded count/headline reaches the prompt) until the user
> confirms the promotion; active patterns and style rules are untrusted **background** in the prompt
> (wrapped, escaped, never followed as instructions, never a tool-call trigger). Every new write path
> (pattern body/title/tags, style rule/examples, imported documents) passes `redact.js`; a value that
> redacts to empty fails `REDACTED`. `privacy.privateSessions` still hides a session from every
> surface, including both new tool families and all three global prompt blocks. The one-time migration
> copies legacy `tech`/`context` facts into patterns — the facts stay profile-local (no new egress).
> The `confluence.memory/v1` export (persona + patterns + styles) is explicit, redacted, path-free and
> bounded; import is validated, bounded and generation-barriered (persona via `profile-reset`;
> patterns/styles via `merge`/`replace`). Offline posture unchanged: no network, no extra port, no subprocess, no model
> call, no prompt scraping, no vector store.

## 1. Assets and trust boundaries

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Board entries (title, body, tags, file hints, author session title) | `$DSH_HOME/storages/confluence/v1/workspaces/ws_0000000000000000/journal.*.jsonl` (legacy v0.1.0 workspace journals merged read-only) | High: agent/user-authored working notes, may contain secrets pasted by a user or model |
| Session ledger metadata (title, status, turn count, timestamps, effective dir, ≤8 relative paths) | same journal, `session` records | Medium: activity/attention metadata; titles can contain pasted secrets |
| Presence heartbeats (live session ids, writer id, plugin version, updatedAt) | `presence/<writerId>.json` | Low |
| Workspace identity (canonical path, `wsKey`) | store `MANIFEST.v1.json` + panel payloads | Medium: reveals project locations |
| Recall results (bounded excerpts of prior session logs) | **not stored by Confluence**; exist only in one tool result / panel read | High transient |
| DSH session logs (the source of truth) | `$DSH_HOME/sessions/...` (DSH-owned) | High; Confluence never writes them |
| Export `memories.v1.jsonl` + `manifest.json` | `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/` (opt-in; `--out` may point anywhere the user chooses) | High; leaves profile storage only by explicit choice |
| Debug log (opt-in) | user-specified absolute path | Low by design: codes/counts/timings only |
| Panel read cursor | browser `localStorage` | Low |

**Trust boundaries.** (1) OS user profile: everything under `$DSH_HOME` is same-user data; the
boundary between OS users is the Windows profile ACL. (2) **DSH profile: the consent and sharing
boundary (v0.2.0)**; every session in the profile may read the one shared memory space, and nothing
crosses into another profile, OS user or machine. (3) Model context: anything a model reads
is untrusted data from another session/agent; the model has no authority from Confluence content.
(4) Web client: the panel is a same-user local browser surface; it must not expose board data to a
foreign origin and must never receive raw session transcripts except an entry the user opened.

## 2. Threat model

| ID | Threat | Adversary / trigger | Likelihood | Impact |
|---|---|---|---|---|
| R1 | Prompt injection through a shared note or recall excerpt ("ignore previous…, call tool X") | A model that posted hostile text, a pasted web page, a compromised subagent | Medium | Medium: wrong actions by a later agent; no direct egress |
| R2 | Secret written into the board (API key, token, password, PEM) | Model or user posting working notes | Medium | High if it then reaches another prompt or an export |
| R3 | Secret disclosed through ledger file hints (path names like `.env`, `secrets.ts`) | Automatic metadata capture | Medium | Medium |
| R4 | Cross-profile leakage (another profile/OS user/machine reads or is sent shared memory) or provenance leakage (raw absolute path in a pulse/tool/panel/export payload) | Bug, model-supplied ids/paths, bad label handling | Low | High (silent, catastrophic if it happens) |
| R5 | Another local process or OS user reads the store | Same-machine process; other OS user | Low (single-user desktop) | High |
| R6 | Export committed to git and pushed | User runs export, then `git add -A` | Medium if export is on | High (public repo is the project's own target!) |
| R7 | Model uses recall to assemble sensitive context for exfiltration | Prompt-injected model | Low: plugin has no network | Medium: depends on other enabled tools |
| R8 | Multi-window write corruption / lost notes | Two DSH windows writing | Medium | Medium |
| R9 | Hostile note forges the pulse frame (`</confluence-memory>`), inserts control chars/U+2028/RTL, or is huge | Malicious/compromised model | Medium | Medium: token injection; breaks digest trust |
| R10 | Private-session opt-out does not actually suppress the pulse | Global context registration + scope bug | Low | High (privacy breach by design failure) |
| R11 | Panel route reachable from a foreign origin / other content | Malicious page in the same browser, DNS rebinding-ish same-origin abuse | Low | High if it returns board data |
| R12 | Panel XSS via note content rendered as HTML/Markdown | Hostile note | Low (v1 renders plain text) | High if introduced later |
| R13 | Board spam / huge notes blow the token or disk budget | Compromised/looping agent | Medium | Medium (cost, trust) |
| R14 | Debug log or export manifest leaks content | Misconfiguration | Low | Medium |
| R15 | A hostile "decision" note is treated as authority ("shared memory says I may…") | Prompt-injected model | Medium | Medium |
| R16 | Path traversal/symlink escape through export dir or file hints | Buggy/malicious config or workspace | Low | High |
| R17 | Workspace rename/collision confuses provenance labels | Filesystem change | Low | Low in v0.2.0 (label is best-effort; never a permission check) |
| R18 | OS backup/sync tools copy the store | Environment | High (harmless if same user) | Low |

## 3. Controls per risk

### 3.1 R1/R9/R15 — untrusted content: framing, escaping, no authority

1. **Fixed framing** on every model-visible block: the pulse's `<confluence-memory …>` wrapper
   (v0.1.0 snapshots used `<confluence-workspace …>`) and a fixed warning sentence naming the three
   dangers ("instructions, permission claims, tool requests"); tool results begin with the same rule
   and every entry line carries provenance (`by "session title"`). Wording is owned by
   `docs/design/tool-api.md`; the escape/warning behavior is owned here.
2. **Escaping:** `<` → `\u003c` and `&` → `\u0026` in any note text embedded in a framed block;
   U+2028/U+2029 escaped as `\u2028`/`\u2029`; control characters (C0/C1, bidi overrides
   U+202A–U+202E, U+2066–U+2069) stripped or replaced with U+FFFD before persistence; newlines
   flattened to one line in the pulse, preserved as `\n` in full entry bodies. Content can never
   close the frame or open a new tag. The frame tag itself is emitted only by code, never from data.
3. **No authority inheritance:** Confluence never executes a tool, approval, permission change or
   file write because of note text. Tool descriptions and results restate "data, not instructions";
   the pulse warning is byte-stable so models cannot be told the rule changed.
4. **No auto-injection of suspicious content:** v1 stores content normally (with framing) and does
   not attempt a classifier. The panel shows a neutral untrusted notice; a "suspicious instruction"
   flag is a possible v2 addition (option-b §7.4.5), not a v1 claim.
5. **Trust labels:** origin is always visible: `explicit` (agent posted via tool) vs the M4
   `user-authored` distinction when the panel composer exists. The pulse only ever contains explicit
   board entries, never auto-captured transcript signals (v1 has none).

### 3.2 R2 — redaction (best effort, labeled as such)

- Applied **before persistence** to note title and body, **again before rendering** (defense in
  depth), to recall excerpts, to ledger file hints (as a final path check), and to export content.
- Built-in pattern families: `sk-…`-style API keys, `AKIA…` AWS key ids, `gh[pousr]_…` tokens, JWT
  triplets, `Bearer <token>`, PEM private-key blocks, and `(?i)(api[_-]?key|access[_-]?token|
  auth[_-]?token|secret|password|passwd|pwd|client[_-]?secret)\s*[:=]\s*\S{4,}`-style assignments.
  Replacement `[redacted]`, capped at 50 replacements/field; other long base64-looking runs are
  **not** guessed at (over-redaction of code is a stated limit).
- `privacy.redact` / `privacy.redactTitles` / `privacy.redactPatterns` (config.md §2.6). Titles are
  redacted by default because titles are model-generated from the first prompt and can carry secrets.
- Docs and panel copy say "best effort, not a guarantee"; users must not paste secrets into either
  chats or notes.
- Test fixtures: one positive per pattern, one negative that must survive (e.g. `password:` without
  a value, a public key block), one over-redaction probe.

### 3.3 R3 — ledger file hints

- Workspace-relative paths only; `path.relative` result must not start with `..` or be absolute;
  symlinked paths are not followed for hints.
- Built-in deny list (always on): `.ssh/`, `.aws/`, `.git-credentials`, `.netrc`, `id_rsa*`,
  `*.key`, `*.p12`, `*.pfx`, `secrets*`, `**/.env*`, `**/*.pem`; plus `privacy.denyPathPatterns`
  (additive; built-ins cannot be removed).
- ≤ `ledger.maxFilesPerSession` (default 8); recorded from `tool/call` and `tool/ptc-dispatch` args
  only, with the wording "files seen in tool calls (partial)" — never "edited" or "changed".
- Hints are **off in the pulse** by default (`ledger.fileHintsInPulse: false`); the panel shows them
  because the user opened it.

### 3.4 R4 — boundary at every layer (v0.2.0: profile, not workspace)

| Layer | Rule |
|---|---|
| Consent boundary | The **DSH profile/machine** (single OS user). Within it, shared memory is readable by every session by design; nothing crosses a profile. OS-user isolation remains the Windows profile ACL. |
| Scope constant | One global scope `ws_0000000000000000` / `{key:'global', label:'All sessions'}`; it can never collide with a real workspace key. A manifest with an empty `canonicalPath` is valid only for this key. |
| Tools | Authority from `exec.agent` only; no workspace parameter exists; `privacy.privateSessions` is the only suppression. |
| Board/reply/read | All ids live in the one global board; a missing id and a merged legacy id are the same code path (`NOT_FOUND` when absent, no existence oracle). |
| Recall | `listSessions()` in the profile → drop the caller and private sessions → bounded reads; no directory filtering. `ref: session:<id>:<seq>` re-checks session readability. |
| Pulse | One global digest; no workspace label rendered; peers are all live sessions. |
| Ledger/presence | One global journal + presence files; workspace appears only as an optional `origin.workspaceLabel` basename. |
| Panel | No workspace key is ever accepted or returned; payloads carry `scope` and per-entry `workspaceLabel` (basename) only. |
| Export | Exports the global board; manifest `scope:"global"` + global `wsKey`; `origin` labels are basenames; absolute paths stripped. |
| Cross-profile | Out of scope by design: another profile's `$DSH_HOME` is a different store; the plugin has no network path to it. |

### 3.5 R7/R11 — no egress and local-only

Host half (enforced by static test): no `node:net`, `node:http`, `node:https`, `node:dns`,
`node:tls`, no `fetch`, no WebSocket, no child process spawn, no model invocation, no listening
socket. Only `node:fs`, `node:path`, `node:crypto`, `node:os` are imported. The only HTTP surface is
`ctx.webServer.register` on the existing Web server (fallback transport; ADR-0005), which adds no
port and serves only derived board data.

Client half: no absolute URL, no `http(s)://`, no `WebSocket`/`EventSource`, no `postMessage`; if the
route fallback ships, exactly one relative same-origin `fetch('/confluence/api/…')` call site, GET
only, `credentials: 'same-origin'`, `cache: 'no-store'`, no request bodies. `setOptOut` is not
available over the route (no POST).

Recall cannot exfiltrate: it returns bounded excerpts to the model's own prompt; the plugin has no
network path. The residual is that other enabled tools may still copy model context elsewhere —
documented, and outside this plugin's authority.

### 3.6 R5 — storage location and permissions

- Default root `$DSH_HOME/storages/confluence/v1` (inside the user profile, never inside a
  repository). `$DSH_HOME` = env `DSH_HOME` else `os.homedir()/.dsh` (ADR-0001 §6).
- Files/directories are created with normal process defaults, inheriting the Windows profile ACL
  (owner + Administrators + SYSTEM). No attempt to make the store world-readable or world-writable;
  on POSIX a `0o700` directory mode is applied. The store is plain text so the user can inspect,
  back up and delete it without the plugin.
- Every write is resolved under the store root (`path.resolve` + prefix check after canonicalizing
  the root); no `..` segments; the root is checked to be a directory, not a file/symlink target
  escaping the profile.
- Export is the only profile-external write and is opt-in; `--out` may place it inside a repository,
  where it inherits that ACL and is documented as leaving the profile. v0.2.0 creates no files inside
  a workspace by default.

### 3.7 R10 — opt-outs and the scoped suppressor

- `privacy.privateSessions`: at `agent/created`, a private session gets (a) no global pulse because
  the plugin installs a **scoped** `systemPrompt.suppressRuntimeContext()` on `agent.ctx` (the
  verified service method; scoping to `agent.ctx` is the round-2 R2/B requirement, HYPOTHESIS to be
  smoke-tested: the global context must be suppressed for that agent only), (b) no ledger row, no
  presence heartbeat, (c) no Confluence tools (per-agent `tools.restrict` or `when` predicate),
  (d) no recall of its log by other sessions? — other sessions may still recall its **committed
  logs** through `sessionQuery`; a private session only removes *Confluence-collected* sharing, not
  DSH's own logs. This limit is stated in the panel and README.
- There is **no workspace-level opt-out** in v0.2.0: `privacy.disabledWorkspaces` was removed with the
  workspace boundary (ADR 0007 §6). A config that still sets it produces
  `CONFIG_DEPRECATED privacy.disabledWorkspaces` and is ignored.
- Changes are re-applied to live agents on plugin activation (`ctx.agents.list()`), and the M3 panel
  toggle writes through the config editor (`config.md` §6).
- Opt-out never deletes existing records; M4 tombstone/forget is a separate explicit action.

### 3.8 Audit and transparency

- Recall calls are visible in the tool result (model side) and in the panel audit footer (user side;
  live-process only, `ui.md` §7.8).
- Activation config warnings are shown in the panel and ping payloads.
- The panel states plainly what is stored and what recall reads on demand (§4).
- No hidden telemetry: nothing is sent anywhere; the store is local plain text.

### 3.9 R6/R14/R16 — export safety

- Opt-in (`export.enabled: false` default); written only by an explicit user action; never read back
  by the plugin; deterministic order; redacted; relative file paths only; absolute/home
  paths stripped. Files: `memories.v1.jsonl` (each line `v:1` + `schema:"confluence.memories/v1"`,
  global `wsKey`, optional additive `origin`) and `manifest.json` (`schema:"confluence.memories/v1"`,
  `formatVersion:1`, `scope:"global"`); tombstoned entries are
  exported as content-free `deleted:true` stubs, never the content (`store-format.md` §14 is
  authoritative).
- **v0.2.0 location:** the default output is `$DSH_HOME/storages/confluence-exports/<UTC-stamp>/`
  (inside the profile, outside the store root); `--out` may override it. The exporter refuses a target
  inside the store root. `export.dir` is a retained v0.1.0 config field; it no longer makes the export
  write into a workspace. No files are created inside any workspace by default.
- **Repository guidance:** if a user points `--out` at a repository, they must gitignore it; the
  README and `docs/install.md` state that exports leave the profile only by explicit choice.
- `debug.logFile` is off by default; when enabled it contains codes/counts/timings/writer ids and
  config warnings only, never note bodies, recall text, prompts or tool output, and rotates at
  5 MB × 2.

### 3.10 R8 — multi-window correctness

Per-writer append-only JSONL shards written through a held `O_APPEND` file descriptor plus
`fs.writeSync` of whole lines (≤64 KiB), not `fs.appendFile`; batched `fsync`, and board posts `fsync`
before acknowledging while ledger/presence rows may lose the last record on a crash (ADR-0001 errata
E10; `store-format.md` §13). Readers merge shards sorted by `seq`, dedupe by id (`entry` first-wins,
`session` last-wins); readers ignore a trailing line without `\n` and recover on the next poll
(ADR-0002). `fs.watch` is an accelerator only; polling (`store.pollMs`) is the freshness contract.
Compaction/export are the only lease-protected operations, never the append path. Full design:
`store-format.md`; tests here assert: torn line ignored, two writers' records both survive, no shard
rewrite, deterministic merge, cap behavior.

### 3.11 R12 — panel rendering

Plain-text rendering only (React text children, `white-space: pre-wrap`), no
`dangerouslySetInnerHTML`, no Markdown renderer, no link auto-detection in v1; copy action only for
ids. Board text is never interpolated into HTML or CSS. Route responses are JSON with
`cache-control: no-store`; the client rejects non-JSON. If M4 adds Markdown, it must use a
sanitizer and pass the same hostile-note fixtures.

## 4. What is stored vs what recall reads on demand (README-ready)

> **What Confluence stores (plain text, under your DSH profile):** the notes agents or you
> deliberately post in shared memory (kind, title, body, tags, optional relative file
> hints, author session title and time, and the originating workspace name as a provenance label);
> session metadata (title, status, turn count, last activity,
> the session's effective directory, and up to 8 relative file paths seen in tool calls);
> live-session heartbeat files; and the global scope's manifest. Notes are append-only; the store
> never contains prompts, assistant messages, reasoning, tool arguments, tool outputs, command
> lines, or full transcripts.
>
> **What recall reads on demand:** when an agent explicitly calls `confluence_recall`, Confluence
> enumerates the *other* sessions in this profile (excluding private ones) and searches their existing
> DSH session logs for a literal text match. It returns at most 3 sessions' worth, at most 5 short excerpts
> (≤600 characters each), redacted and framed as untrusted, each with a provenance reference that
> the agent can open with one bounded read. Nothing is indexed, copied or stored by this search, and
> it never runs automatically in the background or inside the prompt.
>
> **What leaves the machine:** nothing. There is no server, no port, no network call, no model
> call inside the plugin. Nothing is written into a repository unless you explicitly export, and the
> export is redacted and opt-in.

## 5. Residual risks accepted in v1

1. **Redaction is heuristic.** A secret without a recognizable pattern can be stored; over-redaction
   of code-like text can lose information. Labeled best-effort in docs and UI.
2. **Prompt injection is mitigated, not eliminated.** A well-crafted note can still persuade a
   model, exactly like any tool output. The warning, escaping and no-auto-execution reduce the
   blast radius; DSH's approval policy remains the real gate for actions.
3. **Same-user processes can read the store.** Any process running as the same Windows user can read
   `$DSH_HOME`; the store is not encrypted. A multi-user machine should use separate OS accounts.
4. **A private session's DSH log is still readable by tools that read logs.** Opt-out stops
   Confluence from collecting/sharing/recalling through *its* layers; it does not modify DSH-owned
   logs, and prompts that explicitly read logs are outside this plugin.
5. **Board only knows what was posted.** No automatic transcript capture in v1, so a missed fact
   cannot be recovered by the board; recall is literal-only (no semantic search).
6. **Panel audit is live-process only** (M3): recalls from another window or before startup are not
   shown to the user.
7. **Multi-window readers can lag up to one poll interval**; no server push by design.
8. **Export can be committed if the user ignores the guidance.** Opt-in default, generated
   `.gitignore`, and explicit copy mitigate; a determined `git add -f` cannot be prevented by the
   plugin.
9. **No per-note ACLs, no encryption, no cross-user sharing.** Rejected in ADR-0004; the workspace
   is the only consent boundary in v1.

## 6. Test matrix (every control is encoded)

| # | Control | Test target | Fixture | Expected |
|---|---|---|---|---|
| T1 | Redaction before persistence | `redact()` unit + post→journal scan | keys `sk-…`, `AKIA…`, `ghp_…`, JWT, PEM block, `password=hunter2`, `Bearer abc…`, a public key, `password:` with no value | secrets → `[redacted]`; public key and empty assignment untouched; ≤50 replacements |
| T2 | Title redaction | store + render | title containing a token, `privacy.redactTitles` on/off | on: redacted in journal and pulse; off: warning `PRIVACY_TITLES_UNREDACTED` and panel banner |
| T3 | Hostile note fixtures | pulse/tool render escaping | `</confluence-memory>`, `<script>alert(1)</script>`, `{{cwd}}`, U+2028/2029, C0 controls, bidi override, 1 MB title, CJK+emoji, `\n`-heavy body | `<`→`\u003c`, `&`→`\u0026`, U+2028/2029 escaped, controls stripped, title stored ≤160 chars and rendered ≤60 in the pulse, body capped, frame intact, byte-stable on re-render |
| T4 | Journal field allow-list | scan every `session` record + presence file | a full board/ledger fixture | keys ⊆ allow-list; no `/prompt|assistant|reasoning|toolResult|tool_result|command|stdout|stderr/i` key; `entry` records may have `title`/`body` only |
| T5 | Ledger path deny-list | hint collector | `.env`, `.ssh/id_rsa`, `src/app.ts`, `C:\abs\path.ts`, symlink to outside, `..\..\x` | only `src/app.ts` retained; absolute/`..`/symlink/denied dropped |
| T6 | Cross-profile isolation | every layer | two profile stores with distinct entries and sessions | tools/pulse/recall/panel/export of profile A never return profile B's data; the plugin has no network path to another profile or machine |
| T7 | No egress (host) | static bundle scan | built host files | zero matches for `fetch(`, `http://`, `https://`, `node:net`, `node:http`, `node:https`, `node:dns`, `node:tls`, `createServer`, `WebSocket`, `child_process` |
| T8 | No egress (client) | static client scan | `client.js` | no absolute URL/WebSocket/EventSource/postMessage; ≤1 relative same-origin `fetch` call site at the route adapter; none if `host.call` ships |
| T9 | Same-origin route fence | route handler (if shipped) | GET, HEAD, POST, foreign `Origin`, missing `Sec-Fetch-Site`, 200 KiB response | GET/HEAD 200 JSON `no-store`; POST 405; foreign origin rejected; response ≤128 KiB |
| T10 | Private-session opt-out | live-session fixture | agent with id in `privacy.privateSessions` | pulse renders `''` for it; no ledger row; no presence; Confluence tools hidden; scoped suppressor installed on `agent.ctx` only (other agents unaffected) |
| T11 | Removed workspace opt-out | config fixture | `disabledWorkspaces: [ws_A]` | activation warning `CONFIG_DEPRECATED privacy.disabledWorkspaces`; the value is ignored; sharing stays universal; `privateSessions` still suppresses its session |
| T12 | Config validation | config loader | wrong types, out-of-range ints, bad regex, `..\` export dir, device path, unknown key | defaults applied, deterministic warnings, no throw, no store write outside root |
| T13 | Recall bounds | recall service | 10 sessions in the profile with hits, slow reads, one private session, one session from another profile on disk | ≤3 sessions, ≤5 hits, excerpts ≤600 chars, timeout partial marked, untrusted framing, caller excluded, private session excluded, other-profile session excluded |
| T14 | Export safety | exporter | export disabled; enabled with tombstone + secret + absolute path in body/paths | disabled → `CONFLUENCE_EXPORT_DISABLED`; enabled → deterministic order, redacted, relative paths only, no absolute-path regex, tombstoned entries exported as content-free `deleted:true` stubs, `manifest.json` carries `schema:"confluence.memories/v1"` + `formatVersion:1` |
| T15 | Multi-window/torn line | two simulated writers + truncated tail | incomplete last line, interleaved shards | torn line ignored and recovered next poll; both writers' records merge; no shard rewritten; dedupe/last-wins correct |
| T16 | Board caps | posting > cap, body > cap | `maxEntriesPerWorkspace`, `maxBodyBytes` | reject with named error; no partial append; pulse/panel show counts |
| T17 | Debug log content-free | debug writer | normal operation + recall | no note body/recall text/prompt/tool output in the log; rotation bounded |
| T18 | Panel XSS | static + component test | hostile note fixtures in payload | rendered as text; no `innerHTML`/`dangerouslySetInnerHTML` in source; no anchor generated |
| T19 | Audit transparency | host recall ring buffer | one recall call | tool result carries provenance; panel audit shows session title, query, hit count, time; no secret text beyond the bounded query echo (query is the model's own string) |
| T20 | Workspace rename/collision | canonicalizer | path case variants, trailing slash, junction/symlink, missing/unresolvable dir | same canonical key for case/slash/symlink variants; realpath failure → **no workspace key** and therefore no Confluence tools/pulse; no merge across distinct realpaths |

Tests are `node --test` unit/contract tests plus fixture-driven scans; live M2/M3 checks are listed
in `ui.md` §11 and the testing doc. The no-egress and allow-list scans run in CI over the packed
file list, not just the working tree.

## Spike items

- **S-SEC1** — Scoped `suppressRuntimeContext()` on `agent.ctx`: prove it suppresses the plugin's
  *global* context for that agent only (service signature verified live; scoping behavior
  HYPOTHESIS). This is the load-bearing control for R10; M2 spike.
- **S-SEC2** — `connection.requestRejection(req)` semantics if the route transport ships (ADR-0005
  S-UI10); Crisp's call site is not a documented contract (HYPOTHESIS).
- **S-SEC3** — Windows ACL inheritance for newly created directories under
  `$DSH_HOME/storages/confluence/` on this machine: confirm other OS users cannot read (best-effort
  check, no code change planned).
- **S-SEC4** — Redaction regex performance on 8 KiB bodies and the ReDoS risk of
  `privacy.redactPatterns`; if it cannot be bounded, drop the custom-pattern knob (ties to
  `config.md` S-CFG4).
- **S-SEC5** — Recall of a *private* session's log by another session: `sessionQuery` has no caller
  authorization (research F3), so Confluence's own filter is the only control. Confirm the filter is
  applied to every path (`confluence_recall` and `confluence_read` session refs) with a live
  private-session fixture; if `readEvent` can be reached without the private-session check, treat
  as a bug and add the check.
- **S-SEC6** — M4 release check: confirm the export default root stays under `$DSH_HOME`
  (`storages/confluence-exports/`) and that `--out` never writes into the store root.

## Open questions

1. **Recall audit persistence** — M3 shows live-process recall activity only. Does the Lead want a
   persisted `audit/<writerId>.jsonl` (option-b design) in M4 even though ADR-0001's record types do
   not include an audit record? It would need a store-layout addition.
2. **Suspicious-content flag** — should v1 mark notes containing injection-like phrases
   (`ignore previous`, `system prompt`, `call the tool`) as `flagged: true` for the panel and the
   pulse? Proposed: panel-only flag in M4, never a reason to hide data (avoids a false sense of
   safety and false positives).
3. **Private-session semantics vs DSH logs** — the panel/README state that opt-out does not modify
   DSH logs. Confirm the wording satisfies the "profile = sharing boundary" promise or whether a
   stronger user-facing warning is required at first toggle.
4. **Encryption/at-rest** — rejected in ADR-0004 for v1 (key management without a server adds
   failure modes and does not protect against same-user processes). Revisit only if the store moves
   to a shared/multi-user location.
