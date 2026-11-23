import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkMnemonic, checkSeedWords, cleanSeedWord, normalizeMnemonic, seedWordsIn, settleSeedWord, suggestSeedWords } from './mnemonic.ts'

// The canonical all-zero-entropy BIP-39 vectors: every word but the last is
// "abandon", and the last word IS the checksum.
const VALID_12 = `${'abandon '.repeat(11)}about`
const VALID_24 = `${'abandon '.repeat(23)}art`
// A phrase whose words actually differ, so swapping two of them changes it.
const VARIED_12 = 'abandon math mimic master filter design carbon crystal rookie group knife young'

test('a valid 12-word phrase passes', () => {
  const check = checkMnemonic(VALID_12)
  assert.equal(check.status, 'valid')
  assert.equal(check.wordCount, 12)
  assert.equal(check.phrase, VALID_12.trim())
})

test('a valid 24-word phrase passes', () => {
  assert.equal(checkMnemonic(VALID_24).status, 'valid')
})

test('every word real but the checksum wrong is rejected', () => {
  // "abandon" in place of the checksum word — 1 in 16 chance of passing by luck,
  // and this one doesn't.
  const check = checkMnemonic(`${'abandon '.repeat(11)}abandon`)
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /Checksum/)
})

test('two words swapped is caught by the checksum', () => {
  const words = VARIED_12.split(' ')
  ;[words[0], words[1]] = [words[1], words[0]]
  const check = checkMnemonic(words.join(' '))
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /Checksum/)
})

test('a misspelled word is named with its position', () => {
  const words = VALID_12.trim().split(' ')
  words[2] = 'abandonn'
  const check = checkMnemonic(words.join(' '))
  assert.equal(check.status, 'invalid')
  assert.equal(check.message, 'Not a BIP-39 word: "abandonn" (word 3)')
})

test('several misspelled words are all named', () => {
  const check = checkMnemonic(`zzz ${'abandon '.repeat(10)}qqq`)
  assert.equal(check.status, 'invalid')
  assert.equal(check.message, 'Not BIP-39 words: "zzz" (word 1), "qqq" (word 12)')
})

test('a short phrase is incomplete, not an error', () => {
  const check = checkMnemonic('abandon abandon abandon ')
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '3 of 12 words')
})

test('between 12 and 24 words counts towards 24', () => {
  const check = checkMnemonic(`${'abandon '.repeat(13)}`)
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '13 of 24 words')
})

test('more than 24 words is rejected outright', () => {
  const check = checkMnemonic('abandon '.repeat(25))
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /Too many words/)
})

test('the word being typed is not called a typo yet', () => {
  // No trailing space: "aban" could still become "abandon".
  const check = checkMnemonic('abandon aban')
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '1 of 12 words')
})

test('a half-typed last word does not trigger the checksum', () => {
  const check = checkMnemonic(`${'abandon '.repeat(11)}abou`)
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '11 of 12 words')
})

test('a typed word that can never become real is still flagged', () => {
  const check = checkMnemonic('abandon zzzz')
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /"zzzz" \(word 2\)/)
})

test('empty input says nothing', () => {
  assert.deepEqual(checkMnemonic('   '), { status: 'empty', message: '', phrase: '', wordCount: 0 })
})

test('capitals, newlines and double spaces are normalized away', () => {
  const messy = `  ABANDON\n abandon\tabandon  ${'abandon '.repeat(8)}About  `
  const check = checkMnemonic(messy)
  assert.equal(check.status, 'valid')
  assert.equal(check.phrase, VALID_12.trim())
})

test('normalizeMnemonic is what gets imported', () => {
  assert.equal(normalizeMnemonic('  Foo   BAR\nbaz '), 'foo bar baz')
})

// --- [RN-16] The import grid: one input per word ---------------------------------

const slots = (phrase: string, count: 12 | 24 = 12): string[] => {
  const words = phrase.trim().split(' ')
  return Array.from({ length: count }, (_, i) => words[i] ?? '')
}

test('[RN-16] the list shows every BIP-39 word starting with the letters typed, and narrows with each letter', () => {
  assert.deepEqual(suggestSeedWords(''), [], 'nothing typed, nothing listed')
  assert.equal(suggestSeedWords('a').length, 136)
  assert.deepEqual(suggestSeedWords('ac'), [
    'access', 'accident', 'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual',
  ])
  assert.deepEqual(suggestSeedWords('act'), ['act', 'action', 'actor', 'actress', 'actual'], 'a word others continue stays listed with them')
  assert.deepEqual(suggestSeedWords('actr'), ['actress'])
  assert.deepEqual(suggestSeedWords('actress'), [], 'a whole word nothing continues leaves nothing to choose')
  assert.deepEqual(suggestSeedWords('zzz'), [])
})

test('[RN-16] a key settles on the highlighted word, else the typed word, else the only word the letters can become', () => {
  assert.equal(settleSeedWord('ac', 'acoustic'), 'acoustic', 'the highlighted suggestion wins')
  assert.equal(settleSeedWord('act', null), 'act', 'a typed word is kept though longer words start with it')
  assert.equal(settleSeedWord('actr', null), 'actress', 'one word fits: it is completed')
  assert.equal(settleSeedWord('abandon', null), 'abandon')
})

test('[RN-16] no word is picked for the user: letters that fit several words, or none, settle on nothing', () => {
  assert.equal(settleSeedWord('ac', null), null, '"ac" fits 14 words')
  assert.equal(settleSeedWord('zzz', null), null)
  assert.equal(settleSeedWord('', null), null, 'an empty input is not completed to anything')
})

test('[RN-16] an input keeps only letters, in lower case', () => {
  assert.equal(cleanSeedWord(' Abandon1. '), 'abandon')
  assert.equal(cleanSeedWord('ab an-don'), 'abandon')
})

test('[RN-16] a pasted phrase is read as its words, whatever separates or numbers them', () => {
  const words = VARIED_12.split(' ')
  assert.deepEqual(seedWordsIn(`  ${VARIED_12.toUpperCase()}\n`), words)
  assert.deepEqual(seedWordsIn(words.join('\n')), words, 'one word per line')
  assert.deepEqual(seedWordsIn(words.map((w, i) => `${i + 1}.${w} `).join('')), words, 'the create screen\'s numbered box')
  assert.deepEqual(seedWordsIn(words.join(', ')), words)
  assert.equal(seedWordsIn(VALID_24).length, 24, '24 words are told from 12 by the count')
  assert.deepEqual(seedWordsIn('  \n '), [])
})

test('[RN-16] a word not on the list is named once its input is left, and spared while it is being typed', () => {
  const typing = slots('abandon abando')
  // Still in the second input: "abando" can become "abandon".
  assert.deepEqual(checkSeedWords(typing, 1), { status: 'incomplete', message: '1 of 12 words', phrase: '', wordCount: 2, unknown: [] })
  // The input lost focus with the word unfinished.
  const left = checkSeedWords(typing, null)
  assert.equal(left.status, 'invalid')
  assert.equal(left.message, 'Not a BIP-39 word: "abando" (word 2)')
  assert.deepEqual(left.unknown, [1])
  // Typing in another input spares only that one.
  assert.deepEqual(checkSeedWords(typing, 5).unknown, [1])
})

test('[RN-16] letters no word starts with are flagged at once, even in the input being typed in', () => {
  const check = checkSeedWords(slots('abandon zzz'), 1)
  assert.equal(check.status, 'invalid')
  assert.deepEqual(check.unknown, [1])
})

test('[RN-16] every wrong word is named by its own position, with gaps left where they are', () => {
  const words = slots('')
  words[0] = 'zzz'; words[3] = 'abandon'; words[11] = 'qqq'
  const check = checkSeedWords(words, null)
  assert.equal(check.message, 'Not BIP-39 words: "zzz" (word 1), "qqq" (word 12)')
  assert.deepEqual(check.unknown, [0, 11])
})

test('[RN-16] the grid is incomplete, not wrong, until every input holds a word', () => {
  assert.deepEqual(checkSeedWords(slots(''), null), { status: 'empty', message: '', phrase: '', wordCount: 0, unknown: [] })
  const eleven = slots(`${'abandon '.repeat(11)}`)
  assert.equal(checkSeedWords(eleven, null).message, '11 of 12 words')
  // The 24-word tab counts towards 24, and a valid 12 in it is not yet a phrase.
  const check = checkSeedWords(slots(VALID_12, 24), null)
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '12 of 24 words')
})

test('[RN-16] the final check runs when the last word is in: a valid phrase passes with the phrase to import', () => {
  const twelve = checkSeedWords(slots(VALID_12), null)
  assert.equal(twelve.status, 'valid')
  assert.equal(twelve.phrase, VALID_12)
  assert.equal(twelve.message, 'Valid 12-word seed phrase')
  const twentyFour = checkSeedWords(slots(VALID_24, 24), null)
  assert.equal(twentyFour.status, 'valid')
  assert.equal(twentyFour.phrase, VALID_24)
  // Still focused in the last input, as after typing the last word: no wait for a blur.
  assert.equal(checkSeedWords(slots(VALID_12), 11).status, 'valid')
})

test('[RN-16] the final check refuses real words whose checksum is wrong, or two words swapped', () => {
  const wrong = checkSeedWords(slots(`${'abandon '.repeat(12)}`), null)
  assert.equal(wrong.status, 'invalid')
  assert.match(wrong.message, /Checksum/)
  assert.deepEqual(wrong.unknown, [], 'no single input is to blame')
  const words = VARIED_12.split(' ')
  assert.equal(checkSeedWords(words, null).status, 'valid', 'control: the phrase in order is valid')
  ;[words[0], words[1]] = [words[1], words[0]]
  assert.match(checkSeedWords(words, null).message, /Checksum/)
})
