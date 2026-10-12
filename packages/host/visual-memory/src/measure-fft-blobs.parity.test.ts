/**
 * Parity of `stm_fft_peaks` and `stm_detect_blobs` with the Python reference
 * (VISUAL-HARNESS §5).
 *
 * `spec/golden/measure_fft_blobs.json` is produced by
 * `tools/spec-export/export_measure_fft_blobs.py`, which runs VISTA-SPM's
 * `vista_spm/measure.py` (`spectrum_peaks`, `find_blobs`, the tools `fft_peaks` and
 * `detect_blobs` on a reference archive) and SciPy's `next_fast_len` and
 * `least_squares` on synthetic, seeded inputs (frames as float32, the archive's
 * precision); the reference file hashes and head are recorded in it.
 *
 * Exact (the same arithmetic in the same order, or integers and strings):
 * `next_fast_len` for 1..2200; the spectrum's sizes, zero padding, frequency axes,
 * k_min, Nyquist and DC lobe; peak counts and ranks; every fft_peaks reply (its numbers
 * are rounded to 2-6 decimals and agree there); reply keys and their order; derived frame
 * ids, labels and summaries, the archive index; error replies; the blob candidates,
 * noise, threshold and smoothing, and every detect_blobs field that does not come from a
 * fit; the marks' count and numbers.
 *
 * Within stated tolerances, and why:
 * - spectrum peak frequencies 1e-12 cycles/nm, angles 1e-9 deg, strengths 1e-11 robust
 *   units, the top log-magnitude 1e-13: pocketfft against the mixed-radix FFT here, and
 *   `log10` / `cos` of V8 against the C runtime, differ in the last bits (measured: below
 *   4e-14);
 * - `least_squares` (`least-squares.ts`): where the problem is well conditioned from its
 *   start, the iterate itself to 1e-8 and SciPy's `status`, `nfev` and `njev`; where the
 *   start is a circle (`sa == sb`, `theta == 0`, the way `_fit_blob` starts every fit) the
 *   first Jacobian's theta column is rounding noise of `exp`, so the path depends on the
 *   last bit of `exp` and only the fitted surface is compared (1e-5 of the amplitude);
 * - blob fits: for that reason the reference's own result moves when only the last bit of
 *   `exp` moves, as it does between C runtimes (V8's `Math.exp` differs from this NumPy's
 *   in about one input in eleven). The exporter reran every blob case with `exp`'s last bit
 *   flipped for a random 10 % of its inputs (40 runs per `find_blobs` case, 24 per tool
 *   call) and recorded the distinct outcomes (which blobs, which fit kind) and, per blob,
 *   the largest change within its outcome: up to 0.065 px and 19 deg on blobs whose fit
 *   sometimes ends with theta pinned at its +-pi bound, ~1e-6 px elsewhere. The port must
 *   produce one of those outcomes, and each quantity of each blob must lie within twice the
 *   largest change the reference showed for that quantity in that case (a finite number of
 *   reruns visits a rare branch for some blobs and not for others, so the case's largest
 *   change, not the blob's own, is the scale), at least 1e-6 px for positions and sigmas,
 *   1e-6 relative for heights and 1e-3 deg for the axis; each reply number likewise, or one
 *   unit of its last decimal;
 * - blob marks: their position and radius within the same tolerance in image pixels.
 *
 * Deviations (spec/deviations.md) are asserted as such, not skipped: D-VMEM-9 (`max_n` at
 * most 50) and D-VMEM-10 (equidistant pixels belong to the earlier candidate; the
 * reference's `cKDTree` agrees up to 16 candidates).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import golden from '../../../../spec/golden/measure_fft_blobs.json' with { type: 'json' }
import { entrySummary, FrameArchive } from './archive.js'
import { detectBlobs, findBlobs, gaussModel, type Blob } from './detect-blobs.js'
import { fftPeaks, nextFastLen, spectrumPeaks, type Mark, type MarkPainter } from './fft-peaks.js'
import { pyMod } from './pymath.js'
import { encodePngRgb } from './png.js'
import { leastSquares } from './least-squares.js'
import type { ViewToolResult } from './args.js'
import type { PartialGeometry, PartialMeta } from './scan-data.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = golden as any

function input(name: string): { data: Float32Array; rows: number; cols: number } {
  const d = G.inputs[name]
  const buf = Buffer.from(d.f32_b64 as string, 'base64')
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  return { data, rows: d.shape[0], cols: d.shape[1] }
}

/** Every key of a parsed reply, depth first in insertion order: the order the model reads. */
function keyPaths(obj: unknown, path = '$'): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => keyPaths(v, `${path}[${i}]`))
  if (obj === null || typeof obj !== 'object') return []
  return Object.entries(obj).flatMap(([k, v]) => [`${path}.${k}`, ...keyPaths(v, `${path}.${k}`)])
}

/** The reply as the model reads it: JSON text, parsed again. */
function parsed(r: ViewToolResult): any {
  if (!r.ok) return { error: r.error }
  return JSON.parse(JSON.stringify(r.reply))
}

describe('measure parity: reference and SciPy pieces', () => {
  it('records which reference it was exported from', () => {
    for (const k of ['measure_py_sha256', 'frames_py_sha256', 'archive_py_sha256', 'viewtools_py_sha256']) {
      expect(G.reference[k]).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(G.reference.max_blobs).toBe(200)
  })

  it('next_fast_len for 1..2200', () => {
    const got = (G.next_fast_len.sizes as number[]).map((_, i) => nextFastLen(i + 1))
    expect(got).toEqual(G.next_fast_len.sizes)
  })

  describe('least_squares (bounded TRF)', () => {
    for (const c of G.least_squares) {
      it(c.name, () => {
        const resid = (p: Float64Array): Float64Array => {
          const m = gaussModel(p, c.xs, c.ys)
          for (let i = 0; i < m.length; i += 1) m[i] = (m[i] as number) - (c.vs[i] as number)
          return m
        }
        const r = leastSquares(resid, c.p0, c.lo, c.hi, { maxNfev: c.max_nfev })
        expect(r.success).toBe(c.success)
        // the fitted surface does not depend on how the ellipse is parametrized
        const mine = gaussModel(r.x, c.xs, c.ys)
        const theirs = gaussModel(c.x, c.xs, c.ys)
        let worst = 0
        mine.forEach((v, i) => {
          worst = Math.max(worst, Math.abs(v - (theirs[i] as number)))
        })
        expect(worst).toBeLessThanOrEqual(1e-5)
        const exactPath = c.name === 'elongated_rotated'
        expect(Math.abs(r.cost - c.cost)).toBeLessThanOrEqual((exactPath ? 1e-9 : 1e-6) * c.cost)
        if (exactPath || c.name === 'max_nfev') {
          // conditioned enough that SciPy's path is followed step by step
          expect([r.status, r.nfev, r.njev]).toEqual([c.status, c.nfev, c.njev])
          r.x.forEach((v, i) => expect(Math.abs(v - (c.x[i] as number))).toBeLessThanOrEqual(c.name === 'max_nfev' ? 1e-6 : 1e-8))
        }
        // bounds that bind at SciPy's solution bind here too
        const boundBinds = (c.active_mask as number[]).map((a, i) => (i === 5 ? 0 : a))
        expect(Array.from(r.activeMask).map((a, i) => (i === 5 ? 0 : a))).toEqual(boundBinds)
      })
    }
  })
})

describe('measure parity: spectrum_peaks', () => {
  for (const c of G.spectrum_peaks) {
    it(c.name, () => {
      const z = input(c.input)
      const run = () =>
        spectrumPeaks(Float64Array.from(z.data), z.cols, z.rows, c.dx_nm, c.dy_nm, {
          ...(c.kwargs.n_peaks === undefined ? {} : { nPeaks: c.kwargs.n_peaks }),
          ...(c.kwargs.angle_deg === undefined ? {} : { angleDeg: c.kwargs.angle_deg }),
        })
      if (c.error !== undefined) {
        expect(run).toThrow(c.error)
        return
      }
      const r = run()
      const w = c.result
      expect([...r.shape]).toEqual(w.shape)
      expect([...r.padded]).toEqual(w.padded)
      expect(r.pad).toBe(w.pad)
      expect([r.k_min, r.k_nyq, ...r.dc_lobe_per_nm]).toEqual([w.k_min, w.k_nyq, ...w.dc_lobe_per_nm])
      expect([r.fx[0], r.fx[1], r.fx.at(-1)]).toEqual(w.fx_ends)
      expect([r.fy[0], r.fy[1], r.fy.at(-1)]).toEqual(w.fy_ends)
      let top = -Infinity
      for (const v of r.logmag) top = Math.max(top, v)
      expect(Math.abs(top - w.logmag_max)).toBeLessThanOrEqual(1e-13)
      expect(r.peaks.length).toBe(w.peaks.length)
      r.peaks.forEach((p, i) => {
        const q = w.peaks[i]
        for (const k of ['k_per_nm', 'period_nm', 'kx_per_nm', 'ky_per_nm', 'ku', 'kv'] as const) {
          expect(Math.abs(p[k] - q[k])).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(q[k])))
        }
        expect(Math.abs(p.angle_deg - q.angle_deg)).toBeLessThanOrEqual(1e-9)
        expect(Math.abs(p.strength - q.strength)).toBeLessThanOrEqual(1e-11)
      })
    })
  }
})

// ── blob comparisons under the reference's libm spread ─────────────────────

interface Spread {
  readonly position_px: number
  readonly height_rel: number
  readonly sigma_px: number
  readonly major_angle_deg: number
}

function majorAngle(b: { sa: number; sb: number; theta: number }): number {
  const th = b.sa >= b.sb ? b.theta : b.theta + Math.PI / 2
  return pyMod(th * (180 / Math.PI), 180)
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 180
  return Math.min(d, 180 - d)
}

function sameFitBlobs(a: readonly any[], b: readonly any[]): boolean {
  return a.length === b.length && a.every((x, i) => x.fit === b[i].fit && Math.abs(x.col - b[i].col) < 0.5 && Math.abs(x.row - b[i].row) < 0.5)
}

/** The largest recorded change of each quantity over every blob of every outcome of a case. */
function caseSpread(libm: any): Record<string, number> {
  const out: Record<string, number> = {}
  for (const o of libm.outcomes as any[]) {
    for (const s of o.spread as Record<string, number>[]) for (const [k, v] of Object.entries(s)) out[k] = Math.max(out[k] ?? 0, v)
  }
  return out
}

/** The port's blobs are one of the reference's outcomes, each quantity within twice the case's largest change. */
function expectBlobsInSpread(got: readonly Blob[], libm: any, what: string): void {
  const outcome = (libm.outcomes as any[]).find((o) => sameFitBlobs(got, o.blobs))
  expect(outcome, `${what}: ${got.length} blobs (${got.map((b) => b.fit[0]).join('')}) is not an outcome of the reference`).toBeDefined()
  const s = caseSpread(libm) as unknown as Spread
  got.forEach((b, i) => {
    const w = outcome.blobs[i]
    const where = `${what} blob ${i + 1}`
    const pos = Math.max(2 * s.position_px, 1e-6)
    expect(Math.abs(b.col - w.col), `${where} col`).toBeLessThanOrEqual(pos)
    expect(Math.abs(b.row - w.row), `${where} row`).toBeLessThanOrEqual(pos)
    if (w.height !== 0) expect(Math.abs(b.height - w.height) / Math.abs(w.height), `${where} height`).toBeLessThanOrEqual(Math.max(2 * s.height_rel, 1e-6))
    const sig = Math.max(2 * s.sigma_px, 1e-6)
    expect(Math.abs(Math.max(b.sa, b.sb) - Math.max(w.sa, w.sb)), `${where} major sigma`).toBeLessThanOrEqual(sig)
    expect(Math.abs(Math.min(b.sa, b.sb) - Math.min(w.sa, w.sb)), `${where} minor sigma`).toBeLessThanOrEqual(sig)
    expect(angleDiff(majorAngle(b), majorAngle(w)), `${where} axis`).toBeLessThanOrEqual(Math.max(2 * s.major_angle_deg, 1e-3))
    expect(Math.abs(b.peak_sigma - w.peak_sigma), `${where} peak_sigma`).toBeLessThanOrEqual(1e-9 * Math.abs(w.peak_sigma))
  })
}

describe('measure parity: find_blobs', () => {
  for (const c of G.find_blobs) {
    it(c.name, () => {
      const z = input(c.input)
      const kw = c.kwargs
      const run = () =>
        findBlobs(Float64Array.from(z.data), z.cols, z.rows, {
          dxNm: c.dx_nm,
          dyNm: c.dy_nm,
          ...(kw.polarity === undefined ? {} : { polarity: kw.polarity }),
          ...(kw.background_nm === undefined ? {} : { backgroundNm: kw.background_nm }),
          ...(kw.min_height === undefined ? {} : { minHeight: kw.min_height }),
          ...(kw.min_sep_nm === undefined ? {} : { minSepNm: kw.min_sep_nm }),
          ...(kw.max_n === undefined ? {} : { maxN: kw.max_n }),
          ...(kw.box === undefined ? {} : { box: kw.box }),
        })
      if (c.error !== undefined) {
        expect(run).toThrow(c.error)
        return
      }
      const r = run()
      // D-VMEM-10: with more than 16 candidates the port matches the reference rerun with ties
      // given to the earlier candidate (the reference's cKDTree agrees only up to 16)
      const w = c.result_earlier_ties ?? c.result
      expect([r.n_candidates, r.truncated, r.sign, r.smoothing_px]).toEqual([w.n_candidates, w.truncated, w.sign, w.smoothing_px])
      for (const k of ['noise', 'noise_smoothed', 'threshold'] as const) {
        expect(Math.abs(r[k] - w[k])).toBeLessThanOrEqual(1e-12 * Math.abs(w[k]))
      }
      expectBlobsInSpread(r.blobs, c.libm, c.name)
    })
  }

  it('D-VMEM-10: how far the tie rule moves the reference itself (more than 16 candidates)', () => {
    let lattice = 0
    for (const c of G.find_blobs.filter((x: any) => x.result_earlier_ties !== undefined)) {
      const a = c.result.blobs
      const b = c.result_earlier_ties.blobs
      expect(a.length).toBe(b.length)
      a.forEach((x: any, i: number) => {
        lattice = Math.max(lattice, Math.abs(x.col - b[i].col), Math.abs(x.row - b[i].row))
      })
    }
    // measured on the golden: the 121-candidate lattice moves by up to 2e-3 px; 25 scattered blobs not at all
    expect(lattice).toBeGreaterThan(0)
    expect(lattice).toBeLessThanOrEqual(0.003)
  })
})

// ── the tools on a replica of the reference archive ────────────────────────

const UNIT: Readonly<Record<string, number>> = {
  x_px: 0.01,
  y_px: 0.01,
  x_nm: 1e-4,
  y_nm: 1e-4,
  fwhm_x_nm: 1e-3,
  fwhm_y_nm: 1e-3,
  fwhm_major_nm: 1e-3,
  fwhm_minor_nm: 1e-3,
  elongation: 0.01,
  axis_angle_deg: 0.1,
}

function sameReplyBlobs(a: readonly any[], b: readonly any[]): boolean {
  return a.length === b.length && a.every((x, i) => x.fit === b[i].fit && Math.abs(x.x_px - b[i].x_px) < 0.5 && Math.abs(x.y_px - b[i].y_px) < 0.5)
}

/** Reply blobs: one of the reference's outcomes, each number within twice the case's largest change or one unit of its last decimal. */
function expectReplyBlobs(got: readonly any[], libm: any, heightUnit: number, what: string): Record<string, number> {
  const outcome = (libm.outcomes as any[]).find((o) => sameReplyBlobs(got, o.blobs))
  expect(outcome, `${what}: not an outcome of the reference`).toBeDefined()
  const tol: Record<string, number> = {}
  const s = caseSpread(libm)
  got.forEach((b, i) => {
    const w = outcome.blobs[i]
    expect(Object.keys(b).sort()).toEqual(Object.keys(w).sort())
    expect([b.id, b.fit]).toEqual([w.id, w.fit])
    for (const [k, v] of Object.entries(b)) {
      if (k === 'id' || k === 'fit') continue
      const unit = UNIT[k] ?? (k.startsWith('height_') ? heightUnit : 0)
      const t = Math.max(2 * (s[k] ?? 0), unit) + 1e-9
      tol[k] = Math.max(tol[k] ?? 0, t)
      if (v === null || w[k] === null) expect(v).toBe(w[k])
      else if (k === 'axis_angle_deg') expect(angleDiff(v as number, w[k]), `${what} blob ${i + 1} ${k}`).toBeLessThanOrEqual(t)
      else expect(Math.abs((v as number) - w[k]), `${what} blob ${i + 1} ${k}`).toBeLessThanOrEqual(t)
    }
  })
  return tol
}

describe('measure parity: the tools', () => {
  const T = G.tools
  const dir = mkdtempSync(join(tmpdir(), 'measure-parity-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const arc = new FrameArchive(join(dir, 'frames'), { displayMax: T.display_max })
  const frames = (Object.values(T.frames) as any[]).sort((a, b) => a.seq - b.seq)
  for (const f of frames) {
    const arrays = Object.fromEntries(
      ((f.arrays ?? []) as [string, string][]).map(([k, name]) => {
        const z = input(name)
        return [k, { rows: z.rows, cols: z.cols, data: z.data }]
      }),
    )
    if (f.kind === 'partial') {
      arc.addPartial(f.turn, arrays, { ...(f.meta as PartialMeta), geometry: f.geometry as PartialGeometry })
    } else {
      arc.addDerived(f.turn, new Uint8Array(Buffer.from(f.png_b64 as string, 'base64')), {
        tool: f.tool,
        sources: f.sources,
        ...(f.arrays === undefined ? {} : { arrays, geometry: f.geometry, units: f.units }),
      })
    }
  }

  const built = arc.frames().map((e) => e.fid)
  it('rebuilds the same frames', () => {
    expect(built).toEqual(frames.map((f) => f.fid))
  })

  // the calls run in the exporter's order, so derived frame ids line up; the marks are captured
  // where the image is drawn
  let drawn: Mark[] = []
  const capture: MarkPainter = (rgb, w, h, marks) => {
    drawn = [...marks]
    return encodePngRgb(w, h, rgb)
  }
  const call = (c: any): { r: ViewToolResult; marks: Mark[] } => {
    drawn = []
    const r = c.tool === 'fft_peaks' ? fftPeaks(arc, c.args, capture) : detectBlobs(arc, c.args, capture)
    return { r, marks: drawn }
  }
  const results = (T.cases as any[]).map(call)
  const errors = (T.errors as any[]).map((c) => call(c).r)
  const lattice = [call(T.lattice.ckdtree).r, call(T.lattice.earlier_ties).r]
  const deviations = (T.deviations as any[]).map((c) => call(c).r)

  ;(T.cases as any[]).forEach((c, k) => {
    it(`${c.tool} ${JSON.stringify(c.args)}`, () => {
      const { r, marks } = results[k] as { r: ViewToolResult; marks: Mark[] }
      const got = parsed(r)
      expect(r.ok, got.error).toBe(true)
      expect(keyPaths(got)).toEqual(c.key_paths)
      const want = c.derived.marks as [number, number, number, string][]
      expect(marks.map((m) => m.text)).toEqual(want.map((m) => m[3]))
      if (c.tool === 'fft_peaks') {
        expect(got).toEqual(c.reply)
        marks.forEach((m, i) => {
          const [x, y, rad] = want[i] as [number, number, number, string]
          for (const [a, b] of [[m.x, x], [m.y, y], [m.r, rad]] as const) expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)))
        })
      } else {
        const { blobs, ...rest } = got
        const { blobs: wantBlobs, ...wantRest } = c.reply
        expect(rest).toEqual(wantRest)
        const e = arc.get(c.args.frame)
        const unit = 10 ** -arc.fmt(e, arc.resolveChannel(e, c.args.channel)).decimals
        const tol = expectReplyBlobs(blobs, c.libm, unit, JSON.stringify(c.args))
        // marks sit at the centroids, sized by the major FWHM: the same tolerance in image px
        const mag = got.image.image_px_per_display_px as number
        const perNative = mag * e.display_scale // image px per scan px
        const nm = Math.sqrt((e.nm_per_px as number) * (e.extra.nm_per_px_y ?? (e.nm_per_px as number)))
        marks.forEach((m, i) => {
          const [x, y, rad] = want[i] as [number, number, number, string]
          expect(Math.abs(m.x - x)).toBeLessThanOrEqual(((tol['x_px'] ?? 0) + 0.01) * mag)
          expect(Math.abs(m.y - y)).toBeLessThanOrEqual(((tol['y_px'] ?? 0) + 0.01) * mag)
          expect(Math.abs(m.r - rad)).toBeLessThanOrEqual(0.65 * (((tol['fwhm_major_nm'] ?? 0) + 1e-3) / nm) * perNative)
        })
      }
      // the derived image: archived like the reference's, labelled the same way
      if (!r.ok) return
      const d = c.derived
      expect(got.image.frame).toBe(d.frame)
      expect(r.images.map((i) => i.label)).toEqual([d.label])
      expect(entrySummary(arc.get(d.frame))).toEqual(d.summary)
      expect([...arc.get(d.frame).display_size]).toEqual(d.size_px)
    })
  })

  it('errors: the reference\'s refusals, word for word', () => {
    ;(T.errors as any[]).forEach((c, k) => {
      const r = errors[k] as ViewToolResult
      expect(r.ok).toBe(false)
      const got = parsed(r).error as string
      if (c.args?.max_n === 201) {
        // D-VMEM-9: the same refusal, against this port's bound
        expect(c.reply.error).toBe('detect_blobs: arguments.max_n must be <= 200')
        expect(got).toBe('detect_blobs: arguments.max_n must be <= 50')
      } else {
        expect(got, JSON.stringify(c.args)).toBe(c.reply.error)
      }
    })
  })

  it('D-VMEM-10: the lattice (121 candidates) matches the reference with ties to the earlier candidate', () => {
    const want = T.lattice.earlier_ties
    const got = parsed(lattice[1] as ViewToolResult)
    expect(keyPaths(got)).toEqual(want.key_paths)
    const { blobs, ...rest } = got
    const { blobs: wantBlobs, ...wantRest } = want.reply
    expect(rest).toEqual(wantRest)
    expectReplyBlobs(blobs, want.libm, 0.1, 'lattice')
    // against the reference's cKDTree: the same blobs, numbers moved by the tie rule
    const ck = T.lattice.ckdtree.reply
    const first = parsed(lattice[0] as ViewToolResult)
    expect(first.n_blobs).toBe(ck.n_blobs)
    expect(first.blobs.map((b: any) => b.fit)).toEqual(ck.blobs.map((b: any) => b.fit))
    first.blobs.forEach((b: any, i: number) => {
      expect(Math.abs(b.x_px - ck.blobs[i].x_px)).toBeLessThanOrEqual(0.03)
      expect(Math.abs(b.y_px - ck.blobs[i].y_px)).toBeLessThanOrEqual(0.03)
    })
  })

  it('D-VMEM-9: max_n above 50 is refused (the reference accepts up to 200)', () => {
    ;(T.deviations as any[]).forEach((c, k) => {
      expect(c.is_error).toBe(false) // the reference answered
      expect(parsed(deviations[k] as ViewToolResult)).toEqual({ error: 'detect_blobs: arguments.max_n must be <= 50' })
    })
    // the evidence: a 200-blob reply of the reference, centred far from the origin
    const ev = G.evidence.max_n_200
    expect(ev.n_blobs).toBe(200)
    expect(ev.reply_bytes).toBeGreaterThan(45_000)
    expect(ev.reply_bytes_without_blobs + 50 * ev.blob_bytes_max).toBeLessThan(12_000)
  })

  it('archives the same derived frames (none for the refused calls)', () => {
    const refused = new Set((T.deviations as any[]).map((c) => c.reply.image.frame))
    const want = (T.index as any[]).filter((s) => !refused.has(s.frame))
    expect(arc.index()).toEqual(want)
  })
})
