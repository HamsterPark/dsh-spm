/**
 * `stats`: summary statistics of one archived scan frame or a region of it — the Python
 * reference's `vista_spm.measure.stats`, with its argument rules, reply keys, units,
 * decimals and messages.
 *
 * - the raw values (finite pixels of the region, SI → model unit): mean, standard
 *   deviation, min, max and the 1/5/25/50/75/95/99th percentiles (numpy `linear`);
 * - after subtracting a least-squares plane fitted to the region: RMS roughness, mean
 *   absolute deviation and peak-to-valley;
 * - a line-noise index: the median absolute difference between consecutive row medians
 *   of the plane-subtracted region, divided by its standard deviation (`null` with fewer
 *   than three rows or no spread);
 * - the fraction of the region's rows with any acquired pixel, the frame's acquired and
 *   total rows;
 * - when the channel has the other scan pass too: the correlation of the two
 *   plane-subtracted passes and their RMS difference (over more than 8 pixels both have).
 *
 * Means and standard deviations sum pairwise like numpy (`npMean`, `npStd`), medians and
 * percentiles pick and interpolate the same values; the plane fit and the correlation are
 * other backward-stable algorithms (see `measure-profile.parity.test.ts`). Every number is
 * rounded before the model reads it.
 *
 * Never throws: invalid arguments come back as `{ ok: false, error }`.
 */
import { corrcoef, npMean, npStd } from 'dsh-spm-numerics'
import { ArgError, channelDirectionArgs, checkKeys, failure, regionArg, type ViewToolResult } from './args.js'
import { channelDirections, entryScale, type FrameArchive, type FrameEntry } from './archive.js'
import { fitSurface, nanMedian } from './flatten.js'
import { argsObject, imageEntry } from './line-profile.js'
import { pyRound } from './pyfmt.js'
import { crop, percentileSorted, regionToNative, RegionError, type Region } from './render.js'
import { formatKey, formatValue } from './units.js'

const STATS_KEYS: ReadonlySet<string> = new Set(['frame', 'region', 'channel', 'direction'])
const PERCENTILES = [1, 5, 25, 50, 75, 95, 99] as const

/** The native pixel box `[i0, j0, i1, j1]` a region covers (`_native_box`). */
export function nativeBox(e: FrameEntry, region: Region | null): [number, number, number, number] {
  try {
    return regionToNative(region, e.nx, e.ny, entryScale(e))
  } catch (err) {
    if (err instanceof RegionError) throw new ArgError(err.message)
    throw err
  }
}

function finite(v: ArrayLike<number>): Float64Array {
  const out: number[] = []
  for (let i = 0; i < v.length; i += 1) if (Number.isFinite(v[i] as number)) out.push(v[i] as number)
  return Float64Array.from(out)
}

function minMax(v: Float64Array): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const x of v) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  return [lo, hi]
}

/** `z` minus the least-squares plane through its finite pixels (`z - _fit_surface(z, 1)`). */
function planeSubtracted(z: Float64Array, w: number, h: number): Float64Array {
  const fit = fitSurface(z, w, h, 1)
  return z.map((v, i) => v - (fit[i] as number))
}

/** Median absolute offset between consecutive finite row medians over the standard deviation. */
function lineNoiseIndex(zp: Float64Array, w: number, h: number, std: number): number | null {
  const medians: number[] = []
  for (let r = 0; r < h; r += 1) {
    const m = nanMedian(zp.subarray(r * w, (r + 1) * w))
    if (Number.isFinite(m)) medians.push(m)
  }
  if (medians.length <= 2 || !(std > 0)) return null
  const steps = medians.slice(1).map((m, i) => Math.abs(m - (medians[i] as number)))
  return nanMedian(steps) / std
}

/** `stats(frame, region, channel, direction)`: see the module comment. Never throws. */
export function frameStats(archive: FrameArchive, args: unknown): ViewToolResult {
  try {
    const a = argsObject(args)
    checkKeys(a, STATS_KEYS, ['frame'], 'arguments')
    const e = imageEntry(archive, a)
    const [ch, direction] = channelDirectionArgs(archive, e, a, 'arguments')
    const region = regionArg(e, a, 'arguments')
    const box = nativeBox(e, region)
    const [i0, j0, i1, j1] = box
    const w = i1 - i0
    const h = j1 - j0
    const fmt = archive.fmt(e, ch)
    const z = crop(archive.values(e, ch, direction), e.nx, box)
    const fin = finite(z)
    if (fin.length < 4) throw new ArgError('the region has fewer than 4 acquired pixels')
    const u = (v: number): number | null => formatValue(fmt, v)
    const zp = planeSubtracted(z, w, h)
    const zpF = finite(zp)
    const lineNoise = lineNoiseIndex(zp, w, h, npStd(zpF))
    let rowsAcquired = 0
    for (let r = 0; r < h; r += 1) if (z.subarray(r * w, (r + 1) * w).some(Number.isFinite)) rowsAcquired += 1
    const sorted = Float64Array.from(fin).sort()
    const [lo, hi] = minMax(fin)
    const [plo, phi] = minMax(zpF)
    const reply: Record<string, unknown> = {
      instrument_unchanged: true,
      frame: e.fid,
      channel: ch,
      direction,
      region_px: region === null ? null : [region.x, region.y, region.width, region.height],
      native_px: [i0, j0, i1, j1],
      n_pixels: z.length,
      n_not_acquired: z.length - fin.length,
      decimals: fmt.decimals,
      [formatKey(fmt, 'mean')]: u(npMean(fin)),
      [formatKey(fmt, 'std')]: u(npStd(fin)),
      [formatKey(fmt, 'min')]: u(lo),
      [formatKey(fmt, 'max')]: u(hi),
      [formatKey(fmt, 'percentiles')]: Object.fromEntries(PERCENTILES.map((q) => [`p${q}`, u(percentileSorted(sorted, q))])),
      plane_subtracted: {
        [formatKey(fmt, 'rms_roughness')]: u(Math.sqrt(npMean(zpF.map((v) => v * v)))),
        [formatKey(fmt, 'mean_abs_deviation')]: u(npMean(zpF.map(Math.abs))),
        [formatKey(fmt, 'peak_to_valley')]: u(phi - plo),
      },
      line_noise_index: lineNoise === null ? null : pyRound(lineNoise, 4),
      rows_acquired_fraction: pyRound(rowsAcquired / Math.max(1, h), 4),
      rows_acquired: e.acquired_rows,
      rows_total: e.ny,
    }
    const other = direction === 'forward' ? 'backward' : 'forward'
    if (channelDirections(e, ch).includes(other)) {
      const b = planeSubtracted(crop(archive.values(e, ch, other), e.nx, box), w, h)
      const pa: number[] = []
      const pb: number[] = []
      zp.forEach((v, i) => {
        if (Number.isFinite(v) && Number.isFinite(b[i] as number)) {
          pa.push(v)
          pb.push(b[i] as number)
        }
      })
      if (pa.length > 8 && npStd(pa) > 0 && npStd(pb) > 0) {
        reply['forward_backward'] = {
          correlation: pyRound(corrcoef(pa, pb), 4),
          [formatKey(fmt, 'rms_difference')]: u(Math.sqrt(npMean(pa.map((v, i) => (v - (pb[i] as number)) * (v - (pb[i] as number)))))),
        }
      }
    }
    return { ok: true, reply, images: [] }
  } catch (err) {
    return failure('stats', err)
  }
}
