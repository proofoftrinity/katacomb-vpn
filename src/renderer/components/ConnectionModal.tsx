import { useState, useEffect } from 'react'
import type { SentNode, NodeProbeResult, PlanInfo, ExtendResult } from '../types'
import { useConnectFlow } from '../hooks/useConnectFlow'
import { usePlansContext } from '../contexts/PlansContext'
import ConnectErrorActions from './ConnectErrorActions'
import CopyButton from './CopyButton'
import ProtocolIcon from './ProtocolIcon'
import RouteStrip, { singleHopStep, type RouteStage } from './RouteStrip'
import {
  AmountStepper, ChecksSection, FooterReason, LimitsSection, ModeField, OptionsSection,
  Receipt, ReceiptLine, ReviewModal, SectionHead, Segmented, StepList, VpnConfirm,
  dnsCheck, encryptionCheck, keysLimit, modeSummary, otherVpnCheck, seesBothLimit, signingCheck, switchCheck, useActiveWalletName, useOtherVpns, useReviewSettings,
  type CheckSpec, type Limit,
} from './ConnectReview'
import { connectionRelation, previousConnection, switchFooterText } from '../utils/switch'
import { useNavigation } from '../contexts/NavigationContext'
import { useConnection } from '../hooks/useConnection'
import { protocolMeta, isProtocolSupported, isProxyCapable } from '../utils/protocols'
import { nodeStatusMeta, isNodeConnectable, hasDirectoryDetails } from '../utils/node-status'
import { nodeSoftware, versionSignsReplies } from '../../shared/node-signing'
import { useBalance } from '../hooks/useBalance'
import { checkFunds, formatP2p, formatP2pCeil, insufficientFundsMessage } from '../../shared/funds'
import { displayConnectError } from '../utils/connect-errors'
import InsufficientFunds from './InsufficientFunds'
import { SOCKS_DISPLAY_ADDR } from '../../shared/socks'

interface Props {
  node: SentNode
  onClose: () => void
  /** Open on Extend ([REL-46]): a Sessions card's Extend, for the node it is connected to. */
  startExtend?: boolean
}

function getUdvpnPrice(prices: { denom: string; value: string }[]): { raw: string; display: string } | null {
  const p = prices.find((x) => x.denom === 'udvpn')
  if (!p) return null
  return { raw: p.value, display: formatP2p(parseInt(p.value, 10)) }
}

/**
 * Connect to one node from the Nodes tab: the single-hop counterpart of the chain
 * review, built from the same pieces (ConnectReview) so the two read as one product.
 * Route strip first (with what a single node sees, which is both ends), then the
 * checks, the cost and the limits, and a footer that always names what stops Pay.
 */
export default function ConnectionModal({ node, onClose, startExtend = false }: Props) {
  const nodeStatus = nodeStatusMeta(node)
  const connectable = isNodeConnectable(node)
  // The node list's health flag is third-party and can be hours stale, so an
  // active-but-unhealthy node may be tried on explicit acknowledgement — a failed
  // handshake is refunded (establishSessionOrRefund), so it costs a wait, not funds.
  // An INACTIVE node is not overridable: the chain itself rejects those sessions.
  const canOverrideHealth = nodeStatus.state === 'unhealthy'
  const [healthAcknowledged, setHealthAcknowledged] = useState(false)
  const { goToPlansForNode, setMainTab } = useNavigation()
  // Live connection status — when the tunnel is already up to THIS node (alone, not as
  // a chain's entry) we show a "Connected" panel + Disconnect instead of the subscribe
  // form (which would create a redundant second session). `reconnecting` counts so we
  // don't flash the form during a same-node reconnect blip.
  const { status } = useConnection()
  const relation = connectionRelation(status, { node: node.address })
  const onThisNode = relation === 'same'
  // Connected, but not to THIS node: another node, a plan session, a chain or a
  // local proxy. Pay switches ([RN-10]): it leaves that connection first, because main
  // refuses a second session beside a live one (assertNotConnected).
  const switchFrom = relation === 'switch' ? previousConnection(status) : null
  // Plans compatible with THIS node. null = still loading.
  const [compatiblePlans, setCompatiblePlans] = useState<PlanInfo[] | null>(null)
  // The wallet's plan allocations, for the reuse-vs-fresh-subscribe decision.
  const { overview: { allocations } } = usePlansContext()
  const [subType, setSubType] = useState<'gigabytes' | 'hours'>('gigabytes')
  const [amount, setAmount] = useState(1)
  const { udvpn, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  // The purchase-then-tunnel state machine, shared with the Plans tab's modal.
  const {
    connecting, currentStep, stepDetail, error, tunnelConnected, sessionId, paidProtocol, disconnecting, switching,
    start, retryPurchase, retryTunnel, disconnect: disconnectFlow, reset,
  } = useConnectFlow()
  // Full tunnel vs. local SOCKS proxy. Only the child-proxy protocols expose a
  // local listener, so the choice is hidden (and forced to 'tunnel') otherwise.
  const [mode, setMode] = useState<'tunnel' | 'proxy'>('tunnel')
  const [vpnWarning, setVpnWarning] = useState<{ type: string; name: string; iface?: string }[] | null>(null)
  const [probeResult, setProbeResult] = useState<NodeProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const walletName = useActiveWalletName()
  const settings = useReviewSettings()
  const otherVpns = useOtherVpns()
  // [REL-46] Extend: buy a new session on this node and move the live connection onto it.
  // One call to main does all of it; this window reviews it, shows the steps and the outcome.
  const [extendOpen, setExtendOpen] = useState(startExtend)
  const [extendRunning, setExtendRunning] = useState(false)
  const [extendStep, setExtendStep] = useState<{ id: string; detail: string | null }>({ id: '1/5', detail: null })
  const [extendFrom, setExtendFrom] = useState<string | null>(null)
  const [extendError, setExtendError] = useState<string | null>(null)
  const [extendResult, setExtendResult] = useState<ExtendResult | null>(null)

  // v2ray(2)/xray(4)/hysteria2(6) run a local SOCKS5 listener, so they can be used
  // as a plain proxy. WireGuard/AmneziaWG are the routing change — no proxy mode.
  const proxyCapable = isProxyCapable(node.type)
  const effectiveMode = proxyCapable ? mode : 'tunnel'
  const protocol = protocolMeta(node.type)

  const gbPrice = getUdvpnPrice(node.gigabytePrices)
  const hrPrice = getUdvpnPrice(node.hourlyPrices)
  const selectedPrice = subType === 'gigabytes' ? gbPrice : hrPrice
  const costUdvpn = selectedPrice ? parseInt(selectedPrice.raw, 10) * amount : 0

  useEffect(() => {
    let cancelled = false
    window.api
      .planListForNode(node.address)
      .then((plans) => {
        if (!cancelled) setCompatiblePlans(plans)
      })
      .catch(() => {
        if (!cancelled) setCompatiblePlans([])
      })
    return () => {
      cancelled = true
    }
  }, [node.address])

  // Active allocation whose plan covers this node. When present we silently
  // reuse it instead of charging the user per-GB or creating a new subscription.
  const matchingAllocation = (() => {
    if (!compatiblePlans || compatiblePlans.length === 0) return null
    const compatibleIds = new Set(compatiblePlans.map((p) => p.id))
    return allocations.find((a) => a.status === 1 && compatibleIds.has(a.planId)) ?? null
  })()

  // Reusing an allocation buys nothing on-chain — only gas is due. null while the
  // balance is unknown: never block the pay button on a balance we couldn't read.
  const funds = udvpn === null ? null : checkFunds(udvpn, matchingAllocation ? 0 : costUdvpn)
  const cantAfford = funds !== null && !funds.ok

  // Auto-probe latency as soon as the modal opens — saves the user a click and
  // surfaces reachability inline with the rest of the node details.
  useEffect(() => {
    let cancelled = false
    setProbing(true)
    setProbeResult(null)
    window.api
      .nodeTestProbe({ nodeAddress: node.address, remoteUrl: node.api })
      .then((result) => {
        if (!cancelled) setProbeResult(result)
      })
      .catch(() => {
        if (!cancelled) {
          setProbeResult({
            nodeAddress: node.address,
            timestamp: Date.now(),
            reachable: false,
            latencyMs: null,
            error: 'Probe failed',
          })
        }
      })
      .finally(() => {
        if (!cancelled) setProbing(false)
      })
    return () => {
      cancelled = true
    }
  }, [node.address, node.api])

  // Extend presets the billing to the live session's own: per GB when it has a data cap.
  // While connected, main answers from its session cache, so this costs no chain read.
  useEffect(() => {
    if (!extendOpen || !status.sessionId) return
    let cancelled = false
    window.api.walletSessions()
      .then((rows) => {
        const live = rows.find((r) => r.id === status.sessionId)
        if (!cancelled && live) setSubType(parseInt(live.maxBytes, 10) > 0 ? 'gigabytes' : 'hours')
      })
      .catch(() => { /* the billing shown stands */ })
    return () => { cancelled = true }
  }, [extendOpen, status.sessionId])

  useEffect(() => {
    if (!extendRunning) return
    return window.api.onConnectionProgress((id, detail) => setExtendStep({ id, detail: detail ?? null }))
  }, [extendRunning])

  async function handleExtend() {
    if (!selectedPrice || !status.sessionId) return
    setExtendFrom(status.sessionId)
    setExtendStep({ id: '1/5', detail: null })
    setExtendError(null)
    setExtendRunning(true)
    try {
      setExtendResult(await window.api.connectionExtend({
        sessionId: status.sessionId,
        nodeAddress: node.address,
        type: subType,
        amount,
        denom: 'udvpn',
        quoteValue: selectedPrice.raw,
      }))
    } catch (err) {
      setExtendError(err instanceof Error ? err.message : 'Extend failed')
    } finally {
      setExtendRunning(false)
      void refreshBalance()
    }
  }

  async function handleSubscribe() {
    if (!matchingAllocation && !selectedPrice) return

    if (!vpnWarning) {
      try {
        const otherVpns = await window.api.connectionCheckVpn()
        if (otherVpns.length > 0) {
          setVpnWarning(otherVpns)
          return
        }
      } catch { /* proceed if check fails */ }
    }
    setVpnWarning(null)

    await start(async () => {
      if (matchingAllocation) {
        // Reuse existing on-chain subscription — single MsgStartSession in
        // sentinel.subscription.v3, no new subscription is created.
        return window.api.planStartSessionFromSub({
          subscriptionId: matchingAllocation.subscriptionId,
          planId: matchingAllocation.planId,
          nodeAddress: node.address,
          nodeMoniker: node.moniker,
          nodeCountry: node.country,
          nodeType: node.type,
          apiField: node.api,
          ...(proxyCapable && mode === 'proxy' ? { proxyMode: true } : {}),
        })
      }
      if (!selectedPrice) throw new Error('No valid subscription selected')
      return window.api.connectionSubscribe({
        nodeAddress: node.address,
        nodeMoniker: node.moniker,
        nodeCountry: node.country,
        nodeType: node.type,
        apiField: node.api,
        type: subType,
        amount,
        denom: 'udvpn',
        quoteValue: selectedPrice.raw,
        ...(proxyCapable && mode === 'proxy' ? { proxyMode: true } : {}),
      })
    }, { mode: effectiveMode, switchFrom })
  }

  function handleSeePlansForNode() {
    goToPlansForNode(node.address)
    onClose()
  }

  function handleOpenMultihop() {
    setMainTab('multihop')
    onClose()
  }

  async function handleDisconnect() {
    // Only close on success: a failed disconnect used to vanish with the modal,
    // leaving the button looking ignored (the audited catch-less pattern).
    if (await disconnectFlow()) onClose()
  }

  const reviewing = !onThisNode && !connecting && !error && !tunnelConnected

  const title = onThisNode
    ? 'Connected to this node'
    : tunnelConnected
      ? 'Connected'
      : connecting
        ? 'Connecting'
        : error
          ? (paidProtocol ? 'The tunnel did not come up' : 'Not connected')
          : 'Review this node'

  // A failure is drawn on the route only at the bring-up, once the session is paid:
  // before that the error pane says what happened and nothing on the route is owed.
  const stage: RouteStage = onThisNode || tunnelConnected
    ? { kind: 'active' }
    : connecting
      ? { kind: 'building', step: singleHopStep(currentStep) }
      : error && paidProtocol
        ? { kind: 'failed' }
        : { kind: 'review' }

  // ---- checks ----
  // While connected, the probe leaves through the live tunnel like any other traffic,
  // so its time includes that route, and a timeout may be the route's, not the node's.
  const live = relation !== 'idle'
  const probeLine = probeResult?.reachable
    ? `This app's own probe: ${probeResult.latencyMs} ms, reachable.`
    : probeResult
      ? `This app's own probe got no answer${probeResult.error ? `: ${probeResult.error}` : ''}.`
      : null
  const probeTip = `This is this app's own probe of the node's API port${
    live ? ', sent through your current connection, so its time includes that route' : ''
  }. A node can answer it and still fail to build a tunnel; a failed handshake is cancelled and refunded automatically.`
  const healthCheck: CheckSpec = !hasDirectoryDetails(node) ? {
    id: 'health',
    tone: 'danger',
    text: 'The node directory has no details for this node',
    tip: "Its protocol, address and location are unknown, so there is nothing to connect with. The node may be working; the directory just hasn't read it.",
  } : !isProtocolSupported(node.type) ? {
    id: 'health',
    tone: 'danger',
    text: `This app can't connect to ${protocol.label} nodes yet`,
    tip: 'The node is listed so you can filter and compare, nothing more.',
  } : nodeStatus.state === 'inactive' ? {
    id: 'health',
    tone: 'danger',
    text: 'Not active on chain',
    tipLabel: 'Why an inactive node cannot be tried',
    tip: 'The chain itself refuses a session with a node that is not registered as active, so there is nothing to override.',
  } : nodeStatus.state === 'unhealthy' ? {
    id: 'health',
    tone: 'warning',
    text: 'Failed the last network health check',
    tipLabel: 'About the health check',
    tip: 'That check runs elsewhere, by the node list, and can be hours out of date. The node may well be working, so connecting is only off until you say to try.',
    body: (
      <>
        <p>{nodeStatus.detail}{probeLine ? ` ${probeLine}` : ''}</p>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={healthAcknowledged}
            onChange={(e) => setHealthAcknowledged(e.target.checked)}
            className="accent-accent mt-0.5"
          />
          <span>Try it anyway. If the handshake fails, the session is cancelled and refunded automatically.</span>
        </label>
      </>
    ),
  } : probing ? {
    id: 'health',
    tone: 'busy',
    text: 'Active on chain. Measuring latency…',
  } : probeResult?.reachable ? {
    id: 'health',
    tone: 'success',
    text: `Active and reachable, ${probeResult.latencyMs} ms`,
    tipLabel: 'What was measured',
    tip: probeTip,
  } : {
    id: 'health',
    tone: 'warning',
    text: "Active, but it didn't answer this app's probe",
    tipLabel: 'What was measured',
    tip: probeTip,
    body: probeResult?.error || live
      ? <p>{[probeResult?.error && `${probeResult.error}.`, live && 'Sent through your current connection.'].filter(Boolean).join(' ')}</p>
      : undefined,
  }

  const checks: CheckSpec[] = [
    ...[switchCheck(switchFrom, settings)].filter((c): c is CheckSpec => c !== null),
    healthCheck,
    ...(isProtocolSupported(node.type) ? [encryptionCheck(node)] : []),
    ...[signingCheck(node), dnsCheck(settings, effectiveMode, 'this node'), otherVpnCheck(otherVpns)]
      .filter((c): c is CheckSpec => c !== null),
  ]

  const limits: Limit[] = [
    seesBothLimit(handleOpenMultihop),
    ...[keysLimit({ subject: 'node', signs: versionSignsReplies(node.version) })].filter((l): l is Limit => l !== null),
    // Measured on #56152782 (docs/invariants/reliability.md): two tunnel windows of
    // 646 s with a 657 s gap between them settled as 1306 s. n=1, so it says so.
    ...(!matchingAllocation && subType === 'hours' ? [{
      key: 'hourly',
      tone: 'warning' as const,
      label: 'Time runs between uses',
      text: 'A node bills time from the start of the session to its last activity, including the gaps while you are disconnected. Measured on one session so far. For on-and-off use, paying per GB is the fairer deal.',
    }] : []),
  ]

  // ---- the footer's one reason ----
  const blocker: { text: string; tone: 'danger' | 'muted' } | null =
    !hasDirectoryDetails(node)
      ? { text: 'Connecting is disabled because the node directory has no details for this node.', tone: 'danger' }
      : !isProtocolSupported(node.type)
        ? { text: `${protocol.label} isn't supported by this client yet. This node is shown for filtering only.`, tone: 'danger' }
        : nodeStatus.state === 'inactive'
          ? { text: 'Connecting is disabled because this node is not active on chain.', tone: 'danger' }
          : !connectable && !(canOverrideHealth && healthAcknowledged)
            ? { text: 'Tick "Try it anyway" above to connect to a node that failed its health check.', tone: 'muted' }
            : !matchingAllocation && !selectedPrice
              ? { text: `This node has no P2P price for ${subType === 'gigabytes' ? 'data' : 'time'}. Switch the billing.`, tone: 'danger' }
              : cantAfford && funds
                ? { text: `Not enough P2P: short by ${formatP2pCeil(funds.shortfall)}, fees included.`, tone: 'danger' }
                : null

  // ---- Extend ([REL-46]) ----
  // The live single-hop session, paid per GB or per hour: what Extend works on. Main
  // checks all of it again; this only decides what the window offers.
  const extendable = onThisNode && status.state === 'connected' && !status.subscriptionId
  // D3: over WireGuard or AmneziaWG, only on a node known to run dvpnx. dvpnd drops the
  // current peer before its answer to the new session can come back through it.
  const software = nodeSoftware({ version: node.version, signedReply: status.handshakeSigner === 'node' || status.handshakeSigner === 'hotKey' })
  const wgLabel = node.type === 5 ? 'AmneziaWG' : 'WireGuard'
  const extendNodeReason = (node.type === 1 || node.type === 5) && software !== 'dvpnx'
    ? software === 'dvpnd'
      ? `Extend is not available on this node yet: it runs dvpnd, which closes your current ${wgLabel} tunnel as soon as a new session is set up.`
      : `Extend is off for this node: this app cannot tell which software it runs, and on some a new session cuts the current ${wgLabel} tunnel before it is set up.`
    : null
  const extendFunds = udvpn === null ? null : checkFunds(udvpn, costUdvpn, 2)

  const footer = reviewing ? (
    vpnWarning ? (
      <VpnConfirm vpns={vpnWarning} onContinue={() => void handleSubscribe()} onCancel={() => setVpnWarning(null)} disabled={cantAfford} />
    ) : (
      <>
        {blocker
          ? <FooterReason text={blocker.text} tone={blocker.tone} />
          : switchFrom && <FooterReason text={switchFooterText(switchFrom)} tone="muted" />}
        <button
          onClick={handleSubscribe}
          disabled={blocker !== null}
          className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {matchingAllocation
            ? `${switchFrom ? 'Switch' : 'Connect'} via plan #${matchingAllocation.planId}`
            : `Pay ${selectedPrice ? formatP2p(costUdvpn) : '0.00'} P2P and ${switchFrom ? 'switch' : 'connect'}`}
        </button>
      </>
    )
  ) : onThisNode && !connecting && !tunnelConnected ? (
    <>
      {extendable && extendNodeReason && <FooterReason text={extendNodeReason} tone="muted" />}
      <div className="flex gap-2">
        {extendable && (
          <button
            onClick={() => setExtendOpen(true)}
            disabled={disconnecting || extendNodeReason !== null}
            className="btn btn-primary flex-1 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Buy more time or data on this node and move your connection onto it"
          >
            Extend
          </button>
        )}
        <button
          onClick={handleDisconnect}
          disabled={disconnecting}
          className="btn btn-danger flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </button>
        <button
          onClick={onClose}
          disabled={disconnecting}
          className="btn btn-secondary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Close
        </button>
      </div>
    </>
  ) : tunnelConnected && sessionId ? (
    <button onClick={onClose} className="btn btn-primary w-full">Done</button>
  ) : undefined

  const steps = [
    ...(switching ? [{ id: 'switch', label: `Disconnecting from ${switching.from.label}` }] : []),
    { id: '1/5', label: 'Preparing' },
    { id: '2/5', label: matchingAllocation ? 'Starting a session on your plan' : 'Buying the session on chain' },
    { id: '3/5', label: 'Confirming the session' },
    { id: '4/5', label: 'Handshaking with the node' },
    { id: '5/5', label: 'Starting the tunnel' },
  ]

  if (extendOpen) {
    const from = extendFrom ?? status.sessionId ?? '?'
    const unit = subType === 'gigabytes' ? 'GB' : 'hr'
    const blocker = !extendable
      ? 'Extend works while you are connected to this node with a session paid per GB or per hour.'
      : extendNodeReason
        ?? (!selectedPrice
          ? `This node has no P2P price for ${subType === 'gigabytes' ? 'data' : 'time'}. Switch the billing.`
          : extendFunds && !extendFunds.ok
            ? `Not enough P2P: short by ${formatP2pCeil(extendFunds.shortfall)}, both fees included.`
            : null)
    // The old tunnel carries the traffic until the switch, and the new one after it.
    const extendStage: RouteStage = extendRunning && extendStep.id === 'extend:switch'
      ? { kind: 'building', step: singleHopStep('5/5') }
      : extendError && !onThisNode ? { kind: 'failed' } : { kind: 'active' }
    const extendSteps = [
      { id: '1/5', label: 'Preparing' },
      { id: '2/5', label: 'Buying the new session on chain' },
      { id: '3/5', label: 'Confirming the session' },
      { id: '4/5', label: 'Handshaking with the node' },
      { id: 'extend:switch', label: 'Moving your connection to the new session' },
      { id: 'extend:end-old', label: `Ending session #${from}` },
    ]
    const extendFooter = extendRunning ? undefined : extendResult ? (
      <button onClick={onClose} className="btn btn-primary w-full">Done</button>
    ) : extendError ? (
      <div className="flex gap-2">
        <button onClick={() => setExtendError(null)} className="btn btn-secondary flex-1">Back</button>
        <button onClick={onClose} className="btn btn-secondary flex-1">Close</button>
      </div>
    ) : (
      <>
        {blocker && <FooterReason text={blocker} tone={extendable ? 'danger' : 'muted'} />}
        <div className="flex gap-2">
          <button onClick={() => setExtendOpen(false)} className="btn btn-secondary">Back</button>
          <button
            onClick={() => void handleExtend()}
            disabled={blocker !== null}
            className="btn btn-primary flex-1 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {`Pay ${selectedPrice ? formatP2p(costUdvpn) : '0.00'} P2P and extend`}
          </button>
        </div>
      </>
    )
    return (
      <ReviewModal
        title={extendResult ? 'Extended' : extendRunning ? 'Extending' : extendError ? 'Extend did not finish' : 'Extend this session'}
        closable={!extendRunning}
        onClose={onClose}
        footer={extendFooter}
      >
        <RouteStrip hops={[node]} stage={extendStage} />
        {extendRunning ? (
          <div className="space-y-4">
            <StepList
              stages={extendSteps}
              current={Math.max(0, extendSteps.findIndex((st) => st.id === extendStep.id))}
              detail={extendStep.detail}
            />
            <p className="text-text-tertiary text-xs">
              Leave this open. If the new session's handshake fails, the new session is ended and your connection carries on.
            </p>
          </div>
        ) : extendResult ? (
          <div className="space-y-1.5 text-sm">
            <p className="text-text-primary">Your connection now runs on session #{extendResult.sessionId}, on the same node.</p>
            {extendResult.previousEnded ? (
              <p className="text-text-tertiary text-xs">
                Session #{extendResult.previousSessionId} has ended. What is left of its deposit comes back to your wallet when the chain settles it, about 2 hours from now.
              </p>
            ) : (
              <p className="text-warning text-xs">
                Session #{extendResult.previousSessionId} could not be ended
                {extendResult.previousEndError ? `: ${displayConnectError(extendResult.previousEndError)}` : ''}. It no longer carries
                your traffic. End it from the Sessions tab.
              </p>
            )}
          </div>
        ) : extendError ? (
          <div className="bg-danger-subtle border border-danger p-2 rounded-md">
            <p className="text-danger text-sm whitespace-pre-line">{displayConnectError(extendError)}</p>
          </div>
        ) : (
          <>
            <section className="space-y-2.5">
              <SectionHead title="New session">
                <Segmented
                  label="Billing"
                  value={subType}
                  options={[['gigabytes', 'Per GB'], ['hours', 'Per hour']]}
                  onChange={setSubType}
                />
              </SectionHead>
              <AmountStepper
                label="How much"
                amount={amount}
                onChange={setAmount}
                unit={subType === 'gigabytes' ? 'GB' : amount === 1 ? 'hour' : 'hours'}
                presets={subType === 'gigabytes' ? [1, 5, 10] : [1, 2, 5]}
              />
              <Receipt>
                <ReceiptLine
                  country={node.country}
                  label={node.moniker || 'This node'}
                  payer={walletName}
                  detail={selectedPrice
                    ? `${selectedPrice.display} per ${unit} × ${amount}`
                    : <span className="text-warning">no P2P price for {subType === 'gigabytes' ? 'data' : 'time'}</span>}
                  amount={selectedPrice ? `${formatP2p(costUdvpn)} P2P` : null}
                  funds={extendFunds}
                />
              </Receipt>
              {/* [SL-1]: nothing comes back at the click; the old deposit's rest comes back at settlement. */}
              <p className="text-xs text-text-tertiary">
                Paid now, with two network fees: one to buy the new session and one to end session #{from}. Session #{from} ends
                once the new one carries your traffic, and what is left of its deposit comes back to your wallet when the chain
                settles it, about 2 hours later.
              </p>
              {extendFunds && !extendFunds.ok && (
                <InsufficientFunds
                  message={insufficientFundsMessage(extendFunds)}
                  onRefresh={refreshBalance}
                  refreshing={refreshingBalance}
                />
              )}
            </section>
            <section className="space-y-1.5">
              <SectionHead title="What happens" />
              <p className="text-xs text-text-secondary">
                {status.proxyMode
                  ? 'The local proxy keeps working while the new session is bought. Then it stops for a few seconds while it moves to the new session on the same node.'
                  : `Your connection stays up while the new session is bought. Then it pauses for a few seconds while it moves to the new session on the same node, and downloads or calls in progress restart. ${settings.killSwitch
                    ? 'The kill switch stays on, so nothing leaves outside the tunnel during the pause.'
                    : 'The kill switch is off, so apps that send anything during the pause reach the internet directly.'}`}
              </p>
            </section>
            {subType === 'hours' && (
              <LimitsSection title="Limits" limits={[{
                key: 'hourly',
                tone: 'warning',
                label: 'Time runs between uses',
                text: 'A node bills time from the start of the session to its last activity, including the gaps while you are disconnected. Measured on one session so far. For on-and-off use, paying per GB is the fairer deal.',
              }]} />
            )}
          </>
        )}
      </ReviewModal>
    )
  }

  return (
    <ReviewModal title={title} closable={!connecting} onClose={onClose} footer={footer}>
      <RouteStrip
        hops={[node]}
        stage={stage}
        info={reviewing ? {
          label: 'What this node can see',
          text: 'Your device connects straight to this node, so it sees your IP address. Your traffic also leaves for the internet from it, so it sees which sites you visit. HTTPS keeps what you send from it, not where you send it.',
        } : undefined}
      />

      {reviewing && (
        <>
          <ChecksSection title="Checks" checks={checks} />

          <section className="space-y-2.5">
            {matchingAllocation ? (
              <>
                <SectionHead title="Cost" />
                <Receipt>
                  <ReceiptLine
                    country={node.country}
                    label={`Plan #${matchingAllocation.planId}`}
                    payer={`subscription #${matchingAllocation.subscriptionId}`}
                    detail="No new charge. Bytes come out of this plan."
                    amount="network fee only"
                    funds={funds}
                  />
                </Receipt>
              </>
            ) : (
              <>
                <SectionHead title="Cost">
                  <Segmented
                    label="Billing"
                    value={subType}
                    options={[['gigabytes', 'Per GB'], ['hours', 'Per hour']]}
                    onChange={setSubType}
                  />
                </SectionHead>
                <AmountStepper
                  label="How much"
                  amount={amount}
                  onChange={setAmount}
                  unit={subType === 'gigabytes' ? 'GB' : amount === 1 ? 'hour' : 'hours'}
                  presets={subType === 'gigabytes' ? [1, 5, 10] : [1, 2, 5]}
                />
                <Receipt>
                  <ReceiptLine
                    country={node.country}
                    label={node.moniker || 'This node'}
                    payer={walletName}
                    detail={selectedPrice
                      ? `${selectedPrice.display} per ${subType === 'gigabytes' ? 'GB' : 'hr'} × ${amount}`
                      : <span className="text-warning">no P2P price for {subType === 'gigabytes' ? 'data' : 'time'}</span>}
                    amount={selectedPrice ? `${formatP2p(costUdvpn)} P2P` : null}
                    funds={funds}
                  />
                </Receipt>
                {/* Buying more than needed is safe: settlement pays the node for what it
                    metered and returns the rest of the deposit (session-lifecycle.md). */}
                {selectedPrice && (
                  <p className="text-xs text-text-tertiary">
                    {subType === 'gigabytes'
                      ? 'You pay only for the data you send and receive. End the session when you\'re done, and what you didn\'t use comes back to your wallet when the chain settles it, about 2 hours later.'
                      : 'You pay for the time from your first connect to your last use. End the session when you\'re done, and the hours you didn\'t use come back to your wallet when the chain settles it, about 2 hours later.'}
                  </p>
                )}
                {compatiblePlans && compatiblePlans.length > 0 && (
                  <p className="text-xs text-text-tertiary">
                    This node is part of {compatiblePlans.length} plan{compatiblePlans.length === 1 ? '' : 's'}.{' '}
                    <button type="button" onClick={handleSeePlansForNode} className="text-accent hover:underline">
                      See Plans tab
                    </button>
                  </p>
                )}
              </>
            )}
            {cantAfford && funds && (
              <InsufficientFunds
                message={insufficientFundsMessage(funds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}
          </section>

          <LimitsSection title="Limits" limits={limits} />

          <OptionsSection summary={proxyCapable ? `${modeSummary(mode)} · node details` : 'Node details'}>
            {proxyCapable && <ModeField mode={mode} onChange={setMode} />}
            <div className="space-y-1.5">
              <div className="text-xs text-text-secondary">Node details</div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                {/* Full address, not truncated: it is the node's on-chain identity and
                    the only way to tell two nodes of the same operator apart. */}
                <dt className="text-text-tertiary">Address</dt>
                <dd className="flex items-start gap-2 min-w-0">
                  <span className="text-text-secondary font-mono break-all select-text">{node.address}</span>
                  <CopyButton value={node.address} label="Copy address" />
                </dd>
                {/* host:port the node advertises. Usually already an IPv4 literal; when
                    it is a hostname the tunnel pins it to an IP at connect time. */}
                <dt className="text-text-tertiary">Endpoint</dt>
                <dd className="flex items-start gap-2 min-w-0">
                  <span className="text-text-secondary font-mono break-all select-text">{node.api}</span>
                  <CopyButton value={node.api} label="Copy endpoint" />
                </dd>
                <dt className="text-text-tertiary">Location</dt>
                <dd className="text-text-secondary">
                  {node.country}{node.city ? `, ${node.city}` : ''}
                  {node.asn ? <span className="font-mono ml-2">AS{node.asn}</span> : null}
                </dd>
                <dt className="text-text-tertiary">Protocol</dt>
                <dd className={`flex items-center gap-1.5 ${protocol.color}`}>
                  <ProtocolIcon type={node.type} />
                  {protocol.label}
                  {(node.type === 2 || node.type === 4) && node.connection && 'proxy' in node.connection && (
                    <span className="font-mono text-text-tertiary">
                      {node.connection.proxy} / {node.connection.transport} / {node.connection.security}
                    </span>
                  )}
                </dd>
                {node.version && (
                  <>
                    <dt className="text-text-tertiary">Version</dt>
                    <dd className="text-text-secondary font-mono">{node.version}</dd>
                  </>
                )}
              </dl>
            </div>
          </OptionsSection>
        </>
      )}

      {onThisNode && !connecting && !tunnelConnected && (
        <div className="space-y-1.5 text-sm">
          <p className="text-text-primary">This is the node your connection runs through now.</p>
          <p className="text-text-tertiary text-xs font-mono">
            Session #{status.sessionId ?? '?'} · {protocol.label}
          </p>
        </div>
      )}

      {connecting && (
        <div className="space-y-4">
          <StepList
            stages={steps}
            current={Math.max(0, steps.findIndex((s) => s.id === currentStep))}
            detail={stepDetail}
          />
          <p className="text-text-tertiary text-xs">
            Leave this open. If the handshake fails, the session is cancelled and refunded automatically.
          </p>
        </div>
      )}

      {error && !connecting && (
        <ConnectErrorActions
          error={error}
          paidSessionId={paidProtocol ? sessionId : null}
          onRetryTunnel={() => retryTunnel()}
          onRetryPurchase={() => void retryPurchase()}
          onStartOver={reset}
          onRetryWithoutDns={paidProtocol ? () => retryTunnel(true) : undefined}
          goBack={switching?.left ? { from: switching.from, onDone: onClose } : null}
        />
      )}

      {tunnelConnected && sessionId && (
        <div className="space-y-1.5">
          <p className="text-text-primary">
            Sites now see you in {node.city ? `${node.city}, ` : ''}{node.country}.
          </p>
          <p className="text-text-tertiary text-xs font-mono">Session #{sessionId} · {protocol.label}</p>
          {effectiveMode === 'proxy' ? (
            <p className="text-text-tertiary text-xs">
              SOCKS5 proxy at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only apps
              configured to use it are tunneled. The rest of your traffic still goes out directly.
            </p>
          ) : node.type === 1 ? (
            <p className="text-text-tertiary text-xs">
              WireGuard interface is up. Your traffic is now routed through this node.
            </p>
          ) : null}
        </div>
      )}
    </ReviewModal>
  )
}
