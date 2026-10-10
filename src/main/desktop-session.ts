/**
 * Quit with the desktop session: register with the session manager over the session
 * D-Bus, so a logout or a shutdown from the desktop runs the normal quit and waits for it.
 *
 * Without this, a GNOME logout crashed the app every time ([REL-36] in
 * docs/invariants/reliability.md). Launched from the app grid, Chromium forks its zygotes
 * before gnome-shell has moved the new PID into the app's scope, so the zygotes, the GPU
 * process and the renderer stay in gnome-shell's own unit. Logging out stops that unit,
 * systemd kills them, the main process (in its own scope) gets no signal at all, fails to
 * relaunch the GPU process through the dead zygote six times in about 3 ms, and Chromium
 * crashes itself on purpose: SIGTRAP, an apport report, and no teardown, so a tunnel left
 * up outlived the app with nothing watching its quota.
 *
 * GNOME's session manager (also Cinnamon's and MATE's, which kept the interface) asks each
 * registered client before it ends the session and waits for it. EndSession starts the
 * normal quit and is deliberately never answered: GNOME takes a client that exits as having
 * answered, and this connection only closes when Electron frees Node, after Chromium's main
 * loop has ended and it no longer relaunches the GPU process. An answer sent just before
 * app.exit(0) was too early: Chromium's shutdown after it still needs the GPU process, GNOME
 * stopped the shell inside that window, and two logouts in three still crashed. Where no
 * session manager answers, this gives up quietly and the app behaves as before.
 *
 * No D-Bus library: the client sends four calls and reads three signals, and the wire
 * format below is only as much of the spec as those need. The tests hold it to bytes
 * recorded from GDBus, dbus-daemon and gnome-session.
 */
import { createConnection, type Socket } from 'node:net'

const METHOD_CALL = 1
const METHOD_RETURN = 2
const ERROR = 3
const SIGNAL = 4
/** Don't start a session manager just because we called one. */
const NO_AUTO_START = 2

const F_PATH = 1
const F_INTERFACE = 2
const F_MEMBER = 3
const F_ERROR_NAME = 4
const F_REPLY_SERIAL = 5
const F_DESTINATION = 6
const F_SENDER = 7
const F_SIGNATURE = 8

const BUS = 'org.freedesktop.DBus'
const SM = 'org.gnome.SessionManager'
const CLIENT = 'org.gnome.SessionManager.ClientPrivate'
/** The desktop entry's id; the session manager shows it as the client's name. */
const APP_ID = 'katacomb-vpn'
/** Far above anything this client is sent; a bigger frame is a broken stream. */
const MAX_MESSAGE = 1 << 20
const REGISTER_TIMEOUT_MS = 10_000

export interface Call {
  destination: string
  path: string
  interface: string
  member: string
  args: Array<['s', string] | ['b', boolean]>
  flags?: number
}

export interface Message {
  type: number
  serial: number
  path?: string
  interface?: string
  member?: string
  errorName?: string
  replySerial?: number
  destination?: string
  sender?: string
  signature: string
  /** The body's first argument when it is a string or an object path; nothing else is read. */
  arg0?: string
}

const align = (n: number, to: number): number => Math.ceil(n / to) * to

class Writer {
  readonly out: number[] = []
  align(to: number): void { while (this.out.length % to) this.out.push(0) }
  byte(b: number): void { this.out.push(b) }
  u32(v: number): void { this.align(4); this.out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24) }
  string(s: string): void { const b = Buffer.from(s, 'utf8'); this.u32(b.length); this.out.push(...b, 0) }
  signature(s: string): void { this.out.push(s.length, ...Buffer.from(s, 'latin1'), 0) }
}

/** A little-endian method call, header fields in the order GDBus writes them. */
export function encodeCall(serial: number, c: Call): Buffer {
  const body = new Writer()
  for (const [type, value] of c.args) {
    if (type === 's') body.string(value)
    else body.u32(value ? 1 : 0)
  }
  const signature = c.args.map(([type]) => type).join('')
  const h = new Writer()
  h.out.push(0x6c, METHOD_CALL, c.flags ?? 0, 1)
  h.u32(body.out.length)
  h.u32(serial)
  h.u32(0) // the header fields' length, filled in below
  const field = (code: number, type: string, write: () => void): void => {
    h.align(8)
    h.byte(code)
    h.signature(type)
    write()
  }
  field(F_PATH, 'o', () => h.string(c.path))
  field(F_INTERFACE, 's', () => h.string(c.interface))
  field(F_DESTINATION, 's', () => h.string(c.destination))
  if (signature) field(F_SIGNATURE, 'g', () => h.signature(signature))
  field(F_MEMBER, 's', () => h.string(c.member))
  const fieldsLength = h.out.length - 16
  h.align(8)
  const out = Buffer.from([...h.out, ...body.out])
  out.writeUInt32LE(fieldsLength, 12)
  return out
}

/** Bytes the message at the head of `buf` takes, or 0 while its fixed header is incomplete. */
export function messageLength(buf: Buffer): number {
  if (buf.length < 16) return 0
  return align(16 + buf.readUInt32LE(12), 8) + buf.readUInt32LE(4)
}

/** One whole message. Throws on anything malformed. Little-endian only: every peer on an
 *  x86_64 machine writes it, and the bus forwards a message in its sender's byte order. */
export function decodeMessage(m: Buffer): Message {
  if (m[0] !== 0x6c) throw new Error(`not a little-endian message (first byte ${m[0]})`)
  const u32 = (at: number): number => m.readUInt32LE(at)
  let o = 16
  const str = (): string => {
    o = align(o, 4)
    const n = u32(o)
    if (o + 4 + n >= m.length) throw new Error('string runs past the message')
    const s = m.toString('utf8', o + 4, o + 4 + n)
    o += 5 + n
    return s
  }
  const sig = (): string => {
    const n = m[o]
    if (o + 1 + n >= m.length) throw new Error('signature runs past the message')
    const s = m.toString('latin1', o + 1, o + 1 + n)
    o += 2 + n
    return s
  }
  const msg: Message = { type: m[1], serial: u32(8), signature: '' }
  const end = 16 + u32(12)
  while (o < end) {
    o = align(o, 8)
    if (o >= end) throw new Error('header fields run past their length')
    const code = m[o++]
    const type = sig()
    let value: string | number
    if (type === 's' || type === 'o') value = str()
    else if (type === 'g') value = sig()
    else if (type === 'u') { o = align(o, 4); value = u32(o); o += 4 }
    else throw new Error(`header field ${code} has type '${type}'`)
    if (code === F_PATH) msg.path = value as string
    else if (code === F_INTERFACE) msg.interface = value as string
    else if (code === F_MEMBER) msg.member = value as string
    else if (code === F_ERROR_NAME) msg.errorName = value as string
    else if (code === F_REPLY_SERIAL) msg.replySerial = value as number
    else if (code === F_DESTINATION) msg.destination = value as string
    else if (code === F_SENDER) msg.sender = value as string
    else if (code === F_SIGNATURE) msg.signature = value as string
  }
  if (msg.signature[0] === 's' || msg.signature[0] === 'o') {
    o = align(end, 8)
    msg.arg0 = str()
  }
  return msg
}

/** The socket in DBUS_SESSION_BUS_ADDRESS: its first `unix:path=` or `unix:abstract=` entry. */
export function busSocketPath(address: string | undefined): string | null {
  for (const entry of (address ?? '').split(';')) {
    const colon = entry.indexOf(':')
    if (entry.slice(0, colon) !== 'unix') continue
    for (const pair of entry.slice(colon + 1).split(',')) {
      const eq = pair.indexOf('=')
      let value: string
      try { value = decodeURIComponent(pair.slice(eq + 1)) } catch { continue }
      if (pair.slice(0, eq) === 'path') return value
      if (pair.slice(0, eq) === 'abstract') return `\0${value}`
    }
  }
  return null
}

export interface DesktopSessionOptions {
  /** DBUS_SESSION_BUS_ADDRESS. */
  address: string | undefined
  uid: number
  /** DESKTOP_AUTOSTART_ID, set when the session manager itself started the app. */
  startupId: string
  /** Start the app's quit. Called at most once, on EndSession or Stop. */
  onEndSession: () => void
}

export function registerWithDesktopSession(opts: DesktopSessionOptions): void {
  const socketPath = busSocketPath(opts.address)
  if (!socketPath) return

  let socket: Socket | null = createConnection({ path: socketPath })
  let serial = 0
  const pending = new Map<number, { resolve: (m: Message) => void, reject: (e: Error) => void }>()
  let clientPath: string | null = null
  let manager: string | null = null // the unique name that registered us; only it is obeyed
  let ended = false

  const fail = (why: string): void => {
    if (!socket) return
    console.log(`[session] ${why}`)
    socket.destroy()
    socket = null
    for (const p of pending.values()) p.reject(new Error(why))
    pending.clear()
  }
  const timer = setTimeout(() => fail('no desktop session manager answered'), REGISTER_TIMEOUT_MS)
  timer.unref()

  const call = (c: Call): Promise<Message> => new Promise((resolve, reject) => {
    if (!socket) { reject(new Error('the session bus is gone')); return }
    pending.set(++serial, { resolve, reject })
    socket.write(encodeCall(serial, c))
  })
  /** The answer to QueryEndSession: yes. Sent without waiting for its reply. */
  const agree = (): void => {
    socket?.write(encodeCall(++serial, {
      destination: SM, path: clientPath!, interface: CLIENT, member: 'EndSessionResponse',
      args: [['b', true], ['s', '']],
    }))
  }
  const quit = (): void => {
    if (ended) return
    ended = true
    opts.onEndSession()
  }

  const onMessage = (m: Message): void => {
    if ((m.type === METHOD_RETURN || m.type === ERROR) && m.replySerial !== undefined) {
      const p = pending.get(m.replySerial)
      if (!p) return
      pending.delete(m.replySerial)
      if (m.type === ERROR) p.reject(new Error(`${m.errorName}: ${m.arg0 ?? ''}`))
      else p.resolve(m)
      return
    }
    if (m.type !== SIGNAL || m.path !== clientPath || m.interface !== CLIENT || m.sender !== manager) return
    // Agreed at once: the app never objects to a logout, it only needs the time to quit.
    if (m.member === 'QueryEndSession') agree()
    // Never answered: the app exiting is the answer (see the top of this file).
    else if (m.member === 'EndSession' || m.member === 'Stop') quit()
  }

  const register = async (): Promise<void> => {
    try {
      await call({ destination: BUS, path: '/org/freedesktop/DBus', interface: BUS, member: 'Hello', args: [] })
      const reply = await call({
        destination: SM, path: '/org/gnome/SessionManager', interface: SM, member: 'RegisterClient',
        args: [['s', APP_ID], ['s', opts.startupId]], flags: NO_AUTO_START,
      })
      if (!reply.arg0 || !reply.sender) throw new Error('RegisterClient returned no client')
      clientPath = reply.arg0
      manager = reply.sender
      await call({
        destination: BUS, path: '/org/freedesktop/DBus', interface: BUS, member: 'AddMatch',
        args: [['s', `type='signal',sender='${SM}',interface='${CLIENT}',path='${clientPath}'`]],
      })
      clearTimeout(timer)
      console.log(`[session] registered with the desktop session manager as ${clientPath}`)
    } catch (e) {
      fail(`not registered with a desktop session manager: ${(e as Error).message}`)
    }
  }

  let buf = Buffer.alloc(0)
  let authed = false
  socket.on('connect', () => {
    socket?.write(`\0AUTH EXTERNAL ${Buffer.from(String(opts.uid)).toString('hex')}\r\n`)
  })
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    if (!authed) {
      const nl = buf.indexOf('\r\n')
      if (nl < 0) return
      const line = buf.toString('latin1', 0, nl)
      buf = buf.subarray(nl + 2)
      if (!line.startsWith('OK ')) { fail(`the session bus refused us: ${line}`); return }
      authed = true
      socket?.write('BEGIN\r\n')
      void register()
    }
    for (;;) {
      const n = messageLength(buf)
      if (n > MAX_MESSAGE) { fail(`the session bus sent a ${n}-byte message`); return }
      if (n === 0 || buf.length < n) return
      const frame = buf.subarray(0, n)
      buf = buf.subarray(n)
      let m: Message
      try { m = decodeMessage(frame) } catch (e) { fail(`unreadable message from the session bus: ${(e as Error).message}`); return }
      onMessage(m)
      if (!socket) return
    }
  })
  socket.on('error', (e) => fail(`session bus: ${e.message}`))
  socket.on('close', () => fail('the session bus closed'))
}
