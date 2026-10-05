import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chainBuyBlocker,
  chainRowRank,
  chainRowState,
  hopChipState,
  isChainable,
  isCheckable,
  isTooOldToChain,
  isVerifiedFor,
  majorVersion,
  pickChainPair,
  swapBlocker,
  udvpnPrice,
  type ChainBuyState,
} from './chain-node.ts'
import { pairConflict } from './chain-diversity.ts'
import type { ChainEligibility, SentNode } from '../types'

const node = (over: Partial<SentNode>): SentNode => ({
  address: 'sentnode1aaa', moniker: 'n', version: '9.0.0', type: 2, connection: null,
  api: '1.2.3.4:8080', asn: '12345', country: 'Germany', city: '', isResidential: false,
  isActive: true, isHealthy: true, isDuplicate: false, isWhitelisted: false,
  gigabytePrices: [], hourlyPrices: [], leases: 0, sessions: 0, peers: 0,
  errorMessage: null, fetchedAt: '', ...over,
})

const grade = (over: Partial<ChainEligibility>): ChainEligibility => ({
  nodeAddress: 'sentnode1aaa', checkedAt: 0, reachable: true, transports: ['tcp'],
  entry: true, exit: true, entrySecurity: 'tls', exitSecurity: 'tls', ...over,
})

test('isChainable takes only healthy, active v2ray and xray nodes', () => {
  assert.equal(isChainable(node({ type: 2 })), true)
  assert.equal(isChainable(node({ type: 4 })), true)
  // Every other protocol: proxySettings.tag has no equivalent, so they cannot chain.
  for (const type of [0, 1, 3, 5, 6]) {
    assert.equal(isChainable(node({ type })), false)
  }
  assert.equal(isChainable(node({ isActive: false })), false)
  assert.equal(isChainable(node({ isHealthy: false })), false)
})

test('isChainable leaves out nodes too old to check, and isTooOldToChain names exactly those', () => {
  assert.equal(isChainable(node({ version: '8.3.1' })), false)
  assert.equal(isChainable(node({ version: '' })), false)
  assert.equal(isTooOldToChain(node({ version: '8.3.1' })), true)
  assert.equal(isTooOldToChain(node({ version: '9.0.0' })), false)
  // Old AND unusable for another reason is not "too old": the version is not why.
  assert.equal(isTooOldToChain(node({ version: '8.3.1', type: 1 })), false)
  assert.equal(isTooOldToChain(node({ version: '8.3.1', isHealthy: false })), false)
})

test('majorVersion reads the leading number and gives up quietly', () => {
  assert.equal(majorVersion(node({ version: '9.0.0' })), 9)
  assert.equal(majorVersion(node({ version: '10.1.2' })), 10)
  assert.equal(majorVersion(node({ version: '8.3.1' })), 8)
  assert.equal(majorVersion(node({ version: '' })), 0)
  assert.equal(majorVersion(node({ version: 'unstable' })), 0)
  assert.equal(isCheckable(node({ version: '8.3.1' })), false)
  assert.equal(isCheckable(node({ version: '9.0.0' })), true)
})

test('udvpnPrice reads the udvpn quote for the billing type, or null', () => {
  const priced = node({
    gigabytePrices: [{ denom: 'udvpn', value: '40150000' }],
    hourlyPrices: [{ denom: 'other', value: '5' }],
  })
  assert.equal(udvpnPrice(priced, 'gigabytes'), 40150000)
  assert.equal(udvpnPrice(priced, 'hours'), null)
  assert.equal(udvpnPrice(node({}), 'gigabytes'), null)
})

// The three that must never be clickable. Each is a node the chain rule cannot
// confirm, and under that rule an unconfirmed node is a near-certain double refund
// rather than a maybe. Getting this wrong once cost a real pair of sessions.

test('a pre-9.0.0 node is listed but never selectable', () => {
  const state = chainRowState(node({ version: '8.3.1' }), undefined, 'entry', null)
  assert.equal(state.selectable, false)
  assert.equal(state.badge, 'v8.3.1')
  assert.equal(state.tone, 'muted')
})

test('a v9 node with no grade yet is never selectable', () => {
  for (const role of ['entry', 'exit'] as const) {
    const state = chainRowState(node({ version: '9.0.0' }), undefined, role, null)
    assert.equal(state.selectable, false)
    assert.equal(state.badge, 'checking…')
  }
})

test('a node that could not be reached is never selectable', () => {
  const state = chainRowState(node({}), grade({ reachable: false, transports: [], error: 'timeout' }), 'exit', null)
  assert.equal(state.selectable, false)
  assert.equal(state.badge, 'unknown')
  assert.equal(state.tone, 'warning')
  assert.equal(state.title, 'timeout')
})

test('a graded node that fails the rule is refused, per role', () => {
  const noTls = grade({ entry: false, exit: false, entrySecurity: null, exitSecurity: null, transports: ['grpc'] })
  assert.deepEqual(
    { ...chainRowState(node({}), noTls, 'entry', null) },
    {
      selectable: false,
      badge: 'no TLS',
      tone: 'danger',
      title: 'Serves grpc, but none of it is wrapped in TLS or Reality. Still fine for an ordinary single-hop connection.',
    },
  )
  assert.equal(chainRowState(node({}), noTls, 'exit', null).badge, 'no TLS/TCP')
})

test('an entry-only node is selectable as an entry and refused as an exit', () => {
  // Measured: grpc and websocket work as a direct hop but not when carried inside
  // another one, so a node without plain TCP is an entry and never an exit.
  const entryOnly = grade({ exit: false, exitSecurity: null, transports: ['grpc'] })
  assert.equal(chainRowState(node({}), entryOnly, 'entry', null).selectable, true)
  assert.equal(chainRowState(node({}), entryOnly, 'exit', null).selectable, false)
})

test('a verified row names the wrapping it would get', () => {
  const reality = grade({ entrySecurity: 'reality', exitSecurity: 'reality', transports: ['tcp', 'grpc'] })
  assert.deepEqual(
    { ...chainRowState(node({}), reality, 'exit', null) },
    {
      selectable: true,
      badge: 'TCP + Reality',
      tone: 'success',
      title: 'Serves tcp, grpc. This hop would be wrapped in Reality.',
    },
  )
  assert.equal(chainRowState(node({}), grade({}), 'entry', null).badge, 'TLS')
})

test('chainRowRank puts the pickable first and the uncheckable last', () => {
  const v9 = node({ version: '9.0.0' })
  assert.equal(chainRowRank(v9, grade({}), 'entry', null), 0)                                  // verified
  assert.equal(chainRowRank(v9, undefined, 'entry', null), 1)                                  // still checking
  assert.equal(chainRowRank(v9, grade({ reachable: false }), 'entry', null), 2)                // did not answer
  assert.equal(chainRowRank(v9, grade({ entry: false, exit: false }), 'entry', null), 3)       // refused
  assert.equal(chainRowRank(node({ version: '8.3.1' }), undefined, 'entry', null), 4)          // too old
})

test('chainRowRank is scored per role, like the badge', () => {
  const entryOnly = grade({ exit: false, exitSecurity: null, transports: ['grpc'] })
  assert.equal(chainRowRank(node({}), entryOnly, 'entry', null), 0)
  assert.equal(chainRowRank(node({}), entryOnly, 'exit', null), 3)
})

test('rank 0 and selectable never disagree', () => {
  // The column sorts on the rank while the row is enabled on the state, so a split
  // between them would put unpickable rows at the top of a "best first" sort.
  const cases: [SentNode, ChainEligibility | undefined][] = [
    [node({ version: '8.3.1' }), undefined],
    [node({}), undefined],
    [node({}), grade({ reachable: false })],
    [node({}), grade({})],
    [node({}), grade({ entry: false, exit: false })],
    [node({}), grade({ exit: false })],
  ]
  for (const role of ['entry', 'exit'] as const) {
    for (const [n, g] of cases) {
      assert.equal(
        chainRowRank(n, g, role, null) === 0,
        chainRowState(n, g, role, null).selectable,
        `disagreed for ${role} on ${JSON.stringify(g)}`,
      )
    }
  }
})

test('isVerifiedFor answers only on a reachable grade for that end', () => {
  assert.equal(isVerifiedFor(undefined, 'entry'), false)
  assert.equal(isVerifiedFor(grade({ reachable: false }), 'entry'), false)
  assert.equal(isVerifiedFor(grade({ exit: false }), 'exit'), false)
  assert.equal(isVerifiedFor(grade({ exit: false }), 'entry'), true)
})

// ---- the pair rule on a row ----

const sameCountry = { badge: 'same country' as const, title: 'Both hops are in Germany. One legal request can reach both.' }

test('a pair conflict refuses an otherwise verified row, and says why', () => {
  const state = chainRowState(node({}), grade({}), 'exit', sameCountry)
  assert.equal(state.selectable, false)
  assert.equal(state.badge, 'same country')
  assert.equal(state.tone, 'danger')
  assert.match(state.title, /^Both hops are in Germany\./)
})

test('a pair conflict is reported before the grade, which can never rescue it', () => {
  // Still checking, or too old: the conflict is the more useful thing to say.
  assert.equal(chainRowState(node({}), undefined, 'exit', sameCountry).badge, 'same country')
  assert.equal(chainRowState(node({ version: '8.3.1' }), undefined, 'entry', sameCountry).badge, 'same country')
  assert.equal(chainRowRank(node({}), grade({}), 'exit', sameCountry), 3)
})

test('rank 0 and selectable still agree once a pair conflict is in play', () => {
  for (const role of ['entry', 'exit'] as const) {
    for (const g of [undefined, grade({}), grade({ reachable: false }), grade({ exit: false })]) {
      for (const c of [null, sameCountry]) {
        assert.equal(chainRowRank(node({}), g, role, c) === 0, chainRowState(node({}), g, role, c).selectable)
      }
    }
  }
})

// ---- the role chips on a row ----

test('a chip on the picked node says so, and a click on it will remove it', () => {
  const n = node({})
  assert.equal(hopChipState(n, grade({}), 'entry', n, null, null).kind, 'picked')
})

test("the other hop's pick is refused for this role, whatever its grade", () => {
  const n = node({})
  const state = hopChipState(n, grade({}), 'entry', null, n, null)
  assert.equal(state.kind, 'refused')
  assert.equal(state.title, 'Already your exit.')
})

test('a chip is usable exactly when the row is selectable for that role', () => {
  for (const role of ['entry', 'exit'] as const) {
    for (const g of [undefined, grade({}), grade({ reachable: false }), grade({ exit: false }), grade({ entry: false })]) {
      for (const c of [null, sameCountry]) {
        for (const n of [node({}), node({ version: '8.3.1' })]) {
          assert.equal(
            hopChipState(n, g, role, null, null, c).kind === 'usable',
            chainRowState(n, g, role, c).selectable,
          )
        }
      }
    }
  }
})

test('a conflict is a clash that names its reason, for the role it was computed for', () => {
  // The caller passes pairConflict against the OTHER hop, so the entry chip of a row
  // that clashes with the exit can still be usable: it would replace the entry.
  const n = node({})
  const state = hopChipState(n, grade({}), 'exit', null, null, sameCountry)
  assert.equal(state.kind, 'clash')
  assert.equal(state.kind === 'clash' && state.badge, 'same country')
  assert.match(state.title, /^Both hops are in Germany\./)
  assert.equal(hopChipState(n, grade({}), 'entry', null, null, null).kind, 'usable')
})

test('a clash is reported before a role refusal, as on the row', () => {
  assert.equal(hopChipState(node({}), grade({ exit: false }), 'exit', null, null, sameCountry).kind, 'clash')
})

test('a usable chip for a filled hop says it replaces that hop', () => {
  const current = node({ address: 'sentnode1cur', moniker: '(DIGGO) Melbourne' })
  const state = hopChipState(node({}), grade({}), 'entry', current, null, null)
  assert.equal(state.kind, 'usable')
  assert.match(state.title, /^Replaces \(DIGGO\) Melbourne as your entry\. Serves tcp\./)
  assert.doesNotMatch(hopChipState(node({}), grade({}), 'entry', null, null, null).title, /Replaces/)
})

// ---- swapBlocker ----

test('two hops verified for both roles can swap', () => {
  const a = node({ address: 'sentnode1a' })
  const b = node({ address: 'sentnode1b' })
  const grades = new Map([['sentnode1a', grade({})], ['sentnode1b', grade({})]])
  assert.equal(swapBlocker(a, b, grades), null)
})

test('an entry with no verified exit role cannot move to the exit', () => {
  const a = node({ address: 'sentnode1a', moniker: 'ams-relay' })
  const b = node({ address: 'sentnode1b' })
  const grades = new Map([['sentnode1a', grade({ exit: false })], ['sentnode1b', grade({})]])
  assert.equal(swapBlocker(a, b, grades), 'ams-relay is not verified as an exit, so the hops cannot swap.')
})

test('an exit with no grade cannot move to the entry: positive evidence only', () => {
  const a = node({ address: 'sentnode1a' })
  const b = node({ address: 'sentnode1b', moniker: 'tokyo-v9' })
  const grades = new Map([['sentnode1a', grade({})]])
  assert.equal(swapBlocker(a, b, grades), 'tokyo-v9 is not verified as an entry, so the hops cannot swap.')
})

test('a single hop can swap into the empty slot, checked for that slot only', () => {
  const a = node({ address: 'sentnode1a' })
  assert.equal(swapBlocker(a, null, new Map([['sentnode1a', grade({})]])), null)
  assert.notEqual(swapBlocker(a, null, new Map([['sentnode1a', grade({ exit: false })]])), null)
  assert.equal(swapBlocker(null, a, new Map([['sentnode1a', grade({ exit: false })]])), null)
})

// ---- pickChainPair ----

const priced = (over: Partial<SentNode>, perGb: number) =>
  node({ gigabytePrices: [{ denom: 'udvpn', value: String(perGb) }], ...over })

test('pickChainPair takes the fastest pair that passes every rule', () => {
  const jakarta = priced({ address: 'sentnode1jkt', country: 'Indonesia', asn: '63949', api: '172.232.246.6:1' }, 40)
  const jakarta2 = priced({ address: 'sentnode1jk2', country: 'Indonesia', asn: '17451', api: '36.1.1.1:1' }, 35)
  const tokyo = priced({ address: 'sentnode1tyo', country: 'Japan', asn: '2516', api: '106.72.14.9:1' }, 44)
  const melbourne = priced({ address: 'sentnode1mel', country: 'Australia', asn: '133159', api: '45.124.52.245:1' }, 50)
  const grades = new Map([jakarta, jakarta2, tokyo, melbourne].map((n) => [n.address, grade({ nodeAddress: n.address })]))
  const latency = new Map<string, number | null>([
    ['sentnode1jkt', 24], ['sentnode1jk2', 22], ['sentnode1tyo', 96], ['sentnode1mel', 182],
  ])
  const pick = pickChainPair([melbourne, tokyo, jakarta2, jakarta], grades, latency, 'gigabytes', pairConflict)
  // The two Jakarta nodes are fastest but share a country, so they never pair.
  assert.equal(pick?.entry.address, 'sentnode1jk2')
  assert.equal(pick?.exit.address, 'sentnode1tyo')
})

test('pickChainPair admits only graded, priced nodes, each for its own role', () => {
  const a = priced({ address: 'sentnode1a', country: 'Spain', asn: '1', api: '1.1.1.1:1' }, 10)
  const b = priced({ address: 'sentnode1b', country: 'Turkey', asn: '2', api: '2.2.2.2:1' }, 10)
  const unpriced = node({ address: 'sentnode1c', country: 'Chile', asn: '3', api: '3.3.3.3:1' })
  const latency = new Map<string, number | null>()
  // a is graded exit-only and b entry-only, so the one pair is b then a; c has no price.
  const entryOnlyB = new Map([
    ['sentnode1a', grade({ exit: true, entry: false })],
    ['sentnode1b', grade({ exit: false })],
    ['sentnode1c', grade({})],
  ])
  assert.deepEqual(
    pickChainPair([a, b, unpriced], entryOnlyB, latency, 'gigabytes', pairConflict),
    { entry: b, exit: a },
  )
  // Ungraded: nothing qualifies.
  assert.equal(pickChainPair([a, b], new Map(), latency, 'gigabytes', pairConflict), null)
  // No hourly price quoted by either: nothing to buy by the hour.
  assert.equal(pickChainPair([a, b], entryOnlyB, latency, 'hours', pairConflict), null)
})

test('pickChainPair prefers measured hops, then price, then is deterministic', () => {
  const mk = (id: string, country: string, ip: string, perGb: number) =>
    priced({ address: `sentnode1${id}`, country, asn: id, api: `${ip}:1` }, perGb)
  const nodes = [mk('a', 'Spain', '1.1.1.1', 10), mk('b', 'Turkey', '2.2.2.2', 10), mk('c', 'Chile', '3.3.3.3', 1), mk('d', 'Peru', '4.4.4.4', 1)]
  const grades = new Map(nodes.map((n) => [n.address, grade({})]))
  // a and b measured; c and d cheaper but never tested.
  const measured = new Map<string, number | null>([['sentnode1a', 300], ['sentnode1b', 300]])
  const pick = pickChainPair(nodes, grades, measured, 'gigabytes', pairConflict)
  assert.deepEqual([pick?.entry.address, pick?.exit.address], ['sentnode1a', 'sentnode1b'])
  // Nothing measured: cheapest wins, and the address breaks the tie the same way every time.
  const cheap = pickChainPair(nodes, grades, new Map(), 'gigabytes', pairConflict)
  assert.deepEqual([cheap?.entry.address, cheap?.exit.address], ['sentnode1c', 'sentnode1d'])
  assert.deepEqual(pickChainPair([...nodes].reverse(), grades, new Map(), 'gigabytes', pairConflict), cheap)
})

test('pickChainPair returns null when every pair conflicts', () => {
  const de1 = priced({ address: 'sentnode1x', country: 'Germany', asn: '1', api: '1.1.1.1:1' }, 10)
  const de2 = priced({ address: 'sentnode1y', country: 'Germany', asn: '2', api: '2.2.2.2:1' }, 10)
  const grades = new Map([[de1.address, grade({})], [de2.address, grade({})]])
  assert.equal(pickChainPair([de1, de2], grades, new Map(), 'gigabytes', pairConflict), null)
})

// ---- chainBuyBlocker ----

const ready: ChainBuyState = {
  alreadyConnected: false, conflict: null, exitRefused: false, exitWallet: 'clean',
  priceMissing: false, entryShort: false, exitShort: false, acknowledged: true,
}

test('chainBuyBlocker is null only when everything is in place', () => {
  assert.equal(chainBuyBlocker(ready), null)
})

test('chainBuyBlocker names each blocker on its own', () => {
  assert.equal(chainBuyBlocker({ ...ready, alreadyConnected: true }), 'connected')
  assert.equal(chainBuyBlocker({ ...ready, conflict: sameCountry }), 'pair')
  assert.equal(chainBuyBlocker({ ...ready, exitRefused: true }), 'exit-refused')
  assert.equal(chainBuyBlocker({ ...ready, exitWallet: 'none' }), 'no-wallet')
  assert.equal(chainBuyBlocker({ ...ready, exitWallet: 'linked' }), 'wallet-linked')
  assert.equal(chainBuyBlocker({ ...ready, exitWallet: 'checking' }), 'wallet-checking')
  assert.equal(chainBuyBlocker({ ...ready, priceMissing: true }), 'price-missing')
  assert.equal(chainBuyBlocker({ ...ready, entryShort: true }), 'entry-short')
  assert.equal(chainBuyBlocker({ ...ready, exitShort: true }), 'exit-short')
  assert.equal(chainBuyBlocker({ ...ready, acknowledged: false }), 'unacknowledged')
})

test('a link check that could not run never blocks', () => {
  // The RPC keeping no tx index is not a finding. The row still says so, in amber.
  assert.equal(chainBuyBlocker({ ...ready, exitWallet: 'unchecked' }), null)
})

test('chainBuyBlocker names the first blocker when several apply', () => {
  const everything: ChainBuyState = {
    alreadyConnected: true, conflict: sameCountry, exitRefused: true, exitWallet: 'none',
    priceMissing: true, entryShort: true, exitShort: true, acknowledged: false,
  }
  assert.equal(chainBuyBlocker(everything), 'connected')
  assert.equal(chainBuyBlocker({ ...everything, alreadyConnected: false }), 'pair')
  assert.equal(chainBuyBlocker({ ...everything, alreadyConnected: false, conflict: null, exitRefused: false }), 'no-wallet')
  assert.equal(chainBuyBlocker({ ...ready, entryShort: true, exitShort: true, acknowledged: false }), 'entry-short')
})
