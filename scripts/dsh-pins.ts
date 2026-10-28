/**
 * 脚本共用的 dsh 版本事实。以前 `install-minimal.ts`、`verify-minimal.ts`、`verify-native.ts` 各把 dsh 与 Cordis
 * 的版本号写死一份，升级时要记得逐个改，漏一处就是一次验收假红。
 *
 * - `DSH_VERSION` / `CORDIS_VERSION`：读 compat 的依赖，与 `pin.test.ts` 的「真源」是同一处。
 * - `VENDOR_PINS`：启动器依赖闭包里**非 dsh 的** `@deepseek-ai/*`（独立版本线）。dsh 0.1.7-alpha.2 起对它们
 *   声明 `~` 范围，不钉的话全新安装会漂到发布日之后的补丁版。升级时对照 `spec/dsh/pkglist.<版本>.txt` 里的
 *   非 dsh 行更新；其中本仓依赖闭包也有的那几个，`pin.test.ts` 会与锁文件逐项比对。
 */
import { readFileSync } from 'node:fs'

const compat = JSON.parse(readFileSync(new URL('../packages/host/compat/package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}

export const DSH_VERSION: string = compat.dependencies['@deepseek-ai/dsh-tools']!
export const CORDIS_VERSION: string = compat.dependencies['@deepseek-ai/cordis']!

export const VENDOR_PINS: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis': '4.0.5',
  '@deepseek-ai/cordis-plugin-group': '1.0.5',
  '@deepseek-ai/cordis-plugin-include': '1.0.10',
  '@deepseek-ai/cordis-plugin-loader': '1.0.6',
  '@deepseek-ai/cordis-plugin-timer': '1.1.7',
  '@deepseek-ai/cosmokit': '1.8.6',
  '@deepseek-ai/libreoffice-kit': '0.1.5',
  '@deepseek-ai/node-addon-system': '0.1.2',
  '@deepseek-ai/schemastery': '3.18.5',
}
