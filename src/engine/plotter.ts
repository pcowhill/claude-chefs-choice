import { LAYER_VERBS, LayerId, Op, StrokeOp, TextOp } from './chartops'
import { PALETTES, PAPERS, PenSpec, StyleId } from './pens'
import { mulberry32 } from './rng'

/**
 * The drafting engine itself. Consumes ops with a pixel budget per frame,
 * drags a gantry cursor around the sheet, wobbles the pen like a wrist,
 * and reports its progress to the console in period voice.
 */

export interface PlotterStatus {
  verb: string
  layer: LayerId | null
  progress: number // 0..1 over the whole sheet
  plotting: boolean
}

export interface PlotterHooks {
  onStatus?: (s: PlotterStatus) => void
  onActivity?: (inkPxPerSec: number, layer: LayerId | null) => void
  onLayerChange?: (layer: LayerId) => void
  onComplete?: () => void
}

/** Some layers are drawn briskly, some are savoured. */
const LAYER_SPEED: Record<LayerId, number> = {
  graticule: 5.5,
  rhumbs: 4.5,
  wash: 1.7,
  coast: 1.35,
  bathy: 2.6,
  rivers: 1.7,
  relief: 5.6,
  hazards: 3,
  soundings: 2.7,
  track: 1.8,
  names: 1.15,
  rose: 1.4,
  furniture: 1.5,
  user: 3,
}

const BASE_PX_PER_SEC = 1500
const TEXT_COST_MUL = 1.85 // lettering is slower than ruling
const DOT_COST = 3.2
const WASH_COST = 900

interface ActiveStroke {
  seg: number
  segT: number
  lastX: number
  lastY: number
  wobble: number
  wobbleV: number
  rng: () => number
}

interface Ripple {
  x: number
  y: number
  t: number
}

export class Plotter {
  private paper: HTMLCanvasElement
  private wash: HTMLCanvasElement
  private ink: HTMLCanvasElement
  private overlay: HTMLCanvasElement
  private pctx: CanvasRenderingContext2D
  private wctx: CanvasRenderingContext2D
  private ictx: CanvasRenderingContext2D
  private octx: CanvasRenderingContext2D

  private w = 0
  private h = 0
  private dpr = 1
  private style: StyleId = 'fair'

  private ops: Op[] = []
  private idx = 0
  private live: Op[] = []
  private liveActive = false
  private completedFired = false
  private activeStroke: ActiveStroke | null = null
  private textProgress = 0 // chars drawn of current text op
  private dotProgress = 0
  private washProgress = 0
  private committedWashes: { img: CanvasImageSource; a: number }[] = []

  private totalCost = 1
  private spentCost = 0
  private curLayer: LayerId | null = null

  speed = 1
  private boost = 1
  private penX = 0
  private penY = 0
  private penTX = 0
  private penTY = 0
  private penDown = false
  private ripples: Ripple[] = []
  private previewLines: number[][] | null = null
  private hooks: PlotterHooks
  private statusAt = 0
  private inkThisTick = 0
  private done = true
  private jitterRng = mulberry32(0xf00d)

  constructor(
    paper: HTMLCanvasElement,
    wash: HTMLCanvasElement,
    ink: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    hooks: PlotterHooks = {},
  ) {
    this.paper = paper
    this.wash = wash
    this.ink = ink
    this.overlay = overlay
    this.hooks = hooks
    this.pctx = paper.getContext('2d')!
    this.wctx = wash.getContext('2d')!
    this.ictx = ink.getContext('2d')!
    this.octx = overlay.getContext('2d')!
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w
    this.h = h
    this.dpr = dpr
    for (const [cv, ctx] of [
      [this.paper, this.pctx],
      [this.wash, this.wctx],
      [this.ink, this.ictx],
      [this.overlay, this.octx],
    ] as const) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = `${w}px`
      cv.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    this.paintPaper()
  }

  setStyle(style: StyleId) {
    if (this.style === style) return
    this.style = style
    this.paintPaper()
  }

  getStyle(): StyleId {
    return this.style
  }

  /** Begin plotting a fresh sheet. Clears the ink. boost > 1 = brisk redraft. */
  load(ops: Op[], boost = 1) {
    this.boost = boost
    this.ops = ops
    this.idx = 0
    this.live = []
    this.liveActive = false
    this.completedFired = false
    this.activeStroke = null
    this.textProgress = 0
    this.dotProgress = 0
    this.washProgress = 0
    this.committedWashes = []
    this.curLayer = null
    this.spentCost = 0
    this.totalCost = Math.max(1, ops.reduce((s, op) => s + this.costOf(op), 0))
    this.done = false
    this.ictx.clearRect(0, 0, this.w, this.h)
    this.wctx.clearRect(0, 0, this.w, this.h)
    this.penX = this.penTX = 26
    this.penY = this.penTY = 26
    this.emitStatus(true)
  }

  /** User ops jump the queue — the gantry darts over and inks them now. */
  enqueueLive(ops: Op[]) {
    this.live.push(...ops)
    if (this.done) {
      this.done = false
      this.emitStatus(true)
    }
  }

  addRipple(x: number, y: number) {
    this.ripples.push({ x, y, t: 0 })
  }

  /** Ghost coastline shown while the tide wheel is turning. */
  setPreview(lines: number[][] | null) {
    this.previewLines = lines
  }

  finishInstantly() {
    let guard = 0
    while ((!this.done || this.live.length) && guard < 4000) {
      this.step(1e9)
      guard++
    }
    this.renderOverlay(0.016)
    this.emitStatus(true)
  }

  isDone() {
    return this.done && this.live.length === 0
  }

  progress() {
    return Math.min(1, this.spentCost / this.totalCost)
  }

  /** Advance the machine by dt seconds. Returns ink px drawn (for audio). */
  tick(dt: number): number {
    this.inkThisTick = 0
    if (!this.done || this.live.length) {
      const budget = BASE_PX_PER_SEC * this.speed * this.boost * Math.min(dt, 0.1)
      this.step(budget)
    }
    this.renderOverlay(dt)
    const now = performance.now()
    if (now - this.statusAt > 120) this.emitStatus()
    this.hooks.onActivity?.(this.inkThisTick / Math.max(dt, 1 / 240), this.curLayer)
    return this.inkThisTick
  }

  // ------------------------------------------------------------- internals

  private costOf(op: Op): number {
    switch (op.t) {
      case 'stroke': {
        let len = 0
        for (let i = 2; i < op.pts.length; i += 2) {
          len += Math.hypot(op.pts[i] - op.pts[i - 2], op.pts[i + 1] - op.pts[i - 1])
        }
        return len / LAYER_SPEED[op.layer]
      }
      case 'text':
        return (op.text.length * op.size * 0.62 * TEXT_COST_MUL) / LAYER_SPEED[op.layer]
      case 'dots':
        return ((op.pts.length / 2) * DOT_COST) / LAYER_SPEED[op.layer]
      case 'wash':
        return WASH_COST / LAYER_SPEED[op.layer]
    }
  }

  private pen(id: StrokeOp['pen']): PenSpec {
    return PALETTES[this.style][id]
  }

  private step(budget: number) {
    let guard = 0
    while (budget > 0 && guard < 100000) {
      guard++
      // Live (user) ops only take over between ops — the progress state
      // fields are shared, so a mid-stroke swap would corrupt both.
      const atBoundary =
        !this.activeStroke &&
        this.textProgress === 0 &&
        this.dotProgress === 0 &&
        this.washProgress === 0
      const fromLive = this.liveActive || (this.live.length > 0 && atBoundary)
      const op = fromLive ? this.live[0] : this.ops[this.idx]
      if (!op) {
        if (!this.done) {
          this.done = true
          this.emitStatus(true)
          if (!this.completedFired) {
            this.completedFired = true
            this.hooks.onComplete?.()
          }
        }
        return
      }
      if (fromLive) this.liveActive = true
      if (!fromLive && op.layer !== this.curLayer) {
        this.curLayer = op.layer
        this.hooks.onLayerChange?.(op.layer)
        this.emitStatus(true)
      }
      const speedMul = LAYER_SPEED[op.layer] * (fromLive ? 1.6 : 1)
      const used = this.advanceOp(op, budget * speedMul) / speedMul
      budget -= used
      if (this.opFinished(op)) {
        if (fromLive) {
          this.live.shift()
          this.liveActive = false
        } else {
          this.idx++
          this.spentCost += this.costOf(op)
        }
        this.activeStroke = null
        this.textProgress = 0
        this.dotProgress = 0
        this.washProgress = 0
      } else if (used <= 0.0001) {
        return
      }
    }
  }

  private opFinished(op: Op): boolean {
    switch (op.t) {
      case 'stroke':
        return this.activeStroke !== null && this.activeStroke.seg >= op.pts.length / 2 - 1
      case 'text':
        return this.textProgress >= op.text.length
      case 'dots':
        return this.dotProgress >= op.pts.length / 2
      case 'wash':
        return this.washProgress >= 1
    }
  }

  /** Returns budget consumed (in raw px units of this op). */
  private advanceOp(op: Op, budget: number): number {
    switch (op.t) {
      case 'stroke':
        return this.advanceStroke(op, budget)
      case 'text':
        return this.advanceText(op, budget)
      case 'dots':
        return this.advanceDots(op, budget)
      case 'wash':
        return this.advanceWash(op, budget)
    }
  }

  private advanceStroke(op: StrokeOp, budget: number): number {
    const pts = op.pts
    const nSeg = pts.length / 2 - 1
    if (nSeg < 1) {
      this.activeStroke = { seg: nSeg, segT: 0, lastX: 0, lastY: 0, wobble: 0, wobbleV: 0, rng: this.jitterRng }
      return 0.01
    }
    if (!this.activeStroke) {
      this.activeStroke = {
        seg: 0,
        segT: 0,
        lastX: pts[0],
        lastY: pts[1],
        wobble: 0,
        wobbleV: 0,
        rng: mulberry32((pts[0] * 73 + pts[1] * 179) >>> 0),
      }
      this.penTX = pts[0]
      this.penTY = pts[1]
    }
    const st = this.activeStroke
    const spec = this.pen(op.pen)
    const alpha = (op.a ?? 1) * spec.alpha
    const width = op.w * spec.widthMul
    const jitterAmp = spec.jitter * (width < 0.8 ? 0.7 : 1)

    const ctx = this.ictx
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (op.dash) ctx.setLineDash(op.dash)
    const path: number[] = [st.lastX, st.lastY]
    let spent = 0

    while (spent < budget && st.seg < nSeg) {
      const x0 = pts[st.seg * 2]
      const y0 = pts[st.seg * 2 + 1]
      const x1 = pts[st.seg * 2 + 2]
      const y1 = pts[st.seg * 2 + 3]
      const segLen = Math.hypot(x1 - x0, y1 - y0) || 0.0001
      const remain = (1 - st.segT) * segLen
      const adv = Math.min(remain, budget - spent, 9)
      st.segT += adv / segLen
      spent += adv
      // wobble: a damped random walk perpendicular to travel
      st.wobbleV += (st.rng() - 0.5) * 0.55
      st.wobbleV *= 0.82
      st.wobble = Math.max(-1.6, Math.min(1.6, st.wobble + st.wobbleV))
      const px = x0 + (x1 - x0) * st.segT
      const py = y0 + (y1 - y0) * st.segT
      const nx = -(y1 - y0) / segLen
      const ny = (x1 - x0) / segLen
      const jx = px + nx * st.wobble * jitterAmp
      const jy = py + ny * st.wobble * jitterAmp
      path.push(jx, jy)
      st.lastX = jx
      st.lastY = jy
      if (st.segT >= 0.9999) {
        st.seg++
        st.segT = 0
      }
    }

    if (path.length >= 4) {
      // halo pass — ink bleeding into the fibres
      ctx.beginPath()
      ctx.moveTo(path[0], path[1])
      for (let i = 2; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1])
      ctx.strokeStyle = spec.color
      ctx.globalAlpha = alpha * 0.13
      ctx.lineWidth = width * 2.6
      ctx.stroke()
      ctx.globalAlpha = alpha * (0.88 + this.jitterRng() * 0.16)
      ctx.lineWidth = width
      ctx.stroke()
      this.inkThisTick += spent
    }
    ctx.restore()
    this.penTX = st.lastX
    this.penTY = st.lastY
    this.penDown = true
    return spent
  }

  private fontFor(op: TextOp): string {
    const px = op.size
    const it = op.italic ? 'italic ' : ''
    const fam = op.sc ? '"IM Fell English SC", serif' : '"IM Fell English", serif'
    return `${it}${px}px ${fam}`
  }

  private advanceText(op: TextOp, budget: number): number {
    const ctx = this.ictx
    const spec = this.pen(op.pen)
    ctx.save()
    ctx.font = this.fontFor(op)
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = spec.color
    ctx.globalAlpha = (op.a ?? 1) * spec.alpha

    const spacing = op.spacing ?? 0
    const chars = [...op.text]
    const widths = chars.map((c) => ctx.measureText(c).width)
    let total = widths.reduce((s, w) => s + w, 0) + spacing * Math.max(0, chars.length - 1)
    let startX = 0
    if ((op.align ?? 'left') === 'center') startX = -total / 2
    else if (op.align === 'right') startX = -total

    ctx.translate(op.x, op.y)
    if (op.angle) ctx.rotate(op.angle)

    let x = startX
    for (let i = 0; i < this.textProgress && i < chars.length; i++) x += widths[i] + spacing

    let spent = 0
    while (this.textProgress < chars.length && spent < budget) {
      const i = this.textProgress
      const wob = (this.jitterRng() - 0.5) * (this.style === 'field' ? 1.1 : 0.5)
      ctx.fillText(chars[i], x, wob * 0.6)
      const cost = Math.max(4, widths[i] * TEXT_COST_MUL)
      spent += cost
      // pen follows the lettering (approximate for rotated text)
      const cs = Math.cos(op.angle ?? 0)
      const sn = Math.sin(op.angle ?? 0)
      this.penTX = op.x + (x + widths[i] / 2) * cs
      this.penTY = op.y + (x + widths[i] / 2) * sn
      x += widths[i] + spacing
      this.textProgress++
      this.inkThisTick += cost * 0.6
    }
    ctx.restore()
    this.penDown = true
    return spent
  }

  private advanceDots(op: { t: 'dots'; pts: number[]; pen: StrokeOp['pen']; r: number; layer: LayerId; a?: number }, budget: number): number {
    const ctx = this.ictx
    const spec = this.pen(op.pen)
    ctx.save()
    ctx.fillStyle = spec.color
    ctx.globalAlpha = (op.a ?? 1) * spec.alpha
    let spent = 0
    const n = op.pts.length / 2
    while (this.dotProgress < n && spent < budget) {
      const i = this.dotProgress
      const x = op.pts[i * 2]
      const y = op.pts[i * 2 + 1]
      ctx.beginPath()
      ctx.arc(x, y, op.r * (0.8 + this.jitterRng() * 0.5), 0, Math.PI * 2)
      ctx.fill()
      this.penTX = x
      this.penTY = y
      spent += DOT_COST
      this.dotProgress++
      this.inkThisTick += DOT_COST * 0.4
    }
    ctx.restore()
    this.penDown = true
    return spent
  }

  private advanceWash(op: { t: 'wash'; image: CanvasImageSource; a?: number }, budget: number): number {
    const spent = Math.max(0.01, Math.min(budget, WASH_COST * (1 - this.washProgress)))
    this.washProgress = Math.min(1, this.washProgress + spent / WASH_COST)
    // redraw all washes: committed at full strength, current fading in
    const ctx = this.wctx
    ctx.clearRect(0, 0, this.w, this.h)
    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const blur = Math.max(1.2, this.w / 900)
    ctx.filter = `blur(${blur}px)`
    for (const cw of this.committedWashes) {
      ctx.globalAlpha = cw.a
      ctx.drawImage(cw.img, 0, 0, this.w, this.h)
    }
    const ease = this.washProgress * this.washProgress * (3 - 2 * this.washProgress)
    ctx.globalAlpha = (op.a ?? 1) * ease
    ctx.drawImage(op.image, 0, 0, this.w, this.h)
    ctx.restore()
    if (this.washProgress >= 1) {
      this.committedWashes.push({ img: op.image, a: op.a ?? 1 })
    }
    // brush sweeps across the sheet
    this.penTX = this.w * 0.1 + this.w * 0.8 * this.washProgress
    this.penTY = this.h * 0.12
    this.penDown = false
    return spent
  }

  // ------------------------------------------------------------- overlay

  private renderOverlay(dt: number) {
    const ctx = this.octx
    ctx.clearRect(0, 0, this.w, this.h)
    const busy = !this.isDone()
    // gantry eases toward the pen
    const k = Math.min(1, dt * (busy ? 18 : 6))
    this.penX += (this.penTX - this.penX) * k
    this.penY += (this.penTY - this.penY) * k

    const dark = PAPERS[this.style].dark
    const hair = dark ? 'rgba(214,232,255,0.44)' : 'rgba(60,40,20,0.4)'
    const metal = dark ? 'rgba(235,244,255,0.9)' : 'rgba(46,30,14,0.85)'

    if (busy) {
      ctx.save()
      ctx.strokeStyle = hair
      ctx.lineWidth = 1
      ctx.setLineDash([1, 3])
      ctx.beginPath()
      ctx.moveTo(0, this.penY)
      ctx.lineTo(this.w, this.penY)
      ctx.moveTo(this.penX, 0)
      ctx.lineTo(this.penX, this.h)
      ctx.stroke()
      ctx.setLineDash([])
      // carriage blocks at the rails
      ctx.fillStyle = metal
      ctx.fillRect(this.penX - 7, -1, 14, 5)
      ctx.fillRect(this.penX - 7, this.h - 4, 14, 5)
      ctx.fillRect(-1, this.penY - 7, 5, 14)
      ctx.fillRect(this.w - 4, this.penY - 7, 5, 14)
      // the pen head
      ctx.strokeStyle = metal
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.arc(this.penX, this.penY, 7.5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(this.penX, this.penY, 1.6, 0, Math.PI * 2)
      ctx.fillStyle = metal
      ctx.fill()
      ctx.restore()
    }

    // tide preview: where the coastline would move to
    if (this.previewLines) {
      ctx.save()
      ctx.strokeStyle = dark ? 'rgba(190,220,255,0.75)' : 'rgba(46,84,130,0.7)'
      ctx.lineWidth = 1.1
      ctx.setLineDash([5, 4])
      for (const line of this.previewLines) {
        if (line.length < 4) continue
        ctx.beginPath()
        ctx.moveTo(line[0], line[1])
        for (let i = 2; i < line.length; i += 2) ctx.lineTo(line[i], line[i + 1])
        ctx.stroke()
      }
      ctx.restore()
    }

    // sounding ripples
    if (this.ripples.length) {
      ctx.save()
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const rp = this.ripples[i]
        rp.t += dt
        const life = 0.9
        if (rp.t > life) {
          this.ripples.splice(i, 1)
          continue
        }
        const q = rp.t / life
        ctx.strokeStyle = dark ? 'rgba(220,238,255,1)' : 'rgba(70,50,25,1)'
        for (let ring = 0; ring < 2; ring++) {
          const rr = (q * 26 + ring * 7) * (1 + ring * 0.2)
          ctx.globalAlpha = Math.max(0, 0.5 * (1 - q) - ring * 0.12)
          ctx.beginPath()
          ctx.arc(rp.x, rp.y, rr, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
      ctx.restore()
    }
  }

  private emitStatus(force = false) {
    this.statusAt = performance.now()
    const layer = this.curLayer
    const verb = this.isDone()
      ? 'SURVEY COMPLETE'
      : this.liveActive
        ? LAYER_VERBS.user
        : layer
          ? LAYER_VERBS[layer]
          : 'PREPARING THE SHEET'
    this.hooks.onStatus?.({
      verb,
      layer,
      progress: this.progress(),
      plotting: !this.isDone(),
    })
  }

  // ------------------------------------------------------------- paper

  private paintPaper() {
    if (!this.w || !this.h) return
    const ctx = this.pctx
    const r = PAPERS[this.style]
    const rng = mulberry32(0xbeef ^ this.w ^ (this.style === 'cyan' ? 99 : this.style === 'field' ? 7 : 0))
    const w = this.w
    const h = this.h

    const g = ctx.createLinearGradient(0, 0, w * 0.2, h)
    g.addColorStop(0, r.base)
    g.addColorStop(1, r.base2)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)

    // mottling
    for (let i = 0; i < 260; i++) {
      const x = rng() * w
      const y = rng() * h
      const rad = 24 + rng() * 110
      const grad = ctx.createRadialGradient(x, y, 0, x, y, rad)
      grad.addColorStop(0, r.mottle)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2)
    }
    // laid lines (chain texture of period paper)
    if (!r.dark) {
      ctx.strokeStyle = 'rgba(90,70,40,0.028)'
      ctx.lineWidth = 1
      for (let y = 2; y < h; y += 3.4) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
    }
    // fibres
    for (let i = 0; i < 1500; i++) {
      const x = rng() * w
      const y = rng() * h
      const a = rng() * Math.PI
      const len = 3 + rng() * 11
      ctx.strokeStyle = rng() < 0.5 ? r.fiber : r.fiberLight
      ctx.lineWidth = 0.7
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
      ctx.stroke()
    }
    // stains
    for (let i = 0; i < 6; i++) {
      const x = rng() * w
      const y = rng() * h
      const rad = 50 + rng() * 150
      const grad = ctx.createRadialGradient(x, y, rad * 0.55, x, y, rad)
      grad.addColorStop(0, 'rgba(0,0,0,0)')
      grad.addColorStop(0.8, r.stain)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, rad, 0, Math.PI * 2)
      ctx.fill()
    }
    // edge burn
    const edge = (x0: number, y0: number, x1: number, y1: number) => {
      const grad = ctx.createLinearGradient(x0, y0, x1, y1)
      grad.addColorStop(0, r.edge)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)
    }
    const e = 30
    edge(0, 0, e, 0)
    edge(w, 0, w - e, 0)
    edge(0, 0, 0, e)
    edge(0, h, 0, h - e)
  }
}
