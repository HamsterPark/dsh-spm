/**
 * `MoveAtomTo` —— 用针尖把一个吸附原子横向搬到指定位置（Eigler–Schweizer 1990）。
 *
 * 几何约定写死，免得 pull / push 各理解各的：针尖从 `atom − u·approach_offset`
 * 出发（`u` 是原子指向目标的单位向量），扫过原子把它带走，终点就是 `target`。
 * **不提供 push 模式** —— 模拟器不建排斥模型，同一次运行里换模型也无从验证。
 *
 * ## **顺序是安全的一部分**
 *
 * 进入操纵条件：先切电流量程 → 再降偏压 → 最后降设定点；
 * 离开时**倒过来**，`restore_setpoint` 排在一切之前 ——
 * 不然抬着一条几十 kΩ 的结走开，会把刚放好的原子又拖回来。
 *
 * 中止之后还原步骤跑不了，仪器就停在操纵条件上。那一种情况**必须在错误信息里
 * 点名**：`instrument_restored` 为假时返回的是失败，而错误正文里带着
 * 「立刻 SetSetpoint / SetBias 还原成像值」。
 *
 * ## 四个模块常量就是这个技能的全部判据依赖（零 vision / 零 numerics）
 *
 * | 常量 | 它在挡什么 |
 * |---|---|
 * | {@link MAX_WAYPOINT_M} `1e-10` | 一步太长等于让针尖瞬移过去，原子跟不上 |
 * | {@link GAIN_HEADROOM} `2.0` | 设定点顶到量程上沿 ⇒ 前放读不回来 ⇒ Z 环一路伸到撞针 |
 * | {@link RETRY_SETPOINT_FACTOR} `1.5` | 重试时降电阻的倍数 |
 * | {@link MAX_SETPOINT_A} `100e-9` | 重试封顶 |
 *
 * 加上一次 `hypot`（单位向量）与一次 `ceil`（航点数）—— 没有别的了。
 *
 * ## `_prior` 的 `pick`：**键在但值是 `None`** 不等于「设成空」
 *
 * 把 `None` 当读数用，会让还原步骤收到 `None`、`SetSetpoint` 拒绝它，
 * 于是整个组合结束时结还停在操纵电阻上 —— **而那正是这个技能存在要防的那一件事**。
 * 所以 `pick` 逐个键找第一个**非 `None`** 的值，都没有就用缺省。
 *
 * ⚠️ `gain_index` / `full_scale_a` **只从 `read:gain` 那一步读**。
 * 从 `read:speed` 上读它是静默的，唯一的症状是量程永远不会被放宽。
 *
 * ## 重试只在 `displaced` 上做
 *
 * `not_found` / `ambiguous` 说的是「不知道原子在哪」，这时降电阻再拖一次
 * 等于拖一个没认出来的东西。照移：只有 `verdict === 'displaced'` 且还有次数才重来。
 */
import {
  GraphExecutor,
  progressToDict,
  type CompositeStep,
  type Skill,
  type SkillContext,
  type SkillResultLike,
  type StepResult,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { runSubSkill } from './run-sub.js'

/** 拖拽航点的最大步长。 */
export const MAX_WAYPOINT_M = 1e-10
/** 电流量程必须留出的余量。 */
export const GAIN_HEADROOM = 2.0
/** 重试时把设定点乘这个数（降电阻）。 */
export const RETRY_SETPOINT_FACTOR = 1.5
/** 设定点封顶。 */
export const MAX_SETPOINT_A = 100e-9
/** 一次拖拽最多几个航点 —— 一米长的拖拽不是一次操纵。 */
export const MAX_WAYPOINTS = 400

interface Prior {
  bias_v: number
  setpoint_a: number
  speed_m_s: number
  custom_speed: boolean
  gain_index: number | null
  full_scale_a: number | null
}

function numOr(p: Readonly<Record<string, unknown>>, k: string, d: number): number {
  const v = p[k]
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** Python 的 `float(params.get(k) or d)` —— **假值**（`None` / `0` / `''`）走缺省。 */
function numOrFalsy(p: Readonly<Record<string, unknown>>, k: string, d: number): number {
  const v = p[k]
  if (v === null || v === undefined || v === '' || v === 0 || v === false) return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 原子指向目标的单位向量。零长度 ⇒ `(1, 0)`。 */
export function unitVector(
  ax: number, ay: number, tx: number, ty: number,
): [number, number] {
  const dx = tx - ax
  const dy = ty - ay
  const n = Math.hypot(dx, dy)
  return n <= 0 ? [1.0, 0.0] : [dx / n, dy / n]
}

/** 起点到终点之间的航点（**不含起点，含终点**），步长不超过 {@link MAX_WAYPOINT_M}。 */
export function waypoints(
  start: readonly [number, number], end: readonly [number, number],
): [number, number][] {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const dist = Math.hypot(dx, dy)
  let n = Math.max(1, Math.ceil(dist / MAX_WAYPOINT_M))
  n = Math.min(n, MAX_WAYPOINTS)
  const out: [number, number][] = []
  for (let i = 0; i < n; i += 1) {
    out.push([start[0] + (dx * (i + 1)) / n, start[1] + (dy * (i + 1)) / n])
  }
  return out
}

/**
 * 一个满量程**能带余量地装下操纵设定点**的档位。
 *
 * 量程已经够 ⇒ `null`（不动它）；不够就往**更灵敏**的方向退一档
 * （`idx − 1`，下限 0）。读不到当前档 ⇒ `null`。
 */
export function gainFor(setpointA: number, prior: Prior): number | null {
  const full = prior.full_scale_a
  if (!full || full >= setpointA * GAIN_HEADROOM) return null
  const idx = prior.gain_index
  return idx === null ? null : Math.max(0, Math.trunc(idx) - 1)
}

class Manip {
  readonly #ctx: SkillContext
  readonly #params: Readonly<Record<string, unknown>>
  #ex!: GraphExecutor

  constructor(ctx: SkillContext, params: Readonly<Record<string, unknown>>) {
    this.#ctx = ctx
    this.#params = params
  }

  #data(stepId: string): Record<string, unknown> {
    const r = this.#ex.subResults.get(stepId)
    const d = r?.data
    return d !== null && d !== undefined ? (d as Record<string, unknown>) : {}
  }

  /** 键在但值是 `None` ⇒ **「没给」**，不是「设成空」。见文件抬头。 */
  static #pick(d: Record<string, unknown>, keys: readonly string[], dflt: number): number {
    for (const k of keys) {
      const v = d[k]
      if (v !== null && v !== undefined) {
        const n = Number(v)
        if (Number.isFinite(n)) return n
      }
    }
    return dflt
  }

  #prior(): Prior {
    const bias = this.#data('read:bias')
    const setp = this.#data('read:setpoint')
    const speed = this.#data('read:speed')
    const gain = this.#data('read:gain')
    const gi = gain['gain_index']
    const fs = gain['full_scale_a']
    return {
      bias_v: Manip.#pick(bias, ['bias_v', 'bias'], 0.1),
      setpoint_a: Manip.#pick(setp, ['setpoint_a', 'setpoint'], 50e-12),
      speed_m_s: Manip.#pick(speed, ['speed_m_s', 'speed'], 293e-9),
      custom_speed: speed['custom_speed'] === undefined ? true : Boolean(speed['custom_speed']),
      // **从 gain 那一步读**，不是从 speed 那一步 —— 读错了是静默的。
      gain_index: gi === null || gi === undefined ? null : Number(gi),
      full_scale_a: fs === null || fs === undefined ? null : Number(fs),
    }
  }

  /** 复扫帧的路径。四个键按序找第一个非空串。 */
  #scanPath(stepId: string): string | null {
    const d = this.#data(stepId)
    for (const key of ['saved_path', 'scan_path', 'path', 'product_path']) {
      const v = d[key]
      if (typeof v === 'string' && v !== '') return v
    }
    return null
  }

  *#plan(): Generator<CompositeStep> {
    const p = this.#params
    let ax = numOr(p, 'atom_x_m', 0)
    let ay = numOr(p, 'atom_y_m', 0)
    const tx = numOr(p, 'target_x_m', 0)
    const ty = numOr(p, 'target_y_m', 0)
    const epoch = p['coord_epoch']
    const maxAttempts = Math.trunc(numOrFalsy(p, 'max_attempts', 2))
    let setpoint = numOrFalsy(p, 'manip_setpoint_a', 57e-9)

    yield { stepId: 'read:bias', skillName: 'GetBias', params: {}, tags: ['readback'] }
    yield { stepId: 'read:setpoint', skillName: 'GetSetpoint', params: {}, tags: ['readback'] }
    yield { stepId: 'read:speed', skillName: 'GetTipSpeed', params: {}, tags: ['readback'] }
    // 前放量程。没有它就没法拿操纵设定点去比 —— 超量程的设定点读回来是饱和的，
    // Z 环永远看不到它到达目标，于是一路伸到撞上表面。
    yield {
      stepId: 'read:gain', skillName: 'GetCurrentGains', params: {},
      optional: true, tags: ['readback', 'preamp'],
    }
    const prior = this.#prior()
    this.#ex.setPartial('prior', { ...prior })

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const pre = `a${attempt}`
      const [ux, uy] = unitVector(ax, ay, tx, ty)
      const off = numOrFalsy(p, 'approach_offset_m', 0.0)
      const start: [number, number] = [ax - ux * off, ay - uy * off]
      const moveParams: Record<string, unknown> =
        epoch === null || epoch === undefined ? { wait: true } : { wait: true, coord_epoch: Math.trunc(Number(epoch)) }

      yield {
        stepId: `${pre}:pre_move`, skillName: 'MoveToXY',
        params: { x_m: start[0], y_m: start[1], ...moveParams },
        tags: ['move', 'approach'],
      }
      const gain = gainFor(setpoint, prior)
      if (gain !== null) {
        yield {
          stepId: `${pre}:manip_gain`, skillName: 'SetCurrentGain',
          params: { gain_index: gain }, optional: true, tags: ['setup', 'preamp'],
        }
      }
      // 操纵偏压的**大小**由参数给，**符号跟随当前成像偏压**（不穿零）。
      // Python 的 `copysign(|v|, prior.bias_v or 1.0)`：成像偏压是假值（0 / None）时
      // 取 `+1.0` 那一支。
      const signSrc = prior.bias_v || 1.0
      const bias =
        Math.abs(numOrFalsy(p, 'manip_bias_v', 0.01)) * (signSrc < 0 || Object.is(signSrc, -0) ? -1 : 1)
      yield {
        stepId: `${pre}:manip_bias`, skillName: 'SetBias',
        params: { bias_v: bias }, tags: ['setup'],
      }
      yield {
        stepId: `${pre}:manip_setpoint`, skillName: 'SetSetpoint',
        params: { setpoint_a: setpoint }, tags: ['setup'],
      }
      const speed = numOrFalsy(p, 'manip_speed_m_s', 5e-10)
      yield {
        stepId: `${pre}:manip_speed`, skillName: 'SetTipSpeed',
        params: { speed_m_s: speed, custom_speed: true }, tags: ['setup'],
      }
      const wps = waypoints(start, [tx, ty])
      for (let n = 0; n < wps.length; n += 1) {
        const [wx, wy] = wps[n] as [number, number]
        yield {
          stepId: `${pre}:drag_${String(n).padStart(3, '0')}`, skillName: 'MoveToXY',
          params: { x_m: wx, y_m: wy, ...moveParams },
          optional: true, checkpointAfter: false, tags: ['move', 'drag'],
        }
      }
      // 松手：**先把电阻升回去**，针尖才许动。
      yield {
        stepId: `${pre}:restore_setpoint`, skillName: 'SetSetpoint',
        params: { setpoint_a: prior.setpoint_a || 50e-12 }, optional: true, tags: ['restore'],
      }
      yield {
        stepId: `${pre}:restore_bias`, skillName: 'SetBias',
        params: { bias_v: prior.bias_v || 0.1 }, optional: true, tags: ['restore'],
      }
      if (gain !== null && prior.gain_index !== null) {
        yield {
          stepId: `${pre}:restore_gain`, skillName: 'SetCurrentGain',
          params: { gain_index: Math.trunc(prior.gain_index) }, optional: true, tags: ['restore'],
        }
      }
      yield {
        stepId: `${pre}:restore_speed`, skillName: 'SetTipSpeed',
        params: { speed_m_s: prior.speed_m_s, custom_speed: Boolean(prior.custom_speed) },
        optional: true, tags: ['restore'],
      }
      if (p['verify'] === false) {
        this.#ex.setPartial('moved', null)
        return
      }
      yield {
        stepId: `${pre}:verify_scan`, skillName: 'ScanAt',
        params: { center_x_m: tx, center_y_m: ty, size_m: numOrFalsy(p, 'verify_size_m', 6e-9) },
        optional: true, tags: ['verify', 'scan'],
      }
      const scanPath = this.#scanPath(`${pre}:verify_scan`)
      if (scanPath === null) {
        this.#ex.setPartial('moved', null)
        this.#ex.setPartial('verify_verdict', 'no_frame')
        return
      }
      this.#ex.setPartial('verify_scan_path', scanPath)
      yield {
        stepId: `${pre}:verify`, skillName: 'VerifyAdatomAt',
        params: {
          scan_path: scanPath, target_x_m: tx, target_y_m: ty,
          tolerance_m: numOrFalsy(p, 'precision_m', 1.5e-10),
        },
        optional: true, tags: ['verify'],
      }
      const res = this.#ex.subResults.get(`${pre}:verify`)
      const rd = (res?.data ?? {}) as Record<string, unknown>
      const verdict = res === undefined ? null : (rd['verdict'] ?? null)
      this.#ex.setPartial('verify_verdict', verdict)
      this.#ex.setPartial('attempts', attempt)
      if (verdict === 'at_target') {
        this.#ex.setPartial('moved', true)
        this.#ex.setPartial('final_x_m', rd['found_x_m'] ?? null)
        this.#ex.setPartial('final_y_m', rd['found_y_m'] ?? null)
        this.#ex.setPartial('residual_m', rd['residual_m'] ?? null)
        this.#ex.setPartial('bystanders', rd['others'] ?? null)
        return
      }
      this.#ex.setPartial('moved', false)
      this.#ex.setPartial('residual_m', res === undefined ? null : (rd['residual_m'] ?? null))
      this.#ex.setPartial('bystanders', res === undefined ? null : (rd['others'] ?? null))
      if (verdict !== 'displaced' || attempt >= maxAttempts) {
        // `not_found` / `ambiguous`：不知道原子在哪，降电阻再拖一次
        // 等于拖一个没认出来的东西。
        return
      }
      ax = Number(rd['found_x_m'] ?? 0) || ax
      ay = Number(rd['found_y_m'] ?? 0) || ay
      setpoint = Math.min(setpoint * RETRY_SETPOINT_FACTOR, MAX_SETPOINT_A)
    }
  }

  /** 后缀命中的**最后一个**步骤是否成功。 */
  #okSuffix(suffix: string): boolean {
    let last: StepResult | null = null
    for (const [k, r] of this.#ex.subResults) if (k.endsWith(suffix)) last = r
    return last !== null && last.success === true
  }

  #aggregate(): Record<string, unknown> {
    const pd = this.#ex.progress.partialData
    const prior = (pd['prior'] as Record<string, unknown>) ?? {}
    const restored: Record<string, boolean> = {
      setpoint: this.#okSuffix('restore_setpoint'),
      bias: this.#okSuffix('restore_bias'),
      speed: this.#okSuffix('restore_speed'),
    }
    let hasGain = false
    for (const k of this.#ex.subResults.keys()) if (k.endsWith('restore_gain')) hasGain = true
    if (hasGain) restored['gain'] = this.#okSuffix('restore_gain')
    const instrumentRestored = restored['setpoint'] === true && restored['bias'] === true
    const r = pd['residual_m']
    const rn = r === null || r === undefined ? null : Number(r) * 1e9
    return {
      moved: pd['moved'] ?? null,
      verify_verdict: pd['verify_verdict'] ?? null,
      final_x_m: pd['final_x_m'] ?? null,
      final_y_m: pd['final_y_m'] ?? null,
      residual_m: r ?? null,
      residual_nm: rn,
      attempts: pd['attempts'] ?? 1,
      steps: [...this.#ex.subResults.keys()],
      restored,
      instrument_restored: instrumentRestored,
      prior_bias_v: prior['bias_v'] ?? null,
      prior_setpoint_a: prior['setpoint_a'] ?? null,
      junction_resistance_ohm: resistance(pd),
      bystanders: pd['bystanders'] ?? null,
      verify_scan_path: pd['verify_scan_path'] ?? null,
    }
  }

  async run(): Promise<SkillResultLike> {
    const p = this.#params
    this.#ex = new GraphExecutor('MoveAtomTo', {
      now: () => this.#ctx.now(),
      run: (skill, params) => runSubSkill(this.#ctx, skill, params),
      checkAbort: () => this.#ctx.signal.aborted,
    })
    this.#ex.setPartialDefault('attempts', 1)
    this.#ex.setPartial('manip_bias_used_v', p['manip_bias_v'] ?? null)
    this.#ex.setPartial('manip_setpoint_used_a', p['manip_setpoint_a'] ?? null)
    await this.#ex.runPlan(this.#plan())
    const data = this.#aggregate()
    data['_progress'] = progressToDict(this.#ex.progress)
    if (data['instrument_restored'] !== true) {
      return {
        success: false,
        data,
        error:
          `仪器仍停在操纵条件上(设定点 ${pyRepr(p['manip_setpoint_a'])} A、` +
          `偏压 ${pyRepr(p['manip_bias_v'])} V):立刻 SetSetpoint / SetBias ` +
          '还原成像值,否则下一次扫描会把表面拖乱。',
        summary: '搬运中止,仪器未还原',
      }
    }
    if (data['moved'] === false) {
      const rn = data['residual_nm'] as number | null
      return {
        success: false,
        data,
        error:
          `原子没到位(${String(data['verify_verdict'])}` +
          (rn === null ? '' : `,残差 ${rn.toFixed(2)} nm`) +
          `,试了 ${String(data['attempts'])} 次)`,
        summary: '搬运未成功,仪器已还原',
      }
    }
    let summary = data['moved'] ? '原子已到位' : '已搬运,未复扫确认'
    const rn = data['residual_nm'] as number | null
    if (rn !== null) summary += `,残差 ${pyF0(rn * 1000)} pm`
    return { success: true, data, summary }
  }
}

/** `|V| / I`。两个里缺一个（或电流是 0）⇒ `null`。 */
function resistance(pd: Record<string, unknown>): number | null {
  const b = pd['manip_bias_used_v']
  const i = pd['manip_setpoint_used_a']
  if (b === null || b === undefined || !i) return null
  return Math.abs(Number(b)) / Number(i)
}

/** Python 的 `"%s" % x`（`None` → `None`）。 */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  return String(v)
}

/** Python 的 `"%.0f"` —— banker's rounding。 */
function pyF0(x: number): string {
  const f = Math.floor(x)
  const d = x - f
  const n = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1
  return Object.is(n, -0) ? '-0' : String(n)
}

export const MoveAtomTo: Skill = {
  spec: S.MoveAtomToSpec,
  execute: (ctx: SkillContext, params): Promise<SkillResultLike> => new Manip(ctx, params).run(),
}
