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
]
