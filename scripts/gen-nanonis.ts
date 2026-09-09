/**
 * 从 `spec/nanonis/nanonis_commands.json` 生成 typed façade。
 *
 *     node scripts/gen-nanonis.ts            # 写文件
 *     node scripts/gen-nanonis.ts --check    # 只比对，有 diff 就非零退出（CI 用）
 *
 * 生成物入仓（`packages/instrument/nanonis-wire/src/generated/methods.ts`）：671 个方法
 * 手写不现实，但**读代码的人要能直接看到签名**，而不是去猜一张运行期表。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const SPEC = fileURLToPath(new URL('spec/nanonis/nanonis_commands.json', root))
const OUT = fileURLToPath(new URL('packages/instrument/nanonis-wire/src/generated/methods.ts', root))

interface Arg {
  name: string
  fmt: string
}
interface Method {
  command?: string
  args?: Arg[] | null
  returns?: string[] | null
  source?: string
  alias_of?: string
}

/**
 * `c` 参数的二义**不在协议表里**：同一个 `+*c`，字符串与数组产出完全不同的字节。
 * 消歧表硬编码在 STM-Bench 的 `wire/spec.py::ARRAY_STRING_ARGS`，这里是它的副本
 * ——**改了要两边一起改**（`spec/nanonis/README.md` 第 3 条）。
 */
const ARRAY_STRING_ARGS: Readonly<Record<string, readonly number[]>> = {
  'Scan.PropsSet': [5], // Modules_names；同方法的 3 Series_name / 4 Comment 是普通字符串
  'TCPLog.ChsSet': [],
}

/** fmt → TS 类型。规则见 PLAN §7.1；形状的依据是 `spec/golden/wire_types.json`。 */
function tsType(fmt: string, isStringArray = false): string {
  if (fmt === '*2c') return 'string[][]'
  if (fmt.endsWith('c')) {
    if (fmt === '*+c' || fmt === '**c') return 'string[]'
    return isStringArray ? 'string[]' : 'string' // +*c / *-c，二义由消歧表定
  }
  if (fmt.startsWith('2')) return 'number[][]'
  if (fmt.includes('*')) return 'number[]'
  return 'number' // H h I i f d b B
}

function main(): number {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as { methods: Record<string, Method> }
  const raw = spec.methods

  const lines: string[] = [
    '// 本文件由 `node scripts/gen-nanonis.ts` 生成，**不要手改**。',
    '// 源：spec/nanonis/nanonis_commands.json（671 个方法，来源与四条读表须知见该目录 README）。',
    '// CI 校验重生成无 diff。',
    '',
    "import type { ArgValue } from '../types.js'",
    '',
    '/** 一个方法的线协议规格。`args` 的顺序就是编码顺序。 */',
    'export interface MethodSpec {',
    '  readonly command: string',
    '  readonly args: readonly { readonly name: string; readonly fmt: string }[]',
    '  readonly returns: readonly string[]',
    "  /** `patch` = MAST 给 nanonis_spm 打过补丁的 12 个方法之一。 */",
    "  readonly source: 'upstream' | 'patch'",
    '}',
    '',
  ]

  // ── 表 ──
  const entries: string[] = []
  const facade: string[] = []
  let count = 0
  let patched = 0

  for (const method of Object.keys(raw).sort()) {
    const e = raw[method]!
    const target = e.alias_of ? raw[e.alias_of]! : e // alias 先解引用（两个 Osci2T_Ch*）
    const command = target.command
    if (!command || target.args == null || target.returns == null) continue
    count++
    if (target.source === 'patch') patched++

    const strArrayIdx = new Set(ARRAY_STRING_ARGS[command] ?? [])
    const args = target.args
    const rets = target.returns

    entries.push(
      `  ${method}: { command: '${command}', args: [` +
        args.map((a) => `{ name: '${a.name}', fmt: '${a.fmt}' }`).join(', ') +
        `], returns: [${rets.map((r) => `'${r}'`).join(', ')}], source: '${target.source ?? 'upstream'}' },`,
    )

    const params = args
      .map((a, i) => `${a.name}: ${tsType(a.fmt, strArrayIdx.has(i))}`)
      .join(', ')
    const ret = rets.length === 0 ? '[]' : `[${rets.map((r) => tsType(r)).join(', ')}]`
    facade.push(`  ${method}(${params}): Promise<${ret}>`)
  }

  lines.push(
    '/** 671 个方法里 `args`/`returns` 齐全的那些（两个 alias 已解引用）。 */',
    'export const NANONIS_METHODS = {',
    ...entries,
    '} as const satisfies Record<string, MethodSpec>',
    '',
    'export type NanonisMethodName = keyof typeof NANONIS_METHODS',
    '',
    '/**',
    ' * 调用一次线协议往返：编码参数、发帧、收帧、按 `returns` 解码。',
    ' * **不规定失败怎么表达**——抛还是包成 Result 是传输层与仪器服务的策略（PLAN §7.1），',
    ' * 生成层只负责把类型对上。',
    ' */',
    'export type NanonisCall = (',
    '  command: string,',
    '  args: readonly ArgValue[],',
    '  returns: readonly string[],',
    ') => Promise<unknown[]>',
    '',
    '/** 671 个方法的类型化门面。`typed.Bias_Get()` 有提示、参数名与旧仓一致。 */',
    'export interface NanonisFacade {',
    ...facade,
    '}',
    '',
    '/** 把一个调用器包成门面。逐方法查表 → 按 `args` 顺序配对 → 交给调用器。 */',
    'export function createFacade(call: NanonisCall): NanonisFacade {',
    '  const out: Record<string, unknown> = {}',
    '  for (const [method, spec] of Object.entries(NANONIS_METHODS)) {',
    '    out[method] = (...values: unknown[]) =>',
    '      call(',
    '        spec.command,',
    '        spec.args.map((a, i) => ({ value: values[i], fmt: a.fmt })),',
    '        spec.returns,',
    '      )',
    '  }',
    '  return out as unknown as NanonisFacade',
    '}',
    '',
  )

  const text = lines.join('\n')
  const check = process.argv.includes('--check')
  const current = (() => {
    try {
      return readFileSync(OUT, 'utf8')
    } catch {
      return null
    }
  })()

  if (check) {
    if (current === text) {
      console.log(`✓ generated/methods.ts 与源同步（${count} 个方法，其中 ${patched} 个来自 MAST 补丁）`)
      return 0
    }
    console.error('✗ generated/methods.ts 与源不同步。跑 `node scripts/gen-nanonis.ts` 重新生成。')
    return 1
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text, { encoding: 'utf8' })
  console.log(`✓ 生成 ${count} 个方法（其中 ${patched} 个来自 MAST 补丁），跳过 ${Object.keys(raw).length - count} 个空条目`)
  return 0
}

process.exit(main())
