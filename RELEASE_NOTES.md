# Katacomb VPN 1.11.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.11.0 changes the first launch. The window now opens straight away, every time, and
nothing asks for an admin password until a connection needs something this computer is
missing. When one does, the app says so before anything is paid and installs it in one
click. This mostly matters for the AppImage: the .deb still installs the helper, WireGuard
tools and OpenVPN with the package.

## Highlights

- **No pop-ups at launch.** Up to 1.10.0 the AppImage opened two blocking dialogs before
  its window, one to install `wireguard-tools` and one to install the VPN helper, each
  asking for an admin password before you could have created a wallet, let alone
  connected. Skipping one left no way back except restarting the app, and the package
  install only worked on apt-based systems. Both dialogs are gone.
- **Missing setup is caught before you pay.** Every connection first checks that this
  computer has what it needs: the VPN helper for any full-tunnel connection, WireGuard
  tools for WireGuard nodes, OpenVPN for OpenVPN nodes, and a `resolvconf` for the VPN's
  DNS on WireGuard and AmneziaWG. If anything is missing it stops with "Can't connect, not
  charged" and lists all of it in one pane, each item with an Install button. Try Again
  stays greyed out until everything reads Ready, then connects with the choices you
  already made. This covers a single node, a plan (smart connect checks once, before it
  tries any node), a two-hop chain, and reconnecting a paid session from the Sessions
  tab. Local proxy mode needs none of it.
- **Two cases that charged you for a connection that could not start are fixed.** A
  V2Ray, XRAY or Hysteria2 connection in full-tunnel mode paid first and then failed when
  the helper was missing, because the old check only looked for it on WireGuard,
  AmneziaWG and OpenVPN. And a helper left over from an older version, which can refuse a
  config as root after the session is bought, now reads "Needs update" and is replaced
  before any payment.
- **One-click installs on Debian, Ubuntu, Fedora and Arch.** The app uses apt, dnf or
  pacman, chosen from `/etc/os-release`, so derivatives such as Mint, Pop!\_OS, Rocky and
  Manjaro work too. Each install is one password prompt, and the app stays usable while
  the prompt is open. On any other distribution the pane names the package to install
  yourself.
- **New Settings > System tab.** The same checks, for setting things up ahead of time.
  Updating the helper is refused while you are connected, because it restarts the
  service that holds the tunnel up.
- **`resolvconf` is installed only where that is safe.** WireGuard and AmneziaWG need it
  to apply the VPN's DNS. Where systemd-resolved manages DNS (the default on Ubuntu, Mint
  and Fedora), the app installs the `resolvconf` that comes with it: `systemd-resolved`,
  or `systemd-resolvconf` on Arch. Anywhere else it installs nothing, because adding one
  there would change how the whole system handles DNS.

## Fixes in 1.10.0

- Speak the AmneziaWG 3.1 tier where a dvpnd node offers it

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
- The TLS and Reality wrapping does not authenticate the node. There is nothing on chain
  to verify a node's certificate against, so an attacker on your local network can answer
  a handshake in a node's place.

## Platform support

**Linux x86_64 only.** Tested on Debian 11+, Ubuntu 20.04+, and derivatives (Mint,
Pop!\_OS, Zorin). For this release the AppImage was also checked on clean Ubuntu 24.04,
Fedora 44 and Arch installs.

## Installation

**Recommended: .deb**

```bash
sudo apt install ./katacomb-vpn_1.10.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.10.0.AppImage
./katacomb-vpn-1.10.0.AppImage
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
- **The AppImage needs a few packages from your system before it starts**: `libfuse2t64`
  on Ubuntu 24.04+, `libfuse2` on 22.04, `fuse` on Fedora, `fuse2` and `nss` on Arch. The
  `APPIMAGE_EXTRACT_AND_RUN=1` workaround avoids needing FUSE. See the README.
- **AppImage on Ubuntu 24.04+** runs with the Chromium sandbox disabled. An AppImage can
  install neither an AppArmor profile nor a SUID sandbox helper, so prefer the .deb there.

## Security model

Node operators are treated as adversaries. Everything a node sends is validated before it
reaches a privileged operation, because a VPN config can otherwise run shell commands as
root. See [CLAUDE.md](https://github.com/trinitystake/katacomb-vpn/blob/main/CLAUDE.md)
for the full threat model and architecture.

## License

GPL-3.0-or-later. Bundled binaries (v2ray, xray, hysteria) are under their respective
licenses. See
[THIRD-PARTY-LICENSES.md](https://github.com/trinitystake/katacomb-vpn/blob/main/THIRD-PARTY-LICENSES.md).
