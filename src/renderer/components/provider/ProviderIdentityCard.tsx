import { useCallback, useState, type ReactNode } from 'react'
import type { LeaseSummary, MyPlan, MyProvider, ProviderEconomics } from '../../types'
import { displayConnectError } from '../../utils/connect-errors'
import { STATUS_ACTIVE, formatSince, formatUdvpnAmount } from '../../utils/provider-format'
import { useConfirm } from '../ConfirmModal'
import CopyButton from '../CopyButton'
import InfoTip from '../InfoTip'
import Spinner from '../Spinner'
import { PencilIcon, RefreshIcon } from '../Icons'
import ProviderDetailsModal from './ProviderDetailsModal'

/**
 * Activating or deactivating the provider, shared by the bar's button and the plan
 * workspace's "Activate provider" (which is where leasing says it is blocked). One
 * hook in ProviderConsole, so both buttons show the same in-flight state.
 *
 * `pendingTarget` is the status being APPLIED, or null when idle. Not a plain
 * boolean, because `active` is live chain data that changes UNDER the button:
 * `onChanged()` calls setData while it runs, and clearing busy only lands a microtask
 * later, so there is a render with the new status and the spinner still going.
 * Reading the label off `active` there made a freshly activated provider say
 * "Deactivating…" mid-spin. While an action is in flight the button describes the
 * ACTION, and holds its pre-action styling, so it settles in exactly one visible step.
 */
export function useProviderStatus(plans: MyPlan[], leases: LeaseSummary[], onChanged: () => Promise<void>) {
  const [pendingTarget, setPendingTarget] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  const setStatus = useCallback(async (next: boolean) => {
    if (!(await requestConfirm(next ? activateQuestion() : deactivateQuestion(plans, leases)))) return
    setPendingTarget(next)
    setError(null)
    try {
      await window.api.providerSetStatus(next)
      // Awaited: clearing busy when the TX returns would re-render the PRE-tx
      // status for as long as the chain re-read takes, so the label bounces back
      // to "Activate" for a beat before settling on "Deactivate".
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Status change failed')
    } finally {
      setPendingTarget(null)
    }
  }, [leases, onChanged, plans, requestConfirm])

  return { pendingTarget, setStatus, error, confirmDialog }
}

export type ProviderStatusControl = ReturnType<typeof useProviderStatus>

/**
 * The provider in one bar: the record as the chain holds it, the money figures, and
 * the actions that change it. It replaced four stacked bands (identity card, money
 * tiles, an inactive banner and the setup path) that took ~265px before the plans
 * began (2026-10-06), the same fix the Multi-hop route bar made to its rows.
 *
 * All four metadata fields stay on screen, in a second line: they are what
 * subscribers see next to the plans, and a provider with no way to read back what it
 * published cannot tell a typo from a rendering choice.
 *
 * Nothing on this tab polls: chain-side changes (a lease renewing, a subscription
 * sold) are invisible until an action re-reads, so the data age is shown and a
 * manual re-read offered.
 */
export default function ProviderIdentityCard({ provider, economics, stale, fetchedAt, status, onRefresh, onChanged }: {
  provider: MyProvider
  economics: ProviderEconomics | null
  /** Read-only mode: the data is cached and the chain unreachable, so actions are disabled. */
  stale: boolean
  /** When the data was read from the chain (ms), or null before the first read. */
  fetchedAt: number | null
  status: ProviderStatusControl
  onRefresh: () => Promise<void>
  /** Resolves once the chain has been re-read, so the button can stay busy until then. */
  onChanged: () => Promise<void>
}) {
  const active = provider.status === STATUS_ACTIVE
  const { pendingTarget, setStatus } = status
  const busy = pendingTarget !== null
  // Pre-action status is the opposite of what we are moving to.
  const showActive = pendingTarget === null ? active : !pendingTarget
  const [editing, setEditing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      await onRefresh()
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [onRefresh])

  const since = formatSince(provider.statusAt)
  const age = fetchedAt !== null ? formatSince(new Date(fetchedAt).toISOString()) : null
  const dataOld = stale || (fetchedAt !== null && Date.now() - fetchedAt > 10 * 60 * 1000)
  const error = status.error ?? refreshError
  const hasDetails = Boolean(provider.website || provider.identity || provider.description)

  return (
    <div className="border-b border-border bg-bg-secondary px-5 py-2.5 shrink-0">
      <div className="flex items-center gap-x-3.5 gap-y-2 flex-wrap">
        <span className="flex items-center gap-2.5 min-w-0">
          <span className={`status-dot ${active ? 'status-dot-active' : 'status-dot-inactive'}`} />
          <span className="text-text-primary text-[15px] font-semibold truncate max-w-[220px]">
            {provider.name || 'Unnamed provider'}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full leading-none ${
            active ? 'bg-success-subtle text-success' : 'bg-warning-subtle text-warning'
          }`}>
            {active ? 'Active' : 'Inactive'}
          </span>
          {since && <span className="text-text-tertiary text-[11px] whitespace-nowrap">since {since}</span>}
        </span>
        <span className="flex items-center gap-1 text-text-tertiary font-mono text-[11px]" title={provider.address}>
          {provider.address.slice(0, 13)}...{provider.address.slice(-6)}
          <CopyButton value={provider.address} label="Copy provider address" />
        </span>

        <MoneyFigures economics={economics} stale={stale} onRetry={handleRefresh} />

        <span className="ml-auto flex items-center gap-3.5">
          {age && (
            <span className={`text-[11px] ${dataOld ? 'text-warning' : 'text-text-tertiary'}`} title="When this tab last read the chain">
              Updated {age}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={busy || refreshing || stale}
            title={stale ? 'The chain is not reachable while the VPN is connected' : 'Re-read your provider, plans and leases from the chain'}
            className={GHOST}
          >
            {refreshing ? <Spinner className="text-accent" /> : <RefreshIcon className="w-3.5 h-3.5" />}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy || stale}
            title={stale ? 'The chain is not reachable while the VPN is connected' : 'Name, website, identity and description, as subscribers see them'}
            className={GHOST}
          >
            <PencilIcon className="w-3.5 h-3.5" />
            Edit details
          </button>
          <button
            type="button"
            onClick={() => void setStatus(!active)}
            disabled={busy || stale}
            className={`btn text-xs py-1.5 px-3 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 min-w-[120px] ${
              showActive ? 'btn-secondary' : 'btn-primary'
            }`}
          >
            {busy && <Spinner size="sm" />}
            {pendingTarget === null
              ? (active ? 'Deactivate' : 'Activate')
              : (pendingTarget ? 'Activating…' : 'Deactivating…')}
          </button>
        </span>
      </div>

      {hasDetails && (
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-1.5 text-[11px] min-w-0">
          {provider.website && (
            <a href={provider.website} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline truncate max-w-xs">
              {provider.website}
            </a>
          )}
          {provider.identity && (
            <span className="text-text-tertiary">
              identity <span className="text-text-secondary font-mono">{provider.identity}</span>
            </span>
          )}
          {provider.description && (
            <span className="text-text-secondary truncate min-w-0 flex-1" title={provider.description}>{provider.description}</span>
          )}
        </div>
      )}

      {error && (
        <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2 mt-2">
          <p className="text-danger text-xs">{displayConnectError(error)}</p>
        </div>
      )}
      {editing && (
        <ProviderDetailsModal provider={provider} readOnly={stale} onClose={() => setEditing(false)} onSaved={onChanged} />
      )}
    </div>
  )
}

const GHOST = 'flex items-center gap-1.5 text-text-secondary hover:text-accent text-xs transition-colors disabled:opacity-30 disabled:hover:text-text-secondary'

/**
 * The money figures, inline: what the leased nodes cost to keep, what is escrowed,
 * and what the plans have brought in. Before anything is leased or sold that is one
 * phrase, not three "None" tiles.
 *
 * There is deliberately no profit line. The chain deletes a lease once it ends, so
 * lifetime spend can't be reconstructed — subtracting the costs we *can* still see
 * from complete revenue would report a business as healthier than it is.
 */
function MoneyFigures({ economics, stale, onRetry }: {
  economics: ProviderEconomics | null
  stale: boolean
  onRetry: () => Promise<void>
}) {
  if (!economics) {
    return (
      <span className="flex items-center gap-2 text-xs text-warning pl-3.5 border-l border-border">
        Money figures could not be read just now.
        {!stale && (
          <button type="button" onClick={() => void onRetry()} className="text-accent hover:underline">Retry</button>
        )}
      </span>
    )
  }
  const idle = economics.activeLeases === 0
  const noIncome = economics.estimatedRevenueUdvpn === '0'
  if (idle && noIncome) {
    return (
      <span className="text-xs text-text-secondary pl-3.5 border-l border-border">
        No leases yet, so nothing is being spent
      </span>
    )
  }
  return (
    <span className="flex items-stretch">
      {idle ? (
        <Figure label="Burn" value="None" title="No leases are running" />
      ) : (
        <>
          <Figure
            label="Burn"
            value={`${formatUdvpnAmount(economics.burnDailyUdvpn)}/day`}
            title={`${economics.activeLeases} lease${economics.activeLeases === 1 ? '' : 's'} running`}
          />
          <Figure label="In escrow" value={formatUdvpnAmount(economics.committedUdvpn)} title="Refunded if you end the leases" />
        </>
      )}
      <Figure
        label="Income, at least"
        value={noIncome ? 'None' : formatUdvpnAmount(economics.estimatedRevenueUdvpn)}
        title={`${economics.subscriptions} subscription${economics.subscriptions === 1 ? '' : 's'} sold`}
      >
        <InfoTip label="how these figures are computed">
          Income is subscriptions sold, times the plan price, less the share the chain keeps. It is
          a floor: renewals may charge again without creating a new subscription. You pay nodes by
          the hour whether or not anyone connects, but sell plans by the gigabyte, so extra
          subscribers on nodes you already lease cost you nothing more until the nodes run out of
          bandwidth.
        </InfoTip>
      </Figure>
    </span>
  )
}

function Figure({ label, value, title, children }: { label: string; value: string; title: string; children?: ReactNode }) {
  return (
    <span className="flex flex-col justify-center px-3.5 border-l border-border" title={title}>
      <span className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide leading-tight flex items-center gap-1">
        {label}
        {children}
      </span>
      <span className="text-text-primary text-sm font-semibold whitespace-nowrap leading-tight">{value}</span>
    </span>
  )
}

function activateQuestion() {
  return {
    title: 'Activate this provider?',
    body: [
      'Your active plans become visible to subscribers, and the chain will start accepting plan and lease transactions from you.',
      'This is an on-chain transaction.',
    ],
    confirmLabel: 'Activate',
  }
}

/**
 * Deactivating is the closest thing the chain has to cancelling a provider, and
 * it is far more destructive than "your plans stop being offered".
 *
 * Three hooks fire in sentinelhub v12: x/lease's ProviderInactivePreHook ends
 * EVERY lease, each ended lease fires x/plan's LeaseInactivePreHook which unlinks
 * that node from every plan, and x/plan's ProviderInactivePreHook deactivates
 * every active plan. So the counts are read off the state we already hold and
 * stated plainly, rather than discovered afterwards.
 */
function deactivateQuestion(plans: MyPlan[], leases: LeaseSummary[]) {
  const activePlans = plans.filter((p) => p.status === STATUS_ACTIVE).length
  const nodes = new Set(leases.map((l) => l.nodeAddress)).size
  const consequences: string[] = []
  if (leases.length > 0) {
    consequences.push(`${leases.length} lease${leases.length === 1 ? '' : 's'} will be ended by the chain and the unspent escrow refunded`)
  }
  if (nodes > 0) {
    consequences.push(`${nodes} node${nodes === 1 ? '' : 's'} will be unlinked from your plans`)
  }
  if (activePlans > 0) {
    consequences.push(`${activePlans} active plan${activePlans === 1 ? '' : 's'} will be deactivated`)
  }

  return {
    title: 'Deactivate this provider?',
    body: [
      consequences.length > 0
        ? `The chain does this for you, all in the same block: ${consequences.join(', ')}.`
        : 'You have no leases or active plans, so nothing else changes.',
      'Reactivating later costs no new deposit, but every lease has to be bought again and every node linked again.',
      'The registration deposit went to the community pool and is not returned. There is no way to remove a provider from the chain, so this is as close to cancelling as it gets.',
      'This is an on-chain transaction.',
    ],
    confirmLabel: 'Deactivate',
    danger: true,
  }
}
