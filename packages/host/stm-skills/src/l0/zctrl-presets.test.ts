/**
 * `ApplyZCtrlPreset` 与 `ListZCtrlPresets` —— 8 格应用 + 2 格清单，逐条对旧仓。
 *
 * 这两个技能的要害不是它们发了什么，是**它们不发什么**：整条路上没有一个数字
 * 参数，于是也就没有地方让一个丢掉的指数落进去（2026-08-03 `p_gain=3` 那次）。
 * 所以判据落在**子技能调用序列**上——谁被调了、带着哪几个数。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PresetStore,
  type ApproachProfile,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
  type StoredPreset,
} from 'dsh-spm-kernel'
import { makeApplyZCtrlPreset, makeListZCtrlPresets } from './zctrl-presets.js'

interface ApplyCase {
  preset: string
  runs: { skill: string; params: Record<string, number> }[]
  success: boolean
  error: string
  data: Record<string, unknown>
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/zctrl_presets.json', import.meta.url)),
    'utf8',
  ),
) as {
  apply: Record<string, ApplyCase>
  list: Record<string, { success: boolean; data: Record<string, unknown> }>
}

const GENTLE: StoredPreset = { name: 'gentle', p_gain: '3p', i_gain: '180n' }
const FIRM: StoredPreset = {
  name: 'firm',
  p_gain: '5p',
  i_gain: '200n',
  setpoint_a: '150p',
  note: '带设定点的一组',
}
const PROFILE: ApproachProfile = { pGainM: 3e-12, iGainMPerS: 180e-9, setpointA: 50e-12 }

function storeOf(items: readonly StoredPreset[]): PresetStore {
  const s = new PresetStore()
  for (const it of items) s.upsert({ ...it }, true)
  return s
}

/** 脚本化子技能分派 + 一个只回 `Scan_FrameGet` 的 `safeCall`。 */
function rig(opts: { fail?: Record<string, string>; frameM?: number | null } = {}): {
  ctx: SkillContext
  runs: { skill: string; params: Record<string, unknown> }[]
  calls: string[]
} {
  const runs: { skill: string; params: Record<string, unknown> }[] = []
  const calls: string[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push(m)
      const w = opts.frameM
      if (w === null || w === undefined) {
        return Promise.resolve({ method: m, args: a, error: '模拟故障：读不到帧' })
      }
      // (center_x, center_y, width, height, angle)
      return Promise.resolve({ method: m, args: a, values: [0, 0, w, 0, 0] })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: (n: string, p: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
      runs.push({ skill: n, params: { ...p } })
      const err = opts.fail?.[n]
      return Promise.resolve(
        err === undefined ? { success: true, data: {} } : { success: false, error: err },
      )
    },
  } as unknown as SkillContext
  return { ctx, runs, calls }
}

/** 每一格的前提：存了哪几组、档案配没配、帧宽读不读得到。 */
const SETUP: Readonly<
  Record<string, { presets: StoredPreset[]; profile?: ApproachProfile; fail?: Record<string, string>; frameM?: number }>
> = {
  custom_no_setpoint: { presets: [GENTLE] },
  custom_with_setpoint: { presets: [GENTLE, FIRM] },
  approach: { presets: [], profile: PROFILE },
  gain_write_fails: { presets: [FIRM], fail: { SetZCtrlGain: '模拟故障：写后回读不一致' } },
  setpoint_write_fails: { presets: [FIRM], fail: { SetSetpoint: '模拟故障：写后回读不一致' } },
  unknown_name: { presets: [GENTLE] },
  tier_without_gains: { presets: [] },
  scan_without_frame: { presets: [] },
}

describe('ApplyZCtrlPreset —— 8 格逐条对旧仓', () => {
  for (const [key, c] of Object.entries(golden.apply)) {
    it(key, async () => {
      const s = SETUP[key]
      expect(s, `${key} 没写前提`).toBeDefined()
      const { ctx, runs } = rig({
        ...(s!.fail === undefined ? {} : { fail: s!.fail }),
        ...(s!.frameM === undefined ? {} : { frameM: s!.frameM }),
      })
      const skill = makeApplyZCtrlPreset({
        store: storeOf(s!.presets),
        approachProfile: () => s!.profile ?? null,
      })
      const r = await skill.execute(ctx, { preset: c.preset })

      // **子技能调用序列**是这个技能的产品：谁被调了、带着哪几个数
      expect(runs).toEqual(c.runs)
      expect(r.success).toBe(c.success)
      expect(r.error ?? '').toBe(c.error)
      expect(r.data ?? {}).toEqual(c.data)
    })
  }

  it('`scan` 才去读帧 —— 别的名字读它没有意义', async () => {
    const { ctx, calls } = rig({ frameM: 50e-9 })
    await makeApplyZCtrlPreset({ store: storeOf([GENTLE]) }).execute(ctx, { preset: 'gentle' })
    expect(calls).toEqual([])

    const b = rig({ frameM: 50e-9 })
    await makeApplyZCtrlPreset({ store: storeOf([]) }).execute(b.ctx, { preset: 'scan' })
    expect(b.calls).toEqual(['Scan_FrameGet'])
  })

  it('**增益写失败就不写设定点** —— 一半的参数组比不换更难查', async () => {
    const { ctx, runs } = rig({ fail: { SetZCtrlGain: 'boom' } })
    await makeApplyZCtrlPreset({ store: storeOf([FIRM]) }).execute(ctx, { preset: 'firm' })
    expect(runs.map((r) => r.skill)).toEqual(['SetZCtrlGain'])
  })

  it('没有设定点的组**不发** SetSetpoint —— 「未配置」是保持当前值,不是写 0', async () => {
    const { ctx, runs } = rig()
    await makeApplyZCtrlPreset({ store: storeOf([GENTLE]) }).execute(ctx, { preset: 'gentle' })
    expect(runs.map((r) => r.skill)).toEqual(['SetZCtrlGain'])
  })

  it('一个数字参数都不接受 —— 模型只能说名字', () => {
    const params = makeApplyZCtrlPreset().spec.parameters ?? []
    expect(params.map((p) => p.name)).toEqual(['preset'])
    expect(params[0]?.type).toBe('str')
  })
})

describe('ListZCtrlPresets —— 2 格逐条对旧仓', () => {
  const LIST_SETUP: Readonly<Record<string, { presets: StoredPreset[]; profile?: ApproachProfile }>> =
    {
      no_profile_two_customs: { presets: [GENTLE, FIRM] },
      profile_configured: { presets: [], profile: PROFILE },
    }

  for (const [key, c] of Object.entries(golden.list)) {
    it(key, async () => {
      const s = LIST_SETUP[key]!
      const { ctx, calls } = rig()
      const r = await makeListZCtrlPresets({
        store: storeOf(s.presets),
        approachProfile: () => s.profile ?? null,
      }).execute(ctx, {})
      expect(r.success).toBe(c.success)
      expect(r.data ?? {}).toEqual(c.data)
      // **列清单不做硬件 I/O** —— `scan` 那一行如实说「应用时才确定」
      expect(calls).toEqual([])
    })
  }
})
