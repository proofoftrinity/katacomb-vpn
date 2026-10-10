import { test } from 'node:test'
import assert from 'node:assert/strict'
import { builtinModules } from 'node:module'
import ts from 'typescript'
import { nodes, parse, read, runtimeImports, sources, walk, where } from '../harness/source.ts'

// The renderer rules in docs/renderer.md that can be read off the source. Each one
// was a shipped defect first; the doc entry says which.

const rendererFiles = sources('src/renderer')
const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })

const GPU_OR_CHART = /^(three|three-.*|@react-three\/.*|react-globe\.gl|globe\.gl|chart\.js|react-chartjs-2|recharts|victory.*|@nivo\/.*|echarts|echarts-for-react|apexcharts|react-apexcharts|plotly\.js.*|react-plotly\.js|highcharts.*|@visx\/.*|pixi\.js|regl)$/

test('[RN-4] [RN-6] no WebGL, globe or chart library is installed or imported', () => {
  assert.deepEqual(deps.filter((d) => GPU_OR_CHART.test(d)), [], 'see docs/renderer.md: plain SVG and CSS only')
  const imports = rendererFiles.flatMap((f) => runtimeImports(parse(f)).filter((s) => GPU_OR_CHART.test(s)).map((s) => `${f}: ${s}`))
  assert.deepEqual(imports, [])
})

test('[RN-4] nothing in the renderer asks for a WebGL context', () => {
  const hits = rendererFiles.filter((f) => /getContext\(\s*['"`](webgl2?|experimental-webgl)/.test(read(f)))
  assert.deepEqual(hits, [])
})

test('[RN-5] a utils/ helper imports no other module at runtime, only types', () => {
  const utils = sources('src/renderer/utils')
  const bad = utils.flatMap((f) => runtimeImports(parse(f)).filter((s) => s.startsWith('.')).map((s) => `${f}: ${s}`))
  assert.deepEqual(bad, [], 'the native test runner cannot resolve it; pass the dependency in as a parameter')
})

test('[RN-7] no /NN opacity modifier on a theme colour (it generates no CSS)', () => {
  const re = /-(accent|success|danger|warning|info|bg-[a-z]+|text-[a-z]+|border)\/[0-9]/
  const files = walk('src/renderer', (p) => /\.(tsx?|css)$/.test(p) && !p.endsWith('.test.ts'))
  const hits = files.flatMap((f) => read(f).split('\n').flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])))
  assert.deepEqual(hits, [], 'use a -subtle token, opacity-NN, or a color-mix class')
})

test('[RN-8] dark-only: no dark: variant and no .dark selector', () => {
  const files = walk('src/renderer', (p) => /\.(tsx?|css)$/.test(p) && !p.endsWith('.test.ts'))
  const hits: string[] = []
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*.*?\*\/|\/\/.*$/g, '') // comments may name the rule
      if (/(^|[\s'"`{])dark:/.test(code) || /(^|[\s,}])\.dark\b/.test(code)) hits.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(hits, [])
  // 'class' with no .dark anywhere keeps a stray dark: utility inert; Tailwind's
  // default ('media') would let it follow the OS theme.
  assert.match(read('tailwind.config.js'), /darkMode:\s*'class'/)
})

test('[ARCH-1] the renderer imports nothing from main, electron or Node', () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
  const bad = rendererFiles.flatMap((f) => runtimeImports(parse(f))
    .filter((s) => s === 'electron' || builtins.has(s) || /(^|\/)main\//.test(s) || s.includes('/preload'))
    .map((s) => `${f}: ${s}`))
  assert.deepEqual(bad, [], 'the renderer is sandboxed; reach main through window.api')
})

test('[REL-24] [RN-2] the Sessions tab uses the tested decisions: Connect gates on the quota, gauges are floored', () => {
  const sf = parse('src/renderer/components/ActiveSessions.tsx')
  const all = nodes(sf)
  const reconnect = all.filter((n): n is ts.JsxSelfClosingElement | ts.JsxOpeningElement =>
    (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
    n.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'onClick' && a.getText().includes('handleReconnect')))
  assert.equal(reconnect.length, 1, 'one Connect button on a session card')
  const disabled = reconnect[0].attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === 'disabled')
  assert.ok(disabled && /\bquotaUsedUp\b/.test(disabled.getText()), 'Connect must stay disabled once the paid quota is used')
  const called = new Set(all.filter(ts.isCallExpression).map((c) => c.expression.getText()))
  assert.ok(called.has('isQuotaUsedUp'), 'quotaUsedUp comes from utils/session-card')
  assert.ok(called.has('flooredUsage'), 'the gauges are floored by utils/session-card')
})

test('[REL-23] the tab badge and the Sessions header count active rows only, never the ones settling', () => {
  const COUNTS: Array<[string, string]> = [['src/renderer/App.tsx', 'sessionCount'], ['src/renderer/components/ActiveSessions.tsx', 'activeCount']]
  for (const [file, name] of COUNTS) {
    const decl = nodes(parse(file)).filter(ts.isVariableDeclaration).find((d) => d.name.getText() === name)
    assert.ok(decl?.initializer, `${name} moved in ${file}: re-aim this test`)
    assert.match(decl.initializer.getText(), /\.filter\(\(s\) => s\.status === 'active'\)\.length$/, `${file}: ${name}`)
  }
})

/** The text a renderer file can put on screen: string and template literals and JSX text, minus imports and classNames. */
function shownText(file: string): string[] {
  const sf = parse(file)
  return nodes(sf).filter((n): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode | ts.JsxText =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n))
    .filter((n) => !ts.isImportDeclaration(n.parent) && !(ts.isJsxAttribute(n.parent) && n.parent.name.getText() === 'className'))
    .map((n) => n.text.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0)
}

test('[SL-1] the Sessions tab never words End as a refund: End is phase 1, and the remainder is forfeited', () => {
  const shown = shownText('src/renderer/components/ActiveSessions.tsx')
  assert.deepEqual(shown.filter((t) => /refund|money back|get .* back|returned to you|reimburs/i.test(t)), [])
  assert.ok(shown.some((t) => /forfeit/i.test(t)), 'the End confirmation says what is given up')
})

// [NT-3] The channel that delivers a node's keys authenticates nothing, so no copy may
// claim the wrapping defends against the network the user is on. What this can read
// off the source: no such claim in any shown string, and the limit itself stated on
// every connect review where the node does not sign its replies.
const DEFEATS_THE_NETWORK = /(protect|secure|shield|safe)\w*\s+(you\s+)?(from|against)\s+(your\s+)?(ISP|local network|the network|wi-?fi|on-path|man-in-the-middle|MITM|intercept)|can(no|')t be (intercepted|tampered)|immune to|MITM[- ]proof|tamper[- ]proof|impossible to intercept/i

test('[NT-3] no renderer copy claims the TLS/Reality wrapping defeats the local network', () => {
  const claims = rendererFiles.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
    .flatMap((f) => shownText(f).filter((t) => DEFEATS_THE_NETWORK.test(t)).map((t) => `${f}: ${t}`))
  assert.deepEqual(claims, [])
})

test('[NT-3] every connect review states the limit unless the node signs: keysLimit is silent only for signs === true', () => {
  const sf = parse('src/renderer/components/ConnectReview.tsx')
  const fn = nodes(sf).filter(ts.isFunctionDeclaration).find((f) => f.name?.text === 'keysLimit')
  assert.ok(fn?.body, 'keysLimit moved: re-aim this test')
  const nulls = nodes(fn.body).filter((n): n is ts.ReturnStatement => ts.isReturnStatement(n) && n.expression?.kind === ts.SyntaxKind.NullKeyword)
  assert.equal(nulls.length, 1)
  assert.ok(ts.isIfStatement(nulls[0].parent) && nulls[0].parent.expression.getText() === 'signs === true')
  assert.match(fn.body.getText(), /whoever can intercept the setup request can answer it/)
  for (const review of ['ConnectionModal', 'plans/PlanConnectModal', 'multihop/ChainReviewModal']) {
    assert.match(read(`src/renderer/components/${review}.tsx`), /keysLimit\(\{/, `${review} shows the limit`)
  }
})

// [RN-9] A copied recovery phrase is wiped from the clipboard 30 s later, and the wipe
// must outlive the screen that scheduled it: the create screen unmounts the moment the
// new wallet opens, and Settings unmounts the Wallets tab on close or on a tab change,
// so a cleanup that cancels the timer left the phrase on the clipboard for good.
test('[RN-9] no unmount cleanup cancels a pending clipboard wipe', () => {
  const WIPE = /clipboard\.writeText\(\s*(''|""|``)\s*\)/
  const files = rendererFiles.filter((f) => WIPE.test(read(f)))
  for (const expected of ['src/renderer/components/wallet/MnemonicInput.tsx', 'src/renderer/components/settings/WalletsTab.tsx']) {
    assert.ok(files.includes(expected), `${expected} no longer wipes the clipboard: re-aim this test`)
  }
  const bad: string[] = []
  for (const f of files) {
    const all = nodes(parse(f))
    // The timers that carry a wipe: `x.current = window.setTimeout(() => { …writeText('')… })`.
    const timers = all.filter(ts.isBinaryExpression)
      .filter((b) => b.operatorToken.kind === ts.SyntaxKind.EqualsToken && WIPE.test(b.right.getText()) && /setTimeout\(/.test(b.right.getText()))
      .map((b) => b.left.getText().replace(/\.current$/, ''))
    assert.ok(timers.length > 0, `${f}: the wipe is no longer scheduled through a ref: re-aim this test`)
    // Every effect cleanup: the function an effect returns, concise or from a block.
    const effects = all.filter(ts.isCallExpression).filter((c) => c.expression.getText() === 'useEffect')
    for (const effect of effects) {
      const fn = effect.arguments[0]
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) continue
      const returned = ts.isBlock(fn.body)
        ? fn.body.statements.filter(ts.isReturnStatement).map((r) => r.expression)
        : [fn.body]
      for (const cleanup of returned) {
        if (!cleanup || !(ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup))) continue
        for (const t of timers) {
          if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(cleanup.getText())) {
            bad.push(`${where(cleanup)}: the cleanup touches ${t}`)
          }
        }
      }
    }
  }
  assert.deepEqual(bad, [], 'let the wipe fire after unmount; it touches only the clipboard')
})
