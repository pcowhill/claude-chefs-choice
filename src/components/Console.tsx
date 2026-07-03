import { ChartMeta, LayerId } from '../engine/chartops'
import { STYLE_LABEL, StyleId } from '../engine/pens'
import { PlotterStatus } from '../engine/plotter'

export const SPEED_STEPS = [0.25, 0.5, 1, 2, 4, 8] as const

const TOGGLES: { id: LayerId; label: string }[] = [
  { id: 'relief', label: 'RELIEF' },
  { id: 'soundings', label: 'SOUNDINGS' },
  { id: 'rhumbs', label: 'RHUMBS' },
  { id: 'names', label: 'NAMES' },
  { id: 'track', label: 'TRACK' },
]

interface Props {
  status: PlotterStatus
  meta: ChartMeta | null
  style: StyleId
  onStyle: (s: StyleId) => void
  tide: number
  onTide: (t: number) => void
  speedIdx: number
  onSpeedIdx: (i: number) => void
  layersOff: LayerId[]
  onToggleLayer: (l: LayerId) => void
  audioOn: boolean
  onAudio: (on: boolean) => void
  onNew: () => void
  onFinish: () => void
  uiClick: () => void
}

export default function Console(p: Props) {
  const datumFt = Math.round(p.tide * 90)
  const styles: StyleId[] = ['fair', 'field', 'cyan']

  return (
    <aside className="console">
      <header className="masthead">
        <div className="masthead-rule" />
        <h1>THE CHART ROOM</h1>
        <div className="masthead-sub">AUTOMATIC HYDROGRAPHIC DRAFTING ENGINE</div>
        <div className="masthead-rule" />
      </header>

      <div className="status-window">
        <div className="status-verb">{p.status.verb}</div>
        <div className="progress-rail">
          <div
            className="progress-fill"
            style={{ width: `${Math.round(p.status.progress * 100)}%` }}
          />
        </div>
        {p.meta && (
          <div className="status-meta">
            <span>
              SURVEY N° {p.meta.surveyNo} · SHEET {p.meta.sheetRoman}
            </span>
            <span className="status-sea">THE {p.meta.seaName} SEA · {p.meta.year}</span>
            {p.meta.landFraction < 0.02 && (
              <span className="status-remark">OPEN OCEAN — NO LAND WITHIN THE SHEET</span>
            )}
          </div>
        )}
      </div>

      <div className="btn-row">
        <button
          className="btn primary"
          onClick={() => {
            p.uiClick()
            p.onNew()
          }}
        >
          NEW SURVEY <span className="kbd">N</span>
        </button>
        <button
          className="btn"
          onClick={() => {
            p.uiClick()
            p.onFinish()
          }}
          title="Complete the plot at once"
        >
          FINISH <span className="kbd">F</span>
        </button>
      </div>

      <section>
        <div className="sec-label">
          <span>DRAFTING MODE</span>
          <span className="kbd">1·2·3</span>
        </div>
        <div className="mode-row">
          {styles.map((s) => (
            <button
              key={s}
              className={`mode ${p.style === s ? 'active' : ''}`}
              onClick={() => {
                p.uiClick()
                p.onStyle(s)
              }}
            >
              {STYLE_LABEL[s]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="sec-label">
          <span>TIDE · DATUM</span>
          <span className="tide-read">
            {datumFt === 0 ? 'MEAN LOW WATER' : `${datumFt > 0 ? '+' : '−'}${Math.abs(datumFt)} FT`}
          </span>
        </div>
        <input
          type="range"
          min={-100}
          max={100}
          step={2}
          value={Math.round(p.tide * 100)}
          onChange={(e) => p.onTide(Number(e.target.value) / 100)}
          aria-label="Tide datum"
        />
        <div className="under-note">or turn the scroll wheel over the sheet</div>
      </section>

      <section>
        <div className="sec-label">
          <span>PLOT RATE</span>
          <span className="tide-read">
            {SPEED_STEPS[p.speedIdx] < 1 ? `1⁄${Math.round(1 / SPEED_STEPS[p.speedIdx])}` : `${SPEED_STEPS[p.speedIdx]}`}×
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={SPEED_STEPS.length - 1}
          step={1}
          value={p.speedIdx}
          onChange={(e) => p.onSpeedIdx(Number(e.target.value))}
          aria-label="Plot rate"
        />
      </section>

      <section>
        <div className="sec-label">
          <span>ENGRAVED LAYERS</span>
        </div>
        <div className="switch-grid">
          {TOGGLES.map((t) => {
            const on = !p.layersOff.includes(t.id)
            return (
              <label className={`switch ${on ? 'on' : ''}`} key={t.id}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    p.uiClick()
                    p.onToggleLayer(t.id)
                  }}
                />
                <span className="lever" />
                <span className="switch-label">{t.label}</span>
              </label>
            )
          })}
        </div>
      </section>

      <section>
        <div className="sec-label">
          <span>AEOLIAN APPARATUS</span>
          <span className="kbd">M</span>
        </div>
        <label className={`switch ${p.audioOn ? 'on' : ''}`}>
          <input type="checkbox" checked={p.audioOn} onChange={(e) => p.onAudio(e.target.checked)} />
          <span className="lever" />
          <span className="switch-label">{p.audioOn ? 'SOUND ENGAGED' : 'MUTED'}</span>
        </label>
      </section>

      <footer className="hints">
        <div>— Click open water to cast the lead & sound the depth.</div>
        <div>— Drag the sheet to survey adjacent waters; arrows likewise.</div>
        <div>— The tide wheel redraws every coast at the new datum.</div>
      </footer>

      <div className="maker-plate">Nº 113 · PATENT MDCCCLXXXVII</div>
    </aside>
  )
}
