import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HELP_GROUPS, HELP_TOPICS, type TopicId } from './help-topics.ts'

test('[RN-15] every Help topic is in the index exactly once, and the index names no missing topic', () => {
  const listed = HELP_GROUPS.flatMap((g) => g.topics)
  assert.deepEqual([...listed].sort(), Object.keys(HELP_TOPICS).sort())
  assert.equal(new Set(listed).size, listed.length)
})

test('[RN-15] every topic has a title and words, and links only to topics that exist', () => {
  for (const [id, t] of Object.entries(HELP_TOPICS) as [TopicId, (typeof HELP_TOPICS)[TopicId]][]) {
    assert.ok(t.title.trim().length > 0, `${id}: no title`)
    assert.ok(t.body.length > 0 && t.body.every((p) => p.trim().length > 0), `${id}: no body`)
    for (const r of t.related) {
      assert.ok(r in HELP_TOPICS, `${id} links to ${r}, which does not exist`)
      assert.notEqual(r, id, `${id} links to itself`)
    }
  }
})

test('[RN-15] no em dashes in the Help panel (docs/renderer.md)', () => {
  const words = Object.values(HELP_TOPICS).flatMap((t) => [t.title, ...t.body]).concat(HELP_GROUPS.map((g) => g.title))
  assert.deepEqual(words.filter((w) => w.includes('—')), [])
})
