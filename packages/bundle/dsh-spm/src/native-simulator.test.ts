import { Context } from 'dsh-spm-compat'
import { type RoleLink } from 'dsh-spm-nanonis-wire'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeSimulatorConnection, NativeSimulatorInstrument, verifyNativeSimulator,
  type NativeSimulatorSnapshot, type NativeTcpConnection,
} from './native-simulator.js'

function snapshot(): NativeSimulatorSnapshot {
  const connections: NativeTcpConnection[] = [6501, 6502, 6503, 6504].map((port) => ({
    pid: 100, localAddress: '0.0.0.0', localPort: port, remoteAddress: '0.0.0.0', remotePort: 0, state: 'Listen',
  }))
  for (const port of [6555, 6556, 6557]) {
    connections.push(
      { pid: 200, localAddress: '0.0.0.0', localPort: port, remoteAddress: '0.0.0.0', remotePort: 0, state: 'Listen' },
      { pid: 100, localAddress: '127.0.0.1', localPort: port + 10, remoteAddress: '127.0.0.1', remotePort: port, state: 'Established' },
      { pid: 200, localAddress: '127.0.0.1', localPort: port, remoteAddress: '127.0.0.1', remotePort: port + 10, state: 'Established' },
    )
  }
  return {
    processes: [
      { pid: 100, parentPid: 1, executable: 'C:\\Nanonis V5e\\Mimea\\Nanonis Mimea.exe', createdAt: '2026-09-21T06:29:44.6833420Z' },
      { pid: 200, parentPid: 100, executable: 'C:\\Nanonis V5e\\Mimea\\RT-Engine\\Sim\\Sim-Engine.exe', createdAt: '2026-09-21T06:29:48.2913330Z' },
    ],
    connections,
  }
}

function fakeLink() {
  let connected = false
  const connect = vi.fn(async () => { connected = true })
  const close = vi.fn(async () => { connected = false })
  const request = vi.fn(async (command: string): Promise<Uint8Array> => {
    if (command === 'Bias.Get') {
      const reply = Buffer.alloc(12)
      reply.writeFloatBE(0.125)
      return reply
    }
    return new Uint8Array(8)
  })
  const link = { get connected() { return connected }, connect, close, request } as unknown as RoleLink
  return { link, connect, close, request, disconnect: () => { connected = false } }
}

describe('native simulator identity', () => {
  it('accepts the exact local Mimea + its sibling Sim-Engine with both connection endpoints', () => {
    expect(verifyNativeSimulator({ pid: 100 }, snapshot())).toMatchObject({ mimea: { pid: 100 }, engine: { pid: 200 } })
  })

  it('rejects hardware backend or an unrelated similarly named simulator process', () => {
    const state = snapshot()
    expect(() => verifyNativeSimulator({ pid: 100 }, { ...state, connections: state.connections.filter((item) => item.state !== 'Established') })).toThrow(/not connected over loopback/)
    expect(() => verifyNativeSimulator({ pid: 100 }, {
      ...state, processes: state.processes.map((item) => item.pid === 200 ? { ...item, executable: 'C:\\Other\\Sim-Engine.exe' } : item),
    })).toThrow(/sibling/)
    expect(() => verifyNativeSimulator({ pid: 100 }, {
      ...state, processes: state.processes.map((item) => item.pid === 200 ? { ...item, parentPid: 999 } : item),
    })).toThrow(/sibling/)
  })

  it('rejects external backend addresses even when a valid simulator connection remains', () => {
    const state = snapshot()
    expect(() => verifyNativeSimulator({ pid: 100 }, { ...state, connections: [...state.connections, {
      pid: 100, state: 'Established', localAddress: '192.168.1.2', localPort: 60000, remoteAddress: '192.168.1.3', remotePort: 6555,
    }] })).toThrow(/non-loopback/)
  })

  it('pins process creation identity and every listener owner, including engine listeners', () => {
    const state = snapshot()
    const pinned = verifyNativeSimulator({ pid: 100 }, state)
    for (const pid of [100, 200]) {
      expect(() => verifyNativeSimulator({ pid: 100 }, {
        ...state, processes: state.processes.map((item) => item.pid === pid ? { ...item, createdAt: 'replacement' } : item),
      }, pinned)).toThrow(/identity changed/)
    }
    for (const port of [6501, 6555]) {
      expect(() => verifyNativeSimulator({ pid: 100 }, {
        ...state, connections: state.connections.map((item) => item.localPort === port && item.state === 'Listen' ? { ...item, pid: 999 } : item),
      }, pinned)).toThrow(/owned|owner/)
    }
  })

  it('fails closed on unavailable identity and invalid attachment options', async () => {
    expect(() => new NativeSimulatorConnection({ pid: 0 })).toThrow(/pid/)
    expect(() => new NativeSimulatorConnection({ pid: 100, ports: [6501, 6501, 6502, 6503] })).toThrow(/distinct/)
    const sim = new NativeSimulatorConnection({ pid: 100 }, async () => snapshot())
    await expect(sim.assertCurrent()).rejects.toThrow(/not attached/)
    await sim.start()
    expect(sim.running).toBe(true)
    await sim.stop()
    expect(sim.running).toBe(false)
    await sim.start()
    expect(sim.running).toBe(true)
  })
})

describe('native transport boundary', () => {
  it('uses fixed local ports, permits scoped writes, and rejects unrelated writes through both call and typed paths', async () => {
    const inspect = vi.fn(async () => snapshot())
    const sim = new NativeSimulatorConnection({ pid: 100 }, inspect)
    await sim.start()
    const transport = fakeLink()
    const factory = vi.fn(() => transport.link)
    const instrument = new NativeSimulatorInstrument(new Context(), sim, factory)
    expect((await instrument.call('Bias_Get', [])).values).toEqual([0.125])
    expect(factory).toHaveBeenCalledWith('main', 6501)
    expect(inspect).toHaveBeenCalledTimes(2) // attachment + pre-connect identity check
    expect((await instrument.call('Bias_Set', [0.25])).error).toBeUndefined()
    expect((await instrument.urgentCall('Scan_Action', [1, 0])).error).toBeUndefined()
    const sent = transport.request.mock.calls.length
    expect((await instrument.call('ZCtrl_Withdraw', [1, 1000])).error).toContain('UnknownMethod')
    await expect(instrument.typed.ZCtrl_Withdraw(1, 1000)).rejects.toThrow(/method_blocked/)
    await expect(instrument.typed.Bias_Set(11)).rejects.toThrow(/argument_blocked/)
    await expect(instrument.typed.Bias_Set(Number.NaN)).rejects.toThrow(/argument_blocked/)
    expect(transport.request).toHaveBeenCalledTimes(sent)
    await instrument.closeAll()
  })

  it('typed permitted methods cannot bypass detachment and scan action argument limits', async () => {
    const sim = new NativeSimulatorConnection({ pid: 100 }, async () => snapshot())
    await sim.start()
    const transport = fakeLink()
    const instrument = new NativeSimulatorInstrument(new Context(), sim, () => transport.link)
    await expect(instrument.typed.Bias_Get()).resolves.toEqual([0.125])
    await expect(instrument.typed.Scan_Action(2, 0)).rejects.toThrow(/argument_blocked/)
    await expect(instrument.typed.Scan_Action(0, 3)).rejects.toThrow(/argument_blocked/)
    const sent = transport.request.mock.calls.length
    await sim.stop()
    expect((await instrument.call('Bias_Get', [])).error).toContain('detached')
    expect((await instrument.urgentCall('Scan_Action', [1, 0])).error).toContain('detached')
    await expect(instrument.typed.Bias_Get()).rejects.toThrow(/detached/)
    expect(transport.request).toHaveBeenCalledTimes(sent)
    await instrument.closeAll()
    expect(transport.close).toHaveBeenCalled()
  })

  it('refuses reconnecting to a replaced listener before opening the replacement socket', async () => {
    let state = snapshot()
    const sim = new NativeSimulatorConnection({ pid: 100 }, async () => state)
    await sim.start()
    const transport = fakeLink()
    const instrument = new NativeSimulatorInstrument(new Context(), sim, () => transport.link)
    expect((await instrument.call('Bias_Get', [])).error).toBeUndefined()
    transport.disconnect()
    state = { ...state, connections: state.connections.map((item) => item.localPort === 6501 ? { ...item, pid: 999 } : item) }
    expect((await instrument.call('Bias_Get', [])).error).toContain('identity')
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(sim.running).toBe(false)
    await instrument.closeAll()
  })

  it('tool-boundary identity failure latches every transport path closed', async () => {
    let state = snapshot()
    const sim = new NativeSimulatorConnection({ pid: 100 }, async () => state)
    await sim.start()
    const transport = fakeLink()
    const instrument = new NativeSimulatorInstrument(new Context(), sim, () => transport.link)
    await instrument.call('Bias_Get', [])
    state = { ...state, processes: state.processes.filter((item) => item.pid !== 200) }
    await expect(sim.assertCurrent()).rejects.toThrow(/identity/)
    expect((await instrument.call('Bias_Set', [0.25])).error).toContain('detached')
    await expect(instrument.typed.Bias_Set(0.25)).rejects.toThrow(/detached/)
    expect(transport.request).toHaveBeenCalledTimes(1)
    await instrument.closeAll()
  })

  it('detachment wins against an in-flight OS identity check', async () => {
    let release!: (state: NativeSimulatorSnapshot) => void
    const inspect = vi.fn(async () => snapshot())
    const sim = new NativeSimulatorConnection({ pid: 100 }, inspect)
    await sim.start()
    inspect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const check = sim.assertCurrent()
    await sim.stop()
    release(snapshot())
    await expect(check).rejects.toThrow(/detached/)
    expect(sim.running).toBe(false)
  })
})
