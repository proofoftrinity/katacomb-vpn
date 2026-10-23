import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProxyCapable } from './protocols.ts'

test('only the child-proxy protocols qualify for local proxy mode', () => {
  // v2ray (2), xray (4) and hysteria2 (6) expose a local SOCKS5 listener.
  assert.equal(isProxyCapable(2), true)
  assert.equal(isProxyCapable(4), true)
  assert.equal(isProxyCapable(6), true)
})

test('the root-path protocols and unknown are not proxy capable', () => {
  // WireGuard (1) and AmneziaWG (5) route the whole device or nothing;
  // unknown (0) is never connectable at all.
  for (const type of [0, 1, 5]) {
    assert.equal(isProxyCapable(type), false, `type ${type}`)
  }
})

// OpenVPN (3) was removed in 1.19.0: main drops its nodes from the feed, and anything
// else that names type 3 (an old session's node) reads as Unknown, on either OS.
function assertFiveProtocols(m: typeof import('./protocols.ts')): void {
  for (const type of [1, 2, 4, 5, 6]) assert.equal(m.isProtocolSupported(type), true, `type ${type}`)
  assert.equal(m.isProtocolSupported(3), false)
  assert.equal(m.protocolMeta(3).label, 'Unknown')
  assert.deepEqual(m.PROTOCOL_FILTER_OPTIONS.map((o) => o.value), [1, 2, 4, 5, 6])
}

test('[PRO-1] the five protocols connect; type 3 is Unknown and not a filter', async () => {
  // The test runner is not Windows: Node's user agent names Node.
  assertFiveProtocols(await import('./protocols.ts'))
})

test('[PRO-1] Windows: the same five connect, and type 3 is Unknown there too', async () => {
  // A fresh copy of the module (the query string), loaded under Electron's Windows user agent.
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) katacomb-vpn/1.18.0 Chrome/146.0.0.0 Electron/41.10.7 Safari/537.36' },
    configurable: true,
  })
  try {
    const win = await import(new URL('./protocols.ts?windows', import.meta.url).href) as typeof import('./protocols.ts')
    assert.equal(win.IS_WINDOWS, true)
    assertFiveProtocols(win)
  } finally {
    if (real) Object.defineProperty(globalThis, 'navigator', real)
  }
})
