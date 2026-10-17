# Katacomb VPN 1.17.0

A desktop client for the Sentinel decentralized VPN network. Pick a node, pay for a
session on-chain, and tunnel through WireGuard, AmneziaWG, OpenVPN, V2Ray, XRAY or
Hysteria2.

1.17.0 adds Start at Login: the app can wait in the tray from the moment you log in,
without connecting and without asking for your keyring until you open it. It also stops
the app crashing when you log out, restart or shut down, and a WireGuard disconnect now
removes the firewall rules that wg-quick used to leave behind until the next reboot.

## Highlights

- **Start at Login.** Settings > General has a new Start at Login switch, off by
  default. With it on, the app starts in the tray when you log in and opens no window
  until you ask for one: click the tray icon, choose Show Window or About, or launch the
  app again. Until then it does not touch your keyring, so an auto-login desktop shows no
  unlock prompt at boot, and the app holds about 230 MB instead of 383 MB. It never
  connects on its own, and until the window has been opened once the tray does not offer
  Reconnect last session. If the desktop has no tray, the window opens within about ten
  seconds instead. Tested on GNOME, KDE Plasma, Xfce and Cinnamon.

  The switch writes `~/.config/autostart/katacomb-vpn.desktop`, so your desktop's own
  startup settings can turn it off too, and the switch then reads off. It works in the
  installed app only (.deb or AppImage). An AppImage entry follows the file: after an
  update, launch the new AppImage once and login starts use it from then on.
- **Logging out, restarting or shutting down no longer crashes the app.** On GNOME,
  every logout, and every restart or power-off from the system menu, crashed the app
  ("GPU process isn't usable") before its quit could run, so a connected tunnel outlived
  the app with nothing watching its quota. The app now registers with the desktop's
  session manager (GNOME and Xfce over D-Bus, KDE Plasma over XSMP) and, when the session
  ends, quits the normal way, closing the connection first. A reboot or shutdown started
  outside the desktop, such as `sudo reboot`, now waits for the app to close the
  connection too, and ending every app process at once no longer crashes it.
- **A WireGuard disconnect removes wg-quick's firewall rules.** Bringing WireGuard up
  through wg-quick adds firewall rules for the tunnel's address (nft tables named
  `wg-quick-sntl0`, or iptables rules where nft is absent). The VPN helper never removed
  them, so they stayed after every disconnect, logout and quit until the next reboot, and
  each connection added another copy. The helper now removes them once the tunnel is
  down, and leaves the kill switch and any other VPN's rules alone.

  This changes the VPN helper. The .deb updates it during the upgrade. With the
  AppImage, Settings > System shows the helper as "Needs update", and your next
  connection asks to update it, with one password prompt, before anything is paid.
- **Wallets stay with the keyring that saved them.** Each desktop has its own keyring:
  KDE Wallet on Plasma, GNOME Keyring elsewhere. A wallet saved while logged in to GNOME
  read as locked from a Plasma session on the same account, and the other way round. The
  app now records which keyring saved your seeds and asks that one on every desktop.
  Wallets saved before 1.17.0 have no record yet: if one reads as locked, open the app
  once on the desktop where you saved it, and from then on it opens everywhere. On a
  window manager such as i3 or sway, where saving a wallet was refused because no keyring
  was used, the app now uses GNOME Keyring when it is running.
- **When no keyring answers, the app says to restart, not to re-import.** If a keyring
  prompt is cancelled, or KDE Wallet's is answered after its 25-second timeout, no seed
  can be opened until the app restarts. The wallet screens used to suggest importing the
  wallet again, and the delete window called its seed unusable, so deleting it threw
  away a seed that would have opened after a restart. They now say to unlock the keyring,
  restart the app and keep the wallet.
- **The tray icon:**
  - **its K is drawn for the panel it sits on.** It followed the apps' light or dark
    theme, so a dark K sat on GNOME's dark top bar and on Xfce's dark panel. The app now
    reads the panel's own shade on GNOME, Ubuntu, Cinnamon (Mint's "Mixed" themes pair a
    dark panel with light apps) and Xfce, and redraws within a few seconds when you
    change it. Other desktops keep following the apps' theme;
  - **Reconnect last session appears only when there is a session to reconnect.** It
    used to be offered always: with no open session, pressing it only opened the Nodes
    tab, and a used-up session or one on a broken chain was refused after the window
    came up for it;
  - **on Cinnamon it can no longer stay amber after you connect.** The panel gives up on
    an image it cannot fetch within 5 seconds, so if the app was busy right after
    connecting, the connecting icon could stay up. Every change of the icon is now sent
    again 2 seconds later.
- **Nodes the directory never read are marked "No details".** The node directory lists
  some active nodes it has no details for: no protocol, location or version. They showed
  as blank rows with a green Active label, and opening one said protocol "Unknown" isn't
  supported. On 2026-10-16 that was 139 of the 2,127 nodes the default filters showed.
  They now carry a grey "No details" status, cannot be picked, and the Healthy filter,
  which is on by default, hides them. In a plan's node picker, such a node shows its
  address instead of an empty name.
- **Smaller fixes:**
  - Test nodes no longer stalls on one bad address. If the directory gave one node an
    address the app refuses to probe, the whole batch failed and every row stayed on
    "..."; that node now gets its own "Invalid node probe URL" result and the rest are
    tested;
  - the round flags on the route the connect windows and the Sessions tab draw, and in
    the Multi-hop tab, fill their circle, where they showed a band above and below.
- **The styling moved to Tailwind CSS 4, with no visible change.** About 40 screens were
  compared element by element against a Tailwind 3 build. This clears the build-time
  advisories 1.16.1's notes listed as left (`braces`, `micromatch`, `fast-glob`,
  `chokidar` and two PostCSS dependencies). What remains is `elliptic`, which the
  Sentinel SDK depends on: it has no fixed release, and nothing from it is in the app.

Nothing else changes. The packages hold the same files as 1.16.1's, with the same
dependencies and install scripts. The app's code, the VPN helper and the Tailwind line in
its list of npm licences are new.

## Fixes in 1.17.0

- Add the settings generation that records the seeds' keyring
- Keep seeds in the keyring that saved them; draw the tray for its panel
- A login start creates no window until one is asked for
- Start at login: a Settings toggle, and a login start that waits in the tray
- Trim CLAUDE.md's command list and stack line
- Show the address in the plan picker when a node has no moniker
- Probe an unsafe node URL as one failed row instead of failing the batch
- Label nodes the directory never read "No details" and hide them by default
- Fill the round flags' circles with the 4:3 artwork
- Move the renderer to Tailwind 4 with no visible change
- Send every tray repaint twice so a dropped one cannot leave the icon amber
- Correct REL-27's traffic-probe duration to 18s
- Offer the tray's Reconnect only for a session main would reconnect
- Remove wg-quick's firewall when the helper tears WireGuard down
- Share the agents' memory through a gitignored folder
- Give Codex the same rules as Claude Code
- Quit with the session on Xfce and KDE, at a reboot, and at a kill-all
- Quit with the desktop session instead of crashing at logout

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
Pop!\_OS, Zorin). The packaging is unchanged since 1.11.2. Because 1.17.0 changes the
VPN helper, its .deb and AppImage were checked again on a clean Ubuntu 24.04 desktop,
the .deb in containers on Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04, and the
AppImage in containers on those and Fedora 44.

## Installation

**Recommended: .deb**

```bash
sudo apt install ./katacomb-vpn_1.17.0_amd64.deb
```

Installs a root daemon, so connect and disconnect never prompt for a password. It needs
one log out and log back in after the first install before that takes effect.

**Alternative: AppImage**

```bash
chmod +x katacomb-vpn-1.17.0.AppImage
./katacomb-vpn-1.17.0.AppImage
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
