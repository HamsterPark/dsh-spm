/**
 * **元测试**：每一道闸至少变红一条。
 *
 * 这是 Phase 2 的完成判据（PLAN §8.4）。没有它，「闸门写了」和「闸门在挡」分不清——
 * 而这两者在 diff 里长得一模一样。
 *
 * 单独一个 vitest project，**不进默认套件**：每条变异要重新 `tsc -b` 一次，
 * 全跑一趟约五分钟。默认套件要秒级，这套东西一天跑一次。
 *
 *     pnpm vitest run --project mutation
 */
import { describe, expect, it } from 'vitest'
import { MUTATIONS } from '../mutations.ts'
import { runOne } from '../run.ts'

describe('变异框架：每一道闸至少一条变红', () => {
  it('清单本身：id 不重名，scope 覆盖被变异的文件', () => {
    const ids = MUTATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of MUTATIONS) {
      expect(m.file.startsWith(m.scope), `${m.id}: scope 没覆盖 file`).toBe(true)
      expect(m.why.length, `${m.id}: why 太短，说不清拆掉会重犯哪次错`).toBeGreaterThan(10)
    }
  })

  for (const m of MUTATIONS) {
    it(
      `${m.id} —— ${m.why}`,
      () => {
        const r = runOne(m)
        // `inconclusive` **不是**「没红」：三判据没走完，结论无效。
        // 分开报是有意的——把它们混成一类，我们就会以为验过了。
        expect(r.verdict, `${r.verdict}：${r.note}`).toBe('red')
        expect(r.failed).toBeGreaterThan(0)
      },
      120_000,
    )
  }
})
