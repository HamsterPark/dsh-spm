/**
 * 转过角度的帧上，技能报出来的坐标朝**哪一边**转（D-ROT-?：正 SCAN_ANGLE = 顺时针，
 * 像素 → 米是 R(−θ)）。
 *
 * 金样里团簇一族一格 θ≠0 都没有，`FindFlatRegion` 只有一格、而且只验中心 —— 所以这里
 * 用 θ=90° 的合成帧把**会被拿去移动针尖**的那几个坐标逐个钉住。期望值全部手算（写在
 * 每格的注释里），旧式 R(+θ) 的结果一并写出来：两者差几十纳米，不靠容差分辨。
 *
 * ⚠️ 测试点必须**离开帧心**：R(±θ) 都绕帧心转，帧心本身分不出符号。
 *
 * `.sxm` 就地写，不借 `dsh-spm-visual-memory` 的 `encodeSyntheticSxm`：这个包的 `src`
 * 连测试一起进 `tsc -b`，而它与 visual-memory 之间没有 project reference，干净构建时
 * 那份声明文件可能还没生成。下面这份只写本文件要的字段（单通道 Z、只有正扫、`down`）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SkillContext } from 'dsh-spm-kernel'
import { locateStepEdge } from 'dsh-spm-vision'
import { loadSxm, orient } from './analysis-common.js'
import { runExtractClusters, SelectPokedCluster, VerifyAdatomAt } from './analysis-clusters.js'
import { LocateStepEdge } from './analysis-frames.js'
import { FindFlatRegion } from './analysis-flat-region.js'

interface Frame {
  readonly nx: number
  readonly ny: number
  readonly widthM: number
  readonly heightM: number
  readonly offsetXM: number
  readonly offsetYM: number
  readonly angleDeg: number
  /** 行优先，**行 0 = 帧的顶边**（`down` 帧的采集顺序正是这个顺序）。 */
  readonly z: Float64Array
  /** `false` ⇒ 头里不写 `:SCAN_OFFSET:`（几何读不全的那一支）。 */
  readonly withOffset?: boolean
}

function sxmBytes(f: Frame): Buffer {
  const e = (v: number): string => v.toExponential(6).toUpperCase()
  const head = [
    ':NANONIS_VERSION:', '2',
    ':SCANIT_TYPE:', '              FLOAT            MSBFIRST',
    ':SCAN_PIXELS:', `       ${f.nx}       ${f.ny}`,
    ':SCAN_RANGE:', `           ${e(f.widthM)}           ${e(f.heightM)}`,
    ...(f.withOffset === false ? [] : [':SCAN_OFFSET:', `             ${e(f.offsetXM)}         ${e(f.offsetYM)}`]),
    ':SCAN_ANGLE:', `            ${f.angleDeg.toFixed(3)}`,
    ':SCAN_DIR:', 'down',
    ':DATA_INFO:', '\tChannel\tName\tUnit\tDirection\tCalibration\tOffset',
    '\t0\tZ\tm\tfwd\t1.000E+0\t0.000E+0',
    '', ':SCANIT_END:', '', '',
  ].join('\n')
  const data = Buffer.alloc(f.nx * f.ny * 4)
  for (let i = 0; i < f.nx * f.ny; i += 1) data.writeFloatBE(f.z[i] as number, i * 4)
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from([0x1a, 0x04]), data])
}

/** 确定性噪声，均匀落在 `[−amp, amp)`。 */
function noise(k: number, amp: number): number {
  const u = Math.sin(k * 12.9898) * 43758.5453
  return amp * (2 * (u - Math.floor(u)) - 1)
}

let DIR = ''
const PATH: Record<string, string> = {}

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), 'scan-angle-')).replaceAll('\\', '/')

  // ── 帧 A：一颗亮斑 ─────────────────────────────────────────────────────
  // 64×64、64 nm（1 nm/px），中心 (100, −50) nm，θ=90°。斑心在像素（列 48，行 16），
  // 离帧心约 22.6 nm。噪声 ±1 pm：**不能是零噪声**，零噪声时 MAD=0、阈值就是中位数，
  // 整帧连成一团；±1 pm 也到不了约 2.2 pm 的阈值，于是团簇恰好一个。
  {
    const n = 64
    const z = new Float64Array(n * n)
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        const bump = 200e-12 * Math.exp(-((c - 48) ** 2 + (r - 16) ** 2) / (2 * 1.5 ** 2))
        z[r * n + c] = 1e-9 + noise(r * n + c + 1, 1e-12) + bump
      }
    }
    const p = `${DIR}/bump.sxm`
    PATH['bump'] = p
    writeFileSync(p, sxmBytes({
      nx: n, ny: n, widthM: 64e-9, heightM: 64e-9, offsetXM: 100e-9, offsetYM: -50e-9, angleDeg: 90, z,
    }))
  }

  // ── 帧 B：两块平地 ─────────────────────────────────────────────────────
  // 96×96、48 nm（0.5 nm/px），中心 (100, −50) nm，θ=90°。底子 ±50 pm（局部 RMS 约 29 pm，
  // 过不了 25 pm 的可用线）；P1 = 行 12–35 × 列 60–83（±1 pm），P2 = 行 60–83 × 列 12–35
  // （±3 pm）。`window_fraction: 0.25` ⇒ 窗 24 px、步长 12 px，P1 / P2 各自恰好是一个窗。
  {
    const n = 96
    const z = new Float64Array(n * n)
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        const inP1 = r >= 12 && r < 36 && c >= 60 && c < 84
        const inP2 = r >= 60 && r < 84 && c >= 12 && c < 36
        const amp = inP1 ? 1e-12 : inP2 ? 3e-12 : 50e-12
        z[r * n + c] = 1e-9 + noise(r * n + c + 7, amp)
      }
    }
    const p = `${DIR}/flats.sxm`
    PATH['flats'] = p
    writeFileSync(p, sxmBytes({
      nx: n, ny: n, widthM: 48e-9, heightM: 48e-9, offsetXM: 100e-9, offsetYM: -50e-9, angleDeg: 90, z,
    }))
  }

  // ── 帧 C：一道竖直台阶 ─────────────────────────────────────────────────
  // 64×64、64 nm，中心 (100, −50) nm，θ=90°。列 ≥ 40 高 200 pm，噪声 ±1 pm。
  // 另存一份**头里没有 `:SCAN_OFFSET:`** 的，走「几何读不全」那一支。
  {
    const n = 64
    const z = new Float64Array(n * n)
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) z[r * n + c] = 1e-9 + (c >= 40 ? 200e-12 : 0) + noise(r * n + c + 3, 1e-12)
    }
    const frame = { nx: n, ny: n, widthM: 64e-9, heightM: 64e-9, offsetXM: 100e-9, offsetYM: -50e-9, angleDeg: 90, z }
    const p = `${DIR}/step.sxm`
    PATH['step'] = p
    writeFileSync(p, sxmBytes(frame))
    const q = `${DIR}/step_no_offset.sxm`
    PATH['step_no_offset'] = q
    writeFileSync(q, sxmBytes({ ...frame, withOffset: false }))
  }
})

afterAll(() => {
  if (DIR !== '') rmSync(DIR, { recursive: true, force: true })
})

const CTX = {} as SkillContext

/** 斑心的压电坐标：dx = 48.5 − 32 = 16.5 nm，dy = 32 − 16.5 = 15.5 nm；
 *  R(−90°)·(dx, dy) = (dy, −dx) ⇒ (100 + 15.5, −50 − 16.5)。旧式 R(+90°) 给 (84.5, −33.5)。 */
const BUMP_X = 115.5e-9
const BUMP_Y = -66.5e-9
/** 半个像素：阈值边上的像素会被噪声翻掉一两个，质心偏移在亚像素内。 */
const CENTROID_TOL = 0.5e-9

describe('θ=90° 帧上的团簇坐标（D-ROT-?）', () => {
  it('A1 ExtractClusters：斑心落在 R(−θ) 给的位置', () => {
    const r = runExtractClusters({ scan_path: PATH['bump'], polarity: 'bright' })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect([d.frame.angle_deg, d.frame.angle_known]).toEqual([90, true])
    expect(d.clusters).toHaveLength(1)
    const c = d.clusters[0]
    expect(Math.abs(c.x_m - BUMP_X) <= CENTROID_TOL || `x_m = ${c.x_m}`).toBe(true)
    expect(Math.abs(c.y_m - BUMP_Y) <= CENTROID_TOL || `y_m = ${c.y_m}`).toBe(true)
  })

  it('A2 SelectPokedCluster：锚在真位置上就选中它，而且说坐标可信', async () => {
    // 旧式下最近的合格团簇在 45.3 nm 外，超过 3 nm 的锚点容差 ⇒ 弃权。
    const r = await SelectPokedCluster.execute(CTX, {
      scan_path: PATH['bump'],
      polarity: 'bright',
      min_aspect: 0.35,
      min_area_px: 5,
      min_peak_height_m: 50e-12,
      anchor_tolerance_m: 3e-9,
      near_x_m: BUMP_X,
      near_y_m: BUMP_Y,
    })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect(d.coords_trustworthy).toBe(true)
    expect(d.selected).not.toBeNull()
    expect(Math.abs(d.selected.x_m - BUMP_X) <= CENTROID_TOL || `x_m = ${d.selected.x_m}`).toBe(true)
    expect(Math.abs(d.selected.y_m - BUMP_Y) <= CENTROID_TOL || `y_m = ${d.selected.y_m}`).toBe(true)
    expect(d.distance_to_anchor_m).toBeLessThan(CENTROID_TOL)
  })

  it('A3 VerifyAdatomAt：目标在真位置上 ⇒ at_target', async () => {
    // 旧式下残差 45.3 nm > 10 × tol ⇒ not_found。
    const r = await VerifyAdatomAt.execute(CTX, {
      scan_path: PATH['bump'],
      target_x_m: BUMP_X,
      target_y_m: BUMP_Y,
      tolerance_m: 1e-9,
    })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect(d.verdict).toBe('at_target')
    expect(d.residual_m).toBeLessThan(CENTROID_TOL)
  })
})

/**
 * P1 窗心像素 (72, 24)：dx = 72.5/2 − 24 = 12.25 nm，dy = 24 − 24.5/2 = 11.75 nm
 * ⇒ R(−90°) 给 (100 + 11.75, −50 − 12.25) = (111.75, −62.25)；旧式给 (88.25, −37.75)。
 * P2 窗心像素 (24, 72)：dx = −11.75，dy = −12.25 ⇒ (87.75, −38.25)。
 */
const P1: readonly [number, number] = [111.75e-9, -62.25e-9]
const P2: readonly [number, number] = [87.75e-9, -38.25e-9]
/** 窗心是一次 `pxToM`，误差在 1e-24 m 量级；1 pm 只是「是这个窗而不是隔壁那个（6 nm 外）」。 */
const WINDOW_TOL = 1e-12

function expectCentre(d: any, want: readonly [number, number]): void {
  const got: [number, number] = [d.center_x_m, d.center_y_m]
  expect(
    (Math.abs(got[0] - want[0]) <= WINDOW_TOL && Math.abs(got[1] - want[1]) <= WINDOW_TOL) ||
      `center = (${got[0]}, ${got[1]})，应为 (${want[0]}, ${want[1]})`,
  ).toBe(true)
}

describe('θ=90° 帧上 FindFlatRegion 的「避开扎过的点」（D-ROT-?）', () => {
  it('B1 不排除：选中最平的 P1，中心是 R(−θ) 给的位置', async () => {
    const r = await FindFlatRegion.execute(CTX, { scan_path: PATH['flats'], window_fraction: 0.25 })
    expect(r.success).toBe(true)
    expectCentre(r.data, P1)
  })

  it('B2 排除 P1 的真位置：P1 那一个窗被跳过，退到 P2', async () => {
    // 旧式下被跳过的是 (列 12, 行 60) 那个窗（旧式中心 (112.25, −61.75)，离排除点 0.71 nm），
    // 而那个窗正好是 P2 —— P1 照选不误，「避开」落了空。
    const r = await FindFlatRegion.execute(CTX, {
      scan_path: PATH['flats'],
      window_fraction: 0.25,
      exclude_used_spots: '111.75n,-62.25n',
      min_separation_m: 2e-9,
    })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect(d.windows_skipped).toBe(1)
    expectCentre(d, P2)
  })

  it('B3 对照：排除 P1 的旧式像，P1 不受影响', async () => {
    // ⚠️ 只断言中心。θ=90° 的中心对称把窗网格映回网格自己（差 1 px），所以这个点离
    // 某个窗（这里正好是 P2）只有 0.71 nm，那个窗照样被跳过 —— `windows_skipped` 是 1，
    // 不是 0。旧式下被跳过的反而是 P1，于是选到 P2。
    const r = await FindFlatRegion.execute(CTX, {
      scan_path: PATH['flats'],
      window_fraction: 0.25,
      exclude_used_spots: '88.25n,-37.75n',
      min_separation_m: 2e-9,
    })
    expect(r.success).toBe(true)
    expectCentre(r.data, P1)
  })
})

/** 判据在同一帧上给出的边上一点（像素）—— 技能不报它，期望值要从它算。 */
function edgePointPx(path: string): [number, number] {
  const load = loadSxm(path)
  if (!load.ok) throw new Error(load.plain)
  const img = orient(load.scan, 'Z').forward
  if (img === null) throw new Error('no forward frame')
  const res = locateStepEdge(img)
  if (res.verdict !== 'step_edge' || res.xPx === null || res.yPx === null) throw new Error(`verdict ${res.verdict}`)
  return [res.xPx, res.yPx]
}

describe('θ=90° 帧上 LocateStepEdge 的边上一点（D-ROT-?）', () => {
  it('C1 edge_x_m / edge_y_m 经 R(−θ) 换算，而不是旧仓那个不旋转的式子', async () => {
    const [xPx, yPx] = edgePointPx(PATH['step'] as string)
    const r = await LocateStepEdge.execute(CTX, { scan_path: PATH['step'] })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect(d.verdict).toBe('step_edge')
    // R(−θ)，θ=90°，测试里独立写：帧内 (dx, dy) ⇒ 压电 (cx + dy, cy − dx)。
    const t = (90 * Math.PI) / 180
    const dx = ((xPx + 0.5) / 64) * 64e-9 - 32e-9
    const dy = 32e-9 - ((yPx + 0.5) / 64) * 64e-9
    const want = [100e-9 + dx * Math.cos(t) + dy * Math.sin(t), -50e-9 - dx * Math.sin(t) + dy * Math.cos(t)]
    expect(Math.abs(d.edge_x_m - (want[0] as number)) <= WINDOW_TOL || `edge_x_m = ${d.edge_x_m}`).toBe(true)
    expect(Math.abs(d.edge_y_m - (want[1] as number)) <= WINDOW_TOL || `edge_y_m = ${d.edge_y_m}`).toBe(true)
    // 旧式（不旋转，`nm_per_px` = 1）：差的是一整段台阶到帧心的距离（这里约 8 nm）。
    const legacy = [100e-9 + (xPx - 31.5) * 1e-9, -50e-9 - (yPx - 31.5) * 1e-9]
    expect(Math.abs(d.edge_x_m - (legacy[0] as number))).toBeGreaterThan(1e-9)
    expect(Math.abs(d.edge_y_m - (legacy[1] as number))).toBeGreaterThan(1e-9)
  })

  it('C2 头里没有 `:SCAN_OFFSET:` ⇒ 判得出边，但不报坐标（不是「在原点」）', async () => {
    const r = await LocateStepEdge.execute(CTX, { scan_path: PATH['step_no_offset'] })
    expect(r.success).toBe(true)
    const d = r.data as any
    expect(d.verdict).toBe('step_edge')
    expect([d.edge_x_m, d.edge_y_m]).toEqual([undefined, undefined])
  })
})
