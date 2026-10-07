import { useMemo, useState } from 'react'
import type { PlanAllocation, PlanInfo, ProviderInfo, SubscriptionSummary } from '../../types'
import { usePlansContext } from '../../contexts/PlansContext'
import { useConnection } from '../../hooks/useConnection'
import { formatBytes, formatDuration, formatDateUntil, UNLIMITED_BYTES_THRESHOLD } from '../../utils/format'
import { dataUsed, timeUsed } from '../../utils/plan-value'
import { RefreshIcon } from '../Icons'
import PlanConnectModal from './PlanConnectModal'
import SubscriptionActionModal from './SubscriptionActionModal'

/** One subscription the wallet owns, joined with its plan's details when it has one. */
interface MyPlanRow {
  subscription: SubscriptionSummary
  /** The allocation join for plan subscriptions; null for node (per-GB/hour) subs. */
  allocation: PlanAllocation | null
  /** The catalog's plan row, when the catalog knows the plan. */
  plan: PlanInfo | null
}

const STATUS_META: Record<number, { label: string; dot: string; text: string }> = {
  1: { label: 'Active', dot: 'status-dot-active', text: 'text-success' },
  2: { label: 'Ending', dot: 'status-dot-pending', text: 'text-warning' },
  3: { label: 'Inactive', dot: 'bg-border', text: 'text-text-tertiary' },
}

/** One usage bar in the Sessions tab's idiom: info, then warning past 70%, danger past 90%. */
function Meter({ label, title, pct }: { label: React.ReactNode; title: string; pct: number }) {
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-text-secondary" title={title}>{label}</span>
        <span className={`font-mono ${pct > 90 ? 'text-danger' : pct > 70 ? 'text-warning' : 'text-text-secondary'}`}>
          {pct >= 100 ? 'Used up' : `${pct.toFixed(0)}%`}
        </span>
      </div>
      <div className="h-1.5 bg-bg-hover overflow-hidden rounded-full">
        <div
          className={`h-full transition-all rounded-full ${pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warning' : 'bg-info'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

const DATA_TITLE =
  'What the chain has counted for this wallet on this subscription. Nodes report usage ' +
  'as a session runs, so it can trail a live session by one report.'

/**
 * The wallet's subscriptions as cards in the Sessions tab's idiom: what it is, the
 * gauges for what is being used up, then the actions. Connect (smart) is the primary
 * action on active plan subscriptions, a manual picker the secondary, and Manage for
 * renewal and cancel.
 *
 * Two gauges on an active plan subscription: its VALIDITY (calendar time since
 * purchase) and its DATA, the wallet's allocation as the chain counts it. An
 * unlimited allocation gets the figure without a bar; an unread one says so.
 */
export default function MyPlansPanel({ providers, onBrowse }: { providers: ProviderInfo[]; onBrowse: () => void }) {
  const { overview, loading } = usePlansContext()
  const { status } = useConnection()
  const tunnelUp = status.state === 'connected' || status.state === 'reconnecting'
  const [connectTarget, setConnectTarget] = useState<{ row: MyPlanRow; manual: boolean } | null>(null)
  const [manageTarget, setManageTarget] = useState<MyPlanRow | null>(null)
  const providerName = useMemo(() => new Map(providers.map((p) => [p.address, p.name])), [providers])

  const rows = useMemo<MyPlanRow[]>(() => {
    const allocById = new Map(overview.allocations.map((a) => [a.subscriptionId, a]))
    const planById = new Map(overview.plans.map((p) => [p.id, p]))
    const list = overview.subscriptions.map((subscription) => ({
      subscription,
      allocation: allocById.get(subscription.id) ?? null,
      plan: planById.get(subscription.planId) ?? null,
    }))
    // Active first, then newest start date.
    list.sort((a, b) => {
      const rank = (r: MyPlanRow) => (r.subscription.status === 1 ? 0 : 1)
      return rank(a) - rank(b) ||
        new Date(b.subscription.startAt || 0).getTime() - new Date(a.subscription.startAt || 0).getTime()
    })
    return list
  }, [overview.subscriptions, overview.allocations, overview.plans])

  if (loading) {
    return (
      <div className="flex-1 p-5 space-y-2.5" role="status" aria-label="Loading your plans">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <span className="skeleton h-3.5 w-28" />
              <span className="skeleton h-3 w-24" />
              <span className="skeleton h-3 w-14 ml-auto" />
            </div>
            <span className="skeleton block h-1.5 mt-4 rounded-full" />
            <div className="flex justify-end gap-2 mt-3.5">
              <span className="skeleton h-6 w-16" />
              <span className="skeleton h-6 w-20" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        <p className="text-text-primary text-sm font-medium">No plans yet</p>
        <p className="text-text-secondary text-sm text-center max-w-sm">
          A plan is a prepaid bundle from a provider: one purchase covers every node the
          provider links to it, usually cheaper than paying a single node per GB.
        </p>
        <button onClick={onBrowse} className="btn btn-primary text-sm">
          Browse the catalog
        </button>
      </div>
    )
  }

  const now = Date.now()

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-2.5">
      {rows.map((row) => {
        const { subscription: sub, allocation } = row
        const meta = STATUS_META[sub.status] ?? STATUS_META[3]
        const isPlanSub = sub.planId !== '0'
        const size = allocation ? formatBytes(allocation.planBytes) : null
        const duration = allocation ? formatDuration(allocation.planDurationSeconds) : null
        const provAddress = allocation?.planProvAddress ?? row.plan?.provAddress
        const provider = provAddress ? providerName.get(provAddress) : undefined
        const canConnect = isPlanSub && sub.status === 1 && !tunnelUp && !overview.stale
        const validity = isPlanSub && sub.status === 1 ? timeUsed(sub.startAt, sub.inactiveAt, now) : null
        const data = allocation?.usage
          ? dataUsed(allocation.usage.grantedBytes, allocation.usage.utilisedBytes, UNLIMITED_BYTES_THRESHOLD)
          : null
        return (
          <div key={sub.id} className="bg-bg-secondary border border-border rounded-md px-4 py-3.5">
            <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap">
              {isPlanSub ? (
                <span className="text-accent text-sm font-semibold">
                  {size ?? 'Plan'}{duration ? ` · ${duration}` : ''}
                </span>
              ) : (
                <span className="text-text-primary text-sm font-medium">Node subscription</span>
              )}
              {provider && <span className="text-text-secondary text-sm truncate max-w-[220px]">{provider}</span>}
              {isPlanSub && <span className="text-text-tertiary text-xs font-mono">plan #{sub.planId}</span>}
              <span className="text-text-tertiary text-xs font-mono">sub #{sub.id}</span>
              <span className="flex items-center gap-1.5 ml-auto">
                <span className={`status-dot ${meta.dot}`} />
                <span className={`text-xs ${meta.text}`}>{meta.label}</span>
              </span>
            </div>

            {validity ? (
              <Meter
                pct={validity.fraction * 100}
                title="Calendar time since the subscription was bought, out of its validity. It runs whether or not you connect."
                label={<>
                  Validity used: {formatDuration(validity.usedDays * 86400)} of {formatDuration(validity.totalDays * 86400)}
                  <span className="text-text-tertiary"> · until {formatDateUntil(sub.inactiveAt)}</span>
                </>}
              />
            ) : (
              <div className="text-text-secondary text-xs mt-1.5">
                {isPlanSub ? (duration ?? 'Unknown period') : 'Pay per use'}
                {sub.inactiveAt ? `, ${sub.status === 1 ? 'active until' : 'ended'} ${formatDateUntil(sub.inactiveAt)}` : ''}
              </div>
            )}

            {isPlanSub && sub.status === 1 && allocation && (
              data && !data.unlimited ? (
                <Meter
                  pct={data.fraction * 100}
                  title={DATA_TITLE}
                  label={<>Data used: {formatBytes(data.utilised)} of {formatBytes(data.granted)}</>}
                />
              ) : (
                <div className="text-xs mt-2.5" title={DATA_TITLE}>
                  {data ? (
                    <span className="text-text-secondary">
                      Data used: {formatBytes(data.utilised)}
                      <span className="text-text-tertiary"> · no data cap</span>
                    </span>
                  ) : (
                    <span className="text-text-tertiary">Data used could not be read from the chain.</span>
                  )}
                </div>
              )
            )}

            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
                <RefreshIcon className="w-3 h-3" />
                {sub.renewalPricePolicy === 0 ? 'Will not renew' : 'Renews automatically'}
              </span>
              <span className="ml-auto flex gap-2">
                {isPlanSub && (
                  <>
                    <button
                      onClick={() => setConnectTarget({ row, manual: false })}
                      disabled={!canConnect}
                      title={tunnelUp ? 'Disconnect first to start a new session' : 'Start a new session on this plan (small network fee)'}
                      className="btn btn-primary text-xs px-3 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Connect
                    </button>
                    <button
                      onClick={() => setConnectTarget({ row, manual: true })}
                      disabled={!canConnect}
                      className="btn btn-secondary text-xs px-3 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Choose node
                    </button>
                  </>
                )}
                {/*
                  Nothing in the manage modal applies once the subscription
                  leaves status 1: the chain refuses a renew or a cancel on an
                  inactive_pending row, and answers with a raw "invalid status"
                  error. Grey it out rather than let it be reopened.
                */}
                <button
                  onClick={() => setManageTarget(row)}
                  disabled={overview.stale || tunnelUp || sub.status !== 1}
                  title={sub.status !== 1
                    ? 'This subscription is no longer active, so there is nothing left to manage'
                    : tunnelUp
                      ? 'Disconnect the VPN to manage subscriptions'
                      : 'Renewal policy, renew now, or cancel'}
                  className="btn btn-secondary text-xs px-3 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Manage
                </button>
              </span>
            </div>
          </div>
        )
      })}

      {connectTarget && (
        <PlanConnectModal
          plan={
            connectTarget.row.plan ?? {
              // The catalog may not know a plan the wallet subscribed to
              // elsewhere; the allocation carries enough to connect with.
              id: connectTarget.row.subscription.planId,
              provAddress: connectTarget.row.allocation?.planProvAddress ?? '',
              bytes: connectTarget.row.allocation?.planBytes ?? '0',
              durationSeconds: connectTarget.row.allocation?.planDurationSeconds ?? null,
              prices: [],
              private: false,
              status: 1,
              isTest: false,
              nodeCount: null,
            }
          }
          subscriptionId={connectTarget.row.subscription.id}
          startManual={connectTarget.manual}
          autoStart={!connectTarget.manual}
          onClose={() => setConnectTarget(null)}
        />
      )}

      {manageTarget && (
        <SubscriptionActionModal
          subscription={manageTarget.subscription}
          plan={manageTarget.plan}
          locked={overview.stale || tunnelUp}
          onClose={() => setManageTarget(null)}
        />
      )}
    </div>
  )
}
