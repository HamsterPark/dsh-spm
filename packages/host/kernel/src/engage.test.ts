/**
 * 进针判定的四张网格 —— 逐格对旧仓。
 *
 * 每一张都钉着一次真机事故，注释里写着是哪一次。判据落在**文案逐字**上而不只是
 * 布尔值：这些句子是给人读的，而这一族缺陷（#46、08-05、08-08）每一次的代价都不是
 * 「判错了」，是「**说的那句话回答了另一个问题**」。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ENGAGE_AGREE_N,
  ENGAGE_INTERVAL_S,
  KEEP_READS,
  MIN_ENGAGED_CURRENT_A,
  WaitProgress,
  engageEvidence,
  engageFailureText,
  engageVerdictToDict,
  engagementBar,
  fmtA,
  fmtM,
  newEngageVerdict,
  parseRunning,
  settleEngagement,
  type EngageVerdict,
} from './engage.js'

interface SettleCase {
  verdict: Record<string, unknown>
  evidence: string
}
interface WpCase {
  dict: Record<string, unknown>
  text: string
  z_span_m: number | null
  cycles_approx: number | null
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/approach.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    min_engaged_current_a: number
    engage_agree_n: number
    engage_interval_s: number
    keep_reads: number
  }
  engagement_bar: Record<string, { setpoint_a: number | null; bar_a: number | null }>
  fmt_a: Record<string, { input: number | null; text: string }>
  fmt_m: Record<string, { input: number | null; text: string }>
  parse_running: Record<string, { body: unknown; running: boolean | null }>
  settle: Record<string, SettleCase>
  wait_progress: Record<string, WpCase>
}

describe('常量', () => {
  it('四个逐字相等', () => {
    expect(MIN_ENGAGED_CURRENT_A).toBe(golden.constants.min_engaged_current_a)
    expect(ENGAGE_AGREE_N).toBe(golden.constants.engage_agree_n)
    expect(ENGAGE_INTERVAL_S).toBe(golden.constants.engage_interval_s)
    expect(KEEP_READS).toBe(golden.constants.keep_reads)
  })
})

describe('engagementBar —— 9 格（#75「调低电流假装进到针了」）', () => {
  for (const [name, c] of Object.entries(golden.engagement_bar)) {
    it(name, () => {
      expect(engagementBar(c.setpoint_a)).toBe(c.bar_a)
    })
  }

  it('**噪声底封住了那条玩法**：设定点调到 1 fA，判据线仍然是 1 pA', () => {
    // 只相对设定点判进针是可以被玩的：调得足够低，噪声就「达到」了它。
    expect(engagementBar(1e-15)).toBe(MIN_ENGAGED_CURRENT_A)
    expect(engagementBar(0.5e-12)).toBe(MIN_ENGAGED_CURRENT_A)
    // 设定点够大时才轮到 50 % 那条线
    expect(engagementBar(500e-12)).toBe(250e-12)
  })

  it('设定点读不到或为 0 ⇒ `null`，**不是** 0 —— 算不出线就不许判', () => {
    expect(engagementBar(null)).toBeNull()
    expect(engagementBar(undefined)).toBeNull()
    expect(engagementBar(0)).toBeNull()
  })

  it('负设定点按绝对值 —— 隧穿电流的符号跟着偏压走', () => {
    expect(engagementBar(-500e-12)).toBe(250e-12)
  })
})

describe('fmtA / fmtM —— 21 格', () => {
  for (const [name, c] of Object.entries(golden.fmt_a)) {
    it(`fmtA ${name}`, () => {
      expect(fmtA(c.input)).toBe(c.text)
    })
  }
  for (const [name, c] of Object.entries(golden.fmt_m)) {
    it(`fmtM ${name}`, () => {
      expect(fmtM(c.input)).toBe(c.text)
    })
  }

  it('`null` 印 `unreadable`，**不是** `0.00 pA`', () => {
    expect(fmtA(null)).toBe('unreadable')
    expect(fmtM(null)).toBe('unreadable')
    expect(fmtA(0)).toBe('0.00 pA')
  })
})

describe('parseRunning —— 16 格（2026-08-15 普查 A4）', () => {
  for (const [name, c] of Object.entries(golden.parse_running)) {
    it(name, () => {
      expect(parseRunning(c.body)).toBe(c.running)
    })
  }

  it('**空 body ⇒ `null`，不是「没在跑」**', () => {
    // 空 body 正是上游解析失败的样子。`bool([])` = false，于是一次解析故障
    // 答出了一个具体的仪器状态——这个位置已经在真机上静默报过一次「未在运行」。
    expect(parseRunning([])).toBeNull()
    expect(parseRunning([[]])).toBeNull()
    expect(parseRunning(null)).toBeNull()
    expect(parseRunning('nope')).toBeNull()
  })

  it('1-元组要再解一层 —— `[[0]]` 是「停了」，不是「在跑」', () => {
    // 防御性：`bool((0,))` 在 Python 里是 true，一个「已停止」的回包会被读成
    // 「还在跑」。它比读不懂更坏——看起来完全正常，只是答反了。
    expect(parseRunning([[0]])).toBe(false)
    expect(parseRunning([[1]])).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// settleEngagement
// ─────────────────────────────────────────────────────────────────────────

const SP = 50e-12
const ON: [number, number] = [46.6e-12, SP]
const OFF: [number, number] = [0.04e-12, SP]
type Pair = readonly [number | null, number | null]

/** 与导出脚本同形的假钟：`sleep` 往前拨，`now` 每读一次 +1 ms。 */
function harness(
  pairs: (Pair | string)[],
  opts: { budgetS?: number; agreeN?: number; intervalS?: number; aborts?: boolean[] } = {},
): Promise<EngageVerdict> {
  let clock = 1_000_000
  const seq = [...pairs]
  const ab = [...(opts.aborts ?? [])]
  return settleEngagement({
    readPair: () => {
      const v = seq.length > 1 ? seq.shift()! : (seq[0] ?? [null, null])
      if (typeof v === 'string') throw new Error(v)
      return Promise.resolve(v)
    },
    now: () => {
      clock += 1e-3
      return clock
    },
    sleep: (s) => {
      clock += Math.max(s, 0)
      return Promise.resolve()
    },
    checkAbort: () => ab.shift() ?? false,
    budgetS: opts.budgetS ?? 20,
    ...(opts.agreeN !== undefined ? { agreeN: opts.agreeN } : {}),
    ...(opts.intervalS !== undefined ? { intervalS: opts.intervalS } : {}),
  })
}

/** 名字 → 脚本。与 `export_approach.py` 的 `settle_case` 一一对应。 */
const SETTLE_SCRIPTS: Record<
  string,
  { pairs: (Pair | string)[]; budgetS?: number; agreeN?: number; aborts?: boolean[] }
> = {
  settles_engaged: { pairs: [ON] },
  settles_not_engaged: { pairs: [OFF] },
  transient_then_engaged: { pairs: [OFF, ON, ON] },
  never_agrees: { pairs: Array.from({ length: 12 }, () => [ON, OFF] as const).flat() },
  unreadable_all: { pairs: [[null, null]] },
  unreadable_then_engaged: { pairs: [[null, null], ON, ON] },
  setpoint_zero: { pairs: [[46.6e-12, 0]] },
  setpoint_none: { pairs: [[46.6e-12, null]] },
  reader_raises: { pairs: ['读电流炸了'] },
  aborted_immediately: { pairs: [ON], aborts: [true] },
  aborted_midway: { pairs: [ON], aborts: [false, true] },
  noise_floor_blocks_gaming: { pairs: [[0.4e-12, 0.5e-12]] },
  agree_n_three: { pairs: [ON], agreeN: 3 },
  keep_reads_cap: {
    pairs: [...Array.from({ length: 10 }, () => [ON, OFF] as const).flat(), OFF],
    budgetS: 25,
  },
}

/** 时钟读数不是判据 —— 它取决于实现读了几次钟。 */
const CLOCKY = new Set(['elapsed_s'])

describe('settleEngagement —— 14 格（2026-08-05 采到交接瞬态）', () => {
  const names = Object.keys(golden.settle)

  it('脚本表覆盖金样里的每一格', () => {
    expect(Object.keys(SETTLE_SCRIPTS).sort()).toEqual(names.slice().sort())
  })

  for (const name of names) {
    it(name, async () => {
      const want = golden.settle[name]!
      const s = SETTLE_SCRIPTS[name]!
      const v = await harness(s.pairs, {
        ...(s.budgetS !== undefined ? { budgetS: s.budgetS } : {}),
        ...(s.agreeN !== undefined ? { agreeN: s.agreeN } : {}),
        ...(s.aborts !== undefined ? { aborts: s.aborts } : {}),
      })
      const got = engageVerdictToDict(v)
      for (const k of Object.keys(want.verdict)) {
        if (CLOCKY.has(k)) continue
        expect(got[k], `${name}.${k}`).toEqual(want.verdict[k])
      }
      // 证据文案里那两个秒数是时钟派生的，其余逐字
      const strip = (t: string): string => t.replace(/[\d.]+s \/ 判定预算/, '<elapsed>s / 判定预算')
      expect(strip(engageEvidence(v))).toBe(strip(want.evidence))
    })
  }
})

describe('两次一致才下结论 —— 2026-08-05 那一次输在读数的时机上', () => {
  it('一次瞬态不该决定结论', async () => {
    // 老的检查在模块停下的**那一刻**读一次电流——那正是模块交给 Z 反馈的交接点，
    // 整个流程里电流唯一保证在途中的时刻。一次真正成功的进针被报成失败，
    // 而同一个隧道结几十秒后测到 −46.6 pA（设定点的 93 %）。
    const v = await harness([OFF, ON, ON])
    expect(v.engaged).toBe(true)
    expect(v.agreedN).toBe(2)
  })

  it('一直在两边跳 ⇒ `engaged` 是 `null`，**既不是进针也不是没进针**', async () => {
    const v = await harness(Array.from({ length: 12 }, () => [ON, OFF] as const).flat())
    expect(v.engaged).toBeNull()
    expect(v.agreedN).toBe(1)
  })

  it('三个值是**三件事**：`false` 是测出来的零，`null` 是没测出来', async () => {
    expect((await harness([OFF])).engaged).toBe(false)
    expect((await harness([[null, null]])).engaged).toBeNull()
    // 把后者报成「没进针」，正是把人支去看电机量程的那句话
    expect((await harness([[null, null]])).unreadableN).toBeGreaterThan(0)
    expect((await harness([OFF])).unreadableN).toBe(0)
  })

  it('读不到会**打断**连续计数 —— 一次没读到不是「上一次仍然成立」的证据', async () => {
    // 判据必须落在**跨过那次读不到的两个同侧读数**上：`[在线, 读不到, 在线]`。
    // 不打断的话，那一个读数加一次失败就凑成了「两次一致」，于是 engaged 变成 true。
    // 打断之后它只算 1 次，后面两次 OFF 才是真正一致的那一对。
    const v = await harness([ON, [null, null], ON, OFF, OFF])
    expect(v.engaged).toBe(false) // ← 不打断的话这里会是 true
    expect(v.unreadableN).toBe(1)

    // 顺带：打断之后再出现的两次同侧读数照常成立
    const w = await harness([ON, [null, null], ON, ON])
    expect(w.engaged).toBe(true)
  })

  it('一对都没解出来 ⇒ **提前退出**，不把预算耗完', async () => {
    // 把预算耗完也不会让一个死掉的回读变成一个读数，而调用方现在就需要这个诊断：
    // 「读不到电流」和「这个结还在稳」是两种修法。
    const v = await harness([[null, null]], { budgetS: 1000 })
    expect(v.totalReadsN).toBe(0)
    expect(v.unreadableN).toBe(2)
    expect(v.elapsedS).toBeLessThan(1000)
  })

  it('读取方抛异常 = 读不到，不是崩', async () => {
    const v = await harness(['炸了'])
    expect(v.engaged).toBeNull()
    expect(v.unreadableN).toBeGreaterThan(0)
  })

  it('证据最多留 12 次读数 —— 一句失败报文不该是三屏浮点数', async () => {
    const v = await harness(Array.from({ length: 10 }, () => [ON, OFF] as const).flat(), {
      budgetS: 25,
    })
    expect(v.readsA.length).toBeLessThanOrEqual(KEEP_READS)
    expect(v.totalReadsN).toBeGreaterThan(KEEP_READS)
  })

  it('中止 ⇒ `aborted`，**进针状态未知**', async () => {
    const v = await harness([ON], { aborts: [true] })
    expect(v.aborted).toBe(true)
    expect(v.engaged).toBeNull()
    expect(engageFailureText(v, { stopped: true })).toContain('**进针状态未知**')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// WaitProgress
// ─────────────────────────────────────────────────────────────────────────

type WpStep = ['running', boolean, number] | ['z', number | null, number]

const WP_SCRIPTS: Record<string, WpStep[]> = {
  never_polled: [],
  no_z_reads: [
    ['running', true, 0],
    ['running', true, 1],
    ['running', false, 2],
  ],
  z_frozen: [
    ['running', true, 0],
    ['z', 1e-9, 0],
    ['running', true, 1],
    ['z', 1e-9, 0],
    ['running', true, 2],
    ['z', 1e-9, 0],
  ],
  woodpecker_cycles: [
    ['running', true, 0],
    ...(Array.from({ length: 9 }, (_, i) => ['z', i % 2 === 0 ? 169.5e-9 : -169.5e-9, 0]) as WpStep[]),
    ['running', true, 8],
  ],
  one_z_read: [
    ['running', true, 0],
    ['z', 5e-9, 0],
  ],
  z_none_ignored: [
    ['running', true, 0],
    ['z', null, 0],
    ['z', 3e-9, 0],
    ['z', null, 0],
  ],
  module_never_ran: [
    ['running', false, 0],
    ['running', false, 1],
  ],
  ran_then_stopped: [
    ['running', false, 0],
    ['running', true, 1],
    ['running', true, 5],
    ['running', false, 6],
  ],
}

describe('WaitProgress —— 8 格（2026-08-08 整晚查一个不存在的「秒停」）', () => {
  const names = Object.keys(golden.wait_progress)

  it('脚本表覆盖金样里的每一格', () => {
    expect(Object.keys(WP_SCRIPTS).sort()).toEqual(names.slice().sort())
  })

  for (const name of names) {
    it(name, () => {
      const want = golden.wait_progress[name]!
      const p = new WaitProgress()
      for (const [kind, value, elapsed] of WP_SCRIPTS[name]!) {
        if (kind === 'running') p.noteRunning(value as boolean, elapsed)
        else p.noteZ(value as number | null)
      }
      expect(p.toDict()).toEqual(want.dict)
      expect(p.motionText()).toBe(want.text)
      expect(p.zSpanM).toBe(want.z_span_m)
      expect(p.cyclesApprox).toBe(want.cycles_approx)
    })
  }
})

describe('为什么进展信号取 Z，不取电流', () => {
  it('**Z 纹丝不动**与**没读到 Z** 是两句话', () => {
    // 4 K 下针尖离表面还远时电流恒在噪声底。拿电流判「有没有推进」，答案永远是
    // 「没有」——而那正是那次误诊的形状。
    const frozen = new WaitProgress()
    frozen.noteRunning(true, 0)
    frozen.noteZ(1e-9)
    frozen.noteZ(1e-9)
    expect(frozen.motionText()).toContain('纹丝不动')
    expect(frozen.motionText()).toContain('模块报在跑,压电却没动')

    const blind = new WaitProgress()
    blind.noteRunning(true, 0)
    expect(blind.motionText()).toContain('没读到 Z 压电位置')
    expect(blind.motionText()).toContain('无法判断')
  })

  it('啄木鸟进针：满摆的总行程说明**粗动确实在推进**', () => {
    // 真机 2026-08-08：Z 在 ±169.5 nm 之间满摆了上百个循环，而报文说它「秒停」。
    const p = new WaitProgress()
    p.noteRunning(true, 0)
    for (let i = 0; i < 9; i += 1) p.noteZ(i % 2 === 0 ? 169.5e-9 : -169.5e-9)
    p.noteRunning(true, 8)
    expect(p.motionText()).toContain('**粗动确实在推进**')
    expect(p.motionText()).toContain('个进退循环')
    expect(p.zTravelM).toBeCloseTo(8 * 339e-9, 15)
  })

  it('`moduleRanS` 从**第一次**读到 running 起算 —— 那才是模块跑了多久', () => {
    const p = new WaitProgress()
    p.noteRunning(false, 0) // 还没起来
    p.noteRunning(true, 10)
    p.noteRunning(true, 543)
    expect(p.moduleRanS).toBe(533) // ← 真机那 7 次里的第一次
    expect(p.waitedS).toBe(543)
  })

  it('`null` 的 Z 读数被忽略，不算进采样数', () => {
    const p = new WaitProgress()
    p.noteZ(null)
    p.noteZ(3e-9)
    p.noteZ(null)
    expect(p.zReadsN).toBe(1)
    expect(p.zTravelM).toBe(0)
  })

  it('循环数在不足一个循环时不印 —— 没有 ≈ 的循环数会被当刻度用', () => {
    const p = new WaitProgress()
    p.noteRunning(true, 0)
    p.noteZ(0)
    p.noteZ(10e-9)
    expect(p.cyclesApprox).toBeCloseTo(0.5, 12)
    expect(p.motionText()).not.toContain('进退循环')
  })
})

describe('engageFailureText —— 判决在前，证据在后', () => {
  const v = (over: Partial<EngageVerdict>): EngageVerdict => ({
    ...newEngageVerdict(20, 1),
    setpointA: SP,
    barA: 25e-12,
    ...over,
  })

  it('稳定在线下 ⇒ 「针尖未进入隧穿,不要扫图」排在第一句', () => {
    const t = engageFailureText(v({ engaged: false, readsA: [0.04e-12, 0.04e-12] }), {
      stopped: true,
    })
    expect(t.startsWith('AutoApproach 模块已停止,且电流**稳定地**没有达到进针判据')).toBe(true)
    expect(t).toContain('不要扫图')
  })

  it('判不出 ⇒ 明说「**这不等于没进针**,也不等于进针了」', () => {
    const t = engageFailureText(v({ engaged: null, unreadableN: 2 }), { stopped: true })
    expect(t).toContain('**判不出**')
    expect(t).toContain('**这不等于没进针**')
    expect(t).toContain('其中 2 次根本读不到电流/设定点')
  })

  it('**一条成因都不点名** —— 它一条都没测过', () => {
    // 这里原本每次失败都印「量程耗尽 / Z 压电在极限 / 外部停止」，
    // 2026-08-05 那天三条全是假的，人被支去检查一个完全正常的电机量程。
    const t = engageFailureText(v({ engaged: false }), { stopped: true })
    for (const rumour of ['量程耗尽', 'Z 压电在极限', '外部停止']) {
      expect(t).not.toContain(rumour)
    }
  })

  it('运动证据排在电流证据**前面**', () => {
    const p = new WaitProgress()
    p.noteRunning(true, 0)
    p.noteRunning(true, 533)
    const t = engageFailureText(v({ engaged: false }), { stopped: true, progress: p })
    expect(t.indexOf('模块实态运行') < 0).toBe(true) // 防手误
    expect(t.indexOf('模块实际运行')).toBeLessThan(t.indexOf('判据 |I|'))
  })

  it('没跑起来那一支换一个抬头', () => {
    expect(engageFailureText(v({ engaged: false }), { stopped: false })).toContain(
      '在宽限窗口内始终报告未运行(启动可能被拒绝)',
    )
  })
})
