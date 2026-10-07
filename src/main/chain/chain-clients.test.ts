import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadModule } from '../../../test/harness/module.ts'

// [REL-12] The connect flow's speed path: the default endpoint 307-redirects EVERY
// request, so resolveRpcBase follows it once per launch and talks to the target
// directly. Fail-open, https only, never persisted (the setting keeps the official
// name). fetch is the global the module calls; each test answers it.

const cc = await loadModule({
  entries: ['src/main/chain/chain-clients.ts'],
  fake: [],
  allowPackages: ['@cosmjs/stargate', '@cosmjs/proto-signing', '@cosmjs/tendermint-rpc', '@cosmjs/crypto', '@cosmjs/amino', '@cosmjs/encoding', 'long', '@sentinel-official/sentinel-js-sdk'],
})

const RPC = 'https://rpc.sentinel.co:443'
type Resolve = (endpoint: string) => Promise<string>

function answering(reply: () => Promise<Response>): { probes: string[]; restore: () => void } {
  const real = globalThis.fetch
  const probes: string[] = []
  globalThis.fetch = (async (url: string) => { probes.push(String(url)); return reply() }) as typeof fetch
  return { probes, restore: () => { globalThis.fetch = real } }
}
const redirect = (status: number, location: string) => async () => new Response(null, { status, headers: { location } })

test('[REL-12] a 307 to another https host is followed once per launch, and never written to settings', async (t) => {
  const net = answering(redirect(307, 'https://rpc-target.example/'))
  t.after(net.restore)
  const h = cc.fresh({})
  t.after(() => h.dispose())
  const resolve = h.mod.resolveRpcBase as Resolve
  assert.equal(await resolve(RPC), 'https://rpc-target.example')
  assert.equal(await resolve(RPC), 'https://rpc-target.example')
  assert.deepEqual(net.probes, [RPC], 'probed once, then remembered for the launch')
  assert.equal(existsSync(join(h.world.userData, 'settings.json')), false, 'a runtime detail, never persisted')
})

for (const [name, reply] of [
  ['a probe that fails', async () => { throw new Error('offline') }],
  ['a redirect down to plain http', redirect(308, 'http://rpc-target.example/')],
  ['a redirect to the same origin', redirect(307, 'https://rpc.sentinel.co:443/other')],
  ['no redirect at all', async () => new Response('{}', { status: 200 })],
] as const) {
  test(`[REL-12] ${name}: the endpoint is used as configured (fail-open)`, async (t) => {
    const net = answering(reply as () => Promise<Response>)
    t.after(net.restore)
    const h = cc.fresh({})
    t.after(() => h.dispose())
    assert.equal(await (h.mod.resolveRpcBase as Resolve)(RPC), RPC)
  })
}
