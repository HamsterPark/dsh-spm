import { join, resolve } from 'node:path'
import { VISUAL_TOOL_NAMES } from 'dsh-spm-visual-memory'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_TOOLS,
  NATIVE_VISUAL_TOOLS,
  nativeToolCatalog,
  parseNativeSessionArgs,
  recordedCalls,
  runtimeConfigRow,
} from '../../../../scripts/native-session.ts'
import { NATIVE_TOOL_NAMES } from '../src/minimal.js'

const BASE = ['--install-dir', 'inst', '--dsh-home', 'home', '--pid', '42']

describe('本机启动器的 --visual', () => {
  it('视觉工具名单与视觉记忆包一致；关着时目录就是原来那八个', () => {
    expect(NATIVE_VISUAL_TOOLS).toEqual([...VISUAL_TOOL_NAMES])
    expect(nativeToolCatalog(false)).toEqual(NATIVE_TOOLS)
    expect(NATIVE_TOOLS).toEqual(['GetBias', 'GetCurrent', 'GetScanStatus', 'GetZPosition', 'SetBias', 'StartScan', 'StopScan', 'stm_hello'])
    expect(nativeToolCatalog(true)).toEqual(['stm_hello', ...NATIVE_TOOL_NAMES, ...VISUAL_TOOL_NAMES].sort())
  })

  it('关着时运行栈那一行与原来逐字相同；开着时多出 visualHarness', () => {
    const paths = { recordsPath: 'D:/r/actions.sqlite', resultsPath: 'D:/r/results.jsonl', runId: 'native-1' }
    const off = runtimeConfigRow({ pid: 42, ports: [6501, 6502, 6503, 6504] }, paths)
    expect(off).toBe(
      '- id: mast-minimal-runtime\n  config:\n    nativeSimulator:\n      pid: 42\n      ports: [6501, 6502, 6503, 6504]\n' +
      '    recordsPath: "D:/r/actions.sqlite"\n    resultsPath: "D:/r/results.jsonl"\n    runId: "native-1"',
    )
    const on = runtimeConfigRow({ pid: 42, ports: [6501, 6502, 6503, 6504], visual: { root: 'D:/v', saveDir: 'D:/save' } }, paths)
    expect(on).toBe(`${off}\n    visualHarness:\n      root: "D:/v"\n      saveDir: "D:/save"`)
  })

  it('持久记录核对：关着时除 stm_hello 外全算（目录外的名字也算），开着时视觉工具除外', () => {
    const calls = ['GetBias', 'stm_hello', 'stm_inspect', 'Unknown'].map((name) => ({ name }))
    expect(recordedCalls(calls, false).map((c) => c.name)).toEqual(['GetBias', 'stm_inspect', 'Unknown'])
    expect(recordedCalls(calls, true).map((c) => c.name)).toEqual(['GetBias', 'Unknown'])
  })

  it('--visual 必须带 --save-dir；目录参数没有 --visual 时报错；--visual-root 缺省在 DSH_HOME 下', () => {
    expect(parseNativeSessionArgs(BASE)?.visual).toBeUndefined()
    expect(() => parseNativeSessionArgs([...BASE, '--visual'])).toThrow(/--visual 需要 --save-dir/)
    expect(() => parseNativeSessionArgs([...BASE, '--save-dir', 'save'])).toThrow(/只在 --visual 时有效/)
    expect(() => parseNativeSessionArgs([...BASE, '--visual-root', 'v'])).toThrow(/只在 --visual 时有效/)
    expect(parseNativeSessionArgs([...BASE, '--visual', '--save-dir', 'save'])?.visual).toEqual({
      saveDir: resolve('save'), root: resolve(join('home', 'visual-memory')),
    })
    expect(parseNativeSessionArgs([...BASE, '--visual', '--save-dir', 'save', '--visual-root', 'v'])?.visual).toEqual({
      saveDir: resolve('save'), root: resolve('v'),
    })
  })
})
