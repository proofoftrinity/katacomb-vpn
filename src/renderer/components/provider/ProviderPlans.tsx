import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { LeaseSummary, MyPlan, PlanStats, ProviderEconomics, SentNode, TokenPrice } from '../../types'
import { computeBreakEven, isActiveLease, netOfStakingShare, parseDecShare } from '../../../shared/provider-economics'
import { isTestPlan } from '../../../shared/test-plan'
import { RENEWAL_POLICY, renewalPolicyLabel } from '../../../shared/renewal-policy'
import { displayConnectError } from '../../utils/connect-errors'
import { formatBytes, formatDuration, formatPerGb, formatTimeAgo, pricePerGb } from '../../utils/format'
import { leaseRunway, leaseStopsSoon } from '../../utils/lease-runway'
import { nodeMedianPerGb } from '../../utils/plan-value'
import { useNodesContext } from '../../contexts/NodesContext'
import { useNavigation } from '../../contexts/NavigationContext'
import { usePlansContext } from '../../contexts/PlansContext'
import { useConfirm, type ConfirmOptions } from '../ConfirmModal'
import { ChecksSection, FooterReason, Segmented, type CheckSpec } from '../ConnectReview'
import CountryFlag from '../CountryFlag'
import Spinner from '../Spinner'
import { ValueStrip } from '../plans/PlanDetailPane'
import { ChartIcon, EyeIcon, PlusIcon } from '../Icons'
import PlanNodesManager, { type NodeActionState } from './PlanNodesManager'
import { STATUS_ACTIVE, formatUdvpnAmount, usdEstimate } from '../../utils/provider-format'

// formatUdvpnAmount, not formatUdvpn: on the provider's own row a zero price must
// read "0 P2P". "free" is the consumer catalog's word, and it sat oddly next to
// figures the provider chose.
function planPrice(plan: MyPlan): string {
  const udvpn = plan.prices.find((p) => p.denom === 'udvpn')
  return udvpn ? formatUdvpnAmount(udvpn.quoteValue) : '-'
}

function planUsd(plan: MyPlan, price: TokenPrice | null): string | null {
  if (!price) return null
  const udvpn = plan.prices.find((p) => p.denom === 'udvpn')
  return udvpn ? usdEstimate(udvpn.quoteValue, price.usd) : null
}

/** "10 TB · 30d · 100,000 P2P", in the shared formatters the Plans tab uses too. */
function planFacts(plan: MyPlan): string {
  return `${formatBytes(plan.bytes)} · ${formatDuration(plan.durationSeconds)} · ${planPrice(plan)}`
}

/**
 * Exact P2P → udvpn conversion. String-based rather than `value * 1e6` so a price
 * typed as "12.35" can't land on chain as 12349999 through float rounding.
 * Returns null for anything that isn't a plain amount with at most 6 decimals.
 */
function p2pToUdvpn(input: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim())
  if (!match) return null
  const frac = (match[2] ?? '').padEnd(6, '0')
  return Number(match[1]) * 1_000_000 + Number(frac)
}

interface Props {
  plans: MyPlan[]
  leases: LeaseSummary[]
  providerActive: boolean
  /** Cached data, chain unreachable: every mutation is disabled. */
  readOnly: boolean
  /** The provider's own name. Feeds the test-plan heuristic, which reads the NAME, not the plan. */
  providerName: string
  /** Null while unread — the pricing hints simply don't render rather than guess. */
  economics: ProviderEconomics | null
  /** Resolves once the chain has been re-read, so a caller can hold its busy state until then. */
  onChanged: () => Promise<void>
  /**
   * Total nodes CONFIRMED linked across all plans, for the setup path. null when
   * the counters could not be read for every plan — never a guessed zero.
   */
  onLinkedNodesCounted: (count: number | null) => void
  /** Threaded to PlanNodesManager, which cannot own it. See NodeActionState. */
  nodeAction: NodeActionState
  /** The bar's Activate, for the one place leasing says it is blocked. */
  onActivateProvider: () => void
  activatingProvider: boolean
}

/**
 * The provider's plans: a compact list on the left, and on the right either the
 * Overview (no plan selected), the selected plan's workspace, or the new-plan form.
 * The Overview replaced an empty "Select a plan" pane that took half the window.
 */
export default function ProviderPlans({
  plans,
  leases,
  providerActive,
  readOnly,
  providerName,
  economics,
  onChanged,
  onLinkedNodesCounted,
  nodeAction,
  onActivateProvider,
  activatingProvider,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const selected = plans.find((p) => p.id === selectedId) ?? null
  // ONE confirm dialog for the whole pane, threaded to the workspace.
  const { requestConfirm, confirmDialog } = useConfirm()

  // Counters and the USD rate are extra chain/network reads, so they load after
  // the plans themselves and each row shows what it has. Keyed by the plan ids
  // as a string — the plans array is rebuilt on every refresh, its ids are not.
  // null until the first answer arrives; a per-plan null in the answer is a plan
  // the chain wouldn't answer for. statsFailed marks the whole batch failing.
  const [stats, setStats] = useState<Record<string, PlanStats | null> | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  const [price, setPrice] = useState<TokenPrice | null>(null)
  const planIds = plans.map((p) => p.id).join(',')

  const loadStats = useCallback(async () => {
    if (readOnly) {
      // The counters need the chain, which the tunnel blocks. Leaving them
      // unknown is honest; the rows say so instead of showing zeros.
      setStats(null)
      setStatsFailed(false)
      return
    }
    if (!planIds) {
      setStats({})
      setStatsFailed(false)
      return
    }
    try {
      setStats(await window.api.providerPlanStats(planIds.split(',')))
      setStatsFailed(false)
    } catch {
      setStatsFailed(true)
    }
  }, [planIds, readOnly])

  // Not `useEffect(loadStats, ...)`: an async callback returns a Promise, and an
  // effect may only return a cleanup function.
  useEffect(() => { void loadStats() }, [loadStats])

  useEffect(() => {
    window.api.priceToken().then(setPrice).catch(() => setPrice(null))
  }, [])

  // The setup path needs the linked total, CONFIRMED: every plan must have
  // answered, or the answer is null and the path shows "could not check".
  useEffect(() => {
    if (plans.length === 0) {
      onLinkedNodesCounted(0)
      return
    }
    if (!stats || statsFailed) {
      onLinkedNodesCounted(null)
      return
    }
    let total = 0
    for (const plan of plans) {
      const s = stats[plan.id]
      if (!s) {
        onLinkedNodesCounted(null)
        return
      }
      total += s.nodes
    }
    onLinkedNodesCounted(total)
  }, [plans, stats, statsFailed, onLinkedNodesCounted])

  // Linking a node or selling a subscription changes the counters without
  // changing the plan list, so every action re-reads both.
  //
  // Awaited, and that is the whole point: a button that clears its busy state
  // when the TX returns renders the pre-tx state for as long as the re-read takes,
  // so "Activate" reappears for a second before flipping to "Deactivate". Callers
  // await this, so the label goes straight from working to settled.
  const handleChanged = useCallback(async () => {
    await Promise.all([onChanged(), loadStats()])
  }, [onChanged, loadStats])

  const statsFor = (id: string): PlanStats | null | undefined => (stats ? stats[id] : readOnly ? null : undefined)
  const canCreate = providerActive && !readOnly

  // Up and Down move between Overview and the plans, selecting as they go, like the
  // catalog's rows. Enter and Space stay each button's own click.
  function onListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-plan-nav]'))
    const at = items.indexOf(e.target as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]
    const id = next.dataset.planNav
    setSelectedId(id === 'overview' || !id ? null : id)
    setCreating(false)
    next.focus()
  }

  return (
    <div className="flex-1 flex min-h-0">
      <aside onKeyDown={onListKeyDown} className="w-[260px] min-[1180px]:w-[300px] shrink-0 border-r border-border flex flex-col min-h-0">
        <button
          type="button"
          data-plan-nav="overview"
          aria-keyshortcuts="ArrowUp ArrowDown"
          onClick={() => { setSelectedId(null); setCreating(false) }}
          className={`w-full text-left px-4 py-3 border-b border-border flex items-center gap-2 text-sm font-medium transition-colors ${
            !selected && !creating ? 'bg-accent-subtle text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
          }`}
        >
          <ChartIcon className="w-3.5 h-3.5" />
          Overview
        </button>
        <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
          <span className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Your plans ({plans.length})</span>
          {statsFailed && (
            <button
              type="button"
              onClick={() => void loadStats()}
              className="text-warning text-[11px] hover:underline"
              title="The per-plan counters could not be read. Click to try again."
            >
              counters unavailable, retry
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {plans.length === 0 && (
            <p className="px-4 py-2 text-text-tertiary text-xs">
              No plans yet. A plan is what subscribers buy: gigabytes over a period, at your price,
              served by the nodes you link to it.
            </p>
          )}
          {plans.map((plan) => {
            const s = statsFor(plan.id)
            const isSelected = plan.id === selected?.id && !creating
            const active = plan.status === STATUS_ACTIVE
            return (
              <button
                key={plan.id}
                type="button"
                data-plan-nav={plan.id}
                aria-keyshortcuts="ArrowUp ArrowDown"
                onClick={() => { setSelectedId(plan.id); setCreating(false) }}
                className={`w-full text-left px-4 py-2.5 border-b border-border transition-colors ${
                  isSelected ? 'bg-accent-subtle' : 'hover:bg-bg-hover'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-accent font-mono text-xs shrink-0">#{plan.id}</span>
                  <span className="text-text-primary text-xs whitespace-nowrap truncate">{planFacts(plan)}</span>
                </span>
                {/* Wraps rather than cutting the counters off: the list is 260px wide
                    below 1180px, too narrow for both pills and all three counters. */}
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-1.5 text-[11px] text-text-tertiary">
                  <span className={`px-1.5 py-0.5 rounded-full leading-none ${active ? 'bg-success-subtle text-success' : 'bg-warning-subtle text-warning'}`}>
                    {active ? 'Live' : 'Inactive'}
                  </span>
                  {plan.private && <span className="px-1.5 py-0.5 rounded-full leading-none bg-info-subtle text-info">Private</span>}
                  <span className="max-w-full truncate">
                    {s ? `${s.nodes} node${s.nodes === 1 ? '' : 's'} · ${s.subscriptions} sold · ${s.truncated ? `${s.active}+` : s.active} active`
                      : s === null || statsFailed ? 'counters not readable'
                        : <span role="status" aria-label="Counting" className="skeleton inline-block h-2.5 w-36 align-middle" />}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="p-3 border-t border-border space-y-1.5">
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={!canCreate}
            className="btn btn-secondary w-full text-xs py-1.5 inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            New plan
          </button>
          {!canCreate && (
            <p className="text-text-tertiary text-[11px] text-center">
              {readOnly ? 'Disconnect the VPN to create plans.' : 'Needs an active provider.'}
            </p>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {creating ? (
          <CreatePlanForm
            price={price}
            economics={economics}
            providerName={providerName}
            readOnly={readOnly}
            requestConfirm={requestConfirm}
            onCancel={() => setCreating(false)}
            onCreated={() => {
              setCreating(false)
              void handleChanged()
            }}
          />
        ) : selected ? (
          <PlanWorkspace
            key={selected.id}
            plan={selected}
            stats={statsFor(selected.id)}
            statsUnknown={readOnly || statsFailed}
            price={price}
            providerActive={providerActive}
            readOnly={readOnly}
            providerName={providerName}
            economics={economics}
            leases={leases}
            requestConfirm={requestConfirm}
            onChanged={handleChanged}
            nodeAction={nodeAction}
            onActivateProvider={onActivateProvider}
            activatingProvider={activatingProvider}
          />
        ) : (
          <Overview
            plans={plans}
            leases={leases}
            stats={stats}
            statsUnknown={readOnly || statsFailed}
            economics={economics}
            onSelectPlan={setSelectedId}
          />
        )}
      </div>
      {confirmDialog}
    </div>
  )
}

function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{children}</h3>
      {right && <span className="text-xs">{right}</span>}
    </div>
  )
}

/**
 * When a lease's hours run out: what the chain will do, in words. Never and Always
 * are certain; the conditional policies depend on the node's price at the time.
 */
function renewalEnd(policy: number): { text: string; className: string } {
  if (policy === RENEWAL_POLICY.UNSPECIFIED) return { text: 'stops', className: 'text-danger' }
  if (policy === RENEWAL_POLICY.ALWAYS) return { text: 'renews', className: 'text-success' }
  if (policy === RENEWAL_POLICY.IF_LESSER_OR_EQUAL) return { text: 'renews if the price holds', className: 'text-text-secondary' }
  if (policy === RENEWAL_POLICY.IF_LESSER) return { text: 'renews only if cheaper', className: 'text-text-secondary' }
  return { text: renewalPolicyLabel(policy).toLowerCase(), className: 'text-text-secondary' }
}

function nodeName(node: SentNode | undefined, address: string): string {
  return node?.moniker || `${address.slice(0, 12)}...${address.slice(-4)}`
}

/**
 * The business at a glance, when no plan is selected: when each lease runs out, what
 * each node costs a day, and what each plan has brought in. Honest by construction:
 * the cost bars sum to the bar's Burn figure, income is labelled a minimum, and there
 * is no profit line (the chain deletes ended leases, so lifetime cost is unknowable).
 * A chart with one bar is a number, so one lease or one plan gets a figure instead.
 */
function Overview({ plans, leases, stats, statsUnknown, economics, onSelectPlan }: {
  plans: MyPlan[]
  leases: LeaseSummary[]
  stats: Record<string, PlanStats | null> | null
  statsUnknown: boolean
  economics: ProviderEconomics | null
  onSelectPlan: (id: string) => void
}) {
  const { allNodes } = useNodesContext()
  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])
  const runway = useMemo(() => leaseRunway(leases), [leases])
  // The same answer as the dot on the Provider tab label.
  const soonestStop = useMemo(() => leaseStopsSoon(leases), [leases])

  const costs = useMemo(() => leases
    .filter(isActiveLease)
    .map((l) => ({ lease: l, daily: BigInt(l.hourlyPrice) * 24n }))
    .sort((a, b) => (b.daily > a.daily ? 1 : b.daily < a.daily ? -1 : 0)), [leases])
  const maxCost = costs.reduce((m, c) => (c.daily > m ? c.daily : m), 0n)

  // Income per plan, by the same shared maths main uses for the total: subscriptions
  // sold times the price net of the chain's share. null when it cannot be computed.
  const income = useMemo(() => {
    if (!stats || statsUnknown || !economics) return null
    let share: bigint
    try { share = parseDecShare(economics.subscriptionStakingShare) } catch { return null }
    return plans.flatMap((plan) => {
      const s = stats[plan.id]
      const udvpn = plan.prices.find((p) => p.denom === 'udvpn')?.quoteValue
      if (!s || !udvpn || !/^\d+$/.test(udvpn)) return []
      return [{ plan, sold: s.subscriptions, net: BigInt(netOfStakingShare(udvpn, share)) * BigInt(s.subscriptions) }]
    }).sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))
  }, [plans, stats, statsUnknown, economics])
  const maxIncome = income?.reduce((m, r) => (r.net > m ? r.net : m), 0n) ?? 0n
  const pct = (v: bigint, max: bigint) => (max > 0n ? Math.max(1, Number((v * 1000n) / max) / 10) : 0)

  return (
    <div className="p-5 space-y-4">
      <section className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
        <SectionTitle right={soonestStop && (
          <span className="text-warning">
            {nodeName(nodeIndex.get(soonestStop.nodeAddress), soonestStop.nodeAddress)} stops in {formatDuration(soonestStop.hoursLeft * 3600)} and will not renew
          </span>
        )}>
          Lease runway, soonest end first
        </SectionTitle>
        {runway.rows.length === 0 ? (
          <div className="space-y-3">
            {/* Decorative: where the bars will be. The sentence says it. */}
            <div aria-hidden className="space-y-2.5">
              {[82, 46, 64].map((w) => (
                <div key={w} className="h-2.5 rounded-full border border-dashed border-border" style={{ width: `${w}%` }} />
              ))}
            </div>
            <p className="text-text-secondary text-sm">
              No leases yet. Each node you lease shows here as a bar of the hours it has left, so you
              can see which one stops first.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)_auto] gap-x-3 gap-y-2.5 items-center">
            {runway.rows.map((r) => {
              const node = nodeIndex.get(r.nodeAddress)
              const end = renewalEnd(r.renewalPricePolicy)
              const stops = r.renewalPricePolicy === RENEWAL_POLICY.UNSPECIFIED
              return (
                <div key={r.id} className="contents">
                  <span className="flex items-center gap-2 min-w-0 text-sm">
                    {node && <CountryFlag country={node.country} />}
                    <span className="truncate text-text-primary">{nodeName(node, r.nodeAddress)}</span>
                  </span>
                  <span
                    className="h-2 rounded-full bg-bg-tertiary relative"
                    title={`${r.hoursLeft} of ${r.maxHours} hours left. ${renewalPolicyLabel(r.renewalPricePolicy)}.`}
                  >
                    <span
                      className={`absolute inset-y-0 left-0 rounded-full min-w-[4px] ${stops ? 'bg-danger' : 'bg-accent'}`}
                      style={{ width: `${r.fraction * 100}%` }}
                    />
                  </span>
                  <span className="text-xs whitespace-nowrap">
                    <span className="font-mono text-text-primary">{formatDuration(r.hoursLeft * 3600)} left</span>
                    <span className={`ml-2 ${end.className}`}>{end.text}</span>
                  </span>
                </div>
              )
            })}
            <span />
            <span className="flex justify-between text-[10px] font-mono text-text-tertiary">
              <span>now</span>
              <span>{formatDuration((runway.axisHours / 2) * 3600)}</span>
              <span>{formatDuration(runway.axisHours * 3600)}</span>
            </span>
            <span />
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 min-[1100px]:grid-cols-2 gap-4">
        <section className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
          <SectionTitle right={economics && economics.activeLeases > 0 && (
            <span className="font-mono text-text-primary">{formatUdvpnAmount(economics.burnDailyUdvpn)}</span>
          )}>
            Cost by node, per day
          </SectionTitle>
          {costs.length === 0 ? (
            <p className="text-text-secondary text-sm">
              Nothing is being spent. Leases are billed by the hour whether or not anyone connects.
            </p>
          ) : costs.length === 1 ? (
            <p className="text-sm text-text-secondary">
              <span className="text-text-primary text-lg font-semibold">{formatUdvpnAmount(costs[0].daily.toString())}</span> a day for{' '}
              {nodeName(nodeIndex.get(costs[0].lease.nodeAddress), costs[0].lease.nodeAddress)}, billed whether or not anyone connects.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-[minmax(90px,140px)_minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-center text-xs">
                {costs.map(({ lease, daily }) => (
                  <div key={lease.id} className="contents">
                    <span className="truncate text-text-secondary">{nodeName(nodeIndex.get(lease.nodeAddress), lease.nodeAddress)}</span>
                    <span className="h-2 rounded-full bg-bg-tertiary relative" title={`${formatUdvpnAmount(daily.toString())} a day`}>
                      <span className="absolute inset-y-0 left-0 rounded-full bg-accent min-w-[3px]" style={{ width: `${pct(daily, maxCost)}%` }} />
                    </span>
                    <span className="font-mono text-text-primary text-right">{formatUdvpnAmount(daily.toString())}</span>
                  </div>
                ))}
              </div>
              <p className="text-text-tertiary text-[11px] mt-3">Billed hourly whether or not anyone connects. The bars add up to the Burn figure above.</p>
            </>
          )}
        </section>

        <section className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
          <SectionTitle right={economics && economics.estimatedRevenueUdvpn !== '0' && (
            <span className="font-mono text-text-primary">{formatUdvpnAmount(economics.estimatedRevenueUdvpn)}</span>
          )}>
            Income by plan, at least
          </SectionTitle>
          {income === null ? (
            <p className="text-text-secondary text-sm">
              {plans.length === 0 ? 'No plans yet.' : 'The per-plan counters are not readable right now.'}
            </p>
          ) : income.every((r) => r.sold === 0) ? (
            <p className="text-text-secondary text-sm">No subscriptions sold yet.</p>
          ) : income.length === 1 ? (
            <p className="text-sm text-text-secondary">
              <span className="text-text-primary text-lg font-semibold">{formatUdvpnAmount(income[0].net.toString())}</span> from{' '}
              {income[0].sold} subscription{income[0].sold === 1 ? '' : 's'} to{' '}
              <button type="button" onClick={() => onSelectPlan(income[0].plan.id)} className="text-accent hover:underline">plan #{income[0].plan.id}</button>,
              after the chain's share.
            </p>
          ) : (
            <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-center text-xs">
              {income.map(({ plan, sold, net }) => (
                <div key={plan.id} className="contents">
                  <button type="button" onClick={() => onSelectPlan(plan.id)} className="font-mono text-accent hover:underline text-left">#{plan.id}</button>
                  <span className="h-2 rounded-full bg-bg-tertiary relative" title={`${sold} sold`}>
                    {net > 0n && <span className="absolute inset-y-0 left-0 rounded-full bg-accent min-w-[3px]" style={{ width: `${pct(net, maxIncome)}%` }} />}
                  </span>
                  <span className="font-mono text-text-primary text-right">{formatUdvpnAmount(net.toString())}</span>
                </div>
              ))}
            </div>
          )}
          {income !== null && income.some((r) => r.sold > 0) && (
            <p className="text-text-tertiary text-[11px] mt-3">
              Subscriptions sold times the price, after the chain's share. A minimum: renewals can charge
              again without a new subscription.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * One plan: its facts and its two switches, the counters with the break-even meter,
 * whether subscribers will find it, and the nodes serving it. The switches keep the
 * confirm text and the in-flight rules the old row buttons had.
 */
function PlanWorkspace({
  plan,
  stats,
  statsUnknown,
  price,
  providerActive,
  readOnly,
  providerName,
  economics,
  leases,
  requestConfirm,
  onChanged,
  nodeAction,
  onActivateProvider,
  activatingProvider,
}: {
  plan: MyPlan
  /** undefined while the counters are still being read, null if they couldn't be. */
  stats: PlanStats | null | undefined
  /** True when no counter for this batch is trustworthy (cached data or a failed read). */
  statsUnknown: boolean
  price: TokenPrice | null
  providerActive: boolean
  readOnly: boolean
  providerName: string
  economics: ProviderEconomics | null
  leases: LeaseSummary[]
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  onChanged: () => Promise<void>
  nodeAction: NodeActionState
  onActivateProvider: () => void
  activatingProvider: boolean
}) {
  const active = plan.status === STATUS_ACTIVE
  const { goToPlanInCatalog } = useNavigation()
  // Which action is running AND what it is moving to, not merely that one is.
  //
  // Two reasons it carries both. There are two switches, and a shared boolean put
  // the spinner on whichever one you did not touch. And `plan` is live chain data
  // that changes UNDER these switches: `onChanged()` calls setData while it runs and
  // the busy flag only clears a microtask later, so there is a render showing the
  // NEW value with the spinner still going. While an action is in flight each switch
  // keeps its pre-action value and shows the spinner on the target, so it settles in
  // one visible step.
  const [busy, setBusy] = useState<{ kind: 'status' | 'private'; target: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shownActive = busy?.kind === 'status' ? !busy.target : active
  const shownPrivate = busy?.kind === 'private' ? !busy.target : plan.private
  const usd = planUsd(plan, price)

  /**
   * Flip the plan between public and private.
   *
   * Only possible because provider-msgs registers MsgUpdatePlanDetails itself:
   * the SDK omits it, which made `private` a create-once decision. The chain
   * imposes no status precondition, so this works on a live plan.
   */
  async function togglePrivate() {
    const next = !plan.private
    if (!(await requestConfirm({
      title: next ? `Make plan #${plan.id} private?` : `Make plan #${plan.id} public?`,
      body: [
        next
          ? 'It stays active and existing subscriptions are unaffected, but it drops out of the catalog for anyone who has not chosen to show private plans.'
          : 'It appears in the catalog for every subscriber browsing plans.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: next ? 'Make private' : 'Make public',
    }))) return
    setBusy({ kind: 'private', target: next })
    setError(null)
    try {
      await window.api.providerPlanSetPrivate(plan.id, next)
      // Awaited so the switch stays busy through the re-read and never flashes
      // the old value back on the way to the new one.
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the plan visibility')
    } finally {
      setBusy(null)
    }
  }

  async function toggleStatus() {
    if (!(await requestConfirm(
      active
        ? {
            title: `Deactivate plan #${plan.id}?`,
            body: ['It stops being offered to new subscribers. This is an on-chain transaction.'],
            confirmLabel: 'Deactivate',
            danger: true,
          }
        : {
            title: `Activate plan #${plan.id}?`,
            body: activateBody(plan, stats, providerName),
            confirmLabel: 'Activate',
          },
    ))) return
    setBusy({ kind: 'status', target: !active })
    setError(null)
    try {
      await window.api.providerPlanSetStatus(plan.id, !active)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed')
    } finally {
      setBusy(null)
    }
  }

  // Activating needs an active provider (the chain refuses otherwise);
  // deactivating does not. Both need the chain reachable.
  const statusLock = readOnly ? 'The chain is not reachable while the VPN is connected'
    : !active && !providerActive ? 'Activate your provider first' : false
  const privateLock = readOnly ? 'The chain is not reachable while the VPN is connected' : false

  const checks = visibilityChecks({
    plan, stats, statsUnknown, providerName, providerActive, readOnly,
    onActivate: toggleStatus, onMakePublic: togglePrivate, busy: busy !== null,
  })

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <h2 className="text-text-primary text-[17px] font-semibold">Plan #{plan.id}</h2>
        <Segmented
          label="Plan status"
          value={shownActive ? 'active' : 'inactive'}
          options={[['active', 'Active'], ['inactive', 'Inactive']]}
          onChange={() => void toggleStatus()}
          disabled={statusLock || (busy !== null && busy.kind !== 'status')}
          pending={busy?.kind === 'status' ? (busy.target ? 'active' : 'inactive') : null}
        />
        <Segmented
          label="Plan visibility"
          value={shownPrivate ? 'private' : 'public'}
          options={[['public', 'Public'], ['private', 'Private']]}
          onChange={() => void togglePrivate()}
          disabled={privateLock || (busy !== null && busy.kind !== 'private')}
          pending={busy?.kind === 'private' ? (busy.target ? 'private' : 'public') : null}
        />
        <span className="ml-auto text-sm text-text-secondary whitespace-nowrap">
          {formatBytes(plan.bytes)} · {formatDuration(plan.durationSeconds)} ·{' '}
          <span className="text-text-primary">{planPrice(plan)}</span>
          {usd && <span className="text-text-tertiary"> {usd}</span>}
        </span>
      </div>
      {error && (
        <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
          <p className="text-danger text-xs">{displayConnectError(error)}</p>
        </div>
      )}

      <StatStrip plan={plan} stats={stats} statsUnknown={statsUnknown} economics={economics} />

      <div className="bg-bg-secondary border border-border rounded-md px-3 py-3">
        <ChecksSection title="Will subscribers find it?" checks={checks} />
        {/* The catalog only ever lists active plans, so there is nothing to see for
            an inactive one: the status check above already says why. */}
        <div className="flex justify-end px-2.5 mt-1.5">
          <button
            type="button"
            onClick={() => goToPlanInCatalog(plan.id)}
            disabled={!active}
            title={active
              ? 'Open the Plans tab on this plan, with the catalog\'s default filters'
              : 'Inactive plans are never listed in the catalog'}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent transition-colors disabled:opacity-40 disabled:hover:text-text-secondary disabled:cursor-not-allowed"
          >
            <EyeIcon className="w-3.5 h-3.5" />
            See it as a subscriber
          </button>
        </div>
      </div>

      <PlanNodesManager
        plan={plan}
        leases={leases}
        price={price}
        economics={economics}
        providerActive={providerActive}
        readOnly={readOnly}
        onChanged={onChanged}
        nodeAction={nodeAction}
        onActivateProvider={onActivateProvider}
        activatingProvider={activatingProvider}
      />
    </div>
  )
}

/**
 * The counters, and the break-even meter: active subscribers against the number that
 * would cover every running lease if this plan alone paid for them. The same
 * computation as the create form's hint, so it is advisory and never blocks.
 */
function StatStrip({ plan, stats, statsUnknown, economics }: {
  plan: MyPlan
  stats: PlanStats | null | undefined
  statsUnknown: boolean
  economics: ProviderEconomics | null
}) {
  const unknown = stats === null || (stats === undefined && statsUnknown)
  const val = (n: number | undefined) => (stats ? String(n) : unknown ? '?' : '…')

  const breakEven = useMemo(() => {
    if (!economics) return null
    const udvpn = plan.prices.find((p) => p.denom === 'udvpn')?.quoteValue
    const days = plan.durationSeconds ? Math.round(plan.durationSeconds / 86400) : 0
    if (!udvpn || !/^\d+$/.test(udvpn) || days <= 0) return null
    try {
      const net = netOfStakingShare(udvpn, parseDecShare(economics.subscriptionStakingShare))
      return computeBreakEven({ dailyBurnUdvpn: economics.burnDailyUdvpn, netPricePerSubUdvpn: net, durationDays: days })
    } catch {
      return null
    }
  }, [plan, economics])

  const cell = 'px-4 py-2.5 border-r border-border min-w-0'
  return (
    <div className="grid grid-cols-[1fr_1fr_1fr_2fr] bg-bg-secondary border border-border rounded-md">
      <div className={cell} title="Nodes linked to this plan">
        <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Nodes</div>
        <div className="text-text-primary text-lg font-semibold">{val(stats?.nodes)}</div>
      </div>
      <div className={cell} title="Subscriptions ever bought for this plan (one account can hold several)">
        <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Sold</div>
        <div className="text-text-primary text-lg font-semibold">{val(stats?.subscriptions)}</div>
      </div>
      <div
        className={cell}
        title={stats?.truncated ? `At least ${stats.active} are active: this plan has too many subscriptions to count them all` : 'Subscriptions currently active'}
      >
        <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Active now</div>
        <div className={`text-lg font-semibold ${stats && stats.active > 0 ? 'text-success' : 'text-text-primary'}`}>
          {stats ? (stats.truncated ? `${stats.active}+` : stats.active) : val(undefined)}
        </div>
      </div>
      <div className="px-4 py-2.5 min-w-0">
        <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">Break-even</div>
        {breakEven === null ? (
          <div className="text-text-secondary text-xs mt-1.5">Not computable right now</div>
        ) : breakEven.kind === 'no-burn' ? (
          <div className="text-text-secondary text-xs mt-1.5">No leases running, so no costs to cover</div>
        ) : breakEven.kind === 'never' ? (
          <div className="text-warning text-xs mt-1.5">At this price you keep nothing per subscription</div>
        ) : (
          <div className="flex items-center gap-2.5 mt-1.5">
            <span
              className="flex-1 h-2 rounded-full bg-bg-tertiary relative"
              role="img"
              aria-label={`${stats ? stats.active : 'unknown'} active subscribers against ${breakEven.count} needed`}
            >
              {stats && (
                <span
                  className={`absolute inset-y-0 left-0 rounded-full min-w-[3px] ${stats.active >= breakEven.count ? 'bg-success' : 'bg-accent'}`}
                  style={{ width: `${Math.min(100, (stats.active / breakEven.count) * 100)}%` }}
                />
              )}
            </span>
            <span
              className="text-xs text-text-secondary whitespace-nowrap"
              title="Active subscribers this plan would need to cover every running lease on its own."
            >
              ~{breakEven.count.toLocaleString('en-US')} needed{stats ? `, ${stats.active >= breakEven.count ? 'covered' : `${stats.active} now`}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Whether subscribers will find the plan, as live checks rather than a paragraph in
 * the Activate confirm. Two different questions, kept apart as activateBody does:
 * what the CHAIN allows (active, a real chain flag for private) and what this app's
 * catalog shows by default ("Ready to connect" drops a plan counted at zero nodes, and
 * "Test plans" is a guess from the PROVIDER NAME). An unconfirmed node count is never
 * reported as zero.
 */
function visibilityChecks({ plan, stats, statsUnknown, providerName, providerActive, readOnly, onActivate, onMakePublic, busy }: {
  plan: MyPlan
  stats: PlanStats | null | undefined
  statsUnknown: boolean
  providerName: string
  providerActive: boolean
  readOnly: boolean
  onActivate: () => void
  onMakePublic: () => void
  busy: boolean
}): CheckSpec[] {
  const action = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      disabled={readOnly || busy}
      className="btn btn-secondary text-xs px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  )
  const checks: CheckSpec[] = []
  checks.push(plan.status === STATUS_ACTIVE
    ? { id: 'status', tone: 'success', text: 'Active: subscribers can buy it.' }
    : {
        id: 'status',
        tone: 'danger',
        text: providerActive ? 'Inactive, so it cannot be bought.' : 'Inactive, and it can only be activated once your provider is.',
        action: providerActive ? action('Activate', onActivate) : undefined,
      })
  checks.push(plan.private
    ? {
        id: 'private',
        tone: 'warning',
        text: 'Private: only buyers who tick the Private filter see it.',
        tipLabel: 'About private plans',
        tip: 'Private is a flag on chain, so other Sentinel apps should hide the plan too. Existing subscriptions are unaffected either way.',
        action: action('Make public', onMakePublic),
      }
    : { id: 'private', tone: 'success', text: 'Public: listed for everyone browsing plans.' })
  if (stats) {
    checks.push(stats.nodes > 0
      ? { id: 'nodes', tone: 'success', text: `Served by ${stats.nodes} linked node${stats.nodes === 1 ? '' : 's'}.` }
      : {
          id: 'nodes',
          tone: 'danger',
          text: 'No nodes linked, so the catalog hides it by default and a buyer would have nothing to connect to.',
          tipLabel: 'Why no nodes hides it',
          tip: 'The catalog\'s "Ready to connect" filter is on by default and drops any plan counted at zero nodes. Lease and link a node below; you can do that without deactivating.',
        })
  } else if (stats === undefined && !statsUnknown) {
    checks.push({ id: 'nodes', tone: 'busy', text: 'Counting linked nodes' })
  } else {
    checks.push({ id: 'nodes', tone: 'warning', text: 'The linked-node count could not be read right now.' })
  }
  if (isTestPlan(providerName)) {
    checks.push({
      id: 'test',
      tone: 'warning',
      text: `"${providerName}" reads as a test account, so the catalog files the plan under Test plans, hidden by default.`,
      tipLabel: 'Why the name matters',
      tip: 'This is a guess this app makes from the provider name, not anything the chain records. Renaming the provider with Edit details, at the top, changes it.',
    })
  }
  return checks
}

/**
 * Create a plan. It lands INACTIVE on chain — activation is a separate tx, offered
 * in its workspace once it appears — so nothing here needs to track a half-created plan.
 *
 * Laid out as a plan's workspace (2026-10-07): the terms with their break-even, where
 * the price sits among the plans a subscriber is shown, the workspace's "Will
 * subscribers find it?" checks worked out for the draft, and the steps after it, with
 * the buttons in a footer that does not scroll away. The checks replaced a line that
 * said "Listed in the catalog once it is active", which was false for a provider
 * whose name reads as a test account and for every plan created with no nodes.
 */
function CreatePlanForm({ price: tokenPrice, economics, providerName, readOnly, requestConfirm, onCancel, onCreated }: {
  price: TokenPrice | null
  economics: ProviderEconomics | null
  providerName: string
  /** The console went read-only (tunnel up, or the chain read failed) after this form opened. */
  readOnly: boolean
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  onCancel: () => void
  onCreated: () => void
}) {
  const [gigabytes, setGigabytes] = useState('100')
  const [days, setDays] = useState('30')
  const [price, setPrice] = useState('10')
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { overview } = usePlansContext()
  const { allNodes } = useNodesContext()

  const gb = Number(gigabytes)
  const dayCount = Number(days)
  const priceUdvpn = p2pToUdvpn(price)
  // The bounds are main's own (PROVIDER_PLAN_CREATE), said here before they cost a
  // round-trip: past them the handler refused with a bare "Invalid gigabytes".
  const gbOk = Number.isInteger(gb) && gb > 0 && gb <= 1_000_000
  const daysOk = Number.isInteger(dayCount) && dayCount > 0 && dayCount <= 3650
  const priceOk = priceUdvpn !== null && priceUdvpn <= 1_000_000_000_000
  const valid = gbOk && daysOk && priceOk
  const termsProblem = !gbOk ? 'Size must be a whole number of GB, from 1 to 1,000,000.'
    : !daysOk ? 'Days must be a whole number, from 1 to 3,650.'
      : !priceOk ? 'Price must be an amount in P2P with up to 6 decimals, at most 1,000,000.'
        : null

  // The draft as the catalog would hold it, for the value strip. Decimal GB, as main
  // writes it (provider-msgs BYTES_PER_GB).
  const draft = valid && priceUdvpn !== null
    ? {
        id: 'draft',
        bytes: (BigInt(gb) * 1_000_000_000n).toString(),
        durationSeconds: dayCount * 86400,
        prices: [{ denom: 'udvpn', baseValue: '', quoteValue: String(priceUdvpn) }],
      }
    : null
  const perGb = draft ? pricePerGb(draft) : null
  const usd = valid && priceUdvpn !== null && tokenPrice ? usdEstimate(priceUdvpn, tokenPrice.usd) : null
  const nodeMedian = useMemo(() => nodeMedianPerGb(allNodes), [allNodes])
  // What a subscriber is shown with the catalog's DEFAULT filters, the same picture
  // "See it as a subscriber" checks against.
  const listedPerGb = useMemo(
    () => overview.plans
      .filter((p) => p.status === STATUS_ACTIVE && !p.private && !p.isTest && p.nodeCount !== 0)
      .flatMap((p) => {
        const v = pricePerGb(p)
        return v === null ? [] : [{ id: p.id, perGb: v }]
      }),
    [overview.plans],
  )

  // How many subscribers this price would need to cover the running lease burn.
  // Advisory only — it never gates the button, because pricing below cost to win
  // subscribers is a legitimate strategy, not a mistake to be blocked.
  const breakEven = useMemo(() => {
    if (!economics || priceUdvpn === null || !Number.isInteger(dayCount) || dayCount <= 0) return null
    const net = netOfStakingShare(String(priceUdvpn), parseDecShare(economics.subscriptionStakingShare))
    return {
      net,
      burnDailyUdvpn: economics.burnDailyUdvpn,
      result: computeBreakEven({
        dailyBurnUdvpn: economics.burnDailyUdvpn,
        netPricePerSubUdvpn: net,
        durationDays: dayCount,
      }),
    }
  }, [economics, priceUdvpn, dayCount])

  const checks: CheckSpec[] = [
    isPrivate
      ? {
          id: 'private',
          tone: 'warning',
          text: 'Private: only buyers who tick the Private filter will see it.',
          tipLabel: 'About private plans',
          tip: 'Private is a flag on chain, so other Sentinel apps should hide the plan too. You can change it later from the plan\'s page.',
          action: (
            <button type="button" onClick={() => setIsPrivate(false)} className="btn btn-secondary text-xs px-2.5 py-1">
              Make public
            </button>
          ),
        }
      : { id: 'private', tone: 'success', text: 'Public: listed for everyone browsing plans.' },
  ]
  if (isTestPlan(providerName)) {
    checks.push({
      id: 'test',
      tone: 'warning',
      text: `"${providerName}" reads as a test account, so the catalog files the plan under Test plans, hidden by default.`,
      tipLabel: 'Why the name matters',
      tip: 'This is a guess this app makes from the provider name, not anything the chain records. Renaming the provider with Edit details, at the top, changes it.',
    })
  }
  checks.push({
    id: 'nodes',
    tone: 'warning',
    text: 'No nodes linked yet, so the catalog hides it by default until you link one.',
    tipLabel: 'Why no nodes hides it',
    tip: 'The catalog\'s "Ready to connect" filter is on by default and drops any plan counted at zero nodes. You lease and link nodes on the plan\'s own page once it exists.',
  })

  const hasLeases = economics !== null && economics.activeLeases > 0
  const steps = ['Create it', hasLeases ? 'Link a node' : 'Lease and link a node', 'Activate it']

  async function handleCreate() {
    if (!valid || priceUdvpn === null) return
    if (!(await requestConfirm({
      title: `Create a plan for ${gb} GB over ${dayCount} days at ${formatUdvpnAmount(priceUdvpn)}?`,
      body: ['It is created inactive, and you activate it afterwards. This is an on-chain transaction.'],
      confirmLabel: 'Create plan',
    }))) return
    setBusy(true)
    setError(null)
    try {
      await window.api.providerPlanCreate({ gigabytes: gb, days: dayCount, priceUdvpn, private: isPrivate })
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the plan')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <h2 className="text-text-primary text-[17px] font-semibold">New plan</h2>
            <Segmented
              label="Visibility"
              value={isPrivate ? 'private' : 'public'}
              options={[['public', 'Public'], ['private', 'Private']]}
              onChange={(v) => setIsPrivate(v === 'private')}
            />
            {draft && priceUdvpn !== null && (
              <span className="ml-auto text-sm text-text-secondary whitespace-nowrap">
                {formatBytes(draft.bytes)} · {formatDuration(draft.durationSeconds)} ·{' '}
                <span className="text-text-primary">{formatUdvpnAmount(priceUdvpn)}</span>
                {usd && <span className="text-text-tertiary"> {usd}</span>}
              </span>
            )}
          </div>
          <p className="text-text-tertiary text-xs mt-1">What subscribers buy: gigabytes over a period, at your price, served by the nodes you link to it.</p>
        </div>

        <section className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
          <SectionTitle>Terms</SectionTitle>
          <div className="space-y-2.5">
            <TermRow label="Data" unit="GB" value={gigabytes} onChange={setGigabytes} presets={[10, 100, 1000]} invalid={!gbOk}
              hint={gbOk && gb >= 1000 && draft ? formatBytes(draft.bytes) : null} />
            <TermRow label="Valid for" unit="days" value={days} onChange={setDays} presets={[7, 30, 90, 365]} invalid={!daysOk} />
            <TermRow label="Price" unit="P2P" value={price} onChange={setPrice} invalid={!priceOk}
              hint={perGb !== null ? `${formatPerGb(perGb)} P2P per GB` : null} />
          </div>
          {valid && breakEven && (
            <div className="border-t border-border mt-3.5 pt-3">
              <BreakEvenHint {...breakEven} />
            </div>
          )}
        </section>

        <section className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
          {draft ? (
            <ValueStrip plan={draft} perGb={perGb} listed={listedPerGb} nodeMedian={nodeMedian}
              headingClassName="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary" />
          ) : (
            <>
              <SectionTitle>Value per GB</SectionTitle>
              <p className="text-text-secondary text-sm">Fix the terms above to see where the price sits.</p>
            </>
          )}
          {draft && <p className="text-text-tertiary text-[11px] mt-2">
            {overview.fetchedAt === null
              ? 'The plan catalog has not been read yet, so this compares against nodes only. Opening the Plans tab reads it.'
              : listedPerGb.length === 0
                ? `No plan a subscriber is shown with the catalog's default filters has a price per GB, so this compares against nodes only (catalog scan ${formatTimeAgo(overview.fetchedAt)}).`
                : `Other listed plans: the ${listedPerGb.length.toLocaleString('en-US')} with a price per GB that a subscriber is shown with the catalog's default filters, from its scan ${formatTimeAgo(overview.fetchedAt)}.`}
          </p>}
        </section>

        <div className="bg-bg-secondary border border-border rounded-md px-3 py-3">
          <ChecksSection title="Will subscribers find it?" checks={checks} />
        </div>

        <section className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
          <SectionTitle>What happens next</SectionTitle>
          {/* The provider setup route's discs and links (ProviderConsole SetupRoute),
              so the steps read as the same kind of picture. */}
          <div role="list" aria-label="Steps to selling the plan" className="flex items-center max-w-2xl">
            {steps.map((label, i) => (
              <Fragment key={label}>
                {i > 0 && <span className="route-link route-link-dim flex-1 min-w-[14px] mx-2" />}
                <span role="listitem" className="flex items-center gap-2 shrink-0">
                  <span className={`${i === 0 ? 'route-disc route-disc-done' : 'route-disc route-disc-waiting'} w-6 h-6`}>
                    <span className={`font-mono text-[11px] ${i === 0 ? 'text-accent' : ''}`}>{i + 1}</span>
                  </span>
                  <span className={`text-xs whitespace-nowrap ${i === 0 ? 'text-text-primary font-medium' : 'text-text-tertiary'}`}>{label}</span>
                </span>
              </Fragment>
            ))}
          </div>
          <p className="text-text-secondary text-xs mt-2.5">
            It lands inactive, so nobody can buy it until step 3. Steps 2 and 3 are on the plan&apos;s own
            page: select it in the list once it is created.
          </p>
        </section>
      </div>

      <div className="shrink-0 border-t border-border px-5 pt-3.5 pb-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="flex-1 min-w-[240px] space-y-1.5">
          {error ? <FooterReason text={displayConnectError(error)} />
            : readOnly ? <FooterReason tone="muted" text="Disconnect the VPN to create this plan." />
              : termsProblem && <FooterReason text={termsProblem} />}
          <p className="text-text-tertiary text-[11px]">This is an on-chain transaction, and costs the network fee only.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-secondary text-sm py-2 px-4 disabled:opacity-40 disabled:cursor-not-allowed">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!valid || busy || readOnly}
            className="btn btn-primary text-sm py-2 px-6 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
          >
            {busy && <Spinner size="sm" />}
            {busy ? 'Creating…' : 'Create plan'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * What activating this plan is about to mean, in full.
 *
 * Two separate questions get conflated here, so the copy keeps them apart:
 *
 * 1. What the CHAIN does. MsgUpdatePlanStatus checks ownership and that the
 *    PROVIDER is active, and nothing else, because linking nodes is a separate
 *    message with its own lease precondition. So an empty plan can go live and be
 *    sold with nothing to serve the buyer. Worth saying out loud, not worth
 *    blocking, the same line BreakEvenHint draws.
 * 2. Whether anyone will FIND it. That is the consumer catalog's business, and
 *    three of its filters can hide a freshly activated plan, two of which are
 *    invisible from this tab. `private` is a real chain flag; "Test plans" is this
 *    app's own guess from the PROVIDER NAME (shared/test-plan.ts), which surprises
 *    anyone who called their provider something with "test" in it; and
 *    "Ready to connect" (on by default) drops any plan counted at zero nodes.
 *
 * The zero node count has to be CONFIRMED. `stats` is undefined while the counters
 * load and null when the chain read failed, and neither means "no nodes" — warning
 * on those would put a false accusation in front of the one action the provider
 * came here to take.
 */
function activateBody(plan: MyPlan, stats: PlanStats | null | undefined, providerName: string): string[] {
  // Optional chaining IS the confirmed-zero test: undefined (loading) and null
  // (read failed) both compare false against 0.
  const nodeless = stats?.nodes === 0
  const looksLikeTest = isTestPlan(providerName)
  const hidden = plan.private || looksLikeTest || nodeless

  const body = [
    hidden
      ? 'The chain will let subscribers buy it. Whether they can find it is a separate matter, and right now this app keeps it out of the default catalog view:'
      : 'It appears in the plan catalog and subscribers can buy it.',
  ]

  if (plan.private) {
    body.push(
      'It is private, so only subscribers who tick the "Private" filter will see it. That flag is on chain, so other Sentinel clients should honour it too.',
    )
  }
  if (looksLikeTest) {
    body.push(
      `This app reads your provider name ("${providerName}") as a test account, so it files the plan under "Test plans" and hides it by default. That is a local guess from the name, not anything the chain records.`,
    )
  }
  if (nodeless) {
    body.push(
      'It has no nodes linked, so anyone who does buy it has nothing to connect to, and the default "Ready to connect" filter drops it. You can lease and link nodes afterwards without deactivating.',
    )
  }

  body.push('This is an on-chain transaction.')
  return body
}

/**
 * Translates the plan price into the number of subscribers that would cover the
 * lease burn — the one figure connecting the two halves of the business, since
 * nodes bill by time and plans sell by allocation.
 *
 * Advisory: nothing here disables the Create button. A provider may knowingly price
 * below cost to win subscribers, and the app has no business overruling that.
 */
function BreakEvenHint({ net, burnDailyUdvpn, result }: {
  net: string
  burnDailyUdvpn: string
  result: ReturnType<typeof computeBreakEven>
}) {
  // No leases yet, so there is no burn to break even against. Nothing is wrong and
  // nothing is blocked, so this says so plainly; the form's steps say what comes next.
  if (result.kind === 'no-burn') {
    return (
      <p className="text-text-tertiary text-xs">
        No nodes leased yet, so there are no running costs to break even against.
      </p>
    )
  }

  if (result.kind === 'never') {
    return (
      <p className="text-warning text-xs">
        At this price you keep nothing per subscription, so this plan can never cover the{' '}
        {formatUdvpnAmount(burnDailyUdvpn)}/day your nodes cost. That is allowed, just make sure it&apos;s deliberate.
      </p>
    )
  }

  return (
    <p className="text-text-tertiary text-xs">
      Your nodes cost <span className="text-text-secondary">{formatUdvpnAmount(burnDailyUdvpn)}/day</span>. You keep{' '}
      <span className="text-text-secondary">{formatUdvpnAmount(net)}</span> per subscription after the chain&apos;s cut,
      so this plan breaks even at{' '}
      <span className="text-text-primary">
        ~{result.count.toLocaleString('en-US')} active subscriber{result.count === 1 ? '' : 's'}
      </span>.
    </p>
  )
}

/** "Data  [ 100 | GB ]  10 100 1,000": one term of the plan, its unit, and presets. */
function TermRow({ label, unit, value, onChange, presets, invalid, hint }: {
  label: string
  unit: string
  value: string
  onChange: (v: string) => void
  presets?: number[]
  invalid: boolean
  hint?: string | null
}) {
  return (
    <div className="flex items-center gap-x-2.5 gap-y-2 flex-wrap">
      <span className="w-[72px] shrink-0 text-sm text-text-secondary">{label}</span>
      <span className={`inline-flex items-stretch border rounded-sm overflow-hidden ${
        invalid ? 'border-danger' : 'border-border focus-within:border-border-focus'
      }`}>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          aria-label={`${label}, in ${unit}`}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
          className="w-24 bg-bg-primary text-text-primary text-right text-sm font-mono font-semibold px-2 py-1 focus:outline-none"
        />
        <span className="px-2 grid place-items-center bg-bg-tertiary text-text-secondary text-xs">{unit}</span>
      </span>
      {presets && (
        <span className="flex gap-1">
          {presets.map((p) => {
            const on = value.trim() === String(p)
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(String(p))}
                className={`min-w-[28px] px-1.5 py-0.5 rounded-sm border font-mono text-xs transition-colors ${
                  on ? 'border-accent text-accent bg-accent-subtle' : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {p.toLocaleString('en-US')}
              </button>
            )
          })}
        </span>
      )}
      {hint && <span className="text-xs text-text-tertiary">{hint}</span>}
    </div>
  )
}
