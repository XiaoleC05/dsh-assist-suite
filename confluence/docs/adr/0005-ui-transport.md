# ADR 0005 — Web panel data channel (host.call vs same-origin route)

- Status: **Round 3 — decision record** (design phase). The M3 spike has not run, so this ADR fixes
  the decision procedure, the interface and the fallback, not the final channel. Refines
  [ADR 0001](0001-confluence-architecture.md) §12 and [round-2](../discussion/round-2.md) R4.
- Date: 2026-11-13. Author: `design-surface`.
- Inputs: round-2 R4; live client inspection (Lead): the builtin `host.call(method, args)` exists;
  Crisp (`index.js:98-119`, `lib/status.js:290-339`) and dsh-context are the proven route precedents;
  [`security-privacy.md`](../design/security-privacy.md) §3.5/§3.11;
  [`ui.md`](../design/ui.md) §3; spike S6 in [`m0-spikes.md`](../plan/m0-spikes.md) §8.
- Target: DSH Desktop 0.2.2-rc.1 Web GUI, fully offline.

## Context

The M3 panel must read board data from the Host half under hard constraints: no network egress, no
additional port, no server, no iframe, no Harness client imports, no build step, 2.5 engineer-days
including this spike. Two candidate channels exist:

- **`host.call(method, args)`** — client builtin observed in live inspection. Its Host-side
  registration contract is unverified: namespacing, serialization, error shape, caller identity,
  disposal and cross-plugin isolation are unknown (HYPOTHESIS U1).
- **Same-origin Host route** — `ctx.webServer.register({ kind:'exact', path, handler })` (signature
  verified live) read by the client with `fetch`, as Crisp and dsh-context do. Proven, but it is an
  HTTP request on the existing local origin and needs defensive fencing
  (`connection.requestRejection(req)` exists and is called by Crisp; guarantees undocumented —
  HYPOTHESIS). Typert Remotes are unverified for third-party plain JS (option-b F15): not M3.

## Decision

1. **Contract before channel.** One JSON contract `confluence.panel.v1` (`ui.md` §3.5) behind one
   adapter interface; channel switching is a one-file change; both adapters share the tests.
2. **Primary candidate: `host.call`.** If the M3 spike proves a public, plugin-scoped Host
   registration passing all criteria below, ship it and ship no route and no `fetch` call site.
3. **Proven fallback: same-origin route.** GET/HEAD only, JSON, `cache-control: no-store`,
   `kind:'exact'`, prefix `/confluence/api/`, response ≤128 KiB, handler calls
   `connection.requestRejection(req)` first (rejection status returned as-is) and rejects a present
   foreign `Origin` / non-same-origin `Sec-Fetch-Site`. No request bodies, no POST: the only M3 write
   (opt-out) is unavailable here and the panel shows the `/confluence private` instruction.
4. **No second write channel, either way.** Panel writes beyond the user-preference opt-out are M4
   and go through the verified command surface (`ctx.remote.commands.execute(agent, '/confluence …')`);
   opt-out is one Host method also reachable by command. No POST endpoint ever writes board data.
5. **No iframe, no new port, no server, no egress.** The route lives on DSH's existing web server;
   `host.call` adds no transport. A static test asserts the client bundle has no absolute URL and at
   most the single relative route call site (zero if `host.call` ships).
6. **Polling is the freshness model.** 5 s while visible (`ui.pollMs`), pause when hidden, no
   push/SSE/WebSocket; no caching beyond component memory.

## M3 spike outcome criteria (ship `host.call` only if all hold)

1. Host registration is a public/documented extension point usable from a plain-ESM plugin (not a
   reserved first-party build-time table), discovered from the installed runtime.
2. JSON args/results round-trip (strings, numbers, booleans, null, arrays, nested objects, Unicode).
3. Errors arrive as structured rejections (`code`/`message`) distinguishable from transport failure.
4. Calls are scoped to the plugin's own Host half (no other plugin's method); reload disposal is clean.
5. No console errors, no extra network request, no new port, no CORS/preflight behavior involved.
6. No Harness client package import (`require('react')` only).
7. Survives a plugin HMR reload and a page refresh (reconnects or reports cleanly).

## Rejected alternatives

1. **Iframe-served page** — violates ADR-0001; loses theme tokens/locale/light-dark; reintroduces a
   document boundary.
2. **A local HTTP server or extra port** — violates "no server, no additional listening port".
3. **Typert runtime Remote namespace** — third-party registration unverified and outside M3 budget;
   revisit only if `host.call` and the route both prove unusable.
4. **Reading the M4 export via `workspaceFiles`** — couples the panel to opt-in export, requires a
   workspace write, and is stale by construction.
5. **POST route for panel writes** — duplicates the command surface, adds CSRF/fencing obligations,
   contradicts round-2 R4's "no second write channel".
6. **`postMessage`/BroadcastChannel between Host page and panel** — no Host endpoint exists and it
   widens the origin surface for no benefit.

## Consequences

- The panel never depends on transport specifics; the route fallback stays tested even if `host.call`
  ships, selected by one constant (bundle inclusion is a build decision, `ui.md` Open question 2).
- If the route ships, the client gains exactly one same-origin `fetch` call site; the no-egress test
  must encode "no network egress" and assert the URL is relative, GET-only and local.
- `host.call` remains a HYPOTHESIS until the spike; no doc may claim it as the shipped channel before
  then. Payload contract, polling semantics and security controls are transport-independent.
- Any future `host.call` deprecation is a one-adapter change plus a test update, not a redesign.

## Open questions

1. If `host.call` works, keep the route adapter in the shipped bundle as a dead fallback, or
   build-flag it tests-only to minimize attack surface?
2. Does the Lead accept "same-origin local fetch" as consistent with the brief's "no fetch" wording
   (interpreted as no network egress)?
3. Expose the transport mode in the panel footer for diagnostics (proposed yes; leaks nothing beyond
   a local UI label)?
