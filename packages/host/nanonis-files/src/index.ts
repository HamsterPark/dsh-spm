/**
 * Nanonis 文件读取 —— `.sxm` / `.dat` / `.3ds`，**零 I/O、零 dsh 依赖**。
 *
 * ## 这一层为什么单独成包
 *
 * 剩下那批「读一张扫描图再判断点什么」的技能全卡在这三种格式上，而它们与
 * 数值层的性质不同：数值层的判据是**浮点**（容差、累加序、ULP），这一层的
 * 判据是**字节**（偏移、字节序、标记位置）。混在一起，两套判据会互相稀释。
 *
 * ## 金样是怎么来的：字节我们合成，**读法归旧仓**
 *
 * 真机文件不进本仓（用户已同意只用合成数据）。于是
 * `tools/spec-export/export_nanonis_files.py` 先**合成**一份字节，再交给
 * **旧仓真实的 `mast.io.nanonis_files`** 去读，把 `bytes_b64` 与读出来的东西
 * 一起钉进 `spec/golden/nanonis_files.json`。
 *
 * 这一步的顺序是要紧的：如果字节和读法都由我写，那我对格式的**同一个误解**
 * 会同时进到写的一端和读的一端，两边严丝合缝地对上，测试全绿而东西是错的。
 * 让旧仓当读的那一端，误解就暴露成一次读失败。
 *
 * ## 三种格式，三种截断策略 —— 不是疏忽
 *
 * | 格式 | 数据比头声明的短时 | 截断在这里意味着 |
 * |---|---|---|
 * | `.sxm` | **丢掉那一帧**（少一个通道，其余照常） | 写到一半停了，已写的那些帧仍然是好的 |
 * | `.3ds` | **没写进来的像素填 NaN**，外加 `pixels_written` / `pixels_missing` | 网格是逐像素**增量写**的 ⇒ **操作员按了停**，那是正常操作 |
 * | `.npy` | **抛**（D-NUM-4，在 numerics 包里） | 帧是**一次性写完**的 ⇒ 文件坏了 |
 *
 * `.sxm` 与 `.npy` 两条照旧仓移；`.3ds` 那条**本仓刻意与旧仓不同**（D-3DS-1）：
 * 旧仓补 **0**，而**一条恒为零的谱不是「没有数据」，它长得像一块干净的样品** ——
 * 形状对、dtype 对、值是合法浮点，**没有任何外部可见的信号**。
 *
 * 但**不抛**，与 `.npy` 那条相反 —— 上表第三列就是理由：一次被中断的网格仍然是
 * 有价值的数据，抛掉它等于让一次合法的中断变成读不出。所以已写的照常给、
 * 没写的给 NaN，外加两个**读得到的数**。
 *
 * 详见 `threeds.ts` 抬头与 `spec/deviations.md` 的 D-3DS-1。
 */
export {
  MAX_FILE_BYTES,
  MAX_GRID_ELEMENTS,
  assertReadableSize,
  decodeHeaderText,
  firstFloat,
  indexOfBytes,
  pyFloat,
  readBigEndianFloat32,
} from './common.js'
export type { SxmChannel, SxmHeader, SxmScan, OrientedFrames } from './sxm.js'
export {
  parseSxmHeader,
  readSxm,
  readSxmHeaderOnly,
  rowsTopFirst,
  sxmFrameMeta,
  sxmOrientedFrames,
} from './sxm.js'
export type { DatFile } from './dat.js'
export { readDat } from './dat.js'
export type { ThreeDsFile, ThreeDsHeader } from './threeds.js'
export { parse3dsHeader, read3ds } from './threeds.js'
