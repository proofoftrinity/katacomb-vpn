// The Provider overview's lease runway: how long each lease has left, soonest end
// first, on one shared time axis so the bars compare. Pure and import-free so the
// native test runner loads it (lease-runway.test.ts).

/** Axis lengths the runway snaps to, in hours: a day, two, a week, two, thirty days. */
const AXIS_STEPS = [24, 48, 168, 336, 720]

export interface RunwayLease {
  hours: number
  maxHours: number
}

/**
 * Leases still being billed, each with its hours left and its share of the axis.
 * An exhausted lease (hours >= maxHours) is left out: the chain no longer bills it,
 * and the economics figures do not count it either (isActiveLease).
 */
export function leaseRunway<T extends RunwayLease>(leases: T[]): {
  rows: (T & { hoursLeft: number; fraction: number })[]
  axisHours: number
} {
  const live = leases
    .map((l) => ({ ...l, hoursLeft: Math.max(0, l.maxHours - l.hours) }))
    .filter((l) => l.hoursLeft > 0)
    .sort((a, b) => a.hoursLeft - b.hoursLeft)
  const longest = live.reduce((m, l) => Math.max(m, l.hoursLeft), 0)
  const axisHours = AXIS_STEPS.find((s) => s >= longest) ?? longest
  return {
    rows: live.map((l) => ({ ...l, fraction: axisHours > 0 ? l.hoursLeft / axisHours : 0 })),
    axisHours,
  }
}

/**
 * The soonest lease that stops within a day and will NOT renew, or null. Renewal
 * policy 0 is RENEWAL_POLICY.UNSPECIFIED, "never renew" (shared/renewal-policy.ts),
 * spelled as a literal so this file stays import-free. The Overview's warning line and
 * the dot on the Provider tab label both read this, from the same chain read, so they
 * always agree. Neither projects from the read's age: both mean "at the last read".
 */
export function leaseStopsSoon<T extends RunwayLease & { renewalPricePolicy: number }>(leases: T[]):
  (T & { hoursLeft: number }) | null {
  return leaseRunway(leases).rows.find((r) => r.renewalPricePolicy === 0 && r.hoursLeft < 24) ?? null
}
