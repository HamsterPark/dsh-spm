/**
 * `integration` project 的 globalSetup：整组测试前起一个 stmsim，跑完停掉。
 *
 * 在这之前（课时 1.4–1.6）集成测试要手工设 `STMSIM_PORT`，没设就整组跳过。
 * 1.7 有了 `StmsimProcess` 就不必了——**跳过的测试等于没有的测试**。
 *
 * 仍然可以跳过，但要**显式**：不设 `STMSIM_PYTHON` / `STMSIM_ROOT` 时本文件抛错并说清怎么配，
 * 而不是悄悄放行一组空跑的测试。CI 上这两个变量由 workflow 提供（`setup-python` + 钉住的
 * STM-Bench commit，PLAN §6.3）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StmsimProcess } from './packages/instrument/instrument-stmsim/src/process.js'

let sim: StmsimProcess | undefined

export async function setup(): Promise<void> {
  if (!process.env['STMSIM_PYTHON'] || !process.env['STMSIM_ROOT']) {
    throw new Error(
      'integration 需要真 stmsim。设这两个环境变量后重跑：\n' +
        '  STMSIM_PYTHON=C:\\path\\to\\python.exe\n' +
        '  STMSIM_ROOT=C:\\path\\to\\STM-Bench',
    )
  }
  sim = new StmsimProcess({
    // 端口与 profiles/mast-sim 一致，别和真机的 6501–6504 撞
    ports: [16501, 16502, 16503, 16504],
    // 当前 STM-Bench 公开配置；旧版或自定义配置须显式指定名称。
    profile: process.env['STMSIM_PROFILE'] ?? 'reference-stm',
    seed: 0,
    material: 'Au(111)',
    approached: true, // 起手就在隧道状态，否则读不到有意义的电流
    sessionDir: mkdtempSync(join(tmpdir(), 'stmsim-it-')),
  })
  await sim.start()
  process.env['STMSIM_PORT'] = '16501'
}

export async function teardown(): Promise<void> {
  await sim?.stop()
}
