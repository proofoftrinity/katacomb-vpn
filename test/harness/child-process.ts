import { world } from './world.ts'

// Stands in for `child_process` inside a test bundle (BundleSpec.stubs): every call is
// recorded and answered by the test's fakes['child_process'][fn], or refused.
const call = (fn: string, args: unknown[]): any => world().call('child_process', fn, args)

export function execSync(...args: unknown[]): any { return call('execSync', args) }
export function execFileSync(...args: unknown[]): any { return call('execFileSync', args) }
export function execFile(...args: unknown[]): any { return call('execFile', args) }
export function spawn(...args: unknown[]): any { return call('spawn', args) }
