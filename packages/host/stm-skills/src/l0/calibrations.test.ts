/**
 * `ReadCalibrations` —— **它的全部价值是区分两种否定**，所以这份测试就是那两句话。
 *
 * 「有标定」那条成功路已经在 `spec/golden/skill_traces.json` 里逐字对旧仓比过了。
 * 这里补的是金样**录不到**的那一半：旧仓那边模块永远在，于是「读不到档案」
 * 在 Python 里只有一条 `except` 路径；本仓把它做成了一个可以说出口的状态。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { NO_PROFILE_SOURCE, processInstrumentProfile, type SkillContext } from 'dsh-spm-kernel'
import { ReadCalibrations, ageNote, condNote } from './calibrations.js'

const NOW = 1_700_000_000
const CTX = {} as SkillContext

const FULL: Record<string, unknown> = {
  tilt_cal_g11: -1.02, tilt_cal_g12: 0.07, tilt_cal_g21: 0.03, tilt_cal_g22: -0.98,
  tilt_cal_cond: 1.1128, tilt_cal_updated_at: 1_699_000_000.0,
  didv_at_contact_v: 2.5e-3, didv_cal_bias_v: 0.05, didv_cal_setpoint_a: 1e-10,
  didv_cal_mod_amp_v: 0.02, didv_cal_updated_at: 1_699_996_400.0,
  qplus_f0_measured_hz: 32768.0, qplus_q_measured: 24000.0,
  qplus_fq_updated_at: 1_699_999_400.0,
}

function install(profile: Record<string, unknown> | null): void {
  processInstrumentProfile.nowS = () => NOW
  processInstrumentProfile.source = profile === null ? null : () => profile
}

afterEach(() => {
  processInstrumentProfile.source = null
  processInstrumentProfile.nowS = () => Date.now() / 1000
})

async function read(which = ''): Promise<{ data: Record<string, unknown>; summary: string }> {
  const res = await ReadCalibrations.execute(CTX, { which })
  return { data: (res.data ?? {}) as Record<string, unknown>, summary: res.summary ?? '' }
}

describe('ReadCalibrations · 两种否定', () => {
  it('档案读得到但没标定过 ⇒ 「**从未标定过**(不是读取失败)」', async () => {
    install({})
    const { data, summary } = await read()
    for (const key of ['tilt', 'didv', 'qplus']) {
      const block = data[key] as Record<string, unknown>
      expect(block['available']).toBe(false)
      expect(String(block['why'])).toContain('从未')
      expect(String(block['why'])).toContain('不是读取失败')
    }
    expect(summary).toContain('已确认读到档案,不是读取失败')
  })

  it('**宿主没接档案存储 ⇒ 「读不到档案」，而不是「从未标定过」**', async () => {
    install(null)
    const { data, summary } = await read()
    for (const key of ['tilt', 'didv', 'qplus']) {
      const block = data[key] as Record<string, unknown>
      expect(block['available']).toBe(false)
      expect(block['why']).toBe(NO_PROFILE_SOURCE)
      expect(String(block['why'])).not.toContain('从未标定过倾斜响应')
    }
    // ⚠️ 旧仓这一行无条件写「(已确认读到档案,不是读取失败)」—— 一个专门用来分开
    // 两种否定的技能，在它自己的 summary 里把两者合成了，还合成了**错的**那一句。
    expect(summary).toContain('读不到仪器档案本身')
    expect(summary).toContain('**这不是「从未标定过」**')
    expect(summary).not.toContain('已确认读到档案')
  })

  it('读口抛了 ⇒ 同样是「读不到」，并且带上**为什么**', async () => {
    processInstrumentProfile.nowS = () => NOW
    processInstrumentProfile.source = () => {
      throw new Error('ENOENT: ui_settings.json')
    }
    const { data, summary } = await read()
    expect(String((data['tilt'] as Record<string, unknown>)['why'])).toContain('ui_settings.json')
    expect(summary).toContain('ui_settings.json')
  })

  it('倾斜标定缺一个元素 = **从未标定过**（半张矩阵比没有矩阵更危险）', async () => {
    install({ tilt_cal_g11: 1, tilt_cal_g12: 0, tilt_cal_g21: 0, tilt_cal_cond: 1 })
    const tilt = (await read()).data['tilt'] as Record<string, unknown>
    expect(tilt['available']).toBe(false)
    expect(String(tilt['why'])).toContain('从未标定过倾斜响应')
    expect(String(tilt['why'])).toContain('AutoTilt 因此一律跳过')
  })
})

describe('ReadCalibrations · 有标定时说的那几句', () => {
  it('倾斜块带 **G = −M⁻¹** 那句约定，以及「条件数只管形状不管方向」', async () => {
    install(FULL)
    const tilt = (await read()).data['tilt'] as Record<string, unknown>
    expect(tilt['available']).toBe(true)
    expect(tilt['g']).toEqual([[-1.02, 0.07], [0.03, -0.98]])
    // 2026-08-11 的更正：存的是 G，不是 M。信了旧措辞的人会**二次求逆**。
    expect(String(tilt['convention_note'])).toContain('G = −M⁻¹')
    expect(String(tilt['convention_note'])).toContain('不要再求逆、不要再取负')
    // 2026-08-10：cond = 1.1128（很漂亮）而 AutoTilt 仍然发散。
    expect(String(tilt['cond_note'])).toContain('条件数只管形状,不管方向')
  })

  it('`which` 只看一项；写错了就当没写（回全部）', async () => {
    install(FULL)
    expect(Object.keys((await read('tilt')).data).sort()).toEqual(['read_at', 'tilt'])
    expect(Object.keys((await read('QPLUS')).data).sort()).toEqual(['qplus', 'read_at'])
    expect(Object.keys((await read('nope')).data).sort()).toEqual(['didv', 'qplus', 'read_at', 'tilt'])
  })

  it('ring-down τ 给出来是为了**不让人写一个固定等待时长**', async () => {
    install(FULL)
    const q = (await read('qplus')).data['qplus'] as Record<string, unknown>
    expect(q['ring_down_tau_s']).toBeCloseTo(24000 / (Math.PI * 32768), 12)
    expect(String(q['ring_down_note'])).toContain('别据此写一个固定等待时长')
  })

  it('**标称 f₀/Q 不在报文里** —— 它们住在针尖登记表上，而旧仓读的是档案', async () => {
    install(FULL)
    const q = (await read('qplus')).data['qplus'] as Record<string, unknown>
    // 旧仓这两个字段恒为 `None`（金样逐格录着 null），接一条永远不亮的分支没有意义。
    expect('nominal_f0_hz' in q).toBe(false)
    expect('nominal_q' in q).toBe(false)
  })
})

/**
 * ⚠️ **金样里那三格 `age_note` 编码了一个本地时刻，所以它们绑着这台机器的时区。**
 *
 * `age_note` 里那个绝对时刻是旧仓用 `time.localtime(ts)` 渲的，导出器与本仓测试
 * 跑在同一台机器上（UTC+8），于是对得上。**换一台时区不同的机器，
 * `ReadCalibrations` 的三格轨迹金样会红。**
 *
 * 这与 **D-DAT-1** 明写的那条规矩是冲突的：「那会把这台机器的环境钉进金样 ——
 * 一条**记录环境而不是记录行为**的假判据」。这里之所以还留着，是因为它记的
 * 确实是旧仓的行为（旧仓就是渲本地时间），而修法要么改旧仓、要么在两侧各钉一次时区，
 * 两件都不在这一批里。
 *
 * **但一次说不清的红比一次红更坏。** 所以这一条守卫先跑：时区一对不上，
 * 报出来的是这句话，而不是三段看不懂的字符串 diff。
 */
describe('⚠ 金样里的本地时刻 —— 这一族绑着时区', () => {
  it('这台机器的时区渲染与金样里那一格一致（不一致就是时区，不是回归）', () => {
    const ts = NOW - 3600
    const d = new Date(ts * 1000)
    const two = (n: number): string => String(n).padStart(2, '0')
    const here =
      `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
      `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`

    expect(
      here,
      'spec/golden/skill_traces.json 的 ReadCalibrations 三格 age_note 里编码的是 ' +
        '**导出那台机器的本地时刻**（UTC+8）。这台机器渲出来是 ' +
        here +
        '，对不上说明时区不同 —— 这不是一次回归，是 D-DAT-1 说的那种' +
        '「把环境钉进金样」。要么在这台机器上重跑导出器，要么把两侧的时区一起钉死。',
    ).toBe('2023-11-15 05:13:20')
  })
})

describe('ReadCalibrations · 年龄与条件数的说法', () => {
  it('**没有时间戳是一句话，不是 0**', () => {
    processInstrumentProfile.nowS = () => NOW
    for (const bad of [null, undefined, '', 'abc', 0, -1, Number.NaN, true]) {
      const n = ageNote(bad)
      expect(n['updated_at'], String(bad)).toBeNull()
      expect(n['age_s'], String(bad)).toBeNull()
      expect(String(n['age_note'])).toContain('**这条标定没有时间戳**')
    }
  })

  it('三个年龄分支：天 / 小时 / 分钟，而只有「天」那一档说「换过样品就失效」', () => {
    processInstrumentProfile.nowS = () => NOW
    expect(String(ageNote(NOW - 86400 * 3)['age_note'])).toContain('3.0 天前')
    expect(String(ageNote(NOW - 86400 * 3)['age_note'])).toContain('换过样品/托架之后这条就失效了')
    expect(String(ageNote(NOW - 3600)['age_note'])).toContain('1.0 小时前')
    expect(String(ageNote(NOW - 3600)['age_note'])).not.toContain('换过样品')
    expect(String(ageNote(NOW - 600)['age_note'])).toContain('10 分钟前')
  })

  it('条件数读不到 ⇒ 「**这不等于标定良好**，是这一项答不了」', () => {
    for (const bad of [null, undefined, 'abc', Number.NaN, true]) {
      expect(condNote(bad)).toContain('**这不等于标定良好**')
    }
  })

  it('条件数超过拒写线 ⇒ 说「形状可疑」，而**两句话永远一起说**', () => {
    expect(condNote(12.0)).toContain('**形状可疑**')
    expect(condNote(12.0)).toContain('超过拒绝写入线 10')
    expect(condNote(1.1128)).toContain('形状健全')
    for (const c of [1.1128, 12.0]) {
      expect(condNote(c)).toContain('对符号与求逆一无所知')
    }
  })
})

describe('ReadCalibrations · 它不碰硬件', () => {
  it('零 TCP：给一个会抛的 context 也照样跑完', async () => {
    install(FULL)
    const boom = {
      safeCall: () => {
        throw new Error('这个技能不该发调用')
      },
    } as unknown as SkillContext
    const res = await ReadCalibrations.execute(boom, {})
    expect(res.success).toBe(true)
  })
})
