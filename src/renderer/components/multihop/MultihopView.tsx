import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { geoInterpolate, geoNaturalEarth1, geoPath } from 'd3-geo'
import { countryPoint, useWorldCountries } from '../map/world-geo'
import { matchesSearch, useNodes } from '../../hooks/useNodes'
import { useConnection } from '../../hooks/useConnection'
import { useNodeTest } from '../../hooks/useNodeTest'
import { useNodesContext } from '../../contexts/NodesContext'
import { useChainDraft } from '../../contexts/ChainDraftContext'
import {
  chainRowRank,
  chainRowState,
  hopChipState,
  isChainable,
  isTooOldToChain,
  isVerifiedFor,
  pickChainPair,
  swapBlocker,
  udvpnPrice,
  type BillingType,
  type ChainRole,
  type HopChipState,
} from '../../utils/chain-node'
import { pairConflict } from '../../utils/chain-diversity'
import { formatP2p } from '../../../shared/funds'
import { COUNTRY_CODES } from '../../utils/country-codes'
import { polyKey } from '../../utils/country-normalization'
import NodeFilters, { Chip } from '../nodes/NodeFilters'
import CountryFlag from '../CountryFlag'
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  GlobeIcon,
  LaptopIcon,
  SparkleIcon,
  StarIcon,
  SwapIcon,
} from '../Icons'
import {
  NODE_COL,
  ROW_HEIGHT,
  NodeIdentityCell,
  TypeCell,
  PriceCell,
  LatencyCell,
  StatusCell,
} from '../nodes/NodeCells'
import ChainReviewModal from './ChainReviewModal'
import InfoTip from '../InfoTip'
import Spinner from '../Spinner'
import type { SentNode } from '../../types'

/**
 * How long the filter must hold still before its nodes are graded. Long enough that
 * typing a city name is one sweep rather than one per letter, short enough that
 * choosing a country feels immediate.
 */
const PROBE_SETTLE_MS = 250


/** Only v2ray and xray can be chained, so the protocol filter offers only those. */
const CHAIN_PROTOCOL_OPTIONS = [
  { value: 2, label: 'V2Ray' },
  { value: 4, label: 'XRAY' },
] as const

type SortKey = 'country' | 'moniker' | 'type' | 'priceGb' | 'priceHr' | 'latency' | 'status' | 'eligibility'

/**
 * The Nodes tab's columns (widths shared through NODE_COL, so the two tables stay
 * identical) minus Leases, Sessions and Peers (a chain hop is picked on eligibility,
 * not on how busy the node is) plus Use as, the Entry and Exit chips, which is the
 * column this whole page turns on. Fixed widths sum to 132+110+128+96+72+80 = 618, plus the 60px
 * of row chrome, so the identity column keeps ~269px at the window minimum. Use as is
 * 128px so a chip and a pair-rule reason ("Entry same country") fit side by side.
 *
 * Every one of them is sortable, and that is also what keeps the casing consistent: the
 * header row carries `uppercase`, but a <button> does not inherit it. While eligibility
 * was the one unsortable column it was the one plain <div>, so it alone rendered
 * "ELIG." among "Country" and "Latency". Don't make a header a non-button again.
 * Price is the one exception in shape, not in kind: one column, two sort buttons.
 */
const COLUMNS: { key: SortKey; label: string; width: string }[] = [
  { key: 'moniker', label: 'Node', width: NODE_COL.identity },
  { key: 'country', label: 'Location', width: NODE_COL.location },
  { key: 'type', label: 'Type', width: NODE_COL.type },
  { key: 'eligibility', label: 'Use as', width: 'w-[128px]' },
  { key: 'priceHr', label: 'Price', width: `${NODE_COL.price} justify-end` },
  { key: 'latency', label: 'Latency', width: `${NODE_COL.latency} justify-center` },
  { key: 'status', label: 'Status', width: `${NODE_COL.status} justify-center` },
]

const TONE_CLASS = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-text-tertiary',
}

/**
 * Choose the two nodes of a chain: this host -> entry -> exit -> internet.
 *
 * A tab rather than a modal, and deliberately the same shape as the Nodes tab — a page
 * to choose on, a modal to commit in. Picking two nodes out of hundreds, each graded by
 * a probe that streams in over seconds, is a page-scale task, and it runs on the same
 * node data, the same filter bar and the same latency testing as a single hop rather
 * than a weaker copy of them.
 */
export default function MultihopView() {
  const { status, disconnect } = useConnection()
  const { results: testResults, testing: testingNodes, batchProgress, testBatch, cancelBatch, testNode } = useNodeTest()
  const { entry, exit, activeSlot, setActiveSlot, setSlot, swap, billing, eligibility } = useChainDraft()

  const [verifiedOnly, setVerifiedOnly] = useState(false)
  // Why "Pick for me" could not pick: one line under the bar. The note names the pair
  // it was written against, so it disappears once either slot changes.
  const [pickNote, setPickNote] = useState<{ text: string; pair: [string, string] } | null>(null)
  // The pair under review, captured when Review is pressed rather than read live off
  // the draft. That is what lets the draft be cleared the moment the chain comes up:
  // rendered off the draft, clearing it would unmount the modal mid-success and take
  // the two session ids with it.
  const [reviewing, setReviewing] = useState<{ entry: SentNode; exit: SentNode } | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const latencyMap = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const [addr, result] of testResults) {
      map.set(addr, result.reachable ? result.latencyMs : null)
    }
    return map
  }, [testResults])

  // Scored here rather than in useNodes because the grade depends on which hop is
  // being chosen. Rebuilt as grades land, which is what makes an eligibility sort fill
  // in live; the probe key is address-sorted, so the reordering never restarts a sweep.
  const { allNodes } = useNodesContext()
  // The hop already picked, which every row for the other slot is checked against:
  // the two ends must sit in different countries and on different networks.
  const otherHop = activeSlot === 'entry' ? exit : entry
  const eligibilityRank = useMemo(() => {
    const map = new Map<string, number>()
    for (const n of allNodes) {
      if (isChainable(n)) {
        const conflict = otherHop ? pairConflict(n, otherHop) : null
        map.set(n.address, chainRowRank(n, eligibility.results.get(n.address), activeSlot, conflict))
      }
    }
    return map
  }, [allNodes, eligibility.results, activeSlot, otherHop])

  const {
    nodes: matches,
    totalCount,
    filter,
    updateFilter,
    sortKey,
    sortDir,
    toggleSort,
    loading,
    lastFetched,
    error,
    refresh,
    bookmarks,
    toggleBookmark,
  } = useNodes(latencyMap, isChainable, eligibilityRank)

  // Display only. The grading below deliberately runs on `matches`, not on this:
  // "Verified only" filters ON the grades, so probing what it leaves would freeze the
  // list at whatever happened to be graded when it was ticked and silently hide every
  // verified node outside that. A node the pair rule refuses is not one you can pick,
  // so it goes too, however well it graded.
  const rows = useMemo(
    () => (verifiedOnly
      ? matches.filter((n) =>
        isVerifiedFor(eligibility.results.get(n.address), activeSlot) &&
        (otherHop === null || pairConflict(n, otherHop) === null))
      : matches),
    [matches, verifiedOnly, eligibility.results, activeSlot, otherHop],
  )

  // A search that finds nothing may have found a node this tab does not list because
  // of its version alone, typically one the user knows from the Nodes tab. Say so,
  // rather than leave them to conclude it vanished. Counted only when it would show.
  const tooOldMatches = useMemo(() => {
    const q = filter.search.trim().toLowerCase()
    if (q === '' || matches.length > 0) return 0
    return allNodes.filter((n) => isTooOldToChain(n) && matchesSearch(n, q)).length
  }, [filter.search, matches.length, allNodes])

  // Grade every node in the filtered set, in list order, so the rows at the top settle
  // in the first chunk or two. All of them can be graded: pre-9.0.0 nodes, which
  // publish no inbound list, are not listed at all (`isChainable`).
  // The key is sorted, because grades arriving change the list ORDER and an
  // order-sensitive key would retrigger the sweep on every one of them.
  const probeKey = useMemo(() => matches.map((n) => n.address).sort().join(','), [matches])

  const { probe } = eligibility
  // Settle before probing. The search box filters on every keystroke, and each new set
  // abandons the sweep in flight and starts one for the new one — so typing "toronto"
  // unthrottled would fire a chunk of 30 requests per letter. Each probe is an HTTPS
  // request from the user's own address, so a page opened and abandoned must not
  // announce itself to hundreds of operators. probe's identity is stable (it reads
  // results from a ref), so this timer is only reset by a real change of role or filter.
  useEffect(() => {
    // Called even when there is NOTHING to grade, which is what abandons the sweep in
    // flight. Abandonment happens inside probe() (it owns the run key), so an
    // `if (matches.length === 0) return` here skipped it precisely when the user had
    // narrowed hardest: measured 2026-08-16, a search matching no rows left the previous
    // run to completion, 211 further nodes probed over 26 s, every one of them excluded
    // by the filter the user had just typed, with "Checking n/m" still counting up
    // against the old total. probe() handles an empty list by standing the sweep down.
    // The key tells probe() whether this is the set it is already working or a new one
    // to switch to. Role is in it because the two ends are graded against different rules.
    const timer = setTimeout(() => { void probe(matches, `${activeSlot}:${probeKey}`) }, PROBE_SETTLE_MS)
    return () => clearTimeout(timer)
    // probeKey stands in for `matches`, which changes identity with every grade (sort).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot, probeKey, probe])

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  })

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return null
    return <ChevronIcon direction={sortDir === 'asc' ? 'up' : 'down'} className="w-3 h-3 text-accent" />
  }

  const alreadyConnected = status.state === 'connected' || status.state === 'reconnecting'
  // `chainExit` is set only while a two-hop chain is up, so it is what tells this
  // page's own product apart from any other tunnel.
  const chainActive = alreadyConnected && status.chainExit !== undefined
  // What the pair costs in BOTH units. Which one you are billed in is chosen in the
  // review modal, so quoting only one here reads as the price and is wrong half the
  // time. Either can be absent: a node need not quote udvpn for both.
  const pairPrice = (t: BillingType): number | null => {
    if (!entry || !exit) return null
    const a = udvpnPrice(entry, t)
    const b = udvpnPrice(exit, t)
    return a === null || b === null ? null : a + b
  }
  const perGb = pairPrice('gigabytes')
  const perHour = pairPrice('hours')
  // The rows already refuse a conflicting pick in both directions, so this only
  // catches a pair put together before the rule or changed by a directory refresh.
  const pairNow = entry && exit ? pairConflict(entry, exit) : null
  const ready = entry !== null && exit !== null && pairNow === null
  const swapReason = swapBlocker(entry, exit, eligibility.results)

  /**
   * Fill both slots with the best pair the current list offers. Computed on the click
   * rather than kept live: it walks every entry against every exit, and the grades
   * stream in a chunk at a time, so a live answer would redo that walk dozens of times
   * per sweep to change one button.
   */
  function handlePickForMe() {
    const pick = pickChainPair(matches, eligibility.results, latencyMap, billing, pairConflict)
    if (!pick) {
      setPickNote({
        text: eligibility.progress
          ? 'No pair qualifies yet. The checks are still running, so try again in a moment.'
          : 'No two nodes in this list qualify. Widen the filters to give it more to choose from.',
        pair: [entry?.address ?? '', exit?.address ?? ''],
      })
      return
    }
    setSlot('entry', pick.entry)
    setSlot('exit', pick.exit)
    setActiveSlot('exit')
    // Nothing to say on success: the pills show both latencies and the link between
    // them says "apart", which is everything the old note did.
    setPickNote(null)
  }
  const pickNoteShown = pickNote !== null &&
    pickNote.pair[0] === (entry?.address ?? '') && pickNote.pair[1] === (exit?.address ?? '')
    ? pickNote.text
    : null

  return (
    <div className="h-full flex flex-col">
      {/* Two different facts, and reporting them the same way was alarming: the
          moment a chain came up, the page behind the success modal warned that a
          tunnel was in the way, about the chain the user had just paid for. A chain
          of our own is reported as the good news it is; anything else keeps the
          warning, because it really does have to go first. */}
      {alreadyConnected && (
        <div className="bg-bg-secondary px-4 pt-3">
          <div className={`border p-3 rounded-md flex items-center justify-between gap-4 ${
            chainActive ? 'bg-success-subtle border-success' : 'bg-warning-subtle border-warning'
          }`}>
            <div>
              {chainActive ? (
                <>
                  <p className="text-success text-sm flex items-center gap-2">
                    <span className="status-dot status-dot-active" />
                    Your chain is connected.
                  </p>
                  <p className="text-text-secondary text-xs">
                    {status.nodeMoniker || status.nodeCountry} → {status.chainExit?.moniker || status.chainExit?.country}
                    . Both hops are in the Sessions tab. Building another chain replaces this one.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-warning text-sm">A tunnel is already up.</p>
                  <p className="text-text-secondary text-xs">
                    Building a chain replaces it. Disconnect first. The current session stays paid and
                    can be reconnected from the Sessions tab.
                  </p>
                </>
              )}
            </div>
            <button
              onClick={async () => {
                setDisconnecting(true)
                try {
                  await disconnect()
                } finally {
                  setDisconnecting(false)
                }
              }}
              disabled={disconnecting}
              className="btn btn-danger text-xs px-3 py-1 disabled:opacity-50 shrink-0"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>
        </div>
      )}

      {/* The route bar: the whole chain as one row, in RouteStrip's vocabulary, so the
          picker draws the same picture as the review window and the Sessions cards.
          It replaced four stacked rows (a title, a two-box rail, the pick button and a
          "Choosing the entry node" line) that between them left about three table rows
          at the 960x600 minimum. z-20 so its InfoTip opens over the table's sticky header. */}
      <div className="relative z-20 shrink-0 flex items-center gap-4 px-4 py-2 border-b border-border bg-bg-secondary">
        <div
          role="group"
          aria-label="Your route: your device, then the entry, then the exit, then the internet."
          className="flex-1 min-w-0 flex items-center"
        >
          <span className="route-disc route-disc-done w-7 h-7 shrink-0" title="Your device">
            <LaptopIcon className="w-3.5 h-3.5" />
          </span>
          <span className={`${entry ? LINK.lit : LINK.dim} w-[18px] shrink-0`} />
          <HopPill
            role="entry"
            node={entry}
            active={activeSlot === 'entry'}
            latency={entry ? latencyMap.get(entry.address) : undefined}
            onActivate={() => setActiveSlot('entry')}
            onClear={() => setSlot('entry', null)}
          />
          {/* The middle link carries the pair's verdict and the swap. A conflict here
              can only come from a directory refresh: the rows refuse such a pick. */}
          <span className="relative w-[72px] h-12 shrink-0 flex items-center">
            <span className={`${pairNow ? LINK.failed : entry && exit ? LINK.lit : LINK.dim} flex-1`} />
            {entry && exit && (
              <span
                className={`absolute inset-x-0 top-0 text-center text-[10.5px] leading-none whitespace-nowrap ${
                  pairNow ? 'text-danger' : 'text-success'
                }`}
                title={pairNow ? pairNow.title : 'Different countries and different networks.'}
              >
                {pairNow ? pairNow.badge : 'apart'}
              </span>
            )}
            {(entry || exit) && (
              <button
                type="button"
                onClick={() => { if (swapReason === null) swap() }}
                aria-disabled={swapReason !== null}
                aria-label="Swap entry and exit"
                title={swapReason ?? 'Swap entry and exit'}
                className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full grid place-items-center bg-bg-secondary border border-border transition-colors ${
                  swapReason === null
                    ? 'text-text-secondary hover:text-accent hover:border-accent'
                    : 'text-text-tertiary opacity-60 cursor-not-allowed'
                }`}
              >
                <SwapIcon className="w-3 h-3" />
              </button>
            )}
          </span>
          <HopPill
            role="exit"
            node={exit}
            active={activeSlot === 'exit'}
            latency={exit ? latencyMap.get(exit.address) : undefined}
            onActivate={() => setActiveSlot('exit')}
            onClear={() => setSlot('exit', null)}
          />
          <span className={`${ready ? LINK.lit : LINK.dim} w-[18px] shrink-0`} />
          <span className={`${ready ? 'route-disc route-disc-done' : 'route-disc'} w-7 h-7 shrink-0`} title="The internet">
            <GlobeIcon className="w-3.5 h-3.5" />
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <RouteMap entry={entry} exit={exit} clash={pairNow !== null} />
          {/* Both units, because which one is billed is chosen in the review: quoting
              one here would read as THE price and be wrong half the time. Either can be
              absent, since a node need not quote udvpn for both. The slot keeps its
              width while empty so the pills do not jump when the pair completes. */}
          <div
            className={`min-w-[96px] text-right font-mono text-xs leading-4 ${perGb === null && perHour === null ? 'text-text-tertiary' : 'text-text-primary'}`}
            title={entry && exit
              ? 'Both hops together. Per GB or per hour is chosen in the review.'
              : 'The price of the pair, once both hops are picked.'}
          >
            <div>{perGb !== null ? formatP2p(perGb) : '–'} <span className="text-[10.5px] text-text-tertiary">P2P/GB</span></div>
            <div>{perHour !== null ? formatP2p(perHour) : '–'} <span className="text-[10.5px] text-text-tertiary">P2P/hr</span></div>
          </div>
          {/* The main button until a hop is picked, then Review takes over. */}
          <button
            type="button"
            onClick={handlePickForMe}
            className={`btn ${entry || exit ? 'btn-secondary' : 'btn-primary'} text-xs px-3 py-1.5 flex items-center gap-1.5`}
            title="Picks from what the filters show: checked for both hops, different countries and networks, fastest first."
            aria-label="Pick a pair for me"
          >
            <SparkleIcon className="w-3.5 h-3.5" />
            <span className="hidden min-[1120px]:inline">Pick for me</span>
          </button>
          <button
            type="button"
            onClick={() => { if (entry && exit) setReviewing({ entry, exit }) }}
            disabled={!ready}
            className="btn btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Review
            <ArrowRightIcon className="w-3.5 h-3.5" />
          </button>
          {/* "on its own" is load-bearing. The claim is about what ONE node can see,
              which is exactly what the two hops split. Two operators comparing notes
              still defeat it, and the review modal says so before any money moves. */}
          <InfoTip label="About two-hop chains">
            <span className="block">Neither node on its own sees both who you are and where you go.</span>
            <span className="block mt-1.5">
              Both hops must be wrapped in TLS or Reality, which is stricter than an ordinary
              connection. A VMess hop without TLS is still encrypted, but it is recognisable as a
              proxy to anyone watching the wire, and that is the thing a chain is bought to avoid.
              Nodes older than 9.0.0 publish nothing to check against that rule, so they are
              not listed here.
            </span>
          </InfoTip>
        </div>

        {eligibility.progress && (
          <div
            role="progressbar"
            aria-label="Checking nodes for the chain"
            aria-valuemin={0}
            aria-valuemax={eligibility.progress.total}
            aria-valuenow={eligibility.progress.done}
            className="absolute left-0 -bottom-px h-0.5 bg-accent transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${(100 * eligibility.progress.done) / Math.max(1, eligibility.progress.total)}%` }}
          />
        )}
      </div>

      {pickNoteShown && (
        <div className="shrink-0 px-4 py-1.5 border-b border-border bg-bg-secondary text-xs text-warning">
          {pickNoteShown}
        </div>
      )}

      <NodeFilters
        filter={filter}
        updateFilter={updateFilter}
        totalCount={totalCount}
        filteredCount={rows.length}
        loading={loading}
        lastFetched={lastFetched}
        onRefresh={refresh}
        batchProgress={batchProgress}
        onTestBatch={() => {
          testBatch(rows.map((n) => ({ nodeAddress: n.address, remoteUrl: n.api })))
        }}
        onCancelBatch={cancelBatch}
        protocolOptions={CHAIN_PROTOCOL_OPTIONS}
        extra={
          <>
            {/* Follows the highlighted hop, like the row click and the Use as sort. */}
            <Chip
              on={verifiedOnly}
              label={`Verified ${activeSlot === 'exit' ? 'exits' : 'entries'}`}
              Icon={CheckIcon}
              onToggle={() => setVerifiedOnly((v) => !v)}
            />
            {eligibility.progress && (
              <span className="flex items-center gap-1.5 text-text-secondary text-xs">
                <Spinner className="text-accent" />
                Checking {eligibility.progress.done}/{eligibility.progress.total}
              </span>
            )}
          </>
        }
      />

      {/* With a list in hand a failed refresh only makes it stale — the filter bar's
          timestamp already says so, and blanking the table would be worse. */}
      {!lastFetched ? (
        error ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="max-w-sm text-center flex flex-col items-center gap-3">
              <div className="text-text-primary text-sm">Couldn't load the node directory</div>
              <div className="text-text-secondary text-xs break-words">{error}</div>
              <button onClick={refresh} disabled={loading} className="btn btn-secondary text-xs px-3 py-1.5 disabled:opacity-50 flex items-center gap-1.5">
                {loading && <Spinner />}
                Retry
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-text-secondary text-sm flex items-center gap-2">
              <Spinner />
              Loading nodes...
            </div>
          </div>
        )
      ) : (
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div className="sticky top-0 z-10 flex items-center px-4 py-2 border-b border-border bg-bg-secondary text-text-secondary text-xs font-medium uppercase tracking-wide select-none">
          <div className={`${NODE_COL.bookmark} shrink-0`} />
          {COLUMNS.map((col) =>
            col.key === 'priceHr' ? (
              <div key={col.key} className={`${col.width} flex items-center gap-1.5 shrink-0`} title="Price in P2P">
                <span>{col.label}</span>
                {(['priceHr', 'priceGb'] as const).map((key) => (
                  <button
                    key={key}
                    onClick={() => toggleSort(key)}
                    className={`normal-case hover:text-accent transition-colors flex items-center gap-0.5 ${
                      sortKey === key ? 'text-text-primary' : ''
                    }`}
                  >
                    {key === 'priceHr' ? '/hr' : '/GB'}
                    {sortIndicator(key)}
                  </button>
                ))}
              </div>
            ) : (
              <button
                key={col.key}
                onClick={() => toggleSort(col.key)}
                className={`${col.width} text-left hover:text-accent transition-colors flex items-center gap-1 shrink-0`}
                title={col.key === 'eligibility' ? 'Sort by what the highlighted hop can use, usable first' : undefined}
              >
                {col.label}
                {sortIndicator(col.key)}
              </button>
            ),
          )}
        </div>

        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const node = rows[virtualRow.index]
            if (!node) return null
            const grade = eligibility.results.get(node.address)
            // Each chip is checked against the OTHER hop, so a row that clashes with the
            // exit can still replace the entry.
            const entryChip = hopChipState(node, grade, 'entry', entry, exit,
              exit && exit.address !== node.address ? pairConflict(node, exit) : null)
            const exitChip = hopChipState(node, grade, 'exit', exit, entry,
              entry && entry.address !== node.address ? pairConflict(node, entry) : null)
            const selectable = (activeSlot === 'entry' ? entryChip : exitChip).kind === 'usable'
            const mine = entryChip.kind === 'picked' || exitChip.kind === 'picked'
            const dim = !mine && entryChip.kind !== 'usable' && exitChip.kind !== 'usable'
            // Chips need an answer to choose between. Without one (pre-9.0.0, still
            // checking, unreachable) the row keeps today's single label for the
            // highlighted hop, which is also the more useful thing to say about it.
            const label = grade?.reachable
              ? null
              : chainRowState(node, grade, activeSlot, otherHop ? pairConflict(node, otherHop) : null)

            const activate = () => { if (selectable) setSlot(activeSlot, node) }
            const choose = (role: ChainRole, chip: HopChipState) => {
              if (chip.kind === 'picked') setSlot(role, null)
              else if (chip.kind === 'usable') setSlot(role, node)
            }

            return (
              <div
                key={node.address}
                onClick={activate}
                // A dimmed row keeps its Use as cell readable: that cell says why.
                className={`absolute left-0 w-full flex items-center px-4 text-sm border-b border-border transition-colors before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${
                  mine ? 'bg-accent-subtle before:bg-accent' : ''
                } ${
                  selectable ? 'cursor-pointer hover:bg-bg-hover hover:before:bg-accent' : ''
                } ${
                  dim ? '[&>:not(.use-cell)]:opacity-40' : ''
                }`}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); toggleBookmark(node.address) }}
                  className={`${NODE_COL.bookmark} shrink-0 flex justify-center transition-colors ${
                    bookmarks.has(node.address) ? 'text-warning' : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                  title={bookmarks.has(node.address) ? 'Remove bookmark' : 'Bookmark node'}
                  aria-label={bookmarks.has(node.address) ? 'Remove bookmark' : 'Bookmark node'}
                >
                  <StarIcon filled={bookmarks.has(node.address)} className="w-3.5 h-3.5" />
                </button>
                <NodeIdentityCell node={node} onActivate={activate} />
                <div className={`${NODE_COL.location} shrink-0 leading-tight`}>
                  <div className="flex items-center gap-2">
                    <CountryFlag country={node.country} />
                    <span className="truncate">{node.country || '—'}</span>
                  </div>
                  <div className="text-[10px] text-text-secondary truncate">{node.city || '—'}</div>
                </div>
                <TypeCell node={node} />
                <div className="use-cell w-[128px] shrink-0 flex items-center gap-1 text-xs">
                  {label ? (
                    <span className={`truncate ${TONE_CLASS[label.tone]}`} title={label.title}>{label.badge}</span>
                  ) : entryChip.kind === 'clash' && exitChip.kind === 'clash' ? (
                    // Too close to both hops: one reason, for the hop being filled, as a
                    // row with no chips gives. Two would not fit, and say the same thing.
                    <RoleChip role={activeSlot} chip={activeSlot === 'entry' ? entryChip : exitChip} onChoose={() => {}} />
                  ) : (
                    <>
                      <RoleChip role="entry" chip={entryChip} onChoose={() => choose('entry', entryChip)} />
                      <RoleChip role="exit" chip={exitChip} onChoose={() => choose('exit', exitChip)} />
                    </>
                  )}
                </div>
                <PriceCell node={node} />
                <LatencyCell
                  probe={testResults.get(node.address)}
                  testing={testingNodes.has(node.address)}
                  onTest={() => testNode(node.address, node.api)}
                />
                <StatusCell node={node} />
              </div>
            )
          })}
        </div>

        {rows.length === 0 && !loading && (
          <div className="flex items-center justify-center h-32 px-4 text-center text-text-secondary text-sm">
            {verifiedOnly
              ? 'No node here has been verified for this hop yet.'
              : tooOldMatches > 0
                ? `No chainable node matches "${filter.search.trim()}". ${tooOldMatches === 1 ? '1 older node does' : `${tooOldMatches} older nodes do`}, but nodes older than 9.0.0 cannot be checked before paying, so they cannot be chained.`
                : 'No nodes match your filters'}
          </div>
        )}
      </div>
      )}

      {reviewing && (
        <ChainReviewModal
          entry={reviewing.entry}
          exit={reviewing.exit}
          onClose={() => setReviewing(null)}
        />
      )}
    </div>
  )
}

// RouteStrip's link classes, spelled out in full: Tailwind keeps a component class
// only if it finds the literal name in the source (docs/renderer.md).
const LINK = {
  dim: 'route-link route-link-dim',
  lit: 'route-link route-link-lit',
  failed: 'route-link route-link-failed',
}

/** What each hop sees, in RouteStrip's words. */
const SEES: Record<ChainRole, string> = { entry: 'sees your IP', exit: 'sees the sites' }

const ROLE_TEXT: Record<ChainRole, string> = {
  entry: 'Your device dials it directly, so it sees your IP and not where you go.',
  exit: 'Reached only through the entry, setup included, so sites see its location instead of yours.',
}

/**
 * One hop of the route bar: dashed while empty, ringed while it is the hop a row click
 * fills. Identity and latency only; the pair's price sits once, beside Review. A div
 * rather than a button because it holds the clear button, and a button may not nest
 * interactive content.
 */
function HopPill({ role, node, active, latency, onActivate, onClear }: {
  role: ChainRole
  node: SentNode | null
  active: boolean
  latency: number | null | undefined
  onActivate: () => void
  onClear: () => void
}) {
  const code = node ? COUNTRY_CODES[node.country] || '' : ''
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onActivate() }
      }}
      title={ROLE_TEXT[role]}
      className={`${
        active ? 'hop-pill hop-pill-active' : node ? 'hop-pill hop-pill-full' : 'hop-pill hop-pill-empty'
      } flex-1 min-w-0 h-11 px-2.5 flex flex-col justify-center cursor-pointer`}
    >
      <div className="flex items-center gap-1.5 min-w-0 text-[10.5px] leading-[14px]">
        <span className={`uppercase tracking-wider font-semibold ${active ? 'text-accent' : 'text-text-secondary'}`}>{role}</span>
        <span className="text-text-tertiary truncate">· {SEES[role]}</span>
        <span className="flex-1" />
        {node && latency != null && <span className="font-mono text-success shrink-0">{latency} ms</span>}
        {node && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClear() }}
            className="shrink-0 -mr-1 p-0.5 rounded-sm text-text-tertiary hover:text-danger hover:bg-danger-subtle transition-colors"
            title={`Clear the ${role}`}
            aria-label={`Clear the ${role}`}
          >
            <CloseIcon className="w-3 h-3" />
          </button>
        )}
      </div>
      {node ? (
        <div className="flex items-center gap-1.5 min-w-0 text-[13px] leading-[18px]">
          {code && <span className={`fi fis fi-${code} rounded-full shrink-0`} style={{ fontSize: '16px', lineHeight: 1 }} />}
          <span className="font-semibold text-text-primary whitespace-nowrap">{node.city || node.country}</span>
          <span className="text-text-tertiary text-xs truncate">{node.moniker || node.address}</span>
        </div>
      ) : (
        <div className={`text-xs leading-[18px] ${active ? 'text-text-secondary' : 'text-text-tertiary'}`}>
          {active ? `Choose an ${role} below` : 'Not picked yet'}
        </div>
      )}
    </div>
  )
}

// Full literal class strings, for the same Tailwind reason as LINK.
const CHIP_CLASS: Record<Exclude<HopChipState['kind'], 'clash'>, string> = {
  usable: 'role-chip-usable text-success hover:bg-success-subtle',
  picked: 'border-accent bg-accent-subtle text-accent hover:border-danger hover:bg-danger-subtle hover:text-danger',
  refused: 'border-transparent text-text-tertiary line-through cursor-not-allowed',
}

/**
 * "Entry" or "Exit" on a row: puts the node in that hop, or takes it out again. Every
 * chip stops the click, a refused one included, or it would fall through to the row
 * and fill the highlighted hop instead. `aria-disabled` rather than `disabled` for the
 * same reason: whether a disabled button's click reaches its parent is not something
 * to depend on.
 *
 * A pair-rule refusal is not a chip at all but its reason in red words, the same words
 * a row with no chips shows. A struck-through "Exit" hid "same country" behind a hover,
 * so one Australian row said it and the next, checked and chip-bearing, did not.
 */
function RoleChip({ role, chip, onChoose }: {
  role: ChainRole
  chip: HopChipState
  onChoose: () => void
}) {
  if (chip.kind === 'clash') {
    return (
      <span
        onClick={(e) => e.stopPropagation()}
        title={chip.title}
        className="truncate text-[10.5px] text-danger cursor-not-allowed"
      >
        {chip.badge}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (chip.kind !== 'refused') onChoose() }}
      aria-disabled={chip.kind === 'refused'}
      aria-pressed={chip.kind === 'picked'}
      title={chip.title}
      className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 text-[10.5px] leading-4 font-medium transition-colors ${CHIP_CLASS[chip.kind]}`}
    >
      {chip.kind === 'picked' && <CheckIcon className="w-2.5 h-2.5" />}
      {role === 'entry' ? 'Entry' : 'Exit'}
    </button>
  )
}

const MAP_W = 128
const MAP_H = 48

/**
 * The two hops on a small map, with the arc between them: a long chain is a slow one,
 * and the map says so before the latency does. Drawn as SVG with d3-geo, never WebGL
 * (docs/renderer.md). It draws no "you" on purpose: the app never looks up the user's
 * location, and a map that showed one would have to.
 *
 * Static and recomputed only when a hop's country changes, so it costs nothing at
 * rest. Hidden below 1120px, where the bar needs the width for the pills.
 */
function RouteMap({ entry, exit, clash }: { entry: SentNode | null; exit: SentNode | null; clash: boolean }) {
  // An empty frame until (or unless) the file loads: the pills carry the same facts in words.
  const world = useWorldCountries()

  const entryCountry = entry?.country ?? null
  const exitCountry = exit?.country ?? null
  const drawn = useMemo(() => {
    if (!world) return null
    const byName = new Map(world.map((f) => [polyKey(f), f]))
    const a = entryCountry !== null ? countryPoint(entryCountry, byName) : null
    const b = exitCountry !== null ? countryPoint(exitCountry, byName) : null
    const projection = geoNaturalEarth1()
    if (a && b) {
      // Rotate to the arc's midpoint before fitting, so a pair across the antimeridian
      // is drawn as one short arc rather than two halves at the edges. The scale is
      // clamped: neighbours would otherwise zoom in to a blur, and a zero-extent fit
      // (one fallback point for both) gives no scale at all.
      const mid = geoInterpolate(a, b)(0.5)
      projection.rotate([-mid[0], 0]).fitExtent(
        [[MAP_W * 0.22, MAP_H * 0.22], [MAP_W * 0.78, MAP_H * 0.78]],
        { type: 'MultiPoint', coordinates: [a, b] },
      )
      const fitted = projection.scale()
      projection
        .scale(Number.isFinite(fitted) ? Math.min(Math.max(fitted, 22), 240) : 240)
        .center([0, mid[1]])
        .translate([MAP_W / 2, MAP_H / 2])
    } else {
      const one = a ?? b
      projection.rotate([one ? -one[0] : -10, 0]).fitExtent([[2, 2], [MAP_W - 2, MAP_H - 2]], { type: 'Sphere' })
    }
    const path = geoPath(projection)
    return {
      land: world.map((f) => {
        const name = polyKey(f)
        return { name, d: path(f) ?? '', hot: name !== '' && (name === entryCountry || name === exitCountry) }
      }),
      arc: a && b ? path({ type: 'LineString', coordinates: [a, b] }) ?? '' : '',
      entry: a ? projection(a) : null,
      exit: b ? projection(b) : null,
    }
  }, [world, entryCountry, exitCountry])

  return (
    <svg
      width={MAP_W}
      height={MAP_H}
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      role="img"
      aria-label={`Map: ${entry ? `entry in ${entry.country}` : 'no entry yet'}, ${exit ? `exit in ${exit.country}` : 'no exit yet'}.`}
      className="hidden min-[1120px]:block shrink-0 rounded-sm border border-border bg-bg-primary"
    >
      <title>Entry ring, exit dot. Your own location is never looked up.</title>
      {drawn?.land.map((c, i) => c.d && (
        <path key={c.name || i} d={c.d} className={c.hot ? 'route-map-hot' : 'route-map-land'} />
      ))}
      {drawn?.arc && <path d={drawn.arc} className={clash ? 'route-map-arc route-map-arc-clash' : 'route-map-arc'} />}
      {drawn?.entry && <circle cx={drawn.entry[0]} cy={drawn.entry[1]} r={3} className="route-map-entry" />}
      {drawn?.exit && <circle cx={drawn.exit[0]} cy={drawn.exit[1]} r={3.2} className="route-map-exit" />}
    </svg>
  )
}
