/**
 * `BatchRegionsScan` 的两件纯判据：**区域清单校验**与**逐区查档**。零 I/O、零 numpy。
 *
 * ## 它与 `ParseRegions`（`scan-regions.ts`）**不是同一份实现**，别合并
 *
 * 两边的边界值一模一样（`±1 mm`、`1e-10…1e-5 m`、最多 64 个），措辞与**报错的粒度**
 * 却不同，而不同的那一半正是判据：
 *
 * | | `ParseRegions` | 这里 |
 * |---|---|---|
 * | 四个必填字段坏了 | 把 Python `float()` 的**异常原文**拼进报文（缺字段 / 值不对 / 类型不对，三句话） | 一句 `region #i needs numeric …`，**不分三种** |
 * | `label` 缺省 | `"label" in rec` —— 显式的 `""` 会留下来 | `str(it.get("label") or f"R{i+1}")` —— **空串、0、False 都退回 `R{i+1}`** |
 * | `angle_deg` | `float(r.get("angle_deg", 0.0))` | `float(it.get("angle_deg", 0.0) or 0.0)` —— **多一个 `or`**，于是 `None` 与 `0` 都变 `0.0` |
 * | 空数组 | 合法（零个区域） | **拒绝**（`regions array is empty.`） |
 *
 * 合并会让至少三格的答案变掉，而其中两格（`label` 的 `or`、空数组）正是这个技能
 * 写给操作员的那一句。所以两份并存，两份都钉住。
 *
 * ## `angle_deg` 那一句**在 try 外面**（与 `ParseRegions` 同一处照移的钝处）
 *
 * 旧仓 `batch_regions_scan.py:180`：`ang = float(it.get("angle_deg", 0.0) or 0.0)`
 * 写在捕获 `KeyError/TypeError/ValueError` 的 `try` **之后**。于是一个
 * `angle_deg: "北"` 不是「被拒」，是**抛出去**。照移，欠账记在交接里 ——
 * 要修的话，修的是旧仓。
 */
import { REGION_CENTER_LIMIT_M, REGION_SIZE_MAX_M, REGION_SIZE_MIN_M, pyFloatOrThrow } from './scan-regions.js'
import { tierForSize } from './scan-policy.js'

/** 一次最多接多少个区域。**与 `ParseRegions` 同值，但那是巧合不是共用**。 */
export const BATCH_REGIONS_MAX = 64

/** 归一化之后的一个区域。 */
export interface BatchRegion {
  readonly center_x_m: number
  readonly center_y_m: number
  readonly width_m: number
  readonly height_m: number
  readonly angle_deg: number
  readonly label: string
}

/** 解析结果：一串区域，或者一句拒绝（`error` **逐字**，它是模型读的东西）。 */
export type BatchRegionsParse =
  | { readonly ok: true; readonly regions: readonly BatchRegion[] }
  | { readonly ok: false; readonly error: string }

/**
 * 校验并归一化**已经解析出来的** JSON 值（数组）。
 *
 * `json.loads` 那一步不在这里：Python 的 `json` 与 V8 的 `JSON.parse` 措辞完全不同，
 * 调用方负责解析并拼 `regions is not valid JSON: …`（见 deviation）。
 */
export function validateBatchRegions(data: unknown): BatchRegionsParse {
  if (!Array.isArray(data)) {
    return { ok: false, error: 'regions must be a JSON array (list) of region objects.' }
  }
  if (data.length === 0) return { ok: false, error: 'regions array is empty.' }
  if (data.length > BATCH_REGIONS_MAX) {
    return { ok: false, error: `too many regions (${data.length} > ${BATCH_REGIONS_MAX}).` }
  }
  const out: BatchRegion[] = []
  for (let i = 0; i < data.length; i += 1) {
    const it = data[i] as unknown
    if (it === null || typeof it !== 'object' || Array.isArray(it)) {
      return { ok: false, error: `region #${i} is not an object.` }
    }
    const rec = it as Record<string, unknown>
    let cx: number
    let cy: number
    let w: number
    let h: number
    try {
      // 四个一起包在一个 try 里 —— **报文因此不分三种**（见文件抬头）。
      cx = required(rec, 'center_x_m')
      cy = required(rec, 'center_y_m')
      w = required(rec, 'width_m')
      h = required(rec, 'height_m')
    } catch {
      return {
        ok: false,
        error:
          `region #${i} needs numeric center_x_m, center_y_m, ` +
          'width_m, height_m (in meters).',
      }
    }
    // ⚠️ **不在 try 里**，而且多一个 `or 0.0`（见文件抬头）。
    const ang = pyFloatOrThrow(pyOr(rec['angle_deg'] ?? 0.0, 0.0))
    if (!(Math.abs(cx) <= REGION_CENTER_LIMIT_M && Math.abs(cy) <= REGION_CENTER_LIMIT_M)) {
      return {
        ok: false,
        error:
          `region #${i} center out of range (|x|,|y| must be ` +
          `≤ ${expZero(REGION_CENTER_LIMIT_M)} m); check meters vs nm.`,
      }
    }
    if (
      !(REGION_SIZE_MIN_M <= w && w <= REGION_SIZE_MAX_M &&
        REGION_SIZE_MIN_M <= h && h <= REGION_SIZE_MAX_M)
    ) {
      return {
        ok: false,
        error:
          `region #${i} size out of range (${expZero(REGION_SIZE_MIN_M)}–` +
          `${expZero(REGION_SIZE_MAX_M)} m); check meters vs nm.`,
      }
    }
    out.push({
      center_x_m: cx,
      center_y_m: cy,
      width_m: w,
      height_m: h,
      angle_deg: ang,
      label: labelOf(rec['label'], i),
    })
  }
  return { ok: true, regions: out }
}

/**
 * 单个区域的每线时间：**显式优先，否则按这个区域自己的尺寸查档位表**。
 *
 * 逐区查档不是讲究：一个批次里的区域尺寸可以差很多，给它们同一个速度，
 * 对其中大多数都是错的。
 *
 * ⚠️ 与 {@link ./scan-policy.ts | resolveLineTime} **刻意不同**：那一个要求
 * `explicit > 0`，这一个照旧仓 `float(explicit)` —— 只要转得动就直接用，
 * **包括 0 与负数**。两条规矩并存是旧仓的事实；统一它会让 `speed` 那一行的
 * `if line_time > 0 else 200e-9` 兜底永远走不到，而那正是它存在的理由。
 */
export function resolveRegionLineTime(explicit: unknown, regionSizeM: number): number {
  if (explicit !== null && explicit !== undefined) {
    try {
      return pyFloatOrThrow(explicit)
    } catch {
      /* `float()` 转不动 ⇒ 落到档位表（旧仓 `except (TypeError, ValueError): pass`） */
    }
  }
  const t = tierForSize(regionSizeM).lineTimeS
  return Number.isFinite(t) ? t : 0.1
}

/** `it[key]`，缺了或转不动都抛 —— 调用方只需要知道「这四个里有一个不行」。 */
function required(rec: Record<string, unknown>, key: string): number {
  if (!(key in rec)) throw new RangeError(key)
  return pyFloatOrThrow(rec[key])
}

/**
 * Python 的 `x or y`：**假值**（`None` / `False` / `0` / `''` / `[]` / `{}`）走右边。
 *
 * 这一条在 `angle_deg` 与 `label` 上各出现一次，而它在两处的后果不同：
 * `angle_deg` 是数（`0 or 0.0` 仍是 0.0，无差别），`label` 是串
 * （`'' or 'R1'` ⇒ `'R1'`，**一个显式的空标签会被换掉**）。
 */
function pyOr(v: unknown, dflt: unknown): unknown {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return dflt
  if (Array.isArray(v) && v.length === 0) return dflt
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return dflt
  return v
}

/**
 * `str(it.get("label") or f"R{i+1}")`。
 *
 * ⚠️ **没有 `null` 那一支**（与 `scan-regions.ts` 的 `pyLabel` 不同）：那边是
 * `str(r.get("label", 缺省))`，`None` 会原样走到 `str()` 变成 `'None'`；
 * 这边多一个 `or`，于是 `None` 在 {@link pyOr} 就被换成了 `R{i+1}` ——
 * 那一支**走不到**，所以不写（写了就是一条永远不亮的分支）。
 */
function labelOf(raw: unknown, i: number): string {
  const v = pyOr(raw ?? null, `R${i + 1}`)
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/**
 * Python 的 `f"{x:.0e}"` —— 报文里那两个界印的就是它（`1e-03` / `1e-10` / `1e-05`）。
 *
 * JS 的 `toExponential(0)` 给 `1e-3`（指数不补零），而 Python 补到两位。
 * 这一个差别只出现在两句拒绝里，但那两句正是操作员会照着改参数的那两句。
 */
function expZero(v: number): string {
  const s = v.toExponential(0)
  const i = s.indexOf('e')
  const mant = s.slice(0, i)
  const exp = Number(s.slice(i + 1))
  const abs = Math.abs(exp)
  return `${mant}e${exp < 0 ? '-' : '+'}${abs < 10 ? `0${abs}` : abs}`
}
