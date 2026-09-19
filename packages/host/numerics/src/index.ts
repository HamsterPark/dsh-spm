/**
 * 数值底座 —— 零 dsh 依赖、零 I/O、**零新 npm 依赖**。
 *
 * 它存在是因为剩下那 121 个分析类技能全卡在同一件事上：本仓没有数值层。
 * 而这一层的纪律只有一条，写在每个文件的抬头：
 *
 * > **先写下容差与它的理由，再写实现。** 反过来做，容差就会变成
 * > 「刚好让我这版通过的那个数」。
 *
 * 于是这里每一个函数的 docstring 都先回答三件事：对的是哪个 numpy/scipy 调用、
 * 容差是多少、**为什么是这个数**。理由要落在浮点或算法上（eps、累加次数、
 * 条件数、误差界），不落在「我试了试」。
 *
 * 有一批**没有容差**，因为它们不该有：`.npy` 读的是字节，连通域数的是整数，
 * `percentile` 是一个闭式，形态学与最近邻重采样只把输入里的数原样搬过来，
 * 亚像素互相关的答案恒为 `k/uf`。给它们一个容差等于把一次真的算错藏起来。
 *
 * 而这些零容差的档不只是「顺便严一点」——**它们替有容差的那些档报警**：
 * `order=0` 的重采样红过一次 0.93，而同一族的 `order=1` 当时只超差 1.09 倍，
 * 看着像「界推紧了」。真因是折叠算错了。详见 `interpolate.ts` 的抬头。
 */
export * from './mat.js'
export * from './stats.js'
export * from './rng.js'
export * from './pcg64.js'
export * from './pairwise.js'
export * from './filters.js'
export * from './morphology.js'
export * from './interpolate.js'
export * from './fft.js'
export * from './fit.js'
export * from './label.js'
export * from './npy-read.js'
export * from './curve-fit.js'
export * from './peaks.js'
export * from './correlate.js'
export * from './savgol.js'
// ── 批 6c：np.gradient(y, x) 与 np.trapezoid（Sader–Jarvis 的两件底座）──
export * from './calculus.js'
// ── 批 6b 的数值原语（收尾支线从 `vision/` 搬来，见该批交接 §7）──
export * from './ndfilters.js'
export * from './lsq.js'

// ── 批 7a-1（vision/tilt 一族 + AnalyzeFrameTilt + AutoTilt）在这一行下面加 export ──

// ── 批 7a-2（实验地图层 + FindCleanSpot）在这一行下面加 export ──

// ── 批 7a-3（kde_layers + FindFlatRegion + BiasWiggle）在这一行下面加 export ──
export * from './np-grid.js'
export * from './mt19937.js'
