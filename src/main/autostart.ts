import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { writeFileAtomic } from './fs-utils'

/**
 * Start at login, through the XDG Autostart spec: every Linux desktop starts what it finds in
 * ~/.config/autostart when the user logs in, and Electron's setLoginItemSettings covers only
 * macOS and Windows. The file IS the setting, with nothing kept in settings.json, so an entry
 * removed or switched off with the desktop's own startup tool reads as off here too.
 */

export interface AutostartState {
  /** False in a dev build, whose entry would start a broken app at every login. */
  available: boolean
  enabled: boolean
}

function entryPath(): string {
  return join(app.getPath('appData'), 'autostart', 'katacomb-vpn.desktop')
}

/**
 * [PKG-2] What this copy's entry starts: the AppImage file itself, not the mount it runs
 * from (gone by the next login), or the installed binary. Null where no entry may be
 * written: a dev build, or a path the file cannot carry (a newline would end the line).
 */
function command(): string | null {
  if (!app.isPackaged) return null
  const path = process.env['APPIMAGE'] || process.execPath
  return /[\x00-\x1f\x7f]/.test(path) ? null : path
}

/**
 * [PKG-2] The Exec line, quoted the way the Desktop Entry spec says: inside double quotes
 * " ` $ \ each take a backslash, the file's string escape then doubles every backslash, and
 * % is written %%. Always quoted, so the deb's "/opt/Katacomb VPN/" stays one argument.
 */
function execLine(path: string): string {
  const quoted = path.replace(/["`$\\]/g, '\\$&').replace(/\\/g, '\\\\').replace(/%/g, '%%')
  return `Exec="${quoted}" --autostart`
}

function desktopEntry(path: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Katacomb VPN',
    'Comment=Decentralized VPN Client',
    execLine(path),
    'Icon=katacomb-vpn',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    // [PKG-2] Started at once, GNOME's login launches the app while its settings daemon is
    // still starting, so GTK loads the modules ~/.config/gtk-3.0/settings.ini lists, then
    // unloads them when the daemon's list replaces that one. Plasma writes its own two there,
    // and one leaves a signal handler behind: the next GDK notify jumps into unmapped code
    // (SIGSEGV in 3 of 6 GNOME logins on an account that had used Plasma, 2026-10-16).
    'X-GNOME-Autostart-Delay=5',
    '',
  ].join('\n')
}

/** The keys of the entry's [Desktop Entry] group, or null when there is no entry. */
function readEntry(): Map<string, string> | null {
  let text: string
  try {
    text = readFileSync(entryPath(), 'utf-8')
  } catch {
    return null
  }
  const keys = new Map<string, string>()
  let inMain = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]'
      continue
    }
    const eq = line.indexOf('=')
    if (inMain && eq > 0 && !line.startsWith('#')) keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return keys
}

/** Desktops switch an entry off without deleting it: Xfce's Session and Startup writes Hidden=true. */
function isEnabled(keys: Map<string, string> | null): keys is Map<string, string> {
  return keys !== null && keys.get('Hidden') !== 'true' && keys.get('X-GNOME-Autostart-enabled') !== 'false'
}

export function autostartState(): AutostartState {
  return { available: command() !== null, enabled: isEnabled(readEntry()) }
}

export function setAutostart(enabled: boolean): AutostartState {
  const path = command()
  if (path === null) throw new Error('Start at login is only available in the installed app')
  const file = entryPath()
  if (enabled) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileAtomic(file, desktopEntry(path))
  } else if (existsSync(file)) {
    unlinkSync(file)
  }
  return autostartState()
}

/**
 * [PKG-2] Run at each launch: an enabled entry that starts some other copy is moved onto this
 * one. An AppImage's file name carries its version, so without this every update would leave
 * the entry starting a file that is gone. Only Exec is compared, so the user's own edits to
 * the entry survive. Best-effort: the toggle still shows the entry as it is.
 */
export function followRunningCopy(): void {
  const path = command()
  if (path === null) return
  try {
    const keys = readEntry()
    if (isEnabled(keys) && `Exec=${keys.get('Exec')}` !== execLine(path)) writeFileAtomic(entryPath(), desktopEntry(path))
  } catch { /* best-effort */ }
}
