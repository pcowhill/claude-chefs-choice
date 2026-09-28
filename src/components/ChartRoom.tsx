import { MutableRefObject, useEffect, useRef, useState } from 'react'
import { AudioEngine } from '../engine/audio'
import {
  ChartBuild,
  ChartMeta,
  LayerId,
  buildChart,
  contoursForPreview,
  levelForTide,
  userSoundingOps,
} from '../engine/chartops'
import { StyleId } from '../engine/pens'
import { Plotter, PlotterStatus } from '../engine/plotter'
import { Terrain, TerrainGrid } from '../engine/terrain'

/** How many nautical miles of ocean one sheet spans, west to east. */
export const VIEW_MILES = 58
const MARGIN = 46
const PAPER_RATIO = 1.5

export interface ChartRoomBus {
  finish: () => void
}

interface Props {
  seed: number
  sheetIndex: number
  centerX: number
  centerY: number
  style: StyleId
  tide: number
  speed: number
  layersKey: string // comma-joined LayerIds that are OFF
  audio: AudioEngine
  bus: MutableRefObject<ChartRoomBus | null>
  onStatus: (s: PlotterStatus) => void
  onMeta: (m: ChartMeta) => void
  onPan: (dxMiles: number, dyMiles: number) => void
  onTide: (t: number) => void
}

export default function ChartRoom(p: Props) {
  const holderRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLCanvasElement>(null)
  const washRef = useRef<HTMLCanvasElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const plotterRef = useRef<Plotter | null>(null)
  const terrainRef = useRef<{ seed: number; t: Terrain } | null>(null)
  const gridCacheRef = useRef<{ key: string; grid: TerrainGrid } | null>(null)
  const buildRef = useRef<ChartBuild | null>(null)
  const winRef = useRef({ x0: 0, y0: 0, w: 1, h: 1 })
  const soundingsRef = useRef<{ x: number; y: number }[]>([])
  const tideNowRef = useRef(p.tide)

  const [size, setSize] = useState({ w: 0, h: 0, v: 0 })
  const [fontsReady, setFontsReady] = useState(false)
  const [committedTide, setCommittedTide] = useState(p.tide)

  // latest-props refs so long-lived closures stay fresh
  const propsRef = useRef(p)
  propsRef.current = p

  // ------------------------------------------------------------ fonts
  useEffect(() => {
    let alive = true
    Promise.all([
      document.fonts.load('12px "IM Fell English"'),
      document.fonts.load('italic 12px "IM Fell English"'),
      document.fonts.load('12px "IM Fell English SC"'),
    ])
      .then(() => document.fonts.ready)
      .then(() => {
        if (alive) setFontsReady(true)
      })
      .catch(() => setFontsReady(true))
    return () => {
      alive = false
    }
  }, [])

  // ------------------------------------------------------------ plotter + loop
  useEffect(() => {
    const plotter = new Plotter(
      paperRef.current!,
      washRef.current!,
      inkRef.current!,
      overlayRef.current!,
      {
        onStatus: (s) => propsRef.current.onStatus(s),
        onLayerChange: () => propsRef.current.audio.thunk(),
        onComplete: () => propsRef.current.audio.bell(),
        onActivity: (px) => propsRef.current.audio.setScratch(px),
      },
    )
    plotterRef.current = plotter
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      plotter.tick(dt)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ------------------------------------------------------------ sizing
  useEffect(() => {
    const el = holderRef.current!
    const measure = () => {
      const availW = el.clientWidth - 56
      const availH = el.clientHeight - 48
      if (availW < 200 || availH < 200) return
      let w = Math.min(availW, availH * PAPER_RATIO)
      let h = w / PAPER_RATIO
      if (h > availH) {
        h = availH
        w = h * PAPER_RATIO
      }
      w = Math.round(w)
      h = Math.round(h)
      setSize((s) => (s.w === w && s.h === h ? s : { w, h, v: s.v + 1 }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!size.w || !plotterRef.current) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    plotterRef.current.resize(size.w, size.h, dpr)
  }, [size])

  // ------------------------------------------------------------ style repaint
  useEffect(() => {
    plotterRef.current?.setStyle(p.style)
  }, [p.style])

  useEffect(() => {
    if (plotterRef.current) plotterRef.current.speed = p.speed
  }, [p.speed])

  // ------------------------------------------------------------ tide preview + debounce
  useEffect(() => {
    tideNowRef.current = p.tide
    const build = buildRef.current
    const plotter = plotterRef.current
    if (!build || !plotter) {
      setCommittedTide(p.tide)
      return
    }
    if (p.tide === committedTide) return
    plotter.setPreview(contoursForPreview(build.grid, levelForTide(build.grid, p.tide), build.inner))
    const timer = window.setTimeout(() => setCommittedTide(tideNowRef.current), 320)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.tide])

  // ------------------------------------------------------------ build + plot
  const prevRef = useRef({ world: '', look: '', size: 0 })
  useEffect(() => {
    if (!size.w || !fontsReady || !plotterRef.current) return
    const plotter = plotterRef.current

    if (!terrainRef.current || terrainRef.current.seed !== p.seed) {
      terrainRef.current = { seed: p.seed, t: new Terrain(p.seed) }
    }
    const terrain = terrainRef.current.t

    const innerW = size.w - 2 * MARGIN
    const innerH = size.h - 2 * MARGIN
    const winW = VIEW_MILES
    const winH = VIEW_MILES * (innerH / innerW)
    const win = { x0: p.centerX - winW / 2, y0: p.centerY - winH / 2, w: winW, h: winH }
    winRef.current = win

    const worldKey = `${p.seed}:${p.sheetIndex}:${p.centerX.toFixed(2)}:${p.centerY.toFixed(2)}`
    const lookKey = `${p.style}:${committedTide.toFixed(3)}:${p.layersKey}`
    const wasDone = plotter.isDone()
    const firstRun = prevRef.current.world === ''
    const freshWorld = prevRef.current.world !== worldKey
    const sizeChanged = !firstRun && prevRef.current.size !== size.v
    prevRef.current = { world: worldKey, look: lookKey, size: size.v }

    const cached =
      !freshWorld && !sizeChanged && gridCacheRef.current?.key === worldKey
        ? gridCacheRef.current.grid
        : undefined

    const build = buildChart({
      terrain,
      seed: p.seed,
      win,
      sheetW: size.w,
      sheetH: size.h,
      margin: MARGIN,
      tide: committedTide,
      style: p.style,
      layersOff: new Set(p.layersKey ? (p.layersKey.split(',') as LayerId[]) : []),
      userSoundings: soundingsRef.current,
      sheetIndex: p.sheetIndex,
      cachedGrid: cached,
    })
    buildRef.current = build
    gridCacheRef.current = { key: worldKey, grid: build.grid }
    plotter.setPreview(null)
    if (import.meta.env.DEV) {
      const counts: Record<string, number> = {}
      for (const op of build.ops) counts[op.layer] = (counts[op.layer] ?? 0) + 1
      ;(window as unknown as { __chartLayers?: unknown }).__chartLayers = counts
    }

    // fresh worlds get the full ceremony; adjustments are brisk redrafts
    const boost = firstRun || (freshWorld && !sizeChanged) ? 1 : sizeChanged ? 5 : 6.5
    plotter.load(build.ops, boost)
    if (sizeChanged && wasDone) plotter.finishInstantly()
    propsRef.current.onMeta(build.meta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, fontsReady, p.seed, p.sheetIndex, p.centerX, p.centerY, p.style, committedTide, p.layersKey])

  // ------------------------------------------------------------ bus commands
  useEffect(() => {
    p.bus.current = {
      finish: () => plotterRef.current?.finishInstantly(),
    }
    return () => {
      p.bus.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------ pointer interaction
  useEffect(() => {
    const stack = stackRef.current!
    let downX = 0
    let downY = 0
    let dragging = false
    let pointerId = -1

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      pointerId = e.pointerId
      stack.setPointerCapture(e.pointerId)
      downX = e.clientX
      downY = e.clientY
      dragging = false
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      const dx = e.clientX - downX
      const dy = e.clientY - downY
      if (!dragging && Math.hypot(dx, dy) > 7) {
        dragging = true
        stack.style.cursor = 'grabbing'
      }
      if (dragging) {
        stack.style.transform = `translate(${dx}px, ${dy}px)`
      }
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      pointerId = -1
      const dx = e.clientX - downX
      const dy = e.clientY - downY
      stack.style.cursor = ''
      if (dragging) {
        dragging = false
        stack.style.transform = ''
        const build = buildRef.current
        if (!build) return
        const mpp = winRef.current.w / build.inner.w
        propsRef.current.audio.thunk()
        propsRef.current.onPan(-dx * mpp, -dy * mpp)
        return
      }
      // a click: take a sounding
      const build = buildRef.current
      const plotter = plotterRef.current
      if (!build || !plotter) return
      const rect = stack.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const { inner } = build
      if (px < inner.x + 4 || px > inner.x + inner.w - 4 || py < inner.y + 4 || py > inner.y + inner.h - 4) return
      const win = winRef.current
      const wx = win.x0 + ((px - inner.x) / inner.w) * win.w
      const wy = win.y0 + ((py - inner.y) / inner.h) * win.h
      soundingsRef.current.push({ x: wx, y: wy })
      if (soundingsRef.current.length > 240) soundingsRef.current.shift()
      const terrain = terrainRef.current!.t
      plotter.enqueueLive(userSoundingOps(terrain, build.seaLevel, { x: wx, y: wy }, px, py))
      plotter.addRipple(px, py)
      propsRef.current.audio.plop()
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const t = Math.max(-1, Math.min(1, tideNowRef.current + (e.deltaY > 0 ? -1 : 1) * 0.06))
      propsRef.current.onTide(t)
    }

    stack.addEventListener('pointerdown', onDown)
    stack.addEventListener('pointermove', onMove)
    stack.addEventListener('pointerup', onUp)
    stack.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stack.removeEventListener('pointerdown', onDown)
      stack.removeEventListener('pointermove', onMove)
      stack.removeEventListener('pointerup', onUp)
      stack.removeEventListener('wheel', onWheel)
    }
  }, [])

  return (
    <div className="chart-holder" ref={holderRef}>
      <div
        className="sheet-stack"
        ref={stackRef}
        style={{ width: size.w || 100, height: size.h || 66 }}
      >
        <canvas ref={paperRef} />
        <canvas ref={washRef} />
        <canvas ref={inkRef} />
        <canvas ref={overlayRef} />
        {!fontsReady && <div className="sheet-booting">WARMING THE ENGINE…</div>}
      </div>
    </div>
  )
}
