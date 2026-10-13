/**
 * A synthetic `.sxm` writer for fixtures and tests (no real instrument data
 * enters this repository).
 *
 * Callers give ORIENTED frames (row 0 = the frame's top edge, backward pass
 * already un-mirrored) — the convention the archive promises. The writer stores
 * them the way Nanonis does: rows in acquisition order (bottom row first when
 * `scanDir` is `up`), the backward pass mirrored left-right, big-endian float32,
 * channels in `:DATA_INFO:` order with forward before backward. Reading the file
 * back through `dsh-spm-nanonis-files` therefore exercises the reader's
 * orientation, not a shortcut around it.
 */

export interface SyntheticChannel {
  readonly name: string
  /** SI unit written to `:DATA_INFO:` (e.g. `m`, `A`, `Hz`). */
  readonly unit: string
  /** Oriented forward frame, row-major `ny × nx`. */
  readonly forward?: ArrayLike<number>
  /** Oriented (un-mirrored) backward frame, row-major `ny × nx`. */
  readonly backward?: ArrayLike<number>
}

export interface SyntheticSxm {
  readonly nx: number
  readonly ny: number
  readonly widthM: number
  readonly heightM: number
  readonly offsetXM: number
  readonly offsetYM: number
  readonly angleDeg?: number
  readonly scanDir: 'up' | 'down'
  readonly biasV?: number
  /** Written as a `:Z-CONTROLLER>SETPOINT:` field. */
  readonly setpointA?: number
  /** Written as the `on` column of the `:Z-CONTROLLER:` table. */
  readonly feedbackOn?: boolean
  readonly recDate?: string
  readonly recTime?: string
  readonly channels: readonly SyntheticChannel[]
}

function e(v: number): string {
  return v.toExponential(6).toUpperCase()
}

/** Encode a synthetic `.sxm` file. */
export function encodeSyntheticSxm(spec: SyntheticSxm): Uint8Array {
  const { nx, ny } = spec
  const lines: string[] = [
    ':NANONIS_VERSION:', '2',
    ':SCANIT_TYPE:', '              FLOAT            MSBFIRST',
    ':REC_DATE:', spec.recDate ?? '09.10.2026',
    ':REC_TIME:', spec.recTime ?? '12:00:00',
    ':SCAN_PIXELS:', `       ${nx}       ${ny}`,
    ':SCAN_RANGE:', `           ${e(spec.widthM)}           ${e(spec.heightM)}`,
    ':SCAN_OFFSET:', `             ${e(spec.offsetXM)}         ${e(spec.offsetYM)}`,
    ':SCAN_ANGLE:', `            ${(spec.angleDeg ?? 0).toFixed(3)}`,
    ':SCAN_DIR:', spec.scanDir,
  ]
  if (spec.biasV !== undefined) lines.push(':BIAS:', e(spec.biasV))
  if (spec.setpointA !== undefined) lines.push(':Z-CONTROLLER>SETPOINT:', e(spec.setpointA))
  if (spec.feedbackOn !== undefined) {
    lines.push(
      ':Z-CONTROLLER:',
      '\tName\ton\tSetpoint\tP-gain\tI-gain\tT-const',
      `\tlog Current\t${spec.feedbackOn ? 1 : 0}\t1.000E-10 A\t1.000E-12 m\t1.000E-9 m/s\t1.000E-3 s`,
    )
  }
  lines.push(':DATA_INFO:', '\tChannel\tName\tUnit\tDirection\tCalibration\tOffset')
  spec.channels.forEach((ch, i) => {
    const flag = ch.forward !== undefined && ch.backward !== undefined ? 'both' : ch.forward !== undefined ? 'fwd' : 'bwd'
    lines.push(`\t${i}\t${ch.name}\t${ch.unit}\t${flag}\t1.000E+0\t0.000E+0`)
  })
  lines.push('', ':SCANIT_END:', '', '')
  const header = new TextEncoder().encode(lines.join('\n'))

  const frames: { values: ArrayLike<number>; mirror: boolean }[] = []
  for (const ch of spec.channels) {
    if (ch.forward !== undefined) frames.push({ values: ch.forward, mirror: false })
    if (ch.backward !== undefined) frames.push({ values: ch.backward, mirror: true })
  }
  const data = new Uint8Array(frames.length * nx * ny * 4)
  const view = new DataView(data.buffer)
  let off = 0
  for (const f of frames) {
    if (f.values.length !== nx * ny) throw new RangeError(`frame has ${f.values.length} values, expected ${nx * ny}`)
    for (let k = 0; k < ny; k += 1) {
      const r = spec.scanDir === 'up' ? ny - 1 - k : k // acquisition order
      for (let j = 0; j < nx; j += 1) {
        const c = f.mirror ? nx - 1 - j : j
        view.setFloat32(off, f.values[r * nx + c] as number, false)
        off += 4
      }
    }
  }
  const out = new Uint8Array(header.length + 2 + data.length)
  out.set(header, 0)
  out[header.length] = 0x1a
  out[header.length + 1] = 0x04
  out.set(data, header.length + 2)
  return out
}
