import { useState, useRef, useMemo, useEffect, type ReactNode } from 'react'
import { checkSeedWords, cleanSeedWord, seedWordsIn, settleSeedWord, suggestSeedWords } from '../../../shared/mnemonic'
import { isWalletNameTaken, walletNameTakenMessage } from '../../../shared/wallet-names'
import { parseWalletExists } from '../../../shared/wallet-errors'
import { displayConnectError } from '../../utils/connect-errors'
import { countryCode, polyCode } from '../../utils/country-codes'
import { DENSITY_STEPS, densityStep, dotMap } from '../../utils/world-dots'
import { useNodes } from '../../hooks/useNodes'
import { SMALL_COUNTRIES, countryPoint, useWorldCountries } from '../map/world-geo'
import AppLogo from '../AppLogo'
import SetupLayout from './SetupLayout'
import { KeyIcon, LayersIcon, LockIcon, ShieldIcon } from '../Icons'
import ProtocolIcon from '../ProtocolIcon'

interface Props {
  onImport: (mnemonic: string, name?: string) => Promise<void>
  /** Present only when wallets are already stored — returns to the picker. */
  onBackToWallets?: () => void
  /** Open the wallet that already holds the entered seed's address. */
  onUseExisting: (walletId: string) => Promise<void>
  /** The stored wallets: a name one of them has cannot be taken again ([REL-50]). */
  wallets: { id: string; name: string }[]
}

/** The import grid always holds 24 slots; the 12-word tab shows and checks the first 12. */
const NO_WORDS: string[] = Array.from({ length: 24 }, () => '')

type Mode = 'choose' | 'import' | 'create'

export default function MnemonicInput({ onImport, onBackToWallets, onUseExisting, wallets }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  // Set when the entered seed is already stored: nothing was created, so offer
  // that wallet instead of leaving the user at a dead end.
  const [duplicate, setDuplicate] = useState<{ id: string; message: string } | null>(null)
  // The import grid ([RN-16]): its words, which tab is open, and the input being typed in.
  const [words, setWords] = useState(NO_WORDS)
  const [importCount, setImportCount] = useState<12 | 24>(12)
  const [editing, setEditing] = useState<number | null>(null)
  const [walletName, setWalletName] = useState('')
  const [generatedMnemonic, setGeneratedMnemonic] = useState('')
  const [wordCount, setWordCount] = useState<12 | 24>(12)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  // No unmount cleanup for this timer, on purpose [RN-9]: this screen unmounts the
  // moment the new wallet opens, and cancelling the wipe then left the phrase on the
  // clipboard for good. The callback touches only the clipboard and the ref.
  const copyClearTimer = useRef<number | null>(null)

  // Each word against the list, then the checksum, re-run on every keystroke.
  const check = useMemo(() => checkSeedWords(words.slice(0, importCount), editing), [words, importCount, editing])
  // Main refuses a name in use; saying so here spares a seed typed or generated for nothing.
  const nameTaken = isWalletNameTaken(wallets, walletName)

  async function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setDuplicate(null)
    if (check.status !== 'valid' || nameTaken) return
    setLoading(true)
    try {
      // The normalized phrase, not what was typed: it is the form the checksum
      // was verified against and the only one CosmJS accepts.
      await onImport(check.phrase, walletName.trim() || undefined)
    } catch (err) {
      handleCreateFailure(err, 'Failed to import wallet')
    } finally {
      setLoading(false)
    }
  }

  /** Shared by import and create: both go through addWalletEntry's uniqueness guard. */
  function handleCreateFailure(err: unknown, fallback: string) {
    const message = err instanceof Error ? err.message : fallback
    const existing = parseWalletExists(message)
    if (existing) {
      setDuplicate(existing)
      setError('')
      return
    }
    setError(displayConnectError(message))
  }

  async function handleGenerate() {
    setError('')
    setLoading(true)
    try {
      const phrase = await window.api.walletGenerate(wordCount)
      setGeneratedMnemonic(phrase)
      setConfirmed(false)
    } catch (err) {
      setError(displayConnectError(err instanceof Error ? err.message : 'Failed to generate mnemonic'))
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmCreate() {
    setError('')
    setLoading(true)
    try {
      await onImport(generatedMnemonic, walletName.trim() || undefined)
    } catch (err) {
      handleCreateFailure(err, 'Failed to create wallet')
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(generatedMnemonic).catch(() => {})
    // Don't let the seed linger on the clipboard — clear it after 30s (finding M5).
    if (copyClearTimer.current !== null) window.clearTimeout(copyClearTimer.current)
    copyClearTimer.current = window.setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {})
      copyClearTimer.current = null
    }, 30_000)
  }

  function handleBack() {
    setMode('choose')
    setWords(NO_WORDS)
    setImportCount(12)
    setEditing(null)
    setWalletName('')
    setGeneratedMnemonic('')
    setError('')
    setDuplicate(null)
    setConfirmed(false)
  }

  /** Nothing was created — that seed is already on this device. */
  function duplicatePanel() {
    if (!duplicate) return null
    return (
      <div className="bg-warning-subtle border border-warning p-3 rounded-md space-y-2">
        <p className="text-warning text-sm">{duplicate.message}</p>
        <button
          type="button"
          onClick={() => onUseExisting(duplicate.id)}
          className="btn btn-secondary w-full"
        >
          Use that wallet
        </button>
      </div>
    )
  }

  // --- Choose screen ---
  const choices = (
    <div className="space-y-2.5">
      <button
        onClick={() => setMode('create')}
        className="btn btn-primary w-full"
      >
        Create a new wallet
      </button>
      <button
        onClick={() => setMode('import')}
        className="btn btn-secondary w-full"
      >
        Import an existing wallet
      </button>
    </div>
  )

  // First run: nothing is stored, so this is the first screen a new install shows. It
  // says what the app is, shows the network live, and says what the user will need
  // (P2P to pay with) before asking for anything. The card is vertically centred and
  // the map takes up the slack, so the buttons are on screen at the 960x600 minimum.
  if (mode === 'choose' && !onBackToWallets) {
    return (
      <div className="h-full overflow-y-auto setup-backdrop">
        <div className="h-full max-w-6xl mx-auto px-10 grid grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem] gap-10 xl:gap-16">
          <section className="min-h-0 flex flex-col gap-5 py-8">
            <header className="space-y-4 shrink-0">
              <div className="flex items-center gap-4">
                <AppLogo size={56} className="shrink-0" />
                <div>
                  <h1 className="text-text-primary font-semibold text-3xl tracking-tight">Katacomb VPN</h1>
                  <p className="text-accent">A decentralized VPN client</p>
                </div>
              </div>
              {/* The rest of the old paragraph is the "You hold the keys" highlight below ([RN-15]). */}
              <p className="text-text-secondary text-sm leading-relaxed max-w-xl">
                Connect through independent nodes all over the world, with no account and no single provider.
              </p>
            </header>

            <NetworkMap />

            <ul className="grid grid-cols-2 gap-x-8 gap-y-4 shrink-0">
              <Highlight icon={<KeyIcon className="w-4 h-4" />} title="You hold the keys">
                No sign-up. Your wallet pays each node directly, on chain.
              </Highlight>
              <Highlight icon={<ProtocolIcon type={1} className="w-4 h-4" />} title="Five protocols">
                WireGuard, AmneziaWG, V2Ray, XRAY and Hysteria2.
              </Highlight>
              <Highlight icon={<LayersIcon className="w-4 h-4" />} title="Multi-hop">
                Chain two nodes: one sees your IP, the other the sites, neither sees both.
              </Highlight>
              <Highlight icon={<ShieldIcon className="w-4 h-4" />} title="Kill switch and your own DNS">
                Block everything outside the tunnel, and pick the resolver your lookups go to.
              </Highlight>
            </ul>
          </section>

          <aside className="self-center py-8">
            <div className="bg-bg-secondary border border-border rounded-lg shadow-overlay p-6 space-y-6">
              <h2 className="text-text-primary font-semibold text-lg">Get started</h2>
              <ol>
                <Step n={1} title="Create or import a wallet">
                  Make a new one here, or bring one you have with its recovery phrase.
                </Step>
                <Step n={2} title="Add P2P">
                  The network's token. Send some to your wallet's address from an exchange or
                  another wallet.
                </Step>
                <Step n={3} title="Pick a node and connect" last>
                  Pay it by the gigabyte or by the hour, or subscribe to a plan, and Katacomb
                  brings the tunnel up.
                </Step>
              </ol>
              {choices}
              <p className="flex gap-2 text-text-tertiary text-xs leading-relaxed">
                <LockIcon className="w-3.5 h-3.5 shrink-0 mt-px" />
                Your recovery phrase is encrypted by your system keyring and never leaves this
                device.
              </p>
            </div>
          </aside>
        </div>
      </div>
    )
  }

  // Adding another wallet: the user already knows the app, so just the choice.
  if (mode === 'choose') {
    return (
      <SetupLayout>
        <div className="w-full max-w-xl space-y-8">
          <div className="space-y-3">
            <button
              type="button"
              onClick={onBackToWallets}
              className="text-text-secondary text-sm hover:text-accent transition-colors"
            >
              &larr; Back to my wallets
            </button>
            <h1 className="text-text-primary font-semibold text-2xl">
              Add a wallet
            </h1>
            <p className="text-text-secondary text-sm leading-relaxed">
              Add another wallet by creating a new one or importing an existing seed phrase.
            </p>
          </div>

          {choices}

          <p className="flex justify-center gap-2 text-text-tertiary text-xs">
            <LockIcon className="w-3.5 h-3.5 shrink-0" />
            Your recovery phrase is encrypted by your system keyring and never leaves this device.
          </p>
        </div>
      </SetupLayout>
    )
  }

  // --- Import screen ---
  if (mode === 'import') {
    return (
      <SetupLayout>
        <form onSubmit={handleImportSubmit} className="w-full max-w-xl space-y-6">
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleBack}
              className="text-text-secondary text-sm hover:text-accent transition-colors"
            >
              &larr; Back
            </button>
            <h1 className="text-text-primary font-semibold text-2xl">
              Import Wallet
            </h1>
            <p className="text-text-secondary text-sm">
              Type your recovery phrase one word per box, or paste all of it into any box.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-text-secondary text-sm font-medium block">
              Wallet Name <span className="text-text-tertiary font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={walletName}
              onChange={(e) => setWalletName(e.target.value)}
              placeholder="e.g. Cold Storage"
              maxLength={100}
              className="w-full bg-bg-tertiary border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-hidden focus:border-border-focus rounded-md"
              autoComplete="off"
            />
            {nameTaken && <p className="text-danger text-sm">{walletNameTakenMessage(walletName)}</p>}
          </div>

          <div className="space-y-2">
            <span className="text-text-secondary text-sm font-medium block">
              Recovery phrase
            </span>
            <SeedGrid
              count={importCount}
              words={words}
              editing={editing}
              unknown={check.unknown}
              onCount={setImportCount}
              onWords={(next) => { setWords(next); if (error) setError('') }}
              onEditing={setEditing}
            />
            {error ? (
              <p className="text-danger text-sm">{error}</p>
            ) : check.message ? (
              <p
                role="status"
                className={`text-sm ${
                  check.status === 'valid'
                    ? 'text-success'
                    : check.status === 'invalid'
                      ? 'text-danger'
                      : 'text-text-tertiary'
                }`}
              >
                {check.status === 'valid' ? '✓ ' : ''}{check.message}
              </p>
            ) : null}
          </div>

          {duplicatePanel()}

          <button
            type="submit"
            disabled={loading || check.status !== 'valid' || nameTaken}
            className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {loading ? 'Importing...' : 'Import Wallet'}
          </button>
        </form>
      </SetupLayout>
    )
  }

  // --- Create screen ---
  return (
    <SetupLayout>
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleBack}
            className="text-text-secondary text-sm hover:text-accent transition-colors"
          >
            &larr; Back
          </button>
          <h1 className="text-text-primary font-semibold text-2xl">
            Create Wallet
          </h1>
          <p className="text-text-secondary text-sm leading-relaxed">
            Generate a new BIP-39 mnemonic. Write it down and store it safely: this is the only way to recover your wallet.
          </p>
        </div>

        {!generatedMnemonic ? (
          <>
            <div className="space-y-2">
              <label className="text-text-secondary text-sm font-medium block">
                Wallet Name <span className="text-text-tertiary font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g. Daily Driver"
                maxLength={100}
                className="w-full bg-bg-tertiary border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-hidden focus:border-border-focus rounded-md"
                autoComplete="off"
              />
              {nameTaken && <p className="text-danger text-sm">{walletNameTakenMessage(walletName)}</p>}
            </div>

            <div className="space-y-2">
              <label className="text-text-secondary text-sm font-medium block">
                Word Count
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => setWordCount(12)}
                  className={`flex-1 py-2 px-4 text-sm border transition-colors rounded-md ${
                    wordCount === 12
                      ? 'bg-accent border-accent text-text-on-accent'
                      : 'border-border text-text-secondary hover:border-text-secondary'
                  }`}
                >
                  12 words
                </button>
                <button
                  onClick={() => setWordCount(24)}
                  className={`flex-1 py-2 px-4 text-sm border transition-colors rounded-md ${
                    wordCount === 24
                      ? 'bg-accent border-accent text-text-on-accent'
                      : 'border-border text-text-secondary hover:border-text-secondary'
                  }`}
                >
                  24 words
                </button>
              </div>
            </div>

            {error && (
              <p className="text-danger text-sm">{error}</p>
            )}

            <button
              onClick={handleGenerate}
              disabled={loading || nameTaken}
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading ? 'Generating...' : 'Generate Mnemonic'}
            </button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-text-secondary text-sm font-medium">
                  Your Mnemonic
                </label>
                <button
                  onClick={handleCopy}
                  className="text-text-secondary text-sm hover:text-accent transition-colors"
                >
                  Copy
                </button>
              </div>
              <div className="bg-bg-tertiary border border-border p-4 font-mono text-sm text-text-primary select-all leading-relaxed rounded-md">
                {generatedMnemonic.split(' ').map((word, i) => (
                  <span key={i}>
                    <span className="text-text-tertiary">{i + 1}.</span>{word}{' '}
                  </span>
                ))}
              </div>
            </div>

            {/* No "last time you see it" claim: Settings, Wallets, Recovery phrase shows the phrase again. */}
            <div className="bg-danger-subtle border border-danger p-3 rounded-md">
              <p className="text-danger text-sm" data-full>
                Write down these words in order and store them in a safe place. Anyone with this phrase can access your funds.
              </p>
            </div>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              <span className="text-text-secondary text-sm">
                I have written down my mnemonic and stored it safely
              </span>
            </label>

            {error && (
              <p className="text-danger text-sm">{error}</p>
            )}

            {duplicatePanel()}

            <button
              onClick={handleConfirmCreate}
              disabled={loading || !confirmed}
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating wallet...' : 'Create Wallet'}
            </button>
          </>
        )}
      </div>
    </SetupLayout>
  )
}

/** The 12 / 24 choice, as the create screen draws it. */
const COUNT_TAB = 'flex-1 py-2 px-4 text-sm border transition-colors rounded-md'
const COUNT_TAB_ON = 'bg-accent border-accent text-text-on-accent'
const COUNT_TAB_OFF = 'border-border text-text-secondary hover:border-text-secondary'
const WORD_INPUT =
  'w-full bg-bg-tertiary border pl-8 pr-2 py-1.5 font-mono text-sm text-text-primary focus:outline-hidden rounded-md'

/**
 * The import screen's recovery phrase ([RN-16]): a 12 / 24 tab and one input per word.
 * Each input lists the BIP-39 words that start with what is typed; Up and Down move
 * through the list, and Enter, Space, Tab or a click take a word and move on. Pasting a
 * whole phrase into any input picks the tab and fills every input. What counts as a
 * word, what is listed and what a key settles on are `shared/mnemonic.ts`'s to decide.
 */
function SeedGrid({ count, words, editing, unknown, onCount, onWords, onEditing }: {
  count: 12 | 24
  /** All 24 slots; the first `count` are shown. */
  words: string[]
  /** The input being typed in, spared the word check until it loses focus. */
  editing: number | null
  /** The inputs to mark as not a BIP-39 word. */
  unknown: number[]
  onCount: (count: 12 | 24) => void
  onWords: (words: string[]) => void
  onEditing: (index: number | null) => void
}) {
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const list = useRef<HTMLUListElement | null>(null)
  // The list shows for the focused input until Escape or a settled word closes it.
  const [listOpen, setListOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [pasteNote, setPasteNote] = useState('')

  const suggestions = useMemo(
    () => (listOpen && editing !== null ? suggestSeedWords(words[editing]) : []),
    [listOpen, editing, words],
  )

  // Keep the highlighted word in sight while the keys move through a long list.
  useEffect(() => {
    list.current?.children[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  function setWord(index: number, word: string) {
    const next = words.slice()
    next[index] = word
    onWords(next)
  }

  function closeList() {
    setListOpen(false)
    setHighlight(-1)
  }

  /** Put a word in its input and move to the next one; the last input keeps the focus. */
  function take(index: number, word: string) {
    if (word !== words[index]) setWord(index, word)
    closeList()
    if (index < count - 1) inputs.current[index + 1]?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>, index: number) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      e.preventDefault()
      const n = suggestions.length
      setHighlight((h) => (e.key === 'ArrowDown' ? (h + 1) % n : h <= 0 ? n - 1 : h - 1))
      return
    }
    if (e.key === 'Escape') {
      if (suggestions.length === 0) return
      e.preventDefault()
      closeList()
      return
    }
    // A fresh press only: a held Backspace stops at the empty input instead of running
    // back through the words before it.
    if (e.key === 'Backspace' && !e.repeat && words[index] === '' && index > 0) {
      e.preventDefault()
      inputs.current[index - 1]?.focus()
      return
    }
    if (e.key !== 'Enter' && e.key !== ' ' && !(e.key === 'Tab' && !e.shiftKey)) return

    const word = settleSeedWord(words[index], highlight >= 0 ? suggestions[highlight] : null)
    if (word === null) {
      // Several words fit, or none. Enter and Space wait for more letters; Tab moves on
      // and the word check names what was left behind.
      if (e.key !== 'Tab') e.preventDefault()
      return
    }
    if (e.key === 'Tab') {
      // The browser moves the focus itself, to the next input or out of the grid.
      if (word !== words[index]) setWord(index, word)
      closeList()
      return
    }
    // Enter on a finished last word is left to the form: it imports a valid phrase.
    if (e.key === 'Enter' && index === count - 1 && word === words[index]) {
      closeList()
      return
    }
    e.preventDefault()
    take(index, word)
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = seedWordsIn(e.clipboardData.getData('text'))
    // One word lands in this input like typed text.
    if (pasted.length < 2) return
    e.preventDefault()
    if (pasted.length !== 12 && pasted.length !== 24) {
      setPasteNote(`A recovery phrase is 12 or 24 words. What you pasted has ${pasted.length}.`)
      return
    }
    setPasteNote('')
    onCount(pasted.length)
    onWords([...pasted, ...NO_WORDS.slice(pasted.length)])
    // No input is spared: every pasted word is checked now, and then the checksum.
    onEditing(null)
    closeList()
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-3" role="group" aria-label="Number of words">
        {([12, 24] as const).map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={count === n}
            onClick={() => onCount(n)}
            className={`${COUNT_TAB} ${count === n ? COUNT_TAB_ON : COUNT_TAB_OFF}`}
          >
            {n} words
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2">
        {words.slice(0, count).map((word, i) => {
          const open = editing === i && suggestions.length > 0
          return (
            <div key={i} className="relative">
              <span
                aria-hidden
                className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary text-xs tabular-nums pointer-events-none"
              >
                {i + 1}
              </span>
              <input
                ref={(el) => { inputs.current[i] = el }}
                type="text"
                value={word}
                role="combobox"
                aria-label={`Word ${i + 1}`}
                aria-invalid={unknown.includes(i)}
                aria-expanded={open}
                aria-controls="seed-suggestions"
                aria-autocomplete="list"
                aria-activedescendant={open && highlight >= 0 ? `seed-suggestion-${highlight}` : undefined}
                onChange={(e) => {
                  setWord(i, cleanSeedWord(e.target.value))
                  onEditing(i)
                  setListOpen(true)
                  setHighlight(-1)
                  setPasteNote('')
                }}
                onFocus={() => { onEditing(i); setListOpen(true); setHighlight(-1) }}
                onBlur={() => { if (editing === i) onEditing(null) }}
                onKeyDown={(e) => handleKeyDown(e, i)}
                onPaste={handlePaste}
                maxLength={8}
                className={`${WORD_INPUT} ${unknown.includes(i) ? 'border-danger' : 'border-border focus:border-border-focus'}`}
                autoFocus={i === 0}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
              />
              {open && (
                <ul
                  ref={list}
                  id="seed-suggestions"
                  role="listbox"
                  aria-label={`Words starting with ${word}`}
                  className="absolute z-10 left-0 right-0 top-full mt-1 max-h-44 overflow-y-auto bg-bg-secondary border border-border rounded-md shadow-overlay py-1"
                >
                  {suggestions.map((s, j) => (
                    <li
                      key={s}
                      id={`seed-suggestion-${j}`}
                      role="option"
                      aria-selected={j === highlight}
                      // mousedown, not click: a click would blur the input first and close the list.
                      onMouseDown={(e) => { e.preventDefault(); take(i, s) }}
                      onMouseEnter={() => setHighlight(j)}
                      className={`px-2 py-1 font-mono text-sm cursor-pointer ${
                        j === highlight ? 'bg-accent-subtle text-text-primary' : 'text-text-secondary'
                      }`}
                    >
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      {pasteNote && <p className="text-danger text-sm">{pasteNote}</p>}
    </div>
  )
}

/** One of the welcome's four points: what the app does, in a line. */
function Highlight({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 min-w-0">
      <span className="w-8 h-8 shrink-0 rounded-md bg-accent-subtle text-accent grid place-items-center">{icon}</span>
      <div className="min-w-0">
        <div className="text-text-primary text-sm font-medium">{title}</div>
        <p className="text-text-secondary text-xs leading-relaxed mt-0.5">{children}</p>
      </div>
    </li>
  )
}

/** A numbered step of Get started, joined to the next one by a hairline. */
function Step({ n, title, last = false, children }: { n: number; title: string; last?: boolean; children: ReactNode }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span aria-hidden className="absolute left-3 top-7 bottom-1 w-px bg-border" />}
      <span className="w-6 h-6 shrink-0 rounded-full bg-accent-subtle text-accent text-xs font-semibold grid place-items-center">
        {n}
      </span>
      <div className="min-w-0 pt-0.5">
        <div className="text-text-primary text-sm font-medium">{title}</div>
        <p className="text-text-secondary text-xs leading-relaxed mt-0.5">{children}</p>
      </div>
    </li>
  )
}

const MAP_W = 640
const MAP_PITCH = 5
// Written out in full for Tailwind; global.css defines them.
const DOT_CLASS = ['network-dot-0', 'network-dot-1', 'network-dot-2', 'network-dot-3'] as const
const DOT_R = [1.35, 1.6, 1.65, 1.7] as const

/**
 * Where the nodes are right now: the land as dots, each country lit by how many nodes
 * it holds. The list is the one main fetches at launch and every minute for the Map
 * tab, so this makes no request of its own, and it is counted through useNodes with
 * the Nodes tab's default filters, so the figure is the one the Map tab shows once the
 * wallet is set up. Static SVG: it redraws only when the list changes.
 */
function NetworkMap() {
  const world = useWorldCountries()
  const { nodes, lastFetched, error, refresh } = useNodes()
  const map = useMemo(() => {
    if (!world) return null
    const byCode = new Map(world.map((f) => [polyCode(f), f]))
    return dotMap({
      world,
      codeOf: polyCode,
      pointOf: (code) => countryPoint(code, byCode),
      extraCodes: Object.keys(SMALL_COUNTRIES),
      width: MAP_W,
      pitch: MAP_PITCH,
    })
  }, [world])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes) {
      const code = countryCode(n.country)
      if (code) m.set(code, (m.get(code) ?? 0) + 1)
    }
    return m
  }, [nodes])

  const figure = lastFetched
    ? `${nodes.length.toLocaleString('en-US')} nodes online in ${counts.size} ${counts.size === 1 ? 'country' : 'countries'}`
    : null

  return (
    <figure className="flex-1 min-h-[120px] flex flex-col gap-3">
      <div className="flex-1 min-h-0">
        {map && (
          <svg
            viewBox={`0 0 ${map.width} ${map.height}`}
            preserveAspectRatio="xMinYMid meet"
            role="img"
            aria-label={figure ? `World map of the nodes: ${figure}` : 'World map of the nodes'}
            className="w-full h-full block"
          >
            {map.dots.map((d) => {
              const step = densityStep(counts.get(d.code) ?? 0)
              return <circle key={`${d.x},${d.y}`} cx={d.x} cy={d.y} r={DOT_R[step]} className={DOT_CLASS[step]} />
            })}
          </svg>
        )}
      </div>
      <figcaption className="flex items-center justify-between gap-4 flex-wrap shrink-0">
        {figure ? (
          <span
            className="text-text-primary text-sm"
            title="Active nodes that passed the node directory's latest health check, as the Nodes tab counts them. Refreshed every minute."
          >
            {figure}
          </span>
        ) : error ? (
          <span className="text-text-secondary text-sm flex items-center gap-2">
            The node list could not be loaded.
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-accent hover:text-accent-hover transition-colors"
            >
              Retry
            </button>
          </span>
        ) : (
          <span role="status" aria-label="Loading the node list" className="skeleton h-4 w-56" />
        )}
        <span className="flex items-center gap-3 text-[11px] text-text-tertiary">
          Nodes per country
          {DENSITY_STEPS.map((s, i) => (
            <span key={s.label} className="flex items-center gap-1">
              <svg width="8" height="8" aria-hidden="true">
                <circle cx="4" cy="4" r="3.5" className={DOT_CLASS[i + 1]} />
              </svg>
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  )
}
