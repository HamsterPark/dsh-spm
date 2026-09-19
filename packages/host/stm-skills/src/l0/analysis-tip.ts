/**
 * 批 6c 的两个**判针尖**技能 —— `AssessTipSharpness`（从一张 `.sxm`）与
 * `AssessTipFromSpectrum`（从一条 `.dat`）。
 *
 * **只做 IO 与阈值取用，一个判据都不写**（同批 4a/4b 的分工）：判据在
 * `dsh-spm-vision` 的 `tip-metrics.ts` 与 `spectroscopy.ts`。
 *
 * ## 两个技能各自的那一句「判不了不是不合格」
 *
 * | 技能 | 「判不了」长什么样 | 为什么它不能折进「不合格」 |
 * |---|---|---|
 * | `AssessTipSharpness` | `no_step` / `unresolved` | 平坦区上的「边缘宽度」是在量噪声；比采样极限还细的阈值量的是像素栅格 |
 * | `AssessTipFromSpectrum` | `unrated` | **所有阈值都没填**与**每条都通过了**在数值上都是「零个 flag」，而它们是相反的两句话 |
 *
 * `SHARPNESS_VERDICTS` / `TIP_VERDICTS` 两份**闭集**存在的理由是同一件真机事故：
 * 2026-08-11 之前 `ForgeAuTip` 的验收写的是 `verdict in ("good","sharp","ok","pass")`
 * —— 一个**白名单**，于是新增 / 未预料的状态自动落进「不合格」那一侧。
 * `"measured"`（量到了但没给阈值）就是这样被当成不合格的，而那条流程从不传阈值
 * ⇒ 验收**结构上不可能通过**。白名单读起来像在防护，其实它把「没想到的情况」
 * 默默判成了失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { matOf, type Mat } from 'dsh-spm-numerics'
import { readDat } from 'dsh-spm-nanonis-files'
import { judgeFrame, parseXyMeta } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { loadSxm, orient, strParam } from './analysis-common.js'
import { edgeResolution, fwdBwdInstability } from 'dsh-spm-vision'
import { fftSharpness } from 'dsh-spm-vision'
import { assessIv, assessIz } from 'dsh-spm-vision'

// ── AssessTipSharpness ─────────────────────────────────────────────────────

/** `AssessTipSharpness` 能返回的**全部** verdict。调用方必须对每一个都表态。 */
export const SHARPNESS_VERDICTS: readonly string[] = [
  'no_step', // 图里没有台阶 —— 判不了
  'measured', // 量到了，但调用方没给阈值 —— 判不了
  'unresolved', // 阈值细过这张图的采样极限 —— 判不了
  'sharp', // 够尖
  'blunt', // 不够尖
]

/** Python 的 `repr(str)` —— 单引号。 */
function pyRepr(s: string): string {
  return `'${s}'`
}

/**
 * `AssessTipSharpness` —— 台阶边缘的锐利程度 + 正反扫稳定度，从一张 `.sxm` 算出来。
 *
 * ## 为什么**不走** `assess_tip_classical`
 *
 * 那个函数开头有一道 `if h.std() < 1e-9: return 全零` 的守卫，单位是**米** ——
 * 而 Au(111) 的单原子台阶只有 236 pm，一帧漂亮的贵金属台阶图去趋势之后 std 就在
 * `1–2e−10`，**正好落在那道守卫下面**。也就是说：修针最该用它的那种图，它恰好
 * 全部早退，报回 `fft_sharpness=0 / edge=None`，读起来像「这张图没东西」。
 *
 * 所以这里只共用**判据函数**，预处理自己做 —— 走三家共用的 `judgeFrame`
 * （行中值 + 平面 + float32，与那道守卫是同一份去趋势，所以行为逐字节不变）。
 *
 * ## 几何归位只有一份实现
 *
 * 2026-08-11 之前这里直接拿 `ch["backward"]` 的**裸块**喂 `_fwd_bwd_instability`
 * —— 而 `.sxm` 的反扫是从右往左采的，存下来就是镜像。也就是说这道判据一直在拿
 * 一张图和**它自己的镜像**比。真机 76 帧实测，错法在两个方向上都会说谎
 * （有横向结构的帧假失败 1.0000 → 0.0281；`f(y)` 型的帧假通过 0.051 → 0.407）。
 */
export const AssessTipSharpness: Skill = {
  spec: S.AssessTipSharpnessSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const scanPath = String(params['scan_path'] ?? '')
    const channelName = strParam(params, 'channel', 'Z')
    if (!existsSync(scanPath)) return { success: false, error: `文件不存在: ${scanPath}` }
    const load = loadSxm(scanPath)
    if (!load.ok) return { success: false, error: `.sxm 读取失败: ${load.plain}` }
    const scan = load.scan

    let oriented = orient(scan, channelName)
    if (oriented.forward === null) {
      // 指名的通道没有 → 退回文件里的第一个通道（旧行为，原样保留）。
      const first = Object.keys(scan.channels ?? {})[0]
      if (first === undefined) {
        return { success: false, error: `文件里没有可用通道(要的是 ${pyRepr(channelName)})` }
      }
      oriented = orient(scan, first)
    }
    const fwd = oriented.forward
    const bwd = oriented.backward
    if (fwd === null) return { success: false, error: '通道里没有正扫/反扫数据' }
    const bwdArr = bwd !== null && bwd.rows === fwd.rows && bwd.cols === fwd.cols ? bwd : null

    let nmPerPx: number | null = null
    const meta = parseXyMeta(scan.header as Readonly<Record<string, unknown>>)
    if (meta !== null && fwd.cols) nmPerPx = (meta.w / fwd.cols) * 1e9

    const frame = judgeFrame(fwd)
    if (!frame.usable) {
      // `FrameVerdict.meta(**extra)` —— **`None` 的 extra 不进 dict**（旧仓那一行
      // 的 `if v is not None`）。「判不了」这件事本身也要带着可核对的证据。
      const data: Record<string, unknown> = {
        frame_usable: false,
        corrugation_rms_m: frame.corrugationRmsM,
        unusable_reason: frame.reason,
        scan_path: scanPath,
        rows: fwd.rows,
        cols: fwd.cols,
      }
      if (nmPerPx !== null) data['nm_per_px'] = nmPerPx
      return { success: false, error: frame.reason, data }
    }
    const h = frame.detrended as Mat
    const std = frame.corrugationRmsM
    // `_detrend(h) / std` —— float32 数组 ÷ **Python 弱标量** ⇒ 仍是 float32。
    const hn = matOf(h.rows, h.cols, Float64Array.from(h.data, (v) => Math.fround(v / std)))

    const edge = edgeResolution(hn, nmPerPx)
    const sh = fftSharpness(hn, nmPerPx)
    const instab = bwdArr !== null ? fwdBwdInstability(fwd, bwdArr) : null

    const data: Record<string, unknown> = {
      scan_path: scanPath,
      edge_resolution_nm: edge.widthNm,
      edge_resolution_px: edge.widthPx,
      fwd_bwd_instability: instab,
      fft_sharpness: sh.sharpness,
      has_lattice: sh.hasLattice,
      corrugation_rms_m: std,
      nm_per_px: nmPerPx,
      has_step: edge.widthNm !== null || edge.widthPx !== null,
    }

    const thrRaw = params['sharp_edge_nm']
    const thr = thrRaw === undefined || thrRaw === null || thrRaw === '' ? null : Number(thrRaw)
    let summary: string
    if (edge.widthNm === null) {
      // 平坦帧上量「边缘宽度」是在量噪声 —— 判不了就说判不了。
      data['verdict'] = 'no_step'
      summary = '这张图里没有清晰台阶,判不了针尖锐利度 —— 换一块有台阶的地方再扫一张。'
    } else if (thr === null) {
      data['verdict'] = 'measured'
      summary = `台阶边缘 10-90 宽度 ${pyFixed(edge.widthNm, 2)} nm（未给判定阈值）`
    } else {
      // ── 阈值必须是这张图分辨得出的 ───────────────────────────────────
      //
      // 10-90 宽度不可能小于 2 个采样点（Nyquist）。所以要在「≤ thr」与「> thr」
      // 之间做判定，`thr` 本身必须 ≥ 2×nm_per_px —— 否则两侧的答案都落在同一个
      // 像素里，量的是像素栅格不是针尖。
      //
      // 这道闸非有不可：2026-08-11 真机 72 帧实测，边缘宽度中位数 **1.21 px**
      // （41.7% ≤ 1 px）、换算 0.73 nm。也就是说在当时的验收图上，**随便给一个
      // 合理阈值，每一帧都会判「够尖」** —— 而那是「分辨不出来」，不是「针尖尖」。
      // 把一根钝针判成合格，比「永远不合格」更危险：流程会带着它做后面所有实验。
      const floorNm = nmPerPx !== null && nmPerPx ? 2.0 * nmPerPx : null
      if (floorNm !== null && thr < floorNm) {
        data['verdict'] = 'unresolved'
        data['sharp_edge_nm'] = thr
        data['sampling_floor_nm'] = floorNm
        summary =
          `判不了(不是不合格):阈值 ${pyFixed(thr, 2)} nm 比这张图的采样` +
          `极限 ${pyFixed(floorNm, 2)} nm 还小(${pyFixed(nmPerPx as number, 3)} nm/px × 2)。` +
          `量到的 ${pyFixed(edge.widthNm, 2)} nm 只反映像素大小。` +
          `把验收图扫细到 **≤ ${pyFixed(thr / 2, 3)} nm/px**` +
          `(同视野加像素,或缩小视野)再判。`
      } else {
        const isSharp = edge.widthNm <= thr
        data['verdict'] = isSharp ? 'sharp' : 'blunt'
        data['sharp_edge_nm'] = thr
        summary =
          `台阶边缘 ${pyFixed(edge.widthNm, 2)} nm ` +
          `${isSharp ? '≤' : '>'} 阈值 ${pyFixed(thr, 2)} nm — ` +
          `${isSharp ? '够尖' : '还不够尖'}`
      }
    }
    return { success: true, data, summary }
  },
}

// ── AssessTipFromSpectrum ──────────────────────────────────────────────────

/** 针尖裁决的闭集。**四态**，与谱质量那一层同构：「判不了」永远不折进「不行」。 */
export const TIP_VERDICTS: readonly string[] = ['tip_ok', 'tip_suspect', 'tip_bad', 'unrated']

/** 清洁金属针尖的表观势垒区间（eV）。**有依据的**默认：κ ≈ 0.5123·√φ，金属功函数 4–5 eV。
 * 宽到 3.0–8.0 是刻意的 —— 这道闸要拦的是「明显不在隧道区」，不是给势垒做测量。 */
export const DEFAULT_BARRIER_EV_MIN = 3.0
/** 见 {@link DEFAULT_BARRIER_EV_MIN}。 */
export const DEFAULT_BARRIER_EV_MAX = 8.0

/** 反扫列的标记。Nanonis 真机列名是 `Current [bwd] (A)`。 */
const BWD_MARKERS: readonly string[] = ['[bwd]', 'bwd', 'backward']
const BIAS_PATTERNS: readonly (readonly string[])[] = [['bias'], ['voltage'], ['v (v)']]
const CURRENT_PATTERNS: readonly (readonly string[])[] = [['current'], ['i (a)']]
/** I(z) 的扫描轴。`Z (m)` 在 I(V) 的 `.dat` 里通常只出现在**头**里（恒定值），
 * 出现在 `[DATA]` 段里才说明它在被扫。 */
const Z_PATTERNS: readonly (readonly string[])[] = [['z rel'], ['z (m)'], ['z spectr']]

function isBackward(name: string): boolean {
  const low = name.toLowerCase()
  return BWD_MARKERS.some((m) => low.includes(m))
}

/**
 * 按子串组合挑一列，**显式**区分正/反扫。
 *
 * 通用的取列 helper 返回**第一个**含子串的列，正反扫只靠字典顺序区分 —— 真机列序
 * 恰好是 `Current (A)` 在 `Current [bwd] (A)` 之前，所以今天碰巧对。那是运气不是
 * 设计：换一台机器就会静默取错方向，而两列都是电流、量级也一样，没有任何下游判据
 * 会报警。
 */
export function pickDirectional(
  columns: readonly string[],
  patterns: readonly (readonly string[])[],
  backward: boolean,
): string | null {
  for (const pats of patterns) {
    for (const name of columns) {
      const low = name.toLowerCase()
      if (pats.every((p) => low.includes(p)) && isBackward(name) === backward) return name
    }
  }
  return null
}

/**
 * `(kind, 原文)` —— 头里的 `Experiment` 字段**声称**这是什么谱。
 *
 * 只作交叉检验：字段标签会说谎（它是仪器软件上一次的设置留下的），**数据说了算**。
 */
export function headerKind(header: Readonly<Record<string, unknown>>): [string, string] {
  const raw = String(header['Experiment'] ?? '').trim()
  const low = raw.toLowerCase()
  if (low.includes('bias')) return ['iv', raw]
  if (low.startsWith('z') || low.includes('z spectr')) return ['iz', raw]
  return ['', raw]
}

/**
 * 把逐条判据的结论收成一个裁决。
 *
 * 没有任何一条判据真的参与过（`gated` 空）⇒ `unrated`。**这一条比什么都重要**：
 * 「所有阈值都没填」和「每条都通过了」在数值上都是「零个 flag」。
 */
export function toTipVerdict(flags: readonly string[], gated: readonly string[]): string {
  if (gated.length === 0) return 'unrated'
  if (flags.length === 0) return 'tip_ok'
  return flags.length >= 2 ? 'tip_bad' : 'tip_suspect'
}

/** `params.get(k)` 的 Python 语义：**键不在**与**键在但是 None**都给 `null`。 */
function optNum(params: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = params[key]
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** `params.get(k, d)` 的 Python 语义：键**不在**才用默认；键在但是 `None` ⇒ `null`。 */
function optNumOr(params: Readonly<Record<string, unknown>>, key: string, fallback: number): number | null {
  if (!(key in params)) return fallback
  return optNum(params, key)
}

/**
 * `AssessTipFromSpectrum` —— 从一条存盘的 `.dat` 谱反推针尖状态（只读文件，不碰硬件）。
 *
 * ## 它与 `AssessSpectrum` 是两件事，别合并
 *
 * | | 回答什么 |
 * |---|---|
 * | `AssessSpectrum` | **这条数据留不留**（饱和、信噪、正反扫迟滞…） |
 * | 本技能 | **这根针行不行**（I(z) 是不是单指数、I(V) 有没有跳变） |
 *
 * 一条 `discard` 的谱可能只是窗口开错了、相位反了、表面不是那个面 —— 针尖完全
 * 没问题。反过来，一条数据质量挑不出毛病的谱，也可能是一根双针尖测出来的。
 * 两件事分开放，是为了不让下游把「这条谱不好」读成「这根针不行」，然后去反复修
 * 一根其实没问题的针（本仓在「在自己刚炸出来的坑上判针尖」上栽过六版）。
 *
 * ## 未标定的阈值只能说「判不了」
 *
 * I(z) 的表观势垒有物理量纲（清洁金属针尖 4–5 eV），所以它**有**一个可以写下依据
 * 的默认区间；I(V) 的 `smoothness` / `symmetry` 是无量纲的形状分，**没有**。
 * 凡是没标定的，这里只报数、给 `unrated`，**不出坏裁决**。
 */
export const AssessTipFromSpectrum: Skill = {
  spec: S.AssessTipFromSpectrumSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['dat_path'] ?? '')
    if (!existsSync(path)) return { success: false, error: `文件不存在: ${path}` }
    let dat
    try {
      dat = readDat(readFileSync(path), path)
    } catch (e) {
      return { success: false, error: `.dat 读取失败: ${(e as Error).message}` }
    }
    const columns = dat.columns
    const header = dat.header
    const names = Object.keys(columns)
    if (names.length === 0) return { success: false, error: '.dat 里没有 [DATA] 段' }

    const curName = pickDirectional(names, CURRENT_PATTERNS, false)
    if (curName === null) {
      // 文件读得动、但没有电流列 ⇒ **如实回答「判不了」**，不是「没做成」。
      return {
        success: true,
        data: { verdict: 'unrated', reasons: ['no_current_column'], gated_criteria: [], dat_path: path },
      }
    }
    const zName = pickDirectional(names, Z_PATTERNS, false)
    const vName = pickDirectional(names, BIAS_PATTERNS, false)

    const want = strParam(params, 'kind', 'auto').toLowerCase()
    const [hKind, hRaw] = headerKind(header as Readonly<Record<string, unknown>>)
    // 数据说了算：谁在被扫，谁就是自变量。头只作交叉检验。
    const kind = want === 'auto' ? (zName !== null ? 'iz' : vName !== null ? 'iv' : '') : want
    if (kind === '') {
      return {
        success: true,
        data: {
          verdict: 'unrated',
          reasons: ['no_sweep_column'],
          gated_criteria: [],
          dat_path: path,
          header_says: hRaw,
        },
      }
    }

    const I = columns[curName] as Float64Array
    const flags: string[] = []
    const gated: string[] = []
    const notes: string[] = []
    let metrics: Record<string, unknown> = {}
    if (hKind !== '' && kind !== '' && hKind !== kind) {
      // 不拦，只说：两个来源不一致本身是一条值得看见的信息。
      notes.push(`header_says=${pyRepr(hRaw)}，而数据看起来是 ${kind}`)
    }
    const maxJumps = optNum(params, 'max_jumps')

    if (kind === 'iz') {
      if (zName === null) {
        return {
          success: true,
          data: { verdict: 'unrated', reasons: ['no_z_column'], gated_criteria: [], dat_path: path },
        }
      }
      const zM = columns[zName] as Float64Array
      const res = assessIz(Float64Array.from(zM, (v) => v * 1e9), I) // 纯函数吃 nm
      metrics = {
        is_clean_exponential: res.is_clean_exponential,
        fit_r2: res.fit_r2,
        barrier_ev: res.barrier_ev,
        decay_per_nm: res.decay_per_nm,
        n_jumps: res.n_jumps,
      }
      // 「是不是一条干净的单指数」由判据本体自己回答（它内含拟合质量与跳变数）。
      // 这一条**默认参与判决**：一条不是单指数的 I(z) 本身就是针尖信号。
      gated.push('clean_exponential')
      if (!res.is_clean_exponential) flags.push('not_clean_exponential')

      const minR2 = optNum(params, 'min_fit_r2')
      if (minR2 !== null) {
        gated.push('fit_r2')
        if (res.fit_r2 < minR2) flags.push('fit_r2_below_min')
      }

      const bMin = optNumOr(params, 'barrier_ev_min', DEFAULT_BARRIER_EV_MIN)
      const bMax = optNumOr(params, 'barrier_ev_max', DEFAULT_BARRIER_EV_MAX)
      if (bMin && bMax && bMax > bMin) {
        if (res.barrier_ev === null) {
          // 拟合不出势垒 ⇒ 这一条判不了，**不是**「势垒不对」。
          notes.push('barrier_ev 拟合不出来 —— 这一条没参与判决')
        } else if (!res.is_clean_exponential) {
          // ⚠️ 真机纪律：**在一条不是指数的曲线上，「指数拟合的斜率」没有物理意义**。
          // 纯噪声照样能 polyfit 出一个斜率，于是也照样能换算出一个「势垒」——
          // 那个数不是读数，是拟合的副产物。拿它去判针尖，就是在自己刚造出来的数上
          // 做判决。曲线的问题已经由 clean_exponential 说了。
          notes.push('拟合站不住（不是单指数），势垒值没有物理意义 —— 这一条没参与判决')
        } else {
          gated.push('barrier_ev')
          if (!(bMin <= res.barrier_ev && res.barrier_ev <= bMax)) flags.push('barrier_outside_window')
        }
      }

      if (maxJumps !== null) {
        gated.push('n_jumps')
        if (res.n_jumps > maxJumps) flags.push('too_many_jumps')
      }
    } else {
      if (vName === null) {
        return {
          success: true,
          data: { verdict: 'unrated', reasons: ['no_bias_column'], gated_criteria: [], dat_path: path },
        }
      }
      const V = columns[vName] as Float64Array
      const res = assessIv(V, I)
      metrics = {
        is_stable: res.is_stable,
        smoothness: res.smoothness,
        symmetry: res.symmetry,
        n_spikes: res.n_spikes,
        gap_ev: res.gap_ev,
      }
      if (maxJumps !== null) {
        gated.push('n_spikes')
        if (res.n_spikes > maxJumps) flags.push('too_many_spikes')
      }
      const minSm = optNum(params, 'min_smoothness')
      if (minSm !== null) {
        gated.push('smoothness')
        if (res.smoothness < minSm) flags.push('smoothness_below_min')
      }
      const minSym = optNum(params, 'min_symmetry')
      if (minSym !== null) {
        gated.push('symmetry')
        if (res.symmetry < minSym) flags.push('symmetry_below_min')
        notes.push('symmetry 参与了判决 —— 注意带隙/不对称衬底会让一根好针看起来不对称')
      }
    }

    const all = kind === 'iz' ? ['clean_exponential', 'fit_r2', 'barrier_ev', 'n_jumps'] : ['n_spikes', 'smoothness', 'symmetry']
    return {
      success: true,
      data: {
        verdict: toTipVerdict(flags, gated),
        kind,
        reasons: flags,
        gated_criteria: gated,
        ungated_criteria: all.filter((c) => !gated.includes(c)),
        metrics,
        notes,
        dat_path: path,
      },
    }
  },
}

/** 这个文件里的两个技能。 */
export const ANALYSIS_TIP: Readonly<Record<string, Skill>> = {
  AssessTipSharpness,
  AssessTipFromSpectrum,
}
