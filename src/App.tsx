import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ChartRoom, { ChartRoomBus, VIEW_MILES } from './components/ChartRoom'
import Console, { SPEED_STEPS } from './components/Console'
import { AudioEngine } from './engine/audio'
import { ChartMeta, LayerId } from './engine/chartops'
import { StyleId } from './engine/pens'
import { PlotterStatus } from './engine/plotter'

function initialSeed(): number {
  const q = new URLSearchParams(window.location.search).get('seed')
  if (q && /^\d+$/.test(q)) return parseInt(q, 10) >>> 0
  return (Math.floor(Math.random() * 900000) + 1017) >>> 0
}

export default function App() {
  const [seed, setSeed] = useState(initialSeed)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [center, setCenter] = useState({ x: 0, y: 0 })
  const [style, setStyle] = useState<StyleId>('fair')
  const [tide, setTide] = useState(0)
  const [speedIdx, setSpeedIdx] = useState(2) // 1×
  const [layersOff, setLayersOff] = useState<LayerId[]>([])
  const [audioOn, setAudioOn] = useState(false)
  const [status, setStatus] = useState<PlotterStatus>({
    verb: 'PREPARING THE SHEET',
    layer: null,
    progress: 0,
    plotting: true,
  })
  const [meta, setMeta] = useState<ChartMeta | null>(null)

  const audio = useMemo(() => new AudioEngine(), [])
  const bus = useRef<ChartRoomBus | null>(null)

  const newSurvey = useCallback(() => {
    setSeed((Math.floor(Math.random() * 900000) + 1017) >>> 0)
    setCenter({ x: 0, y: 0 })
    setSheetIndex(0)
  }, [])

  const onPan = useCallback((dx: number, dy: number) => {
    setCenter((c) => ({ x: c.x + dx, y: c.y + dy }))
    setSheetIndex((i) => i + 1)
  }, [])

  const toggleLayer = useCallback((l: LayerId) => {
    setLayersOff((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l].sort()))
  }, [])

  const setAudio = useCallback(
    (on: boolean) => {
      setAudioOn(on)
      void audio.setEnabled(on)
    },
    [audio],
  )

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const half = VIEW_MILES / 2
      switch (e.key) {
        case 'n':
        case 'N':
          newSurvey()
          break
        case '1':
          setStyle('fair')
          break
        case '2':
          setStyle('field')
          break
        case '3':
          setStyle('cyan')
          break
        case 'f':
        case 'F':
          bus.current?.finish()
          break
        case 'm':
        case 'M':
          setAudio(!audio.enabled)
          break
        case '-':
        case '_':
          setSpeedIdx((i) => Math.max(0, i - 1))
          break
        case '=':
        case '+':
          setSpeedIdx((i) => Math.min(SPEED_STEPS.length - 1, i + 1))
          break
        case 'ArrowLeft':
          e.preventDefault()
          onPan(-half, 0)
          break
        case 'ArrowRight':
          e.preventDefault()
          onPan(half, 0)
          break
        case 'ArrowUp':
          e.preventDefault()
          onPan(0, -half * 0.66)
          break
        case 'ArrowDown':
          e.preventDefault()
          onPan(0, half * 0.66)
          break
        default:
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSurvey, onPan, setAudio, audio])

  const layersKey = layersOff.join(',')

  return (
    <div className="room">
      <div className="room-desk">
        <ChartRoom
          seed={seed}
          sheetIndex={sheetIndex}
          centerX={center.x}
          centerY={center.y}
          style={style}
          tide={tide}
          speed={SPEED_STEPS[speedIdx]}
          layersKey={layersKey}
          audio={audio}
          bus={bus}
          onStatus={setStatus}
          onMeta={setMeta}
          onPan={onPan}
          onTide={setTide}
        />
      </div>
      <Console
        status={status}
        meta={meta}
        style={style}
        onStyle={setStyle}
        tide={tide}
        onTide={setTide}
        speedIdx={speedIdx}
        onSpeedIdx={setSpeedIdx}
        layersOff={layersOff}
        onToggleLayer={toggleLayer}
        audioOn={audioOn}
        onAudio={setAudio}
        onNew={newSurvey}
        onFinish={() => bus.current?.finish()}
        uiClick={() => audio.click()}
      />
    </div>
  )
}
