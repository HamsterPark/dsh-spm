/**
 * 断点落盘。判据集中在两件事上：**键**（2026-07-10 的真正缺陷）与**原子写**。
 */
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GraphExecutor, newProgress, progressToDict } from 'dsh-spm-kernel'
import { FileProgressStore, sidecarPath, slug, sweepStaleSidecars } from './sidecar.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dsh-spm-sidecar-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      readdirSync(d)
    } catch {
      /* 已经没了 */
    }
  }
})

describe('slug', () => {
  it('中文、字母、数字、下划线、连字符留下，其余变 `_`', () => {
    expect(slug('AutoApproach')).toBe('AutoApproach')
    expect(slug('扫描-区域_1')).toBe('扫描-区域_1')
    expect(slug('chat/adhoc:62b1 132c')).toBe('chat_adhoc_62b1_132c')
  })

  it('截断', () => {
    expect(slug('x'.repeat(200))).toHaveLength(80)
    expect(slug('x'.repeat(200), 40)).toHaveLength(40)
  })
})

describe('键里为什么有 run_id —— 2026-07-10 假进针', () => {
  it('两次运行 ⇒ 两个文件，**结构上**不可能互相捡到', () => {
    const d = tmp()
    const a = sidecarPath(d, 'AutoApproach', 'run-1')
    const b = sidecarPath(d, 'AutoApproach', 'run-2')
    expect(a).not.toBe(b)
    // 只按名字的旧键：一次跑完的 AutoApproach 留下「四步全完成」，之后每一次进针
    // 都从它续跑——跳掉整个计划、不碰仪器就报成功。
    expect(sidecarPath(d, 'AutoApproach')).toBe(sidecarPath(d, 'AutoApproach', ''))
  })

  it('空 run_id 走老文件名（手工执行器 / 测试），仍由两条守卫兜底', () => {
    const d = tmp()
    expect(sidecarPath(d, 'AutoApproach')).toBe(join(d, 'AutoApproach.json'))
    expect(sidecarPath(d, 'AutoApproach', 'r1')).toBe(join(d, 'AutoApproach__r1.json'))
  })

  it('名字被清空时有兜底名，不会变成一个隐藏文件', () => {
    const d = tmp()
    expect(sidecarPath(d, '///')).toBe(join(d, '___.json'))
    expect(sidecarPath(d, '')).toBe(join(d, 'composite.json'))
  })
})

describe('FileProgressStore', () => {
  it('存了能读回来', () => {
    const s = new FileProgressStore(tmp(), 'C', 'r1')
    expect(s.load()).toBeNull()
    const d = progressToDict({ ...newProgress('C', 123), completedSteps: ['s1'] })
    s.save(d)
    expect(s.load()).toEqual(d)
    s.clear()
    expect(s.load()).toBeNull()
  })

  it('清一个不存在的文件不抛', () => {
    const s = new FileProgressStore(tmp(), 'C', 'r1')
    expect(() => s.clear()).not.toThrow()
  })

  it('**坏文件读成「没有」，不是读成「跑到一半」**', () => {
    const dir = tmp()
    const s = new FileProgressStore(dir, 'C', 'r1')
    writeFileSync(s.path, '{"completed_steps": ["s1"', 'utf8') // 写了一半
    expect(s.load()).toBeNull()
    // 一份写了一半的 JSON 被当成进度，就是重放硬件动作。
    writeFileSync(s.path, '[1,2,3]', 'utf8')
    expect(s.load()).toBeNull()
  })

  it('写是原子的：落盘之后目录里只有那一个文件，没有临时残留', () => {
    const dir = tmp()
    const s = new FileProgressStore(dir, 'C', 'r1')
    s.save(progressToDict(newProgress('C', 1)))
    s.save(progressToDict(newProgress('C', 2)))
    expect(readdirSync(dir)).toEqual(['C__r1.json'])
  })
})

describe('sweepStaleSidecars', () => {
  it('只删超过期限的，返回个数', () => {
    const dir = tmp()
    const old = join(dir, 'old.json')
    const fresh = join(dir, 'fresh.json')
    writeFileSync(old, '{}', 'utf8')
    writeFileSync(fresh, '{}', 'utf8')
    const now = Date.now() / 1000
    utimesSync(old, now - 48 * 3600, now - 48 * 3600)
    expect(sweepStaleSidecars(dir, now)).toBe(1)
    expect(readdirSync(dir)).toEqual(['fresh.json'])
  })

  it('不是 .json 的不碰', () => {
    const dir = tmp()
    const keep = join(dir, 'notes.txt')
    writeFileSync(keep, 'x', 'utf8')
    utimesSync(keep, 0, 0)
    expect(sweepStaleSidecars(dir, Date.now() / 1000)).toBe(0)
  })

  it('目录不存在 ⇒ 0，不抛 —— 一次打扫失败不该让实验付出代价', () => {
    expect(sweepStaleSidecars(join(tmp(), 'nope'), Date.now() / 1000)).toBe(0)
  })
})

describe('装到执行器上跑一遍', () => {
  it('跑完删掉自己的断点；被打断的留着', async () => {
    const dir = tmp()
    const run = async (fail: boolean): Promise<string[]> => {
      const store = new FileProgressStore(dir, 'C', 'r1')
      const ex = new GraphExecutor('C', {
        now: () => 1_700_000_000,
        store,
        run: (skill) => (fail && skill === 'B' ? { success: false, error: 'x' } : {}),
      })
      await ex.runPlan([
        { stepId: 's1', skillName: 'A', params: {} },
        { stepId: 's2', skillName: 'B', params: {} },
      ])
      return readdirSync(dir)
    }
    expect(await run(true)).toEqual(['C__r1.json'])
    // 断掉那次留下的断点，下一次同一个 run 里续跑（这是它存在的理由）
    const side = JSON.parse(readFileSync(join(dir, 'C__r1.json'), 'utf8')) as {
      completed_steps: string[]
    }
    expect(side.completed_steps).toEqual(['s1'])
    expect(await run(false)).toEqual([])
  })
})
