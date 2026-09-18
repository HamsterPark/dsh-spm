// 纯域核心：零 dsh 依赖、零 I/O（PLAN §6.1-2）。全部判据最终住在这里。
export * from './si.js'
export * from './comms-breaker.js'
export * from './hardware-state.js'
export * from './watchdog.js'
export * from './safety-tables.js'
export * from './safety.js'
export * from './sample-gate.js'
export * from './args-hash.js'
export * from './preconditions.js'
export * from './skill-kernel.js'
export * from './tool-schema.js'
export * from './tip-park.js'
export * from './graph-executor.js'
export * from './scan-reply.js'
export * from './scan-wait.js'
export * from './bias-ramp.js'
export * from './engage.js'
export * from './approach-refusal.js'
export * from './scan-policy.js'
export * from './scan-frame.js'
export * from './npy.js'
export * from './zctrl-preset.js'
export * from './readback.js'
export * from './crash-check.js'
export * from './lockin-preset.js'
export * from './phase-align.js'
export * from './script-allowlist.js'
export * from './piezo-reconcile.js'
export * from './qplus-amplitude.js'
// ── 批 3j（z_trace 判定机）在这一行下面 export ──
export * from './z-trace.js'
// ── 批 3k（真空互锁 / 温度源）在这一行下面 export ──

// ── 批 3l（spectroscopy 判定件）在这一行下面 export ──
export * from './spectroscopy.js'

// ── 批 4a（分析判定件）在这一行下面 export ──

// ── 批 4b（晶格判据底座 + 原子分辨判定一族）在这一行下面 export ──
export * from './imaging-window.js'

// ── 批 4c（paper 数据处理 + scan_frame 一族）在这一行下面 export ──
export * from './scan-regions.js'
export * from './image-channel.js'

// ── 批 4d（composite.scan_at + 撞针追踪）在这一行下面 export ──

// ── 批 5a（针尖登记表底座 + TipPulse/TipShape + 两个 fail-open 自检）在这一行下面 export ──
export * from './tip-registry.js'
export * from './tip-conditioning-policy.js'
export * from './tip-conditioning-resolver.js'

// ── 批 5b（A 档零散一批（各自自足，不压子系统））在这一行下面 export ──

// ── 批 5c（仪器档案 + Z 稳定 + 粗动驱动三个子系统）在这一行下面 export ──
export * from './instrument-profile.js'
export * from './coarse-drive.js'
export * from './z-settle.js'
export * from './tip-evidence.js'
export * from './scan-resolver.js'
export * from './tip-crash-tracker.js'
export * from './corrugation-gate.js'
export * from './scan-prep-thresholds.js'
export * from './vacuum-interlock.js'
export * from './temperature.js'
