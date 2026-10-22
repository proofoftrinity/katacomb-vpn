import { app, BrowserWindow, shell, Tray, Menu, nativeImage, nativeTheme, powerMonitor } from 'electron'
import { join } from 'path'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'
import {
  registerIpcHandlers, cleanupOnQuit, bootstrapNodesCache, startNodeRefreshTimer, stopNodeRefreshTimer,
  performDisconnect, onConnectionStateChanged, getConnectionInfo, healStrandedKillSwitch,
  healOrphanedTunnel, type ConnectionInfo,
} from './ipc-handlers'
import {
  markedTrayBitmap, panelShade, panelWatchCommand, trayPainter, trayView, waitForTrayHost, windowsTaskbarShade,
  type PanelShade, type TrayView,
} from './tray-view'
import { killAllTunnels, detectExistingConnection } from './vpn/vpn-manager'
import { onChainPathChanged, runAutoRpcSelection, startRpcMonitor, stopRpcMonitor } from './chain/rpc-monitor'
import { sweepStaleSessionFiles } from './chain/chain-service'
import { migrateLegacyUserData, dedupeWalletEntries, migrateProviderModeToWallet, migrateRpcMode, keyringSwitch } from './settings'
import { followRunningCopy } from './autostart'
import { listProviders } from './provider/provider-service'
import { registerWithDesktopSession } from './desktop-session'
import { registerWithXsmp } from './xsmp-session'
import { IPC } from '../shared/ipc-channels'
import { IS_WINDOWS } from './platform'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'

// Node's connection selection ("happy eyeballs") tries a host's addresses one at
// a time and CANCELS an attempt that has not connected within this budget. The
// default (250 ms in older Node, 500 ms in current) is shorter than a round trip
// through a far tunnel: via a node on the other side of the world the SYN-ACK
// lands ~330 ms or more after the SYN, by which time Node has closed the socket,
// so the kernel answers the reply with RST and the lookup fails with ETIMEDOUT.
// Seen as "IP: unreachable" on every far node while browsing through the same
// tunnel worked, because Chromium races addresses instead of cancelling. Only
// hosts with both A and AAAA records are affected (icanhazip, ipapi.co, most RPC
// endpoints); single-family hosts and IP literals never enter this path. The cost
// of a long budget is paid only when an address family is silently blackholed (no
// ICMP), which is rare; an unroutable family fails instantly and moves on. 2 s
// covers a two-hop chain across the world; every caller still bounds the request
// with its own AbortSignal.
setDefaultAutoSelectFamilyAttemptTimeout(2_000)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let forceQuit = false

// Whether any panel actually DISPLAYS StatusNotifierItems. Stock GNOME (default
// desktop on Debian and Ubuntu) ships no tray at all: new Tray() succeeds, the
// item registers, and nothing is drawn anywhere. Hiding the window "to the tray"
// there makes the app unreachable, so the close handler falls back to quitting.
// Defaults to true so a failed probe preserves the hide-to-tray behavior.
let trayHostAvailable = true

// Started by the desktop at login: the autostart entry passes --autostart (autostart.ts).
const startedAtLogin = process.argv.includes('--autostart')

/** Ask the session's StatusNotifierWatcher (over gdbus, which glib ships on every
 *  Debian-based distro) whether a host is registered. Any failure — no watcher on
 *  the bus, no gdbus, timeout — means no visible tray. Async and best-effort: the
 *  answer only matters by the time the user closes the window, or for a login
 *  start, whether the window opens at all. */
function probeTrayHost(): Promise<boolean> {
  // Windows always draws the notification area's icons (in the overflow at worst).
  if (IS_WINDOWS) return Promise.resolve(true)
  return new Promise((resolve) => {
    execFile('gdbus', [
      'call', '--session',
      '--dest', 'org.kde.StatusNotifierWatcher',
      '--object-path', '/StatusNotifierWatcher',
      '--method', 'org.freedesktop.DBus.Properties.Get',
      'org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered',
    ], { timeout: 3000 }, (err, stdout) => {
      trayHostAvailable = !err && stdout.includes('true')
      resolve(trayHostAvailable)
    })
  })
}

function getIconPath(filename: string): string {
  return is.dev
    ? join(__dirname, '../../build/icons', filename)
    : join(process.resourcesPath, 'icons', filename)
}

/** Tray art is kept out of build/icons/ because electron-builder's `linux.icon`
 *  points at that directory and derives the launcher icon set from the PNGs it
 *  finds there — a badged 32x32 must not be a candidate. */
function getTrayIconPath(filename: string): string {
  return is.dev
    ? join(__dirname, '../../build/tray', filename)
    : join(process.resourcesPath, 'tray', filename)
}

/** `then` runs once the window is up: at once if it exists, after its page's first paint
 *  if it had to be created, so a message it sends reaches a page that is listening. */
function showWindow(then?: () => void): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(then)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  then?.()
}

/** Tray left-click: toggle the window — hide it if it's showing, otherwise show it. */
function toggleWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide()
    return
  }
  showWindow()
}

/** Tray "Reconnect last session": show the window and let the renderer reconnect the
 *  session main chose ([REL-38]), on the Sessions tab, where a refusal is shown. */
function triggerTrayConnect(sessionId: string): void {
  showWindow(() => mainWindow?.webContents.send(IPC.CONNECTION_TRAY_CONNECT, sessionId))
}

/** Tray "About": show the window and open the renderer's About modal, the same
 *  one the status bar's version chip opens, so there is exactly one About
 *  surface (with the clickable GitHub link a native message box can't render). */
function showAbout(): void {
  showWindow(() => mainWindow?.webContents.send(IPC.ABOUT_SHOW))
}

// [REL-42] The panel's shade as last read (readPanelShade); the tray is made only after the first read.
let panel: PanelShade = 'dark'

/** The tray is a flat single-colour silhouette (no background tile), like its
 *  neighbours in the panel — so unlike the launcher/About icon it needs a
 *  variant per panel theme. Filenames are keyed by the panel they're FOR, which
 *  is exactly what this returns, so there's no inversion to get backwards. */
function trayPanel(): PanelShade {
  return panel
}

/** [REL-42] Read the panel's shade from the desktop, falling back on the apps' theme. */
async function readPanelShade(): Promise<void> {
  const run = (cmd: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
  panel = IS_WINDOWS ? await windowsTaskbarShade(run) : await panelShade({
    env: process.env,
    home: app.getPath('home'),
    appsDark: nativeTheme.shouldUseDarkColors,
    run,
    readFile: (path) => readFile(path, 'utf-8'),
  })
}

// [REL-42] Prints a line whenever the panel's theme changes without the apps' (panelWatchCommand).
let panelWatch: ChildProcess | null = null

/** Which tray PNG a state wants right now: the state's K + the current panel. */
function trayIconKeyFor(icon: TrayView['icon']): string {
  return `${icon}-${trayPanel()}`
}

/** Load one of the tray PNGs by key (32x32 is the tray size; fall back to 256 if
 *  that file is somehow empty so we never construct a Tray with a blank image —
 *  the broken-image triangle). */
function trayImage(key: string): Electron.NativeImage {
  const icon = nativeImage.createFromPath(getTrayIconPath(`${key}-32x32.png`))
  return icon.isEmpty() ? nativeImage.createFromPath(getTrayIconPath(`${key}-256x256.png`)) : icon
}

// Which tray PNG we last ASKED the panel to show, so a repaint that wouldn't
// change it can be skipped. Every setImage is a visible repaint of the panel
// item, and nativeTheme fires 'updated' three times per theme toggle (measured
// on Cinnamon, all three carrying the same value) — painting each one is what
// made the icon blink before settling. Guarding on the filename collapses the
// burst to the one repaint that actually changes something, with no delay added.
//
// It records INTENT, not what the panel actually displays, and setImage reports
// nothing — so the guard alone makes a dropped repaint permanent: one attempt
// per transition and never a retry. Live on the AppImage 2026-09-14, a connected
// V2Ray tunnel sat under the amber "connecting" dot indefinitely while the
// tooltip, the menu and the window all said Connected (those are separate D-Bus
// properties, so only the image was lost). The AppImage is where it shows because
// AppRun puts $APPDIR/usr/lib ahead of the system and electron-builder stages the
// dead GTK2-era libappindicator.so.1 there, so it binds that instead of the
// host's libayatana-appindicator3.
// Hence `force` below: connection state changes a handful of times a session and
// every one matters, while the theme burst is three events that must collapse.
// The deb drops one too, and `force` cannot help when no push follows ([REL-39]):
// Cinnamon's panel asks this main thread for the new image and gives up after 5 s,
// so a thread busy that long right after the repaint leaves the old icon up for good.
// Hence paintTray, which sends every repaint again a moment later.
let trayIconKey = ''

// [REL-39] The one place the tray's image is set after it is created.
const paintTray = trayPainter((key, marked) => {
  const image = trayImage(key)
  const size = image.getSize()
  tray?.setImage(marked ? nativeImage.createFromBitmap(markedTrayBitmap(image.toBitmap(), size), size) : image)
})

async function createTrayIcon(): Promise<void> {
  // The first image is the right one: a wrong shade repainted a moment later would blink.
  await readPanelShade()
  if (quitHandled) return // a logout in the meantime: the quit has already taken the tray down
  const info = getConnectionInfo()
  trayIconKey = trayIconKeyFor(trayView(info).icon)
  tray = new Tray(trayImage(trayIconKey))
  tray.on('click', () => toggleWindow())
  refreshTray(info)
  // The user can flip their panel theme without restarting the app; re-pick the
  // ink variant when that happens rather than leaving a light-panel icon up
  // against a freshly-dark one. Repaint on the event itself, not on a timer:
  // shouldUseDarkColors is already updated by the time the event arrives (it
  // leads the first firing by ~60-80ms), so there is nothing to wait for, and
  // any debounce here is latency the user reads as the icon lagging its
  // neighbours. Those neighbours are symbolic icons the panel recolours itself,
  // which we can't match exactly — Tray takes a bitmap, so a swap is the only
  // mechanism available — but the event is as early as Electron will tell us.
  // The re-read of the panel's shade answers at once where the apps' theme decides
  // it, and in a few ms where it runs gsettings or xfconf-query ([REL-42]).
  // getConnectionInfo() is the whole state ([REL-35]), so this re-read loses nothing.
  const repaint = () => void readPanelShade().then(() => refreshTray(getConnectionInfo()))
  nativeTheme.on('updated', repaint)
  // A panel restyled on its own (Cinnamon, Xfce) fires no nativeTheme event.
  const watch = panelWatchCommand(process.env)
  if (watch) {
    panelWatch = spawn(watch[0], watch[1], { stdio: ['ignore', 'pipe', 'ignore'] })
    panelWatch.on('error', () => { panelWatch = null })
    panelWatch.stdout?.on('data', repaint)
  }
}

/**
 * Rebuild the tray icon, tooltip + context menu to reflect the current connection
 * state. `force` repaints even when the filename is unchanged — see trayIconKey.
 */
function refreshTray(info: ConnectionInfo, force = false): void {
  if (!tray) return
  const view = trayView(info)
  const action = view.action

  const iconKey = trayIconKeyFor(view.icon)
  if (force || iconKey !== trayIconKey) {
    paintTray(iconKey)
    trayIconKey = iconKey
  }
  tray.setToolTip(view.tooltip)

  const contextMenu = Menu.buildFromTemplate([
    ...view.statusLines.map((label) => ({ label, enabled: false })),
    { type: 'separator' },
    ...(action
      ? [{ label: action.label, click: action.run === 'reconnect' ? () => triggerTrayConnect(action.sessionId) : trayDisconnect }]
      : []),
    { label: 'Show Window', click: () => showWindow() },
    { label: 'About', click: () => showAbout() },
    { type: 'separator' },
    { label: view.quitLabel, click: () => { forceQuit = true; app.quit() } },
  ])

  tray.setContextMenu(contextMenu)
}

/** Tray "Disconnect" / "Restore internet". A failure (usually a dismissed polkit
 *  prompt) is explained by the window's own banners, so bring the window up. */
function trayDisconnect(): void {
  performDisconnect().catch((err: unknown) => {
    console.error('[tray] disconnect failed:', err)
    showWindow()
  })
}

/** `onShown` runs right after the window first shows (showWindow's `then`). */
function createWindow(onShown?: () => void): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    // Must match --color-bg-primary (tokens.css) — this paints the window between
    // OS-level creation and first React paint.
    backgroundColor: '#16181d',
    titleBarStyle: 'hiddenInset',
    icon: getIconPath('256x256.png'),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    onShown?.()
  })

  // [REL-36] Windows asks every top-level window, hidden ones too, before a logoff, a
  // shutdown or an installer's close: the earliest notice there is, so the normal quit,
  // teardown included, starts here. With no window (a login start still in the tray)
  // the service's logoff teardown is the backstop (docs/windows.md).
  if (IS_WINDOWS) mainWindow.on('query-session-end', () => { forceQuit = true; app.quit() })

  mainWindow.on('close', (e) => {
    if (forceQuit) return // Allow quit (from tray menu or app.quit())
    // No desktop shows our tray icon (stock GNOME on Debian/Ubuntu): hiding here
    // would leave the app running with no visible way back in or out. Let the
    // window close; window-all-closed then quits through the normal teardown.
    if (!trayHostAvailable) return
    // Closing the window minimizes to the tray; the app keeps running so the
    // tray Connect/Disconnect menu stays available. Real quit = tray "Quit"
    // (sets forceQuit), whose before-quit handler tears down any active tunnel.
    e.preventDefault()
    mainWindow?.hide()
  })

  // Never open a new window; hand only web/mail links to the OS browser.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const { protocol } = new URL(details.url)
      if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
        shell.openExternal(details.url)
      }
    } catch { /* malformed URL — ignore */ }
    return { action: 'deny' }
  })

  // Lock the renderer to its own origin. The SPA navigates via React state, so
  // a real top-frame navigation is always unwanted — block it (and send any
  // external link to the OS browser instead).
  const rendererOrigin = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
    : null
  // In the packaged app the renderer is loaded via loadFile(), a file:// URL whose
  // .origin is the literal string "null" — never equal to rendererOrigin. That made
  // location.reload() (used e.g. after deleting the active wallet) get silently
  // swallowed below instead of reloading. Compare file:// navigations by filesystem
  // path against our own index.html instead of by origin.
  const indexPath = join(__dirname, '../renderer/index.html')
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let isSameOrigin = false
    try {
      const target = new URL(url)
      isSameOrigin = rendererOrigin !== null && target.origin === rendererOrigin
      if (!isSameOrigin && target.protocol === 'file:') {
        isSameOrigin = fileURLToPath(target) === indexPath
      }
    } catch { /* ignore */ }
    if (isSameOrigin) return // allow dev-server reload/HMR, or reload of our own packaged index.html
    event.preventDefault()
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url)
    } catch { /* ignore */ }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(indexPath)
  }
}

// [REL-41] Ask for the keyring the stored seeds are in, not the one this desktop suggests.
// Chromium picks it as `ready` comes, so this has to run first. A --password-store the
// user passed wins.
if (!app.commandLine.hasSwitch('password-store')) {
  const store = keyringSwitch(process.env)
  if (store) app.commandLine.appendSwitch('password-store', store)
}

// Single-instance lock. A second instance would race the first over the sntl0
// interface, the daemon socket, the kill-switch chain and the settings/wallet
// files. The loser exits at once and focuses the winner's window.
// app.exit (not app.quit) on purpose: app.quit() fires our before-quit handler,
// which tears down the *shared* tunnel — the primary's connection must survive.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => showWindow())
}

app.whenReady().then(() => {
  // Electron's default menu bar (File, Edit, View...) shows in the window on Windows, and
  // offers nothing this app uses. Linux keeps what it has always had.
  if (IS_WINDOWS) Menu.setApplicationMenu(null)
  // Must run before anything touches userData (sweepStaleSessionFiles, settings,
  // the wallet store): the rename moved the directory, so this brings the user's
  // profile across from the pre-rename location.
  migrateLegacyUserData()
  // Repair installs that predate the uniqueness guard in addWalletEntry, where
  // re-importing a stored seed created a second entry for the same address.
  dedupeWalletEntries()
  // Provider mode used to be global, so it leaked onto every seed imported after
  // it was turned on. Runs after the dedupe, which can rewrite activeWalletId.
  migrateProviderModeToWallet()
  // Smart RPC: a pre-feature custom endpoint becomes an explicit 'manual' choice.
  // Must precede any saveSettings, which would bake the 'auto' default in.
  migrateRpcMode()
  // An AppImage update is a new file name: point an enabled start-at-login entry at this copy.
  followRunningCopy()
  // No setup prompts here, deliberately: the window comes first on every launch.
  // The helper and the distro packages are asked for when a connect needs them,
  // before any payment (assertSystemReady in ipc/setup.ts), and from Settings, System.
  detectExistingConnection()
  // A tunnel that outlived the run which created it comes back with no session and
  // nothing supervising it, so close it before anything reports it as connected.
  // Chained ahead of the kill-switch heal rather than run beside it: that heal skips
  // while a tunnel is up, so it has to see the state this leaves behind, not the one
  // it found. Fire-and-forget for the same reason the heal is — on the pkexec path
  // either step can sit on a password prompt for as long as the user takes.
  void healOrphanedTunnel()
    .catch(() => { /* best-effort — the kill-switch heal below still runs */ })
    // If a previous run left a kill-switch chain stranded (crash/OOM mid-teardown),
    // clear it now that we know we're not connected. Best-effort.
    // Re-probe when it lands: until then the monitor reports the chain as blocking
    // (correctly — nothing gets out), and this is what tells it that stopped being
    // true. Not awaited before starting the monitor, because on the pkexec path the
    // heal can sit on a password prompt for as long as the user takes.
    .then(() => healStrandedKillSwitch())
    .catch(() => { /* best-effort self-heal */ })
    .finally(() => { onChainPathChanged() })
  // Drop stale session credential files left by non-endSession exit paths (finding L4).
  sweepStaleSessionFiles()
  registerIpcHandlers()
  // Seed node cache from disk so the first window gets instant data via
  // nodesGetCached(), then start the 60s background refresh loop.
  bootstrapNodesCache()
  startNodeRefreshTimer()
  // Watch the RPC endpoint every chain call depends on, so an unhealthy one is
  // visible in the status bar instead of showing up as silently stale data.
  startRpcMonitor()
  // Answer "does this desktop draw tray icons at all?" before the user can close
  // the window; the close handler falls back to quitting when it doesn't. A login
  // start asks for longer, since the panel may still be starting, and creates no
  // window until one is asked for: the page reads the wallet, which on an auto-login
  // account blocks main behind the keyring's unlock prompt. With no tray the window
  // is the only way in, so it opens. Its tray icon waits for the answer too: one made
  // before the panel's tray is up falls back to an old XEmbed icon ([REL-40]).
  if (startedAtLogin) {
    void waitForTrayHost(probeTrayHost).then((drawn) => {
      if (quitHandled) return // a logout in the meantime: the quit is under way
      void createTrayIcon()
      if (!drawn) showWindow()
    })
  } else {
    void probeTrayHost()
    createWindow()
    void createTrayIcon()
  }
  // A logout or a shutdown from the desktop must run the normal quit, teardown included,
  // before the session goes: GNOME's logout kills the GPU process out from under the
  // app, and Chromium then crashes itself instead of quitting; KDE's takes X away, and
  // Electron crashes on that ([REL-36]). GNOME and Xfce over D-Bus, KDE over XSMP: each
  // waits until the app has exited. XSMP only when no D-Bus session manager took the app
  // on, since GNOME and Xfce answer XSMP as well.
  // Windows tells the window instead (createWindow's query-session-end).
  if (!IS_WINDOWS) void registerWithDesktopSession({
    address: process.env['DBUS_SESSION_BUS_ADDRESS'],
    uid: process.getuid?.() ?? 0,
    startupId: process.env['DESKTOP_AUTOSTART_ID'] ?? '',
    onEndSession: () => { forceQuit = true; app.quit() },
  }).then((registered) => {
    if (registered) return
    registerWithXsmp({
      sessionManager: process.env['SESSION_MANAGER'],
      iceAuthority: process.env['ICEAUTHORITY'],
      onEndSession: () => { forceQuit = true; app.quit() },
    })
  })
  // Keep the tray icon, tooltip + menu in sync with connect/disconnect (incl. from
  // the renderer, auto-reconnect, or the tray itself). Forced: these are the few
  // repaints a session that must not be skipped, and the connect path publishes
  // 'connected' twice on purpose — once when the bring-up finishes, once when its
  // connect step ends — so forcing turns the second push back into the free retry
  // it was meant to be.
  onConnectionStateChanged((info) => refreshTray(info, true))

  // Background prefetch so the Plans tab feels instant on first open.
  // Safely returns cached data if VPN is already active.
  setTimeout(() => {
    listProviders().catch(() => {
      // silent — best-effort warmup
    })
  }, 500)

  // Smart RPC's startup pass: probe the public feed once and settle on the best
  // endpoint. Delayed so it doesn't compete with startup, and so the kill-switch
  // heal above has usually cleared a stranded chain first (the selection skips
  // itself while the path is blocked or an adopted tunnel is up, in which case
  // the on-fault trigger covers the rest of the session).
  setTimeout(() => { void runAutoRpcSelection() }, 3_000)

  // Smart RPC on wake: a resumed laptop is often on a different network, where
  // the endpoint chosen before suspend is still healthy but now far away, a
  // state no fault trigger will ever notice. Delayed for the network to
  // re-associate; a run that finds no network yet keeps the current endpoint,
  // and the monitor's fault trigger covers whatever settles later.
  powerMonitor.on('resume', () => {
    setTimeout(() => { void runAutoRpcSelection() }, 8_000)
  })
  // A shutdown that skips the session manager (`sudo reboot`, or GNOME's restart while
  // another user is logged in) takes X down within ~70 ms, and Electron crashes when X
  // goes. With a listener here Electron holds a logind delay lock, and preventDefault()
  // keeps it until the app has exited, so the quit and its teardown run first ([REL-36]).
  // It must not be powerMonitor's first listener: Electron 41 takes the lock only for a
  // 'shutdown' listener added after the first one. Its typings give this listener no
  // arguments; it is passed the event all the same.
  const power: NodeJS.EventEmitter = powerMonitor
  power.on('shutdown', (e: Electron.Event) => { e.preventDefault(); forceQuit = true; app.quit() })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

let quitHandled = false
app.on('before-quit', (e) => {
  // Destroy the tray the moment quitting starts, on every path: menu Quit,
  // SIGTERM and Ctrl+C all arrive here (Chromium routes signals into the quit
  // flow — verified live). destroy() unregisters the StatusNotifierItem over
  // D-Bus; the app.exit(0) below just drops the bus connection and leaves
  // removal to the panel noticing the name vanish, which is the step that
  // occasionally fails and strands a dead "ghost" icon in the panel.
  tray?.destroy()
  tray = null
  panelWatch?.kill()
  if (quitHandled) {
    // A repeat quit (second menu Quit, double Ctrl+C) must not fall through to
    // the default quit path: that exits at once, cutting the in-flight teardown
    // below mid-way. The already-scheduled app.exit(0) finishes the job.
    e.preventDefault()
    return
  }
  // Teardown is now async (it may round-trip to the root daemon), so defer the
  // quit until it finishes — capped so an unresponsive daemon can't hang the
  // exit. The kernel-resident kill switch/routes survive regardless.
  e.preventDefault()
  quitHandled = true
  // A GPU process lost from here on must not crash the app mid-teardown ([REL-37]): a
  // SIGTERM to every app process at once (pkill, a kill of every PID) kills the zygote
  // with it, every relaunch fails, and after six Chromium crashes itself on purpose.
  // Chromium reads the switch at each crash, so setting it now takes effect at once.
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit')
  stopNodeRefreshTimer()
  stopRpcMonitor()
  void (async () => {
    await Promise.race([
      (async () => {
        try { await cleanupOnQuit() } catch { /* best-effort */ }
        try { await killAllTunnels() } catch { /* best-effort */ }
      })(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
    app.exit(0)
  })()
})

app.on('window-all-closed', () => {
  // With no tray host on this desktop (stock GNOME), the closed window was the
  // only control surface left — quit rather than linger headless.
  if (!trayHostAvailable) {
    app.quit()
    return
  }
  // Otherwise: the app lives in the tray (closing the window only hides it).
  // Quitting is done explicitly via the tray "Quit" item, which sets
  // forceQuit + app.quit().
})

export { mainWindow }
