/**
 * `defineSkillTool()` 的契约测试。
 *
 * 两件事要证，而且都要**对着真的 dsh** 证，不是对着我对 dsh 的印象：
 * 1. D-SCHEMA-2 是真的——`minimum` 塞进去会被拒，折进 description 才过；
 * 2. 工具只是形状翻译——判断全在内核，拒绝也是一段正常返回的文本。
 */
import { parameterSchemaSpecToJsonSchema, type ToolRunContext } from 'dsh-spm-compat'
import type { Skill, SkillOutcome, SkillSpec } from 'dsh-spm-kernel'
import type { ToolExecution, ToolExecutionResult } from 'dsh-spm-compat'
import { emptyHardwareState, SkillKernel } from 'dsh-spm-kernel'
import { describe, expect, it, vi } from 'vitest'
import { defineSkillTool, toDshParameters } from './tool.js'

const S0 = emptyHardwareState('T0')

const spec: SkillSpec = {
  name: '_Probe',
  description: '内核探针',
  parameters: [
    { name: 'setpoint_a', type: 'float', unit: 'A', description: '设定点', minValue: 1e-12, maxValue: 100e-9, required: true },
    { name: 'steps', type: 'int', description: '步数', minValue: 1, maxValue: 100, required: false },
    { name: 'mode', type: 'str', description: '模式', allowedValues: ['fast', 'slow'], required: false },
  ],
}

function probe(over: Partial<Skill> = {}): Skill {
  return {
    spec,
    execute: over.execute ?? ((): Promise<{ success: boolean; summary: string }> =>
      Promise.resolve({ success: true, summary: '_Probe: ok' })),
  }
}

/** 够 `execute` 用的最小 `ToolRunContext`。 */
function exec(over: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    callId: 'c1',
    rootCallId: 'c1',
    name: '_Probe',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('t'),
    deferContext: () => {},
    concludeTurn: () => {},
    ...over,
  } as unknown as ToolRunContext
}

describe('toDshParameters —— D-SCHEMA-2 就在这一个函数里', () => {
  it('数值上下界折进 description，因为 dsh 的关键字白名单里没有它们', () => {
    const p = toDshParameters({
      type: 'object',
      properties: { steps: { type: 'integer', description: '步数', minimum: 1, maximum: 100 } },
      required: ['steps'],
    })
    expect(p['steps']?.description).toBe('步数 范围 1 … 100')
    expect(p['steps']).not.toHaveProperty('minimum')
    expect(p['steps']).not.toHaveProperty('maximum')
  })

  it('**证明这条偏差是被迫的**：minimum 直接给 dsh 会当场抛，折过的能过', () => {
    // 这条测试的价值在于它验的是 dsh 真实的行为。哪天上游放开了数值关键字，
    // 它会变红，而我们就该回来把界还给 schema —— 一条偏差不该无限期地活着。
    expect(() =>
      parameterSchemaSpecToJsonSchema({
        steps: { type: 'integer', minimum: 1 } as never,
      }),
    ).toThrow()
    expect(() =>
      parameterSchemaSpecToJsonSchema(
        toDshParameters({
          type: 'object',
          properties: { steps: { type: 'integer', description: '步数', minimum: 1, maximum: 100 } },
          required: ['steps'],
        }),
      ),
    ).not.toThrow()
  })

  it('required 从根上的数组变成每个属性上的 required: true', () => {
    const p = toDshParameters(
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] },
    )
    expect(p['a']?.required).toBe(true)
    expect(p['b']?.required).toBeUndefined()
    const json = parameterSchemaSpecToJsonSchema(p)
    expect(json.required).toEqual(['a'])
  })

  it('枚举按声明的类型逐类构造 —— 不是一把 as 糊过去', () => {
    const p = toDshParameters({
      type: 'object',
      properties: {
        n: { type: 'integer', enum: [1, 2] },
        s: { type: 'string', const: 'only' },
        b: { type: 'boolean', enum: [true, false] },
      },
      required: [],
    })
    expect(parameterSchemaSpecToJsonSchema(p).properties).toMatchObject({
      n: { type: 'integer', enum: [1, 2] },
      s: { type: 'string', const: 'only' },
      b: { type: 'boolean', enum: [true, false] },
    })
  })
})

describe('defineSkillTool —— 只做形状翻译', () => {
  const kernel = (): SkillKernel => new SkillKernel({ snapshot: () => S0 })

  it('工具名与描述就是技能的，参数 schema 能被 dsh 接受', () => {
    const t = defineSkillTool(probe(), { kernel: kernel() })
    expect(t.name).toBe('_Probe')
    expect(t.description).toBe('内核探针')
    const json = parameterSchemaSpecToJsonSchema(
      toDshParameters({ type: 'object', properties: {}, required: [] }),
    )
    expect(json.type).toBe('object')
  })

  it('有量纲参数在 schema 里是 string，范围与写法在 description 里', () => {
    const t = defineSkillTool(probe(), { kernel: kernel() })
    const props = (t.parameters as { properties: Record<string, { type?: string; description?: string }> })
      .properties
    expect(props['setpoint_a']?.type).toBe('string')
    expect(props['setpoint_a']?.description).toContain('范围 1p … 100n A')
    expect(props['setpoint_a']?.description).toContain('前缀不可省略')
    // 无量纲的 steps 走的是 D-SCHEMA-2 那条路
    expect(props['steps']?.type).toBe('integer')
    expect(props['steps']?.description).toBe('步数 范围 1 … 100')
  })

  it('执行走内核：SI 字符串被解析成数字才到技能手里', async () => {
    let seen: unknown
    const t = defineSkillTool(
      probe({
        execute: (_c, p): Promise<{ success: boolean; summary: string }> => {
          seen = p['setpoint_a']
          return Promise.resolve({ success: true, summary: 'ok' })
        },
      }),
      { kernel: kernel() },
    )
    await t.execute({ setpoint_a: '100p' }, exec())
    expect(seen).toBe(1e-10)
  })

  it('拒绝是**一段正常返回的文本**，不是抛异常 —— 模型要读到它才会改正', async () => {
    const k = new SkillKernel({ snapshot: () => S0, abortLatched: () => true })
    const t = defineSkillTool(probe(), { kernel: k })
    const out = await t.execute({ setpoint_a: '100p' }, exec())
    expect(String(out)).toContain('本次运行处于中止状态')
  })

  it('中止闩要结束本轮：内核那一位布尔翻译成 dsh 的 concludeTurn()', async () => {
    const k = new SkillKernel({ snapshot: () => S0, abortLatched: () => true })
    const concludeTurn = vi.fn()
    await defineSkillTool(probe(), { kernel: k }).execute({ setpoint_a: '1p' }, exec({ concludeTurn }))
    expect(concludeTurn).toHaveBeenCalledTimes(1)
  })

  it('普通成功**不**结束本轮', async () => {
    const concludeTurn = vi.fn()
    await defineSkillTool(probe(), { kernel: kernel() }).execute(
      { setpoint_a: '1p' },
      exec({ concludeTurn }),
    )
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('approvalSource 缺省是 llm —— 工具入口就是模型入口', async () => {
    let src: string | undefined
    const t = defineSkillTool(
      probe({
        execute: (c): Promise<{ success: boolean; summary: string }> => {
          src = c.approvalSource
          return Promise.resolve({ success: true, summary: 'ok' })
        },
      }),
      { kernel: kernel() },
    )
    await t.execute({ setpoint_a: '1p' }, exec())
    expect(src).toBe('llm')
  })

  it('参数校验失败：dsh 那一行**留着**，后面贴上旧仓逐字的教学文案（D-SCHEMA-3）', () => {
    const t = defineSkillTool(probe(), { kernel: kernel() })
    const failure = {
      isError: true,
      error: { message: 'invalid arguments: missing required property "setpoint_a"',
               info: { name: 'ToolArgsError', code: 'INVALID_ARGS' } },
      content: [],
    } as unknown as ToolExecutionResult
    const out = t.finalizeContent?.({} as Readonly<ToolExecution>, failure)
    expect(out).toHaveLength(2)
    // 第一段说**哪个参数**怎么了 —— 旧仓的钩子把这半截丢了
    expect(out?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('setpoint_a') })
    // 第二段是逐字的教学文案（它自己在 kernel 那边对着金样比过）
    expect(out?.[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[_Probe] precondition_failed: 参数超出允许范围。'),
    })
  })

  it('别的失败不碰 —— 只接管参数校验这一类', () => {
    const t = defineSkillTool(probe(), { kernel: kernel() })
    const other = {
      isError: true,
      error: { message: '硬件炸了', info: { name: 'Error', code: 'BOOM' } },
      content: [],
    } as unknown as ToolExecutionResult
    expect(t.finalizeContent?.({} as Readonly<ToolExecution>, other)).toBeUndefined()
    const ok = { isError: false, value: 'x', content: [] } as unknown as ToolExecutionResult
    expect(t.finalizeContent?.({} as Readonly<ToolExecution>, ok)).toBeUndefined()
  })

  it('工具自己不做任何判断：内核给什么文本就返回什么', async () => {
    const fixed: SkillOutcome = {
      kind: 'refused',
      signature: 's',
      text: '内核说了算',
      elapsedMs: 0,
      argsHash: 'x',
    }
    const fake = { run: () => Promise.resolve(fixed) } as unknown as SkillKernel
    // dsh **先按 schema 校验参数再进 execute**，所以这里得传合法参数
    const out = await defineSkillTool(probe(), { kernel: fake }).execute({ setpoint_a: '1p' }, exec())
    expect(out).toBe('内核说了算')
  })
})
