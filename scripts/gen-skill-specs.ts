/**
 * 从 `spec/golden/skills.json` 生成批 1/2 的 `SkillSpec` 常量。
 *
 *     node scripts/gen-skill-specs.ts            # 写文件
 *     node scripts/gen-skill-specs.ts --check    # 只比对，有 diff 就非零退出
 *
 * **为什么生成而不是手抄**：这 73 个技能一共 200 多个参数声明，每个带 unit /
 * min / max / allowed_values / default / 一整段中文描述。手抄一遍的唯一产物是
 * 一批转录错误，而 DoD ① 要的「spec 与金样 deep-equal」会因此从判据退化成
 * 「我抄对了吗」的自测。
 *
 * 代价要说清：**DoD ① 因此是结构性成立的，不是测出来的**。
 * 真正的判据落在别处——DoD ② 的模型面文案（`parametersFromSpec` 对
 * `tool_schemas.json`）与 DoD ③ 的行为轨迹（`skill_traces.json`），
 * 那两样都是**独立导出的**，抄错 spec 会在那里被抓住。
 *
 * 名字里的 `generated/` 与 nanonis 门面同一套办法：生成物入仓（读代码的人要看得见
 * 声明），一条测试保证它没漂。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const SKILLS = fileURLToPath(new URL('spec/golden/skills.json', root))
const TRACES = fileURLToPath(new URL('spec/golden/skill_traces.json', root))
const OUT = fileURLToPath(new URL('packages/host/stm-skills/src/generated/specs.ts', root))

/** 批 1/2 的成员表。与导出脚本 `export_skill_traces.py` 里那两张表一致。 */
const BATCH_1 = [
  'GetBias', 'GetCurrent', 'GetBiasCalibration', 'GetSetpoint', 'GetZPosition',
  'GetZControllerState', 'GetZCtrlGain', 'GetZCtrlList', 'GetTipLift',
  'GetZLimitsEnabled', 'GetHomeProps', 'GetWithdrawRate', 'GetScanFrame',
  'GetScanSpeed', 'GetScanBuffer', 'GetScanXYPosition', 'GetTipSpeed',
  'GetPointShootOnOff', 'GetPiezoTilt', 'GetDriftCompensation',
  'GetPiezoSensitivity', 'GetPiezoXYZLimits', 'GetMotorFreqAmp', 'MotorGetPos',
  'GetMotorStepCounter', 'GetAutoApproachStatus', 'GetSafeTipStatus',
  'GetSafeTipProps', 'GetSafeTipSignal', 'GetSignalValues', 'ListSignalChannels',
  'GetSignalRange', 'GetSessionPath', 'GetAcqPeriod', 'GetRTFreq',
  'GetLatestScanFile',
]

const BATCH_2 = [
  'SetBias', 'SetSetpoint', 'ZControllerOnOff', 'TryEngageController',
  'WithdrawTip', 'SafeRetract', 'EmergencyRetract', 'StopScan',
  'StopAutoApproach', 'StopMotor', 'StopFolMe', 'SetZCtrlGain', 'SetTipLift',
  'SetZPosition', 'SetBiasRange', 'SetSessionPath', 'SetScanBuffer',
  'SetTipSpeed', 'SetFolMeOversampling', 'MoveToXY', 'SetPiezoTilt',
  'SetDriftCompensation', 'SetPiezoRange', 'SetHomeProps', 'SetSwitchOffDelay',
  'SetCurrentGain',
  'MotorMove', 'MotorMoveClosedLoop', 'EnableSafeTip', 'SetZLimitsEnabled',
  'SetBiasCalibration', 'SetCurrentCalibration', 'SetMotorFreqAmp',
  'LockNanonisUI', 'CreateZCtrlPreset',
  'AutoApproach', 'ApproachTip',
]

/**
 * 批 3b：装在 GraphExecutor 上的另一半验收。
 *
 * `WaitScanComplete` 验的是**流式**动态计划（步数事先不知道），`SetBiasRamp` 验的是
 * **先算后排**那一种——第 0 步先读当前偏压，读到了才排得出后面那串步骤。
 */
const BATCH_3B = ['SetBiasRamp']

/** 批 3a：扫描主链（PLAN §8.4 批 3 的头六个）。 */
const BATCH_3A = [
  'ConfigureScan', 'SetScanSpeed', 'StartScan', 'WaitScanComplete',
  'SaveScan', 'GrabScanFrameData',
]

interface GoldenParam {
  name: string
  type: string
  description?: string | null
  unit?: string | null
  required?: boolean | null
  min_value?: number | null
  max_value?: number | null
  allowed_values?: (string | number | boolean)[] | null
  default?: unknown
}
interface GoldenSkill {
  name: string
  description: string
  parameters?: GoldenParam[] | null
  preconditions?: string[] | null
  capabilities?: string[] | null
  tags?: string[] | null
  category?: string
  safety_level?: string
  module?: string
}

const q = (v: unknown): string => JSON.stringify(v)

/** 一个参数声明 → TS 字面量。**只写非空字段**，好让 diff 读得动。 */
function paramLiteral(p: GoldenParam): string {
  const parts = [`name: ${q(p.name)}`, `type: ${q(p.type)}`]
  if (p.description != null && p.description !== '') parts.push(`description: ${q(p.description)}`)
  if (p.unit != null && p.unit !== '') parts.push(`unit: ${q(p.unit)}`)
  parts.push(`required: ${p.required === true}`)
  if (p.min_value != null) parts.push(`minValue: ${p.min_value}`)
  if (p.max_value != null) parts.push(`maxValue: ${p.max_value}`)
  if (p.allowed_values != null && p.allowed_values.length > 0) {
    parts.push(`allowedValues: ${q(p.allowed_values)}`)
  }
  if (p.default !== undefined && p.default !== null) parts.push(`default: ${q(p.default)}`)
  return `{ ${parts.join(', ')} }`
}

function specLiteral(s: GoldenSkill): string {
  const parts = [`  name: ${q(s.name)}`, `  description: ${q(s.description)}`]
  const ps = s.parameters ?? []
  parts.push(
    ps.length === 0
      ? '  parameters: []'
      : `  parameters: [\n${ps.map((p) => `    ${paramLiteral(p)},`).join('\n')}\n  ]`,
  )
  if ((s.preconditions ?? []).length > 0) parts.push(`  preconditions: ${q(s.preconditions)}`)
  if ((s.capabilities ?? []).length > 0) parts.push(`  capabilities: ${q(s.capabilities)}`)
  if ((s.tags ?? []).length > 0) parts.push(`  tags: ${q(s.tags)}`)
  if (s.category != null) parts.push(`  category: ${q(s.category)}`)
  if (s.safety_level != null) parts.push(`  safetyLevel: ${q(s.safety_level.toUpperCase())}`)
  return `{\n${parts.join(',\n')},\n}`
}

function main(): number {
  const raw = JSON.parse(readFileSync(SKILLS, 'utf8')) as Record<string, GoldenSkill> | GoldenSkill[]
  const all = Array.isArray(raw) ? raw : Object.values(raw)
  const byName = new Map(all.map((s) => [s.name, s]))
  const traced = new Set(Object.keys(JSON.parse(readFileSync(TRACES, 'utf8')) as object))

  const names = [...BATCH_1, ...BATCH_2, ...BATCH_3A, ...BATCH_3B]
  const missing = names.filter((n) => !byName.has(n))
  const found = names.filter((n) => byName.has(n))

  const body = found
    .map((n) => `export const ${n}Spec: SkillSpec = ${specLiteral(byName.get(n)!)}\n`)
    .join('\n')

  const text =
    `// 由 \`node scripts/gen-skill-specs.ts\` 生成，**不要手改**。\n` +
    `// 源：spec/golden/skills.json（旧仓 SkillRegistry.discover() + _get_metadata_raw）\n` +
    `//\n` +
    `// 批 1 只读 L0 ${BATCH_1.filter((n) => byName.has(n)).length} 个 · ` +
    `批 2 写/硬闸/DANGEROUS/L1 ${BATCH_2.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3a 扫描主链 ${BATCH_3A.filter((n) => byName.has(n)).length} 个 · ` +
    `批 3b 组合 ${BATCH_3B.filter((n) => byName.has(n)).length} 个\n` +
    (missing.length > 0
      ? `// 计划稿点名但当前旧仓**没有**的：${missing.join('、')}\n`
      : '') +
    `import type { SkillSpec } from 'dsh-spm-kernel'\n\n` +
    body +
    `\n/** 批 1/2 的全部声明，按名字索引。 */\n` +
    `export const BATCH_SPECS: Readonly<Record<string, SkillSpec>> = {\n` +
    found.map((n) => `  ${n}: ${n}Spec,`).join('\n') +
    `\n}\n\n` +
    `/** 有行为轨迹金样的那些（两个进针技能不在内，见导出脚本的 TRACE_SKIP）。 */\n` +
    `export const TRACED = ${q(found.filter((n) => traced.has(n)))} as const\n`

  const check = process.argv.includes('--check')
  const current = ((): string | null => {
    try {
      return readFileSync(OUT, 'utf8')
    } catch {
      return null
    }
  })()

  if (check) {
    if (current === text) {
      console.log(`✓ generated/specs.ts 与金样同步（${found.length} 个技能）`)
      return 0
    }
    console.error('✗ generated/specs.ts 与金样不同步。跑 `node scripts/gen-skill-specs.ts`。')
    return 1
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, text, { encoding: 'utf8' })
  console.log(`✓ 生成 ${found.length} 个 SkillSpec（缺 ${missing.length}：${missing.join('、') || '无'}）`)
  return 0
}

process.exit(main())
