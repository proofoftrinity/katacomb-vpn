import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWalletName, isWalletNameTaken, renameDuplicateNames, walletNameTakenMessage } from './wallet-names.ts'

const STORE = [
  { id: 'w1', name: 'Main' },
  { id: 'w2', name: 'Spare' },
]

test('[REL-50] a name is taken whatever its case or outer spaces, and free otherwise', () => {
  for (const name of ['Main', 'main', 'MAIN', '  Main ', 'spare']) {
    assert.equal(isWalletNameTaken(STORE, name), true, `"${name}" was let through`)
  }
  // Control: a name no wallet has, and no name at all (the store picks one).
  for (const name of ['Main 2', 'Mainnet', 'Ma in', '', '   ']) {
    assert.equal(isWalletNameTaken(STORE, name), false, `"${name}" was refused`)
  }
})

test('[REL-50] a rename does not clash with the wallet being renamed, only with the others', () => {
  assert.equal(isWalletNameTaken(STORE, 'MAIN', 'w1'), false)
  assert.equal(isWalletNameTaken(STORE, 'MAIN', 'w2'), true)
})

test('[REL-50] the message names the name as it will be stored', () => {
  assert.equal(walletNameTakenMessage('  Main '), 'A wallet named "Main" already exists. Choose another name.')
})

test('[REL-50] an unnamed wallet takes the next "Wallet N" that is free', () => {
  assert.equal(defaultWalletName([]), 'Wallet 1')
  assert.equal(defaultWalletName(STORE), 'Wallet 3')
  // "Wallet 1" was deleted: the count alone would name a second "Wallet 2".
  assert.equal(defaultWalletName([{ id: 'a', name: 'Wallet 2' }]), 'Wallet 3')
  assert.equal(defaultWalletName([{ id: 'a', name: 'wallet 2' }, { id: 'b', name: 'Wallet 3' }]), 'Wallet 4')
})

test('[REL-50] the startup repair renames every later wallet of a name and leaves the first', () => {
  const store = [
    { id: 'a', name: 'Main', address: 'sent1aaa' },
    { id: 'b', name: 'Main', address: 'sent1bbb' },
    { id: 'c', name: 'main ', address: 'sent1ccc' },
    { id: 'd', name: 'Spare', address: 'sent1ddd' },
  ]
  assert.deepEqual(renameDuplicateNames(store), [
    { id: 'a', name: 'Main', address: 'sent1aaa' },
    { id: 'b', name: 'Main 2', address: 'sent1bbb' },
    { id: 'c', name: 'main 3', address: 'sent1ccc' },
    { id: 'd', name: 'Spare', address: 'sent1ddd' },
  ])
})

test('[REL-50] the repair never renames onto a name another wallet holds', () => {
  const renamed = renameDuplicateNames([
    { id: 'a', name: 'Main' },
    { id: 'b', name: 'Main' },
    { id: 'c', name: 'Main 2' },
    { id: 'd', name: '' },
    { id: 'e', name: '' },
  ])
  assert.deepEqual(renamed?.map((w) => w.name), ['Main', 'Main 3', 'Main 2', '', 'Wallet 2'])
})

test('[REL-50] a store with no repeated name is left alone, so a second run changes nothing', () => {
  assert.equal(renameDuplicateNames(STORE), null)
  const once = renameDuplicateNames([{ id: 'a', name: 'Main' }, { id: 'b', name: 'Main' }])
  assert.ok(once)
  assert.equal(renameDuplicateNames(once), null)
})
