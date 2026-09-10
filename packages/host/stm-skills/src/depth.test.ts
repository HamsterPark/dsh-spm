/**
 * 纵深防御：**拆掉外层闸，内层仍然拒。**
 *
 * PLAN §8.4 的那条判据——「拔掉 pre-execute 的 abort deny ⇒ 内核 K2 仍拒」——
 * 说的不是「有两份代码」，是「**两层各自独立成立**」。区别在于：
 * 一份被抽成公共函数、两处调用的判断，拆掉那个函数两处一起塌；
 * 而真正的纵深是两处**各有各的判据来源**，拆一处另一处照样挡。
 *
 * 这里的两层是：
 * - 外层 `ctx.tools.guard`（stm-safety）：看得见**模型发出的工具调用**；
 * - 内层 `SkillKernel` K2：看得见**每一次进内核的调用**，包括 composite 的子步。
 *
 * 外层看不见子步，内层看不见「模型想调但被 guard 拦下的那次」——
 * 所以两层不是冗余，是**覆盖面不同**。而这条测试要证的是：
 * 万一外层没装（profile 里没有看门狗），内层不会跟着失守。
 */
import { SkillKernel, emptyHardwareState, type Skill } from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { defineSkillTool } from './tool.js'

const S0 = emptyHardwareState('T0')

const probe = (name = '_Probe'): Skill => ({
  spec: {
    name,
    description: '内核探针',
    parameters: [{ name: 'setpoint_a', type: 'float', unit: 'A', required: true }],
  },
  execute: (): Promise<{ success: boolean; summary: string }> =>
    Promise.resolve({ success: true, summary: 'ok' }),
})

const exec = (): never =>
  ({
    callId: 'c1',
    rootCallId: 'c1',
    name: '_Probe',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('t'),
    deferContext: () => {},
    concludeTurn: () => {},
  }) as never

describe('中止闩：外层拆掉，内核 K2 仍拒', () => {
  it('**没有外层 guard 的情况下**，内核照样拒 —— 这是 §8.4 的那条判据', async () => {
    // 这里刻意不装 stm-safety：模拟「外层 pre-execute/guard 被拔掉」
    let latched = false
    const kernel = new SkillKernel({ snapshot: () => S0, abortLatched: () => latched })
    const tool = defineSkillTool(probe(), { kernel })

    expect(String(await tool.execute({ setpoint_a: '1p' }, exec()))).toContain('ok')
    latched = true
    const after = String(await tool.execute({ setpoint_a: '1p' }, exec()))
    expect(after).toContain('中止已闩上')
  })

  it('闩上时内核还会**结束本轮** —— 不让模型接着试下一个技能', async () => {
    const kernel = new SkillKernel({ snapshot: () => S0, abortLatched: () => true })
    const o = await kernel.run(probe(), { setpoint_a: '1p' })
    expect(o.concludeTurn).toBe(true)
  })

  it('两层的判据**各有来源**：内核问 `abortLatched`，外层问 `ctx.stmWatchdog.latched`', async () => {
    // 如果两层共用同一个函数，拆那个函数会两处一起塌 —— 那就不是纵深。
    // 内核这一侧的来源是注入的谓词，与看门狗服务无关：给一个恒 true 的谓词，
    // 即使 profile 里根本没有看门狗，内核也照拒。
    const kernel = new SkillKernel({ snapshot: () => S0, abortLatched: () => true })
    const o = await kernel.run(probe('AnySkill'), { setpoint_a: '1p' })
    expect(o.kind).toBe('refused')
    expect(o.code).toBe('abort_latched')
  })
})
