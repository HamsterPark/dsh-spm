/**
 * `ctx.stmRecords` 的契约测试——对着**真的 Cordis 上下文**，不是我对它的印象。
 */
import { Context } from 'dsh-spm-compat'
import { SkillKernel, emptyHardwareState, type Skill } from 'dsh-spm-kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { auditClaim } from './claim-audit.js'
import * as records from './plugin.js'
import { UNSCOPED } from './store.js'

const S0 = emptyHardwareState('T0')

const probe = (over: Partial<Skill> = {}): Skill => ({
  spec: {
    name: '_Probe',
    description: '内核探针',
    parameters: [{ name: 'setpoint_a', type: 'float', unit: 'A', required: true }],
  },
  execute: over.execute ?? ((): Promise<{ success: boolean; summary: string }> =>
    Promise.resolve({ success: true, summary: 'ok' })),
})

let ctx: Context | undefined
afterEach(() => {
  // 生命周期粒度是**插件**，不是上下文：卸载插件才会跑 `ctx.effect` 的回滚
  if (ctx !== undefined) ctx.registry.delete(records)
  ctx = undefined
})

/** 装上插件，等它的服务真的挂到上下文上。 */
function host(config: records.Config = {}): Promise<Context> {
  const c = new Context()
  ctx = c
  c.plugin(records, config)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ctx.stmRecords 没挂上')), 2_000)
    c.inject(['stmRecords'], () => {
      clearTimeout(timer)
      resolve(c)
    })
  })
}

describe('装载与卸载', () => {
  it('装上就有 ctx.stmRecords，卸载后库被关掉', async () => {
    const c = await host()
    const svc = c.stmRecords
    expect(svc).toBeDefined()
    expect(svc.record({ skill: 'A', params: {}, kind: 'ok' })).not.toBeNull()
    // **卸载是异步的**：不 await 的话回滚还没跑完，测试就去看结果了 ——
    // 那样这条测试会在「库其实没关」的时候照样绿。
    await c.registry.delete(records)
    ctx = undefined
    // 关掉之后再写只会拿到 null（record 永不抛），不是一个还在偷偷写的句柄
    expect(svc.record({ skill: 'B', params: {}, kind: 'ok' })).toBeNull()
  })
})

describe('接到内核的 record 上：每一个结局都落一行', () => {
  it('成功、被拒、异常各一行，被拒的那条落在 _unscoped', async () => {
    const c = await host()
    const kernel = new SkillKernel({
      snapshot: () => S0,
      sampleGate: (s) => (s.name === '_Probe' ? null : '没有样品'),
      record: c.stmRecords.fromKernel,
    })
    await kernel.run(probe(), { setpoint_a: '1p' })
    await kernel.run(probe(), { setpoint_a: '不是数' })
    await kernel.run(
      probe({ execute: (): Promise<never> => Promise.reject(new Error('boom')) }),
      { setpoint_a: '1p' },
    )

    const rows = c.stmRecords.store.db
      .prepare('SELECT action_type, status, error, experiment_id FROM actions ORDER BY hlc')
      .all() as { action_type: string; status: string; error: string | null; experiment_id: string }[]
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.status)).toEqual(['succeeded', 'failed', 'failed'])
    expect(rows[1]?.error).toContain('precondition_failed')
    expect(rows.every((r) => r.experiment_id === UNSCOPED)).toBe(true)
  })

  it('账本跟着填 —— 于是 claimAudit 有东西可比', async () => {
    const c = await host({ runId: 'run-7' })
    const kernel = new SkillKernel({ snapshot: () => S0, record: c.stmRecords.fromKernel })
    await kernel.run(probe(), { setpoint_a: '1p' })
    expect(c.stmRecords.runEntry()).toEqual({ skills: ['_Probe'], artifacts: [] })

    // 2026-07-27 那条消息，对着一个**真跑过技能**的账本：不再是「零技能」那一条
    const good = auditClaim('STS spectra acquired', {
      executedSkills: c.stmRecords.runEntry()?.skills,
      pathExists: () => false,
    })
    expect(good.unsupported_completion).toBe(false)
  })

  it('**一次技能都没跑的运行**：声明「已完成测量」当场被记录反驳', async () => {
    const c = await host({ runId: 'run-8' })
    // 账本里这一轮是存在的（有过调用），但技能名为空 ⇒ skills 是空数组
    c.stmRecords.store.ledger.note('run-8', '', true)
    const verdict = auditClaim(
      '[HANDOFF → data_processing] 5-point STS grid acquired。',
      { executedSkills: c.stmRecords.runEntry('run-8')?.skills, pathExists: () => false },
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toContain('消息声称已完成测量，但本次运行没有任何技能被调用')
  })

  it('**没有这一轮的账本时不下判** —— 「不知道」不是「没发生」的证据', async () => {
    const c = await host({ runId: 'run-9' })
    expect(c.stmRecords.runEntry('从没有过的一轮')).toBeUndefined()
    const verdict = auditClaim('STS spectra acquired', {
      executedSkills: c.stmRecords.runEntry('从没有过的一轮')?.skills,
      pathExists: () => false,
    })
    expect(verdict.ok).toBe(true)
  })

  it('approvalSource 从内核一路传到 approvals 表', async () => {
    const c = await host()
    const kernel = new SkillKernel({ snapshot: () => S0, record: c.stmRecords.fromKernel })
    await kernel.run(probe(), { setpoint_a: '1p' }, { approvalSource: 'human' })
    const id = (
      c.stmRecords.store.db.prepare('SELECT id FROM actions').get() as { id: string }
    ).id
    expect(c.stmRecords.store.approvalSourceOf(id)).toBe('human')
  })
})
