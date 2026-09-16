/**
 * 「一个 `.sxm` 里该拿哪一路通道当形貌图」—— **零 numpy、零 I/O 的一条判据**。
 *
 * 它长得像一句杂活（挑个名字而已），但它是一条**判决**：挑错了通道，
 * 后面每一个数都算得对、量的却是另一个物理量。批 4a 的
 * `LoadScanFrameFromFile` 抬头把这件事写成了一整节：
 *
 * > `AssessImageQuality._compute_fwd_bwd_ssim` 里那段是 `for ch in ("Z", *channels)`
 * > ——「Z 没有就用碰到的第一个」。那样出来的数**看起来完全正常**。
 *
 * 旧仓 `mast/data/loaders.py:_pick_image_channel` 的三档，照移：
 *
 * 1. 调用方指名了 `prefer` ⇒ 第一个**名字里含有它**（不分大小写）的通道；
 * 2. 否则按 `z` → `height` → `topo` 的顺序找，**且名字里不能有 `current`**；
 * 3. 都没有 ⇒ **第一路**。
 *
 * ⚠️ 第 3 档是这三档里唯一一条「猜」，而 `load_image_2d` 的调用方全都吃它。
 * `LoadScanFrameFromFile` **不用**这个函数 —— 它的纪律相反（通道不在就报错
 * 并把有哪些列出来）。两条纪律在同一个仓里并存是有意的：
 * 一个「随便给你一路」的加载器用在**只要一张图**的滤波技能上是合理的，
 * 用在**要比较两路**的判据上就是灾难。所以这个函数的名字里带 `Image`，
 * 而不是叫 `pickChannel`。
 */

/** 通道名里含 `current` 的那一路**不是形貌**。第 2 档靠它排除电流图。 */
const NOT_TOPO = 'current'

/** 第 2 档按这个顺序找。顺序是判据：一个同时叫 `Z height` 的通道按 `z` 命中。 */
const TOPO_KEYWORDS = ['z', 'height', 'topo'] as const

/**
 * 挑一路当形貌图。`names` 是**按文件里的顺序**给的通道名。
 *
 * 一个通道都没有就抛 —— 与旧仓 `raise ValueError("sxm file exposes no channels")`
 * 同一句话（那是 `load_image_2d` 的报文里会原样出现的一句）。
 */
export function pickImageChannel(names: readonly string[], prefer?: string | null): string {
  if (names.length === 0) throw new RangeError('sxm file exposes no channels')
  const low = names.map((c) => String(c).toLowerCase())
  if (prefer !== undefined && prefer !== null && prefer !== '') {
    const pl = prefer.toLowerCase()
    for (let i = 0; i < low.length; i += 1) {
      if ((low[i] as string).includes(pl)) return names[i] as string
    }
  }
  for (const kw of TOPO_KEYWORDS) {
    for (let i = 0; i < low.length; i += 1) {
      const c = low[i] as string
      if (c.includes(kw) && !c.includes(NOT_TOPO)) return names[i] as string
    }
  }
  return names[0] as string
}
