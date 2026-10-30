/**
 * 发布卫生门：公开仓里不许出现私有网段地址、用户目录路径、疑似密钥和开发过程痕迹，
 * 也不许出现仓外名单里的站点身份词。
 *
 * 扫三类对象：`git ls-files` 的文本文件（含未跟踪、未忽略的新文件）；`spec/golden` 的 JSON 按解码后的
 * 键与字符串值扫，另加金样层规则；`pnpm build:minimal` 暂存的分发包文件。
 *
 * 通用规则在本文件。站点身份名单不入仓，由 `HYGIENE_SITE_LIST`（或 `--site-list`）指向的文本文件提供，
 * 缺省时只跑通用规则。名单命中只报序号，密钥只报前 4 位与长度：CI 日志是公开的。
 * 放行只有三种：规则自带的占位名与网段记法、合成路径登记簿 `SYNTHETIC_ROOTS`、分发包的
 * `DISTRIBUTION_EXEMPTIONS`。
 *
 * 本文件和它的测试会被自己扫到，所以不得出现违规字面量：中文规则用 `\u` 转义，样例在测试里运行时拼接。
 * `scripts/` 不在 `tsc -b` 里，类型错误构建发现不了；只用可擦除的 TS 语法，由 Node 直接运行：
 *
 *     node scripts/release-hygiene.ts [--tree <根>] [--golden-dir <目录>] [--site-list <文件>]
 *
 * 有命中退出码 1，参数或配置错误退出码 2。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ScanOptions { siteListPath?: string | undefined }

export type RuleId = 'private-ip' | 'win-user-path' | 'win-personal-dir' | 'posix-home' | 'unc-share' | 'golden-abs-path'
  | 'sk-key' | 'github-token' | 'aws-key' | 'private-key-block' | 'quoted-secret'
  | 'dev-owner-title' | 'dev-dated-speaker' | 'dev-quoted-speech' | 'dev-agent-role' | 'dev-colloquial' | 'dev-pejorative'
  | 'dev-qinkou' | 'dev-bang3'

export interface Rule {
  id: RuleId
  why: string
  rx: RegExp
  /** `decoded`：只用于解码后的文本（JSON 取值与键、`.md`、`.txt`）；`golden`：只用于金样层。 */
  layer?: 'decoded' | 'golden'
  /** 命中只回显前 4 位与长度。 */
  secret?: boolean
  accept?: (m: RegExpMatchArray, s: string) => boolean
}

/** `where`：行号或 JSON 指针（对象键另标 `(key)`）；文件路径本身命中时为空串。 */
export interface Finding { file: string; where: string; rule: string; excerpt: string }

export interface SiteEntry { line: number; rx: RegExp }

const PLACEHOLDER_NAME = /^(?:user|username|name|you|me|example|test|runner|runneradmin|public|default|all users|<.*>|%.*%|\$.*|\{.*\}|\.\.\.|…)$/i
const PLACEHOLDER_SECRET = /^(?:<.*>|\$.*|%.*%|\{.*\}|x+|\*+|your[_-].*|.*[_-]here|example.*|test.*|dummy.*|fake.*|placeholder.*)$/i
const SYSTEM_DIR = /^(?:program files(?: \(x86\))?|programdata|windows|users)$/i

const placeholderName = (m: RegExpMatchArray): boolean => PLACEHOLDER_NAME.test(m[1] ?? '')

export const RULES: readonly Rule[] = [
  {
    id: 'private-ip',
    why: '私有网段（含 CGNAT）里的具体主机地址；讲网段本身的记法（末段为 0 且紧跟 /nn）放行',
    rx: /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?!\d)/g,
    // 逐个匹配地判，不按整行放行：按整行时 `wss://10.x` 里的 `//10` 会被当成 `/nn`。
    accept: (m, s) => m[0].endsWith('.0') && /^\/\d{1,2}\b/.test(s.slice((m.index ?? 0) + m[0].length)),
  },
  {
    id: 'win-user-path',
    why: 'Windows 用户目录路径（正反斜杠与转义层都算）',
    rx: /\b[A-Za-z]:[\\/]{1,4}(?:Users|Documents and Settings)[\\/]{1,4}([^\\/\s"'`<>:*?|]+)/gi,
    accept: placeholderName,
  },
  {
    id: 'win-personal-dir',
    why: '盘符根下某人的桌面、文档、下载、AppData 或 OneDrive 目录',
    rx: /\b[A-Za-z]:[\\/]{1,4}([^\\/\s"'`<>:*?|]+)[\\/]{1,4}(?:Desktop|Documents|Downloads|AppData|OneDrive)\b/gi,
    accept: (m) => placeholderName(m) || SYSTEM_DIR.test(m[1] ?? ''),
  },
  {
    id: 'posix-home',
    why: 'POSIX 用户目录路径',
    rx: /(?<![\w.:])\/(?:home|Users)\/([A-Za-z0-9_.-]+)(?=[/\s"'`)\]]|$)/g,
    accept: placeholderName,
  },
  {
    id: 'unc-share',
    why: '网络共享路径；源码里的转义写法会误报，所以只用于解码后的文本',
    rx: /(?<![\\\w:])\\{2,4}([A-Za-z0-9_.-]+)\\{1,2}([A-Za-z0-9_.$-]+)/g,
    layer: 'decoded',
  },
  {
    id: 'golden-abs-path',
    why: '金样里的任何盘符绝对路径：重导会把导出机上的路径带进来',
    rx: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]{1,4}[^\s"'`<>|*?\u3001\uff0c\u3002\uff1b\uff1a\uff08\uff09\u300c\u300d]*/g,
    layer: 'golden',
  },
  {
    // 三道限制：占位符（连续 8 个 x）不算；真 key 是高熵串，一定含数字；连字符分隔的小写词是标识符。
    // 开头的后视是本仓加的，免得 `task-…` 一类标识符里的 `sk-` 被当成 key。
    id: 'sk-key',
    why: '疑似明文 API key',
    rx: /(?<![A-Za-z0-9_-])sk-(?!.*x{8})(?=[A-Za-z0-9_-]*\d)(?![a-z]+-[a-z]+-[a-z])[A-Za-z0-9_-]{20,}/g,
    secret: true,
  },
  {
    id: 'github-token',
    why: 'GitHub token',
    rx: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{40,}/g,
    secret: true,
  },
  { id: 'aws-key', why: 'AWS access key', rx: /\bAKIA[0-9A-Z]{16}\b/g, secret: true },
  {
    id: 'private-key-block',
    why: '私钥块',
    rx: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    secret: true,
  },
  {
    id: 'quoted-secret',
    why: '带引号的密钥赋值；占位值放行',
    rx: /\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    secret: true,
    accept: (m) => PLACEHOLDER_SECRET.test(m[1] ?? ''),
  },
  { id: 'dev-owner-title', why: '指向具体个人的称呼', rx: /\u4eea\u5668\u4e3b\u4eba/g },
  {
    id: 'dev-dated-speaker',
    why: '带日期的发言归属',
    rx: /(?:\u64cd\u4f5c\u5458|\u7528\u6237)\s*\d{2,4}-\d{2}(?:-\d{2})?\s*[:\uff1a]/g,
  },
  { id: 'dev-quoted-speech', why: '转述某一次具体发言', rx: /(?:\u7528\u6237|\u4ed6)\s*[:\uff1a]\s*[\u300c"]/g },
  { id: 'dev-agent-role', why: '开发 agent 的内部角色名', rx: /team\x2dlead|skill\x2dporter|vision\x2dporter/g },
  {
    id: 'dev-colloquial',
    why: '口语引语的特征词',
    rx: /\u5e72\u5565\u5462|\u5fc3\u91cc\u6ca1\u6570|\u4f7f\u52b2\u627e|\u641e\u4e24\u4e0b|\u54c8\u54c8|\u5475\u5475/g,
  },
  { id: 'dev-pejorative', why: '以残障或疾病作贬义比喻', rx: /\u6b8b\u5e9f|\u5f31\u667a|\u8111\u6b8b|\u767d\u75f4/g },
  { id: 'dev-qinkou', why: '强调某句话出自某个人', rx: /\u4eb2\u53e3/g },
  { id: 'dev-bang3', why: '感叹号堆叠', rx: /[!\uff01]{3,}/g },
]

/**
 * 合成路径登记簿：导出器**自己合成**的夹具路径。比较时取匹配处起的一段文本规范化（转小写，
 * 连续的 `\` `/` 并成一个 `/`，UNC 保留开头的 `//`），以 `prefix` 开头即放行。取的是「匹配处起」
 * 而不是匹配串：posix-home 的匹配不含末尾的 `/`，拿匹配串比对前缀永远对不上。
 *
 * 往这里加项只有一个理由：它是某个导出器合成的夹具（写明文件与行）。重导带来的新路径不是夹具，
 * 是泄漏，走公开文本覆盖层改写。过期项会让契约测试变红。
 */
export const SYNTHETIC_ROOTS: readonly { rules: readonly RuleId[]; prefix: string; reason: string }[] = [
  { rules: ['golden-abs-path'], prefix: 'd:/data/', reason: '合成夹具：tools/spec-export/export_claim_audit.py:47-73（claim_audit 金样）' },
  { rules: ['golden-abs-path'], prefix: 'c:/nanonis/', reason: '合成夹具：tools/spec-export/export_skill_traces.py:721-723（skill_traces 金样）' },
  { rules: ['unc-share'], prefix: '//rig-pc/share', reason: '合成夹具：tools/spec-export/export_claim_audit.py:61（网络共享路径用例）' },
  // 拼出来写：写成字面量，本文件这一行会被 posix-home 拦下、再被这一条放行，「被用到」就成了自己用自己。
  { rules: ['posix-home'], prefix: ['', 'home', 'rig', ''].join('/'), reason: '合成夹具：tools/spec-export/export_claim_audit.py:62（POSIX 路径用例）' },
]

/**
 * 分发包里确认是第三方内联文本的命中，按（文件、完整匹配文本）登记，理由写「第三方：<包名>」。
 * 不要为了转绿放宽规则。
 */
export const DISTRIBUTION_EXEMPTIONS: readonly { file: string; text: string; reason: string }[] = []

const BINARY_EXT = new Set(['.png', '.npy', '.onnx', '.sxm', '.3ds', '.bin', '.f32', '.ico', '.jpg', '.gif', '.woff', '.woff2', '.zst'])

function normalizeRoot(s: string): string {
  const lower = s.toLowerCase()
  const collapsed = lower.replace(/[\\/]+/g, '/')
  return /^[\\/]{2}/.test(lower) ? `/${collapsed}` : collapsed
}

function syntheticRoot(rule: RuleId, s: string, at: number): number {
  const head = normalizeRoot(s.slice(at, at + 256))
  return SYNTHETIC_ROOTS.findIndex((r) => r.rules.includes(rule) && head.startsWith(r.prefix))
}

/** 通用规则；`used` 收集放行过匹配的 `SYNTHETIC_ROOTS` 下标。 */
export function scanString(
  s: string, ctx: { decoded: boolean; golden: boolean }, used?: Set<number>,
): { rule: RuleId; text: string }[] {
  const out: { rule: RuleId; text: string }[] = []
  for (const rule of RULES) {
    if (rule.layer === 'decoded' && !ctx.decoded) continue
    if (rule.layer === 'golden' && !ctx.golden) continue
    for (const m of s.matchAll(rule.rx)) {
      if (rule.accept?.(m, s) === true) continue
      const root = syntheticRoot(rule.id, s, m.index)
      if (root !== -1) {
        used?.add(root)
        continue
      }
      out.push({ rule: rule.id, text: m[0] })
    }
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 读站点名单。配置错了要大声失败，而不是悄悄退回「没有名单」：读不了、没有条目、条目太宽都抛错。
 * 报错只给行号，不回显条目。
 */
export function loadSiteList(path: string): SiteEntry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`站点名单读不了：${path}`)
  }
  const entries: SiteEntry[] = []
  for (const [i, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let rx: RegExp
    if (line.startsWith('re:')) {
      try {
        rx = new RegExp(line.slice(3), 'i')
      } catch {
        throw new Error(`站点名单第 ${i + 1} 行：正则写错了`)
      }
    } else {
      if ([...line].length < 4) throw new Error(`站点名单第 ${i + 1} 行：普通条目短于 4 个字符，太宽；改写成带边界的 re: 条目`)
      rx = new RegExp(escapeRegExp(line), 'i')
    }
    if (rx.test('')) throw new Error(`站点名单第 ${i + 1} 行：能匹配空串，太宽`)
    entries.push({ line: i + 1, rx })
  }
  if (entries.length === 0) throw new Error(`站点名单里没有任何条目：${path}`)
  return entries
}

const siteCache = new Map<string, readonly SiteEntry[]>()

function siteEntries(opts: ScanOptions): readonly SiteEntry[] {
  const path = opts.siteListPath
  if (path === undefined || path === '') return []
  let entries = siteCache.get(path)
  if (entries === undefined) {
    entries = loadSiteList(path)
    siteCache.set(path, entries)
  }
  return entries
}

/**
 * 整段是 base64 的字符串值：至少 256 个字符、长度是 4 的倍数、只含 base64 字母表（末尾可有 `=`）。
 * 金样用它装导出器合成的 `.sxm`、`.dat`、`.npy` 字节，共几百段、约两千万字符；4–6 个字母数字的
 * 名单词在这么多字符里按概率就会出现，扫出来的只能是巧合（起草名单时实测有过）。所以这类值不按
 * 名单扫；通用规则照扫。载荷不解码：它们是合成的，不含站点文本。将来若有导出器收进真实文件，
 * 要另加解码扫描。
 */
function isBase64Payload(s: string): boolean {
  return s.length >= 256 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

interface Layer { decoded: boolean; golden: boolean }

const SECRET_RULES = new Set(RULES.filter((r) => r.secret === true).map((r) => r.id))

function excerpt(rule: RuleId, text: string): string {
  if (SECRET_RULES.has(rule)) return `${text.slice(0, 4)}…（${text.length} 字符）`
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

interface Sink {
  site: readonly SiteEntry[]
  used: Set<number> | undefined
  out: Finding[]
  exempt?: (text: string) => boolean
}

function scanUnit(file: string, where: string, s: string, layer: Layer, sink: Sink, jsonValue = false): void {
  for (const hit of scanString(s, layer, sink.used)) {
    if (sink.exempt?.(hit.text) === true) continue
    sink.out.push({ file, where, rule: hit.rule, excerpt: excerpt(hit.rule, hit.text) })
  }
  if (sink.site.length === 0 || (jsonValue && isBase64Payload(s))) return
  sink.site.forEach((entry, k) => {
    if (entry.rx.test(s)) sink.out.push({ file, where, rule: `site#${k + 1}`, excerpt: '' })
  })
}

function pointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

/** `.json` 解析成功则扫每个键和字符串值（已解码）；否则与其余文件一样逐行扫。 */
function scanText(file: string, text: string, golden: boolean, sink: Sink): void {
  const ext = extname(file).toLowerCase()
  if (ext === '.json') {
    let parsed: unknown
    let ok = true
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      ok = false
    }
    if (ok) {
      const layer = { decoded: true, golden }
      const walk = (v: unknown, ptr: string): void => {
        if (typeof v === 'string') scanUnit(file, ptr, v, layer, sink, true)
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${ptr}/${i}`))
        else if (v !== null && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            const p = `${ptr}/${pointerToken(k)}`
            scanUnit(file, `${p} (key)`, k, layer, sink)
            walk(x, p)
          }
        }
      }
      walk(parsed, '')
      return
    }
  }
  const layer = { decoded: ext === '.md' || ext === '.txt', golden }
  text.split('\n').forEach((line, i) => scanUnit(file, String(i + 1), line.replace(/\r$/, ''), layer, sink))
}

function isBinary(file: string, bytes: Uint8Array): boolean {
  return BINARY_EXT.has(extname(file).toLowerCase()) || bytes.includes(0)
}

const decoder = new TextDecoder('utf-8')

/** 一个文件：路径本身按字符串扫；二进制跳过；`spec/golden/` 下的文件另加金样层。 */
export function scanContent(rel: string, bytes: Uint8Array, opts: ScanOptions, used?: Set<number>): Finding[] {
  const sink: Sink = { site: siteEntries(opts), used, out: [] }
  scanUnit(rel, '', rel, { decoded: false, golden: false }, sink)
  if (!isBinary(rel, bytes)) scanText(rel, decoder.decode(bytes), rel.startsWith('spec/golden/'), sink)
  return sink.out
}

/**
 * 经运行器重导的 `manifest.json`（带 `reference`）必须带覆盖层 `apply` 写入的 `public_text` 标记，
 * 否则就是原始导出没过覆盖层。旧格式（没有 `reference`）不要求。
 */
export function manifestMarkProblem(manifest: unknown): string | undefined {
  if (manifest === null || typeof manifest !== 'object' || !('reference' in manifest)) return undefined
  const mark: unknown = (manifest as { public_text?: unknown }).public_text
  const overlay: unknown = mark !== null && typeof mark === 'object' ? (mark as { overlay?: unknown }).overlay : undefined
  if (typeof overlay === 'string' && /^[0-9a-f]{12}$/.test(overlay)) return undefined
  return '带 reference，却没有覆盖层写入的 public_text 标记'
}

function manifestFinding(file: string, bytes: Uint8Array): Finding[] {
  let manifest: unknown
  try {
    manifest = JSON.parse(decoder.decode(bytes))
  } catch {
    return []
  }
  const problem = manifestMarkProblem(manifest)
  return problem === undefined ? [] : [{ file, where: '/public_text', rule: 'manifest-public-text', excerpt: problem }]
}

/** `git ls-files` 加未跟踪、未忽略的文件：马上要 add 的新文件也得扫。 */
export function listRepoFiles(root: string): string[] {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return [...new Set(out.split('\0').filter((p) => p !== ''))]
}

function readIfFile(path: string): Uint8Array | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path) : undefined
  } catch {
    return undefined // 已删除未提交的文件仍在 ls-files 的输出里：跳过，不抛错。
  }
}

export function scanTree(
  root: string, opts: ScanOptions,
): { findings: Finding[]; scanned: number; goldenFiles: number; used: ReadonlySet<number> } {
  const used = new Set<number>()
  const findings: Finding[] = []
  let scanned = 0
  let goldenFiles = 0
  for (const rel of listRepoFiles(root)) {
    const bytes = readIfFile(join(root, rel))
    if (bytes === undefined) continue
    findings.push(...scanContent(rel, bytes, opts, used))
    if (isBinary(rel, bytes)) continue
    scanned += 1
    if (rel.startsWith('spec/golden/')) goldenFiles += 1
    if (rel === 'spec/golden/manifest.json') findings.push(...manifestFinding(rel, bytes))
  }
  return { findings, scanned, goldenFiles, used }
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).replaceAll('\\', '/'))
    .sort()
}

/** 把目录里每个文件都当金样层扫：覆盖层 `apply` 的产物在复制进 `spec/golden` 之前用它。 */
export function scanGoldenDir(dir: string, opts: ScanOptions): { findings: Finding[]; scanned: number } {
  const sink: Sink = { site: siteEntries(opts), used: undefined, out: [] }
  let scanned = 0
  for (const rel of walkFiles(dir)) {
    const bytes = readFileSync(join(dir, rel))
    scanUnit(rel, '', rel, { decoded: false, golden: false }, sink)
    if (isBinary(rel, bytes)) continue
    scanned += 1
    scanText(rel, decoder.decode(bytes), true, sink)
    if (rel === 'manifest.json') sink.out.push(...manifestFinding(rel, bytes))
  }
  return { findings: sink.out, scanned }
}

/** 暂存分发包：文件集合必须恰好是 `expected`，每个文件过同一套规则（含名单）。 */
export function scanStagedDistribution(dir: string, expected: readonly string[], opts: ScanOptions): Finding[] {
  const present = walkFiles(dir)
  const site = siteEntries(opts)
  const findings: Finding[] = []
  for (const rel of present) {
    if (!expected.includes(rel)) findings.push({ file: rel, where: '', rule: 'unexpected-file', excerpt: '' })
  }
  for (const rel of expected) {
    if (!present.includes(rel)) {
      findings.push({ file: rel, where: '', rule: 'missing-file', excerpt: '' })
      continue
    }
    const exempt = (text: string): boolean => DISTRIBUTION_EXEMPTIONS.some((e) => e.file === rel && e.text === text)
    const sink: Sink = { site, used: undefined, out: findings, exempt }
    scanUnit(rel, '', rel, { decoded: false, golden: false }, sink)
    scanText(rel, decoder.decode(readFileSync(join(dir, rel))), false, sink)
  }
  return findings
}

export function formatFinding(f: Finding): string {
  const at = f.where === '' ? '' : /^\d+$/.test(f.where) ? `:${f.where}` : `#${f.where}`
  return `${f.file}${at} [${f.rule}]${f.excerpt === '' ? '' : ` ${f.excerpt}`}`
}

const USAGE = '用法：node scripts/release-hygiene.ts [--tree <根>] [--golden-dir <目录>] [--site-list <文件>]'

function main(argv: readonly string[]): number {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === undefined || !['--tree', '--golden-dir', '--site-list'].includes(flag) || value === undefined) {
      console.error(USAGE)
      return 2
    }
    args.set(flag, value)
  }
  const siteListPath = args.get('--site-list') ?? process.env['HYGIENE_SITE_LIST']
  if (siteListPath === undefined || siteListPath === '') console.info('没有配置站点名单（HYGIENE_SITE_LIST）：只跑通用规则。')
  const opts: ScanOptions = { siteListPath }
  const goldenDir = args.get('--golden-dir')
  let findings: Finding[]
  let summary: string
  if (goldenDir !== undefined) {
    const result = scanGoldenDir(resolve(goldenDir), opts)
    findings = result.findings
    summary = `scanned=${result.scanned} goldenFiles=${result.scanned} findings=${findings.length}`
  } else {
    const root = resolve(args.get('--tree') ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
    const result = scanTree(root, opts)
    findings = result.findings
    summary = `scanned=${result.scanned} goldenFiles=${result.goldenFiles} findings=${findings.length}`
  }
  for (const f of findings) console.log(formatFinding(f))
  console.log(summary)
  return findings.length === 0 ? 0 : 1
}

const invoked = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
