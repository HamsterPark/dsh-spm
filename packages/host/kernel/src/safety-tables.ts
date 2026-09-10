/**
 * 安全闸门的**表**——逐字移植 `mast/core/safety.py` 与 `mast/core/execution_context.py`。
 * 零逻辑、零 I/O：这里只放数据与它们各自「为什么长这样」的理由。判定在 `safety.ts`。
 *
 * **Phase 2 是整个项目的承重墙**：后面 400 多个技能全部穿过同一个 choke point，
 * 这些表写错一次，错的就是 400 多次。所以每一张都对 `spec/golden/safety.json`。
 */

// ── 可调包络（管理员可改） ──────────────────────────────────────────────────

/** 全局安全包络。**管理员可调**——所以它不是「物理下限」，物理下限在下面那张表。 */
export interface SafetyLimits {
  readonly bias_min_v: number
  readonly bias_max_v: number
  readonly z_min_m: number
  readonly z_max_m: number
  readonly z_offset_min_m: number
  readonly z_offset_max_m: number
  readonly tip_lift_min_m: number
  readonly tip_lift_max_m: number
  readonly xy_min_m: number
  readonly xy_max_m: number
  readonly setpoint_min_a: number
  readonly setpoint_max_a: number
  readonly scan_size_min_m: number
  readonly scan_size_max_m: number
}

export const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  bias_min_v: -10,
  bias_max_v: 10,
  z_min_m: 0,
  z_max_m: 1.5e-6,
  z_offset_min_m: -1.6e-6,
  z_offset_max_m: 1.6e-6,
  tip_lift_min_m: -1e-7,
  tip_lift_max_m: 1e-7,
  xy_min_m: -1.5e-6,
  xy_max_m: 1.5e-6,
  setpoint_min_a: 1e-12,
  setpoint_max_a: 1e-7,
  scan_size_min_m: 1e-10,
  scan_size_max_m: 1e-5,
}

/**
 * 全局包络检查表：`[参数名子串, 单位, 下限字段, 上限字段]`。
 * **名字与单位都要匹配**才触发；名字按**子串**匹配，所以 `start_v` 也覆盖
 * `bias_start_v` / `sts_start_v`。
 *
 * 为什么谱学/扫描的端点要单独列：可调的全局偏压包络（±10 V）原来**只管 DC 的
 * `bias_v`**，每一个 STS / 偏压扫描 / 脉冲端点都从旁边溜过去了——
 * 一个模型幻觉出来的 `start_v=-50` 就那样到了结。
 */
export const GLOBAL_CHECKS: readonly (readonly [string, string, keyof SafetyLimits, keyof SafetyLimits])[] = [
  ['bias_v', 'v', 'bias_min_v', 'bias_max_v'],
  ['start_v', 'v', 'bias_min_v', 'bias_max_v'],
  ['end_v', 'v', 'bias_min_v', 'bias_max_v'],
  ['lower_v', 'v', 'bias_min_v', 'bias_max_v'],
  ['upper_v', 'v', 'bias_min_v', 'bias_max_v'],
  ['pulse_v', 'v', 'bias_min_v', 'bias_max_v'],
  ['lift_v', 'v', 'bias_min_v', 'bias_max_v'],
  ['z_pos', 'm', 'z_min_m', 'z_max_m'],
  // z_offset 是**有符号的相对**精调 Z 位移（STS 退针是负的），所以用对称的相对包络，
  // 不是绝对的 z 下限——`z_min_m = 0` 会把每一次合法的负向退针都拒掉。
  ['z_offset', 'm', 'z_offset_min_m', 'z_offset_max_m'],
  ['tip_lift', 'm', 'tip_lift_min_m', 'tip_lift_max_m'],
  ['lift_height', 'm', 'tip_lift_min_m', 'tip_lift_max_m'],
  ['deep_depth', 'm', 'tip_lift_min_m', 'tip_lift_max_m'],
  ['x_m', 'm', 'xy_min_m', 'xy_max_m'],
  ['y_m', 'm', 'xy_min_m', 'xy_max_m'],
  ['center_x', 'm', 'xy_min_m', 'xy_max_m'],
  ['center_y', 'm', 'xy_min_m', 'xy_max_m'],
  ['setpoint', 'a', 'setpoint_min_a', 'setpoint_max_a'],
  // 没有这两行，模型可以传 width_m=2（**两米**）而校验器看不见
  ['width_m', 'm', 'scan_size_min_m', 'scan_size_max_m'],
  ['height_m', 'm', 'scan_size_min_m', 'scan_size_max_m'],
]

// ── 物理下限（与仪器无关，管理员改不动） ────────────────────────────────────

/**
 * 物理荒谬表：`[参数名子串, 单位（**精确**匹配）, 上限绝对值, 人话提示]`。
 *
 * 与可调包络的区别是**类别上的**：管理员可以把 `setpoint_max_a` 调宽，但
 * **1.5 A 的隧道电流不是「超出配置范围」，它对任何 STM 都物理上不可能**
 * （真实设定点是 fA–µA；1.5 A 会把结蒸发掉）。那几乎一定是量级/单位滑了一位
 * （模型写 1.5 时想的是 1.5 nA）。
 *
 * **先判这个**，给出的重试信号最干脆：改量级，而不是「把上限调高」——
 * 而且就算某个技能的上界或管理员包络被放宽了，这条依然成立。
 */
export const PHYSICAL_ABSURD: readonly (readonly [string, string, number, string])[] = [
  ['setpoint', 'a', 1e-3, 'STM 隧道电流约 1 fA–100 µA(典型 1 pA–100 nA)'],
  ['current', 'a', 1e-3, 'STM 隧道电流约 1 fA–100 µA(典型 1 pA–100 nA)'],
  ['bias_v', 'v', 1e4, 'STM 偏压约 ±10 V 量级'],
  ['start_v', 'v', 1e4, 'STM 偏压约 ±10 V 量级'],
  ['end_v', 'v', 1e4, 'STM 偏压约 ±10 V 量级'],
  ['lower_v', 'v', 1e4, 'STM 偏压约 ±10 V 量级'],
  ['upper_v', 'v', 1e4, 'STM 偏压约 ±10 V 量级'],
  ['pulse_v', 'v', 1e4, 'STM 偏压约 ±10 V 量级'],
  ['lift_v', 'v', 1e4, 'STM 偏压约 ±10 V 量级'],
  // Z 控制器增益：**P 增益是长度（米），I 增益是速度（m/s）**。压电总程只有 ~µm，
  // 所以 P 增益等于 3 不是「调激进了」，是**三米**——一个在传输中掉了的指数。
  // 2026-08-03 真机上就是这么到硬件的（3e-12 → 3，1e12 倍），当时系统里没有任何
  // 东西能拦。上限比逐技能的 max_value 高约三个数量级，所以两层永远不打架：
  // 上界层拒「对这台机器不合适」，这一层拒「它压根不是一个长度」。
  // **单位精确匹配** ⇒ 开尔文环、通用 PI、PLL 那些无量纲的 p_gain/i_gain 不受影响。
  ['p_gain', 'm', 1e-3, 'Z 控制器 P 增益是长度,典型 1e-13–1e-9 m(压电总程仅 ~µm)'],
  ['i_gain', 'm/s', 1.0, 'Z 控制器 I 增益是速度,典型 1e-9–1e-5 m/s'],
]

// ── 能力标签与半自动档 ──────────────────────────────────────────────────────

export const CAP_BIAS_PULSE = 'bias_pulse'
export const CAP_TIP_SHAPING = 'tip_shaping'

/** SEMI 档允许的最深机械下压。超过它就只是「太深」，不是「不许修针」。 */
export const SEMI_TIP_LIFT_MAX_M = 5e-9

/** 哪些参数名算「下压深度」。子串匹配。 */
export const SEMI_DEPTH_NAME_PATTERNS: readonly string[] = ['tip_lift', 'lift_height', 'depth']

// ── 中止之后还能发的写 ──────────────────────────────────────────────────────

/**
 * 中止闩上之后**仍然可以发**的写动词。`null` = 无条件安全；
 * `[参数下标, 表示「停」的取值集合]` = **只有停的那一形**安全。
 *
 * 下标写错是**最坏方向**的硬件安全缺陷：`Scan_Action(action, direction)` 的
 * action 是 0=START / 1=STOP / 2=PAUSE，一条去看 *direction* 的规则会**高高兴兴地
 * 放行一次中止后的 `Scan_Action(0, …)`——重新开扫**。
 *
 * 每一条都必须是**真实存在且真有技能在调**的 Nanonis 动词。这张表的第一版列了
 * `BiasSpectrMLS_Stop` 与 `GenSweep_Stop`，**两个都不存在**（MLS 用
 * `BiasSpectr_Stop` 停，通用扫描是 `GenSwp_Stop`）——于是两条我以为开着的停止路径
 * 其实是关着的，技能自己的中止清理反被这道闸拒掉，操作员按了中止之后
 * 网格实验还在控制器上跑。
 */
export const ABORT_SAFE_WRITES: Readonly<Record<string, readonly [number, readonly number[]] | null>> = {
  // ── 无条件的停止 / 退针 ──
  ZCtrl_Withdraw: null, // 退针——永远是安全方向
  Motor_StopMove: null,
  FolMe_Stop: null,
  BiasSpectr_Stop: null, // 同时也停 MLS（多段）扫描
  ZSpectr_Stop: null,
  GenSwp_Stop: null,
  PLLFreqSwp_Stop: null,
  Pattern_ExpStop: null,
  // 波形发生器：留着不停就一直在驱动一条输出线——正是按下中止的人要结束的东西，
  // 也是 MAST 看不见远端的那一类。
  FunGen1Ch_Stop: null,
  FunGen2Ch_Stop: null,
  DataLog_Stop: null,
  TCPLog_Stop: null,
  /**
   * **这张表里最重要的一条。**
   *
   * 部署到 Nanonis 的脚本跑在**实时控制器上**，它一个 `safe_call` 都不发——
   * 于是这道闸、安全闸、模式闸、人审全是瞎的，全局的偏压/电流/Z 边界在它里面不适用。
   * 这张表其它每一条停的都是 MAST 自己通过 TCP 起的东西；**这一条停的是 MAST
   * 根本碰不到的东西**。
   *
   * 别处「我们不再发命令了」约等于「仪器停了」。这里不是。
   * 如果中止闩上时 `Script_Stop` 被拒，操作员按下中止而脚本继续驱动针尖——
   * 中止做的事**与它的职责恰好相反**。
   */
  Script_Stop: null,
  // ── 重载动词：只有「停」的那一形安全 ──
  AutoApproach_OnOffSet: [0, [0]], // 0 = 关（停）；1 = 开（会**重新开始**逼近）
  Scan_Action: [0, [1, 2]], // action 0=START / 1=STOP / 2=PAUSE
  Pattern_ExpPause: [0, [1]], // 1 = 暂停，0 = 继续
  AtomTrack_CtrlSet: [1, [0]], // 原子跟踪**在驱动针尖**，关掉它是一次运动停止
  // ── 可选硬件的停止（每个模块出厂都是关的） ──
  // 这些放在**技能层之下**是有意的：模块闸门决定「模型看不看得见某个模块的技能」，
  // 它不该、也不能决定「一次中止还能停什么」。操作员有多探针系统、按下中止时，
  // 探针**必须**退回来；一道因为中止闩上而拒绝退针的闸，是最坏的失败。
  HSSwp_Stop: null,
  APRFGen_SwpStop: null,
  PLLPhasSwp_Stop: null,
  MProbeScanner_Stop: null,
  MProbeZCtrl_Withdraw: null, // 多探针版的退针，同理同样无条件放行
  APRFGen_RFOutOnOffSet: [0, [0]], // RF 输出是输出，不是反馈环，杀掉它明确是「停」
  // 激光的 off **就是**低能量态（不像用户输出——常闭接法的快门在 0 时会打开）
  Laser_OnOffSet: [0, [0]],
  // 刻意**不在**表里：MProbeZCtrl_OnOffSet / KelvinCtrl_CtrlOnOffSet /
  // PICtrl_OnOffSet / Interf_CtrlOnOffSet，以及主的 ZCtrl_OnOffSet。
  // **关掉一个反馈环不是「停」**——它把环原本托着的东西原地扔下，没人再托着。
  // Z 环在中止之后的安全动作是**退针**，不是「关掉」。
}
