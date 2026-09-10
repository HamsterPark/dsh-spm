/**
 * 把 agent **说**它做了什么，和记录里**显示**它做了什么，对一遍。
 *
 * 它只报**能从本次运行自己的记录里证明**的两件事：
 * 1. 文本里点名的文件，本次运行没产生、磁盘上也不存在；
 * 2. 记录显示**零次技能调用**的运行里，出现了「测量已完成」这类声明。
 *
 * 两条都刻意限制在可验证范围内：这里只检查本次运行的工件存在性与技能调用记录，
 * 不把示例或缺少记录本身声称为真实事件证据。
 */

/** 完成词。说的若是测量/观测，这些词表示「已经做了」。 */
const DONE_WORDS: readonly string[] = [
  'acquired', 'collected', 'measured', 'recorded', 'completed', 'finished',
  'performed', 'captured', 'obtained', 'scanned',
  '已完成', '已采集', '已测量', '已记录', '已扫描', '已获取', '采集完成',
  '测量完成', '扫描完成', '完成了',
]

/** 仪器工作词。声明必须**是关于仪器动作**的，不能是「总结写完了」。 */
const WORK_WORDS: readonly string[] = [
  'sts', 'spectr', 'spectrum', 'spectra', 'scan', 'image', 'topograph',
  'grid', 'curve', 'i-v', 'iv ', 'didv', 'di/dv', 'approach', 'pulse',
  '谱', '扫图', '扫描', '图像', '曲线', '进针', '脉冲', '测量',
]

/**
 * 带扩展名的**绝对**路径：Windows（`D:\a\b.txt`、`\\host\share\x.sxm`）与 POSIX（`/a/b.dat`）。
 * **裸文件名不匹配**——普通散文里的误命中太多。
 */
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|\/)[^\s"'<>|?*]{1,400}?\.[A-Za-z0-9]{1,8}/g

export interface ClaimAudit {
  /** 只有**能证明**有问题时才是 false。 */
  readonly ok: boolean
  readonly executed_skills: string[]
  readonly claimed_paths: string[]
  readonly fabricated_paths: string[]
  readonly unsupported_completion: boolean
  readonly problems: string[]
}

/** 给人看的一行；没什么可说时是空串。 */
export function claimNotice(a: ClaimAudit): string {
  return a.ok ? '' : '⚠️ 本次运行的记录与该消息不符：' + a.problems.join('；')
}

/**
 * Windows 的 `os.path.normcase(normpath(p))`，**写死不随平台**。
 *
 * Python 那边这一步是随平台变的（POSIX 上是恒等）。我们不能跟着运行平台走：
 * 路径本身是**仪器机的 Windows 路径**，这段代码在哪台机器上跑不改变这一点。
 * CI 在 Linux 上跑，跟平台走的话同一条金样会在两处给出两个答案。
 */
function normWin(p: string): string {
  const parts = p.replace(/\//g, '\\').split('\\')
  // UNC (`\\host\share\…`) 与盘符根都要保住前缀，`normpath` 不会把它们吃掉
  const leadingEmpties = parts.findIndex((s) => s !== '')
  const prefix = '\\'.repeat(leadingEmpties < 0 ? parts.length : leadingEmpties)
  const out: string[] = []
  for (const seg of parts.slice(leadingEmpties < 0 ? parts.length : leadingEmpties)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return (prefix + out.join('\\')).toLowerCase()
}

function samePath(a: string, b: string): boolean {
  return normWin(a) === normWin(b)
}

/** 文本里提到的绝对路径，去重、保序。 */
export function extractClaimedPaths(text: string): string[] {
  if (text === '') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(PATH_RE)) {
    // 尾随标点要剥——中英文都有（Python 的 rstrip 字符集逐字照抄）
    const p = m[0].replace(/[.,;:)\]}）】。，、]+$/u, '')
    const key = p.toLowerCase().replace(/\//g, '\\')
    if (!seen.has(key)) {
      seen.add(key)
      out.push(p)
    }
  }
  return out
}

/** 文本是不是在声称「仪器工作已经做了」。 */
export function claimsCompletedWork(text: string): boolean {
  if (text === '') return false
  const low = text.toLowerCase()
  return DONE_WORDS.some((w) => low.includes(w)) && WORK_WORDS.some((w) => low.includes(w))
}

export interface AuditOptions {
  /**
   * 记录说本次运行跑过的技能。
   *
   * **`[]` 和 `undefined` 不是一回事**：`[]` ＝ 记录说什么都没跑；
   * `undefined` ＝ 根本没有记录可比，那条「零技能」规则整个不适用。
   * 「不知道」不是「没发生」的证据。
   */
  readonly executedSkills?: readonly string[] | undefined
  /** 本次运行真的产出的文件。 */
  readonly artifacts?: readonly string[] | undefined
  /** 磁盘检查，可注入。**读不了的路径不算证据**。 */
  readonly pathExists?: ((p: string) => boolean) | undefined
}

/** 拿一条 agent 的声明和本次运行的记录对一遍。 */
export function auditClaim(text: string, opts: AuditOptions = {}): ClaimAudit {
  const skills = opts.executedSkills === undefined ? undefined : [...opts.executedSkills]
  const arts = [...(opts.artifacts ?? [])]
  const problems: string[] = []

  const claimed = extractClaimedPaths(text)
  const fabricated: string[] = []
  for (const p of claimed) {
    if (arts.some((q) => samePath(p, q))) continue
    try {
      if (opts.pathExists?.(p) === true) continue
    } catch {
      continue // 读不了的路径不是证据
    }
    fabricated.push(p)
  }
  if (fabricated.length > 0) {
    problems.push('消息里引用的文件本次运行没有产生、磁盘上也不存在：' + fabricated.join('、'))
  }

  const unsupported = skills !== undefined && skills.length === 0 && claimsCompletedWork(text)
  if (unsupported) {
    problems.push('消息声称已完成测量，但本次运行没有任何技能被调用')
  }

  return {
    ok: problems.length === 0,
    executed_skills: skills ?? [],
    claimed_paths: claimed,
    fabricated_paths: fabricated,
    unsupported_completion: unsupported,
    problems,
  }
}
