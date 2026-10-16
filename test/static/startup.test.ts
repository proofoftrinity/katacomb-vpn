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

test('[REL-39] the tray image is set only through paintTray, so every repaint is sent again', () => {
  const decl = nodes(index).find((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) &&
    n.name.getText() === 'paintTray')
  const init = decl?.initializer
  assert.ok(init && ts.isCallExpression(init) && calleeName(init) === 'trayPainter' && init.arguments[0],
    'const paintTray = trayPainter(...) not found')
  const callback = init.arguments[0]
  const setImages = calls(index).filter((c) => calleeName(c) === 'setImage')
  assert.ok(setImages.length > 0, 'no tray.setImage call found')
  for (const c of setImages) {
    assert.ok(c.pos >= callback.pos && c.end <= callback.end,
      `${where(c)} sets the tray image outside paintTray, so that repaint is sent only once`)
  }
  const refresh = nodes(index).find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) &&
    n.name?.text === 'refreshTray')
  assert.ok(refresh, 'refreshTray() not found')
  assert.ok(calls(refresh).some((c) => calleeName(c) === 'paintTray'), 'refreshTray must repaint through paintTray')
})

const fn = (name: string) => {
  const f = nodes(index).find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name)
  assert.ok(f?.body, `function ${name}() not found in src/main/index.ts`)
  return f
}
const isFn = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression =>
  !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))

test('[REL-40] a login start creates no window: it waits on waitForTrayHost and opens one only on a no', () => {
  const flag = nodes(index).find((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText() === 'startedAtLogin')
  // The flag the autostart entry's Exec passes (autostart.ts).
  assert.equal(flag?.initializer?.getText(), "process.argv.includes('--autostart')", 'startedAtLogin must come from --autostart')
  // One place decides what a login start does, so nothing else can create its window early.
  const uses = nodes(index).filter((n) => ts.isIdentifier(n) && n.text === 'startedAtLogin' && n.parent !== flag)
  assert.equal(uses.length, 1, 'startedAtLogin must be read in exactly one place, the startup branch')
  const branch = uses[0].parent
  assert.ok(ts.isIfStatement(branch) && branch.expression === uses[0], 'startedAtLogin must be read as `if (startedAtLogin)`')
  // The page reads the wallet, which on an auto-login account blocks main behind the keyring prompt.
  assert.deepEqual(calls(branch.thenStatement).filter((c) => calleeName(c) === 'createWindow').map(where), [],
    'a login start must not create the window: showWindow() creates it when one is asked for')
  assert.ok(branch.elseStatement && calls(branch.elseStatement).some((c) => calleeName(c) === 'createWindow'),
    'an ordinary launch must still create the window at once')
  // On a no, the window opens: with no tray it is the only way into the app.
  const wait = calls(branch.thenStatement).find((c) => calleeName(c) === 'then' && ts.isPropertyAccessExpression(c.expression) &&
    ts.isCallExpression(c.expression.expression) && calleeName(c.expression.expression) === 'waitForTrayHost' &&
    c.expression.expression.arguments[0]?.getText() === 'probeTrayHost')
  assert.ok(wait, 'a login start must wait on waitForTrayHost(probeTrayHost), which asks again while the panel starts')
  const callback = wait.arguments[0]
  const opens = isFn(callback) && callback.parameters[0]
    ? nodes(callback).some((n) => ts.isIfStatement(n) && ts.isPrefixUnaryExpression(n.expression) &&
      n.expression.operator === ts.SyntaxKind.ExclamationToken && n.expression.operand.getText() === callback.parameters[0].name.getText() &&
      calls(n.thenStatement).some((c) => calleeName(c) === 'showWindow'))
    : false
  assert.ok(opens, 'when waitForTrayHost answers no, the login start must call showWindow()')
  // showWindow creates the window when there is none.
  const show = fn('showWindow')
  assert.ok(calls(show).some((c) => calleeName(c) === 'createWindow'), 'showWindow() must create the window when there is none')
  const ready = calls(index).find((c) => calleeName(c) === 'on' && c.arguments[0]?.getText() === "'ready-to-show'")
  assert.ok(ready && ready.arguments[1], "mainWindow.on('ready-to-show', ...) not found")
  assert.ok(calls(ready.arguments[1]).some((c) => c.expression.getText() === 'mainWindow?.show'), 'a created window must show at once')
})

test('[REL-40] a message for the page waits until the window is up, so a page created for it is listening', () => {
  // showWindow passes its callback to a window it creates, and runs it at once on one that exists.
  const show = fn('showWindow')
  const then = show.parameters[0]?.name.getText()
  assert.ok(then, 'showWindow() must take the callback to run once the window is up')
  const creates = calls(show).filter((c) => calleeName(c) === 'createWindow')
  assert.ok(creates.length > 0 && creates.every((c) => c.arguments[0]?.getText() === then),
    `showWindow() must hand ${then} to the window it creates`)
  assert.ok(calls(show).some((c) => calleeName(c) === then && !creates.includes(c)), `showWindow() must run ${then} on a window that exists`)
  // A created window runs it after its first paint, once shown.
  const create = fn('createWindow')
  const onShown = create.parameters[0]?.name.getText()
  assert.ok(onShown, 'createWindow() must take the callback showWindow hands it')
  const ready = calls(create).find((c) => calleeName(c) === 'on' && c.arguments[0]?.getText() === "'ready-to-show'")
  assert.ok(ready && isFn(ready.arguments[1]), "createWindow() must handle 'ready-to-show'")
  const shown = calls(ready.arguments[1]).find((c) => c.expression.getText() === 'mainWindow?.show')
  const ran = calls(ready.arguments[1]).find((c) => calleeName(c) === onShown)
  assert.ok(shown && ran && shown.pos < ran.pos, `'ready-to-show' must show the window, then run ${onShown}`)
  // The tray's messages to the page go inside that callback.
  for (const name of ['showAbout', 'triggerTrayConnect']) {
    const sends = calls(fn(name)).filter((c) => calleeName(c) === 'send' && c.expression.getText().endsWith('webContents.send'))
    assert.ok(sends.length > 0, `${name}() no longer sends to the page`)
    for (const s of sends) {
      const inCallback = calls(fn(name)).some((c) => calleeName(c) === 'showWindow' && isFn(c.arguments[0]) &&
        c.arguments[0].pos <= s.pos && s.end <= c.arguments[0].end)
      assert.ok(inCallback, `${where(s)}: ${name}() must send inside showWindow's callback; sent at once it reaches a page not yet listening`)
    }
  }
})

test('[REL-40] a login start makes its tray icon once a tray host has answered, and an ordinary launch at once', () => {
  const branch = nodes(index).find((n): n is ts.IfStatement => ts.isIfStatement(n) && n.expression.getText() === 'startedAtLogin')
  assert.ok(branch && branch.elseStatement, 'the `if (startedAtLogin) … else …` startup branch not found')
  // Made before the panel's tray is up (Xfce starts the app first), the icon is an old XEmbed one.
  const wait = calls(branch.thenStatement).find((c) => calleeName(c) === 'then' && ts.isPropertyAccessExpression(c.expression) &&
    ts.isCallExpression(c.expression.expression) && calleeName(c.expression.expression) === 'waitForTrayHost')
  const callback = wait?.arguments[0]
  assert.ok(isFn(callback), 'waitForTrayHost(...).then(callback) not found in the login branch')
  const made = calls(branch.thenStatement).filter((c) => calleeName(c) === 'createTrayIcon')
  assert.ok(made.length > 0, 'a login start must still make its tray icon')
  for (const c of made) {
    assert.ok(c.pos >= callback.pos && c.end <= callback.end, `${where(c)}: a login start makes its tray icon only once waitForTrayHost has answered`)
  }
  assert.ok(calls(branch.elseStatement).some((c) => calleeName(c) === 'createTrayIcon'), 'an ordinary launch must make its tray icon')
  assert.deepEqual(whenReadySteps().filter((c) => calleeName(c) === 'createTrayIcon' && !(c.pos >= branch.pos && c.end <= branch.end)).map(where), [],
    'the tray icon is made only in the startup branch')
})

test('[REL-41] the keyring is chosen before ready, from the stored seeds, unless the user passed one', () => {
  const appends = calls(index).filter((c) => c.expression.getText() === 'app.commandLine.appendSwitch' &&
    c.arguments[0]?.getText() === "'password-store'")
  assert.equal(appends.length, 1, "exactly one app.commandLine.appendSwitch('password-store', …)")
  const append = appends[0]
  // Chromium reads the switch as `ready` comes: inside any function it would run too late, or never.
  for (let n: ts.Node | undefined = append.parent; n; n = n.parent) {
    assert.ok(!ts.isFunctionLike(n), `${where(append)} must run at the top level, before ready`)
  }
  const value = append.arguments[1]
  const decl = value && ts.isIdentifier(value)
    ? nodes(index).find((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText() === value.text)
    : undefined
  assert.equal(decl?.initializer?.getText(), 'keyringSwitch(process.env)', 'the value comes from keyringSwitch(process.env)')
  const guard = nodes(index).find((n): n is ts.IfStatement => ts.isIfStatement(n) && n.pos <= append.pos && append.end <= n.end &&
    n.expression.getText() === "!app.commandLine.hasSwitch('password-store')")
  assert.ok(guard, "a --password-store the user passed wins: guard with `if (!app.commandLine.hasSwitch('password-store'))`")
})

test('[REL-42] the tray icon is drawn for the panel\'s shade as read from the desktop, read before the first image', () => {
  // The apps' theme was the whole answer, and on GNOME and Xfce it put a dark K on a dark panel.
  assert.ok(!fn('trayPanel').getText().includes('shouldUseDarkColors'), 'trayPanel() must return the panel\'s shade, not the apps\' theme')
  const read = fn('readPanelShade')
  assert.ok(calls(read).some((c) => calleeName(c) === 'panelShade'), 'readPanelShade() must ask panelShade (tray-view.ts)')
  const create = fn('createTrayIcon')
  const awaited = nodes(create).find((n): n is ts.AwaitExpression => ts.isAwaitExpression(n) &&
    ts.isCallExpression(n.expression) && calleeName(n.expression) === 'readPanelShade')
  const made = nodes(create).find((n): n is ts.NewExpression => ts.isNewExpression(n) && n.expression.getText() === 'Tray')
  assert.ok(awaited && made && awaited.pos < made.pos, 'createTrayIcon() must await readPanelShade() before new Tray(...)')
  // Re-read when the shade can change: the apps' theme, or the panel's own on Cinnamon and Xfce.
  assert.ok(calls(create).some((c) => calleeName(c) === 'on' && c.arguments[0]?.getText() === "'updated'"), "nativeTheme 'updated' must re-read the shade")
  assert.ok(calls(create).some((c) => calleeName(c) === 'panelWatchCommand'), 'a panel restyled on its own must be watched')
  const quit = calls(index).find((c) => calleeName(c) === 'on' && c.arguments[0]?.getText() === "'before-quit'")
  assert.ok(quit && calls(quit).some((c) => c.expression.getText() === 'panelWatch?.kill'), 'the quit must stop the panel watcher')
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
