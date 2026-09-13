/**
 * Lock-in 参数组 + 相位自动对齐 —— 三个技能，一条纪律：**数字不经过模型**。
 *
 * - `ListLockInPresets` —— 只读：组里有什么、每个数从哪来、哪些键没配。
 * - `ApplyLockInPreset` —— 按**组名**下发，零数值参数，写后回读比对。
 * - `AutoPhase` —— GUI 那个 Auto 按钮没有对应的 TCP 命令（38 条 `LockIn_*` 核过），
 *   但它做的事可以拼出来：读 X/Y → `atan2` 算角 → 写**解调侧** phase。
 *
 * ## 调制侧 phase 一律不碰（D-LOCKIN-1）
 *
 * 真机 2026-08-05：本机 Lock-In 面板的 Modulate 区**没有 phase 字段**，
 * `LockIn_ModPhasSet` 固件恒拒（**写同值也拒**）。相位的操作面在**解调侧**
 * （Ref. Phase，GUI 上带 Auto/+90/−90），`LockIn_DemodPhasSet` 实测可写。
 *
 * 所以判据落在**调用序列**上：`LockIn_ModPhasSet` 这条动词**根本不出现**。
 * 落在参数值上是不够的——挑不出「更好的相位值」来绕过一条恒拒的写。
 */
import {
  AUTOPHASE_MIN_SIGNAL,
  LOCKIN_READBACK_KEYS,
  PRESET_DIDV,
  PresetRejected,
  formatG,
  listLockInPresets,
  phaseMatches,
  phaseTarget,
  pyMean,
  resolveLockInPreset,
  sampleSd,
  signalMagnitude,
  valuesMatch,
  type LockInProfile,
  type PhaseMode,
  type ResolvedLockInPreset,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { closeModulation } from '../composite/modulation.js'
import { body, fail, num, ok, pyStr } from './common.js'

/**
 * 仪器档案里 lock-in 那一节。没接 ⇒ 视为一个键都没填。
 *
 * **绝不拿出厂默认顶上**（D-LOCKIN-2）：旧仓那两个键带 `973 Hz` / `0.02 V` 的出厂值，
 * 于是「档案没填就不下发」这句话永远没机会执行，而 `sources` 仍然说值来自仪器档案。
 */
export interface LockInPresetDeps {
  readonly lockinProfile?: () => LockInProfile | null
}

/**
 * 进程内的那一份 lock-in 档案 —— 与 `processPresetStore` 同样是**跨调用活着**的：
 * 用户在设置界面填一次，此后每一次调用都读它。宿主接线之前是 `null` = 一个键都没填。
 */
export const processLockInProfile: { current: LockInProfile | null } = { current: null }

const profileOf = (deps: LockInPresetDeps): LockInProfile | null =>
  deps.lockinProfile?.() ?? processLockInProfile.current

// ── 只读盘点 ───────────────────────────────────────────────────────────────

export function makeListLockInPresets(deps: LockInPresetDeps = {}): Skill {
  return {
    spec: S.ListLockInPresetsSpec,
    execute: (): Promise<SkillResultLike> =>
      Promise.resolve(ok({ presets: listLockInPresets(profileOf(deps)) })),
  }
}

// ── 按组名下发 ─────────────────────────────────────────────────────────────

/**
 * 组里长出了调制侧 phase 吗。**永远该是 `false`。**
 *
 * 提成函数是为了让这道闸有个名字：它拦的不是一次运行期错误，是一次**未来的编辑**
 * ——有人往 `PROFILE_KEYS` 里加了 `phase`，于是一条固件恒拒的写被排进了调用序列。
 */
function carriesModPhase(callParams: Readonly<Record<string, unknown>>): boolean {
  return 'phase_deg' in callParams
}

export function makeApplyLockInPreset(deps: LockInPresetDeps = {}): Skill {
  return {
    spec: S.ApplyLockInPresetSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const wanted = String(params['preset'] ?? '') || PRESET_DIDV
      let preset: ResolvedLockInPreset
      try {
        preset = resolveLockInPreset(wanted, profileOf(deps))
      } catch (e) {
        if (e instanceof PresetRejected) return fail(e.message)
        throw e
      }
      // 档案一个值都没有 ⇒ 拒绝。**静默不下发是假成功。**
      if (!preset.usable) return fail(preset.why(), preset.asDict())

      const callParams = preset.skillParams(params['mod_on'] !== false)
      if (carriesModPhase(callParams)) {
        return fail(
          '参数组里出现了调制侧 phase —— **本机固件恒拒写它**(写同值也拒),' +
            '这条命令不该进调用序列。相位请走 AutoPhase / ConfigureLockInDemod(解调侧)。',
        )
      }

      const data: Record<string, unknown> = preset.asDict()
      const res = await ctx.runSkill('ConfigureLockIn', callParams)
      data['applied'] = callParams
      data['configure_result'] = res.data ?? {}
      if (!res.success) {
        return fail(`下发 lock-in 参数组失败:${res.error ?? 'unknown'}`, data)
      }

      // 写后回读比对。**读不回来不算成功** —— 「写进去了」和「我们看见它在里面」
      // 是两句话。
      const rb = await ctx.runSkill('GetLockInConfig', {})
      const rbData: Readonly<Record<string, unknown>> = rb.data ?? {}
      data['readback'] = rbData
      const mismatches: string[] = []
      // 回读命令本身没跑成 ≠ 硬件里的值不对。**说清楚是哪一种。**
      if (!rb.success) mismatches.push(`回读命令失败:${rb.error ?? 'unknown'}`)
      for (const [param, want] of Object.entries(preset.values)) {
        const key = LOCKIN_READBACK_KEYS[param]
        if (key === undefined) {
          // 组里长出了新参数而这张表没跟上 —— **代码缺口，不是硬件问题**。
          // 静默跳过会让一个没被核对过的值挂着「已回读验证」的牌子。
          mismatches.push(`${param}: 没有回读映射(代码缺口)`)
          continue
        }
        const got = rbData[key]
        if (got === null || got === undefined) {
          mismatches.push(`${param}: 读不回来(回包里没有 ${key})`)
          continue
        }
        // 比较规则用仓里那一份（`valuesMatch`，rel_tol 1e-3），不自己写第二份。
        // float32 在这里不是问题：硬件回的是量化值（请求 0.02 → 读回
        // 0.019999999552965164，相对差 2e-8），而 1e-3 比 float32 的相对精度
        // （~1.2e-7）宽四个数量级。**用相等比较会把每一次成功写入都判成失败**
        // ——这条本仓 2026-09-13 在真 stmsim 上自己撞过一次（D-READBACK-1）。
        const verdict = valuesMatch(want, got)
        if (!verdict.ok) mismatches.push(`${param}: ${verdict.detail}`)
      }
      data['readback_verified'] = mismatches.length === 0
      if (mismatches.length > 0) {
        return fail(
          `下发后回读不一致:${mismatches.join(';')}。**不要按已设置继续**。`,
          data,
        )
      }
      return ok(data)
    },
  }
}

// ── 相位自动对齐 ───────────────────────────────────────────────────────────

/** 采样节奏（毫秒）。窗口内平均再算角，不用单次快照。 */
const POLL_INTERVAL_MS = 100

const failedCall = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/**
 * `Signals_ValsGet` 回包里的头两个浮点 —— 取**第一个数组字段**的前两个。
 *
 * 回包规格是 `["i", "*f"]`（先长度，再数组），所以 body 的第 0 位是个数、
 * 第 1 位才是那两个值。`firstTwoFloats` 在这里不对：它会把长度位当成 X。
 *
 * 数组元素也可能被裹成 1-元素包（协议里 `*f` 的两种形态），两种都接。
 */
export function demodPair(rec: SkillCallRecord): readonly [number, number] | null {
  for (const field of body(rec)) {
    if (!Array.isArray(field) || field.length < 2) continue
    const out: number[] = []
    for (const item of field.slice(0, 2)) {
      const v = Array.isArray(item) && item.length > 0 ? item[0] : item
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
      out.push(v)
    }
    return [out[0] as number, out[1] as number]
  }
  return null
}

/** 参数或档案里的一个信号索引。取不出给 `null`。 */
function pickIndex(raw: unknown, fromProfile: number | null): number | null {
  const v = raw === undefined || raw === null || raw === '' ? fromProfile : raw
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * `(X 索引, Y 索引, 拒绝理由)`。两处都没配就拒绝，**不猜**。
 *
 * 猜一个索引的代价不是「读不到」——是读到**另一路信号**，然后算出一个同样像模像样
 * 的角度写进硬件。本机 lock-in 的 X/Y 走哪两路 RT 信号是**接线事实**，
 * 软件观测不到，只能由用户填。
 */
export function signalIndices(
  params: Readonly<Record<string, unknown>>,
  profile: LockInProfile | null,
): { readonly x: number | null; readonly y: number | null; readonly why: string } {
  const x = pickIndex(params['x_signal_index'], profile?.xSignalIndex ?? null)
  const y = pickIndex(params['y_signal_index'], profile?.ySignalIndex ?? null)
  if (x !== null && y !== null) return { x, y, why: '' }
  const miss = [
    ['X', x],
    ['Y', y],
  ]
    .filter(([, v]) => v === null)
    .map(([n]) => n as string)
  return {
    x,
    y,
    why:
      `不知道解调 ${miss.join('/')} 在哪一路 RT 信号上 —— **拒绝对齐相位**。` +
      '请传 x_signal_index / y_signal_index,或在仪器档案里填 ' +
      'lockin_x_signal_index / lockin_y_signal_index。' +
      '(不猜:猜错读到的是另一路信号,而算出来的角度看上去一样合理,' +
      '然后它会被写进硬件。)',
  }
}

/** 采样 → 算角 → 写解调相位。**调制的开关不归它管**（见 `execute`）。 */
async function align(
  ctx: SkillContext,
  params: Readonly<Record<string, unknown>>,
  idxX: number,
  idxY: number,
): Promise<SkillResultLike> {
  const mode = (String(params['mode'] ?? '') || 'signal_to_x') as PhaseMode
  const windowS = typeof params['window_s'] === 'number' ? params['window_s'] : 3.0
  const demod = typeof params['demodulator'] === 'number' ? Math.trunc(params['demodulator']) : 1

  const xs: number[] = []
  const ys: number[] = []
  const t0 = ctx.now()
  while ((ctx.now() - t0) / 1000 < windowS) {
    if (ctx.signal.aborted) {
      // 中止的语义是「停手，别再动仪器」：相位没改过，**调制也不去碰** ——
      // 此刻可能正有一套急停序列在跑，往里插写操作不是收尾是打岔。
      return fail(
        '取样期间被中止 —— 相位未改动,**调制也未改动**' +
          '(中止后不再对仪器发写操作;调制此刻可能还开着)。',
        { aborted: true },
      )
    }
    // ⚠️ X/Y 来自 **RT 信号**（`Signals_ValsGet`），不是 `LockIn_DemodSignalGet` ——
    // 后者返回的是「这个解调器读的是哪一路信号」的**索引**，不是 X/Y 的值。
    // 旧仓第一版就是拿它当 X/Y 的：那样 `atan2` 算的是两个通道号的夹角，
    // 而结果看上去和真的一样合理。
    const rec = await ctx.safeCall('Signals_ValsGet', [idxX, idxY], 0)
    if (!failedCall(rec)) {
      const pair = demodPair(rec)
      if (pair !== null) {
        xs.push(pair[0])
        ys.push(pair[1])
      }
    }
    await ctx.sleep(POLL_INTERVAL_MS)
  }

  if (xs.length === 0) {
    return fail(
      '读不到解调器的 X/Y —— **判不了相位**。先确认调制已打开、解调通道配置正确。',
      { samples: 0 },
    )
  }

  // `pyMean` 而不是 `reduce((a, b) => a + b, 0) / n`：CPython 3.12 起 `sum()` 对浮点
  // 用 Neumaier 补偿求和，朴素相加在最后两位上就会分岔（见 `si.ts` 的 `pySum`）。
  const xMean = pyMean(xs)
  const yMean = pyMean(ys)
  const r = signalMagnitude(xMean, yMean)
  const evidence: Record<string, unknown> = {
    mode,
    samples: xs.length,
    window_s: windowS,
    x_mean: xMean,
    y_mean: yMean,
    r,
    x_sd: sampleSd(xs),
    y_sd: sampleSd(ys),
  }
  if (r < AUTOPHASE_MIN_SIGNAL) {
    // 「无信号」和「相位是 0」是两回事。**噪声上算出来的角只是噪声的角。**
    return fail(
      `X/Y 都在噪声底(|R| = ${formatG(r, 3)},下界 ${formatG(AUTOPHASE_MIN_SIGNAL, 1)})` +
        ' —— **无可用信号,不给相位角**。请先打开调制、或确认有信号源' +
        '(隧穿态下有 dI/dV,退针态下有电容串扰)。',
      evidence,
    )
  }

  // 当前相位：算出来的是**增量**，要加到现有相位上。
  const recCur = await ctx.safeCall('LockIn_DemodPhasGet', demod)
  const current = failedCall(recCur) ? null : num(recCur, 0)
  if (current === null) {
    return fail(
      '读不到当前解调相位 —— 算出来的是增量,没有起点就写不了。' +
        '(假起点会把相位转到一个谁也没要的地方。)',
      evidence,
    )
  }

  const { deltaDeg, targetDeg } = phaseTarget(mode, current, xMean, yMean)
  evidence['current_phase_deg'] = current
  evidence['delta_deg'] = deltaDeg
  evidence['target_phase_deg'] = targetDeg

  const recSet = await ctx.safeCall('LockIn_DemodPhasSet', demod, targetDeg)
  if (failedCall(recSet)) {
    return fail(`写解调相位失败:${recSet.error ?? ''}`, evidence)
  }

  const recRb = await ctx.safeCall('LockIn_DemodPhasGet', demod)
  const got = failedCall(recRb) ? null : num(recRb, 0)
  evidence['readback_phase_deg'] = got
  const verified = phaseMatches(targetDeg, got)
  evidence['readback_verified'] = verified
  if (!verified) {
    return fail(
      `写了 ${targetDeg.toFixed(2)}° 但回读是 ${pyStr(got)} —— 不一致,` +
        '**不要按已对齐继续**。',
      evidence,
    )
  }
  return ok(evidence)
}

export function makeAutoPhase(deps: LockInPresetDeps = {}): Skill {
  return {
    spec: S.AutoPhaseSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const idx = signalIndices(params, profileOf(deps))
      if (idx.x === null || idx.y === null) {
        // 纯输入校验的拒绝：**一次硬件调用都没发过 ⇒ 也不发关调制那一条**。
        // 一个什么都没做的拒绝不该留下写操作。
        return fail(idx.why, { x_signal_index: idx.x, y_signal_index: idx.y })
      }

      const res = await align(ctx, params, idx.x, idx.y)

      // 收尾：把调制关回去（缺陷⑪）。**成功和失败都关** —— 一次失败的对齐留下的
      // 调制，和一次成功的一样会污染后面所有电流判据。
      // 唯一不关的是**中止**，见 `align` 里那一支。
      if (res.data?.['aborted'] === true) return res
      const note = await closeModulation(ctx, 'AutoPhase')
      return { ...res, data: { ...(res.data ?? {}), ...note } }
    },
  }
}

export const ListLockInPresets: Skill = makeListLockInPresets()
export const ApplyLockInPreset: Skill = makeApplyLockInPreset()
export const AutoPhase: Skill = makeAutoPhase()

export const LOCKIN_PRESETS: Readonly<Record<string, Skill>> = {
  ListLockInPresets,
  ApplyLockInPreset,
  AutoPhase,
}
