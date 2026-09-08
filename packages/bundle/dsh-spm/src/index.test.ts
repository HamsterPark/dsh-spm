import { describe, expect, it } from 'vitest'
import { apply, inject, name } from './index.js'

/** 只记下插件对 ctx 做了什么。不模拟 dsh 的行为——那是 contract 测试的事。 */
function fakeCtx() {
  const registered: { name: string; description: string }[] = []
  const effects: (() => unknown)[] = []
  const ctx = {
    tools: {
      register(tool: { name: string; description: string }) {
        registered.push(tool)
        return () => {}
      },
    },
    effect(fn: () => unknown) {
      effects.push(fn)
      return fn()
    },
  }
  return { ctx, registered, effects }
}

describe('dsh-spm bundle 插件', () => {
  it('声明 tools 为装载依赖', () => {
    // 不是运行时检查：Cordis 少一件就**不装载**这个插件。将来 skill-runtime
    // 写的是 ['stmSafety','instrument','instrumentState']，缺一则技能工具根本
    // 不出现，而不是出现后在运行时才拒绝（PLAN §6.1-3）。
    expect(name).toBe('dsh-spm')
    expect(inject).toContain('tools')
  })

  it('经 ctx.effect 注册 stm_hello，卸载时可回滚', () => {
    const { ctx, registered, effects } = fakeCtx()
    apply(ctx as never)
    expect(registered.map((t) => t.name)).toEqual(['stm_hello'])
    // 走 effect 而不是裸调 register：不走的话插件卸载后工具还挂在注册表上。
    expect(effects).toHaveLength(1)
  })
})
