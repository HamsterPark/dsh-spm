/**
 * `phase_shift`（批 7b-2）对 `spec/golden/batch7b2.json` 的 `phase_shift` 一节。
 *
 * **判据分两档**：
 *
 * | 量 | 容差 | 推导 |
 * |---|---|---|
 * | `dx` / `dy` | **0** | `argmax` 的下标减一个整数 —— 选错峰是选错格，不是差一点 |
 * | `snr` | {@link phaseShiftSnrRelTol} | 三次二维变换，每次 `fftRelTol(rows)+fftRelTol(cols)`，见 `phase-shift.ts` 抬头 |
 *
 * 实测占比（金样那八格里的最大值）：**0.30**（`shift_x_plus5`）。
 *
 * ⚠️ **这一节住在 `numerics` 而不是 `stm-skills`**，理由只有一条：`phase_shift`
 * 的变异要能用 `packages/host/numerics` 这个窄 scope 跑。判据与看着它的测试
 * 在同一个包里 —— 否则 `run.ts` 会判 `narrow-scope`（批 6c 的搬家那一课）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matFromRows } from './mat.js'
import { phaseShift, phaseShiftSnrRelTol } from './phase-shift.js'

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/batch7b2.json', import.meta.url)), 'utf8'),
) as Record<string, any>

/** 金样里 `{"__nan__": true}` 这个记号 —— `allow_nan=False` 装不下真的 NaN。 */
function frame(rows: unknown[]): ReturnType<typeof matFromRows> {
  return matFromRows(
    (rows as unknown[][]).map((r) =>
      r.map((v) => (v !== null && typeof v === 'object' ? Number.NaN : (v as number))),
    ),
  )
}

describe('批 7b-2 · phase_shift 逐格对旧仓', () => {
  const cases = GOLDEN['phase_shift'] as Record<string, any>

  it('金样不是空的（12 格）', () => {
    expect(Object.keys(cases).length).toBe(12)
  })

  /**
   * ⚠️ **必须有一格奇数边长**：`fftshift` 的方向在偶数边长上给同一个答案
   * （`+n/2 ≡ −n/2 mod n`），那道闸在全是 2 的幂的金样里没有输入。
   */
  it('至少有一格的边长是奇数（fftshift 的方向只有在奇数上才做决定）', () => {
    const odd = Object.values(cases).filter(
      (c: any) => Array.isArray(c.a) && (c.a as unknown[]).length % 2 === 1,
    )
    expect(odd.length).toBeGreaterThan(0)
  })

  for (const [name, c] of Object.entries(cases)) {
    it(name, () => {
      const a = frame(c.a as unknown[])
      const b = frame(c.b as unknown[])
      const got = phaseShift(a, b)
      if (c.snr === null) {
        expect(got, '形状对不上或边长 < 16 ⇒ 不给位移').toBeNull()
        return
      }
      expect(got).not.toBeNull()
      expect(got!.dx).toBe(c.dx)
      expect(got!.dy).toBe(c.dy)
      const tol = phaseShiftSnrRelTol(a.rows, a.cols) * Math.abs(c.snr as number)
      const diff = Math.abs(got!.snr - (c.snr as number))
      expect(diff, `${name}: snr ${got!.snr} vs ${c.snr}（容差 ${tol}）`).toBeLessThanOrEqual(tol)
    })
  }

  /**
   * ⚠️ **合成帧里那层 2% 宽带噪声是这一节能不能比的前提**（导出器 `pit_frame` 的
   * 抬头写着推导）：没有它，三个解析高斯的谱里有一批数值为零的格，而
   * `R /= max(|R|, 1e-30)` 会把那几格的相位整个放出来 —— 那不是舍入误差，
   * 是**一个没有定义的量**，两个 FFT 实现给的角度完全不同（实测 `snr` 差 2e−10）。
   *
   * 这条测试钉住那层噪声还在：帧的**逐行方差**不为零，而且高频那一端有内容。
   * 哪天有人把它「简化」掉，这里会先红。
   */
  it('合成帧带着那层宽带噪声（没有它，snr 这一档就没有判据）', () => {
    const a = frame(cases['shift_x_plus5'].a as unknown[])
    // 取一行远离所有坑的（第 0 行），它应当**不是常数** —— 那一行上只有噪声。
    const row0 = Array.from(a.data.slice(0, a.cols))
    const lo = Math.min(...row0)
    const hi = Math.max(...row0)
    expect(hi - lo).toBeGreaterThan(0.01)
  })
})
