import { mock } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../../src/shared/ipc-channels.ts'
import { maxUsageBytes } from '../../src/main/vpn/traffic-stats.ts'
import { bundle, type Bundle } from './bundle.ts'
import { World, type Call, type FakeFn, type Fakes } from './world.ts'

// The real src/main/ipc-handlers.ts - the connection state machine - with its
// collaborators faked and everything pure left real (connect-decisions, plan-connect,
// config-guard, validate, settings, kill-switch over a faked runPrivileged). A test
// drives it the way the renderer does, through the registered IPC handlers, and
// asserts what it did to its collaborators: what it bought, refunded, brought up,
// tore down, broadcast and wrote to disk. docs/testing.md has the how-to.

export const FAKED = [
  'src/main/chain/rpc-monitor',
  'src/main/chain/wallet',
  'src/main/chain/chain-service',
  'src/main/chain/chain-clients',
  'src/main/plans/plan-service',
  'src/main/vpn/vpn-manager',
  'src/main/vpn/traffic-stats',
  'src/main/helper/privileged',
  'src/main/helper/daemon-client',
  'src/main/nodes/node-tester',
  'src/main/net-fetch',
  'src/main/ipc/diagnostics',
  'src/main/ipc/setup',
  'src/main/ipc/provider',
]

/** A test's fakes, typed against the real modules so a renamed export or a changed signature is a tsc error. */
type Partial2<M> = { [K in keyof M]?: M[K] }
export interface FakesFor {
  'chain/rpc-monitor'?: Partial2<typeof import('../../src/main/chain/rpc-monitor.ts')>
  'chain/wallet'?: Partial2<typeof import('../../src/main/chain/wallet.ts')>
  'chain/chain-service'?: Partial2<typeof import('../../src/main/chain/chain-service.ts')>
  'chain/chain-clients'?: Partial2<typeof import('../../src/main/chain/chain-clients.ts')>
  'plans/plan-service'?: Partial2<typeof import('../../src/main/plans/plan-service.ts')>
  'vpn/vpn-manager'?: Partial2<typeof import('../../src/main/vpn/vpn-manager.ts')>
  'vpn/traffic-stats'?: Partial2<typeof import('../../src/main/vpn/traffic-stats.ts')>
  'helper/privileged'?: Partial2<typeof import('../../src/main/helper/privileged.ts')>
  'helper/daemon-client'?: Partial2<typeof import('../../src/main/helper/daemon-client.ts')>
  'nodes/node-tester'?: Partial2<typeof import('../../src/main/nodes/node-tester.ts')>
  'net-fetch'?: Partial2<typeof import('../../src/main/net-fetch.ts')>
  'ipc/setup'?: Partial2<typeof import('../../src/main/ipc/setup.ts')>
}

/** What the faked vpn-manager pretends the machine's tunnel is doing. */
export class Tunnel {
  up = false
  protocol: string | null = null
  mode: 'tunnel' | 'proxy' = 'tunnel'
  /** Whether the tunnel probe (fetchFreshSocket) gets an answer through it. */
  carries = true
  /** The endpoint the kill switch would whitelist; null models a missing Endpoint. */
  remoteHost: string | null = '203.0.113.7'
  rx = 0
  tx = 0
  bringUps = 0
  bringUp(protocol: string, mode: 'tunnel' | 'proxy' = 'tunnel'): void {
    this.up = true; this.protocol = protocol; this.mode = mode; this.bringUps++
  }
  down(): void { this.up = false; this.protocol = null }
}

export const PROTOCOL_BY_TYPE: Record<number, string> = { 1: 'wireguard', 2: 'v2ray', 3: 'openvpn', 4: 'xray', 5: 'amneziawg', 6: 'hysteria2' }

export const WALLET_ADDRESS = 'sent1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu'

function defaults(tunnel: Tunnel, state: { nextSession: number; chainSessions: unknown[] }): Fakes {
  const noop = () => undefined
  const isRoot = (p: string | null) => p === 'wireguard' || p === 'amneziawg' || p === 'openvpn'
  const bring = (protocol: string) => async () => { tunnel.bringUp(protocol) }
  const bringChild = (protocol: string) => (_cfg: string, ...rest: unknown[]) => {
    const opts = rest.find((r): r is { proxyOnly?: boolean } => typeof r === 'object' && r !== null)
    tunnel.bringUp(protocol, opts?.proxyOnly ? 'proxy' : 'tunnel')
  }
  return {
    'chain/rpc-monitor': {
      onRpcEndpointChanged: noop, onChainPathChanged: noop, reportRpcFailure: noop, runAutoRpcSelection: async () => undefined,
      getRpcHealth: () => ({ state: 'ok', endpoint: 'https://rpc.test' }),
    },
    'chain/wallet': {
      hasStoredWallet: () => true,
      getAddress: () => WALLET_ADDRESS,
      getWallet: () => ({ fake: 'wallet' }),
      getPrivKey: () => new Uint8Array(32).fill(7),
      getActiveWalletId: () => 'w1',
      getBalance: async () => [{ denom: 'udvpn', amount: '1000000000000' }],
      getBalanceForAddress: async () => [{ denom: 'udvpn', amount: '1000000000000' }],
      getActiveSessions: async () => state.chainSessions,
      getSessionsForAddress: async () => [],
      switchWallet: async () => WALLET_ADDRESS,
      importWallet: async () => WALLET_ADDRESS,
      restoreWallet: async () => WALLET_ADDRESS,
      logout: noop,
    },
    'chain/chain-clients': {
      openChainFlow: async () => ({ query: { fake: 'query' }, signing: { fake: 'signing' }, disconnect: noop }),
    },
    'chain/chain-service': {
      subscribeToNode: async () => ({ sessionId: String(state.nextSession++), remoteUrl: 'https://203.0.113.7:8585' }),
      performHandshake: async (p: { nodeType: number }) => ({ protocol: PROTOCOL_BY_TYPE[p.nodeType], configString: `cfg-${PROTOCOL_BY_TYPE[p.nodeType]}` }),
      resolveNodeRemoteUrl: async () => 'https://203.0.113.7:8585',
      endSession: async () => undefined,
      loadSessionConfig: () => null,
      listSessionsOwnedByOtherWallets: () => [],
      sendChainHopProgress: noop,
      sendPlanProgress: noop,
      chainHopRoleOf: () => null,
      chainSigner: (a: unknown) => a,
    },
    'plans/plan-service': {
      subscribeToPlan: async () => ({ sessionId: String(state.nextSession++), subscriptionId: '77' }),
      startSessionWithExistingSubscription: async () => ({ sessionId: String(state.nextSession++) }),
      getCachedPlanNodes: () => null,
    },
    'vpn/vpn-manager': {
      connectWireGuardFromConfig: bring('wireguard'),
      connectAmneziaWgFromConfig: bring('amneziawg'),
      connectOpenVpnFromConfig: bring('openvpn'),
      connectV2RayFromConfig: bringChild('v2ray'),
      connectXRayFromConfig: bringChild('xray'),
      connectHysteria2FromConfig: bringChild('hysteria2'),
      bringUpV2RayTunnel: async () => undefined,
      disconnect: async () => { tunnel.down() },
      getConnectionStatus: () => ({ connected: tunnel.up, protocol: tunnel.protocol, proxyMode: tunnel.up && tunnel.mode === 'proxy' }),
      isProxyChildAlive: () => tunnel.up && !isRoot(tunnel.protocol),
      waitForChildProxyListener: async () => undefined,
      isVpnActive: () => tunnel.up && tunnel.mode === 'tunnel',
      detectOtherVpn: () => [],
      getV2RayError: () => '',
      getV2RayRemoteHost: () => tunnel.remoteHost,
      getWireGuardRemoteHost: () => tunnel.remoteHost,
      getOpenVpnRemoteHost: () => tunnel.remoteHost,
      isWireGuardUp: () => tunnel.up && (tunnel.protocol === 'wireguard' || tunnel.protocol === 'amneziawg'),
      isOpenVpnUp: () => tunnel.up && tunnel.protocol === 'openvpn',
      hasDefaultRouteChanged: () => false,
      startProvisioningProxy: async () => ({ port: 1081, stop: noop }),
      protocolRuntimeError: () => null,
      onV2RayUnexpectedExit: noop,
      reapOrphanedProxyChildren: async () => false,
    },
    'vpn/traffic-stats': {
      getTrafficStats: () => ({ rxBytes: tunnel.rx, txBytes: tunnel.tx, rxRate: 0, txRate: 0 }),
      resetTrafficStats: noop,
      maxUsageBytes,
      // Traffic flows both ways while the tunnel carries: each read sees more.
      readTunnelBytes: () => {
        if (!tunnel.up) return null
        if (tunnel.carries) { tunnel.rx += 200_000; tunnel.tx += 20_000 } else { tunnel.tx += 20_000 }
        return { rx: tunnel.rx, tx: tunnel.tx }
      },
    },
    'helper/privileged': { runPrivileged: async () => undefined, canEscalatePrivileges: () => true },
    'helper/daemon-client': {
      daemonMissingOp: async () => false, daemonXfrmPolicyCount: async () => 0, daemonWireguardHandshakeAge: async () => null,
    },
    'nodes/node-tester': {
      fetchNodeServiceType: async () => 'wireguard',
      fetchNodeServiceMetadata: async () => [],
      fetchNodeSignsReplies: async () => true,
      getAllCachedResults: () => [],
    },
    'net-fetch': {
      fetchFreshSocket: async () => ({ status: tunnel.up && tunnel.carries ? 200 : 0 }),
    },
    'ipc/setup': { registerSetupHandlers: noop, assertSystemReady: async () => undefined },
    'ipc/diagnostics': { registerDiagnosticsHandlers: noop },
    'ipc/provider': { registerProviderHandlers: noop },
  }
}

export interface FreshOptions {
  fakes?: FakesFor
  /** settings.json contents (merged over the app defaults by the real loadSettings). */
  settings?: Record<string, unknown>
  /** wallets-index.json contents. */
  walletsIndex?: unknown[]
  /** What getActiveSessions returns: the chain's session rows. */
  chainSessions?: unknown[]
  /** Write nodes-cache.json so directorySaysSigns has a directory to read. */
  nodes?: Array<Record<string, unknown>>
  dev?: boolean
}

type Key = keyof typeof IPC

export interface IpcHarness {
  world: World
  tunnel: Tunnel
  /** The bundle's exports: performDisconnect, cleanupOnQuit, getConnectionInfo, ... */
  main: Record<string, (...args: never[]) => unknown>
  invoke(key: Key, ...args: unknown[]): Promise<unknown>
  invokeUntrusted(key: Key, ...args: unknown[]): Promise<unknown>
  calls(mod: string, fn?: string | RegExp): Call[]
  /** Payloads main broadcast on an event channel. */
  sent(key: Key): unknown[][]
  /** Let virtual time pass, running every timer that comes due. */
  advance(ms: number): Promise<void>
  /** Drive virtual time until `p` settles; fails past `capMs`, which is "bound every wait" made checkable. */
  settle<T>(p: Promise<T>, capMs?: number): Promise<T>
  /** settle() for a call expected to fail: returns the error. */
  settleError(p: Promise<unknown>, capMs?: number): Promise<Error>
  dispose(): void
}

const TRUSTED_URL = 'file:///opt/Katacomb%20VPN/resources/app.asar/out/renderer/index.html'
const event = (url: string) => ({ senderFrame: { url }, sender: { getURL: () => url } })
const flush = () => new Promise<void>((r) => setImmediate(r))

export const T0 = Date.parse('2026-10-07T00:00:00Z')

export async function loadIpcHandlers(): Promise<{ fresh: (opts?: FreshOptions) => IpcHarness }> {
  const b: Bundle = await bundle({ entries: ['src/main/ipc-handlers.ts', 'src/main/chain/chain-service.ts'], fake: FAKED })
  return {
    fresh(opts: FreshOptions = {}): IpcHarness {
      const userData = mkdtempSync(join(tmpdir(), 'kv-userdata-'))
      if (opts.settings) writeFileSync(join(userData, 'settings.json'), JSON.stringify(opts.settings))
      if (opts.walletsIndex) writeFileSync(join(userData, 'wallets-index.json'), JSON.stringify(opts.walletsIndex))
      if (opts.nodes) writeFileSync(join(userData, 'nodes-cache.json'), JSON.stringify({ nodes: opts.nodes, fetchedAt: T0 }))
      mkdirSync(join(userData, 'sessions'), { recursive: true })

      const w = new World(userData)
      w.isDev = opts.dev ?? false
      const tunnel = new Tunnel()
      const state = { nextSession: 1001, chainSessions: opts.chainSessions ?? [] }
      const base = defaults(tunnel, state)
      for (const [mod, fns] of Object.entries(opts.fakes ?? {})) base[mod] = { ...base[mod], ...(fns as Record<string, FakeFn>) }
      w.fakes = base
      globalThis.__kvWorld = w

      mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 })
      const origLog = console.log
      const origErr = console.error
      const origWarn = console.warn
      console.log = () => undefined
      console.error = () => undefined
      console.warn = () => undefined

      const main = b.load() as IpcHarness['main']
      ;(main.registerIpcHandlers as () => void)()
      if (opts.nodes) (main.bootstrapNodesCache as () => void)()

      const invokeAs = (url: string) => (key: Key, ...args: unknown[]): Promise<unknown> => {
        const handler = w.handlers.get(IPC[key])
        if (!handler) return Promise.reject(new Error(`no handler registered for ${key}`))
        try {
          return Promise.resolve(handler(event(url), ...args))
        } catch (err) {
          return Promise.reject(err)
        }
      }

      const advance = async (ms: number): Promise<void> => {
        for (let t = 0; t < ms; t += 100) {
          mock.timers.tick(Math.min(100, ms - t))
          for (let i = 0; i < 4; i++) await flush()
        }
      }

      const settle = async <T>(p: Promise<T>, capMs = 10 * 60_000): Promise<T> => {
        let done = false
        p.then(() => { done = true }, () => { done = true })
        for (let t = 0; ; t += 100) {
          for (let i = 0; i < 4; i++) await flush()
          if (done) return p
          if (t >= capMs) throw new Error(`still pending after ${capMs} ms of virtual time`)
          mock.timers.tick(100)
        }
      }

      return {
        world: w,
        tunnel,
        main,
        invoke: invokeAs(TRUSTED_URL),
        invokeUntrusted: invokeAs('https://attacker.example/'),
        calls: (mod, fn) => w.calls(mod, fn),
        sent: (key) => w.sent.filter((s) => s.channel === IPC[key]).map((s) => s.args),
        advance,
        settle,
        async settleError(p, capMs) {
          try { await settle(p, capMs) } catch (err) {
            if (err instanceof Error && err.message.startsWith('still pending after')) throw err
            return err as Error
          }
          throw new Error('expected the call to fail, and it succeeded')
        },
        dispose() {
          mock.timers.reset()
          console.log = origLog
          console.error = origErr
          console.warn = origWarn
          globalThis.__kvWorld = undefined
          rmSync(userData, { recursive: true, force: true })
        },
      }
    },
  }
}
