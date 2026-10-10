import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { countryCode, countryName, polyCode } from './country-codes.ts'

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))

// Every country name api.sentnodes.com reported on 2026-10-10 (2,813 nodes). The old
// hand-kept list had no flag for 21 of them: Angola, Bhutan, Cameroon, Chad, Comoros,
// Eritrea, Ivory Coast, Kosovo, Mauritania, Mauritius, Mozambique, Oman, Rwanda, South
// Sudan, Sudan, Syria, Tajikistan, Tanzania, Togo, Turkmenistan and Yemen.
const FEED_2026_10_10 = [
  'Afghanistan', 'Albania', 'Algeria', 'Angola', 'Argentina', 'Armenia', 'Australia',
  'Austria', 'Azerbaijan', 'Bahrain', 'Belarus', 'Belgium', 'Bhutan', 'Brazil', 'Brunei',
  'Bulgaria', 'Cambodia', 'Cameroon', 'Canada', 'Chad', 'Chile', 'Colombia', 'Comoros',
  'Congo (DRC)', 'Costa Rica', 'Croatia', 'Czech Republic', 'Denmark', 'Dominica',
  'Ecuador', 'Egypt', 'El Salvador', 'Eritrea', 'Estonia', 'Ethiopia', 'Finland', 'France',
  'Georgia', 'Germany', 'Ghana', 'Greece', 'Guatemala', 'Honduras', 'Hong Kong', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast',
  'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kosovo', 'Kuwait', 'Laos', 'Latvia', 'Libya',
  'Lithuania', 'Macau', 'Malaysia', 'Malta', 'Mauritania', 'Mauritius', 'Mexico',
  'Moldova', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Nepal', 'Netherlands',
  'New Zealand', 'Norway', 'Oman', 'Pakistan', 'Peru', 'Philippines', 'Poland', 'Portugal',
  'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saudi Arabia', 'Senegal', 'Serbia', 'Singapore',
  'Slovakia', 'Slovenia', 'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain',
  'Sri Lanka', 'Sudan', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan',
  'Tanzania', 'Thailand', 'Togo', 'Tunisia', 'Turkey', 'Turkmenistan', 'Ukraine',
  'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan',
  'Venezuela', 'Vietnam', 'Yemen',
]

const hasFlag = (code: string) => existsSync(repo(`node_modules/flag-icons/flags/4x3/${code}.svg`))

test('[RN-11] every country the node feed reported resolves to a flag that flag-icons ships', () => {
  for (const name of FEED_2026_10_10) {
    const code = countryCode(name)
    assert.ok(code, `${name} has no code`)
    assert.ok(hasFlag(code), `${name} -> ${code} has no flag-icons SVG`)
  }
})

test('[RN-11] every ISO country and Kosovo resolves under its flag-icons name and its CLDR name', () => {
  // Countries the feed has not reported yet: these are the spellings the next one is
  // most likely to arrive in.
  const listed = (JSON.parse(readFileSync(repo('node_modules/flag-icons/country.json'), 'utf8')) as
    { code: string; name: string; iso: boolean }[]).filter((c) => c.iso || c.code === 'xk')
  assert.equal(listed.length, 250)
  const cldr = new Intl.DisplayNames(['en'], { type: 'region' })
  for (const { code, name } of listed) {
    assert.equal(countryCode(name), code, `flag-icons "${name}"`)
    const cldrName = cldr.of(code.toUpperCase()) ?? ''
    assert.equal(countryCode(cldrName), code, `CLDR "${cldrName}"`)
    assert.equal(countryCode(countryName(code) ?? ''), code, `shown name for ${code}`)
    assert.ok(hasFlag(code), `${code} has no flag-icons SVG`)
  }
})

test('[RN-11] the maps find every reported country by code, whatever the world file calls it', () => {
  const features = (JSON.parse(readFileSync(repo('src/renderer/assets/world-countries-110m.geojson'), 'utf8')) as
    { features: { properties?: { name?: string } }[] }).features
  const codes = features.map(polyCode)
  // The only polygons that are no ISO country; they stay unlit.
  assert.deepEqual(features.filter((_, i) => codes[i] === '').map((f) => f.properties?.name).sort(), ['N. Cyprus', 'Somaliland'])
  const drawn = codes.filter((c) => c !== '')
  assert.equal(new Set(drawn).size, drawn.length, 'two polygons share a code')

  // The world file says "Turkey" and "Dem. Rep. Congo"; the feed says "Turkey" and
  // "Congo (DRC)". The rename table this replaced lost both.
  const unplaced = FEED_2026_10_10.filter((name) => !drawn.includes(countryCode(name) ?? ''))
  // Too small for the 110m file: world-geo's SMALL_COUNTRIES draws these as dots.
  assert.deepEqual(unplaced, ['Bahrain', 'Comoros', 'Dominica', 'Hong Kong', 'Macau', 'Malta', 'Mauritius', 'Singapore'])
})

test('[RN-11] spellings match whatever their case, accents, punctuation, "&", "St." or "the"', () => {
  for (const [name, code] of [
    ['TÜRKIYE', 'tr'], ['Turkiye', 'tr'], ['Cote d’Ivoire', 'ci'], ['Congo [DRC]', 'cd'],
    ['Congo, The Democratic Republic of the', 'cd'], ['Congo', 'cg'], ['Bosnia & Herzegovina', 'ba'],
    ['St. Vincent & Grenadines', 'vc'], ['St Kitts and Nevis', 'kn'], ['The Netherlands', 'nl'],
    ['Korea (Republic of)', 'kr'], ['Virgin Islands, U.S.', 'vi'], ['  south   sudan ', 'ss'],
  ] as const) {
    assert.equal(countryCode(name), code, name)
  }
  for (const name of ['', 'Atlantis', 'N. Cyprus', 'Europe']) {
    assert.equal(countryCode(name), undefined, name)
  }
})
