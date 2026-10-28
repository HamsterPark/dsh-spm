/**
 * 验收会话（M4 的 `model-minimal.ts`、Nanonis 的 `native-session.ts`）交给 dsh 的 overlay 与子进程环境里，
 * 两份脚本必须一致的部分。以前各抄一份；dsh 0.2 时两份一起坏了一次（上游删掉了一个工具行，又新增了一个）。
 *
 * 绕行闸门：PTC 的 Node 程序、shell 工具、workflow、子 agent 都能不经「一动一观」闸门直接连仪器的 TCP 端口——
 * 依据是 dsh-ptc-runtime-node 的 README（「Direct filesystem, network and subprocess operations remain Node
 * operations」）与 dsh-sandbox-policy 的 README（「network and process policy are outside its vocabulary」）：
 * 沙箱策略只管文件效果，没有限制网络与进程的开关。所以验收组合，以及将来的 IC / conduct 组合，
 * 必须把这几族关掉。
 *
 * 本清单要与 dsh 组合里默认启用的 `tool-*` 行保持一致：组合里每个默认启用的 `tool-*` 行都必须在这里被关掉，
 * 而清单里引用组合中不存在的行 id，只会在 stderr 留一句 `patch: entry … not found`、退出码仍是 0。
 * 把清单对着入仓的 headless 组合快照自动核对的守卫测试另行加入；在那之前靠 `probe:compose` 与 `--dump-config` 人工对照。
 */

/** 能绕过闸门的工具行族。 */
export const GATE_BYPASS_ROWS = {
  shell: ['tool-bash', 'tool-pwsh'],
  jobs: ['tool-jobs'],
  workflow: ['tool-workflow'],
  subagent: ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork'],
} as const

/** 验收 overlay 关掉的行：全部模型可见工具行，加上与验收无关、会多发请求或多暴露东西的辅助行。 */
export const ACCEPTANCE_DISABLED_ROWS: readonly string[] = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
  'tool-workflow', 'tool-result-pruner', 'tool-todo', 'tool-goal', 'tool-web', 'tool-working-directory',
  'plan-mode', 'session-title-llm', 'llm-retry',
]

/**
 * overlay 里「关掉」的那部分行（patch 按 id 整行替换 config，所以会话日志那一行只写 enabled）。
 * 会话日志上传缺省开启（dsh 0.1.5 缺省关闭，0.1.6-alpha.1 起改为开启）：走官方 DeepSeek API 的请求会附带会话日志增量，
 * 其中含工具结果，也就是仪器读数；`DSH_TELEMETRY_DISABLED` 管不到它（它只管 `session-telemetry-otel` 那一行）。
 */
export function acceptanceOverlayRows(): string[] {
  return [
    ...ACCEPTANCE_DISABLED_ROWS.map((id) => `- id: ${id}\n  disabled: true`),
    '- id: session-log-deepseek\n  config:\n    enabled: false',
  ]
}

/** 子进程环境里两份脚本共有的钉死项：工具只走原生函数调用（不开 PTC）；关掉 OTel 遥测那一行。 */
export const ACCEPTANCE_CHILD_ENV = { DSH_TOOLS_MODE: 'native', DSH_TELEMETRY_DISABLED: '1' } as const
