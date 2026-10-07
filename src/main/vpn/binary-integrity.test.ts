import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { verifyBinaryIntegrity } from './binary-integrity.ts'

// [PKG-1] The pins are only worth anything if they match what ships. Hash the
// git-tracked vendored binaries against the table, so replacing a binary without
// its pin fails here instead of at a user's first connect.

const BIN = 'resources/linux/bin'
const vendored = readdirSync(BIN).filter((f) => !f.startsWith('LICENSE'))

test('[PKG-1] every vendored binary matches its pin', () => {
  assert.deepEqual(vendored.sort(), ['hysteria', 'v2ray', 'xray'], 'a new vendored binary needs a pin in binary-integrity.ts')
  const failing = vendored.filter((name) => !verifyBinaryIntegrity(join(BIN, name), name))
  assert.deepEqual(failing, [], 'update the pin in binary-integrity.ts in the same change as the binary')
})

test('[PKG-1] a different binary under a pinned name is refused', () => {
  assert.equal(verifyBinaryIntegrity(join(BIN, 'xray'), 'v2ray'), false)
})

test('[PKG-1] a binary with no pin is refused, not waved through', () => {
  assert.equal(verifyBinaryIntegrity(join(BIN, 'v2ray'), 'tun2socks'), false)
})

test('an unreadable path is refused', () => {
  assert.equal(verifyBinaryIntegrity(join(BIN, 'does-not-exist'), 'v2ray'), false)
})
