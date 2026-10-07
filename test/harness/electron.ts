import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { world, type IpcListener } from './world.ts'

// Stands in for `electron` inside a test bundle (see bundle.ts). Only what main
// actually touches; anything else is missing on purpose, so a new use shows up as a
// build error rather than a silent no-op.

export const app = {
  isPackaged: false,
  getPath(name: string): string {
    const w = world()
    const path = name === 'userData' ? w.userData : join(w.userData, `.${name}`)
    // A test must never reach the real profile (wallet seeds live there).
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw new Error(`app.getPath(${name}) escaped the temp dir`)
    return path
  },
  getVersion: (): string => '0.0.0-test',
}

export const ipcMain = {
  handle(channel: string, listener: IpcListener): void {
    const w = world()
    // Electron throws on a second handler for one channel; so does this.
    if (w.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
    w.handlers.set(channel, listener)
  },
}

const webContents = {
  send(channel: string, ...args: unknown[]): void { world().sent.push({ channel, args }) },
}

export class BrowserWindow {
  static getAllWindows(): Array<{ webContents: typeof webContents }> { return [{ webContents }] }
}

export class Notification {
  private readonly opts: { title?: string; body?: string }
  constructor(opts: { title?: string; body?: string }) { this.opts = opts }
  static isSupported(): boolean { return true }
  show(): void { world().notifications.push(this.opts) }
}

export const net = {
  fetch(...args: unknown[]): unknown { return world().call('electron', 'net.fetch', args) },
}

export const shell = {
  openExternal(url: string): Promise<void> { world().opened.push(url); return Promise.resolve() },
}

// Reversible "encryption" tagged with the install it came from, so a test can
// model the post-rename case: ciphertext from another key that will not decrypt.
export const safeStorage = {
  isEncryptionAvailable: (): boolean => world().safeStorage.available,
  getSelectedStorageBackend: (): string => world().safeStorage.backend,
  encryptString(text: string): Buffer {
    return Buffer.from(`enc:${world().safeStorage.keyId}:${text}`)
  },
  decryptString(data: Buffer): string {
    const prefix = `enc:${world().safeStorage.keyId}:`
    const s = data.toString()
    if (!s.startsWith(prefix)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
    return s.slice(prefix.length)
  },
}
