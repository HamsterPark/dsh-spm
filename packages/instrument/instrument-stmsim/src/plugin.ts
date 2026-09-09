/**
 * 把 stmsim 装成一个 Cordis 插件：起模拟器 + 提供 `ctx.instrument`。
 *
 * **`simulated: true` 是这里唯一真正重要的一位**。真机与模拟器在上层看只差这一位，
 * 将来的 `rigGuard` 就靠它拒绝「在模拟 profile 上碰真机」与反过来（PLAN §7.1）。
 *
 * 生命周期交给 `ctx.effect`：它登记的东西在插件卸载时**自动回滚**，所以 profile 一卸载、
 * HMR 一重载，模拟器进程就跟着停——不用谁记得去收尾。
 */
import { NANONIS_METHODS } from 'dsh-spm-nanonis-wire'
import { InstrumentService, type Role } from 'dsh-spm-instrument'
import { type Context } from 'dsh-spm-compat'
import { StmsimProcess, type StmsimOptions } from './process.js'

export const name = 'mast-instrument-stmsim'

export interface Config extends StmsimOptions {
  /** 只想用已经在跑的模拟器（比如手工起的）就设 false，插件不再自己 spawn。 */
  readonly spawn?: boolean
}

/** 四个端口按 main/monitor/data/emergency 顺序对上角色。 */
export function portsByRole(ports: readonly number[]): Record<Role, number> {
  const [main, monitor, data, emergency] = ports
  return { main: main!, monitor: monitor!, data: data!, emergency: emergency! }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const sim = new StmsimProcess(config)
  if (config.spawn !== false) {
    await sim.start()
    // 回滚在插件卸载时跑。不用 effect 的话，卸载后模拟器还活着占着四个端口。
    // disposer 把 Promise 交回去，cordis 会等它——于是「插件卸载完成」真的意味着进程已退
    ctx.effect(() => () => sim.stop())
  }
  new InstrumentService(ctx, NANONIS_METHODS, {
    ports: portsByRole(sim.ports),
    simulated: true,
  })
}

/**
 * 插件对象形态——这才是 dsh/Cordis 真正装载我们的方式：
 * `ctx.plugin(stmsimProvider, config)` 装，`ctx.registry.delete(stmsimProvider)` 卸。
 *
 * 卸载时 `apply` 里 `ctx.effect` 登记的回滚会自动跑，模拟器跟着停——**不靠谁记得收尾**。
 * （根 `Context` 上没有公开的 `stop`/`dispose`；生命周期的粒度是**插件**，不是上下文。）
 */
export const stmsimProvider = { name, apply }
