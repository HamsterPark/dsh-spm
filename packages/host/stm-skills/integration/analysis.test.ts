/**
 * `AssessAtomicLines` 对**真 stmsim** 跑一遍（DoD ④）。
 *
 * ## 批 4a 九个里为什么只有这一个有 e2e
 *
 * 另外八个**一次 Nanonis 调用都不发** —— 它们读的是磁盘上的一张 `.sxm`。
 * 在模拟器上跑它们，跑的是我自己合成的那份字节而不是仪器，
 * 而那份字节已经在 `spec/golden/analysis.json` 里被旧仓亲自读过一遍了。
 * 这与「stmsim 没有那个模块 ⇒ 只对 SpecEchoServer 做 e2e」不是同一种情况：
 * 那种是**模拟器缺能力**，这种是**技能不碰仪器**（同批 3k 的两个环境读）。
 *
 * ## 这一条要验的是单测验不到的那件事
 *
 * `resolveReadout` 一口气问四个动词，而它对每一个回包的**形状**都有假设：
 *
 * | 动词 | 假设 |
 * |---|---|
 * | `Scan_BufferGet` | body 是 `[n, [通道…], pixels, lines]`，而通道号在真机上是**一串 1-元组** |
 * | `Signals_NamesGet` | body 是 `[size, declared_n, 名字表]` —— 名字在 **`body[2]`**（D-ATOMLINE-1 的全部内容） |
 * | `Scan_FrameGet` | body 是 `[cx, cy, w, h, angle]`，视野在 **`[2]`** |
 * | `Scan_FrameDataGrab` | body 是**异构**表 `[name_len, name(str), rows, cols, data_2D, dir]` |
 *
 * 四个假设里有三个是「第 k 个元素是什么」，而**自己造的回包会照着假设长**。
 * 2026-09-13 那次（D-READBACK-1）的教训就在这儿：一个「在两套自己造的回包上都对」
 * 的解析器，仍然可以在真东西上一次都对不上。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`）。
 */
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { emptyHardwareState, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { AssessAtomicLines, resolveReadout } from '../src/l0/analysis-lines.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

function instrument(timeoutMs = 10_000): Promise<{ ctx: SkillContext; calls: string[] }> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      resolve(skillCtx(c.instrument as { call: SafeCallish }))
    })
  })
}

/** `InstrumentService.call` → `SkillContext.safeCall`，**中间没有任何转译**。 */
function skillCtx(inst: { call: SafeCallish }): { ctx: SkillContext; calls: string[] } {
  const calls: string[] = []
  const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
    calls.push(m)
    return inst.call(m, a)
  }
  const S0 = emptyHardwareState('stmsim')
  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    runSkill: (n: string) => Promise.resolve({ success: false, error: `本夹具不分发子技能：${n}` }),
    now: () => Date.now() / 1000,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'integration',
    rootCallId: 'analysis',
    approvalSource: 'operator',
  } as unknown as SkillContext
  return { ctx, calls }
}

describe('对真 stmsim：线级原子分辨建议', () => {
  it('四个回包的形状都是解析器假设的那个', async () => {
    const { ctx } = await instrument()
    const calls: SkillCallRecord[] = []
    const ro = await resolveReadout(ctx, calls)

    // 顺序本身是判据：先问缓冲（要通道号），再问信号名，最后问视野。
    expect(calls.map((c) => c.method)).toEqual(['Scan_BufferGet', 'Signals_NamesGet', 'Scan_FrameGet'])
    expect(ro.why).toBe('')
    // 通道号真的解出来了 —— 真机上它们是**一串 1-元组**，
    // 而仓里每一份桩给的都是裸整数（2026-08-04 就是这么栽的）。
    expect(ro.channels.length).toBeGreaterThan(0)
    expect(ro.channels.every((c) => Number.isInteger(c))).toBe(true)
    // 视野与像素数都读到了 ⇒ 尺度是**算**出来的，不是猜的。
    expect(ro.pixels !== null && ro.pixels > 0).toBe(true)
    expect(ro.widthM !== null && ro.widthM > 0).toBe(true)
    expect(ro.nmPerPx !== null && ro.nmPerPx > 0).toBe(true)
    // 通道从哪来的**说得出**：要么按名字解出，要么明说是兜底。
    expect(['按信号名 Z 解出', '兜底：缓冲里非电流的那一路']).toContain(ro.zSource)
  }, 30_000)

  it('整条技能走得通，而且「抓不到帧」也是一句说得清的话', async () => {
    const { ctx, calls } = await instrument()
    const r = await AssessAtomicLines.execute(ctx, {})
    // ⚠️ **这里不断言 `success`**：模拟器上此刻有没有在扫、缓冲里有没有数据，
    // 是模拟器的状态而不是这个技能的判据。要断言的是
    // 「它发的是那四个动词，而且它对结果说的话是可读的那几句之一」。
    expect(calls.slice(0, 3)).toEqual(['Scan_BufferGet', 'Signals_NamesGet', 'Scan_FrameGet'])
    if (r.success) {
      const d = r.data as Record<string, unknown>
      expect(typeof d['advisory']).toBe('string')
      expect(typeof d['worth_a_frame']).toBe('boolean')
      expect(d['nm_per_px']).toBeGreaterThan(0)
      // 建议线是**报出来**的 —— 一个不带阈值的建议没法复核。
      expect(d['advisory_snr']).toBe(80)
    } else {
      // 失败那一侧同样要说得清：不许是空串，也不许是一句 `undefined`。
      expect((r.error ?? '').length).toBeGreaterThan(8)
    }
  }, 30_000)

  /**
   * ⚠️ **这一条是这组 e2e 的产出**：问一个缓冲里没有的通道，
   * 真模拟器**不报错** —— 它照样回一个东西。
   *
   * 旧仓的模块抬头写的是「会得到一个对不齐的回包，报出来是
   * `response layout mismatch`」，而那句话是关于**真机**的。在 stmsim 上它退化成
   * 另一种形状：回包解得开、拼得成二维，但**一行都不是扫出来的**，
   * 于是技能在下一步（`usableRows` / `frameLineAdvisory`）才失败。
   *
   * 两种形状的共同点才是判据：**「我问错了通道」不会以「通道号错了」的样子出现**。
   * 所以「拒绝时把缓冲里有哪些说出来」那句话**只挂在 `Scan_FrameDataGrab` 报错
   * 那一支上**，而真机上那一支未必走得到 —— 这一条把这件事钉住，
   * 免得下一个人以为那句提示是兜底的。
   */
  /**
   * ⚠️ **2026-09-16 补（批 4d）：上面那句「真模拟器不报错」漏了一个前提。**
   *
   * `stmsim/modules/scan_module.py:_grab` 只有在 `w.frame is None`（**这台模拟器
   * 从来没扫过任何一帧**）时才回一帧全零；一旦跑过一次真扫描，它就去 `fr.data` 里
   * 查通道，查不到直接抛 `BadArguments`。
   *
   * 而整组 `integration` **共用一台**模拟器。在批 4d 之前没有任何一条集成测试真的
   * 扫过图，于是那个前提一直白给；`ScanAt` / `FullScan` 的 e2e 落地当天，这一格就
   * 从「单独跑绿、整组跑红」的方式炸了 —— 而它报的是「通道 126 不在缓冲里」，
   * 指向一个跟它自己完全无关的地方。
   *
   * 所以这里断言**两种形状的并集**，并且把「是哪一种」也断言出来（不是 `||` 一下
   * 就算数）：判据本来就写在上面那段注释里 —— **「我问错了通道」不会以「通道号错了」
   * 的样子出现**，而两条路都满足它。
   */
  it('问一个缓冲里没有的通道：扫过之前回一帧全零，扫过之后才报错', async () => {
    const { ctx } = await instrument()
    const scanned = await ctx.safeCall('Scan_StatusGet')
    const grab = await ctx.safeCall('Scan_FrameDataGrab', 126, 1)
    const simRefuses = (grab.error ?? '') !== ''
    expect(scanned.error ?? '').toBe('') // 夹具自己得是活的

    const r = await AssessAtomicLines.execute(ctx, { channel_index: 126 })
    expect(r.success).toBe(false)
    if (simRefuses) {
      // 扫过之后：失败在**抓帧**那一步，证据在**那句话里** ——
      // 它同时印出「你问的是哪一路」与「缓冲里实际有哪几路」。
      // （`data` 这条路上是空的：抓帧那一支在 readout 之后就 return 了。）
      expect(r.error ?? '').toContain('取不到通道 126 的帧')
      expect(r.error ?? '').toContain('扫描缓冲里的通道是')
    } else {
      // 没扫过：回包解得开、拼得成二维，但**一行都不是扫出来的** ——
      // 失败的位置在**线级判读**那一步，不在抓帧那一步，
      // 于是通道解析那一侧照旧把证据交进了 `data`。
      expect(r.error ?? '').toBe('这一帧里没有已扫出来的行')
      const d = (r.data ?? {}) as Record<string, unknown>
      expect(d['channel_index']).toBe(126)
      expect(d['channel_source']).toBe('参数指定')
    }
  }, 30_000)
})
