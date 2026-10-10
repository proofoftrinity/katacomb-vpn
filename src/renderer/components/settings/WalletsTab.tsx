import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { WalletStoreStatus, AppSettings, DerivationPreview } from '../../types'
import Spinner from '../Spinner'
import CopyButton from '../CopyButton'
import { ReviewModal, SectionHead, OptionsSection, Note, FooterReason } from '../ConnectReview'
import { AlertIcon, CheckIcon, CopyIcon, EyeIcon, KeyIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon } from '../Icons'
import { useBalance } from '../../hooks/useBalance'
import { parseWalletExists } from '../../../shared/wallet-errors'
import { displayConnectError } from '../../utils/connect-errors'
import { formatHdPath, DERIVE_PREVIEW_MAX_COUNT } from '../../../shared/hd-path'
import { groupWalletsBySeed, type SeedGroup } from '../../../shared/seed-groups'

// Address indices shown per page in the new-wallet picker, how long a revealed
// recovery phrase stays on screen before it re-blurs, and how long a copied one
// stays on the clipboard.
const PREVIEW_PAGE = 10
const REBLUR_MS = 60_000
const CLIPBOARD_CLEAR_MS = 30_000

// The seed headers' actions: quiet until hovered, one style for all three.
const GHOST = 'flex items-center gap-1.5 text-text-secondary text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-text-secondary'

type StoredWallet = WalletStoreStatus['wallets'][number]
// What the new-wallet / recovery-phrase / remove-seed windows act on: one seed and
// the wallets stored under it. Any member's id serves as the seed source in main.
type Group = SeedGroup<StoredWallet>

// One window at a time. Each owns its own state and unmounts on close, so a revealed
// phrase goes with the window that showed it.
type WalletWindow =
  | { kind: 'derive'; group: Group }
  | { kind: 'phrase'; group: Group }
  | { kind: 'delete'; wallet: StoredWallet }
  | { kind: 'removeSeed'; group: Group }

interface Props {
  wallets: StoredWallet[]
  settings: AppSettings
  /**
   * A session is live, in any mode: tunnel, local proxy, or the reconnect window.
   * Main refuses every change to the active wallet then (assertNotConnected), so
   * these actions grey out behind a note. The handlers are the enforcement;
   * this is only the UX.
   */
  connected: boolean
  /** Re-read settings and the wallet store after a mutation. */
  reload: () => Promise<void>
  onWalletSwitch: () => void
  onWalletsChanged?: () => void
  onAddWallet: () => void
}

/**
 * The Wallets tab: one card per seed, a row per wallet, and four windows (new
 * wallet, recovery phrase, delete wallet, remove seed) built on the connect
 * windows' ReviewModal.
 *
 * Every action sits in one tier with one style (docs/renderer.md): Add wallet for
 * the tab, Switch as the only button on a row, icons for rename / copy / delete,
 * ghost links for the seed. Red appears on hover and inside the confirm windows,
 * never at rest.
 *
 * The windows are siblings of the tab body (a fragment). ReviewModal is a `fixed`
 * overlay, painted above the Settings dialog inside its stacking context, and the
 * dialog's own stopPropagation keeps a backdrop click from closing Settings too.
 */
export default function WalletsTab({
  wallets, settings, connected, reload, onWalletSwitch, onWalletsChanged, onAddWallet,
}: Props) {
  const [open, setOpen] = useState<WalletWindow | null>(null)
  // Switch has no window of its own, so its refusal renders above the list.
  const [switchError, setSwitchError] = useState('')
  // The active wallet's balance only: reading every address at once would tell the
  // RPC operator that one IP owns all of them (docs/renderer.md).
  const { display: balance } = useBalance()

  async function handleSwitch(walletId: string) {
    setSwitchError('')
    try {
      await window.api.walletSwitch(walletId)
      onWalletSwitch()
    } catch (err) {
      setSwitchError(displayConnectError(err instanceof Error ? err.message : 'Failed to switch wallet'))
    }
  }

  async function changed() {
    await reload()
    onWalletsChanged?.()
  }

  // Show the derivation path on each row only when at least one wallet is off the
  // default path: avoids noise for single-account users.
  const showHdPath = wallets.some((w) => (w.accountIndex ?? 0) > 0 || (w.addressIndex ?? 0) > 0)

  // Wallets nested under the seed they were derived from. `locked` holds the
  // ones whose seed cannot be decrypted, so their membership is unknown.
  const { groups, locked } = useMemo(() => groupWalletsBySeed(wallets), [wallets])

  // What deleting one row does to its seed, which depends on the rest of its group.
  const deleteNote = (w: StoredWallet): string => {
    if (w.seedGroup === null) {
      return 'This wallet cannot be unlocked, so nothing usable is removed. Import the same recovery phrase again to get it back.'
    }
    const group = groups.find((g) => g.key === w.seedGroup)
    if (group && group.members.length > 1) {
      return `Removes this wallet from the device. The seed stays with the other wallets of ${group.label}, so you can create it again at the same path.`
    }
    return `This is the only wallet of ${group?.label ?? 'this seed'}, so its seed is removed from this device too. Funds stay on-chain, reachable only by importing your written-down phrase again.`
  }

  const row = (w: StoredWallet) => (
    <WalletRow
      key={w.id}
      wallet={w}
      // By id, not by address: matching on address lit up every entry sharing
      // one, which is exactly how the duplicate-wallet bug showed itself (two
      // rows, both badged Active).
      active={w.id === settings.activeWalletId}
      showHdPath={showHdPath}
      balance={balance}
      connected={connected}
      onSwitch={() => void handleSwitch(w.id)}
      onDelete={() => setOpen({ kind: 'delete', wallet: w })}
      onRenamed={changed}
    />
  )

  const plural = (n: number) => `${n} ${n === 1 ? 'wallet' : 'wallets'}`

  return (
    <>
      <div className="space-y-5">
        {/* Main refuses every change to the active wallet while a session is live
            (assertNotConnected); this is the half that explains instead of
            erroring. Rename, New wallet and Recovery phrase never change the
            active wallet, so they stay usable. */}
        {connected && (
          <Note>You are connected. Switching, adding and removing wallets waits until you disconnect.</Note>
        )}

        <div className="flex items-center justify-between">
          <label className="text-text-secondary text-xs font-medium uppercase tracking-wide">
            Wallets · {wallets.length}
          </label>
          <button
            type="button"
            onClick={onAddWallet}
            disabled={connected}
            title={connected ? 'Disconnect first to add a wallet' : 'Import a recovery phrase or create a new one'}
            className="btn btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Add wallet
          </button>
        </div>

        {switchError && <p className="text-danger text-xs">{switchError}</p>}

        {/* One card per seed. The seed-level actions live on its header, so each
            seed's phrase, new wallets and removal are reachable without
            switching to a wallet under it first. */}
        {groups.map((group) => (
          <SeedCard
            key={group.key}
            heading={`${group.label} · ${plural(group.members.length)}`}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setOpen({ kind: 'derive', group })}
                  title="Another wallet from this seed, at a new address. No phrase to type."
                  className={`${GHOST} hover:text-accent`}
                >
                  <PlusIcon className="w-3.5 h-3.5" />
                  New wallet
                </button>
                <button
                  type="button"
                  onClick={() => setOpen({ kind: 'phrase', group })}
                  title="Show this seed's recovery phrase"
                  className={`${GHOST} hover:text-accent`}
                >
                  <KeyIcon className="w-3.5 h-3.5" />
                  Recovery phrase
                </button>
                <button
                  type="button"
                  onClick={() => setOpen({ kind: 'removeSeed', group })}
                  disabled={connected}
                  title={connected ? 'Disconnect first to remove a seed' : 'Remove this seed and every wallet on it from this device'}
                  className={`${GHOST} hover:text-danger`}
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                  Remove
                </button>
              </>
            }
          >
            {group.members.map(row)}
          </SeedCard>
        ))}

        {locked.length > 0 && (
          <SeedCard
            warn
            heading={`Cannot be unlocked · ${plural(locked.length)}`}
            note={
              <p className="text-text-secondary text-xs mb-2">
                Saved under the app's previous name, so {locked.length === 1 ? 'its seed' : 'their seeds'} can
                no longer be unlocked. Import the same recovery phrase again. Your funds are on-chain
                and unaffected.
              </p>
            }
          >
            {locked.map(row)}
          </SeedCard>
        )}

        <p className="flex items-center gap-1.5 text-text-tertiary text-xs">
          <LockIcon className="w-3.5 h-3.5 shrink-0" />
          Seeds are stored on this device, encrypted with your OS keyring.
        </p>
      </div>

      {open?.kind === 'derive' && (
        <NewWalletWindow group={open.group} onClose={() => setOpen(null)} onCreated={changed} />
      )}
      {open?.kind === 'phrase' && (
        <PhraseWindow group={open.group} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'delete' && (
        <DeleteWindow
          wallet={open.wallet}
          note={deleteNote(open.wallet)}
          onClose={() => setOpen(null)}
          onDeleted={changed}
        />
      )}
      {open?.kind === 'removeSeed' && (
        <RemoveSeedWindow
          group={open.group}
          // Keep seed rides the retained-seed model, which only holds a seed while
          // ZERO wallets are stored, so it is offered only when this group's
          // wallets are the last ones (rows that cannot be unlocked count too).
          isLast={open.group.members.length === wallets.length}
          hitsActive={open.group.members.some((w) => w.id === settings.activeWalletId)}
          lockedCount={locked.length}
          onClose={() => setOpen(null)}
          onRemoved={changed}
          onActiveChanged={onWalletSwitch}
        />
      )}
    </>
  )
}

/** A seed's heading, its actions on the right, and its wallets in one card. */
function SeedCard({ heading, actions, note, warn = false, children }: {
  heading: string
  actions?: ReactNode
  note?: ReactNode
  warn?: boolean
  children: ReactNode
}) {
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className={`text-[11px] font-semibold uppercase tracking-wider ${warn ? 'text-warning' : 'text-text-tertiary'}`}>
          {heading}
        </h3>
        {actions && <div className="flex items-center gap-4">{actions}</div>}
      </div>
      {note}
      <div className="bg-bg-primary border border-border rounded-md divide-y divide-border overflow-hidden">
        {children}
      </div>
    </section>
  )
}

/**
 * One wallet. The active one takes the app's selected-row look (accent tint and
 * bar) and shows its balance where Switch would sit; a wallet that cannot be
 * unlocked carries a warning bar and no Switch. Rename is inline: Enter or leaving
 * the field saves, Escape cancels.
 */
function WalletRow({ wallet: w, active, showHdPath, balance, connected, onSwitch, onDelete, onRenamed }: {
  wallet: StoredWallet
  active: boolean
  showHdPath: boolean
  balance: string | null
  connected: boolean
  onSwitch: () => void
  onDelete: () => void
  onRenamed: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Escape blurs the field like Enter does, so one blur handler decides; this
  // tells it the blur was a cancel.
  const cancelled = useRef(false)

  async function save() {
    const name = draft.trim()
    if (!name || name === w.name) {
      setEditing(false)
      setError('')
      return
    }
    setSaving(true)
    setError('')
    try {
      await window.api.walletRename(w.id, name)
      setEditing(false)
      await onRenamed()
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to rename the wallet'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`relative flex items-center gap-3 px-4 py-2.5 before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${
        active ? 'bg-accent-subtle before:bg-accent' : w.unlockable ? '' : 'before:bg-warning'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0 h-6">
          {editing ? (
            <>
              <input
                type="text"
                value={draft}
                maxLength={100}
                disabled={saving}
                autoFocus
                aria-label="Wallet name"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    cancelled.current = true
                    e.currentTarget.blur()
                  }
                }}
                onBlur={() => {
                  if (cancelled.current) {
                    cancelled.current = false
                    setEditing(false)
                    setError('')
                    return
                  }
                  void save()
                }}
                className="bg-bg-secondary border border-border-focus text-text-primary text-sm font-medium px-1.5 py-0.5 w-48 rounded-sm focus:outline-none disabled:opacity-60"
              />
              {saving && <Spinner className="text-accent" />}
            </>
          ) : (
            <>
              <span className="text-text-primary text-sm font-medium truncate">{w.name}</span>
              <button
                type="button"
                onClick={() => { setDraft(w.name); setEditing(true) }}
                aria-label={`Rename ${w.name}`}
                title="Rename"
                className="shrink-0 text-text-tertiary hover:text-accent transition-colors"
              >
                <PencilIcon className="w-3 h-3" />
              </button>
            </>
          )}
          {active && (
            <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none bg-accent text-text-on-accent">
              Active
            </span>
          )}
          {showHdPath && (
            <span className="shrink-0 text-text-tertiary text-[10px] font-mono">
              {formatHdPath(w.accountIndex ?? 0, w.addressIndex ?? 0)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
          {w.address ? (
            <>
              <span className="text-text-tertiary text-[11px] font-mono truncate">{w.address}</span>
              <CopyButton value={w.address} label="Copy address" />
            </>
          ) : (
            <span className="text-text-tertiary text-[11px]">Address will appear after switching to this wallet</span>
          )}
        </div>
        {error && <p className="text-danger text-xs mt-1">{error}</p>}
      </div>

      {active ? (
        <span className="shrink-0 font-mono text-sm text-text-primary" title="Balance of the wallet in use">
          {balance ?? '…'} <span className="text-text-tertiary text-xs">P2P</span>
        </span>
      ) : w.unlockable && (
        <button
          type="button"
          onClick={onSwitch}
          disabled={connected}
          title={connected ? 'Disconnect first to switch wallets' : 'Use this wallet. The app reloads on it.'}
          className="btn btn-secondary text-xs px-3 py-1 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Switch
        </button>
      )}
      {/* Delete removes ONE wallet and is never offered for the active one, with
          no count-based exception, so the rule stays predictable. That leaves the
          last wallet undeletable here by design: getting rid of everything is the
          seed's Remove, which is where the keep-the-seed question belongs. */}
      <button
        type="button"
        onClick={onDelete}
        disabled={active || connected}
        aria-label={`Delete ${w.name}`}
        title={
          connected
            ? 'Disconnect first to delete a wallet'
            : active
              ? 'Switch to another wallet before deleting this one, or remove the whole seed'
              : 'Delete this wallet'
        }
        className="shrink-0 p-1 -mr-1 rounded-sm text-text-tertiary hover:text-danger transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-text-tertiary"
      >
        <TrashIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

/** The footer's two buttons: Cancel, and the window's action taking the rest of the row. */
function FooterButtons({ busy, onCancel, children }: { busy: boolean; onCancel: () => void; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="btn btn-secondary text-sm py-2 px-4 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Cancel
      </button>
      {children}
    </div>
  )
}

const PRIMARY = 'btn btn-primary text-sm py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5'
const DANGER = 'btn btn-danger text-sm py-2 flex-1 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5'

/**
 * A new wallet on a stored seed. The account index is typed (folded under
 * Options: most people want the next address on account 0), the address index
 * is picked from a preview list that shows the real address behind each path.
 */
function NewWalletWindow({ group, onClose, onCreated }: {
  group: Group
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const [name, setName] = useState('')
  // Start on the seed's first account: "another address on this seed" is the
  // common action, and the preview list greys out whatever is already stored.
  const [account, setAccount] = useState(String(group.members[0].accountIndex ?? 0))
  const [addressIndex, setAddressIndex] = useState<number | null>(null)
  const [previewRows, setPreviewRows] = useState<DerivationPreview[]>([])
  const [previewCount, setPreviewCount] = useState(PREVIEW_PAGE)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // The typed account index, or null while it's blank/invalid.
  const accountIndex = useMemo(() => {
    const parsed = parseInt(account, 10)
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 2147483647 ? parsed : null
  }, [account])

  // Derive the visible paths in main and show what each one would produce.
  // Debounced so holding the spinner doesn't queue a derivation per tick, and
  // `stale` drops a late response from a previous account index.
  useEffect(() => {
    if (accountIndex === null) {
      setPreviewRows([])
      return
    }
    let stale = false
    setPreviewLoading(true)
    const timer = window.setTimeout(() => {
      window.api
        .walletDerivePreview({
          sourceWalletId: group.members[0].id,
          accountIndex,
          startIndex: 0,
          count: previewCount,
        })
        .then((rows) => {
          if (stale) return
          setPreviewRows(rows)
          setPreviewError('')
        })
        .catch((err: unknown) => {
          if (stale) return
          setPreviewRows([])
          setPreviewError(displayConnectError(err instanceof Error ? err.message : 'Failed to derive addresses'))
        })
        .finally(() => {
          if (!stale) setPreviewLoading(false)
        })
    }, 250)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [group, accountIndex, previewCount])

  // Land on the first free path, again whenever the account changes, and move off
  // one that turns out to be taken. A list's first address names its account (each
  // account derives different addresses), so a pick survives Show more but not a
  // new account index: it used to stay on, say, address 2 of the new account.
  const pickedOn = useRef<string | null>(null)
  useEffect(() => {
    if (previewRows.length === 0) return
    const selected = previewRows.find((r) => r.addressIndex === addressIndex)
    if (pickedOn.current === previewRows[0].address && selected && !selected.existingWalletName) return
    pickedOn.current = previewRows[0].address
    setAddressIndex(previewRows.find((r) => !r.existingWalletName)?.addressIndex ?? null)
  }, [previewRows, addressIndex])

  const canCreate = !busy && name.trim() !== '' && accountIndex !== null && addressIndex !== null

  async function submit() {
    if (!canCreate || accountIndex === null || addressIndex === null) return
    setError('')
    setBusy(true)
    try {
      await window.api.walletDeriveSubaccount({
        sourceWalletId: group.members[0].id,
        accountIndex,
        addressIndex,
        name: name.trim(),
      })
      onClose()
      await onCreated()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create the wallet'
      // The picker greys out taken paths, but addWalletEntry's uniqueness guard
      // is still the authority (and covers a race). Its error carries the
      // clashing wallet's id: show only the human half.
      setError(parseWalletExists(message)?.message ?? displayConnectError(message))
      setBusy(false)
    }
  }

  const footer = (
    <>
      {error ? <FooterReason text={error} />
        : !name.trim() ? <FooterReason tone="muted" text="Name the wallet to create it." />
          : accountIndex !== null && addressIndex === null && !previewLoading && previewRows.length > 0
            ? <FooterReason tone="muted" text="Every address shown is in use. Show more to pick another." />
            : null}
      <FooterButtons busy={busy} onCancel={onClose}>
        <button type="button" onClick={() => void submit()} disabled={!canCreate} className={PRIMARY}>
          {busy && <Spinner />}
          {busy ? 'Creating…' : 'Create wallet'}
        </button>
      </FooterButtons>
    </>
  )

  return (
    <ReviewModal
      title={`New wallet on ${group.label}`}
      subtitle={`Same recovery phrase as ${group.members.map((m) => m.name).join(', ')}, at a new address. Nothing to type.`}
      closable={!busy}
      onClose={onClose}
      footer={footer}
      className="max-w-md"
    >
      <div className="space-y-1.5">
        <label htmlFor="new-wallet-name" className="text-xs text-text-secondary block">Name</label>
        <input
          id="new-wallet-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="e.g. Savings"
          maxLength={100}
          autoFocus
          className="w-full bg-bg-primary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus"
        />
      </div>

      <section>
        <SectionHead title="Address">{previewLoading && <Spinner className="text-accent" />}</SectionHead>
        {previewError && <p className="text-danger text-xs mb-2">{previewError}</p>}
        {accountIndex === null ? (
          <p className="text-text-tertiary text-xs">Enter an account index under Options to see its addresses.</p>
        ) : (
          <div className="bg-bg-primary border border-border rounded-md divide-y divide-border max-h-[220px] overflow-y-auto">
            {previewRows.map((r) => {
              const taken = r.existingWalletName !== null
              const selected = r.addressIndex === addressIndex
              return (
                <button
                  key={r.addressIndex}
                  type="button"
                  onClick={() => setAddressIndex(r.addressIndex)}
                  disabled={taken}
                  aria-pressed={selected}
                  title={r.path}
                  className={`relative w-full text-left text-xs px-3 py-1.5 flex items-center gap-2.5 transition-colors before:absolute before:inset-y-0 before:left-0 before:w-0.5 ${
                    selected ? 'bg-accent-subtle before:bg-accent' : taken ? 'cursor-not-allowed' : 'hover:bg-bg-hover'
                  }`}
                >
                  <span className="font-mono text-text-tertiary shrink-0 w-6 text-right">{r.addressIndex}</span>
                  <span className={`font-mono truncate ${selected ? 'text-accent' : taken ? 'text-text-tertiary' : 'text-text-secondary'}`}>
                    {r.address}
                  </span>
                  {taken && <span className="text-text-tertiary ml-auto shrink-0">Used by {r.existingWalletName}</span>}
                </button>
              )
            })}
            {previewRows.length > 0 && previewCount < DERIVE_PREVIEW_MAX_COUNT && (
              <button
                type="button"
                onClick={() => setPreviewCount((c) => Math.min(c + PREVIEW_PAGE, DERIVE_PREVIEW_MAX_COUNT))}
                className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:text-accent transition-colors"
              >
                Show more
              </button>
            )}
          </div>
        )}
      </section>

      <OptionsSection summary={accountIndex === null ? 'Account ?' : `Account ${accountIndex}`}>
        <div className="space-y-1.5">
          <label htmlFor="new-wallet-account" className="text-xs text-text-secondary block">Account index</label>
          <div className="flex items-center gap-3">
            <input
              id="new-wallet-account"
              type="number"
              min={0}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="w-24 bg-bg-primary border border-border text-text-primary text-sm px-2.5 py-1.5 rounded-sm focus:outline-none focus:border-border-focus font-mono"
            />
            <span className="text-text-tertiary text-xs font-mono">
              m/44'/118'/{accountIndex ?? '?'}'/0/<span className="text-text-secondary">x</span>
            </span>
          </div>
          <p className="text-text-tertiary text-xs">
            Another account on the same seed, what Keplr and Ledger Live call a subaccount. Leave it
            as it is for the next address on this one.
          </p>
        </div>
      </OptionsSection>
    </ReviewModal>
  )
}

/**
 * A seed's recovery phrase, behind a warning, then blurred until revealed. The
 * phrase lives in this window's state only, so closing the window drops it.
 */
function PhraseWindow({ group, onClose }: { group: Group; onClose: () => void }) {
  const [phrase, setPhrase] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const reblurTimer = useRef<number | null>(null)
  const copyClearTimer = useRef<number | null>(null)

  // The re-blur timer goes with the window. The clipboard wipe does NOT [RN-9]:
  // closing the window (or Settings) right after copying is the usual flow, and
  // cancelling the wipe then would leave the phrase on the clipboard for good.
  useEffect(() => () => {
    if (reblurTimer.current !== null) window.clearTimeout(reblurTimer.current)
  }, [])

  async function fetchPhrase() {
    setLoading(true)
    setError('')
    try {
      const { mnemonic } = await window.api.walletRevealMnemonic(group.members[0].id)
      setPhrase(mnemonic)
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to read the recovery phrase'))
    } finally {
      setLoading(false)
    }
  }

  function reveal() {
    setRevealed(true)
    if (reblurTimer.current !== null) window.clearTimeout(reblurTimer.current)
    reblurTimer.current = window.setTimeout(() => setRevealed(false), REBLUR_MS)
  }

  async function copyPhrase() {
    if (!phrase) return
    try {
      await navigator.clipboard.writeText(phrase)
    } catch {
      setError('Could not copy to the clipboard')
      return
    }
    setError('')
    setCopied(true)
    // Same rule as the create-wallet screen: don't let the seed linger on the
    // clipboard (finding M5). The label says so while the copy is live.
    if (copyClearTimer.current !== null) window.clearTimeout(copyClearTimer.current)
    copyClearTimer.current = window.setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {})
      copyClearTimer.current = null
      setCopied(false)
    }, CLIPBOARD_CLEAR_MS)
  }

  const footer = phrase === null ? (
    <>
      {error && <FooterReason text={error} />}
      <FooterButtons busy={loading} onCancel={onClose}>
        <button type="button" onClick={() => void fetchPhrase()} disabled={loading} className={PRIMARY}>
          {loading && <Spinner />}
          Show phrase
        </button>
      </FooterButtons>
    </>
  ) : (
    <>
      {error && <FooterReason text={error} />}
      <button type="button" onClick={onClose} className={`${PRIMARY} w-full`}>Done</button>
    </>
  )

  return (
    <ReviewModal
      title="Recovery phrase"
      subtitle={`${group.label} unlocks ${group.members.map((m) => m.name).join(', ')}`}
      closable={!loading}
      onClose={onClose}
      footer={footer}
      className="max-w-md"
    >
      {phrase === null ? (
        <div className="bg-danger-subtle rounded-md px-3.5 py-3 space-y-2">
          <p className="flex items-center gap-2 text-danger text-sm font-medium">
            <AlertIcon className="w-4 h-4 shrink-0" />
            Anyone with these words controls this wallet's funds.
          </p>
          <ul className="text-text-secondary text-xs space-y-1 list-disc pl-10">
            <li>Never share them. Nobody from Katacomb will ever ask for them.</li>
            <li>Make sure nobody can see your screen, and that you aren't recording or sharing it.</li>
            <li>Write them down offline; anything typed into a website is a theft attempt.</li>
          </ul>
        </div>
      ) : (
        <div className="space-y-3">
          {group.members.length > 1 && (
            <p className="text-text-secondary text-xs">
              These words unlock every wallet in {group.label}. Only the derivation path differs.
            </p>
          )}
          <div className="relative">
            <div
              className={`grid grid-cols-3 gap-1.5 transition-[filter] ${
                revealed ? '' : 'blur-sm select-none pointer-events-none'
              }`}
            >
              {phrase.split(/\s+/).map((word, i) => (
                <div
                  key={i}
                  className="bg-bg-primary border border-border rounded-sm px-2 py-1.5 flex items-baseline gap-2"
                >
                  <span className="text-text-tertiary text-[10px] font-mono w-4 shrink-0 text-right">{i + 1}</span>
                  <span className="text-text-primary text-xs font-mono truncate">{word}</span>
                </div>
              ))}
            </div>
            {!revealed && (
              <div className="absolute inset-0 grid place-items-center">
                <button
                  type="button"
                  onClick={reveal}
                  className="btn btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
                >
                  <EyeIcon className="w-3.5 h-3.5" />
                  Reveal
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void copyPhrase()} className={`${GHOST} hover:text-accent`}>
              {copied ? <CheckIcon className="w-3.5 h-3.5 text-success" /> : <CopyIcon className="w-3.5 h-3.5" />}
              {copied ? 'Copied. Clipboard clears in 30s' : 'Copy'}
            </button>
            <span className="text-text-tertiary text-xs ml-auto">
              {revealed ? 'Hides again after 60s' : 'Hidden'}
            </span>
          </div>
        </div>
      )}
    </ReviewModal>
  )
}

/** Deletes one non-active wallet. Whether its seed survives depends on the rest of its group; `note` says which. */
function DeleteWindow({ wallet, note, onClose, onDeleted }: {
  wallet: StoredWallet
  note: string
  onClose: () => void
  onDeleted: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run() {
    setBusy(true)
    setError('')
    try {
      await window.api.walletDelete(wallet.id)
      onClose()
      await onDeleted()
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to delete wallet'))
      setBusy(false)
    }
  }

  return (
    <ReviewModal
      title={`Delete "${wallet.name}"?`}
      subtitle={<span className="font-mono break-all">{wallet.address}</span>}
      closable={!busy}
      onClose={onClose}
      className="max-w-md"
      footer={
        <>
          {error && <FooterReason text={error} />}
          <FooterButtons busy={busy} onCancel={onClose}>
            <button type="button" onClick={() => void run()} disabled={busy} className={DANGER}>
              {busy && <Spinner />}
              Delete wallet
            </button>
          </FooterButtons>
        </>
      }
    >
      <p className="text-text-secondary text-sm">{note}</p>
    </ReviewModal>
  )
}

/**
 * Removes a seed and every wallet on it. When those are the last wallets stored,
 * the seed itself can stay (the retained-seed model), so the window asks.
 */
function RemoveSeedWindow({ group, isLast, hitsActive, lockedCount, onClose, onRemoved, onActiveChanged }: {
  group: Group
  isLast: boolean
  hitsActive: boolean
  lockedCount: number
  onClose: () => void
  onRemoved: () => Promise<void>
  /** Main moved to another wallet, or none is left: reload the way a Switch does. */
  onActiveChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const members = group.members
  const subject = members.length === 1 ? 'this wallet is' : `all ${members.length} wallets of ${group.label} are`

  async function run(keepSeed: boolean) {
    setBusy(true)
    setError('')
    try {
      const { activeWalletChanged } = await window.api.walletDeleteSeed(members[0].id, keepSeed)
      if (activeWalletChanged) {
        // Every wallet-scoped view starts over, exactly as after a Switch.
        onActiveChanged()
        return
      }
      onClose()
      await onRemoved()
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to remove the seed'))
      setBusy(false)
    }
  }

  return (
    <ReviewModal
      title={`Remove ${group.label}?`}
      closable={!busy}
      onClose={onClose}
      className="max-w-md"
      footer={
        <>
          {error && <FooterReason text={error} />}
          <FooterButtons busy={busy} onCancel={onClose}>
            {isLast && (
              <button
                type="button"
                onClick={() => void run(true)}
                disabled={busy}
                className="btn btn-secondary text-sm py-2 px-4 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Keep seed
              </button>
            )}
            <button type="button" onClick={() => void run(false)} disabled={busy} className={DANGER}>
              {busy && <Spinner />}
              {isLast
                ? 'Delete seed too'
                : members.length === 1
                  ? 'Delete wallet'
                  : `Delete ${members.length} wallets`}
            </button>
          </FooterButtons>
        </>
      }
    >
      <div className="bg-danger-subtle rounded-md px-3.5 py-3 space-y-2">
        <p className="flex items-start gap-2 text-danger text-sm font-medium">
          <AlertIcon className="w-4 h-4 mt-px shrink-0" />
          <span>
            {isLast ? `Either way, ${subject}` : subject.charAt(0).toUpperCase() + subject.slice(1)}{' '}
            removed from this device.
          </span>
        </p>
        <ul className="space-y-1 pl-6 text-xs">
          {members.map((w) => (
            <li key={w.id} className="flex items-baseline gap-2 min-w-0">
              <span className="text-text-primary shrink-0">{w.name}</span>
              <span className="text-text-tertiary font-mono truncate">{w.address || 'address unknown'}</span>
            </li>
          ))}
        </ul>
        {hitsActive && (
          <p className="text-text-secondary text-xs pl-6">
            The wallet in use is among them. Afterwards the app reloads on another stored
            wallet, or on the wallet screen when none is left.
          </p>
        )}
        <p className="text-text-secondary text-xs pl-6">App settings are kept.</p>
      </div>

      {isLast ? (
        <div className="space-y-2 text-xs">
          <p className="text-text-secondary">
            <span className="text-text-primary font-medium">Keep seed</span>: the recovery
            phrase stays encrypted on this device, so you can create new wallets from it without
            retyping it.
          </p>
          <p className="text-text-secondary">
            <span className="text-text-primary font-medium">Delete seed too</span>: the phrase
            is removed as well. Funds stay on-chain, reachable only by importing your
            written-down phrase again.
          </p>
        </div>
      ) : (
        <div className="space-y-2 text-xs">
          <p className="text-text-secondary">
            The seed is removed from this device with them. Funds stay on-chain, reachable
            only by importing your written-down phrase again.
          </p>
          {lockedCount > 0 && (
            <p className="text-text-secondary">
              To keep this seed on the device instead, first delete the wallets that cannot
              be unlocked.
            </p>
          )}
        </div>
      )}
    </ReviewModal>
  )
}
