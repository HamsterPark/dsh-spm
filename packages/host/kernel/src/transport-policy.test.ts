import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONNECT_FAILED,
  MODULE_OPEN_RECV_MS,
  ModuleOpenGrace,
  NOT_RESENT_HINT,
  resendIsSafe,
  transportOfKind,
  withNotResentHint,
} from './transport-policy.js'

/**
 * T1–T3、G1–G5 的语义搬自旧仓 `tests/v2/unit/core/test_connection_no_double_action.py` 与
 * `test_connection_open_grace_and_root_cause.py` 的宽限五格；同一批动词与实参，好逐条对。
 * 那两份文件里属于连接池内部的部分（重发的次数、根因优先的文案、机会型锁拒绝）本仓不搬：
 * 本仓的连接层不重发（D-CONN-1）。
 */

const safety = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/safety.json', import.meta.url)), 'utf8'),
) as {
  is_read: Record<string, boolean>
  resend_safe: Record<string, boolean>
  resend_arg0_cases: { method: string; args: unknown[]; safe: boolean }[]
}

/** 动词名写错了，判据会安静地走「可重发」那一支：样例里的动词必须在协议表里。 */
const knownVerb = (method: string): boolean => Object.hasOwn(safety.is_read, method)

const ACTS_EACH_TIME: readonly [string, readonly unknown[]][] = [
  ['Motor_StartMove', [0, 100, 0, 1]], // 粗动：两次 = 2N 步
  ['Bias_Pulse', [1, 0.01, 3.0, 0, 0]],
  ['DigLines_Pulse', [1, 0.01]],
  ['TipShaper_Start', [1, 5000]],
  ['BiasSpectr_Start', [1, '']],
  ['ZSpectr_Start', [1, '']],
  ['Script_Run', [1, 1]],
  ['Scan_Action', [0, 0]], // 起扫
  ['Scan_Action', [3, 0]], // 继续
  ['AutoApproach_OnOffSet', [1]], // 开
  ['AutoApproach_OnOffSet', [true]],
  ['Scan_Save', [1, 4000]], // 两次 = 同一帧两份自动编号的文件
  ['AtomTrack_DriftComp', []], // 可能把测得的漂移再补偿一次
]

const RESENDABLE: readonly [string, readonly unknown[]][] = [
  ['Bias_Get', []],
  ['Bias_Set', [0.5]],
  ['Scan_Action', [1, 0]], // 停
  ['Scan_Action', [2, 0]], // 暂停
  ['AutoApproach_OnOffSet', [0]], // 关
  ['ZCtrl_Withdraw', [1, -1]],
  ['Motor_StopMove', []],
  ['BiasSpectr_Stop', []],
  ['PLLZoomFFT_AvgRestart', []],
]

describe('resendIsSafe：可能已经送达的命令能不能再发一次', () => {
  it('T1 每到一次就做一次事的 13 个：不可重发', () => {
    for (const [method, args] of ACTS_EACH_TIME) {
      expect(knownVerb(method), method).toBe(true)
      expect(resendIsSafe(method, args), `${method}(${JSON.stringify(args)})`).toBe(false)
    }
  })

  it('T2 读、属性设置、停止、退针的 9 个：可重发', () => {
    for (const [method, args] of RESENDABLE) {
      expect(knownVerb(method), method).toBe(true)
      expect(resendIsSafe(method, args), `${method}(${JSON.stringify(args)})`).toBe(true)
    }
  })

  it('T3 第一个实参读不出该有的代码，一律按不安全；与这两个动词无关的照常可重发', () => {
    // 读不出：不猜
    expect(resendIsSafe('Scan_Action', ['start'])).toBe(false)
    expect(resendIsSafe('Scan_Action', [])).toBe(false)
    expect(resendIsSafe('Scan_Action')).toBe(false)
    expect(resendIsSafe('AutoApproach_OnOffSet', [null])).toBe(false)
    expect(resendIsSafe('AutoApproach_OnOffSet', ['1.0'])).toBe(false)
    expect(resendIsSafe('AutoApproach_OnOffSet', [undefined])).toBe(false)
    expect(resendIsSafe('Scan_Action', [Number.NaN, 0])).toBe(false)
    expect(resendIsSafe('Scan_Action', [Number.POSITIVE_INFINITY, 0])).toBe(false)
    // 读得出：按 int() 的读法
    expect(resendIsSafe('AutoApproach_OnOffSet', ['1'])).toBe(false)
    expect(resendIsSafe('AutoApproach_OnOffSet', [' +1 '])).toBe(false)
    expect(resendIsSafe('AutoApproach_OnOffSet', [1.9])).toBe(false) // 截断成 1
    expect(resendIsSafe('AutoApproach_OnOffSet', [false])).toBe(true) // 读作 0 = 关
    expect(resendIsSafe('Scan_Action', ['1', 0])).toBe(true)
    // 与这两个动词无关
    expect(resendIsSafe('Current_Get', [])).toBe(true)
    expect(resendIsSafe('FolMe_XYPosSet', [1e-9, 2e-9, 1])).toBe(true)
  })

  it('T3 名字里有 Start 但不在末尾、也不跟大写字母的，按可重发处理（照抄参考的正则）', () => {
    expect(resendIsSafe('FooStartbar')).toBe(true)
    expect(resendIsSafe('Scan_StartX')).toBe(false)
    expect(resendIsSafe('Foo_Run')).toBe(false)
    expect(resendIsSafe('FooRun')).toBe(true)
  })

  it('T4 金样：全部动词在无实参时与参考逐一相等（不可重发 32 个）', () => {
    const verbs = Object.keys(safety.resend_safe)
    // 防空转：金样与 `is_read` 是同一张协议表
    expect(verbs.length).toBe(Object.keys(safety.is_read).length)
    expect(verbs.length).toBeGreaterThanOrEqual(600)
    expect(verbs.filter((m) => resendIsSafe(m) !== safety.resend_safe[m])).toEqual([])
    expect(verbs.filter((m) => !safety.resend_safe[m])).toHaveLength(32)
  })

  it('T4 金样：按第一个实参判的那几格与参考逐一相等', () => {
    expect(safety.resend_arg0_cases.length).toBeGreaterThanOrEqual(13)
    for (const c of safety.resend_arg0_cases) {
      expect(resendIsSafe(c.method, c.args), `${c.method}(${JSON.stringify(c.args)})`).toBe(c.safe)
    }
  })
})

describe('transportOfKind：RoleLinkError.kind → 传输失败标记', () => {
  it('T5 帧写出之后的四种可能已送达；NotConnected 没发出去；RoleBusy 与认不出的不是传输失败', () => {
    for (const kind of ['Timeout', 'EmptyReply', 'WrongEcho', 'SocketError']) {
      expect(transportOfKind(kind)).toEqual({ kind, maybeDelivered: true })
    }
    expect(transportOfKind('NotConnected')).toEqual({ kind: 'NotConnected', maybeDelivered: false })
    expect(transportOfKind('RoleBusy')).toBeUndefined()
    expect(transportOfKind('Foo')).toBeUndefined()
    expect(CONNECT_FAILED).toEqual({ kind: 'ConnectFailed', maybeDelivered: false })
  })
})

describe('withNotResentHint：可能已执行的命令，错误里说清楚', () => {
  it('T6 原错误留在开头（前缀照样能判），提示追加一次；已经带着就不再加', () => {
    const once = withNotResentHint('Timeout: Motor.StartMove 超过 5000ms 未收到回复')
    expect(once.startsWith('Timeout: Motor.StartMove')).toBe(true)
    expect(once.endsWith(NOT_RESENT_HINT)).toBe(true)
    expect(once).toContain('可能已被控制器收到并执行')
    expect(withNotResentHint(once)).toBe(once)
  })
})

/** 假的单调时钟（秒）。 */
class FakeClock {
  t = 1_000
  now = (): number => this.t
}

describe('ModuleOpenGrace：模块首次加载的宽限', () => {
  it('G1 Open 与紧跟它的下一条取 30 s，再下一条不再给（一次性）', () => {
    const clk = new FakeClock()
    const g = new ModuleOpenGrace(clk.now)
    const got = [g.budgetMs('main', 'BiasSpectr_Open', undefined)]
    g.noteSuccess('main', 'BiasSpectr_Open')
    got.push(g.budgetMs('main', 'BiasSpectr_LimitsSet', undefined))
    got.push(g.budgetMs('main', 'BiasSpectr_PropsSet', undefined))
    expect(got).toEqual([MODULE_OPEN_RECV_MS, MODULE_OPEN_RECV_MS, undefined])
  })

  it('G2 宽限属于打开它的那个角色', () => {
    const g = new ModuleOpenGrace(new FakeClock().now)
    g.noteSuccess('main', 'ZSpectr_Open')
    expect(g.budgetMs('monitor', 'Current_Get', undefined)).toBeUndefined()
    expect(g.budgetMs('main', 'ZSpectr_RangeSet', undefined)).toBe(MODULE_OPEN_RECV_MS)
  })

  it('G3 过期：Open 之后 60 s 以内算（边界含 60 s），61 s 不算', () => {
    const clk = new FakeClock()
    const g = new ModuleOpenGrace(clk.now)
    g.noteSuccess('main', 'BiasSpectr_Open')
    clk.t += 60
    expect(g.budgetMs('main', 'BiasSpectr_LimitsSet', undefined)).toBe(MODULE_OPEN_RECV_MS)
    g.noteSuccess('main', 'BiasSpectr_Open')
    clk.t += 61
    expect(g.budgetMs('main', 'BiasSpectr_LimitsSet', undefined)).toBeUndefined()
  })

  it('G4 失败的 Open 不上膛（只有 noteSuccess 才上膛）；Open 自己始终是 30 s', () => {
    const g = new ModuleOpenGrace(new FakeClock().now)
    expect(g.budgetMs('main', 'BiasSpectr_Open', undefined)).toBe(MODULE_OPEN_RECV_MS)
    // 这次 Open 失败了：宿主不调 noteSuccess
    expect(g.budgetMs('main', 'BiasSpectr_LimitsSet', undefined)).toBeUndefined()
    // 不是 Open 的成功调用也不上膛
    g.noteSuccess('main', 'BiasSpectr_LimitsSet')
    expect(g.budgetMs('main', 'BiasSpectr_PropsSet', undefined)).toBeUndefined()
  })

  it('G5 调用方给的更大值不被压低，更小的被抬到 30 s；不在宽限里就原样返回', () => {
    const g = new ModuleOpenGrace(new FakeClock().now)
    g.noteSuccess('main', 'BiasSpectr_Open')
    expect(g.budgetMs('main', 'BiasSpectr_Start', 600_000)).toBe(600_000)
    expect(g.budgetMs('main', 'BiasSpectr_Open', 1_000)).toBe(MODULE_OPEN_RECV_MS)
    g.noteSuccess('main', 'BiasSpectr_Open')
    expect(g.budgetMs('main', 'BiasSpectr_LimitsSet', 1_000)).toBe(MODULE_OPEN_RECV_MS)
    expect(g.budgetMs('main', 'BiasSpectr_PropsSet', 1_000)).toBe(1_000)
  })
})
