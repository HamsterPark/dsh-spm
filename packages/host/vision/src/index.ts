/**
 * 分析判定件 —— 旧仓 `mast/vision/` 与几个技能文件里那些**纯判据**，
 * 零 dsh 依赖、零 I/O。
 *
 * ## 这一层为什么单独成包，而不是塞进 `kernel`
 *
 * `kernel` 是零依赖的纯域核心，而 `numerics` **依赖 kernel**（`pySum` 住在
 * `si.ts`）。所以 kernel 用不了 numerics —— 一个需要 `labelConnected` / `fft` /
 * `histogram` 的判据放进 kernel，只能靠**再写一份**，而那正是本仓
 * 「十份 `cell()`」那一课要避免的东西。
 *
 * 先例现成：`nanonis-files` 也因为同时要 kernel 与 numerics 而单独成包，
 * 它的抬头写着为什么 ——「数值层的判据是**浮点**，那一层的判据是**字节**，
 * 混在一起两套判据会互相稀释」。这里同理：这一层的判据是**几何与形状**
 * （掩膜、连通域、轴比、角度），它们的容差大多是 **0**，而把它们混进
 * 有容差的那一层，零容差那一档就会被稀释掉 —— 而零容差那一档正是替有容差的
 * 那些档报警的人（`numerics-2.md` 第五节第一条）。
 *
 * 真正留在 `kernel` 的是**零 numpy** 的那两件：起伏门 `corrugation-gate.ts`
 * 与它的阈值表 `scan-prep-thresholds.ts`。
 *
 * ## 这一层的纪律与 numerics 同一条
 *
 * > **先写下容差与它的理由，再写实现。**
 *
 * 而且这一层**大多数件的容差是 0**：掩膜、连通域标签、计数、下标、行程 ——
 * 全是整数与搬运。给它们容差等于把一次「挑错了元素」藏起来，
 * 而挑错元素正是这一族唯一会犯的错。
 */
export * from './nd.js'
export * from './golden.js'
export * from './xy-meta.js'
export * from './plane.js'
export * from './frame-validity.js'
export * from './roundness.js'
export * from './cluster.js'
export * from './row-jump.js'
export * from './step-levels.js'
export * from './step-edge.js'
export * from './atomic-lines.js'
export * from './scan-artifacts.js'
// ── 批 4b：晶格判据底座 + 原子分辨判定一族 ──
export * from './lattice-peaks.js'
export * from './lattice-cell.js'
export * from './frame-texture.js'
export * from './seg-texture.js'
export * from './tip-metrics.js'
export * from './atomic-phase.js'
// ── 批 6b：vision 的 scan_prep 链 ──
export * from './lsq.js'
export * from './tip-change.js'
export * from './scan-prep.js'
// ── 批 7a-1（vision/tilt 一族 + AnalyzeFrameTilt + AutoTilt）在这一行下面加 export ──
export * from './tilt-frame.js'
export * from './tilt-circle.js'

// ── 批 7a-2（实验地图层 + FindCleanSpot）在这一行下面加 export ──

// ── 批 7a-3（kde_layers + FindFlatRegion + BiasWiggle）在这一行下面加 export ──
export * from './seg-scale-adaptive.js'

// ── 批 6c 的四件判据本体（收尾支线从 `stm-skills/src/l0/` 搬来）──
// `tip-metrics.js` 上面已经导出过了 —— 那两件并进了它。
export * from './spectroscopy.js'
export * from './force-inversion.js'
export * from './lattice-multiframe.js'

// ── 批 7b-1（封锁账闭包化 + AssessAtomicPhase + 两条已解封锁的流程）在这一行下面加 export ──

// ── 批 7b-2（势垒链与线缆（8 个技能 / 7 个模块））在这一行下面加 export ──

// ── 批 7b-3（composite 零新原语五个 + paper 四个纯函数）在这一行下面加 export ──

// ── 批 8a-1（写侧 record_damage_marker + 贵金属链三条流程 + AssessShockleyOnset）在这一行下面加 export ──

// ── 批 8a-2（builtins 剩余 A 档：自检 / 对账 / 漂移一族）在这一行下面加 export ──

// ── 批 8a-3（paper 第二批：CheckLineQuality · Bragg 漂移 · 谱拟合 · montage 判据层）在这一行下面加 export ──
