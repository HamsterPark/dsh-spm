# dsh 配置与依赖快照

本目录保存历次升级时导出的 dsh web profile 配置，以及当时的安装树清单。它们用于比较上游变化；当前锁版以 [compat/package.json](../../packages/host/compat/package.json) 和锁文件为准，版本决策见 [facts.md](../../docs/dsh/facts.md) 与 [upgrades.md](../../docs/dsh/upgrades.md)。

## 配置快照

| 文件 | 记录日期 | 比较结果 |
|---|---|---|
| [0.1.2-alpha.3](dump-config.0.1.2-alpha.3.yml) | 2026-09-02 | 早期 web profile 基线 |
| [0.1.2-alpha.4](dump-config.0.1.2-alpha.4.yml) | 2026-09-02 | 与 alpha.3 逐字节相同 |
| [0.1.2-rc.1](dump-config.0.1.2-rc.1.yml) | 2026-09-04 | 与上述两份快照逐字节相同 |
| [0.1.3-alpha.2](dump-config.0.1.3-alpha.2.yml) | 2026-09-07 | 相对 0.1.2-rc.1 的四项变化见下文 |
| [0.1.5-alpha.1](dump-config.0.1.5-alpha.1.yml) | 2026-09-09 | 当次升级基线；后续由 rc 版本替代 |
| [0.1.5-rc.1](dump-config.0.1.5-rc.1.yml) | 2026-09-10 | 当次升级的两处配置变更见升级日志 |
| [0.1.5-rc.2](dump-config.0.1.5-rc.2.yml) | 2026-09-13 | 与 0.1.5-rc.1 快照逐字节相同 |

文件名标识被导出的版本，日期对应仓库内的升级记录。配置相同说明该快照中的插件名单和默认配置相同，不代表包内部实现没有变化。实际包接触面和测试结果在对应升级记录中核对。

## 安装树记录

- [pkglist.0.1.2-alpha.4.txt](pkglist.0.1.2-alpha.4.txt)：早期 npx 缓存中的包清单。
- [pkglist.0.1.3-alpha.2.txt](pkglist.0.1.3-alpha.2.txt)：该次安装的包名与版本。
- [pkglist.0.1.5-alpha.1.txt](pkglist.0.1.5-alpha.1.txt)：该次安装的包名与版本，包含独立版本线的 Cordis 包。

这些是历史环境记录。当前依赖约束由 manifest、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 共同表达；[pin.test.ts](../../packages/host/compat/contract/pin.test.ts) 检查锁文件中的 dsh 版本及真实包契约。

## 更新快照

仅在核查或升级 dsh 时导出。先按升级指南准备独立的临时 `DSH_HOME`，确认目标版本和输出位置；不要使用读者正在工作的个人 profile。命令模板如下，`<版本>` 必须替换为明确版本：

```text
npx -y @deepseek-ai/dsh@<版本> --profile web --dump-config
```

确认命令成功后，将输出保存为 `dump-config.<版本>.yml`，与前一版比较，并在升级日志记录日期、配置差异、包差异和验证结果。导出配置不代表完成插件启动、安装态或模型验收。

快照中的 `!!js` 表达式属于 dsh patch 配置语法。阅读时将其作为配置内容；不要为了查看快照而执行其中表达式。

## 历史比较：0.1.2-rc.1 → 0.1.3-alpha.2

2026-09-07 的配置比较记录了四项变化：

1. 删除已禁用的 `tool-str-replace-editor` 行；SDK/Headless/ACP 默认改用 read/write/edit。
2. `system-prompt` 的 `persona` 拆为 `personaPrefix` 和 `personaSuffix`，影响 persona 配置接缝。
3. 新增宿主侧 `open-in-app` 和客户端 `ui-open-in-app`。
4. 新增客户端 `file-upload`。

同次核查中的 `dsh-http-proxy` 由启动器在进程级安装，不作为 profile 插件行出现。这说明配置树不是全部上游行为的清单；涉及连接、会话或代理的变化还需要阅读相应包与升级记录。
