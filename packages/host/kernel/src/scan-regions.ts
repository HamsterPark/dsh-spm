/**
 * `ParseRegions` 的判据 —— **零 numpy、零 I/O**，所以它住在内核里。
 *
 * 这个技能存在的理由是声明式 composite 那一层**没有 JSON 解析器**
 * （`safe_eval` 只认数据），于是「操作员给一串区域，composite `foreach` 遍历」
 * 这件事得有人来做 `json.loads` + 边界检查。判据在这里，读参数与摆返回值
 * 在 `l0/scan-frame-offline.ts`。
 *
 * ## 报文逐字复刻 Python 的**异常文本**，这一条值得单说
 *
 * 旧仓把四个必填字段包在一个 `try` 里，报的是 `f"region {i} missing/bad field: {exc}"`
 * —— 也就是说**异常那句话本身就是模型读到的那句话**，而 Python 在三种情况下
 * 给三句不同的：
 *
 * | 输入 | 异常 | `str(exc)` |
 * |---|---|---|
 * | 字段不存在 | `KeyError` | `'width_m'`（**带引号**，那是 `repr(key)`） |
 * | 字符串转不动 | `ValueError` | `could not convert string to float: 'wide'` |
 * | 类型不对 | `TypeError` | `float() argument must be a string or a real number, not 'NoneType'` |
 *
 * 三句话区分的是三件不同的事（**缺**字段 / 字段**值**不对 / 字段**类型**不对），
 * 而调用方拿到的只有这一串。统一成一句「字段不合法」会把这三件事压成一件 ——
 * 于是 {@link pyFloatOrThrow} 把三句都照着写了出来。
 *
 * ## ⚠️ `angle_deg` 与 `label` **不在那个 try 里**
 *
 * 旧仓第 673 行：`"angle_deg": float(r.get("angle_deg", 0.0))` 写在 `out.append(...)`
 * 的参数里，**在 try 块外面**。于是一个坏 `angle_deg` 不是「被拒」，是**抛出去**——
 * 四个必填字段给一条 `success=False`，第五个给一次异常，而这两件事对调用方
 * 完全不是一回事。照移（金样 `raises_bad_angle` 钉着那一句），
 * 欠账记在交接里：要修的话，修的是旧仓。
 */

/** 一次最多接多少个区域。 */
export const REGIONS_MAX = 64
/** 中心坐标的绝对上限（米）。 */
export const REGION_CENTER_LIMIT_M = 1e-3
/** 边长下限（米）。 */
export const REGION_SIZE_MIN_M = 1e-10
/** 边长上限（米）。 */
export const REGION_SIZE_MAX_M = 1e-5

/** 归一化之后的一个区域。六个键**一个都不少**——这是这个技能对下游的全部承诺。 */
export interface ScanRegion {
  readonly center_x_m: number
  readonly center_y_m: number
  readonly width_m: number
  readonly height_m: number
  readonly angle_deg: number
  readonly label: string
}

/**
 * Python 在 `json.loads` 之后看到的**类型名** —— `float()` 的 TypeError 里印的是它。
 *
 * JSON 只能给出六种值，于是这张表是**完整的**（不是「常见的几种」）：
 * `null → NoneType` · `true/false → bool` · 数 → `int`/`float` · 串 → `str` ·
 * 数组 → `list` · 对象 → `dict`。
 *
 * ⚠️ `int` 与 `float` 的分界是 **JSON 的写法**，不是数值：`5e-08` 是 `float`，
 * `7` 是 `int`。而 JS 这一侧 `7` 与 `7.0` 是同一个值，分不出来 ——
 * 所以这里按「是不是整数」判，而 `float()` 对这两种**都不报错**，
 * 于是这个分岔走不到任何一条报文上。
 */
export function pyTypeName(v: unknown): string {
  if (v === null) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'string') return 'str'
  if (Array.isArray(v)) return 'list'
  return 'dict'
}

/** Python 的 `repr` 对一个 `str`：单引号。`KeyError` 印的就是它。 */
export function pyReprStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Python 的 `float(x)`，**连它抛的那句话一起**。见文件抬头那张表。
 *
 * 取不到值时抛一个 `RangeError`，`message` 就是 Python 的 `str(exc)` ——
 * 调用方把它拼进 `region {i} missing/bad field: {…}`。
 *
 * ⚠️ 字符串那一支照 Python 的 `float()` 语义：**前后空白照吃**，
 * `'inf'` / `'nan'` 是合法的浮点。JS 的 `Number('')` 给 0 而 Python 抛，
 * 所以空串单独挡一次 —— 一个静默变成 0 的宽度是这条路上最坏的结果
 * （它过得了下面那条下界检查吗？过不了。但如果哪天下界没了，它就是一条
 * 宽度为零的扫描框，而没有任何地方说过它来自一个空字符串）。
 */
export function pyFloatOrThrow(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const t = v.trim()
    if (t !== '') {
      const n = Number(t)
      if (Number.isFinite(n) || /^[+-]?(inf(inity)?|nan)$/i.test(t)) {
        return Number.isFinite(n) ? n : /nan/i.test(t) ? NaN : t.startsWith('-') ? -Infinity : Infinity
      }
    }
    throw new RangeError(`could not convert string to float: ${pyReprStr(v)}`)
  }
  throw new RangeError(
    `float() argument must be a string or a real number, not ${pyReprStr(pyTypeName(v))}`,
  )
}

/** Python 的 `str(x)` 用在 `label` 上。见 `l0/common.ts` 的 `pyStr` —— 这里多认两个字面量。 */
export function pyLabel(v: unknown): string {
  if (v === null) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/** 解析的结果：一串区域，或者一句拒绝。 */
export type RegionsParse =
  | { readonly ok: true; readonly regions: readonly ScanRegion[] }
  | { readonly ok: false; readonly error: string }

/**
 * 校验并归一化一串**已经解析出来的** JSON 值。
 *
 * `json.loads` 那一步**不在这里**：它的异常文本是解析器自己的（Python 的 `json`
 * 与 V8 的 `JSON.parse` 措辞完全不同），而那一句不是判据。调用方负责解析，
 * 解析失败时自己拼 `invalid regions JSON: …`。见 deviation。
 *
 * ⚠️ `angle_deg` 那一步**会抛**（见文件抬头）—— 这是照移，不是疏忽。
 */
export function validateRegions(data: unknown): RegionsParse {
  if (!Array.isArray(data)) return { ok: false, error: 'regions must be a JSON array' }
  if (data.length > REGIONS_MAX) {
    return { ok: false, error: `too many regions (${data.length} > ${REGIONS_MAX})` }
  }
  const out: ScanRegion[] = []
  for (let i = 0; i < data.length; i += 1) {
    const r = data[i] as unknown
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, error: `region ${i} is not an object` }
    }
    const rec = r as Record<string, unknown>
    let cx: number
    let cy: number
    let w: number
    let h: number
    try {
      // 顺序照抄旧仓：cx → cy → w → h，**第一个坏的那个决定报文**。
      cx = field(rec, 'center_x_m')
      cy = field(rec, 'center_y_m')
      w = field(rec, 'width_m')
      h = field(rec, 'height_m')
    } catch (e) {
      return { ok: false, error: `region ${i} missing/bad field: ${(e as Error).message}` }
    }
    if (Math.abs(cx) > REGION_CENTER_LIMIT_M || Math.abs(cy) > REGION_CENTER_LIMIT_M) {
      return { ok: false, error: `region ${i} center out of range (±${REGION_CENTER_LIMIT_M} m)` }
    }
    if (!(w >= REGION_SIZE_MIN_M && w <= REGION_SIZE_MAX_M) ||
        !(h >= REGION_SIZE_MIN_M && h <= REGION_SIZE_MAX_M)) {
      return { ok: false, error: `region ${i} size out of range` }
    }
    out.push({
      center_x_m: cx,
      center_y_m: cy,
      width_m: w,
      height_m: h,
      // ⚠️ **不在 try 里** —— 坏 `angle_deg` 抛出去，见文件抬头。
      angle_deg: pyFloatOrThrow('angle_deg' in rec ? rec['angle_deg'] : 0.0),
      label: pyLabel('label' in rec ? rec['label'] : `R${i + 1}`),
    })
  }
  return { ok: true, regions: out }
}

/** `r[key]`，不存在就抛一个 `KeyError` 形状的错。 */
function field(rec: Record<string, unknown>, key: string): number {
  if (!(key in rec)) throw new RangeError(pyReprStr(key))
  return pyFloatOrThrow(rec[key])
}
