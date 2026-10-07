import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { loadIpcHandlers } from '../../test/harness/ipc.ts'
import { SPEND, PURCHASE_CALLS, BRING_UP_CALLS, ACTIVE_WALLET_CALLS } from '../../test/harness/entry-points.ts'
import { REQUEST, worldFor } from '../../test/harness/requests.ts'
import { IPC } from '../shared/ipc-channels.ts'

// The IPC boundary: every handler registered through the one trusted door refuses a
// frame that is not our renderer, and refuses malformed input before it can spend,
// run anything as root, bring a tunnel up or touch the wallet.

const ipc = await loadIpcHandlers()

const DANGEROUS = new Set([...PURCHASE_CALLS, ...BRING_UP_CALLS, ...ACTIVE_WALLET_CALLS, 'endSession', 'runPrivileged', 'cancelSubscription'])
const dangerous = (h: ReturnType<typeof ipc.fresh>) => h.world.log.filter((c) => DANGEROUS.has(c.fn)).map((c) => `${c.mod}.${c.fn}`)

test('[ARCH-2] a frame that is not our renderer is refused on every channel, before the handler runs', async (t) => {
  const h = ipc.fresh({})
  t.after(() => h.dispose())
  const channels = [...h.world.handlers.keys()]
  assert.ok(channels.length > 40, `only ${channels.length} handlers registered`)
  const before = h.world.log.length
  const byValue = Object.fromEntries(Object.entries(IPC).map(([k, v]) => [v, k])) as Record<string, keyof typeof IPC>
  for (const channel of channels) {
    const err = await h.settleError(h.invokeUntrusted(byValue[channel], REQUEST.CONNECTION_SUBSCRIBE))
    assert.match(err.message, /untrusted sender/, channel)
  }
  assert.deepEqual(h.world.log.slice(before), [], 'nothing behind the door ran')
})

test('[ARCH-2] the handler groups are registered through the same trusted door', async (t) => {
  const h = ipc.fresh({})
  t.after(() => h.dispose())
  for (const group of ['registerDiagnosticsHandlers', 'registerSetupHandlers', 'registerProviderHandlers']) {
    const call = h.world.log.find((c) => c.fn === group)
    assert.ok(call, `${group} was not called`)
    const handle = call.args[0] as (ch: string, fn: () => string) => void
    handle('test:probe', () => 'ran')
    const listener = h.world.handlers.get('test:probe')!
    assert.throws(() => listener({ senderFrame: { url: 'https://attacker.example/' }, sender: { getURL: () => '' } }), /untrusted sender/)
    assert.equal(listener({ senderFrame: { url: 'file:///app/index.html' }, sender: { getURL: () => '' } }), 'ran')
    h.world.handlers.delete('test:probe')
  }
})

describe('malformed input is refused before anything dangerous runs', () => {
  /** Corrupt `field` where the request has it (also inside a chain's hops); null when it has none. */
  const corrupt = (r: Record<string, unknown>, field: string, bad: unknown): Record<string, unknown> | null => {
    let hit = false
    const walk = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => {
      if (k === field) { hit = true; return [k, bad] }
      return [k, v && typeof v === 'object' ? walk(v as Record<string, unknown>) : v]
    }))
    const out = walk(r)
    return hit ? out : null
  }
  const GARBAGE: Array<[string, string, unknown]> = [
    ['a node address that is not one', 'nodeAddress', 'cosmos1evil'],
    ['a quote that is not a number', 'quoteValue', '1; rm -rf /'],
    ['a denom that is not a string', 'denom', 42],
    ['a plan id that is not numeric', 'planId', '../../etc'],
    ['a subscription id that is not numeric', 'subscriptionId', '1 OR 1=1'],
    ['an absurd amount', 'amount', 1e12],
    ['an unknown purchase type', 'type', 'forever'],
    ['an api field that is not a string', 'apiField', { href: 'file:///etc/passwd' }],
  ]
  for (const key of SPEND) {
    for (const req of [undefined, {}]) {
      test(`${key}: ${req === undefined ? 'no params at all' : 'an empty object'}`, async (t) => {
        const h = ipc.fresh(worldFor(key))
        t.after(() => h.dispose())
        await h.settleError(h.invoke(key, req))
        assert.deepEqual(dangerous(h), [])
      })
    }
    for (const [name, field, bad] of GARBAGE) {
      const req = corrupt(REQUEST[key], field, bad)
      if (!req) continue
      test(`${key}: ${name}`, async (t) => {
        const h = ipc.fresh(worldFor(key))
        t.after(() => h.dispose())
        await h.settleError(h.invoke(key, req))
        assert.deepEqual(dangerous(h), [])
      })
    }
  }
})
