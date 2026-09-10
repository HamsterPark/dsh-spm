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
 * **D-SKILL-1 的逐格登记**：Python 在这些格子里把整个回包信封当成读数交出去
 * （`else parsed` 兜底），我们按 `scalarFloat` 判为「取不出数」。
 *
 * 写成 `<技能>/<轨迹> → 我们这一侧的 data`，而不是「跳过这一格」：
 * 两侧都钉住之后，**旧仓哪天把这条修了，这里会变红**，我们就该回来删掉这一条。
 * 一条偏差不该无限期地活着。
 */
const D_SKILL_1: Readonly<Record<string, Record<string, unknown>>> = {
  'GetBiasCalibration/empty@0': { calibration: null, offset: 0 },
  'GetSetpoint/empty@0': { setpoint_a: null },
  'GetScanFrame/empty@0': { raw: [] },
  'GetScanSpeed/empty@0': { raw: [] },
  'GetScanBuffer/empty@0': { raw: [] },
  'GetTipSpeed/empty@0': { raw: [] },
  'GetPointShootOnOff/empty@0': { raw: [] },
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
          expect(got.error ?? '').toBe(want.error ?? '')
          expect(got.summary ?? '').toBe(want.summary ?? '')
          const dev = D_SKILL_1[`${name}/${traceName}`]
          if (dev === undefined) {
            expect(got.data ?? {}).toEqual(want.data ?? {})
          } else {
            // 我们这一侧钉住
            expect(got.data ?? {}).toEqual(dev)
            // 旧仓那一侧也钉住 —— 它哪天修了，这一行变红
            expect(want.data ?? {}).not.toEqual(dev)
          }
        })
      }
    })
  }
})
