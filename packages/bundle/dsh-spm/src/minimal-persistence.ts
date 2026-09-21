import { appendFileSync } from 'node:fs'
import type { KernelRecord } from 'dsh-spm-kernel'
import type { RecordsService } from 'dsh-spm-stm-records'
import type { CallRecord } from 'dsh-spm-instrument'

export interface MinimalResultRecord {
  readonly version: 1
  readonly at: string
  readonly toolCallId: string
  readonly skill: string
  readonly kind: string
  readonly text: string
  readonly data?: Readonly<Record<string, unknown>>
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
    const line: MinimalResultRecord = {
      version: 1,
      at: new Date().toISOString(),
      toolCallId: callId,
      skill: rec.spec.name,
      kind: rec.outcome.kind,
      text: rec.outcome.text,
      instrumentCalls: this.calls.get(callId) ?? [],
      ...(rec.outcome.data === undefined ? {} : { data: rec.outcome.data }),
    }
    try {
      appendFileSync(this.resultsPath, JSON.stringify(line) + '\n', 'utf8')
      this.results.set(callId, line)
      this.status.set(callId, true)
    } catch {
      this.status.set(callId, false)
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
