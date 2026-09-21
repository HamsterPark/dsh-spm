/**
 * The native simulator profile deliberately exposes only these seven skills.
 * Read skills keep their existing contracts. Writes add live verification here,
 * without changing the migrated skills or claiming new MAST golden evidence.
 */
import {
  SET_NO_CHANGE,
  SET_OFF,
  scalarFloat,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  GetBias,
  GetCurrent,
  GetZPosition,
  SetBias,
  StartScan,
  StopScan,
} from 'dsh-spm-stm-skills'
import type { MinimalResultRecord } from './minimal-persistence.js'

const SCAN_VERIFY_ATTEMPTS = 11
const SCAN_VERIFY_INTERVAL_MS = 100

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
    description: "立即设置模拟器偏压，并回读确认。bias_v 支持伏特数值或带 SI 前缀的字符串，例如 0.1 或 '100m'，不要附加单位 V。本工具不提供渐变 ramp。",
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
    const written = await SetBias.execute(ctx, params)
    if (!written.success) return written
    const readback = await GetBias.execute(ctx, {})
    if (!readback.success) {
      return {
        success: false,
        error: `bias_readback_failed: 偏压命令已下发，但回读失败；当前偏压未确认。${readback.error ?? ''}`,
        data: { requested_bias_v: target, bias_v: null, verified: false, command_sent: true },
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
    }
    return verified ? { success: true, data } : {
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
      return `${record.skill}: ${value} ${measurement[1]}${record.skill === 'SetBias' ? ' (readback verified)' : ''}`
    }
  }
  if (['GetScanStatus', 'StartScan', 'StopScan'].includes(record.skill) && typeof data?.['scan_running'] === 'boolean') {
    return `${record.skill}: ${data['scan_running'] ? 'running' : 'stopped'}${data['verified'] === true ? ' (readback verified)' : ''}`
  }
  return fallback
}
