/**
 * 两个开工前自检 —— **移之前先把那句假的许可改掉**。
 *
 * 自检技能的本质是「把某个子系统的不变量跑一遍」。子系统不在，自检就变成空壳；
 * 而这两个的壳**会说话**，说的是「✅ 可以开工」。
 *
 * ## 旧仓那条 fail-open，以及它到底长什么样
 *
 * 两个自检共用一个 `add(name, ok, detail, blocking=False)`，规则是：
 *
 * * `ok is False` ⇒ 进 `blockers`（**当且仅当** `blocking=True`）或 `warnings`；
 * * **`ok is None` ⇒ 只进 `warnings`**；
 * * `ready = not blockers`。
 *
 * 于是每一处 `except Exception → add(…, None, "查不了（…）")` ——**依赖缺席**的那条路
 * ——都只留下一条警告。`TipForgeSelfCheck` 的第 4 项（判据干跑）与第 5 项（扎针深度包络）
 * 落进去时，这个自检**存在的全部理由**就没了，而它照样打出「✅ 可以开工」。
 *
 * ⚠️ **我跑了一遍旧仓，照出来的比盘点说的还要直白**（`spec/golden/skill_traces.json`
 * 的 `TipForgeSelfCheck/ok`）：那一趟**一个 except 都没触发**（旧仓的依赖全都在），
 * 而 `ready` 仍然是 `true` —— 因为「衬底可解析」那一条 `ok=False` 是
 * **`blocking=False`** 写的。也就是说这里有**两条**通往假许可的路：
 * 依赖缺席（`None`）与「失败但不阻塞」（`False, blocking=False`）。
 * 前者是这一批必须改的，后者照移（它是旧仓刻意的分级）——但两条都写在这里，
 * 因为下一个读代码的人只会看见自己撞上的那一条。
 *
 * ## 本仓这一侧：**依赖缺席 ⇒ `ok=false, blocking=true`**（有意与旧仓不同）
 *
 * 本仓大半个针尖工作流还没移植，所以这两个自检现在几乎必然报「❌ 还不能开工」。
 * **那正是真话**：`_tip_phases` 的六个特异化流程一个都不在，`PrepareNobleTip` /
 * `MakeSpectroscopyTip` 不存在，扫描地图与仪器档案也不在。一个在这种状态下说
 * 「可以开工」的自检，比没有这个自检更糟 —— 它把「我没检查」说成了「我检查过了」。
 *
 * ## `registry` 那一项换了不变量（**不是照移**）
 *
 * 旧仓查的是「冻结打包时 `walk_packages` 不跑、包 `__init__` 没 import 到的模块里的
 * 技能会**静默消失**」。本仓是静态
 * `import` + `export const`，掉一个技能是 `tsc` 编译错误：**这个不变量在 TypeScript 里
 * 不存在**。于是这一项换成「`REQUIRED_SKILLS` 里还有几个没移植」——同一个位置、
 * 同一种后果（有一条链是断的，而且断得很安静），判据换成本仓真有的那一个。
 */
import {
  currentTipFacts,
  envelopeOf,
  formatG,
  pyFixed,
  resolveConditioning,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { Xoshiro128, matOf } from 'dsh-spm-numerics'
import { assessAtomicPhase, scaleGate } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'

// ── 从旧仓工作流搬过来的**几个数**（不是搬那两个文件） ──────────────────────
//
// 同批 4d 的 `ATOMIC_WORKING_POINT`：跟着唯一的消费方走，把出处写在数字旁边。
// `core/noble_tip_workflow.py`(1273) 与 `core/special_tip_workflow.py`(410) 整体
// **不在这一批**（它们的消费方是 `_tip_phases.py` 的六个流程，也不在）。

/** `NobleTipWorkflow.pulse_v` —— 大修相使用的 10 V / 500 ms 脉冲。 */
export const NOBLE_TIP_PULSE_V = 10.0

/** `SpectroscopyTip.poke_depth_nm` —— 金属性针尖的浅扎深度（**这一项是这个自检存在的理由**）。 */
export const SPECTROSCOPY_TIP_POKE_DEPTH_NM = 0.3

/** `AtomicTip.eval_frame_nm` / `.eval_pixels` —— 评估帧的视野与像素数。 */
export const ATOMIC_TIP_EVAL_FRAME_NM = 5.0
export const ATOMIC_TIP_EVAL_PIXELS = 256

/** 修针流程依赖的全部技能。少一个就有一条链是断的 —— 而且断得很安静。 */
export const CONDITIONING_REQUIRED_SKILLS: readonly string[] = [
  // 本层新增
  'PrepareNobleTip', 'PulseConditionTip', 'PokeConditionTip',
  'BiasPulseWithReadback', 'FindCleanSpot', 'AssessTipSharpness',
  // 被它们当作子步骤调用的既有技能。
  // `GetBias`：扎针前要把当前偏压读下来存着，好在扎完放回去（qPlus 上扎针要先降到
  // 20 mV）。读不到就不改偏压，所以这一条是那条物理修正**能不能生效**的前提。
  // `CaptureSignalBuffer`：扎针前后采振幅，用来发现音叉起跳。采不到只是没有诊断。
  'TipShapeWithReadback', 'MoveToXY', 'GetBias', 'SetBias', 'SetSetpoint',
  'CaptureSignalBuffer',
  'ZControllerOnOff', 'ScanAt', 'SaveScan', 'GetLatestScanFile',
  'PreScanCheck', 'FindFlatRegion', 'AutoTilt', 'AnalyzeFrameTilt',
  'AssessClusterRoundness',
]

/** 两条锻造流程真正会调到的技能。 */
export const FORGE_REQUIRED_SKILLS: readonly string[] = [
  // 本层新增
  'MakeSpectroscopyTip', 'MakeAtomicResolutionTip',
  'AssessShockleyOnset', 'AssessAtomicPhase', 'BiasWiggle',
  // 被当作子步骤调用的既有技能
  'PokeConditionTip', 'TipShapeWithReadback', 'AssessClusterRoundness',
  'FindCleanSpot', 'FindFlatRegion', 'MoveToXY', 'ScanAt', 'SaveScan',
  'GetLatestScanFile', 'ConfigureScan', 'StartScan', 'StopScan',
  'SetBias', 'SetSetpoint', 'ZControllerOnOff',
  'ConfigureLockIn', 'ConfigureSTS', 'AcquireSTS',
]

export interface SelfCheckItem {
  readonly check: string
  readonly ok: boolean | null
  readonly detail: string
}

class Sheet {
  readonly checks: SelfCheckItem[] = []
  readonly blockers: string[] = []
  readonly warnings: string[] = []

  /**
   * 记一项。**`ok === null` 只进 warnings** —— 这一条照移，因为它本身没错：
   * 「这一项我判不了」确实不等于「这一项不合格」。
   *
   * 改掉的是**谁会落进 `null`**：旧仓让每一处 `except`（= 依赖缺席）落进来，
   * 而依赖缺席时那些检查一条都没跑。本仓的 `null` 只留给**真的是三态**的判据。
   */
  add(check: string, ok: boolean | null, detail: string, blocking = false): void {
    this.checks.push({ check, ok, detail })
    if (ok === false) (blocking ? this.blockers : this.warnings).push(`${check}: ${detail}`)
    else if (ok === null) this.warnings.push(`${check}: ${detail}`)
  }

  /**
   * 一个**本仓还没移植**的子系统。
   *
   * 这就是那条「`except → ok=None`」改成的样子：`ok=false` 且 **blocking**。
   * 措辞点名缺的是什么、在哪一批 —— 一句「查不了（ImportError）」对读的人没有用。
   */
  missing(check: string, what: string, batch: string): void {
    this.add(check, false, `${what} 本仓还没移植（${batch}）—— 这一项**没有被检查**，不是「检查通过」。`, true)
  }

  result(extra: Record<string, unknown>): SkillResultLike {
    const ready = this.blockers.length === 0
    const lines = [ready ? '✅ 可以开工' : '❌ 还不能开工']
    for (const c of this.checks) {
      const mark = c.ok === true ? '✅' : c.ok === false ? '❌' : '⚠'
      lines.push(`${mark} ${c.check}：${c.detail}`)
    }
    return {
      // 体检本身成功了；**结论在 `data.ready` 里，不是 `success`**。
      success: true,
      data: { ready, checks: this.checks, blockers: this.blockers, warnings: this.warnings, ...extra },
      summary: lines.join('\n'),
    }
  }
}

/** 已装进这个 build 的技能名。默认问 `IMPLEMENTED`（**唯一的**那份登记表）。 */
export interface SelfCheckDeps {
  readonly installed?: (() => Promise<readonly string[]>) | undefined
}

// 动态 import 而不是顶上 `import { IMPLEMENTED }`：`l0/index.ts` 要 import 这个文件，
// 静态互引就是一个循环。执行的时候两边都初始化好了。
async function installedNames(deps: SelfCheckDeps): Promise<readonly string[]> {
  if (deps.installed !== undefined) return deps.installed()
  const mod = await import('./index.js')
  return Object.keys(mod.IMPLEMENTED)
}

/** 第 1 项：`REQUIRED_SKILLS` 里还有几个没移植。见抬头。 */
async function addSkillCoverage(
  sheet: Sheet,
  required: readonly string[],
  deps: SelfCheckDeps,
): Promise<string[]> {
  const installed = new Set(await installedNames(deps))
  const missing = required.filter((n) => !installed.has(n))
  sheet.add(
    '技能齐全',
    missing.length === 0,
    missing.length === 0
      ? `全部就位（本仓已移植 ${installed.size} 个）`
      : `缺 ${missing.length} 个（本仓尚未移植）: ${missing.join(', ')}`,
    true,
  )
  return missing
}

/** 唯一一次硬件读：Tip Shaper 模块在不在跑。 */
async function addShaperProbe(sheet: Sheet, ctx: SkillContext): Promise<void> {
  const rec = await ctx.safeCall('TipShaper_PropsGet')
  const okShaper = rec.error === undefined || rec.error === ''
  sheet.add(
    'Tip Shaper 模块',
    okShaper,
    okShaper ? '在跑' : `读不到: ${rec.error ?? ''}（Nanonis 里把 Tip Shaper 模块打开）`,
    true,
  )
}

export function makeTipConditioningSelfCheck(deps: SelfCheckDeps = {}): Skill {
  return {
    spec: S.TipConditioningSelfCheckSpec,
    execute: async (ctx: SkillContext): Promise<SkillResultLike> => {
      const sheet = new Sheet()
      const missing = await addSkillCoverage(sheet, CONDITIONING_REQUIRED_SKILLS, deps)
      await addShaperProbe(sheet, ctx)

      // ── 针尖登记与脉冲包络 ────────────────────────────────────────────────
      const facts = currentTipFacts()
      const tipName = facts?.name ?? ''
      const plan = resolveConditioning(['pulse_v'], { pulse_v: NOBLE_TIP_PULSE_V }, { facts })
      if (facts === null) {
        // ⚠️ 旧仓这句话是：「未登记 —— 安全包络退到保守通用档，流程默认的 10 V 大修
        // 脉冲**会被拒**。先 register_tip。」这条理由已经过时：
        // 全部档位的 `max_abs_pulse_v` 统一拉到 10.0，于是通用档**不会**拒这一发
        // （`abs(10) > 10` 为假）。写这句话的时候它是真的（通用档 6.0 V）。
        // 所以这里**不写断言，写实测**：直接调用解析器确认当前结果。
        const env = envelopeOf(null)
        sheet.add(
          '针尖已登记',
          false,
          `未登记 —— 方案表退到保守通用档（上限 ±${formatG(env['max_abs_pulse_v'] ?? 0, 6)} V / ` +
            `${formatG((env['max_poke_depth_m'] ?? 0) * 1e9, 6)} nm / ${Math.trunc(env['max_pulse_count'] ?? 0)} 发），` +
            `流程默认的 ${formatG(NOBLE_TIP_PULSE_V, 6)} V 大修脉冲${plan.ok ? '仍在这一档的包络内' : '会被拒'}，` +
            '而参数默认值只能按通用档给（不知道装的是钨还是铂铱）。先 register_tip。',
          true,
        )
      } else {
        // 一支 qPlus 的登记常数是**没有任何 Nanonis 回读带得出来**的事实；
        // 力反演要 k，而这一行就是操作员（或 agent）能读到「登记了什么」的地方。
        const extras: string[] = []
        for (const [k, label, unit] of [
          ['qplus_k_n_per_m', 'k', ' N/m'],
          ['qplus_q', 'Q', ''],
          ['qplus_f0_hz', 'f0', ' Hz'],
        ] as const) {
          const v = facts[k]
          if (typeof v === 'number' && Number.isFinite(v)) extras.push(`${label}=${formatG(v, 6)}${unit}`)
        }
        sheet.add(
          '针尖已登记',
          true,
          `${tipName === '' ? '未命名' : tipName}（${facts.material === '' ? '?' : facts.material}/` +
            `${facts.form === '' ? '?' : facts.form}）` +
            (extras.length > 0 ? `，登记常数 ${extras.join('、')}` : ''),
        )
        sheet.add(
          `${formatG(NOBLE_TIP_PULSE_V, 6)} V 脉冲在包络内`,
          plan.ok,
          plan.ok ? '允许' : plan.refusals.join('；'),
          true,
        )
      }

      // ── 扫描地图 / Z 噪声底：两个子系统都还不在 ──────────────────────────
      sheet.missing('扫描地图可读', '扫描地图（`core/map_scope` + `io/exp_map` + `io/coarse_map`）', 'C 档，未分批')
      sheet.missing('Z 噪声底', '仪器档案（`core/instrument_profile`）', '批 5c')

      return sheet.result({ missing_skills: missing, tip_name: tipName })
    },
  }
}

export const TipConditioningSelfCheck = makeTipConditioningSelfCheck()

/**
 * 判据干跑用的合成晶格（三个 60° 方向的余弦和），与旧仓同一条公式。
 *
 * 振幅 10 pm、`nm_per_px = 5/256`、晶格常数 0.2494 nm（Au(111) 最近邻）。
 */
function syntheticLattice(n: number, nmPerPx: number): ReturnType<typeof matOf> {
  const k = (2 * Math.PI) / 0.2494
  const data = new Float64Array(n * n)
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      let s = 0
      for (const deg of [0.0, 60.0, 120.0]) {
        const r = (deg * Math.PI) / 180
        s += Math.cos(k * (x * nmPerPx * Math.cos(r) + y * nmPerPx * Math.sin(r)))
      }
      data[y * n + x] = (s / 3.0) * 10e-12
    }
  }
  return matOf(n, n, data)
}

/**
 * 反例：**一片没有晶格的噪声**。
 *
 * 旧仓用 `np.random.default_rng(0).normal(0, 2e-12, (n,n))`。本仓 `Pcg64` 只到
 * `uniform` —— numpy 的 `normal` 走 ziggurat（一张 256 格的表 + 拒绝采样），
 * 移它是另一件事，而**这里要的性质是「不是晶格」，不是「是高斯」**。
 * 所以用本仓自己的 `Xoshiro128`（种子固定 ⇒ 每次跑同一片噪声）叠 12 个均匀数
 * （Irwin–Hall，方差正好 1）当正态用。**不用真随机数**：一个每次都换一片噪声的
 * 自检，红了你不知道是判据坏了还是这次的噪声刚好像晶格。
 */
function syntheticNoise(n: number): ReturnType<typeof matOf> {
  const rng = new Xoshiro128(20260918)
  const data = new Float64Array(n * n)
  for (let i = 0; i < data.length; i += 1) {
    let s = 0
    for (let j = 0; j < 12; j += 1) s += rng.nextFloat()
    data[i] = (s - 6) * 2e-12
  }
  return matOf(n, n, data)
}

export function makeTipForgeSelfCheck(deps: SelfCheckDeps = {}): Skill {
  return {
    spec: S.TipForgeSelfCheckSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const sheet = new Sheet()
      const missing = await addSkillCoverage(sheet, FORGE_REQUIRED_SKILLS, deps)

      // ── 2. 衬底 → 判据期望值 ──────────────────────────────────────────────
      // 锻造流程最容易白跑的一环：不知道衬底就定不出表面态该在哪，而配方会扎十几次
      // 才发现判据无从建立。⚠️ 旧仓这一条是 `blocking=False` —— 而金样里那句
      // 「✅ 可以开工」正是这么来的（见抬头）。本仓依赖不在 ⇒ **blocking**。
      sheet.missing('衬底可解析', '样品事实（`core/sample_facts`）', 'C 档，未分批')

      // ── 3. 评估帧的像素尺度 ───────────────────────────────────────────────
      // 判不出原子相的帧不值得扫。这一项在开工前就能算，不需要硬件。
      // 阈值（0.02 / 0.05）住在判据模块里 —— 这里只消费 `scaleGate` 的判定，
      // 不自己比第二遍：两份阈值迟早会漂。
      const nmPerPx = ATOMIC_TIP_EVAL_FRAME_NM / ATOMIC_TIP_EVAL_PIXELS
      const scale = scaleGate(nmPerPx)
      sheet.add(
        '评估帧能分辨原子',
        scale === 'full',
        `${formatG(ATOMIC_TIP_EVAL_FRAME_NM, 6)} nm / ${ATOMIC_TIP_EVAL_PIXELS} px = ` +
          `${pyFixed(nmPerPx, 4)} nm/px（${scale === 'full' ? '满权重档' : `尺度门判为 ${String(scale)} —— 证据强度不足以当验收依据`}）`,
        scale !== 'full',
      )

      // ── 4. 表面态判据干跑 ─────────────────────────────────────────────────
      sheet.missing('表面态判据自测', '谱判据（`vision/spectroscopy`，954 行）', 'C 档，未分批')

      // ── 5. 原子相判据干跑（合成数据，不碰硬件） ───────────────────────────
      // 「判据模块坏了」应该在开工前暴露，而不是等真机上拿到一张图之后。
      const good = assessAtomicPhase(syntheticLattice(128, nmPerPx), { nmPerPx })
      const bad = assessAtomicPhase(syntheticNoise(128), { nmPerPx })
      const dryRunOk = good.passed && !bad.passed
      sheet.add(
        '原子相判据自测',
        dryRunOk,
        dryRunOk
          ? '合成晶格通过、纯噪声被拒'
          : `异常：晶格 passed=${String(good.passed)}（${good.reasons.join('/')}）、噪声 passed=${String(bad.passed)}`,
        true,
      )

      // ── 6. 扎针深度在针尖包络内 —— **这个自检存在的全部理由** ─────────────
      const facts = currentTipFacts()
      const depthM = -Math.abs(SPECTROSCOPY_TIP_POKE_DEPTH_NM) * 1e-9
      const plan = resolveConditioning(['poke_deep_depth_m'], { poke_deep_depth_m: depthM }, { facts })
      sheet.add(
        `${formatG(SPECTROSCOPY_TIP_POKE_DEPTH_NM, 6)} nm 浅扎在包络内`,
        plan.ok,
        plan.ok ? '允许' : plan.refusals.join('；'),
        true,
      )

      // ── 旧仓的第 6、7 项（电流监控豁免表 / 地图标记归类表）**不移** ───────
      // 两张表都照移很容易，但本仓既没有电流监控也没有实验地图。
      // **自检一张没人读的表，绿了也不代表任何事。**

      await addShaperProbe(sheet, ctx)

      const substrate = typeof params['substrate'] === 'string' ? params['substrate'] : ''
      return sheet.result({ missing_skills: missing, substrate })
    },
  }
}

export const TipForgeSelfCheck = makeTipForgeSelfCheck()

/** 这一批落地的四个技能。 */
export const TIP_CONDITIONING = {
  TipConditioningSelfCheck,
  TipForgeSelfCheck,
} as const
