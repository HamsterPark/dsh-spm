/**
 * `scripts/probe-compose.ts` 的判定函数。夹具取自 2026-10-26 在 dsh 0.2.1-rc.3 上的真实输出
 * （本地路径已去掉）：兼容闸的失败是**退出码 0 加 stderr 一行**，不是报错——所以每个失败夹具的
 * `status` 都是 0，判定函数必须仍然给出红。
 *
 * 判定函数不比较任何版本号，夹具里的版本串只是那份输出的一部分。产生这些输出的 `dsh-app-boot` 与 `dsh`
 * 包在 rc.3、rc.4、rc.5 之间逐文件相同（tarball 比对）；夹具没有重新抓取，rc.5 上的真实输出
 * 仍含 `skipping profile bundle` 与 `incompatible` 两个关键词。
 */
import { describe, expect, it } from 'vitest'
import { FORBIDDEN_STDERR, judgeCompose, judgeExemptions } from '../../../../scripts/probe-compose.ts'

const EXPECT = { bundle: 'dsh-spm', rowIds: ['mast-minimal-hello', 'mast-minimal-runtime'] } as const

const COMPOSED_WITH_US = [
  '# == @deepseek-ai/dsh-base',
  '- id: tools',
  "  name: '@deepseek-ai/dsh-tools'",
  '# == dsh-spm',
  '- id: mast-minimal-hello',
  '  name: dsh-spm',
  '- id: mast-minimal-runtime',
  '  name: dsh-spm/minimal',
  '',
].join('\n')

const COMPOSED_WITHOUT_US = ['# == @deepseek-ai/dsh-base', '- id: tools', "  name: '@deepseek-ai/dsh-tools'", ''].join('\n')

// 实测：被跳过的 bundle，stderr 一整行；组合树里没有 `# == dsh-spm` 段。
const SKIPPED =
  'dsh: skipping profile bundle "dsh-spm": Error: Plugin dsh-spm@0.0.1 is incompatible with dsh 0.2.1-rc.3: ' +
  'requirements {"@deepseek-ai/dsh-host-webserver":"0.2.1-rc.2","@deepseek-ai/dsh-system-prompt":"0.2.1-rc.2","@deepseek-ai/dsh-tools":"0.2.1-rc.2"}. ' +
  'Running it may cause crashes or data loss.\n'

// 实测：overlay 里还写着 0.2.1 已删除的行（路径部分以 <overlay> 代替）。
const PATCH_WARNING = 'dsh: [<overlay>] patch: entry "tool-ralph" not found\n'

// 按 dsh-app-boot 的 activationDiagnostic 格式构造（lib/index.js:4408-4419，真启动才会出现）。
const NOT_ACTIVATED = 'dsh: warning: 1 entry did not activate\nmast-minimal-runtime (dsh-spm/minimal): pending (waiting for service: tools)\n'

describe('兼容闸探针的判定', () => {
  it('三个关键字就是 dsh-app-boot 里那三条文本的稳定片段', () => {
    expect([...FORBIDDEN_STDERR]).toEqual(['did not activate', 'skipping profile bundle', 'incompatible'])
  })

  it('正常：退出 0、stderr 空、bundle 段与期望行都在', () => {
    expect(judgeCompose({ status: 0, stdout: COMPOSED_WITH_US, stderr: '' }, EXPECT)).toEqual([])
  })

  it('bundle 被静默跳过：退出码是 0 也必须红，并同时点出 stderr 与缺段', () => {
    const failures = judgeCompose({ status: 0, stdout: COMPOSED_WITHOUT_US, stderr: SKIPPED }, EXPECT)
    expect(failures).toContain('stderr 含「skipping profile bundle」')
    expect(failures).toContain('stderr 含「incompatible」')
    expect(failures.some((f) => f.includes('没有 bundle 段'))).toBe(true)
    expect(failures).toContain('组合树里缺行 mast-minimal-hello')
  })

  it('stderr 只有一行 patch 告警（不在三个关键字里）也红：未登记的告警不放行', () => {
    const failures = judgeCompose({ status: 0, stdout: COMPOSED_WITH_US, stderr: PATCH_WARNING }, EXPECT)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('stderr 非空')
  })

  it('可选行没激活的启动告警红', () => {
    const failures = judgeCompose({ status: 0, stdout: COMPOSED_WITH_US, stderr: NOT_ACTIVATED }, EXPECT)
    expect(failures).toEqual(['stderr 含「did not activate」'])
  })

  it('bundle 段在，但缺一行：只点名那一行', () => {
    const stdout = COMPOSED_WITH_US.replace('- id: mast-minimal-runtime\n  name: dsh-spm/minimal\n', '')
    expect(judgeCompose({ status: 0, stdout, stderr: '' }, EXPECT)).toEqual(['组合树里缺行 mast-minimal-runtime'])
  })

  it('带 --patch 时 bundle 段标题可以是「patched by …」', () => {
    const stdout = COMPOSED_WITH_US.replace('# == dsh-spm\n', '# == dsh-spm, patched by <overlay>\n')
    expect(judgeCompose({ status: 0, stdout, stderr: '' }, EXPECT)).toEqual([])
  })

  it('退出码非 0 红', () => {
    expect(judgeCompose({ status: 1, stdout: '', stderr: '' }, EXPECT)[0]).toBe('退出码 1')
  })
})

describe('版本豁免', () => {
  // 实测：没有豁免时 `dsh plugin --profile <p> version-exemptions` 输出 `{}`；
  // 豁免之后 dump 是静默的（stderr 空、行都在），只有这一条看得见。
  it('空对象通过', () => {
    expect(judgeExemptions('{}\n')).toEqual([])
  })

  it('有豁免就红，并点名包与版本', () => {
    const failures = judgeExemptions('{\n  "dsh-spm@0.0.1": [\n    "0.2.1-rc.3"\n  ]\n}\n')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('dsh-spm@0.0.1')
  })

  it('不是 JSON 也红', () => {
    expect(judgeExemptions('oops')).toHaveLength(1)
  })
})
