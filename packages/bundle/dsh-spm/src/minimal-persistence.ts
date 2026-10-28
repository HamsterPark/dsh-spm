import { appendFileSync } from 'node:fs'
import type { KernelRecord, SkillObservation } from 'dsh-spm-kernel'
import type { RecordsService } from 'dsh-spm-stm-records'
import type { CallRecord } from 'dsh-spm-instrument'

export interface MinimalResultRecord {
  readonly version: 1
  readonly at: string
  readonly toolCallId: string
  readonly skill: string
  /** 内核的结局；一动一观闸门拒掉的调用是 `refused`（内核没跑，`instrumentCalls` 为空）。 */
  readonly kind: string
  readonly text: string
  readonly data?: Readonly<Record<string, unknown>>
  /** 视觉线束挂着时 K14 这次入档与出图的帧；没挂、或没有可报的观测时缺席。 */
  readonly observation?: SkillObservation
  readonly instrumentCalls: readonly CallRecord[]
}

/** 同步写两份证据，并让工具包装层能判定这次调用是否完整落盘。 */
export class MinimalPersistence {
  private readonly status = new Map<string, boolean>()
  private readonly results = new Map<string, MinimalResultRecord>()
  private readonly calls = new Map<string, CallRecord[]>()

  constructor(
    private readonly records: RecordsService,
    private readonly resultsPath: string,
    private readonly runId: string,
  ) {}

  begin(callId: string): void {
    this.status.delete(callId)
    this.results.delete(callId)
    this.calls.set(callId, [])
  }

  trace(callId: string | undefined, call: CallRecord): void {
    if (callId !== undefined) this.calls.get(callId)?.push(call)
  }

  record = (rec: KernelRecord): void => {
    const callId = rec.rootCallId ?? rec.outcome.argsHash
    const actionId = this.records.store.record({
      skill: rec.spec.name,
      params: rec.params,
      kind: rec.outcome.kind,
      text: rec.outcome.text,
      elapsedMs: rec.outcome.elapsedMs,
      stateDelta: rec.outcome.stateDelta,
      approvalSource: rec.approvalSource,
      agentId: rec.owner ?? 'instrument_control',
      toolCallId: callId,
      runId: this.runId,
    })
    if (actionId === null) {
      this.status.set(callId, false)
      return
    }
    // 子步（depth ≥ 1，例如 BiasSettleChange 里的 SetBias / SetBiasRamp）与顶层共用同一个调用 id，
    // 并且先于顶层完成。SQLite 照记（审计），JSONL 与结果只留顶层那一行：验收脚本按调用 id 取第一行，
    // 子步的行排在前面就会取错。子步在仪器上做过什么，都在顶层那一行的 instrumentCalls 里。
    if (rec.depth > 0) return
    const line: MinimalResultRecord = {
      version: 1,
      at: new Date().toISOString(),
      toolCallId: callId,
      skill: rec.spec.name,
      kind: rec.outcome.kind,
      text: rec.outcome.text,
      instrumentCalls: this.calls.get(callId) ?? [],
      ...(rec.outcome.data === undefined ? {} : { data: rec.outcome.data }),
      ...(rec.outcome.observation === undefined ? {} : { observation: rec.outcome.observation }),
    }
    let stored = false
    try {
      appendFileSync(this.resultsPath, JSON.stringify(line) + '\n', 'utf8')
      this.results.set(callId, line)
      stored = true
    } catch {
      // 落盘失败：stored 保持 false
    }
    // 累积而不是覆盖：子步先写，它的 SQLite 失败已经把状态置为 false，顶层成功不能把它盖回 true
    this.status.set(callId, this.status.get(callId) !== false && stored)
  }

  /**
   * 一动一观闸门拒掉的调用：内核没跑，所以 `record` 不会来。闸门自己往 SQLite 记了一行
   * （`ctx.stmRecords`），这里补上 JSONL 那一行，两份证据仍按调用 id 一一对应。
   * 返回是否落盘；落不了盘不改变拒绝本身。
   */
  refused(callId: string, skill: string, text: string): boolean {
    const line: MinimalResultRecord = {
      version: 1,
      at: new Date().toISOString(),
      toolCallId: callId,
      skill,
      kind: 'refused',
      text,
      instrumentCalls: [],
    }
    try {
      appendFileSync(this.resultsPath, JSON.stringify(line) + '\n', 'utf8')
      return true
    } catch {
      return false
    }
  }

  finish(callId: string): boolean {
    const ok = this.status.get(callId) === true
    this.status.delete(callId)
    this.calls.delete(callId)
    return ok
  }

  takeResult(callId: string): MinimalResultRecord | undefined {
    const result = this.results.get(callId)
    this.results.delete(callId)
    return result
  }
}
