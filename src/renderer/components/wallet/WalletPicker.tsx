import { useState, type ReactNode } from 'react'
import type { WalletStoreStatus } from '../../types'
import Spinner from '../Spinner'
import CopyButton from '../CopyButton'
import { AlertIcon, PlusIcon } from '../Icons'
import { groupWalletsBySeed } from '../../../shared/seed-groups'
import { displayConnectError } from '../../utils/connect-errors'

type StoredWallet = WalletStoreStatus['wallets'][number]

interface Props {
  status: WalletStoreStatus
  /** Re-read the store and the active wallet after a switch or a delete. */
  onChanged: () => Promise<void>
  /** Go to the import/create screen without discarding what's stored. */
  onAddAnother: () => void
}

/**
 * Shown when seeds are stored but none is active: the active one couldn't be
 * restored, or everything was just deleted. Before this existed, that state
 * rendered the import screen, so the only visible way back in was to retype a
 * seed the app already had: the path that produced duplicate entries for one
 * address.
 */
export default function WalletPicker({ status, onChanged, onAddAnother }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  // Retained-seed state only: the name for the wallet about to be derived, and a
  // two-step confirm so the seed can't be dropped on a single stray click.
  const [seedWalletName, setSeedWalletName] = useState('')
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  async function deriveFromRetainedSeed() {
    if (!status.retainedSeedId) return
    setBusyId('derive')
    setError('')
    try {
      // Nothing is stored while a seed is retained, so account 0 / address 0 is
      // always free — no need to hunt for the first unused path.
      await window.api.walletDeriveSubaccount({
        sourceWalletId: status.retainedSeedId,
        accountIndex: 0,
        addressIndex: 0,
        name: seedWalletName.trim() || 'Wallet 1',
      })
      const [entry] = await window.api.walletList()
      if (entry) await window.api.walletSwitch(entry.id)
      await onChanged()
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to derive a wallet'))
    } finally {
      setBusyId(null)
    }
  }

  async function removeSavedSeed() {
    setBusyId('remove')
    setError('')
    try {
      await window.api.walletDeleteAll()
      await onChanged()
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to remove the seed'))
    } finally {
      setBusyId(null)
    }
  }

  async function use(walletId: string) {
    setBusyId(walletId)
    setError('')
    try {
      const { address } = await window.api.walletSwitch(walletId)
      if (!address) {
        setError('That wallet could not be unlocked. Import its seed phrase again.')
        return
      }
      await onChanged()
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to open that wallet'))
    } finally {
      setBusyId(null)
    }
  }

  async function deleteAll() {
    setBusyId('all')
    setError('')
    try {
      await window.api.walletDeleteAll()
      await onChanged()
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to delete wallets'))
    } finally {
      setBusyId(null)
    }
  }

  // A seed that outlived its wallets. Without this screen the app would fall
  // through to the import form and the saved seed would be unreachable.
  if (status.wallets.length === 0 && status.retainedSeedId) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="w-full max-w-xl space-y-8">
          <div className="space-y-3">
            <h1 className="text-accent font-semibold text-2xl">Your seed is saved</h1>
            <p className="text-text-secondary text-sm leading-relaxed">
              No wallets derived from the seed. Derive one to carry on. You won't need to
              retype your recovery phrase.
            </p>
          </div>

          {error && (
            <div className="bg-danger-subtle border border-danger p-3 rounded-md">
              <p className="text-danger text-sm">{error}</p>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="seed-wallet-name" className="text-text-secondary text-xs block">
              Wallet name
            </label>
            <input
              id="seed-wallet-name"
              type="text"
              value={seedWalletName}
              onChange={(e) => setSeedWalletName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && busyId === null && deriveFromRetainedSeed()}
              placeholder="e.g. Wallet 1"
              maxLength={100}
              autoFocus
              className="w-full bg-bg-secondary border border-border text-text-primary text-sm px-2.5 py-2 rounded-sm focus:outline-none focus:border-border-focus"
            />
            <button
              onClick={deriveFromRetainedSeed}
              disabled={busyId !== null}
              className="btn btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {busyId === 'derive' && <Spinner />}
              Derive a wallet
            </button>
          </div>

          {confirmingRemove ? (
            <DangerConfirm
              question="Remove the saved seed from this device?"
              confirmLabel="Remove seed"
              busy={busyId !== null}
              spinning={busyId === 'remove'}
              onCancel={() => setConfirmingRemove(false)}
              onConfirm={removeSavedSeed}
            >
              <p className="text-text-secondary text-xs">
                Without your written-down recovery phrase it cannot be restored. Funds stay
                on-chain, reachable only by importing the phrase again.
              </p>
            </DangerConfirm>
          ) : (
            <button
              onClick={() => setConfirmingRemove(true)}
              disabled={busyId !== null}
              className="text-text-tertiary hover:text-danger text-xs w-full text-center transition-colors disabled:opacity-50"
            >
              Remove saved seed and start fresh
            </button>
          )}
        </div>
      </div>
    )
  }

  // The same cards as Settings > Wallets: one per seed, a row per wallet, and the
  // ones that cannot be unlocked together under one note rather than one per row.
  const { groups, locked } = groupWalletsBySeed(status.wallets)
  const plural = (n: number) => `${n} ${n === 1 ? 'wallet' : 'wallets'}`

  const row = (w: StoredWallet) => (
    <div
      key={w.id}
      className={`relative flex items-center gap-3 px-4 py-3 before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${
        w.unlockable ? '' : 'before:bg-warning'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-text-primary text-sm font-medium truncate">{w.name}</div>
        <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
          {w.address ? (
            <>
              <span className="text-text-tertiary font-mono text-[11px] truncate">{w.address}</span>
              <CopyButton value={w.address} label="Copy address" />
            </>
          ) : (
            <span className="text-text-tertiary text-[11px]">address not yet derived</span>
          )}
        </div>
      </div>
      {w.unlockable && (
        <button
          onClick={() => use(w.id)}
          disabled={busyId !== null}
          className="btn btn-secondary text-xs px-3 py-1 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          {busyId === w.id && <Spinner className="text-accent" />}
          Use
        </button>
      )}
    </div>
  )

  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-8">
        <div className="space-y-3">
          <h1 className="text-accent font-semibold text-2xl">Welcome back</h1>
          <p className="text-text-secondary text-sm leading-relaxed">
            {status.wallets.length === 1
              ? 'A wallet is already stored on this device.'
              : `${status.wallets.length} wallets are already stored on this device.`}{' '}
            Choose one to continue, or add another.
          </p>
        </div>

        {error && (
          <div className="bg-danger-subtle border border-danger p-3 rounded-md">
            <p className="text-danger text-sm">{error}</p>
          </div>
        )}

        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                {g.label} · {plural(g.members.length)}
              </h2>
              <div className="bg-bg-secondary border border-border rounded-md divide-y divide-border overflow-hidden">
                {g.members.map(row)}
              </div>
            </section>
          ))}
          {locked.length > 0 && (
            <section>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-warning mb-2">
                Cannot be unlocked · {plural(locked.length)}
              </h2>
              <p className="text-text-secondary text-xs mb-2">
                Saved under the app's previous name, so {locked.length === 1 ? 'its seed' : 'their seeds'} can
                no longer be unlocked. Import the same recovery phrase again. Your funds are on-chain
                and unaffected.
              </p>
              <div className="bg-bg-secondary border border-border rounded-md divide-y divide-border overflow-hidden">
                {locked.map(row)}
              </div>
            </section>
          )}
        </div>

        <div className="space-y-3">
          <button
            onClick={onAddAnother}
            disabled={busyId !== null}
            className="btn btn-secondary w-full disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Add another wallet
          </button>
          {confirmingRemove ? (
            <DangerConfirm
              question={`Delete ${status.wallets.length} stored wallet${status.wallets.length === 1 ? '' : 's'} and start fresh?`}
              confirmLabel="Delete all wallets"
              busy={busyId !== null}
              spinning={busyId === 'all'}
              onCancel={() => setConfirmingRemove(false)}
              onConfirm={deleteAll}
            >
              <ul className="space-y-1 text-xs">
                {status.wallets.map((w) => (
                  <li key={w.id} className="flex items-baseline gap-2 min-w-0">
                    <span className="text-text-primary shrink-0">{w.name}</span>
                    <span className="text-text-tertiary font-mono truncate">{w.address || 'address unknown'}</span>
                  </li>
                ))}
              </ul>
              <p className="text-text-secondary text-xs">
                This removes the encrypted seeds from this device. Without your written-down
                recovery phrase they cannot be restored. Funds stay on-chain, reachable only by
                re-importing the phrase. App settings are kept.
              </p>
            </DangerConfirm>
          ) : (
            <button
              onClick={() => setConfirmingRemove(true)}
              disabled={busyId !== null}
              className="text-text-tertiary hover:text-danger text-xs w-full text-center transition-colors disabled:opacity-50"
            >
              Delete all wallets and start fresh
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** The inline two-step confirm both screens use before dropping seeds: a question, what goes, Cancel and the act. */
function DangerConfirm({ question, confirmLabel, busy, spinning, onCancel, onConfirm, children }: {
  question: string
  confirmLabel: string
  busy: boolean
  spinning: boolean
  onCancel: () => void
  onConfirm: () => void
  children: ReactNode
}) {
  return (
    <div className="bg-danger-subtle rounded-md px-3.5 py-3 space-y-3">
      <p className="flex items-center gap-2 text-danger text-sm font-medium">
        <AlertIcon className="w-4 h-4 shrink-0" />
        {question}
      </p>
      <div className="pl-6 space-y-2">{children}</div>
      <div className="flex gap-2 pl-6">
        <button
          onClick={onCancel}
          disabled={busy}
          className="btn btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="btn btn-danger text-xs py-1.5 flex-1 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
        >
          {spinning && <Spinner />}
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
