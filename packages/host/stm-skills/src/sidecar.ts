/**
 * 断点落盘 —— {@link ProgressStore} 的文件实现。
 *
 * 内核只留判据（什么时候读、写、丢），介质在这里。见 `graph-executor.ts` 抬头。
 *
 * ## 键里为什么有 run_id
 *
 * 断点按 **(组合名, 运行)** 索引，不是按组合名。只按名字的旧键让断点成了一个跨运行
 * 的共享信箱：一次跑完的 AutoApproach 留下一份「四步全完成」的文件，**之后每一次**
 * 进针都从它续跑，把整个计划跳掉、不碰仪器就报了成功——2026-07-10 的假进针。
 * terminal / stale 两条守卫是后来补的，但**键才是真正的缺陷**：续跑只在**一次运行
 * 之内**有意义（中断 → 用户决定 → 接着跑），所以运行号属于键，于是跨运行复用变成
 * **结构上不可能**，而不是「被守住了」。
 *
 * `runId` 为空（手工构造执行器、测试）走只按名字的老文件名，仍然由那两条守卫兜底。
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ProgressDict, ProgressStore } from 'dsh-spm-kernel'

/** 超过这么久的断点由清扫器删掉。键带运行号已经保证不会被复用，但文件会一直躺着。 */
export const SIDECAR_SWEEP_AGE_S = 24 * 3600.0

/**
 * 文件名安全化。
 *
 * 旧仓是 `re.sub(r"[^\w一-鿿-]", "_", s)[:n]`——Python 的 `\w` 是 Unicode 的，
 * 所以中文、字母、数字、下划线、连字符留下，其余变 `_`，再截断。
 *
 * ⚠️ 它**不是单射**：截断加上「其余全变 `_`」会让不同的名字撞到同一个文件。承担
 * 「两次运行不撞车」的是 `runId` 本身（ULID / 会话号），不是这个函数。
 */
export function slug(s: string, n = 80): string {
  return String(s)
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .slice(0, n)
}

/** 一个组合在**一次运行**里的断点文件路径。 */
export function sidecarPath(dir: string, compositeName: string, runId = ''): string {
  const safe = slug(compositeName) || 'composite'
  return join(dir, runId ? `${safe}__${slug(runId, 40)}.json` : `${safe}.json`)
}

/**
 * 落在文件上的断点。
 *
 * 写是**原子**的（临时文件 + rename）：每一步之后都要落，而下一刻可能就是一次
 * 中断——一份写了一半的 JSON 在下次启动时是「读不出来 ⇒ 从头跑」，也就是重放硬件。
 */
export class FileProgressStore implements ProgressStore {
  readonly path: string
  #seq = 0

  constructor(dir: string, compositeName: string, runId = '') {
    mkdirSync(dir, { recursive: true })
    this.path = sidecarPath(dir, compositeName, runId)
  }

  load(): Record<string, unknown> | null {
    try {
      const v: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      return typeof v === 'object' && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null
    } catch {
      // 读不出来 ⇒ 从头跑。**不许**把一份坏文件当成「跑到一半」。
      return null
    }
  }

  save(d: ProgressDict): void {
    this.#seq += 1
    const tmp = `${this.path}.${process.pid}.${this.#seq}.tmp`
    writeFileSync(tmp, JSON.stringify(d), 'utf8')
    renameSync(tmp, this.path)
  }

  clear(): void {
    rmSync(this.path, { force: true })
  }
}

/**
 * 删掉超过一天的断点。键带运行号意味着一次崩掉的运行留下的文件永远不会被复用，
 * 但它会永远躺在盘上。
 *
 * 返回删掉的个数。**不抛**——一次打扫失败不该让实验付出任何代价。
 */
export function sweepStaleSidecars(dir: string, now: number, maxAgeS = SIDECAR_SWEEP_AGE_S): number {
  let n = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const p = join(dir, name)
      try {
        if (now - statSync(p).mtimeMs / 1000 > maxAgeS) {
          rmSync(p, { force: true })
          n += 1
        }
      } catch {
        /* 单个文件的问题不打断整轮打扫 */
      }
    }
  } catch {
    /* 目录都没有就没什么可扫的 */
  }
  return n
}
