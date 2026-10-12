/**
 * K14 观测入档的接缝（决策 D12）。观察者是假的：这里钉的是**内核什么时候问它、
 * 把什么交给它、怎样把它的回答接进结局**；找文件与入档的那一半在
 * `dsh-spm-visual-memory` 的 `observe.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import { emptyHardwareState } from './hardware-state.js'
import {
  AbortRequestedError,
  BusyError,
  SkillKernel,
  TOOL_RETURN_CAP,
  observationText,
  type KernelDeps,
  type KernelRecord,
  type ObservedCall,
  type ObservedOutcome,
  type Skill,
  type SkillCallRecord,
  type SkillObservation,
  type SkillObserver,
  type SkillResultLike,
} from './skill-kernel.js'

const S0 = emptyHardwareState('T0')

function skill(over: Partial<Skill> = {}, category = 'write'): Skill {
  return {
    spec: { name: '_Act', description: '会动仪器的假技能', parameters: [], category, ...over.spec },
    execute: over.execute ?? ((): Promise<SkillResultLike> => Promise.resolve({ success: true, summary: '_Act: ok' })),
    ...(over.rollback === undefined ? {} : { rollback: over.rollback }),
  }
}

const FRAME: SkillObservation = {
  frames: [{ id: 't0001.s0', summary: { frame: 't0001.s0', turn: 1, kind: 'scan' } }],
  show: ['t0001.s0'],
  notArchived: [],
}

/** 记下每一次 begin / end 的假观察者。 */
function observer(answer: SkillObservation | null = FRAME): SkillObserver & {
  readonly calls: string[]
  readonly begun: ObservedCall[]
  readonly ended: { token: unknown; call: ObservedOutcome }[]
} {
  const calls: string[] = []
  const begun: ObservedCall[] = []
  const ended: { token: unknown; call: ObservedOutcome }[] = []
  return {
    calls,
    begun,
    ended,
    begin: (call) => {
      calls.push(`begin:${call.spec.name}`)
      begun.push(call)
      return Promise.resolve(`token:${call.spec.name}`)
    },
    end: (token, call) => {
      calls.push(`end:${call.spec.name}`)
      ended.push({ token, call })
      return Promise.resolve(answer)
    },
  }
}

function deps(over: Partial<KernelDeps> = {}): KernelDeps {
  return { snapshot: () => S0, clock: () => 1000, ...over }
}

describe('K14 · 没接观察者', () => {
  it('结局与文本一字不变，也没有 `observation` 这个键', async () => {
    const o = await new SkillKernel(deps()).run(skill(), {})
    expect(o.text).toBe('_Act: ok')
    expect('observation' in o).toBe(false)
  })
})

describe('K14 · 观察者的时序与入参', () => {
  it('执行之前 begin、组完文本之后 end；令牌原样交回；成败与数据也交过去', async () => {
    const obs = observer()
    const order: string[] = obs.calls
    const k = new SkillKernel(deps({ observer: obs }))
    const o = await k.run(
      skill({
        execute: () => {
          order.push('execute')
          return Promise.resolve({ success: true, summary: '_Act: ok', data: { detail: 'd' } })
        },
      }),
      {},
    )
    expect(order).toEqual(['begin:_Act', 'execute', 'end:_Act'])
    expect(obs.ended[0]?.token).toBe('token:_Act')
    expect(obs.ended[0]?.call).toMatchObject({ success: true, data: { detail: 'd' }, stateChanging: true })
    expect(o.kind).toBe('ok')
    expect(o.observation).toEqual(FRAME)
    expect(o.text).toBe(`_Act: ok\ndetail: d\nnew_frames: ${JSON.stringify([FRAME.frames[0]?.summary])}`)
  })

  it('交给观察者的是 K1 解析过的参数，以及**这次调用自己的**仪器出口（带同一道中止门）', async () => {
    const obs = observer()
    const seen: string[] = []
    const safeCall = (method: string): Promise<SkillCallRecord> => {
      seen.push(method)
      return Promise.resolve({ method, args: [], values: ['C:\\data'] })
    }
    await new SkillKernel(deps({ observer: obs, safeCall })).run(
      skill({ spec: { name: '_Act', description: '', parameters: [{ name: 'bias_v', type: 'float', unit: 'V' }] } }),
      { bias_v: '100m' },
    )
    expect(obs.begun[0]?.params).toEqual({ bias_v: 0.1 })
    expect((await obs.begun[0]?.safeCall('Util_SessionPathGet'))?.values).toEqual(['C:\\data'])
    expect(seen).toEqual(['Util_SessionPathGet'])
  })

  it('读与分析类技能交过去时 `stateChanging: false`；缺类别算会改变', async () => {
    const obs = observer(null)
    const k = new SkillKernel(deps({ observer: obs }))
    await k.run(skill({}, 'read'), {})
    await k.run(skill({}, 'analysis'), {})
    await k.run({ ...skill(), spec: { name: '_NoCat', description: '', parameters: [] } }, {})
    expect(obs.begun.map((c) => c.stateChanging)).toEqual([false, false, true])
  })

  it('**被闸门拒掉的调用不观察**：没执行，就没有它产生的文件', async () => {
    const obs = observer()
    const k = new SkillKernel(deps({ observer: obs, safetyGate: () => '[safety_gate] 不行' }))
    const o = await k.run(skill(), {})
    expect(o.kind).toBe('refused')
    expect(obs.calls).toEqual([])
    expect(o.observation).toBeUndefined()
  })

  it('**子步不观察**：组合技能的帧在它自己那一次 K14 里一并入档', async () => {
    const obs = observer()
    const child = skill({ spec: { name: '_Child', description: '', parameters: [] } })
    const parent = skill({
      spec: { name: '_Parent', description: '', parameters: [], category: 'composite' },
      execute: async (ctx) => {
        const r = await ctx.runSkill('_Child', {})
        return { success: r.success, summary: '_Parent: ok' }
      },
    })
    const k = new SkillKernel(deps({ observer: obs, skillByName: (n) => (n === '_Child' ? child : undefined) }))
    const o = await k.run(parent, {})
    expect(o.kind).toBe('ok')
    expect(obs.calls).toEqual(['begin:_Parent', 'end:_Parent'])
  })
})

describe('K14 · 失败与异常也观察', () => {
  it('技能报失败：文本是失败文本，后面接观测', async () => {
    const obs = observer()
    const o = await new SkillKernel(deps({ observer: obs })).run(
      skill({ execute: () => Promise.resolve({ success: false, error: 'scan stopped early' }) }),
      {},
    )
    expect(o.kind).toBe('failed')
    expect(obs.ended[0]?.call.success).toBe(false)
    expect(o.text.startsWith('[_Act] failed: scan stopped early\nnew_frames: ')).toBe(true)
  })

  it.each([
    ['中止', new AbortRequestedError('stop pressed'), 'aborted', '[_Act] aborted: stop pressed'],
    ['占用', new BusyError('lock held'), 'busy', '[_Act] busy: lock held'],
    ['崩溃', new Error('boom'), 'failed', '[_Act] failed: boom'],
  ])('执行中抛出（%s）：结局照旧，K14 照样跑——抛出之前可能已经存下了帧', async (_name, err, kind, text) => {
    const obs = observer()
    const o = await new SkillKernel(deps({ observer: obs })).run(skill({ execute: () => Promise.reject(err) }), {})
    expect(o.kind).toBe(kind)
    expect(obs.ended[0]?.call).toMatchObject({ success: false })
    expect(obs.ended[0]?.call.data).toBeUndefined()
    expect(o.text).toBe(`${text}${observationText(FRAME)}`)
    expect(o.observation).toEqual(FRAME)
  })

  it('回滚成功的崩溃：先回滚，再观察（回滚也可能让控制器存东西）', async () => {
    const obs = observer()
    const order = obs.calls
    const o = await new SkillKernel(deps({ observer: obs })).run(
      skill({
        execute: () => Promise.reject(new Error('boom')),
        rollback: () => {
          order.push('rollback')
          return Promise.resolve()
        },
      }),
      {},
    )
    expect(o.kind).toBe('rolled_back')
    expect(order).toEqual(['begin:_Act', 'rollback', 'end:_Act'])
  })
})

describe('K14 · 观察者自己出错', () => {
  it('end 抛了：结局不变，文本说出来（`observation_error`），不静默', async () => {
    const o = await new SkillKernel(
      deps({
        observer: {
          begin: () => Promise.resolve(undefined),
          end: () => Promise.reject(new Error('disk full')),
        },
      }),
    ).run(skill(), {})
    expect(o.kind).toBe('ok')
    expect(o.text).toBe('_Act: ok\nobservation_error: "disk full"')
    expect(o.observation).toEqual({ frames: [], show: [], notArchived: [], error: 'disk full' })
  })

  it('抛出的不是 Error 也照样说', async () => {
    const o = await new SkillKernel(
      deps({ observer: { begin: () => Promise.resolve(1), end: () => Promise.reject('plain') } }),
    ).run(skill(), {})
    expect(o.observation?.error).toBe('plain')
  })

  it('begin 抛了：令牌为空，end 照样被问', async () => {
    const ended: unknown[] = []
    const o = await new SkillKernel(
      deps({
        observer: {
          begin: () => Promise.reject(new Error('no dir')),
          end: (token) => {
            ended.push(token)
            return Promise.resolve(FRAME)
          },
        },
      }),
    ).run(skill(), {})
    expect(ended).toEqual([undefined])
    expect(o.observation).toEqual(FRAME)
  })

  it('观察者两头都出错，K9 的锁照样放（等观察者的那一段在 finally 里）', async () => {
    let released = 0
    const o = await new SkillKernel(
      deps({
        acquireLock: () => Promise.resolve(() => void (released += 1)),
        observer: { begin: () => Promise.reject(new Error('x')), end: () => Promise.reject(new Error('y')) },
      }),
    ).run(skill(), {})
    expect(o.kind).toBe('ok')
    expect(released).toBe(1)
  })

  it('end 回 `null`：这次没有可报的观测，文本一字不变', async () => {
    const o = await new SkillKernel(deps({ observer: observer(null) })).run(skill(), {})
    expect(o.text).toBe('_Act: ok')
    expect(o.observation).toBeUndefined()
  })
})

describe('K14 · 接进文本与记录', () => {
  it('**不受 2000 字上限截断**：帧编号是模型回看的唯一把手', async () => {
    const long = 'x'.repeat(TOOL_RETURN_CAP + 500)
    const o = await new SkillKernel(deps({ observer: observer() })).run(
      skill({ execute: () => Promise.resolve({ success: true, summary: long }) }),
      {},
    )
    expect(o.text.endsWith(observationText(FRAME))).toBe(true)
    expect(o.text.length).toBe(TOOL_RETURN_CAP + '\n…（已截断）'.length + observationText(FRAME).length)
  })

  it('K16 的记录里有观测（文本也是带着它的那一份）', async () => {
    const recs: KernelRecord[] = []
    await new SkillKernel(deps({ observer: observer(), record: (r) => recs.push(r) })).run(skill(), {})
    expect(recs[0]?.outcome.observation).toEqual(FRAME)
    expect(recs[0]?.outcome.text).toContain('new_frames: ')
  })
})

describe('observationText', () => {
  it('没有观测、或什么都没有可报的：空串', () => {
    expect(observationText(null)).toBe('')
    expect(observationText({ frames: [], show: [], notArchived: [] })).toBe('')
  })

  it('没有新帧时报最近的扫描帧（改变仪器状态的调用才带这个键）；`null` 也照报', () => {
    expect(observationText({ frames: [], show: [], latestFrame: 't0002.s0', notArchived: [] })).toBe(
      '\nlatest_frame: "t0002.s0"',
    )
    expect(observationText({ frames: [], show: [], latestFrame: null, notArchived: [] })).toBe('\nlatest_frame: null')
  })

  it('有新帧时只报新帧，不再报最近的那张；没入档的文件与观察者错误各占一行', () => {
    const text = observationText({
      ...FRAME,
      latestFrame: 't0000.s0',
      notArchived: [{ file: 'x.dat', error: 'cannot read spectra yet' }],
      error: 'partial',
    })
    expect(text.split('\n')).toEqual([
      '',
      `new_frames: ${JSON.stringify([FRAME.frames[0]?.summary])}`,
      'not_archived: [{"file":"x.dat","error":"cannot read spectra yet"}]',
      'observation_error: "partial"',
    ])
  })
})
