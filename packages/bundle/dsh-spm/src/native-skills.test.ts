import { describe, expect, it } from 'vitest'
import { emptyHardwareState, SkillKernel, type HardwareState, type KernelRecord, type SkillCallRecord } from 'dsh-spm-kernel'
import { SetBias } from 'dsh-spm-stm-skills'
import {
  NATIVE_SKILLS,
  NATIVE_SUBSKILLS,
  NativeGetScanStatus,
  NativeSetBias,
  NativeStartScan,
  NativeStopScan,
  formatNativeToolText,
} from './native-skills.js'

type Reply = readonly unknown[] | string

function props(continuous = 0): unknown[] {
  return [continuous, 1, 2, 8, 'sample-A', 4, 'note', 8, 1, ['Bias'], 1, [1], 0, 0, [], 2]
}

interface FixtureOptions {
  /**
   * 状态缓存是活的：snapshot 读它，applyPatch 只收 bias_v，refreshState 重读一次 Bias_Get 写回它
   * （与 minimal.ts 里的接法同形）。缺省时快照是常量，也没有 refreshState。
   */
  readonly live?: boolean
  /** 第 count 次 method 返回之后取消这次调用；此后的线上调用像生产里那样直接回取消错误，不记入 calls。 */
  readonly cancelAfter?: { readonly method: string; readonly count: number }
}

function fixture(script: Record<string, Reply[]> = {}, state: Partial<HardwareState> = {}, options: FixtureOptions = {}) {
  const replies = new Map(Object.entries(script).map(([method, queue]) => [method, [...queue]]))
  const calls: { method: string; args: readonly unknown[] }[] = []
  const patches: Readonly<Record<string, unknown>>[] = []
  const sleeps: number[] = []
  const records: KernelRecord[] = []
  const controller = new AbortController()
  const seen = new Map<string, number>()
  let refreshes = 0
  let cache: HardwareState = { ...emptyHardwareState('T0'), z_controller_on: true, ...state }
  const scripted = (method: string, args: readonly unknown[]): SkillCallRecord => {
    const queue = replies.get(method)
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0]
    if (typeof reply === 'string') return { method, args, error: reply }
    if (reply !== undefined) return { method, args, values: reply }
    if (method === 'ZCtrl_OnOffGet') return { method, args, values: [1] }
    if (method === 'Scan_PropsGet') return { method, args, values: props() }
    if (method === 'Bias_Set' || method === 'Scan_Action' || method === 'Scan_PropsSet') {
      return { method, args, values: [] }
    }
    return { method, args, error: `unscripted: ${method}` }
  }
  const kernel = new SkillKernel({
    snapshot: () => options.live === true ? cache : { ...emptyHardwareState('T0'), z_controller_on: true, ...state },
    applyPatch: (patch) => {
      patches.push(patch)
      if (options.live === true && typeof patch['bias_v'] === 'number') cache = { ...cache, bias_v: patch['bias_v'] }
    },
    ...(options.live === true ? {
      refreshState: async () => {
        refreshes += 1
        const rec = scripted('Bias_Get', [])
        const value = rec.error === undefined ? rec.values?.[0] : undefined
        if (typeof value === 'number') cache = { ...cache, bias_v: value }
        return cache
      },
    } : {}),
    sleep: async (ms) => { sleeps.push(ms) },
    skillByName: (name) => NATIVE_SUBSKILLS.get(name),
    record: (rec) => { records.push(rec) },
    safeCall: async (method, ...args): Promise<SkillCallRecord> => {
      if (controller.signal.aborted) {
        return { method, args, error: 'native_simulator_aborted: 本次调用已取消，未发送仪器命令。' }
      }
      calls.push({ method, args })
      const rec = scripted(method, args)
      const count = (seen.get(method) ?? 0) + 1
      seen.set(method, count)
      if (options.cancelAfter?.method === method && options.cancelAfter.count === count) controller.abort()
      return rec
    },
  })
  return {
    kernel, calls, patches, sleeps, records, signal: controller.signal,
    cache: () => cache, refreshCount: () => refreshes,
  }
}

const methodsOf = (calls: readonly { method: string }[]): string[] => calls.map((call) => call.method)
const biasSets = (calls: readonly { method: string; args: readonly unknown[] }[]): number[] =>
  calls.filter((call) => call.method === 'Bias_Set').map((call) => call.args[0] as number)

describe('native simulator minimal skills', () => {
  it('exposes exactly the seven named tools and omits unsupported override/ramp parameters', () => {
    expect(NATIVE_SKILLS.map((skill) => skill.spec.name)).toEqual([
      'GetBias', 'GetCurrent', 'GetZPosition', 'GetScanStatus', 'SetBias', 'StartScan', 'StopScan',
    ])
    expect(NativeSetBias.spec.parameters.map((p) => p.name)).toEqual(['bias_v'])
    expect(NativeStartScan.spec.parameters.map((p) => p.name)).toEqual(['direction'])
    expect(NativeStartScan.spec.preconditions).toEqual(['z_controller_on'])
  })

  it.each([
    ['GetBias', 'Bias_Get', 0.375, 'bias_v', 'V'],
    ['GetCurrent', 'Current_Get', 2e-12, 'current_a', 'A'],
    ['GetZPosition', 'ZCtrl_ZPosGet', -3e-9, 'z_pos_m', 'm'],
  ] as const)('keeps %s measurements and units visible to the model', async (skillName, method, value, key, unit) => {
    const { kernel } = fixture({ [method]: [[value]] })
    const skill = NATIVE_SKILLS.find((s) => s.spec.name === skillName)!
    const result = await kernel.run(skill, {})
    expect(result.kind).toBe('ok')
    expect(result.data?.[key]).toBe(value)
    expect(formatNativeToolText({ skill: skillName, kind: result.kind, data: result.data! }, result.text))
      .toBe(`${skillName}: ${value} ${unit}`)
  })

  it.each([0, 1])('reads scan status %s from the instrument', async (status) => {
    const { kernel } = fixture({ Scan_StatusGet: [[status]] })
    const result = await kernel.run(NativeGetScanStatus, {})
    expect(result.kind).toBe('ok')
    expect(result.data).toEqual({ scan_running: status === 1, scan_status: status })
  })

  it.each([2, null, '1', Number.NaN])('does not treat invalid scan status %s as stopped', async (status) => {
    const { kernel } = fixture({ Scan_StatusGet: [[status]] })
    const result = await kernel.run(NativeGetScanStatus, {})
    expect(result.kind).toBe('failed')
    expect(result.data?.['scan_running']).toBeNull()
  })

  it('accepts SI voltage input and float32 rounding while returning the observed voltage', async () => {
    // 第一次 Bias_Get 是分流用的起点，第二次起是回读
    const { kernel, calls, sleeps } = fixture({ Bias_Get: [[0.08], [Math.fround(0.1)]] })
    const result = await kernel.run(NativeSetBias, { bias_v: '100m' })
    expect(result.kind).toBe('ok')
    expect(calls).toEqual([
      { method: 'Bias_Get', args: [] }, { method: 'Bias_Set', args: [0.1] }, { method: 'Bias_Get', args: [] },
    ])
    expect(result.data).toMatchObject({
      requested_bias_v: 0.1, bias_v: Math.fround(0.1), verified: true, command_sent: true,
      path: 'SetBias', bias_v_start: 0.08,
    })
    expect(sleeps).toEqual([]) // 直走路径不等稳定时间
  })

  it('fails a materially different voltage, never patches the request into the cache, and refreshes to the observed one', async () => {
    const { kernel, records, patches, cache, refreshCount } = fixture({ Bias_Get: [[0.1001]] }, {}, { live: true })
    const result = await kernel.run(NativeSetBias, { bias_v: 0.1 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_mismatch')
    expect(result.data).toMatchObject({ requested_bias_v: 0.1, bias_v: 0.1001, verified: false })
    expect(patches).toEqual([]) // 直写路径没有子步，请求值从来没进过缓存
    // 回读不符就刷新，走哪条路径都一样：缓存和记录的 stateDelta 拿到实际值
    expect(refreshCount()).toBe(1)
    expect(cache().bias_v).toBe(0.1001)
    expect(records.at(-1)?.outcome.stateDelta).toEqual({ bias_v: 0.1001 })
  })

  it('reports uncertainty after a successful write followed by a read failure', async () => {
    // 起点读得到（0.1 → 0.2 走直写），写成功之后的回读失败：缓存不可信，不刷新
    const { kernel, calls, cache, refreshCount } = fixture({ Bias_Get: [[0.1], 'connection_closed'] }, {}, { live: true })
    const result = await kernel.run(NativeSetBias, { bias_v: 0.2 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_failed')
    expect(result.text).toContain('connection_closed')
    expect(result.data).toMatchObject({ bias_v: null, command_sent: true, verified: false, path: 'SetBias' })
    expect(calls.filter((call) => call.method === 'Bias_Set')).toHaveLength(1)
    expect(refreshCount()).toBe(0)
    expect(cache().bias_v).toBeNull()
  })

  it.each([
    {}, { bias_v: 11 }, { bias_v: -11 }, { bias_v: Number.NaN }, { bias_v: Number.POSITIVE_INFINITY },
    { bias_v: true }, { bias_v: 1, slew_rate_v_per_s: 1 },
  ])('does not write for invalid/unsupported bias parameters %j', async (params) => {
    const { kernel, calls } = fixture()
    expect((await kernel.run(NativeSetBias, params)).kind).toBe('refused')
    expect(calls).toEqual([])
  })

  it.each([{ direction: 'sideways' }, { allow_continuous_scan: true }, { arbitrary_wire_call: 'Motor_Start' }])(
    'does not read or write for invalid/unsupported scan parameters %j', async (params) => {
      const { kernel, calls } = fixture()
      expect((await kernel.run(NativeStartScan, params)).kind).toBe('refused')
      expect(calls).toEqual([])
    },
  )

  it.each([0, 2, null])('refuses live feedback status %s even when the cached module says on', async (status) => {
    const { kernel, calls } = fixture({ ZCtrl_OnOffGet: [[status]] })
    const result = await kernel.run(NativeStartScan, {})
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('feedback_not_on')
    expect(calls.map((call) => call.method)).toEqual(['ZCtrl_OnOffGet'])
  })

  it('retains the kernel feedback precondition before any instrument call', async () => {
    const { kernel, calls } = fixture({}, { z_controller_on: false })
    const result = await kernel.run(NativeStartScan, {})
    expect(result.kind).toBe('refused')
    expect(result.code).toBe('precondition_failed')
    expect(calls).toEqual([])
  })

  it('does not restart an already running scan', async () => {
    const { kernel, calls } = fixture({ Scan_StatusGet: [[1]] })
    const result = await kernel.run(NativeStartScan, {})
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('scan_already_running')
    expect(calls.some((call) => call.method === 'Scan_Action' || call.method === 'Scan_PropsSet')).toBe(false)
  })

  it('starts upward without touching any saving property when continuous is already off', async () => {
    const { kernel, calls } = fixture({ Scan_StatusGet: [[0], [1]] })
    const result = await kernel.run(NativeStartScan, { direction: 'up' })
    expect(result.kind).toBe('ok')
    expect(result.data).toMatchObject({ scan_running: true, verified: true, scan_direction: 'up', scan_props_written: false })
    expect(calls.find((call) => call.method === 'Scan_Action')?.args).toEqual([0, 1])
    expect(calls.some((call) => call.method === 'Scan_PropsSet')).toBe(false)
  })

  it('only changes continuous and verifies all preserved saving properties before starting', async () => {
    const { kernel, calls } = fixture({ Scan_PropsGet: [props(1), props(0)], Scan_StatusGet: [[0], [1]] })
    const result = await kernel.run(NativeStartScan, {})
    expect(result.kind).toBe('ok')
    expect(calls.find((call) => call.method === 'Scan_PropsSet')?.args)
      .toEqual([2, 0, 0, 'sample-A', 'note', ['Bias'], 0])
    expect(result.data).toMatchObject({ continuous_scan_before: 1, continuous_scan_after: 0, scan_props_written: true })
    expect(calls.filter((call) => call.method === 'Scan_Action')).toEqual([{ method: 'Scan_Action', args: [0, 0] }])
  })

  it.each([
    ['continuous remains on', props(1)],
    ['autosave changed', props(0).map((value, index) => index === 2 ? 1 : value)],
    ['comment changed', props(0).map((value, index) => index === 6 ? '' : value)],
    ['module flags changed', props(0).map((value, index) => index === 11 ? [0] : value)],
    ['read failed', 'connection_closed'],
  ] as const)('does not start when props readback shows %s', async (_label, after) => {
    const { kernel, calls } = fixture({ Scan_PropsGet: [props(1), after], Scan_StatusGet: [[0]] })
    const result = await kernel.run(NativeStartScan, {})
    expect(result.kind).toBe('failed')
    expect(calls.some((call) => call.method === 'Scan_Action')).toBe(false)
  })

  it.each([[2], [1], props(1).map((value, index) => index === 8 ? 2 : value)])(
    'does not write props or start if the continuous/property reply is unusable: %j', async (...body) => {
      const { kernel, calls } = fixture({ Scan_PropsGet: [body], Scan_StatusGet: [[0]] })
      expect((await kernel.run(NativeStartScan, {})).kind).toBe('failed')
      expect(calls.some((call) => call.method === 'Scan_Action' || call.method === 'Scan_PropsSet')).toBe(false)
    },
  )

  it('fails when start is acknowledged but scan never becomes running', async () => {
    const { kernel, calls, sleeps, patches } = fixture({ Scan_StatusGet: [[0]] })
    const result = await kernel.run(NativeStartScan, {})
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('scan_readback_mismatch')
    expect(result.data).toMatchObject({ scan_running: false, verified: false, command_sent: true })
    expect(calls.filter((call) => call.method === 'Scan_Action')).toHaveLength(1)
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBe(1_000)
    expect(patches).toEqual([])
  })

  it('waits for a delayed stop without repeating the stop write', async () => {
    const { kernel, calls, sleeps } = fixture({ Scan_StatusGet: [[1], [0]] })
    const result = await kernel.run(NativeStopScan, {})
    expect(result.kind).toBe('ok')
    expect(result.data).toMatchObject({ scan_running: false, verified: true })
    expect(calls.filter((call) => call.method === 'Scan_Action')).toEqual([{ method: 'Scan_Action', args: [1, 0] }])
    expect(sleeps).toEqual([100])
  })

  it('fails stop when the actual scan keeps running', async () => {
    const { kernel } = fixture({ Scan_StatusGet: [[1]] })
    const result = await kernel.run(NativeStopScan, {})
    expect(result.kind).toBe('failed')
    expect(result.data).toMatchObject({ scan_running: true, verified: false })
  })

  it('does not turn failed stop readback into a stopped claim', async () => {
    const { kernel } = fixture({ Scan_StatusGet: ['connection_closed'] })
    const result = await kernel.run(NativeStopScan, {})
    expect(result.kind).toBe('failed')
    expect(result.data).toMatchObject({ scan_running: null, verified: false, command_sent: true })
    expect(formatNativeToolText({ skill: 'StopScan', kind: result.kind, data: result.data! }, result.text)).toBe(result.text)
  })

  it.each([NativeSetBias, NativeStartScan, NativeStopScan])('propagates a rejected write without retry: $spec.name', async (skill) => {
    // Bias_Get：起点 1 V → 目标 1 V 走直写；没有它，读不到起点会改走 BiasSettleChange、一次 Bias_Set 都不发
    const { kernel, calls } = fixture({
      Bias_Get: [[1]], Bias_Set: ['write_rejected'], Scan_Action: ['write_rejected'], Scan_StatusGet: [[0]],
    })
    const result = await kernel.run(skill, skill === NativeSetBias ? { bias_v: 1 } : {})
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('write_rejected')
    expect(calls.filter((call) => call.method === 'Bias_Set' || call.method === 'Scan_Action')).toHaveLength(1)
  })
})

// 模型面的 SetBias 先读起点再分流：变号、变化超过 0.5 V、目标落进 ±50 mV 死区、起点读不到，
// 都走 BiasSettleChange（子技能经内核 runSkill，带参数校验、安全闸、记录）；其余直写。
// 判据本身的真值表在 kernel/bias-settle.test.ts；这里验证接线：每一类确实走到了该走的路，
// 事前拒绝时一次 Bias_Set 都没发，中途失败时 command_sent 为真并带回读。
describe('native SetBias routing', () => {
  // Bias_Get 的顺序：顶层读起点 → BiasSettleChange 读起点 → 顶层回读（最后一个值之后重复）
  it('walks a sign change through BiasSettleChange, settles, then reads back once', async () => {
    const { kernel, calls, sleeps, records, refreshCount } = fixture({ Bias_Get: [[1], [1], [-1]] }, {}, { live: true })
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('ok')
    expect(refreshCount()).toBe(0) // 回读相符，缓存里本来就是实际值
    expect(result.data).toMatchObject({
      path: 'BiasSettleChange', strategy: 'ramp_through_zero', crossed_zero: true, bias_v_start: 1, settle_s: 2,
      requested_bias_v: -1, bias_v: -1, verified: true, command_sent: true,
    })
    const methods = methodsOf(calls)
    expect(methods.slice(0, 3)).toEqual(['Bias_Get', 'Bias_Get', 'ZCtrl_OnOffGet'])
    expect(methods.at(-1)).toBe('Bias_Get')
    expect(new Set(methods.slice(3, -1))).toEqual(new Set(['Bias_Set']))
    const sets = biasSets(calls)
    expect(sets.length).toBeGreaterThan(1) // 没有一步跳到 -1
    expect(sets[0]).not.toBe(-1)
    expect(sets.at(-1)).toBe(-1)
    expect(sleeps.at(-1)).toBe(2000) // 稳定等待在斜坡走完之后
    expect(records.map((rec) => [rec.spec.name, rec.depth])).toEqual([['SetBiasRamp', 2], ['BiasSettleChange', 1], ['SetBias', 0]])
  })

  it('ramps a large change that does not cross zero', async () => {
    const { kernel, calls } = fixture({ Bias_Get: [[1], [1], [1.6]] })
    const result = await kernel.run(NativeSetBias, { bias_v: 1.6 })
    expect(result.kind).toBe('ok')
    expect(result.data).toMatchObject({ path: 'BiasSettleChange', strategy: 'ramp', crossed_zero: false, bias_v_start: 1, verified: true })
    expect(biasSets(calls).length).toBeGreaterThan(1)
  })

  it('keeps a change of exactly 0.5 V on the direct path', async () => {
    const { kernel, calls } = fixture({ Bias_Get: [[1], [1.5]] })
    const result = await kernel.run(NativeSetBias, { bias_v: 1.5 })
    expect(result.kind).toBe('ok')
    expect(result.data).toMatchObject({ path: 'SetBias', bias_v_start: 1, verified: true })
    expect(methodsOf(calls)).toEqual(['Bias_Get', 'Bias_Set', 'Bias_Get'])
  })

  it.each([
    ['feedback is on', [1], '开着'],
    ['the feedback state cannot be read', 'connection_closed', '状态未知'],
  ] as const)('refuses a dead-band target when %s, before any Bias_Set', async (_label, feedback, wording) => {
    const { kernel, calls } = fixture({ Bias_Get: [[0.3]], ZCtrl_OnOffGet: [feedback] })
    const result = await kernel.run(NativeSetBias, { bias_v: 0 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('低偏压死区')
    expect(result.text).toContain(wording)
    expect(biasSets(calls)).toEqual([])
    // 没有任何写，但读了 3 次：顶层起点、BiasSettleChange 的起点、反馈状态（偏差登记与指南都这么说）
    expect(methodsOf(calls)).toEqual(['Bias_Get', 'Bias_Get', 'ZCtrl_OnOffGet'])
    expect(result.data).toMatchObject({
      path: 'BiasSettleChange', command_sent: false, verified: false, bias_v: null, requested_bias_v: 0,
    })
  })

  it('lets a dead-band target through once feedback is confirmed off', async () => {
    const { kernel, calls, sleeps } = fixture({ Bias_Get: [[0.3], [0.3], [0]], ZCtrl_OnOffGet: [[0]] })
    const result = await kernel.run(NativeSetBias, { bias_v: 0 })
    expect(result.kind).toBe('ok')
    expect(result.data).toMatchObject({ path: 'BiasSettleChange', strategy: 'direct', crossed_zero: false, settle_s: 0.5, verified: true })
    expect(biasSets(calls)).toEqual([0])
    expect(sleeps).toEqual([500])
  })

  it('writes nothing when the start voltage cannot be read', async () => {
    const { kernel, calls } = fixture({ Bias_Get: ['connection_closed'] })
    const result = await kernel.run(NativeSetBias, { bias_v: 0.3 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('读不到当前偏压')
    expect(methodsOf(calls)).toEqual(['Bias_Get', 'Bias_Get']) // 顶层一次、BiasSettleChange 一次，没有任何写
    expect(result.data).toMatchObject({ path: 'BiasSettleChange', command_sent: false, verified: false, bias_v: null })
  })

  it('reports a ramp that fails half way as sent, with the voltage actually read back', async () => {
    const { kernel, calls } = fixture({ Bias_Get: [[1], [1], [0.6]], Bias_Set: [[], [], 'write_rejected'] })
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('write_rejected')
    expect(result.data).toMatchObject({
      path: 'BiasSettleChange', strategy: 'ramp_through_zero', command_sent: true, verified: false,
      bias_v: 0.6, requested_bias_v: -1,
    })
    expect(biasSets(calls)).toHaveLength(3) // 失败的那一步不重试
    // 子技能的失败数据里 bias_v 是它的目标值，而偏压其实停在半路：文本里留两层前缀的一行说明，
    // 数据只有顶层那一行（含实际的 0.6），不出现子技能的数据行
    expect(result.text).toContain('[BiasSettleChange] failed')
    expect(result.text).toContain('[SetBiasRamp] failed')
    expect(result.text).not.toContain('slew_rate_v_per_s')
    const lines = result.text.split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toMatchObject({ bias_v: 0.6, command_sent: true, strategy: 'ramp_through_zero' })
  })

  it('keeps a multi-line instrument error description whole and still drops the sub-skill data lines', async () => {
    // Nanonis 的错误描述可以有多行：截在第一个换行处会把后面的丢掉，要截的只是 `\n{...}` 数据行
    const description = 'Nanonis error 7: bias out of range\nCheck the limits and try again'
    const { kernel } = fixture({ Bias_Get: [[1], [1], [0.6]], Bias_Set: [[], [], description] })
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain(description)
    expect(result.text).toContain('[SetBiasRamp] failed')
    expect(result.text).not.toContain('slew_rate_v_per_s')
    const lines = result.text.split('\n')
    expect(lines).toHaveLength(3) // 说明的两行 + 顶层那一行数据
    expect(JSON.parse(lines[2]!)).toMatchObject({ bias_v: 0.6, command_sent: true })
  })

  it('does not claim a voltage when the readback after a failed ramp also fails', async () => {
    const { kernel, refreshCount } = fixture(
      { Bias_Get: [[1], [1], 'connection_closed'], Bias_Set: [[], 'write_rejected'] }, {}, { live: true },
    )
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('failed')
    expect(result.data).toMatchObject({ path: 'BiasSettleChange', command_sent: true, verified: false, bias_v: null })
    expect(refreshCount()).toBe(0) // 读不到实际值，说明链路多半有问题，不再发读
  })

  it('refreshes the cache after a half-way ramp failure once the actual voltage could be read', async () => {
    // 斜坡失败时没有子步成功，缓存还是改动前的值；偏压其实已经停在 0.6 V
    const { kernel, records, cache, refreshCount } = fixture(
      { Bias_Get: [[1], [1], [0.6]], Bias_Set: [[], [], 'write_rejected'] }, { bias_v: 1 }, { live: true },
    )
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('failed')
    expect(refreshCount()).toBe(1)
    expect(cache().bias_v).toBe(0.6)
    expect(records.at(-1)?.outcome.stateDelta).toEqual({ bias_v: 0.6 })
  })

  it('fails a routed change whose final readback differs, and says what it read', async () => {
    const { kernel } = fixture({ Bias_Get: [[1], [1], [-0.9]] })
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_mismatch')
    expect(result.data).toMatchObject({ path: 'BiasSettleChange', requested_bias_v: -1, bias_v: -0.9, verified: false, command_sent: true })
  })

  // 子步成功时内核已把请求值补进缓存（K12）。回读不符说明它不是实际值：不刷新的话，缓存会一直留着它，
  // 而 stateDelta（写进 SQLite 记录）也是用这份缓存算的。
  it('refreshes the cache after a routed readback mismatch, so the cache and the recorded delta carry the actual voltage', async () => {
    const { kernel, records, cache, refreshCount } = fixture({ Bias_Get: [[1], [1], [-0.9]] }, { bias_v: 1 }, { live: true })
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_mismatch')
    expect(refreshCount()).toBe(1)
    expect(cache().bias_v).toBe(-0.9)
    expect(records.at(-1)?.outcome.stateDelta).toEqual({ bias_v: -0.9 })
  })

  // 已知限制（偏差登记里有一条）：回读本身失败时不刷新（链路多半有问题），缓存和 stateDelta 留着请求值。
  it('known limitation: when the readback itself fails, the cache and the recorded delta keep the requested voltage', async () => {
    const { kernel, records, cache, refreshCount } = fixture(
      { Bias_Get: [[1], [1], 'connection_closed'] }, { bias_v: 1 }, { live: true },
    )
    const result = await kernel.run(NativeSetBias, { bias_v: -1 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_failed')
    expect(refreshCount()).toBe(0)
    expect(cache().bias_v).toBe(-1)
    expect(records.at(-1)?.outcome.stateDelta).toEqual({ bias_v: -1 })
  })

  it('after a cancel mid-ramp: the ramp stops where it is, nothing more is sent, no readback and no refresh', async () => {
    const { kernel, calls, records, signal, cache, refreshCount } = fixture(
      { Bias_Get: [[1], [1], [0.6]] }, { bias_v: 1 }, { live: true, cancelAfter: { method: 'Bias_Set', count: 2 } },
    )
    const result = await kernel.run(NativeSetBias, { bias_v: -1 }, { signal })
    expect(result.kind).toBe('failed')
    expect(result.data).toMatchObject({
      path: 'BiasSettleChange', strategy: 'ramp_through_zero', command_sent: true, verified: false,
      bias_v: null, requested_bias_v: -1,
    })
    expect(biasSets(calls)).toEqual([0.8, 0.6])
    expect(methodsOf(calls).at(-1)).toBe('Bias_Set') // 取消之后既没有回读，也没有别的命令
    expect(refreshCount()).toBe(0)
    // 残留（偏差登记里有一条）：停在半路，缓存却还是改动前的值，记录上看不出偏压动过
    expect(cache().bias_v).toBe(1)
    expect(records.at(-1)?.outcome.stateDelta).toEqual({})
  })

  it('does not refresh after a cancel that lands right after a mismatching readback', async () => {
    // 第 3 次 Bias_Get 是顶层回读：它返回之后调用被取消，随后的刷新读也不该发
    const { kernel, signal, cache, refreshCount } = fixture(
      { Bias_Get: [[1], [1], [-0.9]] }, { bias_v: 1 }, { live: true, cancelAfter: { method: 'Bias_Get', count: 3 } },
    )
    const result = await kernel.run(NativeSetBias, { bias_v: -1 }, { signal })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_mismatch')
    expect(refreshCount()).toBe(0)
    expect(cache().bias_v).toBe(-1) // 残留：斜坡已走完的，缓存里是请求值
  })
})

describe('native sub-skill registry', () => {
  it('holds exactly the three skills the routing runs, and SetBias is the reference one', () => {
    expect([...NATIVE_SUBSKILLS.keys()].sort()).toEqual(['BiasSettleChange', 'SetBias', 'SetBiasRamp'])
    expect(NATIVE_SUBSKILLS.get('SetBias')).toBe(SetBias)
    expect(NATIVE_SUBSKILLS.get('SetBias')).not.toBe(NativeSetBias) // 否则 BiasSettleChange 的直写子步会再进 NativeSetBias，无限递归
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'StartScan', 'GetBias', 'Motor_Start'])(
    'does not resolve %s as a sub-skill', (name) => {
      expect(NATIVE_SUBSKILLS.get(name)).toBeUndefined()
    },
  )

  it('leaves the model-visible catalog at seven tools', () => {
    expect(NATIVE_SKILLS).toHaveLength(7)
    expect(NATIVE_SKILLS.some((skill) => skill.spec.name === 'BiasSettleChange' || skill.spec.name === 'SetBiasRamp')).toBe(false)
  })
})

describe('native SetBias model-facing text', () => {
  it('names the route only when the safe path was taken', () => {
    const direct = { skill: 'SetBias', kind: 'ok', data: { bias_v: 0.1, path: 'SetBias' } } as const
    const routed = { skill: 'SetBias', kind: 'ok', data: { bias_v: -1, path: 'BiasSettleChange', strategy: 'ramp_through_zero' } } as const
    expect(formatNativeToolText(direct, 'fallback')).toBe('SetBias: 0.1 V (readback verified)')
    expect(formatNativeToolText(routed, 'fallback')).toBe('SetBias: -1 V (readback verified, via BiasSettleChange ramp_through_zero)')
  })

  it('tells the model about the routing and that targets inside the dead band need feedback off', () => {
    const description = NativeSetBias.spec.description
    expect(description).toContain('BiasSettleChange')
    expect(description).toContain('±50 mV')
    expect(description).not.toContain('不提供渐变')
  })
})
