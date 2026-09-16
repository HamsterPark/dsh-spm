/**
 * **numpy 的** `default_rng(seed)` —— `SeedSequence` + PCG64（XSL-RR 128/64）。
 *
 * ## 容差：**0**，而且这一条不是「顺便严一点」
 *
 * 这一族搬的是整数：`SeedSequence` 是一串 32 位乘法与异或，PCG64 的状态推进是
 * 一次 128 位乘加，输出是一次异或折叠加一次循环右移。**没有一次浮点运算**，
 * 于是「差不多」这个概念在这里不存在 —— 一个 bit 不对，后面整条流就是另一条流。
 * `nextDouble` 那一步唯一的浮点动作是 `(u64 >> 11) * 2⁻⁵³`，**分子是一个
 * 53 位以内的整数、分母是 2 的幂**，IEEE 下精确。
 *
 * ⇒ 判据是**逐位**：金样录 numpy 的 `SeedSequence(s).pool`、`generate_state(4, uint64)`、
 * `bit_generator.random_raw(n)` 与 `uniform(lo, hi)`，四层各比一遍。
 * 只比最后一层是不够的：`uniform` 对得上而 `pool` 错了，说明我在两处各犯了
 * 一个互相抵消的错，而下一个种子上它们就不抵消了。
 *
 * ## 它和 `rng.ts` 的 `Xoshiro128` 不是一回事，**两个都要留着**
 *
 * | | 对的是谁 | 判据 |
 * |---|---|---|
 * | `Xoshiro128` | **本仓自己** | 同一个种子同一串数（金样钉的是它自己的参照） |
 * | `Pcg64`（这里） | **numpy** | 逐位等于 `np.random.default_rng` |
 *
 * `rng.ts` 的抬头写着「复现 PCG64 要实现一个 128 位状态的 LCG，而本层要它做的事
 * 只有一件 —— 让 RANSAC 跑两遍给同一个答案」。那句话对 RANSAC 仍然成立：
 * RANSAC 的抽样序列**没有人在对面**，追 numpy 毫无意义。
 *
 * 这一份存在的理由完全相反：`mast.vision.lattice_cell.superstructure_test` 用
 * `np.random.default_rng(seed)` 抽 **8 个空白对照波矢**，而判决
 * （`present` / `absent` / `undetermined`）就是候选幅值除以那 8 个对照的最大值。
 * **对照抽在哪儿决定了结论**，所以这一处必须是 numpy 的那 8 个点，不是「另外
 * 8 个同样合法的点」。这与 D-VISION-1（RANSAC 抽样序列不追 numpy）是**同一条
 * 判据的两侧**：追不追，看的是「对面有没有一个被比的答案」。
 *
 * ## 实现要点（照抄 numpy，不自己发明）
 *
 * * `SeedSequence` 的池是 **4 个 32 位字**；`generate_state(n, uint64)` 先出
 *   `2n` 个 32 位字，再按**小端**两两拼成 uint64（`view(np.uint64)`）；
 * * `PCG64.seed`：`state = 0；inc = (seq << 1) | 1；step()；state += initstate；step()`
 *   —— 两次 `step` 的位置是 PCG 参考实现的原样，少一次或多一次整条流就变；
 * * `uniform(lo, hi)` = `lo + (hi − lo) · next_double()`，**不是** `lo + range·…`
 *   之外的任何等价变形（浮点上不等价）。
 */

const MASK32 = 0xffffffff
const XSHIFT = 16
const INIT_A = 0x43b0d7e5
const MULT_A = 0x931e8875
const INIT_B = 0x8b51f9dd
const MULT_B = 0x58f38ded
const MIX_MULT_L = 0xca01f9dd
const MIX_MULT_R = 0x4973f715

/** `numpy.random.bit_generator.SeedSequence` 的池长度（`pool_size=4`）。 */
export const SEED_POOL_SIZE = 4

const mul32 = (a: number, b: number): number => Math.imul(a, b) >>> 0

/**
 * `SeedSequence(entropy).pool` —— 4 个 32 位字。
 *
 * `entropy` 是已经摊平成 uint32 的那一串（`seedSequencePool([0])` 就是
 * `np.random.SeedSequence(0)`）。`spawn_key` 本仓没有消费方，不移。
 */
export function seedSequencePool(entropy: readonly number[]): Uint32Array {
  const mixer = new Uint32Array(SEED_POOL_SIZE)
  let hashConst = INIT_A
  const hashmix = (value: number): number => {
    let v = (value ^ hashConst) >>> 0
    hashConst = mul32(hashConst, MULT_A)
    v = mul32(v, hashConst)
    return (v ^ (v >>> XSHIFT)) >>> 0
  }
  const mix = (x: number, y: number): number => {
    const r = (mul32(MIX_MULT_L, x) - mul32(MIX_MULT_R, y)) >>> 0
    return (r ^ (r >>> XSHIFT)) >>> 0
  }
  for (let i = 0; i < SEED_POOL_SIZE; i += 1) {
    mixer[i] = hashmix(i < entropy.length ? (entropy[i] as number) >>> 0 : 0)
  }
  // 「把全部位混在一起，好让靠后的位也影响得到靠前的位」—— numpy 原注释。
  for (let s = 0; s < SEED_POOL_SIZE; s += 1) {
    for (let d = 0; d < SEED_POOL_SIZE; d += 1) {
      if (s !== d) mixer[d] = mix(mixer[d] as number, hashmix(mixer[s] as number))
    }
  }
  for (let s = SEED_POOL_SIZE; s < entropy.length; s += 1) {
    for (let d = 0; d < SEED_POOL_SIZE; d += 1) {
      mixer[d] = mix(mixer[d] as number, hashmix((entropy[s] as number) >>> 0))
    }
  }
  return mixer
}

/** `SeedSequence.generate_state(nWords, np.uint32)`。 */
export function generateState32(pool: Uint32Array, nWords: number): Uint32Array {
  const out = new Uint32Array(nWords)
  let hashConst = INIT_B
  for (let i = 0; i < nWords; i += 1) {
    let v = pool[i % pool.length] as number
    v = (v ^ hashConst) >>> 0
    hashConst = mul32(hashConst, MULT_B)
    v = mul32(v, hashConst)
    out[i] = (v ^ (v >>> XSHIFT)) >>> 0
  }
  return out
}

/**
 * `SeedSequence.generate_state(nWords, np.uint64)`。
 *
 * numpy 出 `2·nWords` 个 32 位字之后直接 `view(np.uint64)` —— 也就是按
 * **小端**拼：低位字在前。写反了每个数都变成另一个完全合法的 64 位整数，
 * 而金样第二层正是为这一件事录的。
 */
export function generateState64(pool: Uint32Array, nWords: number): bigint[] {
  const w = generateState32(pool, nWords * 2)
  const out: bigint[] = []
  for (let i = 0; i < nWords; i += 1) {
    out.push((BigInt(w[2 * i + 1] as number) << 32n) | BigInt(w[2 * i] as number))
  }
  return out
}

const MASK64 = (1n << 64n) - 1n
const MASK128 = (1n << 128n) - 1n
/** PCG 的 128 位乘子 `0x2360ED051FC65DA44385DF649FCCF645`。 */
const PCG_MULT = 0x2360ed051fc65da44385df649fccf645n

/** numpy 的 `PCG64` 位发生器（XSL-RR 128/64）。 */
export class Pcg64 {
  #state: bigint
  #inc: bigint

  /** `pcg64_srandom_r(initstate, initseq)` —— 两次 `step` 的位置照抄参考实现。 */
  constructor(initState: bigint, initSeq: bigint) {
    this.#state = 0n
    this.#inc = ((initSeq << 1n) | 1n) & MASK128
    this.#step()
    this.#state = (this.#state + (initState & MASK128)) & MASK128
    this.#step()
  }

  /** `default_rng(seed)`：种子是一个非负整数（本仓只用到这一路）。 */
  static fromSeed(seed: number): Pcg64 {
    const pool = seedSequencePool(seedEntropy(seed))
    const s = generateState64(pool, 4)
    return new Pcg64(((s[0] as bigint) << 64n) | (s[1] as bigint), ((s[2] as bigint) << 64n) | (s[3] as bigint))
  }

  #step(): void {
    this.#state = (this.#state * PCG_MULT + this.#inc) & MASK128
  }

  /** `random_raw()` —— 一个 uint64。 */
  next(): bigint {
    this.#step()
    const hi = this.#state >> 64n
    const lo = this.#state & MASK64
    const xored = (hi ^ lo) & MASK64
    const rot = hi >> 58n
    if (rot === 0n) return xored
    return ((xored >> rot) | (xored << (64n - rot))) & MASK64
  }

  /** `next_double()` —— `(u64 >> 11) · 2⁻⁵³`。分子 ≤ 2⁵³−1、分母是 2 的幂 ⇒ 精确。 */
  nextDouble(): number {
    return Number(this.next() >> 11n) * (1.0 / 9007199254740992.0)
  }

  /** `Generator.uniform(low, high)` = `low + (high − low)·next_double()`。 */
  uniform(low = 0, high = 1): number {
    return low + (high - low) * this.nextDouble()
  }
}

/**
 * 一个非负整数种子 → numpy 摊平后的 uint32 串（`_int_to_uint32_array`）。
 *
 * `0` 给 `[0]`（**不是空数组** —— numpy 对 0 也留一个字）。大于 32 位的种子按
 * 小端切成多个字。
 */
export function seedEntropy(seed: number): number[] {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new RangeError(`种子要一个非负整数：得到 ${seed}`)
  }
  if (seed === 0) return [0]
  const out: number[] = []
  let v = BigInt(seed)
  while (v > 0n) {
    out.push(Number(v & BigInt(MASK32)) >>> 0)
    v >>= 32n
  }
  return out
}
