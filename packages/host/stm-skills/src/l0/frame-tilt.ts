/**
 * `AnalyzeFrameTilt` —— 从一张已保存的 `.sxm` 量倾斜、台阶主导与表面起伏（**只读**）。
 *
 * 判据一条都不在这一层：全在 `dsh-spm-vision` 的 `tilt-frame.ts`。这里只做三件事 ——
 * 把文件读进来、把参数按旧仓的口径取出来、把判据的产出摆成 `SkillResult.data`。
 *
 * ## 它解开的两件事（旧仓抬头的原话）
 *
 * 1. **`AutoTilt` 的 `surface_rms_m` 没人能算**。那个参数是「斜坡有没有把形貌淹没」
 *    这条触发判据的分母，也就是用户说的「扫出的图明显是倾斜的」。缺了它，
 *    `AutoTilt` 只剩下「吃掉多少 Z 量程」这一条安全判据，而后者在大多数机器上
 *    要很大的倾斜才触发。
 * 2. **真机上的阈值重标定没有数据来源**。台阶主导比的 1.4 是在合成数据上定的。
 *
 * ## ⚠️ 它读的是**裸块**，不走 `sxmOrientedFrames`
 *
 * 旧仓写的是 `scan["channels"][name]["forward"]`，一次几何归位都没有。
 * 这与 `AssessClusterRoundness` 是同一种情形（`analysis-common.ts` 抬头点过名）：
 * **不是本仓的选择，是旧仓的现状**。归位会翻 `backward` 块、会把 `up` 帧翻正，
 * 而那两件都会改变这里报出来的角度符号 —— 一个「顺手修好」的移植，
 * 会让金样里每一格的 `tilt_slow_deg` 换个号，而**改掉的是模型读的那个数**。
 *
 * ## 两个表面起伏口径，**说清楚谁喂给谁**
 *
 * | 字段 | 是什么 | 谁该用 |
 * |---|---|---|
 * | `surface_rms_m` | **扣掉倾斜与曲率之后**整帧的 RMS | **`AutoTilt` 的 `surface_rms_m` 就是它** |
 * | `local_texture_rms_m` | 32 px 分块 σ 的中位数，对台阶免疫 | 回答「局部纹理有多粗糙」，**不要**喂给 AutoTilt |
 *
 * 去趋势是**必须**的：不扣掉倾斜的话，倾斜本身会被算进「形貌」，分母随倾斜一起
 * 变大，这条判据就永远不成立（自我抵消）。
 * 代价：二阶面会吸收掉**单个台阶**的一部分（旧仓实测：一道占半帧的 240 pm 台阶，
 * 理想 RMS 120 pm，实测 ~62 pm）。这让分母偏小、判据偏敏感 ——
 * 真机上若发现调平触发得过于频繁，这里是第一个要看的地方。
 *
 * 拿 `local_texture_rms_m` 当 AutoTilt 的输入会让触发阈**小一个数量级**，
 * 几乎每帧都要求调平。两个都报出来，就是为了让这句话有地方写。
 */
import { existsSync } from 'node:fs'
import { pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { matAt, type Mat } from 'dsh-spm-numerics'
import {
  detrendQuadratic,
  estimateTilt,
  finiteOf,
  nanStd,
  noiseFloor,
  npMedian,
  parseXyMeta,
  stepDominanceMultiscale,
  structureDominance,
  type TiltEstimate,
} from 'dsh-spm-vision'
import type { SxmChannel } from 'dsh-spm-nanonis-files'
import * as S from '../generated/specs.js'
import { loadSxm, strParam } from './analysis-common.js'

/** Python 的 `f"{x:.{n}f}"`。 */
function f(x: number, n: number): string {
  return pyFixed(x, n)
}

/** Python 的 `f"{x:+.{n}f}"` —— 非负数也带符号。 */
function fSigned(x: number, n: number): string {
  const s = pyFixed(x, n)
  return s.startsWith('-') ? s : `+${s}`
}

/** Python 的 `repr(str)`（报文里嵌了 `{channel_name!r}`）。 */
function pyRepr(s: string): string {
  return `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

/**
 * `local_texture_rms_m` —— 固定 32 px 分块的 σ 中位数，一块都凑不出时退回整帧 RMS。
 *
 * ⚠️ 与 {@link structureDominance} **不是**同一段代码，尽管长得像：那边遇到
 * 「一块都没有」给的是比值 `1.0`，这边给的是 `surface_rms`。旧仓在技能里又写了
 * 一遍，本仓照移 —— 合并会把「没有分块」这件事在两个地方报成两个不同的意思。
 */
export function localTextureRms(flat: Mat, fallback: number, tile = 32): number {
  const stds: number[] = []
  const h = Math.floor(flat.rows / tile)
  const w = Math.floor(flat.cols / tile)
  for (let i = 0; i < h; i += 1) {
    for (let j = 0; j < w; j += 1) {
      const block: number[] = []
      for (let r = i * tile; r < (i + 1) * tile; r += 1) {
        for (let c = j * tile; c < (j + 1) * tile; c += 1) {
          const v = matAt(flat, r, c)
          if (Number.isFinite(v)) block.push(v)
        }
      }
      if (block.length >= 2) stds.push(nanStd(block))
    }
  }
  return stds.length > 0 ? npMedian(stds) : fallback
}

/** 旧仓 `TiltEstimate.as_dict()` —— `step` 为 `None` 时那个键**不出现**。 */
export function tiltEstimateDict(e: TiltEstimate): Record<string, unknown> {
  const out: Record<string, unknown> = {
    valid: e.valid,
    invalid_reason: e.invalid_reason,
    tilt_x_deg: e.tilt_x_deg,
    tilt_y_deg: e.tilt_y_deg,
    tilt_fast_deg: e.tilt_fast_deg,
    tilt_slow_deg: e.tilt_slow_deg,
    slope_mag_deg: e.slope_mag_deg,
    z_span_m: e.z_span_m,
    slow_axis_trusted: e.slow_axis_trusted,
    inlier_ratio: e.inlier_ratio,
    noise_floor_m: e.noise_floor_m,
    rotation_applied: e.rotation_applied,
  }
  if (e.step !== null) {
    out['step'] = {
      step_dominated: e.step.step_dominated,
      ratio_multiscale: e.step.ratio_multiscale,
      ratio_by_tile: { ...e.step.ratio_by_tile },
      step_area_frac: e.step.step_area_frac,
      step_present: e.step.step_present,
      triggered_by: e.step.triggered_by,
    }
  }
  return out
}

export const AnalyzeFrameTilt: Skill = {
  spec: S.AnalyzeFrameTiltSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const scanPath = String(params['scan_path'] ?? '')
    const channelName = strParam(params, 'channel', 'Z')
    // 旧仓 `bool(params.get("check_steps", True))` —— 缺席是 True，
    // 而任何**假值**（`False` / `0` / `''`）都是 False。
    const raw = params['check_steps']
    const checkSteps = raw === undefined ? true : Boolean(raw)

    if (!existsSync(scanPath)) return { success: false, error: `文件不存在: ${scanPath}` }

    // ⚠️ 把**路径**传进去当报错里的那个名字：旧仓 `read_sxm(path)` 印的是路径，
    // 而本仓的读取器缺省印 `<sxm>`。这句话是模型读的（「哪个文件坏了」），
    // 缺省值在那里回答不了问题。
    const load = loadSxm(scanPath, scanPath)
    if (!load.ok) return { success: false, error: `.sxm 读取失败: ${load.plain}` }
    const scan = load.scan

    const channels = scan.channels
    // Python 的 `channels.get(name) or next(iter(channels.values()), None)`：
    // ⚠️ `{}` 在 Python 里是**假**的，于是「有这个键但里面是空的」也会落到第一个通道。
    // JS 的 `{}` 是真的 —— 这一行如果照搬 `??`，两边就在这一格上分岔。
    const named = channels[channelName]
    const ch: SxmChannel | undefined =
      named !== undefined && Object.keys(named).length > 0 ? named : Object.values(channels)[0]
    if (ch === undefined) {
      return { success: false, error: `文件里没有可用通道(要的是 ${pyRepr(channelName)})` }
    }
    const img = ch.forward ?? ch.backward
    if (img === undefined) return { success: false, error: '通道里没有正扫/反扫数据' }

    const meta = parseXyMeta(scan.header as Readonly<Record<string, unknown>>)
    if (meta === null) {
      return {
        success: false,
        error:
          '从 .sxm 头里解析不出扫描几何(offset/range)—— 没有物理尺寸' +
          '就换算不出角度,拒绝给出无意义的数字',
        data: { scan_path: scanPath },
      }
    }

    const widthM = meta.w
    const heightM = meta.h
    // Python 的 `float(meta.get("angle") or 0.0)` —— `0.0` 与缺席同义（都给 0）。
    const angleDeg = meta.angle || 0.0
    const ny = img.rows
    const nx = img.cols
    const nmPerPx = nx > 0 ? (widthM / nx) * 1e9 : null

    const est = estimateTilt(img, {
      widthM,
      heightM,
      scanAngleDeg: angleDeg,
      nmPerPx,
      checkSteps,
    })

    const flat = detrendQuadratic(img)
    const fin = finiteOf(flat.data)
    const surfaceRms = fin.length > 0 ? nanStd(flat.data) : 0.0
    const localSigma = localTextureRms(flat, surfaceRms)
    const { ratio: ratioMax, byTile } = stepDominanceMultiscale(flat)

    const data: Record<string, unknown> = {
      scan_path: scanPath,
      channel: channelName,
      geometry: {
        width_m: widthM,
        height_m: heightM,
        angle_deg: angleDeg,
        pixels: [nx, ny],
        nm_per_px: nmPerPx,
      },
      // —— 喂给 AutoTilt 的就是这一个 ——
      surface_rms_m: surfaceRms,
      local_texture_rms_m: localSigma,
      noise_floor_m: noiseFloor(img),
      step: {
        ratio_multiscale: ratioMax,
        ratio_by_tile: { ...byTile },
        ratio_single_tile32: structureDominance(flat, 32),
      },
      tilt: tiltEstimateDict(est),
    }

    const summary = est.valid
      ? `倾斜 ${f(est.slope_mag_deg, 4)}°(快扫轴 ${fSigned(est.tilt_fast_deg, 4)}°,` +
        `慢扫轴 ${fSigned(est.tilt_slow_deg, 4)}° ← 混漂移不可信);` +
        `帧内吃掉 Z ${f(est.z_span_m * 1e9, 2)} nm;` +
        `表面起伏 ${f(surfaceRms * 1e12, 1)} pm`
      : `倾斜无法测定(${est.invalid_reason});` +
        `表面起伏 ${f(surfaceRms * 1e12, 1)} pm,` +
        `台阶主导比 ${f(ratioMax, 2)}`

    return { success: true, data, summary }
  },
}
