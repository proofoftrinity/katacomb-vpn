import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import { IPC } from '../../shared/ipc-channels'
import { SYSTEM_SETUP_REQUIRED } from '../../shared/error-markers'
import { binaryExists, protocolRuntimeError } from '../vpn/vpn-manager'
import {
  helperInstallState,
  hostPackageManager,
  installHelper,
  installPackages,
  isSetupPackage,
  type HelperState,
  type PackageManager,
  type SetupPackage,
} from '../helper/system-setup'
import type { Handle } from './handle'

type SetupItem = 'helper' | SetupPackage
type Protocol = Parameters<typeof protocolRuntimeError>[0]

const ITEM_LABEL: Record<SetupItem, string> = {
  helper: 'the VPN helper',
  'wireguard-tools': 'WireGuard tools',
  openvpn: 'OpenVPN',
}

interface SetupStatus {
  helper: HelperState
  wireguardTools: boolean
  openvpn: boolean
  /** null = one-click package installs aren't available here; the user installs by hand. */
  packageManager: PackageManager | null
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

async function setupStatus(): Promise<SetupStatus> {
  return {
    helper: await helperInstallState(bundledHelperDir()),
    wireguardTools: wireguardToolsInstalled(),
    openvpn: openvpnInstalled(),
    packageManager: hostPackageManager(),
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
 */
export async function assertSystemReady(protocol: Protocol | null, tunnel: boolean, paying: boolean): Promise<void> {
  const items: SetupItem[] = []
  const rootProtocol = protocol === 'wireguard' || protocol === 'amneziawg' || protocol === 'openvpn'
  if ((tunnel || rootProtocol) && await helperInstallState(bundledHelperDir()) !== 'ready') items.push('helper')
  if (protocol === 'wireguard' && !wireguardToolsInstalled()) items.push('wireguard-tools')
  if (protocol === 'openvpn' && !openvpnInstalled()) items.push('openvpn')
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
    // The package names reach a root command line: only the two this app needs.
    if (!Array.isArray(pkgs) || pkgs.length === 0 || !pkgs.every(isSetupPackage)) {
      throw new Error('Invalid package list')
    }
    await installPackages([...new Set(pkgs)])
  })
}
