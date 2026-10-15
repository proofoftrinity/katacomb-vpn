import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  registerWithDesktopSession, decodeMessage, messageLength, busSocketPath, type Message,
} from './desktop-session.ts'

// Every frame below was recorded, not written by hand, so the client is held to what real
// peers send and expect. GNOME and GDBUS: Ubuntu 24.04 (gnome-session 46, dbus-daemon 1.14),
// `busctl --user capture` while a GDBus client registered as katacomb-vpn and the session
// logged out (2026-10-10). XFCE and GDBUS_XFCE: the same on Xfce 4.18 (xfce4-session
// 4.18.3), the GDBus client making the app's calls in the app's order, its RestartStyleHint
// included (2026-10-15). BARE: a
// private `dbus-run-session` bus with no session manager (2026-10-15). GDBUS* is what those
// clients sent; the bus appends a SENDER field on the way through, which is cut back out here.
const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const GNOME = {
  // the bus names the client :1.91
  helloReply: hex('6c0201010a000000010000003d00000006017300050000003a312e39310000000501750001000000080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000050000003a312e393100'),
  // and tells it so
  nameAcquired: hex('6c0401010a000000020000008d00000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e4442757300000000030173000c0000004e616d6541637175697265640000000006017300050000003a312e3931000000080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000050000003a312e393100'),
  // gnome-session (:1.31) answers RegisterClient (serial 2) with Client21
  registerReply: hex('6c020101270000001d0100002e00000006017300050000003a312e393100000008016700016f0000050175000200000007017300050000003a312e3331000000220000002f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e74323100'),
  // the bus answers serial 3
  addMatchReply: hex('6c02010100000000030000003500000006017300050000003a312e3931000000050175000300000007017300140000006f72672e667265656465736b746f702e4442757300000000'),
  // logout, phase one: may the session end?
  queryEndSession: hex('6c04010104000000220100008e00000001016f00220000002f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e74323100000000000002017300260000006f72672e676e6f6d652e53657373696f6e4d616e616765722e436c69656e745072697661746500000801670001750000030173000f0000005175657279456e6453657373696f6e0007017300050000003a312e333100000000000000'),
  // phase two: it is ending, quit and answer
  endSession: hex('6c040101040000003a0100008e00000001016f00220000002f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e74323100000000000002017300260000006f72672e676e6f6d652e53657373696f6e4d616e616765722e436c69656e745072697661746500000801670001750000030173000a000000456e6453657373696f6e00000000000007017300050000003a312e333100000000000000'),
  // phase three: exit now
  stop: hex('6c04010100000000540100008600000001016f00220000002f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e74323100000000000002017300260000006f72672e676e6f6d652e53657373696f6e4d616e616765722e436c69656e745072697661746500000801670000000000030173000400000053746f700000000007017300050000003a312e3331000000'),
  // the same broadcasts, to another client (Client19)
  otherQuery: hex('6c04010104000000210100008e00000001016f00220000002f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e74313900000000000002017300260000006f72672e676e6f6d652e53657373696f6e4d616e616765722e436c69656e745072697661746500000801670001750000030173000f0000005175657279456e6453657373696f6e0007017300050000003a312e333100000000000000'),
  otherEnd: hex('6c04010104000000390100008e00000001016f00220000002f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e74313900000000000002017300260000006f72672e676e6f6d652e53657373696f6e4d616e616765722e436c69656e745072697661746500000801670001750000030173000a000000456e6453657373696f6e00000000000007017300050000003a312e333100000000000000'),
}
const XFCE = {
  // the bus names the client :1.146
  helloReply: hex('6c0201010b000000010000003d00000006017300060000003a312e31343600000501750001000000080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000060000003a312e31343600'),
  nameAcquired: hex('6c0401010b000000020000008d00000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e4442757300000000030173000c0000004e616d6541637175697265640000000006017300060000003a312e3134360000080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000060000003a312e31343600'),
  // nobody owns GNOME's name here (answers serial 2)
  noGnome: hex('6c03010133000000030000007500000006017300060000003a312e313436000004017300290000006f72672e667265656465736b746f702e444275732e4572726f722e4e616d654861734e6f4f776e6572000000000000000501750002000000080167000173000007017300140000006f72672e667265656465736b746f702e44427573000000002e0000004e616d6520226f72672e676e6f6d652e53657373696f6e4d616e616765722220646f6573206e6f7420657869737400'),
  // xfce4-session (:1.94) answers RegisterClient (serial 3) with a path named after the app id
  registerReply: hex('6c0201012a0000004d0000002e00000006017300060000003a312e313436000008016700016f0000050175000300000007017300050000003a312e3934000000250000002f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e00'),
  // and takes RestartStyleHint (serial 4)
  setSmPropertiesReply: hex('6c020101000000004e0000002e00000006017300060000003a312e31343600000801670000000000050175000400000007017300050000003a312e3934000000'),
  // the bus answers serial 5
  addMatchReply: hex('6c02010100000000040000003500000006017300060000003a312e3134360000050175000500000007017300140000006f72672e667265656465736b746f702e4442757300000000'),
  // sent around each step of a logout; nothing to do
  stateChanged: hex('6c040101080000005c0000007e00000001016f00250000002f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e00000002017300170000006f72672e786663652e53657373696f6e2e436c69656e74000801670002757500030173000c00000053746174654368616e6765640000000007017300050000003a312e39340000000000000003000000'),
  queryEndSession: hex('6c040101040000005d0000007e00000001016f00250000002f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e00000002017300170000006f72672e786663652e53657373696f6e2e436c69656e74000801670001750000030173000f0000005175657279456e6453657373696f6e0007017300050000003a312e393400000001000000'),
  endSession: hex('6c040101040000006b0000007e00000001016f00250000002f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e00000002017300170000006f72672e786663652e53657373696f6e2e436c69656e74000801670001750000030173000a000000456e6453657373696f6e00000000000007017300050000003a312e393400000001000000'),
  // the same question, to another client
  otherQuery: hex('6c04010104000000640000009600000001016f003e0000002f6f72672f786663652f53657373696f6e436c69656e74732f3234373232646438305f616132615f346230345f616566625f313930653863373266633965000002017300170000006f72672e786663652e53657373696f6e2e436c69656e74000801670001750000030173000f0000005175657279456e6453657373696f6e0007017300050000003a312e393400000001000000'),
  // xfce4-session refusing SetSmProperties (serial 4), recorded by calling it on a client
  // path it never handed out
  refused: hex('6c03010153000000440000006700000004017300280000006f72672e667265656465736b746f702e444275732e4572726f722e556e6b6e6f776e4d6574686f64000000000000000006017300060000003a312e32303900000801670001730000050175000400000007017300060000003a312e31363000004e0000004f626a65637420646f6573206e6f74206578697374206174207061746820e2809c2f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e5f676f6e65e2809d00'),
}
const BARE = {
  // the bus names the client :1.1
  helloReply: hex('6c02010109000000010000003d00000006017300040000003a312e31000000000501750001000000080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000040000003a312e3100'),
  // nobody owns GNOME's name (answers serial 2)
  noGnome: hex('6c03010133000000030000007500000006017300040000003a312e310000000004017300290000006f72672e667265656465736b746f702e444275732e4572726f722e4e616d654861734e6f4f776e6572000000000000000501750002000000080167000173000007017300140000006f72672e667265656465736b746f702e44427573000000002e0000004e616d6520226f72672e676e6f6d652e53657373696f6e4d616e616765722220646f6573206e6f7420657869737400'),
  // nor Xfce's (answers serial 3)
  noXfce: hex('6c03010132000000040000007500000006017300040000003a312e310000000004017300290000006f72672e667265656465736b746f702e444275732e4572726f722e4e616d654861734e6f4f776e6572000000000000000501750003000000080167000173000007017300140000006f72672e667265656465736b746f702e44427573000000002d0000004e616d6520226f72672e786663652e53657373696f6e4d616e616765722220646f6573206e6f7420657869737400'),
}
const GDBUS = {
  // Hello, serial 1
  hello: hex('6c01000100000000010000006e00000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e444275730000000006017300140000006f72672e667265656465736b746f702e4442757300000000030173000500000048656c6c6f000000'),
  // RegisterClient('katacomb-vpn', ''), serial 2
  registerClient: hex('6c01000119000000020000009700000001016f00190000002f6f72672f676e6f6d652f53657373696f6e4d616e616765720000000000000002017300180000006f72672e676e6f6d652e53657373696f6e4d616e61676572000000000000000006017300180000006f72672e676e6f6d652e53657373696f6e4d616e6167657200000000000000000801670002737300030173000e0000005265676973746572436c69656e7400000c0000006b617461636f6d622d76706e000000000000000000'),
  // AddMatch for Client21's signals, serial 5
  addMatch: hex('6c01000191000000050000007900000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e444275730000000006017300140000006f72672e667265656465736b746f702e4442757300000000080167000173000003017300080000004164644d6174636800000000000000008c000000747970653d277369676e616c272c73656e6465723d276f72672e676e6f6d652e53657373696f6e4d616e61676572272c696e746572666163653d276f72672e676e6f6d652e53657373696f6e4d616e616765722e436c69656e7450726976617465272c706174683d272f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e7432312700'),
  // EndSessionResponse(true, '') from Client21, serial 6
  endSessionResponse: hex('6c0100010900000006000000ab00000001016f00220000002f6f72672f676e6f6d652f53657373696f6e4d616e616765722f436c69656e74323100000000000002017300260000006f72672e676e6f6d652e53657373696f6e4d616e616765722e436c69656e7450726976617465000006017300180000006f72672e676e6f6d652e53657373696f6e4d616e61676572000000000000000008016700026273000301730012000000456e6453657373696f6e526573706f6e7365000000000000010000000000000000'),
}
const GDBUS_XFCE = {
  // RegisterClient('katacomb-vpn', '') on GNOME's name with NO_AUTO_START, serial 2
  registerGnome: hex('6c01020119000000020000009700000001016f00190000002f6f72672f676e6f6d652f53657373696f6e4d616e616765720000000000000002017300180000006f72672e676e6f6d652e53657373696f6e4d616e61676572000000000000000006017300180000006f72672e676e6f6d652e53657373696f6e4d616e6167657200000000000000000801670002737300030173000e0000005265676973746572436c69656e7400000c0000006b617461636f6d622d76706e000000000000000000'),
  // the same on Xfce's, serial 3
  registerXfce: hex('6c01020119000000030000008f00000001016f00180000002f6f72672f786663652f53657373696f6e4d616e61676572000000000000000002017300180000006f72672e786663652e53657373696f6e2e4d616e61676572000000000000000006017300170000006f72672e786663652e53657373696f6e4d616e61676572000801670002737300030173000e0000005265676973746572436c69656e7400000c0000006b617461636f6d622d76706e000000000000000000'),
  // SetSmProperties({RestartStyleHint: <byte 3>}), never restart it, serial 4
  setSmProperties: hex('6c01000121000000040000009800000001016f00250000002f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e00000002017300170000006f72672e786663652e53657373696f6e2e436c69656e740006017300170000006f72672e786663652e53657373696f6e4d616e61676572000801670005617b73767d000000000000030173000f000000536574536d50726f7065727469657300190000000000000010000000526573746172745374796c6548696e740001790003'),
  // AddMatch for its client's signals, serial 5
  addMatch: hex('6c01000184000000050000007900000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e444275730000000006017300140000006f72672e667265656465736b746f702e4442757300000000080167000173000003017300080000004164644d6174636800000000000000007f000000747970653d277369676e616c272c73656e6465723d276f72672e786663652e53657373696f6e4d616e61676572272c696e746572666163653d276f72672e786663652e53657373696f6e2e436c69656e74272c706174683d272f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e2700'),
  // EndSessionResponse(true, ''), serial 6, sent without waiting (NO_REPLY_EXPECTED)
  endSessionResponse: hex('6c01010109000000060000009300000001016f00250000002f6f72672f786663652f53657373696f6e436c69656e74732f6b617461636f6d625f76706e00000002017300170000006f72672e786663652e53657373696f6e2e436c69656e740006017300170000006f72672e786663652e53657373696f6e4d616e616765720008016700026273000301730012000000456e6453657373696f6e526573706f6e7365000000000000010000000000000000'),
}

const SM = 'org.gnome.SessionManager'
const CLIENT21 = '/org/gnome/SessionManager/Client21'
const XFCE_CLIENT = '/org/xfce/SessionClients/katacomb_vpn'
/** `EndSessionResponse(true, '')`'s body, as GDBus writes it. */
const YES = '010000000000000000'

/** A copy of `frame` with another serial, to compare a call with GDBus's at a different place in the conversation. */
function withSerial(frame: Buffer, serial: number): Buffer {
  const out = Buffer.from(frame)
  out.writeUInt32LE(serial, 8)
  return out
}

interface Received { m: Message, frame: Buffer }

/** A session bus on a real Unix socket. It speaks the SASL handshake, records every call the
 *  client makes, and answers each with the recorded reply for its `world`. */
async function fakeBus(world: 'gnome' | 'xfce' | 'xfce-refuses' | 'bare') {
  const path = join(mkdtempSync(join(tmpdir(), 'desktop-session-')), 'bus')
  const received: Received[] = []
  const waiters: Array<{ pred: (r: Received) => boolean, resolve: (r: Received) => void }> = []
  let conn: Socket | null = null
  let authLine!: (line: string) => void
  let hungUp!: () => void
  const auth = new Promise<string>((r) => { authLine = r })
  const closed = new Promise<void>((r) => { hungUp = r })

  const answer = (c: Socket, m: Message): void => {
    const gnome = m.destination === 'org.gnome.SessionManager'
    const xfce = world === 'xfce' || world === 'xfce-refuses'
    if (m.member === 'Hello') {
      c.write(world === 'gnome' ? Buffer.concat([GNOME.helloReply, GNOME.nameAcquired])
        : xfce ? Buffer.concat([XFCE.helloReply, XFCE.nameAcquired]) : BARE.helloReply)
    } else if (m.member === 'RegisterClient') {
      if (world === 'gnome') c.write(GNOME.registerReply)
      else if (xfce) c.write(gnome ? XFCE.noGnome : XFCE.registerReply)
      else c.write(gnome ? BARE.noGnome : BARE.noXfce)
    } else if (m.member === 'SetSmProperties') {
      c.write(world === 'xfce-refuses' ? XFCE.refused : XFCE.setSmPropertiesReply)
    } else if (m.member === 'AddMatch') c.write(world === 'gnome' ? GNOME.addMatchReply : XFCE.addMatchReply)
  }
  const server = createServer((c) => {
    conn = c
    let buf = Buffer.alloc(0)
    let stage: 'auth' | 'begin' | 'messages' = 'auth'
    c.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (stage !== 'messages') {
          const nl = buf.indexOf('\r\n')
          if (nl < 0) return
          const line = buf.toString('latin1', 0, nl)
          buf = buf.subarray(nl + 2)
          if (stage === 'auth') { authLine(line); c.write('OK 2b3f1a8e2fe6b2bb77a1c7d03d9e4f10\r\n'); stage = 'begin' } else { assert.equal(line, 'BEGIN'); stage = 'messages' }
          continue
        }
        const n = messageLength(buf)
        if (n === 0 || buf.length < n) return
        const frame = buf.subarray(0, n)
        buf = buf.subarray(n)
        const r = { m: decodeMessage(frame), frame }
        received.push(r)
        answer(c, r.m)
        for (const w of [...waiters]) {
          if (w.pred(r)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(r) }
        }
      }
    })
    c.on('close', () => hungUp())
  })
  await new Promise<void>((r) => server.listen(path, r))
  return {
    address: `unix:path=${path}`,
    auth,
    closed,
    received,
    send: (frame: Buffer): void => { conn!.write(frame) },
    /** The first call, already made or still to come, that `pred` accepts. */
    next: (pred: (r: Received) => boolean): Promise<Received> => {
      const seen = received.find(pred)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve })
        setTimeout(() => reject(new Error('the client never made that call')), 2_000).unref()
      })
    },
    close: (): void => { conn?.destroy(); server.close() },
  }
}

const isAnswer = (r: Received): boolean => r.m.member === 'EndSessionResponse'
const answers = (bus: { received: Received[] }): Received[] => bus.received.filter(isAnswer)

function register(bus: { address: string }, startupId = '') {
  let quits = 0
  let quitting!: () => void
  const quit = new Promise<void>((r) => { quitting = r })
  const registered = registerWithDesktopSession({
    address: bus.address, uid: 1000, startupId,
    onEndSession: () => { quits++; quitting() },
  })
  return { quit, quits: () => quits, registered }
}

describe('[REL-36] desktop-session reads what gnome-session and the bus send', () => {
  test('decodes recorded replies, signals and errors', () => {
    for (const frame of [GNOME, XFCE, BARE, GDBUS, GDBUS_XFCE].flatMap((recorded) => Object.values(recorded))) {
      assert.equal(messageLength(frame), frame.length)
    }
    assert.deepEqual(decodeMessage(GNOME.registerReply), {
      type: 2, serial: 285, replySerial: 2, destination: ':1.91', sender: ':1.31', signature: 'o', arg0: CLIENT21,
    })
    assert.deepEqual(decodeMessage(GNOME.endSession), {
      type: 4, serial: 314, path: CLIENT21, interface: `${SM}.ClientPrivate`, member: 'EndSession',
      sender: ':1.31', signature: 'u',
    })
    assert.deepEqual(decodeMessage(GNOME.stop), {
      type: 4, serial: 340, path: CLIENT21, interface: `${SM}.ClientPrivate`, member: 'Stop',
      sender: ':1.31', signature: '',
    })
    assert.deepEqual(decodeMessage(BARE.noGnome), {
      type: 3, serial: 3, replySerial: 2, destination: ':1.1', sender: 'org.freedesktop.DBus', signature: 's',
      errorName: 'org.freedesktop.DBus.Error.NameHasNoOwner',
      arg0: 'Name "org.gnome.SessionManager" does not exist',
    })
    assert.deepEqual(decodeMessage(XFCE.registerReply), {
      type: 2, serial: 77, replySerial: 3, destination: ':1.146', sender: ':1.94', signature: 'o', arg0: XFCE_CLIENT,
    })
    assert.deepEqual(decodeMessage(XFCE.endSession), {
      type: 4, serial: 107, path: XFCE_CLIENT, interface: 'org.xfce.Session.Client', member: 'EndSession',
      sender: ':1.94', signature: 'u',
    })
  })

  test('refuses a truncated or foreign frame instead of reading past it', () => {
    assert.equal(messageLength(GNOME.endSession.subarray(0, 15)), 0)
    assert.throws(() => decodeMessage(GNOME.registerReply.subarray(0, GNOME.registerReply.length - 4)))
    const bigEndian = Buffer.from(GNOME.endSession)
    bigEndian[0] = 0x42
    assert.throws(() => decodeMessage(bigEndian), /little-endian/)
  })

  test('finds the bus socket in DBUS_SESSION_BUS_ADDRESS', () => {
    assert.equal(busSocketPath('unix:path=/run/user/1000/bus'), '/run/user/1000/bus')
    assert.equal(busSocketPath('unix:abstract=/tmp/dbus-AbC,guid=0123'), '\0/tmp/dbus-AbC')
    assert.equal(busSocketPath('tcp:host=localhost,port=1;unix:path=/tmp/a%20b'), '/tmp/a b')
    assert.equal(busSocketPath('tcp:host=localhost,port=1'), null)
    assert.equal(busSocketPath(''), null)
    assert.equal(busSocketPath(undefined), null)
  })
})

describe('[REL-36] the desktop session ending is a quit', () => {
  test('registers as katacomb-vpn and subscribes to its own client, each call as GDBus makes it', async (t) => {
    const bus = await fakeBus('gnome')
    t.after(() => bus.close())
    const { registered } = register(bus)
    assert.equal(await bus.auth, `\0AUTH EXTERNAL ${Buffer.from('1000').toString('hex')}`)
    assert.equal(await registered, true, 'registered, so the app does not also try XSMP')
    await bus.next((r) => r.m.member === 'AddMatch')
    assert.deepEqual(bus.received.map((r) => r.m.member), ['Hello', 'RegisterClient', 'AddMatch'])
    const [hello, registerClient, addMatch] = bus.received.map((r) => r.frame)
    assert.deepEqual(hello, GDBUS.hello)
    // GDBus lets the bus start a session manager that is not running; this client asks it
    // not to (NO_AUTO_START), and is otherwise byte for byte the same call.
    const noAutoStart = Buffer.from(GDBUS.registerClient)
    noAutoStart[2] = 2
    assert.deepEqual(registerClient, noAutoStart)
    assert.deepEqual(addMatch, withSerial(GDBUS.addMatch, 3))
  })

  test('passes on the startup id the session manager launched it with', async (t) => {
    const bus = await fakeBus('gnome')
    t.after(() => bus.close())
    register(bus, '10b9a8c7-autostart')
    const { frame } = await bus.next((r) => r.m.member === 'RegisterClient')
    // RegisterClient(app id, startup id): the body ends with the second string, as
    // length, bytes, NUL.
    const length = Buffer.alloc(4)
    length.writeUInt32LE(18)
    const id = Buffer.concat([length, Buffer.from('10b9a8c7-autostart'), Buffer.from([0])])
    assert.deepEqual(frame.subarray(-id.length), id)
  })

  test('a logout quits and is never answered: the app exiting is the answer', async (t) => {
    const bus = await fakeBus('gnome')
    t.after(() => bus.close())
    const { quit, quits } = register(bus)
    await bus.next((r) => r.m.member === 'AddMatch')
    bus.send(GNOME.endSession)
    await quit
    // GNOME stops the shell, and with it the app's GPU process, the moment it has an
    // answer, while Chromium's own shutdown still needs that process. A question sent
    // after the logout is the barrier: signals are handled in order, so its answer is
    // the first one only if the logout itself went unanswered.
    bus.send(GNOME.queryEndSession)
    const first = await bus.next(isAnswer)
    await delay(50)
    assert.equal(answers(bus).length, 1, 'EndSession was answered: GNOME would stop the shell under the quit')
    assert.deepEqual(first.frame, withSerial(GDBUS.endSessionResponse, 4))
    // Stop follows; the quit is already under way and runs once.
    bus.send(GNOME.stop)
    await delay(50)
    assert.equal(quits(), 1)
  })

  test('the question before a logout is answered yes at once, and does not quit', async (t) => {
    const bus = await fakeBus('gnome')
    t.after(() => bus.close())
    const { quits } = register(bus)
    await bus.next((r) => r.m.member === 'AddMatch')
    bus.send(GNOME.queryEndSession)
    const answer = await bus.next(isAnswer)
    assert.equal(answer.m.path, CLIENT21)
    assert.equal(answer.m.destination, SM)
    assert.equal(answer.frame.subarray(-9).toString('hex'), YES)
    await delay(50)
    assert.equal(answers(bus).length, 1)
    assert.equal(quits(), 0)
  })

  test('Stop on its own quits, and is not answered either', async (t) => {
    const bus = await fakeBus('gnome')
    t.after(() => bus.close())
    const { quit, quits } = register(bus)
    await bus.next((r) => r.m.member === 'AddMatch')
    bus.send(GNOME.stop)
    await quit
    await delay(50)
    assert.equal(quits(), 1)
    assert.equal(answers(bus).length, 0)
  })

  test("another client's signals, and ours from another sender, are ignored", async (t) => {
    const bus = await fakeBus('gnome')
    t.after(() => bus.close())
    const { quits } = register(bus)
    await bus.next((r) => r.m.member === 'AddMatch')
    // ':1.31' -> ':1.32': our client path, but not from the session manager that registered us.
    const forged = Buffer.from(GNOME.endSession.toString('latin1').replace(':1.31', ':1.32'), 'latin1')
    bus.send(Buffer.concat([GNOME.otherQuery, GNOME.otherEnd, forged]))
    // Signals are handled in order, so once our own question is answered the three before
    // it have been seen.
    bus.send(GNOME.queryEndSession)
    await bus.next(isAnswer)
    await delay(50)
    assert.equal(quits(), 0)
    assert.equal(answers(bus).length, 1)
  })

  test('without a session manager it hangs up and changes nothing', async (t) => {
    const bus = await fakeBus('bare')
    t.after(() => bus.close())
    const { quits, registered } = register(bus)
    await bus.closed
    // Not registered: the app tries XSMP next (KDE).
    assert.equal(await registered, false)
    // Asks GNOME's session manager, then Xfce's, and gives up.
    assert.deepEqual(bus.received.map((r) => [r.m.member, r.m.destination]), [
      ['Hello', 'org.freedesktop.DBus'],
      ['RegisterClient', 'org.gnome.SessionManager'],
      ['RegisterClient', 'org.xfce.SessionManager'],
    ])
    assert.equal(quits(), 0)
    // No usable bus address at all: nothing to connect to.
    for (const address of [undefined, 'tcp:host=localhost,port=1']) {
      assert.equal(await registerWithDesktopSession({ address, uid: 1000, startupId: '', onEndSession: () => assert.fail() }), false)
    }
  })
})

describe('[REL-36] an Xfce session ending is a quit too', () => {
  test("registers with Xfce's session manager once GNOME's is not there, each call as GDBus makes it", async (t) => {
    const bus = await fakeBus('xfce')
    t.after(() => bus.close())
    const { registered } = register(bus)
    assert.equal(await registered, true)
    assert.deepEqual(bus.received.map((r) => r.m.member),
      ['Hello', 'RegisterClient', 'RegisterClient', 'SetSmProperties', 'AddMatch'])
    const [hello, registerGnome, registerXfce, neverRestart, addMatch] = bus.received.map((r) => r.frame)
    assert.deepEqual(hello, GDBUS.hello)
    assert.deepEqual(registerGnome, GDBUS_XFCE.registerGnome)
    assert.deepEqual(registerXfce, GDBUS_XFCE.registerXfce)
    // Xfce saves every client in the session it restores at the next login; without
    // RestartStyleHint=never (3) the app would start itself at every login after one logout.
    assert.deepEqual(neverRestart, GDBUS_XFCE.setSmProperties)
    assert.deepEqual(addMatch, GDBUS_XFCE.addMatch)
  })

  test('if Xfce refuses to leave it out of the next login, it does not register at all', async (t) => {
    const bus = await fakeBus('xfce-refuses')
    t.after(() => bus.close())
    const { quits, registered } = register(bus)
    await bus.closed
    assert.equal(await registered, false)
    // The old behaviour (a crash at logout) rather than an app that starts itself.
    assert.deepEqual(bus.received.map((r) => r.m.member), ['Hello', 'RegisterClient', 'RegisterClient', 'SetSmProperties'])
    assert.equal(quits(), 0)
  })

  test('a logout quits and is never answered: the app exiting is the answer', async (t) => {
    const bus = await fakeBus('xfce')
    t.after(() => bus.close())
    const { quit, quits } = register(bus)
    await bus.next((r) => r.m.member === 'AddMatch')
    // Xfce waits for the client to exit (about 7 s at most, measured), as GNOME does.
    bus.send(Buffer.concat([XFCE.stateChanged, XFCE.endSession]))
    await quit
    // The same barrier as on GNOME: a question after the logout is the first one answered
    // only if the logout itself went unanswered.
    bus.send(XFCE.queryEndSession)
    const first = await bus.next(isAnswer)
    await delay(50)
    assert.equal(answers(bus).length, 1, 'EndSession was answered: Xfce would end the session under the quit')
    // GDBus marked its fire-and-forget answer NO_REPLY_EXPECTED; this client sends it as a
    // plain call, as on GNOME. Otherwise byte for byte the same.
    const plain = Buffer.from(GDBUS_XFCE.endSessionResponse)
    plain[2] = 0
    assert.deepEqual(first.frame, plain)
    assert.equal(quits(), 1)
  })

  test("the question before a logout is answered yes, and another client's is ignored", async (t) => {
    const bus = await fakeBus('xfce')
    t.after(() => bus.close())
    const { quits } = register(bus)
    await bus.next((r) => r.m.member === 'AddMatch')
    bus.send(Buffer.concat([XFCE.otherQuery, XFCE.stateChanged, XFCE.queryEndSession]))
    const answer = await bus.next(isAnswer)
    assert.equal(answer.m.path, XFCE_CLIENT)
    assert.equal(answer.m.destination, 'org.xfce.SessionManager')
    assert.equal(answer.frame.subarray(-9).toString('hex'), YES)
    await delay(50)
    assert.equal(answers(bus).length, 1)
    assert.equal(quits(), 0)
  })
})
