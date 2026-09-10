/**
 * `RecordStore` —— 记录库。**每一次技能调用一行，包括被拒的那些。**
 *
 * 旧仓这一层的注释把理由说尽了：
 *
 * > 这两道闸原来在 recorder 定义**之上**并且直接 return，于是**一个被参数校验或
 * > 前置条件拒掉的调用，哪个记录库都没进过**。记录层存在的意义是回答
 * > 「为什么什么都没发生」，而一次被拒的调用正是这个问题本身。
 * > 系统里没有别的东西留着它：拒绝以一条 tool message 到达模型，然后就没了。
 *
 * 建表**不重写**：`RECORDS_DDL` 由 `spec/golden/records_schema.sql` 生成，
 * 而那份金样是旧仓真实的 `ALL_DDL`。抄一份进 TS 就有了第二份，两份迟早漂开，
 * 而一张审计表跟丢一个列的症状是「查不到」，不是「崩了」。
 *
 * ## D-REC-1 · 没有实验时也记
 *
 * Python 的 `_record_v2_action` 开头是 `if repos is None or not eid: return None`
 * ——**没有活动实验就整条不记**。而 `actions.experiment_id` 是 NOT NULL 外键，
 * 所以这不是懒，是 schema 逼的。
 *
 * 可是「没有活动实验」恰恰是样品闸拒绝的**判据本身**：照抄的话，
 * 最该被记下来的那一类拒绝会一条都不留。所以我们种三行哨兵
 * （campaign / sample / experiment，id 全是 `_unscoped`），
 * 让每一次调用都有地方落。查询侧只要 `experiment_id = '_unscoped'` 就能把它们摘出来。
 *
 * ## D-REC-2 · `approval_source` 落在 `approvals` 表，不新增列
 *
 * v2 的 `actions` **没有** approval_source 列（v1 有）。不加列的理由是
 * `approvals` 已经能表达它，而且旧仓自己的注释说了为什么这张表必须写：
 *
 * > 审批链路割掉之后 approvals 会变成一张只有历史行的死表，而事后查
 * > 「这个 DANGEROUS 动作是谁准的」时，**空表和「没人准过」长得一模一样**
 * > —— 2026-07-27 的取证正好栽在这个形状上。
 *
 * 映射：`human` → `human_operator`/`gui_click`，`auto` → `automated_policy`/`policy_rule_v1`，
 * `llm` → **不写行**（模型不批准任何东西，它只是发起）。于是
 * 「没有 approvals 行」＝ llm，是可判的，不是缺失。
 */
import { DatabaseSync } from 'node:sqlite'
import { RECORDS_DDL } from './generated/schema.js'
import { HlcClock, ulid } from './ids.js'
import { RunLedger } from './ledger.js'

/** 没有实验归属的调用落在这里。三行哨兵的 id 都是它。 */
export const UNSCOPED = '_unscoped'

/** 内核结局 → `actions.status`。 */
export type OutcomeKind = 'ok' | 'failed' | 'refused' | 'aborted' | 'busy' | 'rolled_back'

/**
 * 拒绝、中止、占用全部落 `'failed'`——schema 的 CHECK 只认六个值，其中没有它们。
 *
 * 这不是信息丢失：区分留在 `error` 的**前缀**里（`[skill] precondition_failed:`、
 * `[sample_gate] …`、`[safety_gate] …`），而那个前缀本来就是机器读的——
 * StallGuard 按它聚合重复失败（见课时 2.12 的 `explainValidationError`）。
 * 加一个 `'refused'` 状态值会让我们的库和金样 schema 不一致，
 * 换来的只是一个已经能从前缀得到的答案。
 */
function statusOf(kind: OutcomeKind): string {
  if (kind === 'ok') return 'succeeded'
  if (kind === 'rolled_back') return 'rolled_back'
  return 'failed'
}

export interface ActionInput {
  readonly skill: string
  readonly params: Readonly<Record<string, unknown>>
  readonly kind: OutcomeKind
  /** 给模型的那段文本；非成功时进 `error` 列（截断到 2000，与旧仓一致）。 */
  readonly text?: string | undefined
  readonly elapsedMs?: number | undefined
  readonly stateDelta?: Readonly<Record<string, unknown>> | undefined
  readonly experimentId?: string | undefined
  readonly agentId?: string | undefined
  readonly threadId?: string | undefined
  readonly toolCallId?: string | undefined
  readonly parentActionId?: string | undefined
  readonly approvalSource?: 'llm' | 'human' | 'auto' | undefined
  /** 这次调用真的产出的文件。**只有成功才进账本。** */
  readonly artifacts?: readonly string[] | undefined
  /** 交叉核对账本的分桶键。 */
  readonly runId?: string | undefined
}

export interface RecordStoreOptions {
  /** 库文件路径；缺省 `:memory:`。 */
  readonly path?: string | undefined
  /** HLC 的节点名。 */
  readonly nodeId?: string | undefined
  readonly clock?: (() => number) | undefined
  readonly random?: (() => number) | undefined
}

export class RecordStore {
  readonly db: DatabaseSync
  readonly ledger = new RunLedger()
  private readonly hlc: HlcClock
  private readonly clock: () => number
  private readonly random: () => number

  constructor(opts: RecordStoreOptions = {}) {
    this.clock = opts.clock ?? Date.now
    this.random = opts.random ?? Math.random
    this.hlc = new HlcClock(opts.nodeId ?? 'IC', this.clock)
    this.db = new DatabaseSync(opts.path ?? ':memory:')
    // 外键**开着**（旧仓 repos.py 也开）：关着的话一个指向不存在实验的
    // action 会安静地写进去，而「有行但连不上」比没行更难查。
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(RECORDS_DDL)
    this.seedUnscoped()
  }

  /**
   * 三行哨兵。`INSERT OR IGNORE` ⇒ 重开同一个库文件时不会重复。
   *
   * ⚠️ `OR IGNORE` **连 CHECK 违规也一起吞**。写这段时把 campaigns.status 填成
   * 了不在 CHECK 里的 `'active'`，插入静默失败，错误直到下游插 experiments 时
   * 才以「外键失败」的形状冒出来 —— 离真正的原因隔了两张表。
   * 所以插完当场验一遍：种不上就当场炸，不要让它变成别处的怪病。
   */
  private seedUnscoped(): void {
    const at = this.hlc.now()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO campaigns
           (id, title, hypothesis, hypothesis_kind, goal_json, status, created_at, created_by)
         VALUES (?, '（无归属）', '（无归属的调用落在这里）', 'exploratory', '{}', 'draft', ?, 'system')`,
      )
      .run(UNSCOPED, at)
    this.db
      .prepare(`INSERT OR IGNORE INTO samples (id, label, material, created_at) VALUES (?, '（无归属）', '', ?)`)
      .run(UNSCOPED, at)
    this.db
      .prepare(
        `INSERT OR IGNORE INTO experiments
           (id, campaign_id, sample_id, title, exp_type, started_at)
         VALUES (?, ?, ?, '（无归属）', 'unscoped', ?)`,
      )
      .run(UNSCOPED, UNSCOPED, UNSCOPED, at)

    // ⚠️ 这一圈**没有输入能触发**：只有我自己把种子 SQL 写错时它才会响
    // （2026-09-10 就响过一次——`status: 'active'` 不在 CHECK 里）。
    // 变红演练把它拆掉，53 条测试全绿——它是构造期断言，不是运行期分支。
    // 留着的理由：它已经省过一次「隔着两张表的外键失败」，而代价是四行。
    for (const t of ['campaigns', 'samples', 'experiments']) {
      const row = this.db.prepare(`SELECT count(*) AS n FROM "${t}" WHERE id = ?`).get(UNSCOPED) as {
        n: number
      }
      if (row.n !== 1) throw new Error(`哨兵行没种上：${t}.${UNSCOPED}（多半是某个 CHECK 被 OR IGNORE 吞了）`)
    }
  }

  /**
   * 记一次调用，返回 action id。
   *
   * **永不抛**：记录坏掉不能变成技能坏掉（旧仓每一处都写着
   * `except Exception: # logging must never break the skill`）。
   * 返回 `null` 表示这一条没记下——调用方据此可以报警，但不会因此失败。
   */
  record(input: ActionInput): string | null {
    try {
      const id = ulid(this.clock(), this.random)
      const ok = input.kind === 'ok'
      // params 走一遍 JSON 往返：schema 的 `json_valid` CHECK 与四个生成列
      // （param_bias_v / param_setpoint_a / param_x_m / param_y_m）都靠它
      const paramsJson = safeJson(input.params) ?? '{}'
      const deltaJson = input.stateDelta === undefined ? null : safeJson(input.stateDelta)

      this.db
        .prepare(
          `INSERT INTO actions
             (id, experiment_id, parent_action_id, agent_id, action_type,
              thread_id, tool_call_id, params_json, state_delta_json,
              hlc, duration_ms, status, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.experimentId ?? UNSCOPED,
          input.parentActionId ?? null,
          input.agentId ?? 'instrument_control',
          input.skill,
          input.threadId ?? null,
          input.toolCallId ?? null,
          paramsJson,
          deltaJson,
          this.hlc.now(),
          input.elapsedMs === undefined ? null : Math.round(input.elapsedMs),
          statusOf(input.kind),
          ok ? null : (input.text ?? '').slice(0, 2000),
        )

      this.recordApproval(id, input.approvalSource ?? 'llm')

      if (input.runId !== undefined) {
        this.ledger.note(input.runId, input.skill, ok, input.artifacts ?? [])
      }
      return id
    } catch {
      return null
    }
  }

  /** `llm` 不写行——模型不批准任何东西，它只是发起。 */
  private recordApproval(actionId: string, source: 'llm' | 'human' | 'auto'): void {
    if (source === 'llm') return
    const [kind, method] =
      source === 'human'
        ? ['human_operator', 'gui_click']
        : ['automated_policy', 'policy_rule_v1']
    this.db
      .prepare(
        `INSERT OR IGNORE INTO approvals
           (id, action_id, approver_id, approver_kind, approval_method, approved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ulid(this.clock(), this.random), actionId, source, kind, method, this.hlc.now())
  }

  /**
   * 一次调用的批准来源，从库里读回来。
   *
   * **没有 approvals 行 ⇒ `'llm'`**，这是可判的，不是「查不到」。
   */
  approvalSourceOf(actionId: string): 'llm' | 'human' | 'auto' {
    const row = this.db
      .prepare('SELECT approver_kind FROM approvals WHERE action_id = ?')
      .get(actionId) as { approver_kind?: string } | undefined
    if (row?.approver_kind === 'human_operator') return 'human'
    if (row?.approver_kind === 'automated_policy') return 'auto'
    return 'llm'
  }

  close(): void {
    this.db.close()
  }
}

/** `default=str` 的等价物：序列化不了的值不能让整条记录消失。 */
function safeJson(v: unknown): string | null {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? String(val) : val)) ?? null
  } catch {
    return null
  }
}
