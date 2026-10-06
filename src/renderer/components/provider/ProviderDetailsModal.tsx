import { useState } from 'react'
import type { MyProvider, ProviderDetailsInput } from '../../types'
import { providerDetailsProblem } from '../../../shared/provider-details'
import { displayConnectError } from '../../utils/connect-errors'
import { FooterReason, ReviewModal } from '../ConnectReview'
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

  // The name is optional to the chain here, but blanking it in a form that was
  // pre-filled means "I cleared this", and the chain would silently keep the old
  // one. Requiring it makes the field mean what it looks like it means.
  const problem = providerDetailsProblem(details, { requireName: true })
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
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update your provider details')
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      {readOnly && <FooterReason tone="muted" text="Disconnect the VPN to save changes." />}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary text-sm py-2 px-4 disabled:opacity-40 disabled:cursor-not-allowed">
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || Boolean(problem) || unchanged || readOnly}
          className="btn btn-primary text-sm py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
          title={readOnly ? 'Disconnect the VPN to save changes' : unchanged ? 'Nothing has changed yet' : undefined}
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
    <ReviewModal title="Edit provider details" closable={!busy} onClose={onClose} footer={footer} className="max-w-md">
      <p className="text-text-tertiary text-xs">
        All four fields are written to the chain together, so whatever is shown here is what
        subscribers will see. Clearing one clears it on chain.
      </p>

      <ProviderDetailsFields details={details} onChange={setDetails} disabled={busy} />

      {(error || problem) && (
        <div className="bg-danger-subtle border border-danger rounded-sm px-3 py-2">
          <p className="text-danger text-xs">{error ? displayConnectError(error) : problem}</p>
        </div>
      )}
    </ReviewModal>
  )
}
