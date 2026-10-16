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
