/**
 * 状态缓存对金样。金样由**真 Python `InstrumentState`** 跑出来
 * （`tools/spec-export/export_state_spec.py` → `spec/golden/state.json`），
 * 不是手抄的断言——carry-forward 与 stale 只在序列里显形，手抄看不出。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scalarFloat } from 'dsh-spm-kernel'
import { describe, expect, it } from 'vitest'
import { HardwareStateCache, REFRESH_VERBS, type StateReader } from './cache.js'

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/state.json', import.meta.url)), 'utf8'),
) as Golden

interface Golden {
  spec: {
    patchable_fields: string[]
    numeric_fields: string[]
    core_fields: string[]
    zctrl_status: Record<string, string>
    history_channels: string[]
    history_len: number
    default_state: Record<string, unknown>
  }
  coerce: { case: string; in: unknown; out: number | null }[]
  trace: Record<string, Step[]>
}
interface Step {
  op: 'refresh' | 'patch'
  state: Record<string, unknown>
  history: Record<string, unknown[]>
  verbs?: [string, number[], string][]
  timestamp_carried?: boolean
  raised?: string
}

/** 金样里的标签编码（Python 侧 `encode()`）还原成 JS 值。 */
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode)
  if (v !== null && typeof v === 'object') {
    const tag = (v as { py?: string }).py
    if (tag === 'true') return true
    if (tag === 'false') return false
    if (tag === 'nan') return NaN
    if (tag === 'inf') return Infinity
    if (tag === '-inf') return -Infinity
    if (tag === 'bytes') return new TextEncoder().encode((v as { value: string }).value)
    if (tag === 'tuple') return (v as { value: unknown[] }).value.map(decode)
    if (tag === 'dict') {
      const src = (v as { value: Record<string, unknown> }).value
      return Object.fromEntries(Object.entries(src).map(([k, x]) => [k, decode(x)]))
    }
  }
  return v
}

/** 金样的 state 去掉 `extra`——Python 的 `HardwareState.extra` 全仓没有一个消费者，我们没移。 */
function expectedState(step: Step): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(step.state)) {
    if (k === 'extra') continue
    out[k] = decode(v)
  }
  return out
}

function actualState(c: HardwareStateCache): Record<string, unknown> {
  const { timestamp: _t, ...rest } = c.snapshot()
  return { ...rest }
}

/** 脚本里的回包 body：`null` 表示那个动词读不到。 */
type Replies = Record<string, unknown>

function readerFor(replies: Replies, seen: [string, number[], string][]): StateReader {
  return (verb, args) => {
    seen.push([verb, [...args], 'monitor'])
    const b = replies[verb]
    return Promise.resolve(b === undefined || b === null ? null : (b as unknown[]))
  }
}

// ── 脚本的输入侧：与导出脚本里的 SCRIPTS 一一对应 ────────────────────────────
// 只重复**输入**（回包），期望值全部来自金样。输入抄错了金样对不上，当场就红。
const GOOD: Replies = {
  Bias_Get: [1.5],
  ZCtrl_StatusGet: [2],
  ZCtrl_CtrlListGet: [3, 3, ['Current', 'log Current', 'df'], 1],
  ZCtrl_SetpntGet: [1.0e-10],
  Current_Get: [1.2e-10],
  ZCtrl_ZPosGet: [-1.0e-8],
  FolMe_XYPosGet: [1.0e-7, 2.0e-7],
  ZCtrl_LimitsGet: [5.0e-7],
  Scan_StatusGet: [1],
  LockIn_ModOnOffGet: [1],
  Scan_FrameGet: [0.0, 0.0, 1.0e-7, 1.0e-7, 30.0],
}
type Op = ['refresh', Replies] | ['patch', Record<string, unknown>]
const SCRIPTS: Record<string, Op[]> = {
  happy_path: [['refresh', GOOD]],
  carry_forward_partial_miss: [
    ['refresh', GOOD],
    ['refresh', { ...GOOD, ZCtrl_StatusGet: null, ZCtrl_CtrlListGet: null }],
  ],
  stale_when_all_core_miss: [['refresh', GOOD], ['refresh', {}], ['refresh', GOOD]],
  cold_start_all_miss: [['refresh', {}]],
  patch_semantics: [
    ['refresh', GOOD],
    ['patch', { scan_running: false }],
    ['patch', { bias_v: null }],
    ['patch', { not_a_field: 42 }],
    ['patch', { z_controller_on: true, z_controller_status: 'On' }],
  ],
  patch_numeric_gate: [
    ['refresh', GOOD],
    ['patch', { current_a: [9.9e-11] }],
    ['patch', { current_a: [1.0, 2.0] }],
    ['patch', { bias_v: 'nan' }],
    ['patch', { z_pos_m: '-1e-9' }],
  ],
  withdrawn_logic: [
    ['refresh', { ...GOOD, ZCtrl_StatusGet: [1], ZCtrl_ZPosGet: [5.0e-7] }],
    ['refresh', { ...GOOD, ZCtrl_StatusGet: [1], ZCtrl_ZPosGet: [4.9e-7] }],
    ['refresh', GOOD],
    ['refresh', { ...GOOD, ZCtrl_StatusGet: null, ZCtrl_ZPosGet: null }],
  ],
  unknown_status_code: [['refresh', { ...GOOD, ZCtrl_StatusGet: [7] }]],
  lockin_unread_is_not_off: [
    ['refresh', GOOD],
    ['refresh', { ...GOOD, LockIn_ModOnOffGet: null }],
  ],
  scan_frame_short: [['refresh', { ...GOOD, Scan_FrameGet: [0.0, 0.0, 1e-7] }]],
  ctrl_list_unrecognised: [['refresh', { ...GOOD, ZCtrl_CtrlListGet: [3, 3, 1] }]],
}

describe('金样：动词表与字段白名单', () => {
  it('11 个读的动词、参数、角色与 Python 观测到的一模一样', () => {
    expect(golden.trace['happy_path']![0]!.verbs).toEqual(
      REFRESH_VERBS.map(([v, a]) => [v, [...a], 'monitor']),
    )
  })

  it('空快照与 Python 的 HardwareState() 默认值一致', () => {
    const c = new HardwareStateCache({ now: () => 'T0' })
    expect(actualState(c)).toEqual(expectedState({ state: golden.spec.default_state } as Step))
  })
})

describe('金样：coerce —— 什么算一个读数', () => {
  for (const c of golden.coerce) {
    it(`${c.case} ⇒ ${c.out === null ? '拒绝' : c.out}`, () => {
      expect(scalarFloat(decode(c.in))).toBe(c.out)
    })
  }
})

describe('金样：刷新与写回的逐步轨迹', () => {
  for (const [name, ops] of Object.entries(SCRIPTS)) {
    it(name, async () => {
      const steps = golden.trace[name]
      expect(steps, `金样里没有脚本 ${name}`).toBeDefined()
      expect(ops.length).toBe(steps!.length)
      // 时钟每次取都往前走一格。**恒定时钟会让「stale 时保留旧时间戳」这条规则测不出来**
      // ——第一版就是 `() => 'T0'`，把 stale 的另一半拆掉时测试照样全绿（变红演练当场逮到）。
      let tick = 0
      const cache = new HardwareStateCache({ now: () => `T${tick++}` })
      for (const [i, op] of ops.entries()) {
        const step = steps![i]!
        const before = cache.snapshot().timestamp
        if (op[0] === 'refresh') {
          const seen: [string, number[], string][] = []
          await cache.refresh(readerFor(op[1], seen))
          expect(seen, `第 ${i} 步的动词序列`).toEqual(step.verbs)
          expect(cache.snapshot().timestamp === before, `第 ${i} 步是否沿用旧时间戳`).toBe(
            step.timestamp_carried,
          )
        } else {
          cache.applyPatch(op[1])
          expect(cache.snapshot().timestamp, 'patch 不动时间戳').toBe(before)
        }
        expect(actualState(cache), `第 ${i} 步（${op[0]}）的快照`).toEqual(expectedState(step))
        for (const ch of golden.spec.history_channels) {
          expect([...cache.history(ch as 'bias')], `第 ${i} 步的 ${ch} 历史`).toEqual(
            (step.history[ch] ?? []).map(decode),
          )
        }
      }
    })
  }
})

describe('D-STATE-1：读的一侧与写回用同一把尺子', () => {
  // Python 的 refresh() 每个字段是裸 `float(parsed[0])`，而 apply_patch 走 scalar_float。
  // 同一个缓存两套判据，松的那套在读的一侧。下面三条是**跑出来的**证据（金样 raised /
  // 值），以及我们统一到严格那侧之后的行为。
  const run = async (replies: Replies) => {
    const c = new HardwareStateCache({ now: () => 'T0' })
    await c.refresh(readerFor(replies, []))
    return c
  }

  it('形状错的读数：Python 抛 TypeError 丢掉整个 tick，我们只丢那一个字段', async () => {
    expect(golden.trace['bad_shape_raises']![0]!.raised).toBe('TypeError')
    // Python 抛在 `self._cache = state` 之前 ⇒ 十一个读**全部作废**，而且 stale 不亮：
    // 缓存悄悄停在旧值上，没有任何一位告诉下游「这一秒没读成」。
    const c = await run({ ...GOOD, Bias_Get: [[1.5, 2.5]] })
    expect(c.snapshot().bias_v).toBeNull() // 这个字段没读到
    expect(c.snapshot().current_a).toBe(1.2e-10) // 其余十个照常落地
    expect(c.snapshot().stale).toBe(false) // 核心读有落地的，链路是好的
  })

  it('NaN：Python 的 refresh 把它写进缓存和历史，我们拒绝', async () => {
    expect(decode(golden.trace['nan_through_refresh']![0]!.state['bias_v'])).toBeNaN()
    // 一个非有限的读数不是测量值。放进去的代价见 D-SI-1：NaN 过得了包络检查
    // （`nan < limit` 恒假），于是「安全上限」对它形同虚设。
    const c = await run({ ...GOOD, Bias_Get: [NaN] })
    expect(c.snapshot().bias_v).toBeNull()
    expect(c.history('bias')).toEqual([])
  })

  it('字符串："1.5" 被 Python 的 float() 收下，我们拒绝', async () => {
    expect(golden.trace['string_through_refresh']![0]!.state['bias_v']).toBe(1.5)
    const c = await run({ ...GOOD, Bias_Get: ['1.5'] })
    expect(c.snapshot().bias_v).toBeNull()
  })
})
