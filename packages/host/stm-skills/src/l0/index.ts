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
import { SafeRetract } from './safe-retract.js'
import { TryEngageController } from './engage.js'
import { SCAN_CHAIN } from './scan.js'
import { ConfigureScan } from './configure-scan.js'
import { StartScan } from './start-scan.js'
// L1：装在 GraphExecutor 上的组合技能（不在 l0/ 里，但同一张登记表）
import { WaitScanComplete } from '../composite/wait-scan-complete.js'
import { SetBiasRamp } from '../composite/set-bias-ramp.js'
import { AutoApproach } from '../composite/auto-approach.js'
import { ApproachTip } from '../composite/approach-tip.js'

export const IMPLEMENTED: Readonly<Record<string, Skill>> = {
  ...CORE_READS,
  ...HW_READS,
  GetZControllerState,
  ...SIMPLE_WRITES,
  ...VERIFIED_WRITES,
  ...GATED_WRITES,
  MoveToXY,
  SafeRetract,
  TryEngageController,
  ...SCAN_CHAIN,
  ConfigureScan,
  StartScan,
  WaitScanComplete,
  SetBiasRamp,
  AutoApproach,
  ApproachTip,
}

export * from './common.js'
export * from './reads-core.js'
export * from './reads-hw.js'
export * from './zctrl-state.js'
export * from './writes-simple.js'
export * from './writes-verified.js'
export * from './writes-gated.js'
export * from './move.js'
export * from './tip-park-read.js'
export * from './safe-retract.js'
export * from './engage.js'
export * from './scan.js'
export * from './configure-scan.js'
export * from './start-scan.js'
export * from './verify.js'
export * from '../composite/wait-scan-complete.js'
export * from '../composite/set-bias-ramp.js'
export * from '../composite/auto-approach.js'
export * from '../composite/approach-tip.js'
