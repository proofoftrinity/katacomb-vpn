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
 * Countries too small for the 110m file, which has no polygon for them. Singapore and
 * Hong Kong are common node locations, so without these a map would lose them.
 */
export const SMALL_COUNTRIES: Record<string, [number, number]> = {
  Singapore: [103.82, 1.35],
  'Hong Kong': [114.17, 22.32],
  Macau: [113.55, 22.17],
  Malta: [14.45, 35.9],
  Bahrain: [50.56, 26.07],
  Monaco: [7.42, 43.74],
  Andorra: [1.52, 42.51],
  Liechtenstein: [9.55, 47.16],
  Mauritius: [57.55, -20.25],
  Maldives: [73.5, 4.2],
  Seychelles: [55.45, -4.62],
}

/**
 * Where a country is drawn as a point: the centroid of its LARGEST polygon. A plain
 * geoCentroid of the whole shape puts France in the Atlantic (French Guiana is part of
 * it), and the United States and Norway drift the same way.
 */
export function countryPoint(country: string, byName: Map<string, Country>): [number, number] | null {
  const f = byName.get(country)
  if (!f) return SMALL_COUNTRIES[country] ?? null
  const g = f.geometry
  const largest = g.type === 'Polygon'
    ? g
    : g.coordinates
      .map((c): Polygon => ({ type: 'Polygon', coordinates: c }))
      .reduce((a, b) => (geoArea(b) > geoArea(a) ? b : a))
  return geoCentroid(largest)
}
