import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CINNAMON_PANEL, cssPanelShade, markedTrayBitmap, panelShade, panelWatchCommand, TRAY_HOST_ATTEMPTS, TRAY_HOST_INTERVAL_MS, TRAY_REPAINT_AGAIN_MS,
  trayPainter, trayView, waitForTrayHost, XFCE_PANEL, type PanelReader,
} from './tray-view.ts'
import type { ConnectionInfo } from './ipc-handlers.ts'

// What the tray draws for each connection state: icon, the disabled status rows at the
// top of its menu, the one action it offers and the Quit label. index.ts only hands
// this to Electron, so this table is the tray's whole behaviour.

const idle: ConnectionInfo = { state: 'idle', blocked: false, proxyMode: false, killSwitchFailed: false }
const up: ConnectionInfo = { ...idle, state: 'connected', nodeMoniker: 'node-wg' }

test('[REL-38] idle: the outline K, and the one action reconnects the session main chose', () => {
  assert.deepEqual(trayView({ ...idle, reconnectSessionId: '2001' }), {
    icon: 'disconnected',
    tooltip: 'Katacomb VPN: Disconnected',
    statusLines: ['Disconnected'],
    action: { label: 'Reconnect last session', run: 'reconnect', sessionId: '2001' },
    quitLabel: 'Quit',
  })
})

test('[REL-38] idle with no session main would reconnect: no action at all', () => {
  assert.deepEqual(trayView(idle), {
    icon: 'disconnected',
    tooltip: 'Katacomb VPN: Disconnected',
    statusLines: ['Disconnected'],
    action: null,
    quitLabel: 'Quit',
  })
})

test('[REL-35] traffic blocked by the kill switch is its own state, and offers Restore internet', () => {
  assert.deepEqual(trayView({ ...idle, blocked: true }), {
    icon: 'blocked',
    tooltip: 'Katacomb VPN: Internet blocked by the kill switch',
    statusLines: ['Internet blocked by the kill switch'],
    action: { label: 'Restore internet', run: 'disconnect' },
    quitLabel: 'Quit',
  })
})

test('[REL-35] connecting offers no action: a second connect or a racing disconnect would land mid-payment', () => {
  const view = trayView({ ...idle, state: 'connecting', nodeMoniker: 'node-wg' })
  assert.deepEqual([view.icon, view.statusLines, view.action, view.quitLabel], ['connecting', ['Connecting to node-wg…'], null, 'Quit'])
  assert.deepEqual(trayView({ ...idle, state: 'connecting' }).statusLines, ['Connecting…'], 'a node not known yet is not guessed')
})

test('reconnecting: the connecting K, the attempt, and Disconnect stops the ladder', () => {
  const view = trayView({ ...idle, state: 'reconnecting', nodeMoniker: 'node-wg', reconnectAttempt: 2, reconnectMaxAttempts: 5 })
  assert.deepEqual(view, {
    icon: 'connecting',
    tooltip: 'Katacomb VPN: Reconnecting to node-wg (2 of 5)',
    statusLines: ['Reconnecting to node-wg (2 of 5)'],
    action: { label: 'Disconnect', run: 'disconnect' },
    quitLabel: 'Disconnect and quit',
  })
})

test('connected: the solid K, the node, Disconnect, and Quit says it disconnects', () => {
  assert.deepEqual(trayView(up), {
    icon: 'connected',
    tooltip: 'Katacomb VPN: Connected to node-wg',
    statusLines: ['Connected to node-wg'],
    action: { label: 'Disconnect', run: 'disconnect' },
    quitLabel: 'Disconnect and quit',
  })
  assert.deepEqual(trayView({ ...up, nodeMoniker: undefined }).statusLines, ['Connected'])
})

test('a chain names the exit first, where the traffic appears to come from, then the entry', () => {
  assert.deepEqual(trayView({ ...up, nodeMoniker: 'tokyo', entryMoniker: 'amsterdam' }).statusLines, ['Connected to tokyo', 'via amsterdam'])
})

test('local-proxy mode says nothing but the SOCKS5 listener is routed', () => {
  assert.deepEqual(trayView({ ...up, proxyMode: true, socksAddr: '127.0.0.1:1080' }).statusLines, ['Connected to node-wg', 'Proxy only: SOCKS5 127.0.0.1:1080'])
  assert.deepEqual(trayView({ ...up, proxyMode: true }).statusLines, ['Connected to node-wg', 'Proxy only (SOCKS5)'])
})

test('a kill switch that failed to arm is said, not hidden behind the green K', () => {
  assert.deepEqual(trayView({ ...up, killSwitchFailed: true }).statusLines, ['Connected to node-wg', '⚠ Kill switch inactive'])
})

test('control: blocked means nothing outside idle', () => {
  assert.equal(trayView({ ...up, blocked: true }).icon, 'connected')
})

// [REL-39] Reproduced on Cinnamon: with the app's main thread busy for 6.5 s right after
// it painted the green K, the panel's fetch of the new image timed out and the amber K
// stayed up for good.

test('[REL-39] every repaint is sent again, marked, so a panel that dropped it catches up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const painted: [string, boolean][] = []
  const paint = trayPainter((key, marked) => painted.push([key, marked]))
  paint('connected-dark')
  assert.deepEqual(painted, [['connected-dark', false]])
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS - 1)
  assert.equal(painted.length, 1)
  t.mock.timers.tick(1)
  assert.deepEqual(painted, [['connected-dark', false], ['connected-dark', true]])
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS * 10)
  assert.equal(painted.length, 2, 'once again, not a repaint loop')
})

test('[REL-39] a newer repaint replaces the pending one: the second send is the latest icon', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const painted: [string, boolean][] = []
  const paint = trayPainter((key, marked) => painted.push([key, marked]))
  paint('connecting-dark')
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS / 2)
  paint('connected-dark')
  t.mock.timers.tick(TRAY_REPAINT_AGAIN_MS)
  assert.deepEqual(painted, [['connecting-dark', false], ['connected-dark', false], ['connected-dark', true]])
})

test('[REL-39] the marked bitmap differs by one alpha step mid-image, and nowhere else', () => {
  const plain = Buffer.alloc(32 * 32 * 4)
  plain.fill(0xff, 4 * 40, 4 * 60) // some opaque pixels elsewhere
  const before = Buffer.from(plain)
  const marked = markedTrayBitmap(plain, { width: 32, height: 32 })
  assert.deepEqual(plain, before, 'the source bitmap is left alone')
  const diffs = [...marked.keys()].filter((i) => marked[i] !== plain[i])
  assert.deepEqual(diffs, [16 * 32 * 4 + 3], 'only the alpha of the middle row’s leftmost pixel changes')
  assert.equal(marked[diffs[0]], 1, 'from fully transparent to 1 of 255')
  // Live on Cinnamon, a mark in the top-left pixel never reached the panel: it checksums
  // the buffer after freeing it, and the allocator writes over both ends.
  assert.ok(diffs[0] >= 64 && diffs[0] < plain.length - 64, 'the mark must sit clear of both ends of the buffer')
})

/** A probe that answers from a script, counting the questions; then a no for ever. */
function scriptedProbe(answers: boolean[]) {
  const probe = { asked: 0, ask: async () => answers[probe.asked++] ?? false }
  return probe
}
/** Let the awaited probe and the loop behind it run (setImmediate is not mocked). */
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('[REL-40] a login start asks again while the panel comes up, and stops at the first yes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const probe = scriptedProbe([false, false, true])
  const answer = waitForTrayHost(probe.ask)
  await flush()
  assert.equal(probe.asked, 1)
  t.mock.timers.tick(TRAY_HOST_INTERVAL_MS - 1)
  await flush()
  assert.equal(probe.asked, 1, 'not asked again before the interval')
  t.mock.timers.tick(1)
  await flush()
  assert.equal(probe.asked, 2)
  t.mock.timers.tick(TRAY_HOST_INTERVAL_MS)
  await flush()
  assert.equal(await answer, true)
  t.mock.timers.tick(TRAY_HOST_INTERVAL_MS * 10)
  await flush()
  assert.equal(probe.asked, 3, 'nothing is asked after the yes')
})

test('[REL-40] with no tray host it answers no after the last attempt, so the window opens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const probe = scriptedProbe([])
  let settled: boolean | undefined
  void waitForTrayHost(probe.ask).then((v) => { settled = v })
  for (let i = 1; i < TRAY_HOST_ATTEMPTS; i++) {
    await flush()
    assert.equal(settled, undefined, `still waiting after ${i} of ${TRAY_HOST_ATTEMPTS}`)
    t.mock.timers.tick(TRAY_HOST_INTERVAL_MS)
  }
  await flush()
  assert.equal(settled, false)
  assert.equal(probe.asked, TRAY_HOST_ATTEMPTS)
})

test('[REL-40] a tray that is already up answers at once, with no wait', async () => {
  const probe = scriptedProbe([true])
  assert.equal(await waitForTrayHost(probe.ask), true)
  assert.equal(probe.asked, 1)
})

// [REL-42] Panel rules as the stock themes write them (Linux Mint 22.3's, trimmed).
const MINT_Y_AQUA = `#panel {
  /* Set the symbolic foreground color for icons, and importantly, the system tray applet icons */
  color: #303030; }
.panel-top, .panel-bottom, .panel-left, .panel-right {
  color: #ffffff;
  background-color: rgba(243, 243, 244, 0.99); }
.panel-bottom .window-list-item-box { background-color: #000; }`
const MINT_Y_DARK_AQUA = MINT_Y_AQUA.replace('rgba(243, 243, 244, 0.99)', 'rgba(29, 29, 33, 0.99)')
const MINT_L = `.panel-top, .panel-bottom, .panel-left, .panel-right {
  border: none;
  background-color: rgba(47, 47, 47, 0.99); }`
const MINT_X = `.panel-top,
.panel-bottom {
    background-gradient-direction: vertical;
    background-gradient-start: rgb(246, 246, 246);
    background-gradient-end: rgb(206, 206, 206); }`
const GREYBIRD = `.xfce4-panel.background menu .linked button { border-radius: 0; }
.xfce4-panel.background { background-color: rgba(36, 36, 36, 0.8); color: #fcfcfc; font-weight: normal; }`
const CINNAMON_DEFAULT = `.panel-top .workspace-switcher { padding: 0 4px; }
.panel-top, .panel-bottom, .panel-left, .panel-right {
  font-weight: bold;
  background-color: #1a1a1a; }`

/** A desktop whose commands and files answer from these tables; anything else fails. */
function reader(env: Record<string, string>, appsDark: boolean, out: Record<string, string>, files: Record<string, string> = {}): PanelReader {
  return {
    env, appsDark, home: '/home/u',
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(' ')
      if (key in out) return out[key]
      throw new Error(`no ${key}`)
    },
    readFile: async (path) => {
      if (path in files) return files[path]
      throw new Error(`ENOENT ${path}`)
    },
  }
}
const CINNAMON_THEME = 'gsettings get org.cinnamon.theme name'
const XFCE_DARK = 'xfconf-query -c xfce4-panel -p /panels/dark-mode'
const XFCE_THEME = 'xfconf-query -c xsettings -p /Net/ThemeName'

test('[REL-42] GNOME Shell\'s top bar is dark whatever the apps use; its restyled sessions keep the apps\' shade', async () => {
  assert.equal(await panelShade(reader({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, false, {})), 'dark')
  assert.equal(await panelShade(reader({ XDG_CURRENT_DESKTOP: 'GNOME' }, false, {})), 'dark')
  for (const desktop of ['GNOME-Classic:GNOME', 'pop:GNOME', 'Budgie:GNOME', 'zorin:GNOME']) {
    assert.equal(await panelShade(reader({ XDG_CURRENT_DESKTOP: desktop }, false, {})), 'light', desktop)
    assert.equal(await panelShade(reader({ XDG_CURRENT_DESKTOP: desktop }, true, {})), 'dark', desktop)
  }
})

test('[REL-42] Cinnamon: the panel\'s shade comes from the Cinnamon theme\'s stylesheet, not the apps\' theme', async () => {
  const mint = (theme: string, appsDark: boolean, files: Record<string, string>) =>
    panelShade(reader({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, appsDark, { [CINNAMON_THEME]: `'${theme}'\n` }, files))
  // Mint's "Mixed": light apps, dark panel.
  assert.equal(await mint('Mint-Y-Dark-Aqua', false, { '/usr/share/themes/Mint-Y-Dark-Aqua/cinnamon/cinnamon.css': MINT_Y_DARK_AQUA }), 'dark')
  // "Light" changes only the panel.
  assert.equal(await mint('Mint-Y-Aqua', false, { '/usr/share/themes/Mint-Y-Aqua/cinnamon/cinnamon.css': MINT_Y_AQUA }), 'light')
  assert.equal(await mint('Mint-Y-Aqua', true, { '/usr/share/themes/Mint-Y-Aqua/cinnamon/cinnamon.css': MINT_Y_AQUA }), 'light')
  // The user's own copy of a theme wins over the system's, as in Cinnamon.
  assert.equal(await mint('Mint-Y-Aqua', false, {
    '/home/u/.themes/Mint-Y-Aqua/cinnamon/cinnamon.css': MINT_Y_DARK_AQUA,
    '/usr/share/themes/Mint-Y-Aqua/cinnamon/cinnamon.css': MINT_Y_AQUA,
  }), 'dark')
  assert.equal(await mint('Mine', false, { '/home/u/.local/share/themes/Mine/cinnamon/cinnamon.css': MINT_L }), 'dark')
  // The built-in theme lives with Cinnamon itself.
  assert.equal(await mint('cinnamon', false, { '/usr/share/cinnamon/theme/cinnamon.css': CINNAMON_DEFAULT }), 'dark')
  // Nothing to read: the apps' shade.
  assert.equal(await mint('Gone', true, {}), 'dark')
  assert.equal(await mint('Gone', false, {}), 'light')
  assert.equal(await panelShade(reader({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, true, {})), 'dark', 'gsettings failed')
})

test('[REL-42] a stylesheet\'s panel shade is read from the panel rule itself, by luminance, not by name', () => {
  assert.equal(cssPanelShade(MINT_Y_AQUA, CINNAMON_PANEL), 'light')
  assert.equal(cssPanelShade(MINT_Y_DARK_AQUA, CINNAMON_PANEL), 'dark')
  assert.equal(cssPanelShade(MINT_L, CINNAMON_PANEL), 'dark', 'Mint-L is a light theme with a dark panel')
  assert.equal(cssPanelShade(MINT_X, CINNAMON_PANEL), 'light', 'Mint-X draws a light gradient')
  assert.equal(cssPanelShade(CINNAMON_DEFAULT, CINNAMON_PANEL), 'dark')
  assert.equal(cssPanelShade('.panel-bottom { background-color: #fff; }', CINNAMON_PANEL), 'light')
  assert.equal(cssPanelShade('.panel-bottom { background-color: white; }', CINNAMON_PANEL), 'light')
  assert.equal(cssPanelShade('.panel-bottom { background-color: #00000080; }', CINNAMON_PANEL), 'dark')
  // Only the panel's own rule counts, and a rule without a background is skipped.
  assert.equal(cssPanelShade('.panel-bottom .applet { background-color: #000; } .panel-top { color: #000; } .panel-top { background-color: #eee; }', CINNAMON_PANEL), 'light')
  assert.equal(cssPanelShade('.panel-top { background-color: transparent; }', CINNAMON_PANEL), null)
  assert.equal(cssPanelShade('#panel { color: #303030; }', CINNAMON_PANEL), null)
  // The first background that is a plain colour counts.
  assert.equal(cssPanelShade('.panel-top { background: none; background-color: #222; }', CINNAMON_PANEL), 'dark')
  // Xfce's panel, as Greybird (Xubuntu's theme) styles it in its light variant too.
  assert.equal(cssPanelShade(GREYBIRD, XFCE_PANEL), 'dark')
  assert.equal(cssPanelShade(GREYBIRD, CINNAMON_PANEL), null)
})

test('[REL-42] Xfce: the panel rule of the GTK theme decides, its dark variant in dark mode; then dark mode; then the apps', async () => {
  const xfce = (darkMode: string | null, theme: string, appsDark: boolean, files: Record<string, string> = {}) =>
    panelShade(reader({ XDG_CURRENT_DESKTOP: 'XFCE' }, appsDark, {
      ...(darkMode === null ? {} : { [XFCE_DARK]: darkMode }),
      [XFCE_THEME]: `${theme}\n`,
    }, files))
  // Greybird draws a dark panel in its light variant: dark whatever the mode or the apps.
  const greybird = { '/usr/share/themes/Greybird/gtk-3.0/gtk.css': GREYBIRD }
  assert.equal(await xfce('false\n', 'Greybird', false, greybird), 'dark')
  assert.equal(await xfce('true\n', 'Greybird', false, greybird), 'dark')
  // A theme with a light panel and a dark variant: the mode picks the stylesheet.
  const split = {
    '/usr/share/themes/Split/gtk-3.0/gtk.css': '.xfce4-panel.background { background-color: #f0f0f0; }',
    '/usr/share/themes/Split/gtk-3.0/gtk-dark.css': '.xfce4-panel.background { background-color: #202020; }',
  }
  assert.equal(await xfce('true\n', 'Split', false, split), 'dark')
  assert.equal(await xfce('false\n', 'Split', true, split), 'light')
  // No panel rule (Adwaita, Yaru): dark mode makes it dark, else the apps' shade.
  assert.equal(await xfce('true\n', 'Adwaita', false, { '/usr/share/themes/Adwaita/gtk-3.0/gtk.css': 'window { color: #000; }' }), 'dark')
  assert.equal(await xfce('false\n', 'Adwaita', false), 'light')
  assert.equal(await xfce('false\n', 'Adwaita', true), 'dark')
  assert.equal(await xfce(null, '', false), 'light', 'nothing readable (before Xfce 4.18, no xfconf)')
})

test('[REL-42] every other desktop keeps the apps\' shade', async () => {
  for (const env of [{ XDG_CURRENT_DESKTOP: 'KDE' }, { XDG_CURRENT_DESKTOP: 'MATE' }, {}] as Record<string, string>[]) {
    assert.equal(await panelShade(reader(env, true, {})), 'dark')
    assert.equal(await panelShade(reader(env, false, {})), 'light')
  }
})

test('[REL-42] a panel restyled on its own is watched where the desktop can say so', () => {
  assert.deepEqual(panelWatchCommand({ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }), ['gsettings', ['monitor', 'org.cinnamon.theme', 'name']])
  assert.deepEqual(panelWatchCommand({ XDG_CURRENT_DESKTOP: 'XFCE' }), ['xfconf-query', ['-c', 'xfce4-panel', '-p', '/panels/dark-mode', '-m']])
  // GNOME's top bar never changes shade; elsewhere the apps' theme, which nativeTheme reports, decides.
  assert.equal(panelWatchCommand({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), null)
  assert.equal(panelWatchCommand({ XDG_CURRENT_DESKTOP: 'KDE' }), null)
})
