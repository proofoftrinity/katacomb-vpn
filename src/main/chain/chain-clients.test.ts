import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join } from 'node:path'
import { loadModule } from '../../../test/harness/module.ts'

// [REL-12] The connect flow's speed path: the default endpoint 307-redirects EVERY
// request, so resolveRpcBase follows it once per launch and talks to the target
// directly. Fail-open, https only, never persisted (the setting keeps the official
// name). fetch is the global the module calls; each test answers it.

const cc = await loadModule({
  entries: ['src/main/chain/chain-clients.ts'],
  fake: [],
  allowPackages: ['@cosmjs/stargate', '@cosmjs/proto-signing', '@cosmjs/tendermint-rpc', '@cosmjs/json-rpc', '@cosmjs/crypto', '@cosmjs/amino', '@cosmjs/encoding', 'long', '@sentinel-official/sentinel-js-sdk'],
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

// [REL-46] After Extend moves the tunnel, the End and the session read go on sockets of
// their own: a socket pooled through the old WireGuard peer hangs with nothing to say so.
// A local RPC counts the calls each socket carried; the default client is the control.

/** A real /status reply (sentinelhub-2, 2026-11-04): what the version detection reads. */
const STATUS = {
  node_info: {
    protocol_version: { p2p: '8', block: '11', app: '0' }, id: 'ea806467d26331049e0768986ea8e2fa0ff6231b',
    listen_addr: 'tcp://0.0.0.0:21056', network: 'sentinelhub-2', version: '0.37.16', channels: '40202122233038606100',
    moniker: 'Busurnode', other: { tx_index: 'on', rpc_address: 'tcp://0.0.0.0:21057' },
  },
  sync_info: {
    latest_block_hash: '0C3F795D439429BA14C50FC79D710BDD296D5EDB69CAA9F35394F59FA5F46384',
    latest_app_hash: 'E51D3042607A2715E446D7A8279CDC5278FE2DCA4D2999E14A560C8E84E15700',
    latest_block_height: '32560093', latest_block_time: '2026-11-04T04:53:15.146353285Z',
    earliest_block_hash: '11E60037E22F6ABDF29DE851063E4C0E0A34E4D3D067EDA55B1674A0257E7D03',
    earliest_app_hash: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
    earliest_block_height: '901801', earliest_block_time: '2021-05-29T14:30:00Z', catching_up: false,
  },
  validator_info: {
    address: '70DF4E597036391A7FA888BF0CE17247D3A7C6BA',
    pub_key: { type: 'tendermint/PubKeyEd25519', value: 'fYUh1hEHlXM85DrkOJJ5zt7RyBK7FGn3tL3DSOeWJFc=' }, voting_power: '0',
  },
}

type Answer = (path: string, call: { id: unknown; method: string }, res: ServerResponse) => void
type OpenFlow = (wallet: unknown, options?: { freshSockets?: boolean }) => Promise<{ query: { getHeight(): Promise<number> }; disconnect(): void }>
const status: Answer = (_path, call, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: STATUS }))

/** A local RPC answering every call with `answer`, and the calls each socket carried. */
async function rpcServer(t: TestContext, answer: Answer): Promise<{ url: string; callsPerSocket: () => number[] }> {
  const perSocket = new Map<Socket, number>()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => {
      // resolveRpcBase's probe: no redirect, so the endpoint is used as configured.
      if (req.method !== 'POST') { res.end('{}'); return }
      perSocket.set(req.socket, (perSocket.get(req.socket) ?? 0) + 1)
      answer(req.url ?? '/', JSON.parse(body) as { id: unknown; method: string }, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, callsPerSocket: () => [...perSocket.values()] }
}

async function flowAgainst(t: TestContext, endpoint: string, options?: { freshSockets?: boolean }) {
  const h = cc.fresh({})
  t.after(() => h.dispose())
  writeFileSync(join(h.world.userData, 'settings.json'), JSON.stringify({ rpcEndpoint: endpoint }))
  const flow = await (h.mod.openChainFlow as OpenFlow)({}, options)
  t.after(() => flow.disconnect())
  return flow
}

test('[REL-46] freshSockets: every call to the chain goes on a socket of its own', async (t) => {
  const rpc = await rpcServer(t, status)
  const flow = await flowAgainst(t, rpc.url, { freshSockets: true })
  for (let i = 0; i < 3; i++) assert.equal(await flow.query.getHeight(), 32560093)
  assert.deepEqual(rpc.callsPerSocket(), [1, 1, 1, 1], 'the version check and three reads, one socket each')
})

test('[REL-46] control: the default client reuses a pooled socket, which is what can hang after a switch', async (t) => {
  const rpc = await rpcServer(t, status)
  const flow = await flowAgainst(t, rpc.url)
  for (let i = 0; i < 3; i++) await flow.query.getHeight()
  assert.ok(rpc.callsPerSocket().some((n) => n > 1), `calls per socket: ${rpc.callsPerSocket().join(', ')}`)
})

test('[REL-46] freshSockets follows a 307 as fetch does: the default endpoint redirects every call', async (t) => {
  const rpc = await rpcServer(t, (path, call, res) => {
    if (path === '/old') { res.writeHead(307, { location: '/new' }); res.end(); return }
    status(path, call, res)
  })
  const flow = await flowAgainst(t, `${rpc.url}/old`, { freshSockets: true })
  assert.equal(await flow.query.getHeight(), 32560093)
})

for (const [name, fail] of [
  ['a JSON-RPC error', (call: { id: unknown }, res: ServerResponse) =>
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'Internal error', data: 'tx already exists in cache' } }))],
  ['a 503', (_call: { id: unknown }, res: ServerResponse) => { res.writeHead(503); res.end('busy') }],
] as const) {
  test(`[REL-46] freshSockets: ${name} reads as the default client words it, which the End's callers match on`, async (t) => {
    let calls = 0
    // The first call of each client is its version check, answered; the read after it fails.
    const rpc = await rpcServer(t, (path, call, res) => (calls++ % 2 === 0 ? status(path, call, res) : fail(call, res)))
    const messages: string[] = []
    for (const options of [undefined, { freshSockets: true }]) {
      const flow = await flowAgainst(t, rpc.url, options)
      messages.push(await flow.query.getHeight().then(() => 'answered', (err: Error) => err.message))
    }
    assert.notEqual(messages[0], 'answered')
    assert.equal(messages[1], messages[0])
  })
}
