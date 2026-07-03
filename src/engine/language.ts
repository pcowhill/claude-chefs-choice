import { Rng, mulberry32, pick, hash2 } from './rng'

/**
 * A tiny constructed-language engine. Each survey seeds one phonology —
 * a consonant/vowel inventory and syllable habits — so every name on a
 * chart sounds like it belongs to the same coast. Proper names are
 * invented; feature words (Cape, Sound, Bank…) stay in the surveyor's
 * English, the way colonial-era charts mixed tongues.
 */

export interface Language {
  /**
   * A proper name seeded by stable coordinates — islands keep their names
   * as tides move. minLen re-rolls deterministically until the name has
   * enough weight for the object it names (seas deserve two syllables).
   */
  properAt(x: number, y: number, minLen?: number): string
  proper(rng: Rng): string
  surveyorName(rng: Rng): string
  shipName(rng: Rng): string
}

const ONSETS_POOL = [
  ['k', 't', 'n', 'm', 'r', 's', 'v', 'l', 'th', 'd'],
  ['b', 'g', 'm', 'n', 'l', 'r', 'z', 'v', 'dr', 'gr'],
  ['s', 'sk', 'st', 'k', 'h', 'f', 'r', 'n', 'thr', 'l'],
  ['p', 't', 'k', 'm', 'n', 'w', 'l', 'h', 'kw', 'ts'],
  ['m', 'n', 'ng', 'k', 't', 'r', 'y', 'w', 's', 'h'],
]
const VOWELS_POOL = [
  ['a', 'e', 'i', 'o', 'u'],
  ['a', 'o', 'u', 'ei', 'ai'],
  ['e', 'i', 'a', 'ou', 'ea'],
  ['a', 'i', 'o', 'aa', 'io'],
  ['o', 'e', 'y', 'a', 'oe'],
]
const CODAS_POOL = [
  ['n', 'r', 'l', 's', 'th', ''],
  ['k', 'm', 'nd', 'r', '', ''],
  ['s', 'st', 'n', 'l', '', ''],
  ['ng', 'n', 'k', '', '', ''],
  ['r', 'rn', 'l', 'd', '', ''],
]

const SURVEYOR_FIRST = ['J.', 'W.', 'H.', 'E.', 'A.', 'T.', 'G.', 'R.', 'F.', 'C.']
const SURVEYOR_LAST = [
  'Fairweather', 'Quill', 'Harrowgate', 'Mercer', 'Bellhouse', 'Stroud',
  'Antram', 'Culverwell', 'Grieve', 'Pennywhistle', 'Loxley', 'Marchmont',
  'Ashdown', 'Tremayne', 'Wolcott', 'Ferrers',
]
const SHIP_ADJ = ['Resolute', 'Diligent', 'Vigilant', 'Peregrine', 'Meridian', 'Perseverance', 'Aurora', 'Halcyon', 'Intrepid', 'Cormorant']

export function makeLanguage(seed: number): Language {
  const base = mulberry32(seed ^ 0x1a2b3c)
  const family = Math.floor(base() * ONSETS_POOL.length)
  const onsets = ONSETS_POOL[family]
  const vowels = VOWELS_POOL[(family + Math.floor(base() * 2)) % VOWELS_POOL.length]
  const codas = CODAS_POOL[(family + Math.floor(base() * 3)) % CODAS_POOL.length]
  // Per-language habits
  const codaChance = 0.3 + base() * 0.4
  const maxSyl = base() < 0.35 ? 2 : 3

  const syllable = (r: Rng, final: boolean): string => {
    let s = pick(r, onsets) + pick(r, vowels)
    if (r() < (final ? codaChance + 0.25 : codaChance * 0.5)) s += pick(r, codas)
    return s
  }

  const word = (r: Rng): string => {
    const n = 1 + Math.floor(r() * maxSyl)
    let w = ''
    for (let i = 0; i < n; i++) w += syllable(r, i === n - 1)
    // Tidy: collapse triples, cap length
    w = w.replace(/(.)\1\1+/g, '$1$1')
    if (w.length > 9) w = w.slice(0, 9).replace(/[^aeiouy]+$/, (m) => m[0] ?? '')
    if (w.length < 3) w += pick(r, vowels) + pick(r, codas)
    return w.charAt(0).toUpperCase() + w.slice(1)
  }

  return {
    proper: (r: Rng) => word(r),
    properAt(x: number, y: number, minLen = 0) {
      for (let salt = 0; salt < 4; salt++) {
        const r = mulberry32(hash2(Math.round(x / 2), Math.round(y / 2), seed ^ (0x9e37 + salt * 0x51ed)))
        const w = word(r)
        if (w.length >= minLen || salt === 3) return w
      }
      return word(mulberry32(hash2(Math.round(x / 2), Math.round(y / 2), seed ^ 0x9e37)))
    },
    surveyorName(r: Rng) {
      return `${pick(r, SURVEYOR_FIRST)} ${pick(r, SURVEYOR_LAST)}`
    },
    shipName(r: Rng) {
      return pick(r, SHIP_ADJ)
    },
  }
}

/** Roman numerals for sheet numbers. */
export function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ]
  let out = ''
  let v = Math.max(1, Math.round(n))
  for (const [num, sym] of table) {
    while (v >= num) {
      out += sym
      v -= num
    }
  }
  return out
}
