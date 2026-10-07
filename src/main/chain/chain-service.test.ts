import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModule, type ModuleHarness } from '../../../test/harness/module.ts'
import type { Fakes } from '../../../test/harness/world.ts'

// chain-service turns a node's handshake reply into a tunnel config and keeps it for
// reconnects. Two rules live here (docs/invariants/node-trust.md): tunnel credentials
// are stored only under real keyring encryption [NT-2], and a reply that should be
// signed but is not is refused [NT-4]. The node's HTTP endpoint and the config
// builders are faked; what is saved, refused and asked for is real.

const cs = await loadModule({
  entries: ['src/main/chain/chain-service.ts'],
  fake: [
    'src/main/protocols/node-handshake', 'src/main/chain/authz-query', 'src/main/nodes/node-tester',
    'src/main/chain/chain-clients', 'src/main/chain/chain-events',
    'src/main/protocols/wireguard-config', 'src/main/protocols/xray-config', 'src/main/protocols/hysteria-config',
    'src/main/protocols/amneziawg-config', 'src/main/protocols/openvpn-config', 'src/main/protocols/v2ray-config',
    'src/main/protocols/multihop-config',
  ],
  allowPackages: ['@cosmjs/stargate', '@cosmjs/proto-signing', '@cosmjs/crypto', '@cosmjs/amino', '@cosmjs/encoding', 'long', '@sentinel-official/sentinel-js-sdk'],
  stubs: { '@sentinel-official/sentinel-js-sdk': 'test/harness/sentinel-sdk.ts' },
})

type Fn = (...a: unknown[]) => Promise<unknown>
const NODE = 'sentnode1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqwg'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')

/** A node that answers every handshake, unsigned unless `signature` is given. */
function node(signature?: string): Fakes {
  return {
    'protocols/node-handshake': {
      buildHandshakeBody: async (_id: string, peerRequest: unknown) => ({ data: b64(peerRequest) }),
      postHandshake: async () => ({ result: { data: b64({ assigned_addrs: ['10.8.0.2/32'], public_key: 'x' }), addrs: ['198.51.100.9'] }, signature }),
    },
    'chain/authz-query': { hasNodeStatusGrant: async () => false },
    'protocols/wireguard-config': { buildWireguardConfig: () => '[Interface]\nPrivateKey = secret-key\n' },
  }
}

const handshake = (h: ModuleHarness, nodeType: number, requireSigned: boolean, sessionId = '1001') =>
  (h.mod.performHandshake as Fn)({ sessionId, nodeAddress: NODE, nodeType, remoteUrl: 'https://198.51.100.9:8585', privKey: new Uint8Array(32).fill(1), requireSigned })
const sessionFile = (h: ModuleHarness, id: string) => join(h.world.userData, 'sessions', `session-${id}.json`)

describe('[NT-2] tunnel credentials are stored only under real keyring encryption', () => {
  test('[NT-2] with a keyring, the saved config is ciphertext, never the plain key', async (t) => {
    const h = cs.fresh(node())
    t.after(() => h.dispose())
    await handshake(h, 1, false)
    const raw = readFileSync(sessionFile(h, '1001'), 'utf-8')
    assert.ok(raw.startsWith(`enc:${h.world.safeStorage.keyId}:`), 'written through safeStorage')
    const back = (h.mod.loadSessionConfig as (id: string) => { configString: string })('1001')
    assert.match(back.configString, /secret-key/, 'and it reads back for a reconnect')
  })

  test('[NT-2] under the basic_text backend nothing is written: the connect works, only reconnect-after-restart is lost', async (t) => {
    const h = cs.fresh(node())
    t.after(() => h.dispose())
    h.world.safeStorage.backend = 'basic_text'
    const res = await handshake(h, 1, false) as { configString: string }
    assert.match(res.configString, /secret-key/)
    assert.equal(existsSync(sessionFile(h, '1001')), false)
  })

  test('a session saved in plaintext by an early release still loads for a reconnect', (t) => {
    const h = cs.fresh(node())
    t.after(() => h.dispose())
    mkdirSync(join(h.world.userData, 'sessions'), { recursive: true })
    writeFileSync(sessionFile(h, '5'), JSON.stringify({ sessionId: '5', protocol: 'wireguard', configString: 'cfg', nodeAddress: NODE }))
    assert.equal((h.mod.loadSessionConfig as (id: string) => { configString: string })('5').configString, 'cfg')
  })
})

describe('[NT-4] a reply that must be signed and is not is refused', () => {
  test('[NT-4] requireSigned and no signature: refused, and nothing saved for a reconnect', async (t) => {
    const h = cs.fresh(node())
    t.after(() => h.dispose())
    await assert.rejects(handshake(h, 1, true), /came unsigned/)
    assert.equal(existsSync(sessionFile(h, '1001')), false)
  })

  test('[NT-4] control: the same unsigned reply from a node not required to sign is accepted, as unsigned', async (t) => {
    const h = cs.fresh(node())
    t.after(() => h.dispose())
    const res = await handshake(h, 1, false) as { signer: string }
    assert.equal(res.signer, 'unsigned')
  })

  test('[NT-4] a signature header that does not verify is refused even when not required', async (t) => {
    const h = cs.fresh(node('not-a-signature'))
    t.after(() => h.dispose())
    await assert.rejects(handshake(h, 1, false))
  })
})

test('[PRO-4] each protocol sends the peer request its node parses: WG a key, XRAY a 16-byte uuid, hysteria2 a string uuid', async (t) => {
  const h = cs.fresh(node())
  t.after(() => h.dispose())
  for (const nodeType of [1, 4, 6]) await handshake(h, nodeType, false, String(1000 + nodeType)).catch(() => undefined)
  const sent = h.world.calls('protocols/node-handshake', 'buildHandshakeBody').map((c) => c.args[1] as Record<string, unknown>)
  assert.equal(sent.length, 3)
  assert.equal(typeof sent[0].public_key, 'string')
  assert.ok(Array.isArray(sent[1].uuid) && (sent[1].uuid as unknown[]).length === 16, 'xray reads uuid as [16]byte')
  assert.equal(typeof sent[2].uuid, 'string', 'hysteria2 reads uuid as a string (a byte array cost a live 500)')
})

describe('[MH-17] the exit hop is resolved over DoH, never through the ISP\'s resolver', () => {
  const spec = (host: string) => ({ protocol: 'v2ray', metadata: [], addrs: [host], uuid: 'u' })
  const finalize = (h: ModuleHarness) => (h.mod.finalizeChain as Fn)({
    entry: { sessionId: '3001', nodeAddress: NODE, nodeType: 2, remoteUrl: 'https://e', walletId: 'w1' },
    exit: { sessionId: '3002', nodeAddress: NODE, nodeType: 2, remoteUrl: 'https://x', walletId: 'w2' },
    entrySpec: spec('entry.example.net'),
    exitSpec: spec('exit.example.net'),
  })
  const doh = (fetch: (url: string) => Promise<unknown>): Fakes => ({
    ...node(),
    electron: { 'net.fetch': fetch },
    'protocols/multihop-config': { buildMultihopConfig: () => ({ built: true }) },
  })

  test('[MH-17] the exit\'s address is looked up over DoH; the entry\'s is left for the direct dial', async (t) => {
    const h = cs.fresh(doh(async () => ({ ok: true, json: async () => ({ Answer: [{ type: 1, data: '198.51.100.77' }] }) })))
    t.after(() => h.dispose())
    await finalize(h)
    const lookups = h.world.calls('electron', 'net.fetch').map((c) => String(c.args[0]))
    assert.equal(lookups.length, 1)
    assert.match(lookups[0], /^https:\/\/.*name=exit\.example\.net&type=A$/)
    const [entrySpec, exitSpec] = h.world.calls('protocols/multihop-config', 'buildMultihopConfig')[0].args as Array<{ addrs: string[] }>
    assert.deepEqual(exitSpec.addrs, ['198.51.100.77'])
    assert.deepEqual(entrySpec.addrs, ['entry.example.net'])
  })

  test('[MH-17] a DoH failure leaves the hostname for the existing pin, never fails the paid chain', async (t) => {
    const h = cs.fresh(doh(async () => { throw new Error('offline') }))
    t.after(() => h.dispose())
    await finalize(h)
    const [, exitSpec] = h.world.calls('protocols/multihop-config', 'buildMultihopConfig')[0].args as Array<{ addrs: string[] }>
    assert.deepEqual(exitSpec.addrs, ['exit.example.net'])
  })

  test('[MH-18] both hops are saved as a pair, each with its own payer and the node\'s protocol', async (t) => {
    const h = cs.fresh(doh(async () => ({ ok: false })))
    t.after(() => h.dispose())
    await finalize(h)
    const load = h.mod.loadSessionConfig as (id: string) => Record<string, unknown>
    assert.deepEqual([load('3001').chainRole, load('3001').chainPeerSessionId, load('3001').walletId, load('3001').nodeType], ['entry', '3002', 'w1', 2])
    assert.deepEqual([load('3002').chainRole, load('3002').chainPeerSessionId, load('3002').walletId], ['exit', '3001', 'w2'])
  })
})

// A connect flow hands its one RPC connection to the purchase [REL-12], and the
// purchase bounds how late its tx can land with a timeoutHeight [REL-5]. Faked at the
// client: the tx is real msg-building, signing is the fake's, and the reply carries no
// session event, so the purchase fails AFTER broadcasting - the path where a wrongly
// placed disconnect would close the caller's connection under it.
test('[REL-5] [REL-12] subscribeToNode bounds its tx with a timeoutHeight and never closes the flow it was handed', async (t) => {
  const h = cs.fresh({ ...node(), 'chain/chain-events': { searchEvent: () => undefined } })
  t.after(() => h.dispose())
  const closed: string[] = []
  const broadcasts: unknown[][] = []
  const query = {
    sentinelQuery: { node: { node: async () => ({ address: NODE, gigabytePrices: [{ denom: 'udvpn', baseValue: '1', quoteValue: '5000000' }], hourlyPrices: [], remoteAddrs: ['https://198.51.100.9:8585'] }) } },
    disconnect: () => { closed.push('query') },
  }
  const signing = {
    getHeight: async () => 31_895_796,
    signAndBroadcast: async (...args: unknown[]) => { broadcasts.push(args); return { code: 0, events: [], height: 31_895_797, transactionHash: 'AB', gasUsed: 1n, gasWanted: 1n } },
    disconnect: () => { closed.push('signing') },
  }
  await assert.rejects((h.mod.subscribeToNode as Fn)({
    wallet: {}, address: 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', nodeAddress: NODE, apiField: '',
    type: 'gigabytes', amount: 1, denom: 'udvpn', clients: { query, signing },
  }), /session creation event/)
  assert.equal(broadcasts.length, 1)
  assert.equal(broadcasts[0][4], BigInt(31_895_796 + 30), 'the chain rejects it past ~30 blocks rather than confirming it after we stopped polling')
  assert.deepEqual(closed, [], 'the handler that opened the flow closes it, in its finally')
})

describe('[MH-9] ending a chain hop leaves a tombstone: credentials cleared, pairing kept', () => {
  const pair = async (h: ModuleHarness) => {
    await (h.mod.finalizeChain as Fn)({
      entry: { sessionId: '3001', nodeAddress: NODE, nodeType: 2, remoteUrl: 'https://e', walletId: 'w1' },
      exit: { sessionId: '3002', nodeAddress: NODE, nodeType: 2, remoteUrl: 'https://x', walletId: 'w2' },
      entrySpec: { protocol: 'v2ray', metadata: [], addrs: ['198.51.100.10'], uuid: 'u' },
      exitSpec: { protocol: 'v2ray', metadata: [], addrs: ['198.51.100.20'], uuid: 'u' },
    })
  }
  /** The chain answers the cancel with `code`; the cancel is otherwise real (msg, signer, address). */
  const chainAnswering = (code: number, rawLog = ''): Fakes => ({
    ...node(),
    electron: { 'net.fetch': async () => ({ ok: false }) },
    'protocols/multihop-config': { buildMultihopConfig: () => ({ built: true }) },
    'chain/chain-clients': { resolveRpcBase: async (u: string) => u },
    sdk: { connectWithSigner: async () => ({ signAndBroadcast: async () => ({ code, rawLog, events: [] }), disconnect: () => undefined }) },
  })
  const end = (h: ModuleHarness, sessionId: string) => (h.mod.endSession as Fn)({ wallet: {}, address: 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', sessionId })
  const load = (h: ModuleHarness, id: string) => (h.mod.loadSessionConfig as (id: string) => Record<string, unknown> | null)(id)

  test('[MH-9] after the cancel lands, the hop\'s record keeps its pairing and loses its credentials', async (t) => {
    const h = cs.fresh(chainAnswering(0))
    t.after(() => h.dispose())
    await pair(h)
    await end(h, '3002')
    const tomb = load(h, '3002')
    assert.deepEqual([tomb?.configString, tomb?.chainPeerSessionId, tomb?.chainRole], ['', '3001', 'exit'], 'grouped with its entry until both settle')
    assert.notEqual(load(h, '3001')?.configString, '', 'the hop still open keeps its own')
  })

  test('[MH-9] a single-hop session\'s record is deleted outright: nothing to group it with', async (t) => {
    const h = cs.fresh(chainAnswering(0))
    t.after(() => h.dispose())
    await handshake(h, 1, false, '1001')
    await end(h, '1001')
    assert.equal(existsSync(sessionFile(h, '1001')), false)
  })

  test('[MH-9] [NT-2] with no keyring a tombstone cannot be written, so the credentials are deleted rather than left', async (t) => {
    const h = cs.fresh(chainAnswering(0))
    t.after(() => h.dispose())
    await pair(h)
    h.world.safeStorage.backend = 'basic_text'
    await end(h, '3002')
    assert.equal(existsSync(sessionFile(h, '3002')), false)
  })

  test('[MH-9] a cancel the chain refuses retires nothing: the hop is still paid for and reconnectable', async (t) => {
    const h = cs.fresh(chainAnswering(5, 'insufficient fees'))
    t.after(() => h.dispose())
    await pair(h)
    await assert.rejects(end(h, '3002'))
    assert.notEqual(load(h, '3002')?.configString, '')
  })
})
