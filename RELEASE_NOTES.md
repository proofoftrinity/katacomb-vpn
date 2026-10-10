# Katacomb VPN 1.16.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.16.0 lets you switch to another node, plan or chain while you are connected, where it
used to tell you to disconnect first. It also opens on a new welcome screen, redesigns the
wallets, and makes the tray show every connection state. Among the fixes: a double click
on Pay could buy two sessions, and a copied recovery phrase could stay on the clipboard.

## Highlights

- **Switch while connected.** Picking another node, plan or chain while connected used to
  end in "Disconnect first" over a greyed-out Pay. The review window in the Nodes, Plans
  and Multi-hop tabs now offers the switch in place:
  - a "Switches from" row heads the checks and states both costs: the current connection
    drops before the purchase, so your apps go out directly and the kill switch is off
    until the new one is up; and the session you leave stays open, to go back to or end
    from the Sessions tab;
  - Pay reads "Pay N P2P and switch". If the current connection cannot be dropped,
    nothing is bought;
  - if the new connection fails after the old one dropped, the error offers to reconnect
    to the one you had;
  - picking what already carries your connection (the same node, the plan subscription
    serving it, or the same chain) says so instead of selling it to you again;
  - a chain switch runs the wallet link check again after leaving, since through the
    tunnel it often cannot run.

  In the Sessions tab, Reconnect on another session also works while connected, with no
  new purchase.
- **Disconnect sits next to whatever needs it.** The Provider tab, Manage subscription,
  wallet changes and the VPN helper update still need the connection down. Each now has a
  Disconnect button beside its reason, instead of pointing you at the header. After a
  Disconnect in the Provider tab, a Resume bar brings the connection back once your
  changes are done. The "a tunnel is already up" banner over the Multi-hop tab is gone.
- **A welcome screen on first launch.** A new install opens on a page that says what the
  app is: the logo, how it works, a live world map of where the nodes are (for example
  "1,453 nodes online in 84 countries"), what it offers, and three steps to a first
  connection, including that you will need P2P. The map uses the node list the app
  already downloads, and its count is the one the Map tab shows. Create, Import, Welcome
  back and the other wallet setup screens now carry the logo too, and Welcome back
  scrolls when the wallet list is long.
- **The wallets are redesigned.** Settings > Wallets shows one card per seed, with a row
  per wallet. The active wallet is highlighted and shows its balance. Switch is the only
  button on a row; rename, copy and delete are icons. The Welcome back screen and the
  top bar's Wallet menu use the same look. Only the active wallet's balance is read:
  reading every address at once would tell the RPC operator they belong to one person.
- **A copied recovery phrase no longer stays on the clipboard.** Copying a phrase sets a
  wipe for 30 seconds later, but closing the screen that copied it cancelled the wipe.
  The create screen closes the moment the new wallet opens, and the Recovery phrase
  window closes on Done, so the phrase usually stayed on the clipboard. The wipe now runs
  whether or not the screen is still open.
- **One connection is set up at a time.** Buying a session and bringing it up takes 10 to
  40 seconds with no tunnel yet, and in that window a second purchase or reconnect could
  start beside the first: a double click on Pay, the tray's Connect, or a Reconnect in
  the Sessions tab. That could buy a second session, or leave the tunnel and the quota
  the app watches belonging to different sessions. A second one is now refused until the
  first finishes. Reconnecting a session that has used everything it was paid for is
  refused too.
- **The tray shows every connection state.** The tray icon's K is an outline when
  disconnected, fills from the bottom (amber) while connecting or reconnecting, is solid
  green when connected, and turns red with a slash through it while the kill switch
  blocks all traffic, so the state reads without relying on colour. Its menu says what is
  happening, with the node's name ("Connecting to …", "Reconnecting to … (2 of 5)",
  "Internet blocked by the kill switch"), and offers the one action that fits: Disconnect,
  Restore internet, or Reconnect last session, which reconnects your most recent open
  session and shows any error on the Sessions tab. A chain is named by its exit node, and
  Quit reads "Disconnect and quit" while connected.
- **Gas and fee failures are no longer reported as "not enough P2P".** A transaction that
  ran out of gas, or offered a fee under the network's minimum, said your wallet was
  short, that nothing was charged, and to top up, which fixes neither. Out of gas now
  says the fee may have been charged and asks you to retry; a low fee shows the chain's
  own message. A funds failure inside a block no longer claims nothing was charged.
- **Every country has its flag, and Turkey is on the globe.** 21 countries in the node
  list had no flag, among them Angola, Chad, Kosovo, South Sudan and Syria. Turkey's
  nodes were missing from the globe and the maps because they expected "Türkiye", and
  Congo (DRC) the same way. Countries are now matched by ISO code everywhere.
- **Smaller fixes:**
  - importing a seed that is already stored now offers "Use that wallet", instead of
    showing a raw error;
  - a refused wallet rename now says why, instead of doing nothing;
  - choosing another account index in New wallet no longer keeps the previous account's
    address selected;
  - on a first launch, the app no longer reads the whole node directory twice at once,
    which got one of the reads refused (HTTP 429);
  - GitHub links point at the proofoftrinity account after its rename.
- **The test suite now covers the Provider tab.** 108 of the app's 111 documented rules
  have a test that goes red if a change breaks it; the other three are blockchain facts,
  re-checked by a separate script. The Provider console, which escrows lease funds and
  pays the registration deposit, had none; it now has seven rules with tests and nine
  mutation canaries. A canary now counts as caught only when its own rule's test fails.
  Nothing changes in use.
- **Nothing else changes.** The packaging is the same as in 1.15.0, apart from the
  redrawn tray icons.

## Fixes in 1.16.0

<!-- regenerated by release.sh from v1.15.0..HEAD at cut time; leave the heading -->

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
curl -sS https://keybase.io/trinitystake/pgp_keys.asc | gpg --import
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
root. See [CLAUDE.md](https://github.com/proofoftrinity/katacomb-vpn/blob/main/CLAUDE.md)
for the full threat model and architecture.

## License

GPL-3.0-or-later. Bundled binaries (v2ray, xray, hysteria) and the libraries compiled
into the app and its VPN helper are under their own licenses, whose texts ship in the
packages. See
[THIRD-PARTY-LICENSES.md](https://github.com/proofoftrinity/katacomb-vpn/blob/main/THIRD-PARTY-LICENSES.md).
