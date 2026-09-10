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
]
