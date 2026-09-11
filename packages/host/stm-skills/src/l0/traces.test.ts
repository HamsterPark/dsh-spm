/**
 * 轨迹金样比对——批 1/2 每个技能、每条分支。
 *
 * 判据三样，逐条：
 * 1. **发出的动词与实参序列**相等（顺序也算）；
 * 2. `success` 相等；
 * 3. `error` / `summary` **逐字**相等，`data` 深相等。
 *
 * 金样由旧仓真实实现跑出来（`tools/spec-export/export_skill_traces.py`），
 * 脚本是**同一份**：成功、按动词首次出现逐个注错、以及第一次调用回空 body。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { emptyHardwareState, type Skill, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { IMPLEMENTED } from './index.js'

interface Trace {
  readonly success?: boolean
  readonly error?: string
  readonly summary?: string
  readonly data?: Record<string, unknown>
  readonly raised?: string
  readonly calls: { verb: string; args: unknown[]; kwargs: Record<string, unknown>; error: string }[]
  readonly runs?: { skill: string; params: Record<string, unknown> }[]
}
interface Entry {
  readonly params: Record<string, unknown>
  readonly traces: Record<string, Trace>
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/skill_traces.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, Entry>

const S0 = emptyHardwareState('T0')

/** 与导出脚本同一套合成规则。**逐位不同**，好让 body 的位置映射可判。 */
function synthOne(t: string, i: number): unknown {
  if (t === 'f' || t === 'd') return Number((0.25 * (i + 1)).toFixed(6))
  if (t === 'i' || t === 'I' || t === 'H' || t === 'h') return 3 + i
  if (t === 'c') return 65 + i
  if (t === '*c') return `SYNTH${i}`
  if (t === '*+c') return [`Sig${i}A`, `Sig${i}B`]
  if (t === '*i') return [1 + i, 2 + i]
  if (t === '*f' || t === '*d') return [Number((0.5 + i).toFixed(6)), Number((0.75 + i).toFixed(6))]
  if (t === '2f') return [[0.1 + i, 0.2 + i], [0.3 + i, 0.4 + i]]
  return Number((0.25 * (i + 1)).toFixed(6))
}

const NANONIS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/nanonis/nanonis_commands.json', import.meta.url)),
    'utf8',
  ),
) as { methods: Record<string, { returns?: string[] }> }

function synthBody(verb: string): unknown[] {
  const meta = NANONIS.methods[verb]
  if (meta === undefined) return [0.25]
  const out = (meta.returns ?? []).map((t, i) => synthOne(t, i))
  return out.length > 0 ? out : [0.25]
}

/** 与导出脚本同形的假 context：回显记忆 + 按序号注错 + 空 body。 */
function fakeCtx(opts: { errorAt?: number; emptyAt?: number; noEcho?: boolean } = {}): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
} {
  const calls: { verb: string; args: unknown[]; emergency?: true }[] = []
  const echo = new Map<string, unknown[]>()
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    const i = calls.length
    calls.push({ verb: method, args })
    if (i === opts.errorAt) {
      return Promise.resolve({ method, args, error: '模拟故障：连接被对端关闭' })
    }
    if (i === opts.emptyAt) return Promise.resolve({ method, args, values: [] })
    const base = method.endsWith('Set') || method.endsWith('Get') ? method.slice(0, -3) : undefined
    if (method.endsWith('Set') && base !== undefined) {
      echo.set(base, [...args])
      return Promise.resolve({ method, args, values: synthBody(method) })
    }
    if (method.endsWith('Get') && base !== undefined && echo.has(base) && opts.noEcho !== true) {
      return Promise.resolve({ method, args, values: [...echo.get(base)!] })
    }
    return Promise.resolve({ method, args, values: synthBody(method) })
  }
  // **假钟与导出脚本同规则**：`sleep` 把钟往前拨，不真等。
  // no-op 的 sleep 会让「预算到了没」永远为假，轮询变死循环 —— 导出那侧
  // 踩过一次（AutoApproach 在真时间上转 30 分钟）。
  let clock = 1_000_000
  const ctx: SkillContext = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: (method: string, ...args: unknown[]) => {
      const p = safeCall(method, ...args)
      calls[calls.length - 1]!.emergency = true
      return p
    },
    now: () => (clock += 1),
    sleep: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'trace-test',
    rootCallId: 'trace',
    approvalSource: 'llm',
  }
  return { ctx, calls }
}

/** 轨迹名 → 假 context 的开关。 */
function optsOf(trace: string): { errorAt?: number; emptyAt?: number; noEcho?: boolean } {
  // `mismatch` = 关掉回显：写进去什么、读回来是另一个数。
  // 这是「写后回读」那一族**最要命**的一条分支 —— 硬件没接受这个值。
  if (trace === 'mismatch') return { noEcho: true }
  const err = /^err@(\d+)$/.exec(trace)
  if (err !== null) return { errorAt: Number(err[1]) }
  const empty = /^empty@(\d+)$/.exec(trace)
  if (empty !== null) return { emptyAt: Number(empty[1]) }
  return {}
}

/**
 * **逐格登记的偏差**。写成「我们这一侧应该是什么」，而不是「这一格跳过」：
 * 两侧都钉住之后，**旧仓哪天把它修了，这里会变红**，我们就该回来删掉这一条。
 *
 * - `D-SKILL-1` 旧仓在这些格子里走 `else parsed` 兜底，把**整个回包信封**
 *   当成读数交出去（`["", "<bytes 0>", []]`）。我们按 `scalarFloat` 判「取不出数」。
 * - `D-SKILL-2` 旧仓的诊断文案里印了 Python 的回包 repr。我们这一侧信封在
 *   wire 层就拆掉了，只有 body —— 印我们真有的东西。
 */
interface Deviation {
  readonly data?: Record<string, unknown>
  readonly error?: string
  /**
   * 金样里有、本仓**故意没有**的字段（点分路径）。
   *
   * 比整份 `data` 抄一遍轻，而且**抄不成一份过期的期望**：测试会先断言这个路径
   * 在金样里确实存在——差异消失时这条登记会当场变红，而不是安静地什么都不管。
   */
  readonly absent?: readonly string[]
  /**
   * 动词序列**不比**，附上理由。
   *
   * 只在旧仓那一趟里**有步骤炸了**时才允许（测试会去金样的 `_progress.failed_steps`
   * 里核实）：一次抛出去的异常会跳过那一步剩下的动作，于是后面每一拍的时刻都偏了。
   * 比较一个从崩溃点之后错位的序列，比不比更糟——它看起来像在测什么。
   *
   * 它同时豁免 `_progress` 与 `polls`：执行器的步骤台账、以及那些对不上的调用的计数，
   * 都是同一次崩溃的直接后果。**结局字段照比** —— 那才是判据。
   */
  readonly callsDifferBecause?: string
}

/** 按点分路径删一个键。返回它原来在不在。 */
function dropPath(obj: unknown, path: string): boolean {
  const parts = path.split('.')
  let cur = obj
  for (const seg of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return false
    cur = (cur as Record<string, unknown>)[seg]
  }
  const last = parts[parts.length - 1]!
  if (cur === null || typeof cur !== 'object' || !(last in (cur as object))) return false
  delete (cur as Record<string, unknown>)[last]
  return true
}

const DEVIATIONS: Readonly<Record<string, Deviation>> = {
  // ── D-SKILL-1：信封不当读数 ──
  'GetBiasCalibration/empty@0': { data: { calibration: null, offset: 0 } },
  'GetSetpoint/empty@0': { data: { setpoint_a: null } },
  'GetScanFrame/empty@0': { data: { raw: [] } },
  'GetScanSpeed/empty@0': { data: { raw: [] } },
  'GetScanBuffer/empty@0': { data: { raw: [] } },
  'GetTipSpeed/empty@0': { data: { raw: [] } },
  'GetPointShootOnOff/empty@0': { data: { raw: [] } },
  'GetZCtrlGain/empty@0': { data: { raw: [] } },
  'GetPiezoTilt/empty@0': { data: { raw: [] } },
  'GetPiezoSensitivity/empty@0': { data: { raw: [] } },
  'GetDriftCompensation/empty@0': { data: { raw: [] } },
  'GetPiezoXYZLimits/empty@0': { data: { raw: [] } },
  'MotorGetPos/empty@0': { data: { raw: [] } },
  'GetMotorStepCounter/empty@0': { data: { raw: [] } },
  'GetSignalRange/empty@0': { data: { signal_index: 63, raw: [] } },
  'SetScanBuffer/empty@0': { data: { raw: [] } },
  // ── D-SKILL-2：诊断文案里的回包形状 ──
  'GetAutoApproachStatus/empty@0': {
    error:
      'AutoApproach_OnOffGet 回来了,但状态位读不懂(values=[])—— 这**不是**「没在进针」,是没问出来。',
  },
  'ListSignalChannels/empty@0': {
    error: 'Could not parse signal names from response: []',
  },
  // ── D-SCAN-2：轮询自己那道中止检查不移植，于是没人再写 partial.aborted ──
  //
  // 旧仓 `run_composite` 起手 `set_partial_default("aborted", False)`，而唯一的
  // 写入方是轮询里那道中止分支。去掉那道检查之后这个键恒为 false ——
  // 一个永远不表示任何事的字段，按消融的纪律不该存在。
  // 中止本身照常记在 `progress.aborted` 与 `abort_facts` 里（而且只有一个说法）。
  ...Object.fromEntries(
    ['ok', 'err@0', 'err@5', 'err@6', 'err@19', 'err@22', 'err@23', 'err@24'].map((t) => [
      `WaitScanComplete/${t}`,
      { absent: ['_progress.partial_data.aborted'] },
    ]),
  ),
  // ── D-SKILL-3 的又一格：空 body 上旧仓的轮询**炸了** ──
  //
  // 旧仓读状态用的是 `parsed[2][0]`，空 body ⇒ IndexError ⇒ 那一步被 `optional`
  // 吞掉（金样里看得见：`failed_steps: ["poll_0"]`）。**这同时是 GraphExecutor 的
  // optional 路第一次在一个真技能上被走到。** 崩掉的那一步不会 sleep，于是从它之后
  // 每一拍的时刻都比本仓早半个轮询，动词序列整体错位。
  'WaitScanComplete/empty@0': {
    absent: ['_progress.partial_data.aborted'],
    callsDifferBecause: '旧仓 poll_0 在空 body 上抛 IndexError（被 optional 吞掉），此后时序错位',
  },
}

/**
 * **时钟派生的字段不比对。**
 *
 * `read_at` 是墙钟，`confirm_waited_s` 是「轮询里走过多少时间」。后者看起来像个
 * 判据，其实不是：要让两侧逐位相同，等于要求 TS 调 `now()` 的**次数**与 Python
 * 调 `monotonic()` 的次数完全一致 —— 那是实现细节，不是判断。
 *
 * 钉的是它们的**形状**（是个数、在预算之内），在下面单独一条测试里。
 */
// 时钟读数不是判据。`elapsed_s` / `started_at` / `last_update_at` 的具体值取决于
// 实现读了几次钟——把它钉住只会让每一次无关重构都变红，而它一次真 bug 也抓不到。
const VOLATILE = new Set([
  'read_at', 'confirm_waited_s', 'elapsed_s', 'started_at', 'last_update_at',
])

/** 递归剥掉时钟字段。 */
function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, x]) => [k, stripVolatile(x)]),
    )
  }
  return v
}

const names = Object.keys(IMPLEMENTED).sort()

describe('轨迹金样：批 1/2 逐条对旧仓', () => {
  it('已实现的技能都在金样里', () => {
    expect(names.filter((n) => golden[n] === undefined)).toEqual([])
  })

  for (const name of names) {
    const entry = golden[name]!
    const skill: Skill = IMPLEMENTED[name]!

    describe(name, () => {
      for (const [traceName, want] of Object.entries(entry.traces)) {
        // 抛异常那条是旧仓自己的缺陷（见 deviations D-SKILL-2），单独测，不在这里比
        if (want.raised !== undefined) continue

        it(`${traceName}：动词序列与返回都相等`, async () => {
          const { ctx, calls } = fakeCtx(optsOf(traceName))
          const got = await skill.execute(ctx, entry.params)

          const dev = DEVIATIONS[`${name}/${traceName}`]
          if (dev?.callsDifferBecause === undefined) {
            expect(calls.map((c) => [c.verb, c.args])).toEqual(
              want.calls.map((c) => [c.verb, c.args]),
            )
          } else {
            // 豁免只在旧仓真的炸了一步时成立——去金样里核实，别信这段注释
            const prog = (want.data as { _progress?: { failed_steps?: string[] } } | undefined)
              ?._progress
            expect(prog?.failed_steps ?? [], dev.callsDifferBecause).not.toEqual([])
          }
          expect(got.success).toBe(want.success === true)

          if (dev?.error === undefined) {
            expect(got.error ?? '').toBe(want.error ?? '')
          } else {
            expect(got.error ?? '').toBe(dev.error)
            expect(want.error ?? '').not.toBe(dev.error) // 旧仓那一侧也钉住
          }

          expect(got.summary ?? '').toBe(want.summary ?? '')

          if (dev?.data === undefined) {
            const wantData = stripVolatile(want.data ?? {})
            const gotData = stripVolatile(got.data ?? {})
            if (dev?.callsDifferBecause !== undefined) {
              // `polls` 就是**那些对不上的调用**的计数，`_progress` 是执行器为它们
              // 记的台账。两者都是同一次崩溃的直接后果，不是第二条证据。
              for (const k of ['_progress', 'polls']) {
                dropPath(wantData, k)
                dropPath(gotData, k)
              }
            }
            for (const path of dev?.absent ?? []) {
              // 先钉住「金样里确实有它」——否则这条登记会在差异消失之后静静地留着
              // `callsDifferBecause` 已经把 `_progress` 整个摘掉了，那条路径下的
              // absent 登记这时不再适用
              if (dev?.callsDifferBecause !== undefined && path.startsWith('_progress.')) continue
              expect(dropPath(wantData, path), `金样里没有 ${path}，这条 absent 登记过期了`)
                .toBe(true)
            }
            expect(gotData).toEqual(wantData)
          } else {
            expect(stripVolatile(got.data ?? {})).toEqual(dev.data)
            expect(stripVolatile(want.data ?? {})).not.toEqual(dev.data)
          }
        })
      }
    })
  }
})

describe('D-SKILL-3 · 旧仓会抛 IndexError 的那一格，我们判「读不出」', () => {
  it('GetSafeTipStatus 收到空 body：失败而不是抛', async () => {
    // 旧仓这里直接 `parsed[2][0]` —— 空 body 时抛 IndexError，
    // 于是一个只读技能以一句**看不懂的**异常失败。而「保护未开」和
    // 「没问出来」是两句必须分开的话：前者可以继续，后者不能。
    expect(golden['GetSafeTipStatus']!.traces['empty@0']!.raised).toContain('IndexError')
    const { ctx } = fakeCtx({ emptyAt: 0 })
    const got = await IMPLEMENTED['GetSafeTipStatus']!.execute(ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('这**不是**「保护未开」,是没问出来')
  })
})

describe('时钟派生字段：不比数值，比形状', () => {
  it('SafeRetract 的 confirm_waited_s 是个数，且不超过 5 s 的确认预算', async () => {
    // 预算有界是「轮询不看 abort」那条能成立的前提：退针在 abort 之后也放行，
    // 而这几秒只读的确认恰恰是在确认那个 abort 想要的动作。
    const { ctx } = fakeCtx()
    const got = await IMPLEMENTED['SafeRetract']!.execute(ctx, {})
    const waited = (got.data as { confirm_waited_s: number }).confirm_waited_s
    expect(typeof waited).toBe('number')
    expect(waited).toBeGreaterThan(0)
    expect(waited).toBeLessThanOrEqual(5.5) // 预算 5 s + 最后一次读的开销
  })

  it('没声明 z_extend_sign 时**立刻收工**，不耗光预算', async () => {
    // 「白等」和「超时」是两件事：报成超时会让人去调大预算，
    // 而该做的是去仪器档案里填那个符号。
    // 默认脚本里 Z 反馈读回来是**闭合**，那一条读数就把结论定死成 not_parked，
    // 根本走不到「没声明符号」那一步。要让它现身，得让反馈读失败（err@1）。
    const { ctx, calls } = fakeCtx({ errorAt: 1 })
    const got = await IMPLEMENTED['SafeRetract']!.execute(ctx, {})
    const park = (got.data as { park: { undeclared: string[] } }).park
    expect(park.undeclared).toEqual(['z_extend_sign'])
    // 一趟读（1 次 Withdraw + 6 次读）就收工，**没有第二轮**
    expect(calls.length).toBeLessThanOrEqual(8)
    // 对照：反馈读得到时它会轮满预算
    const full = fakeCtx()
    await IMPLEMENTED['SafeRetract']!.execute(full.ctx, {})
    expect(full.calls.length).toBeGreaterThan(100)
  })
})
