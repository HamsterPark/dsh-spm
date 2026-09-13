/**
 * Nanonis 脚本模块 —— 实时时序器，以及本仓每一道闸上的**那一个洞**。
 *
 * 脚本编译后**部署到 RT 控制器上**，以硬件计时运行，一次 TCP 往返都不发。它是所有
 * 需要微秒级确定性的事情的唯一做法：脉冲串、与锁相同步的偏压扫描、针尖成形配方、
 * **泵浦-探测延时扫描**。它的参数通道是 **LUT**（查找表）：一个脚本以 RT 速度逐项
 * 走过的浮点数组，而 `Script_LUTLoad` **直接从 TCP 收这个数组** ——
 * 于是 LUT 是智能体在这里真正能撰写的那一样东西。
 *
 * ## 风险，精确地说
 *
 * 不是「LLM 可能上传任意固件」——它做不到：`Script_Load` 收的是**Nanonis 机器上的
 * 文件路径**，不是源码。真正的问题是结构性的，而且更糟：
 *
 * > **一个跑起来的脚本，对本仓每一道安全层都是不可见、也碰不到的。**
 *
 * 安全闸、运行模式闸、中止闸、HITL 都坐在 `safeCall` 那条路上；脚本一次
 * `safeCall` 都不发。所以在一个正在跑的脚本内部：全局边界不生效，**中止闸停不了它**
 * （按下中止只是让本仓不再发命令，脚本照旧在驱动针尖），能停它的只有 `Script_Stop`。
 *
 * 四件事因此都是承重的：
 *
 * 1. **`Script_Stop` 在中止后的放行清单里**——否则中止会做与它的职责相反的事；
 * 2. **每一次 Run 都留痕**（`ctx.markers`）：本仓看不见脚本内部，
 *    **那条记录是事后唯一能拿到的东西**；
 * 3. **技能自己在描述里说清楚**：一个以为安全闸在脚本里保护着它的智能体，
 *    比一个知道它们不保护的更危险；
 * 4. **操作员维护的已审槽位白名单**，默认空 ⇒ 智能体一个脚本都跑不了。
 *    这是「有人审过了」唯一诚实的形态。
 *
 * ## 为什么 `Script_Load` 在旧仓里曾经不是技能（而现在是，带一道反的闸）
 *
 * 这里**没有物理层**。脚本能把偏压、Z、粗动马达开到硬件允许的任何地方，而本仓什么
 * 都看不见。白名单**就是**那道屏障——于是 `Script_Load(slot, file)` 会让智能体把
 * 另一个文件放进一个已审槽位，那一刻「槽位 1 已批准」就什么也不表示了。
 * 见 `script-files.ts`：那道闸是**反的**。
 */
import {
  SCRIPT_ALLOWLIST_FILE,
  gateScriptSlot,
  lutOutOfRange,
  parseScriptAllowlist,
  pyFloatRepr,
  scriptRefusal,
  vettedSlots,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
  type VettedSlot,
} from 'dsh-spm-kernel'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as S from '../generated/specs.js'
import { body, fail, formatG6, ok } from './common.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''
const int = (p: Readonly<Record<string, unknown>>, k: string, dflt = 0): number =>
  typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt

/** 白名单文件在哪。**宿主可以换掉这一处**（测试、以及将来的配置目录）。 */
export const scriptAllowlistPath = { current: (): string => join(process.cwd(), 'config', SCRIPT_ALLOWLIST_FILE) }

/**
 * 读白名单。**fail-closed**：文件不存在、读不动、格式坏了，三件事都归成空清单。
 *
 * 对这份文件没有任何一种读法能把闸打开 ——「审核状态未知」不是「通过」。
 */
export function loadAllowlist(): Map<number, VettedSlot> {
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(scriptAllowlistPath.current(), 'utf8'))
  } catch {
    return new Map()
  }
  return parseScriptAllowlist(raw)
}

/** 一次被拒的门禁，**连同留痕**。本仓看不见脚本内部，所以拒绝也要留得下。 */
function refuse(ctx: SkillContext, skill: string, slot: number, reason: string): SkillResultLike {
  const allow = loadAllowlist()
  ctx.markers.emit('safety_block', {
    subject: `NanonisScript[slot ${slot}]`,
    reason,
    skill,
    allowed_slots: vettedSlots(allow),
  })
  return fail(scriptRefusal(reason, allow))
}

/** 过审了吗。过了给条目，没过给**已经留过痕**的那次拒绝。 */
function gate(
  ctx: SkillContext,
  skill: string,
  slot: number,
): { entry: VettedSlot | null; refusal: SkillResultLike | null } {
  const { entry, refusal } = gateScriptSlot(slot, loadAllowlist())
  if (entry === null) {
    const allow = loadAllowlist()
    ctx.markers.emit('safety_block', {
      subject: `NanonisScript[slot ${slot}]`,
      reason: refusal,
      skill,
      allowed_slots: vettedSlots(allow),
    })
    return { entry: null, refusal: fail(refusal) }
  }
  return { entry, refusal: null }
}

// ── 只读 ───────────────────────────────────────────────────────────────────

/**
 * 我能跑哪些脚本槽位、每一个做什么。
 *
 * **一次硬件调用都不发**：它读的是那份人签过字的文件，不是仪器。
 */
export const ListNanonisScripts: Skill = {
  spec: S.ListNanonisScriptsSpec,
  execute: (): Promise<SkillResultLike> => {
    const allow = loadAllowlist()
    const slots = vettedSlots(allow).map((s) => {
      const e = allow.get(s) as VettedSlot
      return {
        slot: e.slot,
        name: e.name,
        description: e.description,
        allow_lut_write: e.allowLutWrite,
        lut_min: e.lutMin,
        lut_max: e.lutMax,
        notes: e.notes,
      }
    })
    return Promise.resolve(
      ok({
        vetted_slots: slots,
        count: slots.length,
        allowlist_file: scriptAllowlistPath.current(),
        note:
          slots.length === 0
            ? `没有已审核的槽位——智能体不能运行任何脚本。请用户在${SCRIPT_ALLOWLIST_FILE} 里审核并登记。`
            : '只有上列槽位可运行；其余一律拒绝。',
      }),
    )
  },
}

export const GetScriptData: Skill = {
  spec: S.GetScriptDataSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const buf = int(params, 'buffer')
    const sweep = int(params, 'sweep')
    const rec = await ctx.safeCall('Script_DataGet', buf, sweep)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ buffer: buf, sweep, data: [...body(rec)] })
  },
}

export const GetScriptChannels: Skill = {
  spec: S.GetScriptChannelsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const buf = int(params, 'buffer')
    const rec = await ctx.safeCall('Script_ChsGet', buf)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ buffer: buf, channels: [...body(rec)] })
  },
}

// ── 要紧的那个 ─────────────────────────────────────────────────────────────

export const RunNanonisScript: Skill = {
  spec: S.RunNanonisScriptSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const slot = int(params, 'slot')
    const wait = params['wait_until_finished'] !== false ? 1 : 0

    const { entry, refusal } = gate(ctx, 'RunNanonisScript', slot)
    if (refusal !== null) return refusal

    const rec = await ctx.safeCall('Script_Run', slot, wait)
    if (failed(rec)) return fail(rec.error ?? '')

    // **本仓看不见脚本内部。** 这一条是事后唯一能拿到的「跑了什么」：
    // 哪个槽位、哪份配方、阻塞与否，以及（由 `LoadScriptLUT` 留下的）用的哪串数。
    // 丢了它，就等于丢掉了事后解释这次运行的能力。
    ctx.markers.emit('note', {
      subject: `NanonisScript[slot ${slot}]`,
      reason:
        `在 RT 控制器上运行脚本「${entry?.name ?? '?'}」` +
        `（${wait !== 0 ? '阻塞至完成' : '后台运行——需自行 Stop'}）。` +
        'MAST 的安全门/模式门/中止门在脚本内部均不生效。',
      slot,
      script_name: entry?.name ?? '',
      description: entry?.description ?? '',
      wait_until_finished: wait !== 0,
    })

    return ok({
      slot,
      script_name: entry?.name ?? '',
      wait_until_finished: wait !== 0,
      warning:
        '脚本在 RT 控制器上运行——MAST 的安全门与中止门对它不生效。' +
        '要停它只能用 StopNanonisScript。',
    })
  },
}

/**
 * 停掉正在跑的脚本。**从不受闸门管辖，包括中止已经锁住的时候。**
 *
 * 它是**唯一**能停下一个正在跑的脚本的东西——中止闸停不了它，因为脚本根本不发
 * TCP 调用。一道拦得住它的闸，会让中止做与它职责相反的事。
 */
export const StopNanonisScript: Skill = {
  spec: S.StopNanonisScriptSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    const rec = await ctx.safeCall('Script_Stop')
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ stopped: true })
  },
}

export const DeployNanonisScript: Skill = {
  spec: S.DeployNanonisScriptSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const slot = int(params, 'slot')
    const { refusal } = gate(ctx, 'DeployNanonisScript', slot)
    if (refusal !== null) return refusal
    // `Script_Open` 的错**不看** —— 它是幂等的开模块，失败不代表部署不了。
    await ctx.safeCall('Script_Open')
    const rec = await ctx.safeCall('Script_Deploy', slot)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ slot, deployed: true })
  },
}

/** 撤下一个脚本**从来不是有风险的那个方向**，所以它不受白名单管辖。 */
export const UndeployNanonisScript: Skill = {
  spec: S.UndeployNanonisScriptSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const slot = int(params, 'slot')
    const rec = await ctx.safeCall('Script_Undeploy', slot)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ slot, deployed: false })
  },
}

// ── LUT：智能体真正能撰写的那一样 ──────────────────────────────────────────

/**
 * 只认**十进制**的一个数，与 `readback.ts` 的 `toFloat` 同一套。
 *
 * 裸 `Number()` 在这里太松：`Number('0x10')` 给 **16**，而 Python 的
 * `float('0x10')` 抛 `ValueError`。松的那一侧不是「多认一种写法」——
 * 是一个十六进制写法的 LUT 值被当成十进制的那个数收下，然后由脚本以 RT 速度
 * 逐项走过去，而本仓看不见脚本在拿它做什么。
 *
 * 反方向（`'inf'` / `'1_0'` Python 认、我们不认）见 D-SI-1 / D-SI-2：
 * 那两条是本仓**有意更严**，同一条理由。
 */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** `'0, 2.5, 5'` → `[0, 2.5, 5]`。**有一个记号不是数就整串作废**（给 `null`）。 */
export function lutValues(raw: unknown): number[] | null {
  const toks = String(raw ?? '').replaceAll(',', ' ').split(/\s+/).filter((t) => t !== '')
  const out: number[] = []
  for (const t of toks) {
    if (!DECIMAL.test(t)) return null
    const v = Number(t)
    if (!Number.isFinite(v)) return null
    out.push(v)
  }
  return out
}

export const LoadScriptLUT: Skill = {
  spec: S.LoadScriptLUTSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const slot = int(params, 'slot')
    const lut = int(params, 'lut_index')

    const { entry, refusal } = gate(ctx, 'LoadScriptLUT', slot)
    if (refusal !== null) return refusal
    const vetted = entry as VettedSlot
    // 「槽位没过审」与「过审了但没批准写 LUT」是**两句话** —— 说错一句，
    // 调用方会去改错的那份东西。
    if (!vetted.allowLutWrite) {
      return refuse(
        ctx,
        'LoadScriptLUT',
        slot,
        `拒绝：槽位 ${slot}（${vetted.name}）未被批准接受智能体写入 LUT（allow_lut_write=false）。`,
      )
    }

    const vals = lutValues(params['values'])
    if (vals === null) {
      return fail(`values 解析失败：'${String(params['values'] ?? '')}'（应为逗号分隔的数值）`)
    }
    if (vals.length === 0) return fail('values 为空')

    const bad = lutOutOfRange(vals, vetted)
    if (bad.length > 0) {
      const lo = vetted.lutMin ?? -Infinity
      const hi = vetted.lutMax ?? Infinity
      return refuse(
        ctx,
        'LoadScriptLUT',
        slot,
        `拒绝：LUT 值 [${bad.map(pyFloatRepr).join(', ')}] 超出槽位 ${slot} 声明的范围 ` +
          `[${formatG6(lo)}, ${formatG6(hi)}]（该范围由用户在审核脚本时写定——` +
          '它知道脚本把这些数当什么单位用，MAST 不知道）。',
      )
    }

    // `Script_LUTOpen` 的错**不看**（同 `Script_Open`）。
    await ctx.safeCall('Script_LUTOpen')
    // LUTLoad(LUT_index, file_path, LUT_values)：空路径 = 「用我发过去的这个数组」——
    // 那个数组就是这件事的全部意义。
    const rec = await ctx.safeCall('Script_LUTLoad', lut, '', vals)
    if (failed(rec)) return fail(rec.error ?? '')

    const min = Math.min(...vals)
    const max = Math.max(...vals)
    ctx.markers.emit('note', {
      subject: `NanonisScript[slot ${slot}].LUT${lut}`,
      reason:
        `写入 ${vals.length} 个 LUT 值（范围 ${formatG6(min)}..${formatG6(max)}）` +
        `，供脚本「${vetted.name}」使用`,
      slot,
      lut_index: lut,
      n_values: vals.length,
      min,
      max,
      values: vals.slice(0, 20),
    })

    return ok({
      slot,
      lut_index: lut,
      n_values: vals.length,
      min,
      max,
      note: '需 DeployScriptLUT 才会推送到 RT 控制器。',
    })
  },
}

export const DeployScriptLUT: Skill = {
  spec: S.DeployScriptLUTSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const lut = int(params, 'lut_index')
    const wait = params['wait_until_finished'] !== false ? 1 : 0
    const timeout = typeof params['timeout_ms'] === 'number' && params['timeout_ms'] !== 0
      ? Math.trunc(params['timeout_ms'])
      : 10000
    const rec = await ctx.safeCall('Script_LUTDeploy', lut, wait, timeout)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ lut_index: lut, deployed: true })
  },
}

// ── 采集配置 ───────────────────────────────────────────────────────────────

/** `'0,24'` → `[0, 24]`。严格：有一个不是整数就整串作废（同 `logChannels`）。 */
export function scriptChannels(raw: unknown): number[] | null {
  const toks = String(raw ?? '').replaceAll(',', ' ').split(/\s+/).filter((t) => t !== '')
  const out: number[] = []
  for (const t of toks) {
    if (!/^[+-]?\d+$/.test(t)) return null
    out.push(Number(t))
  }
  return out
}

export const SetScriptChannels: Skill = {
  spec: S.SetScriptChannelsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const buf = int(params, 'buffer')
    const chs = scriptChannels(params['channels'])
    if (chs === null) return fail(`channels 解析失败：'${String(params['channels'] ?? '')}'`)
    if (chs.length === 0) return fail('channels 为空')
    const rec = await ctx.safeCall('Script_ChsSet', buf, chs)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ buffer: buf, channels: chs })
  },
}

export const SetScriptAutosave: Skill = {
  spec: S.SetScriptAutosaveSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const buf = int(params, 'buffer')
    const sweep = params['sweep'] === undefined || params['sweep'] === null
      ? -1
      : int(params, 'sweep', -1)
    const same = params['all_sweeps_same_file'] !== false ? 1 : 0
    const folder = typeof params['folder_path'] === 'string' ? params['folder_path'] : ''
    const base = typeof params['basename'] === 'string' && params['basename'] !== ''
      ? params['basename']
      : 'mast_script'
    const rec = await ctx.safeCall('Script_Autosave', buf, sweep, same, folder, base)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ buffer: buf, sweep, basename: base })
  },
}

export const NANONIS_SCRIPT: Readonly<Record<string, Skill>> = {
  ListNanonisScripts,
  GetScriptData,
  GetScriptChannels,
  RunNanonisScript,
  StopNanonisScript,
  DeployNanonisScript,
  UndeployNanonisScript,
  LoadScriptLUT,
  DeployScriptLUT,
  SetScriptChannels,
  SetScriptAutosave,
}
