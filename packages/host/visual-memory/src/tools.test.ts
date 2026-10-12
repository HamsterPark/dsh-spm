/**
 * The tools through a REAL dsh dispatcher (`ToolRuntime` via dsh-spm-compat):
 * argument validation, the scheduler's concurrency classification and the
 * content blocks the model would receive are dsh's, not a stand-in's.
 * Only the attachment service is a fake — dsh's local store is not a
 * dependency of this repository (its behaviour is pinned in docs/dsh/facts.md §9).
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef } from 'dsh-spm-compat'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeSyntheticDat } from './synthetic-dat.js'
import { encodeSyntheticSxm } from './synthetic-sxm.js'
import { pngSize } from './png.js'
import * as plugin from './plugin.js'
import { renderViewValue, VISUAL_TOOL_NAMES } from './tools.js'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.registry.delete(plugin)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Saved {
  readonly data: Uint8Array
  readonly mediaType: string
  readonly name?: string
}

class FakeAttachments extends Service {
  readonly saved: Saved[] = []
  failWith: (Error & { code?: string }) | null = null
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: Saved): Promise<ImageAttachmentRef> {
    if (this.failWith !== null) return Promise.reject(this.failWith)
    this.saved.push(input)
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

function zFrame(): Float32Array {
  return Float32Array.from({ length: 128 }, (_, i) => 2e-12 * (i % 16) + 1e-12 * Math.floor(i / 16))
}

async function host(
  withAttachments = true,
  config: { readonly grid?: boolean } = {},
): Promise<{ ctx: Context; root: string; att: FakeAttachments | undefined }> {
  const root = mkdtempSync(join(tmpdir(), 'vm-tools-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const prompt = ctx.plugin(SystemPrompt)
  await prompt.await()
  const tools = ctx.plugin(ToolRuntime)
  await tools.await()
  const att = withAttachments ? new FakeAttachments(ctx) : undefined
  const fiber = ctx.plugin(plugin, { root, displayMax: 64, ...config })
  await fiber.await()
  ctx.frameArchive.archive.addScanBytes(
    0,
    encodeSyntheticSxm({
      nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 1e-9, offsetYM: 2e-9, scanDir: 'down',
      channels: [{ name: 'Z', unit: 'm', forward: zFrame() }],
    }),
    { sourceName: 's.sxm' },
  )
  return { ctx, root, att }
}

let n = 0
function call(ctx: Context, name: string, args: unknown) {
  n += 1
  return ctx.tools.execute({
    name,
    callId: `call-${n}` as Parameters<typeof ctx.tools.execute>[0]['callId'],
    arguments: args,
    signal: new AbortController().signal,
  })
}

function texts(content: readonly { type: string }[]): string[] {
  return content.filter((b) => b.type === 'text').map((b) => (b as unknown as { text: string }).text)
}

describe('registration', () => {
  it('provides ctx.frameArchive and registers the four tools, which unload with the plugin', async () => {
    const { ctx } = await host()
    expect(ctx.frameArchive.archive.displayMax).toBe(64)
    const names = ctx.tools.schemas().map((s) => s.name)
    for (const t of VISUAL_TOOL_NAMES) expect(names).toContain(t)
    await ctx.registry.delete(plugin)
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(ctx.tools.schemas().map((s) => s.name).filter((t) => t.startsWith('stm_'))).toEqual([])
  })

  it('puts ranges into descriptions, never into the schema, and marks every call concurrency-safe', async () => {
    const { ctx } = await host()
    const validArgs: Record<string, unknown> = {
      stm_inspect: { question: 'q', views: [{ label: 'v', frame: 't0000.s0' }] },
      stm_read_values: { question: 'q', views: [{ label: 'v', frame: 't0000.s0', rows: 1, columns: 1 }] },
      stm_notes_read: { file: 'GUIDE.md' },
      stm_notes_write: { file: 'WORKING.md', content: 'x' },
    }
    for (const s of ctx.tools.schemas().filter((x) => x.name.startsWith('stm_'))) {
      expect(JSON.stringify(s.parameters)).not.toMatch(/"(minimum|maximum|minItems|maxItems|minLength|maxLength)"/)
      expect(s.description).toMatch(/does not change the instrument|without changing the instrument/)
      const exec = (args: unknown) => ctx.tools.executionMode({ name: s.name, callId: 'x' as never, arguments: args, signal: new AbortController().signal })
      expect(exec(validArgs[s.name])).toEqual({ kind: 'parallel' })
      expect(exec({})).toEqual({ kind: 'exclusive' }) // dsh validates before classifying
    }
    const inspect = ctx.tools.schemas().find((s) => s.name === 'stm_inspect')
    expect(inspect?.description).toContain('1 to 16 views per call')
    expect(inspect?.description).toContain('fits 64x64')
    const read = ctx.tools.schemas().find((s) => s.name === 'stm_read_values')
    expect(read?.description).toContain('at most 4096')
    expect(inspect?.description).toContain('a saved scan, a partial scan, a spectrum or a derived image')
    expect(inspect?.description).toContain('A spectrum view is a line plot (x_col, y_col, x_range instead of region)')
    expect(read?.description).toContain("For a spectrum view, give x_range (in the x column's unit), n and y_cols instead")
    expect(read?.description).toContain('n x (1 + number of y_cols) for a spectrum')
  })

  it('draws the graph paper by default and says so; grid: false draws and says nothing', async () => {
    const on = await host()
    expect(on.ctx.frameArchive.archive.grid).toBe(true)
    const dOn = on.ctx.tools.schemas().find((s) => s.name === 'stm_inspect')?.description ?? ''
    expect(dOn).toContain('amber lines draw a square grid every grid_nm nm')
    expect(dOn).toContain('the grid spacing (grid_nm),')
    expect(on.ctx.frameArchive.observation('t0000.s0').label).toMatch(/ grid_nm="[0-9.]+" /)
    const off = await host(true, { grid: false })
    expect(off.ctx.frameArchive.archive.grid).toBe(false)
    const dOff = off.ctx.tools.schemas().find((s) => s.name === 'stm_inspect')?.description ?? ''
    expect(dOff).toContain('nothing is drawn on them.')
    expect(dOff).not.toContain('grid')
    expect(off.ctx.frameArchive.observation('t0000.s0').label).not.toContain('grid_nm')
  })

  it('needs a root directory, and registers nothing without one', () => {
    const ctx = new Context()
    expect(() => new plugin.FrameArchiveService(ctx, {} as never)).toThrow(/needs config\.root/)
    expect(() => new plugin.FrameArchiveService(ctx, { root: '  ' })).toThrow(/needs config\.root/)
    expect(ctx.get('frameArchive')).toBeUndefined()
  })
})

describe('stm_inspect', () => {
  it('returns the reply text, then per view a label block and an image block that references the attachment', async () => {
    const { ctx, att } = await host()
    const res = await call(ctx, 'stm_inspect', {
      question: 'what is here?',
      views: [{ label: 'whole', frame: 't0000.s0' }, { label: 'zoom', frame: 't0000.s0', region: { x: 0, y: 0, width: 16, height: 8 } }],
    })
    expect(res.isError).toBe(false)
    const types = res.content.map((b) => b.type)
    expect(types).toEqual(['text', 'text', 'image', 'text', 'image'])
    const [reply, label1, label2] = texts(res.content)
    expect(JSON.parse(reply as string)).toMatchObject({ view_count: 2, instrument_unchanged: true })
    expect(JSON.parse(reply as string)).not.toHaveProperty('visual_kind')
    expect(reply?.endsWith('\n')).toBe(true)
    expect(label1).toMatch(/^<visual kind="inspection" index="1" count="2" label="whole" frame="t0000\.s0" .*\/>\n$/)
    expect(label2).toContain('index="2" count="2" label="zoom"')
    const image = res.content[2] as { type: 'image'; attachment: ImageAttachmentRef }
    expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 64, height: 32, name: 't0000.s0.inspect-1.png' })
    expect(att?.saved.map((s) => [s.mediaType, s.name])).toEqual([['image/png', 't0000.s0.inspect-1.png'], ['image/png', 't0000.s0.inspect-2.png']])
    expect(String(image.attachment.attachmentId)).toBe(`sha256:${createHash('sha256').update((att?.saved[0] as Saved).data).digest('hex')}`)
  })

  it('answers invalid requests with a value, not a thrown error', async () => {
    const { ctx, att } = await host()
    const res = await call(ctx, 'stm_inspect', { question: 'q', views: [{ label: 'v', frame: 't0000.s0', region: { x: 60, y: 0, width: 8, height: 8 } }] })
    expect(res.isError).toBe(false)
    expect(JSON.parse(texts(res.content)[0] as string)).toEqual({
      error: expect.stringMatching(/^inspect: views\[1\]\.region x=60, y=0, width=8, height=8 leaves t0000\.s0's 64x32 display image/),
      instrument_unchanged: true,
    })
    expect(att?.saved).toEqual([])
  })

  it('leaves schema violations to dsh, which rejects them before the tool runs', async () => {
    const { ctx } = await host()
    const res = await call(ctx, 'stm_inspect', { views: [{ label: 'v', frame: 't0000.s0' }] })
    expect(res.isError).toBe(true)
    if (res.isError) expect(res.error.info?.code).toBe('INVALID_ARGS')
  })

  it('reports images it could not store instead of dropping them', async () => {
    const without = await host(false)
    const res = await call(without.ctx, 'stm_inspect', { question: 'q', views: [{ label: 'v', frame: 't0000.s0' }] })
    expect(res.content.map((b) => b.type)).toEqual(['text', 'text'])
    const [reply, label] = texts(res.content)
    expect(JSON.parse(reply as string)).toMatchObject({ images_not_delivered: 1 })
    expect(label).toMatch(/\[image not delivered: this composition has no attachment service \(ctx\.attachments\)\]\n$/)

    const failing = await host()
    ;(failing.att as FakeAttachments).failWith = Object.assign(new Error('too large'), { code: 'ATTACHMENT_TOO_LARGE' })
    const res2 = await call(failing.ctx, 'stm_inspect', { question: 'q', views: [{ label: 'v', frame: 't0000.s0' }] })
    expect(texts(res2.content)[1]).toContain('[image not delivered: ATTACHMENT_TOO_LARGE: too large]')
    ;(failing.att as FakeAttachments).failWith = 'plain string' as never
    const res3 = await call(failing.ctx, 'stm_inspect', { question: 'q', views: [{ label: 'v', frame: 't0000.s0' }] })
    expect(texts(res3.content)[1]).toContain('[image not delivered: plain string]')
  })
})

describe('spectrum views', () => {
  it('pass dsh\'s schema without rows or columns: a plot from stm_inspect, a readout from stm_read_values', async () => {
    const { ctx, att } = await host()
    const v = [-0.2, -0.1, 0, 0.1, 0.2]
    ctx.frameArchive.archive.addSpectrumBytes(1, encodeSyntheticDat({
      header: { Experiment: 'bias spectroscopy', 'Bias>Bias (V)': 0.2 },
      columns: [['Bias calc (V)', v], ['Current (A)', v.map((x) => x * 1e-10)]],
    }), { sourceName: 'sts.dat' })
    const shown = await call(ctx, 'stm_inspect', { question: 'q', views: [{ label: 'iv', frame: 't0001.d0', x_range: [-0.1, 0.2] }] })
    expect(shown.isError).toBe(false)
    expect(shown.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    const [reply, label] = texts(shown.content)
    expect(JSON.parse(reply as string).views[0]).toMatchObject({ kind: 'spectrum', n_points: 4, x_shown_v: [-0.1, 0.2], image_size_px: [600, 390] })
    expect(label).toBe('<visual kind="inspection" index="1" count="1" label="iv" frame="t0001.d0" plot="spectrum" x="Bias calc [V]" y="Current [pA]" points="4" size="600x390" x_range="-0.1..0.2"/>\n')
    expect((shown.content[2] as { attachment: ImageAttachmentRef }).attachment).toMatchObject({ width: 600, height: 390, name: 't0001.d0.inspect-1.png' })
    expect(att?.saved).toHaveLength(1)
    const read = await call(ctx, 'stm_read_values', { question: 'q', views: [{ label: 'iv', frame: 't0001.d0', n: 2, y_cols: ['current'] }] })
    expect(read.isError).toBe(false)
    expect(read.content.map((b) => b.type)).toEqual(['text'])
    expect(JSON.parse(texts(read.content)[0] as string)).toMatchObject({
      sample_count: 4, views: [{ column_names: ['Bias calc (V)', 'Current (A)'], sample_index: [1, 3], values: [[-0.1, 0.1], [-10, 10]] }],
    })
  })
})

describe('stm_read_values', () => {
  it('returns the readout as text', async () => {
    const { ctx } = await host()
    const res = await call(ctx, 'stm_read_values', { question: 'heights', views: [{ label: 'g', frame: 't0000.s0', rows: 1, columns: 2 }] })
    expect(res.content.map((b) => b.type)).toEqual(['text'])
    const reply = JSON.parse(texts(res.content)[0] as string)
    expect(reply).toMatchObject({ sample_count: 2, sampling: 'cell centers: x + ((2c+1)*width)//(2*columns), y likewise' })
    expect(reply.views[0]).toMatchObject({ decimals: 1, sample_x_px: [16, 48], sample_y_px: [16], values_pm: [[12, 28]] }) // native (4, 4) and (12, 4): 2c + r pm
  })

  it('refuses a reply larger than dsh shows in full, instead of letting it be cut', async () => {
    const { ctx } = await host()
    let s = 3
    const noise = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
    const big = Float32Array.from({ length: 64 * 64 }, () => -1.2345e-8 + 1e-10 * noise()) // about -12345.6 pm
    const e = ctx.frameArchive.addPartial(3, { Z: { rows: 64, cols: 64, data: big } }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 10, h_nm: 10 } })
    const views = Array.from({ length: 64 }, (_, i) => ({ label: `view ${i} `.padEnd(100, '.'), frame: e.fid, rows: 8, columns: 8 }))
    const res = await call(ctx, 'stm_read_values', { question: 'q', views })
    expect(res.isError).toBe(false)
    expect(JSON.parse(texts(res.content)[0] as string).error).toMatch(
      /^read_values: the reply would have \d+ bytes of text; a tool result is shown in full only up to 48000 bytes\. Ask for fewer views/,
    )
    const half = await call(ctx, 'stm_read_values', { question: 'q', views: views.slice(0, 32) })
    expect(JSON.parse(texts(half.content)[0] as string).sample_count).toBe(2048)
  })

  it('answers an unknown frame with a value', async () => {
    const { ctx } = await host()
    const res = await call(ctx, 'stm_read_values', { question: 'q', views: [{ label: 'g', frame: 't0004.s0', rows: 1, columns: 1 }] })
    expect(res.isError).toBe(false)
    expect(JSON.parse(texts(res.content)[0] as string).error).toMatch(/^read_values: views\[1\]\.frame: no frame "t0004\.s0"/)
  })
})

describe('notes tools', () => {
  it('reads the initial guide, says WORKING.md does not exist, then writes and reads it', async () => {
    const { ctx } = await host()
    expect(texts((await call(ctx, 'stm_notes_read', { file: 'GUIDE.md' })).content)).toEqual(['No reliable model yet.\n'])
    expect(texts((await call(ctx, 'stm_notes_read', { file: 'WORKING.md' })).content)).toEqual(['WORKING.md does not exist yet.'])
    const w = await call(ctx, 'stm_notes_write', { file: 'WORKING.md', content: ' next: rescan t0000.s0 \n' })
    expect(JSON.parse(texts(w.content)[0] as string)).toEqual({ saved: 'WORKING.md', bytes: 22 })
    expect(texts((await call(ctx, 'stm_notes_read', { file: 'WORKING.md' })).content)).toEqual(['next: rescan t0000.s0\n'])
  })

  it('refuses empty or oversized content with a value', async () => {
    const { ctx } = await host()
    const empty = await call(ctx, 'stm_notes_write', { file: 'GUIDE.md', content: '  ' })
    expect(empty.isError).toBe(false)
    expect(JSON.parse(texts(empty.content)[0] as string)).toEqual({ error: 'stm_notes_write: GUIDE.md content must not be empty', instrument_unchanged: true })
    const big = await call(ctx, 'stm_notes_write', { file: 'WORKING.md', content: 'x'.repeat(17000) })
    expect(JSON.parse(texts(big.content)[0] as string).error).toMatch(/the limit is 16384/)
  })

  it('reports file-system failures as values too', async () => {
    const { ctx } = await host()
    const notes = ctx.frameArchive.notes
    const origRead = notes.read.bind(notes)
    const origWrite = notes.write.bind(notes)
    notes.read = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    notes.write = () => {
      throw new Error('disk full')
    }
    try {
      expect(JSON.parse(texts((await call(ctx, 'stm_notes_read', { file: 'GUIDE.md' })).content)[0] as string).error).toBe('stm_notes_read: EACCES: EACCES')
      expect(JSON.parse(texts((await call(ctx, 'stm_notes_write', { file: 'GUIDE.md', content: 'x' })).content)[0] as string).error).toBe('stm_notes_write: disk full')
    } finally {
      notes.read = origRead
      notes.write = origWrite
    }
  })
})

describe('the service', () => {
  it('delegates the archive interface', async () => {
    const { ctx, root } = await host()
    const svc = ctx.frameArchive
    expect(svc.get('t0000.s0').fid).toBe('t0000.s0')
    expect(svc.frames({ kind: 's' })).toHaveLength(1)
    expect(svc.latest()?.fid).toBe('t0000.s0')
    expect(svc.index()[0]).toMatchObject({ frame: 't0000.s0', kind: 'scan' })
    expect(svc.array('t0000.s0').rows).toBe(8)
    expect(svc.render('t0000.s0').meta.image_size_px).toEqual([64, 32])
    expect(svc.observation('t0000.s0').label).toContain('kind="current"')
    const p = svc.addPartial(1, { Z: [[1e-10]] }, { geometry: { cx_nm: 0, cy_nm: 0, w_nm: 1, h_nm: 1 } })
    expect(p.fid).toBe('t0001.p0')
    const m = svc.addDerived(1, svc.render('t0000.s0').png, { tool: 'test' })
    expect(m.fid).toBe('t0001.m0')
    const { writeFileSync } = await import('node:fs')
    const sxmPath = join(root, 'again.sxm')
    writeFileSync(sxmPath, encodeSyntheticSxm({
      nx: 4, ny: 4, widthM: 1e-9, heightM: 1e-9, offsetXM: 0, offsetYM: 0, scanDir: 'up',
      channels: [{ name: 'Z', unit: 'm', forward: new Float32Array(16) }],
    }))
    expect(svc.addScan(2, sxmPath).fid).toBe('t0002.s0')
    const datPath = join(root, 'sts.dat')
    writeFileSync(datPath, encodeSyntheticDat({ columns: [['Bias (V)', [0, 1]], ['Current (A)', [0, 1e-12]]] }))
    expect(svc.addSpectrum(3, datPath, { simS: 1 })).toMatchObject({ fid: 't0003.d0', source_name: 'sts.dat', sim_s: 1 })
  })
})

describe('content rendering', () => {
  it('falls back to text when a value carries no valid attachment', () => {
    expect(renderViewValue({ text: '{}', images: [{ label: '<visual/>', attachment: { attachmentId: 3 } }] })).toEqual([
      { type: 'text', text: '{}\n' },
      { type: 'text', text: '<visual/>\n[image not delivered: no attachment]\n' },
    ])
    expect(renderViewValue({ text: '{}', images: [{ label: 'x', attachment: null, error: 'gone' }] })[1]).toEqual({
      type: 'text', text: 'x\n[image not delivered: gone]\n',
    })
  })
})
