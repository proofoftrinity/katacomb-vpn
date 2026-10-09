# Testing: the suite is the invariant

The test suite is the definition of what this app must keep doing. A change is done
when `npm run verify` is green, and not before; a refactor that turns a test red is
wrong until shown otherwise. The rules for changing the suite itself are in
`CLAUDE.md` ("The suite is the invariant").

## What runs

| Command | What it runs |
|---|---|
| `npm run verify` | `typecheck`, `test`, then `test:canaries` - the gate, and what the commit hook runs |
| `npm run typecheck` | `tsc` over main+preload, renderer, and the tests (`tsconfig.test.json`) |
| `npm test` | `node --test` over `src/**/*.test.ts` and `test/**/*.test.ts`, then `go test ./...` in `daemon/`, then the architecture-doc check |
| `npm run test:daemon` | the Go tests alone |
| `npm run test:canaries` | every mutation canary must turn its tests red (about 80 s) |
| `npm run test:fuzz` | each Go fuzz target for `FUZZTIME` (default 10 s); CI also runs the daemon under `-race` |
| `npm run check:chain [address…]` | the live-chain facts the `manual` rules SL-2..SL-4 rest on, read from mainnet; never part of `verify` (see below) |
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

The live-chain facts (SL-2, SL-3, SL-4) are re-checked with `npm run check:chain`:
after a hub upgrade, and whenever a change leans on one of them. It reads the app's own
wallets (or the addresses given), queries mainnet without signing anything, and prints
PASS, FAIL or NOT SEEN per fact; NOT SEEN means no session in those accounts was in the
state that shows it, so run it again while one is (a session the node has not reported
on yet, then one it has). The verdicts are `test/live/chain-facts.ts`, tested offline by
`chain-facts.test.ts` against two real reads; those tests prove the checker, not the
chain, which is why the rules stay `manual`.

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
- **The connection state machine** (`src/main/ipc-handlers.*.test.ts`: money, lifecycle,
  wallet, trust). `test/harness/ipc.ts` bundles the REAL `ipc-handlers.ts` with esbuild
  (`test/harness/bundle.ts`), replaces each collaborator in `FAKED` with a recorder
  generated from that module's real exports, and keeps everything pure real
  (connect-decisions, plan-connect, config-guard, validate, settings, kill-switch).
  - `const ipc = await loadIpcHandlers()` once per file; `const h = ipc.fresh(opts)` per
    test, with `t.after(() => h.dispose())`.
  - Drive it as the renderer does: `h.invoke('CONNECTION_SUBSCRIBE', req)`.
    `test/harness/requests.ts` has one valid request per purchase handler and the world
    each needs (`worldFor`).
  - Timers are mocked. `h.advance(ms)` lets virtual time pass; `h.settle(p)` drives it
    until `p` settles and fails a wait that never ends, which is how "bound every wait"
    is tested. `h.settleError(p)` returns the error of a call expected to fail.
  - Assert on what it did: `h.calls('chain/chain-service', 'endSession')`,
    `h.sent('CONNECTION_STATE_CHANGE')`, `h.tunnel` (the faked machine), files under
    `h.world.userData`. Never on its private variables.
  - Override a collaborator per test, typed against the real module:
    `fakes: { 'chain/chain-service': { performHandshake: async () => { throw err } } }`.
    A call nothing fakes throws `unstubbed mod.fn()`; an npm import the bundle did not
    expect fails the build.
  - A promise checked later must have its rejection handled at once
    (`.then(() => null, (e) => e)`), or node:test fails the test on the unhandled
    rejection.
- **One main-process module on its own** (`vpn-manager.test.ts`, `kill-switch.test.ts`):
  `loadModule({ entries, fake, stubs })` from `test/harness/module.ts`, the same bundling
  and fakes without the IPC layer. A handler group the IPC harness fakes whole (`FAKED`
  in `test/harness/ipc.ts`) is tested this way, or nothing runs it:
  `src/main/ipc/provider.test.ts` loads `ipc/provider.ts`, passes its
  `registerProviderHandlers` a recording `handle`, and invokes the handlers directly. `stubs` swaps an import for a harness file:
  `child_process` -> `test/harness/child-process.ts` (answered by `fakes.child_process`),
  `fs` -> `test/harness/fs.ts` (the real filesystem, but `fakes.fs.existsSync` decides
  paths outside the test's temp dirs, such as the system openvpn), and the SDK root ->
  `test/harness/sentinel-sdk.ts` (the real SDK, but `fakes.sdk.connectWithSigner` answers
  the signing connection a module opens on its own, as `endSession` does).
- **Scripts that run as root** (`test/static/privileged-install.test.ts`): the install
  steps are RUN in a temp sandbox, against a helper that is executing at the time, with
  only `chown`/`systemctl` stood in for. A string match would not show that `cp` onto a
  running binary fails.
- **Golden data files** (`test/fixtures/settings/`): the `settings.json` and
  `wallets-index.json` each past release wrote. `settings.test.ts` runs the startup
  migrations over every one ([ARCH-5]). They are what is on users' disks: never edit one
  to make a test pass; a new settings generation gets a new pair.
- **Cross-language corpus.** The TS config guard and the Go daemon guard read the same
  files, `daemon/internal/guard/testdata/corpus/` (format in its `README.md`), and both
  sides of the daemon wire protocol read
  `daemon/internal/protocol/testdata/corpus/protocol.json`: the framing, the op list, the
  limits both sides enforce (`limits`) and the shapes of the read-only replies
  (`results`). A behaviour change goes into the corpus, so both sides are held to it;
  never into one side's test alone.
- **Go fuzz targets** (`FuzzParseRequest`, `FuzzAssertWireguardConfig`, `FuzzToUAPI`)
  cover the parsers root exposes, seeded from the corpora, each asserting a property,
  not just "no panic". The guard's oracle is wg-quick's own line parser. A crasher lands
  in the package's `testdata/fuzz/`; commit it, and it runs with every `go test`.
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

## Mutation canaries

`test/canaries/canaries.ts` lists deliberate regressions, one per rule that guards
money, root or privacy: drop the refund, sign a hop's cancel with the wrong wallet,
delete an epoch check, let the daemon arm the kill switch for `0.0.0.0`. The runner
applies each to a private copy of the working tree and requires the named tests to go
RED; a canary the suite survives means nothing guards that rule any more.

- Every new money, root or privacy rule gets a canary, named `[ID] what breaks`.
- Caught means a failing test titled with that ID (for a `go:` target, a failing Go
  test). A mutation that breaks the build, or turns another rule's test red, is
  reported as not caught: it proves nothing about its own rule.
- `find` must match exactly once. When a refactor moves the anchor, the canary fails
  with "re-aim it": re-aim it at the new code, never delete it.
- A canary may name several test files (`run`), or `go:<package>` for the daemon.
- A canary may target a file under a linked tree (`resources/`): the runner gives that
  file a private copy first, so the mutation never reaches the real checkout.

## Writing a test that guards a rule

- Assert at the boundary: the calls the code makes to its collaborators, what a
  handler returns, what it broadcasts, what lands on disk. Not internal variables, or
  the test breaks on a correct refactor.
- A refusal test also shows the same call going through once the reason is gone (a
  positive control); otherwise a broken fixture looks like a working guard.
- Before it merges, break the rule on purpose and watch the test go red: as a canary
  for a money, root or privacy rule, otherwise once by hand, said in the commit message.
- A bug fix starts with a test that fails on the bug.
