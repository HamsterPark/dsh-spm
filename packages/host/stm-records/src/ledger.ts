/**
 * RunLedger —— 本次运行**真的做了什么**的内存账本。
 *
 * 它是 `claim-audit` 的另一半：审计需要一份「记录说跑了什么」，而这份东西在
 * 2026-07-27 之前根本不存在——所以当 agent 报告一次没发生的测量时，
 * **没有任何东西能反驳它**。
 *
 * 刻意是**有界的缓冲**，不是日志：
 * - 只留最近 8 次运行（durable 的那份在 SQLite 里，这里只是交叉核对用）；
 * - 每次运行最多 500 条技能名 / 500 条产物路径；
 * - **只有成功的调用才能贡献产物**——一个失败技能「本该写出」的路径，
 *   正是最不该拿去佐证声明的东西。
 * - **永不抛**。账本坏掉不能变成技能坏掉。
 */
export interface RunEntry {
  readonly skills: string[]
  readonly artifacts: string[]
}

const MAX_RUNS = 8
const MAX_PER_RUN = 500

export class RunLedger {
  /** 插入序即最近使用序：Map 保序，这正是「留最近 8 次」要的。 */
  private readonly runs = new Map<string, RunEntry>()

  /** 记一次技能调用。`success` 决定它能不能贡献产物。 */
  note(runId: string, skill: string, success: boolean, artifacts: readonly string[] = []): void {
    try {
      let entry = this.runs.get(runId)
      if (entry === undefined) {
        // 新运行出现时才淘汰，和 Python 的 `list(led)[:-7]` 同一时机
        while (this.runs.size >= MAX_RUNS) {
          const oldest = this.runs.keys().next()
          if (oldest.done === true) break
          this.runs.delete(oldest.value)
        }
        entry = { skills: [], artifacts: [] }
        this.runs.set(runId, entry)
      }
      if (skill !== '') {
        entry.skills.push(skill)
        if (entry.skills.length > MAX_PER_RUN) entry.skills.splice(0, entry.skills.length - MAX_PER_RUN)
      }
      if (success) {
        entry.artifacts.push(...artifacts)
        if (entry.artifacts.length > MAX_PER_RUN) {
          entry.artifacts.splice(0, entry.artifacts.length - MAX_PER_RUN)
        }
      }
    } catch {
      // 账本永不打断技能
    }
  }

  /**
   * 这次运行的记录。**没有这次运行时返回 `undefined`，不是空条目**——
   * 「不知道」和「什么都没跑」是两个答案，`auditClaim` 对它们的处理完全不同。
   */
  get(runId: string): RunEntry | undefined {
    const e = this.runs.get(runId)
    return e === undefined ? undefined : { skills: [...e.skills], artifacts: [...e.artifacts] }
  }

  /** 当前留着的运行 id，最旧在前。 */
  runIds(): string[] {
    return [...this.runs.keys()]
  }
}
