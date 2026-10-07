# settings.json / wallets-index.json as past releases wrote them

One pair per generation of `DEFAULT_SETTINGS` in `src/main/settings.ts`, named by the
commit that introduced it, filled in the way a real user's file is: `saveSettings`
re-serializes every default, so a file carries every key of its generation, here with
non-default choices (active wallet, kill switch on, a custom resolver, bookmarks,
custom split routes) so the test can tell whether a migration kept them.

| File | What is distinctive about the generation |
|---|---|
| G0-f8bdbef | six keys later removed (polling knobs, plan discovery); a custom RPC endpoint |
| G1-f7865a4 | wallet entries gain `accountIndex` |
| G2-a14ee1b | global `providerMode: true`, which `migrateProviderModeToWallet` moves onto the active wallet |
| G3-904787f | `retainedSeedId`; `providerMode` lives on the wallet entry |
| G4-8cae033 | `lanSharing` |
| G5-dcb4dc4 | `rpcMode` (current shape) |

Never edit one to make a test pass: they are what is on users' disks. A new
generation (a key added or retired in `DEFAULT_SETTINGS`) gets a new pair.
