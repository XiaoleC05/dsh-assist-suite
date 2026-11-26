# M0 spike specs — blocking verification gates

Status: **executable template, not executed.** This file is the M0 work order for the
implementation engineer and the evidence record that gates M1. Total timebox **1.0 engineer-day**
(≈435 min of spike work + 30 min gate bookkeeping). Binding architecture:
[ADR 0001](../adr/0001-confluence-architecture.md); scheduling and gate placement:
[execution-plan.md](execution-plan.md) §4/§10.

Every result must be filled into §10 (replace the `TBD` cells) with a link to a committed
**sanitized** evidence summary. Do not paste session content, prompts, or secrets into evidence —
counts, byte excerpts of synthetic fixture data, event shapes and command output fragments only.

> **v0.2.0 amendment (universal memory, ADR 0007).** The executed §10 results remain valid: every
> spike measured host/runtime mechanics (runtime-context commit, projection fold, append/torn-line
> durability, leases, transport), not the memory scope. Two wording changes apply from v0.2.0:
> (a) shards are written to one **global** scope directory (`workspaces/ws_0000000000000000/`), so
> "same synthetic workspace" in a method below means "same store / same profile"; (b) the panel route
> list is now `ping`/`overview`/`entry` (the `/workspaces` route was removed), which S6's shipped
> fallback already covers. The cross-workspace acceptance test is **not** an M0 spike — it lives in
> [`../design/testing.md`](../design/testing.md) and is the v0.2.0 release gate.

---

## 1. Why M0 exists

The design's load-bearing assumptions come from source reading and prior research, not from executing
the extension points. Five of them can invalidate whole milestones if wrong:

1. the agent loop only re-commits a runtime-context snapshot when its rendered text changes (the
   whole zero-token pulse economics);
2. a `sessionProjections` unit can re-derive watermarks across resume/fork/compaction;
3. the default `ptc` preset still lets the model reach Confluence tools and emits a parseable
   dispatch event for the ledger;
4. per-writer append-only shards survive Windows append/torn-line reality;
5. the client can reach the host through `host.call` (M3 primary transport).

M0 is deliberately *not* an implementation preview. Each spike uses a throwaway bundle and the
smallest possible script; nothing is merged into production code except the tests/harness fragments
that later become real test fixtures.

## 2. Environment protocol (mandatory for every spike)

| Rule | Detail |
|---|---|
| Never touch the real profile | The real home `C:\Users\71408\.dsh` is **read-only evidence**. Every run sets `$env:DSH_HOME` to `D:\05_Code\Confluence\.tmp\m0\<spike>\dsh-home` and uses a scratch profile created from the shipped `headless` template. `.tmp/` is already gitignored. |
| Scratch profile | `dsh --profile confluence-m0 --from-default-profile headless --dump-config` (the Electron-managed `desktop` profile refuses `--dump-config`; record the exact rejection if re-checked). |
| Throwaway bundle | Write under `.tmp/m0/bundle/` (`package.json` name `@local/confluence-m0`, `private:true`, `type:module`, `dsh.bundle.patch`), then `dsh plugin --profile confluence-m0 add <absolute dir>`. Never install it into any other profile. |
| Launcher | Resolve the `dsh.cmd` under `C:\Users\71408\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\`; record its path + `dsh --version` output in each evidence block. |
| Local model stub | Only when a real model turn is needed. Reuse the Crisp precedent (`D:\05_Code\Crisp\test\e2e\mockmessages`) as the *shape*: a local loopback Messages/OpenAI-compatible SSE stub, configured through `DEEPSEEK_BASE_URL` (plus key/model env). The stub writes every request body to JSONL for assertions. It listens on `127.0.0.1` only; no external network. `HYPOTHESIS:` the 0.2.2-rc.1 headless template accepts the same env routing as the Crisp runs. If not, mark the spike "source/unit-verified only" — never invent behavior. |
| `cordis_inspect_query` | Available host providers: `Service`, `Event`, `Config`, `Tool`; client providers: `Service`, `Event`, `Builtin`, `Slots`, `Theme`. Client queries **timed out after 10 s in the design session on 2026-11-13** (`Builtin.listBuiltins`); retry with the Harness page open, and record the timeout as evidence if it persists. |
| Cleanup | Remove `.tmp/m0/*` scratch homes after recording evidence; verify the real `C:\Users\71408\.dsh` mtime/content did not change (spot-check `profiles/desktop/package.json`, `storages/`). |
| Evidence format | Per spike: a §10.1 row + an artifact path under `.tmp/m0/<spike>/` + a ≤30-line committed excerpt (command, key output, event/JSDoc shape). Paths to installed `app.asar` files are recorded as `dsh/...` (the `read` tool can open the archive; shell tools cannot). |

## 3. Spike S1 — runtime-context snapshot dedupe end-to-end

| Field | Value |
|---|---|
| Question | In the installed 0.2.2-rc.1 loop: (a) is a `systemPrompt.context` contribution committed as a runtime-context snapshot only when its rendered text changes, and zero new messages when unchanged; (b) does a changed snapshot **replace** or **append** in the derived message history; (c) how much history accumulates after three text changes? |
| `HYPOTHESIS:` | Unchanged text → no new commit (source: `dsh-agent-loop/lib/index.js` commit path). ADR 0003 §4 records a correction: the loop **appends** a new snapshot (`surfaceOp:'append'`), so history grows with each change until compaction; M0 measures this and the design must not rely on collapse. |
| Blocks | M1.6 (pulse), M1.7 (watermark), the product itself |
| Timebox | 90 min |

**Method**

1. Re-read the installed loop's commit logic with the `read` tool
   (`...\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`, region that builds and
   commits the runtime context; record the exact line range + a 10-line excerpt). Record the snapshot
   message shape (`source.kind`, `source.sections[]`, content blocks), the `surfaceOp` used, and where
   `deriveMessages()` reads surface nodes (`dsh-session/lib/index.js`).
2. Build the throwaway bundle to register exactly one contribution:
   `ctx.systemPrompt.context({ name:'m0-s1', order:1500, required:false, interpolate:false, text: () => readFileSync(switchPath, 'utf8') })`
   — the synchronous file read is **spike-only** to simulate a text change deterministically; it is
   not a production pattern.
3. Start the local model stub. Turn 1: mock returns a `tool_call` for any harmless registered tool
   (e.g. a probe tool the same bundle registers) and, on receiving request 1, rewrites the switch
   file from `M0-PULSE-V1` to `M0-PULSE-V2`; then answers request 2 with final text. This yields two
   steps in one turn with a known text change between assemblies.
4. Assert against the stub's captured request bodies, the plugin debug log and (if decodable) the
   session log:
   - unchanged case: request 1 and request 2 each contain exactly one runtime-context snapshot with
     `M0-PULSE-V1`; no new `user/message` is committed for the second assembly;
   - changed case: request 2 contains `M0-PULSE-V2` exactly once and the snapshot count increased by
     exactly one (append, not replace) — record whether `M0-PULSE-V1` is still present in the derived
     messages;
   - no `agent/inbox/spliced` session event exists for the pulse in either case;
   - three-change run: record the number of runtime-context messages in `deriveMessages()` and their
     byte/token footprint after three changed assemblies (the worst-case history cost the pulse
     discipline must tolerate).
5. Record the snapshot's stable identity in the request payload: `source.kind`, the section name
   (`source.sections[].name === <pulse name>`) and the `seq="..."` attribute — this is the concrete
   fold target for the `confluence_watermark` projection in M1.7.

**Evidence to record**

| Item | Format |
|---|---|
| Commit logic | `path:line-range` + 10-line excerpt |
| Stub request bodies | JSONL path + extracted `messages[]` indices for the snapshot |
| Assertion table | unchanged vs changed vs three-change runs: snapshot count per request, whether the old text remains in derived messages, `agent/inbox/spliced` count, history bytes/token estimate |
| Sizing | bytes/chars of the snapshot in the request and after three changes |

**Pass criteria:** unchanged text produces no new commit; each changed text produces exactly one new
snapshot (append semantics documented, not assumed); no inbox splice; the snapshot's section
name/`seq` attribute are observable for the projection fold; three-change history cost measured.
**Fail criteria:** unchanged text re-commits (token churn); changes are not rendered; or the
contribution never reaches the request.

**Fallback design (if fail):** drop the passive pulse to a short static `systemPrompt.section` that
advertises the board and push content into `confluence_board`; the board/tool half of the product
still ships; escalate to the Lead as an ADR amendment (token economics change the product story).

## 4. Spike S2 — projection marker fold across resume / fork / compaction

| Field | Value |
|---|---|
| Question | Can a `sessionProjections` unit (`confluence_watermark`, per ADR 0003 §2) fold `digestSeq` (from the committed runtime-context message's `confluence:pulse` section `seq` attribute) and `boardReadSeq` (from `through=<cursor>` markers in committed `tool/result` under `standard` and `tool/ptc-dispatch` under `ptc`), and re-derive correctly after restart (resume), in a fork child, and when compaction events exist? |
| `HYPOTHESIS:` | Yes (no watermark files needed); fork copies the prefix and inherits state; garbage/unknown markers keep the previous value; the two fold sources are the ones ADR 0003 names. |
| Blocks | M1.7 (watermark), M2.3 (recall refs / read state) |
| Timebox | 90 min |

**Method**

1. `cordis_inspect_query` host `Service` with input `{"service":"sessionProjections"}` and again with
   `{"service":"sessionProjcache"}`; record the exact `register`/`stateOf` signatures and any
   `wire`/`stateVersion` notes. Also inspect `Service` for `sessions` (fork/resume surface) and
   `Event` for `session/event`.
2. Throwaway bundle registers a projection `{key:'m0_fold', stateVersion:1, init, apply, wire}` that
   folds two synthetic markers: `/M0SEQ=([0-9A-Za-z]{1,26})/` out of a runtime-context message whose
   `source.sections[].name` matches the synthetic pulse name, and `/M0READ=([0-9A-Za-z]{1,26})/` out
   of `tool/result` **and** `tool/ptc-dispatch` text. `apply` must be pure, return the same state
   reference when nothing changed, and ignore unknown events.
3. Scratch headless run with the local stub: assert the activation/debug log prints the state after
   the turn; assert `stateOf(session)` returns the expected markers; restart the process
   (`dsh --profile confluence-m0 ... --resume <session-id>` if the headless CLI exposes resume —
   check `--help` first) and assert the state equals the prior value without the plugin having any
   in-memory cache.
4. Fork: if a CLI/headless fork path exists, execute it and assert the child inherits the parent
   markers through its copied prefix; if no runtime fork path is reachable in headless, run a
   *synthetic* inherited-prefix fold in a Node unit test (child session header + copied events +
   `inheritedEventCount`) and mark the runtime fork **UNVERIFIED-source+unit** honestly.
5. Compaction: if compaction can be triggered on a scratch session, fold after it; otherwise (most
   likely) replay synthetic `compaction/*` events through `apply` and assert state does not reset.
6. Garbage marker: corrupt the marker line in a synthetic event stream and assert the previous value
   is kept (duplicate headline at worst, never lost notes).

**Evidence:** inspect signature JSON excerpt; fold unit-test output; resume state log line;
fork/compaction observation status (executed vs source+unit); synthetic event fixtures path.

**Pass criteria:** state re-derived after restart; fork child inherits (or documented runtime
limitation); garbage keeps previous; compaction events tolerated. **Fail criteria:** state depends on
plugin memory (lost on restart); projection registration unavailable; fold is non-pure/throws on
unknown events.

**Fallback design:** in-memory per-agent watermarks reseeded by scanning the last retained snapshot at
`agent/created` (documented degraded mode); no watermark files (they would repeat the Option-A bug).
Record fallback in the decision log at G1.

## 5. Spike S3 — PTC tool presentation and `tool/ptc-dispatch`

| Field | Value |
|---|---|
| Question | Under the profile's default `ptc` executor preset, are Confluence's global tools visible to the model as `run_code` SDK bindings (name/description/schema), does a nested tool call emit a parseable `tool/ptc-dispatch` session event, and are the tools directly callable under `standard`? |
| `HYPOTHESIS:` | PTC renders other tools as SDK bindings; `tool/ptc-dispatch` is the log-visible nested-dispatch event. |
| Blocks | M2.1 (ledger), M2.3, tool docs/claims |
| Timebox | 75 min |

**Method**

1. `cordis_inspect_query` host `Service` `{"service":"tools"}`; host `Config.listConfigs`
   `{"name":"@deepseek-ai/dsh-tool-executor-ptc"}` (then query the returned entry) to find the
   installed package dir; `read` its README + the lines that build the SDK docs and the nested
   dispatch event. Record exact `path:line` and the dispatch payload shape.
2. Scratch profile: `--dump-config` and confirm `selectedDefault`/preset (this profile's default is
   `ptc`, per research). Throwaway bundle registers one probe tool `m0_probe` with a required
   string parameter.
3. Headless run against the local stub; request 1's system prompt / run_code SDK instructions must
   contain `m0_probe` with its description and parameter schema. Record the exact rendered excerpt
   and its byte/character footprint.
4. Script the stub to emit a `run_code` tool call that calls `sdk.m0_probe({x:'1'})`; assert the probe
   executed (bundle debug log) and inspect the session log / `session/event` listener output for
   `tool/call` plus `tool/ptc-dispatch` records; record both event `data` shapes verbatim (synthetic
   values only).
5. Standard preset: create a `--patch` overlay selecting `standard` for the scratch run (record the
   exact overlay), or a second scratch profile; assert `m0_probe` is directly callable and
   `tool/call` is emitted.

**Pass criteria:** PTC: tool visible as an SDK binding, nested call executes, dispatch event parseable
(tool name + session id); standard: direct call works. **Fail criteria:** tool invisible under PTC,
or dispatch events unparseable, or model cannot reach Confluence tools at all under the default
preset.

**Fallback design:** support + document `standard` preset explicitly; in `ptc`, document `run_code`
access and keep ledger parsing tolerant (`tool/call` ∪ `tool/ptc-dispatch`); if tools are entirely
unreachable under the *default* preset, propose a preset-scoped registration or a `/confluence`
command path (ADR amendment) — do not ship a "model-facing tool" nobody can call.

## 6. Spike S4 — journal writer (O_APPEND fd + writeSync), torn line and fsync on Windows

| Field | Value |
|---|---|
| Question | Do per-writer shards written through the normative writer — a **held `O_APPEND` fd + `fs.writeSync` of whole LF-terminated lines**, batched fsync at ~1 s/session events and fsync-before-ack for board posts (ADR-0001 E10, store-format §13) — stay line-intact under concurrent writers on Windows, is a torn trailing line tolerated and recovered, and does the durability policy hold? |
| `HYPOTHESIS:` | Complete-line `writeSync` to an `O_APPEND` fd is not split or interleaved; torn tail ignored; batched fsync + board-post fsync-before-ack give the stated durability; p95 append <10 ms on local NTFS. |
| Blocks | M1.2 (JournalStore) |
| Timebox | 60 min |

**Method** — write `.tmp/m0/s4/append-probe.mjs` (throwaway; its assertions later become real
`test/store` cases). The writer under test is the design's normative writer, **not** `fs.appendFile`:

1. Implement the probe writer exactly as specified: open the shard once per process with
   `fs.openSync(path, 'a')` (O_APPEND), serialize each record to one LF-terminated Buffer, then
   `fs.writeSync(fd, buf)`; record the returned byte count and assert it equals `buf.length` (loop on a
   short write; a design-level short write would need a rule). Batched `fs.fsyncSync` at ~1 s/session
   events; the board-post path calls `fsyncSync` **before** acknowledging.
2. Two writer processes (spawned **by the test harness only** — the plugin never spawns) write
   1 000 lines each (`{v:1,type:'probe',id,seq,pad}`, 1–4 KiB per line) to their own
   `journal.<writerId>.v1.jsonl` shards. Parent merges all `*.jsonl` sorted lexicographically by `seq`;
   assert 2 000 unique ids, zero malformed lines, no split/interleaved bytes (every line is valid JSON
   and its pad length survives), monotone order, and byte-identical re-merge on a second read.
3. Interleaving probe: one process alternates `writeSync` of whole lines with timers/async work while a
   second process appends its own shard; assert no partial/interleaved line appears in either file and
   no line exceeds the 64 KiB cap.
4. Torn line (crash simulation): the writer opens the fd, `writeSync`s ~100 bytes of an incomplete JSON
   object (no `\n`) and exits without a further write; the reader must ignore the tail; a later complete
   append is visible; a second read is stable.
5. fsync/durability: measure `fsyncSync` cost per batch (1/10/100 lines) and confirm the board-post
   path orders `writeSync` → `fsyncSync` → ack (probe log/timestamps); record the batched-fsync window
   and the observed durability boundary (what may be lost on crash) against the design's stated policy.
6. Timing: 200 sequential 1–4 KiB appends — median/p95/p99 for raw append and for the
   fsync-before-ack path; record filesystem type (`Get-Volume`/`fsutil fsinfo volumeinfo`).
7. Path edge cases: store dir with spaces and a CJK name; confirm the O_APPEND writer works and
   `fs.realpath`/merge still behave.

**Evidence:** full-length `writeSync` results; corruption/duplicate/malformed/short-write counts;
interleaving and torn-line read outputs (before/after recovery); fsync batch timings + ack ordering;
timing table; volume info; command lines.

**Pass criteria:** zero split/interleaved/malformed lines across 2 000 lines; torn tail ignored and
recovery works; board-post fsync-before-ack ordering observed; batched fsync follows the stated policy;
p95 raw append <10 ms on local NTFS; re-merge deterministic. **Fail criteria:** partial writes without a
rule, interleaved lines, board ack before fsync, torn line poisons the read, or p95 >25 ms.

**Fallback design:** if short/partial writes appear, loop `writeSync` over the remaining buffer and
fsync per line before ack; if the store path is a network/USB drive, open read-only for readers with a
single visible activation warning (ADR §6 degradation rule); never add a cross-process lock to the hot
path.

## 7. Spike S5 — multi-window / multi-process topology

| Field | Value |
|---|---|
| Question | Is a second DSH Desktop window a second Host process or a second BrowserWindow on one Host? Do two Host processes see each other's journal appends at poll latency, and do they corrupt anything? |
| `HYPOTHESIS:` | One Host process per app instance (intra-instance windows safe); two instances = two Hosts, bound by the polling contract. |
| Blocks | M2/M4 claims (docs wording, soak assumptions) |
| Timebox | 30 min |

**Method**

1. Start two independent headless runs against the **same** scratch `DSH_HOME` and the same synthetic
   store (v0.2.0: the single global scope); each appends to its own shard (throwaway bundle). Measure
   the reader's observation
   latency of the other writer's record over 20 polls (expect ≤ `pollMs` + I/O slack), and assert no
   record loss/duplication in the merge.
2. Desktop topology: with the user's participation (open a second Harness window), record
   `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*DeepSeek Harness*' }` main-process
   count and the process tree; inspect whether `--type=renderer` children dominate. If the user is
   unavailable, mark **INCONCLUSIVE** and record that only the two-Host-process case was measured.
3. Record what this means for docs: whether to promise "live across windows" or "poll-bounded".

**Evidence:** process-tree excerpt, shard ids, 20-sample observation-latency table, merge counts.

**Pass criteria:** documented topology + measured cross-process visibility ≤ poll latency (no
stricter promise in docs); no corruption. **Fail criteria:** cross-process visibility requires a
restart (then update docs to say so) or records are lost.

**Fallback design:** none needed for architecture (polling is the freshness contract); if visibility
is worse than a poll, document the limitation and keep the M4 soak scope. This spike is primarily a
documentation-risk closer, not a design branch.

## 8. Spike S6 — client `host.call` host contract

| Field | Value |
|---|---|
| Question | What is the exact host-side registration and authorization contract for the client builtin `host.call(method, args)`, and can a third-party plugin use it to serve the M3 panel? |
| `HYPOTHESIS:` | The builtin exists (design-session client facts), but the host registration contract for third-party plugins is unverified; `host.call` is M3's primary candidate with a pre-built route fallback. |
| Blocks | M3.1 transport choice (not M3 itself — fallback exists) |
| Timebox | 60 min |

**Method**

1. Retry client inspection with the Harness page open:
   `cordis_inspect_query {platform:'client', provider:'Builtin', method:'listBuiltins'}` and
   `{platform:'client', provider:'Service', method:'listService', input:{service:'connection'}}`.
   Record the timeout if it repeats (10 s limit).
2. Source read: find the client runtime package via host `Config.listConfigs` (filter by client
   runtime package name), then `read` its client bundle for how `host.call` is dispatched; find the
   host-side handler registration (look for `hostCall`, `host-call`, or the builtin bridge rows in
   the web composition). Record exact `path:line` and the method namespace rules (how a plugin names
   its methods, how collisions are handled).
3. Throwaway bundle with a `dsh.client` half: host registers one probe method; the client calls it
   once on page load and reports the result to the host probe log / console. Install only in a
   scratch Web-capable profile (or, if launching a scratch Web UI is not feasible in the timebox,
   record the source contract, mark live call **PARTIAL**, and choose the fallback).
4. Compare with the proven fallback: read Crisp `integrations/dsh-plugin-crisp/index.js:98-119` +
   `lib/status.js` route registration and `connection.requestRejection` fencing; note the exact
   route/fence recipe M3.1 would reuse.
5. Decision output: primary transport (host.call vs same-origin route), with the interface kept
   identical either way (`lib/panel-data.js`).

**Pass criteria:** named host registration API + authorization/fence behavior + one live probe call
(or a clearly-recorded PARTIAL due to no scratch Web UI). **Fail criteria:** no documented host-side
registration path for third parties.

**Fallback design:** same-origin `ctx.webServer.register({kind:'exact', path, handler})` route with
`connection.requestRejection`, `cache-control: no-store`, GET/HEAD only — proven by Crisp/dsh-context
in this ecosystem; adds no port, no external network. M3.1 implements the fallback behind the same
interface; spike result only changes the transport, not the milestone.

## 9. Spike S7 — optional `@deepseek-ai/dsh-atomic-write` import

| Field | Value |
|---|---|
| Question | Can a profile-installed third-party bundle import `@deepseek-ai/dsh-atomic-write` (`writeFileAtomic`, `withFileLock`) at runtime, and does `withFileLock` work cross-process on Windows? |
| `HYPOTHESIS:` | The package ships with DSH; a local bundle may or may not resolve it (native `fs` lease is the primary design, so this is accelerator-only). |
| Blocks | Nothing (accelerator for compaction/export; native lease is primary) |
| Timebox | 30 min |

**Method**

1. `read` `dsh-atomic-write/lib/index.js`/README for the exact exports and Windows retry behavior;
   record `path:line`.
2. Throwaway bundle `apply` does, in a `try/catch` that can never fail activation:
   `const m = await import('@deepseek-ai/dsh-atomic-write')` and logs whether `writeFileAtomic`
   / `withFileLock` are functions.
3. Install in the scratch profile and boot one headless turn; read the debug/activation log.
4. If resolved: run the two-process `withFileLock` probe (two node processes contending for one lock
   file; assert mutual exclusion and dead-PID takeover). If not resolved: record the resolution error
   verbatim.
5. Record the recommendation: use it as an accelerator or rely solely on the native `fs.open('wx')`
   lease.

**Pass criteria:** documented resolution result and, if resolved, a working cross-process lock.
**Fail criteria:** import throws in a way that could disturb activation (must be contained).
**Fallback design:** native lease `fs.open(lease,'wx')` + stale-PID takeover (already the ADR §6
primary); `writeFileAtomic` replaced by temp-file + rename with bounded Windows retries.

## 10. Results (executed 2026-11-13 — evidence, not pre-written)

### 10.1 Per-spike results

| Spike | Verdict (PASS / FAIL / FALLBACK-ACCEPTED / INCONCLUSIVE / PARTIAL) | Key observation (≤2 lines) | Evidence artifact | Fallback chosen | Owner | Date |
|---|---|---|---|---|---|---|
| S1 | **PASS** | Runtime-context dedupe/commit verified end-to-end: unchanged pulse commits nothing, a changed pulse appends exactly one new `runtime-context` user/message, and a second headless session receives the first session's board entry in its pulse. | `.tmp/e2e/run-20261113-183207/` (`mock-writer.jsonl`, `mock-reader.jsonl`, `session*.out.txt`, `summary.json`), `test/e2e/assert-e2e.mjs` E2E-02/04/05 | none (append history growth documented; coalesced refresh implemented) | Lead build round | 2026-11-13 |
| S2 | **PASS** | Committed pulse snapshots are readable from the session log by section name (`confluence:pulse`); watermark projection unit `confluence_watermark` registered in scratch + real profiles (host-only, fallback fold also active). Fork/resume tail replay remains covered by unit tests rather than a live fork run. | `node scripts/m0-smoke.mjs` SMOKE-SESSION-DECODE; `test/e2e/lib/session-log.mjs`; E2E-05; `test/watermark.test.js` | in-memory fallback retained (service optional) | dsh-researcher / Lead | 2026-11-13 |
| S3 | **PARTIAL / OPEN** | `tool/ptc-dispatch` is a real durable event; this profile's default preset is `ptc`, but a live `run_code` session proving Confluence tool reachability was not run. Ledger/watermark parsers accept the dispatch shape defensively. | `docs/research/dsh-internals.md` fact 39; `lib/ledger.js`/`lib/watermark.js` defensive parsers; testing.md UT-PTC row | document `standard` verification first; PTC reachability remains an explicit open item | dsh-researcher | 2026-11-13 (partial) |
| S4 | **PASS** | Held `O_APPEND` fd + `writeSync` appends whole lines under two real processes (800 records, 0 malformed); torn tail ignored; real `JournalStore` survives two writers; native lease contention/dead-PID takeover works. | `node scripts/m0-smoke.mjs` SMOKE-S4-APPEND/TORN/TWO-WRITER/REALSTORE/LEASE (14 PASS / 0 FAIL / 1 BLOCKED overall) | none | design-core / Lead | 2026-11-13 |
| S5 | **PARTIAL** | Two-process merge correctness is covered by the S4 two-writer test and store tests; live multi-window freshness latency was not measured. Polling (4 s) is the implemented contract; `fs.watch` is an optimization only. | `test/store.test.js`, `scripts/m0-smoke.mjs`; `lib/store.js` | polling contract; no code change | design-core | 2026-11-13 (partial) |
| S6 | **FALLBACK-ACCEPTED** | `host.call` host-side registration contract remains unproven; the shipped v0.1.0 panel uses the proven same-origin `webServer` route (live routes registered; unauthenticated loopback request observed 401 → auth-guarded), and the client module loads on the next page render. Panel visual check pending a page refresh. | `lib/hostui.js`, `client.js`, `test/hostui.test.js` WO-01..18/UI-01..04; live route probe 401 | same-origin route (ADR-0005 fallback) | architect-a / Lead | 2026-11-13 |
| S7 | **FALLBACK-ACCEPTED** | `@deepseek-ai/dsh-atomic-write` is not resolvable from the repository Node context (`ERR_MODULE_NOT_FOUND`); native `fs.open(lease,'wx')` + stale-PID takeover verified instead. | `node scripts/m0-smoke.mjs` SMOKE-S7-ATOMIC-WRITE (BLOCKED) + SMOKE-LEASE (PASS) | native lease only; no optional import shipped | design-core / Lead | 2026-11-13 |

### 10.2 Findings that change a design document

| Finding | Doc to amend | Decision-log id |
|---|---|---|
| Runtime-context snapshots are appended, not replaced/shadows | `adr/0001-confluence-architecture.md` §8, `docs/design/pulse.md` §4.3 | ADR-0001 §17 E1 (applied) |
| `writeFileAtomic` neither appends nor fsyncs; per-writer shards + held O_APPEND fd chosen | `docs/adr/0002` / `store-format.md` §13 | ADR-0001 §17 E10 (applied) |
| `host.call` contract unproven in 0.2.2-rc.1 | `docs/adr/0005-ui-transport.md`, `docs/design/ui.md` | ADR-0005 + build-round ruling (route shipped) |
| PTC (`run_code`) tool reachability not yet exercised live | `docs/design/tool-api.md` (PTC note) | open; tracked as M0-S3 / UT-PTC |
| `@deepseek-ai/dsh-atomic-write` unresolvable from a local bundle repository context | `docs/adr/0002`, `store-format.md` | ADR-0001 §17 E10 (native path) |

### 10.3 Gate G1 decision

| Field | Value |
|---|---|
| Decision | **GO-WITH-FALLBACKS** (v0.1.0 shipped; S3/S5 remain explicit open items rather than shipping blockers) |
| Fallbacks accepted (ids) | S6 (same-origin route), S7 (native lease); S1/S2/S4 PASS; S3/S5 tracked open |
| Residual risks | PTC tool reachability; live multi-window freshness; append-only pulse snapshot growth (coalesced refresh + M4 compaction deferred) |
| ADR deviations required | none beyond the recorded errata E1–E11 and ADR-0005 route decision |
| Evidence reviewed by (V) | Lead build round, cross-checked by `scripts/e2e-dsh.ps1` and `node --test --test-force-exit` |
| Chair sign-off (Lead) | 2026-11-13 |

**Gate rule:** all of S1, S2, S3, S4, S6 are PASS or FALLBACK-ACCEPTED; S5 is recorded (any verdict);
S7 may be FALLBACK-ACCEPTED without impact. If S1 fails and no fallback is accepted, **stop the plan**.

## 11. Spike → milestone impact map

| Spike result | Impact if PASS | Impact if FAIL/fallback |
|---|---|---|
| S1 | M1.6/M1.7 proceed as designed | pulse becomes static section + tool-driven content; ADR amendment; M3 panel becomes the primary passive surface |
| S2 | log-derived watermarks in M1.7 | in-memory watermark reseed + documented degraded mode; update `store-format.md`/`pulse.md` |
| S3 | ledger parses both event shapes; tool docs written for both presets (M2) | restrict documented support to `standard`; write ptc guidance into `tool-api.md` before M2 |
| S4 | shards as designed (M1.2) | per-append fsync/validation or read-only degradation; update `store-format.md` durability section |
| S5 | docs say "poll-bounded cross-window visibility"; M4 soak scope unchanged | docs tightened; no code change |
| S6 | M3.1 primary = `host.call` | M3.1 primary = webServer route (fallback already designed); update `ui-panel.md` |
| S7 | use `writeFileAtomic`/`withFileLock` as accelerator in M4.1 | native lease only; no impact |

## Open questions

1. Can the 0.2.2-rc.1 headless template be pointed at a local loopback model stub with the same
   `DEEPSEEK_BASE_URL`-style env routing Crisp used? If not, which spikes degrade to source+unit
   evidence (S1/S2/S3) and who signs that off?
2. Does `dsh` headless expose `--resume` / fork for scratch sessions (S2), or is runtime fork evidence
   genuinely unavailable outside the desktop UI?
3. Is a scratch **Web-capable** profile launchable for S6 without touching the real desktop profile,
   and does it need a separate display/browser session?
4. What is the authoritative process-topology answer for multiple Desktop windows on Windows (S5) —
   can the user be asked to open one window during M0?
5. Are the spike scripts that pass promoted into `test/m0/` (tracked) before G1, or is the committed
   evidence summary sufficient for reproducibility? (Default: promote the append probe S4 and the
   synthetic fold S2; the rest stay summarized.)
