/**
 * 跑变异演练。
 *
 *     node tools/mutate/run.ts              # 全部
 *     node tools/mutate/run.ts k2-abort-latch schema-effective-bounds
 *     node tools/mutate/run.ts --json       # 机器读的结果（meta 测试用）
 *
 * 每一条都走完整的三判据，任何一条不满足就判 `inconclusive`——
 * **「没变红」和「压根没验」必须是两个不同的结论**，不然这套东西只会给人虚假的安心。
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
  /** `red` = 达成目的；`green` = 拆了也没人喊；`inconclusive` = 三判据没走完 */
  readonly verdict: 'red' | 'green' | 'inconclusive'
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
    const t = run([...PNPM, 'run', '--project', '!integration', m.scope, '--reporter=dot'], {
      allowFail: true,
    })
    const line = /^\s+Tests\s+(?:(\d+) failed \| )?(\d+) passed/m.exec(t.out)
    if (line === null) return fail('测试没跑起来（输出里找不到 Tests 汇总行）')
    const failed = Number(line[1] ?? 0)
    const passed = Number(line[2] ?? 0)
    if (failed + passed === 0) return fail('测试跑了 0 条')

    return {
      id: m.id,
      verdict: failed > 0 ? 'red' : 'green',
      failed,
      passed,
      note: failed > 0 ? `${failed} 条变红` : '拆掉也没人喊',
    }
  } finally {
    // 还原并**强制重建**：见文件抬头的 mtime 陷阱
    writeFileSync(path, original, 'utf8')
    build()
  }
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

  const results: MutationResult[] = []
  for (const m of todo) {
    if (!json) process.stderr.write(`… ${m.id}\n`)
    const r = runOne(m)
    results.push(r)
    if (!json) {
      const mark = r.verdict === 'red' ? '✓' : r.verdict === 'green' ? '✗' : '?'
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
      console.log(`  ${r.verdict === 'green' ? '⚠ 没人喊' : '? 没验成'}：${r.id} —— ${m.why}`)
    }
  }
  return results.every((r) => r.verdict === 'red') ? 0 : 1
}

// 只有**直接跑这个文件**时才执行。`import.meta.url.endsWith('run.ts')` 不行——
// 被 import 时它同样为真，于是元测试一 import 就把整套变异跑了一遍然后 exit。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
