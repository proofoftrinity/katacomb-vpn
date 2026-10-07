import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundle } from '../../../test/harness/bundle.ts'
import { read } from '../../../test/harness/source.ts'

// The app reads three answers from the daemon: its op list (the "your privileged
// service is out of date" refusal BEFORE paying), the IPsec policy count, and the
// WireGuard handshake age (the dead-peer detector). The shapes are pinned in the
// shared corpus, which the Go side marshals its real producers against. Here the
// REAL daemon-client reads them off a socket this test serves: the corpus shapes
// read as values, and anything malformed reads as "cannot know" - never as a
// refusal, which would block a connect over a daemon we simply cannot read.

const corpus = JSON.parse(read('daemon/internal/protocol/testdata/corpus/protocol.json')) as {
  results: Record<string, Record<string, unknown>>
}

const sock = join(mkdtempSync(join(tmpdir(), 'kv-daemon-')), 'd.sock')
process.env.KV_DAEMON_SOCKET = sock
const dc = (await bundle({
  entries: ['src/main/helper/daemon-client.ts'],
  fake: [],
  stubs: { 'src/main/helper/daemon-protocol': 'test/harness/daemon-protocol-at.ts' },
})).load() as Record<string, (...a: unknown[]) => Promise<unknown>>

type Answer = { ok: boolean; result?: unknown; error?: string }
let answer: (op: string) => Answer = () => ({ ok: false, error: 'unset' })
const lines: string[] = []
const server = createServer((conn) => {
  conn.setEncoding('utf-8')
  let buf = ''
  conn.on('data', (chunk: string) => {
    buf += chunk
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl)
    lines.push(buf.slice(0, nl + 1))
    const req = JSON.parse(line) as { id: number; op: string }
    conn.write(JSON.stringify({ id: req.id, ...answer(req.op) }) + '\n')
  })
})
await new Promise<void>((r) => server.listen(sock, r))
after(() => server.close())

const replyWith = (results: Record<string, unknown>) => {
  answer = (op) => (op in results ? { ok: true, result: results[op] } : { ok: false, error: `unknown op: ${op}` })
}

test('[PH-2] the corpus result shapes read as values', async () => {
  replyWith(corpus.results)
  assert.deepEqual(await dc.daemonCapabilities(), corpus.results.protocol_version)
  assert.equal(await dc.daemonMissingOp('status'), false)
  assert.equal(await dc.daemonMissingOp('openvpn_up'), true, 'a daemon that lists its ops and lacks one is refused before paying')
  assert.equal(await dc.daemonXfrmPolicyCount(), corpus.results.xfrm_policies.count)
  assert.equal(await dc.daemonWireguardHandshakeAge(), corpus.results.wireguard_handshake.ageSeconds)
})

const MALFORMED: Array<[string, Record<string, unknown>]> = [
  ['a version that is not a number', { protocol_version: { version: '1', ops: ['status'] } }],
  ['an op list that is not a list', { protocol_version: { version: 1, ops: 'everything' } }],
  ['a daemon older than the op list', { protocol_version: { version: 1 } }],
  ['a daemon older than protocol_version itself', {}],
  ['a count that is not a number', { xfrm_policies: { count: '2' } }],
  ['a userspace device (kernel: false)', { wireguard_handshake: { kernel: false, ageSeconds: 5 } }],
  ['a peer that never handshaked (-1)', { wireguard_handshake: { kernel: true, ageSeconds: -1 } }],
  ['an age that is missing', { wireguard_handshake: { kernel: true } }],
]
for (const [name, results] of MALFORMED) {
  test(`[PH-2] ${name} reads as "cannot know", never as a refusal`, async () => {
    replyWith(results)
    assert.equal(await dc.daemonMissingOp('openvpn_up'), false)
    if ('xfrm_policies' in results) assert.equal(await dc.daemonXfrmPolicyCount(), null)
    if ('wireguard_handshake' in results) assert.equal(await dc.daemonWireguardHandshakeAge(), null)
  })
}

test('the client writes one request per line, exactly the JSON the Go parser is pinned to', async () => {
  replyWith({ dns_set: null })
  lines.length = 0
  await dc.daemonRequest('dns_set', { dnsIp: '1.1.1.1' })
  assert.equal(lines.length, 1)
  const [line] = lines
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'newline-framed, one line')
  const req = JSON.parse(line) as { id: number; op: string; args: unknown }
  assert.ok(Number.isInteger(req.id))
  assert.equal(line, JSON.stringify({ id: req.id, op: 'dns_set', args: { dnsIp: '1.1.1.1' } }) + '\n')
})

test('[PH-2] with no daemon at all, every reader abstains', async () => {
  await new Promise<void>((r) => server.close(() => r()))
  assert.equal(await dc.daemonCapabilities(), null)
  assert.equal(await dc.daemonMissingOp('openvpn_up'), false)
  assert.equal(await dc.daemonXfrmPolicyCount(), null)
  assert.equal(await dc.daemonWireguardHandshakeAge(), null)
})
