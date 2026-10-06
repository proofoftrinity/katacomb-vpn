import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNodesContext } from '../../contexts/NodesContext'
import type { LeaseSummary, MyPlan, ProviderEconomics, SentNode, TokenPrice } from '../../types'
import { displayConnectError } from '../../utils/connect-errors'
import { protocolMeta } from '../../utils/protocols'
import { RENEWAL_POLICY, renewalPolicyLabel } from '../../../shared/renewal-policy'
import { formatUdvpn, formatUdvpnAmount, usdEstimate } from '../../utils/provider-format'
import CountryFlag from '../CountryFlag'
import ProtocolIcon from '../ProtocolIcon'
import { useConfirm } from '../ConfirmModal'
import { AmountStepper, FooterReason, LimitsSection, Receipt, ReceiptLine, ReviewModal, SectionHead, StepList, useActiveWalletName } from '../ConnectReview'
import Spinner from '../Spinner'
import { ArrowRightIcon, ChevronIcon, CloseIcon, PlusIcon, SearchIcon } from '../Icons'
import LeaseManageModal, { RenewalChoice } from './LeaseManageModal'

/**
 * Link and Unlink run as on-chain transactions from in-place buttons, with no
 * overlay over the tab bar — so unlike the lease modals below, the user can switch
 * tabs while one is in flight, and that unmounts this whole subtree (the Provider
 * tab is rendered conditionally in App). The marker and the error therefore belong
 * to App, not here: without that the buttons came back live while the tx was still
 * being broadcast, and a second Link would collide with the first on the account
 * sequence number, while the failure of the first had nowhere left to render.
 */
export interface NodeActionState {
  /** The node an on-chain Link or Unlink is currently running for. */
  busyAddress: string | null
  setBusyAddress: (address: string | null) => void
  error: string | null
  setError: (message: string | null) => void
}

/** A udvpn integer string as a bare P2P figure, for a column already headed P2P. */
function p2p(udvpn: string): string {
  const n = Number(udvpn) / 1e6
  return isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '-'
}

// Written out in full for Tailwind, shared by the header and every row.
// Every column fixed or fractional, never auto: each row is its own grid, so an auto
// column sized by its buttons would not line up with the header's empty one.
const NODE_GRID = 'grid grid-cols-[minmax(150px,1.6fr)_96px_minmax(110px,1fr)_76px_164px] gap-x-3 items-center'

/**
 * Nodes serving one plan, in the node table's vocabulary: flag, name, protocol icon,
 * and each lease as a bar of the hours it has used.
 *
 * Attaching a node is two on-chain steps, not one: the hub's HandleMsgLinkNode
 * rejects unless an active LEASE already exists between this provider and the
 * node, so we buy the lease first and link second. Both are shown as one action,
 * but because they are separate transactions the middle state is real — a node
 * that is leased but not linked gets its own group with a Link button, which is
 * also what the user comes back to if the app is closed between the two.
 */
export default function PlanNodesManager({
  plan, leases, price, economics, providerActive, readOnly, onChanged, nodeAction, onActivateProvider, activatingProvider,
}: {
  plan: MyPlan
  leases: LeaseSummary[]
  price: TokenPrice | null
  economics: ProviderEconomics | null
  /** The chain refuses MsgStartLease under an inactive provider, so the picker is gated on it. */
  providerActive: boolean
  /** Cached data, chain unreachable: every mutation is disabled. */
  readOnly: boolean
  /** Resolves once the chain has been re-read, so a caller can hold its busy state until then. */
  onChanged: () => Promise<void>
  /** Owned by App so a Link or Unlink survives a tab switch. See NodeActionState. */
  nodeAction: NodeActionState
  onActivateProvider: () => void
  activatingProvider: boolean
}) {
  const { allNodes, loading: nodesLoading, error: nodesError } = useNodesContext()
  const [linked, setLinked] = useState<string[] | null>(null)
  // A failed read is NOT an empty list: rendering it as "No nodes yet" states
  // something about the plan that nobody verified. The consumer-side pane
  // (PlanDetailPane) draws the same line.
  const [linkedUnknown, setLinkedUnknown] = useState(false)
  const [managingLease, setManagingLease] = useState<LeaseSummary | null>(null)
  const { busyAddress, setBusyAddress, error, setError } = nodeAction
  const [picking, setPicking] = useState(false)
  const [leasingNode, setLeasingNode] = useState<SentNode | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])

  const loadLinked = useCallback(async () => {
    setLinked(null)
    setLinkedUnknown(false)
    try {
      const addrs = await window.api.planNodes(plan.id)
      if (addrs === null) {
        // main could not know (cache miss while the chain is unreachable).
        setLinked([])
        setLinkedUnknown(true)
      } else {
        setLinked(addrs)
      }
    } catch {
      setLinked([])
      setLinkedUnknown(true)
    }
  }, [plan.id])

  // Not `useEffect(loadLinked, ...)`: an async callback returns a Promise, and an
  // effect may only return a cleanup function.
  useEffect(() => { void loadLinked() }, [loadLinked])

  const linkedSet = useMemo(() => new Set(linked ?? []), [linked])
  const leasedNotLinked = leases.filter((l) => !linkedSet.has(l.nodeAddress))

  // Resolves once BOTH re-reads have landed, so an action's busy state can span
  // the transaction and the refresh instead of ending between them.
  const refreshAll = useCallback(async () => {
    await Promise.all([loadLinked(), onChanged()])
  }, [loadLinked, onChanged])

  const run = useCallback(async (address: string, action: () => Promise<void>) => {
    setBusyAddress(address)
    setError(null)
    try {
      await action()
      await refreshAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyAddress(null)
    }
  }, [refreshAll, setBusyAddress, setError])

  async function handleUnlink(address: string) {
    if (!(await requestConfirm({
      title: `Unlink this node from plan #${plan.id}?`,
      body: ['Subscribers stop being served by it. Your lease is unaffected. This is an on-chain transaction.'],
      confirmLabel: 'Unlink',
      danger: true,
    }))) return
    await run(address, () => window.api.providerPlanUnlink(plan.id, address))
  }

  async function handleLink(address: string) {
    if (!(await requestConfirm({
      title: `Link this node to plan #${plan.id}?`,
      body: [
        'Subscribers to the plan can connect through it. You already hold the lease, so this costs the network fee only.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'Link',
    }))) return
    await run(address, () => window.api.providerPlanLink(plan.id, address))
  }

  const leaseByNode = useMemo(() => new Map(leases.map((l) => [l.nodeAddress, l])), [leases])
  const leasedAddresses = useMemo(() => new Set(leases.map((l) => l.nodeAddress)), [leases])
  const pickerDisabled = !providerActive || readOnly

  return (
    <section className="bg-bg-secondary border border-border rounded-md">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Nodes serving this plan{linked !== null && !linkedUnknown ? ` (${linkedSet.size})` : ''}
        </h3>
        <button
          type="button"
          onClick={() => setPicking(true)}
          disabled={pickerDisabled}
          title={readOnly ? 'The chain is not reachable while the VPN is connected' : !providerActive ? 'Activate your provider first' : 'Lease a node and link it to this plan'}
          className="btn btn-primary text-xs py-1 px-2.5 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <PlusIcon className="w-3.5 h-3.5" />
          Add nodes
        </button>
      </div>

      {/* The one reason leasing is blocked, said once with its fix, instead of a
          disabled button on every node row (2026-10-06 screenshot). */}
      {!readOnly && !providerActive && (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-md border border-dashed border-border px-3 py-2.5">
          <p className="flex-1 text-xs text-text-secondary">
            Leasing a node needs an active provider. Once you are active, Add nodes opens the node
            list with hourly prices.
          </p>
          <button
            type="button"
            onClick={onActivateProvider}
            disabled={activatingProvider}
            className="btn btn-secondary text-xs py-1 px-3 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {activatingProvider && <Spinner size="sm" />}
            {activatingProvider ? 'Activating…' : 'Activate provider'}
          </button>
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 bg-danger-subtle border border-danger rounded-md px-3 py-2">
          <p className="text-danger text-xs">{displayConnectError(error)}</p>
        </div>
      )}

      <div className="px-4 py-3">
        {linked === null ? (
          <span className="text-text-tertiary text-xs flex items-center gap-2"><Spinner /> Reading the plan&apos;s nodes…</span>
        ) : linkedUnknown ? (
          <span className="flex items-center gap-2">
            <p className="text-warning text-xs">Could not read the plan&apos;s node list right now.</p>
            {!readOnly && (
              <button type="button" onClick={() => void loadLinked()} className="text-warning text-[11px] hover:underline">
                Retry
              </button>
            )}
          </span>
        ) : linkedSet.size === 0 ? (
          <p className="text-text-tertiary text-xs">
            No nodes yet. Subscribers to this plan have nothing to connect to until you add one.
          </p>
        ) : (
          <NodeTable>
            {[...linkedSet].map((address) => {
              const lease = leaseByNode.get(address)
              return (
                <NodeRow
                  key={address}
                  address={address}
                  node={nodeIndex.get(address)}
                  lease={lease}
                  busy={busyAddress === address}
                  disabled={readOnly}
                  action={{ label: 'Unlink', busyLabel: 'Unlinking…', kind: 'danger', onClick: () => void handleUnlink(address) }}
                  secondaryAction={lease ? { label: 'Lease', onClick: () => setManagingLease(lease) } : undefined}
                />
              )
            })}
          </NodeTable>
        )}
      </div>

      {leasedNotLinked.length > 0 && (
        <div className="px-4 pb-3">
          <div className="flex items-baseline justify-between gap-3 mb-1.5">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              Leased, not linked ({leasedNotLinked.length})
            </h4>
            <span className="text-text-tertiary text-[11px]">You pay for these. Link one to put it behind this plan.</span>
          </div>
          <NodeTable>
            {leasedNotLinked.map((lease) => (
              <NodeRow
                key={lease.id}
                address={lease.nodeAddress}
                node={nodeIndex.get(lease.nodeAddress)}
                lease={lease}
                busy={busyAddress === lease.nodeAddress}
                disabled={readOnly}
                action={{ label: 'Link', busyLabel: 'Linking…', kind: 'primary', onClick: () => void handleLink(lease.nodeAddress) }}
                secondaryAction={{ label: 'Lease', onClick: () => setManagingLease(lease) }}
              />
            ))}
          </NodeTable>
        </div>
      )}

      {picking && (
        <NodeDrawer
          planId={plan.id}
          nodes={allNodes}
          nodesLoading={nodesLoading}
          nodesError={nodesError}
          excluded={leasedAddresses}
          price={price}
          onPick={setLeasingNode}
          onClose={() => setPicking(false)}
        />
      )}
      {leasingNode && (
        <LeaseModal
          node={leasingNode}
          planId={plan.id}
          price={price}
          economics={economics}
          readOnly={readOnly}
          onClose={() => setLeasingNode(null)}
          onDone={() => {
            setLeasingNode(null)
            setPicking(false)
            // The modal is gone, so there is no busy state left to hold: dropping
            // the promise here is deliberate, unlike the in-place buttons.
            void refreshAll()
          }}
        />
      )}
      {managingLease && (
        <LeaseManageModal
          lease={managingLease}
          node={nodeIndex.get(managingLease.nodeAddress)}
          readOnly={readOnly}
          onClose={() => setManagingLease(null)}
          onDone={() => {
            setManagingLease(null)
            void refreshAll()
          }}
        />
      )}
      {confirmDialog}
    </section>
  )
}

function NodeTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className={`${NODE_GRID} px-3 py-1.5 bg-bg-primary border-b border-border text-[10px] font-medium uppercase tracking-wide text-text-tertiary`}>
        <span>Node</span>
        <span>Protocol</span>
        <span>Lease used</span>
        <span className="text-right">P2P/h</span>
        <span />
      </div>
      {children}
    </div>
  )
}

function NodeRow({ address, node, lease, busy, disabled, action, secondaryAction }: {
  address: string
  node: SentNode | undefined
  lease: LeaseSummary | undefined
  busy: boolean
  /** Read-only mode: the buttons render but refuse. */
  disabled?: boolean
  /** `busyLabel` is spelled out rather than derived: "End lease" + "ing" is not a word. */
  action: { label: string; busyLabel: string; kind: 'primary' | 'danger'; onClick: () => void }
  secondaryAction?: { label: string; onClick: () => void }
}) {
  const used = lease && lease.maxHours > 0 ? Math.min(1, lease.hours / lease.maxHours) : null
  const stops = lease?.renewalPricePolicy === RENEWAL_POLICY.UNSPECIFIED
  return (
    <div className={`${NODE_GRID} px-3 py-2 border-b border-border last:border-b-0 text-xs`}>
      <span className="flex items-center gap-2 min-w-0">
        {node && <CountryFlag country={node.country} />}
        <span className="min-w-0 leading-tight">
          <span className="block text-text-primary text-[13px] truncate">{node?.moniker || 'Unknown node'}</span>
          <span className="block text-text-tertiary text-[11px] truncate" title={address}>
            {node ? [node.city, node.country].filter(Boolean).join(', ') || address : address}
          </span>
        </span>
      </span>
      <span className="flex items-center gap-1.5 min-w-0">
        {node && <ProtocolIcon type={node.type} className={`w-3.5 h-3.5 shrink-0 ${protocolMeta(node.type).color}`} />}
        <span className="text-text-secondary truncate">{node ? protocolMeta(node.type).label : '-'}</span>
      </span>
      {lease && used !== null ? (
        <span
          className="flex items-center gap-2 min-w-0"
          title={`Lease #${lease.id}: ${lease.hours} of ${lease.maxHours} hours used. ${renewalPolicyLabel(lease.renewalPricePolicy)}.`}
        >
          <span className="flex-1 h-1.5 rounded-full bg-bg-tertiary relative min-w-[40px]">
            <span className={`absolute inset-y-0 left-0 rounded-full ${stops && used > 0.75 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${used * 100}%` }} />
          </span>
          <span className="font-mono text-[11px] text-text-secondary whitespace-nowrap">{lease.hours}/{lease.maxHours}h</span>
        </span>
      ) : (
        <span className="text-text-tertiary">-</span>
      )}
      <span className="text-right font-mono text-text-primary">{lease ? p2p(lease.hourlyPrice) : '-'}</span>
      <span className="flex justify-end gap-1.5">
        {secondaryAction && (
          <button
            type="button"
            onClick={secondaryAction.onClick}
            disabled={busy || disabled}
            className="btn btn-secondary text-xs py-1 px-2.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {secondaryAction.label}
          </button>
        )}
        <button
          type="button"
          onClick={action.onClick}
          disabled={busy || disabled}
          className={`btn text-xs py-1 px-2.5 inline-flex items-center justify-center gap-1.5 min-w-[92px] disabled:opacity-40 disabled:cursor-not-allowed ${
            action.kind === 'danger' ? 'btn-secondary text-danger' : 'btn-primary'
          }`}
        >
          {busy && <Spinner size="sm" />}
          {busy ? action.busyLabel : action.label}
        </button>
      </span>
    </div>
  )
}

const PICKER_LIMIT = 40

/**
 * The node list to lease from, as a side drawer over the workspace rather than a list
 * of cards inline in it. Only nodes that publish an hourly price in P2P can be leased,
 * so the rest are never offered.
 */
function NodeDrawer({ planId, nodes, nodesLoading, nodesError, excluded, price, onPick, onClose }: {
  planId: string
  nodes: SentNode[]
  nodesLoading: boolean
  nodesError: string | null
  excluded: Set<string>
  price: TokenPrice | null
  onPick: (node: SentNode) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [cheapestFirst, setCheapestFirst] = useState(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { matches, matchTotal } = useMemo(() => {
    const q = search.trim().toLowerCase()
    const leasable = nodes.filter(
      (n) => !excluded.has(n.address) && n.isActive && n.hourlyPrices.some((p) => p.denom === 'udvpn'),
    )
    const filtered = q
      ? leasable.filter(
          (n) =>
            n.moniker.toLowerCase().includes(q) ||
            n.country.toLowerCase().includes(q) ||
            n.city.toLowerCase().includes(q) ||
            n.address.toLowerCase().includes(q),
        )
      : leasable
    const hourlyOf = (n: SentNode) => Number(n.hourlyPrices.find((p) => p.denom === 'udvpn')?.value ?? Infinity)
    const dir = cheapestFirst ? 1 : -1
    return {
      matches: [...filtered].sort((a, b) => dir * (hourlyOf(a) - hourlyOf(b))).slice(0, PICKER_LIMIT),
      matchTotal: filtered.length,
    }
  }, [nodes, excluded, search, cheapestFirst])

  const grid = 'grid grid-cols-[minmax(0,1fr)_64px_84px_60px] gap-x-2.5 items-center'

  return (
    <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={`Add nodes to plan ${planId}`}
        className="absolute inset-y-0 right-0 w-[460px] max-w-full bg-bg-secondary border-l border-border shadow-overlay flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-border">
          <div>
            <h2 className="text-text-primary text-base font-semibold">Add nodes to plan #{planId}</h2>
            <p className="text-text-tertiary text-xs mt-0.5">Active nodes that publish an hourly price in P2P</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 shrink-0 grid place-items-center rounded-sm text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-border">
          <div className="relative">
            <SearchIcon className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, country, city or address"
              aria-label="Search nodes"
              autoFocus
              className="w-full bg-bg-tertiary border border-border text-text-primary text-sm pl-8 pr-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus placeholder:text-text-tertiary"
            />
          </div>
        </div>
        <div className={`${grid} px-5 py-2 border-b border-border text-[10px] font-medium uppercase tracking-wide text-text-tertiary`}>
          <span>Node</span>
          <span>Protocol</span>
          <button
            type="button"
            onClick={() => setCheapestFirst((v) => !v)}
            className="flex items-center justify-end gap-1 uppercase tracking-wide text-text-primary hover:text-accent transition-colors"
            title={cheapestFirst ? 'Cheapest first. Click for dearest first.' : 'Dearest first. Click for cheapest first.'}
          >
            P2P/h
            <ChevronIcon direction={cheapestFirst ? 'up' : 'down'} className="w-3 h-3 text-accent" />
          </button>
          <span />
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* The node list has its own lifecycle: an empty result while it is still
              loading (or failed to load) says nothing about leasable nodes. */}
          {matches.length === 0 && nodesLoading && (
            <span className="px-5 py-3 text-text-tertiary text-xs flex items-center gap-2"><Spinner /> Loading the node list…</span>
          )}
          {matches.length === 0 && !nodesLoading && nodesError && nodes.length === 0 && (
            <p className="px-5 py-3 text-warning text-xs">The node list could not be loaded, so there is nothing to pick from yet.</p>
          )}
          {matches.length === 0 && !nodesLoading && !(nodesError && nodes.length === 0) && (
            <p className="px-5 py-3 text-text-tertiary text-xs">
              No leasable nodes match. A node must be active and publish an hourly price in P2P.
            </p>
          )}
          {matches.map((node) => {
            const hourly = node.hourlyPrices.find((p) => p.denom === 'udvpn')?.value ?? '0'
            return (
              <div key={node.address} className={`${grid} px-5 py-2 border-b border-border text-xs hover:bg-bg-hover`}>
                <span className="flex items-center gap-2 min-w-0">
                  <CountryFlag country={node.country} />
                  <span className="min-w-0 leading-tight">
                    <span className="block text-text-primary text-[13px] truncate">{node.moniker || 'Unnamed'}</span>
                    <span className="block text-text-tertiary text-[11px] truncate">
                      {[node.city, node.country].filter(Boolean).join(', ') || 'Unknown place'}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-1.5 min-w-0">
                  <ProtocolIcon type={node.type} className={`w-3.5 h-3.5 shrink-0 ${protocolMeta(node.type).color}`} />
                  <span className="text-text-secondary truncate">{protocolMeta(node.type).short}</span>
                </span>
                <span className="text-right font-mono text-text-primary" title={price ? `${usdEstimate(hourly, price.usd)} per hour` : undefined}>
                  {p2p(hourly)}
                </span>
                <button
                  type="button"
                  onClick={() => onPick(node)}
                  className="btn btn-primary text-xs py-1 px-2.5"
                >
                  Lease
                </button>
              </div>
            )
          })}
        </div>
        {matchTotal > PICKER_LIMIT && (
          <p className="px-5 py-2.5 border-t border-border text-text-tertiary text-[11px]">
            Showing {PICKER_LIMIT} of {matchTotal.toLocaleString('en-US')} matches. Search to narrow the list.
          </p>
        )}
      </aside>
    </div>
  )
}

/**
 * Buy the lease, then link: a review window in the connect windows' design, so it
 * answers the same questions in the same order (what, for how long, what it costs,
 * what to know, what happens) with a footer that says what stops the button. The
 * window IS the confirmation, as it is for a connect: the old form opened a second
 * confirm dialog on top of itself.
 *
 * `leaseQuote` computes the total in the main process from the node's own on-chain
 * hourly price, never from anything typed here.
 */
function LeaseModal({ node, planId, price, economics, readOnly, onClose, onDone }: {
  node: SentNode
  planId: string
  price: TokenPrice | null
  economics: ProviderEconomics | null
  /** The console went read-only (tunnel up, or the chain read failed) after this modal opened. */
  readOnly: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [hours, setHours] = useState(24)
  const [policy, setPolicy] = useState<number>(RENEWAL_POLICY.ALWAYS)
  const [quote, setQuote] = useState<{ totalUdvpn: string; hourlyPrice: string; minHours: number; maxHours: number } | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'idle' | 'leasing' | 'linking'>('idle')
  const walletName = useActiveWalletName()
  // The default length is clamped into the chain's own bounds once the first
  // quote reports them, but never over anything the user has chosen.
  const hoursTouched = useRef(false)
  // The chain's bounds, once a quote has reported them. Main refuses to price hours
  // outside them (and the stepper goes to 1000), so out-of-range hours skip the quote
  // and the footer says why, instead of showing a pricing error.
  const bounds = useRef<{ min: number; max: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setQuoteError(null)
    const b = bounds.current
    if (b && (hours < b.min || hours > b.max)) return
    window.api
      .leaseQuote(node.address, hours)
      .then((q) => {
        if (cancelled) return
        bounds.current = { min: q.minHours, max: q.maxHours }
        setQuote(q)
        if (!hoursTouched.current) {
          const clamped = Math.min(Math.max(hours, q.minHours), q.maxHours)
          if (clamped !== hours) setHours(clamped)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setQuoteError(e instanceof Error ? e.message : 'Could not price this lease')
      })
    return () => { cancelled = true }
  }, [node.address, hours])

  const withinBounds = quote ? hours >= quote.minHours && hours <= quote.maxHours : true
  // The quote is for the hours on screen only once the fetch for them has landed.
  const quoteCurrent = quote !== null && /^\d+$/.test(quote.totalUdvpn) && /^\d+$/.test(quote.hourlyPrice) &&
    BigInt(quote.totalUdvpn) === BigInt(quote.hourlyPrice) * BigInt(hours)

  // LegacyDec is 10^18-scaled, so /1e16 turns the raw share straight into a percent.
  const poolPercent =
    economics?.leaseStakingShare && /^\d+$/.test(economics.leaseStakingShare)
      ? Math.round(Number(economics.leaseStakingShare) / 1e16)
      : null

  // What this lease does to the running cost. The total is a one-off outlay; this is
  // the rate it commits to, which is the figure the plan price has to cover.
  const nextDailyBurn = useMemo(() => {
    if (!quote || !economics) return null
    if (!/^\d+$/.test(quote.hourlyPrice) || !/^\d+$/.test(economics.burnDailyUdvpn)) return null
    return (BigInt(economics.burnDailyUdvpn) + BigInt(quote.hourlyPrice) * 24n).toString()
  }, [quote, economics])

  async function handleConfirm() {
    if (!quote || !withinBounds || !quoteCurrent) return
    setBusy(true)
    setError(null)
    try {
      setStep('leasing')
      await window.api.leaseStart({ nodeAddress: node.address, hours, renewalPolicy: policy })
      // Link immediately — but as its own tx. If it fails, the lease still stands
      // and the node shows up under "Leased, not linked" with a Link button.
      setStep('linking')
      await window.api.providerPlanLink(planId, node.address)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
      setStep('idle')
    } finally {
      setBusy(false)
    }
  }

  const reason = readOnly ? 'Disconnect the VPN to lease this node.'
    : quoteError ? 'This lease could not be priced.'
      : !withinBounds && quote ? `The chain allows ${quote.minHours} to ${quote.maxHours} hours.`
        : null

  const footer = (
    <>
      {reason ? <FooterReason text={reason} /> : busy ? <FooterReason tone="busy" text={step === 'leasing' ? 'Buying the lease…' : 'Linking the node to the plan…'} /> : null}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary text-sm py-2 px-4 disabled:opacity-40 disabled:cursor-not-allowed">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={busy || !quoteCurrent || !withinBounds || readOnly}
          className="btn btn-primary text-sm py-2 flex-1 inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy && <Spinner size="sm" />}
          {busy ? 'Working…' : quoteCurrent ? `Lease for ${formatUdvpn(quote.totalUdvpn)}` : withinBounds ? 'Pricing…' : 'Lease'}
        </button>
      </div>
    </>
  )

  return (
    <ReviewModal
      title="Lease and link"
      subtitle={`Pay a node by the hour to carry plan #${planId}'s traffic`}
      closable={!busy}
      onClose={onClose}
      footer={footer}
    >
      <div className="flex items-center gap-3 bg-bg-primary border border-border rounded-md px-3.5 py-3">
        <CountryFlag country={node.country} />
        <span className="min-w-0 leading-tight">
          <span className="block text-sm text-text-primary truncate">{node.moniker || node.address}</span>
          <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
            {[node.city, node.country].filter(Boolean).join(', ')}
            <ProtocolIcon type={node.type} className={`w-3 h-3 ${protocolMeta(node.type).color}`} />
            {protocolMeta(node.type).label}
          </span>
        </span>
        <ArrowRightIcon className="w-4 h-4 text-text-tertiary shrink-0 ml-auto" />
        <span className="text-sm text-text-primary whitespace-nowrap">Plan #{planId}</span>
      </div>

      <section>
        <SectionHead title="How long">
          {quote && <span className="text-text-tertiary font-normal">The chain allows {quote.minHours} to {quote.maxHours} hours</span>}
        </SectionHead>
        <AmountStepper
          label="Lease for"
          amount={hours}
          onChange={(n) => { hoursTouched.current = true; setHours(n) }}
          unit="hours"
          presets={[24, 168, 720]}
        />
      </section>

      <section>
        <SectionHead title="When the hours run out" />
        <RenewalChoice value={policy} onChange={setPolicy} disabled={busy} />
      </section>

      <section>
        <SectionHead title="Cost" />
        <Receipt>
          <ReceiptLine
            country={node.country}
            label="Lease"
            payer={walletName}
            detail={quote ? `${formatUdvpn(quote.hourlyPrice)} per hour × ${hours} h` : 'Pricing…'}
            amount={quoteCurrent ? formatUdvpn(quote.totalUdvpn) : null}
            funds={null}
          />
        </Receipt>
        <div className="flex justify-between gap-3 text-xs text-text-tertiary mt-2 px-1">
          <span>
            {nextDailyBurn && economics && (
              <>Daily cost of your leases <span className="font-mono">{formatUdvpnAmount(economics.burnDailyUdvpn)}</span> to{' '}
                <span className="font-mono text-text-secondary">{formatUdvpnAmount(nextDailyBurn)}</span></>
            )}
          </span>
          {quoteCurrent && price && <span>{usdEstimate(quote.totalUdvpn, price.usd)}</span>}
        </div>
      </section>

      <LimitsSection
        title="Worth knowing"
        limits={[
          {
            key: 'hourly',
            tone: 'warning',
            label: 'Billed every hour, used or not',
            text: 'A lease is how you pay a node operator to carry your plan\'s traffic, and the chain refuses to link a node without one. You are billed every hour whether or not anyone connects, so this is a running cost your plan price has to cover. Ending the lease early refunds the unused hours.',
          },
          ...(poolPercent !== null ? [{
            key: 'pool',
            tone: 'warning' as const,
            label: `${poolPercent}% to the community pool`,
            text: `Of each hourly payment the chain sends ${poolPercent}% to the community pool and the rest to the node operator. You pay the full rate either way.`,
          }] : []),
        ]}
      />

      <section>
        <SectionHead title="What happens" />
        <StepList
          stages={[
            { id: 'lease', label: 'Buy the lease, held on chain and paid to the operator hourly' },
            { id: 'link', label: `Link the node to plan #${planId}, network fee only` },
          ]}
          current={step === 'leasing' ? 0 : step === 'linking' ? 1 : -1}
          detail={null}
        />
        <p className="text-text-tertiary text-xs mt-2">
          If the link fails, the lease stands and the node waits under Leased, not linked, with a Link button.
        </p>
      </section>

      {quoteError && (
        <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
          <p className="text-danger text-xs">{displayConnectError(quoteError)}</p>
        </div>
      )}
      {error && (
        <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
          <p className="text-danger text-xs">{displayConnectError(error)}</p>
        </div>
      )}
    </ReviewModal>
  )
}
