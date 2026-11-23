// BIP-39 checking for the import screen, live as the user types. `checkMnemonic`
// checks a whole phrase as text; the import grid ([RN-16], at the end of this file)
// checks its inputs one word at a time and ends on `checkMnemonic`.
//
// Three things can be wrong with a typed seed and they need different words:
// a word that isn't in the BIP-39 list (a typo), a phrase that isn't 12 or 24
// words, and a phrase whose every word is real but whose checksum doesn't add
// up (one word wrong or two swapped). Only the last one needs the crypto —
// @scure/bip39's validateMnemonic, the same package the app generates seeds
// with.
//
// Pure and Electron-free so it can be unit-tested; the renderer is the only
// caller. The normalized `phrase` is what must be imported — NFKD, lowercase,
// single-spaced — because that is the form the checksum was verified against
// and the only form CosmJS's EnglishMnemonic accepts.

import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

const wordSet = new Set(wordlist)

/** Trim, collapse whitespace, lowercase. Paste-friendly; the checksum is verified on this. */
export function normalizeMnemonic(value: string): string {
  return value.normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

export type MnemonicStatus =
  | 'empty'
  /** Nothing wrong yet, just not finished — never shown as an error. */
  | 'incomplete'
  | 'invalid'
  | 'valid'

export interface MnemonicCheck {
  status: MnemonicStatus
  /** Empty only when status is 'empty'. */
  message: string
  /** The form to import. Only meaningful when status is 'valid'. */
  phrase: string
  wordCount: number
}

function notWordsMessage(words: string[], unknown: number[]): string {
  const listed = unknown.map((i) => `"${words[i]}" (word ${i + 1})`).join(', ')
  return `Not ${unknown.length > 1 ? 'BIP-39 words' : 'a BIP-39 word'}: ${listed}`
}

export function checkMnemonic(value: string): MnemonicCheck {
  const phrase = normalizeMnemonic(value)
  const words = phrase ? phrase.split(' ') : []
  const wordCount = words.length
  const base = { phrase, wordCount }

  if (wordCount === 0) return { ...base, status: 'empty', message: '' }

  // The word being typed right now isn't a typo yet — exempt it while it could
  // still grow into a real word, or every phrase would flash red on the way in.
  const last = wordCount - 1
  const pending =
    !/\s$/.test(value) && wordCount <= 24 && !wordSet.has(words[last]) && wordlist.some((w) => w.startsWith(words[last]))

  const unknown: number[] = []
  words.forEach((word, i) => {
    if (wordSet.has(word)) return
    if (pending && i === last) return
    unknown.push(i)
  })

  if (unknown.length > 0) return { ...base, status: 'invalid', message: notWordsMessage(words, unknown) }

  if (wordCount > 24) {
    return { ...base, status: 'invalid', message: `Too many words: a seed phrase is 12 or 24, this is ${wordCount}` }
  }
  // A half-typed last word doesn't count towards the total yet.
  const done = pending ? wordCount - 1 : wordCount
  if (pending || (done !== 12 && done !== 24)) {
    return { ...base, status: 'incomplete', message: `${done} of ${done < 12 ? 12 : 24} words` }
  }

  if (!validateMnemonic(phrase, wordlist)) {
    return {
      ...base,
      status: 'invalid',
      message: 'Checksum does not match: a word is wrong or two are in the wrong order',
    }
  }

  return { ...base, status: 'valid', message: `Valid ${wordCount}-word seed phrase` }
}

// --- [RN-16] The import grid: one input per word ---------------------------------

/** What a word input keeps of what is typed into it: BIP-39 English words are a-z only. */
export function cleanSeedWord(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * The words of a pasted text, in order. Anything that is not a letter separates, so a
 * numbered list ("1.abandon 2.ability", what the create screen's phrase box copies as)
 * and one word per line both come out as the words alone.
 */
export function seedWordsIn(text: string): string[] {
  return text.normalize('NFKD').toLowerCase().match(/[a-z]+/g) ?? []
}

/**
 * The autocomplete list for what is typed so far: every BIP-39 word starting with it,
 * in list order. Empty for no letters, and once the word is whole and no other word
 * continues it ("abandon"), where there is nothing left to choose.
 */
export function suggestSeedWords(typed: string): string[] {
  if (!typed) return []
  const matches = wordlist.filter((w) => w.startsWith(typed))
  return matches.length === 1 && matches[0] === typed ? [] : matches
}

/**
 * The word Enter, Space or Tab leaves in an input: the suggestion the user highlighted,
 * else what is typed when that is a word, else the ONE word the letters can still
 * become. Null when several words fit or none does. A word is never picked for the
 * user: a wrong word that is real passes the per-word check, and one such phrase in 16
 * passes the 12-word checksum too, as a different wallet.
 */
export function settleSeedWord(typed: string, highlighted: string | null): string | null {
  if (highlighted !== null) return highlighted
  if (wordSet.has(typed)) return typed
  const matches = typed ? wordlist.filter((w) => w.startsWith(typed)) : []
  return matches.length === 1 ? matches[0] : null
}

export interface SeedWordsCheck extends MnemonicCheck {
  /** The slots (from 0) holding something that is not a BIP-39 word: the inputs to mark. */
  unknown: number[]
}

/**
 * The grid's check over its 12 or 24 slots, '' for one nothing was typed into.
 *
 * A word is checked against the list once its input loses focus: `editing` is the slot
 * being typed in (null when none is), and it is spared while its letters can still grow
 * into a word. Letters no word starts with are flagged at once. When every slot holds a
 * word, the final check is `checkMnemonic`'s: the checksum, and the `phrase` to import.
 */
export function checkSeedWords(slots: string[], editing: number | null): SeedWordsCheck {
  const unknown = slots.flatMap((word, i) => {
    if (!word || wordSet.has(word)) return []
    if (i === editing && wordlist.some((w) => w.startsWith(word))) return []
    return [i]
  })
  const typed = slots.filter(Boolean).length
  const base = { phrase: '', wordCount: typed, unknown }

  if (typed === 0) return { ...base, status: 'empty', message: '' }
  if (unknown.length > 0) return { ...base, status: 'invalid', message: notWordsMessage(slots, unknown) }
  const done = slots.filter((word) => wordSet.has(word)).length
  if (done < slots.length) return { ...base, status: 'incomplete', message: `${done} of ${slots.length} words` }
  // The trailing space says the last word is finished, so no word is spared here.
  return { ...checkMnemonic(`${slots.join(' ')} `), unknown }
}
