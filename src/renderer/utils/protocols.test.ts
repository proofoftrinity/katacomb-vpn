import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProtocolSupported, isProxyCapable, unsupportedWhere } from './protocols.ts'

test('only the child-proxy protocols qualify for local proxy mode', () => {
  // v2ray (2), xray (4) and hysteria2 (6) expose a local SOCKS5 listener.
  assert.equal(isProxyCapable(2), true)
  assert.equal(isProxyCapable(4), true)
  assert.equal(isProxyCapable(6), true)
})

test('the root-path protocols and unknown are not proxy capable', () => {
  // WireGuard (1), OpenVPN (3) and AmneziaWG (5) route the whole device or
  // nothing; unknown (0) is never connectable at all.
  for (const type of [0, 1, 3, 5]) {
    assert.equal(isProxyCapable(type), false, `type ${type}`)
  }
})

test('OpenVPN is connectable on Linux; the reason it would not be, on Windows, is said only there', () => {
  // The test runner is not Windows: Node's user agent names Node.
  assert.equal(isProtocolSupported(3), true)
  assert.equal(unsupportedWhere(3), '')
})

test('Windows: OpenVPN is listed but not connectable, the copy says why, and every other protocol connects', async () => {
  // A fresh copy of the module (the query string), loaded under Electron's Windows user agent.
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) katacomb-vpn/1.18.0 Chrome/146.0.0.0 Electron/41.10.7 Safari/537.36' },
    configurable: true,
  })
  try {
    const win = await import(new URL('./protocols.ts?windows', import.meta.url).href) as typeof import('./protocols.ts')
    assert.equal(win.IS_WINDOWS, true)
    assert.equal(win.isProtocolSupported(3), false)
    assert.equal(win.unsupportedWhere(3), ' on Windows')
    for (const type of [1, 2, 4, 5, 6]) assert.equal(win.isProtocolSupported(type), true, `type ${type}`)
  } finally {
    if (real) Object.defineProperty(globalThis, 'navigator', real)
  }
})
