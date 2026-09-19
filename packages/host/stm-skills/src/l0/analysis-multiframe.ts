/**
 * `AssessAtomicConsistency` —— 多帧原子相一致性：那个晶格是不是**真的**。
 *
 * 判据在 `dsh-spm-vision` 的 `lattice-multiframe.ts`。这一层只做 IO。
 *
 * ## 它与单帧版是**两种问题**，不是「多扫几张更准」
 *
 * `AssessAtomicResolution`（单帧）能排除白噪声与准周期抖动，**排除不掉**
 * 「针尖恰好在这一帧里以某个空间频率抖」。多帧能解决的正是这件单帧
 * **在原理上**做不到的事：真晶格跨帧重现同一组格矢，抖动不重现。
 *
 * ## 扫描角**从文件头读**，不让调用方手填
 *
 * 手填的角度与文件对不上时，多角度求解会得到一个残差很小的**错解**，
 * 而错在输入上，看代码是看不出来的。
 *
 * ⚠️ 同模块的第二个技能 `CalibratePiezoMultiAngle` **不在本批**：它要
 * `lattice_calibration.solve_affine`（`scipy.optimize.fsolve` 的多分支求根）。
 * 所以 `mast.skills.builtins.atomic_multiframe` 这个模块本批**到不了 complete**
 * （1/2）—— 同批 4b 的 `atomic_lattice`（2/3）。
 */
import { existsSync } from 'node:fs'
import { pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { type Mat } from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { loadSxm, orient, strParam } from './analysis-common.js'
import { assessAtomicConsistency } from 'dsh-spm-vision'

/** 逗号分隔的路径串 → 列表。Windows 路径里没有逗号，所以这样切是安全的。 */
export function splitDatPaths(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .filter((p) => p.trim() !== '')
    .map((p) => p.trim().replace(/^"+|"+$/g, ''))
}

/** 头里一个「数 + 单位」串的第一个数（`float(str(v).split()[0])`）。 */
function firstToken(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const parts = String(v).trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === '') return null
  const n = Number(parts[0])
  return Number.isFinite(n) ? n : null
}

interface LoadedOne {
  readonly img: Mat | null
  readonly nmPerPx: number | null
  readonly angleDeg: number | null
  readonly error: string
}

function loadOne(path: string, channel: string): LoadedOne {
  const bad = (error: string): LoadedOne => ({ img: null, nmPerPx: null, angleDeg: null, error })
  if (!existsSync(path)) return bad(`文件不存在: ${path}`)
  const load = loadSxm(path)
  if (!load.ok) return bad(`.sxm 读取失败: ${load.plain}`)
  const fr = orient(load.scan, channel)
  if (fr.forward === null) return bad(`没有通道 '${channel}' 的正扫数据`)
  if (!fr.nm_per_px) return bad('文件头里没有像素标度')
  const angle = firstToken((load.scan.header as Readonly<Record<string, unknown>>)['scan_angle'])
  if (angle === null) return bad('文件头里没有 scan_angle')
  return { img: fr.forward, nmPerPx: fr.nm_per_px, angleDeg: angle, error: '' }
}

/** 多帧原子相一致性。 */
export const AssessAtomicConsistency: Skill = {
  spec: S.AssessAtomicConsistencySpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const paths = splitDatPaths(params['scan_paths'])
    const channel = strParam(params, 'channel', 'Z')
    if (paths.length < 2) {
      return {
        success: false,
        error:
          '至少要两帧。单帧请用 AssessAtomicResolution —— ' +
          '它给的是「这一帧像不像晶格」，不是「这个晶格是不是真的」。',
      }
    }
    const imgs: Mat[] = []
    const angles: number[] = []
    const rejected: Record<string, unknown>[] = []
    let nmpp: number | null = null
    for (const p of paths) {
      const one = loadOne(p, channel)
      if (one.error !== '') {
        rejected.push({ path: p, error: one.error })
        continue
      }
      const mpp = one.nmPerPx as number
      if (nmpp === null) {
        nmpp = mpp
      } else if (Math.abs(mpp - nmpp) / Math.max(nmpp, 1e-12) > 0.02) {
        // 「同一种取图」才谈得上跨帧一致：标度不同的两帧上，同一个物理周期
        // 会落在不同的像素频率上，而那不是晶格变了。
        rejected.push({
          path: p,
          error: `像素标度与第一帧差 ${pyFixed((Math.abs(mpp - nmpp) / nmpp) * 100, 1)}%，不是同一种取图`,
        })
        continue
      }
      imgs.push(one.img as Mat)
      angles.push(one.angleDeg as number)
    }
    if (imgs.length < 2) {
      return { success: false, error: '能用的帧不足两张', data: { rejected } }
    }
    const r = assessAtomicConsistency(imgs, nmpp as number, angles)
    return {
      success: true,
      data: {
        verdict: r.verdict,
        n_frames: r.n_frames,
        n_atomic: r.n_atomic,
        n_unusable: r.n_unusable,
        n_no_lattice: r.n_no_lattice,
        period_spread: r.period_spread,
        angle_spread_deg: r.angle_spread_deg,
        reason: r.reason,
        per_frame: r.per_frame,
        warnings: [...r.warnings],
        rejected,
        angles_deg: angles,
      },
    }
  },
}

/** 这个文件里的技能。 */
export const ANALYSIS_MULTIFRAME: Readonly<Record<string, Skill>> = { AssessAtomicConsistency }
