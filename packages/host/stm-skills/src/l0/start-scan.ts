/**
 * `StartScan` —— 起扫，并且**拒绝发起一次停不下来的扫描**。
 *
 * ## 「一次 start = 一帧」这个前提，以前没有任何人拥有
 *
 * `ScanAt` / `FullScan` / `WaitScanComplete` / 视觉监视器 / 扫描地图登记——全部照着
 * 「一次 `Scan_Action(start)` 等于一帧」写的。而这件事**只在 Nanonis 的 Continuous
 * scan 关着时成立**。
 *
 * 旧仓观测中 `Scan_PropsGet` 的解析崩在 `*+i` 上 ⇒ 读不到
 * 「保存哪些模块参数」清单 ⇒ 整发 `Scan_PropsSet` 都不下 ⇒ continuous 没被关掉 ⇒
 * 每一次 `WaitScanComplete` 都 `outcome=restarted` 并等满超时。而 `StartScan` 本身
 * 报的是 **success**。
 *
 * ## 先查过的：**没有只改一个属性的调用**
 *
 * Nanonis 的 `Scan.*` 一共 17 个函数，**能改 Continuous scan 标志的只有
 * `Scan.PropsSet` 一个**，而它是一发七个实参、模块名数组是其中之一。所以
 * 「绕过模块名数组去单独关掉 continuous」这条路不存在。
 *
 * ## 为什么读不到清单就不敢下发
 *
 * `Scan.PropsSet` 的七个实参里，四个 unsigned int 明确定义了 `0 = no change`；
 * **模块名数组没有任何值被定义为「保持原样」**。在一份对哨兵值如此啰嗦的文档里，
 * 沉默是有含义的。手上最接近的证据指向同一边：同一发里的 Series name 传空串**已知**
 * 会把用户配的文件名前缀打回 `unnamed####`。⇒ 空数组按「清空」预期，不按「不改」。
 * 这是**类比，不是实测**，而它只用于决定「不冒险」，不用于决定去做什么。
 *
 * ## 于是第二层的修法不是「发明一个兜底」，是**不再让扫描静默地跑不完**
 *
 * `Scan_Action(start)` 有一道前置闸：只有在**回读确认 continuous 是关的**时才发。
 * **三态**，不是两态——读不到也拒。出口有三个，而且都是真出口
 * （「能停不能解」是本仓记过的死锁形状）。
 */
import {
  SET_AUTOSAVE_ALL,
  SET_NO_CHANGE,
  SET_OFF,
  continuousState,
  scanPropsContinuous,
  scanPropsModuleCount,
  scanPropsModules,
  scanPropsSeriesName,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'

/**
 * `Scan_PropsGet` 读几次。
 *
 * 只重试**传输/形状**失败。一份解得开但缺字段的回包是那台固件的性质，不是那一刻的
 * 性质，再问一次是「探针不是免费的」那个错误、还没有好处。
 *
 * 上界是 2：真正发生过的那次失败（2026-08-19 的 `*+i` 错解）是**确定性**的，重试它
 * 纯属浪费。一次重试买回的是瞬态那一档，别装作更多。
 */
export const PROPS_GET_ATTEMPTS = 2

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

interface PropsRead {
  readonly body: unknown[] | null
  readonly error: string
}

/** `Scan_PropsGet` → body 或 `null`，附带**说得清是哪一种失败**的一句话。 */
async function readScanProps(ctx: SkillContext): Promise<PropsRead> {
  let error = ''
  for (let attempt = 1; attempt <= PROPS_GET_ATTEMPTS; attempt += 1) {
    const rec = await ctx.safeCall('Scan_PropsGet')
    if (failed(rec)) {
      error = rec.error ?? ''
    } else {
      const body = rec.values ?? null
      if (Array.isArray(body)) return { body, error: '' }
      error = 'Scan_PropsGet 回包读不懂'
    }
  }
  return { body: null, error: error || 'Scan_PropsGet 失败(原因未知)' }
}

export interface ContinuousGateInput {
  readonly stillOn: boolean | null
  readonly override: boolean
  readonly continuousBefore: unknown
  readonly moduleNamesSource: string
  readonly readError: string
  readonly readbackError: string
}

/**
 * 空串 = 可以起扫；否则是「为什么不起」。
 *
 * 规则**有意只有一条**：起扫当且仅当**回读说它是关的**。不从「之前是关的、而且我们
 * 写了关」推断任何东西——那是绕着缺失的证据推理，而不是去把证据取回来。
 *
 * ⚠️ 这段话**分四种，不是两种**。「机器不认这次写入」和「我们根本没写」指向完全不同
 * 的下一步（前者去查仪器/权限，后者去查那次读），而把两者说成同一句话，就是把人送去
 * 查一件没发生的事——本仓在 `WaitScanComplete` 的「中途停止 vs 从没开始」上已经付过
 * 一次这个学费。
 */
export function continuousGate(i: ContinuousGateInput): string {
  if (i.stillOn === false) return ''

  const written = i.moduleNamesSource === 'read' || i.moduleNamesSource === 'read_empty'
  const whyNotWritten =
    `读「保存哪些模块参数」清单失败:${i.readError || '原因未知'} —— 而协议里没有` +
    '「模块名保持原样」这一档,所以整发 Scan_PropsSet 都不敢下,免得清空用户配好的清单'

  let head: string
  if (i.stillOn === true && written) {
    head =
      'Nanonis 的 **Continuous scan 是开着的**,而这次**写了也没关掉**' +
      '(下发 Scan_PropsSet 之后回读仍然是「开」)。'
  } else if (i.stillOn === true) {
    head = `Nanonis 的 **Continuous scan 是开着的**,而这次**根本没能写**(${whyNotWritten})。`
  } else if (written) {
    head =
      `下发了 Scan_PropsSet,但**回读不到** Continuous scan 状态` +
      `(${i.readbackError || '回包里没有这个标志'}),无法确认它已经关掉。`
  } else {
    head = `**读不到** Nanonis 的 Continuous scan 状态,而且这次也没能写(${whyNotWritten})。`
  }

  if (i.override) return ''

  return (
    `${head}\n` +
    '**不发起这次扫描** —— 一次 start 就不再等于一帧:扫描会一帧接一帧地' +
    '跑下去,WaitScanComplete 只能等满超时(outcome=restarted),而 ' +
    'SaveScan / 扫描地图登记拿到的可能是第 N+2 帧。发出去比不发更坏,' +
    '而且坏在看不见的地方。\n' +
    `(读回的 GET 值:before=${String(i.continuousBefore)}, 0=关 1=开;` +
    `模块清单来源=${i.moduleNamesSource})\n` +
    // 三条出口**逐字**。它们是模型读的东西，而且每一条都真的走得通——
    // 「能停不能解」是本仓记过的死锁形状。第 3 条那句「这是用户的决定，不是自动
    // 重试的开关」尤其不能改写：没有它，agent 会把 override 当成一个重试按钮。
    '三条出口:\n' +
    '  1. **修那次读**。读不到通常本身就是 bug(2026-08-19 那次是 ' +
    'Scan_PropsGet 的 `*+i` 解析崩了),它值得被看见而不是被绕过。\n' +
    '  2. **在 Nanonis 的 Scan 模块里手动关掉 Continuous scan**。' +
    '下一次 StartScan 读到「关」就直接放行 —— 根本不需要写,也就不用冒' +
    '清空「保存哪些模块参数」的险。\n' +
    '  3. 明确接受风险:`allow_continuous_scan=True`。**这是用户的决定,' +
    '不是自动重试的开关** —— agent 遇到这条应当把上面两条报给用户,' +
    '而不是自己把它打开重来一遍(打开之后拿到的那一帧,可能不是你以为的' +
    '那一帧)。'
  )
}

export const StartScan: Skill = {
  spec: S.StartScanSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    let moduleNames: string[] = []
    let moduleNamesSource = 'unchanged'
    let moduleCount: number | null = null
    let continuousBefore: unknown = null
    let seriesName = ''

    const before = await readScanProps(ctx)
    let readError = before.error
    if (before.body !== null) {
      continuousBefore = scanPropsContinuous(before.body)
      seriesName = scanPropsSeriesName(before.body)
      moduleCount = scanPropsModuleCount(before.body)
      const heuristic = scanPropsModules(before.body)
      if (moduleCount !== null) {
        const names = before.body[9]
        moduleNames = Array.isArray(names) ? names.map((s) => String(s)) : []
        // **零个模块是一个事实**：写回 `[]` 在两种可能的协议语义下都可证是空操作。
        moduleNamesSource = moduleNames.length > 0 ? 'read' : 'read_empty'
      } else if (heuristic.length > 0) {
        moduleNames = heuristic
        moduleNamesSource = 'read'
      } else {
        readError = 'Scan_PropsGet 回包里没有模块名数组'
      }
    }

    // 序列名取自**上面那一次读**，不再单开一发 —— 两次读可以给出不同的答案，而分歧
    // 不是无害的：第一发成功（于是这一整发会下出去）、第二发失败（于是 basename
    // 变成空串）时，写下去的空串会把用户配的文件名前缀打回 `unnamed####`。
    const basename = seriesName
    const propsWritten = moduleNamesSource === 'read' || moduleNamesSource === 'read_empty'
    if (propsWritten) {
      await ctx.safeCall(
        'Scan_PropsSet',
        SET_OFF,
        SET_NO_CHANGE,
        SET_AUTOSAVE_ALL,
        basename,
        '',
        moduleNames,
        0,
      )
    }

    // 回读。一台**拒绝**这次写入的机器，不能看起来和一台接受了的一样——那就是这里
    // 是两次调用而不是一次的全部理由。
    const after = await readScanProps(ctx)
    const continuousAfter = after.body === null ? null : scanPropsContinuous(after.body)
    const stillOn = continuousState(continuousAfter)
    const override = params['allow_continuous_scan'] === true

    const data: Record<string, unknown> = {
      saved_modules: moduleNames,
      module_names_source: moduleNamesSource,
      module_names_read_error: readError || null,
      module_names_count_declared: moduleCount,
      scan_props_written: propsWritten,
      continuous_scan_before: continuousBefore ?? null,
      continuous_scan_after: continuousAfter ?? null,
      continuous_readback_error: after.error || null,
      // **读不到不是「没开着」。** 2026-08-19：解析崩掉时这一位曾经报成 false，
      // 而那一帧的 wait 结果恰恰是 `restarted`——故障答成了「一切正常」。
      continuous_scan_still_on: stillOn,
      continuous_scan_override_used: override && stillOn !== false,
    }

    const gate = continuousGate({
      stillOn,
      override,
      continuousBefore,
      moduleNamesSource,
      readError,
      readbackError: after.error,
    })
    if (gate) {
      data['scan_running'] = false
      return { success: false, error: gate, data }
    }

    // ── 扫描方向 ────────────────────────────────────────────────────────
    //
    // 0 = down / 1 = up。旧仓观测帧均报告 `:SCAN_DIR: down`，因此 0=down 有实测支持。
    const direction = String(params['direction'] ?? 'down').trim().toLowerCase()
    if (direction !== 'down' && direction !== 'up') {
      data['scan_running'] = false
      return {
        success: false,
        error:
          `direction 只能是 'down' 或 'up',收到 ${JSON.stringify(String(params['direction']))}。` +
          '**不猜**:猜错的代价是一整帧扫在错误方向上,而文件头会' +
          '如实记下它,于是后面每一处按方向归位的分析都跟着错。',
        data,
      }
    }

    const rec = await ctx.safeCall('Scan_Action', 0, direction === 'up' ? 1 : 0)
    if (failed(rec)) {
      data['scan_running'] = false
      return { success: false, error: rec.error ?? '', data }
    }
    data['scan_running'] = true
    data['scan_direction'] = direction
    return { success: true, data }
  },
}
