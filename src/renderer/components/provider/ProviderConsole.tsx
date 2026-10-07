import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ProviderState } from '../../hooks/useProvider'
import { useConnection } from '../../hooks/useConnection'
import { useRpcHealth } from '../../hooks/useRpcHealth'
import { isChainUnreachable } from '../../../shared/rpc-health'
import { providerDetailsProblem } from '../../../shared/provider-details'
import { displayConnectError } from '../../utils/connect-errors'
import { STATUS_ACTIVE, formatUdvpn } from '../../utils/provider-format'
import { providerSetupSteps, setupComplete, type SetupStep } from '../../utils/provider-setup'
import type { ProviderDetailsInput } from '../../types'
import ChainUnreachable from '../ChainUnreachable'
import { useConfirm } from '../ConfirmModal'
import ProviderDetailsFields from './ProviderDetailsFields'
import ProviderIdentityCard, { useProviderStatus } from './ProviderIdentityCard'
import { AlertIcon, CheckIcon } from '../Icons'
import ProviderPlans from './ProviderPlans'
import type { NodeActionState } from './PlanNodesManager'

/**
 * The Provider tab.
 *
 * Renders whatever the chain currently says, and offers the single next action —
 * there is no local wizard state. The flows are multi-transaction (register →
 * activate, create → activate, lease → link) and each step is its own tx, so a
 * failure part-way through just leaves a row showing the step that still needs
 * doing rather than a stuck or orphaned state. The setup path strip is the same
 * idea made visible: derived from chain state on every render, never stored.
 *
 * While the VPN tunnel is up the tab renders main's cached overview read-only
 * (`stale`), with every mutation disabled — the chain is unreachable through our
 * own tunnel, so writes would only fail late.
 */
export default function ProviderConsole({
  provider,
  plans,
  leases,
  economics,
  stale,
  fetchedAt,
  loading,
  error,
  refresh,
  nodeAction,
}: ProviderState & {
  /** Owned by App so a Link or Unlink survives this tab being switched away from. */
  nodeAction: NodeActionState
}) {
  const { status: connStatus } = useConnection()
  const { state: rpcState } = useRpcHealth()
  const tunnelUp = connStatus.state === 'connected' || connStatus.state === 'reconnecting'
  // stale marks the DATA; tunnelUp closes the gap before the stale re-read lands.
  const readOnly = stale || tunnelUp

  // Per-plan linked-node counters live in ProviderPlans, but the setup path needs
  // their total, so the confirmed count is lifted here. null = not confirmed.
  const [confirmedLinkedNodes, setConfirmedLinkedNodes] = useState<number | null>(null)
  // One status control for the bar's button and the workspace's "Activate provider".
  const status = useProviderStatus(plans, leases, refresh)

  // The first read, in the shape of the tab it becomes: the bar, the plan list and
  // the Overview. A re-read keeps the previous render, so this shows only once.
  if (loading && !provider) {
    return (
      <div className="h-full flex flex-col overflow-hidden" role="status" aria-label="Reading your provider from the chain">
        <div className="border-b border-border bg-bg-secondary px-5 py-3 shrink-0 flex items-center gap-3.5">
          <span className="skeleton h-2 w-2 rounded-full" />
          <span className="skeleton h-4 w-36" />
          <span className="skeleton h-3 w-24" />
          <span className="skeleton h-3 w-44 ml-auto" />
          <span className="skeleton h-6 w-20" />
        </div>
        <div className="flex-1 flex min-h-0">
          <div className="w-[260px] min-[1180px]:w-[300px] shrink-0 border-r border-border">
            <div className="px-4 py-3 border-b border-border"><span className="skeleton block h-3.5 w-24" /></div>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="px-4 py-2.5 border-b border-border space-y-2">
                <span className="skeleton block h-3 w-4/5" />
                <span className="skeleton block h-2.5 w-3/5" />
              </div>
            ))}
          </div>
          <div className="flex-1 p-5 space-y-4">
            <span className="skeleton block h-32 rounded-md" />
            <span className="skeleton block h-40 rounded-md" />
          </div>
        </div>
      </div>
    )
  }

  if (!provider) {
    if (tunnelUp) {
      return (
        <Centered>
          <p className="text-text-secondary text-sm">
            The blockchain is not reachable through your own tunnel, and there is no cached copy of
            your provider from this session yet.
          </p>
          <p className="text-text-tertiary text-xs mt-2">Disconnect the VPN to manage your provider.</p>
        </Centered>
      )
    }
    return (
      <Centered>
        {isChainUnreachable(rpcState)
          ? <ChainUnreachable what="your provider" />
          : (
            <div className="space-y-3">
              <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2 text-left">
                <p className="text-danger text-xs">{displayConnectError(error ?? 'Could not read your provider')}</p>
              </div>
              <button type="button" onClick={() => void refresh()} className="btn btn-secondary text-xs py-1.5 px-4">
                Retry
              </button>
            </div>
          )}
      </Centered>
    )
  }

  const active = provider.status === STATUS_ACTIVE
  const steps = providerSetupSteps({
    registered: provider.registered,
    active,
    planCount: plans.length,
    activePlanCount: plans.filter((p) => p.status === STATUS_ACTIVE).length,
    leaseCount: leases.length,
    confirmedLinkedNodes,
  })

  if (!provider.registered) {
    return <ProviderOnboarding address={provider.address} steps={steps} readOnly={readOnly} onRegistered={refresh} />
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <ProviderIdentityCard
        provider={provider}
        economics={economics}
        stale={readOnly}
        fetchedAt={fetchedAt}
        status={status}
        onRefresh={refresh}
        onChanged={refresh}
      />
      {readOnly ? (
        <div className="px-5 py-1.5 border-b border-border bg-warning-subtle shrink-0">
          <p className="text-warning text-xs">
            Showing cached data: the chain is not reachable while the VPN is connected. Reads stay
            available, actions need you to disconnect first.
          </p>
        </div>
      ) : !setupComplete(steps) && (
        // Shown only while incomplete. An inactive provider always lands here, since
        // Activate is one of the steps, which is what replaced the separate banner.
        <div className="px-5 py-3 border-b border-border shrink-0">
          <SetupRoute steps={steps} />
        </div>
      )}
      <ProviderPlans
        plans={plans}
        leases={leases}
        providerActive={active}
        readOnly={readOnly}
        providerName={provider.name}
        economics={economics}
        onChanged={refresh}
        onLinkedNodesCounted={setConfirmedLinkedNodes}
        nodeAction={nodeAction}
        onActivateProvider={() => void status.setStatus(true)}
        activatingProvider={status.pendingTarget === true}
      />
      {status.confirmDialog}
    </div>
  )
}

// Written out in full for Tailwind: the Multi-hop route's discs and links, so the
// setup path reads as the same kind of picture (global.css .route-disc / .route-link).
const STEP_DISC: Record<SetupStep['state'], string> = {
  done: 'route-disc route-disc-ok',
  next: 'route-disc route-disc-done',
  unknown: 'route-disc route-disc-waiting',
  later: 'route-disc route-disc-waiting',
}
const STEP_LABEL: Record<SetupStep['state'], string> = {
  done: 'text-text-tertiary',
  next: 'text-text-primary font-medium',
  unknown: 'text-text-tertiary',
  later: 'text-text-tertiary',
}
const LINK_LIT = 'route-link route-link-lit'
const LINK_DIM = 'route-link route-link-dim'

/**
 * The provider lifecycle as a route, one disc per step, recomputed from chain state on
 * every render: the guided flow, without any stored progress to get out of sync. The
 * line under it says what the next step is. Activate is the step that blocks the rest,
 * so while it is next the line is amber: it replaced the "Your provider is inactive"
 * banner.
 */
function SetupRoute({ steps }: { steps: SetupStep[] }) {
  const next = steps.find((s) => s.state === 'next')
  return (
    <div>
      <div role="list" aria-label="Provider setup" className="flex items-center max-w-4xl">
        {steps.map((step, i) => (
          <Fragment key={step.key}>
            {i > 0 && (
              <span className={`${steps[i - 1].state === 'done' ? LINK_LIT : LINK_DIM} flex-1 min-w-[14px] mx-2`} />
            )}
            <span role="listitem" className="flex items-center gap-2 shrink-0" title={step.detail}>
              <span className={`${STEP_DISC[step.state]} w-6 h-6`}>
                {step.state === 'done' ? <CheckIcon className="w-3 h-3 text-success" />
                  : step.state === 'unknown' ? <AlertIcon className="w-3 h-3 text-warning" />
                    : <span className={`font-mono text-[11px] ${step.state === 'next' ? 'text-accent' : ''}`}>{i + 1}</span>}
              </span>
              <span className={`text-xs whitespace-nowrap ${STEP_LABEL[step.state]}`}>{step.label}</span>
            </span>
          </Fragment>
        ))}
      </div>
      {next && (
        <p className={`text-xs mt-2 ${next.key === 'activate' ? 'text-warning' : 'text-text-secondary'}`}>
          Next: {next.detail}
        </p>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center px-8">
      <div className="max-w-md text-center">{children}</div>
    </div>
  )
}

const EMPTY_DETAILS: ProviderDetailsInput = { name: '', identity: '', website: '', description: '' }

type DepositState = 'loading' | 'failed' | { denom: string; amount: string }

/**
 * Pre-registration screen. Shows the deposit read live from the chain's own
 * params — it is a governance value (0 udvpn today), and unlike a node session
 * deposit it is sent to the community pool, so it is spent for good.
 *
 * Registration is refused until the deposit has actually been read: a money
 * confirmation must never show "Deposit: …" with the figure missing.
 */
function ProviderOnboarding({ address, steps, readOnly, onRegistered }: {
  address: string
  steps: SetupStep[]
  readOnly: boolean
  onRegistered: () => void
}) {
  const [details, setDetails] = useState<ProviderDetailsInput>(EMPTY_DETAILS)
  const [deposit, setDeposit] = useState<DepositState>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  const loadDeposit = useCallback(() => {
    setDeposit('loading')
    // providerDeposit answers null while the VPN is up; both that and a rejection
    // land on 'failed', which blocks the register button rather than pricing the
    // registration as free or as an ellipsis.
    window.api.providerDeposit()
      .then((d) => setDeposit(d ?? 'failed'))
      .catch(() => setDeposit('failed'))
  }, [])

  useEffect(() => {
    loadDeposit()
  }, [loadDeposit])

  const depositKnown = typeof deposit === 'object'
  const depositLabel = depositKnown ? formatUdvpn(deposit.amount) : deposit === 'loading' ? '…' : 'unavailable'
  // Same rule the chain applies, so a name that is 64 characters but 80 bytes
  // fails here instead of after the deposit is spent.
  const problem = providerDetailsProblem(details, { requireName: true })

  async function handleRegister() {
    if (!depositKnown) return
    if (problem) {
      setError(problem)
      return
    }
    if (!(await requestConfirm({
      title: `Register "${details.name.trim()}" as a provider?`,
      body: [
        `Deposit: ${depositLabel} (plus network fee). The deposit goes to the community pool and is NOT refundable.`,
        'You will land inactive: a second transaction activates you, and until then the chain refuses to create plans or start leases.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'Register',
    }))) return

    setBusy(true)
    setError(null)
    try {
      await window.api.providerRegister({ ...details, name: details.name.trim() })
      onRegistered()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h2 className="text-text-primary text-lg font-semibold">Become a provider</h2>
          <p className="text-text-secondary text-sm mt-2 max-w-2xl">
            A provider publishes subscription plans on the Sentinel chain. Subscribers pay you for a plan;
            you cover them with bandwidth by leasing nodes and linking those nodes to the plan.
          </p>
        </div>

        <div className="border border-border bg-bg-secondary rounded-md px-4 py-3">
          <SetupRoute steps={steps} />
        </div>

        {readOnly && (
          <div className="bg-warning-subtle border border-warning rounded-md px-3 py-2">
            <p className="text-warning text-xs">
              Registering needs the chain, which is not reachable while the VPN is connected. Disconnect first.
            </p>
          </div>
        )}

        {/* What it costs and what it binds you to on the left, the record on the right.
            They stack below 900px, where two columns would squeeze the form. */}
        <div className="grid grid-cols-1 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-6 items-start">
          <div className="space-y-4">
            <dl className="border border-border bg-bg-secondary rounded-md divide-y divide-border text-sm">
              <Row label="Your provider address">
                <span className="font-mono text-xs text-accent break-all">{address}</span>
              </Row>
              <Row label="Registration deposit">
                <span className="text-text-primary">{depositLabel}</span>
              </Row>
            </dl>

            {deposit === 'failed' && (
              <div className="flex items-center gap-3">
                <div className="bg-danger-subtle border border-danger rounded-md px-3 py-1.5 flex-1">
                  <p className="text-danger text-xs">
                    The registration deposit could not be read from the chain, so registering is disabled.
                  </p>
                </div>
                <button type="button" onClick={loadDeposit} className="btn btn-secondary text-xs py-1.5 px-3">
                  Retry
                </button>
              </div>
            )}

            <p className="text-text-tertiary text-xs">
              The provider address is your wallet address in provider form, and the same key signs for both.
              The deposit is set by chain governance and is paid into the community pool, so it cannot be
              reclaimed by deactivating later. There is no way to remove a provider from the chain once it
              exists, so registering is a one-way step.
            </p>
            <p className="text-text-tertiary text-xs">
              You will be inactive right after registering: a second transaction activates you. Plans can only
              go live while the provider is active.
            </p>
          </div>

          <div className="space-y-4">
            <ProviderDetailsFields details={details} onChange={setDetails} disabled={busy} />

            {error && (
              <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
                <p className="text-danger text-xs">{displayConnectError(error)}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handleRegister}
              disabled={busy || Boolean(problem) || !depositKnown || readOnly}
              className="btn btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
              title={problem ?? undefined}
            >
              {busy ? 'Registering…' : depositKnown ? `Register provider (${depositLabel})` : 'Register provider'}
            </button>
          </div>
        </div>
      </div>
      {confirmDialog}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="text-text-secondary shrink-0">{label}</dt>
      <dd className="text-right min-w-0">{children}</dd>
    </div>
  )
}
