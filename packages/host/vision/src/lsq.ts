/**
 * `np.polyfit` 的对面 —— 列缩放 + Householder QR（{@link lstsqQr}，已搬去 `numerics`）。
 *
 * ## ⚠️ 这一份**没有**跟着 `lstsqQr` 搬去 `numerics/`，而那是一条判据不是偷懒
 *
 * 批 6b 交接 §7 把 `lstsqQr` 与 `polyfit` 一起列进了「该搬去 numerics 的四件」。
 * `lstsqQr` 搬了；`polyfit` **搬不过去**：`numerics` 里已经住着一个同名的
 * `polyfit`（`savgol.ts`，走**列缩放 + 正规方程**），而两者**不是同一个函数**。
 *
 * | | 本份（`vision/lsq.ts`） | `numerics/savgol.ts` |
 * |---|---|---|
 * | 解法 | 列缩放 + Householder **QR** | 列缩放 + **正规方程** + Cholesky |
 * | 误差 | `κ·eps` | `κ²·eps`（`lstsqRelTol`） |
 * | 某列范数为 0 | 照解（`c[k] = 0`） | **抛**「设计矩阵不满秩」 |
 * | 实测差 | `n=256, deg=3` 上系数相对差 **`5e−9`** —— 不是最后一位 | |
 *
 * 于是三条路都不通：`export *` 会撞名；改名是重写；统一成一份会**同时**改动
 * `spec/golden/numerics.json`（`polyfit` 一节 + `savgol` 两端那一段）与
 * `spec/golden/scan_prep.json`（`line_subtract` 那一族）。
 * **各自的消费方要的正是各自那一档精度**：这一份的输出会被 `lineSubtract`
 * **减到整行上**，而 `savgol` 那一份是它自己两端重算的一步。
 *
 * 登记在 `spec/deviations.md` 的 `D-LSQ-?`，让下一个人看得见「这里有两份、
 * 而且是故意的」；要合并，判据是**先有一格能分开它们的金样**。
 */
import { lstsqQr } from 'dsh-spm-numerics'

/**
 * `np.polyfit(x, y, deg)` —— 返回**降幂**系数（`[x^deg, …, x, 1]`）。
 *
 * ⚠️ **列缩放照抄**：numpy 先把范德蒙德的每一列除以它自己的 2-范数、解完再乘回来。
 * 那不是优化，是它给出的那个答案的一部分 —— 不缩放时同一份数据上系数会差几位，
 * 而这里的 `line_subtract` 会把这条线**减到整行上**。
 */
export function polyfit(x: Float64Array, y: Float64Array, deg: number): Float64Array {
  const n = deg + 1
  const m = x.length
  const cols: Float64Array[] = []
  const scale = new Float64Array(n)
  for (let j = 0; j < n; j += 1) {
    const pw = deg - j
    const col = new Float64Array(m)
    for (let i = 0; i < m; i += 1) col[i] = Math.pow(x[i] as number, pw)
    let s = 0
    for (let i = 0; i < m; i += 1) s += (col[i] as number) * (col[i] as number)
    s = Math.sqrt(s)
    scale[j] = s === 0 ? 1 : s
    for (let i = 0; i < m; i += 1) col[i] = (col[i] as number) / (scale[j] as number)
    cols.push(col)
  }
  const c = lstsqQr(cols, y)
  for (let j = 0; j < n; j += 1) c[j] = (c[j] as number) / (scale[j] as number)
  return c
}
