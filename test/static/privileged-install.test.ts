import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { nodes, parse, read } from '../harness/source.ts'

// How the privileged helper reaches /usr/local/bin and how its unit keeps its state
// (docs/privileged-helper.md [PH-6], [PH-7]). The two install scripts are RUN here,
// against a helper that is executing at the time: the daemon runs from the installed
// path, and `cp` onto a running executable fails with ETXTBSY, which aborted every
// upgrade's postinst. Only the root-only steps (chown, systemctl) are stood in for.

const run = promisify(execFile)

/** A sandbox where `target` is a running executable, with chown/systemctl recorded instead of run. */
async function sandbox(): Promise<{ dir: string; target: string; env: NodeJS.ProcessEnv; log: () => string[]; stop: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'kv-install-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const tool of ['chown', 'systemctl']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${join(dir, 'calls')}"\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  const target = join(dir, 'katacomb-vpn-helper')
  copyFileSync('/bin/sleep', target)
  chmodSync(target, 0o755)
  const running = spawn(target, ['30'], { stdio: 'ignore' })
  // Until the exec lands the file is not busy yet: wait for the kernel to say it runs.
  for (let i = 0; i < 200; i++) {
    try { if (readlinkSync(`/proc/${running.pid}/exe`) === target) break } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 10))
  }
  return {
    dir,
    target,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    log: () => { try { return readFileSync(join(dir, 'calls'), 'utf-8').trim().split('\n') } catch { return [] } },
    stop: () => { running.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** installHelper's pkexec script, as the array of literal steps it is joined from. */
function installHelperScript(): string {
  const sf = parse('src/main/helper/system-setup.ts')
  const decl = nodes(sf).filter(ts.isVariableDeclaration).find((d) => d.name.getText() === 'script')
  assert.ok(decl?.initializer && ts.isCallExpression(decl.initializer), 'installHelper\'s script moved: re-aim this test')
  const array = (decl.initializer.expression as ts.PropertyAccessExpression).expression
  assert.ok(ts.isArrayLiteralExpression(array))
  return array.elements.map((e) => {
    assert.ok(ts.isNoSubstitutionTemplateLiteral(e) || ts.isStringLiteral(e), 'every step is a literal: paths go in as positional args')
    return e.text
  }).join(' && ')
}

test('[PH-7] control: cp onto the running helper fails with ETXTBSY, the failure the temp name exists for', async (t) => {
  const s = await sandbox()
  t.after(s.stop)
  writeFileSync(join(s.dir, 'new'), 'helper v2')
  await assert.rejects(run('cp', ['--', join(s.dir, 'new'), s.target]), /Text file busy/)
})

test('[PH-7] installHelper\'s pkexec script replaces a RUNNING helper through a temp name, then restarts the unit', async (t) => {
  const s = await sandbox()
  t.after(s.stop)
  const src = join(s.dir, 'bundled-helper')
  const policySrc = join(s.dir, 'bundled.policy')
  const policyDest = join(s.dir, 'installed.policy')
  writeFileSync(src, 'helper v2')
  writeFileSync(policySrc, 'policy v2')
  await run('sh', ['-c', installHelperScript(), '--', src, policySrc, s.target, policyDest], { env: s.env })
  assert.equal(readFileSync(s.target, 'utf-8'), 'helper v2')
  assert.equal(readFileSync(policyDest, 'utf-8'), 'policy v2')
  assert.ok(s.log().includes('systemctl try-restart katacomb-vpn-daemon.service'), 'the daemon is moved onto the new binary')
})

test('[PH-7] the deb\'s postinstall replaces a RUNNING helper through a temp name', async (t) => {
  const s = await sandbox()
  t.after(s.stop)
  const post = read('resources/linux/packaging/postinstall.sh')
  const start = post.indexOf('if [ -f "$HELPER_SRC" ]; then')
  assert.ok(start > 0, 'the postinstall\'s helper block moved: re-aim this test')
  const block = post.slice(start, post.indexOf('\nfi\n', start) + 4)
  assert.match(block, /mv -f "\$HELPER_DEST\.new" "\$HELPER_DEST"/)
  const src = join(s.dir, 'bundled-helper')
  writeFileSync(src, 'helper v2')
  await run('sh', ['-ec', block], { env: { ...s.env, HELPER_SRC: src, HELPER_DEST: s.target } })
  assert.equal(readFileSync(s.target, 'utf-8'), 'helper v2')
})

test('[PH-6] the unit keeps /run/katacomb-vpn across the restart every upgrade runs', () => {
  const unit = read('resources/linux/privileged/katacomb-vpn-daemon.service')
  const service = unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'))
  const keys = Object.fromEntries(service.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)))
  assert.equal(keys.RuntimeDirectory, 'katacomb-vpn')
  assert.equal(keys.RuntimeDirectoryPreserve, 'restart', 'without it every upgrade wiped tun.state and openvpn.pid, stranding routes')
  assert.match(read('resources/linux/packaging/postinstall.sh'), /systemctl (try-)?restart katacomb-vpn-daemon/, 'the restart it has to survive')
})
