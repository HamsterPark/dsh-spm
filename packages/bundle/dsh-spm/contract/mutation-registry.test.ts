/**
 * 变异规则体检 —— **不跑演练**，只数每条规则的 `find` 在目标文件里命中几次。
 *
 * 演练（`MUTATE=1 pnpm vitest run --project mutation`）要逐条重新构建，默认套件不跑。
 * 于是一条规则盯着的那一行被改了（缩进漂移、名单改成由别处算出），平时没有任何东西会红；
 * 运行器遇到命中次数不是 1 的规则只会判 `inconclusive`，而下一次演练可能在几周之后。
 * 这里把「恰好命中一次」提前到每次提交都跑的契约项目里。
 *
 * **不设豁免名单**：失效的规则要修（重新定靶，或写明接替它的断言后退役），不是登记。
 *
 * 演练的运行器每一趟都**排除本文件**（`tools/mutate/suite-args.ts` 的 `EXCLUDED_FROM_SUITE`）：任何一条变异落地，
 * 被改规则自己的 `find` 就不再命中，本体检必然变红，那不是这条变异被抓住的证据。
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MUTATIONS } from '../../../../tools/mutate/mutations.ts'
import { suiteArgs } from '../../../../tools/mutate/suite-args.ts'

const ROOT = new URL('../../../../', import.meta.url)

/** 与运行器（`tools/mutate/run.ts` 的判据①）同一种数法：不重叠、按子串。 */
const hits = (text: string, find: string): number => text.split(find).length - 1

describe('变异规则体检（不跑演练）', () => {
  it('至少登记了 800 条（防空转）', () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(800)
  })

  it('id 不重复', () => {
    const ids = MUTATIONS.map((m) => m.id)
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([])
  })

  it('每条规则的 find 在目标文件里恰好命中一次', () => {
    // 规则数远多于被指向的文件数，每个文件读一次就够
    const texts = new Map<string, string | undefined>()
    const textOf = (file: string): string | undefined => {
      if (!texts.has(file)) {
        const path = new URL(file, ROOT)
        texts.set(file, existsSync(path) ? readFileSync(path, 'utf8') : undefined)
      }
      return texts.get(file)
    }
    const bad = MUTATIONS.flatMap((m) => {
      const text = textOf(m.file)
      if (text === undefined) return [`${m.id}: 文件不存在 ${m.file}`]
      const n = hits(text, m.find)
      return n === 1 ? [] : [`${m.id}: ${m.file} 命中 ${n} 次`]
    })
    expect(bad).toEqual([])
  })

  it('演练的运行器带着排除去跑，排除的就是这个文件', () => {
    // 不排除的话，scope 落在本包的规则按构造永远判 red（本体检在任何一条变异下都红）
    const args = suiteArgs('packages/bundle/dsh-spm')
    const at = args.indexOf('--exclude')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(args[at + 1]).toBe('**/mutation-registry.test.ts')
    expect(existsSync(new URL('packages/bundle/dsh-spm/contract/mutation-registry.test.ts', ROOT))).toBe(true)
    // 运行器的 suite() 确实是用 suiteArgs 拼命令行的，而不是另写了一条
    expect(readFileSync(new URL('tools/mutate/run.ts', ROOT), 'utf8')).toContain('...suiteArgs(scope)')
  })
})
