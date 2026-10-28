/**
 * `ctx.instrument` —— 四个角色的连接池 + 一个共用熔断器 + 类型化门面。
 *
 * 三层各司其职，本文件只做**接线**：
 *   1.4 `RoleLink`（一条连接的单往返） · 1.5 `CommsCircuitBreaker`（该不该尝试） · 1.3 门面（类型）
 *
 * 看门狗与急停在课时 1.9，stmsim/fake provider 在 1.7。
 */
import {
  CONNECT_FAILED,
  CommsCircuitBreaker,
  ModuleOpenGrace,
  formatCommsDown,
  resendIsSafe,
  transportOfKind,
  withNotResentHint,
  type BreakerSnapshot,
  type TransportInfo,
} from 'dsh-spm-kernel'
import {
  RoleLink,
  RoleLinkError,
  createFacade,
  decodeReturns,
  encodeArgs,
  errorOnlyBody,
  parseErrorSection,
  type ArgValue,
  type NanonisFacade,
} from 'dsh-spm-nanonis-wire'
import { Service, type Context } from 'dsh-spm-compat'

/** 四个角色各占一个端口。分角色是为了让**急停永远不排在扫描后面**。 */
export const ROLES = ['main', 'monitor', 'data', 'emergency'] as const
export type Role = (typeof ROLES)[number]

/** 旧仓的端口约定：6501–6504 依次对应四个角色。 */
export const DEFAULT_PORTS: Readonly<Record<Role, number>> = {
  main: 6501,
  monitor: 6502,
  data: 6503,
  emergency: 6504,
}

/**
 * 一次调用的完整记录。**成败都产出它**——被拒绝的调用也要进记录（PLAN §3.2-4：闸门在记录之后）。
 *
 * `error` 一律带机器可判前缀，与 1.4 的 `RoleLinkError.kind` 同一套，另加两个本层产生的：
 * `comms_circuit_open:`（熔断短路，**没碰 socket**）与 `NanonisError:`（仪器自己拒绝，链路是好的）。
 */
export interface CallRecord {
  readonly method: string
  readonly command: string
  readonly role: Role
  readonly args: readonly ArgValue[]
  readonly values?: readonly unknown[]
  readonly error?: string
  readonly elapsedMs: number
  readonly at: number
  /** 是否为模拟器。真机与模拟器**只差这一位**，rigGuard 据此拒绝（PLAN §7.1）。 */
  readonly simulated: boolean
  /**
   * 这次失败发生在**传输层**（超时、空回包、回声不符、socket 出错、没连上），不是控制器答了一个错误。
   * 只有 `RoleLinkError` 会带它：忙锁、熔断短路、仪器拒绝、编码出错、宿主合成的记录都不带。
   * 谱学技能据此对幂等调用隔一会儿重做一次（`l0/idempotent.ts`）；这一层一律不重发。
   */
  readonly transport?: TransportInfo | undefined
}

export interface CallOptions {
  readonly role?: Role
  readonly timeoutMs?: number
  readonly lockTimeoutMs?: number
  /** 高频只读（1 Hz 状态缓存、20 Hz 示波器）传 false，不进熔断记账。 */
  readonly countHealth?: boolean
}

/** 建一条连接。1.7 的 provider 就是换掉这个工厂（`useTransport` 的最小诚实形态）。 */
export type LinkFactory = (role: Role, port: number) => RoleLink

export interface InstrumentConfig {
  readonly ports?: Partial<Record<Role, number>>
  readonly simulated?: boolean
  readonly createLink?: LinkFactory
  readonly clock?: () => number
}

interface MethodSpecLike {
  readonly command: string
  readonly args: readonly { readonly name: string; readonly fmt: string }[]
  readonly returns: readonly string[]
}

export class InstrumentService extends Service {
  private readonly ports: Record<Role, number>
  private readonly links = new Map<Role, RoleLink>()
  private readonly createLink: LinkFactory
  private readonly recordListeners = new Set<(r: CallRecord) => void>()
  /** **四个角色共用一个**熔断器——链路是一条，不是四条（PLAN §7.1）。 */
  readonly breaker: CommsCircuitBreaker
  /** 模块首次加载的宽限：`*_Open` 与同角色紧跟它的那一条多等一会儿。与熔断器用同一个时钟。 */
  private readonly grace: ModuleOpenGrace
  readonly simulated: boolean
  readonly typed: NanonisFacade

  constructor(
    ctx: Context,
    /** 方法名 → 线协议规格。生产用 1.3 生成的 `NANONIS_METHODS`；测试可注入子集。 */
    private readonly methods: Readonly<Record<string, MethodSpecLike>>,
    config: InstrumentConfig = {},
  ) {
    super(ctx, 'instrument')
    this.ports = { ...DEFAULT_PORTS, ...config.ports }
    this.simulated = config.simulated ?? false
    this.createLink = config.createLink ?? ((_role, port) => new RoleLink({ port }))
    const clock = config.clock ?? ((): number => performance.now() / 1000)
    this.breaker = new CommsCircuitBreaker({ clock })
    this.grace = new ModuleOpenGrace(clock)
    this.typed = createFacade(async (command, args, returns) => {
      const method = Object.keys(this.methods).find((m) => this.methods[m]!.command === command)
      const rec = await this.callRaw(method ?? command, command, args, returns, {})
      if (rec.error !== undefined) throw new Error(rec.error)
      return [...(rec.values ?? [])]
    })
  }

  /** 按名字调一个方法。**永不抛**——失败也回一条 `CallRecord`（PLAN §7.1 的「不抛」约定）。 */
  async call(method: string, args: readonly unknown[], opts: CallOptions = {}): Promise<CallRecord> {
    const spec = this.methods[method]
    if (spec === undefined) {
      return this.emit({
        method,
        command: method,
        role: opts.role ?? 'main',
        args: [],
        error: `UnknownMethod: 协议表里没有 ${method}`,
        elapsedMs: 0,
        at: Date.now(),
        simulated: this.simulated,
      })
    }
    const argValues = spec.args.map((a, i) => ({ value: args[i], fmt: a.fmt }))
    return this.callRaw(method, spec.command, argValues, spec.returns, opts).catch((e: unknown) =>
      this.emit({
        method,
        command: spec.command,
        role: opts.role ?? 'main',
        args: argValues,
        error: `Unexpected: ${(e as Error).message}`,
        elapsedMs: 0,
        at: Date.now(),
        simulated: this.simulated,
      }),
    )
  }

  /**
   * 急停通道：走 `emergency` 角色、**只等 2 秒锁**、且**绕过熔断**。
   *
   * 绕过熔断是有意的：熔断的意义是别对着死链路磕头，但退针命令值得**试一次**——
   * 万一链路刚好恢复了呢。试一次的代价是 5 秒，不试的代价是针还扎在样品上。
   */
  urgentCall(method: string, args: readonly unknown[] = []): Promise<CallRecord> {
    return this.call(method, args, { role: 'emergency', lockTimeoutMs: 2_000, countHealth: false })
  }

  private async callRaw(
    method: string,
    command: string,
    args: readonly ArgValue[],
    returns: readonly string[],
    opts: CallOptions,
  ): Promise<CallRecord> {
    const role = opts.role ?? 'main'
    const countHealth = opts.countHealth ?? true
    const started = Date.now()
    const base = { method, command, role, args, at: started, simulated: this.simulated }
    const done = (extra: Partial<CallRecord>): CallRecord =>
      this.emit({ ...base, elapsedMs: Date.now() - started, ...extra } as CallRecord)

    // 熔断短路：**不碰 socket**。急停（countHealth=false 且走 emergency）不受它挡。
    if (countHealth && role !== 'emergency' && !this.breaker.allow()) {
      return done({ error: formatCommsDown(this.breaker) })
    }

    let link: RoleLink
    try {
      link = await this.linkFor(role)
    } catch (e) {
      if (countHealth) this.breaker.recordFailure((e as Error).message)
      // 连不上：命令没发出去。只有传输层自己的连接失败才算传输失败；宿主在建连时做的检查
      // （例如原生模拟器的身份校验）拒绝的不算。
      return done({ error: (e as Error).message, ...(e instanceof RoleLinkError ? { transport: CONNECT_FAILED } : {}) })
    }

    // 模块首次加载的宽限：`*_Open` 与同角色紧跟它的那一条至少等 30 s。只延长等待，不重发。
    const timeoutMs = this.grace.budgetMs(role, method, opts.timeoutMs)
    try {
      const body = await link.request(command, encodeArgs(args), {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(opts.lockTimeoutMs !== undefined ? { waitMs: opts.lockTimeoutMs } : {}),
      })
      // **一次完整往返 = 链路成功**，哪怕仪器说「模块没加载」（1.5 的 app-error 规则）
      if (countHealth) this.breaker.recordSuccess()

      // 先问「是不是只有错误段」。被拒绝的回复里**没有**声明的返回字段——
      // 直接拿 returns 去解，只会把错误段的头 4 字节当成一个 float 读走。
      const rejected = errorOnlyBody(body)
      if (rejected !== null) {
        if (rejected.status !== 0) return done({ error: `NanonisError: ${rejected.description}` })
        this.grace.noteSuccess(role, method)
        return done({ values: [] }) // 无返回字段的方法：成功也是 error-only 形状
      }

      const { values, errorSection } = decodeReturns(body, returns)
      const err = parseErrorSection(errorSection)
      if (err.status !== 0) return done({ error: `NanonisError: ${err.description}` })
      this.grace.noteSuccess(role, method)
      return done({ values })
    } catch (e) {
      const message = (e as Error).message
      // 这一层对任何命令都不重发（见 spec/deviations.md D-CONN-?）。命令可能已经送达、而它每到
      // 一次就做一次事时，在错误里说清楚，让调用方先读状态再决定。只有 `RoleLinkError` 带标记：
      // 编码出错之类的异常重做也没用。
      const transport = e instanceof RoleLinkError ? transportOfKind(e.kind) : undefined
      const error =
        transport?.maybeDelivered === true && !resendIsSafe(method, args.map((a) => a.value))
          ? withNotResentHint(message)
          : message
      const kind = e instanceof RoleLinkError ? e.kind : 'SocketError'
      // `RoleBusy` 是「现在有人在用」，不是链路坏了——不记熔断，否则一次并发争抢就能熔断链路。
      // 熔断记的是原文：提示只给调用方看，不该进 `lastReason`。
      if (countHealth && kind !== 'RoleBusy') this.breaker.recordFailure(message)
      return done({ error, ...(transport === undefined ? {} : { transport }) })
    }
  }

  private async linkFor(role: Role): Promise<RoleLink> {
    let link = this.links.get(role)
    if (link === undefined || !link.connected) {
      link = this.createLink(role, this.ports[role])
      await link.connect()
      this.links.set(role, link)
    }
    return link
  }

  private emit(record: CallRecord): CallRecord {
    for (const fn of this.recordListeners) fn(record)
    return record
  }

  /** records 与差分测试的挂点（PLAN §7.1）。返回取消登记的函数。 */
  onRecord(fn: (r: CallRecord) => void): () => void {
    this.recordListeners.add(fn)
    return () => this.recordListeners.delete(fn)
  }

  async connectAll(): Promise<void> {
    for (const role of ROLES) await this.linkFor(role)
  }

  /** 逐角色**优雅**关闭。强杀会永久损坏端口（1.4 那条硬约束）。 */
  async closeAll(): Promise<void> {
    for (const [, link] of this.links) await link.close()
    this.links.clear()
  }

  /** 主动断掉一个角色（`urgentCall` 拿不到锁时用；1.6 只提供，1.9 才会调）。 */
  async breakRole(role: Role, _why = ''): Promise<void> {
    const link = this.links.get(role)
    this.links.delete(role)
    if (link !== undefined) await link.close(0)
  }

  comms(): BreakerSnapshot {
    return this.breaker.snapshot()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    instrument: InstrumentService
  }
}
