/**
 * `AssessAtomicPhase` —— 一帧扫描图上有没有原子相（旧仓 `builtins/tip_spectro_assess.py`）。
 *
 * **这一层只做 IO、阈值取用与一道覆盖率门，一个判据都不写**：判据本体是
 * `dsh-spm-vision` 的 `assessAtomicPhase`（批 4b 已落，`atomic-phase.ts` 632 行），
 * 它的 `AtomicPhaseResult` 与旧仓 `tip_spectro_assess.py:419-435` 消费的字段逐个对上。
 *
 * ## 三态，不是两态（旧仓模块抬头的原话，照移）
 *
 * 只要文件读得动就**永远 `success: true`**：判据的结论在 `data.passed` 与
 * `data.reasons` 里。技能失败留给「这件事没做成」—— 文件不存在、通道缺失、依赖缺席。
 * 把「判据没通过」表达成技能失败，会让 composite 的 `optional=False` 步骤
 * 直接中止整条流程，而「针尖还不够好」恰恰是流程要处理的正常情况。
 *
 * ## 覆盖率门 `MIN_COVERAGE = 0.5` —— 这一层唯一自己判的东西
 *
 * 扫了几行就停的帧，缺的那部分是 NaN；判据在做谱之前会把它当成常数，
 * 于是谱上多出一堆**与扫描无关**的结构。旧仓观测的一次残帧样本只有 2% 的
 * 像素有数据，判据报 `passed=True`、角向集中度 94（同批完整帧 4356）。
 * 这会产生「针尖很好」的误判，而该样本其实几乎没有有效扫描数据。
 *
 * 判据本体是纯函数，让它去猜「几成算完整」不合适 —— 所以门做在**技能层**。
 *
 * ## 与孪生技能 `AssessAtomicResolution`（批 4b）**刻意不同**的两处
 *
 * | | `AssessAtomicResolution` | 这一个 |
 * |---|---|---|
 * | 指名通道拿不到 | 报错退出 | **回落到文件里的第一个通道**（`tip_spectro_assess.py:361`） |
 * | 帧的取用 | 走 `sxmOrientedFrames`（反扫去镜像、按 `SCAN_DIR` 翻正） | **原样取 `forward`**，一次几何归位都不做 |
 *
 * 两条都不是笔误，两条都照移：统一成一种会让金样里有格对不上，
 * 而对不上的那一格正是模型读的那一句。
 *
 * ## 衬底：`resolve_substrate` 是**注入口**，不是缺口
 *
 * 见 {@link substrateFacts}。
 */
import { existsSync } from 'node:fs'
import { formatG, pyFixed, type Skill, type SkillContext, type SkillResultLike } from 'dsh-spm-kernel'
import { type Mat } from 'dsh-spm-numerics'
import { assessAtomicPhase, parseXyMeta } from 'dsh-spm-vision'
import * as S from '../generated/specs.js'
import { loadSxm, numParam, strParam } from './analysis-common.js'

/**
 * 低于这个有效像素比例就判「这一帧回答不了」。
 *
 * 0.5 **不是标定出来的阈值** —— 它只用来区分「扫完了」和「扫了个开头」：
 * 旧仓观测中的残帧是 2% 和 25%，完整帧是 100%，中间没有东西。
 */
export const MIN_COVERAGE = 0.5

/**
 * 旧仓 `sample_facts.py:51 _ROW_SPACING_FACTOR` —— **先算 √3/2，再乘**。
 *
 * ⚠️ 这与 `dsh-spm-vision` 的 `firstOrderPeriodNm` 不是同一个算式，而那不是笔误：
 * 旧仓两处各写各的，乘法的结合顺序不同 ——
 * `sample_facts.py:196` 是 `nn_nm * (√3/2)`，`lattice_calibration.py:88` 是
 * `a * √3 / 2`。Pt(111) 上两者差 **1 ulp**。
 */
const ROW_SPACING_FACTOR = Math.sqrt(3.0) / 2.0

/**
 * 旧仓知识库里 `clean_metal` 那张表的**最近邻距离（埃）**。
 *
 * ## 为什么不用 `SURFACE_LATTICE_NM`（本仓已有的那张七个面的表）
 *
 * 实测（金样 `resolve_substrate` 那一节，十格）：旧仓的 `resolve_substrate`
 * 只认得**四个洁净金属面**。`SURFACE_LATTICE_NM` 里的另三个 ——
 * `HOPG` / `NaCl(100)` / `Si(111)-1x1` —— 旧仓一律报 `available=false`。
 * 拿那张表去当衬底知识库，会让三个面**凭空变得「知道」**，
 * 而知道之后走的是完全不同的一条路（做晶格常数比对而不是跳过它）。
 *
 * 两张表在旧仓里本来就是两张：一张在 `vision/lattice_calibration`（FFT 一阶峰
 * 用的几何常数），一张在知识库（样品事实）。合成一张不是消除重复，是**把两个
 * 不同的问题合成一个**。
 *
 * ## 为什么存**埃**
 *
 * 旧仓 `sample_facts.py:184-185` 读的是 `nearest_neighbor_ang`，再 `/10.0`。
 * 存 nm 的话 Pt(111) 会差一个 ulp（`2.775/10 = 0.27749999999999997 ≠ 0.2775`）——
 * 而它是晶格常数比对的**入口**。四个面这么写之后，与旧仓**逐位相同**。
 */
const CLEAN_METAL_NN_ANG: Readonly<Record<string, number>> = {
  'Au(111)': 2.884,
  'Ag(111)': 2.889,
  'Cu(111)': 2.556,
  'Pt(111)': 2.775,
}

/** 旧仓 `core.sample_facts.SubstrateFacts` 里这个技能真正用得到的那几项。 */
export interface SubstrateFacts {
  readonly available: boolean
  readonly material: string | null
  readonly source: string
  readonly rowSpacingNm: number | null
}

/**
 * 衬底事实的**注入口**（默认只认表面名，不认「当前样品」）。
 *
 * 旧仓 `resolve_substrate(None)` 走
 * `get_active_log() → current_sample_id → storage.get_sample()`，
 * 也就是**问实验记录「台面上现在放的是什么」**。本仓没有那本记录，
 * 所以这一路是一个注入点，**而默认是关的** —— 默认走「不知道」那条路，
 * 与旧仓在没有样品记录时完全一致。同
 * `analysis-clusters.ts:612 substrateTolerance`（那一条是同一个形状的第一次）。
 *
 * ⚠️ **「不知道」不等于「Au(111)」**（旧仓 `sample_facts.py` 抬头的原话）：
 * 在 Ag(111) 上按 Au 的常数找判据会一直不过，而流程会把这个误读成「针尖不行」，
 * 反复去修一根其实没问题的针。
 *
 * 它的降级是**诚实拒绝**：拿不到衬底时只是**不做**晶格常数那一项比对，
 * 其余三条判据照跑 —— 旧仓注释明写「0 或推断不出来时只是不做这一项比对，
 * **不算失败**」。
 */
export const substrateFacts: { currentSample: (() => string | null) | null } = {
  currentSample: null,
}

/** 表面名 → 事实。`explicit` 与 `unknown` 两个来源，同旧仓 `source` 字段。 */
export function resolveSubstrate(name: string | null): SubstrateFacts {
  let material = name
  let source = 'explicit'
  if (material === null || material === '') {
    source = 'unknown'
    material = null
    const src = substrateFacts.currentSample
    if (src !== null) {
      try {
        material = src()
      } catch {
        /* 拿不到就当没有 —— 同旧仓那条 fail-soft（读不到样品记录不抛，报「不知道」） */
        material = null
      }
      if (material !== null && material !== '') source = 'sample_record'
      else material = null
    }
  }
  if (material === null) return { available: false, material: null, source, rowSpacingNm: null }
  // ⚠️ **只认精确名。** 旧仓在精确查不中时还有一趟模糊匹配（`match_material`），
  // 但它只接受 `type_id == "clean_metal"` 的结果 —— 因为实测
  // `match_material("au111")` 返回的是 `MoS2_on_Au111`（一个长在 Au(111) 上的
  // 二硫化钼样品），拿它的常数当衬底判据是错的。本仓没有那张 30570 行的知识库，
  // 所以那一趟**整条不在**：认不出就是认不出。见 deviations。
  const ang = CLEAN_METAL_NN_ANG[material]
  if (ang === undefined) return { available: false, material: null, source, rowSpacingNm: null }
  // 旧仓 `sample_facts.py:184-196`：埃 → nm → ×√3/2。三步的顺序都照着写，
  // 因为 Pt(111) 在第一步与第三步上各差一个 ulp（见上面两段注释）。
  //
  // fcc(111) 面上量到的是**原子行**的间距，不是最近邻距离 —— 两者差 15.5%，
  // 而典型的压电偏差是 10%：错了会得到一个看起来很合理的错数。
  // （四个 `clean_metal` 全是 fcc(111)，所以这里没有 `SQUARE_SURFACES` 那一支。）
  return { available: true, material, source, rowSpacingNm: (ang / 10.0) * ROW_SPACING_FACTOR }
}

/** 有效像素比例。`res.size == 0` 时旧仓给 0.0（`if arr.size else 0.0`）。 */
function coverageOf(m: Mat): number {
  if (m.data.length === 0) return 0
  let n = 0
  for (let i = 0; i < m.data.length; i += 1) if (Number.isFinite(m.data[i] as number)) n += 1
  return n / m.data.length
}

/**
 * 旧仓 `:406-410` 写好的那句话 —— **逐字**。
 *
 * 它在旧仓里**发不出来**（见 {@link AssessAtomicPhase} 抬头的 D-EXTRA-SPLIT）。
 * 这里不是新写一句，是把那一段接回它本来要去的地方。
 */
export function incompleteWarning(coverage: number): string {
  return (
    `只有 ${pyFixed(coverage * 100, 0)}% 的像素有数据 —— 这一帧**判不了**原子分辨。` +
    '缺的部分在做谱之前会被当成常数，谱上因此多出与扫描无关的结构。' +
    '**不要把这个结果读成「针尖不好」**，它说的是这一帧没扫完。'
  )
}

export const AssessAtomicPhase: Skill = {
  spec: S.AssessAtomicPhaseSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const path = String(params['scan_path'] ?? '')
    const channelName = strParam(params, 'channel', 'Z')
    // ⚠️ `Path("")` 在 Python 里等价于 `Path(".")`，而当前目录**是存在的** ——
    // 所以空串**不走**「文件不存在」那一支，它掉进下面 `readSxm` 的 OSError。
    // 这是从旧仓实跑出来的（金样 `empty_path`），不是读代码读出来的，
    // 而模型读的正是这两句里的一句。
    if (!(path === '' ? existsSync('.') : existsSync(path))) {
      return { success: false, error: `文件不存在: ${path}` }
    }

    // 第二个参数是**报错时的名字**：旧仓 `read_sxm` 把路径写进那句话里
    // （`Cannot find header end marker in <路径>`），而模型读的正是这一句。
    const load = loadSxm(path, path)
    if (!load.ok) return { success: false, error: `.sxm 读取失败: ${load.plain}` }
    const scan = load.scan

    // 原样取通道：指名的拿不到就**取第一个**（不是报错 —— 见抬头那张表）。
    const channels = scan.channels ?? {}
    const ch = channels[channelName] ?? Object.values(channels)[0]
    if (ch === undefined) {
      return { success: false, error: `文件里没有可用通道(要的是 '${channelName}')` }
    }
    const arr: Mat | undefined = ch.forward ?? ch.backward
    if (arr === undefined) return { success: false, error: '通道里没有正扫/反扫数据' }

    // ── 期望晶格常数的三态 ──────────────────────────────────────────────
    // 旧仓注释：「期望晶格常数是可选的：0 或推断不出来时只是不做这一项比对，**不算失败**」。
    //   给了正数 ⇒ 用它，衬底照样解（结果里要留来源痕迹）
    //   给了 0    ⇒ 关掉这项比对，衬底照样解
    //   不给      ⇒ 从衬底取（取不到就是 null，照样不算失败）
    const rawExpected = numParam(params, 'expected_a_nm')
    const substrateArg = strParam(params, 'substrate', '')
    const facts = resolveSubstrate(substrateArg === '' ? null : substrateArg)
    let expectedA: number | null = null
    if (rawExpected !== null && rawExpected > 0) expectedA = rawExpected
    else if (rawExpected === null) expectedA = facts.rowSpacingNm

    let nmPerPx: number | null = null
    const meta = parseXyMeta(scan.header as Readonly<Record<string, unknown>>)
    if (meta !== null && arr.cols > 0) nmPerPx = (meta.w / arr.cols) * 1e9

    const coverage = coverageOf(arr)
    const cmin = numParam(params, 'concentration_min')
    const res = assessAtomicPhase(arr, {
      nmPerPx,
      expectedANm: expectedA,
      snrMin: numParam(params, 'snr_min') ?? 4.0,
      ...(cmin === null ? {} : { concentrationMin: cmin }),
      sharpnessMin: numParam(params, 'sharpness_min') ?? 8.0,
      allowReducedScale: Boolean(params['allow_reduced_scale'] ?? false),
    })

    const incomplete = coverage < MIN_COVERAGE
    const passed = res.passed && !incomplete
    // ── D-EXTRA-SPLIT：`extra_reasons` / `extra_warnings` 在旧仓被拆散了 ──
    // 它们在 `AssessAtomicPhase.execute:405-410` **赋值而不使用**，
    // 在 `AssessShockleyOnset.execute:236-237` **使用而未赋值**（那一侧每条成功
    // 路径都 `NameError`）。同一次重构的两半落进了两个类 —— 这一侧丢了话，
    // 那一侧炸了。**不照抄**（DoD ⑤）：接回来，登记在 deviations。
    const extraReasons = incomplete ? ['incomplete_frame'] : []
    const extraWarnings = incomplete ? [incompleteWarning(coverage)] : []

    const data: Record<string, unknown> = {
      scan_path: path,
      coverage,
      incomplete_frame: incomplete,
      passed,
      passed_before_coverage_gate: res.passed,
      scale: res.scale,
      nm_per_px: res.nmPerPx,
      period_nm: res.periodNm,
      period_fast_axis_nm: res.periodFastAxisNm,
      snr: res.snr,
      angular_concentration: res.angularConcentration,
      order_ratio: res.orderRatio,
      fft_sharpness: res.fftSharpness,
      expected_a_nm: res.expectedANm,
      slow_axis_trusted: res.slowAxisTrusted,
      // 帧内前后两半各自的角向集中度（按**扫描顺序**切）。透传出去，调用方才判得了
      // 「这一帧算不算数」—— 旧仓观测中整帧 136.2「过」，而两半是
      // 5731.9 / 17.0，针尖在半帧处变了；发证方拿不到这两个数，就只能发一张
      // 说过去式的证书。
      half_concentrations: res.halfConcentrations === null ? null : [...res.halfConcentrations],
      reasons: [...res.reasons, ...extraReasons],
      warnings: [...res.warnings, ...extraWarnings],
      substrate: facts.material,
      substrate_source: facts.source,
      substrate_available: facts.available,
    }

    let summary: string
    if (incomplete) {
      // D-EXTRA-SPLIT 的第二半。旧仓这里分支在 `res.passed` 上（**不是**门后的
      // `passed`），于是一帧被门判成「判不了」的图，summary 照样说「有原子相」——
      // 同一个回包里，模型读的那一句和机器读的那一格互相矛盾。
      // 用的仍是旧仓自己写好的那句话（`:406-410`），一个字都没有新造。
      summary = extraWarnings[0] as string
    } else if (res.passed) {
      const per = res.periodFastAxisNm
      summary = per ? `有原子相：快扫方向周期 ${pyFixed(per, 3)} nm` : '有原子相'
      summary +=
        `，角向集中度 ${pyFixed(res.angularConcentration, 0)}` +
        `（阈值 ${formatG(cmin ?? 20.0, 6)}）。`
    } else if (res.reasons.includes('scale_gate')) {
      summary =
        `这一帧 ${pyFixed(res.nmPerPx ?? 0, 4)} nm/px 太粗，判不了原子相 —— ` +
        '这不等于「没有原子相」。换更小的视野或更多像素再看。'
    } else {
      summary = `没有原子相（${res.reasons.join(', ')}）`
    }
    return { success: true, data, summary }
  },
}

/** `builtins.tip_spectro_assess` 这一批落了的那些（2 个里的 1 个）。 */
export const TIP_SPECTRO_ASSESS: Readonly<Record<string, Skill>> = {
  AssessAtomicPhase,
}
