import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// **工作区包别名到源码**，不走 `lib/`。
//
// 两个理由，第二个是被咬过的：
// 1. 覆盖率要诚实 —— 跨包测试走 `lib/` 时，被它们覆盖到的 `src/` 行会显示成未覆盖，
//    于是内核看起来比实际差一大截（`implausibleReadings` 明明被 `GetZCtrlGain` 用着）。
// 2. **测的必须是刚改的那份代码**。2026-09-10 的变异演练里踩过：还原源码用 `mv`，
//    旧 mtime 跟着回来，`tsc -b` 跳过重建，于是 `lib/` 还是变异版而源码是干净的 ——
//    同包测试没事（vitest 转译 `src`），跨包测试莫名其妙地红。别名之后这一类整个消失。
//
// `@deepseek-ai/*` 不在此列：契约测试要的正是**真包**。
const WORKSPACE_ALIAS = {
  'dsh-spm': fileURLToPath(new URL('./packages/bundle/dsh-spm/src/index.ts', import.meta.url)),
  'dsh-spm-compat': fileURLToPath(new URL('./packages/host/compat/src/index.ts', import.meta.url)),
  'dsh-spm-instrument': fileURLToPath(new URL('./packages/instrument/instrument/src/index.ts', import.meta.url)),
  'dsh-spm-instrument-state': fileURLToPath(new URL('./packages/instrument/instrument-state/src/index.ts', import.meta.url)),
  'dsh-spm-instrument-stmsim': fileURLToPath(new URL('./packages/instrument/instrument-stmsim/src/index.ts', import.meta.url)),
  'dsh-spm-instrument-watchdog': fileURLToPath(new URL('./packages/instrument/instrument-watchdog/src/index.ts', import.meta.url)),
  'dsh-spm-kernel': fileURLToPath(new URL('./packages/host/kernel/src/index.ts', import.meta.url)),
  'dsh-spm-nanonis-files': fileURLToPath(new URL('./packages/host/nanonis-files/src/index.ts', import.meta.url)),
  'dsh-spm-nanonis-wire': fileURLToPath(new URL('./packages/instrument/nanonis-wire/src/index.ts', import.meta.url)),
  'dsh-spm-numerics': fileURLToPath(new URL('./packages/host/numerics/src/index.ts', import.meta.url)),
  'dsh-spm-vision': fileURLToPath(new URL('./packages/host/vision/src/index.ts', import.meta.url)),
  'dsh-spm-stm-records': fileURLToPath(new URL('./packages/host/stm-records/src/index.ts', import.meta.url)),
  'dsh-spm-stm-safety': fileURLToPath(new URL('./packages/host/stm-safety/src/index.ts', import.meta.url)),
  'dsh-spm-stm-skills': fileURLToPath(new URL('./packages/host/stm-skills/src/index.ts', import.meta.url)),
  'dsh-spm-stm-ui': fileURLToPath(new URL('./packages/client/stm-ui/src/index.ts', import.meta.url)),
}


// 变异演练**默认不跑**：每条要重新 `tsc -b` 一次，全跑一趟约 45 秒，
// 而日常回路要秒级。它是 Phase 2 的**完成判据**，不是每次提交的检查。
//
//     MUTATE=1 pnpm vitest run --project mutation
//
// 写成条件加入而不是空 include：空 include 的 project 会以「没找到测试文件」
// 报错，那等于把「没开」和「坏了」混成同一种输出。
const MUTATION_PROJECTS =
  process.env['MUTATE'] === '1'
    ? [
        {
          test: {
            name: 'mutation',
            include: ['tools/mutate/meta/**/*.test.ts'],
            fileParallelism: false, // 它们改同一批源文件，绝不能并行
            testTimeout: 120_000,
            hookTimeout: 120_000,
          },
        },
      ]
    : []

// 四个 project。分开是因为代价与前置条件不同：
//   unit      纯函数与内核，零 I/O、零 dsh，秒级
//   contract  对**真实**的 @deepseek-ai/* 包断言签名与行为（spike 十条住这里）。
//             dsh 一升级就靠它变红，所以必须打真包、不能用替身
//   integration 起**真** stmsim、占真端口。1.7 起由 globalSetup 自动起停，不再手工设端口；
//                要跑得先给 STMSIM_PYTHON / STMSIM_ROOT，没给会**明确报错**而不是静默跳过。

// ── 覆盖率门禁（PLAN §6.3）──────────────────────────────────────────────
//
// 分层的理由是**代价不同**：kernel 里一个没测到的分支是一次物理风险，
// 而一个 UI 组件的没测到是一次难看。
//
// ⚠️ **kernel 的 DoD 目标是逐文件 100%，当前没到**（见 docs/EXECUTION.md 的
// 「覆盖率现状」一节，逐行列着还差哪些）。这里的数字是**当前实测的地板**，
// 它的职责是**防倒退**，不是宣布达标 —— 两者混为一谈，就又变成
// 「看起来验过了」。数字只许往上调。
const COVERAGE_THRESHOLDS = {
  'packages/host/kernel/src/**': {
    statements: 97, branches: 91, functions: 99, lines: 98,
  },
  'packages/host/stm-skills/src/**': {
    statements: 90, branches: 80, functions: 90, lines: 90,
  },
  'packages/host/stm-records/src/**': {
    statements: 90, branches: 80, functions: 90, lines: 90,
  },
}

export default defineConfig({
  resolve: { alias: WORKSPACE_ALIAS },
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/generated/**'],
      reporter: ['text', 'json-summary'],
      thresholds: COVERAGE_THRESHOLDS,
    },
    projects: [
      {
        resolve: { alias: WORKSPACE_ALIAS },
        test: {
          name: 'unit',
          include: ['packages/*/*/src/**/*.test.ts'],
          // 缺省 5 s 在**裸跑**时绰绰有余（全仓 5700+ 条 15 秒跑完），
          // 但 `--coverage` 的插桩会把最重的那几条金样驱动测试拖到 6 s 以上
          // （2026-09-19：批 4b 的 lattice 那条实测 6.35 s）。
          //
          // 写成显式的 20 s 而不是让人记得加 `--testTimeout`：
          // **一个要靠人记得加的参数，等于没有这个参数**。
          // 20 s 仍然能把「真的挂住了」照出来 —— 那一类是分钟级，不是秒级。
          testTimeout: 20_000,
        },
      },
      { resolve: { alias: WORKSPACE_ALIAS }, test: { name: 'contract', include: ['packages/*/*/contract/**/*.test.ts'] } },
      {
        resolve: { alias: WORKSPACE_ALIAS },
        test: {
          name: 'integration',
          include: ['packages/*/*/integration/**/*.test.ts'],
          globalSetup: ['./vitest.stmsim-setup.ts'],
          fileParallelism: false, // 起停模拟器有开销，别让它们抢同一批端口
          testTimeout: 30_000,
        },
      },
      ...MUTATION_PROJECTS,
    ],
  },
})
