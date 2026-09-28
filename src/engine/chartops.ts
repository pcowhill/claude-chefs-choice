import { Contour, chaikin, contourLines, simplify } from './contours'
import { makeLanguage, roman } from './language'
import { StyleId, WASHES } from './pens'
import { Rng, intIn, mulberry32, pick } from './rng'
import {
  Terrain,
  TerrainGrid,
  WorldWindow,
  computeDistToLand,
  defaultSeaLevel,
  findIslands,
  findPeaks,
  riverPaths,
} from './terrain'

/**
 * The chart compiler. Takes a window of ocean and produces every mark the
 * drafting engine will make, in drawing order: an op is one stroke of the
 * pen, one line of lettering, one wash of tint. The plotter performs them.
 */

export type PenId = 'ink' | 'inkFaint' | 'red' | 'redFaint' | 'blue'

export type LayerId =
  | 'graticule'
  | 'rhumbs'
  | 'wash'
  | 'coast'
  | 'bathy'
  | 'rivers'
  | 'relief'
  | 'hazards'
  | 'soundings'
  | 'track'
  | 'names'
  | 'rose'
  | 'furniture'
  | 'user'

export const PLOT_ORDER: LayerId[] = [
  'graticule', 'rhumbs', 'wash', 'coast', 'bathy', 'rivers', 'relief',
  'hazards', 'soundings', 'track', 'names', 'rose', 'furniture', 'user',
]

export const LAYER_VERBS: Record<LayerId, string> = {
  graticule: 'RULING THE GRATICULE',
  rhumbs: 'LAYING RHUMB LINES',
  wash: 'TINTING THE WASHES',
  coast: 'SCRIBING COASTLINES',
  bathy: 'TRACING BATHYMETRY',
  rivers: 'TRACING WATERCOURSES',
  relief: 'HATCHING THE RELIEF',
  hazards: 'MARKING HAZARDS',
  soundings: 'SETTING SOUNDINGS',
  track: "PLOTTING SHIP'S TRACK",
  names: 'LETTERING PLACE NAMES',
  rose: 'CONSTRUCTING THE ROSE',
  furniture: 'ENGROSSING THE CARTOUCHE',
  user: 'ENTERING FIELD OBSERVATIONS',
}

export interface StrokeOp {
  t: 'stroke'
  pts: number[]
  pen: PenId
  w: number
  layer: LayerId
  dash?: [number, number]
  a?: number
}
export interface DotsOp {
  t: 'dots'
  pts: number[]
  pen: PenId
  r: number
  layer: LayerId
  a?: number
}
export interface TextOp {
  t: 'text'
  x: number
  y: number
  text: string
  size: number
  pen: PenId
  layer: LayerId
  angle?: number
  italic?: boolean
  sc?: boolean // small caps face
  spacing?: number
  align?: 'center' | 'left' | 'right'
  a?: number
}
export interface WashOp {
  t: 'wash'
  image: CanvasImageSource
  layer: LayerId
  a?: number
}
export type Op = StrokeOp | DotsOp | TextOp | WashOp

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ChartParams {
  terrain: Terrain
  seed: number
  win: WorldWindow
  sheetW: number
  sheetH: number
  margin: number
  tide: number // -1 … 1 around the sheet's natural datum
  style: StyleId
  layersOff: ReadonlySet<LayerId>
  userSoundings: { x: number; y: number }[]
  sheetIndex: number
  /** Reuse a grid sampled for the same window/size (tide & style changes). */
  cachedGrid?: TerrainGrid
}

export interface ChartMeta {
  seaName: string
  archipelagoName: string
  surveyor: string
  ship: string
  year: number
  sheetRoman: string
  surveyNo: string
  scaleText: string
  landFraction: number
  islandCount: number
  datumText: string
}

export interface ChartBuild {
  ops: Op[]
  meta: ChartMeta
  grid: TerrainGrid
  inner: Rect
  seaLevel: number
}

export const DEPTH_SCALE = 100 // height units → fathoms
export const TIDE_SPAN = 0.15

/** The sea level a given tide-wheel position produces on this sheet. */
export function levelForTide(grid: TerrainGrid, tide: number): number {
  return Math.max(
    grid.quantile(0.2),
    Math.min(grid.quantile(0.965), defaultSeaLevel(grid) + tide * TIDE_SPAN),
  )
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/**
 * Contours that run *along* the grid border (the isoline leaving the
 * window nearly parallel to the frame) read as ruler lines hugging the
 * neatline. Cut those runs out, keeping one border point at each cut so
 * genuine frame crossings still reach the edge.
 */
function trimBorderRuns(contours: Contour[], cols: number, rows: number): Contour[] {
  const onBorder = (x: number, y: number) =>
    x < 1.25 || y < 1.25 || x > cols - 2.25 || y > rows - 2.25
  const out: Contour[] = []
  for (const ct of contours) {
    const n = ct.pts.length / 2
    let any = false
    for (let i = 0; i < n; i++) {
      if (onBorder(ct.pts[i * 2], ct.pts[i * 2 + 1])) {
        any = true
        break
      }
    }
    if (!any) {
      out.push(ct)
      continue
    }
    // collect intervals of interior points, extended one point into the border
    let start = -1
    const emit = (a: number, b: number) => {
      const a2 = Math.max(0, a - 1)
      const b2 = Math.min(n - 1, b + 1)
      if (b2 - a2 < 3) return
      out.push({ pts: ct.pts.slice(a2 * 2, (b2 + 1) * 2), closed: false })
    }
    for (let i = 0; i < n; i++) {
      const border = onBorder(ct.pts[i * 2], ct.pts[i * 2 + 1])
      if (!border && start === -1) start = i
      if (border && start !== -1) {
        emit(start, i - 1)
        start = -1
      }
    }
    if (start !== -1) emit(start, n - 1)
  }
  return out
}

export function buildChart(p: ChartParams): ChartBuild {
  const inner: Rect = {
    x: p.margin,
    y: p.margin,
    w: p.sheetW - 2 * p.margin,
    h: p.sheetH - 2 * p.margin,
  }
  const cols = Math.max(120, Math.round(inner.w / 3.7))
  const rows = Math.max(90, Math.round(inner.h / 3.7))
  const grid =
    p.cachedGrid && p.cachedGrid.cols === cols && p.cachedGrid.rows === rows
      ? p.cachedGrid
      : p.terrain.sampleGrid(p.win, cols, rows)
  const level = levelForTide(grid, p.tide)
  grid.seaLevel = level
  grid.distToLand = computeDistToLand(grid, level)
  const dist = grid.distToLand

  const rng = mulberry32((p.seed ^ (p.sheetIndex * 0x9e3779b9)) >>> 0)
  const lang = makeLanguage(p.seed)

  // grid → sheet px
  const sx = inner.w / (cols - 1)
  const sy = inner.h / (rows - 1)
  const gpx = (gx: number) => inner.x + gx * sx
  const gpy = (gy: number) => inner.y + gy * sy
  const mapPts = (gridPts: number[]): number[] => {
    const out = new Array(gridPts.length)
    for (let i = 0; i < gridPts.length; i += 2) {
      out[i] = gpx(gridPts[i])
      out[i + 1] = gpy(gridPts[i + 1])
    }
    return out
  }
  const sample = (field: Float32Array, gx: number, gy: number): number => {
    const cx = Math.max(0, Math.min(cols - 1.001, gx))
    const cy = Math.max(0, Math.min(rows - 1.001, gy))
    const x0 = Math.floor(cx)
    const y0 = Math.floor(cy)
    const fx = cx - x0
    const fy = cy - y0
    const i = y0 * cols + x0
    const a = field[i]
    const b = field[i + 1]
    const c = field[i + cols]
    const d = field[i + cols + 1]
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
  }
  const heightAt = (gx: number, gy: number) => sample(grid.h, gx, gy)
  const distAt = (gx: number, gy: number) => sample(dist, gx, gy)

  const opsByLayer = new Map<LayerId, Op[]>()
  const push = (op: Op) => {
    let list = opsByLayer.get(op.layer)
    if (!list) opsByLayer.set(op.layer, (list = []))
    list.push(op)
  }

  const reserved: Rect[] = []
  const reserve = (r: Rect) => reserved.push(r)
  const isFree = (r: Rect) => !reserved.some((b) => overlaps(r, b))
  const insideInner = (r: Rect) =>
    r.x >= inner.x + 4 &&
    r.y >= inner.y + 12 &&
    r.x + r.w <= inner.x + inner.w - 4 &&
    r.y + r.h <= inner.y + inner.h - 4
  const textRect = (
    x: number,
    y: number,
    text: string,
    size: number,
    spacing = 0,
    align: 'center' | 'left' | 'right' = 'center',
  ): Rect => {
    const w = text.length * size * 0.58 + Math.max(0, text.length - 1) * spacing
    const h = size * 1.25
    const rx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x
    return { x: rx - 3, y: y - h * 0.8 - 2, w: w + 6, h: h + 4 }
  }

  // ---------------------------------------------------------------- geo ref
  const geoRng = mulberry32(p.seed ^ 0x6e0a11)
  const north = geoRng() < 0.72
  const latDeg0 = intIn(geoRng, 9, 63)
  const lonDeg0 = intIn(geoRng, 3, 175)
  const east = geoRng() < 0.5
  // 1 world unit = 1 arcminute. latMin decreases southward (down) if northern.
  const latMinAt = (wy: number) => latDeg0 * 60 - (wy - p.win.y0) * (north ? 1 : -1)
  const lonMinAt = (wx: number) => lonDeg0 * 60 + (wx - p.win.x0) * (east ? 1 : -1)
  const fmtLat = (min: number) => {
    const m = Math.round(Math.abs(min))
    return `${Math.floor(m / 60)}°${String(m % 60).padStart(2, '0')}′${north ? 'N' : 'S'}`
  }
  const fmtLon = (min: number) => {
    const m = Math.round(Math.abs(min))
    return `${Math.floor(m / 60)}°${String(m % 60).padStart(2, '0')}′${east ? 'E' : 'W'}`
  }

  // ------------------------------------------------------------- analyses
  const islands = findIslands(grid, level).filter((i) => i.cellCount >= 5)
  const bigIslands = islands.filter((i) => i.areaMi2 > 13)
  const peaks = findPeaks(grid, level)
  const landFraction = islands.reduce((s, i) => s + i.cellCount, 0) / (cols * rows)

  // Open-water anchor points (grid coords), for the sea title and the rose.
  const openWater = (() => {
    const spots: { gx: number; gy: number; d: number }[] = []
    for (let gy = 8; gy < rows - 8; gy += 3) {
      for (let gx = 8; gx < cols - 8; gx += 3) {
        spots.push({ gx, gy, d: dist[gy * cols + gx] })
      }
    }
    spots.sort((a, b) => b.d - a.d)
    return spots
  })()
  const titleSpot = openWater[0] ?? { gx: cols / 2, gy: rows / 2, d: 0 }
  const roseSpot = (() => {
    const margin = 118
    const inFrame = (s: { gx: number; gy: number }) => {
      const px = gpx(s.gx)
      const py = gpy(s.gy)
      return (
        px > inner.x + margin &&
        px < inner.x + inner.w - margin &&
        py > inner.y + margin &&
        py < inner.y + inner.h - margin
      )
    }
    for (const s of openWater) {
      if (!inFrame(s)) continue
      const dx = gpx(s.gx) - gpx(titleSpot.gx)
      const dy = gpy(s.gy) - gpy(titleSpot.gy)
      if (Math.hypot(dx, dy) > 300 && s.d > 2.2) return s
    }
    for (const s of openWater) if (inFrame(s)) return s
    return openWater[Math.min(40, openWater.length - 1)] ?? titleSpot
  })()

  const seaName = lang.properAt(
    p.win.x0 + titleSpot.gx * grid.dx + 500,
    p.win.y0 + titleSpot.gy * grid.dy + 500,
    5,
  )
  const archipelagoName = bigIslands.length
    ? lang.properAt(
        p.win.x0 + bigIslands[0].peakCol * grid.dx,
        p.win.y0 + bigIslands[0].peakRow * grid.dy,
      )
    : seaName
  const surveyor = lang.surveyorName(rng)
  const ship = lang.shipName(rng)
  const year = 1838 + (p.seed % 55)
  const scaleDen = Math.round((p.win.w * 1852) / (inner.w * 0.00028) / 5000) * 5000
  const meta: ChartMeta = {
    seaName: seaName.toUpperCase(),
    archipelagoName,
    surveyor,
    ship,
    year,
    sheetRoman: roman(p.sheetIndex + 1),
    surveyNo: String(1000 + (p.seed % 9000)),
    scaleText: `1 : ${scaleDen.toLocaleString('en-US')}`,
    landFraction,
    islandCount: bigIslands.length,
    datumText:
      Math.abs(p.tide) < 0.005
        ? ''
        : `${p.tide > 0 ? '+' : '−'}${Math.abs(p.tide * TIDE_SPAN * DEPTH_SCALE * 6).toFixed(0)} FT`,
  }

  // ============================================================ FURNITURE
  // Reserved boxes must exist before names & soundings are placed, so the
  // cartouche corner is chosen first even though it plots last.
  const cartoucheW = Math.min(360, inner.w * 0.3)
  const cartoucheH = 172
  const pad = 22
  const corners: Rect[] = [
    { x: inner.x + pad, y: inner.y + pad, w: cartoucheW, h: cartoucheH },
    { x: inner.x + inner.w - pad - cartoucheW, y: inner.y + pad, w: cartoucheW, h: cartoucheH },
    { x: inner.x + pad, y: inner.y + inner.h - pad - cartoucheH, w: cartoucheW, h: cartoucheH },
    {
      x: inner.x + inner.w - pad - cartoucheW,
      y: inner.y + inner.h - pad - cartoucheH,
      w: cartoucheW,
      h: cartoucheH,
    },
  ]
  const seaFrac = (r: Rect): number => {
    let sea = 0
    let n = 0
    for (let py = r.y; py < r.y + r.h; py += 14) {
      for (let px = r.x; px < r.x + r.w; px += 14) {
        n++
        if (heightAt((px - inner.x) / sx, (py - inner.y) / sy) < level) sea++
      }
    }
    return n ? sea / n : 0
  }
  const titlePx = { x: gpx(titleSpot.gx), y: gpy(titleSpot.gy) }
  const cartouche = corners
    .map((r) => ({
      r,
      score:
        seaFrac(r) -
        (Math.hypot(r.x + r.w / 2 - titlePx.x, r.y + r.h / 2 - titlePx.y) < 320 ? 0.5 : 0) -
        (Math.hypot(r.x + r.w / 2 - gpx(roseSpot.gx), r.y + r.h / 2 - gpy(roseSpot.gy)) < 260
          ? 0.35
          : 0),
    }))
    .sort((a, b) => b.score - a.score)[0].r
  reserve({ x: cartouche.x - 8, y: cartouche.y - 8, w: cartouche.w + 16, h: cartouche.h + 16 })

  // Notes block: below the cartouche if it fits, else above.
  const notesH = 84
  const notes: Rect = {
    x: cartouche.x,
    y:
      cartouche.y + cartoucheH + notesH + 30 < inner.y + inner.h
        ? cartouche.y + cartoucheH + 18
        : cartouche.y - notesH - 18,
    w: Math.min(320, cartoucheW),
    h: notesH,
  }
  reserve(notes)

  // Scale bar: bottom centre unless the cartouche corner owns it.
  const scaleW = Math.min(300, inner.w * 0.24)
  const scaleBar: Rect = {
    x: inner.x + inner.w / 2 - scaleW / 2,
    y: inner.y + inner.h - 52,
    w: scaleW,
    h: 40,
  }
  reserve(scaleBar)

  const roseR = 66
  const rosePx = { x: gpx(roseSpot.gx), y: gpy(roseSpot.gy) }
  reserve({ x: rosePx.x - roseR - 26, y: rosePx.y - roseR - 26, w: roseR * 2 + 52, h: roseR * 2 + 52 })

  // ============================================================ GRATICULE
  {
    const L: LayerId = 'graticule'
    // Neatline: outer heavy, inner light, minute ticks between.
    const o = 10 // band width
    const rect = (r: Rect): number[] => [r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h, r.x, r.y]
    push({ t: 'stroke', pts: rect({ x: inner.x - o, y: inner.y - o, w: inner.w + 2 * o, h: inner.h + 2 * o }), pen: 'ink', w: 2.1, layer: L })
    push({ t: 'stroke', pts: rect(inner), pen: 'ink', w: 0.9, layer: L })

    // Longitude ticks & labels (top/bottom), latitude (left/right).
    const lonA = lonMinAt(p.win.x0)
    const lonB = lonMinAt(p.win.x0 + p.win.w)
    const lonLo = Math.min(lonA, lonB)
    const lonHi = Math.max(lonA, lonB)
    for (let m = Math.ceil(lonLo / 10) * 10; m <= lonHi; m += 10) {
      const wx = p.win.x0 + (m - lonMinAt(p.win.x0)) * (east ? 1 : -1)
      const px = inner.x + ((wx - p.win.x0) / p.win.w) * inner.w
      if (px < inner.x + 2 || px > inner.x + inner.w - 2) continue
      const major = m % 30 === 0
      push({ t: 'stroke', pts: [px, inner.y, px, inner.y - (major ? o : o * 0.55)], pen: 'ink', w: major ? 1 : 0.6, layer: L })
      push({ t: 'stroke', pts: [px, inner.y + inner.h, px, inner.y + inner.h + (major ? o : o * 0.55)], pen: 'ink', w: major ? 1 : 0.6, layer: L })
      if (major) {
        push({ t: 'text', x: px, y: inner.y - 15, text: fmtLon(m), size: 10, pen: 'ink', layer: L, a: 0.75, align: 'center' })
        push({ t: 'text', x: px, y: inner.y + inner.h + 24, text: fmtLon(m), size: 10, pen: 'ink', layer: L, a: 0.75, align: 'center' })
        if (m % 30 === 0) {
          push({ t: 'stroke', pts: [px, inner.y, px, inner.y + inner.h], pen: 'inkFaint', w: 0.6, layer: L, a: 0.5 })
        }
      }
    }
    const latA = latMinAt(p.win.y0)
    const latB = latMinAt(p.win.y0 + p.win.h)
    const latLo = Math.min(latA, latB)
    const latHi = Math.max(latA, latB)
    for (let m = Math.ceil(latLo / 10) * 10; m <= latHi; m += 10) {
      const wy = p.win.y0 + (latDeg0 * 60 - m) * (north ? 1 : -1)
      const py = inner.y + ((wy - p.win.y0) / p.win.h) * inner.h
      if (py < inner.y + 2 || py > inner.y + inner.h - 2) continue
      const major = m % 30 === 0
      push({ t: 'stroke', pts: [inner.x, py, inner.x - (major ? o : o * 0.55), py], pen: 'ink', w: major ? 1 : 0.6, layer: L })
      push({ t: 'stroke', pts: [inner.x + inner.w, py, inner.x + inner.w + (major ? o : o * 0.55), py], pen: 'ink', w: major ? 1 : 0.6, layer: L })
      if (major) {
        push({ t: 'text', x: inner.x - 14, y: py + 3.5, text: fmtLat(m), size: 10, pen: 'ink', layer: L, a: 0.75, align: 'right', angle: 0 })
        push({ t: 'text', x: inner.x + inner.w + 14, y: py + 3.5, text: fmtLat(m), size: 10, pen: 'ink', layer: L, a: 0.75, align: 'left' })
        push({ t: 'stroke', pts: [inner.x, py, inner.x + inner.w, py], pen: 'inkFaint', w: 0.6, layer: L, a: 0.5 })
      }
    }
    // Margin plates (kept clear of the graticule labels' rows)
    push({
      t: 'text', x: p.sheetW / 2, y: 19,
      text: `SURVEY N° ${meta.surveyNo} — SHEET ${meta.sheetRoman}`,
      size: 11, pen: 'ink', layer: L, sc: true, spacing: 2.5, a: 0.8, align: 'center',
    })
    push({
      t: 'text', x: p.sheetW - p.margin, y: p.sheetH - 12,
      text: 'PLOTTED BY THE AUTOMATIC CHART ROOM · PATENT MDCCCLXXXVII',
      size: 8.5, pen: 'ink', layer: L, sc: true, spacing: 1.5, a: 0.55, align: 'right',
    })
    push({
      t: 'text', x: p.margin, y: p.sheetH - 12,
      text: `DATUM OF SOUNDINGS: MEAN LOW WATER${meta.datumText ? ` ${meta.datumText}` : ''}`,
      size: 8.5, pen: 'ink', layer: L, sc: true, spacing: 1.2, a: 0.55, align: 'left',
    })
  }

  // =============================================================== RHUMBS
  if (!p.layersOff.has('rhumbs')) {
    const L: LayerId = 'rhumbs'
    const cx = rosePx.x
    const cy = rosePx.y
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      // clip ray to inner rect
      let tMax = Infinity
      if (dx > 1e-9) tMax = Math.min(tMax, (inner.x + inner.w - cx) / dx)
      if (dx < -1e-9) tMax = Math.min(tMax, (inner.x - cx) / dx)
      if (dy > 1e-9) tMax = Math.min(tMax, (inner.y + inner.h - cy) / dy)
      if (dy < -1e-9) tMax = Math.min(tMax, (inner.y - cy) / dy)
      if (!isFinite(tMax) || tMax < roseR + 30) continue
      const cardinal = k % 4 === 0
      push({
        t: 'stroke',
        pts: [cx + dx * (roseR + 14), cy + dy * (roseR + 14), cx + dx * tMax, cy + dy * tMax],
        pen: 'redFaint',
        w: cardinal ? 0.9 : 0.65,
        layer: L,
        a: cardinal ? 0.5 : 0.34,
      })
    }
  }

  // ================================================================= WASH
  if (!p.layersOff.has('wash')) {
    const wash = WASHES[p.style]
    const img = document.createElement('canvas')
    img.width = cols
    img.height = rows
    const c = img.getContext('2d')!
    const put = c.createImageData(cols, rows)
    const data = put.data
    const parse = (rgba: string): [number, number, number, number] => {
      const m = rgba.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
      if (!m) return [0, 0, 0, 0]
      return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]
    }
    const landC = parse(wash.land)
    const landHighC = parse(wash.landHigh)
    const s1 = parse(wash.shallow1)
    const s2 = parse(wash.shallow2)
    const s3 = parse(wash.shallow3)
    const shade = parse(wash.coastShade)
    for (let i = 0; i < cols * rows; i++) {
      const h = grid.h[i]
      let r = 0, g = 0, b = 0, a = 0
      if (h >= level) {
        const t = Math.min(1, (h - level) / 0.5)
        r = landC[0] + (landHighC[0] - landC[0]) * t
        g = landC[1] + (landHighC[1] - landC[1]) * t
        b = landC[2] + (landHighC[2] - landC[2]) * t
        a = landC[3] + (landHighC[3] - landC[3]) * t
      } else {
        const depth = (level - h) * DEPTH_SCALE
        const src = depth < 3 ? s1 : depth < 10 ? s2 : depth < 20 ? s3 : null
        if (src) {
          r = src[0]; g = src[1]; b = src[2]; a = src[3]
        }
        if (dist[i] < 1.0 && depth >= 3) {
          // engraver's coastal shading
          const k = 1 - dist[i]
          r = r * (1 - k) + shade[0] * k
          g = g * (1 - k) + shade[1] * k
          b = b * (1 - k) + shade[2] * k
          a = Math.max(a, shade[3] * k)
        }
      }
      data[i * 4] = r
      data[i * 4 + 1] = g
      data[i * 4 + 2] = b
      data[i * 4 + 3] = Math.round(a * 255)
    }
    c.putImageData(put, 0, 0)
    push({ t: 'wash', image: img, layer: 'wash' })
  }

  // ================================================================ COAST
  {
    const L: LayerId = 'coast'
    const contours = trimBorderRuns(contourLines(grid, level), cols, rows)
    const keep: { pts: number[]; closed: boolean; len: number }[] = []
    for (const ct of contours) {
      if (ct.pts.length < 12) {
        // Specks become islet dots — too small for a coastline to survive.
        if (ct.closed && ct.pts.length >= 6) {
          let mx = 0, my = 0
          for (let i = 0; i < ct.pts.length; i += 2) { mx += ct.pts[i]; my += ct.pts[i + 1] }
          const n = ct.pts.length / 2
          push({ t: 'dots', pts: [gpx(mx / n), gpy(my / n)], pen: 'ink', r: 1.4, layer: L })
        }
        continue
      }
      const sm = chaikin(simplify(ct.pts, 0.55), ct.closed, 2)
      const px = mapPts(sm)
      if (ct.closed) px.push(px[0], px[1])
      keep.push({ pts: px, closed: ct.closed, len: px.length })
    }
    keep.sort((a, b) => b.len - a.len)
    for (const k of keep) push({ t: 'stroke', pts: k.pts, pen: 'ink', w: 1.5, layer: L })
  }

  // ================================================================ BATHY
  {
    const L: LayerId = 'bathy'
    const specs: { f: number; dash: [number, number]; w: number; a: number }[] = [
      { f: 3, dash: [1.5, 3], w: 0.8, a: 0.65 },
      { f: 5, dash: [4, 3], w: 0.8, a: 0.6 },
      { f: 10, dash: [7, 4], w: 0.8, a: 0.55 },
      { f: 20, dash: [11, 5], w: 0.75, a: 0.5 },
      { f: 40, dash: [16, 6], w: 0.7, a: 0.42 },
    ]
    for (const s of specs) {
      const contours = trimBorderRuns(contourLines(grid, level - s.f / DEPTH_SCALE), cols, rows)
      for (const ct of contours) {
        if (ct.pts.length < 24) continue
        const sm = chaikin(simplify(ct.pts, 0.8), ct.closed, 2)
        const px = mapPts(sm)
        if (ct.closed) px.push(px[0], px[1])
        push({ t: 'stroke', pts: px, pen: 'inkFaint', w: s.w, layer: L, dash: s.dash, a: s.a })
      }
    }
  }

  // =============================================================== RIVERS
  if (landFraction > 0.04) {
    const L: LayerId = 'rivers'
    for (const rv of riverPaths(grid, level)) {
      const sm = chaikin(simplify(rv.pts, 1.2), false, 2)
      push({ t: 'stroke', pts: mapPts(sm), pen: 'ink', w: rv.width * 0.85, layer: L, a: 0.8 })
    }
  }

  // =============================================================== RELIEF
  if (!p.layersOff.has('relief')) {
    const L: LayerId = 'relief'
    const strokes: number[][] = []
    const hRng = mulberry32(p.seed ^ 0x4ac4e5)
    for (let gy = 2; gy < rows - 2; gy += 2) {
      for (let gx = 2; gx < cols - 2; gx += 2) {
        const i = gy * cols + gx
        const h = grid.h[i]
        if (h < level + 0.015) continue
        const gxd = (grid.h[i + 1] - grid.h[i - 1]) / 2
        const gyd = (grid.h[i + cols] - grid.h[i - cols]) / 2
        const slope = Math.hypot(gxd, gyd)
        if (slope < 0.02) continue
        if (hRng() > Math.min(1, slope * 26)) continue
        const px = gpx(gx) + (hRng() - 0.5) * 4
        const py = gpy(gy) + (hRng() - 0.5) * 4
        const ang = Math.atan2(gyd, gxd) + Math.PI + (hRng() - 0.5) * 0.35 // downslope
        const len = Math.min(10, 3.5 + slope * 110)
        strokes.push([px, py, px + Math.cos(ang) * len, py + Math.sin(ang) * len])
      }
    }
    // Cap density, keep it engraving-like
    const max = 3200
    const step = strokes.length > max ? strokes.length / max : 1
    for (let i = 0; i < strokes.length; i += step) {
      const s = strokes[Math.floor(i)]
      push({ t: 'stroke', pts: s, pen: 'ink', w: 0.55, layer: L, a: 0.5 + (i % 3) * 0.1 })
    }
    // Spot heights on the principal peaks
    for (const pk of peaks.slice(0, 4)) {
      const px = gpx(pk.col)
      const py = gpy(pk.row)
      const feet = Math.max(50, Math.round(((pk.h - level) * 4300) / 10) * 10)
      push({ t: 'dots', pts: [px, py], pen: 'ink', r: 1.3, layer: L })
      push({ t: 'text', x: px + 4, y: py - 4, text: String(feet), size: 9.5, pen: 'ink', layer: L, italic: true, a: 0.75, align: 'left' })
    }
  }

  // ============================================================== HAZARDS
  {
    const L: LayerId = 'hazards'
    // Shoal stipple
    const dots: number[] = []
    const stRng = mulberry32(p.seed ^ 0x57091e)
    for (let gy = 1; gy < rows - 1; gy += 1.5) {
      for (let gx = 1; gx < cols - 1; gx += 1.5) {
        const i = Math.floor(gy) * cols + Math.floor(gx)
        const h = grid.h[i]
        if (h >= level) continue
        const depth = (level - h) * DEPTH_SCALE
        if (depth > 2.4 || dist[i] < 0.22) continue
        if (stRng() < 0.42) {
          dots.push(gpx(gx) + (stRng() - 0.5) * 5, gpy(gy) + (stRng() - 0.5) * 5)
        }
      }
    }
    for (let i = 0; i < dots.length; i += 500) {
      push({ t: 'dots', pts: dots.slice(i, i + 500), pen: 'ink', r: 0.55, layer: L, a: 0.55 })
    }
    // Rocks awash
    const rocks: { x: number; y: number }[] = []
    for (const s of openWater) {
      if (rocks.length >= 5) break
      const i = s.gy * cols + s.gx
      const h = grid.h[i]
      const depth = (level - h) * DEPTH_SCALE
      if (depth > 0.1 && depth < 1.6 && dist[i] > 1.2 && stRng() < 0.5) {
        rocks.push({ x: gpx(s.gx), y: gpy(s.gy) })
      }
    }
    for (const rk of rocks) {
      push({ t: 'stroke', pts: [rk.x - 3.4, rk.y, rk.x + 3.4, rk.y], pen: 'ink', w: 0.8, layer: L })
      push({ t: 'stroke', pts: [rk.x, rk.y - 3.4, rk.x, rk.y + 3.4], pen: 'ink', w: 0.8, layer: L })
      push({ t: 'dots', pts: [rk.x - 4.6, rk.y - 3, rk.x + 4.6, rk.y - 3, rk.x - 4.6, rk.y + 3, rk.x + 4.6, rk.y + 3], pen: 'ink', r: 0.5, layer: L, a: 0.7 })
      push({ t: 'text', x: rk.x + 8, y: rk.y + 3, text: 'Rk.', size: 8.5, pen: 'ink', layer: L, italic: true, a: 0.65, align: 'left' })
    }
    // A wreck or two, in memoriam
    const wrecks = intIn(stRng, 1, 2)
    let placedWrecks = 0
    for (const s of openWater) {
      if (placedWrecks >= wrecks) break
      const i = s.gy * cols + s.gx
      const depth = (level - grid.h[i]) * DEPTH_SCALE
      if (depth < 3 || depth > 14 || dist[i] < 0.8 || dist[i] > 3.4) continue
      if (stRng() < 0.85) continue
      const x = gpx(s.gx)
      const y = gpy(s.gy)
      // half-sunk hull
      push({ t: 'stroke', pts: [x - 5, y + 1.5, x - 2, y + 3, x + 3, y + 3, x + 6, y - 2], pen: 'ink', w: 0.9, layer: L })
      push({ t: 'stroke', pts: [x - 1, y + 3, x - 1, y - 4.5, x - 4.4, y - 1.4], pen: 'ink', w: 0.8, layer: L })
      push({ t: 'text', x: x + 9, y: y + 3, text: 'Wk.', size: 8.5, pen: 'ink', layer: L, italic: true, a: 0.65, align: 'left' })
      placedWrecks++
    }
    // An anchorage in the lee of the big island
    if (bigIslands.length) {
      for (const s of openWater) {
        const i = s.gy * cols + s.gx
        if (dist[i] < 0.7 || dist[i] > 2.0) continue
        const depth = (level - grid.h[i]) * DEPTH_SCALE
        if (depth < 4 || depth > 12) continue
        const x = gpx(s.gx)
        const y = gpy(s.gy)
        const r: Rect = { x: x - 14, y: y - 14, w: 42, h: 28 }
        if (!isFree(r)) continue
        reserve(r)
        // anchor glyph
        push({ t: 'stroke', pts: [x, y - 5.5, x, y + 4], pen: 'ink', w: 0.9, layer: L })
        push({ t: 'stroke', pts: [x - 3.2, y - 3, x + 3.2, y - 3], pen: 'ink', w: 0.8, layer: L })
        const arc: number[] = []
        for (let a = 0.15; a <= Math.PI - 0.15; a += 0.3) {
          arc.push(x - Math.cos(a) * 4.6, y + 1.5 + Math.sin(a) * 3.2)
        }
        push({ t: 'stroke', pts: arc, pen: 'ink', w: 0.8, layer: L })
        push({ t: 'text', x: x + 8, y: y + 3.5, text: 'Anchge.', size: 8.5, pen: 'ink', layer: L, italic: true, a: 0.7, align: 'left' })
        break
      }
    }
  }

  // ================================================================ NAMES
  // (Built before soundings so labels reserve space; plots after them.)
  const nameRng = mulberry32(p.seed ^ 0x9a3e21 ^ p.sheetIndex)
  if (!p.layersOff.has('names')) {
    const L: LayerId = 'names'
    // Sea title on an arc through open water
    if (titleSpot.d > 1.6) {
      const text = `${meta.seaName} SEA`
      const size = Math.min(34, 22 + inner.w / 120)
      const spacing = 16
      const R = 1150
      let total = 0
      for (const ch of text) total += size * (ch === ' ' ? 0.5 : 0.66) + spacing
      // keep the whole arc comfortably inside the neatline
      const tx = Math.max(
        inner.x + total / 2 + 26,
        Math.min(inner.x + inner.w - total / 2 - 26, titlePx.x),
      )
      const ty = Math.max(inner.y + 72, Math.min(inner.y + inner.h - 96, titlePx.y))
      const cx = tx
      const cy = ty + R
      let s = -total / 2
      const box: Rect = { x: tx - total / 2 - 10, y: ty - size * 1.6, w: total + 20, h: size * 2.6 }
      reserve(box)
      for (const ch of text) {
        const wCh = size * (ch === ' ' ? 0.5 : 0.66) + spacing
        const mid = s + wCh / 2
        const th = mid / R
        if (ch !== ' ') {
          push({
            t: 'text',
            x: cx + Math.sin(th) * R,
            y: cy - Math.cos(th) * R,
            text: ch,
            size,
            pen: 'ink',
            layer: L,
            angle: th,
            italic: true,
            a: 0.5,
            align: 'center',
          })
        }
        s += wCh
      }
    }

    // Island names, angled along each island's long axis
    for (const isl of bigIslands.slice(0, 9)) {
      const name = lang.properAt(
        p.win.x0 + isl.peakCol * grid.dx,
        p.win.y0 + isl.peakRow * grid.dy,
      )
      const big = isl.areaMi2 > 70
      const text = big ? name.toUpperCase() : `${name} I.`
      const size = big ? Math.min(24, 13 + Math.sqrt(isl.areaMi2) * 0.6) : 12
      const spacing = big ? 7 : 0.5
      // principal axis from the island's cells (approximated inside its bbox)
      let cxx = 0, cxy = 0, cyy = 0, n = 0
      for (let gy = isl.minRow; gy <= isl.maxRow; gy += 2) {
        for (let gx = isl.minCol; gx <= isl.maxCol; gx += 2) {
          if (grid.h[gy * cols + gx] >= level) {
            const dx = gx - isl.cx
            const dy = gy - isl.cy
            cxx += dx * dx
            cxy += dx * dy
            cyy += dy * dy
            n++
          }
        }
      }
      let angle = n > 4 ? 0.5 * Math.atan2(2 * cxy, cxx - cyy) : 0
      if (angle > Math.PI / 2) angle -= Math.PI
      if (angle < -Math.PI / 2) angle += Math.PI
      angle = Math.max(-0.45, Math.min(0.45, angle))
      const x = gpx(isl.cx)
      const y = gpy(isl.cy)
      const r = textRect(x, y, text, size, spacing)
      if (!isFree(r)) continue
      reserve(r)
      push({ t: 'text', x, y: y + size * 0.3, text, size, pen: 'ink', layer: L, angle, sc: big, italic: !big, spacing, a: big ? 0.72 : 0.85, align: 'center' })
    }

    // Capes: farthest promontory of the biggest islands
    let capes = 0
    for (const isl of bigIslands.slice(0, 4)) {
      if (capes >= 3) break
      let best = { gx: isl.cx, gy: isl.cy, d: 0 }
      for (let gy = isl.minRow; gy <= isl.maxRow; gy += 2) {
        for (let gx = isl.minCol; gx <= isl.maxCol; gx += 2) {
          const i = gy * cols + gx
          if (grid.h[i] < level || dist[i] !== 0) continue
          // boundary cell: any sea neighbour?
          const seaN =
            grid.h[i - 1] < level || grid.h[i + 1] < level ||
            grid.h[i - cols] < level || grid.h[i + cols] < level
          if (!seaN) continue
          const d = Math.hypot(gx - isl.cx, gy - isl.cy)
          if (d > best.d) best = { gx, gy, d }
        }
      }
      if (best.d < 8) continue
      const dirx = (best.gx - isl.cx) / best.d
      const diry = (best.gy - isl.cy) / best.d
      const name = lang.properAt(
        p.win.x0 + best.gx * grid.dx + 31,
        p.win.y0 + best.gy * grid.dy - 17,
      )
      const x = gpx(best.gx) + dirx * 26
      const y = gpy(best.gy) + diry * 20
      const text = `C. ${name}`
      const r = textRect(x, y, text, 10.5)
      if (!isFree(r) || !insideInner(r)) continue
      reserve(r)
      push({ t: 'text', x, y, text, size: 10.5, pen: 'ink', layer: L, italic: true, a: 0.8, align: 'center' })
      capes++
    }

    // A sound or strait between the two biggest islands
    if (bigIslands.length >= 2) {
      const a = bigIslands[0]
      const b = bigIslands[1]
      const mx = (a.cx + b.cx) / 2
      const my = (a.cy + b.cy) / 2
      const gapMi = Math.hypot((a.cx - b.cx) * grid.dx, (a.cy - b.cy) * grid.dy)
      if (gapMi < 26 && heightAt(mx, my) < level && distAt(mx, my) > 0.5) {
        const name = lang.properAt(p.win.x0 + mx * grid.dx + 63, p.win.y0 + my * grid.dy + 11)
        let ang = Math.atan2(gpy(b.cy) - gpy(a.cy), gpx(b.cx) - gpx(a.cx)) + Math.PI / 2
        if (ang > Math.PI / 2) ang -= Math.PI
        if (ang < -Math.PI / 2) ang += Math.PI
        ang = Math.max(-0.6, Math.min(0.6, ang))
        const text = `${name.toUpperCase()} SOUND`
        const x = gpx(mx)
        const y = gpy(my)
        const r = textRect(x, y, text, 11.5, 3)
        if (isFree(r) && insideInner(r)) {
          reserve(r)
          push({ t: 'text', x, y, text, size: 11.5, pen: 'ink', layer: L, angle: ang, sc: true, spacing: 3, a: 0.6, align: 'center' })
        }
      }
    }

    // A bank over the loneliest shallow patch
    {
      let best: { gx: number; gy: number; score: number } | null = null
      for (const s of openWater) {
        const i = s.gy * cols + s.gx
        const depth = (level - grid.h[i]) * DEPTH_SCALE
        if (depth < 1 || depth > 6 || dist[i] < 2.4) continue
        const score = dist[i] + (6 - depth) * 0.4
        if (!best || score > best.score) best = { gx: s.gx, gy: s.gy, score }
      }
      if (best) {
        const name = lang.properAt(p.win.x0 + best.gx * grid.dx - 47, p.win.y0 + best.gy * grid.dy + 29)
        const text = `${name.toUpperCase()} BANK`
        const x = gpx(best.gx)
        const y = gpy(best.gy)
        const r = textRect(x, y, text, 10.5, 2.5)
        if (isFree(r) && insideInner(r)) {
          reserve(r)
          push({ t: 'text', x, y, text, size: 10.5, pen: 'ink', layer: L, sc: true, spacing: 2.5, a: 0.55, align: 'center', italic: true })
        }
      }
    }

    // Mountain names for the two proudest peaks
    for (const pk of peaks.slice(0, 2)) {
      if (pk.h - level < 0.3) continue
      const name = lang.properAt(pk.worldX, pk.worldY)
      const x = gpx(pk.col)
      const y = gpy(pk.row) + 14
      const text = `Mt. ${name}`
      const r = textRect(x, y, text, 10)
      if (!isFree(r)) continue
      reserve(r)
      push({ t: 'text', x, y, text, size: 10, pen: 'ink', layer: L, italic: true, a: 0.75, align: 'center' })
    }
  }

  // ============================================================ SOUNDINGS
  if (!p.layersOff.has('soundings')) {
    const L: LayerId = 'soundings'
    const sRng = mulberry32(p.seed ^ 0x50d1c5 ^ p.sheetIndex)
    const spacing = 27
    let row = 0
    for (let py = inner.y + 16; py < inner.y + inner.h - 14; py += spacing * 0.85) {
      row++
      for (
        let px = inner.x + 16 + (row % 2 ? spacing / 2 : 0);
        px < inner.x + inner.w - 14;
        px += spacing
      ) {
        const jx = px + (sRng() - 0.5) * 14
        const jy = py + (sRng() - 0.5) * 12
        const gx = (jx - inner.x) / sx
        const gy = (jy - inner.y) / sy
        const h = heightAt(gx, gy)
        if (h >= level - 0.012) continue
        const depth = (level - h) * DEPTH_SCALE
        const d = distAt(gx, gy)
        const keepP = depth < 12 ? 0.8 : depth < 30 ? 0.5 : d > 5 ? 0.22 : 0.34
        if (sRng() > keepP) continue
        const r: Rect = { x: jx - 8, y: jy - 7, w: 16, h: 13 }
        if (!isFree(r)) continue
        reserve(r)
        const shown = depth < 21 ? Math.max(1, Math.round(depth)) : Math.round(depth / 2) * 2
        push({
          t: 'text',
          x: jx,
          y: jy,
          text: String(shown),
          size: 10.5,
          pen: 'ink',
          layer: L,
          angle: (sRng() - 0.5) * 0.1,
          a: 0.8,
          align: 'center',
        })
      }
    }
  }

  // ================================================================ TRACK
  if (!p.layersOff.has('track') && landFraction > 0.015) {
    const L: LayerId = 'track'
    const path = buildTrack(grid, level, rng, inner, sx, sy, heightAt, distAt)
    if (path) {
      push({ t: 'stroke', pts: path, pen: 'ink', w: 0.85, layer: L, dash: [9, 6], a: 0.7 })
      // date flags + chevrons along the way
      const n = path.length / 2
      const month = pick(rng, ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'])
      let day = intIn(rng, 1, 12)
      const marks = 4
      for (let k = 1; k <= marks; k++) {
        const i = Math.floor((n - 1) * (k / (marks + 1))) * 2
        const x = path[i]
        const y = path[i + 1]
        const x2 = path[Math.min(i + 6, path.length - 2)]
        const y2 = path[Math.min(i + 7, path.length - 1)]
        const ang = Math.atan2(y2 - y, x2 - x)
        // chevron
        push({
          t: 'stroke',
          pts: [
            x - Math.cos(ang - 0.5) * 6, y - Math.sin(ang - 0.5) * 6,
            x, y,
            x - Math.cos(ang + 0.5) * 6, y - Math.sin(ang + 0.5) * 6,
          ],
          pen: 'ink', w: 0.8, layer: L, a: 0.7,
        })
        const lx = x + Math.cos(ang + Math.PI / 2) * 13
        const ly = y + Math.sin(ang + Math.PI / 2) * 13
        const text = `${month} ${day}.`
        const r = textRect(lx, ly, text, 9)
        if (isFree(r)) {
          reserve(r)
          push({ t: 'text', x: lx, y: ly, text, size: 9, pen: 'ink', layer: L, italic: true, a: 0.65, align: 'center' })
        }
        day += intIn(rng, 2, 6)
      }
    }
  }

  // ================================================================= ROSE
  {
    const L: LayerId = 'rose'
    const cx = rosePx.x
    const cy = rosePx.y
    const circle = (r: number): number[] => {
      const pts: number[] = []
      for (let a = 0; a <= Math.PI * 2 + 0.001; a += Math.PI / 32) {
        pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      }
      return pts
    }
    push({ t: 'stroke', pts: circle(roseR), pen: 'ink', w: 1.4, layer: L })
    push({ t: 'stroke', pts: circle(roseR - 3.5), pen: 'ink', w: 0.6, layer: L })
    push({ t: 'stroke', pts: circle(roseR * 0.42), pen: 'inkFaint', w: 0.6, layer: L, a: 0.6 })
    // 32 graduations
    for (let k = 0; k < 32; k++) {
      const a = (k * Math.PI) / 16
      const r0 = k % 2 ? roseR - 8 : roseR - 11
      push({
        t: 'stroke',
        pts: [cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * (roseR - 4), cy + Math.sin(a) * (roseR - 4)],
        pen: 'ink', w: 0.6, layer: L, a: 0.8,
      })
    }
    // 8 minor red points then 8 major dark points (N at top: angle -90°)
    const point = (ang: number, len: number, base: number, pen: PenId, w: number) => {
      const bx = Math.cos(ang + Math.PI / 2) * base
      const by = Math.sin(ang + Math.PI / 2) * base
      const tx = cx + Math.cos(ang) * len
      const ty = cy + Math.sin(ang) * len
      push({ t: 'stroke', pts: [cx - bx, cy - by, tx, ty, cx + bx, cy + by], pen, w, layer: L })
      push({ t: 'stroke', pts: [cx + Math.cos(ang) * 2, cy + Math.sin(ang) * 2, tx, ty], pen, w: w * 0.7, layer: L, a: 0.7 })
    }
    for (let k = 0; k < 8; k++) point(-Math.PI / 2 + (k * Math.PI) / 4 + Math.PI / 8, roseR * 0.52, 4.5, 'red', 0.9)
    for (let k = 0; k < 8; k++) point(-Math.PI / 2 + (k * Math.PI) / 4, roseR * 0.8, 6, 'ink', 1)
    // cardinal letters
    const letters: [string, number, number][] = [
      ['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0],
    ]
    for (const [ch, lx, ly] of letters) {
      push({ t: 'text', x: cx + lx * (roseR + 14), y: cy + ly * (roseR + 14) + 4.5, text: ch, size: 13, pen: 'ink', layer: L, sc: true, a: 0.9, align: 'center' })
    }
    // north diamond
    push({ t: 'stroke', pts: [cx, cy - roseR - 30, cx + 3.5, cy - roseR - 24, cx, cy - roseR - 18, cx - 3.5, cy - roseR - 24, cx, cy - roseR - 30], pen: 'red', w: 0.9, layer: L })
    // magnetic variation
    const varDeg = intIn(rng, 3, 19)
    const varDir = rng() < 0.5 ? 'E' : 'W'
    const va = -Math.PI / 2 + ((varDir === 'E' ? -1 : 1) * varDeg * Math.PI) / 180
    push({ t: 'stroke', pts: [cx - Math.cos(va) * roseR * 0.62, cy - Math.sin(va) * roseR * 0.62, cx + Math.cos(va) * roseR * 0.62, cy + Math.sin(va) * roseR * 0.62], pen: 'redFaint', w: 0.7, layer: L, a: 0.75 })
    push({ t: 'text', x: cx, y: cy + roseR + 26, text: `Varn. ${varDeg}°${varDir}. (${meta.year})`, size: 9, pen: 'red', layer: L, italic: true, a: 0.7, align: 'center' })
  }

  // ============================================================ FURNITURE
  {
    const L: LayerId = 'furniture'
    const ct = cartouche
    const rect = (r: Rect): number[] => [r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h, r.x, r.y]
    push({ t: 'stroke', pts: rect(ct), pen: 'ink', w: 1.3, layer: L })
    push({ t: 'stroke', pts: rect({ x: ct.x + 4, y: ct.y + 4, w: ct.w - 8, h: ct.h - 8 }), pen: 'ink', w: 0.6, layer: L })
    // corner curls
    const curl = (x: number, y: number, dx: number, dy: number) => {
      const pts: number[] = []
      for (let t = 0; t <= 1.001; t += 0.08) {
        const a = t * Math.PI * 1.6
        const r = 7 * (1 - t * 0.75)
        pts.push(x + dx * (10 - Math.cos(a) * r), y + dy * (10 - Math.sin(a) * r * 0.9))
      }
      push({ t: 'stroke', pts, pen: 'ink', w: 0.7, layer: L, a: 0.8 })
    }
    curl(ct.x, ct.y, 1, 1)
    curl(ct.x + ct.w, ct.y, -1, 1)
    curl(ct.x, ct.y + ct.h, 1, -1)
    curl(ct.x + ct.w, ct.y + ct.h, -1, -1)

    const cxm = ct.x + ct.w / 2
    let ty = ct.y + 26
    const line = (
      text: string, size: number, opts: Partial<TextOp> = {},
    ) => {
      push({ t: 'text', x: cxm, y: ty, text, size, pen: 'ink', layer: L, align: 'center', ...opts })
    }
    line('MARE INCOGNITVM', 10, { sc: true, spacing: 3, a: 0.62 })
    ty += 13
    // flourished rule
    push({ t: 'stroke', pts: [cxm - 60, ty, cxm - 8, ty], pen: 'ink', w: 0.6, layer: L, a: 0.7 })
    push({ t: 'stroke', pts: [cxm + 8, ty, cxm + 60, ty], pen: 'ink', w: 0.6, layer: L, a: 0.7 })
    push({ t: 'stroke', pts: [cxm - 5, ty, cxm, ty - 3, cxm + 5, ty, cxm, ty + 3, cxm - 5, ty], pen: 'ink', w: 0.6, layer: L })
    ty += 24
    const titleSize = meta.seaName.length > 9 ? 19 : 22
    line(`THE ${meta.seaName} SEA`, titleSize, { sc: true, spacing: 2 })
    ty += 20
    line(`with the ${meta.archipelagoName} Islands`, 12.5, { italic: true, a: 0.85 })
    ty += 22
    line(`Surveyed by Commr. ${meta.surveyor} — H.M.S. ${meta.ship} — ${meta.year}`, 10, { italic: true, a: 0.8 })
    ty += 16
    line(`SOUNDINGS IN FATHOMS · SCALE ${meta.scaleText}`, 9, { sc: true, spacing: 1.5, a: 0.7 })
    ty += 15
    line('PLOTTED BY THE AUTOMATIC CHART ROOM ENGINE', 8, { sc: true, spacing: 1.2, a: 0.55 })

    // Notes block
    const nRng = mulberry32(p.seed ^ 0x0be5)
    const nx = notes.x + 4
    let ny = notes.y + 12
    push({ t: 'text', x: nx, y: ny, text: 'NOTES.', size: 10, pen: 'ink', layer: L, sc: true, spacing: 2, a: 0.8, align: 'left' })
    push({ t: 'stroke', pts: [nx, ny + 3, nx + 38, ny + 3], pen: 'ink', w: 0.6, layer: L, a: 0.7 })
    ny += 16
    const noteLines = [
      `Magnetic variation ${intIn(nRng, 4, 18)}°${nRng() < 0.5 ? 'E' : 'W'}. (${meta.year}), decreasing abt. ${intIn(nRng, 1, 7)}′ annually.`,
      `Tides: H.W.F. & C. at ${intIn(nRng, 1, 11)}h. ${intIn(nRng, 0, 59)}m.; springs rise ${intIn(nRng, 4, 16)} feet.`,
      pick(nRng, [
        'The banks hereabouts are reported to shift after westerly gales.',
        'Currents set strongly through the sounds at the change of tide.',
        'Kelp marks most rocky patches; give all such a wide berth.',
        'The soundings marked in red are from field observations.',
      ]),
      `Positions referred to the meridian of the Observatory, ${meta.year}.`,
    ]
    for (const nl of noteLines) {
      push({ t: 'text', x: nx, y: ny, text: nl, size: 8.8, pen: 'ink', layer: L, italic: true, a: 0.72, align: 'left' })
      ny += 13.5
    }

    // Scale bar
    const sb = scaleBar
    const miles = Math.max(5, Math.round((sb.w / inner.w) * p.win.w / 5) * 5)
    const mileW = sb.w / miles
    const sy0 = sb.y + 22
    push({ t: 'text', x: sb.x + sb.w / 2, y: sb.y + 8, text: 'NAUTICAL MILES', size: 8.5, pen: 'ink', layer: L, sc: true, spacing: 2, a: 0.7, align: 'center' })
    push({ t: 'stroke', pts: [sb.x, sy0, sb.x + sb.w, sy0], pen: 'ink', w: 1, layer: L })
    for (let m = 0; m <= miles; m++) {
      const x = sb.x + m * mileW
      const major = m % 5 === 0
      push({ t: 'stroke', pts: [x, sy0, x, sy0 - (major ? 7 : 4)], pen: 'ink', w: major ? 1 : 0.6, layer: L })
      if (major) {
        push({ t: 'text', x, y: sy0 + 12, text: String(m), size: 8.5, pen: 'ink', layer: L, a: 0.7, align: 'center' })
      }
    }
    // alternating fill for first five miles
    for (let m = 0; m < Math.min(5, miles); m += 2) {
      const x = sb.x + m * mileW
      push({ t: 'stroke', pts: [x, sy0 - 2.5, x + mileW, sy0 - 2.5], pen: 'ink', w: 3.5, layer: L, a: 0.75 })
    }
  }

  // ================================================================= USER
  for (const us of p.userSoundings) {
    const gx = (us.x - p.win.x0) / grid.dx
    const gy = (us.y - p.win.y0) / grid.dy
    if (gx < 2 || gy < 2 || gx > cols - 3 || gy > rows - 3) continue
    for (const op of userSoundingOps(p.terrain, level, us, gpx(gx), gpy(gy))) push(op)
  }

  // ------------------------------------------------------------- assemble
  const ops: Op[] = []
  for (const layer of PLOT_ORDER) {
    const list = opsByLayer.get(layer)
    if (list) ops.push(...list)
  }
  return { ops, meta, grid, inner, seaLevel: level }
}

/** The survey ship's course: threads the archipelago, never runs aground. */
function buildTrack(
  grid: TerrainGrid,
  level: number,
  rng: Rng,
  inner: Rect,
  sx: number,
  sy: number,
  heightAt: (gx: number, gy: number) => number,
  distAt: (gx: number, gy: number) => number,
): number[] | null {
  const { cols, rows } = grid
  // candidate edge points in open water, tagged by which edge they sit on
  const edges: { gx: number; gy: number; side: number }[] = []
  for (let gx = 6; gx < cols - 6; gx += 4) {
    if (distAt(gx, 4) > 2) edges.push({ gx, gy: 4, side: 0 })
    if (distAt(gx, rows - 5) > 2) edges.push({ gx, gy: rows - 5, side: 1 })
  }
  for (let gy = 6; gy < rows - 6; gy += 4) {
    if (distAt(4, gy) > 2) edges.push({ gx: 4, gy, side: 2 })
    if (distAt(cols - 5, gy) > 2) edges.push({ gx: cols - 5, gy, side: 3 })
  }
  if (edges.length < 2) return null
  const start = pick(rng, edges)
  // leave by a different edge than we came, if the sea allows it
  let end = start
  let bestD = 0
  for (const e of edges) {
    const d = Math.hypot(e.gx - start.gx, e.gy - start.gy) + (e.side !== start.side ? 90 : 0)
    if (d > bestD) {
      bestD = d
      end = e
    }
  }
  // waypoints: offshore of the biggest islands, ordered start → end
  const islands = findIslands(grid, level).filter((i) => i.areaMi2 > 20).slice(0, 3)
  const wps: { gx: number; gy: number }[] = []
  for (const isl of islands) {
    let best: { gx: number; gy: number; score: number } | null = null
    const rr = Math.min(
      Math.min(cols, rows) * 0.34,
      Math.max(isl.maxCol - isl.minCol, isl.maxRow - isl.minRow) * 0.62 + 9,
    )
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8
      const gx = isl.cx + Math.cos(a) * rr
      const gy = isl.cy + Math.sin(a) * rr * 0.8
      if (gx < 8 || gy < 8 || gx > cols - 9 || gy > rows - 9) continue
      const d = distAt(gx, gy)
      if (heightAt(gx, gy) >= level || d < 1.2) continue
      const score = Math.min(d, 3) + rng() * 0.5
      if (!best || score > best.score) best = { gx, gy, score }
    }
    if (best) wps.push(best)
  }
  wps.sort(
    (a, b) =>
      Math.hypot(a.gx - start.gx, a.gy - start.gy) - Math.hypot(b.gx - start.gx, b.gy - start.gy),
  )
  const ctrl = [start, ...wps, end]
  if (ctrl.length < 2) return null

  // Catmull-Rom through control points
  const samples: number[] = []
  const P = (i: number) => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))]
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = P(i - 1)
    const p1 = P(i)
    const p2 = P(i + 1)
    const p3 = P(i + 2)
    const segLen = Math.hypot(p2.gx - p1.gx, p2.gy - p1.gy)
    const steps = Math.max(6, Math.round(segLen / 1.5))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      samples.push(
        0.5 * (2 * p1.gx + (-p0.gx + p2.gx) * t + (2 * p0.gx - 5 * p1.gx + 4 * p2.gx - p3.gx) * t2 + (-p0.gx + 3 * p1.gx - 3 * p2.gx + p3.gx) * t3),
        0.5 * (2 * p1.gy + (-p0.gy + p2.gy) * t + (2 * p0.gy - 5 * p1.gy + 4 * p2.gy - p3.gy) * t2 + (-p0.gy + 3 * p1.gy - 3 * p2.gy + p3.gy) * t3),
      )
    }
  }
  // Push samples away from land, following the distance field uphill
  for (let pass = 0; pass < 10; pass++) {
    let bad = 0
    for (let i = 0; i < samples.length; i += 2) {
      const gx = samples[i]
      const gy = samples[i + 1]
      const d = distAt(gx, gy)
      if (d < 1.15) {
        bad++
        const e = 1.5
        const ddx = distAt(gx + e, gy) - distAt(gx - e, gy)
        const ddy = distAt(gx, gy + e) - distAt(gx, gy - e)
        const m = Math.hypot(ddx, ddy) || 1
        const k = (1.15 - d) * 3
        samples[i] = Math.max(4, Math.min(cols - 5, gx + (ddx / m) * k))
        samples[i + 1] = Math.max(4, Math.min(rows - 5, gy + (ddy / m) * k))
      }
    }
    if (!bad) break
  }
  // Keep the longest stretch of honestly clear water; a course that runs
  // off the sheet mid-way is period truth, a course over a hill is not.
  let runStart = 0
  let bestStart = 0
  let bestLen = 0
  let inRun = false
  const nPts = samples.length / 2
  for (let i = 0; i <= nPts; i++) {
    const clear =
      i < nPts &&
      distAt(samples[i * 2], samples[i * 2 + 1]) > 0.55 &&
      heightAt(samples[i * 2], samples[i * 2 + 1]) < level
    if (clear && !inRun) {
      inRun = true
      runStart = i
    }
    if (!clear && inRun) {
      inRun = false
      if (i - runStart > bestLen) {
        bestLen = i - runStart
        bestStart = runStart
      }
    }
  }
  if (bestLen < nPts * 0.3 || bestLen < 24) return null
  const kept = samples.slice(bestStart * 2, (bestStart + bestLen) * 2)
  const smooth = chaikin(kept, false, 1)
  const px: number[] = new Array(smooth.length)
  for (let i = 0; i < smooth.length; i += 2) {
    px[i] = inner.x + smooth[i] * sx
    px[i + 1] = inner.y + smooth[i + 1] * sy
  }
  return px
}

/**
 * A cheap ghost coastline for the tide preview: marching squares over a
 * decimated copy of the sheet's grid, mapped straight to sheet pixels.
 */
export function contoursForPreview(grid: TerrainGrid, level: number, inner: Rect): number[][] {
  const f = 3
  const cols2 = Math.floor((grid.cols - 1) / f) + 1
  const rows2 = Math.floor((grid.rows - 1) / f) + 1
  const h2 = new Float32Array(cols2 * rows2)
  for (let y = 0; y < rows2; y++) {
    for (let x = 0; x < cols2; x++) {
      h2[y * cols2 + x] = grid.h[y * f * grid.cols + x * f]
    }
  }
  const sx = inner.w / (grid.cols - 1)
  const sy = inner.h / (grid.rows - 1)
  const out: number[][] = []
  for (const ct of contourLines({ cols: cols2, rows: rows2, h: h2 }, level)) {
    if (ct.pts.length < 8) continue
    const pts = new Array(ct.pts.length)
    for (let i = 0; i < ct.pts.length; i += 2) {
      pts[i] = inner.x + ct.pts[i] * f * sx
      pts[i + 1] = inner.y + ct.pts[i + 1] * f * sy
    }
    if (ct.closed) pts.push(pts[0], pts[1])
    out.push(pts)
  }
  return out
}

/**
 * Marks for one observation taken by hand: a red sounding at sea, a
 * triangulation station ashore. Used both at build time and live when
 * the user clicks the sheet.
 */
export function userSoundingOps(
  terrain: Terrain,
  level: number,
  world: { x: number; y: number },
  px: number,
  py: number,
): Op[] {
  const ops: Op[] = []
  const h = terrain.height(world.x, world.y)
  if (h < level) {
    const depth = Math.max(1, Math.round((level - h) * DEPTH_SCALE))
    ops.push({ t: 'text', x: px, y: py, text: String(depth), size: 12.5, pen: 'red', layer: 'user', align: 'center', a: 0.95 })
    ops.push({ t: 'stroke', pts: [px - 6.5, py + 4, px + 6.5, py + 4], pen: 'red', w: 0.7, layer: 'user', a: 0.7 })
  } else {
    const feet = Math.max(10, Math.round(((h - level) * 4300) / 10) * 10)
    ops.push({ t: 'stroke', pts: [px, py - 4.4, px + 4, py + 3, px - 4, py + 3, px, py - 4.4], pen: 'red', w: 0.8, layer: 'user' })
    ops.push({ t: 'text', x: px + 7, y: py + 3, text: `Sta. ${feet}`, size: 9, pen: 'red', layer: 'user', italic: true, a: 0.85, align: 'left' })
  }
  return ops
}

