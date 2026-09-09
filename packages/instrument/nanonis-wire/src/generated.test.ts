import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NANONIS_METHODS, createFacade, type NanonisFacade } from './generated/methods.js'
import { encodeArgs } from './types.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('生成物与源同步', () => {
  it('重跑生成器无 diff', () => {
    // 生成物入仓是为了让读代码的人直接看到 671 个签名；代价是它可能与源脱节。
    // 这条就是那个代价的保险，也是 CI 的同一条命令。
    expect(() =>
      execFileSync(process.execPath, ['scripts/gen-nanonis.ts', '--check'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
    ).not.toThrow()
  })
})

describe('协议表读对了', () => {
  it('671 个方法，两个 alias 已解引用', () => {
    expect(Object.keys(NANONIS_METHODS)).toHaveLength(671)
    // Osci2T_ChGet 的 args/returns/command 在源里都是 null，靠 alias_of 指向 Osci2T_ChsGet
    expect(NANONIS_METHODS.Osci2T_ChGet.command).toBe(NANONIS_METHODS.Osci2T_ChsGet.command)
  })

  it('12 个方法来自 MAST 给 nanonis_spm 打的补丁', () => {
    const patched = Object.entries(NANONIS_METHODS).filter(([, s]) => s.source === 'patch')
    expect(patched).toHaveLength(12)
    expect(patched.map(([n]) => n)).toContain('Scan_PropsGet')
  })

  it('用 args 而不是 params——后者对不上', () => {
    // Osci1T_TrigGet 在源里声明 6 个 params 但只有 4 个 args；params 还可能整个缺失。
    expect(NANONIS_METHODS.Osci1T_TrigGet.args).toHaveLength(4)
  })
})

/**
 * **类型层断言：只有 `tsc -b` 能抓住消歧表写错。**
 *
 * 2026-09-09 变红演练发现的缺口：把消歧表里 `Scan.PropsSet` 的下标从 5 改成 4，
 * 重新生成后**运行期测试全绿**——因为消歧只改变生成的 TS 类型，`args` 的名字、
 * 格式串、编码路径一个都没变。而写错的后果很实在：调用方给 `Comment` 传数组，
 * 编出的字节完全不同，服务端解出垃圾。
 *
 * 所以这条断言必须活在类型层。消歧表一错，`_propsSetShape` 就是 `never`，`pnpm build` 当场红。
 */
type PropsSetIsDisambiguated =
  NanonisFacade['Scan_PropsSet'] extends (
    continuous: number,
    bouncy: number,
    autosave: number,
    series: string, // 下标 3：普通字符串
    comment: string, // 下标 4：普通字符串
    modules: string[], // 下标 5：**字符串数组**——消歧表里唯一那一项
    autopaste: number,
  ) => Promise<[]>
    ? true
    : never
const _propsSetShape: PropsSetIsDisambiguated = true
void _propsSetShape

describe('c 的二义按消歧表生成', () => {
  it('Scan.PropsSet 只有 Modules_names 是字符串数组', () => {
    const spec = NANONIS_METHODS.Scan_PropsSet
    expect(spec.args.map((a) => a.name)).toEqual([
      'Continuous_scan', 'Bouncy_scan', 'Autosave',
      'Series_name', 'Comment', 'Modules_names', 'Autopaste',
    ])
    // 三个参数格式串完全相同，TS 类型却不同——这正是格式串消不掉的歧义
    expect([spec.args[3]!.fmt, spec.args[4]!.fmt, spec.args[5]!.fmt]).toEqual(['+*c', '+*c', '+*c'])
  })

  it('类型上的差别是真的：同一个 +*c，字符串与数组编出不同字节', () => {
    const asStr = encodeArgs([{ value: 'ab', fmt: '+*c' }])
    const asArr = encodeArgs([{ value: ['ab'], fmt: '+*c' }])
    expect(Buffer.from(asStr).toString('hex')).not.toBe(Buffer.from(asArr).toString('hex'))
  })
})

describe('门面把调用转成线协议规格', () => {
  it('按 args 顺序配对，命令名与返回格式原样传下去', async () => {
    const seen: { command: string; args: readonly unknown[]; returns: readonly string[] }[] = []
    const typed = createFacade(async (command, args, returns) => {
      seen.push({ command, args, returns })
      return []
    })

    await typed.Bias_Set(1.5)
    expect(seen[0]).toEqual({
      command: 'Bias.Set',
      args: [{ value: 1.5, fmt: 'f' }],
      returns: [],
    })

    await typed.Scan_Action(1, 0)
    expect(seen[1]!.command).toBe('Scan.Action')
    expect(seen[1]!.args).toEqual([
      { value: 1, fmt: 'H' },
      { value: 0, fmt: 'I' },
    ])
  })

  it('无参方法也走同一条路', async () => {
    let got: readonly string[] = []
    const typed = createFacade(async (_c, _a, returns) => {
      got = returns
      return [1.5]
    })
    await typed.Bias_Get()
    expect(got).toEqual(['f'])
  })
})
