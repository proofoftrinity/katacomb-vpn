import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

async function ranRed(c: Canary): Promise<{ red: boolean; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kv-canary-'))
  try {
    for (const p of COPY) cpSync(join(template, p), join(dir, p), { recursive: true })
    for (const p of LINK) symlinkSync(join(ROOT, p), join(dir, p))
    const path = join(dir, c.file)
    const src = readFileSync(path, 'utf-8')
    const hits = src.split(c.find).length - 1
    assert.equal(hits, 1, `canary "${c.name}" must match its anchor exactly once in ${c.file} (found ${hits}): re-aim it`)
    writeFileSync(path, src.replace(c.find, c.replace))
    let output = ''
    for (const target of c.run) {
      try {
        const r = target.startsWith('go:')
          ? await run('go', ['test', '-count=1', target.slice(3)], { cwd: join(dir, 'daemon'), env, maxBuffer: 1 << 26 })
          : await run(process.execPath, ['--test', target], { cwd: dir, env, maxBuffer: 1 << 26 })
        output += r.stdout
      } catch (err) {
        // A non-zero exit from any target is the canary being caught.
        return { red: true, output: String((err as { stdout?: string }).stdout ?? err) }
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
      const { red, output } = await ranRed(c)
      assert.ok(red, `the suite survived "${c.name}": nothing guards that rule any more.\n${output.slice(-2000)}`)
    })
  }
})
