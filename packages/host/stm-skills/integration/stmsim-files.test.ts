/**
 * 真 stmsim **写出来的** `.sxm` / `.dat`：过我们的解析器，再入视觉档案。
 *
 * ## 这条缝以前没人走过
 *
 * | 缝 | 以前谁走过 |
 * |---|---|
 * | 模拟器写出 `.sxm` → `readSxm` | `tip-spectro-assess.test.ts` 让 `AssessAtomicPhase` 读过一次，但只看结论，没人看通道表和数据块本身 |
 * | 模拟器写出 `.dat` → `readDat` | **没有任何一条。** `spectroscopy.test.ts` 带 `save_basename` 跑过 `AcquireSTS`，只核对 TCP 回包，从不打开落盘的那个文件 |
 * | 解析结果 → `FrameArchive`（落盘、重开） | 单测与金样，输入是合成的字节 |
 *
 * 单测与金样喂给解析器的字节是按格式说明自己拼的。一个「在两套自己造的输入上都对」的解析器，
 * 仍然可以在真东西上一次都对不上 —— D-READBACK-1 的同一条教训。
 *
 * ## 验什么、不验什么
 *
 * 验**形状与一致性**：
 * - 请求的像素数、量程、扫点在文件头里原样出现；
 * - `.sxm` 的数据块字节数恰等于解析器读出的帧数 × 像素数 × 4 —— 数据块一旦错位，症状是后面每个通道
 *   都变成另一路信号，而图看着完全正常；
 * - 同一次采集走 TCP 回包与走落盘文件，读到的是同一条谱；
 * - 入档的值与解析出来的值逐元素相同，重开档案后还在。
 *
 * **不验数值本身**：Z 形貌、电流噪声是模拟器的物理，STM-Bench 换版本会变（`4a0014b` 起重写了扫描渲染）。
 * 也不钉通道表里有几路 —— 那是模拟器的配置；只要求 `Z` 在，因为下游默认读它。
 *
 * 模拟器由 globalSetup 起在 16501–16504，所以这里 `spawn: false`。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context, SystemPrompt } from 'dsh-spm-compat'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { emptyHardwareState, slowCallFrom, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { readDat, readSxm, sxmOrientedFrames, type DatFile } from 'dsh-spm-nanonis-files'
import { FrameArchive, entrySummary, isFrameId } from 'dsh-spm-visual-memory'
import { afterEach, describe, expect, it } from 'vitest'
import { IMPLEMENTED } from '../src/l0/index.js'
import { ConfigureSTS, ConfigureSTSTiming, makeAcquireSTS } from '../src/l0/spectroscopy.js'

const PORTS = [16501, 16502, 16503, 16504]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

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
  const d = mkdtempSync(join(tmpdir(), 'dsh-files-e2e-'))
  dirs.push(d)
  return d
}

interface Instrument {
  call(method: string, args: readonly unknown[], opts?: { timeoutMs?: number }): Promise<SkillCallRecord>
}

/**
 * 起一个只挂了仪器的 host，造一个能真分发子技能的 `SkillContext`。
 *
 * `runSkill` 走注册表 —— `ScanAt` 是组合技能，它的全部价值在子技能的正门，换成假的就绕开了要测的路。
 * `slowCall` 接到传输层的按调用超时上，`AcquireSTS` 要靠它拿到 recv 预算。
 */
function instrument(timeoutMs = 10_000): Promise<SkillContext> {
  const ctx = new Context()
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      const inst = c.instrument as Instrument
      const S0 = emptyHardwareState('stmsim')
      const safeCall = (m: string, ...a: unknown[]): Promise<SkillCallRecord> => inst.call(m, a)
      const budgeted = (m: string, recvTimeoutS: number, ...a: unknown[]): Promise<SkillCallRecord> =>
        inst.call(m, a, { timeoutMs: Math.ceil(recvTimeoutS * 1000) })
      const self = {
        signal: new AbortController().signal,
        safeCall,
        emergencyCall: safeCall,
        slowCall: slowCallFrom(safeCall, budgeted),
        runSkill: (name: string, params: Readonly<Record<string, unknown>>) => {
          const skill = IMPLEMENTED[name]
          if (skill === undefined) return Promise.resolve({ success: false, error: `注册表里没有 ${name}` })
          return skill.execute(self, params)
        },
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        state: () => S0,
        refreshState: () => Promise.resolve(S0),
        markers: { emit: () => {} },
        depth: 0,
        owner: 'integration',
        rootCallId: 'stmsim-files',
        approvalSource: 'operator',
      } as unknown as SkillContext
      resolve(self)
    })
  })
}

/** 读仪器的一个标量（独立于被测的文件）。 */
async function readScalar(ctx: SkillContext, verb: string): Promise<number> {
  return Number(((await ctx.safeCall(verb)).values ?? [])[0])
}

/** 秒级的一帧：32 px × 0.05 s/线 × 双向（同 `tip-spectro-assess.test.ts` 的 `FAST`）。 */
const FAST = { pixels: 32, line_time_s: 0.05 }
const PIXELS = 32
const FIELD_NM = 50

/** 扫一帧 → 存盘 → 报路径。**任何一步没成，这条测试就没有输入**，所以逐步断言。 */
async function scanAndSave(ctx: SkillContext): Promise<{ path: string; startedMs: number }> {
  const startedMs = Date.now()
  const scan = await IMPLEMENTED['ScanAt']!.execute(ctx, {
    center_x_m: 0,
    center_y_m: 0,
    size_m: FIELD_NM * 1e-9,
    ...FAST,
  })
  expect(scan.error ?? '', 'ScanAt').toBe('')
  const save = await IMPLEMENTED['SaveScan']!.execute(ctx, {})
  expect(save.error ?? '', 'SaveScan').toBe('')
  const latest = await IMPLEMENTED['GetLatestScanFile']!.execute(ctx, { max_age_s: 600 })
  expect(latest.error ?? '', 'GetLatestScanFile').toBe('')
  const path = (latest.data as { path?: unknown } | undefined)?.path
  expect(typeof path === 'string' && path.toLowerCase().endsWith('.sxm'), `拿不到 .sxm：${String(path)}`).toBe(true)
  // 会话目录里还有别的测试留下的 .sxm：这份必须是这一趟写下来的
  expect(statSync(path as string).mtimeMs, '这份 .sxm 不是这一趟写的').toBeGreaterThanOrEqual(startedMs - 1000)
  return { path: path as string, startedMs }
}

/** 一份只属于这个文件的短扫掠：别的测试配的是另一组数，读到别人的 `.dat` 一眼就能认出来。 */
const STS = { start_v: -0.045, end_v: 0.035, num_points: 14 }
/** 文件名前缀同理：模拟器把它拼进落盘的文件名。 */
const BASENAME = 'dsh-spm-files'

/** 配一条短扫掠 → 采集 → 报 `.dat` 的路径与解析结果。 */
async function acquireAndRead(
  ctx: SkillContext,
): Promise<{ path: string; reply: Record<string, unknown>; dat: DatFile }> {
  const cfg = await ConfigureSTS.execute(ctx, STS)
  expect(cfg.error ?? '', 'ConfigureSTS').toBe('')
  const timing = await ConfigureSTSTiming.execute(ctx, {
    z_avg_time_s: 0,
    init_settling_s: 0.001,
    max_slew_rate_v_s: 10,
    settling_s: 0.001,
    integration_s: 0.001,
  })
  expect(timing.error ?? '', 'ConfigureSTSTiming').toBe('')

  const startedMs = Date.now()
  const r = await makeAcquireSTS().execute(ctx, { save_basename: BASENAME })
  expect(r.error ?? '', 'AcquireSTS').toBe('')
  const reply = (r.data ?? {}) as Record<string, unknown>
  expect(reply['spectrum_parsed'], 'TCP 回包里的谱没解开').toBe(true)

  // 不是「找到一份 .dat 就行」：它必须是这一趟写下来的，文件名带着我们给的前缀
  const path = reply['path']
  expect(typeof path, 'AcquireSTS 没报出 .dat 的路径').toBe('string')
  expect(basename(path as string)).toMatch(new RegExp(`^${BASENAME}\\d+\\.dat$`))
  expect(statSync(path as string).mtimeMs, '这份 .dat 不是这一趟写的').toBeGreaterThanOrEqual(startedMs - 1000)

  const dat = readDat(new Uint8Array(readFileSync(path as string)), path as string)
  return { path: path as string, reply, dat }
}

/** 逐元素的最大相对差（分母取 x 的绝对值，下限防 0）。 */
function maxRelativeDiff(x: ArrayLike<number>, y: ArrayLike<number>): number {
  expect(y.length).toBe(x.length)
  let worst = 0
  for (let i = 0; i < x.length; i++) {
    worst = Math.max(worst, Math.abs((x[i] as number) - (y[i] as number)) / Math.max(Math.abs(x[i] as number), 1e-30))
  }
  return worst
}

/** 逐元素的最大绝对差。 */
function maxAbsDiff(x: ArrayLike<number>, y: ArrayLike<number>): number {
  expect(y.length).toBe(x.length)
  let worst = 0
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs((x[i] as number) - (y[i] as number)))
  return worst
}

describe('stmsim 写出的 .sxm', () => {
  it('readSxm 读得动：像素数、量程、通道表与数据块字节数，都与请求和文件头自洽', async () => {
    const ctx = await instrument()
    // 文件头里的偏压与设定值，应当就是仪器此刻的：先独立读一次
    const biasV = await readScalar(ctx, 'Bias_Get')
    const setpointA = await readScalar(ctx, 'ZCtrl_SetpntGet')
    const { path } = await scanAndSave(ctx)

    const bytes = readFileSync(path)
    const scan = readSxm(new Uint8Array(bytes), path)

    // ① 请求的是 32×32 px、50 nm，文件头原样给出
    expect(scan.header.scan_pixels).toEqual([PIXELS, PIXELS])

    // ② 通道表：头里声明了几路，解析器就交出几路；`Z` 在（下游默认读它）
    const names = [...(scan.header.channel_names ?? [])]
    expect(names.length).toBeGreaterThan(0)
    expect(Object.keys(scan.channels)).toEqual(names)
    expect(names).toContain('Z')
    expect(scan.header.channel_directions?.length).toBe(names.length)

    // ③ 数据块的字节数恰等于「读出来的帧数 × 像素数 × 4」。差一帧或多一帧，
    //    说明解析器消费的字节与写出器写下的不是同一张账。头的结束记号是 0x1A 0x04。
    const dataStart = bytes.indexOf(Buffer.from([0x1a, 0x04])) + 2
    expect(dataStart, '找不到头的结束记号').toBeGreaterThan(2)
    let frames = 0
    for (const ch of Object.values(scan.channels)) {
      for (const pass of [ch.forward, ch.backward]) {
        if (pass === undefined) continue
        frames += 1
        // 每一帧都是 32×32，而且扫完的帧里没有缺点位
        expect([pass.rows, pass.cols]).toEqual([PIXELS, PIXELS])
        expect(pass.data.every(Number.isFinite), '扫完的帧里有非有限值').toBe(true)
      }
    }
    expect(frames).toBeGreaterThan(0)
    expect(bytes.length - dataStart).toBe(frames * PIXELS * PIXELS * 4)

    // ④ 单位不能错一个数量级：Z 是米，50 nm 视野上的起伏远小于 1 µm，而且不是一张平的
    for (const pass of [scan.channels['Z']!.forward!, scan.channels['Z']!.backward!]) {
      const span = Math.max(...pass.data) - Math.min(...pass.data)
      expect(span).toBeGreaterThan(0)
      expect(Math.max(...pass.data.map(Math.abs))).toBeLessThan(1e-6)
    }

    // ⑤ 定向、尺度、偏压、设定值，与请求和仪器此刻的读数一致
    const o = sxmOrientedFrames(scan, 'Z')
    expect([o.forward?.rows, o.forward?.cols]).toEqual([PIXELS, PIXELS])
    expect([o.backward?.rows, o.backward?.cols]).toEqual([PIXELS, PIXELS])
    expect(o.width_nm).toBeCloseTo(FIELD_NM, 6)
    expect(o.height_nm).toBeCloseTo(FIELD_NM, 6)
    expect(o.nm_per_px).toBeCloseTo(FIELD_NM / PIXELS, 9)
    expect(['up', 'down']).toContain(o.scan_dir)
    expect(o.unit).toBe('m')
    expect(o.bias_v).toBeCloseTo(biasV, 6)
    expect(Math.abs((o.setpoint_a as number) / setpointA - 1)).toBeLessThan(1e-6)
  }, 60_000)

  it('addScan 入档：每个通道每个方向的值逐元素相同，重开档案后仍在', async () => {
    const ctx = await instrument()
    const { path } = await scanAndSave(ctx)
    const scan = readSxm(new Uint8Array(readFileSync(path)), path)

    const root = tmp()
    const archive = new FrameArchive(root)
    const entry = archive.addScan(1, path)

    expect(isFrameId(entry.fid)).toBe(true)
    expect(entry.kind).toBe('s')
    expect([entry.nx, entry.ny]).toEqual([PIXELS, PIXELS])
    expect(entry.channels).toEqual(Object.keys(scan.channels))
    expect(entry.units['Z']).toBe('m')
    expect(entry.channels).toContain(entry.default_channel)
    const summary = entrySummary(entry)
    expect(summary).toMatchObject({
      frame: entry.fid,
      turn: 1,
      kind: 'scan',
      channels: entry.channels,
      size_px: [PIXELS, PIXELS],
      field_nm: [FIELD_NM, FIELD_NM],
    })
    expect(summary['nm_per_px']).toBeCloseTo(FIELD_NM / PIXELS, 5)

    // 归档的是「定向之后」的值（行 0 = 帧顶，backward 去掉镜像）：与解析器交出来的逐元素相同，
    // 只差一次 float32 舍入。
    const sameValues = (a: FrameArchive, label: string): void => {
      const e = a.get(entry.fid)
      for (const channel of e.channels) {
        const o = sxmOrientedFrames(scan, channel)
        for (const [direction, mat] of [['forward', o.forward], ['backward', o.backward]] as const) {
          const archived = a.values(e, channel, direction)
          expect(maxAbsDiff(archived, Float32Array.from(mat!.data)), `${label} ${channel}/${direction}`).toBe(0)
        }
      }
    }
    sameValues(archive, '入档时')

    // 重开：索引、元数据、值都从盘上读回来
    const reopened = new FrameArchive(root)
    expect(reopened.loadWarnings).toEqual([])
    expect(reopened.has(entry.fid)).toBe(true)
    expect(reopened.get(entry.fid)).toEqual(entry)
    sameValues(reopened, '重开后')
  }, 60_000)
})

describe('stmsim 写出的 .dat', () => {
  it('AcquireSTS(save_basename) 的 data.path 指向的文件，readDat 读得动，且与 TCP 回包是同一条谱', async () => {
    const ctx = await instrument()
    const { reply, dat } = await acquireAndRead(ctx)

    // ① 文件头：这是一条偏压谱，请求的扫点原样出现
    expect(String(dat.header['Experiment']).toLowerCase()).toContain('spectroscopy')
    expect(Number(dat.header['Bias Spectroscopy>Sweep Start (V)'])).toBeCloseTo(STS.start_v, 9)
    expect(Number(dat.header['Bias Spectroscopy>Sweep End (V)'])).toBeCloseTo(STS.end_v, 9)
    expect(Number(dat.header['Bias Spectroscopy>Num Pixel'])).toBe(STS.num_points)

    // ② 列：至少偏压轴加一路电流，等长，都是有限数
    const names = Object.keys(dat.columns)
    expect(names.length).toBeGreaterThanOrEqual(2)
    for (const name of names) {
      const col = dat.columns[name] as Float64Array
      expect(col.length, `${name} 的长度`).toBe(STS.num_points)
      expect(col.every(Number.isFinite), `${name} 里有非有限值`).toBe(true)
    }

    // ③ 第一列是扫描轴：恰好覆盖请求的区间，严格递增
    const axis = dat.columns[names[0] as string] as Float64Array
    expect(names[0]).toMatch(/bias/i)
    expect(axis[0]).toBeCloseTo(STS.start_v, 9)
    expect(axis[axis.length - 1]).toBeCloseTo(STS.end_v, 9)
    for (let i = 1; i < axis.length; i++) expect(axis[i], `轴在第 ${i} 点不递增`).toBeGreaterThan(axis[i - 1] as number)

    // ④ 同一次采集走两条路：TCP 回包里的偏压轴和电流，与落盘文件里的是同一批数
    //    （文件按 %.6E 写，所以差在 1e-6 量级）。第三列两边不同名，不在这里比。
    expect(maxRelativeDiff(reply['voltage'] as number[], axis)).toBeLessThan(1e-5)
    expect(maxRelativeDiff(reply['current'] as number[], dat.columns['Current (A)'] as Float64Array)).toBeLessThan(1e-5)
  }, 60_000)

  it('addSpectrum 入档：每一列逐元素相同，重开档案后仍在', async () => {
    const ctx = await instrument()
    const { path, dat } = await acquireAndRead(ctx)

    const root = tmp()
    const archive = new FrameArchive(root)
    const entry = archive.addSpectrum(1, path)

    const names = Object.keys(dat.columns)
    expect(isFrameId(entry.fid)).toBe(true)
    expect(entry.kind).toBe('d')
    expect(entry.nx).toBe(STS.num_points)
    expect(entry.channels).toEqual(names)
    const summary = entrySummary(entry)
    expect(summary).toMatchObject({
      frame: entry.fid,
      turn: 1,
      kind: 'spectrum',
      columns: names,
      n_points: STS.num_points,
    })
    expect(String(summary['experiment']).toLowerCase()).toContain('spectroscopy')

    // 归档的是 float64 原样：与 readDat 交出来的逐元素完全相同
    const sameColumns = (a: FrameArchive, label: string): void => {
      const e = a.get(entry.fid)
      for (const name of names) {
        expect(maxAbsDiff(a.column(e, name), dat.columns[name] as Float64Array), `${label} ${name}`).toBe(0)
      }
    }
    sameColumns(archive, '入档时')

    const reopened = new FrameArchive(root)
    expect(reopened.loadWarnings).toEqual([])
    expect(reopened.has(entry.fid)).toBe(true)
    expect(reopened.get(entry.fid)).toEqual(entry)
    sameColumns(reopened, '重开后')
  }, 60_000)
})
