/**
 * 样品门控 —— 逐字移植 `mast/core/sample_gate.py`。
 *
 * **产数据的操作必须有一个归属的样品。** 操作员的要求是硬的，理由不是洁癖：
 * 一条不知道属于哪块样品的 `.sxm`，事后没有任何人能定位它测的是什么，**等于白测**。
 *
 * 同样硬的另一条：**安全操作绝不能因为没选样品被挡住。**
 * 急停、退针、一切 Stop*、所有只读查询，在任何情况下都必须畅通。
 *
 * ## 为什么这里 fail-open，而仪器锁是 fail-closed
 *
 * 两者形状同构（都是「把哪些技能算数收敛到一处」），但**兜底方向刻意相反**：
 *
 * | | 分类不出来时 | 失败模式 |
 * |---|---|---|
 * | 仪器锁 `needsToken` | **假定要锁** | 两条链路同时驱动同一台 Nanonis ⇒ **危险**，宁可多锁一次 |
 * | 本门控 | **放行** | 一条记录没归属到样品 ⇒ **记账损失**，不是危险 |
 *
 * 而误拦一个安全操作，可能让操作员**在针要撞上去的时候按不动按钮**。
 * **歧义必须朝放行解。**
 *
 * 对话不在拦截范围内：跟 agent 讨论「这个实验该怎么做」发生在建样品之前，
 * 拦掉它会造成鸡生蛋。
 */

/** 无论如何都放行的技能名。这些是**补救**动作——存在的意义就是出事时立刻能跑。 */
export const GATE_EXEMPT_NAMES: ReadonlySet<string> = new Set([
  'AutoApproachClose',
  'EmergencyRetract',
  'SafeRetract',
  'StopAutoApproach',
  'StopAutoApproachAndWithdraw',
  'StopFolMe',
  'StopMotor',
  'StopSTS',
  'StopScan',
  'WithdrawTip',
])

/** 带这些标签的技能一律放行（补救 / 安全 / 只读 / 状态查询）。 */
export const GATE_EXEMPT_TAGS: ReadonlySet<string> = new Set([
  'connection',
  'diagnostic',
  'emergency',
  'read',
  'retract',
  'safety',
  'status',
  'stop',
  'withdraw',
])

/** 带这些标签的技能会产生数据文件或数据记录 ⇒ 必须有样品。 */
export const DATA_TAGS: ReadonlySet<string> = new Set([
  'acquisition',
  'datalog',
  'grid',
  'imaging',
  'lithography',
  'manipulation',
  'pattern',
  'point_shoot',
  'record',
  'scan',
  'spectroscopy',
  'spectrum',
  'sweep',
])

/** 名字层面的兜底：有些技能标签不全，但它们确定会产数据。 */
export const DATA_NAMES: ReadonlySet<string> = new Set([
  'AcquireSTS',
  'BiasPulse',
  'BiasSpectroscopy',
  'GridSpectroscopy',
  'SaveScan',
  'ScanOnce',
  'StartDataLog',
  'StartScan',
  'StartTcpLog',
  'TipPulse',
  'TipShape',
])

/** 能力标签命中这三个也算产数据。 */
const DATA_CAPABILITIES: ReadonlySet<string> = new Set(['bias_pulse', 'produces_file', 'tip_shaping'])

export interface SampleGateMetaLike {
  readonly name?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly category?: string | undefined
  readonly capabilities?: readonly string[] | undefined
}

/**
 * 这个技能是否要求有活跃样品才能跑。
 *
 * 判定顺序（**前三步是保险带，最后一步是背带**）：
 * 1. 名字在豁免表 → `false`
 * 2. 标签命中豁免标签 → `false`
 * 3. category ∈ READ|ANALYSIS → `false`
 * 4. 标签/名字/能力命中产数据集合 → `true`
 * 5. 其它 → **`false`（fail-open）**
 */
export function requiresSample(meta: SampleGateMetaLike, skillName = ''): boolean {
  const name = skillName || meta.name || ''
  if (GATE_EXEMPT_NAMES.has(name)) return false

  const tags = new Set((meta.tags ?? []).map((t) => String(t).toLowerCase()))
  for (const t of tags) if (GATE_EXEMPT_TAGS.has(t)) return false

  const category = String(meta.category ?? '').toLowerCase()
  if (['read', 'analysis', 'skillcategory.read', 'skillcategory.analysis'].includes(category)) {
    return false
  }

  for (const t of tags) if (DATA_TAGS.has(t)) return true
  if (DATA_NAMES.has(name)) return true

  for (const c of meta.capabilities ?? []) {
    if (DATA_CAPABILITIES.has(String(c).toLowerCase())) return true
  }

  // 分类不出来 → 放行。见上面关于 fail-open 方向的说明。
  return false
}

/**
 * 拒绝文案。**给人看的和给模型看的是同一句。**
 *
 * 说清发生了什么、为什么、有哪些出路，并明确告诉模型**不要原样重试**——
 * 否则它会陷进重试循环而不是去问操作员。
 */
export function sampleGateMessage(skillName: string, hasExperiment: boolean): string {
  if (!hasExperiment) {
    return (
      `[sample_gate] no_active_experiment: 当前没有进行中的实验，` +
      `'${skillName}' 未执行——扫描/谱学产生的数据必须归属到一个实验和样品，` +
      `否则以后没人能定位这条记录测的是什么。\n` +
      `出路：(1) 调用 start_experiment("实验名") 开一个实验，再 ` +
      `start_sample("样品名")；(2) 请操作员在右栏「实验 → 样品」里选择。\n` +
      `Do NOT retry this call unchanged — 在实验和样品选定前它会以完全` +
      `相同的方式失败。`
    )
  }
  return (
    `[sample_gate] no_active_sample: 当前没有选定样品，'${skillName}' 未执行` +
    `——扫描/谱学产生的数据必须归属到一个样品，否则以后没人能定位这条记录` +
    `属于哪块样品。\n` +
    `出路：(1) 调用 start_sample("样品名") 新建一个样品；` +
    `(2) 请操作员在右栏「实验 → 样品」里选一个已有样品；` +
    `(3) 若不确定用哪个样品，先问操作员——不要重试本次调用。\n` +
    `Do NOT retry this call unchanged — 在样品选定前它会以完全相同的方式失败。`
  )
}

/** 记录系统的当前指针。两个都缺席（`undefined`）⇒ **一律放行**。 */
export interface ExperimentPointers {
  readonly experimentId?: string | null | undefined
  readonly sampleId?: string | null | undefined
}

/**
 * 放行返回 `null`，否则返回拒绝文案。
 *
 * `pointers` 为 `undefined`（无头 / 测试 / 记录系统未接线）时**一律放行**——
 * 门控是记账约束，**不该在记录系统本身缺席时把仪器锁死**。
 */
export function checkSampleScope(
  meta: SampleGateMetaLike,
  skillName = '',
  pointers?: ExperimentPointers | null | undefined,
): string | null {
  if (pointers === null || pointers === undefined) return null
  if (!requiresSample(meta, skillName)) return null
  if (pointers.sampleId !== null && pointers.sampleId !== undefined && pointers.sampleId !== '') {
    return null
  }
  const name = skillName || meta.name || '(unknown)'
  const hasExperiment =
    pointers.experimentId !== null && pointers.experimentId !== undefined && pointers.experimentId !== ''
  return sampleGateMessage(name, hasExperiment)
}
