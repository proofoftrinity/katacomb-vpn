import { useEffect, useState } from 'react'
import type { LeaseQuote, LeaseSummary, SentNode } from '../../types'
import { RENEWAL_POLICY_OPTIONS, renewalPolicyLabel, renewalPolicyRefusal } from '../../../shared/renewal-policy'
import { displayConnectError } from '../../utils/connect-errors'
import { protocolMeta } from '../../utils/protocols'
import { formatUdvpn, formatUdvpnAmount } from '../../utils/provider-format'
import { useConfirm } from '../ConfirmModal'
import { AmountStepper, FooterReason, Note, ReviewModal, SectionHead } from '../ConnectReview'
import CountryFlag from '../CountryFlag'
import ProtocolIcon from '../ProtocolIcon'
import Spinner from '../Spinner'

/**
 * The renewal policies a lease can carry, as choices that each say what they mean.
 * Shared by the Lease and link window and this one, so the rule reads the same
 * when it is chosen and when it is changed. It replaced a native select whose
 * options only showed their meaning one at a time, under the box.
 */
export function RenewalChoice({ value, onChange, disabled }: {
  value: number
  onChange: (policy: number) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="When the hours run out" className="grid grid-cols-2 gap-2">
      {RENEWAL_POLICY_OPTIONS.map((o) => {
        const on = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`text-left flex gap-2.5 items-start rounded-md border px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              on ? 'border-accent bg-accent-subtle' : 'border-border hover:border-border-focus'
            }`}
          >
            <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
              on ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--color-bg-secondary)]' : 'border-text-tertiary'
            }`} />
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">{o.label}</span>
              <span className="block text-[11px] text-text-tertiary">{o.hint}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Everything that can be done to a lease after it is bought.
 *
 * All three actions live in one place because they are the same decision seen
 * from different angles: keep paying for this node automatically, pay for a fixed
 * stretch more, or stop. Splitting them across the row would also have hidden the
 * one fact that decides which is available, namely whether the renewal policy
 * still lets the chain renew at the node's current price.
 */
export default function LeaseManageModal({ lease, node, readOnly, onClose, onDone }: {
  lease: LeaseSummary
  node: SentNode | undefined
  /** The console went read-only (tunnel up, or the chain read failed) after this modal opened. */
  readOnly: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [quote, setQuote] = useState<LeaseQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [policy, setPolicy] = useState(lease.renewalPricePolicy)
  const [hours, setHours] = useState(lease.maxHours || 720)
  const [busy, setBusy] = useState<'policy' | 'renew' | 'end' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { requestConfirm, confirmDialog } = useConfirm()

  // One quote for the node's CURRENT hourly price: it is both what an extension
  // would cost and what the renewal policy is compared against.
  useEffect(() => {
    let cancelled = false
    window.api.leaseQuote(lease.nodeAddress, 1)
      .then((q) => { if (!cancelled) setQuote(q) })
      .catch((e: unknown) => {
        if (!cancelled) setQuoteError(e instanceof Error ? e.message : 'Could not price this node')
      })
    return () => { cancelled = true }
  }, [lease.nodeAddress])

  const validHours =
    Number.isInteger(hours) &&
    hours >= (quote?.minHours ?? 1) &&
    hours <= (quote?.maxHours ?? 720)
  const extendTotal = quote && validHours ? String(BigInt(quote.hourlyPrice) * BigInt(hours)) : null

  // The chain applies this to a hand-sent MsgRenewLease exactly as it does to the
  // automatic one, so an Extend button that ignored it would just buy a rejection.
  const refusal = quote ? renewalPolicyRefusal(lease.renewalPricePolicy, quote.hourlyPrice, lease.hourlyPrice) : null

  async function act(kind: 'policy' | 'renew' | 'end', run: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    try {
      await run()
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  async function handlePolicy() {
    if (!(await requestConfirm({
      title: `Change the renewal policy on lease #${lease.id}?`,
      body: [
        `From "${renewalPolicyLabel(lease.renewalPricePolicy)}" to "${renewalPolicyLabel(policy)}".`,
        'This is an on-chain transaction, and costs the network fee only.',
      ],
      confirmLabel: 'Change policy',
    }))) return
    await act('policy', () => window.api.leaseUpdatePolicy(lease.id, policy))
  }

  async function handleRenew() {
    if (!(await requestConfirm({
      title: `Extend lease #${lease.id} to ${hours} hours?`,
      body: [
        `Cost: ${extendTotal ? formatUdvpnAmount(extendTotal) : 'unknown'} escrowed now.`,
        'The chain does not add to the hours you have left: it refunds what is unspent and charges for the whole new term, starting from zero.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'Extend lease',
    }))) return
    await act('renew', () => window.api.leaseRenew(lease.id, hours))
  }

  async function handleEnd() {
    if (!(await requestConfirm({
      title: `End lease #${lease.id}?`,
      body: [
        'The unspent escrow is refunded.',
        'The chain also unlinks this node from every plan you had linked it to, so those plans stop being served by it.',
        'This is an on-chain transaction.',
      ],
      confirmLabel: 'End lease',
      danger: true,
    }))) return
    await act('end', () => window.api.leaseEnd(lease.id))
  }

  const anyBusy = busy !== null
  const used = lease.maxHours > 0 ? Math.min(1, lease.hours / lease.maxHours) : 0

  return (
    <ReviewModal
      title={`Lease #${lease.id}`}
      subtitle="Renew automatically, extend now, or stop"
      closable={!anyBusy}
      onClose={onClose}
      footer={readOnly ? <FooterReason tone="muted" text="Disconnect the VPN to change this lease." /> : undefined}
    >
      <div className="bg-bg-primary border border-border rounded-md px-3.5 py-3 space-y-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          {node && <CountryFlag country={node.country} />}
          <span className="text-sm text-text-primary truncate">{node?.moniker || lease.nodeAddress}</span>
          {node && (
            <span className="flex items-center gap-1 text-xs text-text-tertiary shrink-0">
              <ProtocolIcon type={node.type} className={`w-3 h-3 ${protocolMeta(node.type).color}`} />
              {protocolMeta(node.type).label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex-1 h-1.5 rounded-full bg-bg-tertiary relative">
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${used * 100}%` }} />
          </span>
          <span className="font-mono text-xs text-text-secondary whitespace-nowrap">{lease.hours} of {lease.maxHours} hours used</span>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <dt className="text-text-tertiary">Bought at</dt>
          <dd className="text-text-primary font-mono">{formatUdvpn(lease.hourlyPrice)}/h</dd>
          <dt className="text-text-tertiary">Node charges now</dt>
          <dd className="text-text-primary font-mono">{quote ? `${formatUdvpn(quote.hourlyPrice)}/h` : quoteError ? 'unavailable' : '…'}</dd>
          <dt className="text-text-tertiary">Renewal</dt>
          <dd className="text-text-primary">{renewalPolicyLabel(lease.renewalPricePolicy)}</dd>
        </dl>
      </div>

      {refusal && <Note>{refusal}</Note>}

      <section>
        <SectionHead title="When the hours run out" />
        <RenewalChoice value={policy} onChange={setPolicy} disabled={anyBusy} />
        <div className="flex justify-end mt-2">
          <button
            type="button"
            onClick={() => void handlePolicy()}
            disabled={anyBusy || readOnly || policy === lease.renewalPricePolicy}
            className="btn btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === 'policy' && <Spinner size="sm" />}
            {busy === 'policy' ? 'Saving…' : 'Change policy'}
          </button>
        </div>
      </section>

      <section>
        <SectionHead title="Extend now" />
        <AmountStepper label="New term" amount={hours} onChange={setHours} unit="hours" presets={[24, 168, 720]} />
        <div className="flex items-center justify-between gap-3 mt-2.5">
          <p className="text-text-tertiary text-[11px]">
            This replaces the term rather than adding to it: the chain refunds the unspent escrow and
            charges for the full new stretch. It starts at the length you originally bought.
          </p>
          <button
            type="button"
            onClick={() => void handleRenew()}
            disabled={anyBusy || readOnly || Boolean(refusal) || !validHours || !quote}
            className="btn btn-primary text-xs py-1.5 px-3 shrink-0 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            title={refusal ?? (!validHours && quote ? `The chain allows ${quote.minHours} to ${quote.maxHours} hours` : undefined)}
          >
            {busy === 'renew' && <Spinner size="sm" />}
            {busy === 'renew'
              ? 'Extending…'
              : extendTotal
                ? `Extend for ${formatUdvpnAmount(extendTotal)}`
                : quote ? 'Extend' : 'Pricing…'}
          </button>
        </div>
      </section>

      <section>
        <SectionHead title="Stop" />
        <div className="flex items-center justify-between gap-3">
          <p className="text-text-tertiary text-[11px]">
            Refunds the unspent escrow, and unlinks this node from every plan it serves.
          </p>
          <button
            type="button"
            onClick={() => void handleEnd()}
            disabled={anyBusy || readOnly}
            className="btn btn-danger text-xs py-1.5 px-3 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {busy === 'end' && <Spinner size="sm" />}
            {busy === 'end' ? 'Ending…' : 'End lease'}
          </button>
        </div>
      </section>

      {(error || quoteError) && (
        <div className="bg-danger-subtle border border-danger rounded-md px-3 py-2">
          <p className="text-danger text-xs">{displayConnectError(error ?? quoteError ?? '')}</p>
        </div>
      )}
      {confirmDialog}
    </ReviewModal>
  )
}
