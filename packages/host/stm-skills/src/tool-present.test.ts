/**
 * `defineSkillTool` 接上 K14 的出站一侧（`present`）之后：值的形状由 presenter 定，
 * 文本仍是内核那一段；没接的时候与从前一字不差。走的是真的 dsh 调度器。
 */
import { Context, SystemPrompt, ToolRuntime, type ContentBlock, type ToolRunContext } from 'dsh-spm-compat'
import { emptyHardwareState, SkillKernel, type Skill, type SkillCallRecord, type SkillOutcome } from 'dsh-spm-kernel'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controllerSaveDir } from './save-dir.js'
import { defineSkillTool, type OutcomePresenter } from './tool.js'

const S0 = emptyHardwareState('T0')

const act: Skill = {
  spec: { name: '_Act', description: '会动仪器的假技能', parameters: [], category: 'write' },
  execute: () => Promise.resolve({ success: true, summary: '_Act: ok' }),
}

async function runtime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  return ctx
}

function execute(ctx: Context) {
  return ctx.tools.execute({ name: '_Act', callId: 'c1' as never, arguments: {}, signal: new AbortController().signal })
}

describe('defineSkillTool + present', () => {
  it('没接 presenter：值就是文本，内容是一个文本块（与从前一字不差）', async () => {
    const ctx = await runtime()
    ctx.tools.register(defineSkillTool(act, { kernel: new SkillKernel({ snapshot: () => S0 }) }))
    const r = await execute(ctx)
    expect(r.isError).toBe(false)
    if (!r.isError) expect(r.value).toBe('_Act: ok')
    expect(r.content).toEqual([{ type: 'text', text: '_Act: ok' }])
  })

  it('接了：presenter 拿到内核的结局与这次调用，值按它的 schema 校验，内容由它的 render 给', async () => {
    const ctx = await runtime()
    const seen: { outcome: SkillOutcome; exec: ToolRunContext }[] = []
    const present: OutcomePresenter = {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      present: (outcome, exec) => {
        seen.push({ outcome, exec })
        return Promise.resolve({ text: `${outcome.text} [presented]` })
      },
      render: (value): ContentBlock[] => [{ type: 'text', text: (value as { text: string }).text }],
    }
    ctx.tools.register(defineSkillTool(act, { kernel: new SkillKernel({ snapshot: () => S0 }), present }))
    const r = await execute(ctx)
    expect(r.isError).toBe(false)
    if (!r.isError) expect(r.value).toEqual({ text: '_Act: ok [presented]' })
    expect(r.content).toEqual([{ type: 'text', text: '_Act: ok [presented]' }])
    expect(seen[0]?.outcome.kind).toBe('ok')
    expect(seen[0]?.exec.name).toBe('_Act')
  })

  it('presenter 交回的值不合它自己的 schema：dsh 判成错误结果，不会把坏值交给模型', async () => {
    const ctx = await runtime()
    const present: OutcomePresenter = {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      present: () => Promise.resolve({ nope: 1 }),
      render: () => [],
    }
    ctx.tools.register(defineSkillTool(act, { kernel: new SkillKernel({ snapshot: () => S0 }), present }))
    expect((await execute(ctx)).isError).toBe(true)
  })

  it('中止闩的「结束本轮」在接了 presenter 之后照样传给 dsh', async () => {
    const ctx = await runtime()
    const present: OutcomePresenter = {
      schema: { type: 'string' },
      present: (outcome) => Promise.resolve(outcome.text),
      render: (value) => [{ type: 'text', text: String(value) }],
    }
    ctx.tools.register(defineSkillTool(act, { kernel: new SkillKernel({ snapshot: () => S0, abortLatched: () => true }), present }))
    const r = await execute(ctx)
    expect(r.isError).toBe(false)
    if (!r.isError) expect(r.concludesTurn).toBe(true)
  })
})

describe('controllerSaveDir —— K14 问仪器保存目录', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const reply = (values: unknown[], error?: string) => (method: string): Promise<SkillCallRecord> =>
    Promise.resolve({ method, args: [], values, ...(error === undefined ? {} : { error }) })

  it('报的是目录就用它；是「目录 + 文件名前缀」就取上级', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-dir-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'x.sxm'), '')
    expect(await controllerSaveDir({ safeCall: reply([dir.length, dir]) })).toBe(dir)
    expect(await controllerSaveDir({ safeCall: reply([0, join(dir, 'Topo')]) })).toBe(dir)
  })

  it('问不到、或者报的不是一个存在的目录：`null`，不编一个', async () => {
    expect(await controllerSaveDir({ safeCall: reply([], 'Timeout: no reply') })).toBeNull()
    expect(await controllerSaveDir({ safeCall: reply([0, '']) })).toBeNull()
    expect(await controllerSaveDir({ safeCall: reply([0, join(tmpdir(), 'no-such-dir-k14', 'deeper', 'Topo')]) })).toBeNull()
  })
})
