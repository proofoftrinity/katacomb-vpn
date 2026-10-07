import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { read, walk } from '../harness/source.ts'

// The invariant registry. Every rule the docs state carries an ID where it is stated
// (`**[REL-1] Refund on any failure.**`), and every test that pins a rule carries that
// ID in its title. This file is what makes the link mechanical: delete the last test
// for a rule, or add a rule with no test and no recorded reason, and the suite is red.
// docs/testing.md has the rules for IDs and for test/invariants/status.json.

// Each prefix is defined in exactly one file, so an ID says where to read its rule.
const HOMES: Record<string, string> = {
  REL: 'docs/invariants/reliability.md',
  NT: 'docs/invariants/node-trust.md',
  SL: 'docs/invariants/session-lifecycle.md',
  PH: 'docs/privileged-helper.md',
  PRO: 'docs/protocols.md',
  MH: 'docs/multihop.md',
  PC: 'docs/provider-console.md',
  RN: 'docs/renderer.md',
  PKG: 'docs/packaging.md',
  ARCH: 'CLAUDE.md',
}

const ID_RE = /\[([A-Z]+-\d+)\]/g
// A definition is an ID that opens a bold run: `**[REL-1] …**` or a bare `**[NT-2]**`.
// A plain `[REL-1]` anywhere else is a reference to it.
const DEF_RE = /\*\*\[([A-Z]+-\d+)\]/g

const idsIn = (s: string) => [...s.matchAll(ID_RE)].map((m) => m[1])

// --- definitions ---------------------------------------------------------------

const docFiles = ['CLAUDE.md', ...walk('docs', (p) => p.endsWith('.md'))]
const definitions = new Map<string, string[]>() // id -> files defining it
for (const f of docFiles) {
  for (const m of read(f).matchAll(DEF_RE)) {
    definitions.set(m[1], [...(definitions.get(m[1]) ?? []), f])
  }
}

// --- pins ----------------------------------------------------------------------

interface Citation { id: string; where: string; pins: boolean }
const citations: Citation[] = []

const TEST_FNS = new Set(['test', 'it', 'describe', 'suite'])
const NOT_RUN = new Set(['skip', 'todo'])

function titleText(arg: ts.Expression | undefined): string | null {
  if (!arg) return null
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
  if (ts.isTemplateExpression(arg)) return arg.head.text + arg.templateSpans.map((s) => s.literal.text).join('')
  return null
}

function hasNotRunOption(args: ts.NodeArray<ts.Expression>): boolean {
  return args.some((a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) =>
    p.name !== undefined && ts.isIdentifier(p.name) && NOT_RUN.has(p.name.text)))
}

// A title pins its IDs when the test actually runs: `test.todo(…)`, `test.skip(…)`
// and `{ todo }` / `{ skip }` options cite a rule without enforcing it.
function scanTs(file: string): void {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let isTest = false
      let pins = true
      if (ts.isIdentifier(callee)) {
        isTest = TEST_FNS.has(callee.text)
      } else if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text
        if (TEST_FNS.has(name)) isTest = true
        else if (NOT_RUN.has(name) && ts.isIdentifier(callee.expression) && TEST_FNS.has(callee.expression.text)) {
          isTest = true
          pins = false
        }
      }
      const title = isTest ? titleText(node.arguments[0]) : null
      if (title !== null) {
        if (hasNotRunOption(node.arguments)) pins = false
        for (const id of idsIn(title)) citations.push({ id, where: file, pins })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

// Go carries the ID in a t.Run name (it then shows in failure output) or in the
// comment block directly above a func Test… / func Fuzz….
function scanGo(file: string): void {
  const lines = read(file).split('\n')
  lines.forEach((line, i) => {
    if (/^func (Test|Fuzz)\w*\(/.test(line)) {
      for (let j = i - 1; j >= 0 && lines[j].startsWith('//'); j--) {
        for (const id of idsIn(lines[j])) citations.push({ id, where: file, pins: true })
      }
    }
    for (const m of line.matchAll(/t\.Run\(\s*"([^"]*)"/g)) {
      for (const id of idsIn(m[1])) citations.push({ id, where: file, pins: true })
    }
  })
}

const tsTests = [
  ...walk('src', (p) => p.endsWith('.test.ts')),
  ...walk('test', (p) => p.endsWith('.test.ts')),
]
const goTests = walk('daemon', (p) => p.endsWith('_test.go'))
tsTests.forEach(scanTs)
goTests.forEach(scanGo)

const pinned = new Set(citations.filter((c) => c.pins).map((c) => c.id))

// --- status --------------------------------------------------------------------

type Status = Record<'pending' | 'partial' | 'manual', Record<string, string>>
const status = JSON.parse(read('test/invariants/status.json')) as Status

// --- checks --------------------------------------------------------------------

test('the scan found the suite (guards against a walker that silently reads nothing)', () => {
  assert.ok(tsTests.length > 50, `only ${tsTests.length} TS test files found`)
  assert.ok(goTests.length > 10, `only ${goTests.length} Go test files found`)
  assert.ok(definitions.size > 50, `only ${definitions.size} rule IDs found`)
  assert.ok(pinned.size > 20, `only ${pinned.size} pinned IDs found`)
})

test('every ID is defined exactly once, in the file its prefix belongs to', () => {
  const problems: string[] = []
  for (const [id, files] of definitions) {
    const home = HOMES[id.split('-')[0]]
    if (!home) problems.push(`${id}: unknown prefix (add it to HOMES and docs/testing.md)`)
    else if (files.some((f) => f !== home)) problems.push(`${id}: defined in ${files.join(', ')}, but ${id.split('-')[0]} lives in ${home}`)
    if (files.length > 1) problems.push(`${id}: defined ${files.length} times — IDs are never reused`)
  }
  assert.deepEqual(problems, [])
})

test('every rule in docs/invariants carries an ID', () => {
  const problems: string[] = []
  for (const f of walk('docs/invariants', (p) => p.endsWith('.md'))) {
    read(f).split('\n').forEach((line, i) => {
      // Top-level rules: a bullet or a paragraph that opens in bold.
      if (/^(- )?\*\*/.test(line) && !/^(- )?\*\*\[[A-Z]+-\d+\]/.test(line)) {
        problems.push(`${f}:${i + 1}: ${line.slice(0, 70)}`)
      }
    })
  }
  assert.deepEqual(problems, [], 'tag each rule with the next free ID: `- **[REL-34] …**`')
})

test('every ID a test or status.json cites is defined in a doc', () => {
  const cited = [
    ...citations.map((c) => [c.id, c.where] as const),
    ...Object.values(status).flatMap((group) => Object.keys(group).map((id) => [id, 'test/invariants/status.json'] as const)),
  ]
  const unknown = cited.filter(([id]) => !definitions.has(id)).map(([id, where]) => `${id} (${where})`)
  assert.deepEqual(unknown, [])
})

test('every status entry carries a reason, and an ID sits in one group at most', () => {
  const problems: string[] = []
  const seen = new Map<string, string>()
  for (const [group, entries] of Object.entries(status)) {
    for (const [id, reason] of Object.entries(entries)) {
      if (typeof reason !== 'string' || reason.trim().length < 10) problems.push(`${group}.${id}: give a real reason`)
      if (seen.has(id)) problems.push(`${id}: in both ${seen.get(id)} and ${group}`)
      seen.set(id, group)
    }
  }
  assert.deepEqual(problems, [])
})

test('every rule is pinned by a test, or its status.json entry says why not', () => {
  const unaccounted = [...definitions.keys()]
    .filter((id) => !pinned.has(id) && !(id in status.pending) && !(id in status.manual))
    .sort()
  assert.deepEqual(unaccounted, [], 'pin each with a test titled `[ID] …`, or (with the user\'s OK) record why in status.json')
})

test('pending and manual list only unpinned rules, partial only pinned ones', () => {
  const problems: string[] = []
  for (const id of Object.keys(status.pending)) if (pinned.has(id)) problems.push(`${id} is pinned now: remove it from pending`)
  for (const id of Object.keys(status.manual)) if (pinned.has(id)) problems.push(`${id} is pinned now: remove it from manual`)
  for (const id of Object.keys(status.partial)) if (!pinned.has(id)) problems.push(`${id} has no test: partial needs one, so it belongs in pending`)
  assert.deepEqual(problems, [])
})

test('registry summary', (t) => {
  t.diagnostic(`${definitions.size} rules: ${pinned.size} pinned (${Object.keys(status.partial).length} of them partially), ` +
    `${Object.keys(status.pending).length} pending, ${Object.keys(status.manual).length} manual`)
})

