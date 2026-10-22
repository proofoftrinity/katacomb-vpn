import type { ConnectionInfo } from './ipc-handlers'

/**
 * What the tray shows for a connection state, kept free of Electron so the whole of it
 * is a tested table (tray-view.test.ts); index.ts only hands it to Tray and Menu.
 *
 * How FULL the icon's K is carries the state (outline, lower part filled, solid, solid
 * with a slash cut through), so it reads in greyscale and to a colour-blind user; colour
 * only reinforces it (scripts/build-icons.mjs draws them).
 */
export interface TrayView {
  icon: 'disconnected' | 'blocked' | 'connecting' | 'connected'
  tooltip: string
  /** Disabled rows at the top of the menu: what is true now. */
  statusLines: string[]
  /** The one connection action offered: none while a connect is being set up, or while
   *  idle with no session main would reconnect ([REL-38]). */
  action: { label: string; run: 'reconnect'; sessionId: string } | { label: string; run: 'disconnect' } | null
  /** Quit runs the full disconnect ([REL-30]), so while a tunnel is up it says so. */
  quitLabel: string
}

export function trayView(info: ConnectionInfo): TrayView {
  const node = info.nodeMoniker
  const view = (icon: TrayView['icon'], statusLines: string[], action: TrayView['action'], quitLabel = 'Quit'): TrayView =>
    ({ icon, tooltip: `Katacomb VPN: ${statusLines[0]}`, statusLines, action, quitLabel })
  const disconnect = { label: 'Disconnect', run: 'disconnect' } as const

  switch (info.state) {
    case 'connected':
      return view('connected', [
        node ? `Connected to ${node}` : 'Connected',
        ...(info.entryMoniker ? [`via ${info.entryMoniker}`] : []),
        ...(info.proxyMode ? [info.socksAddr ? `Proxy only: SOCKS5 ${info.socksAddr}` : 'Proxy only (SOCKS5)'] : []),
        ...(info.killSwitchFailed ? ['⚠ Kill switch inactive'] : []),
      ], disconnect, 'Disconnect and quit')
    case 'reconnecting':
      return view('connecting', [
        `Reconnecting${node ? ` to ${node}` : ''} (${info.reconnectAttempt} of ${info.reconnectMaxAttempts})`,
      ], disconnect, 'Disconnect and quit')
    // No action: a Connect would start a second flow beside one that may be paying
    // ([REL-34] refuses it anyway), and a Disconnect would queue behind the connection
    // lock until the step it races had finished.
    case 'connecting':
      return view('connecting', [node ? `Connecting to ${node}…` : 'Connecting…'], null)
    case 'idle':
      // The same press as the window's "Restore internet": a full disconnect, which
      // takes the kill switch's DROP-all chain down.
      if (info.blocked) return view('blocked', ['Internet blocked by the kill switch'], { label: 'Restore internet', run: 'disconnect' })
      return view('disconnected', ['Disconnected'], info.reconnectSessionId
        ? { label: 'Reconnect last session', run: 'reconnect', sessionId: info.reconnectSessionId }
        : null)
  }
}

/** [REL-40] How many times a login start asks whether a tray is drawn, and how far apart. */
export const TRAY_HOST_ATTEMPTS = 5
export const TRAY_HOST_INTERVAL_MS = 2000

/**
 * [REL-40] Whether a panel draws tray icons, asked again for a while before taking no for an
 * answer: at login the panel can register its tray after this app has started, and a single
 * early "no" would open the window for nothing, and leave its X quitting the app all session.
 * Resolves true at the first yes.
 */
export async function waitForTrayHost(probe: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    if (await probe()) return true
    if (attempt >= TRAY_HOST_ATTEMPTS) return false
    await new Promise((resolve) => setTimeout(resolve, TRAY_HOST_INTERVAL_MS))
  }
}

/** [REL-39] How long after a repaint the tray sends the same icon again. */
export const TRAY_REPAINT_AGAIN_MS = 2000

/**
 * [REL-39] Wraps the tray's image setter so every repaint goes out twice: now, and once
 * more TRAY_REPAINT_AGAIN_MS later, marked (markedTrayBitmap). A panel can drop a
 * repaint and nothing tells the app, so the second send is what brings it back. A newer
 * repaint replaces the pending one, so the second send is always the latest icon.
 */
export function trayPainter(paint: (key: string, marked: boolean) => void): (key: string) => void {
  let again: ReturnType<typeof setTimeout> | undefined
  return (key) => {
    clearTimeout(again)
    paint(key, false)
    again = setTimeout(() => paint(key, true), TRAY_REPAINT_AGAIN_MS)
  }
}

/**
 * [REL-39] A copy of a tray bitmap with one alpha step changed, in the leftmost pixel of the
 * middle row: transparent in every tray PNG, so it goes from 0 to 1 of 255, which no one can
 * see. Cinnamon skips an image whose checksum matches the one it holds, and takes that
 * checksum over a buffer it has already freed, whose first and last bytes the allocator
 * overwrites; a mark in the top-left pixel was lost that way, mid-image it is not.
 */
export function markedTrayBitmap(bitmap: Buffer, size: { width: number; height: number }): Buffer {
  const marked = Buffer.from(bitmap)
  marked[Math.floor(size.height / 2) * size.width * 4 + 3] ^= 1
  return marked
}

export type PanelShade = 'dark' | 'light'

/** What panelShade reads, passed in so the whole of it is tested; index.ts hands it the real ones. */
export interface PanelReader {
  env: NodeJS.ProcessEnv
  home: string
  /** nativeTheme.shouldUseDarkColors: the shade of the apps' theme. */
  appsDark: boolean
  /** A command's stdout; rejects when it fails or is missing. */
  run: (cmd: string, args: string[]) => Promise<string>
  readFile: (path: string) => Promise<string>
}

/** The rules that style a panel itself, by desktop. */
export const CINNAMON_PANEL = ['.panel-top', '.panel-bottom']
export const XFCE_PANEL = ['.xfce4-panel.background', '.xfce4-panel']

/**
 * [REL-42] The shade of the panel the tray icon sits on, which its ink is picked for. The apps'
 * theme (nativeTheme) says nothing about it where the panel has a theme of its own, and in the
 * release VM (2026-10-16) the dark K sat on a dark panel twice: GNOME Shell's top bar is dark in
 * every stock theme, whatever the apps use, and so is Xfce's under Greybird, Xubuntu's theme,
 * in its light variant too. Cinnamon's panel comes from the Cinnamon theme, which Mint's "Mixed"
 * look pairs dark with light apps. A theme's own CSS says which, since its name does not (Mint-L
 * draws a dark panel, Mint-X a light one). Any other desktop, and any read that fails, gets the
 * apps' shade, which is what every desktop got before.
 */
export async function panelShade(r: PanelReader): Promise<PanelShade> {
  const apps: PanelShade = r.appsDark ? 'dark' : 'light'
  const desktop = r.env['XDG_CURRENT_DESKTOP'] ?? ''
  try {
    // Stock GNOME and Ubuntu's; Classic, Pop, Zorin and Budgie restyle the panel.
    if (desktop === 'GNOME' || desktop === 'ubuntu:GNOME') return 'dark'
    if (desktop.split(':').includes('X-Cinnamon')) {
      const name = (await r.run('gsettings', ['get', 'org.cinnamon.theme', 'name'])).trim().replace(/^'|'$/g, '')
      // 'cinnamon' is the theme Cinnamon ships inside itself.
      const css = await firstReadable(r, !name || name === 'cinnamon'
        ? ['/usr/share/cinnamon/theme/cinnamon.css']
        : themeFiles(name, r.home, 'cinnamon/cinnamon.css'))
      return (css === null ? null : cssPanelShade(css, CINNAMON_PANEL)) ?? apps
    }
    if (desktop.split(':').includes('XFCE')) {
      const xfconf = (channel: string, property: string) =>
        r.run('xfconf-query', ['-c', channel, '-p', property]).then((out) => out.trim(), () => '')
      // Xfce 4.18's panel dark mode (its default) draws the theme's dark variant.
      const dark = await xfconf('xfce4-panel', '/panels/dark-mode') === 'true'
      const theme = await xfconf('xsettings', '/Net/ThemeName')
      const css = theme ? await firstReadable(r, [
        ...(dark ? themeFiles(theme, r.home, 'gtk-3.0/gtk-dark.css') : []),
        ...themeFiles(theme, r.home, 'gtk-3.0/gtk.css'),
      ]) : null
      return (css === null ? null : cssPanelShade(css, XFCE_PANEL)) ?? (dark ? 'dark' : apps)
    }
  } catch { /* the apps' shade */ }
  return apps
}

/**
 * [REL-42] Windows: the taskbar's shade is the system's mode (SystemUsesLightTheme), set
 * apart from the apps' (AppsUseLightTheme, which is what nativeTheme reads): Windows 10's
 * default pairs a dark taskbar with light apps. A failed read gets dark, that default.
 */
export async function windowsTaskbarShade(run: PanelReader['run']): Promise<PanelShade> {
  try {
    const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'])
    const value = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)?.[1]
    if (value !== undefined) return parseInt(value, 16) ? 'light' : 'dark'
  } catch { /* the default */ }
  return 'dark'
}

/** [REL-42] The command that prints a line whenever the panel's theme changes on its own,
 *  without the apps' theme (nativeTheme fires for that): Mint's Mixed to Light changes
 *  only the panel. */
export function panelWatchCommand(env: NodeJS.ProcessEnv): [string, string[]] | null {
  const desktops = (env['XDG_CURRENT_DESKTOP'] ?? '').split(':')
  if (desktops.includes('X-Cinnamon')) return ['gsettings', ['monitor', 'org.cinnamon.theme', 'name']]
  if (desktops.includes('XFCE')) return ['xfconf-query', ['-c', 'xfce4-panel', '-p', '/panels/dark-mode', '-m']]
  return null
}

/** Where a desktop looks for a theme's file, first match wins: the user's copies, then the system's. */
function themeFiles(theme: string, home: string, file: string): string[] {
  return [`${home}/.themes`, `${home}/.local/share/themes`, '/usr/share/themes'].map((dir) => `${dir}/${theme}/${file}`)
}

async function firstReadable(r: PanelReader, files: string[]): Promise<string | null> {
  for (const file of files) {
    const text = await r.readFile(file).catch(() => null)
    if (text !== null) return text
  }
  return null
}

/** [REL-42] The shade of the panel a stylesheet draws: the background (a colour, or a
 *  gradient's start) of the first rule that styles one of `panel` itself. */
export function cssPanelShade(css: string, panel: string[]): PanelShade | null {
  for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((s) => panel.includes(s.trim()))) continue
    const rgb = [...body.matchAll(/background(?:-color|-gradient-start)?\s*:\s*([^;]+)/g)]
      .map((m) => parseCssColor(m[1].trim())).find((c) => c !== null)
    // Relative luminance below 0.179: white ink contrasts more than black (WCAG).
    if (rgb) return luminance(rgb) < 0.179 ? 'dark' : 'light'
  }
  return null
}

function parseCssColor(value: string): [number, number, number] | null {
  if (value === 'white') return [255, 255, 255]
  if (value === 'black') return [0, 0, 0]
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value)
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
