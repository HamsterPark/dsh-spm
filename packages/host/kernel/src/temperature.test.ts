/**
 * 温度源 —— 逐格对 `spec/golden/environment.json`（旧仓真实现录的）。
 *
 * 这一族的全部内容是「**没有值**有六种不同的意思」，而六种里有四种
 * 只在特定的通道组合下才产生 —— 一次技能调用碰不到它们，所以单独录一份。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AMBIGUOUS_CHANNEL,
  NO_SENSOR,
  NO_SOURCE,
  STALE,
  TEMPERATURE_REASONS,
  UNAVAILABLE,
  UNKNOWN_CHANNEL,
  ageS,
  channelDict,
  channelKelvin,
  freshness,
  isTemperatureUnit,
  latestTemperature,
  matchChannel,
  processTemperature,
  readTemperature,
  readingDict,
  temperatureChannels,
  toKelvin,
  type TempChannel,
  type TempReading,
} from './index.js'

interface Golden {
  readonly _now_s: number
  readonly _now_iso: string
  readonly constants: Record<string, unknown>
  readonly to_kelvin: { value: unknown; unit: string; status: string; out: unknown }[]
  readonly age_s: { timestamp: unknown; out: number | null }[]
  readonly read_temperature: {
    name: string
    channels: Record<string, unknown>[]
    channel: string | null
    out: Record<string, unknown>
    available_channels: Record<string, unknown>[]
  }[]
  readonly freshness: {
    value_k: number | null; age_s: number | null; max_age_s: number; out: string
  }[]
}

const G: Golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/environment.json', import.meta.url)),
    'utf8',
  ),
) as Golden

const NOW = G._now_s

function chanOf(raw: Record<string, unknown>): TempChannel {
  return {
    name: String(raw['name'] ?? ''),
    value: raw['value'],
    unit: String(raw['unit'] ?? ''),
    status: String(raw['status'] ?? ''),
    timestamp: String(raw['timestamp'] ?? ''),
    driver: String(raw['driver'] ?? ''),
    real: (raw['real'] ?? null) as boolean | null,
  }
}

describe('六个 reason 的名字 —— 闭集，且每个只有一个名字', () => {
  it('与旧仓逐个相等', () => {
    expect([...TEMPERATURE_REASONS]).toEqual(G.constants['temperature_reasons'])
    expect([NO_SENSOR, UNAVAILABLE, STALE, UNKNOWN_CHANNEL, AMBIGUOUS_CHANNEL, NO_SOURCE])
      .toEqual([...TEMPERATURE_REASONS])
  })

  it('`stale` 在名单里但**本模块永不产出它** —— 多旧算旧只有调用方知道', () => {
    const produced = new Set(G.read_temperature.map((c) => c.out['reason']))
    expect(produced.has(STALE)).toBe(false)
  })
})

describe('toKelvin：按单位换算，不按传感器名字', () => {
  for (const c of G.to_kelvin) {
    it(`${JSON.stringify(c.value)} ${JSON.stringify(c.unit)} / ${c.status}`, () => {
      const got = toKelvin(c.value, c.unit, c.status)
      if (c.out === null) expect(got).toBeNull()
      else expect(got).toBe(c.out as number)
    })
  }

  it('`warning` / `alarm` 算读到了，`error` / `unavailable` 不算', () => {
    // 降温途中必然长期落在警带里，而那恰恰是唯一要看的那个数。
    expect(toKelvin(4.2, 'K', 'warning')).toBe(4.2)
    expect(toKelvin(4.2, 'K', 'alarm')).toBe(4.2)
    // 读失败时上游写的是 `value=0.0, status="error"` —— 当读数就是把 0 K 记进记录
    expect(toKelvin(0.0, 'K', 'error')).toBeNull()
    expect(toKelvin(0.0, 'K', 'unavailable')).toBeNull()
  })

  it('isTemperatureUnit 认 K 与 °C 的各种写法', () => {
    for (const u of ['K', 'k', 'kelvin', 'C', '°C', 'degC', 'celsius', ' K ']) {
      expect(isTemperatureUnit(u)).toBe(true)
    }
    for (const u of ['A', 'Pa', '', 'kOhm', null, undefined]) {
      expect(isTemperatureUnit(u)).toBe(false)
    }
  })
})

describe('ageS：解析不出来是 null，**不是 0**', () => {
  for (const c of G.age_s) {
    it(JSON.stringify(c.timestamp), () => {
      const got = ageS(c.timestamp, NOW)
      if (c.out === null) expect(got).toBeNull()
      else expect(got).toBe(c.out)
    })
  }

  it('伪造一个 0 会让任何 `age <= limit` 的判据无条件通过', () => {
    const r: TempReading = {
      valueK: 77, ageS: ageS('说不好', NOW), source: '', channel: 'X', reason: null,
    }
    expect(r.ageS).toBeNull()
    expect(freshness(r, 60)).toBe('unknown') // 不是 'fresh'
  })

  it('未来的时间戳给**负**年龄 —— 钟不对这件事值得看见', () => {
    expect(ageS('2023-11-14T22:13:50+00:00', NOW)).toBe(-30)
  })
})

describe('readTemperature：一组通道 → 一个答案', () => {
  for (const c of G.read_temperature) {
    it(c.name, () => {
      const chans = c.channels.map(chanOf)
      const r = readTemperature(chans, { channel: c.channel, nowS: NOW })
      expect(readingDict(r)).toEqual(c.out)
      expect(chans.map(channelDict)).toEqual(c.available_channels)
    })
  }

  it('`real === null`（不知道）**不当占位** —— 否则一台报着 293 K 的机器会被判成没温度计', () => {
    const unknown: TempChannel = {
      name: 'Chamber', value: 293.0, unit: 'K', status: 'ok',
      timestamp: '2023-11-14T22:13:13+00:00', driver: 'SnapshotSensor', real: null,
    }
    expect(readTemperature([unknown], { nowS: NOW }).valueK).toBe(293)
    expect(readTemperature([{ ...unknown, real: false }], { nowS: NOW }).reason)
      .toBe(NO_SENSOR)
  })

  it('一个通道都没有时**即使指名**也说「没有温度计」', () => {
    // 折成 unknown_channel 会让人去找一个并不缺的配置项。
    expect(readTemperature([], { channel: 'SPM', nowS: NOW }).reason).toBe(NO_SENSOR)
    expect(readTemperature(null, { channel: 'SPM', nowS: NOW }).reason).toBe(NO_SENSOR)
  })

  it('读不到时**照样回报通道名和年龄** —— 那才是用户能动手的信息', () => {
    const dead: TempChannel = {
      name: 'Shield', value: 0, unit: '', status: 'error',
      timestamp: '2023-11-14T22:13:15+00:00', driver: 'Lakeshore', real: true,
    }
    const r = readTemperature([dead], { nowS: NOW })
    expect(r.reason).toBe(UNAVAILABLE)
    expect(r.channel).toBe('Shield')
    expect(r.ageS).toBe(5)
    expect(r.source).toBe('') // 没人给出过读数
  })
})

describe('matchChannel：精确 → 忽略大小写 → **唯一**子串', () => {
  const chans: TempChannel[] = [
    { name: 'SPM (COM3)', real: true },
    { name: 'Magnet (COM3)', real: true },
  ]

  it('对上两个就说「你得说清是哪个」，不悄悄挑一个', () => {
    expect(matchChannel(chans, 'COM3').why).toBe(AMBIGUOUS_CHANNEL)
    expect(matchChannel(chans, 'COM3').hit).toBeNull()
  })

  it('落空是 unknown_channel，不是 no_sensor', () => {
    expect(matchChannel(chans, 'LN2').why).toBe(UNKNOWN_CHANNEL)
  })

  it('精确命中优先：`A` 与 `AB` 并存时指名 `A` 不该 ambiguous', () => {
    const two: TempChannel[] = [{ name: 'A' }, { name: 'AB' }]
    expect(matchChannel(two, 'A').hit?.name).toBe('A')
  })
})

describe('freshness：三态，不是 bool', () => {
  for (const c of G.freshness) {
    it(`value=${c.value_k} age=${c.age_s} max=${c.max_age_s}`, () => {
      const r: TempReading = {
        valueK: c.value_k, ageS: c.age_s, source: '', channel: '', reason: null,
      }
      expect(freshness(r, c.max_age_s)).toBe(c.out)
    })
  }

  it('阈值本身读不出来 ⇒ unknown，不是 fresh', () => {
    const r: TempReading = {
      valueK: 77, ageS: 12, source: '', channel: '', reason: null,
    }
    expect(freshness(r, '很旧')).toBe('unknown')
    expect(freshness(r, null)).toBe('unknown')
  })
})

describe('进程级注入口：没接上 = no_source，与 unavailable 分开', () => {
  const reset = (): void => {
    processTemperature.source = null
    processTemperature.channelsSource = null
  }

  it('源没接 ⇒ no_source，且**回显你要的那个名字**', () => {
    reset()
    const r = latestTemperature('SPM')
    expect(r.reason).toBe(NO_SOURCE)
    expect(r.channel).toBe('SPM')
    expect(latestTemperature().channel).toBe('')
  })

  it('源抛了 ⇒ no_source，**问一句温度绝不该把调用方搞崩**', () => {
    reset()
    processTemperature.source = (): TempReading => {
      throw new Error('API 进程没起来')
    }
    expect(latestTemperature('SPM').reason).toBe(NO_SOURCE)
  })

  it('源回了个不是读数的东西 ⇒ no_source', () => {
    reset()
    processTemperature.source = (): TempReading =>
      ({ nonsense: true } as unknown as TempReading)
    expect(latestTemperature().reason).toBe(NO_SOURCE)
  })

  it('`channels()` 的 `null` 与 `[]` 刻意不同', () => {
    reset()
    // null = 问不到（源没接上/抛了）—— 不该让智能体得出「这台机器没温度计」
    expect(temperatureChannels()).toBeNull()
    processTemperature.channelsSource = (): TempChannel[] => {
      throw new Error('炸了')
    }
    expect(temperatureChannels()).toBeNull()
    // [] = 确实一个都没有
    processTemperature.channelsSource = (): TempChannel[] => []
    expect(temperatureChannels()).toEqual([])
    reset()
  })

  it('channelKelvin 与 channelDict 用的是同一条换算', () => {
    const c: TempChannel = {
      name: 'SPM', value: -196.0, unit: 'C', status: 'ok', driver: 'LS', real: true,
    }
    expect(channelKelvin(c)).toBe(77.14999999999998)
    expect(channelDict(c)['value_k']).toBe(channelKelvin(c))
    // 技能报的那份字典里**没有** `value` —— 只有换算过的 `value_k`
    expect(Object.keys(channelDict(c)).sort())
      .toEqual(['driver', 'name', 'real', 'status', 'unit', 'value_k'])
  })
})
