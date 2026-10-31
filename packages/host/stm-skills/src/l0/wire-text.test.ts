/**
 * 线协议文本：二进制串怎么还原成真字符（`wire-text.ts`）。
 *
 * `nanonis-wire` 把 `*-c` / `*+c` / `**c` 的回复解成逐字节一字符的串，字节是哪个代码页它不知道。
 * 这里的判据是**还原这一步**：路径按 UTF-8、GBK、windows-1252 逐个试，取指向真实存在的；写回仪器的
 * 串按字节合不合法还原。GBK 的盘没法在每台机器上真建出来，所以大部分格子用注入的假探针；
 * 真文件系统那一路用临时目录里一个带中文名的子目录钉住。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillCallRecord, SkillContext } from 'dsh-spm-kernel'
import { makeGetLatestScanFile } from './frames.js'
import { GetSessionPath } from './reads-hw.js'
import { decodeWireText, lastPath, repairWirePath, type PathProbe } from './wire-text.js'
import { SetSessionPath } from './writes-verified.js'

/** 字节 → 二进制串（逐字节一字符），与 `nanonis-wire` 解 `*-c` 的结果同形。 */
const bin = (bytes: readonly number[]): string => Buffer.from(bytes).toString('latin1')
/** 真字符 → 它的 UTF-8 字节的二进制串。 */
const utf8Bin = (text: string): string => Buffer.from(text, 'utf8').toString('latin1')

const ASCII = (s: string): number[] => [...Buffer.from(s, 'ascii')]
/** 「数据」的 GBK 字节；这四个字节按 UTF-8 读是非法序列。 */
const GBK_SHUJU = [0xca, 0xfd, 0xbe, 0xdd]

/** 一块假盘：`paths` 里的路径存在，`dirs` 里的是目录；上级按最后一个分隔符切。 */
function fakeDisk(paths: readonly string[], dirs: readonly string[] = []): PathProbe & { asked: string[] } {
  const here = new Set(paths)
  const folders = new Set([...dirs, ...paths])
  const asked: string[] = []
  const parentOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))
  return {
    asked,
    exists: (p) => {
      asked.push(p)
      return here.has(p)
    },
    parentIsDirectory: (p) => {
      asked.push(`^${p}`)
      return folders.has(parentOf(p))
    },
  }
}

describe('repairWirePath · 路径按字节逐个代码页试，取指向真实存在的', () => {
  it('P1 · 纯 ASCII 原样返回，一次盘都不问', () => {
    const disk = fakeDisk([])
    expect(repairWirePath('D:\\Data\\Session_', disk)).toBe('D:\\Data\\Session_')
    expect(disk.asked).toEqual([])
  })

  it('P2 · 已经是真字符（有 >0xFF 的码元）原样返回——不能再当字节「修」成乱码', () => {
    // 「文」「件」的低字节是 0x87、0xF6：要是被当成字节截断，剩下的就是一串非 ASCII 字节
    const disk = fakeDisk([])
    expect(repairWirePath('D:\\文件\\x', disk)).toBe('D:\\文件\\x')
    expect(disk.asked).toEqual([])
  })

  it('P3 · UTF-8 的字节、UTF-8 那个读法存在 ⇒ 还原成真字符', () => {
    const real = 'D:\\数据\\scan'
    expect(repairWirePath(utf8Bin(real), fakeDisk([real]))).toBe(real)
  })

  it('P4 · GBK 的字节（按 UTF-8 读是非法的）、GBK 那个读法存在 ⇒ 还原成真字符', () => {
    const raw = bin([...ASCII('D:\\'), ...GBK_SHUJU, ...ASCII('\\scan')])
    expect(repairWirePath(raw, fakeDisk(['D:\\数据\\scan']))).toBe('D:\\数据\\scan')
  })

  it('P5 · 同一串字节在两个代码页里都合法时，**取存在的那个**，不是取第一个合法的', () => {
    // 「é」的 UTF-8 是 C3 A9，按 GBK 读也是一个合法的汉字：两个读法都能解出来。
    const raw = bin([...ASCII('D:\\'), 0xc3, 0xa9])
    const asUtf8 = 'D:\\é'
    const asGbk = `D:\\${new TextDecoder('gbk').decode(Uint8Array.from([0xc3, 0xa9]))}`
    expect(asGbk).not.toBe(asUtf8)
    expect(repairWirePath(raw, fakeDisk([asGbk]))).toBe(asGbk)
    expect(repairWirePath(raw, fakeDisk([asUtf8]))).toBe(asUtf8)
  })

  it('P6 · 哪个读法都不存在 ⇒ 取第一个能解出来的：合法 UTF-8 优先，否则 GBK', () => {
    const disk = fakeDisk([])
    expect(repairWirePath(utf8Bin('D:\\数据\\scan'), disk)).toBe('D:\\数据\\scan')
    expect(repairWirePath(bin([...ASCII('D:\\'), ...GBK_SHUJU]), disk)).toBe('D:\\数据')
  })

  it('P7 · 「目录 + 文件名前缀」：完整路径不存在、但上级是目录，也算指到了真实位置', () => {
    // Nanonis 的会话路径常是一个前缀（`...\Session_`），那个文件并不存在。
    // 两个读法都合法时，只有上级目录能分出该取哪一个。
    const raw = bin([...ASCII('D:\\'), 0xc3, 0xa9, ...ASCII('\\Session_')])
    const gbkDir = `D:\\${new TextDecoder('gbk').decode(Uint8Array.from([0xc3, 0xa9]))}`
    expect(repairWirePath(raw, fakeDisk([], [gbkDir]))).toBe(`${gbkDir}\\Session_`)
  })

  it('P8 · UTF-8 与 GBK 都读不通，最后一档 windows-1252 总能解', () => {
    // 「café」按 Latin-1 的一字节 E9 结尾：UTF-8 缺后续字节、GBK 缺第二个字节。
    expect(repairWirePath(bin([...ASCII('D:\\caf'), 0xe9]), fakeDisk([]))).toBe('D:\\café')
  })

  it('P9 · windows-1252 不是 Latin-1：0x80–0x9F 落在它自己的位置上', () => {
    // 这一档存在的理由是「总能解」，不是「解得对」——但它得是 windows-1252（WHATWG 的表），不是 Latin-1。
    expect(repairWirePath(bin([...ASCII('D:\\'), 0x80, 0xff]), fakeDisk([]))).toBe('D:\\€ÿ')
  })

  it('P10 · windows-1252 档的码表在本仓：0x80–0x9F 整段与 WHATWG 的表逐个相同', () => {
    // Node 22 的 TextDecoder('windows-1252') 把这一段当 Latin-1 解成 C1 控制字符，Node 24 的按 WHATWG。
    // 末尾的 0xFF 让 GBK 档不成立（0x9F 后面没有合法的尾字节），只剩这一档。
    const c1 = Array.from({ length: 32 }, (_, i) => 0x80 + i)
    expect(repairWirePath(bin([...c1, 0xff]), fakeDisk([]))).toBe(
      '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f' +
        '\u0090‘’“”•–—˜™š›œ\u009džŸÿ',
    )
  })
})

describe('decodeWireText · 写回仪器之前，不看文件系统', () => {
  it('S1 · 合法 UTF-8 与合法 GBK 都还原成真字符', () => {
    expect(decodeWireText(utf8Bin('数据_Au111'))).toBe('数据_Au111')
    expect(decodeWireText(bin([...GBK_SHUJU, ...ASCII('_Au111')]))).toBe('数据_Au111')
  })

  it('S2 · 两样都不合法就原样返回——不替读不懂的字节编一个字符', () => {
    // 0x80 在 windows-1252 里是「€」：它对任何字节都「成功」，所以这里不用这一档
    const odd = bin([0x41, 0x80, 0xff])
    expect(decodeWireText(odd)).toBe(odd)
  })

  it('S2b · 纯 ASCII 与已经是真字符的串原样返回', () => {
    expect(decodeWireText('Au111')).toBe('Au111')
    expect(decodeWireText('')).toBe('')
    expect(decodeWireText('文件')).toBe('文件')
  })

  it('S2c · GBK 档按 GBK 自己的字节结构判合法：单独的 0xFF、GB18030 的四字节序列都不算，0x80 算', () => {
    // 认不认不交给运行时：Node 22 的 gbk 解码器把 0xFF 解成私用区的 U+F8F5，Node 24 的把 81 30 81 30 解成 U+0080
    for (const bytes of [[0x41, 0xff], [0x41, 0x81, 0x30, 0x81, 0x30], [0xca, 0xfd, 0xff, 0x41]]) {
      const odd = bin(bytes)
      expect(decodeWireText(odd)).toBe(odd)
    }
    // 0x80 单独一个字节在 GBK（CP936）里是「€」，两个 Node 版本都这么解
    expect(decodeWireText(bin([0x41, 0x80]))).toBe('A€')
  })
})

describe('lastPath · body 里最后一个字符串，并还原', () => {
  const rec = (values: unknown[] | undefined): SkillCallRecord =>
    ({ method: 'Util_SessionPathGet', args: [], ...(values === undefined ? {} : { values }) }) as SkillCallRecord

  it('路径跟在它的长度后面：取最后一个字符串', () => {
    expect(lastPath(rec([5, 'D:\\ab']))).toBe('D:\\ab')
    expect(lastPath(rec([5, 'first', 7, 'last']))).toBe('last')
  })

  it('一个字符串都没有、或者没有 body：空串', () => {
    expect(lastPath(rec([5, 6]))).toBe('')
    expect(lastPath(rec([]))).toBe('')
    expect(lastPath(rec(undefined))).toBe('')
  })

  it('探针沿用传进来的那个', () => {
    const real = 'D:\\数据\\x'
    expect(lastPath(rec([0, bin([...ASCII('D:\\'), ...GBK_SHUJU, ...ASCII('\\x')])]), fakeDisk([real]))).toBe(real)
  })
})

describe('读真文件系统：临时目录里一个带中文名的子目录', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length > 0) {
      try {
        rmSync(roots.pop() as string, { recursive: true, force: true })
      } catch {
        // 清不掉就算了 —— 临时目录不是判据
      }
    }
  })
  // 两层中文名：只有一层时，乱码路径的 `dirname` 恰好是真目录，「目录 + 前缀」的归一会替它蒙混过关
  const session = (): { dir: string; wire: string } => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-wire-'))
    roots.push(root)
    const dir = join(root, '数据', '会话')
    mkdirSync(dir, { recursive: true })
    return { dir, wire: utf8Bin(dir) }
  }
  const scripted = (replies: Record<string, unknown[]>): { ctx: SkillContext; calls: unknown[][] } => {
    const calls: unknown[][] = []
    const call = (verb: string, args: unknown[]): SkillCallRecord => {
      calls.push([verb, ...args])
      return { method: verb, args, values: replies[verb] ?? [] }
    }
    const ctx = {
      signal: new AbortController().signal,
      now: () => 1_000_000,
      sleep: () => Promise.resolve(),
      safeCall: (m: string, ...a: unknown[]) => Promise.resolve(call(m, a)),
      emergencyCall: (m: string, ...a: unknown[]) => Promise.resolve(call(m, a)),
      runSkill: () => Promise.resolve({ success: false, error: '桩不支持' }),
    } as unknown as SkillContext
    return { ctx, calls }
  }

  it('默认探针问真盘：UTF-8 的路径还原成存在的那个', () => {
    const { dir, wire } = session()
    const rec = { method: 'Util_SessionPathGet', args: [], values: [wire.length, wire] } as SkillCallRecord
    expect(wire).not.toBe(dir)
    expect(lastPath(rec)).toBe(dir)
  })

  it('哪里都不存在：默认探针不抛，取第一个能解出来的', () => {
    const ghost = join(tmpdir(), 'dsh-wire-no-such-dir', '数据')
    const wire = utf8Bin(ghost)
    const rec = { method: 'Util_SessionPathGet', args: [], values: [wire.length, wire] } as SkillCallRecord
    expect(lastPath(rec)).toBe(ghost)
  })

  it('GetSessionPath 交出真字符的路径', async () => {
    const { dir, wire } = session()
    const { ctx } = scripted({ Util_SessionPathGet: [wire.length, wire] })
    const r = await GetSessionPath.execute(ctx, {})
    expect((r.data as { session_path: string }).session_path).toBe(dir)
  })

  it('GetLatestScanFile：会话目录带中文名也找得到文件——原先所有找扫描文件的地方都扑空', async () => {
    const { dir, wire } = session()
    const file = join(dir, 'x_0001.sxm')
    writeFileSync(file, 'x')
    const { ctx } = scripted({ Util_SessionPathGet: [wire.length, wire] })
    const r = await makeGetLatestScanFile({ nowS: () => Date.now() / 1000 }).execute(ctx, { max_age_s: 300 })
    expect((r.data as { path: string }).path).toBe(file)
  })

  it('SetSessionPath 的回读走同一个解析器：写了中文路径、仪器按 UTF-8 回显，核对通过', async () => {
    const { dir, wire } = session()
    const { ctx, calls } = scripted({ Util_SessionPathGet: [wire.length, wire] })
    const r = await SetSessionPath.execute(ctx, { session_path: dir })
    expect(r.success).toBe(true)
    expect(calls[0]).toEqual(['Util_SessionPathSet', dir, 1])
    expect((r.data as { session_path: string; verified: boolean }).session_path).toBe(dir)
  })
})

describe('S3 · 会话路径只有一个解析器', () => {
  /** stm-skills/src 下的非测试源码，路径用 `/` 分隔。 */
  const sources = (): { file: string; text: string }[] => {
    const src = fileURLToPath(new URL('..', import.meta.url))
    return (readdirSync(src, { recursive: true }) as string[])
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((file) => ({ file, text: readFileSync(join(src, file), 'utf8') }))
  }

  it('`lastString(` 只出现在 wire-text.ts——别处再抄一份，读与回读就可能各说各话', () => {
    const offenders = sources()
      .filter((s) => s.file !== 'l0/wire-text.ts' && s.text.includes('lastString('))
      .map((s) => s.file)
    expect(offenders).toEqual([])
  })

  it('向仪器要 `Util_SessionPathGet` 的文件，都用 `lastPath(` 解析它的回包', () => {
    const askers = sources().filter((s) => s.text.includes("'Util_SessionPathGet'"))
    // 扫描本身别空转：这几个是已知的消费者
    expect(askers.map((s) => s.file)).toEqual(expect.arrayContaining(['save-dir.ts', 'l0/frames.ts', 'l0/reads-hw.ts']))
    expect(askers.filter((s) => !s.text.includes('lastPath(')).map((s) => s.file)).toEqual([])
  })
})
