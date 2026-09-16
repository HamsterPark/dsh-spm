/**
 * `.sxm` 头 → 物理足迹，以及像素 → 仪器坐标。旧仓 `mast/io/mosaic.py` 的
 * `parse_xy_meta`(48) + `px_to_m`(46)。
 *
 * ## 为什么这两个必须是**同一份**
 *
 * 旧仓 2026-08-10 的现场记录：这套换算一度有**三份**实现 —— `flat_region` 一份、
 * `cluster_extract` 一份、一次性分析脚本里内联的第三份。第三份是**唯一没被测过
 * 的那份**，而写它的人事后说「我甚至没意识到自己在造第三份」。追问「为什么内联」，
 * 答案是「import 那份比自己写四行麻烦」。
 *
 * ⇒ 修法不是提醒大家别复制，是**把复制的诱因去掉**。
 *
 * ## `sxmFrameMeta` **不是**它（这一条是本批核出来的）
 *
 * `nanonis-files` 的 `sxmFrameMeta`（`sxm.ts`）只吐 `scanOffset` / `scanRange` /
 * `scanPixels` 原样，**没有** `cx/cy/w/h/angle`，更没有 `angleKnown`。
 * 而 `angleKnown` 正是 `SelectPokedCluster` 判 `coords_trustworthy` 的来源 ——
 * 少了它，一帧真的转过的图会被当成轴对齐悄悄算完，而调用方拿那个坐标去**移动针尖**。
 *
 * ## 角度解析失败 ⇒ `angle = 0` **且** `angleKnown = false`
 *
 * 兜底值又一次落在「没什么可担心的」那一侧：下游判「是不是转过」的表达式通常是
 * `|angle| > 1`，而 `0.0` 恰好让它不触发。旧仓没有把 `angle` 改成 `null`
 * （六个调用方都当它是数），而是加了一个旗标 —— 本仓照移，**并且把旗标一路透出去**。
 */

/** `parseXyMeta` 的产出。米 / 度。 */
export interface XyMeta {
  readonly cx: number
  readonly cy: number
  readonly w: number
  readonly h: number
  readonly angle: number
  /** `false` = 角度是**猜的**（头里没有，或解析失败）。见文件抬头。 */
  readonly angleKnown: boolean
}

function twoFloats(v: unknown): [number, number] | null {
  if (v === null || v === undefined || v === '') return null
  const parts = String(v).trim().split(/\s+/)
  if (parts.length < 2) return null
  const a = Number(parts[0])
  const b = Number(parts[1])
  // Python 的 `float(parts[0])` 对空串与垃圾串抛 ValueError ⇒ 整体 None。
  // JS 的 `Number('')` 给 0，所以这里显式挡掉非数。
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return [a, b]
}

/**
 * `:SCAN_OFFSET:` / `:SCAN_RANGE:` / `:SCAN_ANGLE:` → `{cx, cy, w, h, angle}`（米 / 度）。
 *
 * 读不出偏移或视野、或者视野 ≤ 0 ⇒ `null`（「这一帧没有几何信息」，不是「在原点」）。
 */
export function parseXyMeta(header: Readonly<Record<string, unknown>>): XyMeta | null {
  const off = twoFloats(header['scan_offset'])
  const rng = twoFloats(header['scan_range'])
  if (off === null || rng === null) return null
  const w = Math.abs(rng[0])
  const h = Math.abs(rng[1])
  if (!(w > 0) || !(h > 0)) return null

  let angle = 0
  let angleKnown = true
  const a = header['scan_angle']
  if (a !== null && a !== undefined && a !== '') {
    const first = String(a).trim().split(/\s+/)[0]
    const parsed = first === undefined || first === '' ? NaN : Number(first)
    if (Number.isFinite(parsed)) angle = parsed
    else {
      angle = 0
      angleKnown = false
    }
  } else {
    // 头里根本没有 SCAN_ANGLE —— 同样是「不知道」，不是「等于 0」。
    angleKnown = false
  }
  return { cx: off[0], cy: off[1], w, h, angle, angleKnown }
}

/**
 * 像素坐标 → 仪器坐标（米）。**全仓唯一一份。**
 *
 * 约定（`.sxm`）：
 * * 原点在扫描框**左下**，帧中心 = `scan_offset`；
 * * **y 翻转** —— row 0 是**最大** y（`sxmOrientedFrames` 已经把 `up` 帧翻正）；
 * * 先算相对帧中心的偏移，**再绕中心转** `angleDeg`，最后加回中心。
 *   少了旋转这一步，一张转过 30° 的图上算出的坐标会落在别处 ——
 *   而调用方拿着它去移动针尖。
 */
export function pxToM(
  pxX: number,
  pxY: number,
  opts: {
    nx: number
    ny: number
    cxM: number
    cyM: number
    wM: number
    hM: number
    angleDeg?: number
  },
): [number, number] {
  const angleDeg = opts.angleDeg ?? 0
  const ca = Math.cos((angleDeg * Math.PI) / 180)
  const sa = Math.sin((angleDeg * Math.PI) / 180)
  const dx = ((pxX + 0.5) / opts.nx) * opts.wM - opts.wM * 0.5
  const dy = opts.hM * 0.5 - ((pxY + 0.5) / opts.ny) * opts.hM
  return [opts.cxM + dx * ca - dy * sa, opts.cyM + dx * sa + dy * ca]
}
