import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build, type Metafile } from 'esbuild'
import { forbiddenDistributionReference } from './minimal-distribution.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(root, 'packages', 'bundle', 'dsh-spm')
const artifactsDir = join(root, 'artifacts')
const stageDir = join(artifactsDir, 'dsh-spm-minimal-package')
const libDir = join(stageDir, 'lib')

type PackageManifest = {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function declaredExternalVersions(): Readonly<Record<string, string>> {
  const compat = readManifest(join(root, 'packages', 'host', 'compat', 'package.json'))
  const bundle = readManifest(join(bundleDir, 'package.json'))
  return Object.fromEntries(
    Object.entries({ ...compat.dependencies, ...bundle.peerDependencies }).filter(([name]) =>
      name.startsWith('@deepseek-ai/'),
    ),
  )
}

function resolvedVersion(name: string): string {
  const require = createRequire(join(root, 'packages', 'host', 'compat', 'package.json'))
  let cursor = dirname(require.resolve(name))
  for (;;) {
    const candidate = join(cursor, 'package.json')
    try {
      const manifest = readManifest(candidate)
      if (manifest.name === name && manifest.version !== undefined) return manifest.version
    } catch {
      // 继续向包根目录查找。
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`无法确定已安装外部包版本：${name}`)
    cursor = parent
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runPnpmBuild(): void {
  const command = process.platform === 'win32' ? process.env.ComSpec : 'pnpm'
  if (command === undefined) throw new Error('Windows 环境缺少 ComSpec，无法运行 pnpm build')
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm', 'build'] : ['build']
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]!
}

function externalPackages(meta: Metafile): string[] {
  const names = new Set<string>()
  for (const output of Object.values(meta.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external || imported.path.startsWith('node:')) continue
      names.add(packageName(imported.path))
    }
  }
  return [...names].sort()
}

runPnpmBuild()
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })

const result = await build({
  entryPoints: {
    index: join(bundleDir, 'src', 'index.ts'),
    minimal: join(bundleDir, 'src', 'minimal.ts'),
  },
  outdir: libDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  sourcemap: false,
  metafile: true,
  external: ['node:*', '@deepseek-ai/*'],
  logLevel: 'info',
})

const external = externalPackages(result.metafile)
const pinnedExternalVersions = declaredExternalVersions()
const unknown = external.filter((name) => pinnedExternalVersions[name] === undefined)
if (unknown.length !== 0) {
  throw new Error(`最小分发出现未钉版本的外部依赖：${unknown.join(', ')}`)
}
for (const name of external) {
  const declared = pinnedExternalVersions[name]!
  const installed = resolvedVersion(name)
  if (declared !== installed) throw new Error(`外部依赖版本不一致：${name} 声明 ${declared}，安装 ${installed}`)
}

const sourceManifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as {
  version: string
  license: string
  description: string
}
const peerDependencies = Object.fromEntries(external.map((name) => [name, pinnedExternalVersions[name]!]))
const manifest = {
  name: 'dsh-spm',
  version: sourceManifest.version,
  type: 'module',
  license: sourceManifest.license,
  description: `${sourceManifest.description}（最小可用分发）`,
  main: './lib/index.js',
  exports: {
    '.': './lib/index.js',
    './minimal': './lib/minimal.js',
    './package.json': './package.json',
  },
  files: ['lib', 'cordis.minimal.patch.yml'],
  dsh: { bundle: { patch: './cordis.minimal.patch.yml' } },
  peerDependencies,
  engines: { node: '^22.19.0 || >=24.0.0' },
}

writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
cpSync(join(bundleDir, 'cordis.minimal.patch.yml'), join(stageDir, 'cordis.minimal.patch.yml'))

for (const path of ['package.json', 'cordis.minimal.patch.yml', 'lib/index.js', 'lib/minimal.js']) {
  const text = readFileSync(join(stageDir, path), 'utf8')
  const found = forbiddenDistributionReference(text, root)
  if (found !== undefined) throw new Error(`${path} 泄漏了禁止的分发引用：${found}`)
}

mkdirSync(artifactsDir, { recursive: true })
const npmCommand = process.platform === 'win32' ? process.env.ComSpec : 'npm'
if (npmCommand === undefined) throw new Error('Windows 环境缺少 ComSpec，无法调用 npm pack')
const npmArgs = ['pack', stageDir, '--pack-destination', artifactsDir, '--json']
if (process.platform === 'win32') npmArgs.unshift('/d', '/s', '/c', 'npm')
const packed = execFileSync(npmCommand, npmArgs, {
  cwd: root,
  encoding: 'utf8',
})
const packResult = JSON.parse(packed) as Array<{ filename: string }>
const filename = packResult[0]?.filename
if (filename === undefined) throw new Error(`npm pack 未返回产物名：${packed}`)
const tgzPath = join(artifactsDir, filename)
const inputs = Object.keys(result.metafile.inputs)
  .map((path) => {
    const absolute = resolve(root, path)
    return { path: relative(root, absolute).replaceAll('\\', '/'), sha256: sha256(absolute) }
  })
  .sort((a, b) => a.path.localeCompare(b.path))
const provenance = {
  schemaVersion: 1,
  package: filename,
  sha256: sha256(tgzPath),
  git: {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length !== 0,
  },
  externalDependencies: peerDependencies,
  inputs,
}
const provenancePath = join(artifactsDir, filename.replace(/\.tgz$/, '.provenance.json'))
writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)

console.log(`最小分发包：${relative(root, tgzPath)}`)
console.log(`构建来源：${relative(root, provenancePath)}`)
console.log(`外部依赖：${external.map((name) => `${name}@${peerDependencies[name]}`).join(', ')}`)
