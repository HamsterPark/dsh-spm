/**
 * 环境读两件 —— 腔体压强（连同粗动互锁裁决）与温度。
 *
 * 两个技能共一条设计：**判据在内核里**（`vacuum-interlock.ts` / `temperature.ts`），
 * 这个文件只负责去问、把答案摆成 `data`。一次计算、几个受众 ——
 * 与压电对账、扫描地图分析同一形状。
 *
 * ## 两个都**永远 `success: true`**
 *
 * 「禁止粗动」是一个**答案**，不是工具坏了；「这台机器没装温度计」也是。
 * 报成 `error` 会让一次寻常的「还在抽气」看起来像故障，
 * 而模型对故障的标准反应是**重试** —— 那正是这两个技能要防的事。
 * 可执行的那句话在 `reason` / `what_to_do` 里，包成错误就把它一起丢了。
 *
 * ## 两个都不碰仪器
 *
 * 一次 Nanonis 调用都不发：压强与温度走的是宿主注入的进程级源
 * （`processVacuum` / `processTemperature`）。于是它们在断线时照样能回答，
 * 而「断线」恰好是最需要问「现在能不能动」的时刻之一。
 */
import {
  CORONA_ZONE_PA,
  attestationExpired,
  attestationLabel,
  attestationRemainingS,
  channelDict,
  checkVacuum,
  currentSample,
  freshness,
  latestTemperature,
  processVacuum,
  pyFloat,
  pyRound,
  readingDict,
  temperatureChannels,
  verdictDict,
  type Skill,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { ok } from './common.js'

/**
 * 腔体压强 + **粗动互锁裁决**。只读，不加任何能力。
 *
 * 在这之前真空计只喂一块面板：没有技能读它、没有工具暴露它、没有决定依赖它。
 * 那对一个「你看一眼」的数是够的，对一个**决定要不要往压电上加几百伏**的数是错的。
 */
export const GetChamberPressure: Skill = {
  spec: S.GetChamberPressureSpec,
  execute: async (_ctx: SkillContext): Promise<SkillResultLike> => {
    const nowS = processVacuum.nowS()
    const verdict = checkVacuum(nowS)
    const sample = currentSample()
    const data = verdictDict(verdict)
    data['corona_danger_zone_pa'] = [...CORONA_ZONE_PA]
    if (sample !== null) {
      data['sensor'] = sample.sensorName
      data['sensor_class'] = sample.sensorClass
      data['raw_value'] = sample.value
      data['raw_unit'] = sample.unit
      data['sensor_status'] = sample.status
    }
    const att = processVacuum.attestation
    if (att !== null) {
      // 裁决可能压根没用上这份签署（规自己就够了），但用户照样该看见它 ——
      // 「没有用上」与「不存在」是两件事。
      data['attestation'] = {
        reason: att.reason,
        label: attestationLabel(att),
        signed_by: att.signedBy,
        expired: attestationExpired(att, nowS),
        remaining_h: pyRound(attestationRemainingS(att, nowS) / 3600.0, 2),
      }
    }
    return ok(data)
  },
}

/**
 * 每种「没有值」该做什么。放在**数据里**而不是只写在描述里 ——
 * 描述会被裁剪、会被总结，而这一句是跟着答案一起到调用方手上的。
 */
const WHAT_TO_DO: Readonly<Record<string, string>> = {
  no_sensor:
    '这台机器上没有真的温度传感器（只有占位实现）。**等下去永远等不到** —— ' +
    '不要轮询、不要重试；需要温度判据的步骤应当直接拒绝并告诉用户。',
  unavailable:
    '有真的温度传感器，但此刻拿不到读数。常见原因是串口被别的程序独占' +
    '（真机上是 Lakeshore Logger.exe 占着 COM3），或归档循环还没跑过一拍。' +
    '**可能会好**：可以等，但要请用户去看端口占用，不要无限轮询。',
  unknown_channel:
    '你指名的那个通道这台机器上没有。看 available_channels 里的名字，' +
    '**不是**「没有温度计」。',
  ambiguous_channel:
    '你给的名字同时对上了不止一个通道。从 available_channels 里挑一个完整名字。',
  no_source:
    'MAST 自己这一侧没接上温度源（独立 API 进程，或环境监控没建起来）。' +
    '与仪器无关；重启/接线才会变。',
}

/**
 * 调用方**显式**给了新鲜度阈值吗。
 *
 * `max_age_s = 0` 是声明里的合法值（`minValue: 0.0`），意思是「一切都算旧」——
 * 一个真实的、很严格的阈值。用真假判它（`if (maxAge)`）会把这个阈值读成「没给」，
 * 于是最严的那一档静静地退化成**不判**（D-ZERO-1，第五次）。
 */
function givenMaxAge(params: Readonly<Record<string, unknown>>): boolean {
  return params['max_age_s'] != null
}

/** 读当前温度，并说明读不到时是**哪一种**读不到。 */
export const GetTemperature: Skill = {
  spec: S.GetTemperatureSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    // `!= null` 而不是 `in params`：模型那条路上 schema 会把可选字段实例化成 `null`。
    // 空白名字等于没指名（`'  '.trim()` ⇒ `''` ⇒ 自动选）。
    const raw = params['channel']
    const channel = raw != null ? String(raw).trim() : ''
    const reading = latestTemperature(channel === '' ? null : channel)

    const data = readingDict(reading)
    if (reading.reason !== null && reading.reason !== '') {
      data['what_to_do'] = WHAT_TO_DO[reading.reason] ?? ''
    }

    // 有哪些通道可选。`null` = **问不到**（源没接上），与「一个都没有」不同 ——
    // 前者不该让智能体得出「这台机器没温度计」的结论。
    const chans = temperatureChannels()
    data['available_channels'] = chans === null ? null : chans.map(channelDict)

    // 陈旧判定是 **explicit-only**：不传 `max_age_s` 就不给 `freshness` 字段，
    // 而不是给一个「用默认阈值算出来的」结论 —— 那种结论看起来和真的一样。
    if (givenMaxAge(params)) {
      const limit = pyFloat(params['max_age_s'])
      if (limit === null) {
        // 阈值本身读不出来 ⇒ 判不了。**连 `max_age_s` 也不写** ——
        // 回显一个没被用上的阈值，等于报告一次没发生的判定。
        data['freshness'] = 'unknown'
      } else {
        data['freshness'] = freshness(reading, limit)
        data['max_age_s'] = limit
      }
    }

    return ok(data)
  },
}

export const ENVIRONMENT: Readonly<Record<string, Skill>> = {
  GetChamberPressure,
  GetTemperature,
}
