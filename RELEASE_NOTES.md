# Katacomb VPN 1.11.1

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.11.1 is a packaging fix for the AppImage. It now starts on a stock Ubuntu 22.04 or
newer desktop without installing anything first, and it is 11 MB smaller. The app itself
and the .deb work exactly as in 1.11.0.

## Highlights

- **The AppImage no longer needs libfuse2.** Up to 1.11.0 it stopped before opening any
  window on a stock Ubuntu 22.04 or 24.04 desktop, with `dlopen(): error loading
  libfuse.so.2`, until you installed `libfuse2t64` or `libfuse2`, and it needed an extra
  FUSE 2 package on Fedora and Arch too. It now carries its own FUSE library and only
  needs the `fusermount` those desktops already have. Checked on Debian 12 and 13,
  Ubuntu 22.04, 24.04 and 26.04, and Fedora 44, none of them with libfuse2, and on a
  clean Ubuntu 24.04 desktop, including the VPN helper install.
- **A smaller download.** The AppImage is 138.6 MB instead of 149.7 MB.
- **Menu entries keep the Chromium sandbox where it works.** When AppImageLauncher adds
  the AppImage to your applications menu, the entry used to turn the sandbox off on every
  system. Now it is only turned off where the system cannot run it, such as Ubuntu
  24.04, exactly as when you start the file directly.
- **AppImageLauncher 2.2.0 can no longer start it.** If you run AppImages through
  AppImageLauncher and the app fails with `fuse: memory allocation failed`, upgrade
  AppImageLauncher to 3.0 or remove it. 2.2.0 fails the same way on every AppImage built
  with the current AppImage runtime.

## Fixes in 1.11.1

- Check that the AppImage starts on distros without libfuse2
- Stop the AppImage needing libfuse2

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
Pop!\_OS, Zorin). For this release the AppImage was also checked on a clean Ubuntu 24.04
desktop, and in containers on Debian 12 and 13, Ubuntu 22.04, 24.04 and 26.04, and
Fedora 44.

## Installation

**Recommended: .deb**

```bash
sudo apt install ./katacomb-vpn_1.11.1_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.11.1.AppImage
./katacomb-vpn-1.11.1.AppImage
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

GPL-3.0-or-later. Bundled binaries (v2ray, xray, hysteria) are under their respective
licenses. See
[THIRD-PARTY-LICENSES.md](https://github.com/trinitystake/katacomb-vpn/blob/main/THIRD-PARTY-LICENSES.md).
