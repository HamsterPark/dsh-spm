/**
 * `ctx.stmRecords` —— 记录库服务。
 *
 * 这一层只做接线：**库开在哪**、**卸载时关掉**、以及把 `KernelDeps.record` 需要的
 * 那个回调准备好。判据全在 `store.ts` / `ledger.ts` / `claim-audit.ts`，
 * 那三处零 dsh 依赖、由金样与单测驱动。
 *
 * 两处刻意的选择：
 *
 * 1. **卸载时 `close()` 走 `ctx.effect`**。SQLite 的写在 WAL/journal 里，
 *    进程被拔掉时未关的库要走恢复流程；而记录库的全部意义是**事后还读得到**。
 * 2. **`record` 是一个方法，不是事件**。事件会让「有没有人在听」变成一个运行期问题，
 *    而 K16 的语义是「每一个结局都落一行」——它不该取决于订阅者在不在。
 */
import { type Context, Service } from 'dsh-spm-compat'
import type { KernelRecord } from 'dsh-spm-kernel'
import { RecordStore, type ActionInput, type RecordStoreOptions } from './store.js'

export const name = 'mast-records'

export interface Config extends RecordStoreOptions {
  /** 这一轮的 run id，交叉核对账本按它分桶。缺省 `'default'`。 */
  readonly runId?: string
}

export class RecordsService extends Service {
  readonly store: RecordStore
  private readonly runId: string

  constructor(ctx: Context, config: Config = {}, beforeClose?: () => Promise<void>) {
    super(ctx, 'stmRecords')
    this.runId = config.runId ?? 'default'
    this.store = new RecordStore(config)
    ctx.effect(() => () => {
      // Cordis disposes independent effects concurrently. A runtime with in-flight
      // calls supplies its drain barrier explicitly; effect registration order
      // alone cannot keep this database open until the final record is written.
      if (beforeClose !== undefined) return beforeClose().finally(() => this.store.close())
      this.store.close()
    })
  }

  /** 直接记一条（内部调用者、命令路径用）。 */
  record(input: ActionInput): string | null {
    return this.store.record(input)
  }

  /**
   * 交给 `KernelDeps.record` 的那个回调。
   *
   * 内核的 `finish()` 是每一个结局的唯一出口，所以接在这里
   * 「被拒的也记」是结构性的，不靠谁记得在某个 return 前面补一笔。
   */
  fromKernel = (rec: KernelRecord): void => {
    this.store.record({
      skill: rec.spec.name,
      params: rec.params,
      kind: rec.outcome.kind,
      text: rec.outcome.text,
      elapsedMs: rec.outcome.elapsedMs,
      stateDelta: rec.outcome.stateDelta,
      approvalSource: rec.approvalSource,
      agentId: rec.owner ?? 'instrument_control',
      toolCallId: rec.rootCallId,
      runId: this.runId,
    })
  }

  /** 这一轮记录说真的跑了什么。**没有这一轮时是 `undefined`，不是空条目。** */
  runEntry(runId: string = this.runId): { skills: string[]; artifacts: string[] } | undefined {
    const e = this.store.ledger.get(runId)
    return e === undefined ? undefined : { skills: [...e.skills], artifacts: [...e.artifacts] }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    stmRecords: RecordsService
  }
}

/**
 * **直接构造，不再 `ctx.plugin(RecordsService)` 套一层。**
 *
 * 套一层的话 Service 里的 `ctx.effect` 挂在的是那个**嵌套**插件的上下文上，
 * 而 `registry.delete(本模块)` 卸的是外层——实测回滚不跑，库一直开着。
 * 症状很轻（一个没关的 SQLite 句柄），但记录库的全部意义是事后还读得到，
 * 而未关的库要走恢复流程。仓里另外两个服务插件也是这么写的。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const svc = new RecordsService(ctx, config)
  void svc
}

export const recordsProvider = { name, apply }
