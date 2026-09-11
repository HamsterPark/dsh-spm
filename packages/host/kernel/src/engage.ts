/**
 * 「针尖到底进没进隧穿」—— 进针判定。
 *
 * 这个文件里的每一条判据都对应一次真机事故：
 *
 * | 日期 | 症状 | 判据 |
 * |---|---|---|
 * | 2026-07-10 #42 | 进针在 0.17 pA / 设定点 500 pA 上报了成功，agent 照样去扫图 | 要拿电流确认「停了」 |
 * | 2026-07-10 #75 | 「调低电流假装进到针了」 | {@link MIN_ENGAGED_CURRENT_A} 噪声底 |
 * | 2026-08-05 | 一次**成功的**进针被判成失败——那一读正好采到模块→反馈的**交接瞬态** | {@link settleEngagement}：两次一致才下结论 |
 * | 2026-08-05 | 报文点名「量程耗尽 / Z 在极限 / 外部停止」，三条当天全是假的，人被支去查一个好好的电机量程 | {@link EngageVerdict.evidence}：只印测到的 |
 * | 2026-08-08 | 7 次失败报文里**只有一个秒数**，所有人都把它读成进针时长，整晚查一个不存在的「秒停」 | {@link WaitProgress}：模块跑了多久 + 台子动没动 |
 * | 2026-08-15 | 状态位读不懂被当成「没在跑」 | {@link parseRunning} 三值 |
 */

/**
 * 进针电流的**绝对底线**。低于这个数的「电流」是放大器噪声，不是隧穿。
 *
 * 只相对设定点判进针是可以被**玩**的：把设定点调得足够低，噪声就「达到」了它
 * ——真机反馈 #75 的原话是「调低电流假装进到针了」。1 pA 安全地低于任何实用的 STM
 * 设定点，又远高于现场日志里看到的约 0.2 pA 噪声底。
 */
export const MIN_ENGAGED_CURRENT_A = 1e-12

/** 要几次**连续**一致的读数才下结论。 */
export const ENGAGE_AGREE_N = 2

/**
 * 那几次读数之间隔多久。
 *
 * 它必须**比反馈交接瞬态长**，否则两次采的是同一个瞬态、「互相印证」，那就回到了
 * 原点。1 s 比前置放大器带宽与反馈环自身响应高出几个数量级，同时相对判定预算又很小。
 */
export const ENGAGE_INTERVAL_S = 1.0

/** 证据里最多留几次最近的读数。一句失败报文不该是三屏浮点数。 */
export const KEEP_READS = 12

/**
 * 一次真实进针必须跨过的 |I|，算不出时返回 `null`。
 *
 * 两道线取高的那条：设定点的一半（反馈确实在调节）与绝对噪声底（于是调低设定点
 * 不能让放大器噪声冒充进针）。
 */
export function engagementBar(setpointA: number | null | undefined): number | null {
  if (setpointA === null || setpointA === undefined || setpointA === 0) return null
  return Math.max(0.5 * Math.abs(setpointA), MIN_ENGAGED_CURRENT_A)
}

/**
 * 隧穿电流有没有**稳定**落在判据线的一侧。
 *
 * `engaged` 有三个值，它们是**三件不同的事**：
 *
 * - `true` —— 稳定在线上。针尖在隧穿。
 * - `false` —— 稳定在线下。针尖没进针；这是一个**测出来的零**，不是一次缺失的测量。
 * - `null` —— 预算内读数始终没和自己一致（或者根本读不到）。**我们不知道。**
 *   调用方必须在这上面失败，但**绝不能**把它报成「没进针」——「没测出来」和
 *   「测出来是零」是两句话，把前者印成后者，正是 2026-08-05 那次把人支去看电机量程的原因。
 */
export interface EngageVerdict {
  engaged: boolean | null
  currentA: number | null
  setpointA: number | null
  barA: number | null
  /** 最近几次 |I|，最旧在前 —— 证据。上限 {@link KEEP_READS}。 */
  readsA: number[]
  /** 实际读了几次（`readsA` 可能只是它的尾巴）。 */
  totalReadsN: number
  /** 停下来之前有几次连续落在同一侧。 */
  agreedN: number
  elapsedS: number
  budgetS: number
  intervalS: number
  aborted: boolean
  /** 完全读不出电流／设定点的次数。 */
  unreadableN: number
}

export function newEngageVerdict(budgetS: number, intervalS: number): EngageVerdict {
  return {
    engaged: null,
    currentA: null,
    setpointA: null,
    barA: null,
    readsA: [],
    totalReadsN: 0,
    agreedN: 0,
    elapsedS: 0,
    budgetS,
    intervalS,
    aborted: false,
    unreadableN: 0,
  }
}

/** 安培值的人读形式（`'0.17 pA'` / `'0.50 nA'` / `'unreadable'`）。 */
export function fmtA(x: number | null | undefined): string {
  if (x === null || x === undefined) return 'unreadable'
  return Math.abs(x) >= 1e-9 ? `${(x / 1e-9).toFixed(2)} nA` : `${(x / 1e-12).toFixed(2)} pA`
}

/** 米值的人读形式（`'169.50 nm'` / `'3.42 µm'` / `'unreadable'`）。 */
export function fmtM(x: number | null | undefined): string {
  if (x === null || x === undefined) return 'unreadable'
  const ax = Math.abs(x)
  if (ax >= 1e-3) return `${(x / 1e-3).toFixed(2)} mm`
  if (ax >= 1e-6) return `${(x / 1e-6).toFixed(2)} µm`
  if (ax >= 1e-9) return `${(x / 1e-9).toFixed(2)} nm`
  return `${(x / 1e-12).toFixed(2)} pm`
}

/**
 * 测到的数字，**别的一概不印**。
 *
 * 这里以前站着的是一串**猜测**——「量程耗尽 / Z 在极限 / 状态过期」——这段代码
 * 一条都没有看过。2026-08-05 那天三条全是假的，而人被支去检查一个完全正常的电机量程。
 * 一个判决可以印它量到的东西；成因该留给真能观测到它们的人。
 */
export function engageEvidence(v: EngageVerdict): string {
  const reads = v.readsA.map((x) => fmtA(x)).join(', ') || '(无)'
  const bar = v.barA !== null ? fmtA(v.barA) : '无法计算(设定点读不到或为 0)'
  const scope =
    v.totalReadsN <= v.readsA.length
      ? '窗口内实测 |I| 依次为'
      : `窗口内共读 ${v.totalReadsN} 次,最近 ${v.readsA.length} 次 |I| 依次为`
  // 「电流判定窗口」而不是「等了」：这个秒数说的是**判电流**花了多久，而报文里曾经
  // 只有它一个秒数，于是 2026-08-08 所有人都把它读成了进针本身的时长（「1.0s」→
  // 「模块秒停」），整晚查一个不存在的故障。名字里带上它计的是什么，比在旁边加一句
  // 「这不是进针时长」更结实——后者会在下一次改写里被删掉。
  return (
    `判据 |I| ≥ ${bar}(= max(50%×设定点 ${fmtA(v.setpointA)}, ` +
    `噪声底 ${fmtA(MIN_ENGAGED_CURRENT_A)}));` +
    `${scope} [${reads}],` +
    `电流判定窗口 ${v.elapsedS.toFixed(1)}s / 判定预算 ${v.budgetS.toFixed(1)}s,` +
    `取样间隔 ${v.intervalS.toFixed(1)}s`
  )
}

export function engageVerdictToDict(v: EngageVerdict): Record<string, unknown> {
  return {
    engaged: v.engaged,
    measured_current_a: v.currentA,
    setpoint_a: v.setpointA,
    engagement_bar_a: v.barA,
    reads_a: [...v.readsA],
    total_reads_n: v.totalReadsN,
    agreed_n: v.agreedN,
    elapsed_s: round3(v.elapsedS),
    budget_s: v.budgetS,
    settle_interval_s: v.intervalS,
    aborted: v.aborted,
    unreadable_reads: v.unreadableN,
  }
}

/** Python `round(x, 3)` —— 银行家舍入。用在 `as_dict` 的两个秒数上。 */
export function round3(x: number): number {
  const scaled = x * 1000
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  let r: number
  if (diff > 0.5) r = floor + 1
  else if (diff < 0.5) r = floor
  else r = floor % 2 === 0 ? floor : floor + 1
  return r / 1000
}

export interface SettleDeps {
  /** 读一对 `(电流, 设定点)`。任一为 `null` 表示那一路没读到。**抛异常等于读不到**。 */
  readonly readPair: () => Promise<readonly [number | null, number | null]>
  /** 单调时钟，**秒**。 */
  readonly now: () => number
  readonly sleep: (seconds: number) => Promise<void>
  readonly checkAbort?: () => boolean
  readonly intervalS?: number
  readonly budgetS: number
  readonly agreeN?: number
}

/**
 * 从**互相一致**的读数判进针，绝不从单次瞬时采样判。
 *
 * ## 它替掉的那个缺陷（真机，2026-08-05）
 *
 * 老的检查在 AutoApproach 模块停下的**那一刻**读一次电流，和设定点的 50 % 比。
 * 那一刻正是模块交给 Z 反馈环的**交接点**——整个流程里电流唯一保证在途中的时刻。
 * 一次真正成功的进针被报成「模块停了但无隧穿电流…量程可能耗尽」，整个
 * `RelocateCoarseXY` 失败；而同一个隧道结几十秒后测到 **−46.6 pA**（设定点的 93 %，
 * σ ≈ 5 fA）。同一份代码 25 分钟前在同一台机器上通过过——它输在**一次读数的时机**上。
 *
 * 所以：轮询，只有当 `agreeN` 次**连续**、间隔大于瞬态的读数落在同一侧时才下结论。
 * 一次不一致**不是失败**——它的意思是「还没稳」，循环继续，直到预算用完。
 */
export async function settleEngagement(deps: SettleDeps): Promise<EngageVerdict> {
  const intervalS = deps.intervalS ?? ENGAGE_INTERVAL_S
  const agreeN = Math.max(2, Math.trunc(deps.agreeN ?? ENGAGE_AGREE_N))
  const out = newEngageVerdict(deps.budgetS, intervalS)
  const t0 = deps.now()
  let runSide: boolean | null = null
  let run = 0

  for (;;) {
    if (deps.checkAbort?.() === true) {
      out.aborted = true
      out.elapsedS = deps.now() - t0
      return out
    }

    let cur: number | null = null
    let sp: number | null = null
    try {
      ;[cur, sp] = await deps.readPair()
    } catch {
      // 读失败就是读不到。
      cur = null
      sp = null
    }
    out.elapsedS = deps.now() - t0

    const bar = engagementBar(sp)
    if (cur === null || bar === null) {
      // 读不到。它**打断**正在累积的连续计数——一个判决只能建立在真的取到的读数上，
      // 而一次没读到不是「上一次仍然成立」的证据。
      out.unreadableN += 1
      // 写成一条赋值：这两个游标是**一件事**（把正在累积的连续计数作废），
      // 分成两行的话，一条只改其中一个的变异会编得过、跑得通、而且看起来无害。
      ;[runSide, run] = [null, 0]
    } else {
      out.currentA = cur
      out.setpointA = sp
      out.barA = bar
      out.totalReadsN += 1
      out.readsA.push(Math.abs(cur))
      if (out.readsA.length > KEEP_READS) out.readsA.shift()
      const side = Math.abs(cur) >= bar
      if (side === runSide) run += 1
      else {
        runSide = side
        run = 1
      }
      out.agreedN = run
      if (run >= agreeN) {
        out.engaged = side
        return out
      }
    }

    if (out.elapsedS >= deps.budgetS) {
      // 始终没和自己一致。`engaged` 保持 `null` —— 见 {@link EngageVerdict}。
      return out
    }
    if (out.totalReadsN === 0 && out.unreadableN >= agreeN) {
      // 试了好几次，**一对都没解出来**。把预算耗完也不会让一个死掉的回读变成一个读数，
      // 而调用方现在就需要这个诊断——「读不到电流」和「这个结还在稳」是两种修法。
      return out
    }
    await deps.sleep(Math.min(intervalS, Math.max(0, deps.budgetS - out.elapsedS)))
  }
}

/**
 * 等待相自己的事实：**模块跑了多久**，以及**台子有没有在动**。
 *
 * ## 为什么必须有（真机 2026-08-08 夜）
 *
 * 那天晚上 7 次 AutoApproach 全部失败，报文每次都是同一句，里面**只有一个秒数**：
 * 「等了 1.0s / 预算 20.0s」。读的人——当班 agent、团队、用户——都把它读成
 * 「这趟进针只跑了 1 秒」，于是整晚在查「模块为什么秒停」：Motor Control 是不是没在跑、
 * 粗动电压够不够、压电是不是顶死了、TCP 起跑方式有没有问题。全都不是。
 *
 * 那 1.0 s 是**模块停下之后**判定电流花的时间，与进针跑了多久毫无关系。aux 序列记着
 * 真相：那 7 次分别跑了 **533 / 18 / 7 / 27 / 12 / 167 / 911 秒**，期间 Z 压电在
 * ±169.5 nm 之间满摆了上百个循环——粗动一直在推进，只是 4 K 下步长太短。
 *
 * 也就是说：报文里唯一那个秒数回答的**不是读它的人在问的那个问题**，而它给出的答案
 * 看上去完全合理。修法不是把那句话写得更小心（措辞级的修法掩盖机制级的缺陷），
 * 是把等待相自己的数字也放进去。
 *
 * ## 为什么进展信号取 Z，不取电流
 *
 * 4 K 下针尖离表面还远时电流恒在噪声底。拿电流判「有没有推进」，答案永远是「没有」
 * ——而那正是这次误诊的形状。啄木鸟进针的每个循环都会把 Z 从量程一端扫到另一端：
 * **Z 的总行程是这条流程里唯一一个在没有隧穿电流时仍然会动的量**。
 *
 * 所以 `zTravelM === 0` 是一个**有信息量**的读数：模块报着 running 而压电纹丝不动，
 * 那才叫「没动」。「在动只是慢」和「根本没动」必须是两句话。
 */
export class WaitProgress {
  pollsN = 0
  runningPollsN = 0
  /** 从**第一次**读到 running 到**最后一次**读到 running 的秒数。 */
  moduleRanS = 0
  /** 整个等待相花了多久（含判定前的轮询）。 */
  waitedS = 0
  zReadsN = 0
  zMinM: number | null = null
  zMaxM: number | null = null
  zTravelM = 0
  /** 读到停止、复读却又变回在跑的次数。 */
  statusFlapN = 0
  /**
   * **状态位读不懂**的次数。与「读到 0」分开记：循环对两者的处置一样（都往「可能停了」
   * 走），但事后查账时它们要做的事完全不同——一个是查仪器，一个是查 TCP / parser。
   * 合成一个数就再也分不开了。
   */
  statusUnreadableN = 0
  #firstRunningS: number | null = null
  #lastZ: number | null = null

  noteRunning(running: boolean, elapsedS: number): void {
    this.pollsN += 1
    this.waitedS = elapsedS
    if (!running) return
    this.runningPollsN += 1
    if (this.#firstRunningS === null) this.#firstRunningS = elapsedS
    this.moduleRanS = elapsedS - this.#firstRunningS
  }

  noteZ(zM: number | null | undefined): void {
    if (zM === null || zM === undefined) return
    if (this.#lastZ !== null) this.zTravelM += Math.abs(zM - this.#lastZ)
    this.#lastZ = zM
    this.zReadsN += 1
    this.zMinM = this.zMinM === null ? zM : Math.min(this.zMinM, zM)
    this.zMaxM = this.zMaxM === null ? zM : Math.max(this.zMaxM, zM)
  }

  get zSpanM(): number | null {
    if (this.zMinM === null || this.zMaxM === null) return null
    return this.zMaxM - this.zMinM
  }

  /**
   * ≈ 几个进退循环。一个循环 = 走一个来回 = 2 × 行程区间。
   *
   * 故意只给一个 `≈`：1 Hz 采样看一个 ~5 s 的循环够用来数，但不够精确到整数，
   * 而一个没有 ≈ 的循环数，读的人会拿它当刻度用。
   */
  get cyclesApprox(): number | null {
    const span = this.zSpanM
    if (!span || span <= 0) return null
    return this.zTravelM / (2.0 * span)
  }

  /** 一句话说清「模块跑了多久 + 台子动没动」。**永远说得出是哪一种。** */
  motionText(): string {
    const head =
      `模块实际运行 **${this.moduleRanS.toFixed(1)}s**` +
      `(共轮询 ${this.pollsN} 次,其中 ${this.runningPollsN} 次读到 running=1` +
      (this.statusFlapN ? `,另有 ${this.statusFlapN} 次读到停止但复读又在跑` : '') +
      (this.statusUnreadableN
        ? `,另有 ${this.statusUnreadableN} 次**状态位读不懂**(那不是「没在跑」,是没问出来)`
        : '') +
      ')'
    if (this.zReadsN === 0) {
      return `${head};这段时间**没读到 Z 压电位置**,粗动有没有推进无法判断。`
    }
    const span = this.zSpanM ?? 0
    if (this.zTravelM <= 0) {
      return (
        `${head};期间 Z 压电**纹丝不动**(采样 ${this.zReadsN} 次,` +
        `始终 ${fmtM(this.zMinM)})—— 模块报在跑,压电却没动。`
      )
    }
    const cyc = this.cyclesApprox
    const cycTxt = cyc !== null && cyc >= 1 ? `,≈${cyc.toFixed(0)} 个进退循环` : ''
    return (
      `${head};期间 Z 压电总行程 **${fmtM(this.zTravelM)}**` +
      `(区间 ${fmtM(this.zMinM)} … ${fmtM(this.zMaxM)},` +
      `摆幅 ${fmtM(span)}${cycTxt},采样 ${this.zReadsN} 次)` +
      ` —— **粗动确实在推进**。`
    )
  }

  toDict(): Record<string, unknown> {
    return {
      polls_n: this.pollsN,
      running_polls_n: this.runningPollsN,
      module_ran_s: round3(this.moduleRanS),
      waited_s: round3(this.waitedS),
      z_reads_n: this.zReadsN,
      z_min_m: this.zMinM,
      z_max_m: this.zMaxM,
      z_travel_m: this.zTravelM,
      z_cycles_approx: this.cyclesApprox,
      status_flap_n: this.statusFlapN,
      status_unreadable_n: this.statusUnreadableN,
    }
  }
}

/**
 * 进针**没被确认**的原因——只有测量，没有猜测。
 *
 * 这里原本印的是「量程耗尽 / Z 压电在极限 / 外部停止」，**每一次失败都印**。三条都没被
 * 观测过；2026-08-05 那天三条全是假的（Z 在 −220.9 nm，离任何限位都远得很），而人被支
 * 去检查一个完全正常的电机量程。一条点名它没测过的成因的报文不是诊断，是一条带行号的
 * 传闻。
 *
 * 排版上：**判决在前，证据在后**——「针尖没进隧穿、别扫图」是读的人第一眼要看到的，
 * 而「模块跑了多久 / 台子动没动」是紧跟其后的第一条证据，排在电流那条前面。
 */
export function engageFailureText(
  v: EngageVerdict,
  opts: { readonly stopped: boolean; readonly progress?: WaitProgress | null },
): string {
  const head = opts.stopped
    ? 'AutoApproach 模块已停止'
    : 'AutoApproach 在宽限窗口内始终报告未运行(启动可能被拒绝)'
  const motion = opts.progress ? opts.progress.motionText() : ''
  if (v.aborted) {
    return (
      `${head},进针判定被中止 —— **进针状态未知**,` +
      `不要按「已进针」继续。${motion}${engageEvidence(v)}`
    )
  }
  if (v.engaged === null) {
    return (
      `${head},但**判不出**有没有隧穿电流:预算耗尽前始终没有出现` +
      `${ENGAGE_AGREE_N} 次一致的读数` +
      (v.unreadableN ? `(其中 ${v.unreadableN} 次根本读不到电流/设定点)` : '') +
      `。${motion}${engageEvidence(v)}。**这不等于没进针**,也不等于进针了 —— ` +
      '读数一直在动。不要扫图;先看反馈是否合上、电流量程是否合适,' +
      '若本机反馈确实较慢,到设置页把「退针 Z 稳定预算」' +
      '(z_settle_timeout_s)调大。'
    )
  }
  return (
    `${head},且电流**稳定地**没有达到进针判据 —— 针尖未进入隧穿,` +
    `不要扫图。${motion}${engageEvidence(v)}。`
  )
}

/**
 * `AutoApproach_OnOffGet` 的状态位。
 *
 * **返回 `null` = 这个回包读不懂**，不是「模块没在跑」（2026-08-15 普查 A4）。
 *
 * 原来每条不认识的路都返回 false。最要命的一条是**空 body**——也就是上游解析失败的
 * 样子。`bool([])` 是 false，于是一次解析故障答出了一个具体的仪器状态。而这个位置
 * **已经在真机上静默报过一次「未在运行」**。
 *
 * ⚠️ 1-元组解包是一条**防御性**修复，不是一个已观测到的现场故障：这个库的数值数组
 * 字段回的是一串 1-元组，而 `bool((0,))` 是 **true** —— 一个「已停止」的回包会被读成
 * 「还在跑」。它比读不懂更坏：读不懂至少长得可疑，这个看起来完全正常，只是答反了。
 * `OnOffGet` 的声明类型是标量，所以这三行防的是一个**推断出来的**形状。留着它的理由
 * 是代价不对称：多解一层的成本是三行，而万一它真的来了，代价是「一次已停止的进针被
 * 读成还在跑」，那条路上的下一步是配扫描或者再发一次进针。
 */
export function parseRunning(body: unknown): boolean | null {
  let inner: unknown = body
  // 再解两层：`[[0]]` / `[(0,)]` 都要解到那个标量。空 = 上游没解出来 ⇒ 读不懂。
  for (let i = 0; i < 2; i += 1) {
    if (!Array.isArray(inner)) break
    if (inner.length === 0) return null
    inner = inner[0]
  }
  if (typeof inner === 'boolean') return inner
  if (typeof inner === 'number') return Number.isNaN(inner) ? null : inner !== 0
  if (typeof inner === 'bigint') return inner !== 0n
  if (typeof inner === 'string') {
    const n = Number.parseInt(inner.trim(), 10)
    return Number.isNaN(n) ? null : n !== 0
  }
  return null
}
