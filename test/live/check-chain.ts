// `npm run check:chain [address…]`: re-checks against live mainnet the chain facts the
// manual rules SL-2, SL-3 and SL-4 rest on. Read-only (queries, no transaction) and
// never part of `npm run verify`: it needs the network, and what it sees depends on
// which sessions the accounts hold right now. With no address it reads the app's own
// wallets. RPC=<url> picks the endpoint. Exit 0 when nothing failed (a NOT SEEN line
// means the accounts held no session that could show that fact), 1 when a fact
// failed, 2 when the chain could not be read.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate'
import { connectComet } from '@cosmjs/tendermint-rpc'
import Long from 'long'
import { QueryServiceClientImpl } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/session/v3/querier.js'
import { Session as NodeSession } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/node/v3/session.js'
import { Session as SubSession } from '@sentinel-official/sentinel-js-sdk/dist/protobuf/sentinel/subscription/v3/session.js'
import { judge, type ChainRead, type Row } from './chain-facts.ts'

const RPC = process.env.RPC ?? 'https://rpc.sentinel.co:443'
const WALLETS = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'katacomb-vpn', 'wallets-index.json')

function accounts(): string[] {
  const given = process.argv.slice(2)
  if (given.length) return given
  const index = JSON.parse(readFileSync(WALLETS, 'utf-8')) as { address: string }[]
  return [...new Set(index.map((w) => w.address))]
}

async function read(addresses: string[]): Promise<ChainRead> {
  const comet = await connectComet(RPC)
  try {
    const q = new QueryServiceClientImpl(createProtobufRpcClient(QueryClient.withExtensions(comet)))
    const timeout = (await q.QueryParams({})).params?.statusTimeout
    if (!timeout) throw new Error('the session params carry no statusTimeout')
    const blockTime = async () => (await comet.block()).block.header.time.getTime()
    const before = await blockTime()
    const read: ChainRead = { statusTimeoutS: Number(timeout.seconds), before, after: 0, accounts: [] }
    for (const address of addresses) {
      const r = await q.QuerySessionsForAccount({
        address,
        pagination: { key: new Uint8Array(), offset: Long.UZERO, limit: Long.fromNumber(100, true), countTotal: true, reverse: false },
      })
      read.accounts.push({
        address,
        total: Number(r.pagination?.total ?? 0),
        rows: r.sessions.map((any): Row => {
          const s = (any.typeUrl.includes('.node.') ? NodeSession : SubSession).decode(any.value).baseSession
          const ms = (t: Date | undefined, what: string) => {
            if (!t) throw new Error(`session ${s?.id} has no ${what}`)
            return t.getTime()
          }
          if (!s) throw new Error(`a ${any.typeUrl} row has no base session`)
          return {
            id: s.id.toString(),
            status: s.status,
            startAt: ms(s.startAt, 'startAt'),
            statusAt: ms(s.statusAt, 'statusAt'),
            inactiveAt: ms(s.inactiveAt, 'inactiveAt'),
            durationS: Number(s.duration?.seconds ?? 0),
            down: s.downloadBytes,
            up: s.uploadBytes,
          }
        }),
      })
    }
    read.after = await blockTime()
    return read
  } finally {
    comet.disconnect()
  }
}

async function main(): Promise<number> {
  const addresses = accounts()
  let chain: ChainRead
  try {
    chain = await Promise.race([
      read(addresses),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer in 60 s')), 60_000).unref()),
    ])
  } catch (e) {
    console.error(`Could not read the chain at ${RPC}: ${(e as Error).message}`)
    return 2
  }
  console.log(`Chain ${RPC} at ${new Date(chain.after).toISOString()}, ${addresses.length} accounts:`)
  for (const a of chain.accounts) console.log(`  ${a.address}  ${a.total} sessions`)
  console.log()
  const findings = judge(chain)
  for (const f of findings) {
    console.log(`${f.verdict.padEnd(9)} ${f.rule}  ${f.text}`)
    for (const o of f.offenders) console.log(`            ${o}`)
  }
  if (findings.some((f) => f.verdict === 'NOT SEEN')) {
    console.log('\nNOT SEEN: these accounts hold no session in the state that shows it. Run again while one is.')
  }
  return findings.some((f) => f.verdict === 'FAIL') ? 1 : 0
}

process.exitCode = await main()
