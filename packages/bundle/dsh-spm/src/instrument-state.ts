/**
 * bundle 的子路径入口：`name: dsh-spm/instrument-state`。
 *
 * 与 `instrument-stmsim` 那条不同的是**它归 bundle 的 patch，不归 profile 的**：
 * 「接哪台仪器」因 profile 而异，「有没有状态缓存」不会——sim / offline / rig 三份
 * profile 都要它（PLAN §6.1 的 `mast-instrument-state` 行）。
 */
export { name, apply, inject, type Config } from 'dsh-spm-instrument-state'
