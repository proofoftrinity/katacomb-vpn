import { geoNaturalEarth1, geoPath } from 'd3-geo'
import type { Feature, MultiPolygon, Polygon } from 'geojson'

// The welcome screen's world map: the land drawn as an even grid of dots, each dot
// tagged with the country it falls in so it can be lit by that country's node count.
// Plain SVG circles, never WebGL [RN-4]. No sibling import [RN-5]: the caller passes
// the polygon-to-code rule (`polyCode`) and the country points (`countryPoint`).

type Country = Feature<Polygon | MultiPolygon, { name?: string }>

export interface LandDot {
  x: number
  y: number
  /** The ISO code of the country the dot falls in, or '' for a polygon with no code. */
  code: string
}

export interface DotMap {
  width: number
  height: number
  dots: LandDot[]
}

interface Options {
  world: Country[]
  codeOf: (f: Country) => string
  /** Where a country is drawn as a point (`countryPoint`), for the ones too small to catch a grid dot. */
  pointOf: (code: string) => [number, number] | null
  /** Countries the world file has no polygon for (`SMALL_COUNTRIES`), which get a dot all the same. */
  extraCodes: string[]
  width: number
  /** The grid spacing, in map units. */
  pitch: number
}

type Ring = [number, number][]

/**
 * Each country's outline in MAP space, read off d3's own path renderer so the
 * antimeridian is already cut: projecting the vertices by hand would draw Russia and
 * Fiji as bands across the whole map.
 */
function projectedRings(path: ReturnType<typeof geoPath>, f: Country): Ring[] {
  const rings: Ring[] = []
  let ring: Ring = []
  path.context({
    moveTo(x: number, y: number) { ring = [[x, y]]; rings.push(ring) },
    lineTo(x: number, y: number) { ring.push([x, y]) },
    closePath() {},
    arc() {},
  } as unknown as CanvasRenderingContext2D)(f)
  return rings
}

/** Even-odd over every ring, so a lake or an enclave is a hole. */
function inRings(rings: Ring[], x: number, y: number): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i]
      const [xj, yj] = r[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/**
 * The land as dots `pitch` apart on a grid in MAP space, so they read as an even
 * matrix rather than following the projection's curved meridians. Antarctica is left
 * out (nobody runs a node there) and the map is fitted to the rest, which spends the
 * height on land rather than on the southern ocean.
 *
 * A country too small to catch a grid dot (the Netherlands, Israel, Singapore, which
 * has no polygon at all) still gets one: the grid cell nearest its point is given to
 * it, so a country with nodes is never missing from the map. Two of them never share
 * a cell (Hong Kong and Macau are one cell apart at most widths); the second takes the
 * nearest free one.
 */
export function dotMap({ world, codeOf, pointOf, extraCodes, width, pitch }: Options): DotMap {
  const land = world.filter((f) => codeOf(f) !== 'aq')
  const collection = { type: 'FeatureCollection' as const, features: land }
  const projection = geoNaturalEarth1().fitWidth(width, collection)
  const path = geoPath(projection)
  const height = Math.ceil(path.bounds(collection)[1][1])
  const shapes = land.map((f) => {
    const [[x0, y0], [x1, y1]] = path.bounds(f)
    return { code: codeOf(f), x0, y0, x1, y1, rings: projectedRings(path, f) }
  })

  const cols = Math.floor(width / pitch)
  const rows = Math.floor(height / pitch)
  // By cell index, so a small country can take over a cell.
  const cells = new Map<number, LandDot>()
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = pitch / 2 + col * pitch
      const y = pitch / 2 + row * pitch
      const hit = shapes.find((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1 && inRings(s.rings, x, y))
      if (hit) cells.set(row * cols + col, { x, y, code: hit.code })
    }
  }

  const owned = new Map<string, number>()
  for (const d of cells.values()) owned.set(d.code, (owned.get(d.code) ?? 0) + 1)
  const claimed = new Set<number>()
  const missing = [...new Set([...shapes.map((s) => s.code), ...extraCodes])].filter((c) => c && !owned.has(c))
  for (const code of missing) {
    const lonLat = pointOf(code)
    const xy = lonLat ? projection(lonLat) : null
    if (!xy) continue
    const col0 = Math.round((xy[0] - pitch / 2) / pitch)
    const row0 = Math.round((xy[1] - pitch / 2) / pitch)
    // The nearest cell that no other small country has taken and that is not a
    // neighbour's only dot: the Netherlands must not take Belgium off the map.
    let best: { i: number; x: number; y: number; d: number } | null = null
    for (let row = row0 - 2; row <= row0 + 2; row++) {
      for (let col = col0 - 2; col <= col0 + 2; col++) {
        const i = row * cols + col
        const owner = cells.get(i)?.code
        if (row < 0 || row >= rows || col < 0 || col >= cols || claimed.has(i)) continue
        if (owner !== undefined && owned.get(owner) === 1) continue
        const x = pitch / 2 + col * pitch
        const y = pitch / 2 + row * pitch
        const d = Math.hypot(x - xy[0], y - xy[1])
        if (!best || d < best.d) best = { i, x, y, d }
      }
    }
    if (!best) continue
    const owner = cells.get(best.i)?.code
    if (owner !== undefined) owned.set(owner, owned.get(owner)! - 1)
    claimed.add(best.i)
    cells.set(best.i, { x: best.x, y: best.y, code })
  }

  // Cropped to the dots themselves. The fit counts every sliver of land, and the tip of
  // Chukotka past the antimeridian catches no dot but still widened the frame by a
  // ninth, so the map sat indented from the text beside it.
  const dots = [...cells.values()]
  const x0 = Math.min(...dots.map((d) => d.x)) - pitch / 2
  const y0 = Math.min(...dots.map((d) => d.y)) - pitch / 2
  const cropped = dots.map((d) => ({ ...d, x: d.x - x0, y: d.y - y0 }))
  return {
    width: Math.max(...cropped.map((d) => d.x)) + pitch / 2,
    height: Math.max(...cropped.map((d) => d.y)) + pitch / 2,
    dots: cropped,
  }
}

/**
 * How brightly a country is lit, by how many nodes it holds. The labels are the
 * legend, so the steps and what the legend says cannot drift apart.
 */
export const DENSITY_STEPS = [
  { min: 1, label: '1-4' },
  { min: 5, label: '5-24' },
  { min: 25, label: '25+' },
] as const

/** 0 for a country with no nodes, else 1-3 by DENSITY_STEPS. */
export function densityStep(nodes: number): 0 | 1 | 2 | 3 {
  return nodes >= DENSITY_STEPS[2].min ? 3 : nodes >= DENSITY_STEPS[1].min ? 2 : nodes >= DENSITY_STEPS[0].min ? 1 : 0
}
