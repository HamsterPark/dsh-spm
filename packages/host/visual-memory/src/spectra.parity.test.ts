/**
 * Parity with the Python reference for spectra (VISUAL-HARNESS §5).
 *
 * The `spectra` section of `spec/golden/visual_memory.json` comes from
 * `tools/spec-export/export_visual_memory.py`: synthetic `.dat` files in the
 * controller's text layout go through the reference `Archive.add_spectrum`
 * (which reads them with MAST's `read_dat`), next to a small partial scan. The
 * same bytes go through this package here.
 *
 * Compared exactly: frame ids, summaries, observation labels, the parsed
 * `inspect` / `read_values` replies with the key order the model reads, the
 * image labels and image sizes, the refusals, and the plot size for a range of
 * widths. Not compared: plot pixels — the reference draws with matplotlib, this
 * package with its own drawing code (the size is in every label, so it is).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import golden from '../../../../spec/golden/visual_memory.json' with { type: 'json' }
import { FrameArchive } from './archive.js'
import { pngSize } from './png.js'
import type { PartialMeta } from './scan-data.js'
import { spectrumPlotSize } from './spectrum.js'
import { inspect, readValues } from './views.js'

/** Every key of a parsed reply, depth first in insertion order: the order the model reads. */
function keyPaths(obj: unknown, path = '$'): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => keyPaths(v, `${path}[${i}]`))
  if (obj === null || typeof obj !== 'object') return []
  return Object.entries(obj).flatMap(([k, v]) => [`${path}.${k}`, ...keyPaths(v, `${path}.${k}`)])
}

/** Heights stored as integers of 1 pm, as the exporter makes them. */
const pmGrid = (rows: readonly (readonly number[])[]) => ({
  rows: rows.length,
  cols: (rows[0] ?? []).length,
  data: Float64Array.from(rows.flat().map((k) => Math.fround(k * 1e-12))),
})

describe('parity with the Python reference: spectra', () => {
  const S = golden.spectra
  const dir = mkdtempSync(join(tmpdir(), 'vm-parity-spectra-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'in')
  mkdirSync(input)
  for (const [name, text] of Object.entries(S.inputs.dat)) writeFileSync(join(input, name), text, 'utf8')
  const arc = new FrameArchive(join(dir, 'frames'), { displayMax: S.display_max })
  const made = [
    arc.addPartial(4, { Z: pmGrid(S.inputs.k_p) }, { ...(S.inputs.meta_p as PartialMeta), geometry: S.inputs.geometry_p }),
    arc.addSpectrum(5, join(input, 'sts_a.dat'), { simS: S.inputs.sim_s_a }),
    arc.addSpectrum(5, join(input, 'z_b.dat')),
    arc.addSpectrum(6, join(input, 'bare.dat')),
  ]

  it('allocates the same frame ids and writes the same summaries, keys in the same order', () => {
    expect(made.map((e) => e.fid)).toEqual(S.frames)
    expect(arc.index()).toEqual(S.index)
    expect(keyPaths(arc.index())).toEqual(S.index_key_paths)
  })

  it('labels the stored observations the same way, plot size included', () => {
    for (const [fid, label] of Object.entries(S.observations)) {
      const obs = arc.observation(fid)
      expect(obs.label).toBe(label)
      const size = /size="(\d+)x(\d+)"/.exec(label)
      expect(pngSize(obs.png)).toEqual({ width: Number(size?.[1]), height: Number(size?.[2]) })
    }
  })

  it('answers inspect with the same reply, key order, labels and image sizes', () => {
    for (const c of S.inspect) {
      expect(c.is_error).toBe(false)
      const r = inspect(arc, c.args)
      if (!r.ok) throw new Error(r.error)
      expect(r.reply).toEqual(c.reply)
      expect(keyPaths(r.reply)).toEqual(c.key_paths)
      expect(r.images.map((i) => i.label)).toEqual(c.labels)
      expect(r.images.map((i) => {
        const { width, height } = pngSize(i.png)
        return [width, height]
      })).toEqual(c.image_sizes)
    }
  })

  it('answers read_values with the same reply and key order', () => {
    for (const c of S.read_values) {
      expect(c.is_error).toBe(false)
      const r = readValues(arc, c.args)
      if (!r.ok) throw new Error(r.error)
      expect(r.reply).toEqual(c.reply)
      expect(keyPaths(r.reply)).toEqual(c.key_paths)
    }
  })

  it('refuses the same spectrum requests with the same messages', () => {
    expect(S.errors.length).toBeGreaterThan(15)
    for (const c of S.errors) {
      expect(c.is_error).toBe(true)
      const r = (c.tool === 'inspect' ? inspect : readValues)(arc, c.args)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(c.error)
    }
  })

  it('sizes the plot like the reference for every width and number of panels', () => {
    for (const c of S.plot_size) expect(spectrumPlotSize(c.width_px, c.panels)).toEqual(c.size)
  })
})
