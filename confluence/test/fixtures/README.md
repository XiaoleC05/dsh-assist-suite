# Test fixtures

Synthetic data only. Nothing in this directory is captured from a real session, a real
credential, or the user's filesystem; every value is invented for tests and safe to commit.
Fixtures live here (not under `test/e2e/`) so both the E2E harness and the future unit suites
can share one copy, and so the future Go consumer conformance fixtures
(`docs/design/solo-bench-integration.md` §9, `GOCON-*`) have a natural home.

| Path | Used by | Purpose |
|---|---|---|
| `secrets/corpus.json` | `scripts/m0-smoke.mjs` fixture self-check now; `test/redact.test.js` (WP2) later | Fake secret corpus for redaction rules. `match` cases must lose their raw value; `preserve` cases must survive redaction unchanged. |
| `journal/sample-records.jsonl` | `scripts/m0-smoke.mjs` parse/merge self-check | Hand-written v1 record envelopes (entry/session, ULID `seq`, ISO `ts`) that match `docs/design/data-model.md` §1–§4. Used to keep the smoke parser honest before/after `lib/store.js` lands. |
| `pulse/cap-cases.json` | `scripts/m0-smoke.mjs` invariant self-check now; `test/pulse.test.js` (WP4) later | `buildPulseText(input)` cases covering empty/steady/welcome/CJK/hostile/overflow states with the 1 400-char and 320-token caps from `docs/design/pulse.md` §6. |
| `export/` | **not created yet** | Reserved for M4 `EXP-*`/`GOCON-*` conformance fixtures (`memories.v1.jsonl` + `manifest.json`). Do not create here until the export implementation is reviewed. |

Rules for adding fixtures:

1. Synthetic or clearly-licensed data only; never paste session content, prompts, or real keys.
2. Prefer a documented JSON envelope with a `$schema`/`description` header over loose snippets.
3. A fixture that cannot be referenced by a test ID is dead weight: add the referencing test in the
   same change or annotate the intended owner file in the table above.
4. Keep fixture bytes small (the whole directory is hand-authored documentation-adjacent content).
