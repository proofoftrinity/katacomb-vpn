// What this machine needs before the app can bring a tunnel up, and the one-click
// installs for it: the privileged helper (+ its polkit policy), and the two distro
// packages the root protocols run (wireguard-tools for WireGuard, openvpn for
// OpenVPN). A .deb install never needs any of it: the package depends on both and
// its postinst installs the helper.
//
// Asked for when a connect needs it, never at launch. It used to be two blocking
// native dialogs before the window existed, each wanting an admin password, at a
// point where the user could not have connected anyway (no wallet yet, let alone
// a funded one). Skip left no way back but a restart, the package install was
// apt-only and synchronous, and it was the first thing a catalog screenshot of a
// clean machine showed instead of the app.
//
// Node builtins only, so the native test runner can load it directly. Everything
// that runs as root goes through async pkexec: see "Never make a privileged call
// synchronous" in docs/invariants/reliability.md.

import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { copyFile, mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const HELPER_NAME = 'katacomb-vpn-helper'
const POLICY_NAME = 'com.katacomb.vpn.policy'
const INSTALLED_HELPER = '/usr/local/bin/katacomb-vpn-helper'
const INSTALLED_POLICY = '/usr/share/polkit-1/actions/com.katacomb.vpn.policy'

// A prompt plus a fast command, the same budget runPrivileged gives one.
const HELPER_INSTALL_TIMEOUT_MS = 60_000
// A prompt plus a download: the old apt path allowed 120s, which a slow mirror
// can use up on its own.
const PACKAGE_INSTALL_TIMEOUT_MS = 300_000

export type HelperState = 'ready' | 'missing' | 'outdated'
export type SetupPackage = 'wireguard-tools' | 'openvpn'
export type PackageManager = 'apt' | 'dnf' | 'pacman'

export function isSetupPackage(value: unknown): value is SetupPackage {
  return value === 'wireguard-tools' || value === 'openvpn'
}

// Keyed by the file's identity, so the 11.8 MB helper is hashed once per version
// rather than on every connect. `mv -f` onto the installed path is a new inode and
// the policy's `cp` a new mtime, so an install invalidates its own entries.
const digestCache = new Map<string, { key: string; digest: string }>()

async function fileDigest(path: string): Promise<string | null> {
  let key: string
  try {
    const s = await stat(path)
    key = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`
  } catch {
    return null
  }
  const hit = digestCache.get(path)
  if (hit?.key === key) return hit.digest
  const digest = createHash('sha256').update(await readFile(path)).digest('hex')
  digestCache.set(path, { key, digest })
  return digest
}

/**
 * Is the installed helper + policy the pair this build bundles? A mismatch is not
 * cosmetic: the helper holds the root-side allow-lists, so an older one refuses
 * configs this app builds correctly, and on a paid connect that refusal lands
 * after the session is bought (seen 2026-09-18 with the AmneziaWG 3.1 keys).
 *
 * Byte-exact (via SHA-256), not a version string: the build is reproducible
 * (scripts/build-daemon.sh), so an unchanged tree compares equal and a dev
 * rebuild of the same source does not ask for an update.
 */
export async function helperInstallState(
  bundledDir: string,
  installed = { helper: INSTALLED_HELPER, policy: INSTALLED_POLICY },
): Promise<HelperState> {
  const [bundledHelper, bundledPolicy, installedHelper, installedPolicy] = await Promise.all([
    fileDigest(join(bundledDir, HELPER_NAME)),
    fileDigest(join(bundledDir, POLICY_NAME)),
    fileDigest(installed.helper),
    fileDigest(installed.policy),
  ])
  if (!installedHelper || !installedPolicy) return 'missing'
  // Nothing bundled to compare against (a dev tree that never built the helper):
  // whatever is installed is the best there is.
  if (!bundledHelper || !bundledPolicy) return 'ready'
  return bundledHelper === installedHelper && bundledPolicy === installedPolicy ? 'ready' : 'outdated'
}

/**
 * Install or update the helper and its polkit policy, and restart the daemon's
 * unit when there is one. The caller must refuse while a tunnel is up: the
 * restart SIGTERMs the daemon's detached children (tun2socks, openvpn, the
 * AmneziaWG device).
 */
export async function installHelper(bundledDir: string): Promise<void> {
  const helperSrc = join(bundledDir, HELPER_NAME)
  const policySrc = join(bundledDir, POLICY_NAME)
  if (!existsSync(helperSrc) || !existsSync(policySrc)) {
    throw new Error('This build has no VPN helper to install.')
  }

  // pkexec's `cp` runs as root, and root CANNOT read the AppImage. The runtime
  // mounts the squashfs as FUSE with user_id=<uid> and neither allow_root nor
  // allow_other, and FUSE's default denies every other uid — root is not exempt
  // (it is FUSE's own check, not DAC). Measured 2026-09-02: three authenticated
  // Install clicks, `cp` EACCES on /tmp/.mount_kataco*/resources/linux/privileged/…,
  // nothing installed, and the dialog back on the next launch because the catch
  // swallowed each one. So stage both files into a private tmpfs dir first
  // and hand pkexec THOSE paths: a 0700 mkdtemp is enough, since plain DAC lets
  // root through. Harmless on the deb and in dev, where the sources were already
  // root-readable.
  let staging: string | null = null
  try {
    staging = await mkdtemp(join(tmpdir(), 'katacomb-helper-'))
    const stagedHelper = join(staging, HELPER_NAME)
    const stagedPolicy = join(staging, POLICY_NAME)
    await copyFile(helperSrc, stagedHelper)
    await copyFile(policySrc, stagedPolicy)

    // Paths go in as positional args, never interpolated into the script. The
    // helper goes in through a temp name + mv: a running daemon executes from $3,
    // and `cp` onto a running executable fails with ETXTBSY (the deb's postinstall
    // does the same for the same reason); mv also means a concurrent pkexec never
    // sees a half-written exec.path. A running daemon keeps the OLD binary until
    // its unit restarts, so the unit is restarted when there is one (try-restart:
    // a no-op where no unit exists, AppImage and dev without the deb); the unit
    // preserves /run/katacomb-vpn across restarts, and the caller has already
    // refused if anything of ours is connected.
    const script = [
      `cp -- "$1" "$3.new"`,
      `chmod 755 "$3.new"`,
      `chown root:root "$3.new"`,
      `mv -f "$3.new" "$3"`,
      `cp -- "$2" "$4"`,
      `chmod 644 "$4"`,
      `chown root:root "$4"`,
      `(systemctl try-restart katacomb-vpn-daemon.service 2>/dev/null || true)`,
    ].join(' && ')

    // Bounded: a polkit prompt that never gets answered (no agent running, dialog
    // swallowed by the WM) must not leave the Install button spinning forever.
    await execFileAsync('pkexec', ['sh', '-c', script, '--', stagedHelper, stagedPolicy, INSTALLED_HELPER, INSTALLED_POLICY], {
      timeout: HELPER_INSTALL_TIMEOUT_MS,
    })
  } catch (err) {
    throw new Error(describePkexecFailure(err, 'The VPN helper could not be installed.'))
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Which package manager an os-release file points at, or null for one this app
 * does not drive (the user gets told to install the package themselves). ID is
 * read before ID_LIKE, so derivatives resolve to their base: Mint and Pop to apt,
 * Rocky and Nobara to dnf, Manjaro and EndeavourOS to pacman.
 */
export function detectPackageManager(osRelease: string): PackageManager | null {
  const field = (key: string): string[] => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(osRelease)
    return m ? m[1].replace(/^["']|["']$/g, '').toLowerCase().split(/\s+/).filter(Boolean) : []
  }
  for (const id of [...field('ID'), ...field('ID_LIKE')]) {
    if (id === 'debian' || id === 'ubuntu') return 'apt'
    if (id === 'fedora' || id === 'rhel' || id === 'centos') return 'dnf'
    if (id === 'arch') return 'pacman'
  }
  return null
}

const PACKAGE_MANAGER_BIN: Record<PackageManager, string> = {
  apt: '/usr/bin/apt-get',
  dnf: '/usr/bin/dnf',
  pacman: '/usr/bin/pacman',
}

/** The package manager one-click installs go through here, or null (install by hand). */
export function hostPackageManager(): PackageManager | null {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    let osRelease: string
    try {
      osRelease = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    const pm = detectPackageManager(osRelease)
    return pm && existsSync(PACKAGE_MANAGER_BIN[pm]) ? pm : null
  }
  return null
}

/**
 * The argv pkexec runs. Non-interactive on all three: there is no terminal to
 * answer a prompt, so one would hang until the timeout. apt gets
 * DEBIAN_FRONTEND through env(1) because pkexec starts the program with a
 * scrubbed environment.
 */
export function packageInstallArgv(pm: PackageManager, pkgs: readonly SetupPackage[]): string[] {
  switch (pm) {
    case 'apt':
      return ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', PACKAGE_MANAGER_BIN.apt, 'install', '-y', ...pkgs]
    case 'dnf':
      return [PACKAGE_MANAGER_BIN.dnf, 'install', '-y', ...pkgs]
    case 'pacman':
      return [PACKAGE_MANAGER_BIN.pacman, '-S', '--noconfirm', '--needed', ...pkgs]
  }
}

function manualInstallCommand(pm: PackageManager, pkgs: readonly SetupPackage[]): string {
  const list = pkgs.join(' ')
  switch (pm) {
    case 'apt': return `sudo apt install ${list}`
    case 'dnf': return `sudo dnf install ${list}`
    case 'pacman': return `sudo pacman -S ${list}`
  }
}

export async function installPackages(pkgs: readonly SetupPackage[]): Promise<void> {
  const pm = hostPackageManager()
  if (!pm) {
    throw new Error(`This system's package manager isn't one the app can drive. Install ${pkgs.join(' and ')} with it, then try again.`)
  }
  try {
    await execFileAsync('pkexec', packageInstallArgv(pm, pkgs), { timeout: PACKAGE_INSTALL_TIMEOUT_MS })
  } catch (err) {
    const reason = describePkexecFailure(err, `${pkgs.join(' and ')} could not be installed.`)
    // No authorization (prompt closed, denied, wrong password) is not an install
    // failure to route around through a terminal, which asks for the same password.
    const code = (err as { code?: unknown }).code
    if (code === 126 || code === 127) throw new Error(reason)
    throw new Error(`${reason} You can install it from a terminal instead: ${manualInstallCommand(pm, pkgs)}`)
  }
}

/**
 * pkexec's own exit codes (pkexec(1)): 126 when the user dismissed the password
 * dialog, 127 when authorization failed. Which one a CANCEL produces depends on the
 * desktop's agent: GNOME Shell reports it as dismissed (126), xfce-polkit as not
 * authorized (127), so 127 must not claim the password was wrong (seen on Fedora
 * 44 Xfce, 2026-09-29). Anything else is the program's own failure, and its last
 * stderr line is usually the reason (apt's "Could not get lock", dnf's "No match
 * for argument").
 */
function describePkexecFailure(err: unknown, fallback: string): string {
  const e = err as { code?: unknown; killed?: boolean; stderr?: unknown }
  if (e.code === 126) return 'The password prompt was closed, so nothing was installed.'
  if (e.code === 127) return "Admin authorization wasn't given, so nothing was installed."
  if (e.killed) return 'The install took too long and was stopped.'
  const lastLine = typeof e.stderr === 'string'
    ? e.stderr.trim().split('\n').filter(Boolean).pop()?.slice(0, 200)
    : undefined
  return lastLine ? `${fallback} (${lastLine})` : fallback
}
