import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_VERSION = '0.1.5-rc.2'

function option(name: string, fallback?: string): string {
  const at = process.argv.indexOf(name)
  const value = at < 0 ? fallback : process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`缺少 ${name} <值>`)
  return value
}

function runNode(script: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function canonicalFuturePath(path: string): string {
  const missing: string[] = []
  let cursor = path
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor))
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return resolve(realpathSync(cursor), ...missing)
}

type DependencyNode = { name?: string; version?: string; dependencies?: Record<string, DependencyNode> }

function installedDshVersions(tree: DependencyNode[]): Record<string, string[]> {
  const versions = new Map<string, Set<string>>()
  const visit = (node: DependencyNode, dependencyName?: string): void => {
    const name = node.name ?? dependencyName
    if (name?.startsWith('@deepseek-ai/dsh') && node.version !== undefined) {
      const found = versions.get(name) ?? new Set<string>()
      found.add(node.version)
      versions.set(name, found)
    }
    for (const [childName, child] of Object.entries(node.dependencies ?? {})) visit(child, childName)
  }
  tree.forEach(visit)
  return Object.fromEntries([...versions].sort(([a], [b]) => a.localeCompare(b)).map(([name, found]) => [name, [...found].sort()]))
}

async function dshPackageNames(): Promise<string[]> {
  const pending = ['@deepseek-ai/dsh']
  const seen = new Set<string>()
  while (pending.length !== 0) {
    const batch = pending.splice(0)
    const manifests = await Promise.all(
      batch.map(async (name) => {
        const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${DSH_VERSION}`
        const response = await fetch(url)
        if (!response.ok) throw new Error(`读取 ${name}@${DSH_VERSION} 失败：HTTP ${response.status}`)
        return (await response.json()) as {
          dependencies?: Record<string, string>
          optionalDependencies?: Record<string, string>
          peerDependencies?: Record<string, string>
        }
      }),
    )
    for (let i = 0; i < batch.length; i += 1) {
      const name = batch[i]!
      if (seen.has(name)) continue
      seen.add(name)
      const manifest = manifests[i]!
      const reachable = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }
      for (const dependency of Object.keys(reachable)) {
        if (dependency.startsWith('@deepseek-ai/dsh-') && !seen.has(dependency)) pending.push(dependency)
      }
    }
  }
  return [...seen].sort()
}

const target = resolve(option('--target'))
const artifact = resolve(option('--artifact', join(repoRoot, 'artifacts', 'dsh-spm-0.0.1.tgz')))
const profile = option('--profile', 'minimal')
if (!/^[a-z][a-z0-9_-]*$/.test(profile)) throw new Error('--profile 只允许小写字母开头及小写字母、数字、_、-')
const canonicalRepo = realpathSync(repoRoot)
const canonicalTarget = canonicalFuturePath(target)
const fromRepo = relative(canonicalRepo, canonicalTarget)
const targetInsideRepo = fromRepo === '' || (!isAbsolute(fromRepo) && fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`))
if (!isAbsolute(target) || targetInsideRepo) {
  throw new Error('--target 必须是仓库之外的新绝对目录')
}
if (existsSync(target)) throw new Error(`拒绝覆盖已有安装目录：${target}`)
if (!existsSync(artifact)) throw new Error(`找不到分发包：${artifact}`)
mkdirSync(target, { recursive: true })
const copiedArtifact = join(target, basename(artifact))
copyFileSync(artifact, copiedArtifact)
const copiedArtifactSha256 = sha256(copiedArtifact)

const dshNames = await dshPackageNames()
const packageJson = {
  name: 'dsh-spm-minimal-install',
  version: '0.0.0',
  private: true,
  type: 'module',
  dependencies: {
    '@deepseek-ai/dsh': DSH_VERSION,
    '@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/dsh-host-webserver': DSH_VERSION,
    '@deepseek-ai/dsh-system-prompt': DSH_VERSION,
    '@deepseek-ai/dsh-tools': DSH_VERSION,
  },
}
writeFileSync(join(target, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
const overrides = dshNames.map((name) => `  '${name}': '${DSH_VERSION}'`).join('\n')
const excludes = dshNames.map((name) => `  - '${name}@${DSH_VERSION}'`).join('\n')
writeFileSync(
  join(target, 'pnpm-workspace.yaml'),
  `minimumReleaseAgeExclude:\n${excludes}\n\noverrides:\n${overrides}\n\nallowBuilds:\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': true\n  koffi: true\n  node-pty: true\n  protobufjs: true\n`,
)

const pnpmCli = process.env.npm_execpath
if (pnpmCli === undefined || !existsSync(pnpmCli)) throw new Error('请通过 pnpm install:minimal 运行，以取得固定 pnpm CLI')
runNode(pnpmCli, ['install', '--frozen-lockfile=false'], target)
const dshHome = join(target, 'dsh-home')
const topRequire = createRequire(join(target, 'package.json'))
const dshManifestPath = topRequire.resolve('@deepseek-ai/dsh/package.json')
const dshCli = join(dirname(dshManifestPath), 'lib', 'bin.js')
runNode(dshCli, ['plugin', '--profile', profile, 'add', copiedArtifact], target, { DSH_HOME: dshHome })

const profileDir = join(dshHome, 'profiles', profile)
const dshRequire = createRequire(dshManifestPath)
const pluginRequire = createRequire(join(profileDir, 'node_modules', 'dsh-spm', 'package.json'))
const external = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools']
const identities = Object.fromEntries(
  external.map((name) => {
    const host = realpathSync(dshRequire.resolve(name))
    const plugin = realpathSync(pluginRequire.resolve(name))
    if (host !== plugin) throw new Error(`${name} 出现重复运行时实例：${host} != ${plugin}`)
    return [name, host]
  }),
)
await import(pathToFileURL(pluginRequire.resolve('dsh-spm')).href)
await import(pathToFileURL(pluginRequire.resolve('dsh-spm/minimal')).href)
const installedTree = JSON.parse(runNode(pnpmCli, ['list', '--depth', 'Infinity', '--json'], target)) as DependencyNode[]
const actualDshVersions = installedDshVersions(installedTree)
for (const [name, versions] of Object.entries(actualDshVersions)) {
  if (!dshNames.includes(name)) throw new Error(`实际安装的 dsh 包未进入 overrides：${name}`)
  if (versions.length !== 1 || versions[0] !== DSH_VERSION) {
    throw new Error(`${name} 实际安装版本不是唯一的 ${DSH_VERSION}：${versions.join(', ')}`)
  }
}

const report = {
  dshVersion: DSH_VERSION,
  dshPackages: dshNames,
  sourceArtifact: artifact,
  copiedArtifact,
  copiedArtifactSha256,
  profile,
  profileDir,
  actualDshVersions,
  externalModuleIdentities: identities,
}
writeFileSync(join(target, 'install-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`安装目录：${target}`)
console.log(`DSH_HOME：${dshHome}`)
console.log(`profile：${profileDir}`)
console.log(`检查报告：${join(target, 'install-report.json')}`)
