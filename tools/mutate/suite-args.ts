/**
 * 演练里每一趟（基线与变异）跑的那条 vitest 命令。
 *
 * 单独一个文件，是为了让契约测试能 import 它、钉住运行器真的带着排除去跑，又不必 import `run.ts`：
 * 后者在顶层装了信号和未捕获异常的处理器，那些只该装在演练的进程里，不该装进 vitest 的 worker。
 */

/**
 * 每一趟（基线与变异）都**排除**规则体检 `mutation-registry.test.ts`。
 *
 * 它数的是每条规则的 `find` 在目标文件里命中几次。任何一条变异落地，那条规则自己的 `find` 就不再命中，
 * 体检必然变红 —— 与被变异的闸有没有人看无关。它住在 bundle 的 `contract/` 里，于是 scope 落在
 * `packages/bundle/dsh-spm` 的规则按构造永远判 red，等价变异也一样，那样的 red 不是证据。
 * host 范围的规则碰不到它。基线里它本来是绿的，排除它不改变基线的含义。
 */
export const EXCLUDED_FROM_SUITE: readonly string[] = ['**/mutation-registry.test.ts']

/** `vitest` 之后的参数：只跑非集成项目里 `scope` 下的测试，排除体检，点状报告。 */
export function suiteArgs(scope: string): string[] {
  const exclude = EXCLUDED_FROM_SUITE.flatMap((glob) => ['--exclude', glob])
  return ['run', '--project', '!integration', ...exclude, scope, '--reporter=dot']
}
