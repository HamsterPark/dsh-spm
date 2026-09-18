/**
 * `ReadCalibrations` —— 让 agent 读到**自己正在依赖的那些标定值**。只读窗口。
 *
 * ## 为什么存在（2026-08-10 真机）
 *
 * `TiltCalibrate` 把 2×2 响应矩阵写进仪器档案，而回包里**只有条件数和两个幅度** ——
 * **矩阵本体拿不到，而且树里没有任何只读途径能把它读出来**。团队负责人当晚是
 * **直接 ssh 去读 `ui_settings.json`** 才拿到那四个数的。
 *
 * ⇒ 一个**被写下来、会驱动硬件、却没有任何程序化途径能读出来**的标定值。
 * 这与「零可达调用方」同族，只是反过来：**写入方有，读出方没有。**
 *
 * 而 agent 侧的后果更具体：`AutoTilt` 在没有标定时**拒绝运行**，却**说不出
 * 「我看到的标定是什么」**。判据一句话（团队负责人）：
 *
 * > **一个标定值如果不能被读出来核对，它就没法被验证。**
 *
 * 当晚正是因为**读到了**那四个数，才发现它和从另一条路反推的矩阵**符号不一致** ——
 * 读不到的话，所有人会一直以为「标定过了」。
 *
 * ## 这个技能的全部价值：**区分两种否定**
 *
 * 「**从未标定过**」 vs 「**读不到档案**」——「该去做的事完全不同」。
 * 内核的 `getTiltCalibration()` 是三态（`ok` / `never` / `unreadable`），
 * 这里只负责把那三态翻成三句不同的话。**绝不塞一个空对象冒充。**
 *
 * ⚠️ 与旧仓的差别在这里：旧仓没有存储时三块**全走 `except`**，恒说后者；
 * 本仓如果把「宿主没接存储」折成一个空档案，就会恒说**前者** —— 一样是假话。
 * 所以内核那一侧把「没接读口」做成了一个可以说出口的状态（`NO_PROFILE_SOURCE`）。
 *
 * ## 这个技能**不做**什么
 *
 * 不写任何东西、不碰硬件、不发 TCP、不解除任何拦截。它读的是**进程内的仪器档案**，
 * 而那份档案本身由宿主负责持久化（同 D-PRESET-2）。
 *
 * **不新写 getter** —— 用的全是档案里已有的读法。缺的从来不是 getter，
 * 是「从外面能调到」。
 */
import {
  TILT_CAL_MAX_COND,
  formatG,
  getCalibration,
  getTiltCalibration,
  processInstrumentProfile,
  readProfile,
  type Skill,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { formatG6, ok } from './common.js'

/** 两位小数（Python `f"{x:.1f}"` / `:.0f` 一族用 `toFixed`，半偶差异见交接 §6）。 */
function fixed(v: number, n: number): string {
  return v.toFixed(n)
}

/** Python `time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))`。**本地时区**。 */
function localStamp(tsS: number): string {
  const d = new Date(tsS * 1000)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/**
 * 标定的年龄。**读不到时间戳是一句话，不是 0。**
 *
 * 「没有时间戳」和「刚刚标定的」在报文里绝不能长得一样 —— 后者是结论，
 * 前者是「这个问题答不了」。
 */
export function ageNote(updatedAt: unknown): Record<string, unknown> {
  const noStamp = {
    updated_at: null,
    age_s: null,
    age_note: '**这条标定没有时间戳** —— 无法判断它是什么时候做的。',
  }
  if (typeof updatedAt === 'boolean' || updatedAt === null || updatedAt === undefined) return noStamp
  const ts = typeof updatedAt === 'number' ? updatedAt : Number(updatedAt)
  if (!Number.isFinite(ts) || ts <= 0) return noStamp
  const age = Math.max(0.0, processInstrumentProfile.nowS() - ts)
  const days = age / 86400.0
  let human: string
  if (days >= 1.0) human = `${fixed(days, 1)} 天前`
  else if (age >= 3600) human = `${fixed(age / 3600.0, 1)} 小时前`
  else human = `${fixed(age / 60.0, 0)} 分钟前`
  return {
    updated_at: ts,
    age_s: age,
    age_note:
      `标定于 ${localStamp(ts)}(${human})。` +
      (days >= 1.0 ? '**换过样品/托架之后这条就失效了** —— 倾斜响应是样品与托架的属性。' : ''),
  }
}

/**
 * 条件数说明 —— **连同它管不了的那一半**。
 *
 * ## 这一句是用一次发散换来的（2026-08-10 真机）
 *
 * 当晚 `AutoTilt` 实测发散（`rolled_back(diverged)`），而档案里的条件数是 **1.1128**
 * —— 一个非常漂亮的数。根因是**方向**：`TiltCalibrate` 存的是 `M = ∂斜率/∂倾斜`，
 * 而 `AutoTilt` 的更新规则需要的是 `−M⁻¹`；用存着的那个 G 算谱半径 = 1.984（发散），
 * 用 `−Gᵀ` = 0.211（收敛）。
 *
 * **条件数只描述矩阵的形状（两个轴的响应有没有几乎共线），它对符号和求逆一无所知。**
 * 一份只报条件数的标定报告，会让读它的人（和 agent）得出「标定良好」这个**错误结论**
 * —— 而那正是当晚发生的事。所以这里永远把两句话一起说。
 */
export function condNote(cond: unknown): string {
  const c = typeof cond === 'number' ? cond : Number(cond)
  if (typeof cond === 'boolean' || cond === null || cond === undefined || !Number.isFinite(c)) {
    return '条件数读不到 —— **这不等于标定良好**,是这一项答不了。'
  }
  const verdict =
    c <= TILT_CAL_MAX_COND ? '形状健全' : `**形状可疑**(超过拒绝写入线 ${formatG6(TILT_CAL_MAX_COND)})`
  return (
    `条件数 ${formatG(c, 4)} —— ${verdict}。` +
    '⚠️ **条件数只管形状,不管方向**:它说的是两个轴的响应有没有几乎共线,' +
    '**对符号与求逆一无所知**。2026-08-10 真机上条件数 1.1128(很漂亮)而 ' +
    'AutoTilt 仍然发散,根因是用了 M 而不是 −M⁻¹。' +
    '**别把一个好看的条件数读成「标定良好」。**'
  )
}

/** 倾斜响应标定。三态各一句话。 */
export function tiltBlock(): Record<string, unknown> {
  const cal = getTiltCalibration()
  if (cal.state === 'unreadable') return { available: false, why: cal.why }
  if (cal.state === 'never') {
    return {
      available: false,
      // ⚠️「没标定过」是一个**结论**，不是「读失败」。两者必须分开 ——
      // 合成一句会让「该去标定」和「该去查为什么读不到」变成同一件事。
      why:
        '**从未标定过倾斜响应**(不是读取失败)。' +
        'AutoTilt 因此一律跳过 —— 它绝不带着猜来的符号去动硬件。' +
        '要标定:运行 TiltCalibrate。',
    }
  }
  return {
    available: true,
    why: '',
    g: [[cal.g[0][0], cal.g[0][1]], [cal.g[1][0], cal.g[1][1]]],
    cond: cal.cond,
    ...ageNote(cal.updatedAt),
    cond_note: condNote(cal.cond),
    // ⚠️ 2026-08-11 更正：这句话在 08-10 修完之后就变成了假话，而它正是写来防那次
    // 事故的 —— 它说存的是 M(=∂斜率/∂倾斜)，而从那次起存的已经是 **G = −M⁻¹**。
    // 任何一个信了旧措辞、自己再做一次 −M⁻¹ 的消费方会**二次求逆**，
    // 把 08-10 那次发散原样请回来。
    //
    // **修好之后旧的理由会静静变成假话，而它比没有理由更危险：下一个人会信它。**
    convention_note:
      '存的是 **G = −M⁻¹**(按行的 2×2),其中 M = ∂斜率/∂倾斜。' +
      '**直接用**:要抵消测到的斜率 s,施加 `Δtilt = G·s` —— 不要再求逆、不要再取负。' +
      '(08-10 那次发散正是「存的是 M、需要的是 −M⁻¹」;修的是存储端,' +
      '而这句说明直到 08-11 才跟上。)',
  }
}

/** 接触点 dI/dV 标定（进针学到的）。档案在但这一项从未写过 = 从未标定。 */
export function didvBlock(): Record<string, unknown> {
  const r = getCalibration()
  if (!r.ok) return { available: false, why: r.why }
  const cal = r.cal
  const v = cal['didv_at_contact_v']
  if (v === undefined || v === null || v === 0) {
    return {
      available: false,
      why: '**从未学到过接触点 dI/dV**(不是读取失败)。一次成功进针会写入它。',
    }
  }
  return {
    available: true,
    why: '',
    didv_at_contact_v: v,
    // 条件绑定：一个 dI/dV 值离开它的偏压/设定点就没有意义。
    measured_at_bias_v: cal['didv_cal_bias_v'] ?? null,
    measured_at_setpoint_a: cal['didv_cal_setpoint_a'] ?? null,
    mod_amp_v: cal['didv_cal_mod_amp_v'] ?? null,
    ...ageNote(cal['didv_cal_updated_at']),
    condition_note: '这个值**绑定在它被测出来的那个偏压/设定点上** —— 换了条件就不可比。',
  }
}

/**
 * qPlus 实测共振（`AcquirePLLFreqSweep` 写入）。
 *
 * ⚠️ **标称那一对（`qplus_f0_hz` / `qplus_q`）不移植**，见 D-CAL-* 那条登记：
 * 它们住在**针尖登记表**那一行上，而旧仓这里是用 `get_config` 去仪器档案里取的 ——
 * 那两个键从来没在档案的键表里注册过，`sanitize()` 会静默丢掉它们，
 * 于是**旧仓这两个字段恒为 `None`**。接一个永远返回空的读口，
 * 等于给下一个人留一条永远不亮的分支（同 D-CRASH-3）。
 */
export function qplusBlock(): Record<string, unknown> {
  const r = readProfile()
  if (!r.ok) return { available: false, why: r.why }
  const f0 = r.profile['qplus_f0_measured_hz'] ?? null
  const q = r.profile['qplus_q_measured'] ?? null
  if (f0 === null && q === null) {
    return {
      available: false,
      why: '**从未实测过 qPlus 共振**(不是读取失败)。运行 AcquirePLLFreqSweep 会写入它。',
    }
  }
  const out: Record<string, unknown> = {
    available: true,
    why: '',
    f0_measured_hz: f0,
    q_measured: q,
    ...ageNote(r.profile['qplus_fq_updated_at']),
  }
  // ring-down 时间常数 τ = Q/(π f₀)。给出来是因为「等振幅回到基线」的超时该按它定，
  // 而 Q 在这台机器上跨了 40 倍(5e3 ~ 2e5)，**所以固定时长是错的** ——
  // 这一句就是为了让读的人别去写一个固定值。
  if (typeof f0 === 'number' && f0 !== 0 && typeof q === 'number' && q !== 0) {
    const tau = q / (3.141592653589793 * f0)
    out['ring_down_tau_s'] = tau
    out['ring_down_note'] =
      `τ = Q/(π·f₀) ≈ ${formatG(tau, 3)} s。**别据此写一个固定等待时长** —— ` +
      'Q 在本机跨 5e3~2e5(τ 0.06~2.5 s),要等就等**振幅回到基线**(带超时)。'
  }
  return out
}

const BLOCKS: Readonly<Record<string, () => Record<string, unknown>>> = {
  tilt: tiltBlock,
  didv: didvBlock,
  qplus: qplusBlock,
}

export const ReadCalibrations: Skill = {
  spec: S.ReadCalibrationsSpec,
  execute: (_ctx, params): Promise<SkillResultLike> => {
    const which = String(params['which'] ?? '').trim().toLowerCase()
    const wanted = which in BLOCKS ? [which] : Object.keys(BLOCKS)

    const data: Record<string, unknown> = {}
    for (const key of wanted) {
      try {
        data[key] = (BLOCKS[key] as () => Record<string, unknown>)()
      } catch (exc) {
        // 一项读不到不影响其余。
        data[key] = { available: false, why: `读取失败: ${String(exc)}` }
      }
    }

    const have = wanted.filter((k) => (data[k] as Record<string, unknown> | undefined)?.['available'] === true)
    const missing = wanted.filter((k) => !have.includes(k))
    let summary: string
    if (have.length === 0) {
      // ⚠️ **旧仓这一行是个真缺陷，而且正好是这个技能存在的理由的反面**：
      // 它无条件写「(已确认读到档案,不是读取失败)」。而三块全空最常见的成因恰恰
      // **就是**读不到档案 —— 于是这个专门用来分开两种否定的技能，
      // 在它自己的 summary 里把两者合成了一句，还合成了错的那一句。
      // 本仓先问一次档案读得到读不到，再决定说哪一句（登记：D-CAL-* 那条）。
      const r = readProfile()
      summary = r.ok
        ? '这些标定**一个都没有**:' +
          missing.join('、') +
          '(已确认读到档案,不是读取失败 —— 逐项 why 里写了原因)。'
        : '这些标定一条都读不出来,而原因是**读不到仪器档案本身**:' +
          r.why +
          '**这不是「从未标定过」** —— 先修读档案这条路,再谈标不标定。'
    } else {
      summary = '已标定:' + have.join('、')
      if (missing.length > 0) summary += ';**未标定**:' + missing.join('、')
      const tilt = (data['tilt'] ?? {}) as Record<string, unknown>
      if (tilt['available'] === true) summary += `。倾斜:${String(tilt['age_note'] ?? '')}`
    }
    data['read_at'] = processInstrumentProfile.nowS()
    return Promise.resolve(ok(data, summary))
  },
}

export const CALIBRATIONS: Readonly<Record<string, Skill>> = { ReadCalibrations }
