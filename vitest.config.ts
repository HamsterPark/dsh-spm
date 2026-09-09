import { defineConfig } from 'vitest/config'

// 两个 project。分开是因为代价与前置条件不同：
//   unit      纯函数与内核，零 I/O、零 dsh，秒级
//   contract  对**真实**的 @deepseek-ai/* 包断言签名与行为（spike 十条住这里）。
//             dsh 一升级就靠它变红，所以必须打真包、不能用替身
//   integration 起**真** stmsim、占真端口。1.7 起由 globalSetup 自动起停，不再手工设端口；
//                要跑得先给 STMSIM_PYTHON / STMSIM_ROOT，没给会**明确报错**而不是静默跳过。
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/*/src/**/*.test.ts'] } },
      { test: { name: 'contract', include: ['packages/*/*/contract/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['packages/*/*/integration/**/*.test.ts'],
          globalSetup: ['./vitest.stmsim-setup.ts'],
          fileParallelism: false, // 起停模拟器有开销，别让它们抢同一批端口
          testTimeout: 30_000,
        },
      },
    ],
  },
})
