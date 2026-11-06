import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scripts/ship.sh RUN in a throwaway repo, with the tools it calls stood in for: the
// cut (release.sh) only commits and tags, and gh, sudo and dpkg-query answer as a
// machine would. Each run stops at the phase under test, and nothing installs.

/** A git repo on main with v1.0.0 tagged and 1.1.0's notes committed, plus stand-ins on PATH. */
function fixture(t: { after: (fn: () => void) => void }, opts: { packagingChange: boolean }): { repo: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'kv-ship-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(bin)
  const tool = (path: string, body: string): void => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755) }
  copyFileSync('scripts/ship.sh', join(repo, 'scripts', 'ship.sh'))
  chmodSync(join(repo, 'scripts', 'ship.sh'), 0o755)
  tool(join(repo, 'scripts', 'release.sh'), 'git commit -q --allow-empty -m "Release v$1" && git tag "v$1"')
  tool(join(bin, 'gh'), 'exit 0')
  // sudo: the credentials phase's `sudo -v` passes, and the install itself is refused.
  tool(join(bin, 'sudo'), 'case "$1" in -v|-n) exit 0 ;; esac; exit 1')
  // ship.sh keeps sudo warm in a background `while sleep 60` loop: a real sleep would
  // outlive the script and hold its output open for a minute.
  tool(join(bin, 'sleep'), 'exit 1')
  // A package removed but not purged (dpkg state rc): dpkg still reports its version.
  tool(join(bin, 'dpkg-query'), `for a; do case "$a" in -f=*) fmt="\${a#-f=}" ;; esac; done
printf '%s' "$fmt" | sed 's/\\\${db:Status-Abbrev}/rc /; s/\\\${Version}/1.0.0/'`)

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    XDG_RUNTIME_DIR: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  }
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' }) }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'electron-builder.yml'), 'appId: one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Release v1.0.0')
  git('tag', 'v1.0.0')
  if (opts.packagingChange) {
    writeFileSync(join(repo, 'electron-builder.yml'), 'appId: two\n')
    git('commit', '-q', '-am', 'Change the packaging')
  }
  writeFileSync(join(repo, 'RELEASE_NOTES.md'), '# Katacomb VPN 1.1.0\n')
  git('add', 'RELEASE_NOTES.md')
  git('commit', '-q', '-m', 'Update release notes for 1.1.0')
  return { repo, env }
}

/** Runs ship.sh 1.1.0 with `answer` on stdin, resolving when the script itself exits. */
function ship(f: { repo: string; env: NodeJS.ProcessEnv }, answer: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(f.repo, 'scripts', 'ship.sh'), ['1.1.0'], { cwd: f.repo, env: f.env })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.end(answer)
  })
}

test('ship.sh measures packaging from the previous tag on the run that cuts the release', async (t) => {
  const f = fixture(t, { packagingChange: true })
  const { code, out } = await ship(f, 'n\n')
  // Before, the comparison ran from the tag just cut to HEAD, which is no range at all,
  // so every cutting run read "unchanged" and skipped the portability question.
  assert.doesNotMatch(out, /unchanged since v1\.1\.0/)
  assert.match(out, /packaging changed since v1\.0\.0/)
  assert.match(out, /stopping so you can run it/)
  assert.equal(code, 1)
})

test('ship.sh reads a removed package whose config files remain as not installed', async (t) => {
  const f = fixture(t, { packagingChange: false })
  mkdirSync(join(f.repo, 'dist'))
  writeFileSync(join(f.repo, 'dist', 'katacomb-vpn_1.1.0_amd64.deb'), '')
  const { code, out } = await ship(f, '')
  assert.match(out, /packaging unchanged since v1\.0\.0/)
  assert.match(out, /installed: none, want: 1\.1\.0/)
  assert.match(out, /installing the deb failed/)
  assert.equal(code, 1)
})
