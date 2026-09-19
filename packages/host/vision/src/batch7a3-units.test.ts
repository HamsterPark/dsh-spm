/**
 * `kde_layers` / `_hist_modes` 对 `spec/golden/batch7a3.json` 的逐格比对。
 *
 * ## 容差 **0**，而且这一条是有内容的
 *
 * 这两个函数的中间量**全是有容差的运算**（`np.percentile`、
 * `gaussian_filter1d` 的可分离卷积、`find_peaks` 的 prominence），
 * 但它们的**输出是离散的**：峰位是直方图的格心、标签是整数。
 *
 * ⇒ 所以这里不能给容差 —— 给了就等于允许「选了另一个格子」。
 * 反过来，这也意味着**金样不许有一格落在判决边界上**：
 * 两个相邻计数恰好相等、prominence 恰好等于门限、谷恰好等于
 * `valley_rel × min(峰)`，都会让答案由最后一位浮点决定。
 * 每一格都刻意离边界很远（见导出器里每一格的注释），
 * 而「离得够不够远」由这条测试自己回答：它红了就是不够远。
 *
 * 同批 6c §9② 的那一课：**一格答案本身没有定义的金样，比一格分辨不出
 * 两种候选的更糟。**
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matFromRows } from 'dsh-spm-numerics'
import { histModes, kdeLayers, type KdeLayersOptions } from './seg-scale-adaptive.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/batch7a3.json', import.meta.url)), 'utf8'),
) as Record<string, any>

/** 金样里的 `opts` 用的是旧仓的下划线名，这里换成本仓的驼峰名。 */
function optsOf(raw: Record<string, unknown>): KdeLayersOptions {
  const map: Record<string, keyof KdeLayersOptions> = {
    prom: 'prom',
    min_sep: 'minSep',
    valley_rel: 'valleyRel',
    max_levels: 'maxLevels',
    low_grad_pct: 'lowGradPct',
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = map[k]
    if (key === undefined) throw new Error(`金样里有本仓不认的 kde 选项：${k}`)
    out[key] = v
  }
  return out as KdeLayersOptions
}

describe('_hist_modes —— 一维样本的层峰（含谷深合并）', () => {
  for (const c of GOLDEN['hist_modes'] as any[]) {
    it(c.case as string, () => {
      const got = histModes(c.sel as number[], c.sig_n as number, optsOf(c.opts as Record<string, unknown>))
      expect(got).toEqual(c.peaks)
    })
  }
})

describe('kde_layers —— 逐像素台面层标签', () => {
  for (const c of GOLDEN['kde_layers'] as any[]) {
    it(`${c.case}：峰位`, () => {
      const m = matFromRows(chunk(c.coarse as number[][] | number[], c.cols as number))
      const got = kdeLayers(m, c.sig_n as number, optsOf(c.opts as Record<string, unknown>))
      expect(got.peaks).toEqual(c.peaks)
    })
    it(`${c.case}：标签逐像素`, () => {
      const m = matFromRows(chunk(c.coarse as number[][] | number[], c.cols as number))
      const got = kdeLayers(m, c.sig_n as number, optsOf(c.opts as Record<string, unknown>))
      expect([...got.labels]).toEqual(c.labels)
      // 「有几层」是 `FindFlatRegion` 用来决定同层约束开不开的那个数 ——
      // 标签相等它自然相等，单独钉一次是因为**它才是下游读的东西**。
      expect(new Set(got.labels).size).toBe(c.n_unique)
    })
  }
})

/** 金样里 `coarse` 是嵌套 list；这里统一成行表。 */
function chunk(v: number[][] | number[], cols: number): number[][] {
  if (Array.isArray(v[0])) return v as number[][]
  const flat = v as number[]
  const out: number[][] = []
  for (let i = 0; i < flat.length; i += cols) out.push(flat.slice(i, i + cols))
  return out
}
