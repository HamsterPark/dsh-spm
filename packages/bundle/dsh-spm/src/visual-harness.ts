/**
 * 视觉线束挂进最小运行栈（决策 D12；VISUAL-HARNESS §6 第 4 步）。
 *
 * **开关是 `Config.visualHarness`，缺省不挂。** 缺席时这里一行都不跑：工具目录、提示段、
 * 回复与 JSONL 与挂之前一字不差，此前两组验收（受管 STM-Bench、本机 Nanonis）的行为不变。
 * 在场时，在本运行栈登记的那几个技能之上挂：
 * - 视觉记忆插件（`dsh-spm-visual-memory` 的 `apply`）：每个 dsh 会话一份帧档案与笔记、
 *   回看 / 读值 / 测量 / 笔记工具、提示段；
 * - 一动一观闸门（`ActGateService`），登记本运行栈改变仪器的技能；
 * - K14：内核的 `frameObserver` 与技能工具的 `observationPresenter`。
 *
 * 不新增仪器技能：本机入口仍是那七个，受管入口仍只有 GetBias。
 *
 * ## 保存目录
 *
 * K14 要知道控制器把 .sxm / .dat 存在哪。受管模式问 stmsim（`Util_SessionPathGet`，即
 * stm-skills 的 `controllerSaveDir`），也可以用 `saveDir` 指定；**本机模式由配置给
 * （`saveDir`，必填）**，不往本机白名单里加这条查询：
 * - 白名单（`NATIVE_SIMULATOR_METHOD_NAMES`）是本机入口验收过的线上边界，开关关着时它必须
 *   一字不变，开关开着也不该因为观察而变宽；
 * - 不连真模拟器就无法核实 Mimea 对 `Util.SessionPathGet` 的回答；
 * - 操作员知道 Nanonis 的保存目录（Session path），启动时就能核验它存在。
 * 给错目录的后果是「什么帧都没入档」：动作的结果只有 `latest_frame`，不会把别处的文件当观测。
 */
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context, ToolExecution } from 'dsh-spm-compat'
import { observationText, type SkillObserver, type SkillSpec } from 'dsh-spm-kernel'
import { ActGateService, controllerSaveDir, type OutcomePresenter } from 'dsh-spm-stm-skills'
import { apply as applyVisualMemory, frameObserver, observationPresenter, type ViewToolValue } from 'dsh-spm-visual-memory'
import type { MinimalResultRecord } from './minimal-persistence.js'
import { formatNativeToolText } from './native-skills.js'

/** `Config.visualHarness`：在场即开。 */
export interface VisualHarnessConfig {
  /**
   * 视觉记忆目录：每个 dsh 会话的帧与笔记在 `sessions/<会话>/` 下。相对路径按 dsh 启动目录
   * 解析，缺省 {@link VISUAL_ROOT_DEFAULT}。
   */
  readonly root?: string
  /** 控制器存 .sxm / .dat 的目录（Nanonis 的 Session path）。本机模式必填；受管模式缺省问 stmsim。 */
  readonly saveDir?: string
  /** 扫描图上的方格纸（VISUAL-HARNESS §4.3），缺省开。 */
  readonly grid?: boolean
}

export const VISUAL_ROOT_DEFAULT = '.dsh-spm/visual'

/** 解析过的开关：路径都是绝对路径。 */
export interface VisualHarnessSettings {
  readonly root: string
  /** 缺席 = 每次调用问仪器（只在受管模式）。 */
  readonly saveDir?: string
  readonly grid: boolean
}

const KEYS = ['root', 'saveDir', 'grid']

function configError(reason: string): never {
  throw new Error(`visual_harness_config: ${reason}`)
}

function pathValue(v: Record<string, unknown>, key: string): string | undefined {
  const value = v[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') configError(`${key} 必须是非空字符串`)
  return resolve(value)
}

/**
 * 校验 `Config.visualHarness` 并解析路径（不碰文件系统）。缺席返回 `undefined`（不挂）。
 * 拼错的键直接拒绝：开关的意思是「挂上」，不能因为一个 `save_dir` 静默挂成另一种样子。
 */
export function parseVisualHarness(value: unknown, native: boolean): VisualHarnessSettings | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    configError('visualHarness 必须是对象，例如 { root, saveDir }')
  }
  const v = value as Record<string, unknown>
  const unknown = Object.keys(v).filter((key) => !KEYS.includes(key))
  if (unknown.length > 0) configError(`不认识的键 ${unknown.join(', ')}；可用的键是 ${KEYS.join(', ')}`)
  if (v['grid'] !== undefined && typeof v['grid'] !== 'boolean') configError('grid 必须是 true 或 false')
  const saveDir = pathValue(v, 'saveDir')
  if (native && saveDir === undefined) {
    configError('本机 Nanonis 模式必须给 saveDir（Nanonis 的 Session path）；本机白名单不含保存目录查询')
  }
  return {
    root: pathValue(v, 'root') ?? resolve(VISUAL_ROOT_DEFAULT),
    ...(saveDir === undefined ? {} : { saveDir }),
    grid: (v['grid'] as boolean | undefined) ?? true,
  }
}

/**
 * 激活前的文件系统核验：视觉记忆目录建得出来，保存目录**已存在**且是目录。
 * 在模拟器启动 / 接入之前做，配置错了什么都不连。
 */
export function prepareVisualHarness(settings: VisualHarnessSettings): void {
  try {
    mkdirSync(settings.root, { recursive: true })
  } catch (error) {
    configError(`root ${settings.root} 无法创建：${error instanceof Error ? error.message : String(error)}`)
  }
  if (settings.saveDir === undefined) return
  let isDir = false
  try {
    isDir = statSync(settings.saveDir).isDirectory()
  } catch {
    configError(`saveDir ${settings.saveDir} 不存在`)
  }
  if (!isDir) configError(`saveDir ${settings.saveDir} 不是目录`)
}

/** 闸门拒绝时的 JSONL 落盘（SQLite 那一行闸门自己经 `ctx.stmRecords` 记）。 */
export type RefusalSink = (exec: Readonly<ToolExecution>, reason: string) => void

/**
 * 一动一观闸门，拒绝同时交给 {@link RefusalSink}：被拒的调用内核没跑，最小运行栈的 JSONL
 * 就该由这里补一行，否则一次模型调用只在 SQLite 里有痕迹。
 */
export class DurableActGate extends ActGateService {
  constructor(ctx: Context, private readonly onRefusal: RefusalSink) {
    super(ctx)
  }

  override check(exec: Readonly<ToolExecution>): string | undefined {
    const refusal = super.check(exec)
    if (refusal !== undefined) this.onRefusal(exec, refusal)
    return refusal
  }
}

/** 挂好的视觉线束：交给内核与技能工具的两件，以及闸门登记。 */
export interface MountedVisualHarness {
  readonly observer: SkillObserver
  readonly present: OutcomePresenter
  /** 在闸门上登记一个技能（只有改变仪器的技能进表）；返回注销函数。 */
  registerSkill(spec: SkillSpec): () => void
}

/**
 * 挂上视觉线束。插件的效果都挂在最小运行栈的 `ctx` 上，随它一起卸载。
 * 必须在建 `SkillKernel` 之前调用：观察者是内核的构造参数。
 */
export function mountVisualHarness(ctx: Context, settings: VisualHarnessSettings, onRefusal: RefusalSink): MountedVisualHarness {
  applyVisualMemory(ctx, { root: settings.root, grid: settings.grid })
  const gate = new DurableActGate(ctx, onRefusal)
  const saveDir = settings.saveDir
  return {
    observer: frameObserver(ctx, { saveDir: saveDir === undefined ? controllerSaveDir : () => saveDir }),
    present: observationPresenter(ctx),
    registerSkill: (spec) => gate.registerSkill(spec),
  }
}

/**
 * 本机提示段在开关开着时多的一句（关着时那一段一字不变）。
 * 「只提供……」说的是仪器操作；视觉工具不操作仪器，这一句把它们与出图的时机说清楚。
 */
export const NATIVE_VISUAL_PROMPT =
  '视觉线束已开启：控制器自动保存的扫描帧在下一次工具调用结束时入档，并随该次结果出图；' +
  'stm_inspect、stm_read_values、测量工具与笔记工具只读写帧档案和笔记，不操作仪器。' +
  '同一步里只能执行一个改变仪器的动作，看到它的结果之后再执行下一个。'

/**
 * 视觉线束开着时的模型可见结果：本机格式化（测量值与单位、回读确认）只换掉内核那段文本，
 * K14 的几行（`new_frames` / `latest_frame` / …）、presenter 加的 `images_not_delivered`
 * 与图像原样保留。没有本机格式（未知技能、失败、没有记录）时值原样返回。
 *
 * 记录里的 `text` 是内核文本连同 K14 的几行（内核先接 K14、再落 K16）；presenter 只在
 * 这段文本之后追加。所以 K14 的几行由记录里的观测重算，presenter 的追加取文本的尾巴。
 */
export function formatObservedToolText(record: MinimalResultRecord | undefined, value: ViewToolValue): ViewToolValue {
  const core = formatNativeToolText(record, undefined)
  if (record === undefined || typeof core !== 'string') return value
  const presenterTail = value.text.startsWith(record.text) ? value.text.slice(record.text.length) : ''
  return { ...value, text: core + observationText(record.observation ?? null) + presenterTail }
}
