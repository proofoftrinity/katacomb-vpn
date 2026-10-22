import { world } from './world.ts'

// Stands in for `dns/promises` inside a test bundle (BundleSpec.stubs): every lookup is
// recorded and answered by the test's fakes['dns'].lookup, or refused. No test reaches
// a real resolver.
export function lookup(...args: unknown[]): Promise<{ address: string; family: number }> {
  return Promise.resolve(world().call('dns', 'lookup', args) as { address: string; family: number })
}
