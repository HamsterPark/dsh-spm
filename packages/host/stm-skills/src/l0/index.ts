/**
 * 已移植的技能，按名字索引。
 *
 * **它就是进度表**：`traces.test.ts` 拿它的键去金样里取轨迹，
 * 少写一个技能只是少一组测试，写错一个技能会当场变红。
 */
import type { Skill } from 'dsh-spm-kernel'
import { CORE_READS } from './reads-core.js'

export const IMPLEMENTED: Readonly<Record<string, Skill>> = {
  ...CORE_READS,
}

export * from './common.js'
export * from './reads-core.js'
