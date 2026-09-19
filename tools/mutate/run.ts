/**
 * 跑变异演练。
 *
 *     node tools/mutate/run.ts              # 全部
 *     node tools/mutate/run.ts k2-abort-latch schema-effective-bounds
 *     node tools/mutate/run.ts --json       # 机器读的结果（meta 测试用）
 *
 * 每一条都走完整的**四**判据，任何一条不满足就判 `inconclusive`——
 * **「没变红」和「压根没验」必须是两个不同的结论**，不然这套东西只会给人虚假的安心。
 *
 * ## 第四条判据：**红的是这条变异吗**（2026-09-19 补）
 *
 * 前三条问的都是「这一趟有没有跑起来」，**没有一条问「这一红是谁造成的」**。
 *
 * 批 5b / 5c 两条支线都报「全部实跑到 red」，而合并后的全量演练里**八条是绿的**。
 * 查实（不是猜）：两条支线的树上各有 **2 条 / 3 条与变异无关的常红**
 * （5b 那两条已复现：演练跑在 `gen:progress` 之前，`progress.test.ts` 恰好红 2 条），
 * 而这里的判据是 `failed > 0` —— 于是**每一条变异都继承了那个底噪**，一律「红」。
 *
 * 指纹很清楚：把那 12 条重跑，偏移是**常数**（5b 一律 −2、5c 一律 −3），
 * 而 2 和 3 正是两份交接给那八条绿的数字。
 *
 * ⇒ **先量基线，基线不为 0 就整趟拒跑。** 一个在脏树上跑的演练，
 * 报出的失败可能全部来自基线，而表面形状与变异导致的失败相同。
 *
 * 还原用 `writeFileSync` 而不是 `mv`：`mv` 会把旧 mtime 一起搬回来，`tsc -b` 于是
 * 认为 `lib/` 还是新的、跳过重建 —— **源码干净而构建产物还是变异版**。
 * 同包测试走 vitest 的 TS 转译读 `src`，看不出来；跨包测试读的正是 `lib/`。
 * （2026-09-10 真踩过：下一段测试莫名其妙地红，源码却是对的。）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTATIONS, type Mutation } from './mutations.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

export interface MutationResult {
  readonly id: string
  /**
   * `red` = 达成目的；`green` = 拆了也没人喊；`inconclusive` = 判据没走完；
   * `narrow-scope` = **在声明的 scope 里没人喊，而放到 `packages/host` 就喊了**
   * —— 那不是「闸不存在」，是这条记录的 `scope` 过期了（2026-09-19 搬家撞出来的）。
   */
  readonly verdict: 'red' | 'green' | 'inconclusive' | 'narrow-scope'
  readonly failed: number
  readonly passed: number
  readonly note: string
}

function run(cmd: string[], opts: { allowFail?: boolean } = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    if (opts.allowFail !== true && err.status === undefined) throw e
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

const PNPM = ['node_modules/vitest/vitest.mjs']

function build(): { code: number; out: string } {
  return run(['node_modules/typescript/bin/tsc', '-b'], { allowFail: true })
}

export function runOne(m: Mutation): MutationResult {
  const path = ROOT + m.file
  const original = readFileSync(path, 'utf8')
  const fail = (note: string): MutationResult => ({
    id: m.id,
    verdict: 'inconclusive',
    failed: 0,
    passed: 0,
    note,
  })

  // ── 判据①：变异唯一命中并落地 ──
  const hits = original.split(m.find).length - 1
  if (hits !== 1) return fail(`替换串命中 ${hits} 次（要求恰好 1 次）`)
  const mutated = original.replace(m.find, m.replace)
  writeFileSync(path, mutated, 'utf8')

  try {
    if (!readFileSync(path, 'utf8').includes(m.replace)) return fail('写回后 grep 不到新串')

    // ── 判据②：构建通过 ──
    const b = build()
    if (b.code !== 0) return fail(`构建失败（红不算数）：${b.out.split('\n')[0] ?? ''}`)

    // ── 判据③：测试确实跑了，且范围覆盖被变异的文件 ──
    if (!m.scope.startsWith('packages') || !m.file.startsWith(m.scope)) {
      return fail(`scope \`${m.scope}\` 没有覆盖被变异的文件 \`${m.file}\``)
    }
    // **排除** integration，而不是白名单 unit。
    //
    // 要排它是因为：`integration` 的 globalSetup 在没有 STMSIM_* 时会**直接抛**，
    // 整趟 vitest 连 `Tests` 汇总行都不打，于是判据③ 不成立、演练齐刷刷判成
    // `inconclusive`（2026-09-11 加第一个 host 侧 integration 文件时当场撞上：
    // 前 53 条跑在文件存在之前，后 27 条跑在之后）。
    //
    // 而**不**写成 `--project unit` 是因为第一版就是那么写的，它当场把
    // `gated-call-abort-verbs` 变成绿的 —— 那道闸的测试住在 `contract/` 里。
    // 白名单会在下一个 project 加进来的时候再漏一次；排除法不会。
    const r = suite(m.scope)
    if (r === null) return fail('测试没跑起来（输出里找不到 Tests 汇总行）')
    const { failed, passed } = r
    if (failed + passed === 0) return fail('测试跑了 0 条')

    if (failed > 0) {
      return { id: m.id, verdict: 'red', failed, passed, note: `${failed} 条变红` }
    }

    // ── 绿了先别下结论：**换全包范围再问一次** ──
    //
    // 一次重构可以把判据搬到另一个包，而看着它的那条测试留在原地 ——
    // 于是这条记录的 `scope` 悄悄不再覆盖它的证人。那时它报绿，
    // 和「这条闸真的没人看」长得一模一样。**预检查不出来**（`file` 仍在 `scope` 里），
    // 只有真跑才看得见（2026-09-19：搬家之后三条晶格变异就是这样）。
    if (m.scope !== WIDE_SCOPE) {
      const w = suite(WIDE_SCOPE)
      if (w !== null && w.failed > 0) {
        return {
          id: m.id,
          verdict: 'narrow-scope',
          failed: w.failed,
          passed: w.passed,
          note: `${m.scope} 里没人喊，而 ${WIDE_SCOPE} 里红了 ${w.failed} 条 —— 把 scope 放宽`,
        }
      }
    }
    return { id: m.id, verdict: 'green', failed, passed, note: '拆掉也没人喊' }
  } finally {
    // 还原并**强制重建**：见文件抬头的 mtime 陷阱
    writeFileSync(path, original, 'utf8')
    build()
  }
}

/** 绿了之后用来复问的全包范围。 */
const WIDE_SCOPE = 'packages/host'

/** 跑一趟某个 scope 的非集成测试，回 `{failed, passed}`；汇总行读不到就 `null`。 */
function suite(scope: string): { failed: number; passed: number } | null {
  const t = run([...PNPM, 'run', '--project', '!integration', scope, '--reporter=dot'], {
    allowFail: true,
  })
  const line = /^\s+Tests\s+(?:(\d+) failed \| )?(\d+) passed/m.exec(t.out)
  if (line === null) return null
  return { failed: Number(line[1] ?? 0), passed: Number(line[2] ?? 0) }
}

/**
 * **判据④：先量基线。**
 *
 * 在**没有任何变异**的树上把这一趟要用到的每个 scope 各跑一遍。只要有一条红，
 * 整趟拒跑 —— 因为此后每一条变异都会继承它，而 `failed > 0` 分不出那是谁的红。
 *
 * 这一条是 2026-09-19 用八条假红换来的：两条支线各带着 2 条 / 3 条常红跑完全部演练，
 * 报回来「全部变红」，而其中八道闸**从来没有任何测试在看**。
 */
function baselineClean(scopes: readonly string[]): boolean {
  let ok = true
  for (const sc of scopes) {
    const r = suite(sc)
    if (r === null) {
      console.error(`✗ 基线：scope \`${sc}\` 的测试没跑起来（找不到 Tests 汇总行）`)
      ok = false
      continue
    }
    if (r.failed > 0) {
      console.error(
        `✗ 基线不干净：scope \`${sc}\` 在**没有变异**的树上就有 ${r.failed} 条红。\n` +
          `  演练拒跑 —— 此后每一条变异都会继承这 ${r.failed} 条，而判据是 \`failed > 0\`，\n` +
          `  于是每一条都会报「红」，包括那些其实没人看的闸（2026-09-19 就是这么丢了八道）。\n` +
          `  先把树弄干净：常见成因是**生成物没重跑**（build → gen:skills → gen:progress 的顺序）。`,
      )
      ok = false
    }
  }
  return ok
}

function main(): number {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const ids = args.filter((a) => !a.startsWith('--'))
  const todo = ids.length > 0 ? MUTATIONS.filter((m) => ids.includes(m.id)) : MUTATIONS
  if (todo.length === 0) {
    console.error(`没有匹配的变异。可用：\n  ${MUTATIONS.map((m) => m.id).join('\n  ')}`)
    return 2
  }

  // 判据④：先量基线。基线非零时无法把失败归因于当前变异。
  const scopes = [...new Set(todo.map((m) => m.scope))].sort()
  if (!json) process.stderr.write(`… 基线（${scopes.length} 个 scope）\n`)
  if (!baselineClean(scopes)) return 2

  const results: MutationResult[] = []
  for (const m of todo) {
    if (!json) process.stderr.write(`… ${m.id}\n`)
    const r = runOne(m)
    results.push(r)
    if (!json) {
      const mark =
        r.verdict === 'red' ? '✓' : r.verdict === 'green' ? '✗' : r.verdict === 'narrow-scope' ? '↔' : '?'
      console.log(`${mark} ${r.id.padEnd(32)} ${r.verdict.padEnd(13)} ${r.note}`)
    }
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    const red = results.filter((r) => r.verdict === 'red').length
    console.log(`\n${red}/${results.length} 变红`)
    for (const r of results.filter((x) => x.verdict !== 'red')) {
      const m = MUTATIONS.find((x) => x.id === r.id)!
      const tag =
        r.verdict === 'green' ? '⚠ 没人喊' : r.verdict === 'narrow-scope' ? '↔ scope 过期' : '? 没验成'
      console.log(`  ${tag}：${r.id} —— ${r.verdict === 'narrow-scope' ? r.note : m.why}`)
    }
  }
  return results.every((r) => r.verdict === 'red') ? 0 : 1
}

// 只有**直接跑这个文件**时才执行。`import.meta.url.endsWith('run.ts')` 不行——
// 被 import 时它同样为真，于是元测试一 import 就把整套变异跑了一遍然后 exit。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
