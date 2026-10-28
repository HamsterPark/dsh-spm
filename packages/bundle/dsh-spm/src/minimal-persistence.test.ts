import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'dsh-spm-compat'
import { emptyHardwareState, SkillKernel, type KernelRecord } from 'dsh-spm-kernel'
import { RecordsService } from 'dsh-spm-stm-records'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GetBias, SetBias } from 'dsh-spm-stm-skills'
import { MinimalPersistence } from './minimal-persistence.js'
import { assertPersisted, formatMinimalToolText } from './minimal.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): { records: RecordsService; sink: MinimalPersistence; results: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spm-minimal-'))
  dirs.push(dir)
  const records = new RecordsService(new Context(), { path: join(dir, 'records.sqlite'), runId: 'r1' })
  const results = join(dir, 'results.jsonl')
  return { records, sink: new MinimalPersistence(records, results, 'r1'), results }
}

/** 一条内核记录；`depth` 为 0 是顶层调用，大于 0 是它里面 `runSkill` 起的子步。 */
function kernelRecord(
  spec: KernelRecord['spec'],
  depth: number,
  rootCallId: string,
  data: Readonly<Record<string, unknown>> = {},
): KernelRecord {
  return {
    spec,
    params: {},
    outcome: { kind: 'ok', signature: `ok:${spec.name}`, text: `${spec.name}: ok`, data, elapsedMs: 1, argsHash: `h${depth}` },
    approvalSource: 'llm',
    rootCallId,
    depth,
  }
}

describe('minimal runtime 持久证据', () => {
  it('同一调用 id 同时进入 SQLite 和 JSONL，JSONL 保留实际偏压', async () => {
    const { records, sink, results } = fixture()
    const kernel = new SkillKernel({
      snapshot: () => emptyHardwareState('T0'),
      safeCall: (method, ...args) => Promise.resolve({ method, args, values: [0.375] }),
      record: sink.record,
    })
    sink.begin('call-1')
    const outcome = await kernel.run(GetBias, {}, { rootCallId: 'call-1' })
    expect(outcome.kind).toBe('ok')
    expect(sink.finish('call-1')).toBe(true)

    const row = records.store.db
      .prepare('SELECT tool_call_id, action_type, status FROM actions')
      .get() as { tool_call_id: string; action_type: string; status: string }
    expect(row).toEqual({ tool_call_id: 'call-1', action_type: 'GetBias', status: 'succeeded' })
    const line = JSON.parse(readFileSync(results, 'utf8').trim()) as {
      toolCallId: string
      data: { bias_v: number }
    }
    expect(line).toMatchObject({ toolCallId: 'call-1', data: { bias_v: 0.375 } })
    expect(formatMinimalToolText(sink.takeResult('call-1'), outcome.text)).toBe('GetBias: 0.375 V')
    records.store.close()
  })

  it('SQLite 写失败时状态保持失败，工具包装层可以把成功改成可观察错误', () => {
    const { records, sink } = fixture()
    records.store.close()
    sink.begin('call-bad')
    sink.record({
      spec: GetBias.spec,
      params: {},
      outcome: {
        kind: 'ok',
        signature: 'ok:GetBias',
        text: 'GetBias: ok',
        data: { bias_v: 1 },
        elapsedMs: 1,
        argsHash: 'h',
      },
      approvalSource: 'llm',
      rootCallId: 'call-bad',
      depth: 0,
    } satisfies KernelRecord)
    expect(() => assertPersisted(sink, 'call-bad')).toThrow(/persistence_failed.*call-bad/)
  })

  it('一动一观拒掉的调用补一行 refused；写不进去时如实返回 false', () => {
    const { records, sink, results } = fixture()
    expect(sink.refused('call-r', 'SetBias', '[act_gate] refused')).toBe(true)
    expect(JSON.parse(readFileSync(results, 'utf8').trim())).toMatchObject({
      version: 1, toolCallId: 'call-r', skill: 'SetBias', kind: 'refused', text: '[act_gate] refused', instrumentCalls: [],
    })
    // 结果路径是一个目录：追加写必然失败
    const blocked = new MinimalPersistence(records, dirs[0]!, 'r1')
    expect(blocked.refused('call-x', 'SetBias', 'x')).toBe(false)
    records.store.close()
  })

  // 安全路径上的 SetBias 会在内部起子步（BiasSettleChange、SetBiasRamp），它们与顶层共用调用 id 且先完成。
  it('子步（depth ≥ 1）只进 SQLite；JSONL 与结果只留顶层那一行', () => {
    const { records, sink, results } = fixture()
    sink.begin('call-2')
    sink.record(kernelRecord(GetBias.spec, 1, 'call-2', { bias_v: 0.2 }))
    sink.record(kernelRecord(SetBias.spec, 0, 'call-2', { bias_v: -0.2 }))
    expect(() => assertPersisted(sink, 'call-2')).not.toThrow()

    const rows = records.store.db
      .prepare('SELECT action_type, tool_call_id, status FROM actions ORDER BY rowid').all()
    expect(rows).toEqual([
      { action_type: 'GetBias', tool_call_id: 'call-2', status: 'succeeded' },
      { action_type: 'SetBias', tool_call_id: 'call-2', status: 'succeeded' },
    ])
    const lines = readFileSync(results, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ toolCallId: 'call-2', skill: 'SetBias', data: { bias_v: -0.2 } })
    expect(sink.takeResult('call-2')).toMatchObject({ skill: 'SetBias', data: { bias_v: -0.2 } })
    records.store.close()
  })

  it('子步的 SQLite 写失败后，顶层成功也不能把这次调用的状态盖回成功', () => {
    const { records, sink } = fixture()
    vi.spyOn(records.store, 'record').mockReturnValueOnce(null) // 第一次（子步）写不进去，之后照常
    sink.begin('call-3')
    sink.record(kernelRecord(GetBias.spec, 1, 'call-3'))
    sink.record(kernelRecord(SetBias.spec, 0, 'call-3'))
    expect(() => assertPersisted(sink, 'call-3')).toThrow(/persistence_failed.*call-3/)
    records.store.close()
  })

  it('顶层的 JSONL 写不进去时状态为失败，也不留结果', () => {
    const { records } = fixture()
    // 结果路径是一个目录：追加写必然失败
    const blocked = new MinimalPersistence(records, dirs[0]!, 'r1')
    blocked.begin('call-4')
    blocked.record(kernelRecord(SetBias.spec, 0, 'call-4'))
    expect(() => assertPersisted(blocked, 'call-4')).toThrow(/persistence_failed.*call-4/)
    expect(blocked.takeResult('call-4')).toBeUndefined()
    records.store.close()
  })
})
