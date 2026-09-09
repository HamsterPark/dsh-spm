import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const allowed = 'packages/host/compat/src'

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'lib' ? [] : tsFilesUnder(full)
    return e.isFile() && e.name.endsWith('.ts') ? [full] : []
  })
}

describe('防腐层边界', () => {
  // PLAN §6.1-2、§3.1-1：dsh 一天一版且预告破坏性重构，全仓只许一个包认识
  // @deepseek-ai/*。这条最终要变成 oxlint no-restricted-imports，现在先用测试兜住。
  //
  // 只匹配**真的 import**，不匹配：
  //   - 字符串字面量（bundle 读 peerDependencies['@deepseek-ai/dsh-tools']）
  //   - `declare module '@deepseek-ai/cordis'` 的类型层增补（1.6 的 ctx.instrument 要它）。
  // 后者不产生任何运行时 import，而这条规则防的是**运行时耦合**散落各处。
  const importsDsh = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s*['"]@deepseek-ai\/|require\(\s*['"]@deepseek-ai\//
  const contractDirs = /[\\/]contract[\\/]/

  it('只有 compat/src 与 contract 目录 import @deepseek-ai/*', () => {
    const offenders = tsFilesUnder(join(repoRoot, 'packages'))
      .filter((f) => importsDsh.test(readFileSync(f, 'utf8')))
      .map((f) => relative(repoRoot, f).replaceAll('\\', '/'))
      // contract 测试按定义就要打真包（PLAN §12）
      .filter((f) => !f.startsWith(allowed) && !contractDirs.test(f))
    expect(offenders).toEqual([])
  })

  it('这条检查抓得住越界（否则它只会一直变绿）', () => {
    expect(importsDsh.test(`import { x } from '@deepseek-ai/dsh-tools'`)).toBe(true)
    expect(importsDsh.test(`export { y } from '@deepseek-ai/cordis'`)).toBe(true)
    // 字符串键不算越界——这正是我第一次用 grep 时的误报
    expect(importsDsh.test(`m.peerDependencies['@deepseek-ai/dsh-tools']`)).toBe(false)
  })
})
