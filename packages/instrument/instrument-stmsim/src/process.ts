/**
 * 起停 STM-Bench 的模拟器（`python -m stmsim serve`）。
 *
 * 它是**靶不是产品**（PLAN §14：不把 stmsim 移植成 TS）——本模块只负责生命周期：
 * spawn、等端口真的能连上、结束时干净收尾。
 *
 * 两个实测数（2026-09-09，本机）：
 *   - 从 spawn 到四个端口都能连上约 **3.4 秒** ⇒ 默认等 30 秒，别用短超时
 *   - `kill` 之后端口立刻释放，不像 Nanonis 真机那样会被强杀弄坏
 *
 * 本机 PATH 里没有可用的 `python`（是 Microsoft Store 的转发桩），所以解释器路径
 * **必须显式给**：构造参数 > `STMSIM_PYTHON` 环境变量 > 抛错。不做「猜一个」的兜底——
 * 猜错的表现是一个语焉不详的 spawn 失败，比直接说「你没告诉我 python 在哪」难查得多。
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { Socket } from 'node:net'

export const DEFAULT_PORTS = [16501, 16502, 16503, 16504] as const

export interface StmsimOptions {
  /** 解释器绝对路径。缺省读 `STMSIM_PYTHON`。 */
  readonly python?: string
  /** STM-Bench 仓库根（`python -m stmsim` 的 cwd）。缺省读 `STMSIM_ROOT`。 */
  readonly root?: string
  readonly ports?: readonly number[]
  readonly profile?: string
  readonly seed?: number
  readonly material?: string
  /** 起手就在隧道状态而不是退针状态。集成测试要它，否则读不到有意义的电流。 */
  readonly approached?: boolean
  readonly sessionDir?: string
  readonly timeScale?: number
  readonly readyTimeoutMs?: number
}

export class StmsimError extends Error {
  override readonly name = 'StmsimError'
}

/** 能连上就算就绪。比数 netstat 可移植，也更接近调用方真正要做的事。 */
function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
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
    s.connect(port, host)
  })
}

export class StmsimProcess {
  readonly ports: readonly number[]
  private child: ChildProcess | null = null
  private readonly opts: StmsimOptions
  private stderr = ''

  constructor(opts: StmsimOptions = {}) {
    this.opts = opts
    this.ports = opts.ports ?? DEFAULT_PORTS
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  async start(): Promise<void> {
    if (this.running) return
    const python = this.opts.python ?? process.env['STMSIM_PYTHON']
    const root = this.opts.root ?? process.env['STMSIM_ROOT']
    if (!python || !root) {
      throw new StmsimError(
        '要起 stmsim 得知道解释器与 STM-Bench 根目录：给构造参数 python/root，' +
          '或设环境变量 STMSIM_PYTHON / STMSIM_ROOT。' +
          '（本机 PATH 里的 python 是 Microsoft Store 转发桩，不能用。）',
      )
    }

    // 端口已经有人监听就立刻说清楚。不查的话，下面的就绪探测会连上**别人的**服务器
    // 而误判成「我起好了」——2026-09-09 就被上一条测试泄漏的模拟器这么骗过一次：
    // start() 秒返回，stop() 停的是刚因端口占用而死掉的子进程，症状是五秒后端口还在。
    const occupied = (await Promise.all(this.ports.map(async (p) => ((await canConnect(p)) ? p : null)))).filter(
      (p) => p !== null,
    )
    if (occupied.length > 0) {
      throw new StmsimError(
        `端口 ${occupied.join(',')} 已经有人在监听——多半是上一轮没停干净的 stmsim。` +
          '停掉它，或换一组端口；想直接用那份现成的就走 spawn:false。',
      )
    }

    const args = ['-m', 'stmsim', 'serve', '--ports', this.ports.join(',')]
    if (this.opts.profile !== undefined) args.push('--profile', this.opts.profile)
    if (this.opts.seed !== undefined) args.push('--seed', String(this.opts.seed))
    if (this.opts.material !== undefined) args.push('--material', this.opts.material)
    if (this.opts.sessionDir !== undefined) args.push('--session-dir', this.opts.sessionDir)
    if (this.opts.timeScale !== undefined) args.push('--time-scale', String(this.opts.timeScale))
    if (this.opts.approached === true) args.push('--approached')

    const child = spawn(python, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4_000) // 只留尾巴，失败时够定位
    })
    // 进程自己先退了要立刻知道，别傻等 30 秒超时
    let failed: string | null = null
    child.once('exit', (code, signal) => {
      failed ??= `stmsim 提前退出（code=${code} signal=${signal}）`
    })
    // spawn 失败（如解释器或 cwd 不存在）会发出 error，而非 exit。
    // 必须处理该事件，避免未捕获异常终止宿主进程，并向调用方报告配置错误。
    child.once('error', (e) => {
      failed ??= `stmsim 起不来：${e.message}`
    })

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 30_000)
    while (Date.now() < deadline) {
      if (failed !== null) throw new StmsimError(`${failed}\n--- stderr ---\n${this.stderr}`)
      const ready = await Promise.all(this.ports.map((p) => canConnect(p)))
      if (ready.every(Boolean)) return
      await new Promise((r) => setTimeout(r, 200))
    }
    await this.stop()
    throw new StmsimError(
      `stmsim 在超时前没把 ${this.ports.join(',')} 全部起起来（本机实测约需 3.4 秒）\n` +
        `--- stderr ---\n${this.stderr}`,
    )
  }

  /** SIGTERM 并等它真的退出。stmsim 是模拟器，强杀无害——但等一下能让端口立刻可复用。 */
  async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
  }
}
