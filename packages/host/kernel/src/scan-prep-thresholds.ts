/**
 * 扫描图预处理阈值的 profile —— 旧仓 `mast/vision/scan_prep_thresholds.py` 的
 * `PROFILES` + `resolve`。
 *
 * ## 消融：批 4a 只移了**两个字段**，批 6b 把其余的**带着消费方**补上了
 *
 * 批 4a 的原话是「本批唯一的消费方是 `AssessFrameCorrugation`，它只读
 * `name` / `provenance` / `corrugation_high_pm` / `corrugation_ref_scan_nm` ……
 * 真要用的时候照着旧仓那份 docstring 补，**那时它们会带着自己的消费方一起来**」。
 *
 * 这一刻到了：`AnalyzeScanImage` / `AutoProcessScanBatch` 的判据链
 * （`vision/scan-prep.ts` 的 `measureFrame` / `planFor` / `harmoniseBatch`）
 * 逐条读 `lineGain` / `bowGain` / `stepPurity` / `stepPeaks` / `stepSep` /
 * `finePeriodicSnr` / 周期带 / `axisGuardDeg` / `rowcorrPoor` / `nanAnnotate` /
 * `badRowFracAnnotate` / `fbInstabilityMax` / `groupMin` / 三组色阶百分位。
 * 于是这 20 个**每一个都有消费方**，消融精神没有被违反 —— 违反它的是反过来
 * 只移一半，那时 `planFor` 只能把阈值写死在代码里，而写死的阈值没有 `provenance`。
 *
 * **仍然没有移的**：`KNOB_LABELS`（设置 UI 的中文标签）与
 * `CALIBRATABLE_FROM_DISTRIBUTION`（标定工具的分组）—— 本仓既没有设置 UI 也没有
 * `scan_prep_commission`，那两张表在这里一个读者都没有。
 *
 * ## 越界：**既有字段夹紧，可空字段丢弃 + 说明**（两种并存，是有意的）
 *
 * 旧仓 `from_mapping` 的注释逐字：可空字段是判据阈值，「夹紧会把一个越界的阈值
 * 静默改成边界值，而调用方以为自己设的是原值；对一个 `None` = 判不了的字段来说，
 * 那等于**凭空造出一个从没标定过的判据**」。既有字段的夹紧是历史行为，
 * **没有跟着改** —— 那是另一个决定，要单独论证。照移。
 *
 * ## 出厂**就是「判不了」**，这一条是判据不是疏漏
 *
 * 内建 profile 的 `corrugationHighPm` / `corrugationRefScanNm` 都是 `null`：
 * 起伏门**没有标定过**。于是 `judgeCorrugation` 开箱即 `undecidable`，
 * 而它的 `reason` 会说清「上限与它的标定视野都没填 …… 这不是『没有上限所以都算正常』」。
 *
 * 那两个数是**一组**：一个 pm 阈值离开它标定时的视野就没有意义
 * （同一根针的边缘宽度在 100 nm 上 2.6 nm、200 nm 上 5.5 nm）。
 *
 * ## 外部 profile 文件 → **注入**（同 D-VAC-1 / D-PRESET-2 / D-LOCKIN-2）
 *
 * 旧仓从 `project_root()/config/scan_prep_profiles.json` 读，读不动就当没有。
 * 本仓零 I/O，于是外部 profile 成了 {@link scanPrepProfiles}`.external` 这张表，
 * 由宿主填。**同名覆盖内建**，与旧仓同。
 *
 * ## 名字不认识时**回落到默认并在 provenance 里说清楚**
 *
 * 静默用一套别的阈值算完再报一个数，是最难查的那种错。
 */

/** 内建 profile 的名字。 */
export const DEFAULT_SCAN_PREP_PROFILE = 'reference-surface-v1'

/**
 * 一套阈值的不可变快照。
 *
 * 字段分两类，**标定方式完全不同**（旧仓 docstring 逐字）：
 *
 * * **随样品漂移的**（`stepSep` / `rowcorrPoor` / `finePeriodicSnr` / `nanAnnotate`）：
 *   合适取值取决于这块样品长什么样、这台机器有多吵，换体系必须重看分布；
 * * **不随样品漂移的**（`lineGain` / `bowGain` / `stepPurity`）：它们是关于
 *   *模型选择* 与 *几何* 的陈述。「逐行平场把残差压掉 30% 以上才值得用」与
 *   「真台阶横跨画面所以大多数行同时含两个高度」在任何样品上都成立。
 *   **改这几个数要的是一个论证，不是一份分布。**
 */
export interface ScanPrepThresholds {
  readonly name: string
  readonly provenance: string

  // ── 模型选择（不随样品漂移） ──
  /** `std(扣平面残差) / std(逐行一阶平场残差)`。按构造 ≥1；> 此值才逐行平场。 */
  readonly lineGain: number
  /** `std(扣平面残差) / std(扣二阶曲面残差)`。> 此值说明面是弯的。 */
  readonly bowGain: number
  /**
   * 两个高度能级中「整行落在同一侧」的行占比。> 此值 = **行向分层**
   * （针尖突变 / z 漂移），**不是**台阶，不该被保护。
   * 真台阶斜跨画面，实测 0.14 / 0.19；行向分层实测 0.91。
   */
  readonly stepPurity: number

  // ── 表面形貌（随样品漂移） ──
  /** 高度直方图里算作「有能级」的峰数下限。 */
  readonly stepPeaks: number
  /** 峰间距 / 像素级粗糙度。台阶密集的样品上这个值要重标。 */
  readonly stepSep: number

  // ── 精细周期结构（随样品 / 放大倍率漂移） ──
  /**
   * 受限带 FFT 峰对局部环背景的信噪比。**只用来决定色阶**，
   * 不产出「有没有晶格」的结论 —— 那个结论来自 `assessAtomicPhase`。
   */
  readonly finePeriodicSnr: number
  /** 可信周期带下限（nm）。 */
  readonly finePeriodMinNm: number
  /** 可信周期带上限（nm）。 */
  readonly finePeriodMaxNm: number
  /**
   * FFT 里两条扫描轴附近的死区半角（度）。扫描线噪声与逐行平场都在轴上留下强脊，
   * ±12° 时 #0007 的条纹伪影仍报出 SNR 29.7 的假峰；±20° 后降到 3.8，真峰不受影响。
   */
  readonly axisGuardDeg: number

  // ── 帧质量标注（随机器漂移） ──
  /** 相邻行相关的中位数低于此值 ⇒ 标注「噪声帧」。 */
  readonly rowcorrPoor: number
  /** NaN 像素占比高于此值 ⇒ 标注「扫描未完成」。 */
  readonly nanAnnotate: number
  /** 坏行占比高于此值 ⇒ 标注。取自 `detectScanArtifacts`。 */
  readonly badRowFracAnnotate: number
  /**
   * 正反扫**不稳定度**上限（= 1 − 允许横向位移的最大归一化互相关）。
   * ⚠️ 与 sxm_auto 的 `fb_corr` **方向相反**：那边「相关 > 0.5 算一致」，
   * 这边「不稳定度 < 0.5 算一致」，且这边补偿了压电迟滞的快轴偏移。
   */
  readonly fbInstabilityMax: number

  // ── 批次一致性 ──
  /** 同（视野, 偏压）组内至少这么多张才做多数票。 */
  readonly groupMin: number

  // ── 色阶（百分位） ──
  readonly clipLatticeLo: number
  readonly clipLatticeHi: number
  readonly clipStepLo: number
  readonly clipStepHi: number
  readonly clipDefaultLo: number
  readonly clipDefaultHi: number

  // ── 起伏门（**出厂就是「判不了」**） ──
  /** 起伏上限（pm）。`null` = **判不了**，不是「没有上限所以都算正常」。 */
  readonly corrugationHighPm: number | null
  /** 上面那个阈值是在多大的视野上标的（nm）。`null` = 没声明 ⇒ 判不了。 */
  readonly corrugationRefScanNm: number | null
}

/** 非数值字段 —— 夹紧 / 标定一律跳过。 */
export const SCAN_PREP_META_FIELDS: readonly string[] = ['name', 'provenance']

/**
 * 可空数值字段：`null` = **判不了**（不是 0，也不是「没有限制」）。
 * 越界**丢弃**（不夹紧），见文件抬头。
 */
export const SCAN_PREP_NULLABLE_FIELDS: readonly string[] = ['corrugationHighPm', 'corrugationRefScanNm']

/**
 * 每个数值 knob 的合法区间。
 *
 * 下界不是「最小可测值」而是「**小于它这条判据就失效**」：`lineGain` / `bowGain`
 * 按构造 ≥1，设成 <1 等于「永远触发」。
 * 可空那两行是**拒绝线**不是夹紧线：0.1 pm 远在任何真实噪声底以下
 * （真机同帧行内差分 MAD 给 3 pm），0.1 nm 的视野连一个原子都装不下。
 */
export const SCAN_PREP_FIELD_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  lineGain: [1.0, 10.0],
  bowGain: [1.0, 10.0],
  stepPurity: [0.0, 1.0],
  stepPeaks: [2.0, 16.0],
  stepSep: [1.0, 100.0],
  finePeriodicSnr: [1.0, 1000.0],
  finePeriodMinNm: [0.05, 5.0],
  finePeriodMaxNm: [0.1, 50.0],
  axisGuardDeg: [0.0, 44.0],
  rowcorrPoor: [0.0, 1.0],
  nanAnnotate: [0.0, 1.0],
  badRowFracAnnotate: [0.0, 1.0],
  fbInstabilityMax: [0.0, 1.0],
  groupMin: [2.0, 100.0],
  clipLatticeLo: [0.0, 49.0],
  clipLatticeHi: [51.0, 100.0],
  clipStepLo: [0.0, 49.0],
  clipStepHi: [51.0, 100.0],
  clipDefaultLo: [0.0, 49.0],
  clipDefaultHi: [51.0, 100.0],
  corrugationHighPm: [0.1, 1e6],
  corrugationRefScanNm: [0.1, 1e5],
}

/** 旧仓 `ScanPrepThresholds()` 的字段缺省值（`name` / `provenance` 由 profile 覆写）。 */
export const SCAN_PREP_DEFAULTS: ScanPrepThresholds = {
  name: '',
  provenance: '未标定',
  lineGain: 1.3,
  bowGain: 1.15,
  stepPurity: 0.7,
  stepPeaks: 2.0,
  stepSep: 3.0,
  finePeriodicSnr: 15.0,
  finePeriodMinNm: 0.15,
  finePeriodMaxNm: 1.6,
  axisGuardDeg: 20.0,
  rowcorrPoor: 0.3,
  nanAnnotate: 0.005,
  badRowFracAnnotate: 0.0,
  fbInstabilityMax: 0.5,
  groupMin: 3.0,
  clipLatticeLo: 2.0,
  clipLatticeHi: 98.0,
  clipStepLo: 0.1,
  clipStepHi: 99.9,
  clipDefaultLo: 1.0,
  clipDefaultHi: 99.0,
  corrugationHighPm: null,
  corrugationRefScanNm: null,
}

/** `ScanPrepThresholds` 的部分覆盖（旧仓那份 JSON 的 `thresholds` 块）。 */
export type ScanPrepProfilePatch = Partial<ScanPrepThresholds> & { readonly provenance: string }

const BUILTIN: Readonly<Record<string, ScanPrepThresholds>> = {
  [DEFAULT_SCAN_PREP_PROFILE]: {
    ...SCAN_PREP_DEFAULTS,
    name: DEFAULT_SCAN_PREP_PROFILE,
    provenance:
      '阈值来自参考系统上一组台阶稀疏、单一畴表面的观测，尚未在本仓独立验证。' +
      '换到台阶密集或噪声特性不同的体系时，step_sep 等随样品漂移的字段必须重新标定；' +
      '先检查目标数据分布再定。',
  },
}

/**
 * 进程级的 profile 表。`external` 由宿主填（旧仓那份 JSON 的位置），
 * `active` 是当前生效的名字。
 *
 * 表里放的是**部分覆盖**，与旧仓 JSON 的 `{base, thresholds}` 同一条口径：
 * 没写的字段继承内建默认，写了的按 {@link scanPrepFromMapping} 的规矩进来。
 */
export const scanPrepProfiles: {
  external: Record<string, ScanPrepProfilePatch>
  active: string
} = { external: {}, active: DEFAULT_SCAN_PREP_PROFILE }

/**
 * 从一份（部分）映射造一套阈值 —— 旧仓 `ScanPrepThresholds.from_mapping`。
 *
 * 未知键忽略；缺失键回落到 `base`；**两种越界处理并存**（见文件抬头）：
 * 既有数值字段**夹紧**，{@link SCAN_PREP_NULLABLE_FIELDS} **丢弃**且 `null` 保持 `null`。
 *
 * 丢弃的那一支会往 `dropped` 里记一行 —— 旧仓那里是一条 `logger.warning`，
 * 本仓零 I/O，所以把它交出来由调用方处置。**静默丢弃与夹紧一样看不出来。**
 */
export function scanPrepFromMapping(
  m: Readonly<Record<string, unknown>> | null | undefined,
  base: ScanPrepThresholds = SCAN_PREP_DEFAULTS,
): { th: ScanPrepThresholds; dropped: string[] } {
  const dropped: string[] = []
  if (m === null || m === undefined) return { th: base, dropped }
  const out: Record<string, unknown> = { ...base }
  for (const [rawKey, v] of Object.entries(m)) {
    // 两种写法都收：本仓内部用 camelCase，而旧仓那份 JSON（与它的每一份标定报告）
    // 用的是 snake_case。**一个只认一种写法的读取器，会把另一种写法的整份 profile
    // 静默当成「没配」** —— 而那正是 `provenance` 存在的理由的反面。
    const k = rawKey.replace(/_([a-z])/g, (_s, c: string) => c.toUpperCase())
    if (!(k in SCAN_PREP_DEFAULTS)) continue
    if (SCAN_PREP_META_FIELDS.includes(k)) {
      if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
      continue
    }
    const nullable = SCAN_PREP_NULLABLE_FIELDS.includes(k)
    if (nullable && v === null) {
      // 显式 null =「这个 profile 不声明这个口径」= 判不了。保留它（而不是继承
      // base 的值），因为「判不了」是保守的一侧。
      out[k] = null
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (nullable) dropped.push(`${k}=${String(v)} 不是数值,丢弃`)
      continue
    }
    const bounds = SCAN_PREP_FIELD_BOUNDS[k]
    const lo = bounds === undefined ? -Infinity : bounds[0]
    const hi = bounds === undefined ? Infinity : bounds[1]
    if (nullable) {
      if (!(lo <= v && v <= hi)) {
        dropped.push(`${k}=${v} 超出 [${lo}, ${hi}],丢弃(**不夹紧**) —— 判据阈值夹紧了就看不出兜底发生过`)
        continue
      }
      out[k] = v
      continue
    }
    out[k] = Math.min(hi, Math.max(lo, v))
  }
  return { th: out as unknown as ScanPrepThresholds, dropped }
}

/**
 * 只要**有值的**数值字段 —— 旧仓 `numeric_mapping()`。
 *
 * 可空字段没填时**整个键不出现**，而不是给一个 0：「没标定」与「标成 0」是两件事，
 * 而下游拿到的是 `%g` 这种格式化 —— 一个 `null` 会当场炸，一个 0 会**看不出来**。
 *
 * ⚠️ **键名是 snake_case**（`line_gain` 而不是 `lineGain`）。
 * 这不是风格：它唯一的消费方是 `AutoProcessScanBatch` 报告末尾那行
 * 「判据阈值:…」，那些键**印在给人看的报告里**，而报告是要跟旧仓那份对得上的。
 */
export function scanPrepNumericMapping(th: ScanPrepThresholds): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(th)) {
    if (SCAN_PREP_META_FIELDS.includes(k)) continue
    if (typeof v === 'number') out[snakeCase(k)] = v
  }
  return out
}

/** `lineGain` → `line_gain`。 */
function snakeCase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/** 内建 + 外部（外部同名按 {@link scanPrepFromMapping} 盖在内建默认上）。 */
function merged(): Record<string, ScanPrepThresholds> {
  const out: Record<string, ScanPrepThresholds> = { ...BUILTIN }
  for (const [name, patch] of Object.entries(scanPrepProfiles.external)) {
    const base = BUILTIN[name] ?? { ...SCAN_PREP_DEFAULTS, name }
    out[name] = { ...scanPrepFromMapping(patch as Record<string, unknown>, base).th, name }
  }
  return out
}

/** `{profile 名: provenance}`。 */
export function availableScanPrepProfiles(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [n, t] of Object.entries(merged())) out[n] = t.provenance
  return out
}

/**
 * 取一套阈值。`profile` 为空 ⇒ 当前激活的那个。
 *
 * 名字不认识时**回落到默认，并把这件事写进 `provenance`** —— 见文件抬头。
 */
export function resolveScanPrepThresholds(profile?: string | null): ScanPrepThresholds {
  const table = merged()
  const name = (profile !== null && profile !== undefined && profile !== '' ? profile : scanPrepProfiles.active).trim()
  const hit = table[name]
  if (hit !== undefined) return hit
  const fallback = table[DEFAULT_SCAN_PREP_PROFILE] ?? SCAN_PREP_DEFAULTS
  return {
    ...fallback,
    name: DEFAULT_SCAN_PREP_PROFILE,
    provenance: `(请求的 profile '${name}' 不存在,已回落到 ${DEFAULT_SCAN_PREP_PROFILE}) ${fallback.provenance}`,
  }
}
