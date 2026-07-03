import { fbm, ridged, warp2 } from './noise'
import { hash2, mulberry32, rangeIn } from './rng'

/**
 * The world model. One seed defines an infinite ocean: a warped noise field
 * salted with island "massifs" placed on a hashed lattice, so any window
 * of it can be surveyed — the home archipelago near the origin is
 * guaranteed, everything beyond is honest exploration.
 *
 * World units are nautical miles-ish. x grows east, y grows SOUTH (screen
 * aligned); north is -y. Heights are unitless: 0 is the reference datum.
 */

export interface WorldWindow {
  x0: number
  y0: number
  w: number
  h: number
}

export interface TerrainGrid {
  cols: number
  rows: number
  h: Float32Array
  win: WorldWindow
  dx: number // world units per cell, x
  dy: number
  /** distance (world units) from cell center to nearest land cell; 0 on land */
  distToLand: Float32Array
  seaLevel: number
  quantile: (q: number) => number
}

interface Blob {
  x: number
  y: number
  r: number
  s: number
  // anisotropy
  cos: number
  sin: number
  sq: number
}

const PROVINCE = 96 // archipelago clusters live/die at this scale
const CELL = 20 // one potential massif per cell

export class Terrain {
  readonly seed: number
  private home: Blob[]

  constructor(seed: number) {
    this.seed = seed
    // The home archipelago: always present around the origin so the first
    // sheet is never an empty sea.
    const r = mulberry32(seed ^ 0x5eafa11)
    const home: Blob[] = []
    const n = 4 + Math.floor(r() * 3)
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2
      const d = 4 + r() * 20
      home.push(this.makeBlob(Math.cos(a) * d, Math.sin(a) * d * 0.72, r, 1))
    }
    this.home = home
  }

  private makeBlob(x: number, y: number, r: () => number, boost: number): Blob {
    const ang = r() * Math.PI
    return {
      x,
      y,
      r: rangeIn(r, 5.5, 13.5),
      s: rangeIn(r, 0.6, 1.05) * boost,
      cos: Math.cos(ang),
      sin: Math.sin(ang),
      sq: rangeIn(r, 1.0, 2.4), // squash factor → elongated islands
    }
  }

  private blobAt(cx: number, cy: number): Blob | null {
    // Province gate: does this region of ocean grow islands at all?
    const px = Math.floor((cx * CELL) / PROVINCE)
    const py = Math.floor((cy * CELL) / PROVINCE)
    const pv = hash2(px, py, this.seed ^ 0xa5c39e) / 4294967296
    if (pv > 0.46) return null
    const density = 0.28 + 0.5 * (1 - pv / 0.46)
    const hv = hash2(cx, cy, this.seed ^ 0x1b3d5f) / 4294967296
    if (hv > density) return null
    const r = mulberry32(hash2(cx, cy, this.seed ^ 0x77aa33))
    return this.makeBlob(
      (cx + 0.15 + r() * 0.7) * CELL,
      (cy + 0.15 + r() * 0.7) * CELL,
      r,
      0.92,
    )
  }

  private blobField(x: number, y: number): number {
    let sum = 0
    const cx0 = Math.floor(x / CELL)
    const cy0 = Math.floor(y / CELL)
    for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
      for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
        const b = this.blobAt(cx, cy)
        if (b) sum += blobContribution(b, x, y)
      }
    }
    for (const b of this.home) sum += blobContribution(b, x, y)
    return sum
  }

  /** Continuous height. ~[-0.75, 1.1]; datum near 0. */
  height(x: number, y: number): number {
    const [wx, wy] = warp2(x, y, this.seed, 0.055, 4.6)
    const base = fbm(wx * 0.045, wy * 0.045, this.seed, 4)
    const blobs = this.blobField(wx, wy)
    let h = base * 0.2 - 0.34 + blobs * 0.62
    if (blobs > 0.05) {
      // Mountain spines only where there is a massif to carry them.
      const spine = ridged(wx * 0.13, wy * 0.13, this.seed, 4)
      h += Math.min(blobs, 0.9) * spine * 0.5
    }
    // Coastline character: fine detail, unwarped so it stays crisp.
    h += fbm(x * 0.42, y * 0.42, this.seed + 71, 3) * 0.055
    return h
  }

  sampleGrid(win: WorldWindow, cols: number, rows: number): TerrainGrid {
    const h = new Float32Array(cols * rows)
    const dx = win.w / (cols - 1)
    const dy = win.h / (rows - 1)
    for (let row = 0; row < rows; row++) {
      const y = win.y0 + row * dy
      const base = row * cols
      for (let col = 0; col < cols; col++) {
        h[base + col] = this.height(win.x0 + col * dx, y)
      }
    }
    // Height quantiles for choosing a sane datum on any sheet.
    const sorted = Float32Array.from(h).sort()
    const quantile = (q: number) =>
      sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))]

    const grid: TerrainGrid = {
      cols,
      rows,
      h,
      win,
      dx,
      dy,
      distToLand: new Float32Array(0),
      seaLevel: 0,
      quantile,
    }
    return grid
  }
}

function blobContribution(b: Blob, x: number, y: number): number {
  let dx = x - b.x
  let dy = y - b.y
  // rotate into blob frame, squash → elongated massifs
  const rx = dx * b.cos + dy * b.sin
  const ry = (-dx * b.sin + dy * b.cos) * b.sq
  const d2 = (rx * rx + ry * ry) / (b.r * b.r)
  if (d2 >= 1) return 0
  const t = 1 - d2
  return b.s * t * t
}

/** Default datum for a sheet: a height that keeps land/sea in good balance. */
export function defaultSeaLevel(grid: TerrainGrid): number {
  const q = grid.quantile(0.66)
  return Math.min(0.12, Math.max(-0.05, q))
}

/** Multi-source BFS from land cells → distance to land in world units. */
export function computeDistToLand(grid: TerrainGrid, seaLevel: number): Float32Array {
  const { cols, rows, h } = grid
  const n = cols * rows
  const dist = new Float32Array(n).fill(Infinity)
  const cell = (grid.dx + grid.dy) / 2
  let queue: number[] = []
  for (let i = 0; i < n; i++) {
    if (h[i] >= seaLevel) {
      dist[i] = 0
      queue.push(i)
    }
  }
  // BFS rings (4-neighbour, good enough for placement heuristics)
  let ring = 1
  while (queue.length > 0) {
    const next: number[] = []
    const d = ring * cell
    for (const i of queue) {
      const x = i % cols
      const y = (i / cols) | 0
      if (x > 0 && dist[i - 1] === Infinity) { dist[i - 1] = d; next.push(i - 1) }
      if (x < cols - 1 && dist[i + 1] === Infinity) { dist[i + 1] = d; next.push(i + 1) }
      if (y > 0 && dist[i - cols] === Infinity) { dist[i - cols] = d; next.push(i - cols) }
      if (y < rows - 1 && dist[i + cols] === Infinity) { dist[i + cols] = d; next.push(i + cols) }
    }
    queue = next
    ring++
  }
  for (let i = 0; i < n; i++) if (dist[i] === Infinity) dist[i] = 999
  return dist
}

export interface Island {
  id: number
  cellCount: number
  areaMi2: number
  cx: number // grid coords of centroid
  cy: number
  peakCol: number
  peakRow: number
  peakH: number
  minCol: number
  maxCol: number
  minRow: number
  maxRow: number
}

export function findIslands(grid: TerrainGrid, seaLevel: number): Island[] {
  const { cols, rows, h } = grid
  const n = cols * rows
  const label = new Int32Array(n).fill(-1)
  const islands: Island[] = []
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (h[i] < seaLevel || label[i] !== -1) continue
    const id = islands.length
    const isl: Island = {
      id,
      cellCount: 0,
      areaMi2: 0,
      cx: 0,
      cy: 0,
      peakCol: i % cols,
      peakRow: (i / cols) | 0,
      peakH: h[i],
      minCol: cols,
      maxCol: 0,
      minRow: rows,
      maxRow: 0,
    }
    stack.length = 0
    stack.push(i)
    label[i] = id
    while (stack.length) {
      const j = stack.pop()!
      const x = j % cols
      const y = (j / cols) | 0
      isl.cellCount++
      isl.cx += x
      isl.cy += y
      if (h[j] > isl.peakH) {
        isl.peakH = h[j]
        isl.peakCol = x
        isl.peakRow = y
      }
      if (x < isl.minCol) isl.minCol = x
      if (x > isl.maxCol) isl.maxCol = x
      if (y < isl.minRow) isl.minRow = y
      if (y > isl.maxRow) isl.maxRow = y
      const tryCell = (k: number) => {
        if (label[k] === -1 && h[k] >= seaLevel) {
          label[k] = id
          stack.push(k)
        }
      }
      if (x > 0) tryCell(j - 1)
      if (x < cols - 1) tryCell(j + 1)
      if (y > 0) tryCell(j - cols)
      if (y < rows - 1) tryCell(j + cols)
    }
    isl.cx /= isl.cellCount
    isl.cy /= isl.cellCount
    isl.areaMi2 = isl.cellCount * grid.dx * grid.dy
    islands.push(isl)
  }
  islands.sort((a, b) => b.areaMi2 - a.areaMi2)
  return islands
}

export interface RiverPath {
  pts: number[] // grid coords
  width: number
}

/** Rain flows downhill; enough of it in one place is a river. */
export function riverPaths(grid: TerrainGrid, seaLevel: number): RiverPath[] {
  const { cols, rows, h } = grid
  const n = cols * rows
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  const arr = Array.from(order).sort((a, b) => h[b] - h[a])
  const flow = new Float32Array(n).fill(1)
  const downhill = new Int32Array(n).fill(-1)
  for (const i of arr) {
    if (h[i] < seaLevel) continue
    const x = i % cols
    const y = (i / cols) | 0
    let best = -1
    let bestH = h[i]
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue
        const nx = x + ox
        const ny = y + oy
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
        const j = ny * cols + nx
        if (h[j] < bestH) {
          bestH = h[j]
          best = j
        }
      }
    }
    downhill[i] = best
    if (best >= 0) flow[best] += flow[i]
  }
  // Trace rivers from strong-flow sources down to the sea.
  const threshold = 42
  const used = new Uint8Array(n)
  const rivers: RiverPath[] = []
  const candidates: number[] = []
  for (let i = 0; i < n; i++) {
    if (h[i] < seaLevel || flow[i] < threshold || used[i]) continue
    candidates.push(i)
  }
  candidates.sort((a, b) => flow[a] - flow[b])
  for (const head of candidates) {
    if (used[head]) continue
    const pts: number[] = []
    let cur = head
    let steps = 0
    let maxFlow = flow[head]
    while (cur >= 0 && steps < 600) {
      if (used[cur]) {
        pts.push(cur % cols, (cur / cols) | 0)
        break
      }
      used[cur] = 1
      pts.push(cur % cols, (cur / cols) | 0)
      maxFlow = Math.max(maxFlow, flow[cur])
      if (h[cur] < seaLevel) break
      cur = downhill[cur]
      steps++
    }
    if (pts.length >= 2 * 14) {
      rivers.push({ pts, width: Math.min(1.4, 0.5 + Math.sqrt(maxFlow) * 0.02) })
    }
    if (rivers.length >= 7) break
  }
  return rivers
}

export interface Peak {
  col: number
  row: number
  h: number
  worldX: number
  worldY: number
}

export function findPeaks(grid: TerrainGrid, seaLevel: number, minAbove = 0.18): Peak[] {
  const { cols, rows, h } = grid
  const peaks: Peak[] = []
  const R = 6
  for (let y = R; y < rows - R; y += 2) {
    for (let x = R; x < cols - R; x += 2) {
      const i = y * cols + x
      const v = h[i]
      if (v < seaLevel + minAbove) continue
      let isMax = true
      for (let oy = -R; oy <= R && isMax; oy += 2) {
        for (let ox = -R; ox <= R; ox += 2) {
          if (!ox && !oy) continue
          if (h[(y + oy) * cols + (x + ox)] > v) {
            isMax = false
            break
          }
        }
      }
      if (isMax) {
        peaks.push({
          col: x,
          row: y,
          h: v,
          worldX: grid.win.x0 + x * grid.dx,
          worldY: grid.win.y0 + y * grid.dy,
        })
      }
    }
  }
  peaks.sort((a, b) => b.h - a.h)
  return peaks.slice(0, 14)
}
