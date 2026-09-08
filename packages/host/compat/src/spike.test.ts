import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { ToolExecutionResult, ToolGuard } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

/**
 * facts.md §7 那十条 spike 里已经有结论的部分，钉成会变红的断言。
 * 每次升级 dsh 后重跑（upgrades.md 清单第 4 步）；红了说明设计前提没了。
 * 结论正文在 docs/dsh/spike.md。
 */

describe('spike 1 · guard 拿得到工具名与参数', () => {
  // 类型层断言：编译期就红。D9 让「物理荒谬」这类判据挂在 guard 上，
  // 前提就是 guard 能看到参数——看不到的话整条设计要改挂 tools/pre-execute。
  it('ToolExecution 带 name 与 arguments', () => {
    const guard: ToolGuard = (exec) => {
      const name: string = exec.name
      const args: unknown = exec.arguments
      return name === 'x' && args !== undefined ? '拒绝' : undefined
    }
    expect(typeof guard).toBe('function')
  })
})

describe('spike 7 · tools/result 读得到 value，但 value 不进持久事件', () => {
  it('成功结果带 value', () => {
    const success = { isError: false, value: 42, content: [] } satisfies ToolExecutionResult
    expect(success.value).toBe(42)
  })
  // dsh 的原话是 "Execution-local canonical value; deliberately omitted from
  // durable events" ⇒ 我们的 records 钩子是**唯一**能留住它的地方，
  // 这正是 PLAN §3.1-1「持久真源放 SQLite 不放 session log」的由来。
})

describe('spike 3 · cordis patch 只有 insert 与按 id 逐字段覆盖', () => {
  const warns: string[] = []
  const warn = (m: string, ...a: unknown[]) => void warns.push(`${m} ${a.join(' ')}`)
  const base = () => [{ id: 'llm', name: '@deepseek-ai/dsh-llm', config: { model: 'a', temp: 1 } }]

  it('没有 remove / replace：想关掉一行只能 disabled: true', () => {
    const out = applyEntryPatches(base(), [{ id: 'llm', disabled: true }], warn)
    expect(out[0]).toMatchObject({ id: 'llm', disabled: true })
  })

  it('config 是整值替换，不深合并——覆盖时必须把原有键抄全', () => {
    // PLAN §3.1-9。实现就是 target[key] = value，抄漏一个键就是静默改默认值。
    const out = applyEntryPatches(base(), [{ id: 'llm', config: { model: 'b' } }], warn)
    expect(out[0]!.config).toEqual({ model: 'b' })
    expect(out[0]!.config).not.toHaveProperty('temp')
  })

  it('id 匹配不到只警告并跳过，不报错', () => {
    warns.length = 0
    const out = applyEntryPatches(base(), [{ id: '不存在', disabled: true }], warn)
    expect(out).toEqual(base())
    expect(warns.join()).toMatch(/not found/)
  })

  it('非 insert 的 patch 里 name 是断言不是覆盖：名字对不上整条跳过', () => {
    // 可以当护栏用：覆盖 dsh-base 行时把 name 一起写上，dsh 哪天改了那个 id
    // 背后的插件，我们的覆盖会跳过并警告，而不是悄悄作用到别的插件上。
    warns.length = 0
    const out = applyEntryPatches(base(), [{ id: 'llm', name: '换了名字', disabled: true }], warn)
    expect(out[0]).not.toHaveProperty('disabled')
    expect(warns.join()).toMatch(/name mismatch/)
  })

  it('不带 id 的 insert 追加到顶层——我们的 bundle patch 就是这么写的', () => {
    const out = applyEntryPatches(base(), [{ insert: [{ id: 'mast-hello', name: 'dsh-spm' }] }], warn)
    expect(out.map((e) => e.id)).toEqual(['llm', 'mast-hello'])
  })
})
