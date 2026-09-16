/**
 * 批 4b 的四个技能 —— `AssessScanTexture` · `MeasureLatticeCell` ·
 * `AssessAtomicResolution` · `AnalyseAtomicLattice`。
 *
 * **只做 IO 与阈值取用，一个判据都不写**（与批 4a 的 `analysis-common.ts` 同一条分工）：
 * 判据全在 `dsh-spm-vision` 的 `lattice-peaks` / `lattice-cell` / `frame-texture` /
 * `atomic-phase`，成像条件窗口在 `dsh-spm-kernel` 的 `imaging-window`（零 numpy）。
 *
 * ## 四个技能各自回答**一个不同的问题**，这一点必须在报文里守住
 *
 * | 技能 | 问什么 | 不回答什么 |
 * |---|---|---|
 * | `AssessAtomicResolution` | **有没有**原子相（三态 atomic/absent/undetermined） | 有多强 |
 * | `AnalyseAtomicLattice` | 周期是多少、六重对不对、取向 | 有没有（它把这个问题**前置**给上一个） |
 * | `AssessScanTexture` | 有多强、哪一块好 | 有没有（它**假设**你已经知道有） |
 * | `MeasureLatticeCell` | 这个表面的**原胞**是多少（不需要已知晶格常数） | 扫描器扭曲了多少 |
 *
 * ## `undetermined` 不是 `absent`（2026-08-26 那根针尖）
 *
 * 修针流程把偏压留在 1.0 V，之后每帧的 FFT 给出周期 0.30–0.36 nm（理论 0.24974）、
 * 散布 80%+。按这个读数往下走，阶梯判「针尖极其糟糕」⇒ 打脉冲 ⇒
 * **真的把一根 asp 1.295 / snr 37.3 的好针尖打坏了**。
 * 所以 `AssessAtomicResolution` 的成像条件闸门产出的是 `undetermined`，
 * 而且那个结论要**机器可读**（`imaging_window` 是一个对象，不是一句中文告警）。
 */
import { existsSync } from 'node:fs'
import { checkAtomicWindow, pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { type Mat } from 'dsh-spm-numerics'
import {
  assessAtomicPhase,
  combineUpDown,
  findLatticePeaks,
  firstOrderPeriodNm,
  latticeAmplitudePm,
  measureCell,
  streakAmplitudePm,
  SURFACE_LATTICE_NM,
  superstructureTest,
  tileLatticeMap,
  type AtomicPhaseResult,
  type CellResult,
} from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { loadSxm, numParam, orient, strParam } from './analysis-common.js'
import { pyStr } from './common.js'

/** `round(x, n)` 的 Python 语义（**四舍六入五成双**），返回**数**。 */
function pyRound(x: number, n: number): number {
  return Number(pyFixed(x, n))
}

/** Python 的 `"%+.2f"` —— 非负数也带符号。 */
function signed(x: number, n: number): string {
  const s = pyFixed(x, n)
  return s.startsWith('-') ? s : `+${s}`
}

/** Python 的 `str(tuple_of_str)` —— `('a', 'b')`、单元素带尾逗号。 */
function pyTupleRepr(xs: readonly string[]): string {
  if (xs.length === 0) return '()'
  if (xs.length === 1) return `('${xs[0] as string}',)`
  return `(${xs.map((x) => `'${x}'`).join(', ')})`
}

/** `mast.io.mosaic` 之外的一份「一批路径」拆法 —— 逗号 / 换行。 */
export function splitPaths(raw: string): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const chunk of String(raw).replace(/\r/g, '\n').split('\n')) {
    for (const p of chunk.split(',')) out.push(p.trim())
  }
  return out.filter((p) => p !== '')
}

/** 一帧 `.sxm` 的图像与工作点（旧仓 `_sxm_frame.LoadedFrame` 的可用子集）。 */
export interface LoadedFrame {
  readonly error: string
  readonly forward: Mat | null
  readonly backward: Mat | null
  readonly nmPerPx: number | null
  readonly widthNm: number | null
  readonly biasV: number | null
  readonly setpointA: number | null
  readonly scanDir: string
  readonly lineTimeS: number | null
  readonly recTime: string
  readonly name: string
}

function headFloat(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const first = String(raw).trim().split(/\s+/)[0]
  if (first === undefined || first === '') return null
  const v = Number(first)
  return Number.isFinite(v) ? v : null
}

/**
 * 读一个 `.sxm`，给出定向后的两个方向 + 工作点。**永不抛。**
 *
 * IO 一律走 `sxmOrientedFrames`：反扫是镜像存的、`:SCAN_DIR: up` 的第一行是帧底，
 * 这两件事只在那一处修正，别在判据层重做。
 */
export function loadFrame(path: string, channel = 'Z', opts: { requireScale?: boolean } = {}): LoadedFrame {
  // ⚠️ **两个技能族对「头里没有像素标度」的处置不一样，而那不是笔误。**
  //
  // | | 旧仓那一份 | 它做什么 |
  // |---|---|---|
  // | `AssessScanTexture` / `MeasureLatticeCell` | `_sxm_frame.load_frame` | 当场退出，报「文件头里没有像素标度」 |
  // | `AssessAtomicResolution` / `AnalyseAtomicLattice` | `atomic_lattice._load_frame` | 把 `null` 原样传下去 |
  //
  // 第二种更好，而且好得有理由：判据环收到 `null` 会给出 **`unknown_pixel_size`**
  // —— 一条**机器可判**的出局词，下游据此判「这一帧回答不了」；
  // 而第一种给的是一句中文错误串，调用方只能去匹配散文。
  // 本仓**两种都照移**：统一成一种会让金样里两条报文有一条对不上，
  // 而改掉的正是模型读的那一句（同 `loadErrorFor` 那条）。
  const requireScale = opts.requireScale ?? true
  const empty = {
    forward: null,
    backward: null,
    nmPerPx: null,
    widthNm: null,
    biasV: null,
    setpointA: null,
    scanDir: '',
    lineTimeS: null,
    recTime: '',
    name: '',
  }
  if (!path) return { error: '没有给 scan_path', ...empty }
  if (!existsSync(path)) return { error: `文件不存在: ${path}`, ...empty }
  const load = loadSxm(path)
  if (!load.ok) return { error: `.sxm 读取失败: ${load.plain}`, ...empty }
  const topo = orient(load.scan, channel)
  if (topo.forward === null) return { error: `没有通道 '${channel}' 的正扫数据`, ...empty }
  if (requireScale && !topo.nm_per_px) return { error: '文件头里没有像素标度', ...empty }
  const header = load.scan.header
  const base = path.replace(/\\/g, '/')
  return {
    error: '',
    forward: topo.forward,
    backward: topo.backward,
    nmPerPx: topo.nm_per_px,
    widthNm: topo.width_nm,
    biasV: topo.bias_v,
    setpointA: topo.setpoint_a,
    scanDir: String(topo.scan_dir ?? ''),
    lineTimeS: headFloat(header['scan_time']),
    recTime: String(topo.rec_time ?? ''),
    name: base.slice(base.lastIndexOf('/') + 1),
  }
}

// ── AssessScanTexture ──────────────────────────────────────────────────────

/**
 * `good_ratio` **刻意没有默认值**，这一条是硬的。
 *
 * 块级比值的阈值 0.6 只在**一个样品、一根针尖、一夜**上标过（好帧 0.77–1.41、
 * 条纹区 0.10–0.35）。给它一个 spec 默认值，schema 会在调用方没传时替它填上，
 * 于是「这台机器上没标定过」这件事再也看不见 —— 本仓已为这个形状付过**五次**
 * 学费（D-ZERO-1 那一族的孪生：这一条不是「0 被吃掉」，是「没配却像配了」）。
 *
 * 不传时**照样出数**：`tile_grid` 与 `tile_median_ratio` 是测量，不需要阈值；
 * 只有 `tile_good_fraction` 留 `null` 并在 `notes` 里说明为什么。
 */
export const AssessScanTexture: Skill = {
  spec: S.AssessScanTextureSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['scan_path'] ?? '')
    const channel = strParam(params, 'channel', 'Z')
    const tileNm = numParam(params, 'tile_nm') || 4.0
    const goodRatio = numParam(params, 'good_ratio')

    const fr = loadFrame(path, channel)
    if (fr.error) return { success: false, error: fr.error }
    const fwd = fr.forward as Mat
    const nmpp = fr.nmPerPx as number

    const notes: string[] = []
    const data: Record<string, unknown> = {
      scan_path: path,
      channel,
      nm_per_px: nmpp,
      width_nm: fr.widthNm,
      bias_v: fr.biasV,
      setpoint_a: fr.setpointA,
      scan_dir: fr.scanDir,
      rec_time: fr.recTime,
    }

    // 晶格方向从整帧上量一次；**块内不重新找峰**（一块里只有几个周期，找峰会锁到噪声上）。
    const cell = measureCell(fwd, nmpp, { scanDir: fr.scanDir })
    if (!cell.ok) {
      data['verdict'] = 'undetermined'
      data['reason'] = cell.reason
      data['streak_pm'] = streakAmplitudePm(fwd, nmpp)
      notes.push(
        `找不到可用的晶格方向（${cell.reason}）—— 晶格幅值与块图都无从谈起，因为它们` +
          `都是「沿着那个方向」的量。条纹幅值仍然给了：它不需要知道晶格在哪。`,
      )
      data['notes'] = notes
      return { success: true, data, summary: textureSummary(data) }
    }

    data['verdict'] = 'measured'
    const dirs: readonly (readonly [number, number])[] = [
      [cell.a1AngleDeg as number, cell.a1Nm as number],
      [(cell.a1AngleDeg as number) + (cell.gammaDeg as number), cell.a2Nm as number],
    ]
    const amps = latticeAmplitudePm(fwd, nmpp, dirs)
    data['lattice_directions'] = amps.map((a) => ({
      angle_deg: pyRound(a.angleDeg, 2),
      period_nm: pyRound(a.periodNm, 4),
      bandpass_pm: pyRound(a.amplitudePm, 2),
      coherent_pm: pyRound(a.coherentPm, 2),
      coherence: pyRound(a.coherence, 3),
    }))
    if (amps.length > 0) {
      data['lattice_bandpass_pm'] = pyRound(Math.max(...amps.map((a) => a.amplitudePm)), 2)
      data['lattice_coherent_pm'] = pyRound(Math.max(...amps.map((a) => a.coherentPm)), 2)
    }
    data['streak_pm'] = streakAmplitudePm(fwd, nmpp)
    // 条纹的绝对值随整帧起伏一起涨，单独看会把「地形丰富」读成「脏」。
    // 有意义的是与**同口径**（都是带通峰峰值）的晶格幅值之比。
    const bp = data['lattice_bandpass_pm'] as number | undefined
    const streak = data['streak_pm'] as number | null
    if (bp && streak) data['streak_to_lattice'] = pyRound(streak / bp, 3)

    const tiles = tileLatticeMap(
      fwd,
      nmpp,
      amps.map((a) => [a.angleDeg, a.periodNm] as const),
      { tileNm, goodRatio: goodRatio !== null ? goodRatio : 0.6 },
    )
    data['tile_ok'] = tiles.ok
    data['tile_reason'] = tiles.reason
    data['tile_nm'] = tiles.tileNm
    data['tile_periods_per_tile'] = tiles.periodsPerTile !== null ? pyRound(tiles.periodsPerTile, 2) : null
    if (tiles.ok) {
      data['tile_grid'] = tiles.grid.map((row) => row.map((v) => pyRound(v, 3)))
      data['tile_median_ratio'] = pyRound(tiles.medianRatio as number, 3)
      // 主报数：**局域**原子起伏。逐块算再取中位，与视野无关 ——
      // 整帧的相干分量会因帧内失相而随视野塌掉（30 nm 上只剩 1/30）。
      data['lattice_local_pm'] = pyRound(tiles.coherentMedianPm as number, 2)
      if (goodRatio === null) {
        data['tile_good_fraction'] = null
        notes.push(
          `没传 good_ratio，所以不给「好块占比」—— 那个数需要一个本机标定过的` +
            `门槛，而随包发布的 0.6 只在一个样品上标过。逐块比值与中位数` +
            `（${pyFixed(tiles.medianRatio as number, 2)}）是测量，不需要门槛，已经给了。`,
        )
      } else {
        data['tile_good_fraction'] = pyRound(tiles.goodFraction as number, 3)
        data['tile_good_ratio_used'] = goodRatio
      }
      // 几何上下 → 扫描先后：`up` 的第一行是帧**底**。
      const top = tiles.topBandMedian as number
      const bot = tiles.bottomBandMedian as number
      const [first, last] = fr.scanDir.startsWith('up') ? [bot, top] : [top, bot]
      data['tile_first_scanned_median'] = pyRound(first, 3)
      data['tile_last_scanned_median'] = pyRound(last, 3)
      if (first > 0 && (last / first < 0.5 || first / last < 0.5)) {
        notes.push(
          `先扫的那一排块中位 ${pyFixed(first, 2)}、后扫的 ${pyFixed(last, 2)} —— 针尖在这一帧里变了。` +
            `**这一帧的读数是两段不同状态的平均**，拿它代表「现在的针尖」` +
            `会指向过去式（与 assess_atomic_phase 的半帧检查同一件事）。`,
        )
      }
    } else {
      notes.push(...tiles.warnings)
    }
    data['notes'] = notes
    data['cell'] = {
      a1_nm: pyRound(cell.a1Nm as number, 4),
      a2_nm: pyRound(cell.a2Nm as number, 4),
      gamma_deg: pyRound(cell.gammaDeg as number, 2),
      indexed: cell.indexed,
      indexed_total: cell.indexedTotal,
    }
    return { success: true, data, summary: textureSummary(data) }
  },
}

function textureSummary(data: Record<string, unknown>): string {
  if (data['verdict'] === 'undetermined') return '这一帧上找不到晶格方向，量不了晶格幅值与块图。'
  const lat = data['lattice_local_pm'] as number | undefined
  const bp = data['lattice_bandpass_pm'] as number | undefined
  const ratio = data['streak_to_lattice'] as number | undefined
  const bits: string[] = []
  if (lat !== undefined && lat !== null) {
    bits.push(`局域原子起伏 ${pyFixed(lat, 1)} pm（逐块相干，与视野无关）`)
  } else if (data['lattice_coherent_pm'] !== undefined && data['lattice_coherent_pm'] !== null && bp !== undefined) {
    bits.push(`整帧相干起伏 ${pyFixed(data['lattice_coherent_pm'] as number, 1)} pm（帧内失相会压低它；带通上界 ${pyFixed(bp, 1)} pm）`)
  }
  if (ratio !== undefined && ratio !== null) bits.push(`条纹/晶格 ${pyFixed(ratio, 2)}（同为带通口径）`)
  const gf = data['tile_good_fraction']
  if (gf !== undefined && gf !== null) bits.push(`${pyFixed(100 * (gf as number), 0)}% 的块晶格清楚`)
  else if (data['tile_median_ratio'] !== undefined && data['tile_median_ratio'] !== null) {
    bits.push(`块比值中位 ${pyFixed(data['tile_median_ratio'] as number, 2)}（未给门槛，不算占比）`)
  }
  let s = bits.length > 0 ? bits.join('；') : '量不出可报的量'
  if (ratio !== undefined && ratio !== null && ratio > 1.5) {
    s += '。条纹带的功率超过晶格带 —— 这帧「脏」的来源是逐行短划，不是晶格弱。'
  }
  return s
}

// ── MeasureLatticeCell ─────────────────────────────────────────────────────

/**
 * 从一批原子分辨帧量出实空间原胞，并检验有没有超结构。
 *
 * **「一个文件都没读进来」与「读进来了但量不出晶格」是两回事**：后者是判不了
 * （`success=true` + `undetermined`），前者是技能失败。混在一起，调用方就分不清
 * 该去修路径还是该换帧。
 */
export const MeasureLatticeCell: Skill = {
  spec: S.MeasureLatticeCellSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const paths = splitPaths(String(params['scan_paths'] ?? ''))
    const channel = strParam(params, 'channel', 'Z')
    const minIndexed = numParam(params, 'min_indexed') || 3
    const doSuper = params['superstructure'] === undefined ? true : Boolean(params['superstructure'])
    if (paths.length === 0) return { success: false, error: '没有给 scan_paths' }

    const ups: CellResult[] = []
    const downs: CellResult[] = []
    const perFrame: Record<string, unknown>[] = []
    const rejected: Record<string, unknown>[] = []
    const heights: number[] = []
    const times: number[] = []
    let best: { cell: CellResult; fr: LoadedFrame } | null = null
    let nIoFailed = 0
    for (const p of paths) {
      const fr = loadFrame(p, channel)
      if (fr.error) {
        rejected.push({ path: p, reason: fr.error })
        nIoFailed += 1
        continue
      }
      const cell = measureCell(fr.forward as Mat, fr.nmPerPx as number, { scanDir: fr.scanDir })
      if (!cell.ok) {
        rejected.push({ path: p, reason: cell.reason })
        continue
      }
      perFrame.push({
        name: fr.name,
        scan_dir: fr.scanDir,
        width_nm: fr.widthNm,
        bias_v: fr.biasV,
        setpoint_a: fr.setpointA,
        a1_nm: pyRound(cell.a1Nm as number, 4),
        a2_nm: pyRound(cell.a2Nm as number, 4),
        gamma_deg: pyRound(cell.gammaDeg as number, 2),
        a1_angle_deg: pyRound(cell.a1AngleDeg as number, 2),
        indexed: cell.indexed,
        indexed_total: cell.indexedTotal,
        n_ridge: cell.nRidge,
      })
      ;(fr.scanDir.startsWith('up') ? ups : downs).push(cell)
      if (fr.widthNm) heights.push(fr.widthNm)
      if (fr.lineTimeS && fr.forward !== null) times.push(fr.lineTimeS * 2.0 * fr.forward.rows)
      if (best === null || cell.indexed > best.cell.indexed) best = { cell, fr }
    }

    if (nIoFailed === paths.length) {
      return {
        success: false,
        error: `${paths.length} 个路径一个都读不进来：${rejected
          .slice(0, 3)
          .map((r) => r['reason'] as string)
          .join('；')}`,
        data: { rejected },
      }
    }
    if (perFrame.length === 0) {
      return {
        success: true,
        data: { verdict: 'undetermined', rejected, n_frames: 0 },
        summary: '这一批帧上一个原胞都量不出来 —— 逐帧原因见 rejected。' + '最常见的是像素太粗（scale_off）或谱被条纹主导。',
      }
    }

    const data: Record<string, unknown> = {
      n_frames: perFrame.length,
      n_up: ups.length,
      n_down: downs.length,
      per_frame: perFrame,
      rejected,
    }
    const combined = combineUpDown(ups, downs, {
      minIndexed,
      frameHeightNm: heights.length > 0 ? medianOf(heights) : null,
      frameTimeS: times.length > 0 ? medianOf(times) : null,
    })
    const rounded: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(combined)) rounded[k] = typeof v === 'number' ? pyRound(v, 5) : v
    data['combined'] = rounded

    if (combined['ok'] === true) {
      data['verdict'] = 'measured'
      data['a1_nm'] = pyRound(combined['a1_nm'] as number, 4)
      data['a2_nm'] = pyRound(combined['a2_nm'] as number, 4)
      data['gamma_deg'] = combined['gamma_deg'] ? pyRound(combined['gamma_deg'] as number, 2) : null
    } else {
      // 只有一个扫描方向：仍然出数，但 a₂ 里含漂移，**必须说出来**。
      const usable = [...ups, ...downs].filter((c) => (c.indexed || 0) >= minIndexed)
      if (usable.length === 0) {
        data['verdict'] = 'undetermined'
        data['reason'] = combined['reason'] ?? ''
      } else {
        data['verdict'] = 'measured_one_direction'
        data['a1_nm'] = pyRound(medianOf(usable.map((c) => c.a1Nm as number)), 4)
        data['a2_nm'] = pyRound(medianOf(usable.map((c) => c.a2Nm as number)), 4)
        data['gamma_deg'] = pyRound(medianOf(usable.map((c) => c.gammaDeg as number)), 2)
        data['one_direction_caveat'] =
          `这一批只有${ups.length > 0 ? '上' : '下'}扫。慢轴热漂移会把 a₂ 沿慢轴拉伸或压缩，而这个偏差` +
          `**只有换慢轴方向才看得见** —— 现在它留在 a₂ 里，量级通常是零点几` +
          `个百分点。要消掉就补几帧反方向的（Nanonis 扫描方向 up ↔ down）。`
      }
    }

    if (doSuper && best !== null) {
      const res = superstructureTest(best.fr.forward as Mat, best.fr.nmPerPx as number, best.cell)
      data['superstructure_frame'] = best.fr.name
      data['superstructure'] = res.map((r) => ({
        order: r.label,
        period_nm: r.periodNm,
        amplitude_pm: pyRound((r.amplitude ?? 0) * 1e12, 3),
        control_max_pm: pyRound((r.controlMax ?? 0) * 1e12, 3),
        ratio_to_control: r.ratioToControl ? pyRound(r.ratioToControl, 2) : null,
        verdict: r.verdict,
        note: r.note,
      }))
    }

    data['shear_caveat'] =
      'γ 是测量值，但它含着**未校正的扫描器剪切** —— 单帧分不开「表面本来就不是' +
      '直角」与「扫描器把直角扭了」。要分开就用 CalibratePiezoMultiAngle' +
      '（换扫描角）或 calibrate_up_down（换慢轴方向），两者分离的是剪切角，' +
      '与本技能用上下扫消掉的慢轴长度应变是同一个漂移矢量的两个分量。'
    return { success: true, data, summary: cellSummary(data) }
  },
}

function cellSummary(data: Record<string, unknown>): string {
  const v = data['verdict']
  if (v === 'undetermined') return `量不出原胞（${data['n_frames'] ?? 0} 帧全部无法定基矢）。`
  let head =
    `原胞 a₁ = ${pyFixed(data['a1_nm'] as number, 4)} nm、a₂ = ${pyFixed(data['a2_nm'] as number, 4)} nm、` +
    `γ = ${pyStr(data['gamma_deg'])}°`
  const c = (data['combined'] ?? {}) as Record<string, unknown>
  if (v === 'measured') {
    head += `（上扫 ${c['n_up'] ?? 0} 帧 / 下扫 ${c['n_down'] ?? 0} 帧取中位，慢轴漂移已抵消`
    if (c['drift_nm_per_h'] !== undefined && c['drift_nm_per_h'] !== null) {
      head += `，顺带测得漂移 ${pyFixed(c['drift_nm_per_h'] as number, 2)} nm/h`
    }
    head += '）。'
  } else {
    head += '（只有一个扫描方向，a₂ 里含未抵消的漂移）。'
  }
  const sup = (data['superstructure'] ?? []) as Record<string, unknown>[]
  const present = sup.filter((s) => s['verdict'] === 'present')
  if (sup.length > 0) {
    head +=
      ' 超结构：' +
      (present.length > 0
        ? present.map((s) => `${s['order'] as string} 处有（对照的 ${pyFixed((s['ratio_to_control'] as number) || 0, 1)} 倍）`).join('、')
        : '半序位置与空白对照不可区分，没有') +
      '。'
  }
  return head
}

/** `np.median`（偶数取两中位的算术平均）。 */
function medianOf(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return NaN
  const h = n >> 1
  return n % 2 === 1 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2
}

// ── AssessAtomicResolution ─────────────────────────────────────────────────

/** 「只差尺度」的出局词。落在这一集里 ⇒ 这一帧**没被判成没有原子相**。 */
export const SCALE_ONLY_REASONS: ReadonlySet<string> = new Set(['scale_gate', 'scale_reduced', 'unknown_pixel_size'])

/** 「这一帧回答不了」的出局词（比 {@link SCALE_ONLY_REASONS} 宽：还含两条「数据不够」）。 */
const UNDETERMINED_REASONS: ReadonlySet<string> = new Set([
  'unknown_pixel_size',
  'scale_gate',
  'insufficient_data',
  'scale_reduced',
  'too_few_periods',
])

function coverageOf(m: Mat | null): number {
  if (m === null || m.rows * m.cols === 0) return 0
  let n = 0
  for (let i = 0; i < m.data.length; i += 1) if (Number.isFinite(m.data[i] as number)) n += 1
  return n / m.data.length
}

export const AssessAtomicResolution: Skill = {
  spec: S.AssessAtomicResolutionSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['scan_path'] ?? '')
    const ch = strParam(params, 'channel', 'Z')
    // `requireScale: false` —— 见 `loadFrame` 抬头那张表：没有像素标度时这一族
    // 不报 IO 错，而是让判据环给出机器可判的 `unknown_pixel_size`。
    const fr = loadFrame(path, ch, { requireScale: false })
    if (fr.error) return { success: false, error: loadErrorFor(fr.error, ch) }
    const f = fr.forward as Mat
    const b = fr.backward !== null && fr.backward.rows === f.rows && fr.backward.cols === f.cols ? fr.backward : null
    const nmpp = fr.nmPerPx

    const surface = strParam(params, 'surface', '')
    const expect = surface ? firstOrderPeriodNm(surface) : null
    const cov = coverageOf(f)
    const cmin = numParam(params, 'concentration_min')
    const allow = Boolean(params['allow_reduced_scale'] ?? false)
    const kw = {
      nmPerPx: nmpp,
      expectedANm: expect,
      allowReducedScale: allow,
      ...(cmin === null ? {} : { concentrationMin: cmin }),
    }
    const res = assessAtomicPhase(f, kw)
    // 正扫过了但反扫没过 = 结构只在一个方向上出现 = 多半不是表面结构。
    const resB: AtomicPhaseResult | null = b === null ? null : assessAtomicPhase(b, kw)

    let verdict = res.passed ? 'atomic' : 'absent'
    const notes: string[] = []

    // ── 成像条件闸门 ──（2026-08-26：偏压留在 1.0 V ⇒ 好针尖被打坏）
    const win = checkAtomicWindow(fr.biasV, fr.setpointA, surface || null)
    if (!win.ok) {
      verdict = 'undetermined'
      notes.push(win.detailZh)
    }

    if (!res.passed && res.reasons.some((r) => UNDETERMINED_REASONS.has(r))) {
      verdict = 'undetermined'
      notes.push(`这一帧回答不了（${res.reasons.join(',')}），换尺度或扫完整再判，` + `**不要读成「针尖不好」**`)
    }
    if (cov < 0.5) {
      verdict = 'undetermined'
      notes.push(`只有 ${pyFixed(100 * cov, 0)}% 的像素有数据 —— 扫了几行就停的帧判不了`)
    }
    if (res.passed && resB !== null && !resB.passed) {
      notes.push(
        `反扫没通过（reasons=${pyTupleRepr(resB.reasons)}）—— 结构只在一个扫描方向上出现，` + `多半是针尖或反馈的产物，不是表面结构`,
      )
    }

    const data: Record<string, unknown> = {
      verdict,
      passed_forward: res.passed,
      passed_backward: resB === null ? null : resB.passed,
      scan_path: path,
      channel: ch,
      nm_per_px: res.nmPerPx,
      scale_gate: res.scale,
      coverage: cov,
      period_fast_axis_nm: res.periodFastAxisNm,
      period_radial_nm: res.periodNm,
      snr: res.snr,
      angular_concentration: res.angularConcentration,
      fft_sharpness: res.fftSharpness,
      order_ratio: res.orderRatio,
      expected_period_nm: expect,
      surface: surface || null,
      reasons: [...res.reasons],
      warnings: [...res.warnings, ...notes],
      // 成像条件的结论要**机器可读**：只放在 warnings 里，调用方就得靠匹配中文散文
      // 才能知道「这一帧为什么判不了」。
      imaging_window: {
        ok: win.ok,
        reason: win.reason,
        bias_v: win.biasV,
        setpoint_a: win.setpointA,
        bias_max_v: win.biasMaxV,
        setpoint_min_a: win.setpointMinA,
      },
    }
    const summary = `${verdict}：角向集中度 ${pyFixed(res.angularConcentration, 0)}（真晶格 97-7645 / 抖动 1.8-3.3）`
    return { success: true, data, summary }
  },
}

/**
 * 两个原子相技能的取帧报错与 `AssessScanTexture` 的**措辞不同**，照移。
 *
 * 旧仓 `atomic_lattice._load_frame` 写「文件里没有通道 'Z' 的正扫数据」，
 * 而 `_sxm_frame.load_frame` 写「没有通道 'Z' 的正扫数据」——
 * 两句都在说同一件事，而**模型读的是这一句**。统一成一种写法会让金样里
 * 两条报文有一条对不上，而改掉的正是模型面。
 */
function loadErrorFor(err: string, channel: string): string {
  return err === `没有通道 '${channel}' 的正扫数据` ? `文件里没有通道 '${channel}' 的正扫数据` : err
}

// ── AnalyseAtomicLattice ───────────────────────────────────────────────────

export const AnalyseAtomicLattice: Skill = {
  spec: S.AnalyseAtomicLatticeSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['scan_path'] ?? '')
    const ch = strParam(params, 'channel', 'Z')
    // 同上：`atomic_lattice._load_frame` 把 `null` 原样传下去。
    const fr = loadFrame(path, ch, { requireScale: false })
    if (fr.error) return { success: false, error: loadErrorFor(fr.error, ch) }
    const f = fr.forward as Mat
    const b = fr.backward !== null && fr.backward.rows === f.rows && fr.backward.cols === f.cols ? fr.backward : null
    const nmpp = fr.nmPerPx as number

    let surface = strParam(params, 'surface', 'Au(111)')
    if (['none', '无', ''].includes(surface.toLowerCase())) surface = ''
    const expect = surface ? firstOrderPeriodNm(surface) : null
    if (surface && expect === null) {
      return {
        success: false,
        error:
          `不认识表面 '${surface}'。已知的：${Object.keys(SURFACE_LATTICE_NM).sort().join(', ')}。` + `也可以传 'none' 只测不比。`,
      }
    }

    const allowReduced = Boolean(params['allow_reduced_scale'] ?? false)
    let pre: AtomicPhaseResult | null = null
    if (params['require_atomic'] === undefined ? true : Boolean(params['require_atomic'])) {
      pre = assessAtomicPhase(f, { nmPerPx: nmpp, allowReducedScale: allowReduced })
      if (!pre.passed) {
        // ═══════════════════════════════════════════════════════════════════
        // **只差尺度时不要断言「这是针尖抖动」**
        // ═══════════════════════════════════════════════════════════════════
        // 第一版的拒绝语一律说「量出来的周期是针尖抖动的周期」，而它同一句里
        // 报出的角向集中度可能是 361 —— 真晶格实测 97–7645，抖动 1.8–3.3。
        // **那句话一边断言，一边带着推翻自己的证据。**
        //
        // 2026-08-20 真机：8 nm / 256 px = 0.03125 nm/px 落在过渡带里 ⇒
        // 唯一的出路是 `require_atomic=false`，也就是**连角向集中度那半道真正
        // 有保护力的闸一起关掉**。一道只能整体关的闸，教出来的行为就是整体关。
        const onlyScale = pre.reasons.every((r) => SCALE_ONLY_REASONS.has(r))
        const tail = onlyScale
          ? `这**不是**「没有原子相」——角向集中度 ${pyFixed(pre.angularConcentration, 1)}` +
            `（真晶格 97–7645 / 抖动 1.8–3.3）。要在这个尺度上` +
            `出数，传 allow_reduced_scale=true：` +
            `警告会跟着结果一起给出，而角向集中度那道闸仍然在。`
          : `在它上面量出来的周期是针尖抖动的周期。要强行量就把` + `require_atomic 设 false，但那个数不要拿去定标。`
        return {
          success: false,
          error:
            `这一帧没有通过原子相判别（${pre.reasons.join(',') || '-'}，角向集中度 ` +
            `${pyFixed(pre.angularConcentration, 1)}）——${tail}`,
          data: { angular_concentration: pre.angularConcentration, reasons: [...pre.reasons], scale_only: onlyScale },
        }
      }
    }

    const lat = findLatticePeaks(f, nmpp)
    if (!lat.ok) {
      return { success: false, error: `量不了晶格：${lat.reason}`, data: { reason: lat.reason, warnings: [...lat.warnings] } }
    }
    const dev = expect && lat.periodMeanNm ? lat.periodMeanNm / expect - 1.0 : null
    const latB = b === null ? null : findLatticePeaks(b, nmpp)

    const data: Record<string, unknown> = {
      scan_path: path,
      channel: ch,
      nm_per_px: nmpp,
      surface: surface || null,
      expected_period_nm: expect,
      hexagonal: lat.hexagonal,
      periods_nm: [...lat.periodsNm],
      period_mean_nm: lat.periodMeanNm,
      period_spread: lat.periodSpread,
      deviation_from_expected: dev,
      angles_deg: [...lat.anglesDeg],
      lattice_angle_deg: lat.latticeAngleDeg,
      n_peaks: lat.nPeaks,
      backward_period_mean_nm: latB !== null && latB.ok ? latB.periodMeanNm : null,
      // 用了尺度逃生门就必须**说出来**，而且是跟着数走 —— 一个 0.03 nm/px 的帧上
      // 量到的周期，和一个 0.01 nm/px 上量到的，不该在结果里长得一模一样。
      warnings: [
        ...lat.warnings,
        ...(allowReduced && pre !== null && pre.warnings.includes('scale_reduced')
          ? ['scale_reduced：像素尺度在过渡带 (0.02, 0.05] nm/px，' + '这个周期的证据强度撑不住一次定标，够用来看趋势']
          : []),
      ],
      scale_gate: pre !== null ? pre.scale : null,
    }
    let s = `周期 ${pyFixed(lat.periodMeanNm ?? 0, 4)} nm（三向散布 ${pyFixed(100 * (lat.periodSpread ?? 0), 1)}%），六重=${
      lat.hexagonal ? 'True' : 'False'
    }`
    if (dev !== null) s += `，比 ${surface} 理论值 ${signed(100 * dev, 2)}%`
    return { success: true, data, summary: s }
  },
}



/** 批 4b 的四个技能，按名字索引。 */
export const ANALYSIS_LATTICE: Readonly<Record<string, Skill>> = {
  AssessScanTexture,
  MeasureLatticeCell,
  AssessAtomicResolution,
  AnalyseAtomicLattice,
}
