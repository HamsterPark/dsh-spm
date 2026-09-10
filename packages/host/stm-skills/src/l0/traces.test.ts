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
function fakeCtx(opts: { errorAt?: number; emptyAt?: number } = {}): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
} {
  const calls: { verb: string; args: unknown[] }[] = []
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
    if (method.endsWith('Get') && base !== undefined && echo.has(base)) {
      return Promise.resolve({ method, args, values: [...echo.get(base)!] })
    }
    return Promise.resolve({ method, args, values: synthBody(method) })
  }
  const ctx: SkillContext = {
    signal: new AbortController().signal,
    safeCall,
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
function optsOf(trace: string): { errorAt?: number; emptyAt?: number } {
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
  // ── D-SKILL-2：诊断文案里的回包形状 ──
  'GetAutoApproachStatus/empty@0': {
    error:
      'AutoApproach_OnOffGet 回来了,但状态位读不懂(values=[])—— 这**不是**「没在进针」,是没问出来。',
  },
  'ListSignalChannels/empty@0': {
    error: 'Could not parse signal names from response: []',
  },
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

          expect(calls.map((c) => [c.verb, c.args])).toEqual(
            want.calls.map((c) => [c.verb, c.args]),
          )
          expect(got.success).toBe(want.success === true)
          const dev = DEVIATIONS[`${name}/${traceName}`]

          if (dev?.error === undefined) {
            expect(got.error ?? '').toBe(want.error ?? '')
          } else {
            expect(got.error ?? '').toBe(dev.error)
            expect(want.error ?? '').not.toBe(dev.error) // 旧仓那一侧也钉住
          }

          expect(got.summary ?? '').toBe(want.summary ?? '')

          if (dev?.data === undefined) {
            expect(got.data ?? {}).toEqual(want.data ?? {})
          } else {
            expect(got.data ?? {}).toEqual(dev.data)
            expect(want.data ?? {}).not.toEqual(dev.data)
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
