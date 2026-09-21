import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Service, SystemPrompt, ToolRuntime } from 'dsh-spm-compat'
import { StmsimProcess } from 'dsh-spm-instrument-stmsim'
import { RecordStore } from 'dsh-spm-stm-records'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as minimal from './minimal.js'

afterEach(() => vi.restoreAllMocks())

class TestCommands extends Service {
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(): () => void { return () => {} }
}

describe('minimum runtime shutdown', () => {
  it('keeps SQLite open until an in-flight tool writes its record during Cordis parallel disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minimal-drain-'))
    const dbPath = join(dir, 'records.sqlite')
    // This test checks shutdown ordering against a real on-disk database. Build
    // its canonical empty schema in one transaction so slow runner disks do not
    // spend the shutdown test's budget on 99 independent DDL commits.
    const schemaDb = new DatabaseSync(dbPath)
    try {
      schemaDb.exec('BEGIN')
      schemaDb.exec(readFileSync(new URL('../../../../spec/golden/records_schema.sql', import.meta.url), 'utf8'))
      schemaDb.exec('COMMIT')
    } finally { schemaDb.close() }
    vi.spyOn(StmsimProcess.prototype, 'start').mockResolvedValue()
    vi.spyOn(StmsimProcess.prototype, 'assertOwned').mockResolvedValue()
    vi.spyOn(StmsimProcess.prototype, 'stop').mockResolvedValue()
    vi.spyOn(StmsimProcess.prototype, 'running', 'get').mockReturnValue(true)
    let release!: () => void
    let entered!: () => void
    const callEntered = new Promise<void>((r) => { entered = r })
    const callGate = new Promise<void>((r) => { release = r })
    vi.spyOn(minimal.ManagedSimulatorInstrument.prototype, 'call').mockImplementation(async (method) => {
      entered()
      await callGate
      return { method, command: 'Bias.Get', role: 'main', args: [], values: [0.625], elapsedMs: 1, at: Date.now(), simulated: true }
    })
    const ctx = new Context()
    new TestCommands(ctx)
    const prompt = ctx.plugin(SystemPrompt)
    await prompt.await()
    const tools = ctx.plugin(ToolRuntime)
    await tools.await()
    const runtime = ctx.plugin(minimal, { recordsPath: dbPath, resultsPath: join(dir, 'results.jsonl'), stateIntervalMs: 0, watchdogIntervalMs: 0 })
    try {
      await runtime.await()
      const close = vi.spyOn(RecordStore.prototype, 'close')
      let disposalEntered!: () => void
      const disposalStarted = new Promise<void>((r) => { disposalEntered = r })
      runtime.ctx.effect(() => () => { disposalEntered() })
      const callId = 'during-unload' as Parameters<typeof ctx.tools.execute>[0]['callId']
      const call = ctx.tools.execute({ callId, name: 'GetBias', arguments: {}, signal: new AbortController().signal })
      await callEntered
      const disposing = runtime.dispose()
      await disposalStarted
      expect(close).not.toHaveBeenCalled()
      release()
      const result = await call
      expect(result.isError).toBe(false)
      await disposing
      expect(close).toHaveBeenCalledTimes(1)
      const record = JSON.parse(readFileSync(join(dir, 'results.jsonl'), 'utf8').trim())
      expect(record.toolCallId).toBe('during-unload')
      expect(record.instrumentCalls).toHaveLength(1)
      expect(record.instrumentCalls[0]).toMatchObject({ method: 'Bias_Get', command: 'Bias.Get', role: 'main', values: [0.625] })
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        expect(db.prepare('SELECT tool_call_id, status FROM actions').all()).toEqual([{ tool_call_id: 'during-unload', status: 'succeeded' }])
      } finally { db.close() }
    } finally {
      release()
      await runtime.dispose()
      await tools.dispose()
      await prompt.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
