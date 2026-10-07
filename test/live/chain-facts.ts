// The verdicts `npm run check:chain` prints: the chain facts the manual rules SL-2, SL-3
// and SL-4 rest on (docs/invariants/session-lifecycle.md), judged from one read of
// mainnet. Pure, so chain-facts.test.ts can run every verdict offline;
// check-chain.ts does the reading.

/** One session row as the chain returns it, times in ms since the epoch. */
export interface Row {
  id: string
  /** 1 active, 2 inactive_pending, 3 inactive (sentinel.types.v1.Status). */
  status: number
  startAt: number
  statusAt: number
  inactiveAt: number
  durationS: number
  down: string
  up: string
}

export interface ChainRead {
  statusTimeoutS: number
  /** Block times read just before and just after the sessions query, which ran at a block between them. */
  before: number
  after: number
  accounts: { address: string; total: number; rows: Row[] }[]
}

export type Verdict = 'PASS' | 'FAIL' | 'NOT SEEN'
export interface Finding { rule: string; verdict: Verdict; text: string; offenders: string[] }

/** What the docs and the UI copy assume statusTimeout is. */
export const EXPECTED_STATUS_TIMEOUT_S = 7200
/** The page `getSessionsForAddress` (src/main/chain/wallet.ts) reads; SL-4 is why one page is enough. */
export const APP_PAGE = 20

const ACTIVE = 1
const INACTIVE_PENDING = 2
const iso = (ms: number) => new Date(ms).toISOString()
const reported = (r: Row) => r.durationS > 0 || r.down !== '0' || r.up !== '0'

export function judge(read: ChainRead): Finding[] {
  const timeout = read.statusTimeoutS * 1000
  const rows = read.accounts.flatMap((a) => a.rows)
  const active = rows.filter((r) => r.status === ACTIVE)
  const pending = rows.filter((r) => r.status === INACTIVE_PENDING)
  const findings: Finding[] = []
  const add = (rule: string, offenders: string[], text: string, seen = true) =>
    findings.push({ rule, verdict: offenders.length ? 'FAIL' : seen ? 'PASS' : 'NOT SEEN', text, offenders })

  add('SL-2', read.statusTimeoutS === EXPECTED_STATUS_TIMEOUT_S ? [] : [
    `statusTimeout is ${read.statusTimeoutS} s: update session-lifecycle.md and the two-hop review's "about 2 h" note`,
  ], `statusTimeout is ${EXPECTED_STATUS_TIMEOUT_S} s`)

  // Phase 1 stamps the settle time once; nothing moves it after.
  add('SL-3', pending.filter((r) => r.inactiveAt !== r.statusAt + timeout).map((r) =>
    `#${r.id}: inactiveAt ${iso(r.inactiveAt)}, statusAt + timeout is ${iso(r.statusAt + timeout)}`),
  `an ending session settles at statusAt + statusTimeout (${pending.length} rows)`, pending.length > 0)

  // On an active row the deadline is the last proof + timeout: never sooner than the
  // start's, never further out than a proof made now would put it.
  add('SL-3', active.filter((r) => r.inactiveAt < r.startAt + timeout || r.inactiveAt > read.after + timeout).map((r) =>
    `#${r.id}: inactiveAt ${iso(r.inactiveAt)} is outside [start + timeout ${iso(r.startAt + timeout)}, now + timeout ${iso(read.after + timeout)}]`),
  `an active session's deadline lies between start + statusTimeout and now + statusTimeout (${active.length} rows)`, active.length > 0)

  // Being connected does not move it: only the node's report does.
  const idle = active.filter((r) => !reported(r))
  add('SL-3', idle.filter((r) => r.inactiveAt !== r.startAt + timeout).map((r) =>
    `#${r.id}: no usage reported, yet inactiveAt ${iso(r.inactiveAt)} is not start + timeout ${iso(r.startAt + timeout)}`),
  `with no node report yet, the deadline is start + statusTimeout (${idle.length} rows)`, idle.length > 0)

  const proven = active.filter(reported)
  add('SL-3', proven.filter((r) => r.inactiveAt === r.startAt + timeout).map((r) =>
    `#${r.id}: the node reported usage, yet inactiveAt is still start + timeout`),
  `a node report moves the deadline to report + statusTimeout (${proven.length} rows)`, proven.length > 0)

  // Settling deletes the row: no settled row, and none left past its settle time.
  add('SL-4', [
    ...rows.filter((r) => r.status !== ACTIVE && r.status !== INACTIVE_PENDING).map((r) => `#${r.id}: kept with status ${r.status}`),
    ...pending.filter((r) => r.inactiveAt < read.before).map((r) => `#${r.id}: still listed after its settle time ${iso(r.inactiveAt)}`),
  ], `settled sessions are deleted (${rows.length} rows)`, rows.length > 0)

  add('SL-4', read.accounts.filter((a) => a.total > APP_PAGE).map((a) =>
    `${a.address}: ${a.total} sessions, the app reads the first ${APP_PAGE}`),
  `every account's sessions fit the app's page of ${APP_PAGE} (most: ${Math.max(0, ...read.accounts.map((a) => a.total))})`)

  return findings
}
