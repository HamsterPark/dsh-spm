// 由 `node scripts/gen-skill-specs.ts` 生成，**不要手改**。
// 源：spec/golden/skills.json（旧仓 SkillRegistry.discover() + _get_metadata_raw）
//
// 批 1 只读 L0 36 个 · 批 2 写/硬闸/DANGEROUS/L1 37 个 · 批 2b 参数组 2 个 · 批 3a 扫描主链 6 个 · 批 3b 组合 1 个 · 批 3c 长尾 28 个 · 批 3d 锁相族 26 个 · 批 3e 收口 15 个 · 批 3f 脚本/PLL/限值 56 个 · 批 3g 58 个 · 批 3h 48 个 · 批 3i 11 个 · 批 3j 3 个 · 批 3k 2 个 · 批 3l 38 个 · 批 4a 9 个 · 批 4b 4 个 · 批 4c 12 个 · 批 4d 2 个 · 批 5a 4 个 · 批 5b 9 个 · 批 5c 4 个 · 批 6a 0 个 · 批 6b 2 个 · 批 6c 4 个 · 批 7a-1 4 个 · 批 7a-2 1 个 · 批 7a-3 2 个 · 批 7b-1 1 个
import type { SkillSpec } from 'dsh-spm-kernel'

export const GetBiasSpec: SkillSpec = {
  name: "GetBias",
  description: "读取当前偏压（bias）。",
  parameters: [],
  tags: ["bias","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetCurrentSpec: SkillSpec = {
  name: "GetCurrent",
  description: "读取隧道电流。",
  parameters: [],
  tags: ["current","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetBiasCalibrationSpec: SkillSpec = {
  name: "GetBiasCalibration",
  description: "读取偏压的标定系数与偏移量。",
  parameters: [],
  tags: ["bias","calibration","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSetpointSpec: SkillSpec = {
  name: "GetSetpoint",
  description: "读取当前的隧道电流 setpoint（Z controller）。",
  parameters: [],
  tags: ["z","setpoint","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZPositionSpec: SkillSpec = {
  name: "GetZPosition",
  description: "读取当前的 Z piezo 位置。",
  parameters: [],
  tags: ["z","position","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZControllerStateSpec: SkillSpec = {
  name: "GetZControllerState",
  description: "一次调用读回**整个** Z 控制器状态：环是否闭合、设定值、增益、Z 位置、Z 限值及其是否启用、tip lift、退针速率、关断延时，以及 home 位置。\n\n**「环关了吗？」有两个不同的答案，而它们并不是一回事。** `controller_on` 来自**实时控制器**（ZCtrl_OnOffGet）—— 这一个才是 Nanonis 手册要你在开始任何需要开环的动作之前去读的，因为模块那边可能还在说「Off」，而实时控制器其实还没跟上。`module_status` 是 Nanonis 界面上显示的那个。两者不一致时，信 `controller_on`。\n\n改动过 Z 环的任何东西之后、以及任何一次粗进针之前，都调它一下。",
  parameters: [],
  tags: ["z","controller","read","readback","verify"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZCtrlGainSpec: SkillSpec = {
  name: "GetZCtrlGain",
  description: "读回 Z 控制器当前的 P/I 增益与时间常数。P 的单位是米(m),I 的单位是米每秒(m/s),T 是秒。",
  parameters: [],
  tags: ["z","gain","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZCtrlListSpec: SkillSpec = {
  name: "GetZCtrlList",
  description: "读取 Z controller 列表，以及当前生效的 controller 索引。",
  parameters: [],
  tags: ["z","controller","list","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetTipLiftSpec: SkillSpec = {
  name: "GetTipLift",
  description: "读取当前的针尖抬起量。",
  parameters: [],
  tags: ["z","tip_lift","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZLimitsEnabledSpec: SkillSpec = {
  name: "GetZLimitsEnabled",
  description: "读取 Z 位置安全限位是否启用。",
  parameters: [],
  tags: ["z","limits","safety","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetHomePropsSpec: SkillSpec = {
  name: "GetHomeProps",
  description: "读取 Z controller 的 Home 位置模式与数值。",
  parameters: [],
  tags: ["z","home","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetWithdrawRateSpec: SkillSpec = {
  name: "GetWithdrawRate",
  description: "读取 Z controller 的退针 slew rate，单位 m/s。",
  parameters: [],
  tags: ["z","withdraw","rate","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetScanFrameSpec: SkillSpec = {
  name: "GetScanFrame",
  description: "读取当前扫描框（中心、尺寸、角度）。",
  parameters: [],
  tags: ["scan","frame","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetScanSpeedSpec: SkillSpec = {
  name: "GetScanSpeed",
  description: "读取当前的扫描速度参数。",
  parameters: [],
  tags: ["scan","speed","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetScanBufferSpec: SkillSpec = {
  name: "GetScanBuffer",
  description: "读取当前的 scan buffer（通道、像素数、行数）。",
  parameters: [],
  tags: ["scan","buffer","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetScanXYPositionSpec: SkillSpec = {
  name: "GetScanXYPosition",
  description: "读取当前扫描的 X、Y 位置。",
  parameters: [
    { name: "wait_for_newest", type: "bool", description: "是否等待最新的数据", required: false, default: true },
  ],
  tags: ["scan","position","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetTipSpeedSpec: SkillSpec = {
  name: "GetTipSpeed",
  description: "读取 Follow-Me 模式下的针尖表面速度与 custom-speed 标志。",
  parameters: [],
  tags: ["folme","speed","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPointShootOnOffSpec: SkillSpec = {
  name: "GetPointShootOnOff",
  description: "读取 Follow-Me 模式下 Point & Shoot 是启用还是禁用。",
  parameters: [],
  tags: ["folme","point_shoot","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPiezoTiltSpec: SkillSpec = {
  name: "GetPiezoTilt",
  description: "读取 piezo X、Y 轴的倾斜校正角度。",
  parameters: [],
  tags: ["piezo","tilt","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetDriftCompensationSpec: SkillSpec = {
  name: "GetDriftCompensation",
  description: "读取 piezo 漂移补偿的开关状态与各向速度。",
  parameters: [],
  tags: ["piezo","drift","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPiezoSensitivitySpec: SkillSpec = {
  name: "GetPiezoSensitivity",
  description: "读取全部 3 个轴的 piezo sensitivity（m/V）。",
  parameters: [],
  tags: ["piezo","sensitivity","calibration","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPiezoXYZLimitsSpec: SkillSpec = {
  name: "GetPiezoXYZLimits",
  description: "从 Piezo Calibration 读取 XYZ 的电压上限与启用状态。",
  parameters: [],
  tags: ["piezo","limits","voltage","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetMotorFreqAmpSpec: SkillSpec = {
  name: "GetMotorFreqAmp",
  description: "读回粗动马达当前的驱动频率与幅度(电压),并与本机声明的耐压上限比对。**只读** —— 设置驱动电压是用户的权限,agent 不能改。粗动移动前会自动做这个核对;读不到就拒绝粗动(读不到 ≠ 没问题)。",
  parameters: [
    { name: "axis", type: "str", description: "马达轴：'all'、'x'、'y' 或 'z'", required: false, allowedValues: ["all","x","y","z"], default: "all" },
  ],
  tags: ["motor","coarse","read","safety"],
  category: "read",
  safetyLevel: "AUTO",
}

export const MotorGetPosSpec: SkillSpec = {
  name: "MotorGetPos",
  description: "读取粗动马达位置。",
  parameters: [],
  tags: ["motor","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetMotorStepCounterSpec: SkillSpec = {
  name: "GetMotorStepCounter",
  description: "读取 X、Y、Z 三轴的步数计数器值。可选择读完后清零。仅适用于 Attocube ANC150。",
  parameters: [
    { name: "reset_x", type: "bool", description: "读完后把 X 步数计数器清零", required: false, default: false },
    { name: "reset_y", type: "bool", description: "读完后把 Y 步数计数器清零", required: false, default: false },
    { name: "reset_z", type: "bool", description: "读完后把 Z 步数计数器清零", required: false, default: false },
  ],
  tags: ["motor","step_counter","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetAutoApproachStatusSpec: SkillSpec = {
  name: "GetAutoApproachStatus",
  description: "读取 auto-approach 流程当前是否在运行。",
  parameters: [],
  tags: ["approach","status","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSafeTipStatusSpec: SkillSpec = {
  name: "GetSafeTipStatus",
  description: "读取当前 SafeTip 保护状态。",
  parameters: [],
  tags: ["safety","hardware","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSafeTipPropsSpec: SkillSpec = {
  name: "GetSafeTipProps",
  description: "读取 SafeTip 配置：自动恢复、自动暂停扫描、阈值。",
  parameters: [],
  tags: ["safety","hardware","props","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSafeTipSignalSpec: SkillSpec = {
  name: "GetSafeTipSignal",
  description: "读取当前 SafeTip 信号值。",
  parameters: [],
  tags: ["safety","hardware","signal","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSignalValuesSpec: SkillSpec = {
  name: "GetSignalValues",
  description: "读若干选定信号的当前值（过采样）。给一份信号序号的列表（0-127）。",
  parameters: [
    { name: "signal_indexes", type: "str", description: "逗号分隔的信号序号，例如 '0,1,14'。每个序号的范围是 0-127。", required: true },
    { name: "wait_for_newest", type: "bool", description: "为 True 时，丢掉第一个采样，返回一个完全新鲜的值（会更慢）。默认 False。", required: false, default: false },
  ],
  tags: ["signals","values","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ListSignalChannelsSpec: SkillSpec = {
  name: "ListSignalChannels",
  description: "列出 128 路可用的 Nanonis 信号（物理输入／输出／内部通道）及其 0-127 序号。会标出哪些序号是电流通道，好让调用方为高速采集挑出隧道电流那一路。",
  parameters: [],
  tags: ["signals","enumerate","channels","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSignalRangeSpec: SkillSpec = {
  name: "GetSignalRange",
  description: "读一路信号（0-127）的量程上限与下限。",
  parameters: [
    { name: "signal_index", type: "int", description: "信号序号（0-127）", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["signals","range","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSessionPathSpec: SkillSpec = {
  name: "GetSessionPath",
  description: "读当前 Nanonis 会话文件夹路径。",
  parameters: [],
  tags: ["util","session","path","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetAcqPeriodSpec: SkillSpec = {
  name: "GetAcqPeriod",
  description: "读 TCP Receiver 里的采集周期（s）。",
  parameters: [],
  tags: ["util","acquisition","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetRTFreqSpec: SkillSpec = {
  name: "GetRTFreq",
  description: "读实时控制器频率，单位 Hz。",
  parameters: [],
  tags: ["util","rt","frequency","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetLatestScanFileSpec: SkillSpec = {
  name: "GetLatestScanFile",
  description: "定位最近写入的那个 .sxm 扫描文件。先查 Nanonis 报出来的 session 路径，再查数据目录下的 working-sessions/，最后查历史遗留的开发目录。返回 {path: str, age_s: float}；若在 max_age_s 秒内一个都没找到，则返回 {path: null}。",
  parameters: [
    { name: "max_age_s", type: "int", description: "只考虑最近 N 秒内被修改过的 .sxm 文件", unit: "s", required: false, minValue: 1, default: 300 },
  ],
  tags: ["scan","file","read","sxm"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetBiasSpec: SkillSpec = {
  name: "SetBias",
  description: "设置偏压。大幅改变电压时，用 slew_rate_v_per_s 做渐进 ramp。",
  parameters: [
    { name: "bias_v", type: "float", description: "目标偏压，单位伏特", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "slew_rate_v_per_s", type: "float", description: "偏压最大变化速率（V/s）。省略则瞬时切换。大幅跳变电压时建议使用，以保护样品/针尖。", unit: "V/s", required: false, minValue: 0.01, maxValue: 100 },
  ],
  tags: ["bias","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSetpointSpec: SkillSpec = {
  name: "SetSetpoint",
  description: "设置 Z controller 的隧道电流 setpoint。",
  parameters: [
    { name: "setpoint_a", type: "float", description: "隧道电流 setpoint，是一个**安培量**（SI）。STM 的 setpoint 极小：1 pA … 100 nA；常见值是 100 pA。请写成**带 SI 前缀的字符串** —— '50p' 表示 50 pA，'1n' 表示 1 nA，'100p' 表示 100 pA。⚠️ 这里前缀**不是**可选的：指数写法和光秃秃的 '1.5' 都会被拒绝。这是刻意的 —— 一个丢了数量级的裸数字仍然是个合法数字，于是 1.5（= 1.5 安培，约为真实 setpoint 的 ~1e10×）就会一路畅通无阻。你若想说的是 1.5 nA，请写 '1.5n'。", unit: "A", required: true, minValue: 1e-12, maxValue: 1e-7 },
  ],
  tags: ["z","setpoint","write","readback"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ZControllerOnOffSpec: SkillSpec = {
  name: "ZControllerOnOff",
  description: "启用或禁用 Z controller（feedback 环路）。",
  parameters: [
    { name: "enable", type: "bool", description: "True 为启用，False 为禁用", required: true },
  ],
  tags: ["z","controller","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const TryEngageControllerSpec: SkillSpec = {
  name: "TryEngageController",
  description: "在**不做**粗动 auto-approach 的前提下，靠打开 Z-controller 尝试进入隧道状态。若隧道电流达到 ~setpoint，说明针已进上，feedback 保持开启；否则把 controller 重新关掉，并在结果里置 needs_auto_approach=True。当收到含糊的「进针/engage」请求时，**先**用它，再考虑退回 AutoApproach。",
  parameters: [
    { name: "settle_s", type: "float", description: "一边轮询电流、一边让 feedback 稳定下来的秒数。", required: false, minValue: 0.1, maxValue: 30, default: 1.5 },
    { name: "poll_hz", type: "int", description: "稳定期间每秒轮询电流的次数。", required: false, minValue: 1, maxValue: 100, default: 10 },
    { name: "engage_fraction", type: "float", description: "|current| 必须达到 setpoint 的这个比例，才算进上针。", required: false, minValue: 0.05, maxValue: 1, default: 0.5 },
  ],
  tags: ["z","controller","approach","engage","tip"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const WithdrawTipSpec: SkillSpec = {
  name: "WithdrawTip",
  description: "把针尖从表面完全退开。",
  parameters: [],
  tags: ["tip","withdraw","safety"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SafeRetractSpec: SkillSpec = {
  name: "SafeRetract",
  description: "安全退针（withdraw），随后**回读硬件确认它确实停在了收回位**（Z feedback 断开 + Z 停在收回端）。`retracted` 是三态：True = 已确认，False = 回读到了、但仍未到位，None = 判不了。绝不臆断为 True。",
  parameters: [],
  tags: ["tip","safety","retract"],
  category: "write",
  safetyLevel: "AUTO",
}

export const EmergencyRetractSpec: SkillSpec = {
  name: "EmergencyRetract",
  description: "经专用应急端口紧急退针。",
  parameters: [],
  tags: ["tip","safety","emergency","retract"],
  category: "write",
  safetyLevel: "AUTO",
}

export const StopScanSpec: SkillSpec = {
  name: "StopScan",
  description: "停止当前的扫描。",
  parameters: [],
  tags: ["scan","imaging","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const StopAutoApproachSpec: SkillSpec = {
  name: "StopAutoApproach",
  description: "立即停止 auto-approach 流程（AutoApproach_OnOffSet 0）。用于紧急叫停正在跑的粗动 approach —— 永远安全，从不设闸。",
  parameters: [],
  tags: ["approach","stop","safety","emergency"],
  category: "write",
  safetyLevel: "AUTO",
}

export const StopMotorSpec: SkillSpec = {
  name: "StopMotor",
  description: "紧急停止所有马达运动。",
  parameters: [],
  tags: ["motor","stop","safety"],
  category: "write",
  safetyLevel: "AUTO",
}

export const StopFolMeSpec: SkillSpec = {
  name: "StopFolMe",
  description: "停止 Follow-Me 模式下的针尖移动。",
  parameters: [],
  tags: ["folme","stop","safety"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetZCtrlGainSpec: SkillSpec = {
  name: "SetZCtrlGain",
  description: "设置 Z 控制器的 P/I 增益与时间常数。\n\n**优先使用 ApplyZCtrlPreset**(按参数组名应用,数值由代码从用户维护的存储里取)。只有当用户在本次对话里逐字念出了具体数值时,才直接调用本技能传裸数值。\n\n三个参数都是有量纲的物理量,且都是极小的数 —— **写成带 SI 前缀的字符串**(如 '3p'、'16.667u'、'180n')。⚠️ 前缀不可省略:**指数写法与裸数字都会被拒绝**。I = P / T。",
  parameters: [
    { name: "p_gain", type: "float", description: "比例增益 —— 它是一个**长度**，单位米 (Nanonis 面板上的 'Proportional (m)')。典型值 1p ~ 10p m(即 1–10 pm)。必须 >= 0。", unit: "m", required: true, minValue: 0, maxValue: 0.000001 },
    { name: "time_constant_s", type: "float", description: "时间常数，单位秒。典型值 10u ~ 100u s (即 10–100 µs)。T = P / I。", unit: "s", required: true, minValue: 0, maxValue: 10 },
    { name: "i_gain", type: "float", description: "积分增益 —— 它是一个**速度**，单位米每秒 (Nanonis 面板上的 'Integral (m/s)')。典型值 10n ~ 1u m/s(即 10 nm/s – 1 µm/s)。I = P / T,必须 >= 0。", unit: "m/s", required: true, minValue: 0, maxValue: 0.001 },
  ],
  tags: ["z","gain","write","readback"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetTipLiftSpec: SkillSpec = {
  name: "SetTipLift",
  description: "设置 Z controller 关闭时针尖回撤的量。",
  parameters: [
    { name: "tip_lift_m", type: "float", description: "针尖抬起量，单位米", unit: "m", required: true, minValue: -0.000001, maxValue: 0.000001 },
  ],
  tags: ["z","tip_lift","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetZPositionSpec: SkillSpec = {
  name: "SetZPosition",
  description: "直接设置 Z piezo 位置。Z controller 必须处于 OFF。",
  parameters: [
    { name: "z_pos_m", type: "float", description: "Z 位置，单位米", unit: "m", required: true, minValue: -0.00001, maxValue: 0.00001 },
  ],
  preconditions: ["z_controller_off"],
  tags: ["z","position","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetBiasRangeSpec: SkillSpec = {
  name: "SetBiasRange",
  description: "按索引选择偏压量程。",
  parameters: [
    { name: "range_index", type: "int", description: "要选择的偏压量程的索引", required: true, minValue: 0 },
  ],
  tags: ["bias","range","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSessionPathSpec: SkillSpec = {
  name: "SetSessionPath",
  description: "设定 Nanonis 会话文件夹路径。",
  parameters: [
    { name: "session_path", type: "str", description: "会话文件夹路径", required: true },
    { name: "save_settings_to_previous", type: "bool", description: "切换之前，把仪器**当前**的设置**写进旧**会话的设置文件里。默认 True，所以改会话文件夹并不是一次纯粹的导航操作 —— 它同时会把状态存进你正要离开的那个文件夹。传 False 则只换位置、不碰旧会话。", required: false, default: true },
  ],
  tags: ["util","session","path","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetScanBufferSpec: SkillSpec = {
  name: "SetScanBuffer",
  description: "设置扫描分辨率：每行像素数与行数。会保留当前选中的采集通道（先回读、再原样写回）。优先用 ScanAt —— 它会按用户的分尺度策略表，为所请求的扫描尺寸挑好分辨率；只有当用户点名了某个具体分辨率、或你正在调试仪器时，才用这个技能。",
  parameters: [
    { name: "pixels", type: "int", description: "每条扫描线的像素数（如 256、512、1024）。取值范围 16..4096。", unit: "px", required: true, minValue: 16, maxValue: 4096 },
    { name: "lines", type: "int", description: "扫描行数。想要方形扫描框就省略它（lines = pixels），这也是常规情形。", unit: "px", required: false, minValue: 16, maxValue: 4096 },
  ],
  preconditions: ["scan_not_running"],
  tags: ["scan","buffer","resolution","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetTipSpeedSpec: SkillSpec = {
  name: "SetTipSpeed",
  description: "设置 Follow-Me（XY 定位）模式下的针尖移动速度。",
  parameters: [
    { name: "speed_m_s", type: "float", description: "表面移动速度，单位米每秒", unit: "m/s", required: true, minValue: 0 },
    { name: "custom_speed", type: "bool", description: "True=用自定义速度，False=用扫描速度", required: false, default: true },
  ],
  tags: ["folme","speed","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetFolMeOversamplingSpec: SkillSpec = {
  name: "SetFolMeOversampling",
  description: "设置 Follow-Me 模式下移动时所采数据的 oversampling。",
  parameters: [
    { name: "oversampling", type: "int", description: "oversampling 取值", required: true, minValue: 1 },
  ],
  tags: ["folme","oversampling","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const MoveToXYSpec: SkillSpec = {
  name: "MoveToXY",
  description: "用 Follow Me 把针尖移到指定的 XY 位置。",
  parameters: [
    { name: "x_m", type: "float", description: "目标 X 位置，单位米", unit: "m", required: true, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "y_m", type: "float", description: "目标 Y 位置，单位米", unit: "m", required: true, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "wait", type: "bool", description: "返回前先等待移动完成", required: false, default: true },
    { name: "coord_epoch", type: "int", description: "目标 x/y 所属的坐标代次。**只有**当这对坐标来自某个自带代次的存储源（地图 marker、扫描计划、已保存的位点）时才传它。传了之后，若期间发生过横向粗动（lateral coarse move），这次移动就会被**拒绝** —— 那些米数如今指向的是另一块表面，而两个代次之间没有任何换算关系。对于你刚从仪器回读出来的坐标请**省略（OMIT）**它：它们按构造就是当前代次。", required: false },
  ],
  preconditions: ["z_controller_on"],
  tags: ["navigation","move","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPiezoTiltSpec: SkillSpec = {
  name: "SetPiezoTilt",
  description: "设置 piezo X、Y 轴的倾斜校正角度。",
  parameters: [
    { name: "tilt_x_deg", type: "float", description: "X 向的倾斜校正角度（度）", unit: "deg", required: true },
    { name: "tilt_y_deg", type: "float", description: "Y 向的倾斜校正角度（度）", unit: "deg", required: true },
  ],
  tags: ["piezo","tilt","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetDriftCompensationSpec: SkillSpec = {
  name: "SetDriftCompensation",
  description: "启用或禁用 piezo 漂移补偿。",
  parameters: [
    { name: "enable", type: "bool", description: "True 为启用漂移补偿", required: true },
    { name: "vx", type: "float", description: "X 向漂移速度（m/s）；默认 0.0（不做 X 轴补偿）。", unit: "m/s", required: false, minValue: -0.000001, maxValue: 0.000001, default: 0 },
    { name: "vy", type: "float", description: "Y 向漂移速度（m/s）；默认 0.0（不做 Y 轴补偿）。", unit: "m/s", required: false, minValue: -0.000001, maxValue: 0.000001, default: 0 },
    { name: "vz", type: "float", description: "Z 向漂移速度（m/s）；默认 0.0（不做 Z 轴补偿）。", unit: "m/s", required: false, minValue: -0.000001, maxValue: 0.000001, default: 0 },
  ],
  tags: ["piezo","drift","compensation"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPiezoRangeSpec: SkillSpec = {
  name: "SetPiezoRange",
  description: "设置全部 3 个轴的 piezo 量程（m）。改量程的同时也会改 sensitivity（HV gain 不变）。",
  parameters: [
    { name: "range_x_m", type: "float", description: "X 轴的 piezo 量程（m）", unit: "m", required: true, minValue: 1e-12, maxValue: 0.001 },
    { name: "range_y_m", type: "float", description: "Y 轴的 piezo 量程（m）", unit: "m", required: true, minValue: 1e-12, maxValue: 0.001 },
    { name: "range_z_m", type: "float", description: "Z 轴的 piezo 量程（m）", unit: "m", required: true, minValue: 1e-12, maxValue: 0.001 },
  ],
  tags: ["piezo","range","calibration","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetHomePropsSpec: SkillSpec = {
  name: "SetHomeProps",
  description: "设置 Z controller 的 Home 位置模式与数值。",
  parameters: [
    { name: "rel_or_abs", type: "int", description: "0=不变，1=绝对，2=相对", required: true, minValue: 0, maxValue: 2 },
    { name: "home_position_m", type: "float", description: "Home 位置，单位米", unit: "m", required: true, minValue: -0.000001, maxValue: 0.000001 },
  ],
  tags: ["z","home","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSwitchOffDelaySpec: SkillSpec = {
  name: "SetSwitchOffDelay",
  description: "设置 Z controller 的关断延时，单位秒。",
  parameters: [
    { name: "delay_s", type: "float", description: "关断延时，单位秒", unit: "s", required: true, minValue: 0 },
  ],
  tags: ["z","switchoff","delay","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetCurrentGainSpec: SkillSpec = {
  name: "SetCurrentGain",
  description: "设置电流放大器的增益档位与滤波器。",
  parameters: [
    { name: "gain_index", type: "int", description: "增益档位索引，取自 Current.GainsGet 返回的列表", required: true, minValue: 0 },
    { name: "filter_index", type: "int", description: "滤波器索引", required: false, minValue: 0, default: 0 },
  ],
  tags: ["current","gain","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const MotorMoveSpec: SkillSpec = {
  name: "MotorMove",
  description: "驱动粗动马达（pan 型步进）。x±/y± 为横向；'z-approach' 朝**样品方向**走步（DANGEROUS —— 需要人工批准）；'z-retract' 朝**远离样品**走步（安全）。",
  parameters: [
    { name: "direction", type: "str", description: "马达方向：'x+','x-','y+','y-'（横向）、'z-approach'（朝样品）、'z-retract'（远离样品）", required: true, allowedValues: ["x+","x-","y+","y-","z-approach","z-retract"] },
    { name: "steps", type: "int", description: "马达走步数", required: true, minValue: 1, maxValue: 1000 },
  ],
  preconditions: ["z_controller_off"],
  tags: ["motor","coarse","relocation"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const MotorMoveClosedLoopSpec: SkillSpec = {
  name: "MotorMoveClosedLoop",
  description: "闭环粗动到目标 XYZ。DANGEROUS:可能与样品相撞 —— 横向与远离样品的移动是常规操作;朝样品走的那一段由人工批准挡着。并非所有控制器都支持闭环。",
  parameters: [
    { name: "absolute", type: "bool", description: "True 表示绝对位置，False 表示相对移动", required: false, default: false },
    { name: "target_x_m", type: "float", description: "目标 X 位置，单位米", unit: "m", required: true },
    { name: "target_y_m", type: "float", description: "目标 Y 位置，单位米", unit: "m", required: true },
    { name: "target_z_m", type: "float", description: "目标 Z 位置，单位米", unit: "m", required: true, minValue: -0.0001, maxValue: 0.0001 },
    { name: "wait", type: "bool", description: "等到移动结束再返回", required: false, default: true },
    { name: "group", type: "int", description: "马达组（0-5）", required: false, minValue: 0, maxValue: 5, default: 0 },
  ],
  preconditions: ["z_controller_off"],
  tags: ["motor","coarse","closed_loop","dangerous"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const EnableSafeTipSpec: SkillSpec = {
  name: "EnableSafeTip",
  description: "启用或禁用 Nanonis 硬件 SafeTip 保护。",
  parameters: [
    { name: "enable", type: "bool", description: "True 为启用，False 为禁用。默认 True：不带参数、走默认的调用会**启用** SafeTip（硬件针尖保护应当保持开启，除非用户显式传 enable=False）。", required: false, default: true },
  ],
  tags: ["safety","hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetZLimitsEnabledSpec: SkillSpec = {
  name: "SetZLimitsEnabled",
  description: "启用或禁用 Z 位置的安全限位。",
  parameters: [
    { name: "enabled", type: "bool", description: "True 为启用 Z 限位，False 为禁用。默认为 True：不带参数、走默认的调用会**启用** Z 软限位（除非用户显式传 enabled=False，否则它们应当保持开启）。", required: false, default: true },
  ],
  tags: ["z","limits","safety","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetBiasCalibrationSpec: SkillSpec = {
  name: "SetBiasCalibration",
  description: "设置偏压的标定系数与偏移量。会影响所有偏压测量。",
  parameters: [
    { name: "calibration", type: "float", description: "偏压标定系数（V/V 倍率）", required: true, minValue: 0.001, maxValue: 1000 },
    { name: "offset", type: "float", description: "偏压偏移量（V）", unit: "V", required: true, minValue: -100, maxValue: 100 },
  ],
  tags: ["bias","calibration","write","dangerous"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetCurrentCalibrationSpec: SkillSpec = {
  name: "SetCurrentCalibration",
  description: "为 Current 模块中选定的增益档位设置标定值与偏移量。",
  parameters: [
    { name: "gain_index", type: "int", description: "增益档位索引（-1 = 当前选中的增益档）", required: false, default: -1 },
    { name: "calibration", type: "float", description: "标定值（float64，A/A 倍率）", required: true, minValue: 0.001, maxValue: 1000 },
    { name: "offset", type: "float", description: "偏移量（float64，A）", unit: "A", required: true, minValue: -1, maxValue: 1 },
  ],
  tags: ["current","calibration","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetMotorFreqAmpSpec: SkillSpec = {
  name: "SetMotorFreqAmp",
  description: "设置粗动马达的驱动频率与幅度(电压)。**这是用户的参数,不是 agent 的。**写入必须落在【高级】页声明的本机耐压上限之内;未声明则一律拒绝,超上限**直接拒绝而不是降到上限**(悄悄降下来会让调用方以为自己设的是另一个值)。",
  parameters: [
    { name: "frequency_hz", type: "float", description: "马达驱动频率，单位 Hz", unit: "Hz", required: true, minValue: 0, maxValue: 20000 },
    { name: "amplitude_v", type: "float", description: "马达驱动幅度，单位伏特", unit: "V", required: true, minValue: 0, maxValue: 400 },
    { name: "axis", type: "str", description: "马达轴：'all'、'x'、'y' 或 'z'", required: false, allowedValues: ["all","x","y","z"], default: "all" },
  ],
  tags: ["motor","frequency","amplitude","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const LockNanonisUISpec: SkillSpec = {
  name: "LockNanonisUI",
  description: "锁定 Nanonis 软件 —— 这会在它上面盖一个**模态窗口**，并**阻止用户与仪器交互**，直到被解锁为止。\n\nDANGEROUS，而且不是因为它对硬件做了什么。这里其余每一道安全机制 —— 安全闸门、模式闸门、abort 按钮、审批提示 —— 归根结底都依赖于「有个人能走到显微镜跟前接管」。这个技能把那件事拿掉了。它需要人工批准正是因为这个原因，而且基本上没有哪个自主任务需要它：用户若想在无人值守运行期间锁住界面，他自己锁就是了 —— 这恰恰就是重点所在。\n\nUnlockNanonisUI 是它的反面，并且永远允许。",
  parameters: [],
  tags: ["util","lock","dangerous","write"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const CreateZCtrlPresetSpec: SkillSpec = {
  name: "CreateZCtrlPreset",
  description: "新建(或覆盖)一个自定义 Z 参数组,之后可以用 ApplyZCtrlPreset 按名应用。\n\n**数值必须写成带 SI 前缀的字符串**,例如 p_gain='3p'、i_gain='180n'、setpoint_a='150p' —— 与 Nanonis 面板上的写法一致。**前缀不可省略**:裸数字(如 '3')会被直接拒绝。原因是量级一旦丢失,裸数字仍然是一个合法的数,错一万亿倍也没人发现;而前缀掉了就解析失败,你会立刻收到一次明确的拒绝。\n\n不要用本技能去改进针参数或扫图档位表 —— 那两套由用户在设置界面维护。本技能只管自定义组。",
  parameters: [
    { name: "name", type: "str", description: "参数组名。不能与保留名(approach / scan)或扫描档名重复。", required: true },
    { name: "p_gain", type: "str", description: "Z 比例增益,带 SI 前缀的字符串,单位米。例如 '3p' = 3p m。典型 1p ~ 10p。**必须带前缀**。", unit: "m", required: true },
    { name: "i_gain", type: "str", description: "Z 积分增益,带 SI 前缀的字符串,单位米每秒。例如 '180n' = 180n m/s。典型 10n ~ 1u。**必须带前缀**。", unit: "m/s", required: true },
    { name: "setpoint_a", type: "str", description: "可选。电流设定点,带 SI 前缀的字符串,单位安培。例如 '150p' = 150p A。留空表示这组不改设定点。", unit: "A", required: false },
    { name: "note", type: "str", description: "可选。这组参数的用途说明,给用户看。", required: false },
    { name: "overwrite", type: "bool", description: "同名组已存在时是否替换。默认 False(存在则拒绝)。", required: false, default: false },
  ],
  tags: ["z","gain","preset","config"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const AutoApproachSpec: SkillSpec = {
  name: "AutoApproach",
  description: "启动 auto approach 流程。它会把针尖朝表面移动。",
  parameters: [
    { name: "wait_timeout_s", type: "float", description: "等待粗动 approach 达到 setpoint 的最长秒数；到点则停掉该模块并报告「未完成」。它**只是一道兜底（BACKSTOP）** —— 模块一旦达到 setpoint，等待就立刻结束，所以保留那个宽松的默认值（1800 s = 30 分钟）是安全的。从远处开始的粗动 approach 可能要花好几分钟；**不要**把它降到几百秒，否则你可能会在一次有效的 approach 触到表面之前就把它截断。", required: false, minValue: 5, maxValue: 3600, default: 1800 },
  ],
  preconditions: ["bias_nonzero"],
  tags: ["approach","tip"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ApproachTipSpec: SkillSpec = {
  name: "ApproachTip",
  description: "面对一句朴素的「进针」，用**安全**的方式建立隧道：先试着让 Z-controller 进上（feedback 开，不动马达）；**只有**当这条路够不到隧道时，才退回到带电流反馈的 AutoApproach（Nanonis 会在 setpoint 处停住 —— 不会撞针）。含糊的「进针 / engage / 把针进上」这类请求，**默认**就用它。",
  parameters: [
    { name: "settle_s", type: "float", description: "engage 阶段里，一边轮询电流、一边让 feedback 稳定下来的秒数。", required: false, minValue: 0.1, maxValue: 30, default: 1.5 },
  ],
  tags: ["approach","engage","tip","进针","smart"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ApplyZCtrlPresetSpec: SkillSpec = {
  name: "ApplyZCtrlPreset",
  description: "按**参数组名**把 Z 控制器参数(P/I 增益 + 设定点)写进硬件。\n\n**这是设置 Z 参数的首选方式**,优先于 SetZCtrlGain / SetSetpoint:具体数值由代码从用户维护的存储里取出并写入,你只需要说用哪一组,不需要(也不应该)自己写出任何数字。\n\n常用组名:\n- `approach` —— 进针参数(来自仪器档案,用户填写)\n- `scan` —— 扫图参数(按当前扫描帧尺寸自动选档,与 ScanAt 同源)\n- 也可以直接用扫描档名(如 `atomic`)或自定义组名\n\n用 ListZCtrlPresets 查看当前可用的全部组名与数值。写入后会自动回读比对,不一致会报失败。",
  parameters: [
    { name: "preset", type: "str", description: "参数组名,如 'approach' / 'scan' / 档名 / 自定义组名。不确定有哪些就先调 ListZCtrlPresets。", required: true },
  ],
  tags: ["z","gain","setpoint","preset","write","readback"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ListZCtrlPresetsSpec: SkillSpec = {
  name: "ListZCtrlPresets",
  description: "列出当前可用的全部 Z 参数组名及其数值与来源。在调用 ApplyZCtrlPreset 之前不确定有哪些组时使用。",
  parameters: [],
  tags: ["z","gain","preset","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureScanSpec: SkillSpec = {
  name: "ConfigureScan",
  description: "配置扫描框：中心、尺寸、角度，以及采集通道。默认还会顺带设置由 line_time_s 推导出的扫描速度（线速度 = width_m / line_time_s）；传 set_scan_speed=False 则保持当前扫描速度不动。",
  parameters: [
    { name: "center_x_m", type: "float", description: "扫描中心的 X 坐标，单位米", unit: "m", required: true },
    { name: "center_y_m", type: "float", description: "扫描中心的 Y 坐标，单位米", unit: "m", required: true },
    { name: "width_m", type: "float", description: "扫描宽度，单位**米**（SI），**不是**纳米。换算：100 nm → 100n，50 nm → 50n。像 100（=100 m）这样的裸数值是单位错误，会被拒绝。", unit: "m", required: true, minValue: 1e-10, maxValue: 0.00001 },
    { name: "height_m", type: "float", description: "扫描高度，单位**米**（SI），**不是**纳米。换算：100 nm → 100n，50 nm → 50n。像 100（=100 m）这样的裸数值是单位错误，会被拒绝。", unit: "m", required: true, minValue: 1e-10, maxValue: 0.00001 },
    { name: "angle_deg", type: "float", description: "扫描角度，单位度。**省略**它则保持当前扫描框的角度不变（角度会从仪器回读；若这次回读失败，这个技能就**失败**，它绝不会臆断为 0°）。想要与坐标轴对齐的扫描框，就显式传 0。", unit: "deg", required: false, minValue: -180, maxValue: 180 },
    { name: "channels", type: "str", description: "要采集的通道名，逗号分隔。默认：'Z,Current'。做 STS mapping 时加上 lock-in：'Z,Current,LI Demod 1 X,LI Demod 1 Y'", required: false, default: "Z,Current" },
    { name: "set_scan_speed", type: "bool", description: "为 True（默认）时，顺带设置由 line_time_s 推导出的扫描速度（正扫线速度 = width_m / line_time_s，保持每行耗时恒定）。设为 False 则**只**配置扫描框 + 通道，并保持当前扫描速度不动（要显式控制速度请用 SetScanSpeed）。", required: false, default: true },
    { name: "line_time_s", type: "float", description: "每条扫描线的耗时，单位秒；当 set_scan_speed 为 True 时用它推导扫描速度。**留空则按这个扫描框尺寸套用出厂的 scan tier**（8 nm -> 原子级档 -> 1.2 s/line）。set_scan_speed 为 False 时本项忽略。", unit: "s", required: false, minValue: 0.0001, maxValue: 600 },
  ],
  tags: ["scan","imaging","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetScanSpeedSpec: SkillSpec = {
  name: "SetScanSpeed",
  description: "设置扫描速度：正/反扫速度，或每行耗时。",
  parameters: [
    { name: "fwd_speed", type: "float", description: "正扫速度，单位 m/s", unit: "m/s", required: true, minValue: 0 },
    { name: "bwd_speed", type: "float", description: "反扫速度，单位 m/s", unit: "m/s", required: true, minValue: 0 },
    { name: "fwd_line_time", type: "float", description: "正扫每行耗时，单位秒", unit: "s", required: true, minValue: 0 },
    { name: "bwd_line_time", type: "float", description: "反扫每行耗时，单位秒", unit: "s", required: true, minValue: 0 },
    { name: "keep_const", type: "int", description: "0 = 不变，1 = 保持线速度恒定，2 = 保持每行耗时恒定", required: false, allowedValues: [0,1,2], default: 0 },
    { name: "speed_ratio", type: "float", description: "正扫/反扫速度比（1.0 = 对称）", required: false, minValue: 0, default: 1 },
  ],
  tags: ["scan","speed","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StartScanSpec: SkillSpec = {
  name: "StartScan",
  description: "用当前参数启动一次扫描。",
  parameters: [
    { name: "direction", type: "str", description: "扫描方向。``down`` = 从帧顶往下扫(出厂默认,也是本机至今**全部** 287 帧的方向);``up`` = 从帧底往上扫。对应 ``Scan_Action(0, dir)`` 的第二个参数(0=down / 1=up)。", required: false, allowedValues: ["down","up"], default: "down" },
    { name: "allow_continuous_scan", type: "bool", description: "**用户级覆盖,不是重试开关。** 置 True 表示:即使 MAST 无法确认 Nanonis 的 Continuous scan 已经关掉,也照样发起扫描。代价是具体的 —— 扫描可能一帧接一帧永不停止,于是 WaitScanComplete 只能等满超时(outcome=restarted),而 SaveScan / 扫描地图登记拿到的可能是第 N+2 帧而不是第 N 帧。**先试另外两条出口**:把那次读失败当 bug 修掉;或者直接在 Nanonis 的 Scan 模块里关掉 Continuous scan(那样下一次 StartScan 读到「关」就直接放行)。", required: false, default: false },
  ],
  preconditions: ["z_controller_on"],
  tags: ["scan","imaging","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const WaitScanCompleteSpec: SkillSpec = {
  name: "WaitScanComplete",
  description: "等待当前扫描结束，或等到超时。",
  parameters: [
    { name: "timeout_ms", type: "int", description: "超时时长，单位毫秒（-1 = 无限等待）", unit: "ms", required: false, minValue: -1, default: -1 },
  ],
  tags: ["scan","wait","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SaveScanSpec: SkillSpec = {
  name: "SaveScan",
  description: "把当前的扫描数据缓冲存成文件。",
  parameters: [
    { name: "timeout_ms", type: "int", description: "保存的超时，单位 ms（-1 = 永远等待）", unit: "ms", required: false, minValue: -1, default: -1 },
  ],
  tags: ["scan","save","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GrabScanFrameDataSpec: SkillSpec = {
  name: "GrabScanFrameData",
  description: "抓取某一路扫描通道的整帧采样（Scan_FrameDataGrab），存成一个 .npy 文件；返回的是文件**路径**（不是数组本身）。direction=1 取正扫，0 取反扫。通道 0 是第一路采集通道（通常是形貌）；通道 14 是 Z-controller 信号。",
  parameters: [
    { name: "channel_index", type: "int", description: "采集通道索引（0 = 第一路 / 形貌）", required: true, minValue: 0 },
    { name: "direction", type: "int", description: "1 = 正扫，0 = 反扫", required: false, allowedValues: [0,1], default: 1 },
    { name: "save_path", type: "str", description: "可选：显式指定 .npy 输出路径；默认 = <data>/experiments/frames/", required: false, default: "" },
  ],
  tags: ["scan","frame","read","g1"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetBiasRampSpec: SkillSpec = {
  name: "SetBiasRamp",
  description: "把偏压从起始值分小步 ramp 到目标值（受 slew rate 限制）。大幅改变偏压时用它，以保护样品 / 针尖。",
  parameters: [
    { name: "bias_v_end", type: "float", description: "目标偏压，单位伏特", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "bias_v_start", type: "float", description: "起始偏压。省略则取当前的 Bias_Get 读数。", unit: "V", required: false, minValue: -10, maxValue: 10 },
    { name: "slew_rate_v_per_s", type: "float", description: "偏压最大变化速率（V/s）。ramp 会被切成 N=max(1, |Δv| / (slew * step_interval)) 步。", unit: "V/s", required: false, minValue: 0.01, maxValue: 100, default: 1 },
    { name: "step_interval_s", type: "float", description: "两步 ramp 之间的等待时长", unit: "s", required: false, minValue: 0.001, maxValue: 10, default: 0.1 },
  ],
  tags: ["bias","ramp","write","composite"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetSignalsAddRTSpec: SkillSpec = {
  name: "GetSignalsAddRT",
  description: "读可用的附加 RT 信号列表，以及当前指派给 Internal 23 与 Internal 24 的名字。",
  parameters: [],
  tags: ["signals","rt","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetCurrentBEEMSpec: SkillSpec = {
  name: "GetCurrentBEEM",
  description: "从 Current 模块读取 BEEM 电流值。",
  parameters: [],
  tags: ["current","beem","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetCurrentGainsSpec: SkillSpec = {
  name: "GetCurrentGains",
  description: "读回电流前放的增益档位表、当前档位与该档的满量程(安培)。只读,不改硬件。增益名是跨阻(V/A),满量程 = 10 V / 跨阻。",
  parameters: [],
  tags: ["read","readback","current","preamp","gain"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ScanBackgroundDeleteSpec: SkillSpec = {
  name: "ScanBackgroundDelete",
  description: "删除最近一次、或全部已粘贴的 scan background。",
  parameters: [
    { name: "wait_until_deleted", type: "bool", description: "等到数据删除完成再返回", required: false, default: true },
    { name: "timeout_ms", type: "int", description: "超时时长，单位毫秒（-1 = 无限等待）", required: false, default: -1 },
    { name: "delete_all", type: "bool", description: "True=删除全部 background，False=只删最近一次", required: false, default: false },
  ],
  tags: ["scan","background","delete","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ScanBackgroundPasteSpec: SkillSpec = {
  name: "ScanBackgroundPaste",
  description: "把当前的扫描数据缓冲粘贴到 background。",
  parameters: [
    { name: "wait_until_pasted", type: "bool", description: "等到数据粘贴完成再返回", required: false, default: true },
    { name: "timeout_ms", type: "int", description: "超时时长，单位毫秒（-1 = 无限等待）", required: false, default: -1 },
  ],
  tags: ["scan","background","paste","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPointShootPropsSpec: SkillSpec = {
  name: "GetPointShootProps",
  description: "读取 Point & Shoot 配置：auto-resume、basename、外部 VI 路径、测量前延时。",
  parameters: [],
  tags: ["folme","point_shoot","config","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPointShootExperimentSpec: SkillSpec = {
  name: "SetPointShootExperiment",
  description: "选择 Follow-Me 模式下 Point & Shoot 要运行哪个 experiment。",
  parameters: [
    { name: "experiment_index", type: "int", description: "要选择的 Point & Shoot experiment 的索引", required: true, minValue: 0 },
  ],
  tags: ["folme","point_shoot","experiment","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPointShootOnOffSpec: SkillSpec = {
  name: "SetPointShootOnOff",
  description: "启用或禁用 Follow-Me 模式下的 Point & Shoot。",
  parameters: [
    { name: "enable", type: "bool", description: "True 为启用 Point & Shoot，False 为禁用", required: true },
  ],
  tags: ["folme","point_shoot","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetRTOversampleSpec: SkillSpec = {
  name: "GetRTOversample",
  description: "读 TCP Receiver 里的实时过采样值。",
  parameters: [],
  tags: ["util","rt","oversampling","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetRTFreqSpec: SkillSpec = {
  name: "SetRTFreq",
  description: "设定实时控制器频率，单位 Hz。",
  parameters: [
    { name: "frequency_hz", type: "float", description: "RT 频率，单位 Hz", unit: "Hz", required: true, minValue: 0 },
  ],
  tags: ["util","rt","frequency","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetRTOversampleSpec: SkillSpec = {
  name: "SetRTOversample",
  description: "设定 TCP Receiver 里的实时过采样值。",
  parameters: [
    { name: "oversampling", type: "int", description: "RT 过采样值", required: true, minValue: 1 },
  ],
  tags: ["util","rt","oversampling","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const LoadLayoutSpec: SkillSpec = {
  name: "LoadLayout",
  description: "从 .ini 文件载入一份 Nanonis 布局。",
  parameters: [
    { name: "file_path", type: "str", description: "布局 .ini 文件的路径（use_session=True 时忽略）", required: false, default: "" },
    { name: "use_session", type: "bool", description: "从当前会话文件载入布局", required: false, default: false },
  ],
  tags: ["util","layout","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SaveLayoutSpec: SkillSpec = {
  name: "SaveLayout",
  description: "把当前 Nanonis 布局存到 .ini 文件。",
  parameters: [
    { name: "file_path", type: "str", description: "布局 .ini 文件的路径（use_session=True 时忽略）", required: false, default: "" },
    { name: "use_session", type: "bool", description: "把布局存到当前会话文件", required: false, default: false },
  ],
  tags: ["util","layout","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SaveSettingsSpec: SkillSpec = {
  name: "SaveSettings",
  description: "把 Nanonis 设置存到 .ini 文件，或从 .ini 文件载入。",
  parameters: [
    { name: "action", type: "str", description: "'save' 或 'load'", required: true, allowedValues: ["save","load"] },
    { name: "file_path", type: "str", description: "设置 .ini 文件的路径（use_session=True 时忽略）", required: false, default: "" },
    { name: "use_session", type: "bool", description: "用当前会话文件，而不是 file_path", required: false, default: false },
  ],
  tags: ["util","settings","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const UnlockNanonisUISpec: SkillSpec = {
  name: "UnlockNanonisUI",
  description: "解锁 Nanonis 界面（关掉 Lock 模态窗口）。",
  parameters: [],
  tags: ["util","unlock","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetPiezoHVAInfoSpec: SkillSpec = {
  name: "GetPiezoHVAInfo",
  description: "读取 AUX、X、Y、Z 各轴的 HVA gain 回读信息，以及它们的启用状态。",
  parameters: [],
  tags: ["piezo","hva","gain","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPiezoHVAStatusLEDSpec: SkillSpec = {
  name: "GetPiezoHVAStatusLED",
  description: "读取 HVA 的 LED 状态：过热、HV 供电、高温、输出接口。",
  parameters: [],
  tags: ["piezo","hva","status","led","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const LoadPiezoHysteresisFileSpec: SkillSpec = {
  name: "LoadPiezoHysteresisFile",
  description: "在 Piezo Configuration 模块中，从一个 .csv 文件载入并应用两个轴的 hysteresis 补偿值。",
  parameters: [
    { name: "file_path", type: "str", description: ".csv hysteresis 文件的路径", required: true },
  ],
  tags: ["piezo","hysteresis","file","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPiezoHysteresisOnOffSpec: SkillSpec = {
  name: "SetPiezoHysteresisOnOff",
  description: "启用或禁用 Piezo Configuration 中的 hysteresis 补偿。",
  parameters: [
    { name: "enable", type: "bool", description: "True 为启用 hysteresis 补偿，False 为禁用", required: true },
  ],
  tags: ["piezo","hysteresis","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPiezoHysteresisValuesSpec: SkillSpec = {
  name: "SetPiezoHysteresisValues",
  description: "在 Piezo Calibration 模块中，为 fast 轴与 slow 轴设置并应用 hysteresis 补偿点。",
  parameters: [
    { name: "fast_x", type: "str", description: "fast 轴 X 的 hysteresis 补偿点，用浮点数 JSON 列表表示", required: true },
    { name: "fast_y", type: "str", description: "fast 轴 Y 的 hysteresis 补偿点，用浮点数 JSON 列表表示", required: true },
    { name: "slow_x", type: "str", description: "slow 轴 X 的 hysteresis 补偿点，用浮点数 JSON 列表表示", required: true },
    { name: "slow_y", type: "str", description: "slow 轴 Y 的 hysteresis 补偿点，用浮点数 JSON 列表表示", required: true },
  ],
  tags: ["piezo","hysteresis","calibration","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPiezoSensitivitySpec: SkillSpec = {
  name: "SetPiezoSensitivity",
  description: "设置全部 3 个轴的 piezo sensitivity（m/V）。改 sensitivity 的同时也会改量程（HV gain 不变）。",
  parameters: [
    { name: "sens_x", type: "float", description: "X 轴的 sensitivity（m/V）", unit: "m/V", required: true, minValue: 1e-12, maxValue: 0.001 },
    { name: "sens_y", type: "float", description: "Y 轴的 sensitivity（m/V）", unit: "m/V", required: true, minValue: 1e-12, maxValue: 0.001 },
    { name: "sens_z", type: "float", description: "Z 轴的 sensitivity（m/V）", unit: "m/V", required: true, minValue: 1e-12, maxValue: 0.001 },
  ],
  tags: ["piezo","sensitivity","calibration","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetMiscInstrumentConfigSpec: SkillSpec = {
  name: "GetMiscInstrumentConfig",
  description: "回读那些不归属于某个更大子系统的设置：**偏压量程**、电流前放的标定与可用增益档、原子跟踪器的参数、粗动马达的频率／幅度、偏压扫描器与通用扫描器的限值、Follow-Me 的过采样与 point-&-shoot 设置、函数发生器的空闲值与所驱动的信号，以及 1 通道示波器的通道。\n\n单看每一项都很小；合起来，它们是其余每一个读数被缩放所依据的那些数字。尤其是电流**标定**：它错了，MAST 有史以来报出的每一个电流都会差一个固定倍数，而且悄无声息。",
  parameters: [],
  tags: ["read","readback","verify","calibration"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPiezoConfigSpec: SkillSpec = {
  name: "GetPiezoConfig",
  description: "回读压电：它的**量程**、标定、灵敏度、迟滞校正（开／关及其系数）、漂移补偿、倾斜，以及 **XYZ 电压限值**。\n\n量程和限值是把一个下达的电压变成一段距离、并框住它能走多远的那两样东西。MAST 从前能设量程却读不回来 —— 也就是说，它算出的每一个位置，都建立在一个它无从核对的数字上。",
  parameters: [],
  tags: ["piezo","read","readback","verify"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPllConfigSpec: SkillSpec = {
  name: "GetPllConfig",
  description: "回读 PLL：**激励输出是否开着**、幅度控制器的设定值与带宽、相位控制器的带宽、解调器的相位参考与谐波次数、输入量程，以及频率／激励的覆写。\n\n`excitation_on` 是最该先看的一项：MAST 从前能把 PLL 激励打开，却没有任何办法问它到底开没开。一路被忘在开启状态的激励，意味着你以为静止的悬臂其实正在被驱动。",
  parameters: [
    { name: "modulator", type: "int", description: "调制器序号", required: false, minValue: 1, maxValue: 8, default: 1 },
    { name: "demodulator", type: "int", description: "解调器序号", required: false, minValue: 1, maxValue: 8, default: 1 },
  ],
  tags: ["pll","read","readback","verify"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetScanPatternConfigSpec: SkillSpec = {
  name: "GetScanPatternConfig",
  description: "回读图案模块：网格定义、线定义，以及图案实验的属性（跑哪个实验、文件基名、测量前延时）。\n\n一个跑在错误网格上的网格实验，就是在错误的地方测上好几个小时 —— 而这个网格此前是只写的。",
  parameters: [],
  tags: ["pattern","grid","read","readback","verify"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSpectroscopyConfigSpec: SkillSpec = {
  name: "GetSpectroscopyConfig",
  description: "回读谱学配置 —— 偏压谱、Z 谱，或两者都读：扫描属性、高级属性（Z 控制器是否保持、终点 Z、是否记录终点 Z）、多线段（MLS）模式及其分段取值，以及 Z 谱的退针延时。\n\n用它在跑之前确认一次谱学确实是按你要的那样设好的。一张糟糕的 MLS 分段表、或一个没料到的「Z 控制器保持开启」，都不会报错 —— 它只是产出一条含义与你所想不同的曲线。",
  parameters: [
    { name: "which", type: "str", description: "bias | z | both", required: false, allowedValues: ["bias","z","both"], default: "both" },
  ],
  tags: ["spectroscopy","sts","read","readback","verify"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetTipShaperConfigSpec: SkillSpec = {
  name: "GetTipShaperConfig",
  description: "回读 tip-shaper 配置：关断延时、是否改变偏压、所用的偏压与 lift、下压／回撤速度、各段等待时间，以及事后是否恢复反馈。\n\n**请用 `props_named`** —— 同一批数值，按协议自己的字段名索引（`bias_v`、`tip_lift_m`、`lift_height_m`……）。`props` 是原始的 11 元素线上数组，保留下来作为证据；**不要**靠猜顺序去下标取值。它把**电压**和 **Z 抬升**混在一起，所以错一位就会把一个偏压读成一个高度。`props_named` 为 null 时，说明仪器返回的值个数出乎意料，`props_named_error` 会说明这一点 —— 那种情况下请把顺序当作未知。\n\n在 TipShape **之前**读这个。修针是蓄意把针尖**扎进**表面 —— 这些参数就是「一次受控的轻戳」与「一根埋进去的针」之间的分界，而在此之前 MAST 能设它们却看不到它们。",
  parameters: [],
  tags: ["tip","tipshaper","read","readback","verify"],
  category: "read",
  safetyLevel: "AUTO",
}

export const CheckScanForCrashSpec: SkillSpec = {
  name: "CheckScanForCrash",
  description: "从刚采到的这一帧里检测撞针：抓取几路探针通道，只要有任何一路的方差接近零、或出现 NaN，就标记为撞针。返回 crash_indicator + status（ok/crash/skipped）+ 每路通道的判语。Channels = 逗号分隔的索引列表（默认 '0,14'：形貌 + Z-controller 信号 —— 撞针会把 Z 压平，哪怕通道 0 看起来还说得过去）。",
  parameters: [
    { name: "channels", type: "str", description: "要探测的采集通道索引，逗号分隔", required: false, default: "0,14" },
    { name: "direction", type: "int", description: "1 = 正扫，0 = 反扫", required: false, allowedValues: [0,1], default: 1 },
  ],
  tags: ["scan","crash","safety","analysis","g1"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const GetLockInConfigSpec: SkillSpec = {
  name: "GetLockInConfig",
  description: "把 lock-in 完整读回来：开/关、幅度、频率、相位，以及 —— 以前只写不可读的那部分 —— 它调制的到底是哪一路信号、谐波次数、调制器与解调器的相位寄存器、解调器的实时信号及其 sync 滤波器。\n\n相信任何一条 dI/dV 之前，先查 `modulated_signal`：调制错了信号的 lock-in 会给出一条完美干净、却彻头彻尾错误的曲线，而且它没有任何一处看起来是错的。",
  parameters: [
    { name: "modulator", type: "int", description: "调制器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）；默认取调制器的编号", required: false, minValue: 1, default: 1 },
  ],
  tags: ["lockin","config","read","readback","verify"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureLockInSpec: SkillSpec = {
  name: "ConfigureLockIn",
  description: "配置 lock-in 放大器调制的开/关与各项参数。",
  parameters: [
    { name: "mod_on", type: "bool", description: "启用或禁用调制", required: true },
    { name: "amplitude_v", type: "float", description: "调制幅度，单位伏特。省略 = 幅度保持原样。显式写 0 依然有效，而且依然表示 0 V —— 正因如此，本参数绝不能对外声称默认值是 0。", unit: "V", required: false, minValue: 0, maxValue: 1 },
    { name: "frequency_hz", type: "float", description: "调制频率，单位 Hz。省略 = 频率保持原样。", unit: "Hz", required: false, minValue: 0 },
    { name: "phase_deg", type: "float", description: "调制相位，单位度。**除非你明确就是要改相位，否则请省略本参数。** 在某些设备上（包括真机），调制器根本没有相位字段，这次写入会被无条件拒绝 —— 你想要的相位几乎一定是 DEMODULATOR 的 Ref. Phase（ConfigureLockInDemod）。省略 = 完全不写调制器的相位寄存器。", unit: "deg", required: false, minValue: -360, maxValue: 360 },
  ],
  tags: ["lockin","modulation","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureLockInDemodSpec: SkillSpec = {
  name: "ConfigureLockInDemod",
  description: "配置 lock-in 解调器：信号、谐波、滤波器、相位。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "signal_index", type: "int", description: "解调信号索引（0-127）", required: false, minValue: 0, maxValue: 127 },
    { name: "harmonic", type: "int", description: "谐波次数（1=基频）", required: false, minValue: 1 },
    { name: "lp_order", type: "int", description: "低通滤波器阶数（-1=不改，0=关，1-8）", required: false, minValue: -1, maxValue: 8 },
    { name: "lp_cutoff_hz", type: "float", description: "低通滤波器截止频率（0=不改）", unit: "Hz", required: false, minValue: 0 },
    { name: "hp_order", type: "int", description: "高通滤波器阶数（-1=不改，0=关，1-8）", required: false, minValue: -1, maxValue: 8 },
    { name: "hp_cutoff_hz", type: "float", description: "高通滤波器截止频率（0=不改）", unit: "Hz", required: false, minValue: 0 },
    { name: "phase_deg", type: "float", description: "解调器的参考相位", unit: "deg", required: false, minValue: -360, maxValue: 360 },
  ],
  tags: ["lockin","demodulator","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetDemodSignalSpec: SkillSpec = {
  name: "GetDemodSignal",
  description: "读某个 lock-in 解调器的解调信号索引（0-127）。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["lockin","demodulator","signal","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetDemodPhaseSpec: SkillSpec = {
  name: "GetDemodPhase",
  description: "读某个 lock-in 解调器的参考相位。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["lockin","demodulator","phase","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetDemodPhasRegSpec: SkillSpec = {
  name: "GetDemodPhasReg",
  description: "读某个 lock-in 解调器的相位寄存器索引（1-8）。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["lockin","demodulator","phase","register","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetDemodHarmonicSpec: SkillSpec = {
  name: "GetDemodHarmonic",
  description: "读某个 lock-in 解调器的谐波次数。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["lockin","demodulator","harmonic","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetDemodLPFilterSpec: SkillSpec = {
  name: "GetDemodLPFilter",
  description: "读某个 lock-in 解调器的低通滤波器阶数与截止频率。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["lockin","demodulator","lp","filter","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetDemodHPFilterSpec: SkillSpec = {
  name: "GetDemodHPFilter",
  description: "读某个 lock-in 解调器的高通滤波器阶数与截止频率。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["lockin","demodulator","hp","filter","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetModSignalSpec: SkillSpec = {
  name: "SetModSignal",
  description: "为某个 lock-in 调制器选择被调制的信号（按索引 0-127）。",
  parameters: [
    { name: "modulator", type: "int", description: "调制器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "signal_index", type: "int", description: "信号索引（0-127），取自 Signals 列表", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["lockin","modulator","signal","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetModPhasRegSpec: SkillSpec = {
  name: "SetModPhasReg",
  description: "把某个 lock-in 调制器指派到一个相位寄存器（1-8）。",
  parameters: [
    { name: "modulator", type: "int", description: "调制器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "phase_register_index", type: "int", description: "相位寄存器索引（1-8）", required: true, minValue: 1, maxValue: 8 },
  ],
  tags: ["lockin","modulator","phase","register","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetModHarmonicSpec: SkillSpec = {
  name: "SetModHarmonic",
  description: "设置某个 lock-in 调制器的谐波次数。",
  parameters: [
    { name: "modulator", type: "int", description: "调制器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "harmonic", type: "int", description: "谐波次数（1 = 基频）", required: true, minValue: 1 },
  ],
  tags: ["lockin","modulator","harmonic","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetDemodSyncFilterSpec: SkillSpec = {
  name: "SetDemodSyncFilter",
  description: "开/关某个 lock-in 解调器的 sync 滤波器。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "sync_filter_on", type: "bool", description: "True 启用 sync 滤波器，False 禁用", required: true },
  ],
  tags: ["lockin","demodulator","sync","filter","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetDemodRTSignalsSpec: SkillSpec = {
  name: "SetDemodRTSignals",
  description: "设置某个 lock-in 解调器的 RT 信号（X/Y 或 R/phi）。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "rt_signals", type: "int", description: "0 = X/Y，1 = R/phi", required: true, minValue: 0, maxValue: 1 },
  ],
  tags: ["lockin","demodulator","rt","signals","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ListLockInPresetsSpec: SkillSpec = {
  name: "ListLockInPresets",
  description: "列出 lock-in 常用参数组:每个值是多少、来自哪个档案键、哪些键用户还没填(没填的**不会下发**)。调制侧相位永远不在组里 —— 本机固件不接受写它。",
  parameters: [],
  tags: ["lockin","preset","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ApplyLockInPresetSpec: SkillSpec = {
  name: "ApplyLockInPreset",
  description: "按**参数组名**设置 lock-in 调制(频率 / 幅度),数值由代码从用户维护的仪器档案里取出,你不需要也不应该自己写任何数字。\n\n组名:`didv`(dI/dV 常用组)。先用 ListLockInPresets 看里面有什么、哪些键还没配。\n\n**不会下发调制侧相位** —— 本机 Modulate 区没有该字段,固件恒拒写(写同样的值也拒)。要调相位请用 AutoPhase 或 ConfigureLockInDemod,它们写的是解调侧 Ref. Phase。",
  parameters: [
    { name: "preset", type: "str", description: "参数组名。目前只有 'didv'。", required: false, default: "didv" },
    { name: "mod_on", type: "bool", description: "下发后是否打开调制。", required: false, default: true },
  ],
  tags: ["lockin","preset","write","readback"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AutoPhaseSpec: SkillSpec = {
  name: "AutoPhase",
  description: "自动对齐 lock-in **解调相位**(GUI 上的 Auto 按钮做的事,但那个按钮没有 TCP 命令,所以这里是读 X/Y → 算角 → 写相位)。\n\n两种模式:\n- `signal_to_x`(默认,**隧穿态**用):把 dI/dV 信号转到 X 轴;\n- `crosstalk_to_y`(**退针态**用):把电容串扰转到 Y 轴,信号轴自然对齐 X —— 不用进针就能定相位轴。\n\n取样窗口内平均后再算角;**X/Y 都在噪声底时拒绝**(无信号不给相位角)。写的是解调侧,**绝不碰调制侧相位**(本机固件恒拒写它)。\n\n⚠️ **跑完会把 lock-in 调制关回 OFF**(幅度/频率保留)—— 它是这条链的终端消费者,而调制留着会污染后面每一条电流判据。**要接着测 dI/dV,请先重新 ApplyLockInPreset 打开调制**:调制关着时 lock-in 通道上没有信号,而曲线照样画得出来。",
  parameters: [
    { name: "mode", type: "str", description: "signal_to_x=把信号归 X(隧穿态);crosstalk_to_y=把串扰归 Y(退针态)。", required: false, allowedValues: ["signal_to_x","crosstalk_to_y"], default: "signal_to_x" },
    { name: "window_s", type: "float", description: "取样窗口秒数 —— 窗口内平均再算角,不用单次快照。", required: false, minValue: 0.2, maxValue: 60, default: 3 },
    { name: "demodulator", type: "int", description: "解调器编号(读/写相位用)。", required: false, minValue: 1, maxValue: 8, default: 1 },
    { name: "x_signal_index", type: "int", description: "承载解调 X 的 RT 信号索引。留空则取仪器档案 lockin_x_signal_index;两处都没有就**拒绝**(不猜索引 —— 猜错读到的是另一路信号,而算出来的角度看上去一样合理)。", required: false, minValue: 0, maxValue: 127 },
    { name: "y_signal_index", type: "int", description: "承载解调 Y 的 RT 信号索引;同上。", required: false, minValue: 0, maxValue: 127 },
  ],
  tags: ["lockin","phase","auto","didv","write","readback"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetDataLogStatusSpec: SkillSpec = {
  name: "GetDataLogStatus",
  description: "读数据记录器的状态（在跑／已停）、它配置的通道，以及它的各项属性。开一次新记录之前先看这个 —— 在一个正在跑的记录之上再开一个，会把前一个丢掉。",
  parameters: [],
  tags: ["datalog","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const StartDataLogSpec: SkillSpec = {
  name: "StartDataLog",
  description: "把一路或多路信号通道录进一个文件，录固定时长、或一直录到被停止。想**盯着**某个量随时间怎么走时用它，而不是去轮询：热漂移的稳定过程、针尖的缓慢退化、一次长退火期间的电流。\n\n通道序号取自信号目录（0=Current，24=Z，…）—— 拿不准就调 ListSignalNames。录制不会碰仪器；它只读。",
  parameters: [
    { name: "channels", type: "str", description: "要录的信号序号，逗号分隔（例如 '0,24'）", required: true },
    { name: "duration_s", type: "float", description: "录制时长，单位秒。不传（或传 0）则一直录到 StopDataLog 为止。", unit: "s", required: false, minValue: 0, maxValue: 86400, default: 0 },
    { name: "basename", type: "str", description: "Nanonis 机器上的文件基名", required: false, default: "mast_log" },
    { name: "averaging", type: "int", description: "每个记录点平均多少个采样", required: false, minValue: 1, maxValue: 100000, default: 1 },
    { name: "comment", type: "str", description: "存进日志文件头的注释", required: false, default: "" },
  ],
  tags: ["datalog","record","monitor"],
  category: "write",
  safetyLevel: "AUTO",
}

export const StopDataLogSpec: SkillSpec = {
  name: "StopDataLog",
  description: "停掉 Nanonis 数据记录器并关闭文件。",
  parameters: [],
  tags: ["datalog","record","stop"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetTcpLogStatusSpec: SkillSpec = {
  name: "GetTcpLogStatus",
  description: "读 TCP 记录器的状态（在流式送出／已停／出错）。",
  parameters: [],
  tags: ["tcplog","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const StartTcpLogSpec: SkillSpec = {
  name: "StartTcpLog",
  description: "启动 TCP 记录器：把选定的通道通过 TCP 流式送出，而不是录到 Nanonis 机器上的文件里。数据应当送到**这边**来的时候用它。只读 —— 不碰任何硬件。",
  parameters: [
    { name: "channels", type: "str", description: "要流式送出的信号序号，逗号分隔", required: true },
    { name: "oversampling", type: "int", description: "每个送出点平均多少个采样", required: false, minValue: 1, maxValue: 100000, default: 10 },
  ],
  tags: ["tcplog","record","stream"],
  category: "write",
  safetyLevel: "AUTO",
}

export const StopTcpLogSpec: SkillSpec = {
  name: "StopTcpLog",
  description: "停掉 Nanonis TCP 记录器的数据流。",
  parameters: [],
  tags: ["tcplog","record","stop"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ListScanMarkersSpec: SkillSpec = {
  name: "ListScanMarkers",
  description: "列出 Nanonis 扫描帧上的点标记与线标记及其坐标。挑下一个位置之前，用它回想一下你已经在哪儿测过了。",
  parameters: [],
  tags: ["marks","annotation","scan","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const DrawScanMarkerSpec: SkillSpec = {
  name: "DrawScanMarker",
  description: "在 Nanonis 扫描帧上画一个**点**或一条**线**标记。用它记录你**在哪里**做过什么 —— 标出每一个 STS 位置、你选中的平坦区域、你发现的一个缺陷、你取剖面所沿的那条线。坐标是扫描器坐标系下的米（和 MoveToXY 及各谱学技能用的是同一套），所以你可以用测量时的精确坐标去标一条谱。\n\n画标记只碰显示 —— 它什么都不移动。",
  parameters: [
    { name: "kind", type: "str", description: "'point' 或 'line'", required: true, allowedValues: ["point","line"] },
    { name: "x_m", type: "float", description: "点的 X，或线的**起点** X（m，扫描器坐标系）", unit: "m", required: true },
    { name: "y_m", type: "float", description: "点的 Y，或线的**起点** Y（m，扫描器坐标系）", unit: "m", required: true },
    { name: "x2_m", type: "float", description: "线的**终点** X（m）。kind='line' 时必填。", unit: "m", required: false },
    { name: "y2_m", type: "float", description: "线的**终点** Y（m）。kind='line' 时必填。", unit: "m", required: false },
    { name: "text", type: "str", description: "显示在标记旁边的标签（仅点标记有）", required: false, default: "" },
    { name: "color", type: "str", description: "red/green/blue/yellow/cyan/magenta/white/black/orange，或 0xRRGGBB", required: false, default: "red" },
  ],
  tags: ["marks","annotation","scan"],
  category: "write",
  safetyLevel: "AUTO",
}

export const EraseScanMarkersSpec: SkillSpec = {
  name: "EraseScanMarkers",
  description: "擦掉一个标记（或者只隐藏、不删除）。index=-1 会擦掉该类型的**全部**标记。擦标记只碰显示。",
  parameters: [
    { name: "kind", type: "str", description: "'point' 或 'line'", required: true, allowedValues: ["point","line"] },
    { name: "index", type: "int", description: "标记序号；-1 = 该类型的全部", required: true, minValue: -1, maxValue: 10000 },
    { name: "hide_only", type: "bool", description: "True = 隐藏但保留；False = 擦掉它", required: false, default: false },
  ],
  tags: ["marks","annotation","scan"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ConfigureAtomTrackSpec: SkillSpec = {
  name: "ConfigureAtomTrack",
  description: "配置 Atom Tracking 参数，并启用/禁用各项控制。",
  parameters: [
    { name: "integral_gain", type: "float", description: "控制器积分增益", required: true },
    { name: "frequency_hz", type: "float", description: "调制频率", unit: "Hz", required: true, minValue: 0 },
    { name: "amplitude_m", type: "float", description: "调制幅度", unit: "m", required: true, minValue: 0 },
    { name: "phase_deg", type: "float", description: "调制相位", unit: "deg", required: false, minValue: -360, maxValue: 360, default: 0 },
    { name: "switch_off_delay_s", type: "float", description: "关闭前的位置平均时间", unit: "s", required: false, minValue: 0, default: 0.5 },
    { name: "enable_modulation", type: "bool", description: "启用调制", required: false, default: true },
    { name: "enable_controller", type: "bool", description: "启用控制器", required: false, default: true },
  ],
  tags: ["atomtrack","tracking","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AtomTrackDriftCompSpec: SkillSpec = {
  name: "AtomTrackDriftComp",
  description: "把 Atom Tracking 测得的漂移应用到漂移补偿上。",
  parameters: [],
  tags: ["atomtrack","drift","compensation","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AtomTrackQuickCompStartSpec: SkillSpec = {
  name: "AtomTrackQuickCompStart",
  description: "通过 Atom Tracking 启动倾斜或漂移补偿。",
  parameters: [
    { name: "compensation_type", type: "int", description: "0=倾斜补偿, 1=漂移补偿", required: true, minValue: 0, maxValue: 1, allowedValues: [0,1] },
  ],
  tags: ["atomtrack","compensation","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AtomTrackStatusGetSpec: SkillSpec = {
  name: "AtomTrackStatusGet",
  description: "读取某一项 Atom Tracking 控制（调制、控制器或漂移）的开/关状态。",
  parameters: [
    { name: "control", type: "int", description: "0=调制, 1=控制器, 2=漂移测量", required: true, minValue: 0, maxValue: 2, allowedValues: [0,1,2] },
  ],
  tags: ["atomtrack","status","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const AcquireOsciTraceSpec: SkillSpec = {
  name: "AcquireOsciTrace",
  description: "从 Nanonis 的 1 通道示波器（Osci1T）取一段缓冲时间序列。按硬件 RT 速率采样（V5e 上 ~20 kHz）。返回 (t0, dt, y_array)。要求 Nanonis 里已加载 Osci1T 模块 —— 默认自带的模拟器上没有。",
  parameters: [
    { name: "data_to_get", type: "int", description: "0 = 当前显示的缓冲区（最快，可能是陈旧的），1 = 等下一个触发，2 = 等 2 个触发（最干净的快照）。", required: false, minValue: 0, maxValue: 2, default: 0 },
    { name: "signal_index", type: "int", description: "可选的 0–15 信号通道索引，采集前赋给 Osci1T。-1 = 保持现有。", required: false, minValue: -1, maxValue: 15, default: -1 },
  ],
  tags: ["oscilloscope","trace","hardware","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetOsciTimebasesSpec: SkillSpec = {
  name: "GetOsciTimebases",
  description: "列出可用的 Oscilloscope-1-Channel（Osci1T）时基。每个时基就是每采样点的间隔 dt（s）；采样率 fs = 1/dt。可选时基集合取决于 RT 频率与 RT 过采样。要求 Nanonis 里已加载 Osci1T 模块。",
  parameters: [],
  tags: ["oscilloscope","timebase","samplerate","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetOsciTimebaseSpec: SkillSpec = {
  name: "SetOsciTimebase",
  description: "按索引设置 Oscilloscope-1-Channel（Osci1T）时基。先用 GetOsciTimebases 拿到 index→sample-rate 的对应关系。纯配置 —— 不移动针尖，也不改任何 setpoint。",
  parameters: [
    { name: "timebase_index", type: "int", description: "在 GetOsciTimebases 返回的时基列表里的索引。索引越小 = 时基越快 / 采样率越高。", required: true, minValue: 0 },
  ],
  tags: ["oscilloscope","timebase","samplerate","configure"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ConfigureSpectrumAnalyzerSpec: SkillSpec = {
  name: "ConfigureSpectrumAnalyzer",
  description: "配置频谱分析仪：FFT 窗、平均、以及 AC 耦合。只读 —— 分析仪只是把信号数字化，它不驱动任何东西。\n\n这三项决定了一条谱值不值得看：\n• **averaging** —— count=1 时每个 bin 都只是一次带噪的单点采样，每一个「峰」都是巧合。相信一个峰之前，先平均 10–50×。\n• **fft_window** —— 矩形窗（0）会把每一个音调抹到相邻的 bin 上。看噪声时该用的默认值是 Hann（通常是 1）。\n• **ac_coupling** —— DC 耦合下，一个大的偏置会主导整条谱，有意思的那几个数量级会被压在它底下。\n\n然后调用 GetSpectrumAnalyzerData。",
  parameters: [
    { name: "instance", type: "int", description: "用哪一个分析仪实例（从 1 开始，Nanonis 编号）", required: false, minValue: 1, maxValue: 8, default: 1 },
    { name: "fft_window", type: "int", description: "FFT 窗索引（0 = 矩形窗；通常该用 Hann）", required: false, minValue: 0, maxValue: 8, default: 1 },
    { name: "averaging_count", type: "int", description: "平均多少条谱（1 = 不平均 —— 每个峰都是噪声）", required: false, minValue: 1, maxValue: 10000, default: 20 },
    { name: "averaging_mode", type: "int", description: "平均模式索引（0 = 不平均，1 = 线性，2 = 指数…）", required: false, minValue: 0, maxValue: 4, default: 1 },
    { name: "weighting_mode", type: "int", description: "加权模式索引", required: false, minValue: 0, maxValue: 4, default: 0 },
    { name: "ac_coupling", type: "bool", description: "对输入做 AC 耦合（剥掉 DC 偏置）", required: false, default: true },
  ],
  tags: ["spectrum","noise","fft","diagnostics"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetSpectrumAnalyzerBandSpec: SkillSpec = {
  name: "SetSpectrumAnalyzerBand",
  description: "设置频谱分析仪上报 band RMS 所用的频段（那一对游标），单位是 HERTZ。\n\nband RMS 是回答「到底有多少噪声」的那一个数 —— 例如电流信号上 1 Hz 到 1 kHz，告诉你反馈环实际要与之共处的噪声。先设频段，再读 GetSpectrumAnalyzerData.band_rms。",
  parameters: [
    { name: "f_low_hz", type: "float", description: "频段下边界，单位 HERTZ", unit: "Hz", required: true, minValue: 0, maxValue: 10000000 },
    { name: "f_high_hz", type: "float", description: "频段上边界，单位 HERTZ", unit: "Hz", required: true, minValue: 0, maxValue: 10000000 },
    { name: "instance", type: "int", description: "用哪一个分析仪实例（从 1 开始）", required: false, minValue: 1, maxValue: 8, default: 1 },
  ],
  tags: ["spectrum","noise","diagnostics"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetSpectrumAnalyzerDataSpec: SkillSpec = {
  name: "GetSpectrumAnalyzerData",
  description: "读频谱分析仪：谱本身、BAND RMS（由 SetSpectrumAnalyzerBand 设定的频段内的噪声 —— 值得拿出来说的就是这一个数）、DC 值，以及当前设置，好让你判断这条谱可不可信。\n\n诊断读法：50 Hz 处的峰及其谐波是市电串入 / 地环路；几百赫兹处宽缓的鼓包是楼体或隔振台；朝 DC 方向抬起是漂移；单纯就是太高的本底是前放、增益或走线。\n\n相信任何一个峰之前，先看 `averaging` —— count=1 时每个 bin 都只是一次带噪的单点采样。",
  parameters: [
    { name: "instance", type: "int", description: "用哪一个分析仪实例（从 1 开始）", required: false, minValue: 1, maxValue: 8, default: 1 },
  ],
  tags: ["spectrum","noise","read","diagnostics"],
  category: "read",
  safetyLevel: "AUTO",
}

export const RunBiasSweepSpec: SkillSpec = {
  name: "RunBiasSweep",
  description: "运行 Nanonis 的 BIAS SWEEPER：把偏压在两个限值之间 ramp，并记录采集通道。它**不是** bias spectroscopy（BiasSpectr / RunSTS）—— sweeper 只管 ramp 和记录，没有 spectroscopy 模块的那套 Z-control 时序。用它做定高的 I–V，或者在 lock-in 盯着时做一次偏压 ramp。\n\n针尖留在原地不动。挑限值时要像用 SetBias 那样谨慎 —— 一次停在 5 V 的 sweep，会把偏压就留在 5 V。",
  parameters: [
    { name: "lower_limit_v", type: "float", description: "sweep 的偏压下限（V）", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "upper_limit_v", type: "float", description: "sweep 的偏压上限（V）", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "steps", type: "int", description: "sweep 的点数", required: false, minValue: 2, maxValue: 65535, default: 256 },
    { name: "period_ms", type: "int", description: "每个点的耗时（ms）", unit: "ms", required: false, minValue: 1, maxValue: 65535, default: 10 },
    { name: "z_controller_off", type: "bool", description: "sweep 期间断开 Z feedback 环路。做定高 I–V 时通常选 True；选 False 则偏压变动时 feedback 会一直追着 setpoint 走。", required: false, default: true },
    { name: "sweep_direction", type: "int", description: "1 = 下限→上限，0 = 上限→下限", required: false, minValue: 0, maxValue: 1, default: 1 },
    { name: "autosave", type: "bool", description: "把这次 sweep 存成文件，落在 Nanonis 那台机器上", required: false, default: true },
  ],
  tags: ["bias","sweep","spectroscopy","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetSignalCalibrationSpec: SkillSpec = {
  name: "GetSignalCalibration",
  description: "读取某路信号的标定（gain + offset）—— 也就是原始值的一个单位对应多少物理量。MAST 一直能列出信号、也能读到它们的值，却说不出这些数字**到底是什么意思**。在解读一条不是你配置的原始通道之前，先用它。",
  parameters: [
    { name: "signal_index", type: "int", description: "信号索引（0..127）—— 见 ListSignalNames", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["signals","calibration","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetAdditionalRealtimeSignalsSpec: SkillSpec = {
  name: "SetAdditionalRealtimeSignals",
  description: "选择 Nanonis 额外计算并输出的那**两路**实时信号（在固定的那几路之外）。它只是配置 —— 改变的是测什么，绝不改变仪器做什么。",
  parameters: [
    { name: "signal_1", type: "int", description: "第一路额外 RT 信号的索引", required: true, minValue: 0, maxValue: 127 },
    { name: "signal_2", type: "int", description: "第二路额外 RT 信号的索引", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["signals","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetAcquisitionPeriodSpec: SkillSpec = {
  name: "SetAcquisitionPeriod",
  description: "设置 Nanonis 的采集周期（控制器的采样间隔）。MAST 以前只能**读**它（GetAcqPeriod），设不了。调小它采样更快、也更吃带宽；它影响控制器做的**每一次**测量，所以要有意识地改。",
  parameters: [
    { name: "period_s", type: "float", description: "采集周期，单位秒", unit: "s", required: true, minValue: 0.000001, maxValue: 1 },
  ],
  tags: ["util","acquisition","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const BiasPulseSpec: SkillSpec = {
  name: "BiasPulse",
  description: "由硬件计时发出单个偏压脉冲。",
  parameters: [
    { name: "width_s", type: "float", description: "脉冲宽度，单位秒", unit: "s", required: true, minValue: 0.000001, maxValue: 10 },
    { name: "bias_v", type: "float", description: "脉冲期间的偏压", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "z_hold", type: "int", description: "Z controller 的保持方式：0=不变，1=保持，2=不保持", required: false, allowedValues: [0,1,2], default: 1 },
    { name: "absolute", type: "bool", description: "True=绝对偏压，False=相对当前值", required: false, default: true },
  ],
  capabilities: ["bias_pulse"],
  tags: ["bias","pulse","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ListNanonisScriptsSpec: SkillSpec = {
  name: "ListNanonisScripts",
  description: "列出**用户**已经审过、允许自主使用的那些 Nanonis 脚本槽位，连同每一个做什么、接受什么 LUT 范围。想跑任何东西之前先调它：没过审的槽位会被拒绝，而这份名单通常很短。\n\nNanonis 脚本跑在实时控制器上。MAST 的各道安全闸门在脚本**内部不**生效 —— 这正是只有过审槽位才允许运行的原因。",
  parameters: [],
  tags: ["script","read","safety"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetScriptDataSpec: SkillSpec = {
  name: "GetScriptData",
  description: "读一个 Nanonis 脚本录进 Acquire Buffer 的数据。脚本以实时速度把若干通道写进 buffer 1 或 2；每一次 'sweep' 是脚本里定义的一趟（sweep 从 0 起算）。返回一个由采集通道构成的 2-D 数组。",
  parameters: [
    { name: "buffer", type: "int", description: "Acquire Buffer 编号：1 或 2", required: true, minValue: 1, maxValue: 2 },
    { name: "sweep", type: "int", description: "sweep 序号（0 起算）", required: false, minValue: 0, maxValue: 100000, default: 0 },
  ],
  tags: ["script","data","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetScriptChannelsSpec: SkillSpec = {
  name: "GetScriptChannels",
  description: "读某个脚本 Acquire Buffer 的通道列表。",
  parameters: [
    { name: "buffer", type: "int", description: "Acquire Buffer 编号：1 或 2", required: true, minValue: 1, maxValue: 2 },
  ],
  tags: ["script","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const RunNanonisScriptSpec: SkillSpec = {
  name: "RunNanonisScript",
  description: "在**实时控制器**上运行一个 Nanonis 脚本。只有用户审过的槽位（config/nanonis_scripts.json）才允许运行 —— 先调 ListNanonisScripts。\n\n**用它之前先读这一段。** 跑起来的脚本是在控制器上执行的，不走 TCP，所以 **MAST 的各层安全在它内部都不生效**：全局的偏压／电流／Z 边界不被强制，运行模式闸门不被咨询，而且 **abort 闸门停不了它**。按 中止 只是让 MAST 不再发命令；它停不了一个已经在控制器上跑起来的脚本。唯一能停它的是 StopNanonisScript。\n\n请先把脚本部署上去（DeployNanonisScript）。如果它带参数，运行之前把参数载入它的 LUT（LoadScriptLUT）。",
  parameters: [
    { name: "slot", type: "int", description: "脚本槽位（1 起算）。必须在过审名单里。", required: true, minValue: 1, maxValue: 64 },
    { name: "wait_until_finished", type: "bool", description: "阻塞直到脚本跑完。对一段有界的序列，通常 True 才对；False 会让它继续跑着 —— 那样一来，停下它就是你的责任。", required: false, default: true },
  ],
  tags: ["script","realtime","write","safety"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StopNanonisScriptSpec: SkillSpec = {
  name: "StopNanonisScript",
  description: "停掉正在实时控制器上跑的脚本。这是**唯一**能停下一个正在跑的脚本的东西 —— abort 闸门停不了它，因为脚本并不在发 TCP 调用。因此它从不受闸门管辖、也从不被拒绝，包括在 abort 已经锁住的时候。",
  parameters: [],
  tags: ["script","stop","safety"],
  category: "write",
  safetyLevel: "AUTO",
}

export const DeployNanonisScriptSpec: SkillSpec = {
  name: "DeployNanonisScript",
  description: "把一个过审的脚本槽位部署到实时控制器上（编译 + 推送）。部署并不会运行它 —— 之后请调 RunNanonisScript。只有过审的槽位才允许被部署。",
  parameters: [
    { name: "slot", type: "int", description: "脚本槽位（1 起算）。必须已过审。", required: true, minValue: 1, maxValue: 64 },
  ],
  tags: ["script","realtime","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const UndeployNanonisScriptSpec: SkillSpec = {
  name: "UndeployNanonisScript",
  description: "把一个脚本槽位从实时控制器上撤下来。撤掉一个脚本从来不是有风险的那个方向，所以它从不受闸门管辖。",
  parameters: [
    { name: "slot", type: "int", description: "脚本槽位（1 起算）", required: true, minValue: 1, maxValue: 64 },
  ],
  tags: ["script","realtime","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const LoadScriptLUTSpec: SkillSpec = {
  name: "LoadScriptLUT",
  description: "把一组数值载入某个脚本的查找表（Look-Up Table）—— 也就是脚本以实时速度逐项走过的那个数组。延时扫描就是这么工作的：把延时值载进去，脚本自己走完它们。\n\nLUT 是你在这里真正能撰写的**那一样**东西（脚本本身是用户的）。所以它的取值范围由过审条目框定：一个声明了 lut_min/lut_max 的槽位，会拒绝范围之外的值。一个 LUT 以毫米为单位的延时线脚本，喂进去以微米计的数字，就会把台子开到硬限位上 —— 而 MAST 看不到脚本，也就无从知道它想要的是哪一种。",
  parameters: [
    { name: "slot", type: "int", description: "这些值是**给哪一个**过审脚本槽位用的", required: true, minValue: 1, maxValue: 64 },
    { name: "lut_index", type: "int", description: "LUT 编号（1 起算）", required: true, minValue: 1, maxValue: 16 },
    { name: "values", type: "str", description: "逗号分隔的数值（例如 '0, 0.5, 1.0, 1.5'）", required: true },
  ],
  tags: ["script","lut","write","safety"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const DeployScriptLUTSpec: SkillSpec = {
  name: "DeployScriptLUT",
  description: "把一个 LUT 部署到实时控制器上，好让正在跑的脚本能逐项走它。请先载入数值（LoadScriptLUT）。",
  parameters: [
    { name: "lut_index", type: "int", description: "LUT 编号（1 起算）", required: true, minValue: 1, maxValue: 16 },
    { name: "wait_until_finished", type: "bool", description: "阻塞直到部署完成", required: false, default: true },
    { name: "timeout_ms", type: "int", description: "部署超时（ms）；-1 = 一直等下去", unit: "ms", required: false, minValue: -1, maxValue: 600000, default: 10000 },
  ],
  tags: ["script","lut","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetScriptChannelsSpec: SkillSpec = {
  name: "SetScriptChannels",
  description: "设定某个脚本的 Acquire Buffer 记录哪些信号通道。仅仅是配置 —— 它改变的是「测什么」，绝不改变仪器做什么。",
  parameters: [
    { name: "buffer", type: "int", description: "Acquire Buffer 编号：1 或 2", required: true, minValue: 1, maxValue: 2 },
    { name: "channels", type: "str", description: "信号序号，逗号分隔（例如 '0,24'）", required: true },
  ],
  tags: ["script","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetScriptAutosaveSpec: SkillSpec = {
  name: "SetScriptAutosave",
  description: "运行结束后把脚本 Acquire Buffer 里的数据自动存盘。任何长序列都建议开 —— 缓冲区是有限的，而没存下来的数据就等于没测过。",
  parameters: [
    { name: "buffer", type: "int", description: "Acquire Buffer 编号：1 或 2", required: true, minValue: 1, maxValue: 2 },
    { name: "sweep", type: "int", description: "要保存的 sweep 编号；-1 = 全部 sweep", required: false, minValue: -1, maxValue: 100000, default: -1 },
    { name: "all_sweeps_same_file", type: "bool", description: "把每一趟 sweep 都放进同一个文件", required: false, default: true },
    { name: "folder_path", type: "str", description: "Nanonis 机器上的文件夹（留空 = 会话目录）", required: false, default: "" },
    { name: "basename", type: "str", description: "文件基名", required: false, default: "mast_script" },
  ],
  tags: ["script","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const LoadNanonisScriptSpec: SkillSpec = {
  name: "LoadNanonisScript",
  description: "把一个 Nanonis 脚本文件载入某个脚本**槽位**。\n\n**它会拒绝载入已在受审白名单上的槽位。** 白名单的含义是「有人读过这个槽位里的脚本并批准了它」。往那个槽位里换一个别的脚本，会把这份批准变成一句假话 —— 而 Nanonis 脚本跑在实时控制器上，MAST 的安全闸门、模式闸门、abort 闸门和 HITL 在那里统统看不见它。\n\n请载入一个**空闲**槽位。agent 载入之后并不能运行它（RunNanonisScript 只允许白名单上的槽位）—— 这正是设计意图。流程是：你在这里载入，由人读过之后把该槽位加进 config/nanonis_scripts.json，只有到那时它才跑得起来。\n\n这里的文件路径是 **NANONIS 机器上的**，不是 MAST 这边的。",
  parameters: [
    { name: "slot", type: "int", description: "脚本槽位（**不能**是已经在白名单上的那些）", required: true, minValue: 1, maxValue: 15 },
    { name: "file_path", type: "str", description: "**NANONIS 机器上** .ns 脚本文件的路径", required: true },
    { name: "load_session", type: "bool", description: "同时载入该脚本存下来的 session", required: false, default: false },
  ],
  tags: ["script","file","advanced","dangerous"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const SaveNanonisScriptSpec: SkillSpec = {
  name: "SaveNanonisScript",
  description: "把某个槽位里当前的脚本导出成 **NANONIS 机器上**的一个文件。\n\n这件事读的是槽位、**写的是一个文件**。它改变不了仪器的行为 —— 但它会覆盖你给的那个路径上已有的文件，而 MAST 看不到那里原本是什么。请挑一个新路径。\n\n适合把一个受审槽位里实际装着什么，连同实验记录一起归档下来。",
  parameters: [
    { name: "slot", type: "int", description: "要读的脚本槽位", required: true, minValue: 1, maxValue: 15 },
    { name: "file_path", type: "str", description: "**NANONIS 机器上**的目标路径（已存在则会被覆盖）", required: true },
    { name: "save_session", type: "bool", description: "同时保存该脚本的 session", required: false, default: false },
  ],
  tags: ["script","file","advanced"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SaveNanonisScriptLutSpec: SkillSpec = {
  name: "SaveNanonisScriptLut",
  description: "把某个脚本槽位的**查找表**（LUT）导出成 Nanonis 机器上的一个文件。\n\nLUT 是脚本接收参数的途径 —— 它是一个受审脚本里 agent 唯一能改的东西（且只能在白名单声明的范围内改）。把它导出来是一次读取；它不改变仪器上的任何东西。它会覆盖给定路径上已有的文件。",
  parameters: [
    { name: "slot", type: "int", description: "要保存其 LUT 的脚本槽位", required: true, minValue: 1, maxValue: 15 },
    { name: "file_path", type: "str", description: "**NANONIS 机器上**的目标路径", required: true },
  ],
  tags: ["script","lut","file","advanced"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetZLimitsSpec: SkillSpec = {
  name: "SetZLimits",
  description: "设定 Z 控制器的位置上限与下限，单位**米**。\n\n这两个界限规定了 Z 压电伸出与回缩都不得越过的边界 —— 是压电与针尖之间最后一道软件屏障。把它们放宽是合法的（更高的样品、更长的针尖确实需要更多行程），并且会连同改动前后的取值一起**记入**诊断账本。\n\n**限值不处于启用状态时，它们什么也不做**（Nanonis 原文：'When the Z position limits are not enabled, this function has no effect'）。请用 enable=true，或去核对 GetZControllerState.z_limits_enabled。\n\n取值单位是**米**：500 nm 的限值要写成 500n，不是 500。",
  parameters: [
    { name: "z_high_limit_m", type: "float", description: "Z 的上界，单位**米**（500 nm = 500n）", unit: "m", required: true, minValue: -0.0001, maxValue: 0.0001 },
    { name: "z_low_limit_m", type: "float", description: "Z 的下界，单位**米**", unit: "m", required: true, minValue: -0.0001, maxValue: 0.0001 },
    { name: "enable", type: "bool", description: "同时**启用**这两个限值（不启用它们就没有任何作用）", required: false, default: true },
  ],
  tags: ["z","limits","safety","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetWithdrawRateSpec: SkillSpec = {
  name: "SetWithdrawRate",
  description: "设定 Z 的退针速率，单位米每秒 —— 也就是 Withdraw（或紧急退针、或 SafeTip）触发时针尖回缩得有多快。\n\n这在两个方向上都是一个安全参数。太**慢**，紧急退针来不及把针尖撤离；太**快**，退针本身就可能把针尖抖松、或者把扫描器激起振铃。Nanonis 的默认值是个合理的起点；要改就得有理由。",
  parameters: [
    { name: "rate_m_per_s", type: "float", description: "退针速率，单位 m/s", unit: "m/s", required: true, minValue: 1e-9, maxValue: 0.01 },
  ],
  tags: ["z","withdraw","safety","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const HomeZControllerSpec: SkillSpec = {
  name: "HomeZController",
  description: "把 Z 移到它配置好的 **HOME** 位置。\n\nHome 是用户设定的一个安全／中性的停放点 —— 调用它之前先用 GetZControllerState.home 读一下，因为这个位置不是 MAST 选的，而一个为另一块样品配的 home 就只是个普通的 Z 位置而已。\n\n这会**移动**压电。若你想让针尖确定无疑地离开表面，请用 Withdraw，不要用 Home —— 退针去的是安全的极端位置，而 home 去的是 home 碰巧在的地方。",
  parameters: [],
  tags: ["z","home","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPiezoLimitsSpec: SkillSpec = {
  name: "SetPiezoLimits",
  description: "设定压电的 X/Y/Z **电压**限值（并启用它们）。\n\n这些限值以伏特为单位框住扫描器能被驱动到多远，是在量程标定把它们换算成米之前起作用的。它们保护的既是针尖，也同样是压电本身（过压会让它**永久**退极化）。\n\n把它们放宽会连同改动前后的取值一起记入诊断账本。当前值用 GetPiezoConfig 读 —— 并注意这些是**伏特**，不是米；把两者连起来的是量程标定。",
  parameters: [
    { name: "x_low_v", type: "float", description: "X 下限（V）", unit: "V", required: true, minValue: -300, maxValue: 300 },
    { name: "x_high_v", type: "float", description: "X 上限（V）", unit: "V", required: true, minValue: -300, maxValue: 300 },
    { name: "y_low_v", type: "float", description: "Y 下限（V）", unit: "V", required: true, minValue: -300, maxValue: 300 },
    { name: "y_high_v", type: "float", description: "Y 上限（V）", unit: "V", required: true, minValue: -300, maxValue: 300 },
    { name: "z_low_v", type: "float", description: "Z 下限（V）", unit: "V", required: true, minValue: -300, maxValue: 300 },
    { name: "z_high_v", type: "float", description: "Z 上限（V）", unit: "V", required: true, minValue: -300, maxValue: 300 },
    { name: "enable", type: "bool", description: "启用这些限值（不启用它们就没有任何作用）", required: false, default: true },
  ],
  tags: ["piezo","limits","safety","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSafeTipPropsSpec: SkillSpec = {
  name: "SetSafeTipProps",
  description: "配置 SafeTip —— 那套自动的针尖保护系统：它盯着一路信号，一旦越过阈值就退针。\n\nMAST 从前只能**读**这份配置而设不了它，这意味着 agent 明明看得出阈值对当前这根针尖是错的，却拿它没办法。\n\n**threshold 是要紧的那个数。** 定高了，SafeTip 永远不触发 —— 这份保护成了摆设。定低了，它会在噪声上触发，把好好的扫描中止掉。先用 GetSafeTipProps / GetSafeTipSignal 读一下当前值和被盯着的那路信号。\n\nauto_recovery 会在一次 SafeTip 事件之后恢复 Z 控制器，**前提是它原本就是开着的**；auto_pause_scan 则把扫描暂停下来，而不是让它在一个针尖刚被拉离的表面上继续磨下去。",
  parameters: [
    { name: "threshold", type: "float", description: "触发阈值，用被盯着那路信号自己的单位", required: true },
    { name: "auto_recovery", type: "bool", description: "SafeTip 事件之后恢复 Z 控制器（前提是它原本开着）", required: false, default: true },
    { name: "auto_pause_scan", type: "bool", description: "发生 SafeTip 事件时暂停扫描", required: false, default: true },
  ],
  tags: ["safetip","safety","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetActiveZControllerSpec: SkillSpec = {
  name: "SetActiveZController",
  description: "选定哪一个 Z 控制器处于**激活**状态。只有在装了不止一个的机器上才有意义 —— 先调 GetZControllerState / ListZControllers。\n\n切换激活的控制器，会改变其余每一个 Z 技能所对话的是哪一个环。弄错了，就意味着你在给一个并没有托着针尖的环设设定值。",
  parameters: [
    { name: "controller_index", type: "int", description: "Z 控制器序号（取自控制器列表）", required: true, minValue: 0, maxValue: 15 },
  ],
  tags: ["z","controller","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigurePLLSpec: SkillSpec = {
  name: "ConfigurePLL",
  description: "配置 PLL 的中心频率、频移与控制器增益。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "center_freq_hz", type: "float", description: "中心频率，单位 Hz", unit: "Hz", required: false },
    { name: "freq_shift_hz", type: "float", description: "频移，单位 Hz", unit: "Hz", required: false },
    { name: "amp_p_gain", type: "float", description: "幅度控制器的 P 增益（V/m）", required: false },
    { name: "amp_time_constant_s", type: "float", description: "幅度控制器的时间常数", unit: "s", required: false },
    { name: "phas_p_gain", type: "float", description: "相位控制器的 P 增益（Hz/deg）", required: false },
    { name: "phas_time_constant_s", type: "float", description: "相位控制器的时间常数", unit: "s", required: false },
  ],
  tags: ["pll","configure","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLStatusSpec: SkillSpec = {
  name: "GetPLLStatus",
  description: "读 PLL 当前状态：频率、增益、excitation。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","status","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const PLLOnOffSpec: SkillSpec = {
  name: "PLLOnOff",
  description: "开或关 PLL 输出、相位控制器与幅度控制器。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "output_on", type: "bool", description: "启用 PLL 输出", required: true },
    { name: "phase_ctrl_on", type: "bool", description: "启用相位控制器", required: false, default: true },
    { name: "amp_ctrl_on", type: "bool", description: "启用幅度控制器", required: false, default: true },
  ],
  tags: ["pll","onoff","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigurePLLExcitationSpec: SkillSpec = {
  name: "ConfigurePLLExcitation",
  description: "设置 PLL 的 excitation 幅度与输出量程。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "excitation_v", type: "float", description: "excitation 幅度，单位伏特", unit: "V", required: true, minValue: 0 },
    { name: "output_range", type: "float", description: "excitation 输出量程", required: false },
  ],
  tags: ["pll","excitation","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AcquirePLLFreqSweepSpec: SkillSpec = {
  name: "AcquirePLLFreqSweep",
  description: "跑一次 PLL 扫频，找出共振峰。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "num_points", type: "int", description: "频率点数", required: true, minValue: 2, maxValue: 10000 },
    { name: "period_s", type: "float", description: "每个频率点上的测量时间", unit: "s", required: true, minValue: 0.001 },
    { name: "settling_time_s", type: "float", description: "设定起始频率之后的等待时间", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "sweep_up", type: "bool", description: "从下限扫到上限", required: false, default: true },
  ],
  tags: ["pll","sweep","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const PLLSignalAnalyzerSpec: SkillSpec = {
  name: "PLLSignalAnalyzer",
  description: "打开 PLL 信号分析仪，并采集示波器/FFT 数据。",
  parameters: [
    { name: "channel_index", type: "int", description: "要分析的信号通道索引", required: true, minValue: 0 },
    { name: "get_fft", type: "bool", description: "同时采集 FFT 数据", required: false, default: false },
  ],
  tags: ["pll","analyzer","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPLLAddOnOffSpec: SkillSpec = {
  name: "GetPLLAddOnOff",
  description: "返回 Add external signal to output 是开还是关。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","add","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLAmpCtrlBandwidthSpec: SkillSpec = {
  name: "SetPLLAmpCtrlBandwidth",
  description: "设置幅度控制器的带宽。使用当前的 Q factor 与幅度对 excitation 之比（取自之前的一次扫频）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "bandwidth_hz", type: "float", description: "带宽，单位 Hz", unit: "Hz", required: true, minValue: 0 },
  ],
  tags: ["pll","amplitude","bandwidth","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLAmpCtrlOnOffSpec: SkillSpec = {
  name: "GetPLLAmpCtrlOnOff",
  description: "返回幅度控制器是开还是关。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","amplitude","onoff","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLAmpCtrlSetpntSpec: SkillSpec = {
  name: "SetPLLAmpCtrlSetpnt",
  description: "设置幅度控制器的 setpoint，单位米。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "setpoint_m", type: "float", description: "幅度 setpoint，单位米", unit: "m", required: true },
  ],
  tags: ["pll","amplitude","setpoint","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLDemodFilterSpec: SkillSpec = {
  name: "GetPLLDemodFilter",
  description: "返回 PLL lock-in 之后那个低通滤波器的阶数。",
  parameters: [
    { name: "demodulator_index", type: "int", description: "解调器索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","demod","filter","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLDemodFilterSpec: SkillSpec = {
  name: "SetPLLDemodFilter",
  description: "设置 PLL lock-in 之后那个低通滤波器的阶数。",
  parameters: [
    { name: "demodulator_index", type: "int", description: "解调器索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "filter_order", type: "int", description: "滤波器阶数（unsigned int16）", required: true, minValue: 0 },
  ],
  tags: ["pll","demod","filter","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLDemodHarmonicSpec: SkillSpec = {
  name: "GetPLLDemodHarmonic",
  description: "返回 PLL lock-in 解调器中选中的谐波。",
  parameters: [
    { name: "demodulator_index", type: "int", description: "解调器索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","demod","harmonic","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPLLDemodInputSpec: SkillSpec = {
  name: "GetPLLDemodInput",
  description: "返回选中解调器的输入与频率发生器。",
  parameters: [
    { name: "demodulator_index", type: "int", description: "解调器索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","demod","input","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLDemodInputSpec: SkillSpec = {
  name: "SetPLLDemodInput",
  description: "设置选中解调器的输入与频率发生器。",
  parameters: [
    { name: "demodulator_index", type: "int", description: "解调器索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "input", type: "int", description: "输入索引（0 = 不改）", required: true },
    { name: "frequency_generator", type: "int", description: "频率发生器索引（0 = 不改）", required: true },
  ],
  tags: ["pll","demod","input","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPLLDemodPhasRefSpec: SkillSpec = {
  name: "SetPLLDemodPhasRef",
  description: "设置选中解调器的参考相位。",
  parameters: [
    { name: "demodulator_index", type: "int", description: "解调器索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "phase_reference_deg", type: "float", description: "参考相位，单位度", unit: "deg", required: true },
  ],
  tags: ["pll","demod","phase","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLExcRangeSpec: SkillSpec = {
  name: "GetPLLExcRange",
  description: "返回 excitation 输出量程的索引（0=10V, 1=1V, 2=0.1V, 3=0.01V, 4=0.001V）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","excitation","range","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLFreqExcOverwriteSpec: SkillSpec = {
  name: "SetPLLFreqExcOverwrite",
  description: "设置用于覆写 Frequency Shift 和/或 Excitation 的信号。仅在对应控制器未激活时有效。不改则填 -2。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "excitation_overwrite_index", type: "int", description: "excitation 覆写信号的索引（-2 = 不改）", required: true },
    { name: "frequency_overwrite_index", type: "int", description: "频率覆写信号的索引（-2 = 不改）", required: true },
  ],
  tags: ["pll","overwrite","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLFreqRangeSpec: SkillSpec = {
  name: "GetPLLFreqRange",
  description: "返回振荡控制模块的频率量程。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","frequency","range","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLFreqRangeSpec: SkillSpec = {
  name: "SetPLLFreqRange",
  description: "设置振荡控制模块的频率量程。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "frequency_range_hz", type: "float", description: "频率量程，单位 Hz", unit: "Hz", required: true, minValue: 0 },
  ],
  tags: ["pll","frequency","range","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const PLLFreqShiftAutoCenterSpec: SkillSpec = {
  name: "PLLFreqShiftAutoCenter",
  description: "频移自动归中：把当前频移加到中心频率上，并把频移复位为零。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","frequency","autocenter","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLInpCalibrSpec: SkillSpec = {
  name: "GetPLLInpCalibr",
  description: "返回振荡控制模块的输入标定（m/V）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","input","calibration","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLInpCalibrSpec: SkillSpec = {
  name: "SetPLLInpCalibr",
  description: "设置振荡控制模块的输入标定（m/V）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "calibration_m_per_v", type: "float", description: "输入标定，单位 m/V", unit: "m/V", required: true },
  ],
  tags: ["pll","input","calibration","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLInpPropsSpec: SkillSpec = {
  name: "GetPLLInpProps",
  description: "返回 PLL 的输入属性（差分输入、1/10 分压器）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","input","properties","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetPLLInpPropsSpec: SkillSpec = {
  name: "SetPLLInpProps",
  description: "设置 PLL 的输入属性（差分输入、1/10 分压器）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "differential_input", type: "bool", description: "启用差分输入", required: true },
    { name: "divider_1_10", type: "bool", description: "启用 1/10 分压器", required: true },
  ],
  tags: ["pll","input","properties","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPLLInpRangeSpec: SkillSpec = {
  name: "SetPLLInpRange",
  description: "设置振荡控制模块的输入量程（m）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "input_range_m", type: "float", description: "输入量程，单位米", unit: "m", required: true, minValue: 0 },
  ],
  tags: ["pll","input","range","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const PLLPerfectPLLUpdtZTCSpec: SkillSpec = {
  name: "PLLPerfectPLLUpdtZTC",
  description: "用 PerfectPLL 算法更新 Z 控制器的时间常数。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","perfectpll","ztc","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPLLPhasCtrlBandwidthSpec: SkillSpec = {
  name: "SetPLLPhasCtrlBandwidth",
  description: "设置相位控制器的带宽。使用当前的 Q factor（取自之前的一次扫频）。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
    { name: "bandwidth_hz", type: "float", description: "带宽，单位 Hz", unit: "Hz", required: true, minValue: 0 },
  ],
  tags: ["pll","phase","bandwidth","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLPhasCtrlOnOffSpec: SkillSpec = {
  name: "GetPLLPhasCtrlOnOff",
  description: "返回相位控制器是开还是关。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","phase","onoff","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPLLSignalAnlzrChSpec: SkillSpec = {
  name: "GetPLLSignalAnlzrCh",
  description: "返回 PLL Signal Analyzer 当前的通道索引。",
  parameters: [],
  tags: ["pll","analyzer","channel","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPLLSignalAnlzrFFTPropsSpec: SkillSpec = {
  name: "GetPLLSignalAnlzrFFTProps",
  description: "返回 FFT 配置：窗函数、平均模式、加权模式与次数。",
  parameters: [],
  tags: ["pll","analyzer","fft","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPLLSignalAnlzrTimebaseSpec: SkillSpec = {
  name: "GetPLLSignalAnlzrTimebase",
  description: "返回 PLL Signal Analyzer 的时基索引与刷新率。",
  parameters: [],
  tags: ["pll","analyzer","timebase","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const PLLSignalAnlzrTrigAutoSpec: SkillSpec = {
  name: "PLLSignalAnlzrTrigAuto",
  description: "把 PLL Signal Analyzer 的触发参数设为预定义值。",
  parameters: [],
  tags: ["pll","analyzer","trigger","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPLLSignalAnlzrTrigSpec: SkillSpec = {
  name: "SetPLLSignalAnlzrTrig",
  description: "设置 PLL Signal Analyzer 中的触发配置。",
  parameters: [
    { name: "trigger_mode", type: "int", description: "触发模式（0=不改，1=Immediate，2=Level）", required: true, minValue: 0, maxValue: 2 },
    { name: "trigger_source", type: "int", description: "触发源的信号索引", required: true },
    { name: "trigger_slope", type: "int", description: "触发沿（0=不改，1=Rising，2=Falling）", required: true, minValue: 0, maxValue: 2 },
    { name: "trigger_level", type: "float", description: "触发电平", required: true },
    { name: "trigger_position_s", type: "float", description: "触发位置，单位秒", unit: "s", required: true },
    { name: "arming_mode", type: "int", description: "布防模式（0=不改，1=Manual，2=Automatic）", required: true, minValue: 0, maxValue: 2 },
  ],
  tags: ["pll","analyzer","trigger","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPLLFreqSwpParamsSpec: SkillSpec = {
  name: "GetPLLFreqSwpParams",
  description: "返回扫频参数：点数、周期、建立时间。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","sweep","params","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const StopPLLFreqSwpSpec: SkillSpec = {
  name: "StopPLLFreqSwp",
  description: "停止 PLL Frequency Sweep 模块中正在进行的扫描。",
  parameters: [
    { name: "modulator_index", type: "int", description: "调制器/PLL 索引（从 1 开始）", required: false, minValue: 1, default: 1 },
  ],
  tags: ["pll","sweep","stop","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigurePiControllerSpec: SkillSpec = {
  name: "ConfigurePiController",
  description: "配置一个通用 PI 控制器（V5e）：它**监视**哪个信号（输入）、**驱动**哪个信号（控制信号）、设定值、增益，以及输出限值。\n\n输出限值是这里最要紧的参数。这个环会毫无边界地驱动它的控制信号，直到输入达到设定值为止 —— 如果设定值根本到不了（传感器坏了、符号弄反了），它就会一路驱动到限值并停在那儿。把限值设成输出可以安全占据的范围，不要设成硬件最大值。\n\nslope 会把环的作用方向反过来。slope 弄错的环不会振荡 —— 它会朝**背离**设定值的方向一路跑到限值。\n\n配置并不会闭合这个环；闭合是 SetPiControllerOnOff 的事。",
  parameters: [
    { name: "controller_index", type: "int", description: "第几个 PI 控制器（0 起算）", required: true, minValue: 0, maxValue: 15 },
    { name: "input_index", type: "int", description: "环所**监视**的信号", required: true, minValue: 0, maxValue: 127 },
    { name: "control_signal_index", type: "int", description: "环所**驱动**的信号", required: true, minValue: 0, maxValue: 127 },
    { name: "setpoint", type: "float", description: "输入信号的目标值", required: true },
    { name: "output_lower_limit", type: "float", description: "环可以把输出驱动到的最低值", required: true },
    { name: "output_upper_limit", type: "float", description: "环可以把输出驱动到的最高值", required: true },
    { name: "p_gain", type: "float", description: "比例增益", required: false, minValue: 0, default: 1 },
    { name: "i_gain", type: "float", description: "积分增益", required: false, minValue: 0, default: 0 },
    { name: "slope", type: "int", description: "0 = 负，1 = 正。slope **弄错**会让输出一路跑到限值。", required: false, minValue: 0, maxValue: 1, default: 0 },
  ],
  tags: ["pi_controller","feedback","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPiControllerOnOffSpec: SkillSpec = {
  name: "SetPiControllerOnOff",
  description: "闭合或断开一个通用 PI 控制环（V5e）。\n\n闭合时是 DANGEROUS。从那一刻起，这个环就会自主地**驱动它的输出** —— 而这个输出可能是一块压电、是偏压、是加热器、是激光。模块本身并不知道是哪一个。先调 GetPiController 读一下这个环实际接的是什么、它的输出限值是多少。\n\n断开这个环是安全的，输出会停在环最后放它的地方 —— 它并不会被送回任何静止值。",
  parameters: [
    { name: "controller_index", type: "int", description: "第几个 PI 控制器（0 起算）", required: true, minValue: 0, maxValue: 15 },
    { name: "on", type: "bool", description: "True = 闭合此环（它随即开始驱动）", required: true },
  ],
  tags: ["pi_controller","feedback","dangerous","optional-hardware"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const GetPiControllerSpec: SkillSpec = {
  name: "GetPiController",
  description: "读一个通用 PI 控制器（V5e）：它是否闭合、监视哪个信号、**驱动哪个信号**、它的设定值、增益与输出限值。\n\n闭合任何一个不是你自己配的环之前，先读这个。控制信号才是要紧的那一项 —— 那是环将要去移动的东西。",
  parameters: [
    { name: "controller_index", type: "int", description: "第几个 PI 控制器（0 起算）", required: true, minValue: 0, maxValue: 15 },
  ],
  tags: ["pi_controller","feedback","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetGenericPiOutputSpec: SkillSpec = {
  name: "SetGenericPiOutput",
  description: "直接设定 V5 通用 PI 控制器的模拟输出，用它**自己的物理单位**（不是伏特 —— 模块会套用它自己的标定）。\n\n当心：这是直接写到一个 MAST 看不见其接线的物理输出上。先读 GetGenericPiController —— 它会报出这个输出的名称、单位与限值，那是你弄清自己将要驱动什么的唯一途径。\n\n直接写输出只有在环**断开**时才讲得通。环闭合时，控制器会在下一拍就把你设的值覆盖掉。\n\n这是 V5 模块。V5e 机箱上请改用 ConfigurePiController；这里报错就说明你手上是另一代。",
  parameters: [
    { name: "value", type: "float", description: "输出值，用该输出**自己的**物理单位（见 GetGenericPiController）", required: true },
  ],
  tags: ["pi_controller","output","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetGenericPiControllerSpec: SkillSpec = {
  name: "GetGenericPiController",
  description: "读 V5 通用 PI 控制器：环的状态、设定值与增益、模拟输出的当前值，以及 —— 写任何东西之前你都需要的那一项 —— 输出的**名称、单位与限值**。",
  parameters: [],
  tags: ["pi_controller","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigurePreampSpec: SkillSpec = {
  name: "ConfigurePreamp",
  description: "设定 MCVA5 前置放大器某个通道的增益、耦合方式（AC/DC）与输入模式。\n\n改前放增益，会改变同一个物理电流**读出来是多少**。Z 控制器闭合时，反馈环会把这看成电流突变，并据此**移动针尖**。改增益之前先退针，或者先断开 Z 环。\n\n前放编号与通道编号沿用 MCVA5 自己的编号方式。",
  parameters: [
    { name: "preamp", type: "int", description: "前放编号（MCVA5 编号方式）", required: true, minValue: 0, maxValue: 7 },
    { name: "channel", type: "int", description: "该前放上的通道号", required: true, minValue: 0, maxValue: 7 },
    { name: "gain", type: "int", description: "增益档位序号 —— 不传则保持不变", required: false, minValue: 0, maxValue: 31 },
    { name: "coupling", type: "int", description: "耦合方式序号（AC/DC）—— 不传则保持不变", required: false, minValue: 0, maxValue: 7 },
    { name: "input_mode", type: "int", description: "输入模式序号 —— 不传则保持不变", required: false, minValue: 0, maxValue: 7 },
  ],
  tags: ["preamp","mcva5","gain","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPreampSpec: SkillSpec = {
  name: "GetPreamp",
  description: "读 MCVA5 前置放大器某个通道：它的增益、耦合方式与输入模式。解读任何电流之前先读增益 —— 没有它，ADC 报出来的数字什么也不是。",
  parameters: [
    { name: "preamp", type: "int", description: "前放编号", required: true, minValue: 0, maxValue: 7 },
    { name: "channel", type: "int", description: "通道号", required: true, minValue: 0, maxValue: 7 },
  ],
  tags: ["preamp","mcva5","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const RunPllZoomFftSpec: SkillSpec = {
  name: "RunPllZoomFft",
  description: "打开 PLL Zoom-FFT 并在某个通道上启动它，带窗函数与平均。只读 —— FFT 不驱动任何东西。\n\n用它来看噪声本底和共振附近的杂散峰：zoom FFT 能分辨出普通频谱糊掉的那些结构。restart_averaging=true 会把旧的平均丢掉，改动过针尖或驱动之后你正需要这么做。",
  parameters: [
    { name: "channel_index", type: "int", description: "要分析的 PLL 通道", required: true, minValue: 0, maxValue: 127 },
    { name: "fft_window", type: "int", description: "FFT 窗类型序号（0 = 矩形窗；通常该用 Hann）", required: false, minValue: 0, maxValue: 8, default: 1 },
    { name: "averaging_mode", type: "int", description: "平均模式序号", required: false, minValue: 0, maxValue: 4, default: 0 },
    { name: "weighting_mode", type: "int", description: "加权模式序号", required: false, minValue: 0, maxValue: 4, default: 0 },
    { name: "count", type: "int", description: "平均次数", required: false, minValue: 1, maxValue: 10000, default: 10 },
    { name: "restart_averaging", type: "bool", description: "丢弃已有的平均", required: false, default: true },
  ],
  tags: ["pll","fft","read","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetPllZoomFftDataSpec: SkillSpec = {
  name: "GetPllZoomFftData",
  description: "读 PLL Zoom-FFT 的频谱及其当前设置。",
  parameters: [],
  tags: ["pll","fft","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const RunPllPhaseSweepSpec: SkillSpec = {
  name: "RunPllPhaseSweep",
  description: "在一个调制器上扫 PLL 的相位，并（可选地）返回得到的曲线。\n\n这是你找出 PLL 实际锁在哪个相位上的办法。扫描期间它**驱动激励** —— 一根悬臂或音叉会在整段扫描里被摇动 —— 但它不移动针尖。StopPllPhaseSweep 能中止它，按 中止 也能。",
  parameters: [
    { name: "modulator_index", type: "int", description: "第几个 PLL 调制器（0 起算）", required: false, minValue: 0, maxValue: 7, default: 0 },
    { name: "get_data", type: "bool", description: "是否返回扫描曲线", required: false, default: true },
  ],
  tags: ["pll","phase","sweep","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StopPllPhaseSweepSpec: SkillSpec = {
  name: "StopPllPhaseSweep",
  description: "停止一次正在跑的 PLL 相位扫描。永远允许，包括在 abort 之后。",
  parameters: [
    { name: "modulator_index", type: "int", description: "第几个 PLL 调制器（0 起算）", required: false, minValue: 0, maxValue: 7, default: 0 },
  ],
  tags: ["pll","phase","stop","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ConfigurePllSignalAnalyzerSpec: SkillSpec = {
  name: "ConfigurePllSignalAnalyzer",
  description: "配置 PLL 信号分析仪：用哪个通道、时基，以及 FFT 窗／平均。它就是架在 PLL 自身信号上的一台示波器 + FFT —— 只读，不驱动任何东西。\n\n用 GetPllSignalAnalyzerData 把时域波形和频谱一起取回来。",
  parameters: [
    { name: "channel_index", type: "int", description: "要分析的 PLL 通道", required: true, minValue: 0, maxValue: 127 },
    { name: "timebase", type: "float", description: "时基 —— 不传则保持不变", required: false },
    { name: "update_rate", type: "int", description: "刷新率 —— 不传则保持不变", required: false, minValue: 1 },
    { name: "fft_window", type: "int", description: "FFT 窗类型序号", required: false, minValue: 0, maxValue: 8, default: 1 },
    { name: "averaging_mode", type: "int", description: "平均模式序号", required: false, minValue: 0, maxValue: 4, default: 0 },
    { name: "weighting_mode", type: "int", description: "加权模式序号", required: false, minValue: 0, maxValue: 4, default: 0 },
    { name: "count", type: "int", description: "平均次数", required: false, minValue: 1, maxValue: 10000, default: 10 },
  ],
  tags: ["pll","analyzer","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetPllSignalAnalyzerDataSpec: SkillSpec = {
  name: "GetPllSignalAnalyzerData",
  description: "读 PLL 信号分析仪：示波器时域波形**和** FFT 频谱，外加触发状态。\n\nrearm=true 会在读之前重新武装触发 —— 触发不是自由运行时就该这么做，否则你拿回来的是上一次的捕获。",
  parameters: [
    { name: "rearm", type: "bool", description: "先重新武装触发", required: false, default: false },
  ],
  tags: ["pll","analyzer","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureOcSyncSpec: SkillSpec = {
  name: "ConfigureOcSync",
  description: "设定 OC Sync 模块的开／关相位角，单位是**度**。它们把振荡控制的输出闸门化，使其只在振荡的某个相位窗内触发 —— 这是在振荡探针上做相位分辨（pump-probe 式）测量的基础。\n\nlink_channels 会把通道 2 的角度绑到通道 1 上。",
  parameters: [
    { name: "ch1_on_deg", type: "float", description: "通道 1 的 ON 相位角", unit: "deg", required: true, minValue: -360, maxValue: 360 },
    { name: "ch1_off_deg", type: "float", description: "通道 1 的 OFF 相位角", unit: "deg", required: true, minValue: -360, maxValue: 360 },
    { name: "ch2_on_deg", type: "float", description: "通道 2 的 ON 相位角", unit: "deg", required: true, minValue: -360, maxValue: 360 },
    { name: "ch2_off_deg", type: "float", description: "通道 2 的 OFF 相位角", unit: "deg", required: true, minValue: -360, maxValue: 360 },
    { name: "link_channels", type: "bool", description: "把通道 2 的角度绑到通道 1 上", required: false, default: false },
  ],
  tags: ["oc_sync","phase","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetOcSyncSpec: SkillSpec = {
  name: "GetOcSync",
  description: "读 OC Sync 模块的相位角与通道绑定关系。",
  parameters: [],
  tags: ["oc_sync","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureTipRecorderSpec: SkillSpec = {
  name: "ConfigureTipRecorder",
  description: "设定针尖移动记录器的缓冲区大小，并可选地清空它。\n\n这个记录器把每一次针尖移动都记进一个环形缓冲区 —— 它是你重建针尖**去过哪里**的依据，而那正是一次无人值守运行出岔子之后你想要的东西。清空会把这段历史丢掉，所以要清就在一次运行**开始时**清，而不是在诊断它的时候清。",
  parameters: [
    { name: "buffer_size", type: "int", description: "保留多少次针尖移动", required: true, minValue: 1, maxValue: 1000000 },
    { name: "clear", type: "bool", description: "清空缓冲区（会把移动历史丢掉）", required: false, default: false },
  ],
  tags: ["tip_recorder","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetTipRecorderDataSpec: SkillSpec = {
  name: "GetTipRecorderData",
  description: "从针尖记录器的缓冲区里读出记录下来的针尖移动历史。用它重建针尖去了哪里 —— 一次无人值守运行停在意料之外的地方时，这是第一个该看的东西。",
  parameters: [],
  tags: ["tip_recorder","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureKelvinControllerSpec: SkillSpec = {
  name: "ConfigureKelvinController",
  description: "配置 Kelvin(KPFM)控制器：它伺服的解调信号、P 增益与时间常数、设定值、AC 调制，以及**偏压限值**。\n\n偏压限值是这里最要紧的参数。Kelvin 环靠驱动 DC 偏压把静电力归零 —— 环没调好或信号有噪声时它会一直驱动下去，而限值就是唯一能阻止它在针尖处于隧穿距离时把偏压推到轨上的东西。把限值设成你真正预期 CPD 会落在的范围（通常一两伏），不要设成硬件最大值。\n\n配置**不会**打开这个环 —— 打开是 SetKelvinControllerOnOff 的事。",
  parameters: [
    { name: "bias_high_limit_v", type: "float", description: "Kelvin 环可以把偏压驱动到的上界", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "bias_low_limit_v", type: "float", description: "Kelvin 环可以把偏压驱动到的下界", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "setpoint", type: "float", description: "环的设定值（通常为 0 —— 把力归零）", required: false, default: 0 },
    { name: "p_gain", type: "float", description: "比例增益", required: false, minValue: 0, default: 1 },
    { name: "time_constant_s", type: "float", description: "积分时间常数", unit: "s", required: false, minValue: 0.000001, maxValue: 100, default: 0.01 },
    { name: "slope", type: "int", description: "环的斜率：0 = 负，1 = 正", required: false, minValue: 0, maxValue: 1, default: 0 },
    { name: "control_signal_index", type: "int", description: "环所伺服的解调信号", required: false, minValue: 0, maxValue: 127, default: 0 },
    { name: "modulation_frequency_hz", type: "float", description: "AC 调制频率", unit: "Hz", required: false, minValue: 0, maxValue: 1000000, default: 1000 },
    { name: "modulation_amplitude", type: "float", description: "AC 调制幅度（V）", unit: "V", required: false, minValue: 0, maxValue: 10, default: 0.1 },
    { name: "modulation_phase_deg", type: "float", description: "AC 调制相位", unit: "deg", required: false, minValue: -360, maxValue: 360, default: 0 },
  ],
  tags: ["kpfm","kelvin","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetKelvinControllerOnOffSpec: SkillSpec = {
  name: "SetKelvinControllerOnOff",
  description: "打开或关闭 Kelvin(KPFM)反馈环，连同它的 AC 调制一起。\n\n打开时须当心：从那一刻起，这个环就会在针尖处于工作距离的情况下，持续地、自主地**驱动偏压**。环没调好、或解调信号有噪声，它会把偏压一路推到 ConfigureKelvinController 所设的限值为止 —— 所以先把那些限值设好，而且要设紧。关闭则永远是安全的，偏压会停在环最后放它的地方（用 GetBias 读回）。",
  parameters: [
    { name: "on", type: "bool", description: "True = 闭合 Kelvin 环（它随即开始驱动偏压）", required: true },
    { name: "modulation_on", type: "bool", description: "AC 调制随之一起开关", required: false, default: true },
    { name: "ac_mode", type: "bool", description: "AC 模式（相对 DC）", required: false, default: true },
  ],
  tags: ["kpfm","kelvin","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetKelvinControllerSpec: SkillSpec = {
  name: "GetKelvinController",
  description: "读 Kelvin 控制器：环是否闭合、它的设定值、增益、偏压限值、调制参数，以及解调幅度。读一下幅度就能判断这个环有没有东西可伺服 —— 幅度接近零意味着环在追噪声。",
  parameters: [],
  tags: ["kpfm","kelvin","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const RunCpdCompensationSpec: SkillSpec = {
  name: "RunCpdCompensation",
  description: "打开 CPD 补偿模块并运行它：它会在给定范围内**扫描偏压**以直接找出接触电位差的抛物线，而不是像 Kelvin 环那样伺服到它。\n\n当心：这会在针尖处于工作距离时把偏压扫过 ±range_v。range_v 是**以零为中心的半幅** —— range_v=2 表示从 -2 V 扫到 +2 V。把它限制在 CPD 实际所在的那一两伏内；近距离下做大范围扫描，你就不是在测量样品，而是在改造它。\n\n用 GetCpdCompensation 读结果。",
  parameters: [
    { name: "range_v", type: "float", description: "要扫描的偏压**半幅**（以零为中心的 ±range_v）", unit: "V", required: true, minValue: 0.01, maxValue: 10 },
    { name: "speed_hz", type: "float", description: "扫描速度", unit: "Hz", required: false, minValue: 0.01, maxValue: 100000, default: 100 },
    { name: "averaging", type: "int", description: "每点平均次数", required: false, minValue: 1, maxValue: 10000, default: 1 },
  ],
  tags: ["kpfm","cpd","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetCpdCompensationSpec: SkillSpec = {
  name: "GetCpdCompensation",
  description: "读 CPD 补偿模块测得的接触电位差，以及它当前的参数。",
  parameters: [],
  tags: ["kpfm","cpd","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureInterferometerSpec: SkillSpec = {
  name: "ConfigureInterferometer",
  description: "配置干涉式偏转探测器：它的 PI 环增益与符号，以及工作点压电电压。\n\nnull_deflection=true 会额外跑一次归零偏转例程，把干涉仪压电移到能让悬臂落在干涉条纹最陡（最灵敏）那一段的位置。信任任何偏转读数之前先做这一步 —— 偏离条纹时，探测器既不灵敏又非线性。",
  parameters: [
    { name: "integral", type: "float", description: "PI 积分增益", required: false, default: 1 },
    { name: "proportional", type: "float", description: "PI 比例增益", required: false, default: 1 },
    { name: "sign", type: "int", description: "环的符号：0 = 负，1 = 正", required: false, minValue: 0, maxValue: 1, default: 0 },
    { name: "w_piezo", type: "float", description: "工作点压电电压", unit: "V", required: false, default: 0 },
    { name: "null_deflection", type: "bool", description: "跑归零偏转例程（停在最陡的条纹上）", required: false, default: false },
  ],
  tags: ["interferometer","afm","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetInterferometerOnOffSpec: SkillSpec = {
  name: "SetInterferometerOnOff",
  description: "打开或关闭干涉仪的 PI 控制环。reset=true 会先复位这个环的积分器 —— 如果环已经积分饱和、卡在轨上，就该这么做。",
  parameters: [
    { name: "on", type: "bool", description: "True = 闭合这个环", required: true },
    { name: "reset", type: "bool", description: "开关之前先复位这个环", required: false, default: false },
  ],
  tags: ["interferometer","afm","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetInterferometerSpec: SkillSpec = {
  name: "GetInterferometer",
  description: "读干涉仪：当前的偏转值、它的环是否闭合、它的增益，以及压电工作点。",
  parameters: [],
  tags: ["interferometer","afm","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureBeamDeflectionSpec: SkillSpec = {
  name: "ConfigureBeamDeflection",
  description: "设定**一条**光杠杆偏转轴的标定：vertical（法向力）、horizontal（横向力／摩擦力），或强度和 sum。\n\n标定把光电二极管的伏特换算成物理单位（偏转的 N/m、力的 nN）。AFM 下游报出来的每一个力的数值都被它缩放过 —— 标定错了不会失败，它只会安静地让此后每一个力都差一个固定倍数。",
  parameters: [
    { name: "axis", type: "str", description: "vertical（法向）、horizontal（横向），或 sum（强度）", required: true, allowedValues: ["vertical","horizontal","sum"] },
    { name: "name", type: "str", description: "在 Nanonis 里显示的信号名", required: true },
    { name: "units", type: "str", description: "标定之后的物理单位（例如 'nN'、'nm'）", required: true },
    { name: "calibration", type: "float", description: "每伏对应多少物理单位", required: true },
    { name: "offset", type: "float", description: "以物理单位表示的偏置", required: false, default: 0 },
  ],
  tags: ["beam_deflection","afm","calibration","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetBeamDeflectionSpec: SkillSpec = {
  name: "GetBeamDeflection",
  description: "读光杠杆偏转探测器三条轴（vertical、horizontal、sum）的配置：名称、单位、标定与偏置。信任任何力的数值之前，先核一下标定。",
  parameters: [],
  tags: ["beam_deflection","afm","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const AutoZeroBeamDeflectionSpec: SkillSpec = {
  name: "AutoZeroBeamDeflection",
  description: "自动归零光杠杆偏转信号：测出它当前的值，并把它作为偏置扣掉，于是「零偏转」就等于悬臂当前的静止位置。\n\n做这件事时针尖必须**已退针**、悬臂处于自由状态。在接触状态下自动归零，等于把带载的偏转定义成了零 —— 此后你测到的每一个力，都会被你原本就施加着的那份载荷偏移掉。",
  parameters: [
    { name: "deflection_signal", type: "int", description: "要归零的偏转信号序号", required: false, minValue: 0, maxValue: 127, default: 0 },
  ],
  tags: ["beam_deflection","afm","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetLaserOnOffSpec: SkillSpec = {
  name: "SetLaserOnOff",
  description: "打开或关闭激光。\n\n打开时是 DANGEROUS。激光既是对眼睛的危害，也是结区的一份热负载；MAST 看不到快门是否关着、显微镜旁有没有人、光束打向哪里。只有在用户要求时才打开它。\n\n关闭则永远允许 —— 包括在 abort 之后：对激光而言，「关」毫无歧义地就是安全态。",
  parameters: [
    { name: "on", type: "bool", description: "True = 激光开", required: true },
  ],
  tags: ["laser","optical","dangerous","optional-hardware"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const SetLaserPowerSpec: SkillSpec = {
  name: "SetLaserPower",
  description: "设定激光的功率设定值。**不会**打开激光 —— 那是 SetLaserOnOff 的事。趁激光关着的时候设功率，是预置一个值的安全做法：设好、用 GetLaser 读回、再打开。",
  parameters: [
    { name: "setpoint", type: "float", description: "激光功率设定值（用激光模块自己的单位）", required: true, minValue: 0 },
  ],
  tags: ["laser","optical","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetLaserSpec: SkillSpec = {
  name: "GetLaser",
  description: "读激光：它是否处于开启状态、实测功率，以及设定值。在假定激光是关着的之前，先读这一条。",
  parameters: [],
  tags: ["laser","optical","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetProbeZControllerSpec: SkillSpec = {
  name: "SetProbeZController",
  description: "设定**某一根**探针的 Z 控制器：开／关它，并设定它的设定值与增益。\n\n当心。把一根探针的 Z 环打开、而设定值又是它根本达不到的，会把那根探针**扎进样品**。把它关掉则会让探针停在当前 Z 上、没有任何东西托着它 —— 想让探针处于安全状态，请用 WithdrawProbe，而不是关掉。\n\n这个技能只作用于你点名的那根探针，别的一根都不动。普通的 ZController 技能作用于**主**通道，那是某一根特定的探针 —— 除非它恰好就是当前的扫描探针，否则不是这一根。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
    { name: "on", type: "bool", description: "闭合这根探针的 Z 反馈环", required: true },
    { name: "setpoint", type: "float", description: "Z 控制器设定值（电流，单位 A）—— 不传则保持不变", unit: "A", required: false },
    { name: "p_gain", type: "float", description: "比例增益 —— 不传则保持不变", required: false, minValue: 0 },
    { name: "i_gain", type: "float", description: "积分增益 —— 不传则保持不变", required: false, minValue: 0 },
  ],
  tags: ["multiprobe","zcontroller","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetProbeZControllerSpec: SkillSpec = {
  name: "GetProbeZController",
  description: "读**某一根**探针的 Z 控制器：它是否开着、它的设定值、增益、Z 位置与 Z 限值。移动那根探针之前先读这个。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
  ],
  tags: ["multiprobe","zcontroller","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const WithdrawProbeSpec: SkillSpec = {
  name: "WithdrawProbe",
  description: "退回**某一根**探针：关掉它的 Z 控制器，并把它的 Z 驱到安全（完全退出）的那一端。\n\n这是一根探针的**安全**状态，而且永远允许 —— 包括在 abort 之后。拿不准某根探针的状态，就把它退回来。普通的 Withdraw 技能只作用于主通道；在多探针装置上，你进过针的每一根探针都必须各自退回。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
  ],
  tags: ["multiprobe","withdraw","safe","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ConfigureProbeScannerSpec: SkillSpec = {
  name: "ConfigureProbeScanner",
  description: "设定**某一根**探针的扫描器标定（X/Y/Z 系数）与移动速度。\n\n标定把下达的伏特换算成米。它不是一个装点门面的设置：X 系数错了，就意味着 MoveProbeXY 走的距离和你要的不一样（方向倒是一样），而且不会报错 —— 在多探针装置上，这意味着把一根探针开进另一根里去。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
    { name: "speed", type: "float", description: "扫描器移动速度（m/s）—— 不传则保持不变", unit: "m/s", required: false, minValue: 0 },
    { name: "factor_x", type: "float", description: "X 标定系数 —— 不传则保持不变", required: false },
    { name: "factor_y", type: "float", description: "Y 标定系数 —— 不传则保持不变", required: false },
    { name: "factor_z", type: "float", description: "Z 标定系数 —— 不传则保持不变", required: false },
  ],
  tags: ["multiprobe","scanner","calibration","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const MoveProbeXYSpec: SkillSpec = {
  name: "MoveProbeXY",
  description: "把**某一根**探针移动到一个绝对 (X, Y) 位置，单位**米**。\n\nDANGEROUS。这会真的驱动一根针尖横穿样品。在多探针装置上，各根探针共用同一个表面、彼此可能只隔几微米 —— 一次按错误探针的坐标系算出来的移动、或者用错扫描器标定的移动，会把一根针尖开进另一根里、或者开上一道台阶边。\n\n坐标单位是**米**：100 nm 是 100n，不是 100。先用 GetProbeZController 加扫描器自己的 XY 读取接口读一下当前位置，并且优先用小步的相对移动。StopProbeScanner 能中止一次正在进行的移动，按 中止 也能。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
    { name: "x_m", type: "float", description: "绝对 X，单位**米**（100 nm = 100n）", unit: "m", required: true, minValue: -0.001, maxValue: 0.001 },
    { name: "y_m", type: "float", description: "绝对 Y，单位**米**（100 nm = 100n）", unit: "m", required: true, minValue: -0.001, maxValue: 0.001 },
  ],
  tags: ["multiprobe","scanner","motion","dangerous","optional-hardware"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const StopProbeScannerSpec: SkillSpec = {
  name: "StopProbeScanner",
  description: "立即停止**某一根**探针的扫描器运动。永远允许，包括在 abort 之后。停止只是中止这次移动 —— 它**不会**把探针退回来；要退请用 WithdrawProbe。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
  ],
  tags: ["multiprobe","scanner","stop","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetProbeBiasSpec: SkillSpec = {
  name: "SetProbeBias",
  description: "设定**某一根**探针的偏压，单位**伏特**。\n\n每根探针都有自己的偏压。设 probe 1 的偏压不会改变 probe 0 的 —— 而普通的 SetBias 技能作用于主通道，那是某一根特定的探针，未必是你心里想的那一根。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
    { name: "bias_v", type: "float", description: "偏压，单位**伏特**", unit: "V", required: true, minValue: -10, maxValue: 10 },
  ],
  tags: ["multiprobe","bias","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const PulseProbeBiasSpec: SkillSpec = {
  name: "PulseProbeBias",
  description: "在**某一根**探针上施加一次偏压**脉冲**：跳到某个值、维持一段设定的宽度，然后回来。\n\n当心。偏压脉冲正是你用来**蓄意改造**针尖或表面的手段 —— 它是 TipPulse 的多探针版本。它会钝化针尖、挖出一个坑、或者挪动一个吸附物，而且是故意的。宽度单位是**秒**（1 ms = 0.001）。\n\nhold_z=true 会在脉冲期间冻结 Z 控制器（标准做法 —— 反馈环绝不能去追那个电流尖峰）。relative=true 让这个值成为相对当前偏压的偏移量，而不是绝对值。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
    { name: "value_v", type: "float", description: "脉冲偏压，单位**伏特**（绝对值；relative 时则为偏移量）", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "width_s", type: "float", description: "脉冲宽度，单位**秒**（1 ms = 0.001）", unit: "s", required: true, minValue: 0.000001, maxValue: 10 },
    { name: "hold_z", type: "bool", description: "脉冲期间冻结 Z 控制器（标准做法）", required: false, default: true },
    { name: "relative", type: "bool", description: "value_v 是相对当前偏压的偏移量", required: false, default: false },
    { name: "wait", type: "bool", description: "阻塞直到脉冲结束", required: false, default: true },
  ],
  tags: ["multiprobe","bias","pulse","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetProbeBiasSpec: SkillSpec = {
  name: "GetProbeBias",
  description: "读**某一根**探针的偏压、它的量程设置与标定。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
  ],
  tags: ["multiprobe","bias","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetProbeCurrentSpec: SkillSpec = {
  name: "GetProbeCurrent",
  description: "读**某一根**探针的隧道电流（单位安培）及其可用的前放增益档。用这个逐探针的读数来判断那一根特定探针是否处在隧穿距离内 —— 主 Current 通道只报其中一根。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
  ],
  tags: ["multiprobe","current","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureProbeCurrentGainSpec: SkillSpec = {
  name: "ConfigureProbeCurrentGain",
  description: "设定**某一根**探针的电流前放增益与滤波器，用的是该探针自己那份增益表里的**序号**（表用 GetProbeCurrent 读）。\n\n改增益会改变同一个电流**读出来是多少**。要做就在 Z 控制器关闭、或探针已退回的状态下做：环闭合时，一次增益改变在反馈看来就是电流突变，而环的回应是去移动这根探针。",
  parameters: [
    { name: "probe", type: "int", description: "**哪一根探针**（扫描器序号，0 起算）。必填 —— 没有默认值，因为默认下去会撞坏错的那根针尖。", required: true, minValue: 0, maxValue: 7 },
    { name: "gain_index", type: "int", description: "这根探针增益表里的序号（表来自 GetProbeCurrent）", required: true, minValue: 0, maxValue: 31 },
    { name: "filter_index", type: "int", description: "这根探针滤波器表里的序号", required: false, minValue: 0, maxValue: 31, default: 0 },
  ],
  tags: ["multiprobe","current","gain","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureHighSpeedSweepSpec: SkillSpec = {
  name: "ConfigureHighSpeedSweep",
  description: "配置高速扫频器（High-Speed Sweeper）：扫哪个信号、扫什么范围、多少个点、时序，以及记录哪些通道。\n\n**用它之前先读这一段。** 被扫的信号是按**序号**从可扫信号表里挑的 —— 调 GetHighSpeedSweepStatus 才看得到那张表。HSSwp 你点名什么它就扫什么：偏压、一块压电、一路输出。它既不知道也不在乎是哪一个。序号点错，就是在高速驱动错误的东西。\n\nrelative_limits=true 会让 start/stop 变成相对该信号当前值的**偏移量**（例如在当前偏压附近 ±0.5 V）；false 则是绝对值。把这个弄反，是扫到一个你从没打算去的值的经典途径。\n\nz_controller_off=true 会在整段扫描期间抬掉 Z 反馈 —— 做谱学时这是对的（针尖绝不能去追电流），而如果被扫的信号会牵动 Z，它就是一份撞针风险。配置本身还什么都不改变；真正执行的是 RunHighSpeedSweep。",
  parameters: [
    { name: "sweep_signal_index", type: "int", description: "**可扫信号表**里的序号（不是通用信号目录）", required: true, minValue: 0, maxValue: 127 },
    { name: "start", type: "float", description: "扫描起点（绝对值；relative_limits 时则为偏移量）", required: true },
    { name: "stop", type: "float", description: "扫描终点（绝对值；relative_limits 时则为偏移量）", required: true },
    { name: "relative_limits", type: "bool", description: "start/stop 是相对该信号**当前**值的偏移量", required: false, default: false },
    { name: "points", type: "int", description: "每次扫描的点数", required: false, minValue: 2, maxValue: 100000, default: 256 },
    { name: "acquire_channels", type: "str", description: "扫描期间要记录的信号序号，逗号分隔（例如 '0,24'）", required: true },
    { name: "settling_time_s", type: "float", description: "每点的稳定时间", unit: "s", required: false, minValue: 0, maxValue: 10, default: 0.0001 },
    { name: "integration_time_s", type: "float", description: "每点的积分时间", unit: "s", required: false, minValue: 0, maxValue: 10, default: 0.0001 },
    { name: "initial_settling_time_s", type: "float", description: "第一个点之前的稳定时间", unit: "s", required: false, minValue: 0, maxValue: 60, default: 0.001 },
    { name: "max_slew_time_s", type: "float", description: "允许用来爬到起始值的最长时间", unit: "s", required: false, minValue: 0, maxValue: 60, default: 1 },
    { name: "backward_sweep", type: "bool", description: "同时反向扫一遍（stop → start）", required: false, default: true },
    { name: "num_sweeps", type: "int", description: "平均多少次扫描（0 = 一直连续扫到被停止为止）", required: false, minValue: 0, maxValue: 10000, default: 1 },
    { name: "z_controller_off", type: "bool", description: "扫描期间抬掉 Z 反馈（做谱学时是对的；如果被扫信号会牵动 Z，则是一份撞针风险）", required: false, default: false },
    { name: "z_offset_m", type: "float", description: "控制器关闭期间施加的 Z 偏移", unit: "m", required: false, minValue: -0.000001, maxValue: 0.000001, default: 0 },
  ],
  tags: ["sweep","hs_sweeper","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const RunHighSpeedSweepSpec: SkillSpec = {
  name: "RunHighSpeedSweep",
  description: "执行由 ConfigureHighSpeedSweep 配好的那次扫描。它会把你点名的那路信号 —— 偏压、一块压电、一路输出 —— 从起点**驱动**到终点，而且很快。\n\n当心：扫频器对信号本身是不可知的。它会毫不犹豫地把一块压电开到硬限位上、或者把偏压拉过一个会毁掉针尖的范围，因为它就是被这么吩咐的。永远先 ConfigureHighSpeedSweep，并核对你点的到底是什么。\n\nwait=true 会阻塞到扫描结束（或 timeout_s 到期）并返回数据；wait=false 立刻返回，之后由你用 GetHighSpeedSweepStatus 轮询。StopHighSpeedSweep 能中止它，按 中止 也能。",
  parameters: [
    { name: "wait", type: "bool", description: "阻塞直到扫描结束", required: false, default: true },
    { name: "timeout_s", type: "float", description: "wait=true 时最多等多久", unit: "s", required: false, minValue: 1, maxValue: 3600, default: 60 },
  ],
  tags: ["sweep","hs_sweeper","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StopHighSpeedSweepSpec: SkillSpec = {
  name: "StopHighSpeedSweep",
  description: "立即停止正在跑的高速扫描。永远允许 —— 包括在 abort 之后，那正是「停止」这件事存在的意义。",
  parameters: [],
  tags: ["sweep","hs_sweeper","stop","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetHighSpeedSweepStatusSpec: SkillSpec = {
  name: "GetHighSpeedSweepStatus",
  description: "读高速扫频器的状态：是否有扫描在跑、当前的扫描信号与限值，以及**可扫信号表**。\n\n请在 ConfigureHighSpeedSweep **之前**调它 —— 扫描信号是按序号从那张表里挑的，而那张表不是通用信号目录。序号靠猜，就是在扫错东西。",
  parameters: [],
  tags: ["sweep","hs_sweeper","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureRfGeneratorSpec: SkillSpec = {
  name: "ConfigureRfGenerator",
  description: "设定 RF 源的频率与功率，但**不**打开输出。用它来预置一组设置、核对一遍，然后才调 StartRfGenerator。\n\npower_dbm 的单位是 dBm，这是一个**对数**标度：+10 dBm 是 0 dBm 的十倍功率，不是多百分之十。频率单位是 Hz —— 2.5 GHz 要写成 2.5e9，写 2.5 就是 2.5 Hz，而且不会有任何提示。",
  parameters: [
    { name: "frequency_hz", type: "float", description: "RF 频率，单位**赫兹**（2.5 GHz = 2.5e9）", unit: "Hz", required: true, minValue: 0, maxValue: 40000000000 },
    { name: "power_dbm", type: "float", description: "RF 功率，单位 dBm（对数标度）", unit: "dBm", required: true, minValue: -100, maxValue: 30 },
  ],
  tags: ["rf","aprf_gen","optional-hardware"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StartRfGeneratorSpec: SkillSpec = {
  name: "StartRfGenerator",
  description: "以当前配置好的频率与功率打开 RF 输出。\n\nDANGEROUS：打进隧道结里的 dBm 就是**能量**。RF 功率会耦合进针尖和样品，量够大就会改变、乃至毁掉这两者。先调 ConfigureRfGenerator 并确认那些数字 —— GetRfGeneratorStatus 显示的才是实际设进去的值。\n\nStopRfGenerator 能切断它，按 中止 也能。",
  parameters: [],
  tags: ["rf","aprf_gen","dangerous","optional-hardware"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const StopRfGeneratorSpec: SkillSpec = {
  name: "StopRfGenerator",
  description: "停掉任何正在跑的 RF 扫描，**并且**关闭 RF 输出。永远允许，包括在 abort 之后。两件事都做，且按这个顺序 —— 只停扫描而不切断输出，会让 RF 停在扫描走到的那个值上继续输出。",
  parameters: [],
  tags: ["rf","aprf_gen","stop","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const RunRfFrequencySweepSpec: SkillSpec = {
  name: "RunRfFrequencySweep",
  description: "以当前功率把 RF 频率从一端扫到另一端，每个点驻留一段时间。\n\nDANGEROUS，理由与 StartRfGenerator 相同 —— 整段扫描期间它都在往外发 RF。请先用 ConfigureRfGenerator 把功率设好。\n\n限值单位是**赫兹**。dwell_s 是每点的驻留时间；points 是点数。总时长 ≈ points × dwell_s × repetitions。auto_off=true 会在扫描结束时切断 RF —— 除非你特别希望输出停在末频率上继续，否则就让它开着。",
  parameters: [
    { name: "lower_hz", type: "float", description: "扫描下限，单位**赫兹**", unit: "Hz", required: true, minValue: 0, maxValue: 40000000000 },
    { name: "upper_hz", type: "float", description: "扫描上限，单位**赫兹**", unit: "Hz", required: true, minValue: 0, maxValue: 40000000000 },
    { name: "points", type: "int", description: "整段扫描的点数", required: false, minValue: 2, maxValue: 100000, default: 101 },
    { name: "dwell_s", type: "float", description: "每个点的驻留时间", unit: "s", required: false, minValue: 0.000001, maxValue: 60, default: 0.01 },
    { name: "repetitions", type: "int", description: "这段扫描重复多少遍", required: false, minValue: 1, maxValue: 10000, default: 1 },
    { name: "direction", type: "str", description: "up（lower→upper）或 down", required: false, allowedValues: ["up","down"], default: "up" },
    { name: "auto_off", type: "bool", description: "扫描结束时关闭 RF 输出", required: false, default: true },
  ],
  tags: ["rf","aprf_gen","sweep","dangerous","optional-hardware"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const GetRfGeneratorStatusSpec: SkillSpec = {
  name: "GetRfGeneratorStatus",
  description: "读 RF 源的频率、功率，以及 —— 真正要紧的那一项 —— **输出是否开着**。在假定 RF 是关的之前，先核这一条。",
  parameters: [],
  tags: ["rf","aprf_gen","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureHighResScopeSpec: SkillSpec = {
  name: "ConfigureHighResScope",
  description: "配置高分辨率示波器（OsciHR）：用哪个信号、采多少点、过采样，以及触发。\n\n配置示波器不会碰仪器 —— 它只决定**什么被数字化**。没有东西会动，也没有东西被施加出去。\n\ntrigger_mode 为 'immediate' 时，一 Run 就立刻捕获；'level' 会等 trigger_channel 按给定方向穿过 trigger_level；'digital' 则等一条数字线。信号序号来自信号目录（ListSignalNames）。",
  parameters: [
    { name: "signal_index", type: "int", description: "要数字化的信号（来自 ListSignalNames）", required: true, minValue: 0, maxValue: 127 },
    { name: "samples", type: "int", description: "每次采集捕获的点数", required: false, minValue: 1, maxValue: 1000000, default: 1024 },
    { name: "oversampling_index", type: "int", description: "过采样序号（0 = 不过采样；越高平均越多、越慢）", required: false, minValue: 0, maxValue: 10, default: 0 },
    { name: "trigger_mode", type: "str", description: "immediate | level | digital", required: false, allowedValues: ["immediate","level","digital"], default: "immediate" },
    { name: "trigger_channel", type: "int", description: "触发源通道（level 模式用）", required: false, minValue: 0, maxValue: 127, default: 0 },
    { name: "trigger_level", type: "float", description: "触发阈值，用触发通道自己的物理单位", required: false, default: 0 },
    { name: "trigger_slope", type: "str", description: "rising | falling", required: false, allowedValues: ["falling","rising"], default: "rising" },
    { name: "trigger_hysteresis", type: "float", description: "触发迟滞（防止在噪声上反复触发）", required: false, minValue: 0, default: 0 },
    { name: "osci_index", type: "int", description: "第几个 OsciHR 实例（0 起算）", required: false, minValue: 0, maxValue: 7, default: 0 },
  ],
  tags: ["oscilloscope","osci_hr","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const RunHighResScopeSpec: SkillSpec = {
  name: "RunHighResScope",
  description: "启动高分辨率示波器（并重新武装它的触发）。之后调 GetHighResScopeData 把波形取回来。\n\n对仪器而言这是只读的：跑示波器是把一个信号数字化，它不驱动任何东西。",
  parameters: [
    { name: "rearm", type: "bool", description: "启动前先重新武装触发", required: false, default: true },
  ],
  tags: ["oscilloscope","osci_hr","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetHighResScopeDataSpec: SkillSpec = {
  name: "GetHighResScopeData",
  description: "读高分辨率示波器捕获到的波形，并可选地读它的功率谱密度。\n\nwait_for_trigger=true 会在示波器上**阻塞**，直到下一次触发发生、或 timeout_s 到期 —— 触发是 level/digital 时，请在 RunHighResScope 之后这样用。timeout_s 给短了你会拿到一个错误，而不是半条波形。",
  parameters: [
    { name: "wait_for_trigger", type: "bool", description: "等下一次触发，而不是取当前缓冲区", required: false, default: true },
    { name: "timeout_s", type: "float", description: "等触发最多等多久", unit: "s", required: false, minValue: 0.1, maxValue: 600, default: 10 },
    { name: "include_psd", type: "bool", description: "同时读 PSD 部分", required: false, default: false },
    { name: "osci_index", type: "int", description: "第几个 OsciHR 实例（0 起算）", required: false, minValue: 0, maxValue: 7, default: 0 },
  ],
  tags: ["oscilloscope","osci_hr","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetHighResScopeStatusSpec: SkillSpec = {
  name: "GetHighResScopeStatus",
  description: "回读高分辨率示波器当前的配置：通道、采样点数、过采样与触发模式。在信任一次由别人（或 Nanonis 界面）设好的捕获之前先读它。",
  parameters: [
    { name: "osci_index", type: "int", description: "第几个 OsciHR 实例（0 起算）", required: false, minValue: 0, maxValue: 7, default: 0 },
  ],
  tags: ["oscilloscope","osci_hr","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureDualScopeSpec: SkillSpec = {
  name: "ConfigureDualScope",
  description: "配置 2 通道示波器：两路信号、时基，以及触发。需要把两个信号放在**同一条**时基上互相对照时用它（一对 pump-probe、电流对偏压、锁相的 X/Y）。\n\ntimebase_index 是从 Nanonis 固定的时基表里挑一项，它**不是**以秒为单位的时间。配置示波器不驱动任何东西。",
  parameters: [
    { name: "channel_a", type: "int", description: "通道 A 的信号序号", required: true, minValue: 0, maxValue: 127 },
    { name: "channel_b", type: "int", description: "通道 B 的信号序号", required: true, minValue: 0, maxValue: 127 },
    { name: "timebase_index", type: "int", description: "时基序号（0 起算，取自 Nanonis 的固定表 —— 不是秒）", required: false, minValue: 0, maxValue: 15, default: 0 },
    { name: "trigger_mode", type: "int", description: "0 = immediate，1 = level，2 = auto", required: false, minValue: 0, maxValue: 2, default: 0 },
    { name: "trigger_channel", type: "int", description: "触发源：0 = 通道 A，1 = 通道 B", required: false, minValue: 0, maxValue: 1, default: 0 },
    { name: "trigger_slope", type: "int", description: "0 = 下降沿，1 = 上升沿", required: false, minValue: 0, maxValue: 1, default: 1 },
    { name: "trigger_level", type: "float", description: "触发阈值，用触发通道自己的单位", required: false, default: 0 },
    { name: "trigger_hysteresis", type: "float", description: "触发迟滞", required: false, minValue: 0, default: 0 },
    { name: "trigger_position", type: "float", description: "触发点在记录中的位置（0..1）", required: false, minValue: 0, maxValue: 1, default: 0 },
  ],
  tags: ["oscilloscope","osci_2t","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetDualScopeDataSpec: SkillSpec = {
  name: "GetDualScopeData",
  description: "跑 2 通道示波器并把两路波形都读回来。先调 ConfigureDualScope 选定信号与时基。\n\n返回的通道 A 与通道 B 共用一条时间轴。",
  parameters: [
    { name: "run_first", type: "bool", description: "读之前先启动一次新的采集", required: false, default: true },
    { name: "data_to_get", type: "int", description: "0 = 当前缓冲区，1 = 下一次触发，2 = 等待下一次触发", required: false, minValue: 0, maxValue: 2, default: 1 },
  ],
  tags: ["oscilloscope","osci_2t","read","optional-hardware"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureSignalChartSpec: SkillSpec = {
  name: "ConfigureSignalChart",
  description: "打开 Signal Chart 并设定它显示哪两路信号。这是 Nanonis 机器上的一个**显示**模块 —— 它改变的是用户在那边看到的东西，与测量本身无关。",
  parameters: [
    { name: "channel_a", type: "int", description: "图表 A 的信号序号", required: true, minValue: 0, maxValue: 127 },
    { name: "channel_b", type: "int", description: "图表 B 的信号序号", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["signal_chart","display","optional-hardware"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetUserOutputLimitsSpec: SkillSpec = {
  name: "GetUserOutputLimits",
  description: "读某个用户输出通道的物理上／下限。这两个限值就是 SetUserOutput 的**安全包络** —— 它们由用户在 Nanonis 里配置，从这里改不了。要驱动一个你没把握的输出之前，先读它们。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算（1..N）", required: true, minValue: 1, maxValue: 24 },
    { name: "raw", type: "int", description: "0 = 物理（已标定）限值；1 = 原始限值", required: false, minValue: 0, maxValue: 1, default: 0 },
  ],
  tags: ["output","user_output","read","safety"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetUserOutputModeSpec: SkillSpec = {
  name: "GetUserOutputMode",
  description: "读某个用户输出的模式：0=User Output（由你驱动），1=Monitor（它镜像一路信号），2=Calc.Signal。SetUserOutput 只有在模式 0 下才起作用 —— Monitor 模式下这个通道由仪器驱动，不由你。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
  ],
  tags: ["output","user_output","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetUserOutputMonitorChannelSpec: SkillSpec = {
  name: "GetUserOutputMonitorChannel",
  description: "读某个用户输出的监视通道序号（Monitor 模式）。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
  ],
  tags: ["output","user_output","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetDigitalLineTTLSpec: SkillSpec = {
  name: "GetDigitalLineTTL",
  description: "读某个数字端口上全部 8 条线的 TTL 值。",
  parameters: [
    { name: "port", type: "int", description: "0=Port A，1=B，2=C，3=D，4+ = 扩展 DIO", required: true, minValue: 0, maxValue: 8 },
  ],
  tags: ["output","digital","ttl","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetCalculatedOutputConfigSpec: SkillSpec = {
  name: "GetCalculatedOutputConfig",
  description: "读某个用户输出把哪两路信号、用什么运算、以什么名字组合起来（Calc.Signal 模式）。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
  ],
  tags: ["output","user_output","calc_signal","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetUserOutputSpec: SkillSpec = {
  name: "SetUserOutput",
  description: "把某个用户输出通道设成一个值，用该通道**已标定的物理单位**（**不一定是伏特** —— 依它在 Nanonis 里的标定，一个通道可能是 µm、mW 或别的任何东西）。\n\n这驱动的是 MAST 看不见的**外部**硬件（一路栅压、一台压电放大器、一个激光快门、一条延时线）。要在一个你没把握的通道上设值之前，先调 GetUserOutputLimits 和 GetUserOutputMode —— Monitor 模式的通道根本不理你，而超出用户所设限值的值会被**拒绝**，不是被夹到边界。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算（1..N）", required: true, minValue: 1, maxValue: 24 },
    { name: "value", type: "float", description: "目标值，用该通道的物理单位。必须落在该通道在 Nanonis 里配置的限值之内。", required: true },
  ],
  tags: ["output","user_output","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetUserOutputModeSpec: SkillSpec = {
  name: "SetUserOutputMode",
  description: "设定某个用户输出的模式：0=User Output（由你驱动），1=Monitor（它镜像一路仪器信号），2=Calc.Signal。把一个通道切**进**模式 0，等于把外部硬件的控制权交给 agent；把它切**出**去，则是把控制权交还给仪器。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
    { name: "mode", type: "int", description: "0=User Output，1=Monitor，2=Calc.Signal", required: true, minValue: 0, maxValue: 2 },
  ],
  tags: ["output","user_output","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetUserOutputMonitorChannelSpec: SkillSpec = {
  name: "SetUserOutputMonitorChannel",
  description: "设定某个用户输出镜像哪一路信号（只在 Monitor 模式下有意义）。用 ListSignalNames／信号目录去找通道序号。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
    { name: "monitor_channel_index", type: "int", description: "要镜像的信号序号（0..127）", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["output","user_output","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetUserOutputLimitsSpec: SkillSpec = {
  name: "SetUserOutputLimits",
  description: "设定某个用户输出通道的物理上／下限。这两个限值就是 SetUserOutput 据以核对的那道包络，所以把它们放宽，就等于放宽了 agent 被允许驱动的范围 —— 这是一次护栏改动，它需要用户确认，并且会被记入诊断账本（记录 → 诊断）。收紧它们可以保护一个通道；只有在接线确实容许更大范围时，才把它们放宽。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
    { name: "upper_limit", type: "float", description: "物理上限（该通道已标定的单位）", required: true },
    { name: "lower_limit", type: "float", description: "物理下限（该通道已标定的单位）", required: true },
    { name: "raw", type: "int", description: "0 = 物理（已标定）限值；1 = 原始限值", required: false, minValue: 0, maxValue: 1, default: 0 },
  ],
  tags: ["output","user_output","write","safety"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetUserOutputCalibrationSpec: SkillSpec = {
  name: "SetUserOutputCalibration",
  description: "设定某个用户输出或监视通道的标定（每伏对应多少物理单位 + 偏移）。这会重新定义在该通道上「一个物理单位」**意味着什么**：改完标定之后，同一个数值驱动出的是**另一个**电压，而且每一条限值都会按新单位重新解释。用它来把该通道真实的缩放关系告诉 MAST；不要用它来绕开一条限值。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
    { name: "calibration_per_volt", type: "float", description: "DAC 每输出一伏对应多少物理单位", required: true },
    { name: "offset", type: "float", description: "偏移，用物理单位表示", required: false, default: 0 },
  ],
  tags: ["output","user_output","write","calibration"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureCalculatedOutputSpec: SkillSpec = {
  name: "ConfigureCalculatedOutput",
  description: "让某个用户输出承载两路信号做一次算术运算的**结果**（Calc.Signal 模式）：例如把 (Signal_A − Signal_B) 作为一条实时模拟线输出。适合做差分通道、归一化信号，或者你想送上示波器、送进外部硬件的某个导出量。\n\n要让它生效，请用 SetUserOutputMode 把该输出切到模式 2（Calc.Signal）。",
  parameters: [
    { name: "output_index", type: "int", description: "用户输出通道，1 起算", required: true, minValue: 1, maxValue: 24 },
    { name: "signal_1", type: "int", description: "第一路信号的序号（见 ListSignalNames）", required: true, minValue: 0, maxValue: 127 },
    { name: "operation", type: "str", description: "算术运算：+ - * /", required: true, allowedValues: ["+","-","*","/"] },
    { name: "signal_2", type: "int", description: "第二路信号的序号", required: true, minValue: 0, maxValue: 127 },
    { name: "name", type: "str", description: "这个计算信号的名字（会显示在 Nanonis 里）", required: false, default: "" },
  ],
  tags: ["output","user_output","calc_signal","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const PulseDigitalLineSpec: SkillSpec = {
  name: "PulseDigitalLine",
  description: "在一条或多条数字输出线上发一列 TTL 脉冲。Nanonis 就是这样触发**外部**硬件的 —— 一次相机曝光、一台脉冲发生器、一个斩波器、一个快门。MAST 并不知道线上接的是什么：对不熟悉的线，打脉冲之前先问用户。",
  parameters: [
    { name: "port", type: "int", description: "0=Port A，1=B，2=C，3=D，4+ = 扩展 DIO", required: true, minValue: 0, maxValue: 8 },
    { name: "lines", type: "str", description: "要打脉冲的数字线，1..8，逗号分隔（例如 '1' 或 '1,3'）", required: true },
    { name: "pulse_width_s", type: "float", description: "每个脉冲持续多久（s）", unit: "s", required: true, minValue: 0.000001, maxValue: 60 },
    { name: "pulse_pause_s", type: "float", description: "脉冲之间的间隔（s）", unit: "s", required: false, minValue: 0, maxValue: 60, default: 0.001 },
    { name: "n_pulses", type: "int", description: "脉冲个数", required: false, minValue: 1, maxValue: 10000, default: 1 },
    { name: "wait_until_finished", type: "bool", description: "阻塞直到整列脉冲发完", required: false, default: true },
  ],
  tags: ["output","digital","ttl","trigger","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetDigitalLineStatusSpec: SkillSpec = {
  name: "SetDigitalLineStatus",
  description: "把一条数字输出线置为 HIGH 或 LOW 并**保持**在那里（不像 PulseDigitalLine，那个会把它送回去）。用于需要锁存的使能 —— 一个一直开着的快门、一台一直开着的放大器。MAST 并不知道线上接的是什么，而且 abort 时它**不会**被复位：abort 只是让 MAST 停止写入，它不会去猜哪一个电平才叫「关」。",
  parameters: [
    { name: "port", type: "int", description: "0=Port A，1=B，2=C，3=D，4+ = 扩展 DIO", required: true, minValue: 0, maxValue: 8 },
    { name: "line", type: "int", description: "端口内的数字线，1..8", required: true, minValue: 1, maxValue: 8 },
    { name: "status", type: "bool", description: "True = HIGH，False = LOW", required: true },
  ],
  tags: ["output","digital","ttl","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureDigitalLineSpec: SkillSpec = {
  name: "ConfigureDigitalLine",
  description: "配置一条数字线的方向（输入／输出）与极性（高有效／低有效）。把一条线从输入翻成输出，就开始**驱动**另一端接着的任何东西 —— 先核对接线。",
  parameters: [
    { name: "line", type: "int", description: "数字线，1..8", required: true, minValue: 1, maxValue: 8 },
    { name: "port", type: "int", description: "0=Port A，1=B，2=C，3=D，4+ = 扩展 DIO", required: true, minValue: 0, maxValue: 8 },
    { name: "direction", type: "int", description: "0 = 输入，1 = 输出", required: true, minValue: 0, maxValue: 1 },
    { name: "polarity", type: "int", description: "0 = 低有效，1 = 高有效", required: true, minValue: 0, maxValue: 1 },
  ],
  tags: ["output","digital","ttl","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureBiasSweepSpec: SkillSpec = {
  name: "ConfigureBiasSweep",
  description: "配置 bias sweep 的上下限、步数与记录通道。",
  parameters: [
    { name: "lower_v", type: "float", description: "bias 下限，单位伏特", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "upper_v", type: "float", description: "bias 上限，单位伏特", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "num_steps", type: "int", description: "扫描的步数", required: true, minValue: 2, maxValue: 10000 },
    { name: "period_ms", type: "float", description: "每一步的积分周期，单位毫秒", unit: "ms", required: false, minValue: 0.1, default: 4 },
  ],
  tags: ["sweep","bias","configure","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AcquireBiasSweepSpec: SkillSpec = {
  name: "AcquireBiasSweep",
  description: "在当前针尖位置采一条 bias sweep。",
  parameters: [],
  preconditions: ["z_controller_on"],
  tags: ["sweep","bias","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureLockInSweepSpec: SkillSpec = {
  name: "ConfigureLockInSweep",
  description: "配置 lock-in 扫频的上下限与各项参数。",
  parameters: [
    { name: "lower_hz", type: "float", description: "频率下限，单位 Hz", unit: "Hz", required: true, minValue: 0 },
    { name: "upper_hz", type: "float", description: "频率上限，单位 Hz", unit: "Hz", required: true, minValue: 0 },
    { name: "num_steps", type: "int", description: "扫描的步数", required: true, minValue: 2, maxValue: 10000 },
    { name: "integration_periods", type: "int", description: "每一步的积分周期数", required: false, minValue: 1, default: 1 },
    { name: "settling_periods", type: "int", description: "每一步的建立（settling）周期数", required: false, minValue: 1, default: 1 },
  ],
  tags: ["sweep","lockin","frequency","configure","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AcquireLockInSweepSpec: SkillSpec = {
  name: "AcquireLockInSweep",
  description: "采一条 lock-in 扫频。",
  parameters: [],
  tags: ["sweep","lockin","frequency","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetLockInSweepLimitsSpec: SkillSpec = {
  name: "GetLockInSweepLimits",
  description: "读 lock-in 扫频的频率下限与上限。",
  parameters: [],
  tags: ["sweep","lockin","frequency","limits","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetLockInSweepPropsSpec: SkillSpec = {
  name: "GetLockInSweepProps",
  description: "读 lock-in 扫频的属性（步数、积分、建立）。",
  parameters: [],
  tags: ["sweep","lockin","frequency","props","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetLockInSweepSignalSpec: SkillSpec = {
  name: "GetLockInSweepSignal",
  description: "读 lock-in 扫频所用的扫描信号索引。",
  parameters: [],
  tags: ["sweep","lockin","frequency","signal","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GenSwpAcqChsGetSpec: SkillSpec = {
  name: "GenSwpAcqChsGet",
  description: "取 Generic Sweeper 记录的采集通道列表。",
  parameters: [],
  tags: ["sweep","generic","channels","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GenSwpPropsGetSpec: SkillSpec = {
  name: "GenSwpPropsGet",
  description: "取 Generic Sweeper 的配置属性。",
  parameters: [],
  tags: ["sweep","generic","props","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GenSwpStopSpec: SkillSpec = {
  name: "GenSwpStop",
  description: "停止当前正在运行的 Generic Sweeper 扫描。",
  parameters: [],
  tags: ["sweep","generic","stop","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GenSwpSwpSignalGetSpec: SkillSpec = {
  name: "GenSwpSwpSignalGet",
  description: "取 Generic Sweeper 的扫描信号名。",
  parameters: [],
  tags: ["sweep","generic","signal","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const OpenPatternExperimentSpec: SkillSpec = {
  name: "OpenPatternExperiment",
  description: "打开选定的网格实验。配置或启动该实验之前必须先做这一步。",
  parameters: [],
  tags: ["pattern","experiment","open","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const PausePatternExperimentSpec: SkillSpec = {
  name: "PausePatternExperiment",
  description: "暂停或恢复当前正在跑的网格实验。",
  parameters: [
    { name: "pause", type: "bool", description: "True 为暂停，False 为恢复", required: true },
  ],
  tags: ["pattern","experiment","pause","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPatternLineSpec: SkillSpec = {
  name: "SetPatternLine",
  description: "设定线图案的参数：点数与两个端点。",
  parameters: [
    { name: "set_active", type: "bool", description: "True 表示把当前图案切换成 Line", required: false, default: true },
    { name: "num_points", type: "int", description: "沿这条线的点数", required: true, minValue: 1, maxValue: 10000 },
    { name: "use_scan_frame", type: "bool", description: "True 表示把这条线设成扫描帧的对角线", required: false, default: false },
    { name: "p1_x_m", type: "float", description: "线上第 1 点的 X 坐标（m）", unit: "m", required: true },
    { name: "p1_y_m", type: "float", description: "线上第 1 点的 Y 坐标（m）", unit: "m", required: true },
    { name: "p2_x_m", type: "float", description: "线上第 2 点的 X 坐标（m）", unit: "m", required: true },
    { name: "p2_y_m", type: "float", description: "线上第 2 点的 Y 坐标（m）", unit: "m", required: true },
  ],
  tags: ["pattern","line","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPatternCloudSpec: SkillSpec = {
  name: "SetPatternCloud",
  description: "为点云图案谱学设定一组 XY 点。",
  parameters: [
    { name: "set_active", type: "bool", description: "True 表示把当前图案切换成 Cloud", required: false, default: true },
    { name: "x_coords", type: "str", description: "X 坐标，以 JSON 浮点数列表给出（m）", required: true },
    { name: "y_coords", type: "str", description: "Y 坐标，以 JSON 浮点数列表给出（m）", required: true },
  ],
  tags: ["pattern","cloud","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetPatternCloudSpec: SkillSpec = {
  name: "GetPatternCloud",
  description: "读为点云图案谱学配置好的那组 XY 点。",
  parameters: [],
  tags: ["pattern","cloud","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetPatternPropsSpec: SkillSpec = {
  name: "GetPatternProps",
  description: "读网格实验配置：可用的实验、选中的实验、外部 VI、测量前延时、保存通道。",
  parameters: [],
  tags: ["pattern","config","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ConfigureWaveformSpec: SkillSpec = {
  name: "ConfigureWaveform",
  description: "配置一台 Nanonis 函数发生器：幅度、频率，以及（仅 2 通道发生器）波形形状。它驱动的是 MAST 看不见的 EXTERNAL 硬件 —— 一路调制、一路 lock-in 参考、一个斩波器、一条栅极斜坡。配置不等于启动；之后还要调用 StartWaveform。",
  parameters: [
    { name: "generator", type: "str", description: "'1ch'（单通道）或 '2ch'（双通道）", required: true, allowedValues: ["1ch","2ch"] },
    { name: "amplitude", type: "float", description: "波形幅度，用该输出的物理单位", required: true },
    { name: "frequency_hz", type: "float", description: "1 通道发生器的频率（Hz）。2 通道发生器那边 Nanonis 收的是 PERIOD（s）—— 你传频率，它会被换算。", unit: "Hz", required: true, minValue: 0.000001, maxValue: 1000000 },
    { name: "channel", type: "int", description: "通道索引（仅 2 通道发生器）", required: false, minValue: 1, maxValue: 2, default: 1 },
    { name: "shape", type: "str", description: "sine/square/triangle/sawtooth/ramp（仅 2 通道）", required: false, allowedValues: ["sine","square","triangle","sawtooth","ramp"], default: "sine" },
    { name: "polarity", type: "int", description: "0 = 双极性，1 = 单极性（厂商约定）", required: false, minValue: 0, maxValue: 1, default: 0 },
    { name: "direction", type: "int", description: "0 = 先向上，1 = 先向下", required: false, minValue: 0, maxValue: 1, default: 0 },
  ],
  tags: ["output","function_generator","waveform","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StartWaveformSpec: SkillSpec = {
  name: "StartWaveform",
  description: "启动一台函数发生器，运行指定的周期数（0 = 一直跑到被停止）。先用 ConfigureWaveform 配置它。这会在一条输出线上放出一个真实信号 —— MAST 看不见另一端接的是什么。",
  parameters: [
    { name: "generator", type: "str", description: "'1ch' 或 '2ch'", required: true, allowedValues: ["1ch","2ch"] },
    { name: "periods", type: "int", description: "要运行的周期数；0 = 连续", required: false, minValue: 0, maxValue: 1000000, default: 0 },
    { name: "wait_until_finished", type: "bool", description: "阻塞直到这次 burst 结束（periods=0 时本项被忽略）", required: false, default: false },
  ],
  tags: ["output","function_generator","waveform","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StopWaveformSpec: SkillSpec = {
  name: "StopWaveform",
  description: "停止一台正在运行的函数发生器。STOP 永远是允许的 —— 对一路输出来说，这是你永远希望自己做得到的那件事。",
  parameters: [
    { name: "generator", type: "str", description: "'1ch' 或 '2ch'", required: true, allowedValues: ["1ch","2ch"] },
  ],
  tags: ["output","function_generator","stop"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetWaveformStatusSpec: SkillSpec = {
  name: "GetWaveformStatus",
  description: "读一台函数发生器的状态与当前设置（幅度 / 频率 / 形状 / idle 值）。启动一台不是你自己配置的发生器之前，先查一下。",
  parameters: [
    { name: "generator", type: "str", description: "'1ch' 或 '2ch'", required: true, allowedValues: ["1ch","2ch"] },
    { name: "channel", type: "int", description: "通道索引（仅 2 通道发生器）", required: false, minValue: 1, maxValue: 2, default: 1 },
  ],
  tags: ["output","function_generator","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetWaveformIdleValueSpec: SkillSpec = {
  name: "SetWaveformIdleValue",
  description: "设置函数发生器停止时保持的 IDLE 值。这是一条输出线的静息状态，所以它比听上去更要紧：外部硬件在两次 burst 之间、以及一次 StopWaveform 之后看到的就是它。它**不一定**就是「关」—— 那取决于你的接线，而接线 MAST 看不见。",
  parameters: [
    { name: "generator", type: "str", description: "'1ch' 或 '2ch'", required: true, allowedValues: ["1ch","2ch"] },
    { name: "idle_value", type: "float", description: "静息值，用该输出的物理单位", required: true },
    { name: "device", type: "int", description: "设备索引（仅 2 通道发生器）", required: false, minValue: 1, maxValue: 2, default: 1 },
  ],
  tags: ["output","function_generator","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetWaveformChannelOnOffSpec: SkillSpec = {
  name: "SetWaveformChannelOnOff",
  description: "启用或禁用 2 通道函数发生器中的一个通道，而不停掉另一个。",
  parameters: [
    { name: "channel", type: "int", description: "通道索引（1 或 2）", required: true, minValue: 1, maxValue: 2 },
    { name: "on", type: "bool", description: "True = 启用，False = 禁用", required: true },
  ],
  tags: ["output","function_generator","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSpectroscopyTtlSyncSpec: SkillSpec = {
  name: "SetSpectroscopyTtlSync",
  description: "让谱学在每一个点上给一条 TTL 线发脉冲 —— 泵浦激光、快门或光谱仪曝光就挂在这个钩子上。\n\n时间一律以 SECONDS 计。`time_to_on_s` 是从该点开始到线变为有效之间的延迟；`on_duration_s` 是它保持有效的时长。1 ms 就是 0.001 —— 传 1 会让这条线在扫描的每一个点上都保持整整一秒。\n\n设 line=0 即可 DISABLE 这个同步。先用 GetSTSTTLSync（bias）或 GetZSpectrTTLSync（Z）读回当前配置 —— 线号用的是 Nanonis 的编号，不是 MAST 的，脉冲发错线就会触发接在那条线上的任何东西。",
  parameters: [
    { name: "which", type: "str", description: "bias（bias 谱学）或 z（Z 谱学）", required: true, allowedValues: ["bias","z"] },
    { name: "line", type: "int", description: "TTL 线号（Nanonis 编号）。0 = 关掉该同步。", required: true, minValue: 0, maxValue: 8 },
    { name: "polarity", type: "str", description: "high_active（线拉高）或 low_active", required: false, allowedValues: ["low_active","high_active"], default: "high_active" },
    { name: "time_to_on_s", type: "float", description: "从该点开始到线变为有效之间的延迟，单位 SECONDS", unit: "s", required: false, minValue: 0, maxValue: 10, default: 0 },
    { name: "on_duration_s", type: "float", description: "线保持有效的时长，单位 SECONDS（1 ms = 0.001）", unit: "s", required: false, minValue: 0, maxValue: 10, default: 0.001 },
  ],
  tags: ["spectroscopy","sync","ttl","pump-probe","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSpectroscopyPulseSyncSpec: SkillSpec = {
  name: "SetSpectroscopyPulseSync",
  description: "设置谱学的数字线门控和/或它的脉冲序列同步。\n\n`digital_sync` 用一条数字线给扫描加门控。`pulse_sequence_nr` 在每一个谱学点上运行脉冲发生器里某个已编程的序列，运行 `pulse_periods` 个周期 —— 这就是隧道一侧做 pump-probe 延时扫描的机制。\n\n把其中任一项设为 0 即可关掉它。省略某个参数则保持它原样不动。",
  parameters: [
    { name: "which", type: "str", description: "bias 或 z", required: true, allowedValues: ["bias","z"] },
    { name: "digital_sync", type: "int", description: "数字同步线（0 = 关）—— 省略则保持不变", required: false, minValue: 0, maxValue: 8 },
    { name: "pulse_sequence_nr", type: "int", description: "脉冲序列编号（0 = 关）—— 省略则保持不变", required: false, minValue: 0, maxValue: 8 },
    { name: "pulse_periods", type: "int", description: "每个点上跑该序列多少个周期", required: false, minValue: 1, maxValue: 1000000, default: 1 },
  ],
  tags: ["spectroscopy","sync","pulse","pump-probe","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSpectroscopyZControlSpec: SkillSpec = {
  name: "SetSpectroscopyZControl",
  description: "配置谱学如何对待 Z 控制器：扫描前它要移到的 ALTERNATE SETPOINT，以及事后是否恢复 Z 偏移。\n\nalternate setpoint 是让你在与扫描时不同的（通常更近、电流更大的）针尖-样品间距上取谱的办法：环路先稳定到 `setpoint`，等待 `settling_time_s`，然后环路才断开、扫描才开始。\n\n**更近的 setpoint 意味着更小的间隙。** 决定反馈松手之前针尖靠得多近的，就是这个参数。把它抬到远高于扫描用的 setpoint 会把针尖往里推；再配上一段大范围的 bias 扫描，那就是在改造表面，而不是在测量它。\n\n`revert_z_offset` 会在事后恢复扫描前的 Z。除非你就是要针尖停在扫描结束时的位置，否则让它保持 ON。",
  parameters: [
    { name: "use_alternate_setpoint", type: "bool", description: "扫描前先移到一个 alternate Z setpoint", required: true },
    { name: "setpoint", type: "float", description: "alternate 的 Z 控制器 setpoint（电流，单位 A）", unit: "A", required: false, default: 0 },
    { name: "settling_time_s", type: "float", description: "断开之前，让环路在该值上稳定多久", unit: "s", required: false, minValue: 0, maxValue: 60, default: 0.1 },
    { name: "revert_z_offset", type: "bool", description: "事后恢复扫描前的 Z 偏移", required: false, default: true },
  ],
  tags: ["spectroscopy","sts","zcontroller","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetZSpectroscopySecondRetractSpec: SkillSpec = {
  name: "SetZSpectroscopySecondRetract",
  description: "给 Z 谱学加第二条（SECOND）retract 条件：当选定信号越过阈值时，中止扫描并退针。\n\n这是一个安全特性，而在此之前它一直是只读的。Z 扫描会在开环状态下把针尖推向表面 —— retract 条件就是在电流说「到了」的时候把它停住的那个东西，而不是等扫描走到量程尽头。\n\ncomparison：0 = 信号高于阈值时退针，1 = 低于阈值时退针。弄反了就意味着这个条件永远不会触发 —— 用 GetZSpectrRetract2nd 读回来核对。",
  parameters: [
    { name: "enable", type: "bool", description: "启用第二条 retract 条件", required: true },
    { name: "signal_index", type: "int", description: "要盯的信号（取自 ListSignalNames）", required: false, minValue: 0, maxValue: 127, default: 0 },
    { name: "threshold", type: "float", description: "阈值，用该信号自己的单位", required: false, default: 0 },
    { name: "comparison", type: "int", description: "0 = 高于阈值时退针，1 = 低于阈值时退针", required: false, minValue: 0, maxValue: 1, default: 0 },
  ],
  tags: ["spectroscopy","zspectr","retract","safety","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetMlsLockinPerSegmentSpec: SkillSpec = {
  name: "SetMlsLockinPerSegment",
  description: "按多线段（MLS）bias 谱学的每一个 SEGMENT 分别开关 lock-in，而不是对整条扫描一次性开关。\n\nMLS 让你在一条曲线里以不同速度扫不同的 bias 区间。这个开关让 lock-in（dI/dV）只在你想要的那些段里运行 —— 慢的、密的那些 —— 而不必拖着它的时间常数走完快的那些段。",
  parameters: [
    { name: "enable", type: "bool", description: "lock-in 按段分别配置（相对于对整条扫描统一配置）", required: true },
  ],
  tags: ["spectroscopy","mls","lockin","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const GetSpectroscopyStatusSpec: SkillSpec = {
  name: "GetSpectroscopyStatus",
  description: "查询 bias 谱学或 Z 谱学当前是不是正在 RUNNING。\n\n在此之前 MAST 只能以阻塞方式跑谱学 —— 启动，然后干等。有了它，你可以先启动再轮询：盯着电流、查中止标志、上报进度。一大片谱的网格于是从「只能等它跑完」变成了「可以盯着它跑」。",
  parameters: [
    { name: "which", type: "str", description: "bias | z | both", required: false, allowedValues: ["bias","z","both"], default: "both" },
  ],
  tags: ["spectroscopy","status","read","poll"],
  category: "read",
  safetyLevel: "AUTO",
}

export const QuitNanonisSpec: SkillSpec = {
  name: "QuitNanonis",
  description: "退出 Nanonis 软件。\n\n**它总是先停掉扫描、并把针尖退回来。** 在针尖仍处于工作状态时退出，会把它留在表面里、且没有任何软件盯着它 —— Z 反馈会随着进程一起死掉。如果退针无法被确认，这个技能会拒绝退出。\n\n它成功之后，MAST 与仪器的连接就没了，它关于仪器所相信的一切也不再为真。在 Nanonis 重启之前，别的什么都不会工作。\n\n这走的是 Nanonis 自己的优雅关闭流程，也是停止它的**正确**方式 —— 在事务进行到一半时强杀进程，会永久损坏 TCP 端口，反正也得重启 Nanonis 才能恢复。",
  parameters: [
    { name: "save_settings", type: "bool", description: "退出途中保存当前的设置／布局", required: false, default: true },
    { name: "settings_name", type: "str", description: "保存设置时用的名字（留空 = 当前那个）", required: false, default: "" },
    { name: "layout_name", type: "str", description: "保存布局时用的名字（留空 = 当前那个）", required: false, default: "" },
  ],
  tags: ["system","quit","advanced","dangerous"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const SetMultiPassSpec: SkillSpec = {
  name: "SetMultiPass",
  description: "打开或关闭多程扫描（multi-pass）。\n\n多程扫描会用不同的设置把同一条线扫上好几遍 —— 这是把形貌与静电／磁性信号分开的标准做法（第 1 程在反馈开启下记录形貌；第 2 程在某个抬升高度上、反馈关闭地重走一遍）。\n\n每一程各自的参数（偏压、Z 偏移、反馈开／关）在 Nanonis 界面里设定。把它打**开**，会让此后每一次扫描都要花 N 倍的时间。",
  parameters: [
    { name: "on", type: "bool", description: "启用多程扫描", required: true },
  ],
  tags: ["scan","multipass","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const LoadMultiPassConfigSpec: SkillSpec = {
  name: "LoadMultiPassConfig",
  description: "从 Nanonis 机器上的一个文件载入一份多程扫描配置。\n\n这个文件决定了**每一程**做什么 —— 它的偏压、它的 Z 偏移、反馈开不开。MAST 读不了这个文件，也没法告诉你它将要做什么。一份带着大幅负 Z 偏移、且反馈关闭的配置，会在每一次扫描的每一行上把针尖开进表面。\n\n请载入你自己写的配置。然后在扫描之前用 GetScanPatternConfig／Nanonis 界面把它读回来核对。",
  parameters: [
    { name: "file_path", type: "str", description: "**NANONIS 机器上**多程配置文件的路径", required: true },
  ],
  tags: ["scan","multipass","file","advanced","dangerous"],
  category: "write",
  safetyLevel: "DANGEROUS",
}

export const SaveMultiPassConfigSpec: SkillSpec = {
  name: "SaveMultiPassConfig",
  description: "把当前的多程扫描配置保存到 Nanonis 机器上的一个文件。它不改变仪器上的任何东西；它会覆盖给定路径上已有的文件。",
  parameters: [
    { name: "file_path", type: "str", description: "**NANONIS 机器上**的目标路径", required: true },
  ],
  tags: ["scan","multipass","file","advanced"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const WaitForScanEndBlockingSpec: SkillSpec = {
  name: "WaitForScanEndBlocking",
  description: "用 Nanonis 自己的等待，阻塞直到当前扫描结束。\n\n**你几乎肯定想要的是 WaitScanComplete** —— 轮询版的那个。它不占住连接，而且会报告进度。这一个是留给「你需要扫描结束的那个精确时刻、容忍不了一个轮询间隔的误差」的场合。\n\n它的代价：整段等待期间它**占住主 TCP 连接**，所以在它返回之前，那条连接上其他技能一个都跑不了。环境监控仍然工作（它走自己的端口）。\n\n**中止**：这段等待被切成 ~1 s 一段的 Nanonis 等待，两段之间夹一次 abort 检查，所以按下停止大约一秒内就会结束 —— 而且**不会**丢掉扫描结束的那个精确时刻（不论给它多长的 timeout，Nanonis 都会在扫描结束的瞬间返回）。它**不会**停掉扫描本身；它停的是「等它」这件事。\n\n那个 timeout 是一条真的界限，不是走过场：挑一个你等得起的。",
  parameters: [
    { name: "timeout_s", type: "float", description: "最长阻塞多久（在这段时间里主连接是不可用的）", unit: "s", required: true, minValue: 1, maxValue: 1800 },
  ],
  tags: ["scan","wait","blocking","advanced"],
  category: "read",
  safetyLevel: "CONFIRM",
}

export const SetWaveformSignalSpec: SkillSpec = {
  name: "SetWaveformSignal",
  description: "选定一个函数发生器通道**驱动哪一路信号**。\n\n这个参数决定了波形实际上在做什么。同样一个 1 V 正弦波，接在空闲输出上是无害的测试信号，接在隧道结上就是 1 V 的偏压调制 —— 发生器分不出这两者的区别。先用 GetMiscInstrumentConfig.fungen2_signal 读一下当前的指派。\n\n波形本身用 ConfigureWaveform 配置；用 StartWaveform 启动。",
  parameters: [
    { name: "channel", type: "int", description: "函数发生器通道（1 起算）", required: true, minValue: 1, maxValue: 2 },
    { name: "signal_index", type: "int", description: "该通道驱动的信号（来自 ListSignalNames）", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["fungen","waveform","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetLockInDemodPhaseRegisterSpec: SkillSpec = {
  name: "SetLockInDemodPhaseRegister",
  description: "设定某个锁相解调器参考**哪一个相位寄存器**。\n\n解调器的相位必须参考到产生该信号的那个调制上。指到错的寄存器不会失败 —— 它会把 X 转到 Y 里去，于是一条 dI/dV 就变成了一个看起来像 dI/dV、实际不是的东西。用 GetLockInConfig 读回来核对。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器编号（1 起算）", required: true, minValue: 1, maxValue: 8 },
    { name: "phase_register", type: "int", description: "相位寄存器序号", required: true, minValue: 0, maxValue: 8 },
  ],
  tags: ["lockin","demod","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetLockInFrequencySweepSignalSpec: SkillSpec = {
  name: "SetLockInFrequencySweepSignal",
  description: "选定锁相**频率扫描**扫的是哪一路信号。\n\n这个扫描会把你点名的东西在整个频率范围内驱动一遍 —— 找共振就是这么找的。点错信号，就是在驱动错的东西。当前值用 GetMiscInstrumentConfig.lockin_freqswp_signal 读。",
  parameters: [
    { name: "signal_index", type: "int", description: "要扫的信号（来自 ListSignalNames）", required: true, minValue: 0, maxValue: 127 },
  ],
  tags: ["lockin","sweep","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPllExcitationAddSpec: SkillSpec = {
  name: "SetPllExcitationAdd",
  description: "把 PLL 的激励信号叠加到它的输出上（或停止叠加）。\n\nAdd 开着时，调制器的激励会到达悬臂／音叉 —— 探针正在被**驱动**。关掉时，环仍然在跟踪，但什么都不驱动。当前状态用 GetPllConfig.add_on_off 读。",
  parameters: [
    { name: "modulator", type: "int", description: "调制器序号", required: true, minValue: 1, maxValue: 8 },
    { name: "add", type: "bool", description: "True = 激励会到达输出", required: true },
  ],
  tags: ["pll","excitation","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPllDemodHarmonicSpec: SkillSpec = {
  name: "SetPllDemodHarmonic",
  description: "设定某个 PLL 解调器锁到**第几次谐波**（1 = 基频）。\n\n更高次谐波携带的是关于针尖-样品相互作用的另一类信息，而一个锁在根本不存在的谐波上的解调器，会非常自信地报出噪声。用 GetPllConfig.demod_harmonic 读回来核对。",
  parameters: [
    { name: "demodulator", type: "int", description: "解调器序号", required: true, minValue: 1, maxValue: 8 },
    { name: "harmonic", type: "int", description: "谐波次数（1 = 基频）", required: true, minValue: 1, maxValue: 16 },
  ],
  tags: ["pll","demod","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ConfigureScopeTriggerSpec: SkillSpec = {
  name: "ConfigureScopeTrigger",
  description: "设定 1 通道示波器的触发：模式、沿、电平与迟滞。只读 —— 示波器做的是数字化，它不驱动任何东西。\n\n电平用的是被触发通道自己的物理单位。迟滞的作用，是让一路有噪声的信号不会在阈值附近每抖一下就重新触发一次。",
  parameters: [
    { name: "trigger_mode", type: "int", description: "0 = immediate，1 = level，2 = auto", required: false, minValue: 0, maxValue: 2, default: 1 },
    { name: "trigger_slope", type: "int", description: "0 = 下降沿，1 = 上升沿", required: false, minValue: 0, maxValue: 1, default: 1 },
    { name: "trigger_level", type: "float", description: "阈值，用该通道自己的单位", required: false, default: 0 },
    { name: "trigger_hysteresis", type: "float", description: "迟滞（防止在噪声上反复触发）", required: false, minValue: 0, default: 0 },
  ],
  tags: ["oscilloscope","trigger","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const SetPatternExperimentSpec: SkillSpec = {
  name: "SetPatternExperiment",
  description: "选定一个图案（网格／线／点云）在每个点上跑**哪一个实验**，外加文件基名与测量前延时。\n\n这个参数是把一组坐标变成一次测量的那一项。一个指向错误实验的网格会跑上几个小时，并在每一个点上产出错的东西 —— 而它此前是只读的（GetScanPatternConfig 看得见它；没有任何东西设得了它）。\n\n`pre_measure_delay_s` 是每个点测量之前的稳定时间；给短了，每条曲线都会拖着「走到这里」那段移动的尾巴。",
  parameters: [
    { name: "experiment", type: "int", description: "实验序号（每个点上跑哪一种测量）", required: true, minValue: 0, maxValue: 31 },
    { name: "basename", type: "str", description: "存盘数据的文件基名", required: false, default: "mast_pattern" },
    { name: "pre_measure_delay_s", type: "float", description: "每个点测量之前的稳定时间", unit: "s", required: false, minValue: 0, maxValue: 60, default: 0.1 },
    { name: "save_scan_channels", type: "bool", description: "每个点上同时保存扫描通道", required: false, default: false },
    { name: "external_vi_path", type: "str", description: "外部 VI 路径（不用就留空）", required: false, default: "" },
  ],
  tags: ["pattern","grid","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetPointShootPropsSpec: SkillSpec = {
  name: "SetPointShootProps",
  description: "配置 Follow-Me 的 point-and-shoot：测完之后扫描是否自动续跑、文件基名，以及测量前延时。\n\n`auto_resume` 是值得想一想的那一个。开着的话，每做完一次 point-and-shoot 测量扫描就会接着跑 —— 做普查时你要的正是这个，而如果那次测量可能改变了针尖，你要的就不是这个。",
  parameters: [
    { name: "auto_resume", type: "bool", description: "每次点测之后续跑扫描", required: true },
    { name: "basename", type: "str", description: "文件基名", required: false, default: "mast_ps" },
    { name: "use_own_basename", type: "bool", description: "用上面这个基名，而不是本次会话的基名", required: false, default: true },
    { name: "pre_measure_delay_s", type: "float", description: "每次测量之前的稳定时间", unit: "s", required: false, minValue: 0, maxValue: 60, default: 0.1 },
    { name: "external_vi_path", type: "str", description: "外部 VI 路径（不用就留空）", required: false, default: "" },
  ],
  tags: ["folme","point-and-shoot","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ReadTipOscillationAmplitudeSpec: SkillSpec = {
  name: "ReadTipOscillationAmplitude",
  description: "读取 qPlus 振荡振幅（OCD1 Amplitude 等通道）。可作为**独立于电流**的针尖状态判据：针尖接触表面后振幅会被阻尼到接近 0，退针后才恢复。没有 qPlus 的机器上返回 status='unavailable'（这不是故障）。",
  parameters: [
    { name: "signal_index", type: "int", description: "显式指定振幅信号索引；-1 = 按通道名自动查找。自动查找不到时返回 unavailable，不会猜一个索引。", required: false, default: -1 },
    { name: "set_baseline", type: "bool", description: "True = 把这次读数记为「自由振荡基线」。**只应在确认针尖未接触表面时调用**（进针前、或退针之后）。基线是撞针判据的分母。", required: false, default: false },
  ],
  tags: ["qplus","afm","read","tip"],
  category: "read",
  safetyLevel: "AUTO",
}

export const CheckTipCrashByAmplitudeSpec: SkillSpec = {
  name: "CheckTipCrashByAmplitude",
  description: "用 qPlus 振幅判断针尖是否已接触表面（撞针）。判据：振幅低于自由振荡基线的 10%。**这是对电流类判据的补充，不替代它们。**status ∈ ok|crash|unavailable|no_baseline —— 后两者是「判断不了」，不是「没撞」。",
  parameters: [
    { name: "signal_index", type: "int", description: "显式振幅信号索引；-1 = 自动查找。", required: false, default: -1 },
  ],
  tags: ["qplus","afm","crash","tip","safety"],
  category: "read",
  safetyLevel: "AUTO",
}

export const CheckPiezoRangeSpec: SkillSpec = {
  name: "CheckPiezoRange",
  description: "读扫描器真实的 XY/Z 压电量程，并与配置里的安全限值（SafetyLimits.xy_max_m）比对。报 ok / mismatch / unknown —— 从不改变任何东西。换过制冷剂、换过扫描器、或做过任何一次压电重标定之后都跑一下：配置里的量程比真实量程大，会让选点器提出针尖根本到不了的目标，接着那次移动会以一个重试也修不好的超时告终。",
  parameters: [
    { name: "tolerance_frac", type: "float", description: "相对差超过它就报 mismatch。出厂 0.02(2%) —— 比读数抖动大得多,比 2026-08-16 那次的 23% 小得多。", required: false, minValue: 0, maxValue: 1, default: 0.02 },
  ],
  tags: ["piezo","range","safety","read","selfcheck"],
  category: "read",
  safetyLevel: "AUTO",
}

export const BiasPulseWithReadbackSpec: SkillSpec = {
  name: "BiasPulseWithReadback",
  description: "发一个偏压脉冲，同时连续采集 Z 与电流，然后报告 Z 在脉冲前的稳定值与脉冲后的稳定值之间跳了多远、往哪个方向跳（脉冲进行中的瞬态不计）。当这一发脉冲的目的是修针、而你需要知道它到底有没有起作用时，用它而不是 BiasPulse。",
  parameters: [
    { name: "bias_v", type: "float", description: "脉冲电压。贵金属上修针通常用 ±10 V；更温和的做法用 ±3–7 V。", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "width_s", type: "float", description: "脉冲宽度（由硬件计时）", unit: "s", required: false, minValue: 0.001, maxValue: 2, default: 0.5 },
    { name: "z_hold", type: "int", description: "脉冲期间的 Z controller：0=不变，1=保持，2=不保持。默认 1 —— feedback 若还开着，一发脉冲会把电流抬高几个数量级，Z 会一路追着它直接扎进表面。", required: false, allowedValues: [0,1,2], default: 1 },
    { name: "absolute", type: "bool", description: "True=绝对偏压，False=相对当前值", required: false, default: true },
    { name: "poll_hz", type: "float", description: "目标逐帧轮询速率（每帧各采一次电流+Z；受 RTT 限制，每通道约 1 kHz 封顶）", unit: "Hz", required: false, minValue: 10, maxValue: 8000, default: 2000 },
    { name: "pre_roll_s", type: "float", description: "脉冲**之前**采集的基线（这就是 z1）", unit: "s", required: false, minValue: 0.01, maxValue: 5, default: 0.1 },
    { name: "post_roll_s", type: "float", description: "脉冲结束之后继续采集；它稳定下来的尾段就是 z3", unit: "s", required: false, minValue: 0.02, maxValue: 5, default: 0.3 },
    { name: "max_capture_s", type: "float", description: "整个采集窗口的硬上限", unit: "s", required: false, minValue: 0.2, maxValue: 30, default: 5 },
    { name: "jump_k", type: "float", description: "跳变灵敏度：|Δ| > median+k·σ_robust 即标记。8 是实测下不产生误报的下限。", required: false, minValue: 1, maxValue: 50, default: 8 },
    { name: "step_tol_nm", type: "float", description: "z3−z1 上的死区（nm）；tol = max(此值, step_tol_k·σ(baseline))。默认 0.5 nm：值得据以动作的脉冲台阶在几十 nm 量级。", unit: "nm", required: false, minValue: 0, maxValue: 1000, default: 0.5 },
    { name: "step_tol_k", type: "float", description: "若 step_tol_nm=0，则 tol = z1 基线的 k·σ", required: false, minValue: 1, maxValue: 50, default: 4 },
  ],
  capabilities: ["bias_pulse"],
  tags: ["bias","pulse","readback","z","tip","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const TipShapeWithReadbackSpec: SkillSpec = {
  name: "TipShapeWithReadback",
  description: "运行硬件 tip shaper，**同时**在流程进行中连续采集电流+Z，以捕捉针尖顶端发生变化时两路通道各自怎么跳（用的是 TipShaper_Start wait=0，所以轮询与动作是重叠进行的）。",
  parameters: [
    { name: "switch_off_delay_s", type: "float", description: "关闭 controller 之前对 Z 做平均的时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "change_bias", type: "bool", description: "在第一段 Z ramp 之前，把偏压跳变到 bias_v。**默认关闭**（2026-08-11）：workflow 层本来就拒绝这条路 —— TipShaper 只能**一步**改完偏压，而一步跳变本身就是一记冲击（_tip_phases.py）。请先自己把偏压设好（用带 slew rate 的 SetBias），再在这一项关闭的情况下扎针。", required: false, default: false },
    { name: "bias_v", type: "float", description: "第一段 Z ramp 之前的偏压（当 change_bias 开启时）。**省略**它则跟随**当前**的成像偏压 —— 也就是用户的参数组（2026-08-10）。没有 3 V 兜底：偏压若读不到，这个技能直接拒绝执行。", unit: "V", required: false, minValue: -10, maxValue: 10 },
    { name: "tip_lift_m", type: "float", description: "第一段 Z ramp（相对量），单位**米**。常用 ±2n，上限 ±100n（±100 nm）。", unit: "m", required: false, minValue: -1e-7, maxValue: 1e-7, default: 0 },
    { name: "lift_time_1_s", type: "float", description: "第一段 Z ramp 的时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "bias_lift_v", type: "float", description: "在第一段 Z ramp**刚结束之后**施加的偏压。⚠️ 与 bias_v 不同，这一项是**无条件**施加的 —— change_bias **不能**把它解除（厂商原文：'Bias (V) … if Change Bias is True' 对比 'Bias Lift (V) … applied just after the first Z ramping'）。**省略**它则跟随 bias_v，也就是当前的成像偏压。没有 3 V 兜底。", unit: "V", required: false, minValue: -10, maxValue: 10 },
    { name: "bias_settling_s", type: "float", description: "施加偏压值之后的等待时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "lift_height_m", type: "float", description: "第二段 Z ramp 的高度（也就是**退回来**的那一段），单位米。**省略**它则默认取 -tip_lift_m —— 扎进去 x，就拉回来 x，这是每个 composite 早已在用的规则。常用 1n..5e-9，上限 ±100n（±100 nm）。", unit: "m", required: false, minValue: -1e-7, maxValue: 1e-7 },
    { name: "lift_time_2_s", type: "float", description: "第二段 Z ramp 的时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "end_wait_s", type: "float", description: "恢复初始偏压之后的等待时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "restore_feedback", type: "bool", description: "结束时恢复 Z-controller 状态", required: false, default: true },
    { name: "timeout_ms", type: "int", description: "shaper 的超时（-1 = 永远等待）", unit: "ms", required: false, minValue: -1, default: -1 },
    { name: "poll_hz", type: "float", description: "目标逐帧轮询速率（每帧各采一次电流+Z；每通道有效速率 ≈ poll_hz，受 RTT 限制、~1 kHz 封顶）", unit: "Hz", required: false, minValue: 10, maxValue: 8000, default: 2000 },
    { name: "pre_roll_s", type: "float", description: "shaper 启动**之前**采集的基线", unit: "s", required: false, minValue: 0, maxValue: 5, default: 0.05 },
    { name: "post_roll_s", type: "float", description: "在估计的 shaper 结束时刻**之后**继续采集", unit: "s", required: false, minValue: 0, maxValue: 5, default: 0.1 },
    { name: "max_capture_s", type: "float", description: "整个采集窗口的硬上限（安全考虑）", unit: "s", required: false, minValue: 0.1, maxValue: 30, default: 5 },
    { name: "jump_k", type: "float", description: "跳变灵敏度：|Δ| > median+k·σ_robust 即标记", required: false, minValue: 1, maxValue: 50, default: 5 },
    { name: "indent_tol_nm", type: "float", description: "判定「扎入」用的 z3−z1 死区（nm）；tol = max(此值, indent_tol_k·σ(baseline))。默认 0.02 nm：低于原子团簇的尺度（~0.1–0.3 nm），高于 z 噪声。", unit: "nm", required: false, minValue: 0, maxValue: 100, default: 0.02 },
    { name: "indent_tol_k", type: "float", description: "若 indent_tol_nm=0，则 tol = z1 基线的 k·σ", required: false, minValue: 1, maxValue: 50, default: 4 },
  ],
  capabilities: ["tip_shaping"],
  tags: ["tip","shaper","readback","current","z","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const CaptureSignalBufferSpec: SkillSpec = {
  name: "CaptureSignalBuffer",
  description: "高速率采集单个 Nanonis 信号的时间序列。要亚毫秒 RTT 就用 channel='current'/'z'/'bias'；要走通用的 Signals_ValGet 路径就传信号索引字符串（'0'..'127'）（受 TCP Tap 限制，~50 Hz 封顶）。",
  parameters: [
    { name: "channel", type: "str", description: "快速路径用 'current' / 'z' / 'bias'；通用路径用数字信号索引 0-127。", required: false, default: "current" },
    { name: "duration_s", type: "float", description: "采集窗口，单位秒。", unit: "s", required: false, minValue: 0.01, maxValue: 60, default: 1 },
    { name: "poll_hz", type: "float", description: "目标轮询速率。受 TCP RTT 封顶（快速路径最高 ~2 kHz， Signals_ValGet 上 ~50 Hz）。", unit: "Hz", required: false, minValue: 1, maxValue: 4000, default: 1000 },
    { name: "include_samples", type: "bool", description: "为 True（默认）时返回完整样本列表。为 False 时只返回 min/max/mean/std + 长度。", required: false, default: true },
  ],
  tags: ["signal","capture","stream","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetChamberPressureSpec: SkillSpec = {
  name: "GetChamberPressure",
  description: "读取腔体压强(Pa)并给出**粗动互锁裁决**:现在能不能动粗动马达,以及理由。\n在中间真空区(约 0.1–1000 Pa = 1e-3–10 mbar,Paschen 极小值附近)给粗动压电加几百伏会打火击穿叠堆 —— 抽气和放气途中正好穿过这个区间。\n**allow=false 时不要重试粗动**:这是硬闸门,不是建议。读不到真空计也会是 false(读不到 ≠ 真空好);那种情况需要用户在界面上签署一次「当前气压安全」,你不能替他签。",
  parameters: [],
  tags: ["vacuum","pressure","read","safety","coarse"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetTemperatureSpec: SkillSpec = {
  name: "GetTemperature",
  description: "读当前温度(K)，带**读数年龄**和**出处**。只读，不碰仪器。\n`value_k` 为 null 时看 `reason`,三种「读不到」含义完全不同、要做的事相反:\n  • `no_sensor` —— 这台机器没有温度计,**等下去永远等不到**,别轮询;\n  • `unavailable` —— 有温度计但此刻不给数(常见:串口被别的程序占着),可以等,并请用户看端口;\n  • `no_source` —— MAST 这一侧没接上,与仪器无关。\n`age_s` 是这个读数多旧(秒);**`age_s` 为 null 表示不知道多旧,不是刚读的**。要判「够不够新」就传 `max_age_s`,结果里的 `freshness` 会给 fresh/stale/unknown 三态。\n多个温度通道时默认取样品台(SPM/stage/sample/tip/cryo);磁体杜瓦的温度**不等于**样品台的温度,要哪个就用 `channel` 指名(名字见 `available_channels`)。",
  parameters: [
    { name: "channel", type: "str", description: "指名读哪个温度通道（传感器名，如 'SPM' / 'Magnet'）。不传 = 自动选样品台优先的那个。名字见结果里的 available_channels。", required: false },
    { name: "max_age_s", type: "float", description: "多旧算旧（秒）。传了才会给 freshness 判定；**不传就不判** —— 这个阈值只有调用方知道，这里不替你拍一个默认值。", unit: "s", required: false, minValue: 0 },
  ],
  tags: ["temperature","environment","read","cryo"],
  category: "read",
  safetyLevel: "AUTO",
}

export const AcquireSTSSpec: SkillSpec = {
  name: "AcquireSTS",
  description: "在当前针尖位置采一条 STS 谱。使用当前的 lock-in 与 bias 扫描设置。传 save_basename 可以控制保存下来的 .dat 文件名（为了可追溯 —— 例如按网格点命名）。",
  parameters: [
    { name: "save_basename", type: "str", description: "保存下来的谱文件的基名（留空 = 沿用模块当前的基名）。它让网格/批量测量能把每一个 .dat 与它的坐标对应起来。", required: false, default: "" },
  ],
  preconditions: ["z_controller_on"],
  tags: ["spectroscopy","sts","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureSTSSpec: SkillSpec = {
  name: "ConfigureSTS",
  description: "配置 STS 的 bias 扫描参数。",
  parameters: [
    { name: "start_v", type: "float", description: "扫描起始电压，单位伏特", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "end_v", type: "float", description: "扫描终止电压，单位伏特", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "num_points", type: "int", description: "扫描的点数", required: true, minValue: 2, maxValue: 10000 },
    { name: "z_offset_m", type: "float", description: "谱学期间的 Z 偏移，单位米", unit: "m", required: false, default: 0 },
  ],
  tags: ["spectroscopy","sts","configure","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureZSpectrSpec: SkillSpec = {
  name: "ConfigureZSpectr",
  description: "配置 Z 谱学：Z 偏移、扫描距离与点数。",
  parameters: [
    { name: "z_offset_m", type: "float", description: "Z 偏移，单位米", unit: "m", required: true },
    { name: "z_sweep_distance_m", type: "float", description: "Z 扫描距离，单位米", unit: "m", required: true, minValue: 0 },
    { name: "num_points", type: "int", description: "扫描的点数", required: true, minValue: 2, maxValue: 10000 },
    { name: "backward_sweep", type: "bool", description: "启用反扫", required: false, default: true },
  ],
  tags: ["spectroscopy","z","configure","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AcquireZSpectrSpec: SkillSpec = {
  name: "AcquireZSpectr",
  description: "在当前针尖位置采一条 Z 谱。",
  parameters: [],
  preconditions: ["z_controller_on"],
  tags: ["spectroscopy","z","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureSTSTimingSpec: SkillSpec = {
  name: "ConfigureSTSTiming",
  description: "配置 Bias Spectroscopy 的时序参数。",
  parameters: [
    { name: "z_avg_time_s", type: "float", description: "Z 平均时间", unit: "s", required: true, minValue: 0 },
    { name: "z_offset_m", type: "float", description: "Z 偏移", unit: "m", required: false, default: 0 },
    { name: "init_settling_s", type: "float", description: "初始建立时间", unit: "s", required: true, minValue: 0 },
    { name: "max_slew_rate_v_s", type: "float", description: "最大压摆率", unit: "V/s", required: true, minValue: 0 },
    { name: "settling_s", type: "float", description: "每点的建立时间", unit: "s", required: true, minValue: 0 },
    { name: "integration_s", type: "float", description: "每点的积分时间", unit: "s", required: true, minValue: 0 },
    { name: "end_settling_s", type: "float", description: "结束时的建立时间", unit: "s", required: false, minValue: 0, default: 0 },
    { name: "z_ctrl_time_s", type: "float", description: "Z 控制时间", unit: "s", required: false, minValue: 0, default: 0 },
  ],
  tags: ["spectroscopy","sts","timing","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StopSTSSpec: SkillSpec = {
  name: "StopSTS",
  description: "停止当前的 Bias Spectroscopy 测量。",
  parameters: [],
  tags: ["spectroscopy","sts","stop"],
  category: "write",
  safetyLevel: "AUTO",
}

export const StopZSpectrSpec: SkillSpec = {
  name: "StopZSpectr",
  description: "停止当前的 Z Spectroscopy 测量。",
  parameters: [],
  tags: ["spectroscopy","z","stop"],
  category: "write",
  safetyLevel: "AUTO",
}

export const ConfigureSTSChannelsSpec: SkillSpec = {
  name: "ConfigureSTSChannels",
  description: "设置 Bias Spectroscopy 期间记录哪些通道。",
  parameters: [
    { name: "channel_indexes", type: "str", description: "逗号分隔的通道索引（0-23）", required: true },
  ],
  tags: ["spectroscopy","sts","channels","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const ConfigureZSpectrTimingSpec: SkillSpec = {
  name: "ConfigureZSpectrTiming",
  description: "配置 Z Spectroscopy 的时序参数。",
  parameters: [
    { name: "z_avg_time_s", type: "float", description: "Z 平均时间", unit: "s", required: true, minValue: 0 },
    { name: "init_settling_s", type: "float", description: "初始建立时间", unit: "s", required: true, minValue: 0 },
    { name: "max_slew_rate_v_s", type: "float", description: "最大压摆率", unit: "V/s", required: true, minValue: 0 },
    { name: "settling_s", type: "float", description: "每点的建立时间", unit: "s", required: true, minValue: 0 },
    { name: "integration_s", type: "float", description: "每点的积分时间", unit: "s", required: true, minValue: 0 },
    { name: "end_settling_s", type: "float", description: "结束时的建立时间", unit: "s", required: false, minValue: 0, default: 0 },
    { name: "z_ctrl_time_s", type: "float", description: "Z 控制时间", unit: "s", required: false, minValue: 0, default: 0 },
  ],
  tags: ["spectroscopy","z","timing","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetSTSChannelsSpec: SkillSpec = {
  name: "GetSTSChannels",
  description: "取 Bias Spectroscopy 记录的通道列表。",
  parameters: [],
  tags: ["spectroscopy","sts","channels","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetSTSChannelsSpec: SkillSpec = {
  name: "SetSTSChannels",
  description: "设置 Bias Spectroscopy 记录的通道。",
  parameters: [
    { name: "channel_indexes", type: "str", description: "通道索引（0-127），逗号分隔，例如 '0, 1, 2'", required: true },
  ],
  tags: ["spectroscopy","sts","channels","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetSTSLimitsSpec: SkillSpec = {
  name: "GetSTSLimits",
  description: "取 Bias Spectroscopy 的 bias 电压范围。",
  parameters: [],
  tags: ["spectroscopy","sts","limits","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetSTSAdvancedPropsSpec: SkillSpec = {
  name: "SetSTSAdvancedProps",
  description: "设置 Bias Spectroscopy 的高级属性。",
  parameters: [
    { name: "reset_bias", type: "int", description: "扫描后复位 bias（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
    { name: "z_controller_hold", type: "int", description: "扫描期间保持 Z 控制器（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
    { name: "record_final_z", type: "int", description: "记录最终的 Z（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
    { name: "lockin_run", type: "int", description: "扫描期间运行 Lock-In（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
  ],
  tags: ["spectroscopy","sts","advanced","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetSTSTimingSpec: SkillSpec = {
  name: "GetSTSTiming",
  description: "取 Bias Spectroscopy 的时序参数。",
  parameters: [],
  tags: ["spectroscopy","sts","timing","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSTSAltZCtrlSpec: SkillSpec = {
  name: "GetSTSAltZCtrl",
  description: "取 Bias Spectroscopy 的备用 Z 控制器设置。",
  parameters: [],
  tags: ["spectroscopy","sts","zctrl","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZSpectrChannelsSpec: SkillSpec = {
  name: "GetZSpectrChannels",
  description: "取 Z Spectroscopy 记录的通道列表。",
  parameters: [],
  tags: ["spectroscopy","z","channels","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetZSpectrChannelsSpec: SkillSpec = {
  name: "SetZSpectrChannels",
  description: "设置 Z Spectroscopy 记录的通道。",
  parameters: [
    { name: "channel_indexes", type: "str", description: "通道索引（0-127），逗号分隔，例如 '0, 1, 2'", required: true },
  ],
  tags: ["spectroscopy","z","channels","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetZSpectrRangeSpec: SkillSpec = {
  name: "GetZSpectrRange",
  description: "取 Z Spectroscopy 的量程设置。",
  parameters: [],
  tags: ["spectroscopy","z","range","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetZSpectrRangeSpec: SkillSpec = {
  name: "SetZSpectrRange",
  description: "设置 Z Spectroscopy 的量程。",
  parameters: [
    { name: "z_offset_m", type: "float", description: "Z 偏移，单位米", unit: "m", required: true },
    { name: "z_sweep_distance_m", type: "float", description: "Z 扫描距离，单位米", unit: "m", required: true, minValue: 0 },
  ],
  tags: ["spectroscopy","z","range","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetZSpectrRetractSpec: SkillSpec = {
  name: "GetZSpectrRetract",
  description: "取 Z Spectroscopy 的自动退针配置。",
  parameters: [],
  tags: ["spectroscopy","z","retract","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetZSpectrRetractSpec: SkillSpec = {
  name: "SetZSpectrRetract",
  description: "设置 Z Spectroscopy 的自动退针条件。",
  parameters: [
    { name: "enabled", type: "int", description: "启用退针（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
    { name: "threshold", type: "float", description: "退针的阈值", required: true },
    { name: "signal_index", type: "int", description: "阈值所用的信号索引（-1=不改）", required: true },
    { name: "comparison", type: "int", description: "比较运算符（0=>，1=<，2=不改）", required: true, minValue: 0, maxValue: 2 },
  ],
  tags: ["spectroscopy","z","retract","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetSTSDigSyncSpec: SkillSpec = {
  name: "GetSTSDigSync",
  description: "取 Bias Spectroscopy 的数字同步模式（Off/TTL/PulseSeq）。",
  parameters: [],
  tags: ["spectroscopy","sts","digsync","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSTSTTLSyncSpec: SkillSpec = {
  name: "GetSTSTTLSync",
  description: "取 Bias Spectroscopy 的 TTL 同步配置。",
  parameters: [],
  tags: ["spectroscopy","sts","ttlsync","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSTSPulseSeqSyncSpec: SkillSpec = {
  name: "GetSTSPulseSeqSync",
  description: "取 Bias Spectroscopy 的脉冲序列同步配置。",
  parameters: [],
  tags: ["spectroscopy","sts","pulseseq","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSTSZOffRevertSpec: SkillSpec = {
  name: "GetSTSZOffRevert",
  description: "取 Bias Spectroscopy 的 Z Offset Revert 标志。",
  parameters: [],
  tags: ["spectroscopy","sts","zoffrevert","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetSTSMLSLockinPerSegSpec: SkillSpec = {
  name: "GetSTSMLSLockinPerSeg",
  description: "取 MLS 模式下的 Lock-In per Segment 标志。",
  parameters: [],
  tags: ["spectroscopy","sts","mls","lockin","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetSTSMLSModeSpec: SkillSpec = {
  name: "SetSTSMLSMode",
  description: "设置 Bias Spectroscopy 的扫描模式：Linear 或 MLS。",
  parameters: [
    { name: "mode", type: "str", description: "'Linear' 或 'MLS'", required: true, allowedValues: ["Linear","MLS"] },
  ],
  tags: ["spectroscopy","sts","mls","mode","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSTSMLSValsSpec: SkillSpec = {
  name: "SetSTSMLSVals",
  description: "设置 Bias Spectroscopy MLS 模式的多线段配置。",
  parameters: [
    { name: "bias_start_v", type: "str", description: "每段的起始 bias（V），逗号分隔，例如 '-1.0, 0.5'", required: true },
    { name: "bias_end_v", type: "str", description: "每段的终止 bias（V），逗号分隔", required: true },
    { name: "initial_settling_s", type: "str", description: "每段的初始建立时间（s），逗号分隔", required: true },
    { name: "settling_s", type: "str", description: "每段的建立时间（s），逗号分隔", required: true },
    { name: "integration_s", type: "str", description: "每段的积分时间（s），逗号分隔", required: true },
    { name: "steps", type: "str", description: "每段的步数，逗号分隔的整数", required: true },
    { name: "lockin_run", type: "str", description: "每段的 Lock-In 运行标志（0=Off，1=On），逗号分隔", required: true },
  ],
  tags: ["spectroscopy","sts","mls","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetSTSSafeCond1Spec: SkillSpec = {
  name: "SetSTSSafeCond1",
  description: "[DEPRECATED —— Nanonis 里 Bias Spectroscopy 没有 safe-condition API；它总是失败。请改用 Z 谱学的 SetZSpectrRetract。] 设置 Bias Spectroscopy 的第一条 safe condition。",
  parameters: [
    { name: "condition", type: "int", description: "动作：0=不改，1=Off，2=Reverse，3=Stop", required: true, minValue: 0, maxValue: 3 },
    { name: "threshold", type: "float", description: "阈值（NaN=不改）", required: true },
    { name: "signal_index", type: "int", description: "信号索引（0-127，-1=不改）", required: true },
    { name: "comparison", type: "int", description: "0=高于，1=低于，2=不改", required: true, minValue: 0, maxValue: 2 },
  ],
  tags: ["spectroscopy","sts","safecond","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetSTSSafeCond1Spec: SkillSpec = {
  name: "GetSTSSafeCond1",
  description: "[DEPRECATED —— Nanonis 里 Bias Spectroscopy 没有 safe-condition API；它总是失败。请改用 Z 谱学的 GetZSpectrRetract。] 取 Bias Spectroscopy 的第一条 safe condition。",
  parameters: [],
  tags: ["spectroscopy","sts","safecond","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetSTSSafeCond2Spec: SkillSpec = {
  name: "SetSTSSafeCond2",
  description: "[DEPRECATED —— Nanonis 里 Bias Spectroscopy 没有 safe-condition API；它总是失败。请改用 Z 谱学的第二条 retract（GetZSpectrRetract2nd）。] 设置 Bias Spectroscopy 的第二条 safe condition。",
  parameters: [
    { name: "condition", type: "int", description: "逻辑：-1=不改，0=Off，1=OR，2=AND，3=THEN", required: true, minValue: -1, maxValue: 3 },
    { name: "threshold", type: "float", description: "阈值（NaN=不改）", required: true },
    { name: "signal_index", type: "int", description: "信号索引（0-127，-1=不改）", required: true },
    { name: "comparison", type: "int", description: "0=高于，1=低于，2=不改", required: true, minValue: 0, maxValue: 2 },
  ],
  tags: ["spectroscopy","sts","safecond","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const SetZSpectrAdvPropsSpec: SkillSpec = {
  name: "SetZSpectrAdvProps",
  description: "设置 Z Spectroscopy 的高级属性。",
  parameters: [
    { name: "time_between_sweeps_s", type: "float", description: "正扫与反扫之间的时间（s）", unit: "s", required: true, minValue: 0 },
    { name: "record_final_z", type: "int", description: "记录最终的 Z（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
    { name: "lockin_run", type: "int", description: "运行 Lock-In（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
    { name: "reset_z", type: "int", description: "扫描后复位 Z（0=不改，1=On，2=Off）", required: true, minValue: 0, maxValue: 2 },
  ],
  tags: ["spectroscopy","z","advanced","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetZSpectrDigSyncSpec: SkillSpec = {
  name: "GetZSpectrDigSync",
  description: "取 Z Spectroscopy 的数字同步模式（Off/TTL/PulseSeq）。",
  parameters: [],
  tags: ["spectroscopy","z","digsync","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZSpectrPulseSeqSyncSpec: SkillSpec = {
  name: "GetZSpectrPulseSeqSync",
  description: "取 Z Spectroscopy 的脉冲序列同步配置。",
  parameters: [],
  tags: ["spectroscopy","z","pulseseq","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZSpectrRetract2ndSpec: SkillSpec = {
  name: "GetZSpectrRetract2nd",
  description: "取 Z Spectroscopy 的第二条自动退针条件。",
  parameters: [],
  tags: ["spectroscopy","z","retract","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SetZSpectrRetractDelaySpec: SkillSpec = {
  name: "SetZSpectrRetractDelay",
  description: "设置 Z Spectroscopy 中正扫与反扫之间的退针延迟（s）。",
  parameters: [
    { name: "retract_delay_s", type: "float", description: "退针延迟，单位秒", unit: "s", required: true, minValue: 0 },
  ],
  tags: ["spectroscopy","z","retract","delay","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const GetZSpectrTTLSyncSpec: SkillSpec = {
  name: "GetZSpectrTTLSync",
  description: "取 Z Spectroscopy 的 TTL 同步配置。",
  parameters: [],
  tags: ["spectroscopy","z","ttlsync","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const GetZSpectrTimingSpec: SkillSpec = {
  name: "GetZSpectrTiming",
  description: "取 Z Spectroscopy 的时序参数。",
  parameters: [],
  tags: ["spectroscopy","z","timing","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ExtractClustersSpec: SkillSpec = {
  name: "ExtractClusters",
  description: "把一张已保存的 .sxm 里**所有**团簇分割出来，以**列表**返回，每一个带几何量 + 真实 xy 坐标 + 峰高。**半张图也照样能用**（只吃已经扫完整的那些行）。找到什么就返回什么，线状伪影也一并返回 —— 挑哪一个、怎么判，是调用方的事。配合 AssessClusterRoundness 用 —— 注意**它是另一套分割，不是这一套的封装**：它按 `mean ± threshold_sigma × std`（默认 1.5σ，plane_subtract 之后）切，这里按 `median ± 3×σ_MAD`（默认 RAW）切，**同一帧会得到不同的 blob**；或者自己写「圆 且 大 且 高」的合取。",
  parameters: [
    { name: "scan_path", type: "str", description: "已保存的那张 .sxm 的路径。", required: true },
    { name: "channel", type: "str", description: ".sxm 头里的通道名（默认 Z）。", required: false, default: "Z" },
    { name: "polarity", type: "str", description: "bright | dark | auto。auto 两侧都试，留下**更紧凑**的那一侧，并把两侧的证据都报出来 —— 同一批帧里两种极性都出现过，所以这件事写不死。", required: false, allowedValues: ["auto","bright","dark"], default: "auto" },
    { name: "threshold_mad", type: "float", description: "分割阈值，单位是 MAD-sigma。UNCALIBRATED。", required: false, minValue: 0.5, maxValue: 20, default: 3 },
    { name: "level", type: "str", description: "分割**之前**的平场。'none'（默认）= RAW，用户要的就是这个。'plane' = 减掉**一个**全局平面。**逐行**平场不提供，传进来直接拒绝：它吃掉的正是我们要找的那一种团簇。", required: false, allowedValues: ["none","plane"], default: "none" },
    { name: "tilt_warn_ratio", type: "float", description: "残余平面的峰谷值超过这么多倍噪声 sigma 时告警（「这一帧没调平，RAW 阈值可能不可靠」）。NOT CALIBRATED（未标定）—— 到目前为止还没有观察到任何一帧因此失败。", required: false, minValue: 0, maxValue: 100000, default: 20 },
    { name: "min_area_px", type: "int", description: "比这更小的连通域丢掉。UNCALIBRATED；它存在的意义是**让列表可读**（真机上有一帧给出 326 个连通域），**不是**用来做分辨的。", required: false, minValue: 1, maxValue: 100000, default: 4 },
    { name: "max_clusters", type: "int", description: "最多返回这么多个，按面积从大到小。", required: false, minValue: 1, maxValue: 10000, default: 50 },
  ],
  tags: ["scan","analysis","cluster","extract","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessClusterRoundnessSpec: SkillSpec = {
  name: "AssessClusterRoundness",
  description: "把一张小 .sxm 里扎出来的那个团簇坑分割出来，说出它有多圆。主输出是 equivalent_axis_ratio ∈ (0,1]：「这个团簇的不规则程度，相当于一个短轴/长轴等于该比值的椭圆」—— 1.0 = 完美圆盘；由于像素化本底已经被减掉，它在任何团簇尺寸上含义都一样。is_round 是一个**合取**（CONJUNCTION：equivalent_axis_ratio 与二阶矩长宽比两条都要过），团簇小到判不了时它是 null —— **不是 false**。",
  parameters: [
    { name: "scan_path", type: "str", description: "那张团簇坑 .sxm 扫描图的路径。", required: true },
    { name: "threshold_sigma", type: "float", description: "一个像素要高出局部均值多少个标准差，才算进团簇。越大越严。", required: false, minValue: 0.5, maxValue: 5, default: 1.5 },
    { name: "polarity", type: "str", description: "'bright' 对应向上的凸包（多数金属团簇），'dark' 对应一个坑，'auto' 用两个极端里更大的那一侧。⚠️ 'auto' 在大团簇上会翻:簇占的像素多过背景时选中背景。评刚扎出来的簇一律传 'bright'(2026-08-15 实测:auto 选暗侧 9 张,用户逐帧独立判错 9 张,p < 0.0001)。", required: false, default: "auto" },
    { name: "threshold_mode", type: "str", description: "'sigma'(出厂,向后兼容)= mean + threshold_sigma×std ——**自指**:簇越大 std 越大、阈值越高、切掉的簇越多。'physical' = 背景**众数** + physical_threshold_pm,用外部标尺,与簇多大无关。一百针实测:sigma 模式下同一个「1.5σ」切在离背景 136–655 pm(四分位);physical 在用户标「阈值不够低」的 13 张上多切出 5.9× 面积。", required: false, default: "sigma" },
    { name: "physical_threshold_pm", type: "float", description: "threshold_mode='physical' 时,高出背景多少算团簇(pm)。出厂 117.7 = **半个 Au(111) 单原子台阶**(235.4 pm = a/√3)。这是外部标尺不是拟合值 —— 换材料要换这个数。", required: false, minValue: 1, maxValue: 5000, default: 117.7 },
    { name: "shape_mode", type: "str", description: "'boundary'(出厂)= 二值化后量边界像素到质心的径向离散 ——**阈值以上每一点的高度全被丢掉**,结果由阈值切在哪儿决定。'weighted' = 高度加权二阶矩,每点按高出背景多少计权。阈值挪 ±20% 时轴比变化:boundary 0.0532 / weighted 0.0125;在用户标「阈值不够低」的 13 张上 0.2451 / 0.0084(稳 29 倍)。两个数**永远都报**(weighted_axis_ratio / boundary_axis_ratio),这个开关只决定谁驱动 is_round。", required: false, default: "boundary" },
    { name: "channel", type: "str", description: "通道名（默认 'Z'）。", required: false, default: "Z" },
    { name: "select", type: "str", description: "一帧里有好几坨时，评的是哪一坨：'largest'（默认）或 'center' —— 后者是离帧中心最近的那一坨，也就是调用方刚刚在它把这次扫描对准的那个点上扎出来的坑。一轮修针会留下好几个坑，而最大的那个往往是更早留下的。", required: false, allowedValues: ["largest","center"], default: "largest" },
    { name: "min_axis_ratio", type: "float", description: "圆到什么程度才算够圆，用**等效轴比**（EQUIVALENT AXIS RATIO）表述：0.75 的意思是「不比一个长短轴相差 25% 的椭圆更不规则」。它是从边界的 r(theta) 相对离散读出来的（已减掉像素化本底），所以在任何团簇尺寸上含义都一样。它**取代** round_threshold=0.65 —— 那个阈值所在的标度上，任何圆都够不着（见模块 docstring）；两个数**不可比**。", required: false, minValue: 0, maxValue: 1, default: 0.75 },
    { name: "min_aspect", type: "float", description: "二阶矩长宽比的下限，也就是这个合取的**另一半**。它抓的是单纯的拉长 —— 而那件事 r(theta) 离散看得没这么清（实测 d' 6.9 对 3.2）；反过来，瓣和缺口这类被二阶矩判成完美圆的形状，靠离散来抓（d' 0.1 对 17.8）。**两条都要过** —— 一条轴上的高分**不能**去补另一条轴上的低分。", required: false, minValue: 0, maxValue: 1, default: 0.6 },
  ],
  tags: ["scan","analysis","cluster","roundness","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const SelectPokedClusterSpec: SkillSpec = {
  name: "SelectPokedCluster",
  description: "从一帧可能有很多团簇的图里，挑出**我们刚扎的那一个**。先跑 ExtractClusters，再过一道合取（圆 且 大 且 高），然后取离扎针坐标最近的那个。容差之内一个都没有时**弃权**（selected=null）—— 「我找到的最近的东西」不是一个答案。每一个阈值都**必填、没有默认值**：拒绝替人猜数，正是这一层的意义所在。",
  parameters: [
    { name: "scan_path", type: "str", description: "已保存的那张 .sxm 的路径。", required: true },
    { name: "min_aspect", type: "float", description: "筛掉线状伪影。**必填，没有默认值**。目前实测的箱子(RAW 口径,n=4 真值 / 405 候选,单次会话,2026-08-10 真机):长宽比 ∈ [0.20, 0.60]、像素数 ∈ [5, 132]、峰高 ∈ [50, 365] pm —— 箱内任意组合都判对 4/4 且零误判。**推荐工作点 (0.35, 40, '150p')**。要自己量:用 ExtractClusters 跑一批**你自己的**帧,对**全部**连通域(不要只挑典型反例)算分布,再取空档。", required: true, minValue: 0, maxValue: 1 },
    { name: "min_area_px", type: "int", description: "连通域的最小面积。**必填，没有默认值**。注意：在参照那批数据上，这一条几乎**不承担分辨力**（下界取到 5 就已经零误判）—— 而这恰恰是「把它调松了也没人会注意到」的原因。目前实测的箱子(RAW 口径,n=4 真值 / 405 候选,单次会话,2026-08-10 真机):长宽比 ∈ [0.20, 0.60]、像素数 ∈ [5, 132]、峰高 ∈ [50, 365] pm —— 箱内任意组合都判对 4/4 且零误判。**推荐工作点 (0.35, 40, '150p')**。要自己量:用 ExtractClusters 跑一批**你自己的**帧,对**全部**连通域(不要只挑典型反例)算分布,再取空档。", required: true, minValue: 1, maxValue: 1000000 },
    { name: "min_peak_height_m", type: "float", description: "最小峰高。**必填，没有默认值**。这一条才是真正分得开的那一维（现场判据：主要看高度）。目前实测的箱子(RAW 口径,n=4 真值 / 405 候选,单次会话,2026-08-10 真机):长宽比 ∈ [0.20, 0.60]、像素数 ∈ [5, 132]、峰高 ∈ [50, 365] pm —— 箱内任意组合都判对 4/4 且零误判。**推荐工作点 (0.35, 40, '150p')**。要自己量:用 ExtractClusters 跑一批**你自己的**帧,对**全部**连通域(不要只挑典型反例)算分布,再取空档。", unit: "m", required: true, minValue: 0, maxValue: 0.000001 },
    { name: "anchor_tolerance_m", type: "float", description: "离扎针点多近才算「我们扎的那一个」。**必填，没有默认值**。扎针坐标由**刚扎完的那个调用方**提供(它知道自己扎在哪);留空则退回帧中心 —— 只有当扫描框确实对准了扎针点时那才等价。容差实测 '3n'(= 3 纳米)(系统性 0.54 nm + 3×散布 0.96 nm,n=4);偏移方向张角 302°,说明主导项是质心噪声而不是热漂移。", unit: "m", required: true, minValue: 0, maxValue: 0.000001 },
    { name: "near_x_m", type: "float", description: "扎针点的 X。不填 → 退回帧中心。扎针坐标由**刚扎完的那个调用方**提供(它知道自己扎在哪);留空则退回帧中心 —— 只有当扫描框确实对准了扎针点时那才等价。容差实测 '3n'(= 3 纳米)(系统性 0.54 nm + 3×散布 0.96 nm,n=4);偏移方向张角 302°,说明主导项是质心噪声而不是热漂移。", unit: "m", required: false },
    { name: "near_y_m", type: "float", description: "扎针点的 Y。不填 → 退回帧中心。", unit: "m", required: false },
    { name: "channel", type: "str", description: "通道名（默认 Z）。", required: false, default: "Z" },
    { name: "polarity", type: "str", description: "原样透传给 ExtractClusters。", required: false, allowedValues: ["auto","bright","dark"], default: "auto" },
    { name: "level", type: "str", description: "原样透传。默认 RAW。上面那个箱子是在 RAW 下量出来的 —— 你改了这个，那几个阈值就不再是当初量出来的那几个了。", required: false, allowedValues: ["none","plane"], default: "none" },
  ],
  tags: ["scan","analysis","cluster","select","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const VerifyAdatomAtSpec: SkillSpec = {
  name: "VerifyAdatomAt",
  description: "读一帧已保存的 .sxm,判断给定目标位置上有没有一个吸附原子,并给出最近团簇到目标的残差。只读文件,不碰硬件。verdict 取 'at_target' / 'ambiguous' / 'displaced' / 'not_found' / 'undecidable'。目标不在这一帧的范围内时是'undecidable' —— 那是**这一帧答不了**,不是「原子不在」。容差留空则取衬底最近邻距离的一半,也就是「同一个晶格位」。",
  parameters: [
    { name: "scan_path", type: "str", description: "复扫帧的 .sxm 路径。", required: true },
    { name: "target_x_m", type: "float", description: "目标位置 x,例如 '12.5n'(SI 前缀必须写)。", unit: "m", required: true, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "target_y_m", type: "float", description: "目标位置 y,例如 '-3n'。", unit: "m", required: true, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "tolerance_m", type: "float", description: "算「到位」的半径,例如 '150p'。留空则取衬底最近邻距离的一半。", unit: "m", required: false, minValue: 1e-11, maxValue: 5e-9 },
    { name: "channel", type: "str", description: "形貌通道。", required: false, default: "Z" },
    { name: "polarity", type: "str", description: "原子是亮的还是暗的。", required: false, allowedValues: ["auto","bright","dark"], default: "bright" },
    { name: "min_peak_height_m", type: "float", description: "比这更矮的团簇不算原子,例如 '30p'。留空则不按高度筛。", unit: "m", required: false, minValue: 1e-12, maxValue: 5e-9 },
    { name: "expected_count", type: "int", description: "这一帧里预期有几个原子(对不上只给 warning)。", required: false, minValue: 0, maxValue: 1000 },
  ],
  tags: ["analysis","cluster","atom","manipulation","scan","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const MeasureStepHeightSpec: SkillSpec = {
  name: "MeasureStepHeight",
  description: "从一张带台阶的 .sxm 量**单原子台阶高度** —— 用内点阈随噪声底自适应的稳健平面拟合调平,台阶因此被保留而不是被当成斜坡减掉。这是 **Z 压电标定的基准**(Au(111) d111 = 235.455 pm)。\n\n**别用 SubtractPlane_RANSAC 去斜再自己量**:那个技能的内点阈写死100 pm,在原子级平整的表面上几乎所有点都算内点,RANSAC 退化成普通最小二乘。2026-08-26 合成对照:它把台阶低估 30–51%,噪声越大错得越离谱。\n\n**它不做理论值归一化** —— 报出来的就是测到的峰间距。要不要跟 d111比是调用方的事。正扫与反扫**分开报**,两者之差是 Z 反馈滞后的直接读数(扫得越快差越大),想要标定就该把它压到接近 0 再取值。\n\n只读文件、不碰硬件。",
  parameters: [
    { name: "scan_path", type: "str", description: "要分析的 .sxm 文件路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道('Z' 是标准选择)。", required: false, default: "Z" },
    { name: "sigma_pm", type: "float", description: "覆盖自适应内点阈所用的噪声尺度(pm)。**留空是默认路径** —— 由 noise_floor 自己量。只有当表面自身的精细结构(如 Au(111) 的herringbone,~20 pm)让内点率掉到 0.2 以下时才手动给一个,取值应在噪声底与台阶高度之间。", required: false, minValue: 0.01, maxValue: 10000 },
    { name: "min_gap_pm", type: "float", description: "只报告间距 ≥ 这个值的台面对(pm)。用来滤掉同一台面的肩部,**不是**用来把答案往某个理论值上靠。", required: false, minValue: 1, maxValue: 100000, default: 120 },
    { name: "max_gap_pm", type: "float", description: "只报告间距 ≤ 这个值的台面对(pm),用来滤掉跨多层的大跳变。默认 400 pm 覆盖到常见金属的单层台阶(Au 235 / Cu 209 / Ag 236 / Si(111) 314)。要量多层就调大它。", required: false, minValue: 1, maxValue: 100000, default: 400 },
  ],
  tags: ["scan","step","height","calibration","z","analysis","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessFrameTrustSpec: SkillSpec = {
  name: "AssessFrameTrust",
  description: "对一张 .sxm 报**逐行跳动 σ**：逐行中位高度的行间差分标准差，一个尽量减少地形影响的针尖稳定性指标。只读文件，不碰硬件。\n\n判断针尖稳定性应优先使用逐行指标，避免单独用 RMS 或长宽比。地形起伏会直接影响 RMS，而针尖跳变会使整行整体抬落。参考系统观测支持这一边界，但尚未在本仓独立验证。\n\n**晶格结论可不可信不归它管**：调用 `AssessAtomicResolution` 并检查 reasons（`peaks_are_ridges` / `not_a_lattice` / `scale_gate`）。",
  parameters: [
    { name: "scan_path", type: "str", description: "要评估的 .sxm 路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道（'Z' 是标准选择）。", required: false, default: "Z" },
    { name: "direction", type: "str", description: "'forward' 或 'backward'。", required: false, default: "forward" },
  ],
  tags: ["analysis","tip","quality","针尖","stability","trust"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const LocateStepEdgeSpec: SkillSpec = {
  name: "LocateStepEdge",
  description: "在一张 .sxm 的形貌通道里找出最主要的那道台阶边,报出边上一点的扫描坐标与边的方向。只读文件,不碰硬件。verdict 取 'step_edge' / 'no_step' / 'undecidable'。一帧里分不出两个够大的台面、或者边不直(弯边、几道台阶叠在一起),就回 undecidable —— 编出来的一条边会让整排谱落在错地方,而每条谱都会「成功」。角度同时给图像坐标与扫描坐标两个版本。",
  parameters: [
    { name: "scan_path", type: "str", description: ".sxm 扫描文件路径。", required: true },
    { name: "channel", type: "str", description: "用哪一路通道,形貌一般是 Z。", required: false, default: "Z" },
    { name: "direction", type: "str", description: "用正扫还是反扫的那一幅。", required: false, allowedValues: ["forward","backward"], default: "forward" },
    { name: "edge_sigma", type: "float", description: "边候选的门限:比梯度中位数高出这么多个稳健 σ(缺省 6)。调小能找到更弱的边,代价是噪声更容易冒充台阶。", required: false, minValue: 1, maxValue: 50 },
    { name: "max_curvature", type: "float", description: "边界像素离拟合直线的 RMS 距离上限,以帧短边为单位(0.06 = 6%)。超过就判 undecidable。", required: false, minValue: 0.005, maxValue: 0.5 },
  ],
  tags: ["analysis","step","terrace","edge","geometry","scan","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessAtomicLinesSpec: SkillSpec = {
  name: "AssessAtomicLines",
  description: "对正在进行的扫描中**已经扫完**的那些线打分，看有没有规则的起伏（就是用户说的「看看扫描线」这一步）。返回的是一条 ADVISORY —— **单条线分不出 2-D 晶格与 1-D 波纹**；下判定的仍然是 AssessAtomicResolution。它读 Z 通道（实测比电流灵敏 2.6-4x），而且**不用停扫**就能做，所以一轮只花几十秒，而不是一帧 6.6-minute。",
  parameters: [
    { name: "direction", type: "int", description: "1 = 正扫，0 = 反扫（与 .sxm 的 forward / backward 对应）。", required: false, minValue: 0, maxValue: 1, default: 1 },
    { name: "n_recent_lines", type: "int", description: "只给最近扫出来的这么多行打分；0 = 全部已扫出的行。打磨环里要的是**刚扫的那几行**，整帧的中位会被扰动之前那些行拖住。", required: false, minValue: 0, maxValue: 4096, default: 0 },
    { name: "advisory_snr", type: "float", description: "建议线。出厂值 80 来自参考系统的一组小样本观测，尚未在本仓独立验证；它只建议不否决。", required: false, minValue: 1, maxValue: 100000, default: 80 },
    { name: "channel_index", type: "int", description: "强行指定信号索引（不是缓冲位）。-1 = 自己去 Scan_BufferGet 找 Z。填错的通道会得到一个对不齐的回包。", required: false, minValue: -1, maxValue: 127, default: -1 },
  ],
  tags: ["atomic","scan","line","advisory","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessFrameCorrugationSpec: SkillSpec = {
  name: "AssessFrameCorrugation",
  description: "量一帧已保存的 .sxm 里表面起伏有多大,再拿它跟样品 profile 的上限比。只读文件,不碰硬件。verdict 取 'high' / 'normal' / 'low' / 'undecidable' 之一,它是一个**观察**,**不是**针尖结论:一簇台阶给出的起伏和一根坏针尖一样大,所以单帧分不开这两者。到底是**针尖**还是**表面**,要靠换到别的位置复测再聚合来回答(aggregate_cross_points)。'undecidable' 的意思是**这一帧答不了** —— 帧不可用、它的视野与阈值标定时的视野对不上(**从来不做**跨尺度换算)、或者根本还没有标定过阈值。'low' 的意思是这一帧太平,连正反扫判据也承载不了,于是判据**弃权**。阈值与它标定时所用的视野是**一组**:要么都传,要么都不传。",
  parameters: [
    { name: "scan_path", type: "str", description: ".sxm 帧的路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道('Z' 是标准选择)。", required: false, default: "Z" },
    { name: "profile", type: "str", description: "样品阈值 profile 的名字。留空就用当前生效的那一个。", required: false, default: "" },
    { name: "threshold_pm", type: "float", description: "起伏上限,单位**皮米**(就写一个普通数字,例如 40 表示 40 pm)。留空则从样品 profile 里取 —— 这里**刻意没有 default**:没传的阈值必须保持「没传」,查 profile 那一行才到得了。你要是传了这个数,就**必须(MUST)**同时把 ref_scan_nm 也传上;一个不带标定视野的阈值毫无意义,只会得到 'undecidable'。", required: false, minValue: 0.1, maxValue: 1000000 },
    { name: "ref_scan_nm", type: "float", description: "threshold_pm 是在多大的扫描尺寸上标定的,单位**纳米**(就写一个普通数字,例如 100 表示 100 nm)。只有和 threshold_pm 一起给才有意义。这一帧自己的扫描尺寸与它相差超过容差时,判定就是 'undecidable' —— 起伏**绝不(NEVER)**跨视野换算。", required: false, minValue: 0.1, maxValue: 100000 },
    { name: "rel_tol", type: "float", description: "拿这一帧的扫描尺寸去对 ref_scan_nm 时的相对容差。0.05 足以覆盖用户输入 100 nm 而实际得到 99.98 的情况。", required: false, minValue: 0, maxValue: 0.5, default: 0.05 },
  ],
  tags: ["tip","corrugation","surface","analysis","read","scan"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessScanTextureSpec: SkillSpec = {
  name: "AssessScanTexture",
  description: "量一帧 .sxm 上晶格起伏有多强（逐方向，皮米）、逐行条纹噪声有多强（同单位，可直接与晶格比），以及把帧切成小块后有多少块的晶格压得住其余结构。回答的是「有多好、哪一块好」，**不回答「有没有原子分辨」** —— 那是 AssessAtomicResolution 的事。",
  parameters: [
    { name: "scan_path", type: "str", description: "要分析的 .sxm 文件路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道名，默认 Z。", required: false, default: "Z" },
    { name: "tile_nm", type: "float", description: "分块的边长，纳米。默认 4 nm —— 它不是阈值而是几何选择：块里至少要装下 8 个晶格周期，装不下就整个不给块图。", unit: "nm", required: false, minValue: 0.5, maxValue: 100, default: 4 },
    { name: "good_ratio", type: "float", description: "一块算「晶格清楚」的比值门槛（晶格带幅值 / 同块其余结构幅值）。**刻意没有默认值**：0.6 来自参考系统的一组观测（好帧 0.77-1.41、条纹区 0.10-0.35），尚未在本仓独立验证，换体系必须重标。不传时仍给出逐块比值与中位数，只是不给「好块占比」。", required: false, minValue: 0, maxValue: 10 },
  ],
  tags: ["scan","quality","lattice","analysis","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const MeasureLatticeCellSpec: SkillSpec = {
  name: "MeasureLatticeCell",
  description: "从一批原子分辨 .sxm 量出表面的实空间原胞 a₁ / a₂ / γ —— **不需要事先知道晶格常数**（那正是 CalibratePiezoFromLattice 要而这里不要的东西）。给上扫与下扫两个方向的帧时，慢轴漂移在 a₂ 上的应变会被抵消，并顺带给出漂移速率。同时检验半序位置有没有超结构，带空白对照。",
  parameters: [
    { name: "scan_paths", type: "str", description: "一个或多个 .sxm 路径，逗号或换行分隔。**上扫与下扫都给**才能消掉慢轴漂移（文件头的 SCAN_DIR 自动分组，不用手工标）。", required: true },
    { name: "channel", type: "str", description: "形貌通道名，默认 Z。", required: false, default: "Z" },
    { name: "min_indexed", type: "int", description: "一帧要被计入平均，它选出的基矢至少要指标上这么多个观测峰。默认 3 = 「除了它们自己，至少还有一个峰印证」。设成 2 会放进「只解释了自己」的帧，那种帧上「a₂ 被报成一半」查不出来。", required: false, minValue: 2, maxValue: 8, default: 3 },
    { name: "superstructure", type: "bool", description: "是否做半序超结构检验（带空白对照）。默认做。", required: false, default: true },
  ],
  tags: ["lattice","analysis","read","calibration"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessAtomicResolutionSpec: SkillSpec = {
  name: "AssessAtomicResolution",
  description: "判断一张已保存的 .sxm 帧上有没有原子分辨。只读，不碰仪器。核心判据是**角向集中度** —— 真晶格在倒空间是离散布拉格点、针尖抖动是弥散环（实测：真晶格 97-7645，带通抖动 1.8-3.3）。「FFT 里有个峰」不够：峰强度类判据分不开准周期抖动，30 个抖动种子全部产生了合格谱峰。verdict 三态：atomic / absent / undetermined。**undetermined 是「这一帧回答不了」**（像素太粗、视场太大、帧不完整），不是「针尖不好」—— 换个尺度重扫，别据此去修针。",
  parameters: [
    { name: "scan_path", type: "str", description: "要判的 .sxm 帧路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道，通常是 'Z'。", required: false, default: "Z" },
    { name: "surface", type: "str", description: "已知表面名（如 'Au(111)'），用来把测到的周期与理论值比对。留空则只报测量值不做比对。", required: false, default: "" },
    { name: "concentration_min", type: "float", description: "角向集中度下限；不填用模块默认", required: false, minValue: 1, maxValue: 100000 },
    { name: "allow_reduced_scale", type: "bool", description: "放宽尺度门：0.02–0.05 nm/px 的帧也允许给正面结论。默认不放 —— 在那个尺度上「有原子相」这句话的证据强度撑不住一次针尖验收。", required: false, default: false },
  ],
  tags: ["atomic","resolution","fft","analysis","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AnalyseAtomicLatticeSpec: SkillSpec = {
  name: "AnalyseAtomicLattice",
  description: "从一张原子分辨的 .sxm 帧里量出晶格：三个方向的周期、六重对称是否成立、晶格取向；给了 surface 就与理论值比对并报偏差。只读。**默认 surface='Au(111)'，所以不填参数时它就是 Au(111) 的专用分析；填别的表面名就是通用的**（表在 vision.lattice_calibration.SURFACE_LATTICE_NM）。⚠️ 报的周期是**二维谱峰位置**给的，不是一维快扫投影 —— 后者取决于晶格与扫描方向的夹角，同一块样品换个角度扫就变。⚠️ 三个方向的周期**本该相等**，不等的程度就是扫描器的畸变，要定标去用 CalibratePiezoFromLattice。",
  parameters: [
    { name: "scan_path", type: "str", description: "要分析的 .sxm 帧路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道。", required: false, default: "Z" },
    { name: "surface", type: "str", description: "表面名。默认 Au(111)。传 'none' 则只报测量值、不与任何理论值比对。", required: false, default: "Au(111)" },
    { name: "allow_reduced_scale", type: "bool", description: "把同名开关透传给前置的原子相判别。**没有它，0.02–0.05 nm/px 的帧只剩「整道关闸」一条路** —— 而这台机器最常用的 8 nm/256 px 正是 0.03125 nm/px，每一帧都落在里面。用了它，`scale_reduced` 会作为警告跟着结果走，而不是被拿去换掉整道闸。", required: false, default: false },
    { name: "require_atomic", type: "bool", description: "先跑原子相判别，没通过就拒绝出数。默认开 —— 在没有原子相的帧上量周期，量到的是针尖抖动的周期，而那个数看起来完全正常。", required: false, default: true },
  ],
  tags: ["atomic","lattice","fft","analysis","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const LoadScanFrameFromFileSpec: SkillSpec = {
  name: "LoadScanFrameFromFile",
  description: "从一个**已保存**的 .sxm 文件中，抽出某一路通道的正扫与反扫 2-D 帧，各写成一个 .npy；返回的是两个**路径**（绝不返回数组本身）。它是 GrabScanFrameData 的离线对应版 —— 后者只能读实时缓冲。这两个路径可以直接喂给 CheckLineQuality、或任何接受 .npy 的判据。若该通道或反扫方向不存在，它会**大声报错** —— 绝不拿另一路通道来顶替。",
  parameters: [
    { name: "scan_path", type: "str", description: "已保存的 .sxm 文件的路径", required: true },
    { name: "channel", type: "str", description: "通道名，按 .sxm 头里写的那样，例如 'Z'（形貌）。通道不存在 = 报错，并列出这个文件里实际有哪些通道。", required: false, default: "Z" },
    { name: "save_dir", type: "str", description: "可选：输出目录；默认 = <data>/experiments/frames/", required: false, default: "" },
  ],
  tags: ["scan","frame","read","offline","sxm"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const ParseRegionsSpec: SkillSpec = {
  name: "ParseRegions",
  description: "解析 + 校验一个由扫描区域组成的 JSON 数组（每个形如 {center_x_m, center_y_m, width_m, height_m, [angle_deg], [label]}），转成 composite 可以 foreach 遍历的归一化列表。坏 JSON、>64 个区域、中心/尺寸越界，都会被拒绝。",
  parameters: [
    { name: "regions", type: "str", description: "由区域对象组成的 JSON 数组（单位米）", required: true },
  ],
  tags: ["scan","regions","analysis","g1"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const ComputeDriftVectorSpec: SkillSpec = {
  name: "ComputeDriftVector",
  description: "抓取当前的扫描帧，与一张参考 .npy 图像做互相关，以估计样品漂移；结果以**米**为单位返回（drift_x_m, drift_y_m）。漂移跟踪类 workflow 会用到它。",
  parameters: [
    { name: "ref_path", type: "str", description: "参考图像 .npy 的路径（2-D）", required: true },
    { name: "scan_width_m", type: "float", description: "扫描框宽度，单位米（用于 px→m 换算）", unit: "m", required: true, minValue: 0 },
    { name: "channel_index", type: "int", description: "从哪一路通道抓取当前帧", required: false, minValue: 0, default: 0 },
    { name: "direction", type: "int", description: "1 = 正扫，0 = 反扫", required: false, allowedValues: [0,1], default: 1 },
  ],
  tags: ["scan","drift","analysis","g1"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const SubtractPlane_RANSACSpec: SkillSpec = {
  name: "SubtractPlane_RANSAC",
  description: "RANSAC-robust plane subtraction for STM images. Rejects outliers (molecules, steps) during plane fit.",
  parameters: [
    { name: "image_path", type: "str", description: "Path to a scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: false, default: "" },
    { name: "residual_threshold", type: "float", description: "RANSAC inlier threshold in meters", unit: "m", required: false, minValue: 1e-15, maxValue: 0.000001, default: 1e-10 },
    { name: "max_trials", type: "int", description: "Maximum RANSAC iterations", required: false, minValue: 10, maxValue: 10000, default: 100 },
  ],
  tags: ["analysis","processing","plane","ransac","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const LevelLines_MedianSpec: SkillSpec = {
  name: "LevelLines_Median",
  description: "Line-by-line leveling using median subtraction or polynomial fit per row.",
  parameters: [
    { name: "image_path", type: "str", description: "Path to a scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: false, default: "" },
    { name: "method", type: "str", description: "Leveling method: 'median' or 'poly'", required: false, allowedValues: ["median","poly"], default: "median" },
    { name: "poly_order", type: "int", description: "Polynomial order (only for method='poly')", required: false, minValue: 0, maxValue: 5, default: 1 },
  ],
  tags: ["analysis","processing","leveling","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const FindEmptySpotSpec: SkillSpec = {
  name: "FindEmptySpot",
  description: "Find the flattest/emptiest region in a scan image. Returns center coordinates of the smoothest sub-region.",
  parameters: [
    { name: "image_path", type: "str", description: "Path to a scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: true },
    { name: "grid_n", type: "int", description: "Grid subdivision (NxN cells)", required: false, minValue: 2, maxValue: 16, default: 4 },
    { name: "scan_width_m", type: "float", description: "Scan frame width in meters", unit: "m", required: false, default: 1e-7 },
    { name: "scan_height_m", type: "float", description: "Scan frame height in meters", unit: "m", required: false, default: 1e-7 },
  ],
  tags: ["analysis","region","heuristic","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const CorrectDrift_XCorrSpec: SkillSpec = {
  name: "CorrectDrift_XCorr",
  description: "Estimate translational drift between two images using phase cross-correlation.",
  parameters: [
    { name: "ref_path", type: "str", description: "Path to the reference scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: true },
    { name: "target_path", type: "str", description: "Path to the target scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: true },
    { name: "upsample_factor", type: "int", description: "Sub-pixel accuracy factor", required: false, minValue: 1, maxValue: 1000, default: 10 },
    { name: "window", type: "bool", description: "Pre-condition each image (DC removal + 2-D Hanning window) before correlating. Suppresses edge leakage that biases the shift. Default on.", required: false, default: true },
    { name: "normalization", type: "str", description: "Cross-correlation normalization. 'none' = standard normalized cross-correlation (robust to SPM line-noise/stripes); 'phase' = skimage phase correlation (sharper but whitens noise). Default 'none'.", required: false, allowedValues: ["none","phase"], default: "none" },
  ],
  tags: ["analysis","drift","cross-correlation","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const SubtractPoly2DSpec: SkillSpec = {
  name: "SubtractPoly2D",
  description: "Subtract 2D polynomial background from STM images. For curved substrates where plane subtraction is insufficient.",
  parameters: [
    { name: "image_path", type: "str", description: "Path to a scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: true },
    { name: "order_x", type: "int", description: "Polynomial order in X direction", required: false, minValue: 1, maxValue: 6, default: 2 },
    { name: "order_y", type: "int", description: "Polynomial order in Y direction", required: false, minValue: 1, maxValue: 6, default: 2 },
    { name: "mask_path", type: "str", description: "Path to boolean mask (.npy). True pixels excluded from fit", required: false, default: "" },
  ],
  tags: ["analysis","background","polynomial","image_processing","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const Destripe_MorphOpenSpec: SkillSpec = {
  name: "Destripe_MorphOpen",
  description: "Remove horizontal stripes from STM images using morphological opening with dual-threshold detection.",
  parameters: [
    { name: "image_path", type: "str", description: "Path to a scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: true },
    { name: "hard_threshold", type: "float", description: "Definite stripe threshold (in std units)", required: false, minValue: 1, maxValue: 10, default: 3 },
    { name: "soft_threshold", type: "float", description: "Candidate stripe threshold (in std units)", required: false, minValue: 0.5, maxValue: 5, default: 1.5 },
    { name: "min_length", type: "int", description: "Minimum consecutive stripe rows to keep", required: false, minValue: 1, maxValue: 50, default: 5 },
  ],
  tags: ["analysis","filter","destripe","image_processing","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AutoCrop_UnscannedRegionSpec: SkillSpec = {
  name: "AutoCrop_UnscannedRegion",
  description: "Detect and crop solid-color (unscanned) borders from an STM image. Block-based and tolerant of scalebar/crosshair overlays; iterates so removing one border can reveal another. Saves the cropped array to a new .npy and never overwrites the input.",
  parameters: [
    { name: "image_path", type: "str", description: "Path to a scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: true },
    { name: "tolerance", type: "float", description: "Solid-region flatness threshold: max deviation from a row/column median (in data units) to count as the same value. If omitted, defaults to 2% of the image peak-to-peak range.", required: false, minValue: 0 },
    { name: "max_iter", type: "int", description: "Maximum crop refinement passes (removing one border can reveal another).", required: false, minValue: 1, maxValue: 20, default: 3 },
    { name: "save_path", type: "str", description: "Optional .npy destination for the cropped array. Defaults to '<input>_cropped.npy'. Forced off the input path so the original is never overwritten.", required: false, default: "" },
  ],
  tags: ["analysis","crop","unscanned","preprocessing","image_processing","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const Denoise_AESpec: SkillSpec = {
  name: "Denoise_AE",
  description: "Denoise STM images using convolutional autoencoder. Falls back to Gaussian filter without model weights.",
  parameters: [
    { name: "image_path", type: "str", description: "Path to the noisy scan image (.npy/.npz/.sxm/.txt/.csv; .sxm uses the Z/topography channel)", required: true },
    { name: "model_path", type: "str", description: "Path to trained autoencoder weights (.pth)", required: false, default: "" },
    { name: "gaussian_sigma", type: "float", description: "Sigma for Gaussian fallback filter", required: false, minValue: 0.1, maxValue: 10, default: 1 },
  ],
  tags: ["analysis","denoise","autoencoder","image_processing","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const DetectAtomJumpSpec: SkillSpec = {
  name: "DetectAtomJump",
  description: "Detect atom jump from manipulation current trace. CNN-based with statistical fallback.",
  parameters: [
    { name: "current_trace", type: "str", description: "Current trace as a JSON array, or a path to trace data (.npy/.dat/.txt/.csv; .3ds grid is flattened to per-pixel spectra)", required: true },
    { name: "model_path", type: "str", description: "Path to trained CNN weights (.pth)", required: false, default: "" },
    { name: "threshold", type: "float", description: "Jump detection threshold (for statistical fallback)", required: false, minValue: 1, maxValue: 10, default: 3 },
  ],
  tags: ["analysis","atom_manipulation","cnn","paper"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const ScanAtSpec: SkillSpec = {
  name: "ScanAt",
  description: "在某个位置扫一帧。你给的是**扫哪**（中心）和**多大**（尺寸）—— 那才是意图。扫描速度、分辨率、反馈增益和默认 setpoint 由用户的分尺度策略表**确定性地**选出；**它们不是你的知识，所以不要传**。只有用户自己点了名的那个值，才把对应的可选参数传进来。**这是成像的首选方式**：一次调用就完成配置、设分辨率、启动、等待。**不要**把它拆成 ConfigureScan + SetScanSpeed + StartScan。",
  parameters: [
    { name: "center_x_m", type: "float", description: "扫描中心 X，单位 METERS（SI），**不是纳米**。换算：100 nm → 100n。", unit: "m", required: true, minValue: -0.001, maxValue: 0.001 },
    { name: "center_y_m", type: "float", description: "扫描中心 Y，单位 METERS（SI），**不是纳米**。换算：100 nm → 100n。", unit: "m", required: true, minValue: -0.001, maxValue: 0.001 },
    { name: "size_m", type: "float", description: "帧的边长，单位 METERS（SI），**不是纳米**。换算：100 nm → 100n，50 nm → 50n，1 µm → 1u。写成裸的 100（=100 m）就是单位写错了，**会被拒绝**。这个尺寸同时决定用哪一档策略来给速度和分辨率。", unit: "m", required: true, minValue: 1e-10, maxValue: 0.00001 },
    { name: "purpose", type: "str", description: "意图类别，用来挑策略档。'auto'（默认）按尺寸挑。可选档：slow, atomic_verify, atomic, highres, roi, survey。只有当你**有意**让尺寸与参数不匹配时才点名某一档，比如想在一个小帧上快速粗看一眼（50 nm 尺寸上用 'survey'）。", required: false, default: "auto" },
    { name: "bias_v", type: "float", description: "样品偏压，单位 VOLTS。**只有现场明确给出过这个值时才传它。** 否则就**留空** —— 由分尺度策略表决定。你在这里传的每一个值都会被记成「用户指定」并展示给他看。 **偏压从来不由策略表决定** —— 它选的是你要成像哪些电子态，那是一个物理判断，不是帧尺寸的函数。留空 = 保持当前偏压。", unit: "V", required: false, minValue: -10, maxValue: 10 },
    { name: "setpoint_a", type: "float", description: "隧道电流 setpoint，单位 AMPERES（SI），**不是 pA**。100p = 100 pA。**只有现场明确给出过这个值时才传它。** 否则就**留空** —— 由分尺度策略表决定。你在这里传的每一个值都会被记成「用户指定」并展示给他看。", unit: "A", required: false, minValue: 1e-12, maxValue: 1e-7 },
    { name: "line_time_s", type: "float", description: "每条扫描线多少秒。**只有现场明确给出过这个值时才传它。** 否则就**留空** —— 由分尺度策略表决定。你在这里传的每一个值都会被记成「用户指定」并展示给他看。", unit: "s", required: false, minValue: 0.0001, maxValue: 600 },
    { name: "pixels", type: "int", description: "每行像素数（方形帧）。**只有现场明确给出过这个值时才传它。** 否则就**留空** —— 由分尺度策略表决定。你在这里传的每一个值都会被记成「用户指定」并展示给他看。", unit: "px", required: false, minValue: 16, maxValue: 4096 },
    { name: "angle_deg", type: "float", description: "扫描旋转角，单位度。**只有现场明确给出过这个值时才传它。** 否则就**留空** —— 由分尺度策略表决定。你在这里传的每一个值都会被记成「用户指定」并展示给他看。 留空 = 保持当前扫描角。", unit: "deg", required: false, minValue: -180, maxValue: 180 },
    { name: "channels", type: "str", description: "要采的通道，逗号分隔。默认 'Z,Current'。只有要**加**通道时才传，比如做 dI/dV 成像时加 lock-in。", required: false },
    { name: "wait_timeout_s", type: "float", description: "等待完成的上限。**留空**则按解析出来的几何自动估（行数 × line time × 2 个方向 + 30% 余量）—— 手填一个短值会把慢扫或高分辨扫描**截断**。", unit: "s", required: false, minValue: 10, maxValue: 7200 },
  ],
  preconditions: ["z_controller_on"],
  tags: ["scan","imaging","composite","policy"],
  category: "composite",
  safetyLevel: "CONFIRM",
}

export const FullScanSpec: SkillSpec = {
  name: "FullScan",
  description: "一步式扫描:配置扫描区域、设定速度、启动、等它扫完。相当于 ConfigureScan + SetScanSpeed + StartScan 合成一步。",
  parameters: [
    { name: "center_x_m", type: "float", description: "扫描中心 X", unit: "m", required: true },
    { name: "center_y_m", type: "float", description: "扫描中心 Y", unit: "m", required: true },
    { name: "width_m", type: "float", description: "扫描宽度,单位**米**(SI),**不是纳米**。换算:100 nm → 100n,50 nm → 50n。像 100 这样的裸值(=100 m)是单位写错,会被拒绝。", unit: "m", required: true, minValue: 1e-10, maxValue: 0.00001 },
    { name: "height_m", type: "float", description: "扫描高度,单位**米**(SI),**不是纳米**。换算:100 nm → 100n,50 nm → 50n。像 100 这样的裸值(=100 m)是单位写错,会被拒绝。", unit: "m", required: true, minValue: 1e-10, maxValue: 0.00001 },
    { name: "line_time_s", type: "float", description: "正扫每线时间,单位秒。**除非用户点名说了一个数,否则别填**:省略时,它来自用户的逐尺度档位表(这个帧尺寸该配多快,是他们的知识,不是你的)。优先用 ScanAt,它对每一个扫描参数都是这么定的。", unit: "s", required: false, minValue: 0.01, maxValue: 60 },
    { name: "channels", type: "str", description: "分号分隔的通道列表", required: false, default: "" },
    { name: "wait_timeout_s", type: "float", description: "等扫描完成最多等多久。留空则由**真实的扫描几何自动估算**(从仪器读回的实际行数 × line_time × 2 个方向,+30% 余量,下限 300 s)—— **不要**自己挑一个短值,否则可能把一张慢扫 / 高分辨的图截断。超时会停掉扫描。", unit: "s", required: false, minValue: 10, maxValue: 3600 },
  ],
  preconditions: ["z_controller_on"],
  tags: ["scan","imaging","composite"],
  category: "composite",
  safetyLevel: "CONFIRM",
}

export const TipShapeSpec: SkillSpec = {
  name: "TipShape",
  description: "运行硬件的 tip shaper 流程（受控修针）。",
  parameters: [
    { name: "switch_off_delay_s", type: "float", description: "关闭 controller 之前，对 Z 位置做平均的时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "change_bias", type: "bool", description: "在第一段 Z ramp 之前，把偏压跳变到 bias_v。**默认关闭**（2026-08-11）。workflow 层本来就拒绝这条路：TipShaper 只能**一步**改完偏压，而一步跳变本身就是一记冲击（_tip_phases.py）。请先自己把偏压设好（用带 slew rate 的 SetBias），再在这一项关闭的情况下扎针。", required: false, default: false },
    { name: "bias_v", type: "float", description: "第一段 Z ramp 之前施加的偏压（仅当 change_bias=True 时生效）。**省略**它则跟随**当前**的成像偏压。没有 3 V 兜底：偏压若读不到，这个技能直接拒绝执行。", unit: "V", required: false, minValue: -10, maxValue: 10 },
    { name: "tip_lift_m", type: "float", description: "第一段 Z ramp 的距离（相对当前 Z 的相对量），单位**米**。常用 -2n 到 2n（±2 nm）。硬上限 ±100n（±100 nm）—— 由 ±1 µm 收紧而来，那是常规扎针的 500×，而且没有任何全局兜底（2026-07-03 复审）。示例：-3n（= -3 nm）✓；5（= 5 米！）✗。", unit: "m", required: false, minValue: -1e-7, maxValue: 1e-7, default: 0 },
    { name: "lift_time_1_s", type: "float", description: "第一段 Z ramp 的时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "bias_lift_v", type: "float", description: "在第一段 Z ramp**刚结束之后**施加的偏压。⚠️ 与 bias_v 不同，这一项是**无条件**施加的 —— change_bias **不能**把它解除（厂商原文：'Bias (V) … if Change Bias is True' 对比 'Bias Lift (V) … applied just after the first Z ramping'）。**省略**它则跟随 bias_v，也就是当前的成像偏压。没有 3 V 兜底。", unit: "V", required: false, minValue: -10, maxValue: 10 },
    { name: "bias_settling_s", type: "float", description: "施加偏压值之后的等待时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "lift_height_m", type: "float", description: "第二段 Z ramp 的高度，单位**米** —— 也就是**退回来**的那一段。**省略**它则默认取 -tip_lift_m（扎进去 x，就拉回来 x），这也是每个 composite 早已在用的规则。常用 1n 到 5n（1–5 nm）。硬上限 ±100n（±100 nm）—— 由 ±1 µm 收紧而来（2026-07-03 复审）。示例：2n（= 2 nm）✓；1（= 1 米！）✗。", unit: "m", required: false, minValue: -1e-7, maxValue: 1e-7 },
    { name: "lift_time_2_s", type: "float", description: "第二段 Z ramp 的时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "end_wait_s", type: "float", description: "恢复初始偏压之后的等待时长", unit: "s", required: false, minValue: 0, default: 0.1 },
    { name: "restore_feedback", type: "bool", description: "结束时恢复 Z-controller 的初始状态", required: false, default: true },
    { name: "allow_on_qplus", type: "bool", description: "在已登记的 qPlus 针尖上显式放行这个动作。Z ramp 可能**不可逆地**毁掉石英音叉（传感器必须物理更换并重新标定），所以除非设了这一项，否则 qPlus 针尖一律**拒绝**。若没有登记针尖，则本项忽略。", required: false, default: false },
    { name: "timeout_ms", type: "int", description: "整个流程的超时（-1 = 永远等待）", unit: "ms", required: false, minValue: -1, default: -1 },
  ],
  capabilities: ["tip_shaping"],
  tags: ["tip","shaper","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const TipPulseSpec: SkillSpec = {
  name: "TipPulse",
  description: "施加偏压脉冲修针。先快照当前偏压，打脉冲，再恢复。",
  parameters: [
    { name: "pulse_v", type: "float", description: "脉冲偏压。**没有具体理由就别填** —— 留空时，它按已登记针尖（材料 × 制法 × 形态）从针尖策略表里取：钨的电化学腐蚀针和 PtIr 剪切针受不住同一个脉冲。你**填了**的值会被采用，但超出该针尖的安全包络时是**拒绝**（不是夹紧）。", unit: "V", required: false, minValue: -10, maxValue: 10 },
    { name: "duration_s", type: "float", description: "每次脉冲的时长（留空 → 针尖策略表）", unit: "s", required: false, minValue: 0.01, maxValue: 5, default: 0.1 },
    { name: "count", type: "int", description: "打几次脉冲（留空 → 针尖策略表）", required: false, minValue: 1, maxValue: 50, default: 1 },
  ],
  preconditions: ["z_controller_on"],
  capabilities: ["bias_pulse"],
  tags: ["tip","pulse","conditioning","composite"],
  category: "composite",
  safetyLevel: "CONFIRM",
}

export const TipConditioningSelfCheckSpec: SkillSpec = {
  name: "TipConditioningSelfCheck",
  description: "针尖整形工作流的只读预检：它要用的技能在这个 build 里是不是真的都注册了、Tip Shaper 模块是不是在跑、针尖有没有登记（未登记的针尖会把脉冲压到保守默认值）、有没有实验可供读取扫描地图、以及 Z 噪声本底是不是小到让 50 pm 的台阶判据还有意义。什么都不碰。",
  parameters: [],
  tags: ["tip","conditioning","selfcheck","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const TipForgeSelfCheckSpec: SkillSpec = {
  name: "TipForgeSelfCheck",
  description: "特异化针尖配方（MakeSpectroscopyTip / MakeAtomicResolutionTip）的预检：技能在这个 build 里在不在、衬底能不能解出 Shockley onset、评估帧到底分不分得开晶格、判据模块能不能工作。只读；除一次 Tip Shaper 探测外无需硬件。结论看 data.ready ，不是 success。",
  parameters: [
    { name: "substrate", type: "str", description: "用来对照检查的衬底。留空则用已登记的样品。", required: false, default: "" },
  ],
  tags: ["tip","forge","selfcheck","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const MonitorCurrentSpec: SkillSpec = {
  name: "MonitorCurrent",
  description: "在一个固定时间窗内高速采样隧道电流。返回 min/max/mean/std，外加一个 `contact_detected` 标志 —— 当 |I| 连续 min_contact_samples 次轮询都高于 contact_threshold_a 时置位。",
  parameters: [
    { name: "duration_s", type: "float", description: "持续轮询多久，单位**秒**。常用 0.1–5。示例：0.5（= 500 ms）✓；60（= 1 分钟）只用于长时间观察。", unit: "s", required: false, minValue: 0.01, maxValue: 60, default: 1 },
    { name: "poll_hz", type: "float", description: "轮询速率，单位 Hz。Nanonis TCP 大致有 ~kHz 的能力，但往返抖动使得 ≤200 Hz 才现实。", unit: "Hz", required: false, minValue: 1, maxValue: 500, default: 100 },
    { name: "contact_threshold_a", type: "float", description: "判定接触的电流绝对值阈值，单位**安培**。STM 的 setpoint 在 pA–nA 量级；接触起始通常是 10–100 nA。示例：50n（= 50 nA）✓；1（= 1 安培 —— STM 上绝不会出现）✗。", unit: "A", required: false, minValue: 1e-12, maxValue: 0.001, default: 5e-8 },
    { name: "min_contact_samples", type: "int", description: "判定接触所需的连续超阈轮询次数。用来滤掉尖峰。", required: false, minValue: 1, maxValue: 100, default: 3 },
  ],
  tags: ["current","monitor","contact","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const MonitorCurrentFFTSpec: SkillSpec = {
  name: "MonitorCurrentFFT",
  description: "通过 TCP 轮询对隧道电流做软件 FFT。以 `poll_hz` Hz 采集 `duration_s` 时长的样本，然后返回幅度（或功率）谱。时延 = duration_s + 22 µs FFT。Nyquist = poll_hz / 2。当 Nanonis Spectrum Analyzer 模块不可用、或你需要自定义窗函数时用它。",
  parameters: [
    { name: "duration_s", type: "float", description: "窗长，单位是 SECONDS（秒）。频率分辨率 df = 1 / duration_s 。典型 0.5–2 s。", unit: "s", required: false, minValue: 0.05, maxValue: 30, default: 1 },
    { name: "poll_hz", type: "float", description: "目标轮询速率，单位 Hz。真实 Nanonis V5e + Python TCP 大约在 1500–2000 Hz 封顶；实际速率会写进结果的 `actual_fs_hz` 字段。", unit: "Hz", required: false, minValue: 10, maxValue: 4000, default: 1000 },
    { name: "window", type: "str", description: "FFT 之前施加的窗函数。'hann'（默认）、'hamming'、'rect'（不加窗）。", required: false, default: "hann" },
    { name: "detrend", type: "bool", description: "加窗前先减去缓冲区的均值。", required: false, default: true },
    { name: "output", type: "str", description: "'magnitude'（|FFT|）或 'power'（|FFT|² PSD）。", required: false, default: "magnitude" },
  ],
  tags: ["current","fft","psd","software","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const ClassifyUnexplainedCurrentSpec: SkillSpec = {
  name: "ClassifyUnexplainedCurrent",
  description: "看到一股说不清来路的电流时，用**偏压依赖**判它是什么：隧穿／场发射／根本不是结电流（偏置或串扰）／放大器饱和。\n\n**判别点是 0 V 那一个读数。** 它看着最没用：压电运动感生的位移电流不关心偏压，0 V 下照样在；而隧穿与场发射在 0 V 下都必须是零。2026-08-28 真机：横移拦截报 1.17e-11 A，用户猜是压电串扰 —— 实测 2.00 V→111.65 pA、1.00 V→0.13 pA、0.00 V→−0.01 pA，偏压变 2 倍电流变 859 倍（n≈9.7），是场发射；0 V 干净这一点把串扰判掉了。\n\n**先查饱和再判别。** 放大器满量程时每个偏压读数都一样，落进判别表就成了「随偏压不变 ⇒ 串扰」，正好判反。「读数不动」有两个原因：没有电流，或者量程满了。\n\n**测量期间关反馈** —— 反馈开着时 Z 会去追 setpoint，I(V) 描述的是反馈环不是结。结束后偏压与反馈都还原。\n\n可选参数 `observed_current_a` 接「引起怀疑的那个读数」：静态复现不出来就判 `transient` —— 那股电流只在某件事发生时存在，静态 I(V) 判不了它，**要在动的过程中重测**。",
  parameters: [
    { name: "test_biases_v", type: "str", description: "逗号分隔的测试偏压。**0 会被自动补上** —— 缺了它整个判别就立不住。", required: false, default: "2.0,1.0,0.5,0.0" },
    { name: "observed_current_a", type: "float", description: "引起怀疑的那个电流读数。给了就与同偏压下的静态读数比：复现不出来 ⇒ 判 transient（只在动的时候存在）。", unit: "A", required: false },
    { name: "repeats", type: "int", description: "每个偏压读几次取中位数。", required: false, minValue: 1, maxValue: 15, default: 3 },
  ],
  tags: ["current","diagnosis","field-emission","crosstalk","场发射","串扰","电流来源"],
  category: "write",
  safetyLevel: "AUTO",
}

export const RecoverTipFromSaturationSpec: SkillSpec = {
  name: "RecoverTipFromSaturation",
  description: "撞针之后电流放大器锁在满量程时，把针尖一级级退开直到读数脱离饱和。\n\n**第一步是查仪器锁**，不是撤针。2026-08-28 真机：撞针后我连发降偏压、撤针，读数一动不动（10003.6 pA）—— 不是命令无效，是它们**根本没到仪器**：`ScanAt` 还持有仪器锁 363 秒。「被挡在门外」与「发出去了但没效果」长得一模一样，而两者要做的事相反。\n\n**压电退针往往不够。** 那次 Z 已经在压电上限 208.73 nm 仍然饱和，真正解开的是**粗动 Z 退 200 步**。所以顺序是：查锁 → 降偏压 → 压电退针 → 粗动 Z 逐级退（20/30/50/100/200/400），每级读一次电流，脱离就停。\n\n**逐级而不是一次退到底**：退过头就要多花几分钟重新进针，而每级多读一次电流几乎不要钱。\n\n读不到电流时说「判不了」，**不当作已恢复** —— 那会让调用方以为可以继续，而针尖可能还压在样品上。",
  parameters: [
    { name: "max_coarse_steps", type: "int", description: "粗动 Z 最多退多少步（累计）。到点仍未脱离就如实返回未恢复。", required: false, minValue: 0, maxValue: 20000, default: 800 },
    { name: "safe_bias_v", type: "float", description: "退针期间的偏压。带着成像偏压时几十 nm 距离就场发射，读数没法用来判断。", unit: "V", required: false, minValue: 0, maxValue: 2, default: 0.2 },
  ],
  tags: ["tip","recovery","crash","saturation","撞针","饱和"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const WaitForThermalSettleSpec: SkillSpec = {
  name: "WaitForThermalSettle",
  description: "等温度**不再变**再开工。判据是**变化速率**，不是绝对值。\n\n换样品后温度会从几十 K 掉回基温，途中任何时刻都可能「已经低于阈值」却仍在快速下降。2026-08-27 实测：到 5.0 K 时还在以 **1.08 K/min** 下降，又过了四分半才降到 0.02 K/min 真正稳住。在那四分半里进针、量势垒、扫图，读到的都是跟着温度走的东西 —— Z 在漂、结阻在变、势垒带着趋势。\n\n**同时看两条**：温度低于 `max_temp_k`（可选，留空=不管绝对值）**并且**速率的绝对值低于 `max_rate_k_per_min`。速率用最近若干点线性拟合，少于 5 点不作数（两点连线算出的「速率」全是噪声）。\n\n**读不到温度就说读不到**，不假装稳定 —— 那会让调用方在未知状态下开工。只读温度，不控温、不碰仪器。",
  parameters: [
    { name: "max_rate_k_per_min", type: "float", description: "算「稳了」的速率上限（绝对值）。默认 0.03 —— 08-27 实测到这个量级时 Z 与结阻都不再跟着走。", unit: "K/min", required: false, minValue: 0.001, maxValue: 5, default: 0.03 },
    { name: "max_temp_k", type: "float", description: "温度上限。**留空 = 只看速率**（比如在 77 K 上工作时就不该要求它降到 5 K）。给了值就是两条**并且**。", unit: "K", required: false, minValue: 0, maxValue: 500 },
    { name: "timeout_s", type: "float", description: "最长等待。到点仍未稳就如实返回未稳，**不假装成功**。", unit: "s", required: false, minValue: 10, maxValue: 86400, default: 3600 },
    { name: "window", type: "int", description: "拟合速率用的采样点数（滑动窗口）。", required: false, minValue: 5, maxValue: 60, default: 6 },
  ],
  tags: ["thermal","wait","settle","温度","换样品"],
  category: "read",
  safetyLevel: "AUTO",
}

export const WatchScanLinesSpec: SkillSpec = {
  name: "WatchScanLines",
  description: "在**不停止**正在运行的扫描的前提下看它一眼：进行到哪儿了、自某条游标行以来是否还在推进、以及新扫出来的那些行长什么样（粗糙度、量程、倾斜、行间相关性、piezo 饱和）。扫一帧要花几分钟，而这个只花一次 TCP 往返 —— 于是「这一帧还值不值得扫完」不再是一个要等几分钟才有答案的问题。它报的是**测量值**加上被标注出来的观察 —— 判语归判据类技能（AssessAtomicLines、CheckScanForCrash）。把 last_line_index 当作游标传回 since_line 即可；新增 0 行意味着扫描停了、卡住了、或者正扫在一行中间 —— 这是一个必须有人处理的信号。",
  parameters: [
    { name: "direction", type: "int", description: "1 = 正扫，0 = 反扫（对应 .sxm 的 forward / backward）。", required: false, minValue: 0, maxValue: 1, default: 1 },
    { name: "since_line", type: "int", description: "游标：只统计行号比它「更新」的那些行。-1 = 全部已扫出的行。把上一次回包里的 last_line_index 传回来即可。", required: false, minValue: -1, maxValue: 100000, default: -1 },
    { name: "channel_index", type: "int", description: "强行指定**信号索引**（不是缓冲位）。-1 = 自己去 Scan_BufferGet 找 Z。", required: false, minValue: -1, maxValue: 127, default: -1 },
    { name: "max_lines", type: "int", description: "最多统计这么多条最新的行（省算力）。0 = 不限。", required: false, minValue: 0, maxValue: 4096, default: 64 },
  ],
  tags: ["scan","read","live","lines","infrastructure"],
  category: "read",
  safetyLevel: "AUTO",
}

export const BiasSettleChangeSpec: SkillSpec = {
  name: "BiasSettleChange",
  description: "走安全路径改样品偏压：跨零时**不在低偏压死区里逗留**（在那里恒流反馈会把针尖往表面上压），大幅改动用 ramp 而不是直接跳，改完还会等反馈稳定。**偏压要变号、或者变化很大时，优先用它而不是 SetBias** —— 直接用 SetBias 跨零是撞针的经典路径，而参数范围和安全门**都不会拦你**。",
  parameters: [
    { name: "bias_v", type: "float", description: "目标样品偏压，是一个 VOLT 量。偏压的量级不大，所以写普通字符串就行：'-2'（−2 V）、'0.05' 或 '50m'（50 mV）。", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "settle_s", type: "float", description: "改完之后等一会儿，让反馈的暂态衰减掉再进行下一次采集。留空用默认值。", unit: "s", required: false, minValue: 0, maxValue: 60 },
    { name: "allow_stop_in_deadband", type: "bool", description: "允许**目标**偏压落在低偏压死区里（|V| < 50 mV）。默认关：恒流反馈开着时停在那里会把针尖往表面上驱。**只有在反馈已关时才开它。**", required: false, default: false },
  ],
  tags: ["bias","safety","settle","composite"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AcquirePSDSpec: SkillSpec = {
  name: "AcquirePSD",
  description: "从 Nanonis 侧的 Spectrum Analyzer（硬件 FFT）读功率谱密度。每个请求的频率量程返回一组 (f0, df, psd_array)。时延：每个量程 ~0.5 ms RTT。当你需要的刷新率超出软件轮询能达到的范围时用它（真实硬件：Nyquist 最高 ~10 kHz；模拟器：上限 1 kHz）。",
  parameters: [
    { name: "instance", type: "int", description: "Spectrum Analyzer 实例（1 或 2）。", required: false, minValue: 1, maxValue: 2, default: 1 },
    { name: "signal_index", type: "int", description: "可选的待分析信号索引（0–127）。默认用 Spectrum Analyzer 前面板上已配置好的通道。", required: false, minValue: -1, maxValue: 127, default: -1 },
    { name: "freq_range_index", type: "int", description: "可选的、从 0 开始的索引，指向可用频率量程列表。-1 = 保持当前。本模拟器上：0=20Hz, 1=50, 2=100, 3=200, 4=500, 5=1000 Hz。给了 freq_range_indices 时本参数被忽略。", required: false, minValue: -1, maxValue: 15, default: -1 },
    { name: "freq_range_indices", type: "str", description: "可选的 JSON 列表，给出要扫的频率量程索引，例如 '[0, 2, 5]'。给了之后，技能会对每个索引各采一条 PSD，并返回一个 per_range 字典。", required: false, default: "" },
    { name: "freq_resolution_index", type: "int", description: "可选的、从 0 开始的索引，指向分辨率列表。-1 = 保持当前。索引越小 = df 越细。", required: false, minValue: -1, maxValue: 15, default: -1 },
  ],
  tags: ["spectrum","psd","fft","hardware","read","composite"],
  category: "read",
  safetyLevel: "AUTO",
}

export const BatchRegionsScanSpec: SkillSpec = {
  name: "BatchRegionsScan",
  description: "把用户指定的一串区域一个接一个扫过去,每个区域产出一张 .sxm,外加一份汇总。适用场景:用户点名了几片要成像的区域(例如离开仪器过夜之前),想要一次无人值守的表面巡游。`regions` 是一个 JSON 数组,每一项是 {center_x_m, center_y_m, width_m, height_m, [angle_deg], [label]} 对象,所有距离都以**米**计。只在针尖已经进针并稳定之后才跑。每个区域都是可选的 —— 一个失败不会中止其余的。",
  parameters: [
    { name: "regions", type: "str", description: "由区域对象组成的 JSON 数组,每一项都要有 center_x_m、center_y_m、width_m、height_m,单位**米**(angle_deg、label 可选)。例: [{\"center_x_m\": 1e-7, \"center_y_m\": 0, \"width_m\": 5e-8, \"height_m\": 5e-8, \"label\": \"A\"}, {\"center_x_m\": -2e-7, \"center_y_m\": 1e-7, \"width_m\": 1e-7, \"height_m\": 1e-7}]。最多 64 个区域。尺寸 100p–10u m。", required: true },
    { name: "channels", type: "str", description: "每个区域要采的通道,逗号分隔。缺省 'Z,Current'。", required: false, default: "Z,Current" },
    { name: "line_time_s", type: "float", description: "每个区域的正扫每线时间(s)。**除非用户点名说了一个数,否则别填**:省略时,每个区域会按**它自己的**尺寸去查逐尺度档位表拿线时间 —— 一个批次里的区域尺寸可以差很多,给它们同一个速度,对其中大多数都是错的。", unit: "s", required: false, minValue: 0.01, maxValue: 10 },
    { name: "wait_timeout_s", type: "float", description: "每个区域的扫描最多等多久(s)。", unit: "s", required: false, minValue: 10, maxValue: 3600, default: 180 },
    { name: "save_each", type: "bool", description: "每个区域扫完就 SaveScan(每个区域一张 .sxm)。", required: false, default: true },
    { name: "assess_quality", type: "bool", description: "对每个区域跑一次 AssessImageQuality;并推荐最好的那一个。", required: false, default: false },
  ],
  preconditions: ["z_controller_on"],
  tags: ["scan","batch","regions","survey","overview","composite"],
  category: "composite",
  safetyLevel: "CONFIRM",
}

export const ReadCalibrationsSpec: SkillSpec = {
  name: "ReadCalibrations",
  description: "读取仪器档案里的标定值:①倾斜响应矩阵 G(AutoTilt 依赖它)②接触点 dI/dV ③qPlus 实测共振 f₀/Q。每一项都带**年龄**与**适用边界**。**纯读,不动任何硬件。**\n\n⚠️ **被「未标定」挡住时先调本工具**——它会告诉你到底是「从未标定过」还是「读不到档案」,这两件事的处置完全不同。\n\n⚠️ **条件数只管形状不管方向**:一个好看的条件数**不等于**标定可用 (2026-08-10 真机:cond=1.11 而 AutoTilt 仍发散,根因是符号/求逆)。",
  parameters: [
    { name: "which", type: "str", description: "只看某一项:tilt / didv / qplus。留空返回全部。", required: false, default: "" },
  ],
  tags: ["read","calibration","diagnostic","instrument_profile"],
  category: "read",
  safetyLevel: "AUTO",
}

export const RetractForSampleChangeSpec: SkillSpec = {
  name: "RetractForSampleChange",
  description: "换样品/关机前的大退针：先收压电，再用粗动马达沿配置的退针方向分级(1→10→100→剩余)后退约数千步；每级退完开反馈回读 Z 压电走向自检(只有确认在远离才继续，检测到逼近立即停+撤针)。方向/步数/阈值来自 instrument_profile。",
  parameters: [
    { name: "total_steps", type: "int", description: "退针总步数(覆盖 instrument_profile 的默认)。分级 1→10→100→剩余(按单次上限分批)后退这么多步。", required: false, minValue: 1, maxValue: 1000000 },
  ],
  tags: ["tip","safety","retract","sample-change","coarse","dangerous"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const RelocateCoarseXYSpec: SkillSpec = {
  name: "RelocateCoarseXY",
  description: "**换区专用**:把样品台横向粗动到一片新表面。这是唯一应该自主使用的换区方式,不要直接调 MotorMove 做横向移动。\n顺序:前置检查(真空互锁/驱动电压读回核对/扫描已停/落点不与去过的站点重叠) → 清障(收压电 + 粗动 Z 退针,逐级自检方向,并确认电流归零、qPlus 振幅恢复) → 分块横移(每块之后看电流/振幅/真空,异常立即停并再退针) → 步进计数器对账 → 可选重新进针。\n成功后扫描地图自动进入**新的坐标代次**(旧坐标全部作废),并在粗动大地图上留下一个新站点。用 get_coarse_map 决定往哪走、走多少步。",
  parameters: [
    { name: "axis", type: "str", description: "横向轴:'x' 或 'y'", required: true, allowedValues: ["x","y"] },
    { name: "direction", type: "str", description: "方向:'+' 或 '-'", required: true, allowedValues: ["+","-"] },
    { name: "steps", type: "int", description: "横向粗动步数。必须大到让新区域完全跳出压电量程,否则只是把旧区域挪进视野。用 get_coarse_map 的建议值。\n⚠️ 别在这里写死量程数字:本机实测半程 ±1.22 µm(GetPiezoConfig 的 calibration 121.95 nm/V x ±10 V),而配置里存的是 2.52 µm、这行原来写的是 1.5 µm —— **三个数**。要真值就调 CheckPiezoRange,它直接问仪器。", required: true, minValue: 1, maxValue: 100000 },
    { name: "reapproach", type: "bool", description: "移动完成后是否自动重新进针(AutoApproach)。", required: false, default: true },
    { name: "prewithdraw_steps", type: "int", description: "横向移动前的粗动退针步数(清障)。留空用 instrument_profile 的 xy_prewithdraw_steps(默认 100)。压电退针只有 1–2 µm,不足以让针尖躲开横移时的垂直跳动。", required: false, minValue: 0, maxValue: 100000 },
    { name: "allow_revisit", type: "bool", description: "允许落在已经去过的站点附近，**只跳过「别重复访问」这一条效率约束**（最小间距 200 步），安全检查一条不跳。标定步长、微调位置这类动作本来就要走小步/回头路 —— 2026-08-28 用户要六个方向的 nm/步，而每一个几步的移动都落在 200 步以内，于是全被那条规则拒掉。常规换区**不要**开它：重复用同一片表面是真的浪费。", required: false, default: false },
    { name: "dry_run", type: "bool", description: "跑完整条相位但**不发出任何移动命令** —— 用于无硬件验收:前置检查、看护逻辑、记录都会真的跑一遍。", required: false, default: false },
  ],
  preconditions: ["vacuum_ok_for_coarse","scan_not_running"],
  tags: ["motor","coarse","relocate","safety","dangerous"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const StepCoarseXYSpec: SkillSpec = {
  name: "StepCoarseXY",
  description: "把粗动台横向**挪几步**（可以只挪一步）——标定步长、微调位置用。\n\n转调 `RelocateCoarseXY(allow_revisit=True)`，**一层薄壳，不重写任何东西**：清障阶梯、真空互锁、驱动电压读回、降偏压到 0.5 V、电流归零证明、里程表记录、重新进针，全是那一份实现在跑。\n\n它存在的理由：`MotorMove` 在自主路径上被硬闸挡着（「有防护的路才是自主路径」），而 `RelocateCoarseXY` 的落点复核要求离已访问站点 ≥200 步 —— **「挪 2 步」两边都过不去**。那 200 步是效率约束（别重复用同一片表面），不是安全约束，所以这里明说地跳过它，安全检查一条不跳。\n\n**常规换区不要用它**，用 `RelocateCoarseXY`：重复用同一片表面是真的浪费。超过 60 步会被拒 —— 那是换区不是挪一下。",
  parameters: [
    { name: "axis", type: "str", description: "横向轴：'x' 或 'y'", required: true, allowedValues: ["x","y"] },
    { name: "direction", type: "str", description: "方向：'+' 或 '-'", required: true, allowedValues: ["+","-"] },
    { name: "steps", type: "int", description: "走几步。默认 1。超过 60 步请改用 RelocateCoarseXY。", required: false, minValue: 1, maxValue: 60, default: 1 },
    { name: "reapproach", type: "bool", description: "走完是否自动重新进针。", required: false, default: true },
    { name: "prewithdraw_steps", type: "int", description: "横移前的粗动 Z 退针步数（清障）。留空用 instrument_profile 的默认。**本机实测粗动 z 每步 108±31 nm**（2026-08-28），5 步 ≈ 0.5 µm。", required: false, minValue: 0, maxValue: 100000 },
    { name: "dry_run", type: "bool", description: "跑完整条相位但不发出任何移动命令。", required: false, default: false },
  ],
  tags: ["coarse","motor","nudge","calibration","粗动","挪一步","步长标定"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const AnalyzeScanImageSpec: SkillSpec = {
  name: "AnalyzeScanImage",
  description: "测量**一帧**已保存的 .sxm，并决定它该怎么处理：用哪种 flattening（平面 / 2nd-order 曲面 / 逐行 / 在主导 terrace 上拟合行）、色标该收多紧 —— 每一个选择都附上实测的理由。它只读，不碰硬件。它还会**转述**已有的那些判语：原子相位（mast.vision.atomic_phase）、扫描中途的针尖变化（mast.vision.tip_change）、正反扫一致性、坏扫描行。它绝不自己宣称看到了晶格 —— 那个断言来自 atomic_phase，而后者还能回答「在这个像素尺寸下判不了」，这跟「没有晶格」是两回事。",
  parameters: [
    { name: "scan_path", type: "str", description: "已保存的那一帧 .sxm 的路径。", required: true },
    { name: "threshold_profile", type: "str", description: "阈值 profile = 这套阈值是在**哪个样品体系**上标定的。留空则用当前生效的那个。随包发布的这一套来自参考系统上的单一表面类型，尚未在本仓独立验证；在台阶密集或噪声特性不同的表面上，必须根据目标数据分布定义新的 profile。", required: false, default: "" },
    { name: "channel", type: "str", description: "通道名（默认 'Z'）。", required: false, default: "Z" },
    { name: "flatten", type: "str", description: "覆盖自动的 flattening 选择。'auto'（默认）让测量结果自己决定。", required: false, allowedValues: ["auto","plane","poly2","line","masked_line"], default: "auto" },
    { name: "save_png", type: "bool", description: "顺便把 flatten 之后的帧，按所选色标渲染成一张 PNG。", required: false, default: false },
    { name: "output_dir", type: "str", description: "PNG 放到哪里（默认：figures 目录）。", required: false, default: "" },
  ],
  tags: ["scan","analysis","flatten","preprocessing","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AutoProcessScanBatchSpec: SkillSpec = {
  name: "AutoProcessScanBatch",
  description: "测量一个文件夹里的**每一个** .sxm，逐帧挑好 flattening 与色标，然后把扫描尺寸与偏压相同的那些帧**统一**起来 —— 好让其中两帧之间的对比度差异只可能来自样品，绝不可能来自处理过程（含有真实台阶的帧保留各自的保护性处理，不参与统一）。它会渲染出这些 PNG，并写一份 _report.md，里面有每一个实测数字、以及每一个决定的理由。它只读，不碰硬件。",
  parameters: [
    { name: "folder", type: "str", description: "存放这些 .sxm 文件的文件夹。", required: true },
    { name: "threshold_profile", type: "str", description: "阈值 profile = 这套阈值是在**哪个样品体系**上标定的。留空则用当前生效的那个。随包发布的这一套来自参考系统上的单一表面类型，尚未在本仓独立验证；在台阶密集或噪声特性不同的表面上，必须根据目标数据分布定义新的 profile。", required: false, default: "" },
    { name: "channel", type: "str", description: "通道名（默认 'Z'）。", required: false, default: "Z" },
    { name: "flatten", type: "str", description: "覆盖自动的 flattening 选择。'auto'（默认）让测量结果自己决定。", required: false, allowedValues: ["auto","plane","poly2","line","masked_line"], default: "auto" },
    { name: "render", type: "bool", description: "每帧渲染一张 PNG（默认 true）。", required: false, default: true },
    { name: "write_report", type: "bool", description: "写出 _report.md（默认 true）。", required: false, default: true },
    { name: "output_dir", type: "str", description: "PNG 和这份报告放到哪里（默认：figures 目录）。", required: false, default: "" },
    { name: "max_files", type: "int", description: "处理文件数的上限（最多 200）。", required: false, minValue: 1, maxValue: 200, default: 200 },
  ],
  tags: ["scan","analysis","flatten","preprocessing","batch","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessTipSharpnessSpec: SkillSpec = {
  name: "AssessTipSharpness",
  description: "针尖有多锐，从一张已保存的 .sxm 上量：最陡台阶边缘的 10-90 上升宽度（锐针尖几个 px 就能分开一个台阶；钝针或双针会把它抹开），外加正/反扫不稳定度与 FFT 锐度。只读。画面里没有清晰台阶时 edge_resolution_nm 为 null —— 那表示「这张图判不出来」，**不是**「锐」。",
  parameters: [
    { name: "scan_path", type: "str", description: "要分析的 .sxm 文件路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道（标准是 'Z'）。", required: false, default: "Z" },
    { name: "sharp_edge_nm", type: "float", description: "边缘宽度到这个值或更小，就算针尖锐。留空则只报数、不下结论 —— 合适的阈值取决于像素尺寸和表面。", unit: "nm", required: false, minValue: 0.01, maxValue: 100 },
  ],
  tags: ["tip","sharpness","step","analysis","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessTipFromSpectrumSpec: SkillSpec = {
  name: "AssessTipFromSpectrum",
  description: "从一条已保存的谱（.dat）判断针尖。只读，不碰硬件。这不是数据质量闸门 —— 那是 AssessSpectrum，它回答的是「这条曲线值不值得留」。这里问的是「这根针尖好不好」：干净针尖的 I(z) 曲线是单一指数，其衰减给出 ~4-5 eV 的表观势垒；稳定针尖的 I(V) 光滑、无尖峰、大致反对称。verdict 是一个封闭的四态集合：tip_ok / tip_suspect / tip_bad / unrated —— 「判不了」绝不（NEVER）被折叠进 'tip_bad'。留空的阈值是 UNCALIBRATED，对那条判据只能给出 'unrated'，绝不给出坏结论；gated_criteria 说明实际是哪几条做的判决。I(z) 的势垒窗有物理依据，因此带默认值；I(V) 的形状分是无量纲的，出厂为 NONE。success=true 只表示这个文件读得出来；判断在 data.verdict 里。",
  parameters: [
    { name: "dat_path", type: "str", description: "已保存的 .dat 谱文件路径。", required: true },
    { name: "kind", type: "str", description: "auto / iv / iz。'auto' 从 DATA 本身判断（哪一列在被扫）；文件头只用来交叉核对，因为文件头字段说的是软件最后被设成了什么。", required: false, allowedValues: ["auto","iv","iz"], default: "auto" },
    { name: "min_fit_r2", type: "float", description: "仅 I(z)。判定「一条干净的单指数」所需的对数-线性拟合质量下限。默认 UNCALIBRATED —— 留空则这条判据只报一个数。", required: false, minValue: 0, maxValue: 1 },
    { name: "barrier_ev_min", type: "float", description: "仅 I(z)。表观势垒窗的下沿。默认 3.0 eV —— 这个默认值是 PHYSICAL 的（干净金属功函数 4-5 eV），不是标定出来的。设为 0 可关掉这条判据。", required: false, minValue: 0, maxValue: 50, default: 3 },
    { name: "barrier_ev_max", type: "float", description: "仅 I(z)。表观势垒窗的上沿。默认 8.0 eV。设为 0 可关掉这条判据。", required: false, minValue: 0, maxValue: 50, default: 8 },
    { name: "max_jumps", type: "int", description: "允许出现多少次电流突跳（I(z) 看 n_jumps / I(V) 看 n_spikes）。在斜坡中途跳变的针尖是不稳定的。默认 UNCALIBRATED。", required: false, minValue: 0, maxValue: 10000 },
    { name: "min_smoothness", type: "float", description: "仅 I(V)。无量纲形状分，取值在 [0,1]。UNCALIBRATED —— 这个量没有公开发表的数值，本台设备上也没测过，所以它是刻意留空的。", required: false, minValue: 0, maxValue: 1 },
    { name: "min_symmetry", type: "float", description: "仅 I(V)。无量纲反对称性分，取值在 [0,1]。UNCALIBRATED —— 出厂留空。NOTE 有能隙或不对称的衬底会让一根 GOOD 针尖看起来不对称，所以在不知道衬底的情况下拿它否决，会把好针尖判成坏的。", required: false, minValue: 0, maxValue: 1 },
  ],
  tags: ["analysis","tip","spectroscopy","readonly"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const InvertForceSaderJarvisSpec: SkillSpec = {
  name: "InvertForceSaderJarvis",
  description: "把一条 Δf(z) 的 .dat 用 Sader–Jarvis 方法反演成力 F(z) 与势能 U(z),报出力的极小值(pN)、它相对 Δf 极小值的位置、短程力衰减长度与结合能(meV)。给了干净表面的背景曲线就先相减。只读文件,不碰硬件。verdict 取 'well' / 'no_well' / 'undecidable'。另外报两条诊断:正向残差(反演出的力再算回 Δf 与实测差多少),以及振幅与力衰减长度之比 —— 后者的门限**未标定**,它提示换个振幅复测,不替你下结论。",
  parameters: [
    { name: "dat_path", type: "str", description: "Δf(z) 曲线的 .dat 路径。", required: true },
    { name: "background_dat_path", type: "str", description: "干净表面上同样扫程的 Δf(z),用来扣长程背景。", required: false, default: "" },
    { name: "f0_hz", type: "float", description: "传感器共振频率,单位**赫兹**(普通数字,例如 30000)。留空则从 .dat 头或仪器档案取。", required: false, minValue: 1, maxValue: 10000000 },
    { name: "k_n_per_m", type: "float", description: "传感器弹性常数,单位 **N/m**(普通数字,qPlus 常见 1800)。任何 Nanonis 头里都没有这个数,留空则从仪器档案/针尖登记信息取。", required: false, minValue: 1, maxValue: 1000000 },
    { name: "amplitude_m", type: "float", description: "振荡振幅,例如 '50p'(SI 前缀必须写)。留空则从 .dat 的振幅列或头里取。", unit: "m", required: false, minValue: 1e-13, maxValue: 1e-8 },
    { name: "direction", type: "str", description: "用正扫、反扫、还是两者平均。", required: false, allowedValues: ["auto","forward","backward","average"], default: "auto" },
    { name: "smooth_points", type: "int", description: "反演前对 Δf 做几点平滑(0 = 不平滑)。", required: false, minValue: 0, maxValue: 99, default: 0 },
    { name: "df_column", type: "str", description: "频移列的列名(留空自动找)。", required: false, default: "" },
    { name: "z_column", type: "str", description: "z 列的列名(留空自动找)。", required: false, default: "" },
  ],
  tags: ["analysis","pll","frequency","force","qplus","afm","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AssessAtomicConsistencySpec: SkillSpec = {
  name: "AssessAtomicConsistency",
  description: "跨帧判断原子晶格是否真实：真晶格重现同一组格矢，针尖抖动不重现。单帧的角向集中度排除不掉「这一帧恰好抖出了周期」。",
  parameters: [
    { name: "scan_paths", type: "str", description: "多个 .sxm 路径，逗号分隔（至少两个）", required: true },
    { name: "channel", type: "str", description: "形貌通道", required: false, default: "Z" },
  ],
  tags: ["atomic","lattice","multiframe","analysis"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const AnalyzeFrameTiltSpec: SkillSpec = {
  name: "AnalyzeFrameTilt",
  description: "量出样品倾斜、台阶是不是主导了高度分布、以及表面自身的粗糙度 —— 全都只从一份已保存的 .sxm 文件里读。只读,不碰硬件。用它来拿到 AutoTilt 需要的 surface_rms_m(也就是「斜坡有没有把形貌淹没」那条判据),以及在决定要不要调平之前先看看图是不是肉眼可见地倾斜。**注意**:它报出来的倾斜**只有沿快扫轴那一个方向可信**:慢扫轴横跨整帧的采集时长,那个方向上的热漂移与真实倾斜无法区分。要两个方向都可信的倾斜测量,用 TiltProbeCircle。",
  parameters: [
    { name: "scan_path", type: "str", description: "要分析的 .sxm 文件路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道('Z' 是标准选择)。", required: false, default: "Z" },
    { name: "check_steps", type: "bool", description: "跑「台阶主导」这道否决闸。台阶主导的时候,倾斜拟合量到的是台阶包络而不是表面,所以倾斜会被报成**无效**,而不是给出一个数。只有在想看原始拟合结果时才关掉它。", required: false, default: true },
  ],
  tags: ["scan","tilt","analysis","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

export const TiltProbeCircleSpec: SkillSpec = {
  name: "TiltProbeCircle",
  description: "在 Z 反馈**开启**（恒流）的状态下让针尖绕一个小圆走一圈，并拟合 Z(theta)，以此测量样品倾斜。这是 Nanonis SmarTilt 按钮的自建等价物（TCP 协议没有把它暴露出来）。与拟合一整幅扫描帧不同，两条轴是在同一个数秒量级的时间尺度上测出来的，因此谁都不会被热漂移污染。它需要一块**平坦**的位置 —— 一个跨过台阶的圆会被它的拟合残差挡掉。返回测得的倾斜；它**不会**改变任何硬件的倾斜设置（要闭环请用 AutoTilt）。",
  parameters: [
    { name: "radius_m", type: "float", description: "圆半径，单位**米**。不传则由当前扫描帧推出（取短边的 0.4 倍，也就是留了余量地落在内切圆里）。", unit: "m", required: false, minValue: 2e-9, maxValue: 5e-7 },
    { name: "n_points", type: "int", description: "沿圆周取多少个采样点。点越多，噪声平均得越干净，但也越慢。", required: false, minValue: 8, maxValue: 180, default: 24 },
    { name: "settle_s", type: "float", description: "每个点上读 Z 之前的稳定时间，好让反馈在横向移动之后跟上来。", unit: "s", required: false, minValue: 0, maxValue: 5, default: 0.05 },
    { name: "center_x_m", type: "float", description: "圆心 X。不传则用针尖当前位置。", unit: "m", required: false, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "center_y_m", type: "float", description: "圆心 Y。不传则用当前位置。", unit: "m", required: false, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "noise_floor_m", type: "float", description: "用来判断拟合残差的 Z 噪声本底（一个跨过台阶的圆会被挡掉）。不传则由起始点上的重复读数估出来。", unit: "m", required: false, minValue: 0, maxValue: 1e-8 },
  ],
  preconditions: ["z_controller_on","scan_not_running"],
  tags: ["tilt","measure","smartilt","write"],
  category: "write",
  safetyLevel: "CONFIRM",
}

export const TiltCalibrateSpec: SkillSpec = {
  name: "TiltCalibrate",
  description: "一次性标定 Piezo_TiltSet 的两个轴与实测表面斜率之间的对应关系：在每个轴上施加一个小的试探步，解出 2x2 响应矩阵（符号 + 轴交换 + 增益一次吃掉）。解得出来就把结果存进 instrument profile；**解不稳（响应矩阵条件数超过 TILT_CAL_MAX_COND）则整个技能失败、什么都不写** —— 那不是「存了一个差的」，是没有标定，AutoTilt 仍然会拒绝运行。**没有它 AutoTilt 一律拒绝运行** —— 轴对应与符号取决于这台装置的接线，猜错方向不是把倾斜去掉，而是把它**加倍**。每台仪器跑一次，跑在一块**平**的地方，而且要有用户在场。",
  parameters: [
    { name: "step_deg", type: "float", description: "施加在每个倾斜轴上的试探步长。小到无害，大到可测。", unit: "deg", required: false, minValue: 0.02, maxValue: 1, default: 0.2 },
    { name: "radius_m", type: "float", description: "测量圆的半径（见 TiltProbeCircle）。", unit: "m", required: false, minValue: 2e-9, maxValue: 5e-7 },
    { name: "n_points", type: "int", description: "每个测量圆上取几个点。", required: false, minValue: 8, maxValue: 180, default: 24 },
  ],
  preconditions: ["z_controller_on","scan_not_running"],
  tags: ["tilt","calibration","composite"],
  category: "composite",
  safetyLevel: "CONFIRM",
}

export const AutoTiltSpec: SkillSpec = {
  name: "AutoTilt",
  description: "在一块平地上测出样品倾斜，用 piezo tilt 把它补偿掉，再复测一次验收。要不要补偿由它自己判（判据是：在你**接下来要扫的那一帧**上，这个斜坡吃掉多少 Z 量程），补偿分成限幅的小步施加，残差不收敛就**回滚**（ROLLS BACK）。前提是这台仪器上已经跑过 TiltCalibrate。图看起来是斜的、或者要换到更精细的尺度之前，就调它；你不需要给任何角度 —— 角度是它自己测的。",
  parameters: [
    { name: "next_frame_m", type: "float", description: "这次调平要对多大的帧负责 —— 那一帧的边长。触发判据是斜坡**在那一帧上**吃掉多少 Z 量程，所以一张 1 um 的综览会比一张 10 nm 的特写严得多。不填则用当前帧。", unit: "m", required: false, minValue: 1e-10, maxValue: 0.00001 },
    { name: "radius_m", type: "float", description: "测量圆的半径（见 TiltProbeCircle）。", unit: "m", required: false, minValue: 2e-9, maxValue: 5e-7 },
    { name: "n_points", type: "int", description: "每个测量圆上取几个点。", required: false, minValue: 8, maxValue: 180, default: 24 },
    { name: "max_iterations", type: "int", description: "「补偿 + 验收」最多做几轮。", required: false, minValue: 1, maxValue: 6, default: 3 },
    { name: "surface_rms_m", type: "float", description: "表面自身高度起伏的 RMS，从一张扫描帧上量出来。给了它之后，斜坡一旦把形貌淹没，也会触发一次补偿（这正是「图明显看着是斜的」那种情况）。没有帧可以拿来量的话就不填。", unit: "m", required: false, minValue: 0, maxValue: 0.000001 },
    { name: "force", type: "bool", description: "即便实测倾斜对目标帧来说已经在预算之内，也照样补偿。", required: false, default: false },
  ],
  preconditions: ["z_controller_on","scan_not_running"],
  tags: ["tilt","levelling","composite"],
  category: "composite",
  safetyLevel: "CONFIRM",
}

export const FindCleanSpotSpec: SkillSpec = {
  name: "FindCleanSpot",
  description: "离针尖最近、而且**没有**被破坏过的那个落点，供下一次脉冲或扎针用。它读的是已记录的地图 marker，**外加**本进程自己的撞针记忆 —— 绝不从一张图上猜。没有实验记录可查时返回 map_known=false，那句话的意思是「不知道」，不是「干净」；crash_memory_unlocated>0 表示**确实**知道发生过一次撞针、但那个位置谁也读不出来，于是它躲不开，返回的落点带着这份风险。",
  parameters: [
    { name: "purpose", type: "str", description: "这个落点拿来做什么：'pulse'（偏压脉冲，污染半径更大）或 'tip_shape'（扎针，半径小一些）。", required: false, allowedValues: ["pulse","tip_shape"], default: "pulse" },
    { name: "exclude_spots", type: "str", description: "**这一轮**已经用掉的落点，'x1,y1;x2,y2'，单位米。刚刚写下的 marker 可能还没落到库里，所以这份清单由调用方自己拿着。", required: false, default: "" },
    { name: "from_x_m", type: "float", description: "搜索的起点。不给就取针尖的实时位置。", unit: "m", required: false, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "from_y_m", type: "float", description: "搜索的起点。不给就取针尖的实时位置。", unit: "m", required: false, minValue: -0.0000015, maxValue: 0.0000015 },
    { name: "max_distance_m", type: "float", description: "离起点比这个还远的落点一律忽略。", unit: "m", required: false, minValue: 1e-9, maxValue: 0.000003 },
    { name: "count", type: "int", description: "返回几个候选（由近到远排）。", required: false, minValue: 1, maxValue: 64, default: 8 },
  ],
  tags: ["map","position","tip","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const FindFlatRegionSpec: SkillSpec = {
  name: "FindFlatRegion",
  description: "在一张 .sxm 扫描图的形貌通道上滑窗,返回去平面之后 RMS 粗糙度最低的那一块窗。返回的是窗中心坐标,单位米(仪器坐标系)。",
  parameters: [
    { name: "scan_path", type: "str", description: "要分析的 .sxm 扫描文件路径。", required: true },
    { name: "window_fraction", type: "float", description: "搜索窗的边长,以整幅扫描范围的**比例**表示。0.2 = 20%(例如 100 nm 的图里开一个 20 nm 的窗)。常用 0.1–0.3。", required: false, minValue: 0.05, maxValue: 0.5, default: 0.2 },
    { name: "stride_fraction", type: "float", description: "相邻两次落窗之间的步长,以窗边长的比例表示。0.5 = 相邻两个窗重叠 50%(推荐)。更小 = 搜得更密。", required: false, minValue: 0.1, maxValue: 1, default: 0.5 },
    { name: "count", type: "int", description: "要交出几块互不重叠的平区。1(缺省)与历史行为**逐字一致**:只报打分最好的那一个窗。>1 时额外返回一个 `sites` 列表,从好到差排序,彼此至少相隔 `min_site_spacing_m`。", required: false, minValue: 1, maxValue: 64, default: 1 },
    { name: "min_site_spacing_m", type: "float", description: "交出的这些落点之间的最小中心距。只在 count > 1 时用得上。省略则退回窗的边长(也就是窗与窗不重叠)。**要在这些落点上扎针**的调用方,应当传两倍于自己修针避让半径的值 —— 这些落点之间不能互相污染。", unit: "m", required: false, minValue: 1e-10, maxValue: 0.00001 },
    { name: "channel", type: "str", description: "要用的形貌通道名('Z' 是标准选择)。文件里没有这个通道时,退回第一个可用通道。", required: false, default: "Z" },
    { name: "exclude_used_spots", type: "str", description: "可选:分号分隔的一串**已经用过的** (x,y) 坐标,都是米量 —— 每个值都可以带 SI 前缀:'100n,-50n;1.2u,0'。窗中心落在其中任何一个的 `min_separation_m` 之内的一律跳过,这样重试时就不会再挑中同一个点。", required: false, default: "" },
    { name: "min_separation_m", type: "float", description: "与被排除的那些点之间的最小距离,单位**米**。缺省 = 窗的边长(与用过的坑不重叠)。", unit: "m", required: false, minValue: 0, default: 0 },
    { name: "min_window_m", type: "float", description: "窗的最小**物理**边长,单位**米**。光靠 window_fraction 表达不了「至少要有 50 nm 的平坦表面」—— 50 nm 帧的 0.2 是 10 nm,根本不满足那个要求。Auto-tilt 要 >= 50 nm(最好 100 nm)。帧本身就比这个还小时,本技能**直接失败**,而不是悄悄把窗缩小。", unit: "m", required: false, minValue: 0, maxValue: 0.00001, default: 0 },
    { name: "usable_rms_m", type: "float", description: "「配得上叫可用平区」的局部残差上限。最平的一块也超过它时,本技能**失败并说「这里没有」**,而不是把最不烂的那个交出去 —— argmin 永远存在,所以不设这条线就等于永远不会放弃。留空 = 25 pm(由真机三个实测总体定出:干净台面 3-13 pm、吸附物 16-41 pm、单原子台阶 63 pm)。只在**样品或判据确实不同**时覆写,而且要写下理由。", unit: "m", required: false, minValue: 0, maxValue: 1e-8 },
    { name: "same_terrace", type: "bool", description: "要求整个窗都落在**同一个**原子台面上。只看最小 RMS 的话,可能挑中一个跨台阶、两半各自平坦的窗 —— 那对倾斜测量毫无用处,因为倾斜测量的要害正是「台面**就是**晶面」。默认关(向后兼容)。", required: false, default: false },
  ],
  tags: ["scan","analysis","flat","read"],
  category: "read",
  safetyLevel: "AUTO",
}

export const BiasWiggleSpec: SkillSpec = {
  name: "BiasWiggle",
  description: "在一个小的双极性窗口内（默认 ±4..20 mV）随机跳变偏压，跑一小段 burst，把针尖顶端推向原子级尖锐的构型 —— 相当于用软件来回拖那根偏压滑块。feedback 必须是**开**的：机理在于 |V| 越小，环路就把针尖推得越近。目标值绝不会落在零附近，变号时以允许的最大 slew 一穿而过、不作停留，每一步之后都会检查电流，整段 burst 硬上限 10 s。它是**故意**允许在扫描过程中跑的（配方就是在一帧牺牲掉的扫描框里 wiggle）。",
  parameters: [
    { name: "base_bias_v", type: "float", description: "burst 结束后要回到的偏压（通常就是成像偏压，如 0.02 V）。每一条退出路径都会把它恢复回去，abort 也不例外。", unit: "V", required: true, minValue: -10, maxValue: 10 },
    { name: "wiggle_lower_v", type: "float", description: "|target| 的最小值（V）。**不能**为零：在恒流 feedback 下，偏压接近零会让环路把针尖一路压进表面。", unit: "V", required: false, minValue: 0.0005, maxValue: 0.1, default: 0.004 },
    { name: "wiggle_upper_v", type: "float", description: "|target| 的最大值（V）。上限 ±0.1 V。", unit: "V", required: false, minValue: 0.001, maxValue: 0.1, default: 0.02 },
    { name: "dwell_min_s", type: "float", description: "在一个目标值上的最短停留时间。", unit: "s", required: false, minValue: 0.01, maxValue: 5, default: 0.05 },
    { name: "dwell_max_s", type: "float", description: "在一个目标值上的最长停留时间。", unit: "s", required: false, minValue: 0.01, maxValue: 10, default: 0.15 },
    { name: "slew_rate_v_per_s", type: "float", description: "目标值之间的最大 ramp 速率。变号时允许用到绝对上限，好让它快速穿过零点。", unit: "V/s", required: false, minValue: 0.005, maxValue: 2, default: 1 },
    { name: "burst_s", type: "float", description: "burst 总时长。硬上限 10 s。", unit: "s", required: false, minValue: 0.1, maxValue: 10, default: 5 },
    { name: "abort_current_a", type: "float", description: "任何一步只要 |I| 超过这个值，就 abort 并把偏压恢复回去。", unit: "A", required: false, minValue: 1e-11, maxValue: 0.000001, default: 5e-9 },
    { name: "seed", type: "int", description: "随机种子（0 = 非确定性）。", required: false, minValue: 0, default: 0 },
    { name: "allow_feedback_off", type: "bool", description: "即使 Z controller 关着也照跑。没有 feedback 就不存在上面那个机理，所以这件事默认会被**拒绝**。", required: false, default: false },
  ],
  capabilities: ["tip_shaping"],
  tags: ["bias","wiggle","tip","write"],
  category: "write",
  safetyLevel: "AUTO",
}

export const AssessAtomicPhaseSpec: SkillSpec = {
  name: "AssessAtomicPhase",
  description: "判断一张已保存的 .sxm 帧有没有 ATOMIC 分辨。三条互相独立的判据必须一致：原子周期带内有一个强峰、是离散的 Bragg 斑点而不是弥散的环（把真实晶格与针尖振铃分开的就是这一条）、以及 FFT 峰的锐度。只读。比 0.05 nm/px 更粗的帧会 REFUSE 判读（reasons=['scale_gate']），而不是报「没有」—— 在那个尺度上晶格本来就分不开，所以「没有原子」会是一句假话。晶格常数只对 FAST 扫描方向报（慢轴漂移让另一个方向不可信）。",
  parameters: [
    { name: "scan_path", type: "str", description: ".sxm 帧的文件路径。", required: true },
    { name: "channel", type: "str", description: "形貌通道（标准是 'Z'）。", required: false, default: "Z" },
    { name: "expected_a_nm", type: "float", description: "期望的原子行间距。留空则从衬底取；填 0 则关掉这项比较。", unit: "nm", required: false, minValue: 0, maxValue: 10 },
    { name: "substrate", type: "str", description: "衬底名。留空则从当前样品推断。", required: false, default: "" },
    { name: "snr_min", type: "float", description: "带内峰信噪比的下限。", required: false, minValue: 1, maxValue: 1000000, default: 4 },
    { name: "concentration_min", type: "float", description: "角向集中度的下限（离散 Bragg 斑点 vs 弥散环）。实测的分离度：真实晶格 97-7645，针尖振铃 1.8-3.3。", required: false, minValue: 1, maxValue: 1000000000, default: 20 },
    { name: "sharpness_min", type: "float", description: "FFT 峰凸显度的下限。", required: false, minValue: 1, maxValue: 1000000, default: 8 },
    { name: "allow_reduced_scale", type: "bool", description: "在 0.02-0.05 nm/px 的过渡带里也接受肯定结论。", required: false, default: false },
  ],
  tags: ["tip","atomic","lattice","fft","analysis","read"],
  category: "analysis",
  safetyLevel: "AUTO",
}

/** 批 1/2 的全部声明，按名字索引。 */
export const BATCH_SPECS: Readonly<Record<string, SkillSpec>> = {
  GetBias: GetBiasSpec,
  GetCurrent: GetCurrentSpec,
  GetBiasCalibration: GetBiasCalibrationSpec,
  GetSetpoint: GetSetpointSpec,
  GetZPosition: GetZPositionSpec,
  GetZControllerState: GetZControllerStateSpec,
  GetZCtrlGain: GetZCtrlGainSpec,
  GetZCtrlList: GetZCtrlListSpec,
  GetTipLift: GetTipLiftSpec,
  GetZLimitsEnabled: GetZLimitsEnabledSpec,
  GetHomeProps: GetHomePropsSpec,
  GetWithdrawRate: GetWithdrawRateSpec,
  GetScanFrame: GetScanFrameSpec,
  GetScanSpeed: GetScanSpeedSpec,
  GetScanBuffer: GetScanBufferSpec,
  GetScanXYPosition: GetScanXYPositionSpec,
  GetTipSpeed: GetTipSpeedSpec,
  GetPointShootOnOff: GetPointShootOnOffSpec,
  GetPiezoTilt: GetPiezoTiltSpec,
  GetDriftCompensation: GetDriftCompensationSpec,
  GetPiezoSensitivity: GetPiezoSensitivitySpec,
  GetPiezoXYZLimits: GetPiezoXYZLimitsSpec,
  GetMotorFreqAmp: GetMotorFreqAmpSpec,
  MotorGetPos: MotorGetPosSpec,
  GetMotorStepCounter: GetMotorStepCounterSpec,
  GetAutoApproachStatus: GetAutoApproachStatusSpec,
  GetSafeTipStatus: GetSafeTipStatusSpec,
  GetSafeTipProps: GetSafeTipPropsSpec,
  GetSafeTipSignal: GetSafeTipSignalSpec,
  GetSignalValues: GetSignalValuesSpec,
  ListSignalChannels: ListSignalChannelsSpec,
  GetSignalRange: GetSignalRangeSpec,
  GetSessionPath: GetSessionPathSpec,
  GetAcqPeriod: GetAcqPeriodSpec,
  GetRTFreq: GetRTFreqSpec,
  GetLatestScanFile: GetLatestScanFileSpec,
  SetBias: SetBiasSpec,
  SetSetpoint: SetSetpointSpec,
  ZControllerOnOff: ZControllerOnOffSpec,
  TryEngageController: TryEngageControllerSpec,
  WithdrawTip: WithdrawTipSpec,
  SafeRetract: SafeRetractSpec,
  EmergencyRetract: EmergencyRetractSpec,
  StopScan: StopScanSpec,
  StopAutoApproach: StopAutoApproachSpec,
  StopMotor: StopMotorSpec,
  StopFolMe: StopFolMeSpec,
  SetZCtrlGain: SetZCtrlGainSpec,
  SetTipLift: SetTipLiftSpec,
  SetZPosition: SetZPositionSpec,
  SetBiasRange: SetBiasRangeSpec,
  SetSessionPath: SetSessionPathSpec,
  SetScanBuffer: SetScanBufferSpec,
  SetTipSpeed: SetTipSpeedSpec,
  SetFolMeOversampling: SetFolMeOversamplingSpec,
  MoveToXY: MoveToXYSpec,
  SetPiezoTilt: SetPiezoTiltSpec,
  SetDriftCompensation: SetDriftCompensationSpec,
  SetPiezoRange: SetPiezoRangeSpec,
  SetHomeProps: SetHomePropsSpec,
  SetSwitchOffDelay: SetSwitchOffDelaySpec,
  SetCurrentGain: SetCurrentGainSpec,
  MotorMove: MotorMoveSpec,
  MotorMoveClosedLoop: MotorMoveClosedLoopSpec,
  EnableSafeTip: EnableSafeTipSpec,
  SetZLimitsEnabled: SetZLimitsEnabledSpec,
  SetBiasCalibration: SetBiasCalibrationSpec,
  SetCurrentCalibration: SetCurrentCalibrationSpec,
  SetMotorFreqAmp: SetMotorFreqAmpSpec,
  LockNanonisUI: LockNanonisUISpec,
  CreateZCtrlPreset: CreateZCtrlPresetSpec,
  AutoApproach: AutoApproachSpec,
  ApproachTip: ApproachTipSpec,
  ApplyZCtrlPreset: ApplyZCtrlPresetSpec,
  ListZCtrlPresets: ListZCtrlPresetsSpec,
  ConfigureScan: ConfigureScanSpec,
  SetScanSpeed: SetScanSpeedSpec,
  StartScan: StartScanSpec,
  WaitScanComplete: WaitScanCompleteSpec,
  SaveScan: SaveScanSpec,
  GrabScanFrameData: GrabScanFrameDataSpec,
  SetBiasRamp: SetBiasRampSpec,
  GetSignalsAddRT: GetSignalsAddRTSpec,
  GetCurrentBEEM: GetCurrentBEEMSpec,
  GetCurrentGains: GetCurrentGainsSpec,
  ScanBackgroundDelete: ScanBackgroundDeleteSpec,
  ScanBackgroundPaste: ScanBackgroundPasteSpec,
  GetPointShootProps: GetPointShootPropsSpec,
  SetPointShootExperiment: SetPointShootExperimentSpec,
  SetPointShootOnOff: SetPointShootOnOffSpec,
  GetRTOversample: GetRTOversampleSpec,
  SetRTFreq: SetRTFreqSpec,
  SetRTOversample: SetRTOversampleSpec,
  LoadLayout: LoadLayoutSpec,
  SaveLayout: SaveLayoutSpec,
  SaveSettings: SaveSettingsSpec,
  UnlockNanonisUI: UnlockNanonisUISpec,
  GetPiezoHVAInfo: GetPiezoHVAInfoSpec,
  GetPiezoHVAStatusLED: GetPiezoHVAStatusLEDSpec,
  LoadPiezoHysteresisFile: LoadPiezoHysteresisFileSpec,
  SetPiezoHysteresisOnOff: SetPiezoHysteresisOnOffSpec,
  SetPiezoHysteresisValues: SetPiezoHysteresisValuesSpec,
  SetPiezoSensitivity: SetPiezoSensitivitySpec,
  GetMiscInstrumentConfig: GetMiscInstrumentConfigSpec,
  GetPiezoConfig: GetPiezoConfigSpec,
  GetPllConfig: GetPllConfigSpec,
  GetScanPatternConfig: GetScanPatternConfigSpec,
  GetSpectroscopyConfig: GetSpectroscopyConfigSpec,
  GetTipShaperConfig: GetTipShaperConfigSpec,
  CheckScanForCrash: CheckScanForCrashSpec,
  GetLockInConfig: GetLockInConfigSpec,
  ConfigureLockIn: ConfigureLockInSpec,
  ConfigureLockInDemod: ConfigureLockInDemodSpec,
  GetDemodSignal: GetDemodSignalSpec,
  GetDemodPhase: GetDemodPhaseSpec,
  GetDemodPhasReg: GetDemodPhasRegSpec,
  GetDemodHarmonic: GetDemodHarmonicSpec,
  GetDemodLPFilter: GetDemodLPFilterSpec,
  GetDemodHPFilter: GetDemodHPFilterSpec,
  SetModSignal: SetModSignalSpec,
  SetModPhasReg: SetModPhasRegSpec,
  SetModHarmonic: SetModHarmonicSpec,
  SetDemodSyncFilter: SetDemodSyncFilterSpec,
  SetDemodRTSignals: SetDemodRTSignalsSpec,
  ListLockInPresets: ListLockInPresetsSpec,
  ApplyLockInPreset: ApplyLockInPresetSpec,
  AutoPhase: AutoPhaseSpec,
  GetDataLogStatus: GetDataLogStatusSpec,
  StartDataLog: StartDataLogSpec,
  StopDataLog: StopDataLogSpec,
  GetTcpLogStatus: GetTcpLogStatusSpec,
  StartTcpLog: StartTcpLogSpec,
  StopTcpLog: StopTcpLogSpec,
  ListScanMarkers: ListScanMarkersSpec,
  DrawScanMarker: DrawScanMarkerSpec,
  EraseScanMarkers: EraseScanMarkersSpec,
  ConfigureAtomTrack: ConfigureAtomTrackSpec,
  AtomTrackDriftComp: AtomTrackDriftCompSpec,
  AtomTrackQuickCompStart: AtomTrackQuickCompStartSpec,
  AtomTrackStatusGet: AtomTrackStatusGetSpec,
  AcquireOsciTrace: AcquireOsciTraceSpec,
  GetOsciTimebases: GetOsciTimebasesSpec,
  SetOsciTimebase: SetOsciTimebaseSpec,
  ConfigureSpectrumAnalyzer: ConfigureSpectrumAnalyzerSpec,
  SetSpectrumAnalyzerBand: SetSpectrumAnalyzerBandSpec,
  GetSpectrumAnalyzerData: GetSpectrumAnalyzerDataSpec,
  RunBiasSweep: RunBiasSweepSpec,
  GetSignalCalibration: GetSignalCalibrationSpec,
  SetAdditionalRealtimeSignals: SetAdditionalRealtimeSignalsSpec,
  SetAcquisitionPeriod: SetAcquisitionPeriodSpec,
  BiasPulse: BiasPulseSpec,
  ListNanonisScripts: ListNanonisScriptsSpec,
  GetScriptData: GetScriptDataSpec,
  GetScriptChannels: GetScriptChannelsSpec,
  RunNanonisScript: RunNanonisScriptSpec,
  StopNanonisScript: StopNanonisScriptSpec,
  DeployNanonisScript: DeployNanonisScriptSpec,
  UndeployNanonisScript: UndeployNanonisScriptSpec,
  LoadScriptLUT: LoadScriptLUTSpec,
  DeployScriptLUT: DeployScriptLUTSpec,
  SetScriptChannels: SetScriptChannelsSpec,
  SetScriptAutosave: SetScriptAutosaveSpec,
  LoadNanonisScript: LoadNanonisScriptSpec,
  SaveNanonisScript: SaveNanonisScriptSpec,
  SaveNanonisScriptLut: SaveNanonisScriptLutSpec,
  SetZLimits: SetZLimitsSpec,
  SetWithdrawRate: SetWithdrawRateSpec,
  HomeZController: HomeZControllerSpec,
  SetPiezoLimits: SetPiezoLimitsSpec,
  SetSafeTipProps: SetSafeTipPropsSpec,
  SetActiveZController: SetActiveZControllerSpec,
  ConfigurePLL: ConfigurePLLSpec,
  GetPLLStatus: GetPLLStatusSpec,
  PLLOnOff: PLLOnOffSpec,
  ConfigurePLLExcitation: ConfigurePLLExcitationSpec,
  AcquirePLLFreqSweep: AcquirePLLFreqSweepSpec,
  PLLSignalAnalyzer: PLLSignalAnalyzerSpec,
  GetPLLAddOnOff: GetPLLAddOnOffSpec,
  SetPLLAmpCtrlBandwidth: SetPLLAmpCtrlBandwidthSpec,
  GetPLLAmpCtrlOnOff: GetPLLAmpCtrlOnOffSpec,
  SetPLLAmpCtrlSetpnt: SetPLLAmpCtrlSetpntSpec,
  GetPLLDemodFilter: GetPLLDemodFilterSpec,
  SetPLLDemodFilter: SetPLLDemodFilterSpec,
  GetPLLDemodHarmonic: GetPLLDemodHarmonicSpec,
  GetPLLDemodInput: GetPLLDemodInputSpec,
  SetPLLDemodInput: SetPLLDemodInputSpec,
  SetPLLDemodPhasRef: SetPLLDemodPhasRefSpec,
  GetPLLExcRange: GetPLLExcRangeSpec,
  SetPLLFreqExcOverwrite: SetPLLFreqExcOverwriteSpec,
  GetPLLFreqRange: GetPLLFreqRangeSpec,
  SetPLLFreqRange: SetPLLFreqRangeSpec,
  PLLFreqShiftAutoCenter: PLLFreqShiftAutoCenterSpec,
  GetPLLInpCalibr: GetPLLInpCalibrSpec,
  SetPLLInpCalibr: SetPLLInpCalibrSpec,
  GetPLLInpProps: GetPLLInpPropsSpec,
  SetPLLInpProps: SetPLLInpPropsSpec,
  SetPLLInpRange: SetPLLInpRangeSpec,
  PLLPerfectPLLUpdtZTC: PLLPerfectPLLUpdtZTCSpec,
  SetPLLPhasCtrlBandwidth: SetPLLPhasCtrlBandwidthSpec,
  GetPLLPhasCtrlOnOff: GetPLLPhasCtrlOnOffSpec,
  GetPLLSignalAnlzrCh: GetPLLSignalAnlzrChSpec,
  GetPLLSignalAnlzrFFTProps: GetPLLSignalAnlzrFFTPropsSpec,
  GetPLLSignalAnlzrTimebase: GetPLLSignalAnlzrTimebaseSpec,
  PLLSignalAnlzrTrigAuto: PLLSignalAnlzrTrigAutoSpec,
  SetPLLSignalAnlzrTrig: SetPLLSignalAnlzrTrigSpec,
  GetPLLFreqSwpParams: GetPLLFreqSwpParamsSpec,
  StopPLLFreqSwp: StopPLLFreqSwpSpec,
  ConfigurePiController: ConfigurePiControllerSpec,
  SetPiControllerOnOff: SetPiControllerOnOffSpec,
  GetPiController: GetPiControllerSpec,
  SetGenericPiOutput: SetGenericPiOutputSpec,
  GetGenericPiController: GetGenericPiControllerSpec,
  ConfigurePreamp: ConfigurePreampSpec,
  GetPreamp: GetPreampSpec,
  RunPllZoomFft: RunPllZoomFftSpec,
  GetPllZoomFftData: GetPllZoomFftDataSpec,
  RunPllPhaseSweep: RunPllPhaseSweepSpec,
  StopPllPhaseSweep: StopPllPhaseSweepSpec,
  ConfigurePllSignalAnalyzer: ConfigurePllSignalAnalyzerSpec,
  GetPllSignalAnalyzerData: GetPllSignalAnalyzerDataSpec,
  ConfigureOcSync: ConfigureOcSyncSpec,
  GetOcSync: GetOcSyncSpec,
  ConfigureTipRecorder: ConfigureTipRecorderSpec,
  GetTipRecorderData: GetTipRecorderDataSpec,
  ConfigureKelvinController: ConfigureKelvinControllerSpec,
  SetKelvinControllerOnOff: SetKelvinControllerOnOffSpec,
  GetKelvinController: GetKelvinControllerSpec,
  RunCpdCompensation: RunCpdCompensationSpec,
  GetCpdCompensation: GetCpdCompensationSpec,
  ConfigureInterferometer: ConfigureInterferometerSpec,
  SetInterferometerOnOff: SetInterferometerOnOffSpec,
  GetInterferometer: GetInterferometerSpec,
  ConfigureBeamDeflection: ConfigureBeamDeflectionSpec,
  GetBeamDeflection: GetBeamDeflectionSpec,
  AutoZeroBeamDeflection: AutoZeroBeamDeflectionSpec,
  SetLaserOnOff: SetLaserOnOffSpec,
  SetLaserPower: SetLaserPowerSpec,
  GetLaser: GetLaserSpec,
  SetProbeZController: SetProbeZControllerSpec,
  GetProbeZController: GetProbeZControllerSpec,
  WithdrawProbe: WithdrawProbeSpec,
  ConfigureProbeScanner: ConfigureProbeScannerSpec,
  MoveProbeXY: MoveProbeXYSpec,
  StopProbeScanner: StopProbeScannerSpec,
  SetProbeBias: SetProbeBiasSpec,
  PulseProbeBias: PulseProbeBiasSpec,
  GetProbeBias: GetProbeBiasSpec,
  GetProbeCurrent: GetProbeCurrentSpec,
  ConfigureProbeCurrentGain: ConfigureProbeCurrentGainSpec,
  ConfigureHighSpeedSweep: ConfigureHighSpeedSweepSpec,
  RunHighSpeedSweep: RunHighSpeedSweepSpec,
  StopHighSpeedSweep: StopHighSpeedSweepSpec,
  GetHighSpeedSweepStatus: GetHighSpeedSweepStatusSpec,
  ConfigureRfGenerator: ConfigureRfGeneratorSpec,
  StartRfGenerator: StartRfGeneratorSpec,
  StopRfGenerator: StopRfGeneratorSpec,
  RunRfFrequencySweep: RunRfFrequencySweepSpec,
  GetRfGeneratorStatus: GetRfGeneratorStatusSpec,
  ConfigureHighResScope: ConfigureHighResScopeSpec,
  RunHighResScope: RunHighResScopeSpec,
  GetHighResScopeData: GetHighResScopeDataSpec,
  GetHighResScopeStatus: GetHighResScopeStatusSpec,
  ConfigureDualScope: ConfigureDualScopeSpec,
  GetDualScopeData: GetDualScopeDataSpec,
  ConfigureSignalChart: ConfigureSignalChartSpec,
  GetUserOutputLimits: GetUserOutputLimitsSpec,
  GetUserOutputMode: GetUserOutputModeSpec,
  GetUserOutputMonitorChannel: GetUserOutputMonitorChannelSpec,
  GetDigitalLineTTL: GetDigitalLineTTLSpec,
  GetCalculatedOutputConfig: GetCalculatedOutputConfigSpec,
  SetUserOutput: SetUserOutputSpec,
  SetUserOutputMode: SetUserOutputModeSpec,
  SetUserOutputMonitorChannel: SetUserOutputMonitorChannelSpec,
  SetUserOutputLimits: SetUserOutputLimitsSpec,
  SetUserOutputCalibration: SetUserOutputCalibrationSpec,
  ConfigureCalculatedOutput: ConfigureCalculatedOutputSpec,
  PulseDigitalLine: PulseDigitalLineSpec,
  SetDigitalLineStatus: SetDigitalLineStatusSpec,
  ConfigureDigitalLine: ConfigureDigitalLineSpec,
  ConfigureBiasSweep: ConfigureBiasSweepSpec,
  AcquireBiasSweep: AcquireBiasSweepSpec,
  ConfigureLockInSweep: ConfigureLockInSweepSpec,
  AcquireLockInSweep: AcquireLockInSweepSpec,
  GetLockInSweepLimits: GetLockInSweepLimitsSpec,
  GetLockInSweepProps: GetLockInSweepPropsSpec,
  GetLockInSweepSignal: GetLockInSweepSignalSpec,
  GenSwpAcqChsGet: GenSwpAcqChsGetSpec,
  GenSwpPropsGet: GenSwpPropsGetSpec,
  GenSwpStop: GenSwpStopSpec,
  GenSwpSwpSignalGet: GenSwpSwpSignalGetSpec,
  OpenPatternExperiment: OpenPatternExperimentSpec,
  PausePatternExperiment: PausePatternExperimentSpec,
  SetPatternLine: SetPatternLineSpec,
  SetPatternCloud: SetPatternCloudSpec,
  GetPatternCloud: GetPatternCloudSpec,
  GetPatternProps: GetPatternPropsSpec,
  ConfigureWaveform: ConfigureWaveformSpec,
  StartWaveform: StartWaveformSpec,
  StopWaveform: StopWaveformSpec,
  GetWaveformStatus: GetWaveformStatusSpec,
  SetWaveformIdleValue: SetWaveformIdleValueSpec,
  SetWaveformChannelOnOff: SetWaveformChannelOnOffSpec,
  SetSpectroscopyTtlSync: SetSpectroscopyTtlSyncSpec,
  SetSpectroscopyPulseSync: SetSpectroscopyPulseSyncSpec,
  SetSpectroscopyZControl: SetSpectroscopyZControlSpec,
  SetZSpectroscopySecondRetract: SetZSpectroscopySecondRetractSpec,
  SetMlsLockinPerSegment: SetMlsLockinPerSegmentSpec,
  GetSpectroscopyStatus: GetSpectroscopyStatusSpec,
  QuitNanonis: QuitNanonisSpec,
  SetMultiPass: SetMultiPassSpec,
  LoadMultiPassConfig: LoadMultiPassConfigSpec,
  SaveMultiPassConfig: SaveMultiPassConfigSpec,
  WaitForScanEndBlocking: WaitForScanEndBlockingSpec,
  SetWaveformSignal: SetWaveformSignalSpec,
  SetLockInDemodPhaseRegister: SetLockInDemodPhaseRegisterSpec,
  SetLockInFrequencySweepSignal: SetLockInFrequencySweepSignalSpec,
  SetPllExcitationAdd: SetPllExcitationAddSpec,
  SetPllDemodHarmonic: SetPllDemodHarmonicSpec,
  ConfigureScopeTrigger: ConfigureScopeTriggerSpec,
  SetPatternExperiment: SetPatternExperimentSpec,
  SetPointShootProps: SetPointShootPropsSpec,
  ReadTipOscillationAmplitude: ReadTipOscillationAmplitudeSpec,
  CheckTipCrashByAmplitude: CheckTipCrashByAmplitudeSpec,
  CheckPiezoRange: CheckPiezoRangeSpec,
  BiasPulseWithReadback: BiasPulseWithReadbackSpec,
  TipShapeWithReadback: TipShapeWithReadbackSpec,
  CaptureSignalBuffer: CaptureSignalBufferSpec,
  GetChamberPressure: GetChamberPressureSpec,
  GetTemperature: GetTemperatureSpec,
  AcquireSTS: AcquireSTSSpec,
  ConfigureSTS: ConfigureSTSSpec,
  ConfigureZSpectr: ConfigureZSpectrSpec,
  AcquireZSpectr: AcquireZSpectrSpec,
  ConfigureSTSTiming: ConfigureSTSTimingSpec,
  StopSTS: StopSTSSpec,
  StopZSpectr: StopZSpectrSpec,
  ConfigureSTSChannels: ConfigureSTSChannelsSpec,
  ConfigureZSpectrTiming: ConfigureZSpectrTimingSpec,
  GetSTSChannels: GetSTSChannelsSpec,
  SetSTSChannels: SetSTSChannelsSpec,
  GetSTSLimits: GetSTSLimitsSpec,
  SetSTSAdvancedProps: SetSTSAdvancedPropsSpec,
  GetSTSTiming: GetSTSTimingSpec,
  GetSTSAltZCtrl: GetSTSAltZCtrlSpec,
  GetZSpectrChannels: GetZSpectrChannelsSpec,
  SetZSpectrChannels: SetZSpectrChannelsSpec,
  GetZSpectrRange: GetZSpectrRangeSpec,
  SetZSpectrRange: SetZSpectrRangeSpec,
  GetZSpectrRetract: GetZSpectrRetractSpec,
  SetZSpectrRetract: SetZSpectrRetractSpec,
  GetSTSDigSync: GetSTSDigSyncSpec,
  GetSTSTTLSync: GetSTSTTLSyncSpec,
  GetSTSPulseSeqSync: GetSTSPulseSeqSyncSpec,
  GetSTSZOffRevert: GetSTSZOffRevertSpec,
  GetSTSMLSLockinPerSeg: GetSTSMLSLockinPerSegSpec,
  SetSTSMLSMode: SetSTSMLSModeSpec,
  SetSTSMLSVals: SetSTSMLSValsSpec,
  SetSTSSafeCond1: SetSTSSafeCond1Spec,
  GetSTSSafeCond1: GetSTSSafeCond1Spec,
  SetSTSSafeCond2: SetSTSSafeCond2Spec,
  SetZSpectrAdvProps: SetZSpectrAdvPropsSpec,
  GetZSpectrDigSync: GetZSpectrDigSyncSpec,
  GetZSpectrPulseSeqSync: GetZSpectrPulseSeqSyncSpec,
  GetZSpectrRetract2nd: GetZSpectrRetract2ndSpec,
  SetZSpectrRetractDelay: SetZSpectrRetractDelaySpec,
  GetZSpectrTTLSync: GetZSpectrTTLSyncSpec,
  GetZSpectrTiming: GetZSpectrTimingSpec,
  ExtractClusters: ExtractClustersSpec,
  AssessClusterRoundness: AssessClusterRoundnessSpec,
  SelectPokedCluster: SelectPokedClusterSpec,
  VerifyAdatomAt: VerifyAdatomAtSpec,
  MeasureStepHeight: MeasureStepHeightSpec,
  AssessFrameTrust: AssessFrameTrustSpec,
  LocateStepEdge: LocateStepEdgeSpec,
  AssessAtomicLines: AssessAtomicLinesSpec,
  AssessFrameCorrugation: AssessFrameCorrugationSpec,
  AssessScanTexture: AssessScanTextureSpec,
  MeasureLatticeCell: MeasureLatticeCellSpec,
  AssessAtomicResolution: AssessAtomicResolutionSpec,
  AnalyseAtomicLattice: AnalyseAtomicLatticeSpec,
  LoadScanFrameFromFile: LoadScanFrameFromFileSpec,
  ParseRegions: ParseRegionsSpec,
  ComputeDriftVector: ComputeDriftVectorSpec,
  SubtractPlane_RANSAC: SubtractPlane_RANSACSpec,
  LevelLines_Median: LevelLines_MedianSpec,
  FindEmptySpot: FindEmptySpotSpec,
  CorrectDrift_XCorr: CorrectDrift_XCorrSpec,
  SubtractPoly2D: SubtractPoly2DSpec,
  Destripe_MorphOpen: Destripe_MorphOpenSpec,
  AutoCrop_UnscannedRegion: AutoCrop_UnscannedRegionSpec,
  Denoise_AE: Denoise_AESpec,
  DetectAtomJump: DetectAtomJumpSpec,
  ScanAt: ScanAtSpec,
  FullScan: FullScanSpec,
  TipShape: TipShapeSpec,
  TipPulse: TipPulseSpec,
  TipConditioningSelfCheck: TipConditioningSelfCheckSpec,
  TipForgeSelfCheck: TipForgeSelfCheckSpec,
  MonitorCurrent: MonitorCurrentSpec,
  MonitorCurrentFFT: MonitorCurrentFFTSpec,
  ClassifyUnexplainedCurrent: ClassifyUnexplainedCurrentSpec,
  RecoverTipFromSaturation: RecoverTipFromSaturationSpec,
  WaitForThermalSettle: WaitForThermalSettleSpec,
  WatchScanLines: WatchScanLinesSpec,
  BiasSettleChange: BiasSettleChangeSpec,
  AcquirePSD: AcquirePSDSpec,
  BatchRegionsScan: BatchRegionsScanSpec,
  ReadCalibrations: ReadCalibrationsSpec,
  RetractForSampleChange: RetractForSampleChangeSpec,
  RelocateCoarseXY: RelocateCoarseXYSpec,
  StepCoarseXY: StepCoarseXYSpec,
  AnalyzeScanImage: AnalyzeScanImageSpec,
  AutoProcessScanBatch: AutoProcessScanBatchSpec,
  AssessTipSharpness: AssessTipSharpnessSpec,
  AssessTipFromSpectrum: AssessTipFromSpectrumSpec,
  InvertForceSaderJarvis: InvertForceSaderJarvisSpec,
  AssessAtomicConsistency: AssessAtomicConsistencySpec,
  AnalyzeFrameTilt: AnalyzeFrameTiltSpec,
  TiltProbeCircle: TiltProbeCircleSpec,
  TiltCalibrate: TiltCalibrateSpec,
  AutoTilt: AutoTiltSpec,
  FindCleanSpot: FindCleanSpotSpec,
  FindFlatRegion: FindFlatRegionSpec,
  BiasWiggle: BiasWiggleSpec,
  AssessAtomicPhase: AssessAtomicPhaseSpec,
}

/** 有行为轨迹金样的那些（两个进针技能不在内，见导出脚本的 TRACE_SKIP）。 */
export const TRACED = ["GetBias","GetCurrent","GetBiasCalibration","GetSetpoint","GetZPosition","GetZControllerState","GetZCtrlGain","GetZCtrlList","GetTipLift","GetZLimitsEnabled","GetHomeProps","GetWithdrawRate","GetScanFrame","GetScanSpeed","GetScanBuffer","GetScanXYPosition","GetTipSpeed","GetPointShootOnOff","GetPiezoTilt","GetDriftCompensation","GetPiezoSensitivity","GetPiezoXYZLimits","GetMotorFreqAmp","MotorGetPos","GetMotorStepCounter","GetAutoApproachStatus","GetSafeTipStatus","GetSafeTipProps","GetSafeTipSignal","GetSignalValues","ListSignalChannels","GetSignalRange","GetSessionPath","GetAcqPeriod","GetRTFreq","GetLatestScanFile","SetBias","SetSetpoint","ZControllerOnOff","TryEngageController","WithdrawTip","SafeRetract","EmergencyRetract","StopScan","StopAutoApproach","StopMotor","StopFolMe","SetZCtrlGain","SetTipLift","SetZPosition","SetBiasRange","SetSessionPath","SetScanBuffer","SetTipSpeed","SetFolMeOversampling","MoveToXY","SetPiezoTilt","SetDriftCompensation","SetPiezoRange","SetHomeProps","SetSwitchOffDelay","SetCurrentGain","MotorMove","MotorMoveClosedLoop","EnableSafeTip","SetZLimitsEnabled","SetBiasCalibration","SetCurrentCalibration","SetMotorFreqAmp","LockNanonisUI","CreateZCtrlPreset","AutoApproach","ApproachTip","ApplyZCtrlPreset","ListZCtrlPresets","ConfigureScan","SetScanSpeed","StartScan","WaitScanComplete","SaveScan","GrabScanFrameData","SetBiasRamp","GetSignalsAddRT","GetCurrentBEEM","GetCurrentGains","ScanBackgroundDelete","ScanBackgroundPaste","GetPointShootProps","SetPointShootExperiment","SetPointShootOnOff","GetRTOversample","SetRTFreq","SetRTOversample","LoadLayout","SaveLayout","SaveSettings","UnlockNanonisUI","GetPiezoHVAInfo","GetPiezoHVAStatusLED","LoadPiezoHysteresisFile","SetPiezoHysteresisOnOff","SetPiezoHysteresisValues","SetPiezoSensitivity","GetMiscInstrumentConfig","GetPiezoConfig","GetPllConfig","GetScanPatternConfig","GetSpectroscopyConfig","GetTipShaperConfig","CheckScanForCrash","GetLockInConfig","ConfigureLockIn","ConfigureLockInDemod","GetDemodSignal","GetDemodPhase","GetDemodPhasReg","GetDemodHarmonic","GetDemodLPFilter","GetDemodHPFilter","SetModSignal","SetModPhasReg","SetModHarmonic","SetDemodSyncFilter","SetDemodRTSignals","ListLockInPresets","ApplyLockInPreset","AutoPhase","GetDataLogStatus","StartDataLog","StopDataLog","GetTcpLogStatus","StartTcpLog","StopTcpLog","ListScanMarkers","DrawScanMarker","EraseScanMarkers","ConfigureAtomTrack","AtomTrackDriftComp","AtomTrackQuickCompStart","AtomTrackStatusGet","AcquireOsciTrace","GetOsciTimebases","SetOsciTimebase","ConfigureSpectrumAnalyzer","SetSpectrumAnalyzerBand","GetSpectrumAnalyzerData","RunBiasSweep","GetSignalCalibration","SetAdditionalRealtimeSignals","SetAcquisitionPeriod","BiasPulse","ListNanonisScripts","GetScriptData","GetScriptChannels","RunNanonisScript","StopNanonisScript","DeployNanonisScript","UndeployNanonisScript","LoadScriptLUT","DeployScriptLUT","SetScriptChannels","SetScriptAutosave","LoadNanonisScript","SaveNanonisScript","SaveNanonisScriptLut","SetZLimits","SetWithdrawRate","HomeZController","SetPiezoLimits","SetSafeTipProps","SetActiveZController","ConfigurePLL","GetPLLStatus","PLLOnOff","ConfigurePLLExcitation","AcquirePLLFreqSweep","PLLSignalAnalyzer","GetPLLAddOnOff","SetPLLAmpCtrlBandwidth","GetPLLAmpCtrlOnOff","SetPLLAmpCtrlSetpnt","GetPLLDemodFilter","SetPLLDemodFilter","GetPLLDemodHarmonic","GetPLLDemodInput","SetPLLDemodInput","SetPLLDemodPhasRef","GetPLLExcRange","SetPLLFreqExcOverwrite","GetPLLFreqRange","SetPLLFreqRange","PLLFreqShiftAutoCenter","GetPLLInpCalibr","SetPLLInpCalibr","GetPLLInpProps","SetPLLInpProps","SetPLLInpRange","PLLPerfectPLLUpdtZTC","SetPLLPhasCtrlBandwidth","GetPLLPhasCtrlOnOff","GetPLLSignalAnlzrCh","GetPLLSignalAnlzrFFTProps","GetPLLSignalAnlzrTimebase","PLLSignalAnlzrTrigAuto","SetPLLSignalAnlzrTrig","GetPLLFreqSwpParams","StopPLLFreqSwp","ConfigurePiController","SetPiControllerOnOff","GetPiController","SetGenericPiOutput","GetGenericPiController","ConfigurePreamp","GetPreamp","RunPllZoomFft","GetPllZoomFftData","RunPllPhaseSweep","StopPllPhaseSweep","ConfigurePllSignalAnalyzer","GetPllSignalAnalyzerData","ConfigureOcSync","GetOcSync","ConfigureTipRecorder","GetTipRecorderData","ConfigureKelvinController","SetKelvinControllerOnOff","GetKelvinController","RunCpdCompensation","GetCpdCompensation","ConfigureInterferometer","SetInterferometerOnOff","GetInterferometer","ConfigureBeamDeflection","GetBeamDeflection","AutoZeroBeamDeflection","SetLaserOnOff","SetLaserPower","GetLaser","SetProbeZController","GetProbeZController","WithdrawProbe","ConfigureProbeScanner","MoveProbeXY","StopProbeScanner","SetProbeBias","PulseProbeBias","GetProbeBias","GetProbeCurrent","ConfigureProbeCurrentGain","ConfigureHighSpeedSweep","RunHighSpeedSweep","StopHighSpeedSweep","GetHighSpeedSweepStatus","ConfigureRfGenerator","StartRfGenerator","StopRfGenerator","RunRfFrequencySweep","GetRfGeneratorStatus","ConfigureHighResScope","RunHighResScope","GetHighResScopeData","GetHighResScopeStatus","ConfigureDualScope","GetDualScopeData","ConfigureSignalChart","GetUserOutputLimits","GetUserOutputMode","GetUserOutputMonitorChannel","GetDigitalLineTTL","GetCalculatedOutputConfig","SetUserOutput","SetUserOutputMode","SetUserOutputMonitorChannel","SetUserOutputLimits","SetUserOutputCalibration","ConfigureCalculatedOutput","PulseDigitalLine","SetDigitalLineStatus","ConfigureDigitalLine","ConfigureBiasSweep","AcquireBiasSweep","ConfigureLockInSweep","AcquireLockInSweep","GetLockInSweepLimits","GetLockInSweepProps","GetLockInSweepSignal","GenSwpAcqChsGet","GenSwpPropsGet","GenSwpStop","GenSwpSwpSignalGet","OpenPatternExperiment","PausePatternExperiment","SetPatternLine","SetPatternCloud","GetPatternCloud","GetPatternProps","ConfigureWaveform","StartWaveform","StopWaveform","GetWaveformStatus","SetWaveformIdleValue","SetWaveformChannelOnOff","SetSpectroscopyTtlSync","SetSpectroscopyPulseSync","SetSpectroscopyZControl","SetZSpectroscopySecondRetract","SetMlsLockinPerSegment","GetSpectroscopyStatus","QuitNanonis","SetMultiPass","LoadMultiPassConfig","SaveMultiPassConfig","WaitForScanEndBlocking","SetWaveformSignal","SetLockInDemodPhaseRegister","SetLockInFrequencySweepSignal","SetPllExcitationAdd","SetPllDemodHarmonic","ConfigureScopeTrigger","SetPatternExperiment","SetPointShootProps","ReadTipOscillationAmplitude","CheckTipCrashByAmplitude","CheckPiezoRange","BiasPulseWithReadback","TipShapeWithReadback","CaptureSignalBuffer","GetChamberPressure","GetTemperature","AcquireSTS","ConfigureSTS","ConfigureZSpectr","AcquireZSpectr","ConfigureSTSTiming","StopSTS","StopZSpectr","ConfigureSTSChannels","ConfigureZSpectrTiming","GetSTSChannels","SetSTSChannels","GetSTSLimits","SetSTSAdvancedProps","GetSTSTiming","GetSTSAltZCtrl","GetZSpectrChannels","SetZSpectrChannels","GetZSpectrRange","SetZSpectrRange","GetZSpectrRetract","SetZSpectrRetract","GetSTSDigSync","GetSTSTTLSync","GetSTSPulseSeqSync","GetSTSZOffRevert","GetSTSMLSLockinPerSeg","SetSTSMLSMode","SetSTSMLSVals","SetSTSSafeCond1","GetSTSSafeCond1","SetSTSSafeCond2","SetZSpectrAdvProps","GetZSpectrDigSync","GetZSpectrPulseSeqSync","GetZSpectrRetract2nd","SetZSpectrRetractDelay","GetZSpectrTTLSync","GetZSpectrTiming","ExtractClusters","AssessClusterRoundness","SelectPokedCluster","VerifyAdatomAt","MeasureStepHeight","AssessFrameTrust","LocateStepEdge","AssessAtomicLines","AssessFrameCorrugation","AssessScanTexture","MeasureLatticeCell","AssessAtomicResolution","AnalyseAtomicLattice","LoadScanFrameFromFile","ParseRegions","ComputeDriftVector","SubtractPlane_RANSAC","LevelLines_Median","FindEmptySpot","CorrectDrift_XCorr","SubtractPoly2D","Destripe_MorphOpen","AutoCrop_UnscannedRegion","Denoise_AE","DetectAtomJump","ScanAt","FullScan","TipShape","TipPulse","TipConditioningSelfCheck","TipForgeSelfCheck","MonitorCurrent","MonitorCurrentFFT","ClassifyUnexplainedCurrent","RecoverTipFromSaturation","WaitForThermalSettle","WatchScanLines","BiasSettleChange","AcquirePSD","BatchRegionsScan","ReadCalibrations","RetractForSampleChange","RelocateCoarseXY","StepCoarseXY","AnalyzeScanImage","AutoProcessScanBatch","AssessTipSharpness","AssessTipFromSpectrum","InvertForceSaderJarvis","AssessAtomicConsistency","AnalyzeFrameTilt","TiltProbeCircle","TiltCalibrate","AutoTilt","FindCleanSpot","FindFlatRegion","BiasWiggle","AssessAtomicPhase"] as const
