/**
 * z(t) 跳变判定 —— 对 `spec/golden/z_trace.json` 逐格回放，外加几条金样说不出的。
 *
 * 金样由旧仓真实现跑出来（`tools/spec-export/export_z_trace.py`），它是**第二台
 * 驱动器**：通用轨迹金样那边喂的是常数回包，于是这一族只走得到 `none` / `no_press`
 * 一条路；这里手搭曲线，一条判据一格。
 *
 * 逐位相等而不是 `toBeCloseTo`：这里面有 `2.1e-28` 这种纯浮点残渣（MAD 在一段
 * 周期性噪声上的结果），一个近似比较会把「算法一样」和「算法差一步」判成同一件事。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_BACK_K,
  CURRENT_PRESSED_K,
  DEFAULT_JUMP_K,
  MIN_FEEDBACK_SEGMENT_S,
  MIN_SAMPLES_FOR_MAD,
  MIN_WINDOW_SAMPLES,
  baselineSigma,
  detectJumps,
  feedbackRestoredT,
  indentVerdict,
  indentVerdictFields,
  jumpReportFields,
  madDiffSigma,
  maxGap,
  median,
  pyFixed,
  std,
  stepVerdict,
  stepVerdictFields,
} from './index.js'

interface Golden {
  constants: Record<string, number>
  scalars: Record<
    string,
    { xs: number[]; median: number; std: number; mad_diff_sigma: number; baseline_sigma: number }
  >
  max_gap: { name: string; times: number[]; out: number }[]
  detect_jumps: {
    name: string
    samples: number[]
    times: number[]
    k: number
    out: Record<string, unknown>
  }[]
  feedback_restored_t: {
    name: string
    current_s: number[]
    current_t: number[]
    event_start_t: number
    t: number | null
    why: string
  }[]
  step_verdict: {
    name: string
    note: string
    samples: number[]
    times: number[]
    event_start_t: number | null
    post_roll_s: number
    tol_k: number
    tol_abs_m: number
    with_current: boolean
    current_s?: number[]
    current_t?: number[]
    out: Record<string, unknown>
  }[]
  indent_verdict: {
    name: string
    samples: number[]
    times: number[]
    current_s: number[] | null
    current_t: number[] | null
    event_start_t: number | null
    post_roll_s: number
    tol_k: number
    tol_abs_m: number
    out: Record<string, unknown>
  }[]
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../spec/golden/z_trace.json', import.meta.url)), 'utf8'),
) as Golden

describe('阈值常量 —— 每一个都有来历，不许悄悄漂', () => {
  it('与旧仓逐个相等', () => {
    expect({
      DEFAULT_JUMP_K,
      MIN_SAMPLES_FOR_MAD,
      MIN_WINDOW_SAMPLES,
      MIN_FEEDBACK_SEGMENT_S,
      CURRENT_BACK_K,
      CURRENT_PRESSED_K,
    }).toEqual(golden.constants)
  })
})

describe('标量：median / std / MAD / baselineSigma', () => {
  for (const [name, c] of Object.entries(golden.scalars)) {
    it(`${name}（n=${c.xs.length}）`, () => {
      expect(median(c.xs)).toBe(c.median)
      expect(std(c.xs)).toBe(c.std)
      expect(madDiffSigma(c.xs)).toBe(c.mad_diff_sigma)
      expect(baselineSigma(c.xs)).toBe(c.baseline_sigma)
    })
  }

  it('**退化保护不是装饰**：量化到同一台阶的基线 MAD 恰好为 0，回落到标准差', () => {
    // 不回落的话容差塌成 0，之后任何一点点差异都会被判成「变了」。
    const q = golden.scalars['quantised']!
    expect(madDiffSigma(q.xs)).toBe(0)
    expect(baselineSigma(q.xs)).toBe(std(q.xs))
  })

  it('**差分先把慢漂移消掉**：爬升的基线上 MAD 远小于标准差', () => {
    const d = golden.scalars['drifting']!
    expect(madDiffSigma(d.xs)).toBeLessThan(std(d.xs) / 5)
    expect(baselineSigma(d.xs)).toBe(madDiffSigma(d.xs))
  })

  it('样本少于两个 ⇒ 三个统计量全是 0（不是 NaN）', () => {
    for (const xs of [[], [1.5]]) {
      expect(std(xs)).toBe(0)
      expect(madDiffSigma(xs)).toBe(0)
      expect(baselineSigma(xs)).toBe(0)
    }
  })
})

describe('maxGap —— **每一条返回路径都要带上它**', () => {
  for (const c of golden.max_gap) {
    it(c.name, () => {
      expect(maxGap(c.times)).toBe(c.out)
    })
  }
})

describe('detectJumps', () => {
  for (const c of golden.detect_jumps) {
    it(`${c.name}（k=${c.k}）`, () => {
      expect(jumpReportFields(detectJumps(c.samples, c.times, c.k))).toEqual(c.out)
    })
  }

  it('缺省 k 就是 `DEFAULT_JUMP_K`', () => {
    const c = golden.detect_jumps.find((x) => x.name === 'one_step')!
    expect(jumpReportFields(detectJumps(c.samples, c.times))).toEqual(c.out)
  })

  it('**斜坡不是跳变**：σ=0 时阈值回落到 median(|Δ|)，平滑斜坡因此安静', () => {
    const c = golden.detect_jumps.find((x) => x.name === 'clean_ramp')!
    expect(detectJumps(c.samples, c.times).count).toBe(0)
  })
})

describe('feedbackRestoredT —— **用电流定位，不用声明的分段边界**', () => {
  for (const c of golden.feedback_restored_t) {
    it(`${c.name} → ${c.why}`, () => {
      const got = feedbackRestoredT(c.current_s, c.current_t, c.event_start_t)
      expect(got.t).toBe(c.t)
      expect(got.why).toBe(c.why)
    })
  }

  it('**`no_press` 与 `no_return` 是两句话** —— 指向完全不同的下一步', () => {
    // 合成一个词的代价：一个说「这一发可能没压到表面」（照判），一个说
    // 「采集在反馈接管之前就结束了」（判不了）。
    const press = golden.feedback_restored_t.find((c) => c.name === 'no_press')!
    const ret = golden.feedback_restored_t.find((c) => c.name === 'no_return')!
    expect(press.why).not.toBe(ret.why)
    expect(feedbackRestoredT(press.current_s, press.current_t, press.event_start_t).why).toBe(
      'no_press',
    )
    expect(feedbackRestoredT(ret.current_s, ret.current_t, ret.event_start_t).why).toBe('no_return')
  })
})

function runStep(c: Golden['step_verdict'][number]): Record<string, unknown> {
  return stepVerdictFields(
    stepVerdict(c.samples, c.times, c.event_start_t, {
      postRollS: c.post_roll_s,
      tolK: c.tol_k,
      tolAbsM: c.tol_abs_m,
      ...(c.with_current ? { currentS: c.current_s, currentT: c.current_t } : {}),
    }),
  )
}

describe('stepVerdict —— 逐格对旧仓', () => {
  for (const c of golden.step_verdict) {
    it(`${c.name}：${c.note}`, () => {
      expect(runStep(c)).toEqual(c.out)
    })
  }
})

describe('stepVerdict 的几条要害，单独说一遍', () => {
  const byName = new Map(golden.step_verdict.map((c) => [c.name, c]))

  it('**第三段按构造等于基线**：同一条曲线，给电流说「判不了」，不给电流说「没扎上」', () => {
    // 2026-08-20 的 168 条历史曲线里 160 条是这个形状，而它们当时全都给出了确定的判定。
    // 真簇被这样判掉了 62%。
    const withCur = byName.get('seg4_too_short_with_current')!
    const without = byName.get('seg4_too_short_without_current')!
    expect(withCur.samples).toEqual(without.samples) // 就是同一条曲线
    expect(runStep(withCur)['direction']).toBe('insufficient_data')
    expect(runStep(withCur)['reason']).toBe('feedback_segment_too_short')
    expect(runStep(without)['direction']).toBe('none')
  })

  it('**判不了那一句要说清下一步** —— 而且方向正好相反', () => {
    const a = runStep(byName.get('seg4_too_short_with_current')!)
    expect(String(a['advice'])).toContain('不要据此加大扎入深度')
    expect(String(a['advice'])).toContain('post_roll_s')
  })

  it('`no_return`：电流升上去了、再没回来 ⇒ 判不了，理由与 `too_short` 不是同一个', () => {
    const r = runStep(byName.get('seg4_not_captured')!)
    expect(r['reason']).toBe('feedback_segment_not_captured')
    expect(r['feedback_restored_t']).toBeNull()
  })

  it('后窗被一次超长往返饿死 ⇒ **往回够到下限**，并把这件事标出来', () => {
    const r = runStep(byName.get('post_window_starved')!)
    expect(r['post_window_starved']).toBe(true)
    expect(r['n_post']).toBe(MIN_WINDOW_SAMPLES)
    // 扩窗是对判据的修复，**不是对卡顿的修复** —— 那一次往返仍然被报出去
    expect(Number(r['max_gap_s'])).toBeGreaterThan(9)
  })

  it('**前窗刻意不兜底**：基线真的不够时，`insufficient_data` 是实话', () => {
    const r = runStep(byName.get('no_pre')!)
    expect(r['direction']).toBe('insufficient_data')
    expect(r['n_pre']).toBe(0)
    expect(r['post_window_starved']).toBe(false)
  })

  it('判不出来的那几条**也带诊断** —— 那正是最需要它们的时刻', () => {
    for (const n of ['no_event', 'too_few_samples', 'no_pre']) {
      const r = runStep(byName.get(n)!)
      for (const k of ['n_pre', 'n_post', 'post_window_starved', 'post_window_s', 'max_gap_s']) {
        expect(Object.keys(r), `${n} 少了 ${k}`).toContain(k)
      }
    }
  })

  it('`zMin` 只作记录，**不参与判定**：扎到 −2 nm 而判定说 up', () => {
    const r = runStep(byName.get('seg4_located')!)
    expect(r['direction']).toBe('up')
    expect(Number(r['z_min_m'])).toBeLessThan(-1e-9) // 过程里的瞬态
    expect(Number(r['delta_m'])).toBeCloseTo(269e-12, 13) // 结果
  })

  it('`tol = max(tolAbsM, tolK·σ)` —— 两侧各说了算一次', () => {
    expect(runStep(byName.get('tol_abs_swallows')!)['direction']).toBe('none')
    expect(runStep(byName.get('tol_k_dominates')!)['direction']).toBe('up')
  })

  it('`times` 为空时不崩 —— 旧仓那里是一次 IndexError', () => {
    // 调用方永远成对地喂这两条表，所以这条折进「数据不够」那道早退，
    // 而不是复制一次崩溃。
    const r = stepVerdict([1, 2, 3, 4], [], 0.5, { postRollS: 0.1 })
    expect(r.direction).toBe('insufficient_data')
    expect(r.maxGapS).toBe(0)
  })
})

describe('indentVerdict —— 扎针那一层的读法', () => {
  for (const c of golden.indent_verdict) {
    it(`${c.name}`, () => {
      const got = indentVerdictFields(
        indentVerdict(c.samples, c.times, c.event_start_t, {
          postRollS: c.post_roll_s,
          tolK: c.tol_k,
          tolAbsM: c.tol_abs_m,
          ...(c.current_s !== null && c.current_t !== null
            ? { currentS: c.current_s, currentT: c.current_t }
            : {}),
        }),
      )
      expect(got).toEqual(c.out)
    })
  }

  it('**剥掉的只有两个键**：`direction` 与 `z_max_m`，诊断一个都不剥', () => {
    const c = golden.indent_verdict.find((x) => x.name === 'cluster')!
    const iv = indentVerdict(c.samples, c.times, c.event_start_t, {
      postRollS: c.post_roll_s,
      tolK: c.tol_k,
      tolAbsM: c.tol_abs_m,
      currentS: c.current_s!,
      currentT: c.current_t!,
    })
    const step = stepVerdictFields(iv.step)
    const ind = indentVerdictFields(iv)
    expect(Object.keys(step).filter((k) => !(k in ind))).toEqual(['direction', 'z_max_m'])
    // 判得出来那一支本来没有 `advice`（判据不发议论），本层加上它与 `verdict`
    expect(Object.keys(ind).filter((k) => !(k in step))).toEqual(['verdict', 'advice'])
  })

  it('`too_short` **自带**一句具体的下一步，不被默认那句顶掉（`setdefault` 的语义）', () => {
    const c = golden.indent_verdict.find((x) => x.name === 'insufficient_too_short')!
    const out = c.out as { advice: string }
    expect(out.advice).toContain('不要据此加大扎入深度')
    // 默认那句「增大扎入深度」在这种情形下正好是**错的方向**
    expect(out.advice).not.toContain('没扎上 —')
  })

  it('判不了、而且连电流都没有 ⇒ advice 回落到「没扎上」那一句', () => {
    const c = golden.indent_verdict.find((x) => x.name === 'insufficient_no_event')!
    expect((c.out as { advice: string }).advice).toContain('没扎上')
  })
})

describe('pyFixed —— 语言分歧一族的第六个', () => {
  it('**半分点上 Python 取偶，`toFixed` 取大**', () => {
    // 3 位小数的半分点恰好是 1/16 的奇数倍，全是二进制精确表示的数。
    expect(pyFixed(0.0625, 3)).toBe('0.062')
    expect((0.0625).toFixed(3)).toBe('0.063') // 两者确实不一样
    expect(pyFixed(0.1875, 3)).toBe('0.188') // 0.187|5 → 取偶得 188
    expect(pyFixed(0.3125, 3)).toBe('0.312')
    expect(pyFixed(0.5, 0)).toBe('0')
    expect(pyFixed(1.5, 0)).toBe('2')
    expect(pyFixed(-0.0625, 3)).toBe('-0.062')
  })

  it('不在半分点上就是普通的正确舍入', () => {
    expect(pyFixed(0.0126, 3)).toBe('0.013')
    expect(pyFixed(10.000000000000002, 0)).toBe('10')
    expect(pyFixed(0.25, 2)).toBe('0.25')
    expect(pyFixed(1 / 3, 4)).toBe('0.3333')
  })

  it('非有限值印成 Python 的写法', () => {
    expect(pyFixed(Number.NaN, 2)).toBe('nan')
    expect(pyFixed(Number.POSITIVE_INFINITY, 2)).toBe('inf')
    expect(pyFixed(Number.NEGATIVE_INFINITY, 2)).toBe('-inf')
  })

  it('金样里那一格就是半分点 —— 它印的是 `0.062`', () => {
    const c = golden.step_verdict.find((x) => x.name === 'seg4_exact_sixteenth')!
    expect(String((c.out as { advice: string }).advice)).toContain('只录到 0.062 s')
  })
})
