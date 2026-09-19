/**
 * `InvertForceSaderJarvis` —— 把一条 Δf(z) 的 `.dat` 反演成力 F(z) 与势能 U(z)。
 *
 * 反演本体在 `dsh-spm-vision` 的 `force-inversion.ts`（纯函数、零 IO）。
 * 这一层负责：找列、取 f0 / k / A、减背景曲线、把 F(z) 与 U(z) 落盘。
 *
 * ## 三个传感器参数**刻意没有 default**
 *
 * `f0_hz` / `k_n_per_m` / `amplitude_m` 缺席时要能触发
 * 「**从 `.dat` 头取 → 从仪器档案取 → 拒绝**」这条回落链，而 `data.*_source`
 * 把走到了哪一档如实报出来。弹性常数 k **不在任何 Nanonis 头里** ——
 * 它来自针尖登记信息；拿不到就直接说，不猜。
 *
 * 一个有 default 的传感器参数会让「这台机器上没标过 k」永远看不见 ——
 * 同 `AssessScanTexture` 的 `good_ratio`（D-ZERO-1 那一族的孪生）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { readDat } from 'dsh-spm-nanonis-files'
import { interp } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { invertForceCurve, type ForceInversionResult } from 'dsh-spm-vision'

/** 模拟器与真机语料用的两种写法都认。 */
const DF_PATTERNS: readonly (readonly string[])[] = [
  ['freq', 'shift'],
  ['df'],
  ['frequency', 'shift'],
]
const Z_PATTERNS: readonly (readonly string[])[] = [['z rel'], ['z (m)'], ['z spectr']]
const AMP_PATTERNS: readonly (readonly string[])[] = [['amplitude']]

/** 第一个含全部子串的列名。**不区分正反扫** —— 旧仓这一族就是这么挑的。 */
function pick(columns: readonly string[], patterns: readonly (readonly string[])[]): string | null {
  for (const pat of patterns) {
    for (const name of columns) {
      const low = name.toLowerCase()
      if (pat.every((t) => low.includes(t))) return name
    }
  }
  return null
}

/** 头里第一个键名含全部子串、且值解得出数的那一条。 */
function headerNumber(header: Readonly<Record<string, string>>, ...tokens: readonly string[]): number | null {
  for (const [key, val] of Object.entries(header)) {
    const low = key.toLowerCase()
    if (!tokens.every((t) => low.includes(t))) continue
    const v = Number(String(val).trim())
    if (Number.isFinite(v)) return v
  }
  return null
}

/** 落盘产物的注入口（同 `frames.ts` / `readback-stream.ts` 的 `deps` 体例）。 */
export interface ForceDeps {
  /** F(z)/U(z) 曲线 JSON 的落点。缺省 `<cwd>/artifacts/force_inversion`。 */
  readonly curveDir?: () => string
}

/** 一个数在 Python 的 `if v:` 下是不是真。 */
function truthy(v: number | null): v is number {
  return v !== null && v !== 0
}

/**
 * 三档回落：入参 → `.dat` 头 → 仪器档案。**每一档都把来源写进回包。**
 *
 * 为什么来源必须出现在 `data` 里：一个从档案里取到的 `k = 1800` 与一个操作员
 * 当场传进来的 `k = 1800` 会给出**一模一样的力**，而它们的可信度完全不同。
 * 没有 `k_source` 这一列，下游读到的只是「有一个 k」。
 */
function sensor(
  params: Readonly<Record<string, unknown>>,
  name: string,
  header: Readonly<Record<string, string>>,
  headerTokens: readonly string[],
  profileKeys: readonly string[],
): [number | null, string] {
  const given = params[name]
  if (given !== undefined && given !== null && given !== '') return [Number(given), 'param']
  const val = headerNumber(header, ...headerTokens)
  if (truthy(val)) return [val, 'dat_header']
  for (const key of profileKeys) {
    const v = getConfig(key)
    const n = v === null || v === undefined || v === '' ? null : Number(v)
    if (truthy(n)) return [n, `instrument_profile:${key}`]
  }
  return [null, 'none']
}

/** 振幅的三档回落：入参 → 头 → **振幅列的中位数**（还要落在物理量程里）。 */
function amplitude(
  params: Readonly<Record<string, unknown>>,
  header: Readonly<Record<string, string>>,
  cols: Readonly<Record<string, Float64Array>>,
): [number | null, string] {
  const given = params['amplitude_m']
  if (given !== undefined && given !== null && given !== '') return [Number(given), 'param']
  const val = headerNumber(header, 'amplitude', 'setpoint')
  if (truthy(val)) return [val, 'dat_header']
  const col = pick(Object.keys(cols), AMP_PATTERNS)
  if (col !== null) {
    const arr = Array.from(cols[col] as Float64Array).filter((v) => Number.isFinite(v))
    if (arr.length > 0) {
      const s = arr.slice().sort((a, b) => a - b)
      const h = s.length >> 1
      const med = s.length % 2 === 1 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2
      if (med > 1e-13 && med < 1e-8) return [med, 'dat_column']
    }
  }
  return [null, 'none']
}

function saveCurve(res: ForceInversionResult, datPath: string, dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true })
    const base = datPath.replace(/\\/g, '/')
    const file = base.slice(base.lastIndexOf('/') + 1)
    const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file
    const out = join(dir, `${stem}_force.json`)
    writeFileSync(
      out,
      JSON.stringify({
        z_m: res.z_m,
        force_n: res.force_n,
        energy_ev: res.energy_ev,
        verdict: res.verdict,
        f_min_n: res.f_min_n,
        e_bind_ev: res.e_bind_ev,
      }),
      { encoding: 'utf8' },
    )
    return out
  } catch {
    return null
  }
}

/** Python 的 `str(sorted(list_of_str))` —— `['a', 'b']`。 */
function pyListRepr(xs: readonly string[]): string {
  return `[${xs.map((x) => `'${x}'`).join(', ')}]`
}

/** 见文件抬头。`deps` 只为把落盘产物指到别处（测试用），语义不变。 */
export function makeInvertForceSaderJarvis(deps: ForceDeps = {}): Skill {
  const curveDir = deps.curveDir ?? ((): string => join(process.cwd(), 'artifacts', 'force_inversion'))
  return {
    spec: S.InvertForceSaderJarvisSpec,
    execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
      const path = String(params['dat_path'] ?? '')
      if (path === '' || !existsSync(path)) return { success: false, error: `文件不存在: ${path}` }
      let got
      try {
        got = readDat(readFileSync(path), path)
      } catch (e) {
        return { success: false, error: `.dat 读取失败: ${(e as Error).message}` }
      }
      const cols = got.columns
      const header = got.header
      const names = Object.keys(cols)
      const zCol = String(params['z_column'] ?? '') || pick(names, Z_PATTERNS)
      const dfCol = String(params['df_column'] ?? '') || pick(names, DF_PATTERNS)
      if (zCol === null || dfCol === null || !(zCol in cols) || !(dfCol in cols)) {
        return { success: false, error: `谱里没有 z 或频移列(有的是 ${pyListRepr(names.slice().sort())})` }
      }
      const z = cols[zCol] as Float64Array
      const df = cols[dfCol] as Float64Array

      const [f0, f0Src] = sensor(params, 'f0_hz', header, ['center', 'freq'], [
        'qplus_f0_measured_hz',
        'qplus_f0_hz',
      ])
      const [k, kSrc] = sensor(params, 'k_n_per_m', header, ['spring', 'constant'], ['qplus_k_n_per_m'])
      const [amp, ampSrc] = amplitude(params, header, cols)
      const missing = ([['f0_hz', f0], ['k_n_per_m', k], ['amplitude_m', amp]] as const)
        .filter(([, v]) => v === null)
        .map(([n]) => n)
      if (missing.length > 0) {
        return {
          success: false,
          error:
            `缺传感器参数:${missing.join(', ')}。` +
            'f0 与振幅通常在 .dat 的 Oscillation Control 头里;' +
            '弹性常数 k 不在任何头里,要从针尖登记信息拿(qPlus 常见 1800 N/m)。',
        }
      }

      let bg: Float64Array | null = null
      const bgPath = String(params['background_dat_path'] ?? '')
      if (bgPath !== '') {
        if (!existsSync(bgPath)) return { success: false, error: `背景文件不存在: ${bgPath}` }
        try {
          const bgGot = readDat(readFileSync(bgPath), bgPath)
          const bgCols = bgGot.columns
          const bgNames = Object.keys(bgCols)
          const bzName = pick(bgNames, Z_PATTERNS)
          const bdfName = pick(bgNames, DF_PATTERNS)
          // 旧仓这里是 `bg_cols[None]` ⇒ `KeyError(None)`，而 `f"{exc}"` 就是 `None`。
          // 照移那句话（它进回包，模型读的就是它）。
          if (bzName === null || bdfName === null) throw new Error('None')
          const bz = bgCols[bzName] as Float64Array
          const bdf = bgCols[bdfName] as Float64Array
          const ord = Array.from(bz, (_, i) => i).sort((a, b) => (bz[a] as number) - (bz[b] as number) || a - b)
          const bzs = Float64Array.from(ord, (i) => bz[i] as number)
          const bdfs = Float64Array.from(ord, (i) => bdf[i] as number)
          const zs = Float64Array.from(z).sort()
          bg = Float64Array.from(zs, (x) => interp(x, bzs, bdfs))
        } catch (e) {
          return { success: false, error: `背景曲线读取失败: ${(e as Error).message}` }
        }
      }

      // ⚠️ `direction` 在旧仓**声明了但一次都没读**。spec 必须照抄（DoD ①），
      // 实现照抄那份「不读」—— 自作主张给它加上语义会让金样的每一格都对不上，
      // 而那不是修好一个 bug，是换掉一个技能。写在这里是为了让它看得见。
      const res = invertForceCurve(z, df, {
        f0Hz: f0 as number,
        kNPerM: k as number,
        amplitudeM: amp as number,
        backgroundDfHz: bg,
        smoothPoints: Math.trunc(Number(params['smooth_points'] ?? 0)) || 0,
      })
      const curvePath = saveCurve(res, path, curveDir())
      const fMinPn = res.f_min_n === null ? null : res.f_min_n * 1e12
      const eBindMev = res.e_bind_ev === null ? null : res.e_bind_ev * 1e3
      const decayPm = res.decay_length_m === null ? null : res.decay_length_m * 1e12
      const data: Record<string, unknown> = {
        verdict: res.verdict,
        f_min_pn: fMinPn,
        f_min_n: res.f_min_n,
        z_f_min_m: res.z_f_min_m,
        z_df_min_m: res.z_df_min_m,
        z_offset_fmin_minus_dfmin_pm:
          res.z_offset_fmin_minus_dfmin_m === null ? null : res.z_offset_fmin_minus_dfmin_m * 1e12,
        e_bind_mev: eBindMev,
        e_bind_ev: res.e_bind_ev,
        decay_length_pm: decayPm,
        forward_residual: res.forward_residual,
        amplitude_over_decay_length: res.amplitude_over_decay_length,
        well_posedness: res.well_posedness,
        background_used: res.background_used,
        f0_hz: f0,
        f0_source: f0Src,
        k_n_per_m: k,
        k_source: kSrc,
        amplitude_m: amp,
        amplitude_source: ampSrc,
        n_points: res.n_points,
        curve_path: curvePath,
        df_column: dfCol,
        z_column: zCol,
        reasons: [...res.reasons],
        warnings: [...res.warnings],
        dat_path: path,
        background_dat_path: bgPath || null,
      }
      const summary =
        fMinPn !== null
          ? `F_min = ${pyFixed(fMinPn, 1)} pN,E_b = ${pyFixed(eBindMev as number, 0)} meV,` +
            `衰减长度 ${pyFixed(decayPm ?? 0, 0)} pm` +
            `(正向残差 ${pyFixed(res.forward_residual as number, 3)},${res.well_posedness})`
          : `反演判定 ${res.verdict}:${res.reasons.join('、') || '无'}`
      return { success: true, data, summary }
    },
  }
}

/** 缺省实例（产物落 `<cwd>/artifacts/force_inversion`）。 */
export const InvertForceSaderJarvis: Skill = makeInvertForceSaderJarvis()

/** 这个文件里的技能。 */
export const ANALYSIS_FORCE: Readonly<Record<string, Skill>> = { InvertForceSaderJarvis }
