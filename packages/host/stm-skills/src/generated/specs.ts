// 由 `node scripts/gen-skill-specs.ts` 生成，**不要手改**。
// 源：spec/golden/skills.json（旧仓 SkillRegistry.discover() + _get_metadata_raw）
//
// 批 1 只读 L0 36 个 · 批 2 写/硬闸/DANGEROUS/L1 37 个 · 批 2b 参数组 2 个 · 批 3a 扫描主链 6 个 · 批 3b 组合 1 个
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
}

/** 有行为轨迹金样的那些（两个进针技能不在内，见导出脚本的 TRACE_SKIP）。 */
export const TRACED = ["GetBias","GetCurrent","GetBiasCalibration","GetSetpoint","GetZPosition","GetZControllerState","GetZCtrlGain","GetZCtrlList","GetTipLift","GetZLimitsEnabled","GetHomeProps","GetWithdrawRate","GetScanFrame","GetScanSpeed","GetScanBuffer","GetScanXYPosition","GetTipSpeed","GetPointShootOnOff","GetPiezoTilt","GetDriftCompensation","GetPiezoSensitivity","GetPiezoXYZLimits","GetMotorFreqAmp","MotorGetPos","GetMotorStepCounter","GetAutoApproachStatus","GetSafeTipStatus","GetSafeTipProps","GetSafeTipSignal","GetSignalValues","ListSignalChannels","GetSignalRange","GetSessionPath","GetAcqPeriod","GetRTFreq","GetLatestScanFile","SetBias","SetSetpoint","ZControllerOnOff","TryEngageController","WithdrawTip","SafeRetract","EmergencyRetract","StopScan","StopAutoApproach","StopMotor","StopFolMe","SetZCtrlGain","SetTipLift","SetZPosition","SetBiasRange","SetSessionPath","SetScanBuffer","SetTipSpeed","SetFolMeOversampling","MoveToXY","SetPiezoTilt","SetDriftCompensation","SetPiezoRange","SetHomeProps","SetSwitchOffDelay","SetCurrentGain","MotorMove","MotorMoveClosedLoop","EnableSafeTip","SetZLimitsEnabled","SetBiasCalibration","SetCurrentCalibration","SetMotorFreqAmp","LockNanonisUI","CreateZCtrlPreset","AutoApproach","ApproachTip","ApplyZCtrlPreset","ListZCtrlPresets","ConfigureScan","SetScanSpeed","StartScan","WaitScanComplete","SaveScan","GrabScanFrameData","SetBiasRamp"] as const
