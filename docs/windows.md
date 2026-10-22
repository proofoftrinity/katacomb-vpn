# Windows (beta)

Katacomb VPN 1.18.0 adds a Windows build: an unsigned per-machine installer for
Windows 10 and 11 on x64, tested on Windows 11. It carries every protocol except
OpenVPN (WireGuard, AmneziaWG, V2Ray, Xray, Hysteria2), multi-hop, the kill switch
and DNS protection. OpenVPN nodes are refused before payment: the Windows helper does
not list the OpenVPN ops, so `daemonMissingOp` refuses them ([PH-2]).

The rules are the Linux ones. This file says how each Linux mechanism maps onto
Windows, and why where the mapping is not obvious.

## How each Linux mechanism maps to Windows

| Concern | Linux | Windows |
|---|---|---|
| Privileged side | systemd daemon on a Unix socket; pkexec fallback | The same Go helper, run as a LocalSystem service; no elevation fallback |
| WireGuard, AmneziaWG | wg-quick and the kernel; AmneziaWG self-exec'd as `_amneziawg` | The AmneziaWG device in the service process on a Wintun adapter `sntl0`. Plain WireGuard is the same device with no obfuscation keys |
| V2Ray, Xray, Hysteria2 | user-run cores, plus `_tun2socks` self-exec'd on `sntl-tun` | The same, on a Wintun adapter `sntl-tun`; the engine runs in a job object, so it never outlives the service |
| Addresses, routes, MTU | `ip` | The IP Helper API (`winipcfg`). The VPN server's /32 goes via the real gateway, the tunnel takes `0.0.0.0/1` and `128.0.0.0/1` (and the IPv6 halves when the config routes `::/0`), interface metric 0 |
| Kill switch | iptables chain `KATACOMB_KILLSWITCH(6)` | WFP filters under our own provider and sublayer ([REL-43]) |
| DNS | wg-quick/resolvconf; `resolv.conf` swap | The resolver set on the tunnel adapter, plus WFP filters that keep port 53 inside the tunnel ([REL-44]) |

## The filtering platform

Both the kill switch and DNS protection are WFP filters. `daemon/internal/ops/wfp_plan.go`
plans them as data and its tests pin the rules on every platform; `daemon/internal/wfp`
installs them. Its syscall layer is adapted from wireguard-windows' `tunnel/firewall`
(MIT), credited in each file.

- The kill switch's session is NOT dynamic. Its filters outlive the process that added
  them, so a crashed service fails closed, and they live only in the filtering engine's
  memory, so a reboot clears them: what iptables does on Linux. The provider and sublayer
  have fixed keys, so a restarted service, `service teardown` and the uninstaller find
  and remove them without state.
- DNS protection's session IS dynamic: its filters die with the service, as the tunnel
  they protect does.

## The service

`katacomb-vpn-helper.exe` is the Linux helper's Windows build, run by the service control
manager as `daemon <user SID>` ([docs/privileged-helper.md](privileged-helper.md), [PH-10],
[PH-11]). It keeps its state in `%ProgramData%\Katacomb VPN` (SYSTEM and Administrators
only; a folder found there with another owner was planted, and is replaced): `routes.state`,
`killswitch.state`, `service.log` and the lock file.

- **Every tunnel lives in or under the service.** The WireGuard/AmneziaWG device runs in
  the service process. The tun2socks engine runs as a child (`_tun2socks`, as on Linux) in a
  job object that kills it when the service's handle closes, a crash included: it is a
  child because the engine exits its process on any start failure. A stopped or crashed
  service therefore takes every tunnel with it, as systemd kills a stopped Linux daemon's
  children, and the kill switch stays ([REL-43]).
- **What outlives the process is recorded first.** The VPN server's /32 and the
  split-tunnel routes sit on the real adapter, so they survive a crash. Each is written to
  `routes.state` before it is added, and the service removes every recorded route when it
  starts (`Heal`): no tunnel can be up then.
- **The kill switch follows the tunnel's adapter.** WFP permits an interface by LUID, and a
  new adapter can get a new one, so an armed kill switch is re-planned each time the helper
  brings that tunnel up. `killswitch.state` keeps it across a service restart.
- **The default route is read by the service.** `tun_up` validates the gateway and
  interface the app sends and ignores them, reading the route itself at the moment it adds
  the /32. WireGuard has no such arguments and does the same. `default_route` gives the app
  the same answer, so it can notice the network change under a tunnel.
- **Logoff is a backstop teardown.** The service records the session of the client that
  brought a tunnel up; when that session logs off it tears everything down, kill switch
  included, as quitting the app does. The app normally does this itself; the backstop is
  for an app Windows killed first.
- **Uninstall leaves nothing.** `service uninstall` stops the service (its own teardown),
  removes the kill switch and every recorded route, deletes the service, then the state
  directory.

## The app

The main process branches on `IS_WINDOWS` (`src/main/platform.ts`); a test reaches the
Windows branches by bundling the module under test with `test/harness/platform-windows.ts`
in its place. The renderer is sandboxed and reads the OS off Chromium's user agent
(`utils/protocols.ts`), which it needs only for OpenVPN's copy and the welcome screen.

| Concern | Linux | Windows |
|---|---|---|
| The door to root | the daemon socket, else pkexec | the service's pipe, and nothing else ([PH-12]) |
| Is our interface up | `ip link show` | Node's `networkInterfaces()`, which lists an adapter by name once it is up and has an address; the service gives it one before its bring-up returns. No exec and no privilege, and synchronous like its callers |
| Byte counters | `/proc/net/dev` | the service's `traffic_counters`; `readTunnelBytes` (vpn-manager) is async for that round trip |
| Default route | `ip route show default` | the service's `default_route`. `tun_up` ignores the gateway the app sends; the app keeps it to notice a network change ([REL-45]) |
| Other VPNs | `ip link show type wireguard`/`tun`, and the IPsec probe | the service's `other_vpns` |
| Host lookups | `getent`, synchronous | Node's resolver, async, run ahead of the synchronous pinners (`resolveAhead`): a dry run of the pinner names the hosts, and the cache answers the real run, the last good answer included when the kill switch blocks DNS |
| Bundled cores | `resources/linux/bin/<name>` | `resources/win/bin/<name>.exe`, pinned per file name ([PKG-1]) |
| Setup gate | the helper, the packages, resolvconf | one row, the service answering; its fix is the installer |
| Seeds | libsecret or KWallet, pinned per seed ([REL-41]) | DPAPI, under the user's account |
| Tray | a StatusNotifier probe; the panel's shade | always drawn; the taskbar's shade ([REL-42]) |
| Start at login | an XDG Autostart entry | the Run key ([PKG-2]) |
| Logout, shutdown | D-Bus or XSMP ([REL-36]) | `query-session-end` on the window; the service's logoff teardown as the backstop |
| Menu bar | as Electron draws it | none: Electron's default one offers nothing the app uses |
| OpenVPN | yes | refused before payment by `protocolRuntimeError`, and by the service's op list ([PH-2]) |

- **The dead-tunnel detectors work as on Linux.** `checkTunnelStalled` reads the service's
  counters, and the dead-peer detector reads the handshake age for WireGuard and AmneziaWG
  alike, since both run on the service's device ([REL-45]).
- **Proxy cores die with the app.** Node on Windows puts every child it spawns into a job
  object that kills them when the app's process ends, a crash included, so
  `proxy-children.ts` has nothing to reap there, and records nothing (it identifies a core
  by `/proc`). On Linux a core outlives a crashed app, which is why that module exists.

## The release check

`scripts/verify-windows-vm.sh fullcycle [setup.exe]` is the Windows counterpart of
`verify-deb-portability.sh fullcycle`, for every release whose Windows side changed. It
reverts the test VM to its `clean` snapshot and installs the installer silently; checks
the service (running, automatic, LocalSystem, restarted after a crash, the shipped helper
for the installing user), the files, the state directory's ACL, Defender, and that another
standard user is refused by the pipe ([PH-10]); starts the app in the desktop session and
drives it over DevTools: the setup gate, start at login ([PKG-2]), a throwaway unfunded
wallet the app generates itself, every tab, Settings' System row, with screenshots; then
runs `integration`; installs again over the running app; uninstalls and checks that
nothing is left ([PKG-3]); and installs once more and saves the VM as `katacomb-ready`,
with no wallet in it, for the paid checks.

`integration` alone drives real tunnels through the installed service's pipe, against
servers the script runs in docker on the host: stock WireGuard, the AmneziaWG reference
peer at the commits dvpnd pins, and an xray SOCKS server for tun2socks. Then the kill
switch with the service killed under it ([REL-43]), DNS outside the tunnel ([REL-44]),
and nothing left behind. It spends nothing: no funded wallet, no chain transaction.

## Wintun adapters (incident log)

Found while testing the service in the VM, 2026-10-22:

- **A process that dies without closing its adapter leaves it behind, down**, until the next
  Wintun adapter is created. `status` read it as a live tunnel. Only adapters that are up
  count now (`adapter()`), for `status`, `traffic_counters` and the kill switch's LUID.
- **tun2socks was stopped with a kill**, so every disconnect left `sntl-tun` behind. It is
  now stopped by closing its stdin, which lets it close the adapter; the kill is the fallback
  after 5 s.
- **Fixed adapter GUIDs raced with Windows removing the previous adapter**: the next connect
  failed with "TUN interface did not appear" or "The system cannot find the file
  specified". Adapters now get a fresh GUID each time, and a disconnect returns only once
  Windows has removed the adapter (`waitAdapterGone`).

## Verified in the VM (2026-10-22, free, against local servers)

A stock kernel WireGuard server in docker on the host, and an xray SOCKS server on the host:

- WireGuard up through the pipe: the address, the two /1 routes, the server's /32 via the real
  gateway, DNS on the tunnel, traffic to the server's own address and to the internet; the
  handshake age and byte counters read back; a DNS query to the LAN resolver times out while
  one through the tunnel answers.
- tun2socks up through the pipe: the same, plus split-tunnel routes, with invalid entries
  dropped and counted in the log.
- The kill switch blocks the LAN and DNS outside the tunnel while the tunnel works. Killing
  the service process takes the tunnel and the DNS filters with it and leaves the kill
  switch blocking everything; the service restarts within seconds, and `killswitch_off`
  restores the network.
- Up and down twice for each tunnel, and up again after killing the service mid-tunnel:
  nothing left behind each time (adapters, routes, `routes.state`); a teardown takes about 1 s.
- A second standard user is refused by the pipe; logging off the session that connected
  tears down the tunnel and the kill switch; `service uninstall` with a tunnel and the kill
  switch up leaves no service, filter, adapter, route or state directory.

And for the app (2026-10-22), with Electron 41.10.7 run as Node in the VM:

- `networkInterfaces()` lists `sntl0` (10.99.0.2) while the service's WireGuard tunnel is up,
  `sntl-tun` (198.18.0.1) while its tun2socks tunnel is up, and neither once each is down;
  a lookup through the tunnel answers.
- A child spawned as vpn-manager spawns a core (piped stdio, not detached) is gone 2 s after
  its parent is killed with `Stop-Process -Force`.

And for the installer (2026-10-22), `npm run dist:win` built on this host and installed in the VM:

- A silent install (`/S`) exits 0 and leaves the service running, set to start
  automatically, registered for the installing user's SID and running the helper from
  `C:\Program Files\Katacomb VPN\resources\win\privileged\`; `resources\win` holds the
  cores, the helper, `wintun.dll` and their licences, and no `resources\linux` ships. The
  pipe answers `protocol_version` with the Windows op list.
- The installed app starts in the desktop session with no menu bar, says "Five
  protocols", loads the node list, and reports the setup gate's one row ready
  (`platform: windows`, `helper: ready`). Start at login writes and removes its Run entry
  (`"C:\Program Files\Katacomb VPN\Katacomb VPN.exe" --autostart`).
- A silent uninstall with the app running closes it, removes the service, the install
  directory and `%ProgramData%\Katacomb VPN`, and keeps the user's data
  (`%APPDATA%\katacomb-vpn`).

And the release check itself (2026-10-22): `verify-windows-vm.sh fullcycle` passed 124 of 124
on this branch's installer, the kill switch section included (the service killed under it,
the restart still blocking, `killswitch_off` restoring the network, no filter, adapter or
route left), and saved `katacomb-ready`. Its first run found two defects, both fixed: the
System tab and three other places still showed Linux-only copy on Windows ("The .deb
package installs …", "allow the password prompt", "No admin password"), and the kill
switch cut the check's own ssh session, which is why that section runs as a task in the VM.

## Verified on mainnet (2026-10-22, paid)

The installed beta in the VM, from `katacomb-ready`, with a funded test wallet imported, on
one operator's NRS-TEST nodes (the cheapest healthy set, one per protocol). Five purchases
of 1 GB, about 0.72 P2P with fees:

- WireGuard, AmneziaWG, V2Ray, Xray and Hysteria2: each bought and connected through the
  app. The exit IP was the node's, traffic went through `sntl0` or `sntl-tun`, HTTPS
  answered, the byte counters moved, and the handshake age was read for WireGuard and
  AmneziaWG. For WireGuard and AmneziaWG a query to the LAN resolver was blocked. Each
  disconnect left nothing behind, and each reconnected on the same session.
- With the "system" resolver and the kill switch off, V2Ray, Xray and Hysteria2 leave the
  LAN resolver reachable, as Linux does; [REL-44] was narrowed to say so.
- The app killed with the kill switch armed (47 filters, LAN DNS blocked): the core went
  with it and nothing got out. The relaunch healed within 16 s: the network back, no
  adapter, no filter ([REL-31]).
- Logoff while connected with the kill switch armed: afterwards the original IP, no
  adapter, no filter and no kill-switch state, and the service logged a full teardown for
  the session.
- Reboot with the kill switch armed: the network was back before the app started (no
  filter, no adapter, no kill-switch state), and the app started idle with no stuck-kill-switch
  banner.

Multi-hop was not bought on Windows, by the user's decision. The exit hop must be paid
from a second wallet and the test had one, and the NRS-TEST nodes all sit in one country,
which [MH-1] refuses. A chain runs the same `xray.exe` and `sntl-tun` path the paid Xray
check passed, and its config comes from the same builder as on Linux.
