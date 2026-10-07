import { test } from 'node:test'
import assert from 'node:assert/strict'
import { builtinModules } from 'node:module'
import { parse, read, runtimeImports, sources, walk } from '../harness/source.ts'

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
