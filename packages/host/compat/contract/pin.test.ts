import { readFileSync } from 'node:fs'
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

/**
 * 从**锁文件**数版本，不是从 `node_modules/.pnpm` 数。
 *
 * 2026-09-09 升级 0.1.2-rc.1 → 0.1.5-alpha.1 时踩到：pnpm 不修剪虚拟 store，旧版本的
 * 15 个包原样躺在 `.pnpm` 里**不可达**，而遍历目录的旧实现把它们数成了漂移，红了一次
 * 假警报。锁文件才是「将来会装成什么」的权威，也正是 CI `--frozen-lockfile` 装的东西；
 * 而我们要防的「overrides 静默失效」，其后果恰恰就是**锁文件里出现多个版本**。
 *
 * 键的形状是 `'@deepseek-ai/dsh-tools@0.1.5-alpha.1':`，带 peer 哈希的形如
 * `'…@0.1.5-alpha.1(239eb…)':`——括号里的部分不是版本，要剥掉。
 */
function lockedDshPackages(): Map<string, Set<string>> {
  const lock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const out = new Map<string, Set<string>>()
  for (const m of lock.matchAll(/^ {2}'(@deepseek-ai\/dsh[^@']*)@([^'(]+)(?:\([^']*\))?':$/gm)) {
    const [, name, version] = m
    ;(out.get(name!) ?? out.set(name!, new Set()).get(name!)!).add(version!)
  }
  return out
}

describe('dsh 版本锁', () => {
  // 这条是整套精确钉的**唯一**执法者。2026-09-08 实测：pnpm 的 overrides 键不支持
  // 通配，写 '@deepseek-ai/*' 会静默无效——不报错、不警告、一个包都没钉住
  // （EXECUTION.md 台账 B4）。所以钉没钉上，只能靠在这里数出来。
  it('锁文件里每个 @deepseek-ai/dsh* 都恰好是锁定版本', () => {
    const installed = lockedDshPackages()
    expect(installed.size).toBeGreaterThan(0) // 一个都没数到说明正则或锁文件格式变了
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
