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

/** True when a node reporting `version` should sign its handshake replies. */
export function versionSignsReplies(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (v[i] !== FIRST_SIGNING_VERSION[i]) return v[i] > FIRST_SIGNING_VERSION[i]
  }
  return true
}
