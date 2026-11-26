# Publishing and release process (v0.4.0 — three-layer memory + style cards)

- Status: **v0.1.0 is committed, tagged and pushed to GitHub; no npm package and no GitHub release
  exist.** The v0.1.0 release commit is `6755bd7` on `main` with annotated tag `v0.1.0`. **v0.2.x,
  v0.3.0 and v0.4.0 have not been committed, tagged, pushed or published**; they are working-tree
  changes at the time of writing. Nothing in this document is a claim that an npm/public package
  release happened.
- Current artifact in the tree: `dsh-confluence` **v0.4.0**, `"private": true`, MIT — 20 host modules
  under `lib/`, the host entry `index.js`, the three-tab read-only panel (`client.js`), the
  `confluence.memory/v1` portability helpers (`lib/export.js`, `lib/profile.js`, `lib/memory.js`,
  `lib/style.js`) with the `memory-export.mjs` / `memory-import.mjs` CLIs, locale resources, icon,
  bundle patch and documentation.
- Breaking changes in v0.4.0 (ADR 0009, extends ADR 0008): long-term `pattern` memory with a
  candidate-confirmation flow, the persona section set, two-channel `style` cards, eight tools, four
  prompt blocks, a seven-route panel and the `confluence.memory/v1` export document replace the v0.3
  profile export; the old `profile-export.mjs` / `profile-import.mjs` scripts became
  `memory-export.mjs` / `memory-import.mjs`. Upgrade notes: [upgrade-v0.4.md](upgrade-v0.4.md).
- Related: [install guide](install.md), [implementation status](plan/implementation-status.md),
  [v0.4 interface contract](plan/v0.4-interfaces.md),
  [ADR 0009](adr/0009-long-term-memory-persona-style.md), [README](../README.md).

---

## 1. Repository and channel state

| Item | State |
|---|---|
| GitHub repository | `https://github.com/XiaoleC05/Confluence.git` — public; **design phase (`design-v1`) and v0.1.0 (`main` @ `6755bd7`, tag `v0.1.0`) are pushed** |
| Local repository | `D:\05_Code\Confluence`, branch `main`, remote `origin` set; **v0.1.0 tag present; v0.2.x/v0.3.0/v0.4.0 changes are uncommitted** |
| v0.1.0 release | **Committed + tagged + pushed** (`git ls-remote` confirms `main` = `6755bd7` and tag object `792b686`) — historical |
| v0.2.x / v0.3.0 release | **Not attempted** — no commit, tag, push, tarball or npm package |
| v0.4.0 release | **Not attempted** — no commit, tag, push, tarball or npm package; the tree is a release candidate |
| Push from this machine | **Executed over SSH** for v0.1.0 (`origin` push URL `git@github.com:XiaoleC05/Confluence.git`). Use SSH (`git push origin main --tags`) from this machine. |
| npm package | **Does not exist**; `"private": true` prevents accidental publication |
| GitHub release / tag | tag `v0.1.0` pushed; **no release page exists for any version** |
| Verification state | v0.1.0: offline suite 256/256, packaging 12/12, scratch-profile E2E 8/8, real-profile install + activation. v0.2.0 (2026-11-16): offline suite 291/291, packaging 17/17, offline cross-directory E2E 15/15 + 12/12. v0.3.0 (2026-11-19): offline suite 353/353, packaging 18/18, contract 24/24, offline E2E 17/17 + 15/15 (run `.tmp/e2e/run-20261119-032058`). **v0.4.0: the offline gates are run by the packaging workstream on the frozen tree and recorded by the Lead in `plan/implementation-status.md`; real-profile install, panel rendering and publish remain not executed** (see `install.md`). |

## 2. Versioning policy

- SemVer; current version **0.4.0** (private, unreleased).
- While the major version is `0`, a **minor** bump may carry breaking changes — v0.2.0, v0.3.0 and
  v0.4.0 all do; patch bumps are fixes.
- The version is declared in **one place**: `package.json`. `index.js` exports it from a single
  constant, the panel ping and the presence heartbeat report the same value, and
  `lib/export.js` `EXPORT_PRODUCER.version` must be bumped in the same commit; the packaging check
  asserts all of them (0.4.0).
- Tag format: `v<version>` (e.g. `v0.4.0`), created only on a release commit.
- Do **not** remove `"private": true` until install/activation verification has passed and an explicit
  publish decision is recorded (ADR addendum or Lead sign-off).

## 3. Pre-release checklist (run from the repository root)

1. **All tests pass offline** (module tests + packaging contract):

   ```powershell
   node --test --test-force-exit "test/*.test.js"
   node scripts/check.mjs
   ```

2. **Version and metadata are consistent** — `package.json` version `0.4.0`, `index.js` `VERSION`,
   `lib/hostui.js` `PLUGIN_VERSION`, the presence heartbeat version and `EXPORT_PRODUCER.version` all
   `0.4.0`; locale `meta.description` is the v0.4 three-layer description; README/status docs no
   longer describe the v0.3 profile export or six-tool surface as current.
3. **Config surface matches the contract** — `cordis.patch.yml` contains `memory` and `style` sections
   on top of `store`/`bus`/`profile`; no `maxEntriesPerWorkspace`, no top-level `pulse`/`export`; and it
   deep-equals `lib/config.js` DEFAULTS (the packaging check asserts this).
4. **Bundle surface is complete** — `index.js`, every required `lib/*.js` (20 modules), `client.js`,
   `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg` exist and are covered by
   `exports`/`files`.
5. **No-egress / privacy check** — static scan finds no `http(s)` imports, `fetch` outside the single
   panel route adapter, sockets, child processes or model calls; the store holds no prompt, assistant,
   tool-output or command text; redaction tests pass; the memory export is redacted and path-free.
6. **Install verification** — `install.md` §6 checks executed and recorded (or explicitly deferred with
   a reason; then do not call the build "verified"). The **offline scratch-profile** E2E covers the
   v0.4 flow; the **real desktop profile** install and the DSH restart after installing the linked
   bundle are still outstanding.
7. **Docs honesty pass** — README "Status", `plan/implementation-status.md`, `upgrade-v0.4.md` and this
   document match the executed evidence. Do not describe unimplemented or unverified features in the
   present tense.
8. **Secrets and local paths** — scan for API keys, tokens, absolute home paths, captured session
   content and `.tmp` scratch state. `.gitignore` excludes local exports and test scratch dirs.
9. **Pack contents inspected before any release** (see §4).

## 4. Pack and inspect (no registry access required)

`npm pack` builds the tarball locally; `--dry-run` lists the file set without writing it. Both work
offline for a dependency-free package.

```powershell
# List what would be packed (no network).
npm pack --dry-run --json

# At the release checkpoint: build the tarball and record its checksum.
npm pack
Get-FileHash .\dsh-confluence-0.4.0.tgz -Algorithm SHA256
```

Record the tarball **checksum (SHA-256)**, byte sizes and file count with the release notes. Because
the tree changes during the implementation round, the pack listing must be re-recorded at the release
checkpoint; a previous listing is not evidence for a later tree.

Expected tarball contents for the complete v0.4.0 tree (npm always includes `package.json`, `README*`,
`LICENSE` and the `files` allow-list; the `scripts/` CLIs and `test/`/`docs/` never ship):

```text
package/package.json
package/README.md
package/README.zh-CN.md
package/LICENSE
package/index.js
package/client.js
package/lib/board.js
package/lib/bus.js
package/lib/config.js
package/lib/context.js
package/lib/export.js
package/lib/facade.js
package/lib/hostui.js
package/lib/ledger.js
package/lib/memory.js
package/lib/presence.js
package/lib/profile.js
package/lib/pulse.js
package/lib/recall.js
package/lib/redact.js
package/lib/store.js
package/lib/style.js
package/lib/tools.js
package/lib/util.js
package/lib/watermark.js
package/lib/workspace.js
package/cordis.patch.yml
package/locale/en.json
package/locale/zh.json
package/icon.svg
```

That is **30 files** (the v0.3.0 inventory plus `lib/memory.js` and `lib/style.js`); the exact list is
owned by `package.json` `files`. A dry-run on the v0.4.0 tree reported exactly this 30-file listing
(`npm pack --dry-run --json`): `dsh-confluence-0.4.0.tgz`, packed size **267,319 B**, unpacked size
**1,066,162 B** — **no tarball was written**. Re-run the pack command on the final release tree and
record the real count, sizes and SHA-256; do not quote this dry-run as a release measurement.

Checks to perform on the listing:

- exactly one copy of each runtime/display file; no `test/`, `docs/`, `examples/`, `scripts/`, `.tmp/`
  or export-directory content leaks in (documentation ships via GitHub, not npm);
- `cordis.patch.yml`, `client.js`, every `lib/*.js`, both locales and `icon.svg` are present — without
  them the bundle is not installable/visible/functional;
- no `.jsonl`, `.log`, `.tgz` or snapshot artifacts from local verification runs;
- record a fresh listing + SHA-256 at the release checkpoint (a later tree invalidates earlier sizes).

### Historical reference — v0.1.0 pack listing

> The v0.1.0 tree packed **24 files** (`package.json`, both READMEs, `LICENSE`, `index.js`,
> `client.js`, the 15 `lib/*.js` modules, `cordis.patch.yml`, both locale files, `icon.svg`) in an
> executed `npm pack --dry-run`. Sizes and hashes must be re-recorded at the v0.4.0 release checkpoint.

## 5. Bundle registration for release notes

A published package is only installable if it declares the bundle correctly (all present):

- `dsh.bundle.patch` → `./cordis.patch.yml`, inserting one row, id `confluence`, name `dsh-confluence`;
- `engines.dsh` → `>=0.2.2-rc.1` so incompatible hosts refuse the install;
- locale `meta.title` / `meta.description` and the icon exported so Plugin Manager can display the
  bundle without activating it;
- `./client` export + `files` entries and the `dsh.client` manifest block for the panel half
  (`platform: 'web'`, `immediately: true`, inject sidebar + layout).

Do not hand-edit a user's profile `package.json` or `cordis.patch.yml` in release notes; document the
Plugin Manager / `dsh plugin add` paths instead.

## 6. Release steps (at the v0.4.0 release checkpoint, in order)

1. Run the §3 checklist on a clean checkout, after the round is merged and green.
2. Re-run the offline scratch-profile E2E on the final tree and record its run directory in
   `plan/implementation-status.md` and `install.md`; do not re-record an old run as new evidence.
3. Re-run §4 pack inspection on the **final** tree; archive the listing and SHA-256 with the notes.
4. Commit: `chore(release): v0.4.0` (Lead owns commit/push).
5. Tag locally: `git tag -a v0.4.0 -m "Confluence v0.4.0 — long-term memory, persona and style cards"`.
6. Push `main` and the tag when credentials/network allow; create a GitHub release whose notes state
   exactly what was verified, and link the upgrade note for v0.3 users.
7. Publish to npm only after the private flag is deliberately removed and an npm account/token is
   available. `npm publish --dry-run` first; verify the file list matches §4; then publish.
8. Record the publication result (package URL, tarball SHA-256, date) in this document.

## 7. What must not be claimed

Until each item is actually executed and recorded, release notes and READMEs must not claim:

- that v0.4.0 was installed into the **real desktop profile**, that DSH was restarted onto it, or that
  activation was observed there;
- that the three-tab panel renders, or which transport shipped, without a recorded UI verification;
- that the v0.4 migration ran on a real profile;
- that offline installation with the network disabled was verified;
- that any v0.4.0 tarball was produced, hashed or published;
- that GitHub contains the v0.4.0 implementation before the push is confirmed.

## 8. Publication status

**Nothing was published.** No npm package and no GitHub release exist for any version. The design phase
and v0.1.0 are pushed to GitHub; the v0.2.x/v0.3.0/v0.4.0 work is a local working-tree change until the
release commit. Earlier local `npm pack --dry-run` inspections (design-stage 9 files, v0.1.0 24 files,
v0.3.0 28 files) and the v0.4.0 dry-run (30 files, 267,319 B packed / 1,066,162 B unpacked, 2026-11-27,
no tarball written) were executed locally only; no v0.4.0 tarball, tag, push or publication has
happened.

The v0.4.0 tree is a **release candidate**: its offline evidence is recorded by the Lead in
`plan/implementation-status.md`, but it is **not** installed on the real profile, its tarball and
SHA-256 do not exist, and no release/tag/push has happened. The next checkpoint is the release commit
plus the §4 pack inspection on the final tree (Lead-owned).
