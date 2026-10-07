import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge, APP_PAGE, EXPECTED_STATUS_TIMEOUT_S, type ChainRead, type Finding, type Row } from './chain-facts.ts'
import { read } from '../harness/source.ts'

// The verdicts of `npm run check:chain`, offline. The rules themselves (SL-2, SL-3,
// SL-4) stay manual in status.json: these tests prove the checker can tell a chain
// that keeps them from one that does not, not that mainnet keeps them. Both reads
// below are real, the same account on 2026-10-07, before and after its node's
// report at 11:43:59.268Z jumped both live deadlines to 13:43:59.268Z.

const t = (iso: string) => Date.parse(iso)
const ended: Row = { id: '66451960', status: 2, startAt: t('2026-10-07T07:35:18.695Z'), statusAt: t('2026-10-07T10:40:16.762Z'), inactiveAt: t('2026-10-07T12:40:16.762Z'), durationS: 3601, down: '33362240', up: '7964716' }
const unreported: Row[] = [
  { id: '66486462', status: 1, startAt: t('2026-10-07T10:40:34.633Z'), statusAt: t('2026-10-07T10:40:34.633Z'), inactiveAt: t('2026-10-07T12:40:34.633Z'), durationS: 0, down: '0', up: '0' },
  { id: '66488552', status: 1, startAt: t('2026-10-07T10:51:49.977Z'), statusAt: t('2026-10-07T10:51:49.977Z'), inactiveAt: t('2026-10-07T12:51:49.977Z'), durationS: 0, down: '0', up: '0' },
]
const reported: Row[] = [
  { ...unreported[0], inactiveAt: t('2026-10-07T13:43:59.268Z'), durationS: 597, down: '11118301', up: '2918578' },
  { ...unreported[1], inactiveAt: t('2026-10-07T13:43:59.268Z'), durationS: 2852, down: '303291289', up: '13783561' },
]
const address = 'sent1xpqgazzucgx29htzvqpc8cfga06z09ywd83ugc'
const at = (before: string, after: string, rows: Row[], extra: Partial<ChainRead> = {}): ChainRead =>
  ({ statusTimeoutS: 7200, before: t(before), after: t(after), accounts: [{ address, total: rows.length, rows }], ...extra })
const beforeReport = (rows = [ended, ...unreported], extra?: Partial<ChainRead>) => at('2026-10-07T11:36:20Z', '2026-10-07T11:36:23Z', rows, extra)
const afterReport = (rows = [ended, ...reported], extra?: Partial<ChainRead>) => at('2026-10-07T11:44:18Z', '2026-10-07T11:44:21Z', rows, extra)

const line = (fs: Finding[], text: RegExp) => {
  const f = fs.find((x) => text.test(x.text))
  assert.ok(f, `no finding matches ${text}`)
  return f
}
const verdicts = (fs: Finding[]) => fs.map((f) => `${f.verdict} ${f.rule} ${f.text}`)

test('chain-facts: the read before the node reported passes, with the report-jump not seen yet', () => {
  const fs = judge(beforeReport())
  assert.deepEqual(fs.filter((f) => f.verdict === 'FAIL'), [])
  assert.equal(line(fs, /no node report yet/).verdict, 'PASS')
  assert.equal(line(fs, /a node report moves/).verdict, 'NOT SEEN')
  assert.equal(fs.length, 7, verdicts(fs).join('\n'))
})

test('chain-facts: the read after the node reported passes, and sees the jump', () => {
  const fs = judge(afterReport())
  assert.deepEqual(fs.filter((f) => f.verdict === 'FAIL'), [])
  assert.equal(line(fs, /a node report moves/).verdict, 'PASS')
  assert.equal(line(fs, /no node report yet/).verdict, 'NOT SEEN')
})

test('chain-facts: SL-2 fails on any other statusTimeout, and the failure names the copy that assumes 2 h', () => {
  assert.equal(EXPECTED_STATUS_TIMEOUT_S, 7200)
  const f = line(judge(beforeReport(undefined, { statusTimeoutS: 3600 })), /statusTimeout is/)
  assert.equal(f.verdict, 'FAIL')
  assert.match(f.offenders[0], /about 2 h/)
})

test('chain-facts: SL-3 fails when an ending session settles anywhere but statusAt + statusTimeout', () => {
  const f = line(judge(beforeReport([{ ...ended, inactiveAt: ended.inactiveAt + 1000 }, ...unreported])), /ending session settles/)
  assert.equal(f.verdict, 'FAIL')
  assert.deepEqual(f.offenders.map((o) => o.split(':')[0]), ['#66451960'])
})

test('chain-facts: SL-3 fails when a reported session still has the start\'s deadline (the reading SL-3 corrected)', () => {
  const stuck = { ...reported[0], inactiveAt: reported[0].startAt + 7_200_000 }
  const f = line(judge(afterReport([ended, stuck, reported[1]])), /a node report moves/)
  assert.equal(f.verdict, 'FAIL')
  assert.deepEqual(f.offenders.map((o) => o.split(':')[0]), ['#66486462'])
})

test('chain-facts: SL-3 fails when a session moved its deadline with no report (connection alone keeps it alive)', () => {
  const moved = { ...unreported[0], inactiveAt: unreported[0].inactiveAt + 60_000 }
  assert.equal(line(judge(beforeReport([ended, moved, unreported[1]])), /no node report yet/).verdict, 'FAIL')
})

test('chain-facts: SL-3 fails when an active deadline lies before start + timeout or past now + timeout', () => {
  const early = { ...reported[0], inactiveAt: reported[0].startAt + 7_200_000 - 1 }
  const late = { ...reported[1], inactiveAt: t('2026-10-07T11:44:21Z') + 7_200_000 + 1 }
  const f = line(judge(afterReport([ended, early, late])), /deadline lies between/)
  assert.equal(f.verdict, 'FAIL')
  assert.deepEqual(f.offenders.map((o) => o.split(':')[0]), ['#66486462', '#66488552'])
  // A report made in the block the query ran at is inside the bound, not past it.
  const edge = { ...reported[1], inactiveAt: t('2026-10-07T11:44:21Z') + 7_200_000 }
  assert.equal(line(judge(afterReport([ended, reported[0], edge])), /deadline lies between/).verdict, 'PASS')
})

test('chain-facts: SL-4 fails on a settled row that is kept, or an ending row past its settle time', () => {
  const kept = { ...ended, id: '1', status: 3 }
  const overdue = { ...ended, id: '2', statusAt: t('2026-10-07T09:36:00Z'), inactiveAt: t('2026-10-07T11:36:00Z') }
  const f = line(judge(beforeReport([ended, kept, overdue, ...unreported])), /settled sessions are deleted/)
  assert.equal(f.verdict, 'FAIL')
  assert.deepEqual(f.offenders.map((o) => o.split(':')[0]), ['#1', '#2'])
  // One that settles between the reads before and after the query is not overdue.
  const settling = { ...ended, id: '3', statusAt: t('2026-10-07T09:36:21Z'), inactiveAt: t('2026-10-07T11:36:21Z') }
  assert.equal(line(judge(beforeReport([ended, settling])), /settled sessions are deleted/).verdict, 'PASS')
})

test('chain-facts: SL-4 fails when an account holds more sessions than the app reads', () => {
  const read = beforeReport()
  read.accounts[0].total = APP_PAGE + 1
  assert.equal(line(judge(read), /fit the app's page/).verdict, 'FAIL')
  read.accounts[0].total = APP_PAGE
  assert.equal(line(judge(read), /fit the app's page/).verdict, 'PASS')
})

test('chain-facts: an account with no sessions shows nothing about rows, rather than passing them', () => {
  const fs = judge(beforeReport([]))
  assert.deepEqual(fs.filter((f) => f.verdict === 'FAIL'), [])
  for (const text of [/ending session/, /deadline lies between/, /no node report yet/, /a node report moves/, /settled sessions/]) {
    assert.equal(line(fs, text).verdict, 'NOT SEEN', String(text))
  }
})

test('chain-facts: APP_PAGE is the page getSessionsForAddress actually reads', () => {
  const wallet = read('src/main/chain/wallet.ts')
  const body = wallet.slice(wallet.indexOf('export async function getSessionsForAddress'))
  assert.match(body.slice(0, body.indexOf('\n}\n')), new RegExp(`limit: Long\\.fromNumber\\(${APP_PAGE}, true\\)`))
})
