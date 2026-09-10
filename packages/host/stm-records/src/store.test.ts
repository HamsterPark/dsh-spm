/**
 * 记录库的判据，三条：
 * 1. **建表与金样一致**（金样是旧仓真实的 `ALL_DDL`）；
 * 2. **被拒的调用也记**；
 * 3. **`approval_source` 落库**且读得回来。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { RECORDS_DDL } from './generated/schema.js'
import { HlcClock, ulid } from './ids.js'
import { RunLedger } from './ledger.js'
import { RecordStore, UNSCOPED } from './store.js'

const goldenJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/records_schema.json', import.meta.url)),
    'utf8',
  ),
) as {
  objects: { type: string; name: string; tbl_name: string; sql: string | null }[]
  columns: Record<string, { cid: number; name: string; type: string; notnull: number; default: unknown; pk: number }[]>
}

let store: RecordStore | undefined
afterEach(() => {
  store?.close()
  store = undefined
})

/** 时钟与随机都钉住 ⇒ 同一段脚本两次跑出同样的 id。 */
function fresh(): RecordStore {
  let t = 1_700_000_000_000
  let r = 0
  store = new RecordStore({ clock: () => (t += 1), random: () => ((r = (r * 1103515245 + 12345) % 2 ** 31), r / 2 ** 31) })
  return store
}

describe('建表与金样一致', () => {
  it('generated/schema.ts 与 spec/golden/records_schema.sql 同步', () => {
    // 与 nanonis 门面同一套办法：生成物入仓，靠一条测试保证它没漂
    execFileSync(process.execPath, ['scripts/gen-records-schema.ts', '--check'], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: 'pipe',
    })
  })

  it('sqlite_master 与金样逐条相等 —— 124 个对象，一个不差', () => {
    const db = fresh().db
    const got = db
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
    expect(got.map((o) => [o.type, o.name, o.tbl_name, o.sql])).toEqual(
      goldenJson.objects.map((o) => [o.type, o.name, o.tbl_name, o.sql]),
    )
  })

  it('每张表的列（名字/类型/非空/缺省/主键位次）都与金样相等', () => {
    const db = fresh().db
    for (const [table, want] of Object.entries(goldenJson.columns)) {
      // PRAGMA 那一列叫 `dflt_value`，导出脚本里记成了 `default` —— 只是键名，改名对齐
      const got = (db.prepare(`PRAGMA table_info("${table}")`).all() as Record<string, unknown>[]).map(
        ({ dflt_value, ...rest }) => ({ ...rest, default: dflt_value }),
      )
      expect({ [table]: got }).toEqual({ [table]: want })
    }
  })

  it('外键是**开着**的 —— 关着时一条指向不存在实验的 action 会安静地写进去', () => {
    const db = fresh().db
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(() =>
      db
        .prepare(
          `INSERT INTO actions (id, experiment_id, agent_id, action_type, params_json, hlc)
           VALUES ('x', '不存在的实验', 'IC', 'T', '{}', '0')`,
        )
        .run(),
    ).toThrow()
  })
})

describe('被拒的调用**也记**', () => {
  it('六种结局都落一行，status 按 schema 的 CHECK 收敛到三个值', () => {
    const s = fresh()
    const kinds = ['ok', 'failed', 'refused', 'aborted', 'busy', 'rolled_back'] as const
    for (const k of kinds) {
      s.record({ skill: '_Probe', params: {}, kind: k, text: `[_Probe] ${k}` })
    }
    const rows = s.db.prepare('SELECT action_type, status, error FROM actions ORDER BY hlc').all() as {
      status: string
      error: string | null
    }[]
    expect(rows).toHaveLength(6)
    expect(rows.map((r) => r.status)).toEqual([
      'succeeded', 'failed', 'failed', 'failed', 'failed', 'rolled_back',
    ])
    // 区分不在 status 里，在 error 的**前缀**里 —— 那个前缀本来就是机器读的
    expect(rows[2]?.error).toBe('[_Probe] refused')
    expect(rows[0]?.error).toBeNull() // 成功不写 error
  })

  it('**没有活动实验时也记**（D-REC-1）—— 那正是样品闸拒绝的判据本身', () => {
    const s = fresh()
    const id = s.record({
      skill: 'StartScan',
      params: {},
      kind: 'refused',
      text: '[sample_gate] no_active_experiment: …',
    })
    expect(id).not.toBeNull()
    const row = s.db.prepare('SELECT experiment_id FROM actions WHERE id = ?').get(id!) as {
      experiment_id: string
    }
    expect(row.experiment_id).toBe(UNSCOPED)
    // 查询侧能一句话把它们摘出来
    const n = s.db
      .prepare('SELECT count(*) AS n FROM actions WHERE experiment_id = ?')
      .get(UNSCOPED) as { n: number }
    expect(n.n).toBe(1)
  })

  it('params 进 json，四个生成列跟着可查 —— 事后能问「谁写过 1.5 V 以上的偏压」', () => {
    const s = fresh()
    s.record({ skill: 'SetBias', params: { bias_v: 2.5 }, kind: 'ok' })
    s.record({ skill: 'SetBias', params: { bias_v: 0.1 }, kind: 'ok' })
    const rows = s.db
      .prepare('SELECT param_bias_v AS v FROM actions WHERE param_bias_v > 1.0')
      .all() as { v: number }[]
    expect(rows).toEqual([{ v: 2.5 }])
  })

  it('**永不抛**：记录坏掉不能变成技能坏掉', () => {
    const s = fresh()
    s.close()
    store = undefined
    // 库已经关了 —— 返回 null 而不是炸出去
    expect(s.record({ skill: '_Probe', params: {}, kind: 'ok' })).toBeNull()
  })

  it('序列化不了的参数不会让整条记录消失', () => {
    const s = fresh()
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const id = s.record({ skill: '_Probe', params: cyclic, kind: 'ok' })
    expect(id).not.toBeNull()
    expect(
      (s.db.prepare('SELECT params_json AS p FROM actions WHERE id = ?').get(id!) as { p: string }).p,
    ).toBe('{}')
  })
})

describe('approval_source 落库', () => {
  it('human / auto 各写一行 approvals，llm 不写 —— 而「没有行」就是 llm', () => {
    const s = fresh()
    const ids = (['llm', 'human', 'auto'] as const).map((src) =>
      s.record({ skill: '_Probe', params: {}, kind: 'ok', approvalSource: src }),
    )
    expect(ids.every((i) => i !== null)).toBe(true)
    expect(s.approvalSourceOf(ids[0]!)).toBe('llm')
    expect(s.approvalSourceOf(ids[1]!)).toBe('human')
    expect(s.approvalSourceOf(ids[2]!)).toBe('auto')
    const rows = s.db.prepare('SELECT approver_kind AS k FROM approvals ORDER BY k').all()
    expect(rows).toEqual([{ k: 'automated_policy' }, { k: 'human_operator' }])
  })

  it('缺省是 llm —— 工具入口就是模型入口', () => {
    const s = fresh()
    const id = s.record({ skill: '_Probe', params: {}, kind: 'ok' })
    expect(s.approvalSourceOf(id!)).toBe('llm')
  })

  it('**空表和「没人准过」不能长得一样** —— 2026-07-27 的取证栽在这个形状上', () => {
    // 所以 approvals 必须真的写。一条 human 批准的 DANGEROUS 动作，
    // 事后要能查出「是人准的」，而不是查到一张空表然后无从判断。
    const s = fresh()
    const id = s.record({
      skill: 'TipShape',
      params: { depth_m: 1e-9 },
      kind: 'ok',
      approvalSource: 'human',
    })
    const row = s.db
      .prepare('SELECT approver_id, approval_method FROM approvals WHERE action_id = ?')
      .get(id!)
    expect(row).toEqual({ approver_id: 'human', approval_method: 'gui_click' })
  })
})

describe('RunLedger —— 交叉核对用的有界缓冲', () => {
  it('只有**成功**的调用能贡献产物', () => {
    const l = new RunLedger()
    l.note('r1', 'A', true, ['D:\\a.sxm'])
    l.note('r1', 'B', false, ['D:\\b.sxm'])
    expect(l.get('r1')).toEqual({ skills: ['A', 'B'], artifacts: ['D:\\a.sxm'] })
  })

  it('**没这次运行时返回 undefined，不是空条目**', () => {
    // 「不知道」和「什么都没跑」是两个答案，auditClaim 对它们的处理完全不同
    const l = new RunLedger()
    expect(l.get('never')).toBeUndefined()
    l.note('r1', '', true)
    expect(l.get('r1')).toEqual({ skills: [], artifacts: [] })
  })

  it('只留最近 8 次运行', () => {
    const l = new RunLedger()
    for (let i = 0; i < 12; i++) l.note(`r${i}`, 'A', true)
    expect(l.runIds()).toEqual(['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11'])
  })

  it('每次运行最多 500 条，超了丢最旧的', () => {
    const l = new RunLedger()
    for (let i = 0; i < 520; i++) l.note('r', `S${i}`, true, [`D:\\${i}.sxm`])
    const e = l.get('r')!
    expect(e.skills).toHaveLength(500)
    expect(e.skills[0]).toBe('S20')
    expect(e.artifacts).toHaveLength(500)
  })

  it('store.record 接账本：runId 给了才记', () => {
    const s = fresh()
    s.record({ skill: 'A', params: {}, kind: 'ok', runId: 'run-1', artifacts: ['D:\\a.sxm'] })
    s.record({ skill: 'B', params: {}, kind: 'refused', runId: 'run-1', artifacts: ['D:\\b.sxm'] })
    s.record({ skill: 'C', params: {}, kind: 'ok' })
    expect(s.ledger.get('run-1')).toEqual({ skills: ['A', 'B'], artifacts: ['D:\\a.sxm'] })
    expect(s.ledger.runIds()).toEqual(['run-1'])
  })
})

describe('ULID 与 HLC 都按时间排序', () => {
  it('ULID 字典序即时间序', () => {
    const a = ulid(1_700_000_000_000, () => 0.5)
    const b = ulid(1_700_000_000_001, () => 0.5)
    expect(a.length).toBe(26)
    expect(a < b).toBe(true)
  })

  it('**同一毫秒内的多次调用不会撞** —— 计数器就是为这一毫秒准备的', () => {
    const c = new HlcClock('IC', () => 1_700_000_000_000)
    const seq = [c.now(), c.now(), c.now()]
    expect(seq).toEqual([
      '1700000000000-0000-IC',
      '1700000000000-0001-IC',
      '1700000000000-0002-IC',
    ])
    expect(seq[0]! < seq[1]!).toBe(true)
  })

  it('墙钟前进时计数器归零', () => {
    let t = 1_700_000_000_000
    const c = new HlcClock('IC', () => t)
    c.now()
    t += 1
    expect(c.now()).toBe('1700000000001-0000-IC')
  })

  it("节点名不能含 '-' —— 那是编码的分隔符，带了就再也切不回来", () => {
    expect(() => new HlcClock('a-b')).toThrow()
    expect(() => new HlcClock('')).toThrow()
  })
})

describe('DDL 常量本身', () => {
  it('21 张表 / 53 个索引都在里面', () => {
    expect((RECORDS_DDL.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length).toBe(21)
    expect((RECORDS_DDL.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length).toBe(53)
  })
})
