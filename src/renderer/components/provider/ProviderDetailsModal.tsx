import { useState } from 'react'
import type { MyProvider, ProviderDetailsInput } from '../../types'
import { providerDetailsProblem } from '../../../shared/provider-details'
import { isTestPlan } from '../../../shared/test-plan'
import { displayConnectError } from '../../utils/connect-errors'
import { usePlansContext } from '../../contexts/PlansContext'
import { FooterReason, ReviewModal, SectionHead } from '../ConnectReview'
import Spinner from '../Spinner'
import ProviderDetailsFields from './ProviderDetailsFields'

/**
 * Edit the provider record on chain.
 *
 * Pre-filled from the current record, and that is not a nicety: the hub's
 * MsgUpdateProviderDetails handler keeps the stored name when the message carries
 * an empty one but overwrites identity, website and description UNCONDITIONALLY.
 * A blank-by-default form would therefore wipe three fields on every save, which
 * is why this one starts from what the chain already holds and sends all four
 * back.
 *
 * The preview under the fields is the Plans catalog's own heading for a provider's
 * plan (PlanDetailPane), drawn from what is typed, so "what subscribers will see" is
 * shown rather than claimed.
 */
export default function ProviderDetailsModal({ provider, readOnly, onClose, onSaved }: {
  provider: MyProvider
  /** The console went read-only (tunnel up, or the chain read failed) after this modal opened. */
  readOnly: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [details, setDetails] = useState<ProviderDetailsInput>({
    name: provider.name,
    identity: provider.identity,
    website: provider.website,
    description: provider.description,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { refreshOverview } = usePlansContext()

  // The name is optional to the chain here, but blanking it in a form that was
  // pre-filled means "I cleared this", and the chain would silently keep the old
  // one. Requiring it makes the field mean what it looks like it means.
  const problem = providerDetailsProblem(details, { requireName: true })
  const shownName = details.name.trim()
  const unchanged =
    details.name === provider.name &&
    details.identity === provider.identity &&
    details.website === provider.website &&
    details.description === provider.description

  async function handleSave() {
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.api.providerUpdateDetails({ ...details, name: details.name.trim() })
      // Awaited before closing, so the card behind is already showing the new
      // details rather than the old ones for the length of a chain round-trip.
      await onSaved()
      // The catalog derives Test plans from this name, and main has just patched its
      // provider list, so the Plans tab re-reads instead of waiting for its next poll.
      void refreshOverview()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update your provider details')
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      {readOnly ? <FooterReason tone="muted" text="Disconnect the VPN to save changes." />
        : problem ? <FooterReason text={problem} />
          : unchanged && !busy && <FooterReason tone="muted" text="Nothing has changed yet." />}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary text-sm py-2 px-4 disabled:opacity-40 disabled:cursor-not-allowed">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || Boolean(problem) || unchanged || readOnly}
          className="btn btn-primary text-sm py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
        >
          {busy && <Spinner size="sm" />}
          {busy ? 'Saving…' : 'Save to chain'}
        </button>
      </div>
      <p className="text-text-tertiary text-[11px]">
        This is an on-chain transaction, and costs the network fee only.
      </p>
    </>
  )

  return (
    <ReviewModal
      title="Edit provider details"
      subtitle="All four fields are written to the chain together, so clearing one clears it on chain."
      closable={!busy}
      onClose={onClose}
      footer={footer}
      className="max-w-md"
    >
      <ProviderDetailsFields details={details} onChange={setDetails} disabled={busy} savedName={provider.name} />

      <section>
        <SectionHead title="How subscribers see it">
          <span className="text-text-tertiary font-normal">in the Plans catalog</span>
        </SectionHead>
        <div className="bg-bg-primary border border-border rounded-md px-3.5 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-text-primary text-base font-semibold break-all">
              {shownName || `${provider.address.slice(0, 14)}...${provider.address.slice(-6)}`}
            </span>
            {isTestPlan(shownName) && (
              <span className="text-[10px] font-mono uppercase bg-warning-subtle text-warning px-1.5 py-0.5 rounded-sm">test</span>
            )}
          </div>
          {details.description
            ? <p className="text-text-tertiary text-xs mt-1 break-words">{details.description}</p>
            : <p className="text-text-tertiary text-xs mt-1 italic">No description, so only the name shows.</p>}
        </div>
        <p className="text-text-tertiary text-[11px] mt-2">
          Website and identity are stored on chain, but the catalog does not show them.
        </p>
      </section>

      {error && (
        <div className="bg-danger-subtle border border-danger rounded-sm px-3 py-2">
          <p className="text-danger text-xs">{displayConnectError(error)}</p>
        </div>
      )}
    </ReviewModal>
  )
}
