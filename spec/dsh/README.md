# dsh 配置与依赖快照

本目录保存历次升级时导出的 dsh web 与 headless 组合配置（headless 自 0.2.1-rc.4 起才有），以及当时的安装树清单。它们用于比较上游变化；当前锁版以 [compat/package.json](../../packages/host/compat/package.json) 和锁文件为准，版本决策见 [facts.md](../../docs/dsh/facts.md) 与 [upgrades.md](../../docs/dsh/upgrades.md)。

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
| [0.2.1-rc.4](dump-config.0.2.1-rc.4.yml) | 2026-10-28 | web 组合：191 个顶层行、1231 行（0.1.5-rc.2 为 152 个、539 行），逐项变化见 [facts.md](../../docs/dsh/facts.md) §8；相对 0.2.1-rc.2 只多 `entry-customization` 一行 |
| [0.2.1-rc.4 headless](dump-config.headless.0.2.1-rc.4.yml) | 2026-10-28 | headless 组合：`dsh-base` 加 `dsh-headless`，不含 preset，98 个顶层行、382 行。我们的最小入口 profile 是 `dsh-base` 加 `dsh-spm`，与它相比，行集合只差 `headless-runner`、`headless-startup` 两行和我们自己的两行，`tool-*` 行相同；但 headless 补丁还禁用了 `credentials`、`authorization`、`deepseek-account`、`hmr`，并改了 `system-prompt` 的 `personaPrefix` 与 `tools` 的 `mode`（取自环境变量 `DSH_TOOLS_MODE`），我们的补丁关掉了 `session-log-deepseek`。模型验收时 profile 会补入 `dsh-headless`（见 [STM-Bench 指南](../../docs/MINIMUM-USABLE.md)与 [Nanonis 指南](../../docs/NANONIS-SIMULATOR.md)） |
| [0.2.1-rc.5](dump-config.0.2.1-rc.5.yml) | 2026-11-01 | web 组合：与 0.2.1-rc.4 的快照逐字节相同（191 个顶层行、1231 行） |
| [0.2.1-rc.5 headless](dump-config.headless.0.2.1-rc.5.yml) | 2026-11-01 | headless 组合：与 0.2.1-rc.4 的 headless 快照逐字节相同（98 个顶层行、382 行）。内容没变也存一份新名字：`acceptance-overlay.test.ts` 与 `reply-budget.test.ts` 按锁定版本读它 |

文件名标识被导出的版本，日期对应仓库内的升级记录。配置相同说明该快照中的插件名单和默认配置相同，不代表包内部实现没有变化。实际包接触面和测试结果在对应升级记录中核对。

## 安装树记录

- [pkglist.0.1.2-alpha.4.txt](pkglist.0.1.2-alpha.4.txt)：早期 npx 缓存中的包清单。
- [pkglist.0.1.3-alpha.2.txt](pkglist.0.1.3-alpha.2.txt)：该次安装的包名与版本。
- [pkglist.0.1.5-alpha.1.txt](pkglist.0.1.5-alpha.1.txt)：该次安装的包名与版本，包含独立版本线的 Cordis 包。
- [pkglist.0.2.1-rc.4.txt](pkglist.0.2.1-rc.4.txt)：从 `pnpm-lock.yaml` 导出的 314 行，其中 dsh 系 296、Cordis 系 7、`libreoffice-kit` 系 6、`node-addon-system` 系 5。
- [pkglist.0.2.1-rc.5.txt](pkglist.0.2.1-rc.5.txt)：同样的 314 行，去掉版本串后与 rc.4 的逐行相同。

这些是历史环境记录。当前依赖约束由 manifest、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 共同表达；[pin.test.ts](../../packages/host/compat/contract/pin.test.ts) 检查锁文件中的 dsh 版本及真实包契约。

## 更新快照

仅在核查或升级 dsh 时导出，并且只在仓外的临时目录里操作；不要使用读者正在工作的个人 profile。**不要用 `npx`**：`npx` 只钉住启动器，子包照样被 caret 拉到最新（见 [facts.md](../../docs/dsh/facts.md) §8.-2），还会读写真实的 `~/.dsh`。方法：

1. 在仓外建一个只依赖 `@deepseek-ai/dsh@<版本>` 的项目：逐个向 registry 解析闭包里的 `@deepseek-ai/dsh*` 包，用 `pnpm-workspace.yaml` 的 `overrides` 把它们和 Cordis 系包都钉成确切版本，`allowBuilds` 全部设为 `false`（不跑任何构建脚本），然后 `pnpm install`。
2. 运行 `node node_modules/@deepseek-ai/dsh/lib/bin.js --profile <web|headless> --dump-config`。不带 `--patch`，也不用已装了 `dsh-spm` 的 profile，否则输出里会出现带本机路径的 `patched by` 标题。运行时把 `DSH_HOME`、`DSH_AGENTS_HOME`、`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP` 都指到该临时目录，网络代理指向不可用地址；每个组合用各自的新目录，因为 `--dump-config` 会在 `DSH_HOME` 里建 profile 目录。
3. 确认 stderr 为空；运行前后各取一份真实 `~/.dsh`、`~/.agents` 的元数据快照（只读路径、类型、大小、时间，不读内容），逐字节比对相同。
4. 把 stdout 保存为 `dump-config.<版本>.yml`（web）和 `dump-config.headless.<版本>.yml`；包清单 `pkglist.<版本>.txt` 取自该项目 `pnpm-lock.yaml` 里去重排序后的 `@deepseek-ai/*@<版本>`（该项目没有给第三方 `zod` 写 override，锁里可以有两份，所以不要拿 `scripts/gen-dsh-pins.ts` 的导出器处理它，按 `@deepseek-ai/*` 自己去重）。提交前扫描本机用户名、盘符路径和临时目录名。与上一版逐字节相同时也存新名字的文件。

与前一版比较后，在升级日志记录日期、配置差异、包差异和验证结果。导出配置不代表完成插件启动、安装态或模型验收。

快照中的 `!!js` 表达式属于 dsh patch 配置语法。阅读时将其作为配置内容；不要为了查看快照而执行其中表达式。

## 历史比较：0.1.2-rc.1 → 0.1.3-alpha.2

2026-09-07 的配置比较记录了四项变化：

1. 删除已禁用的 `tool-str-replace-editor` 行；SDK/Headless/ACP 默认改用 read/write/edit。
2. `system-prompt` 的 `persona` 拆为 `personaPrefix` 和 `personaSuffix`，影响 persona 配置接缝。
3. 新增宿主侧 `open-in-app` 和客户端 `ui-open-in-app`。
4. 新增客户端 `file-upload`。

同次核查中的 `dsh-http-proxy` 由启动器在进程级安装，不作为 profile 插件行出现。这说明配置树不是全部上游行为的清单；涉及连接、会话或代理的变化还需要阅读相应包与升级记录。
