/**
 * 判据②「表面起伏极大」的门 —— **只出观察，不出结论**。
 * 旧仓 `mast/vision/corrugation_gate.py`（259 行，**连 numpy 都没 import**）。
 *
 * ## 它回答的问题，以及它**不**回答的那个
 *
 * 现场对坏针的判据是「表面起伏极大**且**换位置扫依旧」—— 这是一个**合取**。
 * 本件只做前半句。后半句（是针还是表面）由跨点聚合回答。
 *
 * 所以词表里**没有 `bad_tip`**，而且这不是疏漏 —— **一片台阶簇会给出与坏针团簇
 * 同样高的 RMS，单帧分不开这两者**。
 *
 * ## 零第二真源：数不是这里算的
 *
 * `valuePm` 来自 `judgeFrame` 已经算好的 `corrugationRmsM`（逐行中值 + OLS 平面
 * + float32，再取 `std`）。本件**不自己去趋势、不自己取统计量** —— 同一个物理量的
 * 第二份实现迟早各自漂移，而且**同名不同预处理 = 不同的量**，阈值跨口径不可搬。
 *
 * ## 判定顺序不能换
 *
 * ```
 * 帧不可用 → 尺度不匹配 → 无阈值 → low → high → normal
 * ```
 *
 * 四个 `undecidable` 的成因必须能从 `reason` 里分辨，它们指向不同的下一步：
 * 换地方重扫 / 换视野重扫 / 去标定阈值。顺序本身是判据的一部分 ——
 * 「没有阈值」排在 `low` 之前，意味着阈值没标定时连「起伏太小所以弃权」都不说：
 * `low` 是**判据①**的弃权门，它不该在判据②未配置时替判据①发言。
 *
 * ## `low` 用的那个下限是**判据①那个对象**
 *
 * 旧仓刻意做成一个取值函数而不是本模块的常量：这里一旦写下 `15e-12`，
 * 仓里就有了第二个下限，而两个下限迟早不一样。
 *
 * 本仓没有 `line_check`，于是它成了一个**注入点**（{@link lowGate}）——
 * 同 D-VAC-1 / D-PRESET-2 / D-LOCKIN-2 那一族：旧仓从别处 import 的东西，
 * 本仓做成一个可注入的单一真源，默认值照抄，**而「默认是什么」写在这里**。
 *
 * ## 这个判据对什么瞎 —— **恒随返回值给出**
 *
 * `_detrend` 第一步减掉**逐行中值**，所以**行偏置型划痕**在进入任何下游判据之前
 * 就被删干净了。合取项本设计**不接**（真机 `_0032` 的划痕不在慢轴上、它没抓到；
 * 一次上两个未标定阈值出问题时分不清是谁的错）。所以每一份返回值都带着这句话。
 */
import { pyFixed } from './z-trace.js'
import { formatG } from './si.js'

/**
 * Python 的 `f"{x:.{d}%}"` —— 乘 100 再按 `.{d}f` 印。
 *
 * **不另写一份舍入**：`pyFixed` 是这一族的那一份（它现在住在 `z-trace.ts`，
 * 那个文件的抬头写着「收族的时候它该搬过去」）。这里只是一次乘法加一个百分号 ——
 * 一个 `%` 的格式化不值得成为第七个成员，而它要是自己实现一遍舍入，
 * 就正好是本仓「十份 `cell()`」那一课里第十一份。
 */
function pyPercent(x: number, d: number): string {
  return `${pyFixed(x * 100, d)}%`
}

/** 闭集词表。**不含 `bad_tip`** —— 见文件抬头第一节。 */
export const CORRUGATION_VERDICTS = ['high', 'normal', 'low', 'undecidable'] as const
export type CorrugationVerdictKind = (typeof CORRUGATION_VERDICTS)[number]

/** 本切片唯一的口径。数字必须**随口径一起**出现，否则那个数没有意义。 */
export const DETREND = 'ols'
export const STATISTIC = 'std'

/** 本判据测不到什么。**恒随返回值给出** —— 合取项本次不接，但缺口要说出来。 */
export const BLIND_TO =
  '对行偏置型划痕不敏感:去趋势(_detrend)第一步就减掉逐行中值,' +
  '行与行之间的整体高度差在进入本判据之前已被删干净。' +
  '要问「有没有慢轴划痕」得另配合取项(herringbone.slow_axis_power_ratio / ' +
  'stripe_snr),本设计没有接 —— 那是另一个缺口,不是本判据的答案。'

/** 所有 pm 单位阈值共同的口径声明。 */
export const Z_CAL_NOTE =
  '本机 z 压电标定未重标,实测偏低约 12.5%(已知高度的单原子台阶标称 235.4 pm,' +
  '本机读作 ~206 pm)。本阈值是**未重标定**口径下的数;z 重标之后所有 pm 阈值作废,' +
  '按比例缩放不算数,要重跑选型与标定。'

/**
 * `low` 档用的那个下限（米）—— **判据①弃权门的那一个数**。
 *
 * 默认 `15e-12`，与旧仓 `paper.line_check._DEFAULT_MIN_CORRUGATION_M` 逐字相同。
 * 做成可写字段而不是 `const`：等 `CheckLineQuality` 移进来时，两边要指向
 * **同一个**，而不是各自抄一份。
 */
export const lowGate = { m: 15e-12 }

/** 一帧的起伏观察。**这不是针尖结论。** */
export interface CorrugationVerdict {
  verdict: CorrugationVerdictKind
  /** 本口径下测出来的那个数（pm）。`null` **只在帧不可用时**。 */
  value_pm: number | null
  detrend: string
  statistic: string
  /** `judgeFrame` 给的那个米数，**恒上报** —— 拒判时它也有值，
   * 「测出来是零」和「没测」是两句话。 */
  corrugation_rms_m: number | null
  /** `null` ⇒ verdict 必为 `undecidable`。 */
  threshold_pm: number | null
  ref_scan_nm: number | null
  this_scan_nm: number | null
  rel_tol: number
  z_cal_note: string
  reason: string
  blind_to: string
  profile_name: string
  provenance: string
}

/** 能转成有限数就转，否则 `null`（「读不到」不是 0）。`true`/`false` 也算读不到。 */
function finite(x: unknown): number | null {
  if (x === null || x === undefined || typeof x === 'boolean') return null
  const v = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(v) ? v : null
}

/** `judgeFrame` 的产出里本件要读的那两个字段（不引 vision 包，避免反向依赖）。 */
export interface FrameUsability {
  readonly usable: boolean
  readonly reason: string
  readonly corrugationRmsM: number | null
}

/**
 * 这一帧的起伏算不算「极大」？
 *
 * `thresholdPm` / `refScanNm` 是**一组**：阈值离开它标定时的视野就没有意义。
 * 任何一个缺 ⇒ `undecidable`（判不了），**不是**「没有上限所以放行」。
 */
export function judgeCorrugation(
  verdict: FrameUsability,
  opts: {
    thresholdPm: number | null | undefined
    refScanNm: number | null | undefined
    thisScanNm: number | null | undefined
    relTol?: number | null
    profileName?: string
    provenance?: string
  },
): CorrugationVerdict {
  const usable = Boolean(verdict.usable)
  const rmsM = finite(verdict.corrugationRmsM)
  const thr = finite(opts.thresholdPm)
  const ref = finite(opts.refScanNm)
  const thisNm = finite(opts.thisScanNm)
  // `null` 当作没给（签名默认就是 0.05，没有信息丢失）。**负数照收** ——
  // 那会让尺度门永远不通过（全部 undecidable），而那是安全的一侧，
  // 而且 reason 里会原样印出「容差 ±-5%」，一眼看得出是谁传错了。
  const tolIn = finite(opts.relTol === undefined ? 0.05 : opts.relTol)
  const tol = tolIn === null ? 0.05 : tolIn

  const out = (kind: CorrugationVerdictKind, reason: string, valuePm: number | null): CorrugationVerdict => ({
    verdict: kind,
    value_pm: valuePm,
    detrend: DETREND,
    statistic: STATISTIC,
    corrugation_rms_m: rmsM,
    threshold_pm: thr,
    ref_scan_nm: ref,
    this_scan_nm: thisNm,
    rel_tol: tol,
    z_cal_note: Z_CAL_NOTE,
    reason,
    blind_to: BLIND_TO,
    profile_name: opts.profileName ?? '',
    provenance: opts.provenance ?? '',
  })

  // ── 1. 帧不可用 ──
  // 「判不了」与「判出来不好」是两句话：下游该换一块地方重扫，不是去修针尖。
  if (!usable || rmsM === null) {
    const why = verdict.reason !== '' ? verdict.reason : '这一帧不能拿来做针尖判定'
    return out('undecidable', `帧不可用,起伏判不了 —— ${why}`, null)
  }
  const valuePm = rmsM * 1e12

  // ── 2. 尺度不匹配 ──
  // 起伏 RMS 随视野变。**不换算、不外推** —— 归一化模型是发明。
  if (ref === null || ref <= 0) {
    if (thr === null) {
      // 两个都没填 = 这套阈值**整组没标定**。这句话指向「去标定」，
      // 而不是「去补一个视野声明」—— 判不了的每一种成因各指不同的路。
      return out(
        'undecidable',
        '判不了:起伏门没有标定 —— 上限(corrugation_high_pm)' +
          '与它的标定视野(corrugation_ref_scan_nm)都没填。' +
          '两个是一组,缺一个就判不了;这不是「没有上限所以都算正常」。',
        valuePm,
      )
    }
    return out(
      'undecidable',
      '判不了:没有声明这个阈值是在哪个视野上标的' +
        '(corrugation_ref_scan_nm 未填)。一个 pm 阈值离开它的视野就' +
        '没有意义,本判据不换算也不外推。',
      valuePm,
    )
  }
  if (thisNm === null || thisNm <= 0) {
    return out(
      'undecidable',
      `判不了:这一帧的视野读不出来,对不了账` + `(阈值是在 ${formatG(ref, 6)} nm 上标的)。读不到不等于对得上。`,
      valuePm,
    )
  }
  if (Math.abs(thisNm / ref - 1.0) > tol) {
    return out(
      'undecidable',
      `判不了:视野对不上 —— 这一帧 ${formatG(thisNm, 6)} nm,而阈值是在 ` +
        `${formatG(ref, 6)} nm 上标的(容差 ±${pyPercent(tol, 0)})。换一张同视野的再判;` +
        `本判据不做跨视野换算。`,
      valuePm,
    )
  }

  // ── 3. 没有阈值 ──
  // None = **判不了**，不是「没有上限」。排在 low 之前。
  if (thr === null) {
    return out(
      'undecidable',
      '判不了:没有起伏上限阈值(profile 的 corrugation_high_pm 未填)。' +
        'None = 判不了,不是「没有上限所以都算正常」。' +
        '要标它得先跑选型与标定程序。',
      valuePm,
    )
  }

  // ── 4. low：判据①的弃权门 ──
  const gateM = lowGate.m
  if (rmsM < gateM) {
    return out(
      'low',
      `起伏 ${pyFixed(valuePm, 1)} pm 低于弃权门 ${pyFixed(gateM * 1e12, 0)} pm —— ` +
        `没有形貌就没有可相关的信号,这一档**弃权**,` +
        `既不说针好也不说针坏(它是判据①的那道门,不是本判据的下限)。`,
      valuePm,
    )
  }

  // ── 5/6. high / normal ──
  if (valuePm > thr) {
    return out(
      'high',
      `起伏 ${pyFixed(valuePm, 1)} pm 高于上限 ${formatG(thr, 6)} pm` +
        `(视野 ${formatG(thisNm, 6)} nm,口径 ${DETREND}+${STATISTIC})。` +
        `⚠️ 这只是一个**观察**:一片台阶簇会给出同样高的起伏,` +
        `「是针还是表面」要靠换位置复测的跨点聚合来回答。`,
      valuePm,
    )
  }
  return out(
    'normal',
    `起伏 ${pyFixed(valuePm, 1)} pm 未超上限 ${formatG(thr, 6)} pm` +
      `(视野 ${formatG(thisNm, 6)} nm,口径 ${DETREND}+${STATISTIC})。`,
    valuePm,
  )
}

/**
 * `(thresholdPm, refScanNm, source)` —— 阈值和它的视野**同源**。
 *
 * * 两个都没显式给 ⇒ 走 profile 的那一对；
 * * 给了任何一个 ⇒ 用显式的那一对，**缺的那半留 `null`**（⇒ 判不了）。
 *   绝不用 profile 去补另一半：那会把两次不同标定的数拼成一个判据。
 *
 * ⚠️ 这个函数是「没传 `threshold_pm` 时到底查不查 profile」的那一行。
 * `threshold_pm` 一旦有了 schema 默认值，`explicitPm` 就永远不是 `null`，
 * 下面那个分支永远到不了 —— 本仓第三次记这个形状（6.2.13 发出去之后真机针尖速度
 * 恒为兜底值，查了一整轮才发现是一个 `default=0.1`）。
 */
export function resolveThresholdPair(
  explicitPm: number | null | undefined,
  explicitRefNm: number | null | undefined,
  thresholds: { name?: string; corrugationHighPm?: number | null; corrugationRefScanNm?: number | null },
): { thresholdPm: number | null; refScanNm: number | null; source: string } {
  if ((explicitPm === null || explicitPm === undefined) && (explicitRefNm === null || explicitRefNm === undefined)) {
    return {
      thresholdPm: thresholds.corrugationHighPm ?? null,
      refScanNm: thresholds.corrugationRefScanNm ?? null,
      source: `profile:${thresholds.name !== undefined && thresholds.name !== '' ? thresholds.name : '?'}`,
    }
  }
  return {
    thresholdPm: explicitPm === null || explicitPm === undefined ? null : Number(explicitPm),
    refScanNm: explicitRefNm === null || explicitRefNm === undefined ? null : Number(explicitRefNm),
    source: 'explicit',
  }
}
