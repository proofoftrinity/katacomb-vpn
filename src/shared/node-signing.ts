// Which nodes sign their handshake replies, as far as the node directory can tell.
//
// dvpnd signs from 9.4.0 (X-Dvpnd-Signature, checked by
// src/main/protocols/reply-signature.ts). The directory's version string is a HINT,
// not proof: sentinel-dvpnx reports 9.0.0 today and nothing stops it reporting a
// higher number one day. It only narrows what is offered when the user turns on
// "Signed nodes only"; before paying, the connect path asks the node itself (its
// X-Dvpnd-Reply-Signing header), and the signature on the reply is what is checked.

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
