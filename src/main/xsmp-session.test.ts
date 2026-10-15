import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { registerWithXsmp, iceAddress } from './xsmp-session.ts'

// Recorded, not written by hand: a logging proxy between ksmserver (Plasma 5.27.12, Ubuntu
// 24.04) and libSM driven through ctypes making this client's calls in this client's order,
// from connection to logout (2026-10-15). KSM is what ksmserver sent, as it sent it. LIBSM is
// what libSM sent, except that libICE and libSM leave unused and pad bytes uninitialised: those
// are zeroed here, as this client writes them.
const hex = (s: string): Buffer => Buffer.from(s, 'hex')
const KSM = {
  byteOrder: hex('0001001400000000'),
  // MIT-MAGIC-COOKIE-1, the only method offered: send the cookie
  authRequired: hex('00030014010000000000000000000000'),
  // ICE is up: vendor "MIT", release "1.0"
  connectionReply: hex('000600140200000003004d49540000000300312e30636430'),
  // the same for XSMP
  protocolAuthRequired: hex('000300140100000000004d4954000000'),
  // a wrong cookie: "MIT-MAGIC-COOKIE-1 authentication rejected" (recorded with the cookie
  // ksmserver files under XSMP, which it never accepts)
  authRejected: hex('000004000700000004014d49050000002a004d49542d4d414749432d434f4f4b49452d312061757468656e7469636174696f6e2072656a6563746564a4770000'),
  // XSMP is up, under major opcode 1: vendor "KDE", release "1.0"
  protocolReply: hex('000800010200000003004b44450000000300312e30636430'),
  // the client id
  registerClientReply: hex('010200010600000026000000313031343766646364636430303031373932303432383638303030303030343539323030303665004e006100'),
  // straight after registering: save your state (local, no shutdown), and it is saved
  saveYourself: hex('01030001010000000100000031303134'),
  saveComplete: hex('0112000100000000'),
  // logout, phase one: save, the session is ending (both, shutdown, any interaction)
  saveYourselfShutdown: hex('01030001010000000201020031303134'),
  // phase two: go
  die: hex('0109000100000000'),
}
const LIBSM = {
  byteOrder: hex('0001000000000000'),
  connectionSetup: hex('0002010106000000000000000000000003004d49540000000300312e3000000012004d49542d4d414749432d434f4f4b49452d3101000000'),
  // the 16-byte cookie filed under ICE, sent for ICE and again for XSMP: libICE answers both
  // with that one, and ksmserver checks both against it
  authReply: hex('000400000300000010000000000000004c5ec10866006300135e5ef488a5dc1b'),
  protocolSetup: hex('00070100070000000101000000000000040058534d50000003004d49540000000300312e3000000012004d49542d4d414749432d434f4f4b49452d3101000000'),
  registerClient: hex('01010000010000000000000000000000'),
  // RestartStyleHint = SmRestartNever (3), one CARD8
  restartNever: hex('010c000008000000010000000000000010000000526573746172745374796c6548696e74000000000500000043415244380000000000000001000000000000000100000003000000'),
  saveYourselfDone: hex('0108010000000000'),
}
const COOKIE = hex('4c5ec10866006300135e5ef488a5dc1b')

/** An ICE authority file: five fields per entry, each a big-endian 16-bit length and its bytes. */
function authorityFile(entries: Array<[string, string, string, Buffer]>): string {
  const field = (b: Buffer): Buffer => Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b])
  const path = join(mkdtempSync(join(tmpdir(), 'xsmp-auth-')), 'iceauth')
  writeFileSync(path, Buffer.concat(entries.flatMap(([protocol, networkId, name, data]) =>
    [field(Buffer.from(protocol)), field(Buffer.alloc(0)), field(Buffer.from(networkId)), field(Buffer.from(name)), field(data)])))
  return path
}

const name = (m: Buffer): string => m[0] === 0
  ? ['Error', 'ByteOrder', 'ConnectionSetup', 'AuthRequired', 'AuthReply', 'AuthNextPhase', 'ConnectionReply', 'ProtocolSetup', 'ProtocolReply'][m[1]] ?? `ICE ${m[1]}`
  : ({ 1: 'RegisterClient', 8: 'SaveYourselfDone', 11: 'CloseConnection', 12: 'SetProperties' } as Record<number, string>)[m[1]] ?? `XSMP ${m[1]}`

/** ksmserver on a real Unix socket: it answers each step of the setup with what ksmserver
 *  sent, and records every message the client sends. */
async function fakeKsmserver() {
  const path = join(mkdtempSync(join(tmpdir(), 'xsmp-')), 'ice')
  const received: Buffer[] = []
  const waiters: Array<{ n: number, resolve: () => void }> = []
  let conn: Socket | null = null
  let hungUp!: () => void
  const closed = new Promise<void>((r) => { hungUp = r })
  let authReplies = 0
  const answer = (c: Socket, m: Buffer): void => {
    const what = name(m)
    if (what === 'ByteOrder') c.write(KSM.byteOrder)
    else if (what === 'ConnectionSetup') c.write(KSM.authRequired)
    else if (what === 'AuthReply' && !m.subarray(16, 16 + m.readUInt16LE(8)).equals(COOKIE)) c.write(KSM.authRejected)
    else if (what === 'AuthReply') c.write(++authReplies === 1 ? KSM.connectionReply : KSM.protocolReply)
    else if (what === 'ProtocolSetup') c.write(KSM.protocolAuthRequired)
    else if (what === 'RegisterClient') c.write(Buffer.concat([KSM.registerClientReply, KSM.saveYourself, KSM.saveComplete]))
  }
  const server = createServer((c) => {
    conn = c
    let buf = Buffer.alloc(0)
    c.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 8 && buf.length >= 8 + 8 * buf.readUInt32LE(4)) {
        const n = 8 + 8 * buf.readUInt32LE(4)
        const m = buf.subarray(0, n)
        buf = buf.subarray(n)
        received.push(m)
        answer(c, m)
        for (const w of [...waiters]) if (received.length >= w.n) { waiters.splice(waiters.indexOf(w), 1); w.resolve() }
      }
    })
    c.on('close', () => hungUp())
  })
  await new Promise<void>((r) => server.listen(path, r))
  return {
    path,
    received,
    closed,
    send: (b: Buffer): void => { conn!.write(b) },
    /** Resolves once the client has sent `n` messages in all. */
    sent: (n: number): Promise<void> => received.length >= n ? Promise.resolve() : new Promise((resolve, reject) => {
      waiters.push({ n, resolve })
      setTimeout(() => reject(new Error(`the client sent ${received.length} messages, not ${n}`)), 2_000).unref()
    }),
    close: (): void => { conn?.destroy(); server.close() },
  }
}

function register(ksm: { path: string }, entries?: Array<[string, string, string, Buffer]>) {
  const networkId = `unix/testhost:${ksm.path}`
  let quits = 0
  let quitting!: () => void
  const quit = new Promise<void>((r) => { quitting = r })
  registerWithXsmp({
    sessionManager: `tcp/testhost:1234,${networkId}`,
    // Decoys first: another listener's cookies, and a cookie under another method. Last, the
    // cookie ksmserver files under XSMP: a different one, and it rejects it at either step.
    iceAuthority: authorityFile(entries ?? [
      ['ICE', 'unix/testhost:/tmp/.ICE-unix/1', 'MIT-MAGIC-COOKIE-1', Buffer.alloc(16, 1)],
      ['XSMP', 'unix/testhost:/tmp/.ICE-unix/1', 'MIT-MAGIC-COOKIE-1', Buffer.alloc(16, 2)],
      ['ICE', networkId, 'XDM-AUTHORIZATION-1', Buffer.alloc(16, 3)],
      ['ICE', networkId, 'MIT-MAGIC-COOKIE-1', COOKIE],
      ['XSMP', networkId, 'MIT-MAGIC-COOKIE-1', Buffer.alloc(16, 4)],
    ]),
    onEndSession: () => { quits++; quitting() },
  })
  return { quit, quits: () => quits }
}

describe('[REL-36] a KDE session ending is a quit too: XSMP', () => {
  test('registers with ksmserver as libSM does, and asks to be left out of the next login', async (t) => {
    const ksm = await fakeKsmserver()
    t.after(() => ksm.close())
    register(ksm)
    await ksm.sent(8)
    assert.deepEqual(ksm.received.map(name), [
      'ByteOrder', 'ConnectionSetup', 'AuthReply', 'ProtocolSetup', 'AuthReply', 'RegisterClient', 'SetProperties', 'SaveYourselfDone',
    ])
    assert.deepEqual(ksm.received, [
      LIBSM.byteOrder, LIBSM.connectionSetup, LIBSM.authReply, LIBSM.protocolSetup, LIBSM.authReply,
      LIBSM.registerClient,
      // Without it KDE would save the app in the session it restores, and the VPN client
      // would start itself at every login after one logout.
      LIBSM.restartNever,
      // The save straight after registering is agreed to: there is nothing to save.
      LIBSM.saveYourselfDone,
    ])
  })

  test('a logout quits on Die and is never answered: the app exiting closes the connection', { timeout: 5_000 }, async (t) => {
    const ksm = await fakeKsmserver()
    t.after(() => ksm.close())
    const { quit, quits } = register(ksm)
    await ksm.sent(8)
    // Phase one is agreed to at once and is not yet a quit: another client may still cancel.
    ksm.send(KSM.saveYourselfShutdown)
    await ksm.sent(9)
    assert.deepEqual(ksm.received[8], LIBSM.saveYourselfDone)
    await delay(50)
    assert.equal(quits(), 0)
    ksm.send(KSM.die)
    await quit
    // ksmserver waits for the connection to close, and only the process exiting closes it.
    const open = await Promise.race([ksm.closed.then(() => false), delay(50).then(() => true)])
    assert.ok(open, 'the client closed the connection on Die')
    assert.equal(ksm.received.length, 9, `answered Die with ${ksm.received.slice(9).map(name).join(', ')}`)
    ksm.send(KSM.die)
    await delay(50)
    assert.equal(quits(), 1)
  })

  test('without its cookie it hangs up at the first question and changes nothing', async (t) => {
    const ksm = await fakeKsmserver()
    t.after(() => ksm.close())
    const { quits } = register(ksm, [['ICE', 'unix/testhost:/tmp/.ICE-unix/1', 'MIT-MAGIC-COOKIE-1', COOKIE]])
    await ksm.closed
    assert.deepEqual(ksm.received.map(name), ['ByteOrder', 'ConnectionSetup'])
    assert.equal(quits(), 0)
  })

  test('finds the session manager in SESSION_MANAGER: a local or unix entry, abstract or not', () => {
    assert.deepEqual(iceAddress('local/kde:@/tmp/.ICE-unix/1586,unix/kde:/tmp/.ICE-unix/1586'),
      { networkId: 'local/kde:@/tmp/.ICE-unix/1586', path: '\0/tmp/.ICE-unix/1586' })
    assert.deepEqual(iceAddress('tcp/kde:41234,unix/kde:/tmp/.ICE-unix/1586'),
      { networkId: 'unix/kde:/tmp/.ICE-unix/1586', path: '/tmp/.ICE-unix/1586' })
    assert.equal(iceAddress('tcp/kde:41234'), null)
    assert.equal(iceAddress(''), null)
    assert.equal(iceAddress(undefined), null)
    // Nowhere to connect: nothing happens.
    registerWithXsmp({ sessionManager: undefined, iceAuthority: undefined, onEndSession: () => assert.fail() })
  })
})
