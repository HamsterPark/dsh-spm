/**
 * 可种子随机数 —— **xoshiro128\*\***。
 *
 * ## 容差：不适用。判据是**可复现**
 *
 * 这一件不对 numpy：numpy 走 PCG64，而本层要它做的事只有一件 ——
 * **让 RANSAC 跑两遍给同一个答案**。
 *
 * > ⚠️ **2026-09-16 更正**：这里原先还写着「复现 PCG64 要实现一个 128 位状态的
 * > LCG」，语气像是「做不到」。做到了 —— `pcg64.ts` 逐位复刻了
 * > `np.random.default_rng`（pool / state / raw / uniform 四层各比一遍）。
 * > 但这一份**仍然不换**：判据不同。`superstructure_test` 的对照波矢**有一个
 * > 被比的答案**（判决就是「候选 ÷ 那 8 个对照的最大值」），所以那一处必须追
 * > numpy；RANSAC 的抽样序列**对面没有答案**，追它毫无意义。
 * > 两份并存不是重复，是 D-VISION-1 与 D-SUPER-1 的两侧。
 *
 * 一个用 `Math.random()` 的 RANSAC 是这样的东西：它每次给一个略微不同的平面，
 * 于是「把背景扣掉之后这张图还剩什么」每次都略微不同，**而两次都看起来对**。
 * 那种不确定性在金样面前活不下来，在真实验里也一样 —— 一次扣背景的结果
 * 应该由输入决定，不由它碰巧摇到哪几个点决定。
 *
 * 所以这里的判据是：**同一个种子，同一串数**。金样里钉的是这一串数本身
 * （它是本仓自己的参照，不是谁的标准），于是将来任何一次「顺手换个 RNG」
 * 都会当场变红。
 *
 * ## 为什么是 xoshiro128\*\*
 *
 * 32 位状态、四个字、纯位运算 —— JS 的 `|0` 与 `>>>` 正好是 32 位语义，
 * 不需要 BigInt，也就不会在热路径上装箱。周期 2¹²⁸−1，对采样内点足够。
 */

/** 一条可复现的随机数流。**状态是四个 32 位字**。 */
export class Xoshiro128 {
  #s0: number
  #s1: number
  #s2: number
  #s3: number

  /**
   * 用一个 32 位种子起头。
   *
   * 四个字由 **SplitMix32** 展开，而不是把种子抄四遍：全等的初始状态在
   * xoshiro 上要转很多步才散得开，头几个数会有肉眼可见的相关性。
   */
  constructor(seed: number) {
    let x = seed | 0
    const next = (): number => {
      x = (x + 0x9e3779b9) | 0
      let z = x
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
      return (z ^ (z >>> 15)) >>> 0
    }
    this.#s0 = next()
    this.#s1 = next()
    this.#s2 = next()
    this.#s3 = next()
  }

  /** 下一个 32 位无符号整数。 */
  nextUint32(): number {
    const r = (Math.imul(rotl(Math.imul(this.#s1, 5), 7), 9) >>> 0)
    const t = (this.#s1 << 9) | 0
    this.#s2 ^= this.#s0
    this.#s3 ^= this.#s1
    this.#s1 ^= this.#s2
    this.#s0 ^= this.#s3
    this.#s2 ^= t
    this.#s3 = rotl(this.#s3, 11)
    return r
  }

  /**
   * `[0, 1)` 上的浮点。
   *
   * 用 `/ 2**32` 而不是 `>>> 8 / 2**24`：前者把 32 位全用上，
   * 后者扔掉 8 位换一个「看起来更规整」的分母。
   */
  nextFloat(): number {
    return this.nextUint32() / 4294967296
  }

  /** `[0, n)` 上的整数。**无偏**——拒绝采样，不是取模。 */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`nextInt 的上界必须是正整数：${n}`)
    // 取模会让前 `2³² mod n` 个数各多一次机会。n 小的时候偏差小到看不见，
    // 而「看不见的偏差」正是这个函数不该有的东西。
    const limit = Math.floor(4294967296 / n) * n
    let v = this.nextUint32()
    while (v >= limit) v = this.nextUint32()
    return v % n
  }

  /**
   * 从 `0..n−1` 里**不重复**抽 `k` 个。
   *
   * 部分 Fisher–Yates：只洗前 `k` 个位置，`O(k)` 而不是 `O(n)` ——
   * RANSAC 每次迭代只要 3 个点，而 `n` 是整张图的像素数。
   */
  sample(n: number, k: number): number[] {
    if (k > n) throw new RangeError(`要抽 ${k} 个，池子里只有 ${n} 个`)
    const pool = new Map<number, number>()
    const at = (i: number): number => pool.get(i) ?? i
    const out: number[] = []
    for (let i = 0; i < k; i += 1) {
      const j = i + this.nextInt(n - i)
      out.push(at(j))
      pool.set(j, at(i))
    }
    return out
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}
