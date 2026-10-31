/**
 * MotorMove 的两个 Z 标签按本机声明的退针方向换算（D-MOTORZ-1）—— 判定表逐格钉住。
 *
 * | 档案 | `z-retract` | `z-approach` | `z_direction_basis` | `warning` 与 `summary` | 下发 |
 * |---|---|---|---|---|---|
 * | A 声明 z+ | 4 | 5 | `declared_z+` | 无 | 是 |
 * | B 声明 z− | 5 | 4 | `declared_z-` | 无 | 是 |
 * | C 没声明 | 4 | 5 | `undeclared_nanonis_standard` | 有 | 是 |
 * | D 读不到 | — | — | — | 失败，`Z_DIR_UNREADABLE` | **否** |
 *
 * 只断言 `success` 的测试挡不住写死 Z+：这里每一格都断言 `Motor_StartMove` 的第一个实参，
 * 「读不到」断言一次都没发。`batch5b.json` 的 `motor_z/*` 对参考实现钉住 A–C 与
 * 「读退针方向的函数抛了」；「宿主没接」与「整个读口抛出」是本仓独有的状态，只在这里。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  SkillKernel,
  emptyHardwareState,
  processInstrumentProfile,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { IMPLEMENTED } from './index.js'
import { MotorMove, RETRACT_DIR_UNDECLARED_WARNING, Z_DIR_UNREADABLE } from './writes-gated.js'

/** 只有取 `retract_motor_dir` 时抛的档案对象。先装 getter，**不要**再展开它（展开会调 getter）。 */
function retractDirUnreadable(): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  Object.defineProperty(o, 'retract_motor_dir', {
    enumerable: true,
    get(): never {
      throw new Error('profile unreadable')
    },
  })
  return o
}

/** 档案读口的几种接法：没接、整个抛、只有退针方向读不出、一份档案。 */
type Profile = 'no-source' | 'source-throws' | 'retract-dir-throws' | Record<string, unknown>

function install(p: Profile): void {
  processInstrumentProfile.source =
    p === 'no-source'
      ? null
      : p === 'source-throws'
        ? () => {
            throw new Error('profile unreadable')
          }
        : p === 'retract-dir-throws'
          ? () => retractDirUnreadable()
          : () => p
}

afterEach(() => {
  processInstrumentProfile.source = null
})

/** MotorMove 直接 execute 用的最小 context：只记下发了什么。 */
function rig(): { ctx: SkillContext; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = []
  const s0 = emptyHardwareState('T0')
  const ctx = {
    safeCall: (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
      calls.push({ method, args })
      return Promise.resolve({ method, args, values: [] })
    },
    state: () => s0,
  } as unknown as SkillContext
  return { ctx, calls }
}

const TABLE = [
  ['A 声明 z+', { retract_motor_dir: 'z+' }, 4, 5, 'declared_z+'],
  ['B 声明 z−', { retract_motor_dir: 'z-' }, 5, 4, 'declared_z-'],
  ['C 没声明', {}, 4, 5, 'undeclared_nanonis_standard'],
] as const

describe('MotorMove · Z 标签按档案换算（判定表 A–C）', () => {
  for (const [label, profile, retract, approach, basis] of TABLE) {
    for (const [direction, code] of [
      ['z-retract', retract],
      ['z-approach', approach],
    ] as const) {
      it(`${label}：${direction} ⇒ 方向码 ${code}`, async () => {
        install(profile)
        const { ctx, calls } = rig()
        const res = await MotorMove.execute(ctx, { direction, steps: 20 })
        expect(calls).toEqual([{ method: 'Motor_StartMove', args: [code, 20, 0, 1] }])
        expect(res.success).toBe(true)
        const undeclared = basis === 'undeclared_nanonis_standard'
        expect(res.data).toEqual({
          direction,
          steps: 20,
          direction_code: code,
          z_direction_basis: basis,
          ...(undeclared ? { warning: RETRACT_DIR_UNDECLARED_WARNING } : {}),
        })
        expect(res.summary).toBe(
          undeclared
            ? `MotorMove ${direction} 20 步（方向码 ${code}）。⚠ ${RETRACT_DIR_UNDECLARED_WARNING}`
            : undefined,
        )
      })
    }
  }
})

describe('MotorMove · 读不到档案（判定表 D）：一个 Z 动词也不发', () => {
  const unreadable = [
    ['宿主没接读口', 'no-source'],
    ['整个读口抛出', 'source-throws'],
    ['只有退针方向读不出', 'retract-dir-throws'],
  ] as const
  for (const [label, p] of unreadable) {
    for (const direction of ['z-retract', 'z-approach'] as const) {
      it(`${label}：${direction} ⇒ 失败，0 次下发`, async () => {
        install(p)
        const { ctx, calls } = rig()
        const res = await MotorMove.execute(ctx, { direction, steps: 20 })
        expect(res).toEqual({ success: false, error: Z_DIR_UNREADABLE })
        expect(calls).toEqual([])
      })
    }
  }

  // 横向不读方向档案，照走。「整个读口抛出」这里不断言：横向走不走，取决于粗动组号怎么读，
  // 不在这张表里。
  for (const [label, p] of [
    ['宿主没接读口', 'no-source'],
    ['只有退针方向读不出', 'retract-dir-throws'],
  ] as const) {
    it(`${label}：x+ 照走，结果里没有 Z 字段`, async () => {
      install(p)
      const { ctx, calls } = rig()
      const res = await MotorMove.execute(ctx, { direction: 'x+', steps: 20 })
      expect(calls).toEqual([{ method: 'Motor_StartMove', args: [0, 20, 0, 1] }])
      expect(res).toEqual({ success: true, data: { direction: 'x+', steps: 20 } })
    })
  }

  it('不认识的方向仍列出全部 6 个名字；原型链上的名字也不认', async () => {
    install('no-source')
    for (const direction of ['z+', 'toString']) {
      const { ctx, calls } = rig()
      const res = await MotorMove.execute(ctx, { direction, steps: 20 })
      expect(res).toEqual({
        success: false,
        error: `unknown motor direction '${direction}'; expected one of ["x+","x-","y+","y-","z-approach","z-retract"]`,
      })
      expect(calls).toEqual([])
    }
  })
})

/**
 * 端到端：真内核跑 `RecoverTipFromSaturation`，它经 `ctx.runSkill` 调 MotorMove。
 * 电流一直贴着量程端点，阶梯走满预算（60 步 ⇒ 20、30 两级）。
 */
describe('端到端：RecoverTipFromSaturation 经真内核调 MotorMove', () => {
  function kernelRig(): { kernel: SkillKernel; starts: () => unknown[][] } {
    const calls: { method: string; args: readonly unknown[] }[] = []
    const kernel = new SkillKernel({
      // MotorMove 的前置是 `z_controller_off`
      snapshot: () => ({ ...emptyHardwareState('T0'), z_controller_on: false }),
      skillByName: (name) => IMPLEMENTED[name],
      sleep: () => Promise.resolve(),
      safeCall: (method, ...args): Promise<SkillCallRecord> => {
        calls.push({ method, args })
        if (method === 'Current_Get') return Promise.resolve({ method, args, values: [1.00036e-8] })
        return Promise.resolve({ method, args, values: [] })
      },
    })
    const starts = (): unknown[][] =>
      calls.filter((c) => c.method === 'Motor_StartMove').map((c) => [...c.args])
    return { kernel, starts }
  }

  const coarseSteps = (data: Readonly<Record<string, unknown>> | undefined): Record<string, unknown>[] =>
    ((data?.['steps'] ?? []) as Record<string, unknown>[]).filter((s) => s['stage'] === 'coarse_z')

  it('声明 z− ⇒ 每一次粗动都发 5，步记录与失败文案也都按 Z−', async () => {
    install({ retract_motor_dir: 'z-' })
    const { kernel, starts } = kernelRig()
    const res = await kernel.run(IMPLEMENTED['RecoverTipFromSaturation']!, { max_coarse_steps: 60 })
    expect(res.kind).toBe('failed')
    expect(starts()).toEqual([
      [5, 20, 0, 1],
      [5, 30, 0, 1],
    ])
    const coarse = coarseSteps(res.data)
    expect(coarse.map((s) => [s['direction_code'], s['z_direction_basis']])).toEqual([
      [5, 'declared_z-'],
      [5, 'declared_z-'],
    ])
    expect(res.text).toContain('这几步按 本机声明的 Z−（方向码 5） 走')
  })

  it('没声明 ⇒ 按 Nanonis 标准发 4，依据写明没声明', async () => {
    install({})
    const { kernel, starts } = kernelRig()
    const res = await kernel.run(IMPLEMENTED['RecoverTipFromSaturation']!, { max_coarse_steps: 60 })
    expect(starts()).toEqual([
      [4, 20, 0, 1],
      [4, 30, 0, 1],
    ])
    expect(coarseSteps(res.data).map((s) => s['z_direction_basis'])).toEqual([
      'undeclared_nanonis_standard',
      'undeclared_nanonis_standard',
    ])
    expect(res.text).toContain('这几步按 Nanonis 标准 Z+（本机没声明退针方向） 走')
  })

  it('宿主没接档案 ⇒ **一次粗动都不发**，一步都不算，文案说 MotorMove 没报方向', async () => {
    install('no-source')
    const { kernel, starts } = kernelRig()
    const res = await kernel.run(IMPLEMENTED['RecoverTipFromSaturation']!, { max_coarse_steps: 60 })
    expect(res.kind).toBe('failed')
    expect(starts()).toEqual([])
    expect(res.data?.['coarse_steps_used']).toBe(0)
    // 失败的级不算步数，所以梯子一直走到预算放不下为止（20、30、50），每一级都被 MotorMove 拒掉
    const coarse = coarseSteps(res.data)
    expect(coarse.map((s) => s['steps'])).toEqual([20, 30, 50])
    for (const s of coarse) {
      expect(s['ok']).toBe(false)
      expect(String(s['error'])).toContain(Z_DIR_UNREADABLE)
      expect(s['z_direction_basis']).toBeNull()
    }
    expect(res.text).toContain('这几步按 MotorMove 没报方向 走')
  })
})
