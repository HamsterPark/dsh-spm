import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, SystemPrompt, ToolRuntime } from 'dsh-spm-compat'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeSimulatorConnection, NativeSimulatorInstrument } from './native-simulator.js'
import * as minimal from './minimal.js'

afterEach(() => vi.restoreAllMocks())
class TestCommands extends Service {
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(): () => void { return () => {} }
}

describe('native minimum through the real dsh dispatcher', () => {
  it('serializes writes with their readbacks, records identity loss, and unloads its tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-runtime-'))
    const resultsPath = join(dir, 'results.jsonl')
    vi.spyOn(NativeSimulatorConnection.prototype, 'start').mockResolvedValue()
    vi.spyOn(NativeSimulatorConnection.prototype, 'assertOwned').mockResolvedValue()
    const verify = vi.spyOn(NativeSimulatorConnection.prototype, 'assertCurrent').mockResolvedValue()
    const detach = vi.spyOn(NativeSimulatorConnection.prototype, 'stop').mockResolvedValue()
    vi.spyOn(NativeSimulatorInstrument.prototype, 'closeAll').mockResolvedValue()
    let bias = 0
    const wire = vi.spyOn(NativeSimulatorInstrument.prototype, 'call').mockImplementation(async (method, args) => {
      if (method === 'Bias_Set') {
        bias = Number(args[0])
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return { method, command: method, args: [], role: 'main', values: method === 'Bias_Get' ? [bias] : [], at: Date.now(), elapsedMs: 1, simulated: true }
    })
    const ctx = new Context()
    new TestCommands(ctx)
    const prompt = ctx.plugin(SystemPrompt)
    await prompt.await()
    const tools = ctx.plugin(ToolRuntime)
    await tools.await()
    const runtime = ctx.plugin(minimal, {
      nativeSimulator: { pid: 123 }, recordsPath: join(dir, 'records.sqlite'), resultsPath,
    })
    const call = (name: string, id: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) => ctx.tools.execute({
      name, callId: id as Parameters<typeof ctx.tools.execute>[0]['callId'], arguments: args,
      signal,
    })
    try {
      await runtime.await()
      expect(ctx.tools.schemas().map((x) => x.name).sort()).toEqual([...minimal.NATIVE_TOOL_NAMES].sort())
      // 两次都是小幅同号改动（0 → 0.125 → 0.25），走直写；变号会改走 BiasSettleChange，见下一个用例
      await Promise.all([call('SetBias', 'a', { bias_v: '125m' }), call('SetBias', 'b', { bias_v: '250m' })])
      const lines = readFileSync(resultsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toHaveLength(2)
      expect(lines.map((r) => ({ kind: r.kind, text: r.text }))).toEqual([
        { kind: 'ok', text: expect.any(String) }, { kind: 'ok', text: expect.any(String) },
      ])
      expect(lines.map((r) => [r.toolCallId, r.kind, r.data.bias_v])).toEqual([
        ['a', 'ok', 0.125], ['b', 'ok', 0.25],
      ])
      // 每次调用 = 读起点、写、回读，三步连在一起；两次调用不交叉
      expect(wire.mock.calls.map((args) => args[0])).toEqual([
        'Bias_Get', 'Bias_Set', 'Bias_Get', 'Bias_Get', 'Bias_Set', 'Bias_Get',
      ])
      const cancellation = new AbortController()
      verify.mockImplementationOnce(async () => { cancellation.abort() })
      await call('SetBias', 'cancelled-during-identity-check', { bias_v: '0.25' }, cancellation.signal)
      const cancelled = JSON.parse(readFileSync(resultsPath, 'utf8').trim().split('\n').at(-1)!)
      expect(cancelled.kind).not.toBe('ok')
      expect(cancelled.text).toContain('native_simulator_aborted')
      expect(wire).toHaveBeenCalledTimes(6)
      verify.mockRejectedValue(new Error('native_simulator_identity_changed'))
      await call('GetBias', 'identity-lost')
      const failed = JSON.parse(readFileSync(resultsPath, 'utf8').trim().split('\n').at(-1)!)
      expect(failed.kind).not.toBe('ok')
      expect(failed.text).toContain('native_simulator_identity_changed')
      expect(failed.instrumentCalls).toEqual([])
      await runtime.dispose()
      expect(ctx.tools.schemas()).toEqual([])
      expect(detach).toHaveBeenCalled()
    } finally {
      await runtime.dispose()
      await tools.dispose()
      await prompt.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 真计时器：0.125 V → -0.5 V，斜坡 3 步加变号的 2 s 稳定等待，整条约 2.2 s；
  // 不用假计时器是为了让斜坡、等待、回读走真实的先后。
  it('walks a sign change through the safe path with one result line and the sub-steps audited in SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-runtime-'))
    const resultsPath = join(dir, 'results.jsonl')
    vi.spyOn(NativeSimulatorConnection.prototype, 'start').mockResolvedValue()
    vi.spyOn(NativeSimulatorConnection.prototype, 'assertOwned').mockResolvedValue()
    vi.spyOn(NativeSimulatorConnection.prototype, 'assertCurrent').mockResolvedValue()
    vi.spyOn(NativeSimulatorConnection.prototype, 'stop').mockResolvedValue()
    vi.spyOn(NativeSimulatorInstrument.prototype, 'closeAll').mockResolvedValue()
    let bias = 0.125
    const wire = vi.spyOn(NativeSimulatorInstrument.prototype, 'call').mockImplementation(async (method, args) => {
      if (method === 'Bias_Set') bias = Number(args[0])
      return { method, command: method, args: [], role: 'main', values: method === 'Bias_Get' ? [bias] : [], at: Date.now(), elapsedMs: 1, simulated: true }
    })
    const ctx = new Context()
    new TestCommands(ctx)
    const prompt = ctx.plugin(SystemPrompt)
    await prompt.await()
    const tools = ctx.plugin(ToolRuntime)
    await tools.await()
    const runtime = ctx.plugin(minimal, {
      nativeSimulator: { pid: 123 }, recordsPath: join(dir, 'records.sqlite'), resultsPath,
    })
    try {
      await runtime.await()
      const value = await ctx.tools.execute({
        name: 'SetBias', callId: 'flip' as Parameters<typeof ctx.tools.execute>[0]['callId'],
        arguments: { bias_v: '-500m' }, signal: new AbortController().signal,
      })
      expect(value).toMatchObject({
        isError: false, value: 'SetBias: -0.5 V (readback verified, via BiasSettleChange ramp_through_zero)',
      })
      const lines = readFileSync(resultsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toHaveLength(1) // 子步只进 SQLite，JSONL 每次调用一行
      expect(lines[0]).toMatchObject({
        toolCallId: 'flip', skill: 'SetBias', kind: 'ok',
        data: { path: 'BiasSettleChange', strategy: 'ramp_through_zero', crossed_zero: true, bias_v: -0.5, verified: true },
      })
      const methods = wire.mock.calls.map((args) => args[0])
      expect(methods.slice(0, 3)).toEqual(['Bias_Get', 'Bias_Get', 'ZCtrl_OnOffGet'])
      expect(methods.at(-1)).toBe('Bias_Get')
      expect(methods.filter((method) => method === 'Bias_Set').length).toBeGreaterThan(1)
      // 子步的线上调用也归到顶层这一次调用名下
      expect(lines[0].instrumentCalls.map((record: { method: string }) => record.method)).toEqual(methods)
      const rows = ctx.stmRecords.store.db
        .prepare('SELECT action_type, status FROM actions WHERE tool_call_id = ? ORDER BY rowid').all('flip')
      expect(rows).toEqual([
        { action_type: 'SetBiasRamp', status: 'succeeded' },
        { action_type: 'BiasSettleChange', status: 'succeeded' },
        { action_type: 'SetBias', status: 'succeeded' },
      ])
    } finally {
      await runtime.dispose()
      await tools.dispose()
      await prompt.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
