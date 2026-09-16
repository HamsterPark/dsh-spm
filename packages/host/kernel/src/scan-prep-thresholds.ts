/**
 * 扫描图预处理阈值的 profile —— 旧仓 `mast/vision/scan_prep_thresholds.py` 的
 * `PROFILES` + `resolve`。
 *
 * ## 消融：这里只有**两个字段**，不是那 22 个
 *
 * 旧仓的 `ScanPrepThresholds` 有 22 个阈值（`line_gain` / `bow_gain` / `step_purity` /
 * 色阶百分位 …）。本批唯一的消费方是 `AssessFrameCorrugation`，它只读
 * `name` / `provenance` / `corrugation_high_pm` / `corrugation_ref_scan_nm`。
 *
 * 「没有消费方的形状不移」—— 移那 18 个进来，就是给下一个人留 18 条永远不亮的分支，
 * 而且它们各自的标定说明会在本仓**没有任何测试盯着**的情况下慢慢过期。
 * 真要用的时候照着旧仓那份 docstring 补，那时它们会带着自己的消费方一起来。
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

/** 一套阈值的不可变快照（本批只留有消费方的那几个字段）。 */
export interface ScanPrepThresholds {
  readonly name: string
  readonly provenance: string
  /** 起伏上限（pm）。`null` = **判不了**，不是「没有上限所以都算正常」。 */
  readonly corrugationHighPm: number | null
  /** 上面那个阈值是在多大的视野上标的（nm）。`null` = 没声明 ⇒ 判不了。 */
  readonly corrugationRefScanNm: number | null
}

const BUILTIN: Readonly<Record<string, ScanPrepThresholds>> = {
  [DEFAULT_SCAN_PREP_PROFILE]: {
    name: DEFAULT_SCAN_PREP_PROFILE,
    provenance:
      '阈值来自参考系统上一组台阶稀疏、单一畴表面的观测，尚未在本仓独立验证。' +
      '换到台阶密集或噪声特性不同的体系时，step_sep 等随样品漂移的字段必须重新标定；' +
      '先检查目标数据分布再定。',
    corrugationHighPm: null,
    corrugationRefScanNm: null,
  },
}

/**
 * 进程级的 profile 表。`external` 由宿主填（旧仓那份 JSON 的位置），
 * `active` 是当前生效的名字。
 */
export const scanPrepProfiles: {
  external: Record<string, ScanPrepThresholds>
  active: string
} = { external: {}, active: DEFAULT_SCAN_PREP_PROFILE }

/** 内建 + 外部（外部同名覆盖内建）。 */
function merged(): Record<string, ScanPrepThresholds> {
  return { ...BUILTIN, ...scanPrepProfiles.external }
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
  const fallback = table[DEFAULT_SCAN_PREP_PROFILE] ?? {
    name: '',
    provenance: '',
    corrugationHighPm: null,
    corrugationRefScanNm: null,
  }
  return {
    ...fallback,
    name: DEFAULT_SCAN_PREP_PROFILE,
    provenance: `(请求的 profile '${name}' 不存在,已回落到 ${DEFAULT_SCAN_PREP_PROFILE}) ${fallback.provenance}`,
  }
}
