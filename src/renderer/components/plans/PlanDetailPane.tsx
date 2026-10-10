import { useEffect, useMemo, useState } from 'react'
import { geoNaturalEarth1, geoPath } from 'd3-geo'
import type { PlanInfo, ProviderInfo, SentNode, TokenPrice } from '../../types'
import { useNodesContext } from '../../contexts/NodesContext'
import { useConnection } from '../../hooks/useConnection'
import { formatBytes, formatDuration, planPriceDisplay, pricePerGb, formatPerGb, UNLIMITED_BYTES_THRESHOLD } from '../../utils/format'
import { usdEstimate } from '../../utils/provider-format'
import { protocolMeta } from '../../utils/protocols'
import { compareToNodes, decadeScale, nodeMedianPerGb } from '../../utils/plan-value'
import { countryCode, polyCode } from '../../utils/country-codes'
import { countryPoint, useWorldCountries } from '../map/world-geo'
import { FooterReason } from '../ConnectReview'
import CountryFlag from '../CountryFlag'
import ProtocolIcon from '../ProtocolIcon'
import PlanConnectModal from './PlanConnectModal'

interface Props {
  plan: PlanInfo
  provider: ProviderInfo | null
  tokenPrice: TokenPrice | null
  /** Active subscription ids for this plan, so the pane can offer reuse. */
  activeSubscriptionId: string | null
  /** Every listed plan's price per GB, for the value strip. */
  listedPerGb: { id: string; perGb: number }[]
}

/** How many countries get a chip before the rest fold into "+N more". */
const COUNTRY_CHIPS = 6

/**
 * The selected plan: who sells it, an honest price (real denom, never free), what it
 * is worth against every other listed plan and against paying a node directly, and
 * where its nodes are. The node list is fetched on selection, not in bulk for the
 * catalog. The button sits in a footer that never scrolls away and always says what
 * stops it, like the connect windows.
 */
export default function PlanDetailPane({ plan, provider, tokenPrice, activeSubscriptionId, listedPerGb }: Props) {
  const { allNodes } = useNodesContext()
  const { status } = useConnection()
  const tunnelUp = status.state === 'connected' || status.state === 'reconnecting'
  const [nodeAddrs, setNodeAddrs] = useState<string[] | null>(null)
  // Unknown is not empty: main answers null when it cannot know (our own tunnel
  // freezes the chain, or the read failed with nothing cached). Claiming "no
  // nodes" then is false, and was shown for the very plan the user was
  // connected through.
  const [nodesUnknown, setNodesUnknown] = useState(false)
  const [showConnect, setShowConnect] = useState(false)

  useEffect(() => {
    let cancelled = false
    setNodeAddrs(null)
    setNodesUnknown(false)
    window.api.planNodes(plan.id)
      .then((addrs) => {
        if (cancelled) return
        setNodeAddrs(addrs ?? [])
        setNodesUnknown(addrs === null)
      })
      .catch(() => { if (!cancelled) { setNodeAddrs([]); setNodesUnknown(true) } })
    return () => { cancelled = true }
  }, [plan.id])

  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])
  const nodeMedian = useMemo(() => nodeMedianPerGb(allNodes), [allNodes])
  const coverage = useMemo(() => {
    if (nodeAddrs === null) return null
    const known = nodeAddrs.map((a) => nodeIndex.get(a)).filter((n): n is SentNode => n !== undefined)
    const byCountry = new Map<string, number>()
    const byType = new Map<number, number>()
    for (const n of known) {
      if (n.country) byCountry.set(n.country, (byCountry.get(n.country) ?? 0) + 1)
      byType.set(n.type, (byType.get(n.type) ?? 0) + 1)
    }
    return {
      total: nodeAddrs.length,
      healthy: known.filter((n) => n.isHealthy && n.isActive).length,
      countries: [...byCountry].sort((a, b) => b[1] - a[1]),
      protocols: [...byType].sort((a, b) => b[1] - a[1]),
    }
  }, [nodeAddrs, nodeIndex])

  const price = planPriceDisplay(plan.prices)
  const perGb = pricePerGb(plan)
  const usd = price.udvpn !== null && tokenPrice ? usdEstimate(price.udvpn, tokenPrice.usd) : null

  // Last known node count while live data is unavailable: this visit's fetch if
  // it got one, else the catalog scan's persisted count.
  const lastKnownCount = coverage !== null && !nodesUnknown ? coverage.total : plan.nodeCount

  // The active session was started from this plan's subscription: a chain fact
  // (a plan session's row names its subscription; main surfaces it on the
  // status), not a guess from node membership. The earlier heuristic needed the
  // plan's node list, which a fresh app run cannot read while connected, so the
  // label silently fell back exactly when it mattered. When the subscription is
  // unknown the generic label stays.
  const connectedViaPlan = tunnelUp && activeSubscriptionId !== null &&
    status.subscriptionId === activeSubscriptionId
  const confirmedNoNodes = coverage !== null && !nodesUnknown && coverage.total === 0
  const noneHealthy = !tunnelUp && coverage !== null && !nodesUnknown && coverage.total > 0 && coverage.healthy === 0

  // The footer's one line: what stops the button, or what to know before pressing it.
  // Connected through something else is not a reason: the review offers the switch
  // ([RN-10]) and says what it does.
  const reason: { text: string; tone: 'danger' | 'muted' } | null =
    connectedViaPlan ? { text: 'This plan is serving your current connection.', tone: 'muted' }
      : plan.status !== 1 ? { text: 'This plan is not active on chain, so it cannot be bought.', tone: 'danger' }
        : confirmedNoNodes ? { text: 'Nothing to connect to: no nodes are linked to this plan.', tone: 'danger' }
          : noneHealthy ? { text: 'You can buy it, but none of its nodes passes the health check right now.', tone: 'muted' }
            : null

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-text-primary text-base font-semibold">
              {provider?.name || `${plan.provAddress.slice(0, 14)}...${plan.provAddress.slice(-6)}`}
            </h3>
            <span className="text-text-tertiary text-xs font-mono">plan #{plan.id}</span>
            {plan.isTest && (
              <span className="text-[10px] font-mono uppercase bg-warning-subtle text-warning px-1.5 py-0.5 rounded-sm">test</span>
            )}
            {plan.private && (
              <span className="text-[10px] font-mono uppercase bg-info-subtle text-info px-1.5 py-0.5 rounded-sm">private</span>
            )}
          </div>
          {provider?.description && (
            <p className="text-text-tertiary text-xs mt-1">{provider.description}</p>
          )}
        </div>

        {/* The price takes a row of its own until the pane is wide enough for three
            tiles: "25,974.03 P2P" does not fit a third of the 380px minimum. */}
        <div className="grid grid-cols-2 min-[1180px]:grid-cols-3 gap-2.5">
          <Tile label="Price" className="col-span-2 min-[1180px]:col-span-1">
            {price.amount ? (
              <>
                <div className="text-accent text-lg font-semibold leading-snug truncate" title={`${price.amount} ${price.denomLabel}`}>
                  {price.amount} <span className="text-sm">{price.denomLabel.length > 6 ? `${price.denomLabel.slice(0, 6)}...` : price.denomLabel}</span>
                </div>
                {usd && <div className="text-text-tertiary text-xs">{usd}</div>}
              </>
            ) : (
              <div className="text-text-secondary text-sm mt-1">No price listed</div>
            )}
          </Tile>
          <Tile label="Data">
            <div className="text-text-primary text-lg font-semibold leading-snug">{formatBytes(plan.bytes)}</div>
            {perGb !== null && <div className="text-text-tertiary text-xs">{formatPerGb(perGb)} P2P per GB</div>}
          </Tile>
          <Tile label="Valid for">
            <div className="text-text-primary text-lg font-semibold leading-snug">{formatDuration(plan.durationSeconds)}</div>
            <div className="text-text-tertiary text-xs">from purchase</div>
          </Tile>
        </div>

        {price.udvpn === null && price.amount && (
          <p className="text-warning text-xs">
            Priced in {price.denomLabel}. This app cannot estimate that in USD, compare it per GB, or check your balance for it.
          </p>
        )}

        {price.udvpn !== null && (
          <ValueStrip plan={plan} perGb={perGb} listed={listedPerGb} nodeMedian={nodeMedian} />
        )}

        <section>
          <SectionLabel>Coverage</SectionLabel>
          {/* Connected comes FIRST, even when a list was fetched before the tunnel
              came up: the chain and the node directory are both frozen (caches)
              while connected, so "50 healthy right now" would be a claim nothing
              can currently back. */}
          {tunnelUp ? (
            <div className="space-y-1 text-sm">
              <p className="text-text-secondary">The node list cannot be checked live while connected.</p>
              {lastKnownCount !== null && (
                <p className="text-text-primary">
                  {lastKnownCount} node{lastKnownCount === 1 ? '' : 's'} linked at the last check.
                </p>
              )}
            </div>
          ) : coverage === null ? (
            <div className="flex gap-4 items-start flex-wrap" role="status" aria-label="Checking the plan's nodes">
              <span className="skeleton block w-[280px] h-[136px]" />
              <div className="flex-1 min-w-[150px] space-y-2.5">
                <span className="skeleton block h-3.5 w-4/5" />
                <div className="flex gap-1.5">
                  <span className="skeleton h-5 w-14 rounded-full" />
                  <span className="skeleton h-5 w-14 rounded-full" />
                  <span className="skeleton h-5 w-14 rounded-full" />
                </div>
                <div className="flex gap-1.5">
                  <span className="skeleton h-5 w-20 rounded-full" />
                  <span className="skeleton h-5 w-16 rounded-full" />
                </div>
              </div>
            </div>
          ) : nodesUnknown ? (
            <div className="space-y-1 text-sm">
              <p className="text-text-secondary">Could not read the plan's node list right now.</p>
              {plan.nodeCount !== null && (
                <p className="text-text-primary">
                  {plan.nodeCount} node{plan.nodeCount === 1 ? '' : 's'} linked at the last catalog scan.
                </p>
              )}
            </div>
          ) : coverage.total === 0 ? (
            <p className="text-warning text-sm">No nodes are linked to this plan right now. Subscribing would buy data with nowhere to use it.</p>
          ) : (
            <div className="flex gap-4 items-start flex-wrap">
              <CoverageMap countries={coverage.countries} />
              <div className="flex-1 min-w-[150px] space-y-2.5">
                <p className={`text-sm ${coverage.healthy === 0 ? 'text-warning' : 'text-text-primary'}`}>
                  {coverage.healthy === 0
                    ? `None of its ${coverage.total} linked node${coverage.total === 1 ? '' : 's'} passes the health check right now.`
                    : `${coverage.total} node${coverage.total === 1 ? '' : 's'} linked, ${coverage.healthy} healthy right now` +
                      (coverage.countries.length > 1 ? `, in ${coverage.countries.length} countries.` : '.')}
                </p>
                {coverage.countries.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {coverage.countries.slice(0, COUNTRY_CHIPS).map(([country, n]) => (
                      <span key={country} className={PILL}>
                        <CountryFlag country={country} />
                        {country} <span className="font-mono text-text-tertiary">{n}</span>
                      </span>
                    ))}
                    {coverage.countries.length > COUNTRY_CHIPS && (
                      <span className={PILL}>+{coverage.countries.length - COUNTRY_CHIPS} more</span>
                    )}
                  </div>
                )}
                {coverage.protocols.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {coverage.protocols.map(([type, n]) => (
                      <span key={type} className={PILL}>
                        <ProtocolIcon type={type} className={`w-3.5 h-3.5 ${protocolMeta(type).color}`} />
                        {protocolMeta(type).label} <span className="font-mono text-text-tertiary">{n}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-border bg-bg-secondary px-5 pt-3.5 pb-4 space-y-2.5">
        {reason && <FooterReason text={reason.text} tone={reason.tone} />}
        <button
          data-plan-cta
          onClick={() => setShowConnect(true)}
          disabled={connectedViaPlan || plan.status !== 1 || confirmedNoNodes}
          className="btn btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {connectedViaPlan
            ? 'Connected via this plan'
            : activeSubscriptionId ? 'Connect (already subscribed)' : 'Subscribe and connect'}
        </button>
      </div>

      {showConnect && (
        <PlanConnectModal
          plan={plan}
          subscriptionId={activeSubscriptionId ?? undefined}
          onClose={() => setShowConnect(false)}
        />
      )}
    </div>
  )
}

const PILL = 'inline-flex items-center gap-1.5 text-xs text-text-secondary bg-bg-secondary border border-border rounded-full px-2 py-0.5'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide mb-2">{children}</div>
}

function Tile({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`bg-bg-secondary border border-border rounded-md px-3.5 py-3 min-w-0 ${className}`}>
      <div className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}

/** "4x", "1.5x", "over 100x": a factor said the way a person would. */
function factorText(f: number): string {
  if (f > 100) return 'over 100x'
  return f >= 10 ? `${Math.round(f)}x` : `${parseFloat(f.toFixed(1))}x`
}

/**
 * Where this plan's price per GB sits: a log strip with every listed plan as a grey
 * dot, this one in the accent, and the median price of paying a healthy node directly
 * as a marker. One sentence underneath says it in words, so nothing depends on
 * reading the dots. Unlimited plans have no per-GB price, so they are compared by how
 * much data the same money buys from a node instead. The Provider tab's New plan form
 * draws it too, so a provider prices against the same picture a subscriber sees.
 */
export function ValueStrip({ plan, perGb, listed, nodeMedian, headingClassName = 'text-text-tertiary text-[10px] font-medium uppercase tracking-wide' }: {
  /** A catalog plan, or the Provider tab's draft of one (id 'draft'). */
  plan: Pick<PlanInfo, 'id' | 'prices' | 'bytes' | 'durationSeconds'>
  perGb: number | null
  listed: { id: string; perGb: number }[]
  nodeMedian: number | null
  /** The Provider tab heads its cards a size up from this pane's labels. */
  headingClassName?: string
}) {
  const others = listed.filter((p) => p.id !== plan.id)
  const scale = decadeScale([...others.map((p) => p.perGb), ...(perGb !== null ? [perGb] : []), ...(nodeMedian !== null ? [nodeMedian] : [])])
  const udvpn = planPriceDisplay(plan.prices).udvpn
  const unlimited = Number(plan.bytes) >= UNLIMITED_BYTES_THRESHOLD

  let sentence: string
  if (perGb !== null) {
    sentence = `${formatPerGb(perGb)} P2P per GB.`
    if (nodeMedian !== null) {
      const c = compareToNodes(perGb, nodeMedian)
      sentence += ` Paying a node directly costs a median ${formatPerGb(nodeMedian)} P2P per GB, so this plan is ` +
        (c.kind === 'cheaper' ? `${factorText(c.factor)} cheaper per GB.`
          : c.kind === 'dearer' ? `${factorText(c.factor)} dearer per GB.`
            : 'about the same per GB.')
    }
  } else if (unlimited && udvpn !== null && nodeMedian !== null) {
    const gb = Math.round(udvpn / 1e6 / nodeMedian)
    sentence = `Unlimited data, so no price per GB. The same money buys about ${gb.toLocaleString('en-US')} GB from a node ` +
      `paid directly at the median ${formatPerGb(nodeMedian)} P2P per GB, so the plan pays off past that within ${formatDuration(plan.durationSeconds)}.`
  } else {
    sentence = 'No price per GB to compare.'
  }

  // Plain decimals up to four places, powers of ten past that: a test plan priced at
  // 1e-14 P2P per GB printed a sixteen-character label. At most six labels, so a wide
  // span does not pile them on top of each other.
  const tick = (e: number) => (Math.abs(e) <= 4
    ? (e >= 0 ? String(10 ** e) : (10 ** e).toFixed(-e))
    : <>10<sup>{e}</sup></>)
  const labelEvery = Math.ceil((scale.ticks.length - 1) / 5)

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
        <div className={`${headingClassName} mb-2`}>Value per GB</div>
        <span className="flex items-center gap-3 text-[11px] text-text-tertiary">
          {perGb !== null && (
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-accent" />this plan</span>
          )}
          {others.length > 0 && (
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-text-tertiary" />other listed plans</span>
          )}
          {nodeMedian !== null && (
            <span className="flex items-center gap-1.5"><span className="w-0 h-0 border-x-[5px] border-x-transparent border-t-[7px] border-t-info" />nodes paid directly</span>
          )}
        </span>
      </div>
      <div className="relative h-7 mx-1.5" role="img" aria-label={sentence}>
        <div className="absolute inset-x-0 top-[13px] h-0.5 rounded-full bg-bg-tertiary" />
        {others.map((p) => (
          <span
            key={p.id}
            title={`Plan #${p.id}: ${formatPerGb(p.perGb)} P2P per GB`}
            className="absolute top-1 w-5 h-5 -translate-x-1/2 grid place-items-center"
            style={{ left: `${scale.at(p.perGb)}%` }}
          >
            <span className="w-2 h-2 rounded-full bg-text-tertiary opacity-60" />
          </span>
        ))}
        {nodeMedian !== null && (
          <span
            title={`Nodes paid directly: median ${formatPerGb(nodeMedian)} P2P per GB`}
            className="absolute top-0 w-5 h-4 -translate-x-1/2 flex justify-center"
            style={{ left: `${scale.at(nodeMedian)}%` }}
          >
            <span className="w-0 h-0 border-x-[6px] border-x-transparent border-t-[9px] border-t-info" />
          </span>
        )}
        {perGb !== null && (
          <span
            title={`This plan: ${formatPerGb(perGb)} P2P per GB`}
            className="absolute top-0.5 w-6 h-6 -translate-x-1/2 grid place-items-center"
            style={{ left: `${scale.at(perGb)}%` }}
          >
            <span className="w-3.5 h-3.5 rounded-full bg-accent ring-[3px] ring-accent-subtle" />
          </span>
        )}
      </div>
      <div className="relative h-3.5 mx-1.5 text-[10px] font-mono text-text-tertiary">
        {scale.ticks.map((e, i) => i % labelEvery === 0 && (
          <span
            key={e}
            className={`absolute ${i === 0 ? '' : i === scale.ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2'}`}
            style={{ left: `${(i / (scale.ticks.length - 1)) * 100}%` }}
          >
            {tick(e)}
          </span>
        ))}
      </div>
      <p className="text-text-secondary text-xs mt-2">{sentence}</p>
    </section>
  )
}

const MAP_W = 280
const MAP_H = 136

// Written out in full for Tailwind; global.css defines the three steps.
const COVERAGE_CLASS = ['route-map-land', 'coverage-1', 'coverage-2', 'coverage-3'] as const

function coverageStep(n: number): 0 | 1 | 2 | 3 {
  return n >= 10 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0
}

/**
 * Where the plan's nodes are: countries shaded by how many of its nodes they hold, one
 * hue in three steps, with a legend. Countries too small for the world file are drawn
 * as dots. SVG with d3-geo, never WebGL, and static: it recomputes only when the plan's
 * countries change. The chips beside it say the same in words.
 */
function CoverageMap({ countries }: { countries: [string, number][] }) {
  const world = useWorldCountries()
  const drawn = useMemo(() => {
    if (!world) return null
    const counts = new Map(countries.map(([c, n]) => [countryCode(c), n]))
    const projection = geoNaturalEarth1().fitExtent([[2, 2], [MAP_W - 2, MAP_H - 2]], { type: 'Sphere' })
    const path = geoPath(projection)
    const byCode = new Map(world.map((f) => [polyCode(f), f]))
    const land = world
      .filter((f) => polyCode(f) !== 'aq')
      .map((f, i) => ({ key: polyCode(f) || String(i), d: path(f) ?? '', step: coverageStep(counts.get(polyCode(f)) ?? 0) }))
    const dots = countries
      .flatMap(([c, n]) => {
        const code = countryCode(c)
        if (!code || byCode.has(code)) return []
        const p = countryPoint(code, byCode)
        const xy = p ? projection(p) : null
        return xy ? [{ key: c, x: xy[0], y: xy[1], step: coverageStep(n) }] : []
      })
    return { land, dots }
  }, [world, countries])

  return (
    <figure className="shrink-0">
      <svg
        width={MAP_W}
        height={MAP_H}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        role="img"
        aria-label={`Map of the ${countries.length} countr${countries.length === 1 ? 'y' : 'ies'} this plan's nodes are in`}
        className="block rounded-sm border border-border bg-bg-primary"
      >
        {drawn?.land.map((c) => c.d && <path key={c.key} d={c.d} className={COVERAGE_CLASS[c.step]} />)}
        {drawn?.dots.map((d) => (
          <circle key={d.key} cx={d.x} cy={d.y} r={2.6} className={COVERAGE_CLASS[d.step]} />
        ))}
      </svg>
      <figcaption className="flex gap-3 mt-1 text-[10px] text-text-tertiary">
        {(['1-2', '3-9', '10+'] as const).map((label, i) => (
          <span key={label} className="flex items-center gap-1">
            <svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" className={COVERAGE_CLASS[i + 1]} /></svg>
            {i === 0 ? `${label} nodes` : label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}
