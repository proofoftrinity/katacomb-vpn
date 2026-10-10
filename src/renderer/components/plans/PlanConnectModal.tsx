import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlanInfo, SentNode, SmartConnectResult } from '../../types'
import { useConnectFlow } from '../../hooks/useConnectFlow'
import { useConnection } from '../../hooks/useConnection'
import { useNodesContext } from '../../contexts/NodesContext'
import { usePlansContext } from '../../contexts/PlansContext'
import { useNavigation } from '../../contexts/NavigationContext'
import { useBalance } from '../../hooks/useBalance'
import { checkFunds, formatP2pCeil, insufficientFundsMessage } from '../../../shared/funds'
import { planPriceDisplay, formatBytes, formatDuration } from '../../utils/format'
import { protocolMeta, isProtocolSupported, isProxyCapable } from '../../utils/protocols'
import { nodeStatusMeta, isNodeConnectable } from '../../utils/node-status'
import { SOCKS_DISPLAY_ADDR } from '../../../shared/socks'
import { versionSignsReplies } from '../../../shared/node-signing'
import ConnectErrorActions from '../ConnectErrorActions'
import InsufficientFunds from '../InsufficientFunds'
import CountryFlag from '../CountryFlag'
import Spinner from '../Spinner'
import RouteStrip, { singleHopStep, type RouteHop, type RouteStage } from '../RouteStrip'
import {
  ChecksSection, FooterReason, LimitsSection, ModeField, Note, OptionsSection,
  Receipt, ReceiptLine, ReviewModal, SectionHead, Segmented, StepList, VpnConfirm,
  dnsCheck, encryptionCheck, keysLimit, modeSummary, otherVpnCheck, seesBothLimit, signingCheck, switchCheck, useActiveWalletName,
  useOtherVpns, useReviewSettings, type CheckSpec, type Limit,
} from '../ConnectReview'
import { connectionRelation, isLive, previousConnection, switchFooterText, type SwitchTarget } from '../../utils/switch'

interface Props {
  plan: PlanInfo
  /** Present = start a session on this existing subscription (gas only). */
  subscriptionId?: string
  /** Open with the manual node picker already expanded. */
  startManual?: boolean
  /**
   * Begin the smart connect the moment the modal opens. Honoured on the reuse
   * flow only: a fresh subscribe spends the plan price and keeps its confirm.
   */
  autoStart?: boolean
  onClose: () => void
}

/**
 * The RenewalPricePolicy values the UI offers. 0 is the hub's own "never
 * renew"; 7 renews at any price and is the chain default.
 */
const RENEWAL_OPTIONS = [
  { value: 7, label: 'Renew automatically' },
  { value: 0, label: 'Never renew' },
]

/**
 * Progress for a smart connect: the plan:* markers main emits, in order, plus
 * the shared tunnel step. The manual path reuses the same renderer with its
 * two honest stages (no invented "broadcasting subscription tx" on a reuse).
 */
function stagesFor(kind: 'smart-fresh' | 'smart-reuse' | 'manual-fresh' | 'manual-reuse'): { id: string; label: string }[] {
  switch (kind) {
    case 'smart-fresh':
      return [
        { id: 'plan:rank', label: 'Finding the best node' },
        { id: 'plan:buy', label: 'Buying the plan' },
        { id: 'plan:handshake', label: 'Handshaking with the node' },
        { id: '5/5', label: 'Starting the tunnel' },
      ]
    case 'smart-reuse':
      return [
        { id: 'plan:rank', label: 'Finding the best node' },
        { id: 'plan:session', label: 'Starting a session on your subscription' },
        { id: 'plan:handshake', label: 'Handshaking with the node' },
        { id: '5/5', label: 'Starting the tunnel' },
      ]
    case 'manual-fresh':
      return [
        { id: '1/5', label: 'Buying the plan and starting a session' },
        { id: '5/5', label: 'Starting the tunnel' },
      ]
    case 'manual-reuse':
      return [
        { id: '1/5', label: 'Starting a session on your subscription' },
        { id: '5/5', label: 'Starting the tunnel' },
      ]
  }
}

/**
 * ONE connect modal for both plan flows: fresh subscribe (plan price) and
 * session-on-existing-subscription (gas only). Smart connect is the primary
 * path; "Choose myself" expands the manual picker. Carries the four safety
 * features the old plan modals lacked: the other-VPN pre-check, the
 * switch away from a live connection, the unhealthy-node acknowledgement, and local
 * proxy mode. Laid out like the other two connect windows (ConnectReview): the
 * route first, with the node filled in once one is chosen, then the node choice,
 * the checks, the cost and the limits, and a footer that names what stops Pay.
 */
export default function PlanConnectModal({ plan, subscriptionId, startManual = false, autoStart = false, onClose }: Props) {
  const isReuse = subscriptionId !== undefined
  const { status } = useConnection()
  const tunnelUp = isLive(status)
  const { allNodes } = useNodesContext()
  const { refreshOverview } = usePlansContext()
  const { setMainTab } = useNavigation()
  const { udvpn, refresh: refreshBalance, refreshing: refreshingBalance } = useBalance()
  const {
    connecting, currentStep, stepDetail, error, tunnelConnected, sessionId, paidProtocol, disconnecting, switching,
    start, retryPurchase, retryTunnel, disconnect: disconnectFlow, reset,
  } = useConnectFlow()
  const settings = useReviewSettings()
  const otherVpns = useOtherVpns()
  const walletName = useActiveWalletName()

  const [manual, setManual] = useState(startManual)
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null)
  const [healthAcknowledged, setHealthAcknowledged] = useState(false)
  const [renewalPolicy, setRenewalPolicy] = useState(7)
  const [proxyMode, setProxyMode] = useState(false)
  const [vpnWarning, setVpnWarning] = useState<{ type: string; name: string; iface?: string }[] | null>(null)
  // The plan's linked node addresses, for the manual picker. null = loading.
  const [planNodeAddrs, setPlanNodeAddrs] = useState<string[] | null>(null)
  // Main answered null: it could not read the list (nothing cached), which is
  // not the same statement as a plan with no nodes.
  const [planNodesUnknown, setPlanNodesUnknown] = useState(false)
  const [smartResult, setSmartResult] = useState<SmartConnectResult | null>(null)
  // Which flow the current attempt runs, for honest progress labels.
  const [kind, setKind] = useState<'smart-fresh' | 'smart-reuse' | 'manual-fresh' | 'manual-reuse'>(
    isReuse ? 'smart-reuse' : 'smart-fresh',
  )

  const price = planPriceDisplay(plan.prices)
  // The fresh subscribe charges the plan price; only udvpn is known here. A
  // reuse costs gas only. null while the balance is unreadable: never block
  // the pay button on a balance we couldn't read.
  const costUdvpn = isReuse ? 0 : (price.udvpn ?? 0)
  const funds = udvpn === null ? null : checkFunds(udvpn, costUdvpn)
  const cantAfford = funds !== null && !funds.ok
  const denom = plan.prices.find((p) => p.denom === 'udvpn')?.denom ?? plan.prices[0]?.denom ?? 'udvpn'

  // Manual picker data: the plan's nodes joined against the node directory.
  useEffect(() => {
    if (!manual || planNodeAddrs !== null) return
    let cancelled = false
    window.api.planNodes(plan.id)
      .then((addrs) => {
        if (cancelled) return
        setPlanNodeAddrs(addrs ?? [])
        setPlanNodesUnknown(addrs === null)
      })
      .catch(() => { if (!cancelled) { setPlanNodeAddrs([]); setPlanNodesUnknown(true) } })
    return () => { cancelled = true }
  }, [manual, planNodeAddrs, plan.id])

  // Auto-start decides once, from first-render values: anything that blocks it
  // (a tunnel up, gas the wallet can't cover, a fresh subscribe) shows the idle
  // form instead. A tunnel up is the opener's to rule out: this modal's own status
  // reads idle until its first poll lands, so `tunnelUp` here is only a backstop
  // for a connection that was already reported. The decision must exist DURING
  // the first render, not only in the effect: effects run after paint, and the
  // other-VPN IPC check runs before start() flips `connecting`, so gating the
  // form on `connecting` alone flashed it for that whole window. Cleared when the attempt settles,
  // which is what brings the form back after Cancel on the other-VPN warning.
  // The ref keeps StrictMode's dev double-mount to one attempt.
  const [autoStarting, setAutoStarting] = useState(
    () => autoStart && isReuse && !tunnelUp && !cantAfford,
  )
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStarting || autoStartedRef.current) return
    autoStartedRef.current = true
    void handleSmartConnect().finally(() => setAutoStarting(false))
  }, [])

  const nodeIndex = useMemo(() => new Map(allNodes.map((n) => [n.address, n])), [allNodes])
  const manualRows = useMemo(() => {
    if (planNodeAddrs === null) return null
    const rows = planNodeAddrs.map((addr) => ({ addr, node: nodeIndex.get(addr) ?? null }))
    // Directory-known, healthy rows first; unknown addresses stay visible but unclickable.
    rows.sort((a, b) => {
      const rank = (r: { node: SentNode | null }) =>
        r.node === null ? 2 : isNodeConnectable(r.node) ? 0 : 1
      return rank(a) - rank(b) || a.addr.localeCompare(b.addr)
    })
    return rows
  }, [planNodeAddrs, nodeIndex])
  const selectedNode = selectedAddr ? nodeIndex.get(selectedAddr) ?? null : null

  // What Pay would connect to, measured against the live connection ([RN-10]): the
  // picked node, or (smart) the subscription. A fresh subscribe, or a manual pick not
  // made yet, can only be a switch while connected.
  const target: SwitchTarget | null = manual
    ? (selectedNode ? { node: selectedNode.address } : null)
    : (subscriptionId !== undefined ? { subscriptionId } : null)
  const relation = target ? connectionRelation(status, target) : tunnelUp ? 'switch' : 'idle'
  const switchFrom = relation === 'switch' ? previousConnection(status) : null

  function handleProxyModeChange(checked: boolean) {
    setProxyMode(checked)
    // Choosing proxy mode makes a selected non-proxy node ineligible: clear it so
    // the greyed-out row and the connect button agree.
    if (checked && selectedNode && !isProxyCapable(selectedNode.type)) setSelectedAddr(null)
  }

  async function checkOtherVpns(): Promise<boolean> {
    if (vpnWarning) {
      // Second press = Continue anyway.
      setVpnWarning(null)
      return true
    }
    try {
      const others = await window.api.connectionCheckVpn()
      if (others.length > 0) {
        setVpnWarning(others)
        return false
      }
    } catch { /* proceed if the check fails */ }
    return true
  }

  async function handleSmartConnect() {
    if (!(await checkOtherVpns())) return
    setKind(isReuse ? 'smart-reuse' : 'smart-fresh')
    setSmartResult(null)
    await start(async () => {
      const res = await window.api.planSmartConnect({
        planId: plan.id,
        ...(isReuse ? { subscriptionId } : { denom, renewalPolicy }),
        ...(proxyMode ? { requireProxyCapable: true } : {}),
      })
      setSmartResult(res)
      void refreshOverview()
      return res
    }, { mode: proxyMode ? 'proxy' : 'tunnel', switchFrom })
  }

  async function handleManualConnect() {
    if (!selectedNode) return
    if (!(await checkOtherVpns())) return
    setKind(isReuse ? 'manual-reuse' : 'manual-fresh')
    setSmartResult(null)
    const node = selectedNode
    // The picker refuses non-proxy nodes in proxy mode, so proxyMode alone decides
    // the mode (it used to be silently ignored for such nodes).
    await start(async () => {
      const params = {
        nodeAddress: node.address,
        nodeMoniker: node.moniker,
        nodeCountry: node.country,
        nodeType: node.type,
        apiField: node.api,
        ...(proxyMode ? { proxyMode: true } : {}),
      }
      const res = isReuse
        ? await window.api.planStartSessionFromSub({ subscriptionId, planId: plan.id, ...params })
        : await window.api.planSubscribe({ planId: plan.id, denom, renewalPolicy, ...params })
      void refreshOverview()
      return res
    }, { mode: proxyMode ? 'proxy' : 'tunnel', switchFrom })
  }

  async function handleDisconnect() {
    if (await disconnectFlow()) onClose()
  }

  function handleOpenMultihop() {
    setMainTab('multihop')
    onClose()
  }

  // The node the route runs through: the one smart connect settled on, the one
  // picked by hand, or a placeholder until either exists.
  const routeNode: RouteHop = smartResult
    ? nodeIndex.get(smartResult.node.address) ?? { country: smartResult.node.country, moniker: smartResult.node.moniker }
    : manual && selectedNode
      ? selectedNode
      : { country: '', name: manual ? 'Pick a node' : 'Best node', moniker: `in plan #${plan.id}` }

  const connectedNodeLabel = smartResult
    ? `${smartResult.node.moniker} (${smartResult.node.country})`
    : selectedNode
      ? `${selectedNode.moniker} (${selectedNode.country})`
      : null

  // Auto-start's pre-check window, before start() flips `connecting`: the
  // progress list renders from the first frame so the idle form never flashes,
  // and the modal must not be closable, or a purchase could outlive it.
  const preStart = autoStarting && !connecting && !error && !tunnelConnected && !vpnWarning

  const title = tunnelConnected
    ? 'Connected'
    : connecting || preStart
      ? 'Connecting'
      : error
        ? (paidProtocol ? 'The tunnel did not come up' : 'Not connected')
        : isReuse
          ? `Connect via plan #${plan.id}`
          : `Subscribe to plan #${plan.id}`

  const showForm = !connecting && !error && !tunnelConnected && !autoStarting

  const stage: RouteStage = tunnelConnected
    ? { kind: 'active' }
    : connecting || preStart
      ? { kind: 'building', step: singleHopStep(currentStep) }
      : error && paidProtocol
        ? { kind: 'failed' }
        : { kind: 'review' }

  const checks: CheckSpec[] = [
    ...[switchCheck(switchFrom, settings)].filter((c): c is CheckSpec => c !== null),
    ...(manual && selectedNode ? [encryptionCheck(selectedNode)] : []),
    ...[manual && selectedNode ? signingCheck(selectedNode) : null, dnsCheck(settings, proxyMode ? 'proxy' : 'tunnel', 'the node'), otherVpnCheck(otherVpns)]
      .filter((c): c is CheckSpec => c !== null),
  ]

  const priceLabel = price.amount ? `${price.amount} ${price.denomLabel}` : ''
  const blocker: { text: string; tone: 'danger' | 'muted' } | null =
    relation === 'same'
      ? {
          text: manual
            ? 'You are connected to this node already.'
            : 'This plan is serving your connection now. Choose myself to move to another of its nodes.',
          tone: 'muted',
        }
      : cantAfford && funds
        ? { text: `Not enough P2P: short by ${formatP2pCeil(funds.shortfall)}, fees included.`, tone: 'danger' }
        : manual && !selectedNode
          ? { text: 'Pick a node from the list above.', tone: 'muted' }
          : null

  const footer = showForm ? (
    vpnWarning ? (
      <VpnConfirm
        vpns={vpnWarning}
        onContinue={() => void (manual ? handleManualConnect() : handleSmartConnect())}
        onCancel={() => setVpnWarning(null)}
        disabled={cantAfford}
      />
    ) : (
      <>
        {blocker
          ? <FooterReason text={blocker.text} tone={blocker.tone} />
          : switchFrom && <FooterReason text={switchFooterText(switchFrom)} tone="muted" />}
        <button
          onClick={() => void (manual ? handleManualConnect() : handleSmartConnect())}
          disabled={blocker !== null}
          className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {isReuse
            ? (switchFrom
                ? (manual ? 'Switch to this node' : 'Switch to this plan')
                : (manual ? 'Connect to this node' : 'Connect'))
            : `Pay ${priceLabel} and ${switchFrom ? 'switch' : 'connect'}${manual ? ' to this node' : ''}`}
        </button>
      </>
    )
  ) : tunnelConnected && sessionId ? (
    <div className="flex gap-2">
      <button
        onClick={handleDisconnect}
        disabled={disconnecting}
        className="btn btn-danger flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {disconnecting ? 'Disconnecting…' : 'Disconnect'}
      </button>
      <button onClick={onClose} className="btn btn-primary flex-1">
        Done
      </button>
    </div>
  ) : undefined

  const stages = [
    ...(switching ? [{ id: 'switch', label: `Disconnecting from ${switching.from.label}` }] : []),
    ...stagesFor(kind),
  ]
  // '1/5' arrives before any plan:* marker on the smart path: treat it as the first
  // stage after the switch (when there is one).
  const found = stages.findIndex((s) => s.id === currentStep)
  const stageIndex = found === -1 ? (switching ? 1 : 0) : found

  return (
    // Fixed height on purpose: this modal cycles through states of very different
    // sizes (smart form, node picker, progress list, warnings) and resizing on every
    // transition made it jumpy. Long states scroll inside, under a footer that stays.
    <ReviewModal
      title={title}
      subtitle={
        <>
          {formatBytes(plan.bytes)} for {formatDuration(plan.durationSeconds)}
          {isReuse
            ? ', already paid. Starting a session costs gas only.'
            : priceLabel
              ? `, ${priceLabel}.`
              : '.'}
        </>
      }
      closable={!connecting && !preStart}
      onClose={onClose}
      footer={footer}
      className="max-w-xl h-[640px]"
    >
      <RouteStrip
        hops={[routeNode]}
        stage={stage}
        info={showForm ? {
          label: 'What the node can see',
          text: 'Your device connects straight to the node, so it sees your IP address. Your traffic also leaves for the internet from it, so it sees which sites you visit. HTTPS keeps what you send from it, not where you send it.',
        } : undefined}
      />

      {showForm && (
        <>
          <section className="space-y-2.5">
            <SectionHead title="Node">
              <Segmented
                label="How the node is chosen"
                value={manual ? 'manual' : 'smart'}
                options={[['smart', 'Pick for me'], ['manual', 'Choose myself']]}
                onChange={(v) => setManual(v === 'manual')}
              />
            </SectionHead>
            {!manual ? (
              <p className="text-text-tertiary text-xs">
                Smart connect checks the plan's nodes and picks the fastest healthy one. If the
                first choice fails, the next is tried without paying the plan price again.
              </p>
            ) : manualRows === null ? (
              <div className="flex items-center gap-2 text-text-tertiary text-sm">
                <Spinner /> Loading the plan's nodes...
              </div>
            ) : manualRows.length === 0 ? (
              <p className="text-text-secondary text-sm">
                {planNodesUnknown
                  ? (tunnelUp
                    ? "The plan's node list can't be read through the VPN, and none was saved earlier. Pick for me reads it after disconnecting."
                    : "Could not read the plan's node list right now.")
                  : 'No nodes are linked to this plan right now.'}
              </p>
            ) : (
              <>
                <div className="max-h-48 overflow-y-auto border border-border rounded-md divide-y divide-border">
                  {manualRows.map(({ addr, node }) => {
                    const meta = node ? nodeStatusMeta(node) : null
                    const proxyBlocked = proxyMode && node !== null && !isProxyCapable(node.type)
                    const clickable = node !== null &&
                      isProtocolSupported(node.type) &&
                      !proxyBlocked &&
                      (isNodeConnectable(node) || (meta?.state === 'unhealthy' && healthAcknowledged))
                    return (
                      <button
                        key={addr}
                        type="button"
                        disabled={!clickable}
                        title={proxyBlocked ? 'Not available in local proxy mode, needs v2ray, xray or hysteria2' : undefined}
                        onClick={() => setSelectedAddr(addr)}
                        className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                          selectedAddr === addr ? 'bg-accent-subtle' : 'hover:bg-bg-tertiary'
                        } ${clickable ? '' : 'opacity-40 cursor-not-allowed'}`}
                      >
                        {node && <CountryFlag country={node.country} />}
                        <span className="text-text-primary flex-1 truncate">
                          {node ? node.moniker : `${addr.slice(0, 16)}...`}
                        </span>
                        {node && (
                          <span className={`text-xs ${protocolMeta(node.type).color}`}>
                            {protocolMeta(node.type).short}
                          </span>
                        )}
                        {meta && <span className={`status-dot ${meta.dotClass}`} title={meta.label} />}
                      </button>
                    )
                  })}
                </div>
                {manualRows.some((r) => r.node && nodeStatusMeta(r.node).state === 'unhealthy') && (
                  <label className="flex items-start gap-2 cursor-pointer text-xs text-text-secondary">
                    <input
                      type="checkbox"
                      checked={healthAcknowledged}
                      onChange={(e) => setHealthAcknowledged(e.target.checked)}
                      className="accent-accent mt-0.5"
                    />
                    <span>
                      Allow nodes that last failed the network health check. That check can be
                      hours out of date; a failed handshake is cancelled and refunded automatically.
                    </span>
                  </label>
                )}
              </>
            )}
          </section>

          {checks.length > 0 && <ChecksSection title="Checks" checks={checks} />}

          <section className="space-y-2.5">
            <SectionHead title="Cost" />
            <Receipt>
              {isReuse ? (
                <ReceiptLine
                  country=""
                  label={`Plan #${plan.id}`}
                  payer={`subscription #${subscriptionId}`}
                  detail="Already paid. A session costs the network fee only."
                  amount="network fee only"
                  funds={funds}
                />
              ) : (
                <ReceiptLine
                  country=""
                  label={`Plan #${plan.id}`}
                  payer={walletName}
                  detail={`${formatBytes(plan.bytes)} for ${formatDuration(plan.durationSeconds)}`}
                  amount={priceLabel || null}
                  funds={price.udvpn === null ? null : funds}
                />
              )}
            </Receipt>
            {!isReuse && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="text-text-secondary">Renewal</span>
                <select
                  value={renewalPolicy}
                  onChange={(e) => setRenewalPolicy(parseInt(e.target.value, 10))}
                  className="bg-bg-tertiary border border-border text-text-primary text-sm px-2 py-1 rounded-sm focus:outline-none focus:border-border-focus"
                >
                  {RENEWAL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            )}
            {!isReuse && price.udvpn === null && price.amount && (
              <Note>
                This plan is priced in {price.denomLabel}, which this app cannot check your balance
                for. The chain will reject the purchase if the wallet cannot pay.
              </Note>
            )}
            {cantAfford && funds && (
              <InsufficientFunds
                message={insufficientFundsMessage(funds)}
                onRefresh={refreshBalance}
                refreshing={refreshingBalance}
              />
            )}
          </section>

          {/* Smart connect has not picked a node yet, so whether it signs is unknown
              until "Choose myself" names one. If the node it picks is listed as
              signing, main requires the signature like anywhere else. */}
          <LimitsSection
            title="Limits"
            limits={[
              seesBothLimit(handleOpenMultihop),
              ...[keysLimit({
                subject: 'node',
                signs: manual && selectedNode ? versionSignsReplies(selectedNode.version) : null,
              })].filter((l): l is Limit => l !== null),
            ]}
          />

          <OptionsSection summary={modeSummary(proxyMode ? 'proxy' : 'tunnel')}>
            <ModeField mode={proxyMode ? 'proxy' : 'tunnel'} onChange={(m) => handleProxyModeChange(m === 'proxy')} />
            {proxyMode && (
              <p className="text-text-tertiary text-xs">Only nodes running v2ray, xray or hysteria2 can serve a local proxy.</p>
            )}
          </OptionsSection>
        </>
      )}

      {(connecting || preStart) && (
        <StepList stages={stages} current={stageIndex} detail={stepDetail} />
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
            Sites now see you in {routeNode.city ? `${routeNode.city}, ` : ''}{routeNode.country || 'the node\'s country'}.
          </p>
          <p className="text-text-tertiary text-xs font-mono">
            Session #{sessionId}{connectedNodeLabel ? ` · ${connectedNodeLabel}` : ''}
          </p>
          {smartResult && smartResult.attempts.length > 0 && (
            <p className="text-text-tertiary text-xs">
              Skipped {smartResult.attempts.length} node{smartResult.attempts.length === 1 ? '' : 's'}:{' '}
              {smartResult.attempts.map((a) => a.moniker).join(', ')}
            </p>
          )}
          {proxyMode && (
            <p className="text-text-tertiary text-xs">
              SOCKS5 proxy at <span className="font-mono text-text-secondary">{SOCKS_DISPLAY_ADDR}</span>. Only
              apps configured to use it are tunneled.
            </p>
          )}
        </div>
      )}
    </ReviewModal>
  )
}
