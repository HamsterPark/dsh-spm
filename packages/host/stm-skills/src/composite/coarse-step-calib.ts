/**
 * `CalibrateCoarseStep` —— 粗动一步走多远？**用有刻度的压电去量没刻度的马达。**
 *
 * ## 为什么需要（本机的一个真实盲区）
 *
 * 粗动**没有位置反馈**：`Motor_GetPos` / `Motor_StepCounterGet` 在本机 PMD 上都回
 * 「Cannot access Motor Control Module」（那是「本控制器不支持」，不是「模块没运行」）。
 * 于是「走了多远」只能靠步数推算，而步数与距离的比例从来没人量过。
 *
 * 压电是标定过的。所以：**在表面上扎一个坑当基准，粗动 N 步，再扫同一个压电中心，
 * 用整幅图的相位相关求位移** —— 位移 ÷ N 就是每步多远。
 *
 * ## 三条从失败里学到的设计（2026-08-28，三次都没跑完）
 *
 * 1. **不能用 `RelocateCoarseXY`**：它的前置检查要求落点离已访问站点 ≥200 步，
 *    而标定要的正是小步长 ⇒ 直接被拒。那是「别重复访问」的效率约束，不是安全约束；
 *    安全那部分（降压、退针、**验电流真的归零**）本技能自己做。
 * 2. **步数要很小**：若样品倾斜约 1°，每步可能是 100 nm 量级 ⇒ 20 步 = 2 µm 早跑出视野。
 * 3. **动马达之前必须确认扫描真的结束了**：那一夜停了本地脚本，而仪器端的 `ScanAt`
 *    还持有锁 363 秒 —— 期间针尖撞上东西、放大器锁死在 10 nA。
 *    **「命令被挡在门外」和「命令发出去但没效果」长得一样。**
 *
 * ## ⚠️ 整条标定循环在**新旧两仓都是死代码**
 *
 * `_scan` 取的是 `ScanAt` 回包里的 `scan_path` / `path`，而 **`ScanAt` 两个都不写**
 * （旧仓 `composite/scan_at.py:368-389` 的 `set_partial` 清单、本仓
 * `scan-at.ts:183-198` + `:211-228` 的 `snapshot`，逐键比过，见 `bias-series.ts` 抬头那张表）。
 *
 * ⇒ `ref_path` 恒为假 ⇒ `execute` **恒在 `:203-204` 返回「基准帧扫描失败」**，
 * `_load` / `phase_shift` / 清障 / 马达 / 线性自证**一行都到不了**。
 *
 * **旁证**：旧仓自己的 docstring（`coarse_step_calib.py:98-99`）写着
 * 「三次尝试都被别的问题打断（站点检查、视野太小、仪器锁），**尚未在真机上跑完一次完整标定**」。
 *
 * **这一批不给 `ScanAt` 补那个键**（独立决定）。这里做的是：照移整条路 ·
 * 登记它是死的 · 一条**量着它**的测试。金样里那几格走完整条循环，是因为导出器与
 * 重放侧**都**给 `ScanAt` 脚本了一个路径 —— 那一格叫 `hypothetical_*`，
 * 名字本身说明它今天到不了。
 *
 * ## 一处**不照抄**的旧仓缺陷（DoD ⑤）
 *
 * `phase_shift` 在「两帧形状对不上」或「边长 < 16」时回 `(None, None, None)`。
 * 旧仓紧接着的分支是
 *
 * ```python
 * if snr is not None and snr < _MIN_CORR_SNR: row["refused"] = …
 * else: row["nm_per_step_x"] = row["dx_nm"] / n      # ← dx_nm 是 None
 * ```
 *
 * `snr is None` ⇒ 走 `else` ⇒ `None / n` ⇒ **`TypeError` 抛出 `execute`**。
 * 那正是 `barrier_map.py:execute` 抬头警告过的形状：「抛异常的技能到不了 agent 的
 * 错误处理路径 —— 没有 SkillResult、没有诊断记录、没有 HITL、没有恢复，
 * 只剩一个死掉的回合。」
 *
 * 本仓走同一族的 **D-SKILL-3**：给一条说得清的拒绝，写进那一行的 `refused`。
 * 登记在 `spec/deviations.md`。
 */
import { pyFixed, pySum, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { phaseShift } from 'dsh-spm-numerics'
import { planeSubtractRobust } from 'dsh-spm-vision'
import type { Mat } from 'dsh-spm-numerics'
import * as S from '../generated/specs.js'
import { loadSxm, orient } from '../l0/analysis-common.js'
import { fail, ok } from '../l0/common.js'

/** 相位相关峰的锐度下限（峰／中位）。低于它说明两帧没有可对齐的共同特征。 */
export const MIN_CORR_SNR = 12.0

/** 退针后判「针尖确实自由了」的电流上限（A）。 */
export const CLEAR_CURRENT_A = 1e-12

/** 横移期间的安全偏压（V）。同 relocate：带成像偏压时几十 nm 就场发射。 */
export const MOVE_BIAS_V = 0.5

/** 线性自证的容忍度：不同步数给出的「每步多远」彼此差多少还算线性。 */
export const MAX_SPREAD_FRAC = 0.35

export interface CoarseCalibDeps {
  /** 每一步之间的稳定时间（s）。旧仓是类属性 `_settle_s = 1.5`。 */
  readonly settleS?: number
}

const data0 = (r: SkillResultLike): Record<string, unknown> =>
  (r.data as Record<string, unknown> | undefined) ?? {}

/** `_load` —— 读一张 `.sxm`，取 Z 通道的正扫帧，扣掉稳健平面。 */
export function loadLevelled(path: string): { ok: true; frame: Mat } | { ok: false; why: string } {
  const got = loadSxm(path, path)
  if (!got.ok) return { ok: false, why: got.why }
  const fr = orient(got.scan, 'Z')
  if (fr.forward === null) {
    // 旧仓 `np.asarray(None, float)` 在这里抛 TypeError（同抬头那条 D-SKILL-3）。
    return { ok: false, why: `${path} 里没有 Z 通道的正扫帧` }
  }
  return { ok: true, frame: planeSubtractRobust(fr.forward) }
}

export function makeCalibrateCoarseStep(deps: CoarseCalibDeps = {}): Skill {
  const settleS = deps.settleS ?? 1.5
  return {
    spec: S.CalibrateCoarseStepSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const axis = String(params['axis'] ?? '').toLowerCase()
      if (axis !== 'x' && axis !== 'y') {
        return fail(`axis 只能是 'x' 或 'y'（给了 ${pyRepr(params['axis'])}）`)
      }
      const rawSteps = String(params['steps'] ?? '') === '' ? '2,4' : String(params['steps'])
      const stepsParsed: number[] = []
      for (const t of rawSteps.split(',')) {
        if (t.trim() === '') continue
        const v = pyInt(t)
        if (v === null) return fail(`steps 解析不了：${pyRepr(params['steps'])}`)
        stepsParsed.push(v)
      }
      const stepsList = stepsParsed.filter((s) => s > 0)
      if (stepsList.length < 2) {
        return fail(
          '至少要两个不同步数 —— 单个步数算得出一个数，' +
            '但**没有任何东西能证明它是线性的**（位移该与步数成比例）。',
        )
      }
      const rawSize = params['size_m']
      const sizeM = rawSize === undefined || rawSize === null || Number(rawSize) === 0 ? 1.5e-6 : Number(rawSize)

      // ── 动马达之前先确认没有别的链路握着仪器（08-28 撞针的直接原因）──
      const lock = await ctx.runSkill('MotorMove', { direction: 'z-retract', steps: 0 })
      const lockErr = String(lock.error ?? '')
      const free = !lockErr.includes('占用') && !lockErr.toLowerCase().includes('busy')
      if (!free) {
        return {
          success: false,
          error: `仪器正被另一条链路占用，不能动马达：${lockErr.slice(0, 200)}`,
          data: { blocked_by_lock: true },
        }
      }

      const fr = data0(await ctx.runSkill('GetScanFrame', {}))
      const cxM = orZero(fr['center_x_m'])
      const cyM = orZero(fr['center_y_m'])
      const nmPx = (sizeM * 1e9) / 256.0

      const makePit = params['make_pit'] === undefined ? true : params['make_pit'] === true
      if (makePit) {
        for (let i = 0; i < 4; i += 1) {
          await ctx.runSkill('TipShape', {
            tip_lift_m: -10e-9,
            lift_height_m: 10e-9,
            lift_time_1_s: 0.1,
            lift_time_2_s: 0.1,
            bias_lift_v: 0.02,
            change_bias: false,
            bias_settling_s: 0.5,
            end_wait_s: 0.2,
            restore_feedback: true,
          })
          await ctx.sleep(400)
        }
      }

      const scanAt = async (): Promise<string | null> => {
        const res = await ctx.runSkill('ScanAt', {
          center_x_m: cxM,
          center_y_m: cyM,
          size_m: sizeM,
          pixels: 256,
          line_time_s: 0.04,
          purpose: 'survey',
        })
        const d = data0(res)
        // ⚠️ 见抬头：`ScanAt` 这两个键一个都不写 —— 这一行在生产上恒为 `null`。
        const p = d['scan_path'] ?? d['path']
        return p === undefined || p === null || p === '' ? null : String(p)
      }

      const refPath = await scanAt()
      if (refPath === null) return fail('基准帧扫描失败。')
      const first = loadLevelled(refPath)
      if (!first.ok) return fail(`基准帧读不动：${first.why}`)
      let prev: Mat = first.frame

      const runs: Record<string, unknown>[] = []
      for (const n of stepsList) {
        // 降压 → 退针 → **证明**电流归零。证不出来就不动马达。
        await ctx.runSkill('SetBias', { bias_v: MOVE_BIAS_V })
        await ctx.sleep(500)
        await ctx.runSkill('WithdrawTip', {})
        await ctx.sleep(settleS * 1000)
        const curRaw = data0(await ctx.runSkill('GetCurrent', {}))['current_a']
        const cur = curRaw === undefined || curRaw === null ? null : Number(curRaw)
        if (!(cur !== null && Math.abs(cur) <= CLEAR_CURRENT_A)) {
          runs.push({ steps: n, abort: '清障未通过', current_a: cur })
          break
        }
        const moved = await ctx.runSkill('MotorMove', { direction: `${axis}+`, steps: Math.trunc(n) })
        if (moved.success !== true) {
          runs.push({ steps: n, abort: 'MotorMove 失败', error: String(moved.error ?? '').slice(0, 180) })
          break
        }
        const ap = await ctx.runSkill('ApproachTip', {})
        if (ap.success !== true) {
          runs.push({ steps: n, abort: '重新进针失败' })
          break
        }
        const path = await scanAt()
        if (path === null) {
          runs.push({ steps: n, abort: '扫描失败' })
          break
        }
        const loaded = loadLevelled(path)
        if (!loaded.ok) {
          // 旧仓这里 `_load` 直接抛（文件读不动 / 没有 Z 通道），异常穿出 `execute`。
          // 同抬头那条：给一条说得清的中止，别弄死整个回合。**中止理由与
          // 「扫描失败」分开** —— 前者是「扫出来了但读不动」，两者的下一步不同。
          runs.push({ steps: n, abort: '扫描图读不动', error: loaded.why })
          break
        }
        const img = loaded.frame
        const shift = phaseShift(prev, img)
        const row: Record<string, unknown> = {
          steps: n,
          dx_nm: shift === null ? null : shift.dx * nmPx,
          dy_nm: shift === null ? null : shift.dy * nmPx,
          corr_snr: shift === null ? null : shift.snr,
        }
        if (shift === null) {
          // **不照抄旧仓的 TypeError**（见抬头 DoD ⑤ 那一节）。
          row['refused'] =
            '两帧形状对不上，或边长不足 16 px —— 相位相关做不了，**不报位移**。' +
            '（旧仓这条路直接抛 TypeError，把整个回合弄死；见 spec/deviations.md。）'
        } else if (shift.snr < MIN_CORR_SNR) {
          row['refused'] =
            `相关峰锐度 ${pyFixed(shift.snr, 1)} < ${pyFixed(MIN_CORR_SNR, 0)} —— 两帧之间没有可对齐的共同特征，` +
            '**不报位移**。多半是位移超出视野（把 steps 调小或 size 调大），或表面太平（开 make_pit）。'
        } else {
          row['nm_per_step_x'] = (row['dx_nm'] as number) / n
          row['nm_per_step_y'] = (row['dy_nm'] as number) / n
        }
        runs.push(row)
        prev = img
      }

      const good = runs.filter((r) => r['nm_per_step_x'] !== undefined && r['nm_per_step_x'] !== null)
      const data: Record<string, unknown> = {
        axis,
        size_m: sizeM,
        nm_per_px: nmPx,
        runs,
        min_corr_snr: MIN_CORR_SNR,
      }
      if (good.length < 2) {
        data['verdict'] = 'undetermined'
        data['message'] =
          '可用测量不足 2 个 —— **判不了**。单点算得出一个数，但证不了线性；这里不给那个数。'
        return ok(data)
      }

      // 线性自证：位移÷步数在不同步数下应当一致
      const key = `nm_per_step_${axis}`
      const vals = good.map((r) => Math.abs(r[key] as number))
      // 旧仓这里写的是内建 `sum(vals)/len(vals)` ⇒ CPython 3.12+ 的补偿求和。
      const mean = pySum(vals) / vals.length
      const spread = (Math.max(...vals) - Math.min(...vals)) / Math.max(mean, 1e-12)
      data['nm_per_step'] = mean
      data['spread_frac'] = spread
      data['verdict'] = spread <= MAX_SPREAD_FRAC ? 'ok' : 'nonlinear'
      data['message'] =
        `${axis} 轴每步 ≈ ${pyFixed(mean, 1)} nm（${good.length} 个步数，彼此差 ${pyFixed(100 * spread, 0)}%）。` +
        (spread <= MAX_SPREAD_FRAC
          ? ''
          : ' **不同步数给出的每步距离差得太多** —— 可能有滑移或黏滑不均，这个平均值别当成刻度用。')
      return ok(data)
    },
  }
}

/** `float(x or 0.0)`。 */
function orZero(v: unknown): number {
  if (v === undefined || v === null) return 0.0
  const n = Number(v)
  return Number.isNaN(n) ? 0.0 : n
}

/** Python 的 `int(s)`：只认整数字面量（前后空白照吃）。 */
function pyInt(s: string): number | null {
  const t = s.trim()
  if (!/^[+-]?\d+$/.test(t)) return null
  return Number.parseInt(t, 10)
}

/** Python 的 `%r`。 */
function pyRepr(v: unknown): string {
  if (v === null) return 'None'
  if (v === undefined) return 'None'
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

export const CalibrateCoarseStep: Skill = makeCalibrateCoarseStep()

/** 这一族（`builtins.coarse_step_calib`，1/1）。 */
export const COARSE_STEP_CALIB: Readonly<Record<string, Skill>> = { CalibrateCoarseStep }
