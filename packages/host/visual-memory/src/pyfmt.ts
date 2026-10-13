/**
 * Python-compatible rounding and number formatting.
 *
 * The visual harness is ported from a Python reference whose replies and image
 * labels are compared against this package (VISUAL-HARNESS §5). Python rounds
 * the EXACT binary value of a double and breaks exact ties to even
 * (`round(0.125, 2) == 0.12`, `f"{12.625:.4g}" == '12.62'`), while JavaScript's
 * `toFixed` / `toExponential` / `Math.round` break ties upwards. Ties are not
 * exotic here: frame geometries are often dyadic (`0.03125 nm`), and dyadic
 * values are exactly the ones that tie. So every rounding the model can see goes
 * through these helpers, which do the arithmetic exactly with `BigInt`.
 *
 * Tolerance: none — the results are exact (bit-identical to CPython) for
 * every finite double.
 *
 * `dsh-spm-kernel` has CPython-validated `pyRound` / `pyFixed` too
 * (spec/deviations.md D-LANG-3), built on `toFixed` and limited to
 * |v| < 1e21; it has no `%g`. A test pins that both agree on that range, so
 * the two can later be merged into one without changing any output.
 */

interface ExactDouble {
  readonly negative: boolean
  /** |x| = mantissa · 2^exponent, mantissa an integer. */
  readonly mantissa: bigint
  readonly exponent: number
}

const VIEW = new DataView(new ArrayBuffer(8))

function exactDouble(x: number): ExactDouble {
  VIEW.setFloat64(0, x)
  const hi = VIEW.getUint32(0)
  const lo = VIEW.getUint32(4)
  const negative = hi >>> 31 === 1
  const biased = (hi >>> 20) & 0x7ff
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  let exponent: number
  if (biased === 0) {
    exponent = -1074 // subnormal
  } else {
    mantissa |= 1n << 52n
    exponent = biased - 1075
  }
  return { negative, mantissa, exponent }
}

/** `round(num / den)` with ties to even; `num >= 0`, `den > 0`. */
function divRoundHalfEven(num: bigint, den: bigint): bigint {
  let q = num / den
  const twice = (num - q * den) * 2n
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n
  return q
}

/** `round(|x| · 10^digits)` with ties to even; `digits` may be negative. */
function scaledMagnitude(x: ExactDouble, digits: number): bigint {
  let num = x.mantissa
  let den = 1n
  if (digits >= 0) num *= 10n ** BigInt(digits)
  else den *= 10n ** BigInt(-digits)
  if (x.exponent >= 0) num <<= BigInt(x.exponent)
  else den <<= BigInt(-x.exponent)
  return divRoundHalfEven(num, den)
}

/** Python `round(x, ndigits)` for `ndigits >= 0`. Non-finite values pass through. */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x
  const parts = exactDouble(x)
  const q = scaledMagnitude(parts, ndigits)
  // One correctly rounded decimal → double conversion, like CPython's strtod;
  // `Number(q) / 10 ** n` would round twice once q exceeds 2^53.
  const v = Number(`${q}e-${ndigits}`)
  return parts.negative ? -v : v
}

/** Python `round(x)` (to an integer, ties to even). */
export function pyRoundInt(x: number): number {
  return pyRound(x, 0)
}

/** numpy `rint`: nearest integer, ties to even. */
export function rint(v: number): number {
  const f = Math.floor(v)
  const d = v - f
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1
  return r === 0 && v < 0 ? -0 : r // numpy keeps the sign of zero
}

function nonFinite(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  return x > 0 ? 'inf' : '-inf'
}

/** Python `f"{x:.{digits}f}"`. */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return nonFinite(x)
  const parts = exactDouble(x)
  const s = scaledMagnitude(parts, digits).toString().padStart(digits + 1, '0')
  const body = digits === 0 ? s : `${s.slice(0, s.length - digits)}.${s.slice(s.length - digits)}`
  return parts.negative ? `-${body}` : body
}

function stripZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/** Python `f"{x:.{precision}g}"`. */
export function pyG(x: number, precision: number): string {
  if (!Number.isFinite(x)) return nonFinite(x)
  const p = Math.max(1, Math.trunc(precision))
  const parts = exactDouble(x)
  const sign = parts.negative ? '-' : ''
  if (x === 0) return `${sign}0`
  // Decimal exponent of |x| rounded to p significant digits.
  let e = Math.floor(Math.log10(Math.abs(x)))
  let q = scaledMagnitude(parts, p - 1 - e)
  const lowest = 10n ** BigInt(p - 1)
  const highest = 10n ** BigInt(p)
  // log10 can be off by one near powers of ten, and rounding can carry.
  while (q >= highest) {
    e += 1
    q = scaledMagnitude(parts, p - 1 - e)
  }
  while (q < lowest) {
    e -= 1
    q = scaledMagnitude(parts, p - 1 - e)
  }
  const digits = q.toString()
  if (e >= -4 && e < p) {
    let fixed: string
    if (e >= 0) fixed = e + 1 >= digits.length ? digits : `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`
    else fixed = `0.${'0'.repeat(-e - 1)}${digits}`
    return sign + stripZeros(fixed)
  }
  const mantissa = stripZeros(digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits)
  const abs = Math.abs(e)
  return `${sign}${mantissa}e${e < 0 ? '-' : '+'}${abs < 10 ? `0${abs}` : abs}`
}
