/**
 * `ComputeDriftVector` 对**真 stmsim** 跑一遍（DoD ④）。
 *
 * ## 批 4c 十二个里为什么只有这一个有 e2e
 *
 * 另外十一个**一次 Nanonis 调用都不发** —— 它们读的是磁盘上的 `.npy` / `.sxm` /
 * `.dat`。在模拟器上跑它们，跑的是我自己合成的那份字节，而那份字节已经在
 * `spec/golden/paper_data.json` 里被旧仓亲自读过一遍了（同批 4a 那八个）。
 *
 * ## 这一条要验的是单测验不到的两件事
 *
 * 1. **真回包的形状**。`Scan_FrameDataGrab` 在真机上回的是一个**异构表**
 *    `[name_len, name(str), rows, cols, data_2D, dir]`，而 `parseFrameGrab(body, false)`
 *    要从里面把那块二维数据挑出来**再拉平**。自己造的回包会照着假设长
 *    （D-READBACK-1 那一课：一个「在两套自己造的回包上都对」的解析器，
 *    仍然可以在真东西上一次都对不上）。
 *
 * 2. **`arr.size != ref.size` 这条判据比的是元素个数，不是形状**。
 *    真模拟器的帧有多大是它说了算 —— 用它自己刚给的那一帧当参考，
 *    尺寸必然对得上；把参考切小一圈，必然对不上。两侧都跑一遍。
 *
 * ## ⚠️ 这一组的产出：**同一帧对它自己，这个技能从来不报 0**
 *
 * 两种情形，两个数，**都不是 0**：
 *
 * | 缓冲里是什么 | 报出来的位移 | 换算成米（256 px / 10 nm） |
 * |---|---|---|
 * | 真有结构 | `−1` 像素（偶数边长时） | 39 pm |
 * | **一片死平**（模拟器刚起来时就是这样，实测整幅 65536 个 0） | `−rows//2` 像素 | **−5 nm，半幅** |
 *
 * 第一行是 D-NUM-19：`correlate2d(mode='same')` 的原点是 `(M−1)//2`，
 * 而技能拿 `shape//2` 当中心 —— **两个都是 scipy、两个都叫「中心」**，
 * 偶数尺寸时差一格。
 *
 * 第二行更糟，而且它是这次 e2e **当场撞出来的**：去均值之后整幅是 0 ⇒
 * 互相关面处处是 0 ⇒ `argmax` 落在下标 0 ⇒ 位移 = `−(shape//2)`。
 * 技能报 `success: true`，`data` 里四个数一个不缺，**没有任何字段说得出
 * 「这两帧里没有可对齐的东西」**。而漂移补偿会照着那个数去驱动硬件。
 *
 * 两条都照移（金样把旧仓那一侧钉住了），这一组把它们**演示**出来 ——
 * 一个「看起来完全合理的漂移读数」是这类缺陷唯一的外部表现。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import {
  emptyHardwareState,
  encodeNpyFloat64,
  parseFrameGrab,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeDriftVector } from '../src/l0/scan-frame-offline.js'

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
    rootCallId: 'paper-drift',
    approvalSource: 'operator',
  } as unknown as SkillContext
  return { ctx, calls }
}

describe('对真 stmsim：漂移向量', () => {
  it('拿仪器刚给的那一帧当参考 —— 尺寸对得上，而报出来的漂移**不是 0**', async () => {
    const { ctx } = await instrument()
    // 先把真回包要过来，按技能自己那条路解开，写成参考 `.npy`。
    // **这一帧是仪器给的，不是我合成的** —— 也就是说下面那次比对里，
    // 「回包长什么样」这件事完全由模拟器决定。
    const rec = await ctx.safeCall('Scan_FrameDataGrab', 0, 1)
    const arr = parseFrameGrab(rec.values ?? null, true)
    expect(Array.isArray(arr)).toBe(true)
    const rows = arr as number[][]
    expect(Array.isArray(rows[0])).toBe(true)
    const nRows = rows.length
    const nCols = (rows[0] as number[]).length
    expect(nRows).toBeGreaterThan(1)
    expect(nCols).toBeGreaterThan(1)

    const dir = mkdtempSync(join(tmpdir(), 'drift-e2e-')).replaceAll('\\', '/')
    const refPath = `${dir}/ref.npy`
    writeFileSync(refPath, encodeNpyFloat64(rows.flat(), [nRows, nCols]))

    const r = await ComputeDriftVector.execute(ctx, { ref_path: refPath, scan_width_m: 1e-8 })
    expect(r.success).toBe(true)
    const d = r.data as Record<string, unknown>
    // 尺寸对得上 ⇒ 走的是真正算互相关那一支（`note` 那个键**不在**）。
    expect('note' in d).toBe(false)

    // 缓冲里到底有没有东西是**模拟器的状态**，不是这个技能的判据 ——
    // 所以期望值从**拿到的那一帧**算出来，两条路各自可断言（见文件抬头那张表）。
    const flat = rows.flat()
    const degenerate = flat.every((v) => v === (flat[0] as number))
    const wantY = degenerate ? -Math.floor(nRows / 2) : nRows % 2 === 0 ? -1 : 0
    const wantX = degenerate ? -Math.floor(nCols / 2) : nCols % 2 === 0 ? -1 : 0
    expect([degenerate, d['shift_y_px'], d['shift_x_px']]).toEqual([degenerate, wantY, wantX])

    // ⚠️ **这一条才是这组 e2e 的产出**：一帧对它自己，答案永远不是 0，
    // 而且没有任何字段说得出「这两帧里没有可对齐的东西」。
    expect(d['shift_x_px'] === 0 && d['shift_y_px'] === 0).toBe(false)
    expect(d['drift_x_m']).toBeCloseTo(wantX * (1e-8 / nCols), 15)
    // 一片死平的缓冲上，那个数是**半幅**（256 px / 10 nm ⇒ −5 nm）。
    if (degenerate) expect(Math.abs(d['drift_x_m'] as number)).toBeCloseTo(1e-8 / 2, 12)
  }, 30_000)

  it('参考图小一圈 ⇒ 报 `drift = 0` 并带一句 `note`，而**不是**失败', async () => {
    const { ctx } = await instrument()
    const dir = mkdtempSync(join(tmpdir(), 'drift-e2e-')).replaceAll('\\', '/')
    const refPath = `${dir}/small.npy`
    writeFileSync(refPath, encodeNpyFloat64(new Array(4 * 4).fill(1e-9), [4, 4]))

    const r = await ComputeDriftVector.execute(ctx, { ref_path: refPath, scan_width_m: 1e-8 })
    // 旧仓在这里刻意**不失败**：调用方（漂移跟踪 workflow）拿到 0 会「这一轮不补偿」
    // 继续跑，而一次失败会打断整条链。
    expect(r.success).toBe(true)
    const d = r.data as Record<string, unknown>
    expect(d['drift_x_m']).toBe(0)
    expect(d['drift_y_m']).toBe(0)
    // ⚠️ 「0 是量出来的」与「0 是量不了」靠一个**键在不在**区分 —— 照移，记一笔。
    expect(typeof d['note']).toBe('string')
    expect(d['note']).toMatch(/^size mismatch ref=16 cur=\d+$/)
    expect('shift_x_px' in d).toBe(false)
  }, 30_000)

  it('参考图读不动 ⇒ **一次 TCP 都不发**', async () => {
    const { ctx, calls } = await instrument()
    const r = await ComputeDriftVector.execute(ctx, {
      ref_path: `${tmpdir().replaceAll('\\', '/')}/definitely-not-here-4c.npy`,
      scan_width_m: 1e-8,
    })
    expect(r.success).toBe(false)
    expect(r.error ?? '').toMatch(/^cannot load reference image: /)
    // 顺序是判据：先读盘再碰仪器。反过来的话，一次注定失败的分析会先占一次锁。
    expect(calls).toEqual([])
  }, 30_000)
})
