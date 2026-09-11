/**
 * `ApproachTip` 的分派网格 —— 15 格逐条对旧仓。
 *
 * 它是本仓第一个 **L2** 技能：自己不发裸动词，只调别的技能。所以判据是
 * **调了哪些技能、按什么顺序**，加上逃逸闸被记还是被清，加上最后那句话逐字。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ApproachRefusalLatch,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { makeApproachTip } from './approach-tip.js'

interface TipCase {
  params: Record<string, unknown>
  success: boolean
  error: string
  data: Record<string, unknown>
  runs: { skill: string; params: Record<string, unknown> }[]
  refusal_after: { reason: string; source: string; owner: string } | null
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/approach_tip.json', import.meta.url)),
    'utf8',
  ),
) as { cases: Record<string, TipCase> }

const SP = 50e-12
const ON = 46.6e-12
const OFF = 0.04e-12
const SCOPE = 'group#R1'

type SubResult = { success: boolean; data?: Record<string, unknown>; error?: string }

interface Script {
  engage?: SubResult
  auto?: SubResult
  current?: (number | null)[]
  setpoint?: number | null
  aborts?: boolean[]
  priorRefusal?: { reason: string; owner: string }
  params?: Record<string, unknown>
}

const ENG_OK: SubResult = {
  success: true,
  data: { engaged: true, peak_current_a: ON, setpoint_a: SP },
}
const ENG_NEEDS: SubResult = {
  success: true,
  data: { engaged: false, needs_auto_approach: true, setpoint_a: SP },
}
const ENG_MAYBE: SubResult = { success: true, data: { engaged: false, needs_auto_approach: false } }
const ENG_FAIL: SubResult = { success: false, error: 'Z 反馈开关读不出' }

/** 与导出脚本 `_ScriptCtx` 同形：**只有 `runSkill`**，一次裸动词都不发。 */
class Rig {
  readonly runs: { skill: string; params: Record<string, unknown> }[] = []
  readonly latch: ApproachRefusalLatch
  #clock = 1_000_000
  #current: (number | null)[]
  #aborts: boolean[]
  #abortedFlag = false

  constructor(private readonly s: Script) {
    this.#current = [...(s.current ?? [ON])]
    this.#aborts = [...(s.aborts ?? [])]
    this.latch = new ApproachRefusalLatch(() => this.#clock / 1000)
    if (s.priorRefusal) {
      this.latch.record(s.priorRefusal.reason, {
        source: 'ApproachTip',
        owner: s.priorRefusal.owner,
      })
    }
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
      owner: 'group',
      rootCallId: 'R1',
      now: () => {
        this.#clock += 1
        return this.#clock
      },
      sleep: (ms: number) => {
        this.#clock += ms
        return Promise.resolve()
      },
      // 裸动词这条路**故意通向失败**：L2 技能一次都不该走它。
      safeCall: (method: string) =>
        Promise.resolve({ method, args: [], error: `ApproachTip 不该发裸动词 '${method}'` }),
      runSkill: (name: string, params: Readonly<Record<string, unknown>>) =>
        Promise.resolve(this.#sub(name, params)),
    } as unknown as SkillContext
  }

  #nextAbort(): boolean {
    if (this.#abortedFlag) return true
    const v = this.#aborts.shift() ?? false
    if (v) this.#abortedFlag = true
    return v
  }

  #sub(name: string, params: Readonly<Record<string, unknown>>): SkillResultLike {
    this.runs.push({ skill: name, params: { ...params } })
    const wrap = (r: SubResult): SkillResultLike =>
      r.success
        ? { success: true, data: r.data ?? {} }
        : { success: false, error: r.error ?? '', data: r.data ?? {} }
    if (name === 'TryEngageController') return wrap(this.s.engage ?? {} as SubResult)
    if (name === 'AutoApproach') return wrap(this.s.auto ?? { success: true, data: {} })
    if (name === 'GetCurrent') {
      const v = this.#current.length > 1 ? this.#current.shift()! : (this.#current[0] ?? null)
      return v === null
        ? { success: false, error: '读电流失败', data: {} }
        : { success: true, data: { current_a: v } }
    }
    if (name === 'GetSetpoint') {
      const sp = this.s.setpoint === undefined ? SP : this.s.setpoint
      return sp === null
        ? { success: false, error: '读设定点失败', data: {} }
        : { success: true, data: { setpoint_a: sp } }
    }
    return { success: true, data: {} }
  }
}

async function run(s: Script): Promise<{ res: SkillResultLike; rig: Rig }> {
  const rig = new Rig(s)
  const skill = makeApproachTip({ latch: rig.latch, engageBudgetS: 4.0, engageIntervalS: 1.0 })
  return { res: await skill.execute(rig.ctx(), s.params ?? {}), rig }
}

/** 名字 → 脚本。与 `export_approach_tip.py` 的 `case` 一一对应。 */
const SCRIPTS: Record<string, Script> = {
  engaged_via_feedback: { engage: ENG_OK },
  engage_clears_own_refusal: {
    engage: ENG_OK,
    priorRefusal: { reason: '上一次的拒绝', owner: SCOPE },
  },
  engage_cannot_clear_other_chain: {
    engage: ENG_OK,
    priorRefusal: { reason: '群跑记的', owner: 'chat#R9' },
  },
  engage_phase_fails: { engage: ENG_FAIL },
  no_tunnel_no_flag: { engage: ENG_MAYBE },
  escalates_and_verifies: { engage: ENG_NEEDS, current: [ON] },
  escalation_clears_prior_refusal: {
    engage: ENG_NEEDS,
    current: [ON],
    priorRefusal: { reason: '上一次的拒绝', owner: SCOPE },
  },
  auto_approach_fails: {
    engage: ENG_NEEDS,
    auto: { success: false, error: 'AutoApproach 模块已停止,且电流稳定地没有达到进针判据' },
  },
  verify_below_bar: { engage: ENG_NEEDS, current: [OFF] },
  verify_never_settles: {
    engage: ENG_NEEDS,
    current: Array.from({ length: 12 }, () => [ON, OFF]).flat(),
  },
  verify_current_unreadable: { engage: ENG_NEEDS, current: [null] },
  verify_setpoint_unreadable: { engage: ENG_NEEDS, current: [ON], setpoint: null },
  verify_aborted: { engage: ENG_NEEDS, current: [ON], aborts: [true] },
  verify_noise_floor: { engage: ENG_NEEDS, current: [0.4e-12], setpoint: 0.5e-12 },
  settle_s_passes_through: { params: { settle_s: 3.0 }, engage: ENG_OK },
}

/** 时钟派生的秒数不是判据。 */
const stripClock = (t: string): string => t.replace(/电流判定窗口 [\d.]+s/g, '电流判定窗口 <s>')

describe('分派网格 —— 15 格逐条对旧仓', () => {
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
      expect(rig.runs.map((r) => r.skill)).toEqual(want.runs.map((r) => r.skill))
      expect(rig.runs[0]?.params).toEqual(want.runs[0]?.params)
      const got = res.data as Record<string, unknown>
      for (const k of ['engaged', 'method', 'auto_approach_used', 'measured_current_a',
        'setpoint_a', 'peak_current_a', 'message', 'phase']) {
        if (k in want.data) expect(got[k], `data.${k}`).toEqual(want.data[k])
      }
      // 逃逸闸终态：谁记的、理由是什么
      const r = rig.latch.active()
      if (want.refusal_after === null) {
        expect(r).toBeNull()
      } else {
        expect(r?.owner).toBe(want.refusal_after.owner)
        expect(r?.reason).toBe(want.refusal_after.reason)
        expect(r?.source).toBe(want.refusal_after.source)
      }
    })
  }
})

describe('两相分派：先试安全的那条', () => {
  it('已经在隧穿范围内 ⇒ **一次马达都不动**', async () => {
    const { res, rig } = await run({ engage: ENG_OK })
    expect(res.success).toBe(true)
    expect(rig.runs.map((r) => r.skill)).toEqual(['TryEngageController'])
    expect((res.data as Record<string, unknown>)['auto_approach_used']).toBe(false)
  })

  it('只有 `needs_auto_approach` 才升级', async () => {
    const { rig } = await run({ engage: ENG_NEEDS, current: [ON] })
    // 复核要**两轮**一致的读数（`ENGAGE_AGREE_N`），所以那对只读技能各调两次。
    expect(rig.runs.map((r) => r.skill)).toEqual([
      'TryEngageController', 'AutoApproach',
      'GetCurrent', 'GetSetpoint', 'GetCurrent', 'GetSetpoint',
    ])
  })

  it('**不在一个「也许」上开粗进针**', async () => {
    // engage 既没建立隧穿、也没说需要粗进针 —— 两个判据自相矛盾，停下来。
    const { res, rig } = await run({ engage: ENG_MAYBE })
    expect(res.success).toBe(false)
    expect(res.error).toContain('stopping rather than approaching on a maybe')
    expect(rig.runs.map((r) => r.skill)).toEqual(['TryEngageController'])
  })

  it('`settle_s` 透传给第一相', async () => {
    const { rig } = await run({ params: { settle_s: 3.0 }, engage: ENG_OK })
    expect(rig.runs[0]?.params).toEqual({ settle_s: 3.0 })
    const d = await run({ engage: ENG_OK })
    expect(d.rig.runs[0]?.params).toEqual({ settle_s: 1.5 })
  })

  it('L2 技能**一次裸动词都不发**', async () => {
    // 桩里 `safeCall` 通向失败，所以只要它被走到就会露出来。
    for (const n of Object.keys(SCRIPTS)) {
      const { res } = await run(SCRIPTS[n]!)
      expect(String(res.error ?? ''), n).not.toContain('不该发裸动词')
    }
  })
})

describe('最后一道防线：自己再测一次', () => {
  it('粗进针报成功、而电流稳定在线下 ⇒ **仍然失败**', async () => {
    // 2026-07-10：一次过期的续跑让 AutoApproach 一相都没跑就报了成功，
    // agent 于是在 0.17 pA / 设定点 500 pA 上「确认」进针成功，然后去扫图。
    const { res } = await run({ engage: ENG_NEEDS, auto: { success: true, data: {} }, current: [OFF] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('post-approach verification FAILED')
    expect(res.error).toContain('不要扫图')
  })

  it('这次复核也走**两次一致** —— 它就长在第一处的下游', async () => {
    // 曾经两处都是单次瞬时读数，于是真机上一次成功的进针可能被同一个瞬态判死两遍。
    const { res } = await run({
      engage: ENG_NEEDS,
      current: [OFF, ON, ON], // 一次瞬态，随后稳住
    })
    expect(res.success).toBe(true)
    expect((res.data as { engagement: { agreed_n: number } }).engagement.agreed_n).toBe(2)
  })

  it('判不出 ⇒ 明说「**这不等于没进针**,也不等于进针了」', async () => {
    const { res } = await run(SCRIPTS['verify_never_settles']!)
    expect(res.error).toContain('判不出结果')
    expect(res.error).toContain('**这不等于没进针**')
  })

  it('噪声底在这一处**同样**生效（#75）', async () => {
    const { res } = await run(SCRIPTS['verify_noise_floor']!)
    expect(res.success).toBe(false)
    expect(res.error).toContain('判据 |I| ≥ 1.00 pA')
  })

  it('复核用**只读技能**，不用裸动词 —— 它们各自带着自己的读包判据', async () => {
    const { rig } = await run({ engage: ENG_NEEDS, current: [ON] })
    expect(new Set(rig.runs.slice(2).map((r) => r.skill))).toEqual(
      new Set(['GetCurrent', 'GetSetpoint']),
    )
  })
})

describe('逃逸闸：三个记拒绝的点，两个清的点', () => {
  it('第一相失败 ⇒ **记**一次拒绝（挡住直接调 AutoApproach）', async () => {
    const { rig } = await run({ engage: ENG_FAIL })
    const r = rig.latch.active()!
    expect(r.reason).toContain('engage phase failed')
    expect(r.owner).toBe(SCOPE)
  })

  it('自相矛盾 ⇒ 也记', async () => {
    const { rig } = await run({ engage: ENG_MAYBE })
    expect(rig.latch.active()?.reason).toContain('stopping rather than approaching on a maybe')
  })

  it('第一相进成 ⇒ **清**掉本链的拒绝', async () => {
    const { rig } = await run(SCRIPTS['engage_clears_own_refusal']!)
    expect(rig.latch.active()).toBeNull()
  })

  it('⚠️ 清不掉**别的链**记的（2026-07-28 致命一(c)）', async () => {
    // 私聊里的一次成功 engage 曾经把群聊十秒前记下的拒绝抹掉，侧门重新打开。
    const { res, rig } = await run(SCRIPTS['engage_cannot_clear_other_chain']!)
    expect(res.success).toBe(true) // 这一趟自己是成功的
    expect(rig.latch.active()?.owner).toBe('chat#R9') // 而那条拒绝还在
  })

  it('**升级本身**就是出路：它在新证据上取代早先的拒绝', async () => {
    // 这正是「再调一次 ApproachTip」成为逃逸闸出路的机制，而不是「等 TTL 过期」。
    const { res, rig } = await run(SCRIPTS['escalation_clears_prior_refusal']!)
    expect(res.success).toBe(true)
    expect(rig.latch.active()).toBeNull()
  })

  it('粗进针自己失败**不**记拒绝 —— 那不是一次「拒绝升级」', async () => {
    // 拒绝记的是「我决定不升级」。已经升级了然后失败，是另一件事：
    // 它不该挡住下一次直接调用（那次调用有它自己的闸）。
    const { rig } = await run(SCRIPTS['auto_approach_fails']!)
    expect(rig.latch.active()).toBeNull()
  })
})
