/**
 * `WatchScanLines` —— 看**正在扫的那张图**，不停扫。
 *
 * ## 为什么这是基础设施而不是某个判据的附属品
 *
 * 一张 5 nm / 256 px 的图在真机的 0.768 s/线下要 **6.6 分钟**。在这 6.6 分钟里，
 * 现有的每一条路都只有两个选择：**等到扫完**，或者**停掉重来**。于是每一个
 * 「这张图还值得扫下去吗」的问题，代价都是一整帧。
 *
 * 而 Nanonis 的帧缓冲**扫到哪儿就有到哪儿**（实测：没扫到的行是全零）。所以
 * 「现在扫到什么了」本来就是一个几秒钟能答的问题 —— 缺的只是有人去问。
 * 因此可以在扫描过程中读取已完成的行，及时反馈进度。
 *
 * ## 它报什么、不报什么
 *
 * **报的是「现在是什么样」，不是「好不好」。** 好不好是各家判据的事
 * （`AssessAtomicLines` 问「有没有规则跳动」、`CheckScanForCrash` 问「撞没撞针」）。
 * 把「好不好」写进这里，等于让所有下游共用一套没人标定过的阈值。
 *
 * 所以这里给的是**量**：进度、有没有在推进、新扫出来那些行的粗糙度 / 量程 /
 * 斜率 / 行间相关 / 触顶比例。外加几条**说得出理由**的旗标。
 *
 * ## `since_line` 是一个游标，而「新行 0 条」是一个必须有人接的信号
 *
 * 若连续轮询没有新行，仍将该状态写入 `observations`，而不是当作普通日志丢弃。
 *
 * ## 三件已经在仓里的东西，这个技能一件都不用重写
 *
 * | 旧仓 | 本仓 |
 * |---|---|
 * | `_scan_readout.resolve_readout`（143 行） | `analysis-lines.ts:resolveReadout`（批 4a 落的，**同一份**） |
 * | `_scan_readout.grab_frame` | `analysis-lines.ts:grabFrame` |
 * | `vision.atomic_lines.usable_rows`（15 行） | `dsh-spm-vision:usableRows`（批 4a 落的） |
 *
 * 盘点（A26）把这 158 行算成本批要写的量 —— **实际上一行都不用写**，
 * 因为 `AssessAtomicLines` 已经把它们搬过来了，而旧仓那份文件的抬头写的正是
 * 「两个技能各写一份的下场是两边迟早只有一边对」。
 */
import {
  formatG,
  pyFixed,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { matAt, type Mat } from 'dsh-spm-numerics'
import { npMean, npStd } from 'dsh-spm-numerics'
import { npMedian, usableRows } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { ok } from './common.js'
import { grabFrame, readoutDict, resolveReadout } from './analysis-lines.js'

/**
 * Z 触顶的判据：一行里有这么多点贴着**该行自己的**极值，就认为压电到头了。
 *
 * 绝对容差而不是相对：它比的是「这个点等不等于这一行的 max/min」，
 * 而那两个数本身就在数据里 —— `1e-12` 是「同一个读数」的意思，不是一条物理阈值。
 */
export const SATURATION_TOL = 1e-12

/**
 * 行间相关低于这个数就提醒「像是针尖不稳 / 有条纹」。
 *
 * **是提醒不是判定** —— 真实平坦表面上相邻行相关本来就高（0.9+），
 * 而一片纯噪声区也可能低而无害。所以它只进 `observations`，不进 `verdict`
 * （这个技能没有 `verdict`）。
 */
export const CORR_HINT = 0.5

const i32 = (p: Readonly<Record<string, unknown>>, k: string, dflt: number): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/** 取出若干行，按给定的行号顺序。 */
function takeRows(img: Mat, idx: readonly number[]): number[][] {
  return idx.map((r) => {
    const row: number[] = []
    for (let c = 0; c < img.cols; c += 1) row.push(matAt(img, r, c))
    return row
  })
}

/**
 * `np.argsort`（升序、稳定）。
 *
 * `use` 一路都是升序的（`flatnonzero` 的输出再切片），所以这里恒等于 `0..n−1` ——
 * **照移而不是省掉**：省掉它等于把「行要按行号排好再算相邻行相关」这条假设
 * 从代码里删掉，而下一个人改了 `use` 的来源时没有任何东西会红。
 */
function argsort(xs: readonly number[]): number[] {
  return xs
    .map((v, i) => [v, i] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))
    .map(([, i]) => i)
}

export const WatchScanLines: Skill = {
  spec: S.WatchScanLinesSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const direction = i32(params, 'direction', 1)
    const since = i32(params, 'since_line', -1)
    const forced = i32(params, 'channel_index', -1)
    const maxLines = i32(params, 'max_lines', 64)

    const calls: SkillCallRecord[] = []
    const ro = await resolveReadout(ctx, calls, forced)
    if (ro.why !== '' || ro.zIndex === null || ro.nmPerPx === null) {
      return { success: false, error: ro.why, data: readoutDict(ro) }
    }

    const [img, why] = await grabFrame(ctx, ro.zIndex, direction, calls)
    if (img === null) {
      return {
        success: false,
        error:
          `取不到通道 ${ro.zIndex} 的帧：${why}　（扫描缓冲里的通道是 ` +
          `[${ro.channels.join(', ')}] —— 这个参数要的是**信号索引**，不是缓冲位）`,
        data: readoutDict(ro),
      }
    }

    const filled = usableRows(img)
    const idx: number[] = []
    for (let r = 0; r < filled.length; r += 1) if (filled[r] === 1) idx.push(r)
    const nDone = idx.length
    const nTotal = img.rows
    const data: Record<string, unknown> = {
      ...readoutDict(ro),
      direction,
      n_lines_done: nDone,
      n_lines_total: nTotal,
      fraction_done: nTotal ? nDone / nTotal : null,
    }

    if (nDone === 0) {
      const empty =
        '帧缓冲里一行都还没有 —— 扫描可能刚起、或者根本没在扫。这不等于「表面是平的」。'
      data['advancing'] = false
      data['n_lines_new'] = 0
      data['observations'] = [empty]
      return ok(data, empty)
    }

    // 扫描方向决定新行在哪一头：未扫区在低号侧 ⇒ 新行是 idx 的开头。
    const lowUnscanned = (filled[0] ?? 0) === 0
    const lastLine = lowUnscanned ? (idx[0] as number) : (idx[idx.length - 1] as number)
    data['last_line_index'] = lastLine
    data['scan_direction_hint'] = lowUnscanned
      ? '行号从大到小填（未扫区在低号侧）'
      : '行号从小到大填'

    const newIdx =
      since < 0 ? idx : lowUnscanned ? idx.filter((i) => i < since) : idx.filter((i) => i > since)
    data['n_lines_new'] = newIdx.length
    data['advancing'] = since >= 0 ? newIdx.length > 0 : null

    let use = newIdx.length > 0 ? newIdx : idx
    if (maxLines && use.length > maxLines) {
      use = lowUnscanned ? use.slice(0, maxLines) : use.slice(use.length - maxLines)
    }
    const rows = takeRows(img, use)

    // 每行去掉**自己的**均值再统计 —— 不然整帧的倾斜会盖住行内的起伏。
    const rowMeans = rows.map((r) => npMean(r))
    const centred = rows.map((r, k) => r.map((v) => v - (rowMeans[k] as number)))
    // `np.sqrt` 是**正确舍入**的；`x ** 0.5` 走 libm `pow`，不保证。
    // 旧仓这一行是 `np.sqrt(...)`，所以这边也要 `Math.sqrt`。
    const rms = npMedian(centred.map((r) => Math.sqrt(npMean(r.map((v) => v * v)))))
    const rng = npMedian(rows.map((r) => Math.max(...r) - Math.min(...r)))

    // 行间相关：稳定表面上相邻行长得像；针尖不稳 / 有条纹时它掉得最快。
    let corr: number | null = null
    if (rows.length >= 2) {
      const order = argsort(use)
      const cs: number[] = []
      for (let k = 0; k < order.length - 1; k += 1) {
        const x = centred[order[k] as number] as number[]
        const y = centred[order[k + 1] as number] as number[]
        const sx = npStd(x)
        const sy = npStd(y)
        if (sx > 0 && sy > 0) cs.push(npMean(x.map((v, j) => v * (y[j] as number))) / (sx * sy))
      }
      corr = cs.length > 0 ? npMedian(cs) : null
    }

    // 触顶：贴着自己那一行极值的点占多少。
    const flags: number[] = []
    for (const r of rows) {
      const hi = Math.max(...r)
      const lo = Math.min(...r)
      for (const v of r) {
        flags.push(Math.abs(v - hi) < SATURATION_TOL || Math.abs(v - lo) < SATURATION_TOL ? 1 : 0)
      }
    }
    const sat = npMean(flags)

    // 慢轴斜率：相邻行均值的差 —— 漂移 / 倾斜。
    const order2 = argsort(use)
    const means = order2.map((k) => rowMeans[k] as number)
    const slope =
      means.length >= 2 ? npMedian(means.slice(1).map((v, k) => v - (means[k] as number))) : null

    data['n_lines_measured'] = use.length
    data['rms_roughness_m'] = rms
    data['range_m'] = rng
    data['line_to_line_corr'] = corr
    data['saturated_fraction'] = sat
    data['slope_m_per_line'] = slope

    const obs: string[] = []
    if (since >= 0 && newIdx.length === 0) {
      obs.push(
        '自上次以来**一行新的都没有** —— 扫描停了、卡了，或者正好在换行。' +
          '这条要有人接：接着对同一张不再更新的图打分，看到的都是旧的。',
      )
    }
    if (corr !== null && corr < CORR_HINT) {
      obs.push(
        `行间相关只有 ${pyFixed(corr, 2)}（提醒，不是判定）—— 稳定表面上相邻行` +
          '通常 0.9 以上；低到这里常见于针尖不稳或成条纹。',
      )
    }
    if (sat > 0.02) {
      obs.push(`有 ${pyFixed(100 * sat, 1)}% 的点贴着自己那一行的极值 —— 可能压电到头了。`)
    }
    if (obs.length === 0) {
      obs.push(
        `已扫 ${nDone}/${nTotal} 行；新行 ${since >= 0 ? `${newIdx.length} 条` : '（没给游标）'}；` +
          `粗糙度中位 ${formatG(rms, 3)} m、量程 ${formatG(rng, 3)} m。`,
      )
    }
    data['observations'] = obs

    return ok(data, obs[0] as string)
  },
}

/** 这一族的登记表（就一个）。 */
export const SCAN_WATCH: Readonly<Record<string, Skill>> = { WatchScanLines }
