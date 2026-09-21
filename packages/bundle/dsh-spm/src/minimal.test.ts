import { Context } from 'dsh-spm-compat'
import { StmsimProcess } from 'dsh-spm-instrument-stmsim'
import { describe, expect, it, vi } from 'vitest'
import { inject, ManagedSimulatorInstrument, MINIMAL_TOOL_NAMES, minimalProvider, name } from './minimal.js'

describe('minimal runtime 的封闭边界', () => {
  it('模型工具名单只有 GetBias，且基础服务缺失时插件不装载', () => {
    expect(name).toBe('dsh-spm-minimal-runtime')
    expect(MINIMAL_TOOL_NAMES).toEqual(['GetBias'])
    expect(inject).toEqual(['tools', 'systemPrompt', 'commands'])
  })

  it('缺 tools/systemPrompt/commands 的裸 Context 不会启动模拟器', async () => {
    const start = vi.spyOn(StmsimProcess.prototype, 'start')
    const ctx = new Context()
    ctx.plugin(minimalProvider, {})
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(start).not.toHaveBeenCalled()
    start.mockRestore()
  })

  it('受管模拟器停止后，所有仪器角色都在连接前失败', async () => {
    const simulator = {
      ports: [16501, 16502, 16503, 16504],
      running: false,
    } as unknown as StmsimProcess
    const instrument = new ManagedSimulatorInstrument(new Context(), simulator)
    const [main, monitor, emergency] = await Promise.all([
      instrument.call('Bias_Get', []),
      instrument.call('Current_Get', [], { role: 'monitor' }),
      instrument.urgentCall('ZCtrl_Withdraw'),
    ])
    for (const rec of [main, monitor, emergency]) {
      expect(rec.error).toContain('managed_simulator_stopped')
      expect(rec.simulated).toBe(true)
    }
    expect(monitor.role).toBe('monitor')
    expect(emergency.role).toBe('emergency')
  })
})
