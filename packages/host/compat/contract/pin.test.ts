import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VENDOR_PINS } from '../../../../scripts/dsh-pins.ts'
import { exportTables, lockedVersions, renderYaml } from '../../../../scripts/gen-dsh-pins.ts'
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

  // dsh 从 0.2.1-alpha.3 起把 zod 精确钉在自己选的版本上（此前是 `^4.4.3`）。我们的 zod 若是另一个版本，`ProjectionDefinition`
  // 的 `stateSchema: ZodType<S>` 就要在两套 zod 类型之间做结构比较——2026-10-20 实测 stm-ui
  // 的 `tsc` 因此吃满 4 GB 堆崩溃，**一条 TS 报错都没有**。所以在这里点名，而不是让人去猜。
  it('锁文件里 zod 只有一个版本', () => {
    const lock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
    const versions = new Set([...lock.matchAll(/^ {2}'?zod@([^'(:\s]+)/gm)].map((m) => m[1]))
    expect([...versions]).toHaveLength(1)
  })
})

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
}

// `packages/<组>/<包>/package.json`，与 pnpm-workspace.yaml 的 packages 通配同一范围。
function workspaceManifests(): { dir: string; json: Manifest }[] {
  const out: { dir: string; json: Manifest }[] = []
  for (const group of readdirSync(join(repoRoot, 'packages'))) {
    for (const pkg of readdirSync(join(repoRoot, 'packages', group))) {
      try {
        out.push({ dir: `${group}/${pkg}`, json: JSON.parse(readFileSync(join(repoRoot, 'packages', group, pkg, 'package.json'), 'utf8')) as Manifest })
      } catch {
        // 不是包目录
      }
    }
  }
  return out
}

describe('钉版表', () => {
  const lock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const tables = exportTables(lockedVersions(lock))

  // 两张表原先靠人从安装树抄，漏过一次（dsh-attachment 只进了其中一张）。现在由
  // scripts/gen-dsh-pins.ts 从锁文件导出，这里钉住「yaml 里写的 = 脚本导出的」。
  it('pnpm-workspace.yaml 的 overrides / minimumReleaseAgeExclude 就是锁文件的导出', () => {
    expect(renderYaml(yaml, tables)).toBe(yaml)
  })

  // overrides 会把 manifest 里写的版本整个顶掉：manifest 写 4.0.2、overrides 写 4.0.5 时，
  // 锁文件和 `--frozen-lockfile` 都不报错，但 manifest 说的话已经不是真的了（2026-10-26 实测）。
  it('每个工作区包写的 @deepseek-ai/* 与 zod 都等于钉版表', () => {
    const pinned = new Map([...tables.vendorAndZod, ...tables.dsh])
    const wrong: string[] = []
    for (const { dir, json } of workspaceManifests()) {
      for (const section of [json.dependencies, json.devDependencies, json.peerDependencies]) {
        for (const [name, spec] of Object.entries(section ?? {})) {
          if (!name.startsWith('@deepseek-ai/') && name !== 'zod') continue
          if (spec !== pinned.get(name)) wrong.push(`${dir}: ${name} ${spec} ≠ ${pinned.get(name) ?? '(不在表里)'}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  // 变红演练的固定版本：合成一份同时含两个 zod 的锁文件，导出器必须拒绝并点名（2026-10-20 实测，
  // 两份 zod 会让 stm-ui 的 tsc 吃满 4 GB 堆后崩溃，且一条 TS 报错都没有）。
  it('同一个包在锁文件里有两个版本时，导出器拒绝并点名', () => {
    const lock = ['', 'packages:', '', "  'zod@4.4.3':", '    resolution: {}', '', "  'zod@4.5.4':", '    resolution: {}', '', 'snapshots:', ''].join('\n')
    expect(() => exportTables(lockedVersions(lock))).toThrow(/zod=4\.4\.3\|4\.5\.4/)
  })

  // install-minimal 给启动器闭包里的独立版本线包（Cordis 系等）钉的版本表。本仓依赖闭包里也有的那几个，
  // 必须与锁文件一致——否则最小分发装出来的 Cordis 与开发树里的不是同一个。
  it('scripts/dsh-pins.ts 的 VENDOR_PINS 与锁文件里同名包的版本一致', () => {
    const inLock = new Map(tables.vendorAndZod)
    const wrong = Object.entries(VENDOR_PINS).filter(([name, version]) => inLock.has(name) && inLock.get(name) !== version)
    expect(wrong).toEqual([])
  })

  // 一旦写了 engines.dsh，上游兼容闸**只看它、不再看 peer**（dsh-app-boot README）。所以 peer 写错
  // 不会被 dsh 发现，只能在这里抓。
  it('bundle 的 engines.dsh 与 dsh peer 都是锁定版本', () => {
    const bundle = JSON.parse(readFileSync(join(repoRoot, 'packages/bundle/dsh-spm/package.json'), 'utf8')) as Manifest
    expect(bundle.engines?.['dsh']).toBe(lockedVersion)
    const dshPeers = Object.entries(bundle.peerDependencies ?? {}).filter(([n]) => n.startsWith('@deepseek-ai/dsh'))
    expect(dshPeers.length).toBeGreaterThan(0)
    expect(dshPeers.filter(([, v]) => v !== lockedVersion)).toEqual([])
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
