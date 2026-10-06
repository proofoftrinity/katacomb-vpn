import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectPages, type Page } from './filtered-pages.ts'

/** Lexicographic byte order, the order the hub's store iterator walks. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * A stand-in for sentinelhub v12.0.2's QueryNodesForPlan, with the behaviour measured on
 * mainnet: an EMPTY key takes FilteredPaginate's offset branch and returns the first page
 * with no next_key; a non-empty key takes the key branch, which starts at the first store
 * key >= the request's key and sets next_key to the row after the page.
 */
function fakeHub(count: number, limit: number) {
  // Store keys shaped like the hub's length-prefixed node addresses: 0x14, then the address.
  const rows = Array.from({ length: count }, (_, i) => ({
    key: Uint8Array.of(0x14, i >> 8, i & 0xff),
    address: `sentnode${String(i).padStart(4, '0')}`,
  }))
  const keysSent: Uint8Array[] = []
  async function fetchPage(key: Uint8Array): Promise<Page<string>> {
    keysSent.push(key)
    if (key.length === 0) {
      return { items: rows.slice(0, limit).map((r) => r.address), nextKey: null }
    }
    const start = rows.findIndex((r) => compareBytes(r.key, key) >= 0)
    if (start === -1) return { items: [], nextKey: null }
    const page = rows.slice(start, start + limit)
    const next = rows[start + limit]
    return { items: page.map((r) => r.address), nextKey: next ? next.key : null }
  }
  return { fetchPage, keysSent }
}

test('fakeHub reproduces the chain: an empty key gets one page and no next_key', async () => {
  const hub = fakeHub(873, 50)
  const page = await hub.fetchPage(new Uint8Array())
  assert.equal(page.items.length, 50)
  assert.equal(page.nextKey, null)
})

test('collectPages reads every node of a plan bigger than one page', async () => {
  const hub = fakeHub(873, 50)
  const all = await collectPages(hub.fetchPage, 5000)
  assert.equal(all.length, 873)
  assert.equal(new Set(all).size, 873)
  assert.equal(all[0], 'sentnode0000')
  assert.equal(all[872], 'sentnode0872')
})

test('collectPages starts at key 0x00, never an empty key (the empty key is the 50-cap)', async () => {
  const hub = fakeHub(120, 50)
  await collectPages(hub.fetchPage, 5000)
  assert.deepEqual([...hub.keysSent[0]], [0])
  assert.ok(hub.keysSent.every((k) => k.length > 0))
})

test('collectPages stops at max', async () => {
  const hub = fakeHub(873, 50)
  const some = await collectPages(hub.fetchPage, 120)
  assert.equal(some.length, 120)
  assert.equal(hub.keysSent.length, 3)
})

test('collectPages stops on an empty page even when a next key comes with it', async () => {
  let calls = 0
  const all = await collectPages(async () => {
    calls++
    return { items: [] as string[], nextKey: Uint8Array.of(1) }
  }, 5000)
  assert.deepEqual(all, [])
  assert.equal(calls, 1)
})
