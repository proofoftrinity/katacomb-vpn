// The node's signature over its handshake reply.
//
// The handshake channel authenticates nothing (docs/invariants/node-trust.md): the
// node's TLS certificate is self-signed and the chain records none, so whoever
// answers the POST can hand us their own keys and addresses. dvpnd nodes, from 9.4,
// sign the reply with the key the chain knows the node by, and send the signature in
// a header so the JSON body stays what every client already parses:
//
//   X-Dvpnd-Signature: secp256k1:<base64 compressed public key>;<base64 r||s>
//   digest = SHA-256( "dvpnd/handshake-reply/v1" || BE64(session id)
//                     || SHA-256(request data) || SHA-256(reply data)
//                     || addrs joined by "\n" )
//
// signed the way we sign our request: ECDSA over SHA-256 of the digest. `request
// data` is the peer request we signed, `reply data` is result.data decoded. A key
// whose account is the node's own is the node; any other key must hold the node
// account's authz grant for MsgUpdateNodeStatusRequest (a "hot key", which keeps the
// operator's key off the server). Written from dvpnd's spec (its docs/protocols.md),
// not its code; the digest vector in the test is the one dvpnd pins.
//
// Electron-free, so the native test runner can load it.

import { Secp256k1, Secp256k1Signature, sha256 } from '@cosmjs/crypto'
import { rawSecp256k1PubkeyToRawAddress } from '@cosmjs/amino'
import { fromBech32, toBech32 } from '@cosmjs/encoding'

/** On every response of a node that signs, so we can tell before paying. */
export const REPLY_SIGNING_HEADER = 'x-dvpnd-reply-signing'
/** The one scheme this checks; also the digest's domain string. */
export const REPLY_SIGNING_SCHEME = 'dvpnd/handshake-reply/v1'
/** The message a hot key must be granted to count as the node. */
export const NODE_STATUS_MSG_TYPE = '/sentinel.node.v3.MsgUpdateNodeStatusRequest'

/** Who signed a reply: the node account, a key it granted, or nobody. */
export type ReplySigner = 'node' | 'hotKey' | 'unsigned'

/** A reply whose signature is present but does not hold: never connect on it. */
export class ReplySignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplySignatureError'
  }
}

/** The 32 bytes the node signs (see the header comment). */
export function replyDigest(sessionId: string, request: Uint8Array, reply: Uint8Array, addrs: string[]): Uint8Array {
  const id = Buffer.alloc(8)
  id.writeBigUInt64BE(BigInt(sessionId))
  return sha256(Buffer.concat([
    Buffer.from(REPLY_SIGNING_SCHEME, 'utf8'),
    id,
    sha256(request),
    sha256(reply),
    Buffer.from(addrs.join('\n'), 'utf8'),
  ]))
}

/**
 * Check the reply's signature. Returns who signed, 'unsigned' when the header is
 * absent, and throws ReplySignatureError when a signature is there but does not
 * verify, or verifies under a key the node account never granted. `hasGrant` asks the
 * chain; it is only called for a key that is not the node's own.
 */
export async function checkReplySignature(params: {
  header: string | undefined
  sessionId: string
  /** The peer request exactly as signed and sent (the body's `data`, decoded). */
  request: Uint8Array
  result: { data?: unknown; addrs?: unknown }
  /** The node's sentnode1… address, from the chain. */
  nodeAddress: string
  hasGrant: (granter: string, grantee: string) => Promise<boolean>
}): Promise<ReplySigner> {
  const { header, sessionId, request, result, nodeAddress, hasGrant } = params
  if (header === undefined || header === '') return 'unsigned'

  const match = /^secp256k1:([A-Za-z0-9+/=]+);([A-Za-z0-9+/=]+)$/.exec(header.trim())
  if (!match) throw new ReplySignatureError('The node sent a malformed reply signature.')
  const pubkey = Buffer.from(match[1], 'base64')
  const signature = Buffer.from(match[2], 'base64')
  if (pubkey.length !== 33 || signature.length !== 64) {
    throw new ReplySignatureError('The node sent a malformed reply signature.')
  }
  if (typeof result.data !== 'string') {
    throw new ReplySignatureError('The node signed a reply without data.')
  }
  const addrs = result.addrs === undefined ? [] : result.addrs
  if (!Array.isArray(addrs) || !addrs.every((a) => typeof a === 'string')) {
    throw new ReplySignatureError('The node signed a reply with malformed addresses.')
  }

  const digest = replyDigest(sessionId, request, Buffer.from(result.data, 'base64'), addrs)
  const valid = await Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(signature), sha256(digest), pubkey)
  if (!valid) {
    throw new ReplySignatureError(
      "The node's reply signature does not match its reply. Someone on the network may be answering in the node's place.",
    )
  }

  const node = fromBech32(nodeAddress).data
  const signer = rawSecp256k1PubkeyToRawAddress(pubkey)
  if (Buffer.from(signer).equals(Buffer.from(node))) return 'node'

  const granter = toBech32('sent', node)
  const grantee = toBech32('sent', signer)
  if (await hasGrant(granter, grantee)) return 'hotKey'
  throw new ReplySignatureError(
    `The reply was signed by ${grantee}, a key the node account has not authorised. Someone on the network may be answering in the node's place.`,
  )
}
