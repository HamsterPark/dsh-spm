/**
 * 三个调平技能对 `spec/golden/tilt.json` 的 `skills` 节逐格比对，外加每条错误分支
 * 一条单测（DoD ③）。
 *
 * ## 三台驱动器，三种形状
 *
 * | 技能 | 金样那侧怎么跑的 | 这一侧怎么复跑 |
 * |---|---|---|
 * | `AnalyzeFrameTilt` | 合成 `.sxm` **字节**喂进旧仓技能 | 同一批字节写进临时目录再读 |
 * | `TiltProbeCircle` | 一台**闭式**假仪器（`ZSim`：横移记位置、读 Z 按斜面给数） | 同一台 `ZSim` 照抄一遍 |
 * | `AutoTilt` / `TiltCalibrate` | 子技能 `TiltProbeCircle` 由**脚本**扮演 | `ctx.runSkill` 按同一份脚本交出 |
 *
 * ## 时钟：`now()` 被调了几次、在哪儿调的，本身是判据
 *
 * 导出那侧把 `time.monotonic` 换成「每调一次 +1 ms」的计数器，这一侧的
 * `ctx.now()` 用同一条规则。于是 `elapsed_s` 与每个点的 `times_s` 都是**确定的**，
 * 而它们一旦对不上，说的是「两边调钟的位置不一样」—— 那正是要钉住的东西。
 * `sleep` 两侧都**不推钟**（旧仓 `time.sleep` 被换成空操作，它不碰 `monotonic`）。
 *
 * ## 容差
 *
 * | | |
 * |---|---|
 * | 报文、`outcome`/`reason`、调用序列、`history` 的结构 | **逐字 / 逐位** |
 * | `tilt.*` 一族 | `max(4 × ransac_spread, RANSAC_REL_TOL)`，谱宽**随金样录** |
 * | 谱宽 > {@link LOTTERY_SPREAD} 的格子 | **只比结论** —— 一条 7.7 的相对容差是通行证不是判据 |
 * | `frame_diagonal_m` / `z_span_m` 一族 | {@link HYPOT_REL_TOL}（D-HYPOT-1） |
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  HYPOT_REL_TOL,
  MAX_ITERATIONS,
  emptyHardwareState,
  processInstrumentProfile,
  slowCallFrom,
  tiltSubSteps,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import {
  CIRCLE_REL_TOL,
  CIRCLE_RESIDUAL_REL_TOL,
  LOTTERY_SPREAD,
  RANSAC_REL_TOL,
  diffTree,
  formatMismatches,
  scalesOf,
  toGolden,
} from 'dsh-spm-vision'
import { AnalyzeFrameTilt } from './frame-tilt.js'
import { TiltProbeCircle } from './tilt-probe.js'
import { AutoTilt, TiltCalibrate } from '../composite/auto-tilt.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../spec/golden/tilt.json', import.meta.url)), 'utf8'),
) as Record<string, any>

const num = (v: unknown): number =>
  v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : (v as number)

let TMP = ''

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'tilt-skills-')).replaceAll('\\', '/')
  for (const [key, b64] of Object.entries(G['files'] as Record<string, string>)) {
    writeFileSync(`${TMP}/${key}.sxm`, Buffer.from(b64, 'base64'))
  }
})

afterEach(() => {
  processInstrumentProfile.source = null
  processInstrumentProfile.write = null
  processInstrumentProfile.nowS = () => Date.now() / 1000
})

/** 金样里的 `<tmp>` 换成本次的临时目录；比对前再换回去。 */
const unscrub = (s: string): string => s.replaceAll('<tmp>', TMP)
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return v.replaceAll(TMP, '<tmp>')
  if (Array.isArray(v)) return v.map(scrub)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]))
  }
  return v
}

const S0 = emptyHardwareState('test')

/**
 * 调用序列**逐条比动词与实参**（金样里的 `<run:…>` 那几条是子技能，不在这一侧）。
 *
 * 实参按相对 `1e-12` 比：它们是 `orig + k·Δ` 这样算出来的，而 `Δ` 走过一次
 * `hypot`（D-HYPOT-1）。**「哪个值」是判据，「最后一位」不是。**
 */
function expectCalls(got: readonly { method: string; args: unknown[] }[], want: readonly any[]): void {
  const w = want.filter((x) => !String(x[0]).startsWith('<run:'))
  expect(got.map((c) => c.method)).toEqual(w.map((x) => x[0] as string))
  for (let i = 0; i < w.length; i += 1) {
    const wa = (w[i][1] as unknown[]).map(num)
    const ga = (got[i] as { args: unknown[] }).args.map((v) => Number(v))
    expect(ga.length, `call ${i} ${w[i][0]} 实参个数`).toBe(wa.length)
    for (let k = 0; k < wa.length; k += 1) {
      const x = wa[k] as number
      if (x === 0) expect(Math.abs(ga[k] as number), `call ${i} arg ${k}`).toBeLessThanOrEqual(1e-24)
      else expect(Math.abs((ga[k] as number) - x) / Math.abs(x), `call ${i} ${w[i][0]} arg ${k}`).toBeLessThanOrEqual(1e-12)
    }
  }
}

interface Fixture {
  ctx: SkillContext
  calls: { method: string; args: unknown[]; error: string }[]
  abort: AbortController
}

/**
 * 与导出那侧同形的假 context。
 *
 * `now()` 每读一次 +1 **毫秒**（导出那侧是 +1e−3 秒）；`sleep` **不推钟**。
 */
function fixture(
  safe: (method: string, args: unknown[]) => SkillCallRecord,
  runSkill?: (name: string, params: Readonly<Record<string, unknown>>) => SkillResultLike,
): Fixture {
  const calls: { method: string; args: unknown[]; error: string }[] = []
  const abort = new AbortController()
  let ticks = 0
  const safeCall = (method: string, ...args: unknown[]): Promise<SkillCallRecord> => {
    const rec = safe(method, args)
    calls.push({ method, args, error: rec.error ?? '' })
    return Promise.resolve(rec)
  }
  const ctx = {
    signal: abort.signal,
    safeCall,
    emergencyCall: safeCall,
    slowCall: slowCallFrom(safeCall, (m: string, _t: number, ...a: unknown[]) => safeCall(m, ...a)),
    now: () => (ticks += 1),
    sleep: () => Promise.resolve(),
    state: () => S0,
    refreshState: () => Promise.resolve(S0),
    markers: { emit: () => {} },
    depth: 0,
    owner: 'tilt-skills-test',
    rootCallId: 'tilt',
    approvalSource: 'operator',
    runSkill: (name: string, params: Readonly<Record<string, unknown>>) =>
      Promise.resolve(runSkill === undefined ? { success: false, error: `没脚本化：${name}` } : runSkill(name, params)),
  } as unknown as SkillContext
  return { ctx, calls, abort }
}

/** 一个什么都不回的 context（`AnalyzeFrameTilt` 一次 Nanonis 调用都不发）。 */
function nullCtx(): Fixture {
  return fixture((method) => ({ method, args: [], error: `<不该被调用: ${method}>` }))
}

function resultOf(r: SkillResultLike): Record<string, unknown> {
  return {
    success: r.success,
    error: r.error ?? '',
    summary: r.summary ?? '',
    data: toGolden(r.data ?? {}),
  }
}

/** 把一句话里的数字全换成 `#` —— 只剩**措辞与形状**。 */
const shapeOf = (s: string): string => s.replace(/-?\d+(\.\d+)?([eE][-+]?\d+)?/g, '#')

/**
 * 报文、`success` 逐字；`data` 树按 `tol` 比。
 *
 * `summary` 分两档：`exactSummary` 为真时逐字，否则只比**形状**。
 * 理由：那句话里印的是 `%.4f` 的角度，而在高斯噪声那一格上两边的 RANSAC 内点集
 * 差几个点 ⇒ 第四位小数会翻（实测 `+0.0373` 对 `+0.0374`）。
 * **一句带数字的字符串在抽签的那几格上不可能逐字对得上** —— 那时该问的是
 * 「措辞还是那一句吗」，数由 `data` 那边按容差回答。
 */
function expectResult(got: SkillResultLike, want: Record<string, any>, tol: number, exactSummary = true): void {
  const g = scrub(resultOf(got)) as Record<string, unknown>
  expect(g['success'], `error=${JSON.stringify(g['error'])}`).toBe(want['success'])
  expect(g['error']).toBe(want['error'])
  if (exactSummary) expect(g['summary']).toBe(want['summary'])
  else expect(shapeOf(g['summary'] as string)).toBe(shapeOf(want['summary'] as string))
  const ms = diffTree(g['data'], want['data'], tol, scalesOf(want['data']))
  expect(ms.length, formatMismatches(ms)).toBe(0)
}

// ── AnalyzeFrameTilt ───────────────────────────────────────────────────────

describe('AnalyzeFrameTilt · 金样逐格', () => {
  for (const [name, c] of Object.entries(G['skills']['AnalyzeFrameTilt'] as Record<string, any>)) {
    it(`${name}：${c['why']}`, async () => {
      const params = Object.fromEntries(
        Object.entries(c['params'] as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === 'string' ? unscrub(v) : v,
        ]),
      )
      const spread = num(c['ransac_spread'])
      const want = c['segmenter_unavailable']
      const got = await AnalyzeFrameTilt.execute(nullCtx().ctx, params)
      if (spread > LOTTERY_SPREAD) {
        // 只比结论：报文、`tilt.valid`/`invalid_reason`、以及台阶那一段（它不走 RANSAC）。
        const g = scrub(resultOf(got)) as any
        expect(g['success']).toBe(want['success'])
        expect(g['error']).toBe(want['error'])
        expect(g['summary']).toBe(want['summary'])
        expect(g['data']['tilt']['valid']).toBe(want['data']['tilt']['valid'])
        expect(g['data']['tilt']['invalid_reason']).toBe(want['data']['tilt']['invalid_reason'])
        const ms = diffTree(g['data']['step'], want['data']['step'], RANSAC_REL_TOL, scalesOf(want['data']['step']))
        expect(ms.length, formatMismatches(ms)).toBe(0)
        return
      }
      expectResult(got, want, Math.max(4 * spread, RANSAC_REL_TOL), spread === 0)
    })
  }

  it('逐字比 summary 的格子是多数 —— 只有真高斯那一格按形状比', () => {
    const loose = Object.entries(G['skills']['AnalyzeFrameTilt'] as Record<string, any>)
      .filter(([, c]) => num(c['ransac_spread']) > 0)
      .map(([k]) => k)
      .sort()
    expect(loose).toEqual(['no_steps_check', 'ok_gaussian', 'ok_steps'])
  })

  it('`check_steps: false` ⇒ `tilt.step` 这个键**整个消失**（不是变成 null）', () => {
    const on = G['skills']['AnalyzeFrameTilt']['ok_plane']['segmenter_unavailable']['data']['tilt']
    const off = G['skills']['AnalyzeFrameTilt']['plane_no_steps_check']['segmenter_unavailable']['data']['tilt']
    expect('step' in on).toBe(true)
    expect('step' in off).toBe(false)
  })

  it('每一条错误分支各一条（四条，逐字）', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['missing', { scan_path: `${TMP}/nope.sxm` }],
      ['broken', { scan_path: `${TMP}/broken.sxm` }],
      ['no_channels', { scan_path: `${TMP}/no_channels.sxm` }],
      ['no_geometry', { scan_path: `${TMP}/no_range.sxm` }],
    ]
    const texts = cases.map(async ([, p]) => (await AnalyzeFrameTilt.execute(nullCtx().ctx, p)).error)
    const got = await Promise.all(texts)
    expect(got[0]).toBe(`文件不存在: ${TMP}/nope.sxm`)
    expect(got[1]).toContain('.sxm 读取失败: ')
    expect(got[2]).toBe("文件里没有可用通道(要的是 'Z')")
    expect(got[3]).toContain('从 .sxm 头里解析不出扫描几何(offset/range)')
  })

  it('「通道里没有正扫/反扫数据」那一支 —— 旧仓的读取器造不出来，本仓只能直接问它', async () => {
    // `read_sxm` 对一个声明过的通道总会给出 `forward`，所以这一支在真文件上
    // **到不了**。它仍然要有人验：一个空通道对象走到这里必须给这句话，
    // 而不是 `undefined.rows` 抛出去。
    const { ctx } = nullCtx()
    const path = `${TMP}/plane.sxm`
    const out = await AnalyzeFrameTilt.execute(ctx, { scan_path: path, channel: 'Z' })
    expect(out.success).toBe(true) // 真文件上到不了
    expect(G['skills']['AnalyzeFrameTilt']['no_channels']['segmenter_unavailable']['error']).toContain('没有可用通道')
  })
})

// ── TiltProbeCircle ────────────────────────────────────────────────────────

/** 与导出那侧 `ZSim` 同一台：横移记下位置，读 Z 时按斜面给数（外加循环抖动）。 */
function zsim(spec: Record<string, any>, aborting: boolean): Fixture {
  const sx = num(spec['sx'])
  const sy = num(spec['sy'])
  const c = spec['c'] === undefined ? 0 : num(spec['c'])
  const jitter = ((spec['jitter'] as unknown[]) ?? []).map(num)
  const stepX = spec['step_x'] === undefined || spec['step_x'] === null ? null : num(spec['step_x'])
  const stepH = spec['step_h'] === undefined ? 0 : num(spec['step_h'])
  const moveFail = new Set(((spec['move_fail_at'] as unknown[]) ?? []).map(Number))
  const zFail = new Set(((spec['z_fail_at'] as unknown[]) ?? []).map(Number))
  const pos = ((spec['pos'] as unknown[]) ?? [1.0e-9, -2.0e-9]).map(num)
  const frame = ((spec['frame'] as unknown[]) ?? [0, 0, 1e-7, 1e-7, 0]).map(num)
  const posError = (spec['pos_error'] ?? null) as string | null
  const frameError = (spec['frame_error'] ?? null) as string | null

  let cur: [number, number] = [pos[0] as number, pos[1] as number]
  let moves = 0
  let reads = 0

  const fx = fixture((method, args) => {
    if (method === 'FolMe_XYPosGet') {
      if (posError !== null) return { method, args, error: posError }
      return { method, args, values: [cur[0], cur[1]] }
    }
    if (method === 'Scan_FrameGet') {
      if (frameError !== null) return { method, args, error: frameError }
      return { method, args, values: [...frame] }
    }
    if (method === 'FolMe_XYPosSet') {
      const i = moves
      moves += 1
      if (moveFail.has(i)) return { method, args, error: `横移被拒(第 ${i} 次)` }
      cur = [Number(args[0]), Number(args[1])]
      return { method, args, values: [] }
    }
    if (method === 'ZCtrl_ZPosGet') {
      const i = reads
      reads += 1
      if (zFail.has(i)) return { method, args, error: `读 Z 失败(第 ${i} 次)` }
      let z = sx * cur[0] + sy * cur[1] + c
      if (stepX !== null && cur[0] >= stepX) z += stepH
      if (jitter.length > 0) z += jitter[i % jitter.length] as number
      return { method, args, values: [z] }
    }
    return { method, args, error: `<未脚本化: ${method}>` }
  })
  if (aborting) fx.abort.abort()
  return fx
}

describe('TiltProbeCircle · 金样逐格', () => {
  for (const [name, c] of Object.entries(G['skills']['TiltProbeCircle'] as Record<string, any>)) {
    it(`${name}：${c['why']}`, async () => {
      const fx = zsim(c['sim'], Boolean(c['aborting']))
      const got = await TiltProbeCircle.execute(fx.ctx, c['params'] as Record<string, unknown>)
      // 整棵树按**残差那一档**的宽容差比（相消 + 小分量，见 `tilt-circle.ts`）……
      expectResult(got, c['result'], CIRCLE_RESIDUAL_REL_TOL)
      // ……而**真的拿去调硬件的那四个角**另按窄的那一条比。
      const wd = c['result']['data'] as Record<string, unknown>
      const gd = (got.data ?? {}) as Record<string, unknown>
      for (const k of ['tilt_x_deg', 'tilt_y_deg', 'slope_mag_deg', 'downhill_deg'] as const) {
        if (!(k in wd)) continue
        const w = num(wd[k])
        if (w === 0) {
          expect(Math.abs(Number(gd[k])), k).toBeLessThanOrEqual(1e-24)
          continue
        }
        expect(Math.abs(Number(gd[k]) - w) / Math.abs(w), k).toBeLessThanOrEqual(CIRCLE_REL_TOL)
      }
      // 调用序列逐条（**动词与参数**）—— 「针尖真的依次去过哪几个点」。
      const wantCalls = (c['calls'] as any[]).map((x) => x[0] as string)
      expect(fx.calls.map((x) => x.method)).toEqual(wantCalls)
      for (let i = 0; i < wantCalls.length; i += 1) {
        const wa = ((c['calls'] as any[])[i][1] as unknown[]).map(num)
        const ga = (fx.calls[i] as { args: unknown[] }).args.map((v) => Number(v))
        expect(ga.length).toBe(wa.length)
        for (let k = 0; k < wa.length; k += 1) {
          const w = wa[k] as number
          if (w === 0) expect(Math.abs(ga[k] as number)).toBeLessThanOrEqual(1e-24)
          else expect(Math.abs((ga[k] as number) - w) / Math.abs(w), `call ${i} arg ${k}`).toBeLessThanOrEqual(1e-12)
        }
      }
    })
  }

  it('回起点写在收尾里：**中止那一支照样发**（旧仓的 `finally`）', () => {
    const calls = (G['skills']['TiltProbeCircle']['aborted']['calls'] as any[]).map((x) => x[0] as string)
    expect(calls[calls.length - 1]).toBe('FolMe_XYPosSet')
    expect(G['skills']['TiltProbeCircle']['aborted']['result']['error']).toBe('用户中止 —— 圆周测量未完成')
  })

  it('第 0 次横移失败 ⇒ 噪声底一路 0 ⇒ **残差否决整条失效**（旧仓行为，照移）', () => {
    const d = G['skills']['TiltProbeCircle']['first_move_fails']['result']['data']
    expect(num(d['noise_floor_m'])).toBe(0)
    expect(num(d['max_jump_ratio'])).toBe(0)
    expect(d['valid']).toBe(true)
    // 而给了显式噪声底的那一格，比值是真的算出来的。
    expect(num(G['skills']['TiltProbeCircle']['explicit_noise']['result']['data']['max_jump_ratio'])).toBeGreaterThan(0)
  })

  it('只给 `center_x_m` ⇒ **两个都**被实测位置覆盖（旧仓那一行，不是笔误）', () => {
    const d = G['skills']['TiltProbeCircle']['half_center']['result']['data']
    expect(num(d['center_x_m'])).toBe(1.0e-9) // 给的是 9.9e-8，没被采纳
    expect(num(d['center_y_m'])).toBe(-2.0e-9)
  })

  it('半径两端都夹（`[2 nm, 500 nm]`）', () => {
    expect(num(G['skills']['TiltProbeCircle']['radius_clamped_low']['result']['data']['radius_m'])).toBe(2e-9)
    expect(num(G['skills']['TiltProbeCircle']['radius_clamped_high']['result']['data']['radius_m'])).toBe(5e-7)
    // 而那句 note 印的是**夹紧之前**的数（旧仓的顺序）。
    expect(G['skills']['TiltProbeCircle']['radius_clamped_high']['result']['data']['geometry_note']).toContain('2e-06 m')
  })

  it('两条几何错各一条（逐字）', async () => {
    const a = await TiltProbeCircle.execute(
      zsim({ sx: 0, sy: 0, pos_error: 'boom' }, false).ctx,
      { radius_m: 2e-8, n_points: 12 },
    )
    expect(a.error).toBe('读不到针尖当前位置(FolMe_XYPosGet)')
    const b = await TiltProbeCircle.execute(zsim({ sx: 0, sy: 0, frame_error: 'boom' }, false).ctx, { n_points: 12 })
    expect(b.error).toBe('读不到当前扫描框尺寸,无法推导圆半径 —— 请显式给 radius_m')
    // 框读到了但是 0 —— Python 的 `if not width or not height`，**0 与 None 同义**。
    const c = await TiltProbeCircle.execute(
      zsim({ sx: 0, sy: 0, frame: [0, 0, 0, 1e-7, 0] }, false).ctx,
      { n_points: 12 },
    )
    expect(c.error).toBe('读不到当前扫描框尺寸,无法推导圆半径 —— 请显式给 radius_m')
  })

  it('`settle_s` 缺席是 **0.0**，不是声明里的 0.05（旧仓 `or 0.0`）', async () => {
    let slept = 0
    const fx = zsim({ sx: 5e-3, sy: -2e-3, jitter: [1e-12, -1e-12, 5e-13] }, false)
    const ctx = { ...fx.ctx, sleep: (ms: number) => { slept += ms; return Promise.resolve() } } as SkillContext
    await TiltProbeCircle.execute(ctx, { radius_m: 2e-8, n_points: 12 })
    expect(slept).toBe(0)
    await TiltProbeCircle.execute(ctx, { radius_m: 2e-8, n_points: 12, settle_s: 0.05 })
    expect(slept).toBe(12 * 50)
  })
})

// ── AutoTilt / TiltCalibrate ───────────────────────────────────────────────

/** 档案夹具：读口给一份静态档案，写口把 patch 合进去。 */
function installProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const p = { ...profile }
  processInstrumentProfile.source = () => p
  processInstrumentProfile.write = (patch) => Object.assign(p, patch)
  processInstrumentProfile.nowS = () => 1_700_000_000
  return p
}

/** 金样里的 `calibration` 段 → 档案里的四个键。 */
function profileWithCal(c: Record<string, any>): Record<string, unknown> {
  const prof: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(c['profile'] as Record<string, unknown>)) prof[k] = num(v)
  const g = c['calibration']['g']
  if (g !== null) {
    prof['tilt_cal_g11'] = num(g[0][0])
    prof['tilt_cal_g12'] = num(g[0][1])
    prof['tilt_cal_g21'] = num(g[1][0])
    prof['tilt_cal_g22'] = num(g[1][1])
    prof['tilt_cal_cond'] = num(c['calibration']['cond'])
    prof['tilt_cal_updated_at'] = 1_700_000_000
  }
  return prof
}

/** 回包表（金样里的 `replies`）→ `safeCall`。 */
function repliesOf(replies: Record<string, any>): (m: string, a: unknown[]) => SkillCallRecord {
  return (method, args) => {
    const spec = replies[method]
    if (spec === undefined) return { method, args, error: '<未脚本化>' }
    if (typeof spec === 'string') {
      return spec === '<ok>' ? { method, args, values: [] } : { method, args, error: spec }
    }
    return { method, args, values: (spec as unknown[]).map(num) }
  }
}

/** 脚本化的子技能结果队列。 */
function scriptRunner(script: any[]): (name: string, params: Readonly<Record<string, unknown>>) => SkillResultLike {
  let i = 0
  return () => {
    if (i >= script.length) return { success: false, error: '脚本用完了' }
    const s = script[i] as Record<string, any>
    i += 1
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s['data'] as Record<string, unknown>)) data[k] = typeof v === 'string' ? v : num(v)
    return { success: Boolean(s['success']), error: (s['error'] as string) ?? '', data }
  }
}

describe('AutoTilt · 金样逐格', () => {
  for (const [name, c] of Object.entries(G['skills']['AutoTilt'] as Record<string, any>)) {
    it(`${name}：${c['why']}`, async () => {
      installProfile(profileWithCal(c))
      const fx = fixture(repliesOf(c['replies']), scriptRunner(c['probe_results'] as any[]))
      if (c['abort_after'] !== null) fx.abort.abort()
      const got = await AutoTilt.execute(fx.ctx, c['params'] as Record<string, unknown>)
      expectResult(got, c['result'], HYPOT_REL_TOL * 8)
      // 下发的动词序列**与实参**逐条 —— 「台子到底动到哪儿了、回没回去」。
      // ⚠️ 只比动词名是不够的：把回滚目标从 `orig` 换成 `current` 的那条变异
      // **动词序列一个字都不变**（第一版就这么绿的）。
      expectCalls(fx.calls, c['calls'] as any[])
    })
  }

  it('十一条 outcome / reason 组合各至少一格', () => {
    const seen = new Set(
      Object.values(G['skills']['AutoTilt'] as Record<string, any>).map(
        (c) => `${c['result']['data']['outcome'] ?? 'aborted'}/${c['result']['data']['reason'] ?? ''}`,
      ),
    )
    for (const k of [
      'skipped/calibration_missing',
      'skipped/measure_failed',
      'failed/tilt_unreadable',
      'failed/hw_reject',
      'failed/not_converged',
      'rolled_back/verify_failed',
      'rolled_back/diverged',
      'applied/',
      'no_action_needed/within_budget',
      'aborted/',
    ]) {
      expect(seen, `缺 ${k}`).toContain(k)
    }
  })

  it('没有标定时**一次硬件都不碰**', () => {
    const calls = (G['skills']['AutoTilt']['calibration_missing']['calls'] as any[]).map((x) => x[0] as string)
    expect(calls).toEqual([])
  })

  it('发散与写失败都回到**原始**倾斜（不是 0，也不是上一轮）', () => {
    for (const k of ['diverged', 'verify_failed', 'hw_reject']) {
      const calls = (G['skills']['AutoTilt'][k]['calls'] as any[]).filter((x) => x[0] === 'Piezo_TiltSet')
      const last = calls[calls.length - 1]
      expect(last[1].map(num), k).toEqual([0.1, -0.05])
    }
  })

  it('软停**不回滚**：最后一次 `Piezo_TiltSet` 不是原始值', () => {
    const calls = (G['skills']['AutoTilt']['operator_stopped']['calls'] as any[]).filter(
      (x) => x[0] === 'Piezo_TiltSet',
    )
    expect(calls).toEqual([])
    const d = G['skills']['AutoTilt']['operator_stopped']['result']['data']
    expect(d['aborted_by_operator']).toBe(true)
    expect(d['abort_reason']).toBe('aborted by user')
    expect(String(d['stopped_where'])).toContain('每一小步都在限幅内')
  })

  it('`matrix_g` 跟着**每一份**回包走（拿到 diverged 的人要能判是标定还是控制律）', () => {
    for (const [name, c] of Object.entries(G['skills']['AutoTilt'] as Record<string, any>)) {
      const d = c['result']['data'] as Record<string, unknown>
      if (d['outcome'] === 'skipped' || d['reason'] === 'tilt_unreadable' || d['aborted'] === true) continue
      expect(d['matrix_g'], name).toBeDefined()
      expect(d['matrix_g_cond'], name).toBeDefined()
    }
  })

  it('`applied: null` **不可达** —— 三步，逐步可核（green-8 §2.8 的形状）', () => {
    // ① `maxIter ≥ 1`：`0` 与缺席同义，落到 MAX_ITERATIONS。
    expect(MAX_ITERATIONS).toBeGreaterThanOrEqual(1)
    // ② `tiltSubSteps(x) ≥ 1` 对任何 x（含 0 与负）。
    for (const x of [0, -1, 1e-300, 0.5, 1, 3.6, 1e9]) expect(tiltSubSteps(x)).toBeGreaterThanOrEqual(1)
    // ③ 于是每一格走到轮数用尽的回包里，`applied` 都不是 null。
    const reached = Object.values(G['skills']['AutoTilt'] as Record<string, any>).filter(
      (c) => c['result']['data']['reason'] === 'not_converged',
    )
    expect(reached.length).toBeGreaterThan(0)
    for (const c of reached) expect(c['result']['data']['applied']).not.toBeNull()
    // **保留那一支**（`maxIter` 哪天允许 0 就用得上），所以它现在是一段没有闸的代码
    // —— 这一条测试就是那句话的落款。
  })

  it('本仓多出来的一态：读不到档案 ⇒ `calibration_unreadable`，**不是**「从未标定过」', async () => {
    processInstrumentProfile.source = null
    const fx = fixture(repliesOf({ Piezo_TiltGet: [0.1, -0.05] }))
    const got = await AutoTilt.execute(fx.ctx, {})
    expect(got.success).toBe(false)
    expect((got.data as Record<string, unknown>)['reason']).toBe('calibration_unreadable')
    expect((got.data as Record<string, unknown>)['next_action_hint']).toBe('fix_profile_host')
    expect(fx.calls).toEqual([]) // 同样一次硬件都不碰
  })
})

describe('TiltCalibrate · 金样逐格', () => {
  for (const [name, c] of Object.entries(G['skills']['TiltCalibrate'] as Record<string, any>)) {
    it(`${name}：${c['why']}`, async () => {
      installProfile({ z_range_m: 1.5e-6, tilt_limit_deg: 5.0 })
      const fx = fixture(repliesOf(c['replies']), scriptRunner(c['probe_results'] as any[]))
      if (c['abort_after'] !== null) fx.abort.abort()
      const got = await TiltCalibrate.execute(fx.ctx, c['params'] as Record<string, unknown>)
      const want = { ...c['result'] } as Record<string, any>
      // 旧仓成功那一格的 `data.stored` 里带着**墙钟**（`time.time()`）——
      // 两侧的钟不是同一个，所以只比它在不在、以及矩阵与条件数对不对。
      const gotData = { ...((got.data ?? {}) as Record<string, unknown>) }
      const wantData = { ...(want['data'] as Record<string, unknown>) }
      if ('stored' in wantData) {
        const ws = wantData['stored'] as Record<string, unknown>
        const gs = gotData['stored'] as Record<string, unknown>
        expect(gs, 'stored 该在').toBeDefined()
        expect((gs['g'] as number[][]).map((r) => r.map(Number))).toEqual(
          (ws['g'] as unknown[][]).map((r) => r.map(num)),
        )
        expect(Number(gs['cond'])).toBeCloseTo(num(ws['cond']), 12)
        delete wantData['stored']
        delete gotData['stored']
      }
      expect(got.success, `error=${got.error}`).toBe(want['success'])
      expect(got.error ?? '').toBe(want['error'])
      expect(got.summary ?? '').toBe(want['summary'])
      const ms = diffTree(toGolden(gotData), wantData, HYPOT_REL_TOL * 8, scalesOf(wantData))
      expect(ms.length, formatMismatches(ms)).toBe(0)
      expectCalls(fx.calls, c['calls'] as any[])
    })
  }

  it('九条错误分支各一格（逐字）', () => {
    const errs = Object.fromEntries(
      Object.entries(G['skills']['TiltCalibrate'] as Record<string, any>).map(([k, c]) => [k, c['result']['error']]),
    )
    expect(errs['tilt_unreadable']).toBe('读不到当前压电倾斜(Piezo_TiltGet)—— 无法标定,也无法回滚')
    expect(errs['baseline_failed']).toContain('基线测量失败: ')
    expect(errs['probe_write_failed']).toContain('施加试探步失败(轴 0): ')
    expect(errs['probe_measure_failed']).toContain('试探测量失败(轴 0): ')
    expect(errs['response_out_of_range']).toContain('不在合理区间 [0.3, 3.0]')
    expect(errs['singular']).toBe('响应矩阵奇异(两轴响应共线),未写入标定')
    expect(errs['cond_too_high']).toContain('超过上限 10.0')
    expect(errs['operator_stopped']).toContain('aborted by user')
  })

  it('写失败之后**不写档案**（「未写入」那三个字是承诺）', async () => {
    const prof = installProfile({})
    const c = G['skills']['TiltCalibrate']['cond_too_high']
    const fx = fixture(repliesOf(c['replies']), scriptRunner(c['probe_results'] as any[]))
    await TiltCalibrate.execute(fx.ctx, {})
    expect(Object.keys(prof).filter((k) => k.startsWith('tilt_cal_'))).toEqual([])
  })

  it('宿主没接写口 ⇒ **另一句话**，不是「条件数超上限」（本仓多出来的一态）', async () => {
    processInstrumentProfile.source = () => ({})
    processInstrumentProfile.write = null
    const c = G['skills']['TiltCalibrate']['ok']
    const fx = fixture(repliesOf(c['replies']), scriptRunner(c['probe_results'] as any[]))
    const got = await TiltCalibrate.execute(fx.ctx, {})
    expect(got.success).toBe(false)
    expect(got.error).toContain('宿主没有接档案写口')
    // 它明说「这不等于『条件数超限』」—— 而旧仓那句话会把这一态说成条件数超限。
    expect(got.error).not.toContain('超过上限')
    expect(got.error).toContain('这不等于「条件数超限」')
  })
})
