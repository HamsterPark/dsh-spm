/**
 * 把真空互锁接成前置检查 —— 以及**默认不接**这件事本身。
 *
 * `preconditions.test.ts` 那一组用的是假的 `ComputedCheck`（证明 dispatch 对）。
 * 这一组用**真的判定机**，从 `SkillKernel` 这一头走进去，证明三件事：
 *
 * 1. 接上之后，`vacuum_ok_for_coarse` 真的会因为读不到压强而拒；
 * 2. 拒绝的理由是互锁自己那句话，一字不改地到模型手上；
 * 3. **不接的时候什么都不发生** —— 这是本仓当下的默认，也是既有金样成立的前提。
 *
 * 第 3 条为什么值得一条测试：接上会改变粗动那几个技能的行为，
 * 而它们的轨迹金样是按「没接」录的。默认改掉会让一堆已有轨迹变红，
 * 而那不是这一批要证明的事 —— 把「默认是关的」钉住，
 * 将来有人顺手打开时会**当场**看见代价，而不是在一片红里猜。
 */
import { describe, expect, it } from 'vitest'
import { emptyHardwareState } from './hardware-state.js'
import { checkStatePreconditions } from './preconditions.js'
import { SkillKernel, type KernelDeps, type Skill, type SkillResultLike } from './skill-kernel.js'
import {
  processVacuum,
  revokeAttestation,
  vacuumCoarseCheck,
  type PressureSample,
} from './vacuum-interlock.js'

const NOW = 1_700_000_000

/** 真机上唯一声明了这条前置的技能是 `RelocateCoarseXY`。这里造一个同形的探针。 */
const coarseProbe: Skill = {
  spec: {
    name: '_CoarseProbe',
    description: '粗动探针',
    parameters: [],
    preconditions: ['vacuum_ok_for_coarse', 'scan_not_running'],
  },
  execute: (): Promise<SkillResultLike> =>
    Promise.resolve({ success: true, summary: '_CoarseProbe: ok' }),
}

const GOOD: PressureSample = {
  value: 1e-3, unit: 'Pa', status: 'ok',
  timestamp: '2023-11-14T22:13:08+00:00',
  sensorName: 'Chamber', sensorClass: 'DL7VacuumSensor',
}

function reset(): void {
  processVacuum.source = null
  processVacuum.config = {}
  processVacuum.nowS = () => NOW
  revokeAttestation()
}

function deps(over: Partial<KernelDeps> = {}): KernelDeps {
  return {
    snapshot: () => ({ ...emptyHardwareState('T0'), scan_running: false }),
    clock: () => 1000,
    ...over,
  }
}

describe('接上之后：读不到压强 ⇒ 拒绝粗动', () => {
  it('没有规 ⇒ 前置不满足，理由是互锁那句话', async () => {
    reset()
    const k = new SkillKernel(deps({
      computedChecks: { vacuum_ok_for_coarse: vacuumCoarseCheck() },
    }))
    const r = await k.run(coarseProbe, {})
    expect(r.kind).toBe('refused')
    expect(r.text).toContain('vacuum_ok_for_coarse')
    // 「没有可用的真空计读数」是互锁自己的措辞，不是内核编的
    expect(r.text).toContain('没有可用的真空计读数')
  })

  it('占位传感器那个 `0.0` ⇒ 照样拒 —— 它不是完美真空，是没有数据', async () => {
    reset()
    processVacuum.source = (): PressureSample => ({
      value: 0.0, unit: 'Pa', status: 'ok',
      timestamp: '2023-11-14T22:13:18+00:00',
      sensorName: 'Vacuum', sensorClass: 'PlaceholderSensor',
    })
    const k = new SkillKernel(deps({
      computedChecks: { vacuum_ok_for_coarse: vacuumCoarseCheck() },
    }))
    const r = await k.run(coarseProbe, {})
    expect(r.kind).toBe('refused')
    expect(r.text).toContain('占位实现')
  })

  it('一只好规 ⇒ 放行（只有拒绝那一侧的测试证明不了闸门没把一切拦掉）', async () => {
    reset()
    processVacuum.source = (): PressureSample => GOOD
    const k = new SkillKernel(deps({
      computedChecks: { vacuum_ok_for_coarse: vacuumCoarseCheck() },
    }))
    const r = await k.run(coarseProbe, {})
    expect(r.kind).toBe('ok')
  })

  it('读数太旧 ⇒ 拒 —— 年龄是判据，抽气途中压强变得很快', async () => {
    reset()
    processVacuum.source = (): PressureSample => GOOD
    processVacuum.nowS = () => NOW + 3600
    const k = new SkillKernel(deps({
      computedChecks: { vacuum_ok_for_coarse: vacuumCoarseCheck() },
    }))
    expect((await k.run(coarseProbe, {})).kind).toBe('refused')
  })

  it('签署能放行一只哑规，过期之后不能', async () => {
    reset()
    processVacuum.source = (): PressureSample => ({ ...GOOD, status: 'unavailable' })
    processVacuum.attestation = {
      reason: 'vented_to_atmosphere', signedBy: '操作员甲',
      signedAtS: NOW - 3600, ttlS: 8 * 3600, note: '',
    }
    const k = new SkillKernel(deps({
      computedChecks: { vacuum_ok_for_coarse: vacuumCoarseCheck() },
    }))
    expect((await k.run(coarseProbe, {})).kind).toBe('ok')

    processVacuum.nowS = () => NOW + 9 * 3600
    const r = await k.run(coarseProbe, {})
    expect(r.kind).toBe('refused')
    expect(r.text).toContain('已在')
    reset()
  })
})

describe('**默认不接** —— 本仓当下的状态，也是既有金样的前提', () => {
  it('`computedChecks` 缺省是空表：同一条前置什么都不做', async () => {
    reset() // 源没接、签署没有 —— 接上的话这一定会拒
    const k = new SkillKernel(deps())
    const r = await k.run(coarseProbe, {})
    expect(r.kind).toBe('ok')
  })

  it('这条前置在没接时落回子串层、认不出、当没这条', () => {
    const st = { ...emptyHardwareState('T0'), scan_running: false }
    expect(checkStatePreconditions(['vacuum_ok_for_coarse'], st)).toEqual([])
    // 同一份状态、同一条前置，接上真判定机就变成拒 —— 差别只在接没接
    expect(
      checkStatePreconditions(['vacuum_ok_for_coarse'], st, {
        vacuum_ok_for_coarse: vacuumCoarseCheck(() => NOW),
      }).length,
    ).toBe(1)
  })
})
