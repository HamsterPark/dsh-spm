/**
 * `AutoApproach` 的结局网格 —— 20 格逐条对旧仓。
 *
 * 判据是**动词序列与那句话**。这个技能的每一次事故都不是「判错了」，是
 * 「**说的那句话回答了另一个问题**」，所以 `error` 逐字比（时钟派生的两个秒数除外）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { makeAutoApproach } from './auto-approach.js'

interface ApproachCase {
  params: Record<string, unknown>
  success: boolean
  error: string
  data: Record<string, unknown>
  calls: { verb: string; args: unknown[]; error: string }[]
  verbs: string[]
  stop_failures: string[]
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/approach.json', import.meta.url)),
    'utf8',
  ),
) as { cases: Record<string, ApproachCase> }

const SP = 50e-12

interface Script {
  running?: (number | null)[]
  current?: (number | null)[]
  setpoint?: number | null
  z?: (number | null)[]
  aborts?: boolean[]
  /** 动词 → 恒定错误。 */
  errors?: Record<string, string>
  /** 调用序号 → 错误。 */
  errorAt?: Record<number, string>
  /** `"动词(实参…)"` → 错误。`AutoApproach_OnOffSet` 既是起跑也是停机。 */
  errorCall?: Record<string, string>
  params?: Record<string, unknown>
}

/**
 * 一趟最多允许多少次仪器调用。
 *
 * ⚠️ **不是装饰。** 这个桩的 `sleep` 返回的是一个已解决的 Promise，也就是一个
 * **微任务**——一个不收敛的轮询循环会把事件循环饿死，于是 vitest 的超时定时器
 * （宏任务）永远轮不上：测试不是变红，而是**整个 run 挂住**。
 *
 * 这条真的咬过：变异 `approach-timeout-not-success`（拆掉「到上限还在跑不许报成功」）
 * 第一版演练报的是**绿**，因为跑挂了的那次被当成没红。一次挂住和一次通过在退出码上
 * 长得一样，而那正是变异框架要分辨的东西。
 *
 * 预算超了就**抛**，与 `export_skill_traces.py` 的 `MAX_CALLS` 同一个理由：
 * 一趟不收敛的运行该大声失败，不该静静地挂着。
 */
const MAX_CALLS = 500

/** 与导出脚本 `_ScriptCtx` 同形。假钟：`sleep` 往前拨，`now` 每读一次 +1 ms。 */
class Rig {
  readonly calls: { verb: string; args: unknown[]; error: string }[] = []
  #clock = 1_000_000
  #abortedFlag = false
  #running: (number | null)[]
  #current: (number | null)[]
  #z: (number | null)[]
  #aborts: boolean[]

  constructor(private readonly s: Script) {
    this.#running = [...(s.running ?? [1, 1, 0])]
    this.#current = [...(s.current ?? [46.6e-12])]
    this.#z = [...(s.z ?? [null])]
    this.#aborts = [...(s.aborts ?? [])]
  }

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
    const v = this.#aborts.shift() ?? false
    if (v) this.#abortedFlag = true // AbortSignal 是闩
    return v
  }

  static #next<T>(seq: T[]): T | undefined {
    return seq.length > 1 ? seq.shift() : seq[0]
  }

  #call(verb: string, args: unknown[]): SkillCallRecord {
    const i = this.calls.length
    if (i >= MAX_CALLS) throw new Error(`超过 ${MAX_CALLS} 次调用仍未收敛（最后一个动词 ${verb}）`)
    const key = `${verb}(${args.map((a) => String(a)).join(',')})`
    const err = this.s.errorAt?.[i] ?? this.s.errorCall?.[key] ?? this.s.errors?.[verb]
    const push = (error: string, values?: unknown[]): SkillCallRecord => {
      this.calls.push({ verb, args, error })
      return error === '' ? { method: verb, args, values } : { method: verb, args, error }
    }
    if (err !== undefined) return push(err)
    const one = (v: number | null | undefined): unknown[] => (v === null || v === undefined ? [] : [v])
    if (verb === 'AutoApproach_OnOffGet') return push('', one(Rig.#next(this.#running)))
    if (verb === 'Current_Get') return push('', one(Rig.#next(this.#current)))
    if (verb === 'ZCtrl_SetpntGet') return push('', one(this.s.setpoint === undefined ? SP : this.s.setpoint))
    if (verb === 'ZCtrl_ZPosGet') return push('', one(Rig.#next(this.#z)))
    return push('', [])
  }
}

async function run(s: Script): Promise<{ res: SkillResultLike; rig: Rig }> {
  const rig = new Rig(s)
  // 与导出脚本同一组旋钮：判定预算 4 s、取样 1 s，其余用生产默认值。
  const skill = makeAutoApproach({ engageBudgetS: 4.0, engageIntervalS: 1.0 })
  return { res: await skill.execute(rig.ctx(), s.params ?? {}), rig }
}

/** 名字 → 脚本。与 `export_approach.py` 的 `case` 一一对应。 */
const SCRIPTS: Record<string, Script> = {
  converges: { running: [1, 1, 1, 0], current: [46.6e-12], z: [0, 60e-9, 120e-9, 169.5e-9] },
  completed_before_first_poll: { running: [0], current: [46.6e-12] },
  start_rejected: { running: [0], current: [0.04e-12] },
  stopped_but_no_current: {
    running: [1, 1, 0],
    current: [0.17e-12],
    setpoint: 500e-12,
    z: [0, 50e-9, 100e-9],
  },
  never_settles: {
    running: [1, 0],
    current: Array.from({ length: 12 }, () => [46.6e-12, 0.04e-12]).flat(),
    z: [0, 10e-9],
  },
  current_unreadable: { running: [1, 0], current: [null], z: [0, 10e-9] },
  setpoint_unreadable: { running: [1, 0], current: [46.6e-12], setpoint: null, z: [0, 10e-9] },
  noise_floor_blocks_gaming: {
    running: [1, 0],
    current: [0.4e-12],
    setpoint: 0.5e-12,
    z: [0, 1e-9],
  },
  timeout_still_advancing: {
    params: { wait_timeout_s: 5.0 },
    running: [1],
    current: [0.04e-12],
    z: [0, 60e-9, 120e-9, 169.5e-9, 120e-9, 60e-9, 0],
  },
  timeout_z_frozen: { params: { wait_timeout_s: 5.0 }, running: [1], current: [0.04e-12], z: [1e-9] },
  timeout_z_unreadable: {
    params: { wait_timeout_s: 5.0 },
    running: [1],
    current: [0.04e-12],
    z: [null],
  },
  status_flap: {
    running: [1, 1, 0, 1, 1, 0, 0],
    current: [46.6e-12],
    z: [0, 30e-9, 60e-9, 90e-9],
  },
  status_unreadable: {
    running: [1, 1, null, null, 0],
    current: [46.6e-12],
    z: [0, 30e-9, 60e-9],
  },
  open_fails: { errors: { AutoApproach_Open: '模拟故障：连接被对端关闭' } },
  start_fails: { errors: { AutoApproach_OnOffSet: '模拟故障：写失败' } },
  verify_fails: { running: [1, 1, 0], current: [46.6e-12], errorAt: { 12: '模拟故障：最终回读失败' } },
  poll_errors_persistent: { running: [1], errors: { AutoApproach_OnOffGet: '模拟故障：链路断了' } },
  abort_during_wait: { running: [1], current: [46.6e-12], aborts: [false, false, false, true] },
  abort_before_first_step: { running: [1], aborts: [true] },
  stop_command_rejected: {
    running: [1, 1, 0],
    current: [0.04e-12],
    z: [0, 30e-9],
    errorCall: { 'AutoApproach_OnOffSet(0)': '模拟故障：停机被拒' },
  },
}

/** 时钟派生的秒数不是判据 —— 它取决于实现读了几次钟。 */
function stripClock(t: string): string {
  return t
    .replace(/电流判定窗口 [\d.]+s/g, '电流判定窗口 <s>')
    .replace(/模块实际运行 \*\*[\d.]+s\*\*/g, '模块实际运行 **<s>**')
}

describe('结局网格 —— 20 格逐条对旧仓', () => {
  const names = Object.keys(golden.cases)

  it('脚本表覆盖金样里的每一格', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual(names.slice().sort())
  })

  for (const name of names) {
    it(name, async () => {
      const want = golden.cases[name]!
      const { res, rig } = await run(SCRIPTS[name]!)
      expect(res.success, `success（${name}）`).toBe(want.success)
      expect(stripClock(res.error ?? '')).toBe(stripClock(want.error))
      expect(rig.calls.map((c) => c.verb)).toEqual(want.verbs)
      expect(rig.calls.map((c) => c.args)).toEqual(want.calls.map((c) => c.args))
      const got = res.data as Record<string, unknown>
      expect(got['approach_started']).toBe(want.data['approach_started'])
      expect(got['running']).toEqual(want.data['running'])
      const wp = want.data['wait_progress'] as Record<string, unknown> | null
      if (wp === null) {
        expect(got['wait_progress']).toBeNull()
      } else {
        const g = got['wait_progress'] as Record<string, unknown>
        for (const k of ['polls_n', 'running_polls_n', 'z_reads_n', 'z_min_m', 'z_max_m',
          'z_travel_m', 'z_cycles_approx', 'status_flap_n', 'status_unreadable_n']) {
          expect(g[k], `wait_progress.${k}`).toEqual(wp[k])
        }
      }
    })
  }
})

describe('「模块停了」不等于「进针了」', () => {
  it('停了但电流稳定在线下 ⇒ 失败，而且**主动把模块停掉**', async () => {
    // 2026-07-10 #42：一次进针在 0.17 pA / 设定点 500 pA 上报了成功，agent 照样扫图。
    const { res, rig } = await run(SCRIPTS['stopped_but_no_current']!)
    expect(res.success).toBe(false)
    expect(res.error).toContain('针尖未进入隧穿,不要扫图')
    expect(rig.calls.filter((c) => c.verb === 'AutoApproach_OnOffSet' && c.args[0] === 0)).toHaveLength(1)
  })

  it('噪声底封住「调低电流假装进针」（#75）', async () => {
    // 设定点 0.5 pA、电流 0.4 pA：相对设定点已经 80 %，但没过 1 pA 的噪声底。
    const { res } = await run(SCRIPTS['noise_floor_blocks_gaming']!)
    expect(res.success).toBe(false)
    expect(res.error).toContain('判据 |I| ≥ 1.00 pA')
  })

  it('判不出 ⇒ 失败，但明说「**这不等于没进针**」', async () => {
    const { res } = await run(SCRIPTS['never_settles']!)
    expect(res.success).toBe(false)
    expect(res.error).toContain('**判不出**')
    expect(res.error).toContain('**这不等于没进针**')
  })

  it('电流 / 设定点读不到 ⇒ 一样判不出，并点出读不到几次', async () => {
    for (const n of ['current_unreadable', 'setpoint_unreadable']) {
      const { res } = await run(SCRIPTS[n]!)
      expect(res.success, n).toBe(false)
      expect(res.error, n).toContain('根本读不到电流/设定点')
    }
  })
})

describe('2026-08-08：报文里唯一那个秒数回答的不是人在问的那个问题', () => {
  it('超时 + Z 在推进 ⇒ 明说「**不是「卡住」**，再调一次会从当前位置继续」', async () => {
    const { res } = await run(SCRIPTS['timeout_still_advancing']!)
    expect(res.error).toContain('**粗动确实在推进**')
    expect(res.error).toContain('**再调一次 AutoApproach 会从当前粗动位置继续**')
  })

  it('超时 + Z 纹丝不动 ⇒ 「模块报在跑,压电却没动」，**没有**那句「继续」', async () => {
    // 「在动只是慢」和「根本没动」必须是两句话，因为下一步完全不同。
    const { res } = await run(SCRIPTS['timeout_z_frozen']!)
    expect(res.error).toContain('纹丝不动')
    expect(res.error).not.toContain('会从当前粗动位置继续')
  })

  it('超时 + Z 读不到 ⇒ 「粗动有没有推进无法判断」', async () => {
    const { res } = await run(SCRIPTS['timeout_z_unreadable']!)
    expect(res.error).toContain('无法判断')
  })

  it('两个秒数各有名字：**模块实际运行** 与 **电流判定窗口**', async () => {
    const { res } = await run(SCRIPTS['stopped_but_no_current']!)
    expect(res.error).toContain('模块实际运行')
    expect(res.error).toContain('电流判定窗口')
    // 运动证据排在电流证据前面
    expect(res.error!.indexOf('模块实际运行')).toBeLessThan(res.error!.indexOf('判据 |I|'))
  })
})

describe('状态位：一次读数不是一个事实', () => {
  it('读到「停了」、复读又在跑 ⇒ 继续等，并记一次 flap', async () => {
    // 那个「停了」下游会做两件不可逆的事：判失败 + 主动停机。
    const { res } = await run(SCRIPTS['status_flap']!)
    expect(res.success).toBe(true)
    const wp = (res.data as { wait_progress: Record<string, number> }).wait_progress
    expect(wp['status_flap_n']).toBe(1)
  })

  it('状态位读不懂 ⇒ 记进 `status_unreadable_n`，**不是**「没在跑」', async () => {
    const { res } = await run(SCRIPTS['status_unreadable']!)
    const wp = (res.data as { wait_progress: Record<string, number> }).wait_progress
    expect(wp['status_unreadable_n']).toBe(2)
    expect(res.success).toBe(true)
  })
})

describe('中止与停机', () => {
  it('等待相中止 ⇒ **先停模块再返回** —— 它还在跑意味着针尖还在往表面压', async () => {
    const { res, rig } = await run(SCRIPTS['abort_during_wait']!)
    expect(res.success).toBe(false)
    expect(res.error).toContain('aborted by user — AutoApproach module stopped')
    expect(rig.calls.at(-1)).toEqual({ verb: 'AutoApproach_OnOffSet', args: [0], error: '' })
  })

  it('停机命令被拒 ⇒ 报文里顶出那一行（2026-08-10：原来整段 `except: pass`）', async () => {
    // 停机没下发而调用方拿到的东西和停成功时一模一样——接下来它只会报「进针失败」，
    // 一个字都不会提「而且模块可能还在走」。
    const { res } = await run(SCRIPTS['stop_command_rejected']!)
    expect(res.error).toContain('**进针模块的停机命令没有成功下发**')
    expect(res.error).toContain('模块可能仍在推进针尖')
    expect(res.error).toContain('不要假设本技能已经把它停下了')
  })

  it('第一步之前就中止 ⇒ 一次仪器调用都不发', async () => {
    const { res, rig } = await run(SCRIPTS['abort_before_first_step']!)
    expect(rig.calls).toEqual([])
    expect(res.success).toBe(false)
    expect((res.data as Record<string, unknown>)['approach_started']).toBe(false)
  })
})

describe('四相都是必需的', () => {
  it('开模块失败 ⇒ 后面三相一步都不走', async () => {
    const { res, rig } = await run(SCRIPTS['open_fails']!)
    expect(rig.calls.map((c) => c.verb)).toEqual(['AutoApproach_Open'])
    expect(res.success).toBe(false)
  })

  it('起跑失败 ⇒ `approach_started` 保持 false', async () => {
    const { res } = await run(SCRIPTS['start_fails']!)
    expect((res.data as Record<string, unknown>)['approach_started']).toBe(false)
  })

  it('最终回读失败 ⇒ 整个组合失败（哪怕等待相已经成功）', async () => {
    const { res } = await run(SCRIPTS['verify_fails']!)
    expect(res.success).toBe(false)
    expect(res.error).toContain('verify OnOffGet failed')
  })

  it('轮询连错 5 次 ⇒ 撤，不在那个很长的超时上空转', async () => {
    const { res, rig } = await run(SCRIPTS['poll_errors_persistent']!)
    expect(res.error).toContain('OnOffGet failed persistently')
    expect(rig.calls.filter((c) => c.verb === 'AutoApproach_OnOffGet')).toHaveLength(5)
  })
})
