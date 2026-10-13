/**
 * One vocabulary for everything the model reads: the reference's guard
 * (`test_model_facing_json_vocabulary` in STM-Bench `tests/test_vista_measure.py`),
 * ported. Every JSON reply a visual tool returns through a real dsh dispatcher,
 * and every frame summary, keeps the shared rules: frame ids under `frame`,
 * American spelling, units as key suffixes, numbers as JSON numbers, and no
 * `type`, `unit`, `measurement` or `visual_kind` field.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef } from 'dsh-spm-compat'
import { afterEach, describe, expect, it } from 'vitest'
import { entryFromRecord, entrySummary } from './archive.js'
import { encodePngRgb, pngSize } from './png.js'
import * as plugin from './plugin.js'
import { encodeSyntheticSxm } from './synthetic-sxm.js'

const FORBIDDEN_KEYS = new Set(['fid', 'type', 'visual_kind', 'measurement', 'unit', 'setpoint_a', 'centre_nm'])

/** Strings that Python's float() accepts: surrounding whitespace, digit underscores, inf and nan. */
const PY_FLOAT = /^[+-]?(?:(?:\p{Nd}(?:_?\p{Nd})*)?\.\p{Nd}(?:_?\p{Nd})*|\p{Nd}(?:_?\p{Nd})*\.?)(?:e[+-]?\p{Nd}(?:_?\p{Nd})*)?$|^[+-]?(?:inf|infinity|nan)$/iu

/** Keys and values that break the model-facing JSON rules, as paths (the reference's `_vocabulary_violations`). */
function vocabularyViolations(obj: unknown, path = '$'): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => vocabularyViolations(v, `${path}[${i}]`))
  if (typeof obj === 'string') return PY_FLOAT.test(obj.trim()) ? [`${path} = ${JSON.stringify(obj)} (numeric string)`] : []
  if (obj === null || typeof obj !== 'object') return []
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const siSuffix = (k.endsWith('_a') || k.endsWith('_m')) && k !== 'frame_a' && k !== 'frame_b' // diff's parameters
    if (FORBIDDEN_KEYS.has(k) || k.includes('centre') || k.includes('colour') || siSuffix) out.push(`${path}.${k}`)
    out.push(...vocabularyViolations(v, `${path}.${k}`))
  }
  return out
}

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.registry.delete(plugin)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

class FakeAttachments extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }): Promise<ImageAttachmentRef> {
    const { width, height } = pngSize(input.data)
    return Promise.resolve({ attachmentId: `sha256:${'0'.repeat(64)}`, mediaType: 'image/png', bytes: input.data.length, width, height } as unknown as ImageAttachmentRef)
  }
}

/** A dsh context with the tool runtime, optionally the attachment service, and the plugin (display_max 256). */
async function host(withAttachments: boolean): Promise<Context> {
  const root = mkdtempSync(join(tmpdir(), 'vm-vocab-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  if (withAttachments) new FakeAttachments(ctx)
  await ctx.plugin(plugin, { root, displayMax: 256 }).await()
  return ctx
}

let n = 0
/** The text blocks the model would receive for one call. */
async function call(ctx: Context, name: string, args: unknown): Promise<string[]> {
  n += 1
  const res = await ctx.tools.execute({ name, callId: `vocab-${n}` as never, arguments: args, signal: new AbortController().signal })
  if (res.isError) throw new Error(`${name}: dsh refused the call`)
  return res.content.filter((b) => b.type === 'text').map((b) => (b as unknown as { text: string }).text)
}

describe('the vocabulary guard', () => {
  it('flags what the reference flags', () => {
    const numeric = ['1.5', ' -2 ', '1e-3', '1_000', 'nan', 'Infinity', '.5', '5.', '+inf', '-NaN', '1E5', String.fromCodePoint(0x661, 0x662)]
    const text = ['1/2', 't0007.s0', '', '1e', '0x10', '_1', '1__0', '1_', '.', 'e5', '1.5.2', 'ON', 'inf_', '1 2']
    const got = vocabularyViolations({
      fid: 't0000.s0',
      a: {
        centre_nm: [1, 2], colour_scale: 'gray', setpoint_a: 1e-10, z_m: 2e-9, frame_a: 't0000.s0', frame_b: 't0001.s0',
        unit: 'pm', type: 'scan', measurement: 'z', visual_kind: 'inspection', center_nm: [0, 0], values_pm: [[1, null]],
      },
      numeric,
      text,
    })
    expect(got).toEqual([
      '$.fid',
      ...['centre_nm', 'colour_scale', 'setpoint_a', 'z_m', 'unit', 'type', 'measurement', 'visual_kind'].map((k) => `$.a.${k}`),
      ...numeric.map((s, i) => `$.numeric[${i}] = ${JSON.stringify(s)} (numeric string)`),
    ])
  })
})

/** Heights in metres on a cols x rows grid, a corrugation on a slope; rows from missingFrom on not acquired. */
function heights(cols: number, rows: number, missingFrom = rows): { rows: number; cols: number; data: Float64Array } {
  const data = Float64Array.from({ length: cols * rows }, (_, i) => {
    const x = i % cols
    const y = Math.floor(i / cols)
    return y >= missingFrom ? Number.NaN : 1e-11 * Math.sin(x / 5) * Math.cos(y / 7) + 2e-12 * x
  })
  return { rows, cols, data }
}

describe('model-facing JSON', () => {
  it('keeps every tool reply and every frame summary in the shared vocabulary', async () => {
    const ctx = await host(true)
    const archive = ctx.frameArchive.archive
    const g = { cx_nm: 3, cy_nm: -2, w_nm: 12.8, h_nm: 12.8, angle_deg: 10 }
    // The test frame of the reference: 128 x 128, rows from 100 on not acquired, a constant current.
    const fa = archive.addPartial(0, {
      Z: heights(128, 128, 100),
      'Z/backward': heights(128, 128, 100),
      Current: { rows: 128, cols: 128, data: new Float64Array(128 * 128).fill(1e-10) },
    }, { geometry: g, bias_v: 0.1, setpoint_a: 1e-10, scan_dir: 'down' }).fid
    const z16 = Float32Array.from(heights(16, 8).data)
    const fb = archive.addScanBytes(1, encodeSyntheticSxm({
      nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 1e-9, offsetYM: 2e-9, scanDir: 'up', biasV: -0.5, feedbackOn: true,
      setpointA: 2e-10, channels: [{ name: 'Z', unit: 'm', forward: z16, backward: z16 }],
    }), { sourceName: 'scan_001.sxm' }).fid
    const ff = archive.addPartial(2, { 'Frequency Shift': { rows: 8, cols: 8, data: Float64Array.from({ length: 64 }, (_, i) => -3 + 0.01 * i) } }, {
      geometry: { cx_nm: 0, cy_nm: 0, w_nm: 2, h_nm: 2 }, units: { 'Frequency Shift': 'Hz' }, setpoint_a: -2.5, setpoint_unit: 'Hz', feedback: 'OFF',
    }).fid
    const fw = archive.addPartial(2, { Z: heights(300, 20) }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 30, h_nm: 2 }, simS: 4.5 }).fid
    const fm = archive.addDerived(3, encodePngRgb(8, 4, new Uint8Array(96)), {
      tool: 'stm_fft_peaks', sources: [fa], description: 'log magnitude', labelAttrs: [['peaks', 3]],
    }).fid
    const fd = archive.addDerived(3, encodePngRgb(256, 192, new Uint8Array(256 * 192 * 3)), {
      tool: 'stm_frame_diff', sources: [fa, fb], geometry: { cx_nm: 0, cy_nm: 0, w_nm: 8, h_nm: 6 }, units: { diff: 'm' },
      arrays: { 'diff/forward': heights(16, 12) },
    }).fid

    const replies: Record<string, unknown>[] = []
    const json = async (c: Context, name: string, args: unknown): Promise<Record<string, unknown>> => {
      const [text] = await call(c, name, args)
      const reply = JSON.parse(text as string) as Record<string, unknown>
      replies.push(reply)
      return reply
    }
    const shown = await json(ctx, 'stm_inspect', {
      question: 'q',
      views: [
        { label: 'a', frame: fa },
        { label: 'b', frame: fa, channel: 'Current', region: { x: 10, y: 10, width: 50, height: 40 } },
        { label: 'c', frame: fa, direction: 'backward', flatten: 'highpass', highpass_nm: 1.5 },
        { label: 'd', frame: fb, flatten: 'line' },
        { label: 'e', frame: ff },
        { label: 'f', frame: fw, region: { x: 0, y: 0, width: 100, height: 10 } },
        { label: 'g', frame: fm, region: { x: 1, y: 1, width: 4, height: 2 } },
        { label: 'h', frame: fd },
      ],
    })
    expect(shown['view_count']).toBe(8)
    const read = await json(ctx, 'stm_read_values', {
      question: 'q',
      views: [
        { label: 'a', frame: fa, rows: 3, columns: 3 },
        { label: 'b', frame: fa, channel: 'Current', rows: 2, columns: 2 },
        { label: 'c', frame: fa, region: { x: 0, y: 190, width: 256, height: 66 }, rows: 2, columns: 2 },
        { label: 'd', frame: ff, channel: 'df', rows: 1, columns: 2 },
        { label: 'e', frame: fw, rows: 2, columns: 3 },
        { label: 'f', frame: fd, rows: 1, columns: 2 },
        { label: 'g', frame: fb, direction: 'backward', rows: 1, columns: 1 },
      ],
    })
    expect((read['views'] as Record<string, unknown>[])[2]).toHaveProperty('null_count')
    await json(ctx, 'stm_notes_write', { file: 'WORKING.md', content: 'scan the step edge next' })
    // Refusals are replies too.
    await json(ctx, 'stm_inspect', { question: 'q', views: [{ label: 'x', frame: 't0099.s0' }] })
    await json(ctx, 'stm_read_values', { question: 'q', views: [{ label: 'x', frame: fa, channel: 'Mystery', rows: 1, columns: 1 }] })
    await json(ctx, 'stm_notes_write', { file: 'GUIDE.md', content: '   ' })
    const refusalKeys = ['error', 'instrument_unchanged']
    expect(replies.slice(-3).map((r) => Object.keys(r))).toEqual([refusalKeys, refusalKeys, refusalKeys])
    // Without an attachment service the reply counts the images it could not deliver.
    const bare = await host(false)
    bare.frameArchive.archive.addPartial(0, { Z: heights(16, 8) }, { geometry: g })
    expect(await json(bare, 'stm_inspect', { question: 'q', views: [{ label: 'a', frame: 't0000.p0' }] })).toMatchObject({ images_not_delivered: 1 })
    for (const r of replies) expect(vocabularyViolations(r)).toEqual([])

    const spectrum = entryFromRecord({
      fid: 't0005.d0', turn: 5, kind: 'd', index: 0, source_name: 'sts.dat', channels: ['Bias (V)', 'Current (A)'], nx: 64,
      setpoint_a: 5e-11, extra: { position_nm: [1.5, -2.5], experiment: 'bias spectroscopy' },
    })
    const summaries = [...ctx.frameArchive.index(), entrySummary(spectrum)]
    expect(summaries.map((s) => s['kind'])).toEqual(['partial', 'scan', 'partial', 'partial', 'derived', 'derived', 'spectrum'])
    for (const s of summaries) expect(vocabularyViolations(s)).toEqual([])

    // The checks the reference makes on its test frame.
    const summ = entrySummary(archive.get(fa))
    expect(summ).toMatchObject({ frame: fa, kind: 'partial', rows_acquired: 100, rows_total: 128 })
    expect(summ['setpoint_pa']).toBeCloseTo(100, 9)
    expect(Number.isInteger(summ['display_scale'])).toBe(true)
    expect(new Set(Object.keys(summ))).toEqual(new Set([
      'frame', 'turn', 'kind', 'source', 'channels', 'directions', 'size_px', 'field_nm', 'center_nm', 'angle_deg',
      'nm_per_px', 'display_scale', 'display_size_px', 'default_channel', 'rows_acquired', 'rows_total', 'bias_v',
      'setpoint_pa', 'scan_dir',
    ]))
    expect(entrySummary(archive.get(fw))).toMatchObject({ display_scale: 0.5, display_scale_frac: '1/2', sim_s: 4.5 })
    expect(entrySummary(archive.get(ff))).toMatchObject({ setpoint_hz: -2.5, feedback: 'OFF' })
    expect(entrySummary(archive.get(fb))).toMatchObject({ kind: 'scan', feedback: 'ON', setpoint_pa: 200 })
  })
})
