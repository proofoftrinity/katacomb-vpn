// The maths behind the Plans tab's graphics: the value strip (a plan's price per GB
// against every listed plan and against paying a node directly) and the time-used
// and data-used gauges on a subscription. Pure and import-free so the native test runner loads it
// (plan-value.test.ts); the components only draw what these return.

/**
 * The median price per GB, in P2P, of paying a node directly: active, healthy
 * nodes that publish a udvpn per-GB price. null when none does. Healthy only,
 * because an unhealthy node's price is not one anybody can actually pay for
 * bandwidth.
 */
export function nodeMedianPerGb(
  nodes: { isActive: boolean; isHealthy: boolean; gigabytePrices: { denom: string; value: string }[] }[],
): number | null {
  const prices: number[] = []
  for (const n of nodes) {
    if (!n.isActive || !n.isHealthy) continue
    const v = Number(n.gigabytePrices.find((p) => p.denom === 'udvpn')?.value)
    if (isFinite(v) && v > 0) prices.push(v / 1e6)
  }
  if (prices.length === 0) return null
  prices.sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2
}

/**
 * A log scale over whole decades covering every value, for prices that run from
 * 0.0002 to 80 P2P/GB on one strip. `ticks` are the decade exponents; `at` places a
 * value as a percentage of the width.
 */
export function decadeScale(values: number[]): { ticks: number[]; at: (v: number) => number } {
  const logs = values.filter((v) => v > 0 && isFinite(v)).map((v) => Math.log10(v))
  let lo = logs.length ? Math.floor(Math.min(...logs)) : -1
  let hi = logs.length ? Math.ceil(Math.max(...logs)) : 2
  if (hi - lo < 2) { lo -= 1; hi += 1 }
  const ticks: number[] = []
  for (let e = lo; e <= hi; e++) ticks.push(e)
  return {
    ticks,
    at: (v) => (v > 0 ? Math.min(100, Math.max(0, ((Math.log10(v) - lo) / (hi - lo)) * 100)) : 0),
  }
}

/**
 * How a plan's per-GB price compares to the node median: `ratio` is how many
 * times cheaper the plan is (below 1 means dearer). Within a factor of 1.5
 * either way it is "about the same", which is what the strip can honestly show.
 */
export function compareToNodes(planPerGb: number, nodeMedian: number):
  { kind: 'cheaper' | 'dearer' | 'same'; factor: number } {
  const ratio = nodeMedian / planPerGb
  if (ratio >= 1.5) return { kind: 'cheaper', factor: ratio }
  if (ratio <= 1 / 1.5) return { kind: 'dearer', factor: 1 / ratio }
  return { kind: 'same', factor: 1 }
}

/**
 * How far through its validity a subscription is. null when either date is
 * missing or nonsensical: the card then shows no gauge rather than a guess.
 */
export function timeUsed(startIso: string | null, endIso: string | null, now: number):
  { fraction: number; usedDays: number; totalDays: number; leftDays: number } | null {
  if (!startIso || !endIso) return null
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!isFinite(start) || !isFinite(end) || end <= start) return null
  const fraction = Math.min(1, Math.max(0, (now - start) / (end - start)))
  const totalDays = (end - start) / 86_400_000
  const usedDays = Math.min(totalDays, Math.max(0, (now - start) / 86_400_000))
  return { fraction, usedDays, totalDays, leftDays: totalDays - usedDays }
}

/**
 * How much of a subscription's data allocation the wallet has used, from the
 * chain's granted and utilised byte counts. `unlimited` at or past `unlimitedAt`
 * (passed in, so this file stays import-free), where a bar would be a hairline
 * that says nothing. A zero grant is used up: nothing is left to spend. null when
 * either count is unreadable, so the card says so instead of drawing a guess.
 */
export function dataUsed(grantedBytes: string, utilisedBytes: string, unlimitedAt: number):
  { fraction: number; granted: number; utilised: number; unlimited: boolean } | null {
  const granted = Number(grantedBytes)
  const utilised = Number(utilisedBytes)
  if (!isFinite(granted) || !isFinite(utilised) || granted < 0 || utilised < 0) return null
  if (granted >= unlimitedAt) return { fraction: 0, granted, utilised, unlimited: true }
  const fraction = granted > 0 ? Math.min(1, utilised / granted) : 1
  return { fraction, granted, utilised, unlimited: false }
}
