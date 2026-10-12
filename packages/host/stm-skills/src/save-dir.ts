/**
 * K14（决策 D12）要知道控制器把 .sxm / .dat 存到哪：**问仪器**（`Util_SessionPathGet`），不猜。
 *
 * 技能自己从不报「我刚存下了哪个文件」——`ScanAt` / `FullScan` / `WaitScanComplete` 的
 * `data` 里没有路径；`SaveScan` 的 `saved_path`、`AcquireSTS` 的 `path` 是「会话目录里
 * 最近 120 s 内最新的那个」，可能是上一次的文件；分析类技能的 `scan_path` / `dat_path`
 * 是**输入**。所以 K14 不读这些键，而是比较调用前后这个目录里多出来的文件
 * （与参考实现 VISTA-SPM `host.py::_ingest_new_files` 同一个办法）。
 *
 * 与 `GetLatestScanFile` / `SaveScan` / `AcquireSTS` 走同一条路：同一个解析器
 * （`lastString`）、同一个归一（`sessionDir`：报的是目录就用它，是「目录 + 文件名前缀」
 * 就取上级，两个都不是目录给 `null`）。「控制器存在哪」在本仓只该有一种答案。
 */
import type { SafeCall } from 'dsh-spm-kernel'
import { sessionDir } from './l0/frames.js'
import { lastString } from './l0/reads-hw.js'

/** 控制器当前的保存目录；问不到、或者报的不是一个目录，就是 `null`。 */
export async function controllerSaveDir(call: { readonly safeCall: SafeCall }): Promise<string | null> {
  const rec = await call.safeCall('Util_SessionPathGet')
  if (rec.error !== undefined && rec.error !== '') return null
  return sessionDir(lastString(rec))
}
