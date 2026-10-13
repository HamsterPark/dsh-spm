/**
 * Unit tests of the pieces behind `stm_fft_peaks` and `stm_detect_blobs` that the
 * parity golden does not reach on its own: the small NumPy/Python helpers, the
 * tools' answers for frames they cannot use, and the two tools through a real dsh
 * dispatcher (reply, label block, image block). The transform, `next_fast_len`, the
 * frequency axis and the optimizer's refusals and rare branches are numerics'
 * (`fft-mixed.test.ts`, `spectral.test.ts`, `least-squares.test.ts`). Parity with the
 * reference itself is `measure-fft-blobs.parity.test.ts`.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef } from 'dsh-spm-compat'
import { greyDilation, matOf, rectSE } from 'dsh-spm-numerics'
import { afterAll, describe, expect, it } from 'vitest'
import { FrameArchive } from './archive.js'
import { MARK_RGB } from './draw.js'
import * as plugin from './plugin.js'
import { blobGeometry, BlobError, detectBlobs, findBlobs, MAX_BLOBS, scipyGaussianKernel } from './detect-blobs.js'
import { fftPeaks, interpIndex, longestFiniteRows, maximumFilter, spectrumPeaks, SpectrumSizeError } from './fft-peaks.js'
import { decodePng, encodePngRgb, pngSize, toRgb } from './png.js'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

describe('the spectrum pieces', () => {
  it('interp at index positions: ends, knots, between, NaN', () => {
    const fp = Float64Array.from([10, 20, 40])
    expect([interpIndex(-1, fp), interpIndex(5, fp), interpIndex(2, fp), interpIndex(1, fp), interpIndex(1.25, fp)]).toEqual([10, 40, 40, 20, 25])
    expect(interpIndex(Number.NaN, fp)).toBeNaN()
  })

  it('the separable maximum filter equals grey dilation with a square (nearest)', () => {
    const rnd = seeded(3)
    const a = Float64Array.from({ length: 9 * 11 }, rnd)
    a[17] = -Infinity
    const want = greyDilation(matOf(9, 11, a), rectSE(5, 5), 'nearest')
    expect(Array.from(maximumFilter(a, 9, 11, 5))).toEqual(Array.from(want.data))
  })

  it('keeps the longest run of acquired rows, the first on ties', () => {
    const z = Float64Array.from({ length: 8 * 2 }, () => 1)
    for (const r of [2, 5]) z.fill(Number.NaN, r * 2, r * 2 + 2)
    expect(longestFiniteRows(z, 2, 8)).toEqual({ start: 0, rows: 2 })
    z[1 * 2] = Number.NaN // a row half acquired still counts
    expect(longestFiniteRows(z, 2, 8)).toEqual({ start: 0, rows: 2 })
    expect(longestFiniteRows(new Float64Array(4).fill(Number.NaN), 2, 2)).toEqual({ start: 0, rows: 0 })
  })

  it('refuses fewer than 8 x 8 pixels', () => {
    expect(() => spectrumPeaks(new Float64Array(7 * 9), 9, 7, 0.1, 0.1)).toThrow(SpectrumSizeError)
  })
})

describe('Python and NumPy semantics', () => {
  it('SciPy\'s Gaussian kernel: radius int(4 sigma + 0.5), normalised', () => {
    const k = scipyGaussianKernel(0.82)
    expect(k.length).toBe(2 * 3 + 1)
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15)
    expect(k[0]).toBe(k[6])
  })

})

describe('find_blobs edges', () => {
  it('refuses fewer than 64 acquired pixels', () => {
    const z = new Float64Array(16 * 16).fill(Number.NaN)
    z.fill(0, 0, 63)
    expect(() => findBlobs(z, 16, 16, { dxNm: 0.1, dyNm: 0.1 })).toThrow(BlobError)
  })

  it('finds one Gaussian on a flat frame, and the geometry reads it', () => {
    const n = 48
    const z = new Float64Array(n * n)
    const rnd = seeded(11)
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        const dx = c + 0.5 - 20.3
        const dy = r + 0.5 - 25.6
        z[r * n + c] = 50e-12 * Math.exp(-0.5 * ((dx / 2.4) ** 2 + (dy / 1.4) ** 2)) + 1e-12 * rnd()
      }
    }
    const res = findBlobs(z, n, n, { dxNm: 0.2, dyNm: 0.2 })
    expect(res.blobs.length).toBe(1)
    const b = res.blobs[0]!
    expect(b.fit).toBe('gaussian')
    expect(b.col).toBeCloseTo(20.3, 2)
    expect(b.row).toBeCloseTo(25.6, 2)
    const e = { nm_per_px: 0.2, extra: {}, geometry: { angle_deg: 0 } } as never
    const g = blobGeometry(e, b)
    expect(g.fwhm_x_nm).toBeCloseTo(2.3548 * 2.4 * 0.2, 2)
    expect(g.fwhm_y_nm).toBeCloseTo(2.3548 * 1.4 * 0.2, 2)
    expect(g.elongation).toBeCloseTo(2.4 / 1.4, 1)
    expect(Math.min(g.axis_angle_deg, 180 - g.axis_angle_deg)).toBeLessThan(1)
  })
})

describe('the tools on frames they cannot use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-units-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'frames')
  // a spectrum frame, as an index record read back (the archive takes spectra from MAST's files)
  const arc0 = new FrameArchive(root, { displayMax: 64 })
  void arc0
  writeFileSync(join(root, 't0005.d0.png'), encodePngRgb(1, 1, new Uint8Array(3)))
  writeFileSync(
    join(root, 'index.jsonl'),
    `${JSON.stringify({ fid: 't0005.d0', turn: 5, kind: 'd', index: 0, source_name: 'sts', channels: ['Bias (V)'], nx: 8, ny: 1 })}\n`,
  )
  const arc = new FrameArchive(root, { displayMax: 64 })

  it('a spectrum is not a scan frame', () => {
    expect(fftPeaks(arc, { frame: 't0005.d0' })).toEqual({ ok: false, error: 'fft_peaks: frame: t0005.d0 is a spectrum; this tool needs a scan frame' })
    expect(detectBlobs(arc, { frame: 't0005.d0' })).toEqual({ ok: false, error: 'detect_blobs: frame: t0005.d0 is a spectrum; this tool needs a scan frame' })
  })

  it('caps max_n at 50 (spec/deviations.md D-VMEM-9)', () => {
    expect(MAX_BLOBS).toBe(50)
    const e = arc.addPartial(6, { Z: { rows: 16, cols: 16, data: new Float32Array(256) } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 3.2, h_nm: 3.2 } })
    expect(detectBlobs(arc, { frame: e.fid, max_n: 51 })).toEqual({ ok: false, error: 'detect_blobs: arguments.max_n must be <= 50' })
    expect(detectBlobs(arc, { frame: e.fid, max_n: 50 }).ok).toBe(true)
  })
})

// ── through a real dsh dispatcher ─────────────────────────────────────────

class FakeAttachments extends Service {
  readonly saved: Uint8Array[] = []
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }): Promise<ImageAttachmentRef> {
    this.saved.push(input.data)
    const { width, height } = pngSize(input.data)
    return Promise.resolve({
      attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`,
      mediaType: 'image/png',
      bytes: input.data.length,
      width,
      height,
      ...(input.name === undefined ? {} : { name: input.name }),
    } as unknown as ImageAttachmentRef)
  }
}

describe('the dsh tools', () => {
  const contexts: Context[] = []
  const roots: string[] = []
  afterAll(async () => {
    for (const c of contexts) await c.registry.delete(plugin)
    for (const r of roots) rmSync(r, { recursive: true, force: true })
  })

  /** A 96 x 96 frame, 0.2 nm per pixel: a grating of period 1.6 nm plus three Gaussian bumps. */
  async function host(): Promise<{ ctx: Context; att: FakeAttachments }> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    const att = new FakeAttachments(ctx)
    const root = mkdtempSync(join(tmpdir(), 'measure-dsh-'))
    roots.push(root)
    await ctx.plugin(plugin, { root, displayMax: 192 }).await()
    const n = 96
    const rnd = seeded(5)
    const z = new Float32Array(n * n)
    const bumps: readonly (readonly [number, number])[] = [[20.3, 30.6], [60.5, 40.2], [45.1, 75.7]]
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        let v = 4e-12 * Math.cos((2 * Math.PI * (c + 0.5)) / 8) + 0.5e-12 * rnd()
        for (const [bc, br] of bumps) v += 40e-12 * Math.exp((-0.5 * ((c + 0.5 - bc) ** 2 + (r + 0.5 - br) ** 2)) / 1.8 ** 2)
        z[r * n + c] = v
      }
    }
    ctx.frameArchive.addPartial(0, { Z: { rows: n, cols: n, data: z } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 19.2, h_nm: 19.2 } })
    return { ctx, att }
  }

  let k = 0
  const call = (ctx: Context, name: string, args: unknown) => {
    k += 1
    return ctx.tools.execute({ name, callId: `fb-${k}` as never, arguments: args, signal: new AbortController().signal })
  }
  const texts = (content: readonly { type: string }[]): string[] =>
    content.filter((b) => b.type === 'text').map((b) => (b as unknown as { text: string }).text)
  /** Pixels of the mark colour in a delivered PNG. */
  const markPixels = (png: Uint8Array): number => {
    const rgb = toRgb(decodePng(png))
    let hits = 0
    for (let i = 0; i < rgb.length; i += 3) if (rgb[i] === MARK_RGB[0] && rgb[i + 1] === MARK_RGB[1] && rgb[i + 2] === MARK_RGB[2]) hits += 1
    return hits
  }

  it('stm_fft_peaks returns the reply, then the numbered spectrum with its label', async () => {
    const { ctx, att } = await host()
    const res = await call(ctx, 'stm_fft_peaks', { frame: 't0000.p0', n_peaks: 2 })
    expect(res.isError).toBe(false)
    expect(res.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    const [reply, label] = texts(res.content)
    const body = JSON.parse(reply as string)
    expect(body).toMatchObject({ instrument_unchanged: true, frame: 't0000.p0', image: { frame: 't0000.m0' } })
    expect(body.peaks[0].period_nm).toBeCloseTo(1.6, 2)
    expect(label).toContain('<visual kind="derived" frame="t0000.m0" derived="fft_peaks" frames="t0000.p0" channel="Z" direction="forward" spectrum="log magnitude"')
    expect(label).toMatch(/marks="\d+ numbered peaks" size="\d+x\d+"\/>/)
    expect(markPixels(att.saved[0] as Uint8Array)).toBeGreaterThan(0)
  })

  it('stm_detect_blobs returns the reply, then the frame with numbered rings', async () => {
    const { ctx, att } = await host()
    const res = await call(ctx, 'stm_detect_blobs', { frame: 't0000.p0' })
    expect(res.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    const [reply, label] = texts(res.content)
    const body = JSON.parse(reply as string)
    expect(body.n_blobs).toBe(3)
    expect(body.blobs.map((b: { fit: string }) => b.fit)).toEqual(['gaussian', 'gaussian', 'gaussian'])
    expect(label).toContain(
      'derived="detect_blobs" frames="t0000.p0" channel="Z" direction="forward" flatten="plane" region="0,0,192,192" magnification="1" marks="3 numbered rings" size="192x192"',
    )
    const image = res.content[2] as { type: 'image'; attachment: ImageAttachmentRef }
    expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 192, height: 192, name: 't0000.m0.png' })
    expect(markPixels(att.saved[0] as Uint8Array)).toBeGreaterThan(0)
  })

  it('refusals are values; ranges are in the descriptions', async () => {
    const { ctx } = await host()
    const bad = await call(ctx, 'stm_detect_blobs', { frame: 't0000.p0', max_n: 60 })
    expect(bad.isError).toBe(false)
    expect(JSON.parse(texts(bad.content)[0] as string)).toEqual({ error: 'detect_blobs: arguments.max_n must be <= 50', instrument_unchanged: true })
    const small = await call(ctx, 'stm_fft_peaks', { frame: 't0000.p0', region: { x: 0, y: 0, width: 10, height: 10 } })
    expect(JSON.parse(texts(small.content)[0] as string).error).toBe('fft_peaks: the region needs at least 8 x 8 acquired pixels for a spectrum')
    const fft = ctx.tools.schemas().find((s) => s.name === 'stm_fft_peaks')
    expect(JSON.stringify(fft?.parameters)).toContain('Maximum number of peaks listed, 1 to 20. Default 6.')
    const blobs = ctx.tools.schemas().find((s) => s.name === 'stm_detect_blobs')
    expect(JSON.stringify(blobs?.parameters)).toContain('the highest: 1 to 50. Default 50.')
    expect(JSON.stringify(blobs?.parameters)).toContain('at most 192x192')
  })
})
