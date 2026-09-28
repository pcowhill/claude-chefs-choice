/** Deterministic seeded randomness. Every mark the engine makes flows from one of these. */

export type Rng = () => number

/** mulberry32 — small, fast, good enough for cartography. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer hash (2D + seed) → uint32. Stable basis for infinite worlds. */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = seed >>> 0
  h = Math.imul(h ^ (ix | 0), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13) ^ (iy | 0), 0xc2b2ae35)
  h ^= h >>> 16
  h = Math.imul(h, 0x27d4eb2f)
  h ^= h >>> 15
  return h >>> 0
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export const rangeIn = (r: Rng, a: number, b: number) => a + (b - a) * r()
export const intIn = (r: Rng, a: number, b: number) => Math.floor(rangeIn(r, a, b + 1))
export const pick = <T,>(r: Rng, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]
/** Sum of 3 uniforms → cheap bell curve in [0,1). */
export const bell = (r: Rng) => (r() + r() + r()) / 3

export function shuffle<T>(r: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
