# Confluence Web panel design (M3 read-only v1, M4 additions)

- Status: Round-3 detailed design. Binding once accepted; implements ADR-0001 §12 and round-2 R4.
- Author: `design-surface`. Target: DSH Desktop 0.2.2-rc.1 Web GUI (the running GUI URL), profile
  `desktop`, Windows 11. Fully offline: no network egress, no other port, no iframe, no server.
- Companions: [`config.md`](config.md) (row config), [`security-privacy.md`](security-privacy.md)
  (threat model), [`testing.md`](testing.md) (UI-01…UI-06, CON-UI-01, SEC-06 contract IDs),
  [`../adr/0005-ui-transport.md`](../adr/0005-ui-transport.md) (channel decision),
  [`../plan/m0-spikes.md`](../plan/m0-spikes.md) §8 (spike S6), ADR-0001 §12.

> **v0.2.0 amendment — universal memory scope ([ADR 0007](../adr/0007-universal-memory-scope.md), delta
> §7).** The panel becomes **one global timeline**, titled "高级记忆 / Confluence memory": entries from
> every session, a kind filter plus free-text search (search matches titles/bodies/tags; no separate
> tag facet in v0.2.0), entry detail + thread, live peers, and a **provenance chip**
> showing the originating workspace label when the host supplies one. **There is no workspace
> switcher** and no workspace parameter anywhere; `GET /confluence/panel/overview?q=&kind=&limit=` and
> `GET /confluence/panel/entry?id=` serve `scope:{key:'global',label:'All sessions'}`, and the
> v0.1.0 `/workspaces` route is removed. The privacy control for "share this workspace" is gone
> (`privacy.disabledWorkspaces` removed); `privacy.privateSessions` (per session) remains, with the
> same confirmations. The locale inventory is 86 keys in both files (see §5). The v0.1.0 wireframe,
> component tree, workspace-switcher section and some locale copy below are historical.

> **v0.3 amendment — two read-only views ([ADR 0008](../adr/0008-bus-and-profile.md),
> [binding contract](../plan/v0.3-interfaces.md) §6).** The main page becomes **two tabs**:
> **工作区总线** (workspace list → bus detail with keyed context, notes, messages, live peers and an
> entry detail with replies) and **用户画像** (sections, facts, confidence, source, plus a JSON/Markdown
> export button). Routes are read-only same-origin `GET`s: `/confluence/panel/ping`, `/workspaces`,
> `/bus?ws=&q=&kind=&limit=`, `/entry?ws=&id=`, `/profile`, and `/profile/export?format=json|md`
> (file download, no JSON envelope; `content-disposition: attachment`). `ws` is the opaque
> `ws_<16hex>` id and is never a path; labels are basenames/registry titles only. No writes, no POST,
> no new port/dependency/build step, the same 64 KiB cap with a `fitPayload` degradation branch
> (`truncated:true`) on every route, and en/zh locale key sets must stay identical. The v0.2.0
> global-timeline view and its `overview` route are retired; the v0.2.0 amendment and v0.1.0
> wireframe below are historical.

> **v0.4 amendment — three views, seven routes
> ([ADR 0009](../adr/0009-long-term-memory-persona-style.md),
> [binding contract](../plan/v0.4-interfaces.md) §6).** The page gains a third tab: **工作区总线**,
> **长期记忆** (`GET /confluence/panel/memory` →
> `{ok, revision, patterns, candidates, stats:{total,active,candidates}, truncated}`; candidates are
> listed separately with a hint to confirm them with the Agent; **read-only, no write path**) and
> **用户画像** (persona sections **plus** `styles` and `stats:{sections,facts,styles}` and the export
> button). Seven read-only same-origin `GET` routes: `ping`, `workspaces`, `bus`, `entry`, `profile`,
> `memory`, `profile/export?format=json|md` — the export route now downloads the full
> `confluence.memory/v1` document (attachment, no JSON envelope). The transport rules are unchanged:
> no POST, no new port/dependency/build step, opaque `ws_<16hex>` ids (never paths), basename labels
> only, the same 64 KiB cap with a `fitPayload` degradation branch (`truncated:true`) on every route,
> and en/zh locale key sets must stay identical. No promote/reject control exists in the UI;
> confirmation stays conversational.

## 1. Surface decision

### 1.1 Chosen surfaces (M3)

| Purpose | Slot | Registration | Evidence |
|---|---|---|---|
| Left-rail entry | `sidebar.panellist` | `{ name: 'sidebar.panellist', id: 'confluence', order: 30, locale: 'confluence', label: () => t('panel') }` | live client inspection (Lead): id/order/label verified; same shape in Crisp `client.js:534-545` |
| Page | keyed `main` | `ctx.slots.inject('main', function* () { yield ctx.slots.register({ name: 'main', key: 'confluence', locale: 'confluence', inject: () => ({ t, closePanel: () => ctx.layout.selectPanel(null) }) }, ConfluencePage) })` | live client inspection: keyed `main` verified; Crisp `client.js:520-533`; `selectPanel(null)` verified `dsh-client-ui-layout/lib/client.js:505-543` |

Reasons: (1) the pair is proven twice on this host line (Crisp, dsh-context) and is the only slot
combination with room for a global timeline + detail + controls; (2) the left rail is
global across conversations, matching a profile-wide memory space; (3) navigation already exists
(`selectPanel('confluence')` opens, `selectPanel(null)` returns, `main` is a keyed page). Entry order
`30` follows Crisp (`2`) and dsh-context (`20`) without reordering them.

### 1.2 Fallbacks if the chosen surfaces cannot be proven

| Failure | Fallback | Consequence |
|---|---|---|
| keyed `main` registration rejected (props mismatch) | `sidebar.right.pane.tab` + `.title` (live-verified slots) rendering a narrow timeline; rail entry remains | no detail pane; filters collapse into the header; still read-only |
| `sidebar.panellist` entry cannot open the page | page reachable only via `ctx.layout.selectPanel('confluence')` from an M4 `/confluence panel` command | discovery loss, not correctness loss |
| both page surfaces unavailable | ship tools + docs, defer panel; keep this contract for M4 | documented degraded outcome (ADR-0001 §12) |

No fallback uses `shell.overlay`, `rightbar`/`rightbar.session` (track/widget protocol), an iframe,
a second app root, or `conversation.composer.dock` as a panel.

### 1.3 M4 surfaces (designed here, not built in M3)

| Purpose | Slot / mechanism | Note |
|---|---|---|
| Per-session unread badge | `conversation.session.header.utilities` (live-verified id/order/label) | count pill; opens the panel for the workspace; registration shape follows Crisp's verified pattern |
| Secondary live view | `sidebar.right.pane.tab` + `.title` (live-verified keys) | "here now + newest 3"; reuses `overview` |
| Composer / reply / resolve | inside the panel, writes via `ctx.remote.commands.execute(agent, '/confluence …')` (signature verified live) | no second write channel |
| Custom tool cards | `presentCall`/`presentResult` for the six tools | v1 keeps generic presentation (ADR-0001 §7) |
| Copy-mark / hide entry | panel → Host method + command | tombstone semantics owned by the data-model doc |

## 2. Page layout and component tree

### 2.1 Wireframe (text; no screenshot needed)

```text
┌ left rail ─┬───────────────────────────────────────────────────────────────────────┐
│ ◇ Conflu-  │  高级记忆 / Confluence memory                      2 here   [⟳] [Back]   │
│   ence     │  All sessions · shared memory · updated 12:03:44                       │
│  (高级记忆)    ├───────────────────────────────────────────────────────────────────────┤
│            │  [banner: storage degraded / partial records / private]               │
│            │  [Search shared memory…] All Finding Decision Gotcha Question Handoff │
│            │  Warning  [Unread only]                          [Mark all read]      │
│            │  ┌ timeline (flex 1) ────────────────────┐ ┌ detail (420px) ──────────┐ │
│            │  │ Today                                 │ │ [gotcha] shared data    │ │
│            │  │ ● [gotcha] Windows rename retries …   │ │ Windows rename …        │ │
│            │  │   by "Auth work" · 2 replies · #win32 │ │ body text (plain)       │ │
│            │  │ ○ [decision] Pin deps to 0.2.x        │ │ by "Data migration"     │ │
│            │  │   by "Data migration" · resolved      │ │ files · replies (2)     │ │
│            │  │ Yesterday … [Show older notes]        │ │ origin: solo-bench      │ │
│            │  └───────────────────────────────────────┘ └─────────────────────────┘ │
│            │  ▸ Open questions & handoffs  2 questions · 1 handoff               │ │
│            │  Shared with every session in this profile  [ ] Make this session private │
│            │  audit  Last refresh 12:03:44 · transport host.call · recall 12:02 …│ │
└────────────┴───────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component tree

```text
ConfluencePage                    <section aria-labelledby="cf-title">; .cf-page
├─ PageHeader                     h1#cf-title, "高级记忆" chip, scope row (All sessions · updated)
│  ├─ PresenceStrip               role="status": dot + "{n} active now" + ≤2 titles
│  └─ HeaderActions               Refresh · BackToChat        (no workspace switcher)
├─ StatusBanners                  one banner per active state (§4)
├─ Toolbar                        SearchBox (250 ms debounce, ≥2 chars) · KindFilters ·
│                                 UnreadOnlySwitch · MarkAllReadButton
├─ ContentGrid
│  ├─ BoardTimeline               role="list"; day headings; EntryRow ×n; load-more
│  └─ DetailPane                  role="region"; UntrustedNotice · EntryBody · Provenance ·
│                                 OriginChip (workspace label, when present) · ReplyThread ·
│                                 EntryActions (MarkRead, CopyId)
├─ OpenItemsSection               collapsible: open questions / open handoffs, jump links
├─ PrivacySection                 stored-vs-on-demand text; private-session toggle (§7.7)
└─ AuditFooter                    last refresh, transport mode, version, store root, recall tail
```

Render rules: note text is a React text child (`white-space: pre-wrap`), never HTML/Markdown in v1
(link auto-detection off); relative times are computed client-side from ISO `createdAt` so payloads
stay deterministic; no optimistic writes in M3; one snapshot drives all children (pure renderers).

## 3. Host↔client data channel

### 3.1 Hard constraints

Local-only (no network egress, no new port, no server, no iframe); plain-JS client (React from the
module table, no Harness client package imports, no build step); one payload contract; switching
transport is a one-file adapter change; M3 budget 2.5 engineer-days (ADR-0001 §14).

### 3.2 Candidates

| # | Candidate | Status | Pros | Risks |
|---|---|---|---|---|
| A | client builtin `host.call(method, args)` | existence verified live (Lead's client inspection); **Host registration contract unverified** (HYPOTHESIS U1) | in-process, no HTTP, no route fence, natural errors | package-private contract: namespace, serialization, errors, caller identity, disposal, cross-plugin isolation unknown; may change across DSH upgrades |
| B | same-origin `ctx.webServer.register({ kind:'exact', path, handler })` + client `fetch` | **proven** (Crisp `index.js:98-119`, `lib/status.js:290-339`; dsh-context `/api/dsh-context/*`) | documented on this version; fence call site `connection.requestRejection(req)` exists | it is a same-origin request (must be stated as *not* egress); handler needs defensive fencing |
| C | `workspaceFiles` Remote over the M4 export | available | no new route | requires opt-in export + workspace write; stale; rejected |
| D | runtime-registered Typert Remote namespace | unverified for third-party plain JS (`option-b.md` F15) | first-party transport | not proven; outside M3 budget; defer |

### 3.3 Decision rule (M3 spike, S6 in `plan/m0-spikes.md` §8)

Build the adapter interface and the payload contract first. Ship **A** only if spike S-UI1 proves a
public, plugin-scoped Host registration that passes **all** outcome criteria (§3.6, criteria 1–7).
Otherwise ship **B** with the constraints in §3.7 — this is the pre-built ADR-0001 §12 fallback, not
a failure. Never activate both channels in one build; the inactive adapter stays unit-tested.

### 3.4 Adapter interface (stable across channels)

```js
function createPanelClient(call) {          // call(method, args) -> Promise<object>
  return { ping: () => call('ping', {}), workspaces: () => call('workspaces', {}),
           overview: (a) => call('overview', a), entry: (a) => call('entry', a),
           search: (a) => call('search', a), markRead: (a) => call('markRead', a),
           setOptOut: (a) => call('setOptOut', a) }
}
const fromHostCall = (host) => (method, args) => host.call('confluence.' + method, args) // namespace HYPOTHESIS
const fromRoute = (base = '/confluence/api') => (method, args) =>
  fetch(base + '/' + method + toQuery(args), { method: 'GET', credentials: 'same-origin',
    cache: 'no-store', headers: { accept: 'application/json' } }).then(readJson)
```

Errors normalize to `{ code, message, retryable }`; non-JSON or oversized bodies are
`PANEL_TRANSPORT_BAD_PAYLOAD`; the panel never renders host text verbatim.

### 3.5 Payload contract `confluence.panel.v1`

> **v0.2.0 supersedes this sketch.** The shipped panel uses the same-origin route adapter only, with
> exactly three GET routes: `GET /confluence/panel/ping`, `GET /confluence/panel/overview?q=&kind=&limit=`
> and `GET /confluence/panel/entry?id=`. There is **no** `workspaces` method/route, no `workspaceKey`
> parameter, and no candidate `search`/`markRead`/`setOptOut` over the route (GET only; the opt-out
> needs the config editor). `overview` returns `{ok, scope:{key:'global',label:'All sessions'},
> entries:[{id,seq,kind,title,authorTitle,workspaceLabel,ts,status,replyCount}], stats, peers, truncated}`
> and `entry` returns `{ok, entry:{…, workspaceLabel?}, replies}`; workspace data appears only as the
> basename provenance label. The `confluence.panel.v1` shape below is the v0.1.0 record and remains
> historical.

All methods return objects with `protocol: "confluence.panel.v1"`; unknown fields are ignored and only
the listed ones are required. Caps are server-enforced. `warnings` is a `string[]` of stable
`CODE field` lines (matching `config.md` §3), not objects.

```jsonc
// confluence.ping
{ "protocol": "…", "ok": true, "pluginVersion": "0.1.0", "transport": "host.call|route",
  "writerId": "<pid>-<rand>", "storeRoot": "<display path>", "ui": { "pollMs": 5000 },
  "capabilities": { "optOut": "config-editor|unavailable", "readCursor": "host-mirror+local",
                    "search": true, "export": false }, "warnings": ["CONFIG_INVALID_VALUE store.pollMs"] }

// confluence.workspaces   (≤20, sorted by lastActivityAt desc)
{ "protocol": "…", "preferred": "ws_1a2b…|null",
  "workspaces": [ { "key": "ws_1a2b…", "name": "solo-bench", "path": "D:\\05_Code\\solo-bench",
                    "pathVerified": true, "state": "ready|disabled|missing",
                    "lastActivityAt": "2026-11-13T04:03:44.000Z",
                    "entries": 12, "openQuestions": 2, "openHandoffs": 1 } ] }

// confluence.overview { workspaceKey?, readThrough? }        (readThrough = client cursor)
{ "protocol": "…", "status": "ok|degraded|corrupt|no-workspace|disabled|private|error",
  "generatedAt": "2026-11-13T04:03:44.000Z",
  "workspace": { "key": "ws_…", "name": "solo-bench", "path": "D:\\05_Code\\solo-bench",
                 "pathVerified": true, "state": "ready|disabled|private|missing",
                 "retentionDays": 90 } | null,
  "peers": [ { "sessionId": "…", "title": "schema-migration", "status": "running|idle",
               "lastSeenSec": 3 } ],                                          // ≤8
  "board": { "total": 12, "openQuestions": 2, "openHandoffs": 1, "unread": 3,
             "headSeq": "01J…", "hiddenOlder": 4 },
  "entries": [ { "id": "cnf_01JBQ8Z4K1H9T2R6N4X7C0W8FD", "seq": "01J…", "kind": "gotcha",
                 "title": "Windows rename retries wrap in EPERM", "bodyPreview": "…", // ≤240
                 "author": { "sessionId": "…", "title": "Auth work" },
                 "createdAt": "2026-11-13T03:55:00.000Z", "replyCount": 2, "resolved": false,
                 "tags": ["windows"], "files": ["src/win/rename.ts"] } ],       // ≤30 (max 50)
  "openItems": [ { "id": "cnf_01JBQ8Z4K2V7R3N5T6X1Y8M0PQ", "kind": "question|handoff", "title": "…",
                   "author": { "title": "…" }, "createdAt": "…", "replyCount": 0 } ],
  "audit": [ { "ts": "2026-11-13T03:59:00.000Z", "sessionTitle": "schema-migration",
               "query": "fixture timeout", "hitCount": 3 } ],                 // ≤20
  "warnings": [], "nextCursor": "01J…|null" }

// confluence.entry { workspaceKey, id }
{ "protocol": "…",
  "entry": { "id": "cnf_01JBQ8Z4K1H9T2R6N4X7C0W8FD", "seq": "…", "kind": "…", "title": "…", "body": "…",      // ≤maxBodyBytes
             "author": { "sessionId": "…", "title": "…" }, "createdAt": "…",
             "tags": [], "files": [], "resolved": false, "supersedes": "cnf_01JBQ8Z4K5H9T2R6N4X7C0W8FD|null" },
  "replies": [ { "id": "cnf_01JBQ8Z4K3M8S4P6V7W2Z9N1RT", "seq": "…", "body": "…", "author": { "title": "…" },
                 "createdAt": "…", "resolves": false } ] }                      // ≤50

// confluence.search { workspaceKey, query, kinds?, tags?, limit? }   (board only, no logs)
{ "protocol": "…", "items": [ <entry summaries as above> ], "total": 5, "truncated": false }

// confluence.markRead { workspaceKey, throughSeq }
{ "protocol": "…", "ok": true, "cursor": { "throughSeq": "01J…" } }

// confluence.setOptOut { workspaceKey, scope: "workspace"|"session", sessionId?, enabled }
{ "protocol": "…", "ok": true, "applies": "immediate|restart", "warnings": [] }
```

Error object: `{ "protocol": "…", "ok": false, "error": { "code": "…", "message": "…" } }`. Codes:
`CONFLUENCE_DISABLED`, `CONFLUENCE_UI_DISABLED`, `CONFLUENCE_NO_WORKSPACE`,
`CONFLUENCE_WORKSPACE_DISABLED`, `CONFLUENCE_NOT_FOUND`, `CONFLUENCE_STORE_UNAVAILABLE`,
`CONFLUENCE_STORE_CORRUPT`, `CONFLUENCE_INVALID_ARGUMENT`, `CONFLUENCE_CONFIG_EDIT_UNAVAILABLE`,
`CONFLUENCE_CONFIG_EDIT_REJECTED`, `PANEL_TRANSPORT_UNAVAILABLE`, `PANEL_TRANSPORT_BAD_PAYLOAD`.

### 3.6 M3 spike checklist (transport + registration)

- **S-UI1 `host.call` Host contract.** Locate the builtin's implementation and Host counterpart in
  the DSH client/runtime bundles (`read` on app.asar). In a **scratch profile only**, register a probe
  method on the Host half and call it from a probe client module; record the exact declaration API,
  namespacing, JSON round-trip, timeout, error shape, caller identity, disposal on reload, and whether
  another plugin's method is callable. Ship A only if: (1) registration is a public extension point,
  (2) JSON args/results round-trip, (3) errors are structured and distinguishable from transport
  failure, (4) calls are plugin-scoped and disposal is clean, (5) no console error / extra request /
  port, (6) no Harness client package import, (7) survives HMR reload and page refresh. Else → B.
- **S-UI2** re-verify client builtins (`Builtin.listBuiltins`: `ctx`, `React`, `host.call`,
  `styles.insert`, `console`; this session's retries timed out).
- **S-UI3** slot props via `Slots.listSubTree` for `main`, `sidebar.panellist`,
  `sidebar.right.pane.tab`; confirm keyed registration, id/order/label and `inject()` props.
- **S-UI4** `Theme.listTokens` returns the §6 tokens; `--dsh-frame-top-clearance` is a layout var with
  `0px` fallback (HYPOTHESIS) — page must lay out without it.
- **S-UI5** `styles.insert(css)` inserts and disposes through `ctx.effect` (fallback: component-local
  `<style>` element, Crisp `client.js:310-318`); locale switch updates strings live.
- **S-UI6** open/close/back: `selectPanel('confluence')` / `selectPanel(null)`; no duplicate
  registrations after HMR; panel state survives hide/show.
- **S-UI7** `configEditor.edit` on our row without a schemastery `Config` export (see
  `config.md` S-CFG1) — needed for opt-out persistence.
- **S-UI8** does disabling the bundle row remove the static client module from the graph or leave a
  dead rail entry? Document the recovery (re-enable/restart).
- **S-UI9** budget: `overview` p95 < 50 ms host time, payload ≤128 KiB worst case, 5 s polling no
  jank, no overlapping requests while hidden.
- **S-UI10** (only if B) `connection.requestRejection(req)` semantics: which requests are rejected,
  rejection response shape, whether the handler must also check `Sec-Fetch-Site`; Crisp's call site is
  not a documented contract (HYPOTHESIS).
- **S-UI11** workspace selection identity: does the client call carry window/session identity? If not,
  confirm the "preferred workspace" heuristic (most recent live session in process, else newest store
  activity) and the explicit `workspaceKey` path.
- **S-UI12** a11y smoke: no `slot entry crashed in '<slot>'`; focus returns to the rail entry after
  `selectPanel(null)`; Escape closes the dialog.

### 3.7 Route fallback constraints (if B ships)

`kind: 'exact'`, prefix `/confluence/api/`; GET/HEAD only (405 otherwise); JSON
`content-type: application/json; charset=utf-8`, `cache-control: no-store`; response ≤128 KiB;
handler first calls `ctx.get('connection')?.requestRejection(req)` defensively and returns its
status, and rejects a present foreign `Origin` / non-same-origin `Sec-Fetch-Site`. No POST in M3:
`markRead` and `setOptOut` are unavailable in route mode, the panel shows the `/confluence …`
instruction instead. Workspace keys are validated against known workspace directories; the client
never supplies a filesystem path.

### 3.8 Relationship to `design/architecture.md` §5.14

The architecture doc's provisional method list is `overview, entry, search, markRead, setOptOut`. This
design adopts `overview` (renamed from the earlier `state` draft), keeps `entry`/`search`/
`setOptOut`, adds `ping` and `workspaces` (subscription probe + switcher), and folds the audit tail
into `overview.audit` instead of a separate method. `markRead` exists as a Host method with **no
model-watermark effect**: it validates the user cursor, mirrors it in-process (so a second window in
the same process stays consistent), and lets the client persist it in `localStorage`; a UI click
cannot forge a session event, so `boardReadSeq` remains tool-derived (ADR-0001 §8.1, §7.6 below).

## 4. Panel states

Priority: `error` > `disabled` > `private` > `corrupt` > `degraded` > `ok` (the v0.2.0 panel has no
`no-workspace` state: the memory space always exists). Only
the first two render as full banners; the rest render inline.

| State | Trigger | Render | Actions |
|---|---|---|---|
| `loading` | first paint / workspace switch | skeleton (header, 6 rows, detail placeholder), `aria-busy="true"` | switch workspace |
| `ok` entries | status ok, ≥1 entry | full layout | all read controls |
| `ok` empty | status ok, 0 entries | `board.empty` card; privacy section still shown | refresh |
| `no-workspace` | no resolvable key | `workspace.unavailable` card; switcher lists known workspaces | pick workspace |
| `disabled` | disabled workspace / `enabled:false` / `ui.enabled:false` | `state.disabled.*` or `ui.disabled.*`; no data | re-enable (confirm) when capable |
| `private` | current session private | `state.private.*`; board still visible to the user (§7.7) | make public (confirm) |
| `corrupt` | N records skipped | `state.corrupt` banner; healthy records render | refresh |
| `degraded` | store read-only, or poll failure with old data | `state.degraded`/`state.stale` + last-success time | retry, copy store path |
| `error` | transport error, no data | `state.loadError` card with localized code, retry | retry |

Non-urgent banners use `role="status"`; failures `role="alert"`; repeated polls never re-announce.

## 5. i18n

- Namespace `confluence`; `ctx.locale.register('confluence', { en, zh })` inside `ctx.effect`,
  `const t = ctx.locale.bind('confluence')`. No hardcoded English in components.
- **Canonical inventory is the shipped `locale/en.json` + `locale/zh.json` `ui` object** (the
  scaffold already carries 22 panel strings; the repo contract test checks their alignment). M3 adds
  the new keys below to both files in the same commit as `client.js`; a parity test deep-equals the
  client dictionary with the JSON `ui` object (flattened to dotted keys) so they cannot drift.
- Interpolation `{n}`/`{time}`/`{query}` is assumed (dsh-context locale strings use it; HYPOTHESIS:
  `ctx.locale.bind` interpolates). If not, one `format(template, params)` helper.

**Existing scaffold keys** are already shipped in both JSON files and asserted by
`test/contract.test.js`; they keep their **names** (client dictionary parity) but their v0.2.0 copy is
universal: `panel`, `board.title` ("Shared notes"), `board.subtitle` ("Notes published by any session on
this machine"), `board.empty`, `board.unread`, `pulse.title`, `pulse.empty`, `recall.title`,
`recall.empty`, `workspace.label` ("Origin" — the provenance chip label), `workspace.unavailable`,
`search.label` ("Search shared memory"), `search.placeholder`, `search.empty` ("No shared notes
matched."), `questions.open`, `handoffs.open`, `peers.live`, `markRead`, `markRead.done`, `entry.open`,
`entry.resolved`, `ledger.title`.

v0.2.0 adds `scope.global` ("All sessions" / "全部会话") for the scope chip; the shipped inventory is
**86 keys** in each file (`locale/*.json` is canonical, not this table).

New M3 keys (added to `locale/*.json` and the client dictionary; en | zh):

| Key | en | zh |
|---|---|---|
| `panel.subtitle` | Shared memory across every session in this profile. | 此配置文件中所有会话共享的记忆。 |
| `scope.global` | All sessions | 全部会话 |
| `nav.back` | Back to chat | 返回对话 |
| `action.refresh` / `action.retry` / `action.cancel` | Refresh / Retry / Cancel | 刷新 / 重试 / 取消 |
| `state.loading` / `state.loadError` | Loading shared memory… / Unable to load shared memory | 正在读取共享记忆… / 无法读取共享记忆 |
| `state.noWorkspace.title` / `.body` | Nothing shared yet / Sessions publish notes with confluence_post; they appear here for every session in this profile. | 还没有共享内容 / 会话用 confluence_post 发布笔记后，此配置文件中的每个会话都能在这里看到。 |
| `state.private.title` / `.body` | This session is private / Its activity is not recorded, and shared memory is hidden from its agent. | 此会话为私密 / 不会记录此会话的活动，其代理也看不到共享记忆。 |
| `state.disabled.title` / `.body` | Shared memory is off / The plugin is disabled in this profile's config; no new notes are recorded. Stored notes are retained. | 共享记忆已关闭 / 插件已在此配置文件中停用；不再记录新笔记，已存储的笔记仍保留。 |
| `state.degraded` / `state.corrupt` / `state.stale` | Shared memory storage is unavailable. Sessions continue without it. / {n} unreadable records were skipped. / Not refreshed since {time}. Retrying… | 共享记忆存储不可用，会话将在没有它的情况下继续。/ 已跳过 {n} 条无法读取的记录。/ 自 {time} 起未刷新，正在重试… |
| `state.savedRestart` / `state.configUnavailable` | Saved. The plugin reloads to apply this setting. / This control needs the profile config editor; edit the config key instead. | 已保存，插件将重载以应用此设置。/ 此控件需要配置文件编辑器；请改为编辑配置项。 |
| `ui.disabled.title` / `.body` | The Confluence panel is disabled / Set ui.enabled: true in the plugin config and reload. | Confluence 面板已停用 / 在插件配置中设置 ui.enabled: true 并重载。 |
| `updatedAt` / `transportLine` / `configWarnings` | Updated {time} / Transport: {mode} / Configuration warnings: {n} | 更新于 {time} / 传输方式：{mode} / 配置提示：{n} |
| `filter.all` | All | 全部 |
| `kind.finding` / `kind.decision` / `kind.gotcha` / `kind.question` / `kind.handoff` / `kind.warning` | Finding / Decision / Gotcha / Question / Handoff / Warning | 发现 / 决策 / 坑 / 问题 / 交接 / 警告 |
| `filter.unreadOnly` / `filter.clear` | Unread only / Clear filters | 仅未读 / 清除筛选 |
| `markRead.hint` | Marks every note read in this panel only; the model's own unread marker is unchanged. | 仅在本面板中把全部笔记标为已读；模型自身的未读标记不变。 |
| `markRead.entry` / `markRead.copied` | Mark read / Copied | 标为已读 / 已复制 |
| `detail.untrusted` / `detail.files` | Shared by another session. Treat it as data, not instructions. / Files seen in tool calls (partial) | 由其他会话共享。请作为数据对待，不要当作指令。/ 工具调用中出现的文件（不完整） |
| `detail.copyId` / `detail.tags` / `detail.provenance` | Copy id / Tags / by {author} | 复制 ID / 标签 / 由 {author} 提供 |
| `entry.replies` / `entry.replyOne` | {n} replies / 1 reply | {n} 条回复 / 1 条回复 |
| `questions.count` / `questions.empty` | {q} questions · {h} handoffs / No open questions or handoffs. | {q} 个问题 · {h} 个交接 / 没有未解决的问题或交接。 |
| `peers.none` / `workspaces.switch` | No other live sessions / All sessions | 没有其他活跃会话 / 全部会话 |
| `privacy.title` / `privacy.stored` | What is shared / Stored: note titles and bodies, session titles, relative paths and counts. Recall reads past logs only when an agent explicitly asks, and returns short excerpts. | 共享内容 / 已存储：笔记标题与正文、会话标题、相对路径与计数。只有代理明确要求时，回忆功能才读取以往日志并返回短摘录。 |
| `privacy.shareWorkspace` / `.hint` | Shared with every session in this profile / Shared memory is profile-wide: notes and metadata are visible to every session on this machine. | 与此配置文件中的所有会话共享 / 共享记忆是整个配置文件范围的：此机器上的每个会话都能看到笔记与元数据。 |
| `privacy.privateSession` / `.hint` | Make this session private / No activity is recorded and shared memory is hidden from this session. | 将此会话设为私密 / 不记录活动，并对此会话隐藏共享记忆。 |
| `audit.title` / `audit.empty` / `audit.row` | Recall activity / No recall calls since this window started. / {session} · {query} · {hits} hits · {time} | 回忆活动 / 此窗口启动以来没有回忆调用。/ {session} · {query} · {hits} 条命中 · {time} |
| `retention.hidden` / `board.showOlder` | Notes older than {days} days are hidden. / Show older notes | 超过 {days} 天的笔记已隐藏。/ 显示更早的笔记 |

Confirmation dialogs add: `confirm.disable.title`, `confirm.disable.body`, `confirm.disable.action`,
`confirm.enable.title`, `confirm.enable.action`, `confirm.private.action` (copy in §7.2, both
languages in the same locale commit).

## 6. Theme tokens and visual language

Only these live-verified tokens are used; literal colors are reserved for the SVG icon.

| Element | Token |
|---|---|
| Page background | `--dsw-alias-bg-base` |
| Cards, toolbar, list surfaces | `--dsw-alias-bg-layer-1` |
| Nested blocks (reply rows, body quote) | `--dsw-alias-bg-layer-2` |
| Modal/dialog background | `--dsw-alias-bg-overlay` |
| Hairlines, card borders | `--dsw-alias-border-l1` |
| Control borders, stronger dividers | `--dsw-alias-border-l2` |
| Selected row accent, unread dot, focus ring, links | `--dsw-alias-brand-primary` |
| Primary text, headings | `--dsw-alias-label-primary` |
| Secondary text, metadata, captions | `--dsw-alias-label-secondary` |
| Error text/dot | `--dsw-alias-state-error-primary` |
| Idle/offline dot, disabled state | `--dsw-alias-state-idle-primary` |
| Success/resolved dot | `--dsw-alias-state-success-primary` |
| Warning banner | `--dsw-alias-state-warn-primary` |
| Sidebar-like column fill (only if a later layout needs one) | `--dsw-specific-sidebar-fill` |

No hex/rgb/hsl literal outside the icon; state badges use a token border + text (or
`color-mix(in srgb, var(--token) 42%, transparent)`, the Crisp pattern, still token-derived);
disabled elements use `opacity: .6`, not a new color. Light/dark follows the host automatically.

Visual language (reference: Plugin Manager list density + Crisp page chrome, no screenshot needed):
13 px body, 12 px metadata, 22 px semibold page title, 32 px controls, 8–12 px radii, 10–16 px row
padding, 1 px `border-l1` separators; header title with a small "高级记忆" chip, presence as a bordered
pill; timeline rows with an uppercase 11 px kind pill, semibold one-line title, metadata line, unread
dot, and a 2 px `brand-primary` left border + `bg-layer-2` when selected; detail column 420 px sticky,
quiet untrusted inset banner, 13 px/1.6 pre-wrap body, 12 px provenance with monospace id/seq, replies
as nested `bg-layer-2` cards; footer 12 px secondary on a hairline; empty/error states as a dashed
`border-l2` card, max-width 560 px, one action; one 120 ms banner fade, off under reduced motion.

## 7. Interaction details

### 7.1 Focus and keyboard

Real `<button>`/`<a>`/`<input>` elements with a visible `:focus-visible` outline in
`--dsw-alias-brand-primary`; timeline is a roving-tabindex list (`↑/↓` move, `Enter` opens,
`Home/End` jump; the active row is the single `tabindex="0"`); detail `Escape` clears the selection
and returns focus to the row (no selection → no-op; "Back to chat" is explicit); search `Escape`
clears, `Enter` jumps to the first result, `/` focuses search only from the page root; modal initial
focus is **Cancel**, focus trap, `Escape`/backdrop cancels, focus returns to the opening toggle.

### 7.2 Confirmation for destructive actions

Two modal dialogs (`role="dialog" aria-modal="true" aria-labelledby` + `aria-describedby`): **turn
shared memory off at the plugin level** (v0.2.0 has no per-workspace sharing switch; the honest
alternative is disabling the row or setting `enabled:false`, and the dialog says so) and **make this
session private** (activity no longer recorded; shared memory hidden from the agent; immediate).
Re-enable uses the inverse dialog. M4 adds hiding an entry (typed confirmation, last 4 chars of the
entry id; DSH logs are not modified). Mark-all-read needs no confirmation and is followed by
`markRead.done` until new data arrives.

### 7.3 Search and filters

Board-only search (never session logs; that is `confluence_recall`). Filter state is in memory only
(kind chips multi-select, unread switch, text query ≥2 chars after 250 ms), with `filter.clear` when
active. Empty results show `search.empty` + clear action, not the board-level empty state.

### 7.4 Detail pane

Opens on row click/Enter via `confluence.entry`; cached for the poll cycle and invalidated when
`board.headSeq` changes. Replies are read-only in M3. `Copy id` copies the board id for use with
`confluence_read`/`confluence_reply` in chat (clipboard failure → transient notice). A vanished
entry (M4 tombstone, retention) shows "no longer available" and returns to the list.

### 7.5 Scope (no workspace switcher)

There is exactly one scope: `{ key:'global', label:'All sessions' }`. The panel never lists, selects
or switches workspaces and never sends a workspace key; the header shows the scope label and the
detail pane shows an entry's **origin** (workspace basename) as a provenance chip when the host
supplies one. The old switcher is deliberately gone (ADR 0007 §2.5).

### 7.6 Mark-read semantics (M3)

The **user cursor** is the panel's unread model, distinct from the model's log-derived
`boardReadSeq`. The client keeps `{v:1, throughSeq, readIds:[≤200]}` in
`localStorage['dsh.confluence.panel.read.global']` (v0.2.0: one fixed key, no workspace suffix), sends
`readThrough` with each `overview`, and the Host computes `board.unread` for the whole shared board.
Opening a detail adds its id; "Mark all read" sends `confluence.markRead({throughSeq: board.headSeq})`,
which validates the seq, mirrors the cursor in-process (same-process windows agree), and returns it for
the client to persist. This never advances the model watermark — a UI click is not a committed session
event (ADR-0001 §8.1). Clearing site data resets only the user cursor; M4 may move it Host-side.

### 7.7 Privacy controls

Only one control survives in v0.2.0: **make this session private** (off; on = a
`privacy.privateSessions` entry; off again removes it) with the confirmation above. The workspace
sharing toggle is gone with `privacy.disabledWorkspaces` (ADR 0007 §6). The current session's agent
stops seeing shared memory immediately (scoped suppressor) and the panel discloses the state; the
panel still shows the global board to the *user* when the session is private (the private state is
about session participation, not user visibility) and says so. Persistence goes through
`confluence.setOptOut` → config editor; if unavailable (`capabilities.optOut: 'unavailable'`) the
toggle is disabled and shows the exact config key (`state.configUnavailable`). After a successful
write: `state.savedRestart`, tolerate the plugin reload.

### 7.8 Audit footer and telemetry

Last successful refresh, transport mode, plugin version, store root (display only), config-warning
count, and the last ≤3 recall audit rows ("session · query · hits · time"). v1 audit is
**live-process only** (in-memory ring buffer from the recall service); other windows and
pre-restart recalls are not shown; the footer labels it "since this window started".

### 7.9 Polling and staleness

Poll `ui.pollMs` (default 5,000 ms, clamp 2,000–30,000) **only while visible** and mounted;
`visibilitychange` to visible triggers an immediate refresh; single in-flight request (skip a tick,
abort on unmount, 8 s timeout); failures keep the last data, show `state.stale`
with the last success time, and back off 5→10→20→30 s (reset on success). No push, SSE or WebSocket:
polling is the whole freshness model, same contract as the store (ADR-0001 §6/§12).

## 8. Accessibility roles

| Element | Semantics |
|---|---|
| Page root | `<section aria-labelledby="cf-title">` (avoid a second `<main>` landmark) |
| Heading / path | `<h1 id="cf-title">`; path `<p>` with `aria-label` |
| Presence | `<span role="status">` with a text form ("2 sessions here: A, B") |
| Banners | `role="status"` info/degraded; `role="alert"` error/corrupt-on-load |
| Timeline | `role="list"`; row is a `<button>`; selected row `aria-current="true"` |
| Kind filters | `<button aria-pressed>` inside `role="group" aria-label` |
| Unread switch | `role="switch" aria-checked` |
| Search | `<input type="search" aria-label>`; result count in a polite live region |
| Detail | `role="region" aria-label`; replies `role="list"` |
| Modal | `role="dialog" aria-modal="true"`, focus trap, `aria-describedby` consequence text |
| Loading | container `aria-busy="true"`; skeleton rows `aria-hidden` |
| Color-only meaning | none: every dot has a label; kind pills are text |

## 9. Responsive behavior

| Width | Layout |
|---|---|
| ≥1180 px | two columns: timeline `minmax(0,1fr)` + 420 px sticky detail; content max-width 1180 px, padding 32 px |
| 1024–1179 px | detail 360 px; toolbar wraps to two rows |
| 720–1023 px | single column; detail expands inline under the selected row (accordion); filters scroll horizontally |
| <720 px | single column, 18 px padding (Crisp media query pattern); actions wrap under the title; path row collapses to a title attribute; tags hidden in rows (shown in detail) |
| <480 px | presence = dot + count; audit footer one line; detail replaces the list full-width with a back action |

No horizontal page scrolling at any width; fixed 13/12 px type (no fluid scaling).

## 10. M4 additions (designed, deferred)

Header badge (`conversation.session.header.utilities`); right-pane compact tab; composer/reply/
resolve via `ctx.remote.commands.execute(agent, '/confluence …')` with a refetch after each action
(no optimistic UI); custom tool cards via `presentCall`/`presentResult`; entry hide/tombstone with
typed confirmation; optionally a Host-persisted user cursor.

## 11. Test and verification plan (without browser control)

Runs under `node --test` (plain ESM, no build). Acceptance IDs UI-01…UI-06, CON-UI-01, SEC-06 live in
`testing.md`; this section defines the local coverage that feeds them.

1. **Client registration test (`test/ui.registration.test.js`).** Load `client.js` in a VM with a fake
   `window.__ModuleLoader__.load` capturing the definition and a minimal React shim (hooks stubbed,
   components never rendered). Assert: definition id `dsh-confluence`; `inject` exactly
   `['slots','locale','layout']`; dictionaries registered via `ctx.effect`; `main` with
   `{name:'main', key:'confluence'}`; `sidebar.panellist` with `{id:'confluence', order:30}`;
   `label()` returns `t('panel')`; `inject()` exposes `t`/`closePanel`; no other slot registrations.
2. **i18n parity (`test/ui.i18n.test.js`).** `en`/`zh` key sets identical; every `t('…')` literal in
   `client.js` exists in both; the client dictionary deep-equals the flattened `ui` object of
   `locale/en.json`/`zh.json` (the M3 addition commit updates both); `meta.title`/`description`
   present; expected scaffold keys unchanged.
3. **Static source scan (`test/ui.static.test.js`).** `client.js`: no `http(s)://` absolute URL, no
   `iframe`, no `innerHTML`/`dangerouslySetInnerHTML`, no `document.body`/`write`, no `postMessage`,
   no `WebSocket`/`EventSource`, no `require('@deepseek-ai/`, no `fetch` other than the single
   relative route adapter call site (zero if `host.call` ships). Stylesheet: every `var(--dsw-…)` in
   the verified §6 list (plus `--dsh-frame-top-clearance` with fallback); no hex/rgb/hsl literals;
   `<svg>` artwork exempt.
4. **Payload contract (`test/ui.payload.test.js`, host-side).** Build snapshots from fixtures and
   assert protocol, required fields and types, caps (entries ≤50, preview ≤240, peers ≤8, audit ≤20,
   replies ≤50, response ≤128 KiB worst case), deterministic order (entries by `seq` desc),
   `board.unread` from `readThrough`, only the current workspace path absolute, no
   prompt/assistant/tool-output fields in `session`-derived records, ISO timestamps only.
5. **Adapter tests (`test/ui.adapter.test.js`).** Both adapters satisfy the same interface;
   `host.call` rejection normalizes to `{code, retryable}`; route adapter builds only relative
   same-origin GET URLs with `credentials:'same-origin'`/`cache:'no-store'`; non-JSON/oversized →
   `PANEL_TRANSPORT_BAD_PAYLOAD`; `markRead`/`setOptOut` in route mode return a capability error
   without a POST.
6. **State machine and polling (`test/ui.states.test.js`).** Payload → banner/state mapping for all
   states and their priority; stale/backoff schedule 5/10/20/30 s; pause when hidden; no overlapping
   polls; workspace switch aborts in flight.
7. **Accessibility static assertions.** Scan source for `aria-modal` dialog, `aria-pressed`,
   `role="switch"` + `aria-checked`, `aria-busy`, `aria-live`, labelled buttons; manual keyboard
   checklist during M3.
8. **Live check (M3, scratch profile only).** Refresh the existing GUI URL, open the rail entry, use
   `cordis_inspect_query` client `Slots` to confirm registrations, console shows no
   `slot entry crashed`, open/close/back, light+dark, narrow width, zh/en switch, `Theme.listTokens`
   matches the stylesheet, polling pauses when hidden (debug counters), chosen transport behaves as
   spiked. Report visual-verification limits if no page is attached.

## Spike items

See `plan/m0-spikes.md` §8 (S6) and §3.6 above (S-UI1…S-UI12), plus:

- **S-UI13** `ctx.locale.bind` placeholder interpolation and live language switch without remount.
  Fallback: one `format()` helper using `String.replace`.
- **S-UI14** `localStorage` availability/persistence in the DSH Web GUI session partition (shared
  across windows). Fallback: in-memory cursor only.
- **S-UI15** whether the page receives any slot props beyond `inject()` (session/agent identity for
  the private-session toggle target).
- **S-UI16** host CSS interaction with our `:focus-visible` ring and `prefers-reduced-motion`.

## Open questions

1. **markRead ownership** — the architecture doc lists a Host `markRead`; this design defines it as a
   user-cursor validation/mirror with the durable copy in `localStorage` (the model watermark stays
   tool-derived). Confirm that split, or mandate a Host-persisted cursor (needs a store-layout
   addition) before M3.2.
2. **Two-channel risk** — if `host.call` ships, keep the route adapter in the bundle (dead code with
   its own security surface) or build-flag it tests-only?
3. **Right-pane tab timing** — M3 or M4? ADR-0001 §12 defers only the badge.
4. **Empty-state copy** — "every session is told automatically" is only true when `pulse.enabled`
   and the workspace is not disabled; the copy must branch on effective config.
5. **Workspace switcher visibility** — proposed hide-unless-multiple; revisit after first-run
   feedback (a workspace-global panel listing other workspaces may surprise users).
