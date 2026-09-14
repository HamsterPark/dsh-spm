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
import { emptyHardwareState, type Skill, type SkillCallRecord, type SkillContext } from 'dsh-spm-kernel'
import { IMPLEMENTED } from './index.js'
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
function fakeCtx(
  opts: {
    errorAt?: number
    emptyAt?: number
    noEcho?: boolean
    runErrorAt?: number
    /** 注错的**文案**。有技能按错误里的子串分流（`NeedModule`），文案就是开关。 */
    errorText?: string
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

const DEVIATIONS: Readonly<Record<string, Deviation>> = {
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
const VOLATILE = new Set([
  'read_at', 'confirm_waited_s', 'elapsed_s', 'started_at', 'last_update_at',
  'module_ran_s', 'waited_s',
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

function resetProcessState(skillName: string): void {
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
      for (const [traceName, want] of Object.entries(entry.traces)) {
        // 抛异常那条是旧仓自己的缺陷（见 deviations D-SKILL-2），单独测，不在这里比
        if (want.raised !== undefined) continue

        it(`${traceName}：动词序列与返回都相等`, async () => {
          resetProcessState(name)
          const { ctx, calls } = fakeCtx(optsOf(traceName))
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

          expect(got.summary ?? '').toBe(want.summary ?? '')

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
            expect(gotData).toEqual(wantData)
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
