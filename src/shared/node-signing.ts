// Which nodes sign their handshake replies, as far as the node directory can tell.
//
// dvpnd signs from 9.4.0 (X-Dvpnd-Signature, checked by
// src/main/protocols/reply-signature.ts). The directory's version string is a CLAIM
// about the node, made by its operator: sentinel-dvpnx reports 9.0.0 today and nothing
// stops it reporting a higher number one day. Main holds a node to it: a node listed
// at 9.4+ must say it signs before paying (its X-Dvpnd-Reply-Signing header) and must
// sign the reply, or the connect is refused. The renderer uses it for the Signed filter
// and the review's rows. A node that claims 9.4 and does not sign only refuses itself.

const FIRST_SIGNING_VERSION = [9, 4, 0] as const

/** Whether `version` reads as `min` or later; false when it does not read as a version. */
function atLeast(version: string, min: readonly [number, number, number]): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i]
  }
  return true
}

/** True when a node reporting `version` should sign its handshake replies. */
export function versionSignsReplies(version: string): boolean {
  return atLeast(version, FIRST_SIGNING_VERSION)
}

/**
 * Which node software answers, or null when that cannot be told. dvpnd names itself
 * (`version.name` in its root document, in every release since it forked at 9.0.0),
 * signs its replies from 9.4.0, and is the only one past 9.0. dvpnx names nothing and
 * reports 8.x or 9.0.0, so a version string of 9.0.0 alone fits both: only the root
 * document's name tells them apart there. `name` is undefined when the root document
 * was not asked (the directory's version alone); a version before 8.2.0 was never read.
 * Extend keys D3 off this ([REL-46]).
 */
export function nodeSoftware(n: { version: string; name?: string; signedReply?: boolean }): 'dvpnd' | 'dvpnx' | null {
  if (n.signedReply || n.name === 'dvpnd' || atLeast(n.version, [9, 1, 0])) return 'dvpnd'
  if (n.name) return null
  return atLeast(n.version, [8, 2, 0]) ? 'dvpnx' : null
}

