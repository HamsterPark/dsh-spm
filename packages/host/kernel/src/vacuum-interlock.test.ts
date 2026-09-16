/**
 * 真空互锁 —— 逐格对 `spec/golden/environment.json`（旧仓真实现录的）。
 *
 * 这份金样与 `skill_traces.json` 里那一格是两件事：那一格录的是
 * 「某一种压强下技能返回什么」，这一份录的是**判定机本身**——
 * 同一份读数在三种模式下的三个答案、六条拒绝的排序、以及两端量程各自的那一支。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ATTESTATION_REASONS,
  CORONA_ZONE_PA,
  DEFAULT_ATTESTATION_TTL_S,
  DEFAULT_GAUGE_FULL_SCALE_PA,
  DEFAULT_GAUGE_MIN_PA,
  DEFAULT_MAX_AGE_S,
  DEFAULT_MAX_PRESSURE_PA,
  PLACEHOLDER_CLASSES,
  REAL_GAUGE_CLASSES,
  VACUUM_MODES,
  assess,
  attest,
  attestationExpired,
  attestationLabel,
  attestationRemainingS,
  checkVacuum,
  currentSample,
  formatBlock,
  gaugeConfigProblem,
  gaugeVerdict,
  processVacuum,
  pyFloat,
  revokeAttestation,
  toPascal,
  vacuumCoarseCheck,
  verdictDict,
  type Attestation,
  type PressureSample,
  type VacuumConfig,
  type VacuumMode,
} from './index.js'

interface Golden {
  readonly _now_s: number
  readonly constants: Record<string, unknown>
  readonly to_pascal: { value: unknown; unit: string; out: unknown }[]
  readonly gauge_config: {
    min_pa: number; full_scale_pa: number; max_pa: number; out: string
  }[]
  readonly gauge_verdict: {
    name: string
    sample: Record<string, unknown> | null
    cfg: Record<string, number>
    ok: boolean
    reason: string
    detail: Record<string, unknown>
  }[]
  readonly assess: {
    name: string
    sample: Record<string, unknown> | null
    mode: string
    att: Record<string, unknown> | null
    cfg: Record<string, number>
    verdict: Record<string, unknown>
    block: string
  }[]
}

const G: Golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/environment.json', import.meta.url)),
    'utf8',
  ),
) as Golden

const NOW = G._now_s

/** 导出器把 `inf` / `nan` 录成记号串（JSON 没有这三个值）。 */
function decode(v: unknown): unknown {
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  if (v === 'NaN') return NaN
  return v
}

function sampleOf(raw: Record<string, unknown> | null): PressureSample | null {
  if (raw === null) return null
  return {
    value: decode(raw['value']),
    unit: String(raw['unit'] ?? ''),
    status: String(raw['status'] ?? ''),
    timestamp: String(raw['timestamp'] ?? ''),
    sensorName: String(raw['sensor_name'] ?? ''),
    sensorClass: String(raw['sensor_class'] ?? ''),
  }
}

function attOf(raw: Record<string, unknown> | null): Attestation | null {
  if (raw === null) return null
  return {
    reason: String(raw['reason'] ?? ''),
    signedBy: String(raw['signed_by'] ?? ''),
    signedAtS: Number(raw['signed_at'] ?? 0),
    ttlS: Number(raw['ttl_s'] ?? 0),
    note: String(raw['note'] ?? ''),
  }
}

/** 金样的蛇形 cfg → 本仓的驼峰。**声明了返回类型**，变异才编得过。 */
function cfgOf(raw: Record<string, number>): Partial<VacuumConfig> {
  const out: Record<string, number> = {}
  if (raw['min_pa'] !== undefined) out['minPa'] = raw['min_pa']
  if (raw['full_scale_pa'] !== undefined) out['fullScalePa'] = raw['full_scale_pa']
  if (raw['max_pa'] !== undefined) out['maxPa'] = raw['max_pa']
  if (raw['max_age_s'] !== undefined) out['maxAgeS'] = raw['max_age_s']
  return out as Partial<VacuumConfig>
}

function fullCfg(raw: Record<string, number>): VacuumConfig {
  return {
    mode: 'gauge_or_attest',
    maxPa: DEFAULT_MAX_PRESSURE_PA,
    maxAgeS: DEFAULT_MAX_AGE_S,
    fullScalePa: DEFAULT_GAUGE_FULL_SCALE_PA,
    minPa: DEFAULT_GAUGE_MIN_PA,
    ...cfgOf(raw),
  }
}

describe('常量：这一族数字的唯一真源', () => {
  it('与旧仓逐个相等', () => {
    const c = G.constants
    expect([...CORONA_ZONE_PA]).toEqual(c['corona_zone_pa'])
    expect(DEFAULT_MAX_PRESSURE_PA).toBe(c['default_max_pressure_pa'])
    expect(DEFAULT_GAUGE_FULL_SCALE_PA).toBe(c['default_gauge_full_scale_pa'])
    expect(DEFAULT_GAUGE_MIN_PA).toBe(c['default_gauge_min_pa'])
    expect(DEFAULT_MAX_AGE_S).toBe(c['default_max_age_s'])
    expect(DEFAULT_ATTESTATION_TTL_S).toBe(c['default_attestation_ttl_s'])
    expect([...VACUUM_MODES]).toEqual(c['modes'])
    expect(ATTESTATION_REASONS).toEqual(c['attestation_reasons'])
    expect([...REAL_GAUGE_CLASSES].sort()).toEqual(c['real_gauge_classes'])
    expect([...PLACEHOLDER_CLASSES].sort()).toEqual(c['placeholder_classes'])
  })

  it('放行上限低于放电带下沿 —— 这条关系垮了，整个互锁就没意义了', () => {
    expect(DEFAULT_MAX_PRESSURE_PA).toBeLessThan(CORONA_ZONE_PA[0])
    expect(DEFAULT_GAUGE_MIN_PA).toBeLessThan(DEFAULT_MAX_PRESSURE_PA)
  })
})

describe('toPascal：认不出的单位一律拒绝，不假设', () => {
  for (const c of G.to_pascal) {
    it(`${JSON.stringify(c.value)} ${JSON.stringify(c.unit)}`, () => {
      const got = toPascal(decode(c.value), c.unit)
      const want = decode(c.out)
      if (want === null) expect(got).toBeNull()
      else expect(got).toBeCloseTo(want as number, 12)
    })
  }

  it('`Number()` 会把这些当 0，而 0 Pa 读起来正是完美真空', () => {
    // 这一条不在金样里（Python 的 `float(None)` 直接抛），但它是 JS 独有的坑：
    // 少了 `pyFloat` 这一层，三个「没有值」全都变成一个完美真空。
    expect(Number(null)).toBe(0)
    expect(Number('')).toBe(0)
    expect(Number('   ')).toBe(0)
    expect(pyFloat(null)).toBeNull()
    expect(pyFloat('')).toBeNull()
    expect(pyFloat('   ')).toBeNull()
    expect(toPascal(null, 'Pa')).toBeNull()
    expect(toPascal('', 'Pa')).toBeNull()
  })
})

describe('gaugeConfigProblem：这只规能不能证明它该证明的事', () => {
  for (const c of G.gauge_config) {
    it(`min=${c.min_pa} full=${c.full_scale_pa} max=${c.max_pa}`, () => {
      expect(
        gaugeConfigProblem({
          minPa: c.min_pa, fullScalePa: c.full_scale_pa, maxPa: c.max_pa,
        }),
      ).toBe(c.out)
    })
  }
})

describe('gaugeVerdict：六条拒绝，逐条逐字', () => {
  for (const c of G.gauge_verdict) {
    it(c.name, () => {
      const got = gaugeVerdict(sampleOf(c.sample), fullCfg(c.cfg), NOW)
      expect(got.ok).toBe(c.ok)
      expect(got.reason).toBe(c.reason)
      expect(got.detail).toEqual(c.detail)
    })
  }
})

describe('assess：模式 × 签署', () => {
  for (const c of G.assess) {
    it(c.name, () => {
      const v = assess(sampleOf(c.sample), {
        config: { ...cfgOf(c.cfg), mode: c.mode as VacuumMode },
        attestation: attOf(c.att),
        nowS: NOW,
      })
      expect(verdictDict(v)).toEqual(c.verdict)
      expect(formatBlock(v)).toBe(c.block)
    })
  }

  it('提示块永不为空，且拒绝时一定带那句「没有重试」的尾注', () => {
    for (const c of G.assess) {
      expect(c.block.length).toBeGreaterThan(0)
      const v = assess(sampleOf(c.sample), {
        config: { ...cfgOf(c.cfg), mode: c.mode as VacuumMode },
        attestation: attOf(c.att),
        nowS: NOW,
      })
      expect(formatBlock(v).includes('打火击穿')).toBe(!v.allow)
    }
  })
})

describe('签署：进程级、限时、理由是闭集', () => {
  const reset = (): void => {
    processVacuum.source = null
    processVacuum.config = {}
    processVacuum.nowS = () => NOW
    revokeAttestation()
  }

  it('认不出的理由**直接拒**，不存一个自由文本', () => {
    reset()
    expect(() => attest('气压应该没问题吧', { nowS: NOW })).toThrow(
      /unknown attestation reason/,
    )
    expect(processVacuum.attestation).toBeNull()
  })

  it('过期是 `>` 而不是 `>=`：恰好到点还算活的', () => {
    const att: Attestation = {
      reason: 'vented_to_atmosphere', signedBy: '甲',
      signedAtS: NOW - 8 * 3600, ttlS: 8 * 3600, note: '',
    }
    expect(attestationExpired(att, NOW)).toBe(false)
    expect(attestationExpired(att, NOW + 1)).toBe(true)
    expect(attestationRemainingS(att, NOW)).toBe(0)
    // 过期之后剩余时长**夹在 0**，不给负数（负的「还剩」读起来像还剩）
    expect(attestationRemainingS(att, NOW + 3600)).toBe(0)
  })

  it('认得出的理由翻成人话，认不出的回显原文', () => {
    expect(attestationLabel({
      reason: 'high_vacuum_gauge_unavailable', signedBy: '', signedAtS: 0,
      ttlS: 0, note: '',
    })).toBe('已抽至高真空，但真空计不可用')
    expect(attestationLabel({
      reason: '', signedBy: '', signedAtS: 0, ttlS: 0, note: '',
    })).toBe('未说明原因')
  })

  it('默认 TTL 是 8 小时，签署的时刻走注入的钟', () => {
    reset()
    const att = attest('vented_to_atmosphere', { signedBy: '甲' })
    expect(att.signedAtS).toBe(NOW)
    expect(att.ttlS).toBe(DEFAULT_ATTESTATION_TTL_S)
    revokeAttestation()
    expect(processVacuum.attestation).toBeNull()
  })
})

describe('进程级源：读不到 = 没有读数 = 拒', () => {
  const reset = (): void => {
    processVacuum.source = null
    processVacuum.config = {}
    processVacuum.nowS = () => NOW
    revokeAttestation()
  }

  it('没接源 ⇒ `currentSample()` 是 null ⇒ 拒绝', () => {
    reset()
    expect(currentSample()).toBeNull()
    const v = checkVacuum()
    expect(v.allow).toBe(false)
    expect(v.source).toBe('none')
    expect(v.gaugeOk).toBe(false)
  })

  it('**源抛了也是「没有读数」**，不是把异常抬出去', () => {
    reset()
    processVacuum.source = (): PressureSample => {
      throw new Error('串口掉线')
    }
    expect(currentSample()).toBeNull()
    expect(checkVacuum().allow).toBe(false)
  })

  it('接上一只好规 ⇒ 放行，而且用的是注入的钟', () => {
    reset()
    processVacuum.source = (): PressureSample => ({
      value: 1e-3, unit: 'Pa', status: 'ok',
      timestamp: '2023-11-14T22:13:08+00:00',
      sensorName: 'Chamber', sensorClass: 'DL7VacuumSensor',
    })
    const v = checkVacuum()
    expect(v.allow).toBe(true)
    expect(v.source).toBe('gauge')
    expect(v.ageS).toBe(12)
    // 把钟往后拨一小时，同一份读数就过期了 —— 年龄是判据，不是装饰
    processVacuum.nowS = () => NOW + 3600
    expect(checkVacuum().allow).toBe(false)
  })
})

describe('vacuumCoarseCheck：接成前置检查的那个工厂', () => {
  it('ok 跟着 allow，reason 原样透传', () => {
    processVacuum.source = null
    processVacuum.config = {}
    processVacuum.nowS = () => NOW
    revokeAttestation()

    const check = vacuumCoarseCheck()
    const bad = check()
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe(checkVacuum(NOW).reason)

    processVacuum.source = (): PressureSample => ({
      value: 1e-3, unit: 'Pa', status: 'ok',
      timestamp: '2023-11-14T22:13:08+00:00',
      sensorName: 'Chamber', sensorClass: 'DL7VacuumSensor',
    })
    expect(check().ok).toBe(true)
  })

  it('可以自带时钟（宿主接真钟，测试钉住）', () => {
    processVacuum.source = (): PressureSample => ({
      value: 1e-3, unit: 'Pa', status: 'ok',
      timestamp: '2023-11-14T22:13:08+00:00',
      sensorName: 'Chamber', sensorClass: 'DL7VacuumSensor',
    })
    processVacuum.config = {}
    revokeAttestation()
    expect(vacuumCoarseCheck(() => NOW)().ok).toBe(true)
    expect(vacuumCoarseCheck(() => NOW + 3600)().ok).toBe(false)
  })
})
