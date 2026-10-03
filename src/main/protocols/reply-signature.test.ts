import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Secp256k1, sha256 } from '@cosmjs/crypto'
import { rawSecp256k1PubkeyToRawAddress } from '@cosmjs/amino'
import { toBech32 } from '@cosmjs/encoding'
import { checkReplySignature, replyDigest, ReplySignatureError } from './reply-signature.ts'

// The vector dvpnd pins in api/session TestReplyDigestVector and tools/e2e,
// computed there from the spec outside Go. If this fails, we and the nodes
// disagree about the bytes and every signed node would be refused.
test('the digest matches the vector dvpnd pins', () => {
  const digest = replyDigest(
    '42',
    Buffer.from('{"public_key":"abc"}'),
    Buffer.from('{"addrs":["10.8.0.2/32"],"metadata":[{"port":51820}]}'),
    ['203.0.113.1', 'node.example'],
  )
  assert.equal(Buffer.from(digest).toString('hex'), '8146f1e4b375b1e9ff799ccc91dc8304678a645c5e35b94575d33edd6d364882')
})

const NODE_KEY = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'))
const HOT_KEY = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'))
const SESSION_ID = '123456789'
const REQUEST = Buffer.from('{"uuid":"11111111-2222-4333-8444-555555555555"}')
const RESULT = {
  data: Buffer.from('{"metadata":[{"port":443,"tls_pin":"f0:20","obfs_password":""}]}').toString('base64'),
  addrs: ['203.0.113.10'],
}

async function compressedPubkey(priv: Uint8Array): Promise<Uint8Array> {
  return Secp256k1.compressPubkey((await Secp256k1.makeKeypair(priv)).pubkey)
}

/** The node address a key's account maps to (same bytes, sentnode prefix). */
async function nodeAddressOf(priv: Uint8Array): Promise<string> {
  return toBech32('sentnode', rawSecp256k1PubkeyToRawAddress(await compressedPubkey(priv)))
}

/** Sign a reply the way a dvpnd node does. */
async function sign(priv: Uint8Array, sessionId = SESSION_ID, result = RESULT): Promise<string> {
  const digest = replyDigest(sessionId, REQUEST, Buffer.from(result.data, 'base64'), result.addrs)
  const sig = await Secp256k1.createSignature(sha256(digest), priv)
  const compact = Buffer.concat([sig.r(32), sig.s(32)])
  return `secp256k1:${Buffer.from(await compressedPubkey(priv)).toString('base64')};${compact.toString('base64')}`
}

const noGrant = async (): Promise<boolean> => false

test('a reply signed by the node account is the node', async () => {
  const signer = await checkReplySignature({
    header: await sign(NODE_KEY), sessionId: SESSION_ID, request: REQUEST, result: RESULT,
    nodeAddress: await nodeAddressOf(NODE_KEY), hasGrant: noGrant,
  })
  assert.equal(signer, 'node')
})

test('no header is unsigned, not an error', async () => {
  const signer = await checkReplySignature({
    header: undefined, sessionId: SESSION_ID, request: REQUEST, result: RESULT,
    nodeAddress: await nodeAddressOf(NODE_KEY), hasGrant: noGrant,
  })
  assert.equal(signer, 'unsigned')
})

test('a hot key counts only with the node account grant, asked for the right pair', async () => {
  const nodeAddress = await nodeAddressOf(NODE_KEY)
  const asked: string[][] = []
  const signer = await checkReplySignature({
    header: await sign(HOT_KEY), sessionId: SESSION_ID, request: REQUEST, result: RESULT, nodeAddress,
    hasGrant: async (granter, grantee) => { asked.push([granter, grantee]); return true },
  })
  assert.equal(signer, 'hotKey')
  const granter = toBech32('sent', rawSecp256k1PubkeyToRawAddress(await compressedPubkey(NODE_KEY)))
  const grantee = toBech32('sent', rawSecp256k1PubkeyToRawAddress(await compressedPubkey(HOT_KEY)))
  assert.deepEqual(asked, [[granter, grantee]])

  await assert.rejects(
    checkReplySignature({
      header: await sign(HOT_KEY), sessionId: SESSION_ID, request: REQUEST, result: RESULT, nodeAddress, hasGrant: noGrant,
    }),
    ReplySignatureError,
  )
})

test('a reply changed on the way, or meant for another session, is refused', async () => {
  const nodeAddress = await nodeAddressOf(NODE_KEY)
  const header = await sign(NODE_KEY)
  const tampered = [
    { result: { ...RESULT, addrs: ['198.51.100.9'] } },
    { result: { ...RESULT, data: Buffer.from('{"metadata":[{"port":444}]}').toString('base64') } },
    { sessionId: '123456790' },
  ]
  for (const t of tampered) {
    await assert.rejects(
      checkReplySignature({
        header, sessionId: t.sessionId ?? SESSION_ID, request: REQUEST, result: t.result ?? RESULT, nodeAddress, hasGrant: noGrant,
      }),
      ReplySignatureError,
    )
  }
})

test('a malformed header is refused, never read as unsigned', async () => {
  const nodeAddress = await nodeAddressOf(NODE_KEY)
  for (const header of ['secp256k1:abc', 'ed25519:AAAA;BBBB', 'secp256k1:AAAA;BBBB']) {
    await assert.rejects(
      checkReplySignature({ header, sessionId: SESSION_ID, request: REQUEST, result: RESULT, nodeAddress, hasGrant: noGrant }),
      ReplySignatureError,
    )
  }
})
