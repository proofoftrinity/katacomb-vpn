import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'

// The state a bundled module sees in place of the machine: the files under a temp
// userData, what Electron would have recorded (handlers, sent events, notifications),
// and every call it made to a faked collaborator. Fakes and the electron stand-in
// read `globalThis.__kvWorld` at call time, so one bundle serves many fresh worlds.

// Fakes take whatever the real function takes; the test's own fake is checked
// against the real module's type where it is written (see FakesFor in ipc.ts).
export type FakeFn = (...args: any[]) => unknown
export type Fakes = Record<string, Record<string, FakeFn>>

export interface Call { mod: string; fn: string; args: unknown[]; seq: number }

export type IpcListener = (event: unknown, ...args: unknown[]) => unknown

export class World {
  readonly userData: string
  isDev = false
  fakes: Fakes = {}
  readonly log: Call[] = []
  readonly handlers = new Map<string, IpcListener>()
  readonly sent: Array<{ channel: string; args: unknown[] }> = []
  readonly notifications: Array<{ title?: string; body?: string }> = []
  readonly opened: string[] = []
  safeStorage = { available: true, backend: 'gnome_libsecret', keyId: 'this-install' }
  private seq = 0

  constructor(userData: string) {
    const real = resolve(userData)
    if (!real.startsWith(resolve(tmpdir()) + sep)) throw new Error(`test userData must live under ${tmpdir()}: ${real}`)
    this.userData = real
  }

  /** Every faked call lands here: recorded, then answered by the test's fake. */
  call(mod: string, fn: string, args: unknown[]): unknown {
    this.log.push({ mod, fn, args, seq: this.seq++ })
    const impl = this.fakes[mod]?.[fn]
    if (!impl) throw new Error(`unstubbed ${mod}.${fn}() - the test must fake it`)
    return impl(...args)
  }

  /** Calls to `mod` (optionally only `fn`), in order. */
  calls(mod: string, fn?: string | RegExp): Call[] {
    return this.log.filter((c) => c.mod === mod && (fn === undefined || (typeof fn === 'string' ? c.fn === fn : fn.test(c.fn))))
  }
}

declare global {
  var __kvWorld: World | undefined
}

export function world(): World {
  const w = globalThis.__kvWorld
  if (!w) throw new Error('no test world installed')
  return w
}
