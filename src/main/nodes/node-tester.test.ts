import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadModule } from '../../../test/harness/module.ts'

// [REL-5] A node probe is bound by ONE deadline across DNS, connect, TLS and body. It
// used to be `req.setTimeout`, a socket INACTIVITY timer: a node that keeps the
// socket busy without ever finishing (or never connects at all) hung far past the
// budget - measured at >120 s against 8 s - and stalled a whole probe sweep.

const nt = await loadModule({ entries: ['src/main/nodes/node-tester.ts'], fake: [], allowPackages: ['@cosmjs/crypto', '@cosmjs/amino', '@cosmjs/encoding'] })

type Probe = (url: string, address: string) => Promise<{ reachable: boolean; error?: string }>

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}
const realWait = (ms: number) => new Promise<void>((r) => { const i = setInterval(() => { clearInterval(i); r() }, ms) })

test('[REL-5] a node that drips its reply forever is given up on at the deadline, not kept alive by the drip', { timeout: 5_000 }, async (t) => {
  const drips: NodeJS.Timeout[] = []
  const { url, server } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    drips.push(setInterval(() => res.write(' '), 20)) // busy socket, never an end
  })
  t.after(() => { drips.forEach(clearInterval); server.closeAllConnections(); server.close() })
  const h = nt.fresh({})
  t.after(() => h.dispose())
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  const probe = (h.mod.probeNode as Probe)(url, 'sentnode1drip')
  await realWait(200) // connected, headers in, the body dripping
  mock.timers.tick(8_000)
  const res = await probe
  assert.deepEqual([res.reachable, res.error], [false, 'Timeout'])
})

test('[REL-5] control: a node that answers is reachable', async (t) => {
  const { url, server } = await serve((_req, res) => { res.end('{"success":true}') })
  t.after(() => server.close())
  const h = nt.fresh({})
  t.after(() => h.dispose())
  assert.equal((await (h.mod.probeNode as Probe)(url, 'sentnode1ok')).reachable, true)
})
