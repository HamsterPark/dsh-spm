/**
 * 仪器档案对 `spec/golden/instrument_profile.json` 逐格比 —— 外加**三态**那几条。
 *
 * 金样由旧仓真实的 `mast/core/instrument_profile.py` 录制
 * （`tools/spec-export/export_instrument_profile.py`）。它录的是**档案自己的判据**：
 * 键表的夹取与丢弃、`get_config` 的三级回落、倾斜标定「缺一个就是没标定过」。
 *
 * 金样**录不到**的那一半在下半篇：旧仓那边模块永远在，所以「读不到档案」这件事
 * 在 Python 里只有一条 `except` 路径；本仓把它做成了一个可以说出口的状态，
 * 而那正是这一批的要害 —— **「从未标定过」与「读不到档案」是两句话。**
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHOICE_SPEC,
  CONFIG_SPEC,
  CALIB_KEYS,
  MOTOR_DIR_CODE,
  NO_PROFILE_SOURCE,
  TILT_CAL_KEYS,
  TILT_CAL_MAX_COND,
  getCalibration,
  getConfig,
  getConfigNum,
  getRetractDirCode,
  getTiltCalibration,
  processInstrumentProfile,
  readProfile,
  sanitizeProfile,
  specDefault,
  zExtendSignOrNone,
} from './instrument-profile.js'

const G = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../spec/golden/instrument_profile.json', import.meta.url)),
    'utf8',
  ),
) as {
  constants: {
    tilt_cal_max_cond: number
    tilt_cal_keys: string[]
    motor_dir_code: Record<string, number>
    calib_keys: string[]
  }
  spec: Record<string, { label: string; unit: string; type: string; min: number; max: number; default: number | null }>
  choice_spec: Record<string, { label: string; choices: string[]; display: Record<string, string>; default: string }>
  ablated_keys: string[]
  spec_default: Record<string, unknown>
  sanitize: Record<string, Record<string, unknown>>
  get_config: Record<string, { key: string; default: unknown; value: unknown }>
  z_extend_sign_or_none: Record<string, number | null>
  retract_dir_code: Record<string, number>
  tilt_calibration: Record<string, { g: number[][]; cond: number | null; updated_at: number | null } | null>
  calibration: Record<string, Record<string, unknown>>
}

/** 用一份**静态档案**当读口 —— 与导出那侧的 `set_profile` 同义。 */
function install(profile: Record<string, unknown>): void {
  processInstrumentProfile.source = () => profile
}

afterEach(() => {
  processInstrumentProfile.source = null
  processInstrumentProfile.nowS = () => Date.now() / 1000
})

describe('仪器档案 · 常量与键表', () => {
  it('倾斜标定的四个键与拒写线', () => {
    expect(TILT_CAL_MAX_COND).toBe(G.constants.tilt_cal_max_cond)
    expect([...TILT_CAL_KEYS]).toEqual(G.constants.tilt_cal_keys)
    expect(MOTOR_DIR_CODE).toEqual(G.constants.motor_dir_code)
  })

  it('标定键表逐字（顺序也算 —— 它决定 `getCalibration` 交出来的是哪几格）', () => {
    expect([...CALIB_KEYS]).toEqual(G.constants.calib_keys)
  })

  it('每个登记键的标签 / 单位 / 区间 / 出厂默认都与旧仓一致', () => {
    for (const [key, want] of Object.entries(G.spec)) {
      const got = CONFIG_SPEC[key]
      expect(got, `缺登记键 ${key}`).toBeDefined()
      const [label, unit, kind, [lo, hi], fallback] = got!
      expect({ label, unit, type: kind, min: lo, max: hi, default: fallback }).toEqual(want)
    }
    // 反向也钉住：本仓多登记一个键（没有消费方的形状）同样会红。
    expect(Object.keys(CONFIG_SPEC).sort()).toEqual(Object.keys(G.spec).sort())
  })

  it('枚举键逐字', () => {
    for (const [key, want] of Object.entries(G.choice_spec)) {
      const [label, choices, display, fallback] = CHOICE_SPEC[key]!
      expect({ label, choices: [...choices], display: { ...display }, default: fallback }).toEqual(want)
    }
    expect(Object.keys(CHOICE_SPEC).sort()).toEqual(Object.keys(G.choice_spec).sort())
  })

  it('消融掉的键**一个都没登记** —— 「少了」与「漏了」分得开', () => {
    for (const key of G.ablated_keys) {
      expect(CONFIG_SPEC[key], `${key} 不该登记（消融名单里）`).toBeUndefined()
      expect(CHOICE_SPEC[key], `${key} 不该登记（消融名单里）`).toBeUndefined()
    }
  })

  it('`specDefault` 逐格', () => {
    for (const [key, want] of Object.entries(G.spec_default)) {
      expect(specDefault(key), key).toEqual(want)
    }
  })
})

/**
 * **本仓比旧仓严的那一格**，登记在这里而不是悄悄过。
 *
 * Python 的 `float(True)` 是 `1.0`、`int(False)` 是 `0` —— 于是一个布尔型的
 * `z_recede_min_nm` 会被洗成 `1.0 nm` 并**当成一个真的阈值用**。本仓一律丢
 * （同 `scalarFloat` / `pyFloat`：D-VAC-4 那条「早拦一步，让『这不是一个阈值』
 * 在它第一次出现的地方就成立」）。
 */
const STRICTER: Record<string, Record<string, unknown>> = { bool_dropped: {} }

describe('仪器档案 · `sanitize` 逐格对旧仓', () => {
  const keep = new Set([...Object.keys(CONFIG_SPEC), ...Object.keys(CHOICE_SPEC), ...CALIB_KEYS])
  for (const [name, want] of Object.entries(G.sanitize)) {
    it(name, () => {
      const raw = RAW[name]
      const got = sanitizeProfile(raw)
      // 导出那侧只留本仓登记的键（消融掉的那一半不参与比对）。
      const kept = Object.fromEntries(Object.entries(got).filter(([k]) => keep.has(k)))
      const ours = STRICTER[name]
      if (ours === undefined) {
        expect(kept).toEqual(want)
      } else {
        expect(kept).toEqual(ours)
        // 旧仓那一侧也钉住 —— 差异消失时这条登记会变红，而不是安静地留着。
        expect(want).not.toEqual(ours)
      }
    })
  }
})

/** 与 `export_instrument_profile.py` 的 `SANITIZE_CASES` **逐条同形**。 */
const RAW: Record<string, unknown> = {
  not_a_dict: 'nope',
  none: null,
  empty: {},
  unknown_keys_dropped: { nope: 1, qplus_f0_hz: 32768.0, qplus_q: 24000.0 },
  clamped_high: { z_recede_min_nm: 1e9, retract_step_max: 99999 },
  clamped_low: { z_recede_min_nm: -5.0, xy_prewithdraw_steps: -1 },
  int_truncates: { retract_total_steps: 7.9, lockin_signal_index: 12.5 },
  nan_and_inf_dropped: { z_recede_min_nm: Number.NaN, z_settle_timeout_s: Number.POSITIVE_INFINITY },
  empty_string_dropped: { z_recede_min_nm: '', retract_motor_dir: '' },
  blank_string_dropped: { z_recede_min_nm: '   ', tilt_cal_g11: ' ' },
  bool_dropped: { z_recede_min_nm: true, retract_total_steps: false },
  none_dropped: { z_recede_min_nm: null },
  numeric_string_coerced: { z_recede_min_nm: '3.5' },
  bad_choice_dropped: { retract_motor_dir: 'x+', z_extend_sign: '0' },
  good_choice_trimmed: { retract_motor_dir: ' z- ', z_extend_sign: '+1' },
  calib_passthrough: {
    tilt_cal_g11: 1.0, tilt_cal_g12: 0.0, tilt_cal_g21: 0.0, tilt_cal_g22: 1.0,
    tilt_cal_cond: 1.0, tilt_cal_updated_at: 1.0,
  },
  calib_junk_dropped: { tilt_cal_g11: 'abc', tilt_cal_cond: Number.NaN },
  filled: {
    retract_motor_dir: 'z-', z_extend_sign: '-1',
    z_recede_min_nm: 2.5, z_settle_timeout_s: 9.0,
    retract_total_steps: 111, retract_step_max: 100,
    xy_prewithdraw_steps: 11, xy_move_chunk_steps: 10,
    lockin_signal_index: 86, preamp_full_scale_a: 1e-8,
  },
  // ── 批 7a-2：地图层那几个键 ─────────────────────────────────────────
  map_keys_clamped: {
    scan_spacing_factor: 0.5, avoid_radius_pulse_nm: -10.0, avoid_radius_crash_nm: 1e9,
  },
  map_choices: {
    xy_coarse_motion: 'no', approach_damages_surface: ' no ',
    scan_path_strategy: 'perimeter_inward',
  },
  map_choices_bad: {
    xy_coarse_motion: 'maybe', approach_damages_surface: 'NO', scan_path_strategy: 'spiral',
  },
  center_zone_side_nm_dropped: { center_zone_side_nm: 500.0 },
}

const FILLED = RAW['filled'] as Record<string, unknown>

describe('仪器档案 · `getConfig` 的三级回落', () => {
  const profiles: Record<string, Record<string, unknown>> = {
    empty_profile_spec_default: {},
    empty_profile_no_spec_default: {},
    empty_profile_caller_default: {},
    empty_profile_unknown_key: {},
    unregistered_nominal_key: {},
    filled_wins: FILLED,
    choice_spec_default: {},
    choice_filled: FILLED,
    z_extend_sign_spec_default_is_not_neutral: {},
    // ── 批 7a-2 ──
    pulse_radius_spec_default_shadows_the_caller: {},
    pulse_radius_from_profile: { avoid_radius_pulse_nm: 500.0 },
    center_zone_side_nm_is_unregistered: { center_zone_side_nm: 500.0 },
    xy_coarse_motion_default: {},
    approach_damages_default_is_unknown: {},
    scan_path_strategy_default_is_auto: {},
    scan_spacing_factor_default: {},
  }
  for (const [name, want] of Object.entries(G.get_config)) {
    it(name, () => {
      install(profiles[name]!)
      expect(getConfig(want.key, want.default)).toEqual(want.value)
    })
  }

  it('宿主没接读口 ⇒ 仍然是**出厂默认生效**，闸照常关（同 D-VAC-1）', () => {
    processInstrumentProfile.source = null
    expect(getConfig('z_recede_min_nm', null)).toBe(1.0)
    expect(getConfigNum('z_settle_timeout_s', 20.0)).toBe(20.0)
  })

  it('读口抛了 ⇒ 同样退回出厂默认，而 `readProfile` 会说出原因', () => {
    processInstrumentProfile.source = () => {
      throw new Error('存储挂了')
    }
    expect(getConfig('z_recede_min_nm', null)).toBe(1.0)
    const r = readProfile()
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.why).toContain('读不到仪器档案')
    expect(r.ok === false && r.why).toContain('存储挂了')
  })

  it('`getConfigNum` 读到一个非数值时退回调用方的默认，**不是 0**', () => {
    install({ ...FILLED, z_recede_min_nm: 'fast' } as Record<string, unknown>)
    // `sanitize` 先把它丢掉 ⇒ 落到出厂默认 1.0，而不是 `Number('fast')` 的 NaN。
    expect(getConfigNum('z_recede_min_nm', 7.0)).toBe(1.0)
  })
})

describe('仪器档案 · `z_extend_sign` 三态', () => {
  const profiles: Record<string, Record<string, unknown>> = {
    never_declared: {},
    declared_plus: { z_extend_sign: '+1' },
    declared_minus: { z_extend_sign: '-1' },
    junk_is_not_declared: { z_extend_sign: '0' },
    other_keys_only: { ...FILLED, z_extend_sign: '' },
  }
  for (const [name, want] of Object.entries(G.z_extend_sign_or_none)) {
    it(name, () => {
      install(profiles[name]!)
      expect(zExtendSignOrNone()).toEqual(want)
    })
  }

  it('**宿主没接读口 ⇒ `null`，不是出厂 `+1`**', () => {
    processInstrumentProfile.source = null
    // 出厂默认在这一项上不中性：它是两个互斥答案里的一个，而本机实测是 `-1`。
    // 猜成 receding 的代价是「针尖在靠近却说在远离」，然后梯子照爬到 89 步。
    expect(specDefault('z_extend_sign')).toBe('+1')
    expect(zExtendSignOrNone()).toBeNull()
  })

  it('读口抛了 ⇒ 也是 `null`（读不到就是不知道）', () => {
    processInstrumentProfile.source = () => {
      throw new Error('boom')
    }
    expect(zExtendSignOrNone()).toBeNull()
  })
})

describe('仪器档案 · 退针方向码', () => {
  const profiles: Record<string, Record<string, unknown>> = {
    never: {}, z_plus: { retract_motor_dir: 'z+' },
    z_minus: { retract_motor_dir: 'z-' }, junk: { retract_motor_dir: 'x+' },
  }
  for (const [name, want] of Object.entries(G.retract_dir_code)) {
    it(name, () => {
      install(profiles[name]!)
      expect(getRetractDirCode()).toBe(want)
    })
  }
})

describe('仪器档案 · 倾斜标定的三态', () => {
  const profiles: Record<string, Record<string, unknown>> = {
    never: {},
    three_of_four_is_never: { tilt_cal_g11: 1.0, tilt_cal_g12: 0.0, tilt_cal_g21: 0.0, tilt_cal_cond: 1.0 },
    full: {
      tilt_cal_g11: -1.02, tilt_cal_g12: 0.07, tilt_cal_g21: 0.03, tilt_cal_g22: -0.98,
      tilt_cal_cond: 1.1128, tilt_cal_updated_at: 1_699_000_000.0,
    },
    full_without_cond_or_stamp: { tilt_cal_g11: 1.0, tilt_cal_g12: 0.0, tilt_cal_g21: 0.0, tilt_cal_g22: 1.0 },
  }
  for (const [name, want] of Object.entries(G.tilt_calibration)) {
    it(name, () => {
      install(profiles[name]!)
      const got = getTiltCalibration()
      if (want === null) {
        // 旧仓的 `None` = **从未标定过**（它读得到档案）。
        expect(got.state).toBe('never')
        return
      }
      expect(got.state).toBe('ok')
      if (got.state !== 'ok') return
      expect(got.g.map((r) => [...r])).toEqual(want.g)
      expect(got.cond).toEqual(want.cond)
      expect(got.updatedAt).toEqual(want.updated_at)
    })
  }

  it('**宿主没接读口 ⇒ `unreadable`，不是 `never`**', () => {
    processInstrumentProfile.source = null
    const got = getTiltCalibration()
    expect(got.state).toBe('unreadable')
    expect(got.state === 'unreadable' && got.why).toBe(NO_PROFILE_SOURCE)
    // 这两句话是这一批的全部要害：处置完全不同。
    expect(NO_PROFILE_SOURCE).toContain('这不等于「从未标定过」')
  })

  it('读口抛了 ⇒ `unreadable` 并带上**为什么**', () => {
    processInstrumentProfile.source = () => {
      throw new Error('ENOENT: ui_settings.json')
    }
    const got = getTiltCalibration()
    expect(got.state).toBe('unreadable')
    expect(got.state === 'unreadable' && got.why).toContain('ui_settings.json')
  })
})

describe('仪器档案 · 接触点 dI/dV', () => {
  const profiles: Record<string, Record<string, unknown>> = {
    never: {},
    filled: {
      didv_at_contact_v: 2.5e-3, didv_cal_bias_v: 0.05, didv_cal_setpoint_a: 1e-10,
      didv_cal_mod_amp_v: 0.02, didv_cal_updated_at: 1_699_996_400.0,
    },
    partial: { didv_cal_bias_v: 0.05 },
  }
  for (const [name, want] of Object.entries(G.calibration)) {
    it(name, () => {
      install(profiles[name]!)
      const r = getCalibration()
      expect(r.ok).toBe(true)
      expect(r.ok === true && r.cal).toEqual(want)
    })
  }

  it('宿主没接读口 ⇒ `ok: false` + 理由（**不是一份空标定**）', () => {
    processInstrumentProfile.source = null
    const r = getCalibration()
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.why).toBe(NO_PROFILE_SOURCE)
  })
})
