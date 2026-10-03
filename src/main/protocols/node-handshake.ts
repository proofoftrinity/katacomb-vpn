// The node handshake POST, reimplemented so it can be sent through a proxy and so its
// response headers can be read.
//
// The bundled SDK's `handshake()` is a bare axios POST with a fixed
// `https.Agent({rejectUnauthorized:false})` and no way to supply another one (checked
// against the published 2.1.0 dist, and the Go SDK's node client is the same: only
// WithInsecure/WithTimeout), and it returns the body's `result` alone. A multihop chain
// has to reach the EXIT node through the entry hop, which needs an agent we choose; and
// a dvpnd node signs its reply in a header (reply-signature.ts), which the SDK drops.
// So every handshake, direct or proxied, goes through this.
//
// `node-handshake.test.ts` pins this to the SDK by capturing what the real SDK puts on
// the wire and asserting this produces the identical bytes. If the SDK ever changes its
// message construction, that test fails rather than a node silently rejecting us.
//
// Electron-free, so the native test runner can load it.

import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'
import { Secp256k1, sha256 } from '@cosmjs/crypto'

/**
 * The header a dvpnd node signs its reply in (checked by reply-signature.ts), as Node
 * names it: lowercase. Not imported from there: the native test runner cannot resolve
 * a sibling module's extensionless import.
 */
const REPLY_SIGNATURE_HEADER = 'x-dvpnd-signature'

/** The exact JSON body a dvpnx node expects at `POST /`. */
export interface HandshakeBody {
  data: string
  id: number
  pub_key: string
  signature: string
}

/**
 * The bytes the node verifies the signature over: the session id as 8 big-endian bytes,
 * followed by the UTF-8 JSON of the peer request. Mirrors the SDK's `buildMsg`.
 */
export function buildHandshakeMessage(sessionId: string, data: unknown): Uint8Array {
  const id = Buffer.alloc(8)
  id.writeBigUInt64BE(BigInt(sessionId))
  return Buffer.concat([id, Buffer.from(JSON.stringify(data), 'utf8')])
}

/**
 * Build the signed request body. Async because CosmJS signs asynchronously.
 *
 * The signature is the 64-byte compact form (r || s) that libsecp256k1's `ecdsaSign`
 * returns, which is what the SDK sends and what the node's Go side verifies. CosmJS
 * produces the same canonical low-S signature; the equivalence test is what proves it
 * rather than this comment.
 */
export async function buildHandshakeBody(
  sessionId: string,
  data: unknown,
  privKey: Uint8Array,
): Promise<HandshakeBody> {
  if (!/^\d+$/.test(sessionId)) throw new Error(`Invalid session id "${sessionId}"`)
  const hash = sha256(buildHandshakeMessage(sessionId, data))
  const signature = await Secp256k1.createSignature(hash, privKey)
  const compact = Buffer.concat([signature.r(32), signature.s(32)])
  const { pubkey } = await Secp256k1.makeKeypair(privKey)
  const compressed = Secp256k1.compressPubkey(pubkey)
  return {
    data: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    id: Number(sessionId),
    pub_key: `secp256k1:${Buffer.from(compressed).toString('base64')}`,
    signature: compact.toString('base64'),
  }
}

/** What a node returns from a successful handshake (`types.Response.result`). */
export interface HandshakeResult {
  data?: unknown
  addrs?: unknown
}

/** The node's `result`, and its signature over it when it sent one. */
export interface HandshakeReply {
  result: HandshakeResult
  /** The X-Dvpnd-Signature header; undefined from a node that does not sign. */
  signature: string | undefined
}

/**
 * POST a handshake and return the node's `result` with its reply signature, through
 * `agent` when one is given.
 *
 * Errors are shaped like the axios ones the rest of the connect path already handles, so
 * `describeNodeApiError` and `describeHandshakeError` keep working unchanged: a non-2xx
 * carries `.response = {status, data}`, which is where dvpnx puts `{error:{code,message}}`
 * and where the 409-conflict logic reads from.
 */
export function postHandshake(
  remoteUrl: string,
  body: HandshakeBody,
  opts: { agent?: https.Agent; timeoutMs: number },
): Promise<HandshakeReply> {
  const trimmed = remoteUrl.replace(/\/$/, '').trim()
  const target = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  const payload = Buffer.from(JSON.stringify(body), 'utf8')

  // Nodes serve https, but `isSafeNodeApiUrl` allows a plain-http endpoint and the SDK
  // honours one too, so follow the URL rather than assuming.
  const transport = target.protocol === 'http:' ? http : https

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        // URL.port is a STRING, and '' when the URL carries no explicit port. Passing it
        // straight through is what broke the proxied exit handshake: http.get(urlString)
        // would have coerced it via urlToHttpOptions, but building options by hand skips
        // that. undefined lets Node pick the protocol default, which '' also did.
        port: target.port === '' ? undefined : Number(target.port),
        path: target.pathname === '' ? '/' : target.pathname,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        // Self-signed node certificates: same posture as the SDK and node-tester. The
        // caller's agent carries its own rejectUnauthorized:false.
        agent: opts.agent,
        rejectUnauthorized: false,
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk: Buffer) => { raw += chunk.toString() })
        res.on('end', () => {
          let parsed: { result?: HandshakeResult; error?: unknown } | undefined
          try { parsed = JSON.parse(raw) } catch { /* reported below */ }
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            const err = new Error(`Request failed with status code ${status}`) as Error & {
              response?: { status: number; data?: unknown }
            }
            err.response = { status, data: parsed ?? raw }
            reject(err)
            return
          }
          if (!parsed || parsed.result === undefined) {
            reject(new Error('Node returned an invalid handshake response'))
            return
          }
          const signature = res.headers[REPLY_SIGNATURE_HEADER]
          resolve({ result: parsed.result, signature: typeof signature === 'string' ? signature : undefined })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`Handshake timed out after ${opts.timeoutMs}ms`))
    })
    req.end(payload)
  })
}
