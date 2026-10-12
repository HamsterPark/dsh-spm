/**
 * A minimal `.dat` writer for tests: spectra in the controller's text layout,
 * the layout STM-Bench's `stmsim.io.dat_writer` writes and MAST's `read_dat`
 * (ported as `readDat` in `dsh-spm-nanonis-files`) reads:
 *
 *     <key>\t<value>\t
 *     …
 *     <blank line>
 *     [DATA]
 *     <column>\t<column>\t…
 *     1.234560E-01\t…
 *
 * The first column is the sweep axis. Numbers are written like the writer's
 * `%.6E`; files are ASCII, so every reader's encoding agrees.
 */

/** Python `"%.6E" % v`: six decimals, upper case, an exponent of at least two digits. */
export function formatE6(v: number): string {
  if (Number.isNaN(v)) return 'NAN'
  if (!Number.isFinite(v)) return v > 0 ? 'INF' : '-INF'
  const [mantissa, exp] = v.toExponential(6).split('e') as [string, string]
  const sign = exp.startsWith('-') ? '-' : '+'
  return `${mantissa}E${sign}${exp.replace(/^[+-]/, '').padStart(2, '0')}`
}

export interface SyntheticDat {
  /** Header fields in order; numbers are written as `%.6E`, booleans as TRUE / FALSE. */
  readonly header?: Readonly<Record<string, string | number | boolean>>
  /** `[name, values]` in order; the first is the sweep axis. All columns have the same length. */
  readonly columns: readonly (readonly [string, ArrayLike<number>])[]
}

function headerValue(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : formatE6(v)
  return v
}

/** The text of a `.dat` file. */
export function syntheticDatText(spec: SyntheticDat): string {
  const lines = Object.entries(spec.header ?? {}).map(([k, v]) => `${k}\t${headerValue(v)}\t`)
  lines.push('', '[DATA]', spec.columns.map(([name]) => name).join('\t'))
  const n = spec.columns[0]?.[1].length ?? 0
  for (let i = 0; i < n; i += 1) lines.push(spec.columns.map(([, v]) => formatE6(v[i] as number)).join('\t'))
  return `${lines.join('\n')}\n`
}

/** The bytes of a `.dat` file. */
export function encodeSyntheticDat(spec: SyntheticDat): Uint8Array {
  return new TextEncoder().encode(syntheticDatText(spec))
}
