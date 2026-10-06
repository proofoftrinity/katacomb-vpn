// Paging for the two hub queries whose offset branch never returns a next page.
//
// sentinelhub v12.0.2 serves x/node QueryNodesForPlan and x/plan QueryPlansForProvider
// through the SDK's FilteredPaginate, with a callback that opens
// `if !accumulate { return false, nil }`. FilteredPaginate has two branches:
//
// - EMPTY key: it pages by offset, asks the callback about every row it skips or looks
//   past with accumulate=false, and counts only the rows the callback calls a hit. This
//   callback calls none of them a hit, so the reply never carries a next_key, `total`
//   equals the rows returned, and any offset returns nothing.
// - NON-EMPTY key: it passes accumulate=true for every row and sets next_key itself.
//
// A loop that starts with an empty key therefore reads ONE page and stops. Every plan
// with more than 50 linked nodes read as exactly 50: plan 41 has 873 (measured on
// mainnet 2026-10-06). Starting at key 0x00 takes the key branch from the first request.
// Every store key is >= 0x00, so nothing is skipped, and the branch keeps working once
// the hub fixes its callbacks. Don't "simplify" the start key back to an empty array;
// filtered-pages.test.ts models the hub and fails if you do.
//
// Import-free so Node's native test runner loads it.

export interface Page<T> {
  items: T[]
  nextKey: Uint8Array | null | undefined
}

/** Read every page from the start, up to `max` items. */
export async function collectPages<T>(
  fetchPage: (key: Uint8Array) => Promise<Page<T>>,
  max: number,
): Promise<T[]> {
  const out: T[] = []
  let key: Uint8Array = Uint8Array.of(0)
  while (out.length < max) {
    const page = await fetchPage(key)
    for (const item of page.items) {
      out.push(item)
      if (out.length >= max) return out
    }
    // An empty page ends it even with a key attached, so an RPC that keeps answering
    // with nothing cannot hold the loop open.
    if (!page.nextKey || page.nextKey.length === 0 || page.items.length === 0) break
    key = page.nextKey
  }
  return out
}
