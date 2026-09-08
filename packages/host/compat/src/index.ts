/**
 * dsh-spm-compat —— 全仓**唯一**允许 import `@deepseek-ai/*` 的地方（PLAN §3.1-1、§6.1-2）。
 *
 * 为什么要这道墙：dsh 平均一天一版、官方预告还有若干破坏性重构。API 一漂，
 * 有这道墙就只有这一个文件变红；没有的话，几十个包里散落的 import 每一处都要改。
 *
 * **只导出此刻真有人用的名字**。想加新的，先有调用方。
 * 当前调用方：课时 0.4 的 `stm_hello` 工具（插件三件套 + defineTool）。
 */

// 从 dsh-tools 取值时会连带激活它的 `declare module '@deepseek-ai/cordis'`，
// 把 `tools` 挂到 Context 上——所以下面的 Context 类型自带 ctx.tools。
export { defineTool } from '@deepseek-ai/dsh-tools'
export type { DefineToolOptions } from '@deepseek-ai/dsh-tools'

export type { Context } from '@deepseek-ai/cordis'
