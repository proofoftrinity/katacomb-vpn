import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlanInfo, ProviderInfo, TokenPrice } from '../../types'
import { usePlansContext } from '../../contexts/PlansContext'
import { useNavigation } from '../../contexts/NavigationContext'
import { formatBytes, formatDuration, planPriceDisplay, pricePerGb, formatPerGb } from '../../utils/format'
import { ChevronIcon } from '../Icons'
import PlanDetailPane from './PlanDetailPane'

export interface CatalogFilters {
  search: string
  readyOnly: boolean
  showTests: boolean
  showPrivate: boolean
}

/** What the toolbar's count says: shown of total active plans, and the nodeless ones hidden. */
export interface CatalogCounts {
  shown: number
  total: number
  hiddenNodeless: number
}

type SortKey = 'provider' | 'data' | 'duration' | 'price' | 'per-gb' | 'nodes'

/**
 * Columns in the Nodes table's idiom: one sticky uppercase header, each label a sort
 * button. `dir` is the direction a first click sorts in: cheapest first for prices,
 * biggest first for sizes and counts.
 */
const COLUMNS: { key: SortKey; label: string; right?: boolean; dir: 1 | -1; title?: string }[] = [
  { key: 'provider', label: 'Provider', dir: 1, title: 'Sort by provider. In the list, Up and Down move between plans and Enter opens the selected plan\'s review' },
  { key: 'data', label: 'Data', dir: -1 },
  { key: 'duration', label: 'Valid', dir: -1 },
  { key: 'price', label: 'Price', right: true, dir: 1, title: 'Plan price, in P2P unless marked' },
  { key: 'per-gb', label: 'P2P/GB', right: true, dir: 1, title: 'Price per GB of data' },
  { key: 'nodes', label: 'Nodes', right: true, dir: -1, title: 'Active nodes linked at the last catalog scan' },
]

// Written out in full for Tailwind, and shared by the header and every row so the
// columns line up.
const GRID = 'grid grid-cols-[minmax(120px,1fr)_76px_52px_112px_64px_52px] gap-x-3 items-center'

/**
 * A plan's value for a numeric sort key, or null when it has none. Missing values
 * sort AFTER everything else in both directions: a plan without a udvpn price used
 * to read as free and sort first.
 */
function numericValue(plan: PlanInfo, key: Exclude<SortKey, 'provider'>): number | null {
  switch (key) {
    case 'per-gb': return pricePerGb(plan)
    case 'price': return planPriceDisplay(plan.prices).udvpn
    case 'data': return Number(plan.bytes) || null
    case 'duration': return plan.durationSeconds
    case 'nodes': return plan.nodeCount
  }
}

/**
 * Browse the catalog: a sortable table, and the selected plan's details beside it.
 * Every cached plan lists immediately; node availability for the selection is read
 * by the detail pane, never as a bulk scan on load. The first row is selected on
 * arrival, so the right half of the tab is never an empty "select a plan".
 */
export default function PlanCatalog({ filters, providers, tokenPrice, onCounts, focusPlanId }: {
  filters: CatalogFilters
  providers: ProviderInfo[]
  tokenPrice: TokenPrice | null
  onCounts: (counts: CatalogCounts) => void
  /** A plan to select and scroll to as soon as the filters list it. */
  focusPlanId: string | null
}) {
  const { overview, loading } = usePlansContext()
  // Before the first overview there is nothing to say about the catalog yet: "no
  // plans" would be false, so the table and the pane show placeholders instead.
  const firstLoad = loading && overview.plans.length === 0
  const { plansNodeFilter } = useNavigation()
  const [sortKey, setSortKey] = useState<SortKey>('per-gb')
  const [sortDir, setSortDir] = useState<1 | -1>(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Plan ids containing the node the user arrived from (ConnectionModal's
  // "See Plans tab"). null = no filter or still resolving.
  const [nodeFilterPlanIds, setNodeFilterPlanIds] = useState<Set<string> | null>(null)

  useEffect(() => {
    if (!plansNodeFilter) {
      setNodeFilterPlanIds(null)
      return
    }
    let cancelled = false
    window.api.planListForNode(plansNodeFilter)
      .then((plans) => { if (!cancelled) setNodeFilterPlanIds(new Set(plans.map((p) => p.id))) })
      .catch(() => { if (!cancelled) setNodeFilterPlanIds(new Set()) })
    return () => { cancelled = true }
  }, [plansNodeFilter])

  const providerByAddr = useMemo(() => new Map(providers.map((p) => [p.address, p])), [providers])
  const providerLabel = (plan: PlanInfo) => providerByAddr.get(plan.provAddress)?.name || `${plan.provAddress.slice(0, 14)}...`
  const activeSubByPlan = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of overview.allocations) {
      if (a.status === 1) m.set(a.planId, a.subscriptionId)
    }
    return m
  }, [overview.allocations])

  const { listed, total, hiddenNodeless } = useMemo(() => {
    const q = filters.search.trim().toLowerCase()
    const active = overview.plans.filter((p) => p.status === 1)
    let list = active
    if (!filters.showTests) list = list.filter((p) => !p.isTest)
    if (!filters.showPrivate) list = list.filter((p) => !p.private)
    if (nodeFilterPlanIds) list = list.filter((p) => nodeFilterPlanIds.has(p.id))
    if (q) {
      list = list.filter((p) => {
        const prov = providerByAddr.get(p.provAddress)
        return p.id.includes(q) ||
          p.provAddress.toLowerCase().includes(q) ||
          (prov && (prov.name.toLowerCase().includes(q) || prov.description.toLowerCase().includes(q)))
      })
    }
    // Only a COUNTED zero hides a plan; nodeCount null (never scanned) stays.
    let hiddenNodeless = 0
    if (filters.readyOnly) {
      const before = list.length
      list = list.filter((p) => p.nodeCount !== 0)
      hiddenNodeless = before - list.length
    }
    return { listed: list, total: active.length, hiddenNodeless }
  }, [overview.plans, filters, nodeFilterPlanIds, providerByAddr])

  const sorted = useMemo(() => {
    const name = (p: PlanInfo) => providerByAddr.get(p.provAddress)?.name || p.provAddress
    return [...listed].sort((a, b) => {
      let c: number
      if (sortKey === 'provider') {
        c = sortDir * name(a).localeCompare(name(b))
      } else {
        const va = numericValue(a, sortKey)
        const vb = numericValue(b, sortKey)
        c = va === null && vb === null ? 0 : va === null ? 1 : vb === null ? -1 : sortDir * (va - vb)
      }
      return c || Number(a.id) - Number(b.id)
    })
  }, [listed, sortKey, sortDir, providerByAddr])

  useEffect(() => {
    onCounts({ shown: listed.length, total, hiddenNodeless })
  }, [listed.length, total, hiddenNodeless, onCounts])

  const selected = sorted.find((p) => p.id === selectedId) ?? sorted[0] ?? null
  const listRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)

  // Select the focus plan once it is listed: on arrival, or after "Show it anyway"
  // turns on the chips that hid it.
  const focusListed = focusPlanId !== null && sorted.some((p) => p.id === focusPlanId)
  useEffect(() => {
    if (!focusPlanId || !focusListed) return
    setSelectedId(focusPlanId)
    listRef.current?.querySelector<HTMLElement>(`[data-plan-id="${focusPlanId}"]`)?.scrollIntoView({ block: 'center' })
  }, [focusPlanId, focusListed])
  const listedPerGb = useMemo(
    () => sorted.flatMap((p) => {
      const v = pricePerGb(p)
      return v === null ? [] : [{ id: p.id, perGb: v }]
    }),
    [sorted],
  )

  /**
   * The rows as a list box: Up and Down (Home, End) move the selection and the focus
   * together, and Enter on the selected row presses the pane's button. That button
   * only opens the review window, and does nothing while it is disabled.
   */
  function onRowKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'Enter' && sorted[index].id === selected?.id) {
      e.preventDefault()
      paneRef.current?.querySelector<HTMLButtonElement>('[data-plan-cta]')?.click()
      return
    }
    const next = e.key === 'ArrowDown' ? Math.min(sorted.length - 1, index + 1)
      : e.key === 'ArrowUp' ? Math.max(0, index - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? sorted.length - 1
            : null
    if (next === null) return
    e.preventDefault()
    const id = sorted[next].id
    setSelectedId(id)
    const row = listRef.current?.querySelector<HTMLElement>(`[data-plan-id="${id}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }

  function toggleSort(col: (typeof COLUMNS)[number]) {
    if (sortKey === col.key) setSortDir((d) => (d === 1 ? -1 : 1))
    else {
      setSortKey(col.key)
      setSortDir(col.dir)
    }
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div ref={listRef} className="flex-1 min-w-0 overflow-auto">
        <div className={`${GRID} sticky top-0 z-10 px-4 py-2 border-b border-border bg-bg-secondary text-text-secondary text-xs font-medium uppercase tracking-wide select-none`}>
          {COLUMNS.map((col) => (
            <button
              key={col.key}
              type="button"
              onClick={() => toggleSort(col)}
              title={col.title}
              className={`flex items-center gap-1 uppercase tracking-wide hover:text-accent transition-colors ${
                col.right ? 'justify-end' : ''
              } ${sortKey === col.key ? 'text-text-primary' : ''}`}
            >
              {col.label}
              {sortKey === col.key && (
                <ChevronIcon direction={sortDir === 1 ? 'up' : 'down'} className="w-3 h-3 text-accent" />
              )}
            </button>
          ))}
        </div>

        {firstLoad ? (
          <div role="status" aria-label="Loading the plan catalog">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className={`${GRID} h-12 px-4 border-b border-border`}>
                <span className="space-y-1.5">
                  <span className="skeleton block h-3 w-3/5" />
                  <span className="skeleton block h-2.5 w-10" />
                </span>
                <span className="skeleton h-3 w-12" />
                <span className="skeleton h-3 w-8" />
                <span className="skeleton h-3 w-16 justify-self-end" />
                <span className="skeleton h-3 w-10 justify-self-end" />
                <span className="skeleton h-3 w-6 justify-self-end" />
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-text-secondary text-sm p-4">
            {overview.plans.length === 0
              ? 'No plans in the catalog yet. Rescan to load them from the chain.'
              : 'No plans match these filters.'}
          </p>
        ) : (
          sorted.map((plan, index) => {
            const price = planPriceDisplay(plan.prices)
            const perGb = pricePerGb(plan)
            const subscribed = activeSubByPlan.has(plan.id)
            const isSelected = selected?.id === plan.id
            return (
              <button
                key={plan.id}
                type="button"
                data-plan-id={plan.id}
                onClick={() => setSelectedId(plan.id)}
                onKeyDown={(e) => onRowKeyDown(e, index)}
                // One tab stop for the whole list, on the selected row: Tab enters the
                // list and the next Tab leaves it, rather than walking every plan.
                tabIndex={isSelected ? 0 : -1}
                aria-pressed={isSelected}
                aria-keyshortcuts="ArrowUp ArrowDown Home End Enter"
                className={`${GRID} w-full h-12 px-4 border-b border-border text-left transition-colors scroll-mt-9 ${
                  isSelected ? 'bg-accent-subtle' : 'hover:bg-bg-tertiary'
                }`}
              >
                <span className="min-w-0 leading-tight">
                  <span className="block text-sm text-text-primary truncate">{providerLabel(plan)}</span>
                  <span className="flex items-center gap-1.5 text-xs text-text-tertiary mt-0.5">
                    <span className="font-mono">#{plan.id}</span>
                    {subscribed && (
                      <span className="text-[10px] font-mono uppercase bg-success-subtle text-success px-1.5 py-px rounded-sm">subscribed</span>
                    )}
                    {plan.isTest && (
                      <span className="text-[10px] font-mono uppercase bg-warning-subtle text-warning px-1.5 py-px rounded-sm">test</span>
                    )}
                    {plan.private && (
                      <span className="text-[10px] font-mono uppercase bg-info-subtle text-info px-1.5 py-px rounded-sm">private</span>
                    )}
                  </span>
                </span>
                <span className="text-sm font-semibold text-accent whitespace-nowrap">{formatBytes(plan.bytes)}</span>
                <span className="text-sm text-text-secondary whitespace-nowrap">{formatDuration(plan.durationSeconds)}</span>
                <span className="text-right font-mono text-xs text-text-primary truncate" title={price.amount ? `${price.amount} ${price.denomLabel}` : undefined}>
                  {price.amount
                    ? <>{price.amount}{price.denomLabel !== 'P2P' && <span className="text-text-tertiary"> {price.denomLabel}</span>}</>
                    : <span className="text-text-tertiary">no price</span>}
                </span>
                <span className="text-right font-mono text-xs text-text-secondary">
                  {perGb !== null ? formatPerGb(perGb) : '-'}
                </span>
                <span className={`text-right font-mono text-xs ${
                  plan.nodeCount === null ? 'text-text-tertiary' : plan.nodeCount === 0 ? 'text-warning' : 'text-success'
                }`}>
                  {plan.nodeCount === null ? '?' : plan.nodeCount === 0 ? 'none' : plan.nodeCount}
                </span>
              </button>
            )
          })
        )}
      </div>

      <div ref={paneRef} className="w-[42%] min-w-[380px] max-w-[560px] shrink-0 border-l border-border min-h-0">
        {selected ? (
          <PlanDetailPane
            key={selected.id}
            plan={selected}
            provider={providerByAddr.get(selected.provAddress) ?? null}
            tokenPrice={tokenPrice}
            activeSubscriptionId={activeSubByPlan.get(selected.id) ?? null}
            listedPerGb={listedPerGb}
          />
        ) : firstLoad ? (
          <div className="p-5 space-y-5" aria-hidden="true">
            <span className="skeleton block h-4 w-2/5" />
            <div className="grid grid-cols-2 gap-2.5">
              <span className="skeleton block h-16" />
              <span className="skeleton block h-16" />
            </div>
            <span className="skeleton block h-10" />
            <span className="skeleton block h-[136px]" />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center px-8 text-center text-text-tertiary text-sm">
            Nothing to show: no plan matches these filters.
          </div>
        )}
      </div>
    </div>
  )
}
