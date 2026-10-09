import type { ConnectionInfo } from './ipc-handlers'

/**
 * What the tray shows for a connection state, kept free of Electron so the whole of it
 * is a tested table (tray-view.test.ts); index.ts only hands it to Tray and Menu.
 *
 * The icon's badge SHAPE carries the state (none, hollow ring, solid disc, no-entry
 * sign), so it reads in greyscale and to a colour-blind user; colour only reinforces it
 * (scripts/build-icons.mjs draws them).
 */
export interface TrayView {
  icon: 'disconnected' | 'blocked' | 'connecting' | 'connected'
  tooltip: string
  /** Disabled rows at the top of the menu: what is true now. */
  statusLines: string[]
  /** The one connection action offered, or none while a connect is being set up. */
  action: { label: string; run: 'reconnect' | 'disconnect' } | null
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
      return view('disconnected', ['Disconnected'], { label: 'Reconnect last session', run: 'reconnect' })
  }
}
