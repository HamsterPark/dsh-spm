/**
 * 每课时开工第一件事（EXECUTION.md §0-①）：dsh 有没有新版。
 *
 * 不做成测试，因为「上游发了新版」不是缺陷——CI 只该提示，不该变红（PLAN §6.3）。
 * 值得写成脚本的只有一件事：**跨 dist-tag 比 semver 大小**。哪个 tag 领先是会变的
 * （2026-09-04：`alpha` 落后于 `latest`；09-07 又反过来领先一个 minor），
 * 这个判断用眼睛做迟早出错。
 *
 * ## 2026-09-16：规矩 09-13 就改了，而这个脚本还在执行改之前那条
 *
 * `docs/dsh/upgrades.md` 的切换点补记（09-13）写着：此后**只跟 `latest` / `next`
 * 稳定通道**，`alpha` 只读发布说明、把影响记进 `facts.md`，**不升**。
 * 而这里一直在拿「所有 tag 里的 semver 最大值」判「落后了」——于是 `0.1.6-alpha.1`
 * 一发布，它就开始喊落后，而按规矩那一版根本不该升。
 *
 * **一个执行着旧规矩的执法者，比没有执法者更坏**：它每天喊一次狼来了，
 * 直到读的人学会不看它——那时真的落后了也不会有人发现。
 *
 * 所以现在分两栏报：
 *
 * - **稳定通道**（`latest` / `next` 的较大者）—— 这一栏落后了才是「该升级了」；
 * - **alpha 领先多少** —— 这一栏只提示一件事：去读发布说明，把影响记进 `facts.md`。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const compat = JSON.parse(
  readFileSync(new URL('../packages/host/compat/package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> }
const locked = compat.dependencies['@deepseek-ai/dsh-tools']!

// 走 npm 而不是直接打 registry HTTP：这样才和 pnpm 用同一份 registry 配置
// （镜像源、代理、鉴权），否则这里查到的和真正装下来的可能不是一回事。
// 用 execSync 的单条命令串，不用 execFileSync + args 数组：Windows 上 npm 是
// npm.cmd，Node 24 拒绝不开 shell 去 spawn .cmd（EINVAL），而开了 shell 再传
// args 数组又会触发 DEP0190。单条串两头都躲开。
const tags = JSON.parse(
  execSync('npm view @deepseek-ai/dsh dist-tags --json', { encoding: 'utf8' }),
) as Record<string, string>

// prerelease 也要正确排序：1.2.3-alpha.4 拆成 [1,2,3] 与 ['alpha',4]，数字段按数值比。
function compare(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.split('-', 2)
    return [core.split('.').map(Number), pre ? pre.split('.') : null] as const
  }
  const [ac, ap] = split(a)
  const [bc, bp] = split(b)
  for (let i = 0; i < 3; i++) if ((ac[i] ?? 0) !== (bc[i] ?? 0)) return (ac[i] ?? 0) - (bc[i] ?? 0)
  if (!ap && !bp) return 0
  if (!ap) return 1 // 正式版 > 任何预发布
  if (!bp) return -1
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = Number(x), ny = Number(y)
    return Number.isNaN(nx) || Number.isNaN(ny) ? (x < y ? -1 : 1) : nx - ny
  }
  return 0
}

/**
 * 稳定通道就是这两个 tag。**写成常量而不是「不叫 alpha 的都算」**：
 * 上游哪天多发一个 `beta` / `canary`，那种写法会把它悄悄算成稳定通道，
 * 而这里该做的是当场认不出来、由人去看一眼。
 */
const STABLE_TAGS = ['latest', 'next'] as const

const stable = STABLE_TAGS.map((t) => tags[t]).filter((v): v is string => v !== undefined)
const overall = Object.values(tags).sort(compare).at(-1)!
const unknownTags = Object.keys(tags).filter(
  (t) => !(STABLE_TAGS as readonly string[]).includes(t) && t !== 'alpha',
)

console.log(`dist-tags   ${JSON.stringify(tags)}`)
console.log(`本仓锁定    ${locked}`)

if (stable.length === 0) {
  // 两个稳定 tag 一个都没有 ⇒ 判不了。**不要退回「拿最大值凑合」**——
  // 那正是这次要修掉的那条。
  console.log(`\n⚠ ${STABLE_TAGS.join(' / ')} 一个都读不到，判不了是否落后。手动看一眼 dist-tags。`)
} else {
  const newest = stable.sort(compare).at(-1)!
  const behind = compare(locked, newest) < 0
  console.log(`稳定通道最大 ${newest}（${STABLE_TAGS.join(' / ')}）`)
  console.log(
    behind
      ? `\n⚠ 落后了。升级前先读 docs/dsh/upgrades.md 的八步清单。`
      : `\n✓ 稳定通道上已是最新。`,
  )
  // alpha 领先**不是**「落后了」。切换点之后它只带一条义务：读发布说明、记影响。
  if (compare(newest, overall) < 0) {
    console.log(
      `\nℹ alpha 领先到 ${overall} —— 按 upgrades.md 的切换点规则**不升**，` +
        `只读发布说明并把影响记进 docs/dsh/facts.md §8。`,
    )
  }
}

if (unknownTags.length > 0) {
  console.log(`\n⚠ 出现了没见过的 dist-tag：${unknownTags.join(', ')} —— 人去看一眼它算哪一档。`)
}
