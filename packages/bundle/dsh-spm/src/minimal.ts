/**
 * 最小运行栈：受管 STM-Bench 只读入口，或显式核验的本机 Nanonis 模拟器启停入口。
 *
 * 这里的名单有意是闭的。新增技能必须在本文件逐项评审；不能把完整技能注册表
 * 动态铺给模型。
 */
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, resolve } from 'node:path'
import { type Context, Service, type ToolDefinition } from 'dsh-spm-compat'
import { InstrumentService, type CallOptions, type CallRecord } from 'dsh-spm-instrument'
import { InstrumentStateService } from 'dsh-spm-instrument-state'
import { StmsimProcess, type StmsimOptions, portsByRole } from 'dsh-spm-instrument-stmsim'
import { TipWatchdogService } from 'dsh-spm-instrument-watchdog'
import { SkillKernel, type Skill } from 'dsh-spm-kernel'
import { NANONIS_METHODS } from 'dsh-spm-nanonis-wire'
import { RecordsService } from 'dsh-spm-stm-records'
import { StmSafetyService } from 'dsh-spm-stm-safety'
import { GetBias, defineSkillTool, gatedSafeCall } from 'dsh-spm-stm-skills'
import { MinimalPersistence, type MinimalResultRecord } from './minimal-persistence.js'
import { NativeSimulatorConnection, NativeSimulatorInstrument, type NativeSimulatorOptions } from './native-simulator.js'
import { NATIVE_SKILLS, formatNativeToolText } from './native-skills.js'

export const name = 'dsh-spm-minimal-runtime'

/** dsh 提供这三项；其余服务由本插件按固定顺序创建。 */
export const inject = ['tools', 'systemPrompt', 'commands']
export const MINIMAL_TOOL_NAMES = ['GetBias'] as const
export const NATIVE_TOOL_NAMES = NATIVE_SKILLS.map((skill) => skill.spec.name)

export function assertPersisted(persistence: MinimalPersistence, callId: string): void {
  if (!persistence.finish(callId)) {
    throw new Error(`persistence_failed: 工具调用 ${callId} 的 SQLite/JSONL 证据没有完整落盘`)
  }
}

/** GetBias 的模型可见文本必须携带测量值和单位，不能只说 “ok”。 */
export function formatMinimalToolText(record: MinimalResultRecord | undefined, fallback: unknown): unknown {
  return formatNativeToolText(record, fallback)
}

export interface Config extends StmsimOptions {
  /** 显式接入已运行的本机 Nanonis STM Simulator；退出只断开本插件。 */
  readonly nativeSimulator?: NativeSimulatorOptions
  /** SQLite 动作记录。相对路径按 dsh 启动目录解析。 */
  readonly recordsPath?: string
  /** 带工具调用 id 和完整结果数据的 JSONL。相对路径按 dsh 启动目录解析。 */
  readonly resultsPath?: string
  readonly runId?: string
  readonly stateIntervalMs?: number
  readonly watchdogIntervalMs?: number
}

function diskPath(value: string | undefined, fallback: string): string {
  const path = resolve(value ?? fallback)
  mkdirSync(dirname(path), { recursive: true })
  // 激活前即验证目录与文件可写；不能等第一次工具成功后才发现证据没落盘。
  closeSync(openSync(path, 'a'))
  return path
}

export class MinimalSpmService extends Service {
  readonly recordsPath: string
  readonly resultsPath: string

  constructor(
    ctx: Context,
    readonly simulator: StmsimProcess | NativeSimulatorConnection,
    readonly instrument: InstrumentService,
    paths: { recordsPath: string; resultsPath: string },
  ) {
    super(ctx, 'minimalSpm')
    this.recordsPath = paths.recordsPath
    this.resultsPath = paths.resultsPath
  }

  /** 受管模式停止子进程；本机模式仅解除连接许可，从不终止用户进程。 */
  stopSimulator(): Promise<void> {
    return this.simulator.stop()
  }
}

/** 所有角色（含状态轮询与看门狗）都必须受本轮进程存活条件约束。 */
export class ManagedSimulatorInstrument extends InstrumentService {
  constructor(ctx: Context, private readonly simulator: StmsimProcess) {
    super(ctx, NANONIS_METHODS, { ports: portsByRole(simulator.ports), simulated: true })
  }

  override call(method: string, args: readonly unknown[], opts: CallOptions = {}): Promise<CallRecord> {
    if (!this.simulator.running) return Promise.resolve(this.stopped(method, args, opts))
    return super.call(method, args, opts)
  }

  override urgentCall(method: string, args: readonly unknown[] = []): Promise<CallRecord> {
    if (!this.simulator.running) return Promise.resolve(this.stopped(method, args, { role: 'emergency' }))
    return super.urgentCall(method, args)
  }

  private stopped(method: string, args: readonly unknown[], opts: CallOptions): CallRecord {
    return {
      method,
      command: method,
      role: opts.role ?? 'main',
      args: args.map((value) => ({ value, fmt: '' })),
      error: 'managed_simulator_stopped: 本插件拥有的 stmsim 已停止，拒绝连接替代监听者或返回旧状态。',
      elapsedMs: 0,
      at: Date.now(),
      simulated: true,
    }
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const recordsPath = diskPath(config.recordsPath, '.dsh-spm/records.sqlite')
  const resultsPath = diskPath(config.resultsPath, '.dsh-spm/tool-results.jsonl')

  const native = config.nativeSimulator === undefined ? undefined : new NativeSimulatorConnection(config.nativeSimulator)
  const simulator = native ?? new StmsimProcess(config)
  await simulator.start()
  const inFlight = new Set<Promise<unknown>>()
  let instrument: InstrumentService | undefined
  let activated = false
  try {
    await simulator.assertOwned()
    instrument = native === undefined
      ? new ManagedSimulatorInstrument(ctx, simulator as StmsimProcess)
      : new NativeSimulatorInstrument(ctx, native)
    const connectedInstrument = instrument
    new MinimalSpmService(ctx, simulator, instrument, { recordsPath, resultsPath })

    // Cordis disposes effects concurrently. Drain tools before dropping transport,
    // and give the record service the same barrier before it closes SQLite.
    ctx.effect(() => async () => {
      await Promise.allSettled([...inFlight])
      await connectedInstrument.closeAll()
      await simulator.stop()
    })
    const records = new RecordsService(ctx, { path: recordsPath, runId: config.runId ?? 'minimal' },
      async () => { await Promise.allSettled([...inFlight]) })
    // Native mode refreshes only on demand. No hidden automatic retract writes.
    const state = new InstrumentStateService(ctx, { intervalMs: native ? 0 : (config.stateIntervalMs ?? 1_000) })
    const watchdog = native ? undefined : new TipWatchdogService(ctx, { intervalMs: config.watchdogIntervalMs ?? 500 })
    const safety = new StmSafetyService(ctx)
    const persistence = new MinimalPersistence(records, resultsPath, config.runId ?? 'minimal')
    const callScope = new AsyncLocalStorage<{ id: string; signal: AbortSignal }>()
    let nativeTail: Promise<unknown> = Promise.resolve()

    const call = gatedSafeCall({
      abortLatched: () => watchdog?.latched ?? false,
      call: async (method, ...args) => {
        const scope = callScope.getStore()
        const result: CallRecord = native && scope?.signal.aborted ? {
          method, command: method, role: 'main', args: [],
          error: 'native_simulator_aborted: 本次调用已取消，未发送仪器命令。',
          at: Date.now(), elapsedMs: 0, simulated: true,
        } : await connectedInstrument.call(method, args)
        persistence.trace(scope?.id, result)
        return result
      },
    })

    const kernel = new SkillKernel({
      snapshot: () => state.snapshot(),
      refreshState: async () => {
        if (native) await native.assertCurrent()
        return state.refresh()
      },
      applyPatch: (fields) => state.applyPatch(fields),
      abortLatched: () => watchdog?.latched ?? false,
      safetyGate: (spec, params) => {
        const verdict = safety.decide(spec.name, params, { approvalSource: 'llm' })
        return verdict.kind === 'allow' ? null : verdict.reason
      },
      safeCall: call,
      emergencyCall: (method, ...args) => connectedInstrument.urgentCall(method, args),
      record: persistence.record,
    })

    if (native) {
      ctx.effect(() => ctx.systemPrompt.section({
        name: 'native-nanonis-simulator', order: 200,
        text: '已接入本机 Nanonis STM Simulator。只提供偏压、电流、Z 位置、扫描状态、设置偏压、单帧扫描启停。' +
          '依照用户请求逐步调用工具。设置偏压和扫描启停均回读确认。读数必须引用本次工具结果，失败时不得声称成功。' +
          'StartScan 要求操作员已在 Nanonis 中开启 Z 反馈，不支持持续扫描覆盖。关闭本会话只断开连接，不关闭模拟器。',
      }))
    }
    for (const original of native ? NATIVE_SKILLS : [GetBias]) {
      // Check the OS identity for every tool invocation, within the kernel so
      // failures also pass through its durable recording path.
      const skill: Skill = native ? {
        ...original,
        execute: async (context, params) => {
          if (context.signal.aborted) return { success: false, error: 'native_simulator_aborted: 本次调用已取消。' }
          try { await native.assertCurrent() } catch (error) {
            return { success: false, error: String(error) }
          }
          if (context.signal.aborted) return { success: false, error: 'native_simulator_aborted: 本次调用已取消。' }
          return original.execute(context, params)
        },
      } : original
      const unregisterDeclaration = safety.registerSkill(skill.spec)
      const base = defineSkillTool(skill, { kernel })
      const execute = base.execute.bind(base)
      const durableTool: ToolDefinition = {
        ...base,
        execute: (args, exec) => {
          persistence.begin(exec.rootCallId)
          const run = () => callScope.run({ id: exec.rootCallId, signal: exec.signal }, async (): Promise<unknown> => {
            const text = await execute(args, exec)
            assertPersisted(persistence, exec.rootCallId)
            return formatMinimalToolText(persistence.takeResult(exec.rootCallId), text)
          })
          // A write and its readback form one transaction relative to other
          // model tools; parallel SetBias calls must not cross their readbacks.
          const running = native ? nativeTail.then(run, run) : run()
          if (native) nativeTail = running.catch(() => {})
          inFlight.add(running)
          void running.finally(() => inFlight.delete(running)).catch(() => {})
          return running
        },
      }
      ctx.effect(() => {
        const unregisterTool = ctx.tools.register(durableTool)
        return async () => {
          unregisterTool()
          await Promise.allSettled([...inFlight])
          unregisterDeclaration()
        }
      })
    }
    activated = true
  } finally {
    if (!activated) {
      await instrument?.closeAll()
      await simulator.stop()
    }
  }
}

export const minimalProvider = { name, inject, apply }

declare module '@deepseek-ai/cordis' {
  interface Context {
    minimalSpm: MinimalSpmService
  }
}
