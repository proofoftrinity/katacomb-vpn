import { useEffect, useState } from 'react'
import { geoArea, geoCentroid } from 'd3-geo'
import type { Feature, MultiPolygon, Polygon } from 'geojson'
import geoUrl from '../../assets/world-countries-110m.geojson?url'

// The world file the two small maps share: the Multi-hop route bar's RouteMap and the
// Plans tab's coverage map. Drawn as SVG with d3-geo, never WebGL (docs/renderer.md).

export type Country = Feature<Polygon | MultiPolygon, { name?: string }>

/** Loaded once per process, as the Map tab's globe does with the same file. */
let worldCache: Country[] | null = null

/** The countries, or null until the file has loaded (or if it failed: callers draw nothing). */
export function useWorldCountries(): Country[] | null {
  const [world, setWorld] = useState<Country[] | null>(worldCache)
  useEffect(() => {
    if (worldCache) return
    let cancelled = false
    fetch(geoUrl)
      .then((r) => r.json() as Promise<{ features?: Country[] }>)
      .then((data) => {
        worldCache = data.features ?? []
        if (!cancelled) setWorld(worldCache)
      })
      .catch(() => {
        // An empty frame: every caller states the same facts in words beside it.
      })
    return () => { cancelled = true }
  }, [])
  return world
}

/**
 * Countries too small for the 110m file, which has no polygon for them, by country
 * code (utils/country-codes.ts). Singapore and Hong Kong are common node locations, so
 * without these a map would lose them.
 */
export const SMALL_COUNTRIES: Record<string, [number, number]> = {
  sg: [103.82, 1.35], // Singapore
  hk: [114.17, 22.32], // Hong Kong
  mo: [113.55, 22.17], // Macau
  mt: [14.45, 35.9], // Malta
  bh: [50.56, 26.07], // Bahrain
  mc: [7.42, 43.74], // Monaco
  ad: [1.52, 42.51], // Andorra
  li: [9.55, 47.16], // Liechtenstein
  mu: [57.55, -20.25], // Mauritius
  mv: [73.5, 4.2], // Maldives
  sc: [55.45, -4.62], // Seychelles
  km: [43.33, -11.7], // Comoros
  dm: [-61.37, 15.41], // Dominica
}

/**
 * Where a country is drawn as a point: the centroid of its LARGEST polygon. A plain
 * geoCentroid of the whole shape puts France in the Atlantic (French Guiana is part of
 * it), and the United States and Norway drift the same way.
 */
export function countryPoint(code: string, byCode: Map<string, Country>): [number, number] | null {
  const f = byCode.get(code)
  if (!f) return SMALL_COUNTRIES[code] ?? null
  const g = f.geometry
  const largest = g.type === 'Polygon'
    ? g
    : g.coordinates
      .map((c): Polygon => ({ type: 'Polygon', coordinates: c }))
      .reduce((a, b) => (geoArea(b) > geoArea(a) ? b : a))
  return geoCentroid(largest)
}
