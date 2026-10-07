import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Reading the repo's own source, for the tests that enforce a rule about the code
// rather than about what it computes (the registry, the static rules). Paths are
// repo-relative throughout, so failure messages point at a file a reader can open.

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

export function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
}

/** Repo-relative paths under `dir` that `keep` accepts. Skips node_modules and dotdirs. */
export function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const rel = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(rel, keep))
    else if (keep(rel)) out.push(rel)
  }
  return out
}

/** Non-test TypeScript sources under `dir`. */
export function sources(dir: string): string[] {
  return walk(dir, (p) => /\.tsx?$/.test(p) && !p.endsWith('.test.ts') && !p.endsWith('.d.ts'))
}

export function parse(rel: string): ts.SourceFile {
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, kind)
}

/** Every node in the tree, depth first. */
export function nodes(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (n: ts.Node): void => { out.push(n); ts.forEachChild(n, visit) }
  visit(root)
  return out
}

/** Every call expression in the tree. */
export function calls(root: ts.Node): ts.CallExpression[] {
  return nodes(root).filter(ts.isCallExpression)
}

/** `foo(…)` → 'foo', `a.b.foo(…)` → 'foo'; anything else → null. */
export function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return null
}

/** `IPC.FOO` → 'FOO' (the shape every channel reference in this repo takes). */
export function ipcKey(node: ts.Node | undefined): string | null {
  if (node && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'IPC') {
    return node.name.text
  }
  return null
}

/** `file:line` for a node, for failure messages. */
export function where(node: ts.Node): string {
  const sf = node.getSourceFile()
  return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
}

/** Module specifiers a file imports at runtime (type-only imports excluded). */
export function runtimeImports(sf: ts.SourceFile): string[] {
  const out: string[] = []
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause
      if (clause?.isTypeOnly) continue
      const named = clause?.namedBindings
      const allTypes = !clause?.name && named !== undefined && ts.isNamedImports(named) &&
        named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly)
      if (!allTypes) out.push(st.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      out.push(st.moduleSpecifier.text)
    }
  }
  for (const c of calls(sf)) {
    if (c.expression.kind === ts.SyntaxKind.ImportKeyword && c.arguments[0] && ts.isStringLiteral(c.arguments[0])) {
      out.push(c.arguments[0].text)
    }
  }
  return out
}
