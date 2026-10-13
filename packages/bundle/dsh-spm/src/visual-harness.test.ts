import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Context, SystemPrompt, ToolRuntime, type ToolExecution } from 'dsh-spm-compat'
import { ACT_GATE_REFUSAL, observationText, type SkillObservation } from 'dsh-spm-kernel'
import type { ViewToolValue } from 'dsh-spm-visual-memory'
import { afterEach, describe, expect, it } from 'vitest'
import type { MinimalResultRecord } from './minimal-persistence.js'
import {
  DurableActGate,
  VISUAL_ROOT_DEFAULT,
  formatObservedToolText,
  parseVisualHarness,
  prepareVisualHarness,
} from './visual-harness.js'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'visual-harness-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseVisualHarness：开关的配置', () => {
  it('缺席就是不挂', () => {
    expect(parseVisualHarness(undefined, false)).toBeUndefined()
    expect(parseVisualHarness(undefined, true)).toBeUndefined()
  })

  it('受管模式可以什么都不给：缺省目录、问仪器要保存目录、方格纸开', () => {
    expect(parseVisualHarness({}, false)).toEqual({ root: resolve(VISUAL_ROOT_DEFAULT), grid: true })
  })

  it('路径解析成绝对路径；grid 照给的来', () => {
    const s = parseVisualHarness({ root: 'vis', saveDir: 'save', grid: false }, true)
    expect(s).toEqual({ root: resolve('vis'), saveDir: resolve('save'), grid: false })
    expect(isAbsolute(s!.root) && isAbsolute(s!.saveDir!)).toBe(true)
  })

  it('本机模式没有 saveDir 就拒绝：白名单里没有保存目录查询', () => {
    expect(() => parseVisualHarness({ root: 'vis' }, true)).toThrow(
      /^visual_harness_config: 本机 Nanonis 模式必须给 saveDir/,
    )
  })

  it.each([
    [null, /visualHarness 必须是对象/],
    [true, /visualHarness 必须是对象/],
    [['root'], /visualHarness 必须是对象/],
    [{ save_dir: 'x' }, /不认识的键 save_dir；可用的键是 root, saveDir, grid/],
    [{ grid: 'yes' }, /grid 必须是 true 或 false/],
    [{ root: '' }, /root 必须是非空字符串/],
    [{ root: 3 }, /root 必须是非空字符串/],
    [{ saveDir: '  ' }, /saveDir 必须是非空字符串/],
  ])('配错直接拒绝，不静默挂成别的样子：%j', (value, message) => {
    expect(() => parseVisualHarness(value, false)).toThrow(message)
  })
})

describe('prepareVisualHarness：激活前的文件系统核验', () => {
  it('建出视觉记忆目录；保存目录存在且是目录才过', () => {
    const base = tempDir()
    const root = join(base, 'a', 'b')
    prepareVisualHarness({ root, saveDir: base, grid: true })
    expect(existsSync(root)).toBe(true)
    expect(() => prepareVisualHarness({ root, grid: true })).not.toThrow()
  })

  it('保存目录不存在、或者是个文件，都拒绝', () => {
    const base = tempDir()
    const file = join(base, 'not-a-dir')
    writeFileSync(file, 'x')
    expect(() => prepareVisualHarness({ root: base, saveDir: join(base, 'missing'), grid: true })).toThrow(
      /^visual_harness_config: saveDir .* 不存在$/,
    )
    expect(() => prepareVisualHarness({ root: base, saveDir: file, grid: true })).toThrow(/不是目录$/)
  })

  it('视觉记忆目录建不出来就拒绝', () => {
    const base = tempDir()
    const file = join(base, 'occupied')
    writeFileSync(file, 'x')
    expect(() => prepareVisualHarness({ root: join(file, 'inside'), grid: true })).toThrow(/^visual_harness_config: root .* 无法创建：/)
  })
})

const OBS: SkillObservation = {
  frames: [{ id: 't0001.s0', summary: { frame: 't0001.s0', source: 'scan001.sxm' } }],
  show: ['t0001.s0'],
  notArchived: [],
}

function record(skill: string, kind: string, kernelText: string, data: Record<string, unknown>, observation?: SkillObservation): MinimalResultRecord {
  return {
    version: 1, at: '2026-10-13T00:00:00.000Z', toolCallId: 'c1', skill, kind,
    text: kernelText + observationText(observation ?? null), data, instrumentCalls: [],
    ...(observation === undefined ? {} : { observation }),
  }
}

describe('formatObservedToolText：开关开着时的模型可见文本', () => {
  const images: ViewToolValue['images'] = [{ label: '<visual kind="current" frame="t0001.s0"/>', error: 'x' }]

  it('本机格式化只换内核那段文本：K14 的几行、presenter 的尾巴与图都留着', () => {
    const rec = record('GetBias', 'ok', '[GetBias] ok', { bias_v: 0.125 }, OBS)
    const tail = "\nimages_not_delivered: 1 (the session's model accepts text only)"
    const out = formatObservedToolText(rec, { text: rec.text + tail, images })
    expect(out.text).toBe(`GetBias: 0.125 V${observationText(OBS)}${tail}`)
    expect(out.text).toMatch(/^GetBias: 0\.125 V\nnew_frames: \[\{"frame":"t0001\.s0","source":"scan001\.sxm"\}\]\nimages_not_delivered: 1 /)
    expect(out.images).toBe(images)
  })

  it('没有观测时与不挂线束的本机文本一样', () => {
    const rec = record('StartScan', 'ok', '[StartScan] ok', { scan_running: true, verified: true })
    expect(formatObservedToolText(rec, { text: rec.text, images: [] })).toEqual({
      text: 'StartScan: running (readback verified)', images: [],
    })
  })

  it('没有本机格式（失败、未知技能、没有记录）时值原样返回', () => {
    const value = { text: '[SetBias] failed: x', images: [] }
    expect(formatObservedToolText(record('SetBias', 'failed', '[SetBias] failed: x', {}), value)).toBe(value)
    expect(formatObservedToolText(record('Mystery', 'ok', 'ok', {}), value)).toBe(value)
    expect(formatObservedToolText(undefined, value)).toBe(value)
  })

  it('值的文本不以记录文本开头时不猜尾巴', () => {
    const rec = record('GetBias', 'ok', '[GetBias] ok', { bias_v: 1 })
    expect(formatObservedToolText(rec, { text: 'something else', images: [] }).text).toBe('GetBias: 1 V')
  })
})

describe('DurableActGate：拒绝同时交给落盘回调', () => {
  it('放行不报；同一会话的第二个动作被拒并交出调用与原因', async () => {
    const ctx = new Context()
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    await new Promise<void>((r) => ctx.inject(['tools'], () => r()))
    const refusals: [string, string][] = []
    const gate = new DurableActGate(ctx, (exec, reason) => refusals.push([String(exec.rootCallId), reason]))
    gate.registerSkill({ name: 'SetBias', description: 'x', parameters: [], category: 'write' })
    const exec = (id: string) =>
      ({ name: 'SetBias', arguments: {}, rootCallId: id, agent: { id: 'session-a' } }) as unknown as ToolExecution
    expect(gate.check(exec('first'))).toBeUndefined()
    expect(gate.check(exec('second'))).toBe(ACT_GATE_REFUSAL)
    expect(refusals).toEqual([['second', ACT_GATE_REFUSAL]])
  })
})
