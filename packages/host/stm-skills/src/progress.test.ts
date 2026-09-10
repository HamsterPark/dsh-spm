/**
 * `spec/progress.json` 的看守。
 *
 * 一份会过期的进度表比没有更糟：它会让人**以为**自己知道分母。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IMPLEMENTED } from './l0/index.js'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const progress = JSON.parse(readFileSync(ROOT + 'spec/progress.json', 'utf8')) as {
  totals: { skills: number; done: number; partial: number; todo: number }
  modules_complete: number
  modules_total: number
  modules: Record<string, { total: number; done: number; complete: boolean }>
  skills: Record<string, { status: string; impl: boolean; traces: number; spec: boolean; model: boolean }>
}

describe('进度表', () => {
  it('与代码同步（跑一次生成器比对）', () => {
    execFileSync(process.execPath, ['scripts/build-progress.ts', '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    })
  })

  it('**分母是 515**，不是任何一份手写清单', () => {
    // 「已完成 69 个」在分母是 515 还是 73 的时候是两件事。
    expect(progress.totals.skills).toBe(515)
    expect(
      progress.totals.done + progress.totals.partial + progress.totals.todo,
    ).toBe(progress.totals.skills)
  })

  it('`done` 的定义是四项齐全，没有「差不多」这一档', () => {
    for (const [name, r] of Object.entries(progress.skills)) {
      if (r.status === 'done') {
        expect(r.impl && r.spec && r.model && r.traces > 0, `${name} 被标 done 却缺项`).toBe(true)
      }
    }
  })

  it('每个 done 的技能都真的在 `IMPLEMENTED` 里', () => {
    const done = Object.entries(progress.skills).filter(([, r]) => r.status === 'done')
    expect(done.filter(([n]) => IMPLEMENTED[n] === undefined).map(([n]) => n)).toEqual([])
    expect(done).toHaveLength(Object.keys(IMPLEMENTED).length)
  })

  it('**模块级完成 = 该模块全部名字 done**（§8.5 ⑧）', () => {
    for (const [name, m] of Object.entries(progress.modules)) {
      expect(m.complete, `${name}`).toBe(m.done === m.total)
    }
    expect(progress.modules_complete).toBe(
      Object.values(progress.modules).filter((m) => m.complete).length,
    )
  })
})
