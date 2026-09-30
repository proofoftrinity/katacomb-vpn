import { is } from '@electron-toolkit/utils'
import { realpathSync } from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/ipc-channels'
import { SYSTEM_SETUP_REQUIRED } from '../../shared/error-markers'
import { binaryExists, protocolRuntimeError } from '../vpn/vpn-manager'
import { isOnPath } from '../fs-utils'
import {
  helperInstallState,
  hostPackageManager,
  installHelper,
  installPackages,
  isSetupPackage,
  resolvconfPackage,
  type HelperState,
  type PackageManager,
  type SetupPackage,
} from '../helper/system-setup'
import type { Handle } from './handle'

type SetupItem = 'helper' | 'wireguard-tools' | 'openvpn' | 'resolvconf'
type Protocol = Parameters<typeof protocolRuntimeError>[0]

const ITEM_LABEL: Record<SetupItem, string> = {
  helper: 'the VPN helper',
  'wireguard-tools': 'WireGuard tools',
  openvpn: 'OpenVPN',
  resolvconf: "resolvconf (for the VPN's DNS)",
}

interface SetupStatus {
  helper: HelperState
  wireguardTools: boolean
  openvpn: boolean
  resolvconf: boolean
  /** null = one-click package installs aren't available here; the user installs by hand. */
  packageManager: PackageManager | null
  /** The one-click package for a missing resolvconf; null = the user installs one by hand. */
  resolvconfPackage: SetupPackage | null
}

// `__dirname` is the BUILD OUTPUT's directory (out/main, one bundle for all of
// main), not this source file's, so the path is the one index.ts always used.
function bundledHelperDir(): string {
  return is.dev
    ? join(__dirname, '../../resources/linux/privileged')
    : join(process.resourcesPath, 'linux/privileged')
}

const wireguardToolsInstalled = (): boolean => binaryExists('wg-quick') && binaryExists('wg')
const openvpnInstalled = (): boolean => protocolRuntimeError('openvpn') === null

// The PATH the helper gives every child it runs as root (daemon/internal/ops), so
// this asks what wg-quick and the AmneziaWG bring-up will: /usr/sbin, where Debian
// and Fedora put the shim, is on it even when the user's own PATH lacks it.
const ROOT_PATH = '/usr/sbin:/usr/bin:/sbin:/bin'
const resolvconfInstalled = (): boolean => isOnPath('resolvconf', ROOT_PATH)

function resolvConfTarget(): string | null {
  try {
    return realpathSync('/etc/resolv.conf')
  } catch {
    return null
  }
}

const hostResolvconfPackage = (): SetupPackage | null => resolvconfPackage(hostPackageManager(), resolvConfTarget())

async function setupStatus(): Promise<SetupStatus> {
  return {
    helper: await helperInstallState(bundledHelperDir()),
    wireguardTools: wireguardToolsInstalled(),
    openvpn: openvpnInstalled(),
    resolvconf: resolvconfInstalled(),
    packageManager: hostPackageManager(),
    resolvconfPackage: hostResolvconfPackage(),
  }
}

/**
 * Refuse a connect this machine can't bring up yet, naming everything it lacks
 * at once so the user sees one setup pane rather than a chain of them.
 *
 * `tunnel` = the connect routes the device through root (full-tunnel mode). Every
 * protocol does then, the child-proxy ones through the helper's `tun-up`; only
 * local-proxy mode needs no root. WireGuard, AmneziaWG and OpenVPN are always
 * root, whatever the caller says. `protocol` null = not known yet (smart connect
 * before it has picked a node), which checks the helper alone.
 *
 * `paying` only picks the wording: a purchase refused here has spent nothing,
 * while a bring-up refused here is for a session already paid for.
 *
 * `vpnDns` false = the user already chose to connect without the tunnel's DNS
 * (the DNS_PROVISION_FAILED retry), which needs no resolvconf.
 */
export async function assertSystemReady(protocol: Protocol | null, tunnel: boolean, paying: boolean, vpnDns = true): Promise<void> {
  const items: SetupItem[] = []
  const rootProtocol = protocol === 'wireguard' || protocol === 'amneziawg' || protocol === 'openvpn'
  if ((tunnel || rootProtocol) && await helperInstallState(bundledHelperDir()) !== 'ready') items.push('helper')
  if (protocol === 'wireguard' && !wireguardToolsInstalled()) items.push('wireguard-tools')
  if (protocol === 'openvpn' && !openvpnInstalled()) items.push('openvpn')
  // WireGuard and AmneziaWG hand the tunnel's DNS to resolvconf, and without one the
  // bring-up fails AFTER the session is paid for. Refused here only when there is a
  // one-click fix: elsewhere the paid-session "Retry without VPN DNS" is the only
  // way such a machine can use those protocols at all, and refusing would take
  // that away.
  if ((protocol === 'wireguard' || protocol === 'amneziawg') && vpnDns && !resolvconfInstalled() && hostResolvconfPackage()) {
    items.push('resolvconf')
  }
  if (items.length === 0) return

  const names = items.map((i) => ITEM_LABEL[i])
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  throw new Error(
    `${SYSTEM_SETUP_REQUIRED}:${items.join(',')}: ` +
    `${paying ? "Can't connect, not charged." : "Can't bring the tunnel up yet."} ` +
    `This connection needs ${list} set up first.`,
  )
}

/**
 * The machine's readiness, and the installs that fix it. Only for AppImage and dev
 * installs in practice: a .deb brings all of it with the package.
 */
export function registerSetupHandlers(handle: Handle, isConnectionLive: () => boolean): void {
  handle(IPC.SETUP_STATUS, async () => setupStatus())

  handle(IPC.SETUP_INSTALL_HELPER, async () => {
    // An install or update ends in `systemctl try-restart` of the daemon, which
    // SIGTERMs its detached children: tun2socks, openvpn, the AmneziaWG device.
    if (isConnectionLive()) {
      throw new Error('Disconnect first. Updating the helper restarts the service that holds the tunnel up.')
    }
    await installHelper(bundledHelperDir())
  })

  handle(IPC.SETUP_INSTALL_PACKAGES, async (_event, pkgs: unknown) => {
    // The package names reach a root command line: only the ones this app needs.
    // A resolvconf package only where it is this machine's answer: installing
    // systemd-resolved where it is NOT already in use switches the whole system's
    // DNS over to it.
    const resolvconfPkg = hostResolvconfPackage()
    const allowed = (p: unknown): boolean =>
      isSetupPackage(p) && (p === 'wireguard-tools' || p === 'openvpn' || p === resolvconfPkg)
    if (!Array.isArray(pkgs) || pkgs.length === 0 || !pkgs.every(allowed)) {
      throw new Error('Invalid package list')
    }
    await installPackages([...new Set(pkgs)])
  })
}
