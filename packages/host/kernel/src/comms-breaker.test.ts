import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLOSED,
  CommsCircuitBreaker,
  HALF_OPEN,
  OPEN,
  formatCommsDown,
} from './comms-breaker.js'

/**
 * 前七条是旧仓 `tests/v2/unit/test_comms_circuit_breaker.py` 的状态机断言**原样移植**
 * （PLAN §12：旧 pytest 断言表原样搬）。同名、同顺序、同断言，好逐条对。
 * 那份文件后半的四条是 `ConnectionPool.safe_call` 接线，属于课时 1.6。
 */

class FakeClock {
  t = 0
  now = (): number => this.t
}

function breaker(clock = new FakeClock()) {
  return {
    b: new CommsCircuitBreaker({
      failThreshold: 3,
      openCooldownS: 20,
      streakWindowS: 30,
      clock: clock.now,
    }),
    clk: clock,
  }
}

describe('状态机（移植自旧仓 pytest）', () => {
  it('closed_allows_until_threshold', () => {
    const { b } = breaker()
    expect(b.state()).toBe(CLOSED)
    expect(b.allow()).toBe(true)
    b.recordFailure('t1')
    b.recordFailure('t2')
    expect(b.state()).toBe(CLOSED) // 2 < 3，还没到阈值
    expect(b.allow()).toBe(true)
  })

  it('third_consecutive_failure_opens', () => {
    const { b } = breaker()
    for (let i = 0; i < 3; i++) b.recordFailure(`timeout ${i}`)
    expect(b.state()).toBe(OPEN)
    expect(b.isOpen()).toBe(true)
    expect(b.allow()).toBe(false) // 冷却期内短路，**不碰 socket**
    expect(b.cooldownRemainingS()).toBeGreaterThan(0)
    expect(b.cooldownRemainingS()).toBeLessThanOrEqual(20)
  })

  it('cooldown_releases_single_probe_then_holds', () => {
    const { b, clk } = breaker()
    for (let i = 0; i < 3; i++) b.recordFailure('x')
    clk.t = 25 // 越过 20 秒冷却
    expect(b.state()).toBe(HALF_OPEN)
    expect(b.allow()).toBe(true) // 恰好放**一个**探针
    expect(b.allow()).toBe(false) // 探针在外，其余全挡
  })

  it('probe_success_closes_breaker', () => {
    const { b, clk } = breaker()
    for (let i = 0; i < 3; i++) b.recordFailure('x')
    clk.t = 25
    expect(b.allow()).toBe(true) // 探针
    b.recordSuccess() // 探针成功 ⇒ Nanonis 恢复了
    expect(b.state()).toBe(CLOSED)
    expect(b.allow()).toBe(true)
  })

  it('probe_failure_reopens_with_fresh_cooldown', () => {
    const { b, clk } = breaker()
    for (let i = 0; i < 3; i++) b.recordFailure('x')
    clk.t = 25
    expect(b.allow()).toBe(true) // 探针
    b.recordFailure('still down') // 探针失败 ⇒ 重新开闸
    expect(b.isOpen()).toBe(true)
    expect(b.allow()).toBe(false)
    expect(b.cooldownRemainingS()).toBeGreaterThan(19) // 从 t=25 重新武装整段，不是接着原来那段
  })

  it('app_error_success_resets_streak', () => {
    // 一次完成的往返，哪怕 Nanonis 回的是应用错误串，对**链路**就是成功——必须清零连击。
    const { b } = breaker()
    b.recordFailure('t1')
    b.recordFailure('t2')
    b.recordSuccess()
    b.recordFailure('t3')
    expect(b.state()).toBe(CLOSED) // 连击从 1 重新开始，不是 3
  })

  it('stale_failures_do_not_count_as_consecutive', () => {
    const { b, clk } = breaker()
    b.recordFailure('t1')
    b.recordFailure('t2') // t=0 时 streak = 2
    clk.t = 40 // 距上次失败 > 30 秒窗口
    b.recordFailure('t3') // 太老，算不上连续 ⇒ streak 重置为 1
    expect(b.state()).toBe(CLOSED)
  })
})

describe('旧仓测试没覆盖、但接线时会撞上的', () => {
  it('CLOSED→OPEN→HALF_OPEN→CLOSED 走一整圈', () => {
    const { b, clk } = breaker()
    expect(b.state()).toBe(CLOSED)
    for (let i = 0; i < 3; i++) b.recordFailure('down')
    expect(b.state()).toBe(OPEN)
    clk.t = 20 // 恰好等于冷却终点：`>=` 而不是 `>`
    expect(b.state()).toBe(HALF_OPEN)
    expect(b.allow()).toBe(true)
    b.recordSuccess()
    expect(b.state()).toBe(CLOSED)
  })

  it('探针失败会把 trippedTotal 再加一次——同一段冷却内的普通失败不会', () => {
    const { b, clk } = breaker()
    for (let i = 0; i < 3; i++) b.recordFailure('x')
    expect(b.snapshot().trippedTotal).toBe(1)
    b.recordFailure('还在冷却里又失败一次') // openUntil > now 且不是探针 ⇒ 不计
    expect(b.snapshot().trippedTotal).toBe(1)
    clk.t = 25
    b.allow() // 探针出去
    b.recordFailure('探针也失败') // wasProbe ⇒ 计
    expect(b.snapshot().trippedTotal).toBe(2)
  })

  it('CLOSED 时 cooldownRemainingS 恒为 0，不泄露上一轮的残值', () => {
    const { b, clk } = breaker()
    for (let i = 0; i < 3; i++) b.recordFailure('x')
    expect(b.cooldownRemainingS()).toBeGreaterThan(0)
    clk.t = 25
    b.allow()
    b.recordSuccess()
    expect(b.cooldownRemainingS()).toBe(0)
    expect(b.snapshot().cooldownRemainingS).toBe(0)
  })

  it('lastReason 截到 200 字符——它会进遥测，别让一条巨型报错撑爆快照', () => {
    const { b } = breaker()
    b.recordFailure('x'.repeat(500))
    expect(b.snapshot().lastReason).toHaveLength(200)
  })

  it('自定义阈值：threshold=1 一次失败就开闸', () => {
    const clk = new FakeClock()
    const b = new CommsCircuitBreaker({ failThreshold: 1, openCooldownS: 5, clock: clk.now })
    b.recordFailure('boom')
    expect(b.state()).toBe(OPEN)
    clk.t = 5
    expect(b.state()).toBe(HALF_OPEN)
  })
})

/**
 * 拿**旧仓真实实现**跑同一条脚本录下的逐步快照（`tools/spec-export/export_breaker_trace.py`）。
 *
 * 上面那 7 条是我**手抄**的 pytest 断言——抄错了没人知道；而且它们覆盖不到冷却与连击窗口的
 * 精确边界（`>=` 还是 `>`）。这一组补上：金样里 t=30 恰好等于窗口时**仍算连续**（`30 > 30` 为假），
 * t=20 恰好等于冷却终点时**已是 HALF_OPEN**（`>=`）。
 */
const trace = JSON.parse(
  readFileSync(new URL('../../../../spec/golden/breaker_trace.json', import.meta.url), 'utf8'),
) as Record<
  string,
  {
    op: [string, ...unknown[]]
    result: boolean | null
    t: number
    state: string
    streak: number
    cooldown_remaining_s: number
    tripped_total: number
    last_reason: string
  }[]
>

describe('与旧仓实现逐步对齐（分母 = spec/golden/breaker_trace.json）', () => {
  it.each(Object.keys(trace))('脚本 %s', (name) => {
    const clk = new FakeClock()
    const b = new CommsCircuitBreaker({
      failThreshold: name === 'threshold_one' ? 1 : 3,
      openCooldownS: 20,
      streakWindowS: 30,
      clock: clk.now,
    })
    for (const [i, step] of trace[name]!.entries()) {
      const [kind, arg] = step.op
      let result: boolean | null = null
      if (kind === 'fail') b.recordFailure(arg as string)
      else if (kind === 'success') b.recordSuccess()
      else if (kind === 'at') clk.t = arg as number
      else if (kind === 'allow') result = b.allow()
      else throw new Error(`未知操作 ${kind}`)

      const snap = b.snapshot()
      const where = `${name}[${i}] ${JSON.stringify(step.op)}`
      expect({ result, ...snap }, where).toEqual({
        result: step.result,
        state: step.state,
        streak: step.streak,
        failThreshold: name === 'threshold_one' ? 1 : 3,
        cooldownRemainingS: step.cooldown_remaining_s,
        trippedTotal: step.tripped_total,
        lastReason: step.last_reason,
      })
    }
  })
})

describe('给模型看的话', () => {
  it('明说别逐个工具重试、立刻 handoff——这是熔断存在的全部意义', () => {
    const { b } = breaker()
    for (let i = 0; i < 3; i++) b.recordFailure('timeout')
    const msg = formatCommsDown(b)
    expect(msg.startsWith('comms_circuit_open: ')).toBe(true)
    expect(msg).toContain('请勿逐个工具重试')
    expect(msg).toContain('handoff')
    expect(msg).toContain('≥3 次')
  })
})
