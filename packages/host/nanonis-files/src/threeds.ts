/**
 * Nanonis `.3ds` —— 网格谱（grid spectroscopy）。
 *
 * 布局：CRLF 文本头 → `\r\n:HEADER_END:\r\n` → 二进制块。每个像素是一串
 * 大端 float32：`[逐像素参数 × num_params, 通道 0 的整条 sweep, 通道 1 …]`。
 *
 * ## 扫描轴不在头里
 *
 * V5e 的头**不写** bias 轴。前两个逐像素参数叫 `Sweep Start` / `Sweep End`
 * （名字在头的 `Fixed parameters` 里），从像素 (0,0) 读出来再 `linspace` 重建。
 * 两者都读不到 ⇒ 退回 `0..1` —— 那是一个**明显假**的轴，比一个看着像真的假轴好。
 *
 * ## 每一个头声明的维度都要 `<= 0` 拦一道
 *
 * 一个负的 `grid_dim` 或 `Points` 会让 `np.zeros` 抛「negative dimensions」，
 * 一个荒谬的大网格会让它抛 `MemoryError`。这里把两者都表示成**「没数据」**
 * 或一次**说得清的拒绝**，而不是让调用方收到一句底层异常。
 *
 * ## 截断：**尾部像素补零**，形状契约不变
 *
 * ⚠️ 这与 `.sxm`（丢帧）和 `.npy`（抛）**都不一样**，三种格式三种策略。
 * 照移是因为金样如此，但**它是三者里最危险的一个**：补零补出来的是一片
 * 「谱强度恒为零」的区域，而那在自动流程里看起来像一块真实的、干净的样品。
 * 建议给它加一条变异演练与一条 deviation，见 `docs/handoff/nanonis-files.md`。
 */
import { linspace } from 'dsh-spm-kernel'
import { assertReadableSize, decodeHeaderText, indexOfBytes, pyFloat, readBigEndianFloat32, MAX_GRID_ELEMENTS } from './common.js'

export interface ThreeDsHeader {
  readonly [key: string]: unknown
  readonly grid_dim?: readonly [number, number]
  readonly points?: number
  readonly num_parameters?: number
  readonly num_channels?: number
  readonly channels?: readonly string[]
  readonly fixed_parameters?: readonly string[]
  readonly experiment_parameters?: readonly string[]
}

export interface ThreeDsFile {
  readonly header: ThreeDsHeader
  /** `(ny, nx, n_points)` 的**第一个通道**。外层是 y，中层是 x。 */
  readonly grid: readonly (readonly Float64Array[])[]
  readonly params: {
    readonly nx: number
    readonly ny: number
    readonly n_points: number
    readonly fixed_param_names: readonly string[]
    readonly experiment_param_names: readonly string[]
    /** `(ny, nx, num_params)`；`num_params === 0` 时是 `null`。 */
    readonly param_array: readonly (readonly Float64Array[])[] | null
  } | Record<string, never>
  /** 扫描轴，`n_points` 个点。 */
  readonly bias: Float64Array
}

const MARKER_CRLF = new TextEncoder().encode('\r\n:HEADER_END:\r\n')
const MARKER_BARE = new TextEncoder().encode(':HEADER_END:')

/** 解析 `.3ds` 的头。`key=value`，值上可能裹一层双引号。 */
export function parse3dsHeader(raw: string): ThreeDsHeader {
  const header: Record<string, unknown> = {}
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim().replace(/\r+$/, '')
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const keyRaw = line.slice(0, eq)
    let val = line.slice(eq + 1).trim()
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    const key = keyRaw.trim().toLowerCase()

    if (key.startsWith('# parameters')) {
      // 旧仓这里是 `int(val)` —— **`"2.0"` 是要抛的**，所以这里用整数正则
      // 而不是 pyFloat + trunc：后者会把一个写错的 `2.7` 悄悄收成 2。
      if (/^[+-]?\d+$/.test(val)) header['num_parameters'] = Number(val)
      continue
    }
    if (key === 'grid dim') {
      const parts = val.replaceAll('x', ' ').split(/\s+/).filter((t) => t !== '')
      if (parts.length >= 2 && /^[+-]?\d+$/.test(parts[0] as string) && /^[+-]?\d+$/.test(parts[1] as string)) {
        header['grid_dim'] = [Number(parts[0]), Number(parts[1])]
      }
      continue
    }
    if (key === 'points') {
      if (/^[+-]?\d+$/.test(val)) header['points'] = Number(val)
      continue
    }
    if (key === 'channels') {
      const list = val.split(';').map((c) => c.trim()).filter((c) => c !== '')
      header['channels'] = list
      header['num_channels'] = list.length
      continue
    }
    if (key === 'fixed parameters') {
      header['fixed_parameters'] = val.split(';').map((p) => p.trim()).filter((p) => p !== '')
      continue
    }
    if (key === 'experiment parameters') {
      header['experiment_parameters'] = val.split(';').map((p) => p.trim()).filter((p) => p !== '')
      continue
    }
    if (key === 'sweep start' || key === 'sweep end') {
      const v = pyFloat(val)
      if (v !== null) header[key.replaceAll(' ', '_')] = v
      continue
    }
    header[key.replaceAll(' ', '_')] = val
  }
  return header as ThreeDsHeader
}

const emptyResult = (header: ThreeDsHeader): ThreeDsFile => ({
  header, grid: [], params: {}, bias: new Float64Array(0),
})

/** 读一个 `.3ds`。**找不到 `:HEADER_END:` 就抛**。 */
export function read3ds(bytes: Uint8Array, what = '<3ds>'): ThreeDsFile {
  assertReadableSize(bytes.byteLength, what)
  let end = indexOfBytes(bytes, MARKER_CRLF)
  let markerLength = MARKER_CRLF.length
  if (end < 0) {
    end = indexOfBytes(bytes, MARKER_BARE)
    markerLength = MARKER_BARE.length
  }
  if (end < 0) throw new Error(`Cannot find header end in ${what}`)

  const header = parse3dsHeader(decodeHeaderText(bytes.subarray(0, end)))
  const data = bytes.subarray(end + markerLength)

  const gridDim = header.grid_dim ?? [1, 1]
  const nx = gridDim[0]
  const ny = gridDim[1]
  const nPoints = header.points ?? 0
  const nParams = header.num_parameters ?? 0
  const nChannels = header.num_channels ?? 1

  // 每一个头声明的维度都先拦一道 —— 负数与零都走「没数据」，不是崩
  if (nPoints <= 0 || nx <= 0 || ny <= 0) return emptyResult(header)
  if (nParams < 0 || nChannels <= 0) return emptyResult(header)

  const floatsPerPoint = nParams + nChannels * nPoints
  const pointBytes = floatsPerPoint * 4
  const declaredPixels = nx * ny
  const gridElements = declaredPixels * nPoints
  if (gridElements > MAX_GRID_ELEMENTS) {
    throw new RangeError(
      `3ds header declares ${gridElements} grid elements (nx=${nx}, ny=${ny}, ` +
        `points=${nPoints}), exceeding the ${MAX_GRID_ELEMENTS}-element safety limit ` +
        `in ${what}. Header is likely corrupt; refusing to allocate.`,
    )
  }
  const availablePixels = pointBytes > 0 ? Math.floor(data.length / pointBytes) : 0
  if (availablePixels <= 0) return emptyResult(header)

  const grid: Float64Array[][] = []
  const paramArray: Float64Array[][] | null = nParams > 0 ? [] : null
  for (let iy = 0; iy < ny; iy++) {
    const gRow: Float64Array[] = []
    const pRow: Float64Array[] = []
    for (let ix = 0; ix < nx; ix++) {
      gRow.push(new Float64Array(nPoints))
      if (paramArray !== null) pRow.push(new Float64Array(nParams))
    }
    grid.push(gRow)
    if (paramArray !== null) paramArray.push(pRow)
  }

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const offset = (iy * nx + ix) * pointBytes
      // 块到头了：**剩下的像素留零**（见文件抬头那条警告）。
      // 跳出的是内层 —— 与旧仓 `break` 同形。
      if (offset + pointBytes > data.length) break
      const values = readBigEndianFloat32(data, offset, floatsPerPoint)
      if (paramArray !== null) {
        (paramArray[iy] as Float64Array[])[ix]?.set(values.subarray(0, nParams))
      }
      ;(grid[iy] as Float64Array[])[ix]?.set(values.subarray(nParams, nParams + nPoints))
    }
  }

  // 扫描轴：先看头里的 sweep_start/end（老固件），否则从像素 (0,0) 的固定参数读
  const fixedNames = header.fixed_parameters ?? []
  let start = typeof header['sweep_start'] === 'number' ? (header['sweep_start'] as number) : null
  let end2 = typeof header['sweep_end'] === 'number' ? (header['sweep_end'] as number) : null
  if ((start === null || end2 === null) && paramArray !== null) {
    const iStart = fixedNames.indexOf('Sweep Start')
    const iEnd = fixedNames.indexOf('Sweep End')
    const p00 = (paramArray[0] as Float64Array[])[0]
    if (iStart >= 0 && iEnd >= 0 && p00 !== undefined && iStart < p00.length && iEnd < p00.length) {
      start = p00[iStart] as number
      end2 = p00[iEnd] as number
    }
  }
  if (start === null || end2 === null) {
    start = 0.0
    end2 = 1.0
  }
  // `np.linspace` 的逐位等价实现借的是 kernel 的那一份 —— 它最后一行是
  // `y[-1] = stop` 而不是 `start + i*step`，那一行差着一个 ulp，而这里差的是
  // 谱的**端点电压**。不在本包重写一遍：两份 linspace 必然有一天分叉。
  const bias = Float64Array.from(linspace(start, end2, nPoints))

  return {
    header,
    grid,
    params: {
      nx, ny, n_points: nPoints,
      fixed_param_names: [...fixedNames],
      experiment_param_names: [...(header.experiment_parameters ?? [])],
      param_array: paramArray,
    },
    bias,
  }
}
