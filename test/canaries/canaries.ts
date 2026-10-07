// Mutation canaries: one deliberate regression per rule that guards money, root or
// privacy, and the tests that must go red when it lands. `npm run test:canaries`
// applies each to a private copy of the working tree and requires its run to FAIL;
// a canary the suite survives means the rule is no longer guarded.
//
// `find` must match exactly once in `file`, or the canary itself fails with "re-aim":
// an anchor that drifted is a canary that silently stopped testing anything.
// Add one with every money / root / privacy rule (docs/testing.md).

export interface Canary {
  /** `[ID] what breaks`; the registry checks every cited ID exists. */
  name: string
  file: string
  find: string
  replace: string
  /** What must go red: node test files, or `go:<pkg>` for a daemon package. */
  run: string[]
}

const MONEY = 'src/main/ipc-handlers.money.test.ts'
const LIFE = 'src/main/ipc-handlers.lifecycle.test.ts'
const WALLET = 'src/main/ipc-handlers.wallet.test.ts'
const TRUST = 'src/main/ipc-handlers.trust.test.ts'
const ENTRY = 'test/static/entry-points.test.ts'
const IPC_TS = 'src/main/ipc-handlers.ts'

export const CANARIES: Canary[] = [
  // --- money --------------------------------------------------------------------
  {
    name: '[REL-1] a failed handshake is not refunded',
    file: IPC_TS,
    find: "      await withTimeout(endSession({ wallet, address, sessionId }), REFUND_TIMEOUT_MS, 'refund')\n      refunded = true",
    replace: '      refunded = true',
    run: [MONEY],
  },
  {
    name: '[REL-1] a purchase handshakes without the refund wrapper',
    file: IPC_TS,
    find: '      const result = await establishSessionOrRefund({\n        sessionId,\n        nodeAddress: params.nodeAddress,\n        nodeType: params.nodeType,\n        apiField: params.apiField,\n        nodeMoniker: params.nodeMoniker,\n        nodeCountry: params.nodeCountry,\n        wallet,\n        address,\n        privKey,\n        isDeposit: true,\n        remoteUrl,',
    replace: '      const result = await performHandshake({\n        sessionId,\n        nodeAddress: params.nodeAddress,\n        nodeType: params.nodeType,\n        apiField: params.apiField,\n        nodeMoniker: params.nodeMoniker,\n        nodeCountry: params.nodeCountry,\n        wallet,\n        address,\n        privKey,\n        isDeposit: true,\n        remoteUrl,',
    run: [MONEY, ENTRY],
  },
  {
    name: '[MH-6] every chain hop is refunded with the entry wallet',
    file: IPC_TS,
    find: '    const signer = byId.get(sessionId)!',
    replace: '    const signer = paid[0].signer',
    run: [MONEY],
  },
  {
    name: '[MH-6] chain refunds go out in parallel',
    file: IPC_TS,
    find: '  return refundEachInTurn(paid.map((p) => p.sessionId), async (sessionId) => {',
    replace: '  const each = async (ids: string[], fn: (id: string) => Promise<void>) =>\n    Promise.all(ids.map(async (id) => { try { await fn(id); return { sessionId: id, refunded: true } } catch { return { sessionId: id, refunded: false } } }))\n  void refundEachInTurn\n  return each(paid.map((p) => p.sessionId), async (sessionId) => {',
    run: [MONEY],
  },
  {
    name: '[REL-11] the preflight skips the machine check',
    file: IPC_TS,
    find: '  await assertSystemReady(protocol, tunnel, true)\n',
    replace: '',
    run: [MONEY],
  },
  {
    name: "[REL-11] the preflight ignores the node's own protocol",
    file: IPC_TS,
    find: '  if (actualType !== nodeType) {',
    replace: '  if (actualType !== nodeType && false) {',
    run: [MONEY],
  },

  // --- one connection, the lock, the epoch ----------------------------------------
  {
    name: '[REL-3] a purchase handler forgets assertNotConnected',
    file: IPC_TS,
    find: "    // untouched but a session is live all the same (see assertNotConnected).\n    assertNotConnected()\n\n    // Phase A — same shape",
    replace: "    // untouched but a session is live all the same (see assertNotConnected).\n\n    // Phase A — same shape",
    run: [LIFE, ENTRY],
  },
  {
    name: '[REL-2] the queued reconnect attempt ignores the epoch',
    file: IPC_TS,
    find: '      if (connectionEpoch !== myEpoch) return\n',
    replace: '',
    run: [LIFE],
  },
  {
    name: '[REL-2] a disconnect does not bump the epoch',
    file: IPC_TS,
    find: '  connectionEpoch++\n  if (reconnectTimer) {\n    clearTimeout(reconnectTimer)\n    reconnectTimer = null\n  }\n  reconnectAttempt = 0\n\n  return withConnectionLock',
    replace: '  if (reconnectTimer) {\n    clearTimeout(reconnectTimer)\n    reconnectTimer = null\n  }\n  reconnectAttempt = 0\n\n  return withConnectionLock',
    run: [LIFE],
  },
  {
    name: '[REL-2] a mid-bring-up attempt finishes after the user disconnected',
    file: IPC_TS,
    find: '        if (connectionEpoch !== myEpoch) {\n          await teardownToIdle(false)\n          return\n        }\n',
    replace: '',
    run: [LIFE],
  },
  {
    name: '[REL-2] CONNECTION_CONNECT runs outside the lock',
    file: IPC_TS,
    find: '    return withConnectionLock(async () => {\n      // Inside the lock, so a connect queued',
    replace: '    return (async (fn: () => Promise<unknown>) => fn())(async () => {\n      // Inside the lock, so a connect queued',
    run: [LIFE, ENTRY],
  },
  {
    name: '[REL-2] the reconnect give-up tears down outside the lock again',
    file: IPC_TS,
    find: '    const epoch = connectionEpoch\n    await withConnectionLock(async () => {\n      if (connectionEpoch !== epoch || reconnectAttempt === 0) return\n      await teardownToIdle(true)\n    })\n    return',
    replace: '    await teardownToIdle(true)\n    return',
    run: [LIFE, ENTRY],
  },
  {
    name: '[REL-13] a failed connect forgets the paid config',
    file: IPC_TS,
    find: 'async function assertTunnelCarriesTraffic(): Promise<void> {\n  if (await tunnelCarriesTraffic()) return',
    replace: 'async function assertTunnelCarriesTraffic(): Promise<void> {\n  if (await tunnelCarriesTraffic()) return\n  activeWgConfig = null',
    run: [LIFE],
  },
  {
    name: '[REL-13] the stash wins over the config CONNECT is handed',
    file: IPC_TS,
    find: '          // a failed connect, and RECONNECT re-points the session without clearing it).\n          const base = params.configString ?? activeWgConfig',
    replace: '          // a failed connect, and RECONNECT re-points the session without clearing it).\n          const base = activeWgConfig ?? params.configString',
    run: [LIFE],
  },

  // --- the wallet ------------------------------------------------------------------
  {
    name: '[REL-4] the wallet can be switched while connected',
    file: IPC_TS,
    find: "    assertNotConnected('switching wallets')\n",
    replace: '',
    run: [WALLET, ENTRY],
  },
  {
    name: '[REL-4] SETTINGS_SET can write activeWalletId',
    file: IPC_TS,
    find: "      'bookmarkedNodes', 'splitTunnelRoutes',\n    ])",
    replace: "      'bookmarkedNodes', 'splitTunnelRoutes', 'activeWalletId',\n    ])",
    run: [WALLET, ENTRY],
  },

  // --- the IPC boundary ------------------------------------------------------------
  {
    name: '[ARCH-2] any sender is trusted',
    file: IPC_TS,
    find: 'function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {\n',
    replace: 'function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {\n  if (event) return true\n',
    run: [TRUST],
  },
  {
    name: '[ARCH-2] a second door into main',
    file: IPC_TS,
    find: '  ipcMain.handle(channel, (event, ...args) => {',
    replace: "  ipcMain.on('x', () => undefined)\n  ipcMain.handle(channel, (event, ...args) => {",
    run: ['test/static/ipc-contract.test.ts'],
  },
  {
    name: '[ARCH-4] a preload method nothing calls',
    file: 'src/preload/index.ts',
    find: '  priceToken: () => ipcRenderer.invoke(IPC.PRICE_TOKEN),',
    replace: '  priceToken: () => ipcRenderer.invoke(IPC.PRICE_TOKEN),\n  priceTokenAgain: () => ipcRenderer.invoke(IPC.PRICE_TOKEN),',
    run: ['test/static/ipc-contract.test.ts'],
  },

  // --- root, the binaries, the build -----------------------------------------------
  {
    name: '[PH-8] a privileged call goes synchronous',
    file: 'src/main/vpn/kill-switch.ts',
    find: "import { app } from 'electron'",
    replace: "import { app } from 'electron'\nimport { execFileSync } from 'child_process'\nexport const freeze = () => execFileSync('pkexec', ['true'])",
    run: ['test/static/no-sync-exec.test.ts'],
  },
  {
    name: '[PKG-1] an unpinned binary is waved through',
    file: 'src/main/vpn/binary-integrity.ts',
    find: '  if (!expected) return false',
    replace: '  if (!expected) return true',
    run: ['src/main/vpn/binary-integrity.test.ts'],
  },
  {
    name: '[ARCH-3] a dependency left out of DEPS_TO_BUNDLE',
    file: 'electron.vite.config.ts',
    find: "  'long',\n",
    replace: '',
    run: ['test/static/bundling.test.ts'],
  },
  {
    name: '[NT-1] the TypeScript guard accepts PostUp',
    file: 'src/main/config-guard.ts',
    find: "const WG_INTERFACE_KEYS = new Set(['privatekey', 'address', 'dns', 'mtu', 'listenport'])",
    replace: "const WG_INTERFACE_KEYS = new Set(['privatekey', 'address', 'dns', 'mtu', 'listenport', 'postup'])",
    run: ['src/main/config-guard-corpus.test.ts', 'src/main/config-guard.test.ts'],
  },
  {
    name: '[NT-1] the root-side guard accepts PostUp',
    file: 'daemon/internal/guard/guard.go',
    find: '	wgInterfaceKeys = set("privatekey", "address", "dns", "mtu", "listenport")',
    replace: '	wgInterfaceKeys = set("privatekey", "address", "dns", "mtu", "listenport", "postup")',
    run: ['go:./internal/guard/'],
  },
  {
    name: '[REL-8] the daemon arms the kill switch for 0.0.0.0',
    file: 'daemon/internal/server/dispatch.go',
    find: '		if remote == "0.0.0.0" {',
    replace: '		if remote == "never" {',
    run: ['go:./internal/server/'],
  },
  {
    name: '[REL-26] the kill switch REJECTs instead of dropping',
    file: 'daemon/internal/ops/killswitch.go',
    find: '		rules = append(rules, []string{"-A", chain4, "-j", "DROP"}, []string{"-A", "OUTPUT", "-j", chain4})',
    replace: '		rules = append(rules, []string{"-A", chain4, "-j", "REJECT"}, []string{"-A", "OUTPUT", "-j", chain4})',
    run: ['go:./internal/ops/'],
  },

  // --- startup and the renderer ----------------------------------------------------
  {
    name: '[REL-14] the second instance quits through before-quit',
    file: 'src/main/index.ts',
    find: '  app.exit(0)\n} else {',
    replace: '  app.quit()\n} else {',
    run: ['test/static/startup.test.ts'],
  },
  {
    name: '[ARCH-1] the renderer loses its sandbox',
    file: 'src/main/index.ts',
    find: '      sandbox: true,',
    replace: '      sandbox: false,',
    run: ['test/static/startup.test.ts'],
  },
  {
    name: '[RN-4] three.js comes back',
    file: 'src/renderer/components/map/MapView.tsx',
    find: "import { lazy, Suspense, useMemo } from 'react'",
    replace: "import * as THREE from 'three'\nimport { lazy, Suspense, useMemo } from 'react'",
    run: ['test/static/renderer-rules.test.ts'],
  },
]
