import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModule, type ModuleHarness } from '../../test/harness/module.ts'

// Start at login is one file, ~/.config/autostart/katacomb-vpn.desktop (here under the test
// world's appData), so every test asserts on what lands there.

const autostart = await loadModule({ entries: ['src/main/autostart.ts'], fake: [] })

type State = { available: boolean; enabled: boolean }
const DEB_BINARY = '/opt/Katacomb VPN/katacomb-vpn'

/** A world for a copy of the app: packaged or not, started from an AppImage or the deb's binary. */
function copy(t: test.TestContext, { packaged = true, appImage }: { packaged?: boolean; appImage?: string } = {}) {
  const h = autostart.fresh()
  h.world.isPackaged = packaged
  const execPath = process.execPath
  process.execPath = DEB_BINARY
  if (appImage === undefined) delete process.env['APPIMAGE']
  else process.env['APPIMAGE'] = appImage
  t.after(() => {
    process.execPath = execPath
    delete process.env['APPIMAGE']
    h.dispose()
  })
  return h
}

const entryFile = (h: ModuleHarness) => join(h.world.userData, '.appData', 'autostart', 'katacomb-vpn.desktop')
const entry = (h: ModuleHarness) => readFileSync(entryFile(h), 'utf-8')
const execOf = (h: ModuleHarness) => entry(h).split('\n').find((l) => l.startsWith('Exec='))
const state = (h: ModuleHarness) => h.mod.autostartState() as State
const set = (h: ModuleHarness, enabled: boolean) => h.mod.setAutostart(enabled as never) as State
const follow = (h: ModuleHarness) => h.mod.followRunningCopy()
function writeEntry(h: ModuleHarness, text: string): void {
  mkdirSync(join(entryFile(h), '..'), { recursive: true })
  writeFileSync(entryFile(h), text)
}

test('[PKG-2] the AppImage\'s entry starts the .AppImage file itself, with --autostart', (t) => {
  const h = copy(t, { appImage: '/home/u/Apps/katacomb-vpn-1.16.2.AppImage' })
  assert.deepEqual(set(h, true), { available: true, enabled: true })
  assert.equal(entry(h), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Katacomb VPN',
    'Comment=Decentralized VPN Client',
    'Exec="/home/u/Apps/katacomb-vpn-1.16.2.AppImage" --autostart',
    'Icon=katacomb-vpn',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=5',
    '',
  ].join('\n'))
})

test('[PKG-2] the deb\'s entry starts the installed binary, the space in its path inside the quotes', (t) => {
  const h = copy(t)
  set(h, true)
  assert.equal(execOf(h), 'Exec="/opt/Katacomb VPN/katacomb-vpn" --autostart')
})

test('[PKG-2] a path with characters the spec reserves is escaped twice, quote then string, and % doubled', (t) => {
  const h = copy(t, { appImage: '/home/u/a $b "c" `d` 100%\\e.AppImage' })
  set(h, true)
  // " ` $ \ take a backslash inside the quotes, then the file's string escape doubles every
  // backslash: a literal backslash is four, a literal $ is \\$ (the spec's own examples).
  assert.equal(execOf(h), 'Exec="/home/u/a \\\\$b \\\\"c\\\\" \\\\`d\\\\` 100%%\\\\\\\\e.AppImage" --autostart')
})

test('[PKG-2] a dev build never writes an entry, and never moves one', (t) => {
  const h = copy(t, { packaged: false })
  assert.deepEqual(state(h), { available: false, enabled: false })
  assert.throws(() => set(h, true), /only available in the installed app/)
  assert.equal(existsSync(entryFile(h)), false)

  const installed = '[Desktop Entry]\nType=Application\nExec="/opt/Katacomb VPN/katacomb-vpn" --autostart\n'
  writeEntry(h, installed)
  follow(h)
  assert.equal(entry(h), installed, 'a dev run must leave the installed app\'s entry alone')
  assert.deepEqual(state(h), { available: false, enabled: true }, 'it still reports the entry as it is')
})

test('[PKG-2] a path the file cannot carry is unavailable, not written broken', (t) => {
  const h = copy(t, { appImage: '/home/u/odd\nname.AppImage' })
  assert.deepEqual(state(h), { available: false, enabled: false })
  assert.throws(() => set(h, true), /only available in the installed app/)
  assert.equal(existsSync(entryFile(h)), false)
})

test('turning it off deletes the entry, and off with no entry is not an error', (t) => {
  const h = copy(t)
  assert.deepEqual(state(h), { available: true, enabled: false })
  set(h, true)
  assert.deepEqual(set(h, false), { available: true, enabled: false })
  assert.equal(existsSync(entryFile(h)), false)
  assert.deepEqual(set(h, false), { available: true, enabled: false })
})

test('an entry the desktop switched off reads as off, and turning it on again rewrites it', (t) => {
  for (const off of ['Hidden=true', 'X-GNOME-Autostart-enabled=false', 'Hidden = true']) {
    const h = copy(t)
    writeEntry(h, `[Desktop Entry]\nType=Application\nExec="/opt/Katacomb VPN/katacomb-vpn" --autostart\n${off}\n`)
    assert.deepEqual(state(h), { available: true, enabled: false }, off)
    set(h, true)
    assert.deepEqual(state(h), { available: true, enabled: true }, off)
    assert.doesNotMatch(entry(h), /Hidden|enabled=false/)
  }
})

test('a key in another group does not switch the entry off', (t) => {
  const h = copy(t)
  writeEntry(h, '[Desktop Entry]\nType=Application\nExec=x\n\n[Desktop Action other]\nHidden=true\n')
  assert.deepEqual(state(h), { available: true, enabled: true })
})

test('[PKG-2] at launch an enabled entry that starts another copy is moved onto this one', (t) => {
  // An AppImage update arrives as a new file name; the entry still names the old one.
  const h = copy(t, { appImage: '/home/u/Apps/katacomb-vpn-1.17.0.AppImage' })
  writeEntry(h, '[Desktop Entry]\nType=Application\nExec="/home/u/Apps/katacomb-vpn-1.16.2.AppImage" --autostart\n')
  follow(h)
  assert.equal(execOf(h), 'Exec="/home/u/Apps/katacomb-vpn-1.17.0.AppImage" --autostart')
  assert.deepEqual(state(h), { available: true, enabled: true })
})

test('[PKG-2] at launch an entry that already starts this copy, or is switched off, is left as it is', (t) => {
  // The user's own edits survive: only Exec is compared.
  const h = copy(t)
  const mine = '[Desktop Entry]\nType=Application\nExec="/opt/Katacomb VPN/katacomb-vpn" --autostart\nX-GNOME-Autostart-Delay=10\n'
  writeEntry(h, mine)
  follow(h)
  assert.equal(entry(h), mine)

  const off = '[Desktop Entry]\nType=Application\nExec="/somewhere/else" --autostart\nHidden=true\n'
  writeEntry(h, off)
  follow(h)
  assert.equal(entry(h), off, 'a switched-off entry is the desktop\'s choice, not a stale one')

  writeEntry(h, '[Desktop Entry]\nType=Application\nExec="/somewhere/else" --autostart\n')
  follow(h)
  assert.equal(execOf(h), 'Exec="/opt/Katacomb VPN/katacomb-vpn" --autostart', 'control: a stale enabled entry is moved')
})

// Windows: the setting is the user's Run entry (Electron's login items), not a file.
const autostartWin = await loadModule({
  entries: ['src/main/autostart.ts'], fake: [], stubs: { 'src/main/platform': 'test/harness/platform-windows.ts' },
})

test('[PKG-2] Windows: the Run entry starts the installed app with --autostart, and the toggle reads it back', (t) => {
  const h = autostartWin.fresh()
  t.after(() => h.dispose())
  h.world.isPackaged = true
  assert.deepEqual(state(h), { available: true, enabled: false })
  assert.deepEqual(set(h, true), { available: true, enabled: true })
  assert.deepEqual(h.world.loginItem, { openAtLogin: true, args: ['--autostart'] })
  assert.deepEqual(set(h, false), { available: true, enabled: false })
  assert.equal(existsSync(entryFile(h)), false, 'no XDG file on Windows')
})

test('[PKG-2] Windows: a dev build offers no entry, and an upgrade has nothing to follow', (t) => {
  const h = autostartWin.fresh()
  t.after(() => h.dispose())
  assert.deepEqual(state(h), { available: false, enabled: false })
  assert.throws(() => set(h, true), /installed app/)
  assert.equal(h.world.loginItem, null)
  h.world.isPackaged = true
  follow(h)
  assert.equal(h.world.loginItem, null, 'the installed path is the same after an upgrade')
})
