#!/usr/bin/env node
/**
 * 兼容闸探针：装好的 profile 在**这一版 dsh** 下，dsh-spm 是不是真的进了组合树。
 *
 *     node scripts/probe-compose.ts --install-dir DIR --dsh-home DIR --profile NAME [--patch FILE]... [--expect-rows a,b]
 *
 * 为什么不看退出码：dsh 的插件兼容闸（0.1.5 没有，0.1.7-rc.2 已有）在 bundle 的 `engines.dsh`（没有时是
 * `@deepseek-ai/dsh*` 的 peer）与运行时版本不符时，**整个 bundle 被跳过，只在 stderr 打一行，退出码仍是 0**
 * （2026-10-20/26 在 0.2.1 的 rc.2 与 rc.3 上实测；承担这条行为的 `dsh-app-boot` 与 `dsh` 包在 rc.4 与 rc.3
 * 逐文件相同〔tarball 比对〕，未在 rc.4 上重测）；
 * 带 `--patch` 的 overlay 引用了不存在的行同样只是 stderr 一行。所以判据是：
 *   1. stderr 里没有 `did not activate` / `skipping profile bundle` / `incompatible`，且根本没有别的输出；
 *   2. 组合树里有 `# == dsh-spm` 这一段，期望的行都在；
 *   3. `dsh plugin --profile NAME version-exemptions` 为空。豁免（`allow-version --accept-risk`）一旦授予，
 *      不兼容就彻底静默——stderr 空、行都在（实测），只能靠这一条抓。
 *
 * 只做 `--dump-config`：不启动 profile、不碰网络、不碰模型。HOME / USERPROFILE / DSH_AGENTS_HOME 全指向临时目录，
 * 不读写真实的 ~/.dsh。启动期「可选行没激活」只会在真启动时出现，那一层由 M4 / native 验收的工具目录守卫兜住。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** dsh-app-boot 里这三条的出处：`activationDiagnostic`（可选行没激活）、`reportSkippedBundles`（bundle 被跳过）、`pluginCompatibilityWarning`（不兼容的原因文本）。 */
export const FORBIDDEN_STDERR = ['did not activate', 'skipping profile bundle', 'incompatible'] as const

export interface ComposeObservation {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface ComposeExpectation {
  /** bundle 的包名：组合树里以 `# == <名字>` 开头的那一段。 */
  readonly bundle: string
  /** 必须出现的顶层行 id。 */
  readonly rowIds: readonly string[]
}

/** 空数组 = 通过；否则每条是一句能直接读的失败原因。 */
export function judgeCompose(o: ComposeObservation, e: ComposeExpectation): string[] {
  const failures: string[] = []
  if (o.status !== 0) failures.push(`退出码 ${String(o.status)}`)
  const hit = FORBIDDEN_STDERR.filter((keyword) => o.stderr.includes(keyword))
  for (const keyword of hit) failures.push(`stderr 含「${keyword}」`)
  const firstLine = o.stderr.trim().split('\n')[0] ?? ''
  if (hit.length === 0 && firstLine !== '') failures.push(`stderr 非空（未登记的告警也算红）：${firstLine.slice(0, 200)}`)
  const lines = o.stdout.split('\n')
  if (!lines.some((line) => line === `# == ${e.bundle}` || line.startsWith(`# == ${e.bundle}, patched by`))) {
    failures.push(`组合树里没有 bundle 段「# == ${e.bundle}」——它被静默跳过了`)
  }
  for (const id of e.rowIds) if (!lines.includes(`- id: ${id}`)) failures.push(`组合树里缺行 ${id}`)
  return failures
}

/** `dsh plugin --profile <p> version-exemptions` 的输出：无豁免时是 `{}`，有时是 `{"包@版本": ["dsh 版本"]}`。 */
export function judgeExemptions(stdout: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return [`version-exemptions 输出不是 JSON：${stdout.trim().slice(0, 120)}`]
  }
  const keys = typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : ['(非对象)']
  return keys.length === 0 ? [] : [`profile 里有版本豁免：${keys.join(', ')}（豁免后不兼容是静默的，验收不得带豁免）`]
}

function main(): number {
  const { values: v } = parseArgs({
    options: {
      'install-dir': { type: 'string' }, 'dsh-home': { type: 'string' }, profile: { type: 'string' },
      patch: { type: 'string', multiple: true }, 'expect-rows': { type: 'string' }, bundle: { type: 'string' },
    },
  })
  if (!v['install-dir'] || !v['dsh-home'] || !v.profile) {
    console.error('用法：node scripts/probe-compose.ts --install-dir DIR --dsh-home DIR --profile NAME [--patch FILE]... [--expect-rows a,b] [--bundle 名字]')
    return 2
  }
  const installDir = resolve(v['install-dir'])
  const bin = join(dirname(createRequire(join(installDir, 'package.json')).resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  const scratch = mkdtempSync(join(tmpdir(), 'probe-compose-'))
  try {
    mkdirSync(join(scratch, 'agents'))
    mkdirSync(join(scratch, 'cwd'))
    const env = {
      ...process.env,
      DSH_HOME: resolve(v['dsh-home']), DSH_AGENTS_HOME: join(scratch, 'agents'), HOME: scratch, USERPROFILE: scratch,
      DSH_TELEMETRY_DISABLED: '1',
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1',
    }
    const run = (args: string[]): ComposeObservation => {
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: join(scratch, 'cwd'), env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 << 20, windowsHide: true })
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    }
    const patches = (v.patch ?? []).flatMap((file) => ['--patch', resolve(file)])
    const compose = run(['--profile', v.profile, ...patches, '--dump-config'])
    const exemptions = run(['plugin', '--profile', v.profile, 'version-exemptions'])
    const expectRows = (v['expect-rows'] ?? 'mast-minimal-hello,mast-minimal-runtime').split(',').filter(Boolean)
    const failures = [
      ...judgeCompose(compose, { bundle: v.bundle ?? 'dsh-spm', rowIds: expectRows }),
      ...(exemptions.status === 0 ? judgeExemptions(exemptions.stdout) : [`version-exemptions 退出码 ${String(exemptions.status)}`]),
    ]
    if (failures.length === 0) {
      console.log(`✓ ${v.profile}：dsh-spm 已进组合树（${expectRows.join(', ')}），stderr 为空，无版本豁免`)
      return 0
    }
    console.error(`✗ ${v.profile}：`)
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main())
