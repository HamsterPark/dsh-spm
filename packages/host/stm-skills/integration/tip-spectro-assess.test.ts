/**
 * `AssessAtomicPhase` 对**真 stmsim 存出来的那张 `.sxm`** 跑一遍（DoD ④）。
 *
 * ## 这个技能一次 Nanonis 调用都不发 —— 那为什么还有这一条
 *
 * 批 4a 的九个里有八个「读磁盘上的 `.sxm`」的技能**没有** e2e，理由写在
 * `integration/analysis.test.ts` 的抬头：在模拟器上跑它们，跑的是我自己合成的
 * 那份字节，而那份字节已经由旧仓亲自读过一遍了。
 *
 * **这一条不是那个形状。** 它先让模拟器**真的扫一帧、真的存盘**，
 * 再把 `GetLatestScanFile` 报出来的那条路径喂给这个技能。于是被验的是：
 *
 * | 验什么 | 单测与金样为什么验不到 |
 * |---|---|
 * | 一张**不是我写的**字节的 `.sxm`，通道表长什么样 | 金样那 12 个文件是 `export_batch7b1.py` 自己拼的头，通道行、方向、块顺序全按我的假设长 |
 * | 通道回落那一支在真文件上落到哪个通道 | 合成文件里我**决定**只放一个通道；真文件放几个是模拟器说了算 |
 * | `parseXyMeta` 从真头里取出来的 `nm_per_px` | 合成头里 `:SCAN_RANGE:` 是我按 `%22.6E` 摆的 |
 * | 覆盖率门在一张**扫完的**真帧上不误报 | 合成的满帧按构造没有 NaN |
 *
 * 也就是 D-READBACK-1 那条教训的同一个形状：**一个在两套自己造的输入上都对的
 * 解析器，仍然可以在真东西上一次都对不上。**
 *
 * ## 不断言「有没有原子相」
 *
 * 模拟器此刻的样品、针尖、视野是**模拟器的状态**，不是这个技能的判据 ——
 * 50 nm 的视野上本来就不该有原子相（那正是 `scale_gate` 存在的理由）。
 * 这里断言的是**结论的形状**：三态齐全、`coverage` 落在 [0,1]、
 * `scale` 与 `nm_per_px` 自洽、以及一次 TCP 都没多发。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'
import { AssessAtomicPhase } from '../src/l0/tip-spectro-assess.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

class Rig {
  readonly calls: string[] = []
  readonly subs: string[] = []
  readonly #inst: { call: SafeCallish }

  constructor(inst: { call: SafeCallish }) {
    this.#inst = inst
  }

  ctx(): SkillContext {
    const S0 = emptyHardwareState('stmsim')
    const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      this.calls.push(m)
      return this.#inst.call(m, a)
    }
    const ctx = {
      signal: new AbortController().signal,
      safeCall,
      emergencyCall: safeCall,
      slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
      runSkill: (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
        this.subs.push(name)
        const skill = IMPLEMENTED[name]
        if (skill === undefined) return Promise.resolve({ success: false, error: `注册表里没有 ${name}` })
        return skill.execute(ctx, params)
      },
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      state: () => S0,
      refreshState: () => Promise.resolve(S0),
      markers: { emit: () => {} },
      depth: 0,
      owner: 'integration',
      rootCallId: 'tip-spectro-assess',
      approvalSource: 'operator',
    } as unknown as SkillContext
    return ctx
  }
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
      resolve(new Rig(c.instrument as { call: SafeCallish }))
    })
  })
}

/** 秒级的一帧：32 px × 0.05 s/线 × 双向（同 `scan-composites.test.ts` 的 `FAST`）。 */
const FAST = { pixels: 32, line_time_s: 0.05 }

/** 扫一帧 → 存盘 → 报路径。**任何一步没成，这条测试就没有输入**，所以逐步断言。 */
async function scanAndSave(rig: Rig): Promise<string> {
  const scan = await IMPLEMENTED['ScanAt']!.execute(rig.ctx(), {
    center_x_m: 0,
    center_y_m: 0,
    size_m: 50e-9,
    ...FAST,
  })
  expect(scan.error ?? '', 'ScanAt').toBe('')
  const save = await IMPLEMENTED['SaveScan']!.execute(rig.ctx(), {})
  expect(save.error ?? '', 'SaveScan').toBe('')
  const latest = await IMPLEMENTED['GetLatestScanFile']!.execute(rig.ctx(), { max_age_s: 600 })
  expect(latest.error ?? '', 'GetLatestScanFile').toBe('')
  const path = (latest.data as { path?: unknown } | undefined)?.path
  expect(typeof path === 'string' && path.toLowerCase().endsWith('.sxm'), `拿不到 .sxm：${String(path)}`).toBe(true)
  return path as string
}

describe('AssessAtomicPhase 对真 stmsim 存出来的 .sxm', () => {
  it('读得动模拟器自己写的那份字节，三态齐全', async () => {
    const rig = await instrument()
    const path = await scanAndSave(rig)
    const before = rig.calls.length

    const r = await AssessAtomicPhase.execute(rig.ctx(), { scan_path: path, channel: 'Z' })

    // ① 这个技能**一次 TCP 都不发**。在单测里「没发」和「发不出去」长得一样，
    //    在这里它们分得开 —— 上面那几步刚证明这条连接是通的。
    expect(rig.calls.length).toBe(before)

    // ② 三态：文件读得动 ⇒ 永远 success，结论在 data 里。
    expect([r.success, r.error ?? '']).toEqual([true, ''])
    const d = r.data as Record<string, unknown>
    expect(d['scan_path']).toBe(path)
    expect(typeof d['passed']).toBe('boolean')
    expect(Array.isArray(d['reasons'])).toBe(true)

    // ③ 覆盖率：一张扫完的真帧，这道门不该开口。
    const cov = d['coverage'] as number
    expect(cov > 0 && cov <= 1, `coverage=${cov}`).toBe(true)
    expect(d['incomplete_frame']).toBe(cov < 0.5)

    // ④ 像素标度是从**真头**里解出来的，而且与视野自洽：
    //    50 nm / 32 px ≈ 1.56 nm/px ⇒ 远在 0.05 的粗端之外 ⇒ `scale === 'off'`。
    //    这一格顺带把「太粗时是**拒判**而不是说『没有原子』」在真文件上验了一遍。
    //    ⚠️ 这里**不写** `nmpp === null || …`：那种写法在 `null` 的那一侧
    //    什么都不问，于是「头解不开」与「解开了而且对」长得一样
    //    （green-8 §2.4 那条「断言的形状把自己抵消了」）。50 nm / 32 px 是
    //    这一趟**构造出来**的输入，所以这个数是可以算死的。
    expect(d['nm_per_px']).toBeCloseTo((50 / 32) * 1.0, 10)
    expect(d['scale']).toBe('off')
    expect(d['reasons']).toContain('scale_gate')
    expect(r.summary).toContain('这不等于「没有原子相」')
    expect(d['passed']).toBe(false)

    // ⑤ 衬底注入口默认关着 ⇒ 不做晶格常数比对，而**不算失败**。
    expect([d['substrate'], d['substrate_available'], d['expected_a_nm']]).toEqual([null, false, null])
  })

  it('通道回落在**真**文件上也成立 —— 要一个不存在的通道，照样出数', async () => {
    // 合成文件里「只有一个通道」是我决定的；真文件放几路是模拟器说了算。
    // 这一格问的是：拿一个肯定不存在的名字去要，它是回落（不是报错）。
    const rig = await instrument()
    const path = await scanAndSave(rig)
    const named = await AssessAtomicPhase.execute(rig.ctx(), { scan_path: path, channel: 'Z' })
    const bogus = await AssessAtomicPhase.execute(rig.ctx(), { scan_path: path, channel: '没有这一路' })
    expect(bogus.success).toBe(true)
    expect(bogus.error ?? '').toBe('')
    // 回落取的是**第一个**通道。真文件里第一路是不是 Z，由模拟器决定 ——
    // 所以这里不断言「等于 Z 那一路」，只断言它**出了数**而不是报错。
    expect(typeof (bogus.data as Record<string, unknown>)['passed']).toBe('boolean')
    expect((bogus.data as Record<string, unknown>)['coverage']).toBeTypeOf('number')
    // 而指名一路真有的，照样出数（上面那一格已经断言过 error 是空的）。
    expect(named.success).toBe(true)
  })

  it('路径不存在时报的是那句话 —— 真会话目录下也一样', async () => {
    const rig = await instrument()
    const path = await scanAndSave(rig)
    const nope = `${path.slice(0, path.lastIndexOf('/') + 1)}没有这个文件.sxm`
    const r = await AssessAtomicPhase.execute(rig.ctx(), { scan_path: nope })
    expect([r.success, r.error]).toEqual([false, `文件不存在: ${nope}`])
  })
})
