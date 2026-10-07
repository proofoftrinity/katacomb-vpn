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
const TEARDOWN = 'src/main/ipc-handlers.teardown.test.ts'
const CHAIN = 'src/main/ipc-handlers.chain.test.ts'
const SINKS = 'src/main/vpn/vpn-manager.test.ts'
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

  // --- teardown, the kill switch, the quota (P4) -------------------------------------
  {
    name: '[REL-8] the kill switch is armed with no endpoint to whitelist',
    file: IPC_TS,
    find: '  if (!remoteHost) {\n    console.error(`[killswitch] no endpoint IP',
    replace: '  if (!remoteHost && false) {\n    console.error(`[killswitch] no endpoint IP',
    run: [TEARDOWN],
  },
  {
    name: '[REL-30] the watchdog is stopped before the usage is remembered',
    file: IPC_TS,
    find: '  return withConnectionLock(async () => {\n    rememberSessionUsage()\n\n    stopRootTunnelMonitor()\n    stopQuotaWatchdog()',
    replace: '  return withConnectionLock(async () => {\n    stopQuotaWatchdog()\n    rememberSessionUsage()\n\n    stopRootTunnelMonitor()',
    run: [TEARDOWN],
  },
  {
    name: '[REL-16] a bring-up no longer starts the quota watchdog',
    file: IPC_TS,
    find: '  if (mode !== \'proxy\') startRootTunnelMonitor()\n  startQuotaWatchdog()',
    replace: '  if (mode !== \'proxy\') startRootTunnelMonitor()',
    run: [TEARDOWN],
  },
  {
    name: '[REL-31] the kill-switch heal strips a live tunnel\'s chain',
    file: IPC_TS,
    find: '  if (isKillSwitchArmed() && !getConnectionStatus().connected) {',
    replace: '  if (isKillSwitchArmed()) {',
    run: [TEARDOWN],
  },
  {
    name: '[REL-32] the orphan heal forgets to tell the tray',
    file: IPC_TS,
    find: '  // that ordering means createTrayIcon() reads the settled state for itself.\n  notifyTraySettled()',
    replace: '  // that ordering means createTrayIcon() reads the settled state for itself.',
    run: [TEARDOWN],
  },
  {
    name: '[REL-20] usage keeps counting after the tunnel stopped answering',
    file: IPC_TS,
    find: '  const until = Math.max(aliveUntilMs, connectedAtMs)',
    replace: '  const until = Date.now()',
    run: [TEARDOWN],
  },
  {
    name: '[REL-31] the kill-switch marker is written after arming',
    file: 'src/main/vpn/kill-switch.ts',
    find: '  markKillSwitchArmed()\n  await runPrivileged([',
    replace: '  await runPrivileged([',
    run: ['src/main/vpn/kill-switch.test.ts'],
  },

  // --- signing, the chain, the sinks (P4) --------------------------------------------
  {
    name: '[NT-5] a purchase handshake stops asking for a signature',
    file: IPC_TS,
    find: '          sessionId, nodeAddress, nodeType, remoteUrl, privKey, requireSigned: directorySaysSigns(nodeAddress), nodeMoniker, nodeCountry,',
    replace: '          sessionId, nodeAddress, nodeType, remoteUrl, privKey, requireSigned: false, nodeMoniker, nodeCountry,',
    run: [CHAIN],
  },
  {
    name: '[MH-13] the exit is preflighted directly, not through the entry',
    file: IPC_TS,
    find: '    await preflightConnect(exit.nodeAddress, exit.nodeType, exit.apiField, false, agent)',
    replace: '    await preflightConnect(exit.nodeAddress, exit.nodeType, exit.apiField, false)',
    run: [CHAIN],
  },
  {
    name: '[MH-13] the provisioning proxy is left running',
    file: IPC_TS,
    find: '    proxy?.stop()\n  }\n}',
    replace: '  }\n}',
    run: [CHAIN],
  },
  {
    name: '[MH-7] the exit may be paid from the active account under another id',
    file: IPC_TS,
    find: '    if (creds.address === address) {',
    replace: '    if (creds.address === address && false) {',
    run: [CHAIN],
  },
  {
    name: '[NT-1] the WireGuard sink skips the guard',
    file: 'src/main/vpn/vpn-manager.ts',
    find: '  // Saved/reconnect configs are equally untrusted — guard before wg-quick (root).\n  assertSafeWireguardConfig(configString)\n',
    replace: '',
    run: [SINKS],
  },
  {
    name: '[REL-7] the WireGuard sink hands root the hostname',
    file: 'src/main/vpn/vpn-manager.ts',
    find: '  // by now the kill switch may be the thing blocking the lookup).\n  const configString = pinWireguardEndpoint(raw, resolveHostToIPv4)\n',
    replace: '  // by now the kill switch may be the thing blocking the lookup).\n  const configString = raw\n',
    run: [SINKS],
  },

  // --- durable data and the node reply (P5) ----------------------------------------
  {
    name: '[NT-2] tunnel credentials are written without a real keyring',
    file: 'src/main/chain/chain-service.ts',
    find: '  if (!isSecureStorageAvailable()) {\n    console.warn(\'[session] secure OS keyring unavailable',
    replace: '  if (false) {\n    console.warn(\'[session] secure OS keyring unavailable',
    run: ['src/main/chain/chain-service.test.ts'],
  },
  {
    name: '[NT-4] an unsigned reply is accepted from a node that must sign',
    file: 'src/main/chain/chain-service.ts',
    find: "  if (signer === 'unsigned' && requireSigned) {",
    replace: "  if (signer === 'unsigned' && requireSigned && false) {",
    run: ['src/main/chain/chain-service.test.ts'],
  },
  {
    name: "[ARCH-5] a pre-feature custom RPC endpoint is handed to Smart RPC",
    file: 'src/main/settings.ts',
    find: "  raw['rpcMode'] = 'manual'",
    replace: "  raw['rpcMode'] = 'auto'",
    run: ['src/main/settings.test.ts'],
  },
  {
    name: '[PC-1] the global provider mode is dropped instead of moved onto the wallet',
    file: 'src/main/settings.ts',
    find: '  if (activeId && listWallets().some((w) => w.id === activeId)) {\n    setWalletProviderMode(activeId, true)\n  }',
    replace: '',
    run: ['src/main/settings.test.ts'],
  },
  {
    name: '[ARCH-5] the dedupe keeps the copy that no longer unlocks',
    file: 'src/main/settings.ts',
    find: '    const survivor = group.find((w) => canUnlockWallet(w.id)) ?? group[0]',
    replace: '    const survivor = group[0]',
    run: ['src/main/settings.test.ts'],
  },
  {
    name: '[ARCH-5] a seed is written under basic_text',
    file: 'src/main/settings.ts',
    find: '  if (!isSecureStorageAvailable()) {\n    throw new Error(INSECURE_STORAGE_MESSAGE)\n  }',
    replace: '',
    run: ['src/main/settings.test.ts'],
  },
  {
    name: '[REL-27] "connected" goes out before the tunnel is proven',
    file: IPC_TS,
    find: "        await applyPostConnectSettings('wireguard')\n        await assertTunnelCarriesTraffic()\n\n        finalizeTunnelConnect('wireguard', 'tunnel')",
    replace: "        await applyPostConnectSettings('wireguard')\n        finalizeTunnelConnect('wireguard', 'tunnel')\n        await assertTunnelCarriesTraffic()",
    run: [LIFE],
  },
  {
    name: '[MH-20] a subscription cancel is attempted through the tunnel',
    file: IPC_TS,
    find: "    if (isVpnActive()) {\n      throw new Error('Disconnect the VPN before managing subscriptions. The chain is unreachable through the tunnel.')\n    }\n    // Same gap as WALLET_END_SESSION",
    replace: '    // Same gap as WALLET_END_SESSION',
    run: [LIFE],
  },

  {
    name: "[MH-17] the exit's address goes to the ISP's resolver",
    file: 'src/main/chain/chain-service.ts',
    find: '  const exitPinned: HopSpec = { ...exitSpec, addrs: await withPrivatelyResolvedAddrs(exitSpec.addrs) }',
    replace: '  const exitPinned: HopSpec = { ...exitSpec }\n  void withPrivatelyResolvedAddrs',
    run: ['src/main/chain/chain-service.test.ts'],
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
