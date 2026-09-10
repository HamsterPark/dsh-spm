/**
 * `GetZControllerState` —— 一次读全 Z 控制器的十一项。
 *
 * 它是批 1 里唯一一个「读一堆动词、**一条都不失败**」的技能：任何一路读不到，
 * 那个字段是 `null` 并且名字进 `_unreadable`，其余照给。
 *
 * 为什么不失败：这是模型进针前的**处境判断**。十一项里读到十项也足以决定
 * 下一步，而整条失败只会让模型什么都不知道。**但读不到必须显式说出来**——
 * 一个缺席的键会被当成「否」，而「没问出来」和「是 false」在进针这件事上
 * 是两个完全不同的处境。
 */
import {
  implausibleReadings,
  zctrlStatusName,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { bool, int, num } from './common.js'

/**
 * 实时控制器与 Z-Controller 模块**互相不同意**时的那句话，逐字。
 *
 * 以实时控制器为准是 Nanonis 手册的规矩（通信延迟期间两者会不一致），
 * 但**不能只报一个**：2026-08-10 的六种 `False` 就是这么被压成一种的。
 */
function disagreementNote(on: boolean, statusName: string): string {
  return (
    `⚠ 实时控制器说 ${on ? 'ON' : 'OFF'}，而 Z-Controller 模块显示 ${statusName}。` +
    `以实时控制器为准（Nanonis 手册：通信延迟期间两者会不一致）。`
  )
}

/** 模块状态与实时控制器一致吗。`On`/`On` 与 `Off`/`Off` 之外都算不一致。 */
function agrees(on: boolean, code: number): boolean {
  return on ? code === 2 : code !== 2
}

export const GetZControllerState: Skill = {
  spec: S.GetZControllerStateSpec,
  execute: async (ctx: SkillContext) => {
    const data: Record<string, unknown> = {}
    const unreadable: string[] = []

    /** 读一路。出错就记 `null` + 进 `_unreadable`，**永不中断**。 */
    const one = async (
      field: string,
      verb: string,
      map: (rec: SkillCallRecord) => unknown,
      ...args: unknown[]
    ): Promise<void> => {
      const rec = await ctx.safeCall(verb, ...args)
      if (rec.error !== undefined && rec.error !== '') {
        data[field] = null
        unreadable.push(field)
        return
      }
      data[field] = map(rec)
    }

    await one('controller_on', 'ZCtrl_OnOffGet', (r) => bool(r, 0))
    await one('module_status', 'ZCtrl_StatusGet', (r) => int(r, 0))
    await one('setpoint', 'ZCtrl_SetpntGet', (r) => num(r, 0))
    await one('gains', 'ZCtrl_GainGet', (r) => {
      const g = [num(r, 0), num(r, 1), num(r, 2)]
      return g.some((x) => x === null) ? null : g
    })
    await one('z_m', 'ZCtrl_ZPosGet', (r) => num(r, 0))
    await one('z_limits', 'ZCtrl_LimitsGet', (r) => {
      const v = [num(r, 0), num(r, 1)]
      return v.some((x) => x === null) ? null : v
    })
    await one('z_limits_enabled', 'ZCtrl_LimitsEnabledGet', (r) => bool(r, 0))
    await one('tip_lift', 'ZCtrl_TipLiftGet', (r) => num(r, 0))
    await one('withdraw_rate', 'ZCtrl_WithdrawRateGet', (r) => num(r, 0))
    await one('switch_off_delay', 'ZCtrl_SwitchOffDelayGet', (r) => num(r, 0))
    await one('home', 'ZCtrl_HomePropsGet', (r) => {
      const v = [int(r, 0), num(r, 1)]
      return v.some((x) => x === null) ? null : v
    })

    // ── 派生项：只在它依赖的那几路都读到时才出现 ──
    const status = data['module_status']
    if (typeof status === 'number') data['module_status_name'] = zctrlStatusName(status)

    const on = data['controller_on']
    if (typeof on === 'boolean' && typeof status === 'number' && !agrees(on, status)) {
      data['disagreement'] = disagreementNote(on, zctrlStatusName(status))
    }

    const gains = data['gains']
    if (Array.isArray(gains)) {
      // P 增益是**长度**（米）。量纲带上，物理合理性表才判得对。
      const units = { p_gain: 'm', time_constant_s: 's', i_gain: 'm/s' }
      data['gain_units'] = units
      data['gain_warnings'] = implausibleReadings({
        p_gain: [gains[0] as number, units.p_gain],
        i_gain: [gains[2] as number, units.i_gain],
      })
    }

    if (unreadable.length > 0) data['_unreadable'] = unreadable
    return { success: true, data }
  },
}

export { disagreementNote, agrees }
