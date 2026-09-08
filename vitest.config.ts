import { defineConfig } from 'vitest/config'

// 两个 project。分开是因为代价与前置条件不同：
//   unit      纯函数与内核，零 I/O、零 dsh，秒级
//   contract  对**真实**的 @deepseek-ai/* 包断言签名与行为（spike 十条住这里）。
//             dsh 一升级就靠它变红，所以必须打真包、不能用替身
// integration（起真 stmsim、占真端口）等课时 1.4 有东西可跑时再加。
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/*/src/**/*.test.ts'] } },
      { test: { name: 'contract', include: ['packages/*/*/contract/**/*.test.ts'] } },
    ],
  },
})
