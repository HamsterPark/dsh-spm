/**
 * 发布卫生门（`scripts/release-hygiene.ts`）。
 *
 * 每次 `pnpm test --project contract` 都扫一遍整个仓：`git ls-files` 的文本文件（含未跟踪、未忽略的
 * 新文件）和全部金样。通用规则入仓；站点身份名单在仓外，由 `HYGIENE_SITE_LIST` 指向，没设时只跑
 * 通用规则（公开 CI 就是这样）。暂存分发包由 `scripts/build-minimal.ts` 在构建时扫，这里测它的判据。
 *
 * 植入样例一律运行时拼接：写成字面量，本文件自己就会被树扫描拦下。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DISTRIBUTION_EXEMPTIONS, RULES, SYNTHETIC_ROOTS, formatFinding, loadSiteList, manifestMarkProblem, scanContent,
  scanStagedDistribution, scanString, scanTree, type Finding, type RuleId,
} from '../../../../scripts/release-hygiene.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'release-hygiene.ts')

const j = (...parts: string[]): string => parts.join('')
const ip = (...octets: string[]): string => octets.join('.')
const B = '\\'
const cjk = (...codes: number[]): string => String.fromCodePoint(...codes)
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

type Layer = { decoded: boolean; golden: boolean }
const SRC: Layer = { decoded: false, golden: false }
const DEC: Layer = { decoded: true, golden: false }
const GOLD: Layer = { decoded: true, golden: true }

/** 每条规则至少一个被拦的植入样例、一个放行的近似样例。 */
const SAMPLES: Record<RuleId, { block: [string, Layer][]; pass: [string, Layer][] }> = {
  'private-ip': {
    block: [[ip('192', '168', '5', '7'), SRC], [ip('10', '1', '2', '3'), SRC], [j('ws://', ip('10', '0', '0', '5'), ':8080'), SRC]],
    pass: [[j(ip('10', '0', '0', '0'), '/8'), SRC], [j(ip('100', '64', '0', '0'), '/10'), SRC], [ip('192', '0', '2', '5'), SRC],
      [ip('10', '0', '26100', '1'), SRC]],
  },
  'win-user-path': {
    block: [[j('C:/', 'Users/alice/x'), SRC], [j('C:', B, 'Users', B, 'alice', B, 'x'), SRC], [j('C:', B, B, 'Users', B, B, 'alice', B, B, 'x'), SRC]],
    pass: [[j('C:', B, 'Users', B, '<name>', B, 'x'), SRC], [j('C:/', 'Users/%USERNAME%/x'), SRC], [j('C:', B, 'Users', B, 'Public', B, 'x'), SRC]],
  },
  'win-personal-dir': {
    block: [[j('D:/', 'alice/Desktop/x'), SRC]],
    pass: [[j('D:', B, 'Program Files', B, 'Documents', B, 'x'), SRC]],
  },
  'posix-home': {
    block: [[j('/ho', 'me/alice/.ssh/id'), SRC], [j('file://', '/ho', 'me/alice/x'), SRC]],
    pass: [[j('/ho', 'me/user/x'), SRC], [j('/api', '/ho', 'me/x'), SRC]],
  },
  'unc-share': {
    block: [[j(B, B, 'labpc', B, 'share'), DEC]],
    // 源码里的转义写法不算：只用于解码后的文本。
    pass: [[j(B, B, 'labpc', B, 'share'), SRC]],
  },
  'golden-abs-path': {
    block: [[j('E:/', 'satellite/data/x'), GOLD]],
    pass: [[j('E:/', 'satellite/data/x'), DEC]],
  },
  'sk-key': {
    block: [[j('s', 'k-', '0123456789abcdef0123456789abcdef'), SRC]],
    pass: [[j('s', 'k-', 'x'.repeat(24)), SRC], [j('ta', 'sk-', '12345678901234567890'), SRC]],
  },
  'github-token': {
    block: [[j('gh', 'p_', 'A1'.repeat(18)), SRC]],
    pass: [[j('gh', 'p_', 'short'), SRC]],
  },
  'aws-key': {
    block: [[j('AK', 'IA', 'ABCDEFGHIJ234567'), SRC]],
    pass: [[j('AK', 'IA', 'abc'), SRC]],
  },
  'private-key-block': {
    block: [[j('-----BEGIN ', 'OPENSSH PRIVATE', ' KEY-----'), SRC]],
    pass: [[j('-----BEGIN ', 'PUBLIC', ' KEY-----'), SRC]],
  },
  'quoted-secret': {
    block: [[j('api', 'Key: "', 'abcdefghijklmnop"'), SRC]],
    pass: [[j('api', '_key = "', 'YOUR_API_KEY_HERE"'), SRC]],
  },
  'dev-owner-title': { block: [[cjk(0x4eea, 0x5668, 0x4e3b, 0x4eba), SRC]], pass: [[cjk(0x4eea, 0x5668), SRC]] },
  'dev-dated-speaker': {
    block: [[j(cjk(0x64cd, 0x4f5c, 0x5458), ' 08-10', cjk(0xff1a)), SRC]],
    pass: [[j(cjk(0x64cd, 0x4f5c, 0x5458), ' 08-10'), SRC]],
  },
  'dev-quoted-speech': {
    block: [[j(cjk(0x7528, 0x6237), cjk(0xff1a), cjk(0x300c)), SRC]],
    pass: [[j(cjk(0x7528, 0x6237), cjk(0xff1a)), SRC]],
  },
  'dev-agent-role': { block: [[j('team', '-lead'), SRC]], pass: [[j('team', ' lead'), SRC]] },
  'dev-colloquial': { block: [[cjk(0x54c8, 0x54c8), SRC]], pass: [[cjk(0x54c8), SRC]] },
  'dev-pejorative': { block: [[cjk(0x767d, 0x75f4), SRC]], pass: [[cjk(0x767d), SRC]] },
  'dev-qinkou': { block: [[cjk(0x4eb2, 0x53e3), SRC]], pass: [[cjk(0x4eb2), SRC]] },
  'dev-bang3': { block: [['!'.repeat(3), SRC], [cjk(0xff01, 0xff01, 0xff01), SRC]], pass: [['!'.repeat(2), SRC]] },
}

const temps: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** 写一份临时名单；每次一个新文件（扫描器按路径缓存名单）。 */
const siteList = (...lines: string[]): string => {
  const path = join(tempDir(), 'site-list.txt')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

const PLANTED = 'zqxjvplanted'

/** 整棵树只扫一次，第 3、4 组共用。 */
let tree: ReturnType<typeof scanTree> | undefined
const treeScan = (): ReturnType<typeof scanTree> => (tree ??= scanTree(ROOT, {}))

describe('发布卫生门：通用规则', () => {
  it('样例表与规则表一一对应（加了规则就得加样例）', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(RULES.map((r) => r.id).sort())
  })

  it('没有哪条规则能匹配空串（否则每个空行都会被报出来）', () => {
    for (const rule of RULES) expect(new RegExp(rule.rx.source, rule.rx.flags.replace('g', '')).test(''), rule.id).toBe(false)
  })

  it.each(RULES.map((r) => r.id))('%s：植入样例被拦，近似样例放行', (id) => {
    const { block, pass } = SAMPLES[id]
    expect(block.length).toBeGreaterThan(0)
    expect(pass.length).toBeGreaterThan(0)
    for (const [text, layer] of block) expect(scanString(text, layer).map((h) => h.rule), text).toContain(id)
    for (const [text, layer] of pass) expect(scanString(text, layer), text).toEqual([])
  })

  it('密钥类命中只回显前 4 位与长度', () => {
    const key = j('s', 'k-', '0123456789abcdef0123456789abcdef')
    const [finding] = scanContent('a.ts', bytes(`const k = ${key}\n`), {})
    expect(finding?.rule).toBe('sk-key')
    expect(formatFinding(finding!)).not.toContain(key)
    expect(finding?.excerpt).toContain(String(key.length))
  })

  it('金样层：正斜杠与 JSON 转义写法的用户目录路径都被拦，位置报 JSON 指针', () => {
    const json = JSON.stringify({ a: j('C:/', 'Users/alice/AppData/Local/Temp/x'), b: j('C:', B, 'Users', B, 'alice') })
    const findings = scanContent('spec/golden/x.json', bytes(json), {})
    const at = (where: string): string[] => findings.filter((f) => f.where === where).map((f) => f.rule)
    expect(at('/a')).toEqual(expect.arrayContaining(['win-user-path', 'golden-abs-path']))
    expect(at('/b')).toEqual(expect.arrayContaining(['win-user-path', 'golden-abs-path']))
    // 同一份内容不在金样目录下：只有通用路径规则
    expect(scanContent('docs/x.json', bytes(json), {}).map((f) => f.rule)).not.toContain('golden-abs-path')
  })
})

describe('发布卫生门：整棵树', () => {
  // 缺省 20 s 是给单元用例的；整棵树要读几十 MB 的金样，单独给 60 s。
  it('跟踪文件与未跟踪的新文件、全部金样：0 命中，且确实扫过（防空转）', () => {
    const { findings, scanned, goldenFiles } = treeScan()
    expect(findings.map(formatFinding)).toEqual([])
    expect(scanned).toBeGreaterThanOrEqual(700)
    expect(goldenFiles).toBeGreaterThanOrEqual(50)
  }, 60_000)

  it('设了站点名单就带名单再扫一遍', () => {
    const list = process.env['HYGIENE_SITE_LIST']
    if (list === undefined || list === '') {
      console.info('HYGIENE_SITE_LIST 未设：只跑了通用规则。')
      return
    }
    expect(scanTree(ROOT, { siteListPath: list }).findings.map(formatFinding)).toEqual([])
  }, 60_000)

  it('合成路径登记簿：每条有理由，且在这次扫描里被用到（过期项让测试变红）', () => {
    const { used } = treeScan()
    SYNTHETIC_ROOTS.forEach((root, i) => {
      expect(root.reason.trim(), root.prefix).not.toBe('')
      expect(used.has(i), `${root.reason} 没有被用到`).toBe(true)
    })
  }, 60_000)

  it('分发包放行登记：每条有理由（要构建后才用得到，这里只查理由）', () => {
    for (const e of DISTRIBUTION_EXEMPTIONS) expect(e.reason.trim(), e.file).not.toBe('')
  })
})

describe('发布卫生门：站点名单', () => {
  const plain = bytes(`see ${PLANTED} here\n`)

  it('没给名单只跑通用规则', () => {
    expect(scanContent('a.md', plain, {})).toEqual([])
  })

  it('名单命中只报序号，输出里搜不到那个词', () => {
    const list = siteList('# comment', '', 'another-entry', PLANTED.toUpperCase())
    const findings = scanContent('a.md', plain, { siteListPath: list })
    expect(findings.map(formatFinding)).toEqual(['a.md:1 [site#2]'])
    expect(findings.map(formatFinding).join('\n').toLowerCase()).not.toContain(PLANTED)
  })

  it('re: 条目按不分大小写的正则匹配', () => {
    const list = siteList(String.raw`re:\bzqxjv\w+`)
    expect(scanContent('a.md', plain, { siteListPath: list }).map((f) => f.rule)).toEqual(['site#1'])
  })

  it('名单读不了、没有条目、普通条目太短、正则写错、能匹配空串：一律抛错，且不回显条目', () => {
    expect(() => loadSiteList(join(tempDir(), 'missing.txt'))).toThrow(/读不了/)
    expect(() => loadSiteList(siteList('# only comments', ''))).toThrow(/没有任何条目/)
    expect(() => loadSiteList(siteList('abc'))).toThrow(/第 1 行.*短于 4 个字符/)
    expect(() => loadSiteList(siteList('re:(unclosed'))).toThrow(/第 1 行.*正则/)
    expect(() => loadSiteList(siteList('re:x*'))).toThrow(/第 1 行.*空串/)
    try {
      loadSiteList(siteList('abc'))
    } catch (error) {
      expect(String(error)).not.toContain('abc')
    }
  })

  describe('整段 base64 的字符串值不按名单扫，通用规则照扫', () => {
    const list = (): string => siteList(PLANTED)
    // 只含 base64 字母表；中间藏一个名单词和一段 POSIX 用户目录路径
    const payload = (length: number): string => {
      const core = j('A'.repeat(40), '+', '/ho', 'me/alice/', 'B'.repeat(40), PLANTED)
      return core + 'C'.repeat(length - core.length)
    }
    const scanJson = (value: string): Finding[] =>
      scanContent('spec/golden/x.json', bytes(JSON.stringify({ a: value })), { siteListPath: list() })

    it('够格的载荷（≥256 字符、长度是 4 的倍数）：名单放行，posix-home 照样拦下', () => {
      const rules = scanJson(payload(256)).map((f) => f.rule)
      expect(rules).not.toContain('site#1')
      expect(rules).toContain('posix-home')
    })

    it('同一个词在普通字符串里：被名单拦下', () => {
      expect(scanJson(`see ${PLANTED} here`).map((f) => f.rule)).toContain('site#1')
    })

    it('不够格的串照扫：短于 256 字符，或长度不是 4 的倍数', () => {
      expect(scanJson(payload(252)).map((f) => f.rule)).toContain('site#1')
      expect(scanJson(payload(257)).map((f) => f.rule)).toContain('site#1')
    })

    it('同样的载荷写在非 JSON 文件里：照扫', () => {
      const findings = scanContent('a.md', bytes(`${payload(256)}\n`), { siteListPath: list() })
      expect(findings.map((f) => f.rule)).toContain('site#1')
    })
  })
})

describe('发布卫生门：manifest 的覆盖层标记', () => {
  it('仓里的 spec/golden/manifest.json 过检查', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(ROOT, 'spec', 'golden', 'manifest.json'), 'utf8'))
    expect(manifestMarkProblem(manifest)).toBeUndefined()
  })

  it('带 reference 就必须带 public_text.overlay（12 位小写十六进制）；旧格式不要求', () => {
    expect(manifestMarkProblem({ reference: {} })).toBeDefined()
    expect(manifestMarkProblem({ reference: {}, public_text: { overlay: 'XYZ' } })).toBeDefined()
    expect(manifestMarkProblem({ reference: {}, public_text: { overlay: '0123456789ab' } })).toBeUndefined()
    expect(manifestMarkProblem({ spec_source: {} })).toBeUndefined()
  })
})

describe('发布卫生门：暂存分发包', () => {
  const FILES = ['package.json', 'cordis.minimal.patch.yml', 'lib/index.js', 'lib/minimal.js']
  const stage = (extra: Record<string, string> = {}, omit: string[] = []): string => {
    const dir = tempDir()
    const files: Record<string, string> = {
      'package.json': `${JSON.stringify({ name: 'dsh-spm', version: '0.0.0' }, null, 2)}\n`,
      'cordis.minimal.patch.yml': '- insert: []\n',
      'lib/index.js': 'export const x = 1\n',
      'lib/minimal.js': 'export const y = 2\n',
      ...extra,
    }
    for (const [rel, text] of Object.entries(files)) {
      if (omit.includes(rel)) continue
      mkdirSync(join(dir, rel, '..'), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
    return dir
  }

  it('四个干净文件：无命中', () => {
    expect(scanStagedDistribution(stage(), FILES, {})).toEqual([])
  })

  it('多出一个文件或少一个文件都报出来', () => {
    expect(scanStagedDistribution(stage({ 'README.md': 'x\n' }), FILES, {}).map(formatFinding)).toEqual(['README.md [unexpected-file]'])
    expect(scanStagedDistribution(stage({}, ['lib/minimal.js']), FILES, {}).map(formatFinding)).toEqual(['lib/minimal.js [missing-file]'])
  })

  it('打进 lib/index.js 的泄漏与名单词都被拦下', () => {
    const dir = stage({ 'lib/index.js': `const host = '${ip('10', '1', '2', '3')}'\nconst s = '${PLANTED}'\n` })
    const findings = scanStagedDistribution(dir, FILES, { siteListPath: siteList(PLANTED) })
    expect(findings.map(formatFinding)).toEqual([`lib/index.js:1 [private-ip] ${ip('10', '1', '2', '3')}`, 'lib/index.js:2 [site#1]'])
  })
})

describe('发布卫生门：命令行', () => {
  const run = (args: string[]): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HYGIENE_SITE_LIST: '' } }) }
    } catch (error) {
      const e = error as { status: number; stdout: string }
      return { code: e.status, out: e.stdout }
    }
  }

  it('--golden-dir：植入的金样退出码 1，报出两条路径规则与 JSON 指针', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'x.json'), `${JSON.stringify({ a: j('C:/', 'Users/alice/AppData/Local/Temp/x') })}\n`)
    const { code, out } = run(['--golden-dir', dir])
    expect(code).toBe(1)
    expect(out).toContain('x.json#/a [win-user-path]')
    expect(out).toContain('x.json#/a [golden-abs-path]')
    expect(out).toMatch(/scanned=1 goldenFiles=1 findings=2\s*$/)
  })

  it('--site-list：命中只有「文件:位置 [site#序号]」，输出里搜不到那个词', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'x.json'), `${JSON.stringify({ a: `see ${PLANTED} here` })}\n`)
    const { code, out } = run(['--golden-dir', dir, '--site-list', siteList(PLANTED)])
    expect(code).toBe(1)
    expect(out).toContain('x.json#/a [site#1]')
    expect(out.toLowerCase()).not.toContain(PLANTED)
  })

  it('参数错了退出码 2', () => {
    expect(run(['--bogus']).code).toBe(2)
  })
})
