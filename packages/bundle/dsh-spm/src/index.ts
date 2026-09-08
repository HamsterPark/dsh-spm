/**
 * dsh-spm 总 bundle 的插件入口。
 *
 * Cordis 插件的具名导出形式：`name` 是日志与错误里的身份，`inject` 声明**装载
 * 依赖**（不是运行时检查——少一件 Cordis 直接不装载这个插件），`apply` 是插件体。
 *
 * `inject: ['tools']` 这一行就是 PLAN §6.1-3「安全件是装载依赖，不是运行时检查」
 * 的最小演示：将来 skill-runtime 写的是 `inject: ['stmSafety', 'instrument',
 * 'instrumentState']`，缺任何一件，技能工具**根本不会出现**，而不是出现之后在
 * 运行时才拒绝。
 */
import { createRequire } from 'node:module'
import { defineTool, type Context } from 'dsh-spm-compat'

export const name = 'dsh-spm'

export const inject = ['tools']

// 版本不写死。package.json 已经是真源了，再抄一份进常量就是第二份没人校验的真源
// ——正是 EXECUTION.md 台账 B5 反对的那件事。「对应哪个 dsh」也一样：它就是
// peerDependencies 里那个精确钉，不另设字段。
const manifest = createRequire(import.meta.url)('../package.json') as {
  version: string
  peerDependencies: Record<string, string>
}
const VERSION = manifest.version
const LOCKED_DSH = manifest.peerDependencies['@deepseek-ai/dsh-tools']

export function apply(ctx: Context): void {
  // ctx.effect 登记的东西在插件卸载时会被回滚——工具注册也一样。
  // 不用 effect 就等于插件卸载后工具还挂在注册表上。
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'stm_hello',
        description: 'dsh-spm 自检：返回插件版本与它编译时锁定的 dsh 版本。不碰仪器。',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: () => Promise.resolve(`dsh-spm ${VERSION}（对应 dsh ${LOCKED_DSH}）`),
      }),
    ),
  )
}
