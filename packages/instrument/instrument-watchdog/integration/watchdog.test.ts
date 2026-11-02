/**
 * 看门狗对着**真 stmsim** 跑一遍。单测验命令序列，这里验的是另一件事：
 * 这些动词在真仪器上**真的都有回音**，而且急停真能把针退回去。
 *
 * 模拟器由 globalSetup 起在 16501–16504，所以这里 `spawn: false`。
 */
import { Context, Service, SystemPrompt } from 'dsh-spm-compat'
import { instrumentStateProvider } from 'dsh-spm-instrument-state'
import { stmsimProvider } from 'dsh-spm-instrument-stmsim'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { watchdogProvider } from '../src/index.js'

const PORTS = [16501, 16502, 16503, 16504]

/** 工具注册表的替身。instrument-state 的装载依赖之一。 */
class FakeTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(): () => void {
    return () => {}
  }
}

/** 命令注册表的替身——这里要验的是仪器那侧，不是 dsh 的命令运行时。 */
class FakeCommands extends Service {
  readonly registered: { name: string; handler: (i: unknown) => unknown }[] = []
  constructor(ctx: Context) {
    super(ctx, 'commands')
  }
  register(def: unknown): () => void {
    const d = def as { name: string; handler: (i: unknown) => unknown }
    this.registered.push(d)
    return () => void this.registered.splice(this.registered.indexOf(d), 1)
  }
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

function host(ctx: Context): FakeCommands {
  const cmd = new FakeCommands(ctx)
  // instrument-state 自己要 systemPrompt / tools —— 缺一件它就不装，
  // 而它不装，看门狗的 inject 也就不满足。这条链第一次跑就把我绊了一下。
  new FakeTools(ctx)
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  ctx.plugin(instrumentStateProvider, { intervalMs: 0 })
  cleanup.push(() => void ctx.registry.delete(watchdogProvider))
  cleanup.push(() => void ctx.registry.delete(instrumentStateProvider))
  cleanup.push(() => void ctx.registry.delete(stmsimProvider))
  return cmd
}

function svcOf(ctx: Context, timeoutMs = 10_000): Promise<Context['stmWatchdog']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.stmWatchdog 没挂上')), timeoutMs)
    ctx.inject(['stmWatchdog'], (c) => {
      clearTimeout(timer)
      resolve(c.stmWatchdog)
    })
  })
}

/** 前后置钩子直接问仪器用的口：只挂 `stmsimProvider`，不带看门狗。 */
interface Instrument {
  call(method: string, args: readonly unknown[]): Promise<{ values?: readonly unknown[] }>
}

async function withInstrument<T>(fn: (inst: Instrument) => Promise<T>): Promise<T> {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(stmsimProvider, { spawn: false, ports: PORTS })
  try {
    const inst = await new Promise<Instrument>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ctx.instrument 没挂上')), 10_000)
      ctx.inject(['instrument'], (c) => {
        clearTimeout(timer)
        resolve(c.instrument as unknown as Instrument)
      })
    })
    return await fn(inst)
  } finally {
    ctx.registry.delete(stmsimProvider)
  }
}

async function readFirst(inst: Instrument, method: string): Promise<number> {
  return Number(((await inst.call(method, [])).values ?? [])[0])
}

/** Z 反馈在这一组跑之前是什么样 —— 跑完放回去。 */
let zctrlWasOn: boolean | null = null

beforeAll(async () => {
  zctrlWasOn = await withInstrument(async (inst) => (await readFirst(inst, 'ZCtrl_OnOffGet')) !== 0)
}, 30_000)

// 后两条测试会退针（`ZCtrl_Withdraw`），而这台模拟器是整组集成测试共用的一台：不放回去，
// 后面要隧道结的文件读到的就是「针已撤回」（Z 谱的 Z-2 排在最后，正是这样红的）。
// 放回去的办法同 `coarse-composites.test.ts`：合上反馈，模拟器会从退针轨按 I 增益把 Z 伸出去重新找表面。
// 那一程实测约 2 s，所以这里等到电流回到设定值附近再走，最多等 20 s。
afterAll(async () => {
  if (zctrlWasOn !== true) return
  await withInstrument(async (inst) => {
    if ((await readFirst(inst, 'ZCtrl_OnOffGet')) !== 0) return
    await inst.call('ZCtrl_OnOffSet', [1])
    const setpointA = Math.abs(await readFirst(inst, 'ZCtrl_SetpntGet'))
    for (let waitedMs = 0; waitedMs < 20_000; waitedMs += 250) {
      if (Math.abs(await readFirst(inst, 'Current_Get')) > 0.5 * setpointA) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('合上 Z 反馈 20 s 后电流仍没回到设定值，针没放回去')
  })
}, 60_000)

describe('看门狗对真 stmsim', () => {
  it('正常隧道电流下一次都不开火', async () => {
    const ctx = new Context()
    host(ctx)
    // 阈值取一个远高于正常隧道电流的数：正常情况下不该有任何动作
    ctx.plugin(watchdogProvider, { intervalMs: 0, windowSize: 4, thresholdA: 1e-6 })
    const svc = await svcOf(ctx)
    const events: string[] = []
    svc.onEvent((e) => events.push(e.kind))

    for (let i = 0; i < 6; i++) await svc.tick()
    expect(events).not.toContain('fire')
    expect(svc.latched).toBe(false)
  })

  it('阈值压到隧道电流以下 ⇒ 窗口一满就退针，三个动词在真模拟器上都有回音', async () => {
    const ctx = new Context()
    host(ctx)
    // 把阈值压到 0 以上的极小值：任何非零电流都算贴轨，用来逼出完整的退针路径
    ctx.plugin(watchdogProvider, { intervalMs: 0, windowSize: 3, thresholdA: 1e-30 })
    const svc = await svcOf(ctx)
    const fired: { kind: string; result?: { confirmed: boolean; viaRole: string | null } }[] = []
    svc.onEvent((e) => fired.push(e as { kind: string; result?: { confirmed: boolean; viaRole: string | null } }))

    for (let i = 0; i < 3; i++) await svc.tick()

    expect(fired.map((e) => e.kind)).toContain('fire')
    const estop = fired.find((e) => e.kind === 'estop')
    expect(estop, '没走到 estop').toBeDefined()
    // stmsim 只实现 215/671；退针这三个动词必须都在里面，否则真机上这条路是死的
    expect(estop!.result!.confirmed, `退针没确认：${JSON.stringify(estop!.result)}`).toBe(true)
    expect(estop!.result!.viaRole).toBe('emergency')
    expect(svc.latched).toBe(true)
  })

  it('/estop 在真模拟器上把针退回去', async () => {
    const ctx = new Context()
    const cmd = host(ctx)
    ctx.plugin(watchdogProvider, { intervalMs: 0, thresholdA: 1e-6 })
    const svc = await svcOf(ctx)

    const estop = cmd.registered.find((c) => c.name === 'estop')
    expect(estop).toBeDefined()
    const out = (await estop!.handler({})) as { kind: string; text: string }
    expect(out.kind, out.text).toBe('success')
    expect(svc.latched).toBe(true)
  })
})
