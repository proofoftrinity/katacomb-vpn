# Testing: the suite is the invariant

The test suite is the definition of what this app must keep doing. A change is done
when `npm run verify` is green, and not before; a refactor that turns a test red is
wrong until shown otherwise. The rules for changing the suite itself are in
`CLAUDE.md` ("The suite is the invariant").

## What runs

| Command | What it runs |
|---|---|
| `npm run verify` | `typecheck` then `test` - the gate, and what the commit hook runs |
| `npm run typecheck` | `tsc` over main+preload, renderer, and the tests (`tsconfig.test.json`) |
| `npm test` | `node --test` over `src/**/*.test.ts` and `test/**/*.test.ts`, then `go test ./...` in `daemon/`, then the architecture-doc check |
| `npm run test:daemon` | the Go tests alone |
| `npx electron-vite build && node scripts/check-bundle-requires.mjs` | CI: builds the app, then checks the bundles require no npm package ([ARCH-3]) |

- Node 22.18+ (native type stripping, `engines` in `package.json`); Go is the
  toolchain pinned in `daemon/go.mod`.
- Keep `npm test` around 15 s. Anything slower (fuzzing, mutation runs) gets its own
  script and its own CI step.
- Every test file prints a `MODULE_TYPELESS_PACKAGE_JSON` warning: `package.json` has
  no `"type"`, so Node re-parses each `.ts` file as ESM. Harmless and expected.

## Rule IDs

Every rule the docs state carries a stable ID where it is stated, and every test that
pins a rule carries that ID in its title. `test/invariants/registry.test.ts` checks
the link both ways, so deleting a rule's last test is a red suite, not a silent loss.

| Prefix | Defined in |
|---|---|
| `REL` | `docs/invariants/reliability.md` |
| `NT` | `docs/invariants/node-trust.md` |
| `SL` | `docs/invariants/session-lifecycle.md` |
| `PH` | `docs/privileged-helper.md` |
| `PRO` | `docs/protocols.md` |
| `MH` | `docs/multihop.md` |
| `PC` | `docs/provider-console.md` |
| `RN` | `docs/renderer.md` |
| `PKG` | `docs/packaging.md` |
| `ARCH` | `CLAUDE.md` |

- **Defining** an ID: put it at the start of the rule's bold head,
  `- **[REL-n] Refund on any failure.**`, or as a bare bold tag in front of a rule
  inside a paragraph, `**[NT-n]** Likewise, …`. Take the next free number; IDs are
  never renumbered or reused, because test titles and commit messages point at them.
- Every top-level bold rule in `docs/invariants/` must carry one. In the other docs,
  tag the sentences that state a rule, not history or facts.
- **Referring** to a rule anywhere else: a plain `[REL-1]`, no bold.
- **Pinning** a rule: the ID goes in the test's title, `test('[REL-1] a failed
  handshake refunds the session', …)`. A `describe` title pins for its whole block.
  `test.todo`, `test.skip` and `{ todo }` / `{ skip }` cite a rule without pinning it.
  In Go, put it in a `t.Run("[PH-3] …")` name, or in the comment block directly above
  `func TestX` / `func FuzzX`.

### `test/invariants/status.json`

A rule with no pinning test must be listed here with a reason. Changing this file
needs the user's explicit approval.

- `pending` - not pinned yet; the reason says what will pin it.
- `partial` - pinned, but part of the rule is not; the reason says which part.
- `manual` - only checkable by hand or in the release VM (`fullcycle`): systemd and
  maintainer-script behaviour, live-chain facts, UI copy.

The registry fails when a rule is in neither a test nor `pending`/`manual`, when a
pinned rule is still listed as `pending`/`manual`, and when a `partial` rule has no
test at all. The summary line (`ℹ N rules: …`) in `npm test` output is the current
count.

## Kinds of test, and how to write each

- **Pure module, imported directly.** Most of the suite. The module under test may
  have no runtime relative imports (the native runner cannot resolve `./x` without an
  extension) and must not import `electron`. Import it with its extension:
  `import { decideReconnect } from './connect-decisions.ts'`. New pure decision logic
  belongs in a module like `vpn/connect-decisions.ts`, so it can be tested this way.
- **Module the runner cannot load as-is.** Bundle the real source with esbuild and
  swap its imports for recording stubs, never a copy that can drift:
  `src/main/helper/privileged.test.ts` (relative imports and `fs`/`child_process`
  stubbed) and `src/main/helper/daemon-client.test.ts` (a real Unix socket) are the
  worked examples.
- **Cross-language corpus.** The TS config guard and the Go daemon guard read the same
  files, `daemon/internal/guard/testdata/corpus/` (format in its `README.md`), and both
  sides of the daemon wire protocol read
  `daemon/internal/protocol/testdata/corpus/protocol.json`. A behaviour change goes into
  the corpus, so both sides are held to it; never into one side's test alone.
- **Static rules** (`test/static/`). A rule about the code rather than about what it
  computes - one door into main, no synchronous privileged call, the IPC contract,
  every bring-up under the lock - is checked by parsing the source with the TypeScript
  compiler API (`test/harness/source.ts`). Keep each one narrow, give every allow-list
  entry a reason, and say in the failure message what to do.
  `test/harness/entry-points.ts` lists the handlers that buy a session, bring a tunnel up
  or change the active wallet; `test/static/entry-points.test.ts` derives those sets from
  the source and fails when they drift, so a test that loops over a list cannot miss a
  new handler. A known gap stays visible as a `test.todo` beside the passing check.
- **Golden transcripts.** `daemon/internal/ops/testdata/transcripts/` pins every root
  command line byte for byte. They are captured by
  `scripts/capture-helper-transcripts.sh` (docker, root) and replayed by
  `TestTranscriptParity`.
- **Real I/O.** Temp dirs (`mkdtempSync(tmpdir())`), loopback servers and real child
  processes are fine and preferred over mocks. A test never touches `~/.config` or the
  real network.

## Writing a test that guards a rule

- Assert at the boundary: the calls the code makes to its collaborators, what a
  handler returns, what it broadcasts, what lands on disk. Not internal variables, or
  the test breaks on a correct refactor.
- A refusal test also shows the same call going through once the reason is gone (a
  positive control); otherwise a broken fixture looks like a working guard.
- Before it merges, break the rule on purpose and watch the test go red. Say in the
  commit message what was broken.
- A bug fix starts with a test that fails on the bug.
