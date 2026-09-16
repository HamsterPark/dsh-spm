/**
 * Nanonis 文件读取差分测试：逐项比较参考结果。
 *
 * 金样里的字节是合成的，读出来的东西是**旧仓真实读取器**给的
 * （见 `tools/spec-export/export_nanonis_files.py` 与 `index.ts` 的抬头）。
 * 预期值来自 Python 参考读取器对这些合成字节的实际解析结果。
 *
 * 除金样比较外，后续用例还验证等价输入表示的一致性。
 */
import { describe, expect, it } from 'vitest'
import { matToRows, type Mat } from 'dsh-spm-numerics'
import golden from '../../../../spec/golden/nanonis_files.json' with { type: 'json' }
import {
  MAX_FILE_BYTES,
  MAX_GRID_ELEMENTS,
  assertReadableSize,
  firstFloat,
  pyFloat,
} from './common.js'
import { parseSxmHeader, readSxm, readSxmHeaderOnly, rowsTopFirst, sxmFrameMeta, sxmOrientedFrames } from './sxm.js'
import { readDat } from './dat.js'
import { parse3dsHeader, read3ds } from './threeds.js'

// ── 把 TS 的结果摆成金样那个形状 ──────────────────────────────────────────

const isMat = (v: unknown): v is Mat =>
  typeof v === 'object' && v !== null && 'rows' in v && 'cols' in v && 'data' in v

/**
 * 与导出脚本的 `_plain` 一一对应。
 *
 * **非有限值走字符串占位**：金样是用 `allow_nan=False` 写的（`NaN` 不是合法
 * JSON），于是 `NaN` / `±Infinity` 在两边都必须是同一个字符串，否则一次
 * 「读出来是 NaN」与一次「这一格根本没读到」在 JSON 里长得一模一样。
 */
function plain(v: unknown): unknown {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN'
    if (v === Infinity) return 'Infinity'
    if (v === -Infinity) return '-Infinity'
    return v
  }
  if (v instanceof Float64Array || v instanceof Float32Array) return Array.from(v, plain)
  if (isMat(v)) return matToRows(v).map((row) => row.map(plain))
  if (Array.isArray(v)) return v.map(plain)
  if (v === null || v === undefined) return v
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined) continue // Python 那边缺的是**键**，不是一个 undefined 值
      out[k] = plain(x)
    }
    return out
  }
  return v
}

const bytesOf = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, 'base64'))

interface Case {
  readonly bytes_b64: string
  readonly read?: unknown
  readonly raised?: string
  readonly header_only?: unknown
  readonly frame_meta?: unknown
  readonly oriented?: unknown
}

const sxmCases = golden.sxm as unknown as Record<string, Case>
const datCases = golden.dat as unknown as Record<string, Case>
const tdsCases = golden['3ds'] as unknown as Record<string, Case>

/**
 * 金样里的 `raised` 长这样：`"ValueError: Cannot find header end in no_marker.3ds"`。
 *
 * 异常**类名**不比：Python 的 `ValueError` 在 TS 里没有对应物，硬造一个只是
 * 给这一条分支发明一套新词。**消息逐字比** —— 它是这条分支唯一的记录，而只要
 * 把 `what` 传成金样里的那个文件名，两边就该一个字不差。
 *
 * 用 `toBe` 而不是 `toThrowError(string)`：后者是**子串**匹配，
 * 于是把消息删掉一半照样绿。
 */
function expectSameRaise(fn: () => unknown, pyRaised: string): void {
  const want = pyRaised.slice(pyRaised.indexOf(': ') + 2)
  let got: unknown
  expect(() => {
    try {
      fn()
    } catch (e) {
      got = e
      throw e
    }
  }).toThrow()
  expect((got as Error).message).toBe(want)
}

// ── .sxm ────────────────────────────────────────────────────────────────

describe('.sxm —— 逐格对旧仓', () => {
  for (const [name, c] of Object.entries(sxmCases)) {
    it(name, () => {
      const bytes = bytesOf(c.bytes_b64)
      if (c.raised !== undefined) {
        expectSameRaise(() => readSxm(bytes, `${name}.sxm`), c.raised)
        return
      }
      const scan = readSxm(bytes, `<${name}>`)
      expect(plain(scan)).toEqual(c.read)
      expect(plain(readSxmHeaderOnly(bytes))).toEqual(c.header_only)
      expect(plain(sxmFrameMeta(scan.header))).toEqual(c.frame_meta)
      if (c.oriented !== undefined) {
        const channel = (c.oriented as { channel: string }).channel
        expect(plain(sxmOrientedFrames(scan, channel))).toEqual(c.oriented)
      }
    })
  }
})

// ── .dat ────────────────────────────────────────────────────────────────

describe('.dat —— 逐格对旧仓', () => {
  for (const [name, c] of Object.entries(datCases)) {
    it(name, () => {
      const bytes = bytesOf(c.bytes_b64)
      if (c.raised !== undefined) {
        expectSameRaise(() => readDat(bytes, `${name}.dat`), c.raised)
        return
      }
      expect(plain(readDat(bytes, `<${name}>`))).toEqual(c.read)
    })
  }
})

// ── .3ds ────────────────────────────────────────────────────────────────

/**
 * 金样那份字节里二进制块有多长。
 *
 * 用的是**金样自己的字节**和它自己的记号位置，不经本仓的读取器 —— 否则
 * 「缺几个像素」就成了拿被测对象去论证被测对象。
 */
function blobLength(b64: string): number {
  const buf = Buffer.from(b64, 'base64')
  for (const marker of ['\r\n:HEADER_END:\r\n', ':HEADER_END:']) {
    const at = buf.indexOf(Buffer.from(marker, 'latin1'))
    if (at >= 0) return buf.length - at - marker.length
  }
  return -1
}

/**
 * D-3DS-1：旧仓给**没写进来的像素**补 0，本仓补 NaN，另交
 * `pixels_written` / `pixels_missing` 两个数（理由见 `threeds.ts` 抬头）。
 *
 * 期望值**从金样算出来**而不是抄一遍，而且这里分成了两件事：
 *
 * - **「缺几个像素」不是偏差** —— 旧仓的循环也是「写不满一个像素就 `break`」，
 *   两边本来就同意。所以这一步从**金样的字节数 ÷ 金样的头**直接算，
 *   算完的数就是双方共同的事实；
 * - **偏差只在那几格里填什么**。于是下面先**断言金样里那几格确实全是 0**，
 *   再把它们换成 `NaN`。旧仓哪天自己改成 NaN、改成抛、或者改了 `break` 的位置，
 *   这条断言会当场变红 —— 这条登记不会悄悄过期成一句陈述句。
 */
function nanTail(c: Case): unknown {
  const read = structuredClone(c.read) as {
    header: Record<string, unknown>
    grid: unknown[][]
    params: Record<string, unknown>
  }
  // 头声明的维度就没过闸（`negative_dims`）⇒ 旧仓和我们都交空结果，没有偏差
  if (Object.keys(read.params).length === 0) return read

  const h = read.header
  const nPoints = (h['points'] as number | undefined) ?? 0
  const nParams = (h['num_parameters'] as number | undefined) ?? 0
  const nChannels = (h['num_channels'] as number | undefined) ?? 1
  const [nx, ny] = (h['grid_dim'] as [number, number] | undefined) ?? [1, 1]

  const pointBytes = (nParams + nChannels * nPoints) * 4
  const written = Math.min(nx * ny, Math.floor(blobLength(c.bytes_b64) / pointBytes))
  const paramArray = read.params['param_array'] as unknown[][] | null

  for (let flat = written; flat < nx * ny; flat++) {
    const iy = Math.floor(flat / nx)
    const ix = flat % nx
    // ← 这一句才是判据：旧仓在这一格补的是 0。它哪天不补了，这里当场红。
    expect(read.grid[iy]![ix]).toEqual(new Array(nPoints).fill(0))
    read.grid[iy]![ix] = new Array(nPoints).fill('NaN')
    if (paramArray !== null) {
      expect(paramArray[iy]![ix]).toEqual(new Array(nParams).fill(0))
      paramArray[iy]![ix] = new Array(nParams).fill('NaN')
    }
  }
  read.params['pixels_written'] = written
  read.params['pixels_missing'] = nx * ny - written
  return read
}

describe('.3ds —— 逐格对旧仓', () => {
  for (const [name, c] of Object.entries(tdsCases)) {
    it(name, () => {
      const bytes = bytesOf(c.bytes_b64)
      if (c.raised !== undefined) {
        expectSameRaise(() => read3ds(bytes, `${name}.3ds`), c.raised)
        return
      }
      expect(plain(read3ds(bytes, `<${name}>`))).toEqual(nanTail(c))
    })
  }
})

describe('3ds · D-3DS-1：没写进来的像素是 NaN，不是一块干净的样品', () => {
  it('金样里确实有一格是截断的 —— 否则上面那条登记什么也没验', () => {
    const c = tdsCases['truncated_blob']!
    const r = read3ds(bytesOf(c.bytes_b64), '<truncated_blob>')
    expect(r.params).toMatchObject({ pixels_written: 2, pixels_missing: 2 })
  })

  it('「网格没跑完」是一个读得到的数，不用调用方自己去数 NaN', () => {
    for (const [name, c] of Object.entries(tdsCases)) {
      if (c.raised !== undefined) continue
      const r = read3ds(bytesOf(c.bytes_b64), `<${name}>`)
      const p = r.params as Record<string, unknown>
      if (!('nx' in p)) continue
      const nans = r.grid.flat().filter((s) => s.every(Number.isNaN)).length
      expect(p['pixels_missing']).toBe(nans)
      expect((p['pixels_written'] as number) + nans).toBe(p['nx'] as number * (p['ny'] as number))
    }
  })
})

// ── 金样钉不住的那些判据 ─────────────────────────────────────────────────

describe('尺寸闸', () => {
  it('两个常数与旧仓同值', () => {
    expect(MAX_FILE_BYTES).toBe(golden.constants.max_file_bytes)
    expect(MAX_GRID_ELEMENTS).toBe(golden.constants.max_grid_elements)
  })

  it('刚好等于上限放行，多一个字节就拒 —— 闸是 `>` 不是 `>=`', () => {
    expect(() => assertReadableSize(MAX_FILE_BYTES)).not.toThrow()
    expect(() => assertReadableSize(MAX_FILE_BYTES + 1, 'big.sxm')).toThrow(/too large/)
  })
})

describe('pyFloat —— 与 readback 的 toFloat 刻意不同', () => {
  it('认 nan / inf：仪器在缺点位上写的就是它们，拒掉等于丢整行', () => {
    expect(pyFloat('NaN')).toBeNaN()
    expect(pyFloat(' -inf ')).toBe(-Infinity)
    expect(pyFloat('Infinity')).toBe(Infinity)
  })

  it('不认十六进制与下划线 —— `float("0x10")` 在 Python 里是抛的', () => {
    expect(pyFloat('0x10')).toBeNull()
    expect(pyFloat('1_000')).toBeNull()
    expect(pyFloat('')).toBeNull()
    expect(pyFloat('1.5e-3')).toBe(0.0015)
  })

  it('firstFloat 取头字段里的第一个数，取不出给 fallback', () => {
    expect(firstFloat('1.000000E-8           7.5E-9')).toBe(1e-8)
    expect(firstFloat('', 42)).toBe(42)
    expect(firstFloat(null, null)).toBeNull()
    // **0 是合法值**，不许被 fallback 吃掉（D-ZERO-1）
    expect(firstFloat('0.0', 99)).toBe(0)
  })
})

describe('sxm：读不到 ≠ 零 ≠ 否', () => {
  it('`:SCAN_PIXELS:` 解析不出整数时那个键不存在，不是 [0, 0]', () => {
    const h = parseSxmHeader(':SCAN_PIXELS:\n  abc  def\n')
    expect('scan_pixels' in h).toBe(false)
  })

  it('方向读不出来 ⇒ 原样返回，不当成 down', () => {
    const m = { rows: 2, cols: 1, data: Float64Array.from([1, 2]) }
    expect(matToRows(rowsTopFirst(m, undefined))).toEqual([[1], [2]])
    expect(matToRows(rowsTopFirst(m, null))).toEqual([[1], [2]])
    expect(matToRows(rowsTopFirst(m, '垃圾'))).toEqual([[1], [2]])
    expect(matToRows(rowsTopFirst(m, ' UP '))).toEqual([[2], [1]])
  })

  it('`readSxmHeaderOnly` 在上限之内找不到记号就交空头，不抛', () => {
    expect(readSxmHeaderOnly(bytesOf(sxmCases.basic!.bytes_b64), 8)).toEqual({})
    expect(readSxmHeaderOnly(new Uint8Array(0))).toEqual({})
  })
})

describe('3ds：每一个头声明的维度都拦一道', () => {
  it('`# Parameters` 是 `int()` 不是 `float()` —— `2.0` 不算数', () => {
    expect(parse3dsHeader('# Parameters (4 byte)=2\r\n').num_parameters).toBe(2)
    expect('num_parameters' in parse3dsHeader('# Parameters (4 byte)=2.0\r\n')).toBe(false)
  })

  it('`Grid dim` 解析不出两个整数时那个键不存在', () => {
    expect(parse3dsHeader('Grid dim="2 x 2"\r\n').grid_dim).toEqual([2, 2])
    expect('grid_dim' in parse3dsHeader('Grid dim="a x b"\r\n')).toBe(false)
    expect('grid_dim' in parse3dsHeader('Grid dim="4"\r\n')).toBe(false)
  })

  it('声明的网格大得离谱 ⇒ 说得清的拒绝，不是 numpy 深处的 MemoryError', () => {
    const head = 'Grid dim="100000 x 100000"\r\nPoints=1000\r\n' +
      'Channels="Current (A)"\r\n# Parameters (4 byte)=0\r\n:HEADER_END:\r\n'
    expect(() => read3ds(new TextEncoder().encode(head), 'huge.3ds'))
      .toThrow(/exceeding the .* safety limit/)
  })

  it('点数为零 ⇒ 空结果而不是崩', () => {
    const head = 'Grid dim="2 x 2"\r\nPoints=0\r\nChannels="Current (A)"\r\n:HEADER_END:\r\n'
    const r = read3ds(new TextEncoder().encode(head), 'zero.3ds')
    expect(r.grid).toEqual([])
    expect(r.params).toEqual({})
    expect(Array.from(r.bias)).toEqual([])
  })
})

describe('dat：一行坏行不该让整份数据消失', () => {
  it('众数宽度不被一条落单的坏行带偏', () => {
    const text = '[DATA]\nA\tB\n1\t2\n3\t4\n5\t6\t7\n'
    const r = readDat(new TextEncoder().encode(text))
    expect(Array.from(r.columns['A']!)).toEqual([1, 3, 5])
    expect(Array.from(r.columns['B']!)).toEqual([2, 4, 6])
    expect('column_2' in r.columns).toBe(false)
  })

  it('没有 `[DATA]` ⇒ 只有头，没有列 —— 不抛', () => {
    const r = readDat(new TextEncoder().encode('Date\t15.09.2026\n'))
    expect(r.header['Date']).toBe('15.09.2026')
    expect(r.columns).toEqual({})
  })
})
