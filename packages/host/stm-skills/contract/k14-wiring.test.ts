/**
 * 视觉线束接起来的样子：K14 观测入档 + 一动一观 + 每会话一份视觉记忆，全部走**真的**
 * dsh 管线（`ToolRuntime` 的调度与 guard、`dsh-agent` 的事件派发）。宿主组合照着这里接：
 *
 * ```
 * ctx.plugin(visualMemory, { root })                       // ctx.frameArchive + 回看工具 + 提示段
 * const gate = new ActGateService(ctx)                     // 一动一观
 * const kernel = new SkillKernel({ …, observer: frameObserver(ctx, { saveDir: controllerSaveDir }) })
 * ctx.tools.register(defineSkillTool(skill, { kernel, present: observationPresenter(ctx) }))
 * gate.registerSkill(skill.spec)
 * ```
 *
 * 仪器与附件服务是替身：仪器只回答 `Util_SessionPathGet`，技能像控制器的自动保存那样
 * 往保存目录里写一张小 `.sxm`。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef, type ToolExecutionResult } from 'dsh-spm-compat'
import { ACT_GATE_REFUSAL, SkillKernel, emptyHardwareState, type Skill, type SkillCallRecord } from 'dsh-spm-kernel'
import * as visualMemory from 'dsh-spm-visual-memory'
import { encodeSyntheticSxm, frameObserver, observationPresenter, pngSize } from 'dsh-spm-visual-memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActGateService } from '../src/act-gate.js'
import { controllerSaveDir } from '../src/save-dir.js'
import { defineSkillTool } from '../src/tool.js'

const S0 = emptyHardwareState('T0')

class FakeAttachments extends Service {
  readonly saved: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef> {
    this.saved.push(input.name ?? '')
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

/** dsh 的 LlmRuntime 的替身：只有模型元数据那一问。 */
class FakeLlm extends Service {
  constructor(ctx: Context, private readonly modalities: readonly string[]) {
    super(ctx, 'llm')
  }
  resolveModelInfo(): Promise<{ inputModalities: readonly string[] }> {
    return Promise.resolve({ inputModalities: this.modalities })
  }
}

const SXM = encodeSyntheticSxm({
  nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 0, offsetYM: 0, scanDir: 'down',
  channels: [{ name: 'Z', unit: 'm', forward: Float32Array.from({ length: 128 }, (_, i) => 1e-12 * (i % 16)) }],
})

let ctx: Context
let att: FakeAttachments
let root: string
let saveDir: string
let saved = 0

function skill(name: string, category: string, saves = false): Skill {
  return {
    spec: { name, description: `假技能 ${name}`, parameters: [], category },
    execute: () => {
      if (saves) writeFileSync(join(saveDir, `scan${String(++saved).padStart(3, '0')}.sxm`), SXM)
      return Promise.resolve({ success: true, summary: `${name}: ok` })
    },
  }
}

beforeEach(async () => {
  saved = 0
  root = mkdtempSync(join(tmpdir(), 'k14-root-'))
  saveDir = mkdtempSync(join(tmpdir(), 'k14-save-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  att = new FakeAttachments(ctx)
  await ctx.plugin(visualMemory, { root, displayMax: 64 }).await()
  const gate = new ActGateService(ctx)
  const instrument = (method: string): Promise<SkillCallRecord> =>
    Promise.resolve({ method, args: [], values: method === 'Util_SessionPathGet' ? [saveDir.length, saveDir] : [] })
  const kernel = new SkillKernel({
    snapshot: () => S0,
    safeCall: instrument,
    observer: frameObserver(ctx, { saveDir: controllerSaveDir }),
  })
  for (const s of [skill('ScanAt', 'composite', true), skill('SetBias', 'write'), skill('GetBias', 'read')]) {
    ctx.tools.register(defineSkillTool(s, { kernel, present: observationPresenter(ctx) }))
    gate.registerSkill(s.spec)
  }
})
afterEach(async () => {
  await ctx.registry.delete(visualMemory)
  rmSync(root, { recursive: true, force: true })
  rmSync(saveDir, { recursive: true, force: true })
})

const agent = (id: string, route?: { provider: string; model: string }): Agent =>
  ({ id, options: {}, session: { requestHeader: () => (route === undefined ? undefined : { config: route }) } }) as unknown as Agent

let n = 0
function call(name: string, who: Agent, args: unknown = {}): Promise<ToolExecutionResult> {
  n += 1
  return ctx.tools.execute({ name, callId: `call-${n}` as never, arguments: args, signal: new AbortController().signal, agent: who })
}

function preStep(who: Agent, turn: number, step: number): Promise<unknown> {
  return agentEvents(ctx, who).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

const texts = (r: ToolExecutionResult): string[] =>
  r.content.filter((b) => b.type === 'text').map((b) => (b as unknown as { text: string }).text)

describe('一个会话里：扫一帧 → 同一步再动被拒 → 下一步再动 → 读', () => {
  it('扫描帧入档、随结果出图；同一步第二个动作被拒；下一步放行并报最近的帧；读类结果一字不变', async () => {
    const a = agent('session-a')
    const scan = await call('ScanAt', a)
    expect(scan.isError).toBe(false)
    expect(scan.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
    const [text, label] = texts(scan)
    expect(text).toMatch(/^ScanAt: ok\nnew_frames: \[\{"frame":"t0001\.s0","turn":1,"kind":"scan","source":"scan001\.sxm",.*\]\n$/)
    expect(label).toMatch(/^<visual kind="current" frame="t0001\.s0" channel="Z" direction="forward" .*\/>\n$/)
    expect(scan.content[2]).toMatchObject({ type: 'image', attachment: { name: 't0001.s0.png', mediaType: 'image/png' } })
    expect(att.saved).toEqual(['t0001.s0.png'])

    const again = await call('SetBias', a)
    expect(again.isError && again.error.message).toBe(ACT_GATE_REFUSAL)

    await preStep(a, 1, 2)
    const bias = await call('SetBias', a)
    expect(bias.content).toEqual([{ type: 'text', text: 'SetBias: ok\nlatest_frame: "t0001.s0"' }])

    expect((await call('GetBias', a)).content).toEqual([{ type: 'text', text: 'GetBias: ok' }])
  })

  it('回看工具读的是同一个会话的档案；另一个会话的同名帧是它自己扫的', async () => {
    const a = agent('session-a')
    const b = agent('session-b')
    await call('ScanAt', a)
    const view = { question: 'q', views: [{ label: 'v', frame: 't0001.s0' }] }
    expect(JSON.parse(texts(await call('stm_inspect', a, view))[0] as string)).toMatchObject({ view_count: 1 })
    expect(JSON.parse(texts(await call('stm_inspect', b, view))[0] as string).error).toMatch(/the archive is empty/)
    const scanB = await call('ScanAt', b) // b 自己的第一个动作：不受 a 的待观察影响
    expect(texts(scanB)[0]).toContain('"source":"scan002.sxm"')
    expect(ctx.frameArchive.session('session-a').archive.frames().map((e) => e.source_name)).toEqual(['scan001.sxm'])
  })

  it('会话的模型只收文本：图照样存（会话日志可重建），文本说明有几张没送到模型', async () => {
    new FakeLlm(ctx, ['text'])
    const r = await call('ScanAt', agent('session-k', { provider: 'kimi', model: 'kimi-default' }))
    expect(texts(r)[0]).toMatch(/\nimages_not_delivered: 1 \(the session's model accepts text only\)\n$/)
    expect(r.content.map((b) => b.type)).toEqual(['text', 'text', 'image'])
  })
})
