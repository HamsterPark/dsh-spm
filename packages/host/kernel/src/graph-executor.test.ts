/**
 * 组合执行器的网格金样 —— 46 个用例逐格对旧仓。
 *
 * 判据是**它做了什么**，不是它返回了什么：发出的子技能调用序列、拒绝台账逐条（含
 * 字段）、旁白逐条、每一拍的进度快照、断点的落盘次数与终态、以及跑完之后那个文件
 * **还在不在**。最后一样是 2026-08-12 那条 bug 的唯一可见证据。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ABORT_LATCH_REASON,
  AbortRequested,
  GraphExecutor,
  SIDECAR_RESUME_WINDOW_S,
  USER_ABORT_TEXT,
  abortErrorText,
  abortFacts,
  dropStaleAbort,
  isTerminal,
  newProgress,
  progressFromDict,
  progressToDict,
  type CompositeProgress,
  type CompositeStep,
  type GraphExecutorDeps,
  type ProgressDict,
  type ProgressStore,
  type StepResult,
} from './graph-executor.js'

interface GoldenCase {
  progress_after_init: ProgressDict
  init_diags: GoldenDiag[]
  returned: boolean | null
  raised?: string
  raised_text?: string
  calls: { skill: string; params: Record<string, unknown>; version?: string }[]
  diags: GoldenDiag[]
  narrations: { kind: string; data: Record<string, unknown> }[]
  emits: ProgressDict[]
  checkpoint_flushes: number
  sidecar_flushes: number
  sidecar_after: string | null
  progress: ProgressDict
  failed_reasons: Record<string, string>
  sub_results: string[]
  abort_text: string
  abort_facts: { aborted: boolean; aborted_by_operator: boolean; abort_reason: string }
}
interface GoldenDiag {
  kind: string
  subject: string
  reason: string
  fields: Record<string, unknown>
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/graph_executor.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    sidecar_resume_window_s: number
    user_abort_text: string
    abort_latch_reason: string
    now: number
    begin_kind_for_skill: Record<string, string>
  }
  step_shape: Record<string, Record<string, unknown>>
  progress_shape: Record<string, unknown>
  is_terminal: Record<string, { total_steps: number; completed: number; terminal: boolean }>
  drop_stale_abort: Record<string, { before: Record<string, unknown>; after: Record<string, unknown> }>
  abort_text: Record<string, { aborted: boolean; aborted_reason: string; text: string; facts: unknown }>
  cases: Record<string, GoldenCase>
}

const NOW = golden.constants.now
const BEGIN = golden.constants.begin_kind_for_skill

// ─────────────────────────────────────────────────────────────────────────
// 常量与单函数网格
// ─────────────────────────────────────────────────────────────────────────

describe('常量', () => {
  it('三个逐字相等', () => {
    expect(SIDECAR_RESUME_WINDOW_S).toBe(golden.constants.sidecar_resume_window_s)
    expect(USER_ABORT_TEXT).toBe(golden.constants.user_abort_text)
    expect(ABORT_LATCH_REASON).toBe(golden.constants.abort_latch_reason)
  })
})

describe('isTerminal —— 8 格', () => {
  for (const [name, c] of Object.entries(golden.is_terminal)) {
    it(name, () => {
      expect(
        isTerminal({
          totalSteps: c.total_steps,
          completedSteps: Array.from({ length: c.completed }, (_, i) => `s${i}`),
        }),
      ).toBe(c.terminal)
    })
  }

  it('**流式组合的 0 分母不判 terminal** —— 宁可多恢复一次', () => {
    // 「total_steps==0 就丢弃」两次试过两次都毁掉真正被打断的流式续跑：
    // 那会重放硬件动作，并把用户已经答过的问题再问一遍。
    expect(isTerminal({ totalSteps: 0, completedSteps: ['a', 'b', 'c'] })).toBe(false)
  })
})

describe('dropStaleAbort —— 2026-08-23 的「重试」变「重放」', () => {
  for (const [name, c] of Object.entries(golden.drop_stale_abort)) {
    it(name, () => {
      const p = newProgress('C', NOW)
      p.aborted = c.before['aborted'] as boolean
      p.abortedReason = c.before['aborted_reason'] as string
      dropStaleAbort(p)
      expect({ aborted: p.aborted, aborted_reason: p.abortedReason }).toEqual({
        aborted: c.after['aborted'],
        aborted_reason: c.after['aborted_reason'],
      })
    })
  }
})

describe('abortErrorText / abortFacts —— 10 格（2026-07-28 #46）', () => {
  for (const [name, c] of Object.entries(golden.abort_text)) {
    it(name, () => {
      const p = { aborted: c.aborted, abortedReason: c.aborted_reason }
      expect(abortErrorText(p)).toBe(c.text)
      expect(abortFacts(p)).toEqual(c.facts)
    })
  }

  it('停机与步骤失败都让 `aborted` 为真，但**没有人喊过停**', () => {
    const halt = abortFacts({ aborted: true, abortedReason: '针尖状态 CRITICAL：前置放大器顶轨' })
    expect(halt.aborted).toBe(true)
    expect(halt.aborted_by_operator).toBe(false)
    // 「用户喊停」不该触发重试、不该记成故障；「跑失败了」该。
    expect(abortFacts({ aborted: true, abortedReason: '' }).aborted_by_operator).toBe(true)
  })

  it('`abortErrorText` **不看 `aborted`** —— 判有没有停必须用 `abortFacts`', () => {
    expect(abortErrorText({ abortedReason: '' })).toBe(USER_ABORT_TEXT)
    expect(abortFacts({ aborted: false, abortedReason: '' }).abort_reason).toBe('')
  })
})

describe('进度的持久化形状', () => {
  const shape = golden.progress_shape as Record<string, ProgressDict | boolean>

  it('默认值逐字段相等', () => {
    expect(progressToDict(newProgress('C', NOW))).toEqual(shape['defaults'])
  })

  it('空 dict 还原成一份空进度（名字是空串，不是抛）', () => {
    expect(progressToDict(progressFromDict({}, NOW))).toEqual(shape['from_dict_empty'])
  })

  it('宽容还原：`"4"` → 4，`1` → true，`7` → `"7"`', () => {
    const got = progressFromDict(
      { composite_name: 'X', total_steps: '4', completed_steps: ['a'], aborted: 1, aborted_reason: 7 },
      NOW,
    )
    expect(progressToDict(got)).toEqual(shape['from_dict_partial'])
  })

  it('往返不丢', () => {
    const src = shape['roundtrip'] as ProgressDict
    expect(progressToDict(fromDict(src))).toEqual(src)
  })

  it('⚠️ `failedReasons` **不在**持久化形状里 —— 跨进程续跑读不回失败原因', () => {
    expect(shape['failed_reasons_not_in_to_dict']).toBe(false)
    expect(Object.keys(progressToDict(newProgress('C', NOW)))).not.toContain('failed_reasons')
  })
})

describe('CompositeStep 的默认值', () => {
  it('与旧仓 dataclass 一致', () => {
    const d = golden.step_shape['defaults'] as Record<string, unknown>
    expect(d['optional']).toBe(false)
    expect(d['checkpoint_after']).toBe(true)
    expect(d['skill_version']).toBeNull()
    // 本仓用可选字段表达同一件事，判据落在**读的那一侧**：
    const step: CompositeStep = { stepId: 's1', skillName: 'GetBias', params: {} }
    expect(step.optional === true).toBe(d['optional'])
    expect(step.checkpointAfter !== false).toBe(d['checkpoint_after'])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 执行用例：把金样里的脚本重放一遍
// ─────────────────────────────────────────────────────────────────────────

/** 跟旧仓 `_Ctx` 同形的桩，外加一个内存断点。 */
class Harness {
  readonly calls: { skill: string; params: Record<string, unknown>; version?: string }[] = []
  readonly diags: GoldenDiag[] = []
  readonly narrations: { kind: string; data: Record<string, unknown> }[] = []
  readonly emits: ProgressDict[] = []
  checkpointFlushes = 0
  sidecarFlushes = 0
  sidecar: string | null = null

  constructor(
    private readonly results: Record<string, StepResult | Error> = {},
    private readonly aborts: boolean[] = [],
    private readonly halts: unknown[] = [],
  ) {}

  store = (enabled: boolean): ProgressStore | null =>
    enabled
      ? {
          load: () =>
            this.sidecar === null ? null : (JSON.parse(this.sidecar) as Record<string, unknown>),
          save: (d: ProgressDict) => {
            this.sidecarFlushes += 1
            this.sidecar = JSON.stringify(d)
          },
          clear: () => {
            this.sidecar = null
          },
        }
      : null

  deps(opts: Partial<GraphExecutorDeps> & { store?: ProgressStore | null }): GraphExecutorDeps {
    return {
      now: () => NOW,
      run: (skill, params, version) => {
        const rec: { skill: string; params: Record<string, unknown>; version?: string } = {
          skill,
          params: params as Record<string, unknown>,
        }
        if (version !== undefined) rec.version = version
        this.calls.push(rec)
        const r = this.results[skill]
        if (r instanceof Error) throw r
        return r ?? {}
      },
      checkAbort: () => this.aborts.shift() ?? false,
      checkHalt: () => (this.halts.length > 0 ? this.halts.shift() : ''),
      emitProgress: (p) => this.emits.push(progressToDict(p)),
      checkpointFlush: () => {
        this.checkpointFlushes += 1
      },
      diag: (kind, subject, reason, fields) => this.diags.push({ kind, subject, reason, fields }),
      narrate: (kind, data) => this.narrations.push({ kind, data }),
      beginKindFor: (s) => BEGIN[s],
      ...opts,
    }
  }
}

const P3: CompositeStep[] = [
  { stepId: 's1', skillName: 'MoveToXY', params: { x_m: 1e-9 } },
  { stepId: 's2', skillName: 'GetBias', params: {} },
  { stepId: 's3', skillName: 'StartScan', params: {} },
]

const FAIL: Record<string, StepResult> = {
  GetBias: {
    success: false,
    error: 'rolled_back: diverged',
    data: { detail: '第 1 轮后残余 Z 占用 6.4 nm' },
  },
}

interface RunOpts {
  plan?: CompositeStep[] | (() => AsyncGenerator<CompositeStep>)
  results?: Record<string, StepResult | Error>
  aborts?: boolean[]
  halts?: unknown[]
  prior?: unknown
  preSidecar?: Record<string, unknown> | null
  setTotal?: number
  onStepFailed?: (s: CompositeStep, m: string) => boolean
  onStepResult?: (s: CompositeStep, r: StepResult) => void
  noAbortCheck?: boolean
  noHaltCheck?: boolean
  noStore?: boolean
}

/** 跑一个用例，把观察到的一切压成金样那份 dict 的形状。 */
async function replay(o: RunOpts): Promise<GoldenCase> {
  const h = new Harness(o.results ?? {}, o.aborts ?? [], o.halts ?? [])
  if (o.preSidecar) h.sidecar = JSON.stringify(o.preSidecar)
  const store = h.store(o.noStore !== true)

  const deps: GraphExecutorDeps = h.deps({
    store,
    ...(o.prior !== undefined ? { getProgress: () => o.prior } : {}),
    ...(o.onStepFailed ? { onStepFailed: o.onStepFailed } : {}),
    ...(o.onStepResult ? { onStepResult: o.onStepResult } : {}),
  })
  if (o.noAbortCheck) delete (deps as { checkAbort?: unknown }).checkAbort
  if (o.noHaltCheck) delete (deps as { checkHalt?: unknown }).checkHalt

  const ex = new GraphExecutor('C', deps)
  const initDiags = h.diags.splice(0)
  // 顺序跟导出器一致：`setTotalSteps` 在快照**之前**——它是构造后的第一件事。
  if (o.setTotal !== undefined) ex.setTotalSteps(o.setTotal)
  const afterInit = progressToDict(ex.progress)

  let returned: boolean | null = null
  let raised: string | undefined
  let raisedText: string | undefined
  try {
    const plan = o.plan ?? P3
    returned = await ex.runPlan(typeof plan === 'function' ? plan() : plan)
  } catch (e) {
    raised = e instanceof Error ? e.constructor.name : typeof e
    raisedText = e instanceof Error ? e.message : String(e)
  }

  const p = ex.progress
  return {
    progress_after_init: afterInit,
    init_diags: initDiags,
    returned,
    ...(raised !== undefined ? { raised, raised_text: raisedText ?? '' } : {}),
    calls: h.calls,
    diags: h.diags,
    narrations: h.narrations,
    emits: h.emits,
    checkpoint_flushes: h.checkpointFlushes,
    sidecar_flushes: h.sidecarFlushes,
    sidecar_after: h.sidecar,
    progress: progressToDict(p),
    failed_reasons: { ...p.failedReasons },
    sub_results: [...ex.subResults.keys()].sort(),
    abort_text: abortErrorText(p),
    abort_facts: abortFacts(p),
  }
}

/** 断点文件的内容按**解析后的对象**比 —— 键序不是判据。 */
function expectCase(got: GoldenCase, name: string): void {
  const want = golden.cases[name]
  expect(want, `金样里没有用例 ${name}`).toBeDefined()
  const norm = (c: GoldenCase): unknown => ({
    ...c,
    sidecar_after: c.sidecar_after === null ? null : JSON.parse(c.sidecar_after),
  })
  expect(norm(got)).toEqual(norm(want!))
}

const gen =
  (steps: CompositeStep[], raiseAt = -1, exc?: Error) =>
  async function* (): AsyncGenerator<CompositeStep> {
    for (let i = 0; i < steps.length; i += 1) {
      if (i === raiseAt) throw exc
      yield steps[i]!
    }
  }

/** 旧仓抛的是 `ValueError`；`errName` 取的是构造器名字，所以这里得有一个同名的。 */
class ValueError extends Error {
  override readonly name = 'ValueError'
}

const boom = (): never => {
  throw new Error('cb')
}

/** 名字 → 重放脚本。与 `export_graph_executor.py` 里的那张表一一对应。 */
const SCRIPTS: Record<string, RunOpts> = {
  // ① 直路
  static_ok: {},
  empty_plan: { plan: [] },
  no_checkpoint: {
    plan: [
      { stepId: 's1', skillName: 'Noop', params: {}, checkpointAfter: false },
      { stepId: 's2', skillName: 'Noop', params: {}, checkpointAfter: false },
    ],
  },
  skill_version: { plan: [{ stepId: 's1', skillName: 'GetBias', params: {}, skillVersion: '2.1' }] },
  set_total_steps_is_a_max: { setTotal: 10 },
  set_total_steps_below_seen: { setTotal: 1 },
  tags_dont_change_anything: {
    plan: [{ stepId: 's1', skillName: 'Noop', params: {}, tags: ['a', 'b'] }],
  },

  // ② 失败的三条出路
  mandatory_fail_aborts: { results: FAIL },
  optional_fail_continues: {
    plan: [
      { stepId: 's1', skillName: 'MoveToXY', params: {} },
      { stepId: 's2', skillName: 'GetBias', params: {}, optional: true },
      { stepId: 's3', skillName: 'StartScan', params: {} },
    ],
    results: FAIL,
  },
  fail_without_detail: { results: { GetBias: { success: false, error: 'no_such_channel' } } },
  fail_with_empty_error: { results: { GetBias: { success: false, error: '' } } },
  on_step_failed_continues: { results: FAIL, onStepFailed: () => true },
  on_step_failed_aborts: { results: FAIL, onStepFailed: () => false },
  on_step_failed_raises: { results: FAIL, onStepFailed: boom },
  on_step_failed_declines_but_optional: {
    plan: [
      { stepId: 's1', skillName: 'GetBias', params: {}, optional: true },
      { stepId: 's2', skillName: 'StartScan', params: {} },
    ],
    results: FAIL,
    onStepFailed: () => false,
  },
  on_step_result_raises: {
    plan: [{ stepId: 's1', skillName: 'GetBias', params: {} }],
    onStepResult: boom,
  },

  // ③ 异常：普通异常 vs 控制流
  sub_skill_raises: { results: { GetBias: new ValueError('boom') } },
  sub_skill_raises_optional: {
    plan: [
      { stepId: 's1', skillName: 'MoveToXY', params: {} },
      { stepId: 's2', skillName: 'GetBias', params: {}, optional: true },
      { stepId: 's3', skillName: 'StartScan', params: {} },
    ],
    results: { GetBias: new ValueError('boom') },
  },
  sub_skill_abort_requested: { results: { GetBias: new AbortRequested('操作员中止') } },
  generator_abort_requested: { plan: gen(P3, 1, new AbortRequested('轮询中中止')) },
  generator_raises: { plan: gen(P3, 1, new ValueError('plan blew up')) },
  dynamic_plan_ok: { plan: gen(P3) },

  // ④ 中止闩与停机
  abort_before_step_2: { aborts: [false, true] },
  abort_before_step_1: { aborts: [true] },
  no_check_abort_never_aborts: { noAbortCheck: true },
  halt_before_step_2: { halts: ['', '针尖状态 CRITICAL：前置放大器顶轨'] },
  halt_is_one_shot: { halts: ['', '', '第三次才停'] },
  halt_non_string_ignored: { halts: [{}, {}, {}] },
  halt_none_ignored: { halts: [null, null, null] },
  halt_false_ignored: { halts: [false, false, false] },
  no_check_halt_never_halts: { noHaltCheck: true },
  abort_wins_over_halt: { aborts: [true], halts: ['停机理由'] },

  // ⑤ 恢复：两个入口，四条守卫
  sidecar_resume_skips: { preSidecar: prog({ completed_steps: ['s1', 's2'], total_steps: 3, last_update_at: NOW - 60 }) },
  sidecar_terminal_discarded: {
    preSidecar: prog({ completed_steps: ['s1', 's2', 's3'], total_steps: 3, last_update_at: NOW - 60 }),
  },
  sidecar_stale_discarded: {
    preSidecar: prog({
      completed_steps: ['s1', 's2'],
      total_steps: 3,
      last_update_at: NOW - (SIDECAR_RESUME_WINDOW_S + 1),
    }),
  },
  sidecar_streaming_total_zero_still_resumes: {
    preSidecar: prog({ completed_steps: ['s1', 's2'], total_steps: 0, last_update_at: NOW - 60 }),
  },
  sidecar_stale_abort_dropped: {
    preSidecar: prog({
      completed_steps: ['s1'],
      total_steps: 3,
      last_update_at: NOW - 60,
      aborted: true,
      aborted_reason: '上一轮：GetBias failed: 通道不存在',
    }),
  },
  sidecar_empty_not_used: {
    preSidecar: prog({ completed_steps: [], total_steps: 3, last_update_at: NOW - 60 }),
  },
  sidecar_run_id_scopes_the_file: { preSidecar: null },

  context_prior_resume_skips: { prior: prog({ completed_steps: ['s1'], total_steps: 3 }) },
  context_prior_terminal_discarded: {
    prior: prog({ completed_steps: ['s1', 's2', 's3'], total_steps: 3 }),
  },
  context_prior_stale_abort_dropped: {
    prior: prog({
      completed_steps: ['s1'],
      total_steps: 3,
      aborted: true,
      aborted_reason: '上一轮：aborted by user',
    }),
  },
  context_prior_empty_dict_ignored: { prior: {} },
  context_prior_object_accepted: {
    prior: { ...newProgress('C', NOW), totalSteps: 3, completedSteps: ['s1'] } as CompositeProgress,
  },
  sidecar_beats_context_when_further: {
    prior: prog({ completed_steps: ['s1'], total_steps: 3 }),
    preSidecar: prog({ completed_steps: ['s1', 's2'], total_steps: 3, last_update_at: NOW - 60 }),
  },
  context_kept_when_sidecar_not_further: {
    prior: prog({ completed_steps: ['s1', 's2'], total_steps: 3 }),
    preSidecar: prog({ completed_steps: ['s1'], total_steps: 3, last_update_at: NOW - 60 }),
  },
}

function prog(over: Record<string, unknown>): Record<string, unknown> {
  return { ...progressToDict(newProgress('C', NOW)), ...over }
}

describe('执行网格 —— 逐格对旧仓', () => {
  const names = Object.keys(golden.cases)

  it('脚本表覆盖金样里的每一个用例', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual(names.slice().sort())
  })

  for (const name of names) {
    it(name, async () => {
      expectCase(await replay(SCRIPTS[name]!), name)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// 四条守卫各自的理由 —— 金样比得出「相等」，比不出「为什么」
// ─────────────────────────────────────────────────────────────────────────

describe('这四条守卫各自挡住了什么', () => {
  it('**跑完删掉断点**：否则同一次运行里的下一次调用会捡到它（2026-08-12 第三次出货）', async () => {
    const ok = await replay({})
    expect(ok.sidecar_after).toBeNull()
    // 而被打断的那一次**留着**——它要续跑
    const aborted = await replay({ results: FAIL })
    expect(aborted.sidecar_after).not.toBeNull()
  })

  it('**流式组合跑完要落下步数**：分母是 0 的断点永远认不出是跑完的（2026-07-27）', async () => {
    const got = await replay({})
    const side = JSON.parse(JSON.stringify(got.progress)) as ProgressDict
    expect(side.total_steps).toBe(3)
    // 假如那一行写在最后一次 checkpoint 之后（旧仓 07-27 之前就是这样），
    // 留在盘上的断点会是 total_steps == 0，于是 isTerminal 恒假。
    expect(isTerminal({ totalSteps: 0, completedSteps: side.completed_steps })).toBe(false)
    expect(isTerminal({ totalSteps: side.total_steps, completedSteps: side.completed_steps })).toBe(true)
  })

  it('**跳步要写进台账**：跳过的和跑过的从外面看一模一样（#90）', async () => {
    const got = await replay({
      preSidecar: prog({ completed_steps: ['s1', 's2'], total_steps: 3, last_update_at: NOW - 60 }),
    })
    expect(got.calls.map((c) => c.skill)).toEqual(['StartScan'])
    expect(got.diags.filter((d) => d.kind === 'step_skip').map((d) => d.subject)).toEqual([
      'C.s1',
      'C.s2',
    ])
    // 序号从**计划**数，不是从已完成数——诊断的人要的是「第几点」
    expect(got.diags[0]!.fields['ordinal']).toBe(1)
  })

  it('**中止仍然穿透**：清掉旧中止不等于削弱用户的中止', async () => {
    const got = await replay({
      preSidecar: prog({
        completed_steps: ['s1'],
        total_steps: 3,
        last_update_at: NOW - 60,
        aborted: true,
        aborted_reason: '上一轮：坏了',
      }),
      aborts: [true],
    })
    expect(got.returned).toBe(false)
    // 停的理由是**这一次**的，不是上一次那句
    expect(got.progress.aborted_reason).toBe(USER_ABORT_TEXT)
    expect(got.calls).toEqual([])
  })
})

describe('中止与停机故意不通用', () => {
  it('停机是**一次性**的：读一次就消费掉', async () => {
    // 否则一个已经处理过的针尖事件会把这一次跑里后面每个计划都停掉——
    // 而修针 / 退针 / 停扫 正是那些计划。
    const got = await replay({ halts: ['', '', '第三次才停'] })
    expect(got.calls.map((c) => c.skill)).toEqual(['MoveToXY', 'GetBias'])
    expect(got.progress.aborted_reason).toBe('第三次才停')
  })

  it('停机必须是**一个字符串理由**：别的一律读成「没有停机」', async () => {
    // 一个自动生成的桩上下文否则会返回真值哨兵，把每个计划都停在第一步。
    for (const halts of [[{}, {}, {}], [null, null, null], [false, false, false]]) {
      const got = await replay({ halts })
      expect(got.returned).toBe(true)
      expect(got.calls).toHaveLength(3)
    }
  })

  it('中止查在停机**之前**', async () => {
    const got = await replay({ aborts: [true], halts: ['停机理由'] })
    expect(got.progress.aborted_reason).toBe(USER_ABORT_TEXT)
    expect(abortFacts(fromDict(got.progress)).aborted_by_operator).toBe(true)
  })
})

describe('失败的三条出路互不覆盖', () => {
  it('回调说「不」之后**还要看 optional**', async () => {
    const got = await replay({
      plan: [
        { stepId: 's1', skillName: 'GetBias', params: {}, optional: true },
        { stepId: 's2', skillName: 'StartScan', params: {} },
      ],
      results: FAIL,
      onStepFailed: () => false,
    })
    expect(got.returned).toBe(true)
    expect(got.progress.failed_steps).toEqual(['s1'])
  })

  it('回调放行一个**非 optional** 的步骤时，旁白里的 `continued` 是 true', async () => {
    const got = await replay({ results: FAIL, onStepFailed: () => true })
    const n = got.narrations.find((x) => x.kind === 'step_failed')!
    expect(n.data['continued']).toBe(true)
    // 所以它不能由 step.optional 推断——那一步的 optional 是 false
    expect(P3[1]!.optional).toBeUndefined()
  })

  it('回调抛异常 = 说「不」', async () => {
    expect((await replay({ results: FAIL, onStepFailed: boom })).returned).toBe(false)
  })

  it('技能写给人读的那句话（`data.detail`）要跟着失败旁白走', async () => {
    // 一步失败之后 subResults 不收它，于是这句带数字的话正好在出事的时候被丢掉。
    const got = await replay({ results: FAIL })
    expect(got.narrations.find((x) => x.kind === 'step_failed')!.data['detail']).toBe(
      '第 1 轮后残余 Z 占用 6.4 nm',
    )
    expect(got.sub_results).toEqual(['s1'])
  })

  it('中止那一支**不记** `failedSteps`', async () => {
    const got = await replay({ results: FAIL })
    expect(got.progress.failed_steps).toEqual([])
    expect(got.failed_reasons).toEqual({})
    expect(got.progress.aborted_reason).toBe('GetBias failed: rolled_back: diverged')
  })
})

describe('控制流不是失败', () => {
  it('子技能抛中止 ⇒ 组合记中止，**不走失败通道**', async () => {
    // 走失败通道的话上一层会把它当成一个失败的步骤并触发回滚——
    // 回滚一份中止根本没碰过的工作。
    const got = await replay({ results: { GetBias: new AbortRequested('x') } })
    expect(got.returned).toBe(false)
    expect(got.progress.aborted_reason).toBe('aborted by operator')
    expect(got.diags.some((d) => d.kind === 'step_fail')).toBe(false)
  })

  it('动态计划**从生成器里**中止也一样', async () => {
    const got = await replay({ plan: gen(P3, 1, new AbortRequested('轮询中中止')) })
    expect(got.returned).toBe(false)
    expect(got.progress.aborted_reason).toBe('aborted by operator')
  })

  it('生成器抛别的异常照样往外抛 —— 它不是一次「中止」', async () => {
    const got = await replay({ plan: gen(P3, 1, new ValueError('plan blew up')) })
    expect(got.raised).toBe('ValueError')
    expect(got.progress.aborted).toBe(false)
    // 断点留着：这次跑没结束，只是炸了
    expect(got.sidecar_after).not.toBeNull()
  })
})

describe('旁白', () => {
  it('查不到模板就**不发** —— 一次 ForgeAuTip 有几百个子步骤', async () => {
    const got = await replay({})
    expect(got.narrations.map((n) => n.kind)).toEqual(['move_xy', 'scan_start'])
    // GetBias 不在模板表里，于是它一句也没有
    expect(BEGIN['GetBias']).toBeUndefined()
  })

  it('句子里的参数就是**真正下发的那一份**', async () => {
    const got = await replay({})
    expect(got.narrations[0]!.data['params']).toEqual(got.calls[0]!.params)
  })

  it('发在动手**之前**：中止在第一步时，旁白一条也没有', async () => {
    expect((await replay({ aborts: [true] })).narrations).toEqual([])
  })
})

describe('回调与外设炸了都不许拖垮实验', () => {
  it('`onStepResult` 抛异常，这一步照样算成功', async () => {
    const got = await replay({ plan: [{ stepId: 's1', skillName: 'GetBias', params: {} }], onStepResult: boom })
    expect(got.returned).toBe(true)
    expect(got.progress.completed_steps).toEqual(['s1'])
  })

  it('台账、旁白、上报、检查点、断点 —— 任何一个抛都只丢它自己', async () => {
    const ex = new GraphExecutor('C', {
      now: () => NOW,
      run: () => ({}),
      diag: boom,
      narrate: boom,
      emitProgress: boom,
      checkpointFlush: boom,
      beginKindFor: () => 'move_xy',
      store: {
        load: boom,
        save: boom,
        clear: boom,
      },
    })
    await expect(ex.runPlan(P3)).resolves.toBe(true)
    expect(ex.progress.completedSteps).toEqual(['s1', 's2', 's3'])
  })

  it('`getProgress` 抛 ⇒ 当作没有既往进度', async () => {
    const ex = new GraphExecutor('C', {
      now: () => NOW,
      run: () => ({}),
      getProgress: boom,
    })
    expect(ex.progress.completedSteps).toEqual([])
  })

  it('`checkAbort` / `checkHalt` 抛 ⇒ 当作没停 —— 一个坏掉的检查不该停下工作', async () => {
    const ex = new GraphExecutor('C', {
      now: () => NOW,
      run: () => ({}),
      checkAbort: boom,
      checkHalt: boom,
    })
    await expect(ex.runPlan(P3)).resolves.toBe(true)
  })
})

describe('partial_data 的两个入口', () => {
  it('`setPartial` 每次都写，`setPartialDefault` 只在没有时写', () => {
    const ex = new GraphExecutor('C', { now: () => NOW, run: () => ({}) })
    ex.setPartial('nx', 4)
    ex.setPartial('nx', 5)
    expect(ex.progress.partialData['nx']).toBe(5)
    ex.setPartialDefault('succeeded', [])
    ex.setPartialDefault('succeeded', ['x'])
    // 累加器要保住续跑前的值
    expect(ex.progress.partialData['succeeded']).toEqual([])
  })

  it('`undefined` 也算「有」 —— 用 `in`，不是真值判断', () => {
    const ex = new GraphExecutor('C', { now: () => NOW, run: () => ({}) })
    ex.setPartial('k', undefined)
    ex.setPartialDefault('k', 'fallback')
    expect(ex.progress.partialData['k']).toBeUndefined()
  })
})

describe('公开的 abort 入口', () => {
  it('组合技能自己喊停，走同一条路', () => {
    const diags: GoldenDiag[] = []
    const ex = new GraphExecutor('C', {
      now: () => NOW,
      run: () => ({}),
      diag: (kind, subject, reason, fields) => diags.push({ kind, subject, reason, fields }),
    })
    ex.abort('前置条件不成立')
    expect(ex.progress.aborted).toBe(true)
    expect(diags).toEqual([
      {
        kind: 'step_abort',
        subject: 'C.?',
        reason: '前置条件不成立',
        fields: { completed: 0, failed: [], total: 0 },
      },
    ])
  })
})

function fromDict(d: ProgressDict): CompositeProgress {
  return progressFromDict(d as unknown as Record<string, unknown>, NOW)
}
