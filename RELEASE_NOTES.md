# Katacomb VPN 1.16.1

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.16.1 is a security update. It moves the app to Electron 41.10.7 and axios 1.20.0,
past the advisories published against the versions 1.16.0 shipped with. Nothing about
how the app looks or works changes.

## Highlights

- **Electron 41.10.2 → 41.10.7.** Electron is the framework the app runs on. 41.10.2 is
  affected by six advisories, five of them rated high, all fixed in 41.10.6:
  - three where a popup or new window escapes the sandbox of the iframe or page that
    opened it;
  - file and http protocol handlers that allow cross-origin reads;
  - `<webview>` able to turn on Node.js in Web Workers;
  - a race in Squirrel.Mac updates, which affects macOS only.

  The app was not known to be exposed to any of them: it refuses every new window, has
  no iframes or webviews, registers no protocol handlers and only ever loads its own
  page. Updating removes the question. The Chromium inside is unchanged
  (146.0.7680.216).
- **axios 1.16.1 → 1.20.0.** axios is an HTTP library that comes into the app with the
  Sentinel SDK. 1.20.0 fixes 21 advisories that affect 1.16.1, seven of them rated high,
  among them prototype-pollution gadgets that can alter or hijack a request, ways around
  the proxy and `NO_PROXY` settings, and several denial-of-service bugs.
- **The tools that build the app were updated too**, past advisories of their own:
  Electron's downloader, the image library that renders the icons, the CSS tooling and
  the packager's helpers. None of them ship in the app, but this release is built with
  the fixed versions.
- **What is left.** Two groups of advisories remain in the project, and neither is in
  what you download:
  - `elliptic`, which the Sentinel SDK depends on, has no fixed release. Nothing from it
    is in the app;
  - the libraries Tailwind CSS 3 uses while building (`braces`, `micromatch`,
    `fast-glob`, `chokidar` and two of its PostCSS dependencies) clear only with the move
    to Tailwind 4, a larger change than this release.

Nothing else changes. The packages hold the same files as 1.16.0's, with the same
dependencies and install scripts. Only Electron's own files, the app's main bundle and
its list of npm licences are new.

## Fixes in 1.16.1

- Count a new Electron as a packaging change in the release scripts
- Update Electron, axios and the build tools past their advisories
- Name the canaries' test reporter, so CI's Node 22 can read the result

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
Pop!\_OS, Zorin). The packaging is unchanged since 1.11.2. Because 1.16.1 changes the
Electron runtime, its .deb and AppImage were checked again on a clean Ubuntu 24.04
desktop, the .deb in containers on Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04,
and the AppImage in containers on those and Fedora 44.

## Installation

**Recommended: .deb**

```bash
sudo apt install ./katacomb-vpn_1.16.1_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.16.1.AppImage
./katacomb-vpn-1.16.1.AppImage
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
