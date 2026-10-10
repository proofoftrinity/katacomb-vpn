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
const VPN_TS = 'src/main/vpn/vpn-manager.ts'
const PROTOCOLS = 'src/main/ipc-handlers.protocols.test.ts'

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
    find: '  // that ordering means createTrayIcon() reads the settled state for itself.\n  notifyTray()',
    replace: '  // that ordering means createTrayIcon() reads the settled state for itself.',
    run: [TEARDOWN],
  },
  {
    name: '[REL-34] a reconnect or a second purchase runs beside a purchase in flight',
    file: IPC_TS,
    find: "    if (kind === 'opens' && connectSteps > 0) {",
    replace: "    if (kind === 'opens' && connectSteps < 0) {",
    run: [MONEY],
  },
  {
    name: '[REL-35] the tray state forgets a connect in flight (a theme change shows Disconnected + Connect)',
    file: IPC_TS,
    find: "        : connectSteps > 0 || connectSettling !== null ? 'connecting'",
    replace: "        : false ? 'connecting'",
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

  // --- the socket contract (P6) -------------------------------------------------------
  {
    name: "[PH-4] the daemon's bypass-route cap drifts from the app's",
    file: 'daemon/internal/ops/tun.go',
    find: 'const MaxBypassRoutes = 64',
    replace: 'const MaxBypassRoutes = 65',
    run: ['go:./internal/server/'],
  },
  {
    name: "[PH-4] the app's bypass-route cap drifts from the daemon's",
    file: 'src/main/config-guard.ts',
    find: 'const MAX_BYPASS_ROUTES = 64',
    replace: 'const MAX_BYPASS_ROUTES = 63',
    run: ['src/main/helper/daemon-protocol-corpus.test.ts'],
  },
  {
    name: '[PH-2] the daemon renames a result field the app reads',
    file: 'daemon/internal/ops/handshake.go',
    find: 'json:"ageSeconds"',
    replace: 'json:"age_seconds"',
    run: ['go:./internal/server/'],
  },
  {
    name: '[PH-2] a daemon whose op list cannot be read is treated as stale',
    file: 'src/main/helper/daemon-client.ts',
    find: '  if (!caps || caps.ops === null) return false',
    replace: '  if (!caps || caps.ops === null) return true',
    run: ['src/main/helper/daemon-readers.test.ts'],
  },

  // --- the Sessions tab (P7) -----------------------------------------------------------
  {
    name: '[RN-2] the usage gauges follow the reading down',
    file: 'src/renderer/utils/session-card.ts',
    find: '  if (!floor) return reading\n',
    replace: '  return reading\n',
    run: ['src/renderer/utils/session-card.test.ts'],
  },
  {
    name: '[RN-9] closing the create screen cancels the clipboard wipe of a copied phrase',
    file: 'src/renderer/components/wallet/MnemonicInput.tsx',
    find: '  const copyClearTimer = useRef<number | null>(null)\n',
    replace: '  const copyClearTimer = useRef<number | null>(null)\n  useEffect(() => () => {\n    if (copyClearTimer.current !== null) window.clearTimeout(copyClearTimer.current)\n  }, [])\n',
    run: ['test/static/renderer-rules.test.ts'],
  },
  {
    name: '[REL-24] Connect is offered on a session that has used its paid hour',
    file: 'src/renderer/utils/session-card.ts',
    find: '  return (hasTimeCap && timePct >= 100) || (hasByteCap && dataPct >= 100)',
    replace: '  return (hasTimeCap && timePct > 100) || (hasByteCap && dataPct >= 100)',
    run: ['src/renderer/utils/session-card.test.ts'],
  },
  {
    name: '[REL-24] the Connect button stops gating on the quota',
    file: 'src/renderer/components/ActiveSessions.tsx',
    find: "status.state === 'reconnecting' || quotaUsedUp || setupHeld}",
    replace: "status.state === 'reconnecting' || setupHeld}",
    run: ['test/static/renderer-rules.test.ts'],
  },
  {
    name: '[MH-10] a chain that lost a hop is shown as ended, hiding its open deposit',
    file: 'src/renderer/utils/session-card.ts',
    find: "  if (open.length === 0) return 'ended'",
    replace: "  if (open.length < hops.length) return 'ended'",
    run: ['src/renderer/utils/session-card.test.ts'],
  },

  // --- every sink, every protocol branch (closing the partial rules) ------------------
  {
    name: '[NT-1] the AmneziaWG sink stops guarding what it hands root',
    file: VPN_TS,
    find: '  assertSafeAmneziaWgConfig(configString)\n',
    replace: '',
    run: [SINKS],
  },
  {
    name: '[NT-1] the OpenVPN sink stops guarding what it hands root',
    file: VPN_TS,
    find: '  assertSafeOpenVpnConfig(configString)\n',
    replace: '',
    run: [SINKS],
  },
  {
    name: '[NT-1] the Xray sink spawns an unguarded config',
    file: VPN_TS,
    find: '  assertSafeV2RayConfig(cfg)\n  const finalCfg = dohResolverIp',
    replace: '  const finalCfg = dohResolverIp',
    run: [SINKS],
  },
  {
    name: '[NT-1] the Hysteria2 sink spawns an unguarded config',
    file: VPN_TS,
    find: '  assertSafeHysteria2Config(parsed)\n',
    replace: '',
    run: [SINKS],
  },
  {
    name: '[NT-1] split-tunnel routes reach tun-up unsanitized',
    file: VPN_TS,
    find: "  const bypassRoutes = sanitizeBypassRoutes(settings.splitTunnelRoutes).join(',')",
    replace: "  const bypassRoutes = ((settings.splitTunnelRoutes ?? []) as string[]).join(',')",
    run: [SINKS],
  },
  {
    name: '[REL-7] Hysteria2 dials the node by hostname',
    file: VPN_TS,
    find: '      if (ip) parsed.server = `${ip}:${port}`',
    replace: '      if (ip) void port',
    run: [SINKS],
  },
  {
    name: '[REL-7] Xray dials the node by hostname',
    file: VPN_TS,
    find: '  const cfg = pinV2RayNodeAddresses(withV2RayDiagnosticLog(parsed), resolveHostToIPv4)\n  assertSafeV2RayConfig(cfg)\n  const finalCfg',
    replace: '  const cfg = withV2RayDiagnosticLog(parsed)\n  assertSafeV2RayConfig(cfg)\n  const finalCfg',
    run: [SINKS],
  },
  {
    name: '[REL-7] AmneziaWG dials the node by hostname',
    file: VPN_TS,
    find: '  const configString = pinWireguardEndpoint(raw, resolveHostToIPv4)\n\n  // Node operators',
    replace: '  const configString = raw\n\n  // Node operators',
    run: [SINKS],
  },
  {
    name: '[REL-18] a live core reads as connected before tun2socks routes anything',
    file: VPN_TS,
    find: '      if (!isChildProxyCarryingTraffic({ childAlive, proxyMode, tunUp: isTunUp() })) {',
    replace: '      if (!childAlive) {',
    run: [SINKS],
  },
  {
    name: '[REL-18] the startup wait asks the traffic predicate, failing every tunnel-mode connect',
    file: IPC_TS,
    find: '  if (isProxyChildAlive()) return\n',
    replace: '  if (getConnectionStatus().connected) return\n',
    run: [PROTOCOLS],
  },
  {
    name: '[REL-17] the child-proxy branches skip the traffic proof',
    file: IPC_TS,
    find: '    await applyPostConnectSettings(opts.protocol)\n    await assertTunnelCarriesTraffic()',
    replace: '    await applyPostConnectSettings(opts.protocol)',
    run: [PROTOCOLS],
  },
  {
    name: '[REL-17] the AmneziaWG branch skips the traffic proof',
    file: IPC_TS,
    find: "        await applyPostConnectSettings('amneziawg')\n        await assertTunnelCarriesTraffic()",
    replace: "        await applyPostConnectSettings('amneziawg')",
    run: [PROTOCOLS],
  },
  {
    name: '[REL-17] an auto-reconnect counts a dead tunnel as a success',
    file: IPC_TS,
    find: "          await assertTunnelCarriesTraffic()\n        }\n\n        console.log('[reconnect] Success')",
    replace: "        }\n\n        console.log('[reconnect] Success')",
    run: [PROTOCOLS],
  },
  {
    name: '[REL-9] WireGuard keeps the node\'s resolver though the user chose one',
    file: IPC_TS,
    find: 'stripDnsLines(base) : replaceDnsLines(base, wgDns),',
    replace: 'stripDnsLines(base) : base,',
    run: [PROTOCOLS],
  },
  {
    name: '[REL-9] AmneziaWG keeps the node\'s resolver though the user chose one',
    file: IPC_TS,
    find: '          : awgDns ? replaceDnsLines(awgConfig, awgDns)\n',
    replace: '          : awgDns ? awgConfig\n',
    run: [PROTOCOLS],
  },
  {
    name: '[REL-9] the reconnect ladder puts the user back on the node\'s resolver',
    file: IPC_TS,
    find: '        const withResolver = (cfg: string) => (wgDns ? replaceDnsLines(cfg, wgDns) : cfg)',
    replace: '        const withResolver = (cfg: string) => (wgDns ? cfg : cfg)',
    run: [PROTOCOLS],
  },
  {
    name: '[PRO-7] a proxy-mode session comes back from a reconnect as a full tunnel',
    file: IPC_TS,
    find: "          const proxyOnly = desiredMode === 'proxy'\n",
    replace: '          const proxyOnly = false\n',
    run: [PROTOCOLS],
  },
  {
    name: '[REL-2] the monitor asks vpn-manager which protocol to watch, and loses it with the interface',
    file: IPC_TS,
    find: '    if (isRootTunnelProtocol(desiredProtocol)) {',
    replace: '    if (isRootTunnelProtocol(getConnectionStatus().protocol as typeof desiredProtocol)) {',
    run: [PROTOCOLS],
  },

  // --- the rest of the partial rules, and the manual ones that can be read or run -----
  {
    name: '[REL-25] a firewall toggle reapplies beside an in-flight connect or disconnect',
    file: IPC_TS,
    find: '      void withConnectionLock(reapplyFirewall).then(() => {',
    replace: '      void reapplyFirewall().then(() => {',
    run: [TEARDOWN],
  },
  {
    name: '[REL-12] the node purchase is left to open its own connection beside the flow',
    file: IPC_TS,
    find: '        clients: { query: flow.query, signing: flow.signing },\n      }).catch(noteChainError)',
    replace: '      }).catch(noteChainError)',
    run: [MONEY],
  },
  {
    name: '[REL-12] a plan purchase closes the client it was handed',
    file: 'src/main/plans/plan-service.ts',
    find: '    ownFlow?.disconnect()\n  }\n}\n\nexport async function subscribeToPlan(',
    replace: '    ownFlow?.disconnect()\n    params.client?.disconnect()\n  }\n}\n\nexport async function subscribeToPlan(',
    run: ['src/main/plans/plan-service.test.ts'],
  },
  {
    name: '[REL-5] the node purchase broadcasts with no timeoutHeight',
    file: 'src/main/chain/chain-service.ts',
    find: '    const timeoutHeight = BigInt(height + TX_TIMEOUT_HEIGHT_OFFSET)',
    replace: '    const timeoutHeight = undefined',
    run: ['src/main/chain/chain-service.test.ts'],
  },
  {
    name: '[REL-5] the node probe goes back to an inactivity timer a dripping node keeps alive',
    file: 'src/main/nodes/node-tester.ts',
    find: "    deadline = setTimeout(() => { req.destroy(new Error('Timeout')) }, timeoutMs)",
    replace: "    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout')) })",
    run: ['src/main/nodes/node-tester.test.ts'],
  },
  {
    name: '[REL-12] the RPC redirect is followed down to plain http',
    file: 'src/main/chain/chain-clients.ts',
    find: "    if (target.protocol !== 'https:') return endpoint\n",
    replace: '',
    run: ['src/main/chain/chain-clients.test.ts'],
  },
  {
    name: '[REL-23] the tab badge counts settling sessions as live',
    file: 'src/renderer/App.tsx',
    find: "  const sessionCount = sessionsState.sessions.filter((s) => s.status === 'active').length",
    replace: '  const sessionCount = sessionsState.sessions.length',
    run: ['test/static/renderer-rules.test.ts'],
  },
  {
    name: '[MH-5] the chain entry is bought before it is graded',
    file: IPC_TS,
    find: "    await assertChainEligible(params.entry, 'entry')\n",
    replace: '',
    run: [CHAIN],
  },
  {
    name: '[MH-5] the chain exit is bought before it is graded',
    file: IPC_TS,
    find: "    await assertChainEligible(exit, 'exit', agent)\n",
    replace: '',
    run: [CHAIN],
  },
  {
    name: '[MH-9] ending a chain hop deletes its record instead of leaving a tombstone',
    file: 'src/main/chain/chain-service.ts',
    find: "    saveSessionConfig({ ...saved, configString: '' })",
    replace: '    deleteSessionConfig(sessionId)',
    run: ['src/main/chain/chain-service.test.ts'],
  },
  {
    name: '[MH-12] the watchdog stops watching the exit hop\'s deadline',
    file: IPC_TS,
    find: '    void checkChainExitDeadline()\n',
    replace: '',
    run: [CHAIN],
  },
  {
    name: '[SL-1] End is worded as a refund',
    file: 'src/renderer/components/ActiveSessions.tsx',
    find: 'This will close the session on-chain. Remaining data/time will be forfeited.',
    replace: 'This will close the session on-chain and refund what is left.',
    run: ['test/static/renderer-rules.test.ts'],
  },
  {
    name: '[NT-3] copy claims Reality protects the user from their ISP',
    file: 'src/renderer/utils/v2ray-connection.ts',
    find: 'Reality wraps this hop in TLS that looks like an ordinary website to anyone watching.',
    replace: 'Reality wraps this hop in TLS that protects you from your ISP.',
    run: ['test/static/renderer-rules.test.ts'],
  },
  {
    name: '[NT-3] the self-signed limit is dropped for a node whose signing is unknown',
    file: 'src/renderer/components/ConnectReview.tsx',
    find: '  if (signs === true) return null',
    replace: '  if (signs !== false) return null',
    run: ['test/static/renderer-rules.test.ts'],
  },
  {
    name: '[PH-6] an upgrade\'s restart wipes /run/katacomb-vpn again',
    file: 'resources/linux/privileged/katacomb-vpn-daemon.service',
    find: 'RuntimeDirectoryPreserve=restart\n',
    replace: '',
    run: ['test/static/privileged-install.test.ts'],
  },
  {
    name: '[PH-7] the postinstall copies onto the running helper',
    file: 'resources/linux/packaging/postinstall.sh',
    find: '  cp "$HELPER_SRC" "$HELPER_DEST.new"\n  chmod 755 "$HELPER_DEST.new"\n  chown root:root "$HELPER_DEST.new"\n  mv -f "$HELPER_DEST.new" "$HELPER_DEST"',
    replace: '  cp "$HELPER_SRC" "$HELPER_DEST"\n  chmod 755 "$HELPER_DEST"\n  chown root:root "$HELPER_DEST"',
    run: ['test/static/privileged-install.test.ts'],
  },
  {
    name: '[PH-7] installHelper copies onto the running helper',
    file: 'src/main/helper/system-setup.ts',
    find: '      `cp -- "$1" "$3.new"`,\n      `chmod 755 "$3.new"`,\n      `chown root:root "$3.new"`,\n      `mv -f "$3.new" "$3"`,',
    replace: '      `cp -- "$1" "$3"`,\n      `chmod 755 "$3"`,\n      `chown root:root "$3"`,',
    run: ['test/static/privileged-install.test.ts'],
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

  // --- the provider console (P9) ------------------------------------------------------
  {
    name: '[PC-7] registration is checked for gas only, not for the deposit it spends',
    file: 'src/main/ipc/provider.ts',
    find: '    await assertSufficientFunds(registrationDepositCost(deposit))',
    replace: '    await assertSufficientFunds(0)',
    run: ['src/main/ipc/provider.test.ts'],
  },
  {
    name: '[PC-7] a lease start is priced at one hour',
    file: 'src/main/ipc/provider.ts',
    find: '    await assertSufficientFunds(leaseDepositNumber(price.hourlyPrice, params.hours))\n\n    await startLease({',
    replace: '    await assertSufficientFunds(leaseDepositNumber(price.hourlyPrice, 1))\n\n    await startLease({',
    run: ['src/main/ipc/provider.test.ts'],
  },
  {
    name: '[PC-7] a renew is priced as a top-up of the hours left, not the whole new term',
    file: 'src/main/ipc/provider.ts',
    find: '    await assertSufficientFunds(leaseDepositNumber(price.hourlyPrice, params.hours))\n\n    await renewLease({',
    replace: '    await assertSufficientFunds(leaseDepositNumber(price.hourlyPrice, Math.max(1, params.hours - (lease.maxHours - lease.hours))))\n\n    await renewLease({',
    run: ['src/main/ipc/provider.test.ts'],
  },
  {
    name: '[PC-8] a lease starts on a node that is not active on chain',
    file: 'src/main/ipc/provider.ts',
    find: '    if (price.status !== 1) {',
    replace: '    if (price.status === -1) {',
    run: ['src/main/ipc/provider.test.ts'],
  },
  {
    name: '[PC-9] ending a lease trusts the renderer\'s lease id',
    file: 'src/main/ipc/provider.ts',
    find: '    await assertOwnLease(address, params.leaseId)\n    await assertSufficientFunds(0)\n    try {\n      await endLease(',
    replace: '    await assertSufficientFunds(0)\n    try {\n      await endLease(',
    run: ['src/main/ipc/provider.test.ts'],
  },
  {
    name: '[PC-10] the cached overview is served to another wallet',
    file: 'src/main/provider/provider-cache.ts',
    find: '  if (!overview || overview.address !== address) return null',
    replace: '  if (!overview) return null',
    run: ['src/main/ipc/provider.test.ts'],
  },
  {
    name: '[PC-13] a provider tx carries no timeoutHeight',
    file: 'src/main/provider/provider-console.ts',
    find: "client.signAndBroadcast(params.accountAddress, [params.msg], 'auto', '', timeoutHeight),",
    replace: "client.signAndBroadcast(params.accountAddress, [params.msg], 'auto', ''),",
    run: ['src/main/provider/provider-console.test.ts'],
  },
  {
    name: '[PC-13] two provider writes sign at once, on the same sequence',
    file: 'src/main/provider/provider-console.ts',
    find: '  const run = providerWriteLock.then(fn, fn)',
    replace: '  const run = fn()',
    run: ['src/main/provider/provider-console.test.ts'],
  },
  {
    name: '[PC-4] provider txs are signed with the SDK\'s default registry',
    file: 'src/main/provider/provider-console.ts',
    find: '        registry: CHAIN_REGISTRY,',
    replace: '',
    run: ['src/main/provider/provider-console.test.ts'],
  },
]
