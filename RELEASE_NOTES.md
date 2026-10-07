# Katacomb VPN 1.15.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.15.0 rebuilds the Plans and Provider tabs to match the rest of the app, and reads
plans with more than 50 nodes in full. It also fixes three reconnect bugs. In one, every
automatic reconnect put you back on the node's own DNS servers.

## Highlights

- **Plans are easier to compare.** The Plans tab is now a sortable table of every plan,
  with a detail pane beside it. The pane shows the plan's value per GB against every
  other listed plan and against paying a node directly. It also shows a map of the
  countries its nodes cover and the protocols they run. Up, Down, Home and End move
  through the table, and Enter opens the selected plan's review. Under My plans, each
  active plan subscription shows how much of its time and its data you have used.
- **Plans with more than 50 nodes are read in full.** A bug in the blockchain's own
  query (sentinelhub v12.0.2) cut every plan's node list at 50: plan 41 showed 50 of its
  more than 800 nodes. The app now works around it in the catalog, the plan's detail pane, smart
  connect's list of candidates and the Provider tab. Smart connect now has the whole
  list to work through, so it stops after 10 nodes fail the checks it runs before paying,
  and says that nothing was bought.
- **The Provider tab is rebuilt**, for anyone selling bandwidth:
  - one bar at the top carries your provider, with its Burn, In escrow and Income
    figures; the setup steps are laid out as a route below it;
  - an Overview shows when each lease runs out (soonest first), what each node costs
    per day, and the income from each plan;
  - each plan gets a workspace:
    - switches for its status and visibility;
    - a break-even meter, showing how many active subscribers would cover your
      running leases;
    - a **Will subscribers find it?** checklist;
    - **See it as a subscriber**, which opens the catalog on that plan and names any
      filter that hides it;
  - a plan's nodes are listed with a bar for each lease, and an **Add nodes** drawer
    leases and links more;
  - an amber dot on the Provider tab warns while a lease set never to renew has less
    than a day left.
- **New plan and Edit details follow the same layout.**
  - **New plan** shows:
    - the terms, with presets and their break-even;
    - the draft's value against the plans subscribers see;
    - the same checklist;
    - the limits on size, days and price.
  - **Edit details** previews the catalog heading as you type, and warns when a name
    will be filed under Test plans.
  - **Renaming your provider shows in the catalog at once.** Before, a provider renamed
    away from a test-looking name stayed under Test plans for up to an hour.
- **Lease and link asks once.** It no longer stacks a second confirmation on top of its
  own review window.
- **Automatic reconnect keeps your DNS choice.** On WireGuard and AmneziaWG, the
  resolver you pick in Settings replaces the node's own DNS servers when you connect.
  Every automatic reconnect brought the node's servers back, for the rest of that
  connection. It now applies your choice again. With System Default selected, nothing
  changes.
- **Reconnecting from the Sessions tab brings up the session you clicked.** After a
  connect to one session failed, reconnecting a different session from the Sessions tab
  could bring up the first session's tunnel, while the app counted usage against the
  second. This affected WireGuard with System Default DNS, and V2Ray.
- **Giving up on reconnecting no longer races the last attempt.** Automatic reconnect
  could run out of attempts just as a V2Ray, XRAY or Hysteria2 core exited. Its cleanup
  then ran alongside the last attempt while that attempt was still bringing the tunnel
  up. The cleanup now waits its turn, and does nothing if you have disconnected or the
  attempt succeeded.
- **A bundled binary without a recorded checksum is refused.** Before running a bundled
  protocol binary, the app checks it against a SHA-256 checksum recorded in the app. A
  binary with no recorded checksum used to be let through; it is now refused. Every
  binary in 1.15.0 has one, so nothing changes in use.
- **Smaller fixes:**
  - dollar estimates no longer print as "$1.9e-7";
  - disabled buttons look disabled in every tab;
  - the Sessions and Multi-hop tab badges have their tint back, and the globe's
    recenter button and stats chip have their panel back;
  - "Leased, not linked" no longer offers Link on a node that is already linked;
  - the Provider plan list no longer cuts off its counters.
- **A test suite now guards the app's rules.** 95 of the app's 98 documented rules now
  have a test that goes red if a change breaks it. The other three are facts about the
  blockchain, re-checked against it by a separate script. The tested rules include:
  - refunds after a failed connection;
  - one connection at a time;
  - the kill switch's life cycle;
  - what may reach root.

  Each money, root and privacy rule is also broken on purpose to prove its tests catch
  it. The suite found the three reconnect bugs above. Nothing changes in use.
- **Nothing else changes.** The packaging is the same as in 1.14.1.

## Fixes in 1.15.0

- Add npm run check:chain, a mainnet re-check of the SL-2..SL-4 chain facts
- Keep the chosen resolver when the reconnect ladder brings WireGuard back
- Pin the partial rules and the install scripts, and run the copy rules
- Move the Sessions card's rules into tested pure functions
- Fuzz the parsers root exposes, and hold both sides of the socket to one corpus
- Pin the user's data across upgrades, credential storage, and the signed reply
- Pin how a connection ends, what main asks of signing nodes, and the root sinks
- Mutation canaries: prove the suite still catches each money, root and privacy regression
- Record the two reconnect fixes in the reliability invariants
- Run the reconnect give-up teardown under the connection lock
- Connect brings up the config it is handed, not one stashed by a failed connect
- Drive the real connection state machine in tests: money, lifecycle, wallet, trust
- Pin the rules that live in the code's shape: static checks and a CI build
- Make the test suite the invariant: rule IDs, a registry, typed tests
- New plan: terms beside the value strip, no steps card
- Bring New plan and Edit details in line with the redesign
- Document the colour-class rule and the linked-list rule
- Fix the remaining dead colour classes and a false Link offer
- Add the deferred Plans and Provider items
- Align the Provider node tables and document the new tabs
- Rebuild the Provider tab in the app's visual language
- Rebuild the Plans tab in the app's visual language
- Read every node of a plan, not the first 50

## Known limitations

- **A chain has a hard life of about two hours.** Measured on mainnet: exit hops report
  no usage to the chain, so the exit's idle deadline is pinned at purchase and never
  moves, even while the entry still has quota. This is node-side behaviour, not a client
  bug, but it is yours to plan around. The app warns you about 10 minutes before the
  exit closes.
- Chains can only be built from V2Ray and XRAY nodes. The other protocols have no
  equivalent of the relay mechanism a chain needs.
- Expect roughly 2 to 3 MB/s and a large latency increase on a chain. Chains are for
  privacy, not speed.
- **Without systemd-resolved, a missing `resolvconf` still shows up after you pay.** The
  app cannot safely install one on such a system, so a WireGuard or AmneziaWG connection
  there pays first, then offers Retry without VPN DNS on the same session, which sends
  your DNS queries outside the tunnel. To avoid it, set up a resolvconf provider such as
  `openresolv` the way your distribution documents.
- Local-proxy mode tunnels only the apps you point at its SOCKS address. Everything else
  leaks, by design, and the kill switch does not apply.
- **A node that does not sign its handshake reply can be impersonated**, and today that
  is nearly every node. The TLS and Reality wrapping does not authenticate the node, and
  there is nothing on chain to check its certificate against, so an attacker on your
  local network can answer the handshake in its place. A node reported at dvpnd 9.4 or
  later is required to sign, which closes this for it, but almost no node runs that
  version yet.
- **The wallet link check sees direct transfers only.** Two wallets funded from the same
  third account of yours are still linked on chain, and the review cannot tell.

## Platform support

**Linux x86_64 only.** Tested on Debian 11+, Ubuntu 20.04+, and derivatives (Mint,
Pop!\_OS, Zorin). The packaging is unchanged since 1.11.2, whose .deb and AppImage were
checked on a clean Ubuntu 24.04 desktop, the .deb in containers on Debian 12 and 13 and
Ubuntu 22.04, 24.04 and 26.04, and the AppImage in containers on those and Fedora 44.

## Installation

**Recommended: .deb**

```bash
sudo apt install ./katacomb-vpn_1.15.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.15.0.AppImage
./katacomb-vpn-1.15.0.AppImage
```

No install needed. The first connection that needs the VPN helper installs it, with one
password prompt. After that each privileged operation prompts for a password, cached for
a few minutes.

## Verifying your download

```bash
sha256sum -c SHA256SUMS --ignore-missing
gpg --verify SHA256SUMS.asc SHA256SUMS
```

Signed with key `740A F267 B0D8 162B E477 779D 7315 246A 6E67 F3C6`. Import it first if
you have not already:

```bash
curl -sS https://github.com/trinitystake.gpg | gpg --import
```

## Important

- **Connecting spends real funds.** Sessions are blockchain transactions priced in
  `udvpn`, and a failed connection is refunded automatically, but an expired one is not.
- **The AppImage needs a `fusermount` before it starts**, which stock desktops already
  have. If `command -v fusermount3 fusermount` prints nothing, install `fuse3`; on Arch,
  `nss` too. AppImageLauncher 2.2.0 cannot start it: upgrade to 3.0 or remove it. The
  `APPIMAGE_EXTRACT_AND_RUN=1` workaround avoids needing FUSE. See the README.
- **AppImage on Ubuntu 24.04+** runs with the Chromium sandbox disabled. An AppImage can
  install neither an AppArmor profile nor a SUID sandbox helper, so prefer the .deb there.

## Security model

Node operators are treated as adversaries. Everything a node sends is validated before it
reaches a privileged operation, because a VPN config can otherwise run shell commands as
root. See [CLAUDE.md](https://github.com/trinitystake/katacomb-vpn/blob/main/CLAUDE.md)
for the full threat model and architecture.

## License

GPL-3.0-or-later. Bundled binaries (v2ray, xray, hysteria) and the libraries compiled
into the app and its VPN helper are under their own licenses, whose texts ship in the
packages. See
[THIRD-PARTY-LICENSES.md](https://github.com/trinitystake/katacomb-vpn/blob/main/THIRD-PARTY-LICENSES.md).
