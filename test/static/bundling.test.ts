import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import ts from 'typescript'
import { ROOT, nodes, parse, runtimeImports, sources } from '../harness/source.ts'

// [ARCH-3] Electron loads main as CJS, and the CosmJS / SDK tree has ESM-only
// transitive deps, so every npm package main or preload imports must be bundled
// (DEPS_TO_BUNDLE in electron.vite.config.ts). A miss builds fine and dies at
// runtime with ERR_REQUIRE_ESM; scripts/check-bundle-requires.mjs checks the built
// output too, in CI.

const config = parse('electron.vite.config.ts')
const decl = nodes(config).find((n): n is ts.VariableDeclaration =>
  ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'DEPS_TO_BUNDLE')
assert.ok(decl?.initializer && ts.isArrayLiteralExpression(decl.initializer), 'DEPS_TO_BUNDLE array not found')
const bundled = new Set(decl.initializer.elements.filter(ts.isStringLiteral).map((e) => e.text))

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
/** `@scope/pkg/deep/path` → `@scope/pkg`, `pkg/sub` → `pkg`. */
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')

test('[ARCH-3] every npm package main and preload import is in DEPS_TO_BUNDLE', () => {
  const missing = new Set<string>()
  for (const file of [...sources('src/main'), ...sources('src/preload'), ...sources('src/shared')]) {
    for (const spec of runtimeImports(parse(file))) {
      if (spec.startsWith('.') || builtins.has(spec) || spec === 'electron') continue
      if (!bundled.has(packageOf(spec))) missing.add(`${packageOf(spec)} (${file})`)
    }
  }
  assert.deepEqual([...missing].sort(), [], 'add it to DEPS_TO_BUNDLE in electron.vite.config.ts')
})

test('[ARCH-3] every DEPS_TO_BUNDLE entry is an installed package', () => {
  const absent = [...bundled].filter((pkg) => !existsSync(join(ROOT, 'node_modules', pkg, 'package.json')))
  assert.deepEqual(absent, [], 'a stale entry hides nothing today, but it means the list is no longer read')
})
