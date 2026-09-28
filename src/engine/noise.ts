import { hash2 } from './rng'

/**
 * Smooth value noise over a hashed integer lattice, with fBm and domain
 * warping built on top. Grid-free and infinite: the same (x, y, seed)
 * always yields the same height, which is what lets the survey pan to
 * adjacent sheets of the same ocean.
 */

const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

function lattice(ix: number, iy: number, seed: number): number {
  return hash2(ix, iy, seed) / 4294967296
}

export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const u = quintic(fx)
  const v = quintic(fy)
  const a = lattice(ix, iy, seed)
  const b = lattice(ix + 1, iy, seed)
  const c = lattice(ix, iy + 1, seed)
  const d = lattice(ix + 1, iy + 1, seed)
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1
}

/** Rotation between octaves breaks up axis-aligned artifacts. */
const COS_R = Math.cos(2.4)
const SIN_R = Math.sin(2.4)

export function fbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  lacunarity = 2.02,
  gain = 0.5,
): number {
  let amp = 0.5
  let sum = 0
  let norm = 0
  let px = x
  let py = y
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(px, py, seed + i * 1013)
    norm += amp
    const nx = px * COS_R - py * SIN_R
    const ny = px * SIN_R + py * COS_R
    px = nx * lacunarity + 31.7
    py = ny * lacunarity - 17.3
    amp *= gain
  }
  return sum / norm
}

/** Ridged multifractal — sharp crests for mountain spines. Returns [0, 1]. */
export function ridged(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.55
  let sum = 0
  let norm = 0
  let px = x
  let py = y
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(px, py, seed + 733 + i * 419))
    sum += amp * n * n
    norm += amp
    const nx = px * COS_R - py * SIN_R
    const ny = px * SIN_R + py * COS_R
    px = nx * 2.13 + 11.1
    py = ny * 2.13 - 7.7
    amp *= 0.52
  }
  return sum / norm
}

/** Domain warp: displace the sample point by two low-frequency fbm fields. */
export function warp2(
  x: number,
  y: number,
  seed: number,
  freq: number,
  amp: number,
): [number, number] {
  const wx = fbm(x * freq + 5.2, y * freq + 1.3, seed + 4177, 3)
  const wy = fbm(x * freq - 3.1, y * freq + 8.6, seed + 9241, 3)
  return [x + wx * amp, y + wy * amp]
}
