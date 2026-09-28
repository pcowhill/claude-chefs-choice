/**
 * Marching squares over a scalar grid → stitched, smoothed polylines.
 * Contours are returned in fractional grid coordinates; the chart layer
 * decides how they land on paper. Open chains end at the grid boundary
 * (the neatline clips them), closed chains are islands or lakes.
 */

export interface ScalarGrid {
  cols: number
  rows: number
  h: Float32Array // rows * cols, row-major
}

export interface Contour {
  pts: number[] // flat [x0, y0, x1, y1, ...] in grid space
  closed: boolean
}

// Edge identity: horizontal edge at (x, y) is the top edge of cell (x, y);
// vertical edge at (x, y) is the left edge of cell (x, y).
const edgeId = (cols: number, x: number, y: number, vertical: boolean) =>
  (y * (cols + 1) + x) * 2 + (vertical ? 1 : 0)

export function contourLines(grid: ScalarGrid, level: number): Contour[] {
  const { cols, rows, h } = grid
  const segsA: number[] = [] // edge id endpoint A per segment
  const segsB: number[] = []
  const coords = new Map<number, [number, number]>()

  const lerpT = (a: number, b: number) => {
    const d = b - a
    if (Math.abs(d) < 1e-12) return 0.5
    return (level - a) / d
  }

  for (let y = 0; y < rows - 1; y++) {
    const row0 = y * cols
    const row1 = (y + 1) * cols
    for (let x = 0; x < cols - 1; x++) {
      const v0 = h[row0 + x] // tl
      const v1 = h[row0 + x + 1] // tr
      const v2 = h[row1 + x + 1] // br
      const v3 = h[row1 + x] // bl
      let c = 0
      if (v0 >= level) c |= 1
      if (v1 >= level) c |= 2
      if (v2 >= level) c |= 4
      if (v3 >= level) c |= 8
      if (c === 0 || c === 15) continue

      const T = () => {
        const id = edgeId(cols, x, y, false)
        if (!coords.has(id)) coords.set(id, [x + lerpT(v0, v1), y])
        return id
      }
      const B = () => {
        const id = edgeId(cols, x, y + 1, false)
        if (!coords.has(id)) coords.set(id, [x + lerpT(v3, v2), y + 1])
        return id
      }
      const L = () => {
        const id = edgeId(cols, x, y, true)
        if (!coords.has(id)) coords.set(id, [x, y + lerpT(v0, v3)])
        return id
      }
      const R = () => {
        const id = edgeId(cols, x + 1, y, true)
        if (!coords.has(id)) coords.set(id, [x + 1, y + lerpT(v1, v2)])
        return id
      }
      const seg = (a: number, b: number) => {
        segsA.push(a)
        segsB.push(b)
      }

      switch (c) {
        case 1: seg(L(), T()); break
        case 2: seg(T(), R()); break
        case 3: seg(L(), R()); break
        case 4: seg(R(), B()); break
        case 5: {
          const center = (v0 + v1 + v2 + v3) / 4
          if (center >= level) { seg(L(), B()); seg(T(), R()) }
          else { seg(L(), T()); seg(R(), B()) }
          break
        }
        case 6: seg(T(), B()); break
        case 7: seg(L(), B()); break
        case 8: seg(L(), B()); break
        case 9: seg(T(), B()); break
        case 10: {
          const center = (v0 + v1 + v2 + v3) / 4
          if (center >= level) { seg(T(), L()); seg(R(), B()) }
          else { seg(T(), R()); seg(L(), B()) }
          break
        }
        case 11: seg(R(), B()); break
        case 12: seg(L(), R()); break
        case 13: seg(T(), R()); break
        case 14: seg(L(), T()); break
      }
    }
  }

  // Stitch segments into chains.
  const adj = new Map<number, number[]>()
  const nSegs = segsA.length
  for (let i = 0; i < nSegs; i++) {
    let la = adj.get(segsA[i])
    if (!la) adj.set(segsA[i], (la = []))
    la.push(i)
    let lb = adj.get(segsB[i])
    if (!lb) adj.set(segsB[i], (lb = []))
    lb.push(i)
  }

  const used = new Uint8Array(nSegs)
  const out: Contour[] = []

  const walk = (startSeg: number, startEdge: number) => {
    const chain: number[] = [startEdge]
    let seg = startSeg
    let cur = startEdge
    for (;;) {
      used[seg] = 1
      const next = segsA[seg] === cur ? segsB[seg] : segsA[seg]
      chain.push(next)
      cur = next
      const cands = adj.get(cur)!
      let found = -1
      for (const s of cands) if (!used[s]) { found = s; break }
      if (found === -1) break
      seg = found
    }
    return chain
  }

  const emit = (chain: number[]) => {
    const closed = chain.length > 3 && chain[0] === chain[chain.length - 1]
    const upto = closed ? chain.length - 1 : chain.length
    const pts: number[] = new Array(upto * 2)
    for (let i = 0; i < upto; i++) {
      const p = coords.get(chain[i])!
      pts[i * 2] = p[0]
      pts[i * 2 + 1] = p[1]
    }
    out.push({ pts, closed })
  }

  // Open chains first (start at degree-1 edges), then remaining loops.
  for (const [edge, list] of adj) {
    if (list.length !== 1) continue
    const s = list[0]
    if (used[s]) continue
    emit(walk(s, edge))
  }
  for (let i = 0; i < nSegs; i++) {
    if (used[i]) continue
    emit(walk(i, segsA[i]))
  }
  return out
}

/** Drop points closer than eps to the previously kept point. */
export function simplify(pts: number[], eps: number): number[] {
  const n = pts.length / 2
  if (n <= 2) return pts
  const out: number[] = [pts[0], pts[1]]
  let lx = pts[0]
  let ly = pts[1]
  const e2 = eps * eps
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 2]
    const y = pts[i * 2 + 1]
    const dx = x - lx
    const dy = y - ly
    if (dx * dx + dy * dy >= e2) {
      out.push(x, y)
      lx = x
      ly = y
    }
  }
  out.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1])
  return out
}

/** Chaikin corner cutting. Keeps endpoints of open chains anchored. */
export function chaikin(pts: number[], closed: boolean, iterations: number): number[] {
  let p = pts
  for (let it = 0; it < iterations; it++) {
    const n = p.length / 2
    if (n < 3) return p
    const out: number[] = []
    if (!closed) out.push(p[0], p[1])
    const last = closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n
      const x0 = p[i * 2]
      const y0 = p[i * 2 + 1]
      const x1 = p[j * 2]
      const y1 = p[j * 2 + 1]
      out.push(x0 + (x1 - x0) * 0.25, y0 + (y1 - y0) * 0.25)
      out.push(x0 + (x1 - x0) * 0.75, y0 + (y1 - y0) * 0.75)
    }
    if (!closed) out.push(p[(n - 1) * 2], p[(n - 1) * 2 + 1])
    p = out
  }
  return p
}

export function polylineLength(pts: number[]): number {
  let len = 0
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2]
    const dy = pts[i + 1] - pts[i - 1]
    len += Math.hypot(dx, dy)
  }
  return len
}
