/**
 * 谱学整族（38 个）—— STS（Bias Spectroscopy）与 Z 谱学。
 *
 * 这一族是整条谱学链的地基：`GridSTS` / `DemoScanAndSTS` / `MeasureBarrierHeight` /
 * `SpectroscopyAtPositions` 全都卡在它上面。判定件在内核
 * （`kernel/src/spectroscopy.ts`：行列、解不开的理由、扫掠时长），这里只负责
 * **去问仪器**、**按判定件说的组装**。
 *
 * ## 三件要害
 *
 * ### ① 一张转置的谱在数值上仍然是一串合法的浮点
 *
 * 2D Data 的布局是**行=通道、列=扫描点**。老代码按行=点/列=通道读（转置），真机上
 * 返回的是混在一起的谱（2026-07-03）。这件事的可怕之处在于它**不报错**：每个数都是
 * 真的，只是不属于它被贴上的那个通道名。所以判定件的测试用**逐格互不相同**的数据
 * 把行列钉死 —— 全 0.25 的一格里转置与不转置一模一样。
 *
 * ### ② `reason` 与 `spectrum_parsed` **总是**落键
 *
 * 解不开时把「为什么」一起交出去（内核那边 ②）。而 `spectrum_parsed` **两条路上都
 * 写**：一个只在失败时出现的标志，会让按它分支的调用方在成功路径上读到
 * `KeyError`——那是把一个诚实标志变成一颗新的雷。
 *
 * ### ③ 两个采集技能对「解不开」给出**相反**的结论，而不一样是有依据的
 *
 * | | 解不开时 | 为什么 |
 * |---|---|---|
 * | `AcquireSTS` | 盘上**也**没有才算失败 | `ConfigureSTS` 开了 autosave ⇒ 每次采集都有一份 `.dat` 落盘。内联块解不开时数据**可能仍然在盘上**，那时报失败会把 agent 推去重扫同一个点——多一次针尖停留、多一次针尖变化的机会，而好数据本来就在 |
 * | `AcquireZSpectr` | 一律失败 | 它不调 `_attach_saved_dat`，`ZSpectr_Start(1, "")` 也不给 basename——**内联这一份就是唯一的一份** |
 *
 * 两个都照移，**别对齐**。（2026-08-15 普查 A3）
 *
 * ## 通道串的两个解析器**刻意不同**（D-CHANNELS-1 同形）
 *
 * `ConfigureSTSChannels` 用手写的 `split(',')` + `int(x)`；`SetSTSChannels` /
 * `SetZSpectrChannels` / `SetSTSMLSVals` 用 `_coerce_int_list`（`;` 也算分隔符，
 * 而且走 `int(float(x))`，于是 `'2.5'` 被截成 2）。合并它们会**默默改掉**一串
 * 已经在用的通道号写法。
 *
 * ⚠️ 与 `docs/handoff/survey-remaining.md` 的说法不同：`_coerce_int_list`
 * **也会**在垃圾输入上抛（`float('spec-export')` 是 ValueError）。两者真正的差别是
 * 「认不认 `;`」与「认不认小数写法」，不是「抛不抛」。本仓两侧都**不抛**，
 * 一律给一条说得清的拒绝（同 D-SKILL-3）。
 */
import {
  DEFAULT_SAFETY_LIMITS,
  SWEEP_BUDGET_FACTOR,
  SWEEP_BUDGET_PAD_S,
  channelIdsFromBuffer,
  matchSpectrumChannel,
  pyRound,
  reshapeSpectrum,
  scalarFloat,
  sweepDuration,
  type SafetyLimits,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
  type SkillSpec,
  type SweepProps,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'
import { existingDirs, findLatestSaved, sessionDir } from './frames.js'
import { lastString } from './reads-hw.js'

type Params = Readonly<Record<string, unknown>>

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/** body 的第 i 位当成数；取不出给 `null`。 */
const at = (rec: SkillCallRecord, i: number): number | null => scalarFloat(body(rec)[i])

/** Python 的 `float(variables[i])` —— 旧仓在这些格子上用 0.0 兜底，照移。 */
const f = (rec: SkillCallRecord, i: number): number => at(rec, i) ?? 0.0
/** 同上，整数。 */
const i32 = (rec: SkillCallRecord, i: number): number => Math.trunc(at(rec, i) ?? 0)

/** body 至少有 n 位**能当数用**的元素吗（旧仓那道 `len(variables) >= n`）。 */
const hasAtLeast = (rec: SkillCallRecord, n: number): boolean => body(rec).length >= n

// ── 两个通道串解析器 ────────────────────────────────────────────────────────

/**
 * `_coerce_int_list` —— `SetSTSChannels` / `SetZSpectrChannels` / MLS 那两串用。
 *
 * `;` 与 `,` 同义；每一项走 `int(float(x))`，于是 `'2.5'` 截成 `2`。
 * 解不出给 `null`（旧仓抛 ValueError，见抬头；D-SKILL-3 同一条）。
 */
export function coerceIntList(value: unknown): number[] | null {
  const floats = coerceFloatList(value)
  if (floats === null) return null
  return floats.map((x) => Math.trunc(x))
}

/** `_coerce_float_list`。同上。 */
export function coerceFloatList(value: unknown): number[] | null {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') {
    const out: number[] = []
    for (const piece of value.replace(/;/g, ',').split(',')) {
      const s = piece.trim()
      if (s === '') continue
      const n = pyFloatLiteral(s)
      if (n === null) return null
      out.push(n)
    }
    return out
  }
  if (Array.isArray(value)) {
    const out: number[] = []
    for (const x of value) {
      const n = typeof x === 'number' && Number.isFinite(x) ? x : pyFloatLiteral(String(x))
      if (n === null) return null
      out.push(n)
    }
    return out
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [value]
  return null
}

/**
 * Python 的 `float(s)` —— **十进制字面量**，与 `readback.ts` 的 `toFloat` 同一条正则。
 *
 * 裸 `Number()` 会认 `'0x10'`（给 16）与 `'Infinity'`，而 Python 抛。批 3f 的 LUT
 * 那一处撞过：一个十六进制写法的值被当成十进制那个数收下，然后由硬件走过去。
 */
function pyFloatLiteral(s: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * `ConfigureSTSChannels` 那一份 —— **只认逗号，只认整数字面量**。
 *
 * 与上面那个刻意不同，见抬头。名字里带 `strict` 是为了让下一个人在合并它们之前
 * 先看见这两个字。
 */
export function strictIntList(value: unknown): number[] | null {
  if (typeof value !== 'string') return null
  const out: number[] = []
  for (const piece of value.split(',')) {
    const s = piece.trim()
    if (s === '') continue
    if (!/^[+-]?\d+$/.test(s)) return null
    out.push(Number(s))
  }
  return out
}

const CHANNEL_REFUSAL = (raw: unknown): string =>
  `通道索引解析不了：${JSON.stringify(raw)} —— 要逗号分隔的整数，例如 '0, 1, 2'。` +
  `这里不猜：猜错一个通道号，录下来的是另一条信号，而曲线看起来完全正常。`

// ── 单动词直通的那一批 ──────────────────────────────────────────────────────

/** `执行 → 有 error 就原样透传 → 否则把 body 映成 data` 的工厂。 */
function verbSkill(
  spec: SkillSpec,
  verb: string,
  args: (p: Params) => unknown[],
  map: (rec: SkillCallRecord, p: Params) => Record<string, unknown>,
): Skill {
  return {
    spec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const rec = await ctx.safeCall(verb, ...args(params))
      if (failed(rec)) return fail(rec.error ?? '')
      return ok(map(rec, params))
    },
  }
}

/** 参数原样回显的 setter（旧仓这一族全是「写下去 → 把入参报回来」）。 */
const echo =
  (...keys: string[]) =>
  (_rec: SkillCallRecord, p: Params): Record<string, unknown> =>
    Object.fromEntries(keys.map((k) => [k, p[k]]))

/** Python 的 `int(x)`：布尔 → 0/1，数 → 截断。 */
const pyInt = (v: unknown): number =>
  typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? Math.trunc(v) : 0

const DIGSYNC_LABELS: Readonly<Record<number, string>> = {
  0: 'Off',
  1: 'TTL Sync',
  2: 'Pulse Sequence',
}
const SECOND_COND_LABELS: Readonly<Record<number, string>> = {
  0: '-No-',
  1: 'OR',
  2: 'AND',
  3: 'THEN',
}

// ── 采集：两个带判定的 ─────────────────────────────────────────────────────

export interface SpectroscopyDeps {
  /**
   * **生效的**安全限值（配置 + 管理员覆写）。没接 ⇒ 出厂默认（D-LIMITS-1）。
   *
   * 只有 `SetSTSMLSVals` 用它：那七串是 `str` 类型的参数，于是内核 K6 的数值
   * 包络检查**整个绕过去了**——一个幻觉出来的段起点可以就这样到达隧道结。
   *
   * 旧仓在这个调用点上走 `_get_effective_limits`，而它的收紧层
   * （`_INSTRUMENT_CLAMPS`）里**只有 setpoint 一条，偏压不在里面** ⇒ 对这里是
   * 一个可证明的 no-op，退化成「默认 ±10 V 或管理员覆写」。
   */
  readonly effectiveLimits?: () => SafetyLimits
  /**
   * 找刚落盘的那个 `.dat`（`AcquireSTS` 判 success 的第二处证据）。
   *
   * 缺省走 `GetLatestScanFile` 的同一条路：**问仪器**要 session 目录
   * （`Util_SessionPathGet`），只搜真目录，只认最近 120 s 的。
   * 候选目录只有这一个来源 —— 旧仓另外三路依赖本仓还没有的东西，见 D-FRAME-1。
   */
  readonly latestSavedDat?: (ctx: SkillContext) => Promise<string | null>
  /** 墙钟（秒）。与 `frames.ts` 同一条理由：测试要能钉住「多旧算旧」。 */
  readonly nowS?: () => number
}

/** Nanonis 自动保存的 `.dat` 最多算多新。旧仓写死 120 s，照移。 */
const SAVED_DAT_MAX_AGE_S = 120

/**
 * `_attach_saved_dat` —— **尽力而为，绝不猜**。
 *
 * `ConfigureSTS` 打开 autosave ⇒ 每次采集都真的在盘上落一份 `.dat`，而旧仓那版
 * 从来不报它落在哪（2026-07-27 #35/#36）：`data` 里没有 `path`，工具适配器只从
 * `path`/`file_path`/`sxm_path` 里收割 `scan_paths`，于是交给数据处理那一棒手上
 * **没有一个真文件可指**，只能给它一份工具返回的溢出转储 —— 而 `load_scan` 当场炸。
 *
 * 目录与序号由 Nanonis 自己挑，所以唯一能给这个文件命名的办法就是扫掠一结束
 * 立刻去找最新的那个 `.dat`。找不到就**没有 `path`**，绝不编一个：
 * 一条错的路径会把分析 agent 指到别人的数据上。
 */
function defaultLatestSavedDat(nowS: () => number) {
  return async (ctx: SkillContext): Promise<string | null> => {
    const rec = await ctx.safeCall('Util_SessionPathGet')
    if (failed(rec)) return null
    const dir = sessionDir(lastString(rec))
    if (dir === null) return null
    const found = findLatestSaved(existingDirs([dir]), '.dat', nowS(), SAVED_DAT_MAX_AGE_S)
    return found === null ? null : found.path
  }
}

/** 读两次仪器设定，算出这条扫掠要跑多久。**两次读 ≈ 50 ms，换的是对任何配置都成立**。 */
async function readSweepBudget(ctx: SkillContext): Promise<{
  coreS: number
  detail: Readonly<Record<string, unknown>>
}> {
  const props = await ctx.safeCall('BiasSpectr_PropsGet')
  // BiasSpectr.PropsGet body = [Save all, Number of sweeps, Backward sweep,
  //                             Number of points, …]
  let sweep: SweepProps = { numPoints: null, numSweeps: null, backward: true }
  if (hasAtLeast(props, 4)) {
    const nsw = at(props, 1)
    const bwd = at(props, 2)
    const npts = at(props, 3)
    sweep =
      nsw === null || bwd === null || npts === null
        ? { numPoints: null, numSweeps: null, backward: true }
        : {
            numPoints: Math.max(Math.trunc(npts), 1),
            numSweeps: Math.max(Math.trunc(nsw), 1),
            backward: Math.trunc(bwd) !== 0,
          }
  }

  const timing = await ctx.safeCall('BiasSpectr_TimingGet')
  const keys = [
    'z_averaging_time_s',
    'z_offset_m',
    'initial_settling_time_s',
    'max_slew_rate_v_per_s',
    'settling_time_s',
    'integration_time_s',
    'end_settling_time_s',
    'z_control_time_s',
  ]
  const t: Record<string, number> = {}
  const tb = body(timing)
  for (let k = 0; k < keys.length && k < tb.length; k += 1) {
    const v = scalarFloat(tb[k])
    if (v !== null) t[keys[k] as string] = v
  }
  return sweepDuration(sweep, t)
}

/** 谱 → `data` 的那几个键。两个采集技能共用（别名按**名字**认，不按列号）。 */
function spectrumFields(
  channels: Readonly<Record<string, number[]>>,
  numPoints: number,
  aliases: readonly (readonly [string, readonly string[]])[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    channel_names: Object.keys(channels),
    num_points: numPoints,
    ...channels,
  }
  for (const [key, needles] of aliases) {
    const trace = matchSpectrumChannel(channels, needles)
    if (trace !== null) out[key] = trace
  }
  return out
}

export function makeAcquireSTS(deps: SpectroscopyDeps = {}): Skill {
  const latestSavedDat =
    deps.latestSavedDat ?? defaultLatestSavedDat(deps.nowS ?? ((): number => Date.now() / 1000))
  return {
    spec: S.AcquireSTSSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      await ctx.safeCall('BiasSpectr_Open')

      // ⚠️ **刻意不发 `BiasSpectr_PropsSet`。** 它的 Z-offset 实参没有「不改」的
      // 哨兵值，而 `BiasSpectr_PropsGet` 根本不回这一项 —— 于是老代码里那句写死的
      // `PropsSet(1,0,0,0,0.0,1,2)` 每次采集都**把操作员配好的保护性 Z 回撤悄悄
      // 清零**（2026-07-03）。保存/自动保存/Z 偏移走 `ConfigureSTS`；采集只起扫，
      // 而 `Get data=1` 无论如何都会把谱带回来。
      const saveBasename = String(params['save_basename'] ?? '')

      const budget = await readSweepBudget(ctx)
      const requested = budget.coreS * SWEEP_BUDGET_FACTOR + SWEEP_BUDGET_PAD_S
      const { record, recvTimeoutS } = await ctx.slowCall(
        'BiasSpectr_Start',
        requested,
        1,
        saveBasename,
      )
      if (failed(record)) return fail(record.error ?? '')

      // `acquisition_complete` 说的是**这次扫掠调用跑完了**（上面已经挡过
      // `record.error`），不是「谱拿到了」。这两件事在这个技能里是分开的。
      const data: Record<string, unknown> = { acquisition_complete: true }
      // 记账：按仪器设定算出来要多久、recv 预算**真的**抬到了多少。
      // 出问题时这是第一现场 —— 抬得不够会表现成「连接莫名其妙废了」。
      data['sweep_estimate_s'] = pyRound(budget.coreS, 1)
      data['recv_timeout_s'] = recvTimeoutS === null ? null : pyRound(recvTimeoutS, 1)
      data['sweep_settings'] = budget.detail
      if (saveBasename !== '') data['save_basename'] = saveBasename

      const spec = reshapeSpectrum(body(record))
      const parsed = Object.keys(spec.channels).length > 0
      data['spectrum_parsed'] = parsed
      if (parsed) {
        Object.assign(
          data,
          spectrumFields(spec.channels, spec.numPoints, [
            ['voltage', ['bias', 'volt']],
            ['current', ['current']],
          ]),
        )
      } else {
        data['spectrum_unparsed_reason'] = spec.reason
      }

      const saved = await latestSavedDat(ctx)
      if (saved !== null && saved !== '') data['path'] = saved

      // ── success 的取法（判据写在这里，别照搬别处）──
      //
      // ⚠️ 这条判断的弱处写下来，好让下一个人能推翻它：找 `.dat` 用的是
      // 「最近 120 s 内最新的那一个」，是个启发式，它**可能漏**（慢盘、目录不在
      // 候选表里）。所以 error 文本必须告诉人去盘上自己看一眼。
      if (!parsed && (saved === null || saved === '')) {
        return fail(
          `扫掠跑完了,但返回的数据块解不开(${spec.reason}),` +
            `而且没有找到自动保存的 .dat —— 这次采集没有在任何地方` +
            `留下可用的谱。若 autosave 是开着的,请到 Nanonis 的保存` +
            `目录自己确认一次(这里只看最近 120 s 内最新的 .dat)。`,
          data,
        )
      }
      return ok(data)
    },
  }
}

export const AcquireSTS: Skill = makeAcquireSTS()

export const AcquireZSpectr: Skill = {
  spec: S.AcquireZSpectrSpec,
  execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
    await ctx.safeCall('ZSpectr_Open')
    await ctx.safeCall('ZSpectr_PropsSet', 0, 0, 0, 1, 2, 1)

    const record = await ctx.safeCall('ZSpectr_Start', 1, '')
    if (failed(record)) return fail(record.error ?? '')

    const data: Record<string, unknown> = { acquisition_complete: true }
    const spec = reshapeSpectrum(body(record))
    const parsed = Object.keys(spec.channels).length > 0
    data['spectrum_parsed'] = parsed
    if (!parsed) {
      // ⚠️ **这里的结论和 `AcquireSTS` 不一样，而不一样是有依据的**（见抬头 ③）。
      data['spectrum_unparsed_reason'] = spec.reason
      return fail(
        `扫掠跑完了,但返回的数据块解不开(${spec.reason})。` +
          `这个技能不落盘,内联返回是唯一的一份 —— ` +
          `这次采集没有留下任何可用的谱。`,
        data,
      )
    }
    Object.assign(
      data,
      spectrumFields(spec.channels, spec.numPoints, [
        ['current', ['current']],
        ['dIdV', ['lix', 'did', 'di/dv', 'di_dv']],
      ]),
    )
    // z 先按几个明确的写法找，找不到再退到「名字以 z 开头」。
    let z = matchSpectrumChannel(spec.channels, ['z (', 'z(', 'z_m', 'z pos'])
    if (z === null) {
      for (const [name, trace] of Object.entries(spec.channels)) {
        if (name.trim().toLowerCase().startsWith('z')) {
          z = trace
          break
        }
      }
    }
    if (z !== null) data['z'] = z
    return ok(data)
  },
}

// ── 配置：多动词、逐步早退的那几个 ──────────────────────────────────────────

export const ConfigureSTS: Skill = {
  spec: S.ConfigureSTSSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const startV = params['start_v']
    const endV = params['end_v']
    const numPoints = params['num_points']
    const zOffset = params['z_offset_m'] ?? 0.0

    const open = await ctx.safeCall('BiasSpectr_Open')
    if (failed(open)) return fail(open.error ?? '')

    const limits = await ctx.safeCall('BiasSpectr_LimitsSet', startV, endV)
    if (failed(limits)) return fail(limits.error ?? '')

    const props = await ctx.safeCall('BiasSpectr_PropsSet', 1, 1, 1, numPoints, zOffset, 1, 2)
    if (failed(props)) return fail(props.error ?? '')

    // 把两件原本从「操作员上次在 Nanonis 界面里留下的状态」继承来的行为钉死
    // （2026-07-03）。`AdvPropsSet(reset_bias, z_ctrl_hold, record_final_z,
    // lockin_run)`，每一项 0=不改 / 1=On / 2=Off：
    //   · Z-Controller Hold = On ⇒ 扫掠期间**挂起反馈**（等高 STS）。不挂起的话，
    //     扫掠越过 0 V 时反馈会把针尖往表面里驱。
    //   · Reset Bias = On ⇒ 扫完把偏压还回成像值（别把结停在扫掠终点电压上）。
    const adv = await ctx.safeCall('BiasSpectr_AdvPropsSet', 1, 1, 0, 0)
    // **不致命**：有的控制器/固件会拒 AdvPropsSet，而扫掠仍然跑得起来。
    // 报进 `data` 而不是让整条配置失败 —— 但也**不谎称它成了**：拒掉时这两个键
    // 是 `null`（「没设上」不是「设成了 false」）。
    const advOk = !failed(adv)

    return ok({
      start_v: startV,
      end_v: endV,
      num_points: numPoints,
      z_offset_m: zOffset,
      z_controller_hold: advOk ? true : null,
      reset_bias: advOk ? true : null,
    })
  },
}

export const ConfigureZSpectr: Skill = {
  spec: S.ConfigureZSpectrSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const zOffset = params['z_offset_m']
    const zDistance = params['z_sweep_distance_m']
    const numPoints = params['num_points']
    const backward = params['backward_sweep'] ?? true

    const open = await ctx.safeCall('ZSpectr_Open')
    if (failed(open)) return fail(open.error ?? '')

    const range = await ctx.safeCall('ZSpectr_RangeSet', zOffset, zDistance)
    if (failed(range)) return fail(range.error ?? '')

    const props = await ctx.safeCall(
      'ZSpectr_PropsSet',
      pyInt(backward),
      numPoints,
      1,
      1,
      2,
      1,
    )
    if (failed(props)) return fail(props.error ?? '')

    return ok({
      z_offset_m: zOffset,
      z_sweep_distance_m: zDistance,
      num_points: numPoints,
      backward_sweep: backward,
    })
  },
}

// ── 通道 ────────────────────────────────────────────────────────────────────

export const ConfigureSTSChannels: Skill = {
  spec: S.ConfigureSTSChannelsSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const indexes = strictIntList(params['channel_indexes'])
    if (indexes === null) return fail(CHANNEL_REFUSAL(params['channel_indexes']))
    const rec = await ctx.safeCall('BiasSpectr_ChsSet', indexes)
    if (failed(rec)) return fail(rec.error ?? '')
    return ok({ channel_indexes: indexes })
  },
}

/** `*_ChsSet(Channel_indexes)` 收**一个**实参：线格式 `+*i` 自己带长度。 */
function chsSetter(spec: SkillSpec, verb: string): Skill {
  return {
    spec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const indexes = coerceIntList(params['channel_indexes'])
      if (indexes === null) return fail(CHANNEL_REFUSAL(params['channel_indexes']))
      const rec = await ctx.safeCall(verb, indexes)
      if (failed(rec)) return fail(rec.error ?? '')
      return ok({ channel_indexes: indexes })
    },
  }
}

/** `*_ChsGet` 的 body：`[通道数, 索引表, 字节数, 通道数, 名字表]`。 */
function chsReader(spec: SkillSpec, verb: string): Skill {
  return verbSkill(spec, verb, () => [], (rec) => {
    const b = body(rec)
    return {
      // **索引可能是一串 1-元组**（真机 2026-08-04）—— 这条形状知识只有
      // `channelIdsFromBuffer` 一份，见 `scan-reply.ts`。
      channel_indexes: b.length > 1 && Array.isArray(b[1]) ? channelIdsFromBuffer(b) : [],
      channel_names: b.length > 4 && Array.isArray(b[4]) ? (b[4] as unknown[]).map(String) : [],
    }
  })
}

export const GetSTSChannels: Skill = chsReader(S.GetSTSChannelsSpec, 'BiasSpectr_ChsGet')
export const SetSTSChannels: Skill = chsSetter(S.SetSTSChannelsSpec, 'BiasSpectr_ChsSet')
export const GetZSpectrChannels: Skill = chsReader(S.GetZSpectrChannelsSpec, 'ZSpectr_ChsGet')
export const SetZSpectrChannels: Skill = chsSetter(S.SetZSpectrChannelsSpec, 'ZSpectr_ChsSet')

// ── MLS ─────────────────────────────────────────────────────────────────────

export const SetSTSMLSMode: Skill = verbSkill(
  S.SetSTSMLSModeSpec,
  'BiasSpectr_MLSModeSet',
  // `+*c` 自己带长度，多传一个 `len(mode)` 在真机上是一次 TypeError。
  (p) => [p['mode']],
  echo('mode'),
)

/** MLS 的七串按段配置：`bias_start_v` 的长度**定义**段数，其余六串必须一样长。 */
const MLS_ARRAYS: readonly (readonly [string, 'float' | 'int'])[] = [
  ['bias_start_v', 'float'],
  ['bias_end_v', 'float'],
  ['initial_settling_s', 'float'],
  ['settling_s', 'float'],
  ['integration_s', 'float'],
  ['steps', 'int'],
  ['lockin_run', 'int'],
]

export function makeSetSTSMLSVals(deps: SpectroscopyDeps = {}): Skill {
  return {
    spec: S.SetSTSMLSValsSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const arrays: Record<string, number[]> = {}
      for (const [name, kind] of MLS_ARRAYS) {
        const got = kind === 'int' ? coerceIntList(params[name]) : coerceFloatList(params[name])
        if (got === null) {
          return fail(
            `MLS ${name} 解析不了：${JSON.stringify(params[name])} —— ` +
              `要逗号分隔的数字，每段一个。`,
          )
        }
        arrays[name] = got
      }
      const lengths = Object.fromEntries(MLS_ARRAYS.map(([n]) => [n, (arrays[n] as number[]).length]))
      const numSegments = (arrays['bias_start_v'] as number[]).length

      if (numSegments === 0) {
        return fail('no MLS segments provided (bias_start_v is empty)')
      }
      // **七串必须等长**（2026-07-03）：`MLSValsSet` 先发段数、再发每一串，
      // 长度对不上时线上的 body 与声明的段数自相矛盾 ⇒ 帧错位 / 硬件上是一份
      // 垃圾段配置。
      if (Object.values(lengths).some((n) => n !== numSegments)) {
        return fail(
          `MLS per-segment arrays must all have ${numSegments} ` +
            `elements; got lengths ${pyDict(lengths)}`,
        )
      }

      // **偏压边界要在这里自己判**：这七个参数声明成 `str`（模型的工具 schema 没有
      // 表类型），于是内核 K6 的数值包络检查**整个绕过去了** —— 一个幻觉出来的段
      // 起点/终点可以就这样远远越过 ±10 V 到达结。
      const lim = deps.effectiveLimits?.() ?? DEFAULT_SAFETY_LIMITS
      const lo = lim.bias_min_v
      const hi = lim.bias_max_v
      for (const name of ['bias_start_v', 'bias_end_v']) {
        const arr = arrays[name] as number[]
        for (let k = 0; k < arr.length; k += 1) {
          const v = arr[k] as number
          if (v < lo || v > hi) {
            return fail(
              `MLS ${name}[${k}] = ${v} V is outside the global ` +
                `bias safety bound [${lo}, ${hi}] V`,
            )
          }
        }
      }

      const rec = await ctx.safeCall(
        'BiasSpectr_MLSValsSet',
        numSegments,
        arrays['bias_start_v'],
        arrays['bias_end_v'],
        arrays['initial_settling_s'],
        arrays['settling_s'],
        arrays['integration_s'],
        arrays['steps'],
        arrays['lockin_run'],
      )
      if (failed(rec)) return fail(rec.error ?? '')
      return ok({ num_segments: numSegments })
    },
  }
}

export const SetSTSMLSVals: Skill = makeSetSTSMLSVals()

/** Python 的 `str(dict)`，只为那句等长报文。 */
function pyDict(d: Readonly<Record<string, number>>): string {
  return `{${Object.entries(d)
    .map(([k, v]) => `'${k}': ${v}`)
    .join(', ')}}`
}

// ── 三个确定性拒绝：Nanonis 的 Bias Spectroscopy **没有** safe-condition ──────
//
// `nanonis_spm` 里根本没有 `BiasSpectr_SafeCond*`（`BiasSpectr_*` 止于
// `MLSValsGet`）。自动退针那套只有 **Z** 谱学有。老代码照着调那个不存在的方法，
// 于是**只在真机上**、而且只以一句 "Method '…' not found on Nanonis instance"
// 现形。一次都不发，当场拒，并**指路**。

/** 一次 Nanonis 调用都不发的拒绝。 */
function deadEnd(spec: SkillSpec, error: string): Skill {
  return { spec, execute: (): Promise<SkillResultLike> => Promise.resolve(fail(error)) }
}

export const SetSTSSafeCond1: Skill = deadEnd(
  S.SetSTSSafeCond1Spec,
  'Bias Spectroscopy has no safe-condition / auto-retract feature in ' +
    'the Nanonis API. This control only exists for Z Spectroscopy — use ' +
    'SetZSpectrRetract (main condition) or the 2nd-condition Z retract ' +
    'skills instead.',
)

export const GetSTSSafeCond1: Skill = deadEnd(
  S.GetSTSSafeCond1Spec,
  'Bias Spectroscopy has no safe-condition / auto-retract feature in ' +
    'the Nanonis API. This control only exists for Z Spectroscopy — use ' +
    'GetZSpectrRetract / GetZSpectrRetract2nd instead.',
)

export const SetSTSSafeCond2: Skill = deadEnd(
  S.SetSTSSafeCond2Spec,
  'Bias Spectroscopy has no 2nd safe-condition / auto-retract feature ' +
    'in the Nanonis API. This control only exists for Z Spectroscopy — ' +
    'the 2nd-condition (OR/AND/THEN) retract logic is configured via the ' +
    'Z Spectroscopy auto-retract skills.',
)

// ── 时序 ────────────────────────────────────────────────────────────────────

const STS_TIMING_KEYS = [
  'z_avg_time_s',
  'z_offset_m',
  'init_settling_s',
  'max_slew_rate_v_s',
  'settling_s',
  'integration_s',
  'end_settling_s',
  'z_ctrl_time_s',
]
const ZSPECTR_TIMING_KEYS = STS_TIMING_KEYS.filter((k) => k !== 'z_offset_m')

export const ConfigureSTSTiming: Skill = verbSkill(
  S.ConfigureSTSTimingSpec,
  'BiasSpectr_TimingSet',
  (p) => STS_TIMING_KEYS.map((k) => p[k] ?? 0.0),
  (_rec, p) => Object.fromEntries(STS_TIMING_KEYS.map((k) => [k, p[k] ?? 0.0])),
)

export const ConfigureZSpectrTiming: Skill = verbSkill(
  S.ConfigureZSpectrTimingSpec,
  'ZSpectr_TimingSet',
  (p) => ZSPECTR_TIMING_KEYS.map((k) => p[k] ?? 0.0),
  (_rec, p) => Object.fromEntries(ZSPECTR_TIMING_KEYS.map((k) => [k, p[k] ?? 0.0])),
)

const STS_TIMING_READ_KEYS = [
  'z_averaging_time_s',
  'z_offset_m',
  'initial_settling_time_s',
  'max_slew_rate_v_per_s',
  'settling_time_s',
  'integration_time_s',
  'end_settling_time_s',
  'z_control_time_s',
]
const ZSPECTR_TIMING_READ_KEYS = STS_TIMING_READ_KEYS.filter((k) => k !== 'z_offset_m')

/** 读时序：**读到几位就报几位** —— 少的那一位不写这个键（「读不到」不是 0）。 */
function timingReader(
  spec: SkillSpec,
  verb: string,
  keys: readonly string[],
): Skill {
  return verbSkill(spec, verb, () => [], (rec) => {
    const b = body(rec)
    const out: Record<string, unknown> = {}
    for (let k = 0; k < keys.length && k < b.length; k += 1) out[keys[k] as string] = f(rec, k)
    return out
  })
}

export const GetSTSTiming: Skill = timingReader(
  S.GetSTSTimingSpec,
  'BiasSpectr_TimingGet',
  STS_TIMING_READ_KEYS,
)
export const GetZSpectrTiming: Skill = timingReader(
  S.GetZSpectrTimingSpec,
  'ZSpectr_TimingGet',
  ZSPECTR_TIMING_READ_KEYS,
)

// ── 其余读写 ────────────────────────────────────────────────────────────────

export const StopSTS: Skill = verbSkill(S.StopSTSSpec, 'BiasSpectr_Stop', () => [], () => ({
  stopped: true,
}))
export const StopZSpectr: Skill = verbSkill(S.StopZSpectrSpec, 'ZSpectr_Stop', () => [], () => ({
  stopped: true,
}))

export const GetSTSLimits: Skill = verbSkill(
  S.GetSTSLimitsSpec,
  'BiasSpectr_LimitsGet',
  () => [],
  (rec) =>
    hasAtLeast(rec, 2)
      ? { start_v: f(rec, 0), end_v: f(rec, 1) }
      : { start_v: 0.0, end_v: 0.0 },
)

export const SetSTSAdvancedProps: Skill = verbSkill(
  S.SetSTSAdvancedPropsSpec,
  'BiasSpectr_AdvPropsSet',
  (p) => [p['reset_bias'], p['z_controller_hold'], p['record_final_z'], p['lockin_run']],
  echo('reset_bias', 'z_controller_hold', 'record_final_z', 'lockin_run'),
)

export const GetSTSAltZCtrl: Skill = verbSkill(
  S.GetSTSAltZCtrlSpec,
  'BiasSpectr_AltZCtrlGet',
  () => [],
  (rec) =>
    hasAtLeast(rec, 3)
      ? { enabled: i32(rec, 0) !== 0, setpoint: f(rec, 1), settling_time_s: f(rec, 2) }
      : { enabled: false, setpoint: 0.0, settling_time_s: 0.0 },
)

export const GetZSpectrRange: Skill = verbSkill(
  S.GetZSpectrRangeSpec,
  'ZSpectr_RangeGet',
  () => [],
  (rec) =>
    hasAtLeast(rec, 2)
      ? { z_offset_m: f(rec, 0), z_sweep_distance_m: f(rec, 1) }
      : { z_offset_m: 0.0, z_sweep_distance_m: 0.0 },
)

export const SetZSpectrRange: Skill = verbSkill(
  S.SetZSpectrRangeSpec,
  'ZSpectr_RangeSet',
  (p) => [p['z_offset_m'], p['z_sweep_distance_m']],
  echo('z_offset_m', 'z_sweep_distance_m'),
)

export const GetZSpectrRetract: Skill = verbSkill(
  S.GetZSpectrRetractSpec,
  'ZSpectr_RetractGet',
  () => [],
  (rec) =>
    hasAtLeast(rec, 4)
      ? {
          enabled: i32(rec, 0) !== 0,
          threshold: f(rec, 1),
          signal_index: i32(rec, 2),
          comparison: i32(rec, 3) === 0 ? '>' : '<',
        }
      : { enabled: false, threshold: 0.0, signal_index: 0, comparison: '>' },
)

export const SetZSpectrRetract: Skill = verbSkill(
  S.SetZSpectrRetractSpec,
  'ZSpectr_RetractSet',
  (p) => [p['enabled'], p['threshold'], p['signal_index'], p['comparison']],
  echo('enabled', 'threshold', 'signal_index', 'comparison'),
)

/** 第二条退针条件。真方法叫 `ZSpectr_RetractSecondGet`（`…Retract2ndGet` 不存在）。 */
export const GetZSpectrRetract2nd: Skill = verbSkill(
  S.GetZSpectrRetract2ndSpec,
  'ZSpectr_RetractSecondGet',
  () => [],
  (rec) => {
    const cond = hasAtLeast(rec, 4) ? i32(rec, 0) : 0
    return {
      condition: cond,
      condition_label: SECOND_COND_LABELS[cond] ?? String(cond),
      threshold: hasAtLeast(rec, 4) ? f(rec, 1) : 0.0,
      signal_index: hasAtLeast(rec, 4) ? i32(rec, 2) : 0,
      comparison: (hasAtLeast(rec, 4) ? i32(rec, 3) : 0) === 0 ? '>' : '<',
    }
  },
)

export const SetZSpectrRetractDelay: Skill = verbSkill(
  S.SetZSpectrRetractDelaySpec,
  'ZSpectr_RetractDelaySet',
  (p) => [p['retract_delay_s']],
  echo('retract_delay_s'),
)

export const SetZSpectrAdvProps: Skill = verbSkill(
  S.SetZSpectrAdvPropsSpec,
  'ZSpectr_AdvPropsSet',
  (p) => [p['time_between_sweeps_s'], p['record_final_z'], p['lockin_run'], p['reset_z']],
  echo('time_between_sweeps_s', 'record_final_z', 'lockin_run', 'reset_z'),
)

/** 数字同步模式：`0/1/2` 加一句给人看的标签。 */
function digSyncReader(spec: SkillSpec, verb: string): Skill {
  return verbSkill(spec, verb, () => [], (rec) => {
    const v = body(rec).length > 0 ? i32(rec, 0) : 0
    return { dig_sync: v, dig_sync_label: DIGSYNC_LABELS[v] ?? String(v) }
  })
}

export const GetSTSDigSync: Skill = digSyncReader(S.GetSTSDigSyncSpec, 'BiasSpectr_DigSyncGet')
export const GetZSpectrDigSync: Skill = digSyncReader(S.GetZSpectrDigSyncSpec, 'ZSpectr_DigSyncGet')

function ttlSyncReader(spec: SkillSpec, verb: string): Skill {
  return verbSkill(spec, verb, () => [], (rec) =>
    hasAtLeast(rec, 4)
      ? {
          ttl_line: i32(rec, 0),
          ttl_polarity: i32(rec, 1),
          time_to_on_s: f(rec, 2),
          on_duration_s: f(rec, 3),
        }
      : { ttl_line: 0, ttl_polarity: 0, time_to_on_s: 0.0, on_duration_s: 0.0 },
  )
}

export const GetSTSTTLSync: Skill = ttlSyncReader(S.GetSTSTTLSyncSpec, 'BiasSpectr_TTLSyncGet')
export const GetZSpectrTTLSync: Skill = ttlSyncReader(S.GetZSpectrTTLSyncSpec, 'ZSpectr_TTLSyncGet')

function pulseSeqReader(spec: SkillSpec, verb: string): Skill {
  return verbSkill(spec, verb, () => [], (rec) =>
    hasAtLeast(rec, 2)
      ? { pulse_seq_nr: i32(rec, 0), nr_periods: i32(rec, 1) }
      : { pulse_seq_nr: 0, nr_periods: 0 },
  )
}

export const GetSTSPulseSeqSync: Skill = pulseSeqReader(
  S.GetSTSPulseSeqSyncSpec,
  'BiasSpectr_PulseSeqSyncGet',
)
export const GetZSpectrPulseSeqSync: Skill = pulseSeqReader(
  S.GetZSpectrPulseSeqSyncSpec,
  'ZSpectr_PulseSeqSyncGet',
)

export const GetSTSZOffRevert: Skill = verbSkill(
  S.GetSTSZOffRevertSpec,
  'BiasSpectr_ZOffRevertGet',
  () => [],
  (rec) => ({ z_off_revert: (body(rec).length > 0 ? i32(rec, 0) : 0) !== 0 }),
)

export const GetSTSMLSLockinPerSeg: Skill = verbSkill(
  S.GetSTSMLSLockinPerSegSpec,
  'BiasSpectr_MLSLockinPerSegGet',
  () => [],
  (rec) => ({ lockin_per_segment: (body(rec).length > 0 ? i32(rec, 0) : 0) !== 0 }),
)

/** 谱学整族，按名字索引。 */
export const SPECTROSCOPY: Readonly<Record<string, Skill>> = {
  AcquireSTS,
  AcquireZSpectr,
  ConfigureSTS,
  ConfigureSTSChannels,
  ConfigureSTSTiming,
  ConfigureZSpectr,
  ConfigureZSpectrTiming,
  GetSTSAltZCtrl,
  GetSTSChannels,
  GetSTSDigSync,
  GetSTSLimits,
  GetSTSMLSLockinPerSeg,
  GetSTSPulseSeqSync,
  GetSTSSafeCond1,
  GetSTSTTLSync,
  GetSTSTiming,
  GetSTSZOffRevert,
  GetZSpectrChannels,
  GetZSpectrDigSync,
  GetZSpectrPulseSeqSync,
  GetZSpectrRange,
  GetZSpectrRetract,
  GetZSpectrRetract2nd,
  GetZSpectrTTLSync,
  GetZSpectrTiming,
  SetSTSAdvancedProps,
  SetSTSChannels,
  SetSTSMLSMode,
  SetSTSMLSVals,
  SetSTSSafeCond1,
  SetSTSSafeCond2,
  SetZSpectrAdvProps,
  SetZSpectrChannels,
  SetZSpectrRange,
  SetZSpectrRetract,
  SetZSpectrRetractDelay,
  StopSTS,
  StopZSpectr,
}
