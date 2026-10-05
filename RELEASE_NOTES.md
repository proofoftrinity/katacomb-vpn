# Katacomb VPN 1.14.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.14.0 makes multi-hop private by default. A chain's two hops must now be in different
countries and on different networks, and the exit is paid from a second wallet, with no
way to override either. The connect windows, the Multi-hop picker and the connection bar
are redesigned.

## Highlights

- **A chain's two hops must be apart.** The entry and the exit must be in different
  countries, on different networks (ASNs) and in different address blocks, and must not
  share a domain. The old "build it anyway" option is gone: one hosting company, or one
  country's courts, could otherwise see both ends of your chain. A node the node list
  gives no country or network for cannot be used in a chain. When this was measured,
  about one pair in five failed the rule.
- **A chain needs a second wallet.** A session records the account that paid for it, and
  that record is public, so with one wallet either node could look up the other hop. The
  exit is now always paid from a second wallet. If you have only one, the review shows
  how to set one up: derive an account or add a wallet in Settings, then fund it from
  somewhere that never touched your main wallet. The app never moves funds between your
  wallets, because that transfer would be public too.
  - A transfer between the two wallets now stops the purchase instead of only warning.
    If your RPC endpoint cannot check (some keep no transaction index), the review says
    so in amber and lets you continue; it never reports that as clean.
  - Each wallet is checked against its own hop: the entry against your active wallet,
    the exit against the second one. The review used to compare the total with your
    active wallet alone.
- **One review window for every connection.** Connecting from Nodes, Plans or Multi-hop
  now shows the same layout: the route as a picture (your device, the node or nodes, the
  internet, and what each one sees), the checks with a fix beside each, one line per
  payment naming the wallet that pays it, the limits, and a footer that always names
  what is stopping Pay. The route stays on screen while it connects and if it fails.
  - A single-hop connection now says plainly that the node sees both your IP and the
    sites you visit, with a link to Multi-hop.
  - A chain's review states before you pay that the exit closes about 2 hours after you
    buy it, and warns if you are buying more hours than that.
- **A new Multi-hop picker.** The route is one bar at the top: you, the entry, the exit,
  the internet. Every node row has Entry and Exit buttons, so a node goes straight into
  either hop. A row that cannot be used next to your other hop says why ("same country",
  "same network"), Swap exchanges the two hops when both nodes can serve either role,
  and Pick for me fills both in one click. A small map shows where the two hops are; it
  never shows where you are, which the app does not look up. The bar replaces four rows
  of controls, so the table has more room.
- **Nodes too old to check are no longer listed on the Multi-hop tab.** Nodes older than
  9.0.0 publish nothing the app can check before you pay, so they could never be picked,
  and they were about a quarter of the list. Searching for one tells you why it is not
  there. They are still on the Nodes tab.
- **Signed Nodes Only is gone; a node that signs must sign.** If the node list reports a
  node at dvpnd 9.4 or later, an unsigned handshake reply from it is refused, before you
  pay where the node can be asked first and with a refund otherwise, so nobody can strip
  its signature and pose as it. Other nodes are accepted unsigned, as before. If you had
  the setting on, those nodes are no longer refused; the Signed filter on the Nodes tab
  still lists only the nodes that sign. Today 3 of about 1,800 active nodes report 9.4,
  and none of them is a V2Ray or XRAY node.
- **A connection capsule in the header.** While connected, the header shows the node (or
  both hops of a chain), the protocol, a teal key when the node's signature was verified,
  and your exit IP; click it for the details. Disconnect is a labelled button beside it.
  In the node list, a grey key marks nodes whose reported version signs: grey is what the
  node list claims, teal is what this app checked.
- **Sessions cards start with the route**, so each one shows where its traffic enters and
  where it leaves.
- **Nothing else changes.** The packaging is the same as in 1.13.0.

## Fixes in 1.14.0

- Multi-hop private by default; one review design; a route-bar picker
- Header: a connection capsule, one owner for the exit IP

## Known limitations

- **A chain has a hard life of about two hours.** Measured on mainnet: exit hops report
  no usage to the chain, so the exit's idle deadline is pinned at purchase and never
  moves, even while the entry still has quota. This is node-side behaviour, not a client
  bug, but it is yours to plan around.
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
sudo apt install ./katacomb-vpn_1.14.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.14.0.AppImage
./katacomb-vpn-1.14.0.AppImage
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
