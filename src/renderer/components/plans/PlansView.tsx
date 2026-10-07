import { useEffect, useState } from 'react'
import type { ProviderInfo, TokenPrice } from '../../types'
import { usePlansContext } from '../../contexts/PlansContext'
import { useNavigation } from '../../contexts/NavigationContext'
import { useConnection } from '../../hooks/useConnection'
import { formatTimeAgo } from '../../utils/format'
import MyPlansPanel from './MyPlansPanel'
import PlanCatalog, { type CatalogCounts, type CatalogFilters } from './PlanCatalog'
import { Segmented } from '../ConnectReview'
import { Chip } from '../nodes/NodeFilters'
import Spinner from '../Spinner'
import { AlertIcon, CloseIcon, EyeIcon, LockIcon, PowerIcon, RefreshIcon, SearchIcon } from '../Icons'

type Section = 'mine' | 'catalog'

/** "a", "a and b", "a, b, and c". */
function joinReasons(parts: string[]): string {
  if (parts.length <= 2) return parts.join(' and ')
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/**
 * The Plans tab: My plans (the wallet's subscriptions, one-click connect) and
 * the Catalog (browse and subscribe). Overview state lives in PlansContext above
 * the tab, so switching tabs does not reset it.
 *
 * The toolbar is the Nodes tab's, on purpose: the same shaded bar, search with its
 * icon, pill chips for the filters, a "N of M" count and a ghost refresh. It used to
 * be its own dialect (native checkboxes, a native sort select, a bordered Rescan), and
 * the tab read as a different app (2026-10-06). The catalog's filters live here, not
 * in PlanCatalog, because they sit in this bar; the catalog reports its counts back.
 */
export default function PlansView() {
  const { overview, loading, discovering, progress, discoverError, discover, ensureFreshCatalog } = usePlansContext()
  const { plansNodeFilter, clearPlansNodeFilter, plansFocusPlan, clearPlansFocusPlan } = useNavigation()
  const { status } = useConnection()
  // Rescan needs the chain, which our own tunnel makes unreachable (proxy mode
  // leaves routing alone, so it still works there).
  const chainFrozen = (status.state === 'connected' || status.state === 'reconnecting') && !status.proxyMode
  // Arriving from the Provider tab's "See it as a subscriber" opens the catalog.
  const [section, setSection] = useState<Section>(
    overview.subscriptions.length > 0 && !plansFocusPlan ? 'mine' : 'catalog',
  )
  const [filters, setFilters] = useState<CatalogFilters>({
    search: '',
    // Hide plans whose availability scan counted ZERO nodes (nothing to connect to,
    // so nothing to buy). Plans never counted (null) stay visible either way.
    readyOnly: true,
    showTests: false,
    showPrivate: false,
  })
  const [counts, setCounts] = useState<CatalogCounts | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [tokenPrice, setTokenPrice] = useState<TokenPrice | null>(null)

  useEffect(() => {
    window.api.providerList().then(setProviders).catch(() => setProviders([]))
    window.api.priceToken().then(setTokenPrice).catch(() => setTokenPrice(null))
  }, [])

  // Arriving from a node's "See Plans tab" targets the catalog.
  useEffect(() => {
    if (plansNodeFilter) setSection('catalog')
  }, [plansNodeFilter])

  // An old catalog rescans when someone actually looks at it, not at launch.
  useEffect(() => {
    if (section === 'catalog') void ensureFreshCatalog()
  }, [section, ensureFreshCatalog])

  const catalogOld = overview.fetchedAt !== null && Date.now() - overview.fetchedAt > 3600_000
  const update = (patch: Partial<CatalogFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const subCount = overview.subscriptions.length

  // The plan the Provider tab asked to see as a subscriber would. What hides it from
  // one browsing with the catalog's DEFAULT filters, in the workspace checks' words;
  // `hiddenNow` is whether the filters on screen still hide it.
  const focus = plansFocusPlan ? overview.plans.find((p) => p.id === plansFocusPlan) ?? null : null
  const focusReasons = focus
    ? [
        focus.private && 'it is private',
        focus.isTest && 'it is filed under Test plans',
        focus.nodeCount === 0 && 'it had no nodes at the last catalog scan',
      ].filter((r): r is string => Boolean(r))
    : []
  const focusHiddenNow = focus !== null && (
    (focus.private && !filters.showPrivate) ||
    (focus.isTest && !filters.showTests) ||
    (focus.nodeCount === 0 && filters.readyOnly)
  )
  const showFocusAnyway = () => {
    if (!focus) return
    setFilters((f) => ({
      ...f,
      search: '',
      showPrivate: f.showPrivate || focus.private,
      showTests: f.showTests || focus.isTest,
      readyOnly: f.readyOnly && focus.nodeCount !== 0,
    }))
  }

  return (
    <div className="h-full flex flex-col">
      {/* One row that wraps, like NodeFilters: the controls on the left, the count and
          Rescan grouped with ml-auto so they wrap as a unit and stay right-aligned. */}
      <div className="border-b border-border bg-bg-secondary px-4 py-3 shrink-0">
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
          <Segmented
            label="Plans section"
            value={section}
            options={[['mine', subCount > 0 ? `My plans (${subCount})` : 'My plans'], ['catalog', 'Catalog']]}
            onChange={setSection}
          />

          {section === 'catalog' && (
            <>
              <div className="relative">
                <SearchIcon className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                <input
                  type="text"
                  value={filters.search}
                  onChange={(e) => update({ search: e.target.value })}
                  placeholder="Plans and providers"
                  aria-label="Search plans and providers"
                  className="bg-bg-tertiary border border-border text-text-primary text-sm pl-8 pr-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus w-[220px] placeholder:text-text-tertiary"
                />
              </div>
              <Chip on={filters.readyOnly} label="Ready to connect" Icon={PowerIcon} onToggle={() => update({ readyOnly: !filters.readyOnly })} />
              <Chip on={filters.showTests} label="Test plans" Icon={AlertIcon} onToggle={() => update({ showTests: !filters.showTests })} />
              <Chip on={filters.showPrivate} label="Private" Icon={LockIcon} onToggle={() => update({ showPrivate: !filters.showPrivate })} />
              {/* The node a "See Plans tab" came from. Always on while present; the
                  only action is to dismiss it, like the Nodes tab's country chip. */}
              {plansNodeFilter && (
                <button
                  type="button"
                  onClick={clearPlansNodeFilter}
                  title="Only plans that include this node. Click to show every plan again."
                  className="flex items-center gap-1.5 border rounded-full pl-2.5 pr-2 py-1 text-xs transition-colors select-none bg-accent-subtle border-accent text-accent"
                >
                  With node <span className="font-mono">{plansNodeFilter.slice(0, 14)}...</span>
                  <CloseIcon className="w-3 h-3" />
                </button>
              )}
            </>
          )}

          <div className="ml-auto flex items-center gap-3">
            {overview.stale && (
              <span className="text-warning text-xs">Cached data, chain unreachable while connected</span>
            )}
            {section === 'catalog' && (
              <>
                {/* Nothing to count before the first read: "0 of 0 plans" would be false
                    while the table shows placeholders. */}
                {!loading && <span className="text-text-secondary text-xs">
                  {counts && (
                    <>
                      {counts.shown.toLocaleString('en')} of {counts.total.toLocaleString('en')} plans
                      {counts.hiddenNodeless > 0 && ` · ${counts.hiddenNodeless} without nodes hidden`}
                    </>
                  )}
                  <span
                    className={catalogOld ? 'text-warning' : 'text-text-tertiary'}
                    title={catalogOld ? 'Over an hour old. Rescan reads the catalog from the chain again.' : undefined}
                  >
                    {counts ? ' · ' : ''}
                    {overview.fetchedAt ? `Updated ${formatTimeAgo(overview.fetchedAt)}` : 'Not loaded yet'}
                  </span>
                </span>}
                <button
                  onClick={() => void discover()}
                  disabled={discovering || chainFrozen}
                  title={chainFrozen ? 'The chain is not reachable while the VPN is connected' : 'Read the plan catalog from the chain again'}
                  className="flex items-center gap-1.5 text-text-secondary hover:text-accent text-sm transition-colors disabled:opacity-30"
                >
                  {discovering ? <Spinner className="text-accent" /> : <RefreshIcon className="w-3.5 h-3.5" />}
                  {discovering ? 'Scanning' : 'Rescan'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {discovering && progress && (
        <div className="px-5 py-2 border-b border-border text-xs text-text-secondary flex items-center gap-3 shrink-0">
          <Spinner className="text-accent" />
          {progress.phase === 'connecting'
            ? 'Connecting to the chain...'
            : progress.phase === 'nodes'
              ? `Checking node availability: ${progress.done} of ${progress.total}`
              : `Scanning plans: ${progress.done}${progress.phase === 'done' ? ' loaded' : ''}`}
          {(progress.phase === 'fetching' || progress.phase === 'nodes') && progress.done > 0 && (
            <div className="flex-1 h-1 bg-bg-tertiary rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, (progress.done / Math.max(progress.total, progress.done)) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {discoverError && !discovering && (
        <div className="mx-5 mt-3 bg-danger-subtle border border-danger px-3 py-2 rounded-md text-sm text-danger flex items-center gap-3 shrink-0">
          <span className="flex-1">{discoverError}</span>
          <button onClick={() => void discover()} className="btn btn-danger text-xs px-2 py-0.5">
            Retry
          </button>
        </div>
      )}

      {section === 'catalog' && plansFocusPlan && (
        <div className={`mx-5 mt-3 border px-3 py-2 rounded-md text-sm text-text-primary flex items-center gap-3 shrink-0 ${
          focusReasons.length > 0 ? 'bg-warning-subtle border-warning' : 'bg-bg-secondary border-border'
        }`}>
          {focusReasons.length > 0
            ? <AlertIcon className="w-4 h-4 text-warning shrink-0" />
            : <EyeIcon className="w-4 h-4 text-accent shrink-0" />}
          <span className="flex-1">
            {!focus
              ? `Plan #${plansFocusPlan} is not in the catalog yet. Rescan reads it from the chain.`
              : focusReasons.length > 0
                ? `Plan #${focus.id} is hidden from subscribers by default: ${joinReasons(focusReasons)}.`
                : `Plan #${focus.id} is listed for every subscriber with the catalog's default filters.`}
          </span>
          {focusHiddenNow && (
            <button onClick={showFocusAnyway} className="btn btn-secondary text-xs px-2.5 py-1 shrink-0">
              Show it anyway
            </button>
          )}
          <button
            type="button"
            onClick={clearPlansFocusPlan}
            aria-label="Dismiss"
            className="text-text-tertiary hover:text-text-primary transition-colors shrink-0"
          >
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {section === 'mine' ? (
        <MyPlansPanel providers={providers} onBrowse={() => setSection('catalog')} />
      ) : (
        <PlanCatalog
          filters={filters}
          providers={providers}
          tokenPrice={tokenPrice}
          onCounts={setCounts}
          focusPlanId={plansFocusPlan}
        />
      )}
    </div>
  )
}
