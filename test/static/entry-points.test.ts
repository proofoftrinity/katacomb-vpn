import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { calleeName, calls, ipcKey, nodes, parse, sources, where } from '../harness/source.ts'
import {
  ACTIVE_WALLET_CALLS, BRING_UP_CALLS, PURCHASE_CALLS, SPEND, TUNNEL, WALLET_MUTATORS,
} from '../harness/entry-points.ts'

// The money and tunnel rules are about which handlers reach which calls, so they can
// be checked on the source: which handlers can buy a session, whether each one routes
// its handshake through a refund, whether each refuses while connected, whether every
// bring-up sits under the connection lock. The behaviour behind each rule is pinned
// separately; this file is what stops a NEW path from skipping it.

interface FileModel {
  sf: ts.SourceFile
  fns: Map<string, ts.Node> // top-level function declarations and const arrows, by name
  reach: (n: ts.Node) => Set<string>
}

function model(file: string): FileModel {
  const sf = parse(file)
  const fns = new Map<string, ts.Node>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) fns.set(st.name.text, st)
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          fns.set(d.name.text, d.initializer)
        }
      }
    }
  }
  const memo = new Map<ts.Node, Set<string>>()
  // Every name a node calls, following same-file functions it calls or passes along
  // (withConnectionLock(reapplyFirewall) reaches reapplyFirewall).
  const reach = (n: ts.Node): Set<string> => {
    const seen = memo.get(n)
    if (seen) return seen
    const out = new Set<string>()
    memo.set(n, out)
    for (const c of calls(n)) {
      const name = calleeName(c)
      if (name) out.add(name)
    }
    for (const id of nodes(n).filter(ts.isIdentifier)) {
      const f = fns.get(id.text)
      if (!f || f === n || (ts.isFunctionDeclaration(id.parent) && id.parent.name === id)) continue
      out.add(id.text)
      for (const x of reach(f)) out.add(x)
    }
    return out
  }
  return { sf, fns, reach }
}

interface Handler { key: string; fn: ts.Node; file: FileModel; at: string }
const handlers: Handler[] = []
for (const file of sources('src/main')) {
  const m = model(file)
  for (const c of calls(m.sf)) {
    const key = ipcKey(c.arguments[0])
    if (key && ts.isIdentifier(c.expression) && c.expression.text === 'handle' && c.arguments[1]) {
      handlers.push({ key, fn: c.arguments[1], file: m, at: where(c) })
    }
  }
}
const byKey = new Map(handlers.map((h) => [h.key, h]))
const reaching = (names: string[]) => handlers.filter((h) => names.some((n) => h.file.reach(h.fn).has(n))).map((h) => h.key).sort()
const reaches = (key: string, name: string) => byKey.get(key)!.file.reach(byKey.get(key)!.fn).has(name)

const ipc = model('src/main/ipc-handlers.ts')

/** True when `node` sits inside an argument of a call to `wrapper`. */
function insideCallTo(node: ts.Node, wrapper: string): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && calleeName(p) === wrapper && p.arguments.some((a) => a.pos <= node.pos && node.end <= a.end)) return true
  }
  return false
}

/** The same-file top-level function `node` is in, by name (null at module level). */
function enclosingFn(m: FileModel, node: ts.Node): string | null {
  for (const [name, fn] of m.fns) if (fn.pos <= node.pos && node.end <= fn.end) return name
  return null
}

test('the SPEND / TUNNEL / WALLET_MUTATORS lists are exactly the handlers that buy, bring up, or change the wallet', () => {
  assert.deepEqual(reaching(PURCHASE_CALLS), [...SPEND].sort(), 'update test/harness/entry-points.ts, and so every test looping over it')
  assert.deepEqual(reaching(BRING_UP_CALLS), [...TUNNEL].sort())
  assert.deepEqual(reaching(ACTIVE_WALLET_CALLS), [...WALLET_MUTATORS].sort())
})

test('[REL-1] every purchase handler routes its handshake through a refunding wrapper', () => {
  const missing = SPEND.filter((k) => !reaches(k, 'establishSessionOrRefund') && !reaches(k, 'establishChainOrRefund'))
  assert.deepEqual(missing, [])
})

test('[REL-1] a handshake runs only inside establishSessionOrRefund / establishChainOrRefund, or on a reconnect', () => {
  const HANDSHAKES = new Set(['performHandshake', 'handshakeChainEntry', 'handshakeChainExit'])
  const reconnect = byKey.get('CONNECTION_RECONNECT')!.fn
  const stray = calls(ipc.sf)
    .filter((c) => HANDSHAKES.has(calleeName(c) ?? ''))
    .filter((c) => {
      const fn = enclosingFn(ipc, c)
      if (fn === 'establishSessionOrRefund' || fn === 'establishChainOrRefund') return false
      // A reconnect buys nothing, so there is nothing to refund (reliability.md [REL-19]).
      if (reconnect.pos <= c.pos && c.end <= reconnect.end) return false
      return true
    })
    .map(where)
  assert.deepEqual(stray, [], 'a handshake after a purchase must be inside the wrapper that refunds it')
})

test('[REL-3] every purchase, bring-up and reconnect handler refuses while connected', () => {
  const missing = [...SPEND, ...TUNNEL, 'CONNECTION_RECONNECT'].filter((k) => !reaches(k, 'assertNotConnected'))
  assert.deepEqual(missing, [])
  // A connect queued behind another must see the first one's tunnel.
  const connect = byKey.get('CONNECTION_CONNECT')!.fn
  const unlocked = calls(connect).filter((c) => calleeName(c) === 'assertNotConnected' && !insideCallTo(c, 'withConnectionLock'))
  assert.deepEqual(unlocked.map(where), [], 'CONNECTION_CONNECT must check inside the lock')
})

test('[REL-4] the active wallet cannot change while a session is live', () => {
  assert.deepEqual(WALLET_MUTATORS.filter((k) => !reaches(k, 'assertNotConnected')), [])
  assert.deepEqual(['WALLET_END_SESSION', 'SUBSCRIPTION_CANCEL'].filter((k) => !reaches(k, 'connectionIsLive')), [])
  const settingsSet = byKey.get('SETTINGS_SET')!.fn
  const allowed = nodes(settingsSet).filter((n): n is ts.NewExpression =>
    ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Set')
  assert.equal(allowed.length, 1, 'SETTINGS_SET filters through one allow-list Set')
  const keys = nodes(allowed[0]).filter(ts.isStringLiteral).map((s) => s.text)
  assert.ok(keys.length > 0 && !keys.includes('activeWalletId'), 'only wallet.ts may write activeWalletId')
})

/**
 * Bring-ups and tear-downs in ipc-handlers.ts that run outside the connection lock.
 * A call is locked when it sits inside a withConnectionLock argument, or inside a
 * function every reference to which is itself locked. `known` lists references
 * (`caller->callee`) to treat as locked anyway.
 */
function unlockedTunnelOps(known: Set<string>): string[] {
  const OPS = new Set([...BRING_UP_CALLS, 'disconnect'])
  // Startup only: healOrphanedTunnel runs in whenReady before registerIpcHandlers,
  // when no handler or timer exists to race it (reliability.md [REL-31]).
  const UNLOCKED_OK = new Set(['healOrphanedTunnel'])
  const locked = new Map<string, boolean>()
  const fnLocked = (name: string, stack: string[]): boolean => {
    if (locked.has(name)) return locked.get(name)!
    if (stack.includes(name)) return true // recursion: decided by the outer references
    const refs = nodes(ipc.sf).filter((n): n is ts.Identifier => ts.isIdentifier(n) && n.text === name &&
      !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n) && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n))
    const ok = refs.length > 0 && refs.every((r) => known.has(`${enclosingFn(ipc, r)}->${name}`) || positionLocked(r, [...stack, name]))
    locked.set(name, ok)
    return ok
  }
  const positionLocked = (n: ts.Node, stack: string[]): boolean => {
    if (insideCallTo(n, 'withConnectionLock')) return true
    const fn = enclosingFn(ipc, n)
    return fn !== null && fnLocked(fn, stack)
  }
  return calls(ipc.sf)
    .filter((c) => ts.isIdentifier(c.expression) && OPS.has(c.expression.text))
    .filter((c) => !UNLOCKED_OK.has(enclosingFn(ipc, c) ?? '') && !positionLocked(c, []))
    .map((c) => `${where(c)} ${calleeName(c)} in ${enclosingFn(ipc, c) ?? '<module>'}`)
}

// Found by this test (2026-10-07), waiting on the user's approval to fix: the
// reconnect give-up path calls teardownToIdle outside the lock. The interface monitor
// never reaches it (it skips while reconnectAttempt > 0), but the V2Ray exit callback
// has no such guard, so a core dying during the last attempt tears down while the
// locked attempt may still be bringing the tunnel up - and nothing bumps the epoch.
const KNOWN_UNLOCKED = new Set(['attemptReconnect->teardownToIdle'])

test('[REL-2] every tunnel bring-up and tear-down runs under the connection lock', () => {
  assert.deepEqual(unlockedTunnelOps(KNOWN_UNLOCKED), [], 'wrap it in withConnectionLock, or call it only from code that holds the lock')
})

test.todo('[REL-2] the reconnect give-up tears down under the lock too (known gap, fix awaiting approval)', () => {
  assert.deepEqual(unlockedTunnelOps(new Set()), [])
})

test('[REL-11] every purchase handler runs the preflight before its first purchase', () => {
  const problems: string[] = []
  for (const key of SPEND) {
    const fn = byKey.get(key)!.fn
    if (!reaches(key, 'preflightConnect')) { problems.push(`${key}: no preflightConnect`); continue }
    const own = calls(fn)
    const firstPreflight = own.find((c) => calleeName(c) === 'preflightConnect')
    const firstBuy = own.find((c) => PURCHASE_CALLS.includes(calleeName(c) ?? ''))
    if (firstPreflight && firstBuy && firstBuy.pos < firstPreflight.pos) problems.push(`${key}: buys at ${where(firstBuy)} before the preflight`)
  }
  assert.deepEqual(problems, [])
})

test('[MH-5] each chain hop is graded before it is bought', () => {
  const chain = byKey.get('CONNECTION_SUBSCRIBE_CHAIN')!.fn
  const grade = calls(chain).find((c) => calleeName(c) === 'assertChainEligible')
  const wrapper = calls(chain).find((c) => calleeName(c) === 'establishChainOrRefund')
  assert.ok(grade && wrapper && grade.pos < wrapper.pos, 'the entry is graded before establishChainOrRefund buys it')
  const body = ipc.fns.get('establishChainOrRefund')!
  const exitGrade = calls(body).find((c) => calleeName(c) === 'assertChainEligible')
  const buys = calls(body).filter((c) => calleeName(c) === 'startSession')
  assert.equal(buys.length, 2, 'establishChainOrRefund buys exactly two hops')
  assert.ok(exitGrade && buys[0].pos < exitGrade.pos && exitGrade.pos < buys[1].pos, 'the exit is graded, through the entry, before it is bought')
})

test('[MH-8] lastKnownSessions is written only by primeSessionsCache, or cleared', () => {
  const writes = nodes(ipc.sf).filter((n): n is ts.BinaryExpression => ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === 'lastKnownSessions')
  const stray = writes.filter((w) => enclosingFn(ipc, w) !== 'primeSessionsCache' &&
    !(ts.isArrayLiteralExpression(w.right) && w.right.elements.length === 0))
  assert.deepEqual(stray.map(where), [])
})
