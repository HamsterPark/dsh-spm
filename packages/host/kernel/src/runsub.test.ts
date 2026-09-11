/**
 * `ctx.runSkill` —— L2 的接缝。
 *
 * 判据不是「它能调到子技能」，是**子步和主路走的是同一条判据链**：K1–K18 逐条、
 * owner / rootCallId / approvalSource 一路继承、K3 样品闸只在 depth 0 判。
 *
 * 旧仓这里是**手写的第二份闸门清单**（中止闸、注册表、样品闸、运行模式、数值边界、
 * 参数校验、前置检查），而那份清单必须和主路那份保持一致，靠的是有人记得两边一起改。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_COMPOSITION_DEPTH,
  SkillKernel,
  emptyHardwareState,
  type Skill,
  type SkillContext,
  type SkillSpec,
} from './index.js'

const S0 = emptyHardwareState('T0')

const leaf = (name: string, run: (ctx: SkillContext) => unknown = () => ({})): Skill => ({
  spec: { name, description: name, parameters: [] } as SkillSpec,
  execute: (ctx) => Promise.resolve({ success: true, data: run(ctx) as Record<string, unknown> }),
})

/** 一个只会调别人的技能。 */
const caller = (name: string, target: string, params: Record<string, unknown> = {}): Skill => ({
  spec: { name, description: name, parameters: [] } as SkillSpec,
  execute: async (ctx) => {
    const r = await ctx.runSkill(target, params)
    return { success: r.success, error: r.error, data: { sub: r.data ?? null, subError: r.error ?? null } }
  },
})

function kernel(skills: Skill[], extra: Record<string, unknown> = {}): SkillKernel {
  const byName = new Map(skills.map((s) => [s.spec.name, s]))
  return new SkillKernel({
    snapshot: () => S0,
    skillByName: (n: string) => byName.get(n),
    ...extra,
  } as never)
}

describe('ctx.runSkill —— 子步再进一次内核', () => {
  it('调得到，而且拿到的是子技能的 data', async () => {
    const k = kernel([leaf('Leaf', () => ({ v: 42 })), caller('Caller', 'Leaf')])
    const out = await k.run(caller('Caller', 'Leaf'), {}, { markers: { emit: () => {} } })
    expect(out.kind).toBe('ok')
    expect((out.data as { sub: { v: number } }).sub.v).toBe(42)
  })

  it('**深度 +1** —— 子步看得见自己是第几层', async () => {
    let seen = -1
    const k = kernel([
      leaf('Leaf', (ctx) => {
        seen = ctx.depth
        return {}
      }),
      caller('Caller', 'Leaf'),
    ])
    await k.run(caller('Caller', 'Leaf'), {}, { markers: { emit: () => {} } })
    expect(seen).toBe(1)
  })

  it('`owner` / `rootCallId` / `approvalSource` **一路继承** —— 记录链不断', async () => {
    let got: Record<string, unknown> = {}
    const k = kernel([
      leaf('Leaf', (ctx) => {
        got = { owner: ctx.owner, root: ctx.rootCallId, src: ctx.approvalSource }
        return {}
      }),
      caller('Caller', 'Leaf'),
    ])
    await k.run(caller('Caller', 'Leaf'), {}, {
      markers: { emit: () => {} },
      owner: 'group',
      rootCallId: 'R7',
      approvalSource: 'human',
    })
    expect(got).toEqual({ owner: 'group', root: 'R7', src: 'human' })
  })

  it('注册表里没有 ⇒ **一次带理由的失败**，不抛', async () => {
    const k = kernel([caller('Caller', 'Nope')])
    const out = await k.run(caller('Caller', 'Nope'), {}, { markers: { emit: () => {} } })
    expect(String((out.data as { subError: string }).subError)).toContain('unknown_skill')
  })

  it('没接注册表 ⇒ 同样是失败，而不是静静地什么都不做', async () => {
    const k = new SkillKernel({ snapshot: () => S0 } as never)
    const out = await k.run(caller('Caller', 'Leaf'), {}, { markers: { emit: () => {} } })
    expect(String((out.data as { subError: string }).subError)).toContain('unknown_skill')
  })

  it('**子步也过内核的闸** —— 中止闩在子步上照样拒', async () => {
    // 这正是不重写第二份清单的价值：K2 不用在子步那边再抄一遍。
    const k = kernel([leaf('Leaf'), caller('Caller', 'Leaf')], {
      abortLatched: () => true,
    })
    const out = await k.run(caller('Caller', 'Leaf'), {}, { markers: { emit: () => {} } })
    expect(out.kind).not.toBe('ok')
  })

  it('**每一步都进记录** —— 主步与子步各一条，深度不同', async () => {
    const rows: { name: string; depth: number }[] = []
    const k = kernel([leaf('Leaf'), caller('Caller', 'Leaf')], {
      record: (r: { spec: { name: string }; depth: number }) =>
        rows.push({ name: r.spec.name, depth: r.depth }),
    })
    await k.run(caller('Caller', 'Leaf'), {}, { markers: { emit: () => {} } })
    expect(rows).toEqual([
      { name: 'Leaf', depth: 1 },
      { name: 'Caller', depth: 0 },
    ])
  })
})

describe('组合嵌套上限 —— 一个环不该把进程转死', () => {
  it('自己调自己 ⇒ 到上限时**拒**，而不是无限递归', async () => {
    // ⚠️ 预算：拆掉上限之后这是一条**无限递归**，而它会把微任务队列一直填满，
    // vitest 的超时定时器（宏任务）永远轮不上 —— 测试不是变红，是整个 run 挂住，
    // 而挂住和通过在退出码上长得一样。同 `auto-approach.test.ts` 的 `MAX_CALLS`。
    let entered = 0
    const self: Skill = {
      spec: { name: 'Loop', description: 'Loop', parameters: [] } as SkillSpec,
      // **把失败往外传**：不传的话最里层那次拒绝只留在最深的一层，
      // 外面看到的是一次干干净净的成功 —— 那正是这条上限要避免的形状。
      execute: async (ctx) => {
        entered += 1
        if (entered > 20) throw new Error('递归没有被上限挡住')
        const r = await ctx.runSkill('Loop', {})
        return r.success ? { success: true } : { success: false, error: r.error }
      },
    }
    const k = kernel([self])
    const out = await k.run(self, {}, { markers: { emit: () => {} } })
    // 到上限那一层被拒，理由一路冒到最外面 —— 错误看得见，而不是一个挂起
    expect(out.kind).not.toBe('ok')
    expect(out.text).toContain('composition_too_deep')
  })

  it('上限是 4，深度到 3 就不再往下 —— 旧仓最深的是 level 2', async () => {
    expect(MAX_COMPOSITION_DEPTH).toBe(4)
  })
})
