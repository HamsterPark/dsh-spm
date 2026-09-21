import { describe, expect, it } from 'vitest'
import { emptyHardwareState, SkillKernel, type HardwareState, type SkillCallRecord } from 'dsh-spm-kernel'
import {
  NATIVE_SKILLS,
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

function fixture(script: Record<string, Reply[]> = {}, state: Partial<HardwareState> = {}) {
  const replies = new Map(Object.entries(script).map(([method, queue]) => [method, [...queue]]))
  const calls: { method: string; args: readonly unknown[] }[] = []
  const patches: Readonly<Record<string, unknown>>[] = []
  const sleeps: number[] = []
  const kernel = new SkillKernel({
    snapshot: () => ({ ...emptyHardwareState('T0'), z_controller_on: true, ...state }),
    applyPatch: (patch) => { patches.push(patch) },
    sleep: async (ms) => { sleeps.push(ms) },
    safeCall: async (method, ...args): Promise<SkillCallRecord> => {
      calls.push({ method, args })
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
    },
  })
  return { kernel, calls, patches, sleeps }
}

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
    const { kernel, calls } = fixture({ Bias_Get: [[Math.fround(0.1)]] })
    const result = await kernel.run(NativeSetBias, { bias_v: '100m' })
    expect(result.kind).toBe('ok')
    expect(calls).toEqual([{ method: 'Bias_Set', args: [0.1] }, { method: 'Bias_Get', args: [] }])
    expect(result.data).toMatchObject({ requested_bias_v: 0.1, bias_v: Math.fround(0.1), verified: true })
  })

  it('fails a materially different voltage and does not patch requested voltage into cached state', async () => {
    const { kernel, patches } = fixture({ Bias_Get: [[0.1001]] })
    const result = await kernel.run(NativeSetBias, { bias_v: 0.1 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_mismatch')
    expect(result.data).toMatchObject({ requested_bias_v: 0.1, bias_v: 0.1001, verified: false })
    expect(patches).toEqual([])
  })

  it('reports uncertainty after a successful write followed by a read failure', async () => {
    const { kernel, calls } = fixture({ Bias_Get: ['connection_closed'] })
    const result = await kernel.run(NativeSetBias, { bias_v: 0.2 })
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('bias_readback_failed')
    expect(result.text).toContain('connection_closed')
    expect(result.data).toMatchObject({ bias_v: null, command_sent: true, verified: false })
    expect(calls.filter((call) => call.method === 'Bias_Set')).toHaveLength(1)
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
    const { kernel, calls } = fixture({ Bias_Set: ['write_rejected'], Scan_Action: ['write_rejected'], Scan_StatusGet: [[0]] })
    const result = await kernel.run(skill, skill === NativeSetBias ? { bias_v: 1 } : {})
    expect(result.kind).toBe('failed')
    expect(result.text).toContain('write_rejected')
    expect(calls.filter((call) => call.method === 'Bias_Set' || call.method === 'Scan_Action')).toHaveLength(1)
  })
})
