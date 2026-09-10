/**
 * 19 条金样，由旧仓真实的 `claim_audit.py` 产出。
 *
 * 金样导出时把 `path_exists` 钉成恒 false —— 判据不能取决于**这台机器上有什么文件**。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  auditClaim,
  claimNotice,
  claimsCompletedWork,
  extractClaimedPaths,
  type AuditOptions,
} from './claim-audit.js'

interface GoldenCase {
  readonly verdict: {
    ok: boolean
    executed_skills: string[]
    claimed_paths: string[]
    fabricated_paths: string[]
    unsupported_completion: boolean
    problems: string[]
  }
  readonly notice: string
  readonly claims_completed_work: boolean
  readonly extract_claimed_paths: string[]
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/claim_audit.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, GoldenCase>

const FORENSIC =
  '[HANDOFF → data_processing] 5-point STS grid acquired (40 nm spacing, ' +
  'bias -0.8 V, setpoint 100 pA). Per-point summary JSON: ' +
  'D:\\data\\claim-audit\\GridSTS_report.txt'

/** 与导出脚本 CASES 一一对应。 */
const CASES: Record<string, [string, AuditOptions]> = {
  forensic_2026_07_27: [FORENSIC, { executedSkills: [] }],
  forensic_but_skill_ran: [FORENSIC, { executedSkills: ['GridSTS'] }],
  forensic_and_file_real: [
    FORENSIC,
    {
      executedSkills: ['GridSTS'],
      artifacts: ['D:\\data\\claim-audit\\GridSTS_report.txt'],
    },
  ],
  no_record_at_all: [FORENSIC, {}],
  windows_path: ['结果见 D:\\data\\scan_001.sxm', { executedSkills: [] }],
  unc_path: ['结果见 \\\\rig-pc\\share\\scan_001.sxm', { executedSkills: [] }],
  posix_path: ['结果见 /home/rig/data/scan_001.sxm', { executedSkills: [] }],
  bare_filename_not_matched: ['结果见 scan_001.sxm', { executedSkills: [] }],
  no_extension_not_matched: ['结果见 D:\\data\\scan_001', { executedSkills: [] }],
  trailing_punct_cn: ['结果见 D:\\data\\scan_001.sxm。', { executedSkills: [] }],
  trailing_punct_paren: ['结果见（D:\\data\\scan_001.sxm）', { executedSkills: [] }],
  dedup_case_and_slash: [
    '见 D:\\Data\\A.sxm 和 d:/data/a.sxm 和 D:\\Data\\B.sxm',
    { executedSkills: [] },
  ],
  artifact_matches_via_normpath: [
    '见 D:\\data\\.\\sub\\..\\sub\\a.sxm',
    { executedSkills: ['X'], artifacts: ['D:\\data\\sub\\a.sxm'] },
  ],
  done_word_only: ['已完成，总结写好了', { executedSkills: [] }],
  work_word_only: ['接下来打算做 STS 谱', { executedSkills: [] }],
  both_words_en: ['STS spectra acquired', { executedSkills: [] }],
  both_words_cn: ['扫描完成', { executedSkills: [] }],
  both_words_but_skills_ran: ['扫描完成', { executedSkills: ['StartScan'] }],
  empty_text: ['', { executedSkills: [] }],
}

// 金样是在「磁盘上什么都没有」的前提下导的
const NO_DISK = { pathExists: (): boolean => false }

describe('claimAudit —— 19 条金样逐字对旧仓', () => {
  it('金样与用例表一一对应', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(golden).sort())
  })

  for (const name of Object.keys(golden)) {
    it(`${name}：判定与文案都相等`, () => {
      const [text, opts] = CASES[name]!
      const got = auditClaim(text, { ...opts, ...NO_DISK })
      expect(got).toEqual(golden[name]!.verdict)
      expect(claimNotice(got)).toBe(golden[name]!.notice)
      expect(claimsCompletedWork(text)).toBe(golden[name]!.claims_completed_work)
      expect(extractClaimedPaths(text)).toEqual(golden[name]!.extract_claimed_paths)
    })
  }
})

describe('两条规则各自的边界', () => {
  it('**`[]` 与 `undefined` 不是一回事**：没有记录时不下「零技能」的判', () => {
    // 「不知道跑没跑」不是「没跑」的证据。这条弄反了，审计就会在
    // 每一个没接记录的场合尖叫，然后被关掉。
    expect(auditClaim('扫描完成', { executedSkills: [], ...NO_DISK }).unsupported_completion).toBe(true)
    expect(auditClaim('扫描完成', NO_DISK).unsupported_completion).toBe(false)
  })

  it('文件真在磁盘上就不算捏造 —— 哪怕本次运行没产生它', () => {
    const t = '见 D:\\data\\a.sxm'
    expect(auditClaim(t, { pathExists: () => true }).fabricated_paths).toEqual([])
    expect(auditClaim(t, { pathExists: () => false }).fabricated_paths).toEqual(['D:\\data\\a.sxm'])
  })

  it('**读不了的路径不算证据** —— pathExists 抛出时按「不能证明」处理', () => {
    const t = '见 D:\\data\\a.sxm'
    const thrown = auditClaim(t, {
      pathExists: () => {
        throw new Error('EACCES')
      },
    })
    expect(thrown.fabricated_paths).toEqual([])
    expect(thrown.ok).toBe(true)
  })

  it('路径比较用 **Windows 语义**，不跟运行平台走', () => {
    // Python 那边 `os.path.normcase` 在 POSIX 上是恒等，于是同一条金样
    // 在 Windows 和 Linux 上会给两个答案。CI 在 Linux 上跑，所以写死。
    expect(
      auditClaim('见 D:/Data/A.SXM', { artifacts: ['d:\\data\\a.sxm'], ...NO_DISK }).fabricated_paths,
    ).toEqual([])
  })

  it('两条都不成立时 ok=true，notice 是空串', () => {
    const a = auditClaim('接下来打算扫一张图', { executedSkills: [], ...NO_DISK })
    expect(a.ok).toBe(true)
    expect(claimNotice(a)).toBe('')
  })
})
