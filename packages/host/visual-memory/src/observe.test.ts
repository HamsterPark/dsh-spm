/**
 * K14 over the frame archive (`observe.ts`): which files a skill call archives,
 * under which turn and session, what it shows, and how the images reach the
 * tool result. The kernel is the real `SkillKernel`; skills are fakes that
 * save small `.sxm` files into a save directory, as the controller's autosave
 * does. The dsh tool seam (`defineSkillTool`) is exercised end to end in
 * `packages/host/stm-skills/contract/k14-wiring.test.ts`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef, type ToolRunContext } from 'dsh-spm-compat'
import { emptyHardwareState, SkillKernel, type Skill, type SkillOutcome } from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { entryFromRecord, type FrameArchive, type FrameEntry } from './archive.js'
import {
  frameObserver,
  IMAGES_NOT_DELIVERED,
  NO_SPECTRA,
  observationPresenter,
  presentObservation,
  renderObservation,
  routeTakesImages,
  TEXT_ONLY_ROUTE,
} from './observe.js'
import { pngSize } from './png.js'
import * as plugin from './plugin.js'
import { encodeSyntheticSxm } from './synthetic-sxm.js'
import { NO_ATTACHMENT_SERVICE, VIEW_OUTPUT } from './tools.js'

const S0 = emptyHardwareState('T0')
const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.registry.delete(plugin)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

class FakeAttachments extends Service {
  readonly saved: { data: Uint8Array; name?: string }[] = []
  failWith: Error | null = null
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef> {
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

/** A stand-in for dsh's LlmRuntime: only the model metadata lookup. */
class FakeLlm extends Service {
  modalities: readonly string[] | undefined = ['text', 'image']
  fail = false
  readonly asked: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }> {
    this.asked.push(`${provider}/${model}`)
    if (this.fail) return Promise.reject(new Error('NO_ADAPTER'))
    return Promise.resolve(this.modalities === undefined ? {} : { inputModalities: this.modalities })
  }
}

interface Host {
  readonly ctx: Context
  readonly root: string
  readonly saveDir: string
  readonly att: FakeAttachments | undefined
}

async function host(withAttachments = true): Promise<Host> {
  const root = tempDir('k14-root-')
  const saveDir = tempDir('k14-save-')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  const att = withAttachments ? new FakeAttachments(ctx) : undefined
  await ctx.plugin(plugin, { root, displayMax: 64 }).await()
  return { ctx, root, saveDir, att }
}

function sxm(seed = 0): Uint8Array {
  return encodeSyntheticSxm({
    nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 0, offsetYM: 0, scanDir: 'down',
    channels: [{ name: 'Z', unit: 'm', forward: Float32Array.from({ length: 128 }, (_, i) => 1e-12 * ((i + seed) % 16)) }],
  })
}

/** A skill that saves files into `dir` while it runs, as the controller's autosave does. */
function saving(name: string, category: string, save: () => void = () => {}): Skill {
  return {
    spec: { name, description: name, parameters: [], category },
    execute: () => {
      save()
      return Promise.resolve({ success: true, summary: `${name}: ok` })
    },
  }
}

function kernel(h: Host, saveDir: () => string | null = () => h.saveDir): SkillKernel {
  return new SkillKernel({ snapshot: () => S0, observer: frameObserver(h.ctx, { saveDir }) })
}

/** Run a skill as a tool call of `session` runs: inside that session's scope (`null`: a call without an agent). */
function runAs(h: Host, k: SkillKernel, skill: Skill, session: string | null = 'session-a'): Promise<SkillOutcome> {
  return h.ctx.frameArchive.runInSession(session ?? undefined, () => k.run(skill, {}))
}

function archiveOf(h: Host, session: string | null = 'session-a'): FrameArchive {
  return h.ctx.frameArchive.session(session).archive
}

describe('frameObserver: which files a call archives', () => {
  it('archives the scan an action saved under a new turn, lists it and shows it; files there before are not archived', async () => {
    const h = await host()
    writeFileSync(join(h.saveDir, 'old.sxm'), sxm())
    writeFileSync(join(h.saveDir, 'notes.txt'), 'not a data file')
    const k = kernel(h)
    const o = await runAs(h, k, saving('ScanAt', 'composite', () => writeFileSync(join(h.saveDir, 'scan001.sxm'), sxm(1))))
    expect(o.observation?.frames.map((f) => f.id)).toEqual(['t0001.s0'])
    expect(o.observation?.show).toEqual(['t0001.s0'])
    expect(o.observation?.frames[0]?.summary).toMatchObject({ frame: 't0001.s0', turn: 1, kind: 'scan', source: 'scan001.sxm' })
    expect(o.text.split('\n')[1]).toBe(`new_frames: ${JSON.stringify(o.observation?.frames.map((f) => f.summary))}`)
    expect(archiveOf(h).frames().map((e) => e.source_name)).toEqual(['scan001.sxm'])
  })

  it('an action that saved nothing still opens a turn and reports the latest scan frame (null before the first)', async () => {
    const h = await host()
    const k = kernel(h)
    const first = await runAs(h, k, saving('SetBias', 'write'))
    expect(first.observation).toEqual({ frames: [], show: [], latestFrame: null, notArchived: [] })
    expect(first.text).toBe('SetBias: ok\nlatest_frame: null')
    await runAs(h, k, saving('ScanAt', 'composite', () => writeFileSync(join(h.saveDir, 'a.sxm'), sxm())))
    const third = await runAs(h, k, saving('SetSetpoint', 'write'))
    expect(third.observation?.latestFrame).toBe('t0002.s0')
    expect(archiveOf(h).currentTurn).toBe(3)
  })

  it('a read-only call files what it finds under the current turn, and says nothing when there is nothing', async () => {
    const h = await host()
    const k = kernel(h)
    const quiet = await runAs(h, k, saving('GetBias', 'read'))
    expect(quiet.observation).toBeUndefined()
    expect(quiet.text).toBe('GetBias: ok')
    await runAs(h, k, saving('StartScan', 'write'))
    const wait = await runAs(h, k, saving('WaitScanComplete', 'read', () => writeFileSync(join(h.saveDir, 'b.sxm'), sxm())))
    expect(wait.observation?.frames.map((f) => f.id)).toEqual(['t0001.s0'])
    expect(wait.observation?.latestFrame).toBeUndefined()
    expect(archiveOf(h).currentTurn).toBe(1)
  })

  it('archives files that appeared between calls with the next call; several files oldest first; shows the newest scan only', async () => {
    const h = await host()
    const k = kernel(h)
    await runAs(h, k, saving('GetBias', 'read')) // the directory is known from here on
    const now = Date.now() / 1000
    for (const [name, age] of [['z.sxm', 30], ['y.sxm', 20], ['x.sxm', 10]] as const) {
      writeFileSync(join(h.saveDir, name), sxm())
      utimesSync(join(h.saveDir, name), now - age, now - age)
    }
    const o = await runAs(h, k, saving('GetCurrent', 'read'))
    expect(o.observation?.frames.map((f) => f.summary['source'])).toEqual(['z.sxm', 'y.sxm', 'x.sxm'])
    expect(o.observation?.show).toEqual(['t0000.s2'])
  })

  it('a file that fails to load is reported, not retried while unchanged, and archived once it changes', async () => {
    const h = await host()
    const k = kernel(h)
    const bad = await runAs(h, k, saving('ScanAt', 'composite', () => writeFileSync(join(h.saveDir, 'half.sxm'), 'not yet')))
    expect(bad.observation?.frames).toEqual([])
    expect(bad.observation?.notArchived.map((n) => n.file)).toEqual(['half.sxm'])
    expect(bad.text).toMatch(/\nnot_archived: \[\{"file":"half\.sxm","error":".+"\}\]$/)
    expect((await runAs(h, k, saving('GetBias', 'read'))).observation).toBeUndefined()
    writeFileSync(join(h.saveDir, 'half.sxm'), sxm())
    const later = await runAs(h, k, saving('GetBias', 'read'))
    expect(later.observation?.frames.map((f) => f.summary['source'])).toEqual(['half.sxm'])
  })

  it('a missing save directory holds nothing; one created during the call has new files', async () => {
    const h = await host()
    const fresh = join(h.saveDir, 'later')
    const k = kernel(h, () => fresh)
    const o = await runAs(h, k, saving('ScanAt', 'composite', () => {
      mkdirSync(fresh)
      writeFileSync(join(fresh, 'c.sxm'), sxm())
    }))
    expect(o.observation?.frames.map((f) => f.id)).toEqual(['t0001.s0'])
  })
})

describe('frameObserver: spectra', () => {
  it('without addSpectrum a .dat is reported as not archived, never dropped', async () => {
    const h = await host()
    const o = await runAs(h, kernel(h), saving('AcquireSTS', 'write', () => writeFileSync(join(h.saveDir, 'sts001.dat'), 'x')))
    expect(o.observation?.notArchived).toEqual([{ file: 'sts001.dat', error: NO_SPECTRA }])
    expect(o.observation?.latestFrame).toBeNull()
  })

  it("with addSpectrum (the spectra port) .dat files are archived and the last two spectra shown after the newest scan", async () => {
    const h = await host()
    const archive = archiveOf(h)
    let i = 0
    const added: string[] = []
    ;(archive as unknown as { addSpectrum: (turn: number, path: string) => FrameEntry }).addSpectrum = (turn, path) => {
      added.push(path)
      return entryFromRecord({ fid: `t${String(turn).padStart(4, '0')}.d${i}`, turn, kind: 'd', index: i++, source_name: path.slice(-9), nx: 3 })
    }
    const now = Date.now() / 1000
    const o = await runAs(h, kernel(h), saving('DemoScanAndSTS', 'composite', () => {
      for (const [name, age] of [['scan1.sxm', 40], ['sts01.dat', 30], ['sts02.dat', 20], ['sts03.dat', 10]] as const) {
        writeFileSync(join(h.saveDir, name), name.endsWith('.sxm') ? sxm() : 'x')
        utimesSync(join(h.saveDir, name), now - age, now - age)
      }
    }))
    expect(added.map((p) => p.slice(-9))).toEqual(['sts01.dat', 'sts02.dat', 'sts03.dat'])
    expect(o.observation?.show).toEqual(['t0001.s0', 't0001.d1', 't0001.d2'])
    expect(o.observation?.frames[1]?.summary).toMatchObject({ kind: 'spectrum', source: 'sts01.dat', n_points: 3 })
  })
})

describe('frameObserver: sessions and errors', () => {
  it("each session's frames and turns go to its own archive; a file is archived once, by the call that sees it first", async () => {
    const h = await host()
    const k = kernel(h)
    await runAs(h, k, saving('ScanAt', 'composite', () => writeFileSync(join(h.saveDir, 'a.sxm'), sxm())), 'session-a')
    const b = await runAs(h, k, saving('ScanAt', 'composite', () => writeFileSync(join(h.saveDir, 'b.sxm'), sxm())), 'session-b')
    expect(b.observation?.frames.map((f) => f.id)).toEqual(['t0001.s0'])
    expect(archiveOf(h, 'session-a').frames().map((e) => e.source_name)).toEqual(['a.sxm'])
    expect(archiveOf(h, 'session-b').frames().map((e) => e.source_name)).toEqual(['b.sxm'])
    expect(archiveOf(h, null).frames()).toEqual([]) // calls without an agent have their own memory
  })

  it('a save directory that cannot be told is said on actions, not on reads', async () => {
    const h = await host()
    const none = kernel(h, () => null)
    expect((await runAs(h, none, saving('GetBias', 'read'))).observation).toBeUndefined()
    const act = await runAs(h, none, saving('SetBias', 'write'))
    expect(act.observation?.error).toBe('the controller reported no save directory')
    expect(act.text).toBe('SetBias: ok\nlatest_frame: null\nobservation_error: "the controller reported no save directory"')
    const throwing = new SkillKernel({
      snapshot: () => S0,
      observer: frameObserver(h.ctx, { saveDir: () => { throw new Error('link down') } }),
    })
    expect((await runAs(h, throwing, saving('SetBias', 'write'))).observation?.error).toBe('the save directory could not be read: link down')
  })

  it('a save directory that cannot be listed is said, before and after the call', async () => {
    const h = await host()
    const file = join(h.saveDir, 'not-a-dir')
    writeFileSync(file, '')
    const o = await runAs(h, kernel(h, () => file), saving('SetBias', 'write'))
    expect(o.observation?.error).toMatch(/^.*not-a-dir could not be listed: ENOTDIR/)
    const gone = join(h.saveDir, 'gone')
    mkdirSync(gone)
    const k = kernel(h, () => gone)
    const after = await runAs(h, k, saving('ScanAt', 'composite', () => {
      rmSync(gone, { recursive: true })
      writeFileSync(gone, '')
    }))
    expect(after.observation?.error).toMatch(/gone could not be listed: ENOTDIR/)
  })

  it('without ctx.frameArchive the observer does nothing and the outcome is unchanged', async () => {
    const ctx = new Context()
    const k = new SkillKernel({ snapshot: () => S0, observer: frameObserver(ctx, { saveDir: () => { throw new Error('never asked') } }) })
    const o = await k.run(saving('SetBias', 'write'), {})
    expect(o.text).toBe('SetBias: ok')
    expect(o.observation).toBeUndefined()
  })
})

/** A ToolRunContext with an agent whose session used `provider/model`. */
function execFor(route: { provider: string; model: string } | null, options: Record<string, string> = {}): ToolRunContext {
  const agent = {
    id: 'session-a',
    options,
    session: { requestHeader: () => (route === null ? undefined : { config: route }) },
  }
  return { agent, signal: new AbortController().signal } as unknown as ToolRunContext
}

async function scanOutcome(h: Host): Promise<SkillOutcome> {
  return runAs(h, kernel(h), saving('ScanAt', 'composite', () => writeFileSync(join(h.saveDir, 'a.sxm'), sxm())))
}

describe('observationPresenter: the images with the result', () => {
  it('stores each shown frame as <fid>.png and renders its label and image after the text', async () => {
    const h = await host()
    const o = await scanOutcome(h)
    const value = await h.ctx.frameArchive.runInSession('session-a', () => presentObservation(h.ctx, o, execFor(null)))
    expect(value.text).toBe(o.text)
    expect(h.att?.saved.map((s) => s.name)).toEqual(['t0001.s0.png'])
    expect(value.images[0]?.attachment).toMatchObject({ mediaType: 'image/png', name: 't0001.s0.png', width: 64, height: 32 })
    const blocks = renderObservation(value)
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    expect(blocks[0]).toEqual({ type: 'text', text: `${o.text}\n` })
    expect((blocks[1] as { text: string }).text).toMatch(/^<visual kind="current" frame="t0001\.s0" .*\/>\n$/)
  })

  it('with nothing to show the value is the text alone and renders exactly as a plain skill tool does', async () => {
    const h = await host()
    const o = await runAs(h, kernel(h), saving('SetBias', 'write'))
    const value = await presentObservation(h.ctx, o, execFor(null))
    expect(value).toEqual({ text: o.text, images: [] })
    expect(renderObservation(value)).toEqual([{ type: 'text', text: o.text }])
    expect(h.att?.saved).toEqual([])
  })

  it('says how many images do not reach the model: no attachment service, or a store that fails', async () => {
    const h = await host(false)
    const o = await scanOutcome(h)
    const value = await h.ctx.frameArchive.runInSession('session-a', () => presentObservation(h.ctx, o, execFor(null)))
    expect(value.images).toEqual([{ label: expect.stringContaining('frame="t0001.s0"'), error: NO_ATTACHMENT_SERVICE }])
    expect(value.text).toBe(`${o.text}\n${IMAGES_NOT_DELIVERED}: 1`)
    expect(renderObservation(value)[1]).toEqual({
      type: 'text',
      text: expect.stringMatching(/\n\[image not delivered: this composition has no attachment service \(ctx\.attachments\)\]\n$/),
    })

    const h2 = await host()
    ;(h2.att as FakeAttachments).failWith = Object.assign(new Error('too large'), { code: 'ATTACHMENT_TOO_LARGE' })
    const o2 = await scanOutcome(h2)
    const v2 = await h2.ctx.frameArchive.runInSession('session-a', () => presentObservation(h2.ctx, o2, execFor(null)))
    expect(v2.images[0]?.error).toBe('ATTACHMENT_TOO_LARGE: too large')
    expect(v2.text.endsWith(`\n${IMAGES_NOT_DELIVERED}: 1`)).toBe(true)
  })

  it('a frame whose image cannot be read keeps a label with the reason', async () => {
    const h = await host()
    const o: SkillOutcome = { kind: 'ok', signature: 'ok:x', text: 'x: ok', elapsedMs: 0, argsHash: 'h', observation: { frames: [], show: ['t0009.s0'], notArchived: [] } }
    const value = await presentObservation(h.ctx, o, execFor(null))
    expect(value.images).toEqual([{ label: '<visual kind="current" frame="t0009.s0"/>', error: expect.stringContaining('no frame "t0009.s0"') }])
    expect(value.text).toBe(`x: ok\n${IMAGES_NOT_DELIVERED}: 1`)
  })

  it("on a text-only route every image is counted as not delivered, with the reason; image routes are not", async () => {
    const h = await host()
    const llm = new FakeLlm(h.ctx)
    const o = await scanOutcome(h)
    const present = (exec: ToolRunContext) => h.ctx.frameArchive.runInSession('session-a', () => presentObservation(h.ctx, o, exec))
    llm.modalities = ['text']
    expect((await present(execFor({ provider: 'kimi', model: 'k' }))).text).toBe(`${o.text}\n${IMAGES_NOT_DELIVERED}: 1 (${TEXT_ONLY_ROUTE})`)
    expect(llm.asked).toEqual(['kimi/k'])
    llm.modalities = ['text', 'image']
    expect((await present(execFor({ provider: 'anthropic', model: 'claude' }))).text).toBe(o.text)
    llm.modalities = undefined // dsh passes images to a model that declares nothing
    expect((await present(execFor({ provider: 'p', model: 'm' }))).text).toBe(o.text)
  })

  it('observationPresenter wires the schema, present and render together', async () => {
    const h = await host()
    const p = observationPresenter(h.ctx)
    expect(p.schema).toBe(VIEW_OUTPUT)
    const o = await scanOutcome(h)
    const value = await h.ctx.frameArchive.runInSession('session-a', () => p.present(o, execFor(null)))
    expect(p.render(value)).toEqual(renderObservation(value))
  })
})

describe('routeTakesImages', () => {
  it('reads the route of the latest request, else the agent options; undefined when it cannot tell', async () => {
    const ctx = new Context()
    const llm = new FakeLlm(ctx)
    llm.modalities = ['text']
    expect(await routeTakesImages(ctx, execFor(null, { provider: 'kimi', model: 'k2' }))).toBe(false)
    expect(llm.asked).toEqual(['kimi/k2'])
    expect(await routeTakesImages(ctx, execFor(null))).toBeUndefined() // no route at all
    expect(await routeTakesImages(ctx, execFor(null, { provider: 'kimi', model: '' }))).toBeUndefined()
    expect(await routeTakesImages(ctx, { signal: new AbortController().signal } as unknown as ToolRunContext)).toBeUndefined() // no agent
    llm.fail = true
    expect(await routeTakesImages(ctx, execFor({ provider: 'x', model: 'y' }))).toBeUndefined()
    expect(await routeTakesImages(new Context(), execFor({ provider: 'x', model: 'y' }))).toBeUndefined() // no llm service
  })
})
