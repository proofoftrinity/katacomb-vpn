/**
 * The Help panel's topics ([RN-15]): the explanations the app used to repeat on every
 * screen, written once. A screen keeps one short line and links here through a "?"
 * ("Learn more") or a Limits panel. Every sentence comes from copy the app already
 * shows; a topic adds no claim of its own, so a correction to a fact goes here and
 * into the screen that states it.
 *
 * Pure and import-free ([RN-5]).
 */

export type TopicId =
  | 'node-sees' | 'multihop' | 'switching' | 'extend' | 'proxy-mode' | 'health'
  | 'kill-switch' | 'dns' | 'signing'
  | 'sessions' | 'billing' | 'fees'
  | 'plans'
  | 'provider' | 'leases' | 'catalog-visibility'
  | 'wallets'

export interface HelpTopic {
  title: string
  body: string[]
  related: TopicId[]
}

/** The index, in reading order. Every topic is in exactly one group. */
export const HELP_GROUPS: { title: string; topics: TopicId[] }[] = [
  { title: 'Connecting', topics: ['node-sees', 'multihop', 'switching', 'extend', 'proxy-mode', 'health'] },
  { title: 'Privacy', topics: ['kill-switch', 'dns', 'signing'] },
  { title: 'Paying', topics: ['sessions', 'billing', 'fees'] },
  { title: 'Plans', topics: ['plans'] },
  { title: 'Provider', topics: ['provider', 'leases', 'catalog-visibility'] },
  { title: 'Wallets', topics: ['wallets'] },
]

export const HELP_TOPICS: Record<TopicId, HelpTopic> = {
  'node-sees': {
    title: 'What a node can see',
    body: [
      'Your device connects straight to the node, so it sees your IP address.',
      'Your traffic also leaves for the internet from it, so it sees which sites you visit. HTTPS keeps what you send from it, not where you send it.',
      'A two-hop chain splits the two between nodes in different countries, each paid from its own wallet.',
    ],
    related: ['multihop', 'signing'],
  },
  'multihop': {
    title: 'Two-hop chains',
    body: [
      'The entry sees your IP but not your destinations; the exit sees your destinations, and your traffic reaches it only through the entry. Neither alone watches both ends of your browsing.',
      "Buying a session means asking a node for its keys, and for the exit that request is carried by the entry hop, so the exit sees the entry's address and never yours.",
      'One thing it does not cover: while you were choosing, this app asked candidate nodes what they support, directly. That question carries no wallet and no session, but it did come from you.',
      'The two hops must be in different countries and on different networks, and the exit is paid from its own wallet.',
      'It is not anonymity. Two operators working together can still match the traffic itself, since the same bytes cross both hops at the same moments.',
      'Every packet crosses two nodes, often on two continents: measured on a live chain, about 20 times the latency of one hop, at 2 to 3 MB/s.',
      'Exit nodes do not report usage to the chain, so the chain closes the exit session about 2 hours after you buy it, however much time or data you paid for. That ends the chain.',
    ],
    related: ['node-sees', 'wallets', 'sessions'],
  },
  'switching': {
    title: 'Switching nodes',
    body: [
      'One connection runs at a time, and the blockchain cannot be reached through the tunnel, so the current connection has to go before the new one can be bought.',
      'Until the new one is up, apps reach the internet directly, and the kill switch is off.',
      'The session you leave stays open: go back to it from Sessions, or end it there. Left unused, the blockchain closes it by itself.',
    ],
    related: ['sessions', 'kill-switch'],
  },
  'extend': {
    title: 'Extending a session',
    body: [
      'Extend buys a new session on the same node while your connection keeps running, moves your connection onto it, then ends the old session.',
      'It costs two network fees: one to buy the new session and one to end the old one.',
      'The move pauses your connection for a few seconds, and downloads or calls in progress restart. With the kill switch on, nothing leaves outside the tunnel during the pause.',
      "What is left of the old session's deposit comes back to your wallet when the chain settles it, about 2 hours later.",
      'On WireGuard and AmneziaWG, Extend needs a node known to run dvpnx: dvpnd closes your current tunnel as soon as a new session is set up.',
    ],
    related: ['sessions', 'fees', 'billing'],
  },
  'proxy-mode': {
    title: 'Local proxy mode',
    body: [
      'The app runs a SOCKS5 proxy on your computer instead of a tunnel. Nothing about your routing changes.',
      'Only apps you point at the proxy use the connection. Everything else leaves your device as normal, and there is no kill switch.',
      'Only nodes running v2ray, xray or hysteria2 can serve a local proxy.',
    ],
    related: ['kill-switch', 'dns'],
  },
  'health': {
    title: 'Node health',
    body: [
      'The health flag comes from the node list. That check runs elsewhere and can be hours out of date, so a node that failed it may well be working.',
      "The app also sends its own probe to the node's API port. A node can answer it and still fail to build a tunnel.",
      'A failed handshake is cancelled and refunded automatically.',
      'The chain refuses a session with a node that is not registered as active, so that one cannot be overridden.',
    ],
    related: ['sessions'],
  },
  'kill-switch': {
    title: 'Kill switch',
    body: [
      'The kill switch blocks all traffic if the VPN drops.',
      'Local network sharing lets you reach other devices on your network (SSH, printers, NAS) while it is on. That traffic stays on your LAN and is not encrypted by the VPN.',
      'While you switch nodes, apps reach the internet directly until the new connection is up, and the kill switch is off.',
      'If it stays on after your session ended, nothing leaves the machine untunnelled. Use Restore internet in the banner, or turn the kill switch off in Settings.',
    ],
    related: ['switching', 'dns'],
  },
  'dns': {
    title: 'DNS',
    body: [
      'The resolver you choose is applied when the VPN connects, which prevents DNS leaks to your ISP.',
      "On V2Ray nodes, a chosen resolver is queried over encrypted DNS (DoH), so the node can't see your lookups.",
      'System Default stays plaintext, and it is usually your router.',
    ],
    related: ['kill-switch', 'proxy-mode'],
  },
  'signing': {
    title: 'Signed replies',
    body: [
      'Nodes on dvpnd 9.4 or later sign the keys and addresses they hand this app. The signature is checked against the key the chain knows the node by, and a reply without one is refused, so nobody on your network can answer in its place.',
      'Most nodes do not sign yet. They use self-signed certificates and there is nothing on chain to check them against, so whoever can intercept the setup request can answer it. Worth knowing when the observer you are avoiding is the network you are on.',
      'The Signed filter in the node list shows only nodes that sign.',
    ],
    related: ['node-sees'],
  },
  'sessions': {
    title: 'Sessions and settlement',
    body: [
      'Buying a session puts a deposit on chain. You pay the node only for what it reports you used.',
      'End the session when you are done. Whatever is left of your deposit goes back to your wallet when the chain settles the session, about 2 hours later.',
      'The chain closes a session the node stops reporting usage for. Every usage report pushes that deadline back, so it only counts down when nothing is getting through.',
      'Ended sessions stay listed until the chain settles them, up to two hours after they end.',
    ],
    related: ['billing', 'fees', 'extend'],
  },
  'billing': {
    title: 'Per GB or per hour',
    body: [
      'Per GB, you pay for the data you send and receive.',
      'Per hour, the node counts time from your first connect to your last use, time away in between included. A session you have not connected to stays at zero.',
      'Paid time ends at a fixed moment, connected or not. After that, reconnecting would cost the whole session, and ending it charges you only up to your last use.',
      'A node bills the gaps while you are disconnected too (measured on one session so far). For on-and-off use, paying per GB is the fairer deal.',
    ],
    related: ['sessions'],
  },
  'fees': {
    title: 'Network fees',
    body: [
      'Buying or ending a session, subscribing to a plan, leasing a node and editing a provider or a plan are on-chain transactions, and each one costs a network fee.',
      'The funds check before you pay counts the fee as well as the price.',
      'Starting a session on a plan you already paid for costs the network fee only. Extend costs two fees: one to buy the new session and one to end the old one.',
    ],
    related: ['sessions', 'extend'],
  },
  'plans': {
    title: 'What a plan is',
    body: [
      'A plan is a prepaid bundle from a provider: one purchase covers every node the provider links to it, usually cheaper than paying a single node per GB.',
      'It is gigabytes over a period, at the provider\'s price. Starting a session on a plan you already paid for costs the network fee only.',
      'Pick for me checks the plan\'s nodes and picks the fastest healthy one. If the first choice fails, the next is tried without paying the plan price again.',
    ],
    related: ['fees', 'catalog-visibility'],
  },
  'provider': {
    title: 'Being a provider',
    body: [
      'A provider publishes subscription plans on the Sentinel chain. Subscribers pay you for a plan, and you cover them with bandwidth by leasing nodes and linking those nodes to the plan.',
      'The provider address is your wallet address in provider form, and the same key signs for both.',
      'The registration deposit is set by chain governance and paid into the community pool, so it cannot be reclaimed by deactivating later. There is no way to remove a provider from the chain once it exists.',
      'You are inactive right after registering. A second transaction activates you, and plans can only go live while the provider is active.',
    ],
    related: ['leases', 'catalog-visibility'],
  },
  'leases': {
    title: 'Leasing nodes',
    body: [
      'A provider pays a node operator by the hour to carry the plan traffic, then links the node to the plan.',
      'Leases are billed by the hour whether or not anyone connects.',
      'Subscribers to the plan can connect through a linked node. Linking a node you already lease costs the network fee only, and unlinking it leaves the lease as it was.',
    ],
    related: ['provider', 'fees'],
  },
  'catalog-visibility': {
    title: 'Who sees your plans',
    body: [
      'Plans are created inactive. The Plans catalog only ever lists active plans, and activating one lists it for subscribers.',
      'The catalog\'s "Ready to connect" filter is on by default and drops any plan counted at zero nodes.',
      'When a provider\'s name reads as a test account, this app\'s catalog files its plans under Test plans, hidden by default.',
      'A private plan stays active and existing subscriptions are unaffected, but it drops out of the catalog for anyone who has not chosen to show private plans.',
    ],
    related: ['provider', 'plans'],
  },
  'wallets': {
    title: 'Wallets and recovery phrases',
    body: [
      'Your funds are on chain. If this app cannot unlock a stored seed, import the same recovery phrase again.',
      'If your keyring did not answer, start or unlock it, then restart the app. Removing a locked wallet deletes the stored seed.',
      'Only the active wallet shows a balance: reading every stored address at once would tell the RPC operator that one IP owns them all.',
      'A two-hop chain pays its exit from a second wallet. Fund it from a source that never touched the first: transfers are public.',
    ],
    related: ['multihop'],
  },
}
