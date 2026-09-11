/**
 * 扫描档位表 —— 「这个尺寸的图，一条线该扫多久」。
 *
 * ## 为什么只有一份
 *
 * `ConfigureScan` / `FullScan` / `PreScanCheck` 曾各自写过一份，其中**两份把
 * 0.1 s 当默认值**——而 0.1 s 在 50 nm 的图上是 488 nm/s，真机 2026-08-12 用这个
 * 速度**把针尖刮坏了**。一个动作有三份实现时，只有带事故注释的那份是对的。
 *
 * ## `source` 一定要往上报
 *
 * 「这个速度是谁定的」在轨迹里必须可查，而一个光秃秃的 `1.2` 决定不了它来自档位表
 * 还是来自某人手打。
 *
 * ## 2026-08-09 那次改档：从「一帧 34 分钟」到「一帧约 8 分钟」
 *
 * 触发：真机上一句「扫个图看看」→ 50 nm 命中 highres → 512 px × 2.0 s × 双向
 * = **34 分 8 秒**（Nanonis 面板逐秒吻合）。参数不是编的、档位表是自洽的、每一步都对
 * ——而用户想要的是「看一眼」。
 *
 * 旧表的取值原则（分辨率取区间下限、line_time 取中值偏慢护针尖）本身没错，错的是
 * **它只优化一个方向**：每一档都朝「更稳」靠，没有任何一处为「得先看得到东西才谈得上
 * 稳」付账。一张 34 分钟才出结果的图，在找区域、判针尖、试参数这些**要迭代**的场合
 * 是不可用的——不是慢，是用不了。
 *
 * 新原则：**默认档服务迭代，慢速档服务成图**。像素统一 256 而不是 512 是省时的主力，
 * 而且它**不牺牲针尖**：每线时间不变时行数减半让帧时减半，而每像素驻留时间反而翻倍。
 * 真正压针尖的是 `lineTimeS`，不是 `pixels`——两者被旧表捆在一起了。
 */

/** 上界比较的相对容差——浮点写成 `1e-7` 的边界值该落在它自己那一档里。 */
export const BOUND_REL_TOL = 1e-9

export interface ScanTier {
  readonly name: string
  /** **闭上界**（含）。`null` = 兜底档，必须在末位。 */
  readonly upperSizeM: number | null
  readonly pixels: number
  readonly lineTimeS: number
}

/**
 * 出厂默认表。数值化自知识库的 progressive_zoom 四级协议。
 *
 * 要推翻这张表需要回答：8 分钟这一档上，正反扫一致性判据（不稳定度）有没有**系统性
 * 变差**？那是「扫太快导致反馈跟不上」唯一会先露头的地方。至今的观测朝反方向：
 * 2026-08-09 在 4.3 K 的 Au(111) 上以 **0.1536 s/线**（比新默认还快 6.5 倍）扫了四帧
 * 50 nm，不稳定度 0.15 ≪ 阈 0.5。若换到室温或软样品上出现方向性重影，**先加大
 * `lineTimeS`，不要回去加 `pixels`**——加 pixels 只会让同一个问题多花一倍时间显形。
 */
export const FACTORY_TIERS: readonly ScanTier[] = [
  // ≤2 nm。那个尺度上你就是在看原子，值得花 30 分钟。
  { name: 'slow', upperSizeM: 2e-9, pixels: 512, lineTimeS: 1.75 },
  // ≤5 nm。原子相**验收**档：512 px 下 nm/px = 0.00977，满权重余量 2×。
  // `atomic` 档判不出原子相——它是 10 nm / 256 px，最大帧 0.0391 nm/px 落在过渡带。
  { name: 'atomic_verify', upperSizeM: 5e-9, pixels: 512, lineTimeS: 0.3 },
  { name: 'atomic', upperSizeM: 1e-8, pixels: 256, lineTimeS: 1.2 },
  // ≤100 nm —— 最常用的那一档，256×1.0×2 ≈ 8.5 分钟
  { name: 'highres', upperSizeM: 1e-7, pixels: 256, lineTimeS: 1.0 },
  { name: 'roi', upperSizeM: 5e-7, pixels: 256, lineTimeS: 0.8 },
  { name: 'survey', upperSizeM: null, pixels: 256, lineTimeS: 0.5 },
]

/**
 * 按扫描边长查档。
 *
 * 区间语义：**闭上界**，从小到大取第一个 `size <= upperSizeM` 的档；末位那个
 * `upperSizeM: null` 的兜底档接住所有更大的尺寸。所以边界值落在**小的那一档**
 * （出厂表里正好 100 nm 属 highres 而不是 roi）。
 *
 * 这是台阶函数，**不插值**：用户的心智模型是档位（「大图我用 256」），插值会产出
 * 384px 这种非常规像素数，而且轨迹里「来自 roi 档」远比「roi 与 highres 的对数插值
 * 0.63」可用。
 */
export function tierForSize(sizeM: number | null | undefined): ScanTier {
  const size = typeof sizeM === 'number' && Number.isFinite(sizeM) ? sizeM : 0
  for (const tier of FACTORY_TIERS) {
    if (tier.upperSizeM === null) return tier
    if (size <= tier.upperSizeM * (1 + BOUND_REL_TOL)) return tier
  }
  return FACTORY_TIERS[FACTORY_TIERS.length - 1] as ScanTier
}

/** 按档名取档（`purpose` 强制换档用）。找不到返回 `null`。 */
export function tierByName(name: string): ScanTier | null {
  const want = (name || '').trim().toLowerCase()
  if (!want) return null
  return FACTORY_TIERS.find((t) => t.name.toLowerCase() === want) ?? null
}

export interface LineTime {
  readonly lineTimeS: number
  /** `explicit` / `tier:<名字>` —— 「这个速度是谁定的」必须可查。 */
  readonly source: string
}

/** 每线时间：**显式参数 > 出厂档位表 > 兜底**。 */
export function resolveLineTime(
  explicit: unknown,
  sizeM: number | null | undefined,
  fallback = 0.1,
): LineTime {
  if (explicit !== null && explicit !== undefined) {
    const v = typeof explicit === 'number' ? explicit : Number(explicit)
    if (Number.isFinite(v) && v > 0) return { lineTimeS: v, source: 'explicit' }
  }
  const tier = tierForSize(sizeM)
  if (Number.isFinite(tier.lineTimeS)) {
    return { lineTimeS: tier.lineTimeS, source: `tier:${tier.name}` }
  }
  return { lineTimeS: fallback, source: 'fallback' }
}

/**
 * 一帧的估计耗时（秒）= 线数 × 每线时间 × 2（正反扫）。
 *
 * 往返因子 2 是保守估计：Nanonis 的正反扫时间可以分别设，但本表只存一个 line_time，
 * 两个方向同速。
 */
export function estimateScanSeconds(pixels: unknown, lineTimeS: unknown): number {
  const px = typeof pixels === 'number' && Number.isFinite(pixels) ? pixels : 0
  const lt = typeof lineTimeS === 'number' && Number.isFinite(lineTimeS) ? lineTimeS : 0
  return px * lt * 2
}
