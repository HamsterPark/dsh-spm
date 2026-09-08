/**
 * 每课时开工第一件事（EXECUTION.md §0-①）：dsh 有没有新版。
 *
 * 不做成测试，因为「上游发了新版」不是缺陷——CI 只该提示，不该变红（PLAN §6.3）。
 * 值得写成脚本的只有一件事：**跨 dist-tag 比 semver 大小**。追踪对象不是某个固定
 * tag（2026-09-04 的教训：`alpha` 落后于 `latest`；09-07 又反过来领先一个 minor），
 * 而是所有 tag 里最大的那个——这个判断我每次用眼睛做迟早出错。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const compat = JSON.parse(
  readFileSync(new URL('../packages/host/compat/package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> }
const locked = compat.dependencies['@deepseek-ai/dsh-tools']!

// Windows 上 npm 是 npm.cmd；直接点名可执行文件，别开 shell——开了 shell 就是把
// 参数拼进命令行，Node 24 会为此发 DEP0190 弃用警告。
const tags = JSON.parse(
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'view',
    '@deepseek-ai/dsh',
    'dist-tags',
    '--json',
  ], { encoding: 'utf8' }),
) as Record<string, string>

// prerelease 也要正确排序：1.2.3-alpha.4 拆成 [1,2,3] 与 ['alpha',4]，数字段按数值比。
function compare(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.split('-', 2)
    return [core.split('.').map(Number), pre ? pre.split('.') : null] as const
  }
  const [ac, ap] = split(a)
  const [bc, bp] = split(b)
  for (let i = 0; i < 3; i++) if ((ac[i] ?? 0) !== (bc[i] ?? 0)) return (ac[i] ?? 0) - (bc[i] ?? 0)
  if (!ap && !bp) return 0
  if (!ap) return 1 // 正式版 > 任何预发布
  if (!bp) return -1
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = Number(x), ny = Number(y)
    return Number.isNaN(nx) || Number.isNaN(ny) ? (x < y ? -1 : 1) : nx - ny
  }
  return 0
}

const newest = Object.values(tags).sort(compare).at(-1)!
const behind = compare(locked, newest) < 0

console.log(`dist-tags   ${JSON.stringify(tags)}`)
console.log(`semver 最大  ${newest}`)
console.log(`本仓锁定    ${locked}`)
console.log(behind ? `\n⚠ 落后了。升级前先读 docs/dsh/upgrades.md 的八步清单。` : `\n✓ 已是最新。`)
