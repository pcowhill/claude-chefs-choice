/**
 * The Aeolian Apparatus — every sound is synthesized on the spot.
 * Nib scratch is filtered noise that follows plotting activity; the rest
 * is small mechanical punctuation. Nothing plays until the user engages
 * the apparatus (muted by default, per good manners).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private scratchGain: GainNode | null = null
  private scratchFilter: BiquadFilterNode | null = null
  private roomGain: GainNode | null = null
  enabled = false

  private ensure() {
    if (this.ctx) return
    const ctx = new AudioContext()
    this.ctx = ctx
    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)
    this.master = master

    // nib scratch: white noise → bandpass → gain
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate)
    const data = noiseBuf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuf
    noise.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1700
    bp.Q.value = 1.1
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 700
    const sg = ctx.createGain()
    sg.gain.value = 0
    noise.connect(bp)
    bp.connect(hp)
    hp.connect(sg)
    sg.connect(master)
    noise.start()
    this.scratchGain = sg
    this.scratchFilter = bp

    // room tone: darker noise, barely there
    const room = ctx.createBufferSource()
    room.buffer = noiseBuf
    room.loop = true
    room.playbackRate.value = 0.31
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 240
    const rg = ctx.createGain()
    rg.gain.value = 0.012
    room.connect(lp)
    lp.connect(rg)
    rg.connect(master)
    room.start()
    this.roomGain = rg
  }

  async setEnabled(on: boolean) {
    this.enabled = on
    if (on) {
      this.ensure()
      await this.ctx!.resume()
      this.master!.gain.setTargetAtTime(0.5, this.ctx!.currentTime, 0.2)
    } else if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08)
    }
  }

  /** activity: rough px/sec of ink being laid right now. */
  setScratch(activity: number) {
    if (!this.enabled || !this.ctx || !this.scratchGain || !this.scratchFilter) return
    const t = this.ctx.currentTime
    const level = Math.min(1, activity / 2600)
    this.scratchGain.gain.setTargetAtTime(level * 0.16, t, 0.06)
    // faster plotting scratches brighter
    this.scratchFilter.frequency.setTargetAtTime(1300 + level * 1600 + Math.random() * 200, t, 0.12)
  }

  /** Small dry tick — a pen lift or a control detent. */
  click() {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 2400 + Math.random() * 600
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(0.05, t)
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.025)
    osc.connect(g)
    g.connect(this.master)
    osc.start(t)
    osc.stop(t + 0.03)
  }

  /** Carriage thunk on layer change. */
  thunk() {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(120, t)
    osc.frequency.exponentialRampToValueAtTime(52, t + 0.09)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.11, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
    osc.connect(g)
    g.connect(this.master)
    osc.start(t)
    osc.stop(t + 0.16)
  }

  /** Lead line hits the water. */
  plop() {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(640, t)
    osc.frequency.exponentialRampToValueAtTime(170, t + 0.16)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
    osc.connect(g)
    g.connect(this.master)
    osc.start(t)
    osc.stop(t + 0.22)
  }

  /** The office bell: sheet complete. */
  bell() {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const t = ctx.currentTime
    for (const [freq, amp, dur] of [
      [1244, 0.08, 1.4],
      [1866, 0.035, 0.9],
      [830, 0.03, 1.7],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq * (1 + (Math.random() - 0.5) * 0.004)
      const g = ctx.createGain()
      g.gain.setValueAtTime(amp, t)
      g.gain.exponentialRampToValueAtTime(0.0004, t + dur)
      osc.connect(g)
      g.connect(this.master)
      osc.start(t)
      osc.stop(t + dur + 0.05)
    }
  }
}
