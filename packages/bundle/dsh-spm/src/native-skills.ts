/**
 * The native simulator profile deliberately exposes only these seven skills.
 * Read skills keep their existing contracts. Writes add live verification here,
 * without changing the migrated skills or claiming new MAST golden evidence.
 */
import {
  SET_NO_CHANGE,
  SET_OFF,
  biasNeedsSafePath,
  scalarFloat,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  GetBias,
  GetCurrent,
  GetZPosition,
  IMPLEMENTED,
  SetBias,
  StartScan,
  StopScan,
} from 'dsh-spm-stm-skills'
import type { MinimalResultRecord } from './minimal-persistence.js'

const SCAN_VERIFY_ATTEMPTS = 11
const SCAN_VERIFY_INTERVAL_MS = 100

/** 走安全路径成功时从 `BiasSettleChange` 的结果里带出的字段（参考实现的外部动作面也只带这四个）。 */
const ROUTED_FIELDS = ['bias_v_start', 'strategy', 'crossed_zero', 'settle_s'] as const

/**
 * 让状态缓存（和随后写进记录的 stateDelta）拿到仪器上的实际值。尽力而为：调用方的失败结果已经确定，
 * 刷新抛什么都不改变它（身份丢失之类下一次调用自己会报）。取消之后不再开始刷新；如果取消落在刷新进行中，
 * 剩下的 monitor 读还会照发，因为它们走的是状态服务自己的通道，不看取消信号。
 */
async function refreshCache(ctx: SkillContext): Promise<void> {
  if (ctx.signal.aborted) return
  try {
    await ctx.refreshState()
  } catch {
    // 见上
  }
}

/**
 * 子技能的失败文本是一行说明，后面每一层跟一行 JSON 数据。只留说明：斜坡失败时那几行数据里的 `bias_v` 是
 * 子技能的目标值，而偏压其实停在半路，模型会先读到它。子技能的字段已经经 `...res.data` 并进顶层数据，不会丢。
 */
function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text
}

function unexpectedParams(params: Readonly<Record<string, unknown>>, allowed: readonly string[]): string[] {
  return Object.keys(params).filter((name) => !allowed.includes(name)).map((name) =>
    `原生模拟器最小工具不支持参数 '${name}'。`,
  )
}

/** Only the GET wire values 0/1 are evidence of stopped/running. */
async function scanStatus(ctx: SkillContext): Promise<SkillResultLike> {
  const rec = await ctx.safeCall('Scan_StatusGet')
  if (rec.error) return { success: false, error: rec.error, data: { scan_running: null } }
  const status = scalarFloat(rec.values?.[0])
  if (status !== 0 && status !== 1) {
    return {
      success: false,
      error: 'scan_status_unreadable: Scan_StatusGet 没有返回有效的 0/1 状态，无法判断扫描是否运行。',
      data: { scan_running: null, scan_status: status },
    }
  }
  return { success: true, data: { scan_running: status === 1, scan_status: status } }
}

export const NativeGetScanStatus: Skill = {
  spec: {
    name: 'GetScanStatus',
    description: '从当前 Nanonis 模拟器实时读取扫描状态；running 表示正在扫描，stopped 表示已经停止。',
    parameters: [],
    category: 'read',
    tags: ['scan', 'read', 'native-simulator'],
    safetyLevel: 'AUTO',
  },
  validateParams: (params) => unexpectedParams(params, []),
  execute: (ctx) => scanStatus(ctx),
}

export const NativeSetBias: Skill = {
  spec: {
    ...SetBias.spec,
    description: "设置模拟器偏压，并回读确认。bias_v 支持伏特数值或带 SI 前缀的字符串，例如 0.1 或 '100m'，不要附加单位 V。" +
      '本工具没有 ramp 参数：偏压要变号、变化超过 0.5 V、目标落在 ±50 mV 内，或当前偏压读不到时，会自动改走安全路径' +
      '（BiasSettleChange：斜坡过零并等待稳定，通常要几秒），结果里的 path 说明走了哪条路。' +
      '目标落在 ±50 mV 死区内而 Z 反馈开着（或状态未知）时会被拒绝；本工具集不能关反馈，请改用更大的偏压。',
    parameters: SetBias.spec.parameters.filter((p) => p.name === 'bias_v'),
    tags: [...(SetBias.spec.tags ?? []), 'readback', 'native-simulator'],
  },
  validateParams: (params) => [
    ...unexpectedParams(params, ['bias_v']),
    ...(typeof params['bias_v'] !== 'number' || !Number.isFinite(params['bias_v'])
      ? ['bias_v 必须是可解析的有限电压。'] : []),
  ],
  execute: async (ctx, params) => {
    const target = params['bias_v'] as number
    // 先读起点再分流：变号、大幅、落进死区、起点读不到，都不直接写（见 biasNeedsSafePath）。
    // 读不到起点不在这里拒绝——BiasSettleChange 自己读不到会拒绝，那时一次 Bias_Set 都没发。
    const startRead = await GetBias.execute(ctx, {})
    const startValue = startRead.success ? startRead.data?.['bias_v'] : undefined
    const startV = typeof startValue === 'number' ? startValue : null
    const safe = biasNeedsSafePath(startV, target)
    const path = safe ? 'BiasSettleChange' : 'SetBias'
    const routed: Record<string, unknown> = {}
    if (safe) {
      const res = await ctx.runSkill('BiasSettleChange', { bias_v: target })
      if (!res.success) {
        // 结果里有 strategy 说明已经开始动偏压（斜坡中途失败）；没有就是事前拒绝
        // （读不到起点、目标落进死区），一次 Bias_Set 都没发。
        const sent = res.data?.['strategy'] !== undefined
        const back = sent ? await GetBias.execute(ctx, {}) : undefined
        const actual = back?.success === true ? back.data?.['bias_v'] : undefined
        // 读得到实际值，说明链路还活着而偏压已被改动：缓存里还是改动前的值，刷新一次。
        // 取消之后读不到（也不该再发任何命令），回读和刷新都不做。
        if (typeof actual === 'number') await refreshCache(ctx)
        return {
          success: false,
          error: firstLine(res.error ?? 'BiasSettleChange failed'),
          data: {
            ...res.data,
            path,
            requested_bias_v: target,
            command_sent: sent,
            verified: false,
            bias_v: typeof actual === 'number' ? actual : null,
          },
        }
      }
      for (const key of ROUTED_FIELDS) if (res.data?.[key] !== undefined) routed[key] = res.data[key]
    } else {
      const written = await SetBias.execute(ctx, params)
      if (!written.success) return written // 参考 SetBias 直写自己的失败，原样返回
      if (startV !== null) routed['bias_v_start'] = startV
    }
    const readback = await GetBias.execute(ctx, {})
    if (!readback.success) {
      return {
        success: false,
        error: `bias_readback_failed: 偏压命令已下发，但回读失败；当前偏压未确认。${readback.error ?? ''}`,
        data: { requested_bias_v: target, bias_v: null, verified: false, command_sent: true, path, ...routed },
      }
    }
    const observed = readback.data?.['bias_v'] as number
    // Bias.Set/Get use IEEE 754 float32. Allow representation rounding, not a
    // materially different setpoint; the absolute floor is 0.1 microvolt.
    const tolerance = Math.max(1e-7, Math.abs(target) * 2 ** -22)
    const verified = Math.abs(observed - target) <= tolerance
    const data = {
      requested_bias_v: target,
      bias_v: observed,
      readback_tolerance_v: tolerance,
      verified,
      command_sent: true,
      path,
      ...routed,
    }
    if (verified) return { success: true, data }
    // 回读不符：缓存里的不是实际值 —— 走安全路径时，子步成功后内核已把请求值补进缓存（K12）；直写路径上
    // 缓存还是改动前的值。刷新一次，缓存和随后写进记录的 stateDelta（K15）才拿到实际值。
    // 规则统一：回读不符就刷新；回读失败或取消就不刷新（那时链路多半有问题，或不该再发读，缓存不可信）。
    await refreshCache(ctx)
    return {
      success: false,
      error: `bias_readback_mismatch: 请求 ${target} V，实际回读 ${observed} V；偏压设置未通过验证。`,
      data,
    }
  },
}

/** A short bounded wait tolerates asynchronous scan transitions, never retries a write. */
async function verifyScan(ctx: SkillContext, running: boolean): Promise<SkillResultLike> {
  let observed: SkillResultLike | undefined
  for (let attempt = 0; attempt < SCAN_VERIFY_ATTEMPTS; attempt += 1) {
    observed = await scanStatus(ctx)
    if (!observed.success) {
      return {
        success: false,
        error: `scan_readback_failed: 扫描命令已下发，但状态回读失败；当前扫描状态未确认。${observed.error ?? ''}`,
        data: { ...observed.data, verified: false, command_sent: true },
      }
    }
    if (observed.data?.['scan_running'] === running) {
      return { success: true, data: { ...observed.data, verified: true, command_sent: true } }
    }
    if (attempt + 1 < SCAN_VERIFY_ATTEMPTS) await ctx.sleep(SCAN_VERIFY_INTERVAL_MS)
  }
  return {
    success: false,
    error: `scan_readback_mismatch: 扫描命令已下发，但回读未确认${running ? '开始运行' : '停止'}。`,
    data: { ...observed?.data, verified: false, command_sent: true },
  }
}

export const NativeStopScan: Skill = {
  spec: {
    ...StopScan.spec,
    description: '停止当前扫描，并实时回读确认扫描已经停止。',
    tags: [...(StopScan.spec.tags ?? []), 'readback', 'native-simulator'],
  },
  validateParams: (params) => unexpectedParams(params, []),
  execute: async (ctx, params) => {
    const written = await StopScan.execute(ctx, params)
    if (!written.success) return written
    return verifyScan(ctx, false)
  },
}

export const NativeStartScan: Skill = {
  spec: {
    ...StartScan.spec,
    description: '用模拟器当前参数启动一次扫描，并回读确认已经运行。要求 Z 反馈已开启且当前没有扫描；保留保存设置，必要时关闭连续扫描。本工具不允许覆盖连续扫描检查。',
    parameters: StartScan.spec.parameters.filter((p) => p.name === 'direction'),
    tags: [...(StartScan.spec.tags ?? []), 'readback', 'native-simulator'],
  },
  validateParams: (params) => unexpectedParams(params, ['direction']),
  execute: async (ctx, params) => {
    // The kernel checks the module state; check the live controller separately.
    // In particular, unknown cached state must not permit a new scan.
    const feedback = await ctx.safeCall('ZCtrl_OnOffGet')
    if (feedback.error) return { success: false, error: feedback.error }
    if (scalarFloat(feedback.values?.[0]) !== 1) {
      return {
        success: false,
        error: 'feedback_not_on: 未实时确认 Z 反馈已开启。请先在模拟器中开启 Z feedback，再启动扫描。',
      }
    }
    const beforeStatus = await scanStatus(ctx)
    if (!beforeStatus.success) return beforeStatus
    if (beforeStatus.data?.['scan_running'] === true) {
      return { success: false, error: 'scan_already_running: 已有扫描正在运行，请先停止它。', data: beforeStatus.data }
    }

    const props = await ctx.safeCall('Scan_PropsGet')
    if (props.error) return { success: false, error: props.error }
    const body = props.values
    const continuousBefore = scalarFloat(body?.[0])
    if (continuousBefore !== 0 && continuousBefore !== 1) {
      return {
        success: false,
        error: 'continuous_scan_unknown: 无法确认连续扫描状态，未发起扫描。请修复读取或在模拟器中关闭 Continuous scan。',
      }
    }

    let propsWritten = false
    if (continuousBefore === 1) {
      const count = body?.[8]
      const modules = body?.[9]
      // With continuous already off there is no write, even on an older reply
      // shape. Otherwise require the complete property reply before roundtrip.
      if (!body || body.length !== 16 || typeof body[4] !== 'string' || typeof body[6] !== 'string' ||
          typeof count !== 'number' || !Number.isInteger(count) || count < 0 ||
          !Array.isArray(modules) || modules.length !== count || !modules.every((m) => typeof m === 'string')) {
        return {
          success: false,
          error: 'scan_props_incomplete: 连续扫描已开启，但无法完整保留保存设置。请在模拟器中手动关闭 Continuous scan。',
        }
      }
      const write = await ctx.safeCall(
        'Scan_PropsSet', SET_OFF, SET_NO_CHANGE, SET_NO_CHANGE, body[4], body[6], modules, SET_NO_CHANGE,
      )
      if (write.error) return { success: false, error: write.error }
      propsWritten = true
      const after = await ctx.safeCall('Scan_PropsGet')
      if (after.error || scalarFloat(after.values?.[0]) !== 0) {
        return {
          success: false,
          error: `continuous_scan_unverified: 关闭连续扫描后未回读确认，未发起扫描。${after.error ?? ''}`,
          data: { scan_props_written: true, continuous_scan_before: continuousBefore },
        }
      }
      // Compare every other field, including module parameter flags. The setter
      // has no separate API for continuous; never silently accept collateral changes.
      if (JSON.stringify(after.values?.slice(1)) !== JSON.stringify(body.slice(1))) {
        return {
          success: false,
          error: 'scan_props_changed: 关闭连续扫描后，其他扫描保存设置发生变化；未发起扫描，请检查模拟器设置。',
          data: { scan_props_written: true, continuous_scan_before: continuousBefore },
        }
      }
    }

    const direction = params['direction'] ?? 'down'
    const action = await ctx.safeCall('Scan_Action', 0, direction === 'up' ? 1 : 0)
    if (action.error) return { success: false, error: action.error }
    const verified = await verifyScan(ctx, true)
    return {
      ...verified,
      data: {
        ...verified.data,
        scan_direction: direction,
        scan_props_written: propsWritten,
        continuous_scan_before: continuousBefore,
        continuous_scan_after: 0,
      },
    }
  },
}

export const NATIVE_SKILLS: readonly Skill[] = [
  GetBias,
  GetCurrent,
  GetZPosition,
  NativeGetScanStatus,
  NativeSetBias,
  NativeStartScan,
  NativeStopScan,
]

function implemented(name: string): Skill {
  const skill = IMPLEMENTED[name]
  if (skill === undefined) throw new Error(`原生子技能 '${name}' 不在已实现的技能表里`)
  return skill
}

/**
 * 原生内核的子技能注册表（`ctx.runSkill` 查它）。**不是**模型可见的工具目录：模型仍只看到上面七个。
 * 只放 `NativeSetBias` 分流时要跑的三个，子步走完整内核（参数校验、安全闸、前置条件、记录）。
 *
 * - `SetBias` 必须是参考的那个，**不是** `NativeSetBias`，否则无限递归；
 * - `BiasSettleChange` 与 `SetBiasRamp` 没有按名导出，只在 `IMPLEMENTED` 里；
 * - 按名字用 Map 查，不用对象下标：下标会把 `constructor` 之类的原型成员当成技能。
 */
export const NATIVE_SUBSKILLS: ReadonlyMap<string, Skill> = new Map([
  ['BiasSettleChange', implemented('BiasSettleChange')],
  ['SetBias', SetBias],
  ['SetBiasRamp', implemented('SetBiasRamp')],
])

/** Successful tools must expose observations and units to the model, not just "ok". */
export function formatNativeToolText(
  record: Pick<MinimalResultRecord, 'kind' | 'skill' | 'data'> | undefined,
  fallback: unknown,
): unknown {
  if (record?.kind !== 'ok') return fallback
  const data = record.data
  const measurements: Readonly<Record<string, readonly [string, string]>> = {
    GetBias: ['bias_v', 'V'], GetCurrent: ['current_a', 'A'], GetZPosition: ['z_pos_m', 'm'], SetBias: ['bias_v', 'V'],
  }
  const measurement = measurements[record.skill]
  if (measurement) {
    const value = data?.[measurement[0]]
    if (typeof value === 'number' && Number.isFinite(value)) {
      // 直走路径的文案一字不变；走了安全路径就说明是哪条策略。
      const via = record.skill === 'SetBias' && data?.['path'] === 'BiasSettleChange' && typeof data['strategy'] === 'string'
        ? `, via BiasSettleChange ${data['strategy']}` : ''
      return `${record.skill}: ${value} ${measurement[1]}${record.skill === 'SetBias' ? ` (readback verified${via})` : ''}`
    }
  }
  if (['GetScanStatus', 'StartScan', 'StopScan'].includes(record.skill) && typeof data?.['scan_running'] === 'boolean') {
    return `${record.skill}: ${data['scan_running'] ? 'running' : 'stopped'}${data['verified'] === true ? ' (readback verified)' : ''}`
  }
  return fallback
}
