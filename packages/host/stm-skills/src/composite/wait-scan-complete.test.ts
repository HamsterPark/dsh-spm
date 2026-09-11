/**
 * `WaitScanComplete` 的结局网格 —— 17 格逐条对旧仓。
 *
 * 判据是**结局与动词序列**：
 *
 * * `outcome` 那一个字段（调用方唯一要读的东西）；
 * * 行数三件套 `lines_done / lines_total / lines_verified`（「读不到」不是「零」）；
 * * `never_started` / `stopped_early` / `frame_restarted` 各自成立在哪一格；
 * * 发出去的动词序列 —— 尤其那条硬约束：**中止与超时都先发 `Scan_Action(1, 0)`
 *   停扫，再返回**。
 *
 * ⚠️ **不比 `elapsed_s` / `abort_checks` 的具体数字。** 前者取决于假钟被读了几次，
 * 后者在本仓少一次（D-SCAN-2 去掉了轮询自己那道中止检查）。把实现读时钟的次数
 * 钉成判据，只会让每一次无关重构都变红——而它一次真 bug 也抓不到。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  START_GRACE_S,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { WaitScanComplete } from './wait-scan-complete.js'

interface WaitCase {
  params: Record<string, unknown>
  success: boolean
  error: string
  data: Record<string, unknown>
  calls: { verb: string; args: unknown[]; error: string }[]
  verbs: string[]
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/scan_wait.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: { start_grace_s: number; max_extensions: number; extension_fraction: number }
  wait: Record<string, WaitCase>
}

/** 导出时 NaN 被写成记号。 */
function revive(v: unknown): unknown {
  if (v === 'NaN') return Number.NaN
  if (Array.isArray(v)) return v.map(revive)
  return v
}

/** 一帧：前 `acquired` 行有数，其余整行 NaN。真机 body 是异构表。 */
function frame(rows: number, cols: number, acquired: number): unknown[] {
  const data: number[][] = []
  for (let r = 0; r < rows; r += 1) {
    data.push(Array.from({ length: cols }, () => (r < acquired ? r : Number.NaN)))
  }
  return [2, 'Z', rows, cols, data, 1]
}

const BUF256 = [1, [[0]], 256, 256]

interface Script {
  status: number[]
  frames?: (unknown[] | string)[]
  buffer?: unknown[] | string
  aborts?: boolean[]
  errors?: Record<number, string>
  params?: Record<string, unknown>
}

/** 与导出脚本 `_ScriptCtx` 同形的桩。假钟：`sleep` 往前拨，`now` 每读一次 +1ms。 */
class Rig {
  readonly calls: { verb: string; args: unknown[]; error: string }[] = []
  #clock = 1_000_000
  #status: number[]
  #frames: (unknown[] | string)[]
  #buffer: unknown[] | string
  #aborts: boolean[]
  #errors: Record<number, string>
  #abortedFlag = false
  abortChecks = 0

  constructor(s: Script) {
    this.#status = [...s.status]
    this.#frames = [...(s.frames ?? [])]
    this.#buffer = s.buffer ?? BUF256
    this.#aborts = [...(s.aborts ?? [])]
    this.#errors = { ...(s.errors ?? {}) }
  }

  ctx(): SkillContext {
    const signal = {
      get aborted(): boolean {
        return rig.#nextAbort()
      },
    } as AbortSignal
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const rig = this
    return {
      signal,
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
    this.abortChecks += 1
    if (this.#abortedFlag) return true
    const v = this.#aborts.shift() ?? false
    // AbortSignal 是**闩**：翻过来就不会翻回去。
    if (v) this.#abortedFlag = true
    return v
  }

  #call(verb: string, args: unknown[]): SkillCallRecord {
    const i = this.calls.length
    const err = this.#errors[i]
    const rec = (error: string, values?: unknown[]): SkillCallRecord => {
      this.calls.push({ verb, args, error })
      return error === '' ? { method: verb, args, values } : { method: verb, args, error }
    }
    if (err !== undefined) return rec(err)
    if (verb === 'Scan_StatusGet') {
      const s = this.#status.length > 1 ? this.#status.shift()! : (this.#status[0] ?? 0)
      return rec('', [s])
    }
    if (verb === 'Scan_BufferGet') {
      return typeof this.#buffer === 'string' ? rec(this.#buffer) : rec('', this.#buffer)
    }
    if (verb === 'Scan_FrameDataGrab') {
      const f = this.#frames.length > 1 ? this.#frames.shift()! : this.#frames[0]
      if (typeof f === 'string') return rec(f)
      return rec('', f)
    }
    return rec('', [0])
  }
}

async function run(s: Script): Promise<{ res: SkillResultLike; rig: Rig }> {
  const rig = new Rig(s)
  const res = await WaitScanComplete.execute(rig.ctx(), s.params ?? { timeout_ms: 20000 })
  return { res, rig }
}

const F_FULL = frame(256, 256, 256)
const F_PART = frame(256, 256, 100)
const F_ZERO = frame(256, 256, 0)

/** 名字 → 脚本。与 `export_scan_wait.py` 的那张表一一对应。 */
const SCRIPTS: Record<string, Script> = {
  completed: { status: [1, 1, 0], frames: [F_FULL] },
  stopped_early: { status: [1, 1, 0], frames: [F_PART] },
  never_started: { status: [0], frames: [F_ZERO] },
  start_grace_then_completed: { status: [0, 0, 1, 1, 0], frames: [F_ZERO, F_ZERO, F_FULL] },
  already_finished_before_wait: { status: [0], frames: [F_FULL] },
  unmeasurable_buffer: { status: [1, 0], frames: [F_FULL], buffer: '模拟故障：读缓冲区失败' },
  unmeasurable_frame: { status: [1, 0], frames: ['模拟故障：抓帧失败'] },
  frame_rows_mismatch: { status: [1, 0], frames: [frame(128, 128, 128)] },
  timed_out: { params: { timeout_ms: 2000 }, status: [1], frames: [F_PART] },
  timed_out_no_stop: {
    params: { timeout_ms: 2000, stop_on_timeout: false },
    status: [1],
    frames: [F_PART],
  },
  extension_granted: {
    params: { timeout_ms: 2000 },
    status: [1],
    frames: [frame(256, 256, 100), frame(256, 256, 150), frame(256, 256, 200), frame(256, 256, 240)],
  },
  frozen_no_extension: { params: { timeout_ms: 2000 }, status: [1], frames: [frame(256, 256, 100)] },
  restarted: {
    params: { timeout_ms: 2000 },
    status: [1],
    frames: [frame(256, 256, 234), frame(256, 256, 208)],
  },
  abort_external: { status: [1], frames: [F_PART], aborts: [true] },
  // ⚠️ 这两格的 `aborts` 与导出脚本**不同**，而且必须不同：旧仓每轮查两次中止
  // （执行器一次 + 轮询自己一次），本仓 D-SCAN-2 去掉了后者，所以同一个下标落在
  // 不同的时刻。判据是**在第几次轮询之后停**，不是列表长什么样。
  // `abort_inside_poll` 在本仓与 `abort_external` **重合**——去掉那道检查之后，
  // 「轮询自己查到的中止」这件事不再存在。金样那一格的动词序列照样对得上。
  abort_inside_poll: { status: [1], frames: [F_PART], aborts: [true] },
  abort_midway: { status: [1], frames: [F_PART], aborts: [false, false, true] },
  poll_error_is_optional: {
    status: [1, 1, 0],
    frames: [F_FULL],
    errors: { 0: '模拟故障：连接被对端关闭' },
  },
}

/** 判据落在这些字段上 —— 决定，不是时钟读数。 */
const DECIDED = [
  'outcome',
  'timed_out',
  'stopped_early',
  'never_started',
  'frame_restarted',
  'lines_done',
  'lines_total',
  'lines_verified',
  'extensions',
  'polls',
  'budget_s',
] as const

describe('常量', () => {
  it('三个逐字相等', () => {
    expect(START_GRACE_S).toBe(golden.constants.start_grace_s)
  })
})

describe('结局网格 —— 17 格逐条对旧仓', () => {
  const names = Object.keys(golden.wait)

  it('脚本表覆盖金样里的每一格', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual(names.slice().sort())
  })

  for (const name of names) {
    it(name, async () => {
      const want = golden.wait[name]!
      const { res, rig } = await run(SCRIPTS[name]!)
      expect(res.success, `success（${name}）`).toBe(want.success)
      expect(res.error ?? '').toBe(want.error)
      const got = res.data as Record<string, unknown>
      for (const k of DECIDED) {
        expect(revive(got[k]), `data.${k}`).toEqual(revive(want.data[k]))
      }
      expect(rig.calls.map((c) => c.verb)).toEqual(want.verbs)
      expect(rig.calls.map((c) => c.args)).toEqual(want.calls.map((c) => c.args))
    })
  }
})

describe('那条硬约束：绝不把仪器留在运动中', () => {
  // dsh 的超时同样触发 `ctx.signal`。两条路都要先停扫再返回。
  it('中止 ⇒ **先**发 `Scan_Action(1, 0)`，**再**返回 aborted', async () => {
    const { res, rig } = await run(SCRIPTS['abort_external']!)
    expect(rig.calls.at(-1)).toEqual({ verb: 'Scan_Action', args: [1, 0], error: '' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('aborted by user')
  })

  it('超时 ⇒ 默认也停扫', async () => {
    const { rig } = await run(SCRIPTS['timed_out']!)
    expect(rig.calls.at(-1)?.verb).toBe('Scan_Action')
  })

  it('`stop_on_timeout: false` 才不停 —— 这是显式的选择，不是默认', async () => {
    const { rig } = await run(SCRIPTS['timed_out_no_stop']!)
    expect(rig.calls.some((c) => c.verb === 'Scan_Action')).toBe(false)
  })

  it('中止在跑到一半时落下 ⇒ 停扫照发，已经发出的读不回滚', async () => {
    const { res, rig } = await run(SCRIPTS['abort_midway']!)
    expect(rig.calls.map((c) => c.verb)).toEqual(['Scan_StatusGet', 'Scan_StatusGet', 'Scan_Action'])
    expect((res.data as Record<string, unknown>)['aborted_by_operator']).toBe(true)
  })
})

describe('「没在扫」不等于「扫完了」', () => {
  it('停了但只采到 100/256 行 ⇒ `stopped_early`，而 `success` 仍然是真', async () => {
    // 这个技能的职责是**等**，而它等对了。一帧被截断能不能接受是调用方的判断。
    const { res } = await run(SCRIPTS['stopped_early']!)
    expect(res.success).toBe(true)
    const d = res.data as Record<string, unknown>
    expect([d['outcome'], d['lines_done'], d['lines_total']]).toEqual(['stopped_early', 100, 256])
  })

  it('读不到 ⇒ **fail open**：`completed` + `lines_verified: false`', async () => {
    // 把一次量不到的扫描叫「中途停止」，会为了防一个看不见的情况砸掉每一台
    // 回包形状我们解不动的装机。
    const { res } = await run(SCRIPTS['unmeasurable_frame']!)
    const d = res.data as Record<string, unknown>
    expect([d['outcome'], d['lines_verified'], d['stopped_early']]).toEqual(['completed', false, false])
  })

  it('帧行数与缓冲区配置对不上 ⇒ **拒绝判断**，不制造一个截断', async () => {
    const { res } = await run(SCRIPTS['frame_rows_mismatch']!)
    const d = res.data as Record<string, unknown>
    expect([d['outcome'], d['lines_verified'], d['lines_done']]).toEqual(['completed', false, null])
  })
})

describe('2026-08-13：0.31 秒就报「中途停止 (0/256 行)」', () => {
  it('一次都没见它跑 + 缓冲区确证 0 行 ⇒ `never_started`，**不是** `stopped_early`', async () => {
    // 两者指向的下一步不同：前者查我们自己的发起时序，后者才去查用户 Stop。
    // 混成一句话，读的人会去查一件没发生的事。
    const { res } = await run(SCRIPTS['never_started']!)
    const d = res.data as Record<string, unknown>
    expect([d['outcome'], d['never_started'], d['stopped_early']]).toEqual(['never_started', true, false])
  })

  it('宽限期内**测缓冲区**，不是只看时钟', async () => {
    // 第一版在宽限期内直接继续、不测行数，于是「等待开始前扫描就已经跑完了」
    // 这种完全正常的情况也要空等满 5 秒——一条既有测试从 1 次轮询变成 182 次。
    const { res, rig } = await run(SCRIPTS['already_finished_before_wait']!)
    expect((res.data as Record<string, unknown>)['outcome']).toBe('completed')
    expect((res.data as Record<string, unknown>)['polls']).toBe(1)
    expect(rig.calls.filter((c) => c.verb === 'Scan_StatusGet')).toHaveLength(1)
  })

  it('先没起来、随后跑起来并扫完 ⇒ `completed`，`never_started` 为假', async () => {
    const { res } = await run(SCRIPTS['start_grace_then_completed']!)
    const d = res.data as Record<string, unknown>
    expect([d['outcome'], d['never_started'], d['lines_done']]).toEqual(['completed', false, 256])
  })
})

describe('2026-08-05：511/512 行被一只秒表扔掉', () => {
  it('行数还在**严格增长** ⇒ 有界延期，并且把预算与死线都说出来', async () => {
    const { res } = await run(SCRIPTS['extension_granted']!)
    const d = res.data as Record<string, unknown>
    expect(d['extensions']).toBe(2) // 封顶
    expect(d['budget_s']).toBe(2)
    expect(d['deadline_s'] as number).toBeGreaterThan(2)
    expect(d['outcome']).toBe('timed_out')
  })

  it('冻在原地 ⇒ 延期赚不到，按时死', async () => {
    // 行数相等不算进展。延期必须靠正面证据挣到，否则一台读不出缓冲区的机器
    // 会在每一次超时上永远等下去。
    const { res } = await run(SCRIPTS['frozen_no_extension']!)
    expect((res.data as Record<string, unknown>)['extensions']).toBe(0)
  })

  it('行数**掉下去** ⇒ `restarted`，不是「卡住」', async () => {
    // 只有一件事会让这个数变小：我们数的那一帧被更新的换掉了（Continuous scan
    // 开着）。把它叫「卡住」会把下一个读的人送去找一个卡住的压电。
    const { res } = await run(SCRIPTS['restarted']!)
    const d = res.data as Record<string, unknown>
    expect([d['outcome'], d['frame_restarted']]).toEqual(['restarted', true])
  })
})

describe('一次抖动不该让整场等待结束', () => {
  it('`Scan_StatusGet` 报错 ⇒ 睡一下接着轮，结局照常', async () => {
    const { res, rig } = await run(SCRIPTS['poll_error_is_optional']!)
    expect(res.success).toBe(true)
    expect((res.data as Record<string, unknown>)['outcome']).toBe('completed')
    expect(rig.calls[0]?.error).not.toBe('')
  })
})

describe('D-SCAN-2 · 中止只有一个说法', () => {
  it('每一种中止都让 `abort_facts` 说同一句话', async () => {
    // 旧仓「轮询自己查到的中止」那一支会给出 `outcome: aborted` 配
    // `aborted: false, aborted_by_operator: false` —— 下游按 abort_facts 判
    // 「有没有人喊停」会得到「没有」。那正是 #46 那一族。
    for (const name of ['abort_external', 'abort_inside_poll', 'abort_midway']) {
      const { res } = await run(SCRIPTS[name]!)
      const d = res.data as Record<string, unknown>
      expect([name, d['outcome'], d['aborted'], d['aborted_by_operator'], d['abort_reason']]).toEqual(
        [name, 'aborted', true, true, 'aborted by user'],
      )
    }
  })
})
