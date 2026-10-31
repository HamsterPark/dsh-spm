/**
 * 从 `pnpm-lock.yaml` 导出 `pnpm-workspace.yaml` 里 `overrides` 与 `minimumReleaseAgeExclude` 的成员表。
 *
 *     node scripts/gen-dsh-pins.ts            # 改写 pnpm-workspace.yaml 里的两张表
 *     node scripts/gen-dsh-pins.ts --check    # 只比对，有 diff 就非零退出
 *
 * 为什么由脚本生成：两张表以前靠人从安装树抄，漏过一次（dsh-attachment 只进了其中一张），
 * 升 0.2.1 时又要补 11 个新包、删 2 个旧包。锁文件才是「将来会装成什么」的权威（同 pin.test.ts）。
 *
 * 导出规则：
 *   overrides                 = 锁文件里全部 `@deepseek-ai/*`（dsh 系与 Cordis 系）+ `zod`，各取唯一版本
 *   minimumReleaseAgeExclude  = 其中 `@deepseek-ai/dsh*` 的 `<名>@<版本>`（Cordis 系与 zod 不进，沿用旧规则）
 * 任何一个名字在锁文件里不是恰好一个版本 ⇒ 报错退出（那正是要抓的静默漂移）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const LOCK = fileURLToPath(new URL('pnpm-lock.yaml', root))
const YAML = fileURLToPath(new URL('pnpm-workspace.yaml', root))

/** 只读 `packages:` 段：键形如 `'@deepseek-ai/dsh-tools@<版本>':`；`snapshots:` 段的键带 peer 后缀，不重复数。 */
export function lockedVersions(lockText: string): Map<string, Set<string>> {
  const start = lockText.indexOf('\npackages:\n')
  const end = lockText.indexOf('\nsnapshots:\n')
  if (start < 0 || end < start) throw new Error('pnpm-lock.yaml 里找不到 packages:/snapshots: 段，锁文件格式变了')
  const found = new Map<string, Set<string>>()
  for (const m of lockText.slice(start, end).matchAll(/^ {2}'?((?:@deepseek-ai\/[^@'\s]+)|zod)@([^'(:\s]+)'?:/gm)) {
    const [, name, version] = m
    ;(found.get(name!) ?? found.set(name!, new Set()).get(name!)!).add(version!)
  }
  return found
}

export interface PinTables {
  readonly vendorAndZod: readonly (readonly [string, string])[]
  readonly dsh: readonly (readonly [string, string])[]
}

export function exportTables(found: Map<string, Set<string>>): PinTables {
  const multi = [...found].filter(([, v]) => v.size !== 1)
  if (multi.length > 0) throw new Error(`锁文件里这些包不是恰好一个版本：${multi.map(([n, v]) => `${n}=${[...v].join('|')}`).join('; ')}`)
  const entries = [...found].map(([n, v]) => [n, [...v][0]!] as const).sort(([a], [b]) => (a < b ? -1 : 1))
  if (!entries.some(([n]) => n === 'zod')) throw new Error('锁文件里没有 zod：stm-ui 的 zod 声明丢了？')
  return {
    vendorAndZod: entries.filter(([n]) => !n.startsWith('@deepseek-ai/dsh')),
    dsh: entries.filter(([n]) => n.startsWith('@deepseek-ai/dsh')),
  }
}

/** 把两张表写回 yaml 文本：只替换成员行，块内的注释行保留（挪到 vendor 与 dsh 之间）。 */
export function renderYaml(yaml: string, t: PinTables): string {
  const q = (s: string): string => `'${s}'`
  let out = yaml.replace(/minimumReleaseAgeExclude:\n((?: {2}- .*\n)+)/, () =>
    `minimumReleaseAgeExclude:\n${t.dsh.map(([n, v]) => `  - ${q(`${n}@${v}`)}`).join('\n')}\n`)
  out = out.replace(/overrides:\n((?: {2}.*\n?)+)/, (_all, body: string) => {
    const comments = body.split('\n').filter((l) => l.trim().startsWith('#'))
    const lines = [
      ...t.vendorAndZod.map(([n, v]) => `  ${q(n)}: ${q(v)}`),
      ...comments,
      ...t.dsh.map(([n, v]) => `  ${q(n)}: ${q(v)}`),
    ]
    return `overrides:\n${lines.join('\n')}\n`
  })
  return out
}

function main(): number {
  const tables = exportTables(lockedVersions(readFileSync(LOCK, 'utf8')))
  const current = readFileSync(YAML, 'utf8')
  const next = renderYaml(current, tables)
  const label = `${tables.dsh.length} 个 dsh 包 + ${tables.vendorAndZod.length} 个 Cordis 系/zod`
  if (process.argv.includes('--check')) {
    if (next === current) { console.log(`✓ pnpm-workspace.yaml 的钉版表与锁文件同步（${label}）`); return 0 }
    console.error('✗ pnpm-workspace.yaml 的钉版表与锁文件不同步。跑 `node scripts/gen-dsh-pins.ts`，再 `pnpm install`。')
    return 1
  }
  writeFileSync(YAML, next)
  console.log(`✓ 已按锁文件导出钉版表（${label}）`)
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
