/**
 * [REL-50] No two stored wallets share a name.
 *
 * Names are compared trimmed and without case, so "Main" and " main" are one name.
 * The store (`settings.ts`) is the authority; the setup screens use the same test to
 * say so before the user has generated or typed a seed. Import-free so both sides can
 * use it and the native test runner can load it.
 */

interface Named {
  id: string
  name: string
}

const key = (name: string): string => name.trim().toLowerCase()

/** Whether a wallet other than `exceptId` (the one being renamed) already has this name. */
export function isWalletNameTaken(wallets: Named[], name: string, exceptId?: string): boolean {
  const wanted = key(name)
  return wanted !== '' && wallets.some((w) => w.id !== exceptId && key(w.name) === wanted)
}

export function walletNameTakenMessage(name: string): string {
  return `A wallet named "${name.trim()}" already exists. Choose another name.`
}

/**
 * The name a wallet gets when none is typed: "Wallet N", counting up from the number
 * of stored wallets plus one. The count alone repeated a name once a wallet had been
 * deleted ("Wallet 2" left alone in the store made the next one "Wallet 2" too).
 */
export function defaultWalletName(wallets: Named[]): string {
  let n = wallets.length + 1
  while (isWalletNameTaken(wallets, `Wallet ${n}`)) n++
  return `Wallet ${n}`
}

/**
 * The startup repair for stores written before names were unique. The first wallet
 * of a name keeps it; each later one takes the name plus the lowest number from 2
 * that no wallet has ("Main", "Main" becomes "Main", "Main 2"). Returns null when no
 * name repeats, so a normal start writes nothing.
 */
export function renameDuplicateNames<T extends Named>(wallets: T[]): T[] | null {
  const taken = new Set(wallets.map((w) => key(w.name)))
  const seen = new Set<string>()
  let changed = false
  const renamed = wallets.map((wallet) => {
    if (!seen.has(key(wallet.name))) {
      seen.add(key(wallet.name))
      return wallet
    }
    const base = wallet.name.trim() || 'Wallet'
    let n = 2
    while (taken.has(key(`${base} ${n}`))) n++
    const name = `${base} ${n}`
    taken.add(key(name))
    seen.add(key(name))
    changed = true
    return { ...wallet, name }
  })
  return changed ? renamed : null
}
