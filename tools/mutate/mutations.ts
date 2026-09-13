/**
 * 变异清单——**每一道闸一条**。
 *
 * 这一层要回答的问题不是「闸门写了吗」，是「闸门**在挡**吗」。两者的区别在
 * diff 里看不出来：一个被注释掉的判断、一个永远为假的条件、一个 return 提前了
 * 三行，看起来都像正常代码。唯一能分辨的办法是**把它拆掉，看测试红不红**。
 *
 * ## 为什么是源码级替换，不是 `MAST_MUTATE=<gate>` 环境变量
 *
 * PLAN §8.4 原本写的是运行期开关。做到一半意识到那意味着**发布出去的代码里带着
 * 一个能关掉安全闸的环境变量**——而这台仪器上「设一次调试用、然后忘了取消」
 * 是完全现实的事。TS 不做基于 env 的死代码消除，插件是以 JS 形态装进 profile 的，
 * 所以那个开关会一直活在真机的运行时里。
 *
 * 源码级替换给的保证一模一样（三判据全在），而**生产代码一个字都不变**。
 * 代价是每条变异要重新构建一次，慢。慢是可以接受的：这套东西一天跑一次，
 * 而那个环境变量要在真机上活一辈子。
 *
 * ## 三判据（缺一条，「没变红」和「压根没验」就长得一模一样）
 *
 * 1. **变异落地**：替换串在文件里唯一命中，且改完能 grep 到新串；
 * 2. **构建通过**：`tsc -b` 退出码为 0 —— 编译不过的变异不算数；
 * 3. **测试确实跑了**，且**跑的范围包含被变异的文件** —— 这一条是 2.12 当场撞出来的，
 *    脚本当时写死了只跑 kernel，而变异在另一个包里，于是两条演练「绿」得毫无意义。
 */
export interface Mutation {
  /** 稳定 id，报告与 CI 都按它索引。 */
  readonly id: string
  /** 这道闸挡的是什么。拆掉它，系统就会重新犯哪一次错。 */
  readonly why: string
  readonly file: string
  /** 必须在文件里**唯一**命中。 */
  readonly find: string
  readonly replace: string
  /** 跑哪一批测试。必须覆盖 `file`。 */
  readonly scope: string
}

const K = 'packages/host/kernel/src'
const R = 'packages/host/stm-records/src'
const SK = 'packages/host/stm-skills/src'
const SF = 'packages/host/stm-safety/src'

export const MUTATIONS: readonly Mutation[] = [
  // ── 内核的闸 ────────────────────────────────────────────────────────
  {
    id: 'k2-abort-latch',
    why: '中止闩：人喊了停之后，除退针与停扫外一切都该被拒。拆掉 ⇒ 喊停无效',
    file: `${K}/skill-kernel.ts`,
    find: "    if (this.deps.abortLatched?.() === true) {",
    replace: "    if (false && this.deps.abortLatched?.() === true) {",
    scope: 'packages/host',
  },
  {
    id: 'k3-sample-gate',
    why: '样品闸：产数据的操作必须有归属样品。拆掉 ⇒ 以后没人能定位这条记录测的是什么',
    file: `${K}/skill-kernel.ts`,
    find: '      const gate = this.deps.sampleGate?.(spec) ?? null',
    replace: '      const gate = ((): string | null => (void this.deps.sampleGate, null))()',
    scope: 'packages/host',
  },
  {
    id: 'k6-required',
    why: '必填检查：省略 required 即必填。拆掉 ⇒ 广告成必填却不强制，模型漏传时到技能里才炸',
    file: `${K}/skill-kernel.ts`,
    find: '      if ((p.required ?? true) && !has) {',
    replace: '      if (p.required === true && !has) {',
    scope: 'packages/host',
  },
  {
    id: 'k7-safety-gate',
    why: '安全闸：荒谬值 / 包络 / 模式 / 硬闸的总入口。拆掉 ⇒ 四类拦截同时失效',
    file: `${K}/skill-kernel.ts`,
    find: '    const refusal = this.deps.safetyGate?.(spec, params) ?? null',
    replace: '    const refusal = ((): string | null => (void this.deps.safetyGate, null))()',
    scope: 'packages/host',
  },
  {
    id: 'k16-record-every-outcome',
    why: '记录每一个结局：被拒的调用也记。拆掉 ⇒ 回到「为什么什么都没发生」无从回答的状态',
    file: `${K}/skill-kernel.ts`,
    find: '        this.deps.record?.({',
    replace: "        if (o.kind === 'ok') this.deps.record?.({",
    scope: 'packages/host',
  },
  {
    id: 'k16-record-parsed-params',
    why: '记解析后的参数。拆掉 ⇒ schema 那四个生成列全 NULL，按数值查历史直接问不出来',
    file: `${K}/skill-kernel.ts`,
    find: '      recorded = params',
    replace: '      void params',
    scope: 'packages/host',
  },

  // ── 安全判据 ────────────────────────────────────────────────────────
  {
    id: 'safety-physically-absurd',
    why: '物理荒谬：11 条「这个数在这台仪器上不可能是本意」。拆掉 ⇒ 1.5 A 这类值一路放行',
    file: `${K}/safety.ts`,
    find: 'export function physicallyAbsurdViolations(',
    // 改名会连带打断测试文件的 import（构建失败 ⇒ 判 inconclusive，不算数）。
    // 所以留下同名同签名的空壳，把真身改名藏起来。
    replace: `export function physicallyAbsurdViolations(...__a: unknown[]): string[] {
  void __a
  return []
}
void physicallyAbsurdViolations_unused
function physicallyAbsurdViolations_unused(`,
    scope: 'packages/host',
  },
  {
    id: 'schema-effective-bounds',
    why: '广告与执行同源：界要与安全包络求交。拆掉 ⇒ 2026-08-10 的 16 个米制参数重现',
    file: `${K}/tool-schema.ts`,
    find: `  if (gLo !== null) lo = lo === null ? gLo : Math.max(lo, gLo)
  if (gHi !== null) hi = hi === null ? gHi : Math.min(hi, gHi)`,
    replace: `  void gLo
  void gHi`,
    scope: 'packages/host',
  },
  {
    id: 'schema-enum-skips-si',
    why: '枚举不走 SI 解析。拆掉 ⇒ 内核拿 "low" 去 parseQuantity，拒掉一次完全合法的调用',
    file: `${K}/tool-schema.ts`,
    find: '    if (p.allowedValues !== undefined && p.allowedValues.length > 0) continue',
    replace: '    void p.allowedValues',
    scope: 'packages/host',
  },

  // ── dsh 接缝 ────────────────────────────────────────────────────────
  {
    id: 'tool-bounds-into-description',
    why: 'D-SCHEMA-2：dsh 收不下数值界，只能折进描述。拆掉 ⇒ 模型再也读不到范围',
    file: `${SK}/tool.ts`,
    find: '    const sentence = boundsSentence(prop.minimum, prop.maximum)',
    replace: `    void boundsSentence
    const sentence = ''`,
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'tool-validation-teaching-text',
    why: 'D-SCHEMA-3：参数校验失败要贴回教学文案。拆掉 ⇒ 模型只读到英文样板，改不动',
    file: `${SK}/tool.ts`,
    find: "      if (result.error.info?.code !== 'INVALID_ARGS') return undefined",
    replace: "      if (result.error.info?.code !== 'NEVER_HAPPENS') return undefined",
    scope: 'packages/host/stm-skills',
  },

  // ── 记录层 ──────────────────────────────────────────────────────────
  {
    id: 'rec-unscoped-sentinel',
    why: 'D-REC-1：没有实验时也记。拆掉 ⇒ 样品闸的拒绝一条都留不下',
    file: `${R}/store.ts`,
    find: '          input.experimentId ?? UNSCOPED,',
    replace: "          input.experimentId ?? '不存在的实验',",
    scope: 'packages/host/stm-records',
  },
  {
    id: 'rec-approval-row',
    why: 'D-REC-2：人批准的要写 approvals。拆掉 ⇒ 空表和「没人准过」又长得一样了',
    file: `${R}/store.ts`,
    find: "        ? ['human_operator', 'gui_click']",
    replace: "        ? ['automated_policy', 'gui_click']",
    scope: 'packages/host/stm-records',
  },
  {
    id: 'rec-status-rolled-back',
    why: 'rolled_back 是独立状态。拆掉 ⇒ 回滚过的动作和普通失败分不开',
    file: `${R}/store.ts`,
    find: `  if (kind === 'ok') return 'succeeded'
  if (kind === 'rolled_back') return 'rolled_back'
  return 'failed'`,
    replace: "  return kind === 'ok' ? 'succeeded' : 'failed'",
    scope: 'packages/host/stm-records',
  },
  {
    id: 'ledger-success-only-artifacts',
    why: '只有成功的调用能贡献产物。拆掉 ⇒ 失败技能「本该写出」的路径去佐证声明',
    file: `${R}/ledger.ts`,
    find: '      if (success) {',
    replace: '      if (success || true) {',
    scope: 'packages/host/stm-records',
  },
  {
    id: 'ledger-absent-is-undefined',
    why: '没这一轮返回 undefined，不是空条目。拆掉 ⇒ 「不知道」被当成「没发生」，审计开始乱叫',
    file: `${R}/ledger.ts`,
    find: '    return e === undefined ? undefined : { skills: [...e.skills], artifacts: [...e.artifacts] }',
    replace:
      '    return e === undefined ? { skills: [], artifacts: [] } : { skills: [...e.skills], artifacts: [...e.artifacts] }',
    scope: 'packages/host/stm-records',
  },
  {
    id: 'audit-windows-path-semantics',
    why: 'D-REC-4：路径比较写死 Windows。拆掉 ⇒ 同一条判据在开发机与 CI 上给两个答案',
    file: `${R}/claim-audit.ts`,
    find: "  const parts = p.replace(/\\//g, '\\\\').split('\\\\')",
    replace: "  const parts = p.split('\\\\')",
    scope: 'packages/host/stm-records',
  },
  // ── 批 1/2 的技能闸 ──────────────────────────────────────────────────
  {
    id: 'park-undeclared-before-missing',
    why: '没声明符号排在读不到之前。拆掉 ⇒ 一个「白等」被报成「再等等」，轮询耗光预算才收工',
    file: `${K}/tip-park.ts`,
    find: "  if (undeclared.length > 0) {",
    replace: "  if (undeclared.length > 0 && missing.length === 0) {",
    scope: 'packages/host',
  },
  {
    id: 'park-rail-side-by-sign',
    why: '收回端由 z_extend_sign 定。拆掉 ⇒ 把顶在伸长端(朝样品那侧)的针判成已退针',
    file: `${K}/tip-park.ts`,
    find: `      ? ([travel.lo_m, 'low', travel.hi_m] as const)
      : ([travel.hi_m, 'high', travel.lo_m] as const)`,
    replace: `      ? ([travel.hi_m, 'high', travel.lo_m] as const)
      : ([travel.lo_m, 'low', travel.hi_m] as const)`,
    scope: 'packages/host',
  },
  {
    id: 'park-soft-limits-need-enabled',
    why: '软限只有启用时才算数。拆掉 ⇒ 拿一对惰性数字当边界，Z 顶死时告警不会响',
    file: `${K}/tip-park.ts`,
    find: '  if (opts.zLimitsEnabled === true && opts.zLimitsM != null) {',
    replace: '  if (opts.zLimitsEnabled !== false && opts.zLimitsM != null) {',
    scope: 'packages/host',
  },
  {
    id: 'park-is-parked-only-parked',
    why: '`isParked` 只在确认到位时为真。拆掉 ⇒ `unreadable` 被当成已退针',
    file: `${K}/tip-park.ts`,
    find: "  return v.state === PARKED",
    replace: "  return v.state !== NOT_PARKED",
    scope: 'packages/host',
  },
  {
    id: 'retract-retry-useful-exit',
    why: '配置缺口时立刻收工。拆掉 ⇒ 「白等」被报成「超时」，人会去调大预算而不是去填符号',
    file: `${SK}/l0/safe-retract.ts`,
    find: '        if (!retryUseful(verdict)) break',
    replace: '        void retryUseful',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'engage-fail-closed-no-current',
    why: '测不出隧穿就不建议粗进针。拆掉 ⇒ 测量链自己坏了成了盲目粗进针的触发条件',
    file: `${SK}/l0/engage.ts`,
    find: '    if (nValid === 0 || setpointA <= 0) {',
    replace: '    if (false && (nValid === 0 || setpointA <= 0)) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'engage-fail-closed-loop-open',
    why: '确认不了反馈环已开就不建议粗进针。拆掉 ⇒ 带着闭合的环把粗动马达开进表面',
    file: `${SK}/l0/engage.ts`,
    find: '    if (!(v.verified && v.on === false)) {',
    replace: '    if (!(v.verified || v.on === false)) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'move-stall-counter',
    why: '连续逐位不变 ⇒ 停住了。拆掉 ⇒ 「夹住」被说成「可能仍在移动中」，外环去等一个不会发生的事',
    file: `${SK}/l0/move.ts`,
    find: '    const stalled = frozen >= STALL_POLLS',
    replace: '    const stalled = frozen >= STALL_POLLS && false',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'gated-call-abort-verbs',
    why: '动词级中止门。拆掉 ⇒ 中止落在技能中段时，它自己的退针会被自己触发的闸拒掉 —— 人按了中止，针留在原地',
    file: `${SK}/gated-call.ts`,
    find: '    if (isAbortSafe(method, args)) return opts.call(method, ...args)',
    replace: '    void isAbortSafe',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'k2-abort-reason-honesty',
    why: '没原因时不假定是人停的。拆掉 ⇒ 人去翻自己的操作记录，而真正的原因在服务日志的 CRITICAL 行里',
    file: `${K}/skill-kernel.ts`,
    find: "          : '**没有留下中止原因** —— 别假定是人停的:急停、E_STOP 事件、' +",
    replace: "          : '用户已中止本次运行。' + '' +",
    scope: 'packages/host',
  },
  // ── 组合执行器的四条恢复守卫（四次真机事故的现场）────────────────────
  {
    id: 'graph-terminal-guard',
    why: '跑完了的既往进度不许当断点续跑。拆掉 ⇒ 整个计划被跳过，而外面看到的是一次数字完全正常的成功（2026-07-10 假进针 / 2026-07-27 五个 region 0.37 秒「扫完」）',
    file: `${K}/graph-executor.ts`,
    find: '  return total > 0 && done >= total',
    replace: '  return total > 0 && done >= total && false',
    scope: 'packages/host',
  },
  {
    id: 'graph-drop-stale-abort',
    why: '恢复时丢掉上一次的中止。拆掉 ⇒ 「重试」静默变成「重放」：回包用时 0.0 分钟、error 一字不差还是上一轮那句（2026-08-23）',
    file: `${K}/graph-executor.ts`,
    find: '  p.aborted = false',
    replace: '  p.aborted = true',
    scope: 'packages/host',
  },
  {
    id: 'graph-clear-completed-sidecar',
    why: '跑完删掉自己的断点。拆掉 ⇒ 同一次运行里的下一次调用捡到它，跳掉每一步（2026-08-12 ForgeAuTip 的 finalize 被跳过，这个失败模式的第三次出货）',
    file: `${K}/graph-executor.ts`,
    find: '      this.#clearSidecar()',
    replace: '      void this.#clearSidecar',
    scope: 'packages/host',
  },
  {
    id: 'graph-abort-before-step',
    why: '每一步之前查中止闩。拆掉 ⇒ 人按着中止，计划照样一步步走完',
    file: `${K}/graph-executor.ts`,
    find: '      if (this.#checkAbort()) {',
    replace: '      if (false && this.#checkAbort()) {',
    scope: 'packages/host',
  },
  {
    id: 'graph-halt-must-be-a-reason',
    why: '停机必须是一个字符串理由。拆掉 ⇒ 一个返回真值哨兵的桩上下文把每个计划都停在第一步',
    file: `${K}/graph-executor.ts`,
    find: "    return typeof reason === 'string' ? reason : ''",
    replace: '    return String(reason ?? "")',
    scope: 'packages/host',
  },
  {
    id: 'graph-abort-facts-operator-only',
    why: '只有中止闩才算「人喊停」。拆掉 ⇒ 一次 CRITICAL 停机被报成「你中止了」，而人从没碰过它（2026-07-28 #46，连报三次）',
    file: `${K}/graph-executor.ts`,
    find: '    aborted && (!reason || reason === ABORT_LATCH_REASON || reason === USER_ABORT_TEXT)',
    replace: '    aborted && reason.length >= 0',
    scope: 'packages/host',
  },
  // ── 等扫描：三条真机事故各一条 ────────────────────────────────────────
  {
    id: 'wait-lines-mismatch-refusal',
    why: '帧行数与缓冲区配置对不上就拒绝判断。拆掉 ⇒ 两个描述不同对象的数相除，**制造**出一个截断',
    file: `${K}/scan-wait.ts`,
    find: '  if (configured !== null && rows !== configured) return { ...UNMEASURED, linesTotal: configured }',
    replace: '  void 0',
    scope: 'packages/host',
  },
  {
    id: 'wait-never-started',
    why: '一次都没见它跑 + 缓冲区确证 0 行 ⇒ 它从没开始。拆掉 ⇒ 一次刚发起的扫描被判成「中途停止 (0/256 行)」，报错还把人指向去查是谁停的（2026-08-13，0.31 秒）',
    file: `${K}/scan-wait.ts`,
    find: '  const neverStarted = !seenRunning && lines.linesDone === 0',
    replace: '  const neverStarted = false && !seenRunning && lines.linesDone === 0',
    scope: 'packages/host',
  },
  {
    id: 'wait-extension-needs-progress',
    why: '延期要靠行数严格增长挣到。拆掉 ⇒ 一次冻在第 300 行的扫描照样续命，而一台读不出缓冲区的机器在每次超时上永远等下去',
    file: `${K}/scan-wait.ts`,
    find: '  if (prev === null || done <= prev) return no(false, done)',
    replace: '  void done',
    scope: 'packages/host',
  },
  {
    id: 'wait-frame-restarted',
    why: '行数掉下去是换帧，不是卡住。拆掉 ⇒ 把一次 Continuous scan 叫「卡住」，下一个读的人去找一个卡住的压电（2026-08-09 实测 234 → 208 行）',
    file: `${K}/scan-wait.ts`,
    find: '  if (prev !== null && done < prev) return no(true, done)',
    replace: '  if (prev !== null && done < prev) return no(false, done)',
    scope: 'packages/host',
  },
  {
    id: 'wait-stop-scan-on-abort',
    why: '中止时先停扫再返回。拆掉 ⇒ 人按了中止，扫描还在跑 —— 仪器被留在运动中',
    file: `${SK}/composite/wait-scan-complete.ts`,
    find: '    if (aborted) await this.#stopScan()',
    replace: '    void aborted',
    scope: 'packages/host/stm-skills',
  },
  // ── 偏压斜坡：假起点 ────────────────────────────────────────────────
  {
    id: 'ramp-no-fake-start',
    why: '读不到当前偏压就拒绝。拆掉 ⇒ 真实偏压 1 V 而起点被当成 0，第一步把硬件从 1 V 拽到近 0 —— 正是 slew 存在的意义所要防的突变',
    file: `${SK}/composite/set-bias-ramp.ts`,
    find: '    if (v === null) return { success: false, error: NO_START_BIAS_ERROR }',
    replace: '    if (v === null) return { success: true, data: { bias_v_start: 0 } }',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'ramp-endpoint-exact',
    why: 'linspace 的末位直接赋成 stop。拆掉 ⇒ 斜坡的终点差一个 ulp，而那是真的下发给硬件的电压',
    file: `${K}/bias-ramp.ts`,
    find: '  out[num - 1] = stop',
    replace: '  void stop',
    scope: 'packages/host',
  },
  // ── 进针判定：五次真机事故各一条 ──────────────────────────────────────
  {
    id: 'engage-noise-floor',
    why: '噪声底封住「调低电流假装进针」。拆掉 ⇒ 把设定点调到 1 fA，放大器噪声就「达到」了它（#75 原话：调低电流假装进到针了）',
    file: `${K}/engage.ts`,
    find: '  return Math.max(0.5 * Math.abs(setpointA), MIN_ENGAGED_CURRENT_A)',
    replace: '  return 0.5 * Math.abs(setpointA)',
    scope: 'packages/host',
  },
  {
    id: 'engage-bar-needs-setpoint',
    why: '设定点读不到或为 0 ⇒ 算不出判据线就不许判。拆掉 ⇒ 一个读不到设定点的装机会拿 0 当线，任何噪声都「过线」',
    file: `${K}/engage.ts`,
    find: '  if (setpointA === null || setpointA === undefined || setpointA === 0) return null',
    replace: '  if (setpointA === null || setpointA === undefined) return null',
    scope: 'packages/host',
  },
  {
    id: 'engage-two-agreeing-reads',
    why: '两次一致才下结论。拆掉 ⇒ 单次读数说了算，而模块停下那一刻正是电流唯一保证在途中的时刻——2026-08-05 一次成功的进针就是这么被判成失败的',
    file: `${K}/engage.ts`,
    find: '      if (run >= agreeN) {',
    replace: '      if (run >= 1) {',
    scope: 'packages/host',
  },
  {
    id: 'engage-unreadable-breaks-run',
    why: '读不到会打断连续计数。拆掉 ⇒ 一次没读到被当成「上一次仍然成立」，于是一个读数加一次失败凑成了「两次一致」',
    file: `${K}/engage.ts`,
    find: '      ;[runSide, run] = [null, 0]',
    replace: '      ;[runSide, run] = [runSide, run]',
    scope: 'packages/host',
  },
  {
    id: 'engage-unknown-is-not-zero',
    why: '判不出时 engaged 保持 null。拆掉 ⇒ 「没测出来」被报成「测出来是零」，那正是把人支去看电机量程的那句话',
    file: `${K}/engage.ts`,
    find: "  if (v.engaged === null) {",
    replace: "  if (false && v.engaged === null) {",
    scope: 'packages/host',
  },
  {
    id: 'engage-parse-running-unreadable',
    why: '状态位读不懂 ⇒ null，不是「没在跑」。拆掉 ⇒ 一次解析故障答出一个具体的仪器状态（这个位置已经在真机上静默报过一次「未在运行」）',
    file: `${K}/engage.ts`,
    find: '    if (inner.length === 0) return null',
    replace: '    if (inner.length === 0) return false',
    scope: 'packages/host',
  },
  {
    id: 'engage-z-travel-is-evidence',
    why: 'Z 纹丝不动与 Z 在推进是两句话。拆掉 ⇒ 一趟只是 4 K 下步长太短的健康进针被说成「卡住」，而下一步该做什么完全取决于是哪一件（2026-08-08 整晚查一个不存在的秒停）',
    file: `${K}/engage.ts`,
    find: '    if (this.zTravelM <= 0) {',
    replace: '    if (false) {',
    scope: 'packages/host',
  },
  {
    id: 'approach-confirm-stopped',
    why: '读到「停了」要复读一次。拆掉 ⇒ 一次瞬态读数掐掉一趟正在走的进针，而症状和「模块自己停了」一模一样',
    file: `${SK}/composite/auto-approach.ts`,
    find: '        if (observedRunning && !(await this.#confirmStopped(progress))) {',
    replace: '        if (false && observedRunning && !(await this.#confirmStopped(progress))) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'approach-stop-on-abort',
    why: '中止时先停模块再返回。拆掉 ⇒ 人按了中止，进针模块还在把针尖往表面压',
    file: `${SK}/composite/auto-approach.ts`,
    find: '        await this.#stopModule()',
    replace: '        void 0',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'approach-stop-failure-is-visible',
    why: '停机没下发必须留痕。拆掉 ⇒ 调用方拿到的东西和停成功时一模一样，它只会报「进针失败」，一个字不提「而且模块可能还在走」（2026-08-10）',
    file: `${SK}/composite/auto-approach.ts`,
    find: "    if (failed(rec)) this.#stopFailures.push(`AutoApproach_OnOffSet(0): ${rec.error}`)",
    replace: '    void rec',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'approach-timeout-not-success',
    why: '到上限还在跑不许报成功。拆掉 ⇒ 一趟没走到表面的进针被当成进到了，下一步是配扫描',
    file: `${SK}/composite/auto-approach.ts`,
    find: '      if (elapsed >= this.#timeoutS) return this.#afterTimeout(progress)',
    replace: '      if (false && elapsed >= this.#timeoutS) return this.#afterTimeout(progress)',
    scope: 'packages/host/stm-skills',
  },
  // ── 逃逸闸与 L2 分派 ─────────────────────────────────────────────────
  {
    id: 'refusal-clear-is-chain-scoped',
    why: '另一条链清不掉本链记的拒绝。拆掉 ⇒ 私聊里一次成功 engage 抹掉群聊十秒前记下的拒绝，2026-07-27 那道侧门重新打开',
    file: `${K}/approach-refusal.ts`,
    find: "    if (owner !== null && owner !== undefined && cur.owner !== '' && cur.owner !== owner) {",
    replace: "    if (owner === '\u0000never') {",
    scope: 'packages/host',
  },
  {
    id: 'refusal-expires',
    why: '拒绝到期自动失效。拆掉 ⇒ 一条没人再回头看的拒绝活得比它描述的硬件状态更久，粗进针从此调不动',
    file: `${K}/approach-refusal.ts`,
    find: '    if (this.ageS(r) >= r.ttlS) {',
    replace: '    if (false) {',
    scope: 'packages/host',
  },
  {
    id: 'refusal-gate-denies',
    why: '安全闸读到活着的拒绝就拒。拆掉 ⇒ 记下的拒绝谁都挡不住，整条闸等于没有',
    file: `${SF}/plugin.ts`,
    find: '    return isApproachEscalation(toolName) ? this.approachLatch.active() : null',
    replace: '    return isApproachEscalation(toolName) ? null : null',
    scope: 'packages/host/stm-safety',
  },
  {
    id: 'tip-records-refusal-on-engage-fail',
    why: 'engage 相失败要记一次拒绝。拆掉 ⇒ 正门拒了，侧门（直接 AutoApproach）却是开的',
    file: `${SK}/composite/approach-tip.ts`,
    find: `      const err = \`engage phase failed: \${eng.error ?? 'unknown'}\``,
    replace: `      const err = 'engage phase failed'; void this.#latch`,
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'tip-no-approach-on-a-maybe',
    why: 'engage 既没进针也没说要粗进针 ⇒ 停下。拆掉 ⇒ 在两个自相矛盾的判据上开一次粗进针',
    file: `${SK}/composite/approach-tip.ts`,
    find: "    if (engData['needs_auto_approach'] !== true) {",
    replace: "    if (false && engData['needs_auto_approach'] !== true) {",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'tip-verifies-after-approach',
    why: '粗进针跑完要自己再测一次。拆掉 ⇒ 一次过期续跑让 AutoApproach 报成功，0.17 pA 对 500 pA 也「确认」了进针（#42/#75）',
    file: `${SK}/composite/approach-tip.ts`,
    find: '    if (v.engaged !== true) {',
    replace: '    if (false && v.engaged !== true) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'kernel-composition-depth-cap',
    why: '组合嵌套上限。拆掉 ⇒ 一个自己调自己的技能把进程转死，而那时仪器还握在手里',
    file: `${K}/skill-kernel.ts`,
    find: '    if (depth + 1 >= MAX_COMPOSITION_DEPTH) {',
    replace: '    if (false) {',
    scope: 'packages/host',
  },
  // ── 扫描主链的判定件 ────────────────────────────────────────────────
  {
    id: 'tier-bound-tolerance',
    why: '上界带相对容差，边界值才真的落在小的那一档。拆掉 ⇒ 100 nm 从 highres 掉到 roi，速度悄悄变了（顺带查明：`<=` 与 `<` 在有容差时是等价的，真正承重的是容差）',
    file: `${K}/scan-policy.ts`,
    find: '    if (size <= tier.upperSizeM * (1 + BOUND_REL_TOL)) return tier',
    replace: '    if (size <= tier.upperSizeM * (1 - BOUND_REL_TOL)) return tier',
    scope: 'packages/host',
  },
  {
    id: 'line-time-explicit-must-be-positive',
    why: '显式给 0/负数要退回档位表。拆掉 ⇒ 一个 0 直接当线时间用，扫描速度算出来是 Infinity',
    file: `${K}/scan-policy.ts`,
    find: `    if (Number.isFinite(v) && v > 0) return { lineTimeS: v, source: 'explicit' }`,
    replace: `    if (Number.isFinite(v)) return { lineTimeS: v, source: 'explicit' }`,
    scope: 'packages/host',
  },
  {
    id: 'frame-extent-honours-angle',
    why: '包络必须算角度。拆掉 ⇒ 转 45° 的框对角线伸出 √2 倍却被算成没超，越界闸在转角帧上系统性失效',
    file: `${K}/scan-frame.ts`,
    find: '  const a = ((angleDeg ?? 0) * Math.PI) / 180',
    replace: '  const a = 0 * (angleDeg ?? 0)',
    scope: 'packages/host',
  },
  {
    id: 'frame-exceeds-needs-half-range',
    why: '半程读不到要返回 null（判不了）。拆掉 ⇒ 「读不到」被当成「没超」，那 15 % 不是数据的那一帧照常放行',
    file: `${K}/scan-frame.ts`,
    find: '  if (halfXM === null || halfXM === undefined || halfYM === null || halfYM === undefined) return null',
    replace: '  if (halfXM === null || halfXM === undefined || halfYM === null || halfYM === undefined) return { x: halfXM ?? Number.POSITIVE_INFINITY, y: halfYM ?? Number.POSITIVE_INFINITY }',
    scope: 'packages/host',
  },
  {
    id: 'frame-readback-unreadable-is-not-ok',
    why: '回读读不到 ⇒ unreadable，不是「对上了」。拆掉 ⇒ 仪器把框夹到量程内而上层完全看不出来，此后每张图的坐标都是假的',
    file: `${K}/scan-frame.ts`,
    find: '  if (readback === null || readback === undefined) return { unreadable: true }',
    replace: '  if (readback === null || readback === undefined) return null',
    scope: 'packages/host',
  },
  {
    id: 'match-signal-prefix-needs-boundary',
    why: '前缀匹配要带边界。拆掉 ⇒ 通道名 Z 撞上 Z-Controller，采的是另一路信号而没人报错',
    file: `${K}/scan-frame.ts`,
    find: "    if (nl.startsWith(ql) && (nl.length === ql.length || nl[ql.length] === ' ' || nl[ql.length] === '(')) {",
    replace: '    if (nl.startsWith(ql)) {',
    scope: 'packages/host',
  },
  {
    id: 'props-module-count-must-agree',
    why: '声明的个数与解出的数组不一致 ⇒ 未知，绝不修补。拆掉 ⇒ 一次错解被当成可信读数，写回一份残缺清单覆盖用户配的',
    file: `${K}/scan-reply.ts`,
    find: `  if (names.length !== count || !names.every((s) => typeof s === 'string')) return null`,
    replace: `  if (!names.every((s) => typeof s === 'string')) return null`,
    scope: 'packages/host',
  },
  {
    id: 'continuous-state-is-three-valued',
    why: 'GET 表只有 0/1，别的都是「不知道」。拆掉 ⇒ 一个 2（SET 侧的「关」）被读成「确认已关」，2026-08-19 那次就是这么答成一切正常的',
    file: `${K}/scan-reply.ts`,
    find: '  if (flag === GET_OFF) return false',
    replace: '  if (flag !== GET_ON) return false',
    scope: 'packages/host',
  },
  {
    id: 'configure-scan-refuses-unread-angle',
    why: '读不回当前角度就拒绝配帧。拆掉 ⇒ 用一个假定的 0° 静默把扫描框转正，而调用方要的是「保持当前角度」',
    file: `${SK}/l0/configure-scan.ts`,
    find: '      if (angle === null || !Number.isFinite(angle)) {',
    replace: '      if (angle === null && !(angle = 0, true)) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'configure-scan-frame-readback-gate',
    why: '写完读回来对不上就拒。拆掉 ⇒ 回声当读数，仪器夹过的框被当成设上了',
    file: `${SK}/l0/configure-scan.ts`,
    find: '  return frameReadbackMismatch(requested, readback)',
    replace: '  void requested; void readback; return null',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'configure-scan-piezo-range-gate',
    why: '框伸出压电量程就拒。拆掉 ⇒ 超出去那部分像素不是数据，而图看着完全正常（2026-08-28）',
    file: `${SK}/l0/configure-scan.ts`,
    find: '  return frameExceeds(cx, cy, w, h, angle, halfX, halfY)',
    replace: '  void [cx, cy, w, h, angle, halfX, halfY]; return null',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'start-scan-continuous-gate',
    why: '只有回读确认 continuous 关着才起扫。拆掉 ⇒ 一次 start 不再等于一帧，WaitScanComplete 只能等满超时而 SaveScan 拿到的可能是第 N+2 帧',
    file: `${SK}/l0/start-scan.ts`,
    find: `  if (i.stillOn === false) return ''`,
    replace: `  if (i.stillOn !== true) return ''`,
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'start-scan-props-need-read-list',
    why: '读不到模块清单就不下发 Scan_PropsSet。拆掉 ⇒ 一个空数组按「清空」语义把用户配好的清单抹掉',
    file: `${SK}/l0/start-scan.ts`,
    find: "    const propsWritten = moduleNamesSource === 'read' || moduleNamesSource === 'read_empty'",
    replace: '    const propsWritten = true',
    scope: 'packages/host/stm-skills',
  },
  // ── 抓帧落盘 / 找图 / 参数组 ────────────────────────────────────────
  {
    id: 'frame-must-keep-2d',
    why: '落盘的帧必须保住行列。拆掉 ⇒ 每个 .npy 都是扁的，断链断在测量之后一步：2026-07-28 那趟报告每个数都是真的，只是没有图',
    file: `${SK}/l0/frames.ts`,
    find: 'parseFrameGrab(body, true) ?? parseFrameGrab(body, false)',
    replace: 'parseFrameGrab(body, false)',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'frame-name-must-be-free',
    why: '取第一个空名。拆掉 ⇒ 同一毫秒里的第二发盖掉第一发（2026-07-28：下游拿上一趟的残留当本趟结果，而本趟落地时毁掉了上一趟）',
    file: `${SK}/l0/frames.ts`,
    find: '  while (existsSync(out)) {',
    replace: '  while (false && existsSync(out)) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'searched-dirs-must-exist',
    why: 'searched_dirs 只列真找过的目录。拆掉 ⇒ 报告一次没发生过的搜索，调用方据此断定「那儿没有图」',
    file: `${SK}/l0/frames.ts`,
    find: '      if (!statSync(real).isDirectory()) continue',
    replace: '      void statSync(real)',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'session-path-may-be-prefix',
    why: 'SessionPathGet 报的可能是「目录 + 文件名前缀」，要取上级。拆掉 ⇒ 存在 working-sessions 之外的图一律找不到（2026-06-29：path:null，而文件就在那儿）',
    file: `${SK}/l0/frames.ts`,
    find: '  const up = dirname(s)',
    replace: '  const up = s',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'preset-never-clamps',
    why: '超范围就拒，从不夹紧。拆掉 ⇒ 被悄悄改小的值会让你以为自己设的是原来那个数',
    file: `${K}/zctrl-preset.ts`,
    find: '  if (value >= lo && value <= hi) return',
    replace: '  if (true) return',
    scope: 'packages/host',
  },
  {
    id: 'preset-duplicate-needs-overwrite',
    why: '同名默认拒，覆盖要显式说。拆掉 ⇒ 一次手滑把用户调了一下午的那组参数换掉，而返回值看起来完全正常',
    file: `${K}/zctrl-preset.ts`,
    find: '    if (at >= 0 && !overwrite) {',
    replace: '    if (false && at >= 0 && !overwrite) {',
    scope: 'packages/host',
  },
  {
    id: 'npy-header-64-align',
    why: '.npy 头部要补到 64 字节的整数倍。拆掉 ⇒ 在 np.load 抛异常之前一切看起来都正常，而那时那一帧已经扫完了',
    file: `${K}/npy.ts`,
    find: '  const headerLen = dict.length + 1 + ((NPY_ALIGN - (unpadded % NPY_ALIGN)) % NPY_ALIGN)',
    replace: '  const headerLen = dict.length + 1 + (void unpadded, 0)',
    scope: 'packages/host',
  },
  {
    id: 'py-repr-exponent-band',
    why: 'Python 在 1e-4 换指数记法，JS 要到 1e-6。拆掉 ⇒ setpoint_a 的上界 1e-7 在超界报文里印成 JS 的写法，而那句话是模型读的',
    file: `${K}/si.ts`,
    find: '  if (decpt > -4 && decpt <= 16) {',
    replace: '  if (decpt > -6 && decpt <= 21) {',
    scope: 'packages/host',
  },
  // ── 写后回读 / 参数组的解析与放回 ──────────────────────────────────
  {
    id: 'readback-tolerance-is-load-bearing',
    // 变异打在**容差这个数**上而不是那个 `if` 上：把 `isClose(...)` 换成 `===`
    // 会让 `isClose` 变成未使用的函数、`tsc` 报错，于是那条变异永远编不过
    // （「一道闸如果拆不开试一次，它就没被验过」，本仓第四次）。
    // 而 relTol = 0 时 `isClose` 本来就退化成精确相等 —— 同一个缺陷，编得过。
    why: '写后回读比对留 1e-3 相对容差。归零 ⇒ 退化成精确相等，真机上每一次写增益都判「不一致」、回滚、并叫人别进针，而报文里写着「相差 1 倍」',
    file: `${K}/readback.ts`,
    find: 'export const READBACK_REL_TOL = 1e-3',
    replace: 'export const READBACK_REL_TOL = 0',
    scope: 'packages/host',
  },
  {
    id: 'readback-rejects-unreadable',
    // 这道闸原先写在 `valuesMatch` 的 `if` 里，下游的类型收窄挂在它身上 ⇒
    // 改成永远为假就编不过。提成 `bothNumbers` 之后它拆得开了
    // （同 `knownHalfRange` / `checkFrameReadback` 那条规则，本仓第四次）。
    why: '「读不到」不是「一样」。拆掉 ⇒ 一个 null 回读被当成「硬件收下了」，而那正是回读这件事要防的东西',
    file: `${K}/readback.ts`,
    find: '  return a === null || b === null ? null : [a, b]',
    replace: '  return [a as number, b as number]',
    scope: 'packages/host',
  },
  {
    id: 'preset-approach-needs-profile',
    why: '进针参数只由用户输入。拆掉 ⇒ 编一组「常见值」顶上，以本机标定的名义跑一次真实的进针',
    file: `${K}/zctrl-preset.ts`,
    find: '  if (missing.length > 0) {',
    replace: '  if (false && missing.length > 0) {',
    scope: 'packages/host',
  },
  {
    id: 'preset-scan-needs-frame-size',
    why: '读不到帧宽就拒，不挑一档。拆掉 ⇒ 用一组不对的增益扫一整帧，而没人知道它是怎么选中的',
    file: `${K}/zctrl-preset.ts`,
    find: '  return size === null || size === undefined || !Number.isFinite(size) ? null : size',
    replace: '  return (size ?? 0) as number',
    scope: 'packages/host',
  },
  {
    id: 'preset-tier-needs-gains',
    why: '档位表没配 P/T 就拒。拆掉 ⇒ undefined 当增益写进硬件（出厂表六档全是空的，这条路每次都会走到）',
    file: `${K}/zctrl-preset.ts`,
    find: '  return p === undefined || p === null || t === undefined || t === null ? null : [p, t]',
    replace: '  return [(p ?? 0) as number, (t ?? 1) as number]',
    scope: 'packages/host',
  },
  {
    id: 'apply-preset-stops-on-gain-failure',
    why: '增益没写进去就不写设定点。拆掉 ⇒ 半组参数落地：增益是旧的、设定点是新的，而返回值看起来只是「设定点失败」',
    file: `${SK}/l0/zctrl-presets.ts`,
    find: '      if (!gainRes.success) {',
    replace: '      if (false && !gainRes.success) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'approach-preset-restores',
    why: '缺陷⑫：进针改过的增益必须放回去。拆掉 ⇒ 进针组的快增益一路带进成像，而没人知道它是谁改的',
    file: `${SK}/composite/approach-preset.ts`,
    find: "      const res = await ctx.runSkill('SetZCtrlGain', { ...snapshot.gains })",
    replace: '      const res: SkillResultLike = { success: true }',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'approach-preset-soft-stop-keeps-setpoint',
    why: '软停时**不还设定点**（缺陷⑬ 要求四）。拆掉 ⇒ 一个刚被叫停的流程以「归还」的名义再动一次针',
    file: `${SK}/composite/approach-preset.ts`,
    find: '    if (sp !== null && operatorStopped(ctx)) {',
    replace: '    if (false && sp !== null && operatorStopped(ctx)) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'approach-preset-snapshot-on-failure',
    why: '切参数组失败也要返回快照 ——「调用失败」不等于「什么都没改」。拆掉 ⇒ 写了一半的参数组永远放不回去',
    file: `${SK}/composite/approach-preset.ts`,
    find: '    return [{ gains: before, setpointA: spBefore }, note]',
    replace: '    return [ok ? { gains: before, setpointA: spBefore } : null, note]',
    scope: 'packages/host/stm-skills',
  },
  // ── 批 3c：撞针判据与聚合读 ────────────────────────────────────────
  {
    id: 'crash-status-is-three-valued',
    why: '一路都没读到是 skipped，不是 ok。拆掉 ⇒ 「我没能看」被说成「我没发现撞针」，而下游拿它决定要不要接着扫',
    file: `${K}/crash-check.ts`,
    // `void readableAny` 是为了让它仍被引用 —— 本仓开着 `noUnusedParameters`，
    // 直接删掉那一支会让参数变成未使用、`tsc` 报错、演练判 inconclusive。
    find: "  return crash ? 'crash' : readableAny ? 'ok' : 'skipped'",
    replace: "  return crash ? 'crash' : (void readableAny, 'ok')",
    scope: 'packages/host',
  },
  {
    id: 'crash-nan-is-a-crash',
    why: '一整帧 NaN 就是撞针最典型的样子。只看极差 ⇒ NaN < eps 为假，最该报警的那一帧变成最安静的那一帧',
    file: `${K}/crash-check.ts`,
    // `||` 换 `&&` 而不是把 `hasNan` 整个删掉：后者让它变成未使用的变量、编不过。
    find: '    if (hasNan || range < CRASH_RANGE_EPS) {',
    replace: '    if (hasNan && range < CRASH_RANGE_EPS) {',
    scope: 'packages/host',
  },
  {
    id: 'crash-bad-channel-token-skipped',
    why: '通道清单里夹了个错字，跳过它继续。拆掉 ⇒ 一个错字让整次撞针检测不做，而它本来只是少探一路',
    file: `${K}/crash-check.ts`,
    find: '    if (!/^[+-]?\\d+$/.test(t)) continue',
    replace: '    if (Number.isNaN(Number(t))) continue',
    scope: 'packages/host',
  },
  {
    id: 'readmany-lists-unreadable',
    why: '聚合读里读不到的那几格要单列。拆掉 ⇒ null 既可能是「没配」也可能是「没问到」，而两者长得一模一样',
    file: `${SK}/l0/reads-config.ts`,
    find: "  if (failed.length > 0) out['_unreadable'] = failed",
    replace: '  void failed',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'readmany-one-failure-keeps-the-batch',
    why: '一格读失败只置空它自己。拆掉 ⇒ 一个没装的模块把整批设置全带走，而其余十几格本来都读到了',
    file: `${SK}/l0/reads-config.ts`,
    find: '      failed.push(key)',
    replace: "      return { success: false, error: rec.error ?? '' }",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'tipshaper-naming-is-all-or-nothing',
    why: '长度对不上就一个都不具名。拆掉 ⇒ 「能对上几个先对几个」看起来很权威，而分歧点之后每个字段都悄悄错位',
    file: `${SK}/l0/reads-config.ts`,
    // 变异改成「只在**多**的时候拒」，于是少的那一侧会「能对上几个先对几个」——
    // 那正是这段注释说的更坏的失败，而且它编得过。
    find: '  if (props.length !== TIP_SHAPER_PROPS.length) {',
    replace: '  if (props.length > TIP_SHAPER_PROPS.length) {',
    scope: 'packages/host/stm-skills',
  },
  // ── 批 3d：锁相与留痕 ──────────────────────────────────────────────
  {
    id: 'lockin-values-before-modulation',
    why: '先设频率/幅度/相位，最后才开调制。倒过来 ⇒ 隧道结被上一次残留的幅度激励一小段时间（2026-07-03 复盘）',
    file: `${SK}/l0/lockin.ts`,
    // 把开关**提到最前面**（旧仓那一版就是这样），于是调制会先带着上一次残留的
    // 幅度/频率打开一小段时间。单行替换，编得过，而且正是那个缺陷的形状。
    find: "    const modOn = params['mod_on'] === true",
    replace:
      "    const modOn = params['mod_on'] === true; await ctx.safeCall('LockIn_ModOnOffSet', 1, modOn ? 1 : 0)",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'lockin-zero-amplitude-is-a-value',
    why: '幅度 0 是「开之前先把它变安全」，必须写得下去。拆掉 ⇒ 这件事做不到，而调用方以为做到了',
    file: `${SK}/l0/lockin.ts`,
    find: "    if (given(params, 'amplitude_v') && n(params, 'amplitude_v') >= 0) {",
    replace: "    if (given(params, 'amplitude_v') && n(params, 'amplitude_v') > 0) {",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'lockin-unwritten-field-is-null',
    why: '没写的字段报 null。拆掉 ⇒ 返回值宣称了一个相位，而那个寄存器它根本没碰过',
    file: `${SK}/l0/lockin.ts`,
    find: "      phase_deg: phaseWritten ? n(params, 'phase_deg') : null,",
    replace: "      phase_deg: n(params, 'phase_deg'),",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'lockin-demod-null-means-unset',
    why: '模型那条路上每个可选字段都以 null 到达。用 `in` 判 ⇒ 把 null 送进硬件 setter（真机上是写坏的写入）',
    file: `${SK}/l0/lockin.ts`,
    find: '  p[k] !== undefined && p[k] !== null',
    replace: '  k in p',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'lockin-readback-unreadable-is-null',
    why: '六个读回字段读不到时给 null。拆掉 ⇒ 0 被当成读数，而 modulated_signal 读错会让一条完全干净的曲线不是 dI/dV',
    file: `${SK}/l0/lockin.ts`,
    find: '      data[key] = failed(rec) ? null : scalarInt(rec.values ?? null)',
    replace: '      data[key] = scalarInt(rec.values ?? null) ?? 0',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'datalog-channels-are-strict',
    why: '记的是哪几路，一个记号不是整数就整串作废。拆掉 ⇒ 默默丢掉一路，日志里少一个通道而没人知道',
    file: `${SK}/l0/datalog-marks.ts`,
    find: '    if (!/^[+-]?\\d+$/.test(t)) return null',
    replace: '    if (!/^[+-]?\\d+$/.test(t)) continue',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'datalog-timed-vs-continuous',
    why: '给了时长就是定时，没给才是连续。拆掉 ⇒ 一次本该定时的日志一直写到磁盘满',
    file: `${SK}/l0/datalog-marks.ts`,
    // `void MODE_TIMED` 让它仍被引用 —— 直接删掉那一支会让常量变成未使用、编不过。
    find: '    const mode = total > 0 ? MODE_TIMED : MODE_CONTINUOUS',
    replace: '    const mode = (void MODE_TIMED, MODE_CONTINUOUS)',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'marks-line-needs-both-ends',
    why: '线标记缺终点就拒。拆掉 ⇒ 拿起点当终点画一条零长的线，而留痕的全部意义是「在哪里」',
    file: `${SK}/l0/datalog-marks.ts`,
    find: "      if (!(typeof params['x2_m'] === 'number') || !(typeof params['y2_m'] === 'number')) {",
    replace: '      if (false) {',
    scope: 'packages/host/stm-skills',
  },

  // ── 批 3e：锁相参数组 + 相位对齐 ────────────────────────────────────
  {
    id: 'lockin-preset-no-factory-default',
    why: '档案没填就不下发（D-LOCKIN-2）。拆掉 ⇒ 一个出厂默认的 20 mV 调制以「本机标定」的名义加到谁也没确认过的隧道结上',
    file: `${K}/lockin-preset.ts`,
    find: '  return raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw',
    replace: '  return raw === null || raw === undefined || !Number.isFinite(raw) ? 0.02 : raw',
    scope: 'packages/host',
  },
  {
    id: 'lockin-preset-phase-never-sent',
    why: '调制侧 phase 永不进调用序列（D-LOCKIN-1，固件恒拒、写同值也拒）。往组里塞一个 ⇒ 看谁拦得住',
    file: `${K}/lockin-preset.ts`,
    find: '    return { mod_on: modOn, ...this.values }',
    replace: '    return { mod_on: modOn, ...this.values, phase_deg: 0 }',
    scope: 'packages/host',
  },
  {
    id: 'lockin-readback-key-map',
    why: '组里叫 amplitude_v、回包里叫 amplitude（旧仓缺陷⑩）。改成同名 ⇒ 每一次成功写入都被报成「读不回来」，而那句失败带着「我核对过」的口气',
    file: `${K}/lockin-preset.ts`,
    find: "  amplitude_v: 'amplitude',",
    replace: "  amplitude_v: 'amplitude_v',",
    scope: 'packages/host',
  },
  {
    id: 'lockin-apply-readback-blocks',
    why: '下发后回读不一致 ⇒ 失败。拆掉 ⇒ 一次硬件没收下的调制幅度挂着「已设置」的牌子，而 dI/dV 曲线照样画得出来',
    file: `${SK}/l0/lockin-presets.ts`,
    find: '      if (mismatches.length > 0) {',
    replace: '      if (false) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'autophase-pymod-not-remainder',
    why: 'Python 取模、不是 JS 取余。改成取余 ⇒ 相位目标差 360°（−170° 起、−90° 增量给 −260° 而不是 +100°），而硬件会自己折回去，于是写进去的和报出来的不是一个数',
    file: `${K}/phase-align.ts`,
    find: '  return r < 0 !== n < 0 ? r + n : r',
    replace: '  return r',
    scope: 'packages/host',
  },
  {
    id: 'autophase-noise-floor',
    why: '噪声底上判不了相位就不写。把下界降到 0 ⇒ 一个由噪声算出来的角被写进硬件，而它和真的相位角一样体面',
    file: `${K}/phase-align.ts`,
    find: 'export const AUTOPHASE_MIN_SIGNAL = 1e-12',
    replace: 'export const AUTOPHASE_MIN_SIGNAL = 0',
    scope: 'packages/host',
  },
  {
    id: 'autophase-phase-readback-tol',
    why: '相位回读的 0.5° 绝对容差。放到 1e9 ⇒ 写了 26° 回读 12° 也算「已对齐」',
    file: `${K}/phase-align.ts`,
    find: 'export const PHASE_READBACK_TOL_DEG = 0.5',
    replace: 'export const PHASE_READBACK_TOL_DEG = 1e9',
    scope: 'packages/host',
  },
  {
    id: 'pysum-neumaier',
    why: 'CPython 3.12 起 sum() 对浮点用 Neumaier 补偿求和。拆掉补偿 ⇒ 均值在最后两位上与旧仓分岔，而金样是逐字节比的',
    file: `${K}/si.ts`,
    find: '    comp += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum',
    replace: '    comp += 0',
    scope: 'packages/host',
  },
  {
    id: 'autophase-abort-writes-nothing',
    why: '中止时什么都不写（连收尾关调制也不发）。拆掉 ⇒ 往一套正在跑的急停序列里插一条写操作',
    file: `${SK}/l0/lockin-presets.ts`,
    find: "      if (res.data?.['aborted'] === true) return res",
    replace: '      if (false) return res',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'autophase-closes-modulation',
    why: '缺陷⑪：它是这条链的终端消费者，跑完要把调制关回 OFF。拆掉 ⇒ 调制留着，在电流通道上叠一层纹波，污染后面每一条判据',
    file: `${SK}/l0/lockin-presets.ts`,
    find: "      const note = await closeModulation(ctx, 'AutoPhase')",
    replace:
      '      const note = ((): Record<string, unknown> => (void closeModulation, {}))()',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'autophase-never-guesses-indices',
    why: 'X/Y 走哪两路 RT 信号是接线事实，两处都没配就拒。改成猜 0 ⇒ 读到的是另一路信号，而算出来的角度看上去一样合理，然后被写进硬件',
    file: `${SK}/l0/lockin-presets.ts`,
    find: "  if (x !== null && y !== null) return { x, y, why: '' }",
    replace: "  return { x: x ?? 0, y: y ?? 0, why: '' }",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'autophase-needs-current-phase',
    why: 'atan2 算出来的是增量，读不到起点就不写。编一个 0 起点 ⇒ 相位被转到一个谁也没要的地方',
    file: `${SK}/l0/lockin-presets.ts`,
    find: '  const current = failedCall(recCur) ? null : num(recCur, 0)',
    replace: '  const current = failedCall(recCur) ? 0 : num(recCur, 0) ?? 0',
    scope: 'packages/host/stm-skills',
  },

  // ── 批 3e：五个收口模块 ─────────────────────────────────────────────
  {
    id: 'atomtrack-enable-failure-is-failure',
    why: '开调制失败就是整趟失败。咽下去 ⇒ 调用方相信调制与控制器已经开着，而它们没有',
    file: `${SK}/l0/atom-track.ts`,
    find: '      if (failed(rec)) return fail(`enable modulation failed: ${rec.error ?? \'\'}`)',
    replace: '      if (false) return fail(`enable modulation failed: ${rec.error ?? \'\'}`)',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'atomtrack-status-from-body',
    why: '状态位在 body 第 0 位。读不到它 ⇒ 每一项 Atom Tracking 控制都报 Off，而这个读从来没看过硬件',
    file: `${SK}/l0/atom-track.ts`,
    find: '      status: (int(rec, 0) ?? 0) !== 0,',
    replace: '      status: (void int(rec, 0), false),',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'osci-needmodule-vs-link-error',
    why: '带 NeedModule 是配置问题，别的错是线路故障。合成一种 ⇒ 一次断链被报成「去 Nanonis 里打开那个模块」，而重连一百次也没用的那句建议给错了对象',
    file: `${SK}/l0/osci.ts`,
    find: "  return failed(rec) && isNeedModule(rec.error ?? '')",
    replace: '  return (void isNeedModule, failed(rec))',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'osci-samples-all-or-nothing',
    why: '一条采样里有一个点解不出就整条作废。改成跳过 ⇒ 一条中间掉了几个点的时间序列，形状看起来完全正常，而后面每个 FFT 峰位都按等间隔算',
    file: `${SK}/l0/osci.ts`,
    find: '    if (x === null) return null',
    replace: '    if (x === null) continue',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'spectrum-zero-is-a-value',
    why: '矩形窗(0)与不平均(0)都是声明里写着的合法值（D-ZERO-1）。把 0 当「没给」⇒ 这两个一次也下发不出去，而调用方以为下发了',
    file: `${SK}/l0/spectrum.ts`,
    find: '  typeof p[k] === \'number\' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt',
    replace: "  typeof p[k] === 'number' && p[k] !== 0 ? Math.trunc(p[k] as number) : dflt",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'spectrum-band-lo-lt-hi',
    why: '频段下界 ≥ 上界就拒。拆掉 ⇒ 一对反过来的游标，而 band_rms 报的是一个谁也没要的频段里的噪声',
    file: `${SK}/l0/spectrum.ts`,
    find: '    if (lo >= hi) {',
    replace: '    if (false) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'biassweep-limits-swapped',
    why: '颠倒的偏压限值换过来（与频带那条刻意不同：这里方向是另一个参数）。拆掉 ⇒ Nanonis 收到一对反的限值',
    file: `${SK}/l0/bias-sweep.ts`,
    find: '    if (lo > hi) [lo, hi] = [hi, lo]',
    replace: '    if (false) [lo, hi] = [hi, lo]',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'biassweep-props-four-args',
    why: 'BiasSwp.PropsSet 只收四个实参（D-BIASSWP-1）。加回旧仓那个第五个 ⇒ 真机上一次 TypeError，RunBiasSweep 每次都停在第三步',
    file: `${SK}/l0/bias-sweep.ts`,
    find: "'BiasSwp_PropsSet', steps, period, autosave, 0)",
    replace: "'BiasSwp_PropsSet', steps, period, autosave, 0, period)",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'biassweep-zero-is-a-value',
    why: 'sweep_direction=0（上限→下限）与 z_hold=0（Z 控制器不变）都是合法值（D-ZERO-1）。把 0 当「没给」⇒ 这两个一次也选不出来',
    file: `${SK}/l0/bias-sweep.ts`,
    find: '  typeof p[k] === \'number\' && Number.isFinite(p[k] as number) ? Math.trunc(p[k] as number) : dflt',
    replace: "  typeof p[k] === 'number' && p[k] !== 0 ? Math.trunc(p[k] as number) : dflt",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'biaspulse-position-before-pulse',
    why: '脉冲留下永久痕迹，所以发之前读一次针尖在哪。拆掉 ⇒ 标记落在一个最多差一个刷新周期的缓存坐标上，而躲开坏片区全靠这些坐标',
    file: `${SK}/l0/bias-sweep.ts`,
    find: '    const spot = await tipXyFields(ctx)',
    replace: '    const spot = ((): Record<string, number> => (void tipXyFields, {}))()',
    scope: 'packages/host/stm-skills',
  },
  // ── 批 3f：脚本白名单（本仓唯一一道「人签过字」形态的闸）─────────────
  {
    id: 'script-allowlist-empty-means-no',
    why: '空清单 = 一个脚本都不许跑（fail-closed）。拆掉 ⇒ 「审核状态未知」被当成「通过」，而脚本跑在 RT 控制器上，本仓每一道闸在它内部都不生效',
    file: `${K}/script-allowlist.ts`,
    find: '  if (allow.size === 0) {',
    replace: '  if (false) {',
    scope: 'packages/host',
  },
  {
    id: 'script-allowlist-unvetted-slot',
    why: '槽位不在清单上就拒。改成「随便挑一个已批准的条目顶上」⇒ 一个没人读过的脚本以另一个脚本的名义跑起来',
    file: `${K}/script-allowlist.ts`,
    find: '  const entry = allow.get(slot)',
    replace: '  const entry = allow.get(slot) ?? allow.values().next().value',
    scope: 'packages/host',
  },
  {
    id: 'script-lut-range-is-enforced',
    why: 'LUT 的范围由审脚本的人写定（只有他知道脚本把这些数当什么单位用）。拆掉 ⇒ 一个 LUT 以毫米计的延时线脚本收到以微米计的数，台子开到硬限位上',
    file: `${K}/script-allowlist.ts`,
    find: '  if (entry.lutMin === null && entry.lutMax === null) return []',
    replace: '  return (void entry, [])',
    scope: 'packages/host',
  },
  {
    id: 'script-load-gate-is-inverted',
    why: '**本仓唯一一道反的闸**：LoadNanonisScript 拒绝往已审槽位里装别的脚本。把它改成正的 ⇒ 「槽位 3 已批准」从此什么也不表示',
    file: `${SK}/l0/script-files.ts`,
    find: '  return allow.has(slot)',
    replace: '  return !allow.has(slot)',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'script-lut-write-permission',
    why: '过审 ≠ 批准写 LUT（allow_lut_write）。拆掉 ⇒ 一个只被批准「按原样跑」的脚本被换了参数',
    file: `${SK}/l0/nanonis-script.ts`,
    find: '    if (!vetted.allowLutWrite) {',
    replace: '    if (false) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'script-run-leaves-a-record',
    why: '本仓看不见脚本内部，那条留痕是事后唯一能拿到的「跑了什么」。抹掉它那句话 ⇒ 事后解释不了这次运行',
    file: `${SK}/l0/nanonis-script.ts`,
    find: "        'MAST 的安全门/模式门/中止门在脚本内部均不生效。',",
    replace: "        '',",
    scope: 'packages/host/stm-skills',
  },

  // ── 批 3f：仪器限值 ─────────────────────────────────────────────────
  {
    id: 'zlimits-enable-failure-is-failure',
    why: '限值写进去了但没启用 ⇒ 整趟失败（Nanonis 原文：未启用时本函数无任何作用）。拆掉 ⇒ 一条什么也不做的限值挂着「已设置」的牌子',
    file: `${SK}/l0/limits.ts`,
    find: '      if (failed(recEn)) {',
    replace: '      if (false) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'zlimits-enabled-is-read-not-inferred',
    why: 'enable=false 时把启用状态**读回来**，不推断。改成推断 ⇒ 调用方以为一条收紧的限值在保护他，而它一个作用都没有',
    file: `${SK}/l0/limits.ts`,
    find: '  return flags === null ? null : flags[0] !== 0',
    replace: '  return (void flags, true)',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'zlimits-widened-is-tristate',
    why: '读不到改前的值时 widened 是 null。改成 false ⇒ 「没放宽」与「不知道有没有放宽」被折成同一句话，而放宽这件事的全部纪律就是它看得见',
    file: `${SK}/l0/limits.ts`,
    find: '    const widened = before === null ? null : hi > (before[0] as number) || lo < (before[1] as number)',
    replace: '    const widened = before === null ? false : hi > (before[0] as number) || lo < (before[1] as number)',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'piezo-limits-lo-lt-hi',
    why: '反过来的一对压电电压界就拒。拆掉 ⇒ 一对颠倒的界被下发，而过压会让压电**永久**退极化',
    file: `${SK}/l0/limits.ts`,
    find: '      if (lo >= hi) {',
    replace: '      if (false) {',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'limits-floats-all-or-nothing',
    why: '限值读不齐就整份作废。改成「有几个算几个」⇒ 半份限值，而它比没有限值更危险（读的人以为两端都有界）',
    file: `${SK}/l0/limits.ts`,
    find: '  return out.length >= n ? out.slice(0, n) : null',
    replace: '  return out.slice(0, n)',
    scope: 'packages/host/stm-skills',
  },

  // ── 批 3f：PLL ─────────────────────────────────────────────────────
  {
    id: 'pll-output-failure-is-failure',
    why: 'PLL 输出开不起来就是整趟失败（后面两个控制器无从谈起）。拆掉 ⇒ 调用方相信环锁上了，而 Δf 读的是噪声',
    file: `${SK}/l0/pll.ts`,
    find: "    const r = await ctx.safeCall('PLL_OutOnOffSet', mod, outputOn ? 1 : 0)\n    if (failed(r)) return fail(r.error ?? '')",
    replace: "    const r = await ctx.safeCall('PLL_OutOnOffSet', mod, outputOn ? 1 : 0)\n    if (false) return fail(r.error ?? '')",
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'pll-given-not-in',
    why: '判「给了没有」用 != null 而不是 in。改回 in ⇒ 模型那条路上 schema 实例化出来的六个 null 被送进硬件 setter',
    file: `${SK}/l0/pll.ts`,
    find: '  p[k] !== undefined && p[k] !== null',
    replace: '  k in p',
    scope: 'packages/host/stm-skills',
  },
  {
    id: 'pll-unparsable-omits-the-key',
    why: '解不出的读回字段**不写这个键**。改成照写 ⇒ 空 body 上 `null !== 0` 报出一个 true，而那是一个从来没被读到过的开关状态',
    file: `${SK}/l0/pll.ts`,
    find: '  return v === null ? {} : { [key]: v !== 0 }',
    replace: '  return { [key]: v !== 0 }',
    scope: 'packages/host/stm-skills',
  },

  {
    id: 'tipxy-magnitude-guard',
    why: '超出 1 mm 的「坐标」是解析残渣不是位置。放开它 ⇒ 标记被画到离样品几光年的地方，下游每一次算范围都跟着炸',
    file: `${SK}/l0/tip-xy.ts`,
    find: 'export const TIP_XY_MAX_M = 1e-3',
    replace: 'export const TIP_XY_MAX_M = 1e30',
    scope: 'packages/host/stm-skills',
  },
]
