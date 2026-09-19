/**
 * 仪器档案 —— **这台机器的硬事实**，以及「读不到」与「没填过」这两句话的分界线。
 *
 * 旧仓 `mast/core/instrument_profile.py`（1237 行）。里面是三样东西：操作员填一次的
 * 硬件事实（退针方向、Z 稳定预算、粗动分块步数……）、运行时学出来的标定
 * （接触点 dI/dV、倾斜响应矩阵 G、qPlus 实测共振），以及把它们渲染给模型的那几块。
 *
 * ---
 *
 * ## 这个模块存在的全部理由：**区分两种否定**
 *
 * `ReadCalibrations` 要回答的不是「有没有标定」，是
 *
 * > **「从未标定过」** 还是 **「读不到档案」**
 *
 * ——「该去做的事完全不同」。没有存储的时候它永远只会说后者；而如果把「没接存储」
 * 折成一个空档案，它就永远只会说**前者**，也一样是一句假话。所以这里是三态，
 * 不是两态（本仓「读不到 ≠ 零 ≠ 否」那一族的第 N 次）。
 *
 * 现场（2026-08-10 真机）：`TiltCalibrate` 把 2×2 响应矩阵写进档案，而回包里只有
 * 条件数与两个幅度 —— **矩阵本体拿不到**，团队负责人当晚是直接 ssh 去读
 * `ui_settings.json` 才拿到那四个数的。读到之后才发现它与从另一条路反推的矩阵
 * **符号不一致**。判据一句话：**一个标定值如果不能被读出来核对，它就没法被验证。**
 *
 * ---
 *
 * ## 三个问题，写在动手之前（同 `tip-crash-tracker.ts` 的抬头）
 *
 * ### ① 它住在哪里
 *
 * **进程级**（{@link processInstrumentProfile}），与 `processVacuum` /
 * `processPresetStore` / `processTipCrash` 同一族。一台机器一份档案，
 * 而「这台机器的退针方向是 z−」必须跨调用、跨链活着。
 *
 * ⚠️ **进程级不等于持久**：本仓和旧仓一样**不落盘**，落盘由宿主接
 * （同 D-PRESET-2）。区别在于旧仓的持久化是模块自己 `set_persist_sink` 出去的，
 * 本仓连读口都在外面 —— 见②。
 *
 * ### ② 由谁注入
 *
 * **宿主**。{@link processInstrumentProfile}`.source` 是一个**读口函数**，
 * 不是一份被这里持有的数据（同 `processVacuum.source`）。
 * 理由与 D-VAC-1 / D-LIMITS-1 / D-PRESET-2 逐字相同：
 * **档案是台架的属性，不是类的属性** —— 退针方向、Z 稳定预算、前置放大器满量程，
 * 每一项都取决于你站在哪台机器前面。
 *
 * 把它做成读口而不是一份快照，是为了让「宿主根本没接」这件事**在类型上存在**：
 * `source === null` 与 `source` 返回 `{}` 是两回事，而前者正是本模块要说出口的那句话。
 *
 * ### ③ 宿主不接时是什么行为
 *
 * | 谁在问 | 没接时 | 为什么 |
 * |---|---|---|
 * | {@link getConfig} | **出厂默认生效**（spec 默认 → 调用方默认） | 同 D-VAC-1：闸照常关，不是放行。旧仓 `get_config` 在空档案上也正是这个行为 |
 * | {@link readProfile} | `{ ok: false, why }` —— **照实说读不到** | 折成「空档案」就等于宣告「从未标定过」，那是编造一个结论 |
 * | {@link getTiltCalibration} | `{ state: 'unreadable', why }` | 三态。`never` 是**结论**，`unreadable` 是「这个问题答不了」 |
 * | {@link zExtendSignOrNone} | `null` ⇒ **拒判** | 出厂 `+1` 在这一项上**不中性**：它是两个互斥答案里的一个，而本机实测是 `-1` |
 *
 * 最后一行值得单独说：**猜错的两个方向不对称**。猜成 approaching 只是白撤一次针
 * （烦，安全）；猜成 receding 是**针尖在靠近却说在远离**，然后梯子照爬到 89 步。
 * 所以这一项没有「保守默认」可用 —— 只有「说不知道」。
 *
 * ---
 *
 * ## 键表按消融精神裁过
 *
 * 旧仓 `_CONFIG_SPEC` 39 项 + `_CHOICE_SPEC` 9 项 + `_TEXT_SPEC` 1 项。这里只登记
 * **本仓真的有消费方**的那些（见 {@link CONFIG_SPEC} / {@link CHOICE_SPEC} 每一行的
 * 注释）。未登记的键在 {@link sanitizeProfile} 里被丢掉 —— 与旧仓同一条规则，
 * 而那条规则本身咬过人：D-QPLUS-1 记着「两个键必须先注册，否则写得干干净净、
 * 读回来永远是 `None`」。所以这里每加一个消费方，要同时加它的那一行。
 */

/** 档案里一个数值配置项的规格：`[标签, 单位, 类型, [下界, 上界], 出厂默认]`。 */
export type ConfigSpecEntry = readonly [
  label: string,
  unit: string,
  kind: 'int' | 'float',
  range: readonly [number, number],
  fallback: number | null,
]

/**
 * 数值配置项。**只登记有消费方的**（右栏就是消费方）。
 *
 * 标签与范围逐字照移旧仓 —— 它们是操作员在设置页上看到的东西，而本仓迟早要渲染
 * 同一张表（`field_specs()` 存在的理由就是「前端和后端不能各抄一份区间」）。
 */
export const CONFIG_SPEC: Readonly<Record<string, ConfigSpecEntry>> = {
  // ── `z-settle.ts`：稳定判据与预算 ──────────────────────────────────
  z_recede_min_nm: ['退针方向自检: Z 伸长超过此阈值判定为远离', 'nm', 'float', [0.0, 10000.0], 1.0],
  z_settle_timeout_s: ['退针自检: 等 Z 反馈稳定的预算上限', 's', 'float', [0.5, 300.0], 20.0],
  // ── `RetractForSampleChange`：梯子 ────────────────────────────────
  retract_total_steps: ['换样品退针总步数(粗动马达)', '步', 'int', [1, 1000000], 3000],
  retract_step_max: ['单次粗动最大步数(Nanonis 硬件上限 1000)', '步', 'int', [1, 1000], 1000],
  //   `_read_didv`：没填 ⇒ 这一路证据不取（`None` 是**合法值**，不是缺省）
  lockin_signal_index: ['dI/dV lock-in 信号索引', '', 'int', [0, 127], null],
  // ── `RelocateCoarseXY` ───────────────────────────────────────────
  xy_prewithdraw_steps: ['横向粗动前的粗动退针步数(清障)', '步', 'int', [0, 100000], 100],
  xy_move_chunk_steps: ['横向粗动分块步数(每块之后做一次看护)', '步', 'int', [1, 1000], 50],
  //   `judgeRecedeClearance`：读不到 setpoint 时那个**与工作点无关**的界
  preamp_full_scale_a: ['前置放大器满量程电流(可测的最大电流)', 'A', 'float', [1e-12, 1e-2], null],
  // ── 批 7a-1 `AutoTilt`：三条阈的分母，与单轴限幅 ────────────────────
  //   `z_range_m` 是调平触发判据的分母：判据统一成「这一帧的斜坡吃掉多少 Z 量程」
  //   (`z_span = L·tanθ`)，这样同一个角度在 1 µm 帧和 10 nm 帧上自动给出不同的
  //   紧迫程度，不需要为粗扫/精扫各设一个角度阈值。
  z_range_m: ['Z 压电总量程', 'm', 'float', [1.0e-9, 1.0e-4], 1.5e-6],
  //   单轴倾斜补偿的绝对上限。压电倾斜补偿把扫描平面转过来，转过头会吃掉 XY 行程
  //   并让 Z 在帧角上打满；5° 对任何 STM 都已经是很大的失配角了。
  tilt_limit_deg: ['压电倾斜补偿绝对上限(单轴)', '°', 'float', [0.0, 45.0], 5.0],
}

/** 枚举配置项：`[标签, 允许值, 显示名, 出厂默认]`。 */
export type ChoiceSpecEntry = readonly [
  label: string,
  choices: readonly string[],
  display: Readonly<Record<string, string>>,
  fallback: string,
]

export const CHOICE_SPEC: Readonly<Record<string, ChoiceSpecEntry>> = {
  retract_motor_dir: [
    '退针方向(粗动马达 远离样品)',
    ['z+', 'z-'],
    { 'z+': 'Z+ (Nanonis 标准: 远离样品)', 'z-': 'Z- (反向装置)' },
    'z+',
  ],
  z_extend_sign: [
    '压电伸长(趋向样品)对应 Z 读数符号',
    ['+1', '-1'],
    { '+1': '伸长时 Z 增大', '-1': '伸长时 Z 减小' },
    // ⚠️ 这个出厂值**只给显示与诊断用**。方向自检走 `zExtendSignOrNone()`，
    //    它在没声明时返回 `null` —— 见抬头③的最后一行。
    '+1',
  ],
}

/**
 * 运行时学出来 / 标定出来的键。**由运行时写、由界面只读**（旧仓同）。
 *
 * 它们与 {@link CONFIG_SPEC} 分开的理由：配置是**意图**，标定是**测量结果**，
 * 而测量结果绑定在它被测出来的那个条件上（偏压 / 设定点 / 调制幅度）。
 */
export const CALIB_KEYS: readonly string[] = [
  'didv_at_contact_v',
  'didv_cal_bias_v',
  'didv_cal_setpoint_a',
  'didv_cal_mod_amp_v',
  'didv_cal_updated_at',
  'tilt_cal_g11',
  'tilt_cal_g12',
  'tilt_cal_g21',
  'tilt_cal_g22',
  'tilt_cal_cond',
  'tilt_cal_updated_at',
  'qplus_f0_measured_hz',
  'qplus_q_measured',
  'qplus_fq_updated_at',
]

/** 倾斜响应矩阵的四个元素（按行）。四个**都在**才算标定过。 */
export const TILT_CAL_KEYS: readonly string[] = [
  'tilt_cal_g11',
  'tilt_cal_g12',
  'tilt_cal_g21',
  'tilt_cal_g22',
]

/**
 * 响应矩阵条件数上限 —— 超过说明两个轴的响应几乎共线，解出来的 G 不可靠。
 *
 * 旧仓 `set_tilt_calibration` 拿它**拒绝写入**。本仓还没有写入侧（`TiltCalibrate`
 * 这一批没落，见交接 §5），所以这里是**唯一一份**，`ReadCalibrations` 复述它。
 * 写入侧接上来的那天，拒写闸要用同一个常量，不许再抄一份。
 */
export const TILT_CAL_MAX_COND = 10.0

/** Nanonis `Motor_StartMove` 的方向码：4 = Z+，5 = Z−。 */
export const MOTOR_DIR_CODE: Readonly<Record<string, number>> = { 'z+': 4, 'z-': 5 }

/**
 * 进程内的档案**读口**。`source === null` = 宿主没接（不是「空档案」）。
 *
 * `nowS` 与 D-VAC-2 同一条：标定的年龄由它算，而一份每跑一次都换个数的金样，
 * `git diff` 回答不了「有没有变」。
 */
export const processInstrumentProfile: {
  source: (() => unknown) | null
  /**
   * 档案的**写口**（批 7a-1 接上）。`null` = 宿主没接 —— 那时
   * {@link setTiltCalibration} **失败并说出来**，而不是静默成功。
   *
   * 写成 patch（只给要改的那几个键）而不是整份快照：本仓的读口是**宿主拥有**的，
   * 内核手上没有一份可以整体替换的档案。谁来合并、谁来落盘，是宿主的事。
   */
  write: ((patch: Readonly<Record<string, unknown>>) => void) | null
  nowS: () => number
} = { source: null, write: null, nowS: () => Date.now() / 1000 }

/** 读档案的结果。**三态里的前两态**，第三态（读到了但没这一项）由调用方判。 */
export type ProfileRead =
  | { readonly ok: true; readonly profile: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly why: string }

/** 宿主没接读口时那句话。**逐字**，因为它会直接出现在模型与操作员眼前。 */
export const NO_PROFILE_SOURCE =
  '读不到仪器档案: 宿主没有接档案存储(processInstrumentProfile.source 未注入)。' +
  '**这不等于「从未标定过」** —— 那是两件事,该去做的事完全不同。'

/**
 * `float()` / `int()` 的语义：非有限数、非数值一律 `null`（**不是 0** —— 见 D-VAC-4）。
 *
 * ⚠️ **不能直接 `Number(value)`**：`Number('  ')` 是 `0`，而旧仓 `float('  ')` 抛 ——
 * 一个全是空格的 `z_recede_min_nm` 会被夹成 `0 nm`，也就是「任何 Z 变化都算远离」。
 * 空串在上面已经拦掉了，空白串没有；两者在存储层看起来一样，在这里不一样。
 */
function coerceNum(kind: 'int' | 'float', value: unknown): number | null {
  if (typeof value === 'boolean') return null
  let v: number
  if (typeof value === 'number') v = value
  else if (typeof value === 'string') {
    const t = value.trim()
    if (t === '') return null
    v = Number(t)
  } else return null
  if (!Number.isFinite(v)) return null
  return kind === 'int' ? Math.trunc(v) : v
}

/**
 * 把一份生档案洗成干净快照。**永不抛**；非对象给 `{}`。
 *
 * 规则逐字照移旧仓：只留已登记的键；配置数值**夹到区间内**；枚举值必须在表里；
 * 标定键按浮点透传。⚠️ 未登记的键**静默丢掉** —— 这条规则咬过人（D-QPLUS-1）。
 */
export function sanitizeProfile(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, [, , kind, [lo, hi]]] of Object.entries(CONFIG_SPEC)) {
    const v = src[key]
    if (v === undefined || v === null || v === '') continue
    const num = coerceNum(kind, v)
    if (num === null) continue
    out[key] = Math.max(lo, Math.min(hi, num))
  }
  for (const [key, [, choices]] of Object.entries(CHOICE_SPEC)) {
    const v = src[key]
    if (typeof v === 'string' && choices.includes(v.trim())) out[key] = v.trim()
  }
  for (const key of CALIB_KEYS) {
    const v = src[key]
    if (v === undefined || v === null || v === '') continue
    const num = coerceNum('float', v)
    if (num !== null) out[key] = num
  }
  return out
}

/**
 * 现在的档案，或者**为什么读不到**。
 *
 * 三条路：没接读口、读口抛了、读到了。前两条都是「读不到」，但**理由不同**，
 * 而理由正是 2026-08-10 现场想查却查不到的东西（同 `ZSettle.setpointWhy`）。
 */
export function readProfile(): ProfileRead {
  const src = processInstrumentProfile.source
  if (src === null) return { ok: false, why: NO_PROFILE_SOURCE }
  try {
    return { ok: true, profile: sanitizeProfile(src()) }
  } catch (exc) {
    return { ok: false, why: `读不到仪器档案: ${String(exc)}` }
  }
}

/** 这个键的**出厂默认**（没有默认 / 未知键 → `null`）。 */
export function specDefault(key: string): number | string | null {
  const cfg = CONFIG_SPEC[key]
  if (cfg !== undefined) return cfg[4]
  const ch = CHOICE_SPEC[key]
  if (ch !== undefined) return ch[3]
  return null
}

/**
 * 读一个配置值：**现在生效的那个**。档案里有就用档案的，否则出厂默认，再否则
 * 调用方给的默认。
 *
 * ⚠️ 与 {@link specDefault} 的区别很要紧：那个回答「用户什么都没填时系统在用什么」，
 * 这个回答「现在在用什么」。设置页要同时显示两个，才能区分「填过」与「用着默认」
 * —— 而那两者在存储层看起来一模一样。
 */
export function getConfig<T = unknown>(key: string, fallback: T): T
export function getConfig(key: string): unknown
export function getConfig(key: string, fallback: unknown = null): unknown {
  const r = readProfile()
  if (r.ok && key in r.profile) return r.profile[key]
  const sd = specDefault(key)
  if (sd !== null) return sd
  return fallback
}

/** 读一个数值配置（读不出数 ⇒ 用 `fallback`，与旧仓那几处 `float(...)` 同）。 */
export function getConfigNum(key: string, fallback: number): number {
  const v = coerceNum('float', getConfig(key, fallback))
  return v === null ? fallback : v
}

/** 本机「远离样品」对应的 `Motor_StartMove` 方向码。 */
export function getRetractDirCode(): number {
  const dir = String(getConfig('retract_motor_dir', 'z+'))
  return MOTOR_DIR_CODE[dir] ?? 4
}

/**
 * 压电伸长（趋向样品）对应 Z 读数的符号，**没声明过就返回 `null`**。
 *
 * ## 为什么没有「保守默认」（2026-08-10 → 08-11 定案）
 *
 * 出厂默认是 `'+1'`，而出厂默认在这一项上**不是中性的** —— 它是两个互斥答案里的
 * 一个。本机实测三条独立证据都指向 `-1`：`WithdrawTip` 之后 Z 停在 **+169.5 nm**
 * （收回轨 = 正），进针失败时卡在 **−169.5 nm**，反馈开着空追时往负侧跑（伸长 = 负）。
 * 也就是说：**从没配过的机器上，出厂值给出的正是相反的那个方向。**
 *
 * ⚠️ **2026-08-11 撤回**：曾经写过「这个符号跟着降温翻过」。**两个温度下都是 `-1`，
 * 符号没翻过。** 那条结论引的是一句中文标注（「Z −360 nm 收回端」），
 * 而同一份文档另一处写的是「+360 nm 收回端」—— 紧接 `WithdrawTip`，
 * 也就是把压电推到收回轨的那个动作本身。
 *
 * **这一族错误的形态**：仓里那些「伸长 / 收回」字样的标注**是这个符号的下游产物**
 * （由 `× sign` 或由它翻译出的 `receding` 算出来），**不能反过来用作它的证据**。
 * 能立论的只有未经解释的原始读数。
 *
 * ## 判据是「值在不在档案里」
 *
 * 不是「值等不等于出厂默认」：后者会把「有人明确选了 +1」也判成没声明。
 * 所以这里读的是 {@link readProfile} 的原始快照，不是 {@link getConfig}。
 * **读不到档案同样是 `null`** —— 读不到就是不知道。
 */
export function zExtendSignOrNone(): number | null {
  const r = readProfile()
  if (!r.ok) return null
  const raw = r.profile['z_extend_sign']
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (text !== '+1' && text !== '-1') return null
  return text === '+1' ? 1 : -1
}

/** 标定读取的两态外壳；第三态（读到了但这一项从未写过）由 `cal` 的内容表达。 */
export type CalibrationRead =
  | { readonly ok: true; readonly cal: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly why: string }

/**
 * 进针学到的接触点 dI/dV 标定。**读不到档案与「从未标定过」分开**。
 *
 * `ok: true` 且 `cal` 里没有 `didv_at_contact_v` = 从未学到过（一次成功进针会写入它）。
 */
export function getCalibration(): CalibrationRead {
  const r = readProfile()
  if (!r.ok) return { ok: false, why: r.why }
  const cal: Record<string, unknown> = {}
  for (const k of CALIB_KEYS) if (k in r.profile) cal[k] = r.profile[k]
  return { ok: true, cal }
}

/** 倾斜响应标定的三态。`never` 是**结论**，`unreadable` 是「这个问题答不了」。 */
export type TiltCalibration =
  | {
      readonly state: 'ok'
      /** G，按行的 2×2。**存的是 G = −M⁻¹**，不是 M —— 见 `ReadCalibrations` 的 `convention_note`。 */
      readonly g: readonly [readonly [number, number], readonly [number, number]]
      readonly cond: number | null
      readonly updatedAt: number | null
    }
  | { readonly state: 'never' }
  | { readonly state: 'unreadable'; readonly why: string }

/**
 * 倾斜响应矩阵 G（2×2，按行）+ 条件数 + 时间戳。
 *
 * 没有它 `AutoTilt` **一律拒跑** —— `Piezo_TiltSet` 的轴对应与符号取决于仪器接线，
 * 猜错方向不是把倾斜去掉，而是**把它加倍**。
 *
 * 四个元素**缺一个就是没标定过**（旧仓 `all(k in _profile ...)`，照移）：
 * 一个半张的矩阵乘出来的增量，比没有矩阵更危险。
 */
export function getTiltCalibration(): TiltCalibration {
  const r = readProfile()
  if (!r.ok) return { state: 'unreadable', why: r.why }
  if (!TILT_CAL_KEYS.every((k) => k in r.profile)) return { state: 'never' }
  const n = (k: string): number => Number(r.profile[k])
  const cond = r.profile['tilt_cal_cond']
  const ts = r.profile['tilt_cal_updated_at']
  return {
    state: 'ok',
    g: [
      [n('tilt_cal_g11'), n('tilt_cal_g12')],
      [n('tilt_cal_g21'), n('tilt_cal_g22')],
    ],
    cond: typeof cond === 'number' ? cond : null,
    updatedAt: typeof ts === 'number' ? ts : null,
  }
}

/**
 * 写倾斜标定的结果。**拒写的理由必须带出来** —— 旧仓那边只有一个 `None`，
 * 而 `TiltCalibrate` 的报文把「条件数超限」当成了唯一可能的原因。
 * 形状非法与宿主没接写口在那句话里会被说成「条件数 …… 超过上限」，
 * 而那两件事该做的完全不同。见 `spec/deviations.md` 批 7a-1。
 */
export type TiltCalWrite =
  | { readonly ok: true; readonly cal: TiltCalibration }
  | { readonly ok: false; readonly why: 'bad_matrix' | 'not_finite' | 'cond_unknown' | 'cond_too_high' | 'no_sink' }

/**
 * 写入倾斜响应矩阵（`TiltCalibrate` 的产物）。逐条照移旧仓 `set_tilt_calibration`。
 *
 * 条件数超过 {@link TILT_CAL_MAX_COND} 时**拒绝写入**：两个轴的响应几乎共线意味着
 * 解出来的 G 不可靠，存进去比不存更危险 —— 之后**每一次调平**都会用它。
 *
 * ## `cond` 是必需的，而且「算不出」按拒绝处理
 *
 * 旧仓 v6.1.3 之前它是 `cond: float | None = None` 配一道
 * `if cond is not None and cond > MAX` —— 于是**不传 cond 就等于跳过这道闸门**。
 * 「算不出条件数」不是「条件数良好」的证据，而那份可选性替调用方做了这个决定。
 * 本仓的类型让它连「忘了传」都写不出来。
 *
 * ## `tilt_cal_cond` **无条件写**
 *
 * 旧仓改过的另一处：以前是 `if cond is not None:`，传 None 时这个字段**不更新**，
 * 于是档案里留着**上一次标定**的条件数，配着**这一次**的矩阵。
 * 那比没有更坏 —— 一个看起来有依据的数，描述的是另一个已经不在那里的矩阵。
 */
export function setTiltCalibration(g: unknown, cond: unknown): TiltCalWrite {
  const rows = coerceMatrix2(g)
  if (rows === null) return { ok: false, why: 'bad_matrix' }
  if (!rows.every((row) => row.every((v) => Number.isFinite(v)))) return { ok: false, why: 'not_finite' }
  const c = typeof cond === 'number' ? cond : Number(cond)
  if (cond === null || cond === undefined || !Number.isFinite(c)) return { ok: false, why: 'cond_unknown' }
  if (c > TILT_CAL_MAX_COND) return { ok: false, why: 'cond_too_high' }
  const sink = processInstrumentProfile.write
  if (sink === null) return { ok: false, why: 'no_sink' }
  sink({
    tilt_cal_g11: rows[0][0],
    tilt_cal_g12: rows[0][1],
    tilt_cal_g21: rows[1][0],
    tilt_cal_g22: rows[1][1],
    tilt_cal_cond: c,
    tilt_cal_updated_at: processInstrumentProfile.nowS(),
  })
  return { ok: true, cal: getTiltCalibration() }
}

/** `[[float, float], [float, float]]`，取不出来给 `null`（旧仓 `except (TypeError, ValueError, IndexError)`）。 */
function coerceMatrix2(g: unknown): [[number, number], [number, number]] | null {
  if (!Array.isArray(g) || g.length < 2) return null
  const r0 = g[0] as unknown
  const r1 = g[1] as unknown
  if (!Array.isArray(r0) || !Array.isArray(r1) || r0.length < 2 || r1.length < 2) return null
  const f = (v: unknown): number => (typeof v === 'number' ? v : Number(v))
  return [
    [f(r0[0]), f(r0[1])],
    [f(r1[0]), f(r1[1])],
  ]
}
