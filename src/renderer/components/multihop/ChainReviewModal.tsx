import { useEffect, useState } from 'react'
import type { SentNode, TunnelProtocol, WalletEntry } from '../../types'
import { useBalance } from '../../hooks/useBalance'
import { useConnection } from '../../hooks/useConnection'
import { useChainDraft } from '../../contexts/ChainDraftContext'
import { useNavigation } from '../../contexts/NavigationContext'
import { pairConflict } from '../../utils/chain-diversity'
import { chainBuyBlocker, udvpnPrice, type ChainBlocker, type ChainBuyState } from '../../utils/chain-node'
import { checkFunds, formatP2p, formatP2pCeil, insufficientFundsMessage, udvpnOf, type FundsCheck } from '../../../shared/funds'
import { SOCKS_DISPLAY_ADDR } from '../../../shared/socks'
import { versionSignsReplies } from '../../../shared/node-signing'
import { protocolMeta } from '../../utils/protocols'
import ConnectErrorActions from '../ConnectErrorActions'
import InsufficientFunds from '../InsufficientFunds'
import RouteStrip, { type RouteStage } from '../RouteStrip'
import {
  AmountStepper, ChecksSection, FooterReason, LimitsSection, ModeField, Note,
  OptionsSection, Receipt, ReceiptLine, ReviewModal, SectionHead, Segmented,
  dnsCheck, keysLimit, modeSummary, otherVpnCheck, useOtherVpns, useReviewSettings,
  type CheckSpec, type Limit,
} from '../ConnectReview'

interface Props {
  entry: SentNode
  exit: SentNode
  onClose: () => void
}

/**
 * Commit step for a two-hop chain: everything the user is about to pay for, then the
 * two purchases and the bring-up.
 *
 * A modal on purpose, and the exact counterpart of ConnectionModal for a single hop:
 * the choosing happens on a page, the paying happens here. It is also why this is a
 * separate file from the page — the page is mounted for as long as the tab is open,
 * this only exists during a purchase.
 *
 * Laid out around three questions (redesigned 2026-10-05, after a review that showed
 * twelve equal-weight sections): where the traffic goes (the route strip, which stays
 * on screen through the build and the result), how private this pair is (one list of
 * checks, each carrying its own fix), and what it costs (one line per hop, next to the
 * wallet that pays it). Pay sits in a footer that never scrolls away, and the footer
 * always names what is stopping it. The pieces are ConnectReview's, shared with the
 * two single-hop windows.
 */
export default function ChainReviewModal({ entry, exit, onClose }: Props) {
  const { status } = useConnection()
  const { udvpn, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  const { billing, setBilling, amount, setAmount, clear, setSlot, eligibility } = useChainDraft()
  const { openSettings } = useNavigation()
  const settings = useReviewSettings()
  const otherVpns = useOtherVpns()

  const [mode, setMode] = useState<'tunnel' | 'proxy'>('tunnel')
  const [acknowledged, setAcknowledged] = useState(false)
  // Which wallet pays for the EXIT hop. Required (decided 2026-10-05): paid from one
  // account, either node can read the address off its own session and find the other
  // hop with a public query. '' = none available, which blocks Pay.
  const [exitWalletId, setExitWalletId] = useState('')
  // null while the list loads, so the "set up a second wallet" guide doesn't flash
  // for a user who has one.
  const [wallets, setWallets] = useState<WalletEntry[] | null>(null)
  const [activeAddress, setActiveAddress] = useState<string | null>(null)
  // Whether the chosen exit wallet is visibly funded from the active one. null =
  // not asked yet or asking.
  const [walletLink, setWalletLink] = useState<{ checked: boolean; linked: boolean } | null>(null)
  // The exit wallet's own balance in udvpn, so each hop is checked against the account
  // that pays for it, as main does before broadcasting. null = unknown, which never
  // blocks (useBalance's rule): main re-checks both payers against fresh balances.
  const [exitUdvpn, setExitUdvpn] = useState<number | null>(null)
  const [exitBalanceReads, setExitBalanceReads] = useState(0)

  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [currentDetail, setCurrentDetail] = useState<string | null>(null)
  const [hopMarker, setHopMarker] = useState<HopMarker | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState<{ entrySessionId: string; exitSessionId: string } | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)

  const alreadyConnected = status.state === 'connected' || status.state === 'reconnecting'
  // Both purchases and handshakes are done once the modal moves to the bring-up.
  const tunnelStarted = currentStep === '5/5'

  useEffect(() => {
    // `hop:<role>:<phase>` are markers, not steps: a chain runs the purchase sequence
    // twice, and without them the shared 1/5..3/5 list replays from the start halfway
    // through and looks like the connect restarted. The PHASE matters as much as the
    // role: the entry is bought AND handshaked before the exit is touched at all, since
    // the exit is reached through it (see MARKER_SEQUENCE).
    const unsub = window.api.onConnectionProgress((step, detail) => {
      if (step.startsWith('hop:')) {
        const marker = parseHopMarker(step)
        if (marker) setHopMarker(marker)
        return
      }
      setCurrentStep(step)
      setCurrentDetail(detail || null)
    })
    return unsub
  }, [])

  // Ask the chain whether the two accounts are already tied together by a transfer.
  // Without this the "funded independently" caveat is a sentence the user skims and
  // then defeats in the obvious way — topping the second wallet up from the first.
  useEffect(() => {
    if (!exitWalletId) { setWalletLink(null); return }
    let cancelled = false
    setWalletLink(null)
    window.api.walletLinkCheck(exitWalletId)
      .then((r) => { if (!cancelled) setWalletLink(r) })
      .catch(() => { if (!cancelled) setWalletLink({ checked: false, linked: false }) })
    return () => { cancelled = true }
  }, [exitWalletId])

  useEffect(() => {
    setExitUdvpn(null)
    if (!exitWalletId) return
    let cancelled = false
    window.api.walletBalanceOf(exitWalletId)
      .then((b) => { if (!cancelled) setExitUdvpn(b === null ? null : udvpnOf(b)) })
      .catch(() => { /* stays unknown, which never blocks */ })
    return () => { cancelled = true }
  }, [exitWalletId, exitBalanceReads])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [list, addr] = await Promise.all([window.api.walletList(), window.api.walletGetAddress()])
        if (cancelled) return
        setWallets(list)
        setActiveAddress(addr)
        // Two wallets are required, so the exit starts on the first one that isn't
        // the active wallet. There is no "this wallet" option to fall back to.
        setExitWalletId((current) => current || list.find((w) => w.address !== addr)?.id || '')
      } catch {
        if (!cancelled) setWallets([])
      }
    })()
    return () => { cancelled = true }
  }, [])

  const entryPrice = udvpnPrice(entry, billing)
  const exitPrice = udvpnPrice(exit, billing)
  const entryCost = (entryPrice ?? 0) * amount
  const exitCost = (exitPrice ?? 0) * amount
  const costUdvpn = entryCost + exitCost
  const priceMissing = entryPrice === null || exitPrice === null
  // Each payer against its own hop. Summing both against the active wallet (what this
  // did while one account could pay for both) falsely blocks a pair whose second
  // wallet covers the exit, and never notices that the second wallet cannot.
  const entryFunds = udvpn === null ? null : checkFunds(udvpn, entryCost)
  const exitFunds = exitUdvpn === null ? null : checkFunds(exitUdvpn, exitCost)
  const entryShort = entryFunds !== null && !entryFunds.ok
  const exitShort = exitFunds !== null && !exitFunds.ok

  const otherWallets = (wallets ?? []).filter((w) => w.address !== activeAddress)
  const activeName = wallets?.find((w) => w.address === activeAddress)?.name || 'this wallet'
  const exitName = otherWallets.find((w) => w.id === exitWalletId)?.name || 'the exit wallet'
  const exitWalletState: ChainBuyState['exitWallet'] =
    wallets === null ? 'checking'
      : !exitWalletId ? 'none'
        : walletLink === null ? 'checking'
          : walletLink.linked ? 'linked'
            : walletLink.checked ? 'clean' : 'unchecked'

  // The picker already refuses such a pair; this is the backstop for one that was
  // put together before the rule, or changed under the review.
  const conflict = pairConflict(entry, exit)
  const exitGrade = eligibility.results.get(exit.address)
  // Block only on a definite No. "Couldn't ask" (a pre-9.0.0 node, or an
  // unreachable one) stays allowed: it may work, and a failed build refunds both
  // sessions. A definite no is different — it is known before any money moves.
  const exitRefused = exitGrade !== undefined && exitGrade.reachable && !exitGrade.exit

  const blocker = chainBuyBlocker({
    alreadyConnected, conflict, exitRefused, exitWallet: exitWalletState,
    priceMissing, entryShort, exitShort, acknowledged,
  })

  /**
   * Closing once a session exists spends the draft: those two nodes are now a pair of
   * sessions, and re-offering them on the page would invite a second purchase.
   */
  function handleClose() {
    if (paid) clear()
    onClose()
  }

  /** Back to the page with the exit slot emptied, which is also the one a click fills. */
  function handlePickAnotherExit() {
    setSlot('exit', null)
    onClose()
  }

  function handleOpenWalletSettings() {
    handleClose()
    openSettings('wallets')
  }

  async function handleBuild() {
    if (entryPrice === null || exitPrice === null || !exitWalletId) return
    setConnecting(true)
    setError(null)
    setCurrentStep('1/5')
    setHopMarker({ hop: 'entry', phase: 'buy' })
    try {
      const result = await window.api.connectionSubscribeChain({
        entry: {
          nodeAddress: entry.address, nodeMoniker: entry.moniker, nodeCountry: entry.country,
          nodeType: entry.type, apiField: entry.api, quoteValue: String(entryPrice),
        },
        exit: {
          nodeAddress: exit.address, nodeMoniker: exit.moniker, nodeCountry: exit.country,
          nodeType: exit.type, apiField: exit.api, quoteValue: String(exitPrice),
        },
        type: billing,
        amount,
        denom: 'udvpn',
        exitWalletId,
        ...(mode === 'proxy' ? { proxyMode: true } : {}),
      })
      setPaid({ entrySessionId: result.sessionId, exitSessionId: result.exitSessionId })
      await connectTunnelOnly(result.protocol as TunnelProtocol)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build the chain')
    } finally {
      setConnecting(false)
    }
  }

  /** The bring-up alone. Both sessions stay paid, so this never re-buys. */
  async function connectTunnelOnly(protocol: TunnelProtocol) {
    setCurrentStep('5/5')
    await window.api.connectionConnect({
      protocol,
      ...(mode === 'proxy' ? { mode: 'proxy' as const } : {}),
    })
    setTunnelConnected(true)
    // Spent the instant it becomes a live chain, not when this window is closed. The
    // page behind is visible around this modal, and leaving two nodes sitting in the
    // rail next to a "2/2" badge invites buying the same pair twice. This modal holds
    // its own copy of the pair, so clearing here does not disturb the pane below.
    clear()
  }

  async function handleRetryTunnel() {
    if (!paid) return
    setConnecting(true)
    setError(null)
    try {
      await connectTunnelOnly('xray')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  const title = tunnelConnected
    ? 'Chain active'
    : connecting
      ? 'Building your chain'
      : error
        ? (paid ? 'The chain did not come up' : 'The chain was not built')
        : 'Review your chain'

  // The strip follows the same marker sequence as the per-hop list under it. A
  // failure is drawn on the route only once both hops are paid, i.e. at the bring-up:
  // before that the error pane says what happened and nothing on the route is owed.
  const markerAt = hopMarker === null ? 0 : Math.max(0, markerIndex(hopMarker))
  const stage: RouteStage = tunnelConnected
    ? { kind: 'active' }
    : connecting
      ? { kind: 'building', step: tunnelStarted ? 5 : markerAt }
      : error && paid
        ? { kind: 'failed' }
        : { kind: 'review' }

  const reviewing = !connecting && !error && !tunnelConnected
  const perUnit = billing === 'gigabytes' ? 'GB' : 'hr'
  const exitSecurity = exitGrade?.exitSecurity === 'reality' ? 'Reality' : 'TLS'

  const walletSelect = otherWallets.length > 0 && (
    <label className="flex items-center gap-2 flex-wrap text-xs text-text-tertiary">
      <span>Exit paid by</span>
      <select
        value={exitWalletId}
        onChange={(e) => setExitWalletId(e.target.value)}
        className="bg-bg-tertiary border border-border text-text-primary text-xs px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus min-w-0 max-w-full"
      >
        {otherWallets.map((w) => (
          <option key={w.id} value={w.id}>{w.name} · {w.address.slice(0, 12)}…{w.address.slice(-6)}</option>
        ))}
      </select>
    </label>
  )
  const pickAnotherExit = (
    <div>
      <button onClick={handlePickAnotherExit} className="btn btn-secondary text-xs px-2.5 py-1">
        Pick another exit
      </button>
    </div>
  )

  const checks: CheckSpec[] = [
    conflict ? {
      id: 'pair',
      tone: 'danger',
      text: conflict.badge === 'location unknown'
        ? 'Can\'t tell where one hop is'
        : `Both hops share a ${conflict.badge === 'same country' ? 'country' : 'network'}`,
      tipLabel: 'Why the hops must be apart',
      tip: "One hosting network can watch both ends of a chain whoever rents the two machines, and one country's courts can reach both. A chain needs its two hops in different countries and on different networks.",
      body: <><p>{conflict.title}</p>{pickAnotherExit}</>,
    } : {
      id: 'pair',
      tone: 'success',
      text: 'Different countries and networks',
      tipLabel: 'What was compared',
      tip: `Entry in ${entry.country} on AS${entry.asn}, exit in ${exit.country} on AS${exit.asn}, with no shared address block or domain. One hosting network, or one country's courts, cannot see both ends.`,
    },
    // One line per outcome, reasoning behind the "?". The refused variant keeps its
    // full first sentence visible: it blocks Pay, so the user needs to know what to
    // change without hovering anything.
    exitRefused ? {
      id: 'exit',
      tone: 'danger',
      text: 'This node cannot be the exit',
      tipLabel: 'Why this node cannot be the exit',
      tip: 'Only plain TCP survives being carried inside the entry hop: grpc and websocket bring their own dialer. Pick another exit.',
      body: (
        <>
          <p>It serves {exitGrade?.transports.join(', ') || 'no usable transport'} and no plain TCP. Still fine as an entry.</p>
          {pickAnotherExit}
        </>
      ),
    } : exitGrade?.reachable ? {
      id: 'exit',
      tone: 'success',
      text: `Exit can be chained: plain TCP inside ${exitSecurity}`,
      tipLabel: 'What was verified on this exit',
      tip: `This node serves plain TCP, so it can be chained, and the hop will be wrapped in ${
        exitSecurity === 'Reality' ? 'Reality' : "TLS, with the node's certificate pinned"
      }.${exitGrade.transports.length > 1
        ? ` It also offers ${exitGrade.transports.filter((t) => t !== 'tcp').join(', ')}, which cannot be chained.`
        : ''}`,
    } : {
      id: 'exit',
      tone: 'warning',
      text: exitGrade ? `Exit not checked: ${exitGrade.error ?? 'the node did not answer'}` : 'Exit not checked yet',
      tipLabel: 'What happens if this exit cannot be chained',
      tip: "Whether it can be chained is unknown until the handshake. If it can't, both sessions are cancelled and refunded automatically.",
    },
    // Per-hop wallets, now required. Paying both hops from one account is what lets
    // either node read its session's `accAddress`, run the public SessionsForAccount
    // query and find the other half of the chain. Deliberately a picker over wallets
    // the user already has: creating and funding one here would move coins between
    // the two accounts, which is itself a public link. The two states that must never
    // read as a pass keep their own colour and wording: `linked` blocks, and
    // `checked: false` stays amber and says it could not check.
    exitWalletState === 'none' ? {
      id: 'wallet',
      tone: 'danger',
      text: 'The exit needs its own wallet',
      tipLabel: 'Why the exit needs its own wallet',
      tip: "A session's account is public on chain. Paid from one wallet, either node can look your address up and find the other hop.",
      body: (
        <>
          <p>You have one wallet, so either node could look up the other hop.</p>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>In Settings, Wallets: derive a new account, or add a wallet.</li>
            <li>Fund it from an exchange or any source that never touched &ldquo;{activeName}&rdquo;.</li>
            <li>Come back here. It appears in this list.</li>
          </ol>
          <div>
            <button onClick={handleOpenWalletSettings} className="btn btn-secondary text-xs px-2.5 py-1">
              Open wallet settings
            </button>
          </div>
        </>
      ),
    } : exitWalletState === 'checking' ? {
      id: 'wallet',
      tone: 'busy',
      text: wallets === null ? 'Loading your wallets…' : `Checking whether “${exitName}” and “${activeName}” are linked…`,
      body: walletSelect,
    } : exitWalletState === 'linked' ? {
      id: 'wallet',
      tone: 'danger',
      text: `“${exitName}” was funded from “${activeName}”`,
      tipLabel: 'Why a transfer between the wallets undoes this',
      tip: 'There is a transfer between this wallet and your active one, and transfers are public. Anyone who sees both hops can follow it back and join them. To get the benefit, the exit wallet needs funds that never touched the other account.',
      body: <><p>Transfers are public, so paying separately hides nothing. Pick another wallet.</p>{walletSelect}</>,
    } : exitWalletState === 'unchecked' ? {
      id: 'wallet',
      tone: 'warning',
      text: `Couldn't check whether “${exitName}” and “${activeName}” are linked`,
      tipLabel: 'Why the link check could not run',
      tip: 'The RPC did not answer, or keeps no transaction index. If you funded this wallet from the other one, that transfer is public and the hops are still joined.',
      body: walletSelect,
    } : {
      id: 'wallet',
      tone: 'success',
      text: `Exit paid by “${exitName}”. No transfer links it to “${activeName}”`,
      tipLabel: 'What this check does and does not cover',
      tip: 'Neither node can pair them by following coins from one to the other. Only that one hop is checked: if both wallets were funded from the same third account, an exchange withdrawal for instance, that account still joins them.',
      body: walletSelect,
    },
    ...[dnsCheck(settings, mode, 'the chain'), otherVpnCheck(otherVpns)].filter((c): c is CheckSpec => c !== null),
  ]

  const limits: Limit[] = [
    {
      key: 'anonymity',
      tone: 'danger',
      label: 'Not anonymity',
      text: 'Two operators working together can still match the traffic itself, since the same bytes cross both hops at the same moments. Paying each hop from a different account stops them pairing you on chain; it does not stop them comparing notes.',
    },
    {
      key: 'speed',
      tone: 'warning',
      label: 'About 20x slower',
      text: 'Every packet crosses two nodes, often on two continents. Measured on a live chain, not estimated: about 20 times the latency of one hop, at 2 to 3 MB/s. Two sessions, two deposits, each billed separately.',
    },
    {
      key: 'lifetime',
      tone: 'warning',
      label: 'Ends about 2 h after buying',
      text: 'Exit nodes do not report usage to the chain, so the chain closes the exit session about 2 hours after you buy it, however much time or data you paid for. The entry keeps whatever it has left. Measured on three chains through three different exit nodes.',
    },
    ...[keysLimit({
      subject: 'chain',
      signs: versionSignsReplies(entry.version) && versionSignsReplies(exit.version),
    })].filter((l): l is Limit => l !== null),
  ]

  const footer = reviewing ? (
    <>
      {blocker !== null && blocker !== 'unacknowledged' && (
        <FooterReason
          tone={blocker === 'wallet-checking' ? 'busy' : 'danger'}
          text={blockerText(blocker, { billing, activeName, exitName, entryFunds, exitFunds })}
        />
      )}
      <label className="flex items-center gap-2 cursor-pointer text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="accent-accent"
        />
        <span>I understand what a chain does and does not hide.</span>
      </label>
      <button
        onClick={handleBuild}
        disabled={blocker !== null}
        className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Pay {formatP2p(costUdvpn)} P2P and connect
      </button>
    </>
  ) : tunnelConnected && paid ? (
    <button onClick={handleClose} className="btn btn-primary w-full">Done</button>
  ) : undefined

  return (
    <ReviewModal title={title} closable={!connecting} onClose={handleClose} footer={footer} className="max-w-2xl">
      <RouteStrip
        hops={[entry, exit]}
        stage={stage}
        info={reviewing ? {
          label: 'What each hop can see',
          // The two claims the strip makes by itself, with the caveat that keeps the
          // second one honest. These were two always-green rows before.
          text: "The entry sees your IP but not your destinations; the exit sees your destinations, and your traffic reaches it only through the entry. Neither alone watches both ends of your browsing. Buying a session means asking a node for its keys, and for the exit that request is carried by the entry hop, so the exit sees the entry's address and never yours. One thing it does not cover: while you were choosing, this app asked candidate nodes what they support, directly. That question carries no wallet and no session, but it did come from you.",
        } : undefined}
      />

      {reviewing && (
        <>
          <ChecksSection title="Privacy checks" checks={checks} />

          <section className="space-y-2.5">
            <SectionHead title="Cost">
              <Segmented
                label="Billing"
                value={billing}
                options={[['gigabytes', 'Per GB'], ['hours', 'Per hour']]}
                onChange={setBilling}
              />
            </SectionHead>
            {/* Both hops carry the same bytes and the same wall-clock, so the chain
                lasts as long as its SHORTER half — buying different amounts per hop
                would just strand the difference. One amount, applied to both. */}
            <AmountStepper
              label="On each hop"
              amount={amount}
              onChange={setAmount}
              unit={billing === 'gigabytes' ? 'GB' : amount === 1 ? 'hour' : 'hours'}
              presets={billing === 'gigabytes' ? [1, 5, 10] : [1, 2]}
              tip={{
                label: 'Why one amount for both hops',
                text: 'Both hops carry the same traffic for the same time, so the chain ends when either half runs out. Buying different amounts would strand the difference.',
              }}
            />
            {/* Measured 2026-08-15: the exit never reports usage, so the chain reaps
                it at purchase + statusTimeout (2 h) whatever was bought. Hours past
                that are paid for and almost certainly never used. */}
            {billing === 'hours' && amount > 2 && (
              <Note>The exit usually closes about 2 h after you buy it, so hours past 2 are likely unused.</Note>
            )}
            <Receipt total={
              <>
                <span className="col-span-2 font-semibold text-text-primary">Total, two deposits</span>
                <span className="text-right font-mono font-semibold text-accent">{formatP2p(costUdvpn)} P2P</span>
              </>
            }>
              <ReceiptLine
                country={entry.country}
                label="Entry"
                payer={activeName}
                detail={priceDetail(entryPrice, perUnit, amount, billing)}
                amount={entryPrice === null ? null : `${formatP2p(entryCost)} P2P`}
                funds={entryFunds}
              />
              <ReceiptLine
                country={exit.country}
                label="Exit"
                payer={exitWalletId ? exitName : null}
                detail={priceDetail(exitPrice, perUnit, amount, billing)}
                amount={exitPrice === null ? null : `${formatP2p(exitCost)} P2P`}
                funds={exitFunds}
              />
            </Receipt>
            {entryShort && entryFunds && (
              <InsufficientFunds
                message={insufficientFundsMessage(entryFunds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}
            {/* Not the InsufficientFunds pane: that one offers the ACTIVE wallet's
                address, and the obvious way to top the exit wallet up (from the
                active one) is the transfer that undoes the second wallet. */}
            {exitShort && exitFunds && (
              <div className="flex items-start justify-between gap-3 text-xs text-warning bg-warning-subtle border border-warning rounded-md p-3">
                <p>
                  &ldquo;{exitName}&rdquo; needs {formatP2pCeil(exitFunds.shortfall)} P2P more for the exit, fees
                  included. Fund it from a source that never touched &ldquo;{activeName}&rdquo;.
                </p>
                <button
                  type="button"
                  onClick={() => setExitBalanceReads((n) => n + 1)}
                  className="btn btn-secondary text-xs px-2.5 py-1 shrink-0"
                >
                  Check again
                </button>
              </div>
            )}
          </section>

          {/* The honest part. Every claim here is measured or verified on chain —
              see docs/multihop.md. Do not soften it into "anonymity". */}
          <LimitsSection title="Limits of any chain" limits={limits} />

          <OptionsSection summary={`${modeSummary(mode)} · node details`}>
            <ModeField mode={mode} onChange={setMode} />
            <div className="space-y-1.5">
              <div className="text-xs text-text-secondary">Node details</div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                {([['Entry', entry], ['Exit', exit]] as const).map(([role, n]) => (
                  <NodeDetail key={role} role={role} node={n} transports={eligibility.results.get(n.address)?.transports} />
                ))}
              </dl>
            </div>
          </OptionsSection>
        </>
      )}

      {connecting && (
        <div className="space-y-4">
          {/* Two hops, tracked separately. The generic 5-step list is wrong here: a
              chain repeats steps 1-3 for the second purchase, so it counts up,
              jumps back and counts up again with nothing saying why. */}
          <div className="space-y-2">
            <HopProgress
              label="Entry"
              node={entry}
              stage={hopStage('entry', hopMarker, tunnelStarted)}
              detail={hopMarker?.hop === 'entry' && !tunnelStarted ? currentDetail : null}
            />
            <HopProgress
              label="Exit"
              node={exit}
              stage={hopStage('exit', hopMarker, tunnelStarted)}
              detail={hopMarker?.hop === 'exit' && !tunnelStarted ? currentDetail : null}
            />
            <div className="flex items-start gap-3 text-sm">
              <span className={`status-dot mt-1.5 ${tunnelStarted ? 'status-dot-pending' : ''}`} />
              <span className="min-w-0">
                <span className={tunnelStarted ? 'text-text-primary' : 'text-text-tertiary'}>
                  Establishing the chained tunnel
                </span>
                {tunnelStarted && currentDetail && (
                  <span className="block text-text-tertiary text-xs">{currentDetail}</span>
                )}
              </span>
            </div>
          </div>
          <p className="text-text-tertiary text-xs">
            Leave this open. If anything fails after a session is paid for, it is cancelled
            automatically.
          </p>
        </div>
      )}

      {error && !connecting && (
        <div className="space-y-3">
          {/* Both hops are paid for and neither is named in the shared error pane,
              which only carries one session id. Without this the two deposits are
              invisible at exactly the moment the user is deciding what to do next. */}
          {paid && (
            <div className="border border-border rounded-md p-3 text-xs space-y-1">
              <p className="text-text-primary">Both hops are bought and still open.</p>
              <p className="text-text-secondary">
                Entry <span className="font-mono">#{paid.entrySessionId}</span>, exit{' '}
                <span className="font-mono">#{paid.exitSessionId}</span>. Retrying the connection
                does not charge you again. If you give up, end them from the Sessions tab, where
                they appear as one chain.
              </p>
            </div>
          )}
          <ConnectErrorActions
            error={error}
            paidSessionId={paid ? paid.entrySessionId : null}
            onRetryTunnel={handleRetryTunnel}
            onRetryPurchase={() => void handleBuild()}
            // With two sessions already paid for, "start over" must NOT lead back to
            // the review: the Pay button there is live, and pressing it buys a SECOND
            // pair while the first is still open and still charged. Close instead, and
            // leave the chain where the user can see and end it.
            onStartOver={paid
              ? handleClose
              : () => { setError(null); setCurrentStep(null) }}
          />
        </div>
      )}

      {tunnelConnected && paid && (
        <div className="space-y-1.5">
          <p className="text-text-primary">
            {mode === 'proxy' ? 'Chained proxy active. ' : ''}
            Sites now see you in {exit.city ? `${exit.city}, ` : ''}{exit.country}.
          </p>
          <p className="text-text-tertiary text-xs font-mono">
            Entry #{paid.entrySessionId} · Exit #{paid.exitSessionId} · billed separately
          </p>
          <p className="text-text-tertiary text-xs">
            Ending either hop ends the chain. Both are in the Sessions tab.
          </p>
          {mode === 'proxy' && (
            <p className="text-text-tertiary text-xs">
              SOCKS5 at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only apps
              pointed at it go through the chain.
            </p>
          )}
        </div>
      )}

    </ReviewModal>
  )
}

function priceDetail(price: number | null, perUnit: string, amount: number, billing: 'gigabytes' | 'hours') {
  return price === null
    ? <span className="text-warning">no P2P price for {billing === 'gigabytes' ? 'data' : 'time'}</span>
    : `${formatP2p(price)} per ${perUnit} × ${amount}`
}

/** The footer's one line about why Pay is disabled. */
function blockerText(b: ChainBlocker, c: {
  billing: 'gigabytes' | 'hours'
  activeName: string
  exitName: string
  entryFunds: FundsCheck | null
  exitFunds: FundsCheck | null
}): string {
  switch (b) {
    case 'connected': return 'A tunnel is already up. Disconnect it first, on the tab behind this window.'
    case 'pair': return 'The two hops must be in different countries and on different networks. Pick another exit.'
    case 'exit-refused': return 'This node cannot be the exit. Pick another exit.'
    case 'no-wallet': return 'The exit needs its own wallet. Set one up above.'
    case 'wallet-linked': return `“${c.exitName}” was funded from “${c.activeName}”. Pick another wallet for the exit.`
    case 'wallet-checking': return 'Checking whether the two wallets are linked…'
    case 'price-missing': return `One of these nodes has no P2P price for ${c.billing === 'gigabytes' ? 'data' : 'time'}. Switch the billing, or pick another node.`
    case 'entry-short': return `“${c.activeName}” is short by ${formatP2pCeil(c.entryFunds?.shortfall ?? 0)} P2P for the entry.`
    case 'exit-short': return `“${c.exitName}” is short by ${formatP2pCeil(c.exitFunds?.shortfall ?? 0)} P2P for the exit.`
    case 'unacknowledged': return 'Tick the box to confirm you have read what a chain does not hide.'
  }
}

function NodeDetail({ role, node, transports }: { role: string; node: SentNode; transports?: string[] }) {
  return (
    <>
      <dt className="text-text-tertiary">{role}</dt>
      <dd className="text-text-secondary font-mono break-all">
        {node.asn ? `AS${node.asn} · ` : ''}{node.api} · {protocolMeta(node.type).short}
        {transports && transports.length > 0 ? ` · serves ${transports.join(', ')}` : ''}
      </dd>
    </>
  )
}

type HopPhase = 'buy' | 'provision' | 'handshake'
type HopMarker = { hop: 'entry' | 'exit'; phase: HopPhase }

/** `hop:entry:buy` and friends. Anything else is ignored rather than guessed at. */
function parseHopMarker(step: string): HopMarker | null {
  const [, hop, phase] = step.split(':')
  if (
    (hop === 'entry' || hop === 'exit') &&
    (phase === 'buy' || phase === 'provision' || phase === 'handshake')
  ) {
    return { hop, phase }
  }
  return null
}

/**
 * The order main announces these in. The whole entry is finished before the exit is
 * touched, because the exit is reached THROUGH the entry: it is bought and handshaked
 * over a proxy that the entry hop is already carrying.
 */
const MARKER_SEQUENCE: HopMarker[] = [
  { hop: 'entry', phase: 'buy' },
  { hop: 'entry', phase: 'handshake' },
  { hop: 'exit', phase: 'provision' },
  { hop: 'exit', phase: 'buy' },
  { hop: 'exit', phase: 'handshake' },
]

/** Where `marker` sits in MARKER_SEQUENCE, which is also RouteStrip's build step. */
function markerIndex(marker: HopMarker): number {
  return MARKER_SEQUENCE.findIndex((s) => s.hop === marker.hop && s.phase === marker.phase)
}

type HopStage = 'pending' | 'buying' | 'routing' | 'handshaking' | 'done'

/**
 * Where a hop sits, given the marker main last sent. Scored off the position in
 * MARKER_SEQUENCE rather than off the role alone, which is what keeps each hop's own
 * stage moving in one direction only: an earlier version read the role and made both
 * hops jump backwards halfway through the build.
 */
function hopStage(role: 'entry' | 'exit', marker: HopMarker | null, tunnelStarted: boolean): HopStage {
  if (tunnelStarted) return 'done'
  const at = marker === null ? -1 : markerIndex(marker)
  if (at < 0) return 'pending'
  const stages: Record<'entry' | 'exit', HopStage[]> = {
    entry: ['buying', 'handshaking', 'done', 'done', 'done'],
    exit: ['pending', 'pending', 'routing', 'buying', 'handshaking'],
  }
  return stages[role][at]
}

const HOP_STAGE_LABEL: Record<HopStage, string | null> = {
  pending: null,
  buying: 'Buying the session on chain.',
  // The step this whole flow exists for, so it says what it is buying the user.
  routing: 'Connecting through the entry, so this node never sees your address.',
  handshaking: 'Handshaking with the node.',
  done: 'Bought and handshaked.',
}

function HopProgress({ label, node, stage, detail }: {
  label: string
  node: SentNode | null
  stage: HopStage
  detail: string | null
}) {
  const busy = stage === 'buying' || stage === 'handshaking'
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className={`status-dot mt-1.5 ${
        stage === 'done' ? 'status-dot-active' : stage === 'pending' ? '' : 'status-dot-pending'
      }`} />
      <span className="min-w-0">
        <span className={stage === 'pending' ? 'text-text-tertiary' : 'text-text-primary'}>
          {label} hop{node ? ` · ${node.moniker || node.country}` : ''}
        </span>
        {busy && detail && <span className="block text-text-tertiary text-xs">{detail}</span>}
        {HOP_STAGE_LABEL[stage] && (
          <span className="block text-text-tertiary text-xs">{HOP_STAGE_LABEL[stage]}</span>
        )}
      </span>
    </div>
  )
}
