/**
 * `SetBiasRamp` —— 12 格步长 + 13 个端到端，逐条对旧仓。
 *
 * 步长那 12 格比的是**逐位相等的浮点**：交出去的每一个数都会被原样下发给硬件。
 * 端到端那 13 个比的是动词序列、失败文案、以及两道「不要编一个起点」的哨兵。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLEW_V_PER_S,
  DEFAULT_STEP_INTERVAL_S,
  SINGLE_SHOT_THRESHOLD_V,
  biasRampTargets,
  linspace,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { NO_START_BIAS_ERROR, SetBiasRamp } from './set-bias-ramp.js'

interface StepsCase {
  start_v: number
  end_v: number
  slew: number
  step_interval_s: number
  targets: number[]
  n: number
}
interface RampCase {
  params: Record<string, unknown>
  success: boolean
  error: string
  data: Record<string, unknown>
  calls: { verb: string; args: unknown[]; error: string }[]
  verbs: string[]
  set_targets: number[]
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/bias_ramp.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    single_shot_threshold_v: number
    default_slew_v_per_s: number
    default_step_interval_s: number
  }
  compute_steps: Record<string, StepsCase>
  cases: Record<string, RampCase>
}

interface Script {
  /** `Bias_Get` 的 body；字符串表示读失败。 */
  bias?: unknown[] | string
  errors?: Record<number, string>
  aborts?: boolean[]
}

class Rig {
  readonly calls: { verb: string; args: unknown[]; error: string }[] = []
  #clock = 1_000_000
  #abortedFlag = false
  constructor(private readonly s: Script) {}

  ctx(): SkillContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const rig = this
    return {
      signal: {
        get aborted(): boolean {
          return rig.#nextAbort()
        },
      } as AbortSignal,
      safeCall: (m: string, ...a: unknown[]) => Promise.resolve(this.#call(m, a)),
      emergencyCall: (m: string, ...a: unknown[]) => Promise.resolve(this.#call(m, a)),
      now: () => {
        this.#clock += 1
        return this.#clock
      },
      sleep: (ms: number) => {
        this.#clock += ms
        return Promise.resolve()
      },
    } as unknown as SkillContext
  }

  #nextAbort(): boolean {
    if (this.#abortedFlag) return true
    const v = (this.s.aborts ??= []).shift() ?? false
    if (v) this.#abortedFlag = true
    return v
  }

  #call(verb: string, args: unknown[]): SkillCallRecord {
    const i = this.calls.length
    const err = this.s.errors?.[i]
    const push = (error: string, values?: unknown[]): SkillCallRecord => {
      this.calls.push({ verb, args, error })
      return error === '' ? { method: verb, args, values } : { method: verb, args, error }
    }
    if (err !== undefined) return push(err)
    if (verb === 'Bias_Get') {
      const b = this.s.bias ?? [1.0]
      return typeof b === 'string' ? push(b) : push('', b)
    }
    return push('', [])
  }
}

async function run(
  params: Record<string, unknown>,
  s: Script = {},
): Promise<{ res: SkillResultLike; rig: Rig }> {
  const rig = new Rig({ ...s, aborts: [...(s.aborts ?? [])] })
  return { res: await SetBiasRamp.execute(rig.ctx(), params), rig }
}

/** 名字 → 脚本。与 `export_bias_ramp.py` 一一对应。 */
const SCRIPTS: Record<string, Script> = {
  start_given: {},
  start_read_from_instrument: { bias: [1.0] },
  single_shot_below_1mv: {},
  slow_slew: {},
  custom_interval: {},
  bias_get_fails: { bias: '模拟故障：连接被对端关闭' },
  bias_get_unparseable: { bias: [] },
  bias_get_nan: { bias: [Number.NaN] },
  set_fails_midway: { errors: { 3: '模拟故障：写偏压失败' } },
  set_fails_first: { errors: { 0: '模拟故障：写偏压失败' } },
  abort_before_first_step: { aborts: [true] },
  abort_midway: { aborts: [false, false, false, true] },
  abort_before_get_current: { aborts: [true] },
}

describe('常量', () => {
  it('三个逐字相等', () => {
    expect(SINGLE_SHOT_THRESHOLD_V).toBe(golden.constants.single_shot_threshold_v)
    expect(DEFAULT_SLEW_V_PER_S).toBe(golden.constants.default_slew_v_per_s)
    expect(DEFAULT_STEP_INTERVAL_S).toBe(golden.constants.default_step_interval_s)
  })
})

describe('biasRampTargets —— 12 格，**逐位**相等', () => {
  for (const [name, c] of Object.entries(golden.compute_steps)) {
    it(name, () => {
      const got = biasRampTargets({
        startV: c.start_v,
        endV: c.end_v,
        slewVPerS: c.slew,
        stepIntervalS: c.step_interval_s,
      })
      expect(got).toHaveLength(c.n)
      // `toEqual` 对 number 就是位相等——不是 toBeCloseTo。交出去的数会被原样下发。
      expect(got).toEqual(c.targets)
    })
  }

  it('末位是**直接赋成 stop** 的，不是算出来的', () => {
    // 斜坡的终点是调用方要求的那个电压，不是一个差着一个 ulp 的近似值。
    // 0.3 → 0.9 切 3 份是能看见这件事的最小反例：
    const step = (0.9 - 0.3) / 3
    expect(3 * step + 0.3).toBe(0.9000000000000001) // ← 没有那行赋值就会是这个
    expect(linspace(0.3, 0.9, 4).at(-1)).toBe(0.9)
  })

  it('中间项是 `i * step + start`，不是 `(i * Δ) / div + start`', () => {
    // 两种写法在 0 → 1 切 10 份的第 3 项上分岔：前者 0.30000000000000004，
    // 后者 0.3。金样 `up_1v_slew1` 录的是前者。
    expect(3 * (1 / 10)).toBe(0.30000000000000004)
    expect((3 * 1) / 10).toBe(0.3)
    expect(linspace(0, 1, 11)[3]).toBe(0.30000000000000004)
  })

  it('`linspace` 的两个退化情形 —— 没有它们 `(num-1)` 会变成 0 或 -1', () => {
    expect(linspace(1, 2, 0)).toEqual([])
    expect(linspace(1, 2, -3)).toEqual([])
    // num === 1 给起点，不是终点：`(stop-start)/0` 是 Infinity
    expect(linspace(1, 2, 1)).toEqual([1])
  })

  it('步数的**截断**是真判据：0.3 V / 0.1 V·步 切的是 2 步不是 3 步', () => {
    // 0.3 / (1.0 × 0.1) 在浮点里是 2.9999999999999996。
    expect(0.3 / (1.0 * 0.1)).toBeLessThan(3)
    expect(biasRampTargets({ startV: 0, endV: 0.3, slewVPerS: 1, stepIntervalS: 0.1 })).toEqual([
      0.15, 0.3,
    ])
  })

  it('低于 1 mV 一发到位 —— 把毫伏级改动切成几十步只是反复写同一个电压', () => {
    expect(biasRampTargets({ startV: 1, endV: 1.0005, slewVPerS: 1, stepIntervalS: 0.1 })).toEqual([
      1.0005,
    ])
    expect(biasRampTargets({ startV: 0.5, endV: 0.5, slewVPerS: 1, stepIntervalS: 0.1 })).toEqual([
      0.5,
    ])
    // 恰好 1 mV 还在阈值之内（`<=`）
    expect(biasRampTargets({ startV: 1, endV: 1.001, slewVPerS: 1, stepIntervalS: 0.1 })).toEqual([
      1.001,
    ])
  })
})

describe('端到端 —— 13 格逐条对旧仓', () => {
  const names = Object.keys(golden.cases)

  it('脚本表覆盖金样里的每一格', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual(names.slice().sort())
  })

  for (const name of names) {
    it(name, async () => {
      const want = golden.cases[name]!
      const { res, rig } = await run(want.params, SCRIPTS[name]!)
      expect(res.success, `success（${name}）`).toBe(want.success)
      expect(res.error ?? '').toBe(want.error)
      const got = res.data as Record<string, unknown>
      expect(got['bias_v']).toBe(want.data['bias_v'])
      expect(got['slew_rate_v_per_s']).toBe(want.data['slew_rate_v_per_s'])
      expect(got['steps']).toBe(want.data['steps'])
      expect(rig.calls.map((c) => c.verb)).toEqual(want.verbs)
      // 下发的电压逐位相等
      expect(rig.calls.filter((c) => c.verb === 'Bias_Set').map((c) => c.args[0])).toEqual(
        want.set_targets,
      )
    })
  }
})

describe('两道哨兵：读不到就拒绝，不要编一个 0.0 起点', () => {
  // 真实偏压 1 V 而起点被当成 0 时，第一步就把硬件从 1 V 拽到近 0 ——
  // 那正是 slew 存在的意义所要防的突变。一个失败的读取变成一个假的测量值，
  // 而那个假值废掉了一条安全保护。
  for (const [why, bias] of [
    ['读失败', '模拟故障：连接被对端关闭'],
    ['空 body', []],
    ['NaN', [Number.NaN]],
    ['字符串', ['1.0']],
  ] as const) {
    it(`${why} ⇒ 一次 Bias_Set 都不发`, async () => {
      const { res, rig } = await run({ bias_v_end: 1.0 }, { bias: bias as unknown[] | string })
      expect(res.success).toBe(false)
      expect(rig.calls.map((c) => c.verb)).toEqual(['Bias_Get'])
      expect((res.data as Record<string, unknown>)['steps']).toBe(0)
    })
  }

  it('多元素 body 取第 0 位 —— 与旧仓 `parsed[2][0]` 同一条，不擅自加严', async () => {
    // 收紧到「多元素就拒」是另一条判据，而它没有金样支持：`Bias_Get` 声明的是
    // 单个 float，多出来的那一位意味着别的事，不该由这里替它下结论。
    const { res, rig } = await run({ bias_v_end: 1.2 }, { bias: [1.0, 2.0] })
    expect(res.success).toBe(true)
    // 起点取的是第 0 位（1.0），不是第 1 位（2.0），也不是 0。
    // 顺带又撞上那条截断：`(1.2 - 1.0) / 0.1` 是 1.9999999999999996 ⇒ **一步到位**。
    expect(1.2 - 1.0).toBe(0.19999999999999996)
    expect(rig.calls.map((c) => [c.verb, c.args[0]])).toEqual([
      ['Bias_Get', undefined],
      ['Bias_Set', 1.2],
    ])
  })

  it('读不出来那句拒绝**逐字** —— 它是模型读的东西', async () => {
    const { res } = await run({ bias_v_end: 1.0 }, { bias: [] })
    expect(res.error).toBe(`_phase_get_current failed: ${NO_START_BIAS_ERROR}`)
    expect(NO_START_BIAS_ERROR).toContain('Refusing to ramp from an assumed 0.0V start')
  })

  it('起点读不到 ⇒ **一步都不排**，不是排一条从 0 开始的', async () => {
    // 旧仓这里有过两个各自独立的 `0.0` 兜底。本仓挡住它的是 `#getCurrent` 里那句
    // 拒绝（变异 `ramp-no-fake-start` 指着它）；排计划那侧的 `null` 分支是类型上
    // 必要、行为上不可达的，见那个方法的自述。
    const { res } = await run({ bias_v_end: 5.0 }, { bias: [] })
    const prog = (res.data as { _progress?: { completed_steps?: string[] } })._progress
    expect(prog?.completed_steps ?? []).toEqual([])
  })
})

describe('一步写坏就中止整条斜坡', () => {
  it('中间那一步失败 ⇒ 后面的不再下发，错误里带着**是哪个电压**', async () => {
    // 把偏压停在半路，比走完或者不走都糟——所以每一步都是 optional: false。
    const { res, rig } = await run(
      { bias_v_end: 1.0, bias_v_start: 0.0 },
      { errors: { 3: '模拟故障：写偏压失败' } },
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain('Slew failed at 0.4000V')
    expect(rig.calls).toHaveLength(4)
  })

  it('中止 ⇒ 停在当前电压，理由是**这一次**的', async () => {
    const { res, rig } = await run(
      { bias_v_end: 1.0, bias_v_start: 0.0 },
      { aborts: [false, false, false, true] },
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe('aborted by user')
    expect(rig.calls).toHaveLength(3)
  })
})

describe('两条计划入口', () => {
  it('给了起点 ⇒ 一次仪器读都不发，直接排斜坡', async () => {
    const { rig } = await run({ bias_v_end: 1.0, bias_v_start: 0.0 })
    expect(rig.calls.every((c) => c.verb === 'Bias_Set')).toBe(true)
  })

  it('没给起点 ⇒ 第 0 步先读，读到了才排得出后面那串', async () => {
    const { rig } = await run({ bias_v_end: 2.0 }, { bias: [1.0] })
    expect(rig.calls[0]?.verb).toBe('Bias_Get')
    expect(rig.calls.slice(1).every((c) => c.verb === 'Bias_Set')).toBe(true)
    // 起点是**读回来的** 1.0，不是 0
    expect(rig.calls[1]?.args[0]).toBe(1.1)
  })

  it('最后一步不睡 —— 调用方不需要一段斜坡之后的空等', async () => {
    let slept = 0
    const rig = new Rig({})
    const ctx = rig.ctx()
    const real = ctx.sleep.bind(ctx)
    const patched = {
      ...ctx,
      sleep: (ms: number) => {
        slept += 1
        return real(ms)
      },
    } as SkillContext
    await SetBiasRamp.execute(patched, { bias_v_end: 1.0, bias_v_start: 0.0 })
    expect(rig.calls).toHaveLength(10)
    expect(slept).toBe(9) // 10 步，9 次间隔
  })
})
