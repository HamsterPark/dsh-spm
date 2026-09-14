/**
 * 图样实验（`Pattern_*`）—— 让针尖按一条线、一片点云或一张网格逐点停下来测。
 *
 * ## 合法的 JSON 还不够
 *
 * `SetPatternCloud` 收的是两串 JSON 数组。而 `"5"` **是合法 JSON** —— 它解出来
 * 是整数 5，随后 `len()` 抛 `TypeError`，那个异常到不了 `SkillResult`：
 * 没有错误分支、没有重试，**一个死掉的回合**。
 *
 * 而一个模型写 `x_coords="5"` 表示「就一个点」（忘了那对方括号）不是什么异国情调
 * 的输入，它是**最可能的那个错**。所以解完之后还要问一句「它是不是一个数组」。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, cell, fail, ok, pyStr } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const f = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? (p[k] as number) : dflt
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt


const at = (rec: SkillCallRecord, i: number): number | null => {
  const v = body(rec)[i]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
const trunc = (v: number | null): number | null => (v === null ? null : Math.trunc(v))

/**
 * Python `json.loads` 那句话，逐字（同 `tail-l0.ts` 的 `PY_JSON_ERROR`）。
 *
 * `JSON.parse` 与 `json.JSONDecodeError` 的英文不一样，而这句话是模型读的。
 * 位置写死在第 1 列：见 D-JSON-1。
 */
const PY_JSON_ERROR = 'Expecting value: line 1 column 1 (char 0)'

export const OpenPatternExperiment: Skill = {
  spec: S.OpenPatternExperimentSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('Pattern_ExpOpen')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ opened: true })
  },
}

export const PausePatternExperiment: Skill = {
  spec: S.PausePatternExperimentSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const pause = params['pause'] === true
    const rec = await ctx.safeCall('Pattern_ExpPause', pause ? 1 : 0)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ paused: pause })
  },
}

export const SetPatternLine: Skill = {
  spec: S.SetPatternLineSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const setActive = params['set_active'] !== false ? 1 : 0
    const numPoints = int(params, 'num_points')
    const scanFrame = params['use_scan_frame'] === true ? 1 : 0
    const p1x = f(params, 'p1_x_m')
    const p1y = f(params, 'p1_y_m')
    const p2x = f(params, 'p2_x_m')
    const p2y = f(params, 'p2_y_m')
    const rec = await ctx.safeCall(
      'Pattern_LineSet', setActive, numPoints, scanFrame, p1x, p1y, p2x, p2y,
    )
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ num_points: numPoints, p1: [p1x, p1y], p2: [p2x, p2y] })
  },
}

export const SetPatternCloud: Skill = {
  spec: S.SetPatternCloudSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const setActive = params['set_active'] !== false ? 1 : 0
    let xs: unknown
    let ys: unknown
    try {
      xs = JSON.parse(String(params['x_coords']))
      ys = JSON.parse(String(params['y_coords']))
    } catch {
      return fail(`Invalid JSON in cloud coordinates: ${PY_JSON_ERROR}`)
    }
    // **合法 JSON 还不够。** 见文件抬头：`"5"` 解得干干净净，然后在下一行炸掉。
    for (const [label, seq] of [['x_coords', xs], ['y_coords', ys]] as const) {
      if (!Array.isArray(seq)) {
        return fail(
          `${label} 必须是 JSON 数组，例如 "[1e-9, 2e-9]"；` +
            `收到的是 ${pyTypeName(seq)}（'${String(params[label] ?? '')}'）——` +
            '单个点也要写成数组："[1e-9]"',
        )
      }
    }
    const x = xs as number[]
    const y = ys as number[]
    if (x.length !== y.length) {
      return fail('x_coords and y_coords must have equal length')
    }
    const rec = await ctx.safeCall('Pattern_CloudSet', setActive, x.length, x, y)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ num_points: x.length })
  },
}

/** Python 的 `type(x).__name__`——只在那一句报错里用。 */
function pyTypeName(v: unknown): string {
  if (v === null) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'string') return 'str'
  if (Array.isArray(v)) return 'list'
  return 'dict'
}

export const GetPatternCloud: Skill = {
  spec: S.GetPatternCloudSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('Pattern_CloudGet')
    if (failed(rec)) return fail(rec.error ?? '')
    const v = body(rec)
    if (v.length < 3) return ok({ raw: cell(rec) })
    return ok({
      num_points: trunc(at(rec, 0)),
      x_coords: asList(v[1]),
      y_coords: asList(v[2]),
    })
  },
}

/** 一个可能是标量也可能是数组的坐标槽 —— 标量就裹成单元素表。 */
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? [...v] : [v])

export const GetPatternProps: Skill = {
  spec: S.GetPatternPropsSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('Pattern_PropsGet')
    if (failed(rec)) return fail(rec.error ?? '')
    const v = body(rec)
    if (v.length < 9) return ok({ raw: cell(rec) })
    return ok({
      experiments_size: trunc(at(rec, 0)),
      num_experiments: trunc(at(rec, 1)),
      experiments: v[2],
      selected_exp_size: trunc(at(rec, 3)),
      selected_experiment: pyStr(v[4]),
      ext_vi_path_size: trunc(at(rec, 5)),
      ext_vi_path: pyStr(v[6]),
      pre_measure_delay_s: at(rec, 7),
      save_scan_channels: Boolean(v[8]),
    })
  },
}

export const PATTERN: Readonly<Record<string, Skill>> = {
  OpenPatternExperiment,
  PausePatternExperiment,
  SetPatternLine,
  SetPatternCloud,
  GetPatternCloud,
  GetPatternProps,
}
