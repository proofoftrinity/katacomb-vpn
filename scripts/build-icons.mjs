// Generate the app's PNG icon set from build/icons/1024x1024.svg, plus the
// per-state tray variants in build/tray/.
//
// This script exists because Electron's nativeImage cannot decode SVG at all,
// so every OS-level icon (window/taskbar, tray, About) must be a PNG.
//
// Run: node scripts/build-icons.mjs

import sharp from 'sharp'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'build/icons')
const SOURCE = join(iconDir, '1024x1024.svg')

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]

// Tray variants live OUTSIDE build/icons/ on purpose: `linux.icon` in
// electron-builder.yml points at that directory and derives the launcher/desktop
// icon set from the PNGs it finds, so a tray 32x32 sitting there risks being
// shipped as the app's launcher icon.
const trayDir = join(root, 'build/tray')

// Fraction of the canvas the icon should occupy. 0.88 keeps a small breathing
// margin — icons that bleed to the edge look clipped in docks.
const GLYPH_SCALE = 0.88

// The tray sits directly among flat OS status icons (network/volume/bell), which
// carry noticeably more internal padding than a dock icon — at GLYPH_SCALE the
// tray glyph visibly out-sized its neighbors. 0.68 was picked to close that gap.
const TRAY_GLYPH_SCALE = 0.68

/** Render the icon at one size: trim the empty margin, then re-pad evenly. */
async function renderSize(svg, size, scale = GLYPH_SCALE) {
  const glyphPx = Math.round(size * scale)
  // Rasterize large, trim to the ink, then downscale — trimming a small render
  // would quantize the bounds and wobble between sizes.
  const trimmed = await sharp(Buffer.from(svg), { density: 384 })
    .resize(1024, 1024)
    .png()
    .trim({ threshold: 1 })
    .resize(glyphPx, glyphPx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()

  const pad = size - glyphPx
  const left = Math.floor(pad / 2)
  const top = Math.floor(pad / 2)
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: trimmed, left, top }])
    .png()
    .toBuffer()
}

// --- Tray icon: the K, filled to show the state -------------------------------
//
// The launcher icon (rounded white tile, two-tone bronze gradient) is a branded
// card meant for docks. Sitting in a system tray next to flat single-color
// glyphs (network/volume/bell), that treatment reads as a heavier, brighter
// "sticker" than its neighbors — verified against real light- and dark-panel
// screenshots. The tray gets its own, plainer rendering instead: no background
// tile, no gradient, just the K+keyhole shape as one flat color — matching how
// the OS's own tray icons are single-color silhouettes that invert between
// light and dark panels.

/** The source's two shapes, the K (st1) and the keyhole (st0). The keyhole sits
 *  inside the K, poking past its bottom edge by a sliver, so a one-colour
 *  silhouette fills both; the outline traces the K. */
function trayPaths(svg) {
  const d = (cls) => svg.match(new RegExp(`<path class="${cls}" d="([^"]+)"`))[1]
  return { k: d('st1'), keyhole: d('st0') }
}

// 32 is what the tray actually loads; 256 is trayImage()'s empty-file fallback.
const TRAY_SIZES = [32, 256]

// The tray icon has to say disconnected / connecting / connected / blocked at
// 16-24px on a panel whose background we don't control. How FULL the K is carries
// that: an outline, the lower part filled, solid, and solid with a slash cut through
// it, distinguishable in pure greyscale. Colour only reinforces it.
//
// Colour alone was put on a contact sheet (2026-10-10) and fails: simulated for the
// strongest red-green colour blindness, the green and the red K differ by ΔE 8 on a
// dark panel (the same colour), and amber and green are equally bright, so in
// greyscale "reconnecting" (the tunnel is down) looked exactly like "connected".
// Before that the state was a dot/ring badge on a solid K: 5.5px wide at 22px, and
// a dot on an app icon reads as "something needs your attention".
//
// Disconnected gets no colour and no red. It is this app's normal resting state
// (you are disconnected whenever you aren't paying for a session), and an icon
// that is permanently alarmed is an icon nobody reads. Red is kept for the one
// state that has actually gone wrong: the kill switch still blocking all traffic
// with no tunnel up.
//
// Colours are keyed by the PANEL they're for, swapped at runtime by the tray's own
// dark/light-panel detection (see trayPanel in src/main/index.ts). Disconnected is
// the app's primary-text pair (tokens.css --color-gunmetal-100 / -950). On a dark
// panel the others are the app's own semantic tokens (--color-warning, --color-success,
// --color-danger), 4.8-7.3:1 there; on a light panel those measure 1.6-2.4:1, under
// the 3:1 graphics need, so it gets darker shades of the same hues (3.9-4.9:1).
const TRAY_STATES = {
  disconnected: { fill: 'outline', dark: '#eeeff2', light: '#101114' },
  connecting: { fill: 'lower', dark: '#f0b429', light: '#a86b00' },
  connected: { fill: 'solid', dark: '#5fd98b', light: '#1e8a4c' },
  blocked: { fill: 'slashed', dark: '#f5767c', light: '#c62f37' },
}

// Geometry in the source SVG's units (a 1024 viewBox). The K is ~808 of them tall
// and shows ~15px tall in a 22px panel slot, so 90 units is ~1.7px. Each was picked
// on the contact sheet at 16, 22 and 24px.
const OUTLINE = 90 // stroke width, inside the K's edge
const LOWER_FILL = 0.46 // of the K's height, from its bottom; leaves a clear gap above at 16px
// The blocked cut is a '/' through the K's bottom-left corner. At 48° (a touch steeper
// than the box's own diagonal) it leaves the arm's tip as a separate piece, so it reads
// as a K cut through; a '\' runs parallel to the K's own leg and reads as a different
// shape, not as a slash.
const SLASH = 130 // width of the cut
const SLASH_ANGLE = 48 // degrees above horizontal

/** The K's ink box in a 1024px render: every state is cropped to it, so the icon
 *  does not move or resize when the state changes (a slash would shrink a trim). */
async function trayBox(paths) {
  const { info } = await sharp(traySvg(paths, null, 'solid', '#000')).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true })
  return { left: -info.trimOffsetLeft, top: -info.trimOffsetTop, width: info.width, height: info.height }
}

/** One state as a 1024px SVG. */
function traySvg({ k, keyhole }, box, fill, color) {
  const solid = `<path d="${k}" fill="${color}"/><path d="${keyhole}" fill="${color}"/>`
  const outline = `<path d="${k}" fill="none" stroke="${color}" stroke-width="${2 * OUTLINE}" clip-path="url(#k)"/>`
  let defs = `<clipPath id="k"><path d="${k}"/><path d="${keyhole}"/></clipPath>`
  let body
  if (fill === 'solid') body = solid
  else if (fill === 'outline') body = outline
  else if (fill === 'lower') {
    const y = box.top + box.height * (1 - LOWER_FILL)
    body = `${outline}<rect y="${y}" width="1024" height="1024" fill="${color}" clip-path="url(#k)"/>`
  } else {
    const a = (SLASH_ANGLE * Math.PI) / 180
    const [x, y, dx, dy] = [box.left, box.top + box.height, 1500 * Math.cos(a), 1500 * Math.sin(a)]
    defs += `<mask id="cut"><rect width="1024" height="1024" fill="#fff"/><line x1="${x - dx}" y1="${y + dy}" ` +
      `x2="${x + dx}" y2="${y - dy}" stroke="#000" stroke-width="${SLASH}"/></mask>`
    body = `<g mask="url(#cut)">${solid}</g>`
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><defs>${defs}</defs>${body}</svg>`)
}

/** One tray icon: the state's K, cropped to the K's box and padded like renderSize. */
async function renderTrayIcon(paths, box, size, state, panel) {
  const { fill, [panel]: color } = TRAY_STATES[state]
  const glyphPx = Math.round(size * TRAY_GLYPH_SCALE)
  const glyph = await sharp(traySvg(paths, box, fill, color))
    .extract(box)
    .resize(glyphPx, glyphPx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  const pad = Math.floor((size - glyphPx) / 2)
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: glyph, left: pad, top: pad }])
    .png()
    .toBuffer()
}

const svg = readFileSync(SOURCE, 'utf-8')

for (const size of SIZES) {
  const png = await renderSize(svg, size)
  writeFileSync(join(iconDir, `${size}x${size}.png`), png)
}
console.log(`${SIZES.length} sizes -> build/icons/`)

mkdirSync(trayDir, { recursive: true })
const paths = trayPaths(svg)
const box = await trayBox(paths)
let trayCount = 0
// Filenames are keyed by the PANEL the variant is for, not the ink used, so the
// runtime pick (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') maps to a
// filename with no inversion to get backwards.
for (const panel of ['light', 'dark']) {
  for (const size of TRAY_SIZES) {
    for (const state of Object.keys(TRAY_STATES)) {
      writeFileSync(join(trayDir, `${state}-${panel}-${size}x${size}.png`), await renderTrayIcon(paths, box, size, state, panel))
      trayCount++
    }
  }
}
console.log(`${trayCount} tray icons -> build/tray/`)
