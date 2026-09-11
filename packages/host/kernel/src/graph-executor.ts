/**
 * 组合技能的执行器 —— 走计划、报进度、支持续跑。
 *
 * 这是**四次真机事故的现场**，四条守卫全部长在「恢复」这条路径上：
 *
 * | 日期 | 症状 | 守卫 |
 * |---|---|---|
 * | 2026-07-10 | AutoApproach 假进针（#42/#75） | {@link isTerminal} |
 * | 2026-07-27 | BatchRegionsScan 五个 region 各 0.37 s「扫完」，`success_count=5` | {@link isTerminal} 的**第二个入口** |
 * | 2026-08-12 | ForgeAuTip 的 `finalize` 被跳过 | 跑完删掉自己的断点 |
 * | 2026-08-23 | 「重试」静默变成「重放」，用时 0.0 分钟、error 一字不差 | {@link dropStaleAbort} |
 *
 * 四条都只在**出事那天**才被走到 —— 顺利的时候它们一行都不执行。所以判据是一份
 * 网格金样（`spec/golden/graph_executor.json`，驱动旧仓真执行器录得），而不是
 * 几个手挑的点。
 *
 * ## 内核零 I/O 怎么装 sidecar
 *
 * 旧仓的 sidecar 是 `experiments/composite_progress/<name>__<run_id>.json`，
 * 断点真源。内核不许碰盘，所以它在这里是一个**注入的口子**
 * （{@link ProgressStore}）：走什么介质由宿主决定，而**什么时候读、什么时候写、
 * 什么时候丢**这四条判据留在这里 —— 它们才是出过事的那部分。
 *
 * 口子是**同步**的：旧仓那份是 `readFileSync` 级别的小 JSON，而构造函数要在返回
 * 之前把断点定下来（否则「有没有恢复」这件事会有一个 await 宽的窗口）。宿主要异步
 * 介质的话，自己在构造前读好、传一份内存快照进来。
 *
 * ## 与旧仓的差异
 *
 * - **LangGraph 的 `GraphInterrupt` 没有对应物**（D-GRAPH-1）。旧仓那条
 *   `_is_graph_interrupt(exc) → raise` 是给 HITL 图节点暂停用的；dsh 没有图，
 *   一个永远为假的分支写出来只会让人以为有人在守它。
 * - **结论类旁白 `_narrate_step_result` 不移植**（D-GRAPH-2）：它要
 *   `mast.vision.cluster_panel.render_cluster_panel` 落一张 PNG，视觉链路本仓
 *   还没有。开始与失败两条旁白照移 —— 它们是纯的，而且承担「句子里的电压等于真正
 *   下发的电压」那条性质。
 */

/** 断点的可续跑窗口。超过这么久的断点不再续跑 —— 从头来。 */
export const SIDECAR_RESUME_WINDOW_S = 30 * 60.0

/**
 * 中止闩被扳时呈现给人的那句话。
 *
 * 2026-07-28 #46：没人碰过的一次跑被连着三次报成「用户中止」，而 agent 也被这么
 * 告知，于是它一遍遍重试一次**坏针尖**停掉的扫描。只有中止闩（恰好两个设置者：
 * 用户的中止按钮与 E_STOP）才配得上这句话，其余理由一律原样透出。
 */
export const USER_ABORT_TEXT = 'aborted by user'

/** 老版本闩留在断点文件里的哨兵值 —— 读到它按「用户中止」翻译。 */
export const ABORT_LATCH_REASON = 'external abort flag before step'

/** 计划里的一步。 */
export interface CompositeStep {
  readonly stepId: string
  readonly skillName: string
  readonly params: Readonly<Record<string, unknown>>
  /** 失败了继续往下走（默认 false = 失败即中止）。 */
  readonly optional?: boolean
  /** 这一步成功之后驱动一次检查点落盘（默认 true）。 */
  readonly checkpointAfter?: boolean
  readonly tags?: readonly string[]
  /** 钉版本；给出时按三参调用 `run`。 */
  readonly skillVersion?: string | null
}

/** 进度快照。**全部字段都必须是 JSON 能表达的** —— 它要过检查点。 */
export interface CompositeProgress {
  compositeName: string
  totalSteps: number
  completedSteps: string[]
  failedSteps: string[]
  /**
   * step_id → 那一步失败的原因原文。
   *
   * 2026-08-12 补。在此之前 `failedSteps` 里**只有 step_id**，于是一个
   * `optional: true` 的步骤（语义正是「失败由调用方自己处理」）把失败交给了一个
   * **看不见原因**的调用方。真机第一次完整 ForgeAuTip 报的是「粗动换位失败（计划：
   * 沿 x+ 走 301 步…）」—— 那是**打算做什么**，不是**为什么没做成**。
   *
   * ⚠️ 它**不进** {@link progressToDict} —— 旧仓的 `to_dict` 就没有它。这是持久化
   * 面的真实形状，不是遗漏：跨进程续跑读不回失败原因。
   */
  failedReasons: Record<string, string>
  currentStep: string | null
  partialData: Record<string, unknown>
  startedAt: number
  lastUpdateAt: number
  aborted: boolean
  abortedReason: string
}

/** 进度的持久化形态（旧仓 `to_dict` 的键名，下划线）。 */
export interface ProgressDict {
  composite_name: string
  total_steps: number
  completed_steps: string[]
  failed_steps: string[]
  current_step: string | null
  partial_data: Record<string, unknown>
  started_at: number
  last_update_at: number
  aborted: boolean
  aborted_reason: string
}

export function newProgress(compositeName: string, now: number): CompositeProgress {
  return {
    compositeName,
    totalSteps: 0,
    completedSteps: [],
    failedSteps: [],
    failedReasons: {},
    currentStep: null,
    partialData: {},
    startedAt: now,
    lastUpdateAt: now,
    aborted: false,
    abortedReason: '',
  }
}

export function progressToDict(p: CompositeProgress): ProgressDict {
  return {
    composite_name: p.compositeName,
    total_steps: p.totalSteps,
    completed_steps: [...p.completedSteps],
    failed_steps: [...p.failedSteps],
    current_step: p.currentStep,
    partial_data: { ...p.partialData },
    started_at: p.startedAt,
    last_update_at: p.lastUpdateAt,
    aborted: p.aborted,
    aborted_reason: p.abortedReason,
  }
}

/** 宽容地还原一份进度 —— 磁盘上的东西可能是任何一版写的。 */
export function progressFromDict(
  d: Readonly<Record<string, unknown>>,
  now: number,
): CompositeProgress {
  const num = (v: unknown, dflt: number): number => {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && Number.isFinite(n) ? n : dflt
  }
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])
  const partial = d['partial_data']
  return {
    compositeName: typeof d['composite_name'] === 'string' ? d['composite_name'] : '',
    // Python 是 `int(...)` —— 截断，不是四舍五入
    totalSteps: Math.trunc(num(d['total_steps'], 0)),
    completedSteps: arr(d['completed_steps']),
    failedSteps: arr(d['failed_steps']),
    failedReasons: {},
    currentStep: typeof d['current_step'] === 'string' ? d['current_step'] : null,
    partialData:
      typeof partial === 'object' && partial !== null && !Array.isArray(partial)
        ? { ...(partial as Record<string, unknown>) }
        : {},
    startedAt: num(d['started_at'], now),
    lastUpdateAt: num(d['last_update_at'], now),
    aborted: Boolean(d['aborted']),
    // Python 的 `str(7)` 是 "7"，不是丢掉
    abortedReason: d['aborted_reason'] === undefined ? '' : String(d['aborted_reason']),
  }
}

/**
 * 这份既往进度描述的是一次**跑完了**的运行，不是一次被打断的。
 *
 * 恢复的语义是「中断 → 用户决定 → 接着跑」。一份每一步都完成的快照不是中断，是一次
 * **清理没做干净**的完成 —— 拿它当起点会把整个计划跳掉，而外面看到的是一次数字完全
 * 正常的成功。
 *
 * `totalSteps > 0` 是分母：流式组合（步数事先不知道）在跑完前可能是 0，那时
 * **不判 terminal** —— 宁可多恢复一次，也不要把一次真正的中断续跑判死。
 *
 * 有名字是因为它有**两个调用点**（断点一个、上下文一个），而这两处以前只有一处有
 * 它 ——「同一个坑的两个入口只堵了一个」正是这么来的。
 */
export function isTerminal(p: Pick<CompositeProgress, 'totalSteps' | 'completedSteps'>): boolean {
  const total = Math.trunc(p.totalSteps || 0)
  const done = p.completedSteps?.length ?? 0
  return total > 0 && done >= total
}

/**
 * 恢复既往进度时**丢掉上一次的中止状态**。返回它是否真的清掉了什么。
 *
 * `aborted` / `abortedReason` 是持久化的，而它们描述的是**上一次调用被停在哪儿**，
 * 不是「这个组合从此不许跑」。不清掉的话：上一轮中止过 ⇒ 恢复窗口内再调 ⇒ 起手就
 * 带着 `aborted = true` ⇒ 每一步都被跳过 ⇒ **秒回上一轮那句 error**。
 *
 * 真机症状（2026-08-23，用户报的第 4 条）：摆正配置后重跑，回包**用时 0.0 分钟**、
 * `error` 字段**一字不差**还是上一轮那句 —— 根本没跑。一次「重试」在无人值守里静默
 * 变成了「**重放**」，而重放的结论看起来和真跑一模一样。
 *
 * ⚠️ 这**不会**削弱用户的中止。活的中止走 `checkAbort()`（每一步独立回调），它根本
 * 不读 `progress.aborted`。按着中止按钮的话下一步照样停 —— 而停的理由会是**这一次**
 * 的，不是上一次的。
 */
export function dropStaleAbort(p: CompositeProgress): boolean {
  if (!p.aborted) return false
  p.aborted = false
  p.abortedReason = ''
  return true
}

/**
 * 一次早停的组合该报给人的那句话 —— **为什么**停的。
 *
 * `aborted` 有不止一个设置者：用户的中止与 E_STOP 会设，一次 CRITICAL 停机会设，
 * 一个必要步骤失败也会设。每个手写的 `run_composite` 都把它们翻译成同一句
 * "aborted by user"，把已经握着真实原因的 `abortedReason` 丢掉了。
 *
 * ⚠️ 它**不看 `aborted`**：传一份没中止的进度进来照样得到 "aborted by user"。判
 * 「有没有停」用 {@link abortFacts}，这里只回答「停的话怎么说」。
 */
export function abortErrorText(p: Pick<CompositeProgress, 'abortedReason'>): string {
  const reason = (p.abortedReason || '').trim()
  if (!reason || reason === ABORT_LATCH_REASON) return USER_ABORT_TEXT
  return reason
}

/** {@link abortErrorText} 的**机器可读**版本 —— 下游用它判「谁停的」。 */
export interface AbortFacts {
  readonly aborted: boolean
  /**
   * 只在**中止闩**被扳时为真。CRITICAL 停机与必要步骤失败也让 `aborted` 为真，
   * 但**没有人喊过停**。
   */
  readonly aborted_by_operator: boolean
  readonly abort_reason: string
}

/**
 * 「用户喊停」和「跑失败了」是两句话：前者不该触发重试、不该记成故障，后者该。
 *
 * 下游要判这件事就得去猜 {@link abortErrorText} 的措辞 —— 而那正是 #46 的翻版
 * （判据落在措辞上，措辞一改就失效）。
 */
export function abortFacts(p: Pick<CompositeProgress, 'aborted' | 'abortedReason'>): AbortFacts {
  const aborted = Boolean(p.aborted)
  const reason = (p.abortedReason || '').trim()
  const byOperator =
    aborted && (!reason || reason === ABORT_LATCH_REASON || reason === USER_ABORT_TEXT)
  return {
    aborted,
    aborted_by_operator: byOperator,
    abort_reason: aborted ? abortErrorText(p) : '',
  }
}

/**
 * 操作员中止 —— **控制流，不是失败**。
 *
 * 从子技能里抛出来的中止如果走失败通道，上一层会把它当成一个失败的步骤并触发
 * **回滚** —— 回滚一份中止根本没碰过的工作。
 */
export class AbortRequested extends Error {
  override readonly name = 'AbortRequested'
}

/** 子技能的返回值。执行器只看这三样。 */
export interface StepResult {
  readonly success?: boolean
  readonly error?: string
  readonly data?: Readonly<Record<string, unknown>> | null
}

/** 断点介质。**同步** —— 见模块抬头。 */
export interface ProgressStore {
  load(): Readonly<Record<string, unknown>> | null
  save(d: ProgressDict): void
  clear(): void
}

export interface GraphExecutorDeps {
  /** 跑一个子技能。 */
  readonly run: (
    skillName: string,
    params: Readonly<Record<string, unknown>>,
    version?: string,
  ) => StepResult | Promise<StepResult>
  readonly now: () => number
  readonly store?: ProgressStore | null
  /** 上下文里的既往进度（检查点那一路）。 */
  readonly getProgress?: (compositeName: string) => unknown
  /** 中止闩。真为「别开新的」。 */
  readonly checkAbort?: () => boolean
  /**
   * 本次跑的一次性停机理由。**读一次就消费掉** —— 一个已经处理过的针尖事件不该把
   * 这一次跑里后面每个计划都停掉。
   */
  readonly checkHalt?: () => unknown
  readonly emitProgress?: (p: CompositeProgress) => void
  readonly checkpointFlush?: () => void
  /** 拒绝台账。丢一条不许让一次跑付出代价。 */
  readonly diag?: (
    kind: string,
    subject: string,
    reason: string,
    fields: Record<string, unknown>,
  ) => void
  /** 旁白（说给人听，agent 看不见）。 */
  readonly narrate?: (kind: string, data: Record<string, unknown>) => void
  /** 技能名 → 开场旁白模板码。查不到就**不发**。 */
  readonly beginKindFor?: (skillName: string) => string | undefined
  readonly onStepResult?: (step: CompositeStep, result: StepResult) => void
  /**
   * 返回 true 放行（当作 optional），false 中止。**它也能放行一个非 optional 的
   * 步骤** —— 所以「这次跑还在不在跑」不能由 `step.optional` 推断。
   */
  readonly onStepFailed?: (step: CompositeStep, msg: string) => boolean
}

export type PlanSource = Iterable<CompositeStep> | AsyncIterable<CompositeStep>

export class GraphExecutor {
  readonly #name: string
  readonly #d: GraphExecutorDeps
  #progress: CompositeProgress
  readonly #subResults = new Map<string, StepResult>()

  constructor(compositeName: string, deps: GraphExecutorDeps) {
    this.#name = compositeName
    this.#d = deps
    this.#progress = this.#loadOrInit()
    // 同一个坑的**两个入口**：既往进度可以从上下文来，也可以从断点来，两条路都会
    // 还原 `aborted`。只堵一个等于没堵。
    dropStaleAbort(this.#progress)
    this.#adoptSidecar()
  }

  get progress(): CompositeProgress {
    return this.#progress
  }

  get subResults(): ReadonlyMap<string, StepResult> {
    return this.#subResults
  }

  isCompleted(stepId: string): boolean {
    return this.#progress.completedSteps.includes(stepId)
  }

  /** 给进度条的提示。执行器自己也会随步数往上抬，所以这里只取较大者。 */
  setTotalSteps(n: number): void {
    this.#progress.totalSteps = Math.max(this.#progress.totalSteps, Math.trunc(n))
  }

  setPartial(key: string, value: unknown): void {
    this.#progress.partialData[key] = value
    this.#progress.lastUpdateAt = this.#d.now()
  }

  /**
   * 只在这个键还没有的时候设。给**累加器**用（`succeeded` / `failed` /
   * `quality_history` —— 续跑时要保住上一轮的值）；随本次调用变的**参数**
   * （`nx` / `ny` / `spacing_m`）走 {@link setPartial}。
   */
  setPartialDefault(key: string, value: unknown): void {
    if (!(key in this.#progress.partialData)) this.setPartial(key, value)
  }

  abort(reason: string): void {
    this.#abort(reason)
  }

  /** 走完整个计划。返回 true 当且仅当没有中止。 */
  async runPlan(plan: PlanSource): Promise<boolean> {
    let stepsSeen = 0
    const it = this.#iterator(plan)
    for (;;) {
      let step: CompositeStep
      try {
        const nx = await it.next()
        if (nx.done === true) break
        step = nx.value
      } catch (exc) {
        // 动态计划把**计划体**跑在生成器里，于是它能从里面中止（ConditionTip 的
        // 等扫描助手就在轮询时抛中止）。那是**控制流**，不是步骤失败：让它逃出
        // `runPlan` 会一路上到技能的通用 catch，触发一次**回滚** —— 回滚一份中止
        // 根本没碰过的工作。
        if (exc instanceof AbortRequested) {
          this.#abort('aborted by operator')
          return false
        }
        throw exc
      }
      stepsSeen += 1

      if (this.isCompleted(step.stepId)) {
        // 一个**被跳过**的步骤和一个跑过且成功的步骤，从外面看一模一样 —— 这正是
        // 「在做 STS 第五点的时候停下来了」（#90）没法诊断的原因。如果一份过期断点
        // 让执行器跳掉前几个点，组合会**从中间开始**，而用户看到的是它「提前停」。
        // 跳步是一个**决定**，写下来。
        this.#diag('step_skip', step.stepId, '已完成（从 sidecar 断点恢复）——本次未执行', {
          skill: step.skillName,
          ordinal: stepsSeen,
          completed: this.#progress.completedSteps.length,
        })
        continue
      }

      if (this.#checkAbort()) {
        this.#abort(USER_ABORT_TEXT)
        return false
      }

      // 停机与中止**故意不通用**。中止是一道闩，它让每一个新的仪器动作都被拒 ——
      // 拿它来处理一个坏针尖会把 修针 / 退针 / 停扫 一起挡掉，也就是把仪器挡在它
      // 自己的补救之外。停机是一次性的、只作用于这一次跑：它在这里停掉这个计划，
      // 别的什么都不改。
      const halt = this.#checkHalt()
      if (halt) {
        this.#abort(halt)
        return false
      }

      this.#progress.currentStep = step.stepId
      this.#progress.lastUpdateAt = this.#d.now()

      // 旁白发在动手**之前**。现场要的措辞是未来时的「**即将**打 10 V 500 ms
      // 脉冲」—— 价值在于用户在脉冲落下之前就知道要发生什么；跑完再说「刚才打了」
      // 是另一件事，而且对一个 3 分钟的步骤来说太晚了。
      this.#narrateBegin(step)

      let result: StepResult
      try {
        const v = step.skillVersion
        result = await (v
          ? this.#d.run(step.skillName, step.params, v)
          : this.#d.run(step.skillName, step.params))
      } catch (exc) {
        if (exc instanceof AbortRequested) {
          this.#abort('aborted by operator')
          return false
        }
        const msg = `${step.skillName} raised ${errName(exc)}: ${errText(exc)}`
        if (!this.#handleFailure(step, msg, '')) return false
        continue
      }

      if (result?.success === false) {
        const err = result.error || '(no error message)'
        // ⚠️ `error` 是**短码**（"rolled_back: diverged"），而技能写给人读的那句带
        // 数字的话在 `data.detail` 里（"第 1 轮后残余 Z 占用 6.4 nm"）。一步失败之后
        // `subResults` 不收它，于是**技能说得最清楚的那句话，正好在出事的时候被
        // 丢掉**。走显式形参，不走一个临时字段：后者等于给失败处理加了一个看不见的
        // 入参，而另一条调用路读到的会是上一次留下来的值。
        const detail = String(result.data?.['detail'] ?? '')
        if (!this.#handleFailure(step, `${step.skillName} failed: ${err}`, detail)) return false
        continue
      }

      this.#subResults.set(step.stepId, result)
      this.#progress.completedSteps.push(step.stepId)
      if (this.#d.onStepResult) {
        try {
          this.#d.onStepResult(step, result)
        } catch {
          /* 回调炸了不许拖垮正在跑的实验 */
        }
      }
      this.#emitProgress()
      if (step.checkpointAfter !== false) this.#checkpointFlush()
    }

    this.#progress.totalSteps = Math.max(this.#progress.totalSteps, stepsSeen)
    this.#progress.currentStep = null
    this.#emitProgress()
    // 落下这个**现在才知道**的步数：terminal 判据拿 `totalSteps > 0` 当分母，而流式
    // 组合（步数事先不知道）在此之前留下的断点**永远不可能被认出是跑完的**，只可能
    // 被认成被打断的。2026-07-27 就是这么来的：一次 BatchRegionsScan 里所有 region
    // 共用一个 run_id 因而共用一份断点，region 0 扫了 105.6 s 留下 211 步、
    // total_steps == 0 的断点，region 1..4「续跑」时把 WaitScanComplete 整个跳过，
    // 0.37/0.38/0.38/0.22 s 就回来了 —— 而组合报的是 success_count=5、fail_count=0、
    // 五个不同的 .sxm 路径，还从这些假 region 里推荐了一个「最好的」。
    if (this.#d.store && !this.#progress.aborted) {
      this.#flushSidecar()
      // ⭐ 跑完（未中止）删掉自己的断点 ——**同一次运行里的下一次调用不该捡到它**。
      //
      // 2026-08-12 查实：清理这件事**从来没做过**，整套 terminal/stale 守卫建立在
      // 一个**不存在的清理**之上，而注释让每个读到它的人相信它存在。那天是这个失败
      // 模式第三次出货。
      //
      // 为什么修这里而不是收紧读端判据（两条都试过，都不对）：
      //  * 「totalSteps == 0 就丢弃」会毁掉**真正被打断**的流式续跑 —— 那会重放硬件
      //    动作，并把用户已经答过的问题再问一遍；
      //  * 「要求 run_id」什么也拦不住 —— 真机断点本来就带 run_id。
      // 真正缺的就是**跑完把自己的记录删掉**：被打断的调用走不到这里，它的断点照常
      // 留着续跑；跑完的调用不再给下一次留下一份假进度。
      this.#clearSidecar()
    }
    return !this.#progress.aborted
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  #iterator(plan: PlanSource): AsyncIterator<CompositeStep> | Iterator<CompositeStep> {
    const a = (plan as AsyncIterable<CompositeStep>)[Symbol.asyncIterator]
    if (typeof a === 'function') return a.call(plan)
    return (plan as Iterable<CompositeStep>)[Symbol.iterator]()
  }

  #loadOrInit(): CompositeProgress {
    const now = this.#d.now()
    const get = this.#d.getProgress
    if (!get) return newProgress(this.#name, now)
    let prior: unknown
    try {
      prior = get(this.#name)
    } catch {
      prior = null
    }
    let p: CompositeProgress
    if (isProgress(prior)) {
      p = prior
    } else if (
      typeof prior === 'object' &&
      prior !== null &&
      !Array.isArray(prior) &&
      Object.keys(prior).length > 0
    ) {
      p = progressFromDict(prior as Record<string, unknown>, now)
    } else {
      return newProgress(this.#name, now)
    }
    if (isTerminal(p)) {
      this.#d.diag?.(
        'progress_discard',
        this.#name,
        '上下文里的既往进度是**跑完了的**——本次从头跑,不跳步(跳步 = 零仪器调用的假成功)',
        { completed: p.completedSteps.length, total: p.totalSteps },
      )
      return newProgress(this.#name, now)
    }
    return p
  }

  #adoptSidecar(): void {
    const store = this.#d.store
    if (!store) return
    try {
      const raw = store.load()
      if (raw === null || raw === undefined) return
      const side = progressFromDict(raw, this.#d.now())
      // **比手上这份更远**才值得采纳。相等也不采纳：那不是新信息。
      if (side.completedSteps.length <= this.#progress.completedSteps.length) return
      const age = Math.max(0, this.#d.now() - (side.lastUpdateAt || 0))
      if (isTerminal(side) || age > SIDECAR_RESUME_WINDOW_S) {
        store.clear()
        return
      }
      dropStaleAbort(side)
      this.#progress = side
    } catch {
      /* 断点不许挡住一次跑 */
    }
  }

  #diag(kind: string, stepId: string, reason: string, fields: Record<string, unknown>): void {
    try {
      this.#d.diag?.(kind, `${this.#name}.${stepId}`, reason, fields)
    } catch {
      /* 丢一条台账不许让一次跑付出代价 */
    }
  }

  #narrate(kind: string, data: Record<string, unknown>): void {
    try {
      this.#d.narrate?.(kind, data)
    } catch {
      /* 旁白链路出任何事都只能丢一条旁白 */
    }
  }

  /**
   * 只对**查得到模板**的技能说。查不到就**不发**，不是发一句通用的「正在执行某个
   * 步骤」：后者既没有信息量，又会把真正有信息量的那几条淹掉。一次 ForgeAuTip 有
   * 几百个子步骤。
   *
   * 「句子里的电压等于真正下发的电压」成立的原因在这里：交出去的 `params` 就是下面
   * 送进子技能的**同一份**，中间没有任何人有机会改写它。
   */
  #narrateBegin(step: CompositeStep): void {
    const kind = this.#d.beginKindFor?.(step.skillName)
    if (!kind) return
    this.#narrate(kind, {
      skill: step.skillName,
      step_id: step.stepId,
      composite: this.#name,
      params: step.params,
    })
  }

  /** 返回 true 继续，false 中止。 */
  #handleFailure(step: CompositeStep, msg: string, detail: string): boolean {
    const cont = ((): boolean => {
      if (!this.#d.onStepFailed) return false
      try {
        return Boolean(this.#d.onStepFailed(step, msg))
      } catch {
        return false
      }
    })()
    // ⚠️ 回调说「不」之后**还要看 `optional`** —— 两条放行路互不覆盖。
    if (cont || step.optional === true) {
      this.#progress.failedSteps.push(step.stepId)
      this.#progress.failedReasons[step.stepId] = msg || ''
      this.#diag('step_fail', step.stepId, msg, {
        skill: step.skillName,
        continued: true,
        ...(cont ? {} : { optional: true }),
      })
      this.#narrateFailure(step, msg, true, detail)
      this.#emitProgress()
      return true
    }
    // 中止那一支**不记** `failedSteps` / `failedReasons` —— 与旧仓一致：那一步的
    // 原因已经成了整个组合的 `abortedReason`。
    this.#diag('step_fail', step.stepId, msg, { skill: step.skillName, continued: false })
    this.#narrateFailure(step, msg, false, detail)
    this.#abort(msg)
    return false
  }

  /**
   * `continued` 是用户看到「没成」之后要知道的第一件事：**这次跑还在不在跑**。它由
   * 上面那三条出路各自决定，不由 `step.optional` 推断 —— 回调也能放行一个非 optional
   * 的步骤。
   */
  #narrateFailure(step: CompositeStep, msg: string, continued: boolean, detail: string): void {
    this.#narrate('step_failed', {
      skill: step.skillName,
      step_id: step.stepId,
      composite: this.#name,
      reason: msg,
      continued,
      detail,
    })
  }

  #abort(reason: string): void {
    this.#progress.aborted = true
    this.#progress.abortedReason = reason
    this.#progress.lastUpdateAt = this.#d.now()
    // 停在**哪一步**、为什么。「组合停了」加一句光秃秃的理由，正是 #90 没法诊断的
    // 原因 —— 用户看得见它停在第 5 点，而没人说得出第 5 点是跑了、跳了、还是没到。
    this.#diag('step_abort', this.#progress.currentStep || '?', reason, {
      completed: this.#progress.completedSteps.length,
      failed: [...this.#progress.failedSteps],
      total: this.#progress.totalSteps,
    })
    this.#emitProgress()
  }

  #checkAbort(): boolean {
    if (!this.#d.checkAbort) return false
    try {
      return Boolean(this.#d.checkAbort())
    } catch {
      return false
    }
  }

  /**
   * 一个待处理的停机理由，或 `""`。
   *
   * 停机必须是一个**理由**，而只有真的字符串才算。别的一律读成「没有停机」——
   * 一个自动生成的桩上下文否则会返回一个真值哨兵，把每个计划都停在第一步。
   */
  #checkHalt(): string {
    if (!this.#d.checkHalt) return ''
    let reason: unknown
    try {
      reason = this.#d.checkHalt()
    } catch {
      return ''
    }
    return typeof reason === 'string' ? reason : ''
  }

  #emitProgress(): void {
    // 断点**就是**步级持久化的真源 —— 每一拍都落。
    this.#flushSidecar()
    if (!this.#d.emitProgress) return
    try {
      this.#d.emitProgress(this.#progress)
    } catch {
      /* 上报炸了不许拖垮实验 */
    }
  }

  #flushSidecar(): void {
    if (!this.#d.store) return
    try {
      this.#d.store.save(progressToDict(this.#progress))
    } catch {
      /* 落盘失败不许挡住一次跑 */
    }
  }

  #clearSidecar(): void {
    if (!this.#d.store) return
    try {
      this.#d.store.clear()
    } catch {
      /* 清理失败不许把一次已经跑完的运行变成一次失败 */
    }
  }

  #checkpointFlush(): void {
    if (!this.#d.checkpointFlush) return
    try {
      this.#d.checkpointFlush()
    } catch {
      /* 同上 */
    }
  }
}

function isProgress(v: unknown): v is CompositeProgress {
  return typeof v === 'object' && v !== null && 'compositeName' in v && 'completedSteps' in v
}

function errName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
