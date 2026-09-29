import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPackageManager, helperInstallState, packageInstallArgv } from './system-setup.ts'

// --- detectPackageManager: real os-release files, trimmed to the lines that matter.

const OS_RELEASE: Record<string, string> = {
  debian: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n',
  ubuntu: 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
  mint: 'NAME="Linux Mint"\nVERSION_ID="22"\nID=linuxmint\nID_LIKE="ubuntu debian"\n',
  pop: 'NAME="Pop!_OS"\nID=pop\nID_LIKE="ubuntu debian"\n',
  fedora: 'NAME="Fedora Linux"\nVERSION_ID=40\nID=fedora\n',
  rocky: 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n',
  arch: 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n',
  manjaro: 'NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\n',
  endeavouros: 'NAME="EndeavourOS"\nID="endeavouros"\nID_LIKE="arch"\n',
  tumbleweed: 'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
}

test('Debian and its derivatives resolve to apt', () => {
  for (const d of ['debian', 'ubuntu', 'mint', 'pop']) assert.equal(detectPackageManager(OS_RELEASE[d]), 'apt', d)
})

test('Fedora and the RHEL family resolve to dnf', () => {
  for (const d of ['fedora', 'rocky']) assert.equal(detectPackageManager(OS_RELEASE[d]), 'dnf', d)
})

test('Arch and its derivatives resolve to pacman', () => {
  for (const d of ['arch', 'manjaro', 'endeavouros']) assert.equal(detectPackageManager(OS_RELEASE[d]), 'pacman', d)
})

test('a distro the app does not drive gets null, so the user installs by hand', () => {
  assert.equal(detectPackageManager(OS_RELEASE.tumbleweed), null)
  assert.equal(detectPackageManager(''), null)
})

test('VERSION_ID and BUILD_ID are not mistaken for ID', () => {
  assert.equal(detectPackageManager('VERSION_ID=debian\nBUILD_ID=arch\n'), null)
})

// --- packageInstallArgv: pkexec has no terminal, so every one must be non-interactive.

test('apt runs non-interactively through env, since pkexec scrubs the environment', () => {
  assert.deepEqual(
    packageInstallArgv('apt', ['wireguard-tools']),
    ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', '/usr/bin/apt-get', 'install', '-y', 'wireguard-tools'],
  )
})

test('dnf and pacman are told not to ask', () => {
  assert.deepEqual(packageInstallArgv('dnf', ['openvpn']), ['/usr/bin/dnf', 'install', '-y', 'openvpn'])
  assert.deepEqual(
    packageInstallArgv('pacman', ['wireguard-tools', 'openvpn']),
    ['/usr/bin/pacman', '-S', '--noconfirm', '--needed', 'wireguard-tools', 'openvpn'],
  )
})

// --- helperInstallState: bundled pair vs installed pair, byte-exact.

function fixture(): { bundled: string; installed: { helper: string; policy: string } } {
  const root = mkdtempSync(join(tmpdir(), 'setup-'))
  const bundled = join(root, 'bundled')
  mkdirSync(bundled)
  writeFileSync(join(bundled, 'katacomb-vpn-helper'), 'helper v2')
  writeFileSync(join(bundled, 'com.katacomb.vpn.policy'), 'policy v2')
  return { bundled, installed: { helper: join(root, 'helper'), policy: join(root, 'policy') } }
}

test('nothing installed is missing', async () => {
  const f = fixture()
  assert.equal(await helperInstallState(f.bundled, f.installed), 'missing')
})

test('a helper without its policy is missing, not ready', async () => {
  const f = fixture()
  writeFileSync(f.installed.helper, 'helper v2')
  assert.equal(await helperInstallState(f.bundled, f.installed), 'missing')
})

test('the bundled pair installed is ready', async () => {
  const f = fixture()
  writeFileSync(f.installed.helper, 'helper v2')
  writeFileSync(f.installed.policy, 'policy v2')
  assert.equal(await helperInstallState(f.bundled, f.installed), 'ready')
})

test('a different helper or policy is outdated', async () => {
  const f = fixture()
  writeFileSync(f.installed.helper, 'helper v1')
  writeFileSync(f.installed.policy, 'policy v2')
  assert.equal(await helperInstallState(f.bundled, f.installed), 'outdated')

  const g = fixture()
  writeFileSync(g.installed.helper, 'helper v2')
  writeFileSync(g.installed.policy, 'policy v1')
  assert.equal(await helperInstallState(g.bundled, g.installed), 'outdated')
})

test('an install is seen at once, despite the digest cache', async () => {
  const f = fixture()
  writeFileSync(f.installed.helper, 'helper v1')
  writeFileSync(f.installed.policy, 'policy v2')
  assert.equal(await helperInstallState(f.bundled, f.installed), 'outdated')
  // What installHelper does: a temp name, then mv -f over the installed path.
  writeFileSync(`${f.installed.helper}.new`, 'helper v2')
  renameSync(`${f.installed.helper}.new`, f.installed.helper)
  assert.equal(await helperInstallState(f.bundled, f.installed), 'ready')
})

test('with nothing bundled to compare against, an installed helper is ready', async () => {
  const f = fixture()
  writeFileSync(f.installed.helper, 'anything')
  writeFileSync(f.installed.policy, 'anything')
  assert.equal(await helperInstallState(join(f.bundled, 'absent'), f.installed), 'ready')
})
