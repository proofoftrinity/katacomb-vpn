// Pure helpers for the node-list V2Ray connection badge.
//
// These derive a display badge + a cleartext flag from the node-list API's
// `connection` claim ({proxy, transport, security} strings). This is the
// COSMETIC, pre-connect counterpart to the security-critical numeric classifier
// in src/main/config-guard.ts (classifyV2RayInbound / v2raySecurityBadge), which
// runs on the SDK's post-handshake metadata. The two are deliberately separate:
// this one consumes UNTRUSTED API strings in the renderer and only hints the UI;
// config-guard consumes verified SDK enums in the main process and enforces. Keep
// the badge strings and the vless+none rule in sync between the two.

export interface NodeConnection {
  proxy: string
  transport: string
  security: string
}

/**
 * Narrow the untrusted/loosely-typed API value to a NodeConnection. Returns
 * false for null, primitives, `{}`, and odd shapes like `{proto:'udp'}` seen on
 * the stray type-0/3 nodes.
 */
export function isNodeConnection(conn: unknown): conn is NodeConnection {
  if (!conn || typeof conn !== 'object') return false
  const c = conn as Record<string, unknown>
  return typeof c.proxy === 'string' && typeof c.transport === 'string' && typeof c.security === 'string'
}

/**
 * Single source of truth for classifying a connection claim. Combos:
 * vmess→vmess(+tls), vless→vless-tls or vless-none (cleartext). null/odd→unknown.
 * The badge and cleartext flag below both derive from this so they can't drift,
 * and it's the key the node-list connection sub-filter toggles on.
 */
export type V2RayCategory = 'vmess' | 'vmess-tls' | 'vless-tls' | 'vless-none' | 'unknown'

export function v2rayConnectionCategory(conn: unknown): V2RayCategory {
  if (!isNodeConnection(conn)) return 'unknown'
  const proxy = conn.proxy.toLowerCase()
  const tls = conn.security.toLowerCase() === 'tls'
  if (proxy === 'vmess') return tls ? 'vmess-tls' : 'vmess'
  // VLess has no cipher of its own — without TLS the proxy hop is cleartext.
  return tls ? 'vless-tls' : 'vless-none'
}

// Compact node-list badge per category. 'unknown' has no badge (caller renders
// "unknown"). Strings match config-guard's v2raySecurityBadge output.
const CATEGORY_BADGE: Record<V2RayCategory, string | null> = {
  vmess: 'VMess',
  'vmess-tls': 'VMess+TLS',
  'vless-tls': 'VLess+TLS',
  'vless-none': 'VLess ⚠',
  unknown: null,
}

/**
 * True only for the known-bad VLess-none combo. null/unknown/odd shapes are NOT
 * flagged (we never whitelist). Mirrors config-guard's numeric rule.
 */
export function isCleartextConnection(conn: unknown): boolean {
  return v2rayConnectionCategory(conn) === 'vless-none'
}

/**
 * Compact human badge for the node list, e.g. "VMess", "VMess+TLS", "VLess+TLS",
 * or "VLess ⚠" for cleartext. Returns null when there is no usable connection
 * claim, so the caller can render "unknown".
 */
export function v2rayConnectionBadge(conn: unknown): string | null {
  return CATEGORY_BADGE[v2rayConnectionCategory(conn)]
}

/**
 * What the pre-connect review says about a V2Ray (2) or XRAY (4) node's encryption,
 * from the node list's claim. The other protocols this client runs always encrypt,
 * so the review names them itself.
 *
 * Reality is checked FIRST, by its own name. It is XRAY's TLS replacement, and
 * v2rayConnectionCategory (written for V2Ray, which has no Reality) files anything
 * that is not literally `tls` under VLess-none: asked directly, it would call every
 * Reality node cleartext. 22 of the 23 XRAY nodes in the list publish a connection.
 */
export function v2rayEncryption(conn: unknown): { ok: boolean; text: string; detail: string } {
  if (!isNodeConnection(conn)) {
    return {
      ok: false,
      text: 'Encryption is only known at connect time',
      detail: 'The node list does not say how this node wraps its traffic. It tells this app when you connect, and a node offering only VLess without TLS is refused then, with the session refunded.',
    }
  }
  if (conn.security.toLowerCase() === 'reality') {
    return {
      ok: true,
      text: `Encrypted: ${conn.proxy.toLowerCase() === 'vmess' ? 'VMess' : 'VLess'}+Reality`,
      detail: 'Reality wraps this hop in TLS that looks like an ordinary website to anyone watching.',
    }
  }
  switch (v2rayConnectionCategory(conn)) {
    case 'vless-none':
      return {
        ok: false,
        text: 'Not encrypted: VLess without TLS',
        detail: 'The node list says this node offers VLess without TLS, which has no cipher of its own. If that is all it offers, this app refuses it at the handshake and the session is refunded.',
      }
    case 'vmess':
      return {
        ok: true,
        text: 'Encrypted: VMess',
        detail: 'VMess encrypts with its own cipher. Without TLS it can still be recognised as a proxy by anyone watching.',
      }
    default:
      return { ok: true, text: `Encrypted: ${v2rayConnectionBadge(conn)}`, detail: 'This hop is wrapped in TLS.' }
  }
}
