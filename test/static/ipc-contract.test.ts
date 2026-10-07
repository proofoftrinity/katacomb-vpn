import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { IPC } from '../../src/shared/ipc-channels.ts'
import { calleeName, calls, ipcKey, nodes, parse, read, sources, where } from '../harness/source.ts'

// The IPC surface is four lists that must agree: the channel constants, main's
// handlers and senders, the preload object, and the ElectronAPI type the renderer
// codes against. Nothing type-links them (preload and renderer are separate tsconfig
// projects), so drift was silent: two methods had sat in all three with no caller.

const mainSfs = sources('src/main').map(parse)

const handled = new Map<string, string[]>() // channel key -> where handle() registers it
const sent = new Map<string, string[]>() // channel key -> where main sends it
for (const sf of mainSfs) {
  for (const c of calls(sf)) {
    const key = ipcKey(c.arguments[0])
    if (!key) continue
    if (ts.isIdentifier(c.expression) && c.expression.text === 'handle') handled.set(key, [...(handled.get(key) ?? []), where(c)])
    if (calleeName(c) === 'send') sent.set(key, [...(sent.get(key) ?? []), where(c)])
  }
}

interface Method { name: string; at: string; uses: Map<string, string[]> } // ipcRenderer method -> channel keys
const preload = parse('src/preload/index.ts')
const expose = calls(preload).find((c) => calleeName(c) === 'exposeInMainWorld')
assert.ok(expose && ts.isObjectLiteralExpression(expose.arguments[1]), 'preload must expose one object literal')
const methods: Method[] = (expose.arguments[1] as ts.ObjectLiteralExpression).properties.map((p) => {
  const uses = new Map<string, string[]>()
  for (const c of calls(p)) {
    const e = c.expression
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'ipcRenderer') {
      uses.set(e.name.text, [...(uses.get(e.name.text) ?? []), ipcKey(c.arguments[0]) ?? '<not an IPC constant>'])
    }
  }
  return { name: p.name && ts.isIdentifier(p.name) ? p.name.text : '<computed>', at: where(p), uses }
})
const preloadInvokes = methods.flatMap((m) => m.uses.get('invoke') ?? [])
const preloadListens = methods.flatMap((m) => m.uses.get('on') ?? [])

const types = parse('src/renderer/types/index.ts')
const apiType = nodes(types).find((n): n is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(n) && n.name.text === 'ElectronAPI')
assert.ok(apiType, 'ElectronAPI interface not found')
const typeMembers = apiType.members.map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : '<computed>'))

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()
const minus = (a: Iterable<string>, b: Iterable<string>) => { const bs = new Set(b); return sorted([...a].filter((x) => !bs.has(x))) }

test('[ARCH-2] main has exactly one ipcMain.handle, behind the sender check in ipc-handlers.ts', () => {
  const uses = mainSfs.flatMap((sf) => nodes(sf).filter((n): n is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'ipcMain'))
  assert.deepEqual(uses.map((u) => `${u.name.text} @ ${where(u)}`).filter((s) => !s.startsWith('handle @ src/main/ipc-handlers.ts')), [],
    'only ipc-handlers.ts\'s handle() may touch ipcMain; no on/once/handleOnce/removeHandler anywhere')
  assert.equal(uses.length, 1, `expected one ipcMain.handle, found ${uses.length}`)
})

test('[ARCH-2] the handler groups import no ipcMain and register only through the handle they are given', () => {
  const problems: string[] = []
  for (const sf of mainSfs) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== 'electron') continue
      const b = st.importClause?.namedBindings
      if (st.importClause?.isTypeOnly || !b || !ts.isNamedImports(b)) continue
      if (b.elements.some((el) => !el.isTypeOnly && el.name.text === 'ipcMain') && sf.fileName !== 'src/main/ipc-handlers.ts') {
        problems.push(`${sf.fileName} imports ipcMain`)
      }
    }
    if (!sf.fileName.startsWith('src/main/ipc/')) continue
    for (const fn of nodes(sf).filter(ts.isFunctionDeclaration)) {
      if (!fn.name?.text.startsWith('register')) continue
      const first = fn.parameters[0]
      if (!first || !ts.isIdentifier(first.name) || first.name.text !== 'handle') problems.push(`${where(fn)}: ${fn.name.text} must take handle first`)
    }
  }
  const wiring = parse('src/main/ipc-handlers.ts')
  for (const c of calls(wiring)) {
    const name = calleeName(c)
    if (name && /^register\w+Handlers$/.test(name) && !(c.arguments[0] && ts.isIdentifier(c.arguments[0]) && c.arguments[0].text === 'handle')) {
      problems.push(`${where(c)}: ${name} must be given the trusted handle`)
    }
  }
  assert.deepEqual(problems, [])
})

test('[ARCH-4] every request channel has exactly one handler in main and one preload method', () => {
  const dupes = [...handled].filter(([, at]) => at.length > 1).map(([k, at]) => `${k}: ${at.join(', ')}`)
  assert.deepEqual(dupes, [], 'a channel registered twice throws at startup in Electron')
  assert.deepEqual(minus(handled.keys(), preloadInvokes), [], 'handled in main but no preload method invokes it')
  assert.deepEqual(minus(preloadInvokes, handled.keys()), [], 'invoked by the preload but nothing in main handles it')
  assert.equal(preloadInvokes.length, new Set(preloadInvokes).size, 'two preload methods invoke one channel')
})

test('[ARCH-4] every event main sends has one preload listener, and that listener can be removed', () => {
  assert.deepEqual(minus(sent.keys(), preloadListens), [], 'sent by main but no preload listener')
  assert.deepEqual(minus(preloadListens, sent.keys()), [], 'listened for by the preload but main never sends it')
  assert.equal(preloadListens.length, new Set(preloadListens).size, 'two preload listeners for one event')
  const leaky = methods.filter((m) => m.uses.has('on') && sorted(m.uses.get('on')!).join() !== sorted(m.uses.get('removeListener') ?? []).join())
  assert.deepEqual(leaky.map((m) => m.at), [], 'an on() listener must return a function that removes the same channel')
})

test('[ARCH-4] every IPC constant is a request or an event, never both or neither', () => {
  assert.deepEqual(sorted([...handled.keys()].filter((k) => sent.has(k))), [], 'a channel is either invoked or sent, not both')
  assert.deepEqual(minus(Object.keys(IPC), [...handled.keys(), ...sent.keys()]), [], 'unused channel constant')
  assert.deepEqual(minus([...handled.keys(), ...sent.keys()], Object.keys(IPC)), [])
})

test('[ARCH-4] each preload method touches one channel, through invoke or on/removeListener only', () => {
  const problems: string[] = []
  for (const m of methods) {
    const other = [...m.uses.keys()].filter((k) => !['invoke', 'on', 'removeListener'].includes(k))
    if (other.length) problems.push(`${m.at} ${m.name}: uses ipcRenderer.${other.join(', ')}`)
    const channels = new Set([...m.uses.values()].flat())
    if (channels.size !== 1) problems.push(`${m.at} ${m.name}: touches ${channels.size} channels`)
  }
  assert.deepEqual(problems, [])
})

test('[ARCH-4] the preload object and the ElectronAPI type list the same methods', () => {
  const exposed = methods.map((m) => m.name)
  assert.deepEqual(minus(exposed, typeMembers), [], 'exposed by the preload but missing from ElectronAPI')
  assert.deepEqual(minus(typeMembers, exposed), [], 'declared on ElectronAPI but the preload does not expose it')
})

test('[ARCH-4] every preload method has a caller in the renderer', () => {
  const renderer = sources('src/renderer').filter((p) => p !== 'src/renderer/types/index.ts').map(read).join('\n')
  const uncalled = methods.map((m) => m.name).filter((name) => !new RegExp(`\\bwindow\\.api\\s*\\.${name}\\b`).test(renderer))
  assert.deepEqual(uncalled, [], 'remove a method nothing calls (channel, handler, preload and type together)')
})
