/**
 * bundle 的子路径入口：`name: dsh-spm/instrument-stmsim`。
 *
 * profile 的 `node_modules` 里只有 **`dsh-spm` 一个包**（`dsh plugin add` 装的是 bundle），
 * 加载器又是拿 `name` 直接做动态 import 的 ⇒ 内部包必须**经由 bundle 的子路径导出**才寻址得到。
 * 这就是「bundle 是安装单位、profile 是组合单位」（PLAN §6.1）在文件层面的样子。
 *
 * 只转出 `name` / `apply` / `Config`：加载器把整个模块名字空间当插件对象用，
 * 多转出来的东西（`StmsimProcess` 之类）在这条路径上一个消费者都没有。
 */
export { name, apply, type Config } from 'dsh-spm-instrument-stmsim'
