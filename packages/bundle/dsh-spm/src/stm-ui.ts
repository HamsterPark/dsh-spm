/**
 * bundle 的子路径入口：`name: dsh-spm/stm-ui`。
 *
 * 宿主面（`/mast/events` SSE hub）。客户端包（`ui-core` 等）是**另一条打包路径**
 * ——它们进的是 client bundle，不经过这里。
 */
export { name, apply, inject, type Config } from 'dsh-spm-stm-ui'
