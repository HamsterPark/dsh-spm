/**
 * `spec/progress.json` —— **分母**。
 *
 *     node scripts/build-progress.ts            # 写文件
 *     node scripts/build-progress.ts --check    # 只比对，有 diff 就非零退出
 *
 * PLAN §11 第四条：「**每个 Phase 开头先补该 Phase 要用的 golden，分母先定，
 * 进度才有意义**」。一个「已完成 69 个技能」的说法，在分母是 515 还是 73 的时候
 * 是两件事；而没有这份文件时，那个分母只存在于我的记忆里。
 *
 * 每个技能记四项 DoD 的**实测状态**，不是我的判断：
 *
 * | 项 | 怎么判 |
 * |---|---|
 * | `spec` | `generated/specs.ts` 里有没有它 —— 有就是**结构性成立**（生成的，见那个文件的抬头） |
 * | `model` | `tool_schemas_real.json` 里有没有它的 schema（`tool-schema-real.test.ts` 逐字比过全部 515 个） |
 * | `traces` | `skill_traces.json` 里有几条轨迹 |
 * | `impl` | `IMPLEMENTED` 里有没有它 |
 *
 * `status` 只有三种：
 * - `done` —— 四项齐全（`impl` + `spec` + `model` + `traces ≥ 1`）；
 * - `partial` —— 有金样没实现，或有实现没轨迹；
 * - `todo` —— 只有 spec 与 model（那两项对 515 个技能全都成立）。
 *
 * **不设「差不多完成」这一档**：一个技能要么这四样齐了，要么没齐。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// 读**构建产物**而不是源码：Node 的 TS 剥离不改写相对 import 的 `.js` 后缀，
// 而源码里那些后缀是给 tsc 用的。读 lib/ 顺带保证了「进度是编译得过的那份代码的进度」。
import { BATCH_SPECS } from '../packages/host/stm-skills/lib/generated/specs.js'
import { IMPLEMENTED } from '../packages/host/stm-skills/lib/l0/index.js'

const url = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const OUT = url('../spec/progress.json')

interface GoldenSkill {
  name: string
  module?: string
  category?: string
  safety_level?: string
}

const rawSkills = JSON.parse(readFileSync(url('../spec/golden/skills.json'), 'utf8')) as
  | Record<string, GoldenSkill>
  | GoldenSkill[]
const skills = (Array.isArray(rawSkills) ? rawSkills : Object.values(rawSkills)).slice()
skills.sort((a, b) => (a.name < b.name ? -1 : 1))

const realSchemas = JSON.parse(
  readFileSync(url('../spec/golden/tool_schemas_real.json'), 'utf8'),
) as Record<string, { error?: string }>

const traces = JSON.parse(readFileSync(url('../spec/golden/skill_traces.json'), 'utf8')) as Record<
  string,
  { traces: Record<string, unknown> }
>

type Status = 'done' | 'partial' | 'todo'

interface Row {
  readonly module: string
  readonly category: string
  readonly safety: string
  readonly spec: boolean
  readonly model: boolean
  readonly traces: number
  readonly impl: boolean
  readonly status: Status
}

function statusOf(r: Omit<Row, 'status'>): Status {
  if (r.impl && r.spec && r.model && r.traces > 0) return 'done'
  if (r.impl || r.traces > 0) return 'partial'
  return 'todo'
}

function main(): number {
  const bySkill: Record<string, Row> = {}
  for (const s of skills) {
    const base = {
      module: (s.module ?? '').replace('mast.skills.', ''),
      category: s.category ?? '?',
      safety: s.safety_level ?? '?',
      spec: BATCH_SPECS[s.name] !== undefined,
      model: realSchemas[s.name] !== undefined && realSchemas[s.name]?.error === undefined,
      traces: Object.keys(traces[s.name]?.traces ?? {}).length,
      impl: IMPLEMENTED[s.name] !== undefined,
    }
    bySkill[s.name] = { ...base, status: statusOf(base) }
  }

  const counts: Record<Status, number> = { done: 0, partial: 0, todo: 0 }
  for (const r of Object.values(bySkill)) counts[r.status] += 1

  // 模块级完成 = 该模块全部名字 done（§8.5 ⑧）
  const byModule: Record<string, { total: number; done: number; complete: boolean }> = {}
  for (const r of Object.values(bySkill)) {
    const m = (byModule[r.module] ??= { total: 0, done: 0, complete: false })
    m.total += 1
    if (r.status === 'done') m.done += 1
  }
  for (const m of Object.values(byModule)) m.complete = m.done === m.total

  const out = {
    _note:
      '由 `node scripts/build-progress.ts` 生成。分母是 spec/golden/skills.json 的 515 条，' +
      '不是任何一份手写清单。',
    totals: { skills: skills.length, ...counts },
    modules_complete: Object.values(byModule).filter((m) => m.complete).length,
    modules_total: Object.keys(byModule).length,
    modules: Object.fromEntries(Object.entries(byModule).sort(([a], [b]) => (a < b ? -1 : 1))),
    skills: bySkill,
  }

  const text = JSON.stringify(out, null, 2) + '\n'
  const check = process.argv.includes('--check')
  const current = ((): string | null => {
    try {
      return readFileSync(OUT, 'utf8')
    } catch {
      return null
    }
  })()

  if (check) {
    if (current === text) {
      console.log(
        `✓ progress.json 与金样同步（${counts.done}/${skills.length} done，` +
          `${out.modules_complete}/${out.modules_total} 模块完成）`,
      )
      return 0
    }
    console.error('✗ progress.json 过期。跑 `node scripts/build-progress.ts` 重新生成。')
    return 1
  }

  writeFileSync(OUT, text, { encoding: 'utf8' })
  console.log(
    `✓ progress.json：${counts.done} done · ${counts.partial} partial · ${counts.todo} todo` +
      `（共 ${skills.length}）；模块 ${out.modules_complete}/${out.modules_total} 完成`,
  )
  return 0
}

process.exit(main())
