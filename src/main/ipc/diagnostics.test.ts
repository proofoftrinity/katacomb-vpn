import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from '../../../test/harness/module.ts'
import { IPC } from '../../shared/ipc-channels.ts'

// The read-only diagnostics handlers. The batch probe ("Test nodes") used to reject the
// whole batch when one row's directory URL failed the http(s) guard, and the renderer
// had already marked every row as testing, so each one stayed on "…" with no result
// coming. probeNode refuses an unsafe URL per row instead.

const dg = await loadModule({
  entries: ['src/main/ipc/diagnostics.ts'],
  fake: ['src/main/nodes/node-tester', 'src/main/chain/rpc-monitor', 'src/main/vpn/vpn-manager', 'src/main/net-fetch'],
})

type Listener = (event: unknown, ...args: unknown[]) => unknown

test('a batch with one unsafe node URL still goes to the prober whole, so no row is left without a result', async (t) => {
  const h = dg.fresh({ 'nodes/node-tester': { startBatch: () => undefined } })
  t.after(() => h.dispose())
  const handlers = new Map<string, Listener>()
  ;(h.mod.registerDiagnosticsHandlers as (handle: (channel: string, fn: Listener) => void) => void)(
    (channel, fn) => { handlers.set(channel, fn) },
  )
  const rows = [
    { nodeAddress: 'sentnode1good', remoteUrl: '203.0.113.7:21003' },
    { nodeAddress: 'sentnode1bad', remoteUrl: 'ftp://203.0.113.8/' },
    { nodeAddress: 'sentnode1blank', remoteUrl: '' },
  ]
  await handlers.get(IPC.NODE_TEST_BATCH)!({}, rows)
  const started = h.world.calls('nodes/node-tester', 'startBatch')
  assert.equal(started.length, 1)
  assert.deepEqual(started[0].args[0], rows)
})
