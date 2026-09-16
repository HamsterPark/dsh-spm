/**
 * 批 4c 十二个技能对 `spec/golden/paper_data.json` 的**逐格**比对（DoD ③ + ⑤）。
 *
 * ## 这一份比两样东西
 *
 * 1. **整棵 `SkillResult`**（`success` / `error` / `summary` / `data`），逐叶子；
 * 2. **技能写出去的那个 `.npy`**（金样里的 `output`）。
 *
 * 第二样是批 4a 那份没有的。这一族技能的 `data` 里只有形状与几个标量，
 * 真正的产物是磁盘上那张图 —— 只比 `data` 等于**只比收据不比货**：
 * 一个把 `result[i]` 写成 `result[i-1]` 的 destripe，
 * `corrected_image_shape` 与 `stripes_removed` 一个字都不会变。
 *
 * ## 容差从**被测函数自己导出的常量**来，一个字面量都没有
 *
 * | 字段 | 容差 | 在哪 |
 * |---|---|---|
 * | 掩膜 / 计数 / 下标 / 切边 / 路径 / 措辞 | **0** | 见下面 `EXACT` |
 * | `rms_*` / `noise_estimate` / `roughness_map` / `confidence` | `STD_REL_TOL(n)` | `paper-data.ts` |
 * | `plane_coefficients` / 多项式与逐行拟合的输出 | `lstsqRelTol(κ)` | κ 随金样录在 `condition_numbers` |
 * | `phase_diff` | `xcorrPhaseAbsTol(n)`，**绝对** | `numerics/fft.ts`（D-NUM-21 一族） |
 * | `correlation_error` | 在**平方**上，`xcorrErrorSqAbsTol(n) · xcorrErrorSqScale(w²)` | `paper-data.ts` 的推广 |
 *
 * ## 两处**刻意**对不上的地方，在这里归一化掉（各有一条专门的测试）
 *
 * | | 为什么 |
 * |---|---|
 * | `invalid regions JSON: …` / `Failed to load current trace: …`（JSON 那一支） | Python 的 `json` 与 V8 的 `JSON.parse` 措辞完全不同，而判据是前半句 |
 * | `读不了 X: …` | Python 的异常**类名**（`FileNotFoundError` / `ValueError`）+ reader 的措辞 |
 * | `method: "cnn"` | 旧仓报的是**请求**的那一条（D-JUMP-*），本仓报真的跑了哪一条 |
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { diffTree, formatMismatches, scalesOf, toGolden } from 'dsh-spm-vision'
import { decodeNpy, lstsqRelTol, xcorrErrorSqAbsTol, xcorrPhaseAbsTol } from 'dsh-spm-numerics'
import { encodeNpyFrame, pickImageChannel } from 'dsh-spm-kernel'
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { PAPER_DATA, STD_REL_TOL, xcorrErrorSqScale } from './paper-data.js'
import { PAPER_IMAGE } from './paper-image.js'
import { PAPER_CROP, statisticalDetect } from './paper-crop.js'
import { makeLoadScanFrameFromFile, ParseRegions, ComputeDriftVector } from './scan-frame-offline.js'
import { loadImage2d } from './paper-common.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/paper_data.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const COND = GOLDEN['condition_numbers'] as Record<string, number>
const N_XCORR = 32 * 32

let TMP = ''
let LoadScanFrameFromFile: Skill

const SKILLS = (): Record<string, Skill> => ({
  ...PAPER_DATA,
  ...PAPER_IMAGE,
  ...PAPER_CROP,
  ParseRegions,
  ComputeDriftVector,
  LoadScanFrameFromFile,
})

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'paper-golden-')).replaceAll('\\', '/')
  for (const [key, b64] of Object.entries(GOLDEN['files'] as Record<string, string>)) {
    // 扩展名从金样的键推 —— 导出器按 `<key><suffix>` 落盘，而路径里带着那个后缀。
    const ext = EXT_OF[key] ?? '.npy'
    writeFileSync(`${TMP}/${key}${ext}`, Buffer.from(b64, 'base64'))
  }
  mkdirSync(`${TMP}/frames`, { recursive: true })
  // 墙钟钉死成导出器用的那个数（`int(1_700_000_000 * 1000) & 0xFFFFFFFF`）——
  // 于是两侧算出来的文件名是同一个，而**撞名那一格**（`_01`）也照样走得到。
  LoadScanFrameFromFile = makeLoadScanFrameFromFile({
    framesDir: () => `${TMP}/frames`,
    stamp: () => ((1_700_000_000 * 1000) >>> 0).toString(16),
  })
})

/** 哪个键是哪种文件 —— 导出器那边由 `npy_file` / `sxm_file` / `dat_file` 决定。 */
const EXT_OF: Record<string, string> = {
  topo: '.sxm', fwd_only: '.sxm', current_only: '.sxm', trace: '.dat',
}

/** 金样里的 `<tmp>` 换成本次运行的临时目录。 */
function realPath(v: unknown): unknown {
  if (typeof v === 'string') return v.replaceAll('<tmp>', TMP)
  if (Array.isArray(v)) return v.map(realPath)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = realPath(x)
    return out
  }
  return v
}

/** 与导出器同一组归一化：临时目录、分隔符、操作系统那句错、两个解析器的异常文本。 */
function normalize(v: unknown): unknown {
  if (typeof v === 'string') {
    let s = v.replaceAll(TMP, '<tmp>').replaceAll(TMP.replaceAll('/', '\\'), '<tmp>')
    if (s.includes('<tmp>')) s = s.replaceAll('\\', '/')
    return s
      .replace(/(ENOENT|EISDIR|EACCES|EPERM|EBUSY)[\s\S]*/, '<oserror>')
      .replace(/\[WinError [\s\S]*/, '<oserror>')
      .replace(/\[Errno [\s\S]*/, '<oserror>')
      .replace(/(invalid regions JSON: )[\s\S]*/, '$1<json-error>')
      .replace(/(Failed to load current trace: )(?!spectrum file not found)[\s\S]*/, '$1<json-error>')
      .replace(/(读不了 .*?: )[\s\S]*/, '$1<read-error>')
  }
  if (Array.isArray(v)) return v.map(normalize)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = normalize(x)
    return out
  }
  return v
}

/**
 * 摆成旧仓 `SkillResult` 的形状。
 *
 * ⚠️ 两个缺省值**不一样**：旧仓 `error` 的缺省是空串（「没有错误」），
 * `summary` 的缺省是 `None`（「这个技能没写一句话」）。
 */
function asGolden(r: SkillResultLike): Record<string, unknown> {
  return { success: r.success, error: r.error ?? '', summary: r.summary ?? null, data: r.data ?? {} }
}

/**
 * 字段路径 → 容差。**没列在这里的一律 0**（掩膜、计数、下标、路径、措辞）。
 *
 * ⚠️ `.data.confidence` 那一条带一个**相消放大系数**，而它只有从数据里才算得出来：
 *
 * ```
 * z = |mean₂ − mean₁| / std
 * ```
 *
 * 这一族的曲线是「1e-10 上下抖 1e-13」，两个均值几乎相等，它们的**差**
 * 把各自的舍入放大了 `(|m₁| + |m₂|) / |m₂ − m₁|` 倍 —— `json_flat` 那一格
 * 是 **2.36e4**。金样把这个系数按格录在 `atom_jump_facts` 里（导出器算的），
 * 于是这条容差是**推出来的**，不是「刚好让我这版通过的那个数」。
 * 实测 3.0e-12，容差 2.2e-10，占比 1.4%。
 */
function tolFor(path: string, key: string): number {
  const p = path.replace(/\[\d+\]/g, '')
  if (p === '.data.rms_before' || p === '.data.rms_after' || p === '.data.noise_estimate') {
    return STD_REL_TOL(32 * 32)
  }
  if (p === '.data.roughness_map' || p === '.data.min_roughness') return STD_REL_TOL(8 * 8)
  if (p === '.data.confidence') {
    const f = (GOLDEN['atom_jump_facts'] as Record<string, { n: number; cancellation: number }>)[key]
    if (f === undefined) return STD_REL_TOL(80)
    return STD_REL_TOL(f.n / 2) * f.cancellation
  }
  if (p === '.data.plane_coefficients') return lstsqRelTol(COND['plane_32x32'] as number)
  if (p === '.data.tolerance') return 0
  return 0
}

/**
 * 逐格比。返回还对不上的地方。
 *
 * `correlation_error` 与 `phase_diff` 走各自的绝对容差（见文件抬头那张表），
 * 所以它们**先从树里摘出来**单独比 —— 这两条是「绝对」，而 `diffTree` 的
 * 归一化是「按字段的全批最大值」，两种规矩混在一起会让紧的那一条形同虚设。
 */
function expectCase(
  name: string, key: string, got: SkillResultLike, want: any, scales: Map<string, number>,
): void {
  const a = normalize(toGolden(asGolden(got))) as Record<string, any>
  const w = want as Record<string, any>
  const ms = diffTree(a, w, 0, scales).filter((m) => {
    const p = m.path.replace(/\[\d+\]/g, '')
    // ⚠️ **刻意不同的那一处**：`method` 报的是真的跑了哪一条，不是请求的那一条。
    // 它有自己的两条测试（下面的 D-JUMP-1），不是靠这里让它过去。
    if (name === 'DetectAtomJump' && p === '.data.method') return false
    if (typeof m.actual !== 'number' || typeof m.want !== 'number') return true
    if (p === '.data.correlation_error') {
      const tol = xcorrErrorSqAbsTol(N_XCORR) * xcorrErrorSqScale(m.want * m.want)
      return !(Math.abs(m.actual * m.actual - m.want * m.want) <= tol)
    }
    if (p === '.data.phase_diff') return !(Math.abs(m.actual - m.want) <= xcorrPhaseAbsTol(N_XCORR))
    const tol = tolFor(m.path, key)
    const scale = Math.max(scales.get(p) ?? 0, Math.abs(m.want))
    return !(Math.abs(m.actual - m.want) <= tol * scale)
  })
  expect(ms.length === 0 || `${name}/${key}：${formatMismatches(ms)}`).toBe(true)
}

/**
 * 比技能**写出去的那个文件**。金样里的 `output` 是 `np.load` 读回来的二维表。
 *
 * ## ⚠️ 尺度取的是**输入**的量级，不是输出的
 *
 * 这一族的输出大多是**残差**（图减掉背景），而拟合误差是按**输入**的量级走的。
 * `LevelLines_Median/poly1` 那一格最典型：输入在 1e-9 上，残差只剩 1e-13 ——
 * 按残差归一等于要求 `1e4 × lstsqRelTol` 的精度，那是做不到的，
 * 而**做不到的容差不是严格，是一条迟早要被改松的断言**。
 *
 * 所以 `scale = max(|输入的峰值|, |这一格的期望值|)`。输入是从技能自己的
 * `image_path` 读回来的**同一份字节**（不是重建的），见 `paper-common.ts`。
 */
function expectOutput(
  name: string, key: string, data: any, want: unknown, tol: number, inputScale: number,
  field = 'output_path',
): void {
  const path = realPath((data ?? {})[field]) as string | null
  expect(`${name}/${key} ${field}`).toBe(
    typeof path === 'string' && path !== '' ? `${name}/${key} ${field}` : `${name}/${key} 没有写出文件`,
  )
  const got = decodeNpy(new Uint8Array(readFileSync(path as string)))
  const rows = got.shape[0] as number
  const cols = got.values.length / rows
  const wantRows = want as number[][]
  expect([name, key, rows, cols]).toEqual([name, key, wantRows.length, (wantRows[0] as number[]).length])
  const scale = inputScale
  const bad: string[] = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const a = got.values[r * cols + c] as number
      const b = (wantRows[r] as number[])[c] as number
      if (!(Math.abs(a - b) <= tol * Math.max(scale, Math.abs(b)))) {
        bad.push(`[${r}][${c}] ${a} ≠ ${b}`)
        if (bad.length > 6) break
      }
    }
    if (bad.length > 6) break
  }
  expect(bad.length === 0 || `${name}/${key} 写出的 .npy：${bad.join(' · ')}`).toBe(true)
}

/** 输出文件的容差 —— 每个技能一条，理由在各自的抬头。 */
const OUTPUT_TOL: Record<string, (key: string) => number> = {
  // RANSAC 之后每个像素是 `z − 平面` —— 平面的误差由 `lstsqRelTol(κ)` 定，
  // 而残差的尺度是整幅的峰谷，于是这一条与 `plane_coefficients` 同一个数。
  SubtractPlane_RANSAC: () => lstsqRelTol(COND['plane_32x32'] as number),
  // 逐行平场：`median` 那一档是一次减法 ⇒ **0**；`poly` 那一档走 `polyfit`。
  // ⚠️ `median` 那一档**必须**是 0：两种中位数写法只差最后一位，而一条
  // `lstsqRelTol` 量级（1.8e-13）的相对容差会把那一位整个吞掉 ——
  // 实测把 `npMedian` 换成 `percentile(50)`，带容差时 114 条全绿。
  LevelLines_Median: (key) =>
    key.startsWith('median') || key === 'unknown_method'
      ? 0
      : lstsqRelTol(COND[key === 'poly3' ? 'vander_32_3' : 'vander_16_1'] as number),
  SubtractPoly2D: (key) =>
    lstsqRelTol(COND[key === 'order11' ? 'poly2d_24x24_1_1'
      : key === 'order31' ? 'poly2d_24x24_3_1' : 'poly2d_24x24_2_2'] as number),
  // 去条纹的输出要么是输入里某一行原样、要么是两行的一次线性插值 ⇒ **0**。
  Destripe_MorphOpen: () => 0,
  // 切图是**切片** ⇒ 每个数原样搬过来 ⇒ **0**。
  AutoCrop_UnscannedRegion: () => 0,
  // 可分离高斯：两轴各一次一维相关，照抄了 scipy 的轴序与累加顺序。
  Denoise_AE: () => 16 * Number.EPSILON,
}

/** 这一格的**输入**有多大 —— 拟合误差按它走（见 `expectOutput` 的抬头）。 */
function inputScale(params: Record<string, unknown>): number {
  if (params['image_path'] === undefined) return 0
  const m = loadImage2d(String(params['image_path']))
  let s = 0
  for (const v of m.data) if (Math.abs(v) > s) s = Math.abs(v)
  return s
}

/** 一个只答固定桩的 `SkillContext`（`ComputeDriftVector` 用）。 */
function fakeCtx(stub: Record<string, unknown>, calls: SkillCallRecord[]): SkillContext {
  const safeCall = async (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    const entry = stub[method]
    let rec: SkillCallRecord
    if (entry === undefined) rec = { method, args, error: `no stub for ${method}` }
    else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'error' in entry) {
      rec = { method, args, error: String((entry as Record<string, unknown>)['error']) }
    } else rec = { method, args, values: entry as readonly unknown[] }
    calls.push(rec)
    return rec
  }
  return { safeCall } as unknown as SkillContext
}

// ──────────────────────────────────────────────────────────────────────────

describe('批 4c —— 技能级差分（逐格对旧仓）', () => {
  for (const name of [
    'SubtractPlane_RANSAC', 'LevelLines_Median', 'FindEmptySpot', 'CorrectDrift_XCorr',
    'SubtractPoly2D', 'Destripe_MorphOpen', 'AutoCrop_UnscannedRegion', 'Denoise_AE',
    'DetectAtomJump', 'LoadScanFrameFromFile', 'ParseRegions',
  ] as const) {
    describe(name, () => {
      const rows = GOLDEN['skills'][name] as any[]
      const scales = scalesOf(rows.map((r) => r.result))
      for (const row of rows) {
        it(row.key as string, async () => {
          const skill = SKILLS()[name] as Skill
          const params = realPath(row.params) as Record<string, unknown>
          let got: SkillResultLike
          try {
            got = await skill.execute({} as SkillContext, params)
          } catch (e) {
            // 抛出来本身就是一条判据（`ParseRegions` 的 `angle_deg` 那一格）。
            expect([row.key, `${(e as Error).name}: ${(e as Error).message}`])
              .toEqual([row.key, (row.result.raised as string).replace(/^ValueError/, 'RangeError')])
            return
          }
          expect(row.result.raised).toBeUndefined()
          expectCase(name, row.key as string, got, row.result, scales)
          if (row.output !== undefined) {
            const tol = (OUTPUT_TOL[name] as (k: string) => number)(row.key as string)
            expectOutput(name, row.key as string, got.data, row.output, tol, inputScale(params))
          }
          // ⚠️ `LoadScanFrameFromFile` 写的是**两个**文件，而那两份正是它唯一的
          // 产物。反扫那一份尤其要紧：不镜像回样品坐标的话，一切正/反扫比较
          // 都是在拿一张图和它自己的镜像比（76 张真机帧上判据整个反了过来）。
          // 帧是从**同一份 `.sxm` 字节**里读出来的 float32 ⇒ 容差 **0**。
          if (row.output_fwd !== undefined) {
            expectOutput(name, row.key as string, got.data, row.output_fwd, 0, 0, 'fwd_path')
            expectOutput(name, row.key as string, got.data, row.output_bwd, 0, 0, 'bwd_path')
          }
        })
      }
    })
  }

  describe('ComputeDriftVector', () => {
    const rows = GOLDEN['skills']['ComputeDriftVector'] as any[]
    const scales = scalesOf(rows.map((r) => r.result))
    for (const row of rows) {
      it(row.key as string, async () => {
        const stub = (GOLDEN['drift_stubs'] as Record<string, Record<string, unknown>>)
        const table = stubFor(stub, row.key as string)
        const calls: SkillCallRecord[] = []
        const ctx = fakeCtx(table, calls)
        const got = await ComputeDriftVector.execute(ctx, realPath(row.params) as Record<string, unknown>)
        // **调用序列也是判据**：参考图读不动就**一次 TCP 都不发**。
        expect([row.key, calls.map((c) => c.method)])
          .toEqual([row.key, (row.calls as any[]).map((c) => c.verb)])
        expectCase('ComputeDriftVector', row.key as string, got, row.result, scales)
      })
    }
  })
})

/** 金样里每一格用的是哪个桩（导出器那边的 `_drift_ctx` 表，这里照抄）。 */
function stubFor(stubs: Record<string, Record<string, unknown>>, key: string): Record<string, unknown> {
  const name = key === 'size_mismatch' ? 'small'
    : key === 'err_grab' ? 'grab_error'
    : key === 'err_empty_body' ? 'grab_empty'
    : 'ok'
  return stubs[name] as Record<string, unknown>
}

// ──────────────────────────────────────────────────────────────────────────
// 刻意与旧仓不同的三条，各自一条测试
// ──────────────────────────────────────────────────────────────────────────

describe('D-JUMP-1：`method` 报的是**真的跑了哪一条**，不是请求的那一条', () => {
  it('旧仓：给了 `model_path` 就报 `cnn`，哪怕 CNN 当场抛异常落回了统计', () => {
    const row = (GOLDEN['skills']['DetectAtomJump'] as any[]).find((r) => r.key === 'model_path_says_cnn')
    // 先把旧仓那一侧钉住 —— 差异消失时这条登记会当场变红，而不是安静地留着。
    expect(row.result.data.method).toBe('cnn')
    // 而它报的数**与统计那一支逐位相同** —— 也就是说那句 `cnn` 没有任何东西支撑。
    const plain = (GOLDEN['skills']['DetectAtomJump'] as any[]).find((r) => r.key === 'json_jump')
    expect(row.result.data.confidence).toBe(plain.result.data.confidence)
  })

  it('本仓：同一格报 `statistical`，而别的字段一个不差', async () => {
    const row = (GOLDEN['skills']['DetectAtomJump'] as any[]).find((r) => r.key === 'model_path_says_cnn')
    const got = await (PAPER_CROP['DetectAtomJump'] as Skill)
      .execute({} as SkillContext, realPath(row.params) as Record<string, unknown>)
    const d = got.data as Record<string, unknown>
    expect(d['method']).toBe('statistical')
    expect(d['confidence']).toBe(row.result.data.confidence)
    expect(d['jumped']).toBe(row.result.data.jumped)
  })
})

describe('D-JUMP-2：统计回退的 z 分数上限是 2，而缺省阈值是 3', () => {
  it('一次完美的中点跳变：z 正好是 2 —— 缺省阈值下 `jumped` 仍然是假', () => {
    const trace = Float64Array.from({ length: 80 }, (_v, i) => (i < 40 ? 1 : 5))
    const at3 = statisticalDetect(trace, 3.0)
    const at1 = statisticalDetect(trace, 1.0)
    expect(at3.jumped).toBe(false)
    expect(at1.jumped).toBe(true)
    // z = 2 ⇒ `confidence = min(1, 2/(2·threshold))`：阈值 1 时正好封顶。
    expect(at1.confidence).toBeCloseTo(1.0, 12)
    expect(at3.confidence).toBeCloseTo(1 / 3, 12)
  })

  it('跳得更高也顶不上去 —— 分母跟着长', () => {
    for (const h of [10, 1e3, 1e9]) {
      const trace = Float64Array.from({ length: 80 }, (_v, i) => (i < 40 ? 0 : h))
      expect(statisticalDetect(trace, 3.0).jumped).toBe(false)
    }
  })
})

describe('两处不复刻的异常文本，本仓这一侧说了什么', () => {
  it('`读不了 X` 分得开「文件不存在」与「不是个 .sxm」', async () => {
    const missing = await LoadScanFrameFromFile.execute({} as SkillContext, { scan_path: `${TMP}/nope.sxm` })
    const notSxm = await LoadScanFrameFromFile.execute({} as SkillContext, { scan_path: `${TMP}/plane_disks.npy` })
    expect(missing.error).toMatch(/^读不了 .*nope\.sxm: /)
    expect(missing.error).toMatch(/ENOENT/)
    expect(notSxm.error).toMatch(/Cannot find header end marker/)
    // 两句话**不一样** —— 归一化之后它们在金样里都是 `<read-error>`，
    // 而「分得开」这件事只有这一条测试在验。
    expect(missing.error).not.toBe(notSxm.error)
  })

  it('`invalid regions JSON` 后面带的是 V8 的话，而前半句逐字', async () => {
    const r = await ParseRegions.execute({} as SkillContext, { regions: '{not json' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/^invalid regions JSON: /)
    expect((r.error as string).length).toBeGreaterThan('invalid regions JSON: '.length)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 几条单测验不到别处的
// ──────────────────────────────────────────────────────────────────────────

describe('RANSAC：判据是「离对的近、离错的远」', () => {
  it('内点集正好是背景像素集，而不是全体', async () => {
    const facts = GOLDEN['ransac_facts'] as Record<string, any>
    const got = await (PAPER_DATA['SubtractPlane_RANSAC'] as Skill)
      .execute({} as SkillContext, { image_path: `${TMP}/plane_disks.npy` })
    const d = got.data as Record<string, unknown>
    expect(d['inlier_ratio']).toBe(facts['n_background'] / facts['n_points'])
  })

  it('解出来的平面离**全体像素**那条最小二乘远得多 —— 这就是 RANSAC 在做的事', async () => {
    const facts = GOLDEN['ransac_facts'] as Record<string, any>
    const golden = (GOLDEN['skills']['SubtractPlane_RANSAC'] as any[]).find((r) => r.key === 'plane_disks')
    const got = await (PAPER_DATA['SubtractPlane_RANSAC'] as Skill)
      .execute({} as SkillContext, { image_path: `${TMP}/plane_disks.npy` })
    const coef = (got.data as Record<string, unknown>)['plane_coefficients'] as number[]
    const wantA = (golden.result.data.plane_coefficients as number[])[0] as number
    const wrongA = (facts['lstsq_all_coefficients'] as number[])[0] as number
    const near = Math.abs((coef[0] as number) - wantA)
    const far = Math.abs((coef[0] as number) - wrongA)
    // 「离对的近」已经由差分那一格按 `lstsqRelTol` 比过；这里比的是**离错的多远**。
    expect(far / Math.max(near, Number.MIN_VALUE)).toBeGreaterThan(1e6)
    expect(far / Math.abs(wantA)).toBeGreaterThan(5)
  })
})

describe('D-DRIFT-1：`ComputeDriftVector` 的中心差一格，而它把符号也反着报', () => {
  it('金样那一格的真位移是 `roll(ref, +3, −2)`，报出来是 `(−4, +1)`', () => {
    const row = (GOLDEN['skills']['ComputeDriftVector'] as any[]).find((r) => r.key === 'ok')
    // 旧仓那一侧先钉住：`−(dy) − 1` 与 `−(dx) − 1`。
    // `−dy` 是**约定**（「把当前帧移回去多少」），而那个 `−1` 不是 ——
    // 它是 `correlate2d(mode='same')` 的原点 `(M−1)//2` 与技能拿的 `M//2`
    // 在**偶数**边长上差的那一格（D-NUM-19）。
    expect([row.result.data.shift_y_px, row.result.data.shift_x_px]).toEqual([-4, 1])
    expect(row.result.data.drift_x_m).toBeCloseTo(1 * (1e-8 / 32), 20)
  })

  it('32 是偶数，所以「一帧对它自己」也报 −1 —— 而 31 报 0', async () => {
    const mk = async (n: number): Promise<[unknown, unknown]> => {
      const img: number[][] = []
      for (let r = 0; r < n; r += 1) {
        const row: number[] = []
        for (let c = 0; c < n; c += 1) row.push(Math.cos(r * 0.7) * Math.sin(c * 1.1))
        img.push(row)
      }
      const p = `${TMP}/self_${n}.npy`
      writeFileSync(p, encodeNpyFrame(img))
      const calls: SkillCallRecord[] = []
      const ctx = fakeCtx({ Scan_FrameDataGrab: [4, 'Z', n, n, img, 1] }, calls)
      const r = await ComputeDriftVector.execute(ctx, { ref_path: p, scan_width_m: 1e-8 })
      const d = r.data as Record<string, unknown>
      return [d['shift_y_px'], d['shift_x_px']]
    }
    expect(await mk(32)).toEqual([-1, -1])
    expect(await mk(31)).toEqual([0, 0])
  })
})

describe('pickImageChannel：三档，各一格', () => {
  it('指名 `prefer` ⇒ 第一个名字里含它的', () => {
    expect(pickImageChannel(['Current', 'Z', 'Z fwd'], 'z f')).toBe('Z fwd')
  })

  it('没指名 ⇒ 按 z → height → topo 找，而**不是**第一路', () => {
    expect(pickImageChannel(['Current', 'Z'])).toBe('Z')
    expect(pickImageChannel(['Bias', 'Height'])).toBe('Height')
  })

  /**
   * ⚠️ 这一格在金样里**没有对应的文件** —— 真 Nanonis 不会把一路叫
   * `Z current`。但那道 `!includes('current')` 的闸是照移来的，而一道**没有
   * 任何用例走到**的闸与一道不存在的闸在 diff 里长得一模一样
   * （批 4a §9②）。这一条就是那个用例。
   */
  it('名字里带 current 的那一路**不当形貌**，哪怕它也带着 z', () => {
    expect(pickImageChannel(['Z current', 'Z'])).toBe('Z')
  })

  it('三档都落空 ⇒ 第一路（旧仓最后那一支，唯一一处「猜」）', () => {
    expect(pickImageChannel(['Bias', 'Amplitude'])).toBe('Bias')
  })

  it('一路都没有 ⇒ 抛，而且那句话与旧仓逐字相同', () => {
    expect(() => pickImageChannel([])).toThrow('sxm file exposes no channels')
  })
})

describe('loadImage2d：三条已实现的路 + 一条说得出口的缺口', () => {
  it('`.sxm` 挑的是 Z 不是第一路（第一路是 Current，两者差 1000 倍）', () => {
    const z = loadImage2d(`${TMP}/topo.sxm`)
    const cur = loadImage2d(`${TMP}/current_only.sxm`)
    expect(z.rows).toBe(32)
    expect(Math.abs((z.data[0] as number) / (cur.data[0] as number))).toBeGreaterThan(900)
  })

  it('`.dat` 的数值列拼成 `(n_points, n_cols)`', () => {
    const m = loadImage2d(`${TMP}/trace.dat`)
    expect([m.rows, m.cols]).toEqual([64, 2])
  })

  it('没实现的扩展名**当场说清楚**，不去撞一个「魔数不对」', () => {
    writeFileSync(`${TMP}/x.npz`, Buffer.from('PK'))
    expect(() => loadImage2d(`${TMP}/x.npz`)).toThrow(/本仓读不了 \.npz/)
  })
})

describe('AutoCrop：切了却写不出去**不算成功**', () => {
  it('落点的父目录不存在 ⇒ `success: false`，而 `cropped: true` 照样带出来', async () => {
    const got = await (PAPER_CROP['AutoCrop_UnscannedRegion'] as Skill).execute({} as SkillContext, {
      image_path: `${TMP}/bordered.npy`,
      tolerance: 1e-13,
      // `np.save` 与 `writeFileSync` 都不会替你建目录 —— 两边同一种失败
      save_path: `${TMP}/no/such/dir/out.npy`,
    })
    expect(got.success).toBe(false)
    expect(got.error).toMatch(/but failed to write the \.npy/)
    expect((got.data as Record<string, unknown>)['cropped']).toBe(true)
    expect((got.data as Record<string, unknown>)['output_path']).toBe(null)
  })
})
