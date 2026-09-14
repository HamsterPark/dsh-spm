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
 * 有三件**没有容差**，因为它们不该有：`.npy` 读的是字节，连通域数的是整数，
 * `percentile` 是一个闭式。给它们一个容差等于把一次真的算错藏起来。
 */
export * from './mat.js'
export * from './stats.js'
export * from './rng.js'
export * from './filters.js'
export * from './fft.js'
export * from './fit.js'
export * from './label.js'
export * from './npy-read.js'
export * from './curve-fit.js'
