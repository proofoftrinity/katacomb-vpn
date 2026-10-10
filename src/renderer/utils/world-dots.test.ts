import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { geoCentroid } from 'd3-geo'
import { DENSITY_STEPS, densityStep, dotMap } from './world-dots.ts'
import { polyCode } from './country-codes.ts'

const geojson = fileURLToPath(new URL('../assets/world-countries-110m.geojson', import.meta.url))
const world = JSON.parse(readFileSync(geojson, 'utf8')).features as Parameters<typeof dotMap>[0]['world']

// No polygon in the 110m file at all, so these only reach the map as points.
const SMALL: Record<string, [number, number]> = { sg: [103.82, 1.35], hk: [114.17, 22.32], mo: [113.55, 22.17] }
const byCode = new Map(world.map((f) => [polyCode(f), f]))
const pointOf = (code: string): [number, number] | null => {
  const f = byCode.get(code)
  return f ? (geoCentroid(f) as [number, number]) : SMALL[code] ?? null
}
const map = dotMap({ world, codeOf: polyCode, pointOf, extraCodes: Object.keys(SMALL), width: 640, pitch: 5 })
const dotsOf = (code: string) => map.dots.filter((d) => d.code === code).length

test('every country in the world file, and every small one, gets at least one dot', () => {
  const codes = [...new Set(world.map(polyCode))].filter((c) => c && c !== 'aq')
  const missing = [...codes, ...Object.keys(SMALL)].filter((c) => dotsOf(c) === 0)
  assert.deepEqual(missing, [])
  // Too small to catch a grid dot, so each was given the nearest cell, without
  // taking a neighbour's only one (Belgium's, for the Netherlands) or a cell another
  // small country was already given (Israel's and Montenegro's went that way).
  for (const code of ['nl', 'be', 'il', 'me', 'sg']) assert.ok(dotsOf(code) >= 1, code)
})

test('Antarctica is left out and the frame is cropped to the dots, so the map lines up with the text beside it', () => {
  assert.equal(dotsOf('aq'), 0)
  const xs = map.dots.map((d) => d.x)
  const ys = map.dots.map((d) => d.y)
  // Half a pitch of margin on every side, no more: the tip of Chukotka past the
  // antimeridian used to leave a dotless ninth of the width on the left.
  assert.deepEqual([Math.min(...xs), Math.min(...ys)], [2.5, 2.5])
  assert.deepEqual([Math.max(...xs) + 2.5, Math.max(...ys) + 2.5], [map.width, map.height])
  // A large country is a field of dots, not a scatter.
  assert.ok(dotsOf('us') > 100 && dotsOf('ru') > 100)
})

test('the density steps are the legend: each label starts where its step does', () => {
  assert.equal(densityStep(0), 0)
  DENSITY_STEPS.forEach((s, i) => {
    assert.equal(densityStep(s.min), i + 1, s.label)
    assert.equal(densityStep(s.min - 1), i, s.label)
    assert.ok(s.label.startsWith(String(s.min)), s.label)
  })
  assert.equal(densityStep(492), 3)
})
