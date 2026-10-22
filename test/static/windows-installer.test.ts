import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { read } from '../harness/source.ts'

// [PKG-3] The Windows installer (docs/packaging.md, "Windows installer"): what it ships,
// and that it registers the service and removes it again. What it DOES on a machine is
// checked by installing it in the Windows VM (docs/windows.md); this pins the wiring that
// nothing else reads until then. electron-builder only warns when a resource is missing,
// and NSIS runs a hook that names the wrong path without complaint.

// electron-builder's own YAML parser, the one that reads this file at build time.
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (s: string) => unknown }

interface Resource { from: string; to: string; filter?: string[] }
interface BuilderConfig {
  extraResources: Resource[]
  linux: { extraResources: Resource[] }
  win: { target: Array<{ target: string; arch: string[] }>; extraResources: Resource[] }
  nsis: { perMachine: boolean; include: string }
}
const config = yaml.load(read('electron-builder.yml')) as BuilderConfig
const nsh = read('build/installer.nsh')

/** The body of one `!macro name` … `!macroend` block in installer.nsh. */
function macro(name: string): string {
  const m = new RegExp(`^!macro ${name}\\n([\\s\\S]*?)^!macroend`, 'm').exec(nsh)
  assert.ok(m, `installer.nsh has no !macro ${name}`)
  return m[1]
}

const HELPER = '"$INSTDIR\\resources\\win\\privileged\\katacomb-vpn-helper.exe"'

test('[PKG-3] each package ships its own platform\'s binaries, and only those', () => {
  const shared = config.extraResources.map((r) => r.from)
  assert.ok(!shared.some((f) => f.startsWith('resources/linux') || f.startsWith('resources/win')),
    'a platform\'s binaries in the shared list ship in the other platform\'s package too')
  assert.deepEqual(config.linux.extraResources.map((r) => [r.from, r.to]), [['resources/linux/', 'linux/']])
  assert.deepEqual(config.win.extraResources.map((r) => [r.from, r.to]), [['resources/win/', 'win/']])
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }])
})

test('[PKG-3] the installer registers the service from the helper it ships, elevated', () => {
  assert.equal(config.nsis.perMachine, true, 'the service runs from Program Files, which only an administrator can write')
  assert.equal(config.nsis.include, 'build/installer.nsh')
  assert.match(macro('customInstall'), new RegExp(`nsExec::ExecToLog '${HELPER.replace(/[\\$.]/g, '\\$&')} service install'`))
  // The path is where win.extraResources and build-daemon.sh put the helper.
  assert.match(read('scripts/build-daemon.sh'), /resources\/win\/privileged\/katacomb-vpn-helper\.exe/)
})

test('[PKG-3] the uninstaller removes the service, which runs from a file the uninstall deletes', () => {
  assert.match(macro('customUnInstall'), new RegExp(`nsExec::ExecToLog '${HELPER.replace(/[\\$.]/g, '\\$&')} service uninstall'`))
  // electron-builder's uninstaller runs customUnInstall before it deletes $INSTDIR.
  const template = read('node_modules/app-builder-lib/templates/nsis/uninstaller.nsh')
  const hook = template.indexOf('!insertmacro customUnInstall')
  const removal = template.indexOf('RMDir /r $INSTDIR')
  assert.ok(hook > 0 && removal > hook, 'customUnInstall must run before the files are removed')
})

test('[PKG-3] both verbs are ones the Windows helper accepts on its command line ([PH-11])', () => {
  const command = read('daemon/command.go')
  for (const verb of ['install', 'uninstall']) {
    assert.ok(command.includes(`"${verb}"`), `daemon/command.go no longer accepts \`service ${verb}\``)
  }
})
