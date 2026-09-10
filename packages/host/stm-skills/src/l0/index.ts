/**
 * 已移植的技能，按名字索引。
 *
 * **它就是进度表**：`traces.test.ts` 拿它的键去金样里取轨迹，
 * 少写一个技能只是少一组测试，写错一个技能会当场变红。
 */
import type { Skill } from 'dsh-spm-kernel'
import { CORE_READS } from './reads-core.js'
import { HW_READS } from './reads-hw.js'
import { GetZControllerState } from './zctrl-state.js'
import { SIMPLE_WRITES } from './writes-simple.js'
import { VERIFIED_WRITES } from './writes-verified.js'
import { GATED_WRITES } from './writes-gated.js'
import { MoveToXY } from './move.js'

export const IMPLEMENTED: Readonly<Record<string, Skill>> = {
  ...CORE_READS,
  ...HW_READS,
  GetZControllerState,
  ...SIMPLE_WRITES,
  ...VERIFIED_WRITES,
  ...GATED_WRITES,
  MoveToXY,
}

export * from './common.js'
export * from './reads-core.js'
export * from './reads-hw.js'
export * from './zctrl-state.js'
export * from './writes-simple.js'
export * from './writes-verified.js'
export * from './writes-gated.js'
export * from './move.js'
export * from './verify.js'
