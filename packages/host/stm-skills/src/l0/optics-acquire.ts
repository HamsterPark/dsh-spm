/**
 * `AcquireSignalPoint` —— 在**当前**光学位置上读一组 Nanonis 信号并做软件平均。
 *
 * ## 它为什么在这里，而不在「架构上不要的那一档」里
 *
 * 分派单把 `builtins.optics_scan` 的两个技能都记成 D 档（压着
 * `mast/instruments/` 那 2113 行四家 DLL 驱动）。**这一个不是。** 逐行核过：
 *
 * | 核的是 | 结果 |
 * |---|---|
 * | `optics_scan.py:100-132`（`execute` 全文） | **一次 `get_instrument_registry` 都没有**。对照同文件 `OpticalStageScan.execute:303` —— 它在 `:314` 就取 registry |
 * | 可达调用面 | 三个函数，全在 `optics_acquire.py`：`parse_indices`(`:37-48`) · `PointAcquirer.__init__`(`:148-165`) · `acquire`(`:208-254`)；`acquire` 往下只调同文件两个纯函数 `nanonis_scalar`(`:51-70`) 与 `mean_std`(`:92-100`) |
 * | I/O | 全走 `context.safe_call("Current_Get")` 与 `safe_call("Signals_ValGet", xi, 0)` |
 * | 模块抬头 | `optics_acquire.py:10-11` 逐字：「**Nothing here touches the instruments registry** —— motion is the caller's job; this module only reads Nanonis through `context.safe_call`.」 |
 * | 唯一指向驱动层的东西 | 异常类 `InstrumentError`（`instruments/base.py:44-45`，`class InstrumentError(RuntimeError)` + 一句 docstring，**两行、无行为**） |
 *
 * ⇒ 判据本体 106 行（12+20+9+18+47），技能壳 27 行，**零 registry**。
 *
 * ⚠️ 但 `builtins.optics_scan` 这个模块**永远到不了 complete**：另一半
 * `OpticalStageScan` 是真 D 档。落这一个的收益是**技能数，不是模块数**
 * （先例：`paper.region_analysis`）。
 *
 * ## 两处与旧仓不同，都是本仓已判过的形状
 *
 * 1. **`InstrumentError` 这个类不搬。** 它在旧仓的全部作用是让
 *    `optics_scan.py:117` 的 `except (InstrumentError, ValueError)` 接得住
 *    `acquire` 抛的那几句话。本仓 `safeCall` **永不抛**（失败表达成
 *    `record.error`），于是这里直接在出错那一行返回 —— 措辞逐字照抄，
 *    而「抛一个名字来自驱动层的异常再自己接住」那一圈没有消费方。
 * 2. **`no numeric value in Nanonis reply: …` 印的是 body，不是回包 repr**
 *    —— D-SKILL-2 同一条：旧仓印的 `record.return_value` 是三段信封
 *    `(error, raw_bytes, [values])`，而本仓信封在 wire 层就拆掉了。
 *    为了逐字去伪造一个不存在的信封，等于让诊断指向一门这里没有在跑的语言。
 */
import type { Skill, SkillCallRecord, SkillContext, SkillResultLike } from 'dsh-spm-kernel'
import { formatG, pySum } from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { body, fail, ok } from './common.js'

/**
 * `parse_indices` —— 逗号／空格分隔的信号槽位串 → 去重保序的整数表。
 *
 * ⚠️ 旧仓的 docstring 说「each clamped to the valid 0-127 slot range」，
 * 而代码写的是 `if 0 <= idx <= 127 and idx not in out` —— **越界的被丢掉，
 * 不是夹回来**。照代码移，不照 docstring 移；两者不一致这件事记在这里。
 *
 * `int(tok)` 只认整数字面量：`'5.0'` 抛 `ValueError` ⇒ 被 `continue` 吃掉。
 */
export function parseIndices(text: unknown): number[] {
  const out: number[] = []
  for (const tok of String(text ?? '').replace(/,/g, ' ').split(/\s+/)) {
    if (tok === '') continue
    // Python 的 `int(tok)`：可选正负号 + 纯数字，前后空白已由 split 吃掉。
    if (!/^[+-]?\d+$/.test(tok)) continue
    const idx = Number.parseInt(tok, 10)
    if (idx >= 0 && idx <= 127 && !out.includes(idx)) out.push(idx)
  }
  return out
}

/**
 * `nanonis_scalar` —— 单标量回包里的那个数。
 *
 * 先序遍历，**第一个数就是答案**；布尔跳过（Python 的 `isinstance(True, int)`
 * 为真，所以旧仓专门先挡了一次 `bool`）。
 *
 * 取不出数时**抛**，与旧仓同形：这是「读不到」与「读到 0」的分界，
 * 而 `mean_std` 对一个缺席的读数没有任何说法。调用方（`acquire`）把它
 * 翻成一句拒绝。
 */
export function nanonisScalar(rec: SkillCallRecord): number {
  const stack: unknown[] = [body(rec)]
  while (stack.length > 0) {
    const item = stack.shift()
    if (typeof item === 'boolean') continue
    if (typeof item === 'number') return item
    if (Array.isArray(item)) stack.unshift(...item)
  }
  // D-SKILL-2：印 body，不印 Python 的三段信封 repr。
  throw new RangeError(`no numeric value in Nanonis reply: ${JSON.stringify(body(rec))}`)
}

/**
 * `mean_std` —— 均值与**样本**标准差（`ddof=1`）。
 *
 * `n === 0` 给 `(nan, nan)`，`n === 1` 给 `(mean, 0.0)`。照移：
 * 一个点的「散布是 0」与「散布不知道」在旧仓这里是同一个答案，
 * 而改掉它会动到 `current_std` 这一列的含义。
 *
 * ⚠️ **两次求和都走 `pySum`（Neumaier 补偿）**，因为旧仓这里用的是**内建 `sum()`**，
 * 而 CPython 3.12 起它对浮点走补偿求和（不是顺序累加，也不是 numpy 的成对）。
 * 第一版顺序累加，`[0.2, 0.4, 0.6]` 的均值就差了一位
 * （`0.4000000000000001` vs `0.39999999999999997`）——
 * 而那一位会一路进 `sig14_mean`、进摘要里的 `%.4g`。
 * `stats.ts` 的抬头写着同一条：**一个仓里只能有一个 `sum`**。
 */
export function meanStd(values: readonly number[]): readonly [number, number] {
  const n = values.length
  if (n === 0) return [Number.NaN, Number.NaN]
  const mean = pySum(values) / n
  if (n === 1) return [mean, 0.0]
  const sq = values.map((v) => (v - mean) ** 2)
  return [mean, (pySum(sq) / (n - 1)) ** 0.5]
}

/** Python 的 `params.get(k, True)` + `bool(…)`：键缺席才是 `True`。 */
function optBool(params: Readonly<Record<string, unknown>>, key: string, dflt: boolean): boolean {
  const v = params[key]
  if (v === undefined) return dflt
  if (typeof v === 'boolean') return v
  if (v === null) return false
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  return true
}

/** Python 的 `int(params.get(k, d))`。 */
function optInt(params: Readonly<Record<string, unknown>>, key: string, dflt: number): number {
  const v = params[key]
  if (v === undefined || v === null) return Math.trunc(dflt)
  return Math.trunc(Number(v))
}

/** Python 的 `float(params.get(k, d))`。 */
function optFloat(params: Readonly<Record<string, unknown>>, key: string, dflt: number): number {
  const v = params[key]
  if (v === undefined || v === null) return dflt
  return Number(v)
}

export const AcquireSignalPoint: Skill = {
  spec: S.AcquireSignalPointSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const readCurrent = optBool(params, 'read_current', true)
    const indices = parseIndices(params['signal_indices'] ?? '')
    if (!readCurrent && indices.length === 0) {
      return fail('nothing to acquire: enable read_current or add signal_indices')
    }
    const samples = optInt(params, 'samples', 10)
    const intervalS = optFloat(params, 'sample_interval_s', 0.01)

    const cur: number[] = []
    const extra = new Map<number, number[]>(indices.map((xi) => [xi, []]))
    for (let k = 0; k < samples; k += 1) {
      // `if k and self.interval_s > 0` —— 第 0 次不等（旧仓 `acquire:219-220`）。
      if (k !== 0 && intervalS > 0) await ctx.sleep(intervalS * 1000)
      if (readCurrent) {
        const rec = await ctx.safeCall('Current_Get')
        if (rec.error !== undefined && rec.error !== '') {
          return fail(`Current_Get failed: ${rec.error}`)
        }
        try {
          cur.push(nanonisScalar(rec))
        } catch (exc) {
          return fail(exc instanceof Error ? exc.message : String(exc))
        }
      }
      for (const xi of indices) {
        const rec = await ctx.safeCall('Signals_ValGet', xi, 0)
        if (rec.error !== undefined && rec.error !== '') {
          return fail(`Signals_ValGet(${xi}) failed: ${rec.error}`)
        }
        try {
          extra.get(xi)!.push(nanonisScalar(rec))
        } catch (exc) {
          return fail(exc instanceof Error ? exc.message : String(exc))
        }
      }
    }

    const row: Record<string, unknown> = {}
    if (readCurrent) {
      const [m, s] = meanStd(cur)
      row['current_a'] = m
      row['current_std'] = s
    }
    for (const xi of indices) {
      const [m, s] = meanStd(extra.get(xi)!)
      row[`sig${xi}_mean`] = m
      row[`sig${xi}_std`] = s
    }
    row['n_samples'] = samples

    const bits: string[] = []
    if (readCurrent && 'current_a' in row) bits.push(`I=${formatG(row['current_a'] as number, 4)} A`)
    for (const xi of indices) bits.push(`s${xi}=${formatG(row[`sig${xi}_mean`] as number, 4)}`)
    return ok(row, `acquired ${bits.length > 0 ? bits.join(', ') : 'point'}`)
  },
}

/** 这一族（`builtins.optics_scan` 的 A 档那一半）。 */
export const OPTICS_ACQUIRE: Readonly<Record<string, Skill>> = { AcquireSignalPoint }
