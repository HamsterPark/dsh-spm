/**
 * `batch-regions.ts` 里技能层排不出来的那几格，外加**那三处「与 `ParseRegions`
 * 刻意不同」的钉子**。
 *
 * 后者才是这个文件真正的理由：两份区域校验的边界值一模一样（±1 mm、
 * 1e-10…1e-5 m、最多 64 个），于是「它们是同一份」这个念头迟早会出现。
 * 这里把**答案不同的那三格**钉住 —— 合并时它们会当场变红。
 */
import { describe, expect, it } from 'vitest'
import { BATCH_REGIONS_MAX, resolveRegionLineTime, validateBatchRegions } from './batch-regions.js'
import { validateRegions } from './scan-regions.js'
import { tierForSize } from './scan-policy.js'

const region = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  center_x_m: 0,
  center_y_m: 0,
  width_m: 5e-8,
  height_m: 5e-8,
  ...extra,
})

describe('与 `ParseRegions` **答案不同**的三格（合并会让它们变红）', () => {
  it('① 空数组：这里拒，`ParseRegions` 放行', () => {
    const mine = validateBatchRegions([])
    expect(mine.ok).toBe(false)
    expect(mine.ok === false && mine.error).toBe('regions array is empty.')
    expect(validateRegions([]).ok).toBe(true)
  })

  it('② 空 `label`：这里退回 `R{i+1}`（Python 的 `or`），`ParseRegions` 留着空串', () => {
    const mine = validateBatchRegions([region({ label: '' })])
    expect(mine.ok === true && mine.regions[0]?.label).toBe('R1')
    const theirs = validateRegions([region({ label: '' })])
    expect(theirs.ok === true && theirs.regions[0]?.label).toBe('')
  })

  it('③ 坏字段的**报错粒度**：这里一句，`ParseRegions` 把 Python 异常原文拼进去', () => {
    const mine = validateBatchRegions([region({ width_m: undefined })])
    expect(mine.ok === false && mine.error).toBe(
      'region #0 needs numeric center_x_m, center_y_m, width_m, height_m (in meters).',
    )
    const theirs = validateRegions([{ center_x_m: 0, center_y_m: 0, height_m: 5e-8 }])
    // 那一份印的是 `KeyError` 的 `repr(key)` —— 三种坏法三句话
    expect(theirs.ok === false && theirs.error).toContain("'width_m'")
  })
})

describe('技能层排不出来的边角', () => {
  it('超过上限：报的是**看到了几个**，不是一句「太多了」', () => {
    const many = Array.from({ length: BATCH_REGIONS_MAX + 1 }, () => region())
    const got = validateBatchRegions(many)
    expect(got.ok === false && got.error).toBe(
      `too many regions (${BATCH_REGIONS_MAX + 1} > ${BATCH_REGIONS_MAX}).`,
    )
  })

  it('`label` 的假值一族（Python 的 `or`）：`null` / `false` / `0` 全退回 `R{i+1}`', () => {
    for (const label of [null, false, 0, '']) {
      const got = validateBatchRegions([region({ label })])
      expect(got.ok === true && got.regions[0]?.label).toBe('R1')
    }
    // 空表与空字典同样是假值（JSON 里传得到）
    for (const label of [[], {}]) {
      const got = validateBatchRegions([region({ label })])
      expect(got.ok === true && got.regions[0]?.label).toBe('R1')
    }
    // 真值照用，而且走 `str()`：数字与布尔都印成 Python 的写法
    const seven = validateBatchRegions([region({ label: 7 })])
    expect(seven.ok === true && seven.regions[0]?.label).toBe('7')
    const yes = validateBatchRegions([region({ label: true })])
    expect(yes.ok === true && yes.regions[0]?.label).toBe('True')
  })

  it('`angle_deg` 的 `or 0.0`：假值当 0，而**坏值会抛**（照移的钝处）', () => {
    const zeroish = validateBatchRegions([region({ angle_deg: null })])
    expect(zeroish.ok === true && zeroish.regions[0]?.angle_deg).toBe(0)
    // ⚠️ 四个必填字段给一条 `success=False`，第五个给一次**异常** —— 见登记
    expect(() => validateBatchRegions([region({ angle_deg: '北' })])).toThrow()
  })

  it('不是对象的那一项：报的是**第几个**', () => {
    const got = validateBatchRegions([region(), 3])
    expect(got.ok === false && got.error).toBe('region #1 is not an object.')
  })
})

describe('`resolveRegionLineTime`：与 `resolveLineTime` **刻意不同**', () => {
  it('没给显式值 ⇒ 按**这个区域自己的**尺寸查档（两个尺寸给两个答案）', () => {
    const small = resolveRegionLineTime(null, 5e-8)
    const big = resolveRegionLineTime(null, 2e-6)
    expect(small).toBe(tierForSize(5e-8).lineTimeS)
    expect(big).toBe(tierForSize(2e-6).lineTimeS)
    expect(small).not.toBe(big)
  })

  it('给了就用给的 —— **包括 0 与负数**（`resolveLineTime` 会把它们当没给）', () => {
    expect(resolveRegionLineTime(0, 5e-8)).toBe(0)
    expect(resolveRegionLineTime(-1, 5e-8)).toBe(-1)
  })

  it('给了但转不动 ⇒ 落回档位表（旧仓 `except (TypeError, ValueError): pass`）', () => {
    expect(resolveRegionLineTime('很快', 5e-8)).toBe(tierForSize(5e-8).lineTimeS)
  })
})
