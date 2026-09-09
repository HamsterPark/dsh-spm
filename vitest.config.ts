import { defineConfig } from 'vitest/config'

// 两个 project。分开是因为代价与前置条件不同：
//   unit      纯函数与内核，零 I/O、零 dsh，秒级
//   contract  对**真实**的 @deepseek-ai/* 包断言签名与行为（spike 十条住这里）。
//             dsh 一升级就靠它变红，所以必须打真包、不能用替身
//   integration 起**真** stmsim、占真端口。默认跳过（需 STMSIM_PORT），1.7 的
//                instrument-stmsim provider 会把起停做成 globalSetup，那时改成无条件跑。
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/*/src/**/*.test.ts'] } },
      { test: { name: 'contract', include: ['packages/*/*/contract/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['packages/*/*/integration/**/*.test.ts'],
          fileParallelism: false, // 起停模拟器有开销，别让它们抢同一批端口
          testTimeout: 30_000,
        },
      },
    ],
  },
})
