/**
 * 闸门绕行守卫：验收组合必须把 shell / 后台 job / workflow / 子 agent 这几族工具行关掉。
 *
 * PTC 的 Node 程序和 shell 工具能直接连仪器的 TCP 端口，不经「一动一观」闸门；dsh 的沙箱只管文件。
 * 所以守得住的地方只有组合层。这里不靠记性：拿 overlay 清单对着**入仓的 headless 组合快照**
 * （spec/dsh/dump-config.headless.<版本>.yml，随每次升级重导）核对——上游哪天新增一个默认启用的
 * `tool-*` 行，或者删掉我们还在引用的行（那只会在 stderr 留一句 `patch: entry … not found`，退出码仍是 0），
 * 这里先红。
 *
 * `COMBINATIONS` 是登记点：将来的 IC / conduct 组合落地时，在这里登记它关掉的行，否则没有人检查它有没有关掉这几族工具。
 *
 * web 路线的 `profiles/mast-sim` 故意不在受守之列：它用 web 组合的 standard preset，自带 shell、jobs、子 agent 等工具
 * （dsh 0.2 起工具行挂在 preset 的嵌套插件里，顶层的 `disabled` 关不到它们）。它只连模拟器，这些工具暂时留着；
 * 接真机（Phase 8）之前必须先在它的 preset 里关掉，并登记到 `COMBINATIONS`。
 *
 * 这条守卫按行名认工具，「每个默认启用的 `tool-*` 行都关掉」看不到下面这些，所以单独处理：
 * - Web preset 里另有几行同样能绕过闸门：`persistent-shell`（minimal preset 的持久 bash / pwsh，行名不带 `tool-`）、
 *   `tool-plugin-manager` 与 `tool-plugin-market`（运行时装插件）、`tool-schedule`（持久提醒，事后唤醒 agent）。
 *   它们在 headless 组合里应当不存在或是关着的，下面断言这一点；哪天出现并启用，先红。
 * - `workflow-ptc` 与 `ptc-runtime` 在 headless 里是启用的，但本身不注册工具：前者只经 `tool-workflow` 用到（已关），
 *   后者只在 PTC 模式下经 `run_code` 用到，而验收组合固定原生函数调用（下面断言 `DSH_TOOLS_MODE`）。
 * - `mcp-resources` 只在配置了 MCP 服务器时才有工具；两份组合快照里都没有 MCP 客户端行，验收 overlay 也不加。
 * - 按行读快照只认顶层行，所以快照里出现嵌套的 `- id:` 行也算红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACCEPTANCE_CHILD_ENV, ACCEPTANCE_DISABLED_ROWS, GATE_BYPASS_ROWS, acceptanceOverlayRows } from '../../../../scripts/acceptance-overlay.ts'
import { DSH_VERSION } from '../../../../scripts/dsh-pins.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const snapshotText = readFileSync(join(repoRoot, `spec/dsh/dump-config.headless.${DSH_VERSION}.yml`), 'utf8')

interface Row {
  readonly id: string
  /** `true`、`!!js …` 之类的原文；没写 disabled 就是 undefined。 */
  readonly disabled: string | undefined
}

/** 快照是 `dsh --dump-config` 的输出：顶层行以 `- id:` 开头，`disabled:` 缩进两格。不引 YAML 库，按行读。 */
function topLevelRows(text: string): Row[] {
  const rows: { id: string; disabled: string | undefined }[] = []
  for (const line of text.split('\n')) {
    const id = /^- id: (.+)$/.exec(line)?.[1]
    if (id !== undefined) rows.push({ id, disabled: undefined })
    const disabled = /^ {2}disabled: (.+)$/.exec(line)?.[1]
    if (disabled !== undefined && rows.length > 0) rows[rows.length - 1]!.disabled = disabled
  }
  return rows
}

const headless = topLevelRows(snapshotText)

/** 受守的组合：名字与它关掉的行 id。 */
const COMBINATIONS: readonly { name: string; disabledRows: readonly string[] }[] = [
  { name: 'M4 与 Nanonis 验收 overlay（model-minimal.ts / native-session.ts 共用）', disabledRows: ACCEPTANCE_DISABLED_ROWS },
]

/** 只在 Web preset 里挂着、同样能绕过闸门的行（见文件头）。 */
const WEB_PRESET_BYPASS_ROWS = ['persistent-shell', 'tool-plugin-manager', 'tool-plugin-market', 'tool-schedule'] as const

describe('闸门绕行：验收组合关掉能绕过闸门的工具族', () => {
  it('快照读到了东西，而且全是顶层行（有嵌套的行，按行读就会漏看）', () => {
    expect(headless.length).toBeGreaterThan(50)
    expect(headless.some((row) => row.id === 'tool-fs')).toBe(true)
    expect(snapshotText.split('\n').filter((line) => /^\s+- id: /.test(line))).toEqual([])
  })

  for (const combo of COMBINATIONS) {
    describe(combo.name, () => {
      for (const [family, ids] of Object.entries(GATE_BYPASS_ROWS)) {
        it(`族「${family}」的行全部关掉：${ids.join(', ')}`, () => {
          expect(ids.filter((id) => !combo.disabledRows.includes(id))).toEqual([])
        })
      }

      it('组合里每个默认启用的 tool-* 行都被关掉（条件启用的 !!js 也算启用）', () => {
        const enabled = headless.filter((row) => row.id.startsWith('tool-') && row.disabled !== 'true').map((row) => row.id)
        expect(enabled.length).toBeGreaterThan(10)
        expect(enabled.filter((id) => !combo.disabledRows.includes(id))).toEqual([])
      })

      it('要关的每一行都真的在这一版的组合里（引用已删除的行只会在 stderr 留一句告警）', () => {
        const known = new Set(headless.map((row) => row.id))
        expect(combo.disabledRows.filter((id) => !known.has(id))).toEqual([])
      })
    })
  }

  it('Web preset 里另几行能绕过闸门的，在 headless 组合里不存在或是关着的', () => {
    const byId = new Map(headless.map((row) => [row.id, row]))
    expect(WEB_PRESET_BYPASS_ROWS.filter((id) => byId.has(id) && byId.get(id)!.disabled !== 'true')).toEqual([])
  })

  it('工具只走原生函数调用，不开 PTC', () => {
    expect(ACCEPTANCE_CHILD_ENV.DSH_TOOLS_MODE).toBe('native')
  })

  it('OTel 遥测那一行被启动器硬关；会话日志上传由 overlay 单独关（DSH_TELEMETRY_DISABLED 管不到它）', () => {
    expect(ACCEPTANCE_CHILD_ENV.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(acceptanceOverlayRows()).toContain('- id: session-log-deepseek\n  config:\n    enabled: false')
  })

  it('两份验收脚本都用共用清单，没有各抄一份', () => {
    for (const script of ['scripts/model-minimal.ts', 'scripts/native-session.ts']) {
      const text = readFileSync(join(repoRoot, script), 'utf8')
      expect(text, script).toContain("from './acceptance-overlay.ts'")
      expect(text, script).toContain('...acceptanceOverlayRows()')
      expect(text, script).toContain('...ACCEPTANCE_CHILD_ENV')
    }
  })
})
