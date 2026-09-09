// 本文件由 `node scripts/gen-nanonis.ts` 生成，**不要手改**。
// 源：spec/nanonis/nanonis_commands.json（671 个方法，来源与四条读表须知见该目录 README）。
// CI 校验重生成无 diff。

import type { ArgValue } from '../types.js'

/** 一个方法的线协议规格。`args` 的顺序就是编码顺序。 */
export interface MethodSpec {
  readonly command: string
  readonly args: readonly { readonly name: string; readonly fmt: string }[]
  readonly returns: readonly string[]
  /** `patch` = MAST 给 nanonis_spm 打过补丁的 12 个方法之一。 */
  readonly source: 'upstream' | 'patch'
}

/** 671 个方法里 `args`/`returns` 齐全的那些（两个 alias 已解引用）。 */
export const NANONIS_METHODS = {
  APRFGen_FreqGet: { command: 'APRFGen.FreqGet', args: [], returns: ['f'], source: 'upstream' },
  APRFGen_FreqSet: { command: 'APRFGen.FreqSet', args: [{ name: 'Force_RF_On', fmt: 'I' }, { name: 'Frequency_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  APRFGen_FreqSwpLimitsGet: { command: 'APRFGen.FreqSwpLimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  APRFGen_FreqSwpLimitsSet: { command: 'APRFGen.FreqSwpLimitsSet', args: [{ name: 'Lower_limit', fmt: 'f' }, { name: 'Upper_limit', fmt: 'f' }], returns: [], source: 'upstream' },
  APRFGen_FreqSwpPropsGet: { command: 'APRFGen.FreqSwpPropsGet', args: [], returns: ['H', 'f', 'f', 'H', 'i', 'f', 'H'], source: 'upstream' },
  APRFGen_FreqSwpPropsSet: { command: 'APRFGen.FreqSwpPropsSet', args: [{ name: 'Mode', fmt: 'H' }, { name: 'Dwell_s', fmt: 'f' }, { name: 'Repetitions', fmt: 'f' }, { name: 'Infinite', fmt: 'H' }, { name: 'Points', fmt: 'i' }, { name: 'Off_s', fmt: 'f' }, { name: 'AutoOff', fmt: 'H' }], returns: [], source: 'upstream' },
  APRFGen_FreqSwpStart: { command: 'APRFGen.FreqSwpStart', args: [{ name: 'Direction', fmt: 'I' }], returns: [], source: 'upstream' },
  APRFGen_ListSwpPropsGet: { command: 'APRFGen.ListSwpPropsGet', args: [], returns: ['H', 'i', 'i', '2f', 'H', 'f', 'H'], source: 'upstream' },
  APRFGen_ListSwpPropsSet: { command: 'APRFGen.ListSwpPropsSet', args: [{ name: 'Signal', fmt: 'H' }, { name: 'Values', fmt: '2f' }, { name: 'Infinite', fmt: 'H' }, { name: 'Repetitions', fmt: 'f' }, { name: 'AutoOff', fmt: 'H' }], returns: [], source: 'upstream' },
  APRFGen_ListSwpStart: { command: 'APRFGen.ListSwpStart', args: [{ name: 'Direction', fmt: 'I' }], returns: [], source: 'upstream' },
  APRFGen_PowerGet: { command: 'APRFGen.PowerGet', args: [], returns: ['f'], source: 'upstream' },
  APRFGen_PowerSet: { command: 'APRFGen.PowerSet', args: [{ name: 'Force_RF_On', fmt: 'I' }, { name: 'Power_dBm', fmt: 'f' }], returns: [], source: 'upstream' },
  APRFGen_PowerSwpLimitsGet: { command: 'APRFGen.PowerSwpLimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  APRFGen_PowerSwpLimitsSet: { command: 'APRFGen.PowerSwpLimitsSet', args: [{ name: 'Lower_limit', fmt: 'f' }, { name: 'Upper_limit', fmt: 'f' }], returns: [], source: 'upstream' },
  APRFGen_PowerSwpPropsGet: { command: 'APRFGen.PowerSwpPropsGet', args: [], returns: ['f', 'f', 'H', 'i', 'f', 'H'], source: 'upstream' },
  APRFGen_PowerSwpPropsSet: { command: 'APRFGen.PowerSwpPropsSet', args: [{ name: 'Dwell_s', fmt: 'f' }, { name: 'Repetitions', fmt: 'f' }, { name: 'Infinite', fmt: 'H' }, { name: 'Points', fmt: 'i' }, { name: 'Off_s', fmt: 'f' }, { name: 'AutoOff', fmt: 'H' }], returns: [], source: 'upstream' },
  APRFGen_PowerSwpStart: { command: 'APRFGen.PowerSwpStart', args: [{ name: 'Direction', fmt: 'I' }], returns: [], source: 'upstream' },
  APRFGen_RFOutOnOffGet: { command: 'APRFGen.RFOutOnOffGet', args: [], returns: ['I'], source: 'upstream' },
  APRFGen_RFOutOnOffSet: { command: 'APRFGen.RFOutOnOffSet', args: [{ name: 'RF_Output', fmt: 'I' }], returns: [], source: 'upstream' },
  APRFGen_SwpStop: { command: 'APRFGen.SwpStop', args: [], returns: [], source: 'upstream' },
  APRFGen_TrigPropsGet: { command: 'APRFGen.TrigPropsGet', args: [], returns: ['H', 'f', 'H', 'H', 'H', 'H'], source: 'upstream' },
  APRFGen_TrigPropsSet: { command: 'APRFGen.TrigPropsSet', args: [{ name: 'Edge', fmt: 'H' }, { name: 'Delay_s', fmt: 'f' }, { name: 'Source', fmt: 'H' }, { name: 'Type', fmt: 'H' }, { name: 'Event_Count', fmt: 'H' }, { name: 'Mode', fmt: 'H' }], returns: [], source: 'upstream' },
  APRFGen_TrigRearm: { command: 'APRFGen.TrigRearm', args: [], returns: [], source: 'upstream' },
  AtomTrack_CtrlSet: { command: 'AtomTrack.CtrlSet', args: [{ name: 'AT_control', fmt: 'H' }, { name: 'Status', fmt: 'H' }], returns: [], source: 'upstream' },
  AtomTrack_DriftComp: { command: 'AtomTrack.DriftComp', args: [], returns: [], source: 'upstream' },
  AtomTrack_PropsGet: { command: 'AtomTrack.PropsGet', args: [], returns: ['f', 'f', 'f', 'f', 'f'], source: 'upstream' },
  AtomTrack_PropsSet: { command: 'AtomTrack.PropsSet', args: [{ name: 'Integral_gain', fmt: 'f' }, { name: 'Frequency_Hz', fmt: 'f' }, { name: 'Amplitude_m', fmt: 'f' }, { name: 'Phase_deg', fmt: 'f' }, { name: 'Switch_Off_delay_s', fmt: 'f' }], returns: [], source: 'upstream' },
  AtomTrack_QuickCompStart: { command: 'AtomTrack.QuickCompStart', args: [{ name: 'AT_control', fmt: 'H' }], returns: [], source: 'upstream' },
  AtomTrack_StatusGet: { command: 'AtomTrack.StatusGet', args: [{ name: 'AT_control', fmt: 'H' }], returns: ['H'], source: 'upstream' },
  AutoApproach_OnOffGet: { command: 'AutoApproach.OnOffGet', args: [], returns: ['H'], source: 'upstream' },
  AutoApproach_OnOffSet: { command: 'AutoApproach.OnOffSet', args: [{ name: 'On_Off', fmt: 'H' }], returns: [], source: 'upstream' },
  AutoApproach_Open: { command: 'AutoApproach.Open', args: [], returns: [], source: 'upstream' },
  BeamDefl_AutoOffset: { command: 'BeamDefl.AutoOffset', args: [{ name: 'Deflection_signal', fmt: 'H' }], returns: [], source: 'upstream' },
  BeamDefl_HorConfigGet: { command: 'BeamDefl.HorConfigGet', args: [], returns: ['i', '*-c', 'i', '*-c', 'f', 'f'], source: 'upstream' },
  BeamDefl_HorConfigSet: { command: 'BeamDefl.HorConfigSet', args: [{ name: 'Name', fmt: '+*c' }, { name: 'Units', fmt: '+*c' }, { name: 'Calibration', fmt: 'f' }, { name: 'Offset', fmt: 'f' }], returns: [], source: 'upstream' },
  BeamDefl_IntConfigGet: { command: 'BeamDefl.IntConfigGet', args: [], returns: ['i', '*-c', 'i', '*-c', 'f', 'f'], source: 'upstream' },
  BeamDefl_IntConfigSet: { command: 'BeamDefl.IntConfigSet', args: [{ name: 'Name', fmt: '+*c' }, { name: 'Units', fmt: '+*c' }, { name: 'Calibration', fmt: 'f' }, { name: 'Offset', fmt: 'f' }], returns: [], source: 'upstream' },
  BeamDefl_VerConfigGet: { command: 'BeamDefl.VerConfigGet', args: [], returns: ['i', '*-c', 'i', '*-c', 'f', 'f'], source: 'upstream' },
  BeamDefl_VerConfigSet: { command: 'BeamDefl.VerConfigSet', args: [{ name: 'Name', fmt: '+*c' }, { name: 'Units', fmt: '+*c' }, { name: 'Calibration', fmt: 'f' }, { name: 'Offset', fmt: 'f' }], returns: [], source: 'upstream' },
  BiasSpectr_AdvPropsGet: { command: 'BiasSpectr.AdvPropsGet', args: [], returns: ['H', 'H', 'H', 'H'], source: 'upstream' },
  BiasSpectr_AdvPropsSet: { command: 'BiasSpectr.AdvPropsSet', args: [{ name: 'Reset_Bias', fmt: 'H' }, { name: 'Z_Controller_Hold', fmt: 'H' }, { name: 'Record_final_Z', fmt: 'H' }, { name: 'Lockin_Run', fmt: 'H' }], returns: [], source: 'upstream' },
  BiasSpectr_AltZCtrlGet: { command: 'BiasSpectr.AltZCtrlGet', args: [], returns: ['H', 'f', 'f'], source: 'upstream' },
  BiasSpectr_AltZCtrlSet: { command: 'BiasSpectr.AltZCtrlSet', args: [{ name: 'Alternate_Z_controller_setpoint', fmt: 'H' }, { name: 'Setpoint', fmt: 'f' }, { name: 'Settling_time_s', fmt: 'f' }], returns: [], source: 'upstream' },
  BiasSpectr_ChsGet: { command: 'BiasSpectr.ChsGet', args: [], returns: ['i', '*i', 'i', 'i', '*+c'], source: 'upstream' },
  BiasSpectr_ChsSet: { command: 'BiasSpectr.ChsSet', args: [{ name: 'Channel_indexes', fmt: '+*i' }], returns: [], source: 'upstream' },
  BiasSpectr_DigSyncGet: { command: 'BiasSpectr.DigSyncGet', args: [], returns: ['H'], source: 'upstream' },
  BiasSpectr_DigSyncSet: { command: 'BiasSpectr.DigSyncSet', args: [{ name: 'Digital_Sync', fmt: 'H' }], returns: [], source: 'upstream' },
  BiasSpectr_LimitsGet: { command: 'BiasSpectr.LimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  BiasSpectr_LimitsSet: { command: 'BiasSpectr.LimitsSet', args: [{ name: 'Start_value_V', fmt: 'f' }, { name: 'End_value_V', fmt: 'f' }], returns: [], source: 'upstream' },
  BiasSpectr_MLSLockinPerSegGet: { command: 'BiasSpectr.MLSLockinPerSegGet', args: [], returns: ['I'], source: 'upstream' },
  BiasSpectr_MLSLockinPerSegSet: { command: 'BiasSpectr.MLSLockinPerSegSet', args: [{ name: 'Lock_In_per_segment', fmt: 'I' }], returns: [], source: 'upstream' },
  BiasSpectr_MLSModeGet: { command: 'BiasSpectr.MLSModeGet', args: [], returns: ['i', '*-c'], source: 'upstream' },
  BiasSpectr_MLSModeSet: { command: 'BiasSpectr.MLSModeSet', args: [{ name: 'Sweep_mode', fmt: '+*c' }], returns: [], source: 'upstream' },
  BiasSpectr_MLSValsGet: { command: 'BiasSpectr.MLSValsGet', args: [], returns: ['i', '**f', '**f', '**f', '**f', '**f', '**i', '**I'], source: 'upstream' },
  BiasSpectr_MLSValsSet: { command: 'BiasSpectr.MLSValsSet', args: [{ name: 'No_Of_Segments', fmt: 'i' }, { name: 'Bias_start_V', fmt: '*f' }, { name: 'Bias_end_V', fmt: '*f' }, { name: 'Initial_settling_time_s', fmt: '*f' }, { name: 'Settling_time_s', fmt: '*f' }, { name: 'Integration_time_s', fmt: '*f' }, { name: 'Steps', fmt: '*i' }, { name: 'Lock_In_run', fmt: '*i' }], returns: [], source: 'upstream' },
  BiasSpectr_Open: { command: 'BiasSpectr.Open', args: [], returns: [], source: 'upstream' },
  BiasSpectr_PropsGet: { command: 'BiasSpectr.PropsGet', args: [], returns: ['H', 'i', 'H', 'i', 'i', 'i', '*+c', 'i', 'i', '*+c', 'i', 'i', '*+c'], source: 'upstream' },
  BiasSpectr_PropsSet: { command: 'BiasSpectr.PropsSet', args: [{ name: 'Save_all', fmt: 'H' }, { name: 'Number_of_sweeps', fmt: 'i' }, { name: 'Backward_sweep', fmt: 'H' }, { name: 'Number_of_points', fmt: 'i' }, { name: 'Z_offset_m', fmt: 'f' }, { name: 'Autosave', fmt: 'H' }, { name: 'Show_save_dialog', fmt: 'H' }], returns: [], source: 'upstream' },
  BiasSpectr_PulseSeqSyncGet: { command: 'BiasSpectr.PulseSeqSyncGet', args: [], returns: ['H', 'I'], source: 'upstream' },
  BiasSpectr_PulseSeqSyncSet: { command: 'BiasSpectr.PulseSeqSyncSet', args: [{ name: 'Pulse_Sequence_Nr', fmt: 'H' }, { name: 'Nr_Periods', fmt: 'I' }], returns: [], source: 'upstream' },
  BiasSpectr_Start: { command: 'BiasSpectr.Start', args: [{ name: 'Get_data', fmt: 'I' }, { name: 'Save_base_name', fmt: '+*c' }], returns: ['i', 'i', '*+c', 'i', 'i', '2f', 'i', '*f'], source: 'upstream' },
  BiasSpectr_StatusGet: { command: 'BiasSpectr.StatusGet', args: [], returns: [], source: 'upstream' },
  BiasSpectr_Stop: { command: 'BiasSpectr.Stop', args: [], returns: [], source: 'upstream' },
  BiasSpectr_TTLSyncGet: { command: 'BiasSpectr.TTLSyncGet', args: [], returns: ['H', 'H', 'f', 'f'], source: 'upstream' },
  BiasSpectr_TTLSyncSet: { command: 'BiasSpectr.TTLSyncSet', args: [{ name: 'TTL_line', fmt: 'H' }, { name: 'TTL_polarity', fmt: 'H' }, { name: 'Time_to_on_s', fmt: 'f' }, { name: 'On_duration_s', fmt: 'f' }], returns: [], source: 'upstream' },
  BiasSpectr_TimingGet: { command: 'BiasSpectr.TimingGet', args: [], returns: ['f', 'f', 'f', 'f', 'f', 'f', 'f', 'f'], source: 'upstream' },
  BiasSpectr_TimingSet: { command: 'BiasSpectr.TimingSet', args: [{ name: 'Z_averaging_time_s', fmt: 'f' }, { name: 'Z_offset_m', fmt: 'f' }, { name: 'Initial_settling_time_s', fmt: 'f' }, { name: 'Maximum_slew_rate_Vdivs', fmt: 'f' }, { name: 'Settling_time_s', fmt: 'f' }, { name: 'Integration_time_s', fmt: 'f' }, { name: 'End_settling_time_s', fmt: 'f' }, { name: 'Z_control_time_s', fmt: 'f' }], returns: [], source: 'upstream' },
  BiasSpectr_ZOffRevertGet: { command: 'BiasSpectr.ZOffRevertGet', args: [], returns: ['H'], source: 'upstream' },
  BiasSpectr_ZOffRevertSet: { command: 'BiasSpectr.ZOffRevertSet', args: [{ name: 'Z_Offset_Revert', fmt: 'h' }], returns: [], source: 'upstream' },
  BiasSwp_LimitsGet: { command: 'BiasSwp.LimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  BiasSwp_LimitsSet: { command: 'BiasSwp.LimitsSet', args: [{ name: 'Lower_limit', fmt: 'f' }, { name: 'Upper_limit', fmt: 'f' }], returns: [], source: 'upstream' },
  BiasSwp_Open: { command: 'BiasSwp.Open', args: [], returns: [], source: 'upstream' },
  BiasSwp_PropsSet: { command: 'BiasSwp.PropsSet', args: [{ name: 'Number_of_steps', fmt: 'H' }, { name: 'Period_ms', fmt: 'H' }, { name: 'Autosave', fmt: 'H' }, { name: 'Save_dialog_box', fmt: 'H' }], returns: [], source: 'upstream' },
  BiasSwp_Start: { command: 'BiasSwp.Start', args: [{ name: 'Get_data', fmt: 'I' }, { name: 'Sweep_direction', fmt: 'I' }, { name: 'Z_Controller_status', fmt: 'I' }, { name: 'Save_base_name', fmt: '+*c' }, { name: 'Reset_bias', fmt: 'I' }], returns: ['i', 'i', '*+c', 'i', 'i', '2f'], source: 'upstream' },
  Bias_CalibrGet: { command: 'Bias.CalibrGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  Bias_CalibrSet: { command: 'Bias.CalibrSet', args: [{ name: 'Calibration', fmt: 'f' }, { name: 'Offset', fmt: 'f' }], returns: [], source: 'upstream' },
  Bias_Get: { command: 'Bias.Get', args: [], returns: ['f'], source: 'upstream' },
  Bias_Pulse: { command: 'Bias.Pulse', args: [{ name: 'Wait_until_done', fmt: 'I' }, { name: 'Bias_pulse_width_s', fmt: 'f' }, { name: 'Bias_value_V', fmt: 'f' }, { name: 'Z_Controller_on_hold', fmt: 'H' }, { name: 'Pulse_absolute_relative', fmt: 'H' }], returns: [], source: 'upstream' },
  Bias_RangeGet: { command: 'Bias.RangeGet', args: [], returns: ['i', 'i', '*+c', 'H'], source: 'upstream' },
  Bias_RangeSet: { command: 'Bias.RangeSet', args: [{ name: 'Bias_range_index', fmt: 'H' }], returns: [], source: 'upstream' },
  Bias_Set: { command: 'Bias.Set', args: [{ name: 'Bias_value_V', fmt: 'f' }], returns: [], source: 'upstream' },
  CPDComp_Close: { command: 'CPDComp.Close', args: [], returns: [], source: 'upstream' },
  CPDComp_DataGet: { command: 'CPDComp.DataGet', args: [], returns: ['i', '**f', '**f', '**f', 'i', '**f', '**f', '**f', 'f', 'd', 'd'], source: 'upstream' },
  CPDComp_Open: { command: 'CPDComp.Open', args: [], returns: [], source: 'upstream' },
  CPDComp_ParamsGet: { command: 'CPDComp.ParamsGet', args: [], returns: ['f', 'f', 'i'], source: 'upstream' },
  CPDComp_ParamsSet: { command: 'CPDComp.ParamsSet', args: [{ name: 'Speed_Hz', fmt: 'f' }, { name: 'Range_V', fmt: 'f' }, { name: 'Averaging', fmt: 'i' }], returns: [], source: 'upstream' },
  Current_100Get: { command: 'Current.100Get', args: [], returns: ['f'], source: 'upstream' },
  Current_BEEMGet: { command: 'Current.BEEMGet', args: [], returns: ['f'], source: 'upstream' },
  Current_CalibrGet: { command: 'Current.CalibrGet', args: [{ name: 'Gain_index', fmt: 'i' }], returns: ['d', 'd'], source: 'upstream' },
  Current_CalibrSet: { command: 'Current.CalibrSet', args: [{ name: 'Gain_index', fmt: 'i' }, { name: 'Calibration', fmt: 'd' }, { name: 'Offset', fmt: 'd' }], returns: [], source: 'upstream' },
  Current_GainSet: { command: 'Current.GainSet', args: [{ name: 'Gain_index', fmt: 'i' }, { name: 'Filter_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  Current_GainsGet: { command: 'Current.GainsGet', args: [], returns: ['i', 'i', '*+c', 'i', 'i', 'i', '*+c', 'i'], source: 'upstream' },
  Current_Get: { command: 'Current.Get', args: [], returns: ['f'], source: 'upstream' },
  DataLog_ChsGet: { command: 'DataLog.ChsGet', args: [], returns: ['i', '*i'], source: 'upstream' },
  DataLog_ChsSet: { command: 'DataLog.ChsSet', args: [{ name: 'Channel_indexes', fmt: '+*i' }], returns: [], source: 'upstream' },
  DataLog_Open: { command: 'DataLog.Open', args: [], returns: [], source: 'upstream' },
  DataLog_PropsGet: { command: 'DataLog.PropsGet', args: [], returns: ['H', 'i', 'i', 'f', 'i', 'i', '*-c', 'i', '*-c'], source: 'upstream' },
  DataLog_PropsSet: { command: 'DataLog.PropsSet', args: [{ name: 'Acquisition_mode', fmt: 'H' }, { name: 'Acquisition_duration_hours', fmt: 'i' }, { name: 'Acquisition_duration_minutes', fmt: 'i' }, { name: 'Acquisition_duration_seconds', fmt: 'f' }, { name: 'Averaging', fmt: 'i' }, { name: 'Basename', fmt: '+*c' }, { name: 'Comment', fmt: '+*c' }, { name: 'List_of_modules', fmt: '+*c' }], returns: [], source: 'upstream' },
  DataLog_Start: { command: 'DataLog.Start', args: [], returns: [], source: 'upstream' },
  DataLog_StatusGet: { command: 'DataLog.StatusGet', args: [], returns: ['i', '*-c', 'H', 'H', 'f', 'i', '*-c', 'i', '*-c', 'i'], source: 'upstream' },
  DataLog_Stop: { command: 'DataLog.Stop', args: [], returns: [], source: 'upstream' },
  DigLines_OutStatusSet: { command: 'DigLines.OutStatusSet', args: [{ name: 'Port', fmt: 'I' }, { name: 'Digital_line', fmt: 'I' }, { name: 'Status', fmt: 'I' }], returns: [], source: 'upstream' },
  DigLines_PropsSet: { command: 'DigLines.PropsSet', args: [{ name: 'Digital_line', fmt: 'I' }, { name: 'Port', fmt: 'I' }, { name: 'Direction', fmt: 'I' }, { name: 'Polarity', fmt: 'I' }], returns: [], source: 'upstream' },
  DigLines_Pulse: { command: 'DigLines.Pulse', args: [{ name: 'Port', fmt: 'H' }, { name: 'Digital_lines', fmt: '+*b' }, { name: 'Pulse_width_s', fmt: 'f' }, { name: 'Pulse_pause_s', fmt: 'f' }, { name: 'Number_of_pulses', fmt: 'i' }, { name: 'Wait_until_finished', fmt: 'I' }], returns: [], source: 'upstream' },
  DigLines_TTLValGet: { command: 'DigLines.TTLValGet', args: [{ name: 'Port', fmt: 'H' }], returns: ['i', '*I'], source: 'upstream' },
  FolMe_OversamplGet: { command: 'FolMe.OversamplGet', args: [], returns: ['i', 'f'], source: 'upstream' },
  FolMe_OversamplSet: { command: 'FolMe.OversamplSet', args: [{ name: 'Oversampling', fmt: 'i' }], returns: [], source: 'upstream' },
  FolMe_PSExpGet: { command: 'FolMe.PSExpGet', args: [], returns: ['H', 'i', 'i', '*+c'], source: 'upstream' },
  FolMe_PSExpSet: { command: 'FolMe.PSExpSet', args: [{ name: 'Point_And_Shoot_experiment', fmt: 'H' }], returns: [], source: 'upstream' },
  FolMe_PSOnOffGet: { command: 'FolMe.PSOnOffGet', args: [], returns: ['I'], source: 'upstream' },
  FolMe_PSOnOffSet: { command: 'FolMe.PSOnOffSet', args: [{ name: 'Point_And_Shoot_status', fmt: 'I' }], returns: [], source: 'upstream' },
  FolMe_PSPropsGet: { command: 'FolMe.PSPropsGet', args: [], returns: ['I', 'I', 'i', '*-c', 'i', '*-c', 'f'], source: 'upstream' },
  FolMe_PSPropsSet: { command: 'FolMe.PSPropsSet', args: [{ name: 'Auto_resume', fmt: 'I' }, { name: 'Use_own_basename', fmt: 'I' }, { name: 'Basename', fmt: '+*c' }, { name: 'External_VI_path', fmt: '+*c' }, { name: 'Pre_measure_delay_s', fmt: 'f' }], returns: [], source: 'upstream' },
  FolMe_SpeedGet: { command: 'FolMe.SpeedGet', args: [], returns: ['f', 'I'], source: 'upstream' },
  FolMe_SpeedSet: { command: 'FolMe.SpeedSet', args: [{ name: 'Speed_m_s', fmt: 'f' }, { name: 'Custom_speed', fmt: 'I' }], returns: [], source: 'upstream' },
  FolMe_Stop: { command: 'FolMe.Stop', args: [], returns: [], source: 'upstream' },
  FolMe_XYPosGet: { command: 'FolMe.XYPosGet', args: [{ name: 'Wait_for_newest_data', fmt: 'I' }], returns: ['d', 'd'], source: 'upstream' },
  FolMe_XYPosSet: { command: 'FolMe.XYPosSet', args: [{ name: 'X_m', fmt: 'd' }, { name: 'Y_m', fmt: 'd' }, { name: 'Wait_end_of_move', fmt: 'I' }], returns: [], source: 'upstream' },
  FunGen1Ch_IdleGet: { command: 'FunGen1Ch.IdleGet', args: [], returns: ['f'], source: 'upstream' },
  FunGen1Ch_IdleSet: { command: 'FunGen1Ch.IdleSet', args: [{ name: 'Idle_value', fmt: 'f' }], returns: [], source: 'upstream' },
  FunGen1Ch_PropsGet: { command: 'FunGen1Ch.PropsGet', args: [], returns: ['f', 'f', 'H', 'H'], source: 'upstream' },
  FunGen1Ch_PropsSet: { command: 'FunGen1Ch.PropsSet', args: [{ name: 'Amplitude', fmt: 'f' }, { name: 'Frequency', fmt: 'f' }, { name: 'Polarity', fmt: 'H' }, { name: 'Direction', fmt: 'H' }], returns: [], source: 'upstream' },
  FunGen1Ch_Start: { command: 'FunGen1Ch.Start', args: [{ name: 'Periods', fmt: 'i' }, { name: 'Wait_until_finished', fmt: 'I' }], returns: [], source: 'upstream' },
  FunGen1Ch_StatusGet: { command: 'FunGen1Ch.StatusGet', args: [], returns: ['I', 'i'], source: 'upstream' },
  FunGen1Ch_Stop: { command: 'FunGen1Ch.Stop', args: [], returns: [], source: 'upstream' },
  FunGen2Ch_IdleGet: { command: 'FunGen2Ch.IdleGet', args: [{ name: 'Device', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  FunGen2Ch_IdleSet: { command: 'FunGen2Ch.IdleSet', args: [{ name: 'Device', fmt: 'i' }, { name: 'Idle_value', fmt: 'f' }], returns: [], source: 'upstream' },
  FunGen2Ch_OnOffGet: { command: 'FunGen2Ch.OnOffGet', args: [{ name: 'Channel_index', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  FunGen2Ch_OnOffSet: { command: 'FunGen2Ch.OnOffSet', args: [{ name: 'Channel_index', fmt: 'i' }, { name: 'Status', fmt: 'I' }], returns: [], source: 'upstream' },
  FunGen2Ch_PropsGet: { command: 'FunGen2Ch.PropsGet', args: [{ name: 'Channel_index', fmt: 'i' }], returns: ['f', 'f', 'H', 'H', 'H'], source: 'upstream' },
  FunGen2Ch_PropsSet: { command: 'FunGen2Ch.PropsSet', args: [{ name: 'Channel_index', fmt: 'i' }, { name: 'Amplitude', fmt: 'f' }, { name: 'Time', fmt: 'f' }, { name: 'Polarity', fmt: 'H' }, { name: 'Direction', fmt: 'H' }, { name: 'Add_Zero', fmt: 'H' }], returns: [], source: 'upstream' },
  FunGen2Ch_SignalGet: { command: 'FunGen2Ch.SignalGet', args: [{ name: 'Channel_index', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  FunGen2Ch_SignalSet: { command: 'FunGen2Ch.SignalSet', args: [{ name: 'Channel_index', fmt: 'i' }, { name: 'Signal_index', fmt: 'i' }], returns: [], source: 'upstream' },
  FunGen2Ch_Start: { command: 'FunGen2Ch.Start', args: [{ name: 'Periods', fmt: 'i' }, { name: 'Wait_until_finished', fmt: 'I' }], returns: [], source: 'upstream' },
  FunGen2Ch_StatusGet: { command: 'FunGen2Ch.StatusGet', args: [], returns: ['I', 'i'], source: 'upstream' },
  FunGen2Ch_Stop: { command: 'FunGen2Ch.Stop', args: [], returns: [], source: 'upstream' },
  FunGen2Ch_WaveformGet: { command: 'FunGen2Ch.WaveformGet', args: [{ name: 'Channel_index', fmt: 'i' }], returns: ['H'], source: 'upstream' },
  FunGen2Ch_WaveformSet: { command: 'FunGen2Ch.WaveformSet', args: [{ name: 'Channel_index', fmt: 'i' }, { name: 'Shape', fmt: 'H' }], returns: [], source: 'upstream' },
  GenPICtrl_AOPropsGet: { command: 'GenPICtrl.AOPropsGet', args: [], returns: ['i', '*-c', 'i', '*-c', 'f', 'f', 'f', 'f'], source: 'upstream' },
  GenPICtrl_AOPropsSet: { command: 'GenPICtrl.AOPropsSet', args: [{ name: 'Signal_name', fmt: '+*c' }, { name: 'Units', fmt: '+*c' }, { name: 'Upper_limit', fmt: 'f' }, { name: 'Lower_limit', fmt: 'f' }, { name: 'Calibration_per_volt', fmt: 'f' }, { name: 'Offset_in_physical_units', fmt: 'f' }], returns: [], source: 'upstream' },
  GenPICtrl_AOValGet: { command: 'GenPICtrl.AOValGet', args: [], returns: ['f'], source: 'upstream' },
  GenPICtrl_AOValSet: { command: 'GenPICtrl.AOValSet', args: [{ name: 'Output_value', fmt: 'f' }], returns: [], source: 'upstream' },
  GenPICtrl_DemodChGet: { command: 'GenPICtrl.DemodChGet', args: [], returns: ['i'], source: 'upstream' },
  GenPICtrl_DemodChSet: { command: 'GenPICtrl.DemodChSet', args: [{ name: 'Input_index', fmt: 'i' }, { name: 'AC_mode', fmt: 'H' }], returns: [], source: 'upstream' },
  GenPICtrl_ModChGet: { command: 'GenPICtrl.ModChGet', args: [], returns: ['i'], source: 'upstream' },
  GenPICtrl_ModChSet: { command: 'GenPICtrl.ModChSet', args: [{ name: 'Output_index', fmt: 'i' }], returns: [], source: 'upstream' },
  GenPICtrl_OnOffGet: { command: 'GenPICtrl.OnOffGet', args: [], returns: ['I'], source: 'upstream' },
  GenPICtrl_OnOffSet: { command: 'GenPICtrl.OnOffSet', args: [{ name: 'Controller_status', fmt: 'I' }], returns: [], source: 'upstream' },
  GenPICtrl_PropsGet: { command: 'GenPICtrl.PropsGet', args: [], returns: ['f', 'f', 'f', 'H'], source: 'upstream' },
  GenPICtrl_PropsSet: { command: 'GenPICtrl.PropsSet', args: [{ name: 'Setpoint', fmt: 'f' }, { name: 'P_gain', fmt: 'f' }, { name: 'Time_constant', fmt: 'f' }, { name: 'Slope', fmt: 'H' }], returns: [], source: 'upstream' },
  GenSwp_AcqChsGet: { command: 'GenSwp.AcqChsGet', args: [], returns: ['i', '*i', 'i', 'i', '*+c'], source: 'upstream' },
  GenSwp_AcqChsSet: { command: 'GenSwp.AcqChsSet', args: [{ name: 'Channel_indexes', fmt: '+*i' }, { name: 'Channel_names', fmt: '*+c' }], returns: [], source: 'upstream' },
  GenSwp_LimitsGet: { command: 'GenSwp.LimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  GenSwp_LimitsSet: { command: 'GenSwp.LimitsSet', args: [{ name: 'Lower_limit', fmt: 'f' }, { name: 'Upper_limit', fmt: 'f' }], returns: [], source: 'upstream' },
  GenSwp_Open: { command: 'GenSwp.Open', args: [], returns: [], source: 'upstream' },
  GenSwp_PropsGet: { command: 'GenSwp.PropsGet', args: [], returns: ['f', 'f', 'i', 'H', 'I', 'I', 'f'], source: 'upstream' },
  GenSwp_PropsSet: { command: 'GenSwp.PropsSet', args: [{ name: 'Initial_Settling_time_ms', fmt: 'f' }, { name: 'Maximum_slew_rate_units_s', fmt: 'f' }, { name: 'Number_of_steps', fmt: 'i' }, { name: 'Period_ms', fmt: 'H' }, { name: 'Autosave', fmt: 'i' }, { name: 'Save_dialog_box', fmt: 'i' }, { name: 'Settling_time_ms', fmt: 'f' }], returns: [], source: 'upstream' },
  GenSwp_Start: { command: 'GenSwp.Start', args: [{ name: 'Get_data', fmt: 'I' }, { name: 'Sweep_direction', fmt: 'I' }, { name: 'Save_base_name', fmt: '+*c' }, { name: 'Reset_signal', fmt: 'I' }, { name: 'Z_Controller', fmt: 'H' }], returns: ['i', 'i', '*+c', 'i', 'i', '2f'], source: 'upstream' },
  GenSwp_Stop: { command: 'GenSwp.Stop', args: [], returns: [], source: 'upstream' },
  GenSwp_SwpSignalGet: { command: 'GenSwp.SwpSignalGet', args: [], returns: ['i', '*-c'], source: 'upstream' },
  GenSwp_SwpSignalListGet: { command: 'GenSwp.SwpSignalListGet', args: [], returns: ['i', 'i', '*+c'], source: 'upstream' },
  GenSwp_SwpSignalSet: { command: 'GenSwp.SwpSignalSet', args: [{ name: 'Sweep_channel_name', fmt: '+*c' }], returns: [], source: 'upstream' },
  HSSwp_AcqChsGet: { command: 'HSSwp.AcqChsGet', args: [], returns: ['i', '*I', 'i', 'i', '*+c', 'i', '*i'], source: 'upstream' },
  HSSwp_AcqChsSet: { command: 'HSSwp.AcqChsSet', args: [{ name: 'Channel_Indexes', fmt: '+*i' }], returns: [], source: 'upstream' },
  HSSwp_AutoReverseGet: { command: 'HSSwp.AutoReverseGet', args: [], returns: ['i', 'i', 'i', 'f', 'i', 'i', 'i', 'f'], source: 'upstream' },
  HSSwp_AutoReverseSet: { command: 'HSSwp.AutoReverseSet', args: [{ name: 'OnOff', fmt: 'i' }, { name: 'Condition', fmt: 'i' }, { name: 'Signal', fmt: 'i' }, { name: 'Threshold', fmt: 'f' }, { name: 'LinkToOne', fmt: 'i' }, { name: 'Condition2', fmt: 'i' }, { name: 'Signal2', fmt: 'i' }, { name: 'Threshold2', fmt: 'f' }], returns: [], source: 'upstream' },
  HSSwp_EndSettlGet: { command: 'HSSwp.EndSettlGet', args: [], returns: ['f'], source: 'upstream' },
  HSSwp_EndSettlSet: { command: 'HSSwp.EndSettlSet', args: [{ name: 'Threshold', fmt: 'f' }], returns: [], source: 'upstream' },
  HSSwp_NumSweepsGet: { command: 'HSSwp.NumSweepsGet', args: [], returns: ['I', 'i'], source: 'upstream' },
  HSSwp_NumSweepsSet: { command: 'HSSwp.NumSweepsSet', args: [{ name: 'Number_Of_Sweeps', fmt: 'I' }, { name: 'Continuous', fmt: 'i' }], returns: [], source: 'upstream' },
  HSSwp_ResetSignalsGet: { command: 'HSSwp.ResetSignalsGet', args: [], returns: ['i'], source: 'upstream' },
  HSSwp_ResetSignalsSet: { command: 'HSSwp.ResetSignalsSet', args: [{ name: 'ResetSignals', fmt: 'i' }], returns: [], source: 'upstream' },
  HSSwp_SaveBasenameGet: { command: 'HSSwp.SaveBasenameGet', args: [], returns: ['i', '*-c', '*-c'], source: 'upstream' },
  HSSwp_SaveBasenameSet: { command: 'HSSwp.SaveBasenameSet', args: [{ name: 'Basename', fmt: '+*c' }, { name: 'Path', fmt: '+*c' }], returns: [], source: 'upstream' },
  HSSwp_SaveDataGet: { command: 'HSSwp.SaveDataGet', args: [], returns: ['i'], source: 'upstream' },
  HSSwp_SaveDataSet: { command: 'HSSwp.SaveDataSet', args: [{ name: 'SaveData', fmt: 'i' }], returns: [], source: 'upstream' },
  HSSwp_SaveOptionsGet: { command: 'HSSwp.SaveOptionsGet', args: [], returns: ['i', '*-c', 'i', 'i', '*+c'], source: 'upstream' },
  HSSwp_SaveOptionsSet: { command: 'HSSwp.SaveOptionsSet', args: [{ name: 'Comment', fmt: '+*c' }, { name: 'ModulesNames', fmt: '+*c' }], returns: [], source: 'upstream' },
  HSSwp_Start: { command: 'HSSwp.Start', args: [{ name: 'Wait_Until_Done', fmt: 'i' }, { name: 'Timeout', fmt: 'i' }], returns: [], source: 'upstream' },
  HSSwp_StatusGet: { command: 'HSSwp.StatusGet', args: [], returns: ['I'], source: 'upstream' },
  HSSwp_Stop: { command: 'HSSwp.Stop', args: [], returns: [], source: 'upstream' },
  HSSwp_SwpChBwdDelayGet: { command: 'HSSwp.SwpChBwdDelayGet', args: [], returns: ['f'], source: 'upstream' },
  HSSwp_SwpChBwdDelaySet: { command: 'HSSwp.SwpChBwdDelaySet', args: [{ name: 'Bwd_Delay', fmt: 'f' }], returns: [], source: 'upstream' },
  HSSwp_SwpChBwdSwGet: { command: 'HSSwp.SwpChBwdSwGet', args: [], returns: ['I'], source: 'upstream' },
  HSSwp_SwpChBwdSwSet: { command: 'HSSwp.SwpChBwdSwSet', args: [{ name: 'Bwd_Sweep', fmt: 'I' }], returns: [], source: 'upstream' },
  HSSwp_SwpChLimitsGet: { command: 'HSSwp.SwpChLimitsGet', args: [], returns: ['i', 'f', 'f'], source: 'upstream' },
  HSSwp_SwpChLimitsSet: { command: 'HSSwp.SwpChLimitsSet', args: [{ name: 'Relative_Limits', fmt: 'i' }, { name: 'Start', fmt: 'f' }, { name: 'Stop', fmt: 'f' }], returns: [], source: 'upstream' },
  HSSwp_SwpChNumPtsGet: { command: 'HSSwp.SwpChNumPtsGet', args: [], returns: ['i'], source: 'upstream' },
  HSSwp_SwpChNumPtsSet: { command: 'HSSwp.SwpChNumPtsSet', args: [{ name: 'Number_Of_Points', fmt: 'I' }], returns: [], source: 'upstream' },
  HSSwp_SwpChSigListGet: { command: 'HSSwp.SwpChSigListGet', args: [], returns: ['+*c', '+*i'], source: 'upstream' },
  HSSwp_SwpChSignalGet: { command: 'HSSwp.SwpChSignalGet', args: [], returns: ['i', 'i'], source: 'upstream' },
  HSSwp_SwpChSignalSet: { command: 'HSSwp.SwpChSignalSet', args: [{ name: 'Sweep_Signal_Index', fmt: 'i' }, { name: 'Timed_Sweep', fmt: 'i' }], returns: [], source: 'upstream' },
  HSSwp_SwpChTimingGet: { command: 'HSSwp.SwpChTimingGet', args: [], returns: ['f', 'f', 'f', 'f'], source: 'upstream' },
  HSSwp_SwpChTimingSet: { command: 'HSSwp.SwpChTimingSet', args: [{ name: 'Initial_Settling_Time', fmt: 'f' }, { name: 'Settling_Time', fmt: 'f' }, { name: 'Integration_Time', fmt: 'f' }, { name: 'Max_Slew_Time', fmt: 'f' }], returns: [], source: 'upstream' },
  HSSwp_ZCtrlOffGet: { command: 'HSSwp.ZCtrlOffGet', args: [], returns: ['i', 'i', 'f', 'f', 'f'], source: 'upstream' },
  HSSwp_ZCtrlOffSet: { command: 'HSSwp.ZCtrlOffSet', args: [{ name: 'Z_Controller_Off', fmt: 'i' }, { name: 'Z_Controller_Index', fmt: 'i' }, { name: 'Z_Averaging_Time', fmt: 'f' }, { name: 'Z_Offset', fmt: 'f' }, { name: 'Z_Control_Time', fmt: 'f' }], returns: [], source: 'upstream' },
  Interf_CtrlCalibrOpen: { command: 'Interf.CtrlCalibrOpen', args: [], returns: [], source: 'upstream' },
  Interf_CtrlNullDefl: { command: 'Interf.CtrlNullDefl', args: [], returns: [], source: 'upstream' },
  Interf_CtrlOnOffGet: { command: 'Interf.CtrlOnOffGet', args: [], returns: ['I'], source: 'upstream' },
  Interf_CtrlOnOffSet: { command: 'Interf.CtrlOnOffSet', args: [{ name: 'Status', fmt: 'I' }], returns: [], source: 'upstream' },
  Interf_CtrlPropsGet: { command: 'Interf.CtrlPropsGet', args: [], returns: ['f', 'f', 'I'], source: 'upstream' },
  Interf_CtrlPropsSet: { command: 'Interf.CtrlPropsSet', args: [{ name: 'Integral', fmt: 'f' }, { name: 'Proportional', fmt: 'f' }, { name: 'Sign', fmt: 'I' }], returns: [], source: 'upstream' },
  Interf_CtrlReset: { command: 'Interf.CtrlReset', args: [], returns: [], source: 'upstream' },
  Interf_ValGet: { command: 'Interf.ValGet', args: [], returns: ['f'], source: 'upstream' },
  Interf_WPiezoGet: { command: 'Interf.WPiezoGet', args: [], returns: ['f'], source: 'upstream' },
  Interf_WPiezoSet: { command: 'Interf.WPiezoSet', args: [{ name: 'W_piezo', fmt: 'f' }], returns: [], source: 'upstream' },
  KelvinCtrl_AmpGet: { command: 'KelvinCtrl.AmpGet', args: [], returns: ['f'], source: 'upstream' },
  KelvinCtrl_BiasLimitsGet: { command: 'KelvinCtrl.BiasLimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  KelvinCtrl_BiasLimitsSet: { command: 'KelvinCtrl.BiasLimitsSet', args: [{ name: 'Bias_high_limit_V', fmt: 'f' }, { name: 'Bias_low_limit_V', fmt: 'f' }], returns: [], source: 'upstream' },
  KelvinCtrl_CtrlOnOffGet: { command: 'KelvinCtrl.CtrlOnOffGet', args: [], returns: ['I'], source: 'upstream' },
  KelvinCtrl_CtrlOnOffSet: { command: 'KelvinCtrl.CtrlOnOffSet', args: [{ name: 'Control_On_Off', fmt: 'I' }], returns: [], source: 'upstream' },
  KelvinCtrl_CtrlSignalGet: { command: 'KelvinCtrl.CtrlSignalGet', args: [], returns: ['i'], source: 'upstream' },
  KelvinCtrl_CtrlSignalSet: { command: 'KelvinCtrl.CtrlSignalSet', args: [{ name: 'Demodulated_Control_signal_index', fmt: 'i' }], returns: [], source: 'upstream' },
  KelvinCtrl_GainGet: { command: 'KelvinCtrl.GainGet', args: [], returns: ['f', 'f', 'H'], source: 'upstream' },
  KelvinCtrl_GainSet: { command: 'KelvinCtrl.GainSet', args: [{ name: 'P_gain', fmt: 'f' }, { name: 'Time_constant_s', fmt: 'f' }, { name: 'Slope', fmt: 'H' }], returns: [], source: 'upstream' },
  KelvinCtrl_ModOnOffGet: { command: 'KelvinCtrl.ModOnOffGet', args: [], returns: ['H', 'H'], source: 'upstream' },
  KelvinCtrl_ModOnOffSet: { command: 'KelvinCtrl.ModOnOffSet', args: [{ name: 'AC_mode_On_Off', fmt: 'H' }, { name: 'Modulation_On_Off', fmt: 'H' }], returns: [], source: 'upstream' },
  KelvinCtrl_ModParamsGet: { command: 'KelvinCtrl.ModParamsGet', args: [], returns: ['f', 'f', 'f'], source: 'upstream' },
  KelvinCtrl_ModParamsSet: { command: 'KelvinCtrl.ModParamsSet', args: [{ name: 'Frequency_Hz', fmt: 'f' }, { name: 'Amplitude', fmt: 'f' }, { name: 'Phase_deg', fmt: 'f' }], returns: [], source: 'upstream' },
  KelvinCtrl_SetpntGet: { command: 'KelvinCtrl.SetpntGet', args: [], returns: ['f'], source: 'upstream' },
  KelvinCtrl_SetpntSet: { command: 'KelvinCtrl.SetpntSet', args: [{ name: 'Setpoint', fmt: 'f' }], returns: [], source: 'upstream' },
  Laser_OnOffGet: { command: 'Laser.OnOffGet', args: [], returns: ['I'], source: 'upstream' },
  Laser_OnOffSet: { command: 'Laser.OnOffSet', args: [{ name: 'Status', fmt: 'I' }], returns: [], source: 'upstream' },
  Laser_PowerGet: { command: 'Laser.PowerGet', args: [], returns: ['f'], source: 'upstream' },
  Laser_PropsGet: { command: 'Laser.PropsGet', args: [], returns: ['f'], source: 'upstream' },
  Laser_PropsSet: { command: 'Laser.PropsSet', args: [{ name: 'Laser_Setpoint', fmt: 'f' }], returns: [], source: 'upstream' },
  LockInFreqSwp_LimitsGet: { command: 'LockInFreqSwp.LimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  LockInFreqSwp_LimitsSet: { command: 'LockInFreqSwp.LimitsSet', args: [{ name: 'Lower_limit_Hz', fmt: 'f' }, { name: 'Upper_limit_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  LockInFreqSwp_Open: { command: 'LockInFreqSwp.Open', args: [], returns: [], source: 'upstream' },
  LockInFreqSwp_PropsGet: { command: 'LockInFreqSwp.PropsGet', args: [], returns: ['H', 'H', 'f', 'H', 'f', 'I', 'I', 'i', '*-c'], source: 'upstream' },
  LockInFreqSwp_PropsSet: { command: 'LockInFreqSwp.PropsSet', args: [{ name: 'Number_of_steps', fmt: 'H' }, { name: 'Integration_periods', fmt: 'H' }, { name: 'Minimum_integration_time_s', fmt: 'f' }, { name: 'Settling_periods', fmt: 'H' }, { name: 'Minimum_Settling_time_s', fmt: 'f' }, { name: 'Autosave', fmt: 'I' }, { name: 'Save_dialog', fmt: 'I' }, { name: 'Basename', fmt: '+*c' }], returns: [], source: 'upstream' },
  LockInFreqSwp_SignalGet: { command: 'LockInFreqSwp.SignalGet', args: [], returns: ['i'], source: 'upstream' },
  LockInFreqSwp_SignalSet: { command: 'LockInFreqSwp.SignalSet', args: [{ name: 'Sweep_signal_index', fmt: 'i' }], returns: [], source: 'upstream' },
  LockInFreqSwp_Start: { command: 'LockInFreqSwp.Start', args: [{ name: 'Get_Data', fmt: 'I' }, { name: 'Direction', fmt: 'I' }], returns: ['i', 'i', '*+c', 'i', 'i', '2f'], source: 'upstream' },
  LockIn_DemodHPFilterGet: { command: 'LockIn.DemodHPFilterGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['i', 'f'], source: 'upstream' },
  LockIn_DemodHPFilterSet: { command: 'LockIn.DemodHPFilterSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'HP_Filter_Order', fmt: 'i' }, { name: 'HP_Filter_Cutoff_Frequency_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  LockIn_DemodHarmonicGet: { command: 'LockIn.DemodHarmonicGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  LockIn_DemodHarmonicSet: { command: 'LockIn.DemodHarmonicSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'Harmonic_', fmt: 'i' }], returns: [], source: 'upstream' },
  LockIn_DemodLPFilterGet: { command: 'LockIn.DemodLPFilterGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['i', 'f'], source: 'upstream' },
  LockIn_DemodLPFilterSet: { command: 'LockIn.DemodLPFilterSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'LP_Filter_Order', fmt: 'i' }, { name: 'LP_Filter_Cutoff_Frequency_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  LockIn_DemodPhasGet: { command: 'LockIn.DemodPhasGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  LockIn_DemodPhasRegGet: { command: 'LockIn.DemodPhasRegGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  LockIn_DemodPhasRegSet: { command: 'LockIn.DemodPhasRegSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'Phase_Register_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  LockIn_DemodPhasSet: { command: 'LockIn.DemodPhasSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'Phase_deg_', fmt: 'f' }], returns: [], source: 'upstream' },
  LockIn_DemodRTSignalsGet: { command: 'LockIn.DemodRTSignalsGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  LockIn_DemodRTSignalsSet: { command: 'LockIn.DemodRTSignalsSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'RT_Signals_', fmt: 'I' }], returns: [], source: 'upstream' },
  LockIn_DemodSignalGet: { command: 'LockIn.DemodSignalGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  LockIn_DemodSignalSet: { command: 'LockIn.DemodSignalSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'Demodulator_Signal_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  LockIn_DemodSyncFilterGet: { command: 'LockIn.DemodSyncFilterGet', args: [{ name: 'Demodulator_number', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  LockIn_DemodSyncFilterSet: { command: 'LockIn.DemodSyncFilterSet', args: [{ name: 'Demodulator_number', fmt: 'i' }, { name: 'Sync_Filter_', fmt: 'I' }], returns: [], source: 'upstream' },
  LockIn_ModAmpGet: { command: 'LockIn.ModAmpGet', args: [{ name: 'Modulator_number', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  LockIn_ModAmpSet: { command: 'LockIn.ModAmpSet', args: [{ name: 'Modulator_number', fmt: 'i' }, { name: 'Amplitude_', fmt: 'f' }], returns: [], source: 'upstream' },
  LockIn_ModHarmonicGet: { command: 'LockIn.ModHarmonicGet', args: [{ name: 'Modulator_number', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  LockIn_ModHarmonicSet: { command: 'LockIn.ModHarmonicSet', args: [{ name: 'Modulator_number', fmt: 'i' }, { name: 'Harmonic_', fmt: 'i' }], returns: [], source: 'upstream' },
  LockIn_ModOnOffGet: { command: 'LockIn.ModOnOffGet', args: [{ name: 'Modulator_number', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  LockIn_ModOnOffSet: { command: 'LockIn.ModOnOffSet', args: [{ name: 'Modulator_number', fmt: 'i' }, { name: 'Lock_In_OndivOff', fmt: 'I' }], returns: [], source: 'upstream' },
  LockIn_ModPhasFreqGet: { command: 'LockIn.ModPhasFreqGet', args: [{ name: 'Modulator_number', fmt: 'i' }], returns: ['d'], source: 'upstream' },
  LockIn_ModPhasFreqSet: { command: 'LockIn.ModPhasFreqSet', args: [{ name: 'Modulator_number', fmt: 'i' }, { name: 'Frequency_Hz_', fmt: 'd' }], returns: [], source: 'upstream' },
  LockIn_ModPhasGet: { command: 'LockIn.ModPhasGet', args: [{ name: 'Modulator_number', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  LockIn_ModPhasRegGet: { command: 'LockIn.ModPhasRegGet', args: [{ name: 'Modulator_number', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  LockIn_ModPhasRegSet: { command: 'LockIn.ModPhasRegSet', args: [{ name: 'Modulator_number', fmt: 'i' }, { name: 'Phase_Register_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  LockIn_ModPhasSet: { command: 'LockIn.ModPhasSet', args: [{ name: 'Modulator_number', fmt: 'i' }, { name: 'Phase_deg_', fmt: 'f' }], returns: [], source: 'upstream' },
  LockIn_ModSignalGet: { command: 'LockIn.ModSignalGet', args: [{ name: 'Modulator_number', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  LockIn_ModSignalSet: { command: 'LockIn.ModSignalSet', args: [{ name: 'Modulator_number', fmt: 'i' }, { name: 'Modulator_Signal_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  MCVA5_ContStateUpdateGet: { command: 'MCVA5.ContStateUpdateGet', args: [{ name: 'Preamp_Nr', fmt: 'H' }], returns: ['I'], source: 'upstream' },
  MCVA5_ContStateUpdateSet: { command: 'MCVA5.ContStateUpdateSet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Continuous_Read', fmt: 'I' }], returns: [], source: 'upstream' },
  MCVA5_ContTempUpdateGet: { command: 'MCVA5.ContTempUpdateGet', args: [{ name: 'Preamp_Nr', fmt: 'H' }], returns: ['I'], source: 'upstream' },
  MCVA5_ContTempUpdateSet: { command: 'MCVA5.ContTempUpdateSet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Continuous_Read', fmt: 'I' }], returns: [], source: 'upstream' },
  MCVA5_CouplingGet: { command: 'MCVA5.CouplingGet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }], returns: ['H'], source: 'upstream' },
  MCVA5_CouplingSet: { command: 'MCVA5.CouplingSet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }, { name: 'Coupling', fmt: 'H' }], returns: [], source: 'upstream' },
  MCVA5_GainGet: { command: 'MCVA5.GainGet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }], returns: ['H'], source: 'upstream' },
  MCVA5_GainSet: { command: 'MCVA5.GainSet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }, { name: 'Gain', fmt: 'H' }], returns: [], source: 'upstream' },
  MCVA5_InputModeGet: { command: 'MCVA5.InputModeGet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }], returns: ['H'], source: 'upstream' },
  MCVA5_InputModeSet: { command: 'MCVA5.InputModeSet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }, { name: 'Input_Mode', fmt: 'H' }], returns: [], source: 'upstream' },
  MCVA5_SingleStateUpdate: { command: 'MCVA5.SingleStateUpdate', args: [{ name: 'Preamp_Nr', fmt: 'H' }], returns: ['i', 'i', 'i', 'i', 'i', 'i', 'i', 'i'], source: 'upstream' },
  MCVA5_SingleTempUpdate: { command: 'MCVA5.SingleTempUpdate', args: [{ name: 'Preamp_Nr', fmt: 'H' }], returns: ['H', 'H', 'H', 'H'], source: 'upstream' },
  MCVA5_UserInGet: { command: 'MCVA5.UserInGet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }], returns: ['I'], source: 'upstream' },
  MCVA5_UserInSet: { command: 'MCVA5.UserInSet', args: [{ name: 'Preamp_Nr', fmt: 'H' }, { name: 'Channel_Nr', fmt: 'H' }, { name: 'User_Input', fmt: 'I' }], returns: [], source: 'upstream' },
  MPass_Activate: { command: 'MPass.Activate', args: [{ name: 'On_Off', fmt: 'I' }], returns: [], source: 'upstream' },
  MPass_Load: { command: 'MPass.Load', args: [{ name: 'File_Path', fmt: '+*c' }], returns: [], source: 'upstream' },
  MPass_Save: { command: 'MPass.Save', args: [{ name: 'File_Path', fmt: '+*c' }], returns: [], source: 'upstream' },
  MProbeBias_CalibrGet: { command: 'MProbeBias.CalibrGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['f', 'f'], source: 'upstream' },
  MProbeBias_CalibrSet: { command: 'MProbeBias.CalibrSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Calibration', fmt: 'f' }, { name: 'Offset', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeBias_Get: { command: 'MProbeBias.Get', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['f'], source: 'upstream' },
  MProbeBias_Pulse: { command: 'MProbeBias.Pulse', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Wait_Until_Done', fmt: 'I' }, { name: 'Width', fmt: 'f' }, { name: 'Value', fmt: 'f' }, { name: 'ZCtrl_Hold', fmt: 'H' }, { name: 'Abs_Rel', fmt: 'H' }], returns: [], source: 'upstream' },
  MProbeBias_RangeGet: { command: 'MProbeBias.RangeGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['H'], source: 'upstream' },
  MProbeBias_RangeSet: { command: 'MProbeBias.RangeSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Bias_Range_Index', fmt: 'H' }], returns: [], source: 'upstream' },
  MProbeBias_Set: { command: 'MProbeBias.Set', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Bias_Value', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeCurrent_CalibrGet: { command: 'MProbeCurrent.CalibrGet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Gain_Index', fmt: 'i' }], returns: ['d', 'd'], source: 'upstream' },
  MProbeCurrent_CalibrSet: { command: 'MProbeCurrent.CalibrSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Gain_Index', fmt: 'i' }, { name: 'Calibration', fmt: 'd' }, { name: 'Offset', fmt: 'd' }], returns: [], source: 'upstream' },
  MProbeCurrent_GainSet: { command: 'MProbeCurrent.GainSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Gain_Index', fmt: 'i' }, { name: 'Filter_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  MProbeCurrent_GainsGet: { command: 'MProbeCurrent.GainsGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['i', 'i', '*+c', 'i', 'i', 'i', '*+c', 'i'], source: 'upstream' },
  MProbeCurrent_Get: { command: 'MProbeCurrent.Get', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['f'], source: 'upstream' },
  MProbeScanner_ActiveScannerGet: { command: 'MProbeScanner.ActiveScannerGet', args: [], returns: ['i'], source: 'upstream' },
  MProbeScanner_CalibrGet: { command: 'MProbeScanner.CalibrGet', args: [{ name: 'Scanner_Index', fmt: 'i' }], returns: ['f', 'f', 'f', 'f', 'f', 'f'], source: 'upstream' },
  MProbeScanner_CalibrSet: { command: 'MProbeScanner.CalibrSet', args: [{ name: 'Scanner_Index', fmt: 'i' }, { name: 'Factor_X', fmt: 'f' }, { name: 'Factor_Y', fmt: 'f' }, { name: 'Factor_Z', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeScanner_ScannerSwitch: { command: 'MProbeScanner.ScannerSwitch', args: [{ name: 'Scanner_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  MProbeScanner_SpeedGet: { command: 'MProbeScanner.SpeedGet', args: [{ name: 'Scanner_Index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  MProbeScanner_SpeedSet: { command: 'MProbeScanner.SpeedSet', args: [{ name: 'Scanner_Index', fmt: 'i' }, { name: 'Speed', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeScanner_Stop: { command: 'MProbeScanner.Stop', args: [{ name: 'Scanner_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  MProbeScanner_XYPosGet: { command: 'MProbeScanner.XYPosGet', args: [{ name: 'Scanner_Index', fmt: 'i' }], returns: ['f', 'f'], source: 'upstream' },
  MProbeScanner_XYPosSet: { command: 'MProbeScanner.XYPosSet', args: [{ name: 'Scanner_Index', fmt: 'i' }, { name: 'X_m', fmt: 'f' }, { name: 'Y_m', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeZCtrl_GainGet: { command: 'MProbeZCtrl.GainGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['f', 'f'], source: 'upstream' },
  MProbeZCtrl_GainSet: { command: 'MProbeZCtrl.GainSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'P_Gain', fmt: 'f' }, { name: 'I_Gain', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeZCtrl_Home: { command: 'MProbeZCtrl.Home', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: [], source: 'upstream' },
  MProbeZCtrl_HomePropsGet: { command: 'MProbeZCtrl.HomePropsGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['H', 'f'], source: 'upstream' },
  MProbeZCtrl_HomePropsSet: { command: 'MProbeZCtrl.HomePropsSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Abs_Rel', fmt: 'H' }, { name: 'Home_m', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeZCtrl_LimitsGet: { command: 'MProbeZCtrl.LimitsGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['f', 'f'], source: 'upstream' },
  MProbeZCtrl_LimitsSet: { command: 'MProbeZCtrl.LimitsSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'High_Limit', fmt: 'f' }, { name: 'Low_Limit', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeZCtrl_OnOffGet: { command: 'MProbeZCtrl.OnOffGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['I'], source: 'upstream' },
  MProbeZCtrl_OnOffSet: { command: 'MProbeZCtrl.OnOffSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'ZCtrl_Status', fmt: 'I' }], returns: [], source: 'upstream' },
  MProbeZCtrl_SetpntGet: { command: 'MProbeZCtrl.SetpntGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['f'], source: 'upstream' },
  MProbeZCtrl_SetpntSet: { command: 'MProbeZCtrl.SetpntSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'ZCtrl_Setpoint', fmt: 'f' }], returns: [], source: 'upstream' },
  MProbeZCtrl_Withdraw: { command: 'MProbeZCtrl.Withdraw', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: [], source: 'upstream' },
  MProbeZCtrl_ZPosGet: { command: 'MProbeZCtrl.ZPosGet', args: [{ name: 'Scanner_Index', fmt: 'H' }], returns: ['f'], source: 'upstream' },
  MProbeZCtrl_ZPosSet: { command: 'MProbeZCtrl.ZPosSet', args: [{ name: 'Scanner_Index', fmt: 'H' }, { name: 'Z_m', fmt: 'f' }], returns: [], source: 'upstream' },
  Marks_LineDraw: { command: 'Marks.LineDraw', args: [{ name: 'Start_point_X_coordinate_m', fmt: 'f' }, { name: 'Start_point_Y_coordinate_m', fmt: 'f' }, { name: 'End_point_X_coordinate_m', fmt: 'f' }, { name: 'End_point_Y_coordinate_m', fmt: 'f' }, { name: 'Color', fmt: 'I' }], returns: [], source: 'upstream' },
  Marks_LinesDraw: { command: 'Marks.LinesDraw', args: [{ name: 'Number_of_lines', fmt: 'i' }, { name: 'Start_point_X_coordinate_m', fmt: '*f' }, { name: 'Start_point_Y_coordinate_m', fmt: '*f' }, { name: 'End_point_X_coordinate_m', fmt: '*f' }, { name: 'End_point_Y_coordinate_m', fmt: '*f' }, { name: 'Color', fmt: '*I' }], returns: [], source: 'upstream' },
  Marks_LinesErase: { command: 'Marks.LinesErase', args: [{ name: 'Line_index', fmt: 'i' }], returns: [], source: 'upstream' },
  Marks_LinesGet: { command: 'Marks.LinesGet', args: [], returns: ['i', '**f', '**f', '**f', '**f', '**I', '**I'], source: 'upstream' },
  Marks_LinesVisibleSet: { command: 'Marks.LinesVisibleSet', args: [{ name: 'Line_index', fmt: 'i' }, { name: 'Show_hide', fmt: 'H' }], returns: [], source: 'upstream' },
  Marks_PointDraw: { command: 'Marks.PointDraw', args: [{ name: 'X_coordinate_m', fmt: 'f' }, { name: 'Y_coordinate_m', fmt: 'f' }, { name: 'Text', fmt: '+*c' }, { name: 'Color', fmt: 'I' }], returns: [], source: 'upstream' },
  Marks_PointsDraw: { command: 'Marks.PointsDraw', args: [{ name: 'nr_points', fmt: 'i' }, { name: 'X_coordinate_m', fmt: '*f' }, { name: 'Y_coordinate_m', fmt: '*f' }, { name: 'Text', fmt: '+*c' }, { name: 'Color', fmt: '*I' }], returns: [], source: 'upstream' },
  Marks_PointsErase: { command: 'Marks.PointsErase', args: [{ name: 'Point_index', fmt: 'i' }], returns: [], source: 'upstream' },
  Marks_PointsGet: { command: 'Marks.PointsGet', args: [], returns: ['i', '**f', '**f', 'i', '**c', '**I', '**I'], source: 'upstream' },
  Marks_PointsVisibleSet: { command: 'Marks.PointsVisibleSet', args: [{ name: 'Point_index', fmt: 'i' }, { name: 'Show_hide', fmt: 'H' }], returns: [], source: 'upstream' },
  Motor_FreqAmpGet: { command: 'Motor.FreqAmpGet', args: [{ name: 'Axis', fmt: 'H' }], returns: ['f', 'f'], source: 'upstream' },
  Motor_FreqAmpSet: { command: 'Motor.FreqAmpSet', args: [{ name: 'Frequency_Hz', fmt: 'f' }, { name: 'Amplitude_V', fmt: 'f' }, { name: 'Axis', fmt: 'H' }], returns: [], source: 'upstream' },
  Motor_PosGet: { command: 'Motor.PosGet', args: [{ name: 'Group', fmt: 'I' }, { name: 'Timeout', fmt: 'I' }], returns: ['d', 'd', 'd'], source: 'upstream' },
  Motor_StartClosedLoop: { command: 'Motor.StartClosedLoop', args: [{ name: 'Absolute_relative', fmt: 'I' }, { name: 'Target_Xm', fmt: 'd' }, { name: 'Target_Ym', fmt: 'd' }, { name: 'Target_Zm', fmt: 'd' }, { name: 'Wait_until_finished', fmt: 'I' }, { name: 'Group', fmt: 'I' }], returns: [], source: 'upstream' },
  Motor_StartMove: { command: 'Motor.StartMove', args: [{ name: 'Direction', fmt: 'I' }, { name: 'Number_of_steps', fmt: 'H' }, { name: 'Group', fmt: 'I' }, { name: 'Wait_until_finished', fmt: 'I' }], returns: [], source: 'upstream' },
  Motor_StepCounterGet: { command: 'Motor.StepCounterGet', args: [{ name: 'Reset_X', fmt: 'I' }, { name: 'Reset_Y', fmt: 'I' }, { name: 'Reset_Z', fmt: 'I' }], returns: ['i', 'i', 'i'], source: 'upstream' },
  Motor_StopMove: { command: 'Motor.StopMove', args: [], returns: [], source: 'upstream' },
  OCSync_AnglesGet: { command: 'OCSync.AnglesGet', args: [], returns: ['f', 'f', 'f', 'f'], source: 'upstream' },
  OCSync_AnglesSet: { command: 'OCSync.AnglesSet', args: [{ name: 'Channel_1_on_angle_deg', fmt: 'f' }, { name: 'Channel_1_off_angle_deg', fmt: 'f' }, { name: 'Channel_2_on_angle_deg', fmt: 'f' }, { name: 'Channel_3_off_angle_deg', fmt: 'f' }], returns: [], source: 'upstream' },
  OCSync_LinkAnglesGet: { command: 'OCSync.LinkAnglesGet', args: [], returns: ['I', 'I'], source: 'upstream' },
  OCSync_LinkAnglesSet: { command: 'OCSync.LinkAnglesSet', args: [{ name: 'Link_angles_Channel_1', fmt: 'I' }, { name: 'Link_angles_Channel_2', fmt: 'I' }], returns: [], source: 'upstream' },
  Osci1T_ChGet: { command: 'Osci1T.ChGet', args: [], returns: ['i'], source: 'upstream' },
  Osci1T_ChSet: { command: 'Osci1T.ChSet', args: [{ name: 'ChannelIndex', fmt: 'i' }], returns: [], source: 'upstream' },
  Osci1T_DataGet: { command: 'Osci1T.DataGet', args: [{ name: 'DataToGet', fmt: 'H' }], returns: ['d', 'd', 'i', '*d'], source: 'upstream' },
  Osci1T_Run: { command: 'Osci1T.Run', args: [], returns: [], source: 'upstream' },
  Osci1T_TimebaseGet: { command: 'Osci1T.TimebaseGet', args: [], returns: ['i', 'i', '*f'], source: 'patch' },
  Osci1T_TimebaseSet: { command: 'Osci1T.TimebaseSet', args: [{ name: 'TimebaseIndex', fmt: 'i' }], returns: [], source: 'upstream' },
  Osci1T_TrigGet: { command: 'Osci1T.TrigGet', args: [{ name: 'TriggerMode', fmt: 'H' }, { name: 'TriggerChannel', fmt: 'H' }, { name: 'TriggerSlope', fmt: 'd' }, { name: 'TriggerLevel', fmt: 'd' }], returns: [], source: 'upstream' },
  Osci1T_TrigSet: { command: 'Osci1T.TrigSet', args: [{ name: 'TriggerMode', fmt: 'H' }, { name: 'TriggerSlope', fmt: 'H' }, { name: 'TriggerLevel', fmt: 'd' }, { name: 'TriggerHysteresis', fmt: 'd' }], returns: [], source: 'upstream' },
  Osci2T_ChGet: { command: 'Osci2T.ChsGet', args: [], returns: ['i', 'i'], source: 'patch' },
  Osci2T_ChSet: { command: 'Osci2T.ChsSet', args: [{ name: 'ChannelAIndex', fmt: 'i' }, { name: 'ChannelBIndex', fmt: 'i' }], returns: [], source: 'patch' },
  Osci2T_ChsGet: { command: 'Osci2T.ChsGet', args: [], returns: ['i', 'i'], source: 'patch' },
  Osci2T_ChsSet: { command: 'Osci2T.ChsSet', args: [{ name: 'ChannelAIndex', fmt: 'i' }, { name: 'ChannelBIndex', fmt: 'i' }], returns: [], source: 'patch' },
  Osci2T_DataGet: { command: 'Osci2T.DataGet', args: [{ name: 'DataToGet', fmt: 'H' }], returns: ['d', 'd', 'i', '*d', 'i', '*d'], source: 'upstream' },
  Osci2T_OversamplGet: { command: 'Osci2T.OversamplGet', args: [], returns: ['H'], source: 'patch' },
  Osci2T_OversamplSet: { command: 'Osci2T.OversamplSet', args: [{ name: 'OversamplIndex', fmt: 'H' }], returns: [], source: 'upstream' },
  Osci2T_Run: { command: 'Osci2T.Run', args: [], returns: [], source: 'upstream' },
  Osci2T_TimebaseGet: { command: 'Osci2T.TimebaseGet', args: [], returns: ['i', 'i', '*f'], source: 'patch' },
  Osci2T_TimebaseSet: { command: 'Osci2T.TimebaseSet', args: [{ name: 'TimebaseIndex', fmt: 'H' }], returns: [], source: 'patch' },
  Osci2T_TrigGet: { command: 'Osci2T.TrigGet', args: [{ name: 'TriggerMode', fmt: 'H' }, { name: 'TriggerChannel', fmt: 'H' }, { name: 'TriggerSlope', fmt: 'H' }, { name: 'TriggerLevel', fmt: 'd' }, { name: 'TriggerHysterstis', fmt: 'd' }, { name: 'TriggerPos', fmt: 'd' }], returns: [], source: 'upstream' },
  Osci2T_TrigSet: { command: 'Osci2T.TrigSet', args: [{ name: 'TriggerMode', fmt: 'H' }, { name: 'TrigChannel', fmt: 'H' }, { name: 'TriggerSlope', fmt: 'H' }, { name: 'TriggerLevel', fmt: 'd' }, { name: 'TriggerHysteresis', fmt: 'd' }, { name: 'TrigPosition', fmt: 'd' }], returns: [], source: 'upstream' },
  OsciHR_CalibrModeGet: { command: 'OsciHR.CalibrModeGet', args: [{ name: 'Osci_index', fmt: 'i' }], returns: ['H'], source: 'upstream' },
  OsciHR_CalibrModeSet: { command: 'OsciHR.CalibrModeSet', args: [{ name: 'Osci_index', fmt: 'i' }, { name: 'Calibration_mode', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_ChGet: { command: 'OsciHR.ChGet', args: [{ name: 'Osci_index', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  OsciHR_ChSet: { command: 'OsciHR.ChSet', args: [{ name: 'Osci_index', fmt: 'i' }, { name: 'Signal_index', fmt: 'i' }], returns: [], source: 'upstream' },
  OsciHR_OsciDataGet: { command: 'OsciHR.OsciDataGet', args: [{ name: 'Osci_index', fmt: 'i' }, { name: 'Data_to_get', fmt: 'H' }, { name: 'Timeout_s', fmt: 'd' }], returns: ['i', '*-c', 'd', 'i', '*f', 'I'], source: 'upstream' },
  OsciHR_OversamplGet: { command: 'OsciHR.OversamplGet', args: [], returns: ['i'], source: 'upstream' },
  OsciHR_OversamplSet: { command: 'OsciHR.OversamplSet', args: [{ name: 'Oversampling_index', fmt: 'i' }], returns: [], source: 'upstream' },
  OsciHR_PSDAvrgCountGet: { command: 'OsciHR.PSDAvrgCountGet', args: [], returns: ['i'], source: 'upstream' },
  OsciHR_PSDAvrgCountSet: { command: 'OsciHR.PSDAvrgCountSet', args: [{ name: 'PSD_averaging_count', fmt: 'i' }], returns: [], source: 'upstream' },
  OsciHR_PSDAvrgRestart: { command: 'OsciHR.PSDAvrgRestart', args: [], returns: [], source: 'upstream' },
  OsciHR_PSDAvrgTypeGet: { command: 'OsciHR.PSDAvrgTypeGet', args: [], returns: ['H'], source: 'upstream' },
  OsciHR_PSDAvrgTypeSet: { command: 'OsciHR.PSDAvrgTypeSet', args: [{ name: 'PSD_averaging_type', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_PSDDataGet: { command: 'OsciHR.PSDDataGet', args: [{ name: 'Data_to_get', fmt: 'H' }, { name: 'Timeout_s', fmt: 'd' }], returns: ['d', 'd', 'i', '*d', 'I'], source: 'upstream' },
  OsciHR_PSDShow: { command: 'OsciHR.PSDShow', args: [{ name: 'Show_PSD_section', fmt: 'I' }], returns: [], source: 'upstream' },
  OsciHR_PSDWeightGet: { command: 'OsciHR.PSDWeightGet', args: [], returns: ['H'], source: 'upstream' },
  OsciHR_PSDWeightSet: { command: 'OsciHR.PSDWeightSet', args: [{ name: 'PSD_Weighting', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_PSDWindowGet: { command: 'OsciHR.PSDWindowGet', args: [], returns: ['H'], source: 'upstream' },
  OsciHR_PSDWindowSet: { command: 'OsciHR.PSDWindowSet', args: [{ name: 'PSD_window_type', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_PreTrigGet: { command: 'OsciHR.PreTrigGet', args: [], returns: ['i'], source: 'upstream' },
  OsciHR_PreTrigSet: { command: 'OsciHR.PreTrigSet', args: [{ name: 'Pre_Trigger_samples', fmt: 'I' }, { name: 'Pre_Trigger_s', fmt: 'd' }], returns: [], source: 'upstream' },
  OsciHR_Run: { command: 'OsciHR.Run', args: [], returns: [], source: 'upstream' },
  OsciHR_SamplesGet: { command: 'OsciHR.SamplesGet', args: [], returns: ['i'], source: 'upstream' },
  OsciHR_SamplesSet: { command: 'OsciHR.SamplesSet', args: [{ name: 'Number_of_samples', fmt: 'i' }], returns: [], source: 'upstream' },
  OsciHR_TrigArmModeGet: { command: 'OsciHR.TrigArmModeGet', args: [], returns: ['H'], source: 'upstream' },
  OsciHR_TrigArmModeSet: { command: 'OsciHR.TrigArmModeSet', args: [{ name: 'Trigger_arming_mode', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_TrigDigChGet: { command: 'OsciHR.TrigDigChGet', args: [], returns: ['i'], source: 'upstream' },
  OsciHR_TrigDigChSet: { command: 'OsciHR.TrigDigChSet', args: [{ name: 'Digital_trigger_channel_index', fmt: 'i' }], returns: [], source: 'upstream' },
  OsciHR_TrigDigSlopeGet: { command: 'OsciHR.TrigDigSlopeGet', args: [], returns: ['H'], source: 'upstream' },
  OsciHR_TrigDigSlopeSet: { command: 'OsciHR.TrigDigSlopeSet', args: [{ name: 'Digital_trigger_slope', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_TrigLevChGet: { command: 'OsciHR.TrigLevChGet', args: [], returns: ['i'], source: 'upstream' },
  OsciHR_TrigLevChSet: { command: 'OsciHR.TrigLevChSet', args: [{ name: 'Level_trigger_channel_index', fmt: 'i' }], returns: [], source: 'upstream' },
  OsciHR_TrigLevHystGet: { command: 'OsciHR.TrigLevHystGet', args: [], returns: ['d'], source: 'upstream' },
  OsciHR_TrigLevHystSet: { command: 'OsciHR.TrigLevHystSet', args: [{ name: 'Level_trigger_Hysteresis', fmt: 'd' }], returns: [], source: 'upstream' },
  OsciHR_TrigLevSlopeGet: { command: 'OsciHR.TrigLevSlopeGet', args: [], returns: ['H'], source: 'upstream' },
  OsciHR_TrigLevSlopeSet: { command: 'OsciHR.TrigLevSlopeSet', args: [{ name: 'Level_trigger_slope', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_TrigLevValGet: { command: 'OsciHR.TrigLevValGet', args: [], returns: ['d'], source: 'upstream' },
  OsciHR_TrigLevValSet: { command: 'OsciHR.TrigLevValSet', args: [{ name: 'Level_trigger_value', fmt: 'd' }], returns: [], source: 'upstream' },
  OsciHR_TrigModeGet: { command: 'OsciHR.TrigModeGet', args: [], returns: ['H'], source: 'upstream' },
  OsciHR_TrigModeSet: { command: 'OsciHR.TrigModeSet', args: [{ name: 'Trigger_mode', fmt: 'H' }], returns: [], source: 'upstream' },
  OsciHR_TrigRearm: { command: 'OsciHR.TrigRearm', args: [], returns: [], source: 'upstream' },
  PICtrl_CtrlChGet: { command: 'PICtrl.CtrlChGet', args: [{ name: 'Controller_Index', fmt: 'i' }], returns: ['i', 'i', 'i', '*+c', 'i', '*i'], source: 'upstream' },
  PICtrl_CtrlChPropsGet: { command: 'PICtrl.CtrlChPropsGet', args: [{ name: 'Controller_Index', fmt: 'i' }], returns: ['f', 'f'], source: 'upstream' },
  PICtrl_CtrlChPropsSet: { command: 'PICtrl.CtrlChPropsSet', args: [{ name: 'Controller_Index', fmt: 'i' }, { name: 'Lower_Limit', fmt: 'f' }, { name: 'Upper_Limit', fmt: 'f' }], returns: [], source: 'upstream' },
  PICtrl_CtrlChSet: { command: 'PICtrl.CtrlChSet', args: [{ name: 'Controller_Index', fmt: 'i' }, { name: 'CtrlSignal_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  PICtrl_InputChGet: { command: 'PICtrl.InputChGet', args: [{ name: 'Controller_Index', fmt: 'i' }], returns: ['i', 'i', 'i', '*+c', 'i', '*i'], source: 'upstream' },
  PICtrl_InputChSet: { command: 'PICtrl.InputChSet', args: [{ name: 'Controller_Index', fmt: 'i' }, { name: 'Input_Index', fmt: 'i' }], returns: [], source: 'upstream' },
  PICtrl_OnOffGet: { command: 'PICtrl.OnOffGet', args: [{ name: 'Controller_Index', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  PICtrl_OnOffSet: { command: 'PICtrl.OnOffSet', args: [{ name: 'Controller_Index', fmt: 'i' }, { name: 'Controller_Status', fmt: 'I' }], returns: [], source: 'upstream' },
  PICtrl_PropsGet: { command: 'PICtrl.PropsGet', args: [{ name: 'Controller_Index', fmt: 'i' }], returns: ['f', 'f', 'f', 'H'], source: 'upstream' },
  PICtrl_PropsSet: { command: 'PICtrl.PropsSet', args: [{ name: 'Controller_Index', fmt: 'i' }, { name: 'Setpoint', fmt: 'f' }, { name: 'P_Gain', fmt: 'f' }, { name: 'I_Gain', fmt: 'f' }, { name: 'Slope', fmt: 'H' }], returns: [], source: 'upstream' },
  PLLFreqSwp_Open: { command: 'PLLFreqSwp.Open', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: [], source: 'upstream' },
  PLLFreqSwp_ParamsGet: { command: 'PLLFreqSwp.ParamsGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['i', 'f', 'f'], source: 'upstream' },
  PLLFreqSwp_ParamsSet: { command: 'PLLFreqSwp.ParamsSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Number_of_points', fmt: 'i' }, { name: 'Period_s', fmt: 'f' }, { name: 'Settling_time_s', fmt: 'f' }], returns: [], source: 'upstream' },
  PLLFreqSwp_Start: { command: 'PLLFreqSwp.Start', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Get_data', fmt: 'I' }, { name: 'Sweep_direction', fmt: 'I' }], returns: ['i', 'i', '*+c', 'i', 'i', '2f', 'd', 'd', 'f', 'f', 'i', 'i'], source: 'upstream' },
  PLLFreqSwp_Stop: { command: 'PLLFreqSwp.Stop', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: [], source: 'upstream' },
  PLLPhasSwp_Start: { command: 'PLLPhasSwp.Start', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Get_data', fmt: 'I' }], returns: ['i', 'i', '*+c', 'i', 'i', '2f'], source: 'upstream' },
  PLLPhasSwp_Stop: { command: 'PLLPhasSwp.Stop', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: [], source: 'upstream' },
  PLLSignalAnlzr_ChGet: { command: 'PLLSignalAnlzr.ChGet', args: [], returns: ['i'], source: 'upstream' },
  PLLSignalAnlzr_ChSet: { command: 'PLLSignalAnlzr.ChSet', args: [{ name: 'Channel_index', fmt: 'i' }], returns: [], source: 'upstream' },
  PLLSignalAnlzr_FFTAvgRestart: { command: 'PLLSignalAnlzr.FFTAvgRestart', args: [], returns: [], source: 'upstream' },
  PLLSignalAnlzr_FFTDataGet: { command: 'PLLSignalAnlzr.FFTDataGet', args: [], returns: ['d', 'd', 'i', '*d'], source: 'upstream' },
  PLLSignalAnlzr_FFTPropsGet: { command: 'PLLSignalAnlzr.FFTPropsGet', args: [], returns: ['H', 'H', 'H', 'i'], source: 'upstream' },
  PLLSignalAnlzr_FFTPropsSet: { command: 'PLLSignalAnlzr.FFTPropsSet', args: [{ name: 'FFT_window', fmt: 'H' }, { name: 'Averaging_mode', fmt: 'H' }, { name: 'Weighting_mode', fmt: 'H' }, { name: 'Count', fmt: 'i' }], returns: [], source: 'upstream' },
  PLLSignalAnlzr_Open: { command: 'PLLSignalAnlzr.Open', args: [], returns: [], source: 'upstream' },
  PLLSignalAnlzr_OsciDataGet: { command: 'PLLSignalAnlzr.OsciDataGet', args: [], returns: ['d', 'd', 'i', '*+d'], source: 'upstream' },
  PLLSignalAnlzr_TimebaseGet: { command: 'PLLSignalAnlzr.TimebaseGet', args: [], returns: ['i', 'i', 'i', 'i', '*+c'], source: 'upstream' },
  PLLSignalAnlzr_TimebaseSet: { command: 'PLLSignalAnlzr.TimebaseSet', args: [{ name: 'Timebase', fmt: 'i' }, { name: 'Update_rate', fmt: 'i' }], returns: [], source: 'upstream' },
  PLLSignalAnlzr_TrigAuto: { command: 'PLLSignalAnlzr.TrigAuto', args: [], returns: [], source: 'upstream' },
  PLLSignalAnlzr_TrigGet: { command: 'PLLSignalAnlzr.TrigGet', args: [], returns: ['H', 'i', 'H', 'd', 'd', 'H', 'i', 'i', '*+c'], source: 'upstream' },
  PLLSignalAnlzr_TrigRearm: { command: 'PLLSignalAnlzr.TrigRearm', args: [], returns: [], source: 'upstream' },
  PLLSignalAnlzr_TrigSet: { command: 'PLLSignalAnlzr.TrigSet', args: [{ name: 'Trigger_mode', fmt: 'H' }, { name: 'Trigger_source', fmt: 'i' }, { name: 'Trigger_slope', fmt: 'H' }, { name: 'Trigger_level', fmt: 'd' }, { name: 'Trigger_position_s', fmt: 'd' }, { name: 'Arming_mode', fmt: 'H' }], returns: [], source: 'upstream' },
  PLLZoomFFT_AvgRestart: { command: 'PLLZoomFFT.AvgRestart', args: [], returns: [], source: 'upstream' },
  PLLZoomFFT_ChGet: { command: 'PLLZoomFFT.ChGet', args: [], returns: ['i'], source: 'upstream' },
  PLLZoomFFT_ChSet: { command: 'PLLZoomFFT.ChSet', args: [{ name: 'Channel_index', fmt: 'i' }], returns: [], source: 'upstream' },
  PLLZoomFFT_DataGet: { command: 'PLLZoomFFT.DataGet', args: [], returns: ['d', 'd', 'i', '*d'], source: 'upstream' },
  PLLZoomFFT_Open: { command: 'PLLZoomFFT.Open', args: [], returns: [], source: 'upstream' },
  PLLZoomFFT_PropsGet: { command: 'PLLZoomFFT.PropsGet', args: [], returns: ['H', 'H', 'H', 'i'], source: 'upstream' },
  PLLZoomFFT_PropsSet: { command: 'PLLZoomFFT.PropsSet', args: [{ name: 'FFT_window', fmt: 'H' }, { name: 'Averaging_mode', fmt: 'H' }, { name: 'Weighting_mode', fmt: 'H' }, { name: 'Count', fmt: 'i' }], returns: [], source: 'upstream' },
  PLL_AddOnOffGet: { command: 'PLL.AddOnOffGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  PLL_AddOnOffSet: { command: 'PLL.AddOnOffSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Add', fmt: 'I' }], returns: [], source: 'upstream' },
  PLL_AmpCtrlBandwidthGet: { command: 'PLL.AmpCtrlBandwidthGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_AmpCtrlBandwidthSet: { command: 'PLL.AmpCtrlBandwidthSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Bandwidth_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_AmpCtrlGainGet: { command: 'PLL.AmpCtrlGainGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f', 'f', 'f'], source: 'upstream' },
  PLL_AmpCtrlGainSet: { command: 'PLL.AmpCtrlGainSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'P_gain_Vdivm', fmt: 'f' }, { name: 'Time_constant_s', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_AmpCtrlOnOffGet: { command: 'PLL.AmpCtrlOnOffGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  PLL_AmpCtrlOnOffSet: { command: 'PLL.AmpCtrlOnOffSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Status', fmt: 'I' }], returns: [], source: 'upstream' },
  PLL_AmpCtrlSetpntGet: { command: 'PLL.AmpCtrlSetpntGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_AmpCtrlSetpntSet: { command: 'PLL.AmpCtrlSetpntSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Setpoint_m', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_CenterFreqGet: { command: 'PLL.CenterFreqGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['d'], source: 'upstream' },
  PLL_CenterFreqSet: { command: 'PLL.CenterFreqSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Center_frequency_Hz', fmt: 'd' }], returns: [], source: 'upstream' },
  PLL_DemodFilterGet: { command: 'PLL.DemodFilterGet', args: [{ name: 'Demodulator_index', fmt: 'H' }], returns: ['H'], source: 'upstream' },
  PLL_DemodFilterSet: { command: 'PLL.DemodFilterSet', args: [{ name: 'Demodulator_index', fmt: 'H' }, { name: 'Filter_order_', fmt: 'H' }], returns: [], source: 'upstream' },
  PLL_DemodHarmonicGet: { command: 'PLL.DemodHarmonicGet', args: [{ name: 'Demodulator_index', fmt: 'H' }], returns: ['H'], source: 'upstream' },
  PLL_DemodHarmonicSet: { command: 'PLL.DemodHarmonicSet', args: [{ name: 'Demodulator_index', fmt: 'H' }, { name: 'Harmonic_', fmt: 'H' }], returns: [], source: 'upstream' },
  PLL_DemodInputGet: { command: 'PLL.DemodInputGet', args: [{ name: 'Demodulator_index', fmt: 'H' }], returns: ['H', 'H'], source: 'upstream' },
  PLL_DemodInputSet: { command: 'PLL.DemodInputSet', args: [{ name: 'Demodulator_index', fmt: 'H' }, { name: 'Input_', fmt: 'H' }, { name: 'Frequency_generator', fmt: 'H' }], returns: [], source: 'upstream' },
  PLL_DemodPhasRefGet: { command: 'PLL.DemodPhasRefGet', args: [{ name: 'Demodulator_index', fmt: 'H' }], returns: ['f'], source: 'upstream' },
  PLL_DemodPhasRefSet: { command: 'PLL.DemodPhasRefSet', args: [{ name: 'Demodulator_index', fmt: 'H' }, { name: 'Phase_reference_deg_', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_ExcRangeGet: { command: 'PLL.ExcRangeGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['H'], source: 'upstream' },
  PLL_ExcRangeSet: { command: 'PLL.ExcRangeSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Output_range', fmt: 'H' }], returns: [], source: 'upstream' },
  PLL_ExcitationGet: { command: 'PLL.ExcitationGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_ExcitationSet: { command: 'PLL.ExcitationSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Excitation_value_V', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_FreqExcOverwriteGet: { command: 'PLL.FreqExcOverwriteGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['i', 'i'], source: 'upstream' },
  PLL_FreqExcOverwriteSet: { command: 'PLL.FreqExcOverwriteSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Excitation_overwrite_signal_index', fmt: 'i' }, { name: 'Frequency_overwrite_signal_index', fmt: 'i' }], returns: [], source: 'upstream' },
  PLL_FreqRangeGet: { command: 'PLL.FreqRangeGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_FreqRangeSet: { command: 'PLL.FreqRangeSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Frequency_range_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_FreqShiftAutoCenter: { command: 'PLL.FreqShiftAutoCenter', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: [], source: 'upstream' },
  PLL_FreqShiftGet: { command: 'PLL.FreqShiftGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_FreqShiftSet: { command: 'PLL.FreqShiftSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Frequency_shift_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_InpCalibrGet: { command: 'PLL.InpCalibrGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_InpCalibrSet: { command: 'PLL.InpCalibrSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Calibration_mdivV', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_InpPropsGet: { command: 'PLL.InpPropsGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['H', 'H'], source: 'upstream' },
  PLL_InpPropsSet: { command: 'PLL.InpPropsSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Differential_input', fmt: 'H' }, { name: 'OneDiv10_divider', fmt: 'H' }], returns: [], source: 'upstream' },
  PLL_InpRangeGet: { command: 'PLL.InpRangeGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_InpRangeSet: { command: 'PLL.InpRangeSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Input_range_m', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_OutOnOffGet: { command: 'PLL.OutOnOffGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  PLL_OutOnOffSet: { command: 'PLL.OutOnOffSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'PLL_output', fmt: 'I' }], returns: [], source: 'upstream' },
  PLL_PerfectPLLUpdtZTC: { command: 'PLL.PerfectPLLUpdtZTC', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: [], source: 'patch' },
  PLL_PhasCtrlBandwidthGet: { command: 'PLL.PhasCtrlBandwidthGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f'], source: 'upstream' },
  PLL_PhasCtrlBandwidthSet: { command: 'PLL.PhasCtrlBandwidthSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Bandwidth_Hz', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_PhasCtrlGainGet: { command: 'PLL.PhasCtrlGainGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['f', 'f'], source: 'upstream' },
  PLL_PhasCtrlGainSet: { command: 'PLL.PhasCtrlGainSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'P_gain_Hzdivdeg', fmt: 'f' }, { name: 'Time_constant_s', fmt: 'f' }], returns: [], source: 'upstream' },
  PLL_PhasCtrlOnOffGet: { command: 'PLL.PhasCtrlOnOffGet', args: [{ name: 'Modulator_index', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  PLL_PhasCtrlOnOffSet: { command: 'PLL.PhasCtrlOnOffSet', args: [{ name: 'Modulator_index', fmt: 'i' }, { name: 'Status', fmt: 'I' }], returns: [], source: 'upstream' },
  Pattern_CloudGet: { command: 'Pattern.CloudGet', args: [], returns: ['i', '**f', '**f'], source: 'upstream' },
  Pattern_CloudSet: { command: 'Pattern.CloudSet', args: [{ name: 'Set_active_pattern', fmt: 'I' }, { name: 'Number_of_points', fmt: 'i' }, { name: 'X_coordinates_m', fmt: '*f' }, { name: 'Y_coordinates_m', fmt: '*f' }], returns: [], source: 'upstream' },
  Pattern_ExpOpen: { command: 'Pattern.ExpOpen', args: [], returns: [], source: 'upstream' },
  Pattern_ExpPause: { command: 'Pattern.ExpPause', args: [{ name: 'Pause_Resume', fmt: 'I' }], returns: [], source: 'upstream' },
  Pattern_ExpStart: { command: 'Pattern.ExpStart', args: [{ name: 'Pattern', fmt: 'H' }], returns: [], source: 'upstream' },
  Pattern_ExpStatusGet: { command: 'Pattern.ExpStatusGet', args: [], returns: ['I'], source: 'upstream' },
  Pattern_ExpStop: { command: 'Pattern.ExpStop', args: [], returns: [], source: 'upstream' },
  Pattern_GridGet: { command: 'Pattern.GridGet', args: [], returns: ['i', 'i', 'f', 'f', 'f', 'f', 'f'], source: 'upstream' },
  Pattern_GridSet: { command: 'Pattern.GridSet', args: [{ name: 'Set_active_pattern', fmt: 'I' }, { name: 'Number_of_points_in_X', fmt: 'i' }, { name: 'Number_of_points_in_Y', fmt: 'i' }, { name: 'Grid_Scan_frame', fmt: 'I' }, { name: 'Center_X_m', fmt: 'f' }, { name: 'Center_Y_m', fmt: 'f' }, { name: 'Width_m', fmt: 'f' }, { name: 'Height_m', fmt: 'f' }, { name: 'Angle_deg', fmt: 'f' }], returns: [], source: 'upstream' },
  Pattern_LineGet: { command: 'Pattern.LineGet', args: [], returns: ['i', 'f', 'f', 'f', 'f'], source: 'upstream' },
  Pattern_LineSet: { command: 'Pattern.LineSet', args: [{ name: 'Set_active_pattern', fmt: 'I' }, { name: 'Number_of_points', fmt: 'i' }, { name: 'Line_Scan_frame', fmt: 'I' }, { name: 'Line_Point_1_X_m', fmt: 'f' }, { name: 'Line_Point_1_Y_m', fmt: 'f' }, { name: 'Line_Point_2_X_m', fmt: 'f' }, { name: 'Line_Point_2_Y_m', fmt: 'f' }], returns: [], source: 'upstream' },
  Pattern_PropsGet: { command: 'Pattern.PropsGet', args: [], returns: ['i', 'i', '*+c', 'i', '*-c', 'i', '*-c', 'f', 'I'], source: 'upstream' },
  Pattern_PropsSet: { command: 'Pattern.PropsSet', args: [{ name: 'Selected_experiment', fmt: '+*c' }, { name: 'Basename', fmt: '+*c' }, { name: 'External_VI_path', fmt: '+*c' }, { name: 'Pre_measure_delay_s', fmt: 'f' }, { name: 'Save_scan_channels', fmt: 'I' }], returns: [], source: 'upstream' },
  Piezo_CalibrGet: { command: 'Piezo.CalibrGet', args: [], returns: ['f', 'f', 'f'], source: 'upstream' },
  Piezo_DriftCompGet: { command: 'Piezo.DriftCompGet', args: [], returns: ['I', 'f', 'f', 'f', 'I', 'I', 'I', 'f'], source: 'upstream' },
  Piezo_DriftCompSet: { command: 'Piezo.DriftCompSet', args: [{ name: 'Compensation_on_off', fmt: 'I' }, { name: 'Vx_m_s', fmt: 'f' }, { name: 'Vy_m_s', fmt: 'f' }, { name: 'Vz_m_s', fmt: 'f' }, { name: 'Sat_Lim', fmt: 'f' }], returns: [], source: 'upstream' },
  Piezo_HVAInfoGet: { command: 'Piezo.HVAInfoGet', args: [], returns: ['f', 'f', 'f', 'f', 'I', 'I', 'I'], source: 'upstream' },
  Piezo_HVAStatusLEDGet: { command: 'Piezo.HVAStatusLEDGet', args: [], returns: ['I', 'I', 'I', 'I'], source: 'upstream' },
  Piezo_HystFileLoad: { command: 'Piezo.HystFileLoad', args: [{ name: 'File_path', fmt: '+*c' }], returns: [], source: 'upstream' },
  Piezo_HystFileSave: { command: 'Piezo.HystFileSave', args: [{ name: 'File_path', fmt: '+*c' }], returns: [], source: 'upstream' },
  Piezo_HystOnOffGet: { command: 'Piezo.HystOnOffGet', args: [], returns: ['I'], source: 'upstream' },
  Piezo_HystOnOffSet: { command: 'Piezo.HystOnOffSet', args: [{ name: 'On_Off', fmt: 'I' }], returns: [], source: 'upstream' },
  Piezo_HystValsGet: { command: 'Piezo.HystValsGet', args: [], returns: ['i', '*f', 'i', '*f', 'i', '*f', 'i', '*f'], source: 'upstream' },
  Piezo_HystValsSet: { command: 'Piezo.HystValsSet', args: [{ name: 'Fast_axis__number_points_X', fmt: 'i' }, { name: 'Fast_axis_points_X', fmt: '*f' }, { name: 'Fast_axis_number_points_Y', fmt: 'i' }, { name: 'Fast_axis_points_Y', fmt: '*f' }, { name: 'Slow_axis_number_points_X', fmt: 'i' }, { name: 'Slow_axis_points_X', fmt: '*f' }, { name: 'Slow_axis_number_points_Y', fmt: 'i' }, { name: 'Slow_axis_points_Y', fmt: '*f' }], returns: [], source: 'upstream' },
  Piezo_RangeGet: { command: 'Piezo.RangeGet', args: [], returns: ['f', 'f', 'f'], source: 'upstream' },
  Piezo_RangeSet: { command: 'Piezo.RangeSet', args: [{ name: 'Range_X_m', fmt: 'f' }, { name: 'Range_Y_m', fmt: 'f' }, { name: 'Range_Z_m', fmt: 'f' }], returns: [], source: 'upstream' },
  Piezo_SensGet: { command: 'Piezo.SensGet', args: [], returns: ['f', 'f', 'f'], source: 'upstream' },
  Piezo_SensSet: { command: 'Piezo.SensSet', args: [{ name: 'Calibration_X_mPerV', fmt: 'f' }, { name: 'Calibration_Y_mPerV', fmt: 'f' }, { name: 'Calibration_Z_mPerV', fmt: 'f' }], returns: [], source: 'upstream' },
  Piezo_TiltGet: { command: 'Piezo.TiltGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  Piezo_TiltSet: { command: 'Piezo.TiltSet', args: [{ name: 'Tilt_X_deg', fmt: 'f' }, { name: 'Tilt_Y_deg', fmt: 'f' }], returns: [], source: 'upstream' },
  Piezo_XYZLimitsGet: { command: 'Piezo.XYZLimitsGet', args: [], returns: ['H', 'f', 'f', 'f', 'f', 'f', 'f'], source: 'upstream' },
  Piezo_XYZLimitsSet: { command: 'Piezo.XYZLimitsSet', args: [{ name: 'Enable_limits', fmt: 'H' }, { name: 'Limit_X_low_V', fmt: 'f' }, { name: 'Limit_X_high_V', fmt: 'f' }, { name: 'Limit_Y_low_V', fmt: 'f' }, { name: 'Limit_Y_high_V', fmt: 'f' }, { name: 'Limit_Z_low_V', fmt: 'f' }, { name: 'Limit_Z_high_V', fmt: 'f' }], returns: [], source: 'upstream' },
  SafeTip_OnOffGet: { command: 'SafeTip.OnOffGet', args: [], returns: ['H'], source: 'upstream' },
  SafeTip_OnOffSet: { command: 'SafeTip.OnOffSet', args: [{ name: 'Safe_Tip_status', fmt: 'H' }], returns: [], source: 'upstream' },
  SafeTip_PropsGet: { command: 'SafeTip.PropsGet', args: [], returns: ['H', 'H', 'f'], source: 'upstream' },
  SafeTip_PropsSet: { command: 'SafeTip.PropsSet', args: [{ name: 'Auto_recovery', fmt: 'H' }, { name: 'Auto_pause_scan', fmt: 'H' }, { name: 'Threshold', fmt: 'f' }], returns: [], source: 'upstream' },
  SafeTip_SignalGet: { command: 'SafeTip.SignalGet', args: [], returns: ['f'], source: 'upstream' },
  Scan_Action: { command: 'Scan.Action', args: [{ name: 'Scan_action', fmt: 'H' }, { name: 'Scan_direction', fmt: 'I' }], returns: [], source: 'upstream' },
  Scan_BackgroundDelete: { command: 'Scan.BackgroundDelete', args: [{ name: 'Wait_until_deleted', fmt: 'I' }, { name: 'Timeout_ms', fmt: 'i' }, { name: 'Which_background', fmt: 'I' }], returns: ['I'], source: 'upstream' },
  Scan_BackgroundPaste: { command: 'Scan.BackgroundPaste', args: [{ name: 'Wait_until_pasted', fmt: 'I' }, { name: 'Timeout_ms', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  Scan_BufferGet: { command: 'Scan.BufferGet', args: [], returns: ['i', '*i', 'i', 'i'], source: 'upstream' },
  Scan_BufferSet: { command: 'Scan.BufferSet', args: [{ name: 'Channel_indexes', fmt: '+*i' }, { name: 'Pixels', fmt: 'i' }, { name: 'Lines', fmt: 'i' }], returns: [], source: 'upstream' },
  Scan_FrameDataGrab: { command: 'Scan.FrameDataGrab', args: [{ name: 'Channel_index', fmt: 'I' }, { name: 'Data_direction', fmt: 'I' }], returns: ['i', '*-c', 'i', 'i', '2f', 'I'], source: 'upstream' },
  Scan_FrameGet: { command: 'Scan.FrameGet', args: [], returns: ['f', 'f', 'f', 'f', 'f'], source: 'upstream' },
  Scan_FrameSet: { command: 'Scan.FrameSet', args: [{ name: 'Center_X_m', fmt: 'f' }, { name: 'Center_Y_m', fmt: 'f' }, { name: 'Width_m', fmt: 'f' }, { name: 'Height_m', fmt: 'f' }, { name: 'Angle_deg', fmt: 'f' }], returns: [], source: 'upstream' },
  Scan_PropsGet: { command: 'Scan.PropsGet', args: [], returns: ['I', 'I', 'I', 'i', '*-c', 'i', '*-c', 'i', 'i', '*+c', 'i', '*+i', 'i', 'i', '*2c', 'I'], source: 'patch' },
  Scan_PropsSet: { command: 'Scan.PropsSet', args: [{ name: 'Continuous_scan', fmt: 'I' }, { name: 'Bouncy_scan', fmt: 'I' }, { name: 'Autosave', fmt: 'I' }, { name: 'Series_name', fmt: '+*c' }, { name: 'Comment', fmt: '+*c' }, { name: 'Modules_names', fmt: '+*c' }, { name: 'Autopaste', fmt: 'I' }], returns: [], source: 'upstream' },
  Scan_Save: { command: 'Scan.Save', args: [{ name: 'Wait_until_saved', fmt: 'I' }, { name: 'Timeout_ms', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  Scan_SpeedGet: { command: 'Scan.SpeedGet', args: [], returns: ['f', 'f', 'f', 'f', 'H', 'f'], source: 'upstream' },
  Scan_SpeedSet: { command: 'Scan.SpeedSet', args: [{ name: 'Forward_linear_speed_m_s', fmt: 'f' }, { name: 'Backward_linear_speed_m_s', fmt: 'f' }, { name: 'Forward_time_per_line_s', fmt: 'f' }, { name: 'Backward_time_per_line_s', fmt: 'f' }, { name: 'Keep_parameter_constant', fmt: 'H' }, { name: 'Speed_ratio', fmt: 'f' }], returns: [], source: 'upstream' },
  Scan_StatusGet: { command: 'Scan.StatusGet', args: [], returns: ['I'], source: 'upstream' },
  Scan_WaitEndOfScan: { command: 'Scan.WaitEndOfScan', args: [{ name: 'Timeout_ms', fmt: 'i' }], returns: ['I', 'I', '*-c'], source: 'upstream' },
  Scan_XYPosGet: { command: 'Scan.XYPosGet', args: [{ name: 'Wait_newest_data', fmt: 'I' }], returns: ['f', 'f'], source: 'upstream' },
  Script_Autosave: { command: 'Script.Autosave', args: [{ name: 'Acquire_buffer', fmt: 'H' }, { name: 'Sweep_number', fmt: 'i' }, { name: 'All_sweeps_to_same_file', fmt: 'I' }, { name: 'Folder_path', fmt: '+*c' }, { name: 'Basename', fmt: '+*c' }], returns: [], source: 'upstream' },
  Script_ChsGet: { command: 'Script.ChsGet', args: [{ name: 'Acquire_buffer', fmt: 'H' }], returns: ['i', '*i'], source: 'upstream' },
  Script_ChsSet: { command: 'Script.ChsSet', args: [{ name: 'Acquire_buffer', fmt: 'H' }, { name: 'Channel_indexes', fmt: '+*i' }], returns: [], source: 'upstream' },
  Script_DataGet: { command: 'Script.DataGet', args: [{ name: 'Acquire_buffer', fmt: 'H' }, { name: 'Sweep_number', fmt: 'i' }], returns: ['i', 'i', '2f'], source: 'upstream' },
  Script_Deploy: { command: 'Script.Deploy', args: [{ name: 'Script_index', fmt: 'i' }], returns: [], source: 'upstream' },
  Script_LUTDeploy: { command: 'Script.LUTDeploy', args: [{ name: 'Script_index', fmt: 'i' }, { name: 'Wait_until_finished', fmt: 'I' }, { name: 'Timeout_ms', fmt: 'i' }], returns: [], source: 'upstream' },
  Script_LUTLoad: { command: 'Script.LUTLoad', args: [{ name: 'Script_index', fmt: 'i' }, { name: 'Script_file_path', fmt: '+*c' }, { name: 'LUT_Values', fmt: '*f' }], returns: [], source: 'upstream' },
  Script_LUTOpen: { command: 'Script.LUTOpen', args: [], returns: [], source: 'upstream' },
  Script_LUTSave: { command: 'Script.LUTSave', args: [{ name: 'Script_index', fmt: 'i' }, { name: 'Script_file_path', fmt: '+*c' }], returns: [], source: 'upstream' },
  Script_Load: { command: 'Script.Load', args: [{ name: 'Script_index', fmt: 'i' }, { name: 'Script_file_path', fmt: '+*c' }, { name: 'Load_session', fmt: 'I' }], returns: [], source: 'upstream' },
  Script_Open: { command: 'Script.Open', args: [], returns: [], source: 'upstream' },
  Script_Run: { command: 'Script.Run', args: [{ name: 'Script_index', fmt: 'i' }, { name: 'Wait_until_script_finishes', fmt: 'I' }], returns: [], source: 'upstream' },
  Script_Save: { command: 'Script.Save', args: [{ name: 'Script_index', fmt: 'i' }, { name: 'Script_file_path', fmt: '+*c' }, { name: 'Save_session', fmt: 'I' }], returns: [], source: 'upstream' },
  Script_Stop: { command: 'Script.Stop', args: [], returns: [], source: 'upstream' },
  Script_Undeploy: { command: 'Script.Undeploy', args: [{ name: 'Script_index', fmt: 'i' }], returns: [], source: 'upstream' },
  SignalChart_ChsGet: { command: 'SignalChart.ChsGet', args: [], returns: ['i', 'i'], source: 'upstream' },
  SignalChart_ChsSet: { command: 'SignalChart.ChsSet', args: [{ name: 'Channel__A__index', fmt: 'i' }, { name: 'Channel__B__index', fmt: 'i' }], returns: [], source: 'upstream' },
  SignalChart_Open: { command: 'SignalChart.Open', args: [], returns: [], source: 'upstream' },
  Signals_AddRTGet: { command: 'Signals.AddRTGet', args: [], returns: ['i', 'i', '*+c', 'i', '*-c', 'i', '*-c'], source: 'upstream' },
  Signals_AddRTSet: { command: 'Signals.AddRTSet', args: [{ name: 'Additional_RT_signal_1', fmt: 'i' }, { name: 'Additional_RT_signal_2', fmt: 'i' }], returns: [], source: 'upstream' },
  Signals_CalibrGet: { command: 'Signals.CalibrGet', args: [{ name: 'Signal_index', fmt: 'i' }], returns: ['f', 'f'], source: 'upstream' },
  Signals_MeasNamesGet: { command: 'Signals.MeasNamesGet', args: [], returns: ['i', 'i', '*+c'], source: 'upstream' },
  Signals_NamesGet: { command: 'Signals.NamesGet', args: [], returns: ['i', 'i', '*+c'], source: 'upstream' },
  Signals_RangeGet: { command: 'Signals.RangeGet', args: [{ name: 'Signal_index', fmt: 'i' }], returns: ['f', 'f'], source: 'upstream' },
  Signals_ValGet: { command: 'Signals.ValGet', args: [{ name: 'Signal_index', fmt: 'i' }, { name: 'Wait_for_newest_data', fmt: 'I' }], returns: ['f'], source: 'upstream' },
  Signals_ValsGet: { command: 'Signals.ValsGet', args: [{ name: 'Signals_indexes', fmt: '+*i' }, { name: 'Wait_for_newest_data', fmt: 'I' }], returns: ['i', '*f'], source: 'upstream' },
  SpectrumAnlzr_ACCouplingGet: { command: 'SpectrumAnlzr.ACCouplingGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['I'], source: 'upstream' },
  SpectrumAnlzr_ACCouplingSet: { command: 'SpectrumAnlzr.ACCouplingSet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'AC_coupling', fmt: 'I' }], returns: [], source: 'upstream' },
  SpectrumAnlzr_AveragGet: { command: 'SpectrumAnlzr.AveragGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['H', 'H', 'I'], source: 'upstream' },
  SpectrumAnlzr_AveragSet: { command: 'SpectrumAnlzr.AveragSet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'Averaging_mode', fmt: 'H' }, { name: 'Weighting_mode', fmt: 'H' }, { name: 'Count', fmt: 'I' }], returns: [], source: 'upstream' },
  SpectrumAnlzr_BandRMSGet: { command: 'SpectrumAnlzr.BandRMSGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['d', 'd', 'd'], source: 'upstream' },
  SpectrumAnlzr_ChGet: { command: 'SpectrumAnlzr.ChGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  SpectrumAnlzr_ChSet: { command: 'SpectrumAnlzr.ChSet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'Channel__index', fmt: 'i' }], returns: [], source: 'upstream' },
  SpectrumAnlzr_CursorPosGet: { command: 'SpectrumAnlzr.CursorPosGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'Cursor_type', fmt: 'H' }], returns: ['d', 'd', 'd'], source: 'upstream' },
  SpectrumAnlzr_CursorPosSet: { command: 'SpectrumAnlzr.CursorPosSet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'Cursor_type', fmt: 'H' }, { name: 'Position_X_Cursor_1_Hz', fmt: 'd' }, { name: 'Position_X_Cursor_2_Hz', fmt: 'd' }], returns: [], source: 'upstream' },
  SpectrumAnlzr_DCGet: { command: 'SpectrumAnlzr.DCGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['d'], source: 'upstream' },
  SpectrumAnlzr_DataGet: { command: 'SpectrumAnlzr.DataGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['d', 'd', 'i', '*d'], source: 'patch' },
  SpectrumAnlzr_FFTWindowGet: { command: 'SpectrumAnlzr.FFTWindowGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['H'], source: 'upstream' },
  SpectrumAnlzr_FFTWindowSet: { command: 'SpectrumAnlzr.FFTWindowSet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'FFT_window__index', fmt: 'H' }], returns: [], source: 'upstream' },
  SpectrumAnlzr_FreqRangeGet: { command: 'SpectrumAnlzr.FreqRangeGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['i', 'i', '*f'], source: 'upstream' },
  SpectrumAnlzr_FreqRangeSet: { command: 'SpectrumAnlzr.FreqRangeSet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'Range__index', fmt: 'i' }], returns: [], source: 'upstream' },
  SpectrumAnlzr_FreqResGet: { command: 'SpectrumAnlzr.FreqResGet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: ['H', 'i', '*f'], source: 'upstream' },
  SpectrumAnlzr_FreqResSet: { command: 'SpectrumAnlzr.FreqResSet', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }, { name: 'Resolution__index', fmt: 'H' }], returns: [], source: 'upstream' },
  SpectrumAnlzr_Run: { command: 'SpectrumAnlzr.Run', args: [{ name: 'Spectrum_Analyzer_instance', fmt: 'i' }], returns: [], source: 'upstream' },
  TCPLog_ChsSet: { command: 'TCPLog.ChsSet', args: [{ name: 'Num_channels', fmt: 'i' }, { name: 'Channel_indexes', fmt: '*i' }], returns: [], source: 'upstream' },
  TCPLog_OversamplSet: { command: 'TCPLog.OversamplSet', args: [{ name: 'Oversampling_value', fmt: 'i' }], returns: [], source: 'upstream' },
  TCPLog_Start: { command: 'TCPLog.Start', args: [], returns: [], source: 'upstream' },
  TCPLog_StatusGet: { command: 'TCPLog.StatusGet', args: [], returns: ['i'], source: 'upstream' },
  TCPLog_Stop: { command: 'TCPLog.Stop', args: [], returns: [], source: 'upstream' },
  TipRec_BufferClear: { command: 'TipRec.BufferClear', args: [], returns: [], source: 'upstream' },
  TipRec_BufferSizeGet: { command: 'TipRec.BufferSizeGet', args: [], returns: ['i'], source: 'upstream' },
  TipRec_BufferSizeSet: { command: 'TipRec.BufferSizeSet', args: [{ name: 'Buffer_size', fmt: 'i' }], returns: [], source: 'upstream' },
  TipRec_DataGet: { command: 'TipRec.DataGet', args: [], returns: ['i', '*i', 'i', 'i', '2f'], source: 'upstream' },
  TipRec_DataSave: { command: 'TipRec.DataSave', args: [{ name: 'Clear_buffer', fmt: 'I' }, { name: 'Basename', fmt: '+*c' }], returns: [], source: 'upstream' },
  TipShaper_PropsGet: { command: 'TipShaper.PropsGet', args: [], returns: ['f', 'I', 'f', 'f', 'f', 'f', 'f', 'f', 'f', 'f', 'I'], source: 'upstream' },
  TipShaper_PropsSet: { command: 'TipShaper.PropsSet', args: [{ name: 'Switch_Off_Delay', fmt: 'f' }, { name: 'Change_Bias', fmt: 'I' }, { name: 'Bias_V', fmt: 'f' }, { name: 'Tip_Lift_m', fmt: 'f' }, { name: 'Lift_Time_1_s', fmt: 'f' }, { name: 'Bias_Lift_V', fmt: 'f' }, { name: 'Bias_Settling_Time_s', fmt: 'f' }, { name: 'Lift_Height_m', fmt: 'f' }, { name: 'Lift_Time_2_s', fmt: 'f' }, { name: 'End_Wait_Time_s', fmt: 'f' }, { name: 'Restore_Feedback', fmt: 'I' }], returns: [], source: 'upstream' },
  TipShaper_Start: { command: 'TipShaper.Start', args: [{ name: 'Wait_until_finished', fmt: 'I' }, { name: 'Timeout_ms', fmt: 'i' }], returns: [], source: 'upstream' },
  UserIn_CalibrSet: { command: 'UserIn.CalibrSet', args: [{ name: 'Input_index', fmt: 'i' }, { name: 'Calibration_per_volt', fmt: 'f' }, { name: 'Offset_in_physical_units', fmt: 'f' }], returns: [], source: 'upstream' },
  UserOut_CalcSignalConfigGet: { command: 'UserOut.CalcSignalConfigGet', args: [{ name: 'Output_index', fmt: 'i' }], returns: ['H', 'H', 'H'], source: 'upstream' },
  UserOut_CalcSignalConfigSet: { command: 'UserOut.CalcSignalConfigSet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Signal_1', fmt: 'H' }, { name: 'Operation', fmt: 'H' }, { name: 'Signal_2', fmt: 'H' }], returns: [], source: 'upstream' },
  UserOut_CalcSignalNameGet: { command: 'UserOut.CalcSignalNameGet', args: [{ name: 'Output_index', fmt: 'i' }], returns: ['i', '*-c'], source: 'upstream' },
  UserOut_CalcSignalNameSet: { command: 'UserOut.CalcSignalNameSet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Calculated_signal_name', fmt: '+*c' }], returns: [], source: 'upstream' },
  UserOut_CalibrSet: { command: 'UserOut.CalibrSet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Calibration_per_volt', fmt: 'f' }, { name: 'Offset_in_physical_units', fmt: 'f' }], returns: [], source: 'upstream' },
  UserOut_LimitsGet: { command: 'UserOut.LimitsGet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Raw_limits', fmt: 'I' }], returns: ['f', 'f'], source: 'upstream' },
  UserOut_LimitsSet: { command: 'UserOut.LimitsSet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Upper_limit', fmt: 'f' }, { name: 'Lower_limit', fmt: 'f' }, { name: 'Raw_limits', fmt: 'I' }], returns: [], source: 'upstream' },
  UserOut_ModeGet: { command: 'UserOut.ModeGet', args: [{ name: 'Output_index', fmt: 'i' }], returns: ['H'], source: 'upstream' },
  UserOut_ModeSet: { command: 'UserOut.ModeSet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Output_mode', fmt: 'H' }], returns: [], source: 'upstream' },
  UserOut_MonitorChGet: { command: 'UserOut.MonitorChGet', args: [{ name: 'Output_index', fmt: 'i' }], returns: ['i'], source: 'upstream' },
  UserOut_MonitorChSet: { command: 'UserOut.MonitorChSet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Monitor_channel_index', fmt: 'i' }], returns: [], source: 'upstream' },
  UserOut_ValSet: { command: 'UserOut.ValSet', args: [{ name: 'Output_index', fmt: 'i' }, { name: 'Output_value', fmt: 'f' }], returns: [], source: 'upstream' },
  Util_AcqPeriodGet: { command: 'Util.AcqPeriodGet', args: [], returns: ['f'], source: 'upstream' },
  Util_AcqPeriodSet: { command: 'Util.AcqPeriodSet', args: [{ name: 'Acquisition_Period_s', fmt: 'f' }], returns: [], source: 'upstream' },
  Util_LayoutLoad: { command: 'Util.LayoutLoad', args: [{ name: 'Layout_file_path', fmt: '+*c' }, { name: 'Load_session_layout', fmt: 'I' }], returns: [], source: 'upstream' },
  Util_LayoutSave: { command: 'Util.LayoutSave', args: [{ name: 'Layout_file_path', fmt: '+*c' }, { name: 'Save_session_layout', fmt: 'I' }], returns: [], source: 'upstream' },
  Util_Lock: { command: 'Util.Lock', args: [], returns: [], source: 'upstream' },
  Util_Quit: { command: 'Util.Quit', args: [{ name: 'Use_Stored_Values', fmt: 'I' }, { name: 'Settings_Name', fmt: '+*c' }, { name: 'Layout_Name', fmt: '+*c' }, { name: 'Save_Signals', fmt: 'I' }], returns: [], source: 'upstream' },
  Util_RTFreqGet: { command: 'Util.RTFreqGet', args: [], returns: ['f'], source: 'upstream' },
  Util_RTFreqSet: { command: 'Util.RTFreqSet', args: [{ name: 'RT_frequency', fmt: 'f' }], returns: [], source: 'upstream' },
  Util_RTOversamplGet: { command: 'Util.RTOversamplGet', args: [], returns: ['i'], source: 'upstream' },
  Util_RTOversamplSet: { command: 'Util.RTOversamplSet', args: [{ name: 'RT_oversampling', fmt: 'i' }], returns: [], source: 'upstream' },
  Util_SessionPathGet: { command: 'Util.SessionPathGet', args: [], returns: ['i', '*-c'], source: 'upstream' },
  Util_SessionPathSet: { command: 'Util.SessionPathSet', args: [{ name: 'Session_path', fmt: '+*c' }, { name: 'Save_settings_to_previous', fmt: 'I' }], returns: [], source: 'patch' },
  Util_SettingsLoad: { command: 'Util.SettingsLoad', args: [{ name: 'Settings_file_path', fmt: '+*c' }, { name: 'Load_session_settings', fmt: 'I' }], returns: [], source: 'upstream' },
  Util_SettingsSave: { command: 'Util.SettingsSave', args: [{ name: 'Settings_file_path', fmt: '+*c' }, { name: 'Save_session_settings', fmt: 'I' }], returns: [], source: 'upstream' },
  Util_UnLock: { command: 'Util.UnLock', args: [], returns: [], source: 'upstream' },
  Util_VersionGet: { command: 'Util.VersionGet', args: [], returns: ['+*c', '+*c', 'I', 'I'], source: 'upstream' },
  ZCtrl_ActiveCtrlSet: { command: 'ZCtrl.ActiveCtrlSet', args: [{ name: 'Z_Controller_index', fmt: 'i' }], returns: [], source: 'upstream' },
  ZCtrl_CtrlListGet: { command: 'ZCtrl.CtrlListGet', args: [], returns: ['i', 'i', '*+c', 'i'], source: 'upstream' },
  ZCtrl_GainGet: { command: 'ZCtrl.GainGet', args: [], returns: ['f', 'f', 'f'], source: 'upstream' },
  ZCtrl_GainSet: { command: 'ZCtrl.GainSet', args: [{ name: 'P_gain', fmt: 'f' }, { name: 'Time_constant_s', fmt: 'f' }, { name: 'I_gain', fmt: 'f' }], returns: [], source: 'upstream' },
  ZCtrl_Home: { command: 'ZCtrl.Home', args: [], returns: [], source: 'upstream' },
  ZCtrl_HomePropsGet: { command: 'ZCtrl.HomePropsGet', args: [], returns: ['H', 'f'], source: 'upstream' },
  ZCtrl_HomePropsSet: { command: 'ZCtrl.HomePropsSet', args: [{ name: 'Relative_or_Absolute', fmt: 'H' }, { name: 'Home_position_m', fmt: 'f' }], returns: [], source: 'upstream' },
  ZCtrl_LimitsEnabledGet: { command: 'ZCtrl.LimitsEnabledGet', args: [], returns: ['I'], source: 'upstream' },
  ZCtrl_LimitsEnabledSet: { command: 'ZCtrl.LimitsEnabledSet', args: [{ name: 'Limit_Z_status', fmt: 'I' }], returns: [], source: 'upstream' },
  ZCtrl_LimitsGet: { command: 'ZCtrl.LimitsGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  ZCtrl_LimitsSet: { command: 'ZCtrl.LimitsSet', args: [{ name: 'Z_high_limit_m', fmt: 'f' }, { name: 'Z_low_limit_m', fmt: 'f' }], returns: [], source: 'upstream' },
  ZCtrl_OnOffGet: { command: 'ZCtrl.OnOffGet', args: [], returns: ['I'], source: 'upstream' },
  ZCtrl_OnOffSet: { command: 'ZCtrl.OnOffSet', args: [{ name: 'Z_Controller_status', fmt: 'I' }], returns: [], source: 'upstream' },
  ZCtrl_SetpntGet: { command: 'ZCtrl.SetpntGet', args: [], returns: ['f'], source: 'upstream' },
  ZCtrl_SetpntSet: { command: 'ZCtrl.SetpntSet', args: [{ name: 'Z_Controller_setpoint', fmt: 'f' }], returns: [], source: 'upstream' },
  ZCtrl_StatusGet: { command: 'ZCtrl.StatusGet', args: [], returns: ['H'], source: 'upstream' },
  ZCtrl_SwitchOffDelayGet: { command: 'ZCtrl.SwitchOffDelayGet', args: [], returns: ['f'], source: 'upstream' },
  ZCtrl_SwitchOffDelaySet: { command: 'ZCtrl.SwitchOffDelaySet', args: [{ name: 'Z_Controller_switch_off_delay_s', fmt: 'f' }], returns: [], source: 'upstream' },
  ZCtrl_TipLiftGet: { command: 'ZCtrl.TipLiftGet', args: [], returns: ['f'], source: 'upstream' },
  ZCtrl_TipLiftSet: { command: 'ZCtrl.TipLiftSet', args: [{ name: 'TipLift_m', fmt: 'f' }], returns: [], source: 'upstream' },
  ZCtrl_Withdraw: { command: 'ZCtrl.Withdraw', args: [{ name: 'Wait_until_finished', fmt: 'I' }, { name: 'Timeout_ms', fmt: 'i' }], returns: [], source: 'upstream' },
  ZCtrl_WithdrawRateGet: { command: 'ZCtrl.WithdrawRateGet', args: [], returns: ['f'], source: 'upstream' },
  ZCtrl_WithdrawRateSet: { command: 'ZCtrl.WithdrawRateSet', args: [{ name: 'Withdraw_slew_rate_mdivs', fmt: 'f' }], returns: [], source: 'upstream' },
  ZCtrl_ZPosGet: { command: 'ZCtrl.ZPosGet', args: [], returns: ['f'], source: 'upstream' },
  ZCtrl_ZPosSet: { command: 'ZCtrl.ZPosSet', args: [{ name: 'Z_position_m', fmt: 'f' }], returns: [], source: 'upstream' },
  ZSpectr_AdvPropsGet: { command: 'ZSpectr.AdvPropsGet', args: [], returns: ['f', 'H', 'H', 'H'], source: 'upstream' },
  ZSpectr_AdvPropsSet: { command: 'ZSpectr.AdvPropsSet', args: [{ name: 'Time_between_forward_and_backward_sweep_s', fmt: 'f' }, { name: 'Record_final_Z', fmt: 'H' }, { name: 'Lockin_Run', fmt: 'H' }, { name: 'Reset_Z', fmt: 'H' }], returns: [], source: 'upstream' },
  ZSpectr_ChsGet: { command: 'ZSpectr.ChsGet', args: [], returns: ['i', '*i', 'i', 'i', '*+c'], source: 'upstream' },
  ZSpectr_ChsSet: { command: 'ZSpectr.ChsSet', args: [{ name: 'Channel_indexes', fmt: '+*i' }], returns: [], source: 'upstream' },
  ZSpectr_DigSyncGet: { command: 'ZSpectr.DigSyncGet', args: [], returns: ['H'], source: 'upstream' },
  ZSpectr_DigSyncSet: { command: 'ZSpectr.DigSyncSet', args: [{ name: 'Digital_Sync', fmt: 'H' }], returns: [], source: 'upstream' },
  ZSpectr_Open: { command: 'ZSpectr.Open', args: [], returns: [], source: 'upstream' },
  ZSpectr_PropsGet: { command: 'ZSpectr.PropsGet', args: [], returns: ['H', 'i', 'i', 'i', '*+c', 'i', 'i', '*+c', 'H', 'H'], source: 'upstream' },
  ZSpectr_PropsSet: { command: 'ZSpectr.PropsSet', args: [{ name: 'Backward_sweep', fmt: 'H' }, { name: 'Number_of_points', fmt: 'i' }, { name: 'Number_of_sweeps', fmt: 'H' }, { name: 'Autosave', fmt: 'H' }, { name: 'Show_save_dialog', fmt: 'H' }, { name: 'Save_all', fmt: 'H' }], returns: [], source: 'upstream' },
  ZSpectr_PulseSeqSyncGet: { command: 'ZSpectr.PulseSeqSyncGet', args: [], returns: ['H', 'I'], source: 'upstream' },
  ZSpectr_PulseSeqSyncSet: { command: 'ZSpectr.PulseSeqSyncSet', args: [{ name: 'Pulse_Sequence_Nr', fmt: 'H' }, { name: 'Nr_Periods', fmt: 'I' }], returns: [], source: 'upstream' },
  ZSpectr_RangeGet: { command: 'ZSpectr.RangeGet', args: [], returns: ['f', 'f'], source: 'upstream' },
  ZSpectr_RangeSet: { command: 'ZSpectr.RangeSet', args: [{ name: 'Z_offset_m', fmt: 'f' }, { name: 'Z_sweep_distance_m', fmt: 'f' }], returns: [], source: 'upstream' },
  ZSpectr_RetractDelayGet: { command: 'ZSpectr.RetractDelayGet', args: [], returns: ['f'], source: 'upstream' },
  ZSpectr_RetractDelaySet: { command: 'ZSpectr.RetractDelaySet', args: [{ name: 'Retract_delay_s', fmt: 'f' }], returns: [], source: 'upstream' },
  ZSpectr_RetractGet: { command: 'ZSpectr.RetractGet', args: [], returns: ['H', 'f', 'i', 'H'], source: 'upstream' },
  ZSpectr_RetractSecondGet: { command: 'ZSpectr.RetractSecondGet', args: [], returns: ['i', 'f', 'i', 'H'], source: 'upstream' },
  ZSpectr_RetractSecondSet: { command: 'ZSpectr.RetractSecondSet', args: [{ name: 'Second_condition', fmt: 'i' }, { name: 'Threshold', fmt: 'f' }, { name: 'Signal_index', fmt: 'i' }, { name: 'Comparison', fmt: 'H' }], returns: [], source: 'upstream' },
  ZSpectr_RetractSet: { command: 'ZSpectr.RetractSet', args: [{ name: 'Enable', fmt: 'H' }, { name: 'Threshold', fmt: 'f' }, { name: 'Signal_index', fmt: 'i' }, { name: 'Comparison', fmt: 'H' }], returns: [], source: 'upstream' },
  ZSpectr_Start: { command: 'ZSpectr.Start', args: [{ name: 'Get_data', fmt: 'I' }, { name: 'Save_base_name', fmt: '+*c' }], returns: ['i', 'i', '*+c', 'i', 'i', '2f', 'i', '*f'], source: 'upstream' },
  ZSpectr_StatusGet: { command: 'ZSpectr.StatusGet', args: [], returns: ['I'], source: 'upstream' },
  ZSpectr_Stop: { command: 'ZSpectr.Stop', args: [], returns: [], source: 'upstream' },
  ZSpectr_TTLSyncGet: { command: 'ZSpectr.TTLSyncGet', args: [], returns: ['H', 'H', 'f', 'f'], source: 'upstream' },
  ZSpectr_TTLSyncSet: { command: 'ZSpectr.TTLSyncSet', args: [{ name: 'TTL_line', fmt: 'H' }, { name: 'TTL_polarity', fmt: 'H' }, { name: 'Time_to_on_s', fmt: 'f' }, { name: 'On_duration_s', fmt: 'f' }], returns: [], source: 'upstream' },
  ZSpectr_TimingGet: { command: 'ZSpectr.TimingGet', args: [], returns: ['f', 'f', 'f', 'f', 'f', 'f', 'f'], source: 'upstream' },
  ZSpectr_TimingSet: { command: 'ZSpectr.TimingSet', args: [{ name: 'Z_averaging_time_s', fmt: 'f' }, { name: 'Initial_settling_time_s', fmt: 'f' }, { name: 'Maximum_slew_rate_Vdivs', fmt: 'f' }, { name: 'Settling_time_s', fmt: 'f' }, { name: 'Integration_time_s', fmt: 'f' }, { name: 'End_settling_time_s', fmt: 'f' }, { name: 'Z_control_time_s', fmt: 'f' }], returns: [], source: 'upstream' },
} as const satisfies Record<string, MethodSpec>

export type NanonisMethodName = keyof typeof NANONIS_METHODS

/**
 * 调用一次线协议往返：编码参数、发帧、收帧、按 `returns` 解码。
 * **不规定失败怎么表达**——抛还是包成 Result 是传输层与仪器服务的策略（PLAN §7.1），
 * 生成层只负责把类型对上。
 */
export type NanonisCall = (
  command: string,
  args: readonly ArgValue[],
  returns: readonly string[],
) => Promise<unknown[]>

/** 671 个方法的类型化门面。`typed.Bias_Get()` 有提示、参数名与旧仓一致。 */
export interface NanonisFacade {
  APRFGen_FreqGet(): Promise<[number]>
  APRFGen_FreqSet(Force_RF_On: number, Frequency_Hz: number): Promise<[]>
  APRFGen_FreqSwpLimitsGet(): Promise<[number, number]>
  APRFGen_FreqSwpLimitsSet(Lower_limit: number, Upper_limit: number): Promise<[]>
  APRFGen_FreqSwpPropsGet(): Promise<[number, number, number, number, number, number, number]>
  APRFGen_FreqSwpPropsSet(Mode: number, Dwell_s: number, Repetitions: number, Infinite: number, Points: number, Off_s: number, AutoOff: number): Promise<[]>
  APRFGen_FreqSwpStart(Direction: number): Promise<[]>
  APRFGen_ListSwpPropsGet(): Promise<[number, number, number, number[][], number, number, number]>
  APRFGen_ListSwpPropsSet(Signal: number, Values: number[][], Infinite: number, Repetitions: number, AutoOff: number): Promise<[]>
  APRFGen_ListSwpStart(Direction: number): Promise<[]>
  APRFGen_PowerGet(): Promise<[number]>
  APRFGen_PowerSet(Force_RF_On: number, Power_dBm: number): Promise<[]>
  APRFGen_PowerSwpLimitsGet(): Promise<[number, number]>
  APRFGen_PowerSwpLimitsSet(Lower_limit: number, Upper_limit: number): Promise<[]>
  APRFGen_PowerSwpPropsGet(): Promise<[number, number, number, number, number, number]>
  APRFGen_PowerSwpPropsSet(Dwell_s: number, Repetitions: number, Infinite: number, Points: number, Off_s: number, AutoOff: number): Promise<[]>
  APRFGen_PowerSwpStart(Direction: number): Promise<[]>
  APRFGen_RFOutOnOffGet(): Promise<[number]>
  APRFGen_RFOutOnOffSet(RF_Output: number): Promise<[]>
  APRFGen_SwpStop(): Promise<[]>
  APRFGen_TrigPropsGet(): Promise<[number, number, number, number, number, number]>
  APRFGen_TrigPropsSet(Edge: number, Delay_s: number, Source: number, Type: number, Event_Count: number, Mode: number): Promise<[]>
  APRFGen_TrigRearm(): Promise<[]>
  AtomTrack_CtrlSet(AT_control: number, Status: number): Promise<[]>
  AtomTrack_DriftComp(): Promise<[]>
  AtomTrack_PropsGet(): Promise<[number, number, number, number, number]>
  AtomTrack_PropsSet(Integral_gain: number, Frequency_Hz: number, Amplitude_m: number, Phase_deg: number, Switch_Off_delay_s: number): Promise<[]>
  AtomTrack_QuickCompStart(AT_control: number): Promise<[]>
  AtomTrack_StatusGet(AT_control: number): Promise<[number]>
  AutoApproach_OnOffGet(): Promise<[number]>
  AutoApproach_OnOffSet(On_Off: number): Promise<[]>
  AutoApproach_Open(): Promise<[]>
  BeamDefl_AutoOffset(Deflection_signal: number): Promise<[]>
  BeamDefl_HorConfigGet(): Promise<[number, string, number, string, number, number]>
  BeamDefl_HorConfigSet(Name: string, Units: string, Calibration: number, Offset: number): Promise<[]>
  BeamDefl_IntConfigGet(): Promise<[number, string, number, string, number, number]>
  BeamDefl_IntConfigSet(Name: string, Units: string, Calibration: number, Offset: number): Promise<[]>
  BeamDefl_VerConfigGet(): Promise<[number, string, number, string, number, number]>
  BeamDefl_VerConfigSet(Name: string, Units: string, Calibration: number, Offset: number): Promise<[]>
  BiasSpectr_AdvPropsGet(): Promise<[number, number, number, number]>
  BiasSpectr_AdvPropsSet(Reset_Bias: number, Z_Controller_Hold: number, Record_final_Z: number, Lockin_Run: number): Promise<[]>
  BiasSpectr_AltZCtrlGet(): Promise<[number, number, number]>
  BiasSpectr_AltZCtrlSet(Alternate_Z_controller_setpoint: number, Setpoint: number, Settling_time_s: number): Promise<[]>
  BiasSpectr_ChsGet(): Promise<[number, number[], number, number, string[]]>
  BiasSpectr_ChsSet(Channel_indexes: number[]): Promise<[]>
  BiasSpectr_DigSyncGet(): Promise<[number]>
  BiasSpectr_DigSyncSet(Digital_Sync: number): Promise<[]>
  BiasSpectr_LimitsGet(): Promise<[number, number]>
  BiasSpectr_LimitsSet(Start_value_V: number, End_value_V: number): Promise<[]>
  BiasSpectr_MLSLockinPerSegGet(): Promise<[number]>
  BiasSpectr_MLSLockinPerSegSet(Lock_In_per_segment: number): Promise<[]>
  BiasSpectr_MLSModeGet(): Promise<[number, string]>
  BiasSpectr_MLSModeSet(Sweep_mode: string): Promise<[]>
  BiasSpectr_MLSValsGet(): Promise<[number, number[], number[], number[], number[], number[], number[], number[]]>
  BiasSpectr_MLSValsSet(No_Of_Segments: number, Bias_start_V: number[], Bias_end_V: number[], Initial_settling_time_s: number[], Settling_time_s: number[], Integration_time_s: number[], Steps: number[], Lock_In_run: number[]): Promise<[]>
  BiasSpectr_Open(): Promise<[]>
  BiasSpectr_PropsGet(): Promise<[number, number, number, number, number, number, string[], number, number, string[], number, number, string[]]>
  BiasSpectr_PropsSet(Save_all: number, Number_of_sweeps: number, Backward_sweep: number, Number_of_points: number, Z_offset_m: number, Autosave: number, Show_save_dialog: number): Promise<[]>
  BiasSpectr_PulseSeqSyncGet(): Promise<[number, number]>
  BiasSpectr_PulseSeqSyncSet(Pulse_Sequence_Nr: number, Nr_Periods: number): Promise<[]>
  BiasSpectr_Start(Get_data: number, Save_base_name: string): Promise<[number, number, string[], number, number, number[][], number, number[]]>
  BiasSpectr_StatusGet(): Promise<[]>
  BiasSpectr_Stop(): Promise<[]>
  BiasSpectr_TTLSyncGet(): Promise<[number, number, number, number]>
  BiasSpectr_TTLSyncSet(TTL_line: number, TTL_polarity: number, Time_to_on_s: number, On_duration_s: number): Promise<[]>
  BiasSpectr_TimingGet(): Promise<[number, number, number, number, number, number, number, number]>
  BiasSpectr_TimingSet(Z_averaging_time_s: number, Z_offset_m: number, Initial_settling_time_s: number, Maximum_slew_rate_Vdivs: number, Settling_time_s: number, Integration_time_s: number, End_settling_time_s: number, Z_control_time_s: number): Promise<[]>
  BiasSpectr_ZOffRevertGet(): Promise<[number]>
  BiasSpectr_ZOffRevertSet(Z_Offset_Revert: number): Promise<[]>
  BiasSwp_LimitsGet(): Promise<[number, number]>
  BiasSwp_LimitsSet(Lower_limit: number, Upper_limit: number): Promise<[]>
  BiasSwp_Open(): Promise<[]>
  BiasSwp_PropsSet(Number_of_steps: number, Period_ms: number, Autosave: number, Save_dialog_box: number): Promise<[]>
  BiasSwp_Start(Get_data: number, Sweep_direction: number, Z_Controller_status: number, Save_base_name: string, Reset_bias: number): Promise<[number, number, string[], number, number, number[][]]>
  Bias_CalibrGet(): Promise<[number, number]>
  Bias_CalibrSet(Calibration: number, Offset: number): Promise<[]>
  Bias_Get(): Promise<[number]>
  Bias_Pulse(Wait_until_done: number, Bias_pulse_width_s: number, Bias_value_V: number, Z_Controller_on_hold: number, Pulse_absolute_relative: number): Promise<[]>
  Bias_RangeGet(): Promise<[number, number, string[], number]>
  Bias_RangeSet(Bias_range_index: number): Promise<[]>
  Bias_Set(Bias_value_V: number): Promise<[]>
  CPDComp_Close(): Promise<[]>
  CPDComp_DataGet(): Promise<[number, number[], number[], number[], number, number[], number[], number[], number, number, number]>
  CPDComp_Open(): Promise<[]>
  CPDComp_ParamsGet(): Promise<[number, number, number]>
  CPDComp_ParamsSet(Speed_Hz: number, Range_V: number, Averaging: number): Promise<[]>
  Current_100Get(): Promise<[number]>
  Current_BEEMGet(): Promise<[number]>
  Current_CalibrGet(Gain_index: number): Promise<[number, number]>
  Current_CalibrSet(Gain_index: number, Calibration: number, Offset: number): Promise<[]>
  Current_GainSet(Gain_index: number, Filter_Index: number): Promise<[]>
  Current_GainsGet(): Promise<[number, number, string[], number, number, number, string[], number]>
  Current_Get(): Promise<[number]>
  DataLog_ChsGet(): Promise<[number, number[]]>
  DataLog_ChsSet(Channel_indexes: number[]): Promise<[]>
  DataLog_Open(): Promise<[]>
  DataLog_PropsGet(): Promise<[number, number, number, number, number, number, string, number, string]>
  DataLog_PropsSet(Acquisition_mode: number, Acquisition_duration_hours: number, Acquisition_duration_minutes: number, Acquisition_duration_seconds: number, Averaging: number, Basename: string, Comment: string, List_of_modules: string): Promise<[]>
  DataLog_Start(): Promise<[]>
  DataLog_StatusGet(): Promise<[number, string, number, number, number, number, string, number, string, number]>
  DataLog_Stop(): Promise<[]>
  DigLines_OutStatusSet(Port: number, Digital_line: number, Status: number): Promise<[]>
  DigLines_PropsSet(Digital_line: number, Port: number, Direction: number, Polarity: number): Promise<[]>
  DigLines_Pulse(Port: number, Digital_lines: number[], Pulse_width_s: number, Pulse_pause_s: number, Number_of_pulses: number, Wait_until_finished: number): Promise<[]>
  DigLines_TTLValGet(Port: number): Promise<[number, number[]]>
  FolMe_OversamplGet(): Promise<[number, number]>
  FolMe_OversamplSet(Oversampling: number): Promise<[]>
  FolMe_PSExpGet(): Promise<[number, number, number, string[]]>
  FolMe_PSExpSet(Point_And_Shoot_experiment: number): Promise<[]>
  FolMe_PSOnOffGet(): Promise<[number]>
  FolMe_PSOnOffSet(Point_And_Shoot_status: number): Promise<[]>
  FolMe_PSPropsGet(): Promise<[number, number, number, string, number, string, number]>
  FolMe_PSPropsSet(Auto_resume: number, Use_own_basename: number, Basename: string, External_VI_path: string, Pre_measure_delay_s: number): Promise<[]>
  FolMe_SpeedGet(): Promise<[number, number]>
  FolMe_SpeedSet(Speed_m_s: number, Custom_speed: number): Promise<[]>
  FolMe_Stop(): Promise<[]>
  FolMe_XYPosGet(Wait_for_newest_data: number): Promise<[number, number]>
  FolMe_XYPosSet(X_m: number, Y_m: number, Wait_end_of_move: number): Promise<[]>
  FunGen1Ch_IdleGet(): Promise<[number]>
  FunGen1Ch_IdleSet(Idle_value: number): Promise<[]>
  FunGen1Ch_PropsGet(): Promise<[number, number, number, number]>
  FunGen1Ch_PropsSet(Amplitude: number, Frequency: number, Polarity: number, Direction: number): Promise<[]>
  FunGen1Ch_Start(Periods: number, Wait_until_finished: number): Promise<[]>
  FunGen1Ch_StatusGet(): Promise<[number, number]>
  FunGen1Ch_Stop(): Promise<[]>
  FunGen2Ch_IdleGet(Device: number): Promise<[number]>
  FunGen2Ch_IdleSet(Device: number, Idle_value: number): Promise<[]>
  FunGen2Ch_OnOffGet(Channel_index: number): Promise<[number]>
  FunGen2Ch_OnOffSet(Channel_index: number, Status: number): Promise<[]>
  FunGen2Ch_PropsGet(Channel_index: number): Promise<[number, number, number, number, number]>
  FunGen2Ch_PropsSet(Channel_index: number, Amplitude: number, Time: number, Polarity: number, Direction: number, Add_Zero: number): Promise<[]>
  FunGen2Ch_SignalGet(Channel_index: number): Promise<[number]>
  FunGen2Ch_SignalSet(Channel_index: number, Signal_index: number): Promise<[]>
  FunGen2Ch_Start(Periods: number, Wait_until_finished: number): Promise<[]>
  FunGen2Ch_StatusGet(): Promise<[number, number]>
  FunGen2Ch_Stop(): Promise<[]>
  FunGen2Ch_WaveformGet(Channel_index: number): Promise<[number]>
  FunGen2Ch_WaveformSet(Channel_index: number, Shape: number): Promise<[]>
  GenPICtrl_AOPropsGet(): Promise<[number, string, number, string, number, number, number, number]>
  GenPICtrl_AOPropsSet(Signal_name: string, Units: string, Upper_limit: number, Lower_limit: number, Calibration_per_volt: number, Offset_in_physical_units: number): Promise<[]>
  GenPICtrl_AOValGet(): Promise<[number]>
  GenPICtrl_AOValSet(Output_value: number): Promise<[]>
  GenPICtrl_DemodChGet(): Promise<[number]>
  GenPICtrl_DemodChSet(Input_index: number, AC_mode: number): Promise<[]>
  GenPICtrl_ModChGet(): Promise<[number]>
  GenPICtrl_ModChSet(Output_index: number): Promise<[]>
  GenPICtrl_OnOffGet(): Promise<[number]>
  GenPICtrl_OnOffSet(Controller_status: number): Promise<[]>
  GenPICtrl_PropsGet(): Promise<[number, number, number, number]>
  GenPICtrl_PropsSet(Setpoint: number, P_gain: number, Time_constant: number, Slope: number): Promise<[]>
  GenSwp_AcqChsGet(): Promise<[number, number[], number, number, string[]]>
  GenSwp_AcqChsSet(Channel_indexes: number[], Channel_names: string[]): Promise<[]>
  GenSwp_LimitsGet(): Promise<[number, number]>
  GenSwp_LimitsSet(Lower_limit: number, Upper_limit: number): Promise<[]>
  GenSwp_Open(): Promise<[]>
  GenSwp_PropsGet(): Promise<[number, number, number, number, number, number, number]>
  GenSwp_PropsSet(Initial_Settling_time_ms: number, Maximum_slew_rate_units_s: number, Number_of_steps: number, Period_ms: number, Autosave: number, Save_dialog_box: number, Settling_time_ms: number): Promise<[]>
  GenSwp_Start(Get_data: number, Sweep_direction: number, Save_base_name: string, Reset_signal: number, Z_Controller: number): Promise<[number, number, string[], number, number, number[][]]>
  GenSwp_Stop(): Promise<[]>
  GenSwp_SwpSignalGet(): Promise<[number, string]>
  GenSwp_SwpSignalListGet(): Promise<[number, number, string[]]>
  GenSwp_SwpSignalSet(Sweep_channel_name: string): Promise<[]>
  HSSwp_AcqChsGet(): Promise<[number, number[], number, number, string[], number, number[]]>
  HSSwp_AcqChsSet(Channel_Indexes: number[]): Promise<[]>
  HSSwp_AutoReverseGet(): Promise<[number, number, number, number, number, number, number, number]>
  HSSwp_AutoReverseSet(OnOff: number, Condition: number, Signal: number, Threshold: number, LinkToOne: number, Condition2: number, Signal2: number, Threshold2: number): Promise<[]>
  HSSwp_EndSettlGet(): Promise<[number]>
  HSSwp_EndSettlSet(Threshold: number): Promise<[]>
  HSSwp_NumSweepsGet(): Promise<[number, number]>
  HSSwp_NumSweepsSet(Number_Of_Sweeps: number, Continuous: number): Promise<[]>
  HSSwp_ResetSignalsGet(): Promise<[number]>
  HSSwp_ResetSignalsSet(ResetSignals: number): Promise<[]>
  HSSwp_SaveBasenameGet(): Promise<[number, string, string]>
  HSSwp_SaveBasenameSet(Basename: string, Path: string): Promise<[]>
  HSSwp_SaveDataGet(): Promise<[number]>
  HSSwp_SaveDataSet(SaveData: number): Promise<[]>
  HSSwp_SaveOptionsGet(): Promise<[number, string, number, number, string[]]>
  HSSwp_SaveOptionsSet(Comment: string, ModulesNames: string): Promise<[]>
  HSSwp_Start(Wait_Until_Done: number, Timeout: number): Promise<[]>
  HSSwp_StatusGet(): Promise<[number]>
  HSSwp_Stop(): Promise<[]>
  HSSwp_SwpChBwdDelayGet(): Promise<[number]>
  HSSwp_SwpChBwdDelaySet(Bwd_Delay: number): Promise<[]>
  HSSwp_SwpChBwdSwGet(): Promise<[number]>
  HSSwp_SwpChBwdSwSet(Bwd_Sweep: number): Promise<[]>
  HSSwp_SwpChLimitsGet(): Promise<[number, number, number]>
  HSSwp_SwpChLimitsSet(Relative_Limits: number, Start: number, Stop: number): Promise<[]>
  HSSwp_SwpChNumPtsGet(): Promise<[number]>
  HSSwp_SwpChNumPtsSet(Number_Of_Points: number): Promise<[]>
  HSSwp_SwpChSigListGet(): Promise<[string, number[]]>
  HSSwp_SwpChSignalGet(): Promise<[number, number]>
  HSSwp_SwpChSignalSet(Sweep_Signal_Index: number, Timed_Sweep: number): Promise<[]>
  HSSwp_SwpChTimingGet(): Promise<[number, number, number, number]>
  HSSwp_SwpChTimingSet(Initial_Settling_Time: number, Settling_Time: number, Integration_Time: number, Max_Slew_Time: number): Promise<[]>
  HSSwp_ZCtrlOffGet(): Promise<[number, number, number, number, number]>
  HSSwp_ZCtrlOffSet(Z_Controller_Off: number, Z_Controller_Index: number, Z_Averaging_Time: number, Z_Offset: number, Z_Control_Time: number): Promise<[]>
  Interf_CtrlCalibrOpen(): Promise<[]>
  Interf_CtrlNullDefl(): Promise<[]>
  Interf_CtrlOnOffGet(): Promise<[number]>
  Interf_CtrlOnOffSet(Status: number): Promise<[]>
  Interf_CtrlPropsGet(): Promise<[number, number, number]>
  Interf_CtrlPropsSet(Integral: number, Proportional: number, Sign: number): Promise<[]>
  Interf_CtrlReset(): Promise<[]>
  Interf_ValGet(): Promise<[number]>
  Interf_WPiezoGet(): Promise<[number]>
  Interf_WPiezoSet(W_piezo: number): Promise<[]>
  KelvinCtrl_AmpGet(): Promise<[number]>
  KelvinCtrl_BiasLimitsGet(): Promise<[number, number]>
  KelvinCtrl_BiasLimitsSet(Bias_high_limit_V: number, Bias_low_limit_V: number): Promise<[]>
  KelvinCtrl_CtrlOnOffGet(): Promise<[number]>
  KelvinCtrl_CtrlOnOffSet(Control_On_Off: number): Promise<[]>
  KelvinCtrl_CtrlSignalGet(): Promise<[number]>
  KelvinCtrl_CtrlSignalSet(Demodulated_Control_signal_index: number): Promise<[]>
  KelvinCtrl_GainGet(): Promise<[number, number, number]>
  KelvinCtrl_GainSet(P_gain: number, Time_constant_s: number, Slope: number): Promise<[]>
  KelvinCtrl_ModOnOffGet(): Promise<[number, number]>
  KelvinCtrl_ModOnOffSet(AC_mode_On_Off: number, Modulation_On_Off: number): Promise<[]>
  KelvinCtrl_ModParamsGet(): Promise<[number, number, number]>
  KelvinCtrl_ModParamsSet(Frequency_Hz: number, Amplitude: number, Phase_deg: number): Promise<[]>
  KelvinCtrl_SetpntGet(): Promise<[number]>
  KelvinCtrl_SetpntSet(Setpoint: number): Promise<[]>
  Laser_OnOffGet(): Promise<[number]>
  Laser_OnOffSet(Status: number): Promise<[]>
  Laser_PowerGet(): Promise<[number]>
  Laser_PropsGet(): Promise<[number]>
  Laser_PropsSet(Laser_Setpoint: number): Promise<[]>
  LockInFreqSwp_LimitsGet(): Promise<[number, number]>
  LockInFreqSwp_LimitsSet(Lower_limit_Hz: number, Upper_limit_Hz: number): Promise<[]>
  LockInFreqSwp_Open(): Promise<[]>
  LockInFreqSwp_PropsGet(): Promise<[number, number, number, number, number, number, number, number, string]>
  LockInFreqSwp_PropsSet(Number_of_steps: number, Integration_periods: number, Minimum_integration_time_s: number, Settling_periods: number, Minimum_Settling_time_s: number, Autosave: number, Save_dialog: number, Basename: string): Promise<[]>
  LockInFreqSwp_SignalGet(): Promise<[number]>
  LockInFreqSwp_SignalSet(Sweep_signal_index: number): Promise<[]>
  LockInFreqSwp_Start(Get_Data: number, Direction: number): Promise<[number, number, string[], number, number, number[][]]>
  LockIn_DemodHPFilterGet(Demodulator_number: number): Promise<[number, number]>
  LockIn_DemodHPFilterSet(Demodulator_number: number, HP_Filter_Order: number, HP_Filter_Cutoff_Frequency_Hz: number): Promise<[]>
  LockIn_DemodHarmonicGet(Demodulator_number: number): Promise<[number]>
  LockIn_DemodHarmonicSet(Demodulator_number: number, Harmonic_: number): Promise<[]>
  LockIn_DemodLPFilterGet(Demodulator_number: number): Promise<[number, number]>
  LockIn_DemodLPFilterSet(Demodulator_number: number, LP_Filter_Order: number, LP_Filter_Cutoff_Frequency_Hz: number): Promise<[]>
  LockIn_DemodPhasGet(Demodulator_number: number): Promise<[number]>
  LockIn_DemodPhasRegGet(Demodulator_number: number): Promise<[number]>
  LockIn_DemodPhasRegSet(Demodulator_number: number, Phase_Register_Index: number): Promise<[]>
  LockIn_DemodPhasSet(Demodulator_number: number, Phase_deg_: number): Promise<[]>
  LockIn_DemodRTSignalsGet(Demodulator_number: number): Promise<[number]>
  LockIn_DemodRTSignalsSet(Demodulator_number: number, RT_Signals_: number): Promise<[]>
  LockIn_DemodSignalGet(Demodulator_number: number): Promise<[number]>
  LockIn_DemodSignalSet(Demodulator_number: number, Demodulator_Signal_Index: number): Promise<[]>
  LockIn_DemodSyncFilterGet(Demodulator_number: number): Promise<[number]>
  LockIn_DemodSyncFilterSet(Demodulator_number: number, Sync_Filter_: number): Promise<[]>
  LockIn_ModAmpGet(Modulator_number: number): Promise<[number]>
  LockIn_ModAmpSet(Modulator_number: number, Amplitude_: number): Promise<[]>
  LockIn_ModHarmonicGet(Modulator_number: number): Promise<[number]>
  LockIn_ModHarmonicSet(Modulator_number: number, Harmonic_: number): Promise<[]>
  LockIn_ModOnOffGet(Modulator_number: number): Promise<[number]>
  LockIn_ModOnOffSet(Modulator_number: number, Lock_In_OndivOff: number): Promise<[]>
  LockIn_ModPhasFreqGet(Modulator_number: number): Promise<[number]>
  LockIn_ModPhasFreqSet(Modulator_number: number, Frequency_Hz_: number): Promise<[]>
  LockIn_ModPhasGet(Modulator_number: number): Promise<[number]>
  LockIn_ModPhasRegGet(Modulator_number: number): Promise<[number]>
  LockIn_ModPhasRegSet(Modulator_number: number, Phase_Register_Index: number): Promise<[]>
  LockIn_ModPhasSet(Modulator_number: number, Phase_deg_: number): Promise<[]>
  LockIn_ModSignalGet(Modulator_number: number): Promise<[number]>
  LockIn_ModSignalSet(Modulator_number: number, Modulator_Signal_Index: number): Promise<[]>
  MCVA5_ContStateUpdateGet(Preamp_Nr: number): Promise<[number]>
  MCVA5_ContStateUpdateSet(Preamp_Nr: number, Continuous_Read: number): Promise<[]>
  MCVA5_ContTempUpdateGet(Preamp_Nr: number): Promise<[number]>
  MCVA5_ContTempUpdateSet(Preamp_Nr: number, Continuous_Read: number): Promise<[]>
  MCVA5_CouplingGet(Preamp_Nr: number, Channel_Nr: number): Promise<[number]>
  MCVA5_CouplingSet(Preamp_Nr: number, Channel_Nr: number, Coupling: number): Promise<[]>
  MCVA5_GainGet(Preamp_Nr: number, Channel_Nr: number): Promise<[number]>
  MCVA5_GainSet(Preamp_Nr: number, Channel_Nr: number, Gain: number): Promise<[]>
  MCVA5_InputModeGet(Preamp_Nr: number, Channel_Nr: number): Promise<[number]>
  MCVA5_InputModeSet(Preamp_Nr: number, Channel_Nr: number, Input_Mode: number): Promise<[]>
  MCVA5_SingleStateUpdate(Preamp_Nr: number): Promise<[number, number, number, number, number, number, number, number]>
  MCVA5_SingleTempUpdate(Preamp_Nr: number): Promise<[number, number, number, number]>
  MCVA5_UserInGet(Preamp_Nr: number, Channel_Nr: number): Promise<[number]>
  MCVA5_UserInSet(Preamp_Nr: number, Channel_Nr: number, User_Input: number): Promise<[]>
  MPass_Activate(On_Off: number): Promise<[]>
  MPass_Load(File_Path: string): Promise<[]>
  MPass_Save(File_Path: string): Promise<[]>
  MProbeBias_CalibrGet(Scanner_Index: number): Promise<[number, number]>
  MProbeBias_CalibrSet(Scanner_Index: number, Calibration: number, Offset: number): Promise<[]>
  MProbeBias_Get(Scanner_Index: number): Promise<[number]>
  MProbeBias_Pulse(Scanner_Index: number, Wait_Until_Done: number, Width: number, Value: number, ZCtrl_Hold: number, Abs_Rel: number): Promise<[]>
  MProbeBias_RangeGet(Scanner_Index: number): Promise<[number]>
  MProbeBias_RangeSet(Scanner_Index: number, Bias_Range_Index: number): Promise<[]>
  MProbeBias_Set(Scanner_Index: number, Bias_Value: number): Promise<[]>
  MProbeCurrent_CalibrGet(Scanner_Index: number, Gain_Index: number): Promise<[number, number]>
  MProbeCurrent_CalibrSet(Scanner_Index: number, Gain_Index: number, Calibration: number, Offset: number): Promise<[]>
  MProbeCurrent_GainSet(Scanner_Index: number, Gain_Index: number, Filter_Index: number): Promise<[]>
  MProbeCurrent_GainsGet(Scanner_Index: number): Promise<[number, number, string[], number, number, number, string[], number]>
  MProbeCurrent_Get(Scanner_Index: number): Promise<[number]>
  MProbeScanner_ActiveScannerGet(): Promise<[number]>
  MProbeScanner_CalibrGet(Scanner_Index: number): Promise<[number, number, number, number, number, number]>
  MProbeScanner_CalibrSet(Scanner_Index: number, Factor_X: number, Factor_Y: number, Factor_Z: number): Promise<[]>
  MProbeScanner_ScannerSwitch(Scanner_Index: number): Promise<[]>
  MProbeScanner_SpeedGet(Scanner_Index: number): Promise<[number]>
  MProbeScanner_SpeedSet(Scanner_Index: number, Speed: number): Promise<[]>
  MProbeScanner_Stop(Scanner_Index: number): Promise<[]>
  MProbeScanner_XYPosGet(Scanner_Index: number): Promise<[number, number]>
  MProbeScanner_XYPosSet(Scanner_Index: number, X_m: number, Y_m: number): Promise<[]>
  MProbeZCtrl_GainGet(Scanner_Index: number): Promise<[number, number]>
  MProbeZCtrl_GainSet(Scanner_Index: number, P_Gain: number, I_Gain: number): Promise<[]>
  MProbeZCtrl_Home(Scanner_Index: number): Promise<[]>
  MProbeZCtrl_HomePropsGet(Scanner_Index: number): Promise<[number, number]>
  MProbeZCtrl_HomePropsSet(Scanner_Index: number, Abs_Rel: number, Home_m: number): Promise<[]>
  MProbeZCtrl_LimitsGet(Scanner_Index: number): Promise<[number, number]>
  MProbeZCtrl_LimitsSet(Scanner_Index: number, High_Limit: number, Low_Limit: number): Promise<[]>
  MProbeZCtrl_OnOffGet(Scanner_Index: number): Promise<[number]>
  MProbeZCtrl_OnOffSet(Scanner_Index: number, ZCtrl_Status: number): Promise<[]>
  MProbeZCtrl_SetpntGet(Scanner_Index: number): Promise<[number]>
  MProbeZCtrl_SetpntSet(Scanner_Index: number, ZCtrl_Setpoint: number): Promise<[]>
  MProbeZCtrl_Withdraw(Scanner_Index: number): Promise<[]>
  MProbeZCtrl_ZPosGet(Scanner_Index: number): Promise<[number]>
  MProbeZCtrl_ZPosSet(Scanner_Index: number, Z_m: number): Promise<[]>
  Marks_LineDraw(Start_point_X_coordinate_m: number, Start_point_Y_coordinate_m: number, End_point_X_coordinate_m: number, End_point_Y_coordinate_m: number, Color: number): Promise<[]>
  Marks_LinesDraw(Number_of_lines: number, Start_point_X_coordinate_m: number[], Start_point_Y_coordinate_m: number[], End_point_X_coordinate_m: number[], End_point_Y_coordinate_m: number[], Color: number[]): Promise<[]>
  Marks_LinesErase(Line_index: number): Promise<[]>
  Marks_LinesGet(): Promise<[number, number[], number[], number[], number[], number[], number[]]>
  Marks_LinesVisibleSet(Line_index: number, Show_hide: number): Promise<[]>
  Marks_PointDraw(X_coordinate_m: number, Y_coordinate_m: number, Text: string, Color: number): Promise<[]>
  Marks_PointsDraw(nr_points: number, X_coordinate_m: number[], Y_coordinate_m: number[], Text: string, Color: number[]): Promise<[]>
  Marks_PointsErase(Point_index: number): Promise<[]>
  Marks_PointsGet(): Promise<[number, number[], number[], number, string[], number[], number[]]>
  Marks_PointsVisibleSet(Point_index: number, Show_hide: number): Promise<[]>
  Motor_FreqAmpGet(Axis: number): Promise<[number, number]>
  Motor_FreqAmpSet(Frequency_Hz: number, Amplitude_V: number, Axis: number): Promise<[]>
  Motor_PosGet(Group: number, Timeout: number): Promise<[number, number, number]>
  Motor_StartClosedLoop(Absolute_relative: number, Target_Xm: number, Target_Ym: number, Target_Zm: number, Wait_until_finished: number, Group: number): Promise<[]>
  Motor_StartMove(Direction: number, Number_of_steps: number, Group: number, Wait_until_finished: number): Promise<[]>
  Motor_StepCounterGet(Reset_X: number, Reset_Y: number, Reset_Z: number): Promise<[number, number, number]>
  Motor_StopMove(): Promise<[]>
  OCSync_AnglesGet(): Promise<[number, number, number, number]>
  OCSync_AnglesSet(Channel_1_on_angle_deg: number, Channel_1_off_angle_deg: number, Channel_2_on_angle_deg: number, Channel_3_off_angle_deg: number): Promise<[]>
  OCSync_LinkAnglesGet(): Promise<[number, number]>
  OCSync_LinkAnglesSet(Link_angles_Channel_1: number, Link_angles_Channel_2: number): Promise<[]>
  Osci1T_ChGet(): Promise<[number]>
  Osci1T_ChSet(ChannelIndex: number): Promise<[]>
  Osci1T_DataGet(DataToGet: number): Promise<[number, number, number, number[]]>
  Osci1T_Run(): Promise<[]>
  Osci1T_TimebaseGet(): Promise<[number, number, number[]]>
  Osci1T_TimebaseSet(TimebaseIndex: number): Promise<[]>
  Osci1T_TrigGet(TriggerMode: number, TriggerChannel: number, TriggerSlope: number, TriggerLevel: number): Promise<[]>
  Osci1T_TrigSet(TriggerMode: number, TriggerSlope: number, TriggerLevel: number, TriggerHysteresis: number): Promise<[]>
  Osci2T_ChGet(): Promise<[number, number]>
  Osci2T_ChSet(ChannelAIndex: number, ChannelBIndex: number): Promise<[]>
  Osci2T_ChsGet(): Promise<[number, number]>
  Osci2T_ChsSet(ChannelAIndex: number, ChannelBIndex: number): Promise<[]>
  Osci2T_DataGet(DataToGet: number): Promise<[number, number, number, number[], number, number[]]>
  Osci2T_OversamplGet(): Promise<[number]>
  Osci2T_OversamplSet(OversamplIndex: number): Promise<[]>
  Osci2T_Run(): Promise<[]>
  Osci2T_TimebaseGet(): Promise<[number, number, number[]]>
  Osci2T_TimebaseSet(TimebaseIndex: number): Promise<[]>
  Osci2T_TrigGet(TriggerMode: number, TriggerChannel: number, TriggerSlope: number, TriggerLevel: number, TriggerHysterstis: number, TriggerPos: number): Promise<[]>
  Osci2T_TrigSet(TriggerMode: number, TrigChannel: number, TriggerSlope: number, TriggerLevel: number, TriggerHysteresis: number, TrigPosition: number): Promise<[]>
  OsciHR_CalibrModeGet(Osci_index: number): Promise<[number]>
  OsciHR_CalibrModeSet(Osci_index: number, Calibration_mode: number): Promise<[]>
  OsciHR_ChGet(Osci_index: number): Promise<[number]>
  OsciHR_ChSet(Osci_index: number, Signal_index: number): Promise<[]>
  OsciHR_OsciDataGet(Osci_index: number, Data_to_get: number, Timeout_s: number): Promise<[number, string, number, number, number[], number]>
  OsciHR_OversamplGet(): Promise<[number]>
  OsciHR_OversamplSet(Oversampling_index: number): Promise<[]>
  OsciHR_PSDAvrgCountGet(): Promise<[number]>
  OsciHR_PSDAvrgCountSet(PSD_averaging_count: number): Promise<[]>
  OsciHR_PSDAvrgRestart(): Promise<[]>
  OsciHR_PSDAvrgTypeGet(): Promise<[number]>
  OsciHR_PSDAvrgTypeSet(PSD_averaging_type: number): Promise<[]>
  OsciHR_PSDDataGet(Data_to_get: number, Timeout_s: number): Promise<[number, number, number, number[], number]>
  OsciHR_PSDShow(Show_PSD_section: number): Promise<[]>
  OsciHR_PSDWeightGet(): Promise<[number]>
  OsciHR_PSDWeightSet(PSD_Weighting: number): Promise<[]>
  OsciHR_PSDWindowGet(): Promise<[number]>
  OsciHR_PSDWindowSet(PSD_window_type: number): Promise<[]>
  OsciHR_PreTrigGet(): Promise<[number]>
  OsciHR_PreTrigSet(Pre_Trigger_samples: number, Pre_Trigger_s: number): Promise<[]>
  OsciHR_Run(): Promise<[]>
  OsciHR_SamplesGet(): Promise<[number]>
  OsciHR_SamplesSet(Number_of_samples: number): Promise<[]>
  OsciHR_TrigArmModeGet(): Promise<[number]>
  OsciHR_TrigArmModeSet(Trigger_arming_mode: number): Promise<[]>
  OsciHR_TrigDigChGet(): Promise<[number]>
  OsciHR_TrigDigChSet(Digital_trigger_channel_index: number): Promise<[]>
  OsciHR_TrigDigSlopeGet(): Promise<[number]>
  OsciHR_TrigDigSlopeSet(Digital_trigger_slope: number): Promise<[]>
  OsciHR_TrigLevChGet(): Promise<[number]>
  OsciHR_TrigLevChSet(Level_trigger_channel_index: number): Promise<[]>
  OsciHR_TrigLevHystGet(): Promise<[number]>
  OsciHR_TrigLevHystSet(Level_trigger_Hysteresis: number): Promise<[]>
  OsciHR_TrigLevSlopeGet(): Promise<[number]>
  OsciHR_TrigLevSlopeSet(Level_trigger_slope: number): Promise<[]>
  OsciHR_TrigLevValGet(): Promise<[number]>
  OsciHR_TrigLevValSet(Level_trigger_value: number): Promise<[]>
  OsciHR_TrigModeGet(): Promise<[number]>
  OsciHR_TrigModeSet(Trigger_mode: number): Promise<[]>
  OsciHR_TrigRearm(): Promise<[]>
  PICtrl_CtrlChGet(Controller_Index: number): Promise<[number, number, number, string[], number, number[]]>
  PICtrl_CtrlChPropsGet(Controller_Index: number): Promise<[number, number]>
  PICtrl_CtrlChPropsSet(Controller_Index: number, Lower_Limit: number, Upper_Limit: number): Promise<[]>
  PICtrl_CtrlChSet(Controller_Index: number, CtrlSignal_Index: number): Promise<[]>
  PICtrl_InputChGet(Controller_Index: number): Promise<[number, number, number, string[], number, number[]]>
  PICtrl_InputChSet(Controller_Index: number, Input_Index: number): Promise<[]>
  PICtrl_OnOffGet(Controller_Index: number): Promise<[number]>
  PICtrl_OnOffSet(Controller_Index: number, Controller_Status: number): Promise<[]>
  PICtrl_PropsGet(Controller_Index: number): Promise<[number, number, number, number]>
  PICtrl_PropsSet(Controller_Index: number, Setpoint: number, P_Gain: number, I_Gain: number, Slope: number): Promise<[]>
  PLLFreqSwp_Open(Modulator_index: number): Promise<[]>
  PLLFreqSwp_ParamsGet(Modulator_index: number): Promise<[number, number, number]>
  PLLFreqSwp_ParamsSet(Modulator_index: number, Number_of_points: number, Period_s: number, Settling_time_s: number): Promise<[]>
  PLLFreqSwp_Start(Modulator_index: number, Get_data: number, Sweep_direction: number): Promise<[number, number, string[], number, number, number[][], number, number, number, number, number, number]>
  PLLFreqSwp_Stop(Modulator_index: number): Promise<[]>
  PLLPhasSwp_Start(Modulator_index: number, Get_data: number): Promise<[number, number, string[], number, number, number[][]]>
  PLLPhasSwp_Stop(Modulator_index: number): Promise<[]>
  PLLSignalAnlzr_ChGet(): Promise<[number]>
  PLLSignalAnlzr_ChSet(Channel_index: number): Promise<[]>
  PLLSignalAnlzr_FFTAvgRestart(): Promise<[]>
  PLLSignalAnlzr_FFTDataGet(): Promise<[number, number, number, number[]]>
  PLLSignalAnlzr_FFTPropsGet(): Promise<[number, number, number, number]>
  PLLSignalAnlzr_FFTPropsSet(FFT_window: number, Averaging_mode: number, Weighting_mode: number, Count: number): Promise<[]>
  PLLSignalAnlzr_Open(): Promise<[]>
  PLLSignalAnlzr_OsciDataGet(): Promise<[number, number, number, number[]]>
  PLLSignalAnlzr_TimebaseGet(): Promise<[number, number, number, number, string[]]>
  PLLSignalAnlzr_TimebaseSet(Timebase: number, Update_rate: number): Promise<[]>
  PLLSignalAnlzr_TrigAuto(): Promise<[]>
  PLLSignalAnlzr_TrigGet(): Promise<[number, number, number, number, number, number, number, number, string[]]>
  PLLSignalAnlzr_TrigRearm(): Promise<[]>
  PLLSignalAnlzr_TrigSet(Trigger_mode: number, Trigger_source: number, Trigger_slope: number, Trigger_level: number, Trigger_position_s: number, Arming_mode: number): Promise<[]>
  PLLZoomFFT_AvgRestart(): Promise<[]>
  PLLZoomFFT_ChGet(): Promise<[number]>
  PLLZoomFFT_ChSet(Channel_index: number): Promise<[]>
  PLLZoomFFT_DataGet(): Promise<[number, number, number, number[]]>
  PLLZoomFFT_Open(): Promise<[]>
  PLLZoomFFT_PropsGet(): Promise<[number, number, number, number]>
  PLLZoomFFT_PropsSet(FFT_window: number, Averaging_mode: number, Weighting_mode: number, Count: number): Promise<[]>
  PLL_AddOnOffGet(Modulator_index: number): Promise<[number]>
  PLL_AddOnOffSet(Modulator_index: number, Add: number): Promise<[]>
  PLL_AmpCtrlBandwidthGet(Modulator_index: number): Promise<[number]>
  PLL_AmpCtrlBandwidthSet(Modulator_index: number, Bandwidth_Hz: number): Promise<[]>
  PLL_AmpCtrlGainGet(Modulator_index: number): Promise<[number, number, number]>
  PLL_AmpCtrlGainSet(Modulator_index: number, P_gain_Vdivm: number, Time_constant_s: number): Promise<[]>
  PLL_AmpCtrlOnOffGet(Modulator_index: number): Promise<[number]>
  PLL_AmpCtrlOnOffSet(Modulator_index: number, Status: number): Promise<[]>
  PLL_AmpCtrlSetpntGet(Modulator_index: number): Promise<[number]>
  PLL_AmpCtrlSetpntSet(Modulator_index: number, Setpoint_m: number): Promise<[]>
  PLL_CenterFreqGet(Modulator_index: number): Promise<[number]>
  PLL_CenterFreqSet(Modulator_index: number, Center_frequency_Hz: number): Promise<[]>
  PLL_DemodFilterGet(Demodulator_index: number): Promise<[number]>
  PLL_DemodFilterSet(Demodulator_index: number, Filter_order_: number): Promise<[]>
  PLL_DemodHarmonicGet(Demodulator_index: number): Promise<[number]>
  PLL_DemodHarmonicSet(Demodulator_index: number, Harmonic_: number): Promise<[]>
  PLL_DemodInputGet(Demodulator_index: number): Promise<[number, number]>
  PLL_DemodInputSet(Demodulator_index: number, Input_: number, Frequency_generator: number): Promise<[]>
  PLL_DemodPhasRefGet(Demodulator_index: number): Promise<[number]>
  PLL_DemodPhasRefSet(Demodulator_index: number, Phase_reference_deg_: number): Promise<[]>
  PLL_ExcRangeGet(Modulator_index: number): Promise<[number]>
  PLL_ExcRangeSet(Modulator_index: number, Output_range: number): Promise<[]>
  PLL_ExcitationGet(Modulator_index: number): Promise<[number]>
  PLL_ExcitationSet(Modulator_index: number, Excitation_value_V: number): Promise<[]>
  PLL_FreqExcOverwriteGet(Modulator_index: number): Promise<[number, number]>
  PLL_FreqExcOverwriteSet(Modulator_index: number, Excitation_overwrite_signal_index: number, Frequency_overwrite_signal_index: number): Promise<[]>
  PLL_FreqRangeGet(Modulator_index: number): Promise<[number]>
  PLL_FreqRangeSet(Modulator_index: number, Frequency_range_Hz: number): Promise<[]>
  PLL_FreqShiftAutoCenter(Modulator_index: number): Promise<[]>
  PLL_FreqShiftGet(Modulator_index: number): Promise<[number]>
  PLL_FreqShiftSet(Modulator_index: number, Frequency_shift_Hz: number): Promise<[]>
  PLL_InpCalibrGet(Modulator_index: number): Promise<[number]>
  PLL_InpCalibrSet(Modulator_index: number, Calibration_mdivV: number): Promise<[]>
  PLL_InpPropsGet(Modulator_index: number): Promise<[number, number]>
  PLL_InpPropsSet(Modulator_index: number, Differential_input: number, OneDiv10_divider: number): Promise<[]>
  PLL_InpRangeGet(Modulator_index: number): Promise<[number]>
  PLL_InpRangeSet(Modulator_index: number, Input_range_m: number): Promise<[]>
  PLL_OutOnOffGet(Modulator_index: number): Promise<[number]>
  PLL_OutOnOffSet(Modulator_index: number, PLL_output: number): Promise<[]>
  PLL_PerfectPLLUpdtZTC(Modulator_index: number): Promise<[]>
  PLL_PhasCtrlBandwidthGet(Modulator_index: number): Promise<[number]>
  PLL_PhasCtrlBandwidthSet(Modulator_index: number, Bandwidth_Hz: number): Promise<[]>
  PLL_PhasCtrlGainGet(Modulator_index: number): Promise<[number, number]>
  PLL_PhasCtrlGainSet(Modulator_index: number, P_gain_Hzdivdeg: number, Time_constant_s: number): Promise<[]>
  PLL_PhasCtrlOnOffGet(Modulator_index: number): Promise<[number]>
  PLL_PhasCtrlOnOffSet(Modulator_index: number, Status: number): Promise<[]>
  Pattern_CloudGet(): Promise<[number, number[], number[]]>
  Pattern_CloudSet(Set_active_pattern: number, Number_of_points: number, X_coordinates_m: number[], Y_coordinates_m: number[]): Promise<[]>
  Pattern_ExpOpen(): Promise<[]>
  Pattern_ExpPause(Pause_Resume: number): Promise<[]>
  Pattern_ExpStart(Pattern: number): Promise<[]>
  Pattern_ExpStatusGet(): Promise<[number]>
  Pattern_ExpStop(): Promise<[]>
  Pattern_GridGet(): Promise<[number, number, number, number, number, number, number]>
  Pattern_GridSet(Set_active_pattern: number, Number_of_points_in_X: number, Number_of_points_in_Y: number, Grid_Scan_frame: number, Center_X_m: number, Center_Y_m: number, Width_m: number, Height_m: number, Angle_deg: number): Promise<[]>
  Pattern_LineGet(): Promise<[number, number, number, number, number]>
  Pattern_LineSet(Set_active_pattern: number, Number_of_points: number, Line_Scan_frame: number, Line_Point_1_X_m: number, Line_Point_1_Y_m: number, Line_Point_2_X_m: number, Line_Point_2_Y_m: number): Promise<[]>
  Pattern_PropsGet(): Promise<[number, number, string[], number, string, number, string, number, number]>
  Pattern_PropsSet(Selected_experiment: string, Basename: string, External_VI_path: string, Pre_measure_delay_s: number, Save_scan_channels: number): Promise<[]>
  Piezo_CalibrGet(): Promise<[number, number, number]>
  Piezo_DriftCompGet(): Promise<[number, number, number, number, number, number, number, number]>
  Piezo_DriftCompSet(Compensation_on_off: number, Vx_m_s: number, Vy_m_s: number, Vz_m_s: number, Sat_Lim: number): Promise<[]>
  Piezo_HVAInfoGet(): Promise<[number, number, number, number, number, number, number]>
  Piezo_HVAStatusLEDGet(): Promise<[number, number, number, number]>
  Piezo_HystFileLoad(File_path: string): Promise<[]>
  Piezo_HystFileSave(File_path: string): Promise<[]>
  Piezo_HystOnOffGet(): Promise<[number]>
  Piezo_HystOnOffSet(On_Off: number): Promise<[]>
  Piezo_HystValsGet(): Promise<[number, number[], number, number[], number, number[], number, number[]]>
  Piezo_HystValsSet(Fast_axis__number_points_X: number, Fast_axis_points_X: number[], Fast_axis_number_points_Y: number, Fast_axis_points_Y: number[], Slow_axis_number_points_X: number, Slow_axis_points_X: number[], Slow_axis_number_points_Y: number, Slow_axis_points_Y: number[]): Promise<[]>
  Piezo_RangeGet(): Promise<[number, number, number]>
  Piezo_RangeSet(Range_X_m: number, Range_Y_m: number, Range_Z_m: number): Promise<[]>
  Piezo_SensGet(): Promise<[number, number, number]>
  Piezo_SensSet(Calibration_X_mPerV: number, Calibration_Y_mPerV: number, Calibration_Z_mPerV: number): Promise<[]>
  Piezo_TiltGet(): Promise<[number, number]>
  Piezo_TiltSet(Tilt_X_deg: number, Tilt_Y_deg: number): Promise<[]>
  Piezo_XYZLimitsGet(): Promise<[number, number, number, number, number, number, number]>
  Piezo_XYZLimitsSet(Enable_limits: number, Limit_X_low_V: number, Limit_X_high_V: number, Limit_Y_low_V: number, Limit_Y_high_V: number, Limit_Z_low_V: number, Limit_Z_high_V: number): Promise<[]>
  SafeTip_OnOffGet(): Promise<[number]>
  SafeTip_OnOffSet(Safe_Tip_status: number): Promise<[]>
  SafeTip_PropsGet(): Promise<[number, number, number]>
  SafeTip_PropsSet(Auto_recovery: number, Auto_pause_scan: number, Threshold: number): Promise<[]>
  SafeTip_SignalGet(): Promise<[number]>
  Scan_Action(Scan_action: number, Scan_direction: number): Promise<[]>
  Scan_BackgroundDelete(Wait_until_deleted: number, Timeout_ms: number, Which_background: number): Promise<[number]>
  Scan_BackgroundPaste(Wait_until_pasted: number, Timeout_ms: number): Promise<[number]>
  Scan_BufferGet(): Promise<[number, number[], number, number]>
  Scan_BufferSet(Channel_indexes: number[], Pixels: number, Lines: number): Promise<[]>
  Scan_FrameDataGrab(Channel_index: number, Data_direction: number): Promise<[number, string, number, number, number[][], number]>
  Scan_FrameGet(): Promise<[number, number, number, number, number]>
  Scan_FrameSet(Center_X_m: number, Center_Y_m: number, Width_m: number, Height_m: number, Angle_deg: number): Promise<[]>
  Scan_PropsGet(): Promise<[number, number, number, number, string, number, string, number, number, string[], number, number[], number, number, string[][], number]>
  Scan_PropsSet(Continuous_scan: number, Bouncy_scan: number, Autosave: number, Series_name: string, Comment: string, Modules_names: string[], Autopaste: number): Promise<[]>
  Scan_Save(Wait_until_saved: number, Timeout_ms: number): Promise<[number]>
  Scan_SpeedGet(): Promise<[number, number, number, number, number, number]>
  Scan_SpeedSet(Forward_linear_speed_m_s: number, Backward_linear_speed_m_s: number, Forward_time_per_line_s: number, Backward_time_per_line_s: number, Keep_parameter_constant: number, Speed_ratio: number): Promise<[]>
  Scan_StatusGet(): Promise<[number]>
  Scan_WaitEndOfScan(Timeout_ms: number): Promise<[number, number, string]>
  Scan_XYPosGet(Wait_newest_data: number): Promise<[number, number]>
  Script_Autosave(Acquire_buffer: number, Sweep_number: number, All_sweeps_to_same_file: number, Folder_path: string, Basename: string): Promise<[]>
  Script_ChsGet(Acquire_buffer: number): Promise<[number, number[]]>
  Script_ChsSet(Acquire_buffer: number, Channel_indexes: number[]): Promise<[]>
  Script_DataGet(Acquire_buffer: number, Sweep_number: number): Promise<[number, number, number[][]]>
  Script_Deploy(Script_index: number): Promise<[]>
  Script_LUTDeploy(Script_index: number, Wait_until_finished: number, Timeout_ms: number): Promise<[]>
  Script_LUTLoad(Script_index: number, Script_file_path: string, LUT_Values: number[]): Promise<[]>
  Script_LUTOpen(): Promise<[]>
  Script_LUTSave(Script_index: number, Script_file_path: string): Promise<[]>
  Script_Load(Script_index: number, Script_file_path: string, Load_session: number): Promise<[]>
  Script_Open(): Promise<[]>
  Script_Run(Script_index: number, Wait_until_script_finishes: number): Promise<[]>
  Script_Save(Script_index: number, Script_file_path: string, Save_session: number): Promise<[]>
  Script_Stop(): Promise<[]>
  Script_Undeploy(Script_index: number): Promise<[]>
  SignalChart_ChsGet(): Promise<[number, number]>
  SignalChart_ChsSet(Channel__A__index: number, Channel__B__index: number): Promise<[]>
  SignalChart_Open(): Promise<[]>
  Signals_AddRTGet(): Promise<[number, number, string[], number, string, number, string]>
  Signals_AddRTSet(Additional_RT_signal_1: number, Additional_RT_signal_2: number): Promise<[]>
  Signals_CalibrGet(Signal_index: number): Promise<[number, number]>
  Signals_MeasNamesGet(): Promise<[number, number, string[]]>
  Signals_NamesGet(): Promise<[number, number, string[]]>
  Signals_RangeGet(Signal_index: number): Promise<[number, number]>
  Signals_ValGet(Signal_index: number, Wait_for_newest_data: number): Promise<[number]>
  Signals_ValsGet(Signals_indexes: number[], Wait_for_newest_data: number): Promise<[number, number[]]>
  SpectrumAnlzr_ACCouplingGet(Spectrum_Analyzer_instance: number): Promise<[number]>
  SpectrumAnlzr_ACCouplingSet(Spectrum_Analyzer_instance: number, AC_coupling: number): Promise<[]>
  SpectrumAnlzr_AveragGet(Spectrum_Analyzer_instance: number): Promise<[number, number, number]>
  SpectrumAnlzr_AveragSet(Spectrum_Analyzer_instance: number, Averaging_mode: number, Weighting_mode: number, Count: number): Promise<[]>
  SpectrumAnlzr_BandRMSGet(Spectrum_Analyzer_instance: number): Promise<[number, number, number]>
  SpectrumAnlzr_ChGet(Spectrum_Analyzer_instance: number): Promise<[number]>
  SpectrumAnlzr_ChSet(Spectrum_Analyzer_instance: number, Channel__index: number): Promise<[]>
  SpectrumAnlzr_CursorPosGet(Spectrum_Analyzer_instance: number, Cursor_type: number): Promise<[number, number, number]>
  SpectrumAnlzr_CursorPosSet(Spectrum_Analyzer_instance: number, Cursor_type: number, Position_X_Cursor_1_Hz: number, Position_X_Cursor_2_Hz: number): Promise<[]>
  SpectrumAnlzr_DCGet(Spectrum_Analyzer_instance: number): Promise<[number]>
  SpectrumAnlzr_DataGet(Spectrum_Analyzer_instance: number): Promise<[number, number, number, number[]]>
  SpectrumAnlzr_FFTWindowGet(Spectrum_Analyzer_instance: number): Promise<[number]>
  SpectrumAnlzr_FFTWindowSet(Spectrum_Analyzer_instance: number, FFT_window__index: number): Promise<[]>
  SpectrumAnlzr_FreqRangeGet(Spectrum_Analyzer_instance: number): Promise<[number, number, number[]]>
  SpectrumAnlzr_FreqRangeSet(Spectrum_Analyzer_instance: number, Range__index: number): Promise<[]>
  SpectrumAnlzr_FreqResGet(Spectrum_Analyzer_instance: number): Promise<[number, number, number[]]>
  SpectrumAnlzr_FreqResSet(Spectrum_Analyzer_instance: number, Resolution__index: number): Promise<[]>
  SpectrumAnlzr_Run(Spectrum_Analyzer_instance: number): Promise<[]>
  TCPLog_ChsSet(Num_channels: number, Channel_indexes: number[]): Promise<[]>
  TCPLog_OversamplSet(Oversampling_value: number): Promise<[]>
  TCPLog_Start(): Promise<[]>
  TCPLog_StatusGet(): Promise<[number]>
  TCPLog_Stop(): Promise<[]>
  TipRec_BufferClear(): Promise<[]>
  TipRec_BufferSizeGet(): Promise<[number]>
  TipRec_BufferSizeSet(Buffer_size: number): Promise<[]>
  TipRec_DataGet(): Promise<[number, number[], number, number, number[][]]>
  TipRec_DataSave(Clear_buffer: number, Basename: string): Promise<[]>
  TipShaper_PropsGet(): Promise<[number, number, number, number, number, number, number, number, number, number, number]>
  TipShaper_PropsSet(Switch_Off_Delay: number, Change_Bias: number, Bias_V: number, Tip_Lift_m: number, Lift_Time_1_s: number, Bias_Lift_V: number, Bias_Settling_Time_s: number, Lift_Height_m: number, Lift_Time_2_s: number, End_Wait_Time_s: number, Restore_Feedback: number): Promise<[]>
  TipShaper_Start(Wait_until_finished: number, Timeout_ms: number): Promise<[]>
  UserIn_CalibrSet(Input_index: number, Calibration_per_volt: number, Offset_in_physical_units: number): Promise<[]>
  UserOut_CalcSignalConfigGet(Output_index: number): Promise<[number, number, number]>
  UserOut_CalcSignalConfigSet(Output_index: number, Signal_1: number, Operation: number, Signal_2: number): Promise<[]>
  UserOut_CalcSignalNameGet(Output_index: number): Promise<[number, string]>
  UserOut_CalcSignalNameSet(Output_index: number, Calculated_signal_name: string): Promise<[]>
  UserOut_CalibrSet(Output_index: number, Calibration_per_volt: number, Offset_in_physical_units: number): Promise<[]>
  UserOut_LimitsGet(Output_index: number, Raw_limits: number): Promise<[number, number]>
  UserOut_LimitsSet(Output_index: number, Upper_limit: number, Lower_limit: number, Raw_limits: number): Promise<[]>
  UserOut_ModeGet(Output_index: number): Promise<[number]>
  UserOut_ModeSet(Output_index: number, Output_mode: number): Promise<[]>
  UserOut_MonitorChGet(Output_index: number): Promise<[number]>
  UserOut_MonitorChSet(Output_index: number, Monitor_channel_index: number): Promise<[]>
  UserOut_ValSet(Output_index: number, Output_value: number): Promise<[]>
  Util_AcqPeriodGet(): Promise<[number]>
  Util_AcqPeriodSet(Acquisition_Period_s: number): Promise<[]>
  Util_LayoutLoad(Layout_file_path: string, Load_session_layout: number): Promise<[]>
  Util_LayoutSave(Layout_file_path: string, Save_session_layout: number): Promise<[]>
  Util_Lock(): Promise<[]>
  Util_Quit(Use_Stored_Values: number, Settings_Name: string, Layout_Name: string, Save_Signals: number): Promise<[]>
  Util_RTFreqGet(): Promise<[number]>
  Util_RTFreqSet(RT_frequency: number): Promise<[]>
  Util_RTOversamplGet(): Promise<[number]>
  Util_RTOversamplSet(RT_oversampling: number): Promise<[]>
  Util_SessionPathGet(): Promise<[number, string]>
  Util_SessionPathSet(Session_path: string, Save_settings_to_previous: number): Promise<[]>
  Util_SettingsLoad(Settings_file_path: string, Load_session_settings: number): Promise<[]>
  Util_SettingsSave(Settings_file_path: string, Save_session_settings: number): Promise<[]>
  Util_UnLock(): Promise<[]>
  Util_VersionGet(): Promise<[string, string, number, number]>
  ZCtrl_ActiveCtrlSet(Z_Controller_index: number): Promise<[]>
  ZCtrl_CtrlListGet(): Promise<[number, number, string[], number]>
  ZCtrl_GainGet(): Promise<[number, number, number]>
  ZCtrl_GainSet(P_gain: number, Time_constant_s: number, I_gain: number): Promise<[]>
  ZCtrl_Home(): Promise<[]>
  ZCtrl_HomePropsGet(): Promise<[number, number]>
  ZCtrl_HomePropsSet(Relative_or_Absolute: number, Home_position_m: number): Promise<[]>
  ZCtrl_LimitsEnabledGet(): Promise<[number]>
  ZCtrl_LimitsEnabledSet(Limit_Z_status: number): Promise<[]>
  ZCtrl_LimitsGet(): Promise<[number, number]>
  ZCtrl_LimitsSet(Z_high_limit_m: number, Z_low_limit_m: number): Promise<[]>
  ZCtrl_OnOffGet(): Promise<[number]>
  ZCtrl_OnOffSet(Z_Controller_status: number): Promise<[]>
  ZCtrl_SetpntGet(): Promise<[number]>
  ZCtrl_SetpntSet(Z_Controller_setpoint: number): Promise<[]>
  ZCtrl_StatusGet(): Promise<[number]>
  ZCtrl_SwitchOffDelayGet(): Promise<[number]>
  ZCtrl_SwitchOffDelaySet(Z_Controller_switch_off_delay_s: number): Promise<[]>
  ZCtrl_TipLiftGet(): Promise<[number]>
  ZCtrl_TipLiftSet(TipLift_m: number): Promise<[]>
  ZCtrl_Withdraw(Wait_until_finished: number, Timeout_ms: number): Promise<[]>
  ZCtrl_WithdrawRateGet(): Promise<[number]>
  ZCtrl_WithdrawRateSet(Withdraw_slew_rate_mdivs: number): Promise<[]>
  ZCtrl_ZPosGet(): Promise<[number]>
  ZCtrl_ZPosSet(Z_position_m: number): Promise<[]>
  ZSpectr_AdvPropsGet(): Promise<[number, number, number, number]>
  ZSpectr_AdvPropsSet(Time_between_forward_and_backward_sweep_s: number, Record_final_Z: number, Lockin_Run: number, Reset_Z: number): Promise<[]>
  ZSpectr_ChsGet(): Promise<[number, number[], number, number, string[]]>
  ZSpectr_ChsSet(Channel_indexes: number[]): Promise<[]>
  ZSpectr_DigSyncGet(): Promise<[number]>
  ZSpectr_DigSyncSet(Digital_Sync: number): Promise<[]>
  ZSpectr_Open(): Promise<[]>
  ZSpectr_PropsGet(): Promise<[number, number, number, number, string[], number, number, string[], number, number]>
  ZSpectr_PropsSet(Backward_sweep: number, Number_of_points: number, Number_of_sweeps: number, Autosave: number, Show_save_dialog: number, Save_all: number): Promise<[]>
  ZSpectr_PulseSeqSyncGet(): Promise<[number, number]>
  ZSpectr_PulseSeqSyncSet(Pulse_Sequence_Nr: number, Nr_Periods: number): Promise<[]>
  ZSpectr_RangeGet(): Promise<[number, number]>
  ZSpectr_RangeSet(Z_offset_m: number, Z_sweep_distance_m: number): Promise<[]>
  ZSpectr_RetractDelayGet(): Promise<[number]>
  ZSpectr_RetractDelaySet(Retract_delay_s: number): Promise<[]>
  ZSpectr_RetractGet(): Promise<[number, number, number, number]>
  ZSpectr_RetractSecondGet(): Promise<[number, number, number, number]>
  ZSpectr_RetractSecondSet(Second_condition: number, Threshold: number, Signal_index: number, Comparison: number): Promise<[]>
  ZSpectr_RetractSet(Enable: number, Threshold: number, Signal_index: number, Comparison: number): Promise<[]>
  ZSpectr_Start(Get_data: number, Save_base_name: string): Promise<[number, number, string[], number, number, number[][], number, number[]]>
  ZSpectr_StatusGet(): Promise<[number]>
  ZSpectr_Stop(): Promise<[]>
  ZSpectr_TTLSyncGet(): Promise<[number, number, number, number]>
  ZSpectr_TTLSyncSet(TTL_line: number, TTL_polarity: number, Time_to_on_s: number, On_duration_s: number): Promise<[]>
  ZSpectr_TimingGet(): Promise<[number, number, number, number, number, number, number]>
  ZSpectr_TimingSet(Z_averaging_time_s: number, Initial_settling_time_s: number, Maximum_slew_rate_Vdivs: number, Settling_time_s: number, Integration_time_s: number, End_settling_time_s: number, Z_control_time_s: number): Promise<[]>
}

/** 把一个调用器包成门面。逐方法查表 → 按 `args` 顺序配对 → 交给调用器。 */
export function createFacade(call: NanonisCall): NanonisFacade {
  const out: Record<string, unknown> = {}
  for (const [method, spec] of Object.entries(NANONIS_METHODS)) {
    out[method] = (...values: unknown[]) =>
      call(
        spec.command,
        spec.args.map((a, i) => ({ value: values[i], fmt: a.fmt })),
        spec.returns,
      )
  }
  return out as unknown as NanonisFacade
}
