import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { calleeName, calls, nodes, parse, sources, where } from '../harness/source.ts'

// What src/main/index.ts must do at startup, in order. These are structural: the
// behaviour of each step is pinned by its own module's tests.

const index = parse('src/main/index.ts')

test('[REL-14] the second instance exits with app.exit, never app.quit', () => {
  const guard = nodes(index).find((n): n is ts.IfStatement => ts.isIfStatement(n) &&
    calls(n.expression).some((c) => calleeName(c) === 'requestSingleInstanceLock'))
  assert.ok(guard, 'requestSingleInstanceLock() guard not found')
  assert.ok(ts.isPrefixUnaryExpression(guard.expression) && guard.expression.operator === ts.SyntaxKind.ExclamationToken,
    'the guard reads `if (!app.requestSingleInstanceLock())`')
  const loser = calls(guard.thenStatement).map((c) => c.expression.getText())
  // app.quit() fires before-quit, which tears down the tunnel the FIRST instance owns.
  assert.deepEqual(loser, ['app.exit'])
})

/** Statement-level calls inside app.whenReady().then(...), in source order. */
function whenReadySteps(): ts.CallExpression[] {
  const ready = calls(index).find((c) => calleeName(c) === 'then' &&
    ts.isPropertyAccessExpression(c.expression) && calls(c.expression.expression).some((x) => calleeName(x) === 'whenReady'))
  assert.ok(ready && ready.arguments[0], 'app.whenReady().then(...) not found')
  return calls(ready.arguments[0])
}

const firstAt = (steps: ts.CallExpression[], name: string) => {
  const c = steps.find((s) => calleeName(s) === name)
  assert.ok(c, `${name}() is no longer called at startup`)
  return c.pos
}

test('[REL-31] startup heals in order: migrate, adopt, close the orphan, then clear a stranded kill switch', () => {
  const steps = whenReadySteps()
  const order = [
    'migrateLegacyUserData', // before anything touches userData
    'dedupeWalletEntries',
    'migrateProviderModeToWallet', // after the dedupe, which can rewrite activeWalletId
    'migrateRpcMode', // before any saveSettings bakes the 'auto' default in
    'detectExistingConnection', // sets activeProtocol, so disconnect() picks the right verb
    'healOrphanedTunnel',
    'healStrandedKillSwitch', // skips while a tunnel is up: must see what the orphan heal left
    'registerIpcHandlers', // no handler can race the heal... (see REL-2's startup exemption)
    'createWindow',
  ]
  const positions = order.map((name) => [name, firstAt(steps, name)] as const)
  const outOfOrder = positions.filter(([, pos], i) => i > 0 && pos < positions[i - 1][1]).map(([n]) => n)
  assert.deepEqual(outOfOrder, [], `startup order must be ${order.join(' -> ')}`)
  // The kill-switch heal is chained on the orphan heal, not run beside it.
  const heal = steps.find((s) => calleeName(s) === 'healStrandedKillSwitch')!
  const chained = calls(index).some((c) => calleeName(c) === 'then' &&
    calls(c.expression).some((x) => calleeName(x) === 'healOrphanedTunnel') &&
    c.arguments.some((a) => a.pos <= heal.pos && heal.end <= a.end))
  assert.ok(chained,
    'healStrandedKillSwitch must run in a .then() chained on healOrphanedTunnel')
})

test('[REL-36] the app registers with the desktop session at startup, and a session end runs the normal quit', () => {
  const register = whenReadySteps().find((s) => calleeName(s) === 'registerWithDesktopSession')
  assert.ok(register, 'registerWithDesktopSession() is no longer called at startup')
  const opts = register.arguments[0]
  const onEnd = opts && ts.isObjectLiteralExpression(opts)
    ? opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'onEndSession')
    : undefined
  // Not app.exit: the teardown runs in before-quit, and GNOME waits for the app to exit.
  assert.ok(onEnd && calls(onEnd.initializer).some((c) => c.expression.getText() === 'app.quit'),
    'onEndSession must start the normal quit, app.quit(), so before-quit runs the teardown')
})

test('[REL-36] with no D-Bus session manager the app registers over XSMP (KDE), and Die runs the normal quit', () => {
  const dbus = whenReadySteps().find((s) => calleeName(s) === 'registerWithDesktopSession')
  assert.ok(dbus, 'registerWithDesktopSession() is no longer called at startup')
  // Chained on the D-Bus registration's result: GNOME and Xfce answer XSMP too, and a client
  // registered twice would be waited for twice.
  const then = calls(index).find((c) => calleeName(c) === 'then' && calls(c.expression).includes(dbus))
  const xsmp = then && calls(then.arguments[0]).find((c) => calleeName(c) === 'registerWithXsmp')
  assert.ok(xsmp, 'registerWithXsmp() must run in a .then() on registerWithDesktopSession()')
  const opts = xsmp.arguments[0]
  const onEnd = opts && ts.isObjectLiteralExpression(opts)
    ? opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'onEndSession')
    : undefined
  assert.ok(onEnd && calls(onEnd.initializer).some((c) => c.expression.getText() === 'app.quit'),
    'onEndSession must start the normal quit, app.quit(), so before-quit runs the teardown')
})

test('[REL-36] a system shutdown waits for the normal quit: the shutdown listener holds the delay and quits', () => {
  const ready = whenReadySteps()
  const listener = ready.find((s) => calleeName(s) === 'on' && s.arguments[0]?.getText() === "'shutdown'")
  assert.ok(listener && listener.arguments[1], "powerMonitor's 'shutdown' listener is no longer registered at startup")
  // Electron 41 creates its power monitor for the first listener and only then starts
  // watching for 'shutdown' ones: a 'shutdown' listener that comes first takes no lock
  // (seen in the release VM: no inhibitor, and two reboots crashed).
  const first = ready.find((s) => s.expression.getText() === 'powerMonitor.on')
  assert.ok(first && first.pos < listener.pos, "the 'shutdown' listener must not be powerMonitor's first listener")
  const steps = calls(listener.arguments[1]).map((c) => c.expression.getText())
  // Without preventDefault() Electron releases its logind delay lock at once, logind goes on,
  // and X is gone ~70 ms later, which Electron answers by crashing ("Failed to shutdown.").
  assert.ok(steps.some((s) => s.endsWith('.preventDefault')), 'the shutdown listener must call preventDefault()')
  assert.ok(steps.includes('app.quit'), 'the shutdown listener must start the normal quit, app.quit()')
})

test("[REL-37] the quit turns off Chromium's GPU crash limit before the teardown starts", () => {
  const quit = calls(index).find((c) => calleeName(c) === 'on' && c.arguments[0]?.getText() === "'before-quit'")
  assert.ok(quit && quit.arguments[1], "app.on('before-quit', ...) not found")
  const steps = calls(quit.arguments[1])
  const limitOff = steps.find((c) => c.expression.getText() === 'app.commandLine.appendSwitch' &&
    c.arguments[0]?.getText() === "'disable-gpu-process-crash-limit'")
  // Without it, a SIGTERM to every app process at once (pkill, a kill of every PID) kills
  // the zygote with the GPU process, and Chromium crashes itself mid-teardown after six
  // failed relaunches: 6 of 12 in the release VM, 0 of 12 with it.
  assert.ok(limitOff, "before-quit must append 'disable-gpu-process-crash-limit'")
  const teardown = steps.find((c) => calleeName(c) === 'cleanupOnQuit')
  assert.ok(teardown, 'cleanupOnQuit() is no longer called from before-quit')
  assert.ok(limitOff.pos < teardown.pos, 'the crash limit must be off before the teardown starts')
})

test('[ARCH-1] every window keeps the renderer isolated, sandboxed and Node-free', () => {
  const windows = sources('src/main').flatMap((f) => nodes(parse(f)).filter((n): n is ts.NewExpression =>
    ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'BrowserWindow'))
  assert.ok(windows.length > 0)
  const problems: string[] = []
  for (const w of windows) {
    const opts = w.arguments?.[0]
    const prefs = opts && ts.isObjectLiteralExpression(opts)
      ? opts.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'webPreferences')
      : undefined
    if (!prefs || !ts.isObjectLiteralExpression(prefs.initializer)) { problems.push(`${where(w)}: no literal webPreferences`); continue }
    const value = (key: string) => (prefs.initializer as ts.ObjectLiteralExpression).properties
      .find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === key)?.initializer.getText()
    const want: Record<string, string> = { contextIsolation: 'true', nodeIntegration: 'false', sandbox: 'true' }
    for (const [k, v] of Object.entries(want)) if (value(k) !== v) problems.push(`${where(w)}: ${k} must be ${v}`)
    const never: Record<string, string> = { webSecurity: 'false', allowRunningInsecureContent: 'true', nodeIntegrationInWorker: 'true', nodeIntegrationInSubFrames: 'true', webviewTag: 'true' }
    for (const [k, v] of Object.entries(never)) if (value(k) === v) problems.push(`${where(w)}: ${k}: ${v}`)
  }
  assert.deepEqual(problems, [])
})

test('[ARCH-1] the window never opens a new window and never navigates away from the app', () => {
  const handler = calls(index).find((c) => calleeName(c) === 'setWindowOpenHandler')
  assert.ok(handler, 'setWindowOpenHandler is gone')
  assert.match(handler.getText(), /action:\s*'deny'/, 'the open handler must deny')
  const nav = calls(index).find((c) => calleeName(c) === 'on' && c.arguments[0]?.getText() === "'will-navigate'")
  assert.ok(nav && /preventDefault\(\)/.test(nav.getText()), 'will-navigate must prevent navigation away from the app')
})
