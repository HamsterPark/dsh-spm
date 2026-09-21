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
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertProcessOwnsPorts } from './ownership.js'

export const DEFAULT_PORTS = [16501, 16502, 16503, 16504] as const

export interface StmsimOptions {
  /** 解释器绝对路径。缺省读 `STMSIM_PYTHON`。 */
  readonly python?: string
  /** STM-Bench 仓库根（`python -m stmsim` 的 cwd）。缺省读 `STMSIM_ROOT`。 */
  readonly root?: string
  /** 独立运行目录；缺省创建临时目录，绝不在模拟器源码下运行或存数据。 */
  readonly runtimeDir?: string
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

/** Resolve existing parent links before creating a path, so rejection itself is read-only. */
function creationPath(path: string): string {
  const full = resolve(path)
  let ancestor = full
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  return resolve(realpathSync(ancestor), relative(ancestor, full))
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
  private sourceRoot: string | undefined
  private runDirectory: string | undefined

  constructor(opts: StmsimOptions = {}) {
    this.opts = opts
    this.ports = Object.freeze([...(opts.ports ?? DEFAULT_PORTS)])
    if (this.ports.length !== 4 || new Set(this.ports).size !== 4 ||
        this.ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
      throw new StmsimError('stmsim 需要四个不同的有效非特权端口')
    }
  }

  get running(): boolean {
    return this.child !== null && this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null
  }

  get identity(): { pid: number | undefined; ports: readonly number[]; root: string | undefined; runtimeDir: string | undefined; running: boolean } {
    return { pid: this.child?.pid, ports: this.ports, root: this.sourceRoot, runtimeDir: this.runDirectory, running: this.running }
  }

  /** The minimum runtime requires this OS check before enabling its tools. */
  async assertOwned(): Promise<void> {
    const child = this.child
    if (!this.running || child?.pid === undefined) throw new StmsimError('stmsim 本轮启动的进程没有运行')
    await assertProcessOwnsPorts(child.pid, this.ports)
    if (child !== this.child || !this.running) throw new StmsimError('stmsim 身份检查期间进程已经退出')
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

    // Resolve symlinks before comparing directories: a linked runtime directory
    // inside the source checkout would defeat the isolation guarantee.
    try {
      this.sourceRoot = realpathSync(root)
      if (!statSync(this.sourceRoot).isDirectory()) throw new Error('root 不是目录')
      const runtime = this.opts.runtimeDir ?? mkdtempSync(join(tmpdir(), 'dsh-stmsim-'))
      const withinSource = (path: string): boolean => {
        const part = relative(this.sourceRoot!, path)
        return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
      }
      this.runDirectory = creationPath(runtime)
      if (withinSource(this.runDirectory)) throw new Error('runtimeDir 不能位于模拟器源码目录内')
      const sessionDir = creationPath(this.opts.sessionDir ?? join(this.runDirectory, 'sessions'))
      if (withinSource(sessionDir)) throw new Error('sessionDir 不能位于模拟器源码目录内')
      mkdirSync(this.runDirectory, { recursive: true })
      mkdirSync(sessionDir, { recursive: true })
    } catch (error) {
      throw new StmsimError(`stmsim 运行目录配置错误：${String(error)}`)
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
    args.push('--session-dir', resolve(this.opts.sessionDir ?? join(this.runDirectory, 'sessions')))
    if (this.opts.timeScale !== undefined) args.push('--time-scale', String(this.opts.timeScale))
    if (this.opts.approached === true) args.push('--approached')

    this.stderr = ''
    const child = spawn(python, args, {
      cwd: this.runDirectory,
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: [this.sourceRoot, process.env['PYTHONPATH']].filter(Boolean).join(delimiter),
        STM_BENCH_DATA: join(this.runDirectory, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.resume() // Drain the pipe even when no caller needs simulator logs.
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
      if (failed !== null) {
        await this.stop()
        throw new StmsimError(`${failed}\n--- stderr ---\n${this.stderr}`)
      }
      const ready = await Promise.all(this.ports.map((p) => canConnect(p)))
      if (ready.every(Boolean) && failed === null && this.running) return
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
    if (child === null || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      if (process.platform === 'win32') {
        // A Windows venv launcher may own a separate interpreter process. Stop
        // only this live child's tree; never kill listeners merely by port.
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
          if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve() }
        })
      } else child.kill()
    })
  }
}
