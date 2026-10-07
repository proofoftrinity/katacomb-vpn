#!/usr/bin/env node
// [ARCH-3] After `electron-vite build`: the main and preload bundles may require only
// Electron, Node builtins and ws's two optional native deps (externalized on purpose,
// they no-op when absent). Anything else is an npm package that was left external,
// and the packaged app ships no node_modules - it would die at runtime with
// MODULE_NOT_FOUND or ERR_REQUIRE_ESM. test/static/bundling.test.ts checks the source
// side; this checks what was actually built.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

const ALLOWED_EXTERNALS = new Set(['electron', 'bufferutil', 'utf-8-validate'])
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

const files = ['out/main', 'out/preload'].flatMap((dir) => {
  if (!existsSync(dir)) {
    console.error(`${dir} is missing: run \`npx electron-vite build\` first`)
    process.exit(2)
  }
  return readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f))
})

const bad = []
for (const file of files) {
  for (const [, spec] of readFileSync(file, 'utf-8').matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    if (spec.startsWith('.') || builtins.has(spec) || builtins.has(spec.split('/')[0]) || ALLOWED_EXTERNALS.has(spec)) continue
    bad.push(`${file}: require("${spec}")`)
  }
}

if (bad.length) {
  console.error('Unbundled packages in the build output (add them to DEPS_TO_BUNDLE in electron.vite.config.ts):')
  for (const b of bad) console.error(`  ${b}`)
  process.exit(1)
}
console.log(`ok: ${files.length} bundles require only electron, Node builtins and the ws optional deps`)
