/**
 * 轨迹金样比对——批 1/2 每个技能、每条分支。
 *
 * 判据三样，逐条：
 * 1. **发出的动词与实参序列**相等（顺序也算）；
 * 2. `success` 相等；
 * 3. `error` / `summary` **逐字**相等，`data` 深相等。
 *
 * 金样由旧仓真实实现跑出来（`tools/spec-export/export_skill_traces.py`），
 * 脚本是**同一份**：成功、按动词首次出现逐个注错、以及第一次调用回空 body。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NO_PROFILE_SOURCE,
  attest,
  emptyHardwareState,
  processCoarseDrive,
  processExpMap,
  processInstrumentProfile,
  processTipCrash,
  processTemperature,
  processTipRegistry,
  processVacuum,
  setCurrentTip,
  readTemperature,
  revokeAttestation,
  slowCallFrom,
  type PressureSample,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type TempChannel,
} from 'dsh-spm-kernel'
import { IMPLEMENTED } from './index.js'
import { CONDITIONING_REQUIRED_SKILLS, FORGE_REQUIRED_SKILLS } from './tip-selfcheck.js'
import { processPresetStore } from './frames.js'
import { processLockInProfile } from './lockin-presets.js'
import { scriptAllowlistPath } from './nanonis-script.js'

interface Trace {
  /**
   * 这条轨迹**自己的**入参，只有与技能基准参数不同时才有。
   *
   * 有些分支由参数决定而不是由回包决定（`SetPiezoHysteresisValues` 的
   * 「不是 JSON」、`CheckScanForCrash` 的通道清单）。整个技能共用一份参数的话，
   * 重放这一侧会拿基准参数去跑它 —— 比的是另一件事，**而且会绿**。
   */
  readonly params?: Record<string, unknown>
  readonly success?: boolean
  readonly error?: string
  readonly summary?: string
  readonly data?: Record<string, unknown>
  readonly raised?: string
  readonly calls: { verb: string; args: unknown[]; kwargs: Record<string, unknown>; error: string }[]
  readonly runs?: { skill: string; params: Record<string, unknown> }[]
}
interface Entry {
  readonly params: Record<string, unknown>
  readonly traces: Record<string, Trace>
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/golden/skill_traces.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, Entry>

const S0 = emptyHardwareState('T0')

/** 与导出脚本同一套合成规则。**逐位不同**，好让 body 的位置映射可判。 */
function synthOne(t: string, i: number): unknown {
  if (t === 'f' || t === 'd') return Number((0.25 * (i + 1)).toFixed(6))
  if (t === 'i' || t === 'I' || t === 'H' || t === 'h') return 3 + i
  if (t === 'c') return 65 + i
  if (t === '*c') return `SYNTH${i}`
  if (t === '*+c') return [`Sig${i}A`, `Sig${i}B`]
  if (t === '*i') return [1 + i, 2 + i]
  if (t === '*f' || t === '*d') return [Number((0.5 + i).toFixed(6)), Number((0.75 + i).toFixed(6))]
  if (t === '2f') return [[0.1 + i, 0.2 + i], [0.3 + i, 0.4 + i]]
  return Number((0.25 * (i + 1)).toFixed(6))
}

const NANONIS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../spec/nanonis/nanonis_commands.json', import.meta.url)),
    'utf8',
  ),
) as { methods: Record<string, { returns?: string[] }> }

function synthBody(verb: string): unknown[] {
  const meta = NANONIS.methods[verb]
  if (meta === undefined) return [0.25]
  const out = (meta.returns ?? []).map((t, i) => synthOne(t, i))
  return out.length > 0 ? out : [0.25]
}

/** 与导出脚本同形的假 context：回显记忆 + 按序号注错 + 空 body。 */
/**
 * **按技能**覆写某几个动词的 body —— 与导出脚本 `export_skill_traces.CUSTOM_BODIES`
 * **同一张表**（那边的抬头写着为什么）。
 *
 * 一句话：`TiltProbeCircle` 在恒定回包上是**退化**的（一圈 Z 全相等 ⇒ 正弦拟合
 * 只剩舍入噪声 ⇒ `downhill_deg` 是掷骰子）。给 Z 一个跟着 XY 走的斜面，
 * 它才是那个技能真正要面对的东西。
 */
const CUSTOM_BODIES: Readonly<Record<string, Readonly<Record<string, (xy: [number, number]) => unknown[]>>>> = {
  TiltProbeCircle: {
    ZCtrl_ZPosGet: (xy) => [1.0e-9 + 5.0e-3 * xy[0] - 2.0e-3 * xy[1]],
  },
}

function fakeCtx(
  opts: {
    errorAt?: number
    emptyAt?: number
    noEcho?: boolean
    runErrorAt?: number
    /** 注错的**文案**。有技能按错误里的子串分流（`NeedModule`），文案就是开关。 */
    errorText?: string
    /** 哪个技能在跑 —— 只给 {@link CUSTOM_BODIES} 用（批 7a-1）。 */
    skill?: string
  } = {},
): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
} {
  const calls: { verb: string; args: unknown[]; emergency?: true }[] = []
  /** 子技能调用序列（L2 技能才有）。 */
  const runs: { skill: string; params: Record<string, unknown> }[] = []
  const echo = new Map<string, unknown[]>()
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    const i = calls.length
    // **预算，不是优化。** 这个夹具的 `sleep` 返回的是已决议的 Promise（微任务），
    // 于是一个转不出来的轮询会把事件循环填满，而 vitest 的超时是宏任务、永远轮不上
    // ——那一趟既不红也不绿，它**挂住**。挂住与通过在退出码上分不开。
    //
    // 2026-09-13 变异演练当场撞到：拆掉进针超时那道闸之后这里转了 277 秒，
    // 撞上演练自己的 120 秒上限，一条本该变红的变异被报成「超时失败」。
    // 金样里最长的一趟也就几百次调用，5000 是它的十几倍。
    if (i >= 5000) throw new Error(`轨迹夹具：调用数超过预算（${i}）—— 轮询没有出口`)
    calls.push({ verb: method, args })
    if (i === opts.errorAt) {
      return Promise.resolve({ method, args, error: opts.errorText ?? '模拟故障：连接被对端关闭' })
    }
    if (i === opts.emptyAt) return Promise.resolve({ method, args, values: [] })
    const custom = CUSTOM_BODIES[opts.skill ?? '']?.[method]
    if (custom !== undefined) {
      const xy = (echo.get('FolMe_XYPos') ?? [0, 0]).map(Number)
      return Promise.resolve({ method, args, values: custom([xy[0] ?? 0, xy[1] ?? 0]) })
    }
    const base = method.endsWith('Set') || method.endsWith('Get') ? method.slice(0, -3) : undefined
    if (method.endsWith('Set') && base !== undefined) {
      echo.set(base, [...args])
      return Promise.resolve({ method, args, values: synthBody(method) })
    }
    if (method.endsWith('Get') && base !== undefined && echo.has(base) && opts.noEcho !== true) {
      return Promise.resolve({ method, args, values: [...echo.get(base)!] })
    }
    return Promise.resolve({ method, args, values: synthBody(method) })
  }
  // **假钟与导出脚本同规则**：`sleep` 把钟往前拨，不真等。
  // no-op 的 sleep 会让「预算到了没」永远为假，轮询变死循环 —— 导出那侧
  // 踩过一次（AutoApproach 在真时间上转 30 分钟）。
  let clock = 1_000_000
  const ctx: SkillContext = {
    signal: new AbortController().signal,
    safeCall,
    // 子技能分发**照着导出脚本的 `_FakeContext.run` 来**：成功 + 空 data，
    // 第 `runErrorAt` 次失败。这个夹具的职责就是复现金样那台驱动器——
    // 换成别的形状（比如一律失败），比的就不是同一件事了。
    runSkill: (n: string, p: Readonly<Record<string, unknown>>) => {
      const i = runs.length
      runs.push({ skill: n, params: { ...p } })
      return Promise.resolve(
        i === opts.runErrorAt
          ? { success: false, error: '模拟故障：子技能失败' }
          : { success: true, data: {}, summary: `${n}: ok` },
      )
    },
    emergencyCall: (method: string, ...args: unknown[]) => {
      const p = safeCall(method, ...args)
      calls[calls.length - 1]!.emergency = true
      return p
    },
    // 批 3l：**这个夹具收得下 recv 预算**——与导出那侧同形（`_FakeContext.safe_call`
    // 收 `**kwargs` 并把 `recv_timeout_s` 记进轨迹）。接一个 `null` 的话，
    // `AcquireSTS` 会照实报 `recv_timeout_s: null`，而金样里是一个数 ——
    // 那比的就不是同一件事了。
    slowCall: slowCallFrom(safeCall, (method, _recvTimeoutS, ...args) => safeCall(method, ...args)),
    now: () => (clock += 1),
    sleep: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'trace-test',
    rootCallId: 'trace',
    approvalSource: 'llm',
  }
  return { ctx, calls }
}

/** 轨迹名 → 假 context 的开关。 */
function optsOf(trace: string): {
  errorAt?: number
  emptyAt?: number
  noEcho?: boolean
  runErrorAt?: number
  errorText?: string
} {
  // `need_module@i` = 第 i 次调用回一条**带 `NeedModule` 字样**的错。
  // Osci1T 那三个技能按这个子串分流（模块没装 ≠ 线路坏了），于是文案本身是开关：
  // 用通用注错文案跑这一格，走的是另一条分支，而且它会绿。
  const need = /^need_module@(\d+)$/.exec(trace)
  if (need !== null) {
    return { errorAt: Number(need[1]), errorText: 'NanonisError: NeedModule Osci1T' }
  }
  // `mismatch` = 关掉回显：写进去什么、读回来是另一个数。
  // 这是「写后回读」那一族**最要命**的一条分支 —— 硬件没接受这个值。
  if (trace === 'mismatch') return { noEcho: true }
  const err = /^err@(\d+)$/.exec(trace)
  if (err !== null) return { errorAt: Number(err[1]) }
  const empty = /^empty@(\d+)$/.exec(trace)
  if (empty !== null) return { emptyAt: Number(empty[1]) }
  // `runerr@i` = 第 i 次**子技能**调用失败（L2 技能才有这一路）
  const runErr = /^runerr@(\d+)$/.exec(trace)
  if (runErr !== null) return { runErrorAt: Number(runErr[1]) }
  return {}
}

/**
 * **逐格登记的偏差**。写成「我们这一侧应该是什么」，而不是「这一格跳过」：
 * 两侧都钉住之后，**旧仓哪天把它修了，这里会变红**，我们就该回来删掉这一条。
 *
 * - `D-SKILL-1` 旧仓在这些格子里走 `else parsed` 兜底，把**整个回包信封**
 *   当成读数交出去（`["", "<bytes 0>", []]`）。我们按 `scalarFloat` 判「取不出数」。
 * - `D-SKILL-2` 旧仓的诊断文案里印了 Python 的回包 repr。我们这一侧信封在
 *   wire 层就拆掉了，只有 body —— 印我们真有的东西。
 */
interface Deviation {
  readonly data?: Record<string, unknown>
  readonly error?: string
  /**
   * `summary` **逐字照这一份比**（而不是照金样那一份）。
   *
   * 与 `error` 同一条规矩，包括「旧仓那一侧也钉住」：差异消失时这条登记会当场变红。
   * 批 5a 第一次用到它 —— 两个自检的 `summary` 就是它们的**结论**
   * （「✅ 可以开工」/「❌ 还不能开工」），而本仓有意与旧仓不同。
   * 那句结论正是这一批要改的东西，所以它必须**被比**，不能被豁免。
   */
  readonly summary?: string
  /**
   * 金样里有、本仓**故意没有**的字段（点分路径）。
   *
   * 比整份 `data` 抄一遍轻，而且**抄不成一份过期的期望**：测试会先断言这个路径
   * 在金样里确实存在——差异消失时这条登记会当场变红，而不是安静地什么都不管。
   */
  readonly absent?: readonly string[]
  /**
   * 动词序列**不比**，附上理由。
   *
   * 只在旧仓那一趟里**有步骤炸了**时才允许（测试会去金样的 `_progress.failed_steps`
   * 里核实）：一次抛出去的异常会跳过那一步剩下的动作，于是后面每一拍的时刻都偏了。
   * 比较一个从崩溃点之后错位的序列，比不比更糟——它看起来像在测什么。
   *
   * 它同时豁免 `_progress` 与 `polls`：执行器的步骤台账、以及那些对不上的调用的计数，
   * 都是同一次崩溃的直接后果。**结局字段照比** —— 那才是判据。
   */
  readonly callsDifferBecause?: string
  /**
   * 动词序列**照这一份比**（而不是照金样那一份）。
   *
   * 与 `callsDifferBecause` 的区别是它仍然逐格比 —— 只是先按一条**写得出来的规则**
   * 把金样改一下。给的是「旧仓发错了实参」这一类：差异是确定的、看得见的，
   * 而整条序列的其余部分照旧钉住。
   */
  readonly calls?: readonly [string, unknown[]][]
  /**
   * 时钟派生的数按**容差**比，而不是逐位比。
   *
   * 只有一种情形用得上，而它是**夹具的属性、不是技能的**：两侧的假钟摆在不同的
   * 量级上 —— 导出脚本那边是 `_CLOCK = 1_000_000.0` **秒**、每读一次 `+= 1e-3`；
   * 这边的 `SkillContext.now()` 按契约是**毫秒**，夹具给的是整数。
   *
   * 于是「3 毫秒」在那边算出来是 `0.003000000142492354`（1e6 量级上一个 ULP 的
   * 累积漂移），在这边是 `0.0030000000000427463`。**两个都不是 0.003**，而且
   * 差在第 10 位。
   *
   * 这个差**消不掉**：毫秒钟在 1e9 上的栅格比秒钟在 1e6 上的栅格粗 2.4 %，
   * 于是有约 2 % 的秒值根本没有毫秒原像 —— 无论怎么折算，除回去都回不到同一个
   * double。（真换成同一个量级，等于改导出脚本那个全局假钟，那会把**每一条**
   * 已有金样的时间字段一起改掉。）
   *
   * 所以这一族的时间字段按 `|a−b| ≤ 1e-6·max(1,|a|)` 比 —— 实测差是 1e-10，
   * 留了四个数量级的余量，而**判据（采了几点、哪一帧丢了、顺序、判定、文案）
   * 分毫不动**：它们全都不在 {@link CLOCK_KEYS} 里。
   */
  readonly clockApprox?: true
  /**
   * **最小二乘算出来的**那几个数按容差比，而不是逐位比（批 7a-1）。
   *
   * 与 `clockApprox` 同一种形状、不同的理由，所以**另开一个名字**：
   * 那一条说的是夹具的钟不在同一个量级，这一条说的是**两边解的是同一个方程、
   * 用的是两种分解**。
   *
   * `TiltProbeCircle` 的整份 `data` 都从一次 `Z(θ)` 的正弦拟合出来：
   * 旧仓走 `np.linalg.lstsq`（LAPACK `gelsd`，SVD），本仓走列缩放 Householder QR
   * （`numerics/lsq.ts`，抬头写着为什么不能用正规方程）。两个算法都向后稳定，
   * 而它们**不是同一串浮点运算** —— 实测角度差 `8e−15`（相对），
   * 残差派生量差 `1.1e−11`（相消 + 小分量放大，推导在 `vision/tilt-circle.ts`）。
   *
   * 逐位比在这里不是「更严」，是**不可能**：要它成立得把 LAPACK 也移植一份。
   * 判据留在别处，而且留得住 —— 动词序列、点数、`valid`、`invalid_reason`、
   * 报文全都不在 {@link FIT_KEYS} 里，照旧逐位 / 逐字。
   *
   * ⚠️ 这一族的**主判据不在这份金样里**：`spec/golden/tilt.json` 的
   * `fit_circle_tilt`（12 格）与 `skills.TiltProbeCircle`（13 格）用的是一台
   * 会给斜面的假仪器，那边按 `CIRCLE_REL_TOL` / `CIRCLE_RESIDUAL_REL_TOL`
   * **逐格**比，两条容差各有推导。这边钉的是「它在注册表里、被真调度链调得动、
   * 发的是那一串动词」。
   */
  readonly fitApprox?: true
}

/**
 * 时钟派生的叶子键名。**按名字**认，与 `VOLATILE` 同一条路子 ——
 * 区别是这些量**不丢**，只是换成容差比。
 */
const CLOCK_KEYS = new Set([
  't_s', 'timestamps_s', 't_start', 't_end',
  'capture_s', 'pulse_t_s', 'shaper_start_t_s',
  'fire_call_blocked_s', 'start_call_blocked_s',
  'post_window_s', 'max_gap_s', 'feedback_restored_t', 'feedback_segment_s',
  'actual_duration_s', 'actual_fs_hz', 'fs_current_hz', 'fs_z_hz',
  // ── 批 5b：轮询循环自己算出来的那几个（见上面 `MonitorCurrent*` 那一段）──
  // ⚠️ 这张表只在**登记了 `clockApprox`** 的那几格上起作用，所以往里加名字
  // 不会放松任何别的技能（`AcquirePSD` 的 `df_hz` 来自仪器，照旧逐位比）。
  'contact_at_s', 'nyquist_hz', 'df_hz', 'freqs_hz',
])
const CLOCK_REL = 1e-6

/**
 * 最小二乘派生的叶子键名（批 7a-1）。与 {@link CLOCK_KEYS} 同一条路子：
 * 按名字认，**不丢，只是换成容差比**。只在登记了 `fitApprox` 的那几格上起作用。
 */
const FIT_KEYS = new Set([
  'tilt_x_deg', 'tilt_y_deg', 'slope_mag_deg', 'downhill_deg',
  'residual_rms_m', 'residual_ratio', 'max_residual_ratio', 'max_jump_ratio',
  'drift_rate_m_s',
])

function clockClose(a: unknown, b: unknown): boolean {
  return (
    typeof a === 'number' &&
    typeof b === 'number' &&
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= CLOCK_REL * Math.max(1, Math.abs(a))
  )
}

/**
 * 把 `want` 里**够近的**时钟数换成 `got` 的那一个，其余原样。
 *
 * 换而不是跳过：不够近时它留在原地，`toEqual` 照样把两个数并排印出来。
 */
function alignClock(want: unknown, got: unknown, key = '', keys: ReadonlySet<string> = CLOCK_KEYS): unknown {
  if (keys.has(key) && clockClose(want, got)) return got
  if (Array.isArray(want) && Array.isArray(got) && want.length === got.length) {
    return want.map((x, i) => alignClock(x, got[i], key, keys))
  }
  if (want !== null && typeof want === 'object' && got !== null && typeof got === 'object') {
    return Object.fromEntries(
      Object.entries(want as Record<string, unknown>).map(([k, x]) => [
        k,
        alignClock(x, (got as Record<string, unknown>)[k], k, keys),
      ]),
    )
  }
  return want
}

/**
 * 走 `Math.hypot` 的那几个字段 —— **D-HYPOT-1**：两种语言的 `hypot` 不是同一个
 * 函数（`hypot(4e-7, 4e-7)`：Python `…38e-7`，JS `…381e-7`，差 1 ULP）。
 *
 * 只有 `distance_m` 一个键（`FindCleanSpot` 的落点距离）。容差 `4·eps` ——
 * 一个 ULP 的四倍，**小到任何一次真的算错都盖不住**：这一族的错要么是选错了点
 * （坐标就不一样了，而坐标是整数乘 step，逐位相同），要么是量错了距离（纳米级）。
 */
const HYPOT_KEYS = new Set(['distance_m'])
const HYPOT_REL = 4 * Number.EPSILON

/** 同 {@link alignClock}：够近就换成 `got` 的那一个，不够近留在原地让 diff 印出来。 */
function alignHypot(want: unknown, got: unknown, key = ''): unknown {
  if (
    HYPOT_KEYS.has(key) &&
    typeof want === 'number' &&
    typeof got === 'number' &&
    Number.isFinite(want) &&
    Number.isFinite(got) &&
    Math.abs(want - got) <= HYPOT_REL * Math.max(Math.abs(want), Number.MIN_VALUE)
  ) {
    return got
  }
  if (Array.isArray(want) && Array.isArray(got) && want.length === got.length) {
    return want.map((x, i) => alignHypot(x, got[i], key))
  }
  if (want !== null && typeof want === 'object' && got !== null && typeof got === 'object') {
    return Object.fromEntries(
      Object.entries(want as Record<string, unknown>).map(([k, x]) => [
        k,
        alignHypot(x, (got as Record<string, unknown>)[k], k),
      ]),
    )
  }
  return want
}

/**
 * D-BIASSWP-1：旧仓给 `BiasSwp_PropsSet` 发了**五个**实参，而这条命令只收四个
 * （协议表与 `nanonis_spm` 的签名一致，都没有 `Settling_ms`）。真机上那是一次
 * `TypeError` ⇒ `RunBiasSweep` 每一次都停在第三步。
 *
 * 金样照不出它：假 context 不检查实参个数。期望值**从金样算出来** ——
 * 旧仓哪天把那个多余的实参删了，这条登记会当场变红。
 */
function withoutPhantomArg(name: string, trace: string): Deviation {
  const want = golden[name]?.traces[trace]?.calls ?? []
  return {
    calls: want.map((c) => [
      c.verb,
      c.verb === 'BiasSwp_PropsSet' ? c.args.slice(0, 4) : c.args,
    ]),
  }
}

/** 按点分路径删一个键。返回它原来在不在。 */
function dropPath(obj: unknown, path: string): boolean {
  const parts = path.split('.')
  let cur = obj
  for (const seg of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return false
    cur = (cur as Record<string, unknown>)[seg]
  }
  const last = parts[parts.length - 1]!
  if (cur === null || typeof cur !== 'object' || !(last in (cur as object))) return false
  delete (cur as Record<string, unknown>)[last]
  return true
}

/**
 * D-SCAN-5：那句报文里印的是「读回的 GET 值」，而读不到时 Python 印 `None`、
 * JS 印 `null`。为了逐字去伪造一个 Python 字面量，等于让诊断指向一个不存在的语言
 * （同 D-SKILL-2 的理由）。
 *
 * 期望值**从金样算出来**而不是抄一遍：差异就是这一个 `.replace`，看得见；
 * 而旧仓哪天改了那句话，这里会跟着变，不会悄悄过期。
 */
function startScanNullRendering(trace: string): { error?: string } {
  const want = golden['StartScan']?.traces[trace]?.error ?? ''
  const ours = want.replace('before=None', 'before=null')
  return ours === want ? {} : { error: ours }
}

/**
 * D-SCAN-5 的**同一条**，这次落在 `ScanAt` 的来源表上。
 *
 * `param_summary` 每一行是 `- name = {值} ← 来源`，而「不下发那个硬件写」那几行的值
 * 就是一个空记号：Python 印 `None`，JS 印 `null`。**为了逐字去写一个 Python 字面量，
 * 等于让这张给人看的表指向一门这里没有在跑的语言。**
 *
 * 期望值**从金样算出来**而不是抄一遍：差异就是这一个 `.replace`，看得见；
 * 而旧仓哪天改了这句话（或者去掉那几行），这里会跟着变，不会悄悄过期。
 */
/**
 * `dev.data` 那一侧的剥时钟。
 *
 * ⚠️ 它**不是** `stripVolatile`，而本该是。`DEVIATIONS` 是模块级常量，在
 * `VOLATILE` 那行之前就求值了 —— 调 `stripVolatile` 会撞 TDZ。
 * 所以这里手写一份**只针对 `_progress` 的两个时刻**的剥法，
 * 并在下面用一条测试把两份钉在一起（`批 4d 的 dev.data 与 stripVolatile 同口径`）：
 * 两份实现的仓里已经付过三次账了，这一次至少让它们分岔时当场变红。
 */
function stripProgressClock(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = { ...(data ?? {}) }
  const prog = out['_progress']
  if (prog !== null && typeof prog === 'object') {
    const { started_at: _s, last_update_at: _l, ...rest } = prog as Record<string, unknown>
    out['_progress'] = rest
  }
  return out
}

function scanAtNullRendering(trace: string): { data?: Record<string, unknown> } {
  const want = golden['ScanAt']?.traces[trace]?.data
  const lines = want?.['param_summary']
  if (!Array.isArray(lines)) return {}
  const ours = lines.map((s) => String(s).replace(' = None ←', ' = null ←'))
  if (JSON.stringify(ours) === JSON.stringify(lines)) return {}
  return { data: { ...stripProgressClock(want), param_summary: ours } }
}

/**
 * `FullScan` 的逐通道判语：旧仓兜底探针表把 14 叫「Z」，本仓一律 `ch<编号>`。
 *
 * 只在金样那一格**真的**带着一个非 `ch*` 的键时才登记（= 走了兜底那条路）。
 * 期望值从金样算出来：旧仓哪天把那张静态表修了，这条登记会跟着变。
 */
const FALLBACK_LABELS: Readonly<Record<string, string>> = { Z: 'ch14' }

function fullScanChannelLabels(trace: string): { data?: Record<string, unknown> } {
  const want = golden['FullScan']?.traces[trace]?.data
  const per = want?.['crash_check_channels']
  if (per === null || typeof per !== 'object') return {}
  const entries = Object.entries(per as Record<string, unknown>)
  if (!entries.some(([k]) => FALLBACK_LABELS[k] !== undefined)) return {}
  const renamed = Object.fromEntries(entries.map(([k, v]) => [FALLBACK_LABELS[k] ?? k, v]))
  const base = stripProgressClock(want)
  const progress = base['_progress'] as Record<string, unknown> | undefined
  const partial = progress?.['partial_data'] as Record<string, unknown> | undefined
  return {
    data: {
      ...base,
      crash_check_channels: renamed,
      ...(partial === undefined
        ? {}
        : {
            _progress: {
              ...progress,
              partial_data: { ...partial, crash_check_channels: renamed },
            },
          }),
    },
  }
}


/**
 * 批 5c · 串扰导航报告不移植：把每一级上那两个 `crosstalk_*` 键摘掉。
 *
 * 逐级的那张表出现在**两处**（`data.rungs` 与 `_progress.partial_data.rungs`），
 * 两处都要摘 —— 漏一处会让这条登记看起来「过期了」而其实只是摘漏了
 * （`fullScanChannelLabels` 已经在同一个坑上付过一次账）。
 *
 * 只在金样那一格**真的**带着这两个键时才登记：不带的时候挂一条偏差，
 * 等于登记一条不存在的差异。
 */
const CROSSTALK_KEYS = ['crosstalk_modulation_off', 'crosstalk_skipped'] as const

/**
 * `stripVolatile` 的**早求值**版本 —— 同一张键表，递归到底。
 *
 * 为什么又是一份：`DEVIATIONS` 是模块级常量，在 `VOLATILE` 那一行之前就求值，
 * 调 `stripVolatile` 会撞 TDZ（`stripProgressClock` 那段注释写的是同一件事，
 * 只是它只剥 `_progress` 的两个时刻，而批 5c 的 `elapsed_s` 藏在
 * `rungs[i].settle` 里，深两层）。
 *
 * 两份实现在这个仓里已经付过三次账，所以**键表由一条测试钉死等于 `VOLATILE`**
 * （`批 5c 的 EARLY_VOLATILE 与 VOLATILE 是同一张表`）：哪天那边长出一个键，
 * 这边不跟就当场变红。
 */
const EARLY_VOLATILE = [
  'read_at', 'confirm_waited_s', 'elapsed_s', 'started_at', 'last_update_at',
  'module_ran_s', 'waited_s', 'start_time',
]

function stripClockEarly(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripClockEarly)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !EARLY_VOLATILE.includes(k))
        .map(([k, x]) => [k, stripClockEarly(x)]),
    )
  }
  return v
}

function stripCrosstalk(rungs: unknown): { rungs: unknown; found: boolean } {
  if (!Array.isArray(rungs)) return { rungs, found: false }
  let found = false
  const out = rungs.map((r) => {
    if (r === null || typeof r !== 'object') return r
    const copy = { ...(r as Record<string, unknown>) }
    for (const k of CROSSTALK_KEYS) {
      if (k in copy) {
        found = true
        delete copy[k]
      }
    }
    return copy
  })
  return { rungs: out, found }
}

/** 本仓多出来的那一格：对账那一步的答复（见 `DEVIATIONS` 里那段）。 */
function withStepCounter(trace: string): Deviation {
  const want = golden['RelocateCoarseXY']?.traces[trace]?.data
  if (want === undefined) return {}
  return { data: { ...(stripClockEarly(want) as Record<string, unknown>), step_counter: null } }
}

function withoutCrosstalk(trace: string): Deviation {
  const want = golden['RetractForSampleChange']?.traces[trace]?.data
  if (want === undefined) return {}
  const base = stripClockEarly(want) as Record<string, unknown>
  const top = stripCrosstalk(base['rungs'])
  const progress = base['_progress'] as Record<string, unknown> | undefined
  const partial = progress?.['partial_data'] as Record<string, unknown> | undefined
  const inner = stripCrosstalk(partial?.['rungs'])
  if (!top.found && !inner.found) return {}
  return {
    data: {
      ...base,
      rungs: top.rungs,
      ...(partial === undefined
        ? {}
        : { _progress: { ...progress, partial_data: { ...partial, rungs: inner.rungs } } }),
    },
  }
}

/**
 * D-SKILL-1 在**空 body** 上的又一批：旧仓把整个回包信封
 * `["", "<bytes 0>", []]` 当成读数交了出去，而本仓在 wire 层就把信封拆了，
 * 手上只有 body（`[]`）。
 *
 * 期望值**从金样算出来**而不是抄一遍（同 D-SCAN-5 的理由）：差异就是这一条替换，
 * 看得见；旧仓哪天把它修了，这里会跟着变，不会悄悄过期。
 */
const ENVELOPE = ['', '<bytes 0>', []]

function isEnvelope(v: unknown): boolean {
  return JSON.stringify(v) === JSON.stringify(ENVELOPE)
}

/** 递归把「信封」换成「空 body」。 */
function envelopeToBody(v: unknown): unknown {
  if (isEnvelope(v)) return []
  if (Array.isArray(v)) return v.map(envelopeToBody)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, envelopeToBody(x)]),
    )
  }
  return v
}

/** 金样里含信封的那一格 → 我们这一侧应该是什么。 */
function withoutEnvelope(name: string, trace: string): Deviation {
  const want = golden[name]?.traces[trace]?.data ?? {}
  const ours = envelopeToBody(want) as Record<string, unknown>
  return { data: ours }
}

/**
 * D-SKILL-1 **最赤裸的一次**：`PLLSignalAnalyzer` 把
 * `str(rec.return_value)` 塞进 `data` —— 也就是把整个三段信封的 Python repr
 * `"('', b'', [0.25, 0.5, 5, 1.0])"` 当成示波器数据交给模型。
 *
 * 期望值**从金样那串字符串里把 body 抠出来**，而不是抄一遍：旧仓哪天改了这一处，
 * 这条登记会跟着变、或者当场变红。
 */
function withoutStrEnvelope(name: string, trace: string): Deviation {
  const want = { ...(golden[name]?.traces[trace]?.data ?? {}) }
  for (const key of ['osci_data', 'fft_data']) {
    const s = want[key]
    if (typeof s !== 'string') continue
    const at = s.indexOf('[')
    const end = s.lastIndexOf(']')
    want[key] = at < 0 || end < at ? [] : (JSON.parse(s.slice(at, end + 1)) as unknown[])
  }
  return { data: want }
}

/**
 * 批 3l · D-OSCI-1 同一条：那句「装不下」里印的是 **numpy 的异常文本**。
 *
 * 旧仓 `_reshape_spectrum` 用 `np.array(...).reshape(rows, cols)`，失败时把
 * `ValueError` 的 `str(exc)` 拼进 `reason`：
 * `cannot reshape array of size 4 into shape (6,7)`。逐字复刻它等于让诊断指向一个
 * 本仓根本没有的库 —— 而**判据（几个数、要几个）一模一样**，只是用本仓的话说。
 *
 * 期望值**从金样算出来**而不是抄一遍（同 D-SCAN-5 / D-SKILL-1 那几条的理由）：
 * 旧仓哪天改了那句话、或者 numpy 换了措辞，这条登记会跟着变，不会悄悄过期。
 */
const NUMPY_RESHAPE = /cannot reshape array of size (\d+) into shape \((\d+),\s*(\d+)\)/g

function ourReshapeWording(s: string): string {
  return s.replace(NUMPY_RESHAPE, (_m, size: string, rows: string, cols: string) =>
    `一共 ${size} 个数,要 ${Number(rows) * Number(cols)} 个`,
  )
}

function reshapeReason(name: string, trace: string): Deviation {
  const want = golden[name]?.traces[trace]
  const out: { error?: string; data?: Record<string, unknown> } = {}
  const err = want?.error ?? ''
  if (NUMPY_RESHAPE.test(err)) out.error = ourReshapeWording(err)
  NUMPY_RESHAPE.lastIndex = 0
  const data = want?.data
  if (data !== undefined) {
    // 两个键名：`AcquireSTS` / `AcquireZSpectr` 叫 `spectrum_unparsed_reason`，
    // `AcquireDeltaFCurve` 叫 `parse_error`（旧仓 `_parse` 自己起的名字，
    // 两边都照移）。同一句话、同一条登记。
    for (const key of ['spectrum_unparsed_reason', 'parse_error']) {
      const reason = data[key]
      if (typeof reason === 'string' && reason.includes('cannot reshape')) {
        out.data = { ...(out.data ?? data), [key]: ourReshapeWording(reason) }
      }
    }
  }
  return out
}

/**
 * 批 5a · 两个自检：**本仓这一侧有意与旧仓不同**，逐项登记。
 *
 * 三类差异：
 *
 * 1. **依赖缺席 ⇒ `ok=false, blocking=true`**（旧仓 `except → ok=None` 只进 warnings）。
 *    后果直接写在 `ready` 上：`TipForgeSelfCheck` 的金样那一格 `ready: true`
 *    （「✅ 可以开工」—— 而它什么都没验），本仓 `false`。
 * 2. **registry 那一项换了不变量**：旧仓查「冻结打包时技能静默消失」，
 *    本仓查「`REQUIRED_SKILLS` 里还有几个没移植」。
 * 3. 旧仓第 6/7 项（电流监控豁免表 / 地图标记归类表）与「操作模式」**不移**。
 *
 * `missing_skills` **从 `IMPLEMENTED` 算**而不是抄一份：后面几批每移一个技能它就变，
 * 抄下来的那一份会在下一批静静过期。
 */
function selfCheckDev(
  required: readonly string[],
  items: readonly (readonly [string, boolean | null, string])[],
  extra: Record<string, unknown>,
): Deviation {
  const missing = required.filter((n) => IMPLEMENTED[n] === undefined)
  const checks = [
    {
      check: '技能齐全',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `全部就位（本仓已移植 ${Object.keys(IMPLEMENTED).length} 个）`
          : `缺 ${missing.length} 个（本仓尚未移植）: ${missing.join(', ')}`,
    },
    ...items.map(([check, ok, detail]) => ({ check, ok, detail })),
  ]
  const blockers: string[] = []
  const warnings: string[] = []
  for (const c of checks) {
    if (c.ok === false) blockers.push(`${c.check}: ${c.detail}`)
    else if (c.ok === null) warnings.push(`${c.check}: ${c.detail}`)
  }
  const ready = blockers.length === 0
  const summary = [
    ready ? '✅ 可以开工' : '❌ 还不能开工',
    ...checks.map((c) => `${c.ok === true ? '✅' : c.ok === false ? '❌' : '⚠'} ${c.check}：${c.detail}`),
  ].join('\n')
  return { data: { ready, checks, blockers, warnings, missing_skills: missing, ...extra }, summary }
}

/**
 * 两个自检在 `ok` / `empty@0` 上走同一条路（空 body 的 `TipShaper_PropsGet` 不报错）。
 *
 * ⚠️ **这一项在两个自检里的位置不一样**（修针那份排第 2，锻造那份排倒数第 2），
 * 所以它由调用方摆进 `items`，不是由 `selfCheckDev` 自己补在末尾。
 */
const SHAPER_ERR: Readonly<Record<string, string>> = {
  ok: '',
  'empty@0': '',
  'err@0': '模拟故障：连接被对端关闭',
}

/**
 * Tip Shaper 那一项。
 *
 * ⚠️ 旧仓两个自检的措辞差一个词（修针那份「把 Tip Shaper **模块**打开」、锻造那份
 * 「把 Tip Shaper 打开」）。本仓两处共用同一句 —— 同一件事两句话，多的那一句只会漂。
 */
function shaperItem(err: string): readonly [string, boolean, string] {
  return err === ''
    ? ['Tip Shaper 模块', true, '在跑']
    : ['Tip Shaper 模块', false, `读不到: ${err}（Nanonis 里把 Tip Shaper 模块打开）`]
}

const MISSING_MAP = '扫描地图（`core/map_scope` + `io/exp_map` + `io/coarse_map`） 本仓还没移植（C 档，未分批）—— 这一项**没有被检查**，不是「检查通过」。'
const MISSING_PROFILE = '仪器档案（`core/instrument_profile`） 本仓还没移植（批 5c）—— 这一项**没有被检查**，不是「检查通过」。'
const MISSING_SAMPLE = '样品事实（`core/sample_facts`） 本仓还没移植（C 档，未分批）—— 这一项**没有被检查**，不是「检查通过」。'
const MISSING_SPECTRO = '谱判据（`vision/spectroscopy`，954 行） 本仓还没移植（C 档，未分批）—— 这一项**没有被检查**，不是「检查通过」。'

/** 未登记针尖时那句话 —— **旧仓写「会被拒」，而 2026-08-12 之后通用档不拒**。 */
const UNREGISTERED_TIP =
  '未登记 —— 方案表退到保守通用档（上限 ±10 V / 10 nm / 5 发），' +
  '流程默认的 10 V 大修脉冲仍在这一档的包络内，' +
  '而参数默认值只能按通用档给（不知道装的是钨还是铂铱）。先 register_tip。'

const DEVIATIONS: Readonly<Record<string, Deviation>> = {
  // ── 批 5a：两个自检逐格登记（见 `selfCheckDev` 的抬头） ──
  ...Object.fromEntries(
    Object.entries(SHAPER_ERR).map(([trace, err]) => [
      `TipConditioningSelfCheck/${trace}`,
      selfCheckDev(
        CONDITIONING_REQUIRED_SKILLS,
        [
          shaperItem(err),
          ['针尖已登记', false, UNREGISTERED_TIP],
          ['扫描地图可读', false, MISSING_MAP],
          ['Z 噪声底', false, MISSING_PROFILE],
        ],
        { tip_name: '' },
      ),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(SHAPER_ERR).map(([trace, err]) => [
      `TipForgeSelfCheck/${trace}`,
      selfCheckDev(
        FORGE_REQUIRED_SKILLS,
        [
          ['衬底可解析', false, MISSING_SAMPLE],
          ['评估帧能分辨原子', true, '5 nm / 256 px = 0.0195 nm/px（满权重档）'],
          ['表面态判据自测', false, MISSING_SPECTRO],
          ['原子相判据自测', true, '合成晶格通过、纯噪声被拒'],
          ['0.3 nm 浅扎在包络内', true, '允许'],
          shaperItem(err),
        ],
        { substrate: '' },
      ),
    ]),
  ),
  // 批 5a · D-SKILL-2：`TipShape` 与它的孪生兄弟 `TipShapeWithReadback` 同一句话 ——
  // 旧仓印三段信封的 Python repr，信封在 `nanonis-wire` 那层就拆掉了。
  'TipShape/empty@0': {
    error: (golden['TipShape']?.traces['empty@0']?.error ?? '').replace(
      "repr 前 80 字:('', b'', [])",
      'values=[]',
    ),
  },
  // ── D-SKILL-1 的又一批：空 body 上旧仓交出整个信封 ──
  //
  // 四个单动词读把它塞进 `raw`，六个聚合读把它塞进那一格。我们手上只有 body。
  ...Object.fromEntries(
    ['GetSignalsAddRT', 'GetPointShootProps', 'GetPiezoHVAInfo', 'GetPiezoHVAStatusLED',
      'GetPiezoConfig', 'GetPllConfig', 'GetScanPatternConfig', 'GetSpectroscopyConfig',
      'GetMiscInstrumentConfig',
      // 锁相解调侧那六个读的 `raw` 兜底也是同一个形状
      'GetDemodSignal', 'GetDemodPhase', 'GetDemodPhasReg', 'GetDemodHarmonic',
      'GetDemodLPFilter', 'GetDemodHPFilter',
    ].map((n) => [`${n}/empty@0`, withoutEnvelope(n, 'empty@0')]),
  ),
  // `GetTipShaperConfig` 还多一句：具名要求恰好 11 个值，而旧仓数到的是**信封的
  // 三段**，我们数到的是**空 body 的 0 个**。那句报文里印着这个数。
  'GetTipShaperConfig/empty@0': {
    data: (() => {
      const d = withoutEnvelope('GetTipShaperConfig', 'empty@0').data as Record<string, unknown>
      return { ...d, props_named_error: String(d['props_named_error']).replace('本机返回 3 个值', '本机返回 0 个值') }
    })(),
  },
  // `GetRTOversample` 那一格旧仓把解不出的信封折成了 **0**。
  // 「读不到」不是「零」——这一条本仓刻意答 `null`。
  'GetRTOversample/empty@0': { data: { rt_oversampling: null } },
  // ── D-SKILL-1：信封不当读数 ──
  'GetBiasCalibration/empty@0': { data: { calibration: null, offset: 0 } },
  'GetSetpoint/empty@0': { data: { setpoint_a: null } },
  'GetScanFrame/empty@0': { data: { raw: [] } },
  'GetScanSpeed/empty@0': { data: { raw: [] } },
  'GetScanBuffer/empty@0': { data: { raw: [] } },
  'GetTipSpeed/empty@0': { data: { raw: [] } },
  'GetPointShootOnOff/empty@0': { data: { raw: [] } },
  'GetZCtrlGain/empty@0': { data: { raw: [] } },
  'GetPiezoTilt/empty@0': { data: { raw: [] } },
  'GetPiezoSensitivity/empty@0': { data: { raw: [] } },
  'GetDriftCompensation/empty@0': { data: { raw: [] } },
  'GetPiezoXYZLimits/empty@0': { data: { raw: [] } },
  'MotorGetPos/empty@0': { data: { raw: [] } },
  'GetMotorStepCounter/empty@0': { data: { raw: [] } },
  'GetSignalRange/empty@0': { data: { signal_index: 63, raw: [] } },
  'SetScanBuffer/empty@0': { data: { raw: [] } },
  // ── D-SKILL-2：诊断文案里的回包形状 ──
  'GetAutoApproachStatus/empty@0': {
    error:
      'AutoApproach_OnOffGet 回来了,但状态位读不懂(values=[])—— 这**不是**「没在进针」,是没问出来。',
  },
  'ListSignalChannels/empty@0': {
    error: 'Could not parse signal names from response: []',
  },
  // ── D-SCAN-2：轮询自己那道中止检查不移植，于是没人再写 partial.aborted ──
  //
  // 旧仓 `run_composite` 起手 `set_partial_default("aborted", False)`，而唯一的
  // 写入方是轮询里那道中止分支。去掉那道检查之后这个键恒为 false ——
  // 一个永远不表示任何事的字段，按消融的纪律不该存在。
  // 中止本身照常记在 `progress.aborted` 与 `abort_facts` 里（而且只有一个说法）。
  ...Object.fromEntries(
    ['ok', 'err@0', 'err@5', 'err@6', 'err@19', 'err@22', 'err@23', 'err@24'].map((t) => [
      `WaitScanComplete/${t}`,
      { absent: ['_progress.partial_data.aborted'] },
    ]),
  ),
  // ── D-SCAN-4：扫描进度视觉监视器不移植 ──
  //
  // 旧仓 `StartScan` 起扫之后拉起一个守护线程，在 12.5 %…100 % 抓部分帧、跑 M12、
  // 往缓冲里发一条中文旁白。它**完全 fail-safe**（没缓冲/没视觉就空转）、也在图之外
  // （自己的线程），所以它不可能弄坏扫描——而视觉链路本仓还没有。
  ...Object.fromEntries(
    ['ok', 'empty@0', 'mismatch', 'err@0', 'err@1', 'err@2'].map((t) => [
      `StartScan/${t}`,
      {
        absent: ['vision_monitor'],
        // ── D-SCAN-5：`before=None` → `before=null` ──
        //
        // 那句报文里印的是「读回的 GET 值」，而读不到时 Python 印 `None`、JS 印
        // `null`。为了逐字去伪造一个 Python 字面量，等于让诊断指向一个不存在的
        // 语言（同 D-SKILL-2 的理由）。
        //
        // 期望值**从金样算出来**而不是抄一遍：差异就是这一个 `.replace`，
        // 看得见；而旧仓哪天改了那句话，这里会跟着变，不会悄悄过期。
        // 只在金样那句话里**真的**有 `before=None` 时才登记 —— 读得到值的那几趟
        // 两边一字不差，给它们挂一条「偏差」等于登记一条不存在的差异。
        ...startScanNullRendering(t),
      },
    ]),
  ),
  // `err@0` / `err@1` 在开模块或起跑那一步就中止了，**根本没进等待相**，
  // 所以它们的金样里没有 crosstalk 那一格——`absent` 会先断言路径存在，
  // 一刀切地登记会被它当场判成过期（确实被判了一次）。
  ...Object.fromEntries(
    ['ok', 'empty@0', 'mismatch', 'runerr@0', 'err@2', 'err@3',
      'err@17', 'err@18', 'err@19'].map((t) => [
      `AutoApproach/${t}`,
      {
        absent: [
          // D-APPROACH-2：串扰报告不移植。它每 15 s 读一次 lock-in X 报「≈还剩多少步」，
          // **不驱动任何决策**（旧仓自己的注释写着），而 lock-in 链路本仓还没有。
          // 金样里它那一格记的正好是「调制关着所以这条报告永远是这一句」——
          // 也就是说在旧仓的默认配置下它也不产出信息。
          '_progress.partial_data.crosstalk',
        ],
      },
    ]),
  ),
  // ── D-SKILL-3 的又一格：空 body 上旧仓的轮询**炸了** ──
  //
  // 旧仓读状态用的是 `parsed[2][0]`，空 body ⇒ IndexError ⇒ 那一步被 `optional`
  // 吞掉（金样里看得见：`failed_steps: ["poll_0"]`）。**这同时是 GraphExecutor 的
  // optional 路第一次在一个真技能上被走到。** 崩掉的那一步不会 sleep，于是从它之后
  // 每一拍的时刻都比本仓早半个轮询，动词序列整体错位。
  'WaitScanComplete/empty@0': {
    absent: ['_progress.partial_data.aborted'],
    callsDifferBecause: '旧仓 poll_0 在空 body 上抛 IndexError（被 optional 吞掉），此后时序错位',
  },
  // ── D-BIASSWP-1：那个第五个实参不存在（见 `withoutPhantomArg`）──
  ...Object.fromEntries(
    ['ok', 'empty@0', 'swapped', 'err@2', 'err@3'].map((t) => [
      `RunBiasSweep/${t}`,
      withoutPhantomArg('RunBiasSweep', t),
    ]),
  ),
  // ── D-SKILL-1 的又一格：空 body 上旧仓把整个信封塞进 `band_rms` ──
  'GetSpectrumAnalyzerData/empty@0': withoutEnvelope('GetSpectrumAnalyzerData', 'empty@0'),
  // ── 批 3f：空 body 上的信封又一批（PLL 的 `raw` / 限值那两格的 `before`）──
  ...Object.fromEntries(
    ['GetPLLDemodInput', 'GetPLLFreqSwpParams', 'GetPLLInpProps',
      'GetPLLSignalAnlzrFFTProps', 'GetPLLSignalAnlzrTimebase',
      'HomeZController', 'SetSafeTipProps',
    ].map((n) => [`${n}/empty@0`, withoutEnvelope(n, 'empty@0')]),
  ),
  // ── 批 3h：空 body 上的信封又一批 ──
  //
  // 扫频与图样那一族的读都是「解得出就换掉 data，解不出就留 `raw`」，而空 body 上
  // 旧仓的 `decode_reply` 把整个信封当成 `raw` 交了出去。`WaitForScanEndBlocking`
  // 的 `result` 同理。我们这一侧信封在 wire 层就没了，手上只有 body。
  ...Object.fromEntries(
    ['GenSwpAcqChsGet', 'GenSwpPropsGet', 'GenSwpSwpSignalGet',
      'GetLockInSweepLimits', 'GetLockInSweepProps',
      'GetPatternCloud', 'GetPatternProps', 'WaitForScanEndBlocking',
    ].map((n) => [`${n}/empty@0`, withoutEnvelope(n, 'empty@0')]),
  ),
  // ── D-SKILL-1 **最赤裸的一次**：`str(整个信封)` 被当成示波器数据交给模型 ──
  ...Object.fromEntries(
    ['ok', 'mismatch', 'empty@0'].map((t) => [
      `PLLSignalAnalyzer/${t}`,
      withoutStrEnvelope('PLLSignalAnalyzer', t),
    ]),
  ),
  // ── 批 3g：空 body 上的信封又一批（`optional_*` 五族的聚合读）──
  //
  // 这一族全走 `_multi_read` / 逐格 `_rv`：旧仓在空 body 上把整个三段信封
  // `["", "<bytes 0>", []]` 当成那一格的读数交出去，我们手上只有 body（`[]`）。
  ...Object.fromEntries(
    ['GetPiController', 'GetGenericPiController', 'GetPreamp', 'GetPllZoomFftData',
      'GetPllSignalAnalyzerData', 'GetOcSync', 'GetTipRecorderData',
      'GetKelvinController', 'GetCpdCompensation', 'GetInterferometer',
      'GetBeamDeflection', 'GetLaser',
      'GetProbeZController', 'GetProbeBias', 'GetProbeCurrent',
      'GetHighSpeedSweepStatus', 'GetRfGeneratorStatus',
      'GetHighResScopeData', 'GetHighResScopeStatus',
      'RunHighSpeedSweep', 'RunPllPhaseSweep',
    ].map((n) => [`${n}/empty@0`, withoutEnvelope(n, 'empty@0')]),
  ),
  // ── 批 3g · D-ZERO-1 第四次：`num_sweeps = 0` 那个无限标志翻不起来 ──
  //
  // 声明写着「0 = 一直连续扫到被停止为止」、`min_value = 0`，代码里也有
  // `1 if n == 0 else 0` 这一支 —— 而 `or 1` 让 `n` 永远不可能是 0，
  // 于是那个分支是死的，一次「扫到我喊停」的请求安安静静地变成**扫一次**。
  //
  // 期望值**从金样算出来**：旧仓哪天把 `or 1` 去掉，这条登记会当场变红。
  'ConfigureHighSpeedSweep/infinite': {
    calls: (golden['ConfigureHighSpeedSweep']?.traces['infinite']?.calls ?? []).map((c) => [
      c.verb,
      c.verb === 'HSSwp_NumSweepsSet' ? [c.args[0], 1] : c.args,
    ]),
  },
  // ── 批 3j · D-SKILL-2 的又一处：那句「读不懂」里印的是回包形状 ──
  //
  // `shaper_bias_default` 读不懂偏压时，旧仓印的是 `str(return_value)[:80]` ——
  // 三段信封的 Python repr。信封在 `nanonis-wire` 那层就拆掉了，这一侧只有 body。
  // 期望值**从金样算出来**：旧仓哪天改了那句话，这条登记会跟着变，不会悄悄过期。
  // ── 批 3j · 两侧的假钟摆在不同量级上 ⇒ 时间字段按容差比（见 `clockApprox`）──
  ...Object.fromEntries(
    ['BiasPulseWithReadback', 'TipShapeWithReadback', 'CaptureSignalBuffer'].flatMap((n) =>
      Object.keys(golden[n]?.traces ?? {}).map((t) => [`${n}/${t}`, { clockApprox: true } as const]),
    ),
  ),
  // ── 批 3l：numpy 的 reshape 异常文本（见 `reshapeReason`）──
  //
  // 合成回包给 `2f` 的是一块 2×2，而表头（`i` 的第 3/4 位）说 6×7 ——
  // 于是这一族**每一条**轨迹走的都是「装不下」那一支。
  // 批 7b-2 把 `AcquireDeltaFCurve` 加进来：同一族同一条 —— 它的 `_parse` 也走
  // `_reshape_spectrum`，只是把那句话落在 `parse_error` 这个键上。
  ...Object.fromEntries(
    ['AcquireSTS', 'AcquireZSpectr', 'AcquireDeltaFCurve'].flatMap((n) =>
      Object.keys(golden[n]?.traces ?? {}).map((t) => [`${n}/${t}`, reshapeReason(n, t)]),
    ),
  ),
  // ── 批 7b-2 · D-SKILL-2 的又一处：那句「回包里一个数都没有」印的是信封 ──
  //
  // 旧仓 `nanonis_scalar` 抛的是 `no numeric value in Nanonis reply:
  // ('', b'', [])` —— 三段信封的 Python repr。本仓 `SkillCallRecord.values`
  // **就是** body（信封在 `nanonis-wire` 那层拆掉了），印的是我们真有的东西。
  // 期望值**从金样算出来**：旧仓哪天改了那句话，这条登记会跟着变，不会悄悄过期。
  'AcquireSignalPoint/empty@0': {
    error: (golden['AcquireSignalPoint']?.traces['empty@0']?.error ?? '').replace(
      "('', b'', [])",
      '[]',
    ),
  },
  'TipShapeWithReadback/empty@0': {
    clockApprox: true,
    error: (golden['TipShapeWithReadback']?.traces['empty@0']?.error ?? '').replace(
      "repr 前 80 字:('', b'', [])",
      'values=[]',
    ),
  },
  // ── 批 4a：两句话，两条已登记的差异 ──
  //
  // ① **操作系统那句错**。旧仓印的是 `[WinError 2] 系统找不到指定的文件。`
  //    —— 带着本机的**语言环境**；Node 那边叫 `ENOENT: no such file or directory`。
  //    两句都对，都不是判据：判据是它前面那半句（谁在报、报的是哪条路径）。
  //    这里把整条期望换成本仓那句，**并且把它写死** —— 换了实现它照样会红。
  'AssessFrameTrust/ok': {
    error:
      '读不了 spec-export：ENOENT: no such file or directory, open ' +
      `'${join(process.cwd(), 'spec-export')}'`,
  },
  // ② **信封在 wire 层已经拆掉**（D-SKILL-1 的又一次）。旧仓这句把整个
  //    `(error, raw_bytes, body)` 三元组 `str()` 出来当「原始回包」，
  //    本仓手上只有 body。
  'AssessAtomicLines/empty@0': {
    error: (golden['AssessAtomicLines']?.traces['empty@0']?.error ?? '').replace(
      "('', b'', [])",
      '[]',
    ),
  },
  // ── 批 4c：四句**解析器/操作系统自己的**话，两侧本来就不同 ──
  //
  // 这四条与 `AssessFrameTrust/ok` 是同一个形状：判据是报文的**前半句**
  // （谁在拒、拒的是什么），后半句是 Python 的 `json` / `np.load` / reader
  // 或者操作系统给的，而 Node 那边一个都对不上。
  // 期望**写死本仓那一句** —— 换了实现它照样会红。
  'ComputeDriftVector/ok': {
    error:
      'cannot load reference image: ENOENT: no such file or directory, open ' +
      `'${join(process.cwd(), 'spec-export')}'`,
  },
  'LoadScanFrameFromFile/ok': {
    error:
      '读不了 spec-export: Error: ENOENT: no such file or directory, open ' +
      `'${join(process.cwd(), 'spec-export')}'`,
  },
  // V8 的 `JSON.parse` 措辞。⚠️ 它比 Python 那句**更有用**（印出了看到的是哪个 token），
  // 而这正是「不复刻」的代价与收益同时出现的地方。
  'ParseRegions/ok': {
    error: `invalid regions JSON: Unexpected token 's', "spec-export" is not valid JSON`,
  },
  'DetectAtomJump/ok': {
    error: `Failed to load current trace: Unexpected token 's', "spec-export" is not valid JSON`,
  },  // ── 批 4d：`ScanAt` 的来源表里那个空记号（D-SCAN-5 同一条）──
  ...Object.fromEntries(
    Object.keys(golden['ScanAt']?.traces ?? {}).map((t) => [`ScanAt/${t}`, scanAtNullRendering(t)]),
  ),
  // ── 批 4d：撞针检查的每一路一律标 `ch<编号>` ──
  //
  // 旧仓那张**静态兜底**探针表是 `((0, "ch0"), (14, "Z"))` —— 第二项带着一个名字
  // 「Z」，而 14 是不是 Z **随装机而变**（标准模拟器上 Z 是 **30**）。也就是说那个
  // 标签是一句**没核过的断言**：一路逐通道的判语，键上写着一个可能根本不是那路信号
  // 的名字。2026-06-29 那个「撞针检查每一次都报 skipped」的缺陷，根就是同一个数字。
  //
  // 所以本仓不带名字，只带编号。**只在真的走了兜底那条路的格子上登记** ——
  // 通道问得到的那几趟两边一字不差（`ch2`/`ch3`），给它们挂一条偏差
  // 等于登记一条不存在的差异。
  ...Object.fromEntries(
    Object.keys(golden['FullScan']?.traces ?? {}).map((t) => [
      `FullScan/${t}`,
      fullScanChannelLabels(t),
    ]),
  ),
  // ── 批 5c：`ReadCalibrations` 的「标称 f₀/Q」两个字段不移植 ──
  //
  // 旧仓那两个字段**恒为 `None`**，而且是有原因的：它们住在**针尖登记表**那一行上
  // （`core/tip_state.py`），而这个技能是用 `get_config` 去**仪器档案**里取的。
  // 那两个键从来没在档案的键表里注册过，于是 `sanitize()` 静默丢掉它们 ——
  // 与 D-QPLUS-1 记着的那个坑是同一个。金样里逐格录着 `null`，就是证据。
  //
  // 接一个永远返回空的读口，等于给下一个人留一条永远不亮的分支（同 D-CRASH-3）。
  // 针尖登记表落地的那天，把它们接到**那一侧**，不是接到档案上。
  'ReadCalibrations/ok': {
    absent: ['qplus.nominal_f0_hz', 'qplus.nominal_q', 'qplus.nominal_note'],
  },
  // ── 批 5c：串扰导航报告不移植（同 D-APPROACH-2）──
  //
  // 它要一条参考曲线，本仓没有。旧仓那段自己写着「这是报告，不是任何流程的目的」，
  // 整体包在 try/except、永不抛、**不驱动任何决策** —— 梯子的进退只看方向判据。
  // 期望值**从金样算出来**：旧仓哪天把这两个键改了，这条登记会跟着变。
  ...Object.fromEntries(
    Object.keys(golden['RetractForSampleChange']?.traces ?? {}).map((t) => [
      `RetractForSampleChange/${t}`,
      withoutCrosstalk(t),
    ]),
  ),
  // ── 批 5c：`RelocateCoarseXY` 多一格 `step_counter` ──
  //
  // 旧仓 `_phase_verify` 的答复（「本控制器不支持步进计数器读回…… **这是如实记录,
  // 不是通过**」）**从来没有离开过那个步骤** —— `run_composite` 的 `data` 里没有它。
  // 一句专门写来防止「打一个安心的勾」的话，读不到就等于没写，所以本仓把它顶上来。
  // 这几格轨迹都停在 preflight，所以那一格是 `null`（这一步没跑到）。
  ...Object.fromEntries(
    Object.keys(golden['RelocateCoarseXY']?.traces ?? {}).map((t) => [
      `RelocateCoarseXY/${t}`,
      withStepCounter(t),
    ]),
  ),
  ...Object.fromEntries(
    Object.keys(golden['StepCoarseXY']?.traces ?? {}).map((t) => [
      `StepCoarseXY/${t}`,
      { clockApprox: true } as const,
    ]),
  ),
  // ── 批 5b · D-SKILL-2 的又一处：那句「读不懂」里印的是回包形状 ──
  //
  // `WatchScanLines` 与 `AssessAtomicLines` 共用同一份 `resolveReadout`，
  // 于是同一句话在这里第二次出现：旧仓印的是三段信封的 Python repr，
  // 而信封在 `nanonis-wire` 那层就拆掉了，这一侧只有 body。
  // 期望**从金样算出来** —— 旧仓哪天改了那句话，这条登记会跟着变，不会悄悄过期。
  'WatchScanLines/empty@0': {
    error: (golden['WatchScanLines']?.traces['empty@0']?.error ?? '').replace(
      "('', b'', [])",
      '[]',
    ),
  },
  // ── 批 5b · 两侧的假钟摆在不同量级上 ⇒ 时间字段按容差比（同批 3j 那一组）──
  //
  // 这两个技能是**自己排拍的轮询循环**，于是每一个上报的量都从钟上来：
  // `timestamps_s` / `actual_duration_s` / `contact_at_s`（何时判到接触）、
  // 以及频谱那一族的 `actual_fs_hz` / `nyquist_hz` / `df_hz` / `freqs_hz`
  // （频率刻度 = 采样率 ÷ 点数，而采样率是两个时刻之差算出来的）。
  //
  // 导出脚本那边的假钟是 `1e6` **秒**、每读一次 `+= 1e-3`，本仓夹具是 `1e6`
  // **毫秒**、每读一次 `+= 1`。于是 `timestamps_s[0]` 那边是
  // `0.0010000000474974513`（1e6 量级上一个 ULP 的累积漂移），这边是 `0.001`。
  // **两个都不是算错了**，差在第 10 位。
  //
  // 判据字段一个都不在 `CLOCK_KEYS` 里：采了几点（`n_samples`）、接触没接触
  // （`contact_detected`）、统计量（`min/max/mean/std_abs_a`）、采到的样本
  // （`samples_a`）、窗与输出档（`window`/`output`）、以及**谱本身**（`spectrum`）
  // —— 全部逐位比。
  ...Object.fromEntries(
    ['MonitorCurrent', 'MonitorCurrentFFT'].flatMap((n) =>
      Object.keys(golden[n]?.traces ?? {}).map((t) => [`${n}/${t}`, { clockApprox: true } as const]),
    ),
  ),
  // ── 批 7a-1 · 圆拟合那一族按 `fitApprox` 比（见那个字段的抬头）──
  //
  // `TiltProbeCircle` 的整份 `data` 都从一次最小二乘出来，而两边解的是同一个方程、
  // 用的是两种分解（LAPACK `gelsd` 对列缩放 Householder QR）。
  // 判据（动词序列、`n_points`、`valid`、报文）一个都不在 `FIT_KEYS` 里。
  ...Object.fromEntries(
    Object.keys(golden['TiltProbeCircle']?.traces ?? {}).map((t) => [
      `TiltProbeCircle/${t}`,
      { fitApprox: true } as const,
    ]),
  ),
  // ── 批 7a-1 · 本仓比旧仓**多一态**：读不到档案 ≠ 从未标定过 ──
  //
  // 旧仓的仪器档案是进程内的一份 dict，永远读得到，于是 `get_tilt_calibration()`
  // 只有「有」与「没有」两种答案。本仓的读口由宿主注入，而这台驱动器**没有注入**
  // —— 那是第三种状态，该做的事完全不同（一个去跑 `TiltCalibrate`，
  // 一个去修宿主接线）。把它说成「从未标定过」等于把一次配置故障报成一次待办。
  //
  // 期望**从金样算出来**（替换那两处措辞），所以旧仓哪天改了那句话，这条会跟着变。
  ...Object.fromEntries(
    Object.keys(golden['AutoTilt']?.traces ?? {}).map((t) => {
      const w = golden['AutoTilt']?.traces[t]
      const detail = String(
        (w?.data as { detail?: unknown } | undefined)?.detail ?? '',
      )
      return [
        `AutoTilt/${t}`,
        {
          error: 'skipped: calibration_unreadable',
          summary: 'AutoTilt: skipped(calibration_unreadable)',
          data: {
            ...(w?.data as Record<string, unknown>),
            reason: 'calibration_unreadable',
            next_action_hint: 'fix_profile_host',
            // 那句话换成**本仓真有的**那一句（`NO_PROFILE_SOURCE`），
            // 而金样那一侧的原话在上面 `detail` 里，差异消失时这条会变红。
            detail: detail === '' ? '' : NO_PROFILE_SOURCE,
          },
        } as const,
      ]
    }),
  ),
}

/**
 * **时钟派生的字段不比对。**
 *
 * `read_at` 是墙钟，`confirm_waited_s` 是「轮询里走过多少时间」。后者看起来像个
 * 判据，其实不是：要让两侧逐位相同，等于要求 TS 调 `now()` 的**次数**与 Python
 * 调 `monotonic()` 的次数完全一致 —— 那是实现细节，不是判断。
 *
 * 钉的是它们的**形状**（是个数、在预算之内），在下面单独一条测试里。
 */
// 时钟读数不是判据。`elapsed_s` / `started_at` / `last_update_at` 的具体值取决于
// 实现读了几次钟——把它钉住只会让每一次无关重构都变红，而它一次真 bug 也抓不到。
// 批 7b-2 补 `start_time`（**全份金样里只有 `RunGridExperiment` 有这个键**）：
// 它是 `_phase_start_experiment` 记下的一个**时刻**，而两侧的钟连原点都不同 ——
// 导出那一侧是被钉死的墙钟（`_fake_time` 恒回 `1_700_000_000.0`），本仓是单调钟
// （`ctx.now()/1000`，夹具从 1e6 ms 起）。不是「差一点」，是两把不同的尺。
// **它的值没有判据可言，而它的用法有**：`elapsed = now − start_time` 是超时那道闸，
// 那一条由 `spec/golden/batch7b2.json` 的 `grid/timeout` 一格（假钟会走）钉住，
// 「它确实被记下来了、是个有限的数」由 `batch7b2-skills.test.ts` 单独钉。
const VOLATILE = new Set([
  'read_at', 'confirm_waited_s', 'elapsed_s', 'started_at', 'last_update_at',
  'module_ran_s', 'waited_s', 'start_time',
])

/** 递归剥掉时钟字段。 */
function stripVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripVolatile)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, x]) => [k, scrubPaths(stripVolatile(x))]),
    )
  }
  return scrubPaths(v)
}

/**
 * 落盘路径按**导出脚本那一套**抹一遍，再比。
 *
 * `GrabScanFrameData` 的 `frame_path` 里有两样与判据无关的东西：跑出金样的那台机器
 * 的项目根，和一个毫秒戳。把整个字段丢掉（像 `read_at` 那样）会顺手丢掉**是判据**的
 * 部分——目录、`frame_ch{N}_dir{D}_` 这个命名模板、`.npy` 后缀。模板尤其要留：
 * 它是「取第一个空名」那道防覆盖的前提，名字里少了 `_dir{D}` 就等于两个方向互相盖。
 *
 * 所以抹的是那两段，**留下其余全部逐字比**。两侧用的是同一条规则（导出脚本里的
 * `_scrub`），改一边另一边就会红。
 */
const STAMP_RE = /(frame_ch\d+_dir\d+_)[0-9a-f]+(?=(?:_\d\d)?\.npy)/g
/**
 * 批 3j 的读回曲线同理：`<Skill>_20260916T131900Z_a1b2c3d4.json`。
 * 抹掉 UTC 时刻与那 8 位随机，**留下技能名、后缀，以及「取第一个空名」的 `_NN`**。
 */
const TRACE_STAMP_RE = /([A-Za-z0-9_]{1,40})_\d{8}T\d{6}Z_[0-9a-f]{8}(?=(?:_\d\d)?\.json)/g
/**
 * 批 7b-3：`TrackDrift_ReferenceScan` 第一趟采参考时落的
 * `drift_ref_<毫秒>.npy`。同上两条，抹掉毫秒、**留下目录与命名模板** ——
 * 而 `drift_ref_` 这个前缀是判据（路径要原样进 `message`，让调用方下一次带回来）。
 *
 * ⚠️ 这一条**只加在这一侧**，与上面两条不同。理由：导出脚本把墙钟钉死成
 * `1_700_000_000.0`（`_fake_time`），于是金样那一侧的毫秒**本来就是常数**
 * （重跑逐字节相同）；会变的只有 TS 这一侧的 `Date.now()`。而 `scrubPaths`
 * 对 `want` 与 `got` **都跑一遍**（见 `stripVolatile`），所以一条规则就够，
 * 两侧仍然落在同一个占位符上。
 */
const DRIFT_STAMP_RE = /(drift_ref_)\d+(?=\.npy)/g
function scrubPaths(v: unknown): unknown {
  if (typeof v !== 'string') return v
  return v
    .split(process.cwd())
    .join('<project-root>')
    // 脚本白名单的夹具住在一个临时目录里（**不往仓库里写文件**），
    // 而导出那侧的项目根也是临时目录——两边抹成同一个占位符，
    // 于是 `allowlist_file` 里**是判据的那部分**（`config/<文件名>`）照旧逐字比。
    .split(FIXTURE_ROOT)
    .join('<project-root>')
    .replace(STAMP_RE, '$1<stamp>')
    .replace(TRACE_STAMP_RE, '$1_<stamp>')
    .replace(DRIFT_STAMP_RE, '$1<stamp>')
}

/**
 * 每条轨迹跑之前把**进程级存储**摆成金样那一格的前提。
 *
 * 参数组存储活在进程里（它就该活在进程里——一次调用建的组，下一次调用要能用），
 * 于是 `CreateZCtrlPreset` 那一格建的 `spec-export` 会漏给后面每一格。导出脚本那侧
 * 也踩到了同一件事：`ApplyZCtrlPreset/ok` 曾经「成功」，而它成功的原因不在它自己的
 * 轨迹里，只在批次顺序里。
 *
 * 两侧现在都**显式摆**（`export_skill_traces.py` 的 `_reset_state`），值一样、
 * 名字一样。TS 这边还多一层需要：`names` 是**按字母排的**，`ApplyZCtrlPreset`
 * 跑在 `CreateZCtrlPreset` 前面——靠顺序在这里连碰巧都碰不上。
 */
const PRESET_FIXTURE = { name: 'spec-export', p_gain: '150p', i_gain: '150p' }
const NEEDS_PRESET = new Set(['ApplyZCtrlPreset', 'ListZCtrlPresets'])

/**
 * 跑金样那台机器的 lock-in 档案 —— **D-LOCKIN-2 的另一半，写下来**。
 *
 * 旧仓这两个键在 `instrument_profile` 里带**出厂默认**（973 Hz / 0.02 V），而
 * `sanitize()` 又把空值丢掉，于是 `get_config` 永远给得出数。金样因此是在
 * 「档案已填」的前提下录的，而那个前提**没写在金样里**，它藏在出厂表里。
 *
 * 本仓不带出厂默认（见 `lockin-preset.ts` 抬头：0.02 V 是一次真实的物理动作，
 * 加在谁也没确认过的隧道结上）。所以这里把那个前提**摆出来**——同 `PRESET_FIXTURE`：
 * 金样自带它的前提，两侧摆一样的。
 *
 * X/Y 信号索引照旧是 `null`：那两个键**没有**出厂默认，两侧都拒绝。
 */
const LOCKIN_FIXTURE = { modFreqHz: 973.0, modAmpV: 0.02, xSignalIndex: null, ySignalIndex: null }

/**
 * 已审脚本槽位的白名单夹具 —— **住在磁盘上，因为真的那一份也住在磁盘上**。
 *
 * 空清单是出厂状态（fail-closed），所以不摆这一份的话，脚本那 14 个技能全都落在
 * 同一句拒绝上。写进一个**临时目录**而不是仓库：一次跑测试不该在工作树里留下文件，
 * 而这条路径本身在比对前会被抹成 `<project-root>`（导出那侧也是临时目录）。
 *
 * 两条刻意不同：槽位 3 允许写 LUT 且声明了范围 `[0, 10]`，槽位 5 不允许 ——
 * 「白名单认的是**这个槽位里的那个脚本**」只有在两者并存时才看得出来。
 */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-spm-traces-'))
const ALLOWLIST_FIXTURE = {
  allowed_slots: [
    {
      slot: 3, name: '延时扫描', description: '泵浦-探测延时扫描',
      allow_lut_write: true, lut_min: 0.0, lut_max: 10.0, notes: 'LUT 单位 mm',
    },
    { slot: 5, name: '针尖成形序列', description: '固定脉冲串', allow_lut_write: false },
  ],
}
const NEEDS_SCRIPTS = new Set([
  'ListNanonisScripts', 'RunNanonisScript', 'DeployNanonisScript',
  'LoadScriptLUT', 'LoadNanonisScript',
])
const ALLOWLIST_PATH = join(FIXTURE_ROOT, 'config', 'nanonis_scripts.json')
mkdirSync(join(FIXTURE_ROOT, 'config'), { recursive: true })
scriptAllowlistPath.current = (): string => ALLOWLIST_PATH

/**
 * 批 3k：环境读的进程级夹具 —— **与 `export_skill_traces.py` 里那一份逐字同形**。
 *
 * 真空互锁的压强源与签署、温度的读数源与通道清单都是进程级注入口。
 * 不摆这一份的话，重放的是「空进程」而不是「那台机器」，
 * 而它会**绿着**比对另一件事。
 *
 * 时间钉在 `1_700_000_000`（= 2023-11-14T22:13:20Z），与导出那侧的假墙钟同一个数。
 */
const ENV_NOW_S = 1_700_000_000
const VACUUM_FIXTURE: PressureSample = {
  value: 1.0e-3, unit: 'Pa', status: 'ok',
  timestamp: '2023-11-14T22:13:08+00:00', // = ENV_NOW_S - 12
  sensorName: 'Chamber', sensorClass: 'DL7VacuumSensor',
}
const NEEDS_VACUUM = new Set(['GetChamberPressure', 'RelocateCoarseXY', 'StepCoarseXY'])

/**
 * 批 5c：**一台填过的机器**。与 `export_skill_traces.py` 的 `PROFILE_FIXTURE` 逐字同形。
 *
 * 不摆这一份，重放的是「宿主没接档案」——而那一侧本仓会**如实说读不到**，
 * 金样那一侧说的却是「从未标定过」。两句话都对，只是前提不同；
 * 把前提摆出来，比的才是同一件事（同 `PRESET_FIXTURE` / `LOCKIN_FIXTURE` 的理由）。
 *
 * ⚠️ 粗动驱动声明**故意不摆**：金样那几格录的正是「没声明 ⇒ 拒绝一切」那道闸。
 */
const PROFILE_FIXTURE: Record<string, unknown> = {
  retract_motor_dir: 'z-',
  z_extend_sign: '-1',
  z_recede_min_nm: 1.0,
  z_settle_timeout_s: 5.0,
  retract_total_steps: 111,
  retract_step_max: 100,
  xy_prewithdraw_steps: 11,
  xy_move_chunk_steps: 10,
  lockin_signal_index: 86,
  preamp_full_scale_a: 1e-8,
  tilt_cal_g11: -1.02,
  tilt_cal_g12: 0.07,
  tilt_cal_g21: 0.03,
  tilt_cal_g22: -0.98,
  tilt_cal_cond: 1.1128,
  tilt_cal_updated_at: 1_699_000_000.0,
  didv_at_contact_v: 2.5e-3,
  didv_cal_bias_v: 0.05,
  didv_cal_setpoint_a: 1e-10,
  didv_cal_mod_amp_v: 0.02,
  didv_cal_updated_at: 1_699_996_400.0,
  qplus_f0_measured_hz: 32768.0,
  qplus_q_measured: 24000.0,
  qplus_fq_updated_at: 1_699_999_400.0,
}
const NEEDS_PROFILE = new Set([
  'ReadCalibrations', 'RetractForSampleChange', 'RelocateCoarseXY', 'StepCoarseXY',
])
const TEMP_FIXTURE: TempChannel[] = [
  {
    name: 'SPM (COM3)', value: 77.35, unit: 'K', status: 'ok',
    timestamp: '2023-11-14T22:13:08+00:00', // 12 s
    driver: 'LakeshoreTemperatureSensor', real: true,
  },
  {
    name: 'Magnet (COM3)', value: 4.21, unit: 'K', status: 'warning',
    timestamp: '2023-11-14T22:12:20+00:00', // 60 s
    driver: 'LakeshoreTemperatureSensor', real: true,
  },
  {
    name: 'Cryostat', value: 0.0, unit: '', status: 'unavailable',
    timestamp: '', driver: 'PlaceholderSensor', real: false,
  },
]
const NEEDS_TEMPERATURE = new Set(['GetTemperature'])

function resetProcessState(skillName: string): void {
  // 批 5a。针尖登记表是进程级的，而**它决定修针技能填什么参数、按什么包络判**——
  // 漏清一次就会让后面某一格「因为上一格登记过一支 qPlus」而走另一条路。
  // 金样那一侧全部是**未登记**（导出器里没有 holder），所以这里清成未登记。
  setCurrentTip(null)
  processTipRegistry.overrides = {}
  processPresetStore.clear()
  if (NEEDS_PRESET.has(skillName)) processPresetStore.upsert(PRESET_FIXTURE)
  processLockInProfile.current = LOCKIN_FIXTURE
  // 「文件不存在 = 空清单」是那条 fail-closed 判据自己的一支，所以这里**删文件**
  // 而不是写一个空清单：两者在语义上是同一件事，而走真路径才验得到它。
  if (NEEDS_SCRIPTS.has(skillName)) {
    writeFileSync(ALLOWLIST_PATH, JSON.stringify(ALLOWLIST_FIXTURE), 'utf8')
  } else {
    rmSync(ALLOWLIST_PATH, { force: true })
  }
  // 批 3k。**先全清再按需摆** —— 签署是进程级的，漏清一次就会让后面某一格
  // 「因为上一格签过字」而放行，而那种绿最难看出来。
  processVacuum.nowS = () => ENV_NOW_S
  processVacuum.source = null
  processVacuum.config = {}
  revokeAttestation()
  if (NEEDS_VACUUM.has(skillName)) {
    processVacuum.source = () => VACUUM_FIXTURE
    attest('vented_to_atmosphere', {
      signedBy: '操作员甲', ttlS: 6 * 3600.0, note: '腔体已通大气',
    })
  }
  // 批 5c。同样**先全清再按需摆**。
  processInstrumentProfile.nowS = () => ENV_NOW_S
  processInstrumentProfile.source = null
  processCoarseDrive.source = null
  // 批 7a-2。**先全清** —— 撞针记忆是进程级的，而 `FindCleanSpot` 把它当成第二个
  // 避让来源：漏清一次，它就会「因为上一格撞过针」而躲开一个本来干净的点，
  // 而那种绿看起来和「它真的躲开了一个坑」一模一样。地图读口同理：
  // 导出那一侧的进程里没有活动实验（`get_active_log()` 恒为 None）。
  processExpMap.markerRows = null
  processTipCrash.tracker = null
  if (NEEDS_PROFILE.has(skillName)) {
    processInstrumentProfile.source = () => PROFILE_FIXTURE
  }
  processTemperature.source = null
  processTemperature.channelsSource = null
  if (NEEDS_TEMPERATURE.has(skillName)) {
    processTemperature.channelsSource = () => TEMP_FIXTURE
    processTemperature.source = (ch) =>
      readTemperature(TEMP_FIXTURE, { channel: ch, nowS: ENV_NOW_S })
  }
}

const names = Object.keys(IMPLEMENTED).sort()

describe('轨迹金样：批 1/2 逐条对旧仓', () => {
  it('已实现的技能都在金样里', () => {
    expect(names.filter((n) => golden[n] === undefined)).toEqual([])
  })

  for (const name of names) {
    const entry = golden[name]!
    const skill: Skill = IMPLEMENTED[name]!

    describe(name, () => {
      // **一条能比的都没有**：旧仓这个技能在基准参数上每一格都抛。
      //
      // 批 3l 第一次出现这种技能（通道串的 `'spec-export'` 过不了
      // `int()` / `float()`，而那一抛发生在任何下发之前）。空着不写的话
      // vitest 报 "No test found in suite" —— 一个**长得像故障**的通过，
      // 而且它把「这个技能一条判据都没验」藏在噪声里。
      //
      // 所以这里**照样留一条判据**：旧仓抛了；本仓不抛（D-SKILL-3 同一条），
      // 给一条说得清的拒绝，而且**一次调用都不发** —— 抛在下发之前，
      // 那就不该有半条命令已经上线。
      const comparable = Object.entries(entry.traces).filter(([, w]) => w.raised === undefined)
      if (comparable.length === 0) {
        it('旧仓每一格都抛；本仓不抛，给一条说得清的拒绝且一次调用都不发', async () => {
          expect(Object.values(entry.traces).map((t) => t.raised ?? '')).not.toContain('')
          resetProcessState(name)
          const { ctx, calls } = fakeCtx()
          const got = await skill.execute(ctx, entry.params)
          expect(got.success).toBe(false)
          expect(got.error ?? '').not.toBe('')
          expect(calls.map((c) => c.verb)).toEqual([])
        })
        return
      }

      for (const [traceName, want] of comparable) {
        it(`${traceName}：动词序列与返回都相等`, async () => {
          resetProcessState(name)
          const { ctx, calls } = fakeCtx({ ...optsOf(traceName), skill: name })
          const got = await skill.execute(ctx, want.params ?? entry.params)

          const dev = DEVIATIONS[`${name}/${traceName}`]
          if (dev?.calls !== undefined) {
            expect(calls.map((c) => [c.verb, c.args])).toEqual(dev.calls)
            // 旧仓那一侧也钉住 —— 差异消失时这条登记会变红，而不是安静地留着
            expect(want.calls.map((c) => [c.verb, c.args])).not.toEqual(dev.calls)
          } else if (dev?.callsDifferBecause === undefined) {
            expect(calls.map((c) => [c.verb, c.args])).toEqual(
              want.calls.map((c) => [c.verb, c.args]),
            )
          } else {
            // 豁免只在旧仓真的炸了一步时成立——去金样里核实，别信这段注释
            const prog = (want.data as { _progress?: { failed_steps?: string[] } } | undefined)
              ?._progress
            expect(prog?.failed_steps ?? [], dev.callsDifferBecause).not.toEqual([])
          }
          expect(got.success).toBe(want.success === true)

          if (dev?.error === undefined) {
            expect(got.error ?? '').toBe(want.error ?? '')
          } else {
            expect(got.error ?? '').toBe(dev.error)
            expect(want.error ?? '').not.toBe(dev.error) // 旧仓那一侧也钉住
          }

          // 摘要也走一遍路径抹除：批 3j 的两个技能**把落盘指针写进摘要**
          // （摘要是唯一穿过工具边界的东西），而那条路径里有项目根与时间戳。
          if (dev?.summary === undefined) {
            expect(scrubPaths(got.summary ?? '')).toBe(scrubPaths(want.summary ?? ''))
          } else {
            expect(got.summary ?? '').toBe(dev.summary)
            expect(want.summary ?? '').not.toBe(dev.summary) // 旧仓那一侧也钉住
          }

          if (dev?.data === undefined) {
            const wantData = stripVolatile(want.data ?? {})
            const gotData = stripVolatile(got.data ?? {})
            if (dev?.callsDifferBecause !== undefined) {
              // `polls` 就是**那些对不上的调用**的计数，`_progress` 是执行器为它们
              // 记的台账。两者都是同一次崩溃的直接后果，不是第二条证据。
              for (const k of ['_progress', 'polls']) {
                dropPath(wantData, k)
                dropPath(gotData, k)
              }
            }
            for (const path of dev?.absent ?? []) {
              // 先钉住「金样里确实有它」——否则这条登记会在差异消失之后静静地留着
              // `callsDifferBecause` 已经把 `_progress` 整个摘掉了，那条路径下的
              // absent 登记这时不再适用
              if (dev?.callsDifferBecause !== undefined && path.startsWith('_progress.')) continue
              expect(dropPath(wantData, path), `金样里没有 ${path}，这条 absent 登记过期了`)
                .toBe(true)
            }
            // 三档对齐叠着走，顺序无关（各自只碰自己那组键）：
            //   clockApprox —— 时钟派生字段（批 5b/5c）
            //   fitApprox   —— 拟合派生字段（批 7a-1 的 RANSAC / 圆拟合）
            //   HYPOT       —— `distance_m` 那一档**无条件**过，容差 4·eps，
            //                  盖不住任何一次真的算错（见 `HYPOT_KEYS` 抬头）
            let aligned: typeof wantData = wantData
            if (dev?.clockApprox === true) aligned = alignClock(aligned, gotData) as typeof wantData
            if (dev?.fitApprox === true) aligned = alignClock(aligned, gotData, '', FIT_KEYS) as typeof wantData
            expect(gotData).toEqual(alignHypot(aligned, gotData))
          } else {
            expect(stripVolatile(got.data ?? {})).toEqual(dev.data)
            expect(stripVolatile(want.data ?? {})).not.toEqual(dev.data)
          }
        })
      }
    })
  }
})

describe('D-SKILL-3 · 旧仓会抛 IndexError 的那一格，我们判「读不出」', () => {
  it('GetSafeTipStatus 收到空 body：失败而不是抛', async () => {
    // 旧仓这里直接 `parsed[2][0]` —— 空 body 时抛 IndexError，
    // 于是一个只读技能以一句**看不懂的**异常失败。而「保护未开」和
    // 「没问出来」是两句必须分开的话：前者可以继续，后者不能。
    expect(golden['GetSafeTipStatus']!.traces['empty@0']!.raised).toContain('IndexError')
    const { ctx } = fakeCtx({ emptyAt: 0 })
    const got = await IMPLEMENTED['GetSafeTipStatus']!.execute(ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('这**不是**「保护未开」,是没问出来')
  })
})

describe('时钟派生字段：不比数值，比形状', () => {
  it('SafeRetract 的 confirm_waited_s 是个数，且不超过 5 s 的确认预算', async () => {
    // 预算有界是「轮询不看 abort」那条能成立的前提：退针在 abort 之后也放行，
    // 而这几秒只读的确认恰恰是在确认那个 abort 想要的动作。
    const { ctx } = fakeCtx()
    const got = await IMPLEMENTED['SafeRetract']!.execute(ctx, {})
    const waited = (got.data as { confirm_waited_s: number }).confirm_waited_s
    expect(typeof waited).toBe('number')
    expect(waited).toBeGreaterThan(0)
    expect(waited).toBeLessThanOrEqual(5.5) // 预算 5 s + 最后一次读的开销
  })

  it('没声明 z_extend_sign 时**立刻收工**，不耗光预算', async () => {
    // 「白等」和「超时」是两件事：报成超时会让人去调大预算，
    // 而该做的是去仪器档案里填那个符号。
    // 默认脚本里 Z 反馈读回来是**闭合**，那一条读数就把结论定死成 not_parked，
    // 根本走不到「没声明符号」那一步。要让它现身，得让反馈读失败（err@1）。
    const { ctx, calls } = fakeCtx({ errorAt: 1 })
    const got = await IMPLEMENTED['SafeRetract']!.execute(ctx, {})
    const park = (got.data as { park: { undeclared: string[] } }).park
    expect(park.undeclared).toEqual(['z_extend_sign'])
    // 一趟读（1 次 Withdraw + 6 次读）就收工，**没有第二轮**
    expect(calls.length).toBeLessThanOrEqual(8)
    // 对照：反馈读得到时它会轮满预算
    const full = fakeCtx()
    await IMPLEMENTED['SafeRetract']!.execute(full.ctx, {})
    expect(full.calls.length).toBeGreaterThan(100)
  })
})

describe('批 4d 的 dev.data 与 stripVolatile 同口径', () => {
  // `DEVIATIONS` 是模块级常量，在 `VOLATILE` 那行之前求值 ⇒ 它调不到 `stripVolatile`
  // （TDZ），于是 `stripProgressClock` 是**第二份**剥时钟的实现。仓里因为「同一件事
  // 两份实现」已经付过三次账（D-CHANNELS-1 / D-PIEZO-1 / 十份 `cell()`），所以把两份
  // 钉在一起：哪天 `VOLATILE` 长出一个键而 `_progress` 里恰好有它，这条当场变红。
  for (const name of ['ScanAt', 'FullScan']) {
    for (const trace of Object.keys(golden[name]?.traces ?? {})) {
      it(`${name}/${trace}`, () => {
        const want = golden[name]?.traces[trace]?.data ?? {}
        expect(stripProgressClock(want)).toEqual(stripVolatile(want))
      })
    }
  }
  // 批 5c 的那一份（递归到底）同样钉住。
  it('批 5c 的 EARLY_VOLATILE 与 VOLATILE 是同一张表', () => {
    expect([...EARLY_VOLATILE].sort()).toEqual([...VOLATILE].sort())
  })
  for (const trace of Object.keys(golden['RetractForSampleChange']?.traces ?? {})) {
    it(`RetractForSampleChange/${trace}`, () => {
      const want = golden['RetractForSampleChange']?.traces[trace]?.data ?? {}
      expect(stripClockEarly(want)).toEqual(stripVolatile(want))
    })
  }
})
