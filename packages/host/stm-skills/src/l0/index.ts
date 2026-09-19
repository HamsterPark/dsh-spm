/**
 * 已移植的技能，按名字索引。
 *
 * **它就是进度表**：`traces.test.ts` 拿它的键去金样里取轨迹，
 * 少写一个技能只是少一组测试，写错一个技能会当场变红。
 */
import type { Skill } from 'dsh-spm-kernel'
import { CORE_READS } from './reads-core.js'
import { HW_READS } from './reads-hw.js'
import { GetZControllerState } from './zctrl-state.js'
import { SIMPLE_WRITES } from './writes-simple.js'
import { VERIFIED_WRITES } from './writes-verified.js'
import { GATED_WRITES } from './writes-gated.js'
import { MoveToXY } from './move.js'
import { SafeRetract } from './safe-retract.js'
import { TryEngageController } from './engage.js'
import { SCAN_CHAIN } from './scan.js'
import { ConfigureScan } from './configure-scan.js'
import { StartScan } from './start-scan.js'
import { FRAMES_PRESETS } from './frames.js'
import { ZCTRL_PRESETS } from './zctrl-presets.js'
import { TAIL_L0 } from './tail-l0.js'
import { CONFIG_READS } from './reads-config.js'
import { CheckScanForCrash } from './crash.js'
import { LOCKIN } from './lockin.js'
import { DATALOG_MARKS } from './datalog-marks.js'
import { LOCKIN_PRESETS } from './lockin-presets.js'
import { ATOM_TRACK } from './atom-track.js'
import { OSCI } from './osci.js'
import { SPECTRUM } from './spectrum.js'
import { BIAS_SWEEP } from './bias-sweep.js'
import { NANONIS_SCRIPT } from './nanonis-script.js'
import { SCRIPT_FILES } from './script-files.js'
import { LIMITS } from './limits.js'
import { PLL } from './pll.js'
// ── 批 3g（optional_* 五族）在这一行下面加 import ──
import { OPTIONAL_CONTROLLERS } from './optional-controllers.js'
import { OPTIONAL_AFM } from './optional-afm.js'
import { OPTIONAL_MULTIPROBE } from './optional-multiprobe.js'
import { OPTIONAL_SWEEPERS } from './optional-sweepers.js'
import { OPTIONAL_SCOPES } from './optional-scopes.js'
// ── 批 3h（输出 / 扫频 / 图样）在这一行下面加 import ──
import { USER_OUTPUT } from './user-output.js'
import { SWEEP } from './sweep.js'
import { PATTERN } from './pattern.js'
import { WAVEFORM } from './waveform.js'
import { SPECTROSCOPY_SYNC } from './spectroscopy-sync.js'
import { ADVANCED_OPS } from './advanced-ops.js'
// ── 批 3i（光学台 / 杂项 setter / 单件）在这一行下面加 import ──
// ── 批 3j（流式读回一族）在这一行下面加 import ──
import { READBACK_STREAM } from './readback-skills.js'
// ── 批 3k（环境读）在这一行下面加 import ──

// ── 批 3l（spectroscopy 整族）在这一行下面加 import ──
import { SPECTROSCOPY } from './spectroscopy.js'

// ── 批 4a（分析技能第一批）在这一行下面加 import ──

// ── 批 4b（晶格判据底座 + 原子分辨判定一族）在这一行下面加 import ──
import { ANALYSIS_LATTICE } from './analysis-lattice.js'

// ── 批 4c（paper 数据处理 + scan_frame 一族）在这一行下面加 import ──
import { PAPER_DATA } from './paper-data.js'
import { PAPER_IMAGE } from './paper-image.js'
import { PAPER_CROP } from './paper-crop.js'
import { SCAN_FRAME_OFFLINE } from './scan-frame-offline.js'

// ── 批 4d（composite.scan_at + 撞针追踪）在这一行下面加 import ──

// ── 批 5a（针尖登记表底座 + TipPulse/TipShape + 两个 fail-open 自检）在这一行下面加 import ──
import { TipShape } from './tip-shape.js'
import { TIP_CONDITIONING } from './tip-selfcheck.js'
import { TipPulse } from '../composite/tip-pulse.js'

// ── 批 5b（A 档零散一批（各自自足，不压子系统））在这一行下面加 import ──
import { CURRENT_MONITOR } from './current-monitor.js'
import { CURRENT_ORIGIN } from './current-origin.js'
import { THERMAL_SETTLE } from './thermal-settle.js'
import { SCAN_WATCH } from './scan-watch.js'
import { ACQUIRE_PSD } from './acquire-psd.js'
import { BiasSettleChange } from '../composite/bias-settle.js'
import { BatchRegionsScan } from '../composite/batch-regions-scan.js'

// ── 批 5c（仪器档案 + Z 稳定 + 粗动驱动三个子系统）在这一行下面加 import ──

// ── 批 6a（特异化流程 _tip_phases 六个组合技能）在这一行下面加 import ──

// ── 批 6b（vision 的 scan_prep 链）在这一行下面加 import ──
import { SCAN_PREP_SKILLS } from './scan-prep-skills.js'

// ── 批 6c（批 5b 欠下的数值原语 + 晶格一族剩余）在这一行下面加 import ──

// ── 批 7a-1（vision/tilt 一族 + AnalyzeFrameTilt + AutoTilt）在这一行下面加 import ──
import { AnalyzeFrameTilt } from './frame-tilt.js'
import { TiltProbeCircle } from './tilt-probe.js'
import { AutoTilt, TiltCalibrate } from '../composite/auto-tilt.js'

// ── 批 7a-2（实验地图层 + FindCleanSpot）在这一行下面加 import ──
import { CLEAN_SPOT } from './clean-spot.js'

// ── 批 7a-3（kde_layers + FindFlatRegion + BiasWiggle）在这一行下面加 import ──

// ── 批 7b-1（封锁账闭包化 + AssessAtomicPhase + 两条已解封锁的流程）在这一行下面加 import ──

// ── 批 7b-2（势垒链与线缆（8 个技能 / 7 个模块））在这一行下面加 import ──

// ── 批 7b-3（composite 零新原语五个 + paper 四个纯函数）在这一行下面加 import ──
import { ANALYSIS_FLAT_REGION } from './analysis-flat-region.js'
import { BIAS_WIGGLE } from './bias-wiggle.js'
import { ANALYSIS_TIP } from './analysis-tip.js'
import { ANALYSIS_FORCE } from './analysis-force.js'
import { ANALYSIS_MULTIFRAME } from './analysis-multiframe.js'
import { CALIBRATIONS } from './calibrations.js'
import { RetractForSampleChange } from '../composite/retract-for-sample-change.js'
import { RelocateCoarseXY } from '../composite/relocate-coarse-xy.js'
import { StepCoarseXY } from '../composite/step-coarse-xy.js'
// 组合技能也从这个锚点走 —— 底部那几行是没有锚点的公共区
import { ScanAt } from '../composite/scan-at.js'
import { FullScan } from '../composite/full-scan.js'
import { ANALYSIS_CLUSTERS } from './analysis-clusters.js'
import { ANALYSIS_FRAMES } from './analysis-frames.js'
import { ANALYSIS_LINES } from './analysis-lines.js'
import { ENVIRONMENT } from './environment.js'
import { MISC_SETTERS } from './misc-setters.js'
import { QPLUS } from './qplus.js'
import { PIEZO_CHECK } from './piezo-check.js'
// L1：装在 GraphExecutor 上的组合技能（不在 l0/ 里，但同一张登记表）
import { WaitScanComplete } from '../composite/wait-scan-complete.js'
import { SetBiasRamp } from '../composite/set-bias-ramp.js'
import { AutoApproach } from '../composite/auto-approach.js'
import { ApproachTip } from '../composite/approach-tip.js'

export const IMPLEMENTED: Readonly<Record<string, Skill>> = {
  ...CORE_READS,
  ...HW_READS,
  GetZControllerState,
  ...SIMPLE_WRITES,
  ...VERIFIED_WRITES,
  ...GATED_WRITES,
  MoveToXY,
  SafeRetract,
  TryEngageController,
  ...SCAN_CHAIN,
  ConfigureScan,
  StartScan,
  ...FRAMES_PRESETS,
  ...ZCTRL_PRESETS,
  ...TAIL_L0,
  ...CONFIG_READS,
  CheckScanForCrash,
  ...LOCKIN,
  ...DATALOG_MARKS,
  ...LOCKIN_PRESETS,
  ...ATOM_TRACK,
  ...OSCI,
  ...SPECTRUM,
  ...BIAS_SWEEP,
  ...NANONIS_SCRIPT,
  ...SCRIPT_FILES,
  ...LIMITS,
  ...PLL,
  // ── 批 3g 在这一行下面展开 ──
  ...OPTIONAL_CONTROLLERS,
  ...OPTIONAL_AFM,
  ...OPTIONAL_MULTIPROBE,
  ...OPTIONAL_SWEEPERS,
  ...OPTIONAL_SCOPES,
  // ── 批 3h 在这一行下面展开 ──
  ...USER_OUTPUT,
  ...SWEEP,
  ...PATTERN,
  ...WAVEFORM,
  ...SPECTROSCOPY_SYNC,
  ...ADVANCED_OPS,
  // ── 批 3i 在这一行下面展开 ──
  // ── 批 3j 在这一行下面展开 ──
  ...READBACK_STREAM,
  // ── 批 3k 在这一行下面展开 ──

  // ── 批 3l 在这一行下面展开 ──
  ...SPECTROSCOPY,

  // ── 批 4a 在这一行下面展开 ──

  // ── 批 4b 在这一行下面展开 ──
  ...ANALYSIS_LATTICE,

  // ── 批 4c 在这一行下面展开 ──
  ...PAPER_DATA,
  ...PAPER_IMAGE,
  ...PAPER_CROP,
  ...SCAN_FRAME_OFFLINE,

  // ── 批 4d 在这一行下面展开 ──

  // ── 批 5a 在这一行下面展开 ──
  TipShape,
  TipPulse,
  ...TIP_CONDITIONING,

  // ── 批 5b 在这一行下面展开 ──
  ...CURRENT_MONITOR,
  ...CURRENT_ORIGIN,
  ...THERMAL_SETTLE,
  ...SCAN_WATCH,
  ...ACQUIRE_PSD,
  BiasSettleChange,
  BatchRegionsScan,

  // ── 批 5c 在这一行下面展开 ──

  // ── 批 6a 在这一行下面展开 ──

  // ── 批 7a-1 在这一行下面展开 ──
  AnalyzeFrameTilt,
  TiltProbeCircle,
  TiltCalibrate,
  AutoTilt,

  // ── 批 7a-2 在这一行下面展开 ──
  ...CLEAN_SPOT,

  // ── 批 7a-3 在这一行下面展开 ──

  // ── 批 7b-1 在这一行下面展开 ──

  // ── 批 7b-2 在这一行下面展开 ──

  // ── 批 7b-3 在这一行下面展开 ──
  ...ANALYSIS_FLAT_REGION,
  ...BIAS_WIGGLE,

  // ── 批 6b 在这一行下面展开 ──
  ...SCAN_PREP_SKILLS,

  // ── 批 6c 在这一行下面展开 ──
  ...ANALYSIS_TIP,
  ...ANALYSIS_FORCE,
  ...ANALYSIS_MULTIFRAME,
  ...CALIBRATIONS,
  RetractForSampleChange,
  RelocateCoarseXY,
  StepCoarseXY,
  ScanAt,
  FullScan,
  ...ANALYSIS_CLUSTERS,
  ...ANALYSIS_FRAMES,
  ...ANALYSIS_LINES,
  ...ENVIRONMENT,
  ...MISC_SETTERS,
  ...QPLUS,
  ...PIEZO_CHECK,
  WaitScanComplete,
  SetBiasRamp,
  AutoApproach,
  ApproachTip,
}

export * from './common.js'
export * from './reads-core.js'
export * from './reads-hw.js'
export * from './zctrl-state.js'
export * from './writes-simple.js'
export * from './writes-verified.js'
export * from './writes-gated.js'
export * from './move.js'
export * from './tip-park-read.js'
export * from './safe-retract.js'
export * from './engage.js'
export * from './scan.js'
export * from './configure-scan.js'
export * from './start-scan.js'
export * from './frames.js'
export * from './zctrl-presets.js'
export * from './tail-l0.js'
export * from './reads-config.js'
export * from './crash.js'
export * from './lockin.js'
export * from './datalog-marks.js'
export * from './lockin-presets.js'
export * from './atom-track.js'
export * from './osci.js'
export * from './spectrum.js'
export * from './bias-sweep.js'
export * from './nanonis-script.js'
export * from './script-files.js'
export * from './limits.js'
export * from './pll.js'
// ── 批 3g 在这一行下面 re-export ──
export * from './optional-common.js'
export * from './optional-controllers.js'
export * from './optional-afm.js'
export * from './optional-multiprobe.js'
export * from './optional-sweepers.js'
export * from './optional-scopes.js'
// ── 批 3h 在这一行下面 re-export ──
export * from './user-output.js'
export * from './sweep.js'
export * from './pattern.js'
export * from './waveform.js'
export * from './spectroscopy-sync.js'
export * from './advanced-ops.js'
// ── 批 3i 在这一行下面 re-export ──
// ── 批 3j 在这一行下面 re-export ──
export * from './readback-stream.js'
export * from './readback-skills.js'
export * from './tip-policy.js'
// ── 批 3k 在这一行下面 re-export ──

// ── 批 3l 在这一行下面 re-export ──
export * from './spectroscopy.js'

// ── 批 4a 在这一行下面 re-export ──

// ── 批 4b 在这一行下面 re-export ──
export * from './analysis-lattice.js'

// ── 批 4c 在这一行下面 re-export ──
export * from './paper-common.js'
export * from './paper-data.js'
export * from './paper-image.js'
export * from './paper-crop.js'
export * from './scan-frame-offline.js'

// ── 批 4d 在这一行下面 re-export ──

// ── 批 5a 在这一行下面 re-export ──
export * from './tip-shape.js'
export * from './tip-selfcheck.js'
export * from '../composite/tip-pulse.js'

// ── 批 5b 在这一行下面 re-export ──
export * from './current-monitor.js'
export * from './current-origin.js'
export * from './thermal-settle.js'
export * from './scan-watch.js'
export * from './acquire-psd.js'
export * from '../composite/bias-settle.js'
export * from '../composite/batch-regions-scan.js'

// ── 批 5c 在这一行下面 re-export ──

// ── 批 6a 在这一行下面 re-export ──

// ── 批 6b 在这一行下面 re-export ──
export * from './scan-prep-skills.js'

// ── 批 7a-1 在这一行下面 re-export ──

// ── 批 7a-2 在这一行下面 re-export ──

// ── 批 7a-3 在这一行下面 re-export ──
export * from './analysis-flat-region.js'
export * from './bias-wiggle.js'
export * from './frame-tilt.js'
export * from './tilt-probe.js'
export * from '../composite/auto-tilt.js'

// ── 批 6c 在这一行下面 re-export ──
export * from './analysis-tip.js'
export * from './analysis-force.js'
export * from './analysis-multiframe.js'
export * from './calibrations.js'
export * from '../composite/z-settle.js'
export * from '../composite/tip-evidence.js'
export * from '../composite/retract-for-sample-change.js'
export * from '../composite/relocate-coarse-xy.js'
export * from '../composite/step-coarse-xy.js'
export * from '../composite/scan-at.js'
export * from '../composite/full-scan.js'
export * from './analysis-common.js'
export * from './analysis-clusters.js'
export * from './analysis-frames.js'
export * from './analysis-lines.js'
export * from './environment.js'
export * from './misc-setters.js'
export * from './qplus.js'
export * from './piezo-check.js'
export * from './tip-xy.js'
export * from './verify.js'
export * from '../composite/wait-scan-complete.js'
export * from '../composite/set-bias-ramp.js'
export * from '../composite/auto-approach.js'
export * from '../composite/approach-tip.js'
