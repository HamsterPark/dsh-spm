/**
 * `FindFlatRegion` —— 在一张 `.sxm` 上滑窗，交出**局部残差 RMS 最低**的那一块。
 *
 * 判据件（`kdeLayers` / `planeSubtractRobust` / `noiseFloor` / `judgeFrame` /
 * `parseXyMeta` / `pxToM`）全在 `dsh-spm-vision`，读文件在 `dsh-spm-nanonis-files`，
 * SI 解析在 `dsh-spm-kernel`。**只有 `localPlaneRms` 住在这里** ——
 * 它是旧仓写在技能文件里的私有判据，本仓此刻也只有这一个消费方
 * （而 `vision/` 这一轮由别的支线主用，见批 7a 的地盘划分）。
 *
 * ## 这个技能最贵的地方不是判据，是它自己
 *
 * 十一个参数、两次不同步长的扫描、三条各带「换小一档」探测的失败路径、
 * 一条 `count > 1` 的多落点路径。逐条照移，下面把**每一条为什么在那里**
 * 抄在它旁边 —— 那些理由全部来自真机，删一条就等于把那一天重演一遍。
 *
 * ## 「这块有多平」不是「这块离全帧平面多远」
 *
 * `localPlaneRms` 在**窗内自己**再拟合一次平面。旧仓 2026-08-14 之前用的是
 * 整帧去平面后的 `sqrt(mean(patch²))` —— 那是「这个窗离全帧平面多远」，
 * 在有台阶的表面上**系统性地指向相反的窗**：一块干净的单台面只要整体高出一个
 * 台阶就被判成很不平，而一个跨台阶的窗两半分踞全局平面上下，平均起来反而很贴近。
 * 真机 `_0182` 实测：旧判据挑中的窗局部残差 54.5 pm，全帧真正最平的是 3.9 pm
 * （13.8×）；两个排序的 Spearman 只有 +0.373，而**台阶越多相关性越低**
 * （无台阶帧 ρ=+0.94，密集阶梯帧 ρ=+0.08）。
 *
 * ## 三条**旧仓有、本仓不可达**的路（照移的反面：证明它不可达，不留没有闸的守卫）
 *
 * | 旧仓那一支 | 本仓为什么到不了 |
 * |---|---|
 * | `except ImportError ⇒ "missing dependency: {e}"` | 依赖是编译期的 import，不是运行期的 |
 * | `except Exception ⇒ leveled = img − nanmean(img)` | `planeSubtractRobust` **拟合失败时原样返回**，不抛 |
 * | `except Exception ⇒ terrace_note`（分割失败） | `kdeLayers` 这条链上没有会抛的东西（见下） |
 *
 * 第三条**留着**：`kdeLayers` 会抛 —— `gradient2dUniform` 在轴长 < 2 时抛
 * （`np.gradient` 同）。一张 1×N 的帧走得到，而 `judgeFrame` 只挡 `cols < 2`，
 * **不挡 `rows < 2`**。所以那一支在本仓是可达的，照移。
 *
 * ## ⚠️ `exclude_used_spots` **不是会话态**
 *
 * 批 7a 的任务书把它列成「会话态」。逐行核过：它是一个**纯参数** ——
 * 一个分号分隔的坐标串，由调用方每次传进来，`_parse_excluded` 当场解析完就用掉，
 * 技能自己不记任何东西。`SkillContext` 一个字节都不需要。
 * （真正需要跨调用记忆的是 `FindCleanSpot` 的实验地图，那是批 7a-2 的事。）
 */
import {
  parseQuantity,
  pyFixed,
  pyRound,
  SIParseError,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { EPS, matOf, matSlice, std, type Mat } from 'dsh-spm-numerics'
import {
  judgeFrame,
  kdeLayers,
  lstsqPlane,
  nanMean,
  noiseFloor,
  parseXyMeta,
  planeSubtractRobust,
  pxToM,
} from 'dsh-spm-vision'
import { existsSync } from 'node:fs'
import * as S from '../generated/specs.js'
import { loadSxm, numOr, orient, strParam } from './analysis-common.js'
import { fail, ok, pyExp } from './common.js'

/**
 * `same_terrace` 判据：窗内属于同一台面层的像素比例下限。
 *
 * 留 2% 余量给台面层标签在边界上的抖动（中值滤波之后仍会有几个像素摇摆），
 * 不给跨台阶的窗留活路。
 */
export const SAME_TERRACE_FRAC = 0.98

/**
 * 「这块配得上叫可用平区」的绝对线（局部平面拟合残差 RMS，米）。
 *
 * **常量。不许写成 `max(25 pm, k × 噪声底)` 或任何自适应形式。**
 * 自适应项能被一张脏图推上去 —— 2026-08-11 实测：噪声底 7.4 pm 的那张帧上
 * `5×噪声 = 37 pm` 会压过物理线，把「阈值随帧漂移」的毛病按比例请回来。
 * 要留裕度就直接调这个常数，让它留在版本历史里。
 *
 * 怎么来的（2026-08-11，88 张真机帧，三个**实测**总体）：
 *
 * | 总体 | 局部残差 | 应当 |
 * |---|---|---|
 * | 干净 Au(111) 台面（含 herringbone 起伏） | 3.2 – 12.8 pm | 通过 |
 * | 全批最差的行差分噪声底 | 7.4 pm | 通过 |
 * | 台面上有吸附物 | 16 – 41 pm | 多数不通过 |
 * | 一个 236 pm 台阶被抹开 35% | 38 pm | 不通过 |
 * | 一个锐利的 236 pm 单原子台阶 | 63 pm | 不通过 |
 *
 * **独立佐证**：现场逐帧判定了 6 种分割算法的对错（48 个判定），最能复现他
 * 那批判定的切点是 **21–25 pm（94%）**。表面物理与他的眼睛这两条毫不相干的
 * 推导落在同一条线上 —— 这是这个数最强的支撑。
 */
export const USABLE_FLAT_RMS_M = 25e-12

/**
 * 「我找过了，这里没有可用平区」的**机器可读**标记。
 *
 * **不是**「我没法找」—— 两者的下一步完全不同：前者「换一块再扫」，
 * 后者「退回几何选点并声明这几针没有平坦性保证」。从前只有 `success=False`
 * 一个信号，调用方把两件事一起读成「判不了」，于是「找不到就扩大范围继续找」
 * 那条重扫循环**从来没被走到过**（2026-08-16 真机：`flatness_unavailable=4/6`，
 * `dry_refills` 0 次）。
 */
export const VERDICT_NO_USABLE_REGION = 'no_usable_region'

/** 一个窗里至少要有这么多有限点才谈得上拟合（3 个自由度）。 */
const MIN_FIT_POINTS = 12

/** 窗内 NaN 上限：有效点少于一半的窗直接跳过。 */
const MAX_NAN_FRAC = 0.5

/** 粗扫说不出「没有」时，补一次这么细的扫（窗边长的 1/8）。 */
const FINE_STRIDE_DIV = 8

/** 小于这么多像素的窗要带**尺度自白**（见 `scale_caveat`）。 */
const SCALE_CAVEAT_PX = 24

/**
 * {@link localPlaneRms} 对旧仓的容差 —— **绝对**，按窗内 z 的量程给。
 *
 * ## 为什么是绝对的，而且分母是 `zSpan` 不是 `rms`
 *
 * 输出是 `std(z − A·c*)`，而 `c*` 是同一个最小二乘问题的解。三段：
 *
 * 1. **解本身的差**（本仓中心化正规方程 vs numpy 的 SVD）对结果是**二阶**的 ——
 *    在 `‖z − Ac‖²` 的极小点上，`S(c*+Δ) = S(c*) + ΔᵀAᵀAΔ`。`|Δ| ~ κ·eps·|c*|`，
 *    κ 在 24 px 的窗上是 10² 量级 ⇒ 这一项在 `1e−26` 相对量级，**可以忽略**；
 * 2. **减法那一步**是主项：`z − (a·x + b·y + c)` 的每个元素带 `eps·max|z|` 的
 *    舍入，**与残差本身多小无关** —— 残差是相消的结果，而相消毁掉相对精度、
 *    不毁绝对精度（`numerics.md` 第四节第一条）；
 * 3. 归约（两遍法的均值与离差平方和）与一次 `sqrt` 合起来不到一份 `eps·√n`。
 *
 * ⇒ 界是 **`k · eps · zSpan`**。实测最坏的一格（判据本体那一节的 `pure_plane`，
 * 残差只剩浮点噪声）用掉 `10 · eps · zSpan`，技能那一节最坏 `4 · eps · zSpan`
 * ⇒ 取 **`k = 128`**，约 **12 倍余量**（与 `convRelTol` 那条 41 倍、
 * `RANSAC_REL_TOL` 那条 20 倍同一个口径）。
 *
 * ### 一条**相对**容差在这里会问错问题
 *
 * 「纯平面」那一格的残差是 `3.3e−25`（只剩浮点噪声），而窗内 z 量程是
 * `7.5e−11` —— 两边的答案差了一倍（`1.6e−25` vs `3.3e−25`），
 * **而那正是正确的**：两个都是零，各自的舍入路径不同。一条按 `rms` 归一的
 * 相对容差在这一格上要求第 25 位对上，那不是判据，那是在量噪声。
 * 这是批 6c §9③「容差是一个三元组（量、误差来源、**入口**）」的同一条：
 * **入口是 z 的量程，不是残差。**
 */
export function localRmsAbsTol(zSpanM: number): number {
  return 128 * EPS * Math.abs(zSpanM)
}

/**
 * 窗内**自己**拟合一个平面之后的残差 RMS ——「这块有多平」。
 *
 * 有效点太少返回 `null`（那个窗判不了，跳过，而不是给它一个凑出来的分）。
 *
 * ## ⚠️ 设计矩阵奇异时本仓给 `null`，**旧仓给 0**（D-FLAT-? ，不照抄）
 *
 * 12 个以上的有效点全落在**同一行**（真机上是 NaN 挖出来的形状）时，
 * `[x, y, 1]` 掉秩。`np.linalg.lstsq` 走 SVD，给一个**最小范数解** ——
 * 而一条直线被一个平面拟合的残差恰好是 0，于是旧仓报
 * `rms = 4.5e−28`：**一块完美的平地**。那个窗会赢下 `argmin`，
 * 调用方拿着它的坐标去移动针尖。
 *
 * 这与本技能自己那道前置（`judge_frame` 拦「死平帧」）挡的是同一件事，
 * 原话就在那里：「读起来像『找到了一块完美的平地』，而调用方拿这个坐标去移动
 * 针尖」。⇒ 按 DoD ⑤ **不照抄**：判不了就是判不了，返回 `null`，那个窗跳过。
 * （本仓的 `lstsqPlane` 走正规方程，掉秩时 Cholesky 抛 ⇒ 它**天然**给 `null`。
 * 这不是「碰巧」—— `fit.ts` 的抬头写着「不满秩就抛：一个不满秩的系统解出来的是
 * 『某一个解』，而调用方会把它当成『那个解』」。）
 */
export function localPlaneRms(patch: Mat): number | null {
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  for (let r = 0; r < patch.rows; r += 1) {
    for (let c = 0; c < patch.cols; c += 1) {
      const z = patch.data[r * patch.cols + c] as number
      if (!Number.isFinite(z)) continue
      xs.push(c)
      ys.push(r)
      zs.push(z)
    }
  }
  // 3 个自由度，少于 12 点的拟合残差没有意义（窗口本来就有 50% NaN 上限）
  if (zs.length < MIN_FIT_POINTS) return null
  const coeff = lstsqPlane(xs, ys, zs)
  if (coeff === null) return null
  const [a, b, c0] = coeff
  const resid = new Float64Array(zs.length)
  for (let i = 0; i < zs.length; i += 1) {
    resid[i] = (zs[i] as number) - (a * (xs[i] as number) + b * (ys[i] as number) + c0)
  }
  return std(resid)
}

/**
 * `"1n,2n;3n,-1n"` → `[[[1e-9, 2e-9], [3e-9, -1e-9]], []]`。
 *
 * 两处都是旧仓 2026-08-04 改的，起因是同一件事：
 *
 * 1. **接受 SI 前缀。** 有量纲参数整体走字符串通道，模型到处被教「写 '100n'
 *    不要写 1e-7」—— 它多半会把这个习惯带到这个自由格式串里来。
 * 2. **解析不了要说出来，不能静默跳过。** 原来是 `except ValueError: continue`
 *    —— 于是「排除这几个已用过的点」会悄悄变成「一个都不排除」，然后技能
 *    **高高兴兴地把针尖送回刚才那个坏点**。它不报错、不降级、没有任何痕迹。
 */
export function parseExcluded(s: string): readonly [readonly (readonly [number, number])[], readonly string[]] {
  const out: [number, number][] = []
  const bad: string[] = []
  for (const raw of (s || '').split(';')) {
    const chunk = raw.trim()
    if (chunk === '') continue
    const parts = chunk.split(',')
    // Python 的 `x_s, y_s = chunk.split(",")` 在不是两段时抛 ValueError。
    if (parts.length !== 2) {
      bad.push(chunk)
      continue
    }
    try {
      out.push([
        parseQuantity(parts[0], { strict: false, what: 'x' }),
        parseQuantity(parts[1], { strict: false, what: 'y' }),
      ])
    } catch (e) {
      if (e instanceof SIParseError || e instanceof RangeError || e instanceof TypeError) bad.push(chunk)
      else throw e
    }
  }
  return [out, bad]
}

interface Candidate {
  readonly rms: number
  readonly cxM: number
  readonly cyM: number
  readonly px: readonly [number, number]
}

export const FindFlatRegion: Skill = {
  spec: S.FindFlatRegionSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const scanPath = String(params['scan_path'] ?? '')
    const windowFrac = numOr(params, 'window_fraction', 0.2)
    const strideFrac = numOr(params, 'stride_fraction', 0.5)
    const channelName = strParam(params, 'channel', 'Z')
    const exclStr = params['exclude_used_spots'] === null || params['exclude_used_spots'] === undefined
      ? ''
      : String(params['exclude_used_spots'])
    let minSep = numOr(params, 'min_separation_m', 0)
    const minWindowM = numOr(params, 'min_window_m', 0)
    const sameTerrace = Boolean(params['same_terrace'])
    // 2026-08-14：一次要多个平区（扎针落点）。1 = 历史行为，逐字不变。
    const wantCount = Math.max(1, Math.trunc(numOr(params, 'count', 1) || 1))
    // 落点间距 —— 与上面 `minSep`（排除距离）是**两个**参数。
    // 2026-08-25 之前它们同名，那一行读到的其实是排除距离，于是这一条
    // （连同它的扎针避让指示与 max_value）**从上线起一次都没到达过模型**。
    const rawSpacing = numOr(params, 'min_site_spacing_m', 0)
    const minSepM: number | null = rawSpacing ? rawSpacing : null
    // 绝对线可以被调用方**显式**覆写，但默认是常量。这与被禁掉的
    // `max(25 pm, k×噪声)` 不是一回事：那个是**帧自己**把线推上去（脏图 ⇒ 线变松
    // ⇒ 越脏越容易过），而这个是调用方写出来的一个数，看得见、进得了版本历史。
    const usableRmsM = numOr(params, 'usable_rms_m', 0) || USABLE_FLAT_RMS_M

    // 参数校验排在**加载 .sxm 之前**：一个写错的坐标串不该等到分析完一整张图
    // 才被指出来，而且此刻还没有任何东西可以「凑合着用」。
    //
    // **拒绝，不要凑合。** 这个参数的意思是「别再选这几个点」，而看不懂的那几块
    // 正是要避开的位置。忽略它们等于把针尖送回刚才那个坏点，而调用方会以为
    // 回避生效了 —— 挑出来的点看起来和正常结果一模一样。
    const [excluded, badExcl] = parseExcluded(exclStr)
    if (badExcl.length > 0) {
      return fail(
        'exclude_used_spots 里有解析不了的坐标: ' +
          badExcl.slice(0, 5).join('; ') +
          '。每一项写成 `x,y`,分号分隔,数值可带 SI 前缀' +
          "(如 '100n,-50n;1.2u,0')。**没有把这些点排除掉就选点是危险的**" +
          '—— 它们正是你要避开的位置。',
      )
    }

    if (!existsSync(scanPath)) return fail(`scan_path not found: ${scanPath}`)
    const load = loadSxm(scanPath)
    if (!load.ok) return fail(`failed to read .sxm: ${load.plain}`)
    const scan = load.scan

    // 取形貌通道，**经几何归位的单一真源** `sxmOrientedFrames`：
    // 正扫优先；反扫左右翻转（它是从右往左采的）；`:SCAN_DIR: up` 上下翻转。
    // 不看 `scan_dir` 的话 `pxToM` 的前提（row 0 = 最大 y）不成立 ⇒ 报出来的 y
    // 会差半帧（60 nm 帧上实测 42.9 nm），**而且一声不响**。
    let oriented = orient(scan, channelName)
    if (oriented.forward === null) {
      const channels = scan.channels as Readonly<Record<string, unknown>>
      const first = Object.keys(channels)[0]
      if (first === undefined) return fail(`no usable channel in ${scanPath}`)
      oriented = orient(scan, first)
    }
    const img = oriented.forward
    if (img === null) return fail('no forward/backward frame in selected channel')

    // ── 这一帧能不能判（三家共用的前置，2026-08-10）──────────────────────
    //
    // 「最平的那块在哪」在一帧**死平**的图上是个没有答案的问题：每一块都并列第一。
    // 2026-08-10 真机的两张废帧上本技能给的是 `rms_m = 0.00` 且一声不吭 ——
    // 读起来像「找到了一块完美的平地」，而调用方拿这个坐标去移动针尖。
    //
    // 注意这道前置拦的**不是**「很平」：一块真正原子级平坦的 Au(111) 台面仍有
    // pm 级起伏（单原子台阶 236 pm），它照常通过。拦的是「这帧不含任何信息」。
    const frame = judgeFrame(img)
    if (!frame.usable) {
      return fail(frame.reason, {
        frame_usable: false,
        corrugation_rms_m: frame.corrugationRmsM,
        unusable_reason: frame.reason,
        scan_path: scanPath,
        rows: img.rows,
        cols: img.cols,
      })
    }

    // 去趋势的**单一真源**是 `vision/tilt.plane_subtract`（RANSAC + 随图自适应的
    // 内点阈）。2026-08-14 之前这里用的是 `data.processors.plane_subtract`
    // （普通 OLS）——**它会把台阶抹平**：真机 10 帧实证，用高度直方图数平台，
    // OLS 给 1-2 个峰、RANSAC 给 5-6 个。现场要求：可以用于论文发表，
    // 但不可用于数据分析。
    const leveled = planeSubtractRobust(img)
    const ny = leveled.rows
    const nx = leveled.cols

    // 扫描几何：用 `parseXyMeta` 而不是自己 split —— 它是仓库里唯一同时处理
    // `scan_angle` 的几何解析入口。之前这里只取 offset/range，扫描框一旦旋转，
    // 返回的坐标就整个错位 —— 而调用方拿这个坐标去移动针尖。
    const header = scan.header as Readonly<Record<string, unknown>>
    let angleDeg = 0
    let cxM = 0
    let cyM = 0
    let wM = 1e-7
    let hM = 1e-7
    const meta = parseXyMeta(header)
    if (meta !== null) {
      cxM = meta.cx
      cyM = meta.cy
      wM = meta.w
      hM = meta.h
      angleDeg = meta.angle
    } else {
      const off = twoFloats(header['scan_offset'], [0, 0])
      cxM = off[0]
      cyM = off[1]
      const rng = twoFloats(header['scan_range'], [1e-7, 1e-7])
      wM = rng[0]
      hM = rng[1]
    }

    // 窗边长：比例 → 像素，并尊重物理下限。
    let winPx = Math.max(8, Math.trunc(Math.min(nx, ny) * windowFrac))
    if (minWindowM > 0) {
      const frameShortM = Math.min(wM, hM)
      if (frameShortM < minWindowM) {
        // 显式失败，不静默缩窗：调用方要的是「至少这么大一块平地」，
        // 给它一块更小的会让它以为条件满足了。
        return fail(
          `帧本身只有 ${pyFixed(frameShortM * 1e9, 1)} nm,小于要求的最小` +
            `窗口 ${pyFixed(minWindowM * 1e9, 1)} nm —— 换一张更大的图再找。`,
          { frame_short_m: frameShortM, min_window_m: minWindowM },
        )
      }
      const pxPerM = Math.min(nx / wM, ny / hM)
      winPx = Math.max(winPx, Math.ceil(minWindowM * pxPerM))
      winPx = Math.min(winPx, Math.min(nx, ny))
    }
    const stridePx = Math.max(1, Math.trunc(winPx * strideFrac))

    // 逐像素台面层标签（`same_terrace` 用）。分割不可用时降级为「不做同层约束」
    // 并在结果里说明 —— 一个分析组件缺失不该让整次搜索失败。
    let layerLabels: Int32Array | null = null
    let terraceNote = ''
    if (sameTerrace) {
      try {
        const fillValue = nanMean(img.data)
        const filledData = new Float64Array(img.rows * img.cols)
        for (let i = 0; i < filledData.length; i += 1) {
          const v = img.data[i] as number
          filledData[i] = Number.isNaN(v) ? fillValue : v === Infinity ? Number.MAX_VALUE : v === -Infinity ? -Number.MAX_VALUE : v
        }
        // 前处理只扣一阶平面。**不能用 flatten_robust**：它的逐行中位数差分
        // 会把层结构本身揉掉（实测：一道 240 pm 的垂直台阶经它处理后 KDE
        // 只剩一个峰，同层约束整个失效）。
        const coarse = planeSubtractRobust(matOf(img.rows, img.cols, filledData))
        // 噪声底用行内差分的 MAD。用 std 会被台阶本身抬高 —— 实测同一张图
        // std 给 15 pm、MAD 给 3 pm，而真值是 3 pm；噪声估大了，KDE 的峰
        // 就合并成一个。
        let sigN = noiseFloor(coarse)
        if (sigN <= 0) sigN = Math.max(std(coarse.data) * 1e-3, 1e-15)
        const layers = kdeLayers(coarse, sigN)
        layerLabels = layers.labels
        if (new Set(layerLabels).size < 2) layerLabels = null // 单层 = 整帧同一台面
      } catch (exc) {
        terraceNote = `同层约束不可用(分割失败: ${(exc as Error).message}),已按无约束搜索`
        layerLabels = null
      }
    }

    if (minSep <= 0) minSep = ((wM + hM) * 0.5) * windowFrac

    // 像素 → 米。**用共享的那一份**（2026-08-10 合并）：这套换算一度有三份实现，
    // 而第三份（一次性脚本里内联的）是唯一没被测过的那份。
    const toM = (pxX: number, pxY: number): [number, number] =>
      pxToM(pxX, pxY, { nx, ny, cxM, cyM, wM, hM, angleDeg })

    // 与旧仓同一个 `best` 字典（不用四个 `let`：TS 的控制流分析看不见闭包里的赋值，
    // 而一个对象的属性在任何一次函数调用之后都会退回声明类型 —— 这里要的正是那个）。
    const best = {
      rms: Infinity,
      cxM: null as number | null,
      cyM: null as number | null,
      px: null as readonly [number, number] | null,
    }
    let windowsChecked = 0
    let windowsSkipped = 0
    let windowsCrossTerrace = 0
    // 合格窗口的候选池（2026-08-14，给 `count > 1` 用）。`count == 1` 时它被填但
    // 不被读 —— 一份列表的内存换掉一个第二实现。
    const candidates: Candidate[] = []

    /** 按 `step` 的步长扫一遍，把 `best` 与三个计数器就地更新。 */
    const sweep = (step: number): void => {
      for (let iy = 0; iy + winPx <= ny; iy += step) {
        for (let ix = 0; ix + winPx <= nx; ix += step) {
          const patch = matSlice(leveled, iy, iy + winPx, ix, ix + winPx)
          // 洞太多的窗直接跳过。
          let valid = 0
          for (let i = 0; i < patch.data.length; i += 1) if (!Number.isNaN(patch.data[i] as number)) valid += 1
          if (valid < patch.data.length * MAX_NAN_FRAC) continue

          // 整窗同层：最小 RMS 会选到「跨台阶但两半各自平坦」的窗，那对倾斜测量
          // 毫无用处 —— 台面就是晶面，单一台面内测到的斜率才是压电扫描平面与
          // 晶面的失配角。
          if (layerLabels !== null) {
            const counts = new Map<number, number>()
            let maxCount = 0
            for (let r = iy; r < iy + winPx; r += 1) {
              for (let c = ix; c < ix + winPx; c += 1) {
                const lab = layerLabels[r * nx + c] as number
                const n = (counts.get(lab) ?? 0) + 1
                counts.set(lab, n)
                if (n > maxCount) maxCount = n
              }
            }
            if (maxCount < winPx * winPx * SAME_TERRACE_FRAC) {
              windowsCrossTerrace += 1
              continue
            }
          }
          const rms = localPlaneRms(patch)
          if (rms === null) continue
          const [cx, cy] = toM(ix + winPx / 2.0, iy + winPx / 2.0)

          let near = false
          for (const [ex, ey] of excluded) {
            if ((cx - ex) ** 2 + (cy - ey) ** 2 < minSep ** 2) {
              near = true
              break
            }
          }
          if (near) {
            windowsSkipped += 1
            continue
          }

          windowsChecked += 1
          candidates.push({ rms, cxM: cx, cyM: cy, px: [ix, iy] })
          if (rms < best.rms) {
            best.rms = rms
            best.cxM = cx
            best.cyM = cy
            best.px = [ix, iy]
          }
        }
      }
    }

    sweep(stridePx)

    // ⭐ **说「有」可以便宜，说「没有」必须贵。**
    //
    // 粗步长（出厂 `stride_fraction=0.5` ⇒ 64 px 的窗只落 7×7 个位置）在旧判据下
    // 无所谓 —— 那个量本来就没在测平坦度。判据修对之后，**采样栅格立刻变成限制
    // 因素**：真机 `_0186` 上粗扫的最优是 36.0 pm，而细扫（步长 win/8）能找到
    // **14.4 pm** —— 差 2.5 倍，而且正好跨在 25 pm 线的两侧。
    // ⇒ 粗扫会给出一个**假的「这里没有」**，而假的「没有」代价是让调用方白白
    // 换地方，离开一块本来很好的表面。
    //
    // 所以只在**将要拒绝**时补一次细扫。常见情形（粗扫就过线）一分钱不多花。
    if (best.rms > usableRmsM) {
      const fine = Math.max(1, Math.trunc(winPx / FINE_STRIDE_DIV))
      if (fine < stridePx) sweep(fine)
    }

    if (best.cxM === null || best.cyM === null || best.px === null) {
      let hint = 'Try a smaller window_fraction or a different scan.'
      // ⭐ 2026-08-17：**全跨台阶时也要给「换小一档」的建议。**
      //
      // 在此之前这条建议只在「量过了但都太糙」那条返回路上产出；而
      // 「所有窗都跨台阶」恰恰就是**窗太大**的定义 —— 它比另一条更需要这个建议。
      // 真机 C 相（50 nm 窗 / 100 nm 图）每次都走这条路，于是调用方的重试
      // 永远拿不到尺寸，直接放弃。
      const smallerCross: { side_m: number; same_terrace_frac: number }[] = []
      if (windowsCrossTerrace > 0 && layerLabels !== null) {
        for (const frac of [0.75, 0.5, 0.35, 0.25]) {
          const w2 = Math.trunc(winPx * frac)
          if (w2 < 8) continue
          let bestFrac = 0.0
          const st2 = Math.max(1, Math.trunc(w2 / 4))
          for (let jy = 0; jy + w2 <= ny; jy += st2) {
            for (let jx = 0; jx + w2 <= nx; jx += st2) {
              const counts = new Map<number, number>()
              let maxCount = 0
              for (let r = jy; r < jy + w2; r += 1) {
                for (let c = jx; c < jx + w2; c += 1) {
                  const lab = layerLabels[r * nx + c] as number
                  const n = (counts.get(lab) ?? 0) + 1
                  counts.set(lab, n)
                  if (n > maxCount) maxCount = n
                }
              }
              bestFrac = Math.max(bestFrac, maxCount / (w2 * w2))
            }
          }
          smallerCross.push({ side_m: (wM / nx) * w2, same_terrace_frac: pyRound(bestFrac, 3) })
          if (bestFrac >= SAME_TERRACE_FRAC) break
        }
      }
      if (windowsCrossTerrace > 0) {
        const ok2 = smallerCross.filter((d) => d.same_terrace_frac >= SAME_TERRACE_FRAC)
        const first = ok2[0]
        hint =
          first !== undefined
            ? `${windowsCrossTerrace} 个窗因跨台阶被排除,` +
              `但**换小一档就装得下**:` +
              `${pyFixed(first.side_m * 1e9, 0)} nm 的窗能落在单个台面里。` +
              `用 min_window_m=${pyExp(first.side_m, 3)} 重试。`
            : `${windowsCrossTerrace} 个窗因跨台阶被排除 —— ` +
              '这块区域的台面比要求的窗口还窄,换一处更大的平台。'
      }
      return fail(
        `no valid windows found (checked ${windowsChecked}, ` +
          `skipped ${windowsSkipped}, cross-terrace ` +
          `${windowsCrossTerrace}). ${hint}`,
        {
          windows_checked: windowsChecked,
          windows_skipped: windowsSkipped,
          windows_cross_terrace: windowsCrossTerrace,
          // 全跨台阶时：更小的窗能不能装进同一个台面。
          // `side_m` 升序，第一个 `same_terrace_frac >= 0.98` 的就是答案。
          smaller_windows_same_terrace: smallerCross,
        },
      )
    }

    // ── 绝对线：argmin **不是**「有没有」的答案 ────────────────────────
    //
    // 现场 2026-08-11：「一个区域找不到可以换地方找，没必要一定在一个地方找到。
    // **现在的算法可能不会放弃。**」—— 这一点说中了：本技能一直返回 argmin，
    // 而 argmin 永远存在，所以它从来不会说「这里没有」。
    //
    // 真机 `_0184`（200 nm，台阶密集）上这条同时错两次：交出的窗 75 pm，而同尺寸
    // 全帧最平的是 45.4 pm（排序就错了），**且连那个 45.4 pm 也过不了 25 pm 线**。
    if (best.rms > usableRmsM) {
      // 「换小一档有没有」是能照着做的下一步，「这里没有」不是。
      // `_0184` 实测：50 nm 没有（45.4 pm），而 **30 nm 有一块 6.8 pm 的**。
      // ⚠️ 这个探测**不套** same_terrace / exclude_used_spots，所以它是**提示**，
      // 不是承诺 —— 措辞里要说清这一点。
      const smaller: [number, number][] = []
      for (const frac of [0.75, 0.5, 0.35]) {
        const w2 = Math.trunc(winPx * frac)
        if (w2 < 8) continue
        let b2 = Infinity
        const st2 = Math.max(1, Math.trunc(w2 / 4))
        for (let jy = 0; jy + w2 <= ny; jy += st2) {
          for (let jx = 0; jx + w2 <= nx; jx += st2) {
            const r2 = localPlaneRms(matSlice(leveled, jy, jy + w2, jx, jx + w2))
            if (r2 !== null && r2 < b2) b2 = r2
          }
        }
        if (b2 < Infinity) smaller.push([(wM / nx) * w2, b2])
      }
      const okSmaller = smaller.filter(([, r]) => r <= usableRmsM)
      const head = okSmaller[0]
      const lastSmall = smaller[smaller.length - 1]
      const tail =
        head !== undefined
          ? `但**换小一档就有**:${pyFixed(head[0] * 1e9, 0)} nm 的窗在这张图上能到 ` +
            `${pyFixed(head[1] * 1e12, 1)} pm。用 min_window_m=${pyExp(head[0], 3)} 重试,` +
            `比换地方便宜。(该提示未套 same_terrace/排除点,是线索不是承诺。)`
          : '而且**缩小窗口也没用**' +
            (lastSmall !== undefined
              ? `(试到 ${pyFixed(lastSmall[0] * 1e9, 0)} nm 仍有 ${pyFixed(lastSmall[1] * 1e12, 1)} pm)`
              : '') +
            ' —— 这一片确实该换地方。'
      return fail(
        `这张图里没有可用的 ${pyFixed(((wM / nx) * winPx) * 1e9, 0)} nm 平区:` +
          `最平的一块局部残差 ${pyFixed(best.rms * 1e12, 1)} pm,` +
          `超过可用线 ${pyFixed(usableRmsM * 1e12, 0)} pm。${tail}`,
        {
          // ⭐ 给**代码**看的那一半（2026-08-16 加）。
          //
          // 这是「我找过了,这里没有」——**不是**「我没法找」。
          // 从前只有 `success=False` 一个信号，`flat_poke_sites` 把这两件事
          // 一起读成「判不了」，于是「找不到就继续找」那条重扫循环
          // **从来没被走到过**。文案是给人的，字段是给代码的。
          verdict: VERDICT_NO_USABLE_REGION,
          usable_rms_m: usableRmsM,
          best_rms_m: best.rms,
          best_center_x_m: best.cxM,
          best_center_y_m: best.cyM,
          window_side_m: (wM / nx) * winPx,
          smaller_windows: smaller.map(([s, r]) => ({ side_m: s, best_rms_m: r })),
          windows_checked: windowsChecked,
          windows_skipped: windowsSkipped,
          windows_cross_terrace: windowsCrossTerrace,
        },
      )
    }

    const windowSideM = (wM / nx) * winPx
    const data: Record<string, unknown> = {
      scan_path: scanPath,
      usable_rms_m: usableRmsM,
      center_x_m: best.cxM,
      center_y_m: best.cyM,
      window_side_m: windowSideM,
      rms_m: best.rms,
      pixel_origin: [best.px[0], best.px[1]],
      window_side_px: winPx,
      windows_checked: windowsChecked,
      windows_skipped: windowsSkipped,
      windows_cross_terrace: windowsCrossTerrace,
      scan_center_x_m: cxM,
      scan_center_y_m: cyM,
      scan_width_m: wM,
      scan_height_m: hM,
      scan_angle_deg: angleDeg,
      same_terrace_enforced: layerLabels !== null,
    }
    if (terraceNote !== '') data['note'] = terraceNote

    // ── 尺度自白（2026-08-27 加）────────────────────────────────────
    //
    // **小窗口在任何图上都能找到「平区」，那是选择偏倚不是平整度。**
    // 参考系统观测：同一张 200 nm/256 px（0.78 nm/px）、整帧 RMS 20.3 nm 的
    // 灾难帧上，最小残余随窗口单调变化：8 px → 30.5 pm、12 px → 49.6 pm、
    // 32 px → 130.0 pm、96 px → 391.8 pm。在 256×256 里挑一个 8×8，总挑得到
    // 看着平的 —— 而真跑去那里扫，看到的是整帧那个量级。
    //
    // 没有拐点可言，所以这**不是调阈值能解决的**，只能把尺度如实报出来。
    const finite: number[] = []
    for (let i = 0; i < leveled.data.length; i += 1) {
      const v = leveled.data[i] as number
      if (Number.isFinite(v)) finite.push(v)
    }
    const frameRmsM = finite.length > 0 ? std(finite) : null
    data['window_side_px'] = winPx
    data['frame_rms_m'] = frameRmsM
    if (frameRmsM !== null && frameRmsM > 0) data['rms_ratio_to_frame'] = best.rms / frameRmsM
    if (winPx < SCALE_CAVEAT_PX) {
      data['scale_caveat'] =
        `窗口只有 ${winPx} 像素（${pyFixed(windowSideM * 1e9, 1)} nm）。` +
        `**这个尺度上的残差不能与更大尺度比较，也不保证你去那里扫会看到同样的平整度** —— ` +
        `小窗口在任何图上都挑得到看着平的一块（选择偏倚）。` +
        `要一块真的能用的平区，把 window_fraction 调大或改用 min_window_m 指定物理尺寸。`
    }

    // ── `count > 1`：再交出 N 个互不重叠的平区（2026-08-14）──────────────
    //
    // 用途是**扎针落点**：`poke_phase` 最多扎 30 次，而此前落点只保证「没被用过」
    // —— 可能扎在台阶边缘。这里交出来的每一个都过了和 `best` 同一套判据。
    //
    // ⚠️ 两条纪律：
    // ① 只收 `rms <= usable_rms_m` 的 —— 候选已按 rms 升序，第一个超线就 break。
    //    **绝不为了凑满 count 而放行不合格的窗**；
    // ② 交出的数量少于 count 是**正常结果**，不是失败。
    if (wantCount > 1 && candidates.length > 0) {
      const sep = minSepM !== null ? minSepM : (wM / nx) * winPx
      const sites: { center_x_m: number; center_y_m: number; rms_m: number }[] = []
      const sorted = candidates.slice().sort((a, b) => a.rms - b.rms)
      for (const c of sorted) {
        if (c.rms > usableRmsM) break
        const farEnough = sites.every(
          (s) => (c.cxM - s.center_x_m) ** 2 + (c.cyM - s.center_y_m) ** 2 >= sep * sep,
        )
        if (farEnough) {
          sites.push({ center_x_m: c.cxM, center_y_m: c.cyM, rms_m: c.rms })
          if (sites.length >= wantCount) break
        }
      }
      data['sites'] = sites
      data['sites_requested'] = wantCount
      data['sites_min_separation_m'] = sep
      if (sites.length < wantCount) {
        data['sites_note'] =
          `要 ${wantCount} 个,这张图上只找到 ${sites.length} 个互相间隔 ` +
          `≥ ${pyFixed(sep * 1e9, 0)} nm 的可用平区 —— **这不是失败**,` +
          '是这一片能给的就这么多。用完了换一块地方再扫一张。'
      }
    }
    return ok(data)
  },
}

/** `float(str(v).split()[:2])`，解析不出用 `dflt`（旧仓那条 `except` 兜底）。 */
function twoFloats(v: unknown, dflt: readonly [number, number]): [number, number] {
  if (v === null || v === undefined) return [dflt[0], dflt[1]]
  const parts = String(v).trim().split(/\s+/)
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (parts.length < 2 || !Number.isFinite(a) || !Number.isFinite(b)) return [dflt[0], dflt[1]]
  return [a, b]
}

/** 这个文件里的技能。 */
export const ANALYSIS_FLAT_REGION: Readonly<Record<string, Skill>> = { FindFlatRegion }
