import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defineTool } from '../src/index.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** 真源：compat 直接依赖里那个精确钉的 dsh 版本。别去解析 facts.md 的散文。 */
const lockedVersion = (
  JSON.parse(readFileSync(join(repoRoot, 'packages/host/compat/package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
).dependencies['@deepseek-ai/dsh-tools']!

/** 走遍 pnpm 虚拟store，读每个包**自己的** package.json——目录名带哈希且会被截断，不能解析。 */
function installedDshPackages(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const store = join(repoRoot, 'node_modules/.pnpm')
  for (const entry of readdirSync(store)) {
    const scope = join(store, entry, 'node_modules/@deepseek-ai')
    if (!existsSync(scope)) continue
    for (const pkg of readdirSync(scope)) {
      const manifest = join(scope, pkg, 'package.json')
      if (!existsSync(manifest)) continue
      const { name, version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name: string
        version: string
      }
      if (!name.startsWith('@deepseek-ai/dsh')) continue
      ;(out.get(name) ?? out.set(name, new Set()).get(name)!).add(version)
    }
  }
  return out
}

describe('dsh 版本锁', () => {
  // 这条是整套精确钉的**唯一**执法者。2026-09-08 实测：pnpm 的 overrides 键不支持
  // 通配，写 '@deepseek-ai/*' 会静默无效——不报错、不警告、一个包都没钉住
  // （EXECUTION.md 台账 B4）。所以钉没钉上，只能靠在这里数出来。
  it('安装树里每个 @deepseek-ai/dsh* 都恰好是锁定版本', () => {
    const installed = installedDshPackages()
    expect(installed.size).toBeGreaterThan(0) // 树是空的说明测试自己坏了
    const drifted = [...installed].filter(([, vs]) => vs.size !== 1 || !vs.has(lockedVersion))
    expect(drifted.map(([n, vs]) => `${n}: ${[...vs].join(', ')}`)).toEqual([])
  })
})

describe('dsh 接缝', () => {
  // 不是测 dsh 的功能，是钉住我们**依赖的那一小块形状**。dsh 一改，这里先红。
  // 这条第一次跑就抓到了我对 API 的两处误解：parameters 不是完整 JSON Schema
  // 而是**属性表**（dsh 自己补隐式 object 根），且 output 是必填。
  const tool = defineTool({
    name: 'stm_probe',
    description: '契约测试用的最小工具',
    // 有量纲的 float 一律以 string 要模型写（PLAN §3.2-1：Kimi 受限解码会把
    // 3e-12 变成 3），范围提示只能进 description——dsh 的 schema DSL 没有
    // minimum/maximum。这条属性就是那个约定的最小样本。
    parameters: { bias_v: { type: 'string', description: '偏压 (V)，范围 -10 … 10' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => Promise.resolve(`bias=${args.bias_v}`),
  })

  it('保留 name 与 description', () => {
    expect(tool.name).toBe('stm_probe')
    expect(tool.description).toBe('契约测试用的最小工具')
  })

  it('把属性表编成了带隐式 object 根的 JSON Schema', () => {
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { bias_v: { type: 'string' } },
    })
  })

  it('schema DSL 见到 minimum 直接抛错，不是静默丢弃', () => {
    // spike 第 5 条（facts.md §7）的结论，比 PLAN §3.1-10 当初写的更强：
    // 不透传**且**拒绝定义。所以「范围写进 description」不是可选变通而是唯一写法，
    // 而且写错了会在构造期就炸，不会变成「模型永远看不见这个范围」的静默缺陷。
    // 哪天 dsh 支持了，这条会红——那时才去掉变通并同步改 PLAN §8.2 的 schema 生成。
    expect(() =>
      defineTool({
        name: 'stm_probe_range',
        description: 'x',
        parameters: { n: { type: 'integer', minimum: 1, maximum: 10 } },
        output: { schema: { type: 'string' }, render: () => [] },
        execute: () => Promise.resolve('ok'),
      }),
    ).toThrow(/minimum is not supported by the value schema DSL/)
  })
})
