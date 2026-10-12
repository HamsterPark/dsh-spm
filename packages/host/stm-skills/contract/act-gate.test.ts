/**
 * 一动一观闸门在**真的** dsh 管线上：真 `ToolRuntime`（guard / pre-execute / 并发），
 * 真 `dsh-agent` 的事件派发（`agentEvents` —— agent-loop 自己发 `agent/pre-step`、
 * `agent/disposed` 用的就是它，带 agent 的作用域载体）。
 *
 * 钉住的是闸门依赖的那几条 dsh 事实（facts.md §9.5）：
 * 1. 宿主层（不带作用域）的 `agent/pre-step` / `agent/disposed` 监听者收得到**每一个**
 *    agent 经作用域载体派发的事件——否则回执永远到不了，第二个动作永远被拒；
 * 2. guard 拿得到 `exec.agent`，拒绝变成 `isError` 结果、文案原样进 `error.message`；
 * 3. 全局 guard 按登记顺序问，第一个拒绝就停——决定了「别的闸先拒了，这里不记账」。
 *
 * 「第 S 步的全部结果在第 S+1 步的 pre-step 之前提交、请求由日志推导」是 `dsh-agent-loop`
 * 的行为，那个包不在本仓依赖树里：证据见 facts.md §9.5（读包 + 仓外探针）。
 */
import { agentEvents, emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { Context, SystemPrompt, ToolRuntime, defineTool, type ToolExecutionResult } from 'dsh-spm-compat'
import { ACT_GATE_REFUSAL, SkillKernel, emptyHardwareState, type Skill } from 'dsh-spm-kernel'
import * as records from 'dsh-spm-stm-records'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActGateService, actGateProvider } from '../src/act-gate.js'
import { defineSkillTool } from '../src/tool.js'

const S0 = emptyHardwareState('T0')

let ctx: Context
let gate: ActGateService
const ran: string[] = []

/** 一个假技能：跑了就记一笔。 */
function skill(name: string, category: string, tags: string[] = []): Skill {
  return {
    spec: { name, description: `假技能 ${name}`, parameters: [], category, tags },
    execute: () => {
      ran.push(name)
      return Promise.resolve({ success: true, summary: `${name}: ok` })
    },
  }
}

/** 装一个技能工具，并在闸门上登记它的声明（与安全件的 `registerSkill` 同一形状）。 */
function install(s: Skill): () => void {
  const kernel = new SkillKernel({ snapshot: () => S0, record: ctx.stmRecords.fromKernel })
  const offTool = ctx.tools.register(defineSkillTool(s, { kernel }))
  const offGate = gate.registerSkill(s.spec)
  return () => {
    offGate()
    offTool()
  }
}

const agent = (id: string): Agent => ({ id }) as unknown as Agent

let n = 0
function call(name: string, who: Agent | undefined): Promise<ToolExecutionResult> {
  n += 1
  return ctx.tools.execute({
    name,
    callId: `call-${n}` as never,
    arguments: {},
    signal: new AbortController().signal,
    ...(who === undefined ? {} : { agent: who }),
  })
}

/** 像 agent-loop 那样经 agent 的作用域载体派发 `agent/pre-step`。 */
function preStep(who: Agent, turn: number, step: number): Promise<unknown> {
  return agentEvents(ctx, who).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

const refused = (r: ToolExecutionResult): boolean => r.isError && r.error.message === ACT_GATE_REFUSAL

beforeEach(async () => {
  ran.length = 0
  ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  ctx.plugin(records, {})
  await new Promise<void>((r) => ctx.inject(['stmRecords', 'tools'], () => r()))
  gate = new ActGateService(ctx)
  install(skill('SetBias', 'write'))
  install(skill('StartScan', 'write'))
  install(skill('ScanAt', 'composite'))
  install(skill('GetBias', 'read'))
  install(skill('AnalyzeScanImage', 'analysis'))
  install(skill('StopScan', 'write', ['scan', 'imaging', 'write']))
  install(skill('StopDataLog', 'write', ['datalog', 'record', 'stop']))
})
afterEach(async () => {
  await ctx.registry.delete(records)
})

describe('同一步里的两个动作', () => {
  it('第一个跑、第二个被拒（文案原样进 error.message）；下一步的 pre-step 之后放行', async () => {
    const a = agent('session-a')
    const first = await call('SetBias', a)
    const second = await call('StartScan', a)
    expect(first.isError).toBe(false)
    expect(refused(second)).toBe(true)
    if (second.isError) expect(second.content).toEqual([{ type: 'text', text: `Error: ${ACT_GATE_REFUSAL}` }])
    expect(ran).toEqual(['SetBias'])

    // 被拒的那一次不算动作：没有新结果要等，但上一个结果仍然没被看到
    expect(refused(await call('ScanAt', a))).toBe(true)

    const decision = await preStep(a, 1, 2)
    expect(decision).toEqual({ kind: 'enter', messages: [] }) // 闸门只回执，不改这一步的决定
    expect((await call('StartScan', a)).isError).toBe(false)
    expect(ran).toEqual(['SetBias', 'StartScan'])
  })

  it('并发的两个动作只放一个：放行与记账是同一个同步调用', async () => {
    const a = agent('session-a')
    const results = await Promise.all([call('SetBias', a), call('StartScan', a), call('ScanAt', a)])
    expect(results.filter((r) => !r.isError)).toHaveLength(1)
    expect(results.filter(refused)).toHaveLength(2)
    expect(ran).toHaveLength(1)
  })
})

describe('谁不受闸', () => {
  it('读与分析类技能、没登记的工具（视觉记忆、笔记）在待观察时照样跑', async () => {
    ctx.tools.register(
      defineTool({
        name: 'stm_inspect',
        description: '不改变仪器的回看工具（替身）',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: () => {
          ran.push('stm_inspect')
          return Promise.resolve('ok')
        },
      }),
    )
    const a = agent('session-a')
    await call('SetBias', a)
    for (const name of ['GetBias', 'AnalyzeScanImage', 'stm_inspect']) {
      expect((await call(name, a)).isError).toBe(false)
    }
    expect(ran).toEqual(['SetBias', 'GetBias', 'AnalyzeScanImage', 'stm_inspect'])
  })

  it('没有 agent 的调用（不是模型发的）不受闸，也不记账', async () => {
    expect((await call('SetBias', undefined)).isError).toBe(false)
    expect((await call('StartScan', undefined)).isError).toBe(false)
    expect((await call('SetBias', agent('session-a'))).isError).toBe(false)
  })

  it('补救动作（StopScan、带 stop 标签的）在待观察时照样跑——而且它们自己也记账', async () => {
    const a = agent('session-a')
    await call('StartScan', a)
    expect((await call('StopScan', a)).isError).toBe(false)
    expect((await call('StopDataLog', a)).isError).toBe(false)
    expect(ran).toEqual(['StartScan', 'StopScan', 'StopDataLog'])

    const b = agent('session-b')
    expect((await call('StopScan', b)).isError).toBe(false) // 退针之后再动别的……
    expect(refused(await call('SetBias', b))).toBe(true) // ……也得先看过退针的结果
  })

  it('读类技能登记了也不进表（注销是空操作）；拒绝时参数不是对象也照样记', async () => {
    const offRead = gate.registerSkill(skill('GetCurrent', 'read').spec)
    offRead()
    const a = agent('session-a')
    await call('SetBias', a)
    const r = await ctx.tools.execute({ name: 'StartScan', callId: 'odd' as never, arguments: ['not', 'an', 'object'], signal: new AbortController().signal, agent: a })
    expect(refused(r)).toBe(true)
  })

  it('注销之后不再受闸', async () => {
    const a = agent('session-a')
    const off = install(skill('MoveToXY', 'write'))
    await call('SetBias', a)
    expect(refused(await call('MoveToXY', a))).toBe(true)
    off()
    ctx.tools.register(defineSkillTool(skill('MoveToXY', 'write'), { kernel: new SkillKernel({ snapshot: () => S0 }) }))
    expect((await call('MoveToXY', a)).isError).toBe(false)
  })
})

describe('会话', () => {
  it('会话之间互不相干：一个 agent 的 pre-step 不回执另一个', async () => {
    const a = agent('session-a')
    const b = agent('session-b')
    await call('SetBias', a)
    expect((await call('SetBias', b)).isError).toBe(false)
    await preStep(a, 1, 2)
    expect((await call('StartScan', a)).isError).toBe(false)
    expect(refused(await call('StartScan', b))).toBe(true)
  })

  it('`agent/disposed`（经真的派发）之后忘掉这个会话', async () => {
    const a = agent('session-a')
    await call('SetBias', a)
    expect(gate.gate.isPending('session-a')).toBe(true)
    emitAgentEvent(ctx, a, 'agent/disposed', {})
    expect(gate.gate.isPending('session-a')).toBe(false)
  })
})

describe('记录与 guard 顺序', () => {
  it('拒绝自己记一行：内核根本没被调用，K16 看不见它', async () => {
    const a = agent('session-a')
    await call('SetBias', a)
    await call('StartScan', a)
    const rows = ctx.stmRecords.store.db
      .prepare('SELECT action_type, status, error, agent_id FROM actions ORDER BY hlc')
      .all() as { action_type: string; status: string; error: string | null; agent_id: string | null }[]
    // 内核记的是 SetBias 那一次；StartScan 那一行是闸门记的
    expect(rows.map((r) => [r.action_type, r.status])).toEqual([
      ['SetBias', 'succeeded'],
      ['StartScan', 'failed'],
    ])
    expect(rows[1]?.error).toBe(ACT_GATE_REFUSAL)
    expect(rows[1]?.agent_id).toBe('session-a')
  })

  it('全局 guard 按登记顺序问、第一个拒绝就停：别的闸先拒了，闸门不记账', async () => {
    // 新的上下文：这里要控制 guard 的登记顺序
    const c2 = new Context()
    c2.plugin(SystemPrompt)
    c2.plugin(ToolRuntime)
    await new Promise<void>((r) => c2.inject(['tools'], () => r()))
    let deny = true
    c2.tools.guard(() => (deny ? '[safety_gate] 先拒' : undefined))
    const g2 = new ActGateService(c2)
    const s = skill('SetBias', 'write')
    c2.tools.register(defineSkillTool(s, { kernel: new SkillKernel({ snapshot: () => S0 }) }))
    g2.registerSkill(s.spec)
    const run = () => c2.tools.execute({ name: 'SetBias', callId: 'x' as never, arguments: {}, signal: new AbortController().signal, agent: agent('a') })
    const r1 = await run()
    expect(r1.isError && r1.error.message).toBe('[safety_gate] 先拒')
    expect(g2.gate.isPending('a')).toBe(false) // 闸门没被问到，没记账
    deny = false
    expect((await run()).isError).toBe(false) // 同一步里放行：上一个根本没执行
    expect(g2.gate.isPending('a')).toBe(true)
  })

  it('插件形态：`actGateProvider` 装上就有 `ctx.stmActGate`', async () => {
    const c3 = new Context()
    c3.plugin(SystemPrompt)
    c3.plugin(ToolRuntime)
    c3.plugin(actGateProvider)
    await new Promise<void>((r) => c3.inject(['stmActGate'], () => r()))
    expect(c3.stmActGate).toBeInstanceOf(ActGateService)
  })
})
