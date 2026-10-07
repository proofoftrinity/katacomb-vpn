import { build, type Plugin } from 'esbuild'
import { existsSync, mkdtempSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { ROOT, read } from './source.ts'

// Loads a main-process module the native test runner cannot import as-is (it uses
// extensionless relative imports, and it imports `electron`). The REAL source is
// bundled with esbuild; `electron` and `@electron-toolkit/utils` become the stand-ins
// in this directory; every module listed in `fake` becomes a generated recorder.
//
// A generated fake is derived from the real module's exports, so it cannot drift:
// each exported function forwards to world.call(mod, fn, args), which records the
// call and runs the test's fake (or throws `unstubbed mod.fn()`). Exported constants
// with a literal value and exported Error subclasses are reproduced as they are; any
// other export shape is refused, loudly, rather than guessed at. An npm package the
// bundle did not expect is refused too, so a new import into a module under test is
// a decision (fake it, or allow it), not an accident.

export interface BundleSpec {
  /** Repo-relative modules whose exports the bundle re-exports (the first is the module under test). */
  entries: string[]
  /** Repo-relative modules (no extension) to replace with generated recorders. */
  fake: string[]
  /** npm packages allowed to be bundled for real. */
  allowPackages?: string[]
  /** Bare specifiers (a Node builtin such as `child_process`) to replace with a harness file. */
  stubs?: Record<string, string>
}

export interface Bundle { path: string; load: () => Record<string, unknown> }

const HARNESS = dirname(new URL(import.meta.url).pathname)
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')

/** `chain/chain-service` for `src/main/chain/chain-service.ts`: the name tests use for a fake. */
export function modKey(repoPath: string): string {
  return repoPath.replace(/^src\/main\//, '').replace(/\.ts$/, '')
}

function resolveTs(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate
  }
  return null
}

function isConstExpr(n: ts.Expression): boolean {
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true
  if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isParenthesizedExpression(n)) return isConstExpr(n.expression)
  if (ts.isPrefixUnaryExpression(n)) return isConstExpr(n.operand)
  if (ts.isBinaryExpression(n)) return isConstExpr(n.left) && isConstExpr(n.right)
  if (ts.isAsExpression(n) && n.type.getText() === 'const') return isConstExpr(n.expression)
  return false
}

const exported = (s: ts.Statement) =>
  ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

/** The recorder that replaces `repoPath` in a bundle. */
export function fakeSource(repoPath: string): string {
  const sf = ts.createSourceFile(repoPath, read(repoPath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const mod = modKey(repoPath)
  const out = [`const __kv = (fn: string, args: unknown[]) => (globalThis as any).__kvWorld.call(${JSON.stringify(mod)}, fn, args)`]
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) throw new Error(`${repoPath}: re-export \`${st.getText()}\` - extend fakeSource before faking this module`)
    if (!exported(st)) continue
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue
    if (ts.isFunctionDeclaration(st) && st.name) {
      out.push(`export function ${st.name.text}(...args: unknown[]): any { return __kv(${JSON.stringify(st.name.text)}, args) }`)
    } else if (ts.isClassDeclaration(st) && st.name && st.heritageClauses?.some((h) => h.getText() === 'extends Error')) {
      const n = st.name.text
      out.push(`export class ${n} extends Error { constructor(message?: string) { super(message); this.name = ${JSON.stringify(n)} } }`)
    } else if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const)) {
      for (const d of st.declarationList.declarations) {
        const name = d.name.getText()
        const init = d.initializer
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.push(`export function ${name}(...args: unknown[]): any { return __kv(${JSON.stringify(name)}, args) }`)
        } else if (init && isConstExpr(init)) {
          out.push(`export const ${name} = ${init.getText()}`)
        } else {
          throw new Error(`${repoPath}: export const ${name} has no literal value - extend fakeSource before faking this module`)
        }
      }
    } else {
      throw new Error(`${repoPath}: cannot fake this export: ${st.getText().slice(0, 80)}`)
    }
  }
  return out.join('\n')
}

/** Bundle the spec into a CommonJS file under the temp dir. */
export async function bundle(spec: BundleSpec): Promise<Bundle> {
  const fakes = new Set(spec.fake.map((p) => resolve(ROOT, `${p}.ts`)))
  for (const f of fakes) if (!existsSync(f)) throw new Error(`no such module to fake: ${relative(ROOT, f)}`)
  const allowed = new Set(spec.allowPackages ?? [])

  const plugin: Plugin = {
    name: 'kv-harness',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: join(HARNESS, 'electron.ts') }))
      b.onResolve({ filter: /^@electron-toolkit\/utils$/ }, () => ({ path: join(HARNESS, 'electron-toolkit-utils.ts') }))
      b.onResolve({ filter: /^[./]/ }, (args) => {
        if (args.namespace === 'kv-fake') return undefined
        const target = args.path.startsWith('/') ? resolveTs(args.path, args.path) : resolveTs(args.importer, args.path)
        if (target && fakes.has(target)) return { path: target, namespace: 'kv-fake' }
        return undefined
      })
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        const stub = spec.stubs?.[args.path] ?? spec.stubs?.[args.path.replace(/^node:/, '')]
        if (stub && !args.importer.startsWith(HARNESS)) return { path: resolve(ROOT, stub) }
        if (builtins.has(args.path) || args.path === 'electron' || args.importer.startsWith(HARNESS)) return undefined
        if (allowed.has(packageOf(args.path))) return undefined
        return { errors: [{ text: `unexpected npm import '${args.path}' from ${relative(ROOT, args.importer)}: fake its importer, or allow the package` }] }
      })
      b.onLoad({ filter: /.*/, namespace: 'kv-fake' }, (args) => ({
        contents: fakeSource(relative(ROOT, args.path)),
        loader: 'ts',
        resolveDir: dirname(args.path),
      }))
    },
  }

  const outdir = mkdtempSync(join(tmpdir(), 'kv-bundle-'))
  const path = join(outdir, 'bundle.cjs')
  await build({
    stdin: {
      contents: spec.entries.map((e) => `export * from ${JSON.stringify(resolve(ROOT, e))}`).join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path,
    sourcemap: 'inline',
    logLevel: 'silent',
    plugins: [plugin],
  })
  const require = createRequire(import.meta.url)
  return {
    path,
    // A fresh instance each call: module-level state (every `let` in main) starts over.
    load: () => {
      delete require.cache[path]
      return require(path) as Record<string, unknown>
    },
  }
}
