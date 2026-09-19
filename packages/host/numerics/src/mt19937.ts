/**
 * CPython 的 `random.Random` —— **MT19937** + 它上面那四层
 * （`random()` / `getrandbits()` / `_randbelow()` / `uniform()` / `choice()`）。
 *
 * ## 这是本仓**第三个** RNG，而它不是重复
 *
 * 前两个的分工写在 `rng.ts` 的抬头：
 *
 * * `Xoshiro128` —— **只为可复现**。RANSAC 的抽样序列对面没有答案，追 numpy 毫无意义；
 * * `Pcg64` —— **进判决**。`superstructure_test` 的对照波矢有一个被比的答案，
 *   所以那一处必须逐位追 `np.random.default_rng`。
 *
 * 这一份落在 `Pcg64` 那一侧，而且更硬：`BiasWiggle` 的**每一个扰动目标**
 * （`rng.uniform(lower, upper) * rng.choice((-1., 1.))`）与**每一段停留**
 * （`rng.uniform(dwell_lo, dwell_hi)`）都被逐条录进回包的 `log`，
 * 而停留时长又决定了一次 burst 打得出几次跳变（`flips_executed`）。
 *
 * ⇒ **换一个 RNG 等于这个技能整条轨迹没有判据**：`log` 对不上、`flips_executed`
 * 对不上、`summary` 里那个次数也对不上。剩下能比的只有参数回显与四条拒绝文案 ——
 * 而那时金样说的是「拒绝分支移对了」，不是「这个技能移对了」。
 *
 * 追的是 **CPython 的 `random`**（Mersenne Twister），不是 numpy ——
 * 旧仓这个技能用的是标准库 `random.Random(seed)`，与 `np.random` 无关。
 *
 * ## 容差：**0，而且是字节级的**
 *
 * 全部是 32 位整数运算与两次除以 2 的幂。`random()` 的式子
 * `((a >> 5) · 2²⁶ + (b >> 6)) / 2⁵³` 在 double 里精确（分子 < 2⁵³）。
 * `uniform(a, b) = a + (b − a)·random()` 是两次浮点运算，逐字同序。
 *
 * ## 三处**只能由金样确认**的细节
 *
 * 这几条是 CPython 的实现细节，不是它文档里的承诺 —— 所以这里写下我们复刻的那一版，
 * 而**期望值由导出器从旧仓那台解释器里录出来**（`spec/golden/batch7a3.json` 的
 * `mt19937` 节），对不上就当场红：
 *
 * 1. `Random(n)` 对**整数**种子走 `init_by_array`，key 是 `abs(n)` 的小端 32 位字数组
 *    （`n === 0` 时 key 是 `[0]`，一个字）；
 * 2. `getrandbits(k)`（`k ≤ 32`）是 `genrandUint32() >>> (32 − k)` —— 取**高位**；
 * 3. `_randbelow(n)` 取 `k = n.bit_length()`（**不是** `(n−1).bit_length()`），
 *    `getrandbits(k)` 拒绝重采样直到 `< n`。于是 `choice` 一个二元组平均要抽两次。
 */

const N = 624
const M = 397
const MATRIX_A = 0x9908b0df
const UPPER_MASK = 0x80000000
const LOWER_MASK = 0x7fffffff

/**
 * CPython `random.Random` 的逐位复刻。
 *
 * 只实现 `BiasWiggle` 用得到的那四个入口（`random` / `getrandbits` /
 * `uniform` / `choice`）。**没有实现的不写**：`randint` / `shuffle` /
 * `gauss` 一个消费方都没有，而一份没人调的实现是下一个漂掉的东西。
 */
export class PyRandom {
  readonly #mt = new Uint32Array(N)
  #mti = N + 1

  /** 种子是一个**非负整数**（旧仓那一路 `int(params.get("seed", 0) or 0)`）。 */
  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0) {
      throw new RangeError(`PyRandom 的种子必须是非负整数：${seed}`)
    }
    this.#initByArray(keyOf(seed))
  }

  /** `init_genrand`。 */
  #initGenrand(s: number): void {
    this.#mt[0] = s >>> 0
    for (let i = 1; i < N; i += 1) {
      const prev = this.#mt[i - 1] as number
      // 1812433253 · (prev ^ (prev >>> 30)) + i，全部 mod 2³²
      this.#mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0
    }
    this.#mti = N
  }

  /** `init_by_array` —— CPython 给整数种子走的就是这一条。 */
  #initByArray(key: Uint32Array): void {
    this.#initGenrand(19650218)
    let i = 1
    let j = 0
    let k = Math.max(N, key.length)
    for (; k > 0; k -= 1) {
      const prev = this.#mt[i - 1] as number
      this.#mt[i] =
        (((this.#mt[i] as number) ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + (key[j] as number) + j) >>> 0
      i += 1
      j += 1
      if (i >= N) {
        this.#mt[0] = this.#mt[N - 1] as number
        i = 1
      }
      if (j >= key.length) j = 0
    }
    for (k = N - 1; k > 0; k -= 1) {
      const prev = this.#mt[i - 1] as number
      this.#mt[i] = (((this.#mt[i] as number) ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0
      i += 1
      if (i >= N) {
        this.#mt[0] = this.#mt[N - 1] as number
        i = 1
      }
    }
    this.#mt[0] = 0x80000000
  }

  /** `genrand_uint32` —— 原始 32 位输出。 */
  nextUint32(): number {
    if (this.#mti >= N) {
      for (let kk = 0; kk < N - M; kk += 1) {
        const y = (((this.#mt[kk] as number) & UPPER_MASK) | ((this.#mt[kk + 1] as number) & LOWER_MASK)) >>> 0
        this.#mt[kk] = ((this.#mt[kk + M] as number) ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0
      }
      for (let kk = N - M; kk < N - 1; kk += 1) {
        const y = (((this.#mt[kk] as number) & UPPER_MASK) | ((this.#mt[kk + 1] as number) & LOWER_MASK)) >>> 0
        this.#mt[kk] = ((this.#mt[kk + (M - N)] as number) ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0
      }
      const y = (((this.#mt[N - 1] as number) & UPPER_MASK) | ((this.#mt[0] as number) & LOWER_MASK)) >>> 0
      this.#mt[N - 1] = ((this.#mt[M - 1] as number) ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0
      this.#mti = 0
    }
    let y = this.#mt[this.#mti] as number
    this.#mti += 1
    y = (y ^ (y >>> 11)) >>> 0
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0
    y = (y ^ (y >>> 18)) >>> 0
    return y >>> 0
  }

  /**
   * `random.random()` —— `[0, 1)` 上 53 位精度的双精度数。
   *
   * `(a >> 5) · 2²⁶ + (b >> 6)` 至多 2⁵³−1，在 double 里**精确**，
   * 所以这一步与 CPython 逐位相同。
   */
  random(): number {
    const a = this.nextUint32() >>> 5
    const b = this.nextUint32() >>> 6
    return (a * 67108864 + b) * (1.0 / 9007199254740992.0)
  }

  /** `random.getrandbits(k)`，**只支持 `1 ≤ k ≤ 32`**（`_randbelow` 只要这一档）。 */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 1 || k > 32) {
      throw new RangeError(`本仓的 getrandbits 只实现 1–32 位：得到 ${k}`)
    }
    return this.nextUint32() >>> (32 - k)
  }

  /**
   * `Random._randbelow_with_getrandbits(n)` —— `[0, n)` 上的整数。
   *
   * ⚠️ `k = n.bit_length()`，**不是** `(n−1).bit_length()`。前者对 `n = 2` 给 2 位、
   * 于是要拒绝一半的抽样；后者给 1 位、一次就中。**两者消耗的随机数个数不同** ⇒
   * 之后的每一个数都跟着错位，而每一个看起来都是合理的随机数。
   */
  randbelow(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`randbelow 的 n 必须是正整数：${n}`)
    const k = 32 - Math.clz32(n)
    let r = this.getrandbits(k)
    while (r >= n) r = this.getrandbits(k)
    return r
  }

  /** `random.uniform(a, b)` = `a + (b − a) · random()`。**运算顺序照抄**。 */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random()
  }

  /** `random.choice(seq)` = `seq[_randbelow(len(seq))]`。 */
  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new RangeError('choice 不接受空序列')
    return seq[this.randbelow(seq.length)] as T
  }
}

/**
 * CPython `random_seed` 把一个整数种子拆成 32 位小端字数组的那一步。
 *
 * `bits = n.bit_length()`；`keyused = bits === 0 ? 1 : (bits − 1) / 32 + 1`。
 * 于是 `0` 给 `[0]`（**一个字，不是零个**），`7` 给 `[7]`，`2³²` 给 `[0, 1]`。
 *
 * 旧仓那一路是 `int(params.get("seed", 0) or 0)`，而 `seed === 0` 走的是
 * **非确定性**分支（`random.Random()`，用系统熵）—— 所以 `[0]` 这一格在
 * `BiasWiggle` 里到不了。写出来是因为这个函数不该对 0 说谎。
 */
function keyOf(n: number): Uint32Array {
  if (n === 0) return Uint32Array.of(0)
  const words: number[] = []
  let rest = n
  while (rest > 0) {
    words.push(rest % 4294967296 >>> 0)
    rest = Math.floor(rest / 4294967296)
  }
  return Uint32Array.from(words)
}
