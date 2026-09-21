import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'dsh-spm-compat'
import { emptyHardwareState, SkillKernel, type KernelRecord } from 'dsh-spm-kernel'
import { RecordsService } from 'dsh-spm-stm-records'
import { afterEach, describe, expect, it } from 'vitest'
import { GetBias } from 'dsh-spm-stm-skills'
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
})
