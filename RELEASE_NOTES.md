# Katacomb VPN 1.18.1

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.18.1 is a small interface release. The version number at the bottom right of the
window now reads "About".

## Highlights

- **The version number at the bottom right now reads "About".** It showed the version
  (for example "v1.18.0"), and nothing told you that clicking it opened the About
  window. It now says "About" and opens the same window. Hover over it to see the
  version; the About window shows it too, and so does the tray's About item.

Nothing else changes. The packages hold the same files as 1.18.0's, with the same
dependencies, install scripts and VPN helper, so the AppImage does not ask to update the
helper. Only the app bundle is new.

## Fixes in 1.18.1

- Label the status bar's About button "About"
- Check Go files out with LF on Windows

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
- **Windows is a beta.** It was tested on Windows 11 only. Multi-hop chains and local proxy
  mode have not been tried on Windows yet: a chain runs the same XRAY path the Windows
  checks passed, but no chain was bought there.
- **On Windows, only the account that ran the installer can connect.** The service admits
  that account and refuses the other accounts on the same PC.

## Platform support

**Linux x86_64.** Tested on Debian 11+, Ubuntu 20.04+, and derivatives (Mint,
Pop!\_OS, Zorin). The packaging, the VPN helper and Electron are unchanged since 1.18.0,
whose .deb and AppImage were checked on a clean Ubuntu 24.04 desktop, the .deb in
containers on Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04, and the AppImage in
containers on those and Fedora 44.

**Windows 10 and 11, x64 (beta).** The installer script and the Windows service are
unchanged since 1.18.0, which was tested on Windows 11: the installer in a clean VM
(install, the service, the app, upgrade, uninstall), and connections on mainnet. Windows
10 has not been tested.

## Installation

**Recommended: .deb**

```bash
sudo apt install ./katacomb-vpn_1.18.1_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.18.1.AppImage
./katacomb-vpn-1.18.1.AppImage
```

No install needed. The first connection that needs the VPN helper installs it, with one
password prompt. After that each privileged operation prompts for a password, cached for
a few minutes.

**Windows 10 and 11 (beta): installer**

Run `katacomb-vpn-1.18.1-setup.exe` and approve the administrator prompt. SmartScreen
warns first because the installer is not code-signed: check the download as below, then
choose **More info** and **Run anyway**. To remove it, use Settings > Apps; your wallets
and settings stay in `%APPDATA%\katacomb-vpn`.

## Verifying your download

```bash
sha256sum -c SHA256SUMS --ignore-missing
gpg --verify SHA256SUMS.asc SHA256SUMS
```

Signed with key `740A F267 B0D8 162B E477 779D 7315 246A 6E67 F3C6`. Import it first if
you have not already:

```bash
curl -sS https://keybase.io/proofoftrinity/pgp_keys.asc | gpg --import
```

On Windows, `Get-FileHash .\katacomb-vpn-1.18.1-setup.exe` in PowerShell prints the hash
to compare with its line in `SHA256SUMS`, and Gpg4win's `gpg` runs the same `--verify`.

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

GPL-3.0-or-later. Bundled binaries (v2ray, xray, hysteria, and Wintun's driver library
on Windows) and the libraries compiled
into the app and its VPN helper are under their own licenses, whose texts ship in the
packages. See
[THIRD-PARTY-LICENSES.md](https://github.com/proofoftrinity/katacomb-vpn/blob/main/THIRD-PARTY-LICENSES.md).
