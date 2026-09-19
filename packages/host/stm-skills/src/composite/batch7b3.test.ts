/**
 * 批 7b-3 · 五个 `composite.*` 技能对 `spec/golden/batch7b3.json` 的**逐格**比对
 * （DoD ③ + ⑤）。
 *
 * ## 这一份比三样东西，而第一样最要紧
 *
 * 1. **`runs`** —— 派出去的子技能名与参数，**按顺序**。那就是「计划」本身：
 *    一个组合技能的全部内容是它排了什么、按什么次序、带什么参数。
 *    只比 `data` 等于只看它自己怎么总结自己。
 * 2. **`calls`** —— 裸动词（只有 `TrackDrift_ReferenceScan` 有：它的抓帧
 *    不是子技能，是一次 `Scan_FrameDataGrab`）。
 * 3. 整棵 `SkillResult`（`success` / `error` / `summary` / `data`），逐叶子。
 *
 * ## 容差
 *
 * | 字段 | 容差 | 推导 |
 * |---|---|---|
 * | 计数 / 判语 / 步骤名 / 坐标 / 路径 | **0** | 栅格坐标两侧是同一串运算（`c + (i − (n−1)/2)·s`）；计数是计数 |
 * | `MoveAtomTo` 拖拽航点的 `x_m` / `y_m` | {@link HYPOT_REL} | **D-HYPOT-1**：两种语言的 `hypot` 差 1 ULP，而单位向量除以它 |
 * | `_progress.started_at` / `last_update_at` | **剥掉** | 时钟读数不是判据（同 `traces.test.ts` 的 `VOLATILE`） |
 *
 * `MoveAtomTo` 的另外十三格 `dy` 都是 0（`hypot(x, 0) == |x|`，两侧逐位相同），
 * 所以 `diagonal_drag_exercises_hypot` 是整份金样里**唯一**照得到 D-HYPOT-1 的一格。
 *
 * ## 时钟与路径两处夹具
 *
 * `TrackDrift_ReferenceScan` 会把 `int(time.time()*1000)` 写进参考图的文件名，
 * 并把那条路径原样放进 `message`（调用方下一次要带回来）。导出器把墙钟钉死成
 * `1_700_000_000`，这里用 {@link makeTrackDriftReferenceScan} 注入同一个数 ——
 * **而不是**在比对时把文件名整个丢掉：目录、`drift_ref_` 前缀、`.npy` 后缀都是判据。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  Skill,
  SkillCallRecord,
  SkillContext,
  SkillResultLike,
} from 'dsh-spm-kernel'
import { decodeNpy } from 'dsh-spm-numerics'
import { GridSTS, MAX_TRACKED_POINTS } from './grid-sts.js'
import { DemoScanAndSTS, buildStsPositions } from './demo-scan-and-sts.js'
import { makeTrackDriftReferenceScan } from './drift-track.js'
import { AcquireBiasImagingSeries, interleaveBiases, parseBiases } from './bias-imaging-series.js'
import { MAX_WAYPOINTS, MAX_WAYPOINT_M, MoveAtomTo, gainFor, waypoints } from './move-atom-to.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/batch7b3.json', import.meta.url)), 'utf8'),
) as {
  files: Record<string, string>
  cases: Record<string, GoldenCase>
}

interface GoldenCase {
  skill: string
  key: string
  params: Record<string, unknown>
  success: boolean
  error: string
  summary: string | null
  data: Record<string, unknown>
  runs: { skill: string; params: Record<string, unknown> }[]
  calls: { verb: string; args: unknown[] }[]
}

/** `Math.hypot` 差 1 ULP（D-HYPOT-1）。单位向量除以它，于是航点坐标跟着差。 */
const HYPOT_REL = 4 * Number.EPSILON

let TMP = ''
let PROJECT_ROOT = ''
let TrackDrift: Skill

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'b7b3-')).replaceAll('\\', '/')
  PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'b7b3-root-')).replaceAll('\\', '/')
  for (const [key, b64] of Object.entries(GOLDEN.files)) {
    writeFileSync(`${TMP}/${key}.npy`, Buffer.from(b64, 'base64'))
  }
  mkdirSync(`${PROJECT_ROOT}/experiments/frames`, { recursive: true })
  TrackDrift = makeTrackDriftReferenceScan({
    framesDir: () => `${PROJECT_ROOT}/experiments/frames`,
    // 导出器那侧 `time.time()` 被钉成 1_700_000_000.0，文件名里是
    // `int(time.time() * 1000)`。
    stamp: () => 1_700_000_000_000,
  })
})

const SKILL_OF = (name: string): Skill =>
  ({
    GridSTS,
    DemoScanAndSTS,
    TrackDrift_ReferenceScan: TrackDrift,
    AcquireBiasImagingSeries,
    MoveAtomTo,
  })[name] as Skill

/** 金样里的占位符换成本次运行的两个临时目录。 */
function realPath(v: unknown): unknown {
  if (typeof v === 'string') return v.replaceAll('<tmp>', TMP).replaceAll('<project-root>', PROJECT_ROOT)
  if (Array.isArray(v)) return v.map(realPath)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, realPath(x)]))
  }
  return v
}

/** 与导出器同一组归一化：两个临时目录、分隔符、操作系统那句错。 */
function normalize(v: unknown): unknown {
  if (typeof v === 'string') {
    let s = v
      .replaceAll(TMP, '<tmp>')
      .replaceAll(TMP.replaceAll('/', '\\'), '<tmp>')
      .replaceAll(PROJECT_ROOT, '<project-root>')
      .replaceAll(PROJECT_ROOT.replaceAll('/', '\\'), '<project-root>')
    if (s.includes('<tmp>') || s.includes('<project-root>')) s = s.replaceAll('\\', '/')
    return s
      .replace(/(ENOENT|EISDIR|EACCES|EPERM|EBUSY)[\s\S]*/, '<oserror>')
      .replace(/\[WinError [\s\S]*/, '<oserror>')
      .replace(/\[Errno [\s\S]*/, '<oserror>')
  }
  if (Array.isArray(v)) return v.map(normalize)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalize(x)]))
  }
  return v
}

/** 时钟读数不是判据 —— 剥掉 `_progress` 的两个时刻（同 `traces.test.ts`）。 */
function stripClocks(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  const prog = out['_progress']
  if (prog !== null && typeof prog === 'object') {
    const { started_at: _s, last_update_at: _l, ...rest } = prog as Record<string, unknown>
    out['_progress'] = rest
  }
  return out
}

/**
 * 一个**只按脚本答**的 `SkillContext`。
 *
 * `runSkill` 与导出器那侧的 `_ScriptCtx.run` 同一套规则：按技能名取，
 * 列表按调用次序取、用完取最后一个；`SetBias` 的值被记住，`GetBias` 默认答它。
 */
function scriptCtx(
  script: Record<string, unknown>,
  calls: Record<string, unknown>,
  setpointA: unknown,
): {
  ctx: SkillContext
  runs: { skill: string; params: Record<string, unknown> }[]
  verbs: { verb: string; args: unknown[] }[]
} {
  const runs: { skill: string; params: Record<string, unknown> }[] = []
  const verbs: { verb: string; args: unknown[] }[] = []
  const seen = new Map<string, number>()
  let lastBias: unknown = null

  const runSkill = (name: string, params: Readonly<Record<string, unknown>>): Promise<SkillResultLike> => {
    runs.push({ skill: name, params: { ...params } })
    if (name === 'SetBias') lastBias = params['bias_v']
    let spec = script[name]
    if (Array.isArray(spec)) {
      const n = seen.get(name) ?? 0
      seen.set(name, n + 1)
      spec = (spec[n] ?? spec[spec.length - 1]) as unknown
    }
    if (spec === undefined || spec === null) {
      spec =
        name === 'GetBias'
          ? { success: true, data: { bias_v: lastBias } }
          : name === 'GetSetpoint'
            ? { success: true, data: { setpoint_a: setpointA } }
            : { success: true, data: {} }
    }
    const s = spec as { success?: boolean; data?: Record<string, unknown>; error?: string }
    return Promise.resolve({
      success: s.success !== false,
      data: { ...(s.data ?? {}) },
      error: s.error ?? '',
    })
  }

  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    verbs.push({ verb: method, args })
    const entry = calls[method]
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && 'error' in entry) {
      return Promise.resolve({ method, args, error: String((entry as Record<string, unknown>)['error']) })
    }
    if (entry === undefined) return Promise.resolve({ method, args, error: `no stub for ${method}` })
    return Promise.resolve({ method, args, values: entry as readonly unknown[] })
  }

  const ctx = {
    signal: new AbortController().signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: (_s: number, m: string, ...a: unknown[]) => safeCall(m, ...a),
    runSkill,
    now: () => 1_700_000_000_000,
    // 整定等待走它 —— 测试里不真等（导出器那侧 `time.sleep` 也被钉成假钟）。
    sleep: () => Promise.resolve(),
    state: () => ({}) as never,
    refreshState: () => Promise.resolve({} as never),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'batch7b3',
    rootCallId: 'batch7b3',
    approvalSource: 'auto' as const,
  } as unknown as SkillContext
  return { ctx, runs, verbs }
}

/**
 * 导出器那侧每一格的脚本 —— **这里照抄一份**。
 *
 * 为什么不从金样里读：脚本是**输入**，而金样录的是输出。把输入也塞进金样，
 * 等于让被测那一侧从答案里读题。两份并排、差异在评审时看得见，
 * 这是批 4c `stubFor` 已经立过的规矩。
 */
const FAIL = { success: false, error: '模拟故障：子技能失败' }
const WAIT_OK = {
  success: true,
  data: { timed_out: false, stopped_early: false, outcome: 'completed', lines_done: 16, lines_total: 16 },
}
const WAIT_TIMEOUT = { success: true, data: { timed_out: true, stopped_early: false, lines_done: 7, lines_total: 16 } }
const WAIT_STOPPED = { success: true, data: { timed_out: false, stopped_early: true, lines_done: 11, lines_total: 16 } }
const FRAME = { success: true, data: { center_x_m: 2e-8, center_y_m: 1e-8, width_m: 4e-8 } }
const SAVED = { success: true, data: { saved_path: '<tmp>/bias_frame.sxm' } }
const assess = (conc: number): unknown => ({
  success: true,
  data: { verdict: 'atomic', angular_concentration: conc, snr: 12.5, period_fast_axis_nm: 0.25, coverage: 0.91 },
})
const READ_OK: Record<string, unknown> = {
  GetBias: { success: true, data: { bias_v: 0.8 } },
  GetSetpoint: { success: true, data: { setpoint_a: 60e-12 } },
  GetTipSpeed: { success: true, data: { speed_m_s: 250e-9, custom_speed: false } },
  GetCurrentGains: { success: true, data: { gain_index: 3, full_scale_a: 1e-6 } },
}
const verify = (verdict: string, extra: Record<string, unknown> = {}): unknown => ({
  success: true,
  data: { verdict, ...extra },
})
const AT_TARGET = verify('at_target', { found_x_m: 1.5e-9, found_y_m: 1e-11, residual_m: 1e-11, others: [] })
const DISPLACED = verify('displaced', { found_x_m: 1.2e-9, found_y_m: 0.0, residual_m: 3e-10, others: [] })
const NOT_FOUND = verify('not_found', { residual_m: null, others: [] })
const SCAN_OK = { success: true, data: { saved_path: '<tmp>/verify.sxm' } }

function grabBody(key: string, rows: number, cols: number): unknown[] {
  // `Scan_FrameDataGrab` 的 body：`[name_len, name, rows, cols, data, dir]`。
  return [4, 'Z (m)', rows, cols, `@${key}`, 1]
}
const GRAB_CUR = { Scan_FrameDataGrab: grabBody('cur_frame', 16, 16) }
const GRAB_REF = { Scan_FrameDataGrab: grabBody('ref_frame', 16, 16) }
const GRAB_SMALL = { Scan_FrameDataGrab: grabBody('small_frame', 8, 8) }
const GRAB_ERR = { Scan_FrameDataGrab: { error: 'NanonisError: no frame in buffer' } }

interface Script {
  runs?: Record<string, unknown>
  calls?: Record<string, unknown>
  setpointA?: unknown
}

const SCRIPTS: Record<string, Script> = {
  'GridSTS/ok_2x2': {},
  'GridSTS/second_move_fails_spectrum_is_suspect': {
    runs: { MoveToXY: [{ success: true }, FAIL, { success: true }, { success: true }] },
  },
  'GridSTS/all_sts_fail': { runs: { AcquireSTS: FAIL } },
  'GridSTS/configure_fails_aborts': { runs: { ConfigureSTS: FAIL } },
  'GridSTS/single_point': {},
  'GridSTS/defaults_are_3x3_and_40_points': {},
  'GridSTS/points_cap_is_inclusive_at_400': {},

  'DemoScanAndSTS/ok_three_points': { runs: { WaitScanComplete: WAIT_OK } },
  'DemoScanAndSTS/timed_out_is_reported_not_fatal': { runs: { WaitScanComplete: WAIT_TIMEOUT } },
  'DemoScanAndSTS/stopped_early_is_reported_not_fatal': { runs: { WaitScanComplete: WAIT_STOPPED } },
  'DemoScanAndSTS/outcome_derived_when_absent': {
    runs: { WaitScanComplete: { success: true, data: { timed_out: true } } },
  },
  'DemoScanAndSTS/save_scan_fails_but_run_stands': { runs: { WaitScanComplete: WAIT_OK, SaveScan: FAIL } },
  'DemoScanAndSTS/failed_move_skips_that_spectrum': {
    runs: { WaitScanComplete: WAIT_OK, MoveToXY: [{ success: true }, FAIL, { success: true }] },
  },
  'DemoScanAndSTS/nine_points_is_a_real_grid': { runs: { WaitScanComplete: WAIT_OK } },
  'DemoScanAndSTS/one_point': { runs: { WaitScanComplete: WAIT_OK } },
  'DemoScanAndSTS/configure_fails_aborts': { runs: { ConfigureScan: FAIL } },
  'DemoScanAndSTS/wait_step_failing_aborts': { runs: { WaitScanComplete: FAIL } },

  'TrackDrift_ReferenceScan/first_call_captures_reference': { calls: GRAB_REF },
  'TrackDrift_ReferenceScan/grab_fails_aborts': { calls: GRAB_ERR },
  'TrackDrift_ReferenceScan/tracks_and_compensates': { calls: GRAB_CUR },
  'TrackDrift_ReferenceScan/no_drift_no_compensation_step': { calls: GRAB_REF },
  'TrackDrift_ReferenceScan/compensation_step_fails_drift_still_reported': {
    calls: GRAB_CUR, runs: { ConfigureScan: FAIL },
  },
  'TrackDrift_ReferenceScan/size_mismatch_reports_zero_drift': { calls: GRAB_SMALL },
  'TrackDrift_ReferenceScan/ref_image_unreadable_aborts': { calls: GRAB_CUR },
  'TrackDrift_ReferenceScan/ref_scan_fails_aborts': { calls: GRAB_REF, runs: { FullScan: FAIL } },
  'TrackDrift_ReferenceScan/set_bias_fails_but_run_stands': { calls: GRAB_REF, runs: { SetBias: FAIL } },

  'AcquireBiasImagingSeries/refused_need_two_biases': {},
  'AcquireBiasImagingSeries/refused_no_scan_frame': {
    runs: { GetScanFrame: { success: true, data: {} } },
  },
  'AcquireBiasImagingSeries/ok_four_frames_with_time_scale': {
    runs: {
      GetScanFrame: FRAME, SaveScan: SAVED,
      AssessAtomicResolution: [assess(120.0), assess(180.0), assess(90.0), assess(100.0)],
    },
  },
  'AcquireBiasImagingSeries/bias_did_not_follow': {
    runs: {
      GetScanFrame: FRAME, SaveScan: SAVED, AssessAtomicResolution: assess(120.0),
      GetBias: [
        { success: true, data: { bias_v: 0.02 } },
        { success: true, data: { bias_v: 0.02 } },
        { success: true, data: { bias_v: -0.1 } },
        { success: true, data: { bias_v: 0.02 } },
      ],
    },
  },
  'AcquireBiasImagingSeries/setpoint_drifted': {
    runs: {
      GetScanFrame: FRAME, SaveScan: SAVED, AssessAtomicResolution: assess(120.0),
      GetSetpoint: [
        { success: true, data: { setpoint_a: 100e-12 } },
        { success: true, data: { setpoint_a: 100e-12 } },
        { success: true, data: { setpoint_a: 400e-12 } },
        { success: true, data: { setpoint_a: 100e-12 } },
      ],
    },
  },
  'AcquireBiasImagingSeries/no_saved_path': {
    runs: { GetScanFrame: FRAME, SaveScan: { success: true, data: {} } },
  },
  'AcquireBiasImagingSeries/repeat_off_loses_the_time_scale': {
    runs: {
      GetScanFrame: FRAME, SaveScan: SAVED,
      AssessAtomicResolution: [assess(120.0), assess(180.0), assess(90.0)],
    },
  },
  'AcquireBiasImagingSeries/one_good_frame_cannot_compare': {
    runs: {
      GetScanFrame: FRAME,
      SaveScan: [SAVED, { success: true, data: {} }, { success: true, data: {} }, { success: true, data: {} }],
      AssessAtomicResolution: assess(120.0),
    },
  },
  'AcquireBiasImagingSeries/explicit_frame_skips_the_readback': {
    setpointA: 50e-12,
    runs: { SaveScan: SAVED, AssessAtomicResolution: assess(150.0) },
  },
  'AcquireBiasImagingSeries/bias_string_parsing': {
    runs: { GetScanFrame: FRAME, SaveScan: SAVED, AssessAtomicResolution: assess(120.0) },
  },

  'MoveAtomTo/ok_at_target': { runs: { ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET } },
  'MoveAtomTo/displaced_then_at_target': {
    runs: { ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: [DISPLACED, AT_TARGET] },
  },
  'MoveAtomTo/displaced_exhausts_attempts': {
    runs: { ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: DISPLACED },
  },
  'MoveAtomTo/not_found_does_not_retry': {
    runs: { ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: NOT_FOUND },
  },
  'MoveAtomTo/verify_off': { runs: READ_OK },
  'MoveAtomTo/scan_gives_no_path': { runs: { ...READ_OK, ScanAt: { success: true, data: {} } } },
  'MoveAtomTo/restore_setpoint_fails_is_a_hard_failure': {
    runs: { ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET, SetSetpoint: [{ success: true }, FAIL] },
  },
  'MoveAtomTo/gain_widened_and_restored': {
    runs: {
      ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET,
      GetCurrentGains: { success: true, data: { gain_index: 3, full_scale_a: 60e-9 } },
    },
  },
  'MoveAtomTo/gain_unreadable_leaves_it_alone': {
    runs: {
      ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET,
      GetCurrentGains: { success: true, data: { full_scale_a: 1e-9 } },
    },
  },
  'MoveAtomTo/negative_imaging_bias_keeps_the_sign': {
    runs: {
      ...READ_OK, GetBias: { success: true, data: { bias_v: -1.2 } },
      ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET,
    },
  },
  'MoveAtomTo/none_valued_readback_falls_back_to_defaults': {
    runs: {
      GetBias: { success: true, data: { bias_v: null } },
      GetSetpoint: { success: true, data: { setpoint_a: null } },
      GetTipSpeed: { success: true, data: { speed_m_s: null } },
      GetCurrentGains: { success: true, data: {} },
      ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET,
    },
  },
  'MoveAtomTo/coord_epoch_passes_through': { runs: { ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET } },
  'MoveAtomTo/waypoints_are_capped_at_400': { runs: READ_OK },
  'MoveAtomTo/diagonal_drag_exercises_hypot': { runs: READ_OK },
  'MoveAtomTo/explicit_manip_conditions_give_a_resistance': {
    runs: { ...READ_OK, ScanAt: SCAN_OK, VerifyAdatomAt: AT_TARGET },
  },
}

/** 数值叶子的容差 —— 见文件抬头那张表。 */
function closeEnough(path: string, got: unknown, want: unknown): boolean {
  if (typeof got !== 'number' || typeof want !== 'number') return Object.is(got, want)
  if (Object.is(got, want)) return true
  // 拖拽航点：`start = atom − u·offset`，而 `u` 除以 `hypot` —— D-HYPOT-1。
  if (/^runs\[\d+]\.params\.[xy]_m$/.test(path)) {
    return Math.abs(got - want) <= HYPOT_REL * Math.max(Math.abs(want), Math.abs(got))
  }
  return false
}

/** 逐叶子比。返回对不上的地方（最多印六处）。 */
function mismatches(got: unknown, want: unknown, path = ''): string[] {
  if (Array.isArray(want) || Array.isArray(got)) {
    if (!Array.isArray(want) || !Array.isArray(got)) return [`${path}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`]
    if (got.length !== want.length) return [`${path}.length: ${got.length} ≠ ${want.length}`]
    const out: string[] = []
    for (let i = 0; i < want.length && out.length < 6; i += 1) out.push(...mismatches(got[i], want[i], `${path}[${i}]`))
    return out
  }
  if (want !== null && typeof want === 'object' && got !== null && typeof got === 'object') {
    const kw = Object.keys(want as object).sort()
    const kg = Object.keys(got as object).sort()
    if (JSON.stringify(kw) !== JSON.stringify(kg)) return [`${path} 键不同：${JSON.stringify(kg)} ≠ ${JSON.stringify(kw)}`]
    const out: string[] = []
    for (const k of kw) {
      if (out.length >= 6) break
      out.push(...mismatches((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], `${path}.${k}`))
    }
    return out
  }
  return closeEnough(path, got, want) ? [] : [`${path}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`]
}

// ──────────────────────────────────────────────────────────────────────────

describe('批 7b-3 —— 五个 composite 技能逐格对旧仓', () => {
  const bySkill = new Map<string, [string, GoldenCase][]>()
  for (const [id, c] of Object.entries(GOLDEN.cases)) {
    if (!bySkill.has(c.skill)) bySkill.set(c.skill, [])
    ;(bySkill.get(c.skill) as [string, GoldenCase][]).push([id, c])
  }

  it('金样里的每一格都有脚本 —— 少一格就等于少验一格', () => {
    expect(Object.keys(GOLDEN.cases).filter((id) => SCRIPTS[id] === undefined)).toEqual([])
  })

  for (const [skillName, rows] of bySkill) {
    describe(skillName, () => {
      for (const [id, c] of rows) {
        it(c.key, async () => {
          const sc = SCRIPTS[id] as Script
          const { ctx, runs, verbs } = scriptCtx(
            realPath(sc.runs ?? {}) as Record<string, unknown>,
            resolveGrabs(sc.calls ?? {}),
            sc.setpointA ?? 100e-12,
          )
          const got = await SKILL_OF(skillName).execute(ctx, realPath(c.params) as Record<string, unknown>)

          // ① 计划本身 —— 派了谁、按什么次序、带什么参数。
          const gotRuns = normalize(runs)
          const badRuns = mismatches(gotRuns, c.runs, 'runs')
          expect(badRuns.length === 0 || `${id} 的计划：${badRuns.join(' · ')}`).toBe(true)

          // ② 裸动词（只有 TrackDrift 有）。
          expect([id, verbs.map((v) => v.verb)]).toEqual([id, c.calls.map((v) => v.verb)])

          // ③ 整棵返回。
          const mine = {
            success: got.success,
            error: normalize(got.error ?? ''),
            summary: got.summary ?? null,
            data: normalize(stripClocks((got.data ?? {}) as Record<string, unknown>)),
          }
          const theirs = {
            success: c.success,
            error: c.error,
            summary: c.summary,
            data: stripClocks(c.data),
          }
          const bad = mismatches(mine, theirs, '')
          expect(bad.length === 0 || `${id}：${bad.join(' · ')}`).toBe(true)
        })
      }
    })
  }
})

/** `@<key>` 占位符换成那张合成帧的二维表（`Scan_FrameDataGrab` 的 body）。 */
function resolveGrabs(calls: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [verb, body] of Object.entries(calls)) {
    if (!Array.isArray(body)) {
      out[verb] = body
      continue
    }
    out[verb] = body.map((x) => (typeof x === 'string' && x.startsWith('@') ? frameOf(x.slice(1)) : x))
  }
  return out
}

const FRAME_CACHE = new Map<string, number[][]>()
function frameOf(key: string): number[][] {
  const hit = FRAME_CACHE.get(key)
  if (hit !== undefined) return hit
  // 与导出器**同一批字节**（金样里录的就是那份 `.npy`），不是照公式重建一份。
  const bytes = Buffer.from(GOLDEN.files[key] as string, 'base64')
  const { shape, values } = decode(new Uint8Array(bytes))
  const rows = shape[0] as number
  const cols = values.length / rows
  const out: number[][] = []
  for (let r = 0; r < rows; r += 1) out.push(Array.from(values.subarray(r * cols, (r + 1) * cols)))
  FRAME_CACHE.set(key, out)
  return out
}

// ──────────────────────────────────────────────────────────────────────────
// 几条金样验不到的：闸的边界、以及「那道闸够不着」
// ──────────────────────────────────────────────────────────────────────────

describe('GridSTS 的逐点记账上限**在声明范围内够不着**', () => {
  it('`nx`/`ny` 各封顶 20 ⇒ 最多 400 点 ⇒ 那条 `> 400 就不记` 永远不成立', () => {
    // 与 green-8 §2.8 同一条规矩：**先证明够不着，再决定拿它怎么办**。
    // 这里留着它（哪天上限放宽就是它上场的时候），但金样不为它编一格 ——
    // 一格造不出来的输入不是判据。
    const spec = GridSTS.spec
    const nx = spec.parameters.find((p) => p.name === 'nx')
    const ny = spec.parameters.find((p) => p.name === 'ny')
    expect([nx?.maxValue, ny?.maxValue]).toEqual([20, 20])
    expect((nx?.maxValue as number) * (ny?.maxValue as number)).toBe(MAX_TRACKED_POINTS)
  })
})

describe('DemoScanAndSTS 的谱点表', () => {
  it('≤5 个点走历史布局：中心 + 内接正方形四角，偏移 size/3', () => {
    // ⚠️ 期望值写成 `size / 3`，**不写 1e-8** —— `30e-9 / 3` 在 float64 上是
    // `9.999999999999999e-9`。写字面量等于给这一格加一条隐形容差，
    // 而它挡的正好是「偏移算错了」这一类。
    const off = 30e-9 / 3.0
    const p = buildStsPositions(0, 0, 30e-9, 5)
    expect(p).toEqual([[0, 0], [-off, -off], [off, -off], [off, off], [-off, off]])
  })

  it('>5 个点铺真网格 —— **每个点都不一样**（从前是拿中心补齐）', () => {
    for (const n of [6, 7, 9, 16, 25]) {
      const p = buildStsPositions(0, 0, 30e-9, n)
      expect([n, p.length]).toEqual([n, n])
      expect([n, new Set(p.map((q) => q.join(','))).size]).toEqual([n, n])
    }
  })
})

describe('AcquireBiasImagingSeries 的偏压表', () => {
  it('没给 / 空串 ⇒ 缺省四个，而缺省表与声明逐字一致', () => {
    expect(parseBiases(null)).toEqual([0.02, -0.02, 0.1, -0.1])
    expect(parseBiases('   ')).toEqual([0.02, -0.02, 0.1, -0.1])
    const dflt = AcquireBiasImagingSeries.spec.parameters.find((p) => p.name === 'biases_v')?.default
    expect(parseBiases(dflt)).toEqual([0.02, -0.02, 0.1, -0.1])
  })

  it('转不动的那一段**跳过**，不是拒绝整串', () => {
    expect(parseBiases('0.1, 抱歉, -0.1')).toEqual([0.1, -0.1])
  })

  it('按 |V| 升序、同一 |V| 正的在前，并按**原值**去重', () => {
    expect(interleaveBiases([-0.1, 0.5, 0.1, -0.5, 0.1])).toEqual([0.1, -0.1, 0.5, -0.5])
  })
})

describe('MoveAtomTo 的两条纯算术', () => {
  it('航点步长不超过 1 Å，而 400 是**硬上限**（一米长的拖拽不是一次操纵）', () => {
    const short = waypoints([0, 0], [MAX_WAYPOINT_M * 3, 0])
    expect(short.length).toBe(3)
    expect(short[short.length - 1]).toEqual([MAX_WAYPOINT_M * 3, 0])
    expect(waypoints([0, 0], [1.0, 0]).length).toBe(MAX_WAYPOINTS)
    // 零位移也要给一个航点 —— `max(1, ceil(0))`。
    expect(waypoints([0, 0], [0, 0])).toEqual([[0, 0]])
  })

  it('量程够就不动它；不够就退一档；读不到当前档就**不动**', () => {
    const base = {
      bias_v: 0.1, setpoint_a: 5e-11, speed_m_s: 1e-9, custom_speed: true,
      gain_index: 3, full_scale_a: 1e-6,
    }
    expect(gainFor(57e-9, base)).toBeNull()
    // 满量程 60 nA < 57 nA × 2 ⇒ 退一档
    expect(gainFor(57e-9, { ...base, full_scale_a: 60e-9 })).toBe(2)
    // 已经在第 0 档 ⇒ 退不动，停在 0（不是 −1）
    expect(gainFor(57e-9, { ...base, full_scale_a: 60e-9, gain_index: 0 })).toBe(0)
    // 读不到当前档 ⇒ 不动它
    expect(gainFor(57e-9, { ...base, full_scale_a: 60e-9, gain_index: null })).toBeNull()
    // 读不到满量程 ⇒ 不动它（`not full` 把 0 也算进去）
    expect(gainFor(57e-9, { ...base, full_scale_a: null })).toBeNull()
    expect(gainFor(57e-9, { ...base, full_scale_a: 0 })).toBeNull()
  })
})

/** 本文件自己解一次 `.npy`（只为把合成帧喂给假 context），走 numerics 的那一份。 */
function decode(bytes: Uint8Array): { shape: readonly number[]; values: Float64Array } {
  return decodeNpy(bytes)
}
