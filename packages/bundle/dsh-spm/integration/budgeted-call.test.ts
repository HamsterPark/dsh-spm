/**
 * Z-2（可选）—— `budgetedCall` 在**真 stmsim**上：`timeoutMs` 真的落到了传输层。
 *
 * 钉定的 STM-Bench 把 `ZSpectr_Start` 的真实回复时延封顶在 4 s（`spectr_module.py` 里
 * `time.sleep(min(duration, 4.0))`），`stmsim serve` 又没有注入延迟的开关，所以这里**不能**复现
 * 「回复晚于缺省的 5 s 超时」。能做的是把预算压到 1 s：stmsim 约 4 s 才回，1 s 的预算必然超时；
 * 等它睡完之后再给 10 s 的预算，必然收得到。这一格验的是「预算真的按调用生效」，
 * 与 `src/instrument-calls.test.ts` 里缩比的真 TCP 用例互补（那边没有 stmsim 的协议细节）。
 *
 * 若将来 STM-Bench 放开 4 s 封顶：删掉本文件，把 stm-skills 集成里 Z-1 的点数加到真实回复 > 5 s。
 *
 * 需要 `STMSIM_PYTHON` / `STMSIM_ROOT`（见 `vitest.stmsim-setup.ts`）。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import type { InstrumentService } from 'dsh-spm-instrument'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { afterEach, describe, expect, it } from 'vitest'
import { createInstrumentCalls } from '../src/instrument-calls.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

function instrument(timeoutMs = 10_000): Promise<InstrumentService> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      resolve(c.instrument as unknown as InstrumentService)
    })
  })
}

describe('对真 stmsim：budgetedCall 的 timeoutMs 真的落到传输层', () => {
  it('Z-2 1 s 的预算等不到约 4 s 才回的 Z 谱 ⇒ Timeout；等它睡完后 10 s 的预算 ⇒ 成功', async () => {
    const svc = await instrument()
    const { safeCall, budgetedCall } = createInstrumentCalls({
      send: (method, args, opts) => svc.call(method, args, opts),
      abortLatched: () => false,
    })

    // 与 stm-skills 集成里 Z-1 同一份配置：4000 点、往返、每点 0.002 s ⇒ 估算 16 s，stmsim 封顶在 4 s
    const open = await safeCall('ZSpectr_Open')
    if (open.error !== undefined) return // 模块没装，这一格没验到
    await safeCall('ZSpectr_RangeSet', 0, 5e-10)
    await safeCall('ZSpectr_PropsSet', 1, 4000, 1, 1, 2, 1)
    await safeCall('ZSpectr_TimingSet', 0, 0.001, 10, 0.001, 0.001, 0, 0)

    const tooShort = await budgetedCall('ZSpectr_Start', 1, 1, '')
    expect(tooShort.error).toMatch(/^Timeout:/)

    // 客户端已经断开，stmsim 那一侧还要把剩下的几秒睡完；等它做完再发，免得两次扫掠叠在一起
    await new Promise((resolve) => setTimeout(resolve, 5_000))

    const enough = await budgetedCall('ZSpectr_Start', 10, 1, '')
    expect(enough.error).toBeUndefined()
  })
})
