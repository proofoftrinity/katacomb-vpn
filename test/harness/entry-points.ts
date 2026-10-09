// The IPC handlers that can spend money, bring a tunnel up, or change the active
// wallet. test/static/entry-points.test.ts derives these sets from the source and
// fails when they drift from what is written here, so a new handler that buys a
// session cannot slip past the matrices that loop over this list (refund, preflight,
// one connection at a time). Adding a handler here means it gets those tests too.

/** Handlers that create an on-chain session (a purchase). */
export const SPEND = [
  'CONNECTION_SUBSCRIBE',
  'CONNECTION_SUBSCRIBE_CHAIN',
  'PLAN_SUBSCRIBE',
  'PLAN_START_SESSION_FROM_SUB',
  'PLAN_SMART_CONNECT',
] as const

/** Handlers that bring a tunnel or a proxy core up. */
export const TUNNEL = ['CONNECTION_CONNECT'] as const

/** Handlers that change which wallet is active, or remove the one that is. */
export const WALLET_MUTATORS = [
  'WALLET_IMPORT',
  'WALLET_SWITCH',
  'WALLET_DELETE',
  'WALLET_DELETE_ALL',
  'WALLET_DELETE_SEED',
] as const

/**
 * Provider-console handlers that broadcast a provider tx (src/main/ipc/provider.ts):
 * a deposit, a lease escrow, or gas. src/main/ipc/provider.test.ts loops over these
 * for the tunnel and funds checks [PC-7] [PC-10].
 */
export const PROVIDER_WRITES = [
  'PROVIDER_REGISTER',
  'PROVIDER_UPDATE_DETAILS',
  'PROVIDER_SET_STATUS',
  'PROVIDER_PLAN_CREATE',
  'PROVIDER_PLAN_SET_STATUS',
  'PROVIDER_PLAN_SET_PRIVATE',
  'PROVIDER_PLAN_LINK',
  'PROVIDER_PLAN_UNLINK',
  'LEASE_START',
  'LEASE_RENEW',
  'LEASE_UPDATE_POLICY',
  'LEASE_END',
] as const

// What makes a handler one of the above: reaching any of these calls.
export const PURCHASE_CALLS = ['subscribeToNode', 'subscribeToPlan', 'startSessionWithExistingSubscription']
export const BRING_UP_CALLS = [
  'connectWireGuardFromConfig', 'connectAmneziaWgFromConfig', 'connectOpenVpnFromConfig',
  'connectV2RayFromConfig', 'connectXRayFromConfig', 'connectHysteria2FromConfig', 'bringUpV2RayTunnel',
]
export const ACTIVE_WALLET_CALLS = ['importWallet', 'switchWallet', 'deleteWalletEntry', 'logout']
/** The provider-console ops that sign and broadcast; provider-console.test.ts loops over these [PC-13]. */
export const PROVIDER_WRITE_CALLS = [
  'registerProvider', 'updateProviderDetails', 'setProviderStatus', 'createPlan', 'setPlanStatus',
  'updatePlanDetails', 'linkNode', 'unlinkNode', 'startLease', 'renewLease', 'updateLease', 'endLease',
] as const
