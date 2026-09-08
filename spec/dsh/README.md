# `spec/dsh/` —— dsh 组合树存档

每次升级 dsh 都把 web profile 的组合树导出存档，用来逐行 diff（升级清单第 2 步，`docs/dsh/upgrades.md`）。

```powershell
npx -y @deepseek-ai/dsh@<版本> --profile web --dump-config > spec/dsh/dump-config.<版本>.yml
```

npx 在本机偶发 EPERM（清理缓存时撞上文件锁）。退路是装到临时目录再直接调 bin——**这条路还能在原生依赖没编译时照样导出规格**：

```sh
mkdir /tmp/pin && cd /tmp/pin && echo '{"name":"x","private":true,"version":"0.0.0"}' > package.json
npm i @deepseek-ai/dsh@<版本> --ignore-scripts --no-audit --no-fund
node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config > dump-config.<版本>.yml
```

| 文件 | 导出日期 | 说明 |
|---|---|---|
| `dump-config.0.1.2-alpha.3.yml` | 2026-09-02 | 145 行插件行，27 行 `disabled: true` |
| `dump-config.0.1.2-alpha.4.yml` | 2026-09-02 | 与 alpha.3 逐字节相同 |
| `dump-config.0.1.2-rc.1.yml` | 2026-09-04 | 与前两版逐字节相同；**当前锁定版本** |
| `dump-config.0.1.3-alpha.2.yml` | 2026-09-07 | **147 行插件行，26 disabled**。相对 rc.1 只有四处变更，见下 |
| `pkglist.0.1.2-alpha.4.txt` | 2026-09-02 | npx 安装树里 223 个 `@deepseek-ai/*` 包名清单 |
| `pkglist.0.1.3-alpha.2.txt` | 2026-09-07 | 232 个包名＋版本。**223 个 `@deepseek-ai/dsh*` 全部恰好是 `0.1.3-alpha.2`，零例外**；其余 9 个是独立版本线的 Cordis 系与 `node-addon-landlock-run@0.1.1` |

**0.1.2 的三版组合树逐字节相同**，说明 alpha.3 → rc.1 之间插件名单与默认配置没动过；变的是各包内部实现（见 `docs/dsh/facts.md` §8）。
这也解释了为什么本地跑着没事：npx 缓存是冻结快照，版本漂移只在全新安装时发作（facts.md §1）。

**rc.1 → 0.1.3-alpha.2 的全部四处变更**（2026-09-07 实测 diff，共 20 个 diff 行）：

1. **删除** `tool-str-replace-editor` 行（原本就 `disabled`）⇒ 对应发布说明「SDK/Headless/ACP 默认改用 read/write/edit」。disabled 计数 27 → 26。
2. **`system-prompt` 的 `persona` 拆成 `personaPrefix` + `personaSuffix`** ⇒ 发布说明列为破坏性变更，实测确认。我们 8 个 preset 的 `persona` 子插件要跟着拆（PLAN §7.8）。
3. **新增** `open-in-app`（`dsh-host-open-in-app`，含 `probeTimeoutMs/iconTimeoutMs/launchWatchMs`）+ 客户端 `ui-open-in-app` ⇒「在编辑器/IDE/终端/文件管理器中打开工作区」。
4. **新增** 客户端 `file-upload`（`dsh-client-file-upload`）⇒ 任意文件上传。

**新包 `dsh-http-proxy` 不在组合树里**——它是启动器在进程级装的 undici 全局 dispatcher（读 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`），不是 profile 插件行。这对 `mast-rig` 是个比 `restrict({deny: web_fetch})` 更硬的出站闸（Phase 8 评估）。

导出件带 `!!js` 表达式（如 `process.platform === 'win32'`），是 dsh 的 patch 层语法，不是我们要执行的东西。
