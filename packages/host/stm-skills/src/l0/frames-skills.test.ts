/**
 * 三个碰文件系统的技能：抓帧落盘、找最近那张图、建 Z 参数组。
 *
 * 通用轨迹金样只驱动得到**一条**路（合成回包 → 一次成功 + 两种失败）。这一组要的是
 * 别的：同一毫秒里连发两次抓帧、目录读不动、session 路径报的是文件前缀、
 * `.SXM` 大写、参数组的每一种拒绝……这些格子里没有一格是「多加一个断言」，
 * 每一格都对应一件在真机上发生过、或者只会在真机上发生的事。
 *
 * 落盘全部走**临时目录**：往仓里写测试产物，等于让下一次测试读到上一次的残留 ——
 * 而这恰恰是 `GrabScanFrameData` 自己要防的那个缺陷。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PresetStore,
  encodeNpyFloat64,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  existingDirs,
  findLatestSaved,
  makeCreateZCtrlPreset,
  makeGetLatestScanFile,
  makeGrabScanFrameData,
  sessionDir,
} from './frames.js'

const roots: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-frames-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true })
    } catch {
      // 清不掉就算了 —— 临时目录不是判据
    }
  }
})

/** 一个只回放脚本的假 context。`null` = 这一次读失败。 */
function rig(replies: Record<string, unknown[] | null>): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
} {
  const calls: { verb: string; args: unknown[] }[] = []
  const call = (verb: string, args: unknown[]): SkillCallRecord => {
    calls.push({ verb, args })
    const v = replies[verb]
    if (v === undefined) return { method: verb, args, values: [] }
    return v === null
      ? { method: verb, args, error: '模拟故障：读不到' }
      : { method: verb, args, values: v }
  }
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]) => Promise.resolve(call(m, a)),
    emergencyCall: (m: string, ...a: unknown[]) => Promise.resolve(call(m, a)),
    runSkill: (n: string) => Promise.resolve({ success: false, error: `桩不支持 '${n}'` }),
  } as unknown as SkillContext
  return { ctx, calls }
}

/** 真机 body 是**异构**表 `[name_len, name, rows, cols, data_2D, dir]`。 */
const body2x2 = (rows: number[][]): unknown[] => [1, 'Z', rows.length, rows[0]!.length, rows, 1]
const FRAME_2x2 = body2x2([[1.5, 2.5], [3.5, 4.5]])

// ─────────────────────────────────────────────────────────────────────────
// GrabScanFrameData
// ─────────────────────────────────────────────────────────────────────────

describe('GrabScanFrameData', () => {
  function grab(dir: string, stamp = 'aabbccdd') {
    return makeGrabScanFrameData({ framesDir: () => dir, stamp: () => stamp })
  }

  it('二维保形落盘，返回的是路径不是数组', async () => {
    const dir = tmp()
    const { ctx } = rig({ Scan_FrameDataGrab: FRAME_2x2 })
    const r = await grab(dir).execute(ctx, { channel_index: 0, direction: 1 })
    expect(r.success).toBe(true)
    const d = r.data as { frame_path: string; n_samples: number; shape: number[] }
    // **形状是判据。** 旧仓这里把二维拉平过，于是每一个 .npy 都是扁的，
    // 断链断在测量之后一步：报告里每个数都是真的，只是没有图。
    expect(d.shape).toEqual([2, 2])
    expect(d.n_samples).toBe(4)
    expect(d.frame_path).toBe(join(dir, 'frame_ch0_dir1_aabbccdd.npy'))
    // 逐字节 —— 「大概能用 numpy 读回来」在 np.load 抛异常之前一切看起来都正常
    expect(new Uint8Array(readFileSync(d.frame_path))).toEqual(
      encodeNpyFloat64([1.5, 2.5, 3.5, 4.5], [2, 2]),
    )
  })

  it('通道与方向都进文件名', async () => {
    const dir = tmp()
    const { ctx, calls } = rig({ Scan_FrameDataGrab: FRAME_2x2 })
    const r = await grab(dir).execute(ctx, { channel_index: 14, direction: 0 })
    expect(calls).toEqual([{ verb: 'Scan_FrameDataGrab', args: [14, 0] }])
    expect((r.data as { frame_path: string }).frame_path).toBe(
      join(dir, 'frame_ch14_dir0_aabbccdd.npy'),
    )
  })

  it('参数缺省：通道 0、正扫', async () => {
    const dir = tmp()
    const { ctx, calls } = rig({ Scan_FrameDataGrab: FRAME_2x2 })
    await grab(dir).execute(ctx, {})
    expect(calls[0]?.args).toEqual([0, 1])
  })

  it('同一个戳连发三次：取第一个空名，前两份都还在', async () => {
    const dir = tmp()
    const g = grab(dir)
    const paths: string[] = []
    for (const v of [1, 2, 3]) {
      const { ctx } = rig({ Scan_FrameDataGrab: body2x2([[v, v], [v, v]]) })
      const r = await g.execute(ctx, { channel_index: 0, direction: 1 })
      paths.push((r.data as { frame_path: string }).frame_path)
    }
    expect(paths).toEqual([
      join(dir, 'frame_ch0_dir1_aabbccdd.npy'),
      join(dir, 'frame_ch0_dir1_aabbccdd_01.npy'),
      join(dir, 'frame_ch0_dir1_aabbccdd_02.npy'),
    ])
    // **前两份没有被盖掉。** 毫秒戳自己不够唯一，背靠背两次抓帧会落在同一毫秒里；
    // 真机 2026-07-28 上就是这么把上一趟的帧毁掉的。
    for (const [i, p] of paths.entries()) {
      expect(new Uint8Array(readFileSync(p))).toEqual(
        encodeNpyFloat64([i + 1, i + 1, i + 1, i + 1], [2, 2]),
      )
    }
  })

  it('显式 save_path：落到那儿，父目录自动建', async () => {
    const dir = tmp()
    const want = join(dir, 'a', 'b', 'mine.npy')
    const { ctx } = rig({ Scan_FrameDataGrab: FRAME_2x2 })
    const r = await grab(dir).execute(ctx, { channel_index: 0, save_path: `  ${want}  ` })
    expect((r.data as { frame_path: string }).frame_path).toBe(want)
    expect(existsSync(want)).toBe(true)
  })

  it('一维回包：拼不成图就按一维存，不再发一次 TCP', async () => {
    const dir = tmp()
    // 5 个数：没有二维块；表头那两位（2、3）乘起来不等于 5，也不是完全平方数
    const { ctx, calls } = rig({ Scan_FrameDataGrab: [1, 2, 3, 4, 5] })
    const r = await grab(dir).execute(ctx, { channel_index: 0 })
    expect(r.success).toBe(true)
    expect((r.data as { shape: number[] }).shape).toEqual([5])
    // 二维是**偏好**不是前置条件：已经到手的采样丢掉，比拼不成图更坏
    expect(calls).toHaveLength(1)
  })

  it('抓帧失败：原样报出仪器那句话', async () => {
    const dir = tmp()
    const { ctx } = rig({ Scan_FrameDataGrab: null })
    const r = await grab(dir).execute(ctx, { channel_index: 0 })
    expect(r).toEqual({ success: false, error: '模拟故障：读不到' })
  })

  it('回包解不出采样：说「没有可用采样」，不是空图', async () => {
    const dir = tmp()
    const { ctx } = rig({ Scan_FrameDataGrab: [] })
    const r = await grab(dir).execute(ctx, { channel_index: 0 })
    expect(r).toEqual({
      success: false,
      error: 'Scan_FrameDataGrab returned no usable samples',
    })
  })

  it('写盘失败：报成一次干净的失败，不抛', async () => {
    const dir = tmp()
    // 拿一个**文件**当目录用 —— mkdir 必炸
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x')
    const { ctx } = rig({ Scan_FrameDataGrab: FRAME_2x2 })
    const r = await makeGrabScanFrameData({ framesDir: () => blocked }).execute(ctx, {
      channel_index: 0,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/^failed to save frame \.npy: /)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// GetLatestScanFile
// ─────────────────────────────────────────────────────────────────────────

/** 造一个文件并把 mtime 拨到 `ageS` 秒之前。 */
function touch(path: string, ageS: number, nowS: number, bytes = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  utimesSync(path, nowS - ageS, nowS - ageS)
}

const NOW = 1_700_000_000

describe('findLatestSaved', () => {
  it('跨目录、跨层级取最新的那个', () => {
    const a = tmp()
    const b = tmp()
    touch(join(a, 'deep', 'x_0001.sxm'), 100, NOW)
    touch(join(a, 'x_0002.sxm'), 50, NOW)
    touch(join(b, 'x_0003.sxm'), 10, NOW, 'abcde')
    const f = findLatestSaved([a, b], '.sxm', NOW, 300)
    expect(f?.path).toBe(join(b, 'x_0003.sxm'))
    expect(Math.round(f?.ageS ?? -1)).toBe(10)
    expect(f?.sizeBytes).toBe(5)
  })

  it('超出 max_age_s 的不算', () => {
    const a = tmp()
    touch(join(a, 'old.sxm'), 400, NOW)
    expect(findLatestSaved([a], '.sxm', NOW, 300)).toBeNull()
  })

  it('后缀大小写不敏感', () => {
    const a = tmp()
    touch(join(a, 'X_0001.SXM'), 5, NOW)
    expect(findLatestSaved([a], '.sxm', NOW, 300)?.path).toBe(join(a, 'X_0001.SXM'))
    // 别的后缀不要
    touch(join(a, 'note.txt'), 1, NOW)
    expect(findLatestSaved([a], '.sxm', NOW, 300)?.path).toBe(join(a, 'X_0001.SXM'))
  })

  it('读不动的目录只跳过它自己，不是整趟失败', () => {
    const a = tmp()
    touch(join(a, 'ok.sxm'), 5, NOW)
    // 候选目录本来就是「可能在这儿」的清单 —— 其中一条不存在是常态
    expect(findLatestSaved([join(a, 'gone'), a], '.sxm', NOW, 300)?.path).toBe(join(a, 'ok.sxm'))
  })

  it('一个都没有：null，不是异常', () => {
    expect(findLatestSaved([tmp()], '.sxm', NOW, 300)).toBeNull()
    expect(findLatestSaved([], '.sxm', NOW, 300)).toBeNull()
  })
})

describe('sessionDir', () => {
  it('报的是目录：原样', () => {
    const a = tmp()
    expect(sessionDir(a)).toBe(a)
  })

  it('报的是「目录 + 文件名前缀」：取上级', () => {
    const a = tmp()
    // Nanonis 的 SessionPathGet 会报一个前缀，那个文件并不存在
    expect(sessionDir(join(a, 'Session_'))).toBe(a)
  })

  it('两个都不是目录：null —— 不存在的路径进不了 searched_dirs', () => {
    expect(sessionDir(join(tmp(), 'no', 'such', 'place'))).toBeNull()
    expect(sessionDir('')).toBeNull()
    expect(sessionDir('   ')).toBeNull()
  })
})

describe('existingDirs', () => {
  it('只留真目录，去重，保序', () => {
    const a = tmp()
    const b = tmp()
    writeFileSync(join(a, 'f.txt'), 'x')
    const out = existingDirs([a, join(a, 'nope'), join(a, 'f.txt'), b, a])
    expect(out).toHaveLength(2)
    expect(out[0]).toContain(a.split(/[\\/]/).pop() as string)
    expect(out[1]).toContain(b.split(/[\\/]/).pop() as string)
  })
})

describe('GetLatestScanFile', () => {
  it('默认候选目录：问仪器要 session 目录', async () => {
    const a = tmp()
    touch(join(a, 'x_0007.sxm'), 3, NOW)
    const { ctx, calls } = rig({ Util_SessionPathGet: [0, a] })
    const r = await makeGetLatestScanFile({ nowS: () => NOW }).execute(ctx, { max_age_s: 300 })
    // session 目录**问仪器**，不从属性里读 —— 那个属性从来没人写过（2026-06-29）
    expect(calls).toEqual([{ verb: 'Util_SessionPathGet', args: [] }])
    const d = r.data as { path: string; age_s: number; size_bytes: number }
    expect(d.path).toBe(join(a, 'x_0007.sxm'))
    expect(d.age_s).toBe(3)
    expect(d.size_bytes).toBe(1)
  })

  it('session 读不到：照样成功，候选表是空的', async () => {
    const { ctx } = rig({ Util_SessionPathGet: null })
    const r = await makeGetLatestScanFile({ nowS: () => NOW }).execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ path: null, searched_dirs: [], max_age_s: 300 })
  })

  it('默认候选**只有仪器报的那一个** —— 不编第二个目录', async () => {
    const a = tmp()
    const { ctx } = rig({ Util_SessionPathGet: [0, a] })
    const r = await makeGetLatestScanFile({ nowS: () => NOW }).execute(ctx, {})
    // 旧仓另外攒了三路，三路各自依赖本仓还没有的东西（D-FRAME-1）。
    // 编一个没人会创建的目录进来，只会让 searched_dirs 长出一行没发生过的搜索。
    expect((r.data as { searched_dirs: string[] }).searched_dirs).toEqual(existingDirs([a]))
  })

  it('一个都没找到：success，path 为 null —— 那是一个答案，不是一次失败', async () => {
    const a = tmp()
    const { ctx } = rig({})
    const r = await makeGetLatestScanFile({
      candidateDirs: () => Promise.resolve([a]),
      nowS: () => NOW,
    }).execute(ctx, { max_age_s: 120 })
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ path: null, searched_dirs: existingDirs([a]), max_age_s: 120 })
  })

  it('searched_dirs 只列真找过的目录', async () => {
    const a = tmp()
    const { ctx } = rig({})
    const r = await makeGetLatestScanFile({
      candidateDirs: () => Promise.resolve([a, join(a, 'ghost')]),
      nowS: () => NOW,
    }).execute(ctx, {})
    // 把一个不存在的目录列进去，等于报告了一次没发生过的搜索
    expect((r.data as { searched_dirs: string[] }).searched_dirs).toHaveLength(1)
  })

  it('max_age_s 缺省 300', async () => {
    const a = tmp()
    touch(join(a, 'x.sxm'), 299, NOW)
    touch(join(a, 'y.sxm'), 301, NOW)
    const { ctx } = rig({})
    const r = await makeGetLatestScanFile({
      candidateDirs: () => Promise.resolve([a]),
      nowS: () => NOW,
    }).execute(ctx, {})
    expect((r.data as { path: string }).path).toBe(join(a, 'x.sxm'))
  })
})

// ─────────────────────────────────────────────────────────────────────────
// CreateZCtrlPreset
// ─────────────────────────────────────────────────────────────────────────

describe('CreateZCtrlPreset', () => {
  const run = (
    params: Record<string, unknown>,
    store = new PresetStore(),
  ): Promise<SkillResultLike> =>
    makeCreateZCtrlPreset({ store }).execute(rig({}).ctx, params)

  it('存下来之后回给模型的是**存储里的值**重新解析出的来历行', async () => {
    const r = await run({ name: 'gentle', p_gain: '3p', i_gain: '180n' })
    expect(r.success).toBe(true)
    const d = r.data as { preset: string; stored: object; trace: string[]; message: string }
    expect(d.preset).toBe('gentle')
    expect(d.stored).toEqual({ name: 'gentle', p_gain: '3p', i_gain: '180n' })
    expect(d.trace).toEqual([
      "p_gain = 3pm ← 自定义参数组 'gentle'",
      "i_gain = 180nm/s ← 自定义参数组 'gentle'",
      'time_constant_s = 16.6667us ← 由 P/I 导出',
      'setpoint_a = 未配置(保持当前值,不下发)',
    ])
    expect(d.message).toBe(
      "参数组 'gentle' 已保存。存储里现在的值是:\n" +
        d.trace.join('\n') +
        "\n\n用 ApplyZCtrlPreset('gentle') 应用它。",
    )
  })

  it('带设定点：第四行说出它的来历', async () => {
    const r = await run({ name: 'g', p_gain: '3p', i_gain: '180n', setpoint_a: '150p' })
    expect((r.data as { trace: string[] }).trace[3]).toBe(
      "setpoint_a = 150pA ← 自定义参数组 'g'",
    )
  })

  it('一个技能调用不碰仪器', async () => {
    const { ctx, calls } = rig({})
    await makeCreateZCtrlPreset({ store: new PresetStore() }).execute(ctx, {
      name: 'g', p_gain: '3p', i_gain: '180n',
    })
    expect(calls).toEqual([])
  })

  // ── 拒绝：判据在内核，这里钉的是「那句话原样到得了模型」 ──
  it.each([
    ['裸数字', { name: 'g', p_gain: '3', i_gain: '180n' }, /前缀不可省略/],
    ['保留名', { name: 'approach', p_gain: '3p', i_gain: '180n' }, /是保留名/],
    ['没名字', { p_gain: '3p', i_gain: '180n' }, /参数组必须有名字。/],
    ['缺 i_gain', { name: 'g', p_gain: '3p' }, /缺少 i_gain/],
    ['超范围', { name: 'g', p_gain: '1m', i_gain: '180n' }, /拒绝写入,不会自动夹到边界/],
    ['时间常数不合理', { name: 'g', p_gain: '1u', i_gain: '1p' }, /导出的时间常数/],
  ])('%s：拒，一个字都不改', async (_why, params, want) => {
    const r = await run(params)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(want)
    expect(r.data).toBeUndefined()
  })

  it('档名重名：拒（档名已经能当参数组名用）', async () => {
    const store = new PresetStore(() => ['highres', 'survey'])
    const r = await run({ name: 'HighRes', p_gain: '3p', i_gain: '180n' }, store)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/与扫描档位表里的档名重名/)
  })

  it('同名默认拒，overwrite=true 才换', async () => {
    const store = new PresetStore()
    const p = { name: 'g', p_gain: '3p', i_gain: '180n' }
    expect((await run(p, store)).success).toBe(true)
    const dup = await run(p, store)
    expect(dup.success).toBe(false)
    expect(dup.error).toMatch(/已存在。要替换它请显式传 overwrite=true。/)
    const over = await run({ ...p, i_gain: '200n', overwrite: true }, store)
    expect(over.success).toBe(true)
    expect(store.list()).toEqual([{ name: 'g', p_gain: '3p', i_gain: '200n' }])
  })

  it('overwrite 只认真正的 true', async () => {
    const store = new PresetStore()
    const p = { name: 'g', p_gain: '3p', i_gain: '180n' }
    await run(p, store)
    expect((await run({ ...p, overwrite: 'yes' }, store)).success).toBe(false)
    expect((await run({ ...p, overwrite: 1 }, store)).success).toBe(false)
  })

  it('不是 PresetRejected 的异常照抛 —— 别把一个 bug 伪装成一次拒绝', async () => {
    const store = new PresetStore(() => {
      throw new TypeError('档位表炸了')
    })
    await expect(run({ name: 'g', p_gain: '3p', i_gain: '180n' }, store)).rejects.toThrow(TypeError)
  })
})
