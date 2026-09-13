/**
 * 批 3f 里**通用金样驱动不到**的格子。
 *
 * 三类：
 * 1. **留痕**（`ctx.markers`）—— 本仓看不见脚本内部，那条记录是事后唯一能拿到的东西，
 *    而金样只录返回值，不录留痕；
 * 2. **旧仓在这一格炸了**（PLL 的读在空 body 上抛 `IndexError`，金样里记的是
 *    `raised`，轨迹比对会跳过它）—— 我们这一侧必须给一个**值**；
 * 3. 那道**反的**闸：`LoadNanonisScript` 拒绝往已审槽位里装。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import {
  DeployNanonisScript,
  ListNanonisScripts,
  LoadScriptLUT,
  RunNanonisScript,
  StopNanonisScript,
  UndeployNanonisScript,
  lutValues,
  scriptAllowlistPath,
  scriptChannels,
} from './nanonis-script.js'
import { LoadNanonisScript } from './script-files.js'
import { ConfigurePLL, GetPLLAddOnOff, GetPLLExcRange, GetPLLSignalAnlzrFFTProps, GetPLLStatus, PLLOnOff } from './pll.js'
import { SetPiezoLimits, SetZLimits, floatsOf } from './limits.js'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-spm-script-'))
const PATH = join(ROOT, 'config', 'nanonis_scripts.json')
mkdirSync(join(ROOT, 'config'), { recursive: true })
scriptAllowlistPath.current = (): string => PATH
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const FIXTURE = {
  allowed_slots: [
    { slot: 3, name: '延时扫描', description: '泵浦-探测', allow_lut_write: true, lut_min: 0, lut_max: 10 },
    { slot: 5, name: '脉冲串', allow_lut_write: false },
  ],
}

function setAllowlist(content: unknown | null): void {
  if (content === null) rmSync(PATH, { force: true })
  else writeFileSync(PATH, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}
beforeEach(() => setAllowlist(FIXTURE))

interface Marker {
  kind: string
  data: Record<string, unknown>
}

function rig(opts: {
  replies?: Record<string, unknown[]>
  /** 同一个动词按**次序**回不同的 body —— 「改之前」与「改之后」读的是同一条动词。 */
  seq?: Record<string, unknown[][]>
  fail?: Set<string>
} = {}): {
  ctx: SkillContext
  calls: { verb: string; args: unknown[] }[]
  markers: Marker[]
} {
  const calls: { verb: string; args: unknown[] }[] = []
  const markers: Marker[] = []
  const ctx = {
    signal: new AbortController().signal,
    now: () => 1_000_000,
    sleep: () => Promise.resolve(),
    safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> => {
      calls.push({ verb: m, args: a })
      if (opts.fail?.has(m) === true) {
        return Promise.resolve({ method: m, args: a, error: '模拟故障：连接被对端关闭' })
      }
      const q = opts.seq?.[m]
      if (q !== undefined && q.length > 0) {
        return Promise.resolve({ method: m, args: a, values: q.length > 1 ? (q.shift() as unknown[]) : (q[0] as unknown[]) })
      }
      return Promise.resolve({ method: m, args: a, values: opts.replies?.[m] ?? [1] })
    },
    emergencyCall: () => Promise.resolve({ method: '', args: [] }),
    runSkill: () => Promise.resolve({ success: false, error: 'n/a' }),
    markers: { emit: (kind: string, data?: Record<string, unknown>) => markers.push({ kind, data: data ?? {} }) },
  } as unknown as SkillContext
  return { ctx, calls, markers }
}

const verbs = (calls: { verb: string }[]): string[] => calls.map((c) => c.verb)

// ── 白名单：fail-closed 的每一支 ────────────────────────────────────────────

describe('白名单 fail-closed —— 四种「读不懂」都是同一个答案', () => {
  it('没文件 / 不是 JSON / 结构不对 / 空清单：**一个脚本都跑不了**', async () => {
    for (const content of [null, '{不是 JSON', { allowed_slots: '不是表' }, { allowed_slots: [] }]) {
      setAllowlist(content)
      const { ctx, calls } = rig()
      const r = await RunNanonisScript.execute(ctx, { slot: 3 })
      expect(r.success, JSON.stringify(content)).toBe(false)
      expect(r.error).toContain('脚本白名单为空')
      // **一次硬件调用都不发** —— 拒绝发生在任何动作之前
      expect(calls).toEqual([])
    }
  })

  it('`ListNanonisScripts` 在空清单上照样答，并说去哪儿登记', async () => {
    setAllowlist(null)
    const { ctx, calls } = rig()
    const r = await ListNanonisScripts.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ count: 0, vetted_slots: [] })
    expect(String(r.data?.['note'])).toContain('智能体不能运行任何脚本')
    // 它读的是那份人签过字的文件，**不是仪器**
    expect(calls).toEqual([])
  })
})

describe('拒绝要留痕 —— 本仓看不见脚本内部', () => {
  it('未审槽位：`safety_block` 留痕，带着已审清单', async () => {
    const { ctx, markers } = rig()
    await RunNanonisScript.execute(ctx, { slot: 7 })
    expect(markers.map((m) => m.kind)).toEqual(['safety_block'])
    expect(markers[0]?.data).toMatchObject({
      subject: 'NanonisScript[slot 7]',
      skill: 'RunNanonisScript',
      allowed_slots: [3, 5],
    })
  })

  it('**每一次 Run 都留痕** —— 那是事后唯一能拿到的「跑了什么」', async () => {
    const { ctx, markers } = rig()
    const r = await RunNanonisScript.execute(ctx, { slot: 3, wait_until_finished: false })
    expect(r.success).toBe(true)
    const note = markers.find((m) => m.kind === 'note')
    expect(note?.data).toMatchObject({
      subject: 'NanonisScript[slot 3]',
      slot: 3,
      script_name: '延时扫描',
      wait_until_finished: false,
    })
    expect(String(note?.data['reason'])).toContain('中止门在脚本内部均不生效')
  })

  it('写 LUT 留痕里带着**实际写进去的那串数**', async () => {
    const { ctx, markers } = rig()
    await LoadScriptLUT.execute(ctx, { slot: 3, lut_index: 2, values: '0,1,2' })
    const note = markers.find((m) => m.kind === 'note')
    expect(note?.data).toMatchObject({ slot: 3, lut_index: 2, n_values: 3, min: 0, max: 2 })
    expect(note?.data['values']).toEqual([0, 1, 2])
  })
})

describe('LoadNanonisScript —— **反的**那道闸', () => {
  it('往**已审**槽位里装：拒（换掉内容会让那份批准变成一句假话）', async () => {
    const { ctx, calls, markers } = rig()
    const r = await LoadNanonisScript.execute(ctx, { slot: 3, file_path: 'C:/x.ns' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('在已审白名单上——不能往里装别的脚本')
    expect(calls).toEqual([])
    expect(markers[0]?.kind).toBe('safety_block')
  })

  it('往**未审**槽位里装：放行，但明说 `runnable: false`', async () => {
    // 这不是死胡同，是分工：机械活归智能体，批准归人。
    const { ctx, calls } = rig()
    const r = await LoadNanonisScript.execute(ctx, { slot: 7, file_path: 'C:/x.ns' })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ slot: 7, runnable: false, allowed_slots: [3, 5] })
    expect(verbs(calls)).toEqual(['Script_Load'])
    expect(String(r.summary)).toContain('agent 还不能运行它')
  })

  it('**别的闸都是正的，只有这一条是反的** —— 同一个槽位号，两种结局', async () => {
    const a = rig()
    expect((await RunNanonisScript.execute(a.ctx, { slot: 3 })).success).toBe(true)
    const b = rig()
    expect((await LoadNanonisScript.execute(b.ctx, { slot: 3, file_path: 'x' })).success).toBe(false)
    const c = rig()
    expect((await RunNanonisScript.execute(c.ctx, { slot: 7 })).success).toBe(false)
    const d = rig()
    expect((await LoadNanonisScript.execute(d.ctx, { slot: 7, file_path: 'x' })).success).toBe(true)
  })
})

describe('LUT：智能体唯一能撰写的东西', () => {
  it('槽位过审但**没批准写 LUT** —— 与「没过审」是两句话', async () => {
    const { ctx } = rig()
    const r = await LoadScriptLUT.execute(ctx, { slot: 5, lut_index: 1, values: '1' })
    expect(r.error).toContain('未被批准接受智能体写入 LUT')
    expect(r.error).not.toContain('不在已审核的白名单里')
  })

  it('超范围：**报出那几个值**，并说范围是谁写的', async () => {
    const { ctx, calls } = rig()
    const r = await LoadScriptLUT.execute(ctx, { slot: 3, lut_index: 1, values: '0, 5, 42' })
    expect(r.error).toContain('LUT 值 [42.0] 超出槽位 3 声明的范围 [0, 10]')
    expect(r.error).toContain('它知道脚本把这些数当什么单位用，MAST 不知道')
    // **一个值都不下发**：半张表比没有表更坏
    expect(calls).toEqual([])
  })

  it('`lutValues`：有一个记号不是数就整串作废', () => {
    expect(lutValues('0, 2.5, 5')).toEqual([0, 2.5, 5])
    expect(lutValues('0 2.5 5')).toEqual([0, 2.5, 5])
    expect(lutValues('1e-3, -2')).toEqual([1e-3, -2])
    expect(lutValues('0, 一点五')).toBeNull()
    expect(lutValues('0, NaN')).toBeNull()
    // JS 的 Number('0x10') 给 16，而 Python 的 float('0x10') 抛 —— 松的那一侧
    // 是一个十六进制写法的值被当成十进制那个数收下，然后由脚本以 RT 速度走过去
    expect(lutValues('0x10')).toBeNull()
    expect(lutValues('1_0')).toBeNull()
    expect(lutValues('inf')).toBeNull()
    expect(lutValues('')).toEqual([])
  })

  it('`scriptChannels`：严格到整数（同 `logChannels`）', () => {
    expect(scriptChannels('0,24')).toEqual([0, 24])
    expect(scriptChannels('0, 1.5')).toBeNull()
    expect(scriptChannels('x')).toBeNull()
  })

  it('`Script_LUTOpen` 失败**不影响**下发 —— 它是幂等的开模块', async () => {
    const { ctx, calls } = rig({ fail: new Set(['Script_LUTOpen']) })
    const r = await LoadScriptLUT.execute(ctx, { slot: 3, lut_index: 1, values: '1,2' })
    expect(r.success).toBe(true)
    expect(verbs(calls)).toEqual(['Script_LUTOpen', 'Script_LUTLoad'])
  })
})

describe('两个不受白名单管辖的', () => {
  it('`StopNanonisScript`：**唯一**能停下脚本的东西，从不被拒', async () => {
    setAllowlist(null) // 清单空着也照停
    const { ctx, calls } = rig()
    const r = await StopNanonisScript.execute(ctx, {})
    expect(r.success).toBe(true)
    expect(verbs(calls)).toEqual(['Script_Stop'])
  })

  it('`UndeployNanonisScript`：撤下从来不是有风险的那个方向', async () => {
    setAllowlist(null)
    const { ctx } = rig()
    expect((await UndeployNanonisScript.execute(ctx, { slot: 9 })).success).toBe(true)
  })

  it('`DeployNanonisScript` 受管辖 —— 部署的是脚本，不是撤下', async () => {
    setAllowlist(null)
    const { ctx, calls } = rig()
    expect((await DeployNanonisScript.execute(ctx, { slot: 3 })).success).toBe(false)
    expect(calls).toEqual([])
  })
})

// ── PLL：旧仓在空 body 上炸了的那一族 ──────────────────────────────────────

describe('PLL 的读：**空 body 给一个值，不抛**（D-SKILL-3）', () => {
  it('旧仓这些格子记的是 `raised: IndexError`', async () => {
    for (const skill of [GetPLLAddOnOff, GetPLLExcRange, GetPLLSignalAnlzrFFTProps]) {
      const { ctx } = rig({ replies: { } })
      // 把每一个动词都回成空 body
      const empty = rig()
      const c = {
        ...empty.ctx,
        safeCall: (m: string, ...a: unknown[]): Promise<SkillCallRecord> =>
          Promise.resolve({ method: m, args: a, values: [] }),
      } as unknown as SkillContext
      void ctx
      const r = await skill.execute(c, {})
      // 一个只读技能以一句看不懂的异常失败，和「没问出来」是两件事
      expect(r.success).toBe(true)
      expect(r.data?.['raw']).toEqual([])
      // 解不出的字段**不写这个键** —— 与「读到了 0」分得开
      expect('add_on' in (r.data ?? {})).toBe(false)
      expect('output_range' in (r.data ?? {})).toBe(false)
      expect('fft_window' in (r.data ?? {})).toBe(false)
    }
  })

  it('`GetPLLExcRange` 认不出的量程索引**原样印出来**', async () => {
    const { ctx } = rig({ replies: { PLL_ExcRangeGet: [9] } })
    const r = await GetPLLExcRange.execute(ctx, {})
    expect(r.data).toMatchObject({ output_range_index: 9, output_range: 'unknown(9)' })
  })

  it('`GetPLLStatus` **永远 success**，读不到的那一组字段不写', async () => {
    const { ctx } = rig({ fail: new Set(['PLL_AmpCtrlGainGet', 'PLL_ExcitationGet']) })
    const r = await GetPLLStatus.execute(ctx, {})
    expect(r.success).toBe(true)
    expect('amp_p_gain' in (r.data ?? {})).toBe(false)
    expect('excitation_v' in (r.data ?? {})).toBe(false)
    expect('center_freq_hz' in (r.data ?? {})).toBe(true)
  })
})

describe('PLLOnOff —— 只有输出那一条算整趟失败', () => {
  it('两个控制器的开关失败**不**让整趟失败', async () => {
    const { ctx, calls } = rig({ fail: new Set(['PLL_PhasCtrlOnOffSet', 'PLL_AmpCtrlOnOffSet']) })
    const r = await PLLOnOff.execute(ctx, { output_on: true })
    expect(r.success).toBe(true)
    expect(verbs(calls)).toEqual(['PLL_OutOnOffSet', 'PLL_PhasCtrlOnOffSet', 'PLL_AmpCtrlOnOffSet'])
  })

  it('输出那一条失败就停，**后面两条不发**', async () => {
    const { ctx, calls } = rig({ fail: new Set(['PLL_OutOnOffSet']) })
    expect((await PLLOnOff.execute(ctx, { output_on: true })).success).toBe(false)
    expect(verbs(calls)).toEqual(['PLL_OutOnOffSet'])
  })

  it('`output_on: false` 下发的是 0', async () => {
    const { ctx, calls } = rig()
    await PLLOnOff.execute(ctx, { output_on: false, phase_ctrl_on: false })
    expect(calls[0]?.args).toEqual([1, 0])
    expect(calls[1]?.args).toEqual([1, 0])
  })
})

// ── 限值：放宽要看得见 ─────────────────────────────────────────────────────

describe('SetZLimits —— 放宽合法，但要留痕', () => {
  it('`widened` 与留痕一起出现', async () => {
    const { ctx, markers } = rig({ seq: { ZCtrl_LimitsGet: [[1e-7, -1e-7], [5e-7, -5e-7]] } })
    const r = await SetZLimits.execute(ctx, { z_high_limit_m: 5e-7, z_low_limit_m: -5e-7 })
    expect(r.data?.['widened']).toBe(true)
    const note = markers.find((m) => m.kind === 'note')
    expect(note?.data).toMatchObject({ subject: 'SetZLimits', widened: true })
    expect(String(note?.data['reason'])).toContain('（放宽）')
  })

  it('收紧不算放宽', async () => {
    const { ctx } = rig({ seq: { ZCtrl_LimitsGet: [[1e-6, -1e-6], [5e-7, -5e-7]] } })
    const r = await SetZLimits.execute(ctx, { z_high_limit_m: 5e-7, z_low_limit_m: -5e-7 })
    expect(r.data?.['widened']).toBe(false)
  })

  it('读不到改前的值 ⇒ `widened: null`（**不是 false**）', async () => {
    // 「没放宽」与「不知道有没有放宽」是两句话。
    const { ctx } = rig({ fail: new Set(['ZCtrl_LimitsGet']) })
    const r = await SetZLimits.execute(ctx, { z_high_limit_m: 5e-7, z_low_limit_m: -5e-7 })
    expect(r.data?.['widened']).toBeNull()
  })

  it('**`enable=false` 时读回启用状态，不推断** —— 未启用的限值什么也不做', async () => {
    const { ctx, calls } = rig({ replies: { ZCtrl_LimitsEnabledGet: [0] } })
    const r = await SetZLimits.execute(ctx, {
      z_high_limit_m: 5e-7, z_low_limit_m: -5e-7, enable: false,
    })
    expect(verbs(calls)).toContain('ZCtrl_LimitsEnabledGet')
    // 刻意**不**自动启用：调用方说了 enable=false
    expect(verbs(calls)).not.toContain('ZCtrl_LimitsEnabledSet')
    expect(r.data?.['enabled']).toBe(false)
    expect(String(r.summary)).toContain('这对数字不起任何作用')
  })

  it('启用失败 ⇒ 整趟失败（**未启用的限值不起任何作用**）', async () => {
    const { ctx } = rig({ fail: new Set(['ZCtrl_LimitsEnabledSet']) })
    const r = await SetZLimits.execute(ctx, { z_high_limit_m: 5e-7, z_low_limit_m: -5e-7 })
    expect(r.success).toBe(false)
    expect(r.error).toContain('限值已写入但**未能启用**')
  })
})

describe('SetPiezoLimits —— 反过来的一对电压界就拒', () => {
  it('三条轴逐条查，**第一条不合法就停**', async () => {
    const { ctx, calls } = rig()
    const r = await SetPiezoLimits.execute(ctx, {
      x_low_v: 10, x_high_v: -10,
      y_low_v: -1, y_high_v: 1, z_low_v: -1, z_high_v: 1,
    })
    expect(r.error).toBe('x_low_v (10 V) 必须小于 x_high_v (-10 V)')
    expect(calls).toEqual([])
  })

  it('任意一条轴放宽就算放宽', async () => {
    const { ctx } = rig({ replies: { Piezo_XYZLimitsGet: [-10, 10, -10, 10, -10, 10] } })
    const r = await SetPiezoLimits.execute(ctx, {
      x_low_v: -10, x_high_v: 10, y_low_v: -10, y_high_v: 10, z_low_v: -20, z_high_v: 10,
    })
    expect(r.data?.['widened']).toBe(true)
  })
})

describe('floatsOf —— 数不够就是 null', () => {
  it('扁平与嵌一层都认', () => {
    expect(floatsOf({ method: '', args: [], values: [1, 2] }, 2)).toEqual([1, 2])
    expect(floatsOf({ method: '', args: [], values: [[1, 2], 3] }, 3)).toEqual([1, 2, 3])
  })

  it('**半份限值比没有限值更危险** —— 不够就整份作废', () => {
    expect(floatsOf({ method: '', args: [], values: [1] }, 2)).toBeNull()
    expect(floatsOf({ method: '', args: [], values: [] }, 1)).toBeNull()
  })

  it('布尔不算数（Nanonis 的 0/1 走的是数那条路）', () => {
    expect(floatsOf({ method: '', args: [], values: [true, 1, 2] }, 2)).toEqual([1, 2])
  })
})

describe('ConfigurePLL —— 给了才写，`null` 算没给', () => {
  it('一个都没给就**一次调用都不发**', async () => {
    const { ctx, calls } = rig()
    const r = await ConfigurePLL.execute(ctx, {})
    expect(calls).toEqual([])
    expect(r.data).toEqual({ modulator_index: 1 })
  })

  it('**`null` 算没给** —— 模型那条路上每个可选字段都会以 null 到达', async () => {
    const { ctx, calls } = rig()
    await ConfigurePLL.execute(ctx, {
      center_freq_hz: null, freq_shift_hz: null,
      amp_p_gain: null, amp_time_constant_s: null,
      phas_p_gain: null, phas_time_constant_s: null,
    })
    // 用 `k in p` 判的话这里会把六个 null 送进硬件 setter
    expect(calls).toEqual([])
  })

  it('增益与时间常数是一对：只给 P 时 T 用 1e-3 顶上', async () => {
    const { ctx, calls } = rig()
    await ConfigurePLL.execute(ctx, { amp_p_gain: 5 })
    expect(calls).toEqual([{ verb: 'PLL_AmpCtrlGainSet', args: [1, 5, 1e-3] }])
  })

  it('任何一步失败就停，后面的不发', async () => {
    const { ctx, calls } = rig({ fail: new Set(['PLL_CenterFreqSet']) })
    const r = await ConfigurePLL.execute(ctx, { center_freq_hz: 32768, freq_shift_hz: -5 })
    expect(r.success).toBe(false)
    expect(verbs(calls)).toEqual(['PLL_CenterFreqSet'])
  })
})
