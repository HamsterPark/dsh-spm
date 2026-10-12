/**
 * CPython float arithmetic the measurement tools need bit for bit.
 *
 * - {@link pyHypot}: `math.hypot(x, y)`. CPython (3.12 and later) computes it with
 *   lossless scaling, exact squares and a compensated sum, then one differential
 *   correction (`vector_norm` in `Modules/mathmodule.c`), so it is correctly rounded in
 *   practice; V8's `Math.hypot` is not: `Math.hypot(104, 153)` is
 *   `185.00000000000003`, where CPython gives exactly `185`. A line profile takes
 *   `ceil(hypot) + 1` samples, so that one ulp would change the sample count
 *   (spec/deviations.md D-HYPOT-1 records the same difference elsewhere, where only a
 *   rounded value is read). JavaScript has no `fma`; Dekker's product gives the same
 *   exact error term for these operands, which are scaled below 1.
 * - {@link pyMod}: Python's float `%` (the result takes the divisor's sign).
 * - {@link pyMax} / {@link pyMin}: the builtins on two floats, ties to the first argument
 *   (`max(-0.0, 0.0)` is `-0.0`, which `Math.max` turns into `0`).
 * - {@link pyTypeName}: the Python type name of a parsed JSON value, for messages.
 *
 * Tolerance: none. `measure_profile.json` pins `pyHypot` on every Pythagorean triple below
 * 400, random pairs and the edge cases (zero, subnormal, huge).
 */

const SPLIT = 134217729 // 2^27 + 1, Veltkamp's splitter for doubles
const DBL_MIN = 2.2250738585072014e-308 // 2^-1022
const VIEW = new DataView(new ArrayBuffer(8))

/** `[hi, lo]` with `hi = fl(a·b)` and `lo = a·b − hi` exactly (Dekker; CPython uses `fma`). */
function twoProduct(a: number, b: number): [number, number] {
  const p = a * b
  let t = SPLIT * a
  const ah = t - (t - a)
  const al = a - ah
  t = SPLIT * b
  const bh = t - (t - b)
  const bl = b - bh
  return [p, ah * bh - p + ah * bl + al * bh + al * bl]
}

/** `[x, y]` with `x = fl(a + b)` and `y = a + b − x` exactly, for `|a| >= |b|`. */
function fastTwoSum(a: number, b: number): [number, number] {
  const x = a + b
  return [x, a - x + b]
}

/** The exponent `e` of C's `frexp`: `v = m · 2^e` with `0.5 <= m < 1` (`v` finite, > 0). */
function frexpExponent(v: number): number {
  VIEW.setFloat64(0, v)
  const biased = (VIEW.getUint32(0) >>> 20) & 0x7ff
  if (biased !== 0) return biased - 1022
  return frexpExponent(v * 2 ** 64) - 64 // subnormal: scale into the normal range first
}

/** `2^k` for an integer `-1074 <= k <= 1023`, built from its bits (exact, unlike a pow call). */
function powerOfTwo(k: number): number {
  if (k < -1022) return powerOfTwo(k + 64) / 2 ** 64 // subnormal powers of two are exact too
  VIEW.setUint32(0, ((k + 1023) << 20) >>> 0)
  VIEW.setUint32(4, 0)
  return VIEW.getFloat64(0)
}

function vectorNorm(vec: number[], max: number, foundNan: boolean): number {
  if (max === Infinity) return max
  if (foundNan) return NaN
  if (max === 0 || vec.length <= 1) return max
  const maxE = frexpExponent(max)
  if (maxE < -1023) {
    // 2^-maxE would overflow: convert subnormals to normals first
    return DBL_MIN * vectorNorm(vec.map((x) => x / DBL_MIN), max / DBL_MIN, foundNan)
  }
  const scale = powerOfTwo(-maxE)
  let csum = 1
  let frac1 = 0
  let frac2 = 0
  for (const v of vec) {
    const x = v * scale // lossless scaling
    const [hi, lo] = twoProduct(x, x) // lossless squaring
    const [s, e] = fastTwoSum(csum, hi) // lossless addition
    csum = s
    frac1 += lo
    frac2 += e
  }
  let h = Math.sqrt(csum - 1 + (frac1 + frac2))
  const [hi, lo] = twoProduct(-h, h)
  const [s, e] = fastTwoSum(csum, hi)
  csum = s
  frac1 += lo
  frac2 += e
  const x = csum - 1 + (frac1 + frac2)
  h += x / (2 * h) // differential correction
  return h / scale
}

/** CPython's `math.hypot(x, y)`, bit for bit (see the module comment). */
export function pyHypot(x: number, y: number): number {
  const vec = [Math.abs(x), Math.abs(y)]
  let max = 0
  let foundNan = false
  for (const v of vec) {
    foundNan ||= Number.isNaN(v)
    if (v > max) max = v
  }
  return vectorNorm(vec, max, foundNan)
}

/** Python's float `a % b`: `fmod`, moved into the divisor's sign; a zero result takes the divisor's sign. */
export function pyMod(a: number, b: number): number {
  let m = a % b
  if (m !== 0) {
    if (b < 0 !== m < 0) m += b
  } else {
    m = b < 0 ? -0 : 0
  }
  return m
}

/** Python's `max(a, b)` on floats: `b` only when it is strictly larger. */
export function pyMax(a: number, b: number): number {
  return b > a ? b : a
}

/** Python's `min(a, b)` on floats: `b` only when it is strictly smaller. */
export function pyMin(a: number, b: number): number {
  return b < a ? b : a
}

/** `type(v).__name__` of a value parsed from JSON, as Python would name it. */
export function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'string') return 'str'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  return 'dict'
}
