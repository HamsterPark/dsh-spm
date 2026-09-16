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
 * | 格式 | 数据比头声明的短时 |
 * |---|---|
 * | `.sxm` | **丢掉那一帧**（少一个通道，其余照常） |
 * | `.3ds` | **尾部像素补零**（保持 `(ny, nx, n_points)` 形状契约） |
 * | `.npy` | **抛**（D-NUM-4，在 numerics 包里） |
 *
 * 三条都照旧仓移过来了。其中 `.3ds` 那条最危险：补出来的零是一片「谱强度
 * 恒为零」的区域，在自动流程里看起来像一块真实的、干净的样品。见
 * `docs/handoff/nanonis-files.md`。
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
