import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic, isOnPath } from './fs-utils.ts'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'fsutil-'))
}

test('writeFileAtomic writes the content', () => {
  const p = join(freshDir(), 'a.json')
  writeFileAtomic(p, '{"x":1}')
  assert.equal(readFileSync(p, 'utf-8'), '{"x":1}')
})

test('writeFileAtomic applies 0o600 perms by default', () => {
  const p = join(freshDir(), 'a.json')
  writeFileAtomic(p, 'secret')
  assert.equal(statSync(p).mode & 0o777, 0o600)
})

test('writeFileAtomic leaves no temp file behind', () => {
  const dir = freshDir()
  writeFileAtomic(join(dir, 'a.json'), 'data')
  assert.deepEqual(readdirSync(dir), ['a.json'])
})

test('writeFileAtomic overwrites an existing file', () => {
  const p = join(freshDir(), 'a.json')
  writeFileAtomic(p, 'old')
  writeFileAtomic(p, 'new')
  assert.equal(readFileSync(p, 'utf-8'), 'new')
})

test('isOnPath finds an executable file in any PATH directory', () => {
  const a = freshDir()
  const b = freshDir()
  writeFileSync(join(b, 'wg-quick'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(isOnPath('wg-quick', `${a}:${b}`), true)
  assert.equal(isOnPath('wg', `${a}:${b}`), false)
})

test('isOnPath ignores non-executable files, directories and empty PATH entries', () => {
  const d = freshDir()
  writeFileSync(join(d, 'plain'), 'x', { mode: 0o644 })
  mkdirSync(join(d, 'adir'))
  assert.equal(isOnPath('plain', d), false)
  assert.equal(isOnPath('adir', d), false)
  assert.equal(isOnPath('plain', `::${d}:`), false)
  assert.equal(isOnPath('anything', ''), false)
})
