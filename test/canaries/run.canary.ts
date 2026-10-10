import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ROOT } from '../harness/source.ts'
import { CANARIES, type Canary } from './canaries.ts'

// `npm run test:canaries`: every canary in canaries.ts must turn its tests red.
// Each runs in its own copy of the working tree (uncommitted changes included), so
// the real checkout is never mutated and the canaries can run side by side.

const run = promisify(execFile)
// node:test marks the processes it spawns with NODE_TEST_CONTEXT; a nested
// `node --test` that inherits it reports to a parent that is not listening and
// exits 0 whatever happened - every canary would "survive". Strip it.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'))

// What a copy needs. node_modules and the 90 MB of vendored binaries are linked, not copied.
const COPY = ['src', 'test', 'daemon', 'docs', 'CLAUDE.md', 'package.json', 'tsconfig.json', 'tsconfig.node.json',
  'tsconfig.web.json', 'tsconfig.test.json', 'electron.vite.config.ts', 'tailwind.config.js', 'postcss.config.js']
const LINK = ['node_modules', 'resources', 'build']

let template = ''
before(() => {
  template = mkdtempSync(join(tmpdir(), 'kv-canary-template-'))
  for (const p of COPY) cpSync(join(ROOT, p), join(template, p), { recursive: true })
})
after(() => rmSync(template, { recursive: true, force: true }))

/**
 * Give a canary a private copy of its file when the file sits under a LINKED tree:
 * written through the link, the mutation would land in the real checkout. Each
 * directory on the way down becomes real (its other entries still links), and the
 * file itself a copy.
 */
function privatize(dir: string, rel: string): void {
  const parts = rel.split('/')
  let cur = dir
  for (let i = 0; i < parts.length; i++) {
    const p = join(cur, parts[i])
    if (lstatSync(p).isSymbolicLink()) {
      const real = realpathSync(p)
      unlinkSync(p)
      if (i === parts.length - 1) {
        copyFileSync(real, p)
        return
      }
      mkdirSync(p)
      for (const e of readdirSync(real)) symlinkSync(join(real, e), join(p, e))
    }
    cur = p
  }
}

async function ranRed(c: Canary): Promise<{ red: boolean; output: string; target?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kv-canary-'))
  try {
    for (const p of COPY) cpSync(join(template, p), join(dir, p), { recursive: true })
    for (const p of LINK) symlinkSync(join(ROOT, p), join(dir, p))
    privatize(dir, c.file)
    const path = join(dir, c.file)
    const src = readFileSync(path, 'utf-8')
    const hits = src.split(c.find).length - 1
    assert.equal(hits, 1, `canary "${c.name}" must match its anchor exactly once in ${c.file} (found ${hits}): re-aim it`)
    writeFileSync(path, src.replace(c.find, c.replace))
    let output = ''
    for (const target of c.run) {
      try {
        // The reporter is named, not left to the default: the check below reads spec's ✖,
        // and Node 22 (CI's) reports TAP to a pipe where Node 23+ reports spec. With the
        // default, every node canary failed in CI as "no failing test is titled".
        const r = target.startsWith('go:')
          ? await run('go', ['test', '-count=1', target.slice(3)], { cwd: join(dir, 'daemon'), env, maxBuffer: 1 << 26 })
          : await run(process.execPath, ['--test', '--test-reporter=spec', target], { cwd: dir, env, maxBuffer: 1 << 26 })
        output += r.stdout
      } catch (err) {
        // A non-zero exit from any target turned the run red; the test below checks it
        // was the rule's own test that did.
        return { red: true, output: String((err as { stdout?: string }).stdout ?? err), target }
      }
    }
    return { red: false, output }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const concurrency = Math.max(1, Math.floor(availableParallelism() / 2))

describe('every canary is caught', { concurrency }, () => {
  for (const c of CANARIES) {
    test(c.name, async () => {
      const { red, output, target } = await ranRed(c)
      assert.ok(red, `the suite survived "${c.name}": nothing guards that rule any more.\n${output.slice(-2000)}`)
      // A mutation that breaks the build, or some unrelated test, is red too and proves
      // nothing about the rule. Caught means a failing test titled with the canary's ID
      // (for a daemon package, a failing Go test).
      const id = c.name.match(/^\[([A-Z]+-\d+)\]/)?.[1]
      const own = target?.startsWith('go:') ? /--- FAIL/ : new RegExp(`^\\s*✖ .*\\[${id}\\]`, 'm')
      assert.match(output, own, `"${c.name}" turned ${target} red, but no failing test is titled [${id}]: the mutation ` +
        `broke something else (the build, or another rule's test). Aim it so the rule's own test catches it.\n${output.slice(-2000)}`)
    })
  }
})
