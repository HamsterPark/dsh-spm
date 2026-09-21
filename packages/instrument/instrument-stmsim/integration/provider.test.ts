import { Socket } from 'node:net'
import { Context } from 'dsh-spm-compat'
import { afterEach, describe, expect, it } from 'vitest'
import { StmsimError, StmsimProcess, apply, portsByRole, stmsimProvider } from '../src/index.js'

/**
 * provider 的生命周期只能对着**真进程**验——「spawn 了吗、端口起来了吗、卸载后停了吗」
 * 用替身测等于什么都没测。
 *
 * 这里自己起一份独立的 stmsim（端口 17511+，与 globalSetup 那份 16501+ 岔开），
 * 因为要验的正是起停本身。
 */
const env = {
  python: process.env['STMSIM_PYTHON']!,
  root: process.env['STMSIM_ROOT']!,
}
const PORTS = [17511, 17512, 17513, 17514]

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket()
    const done = (ok: boolean) => {
      s.removeAllListeners()
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(500)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.once('timeout', () => done(false))
    s.connect(port, '127.0.0.1')
  })
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
  // 各条测试共用同一组端口，而释放是异步的：不在这儿等一下，就成了顺序依赖——
  // 上一条还没放开，下一条就撞上「已经有人在监听」。端口空着时这行几乎不花时间。
  await waitAllClosed(PORTS)
})

/** 等所有端口都连不上。`stop()` 返回时进程已退，但 OS 释放监听套接字有短暂延迟——
 *  契约是「**及时**释放」，不是「同一 tick 内释放」，所以轮询而不是瞬时断言。 */
async function waitAllClosed(ports: readonly number[], timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await Promise.all(ports.map(reachable))).every((up) => !up)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

describe('StmsimProcess 生命周期', () => {
  it('start 之后四个端口都能连上，stop 之后都释放', async () => {
    const sim = new StmsimProcess({ ...env, ports: PORTS })
    cleanup.push(() => sim.stop())
    await sim.start()
    expect(sim.running).toBe(true)
    expect(await Promise.all(PORTS.map(reachable))).toEqual([true, true, true, true])
    await expect(sim.assertOwned()).resolves.toBeUndefined()
    expect(sim.identity.pid).toBeGreaterThan(0)
    expect(sim.identity.root).toBeTruthy()
    expect(sim.identity.runtimeDir).not.toBe(sim.identity.root)

    await sim.stop()
    expect(sim.running).toBe(false)
    await expect(sim.assertOwned()).rejects.toThrow(/没有运行/)
    expect(await waitAllClosed(PORTS)).toBe(true)
  })

  it('端口已经有人监听时直接说清楚，不会误连上别人的服务器', async () => {
    // 连接成功不能证明端口属于当前子进程。启动前若不检查端口占用，遗留模拟器
    // 可能使 start() 误判就绪，而 stop() 只处理已经启动失败的新进程，留下监听端口。
    const first = new StmsimProcess({ ...env, ports: PORTS })
    cleanup.push(() => first.stop())
    await first.start()

    const second = new StmsimProcess({ ...env, ports: PORTS })
    await expect(second.start()).rejects.toThrow(/已经有人在监听/)
    await expect(second.assertOwned()).rejects.toThrow(/没有运行/)
  })

  it('两个路径都没给时明确报错，不是一个语焉不详的 spawn 失败', async () => {
    // 环境变量在本轮测试里是设着的（globalSetup 要用），这条要的是「都没给」的情形，
    // 所以临时摘掉——不摘的话回退逻辑会正常取到，测试测了个寂寞（第一版就是这样）。
    const { STMSIM_PYTHON, STMSIM_ROOT } = process.env
    delete process.env['STMSIM_PYTHON']
    delete process.env['STMSIM_ROOT']
    try {
      const sim = new StmsimProcess({ ports: PORTS })
      // 本机 PATH 里的 python 是 Store 转发桩，猜一个只会让人查半天
      await expect(sim.start()).rejects.toThrow(StmsimError)
      await expect(sim.start()).rejects.toThrow(/STMSIM_PYTHON/)
    } finally {
      process.env['STMSIM_PYTHON'] = STMSIM_PYTHON
      process.env['STMSIM_ROOT'] = STMSIM_ROOT
    }
  })

  it('cwd 不存在时立刻报错，而不是干等 30 秒超时', async () => {
    const sim = new StmsimProcess({ ...env, root: 'D:\\不存在的目录', ports: PORTS, readyTimeoutMs: 20_000 })
    cleanup.push(() => sim.stop())
    const started = Date.now()
    await expect(sim.start()).rejects.toThrow(StmsimError)
    expect(Date.now() - started).toBeLessThan(15_000) // 起不来就立刻报，不傻等到超时
  })

  it('解释器路径不存在时也是一句清楚的话，不是未捕获异常', async () => {
    // spawn 失败走 child 的 'error' 事件，**不是** 'exit'。没人接它就是未捕获异常，
    // 直接崩掉整个进程——2026-09-09 写这条时真踩到，一个配错的路径把整轮 vitest 打挂了。
    const sim = new StmsimProcess({
      ...env,
      python: 'D:\\没这个解释器.exe',
      ports: PORTS,
      readyTimeoutMs: 20_000,
    })
    cleanup.push(() => sim.stop())
    await expect(sim.start()).rejects.toThrow(/stmsim 起不来/)
  })
})

/** 等 `ctx.instrument` 挂上来。Cordis 的 inject 是异步生效的。 */
function instrumentOf(ctx: Context, timeoutMs = 5_000): Promise<Context['instrument']> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.instrument 没在超时前挂上')), timeoutMs)
    ctx.inject(['instrument'], (c) => {
      clearTimeout(timer)
      resolve(c.instrument)
    })
  })
}

describe('作为 Cordis 插件', () => {
  it('装上后起模拟器并提供 simulated=true 的 ctx.instrument', async () => {
    // 收尾走的是**卸载**而不是「我自己记着停」——后者第一版写成了停一个从没 start 过的
    // 空壳，真起的那份泄漏下来占着端口，把下一条测试骗得连上了别人的服务器。
    const ctx = new Context()
    cleanup.push(async () => void ctx.registry.delete(stmsimProvider))
    ctx.plugin(stmsimProvider, { ...env, ports: PORTS })

    const svc = await instrumentOf(ctx, 40_000)
    expect(await reachable(PORTS[0]!)).toBe(true)
    // 真机与模拟器在上层只差这一位，将来的 rigGuard 全靠它
    expect(svc.simulated).toBe(true)

    const rec = await svc.call('Bias_Get', [])
    expect(rec.error).toBeUndefined()
    expect(typeof rec.values?.[0]).toBe('number')
    expect(rec.simulated).toBe(true)
  })

  it('插件卸载后模拟器跟着停——ctx.effect 的回滚，不靠谁记得收尾', async () => {
    // 这才是 dsh 真正装卸我们的方式；根 Context 上没有公开的 stop/dispose，
    // **生命周期的粒度是插件，不是上下文**。
    const ctx = new Context()
    ctx.plugin(stmsimProvider, { ...env, ports: PORTS })
    // apply 是异步的，等服务挂上来就说明模拟器已经起好了
    await instrumentOf(ctx, 40_000)
    expect(await reachable(PORTS[0]!)).toBe(true)

    ctx.registry.delete(stmsimProvider)
    expect(await waitAllClosed(PORTS)).toBe(true)
  })

  it('spawn:false 时不自己起进程——用外面已经在跑的那个', async () => {
    const ctx = new Context()
    // 端口指向 globalSetup 起的那份，不新起进程
    await apply(ctx, { spawn: false, ports: [16501, 16502, 16503, 16504] })
    const svc = await instrumentOf(ctx)
    const rec = await svc.call('Bias_Get', [])
    expect(rec.error).toBeUndefined()
    expect(await reachable(16501)).toBe(true) // 那份还活着，我们没碰它
  })
})

describe('端口按角色对位', () => {
  it('四个端口依次是 main / monitor / data / emergency', () => {
    expect(portsByRole([1, 2, 3, 4])).toEqual({ main: 1, monitor: 2, data: 3, emergency: 4 })
  })
})
