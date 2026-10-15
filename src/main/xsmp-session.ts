/**
 * Quit with a KDE session: register with its session manager over XSMP, so a logout runs the
 * normal quit before the session tears down.
 *
 * KDE Plasma on X11 (5.27, Kubuntu 24.04's default) has no D-Bus registration for apps: its
 * ksmserver speaks only XSMP, the X11 session protocol, and a logout takes X down about 0.35 s
 * after the request without telling anyone else. Electron's answer to losing X is
 * `LOG(FATAL) << "Failed to shutdown."` (electron_browser_main_parts.cc), so every Plasma logout
 * crashed the app and skipped its teardown ([REL-36] in docs/invariants/reliability.md).
 * ksmserver asks each XSMP client whether the session may end (SaveYourself), tells it to go
 * (Die), and then waits up to 10 s for it to disconnect. As with the D-Bus client, Die starts
 * the normal quit and is never answered: the connection closes only when Electron frees Node,
 * after the teardown, and ksmserver ended the session only once it saw that (traced in the
 * release VM).
 *
 * No libICE: XSMP runs on ICE, and this client sends seven kinds of message and acts on eight.
 * Each is written as libICE and libSM write it, and the tests hold it to frames recorded
 * between libSM and ksmserver. It asks to be left out of the session the desktop restores at
 * the next login (RestartStyleHint never): a VPN client that starts itself is not something the
 * user chose.
 */
import { createConnection } from 'node:net'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ICE's own messages (major opcode 0).
const ICE_ERROR = 0
const ICE_BYTE_ORDER = 1
const ICE_CONNECTION_SETUP = 2
const ICE_AUTH_REQUIRED = 3
const ICE_AUTH_REPLY = 4
const ICE_CONNECTION_REPLY = 6
const ICE_PROTOCOL_SETUP = 7
const ICE_PROTOCOL_REPLY = 8
// XSMP's, under the major opcode each side picks for it.
const SM_REGISTER_CLIENT = 1
const SM_REGISTER_CLIENT_REPLY = 2
const SM_SAVE_YOURSELF = 3
const SM_SAVE_YOURSELF_DONE = 8
const SM_DIE = 9
const SM_SET_PROPERTIES = 12

const LSB_FIRST = 0
const AUTH = 'MIT-MAGIC-COOKIE-1'
/** The major opcode this client sends XSMP under; the session manager names its own. */
const XSMP_OPCODE = 1
const SM_RESTART_NEVER = 3
/** Far above anything this client is sent; a bigger message is a broken stream. */
const MAX_MESSAGE = 1 << 16
const REGISTER_TIMEOUT_MS = 10_000

const pad = (n: number, to: number): number => (to - (n % to)) % to

/** ICE's STRING: a 16-bit length and the bytes, padded to 4. */
function iceString(s: string): Buffer {
  const out = Buffer.alloc(2 + s.length + pad(2 + s.length, 4))
  out.writeUInt16LE(s.length)
  out.write(s, 2, 'latin1')
  return out
}

/** XSMP's ARRAY8: a 32-bit length and the bytes, padded to 8. */
function array8(b: Buffer): Buffer {
  const out = Buffer.alloc(4 + b.length + pad(4 + b.length, 8))
  out.writeUInt32LE(b.length)
  b.copy(out, 4)
  return out
}

/** A count for a LIST, padded to 8. */
function count(n: number): Buffer {
  const out = Buffer.alloc(8)
  out.writeUInt32LE(n)
  return out
}

/** One message: a header carrying two bytes of its own, then the body in whole 8-byte units. */
function message(major: number, minor: number, data: [number, number], ...body: Buffer[]): Buffer {
  const b = Buffer.concat(body)
  const out = Buffer.alloc(8 + b.length + pad(b.length, 8))
  out.set([major, minor, ...data])
  out.writeUInt32LE((out.length - 8) / 8, 4)
  b.copy(out, 8)
  return out
}

/** Protocol version 1.0, the only one either side speaks. */
const VERSION_1_0 = Buffer.from([1, 0, 0, 0])

const BYTE_ORDER = message(0, ICE_BYTE_ORDER, [LSB_FIRST, 0])
const CONNECTION_SETUP = message(0, ICE_CONNECTION_SETUP, [1, 1],
  Buffer.alloc(8), iceString('MIT'), iceString('1.0'), iceString(AUTH), VERSION_1_0)
const PROTOCOL_SETUP = message(0, ICE_PROTOCOL_SETUP, [XSMP_OPCODE, 0],
  Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), iceString('XSMP'), iceString('MIT'), iceString('1.0'), iceString(AUTH), VERSION_1_0)
/** No previous client id: a new client every launch. */
const REGISTER_CLIENT = message(XSMP_OPCODE, SM_REGISTER_CLIENT, [0, 0], array8(Buffer.alloc(0)))
const RESTART_NEVER = message(XSMP_OPCODE, SM_SET_PROPERTIES, [0, 0], count(1),
  array8(Buffer.from('RestartStyleHint')), array8(Buffer.from('CARD8')), count(1), array8(Buffer.from([SM_RESTART_NEVER])))
const SAVE_YOURSELF_DONE = message(XSMP_OPCODE, SM_SAVE_YOURSELF_DONE, [1, 0])

function authReply(cookie: Buffer): Buffer {
  const length = Buffer.alloc(8)
  length.writeUInt16LE(cookie.length)
  return message(0, ICE_AUTH_REPLY, [0, 0], length, cookie)
}

/** The session manager's address in SESSION_MANAGER: its first `local/` or `unix/` entry, whose
 *  text is also the network id its cookies are filed under. A leading `@` is the abstract namespace. */
export function iceAddress(sessionManager: string | undefined): { networkId: string, path: string } | null {
  for (const networkId of (sessionManager ?? '').split(',')) {
    const m = /^(?:local|unix)\/[^:]*:(.+)$/.exec(networkId)
    if (m) return { networkId, path: m[1].startsWith('@') ? `\0${m[1].slice(1)}` : m[1] }
  }
  return null
}

/** The MIT-MAGIC-COOKIE-1 an ICE authority file holds under ICE for `networkId`, the answer to
 *  both questions, ICE's and XSMP's: libICE sends it for both, and ksmserver rejects the cookie
 *  it files under XSMP (seen in the release VM). Each entry is five fields, each a big-endian
 *  16-bit length and its bytes. */
function iceCookie(file: Buffer, networkId: string): Buffer | null {
  let o = 0
  const field = (): Buffer => {
    const n = file.readUInt16BE(o)
    const v = file.subarray(o + 2, o + 2 + n)
    o += 2 + n
    return v
  }
  try {
    while (o < file.length) {
      const [proto, , id, name, data] = [field(), field(), field(), field(), field()]
      if (String(proto) === 'ICE' && String(id) === networkId && String(name) === AUTH) return data
    }
  } catch { /* a truncated file: no cookie */ }
  return null
}

export interface XsmpOptions {
  /** SESSION_MANAGER. */
  sessionManager: string | undefined
  /** ICEAUTHORITY; libICE's default, ~/.ICEauthority, when unset. */
  iceAuthority: string | undefined
  /** Start the app's quit. Called at most once, on Die. */
  onEndSession: () => void
}

export function registerWithXsmp(opts: XsmpOptions): void {
  const address = iceAddress(opts.sessionManager)
  if (!address) return
  void readFile(opts.iceAuthority ?? join(homedir(), '.ICEauthority'))
    .then((authority) => connect(address, authority, opts.onEndSession))
    .catch((e: Error) => console.log(`[session] no X session manager cookie: ${e.message}`))
}

function connect(address: { networkId: string, path: string }, authority: Buffer, onEndSession: () => void): void {
  let socket: ReturnType<typeof createConnection> | null = createConnection({ path: address.path })
  let smOpcode = -1 // the major opcode the session manager sends XSMP under
  let registered = false
  let ended = false

  const fail = (why: string): void => {
    if (!socket) return
    if (!registered) console.log(`[session] not registered with the X session manager: ${why}`)
    socket.destroy()
    socket = null
  }
  const timer = setTimeout(() => fail('it never answered'), REGISTER_TIMEOUT_MS)
  timer.unref()
  const send = (b: Buffer): void => { socket?.write(b) }

  const onMessage = (m: Buffer): void => {
    const [major, minor] = [m[0], m[1]]
    if (major === 0) {
      if (minor === ICE_BYTE_ORDER && m[2] !== LSB_FIRST) fail('it writes big-endian')
      else if (minor === ICE_AUTH_REQUIRED) {
        const cookie = iceCookie(authority, address.networkId)
        if (cookie) send(authReply(cookie))
        else fail(`no ICE cookie for ${address.networkId}`)
      } else if (minor === ICE_CONNECTION_REPLY) {
        send(PROTOCOL_SETUP)
      } else if (minor === ICE_PROTOCOL_REPLY) {
        smOpcode = m[3]
        send(REGISTER_CLIENT)
      } else if (minor === ICE_ERROR) fail('it refused the connection')
      return
    }
    if (major !== smOpcode) return
    if (minor === SM_REGISTER_CLIENT_REPLY) {
      registered = true
      clearTimeout(timer)
      send(RESTART_NEVER)
      console.log('[session] registered with the X session manager')
    }
    // Agreed at once, shutdown or not: the app has nothing to save and never objects to a logout.
    else if (minor === SM_SAVE_YOURSELF) send(SAVE_YOURSELF_DONE)
    // Never answered: the app exiting closes the connection, which is what ksmserver waits for.
    else if (minor === SM_DIE && !ended) {
      ended = true
      onEndSession()
    }
  }

  let buf = Buffer.alloc(0)
  socket.on('connect', () => send(Buffer.concat([BYTE_ORDER, CONNECTION_SETUP])))
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 8) {
      const n = 8 + 8 * buf.readUInt32LE(4)
      if (n > MAX_MESSAGE) { fail(`it sent a ${n}-byte message`); return }
      if (buf.length < n) return
      const m = buf.subarray(0, n)
      buf = buf.subarray(n)
      onMessage(m)
      if (!socket) return
    }
  })
  socket.on('error', (e) => fail(e.message))
  socket.on('close', () => fail('it closed the connection'))
}
