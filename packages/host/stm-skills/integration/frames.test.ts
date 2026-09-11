/**
 * 三个碰文件系统的技能，对**真 stmsim** 跑一遍。
 *
 * 单测与金样验的是判据；这里验的是另一件事：**动词在真仪器上真的有回音，
 * 而回包的形状正是解析器假设的那个**。这条缝以前没人走过——`traces.test.ts` 里
 * 的回包是合成的，`scan-skills.test.ts` 里的是我手写的，两者都由我决定形状。
 * 一个「在两套自己造的回包上都对」的解析器，仍然可以在真东西上一次都对不上。
 *
 * 抓帧尤其如此：`Scan_FrameDataGrab` 的 body 是**异构**表
 * `[name_len, name(str), rows, cols, data_2D, dir]`，而旧仓在这上面栽过
 * ——`np.asarray(整表)` 在扁平桩上「能跑」，在**每一次真实扫描**上都炸
 * （2026-07-03 复盘）。所以这一格要的就是真机形状。
 *
 * 模拟器由 globalSetup 起在 16501–16504（`vitest.stmsim-setup.ts`），
 * 所以这里 `spawn: false`——用外面那份，不另起进程。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { emptyHardwareState, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { makeCreateZCtrlPreset, makeGetLatestScanFile, makeGrabScanFrameData } from '../src/l0/frames.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

/** 起一个只挂了仪器的 host，等 `ctx.instrument` 就位。 */
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

type SafeCallish = (m: string, a: readonly unknown[]) => Promise<SkillCallRecord>

/**
 * `InstrumentService.call` → `SkillContext.safeCall`。
 *
 * 两者的形状本来就一样（`CallRecord` 里有 `method` / `args` / `values` / `error`），
 * 这里只是把可变参数摊平。**没有任何转译**——有转译就等于这条缝上还有一层我写的
 * 东西，而这一组测试要验的正是没有那一层时对不对得上。
 */
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
    rootCallId: 'frames',
    approvalSource: 'operator',
  } as unknown as SkillContext
  return { ctx, calls }
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    } catch {
      // 临时目录不是判据
    }
  }
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-frames-e2e-'))
  dirs.push(d)
  return d
}

describe('对真 stmsim：抓帧、找图、建参数组', () => {
  it('Scan_FrameDataGrab 的真机回包解得出二维，落盘是一份能读的 .npy', async () => {
    const { ctx } = await instrument()
    const dir = tmp()
    const r = await makeGrabScanFrameData({ framesDir: () => dir, stamp: () => 'e2e' }).execute(
      ctx,
      { channel_index: 0, direction: 1 },
    )
    expect(r.error ?? '').toBe('')
    expect(r.success).toBe(true)
    const d = r.data as { frame_path: string; n_samples: number; shape: number[] }

    // **二维**——真机 body 是异构表，整表一起当数组解会炸，而扁平桩上看不出来
    expect(d.shape).toHaveLength(2)
    expect(d.shape[0]).toBeGreaterThan(0)
    expect(d.n_samples).toBe((d.shape[0] as number) * (d.shape[1] as number))

    // 落盘的字节自己说得清自己的形状：魔数 + 版本 + 头里的 shape + 64 字节对齐
    const raw = new Uint8Array(readFileSync(d.frame_path))
    expect([...raw.slice(0, 8)]).toEqual([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0])
    const headerLen = raw[8]! | (raw[9]! << 8)
    expect((10 + headerLen) % 64).toBe(0)
    const header = new TextDecoder().decode(raw.slice(10, 10 + headerLen))
    expect(header).toContain(`'shape': (${d.shape[0]}, ${d.shape[1]})`)
    expect(raw.length).toBe(10 + headerLen + d.n_samples * 8)
  })

  it('Util_SessionPathGet 报的是一个真目录，`GetLatestScanFile` 据此答得出话', async () => {
    const { ctx, calls } = await instrument()
    const r = await makeGetLatestScanFile().execute(ctx, { max_age_s: 300 })
    expect(calls).toEqual(['Util_SessionPathGet'])
    expect(r.success).toBe(true)
    const d = r.data as { path: string | null; searched_dirs: string[] }
    // 模拟器的会话目录是真的存在的，所以它必须出现在「我找过哪儿」里 ——
    // 这一条同时钉住 `sessionDir` 的归一（报目录 or 报文件前缀）和 `existingDirs` 的过滤
    expect(d.searched_dirs.length).toBeGreaterThan(0)
    // 找不找得到 .sxm 取决于模拟器有没有存过图，两种都是合法答案；
    // **不合法的是「答不出来」** —— 那会是一次失败，而这里必须是一次回答
    expect(d.path === null || d.path.toLowerCase().endsWith('.sxm')).toBe(true)
  })

  it('`CreateZCtrlPreset` 一个仪器调用都不发', async () => {
    const { ctx, calls } = await instrument()
    const r = await makeCreateZCtrlPreset().execute(ctx, {
      name: `e2e-${Date.now()}`,
      p_gain: '3p',
      i_gain: '180n',
    })
    expect(r.success).toBe(true)
    // config/admin 层的技能。它碰仪器就是一个 bug —— 参数组是**存下来**的，
    // 不是写下去的；真正下发要等 ApplyZCtrlPreset。
    expect(calls).toEqual([])
  })
})
