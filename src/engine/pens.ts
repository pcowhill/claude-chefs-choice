/**
 * The instrument's pen rack. Ops name pens semantically ('ink', 'red', …);
 * the active drafting style decides what each pen physically is —
 * iron-gall ink on a fair copy, graphite on a field sheet, white light
 * on a cyanotype. Swapping styles re-inks the same survey.
 */

export type StyleId = 'fair' | 'field' | 'cyan'
export type PenId = 'ink' | 'inkFaint' | 'red' | 'redFaint' | 'blue'

export interface PenSpec {
  color: string
  alpha: number
  widthMul: number
  jitter: number // hand-wobble amplitude, px
}

export const PALETTES: Record<StyleId, Record<PenId, PenSpec>> = {
  fair: {
    ink: { color: '#33291d', alpha: 0.92, widthMul: 1, jitter: 0.35 },
    inkFaint: { color: '#4d3f2c', alpha: 0.5, widthMul: 1, jitter: 0.3 },
    red: { color: '#8e3520', alpha: 0.82, widthMul: 1, jitter: 0.35 },
    redFaint: { color: '#9c4a33', alpha: 0.4, widthMul: 1, jitter: 0.3 },
    blue: { color: '#274a6d', alpha: 0.9, widthMul: 1, jitter: 0.4 },
  },
  field: {
    ink: { color: '#3f3d38', alpha: 0.78, widthMul: 1.15, jitter: 0.85 },
    inkFaint: { color: '#54514a', alpha: 0.42, widthMul: 1.1, jitter: 0.8 },
    red: { color: '#8d4a3c', alpha: 0.72, widthMul: 1.2, jitter: 0.9 },
    redFaint: { color: '#96584a', alpha: 0.32, widthMul: 1.1, jitter: 0.8 },
    blue: { color: '#46586b', alpha: 0.72, widthMul: 1.2, jitter: 0.9 },
  },
  cyan: {
    ink: { color: '#eaf3ff', alpha: 0.9, widthMul: 1, jitter: 0.3 },
    inkFaint: { color: '#cfe2f8', alpha: 0.42, widthMul: 1, jitter: 0.3 },
    red: { color: '#ffd9a8', alpha: 0.78, widthMul: 1, jitter: 0.3 },
    redFaint: { color: '#f4cfa6', alpha: 0.36, widthMul: 1, jitter: 0.3 },
    blue: { color: '#ffffff', alpha: 0.9, widthMul: 1, jitter: 0.35 },
  },
}

export interface WashColors {
  land: string
  landHigh: string
  shallow1: string // < 3 fathoms
  shallow2: string // < 10
  shallow3: string // < 20
  coastShade: string
}

export const WASHES: Record<StyleId, WashColors> = {
  fair: {
    land: 'rgba(203,178,122,0.42)',
    landHigh: 'rgba(187,156,102,0.55)',
    shallow1: 'rgba(147,188,196,0.42)',
    shallow2: 'rgba(160,197,204,0.26)',
    shallow3: 'rgba(174,205,211,0.13)',
    coastShade: 'rgba(116,148,158,0.25)',
  },
  field: {
    land: 'rgba(172,159,120,0.15)',
    landHigh: 'rgba(160,146,106,0.2)',
    shallow1: 'rgba(150,180,188,0.13)',
    shallow2: 'rgba(160,190,196,0.08)',
    shallow3: 'rgba(174,200,206,0.04)',
    coastShade: 'rgba(120,150,160,0.08)',
  },
  cyan: {
    land: 'rgba(214,232,255,0.14)',
    landHigh: 'rgba(228,240,255,0.2)',
    shallow1: 'rgba(235,246,255,0.17)',
    shallow2: 'rgba(235,246,255,0.10)',
    shallow3: 'rgba(235,246,255,0.05)',
    coastShade: 'rgba(255,255,255,0.10)',
  },
}

export interface PaperRecipe {
  base: string
  base2: string
  mottle: string // rgba with alpha
  fiber: string
  fiberLight: string
  stain: string
  edge: string
  dark: boolean
}

export const PAPERS: Record<StyleId, PaperRecipe> = {
  fair: {
    base: '#e7dabb',
    base2: '#dccaa2',
    mottle: 'rgba(130,100,58,0.045)',
    fiber: 'rgba(96,74,48,0.05)',
    fiberLight: 'rgba(255,248,225,0.05)',
    stain: 'rgba(146,108,58,0.035)',
    edge: 'rgba(74,52,28,0.32)',
    dark: false,
  },
  field: {
    base: '#ece2c8',
    base2: '#e2d6b4',
    mottle: 'rgba(120,100,64,0.045)',
    fiber: 'rgba(100,84,56,0.06)',
    fiberLight: 'rgba(255,250,232,0.06)',
    stain: 'rgba(140,110,66,0.028)',
    edge: 'rgba(80,60,34,0.26)',
    dark: false,
  },
  cyan: {
    base: '#173a63',
    base2: '#0e2846',
    mottle: 'rgba(6,16,32,0.16)',
    fiber: 'rgba(200,224,255,0.022)',
    fiberLight: 'rgba(220,238,255,0.03)',
    stain: 'rgba(190,220,255,0.04)',
    edge: 'rgba(2,8,18,0.5)',
    dark: true,
  },
}

export const STYLE_LABEL: Record<StyleId, string> = {
  fair: 'FAIR COPY',
  field: 'FIELD SHEET',
  cyan: 'CYANOTYPE',
}
