import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chainDiversityIssues,
  endpointHost,
  ipv4Slash24,
  sharedDomain,
  pairConflict,
} from './chain-diversity.ts'
import type { SentNode } from '../types'

// Endpoints below are the real shapes the node list carries: bare `host:port`,
// IPv4 literals, and operator fleets under one domain (all observed 2026-08-14).
const node = (over: Partial<SentNode>): SentNode => ({
  address: 'sentnode1aaa', moniker: 'n', version: '9.0.0', type: 2, connection: null,
  api: '1.2.3.4:8080', asn: '12345', country: 'Germany', city: '', isResidential: false,
  isActive: true, isHealthy: true, isDuplicate: false, isWhitelisted: false,
  gigabytePrices: [], hourlyPrices: [], leases: 0, sessions: 0, peers: 0,
  errorMessage: null, fetchedAt: '', ...over,
})

test('endpointHost strips the port, the scheme and any path', () => {
  assert.equal(endpointHost('190.15.196.193:18407'), '190.15.196.193')
  assert.equal(endpointHost('https://nlv2.pytonode.my.id:23457/'), 'nlv2.pytonode.my.id')
  assert.equal(endpointHost('[2001:db8::1]:443'), '2001:db8::1')
  assert.equal(endpointHost(''), null)
  assert.equal(endpointHost(null), null)
})

test('ipv4Slash24 only answers for real IPv4 literals', () => {
  assert.equal(ipv4Slash24('190.15.196.193'), '190.15.196.0/24')
  assert.equal(ipv4Slash24('nlv2.pytonode.my.id'), null)
  assert.equal(ipv4Slash24('999.1.1.1'), null)
})

test('sharedDomain catches an operator fleet under one domain', () => {
  assert.equal(sharedDomain('nlv2.pytonode.my.id', 'hk2.pytonode.my.id'), 'pytonode.my.id')
  assert.equal(sharedDomain('a.example.com', 'b.example.com'), 'example.com')
})

test('sharedDomain needs both hosts to sit UNDER the shared part', () => {
  // Not "one is the domain the other is under" — that is one host, not two peers.
  assert.equal(sharedDomain('example.com', 'b.example.com'), null)
  // A single shared label is not a domain.
  assert.equal(sharedDomain('a.example.com', 'b.example.net'), null)
  assert.equal(sharedDomain('1.2.3.4', '1.2.9.9'), null, 'IPv4 is the subnet check, not this one')
})

test('two hops on one operator report ASN, subnet and country', () => {
  const issues = chainDiversityIssues(
    node({ api: '190.15.196.10:1', asn: '271898', country: 'Argentina' }),
    node({ api: '190.15.196.200:1', asn: '271898', country: 'Argentina' }),
  )
  assert.deepEqual(issues.map((i) => i.key), ['asn', 'subnet', 'country'])
})

test('two independent hops raise nothing', () => {
  const issues = chainDiversityIssues(
    node({ api: '91.149.243.171:9966', asn: '211252', country: 'Spain' }),
    node({ api: '45.87.173.26:4876', asn: '208556', country: 'Turkey' }),
  )
  assert.deepEqual(issues, [])
})

test('a shared country alone is reported on its own', () => {
  const issues = chainDiversityIssues(
    node({ api: '1.1.1.1:1', asn: '111', country: 'Germany' }),
    node({ api: '2.2.2.2:1', asn: '222', country: 'Germany' }),
  )
  assert.deepEqual(issues.map((i) => i.key), ['country'])
})

test('a blank ASN or country is not treated as a match', () => {
  // The aggregator sends null for unknown text fields; normalizeNodes turns those
  // into '' (see node-normalize.ts), and '' === '' must not read as "same ASN".
  const issues = chainDiversityIssues(
    node({ api: '1.1.1.1:1', asn: '', country: '' }),
    node({ api: '2.2.2.2:1', asn: '', country: '' }),
  )
  assert.deepEqual(issues, [])
})

// The hard rule built on the observations above. Every one of them refuses the pair:
// a shared country (one court reaches both) as much as a shared network (one host
// watches both), with no override.

test('pairConflict allows two hops apart in country and network', () => {
  assert.equal(pairConflict(
    node({ api: '91.149.243.171:9966', asn: '211252', country: 'Spain' }),
    node({ api: '45.87.173.26:4876', asn: '208556', country: 'Turkey' }),
  ), null)
})

test('[MH-1] pairConflict refuses a shared country, even on two networks', () => {
  const c = pairConflict(
    node({ api: '1.1.1.1:1', asn: '111', country: 'Germany' }),
    node({ api: '2.2.2.2:1', asn: '222', country: 'Germany' }),
  )
  assert.equal(c?.badge, 'same country')
  assert.equal(c?.title, 'Both hops are in Germany. One legal request can reach both.')
})

test('pairConflict refuses each network overlap, in different countries', () => {
  const sameAsn = pairConflict(
    node({ api: '1.1.1.1:1', asn: '16509', country: 'Japan' }),
    node({ api: '2.2.2.2:1', asn: '16509', country: 'Brazil' }),
  )
  assert.equal(sameAsn?.badge, 'same network')
  const sameSubnet = pairConflict(
    node({ api: '190.15.196.10:1', asn: '111', country: 'Japan' }),
    node({ api: '190.15.196.200:1', asn: '222', country: 'Brazil' }),
  )
  assert.equal(sameSubnet?.badge, 'same network')
  const sameDomain = pairConflict(
    node({ api: 'nlv2.pytonode.my.id:1', asn: '111', country: 'Netherlands' }),
    node({ api: 'hk2.pytonode.my.id:1', asn: '222', country: 'Hong Kong' }),
  )
  assert.equal(sameDomain?.badge, 'same network')
})

test('pairConflict calls a network overlap that, even in one country too', () => {
  const c = pairConflict(
    node({ api: '190.15.196.10:1', asn: '271898', country: 'Argentina' }),
    node({ api: '190.15.196.200:1', asn: '271898', country: 'Argentina' }),
  )
  assert.equal(c?.badge, 'same network')
  // Every observation is in the title, not just the first.
  assert.match(c?.title ?? '', /AS271898.*190\.15\.196\.0\/24.*Argentina/)
})

test('pairConflict refuses a node it cannot place', () => {
  // Positive evidence only: a blank field cannot be shown to differ, so it does not pass.
  const placed = node({ api: '1.1.1.1:1', asn: '111', country: 'Spain' })
  assert.equal(pairConflict(node({ api: '2.2.2.2:1', asn: '', country: 'Turkey' }), placed)?.badge, 'location unknown')
  assert.equal(pairConflict(placed, node({ api: '2.2.2.2:1', asn: '222', country: ' ' }))?.badge, 'location unknown')
})
