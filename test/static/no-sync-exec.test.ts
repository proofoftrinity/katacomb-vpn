import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { calleeName, calls, nodes, parse, sources, where } from '../harness/source.ts'

// [PH-8] A synchronous exec on the privileged path is a polkit dialog that freezes the
// whole main process until the user answers it (2026-08-16: Disconnect froze the app,
// then the kill switch could not be turned off, leaving no internet). Unprivileged
// probes may stay synchronous; each one is listed here by the function it lives in,
// so a new sync call is a deliberate decision, not an accident.

const SYNC = new Set(['execSync', 'execFileSync', 'spawnSync'])

// function -> how many sync calls it makes, and why that is safe (none touches root).
const ALLOWED: Record<string, { calls: number; why: string }> = {
  'vpn-manager.ts:isWireGuardUp': { calls: 1, why: '`ip link show sntl0`, read-only' },
  'vpn-manager.ts:isAnyWireGuardUp': { calls: 1, why: '`ip -o link show type wireguard`, read-only' },
  'vpn-manager.ts:sntl0IsKernelWireGuard': { calls: 1, why: '`ip -o link show type wireguard`, read-only' },
  'vpn-manager.ts:isTunUp': { calls: 1, why: '`ip link show sntl-tun`, read-only' },
  'vpn-manager.ts:resolveHostToIPv4': { calls: 1, why: '`getent ahostsv4`, bounded by a 5 s timeout' },
  'vpn-manager.ts:getDefaultRoute': { calls: 1, why: '`ip route show default`, read-only' },
  'vpn-manager.ts:probeV2RayVersion': { calls: 1, why: "the bundled core's version flag, run as the user" },
  'vpn-manager.ts:isOpenVpnUp': { calls: 1, why: '`ip link show sntl-ovpn`, read-only' },
  'vpn-manager.ts:detectOtherVpn': { calls: 2, why: '`ip -o link show type wireguard|tun`, read-only' },
}

function enclosingFunctionName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer &&
      (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.text
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  }
  return '<module>'
}

const mainSfs = sources('src/main').map(parse)

test('[PH-8] runPrivileged stays async', () => {
  const sf = parse('src/main/helper/privileged.ts')
  const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'runPrivileged')
  assert.ok(fn, 'runPrivileged not found')
  assert.ok(fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword), 'runPrivileged must be async')
})

test('[PH-8] no synchronous exec ever carries pkexec, sudo or the helper', () => {
  const bad = mainSfs.flatMap((sf) => calls(sf).filter((c) => SYNC.has(calleeName(c) ?? '')))
    .filter((c) => /pkexec|sudo|katacomb-vpn-helper|HELPER/i.test(c.arguments.map((a) => a.getText()).join(' ')))
  assert.deepEqual(bad.map(where), [])
})

test('[PH-8] the only synchronous execs are the listed unprivileged probes', () => {
  const found: Record<string, number> = {}
  for (const sf of mainSfs) {
    for (const c of calls(sf).filter((c) => SYNC.has(calleeName(c) ?? ''))) {
      const key = `${sf.fileName.split('/').pop()}:${enclosingFunctionName(c)}`
      found[key] = (found[key] ?? 0) + 1
    }
  }
  const expected = Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.calls]))
  assert.deepEqual(found, expected,
    'a new sync exec needs an entry in ALLOWED saying why it cannot block on a password prompt; prefer the async form')
})

test('[PH-8] the privileged call tree imports no synchronous exec', () => {
  const tree = mainSfs.filter((sf) => sf.fileName !== 'src/main/vpn/vpn-manager.ts')
  const bad: string[] = []
  for (const sf of tree) {
    for (const id of nodes(sf).filter(ts.isImportSpecifier)) {
      if (SYNC.has((id.propertyName ?? id.name).text)) bad.push(`${where(id)} imports ${id.name.text}`)
    }
  }
  assert.deepEqual(bad, [])
})
