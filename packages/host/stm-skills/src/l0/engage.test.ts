/**
 * `TryEngageController` 的**决策点**——它是这套系统里唯一一个能可靠毁掉针尖的
 * 动作的授权者。
 *
 * `needs_auto_approach: true` = 「去跑开环粗进针马达」。那个马达**没有电流反馈
 * 停止机制**，只有 Z 反馈环开着时才安全。
 *
 * 轨迹金样走不到这个分支（合成回包下 peak 总是够或者链路总是坏），
 * 而**变异演练把这个洞照出来了**：`engage-fail-closed-loop-open` 拆掉之后
 * 一条测试都没红。这个文件就是补上的那条。
 */
import {
  SkillKernel,
  emptyHardwareState,
  slowCallFrom,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { TryEngageController } from './engage.js'

const S0 = emptyHardwareState('T0')

/**
 * 一个能精确摆布的假仪器。
 *
 * `onOffGet` 决定 `ZCtrl_OnOffGet` 回什么：`true`/`false` = 那个状态，
 * `'error'` = 读失败。这三种正是决策点要分开对待的三种处境。
 */
function ctxWith(opts: {
  setpointA: number
  currentA: number | 'error'
  onOffGet: boolean | 'error'
}): { ctx: SkillContext; calls: string[] } {
  const calls: string[] = []
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    calls.push(method)
    if (method === 'ZCtrl_SetpntGet') return Promise.resolve({ method, args, values: [opts.setpointA] })
    if (method === 'Current_Get') {
      return opts.currentA === 'error'
        ? Promise.resolve({ method, args, error: '读不到' })
        : Promise.resolve({ method, args, values: [opts.currentA] })
    }
    if (method === 'ZCtrl_OnOffGet') {
      return opts.onOffGet === 'error'
        ? Promise.resolve({ method, args, error: '读不到' })
        : Promise.resolve({ method, args, values: [opts.onOffGet ? 1 : 0] })
    }
    return Promise.resolve({ method, args, values: [0] })
  }
  let clock = 1_000_000
  return {
    calls,
    ctx: {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      // 批 3l：这个桩不抬 recv 预算（进针不走那条路）——**照实报 `null`**。
      slowCall: slowCallFrom(safeCall, null),
      // 这个桩不接注册表。**返回一次带理由的失败**，不返回成功：
      // 一个静静地「成功」的子技能调用会把组合技能的判据整段架空。
      runSkill: (n: string) =>
        Promise.resolve({ success: false, error: `这个桩不支持子技能 '${n}'` }),
      now: () => (clock += 1),
      sleep: (ms: number) => {
        clock += ms
        return Promise.resolve()
      },
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'test',
      rootCallId: 'r',
      approvalSource: 'llm',
    },
  }
}

/** 峰值远低于阈值 ⇒ 走到决策点。 */
const FAR_BELOW = { setpointA: 1e-9, currentA: 1e-12 }

describe('决策点：要不要授权开环粗进针', () => {
  it('反馈环**确认已开** ⇒ 才建议粗进针', async () => {
    const { ctx } = ctxWith({ ...FAR_BELOW, onOffGet: false })
    const r = await TryEngageController.execute(ctx, {})
    expect(r.success).toBe(true)
    expect((r.data as { needs_auto_approach: boolean }).needs_auto_approach).toBe(true)
    expect((r.data as { message: string }).message).toContain('confirmed OFF')
  })

  it('实时控制器说**还闭着** ⇒ 不建议，且报的是 `true`（知道，且很糟）', async () => {
    const { ctx } = ctxWith({ ...FAR_BELOW, onOffGet: true })
    const r = await TryEngageController.execute(ctx, {})
    expect(r.success).toBe(false)
    const d = r.data as { needs_auto_approach: boolean; z_controller_on: boolean | null }
    expect(d.needs_auto_approach).toBe(false)
    // **不是 null**：把「你的 OFF 写没生效」压成「不知道」，就丢掉了唯一
    // 能告诉操作的人问题在哪的那个信号。
    expect(d.z_controller_on).toBe(true)
    expect(r.error).toContain('实时控制器回报 Z 反馈仍然闭合')
    expect(r.error).toContain('反馈环还在的时候跑开环粗进针马达就是撞针')
  })

  it('**读不到** ⇒ 不建议，且报的是 `null`（不知道）', async () => {
    const { ctx } = ctxWith({ ...FAR_BELOW, onOffGet: 'error' })
    const r = await TryEngageController.execute(ctx, {})
    expect(r.success).toBe(false)
    const d = r.data as { needs_auto_approach: boolean; z_controller_on: boolean | null }
    expect(d.needs_auto_approach).toBe(false)
    expect(d.z_controller_on).toBeNull()
    expect(r.error).toContain('无法确认 Z 反馈是否已断开')
  })

  it('**检查本身的失败绝不能成为危险动作的授权** —— 三种处境里只有一种放行', async () => {
    const outcomes = await Promise.all(
      ([false, true, 'error'] as const).map(async (onOffGet) => {
        const { ctx } = ctxWith({ ...FAR_BELOW, onOffGet })
        const r = await TryEngageController.execute(ctx, {})
        return (r.data as { needs_auto_approach: boolean }).needs_auto_approach
      }),
    )
    expect(outcomes).toEqual([true, false, false])
  })

  it('电流链全坏 ⇒ 关回去、不建议 —— 测量链自己失败不能触发盲目粗进针', async () => {
    const { ctx, calls } = ctxWith({ setpointA: 1e-9, currentA: 'error', onOffGet: false })
    const r = await TryEngageController.execute(ctx, {})
    expect(r.success).toBe(false)
    expect((r.data as { needs_auto_approach: boolean }).needs_auto_approach).toBe(false)
    expect(r.error).toContain('current measurement chain returned no valid reading')
    // 关回去这一步必须真的发出去
    expect(calls.filter((c) => c === 'ZCtrl_OnOffSet')).toHaveLength(2)
  })

  it('设定点是 0 / 读不出 ⇒ 同样拒绝判断', async () => {
    const { ctx } = ctxWith({ setpointA: 0, currentA: 1e-12, onOffGet: false })
    const r = await TryEngageController.execute(ctx, {})
    expect(r.error).toContain('setpoint is non-positive / unreadable')
    expect((r.data as { needs_auto_approach: boolean }).needs_auto_approach).toBe(false)
  })

  it('峰值达到阈值 ⇒ 隧穿已建立，反馈环留在 ON', async () => {
    const { ctx, calls } = ctxWith({ setpointA: 1e-9, currentA: 8e-10, onOffGet: false })
    const r = await TryEngageController.execute(ctx, {})
    expect(r.success).toBe(true)
    const d = r.data as { engaged: boolean; z_controller_on: boolean }
    expect(d.engaged).toBe(true)
    expect(d.z_controller_on).toBe(true)
    // 没有第二次 OnOffSet —— 建立了隧穿就不该把环关掉
    expect(calls.filter((c) => c === 'ZCtrl_OnOffSet')).toHaveLength(1)
  })
})

describe('沉降循环被叫停', () => {
  it('abort 时立刻收工，并**明说没验证过**', async () => {
    const ac = new AbortController()
    const { ctx } = ctxWith({ ...FAR_BELOW, onOffGet: false })
    ac.abort()
    const r = await TryEngageController.execute(
      { ...ctx, signal: ac.signal },
      {},
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain('engagement is UNVERIFIED')
    expect((r.data as { engaged: boolean }).engaged).toBe(false)
  })
})

describe('内核穿过去也一样', () => {
  it('通过 SkillKernel 跑时，注入的 safeCall 与时钟都被用上', async () => {
    const { ctx } = ctxWith({ ...FAR_BELOW, onOffGet: false })
    let clock = 1_000_000
    const o = await new SkillKernel({
      snapshot: () => S0,
      safeCall: ctx.safeCall,
      monotonic: () => (clock += 1),
      sleep: (ms) => {
        clock += ms
        return Promise.resolve()
      },
    }).run(TryEngageController, {})
    expect(o.kind).toBe('ok')
    expect(o.data?.['needs_auto_approach']).toBe(true)
  })
})
