/**
 * 批 4a 的共用外壳 —— **只做 IO，一个判据都不写**。
 *
 * 判据全在 `dsh-spm-vision`（几何 / 形状 / 掩膜）与 `dsh-spm-kernel`
 * （起伏门与它的阈值表）。这一层的活只有三样：把文件读进来、把参数按旧仓的口径
 * 取出来、把判据的产出摆成 `SkillResult.data`。
 *
 * ## 取帧走**几何归位的单一真源**
 *
 * `sxmOrientedFrames` 而不是自己扒 `channels`：
 *
 * * `backward` 块沿 −x 采集，**是镜像存的** —— 不翻的话任何正/反扫比较都是在拿
 *   一张图和它自己的镜像比；
 * * `:SCAN_DIR: up` 时第一条采集线是帧底 —— 不翻的话 `pxToM` 的前提
 *   （row 0 = 最大 y）不成立，团簇的 y 会差半帧（60 nm 帧实测 31.8 nm），
 *   **而且不报错**。
 *
 * 2026-08-11 旧仓正是在开放 `StartScan` 的 direction 参数那一批里补上这一条的：
 * 两件必须一起做，否则 `up` 帧从此会真的出现。
 *
 * ⚠️ **`AssessClusterRoundness` 是例外**：它读的是**裸块**（`scan.channels[ch]`），
 * 不经归位。这不是本仓的选择，是旧仓的现状 —— 照移，并在交接里记一笔。
 */
import { readFileSync } from 'node:fs'
import { readSxm, sxmOrientedFrames, type OrientedFrames, type SxmScan } from 'dsh-spm-nanonis-files'

/**
 * 读一张 `.sxm`。读不动就把**原因**带出来 —— 「文件坏了」与「没这个文件」是两句话。
 *
 * ⚠️ 两种写法都给，因为旧仓**六个调用方里五个写 `{exc}`、一个写
 * `{type(exc).__name__}: {exc}`**（`ExtractClusters`）。那不是笔误，
 * 是两句不同的话：带类名的那句把「读到一半格式不对」与「根本没这个文件」分开，
 * 而另外五个只转述那一句。照移 —— 一个统一成同一种写法的移植，
 * 会让金样里六条报文有五条对不上，而**改掉的是模型读的那句**。
 */
export type SxmLoad = { ok: true; scan: SxmScan } | { ok: false; why: string; plain: string }

export function loadSxm(path: string): SxmLoad {
  try {
    return { ok: true, scan: readSxm(readFileSync(path)) }
  } catch (e) {
    const err = e as Error
    return { ok: false, why: `${err.name}: ${err.message}`, plain: err.message }
  }
}

/** 几何归位之后的两帧 + 尺度。 */
export function orient(scan: SxmScan, channel: string): OrientedFrames {
  return sxmOrientedFrames(scan, channel)
}

/** `params` 里取一个字符串，空/缺省走 `fallback`（同 Python 的 `str(x or d).strip()`）。 */
export function strParam(params: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const v = params[key]
  if (v === null || v === undefined || v === '') return fallback
  return String(v).trim()
}

/** `params` 里取一个数；**缺席给 `null`，不给默认值**（那是调用方的事）。 */
export function numParam(params: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = params[key]
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** `params` 里取一个数，缺席用 `fallback`。 */
export function numOr(params: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = numParam(params, key)
  return v === null ? fallback : v
}
