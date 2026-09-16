/**
 * 批 3l 接上**真 stmsim** —— 这一族里只有真东西答得了的那几件。
 *
 * 排第一的是**谱数据块的形状**：`_reshape_spectrum` 假定 Variables 有 8 项、
 * 通道名在 `[2]`、行数在 `[3]`、列数在 `[4]`、2D 块在 `[5]`，而**两套自己造的回包
 * 都由我决定**（合成器照协议表摆，手写夹具照我的理解摆）。一个「在两套自己造的
 * 回包上都对」的解析器，仍然可以在真东西上一次都对不上 —— 这正是 D-READBACK-1
 * 在落地第二天就还本的那条理由。
 *
 * 排第二的是**通道号的形状**：真机上 `*_ChsGet` 的索引是一串 1-元组
 * （2026-08-04 实测），而仓里每一份桩给的都是裸整数。
 *
 * 排第三的是 recv 预算那条口子：这里**故意接上一条会记账的出口**，于是
 * 「抬到了多少」这件事第一次落在一条真的能发 TCP 的路上。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  reshapeSpectrum,
  slowCallFrom,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AcquireZSpectr,
  ConfigureSTS,
  ConfigureSTSTiming,
  GetSTSChannels,
  GetSTSLimits,
  GetSTSTiming,
  SetSTSChannels,
  SetSTSSafeCond1,
  StopSTS,
  makeAcquireSTS,
} from '../src/l0/spectroscopy.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

interface Rig {
  ctx: SkillContext
  calls: string[]
  budgets: number[]
}

function instrument(timeoutMs = 10_000): Promise<Rig> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      const inst = c.instrument as {
        call: (m: string, a: readonly unknown[], o?: { timeoutMs?: number }) => Promise<SkillCallRecord>
      }
      const S0 = emptyHardwareState('stmsim')
      const calls: string[] = []
      const budgets: number[] = []
      const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
        calls.push(m)
        return inst.call(m, a)
      }
      // **真的把预算接到传输层**：`InstrumentService.call` 自己就收 `timeoutMs`，
      // 于是这条路上「抬 recv 预算」不是一句声明，是一次真的按调用设定的超时。
      const budgeted = (m: string, recvTimeoutS: number, ...a: unknown[]): Promise<SkillCallRecord> => {
        calls.push(m)
        budgets.push(recvTimeoutS)
        return inst.call(m, a, { timeoutMs: Math.ceil(recvTimeoutS * 1000) })
      }
      const self = {
        signal: new AbortController().signal,
        safeCall,
        emergencyCall: safeCall,
        slowCall: slowCallFrom(safeCall, budgeted),
        runSkill: (n: string) => Promise.resolve({ success: false, error: `本夹具不分发：${n}` }),
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        state: () => S0,
        refreshState: () => Promise.resolve(S0),
        markers: { emit: () => {} },
        depth: 0,
        owner: 'integration',
        rootCallId: 'spectroscopy',
        approvalSource: 'operator',
      } as unknown as SkillContext
      resolve({ ctx: self, calls, budgets })
    })
  })
}

describe('对真 stmsim：谱数据块的形状', () => {
  it('`BiasSpectr_Start` 的真回包 —— 要么解得开，要么**说得出为什么**', async () => {
    const rig = await instrument()
    // 先给一条短扫掠，别让这一格在集成回路里跑几分钟
    await ConfigureSTS.execute(rig.ctx, { start_v: -0.05, end_v: 0.05, num_points: 16 })
    await ConfigureSTSTiming.execute(rig.ctx, {
      z_avg_time_s: 0, init_settling_s: 0.001, max_slew_rate_v_s: 10,
      settling_s: 0.001, integration_s: 0.001,
    })
    const r = await makeAcquireSTS().execute(rig.ctx, { save_basename: 'dsh-spm-it' })
    const d = (r.data ?? {}) as Record<string, unknown>

    // 起扫本身可能被拒（模块没装）——那也是一种合法结局，但它必须**说得出话**
    if (r.success === false && d['acquisition_complete'] !== true) {
      expect(r.error ?? '').not.toBe('')
      return
    }

    // 到这儿说明扫掠真的跑完了。两件事二选一，而且**都得说得清**：
    expect(d['spectrum_parsed']).toBeTypeOf('boolean')
    if (d['spectrum_parsed'] === true) {
      // 解开了：通道名、点数、每条整行，三样齐
      const names = d['channel_names'] as string[]
      expect(Array.isArray(names) && names.length > 0).toBe(true)
      const n = d['num_points'] as number
      expect(n).toBeGreaterThan(0)
      for (const name of names) {
        expect((d[name] as number[]).length, `${name} 的长度该是列数`).toBe(n)
      }
      // ⚠️ **行列在这里才第一次被真东西检验**。本机 stmsim 实测（2026-09-16）：
      //   `[53, 3, ["Bias calc (V)","Current (A)","Current [bwd] (A)"], 3, 200, [[…200 个],[…],[…]]]`
      // 也就是 rows=3=通道、cols=200=点。**转置的读法在这里会给出 200 个
      // 只有 3 个点的「通道」** —— 每个数都是真的，而谱全错。
      expect(names.length).toBeLessThan(n)
      const volt = d['voltage'] as number[] | undefined
      if (volt !== undefined) {
        // 偏压那一路必须是**单调的一段扫掠**，不是三个数的抖动
        expect(volt.length).toBe(n)
        expect(Math.abs((volt.at(-1) as number) - (volt[0] as number))).toBeGreaterThan(0)
      }
    } else {
      // 解不开：**理由必须在**（一个缺席的键分不出「没测出来」和「没解出来」）
      expect(String(d['spectrum_unparsed_reason'] ?? '')).not.toBe('')
      expect('num_points' in d).toBe(false)
    }
  })

  it('recv 预算走的是**真的按调用设定的超时**，而且报的是用上的那个数', async () => {
    const rig = await instrument()
    const r = await makeAcquireSTS().execute(rig.ctx, {})
    const d = (r.data ?? {}) as Record<string, unknown>
    if (d['acquisition_complete'] !== true) return // 模块没装，这一格没验到
    expect(rig.budgets.length).toBe(1)
    expect(d['recv_timeout_s']).toBe(Math.round((rig.budgets[0] as number) * 10) / 10)
    // 预算是从仪器**自己的设定**算出来的，不是一个写死的数
    expect((d['sweep_settings'] as Record<string, unknown>)['npts']).not.toBeUndefined()
  })

  it('`ZSpectr_Start` 那一侧：解不开时**一律失败**，而且不去找 .dat', async () => {
    const rig = await instrument()
    const r = await AcquireZSpectr.execute(rig.ctx, {})
    expect(rig.calls).not.toContain('Util_SessionPathGet')
    if (!r.success) {
      expect(r.error ?? '').not.toBe('')
      return
    }
    const d = r.data as Record<string, unknown>
    expect(d['spectrum_parsed']).toBe(true)

    // ⚠️ **本机 stmsim 上 z 那一路的真名字是 `Z rel (m)`**（2026-09-16 实测），
    // 而四个显式 needle（`z (` / `z(` / `z_m` / `z pos`）**一个都不命中它**：
    // `'z rel (m)'` 里 `z` 后面跟的是空格再跟 `r`。
    //
    // 也就是说「名字以 z 开头」那条回退**不是冗余**，它是真机上唯一命中的那一路。
    // 删掉它，每一条真 Z 谱的 `data.z` 都会安静地消失 —— 而技能照样 success。
    const names = d['channel_names'] as string[]
    expect(names.length).toBeGreaterThan(0)
    expect(d['z'], `通道名 ${JSON.stringify(names)} 里没解出 z`).toBeDefined()
    expect((d['z'] as number[]).length).toBe(d['num_points'])
  })
})

describe('对真 stmsim：通道与限值的真形状', () => {
  it('`BiasSpectr_ChsGet` 的索引 —— 裸整数或 1-元组，两种都要读得出来', async () => {
    const rig = await instrument()
    const r = await GetSTSChannels.execute(rig.ctx, {})
    if (!r.success) return // 模块没装也是答案
    const d = r.data as { channel_indexes: number[]; channel_names: string[] }
    expect(Array.isArray(d.channel_indexes)).toBe(true)
    // 要害：**每一个都得是数**。真机 2026-08-04 上它们是 `[(0,), (30,)]`，
    // 而 `SetScanBuffer` 那一路当场死在 `int() argument must be … not 'tuple'`。
    for (const i of d.channel_indexes) expect(typeof i).toBe('number')
    for (const n of d.channel_names) expect(typeof n).toBe('string')
  })

  it('写通道 → 读回来：`*_ChsSet` 收一个实参这件事只有真机说得准', async () => {
    const rig = await instrument()
    const w = await SetSTSChannels.execute(rig.ctx, { channel_indexes: '0' })
    if (!w.success) {
      // 被拒也要说得清（而不是一句 TypeError 的 repr）
      expect(w.error ?? '').not.toBe('')
      return
    }
    const r = await GetSTSChannels.execute(rig.ctx, {})
    if (r.success) expect((r.data as { channel_indexes: number[] }).channel_indexes).toContain(0)
  })

  it('`LimitsGet` / `TimingGet`：读得到就是数，读不到那一位就不写这个键', async () => {
    const rig = await instrument()
    const lim = await GetSTSLimits.execute(rig.ctx, {})
    if (lim.success) {
      const d = lim.data as { start_v: number; end_v: number }
      expect(typeof d.start_v).toBe('number')
      expect(typeof d.end_v).toBe('number')
    }
    const t = await GetSTSTiming.execute(rig.ctx, {})
    if (t.success) {
      for (const v of Object.values(t.data as Record<string, unknown>)) expect(typeof v).toBe('number')
    }
  })

  it('`StopSTS` 在真机上要么停得下来，要么说得出为什么', async () => {
    const rig = await instrument()
    const r = await StopSTS.execute(rig.ctx, {})
    if (r.success) expect(r.data).toEqual({ stopped: true })
    else expect(r.error ?? '').not.toBe('')
  })
})

describe('对真 stmsim：那三个拒绝桩**一次 TCP 都不发**', () => {
  it('SetSTSSafeCond1 拒绝，而且调用记录是空的', async () => {
    // 这一条只有在**真的能发 TCP 的地方**验才算数：单测里「没发」和「发不出去」
    // 在调用记录上长得一样（同批 3f 的脚本白名单那一格）。
    const rig = await instrument()
    const r = await SetSTSSafeCond1.execute(rig.ctx, {
      condition: 1, threshold: 1e-12, signal_index: 0, comparison: 0,
    })
    expect(r.success).toBe(false)
    expect(rig.calls).toEqual([])
  })
})

describe('对真 stmsim：谱块解析器吃的是真 body', () => {
  it('直接问一次 `BiasSpectr_Start`，把 body 交给判定件', async () => {
    // 技能那一层之外再来一次**独立**的交叉核对：解析器直接吃
    // `InstrumentService` 解出来的 body，中间没有任何转译。
    const rig = await instrument()
    const rec = await rig.ctx.safeCall('BiasSpectr_Start', 1, '')
    if ((rec.error ?? '') !== '') {
      expect(rec.error).toMatch(/^(NanonisError|Timeout|comms_circuit_open|RoleBusy)/)
      return
    }
    const spec = reshapeSpectrum(rec.values ?? [])
    // 真机上的结论只有两种，而两种都不是「安静地给 0 个点」
    if (spec.reason === '') {
      expect(spec.numPoints).toBeGreaterThan(0)
      expect(Object.keys(spec.channels).length).toBeGreaterThan(0)
    } else {
      expect(spec.numPoints).toBe(0)
      expect(spec.reason).not.toBe('')
    }
  })
})
