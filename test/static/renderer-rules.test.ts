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

test('[RN-7] no /NN opacity modifier on a theme colour: tints come from the palette', () => {
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
  // The dark variant matches nothing, so a stray dark: utility stays inert; Tailwind's
  // default (prefers-color-scheme) would let it follow the OS theme.
  assert.match(read('src/renderer/styles/global.css'), /@custom-variant dark \(&:not\(\*\)\);/)
})

// [RN-12] The lines in global.css that make Tailwind 4 render what Tailwind 3 did. Each
// looks deletable, and each was measured moving pixels without it (2026-10-16).
test('[RN-12] global.css keeps the lines that make Tailwind 4 render as Tailwind 3 did', () => {
  const css = read('src/renderer/styles/global.css')
  assert.match(css, /@import 'flag-icons\/css\/flag-icons\.min\.css' layer\(base\);/, 'unlayered, flag-icons beats the size utilities on every flag')
  assert.match(css, /@custom-variant hover \(&:hover\);/, 'hover on every device, not only hover-capable ones')
  const LINE_HEIGHTS = { xs: '1rem', sm: '1.25rem', base: '1.5rem', lg: '1.75rem', xl: '1.75rem', '2xl': '2rem', '3xl': '2.25rem' }
  for (const [size, lh] of Object.entries(LINE_HEIGHTS)) {
    assert.ok(css.includes(`--text-${size}--line-height: ${lh};`), `text-${size} keeps Tailwind 3's absolute line height`)
  }
  assert.match(css, /@utility space-y-\* \{\s*& > :not\(\[hidden\]\) ~ :not\(\[hidden\]\) \{\s*margin-top: --spacing\(--value\(number\)\);\s*margin-bottom: 0;\s*\}\s*:where\(&\) > :not\(_\) \{\s*margin-bottom: 0;\s*\}\s*\}/,
    "space-y keeps Tailwind 3's selector")
  assert.match(css, /button,\s*\[role="button"\]\s*\{\s*cursor: pointer;\s*\}/, 'buttons show the pointer')
  assert.match(css, /:disabled\s*\{\s*cursor: default;\s*\}/)
  assert.match(css, /input::placeholder,\s*textarea::placeholder\s*\{\s*color: #9ca3af;\s*\}/, 'placeholders keep their grey')
  assert.match(css, /option\s*\{\s*padding: revert;\s*\}/, "an option keeps the browser's padding")
})

// [RN-13] postcss.config.js drops flag-icons' square artwork, so `fis` only makes the box
// square, and the 4:3 artwork has to cover it or the circle shows bands above and below.
test('[RN-13] a round flag covers its circle: every fis also carries bg-cover', () => {
  const hits = rendererFiles.flatMap((f) => read(f).split('\n').flatMap((line, i) => {
    const code = line.replace(/\/\*.*?\*\/|\/\/.*$/g, '')
    return /(^|[\s'"`])fis(?=[\s'"`]|$)/.test(code) && !/(^|[\s'"`])bg-cover(?=[\s'"`]|$)/.test(code) ? [`${f}:${i + 1}: ${line.trim()}`] : []
  }))
  assert.deepEqual(hits, [])
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

test('[SL-1] the Sessions tab never words End as an instant refund: what is left comes back only when the chain settles', () => {
  const shown = shownText('src/renderer/components/ActiveSessions.tsx')
  assert.deepEqual(shown.filter((t) => /refund|money back|get .* back|returned to you|reimburs|forfeit/i.test(t)), [])
  const comesBack = shown.filter((t) => /back to your wallet/i.test(t))
  assert.ok(comesBack.length > 0, 'the End confirmation says what happens to a P2P deposit')
  for (const t of comesBack) assert.match(t, /when the chain settles the session, about 2 hours from now/, t)
  assert.ok(shown.some((t) => /plan keeps whatever data and time it has left/i.test(t)), 'and to a plan session\'s allocation')
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

// [RN-15] One line per fact on screen, the reason one press away. Every renderer file, since
// the last phase of the plan of 2026-11-04; help-topics.ts is the on-demand text itself.
const SHORT_COPY_FILES = rendererFiles.filter((f) =>
  /\.tsx?$/.test(f) && !f.endsWith('.test.ts') && f !== 'src/renderer/utils/help-topics.ts')
const MAX_LINE = 120
// Components whose content is the "one press away" part.
const ON_DEMAND = new Set(['InfoTip', 'Tooltip', 'HelpPanel'])
// Attributes that never reach the screen as a line of copy, or are the on-demand part. A
// native `title` is measured: a long one belongs in a Tooltip, which keyboard users can open.
const NOT_A_LINE = new Set(['className', 'placeholder', 'key', 'id', 'href', 'type', 'label', 'content', 'detail', 'topic', 'value'])

/** The longest text an expression can put on screen; dynamic parts count as nothing. */
function staticText(e: ts.Node): string {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => staticText(s.expression) + s.literal.text).join('')
  if (ts.isParenthesizedExpression(e)) return staticText(e.expression)
  if (ts.isConditionalExpression(e)) {
    const [a, b] = [staticText(e.whenTrue), staticText(e.whenFalse)]
    return a.length >= b.length ? a : b
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return staticText(e.right)
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      const [a, b] = [staticText(e.left), staticText(e.right)]
      return a.length >= b.length ? a : b
    }
    if (op === ts.SyntaxKind.PlusToken) return staticText(e.left) + staticText(e.right)
  }
  return ''
}

const tagOf = (el: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(el) ? el.openingElement : el).tagName.getText()
const hasAttr = (el: ts.JsxElement, name: string) => el.openingElement.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === name)
const propName = (p: ts.PropertyAssignment) => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '')

/** Inside a tip (a `tip:` or a `fooTip` variable), a Limit's panel, a `data-full` element or an on-demand component. */
function onDemandOrFull(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if ((ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) && ON_DEMAND.has(tagOf(p))) return true
    if (ts.isJsxElement(p) && hasAttr(p, 'data-full')) return true
    // A `fooTip` variable holds text a tip shows.
    if (ts.isVariableDeclaration(p) && /Tip$/.test(p.name.getText())) return true
    if (ts.isPropertyAssignment(p)) {
      const name = propName(p)
      if (name === 'tip' || name === 'detail') return true
      // { label, text } is a tip or a Limit's panel: the label shows, the text on demand.
      if (name === 'text' && ts.isObjectLiteralExpression(p.parent) &&
        p.parent.properties.some((q) => ts.isPropertyAssignment(q) && propName(q) === 'label')) return true
    }
  }
  return false
}

/** A class string kept in a constant: no capital and no sentence punctuation, which a long line of copy always has. */
const isClassList = (t: string) => !/[A-Z]/.test(t) && !/[,;]|\.\s/.test(t)
/** Markup, not words: an SVG path or a CSS selector never has two plain words in a row. */
const isMarkup = (t: string) => !/[A-Za-z]+ [A-Za-z]+/.test(t)

/** Every line of copy in `sf` longer than MAX_LINE that is not on demand or marked data-full. */
function longLines(sf: ts.SourceFile): string[] {
  const out: string[] = []
  const report = (n: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, ' ').trim()
    if (t.length > MAX_LINE && !isClassList(t) && !isMarkup(t) && !onDemandOrFull(n)) out.push(`${where(n)}: ${t.length} chars: "${t.slice(0, 70)}…"`)
  }
  const COMBINING = (n: ts.Node) => ts.isTemplateSpan(n) || ts.isParenthesizedExpression(n) || ts.isConditionalExpression(n) || ts.isBinaryExpression(n)
  const STRINGISH = (n: ts.Node) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)
  for (const n of nodes(sf)) {
    // A JSX element's own words, or a fragment's: its text runs and the strings it interpolates.
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      if (ts.isJsxElement(n) && hasAttr(n, 'data-full')) continue
      report(n, n.children.map((c) => ts.isJsxText(c) ? c.text : ts.isJsxExpression(c) && c.expression ? staticText(c.expression) : ' ').join(''))
      continue
    }
    // Any other string: measured whole, once, at the outermost expression that builds it.
    if (!STRINGISH(n)) continue
    let top: ts.Node = n
    while (top.parent && COMBINING(top.parent)) top = top.parent
    if (ts.isTemplateSpan(top) || ts.isImportDeclaration(top.parent)) continue // inside a template, measured with it
    if (nodes(top).find(STRINGISH) !== n) continue
    const at = top.parent
    if (ts.isJsxExpression(at) && (ts.isJsxElement(at.parent) || ts.isJsxFragment(at.parent))) continue // measured with its element
    const attr = ts.isJsxAttribute(at) ? at : ts.isJsxExpression(at) && ts.isJsxAttribute(at.parent) ? at.parent : null
    if (attr && (NOT_A_LINE.has(attr.name.getText()) || attr.name.getText().startsWith('aria-'))) continue
    report(top, staticText(top))
  }
  return out
}

test('[RN-15] a rewritten screen puts one line per fact on screen: nothing over 120 characters outside a tip or data-full', () => {
  const hits = SHORT_COPY_FILES.flatMap((f) => longLines(parse(f)))
  assert.deepEqual(hits, [], 'shorten the line and move the reason into a tip or a Help topic; a blocker, an error or money that cannot come back keeps its words and carries data-full')
})

test('[RN-15] the measure sees a long line, and lets a tip or data-full through', () => {
  // A positive control: the rule above would pass vacuously if longLines saw nothing.
  const long = 'Long words. '.repeat(11)
  const flagged = (src: string) => longLines(ts.createSourceFile('probe.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)).length > 0
  assert.ok(flagged(`const a = <p>${long}</p>`))
  assert.ok(flagged(`const a = <p>{ok ? '${long}' : 'short'}</p>`))
  assert.ok(flagged(`const a = <>${long}</>`))
  assert.ok(flagged(`const a = <span title="${long}">x</span>`))
  assert.ok(flagged(`const a = ['${long}']`))
  assert.ok(!flagged(`const a = <p data-full>${long}</p>`))
  assert.ok(!flagged(`const a = <p data-full><>${long}</></p>`))
  assert.ok(!flagged(`const a = <InfoTip label="why"><p>${long}</p></InfoTip>`))
  assert.ok(!flagged(`const a = <InfoTip label="why">${long}</InfoTip>`))
  assert.ok(!flagged(`const a = <Tooltip content="${long}">x</Tooltip>`))
  assert.ok(!flagged(`const a = { label: 'Limit', text: <p>${long}</p> }`))
  assert.ok(!flagged(`const whyTip = <p>${long}</p>`))
  assert.ok(!flagged(`const GHOST = '${'flex items-center gap-1.5 text-xs '.repeat(5)}'`))
  assert.ok(!flagged(`const a = <path d="${'M544.86,911.94l348.09-2.88c11.7-.09 '.repeat(5)}" />`))
  assert.ok(!flagged(`const FOCUSABLE = '${'button:not([disabled]), [href], '.repeat(5)}'`))
})

// [RN-15] Say it once: "This is an on-chain transaction" closed about 14 confirm bodies
// before the confirm's `fee` line said it for all of them.
test('[RN-15] an on-chain confirm says its fee in the fee line, not in a paragraph of its own', () => {
  assert.match(read('src/renderer/components/ConfirmModal.tsx'), /pending\.fee &&/, 'the confirm lost its fee line: re-aim this test')
  const said = SHORT_COPY_FILES.flatMap((f) => shownText(f).filter((t) => /is an on-chain transaction/i.test(t)).map((t) => `${f}: ${t}`))
  assert.deepEqual(said, [])
})

// [RN-15] Shortening the create screen surfaced a false line: "You will not be shown this
// again", while Settings, Wallets, Recovery phrase shows the phrase whenever it is asked.
const NEVER_AGAIN = /(not|never|n't) (be )?(shown|see|displayed|show)\w* (this |it |them )?again|only (time|chance) (to|you)|last (time|chance) to (see|write)/i

test('[RN-15] no screen says the recovery phrase will not be shown again: the Wallets tab shows it', () => {
  assert.match(read('src/renderer/components/settings/WalletsTab.tsx'), /window\.api\.walletRevealMnemonic\(/,
    'the Wallets tab no longer shows the phrase: re-aim this test')
  const claims = rendererFiles.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
    .flatMap((f) => shownText(f).filter((t) => NEVER_AGAIN.test(t)).map((t) => `${f}: ${t}`))
  assert.deepEqual(claims, [])
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

test('[REL-41] a seed locked only because no keyring answered is never offered for removal as unusable', () => {
  // Both screens that list locked wallets tell the two cases apart.
  for (const f of ['src/renderer/components/wallet/WalletPicker.tsx', 'src/renderer/components/settings/WalletsTab.tsx']) {
    assert.match(read(f), /keyringMissing \? <>[\s\S]*?restart the app/, `${f}: the locked note must say to restart when no keyring answered`)
  }
  // The delete window's note: "nothing usable is removed" is false when the keyring merely did not answer.
  const tab = parse('src/renderer/components/settings/WalletsTab.tsx')
  const note = nodes(tab).find((n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && n.name.getText() === 'deleteNote')
  assert.ok(note?.initializer, 'deleteNote not found in WalletsTab.tsx')
  const text = note.initializer.getText()
  const missing = text.indexOf('keyringMissing')
  const unusable = text.indexOf('nothing usable is removed')
  assert.ok(missing >= 0 && unusable >= 0 && missing < unusable, `${where(note)}: deleteNote must answer the no-keyring case before calling a locked seed unusable`)
})
