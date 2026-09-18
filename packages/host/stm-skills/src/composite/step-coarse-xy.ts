/**
 * `StepCoarseXY` —— 把粗动台**挪几步**（可以只挪一步）。
 *
 * ## 它治的是什么（2026-08-28，现场给出的判据）
 *
 * > 树里连一个「只挪一步」的位移 skill 都没有 —— 这是功能缺口。
 *
 * 树里确实没有。原语 `MotorMove` 在自主路径上被硬闸挡着
 *（**「有防护的 `RelocateCoarseXY` 才是自主路径，裸马达命令才是要人的那个」**），
 * 而 `RelocateCoarseXY` 的落点复核要求新落点离已访问站点 ≥200 步 ——
 * 于是「挪 2 步」这种事**两边都过不去**。
 *
 * 那 200 步是**效率**约束（别重复用同一片表面），它自己的注释就这么写的；
 * 不是安全约束。所以修法不是拆闸，是给那条效率约束一个明说的出口，
 * 再给它一个**名字对得上**的入口。
 *
 * ## 这个技能做了什么
 *
 * 一层薄壳，转调 `RelocateCoarseXY(allow_revisit=true)`。**不重写任何东西** ——
 * 清障阶梯、真空互锁、驱动电压读回、降偏压、电流归零证明、里程表记录、重新进针，
 * 全部还是那一份实现在跑。
 *
 * ⚠ 之所以单独存在而不是让人去传 `RelocateCoarseXY(allow_revisit=true)`：
 * 技能按「治什么病」命名（**换区**），而人按「要什么结果」找（**挪两步**）。
 * 同一天刚在别处栽过一次：用户要「把碘卸到金上」，树里叫 `ForgeAuTip`，
 * 没找到，手工做了一夜。
 *
 * ## 什么时候**不要**用它
 *
 * 常规换区用 `RelocateCoarseXY` —— 重复用同一片表面是真的浪费，
 * 那条 200 步的规则存在是有道理的。这个技能是给标定步长、微调位置用的。
 *
 * ⚠️ **本仓现状**：粗动大地图没移植，所以那条 200 步的效率约束**此刻并不存在**
 *（见 `relocate-coarse-xy.ts` 的 `#checkDestination` 与 deviation）。
 * 也就是说 `allow_revisit` 这一趟**跳过的是一条空的约束**。
 * 这个技能仍然成立，而且仍然该落：它的另外两件事（一个名字对得上的入口、
 * 一条 ≤60 步的**用途**上限）与地图无关，而地图接上来的那天它一个字都不用改。
 */
import type { Skill, SkillResultLike } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { runSubSkill } from './run-sub.js'

/**
 * 超过这个步数就不该走这条路了 —— 那是换区，用 `RelocateCoarseXY`。
 *
 * **不是安全上限**（真正的上限在 `RelocateCoarseXY` 的单轴行程预算），
 * 是**用途上限**：让「挪一下」和「换个地方」在调用点就分得开。
 */
export const NUDGE_MAX_STEPS = 60

export const StepCoarseXY: Skill = {
  spec: S.StepCoarseXYSpec,
  execute: async (ctx, params): Promise<SkillResultLike> => {
    const steps = Math.trunc(Number(params['steps'] ?? 1)) || 1
    if (steps > NUDGE_MAX_STEPS) {
      return {
        success: false,
        error:
          `${steps} 步不是「挪一下」，那是换区 —— 用 RelocateCoarseXY。` +
          '这条路明说地跳过了「别重复访问」的效率约束，' +
          '拿它做大距离移动会把那条规则整个架空。',
      }
    }

    const inner: Record<string, unknown> = {
      axis: params['axis'],
      direction: params['direction'],
      steps,
      allow_revisit: true,
      reapproach: params['reapproach'] !== false,
      dry_run: params['dry_run'] === true,
    }
    if (params['prewithdraw_steps'] !== undefined && params['prewithdraw_steps'] !== null) {
      inner['prewithdraw_steps'] = Math.trunc(Number(params['prewithdraw_steps']))
    }

    const res = await runSubSkill(ctx, 'RelocateCoarseXY', inner)
    const data: Record<string, unknown> = { ...(res.data ?? {}) }
    data['delegated_to'] = 'RelocateCoarseXY'
    data['allow_revisit'] = true
    data['requested_steps'] = steps
    return res.success
      ? { success: true, data }
      : { success: false, error: res.error ?? '', data }
  },
}
