import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { version } from './package.json'

// Bundle everything except native modules and electron builtins.
// The CosmJS / dVPN SDK ecosystem has ESM-only transitive deps
// (@scure/base, @noble/*) that Electron's CJS require() can't load,
// so we must let Vite transpile the entire dependency tree.
const DEPS_TO_BUNDLE = [
  // Bundle the one remaining externalized main-process dep so NOTHING needs
  // node_modules at runtime — lets us drop the whole tree from the package
  // (everything else main/renderer use is already inlined by the bundler).
  '@electron-toolkit/utils',
  '@sentinel-official/sentinel-js-sdk',
  '@cosmjs/encoding',
  '@cosmjs/crypto',
  '@cosmjs/amino',
  '@cosmjs/math',
  '@cosmjs/proto-signing',
  '@cosmjs/stargate',
  '@cosmjs/tendermint-rpc',
  '@cosmjs/stream',
  '@cosmjs/utils',
  '@cosmjs/json-rpc',
  '@cosmjs/socket',
  '@scure/base',
  '@scure/bip32',
  '@scure/bip39',
  '@noble/hashes',
  '@noble/curves',
  'long',
  'protobufjs',
  'axios',
  'cosmjs-types',
]

// electron-vite defaults build.minify to FALSE (unlike plain Vite, which minifies
// production builds), so every section below has to ask for it explicitly. Without
// these the packaged app ships readable source: 4.2 MB for the globe chunk alone,
// and ~4.8 MB across main + renderer.
// Vite emits an asset the moment it resolves a url() in CSS, which happens in a
// postcss plugin that runs BEFORE the one in postcss.config.js that drops the
// unused 1x1 flag rules. The rules go, the ~1.8 MB of SVG they pointed at stays.
// This sweeps anything the finished bundle no longer mentions. It is deliberately
// generic rather than flag-specific: an asset nothing references is dead weight
// whatever it is.
function dropUnreferencedAssets() {
  return {
    name: 'drop-unreferenced-assets',
    generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>) {
      const haystack = Object.values(bundle)
        .map((c) => (c.type === 'chunk' ? c.code : typeof c.source === 'string' ? c.source : ''))
        .join('\n')
      for (const name of Object.keys(bundle)) {
        const entry = bundle[name]
        if (entry.type !== 'asset') continue
        const base = name.split('/').pop() as string
        // Never sweep the entry CSS/JS themselves; only referenced-by-name assets.
        if (base.endsWith('.css') || base.endsWith('.js')) continue
        if (!haystack.includes(base)) delete bundle[name]
      }
    },
  }
}

// The packaged app ships no node_modules (electron-builder.yml): every npm package
// is inlined into out/, so no package's own LICENSE reaches the user that way.
// MIT/ISC/BSD require the notice in every copy, and Apache-2.0 §4 the licence text
// plus the package's NOTICE. npmNotices() writes them all to
// out/THIRD-PARTY-NOTICES-npm.md, which electron-builder ships at the app root.
//
// Texts for bundled packages whose npm release carries none, vendored under
// resources/npm-licenses/. Keyed by exact name@version so a bump fails the build
// until someone re-reads the licence at the new version: they do change between
// releases (the SDK went from ISC to Apache-2.0).
const VENDORED_LICENCES: Record<string, string> = {
  // github.com/cosmos/cosmjs at tag v0.38.1: its LICENSE, and the NOTICE that
  // Apache-2.0 §4(d) says must travel with it.
  '@cosmjs/amino@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/crypto@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/encoding@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/json-rpc@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/math@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/proto-signing@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/socket@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/stargate@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/stream@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/tendermint-rpc@0.38.1': 'cosmjs-0.38.1',
  '@cosmjs/utils@0.38.1': 'cosmjs-0.38.1',
  // Declares ISC and publishes no text or copyright line; the file says so.
  '@sentinel-official/sentinel-js-sdk@2.0.4': 'sentinel-js-sdk-2.0.4',
  // The licence section of each package's own README, the only place they publish it.
  'elliptic@6.6.1': 'elliptic-6.6.1',
  'brorand@1.1.0': 'brorand-1.1.0',
  'hash.js@1.1.7': 'hash.js-1.1.7',
  'hmac-drbg@1.0.1': 'hmac-drbg-1.0.1',
  'minimalistic-crypto-utils@1.0.1': 'minimalistic-crypto-utils-1.0.1',
  'https-proxy-agent@5.0.1': 'https-proxy-agent-5.0.1',
  'agent-base@6.0.2': 'agent-base-6.0.2',
}

// Package roots, collected across all three builds: electron-vite resolves this
// config once and runs main, preload and renderer in turn in one process.
// tailwindcss is seeded by hand. It is a devDependency, but its PostCSS plugin
// writes its preflight stylesheet into the renderer CSS without the bundler ever
// reading one of its files.
const bundledPackages = new Set([resolve(__dirname, 'node_modules/tailwindcss')])

function npmNotices() {
  let buildRoot = ''
  return {
    name: 'npm-notices',
    configResolved(config: { root: string }) {
      buildRoot = config.root
    },
    // Every file the build read: each module it loaded, plus what the CSS pipeline
    // @imported, which is the only route flag-icons' stylesheet takes (and which
    // reports it relative to the build's root). That is a superset of what ships,
    // since a package can be read and then tree-shaken away.
    generateBundle(this: { getWatchFiles(): string[] }) {
      for (const file of this.getWatchFiles()) {
        const path = resolve(buildRoot, file.replace(/^\0/, '').split('?')[0])
        const at = path.lastIndexOf('/node_modules/')
        if (at < 0) continue
        const base = at + '/node_modules/'.length
        const [first, second] = path.slice(base).split('/')
        bundledPackages.add(path.slice(0, base) + (first.startsWith('@') ? `${first}/${second}` : first))
      }
    },
    // Rewritten after each of the three builds, so the last one leaves all of them.
    closeBundle() {
      const packages = new Map<string, { name: string; version: string; licence: string; text: string }>()
      for (const root of bundledPackages) {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        const id = `${pkg.name}@${pkg.version}`
        const vendored = VENDORED_LICENCES[id]
        const dir = vendored ? resolve(__dirname, 'resources/npm-licenses', vendored) : root
        const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort()
        if (!files.some((f) => !/^notice/i.test(f))) {
          throw new Error(
            `${id} is bundled but ships no licence file. Vendor its upstream text under ` +
              `resources/npm-licenses/ and map it in VENDORED_LICENCES (see docs/packaging.md).`,
          )
        }
        const text = files
          .map((f) => `${f}:\n\n\`\`\`\n${readFileSync(join(dir, f), 'utf8').trimEnd()}\n\`\`\``)
          .join('\n\n')
        const licence = typeof pkg.license === 'string' ? pkg.license : ''
        packages.set(id, { name: pkg.name, version: pkg.version, licence, text })
      }
      const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
      // Packages that share a text (the eleven @cosmjs ones, React's three) print it once.
      const byText = new Map<string, string[]>()
      for (const p of sorted) byText.set(p.text, [...(byText.get(p.text) ?? []), `${p.name} ${p.version}`])
      const out = [
        '# Third-party notices for the npm packages in the app',
        '',
        'Katacomb VPN (GPL-3.0-or-later) is built with electron-vite, which inlines the npm',
        "packages below into the application's own JavaScript and CSS, so their licence texts",
        'travel in this file rather than in a `node_modules` folder. It is generated at build',
        'time from every file the bundler read, so it can list a package whose code was then',
        "tree-shaken away. Each text is the package's own licence and NOTICE files or, where",
        'its npm release ships none, the upstream text vendored under `resources/npm-licenses/`',
        'in the source repository.',
        '',
        '| Package | Version | Licence |',
        '|---|---|---|',
        ...sorted.map((p) => `| \`${p.name}\` | ${p.version} | ${p.licence} |`),
        ...[...byText].flatMap(([text, ids]) => ['', `## ${ids.join(', ')}`, '', text]),
      ]
      writeFileSync(resolve(__dirname, 'out/THIRD-PARTY-NOTICES-npm.md'), out.join('\n') + '\n')
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: DEPS_TO_BUNDLE,
      }),
      npmNotices(),
    ],
    build: {
      // Never ship source maps in the packaged app (would expose full main
      // source incl. wallet flow inside the AppImage/deb).
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        // ws optional native deps — must stay as runtime require() so they
        // gracefully no-op when not installed
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), npmNotices()],
    build: { sourcemap: false, minify: 'esbuild' },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
      },
    },
    // The renderer has no other route to the app version (no Node access), and
    // an IPC round-trip for a constant would be overkill.
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [react(), dropUnreferencedAssets(), npmNotices()],
    css: {
      postcss: resolve(__dirname, 'postcss.config.js'),
    },
    build: { sourcemap: false, minify: 'esbuild' },
  },
})
