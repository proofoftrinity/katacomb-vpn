import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
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

const WIN_BIN = 'resources/win/bin'
const winVendored = readdirSync(WIN_BIN).filter((f) => !f.startsWith('LICENSE'))

test('[PKG-1] every vendored Windows binary matches its own pin, never the Linux one', () => {
  assert.deepEqual(winVendored.sort(), ['hysteria.exe', 'v2ray.exe', 'xray.exe'], 'a new vendored binary needs a pin in binary-integrity.ts')
  const failing = winVendored.filter((name) => !verifyBinaryIntegrity(join(WIN_BIN, name), name))
  assert.deepEqual(failing, [], 'update the pin in binary-integrity.ts in the same change as the binary')
  assert.equal(verifyBinaryIntegrity(join(WIN_BIN, 'xray.exe'), 'xray'), false, 'the Linux pin does not pass the Windows core')
  assert.equal(verifyBinaryIntegrity(join(BIN, 'xray'), 'xray.exe'), false, 'nor the Windows pin the Linux core')
})

test('[PKG-1] the vendored wintun.dll is the one in wintun.net\'s 0.14.1 zip', () => {
  // The zip's SHA2-256 is published on wintun.net (07c25618…ef51); this is the amd64 DLL
  // inside it. Only the service loads it, from Program Files, so it has no runtime pin.
  const dll = createHash('sha256').update(readFileSync('resources/win/privileged/wintun.dll')).digest('hex')
  assert.equal(dll, 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce')
})
