import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundle, type BundleSpec } from './bundle.ts'
import { World, type Fakes } from './world.ts'

// One main-process module on its own, for the modules whose rules live inside them
// (vpn-manager's sinks, kill-switch's marker). Same bundling and the same fakes as
// the ipc-handlers harness, without the IPC layer.

export interface ModuleHarness {
  mod: Record<string, (...args: never[]) => unknown>
  world: World
  dispose(): void
}

export async function loadModule(spec: BundleSpec): Promise<{ fresh: (fakes?: Fakes) => ModuleHarness }> {
  const b = await bundle(spec)
  return {
    fresh(fakes: Fakes = {}): ModuleHarness {
      const userData = mkdtempSync(join(tmpdir(), 'kv-userdata-'))
      const w = new World(userData)
      w.fakes = fakes
      globalThis.__kvWorld = w
      const mod = b.load() as ModuleHarness['mod']
      return {
        mod,
        world: w,
        dispose() {
          globalThis.__kvWorld = undefined
          rmSync(userData, { recursive: true, force: true })
        },
      }
    },
  }
}
