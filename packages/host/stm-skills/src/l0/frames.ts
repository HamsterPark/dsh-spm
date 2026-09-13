/**
 * 抓帧、找最近那张图、建 Z 参数组 —— 三个各自要碰**文件系统**的技能。
 *
 * 内核只管判据（`.npy` 的字节、参数组的校验、来历行），路径与落盘在这里。
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import {
  PresetRejected,
  PresetStore,
  encodeNpyFloat64,
  parseFrameGrab,
  resolvePreset,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import * as S from '../generated/specs.js'
import { lastString } from './reads-hw.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

/**
 * 帧落盘的目录。宿主接线时给；没给就落在工作目录下（同旧仓的 `<data>/experiments/frames`）。
 *
 * ⚠️ 这里拿 `process.cwd()` 顶旧仓的**数据根**，而 `GetLatestScanFile` 那边我把同一个
 * 映射删掉了（D-FRAME-1）。不是前后不一：那边是**搜索候选**，一个没人会去创建的目录
 * 进候选表等于报告一次没发生过的搜索；这边是**写入目标**，帧总得落在某处，而这个目录
 * 由本函数自己 `mkdir` 出来。宿主接上数据根之后两处都该改成从那儿取。
 */
export interface FramesDeps {
  readonly framesDir?: () => string
  /** 落盘序号来源。注入是为了让文件名在测试里可复现。 */
  readonly stamp?: () => string
}

/**
 * `GrabScanFrameData` —— 抓一路通道的整帧，存成 `.npy`，**返回路径**。
 *
 * 返回路径而不是数组：一帧 512² 是 2 MB 的 float64，把它塞进工具返回值等于把模型的
 * 上下文烧掉，而下游要的从来都是「那份数据在哪」。
 *
 * ## 二维是**偏好**，不是前置条件
 *
 * 二维取不出来就把**同一份回包**按一维再解一遍，绝不为此再发一次 TCP：已经到手的
 * 采样丢掉，比拼不成图更坏。
 *
 * 但**拼得出来就必须存成二维**。旧仓这里错过一次：`parse_frame_grab` 默认拉平，
 * 于是这个技能写出去的每一个 `.npy` 都是扁的 `(rows*cols,)`，而行列数就在回包里、
 * 在去磁盘的路上被扔了。断链断在测量之后一步——2026-07-28 那趟端到端跑出了一份
 * 完整的报告，每个数都是真的，只是**没有图**。
 */
export function makeGrabScanFrameData(deps: FramesDeps = {}): Skill {
  const framesDir = deps.framesDir ?? ((): string => join(process.cwd(), 'experiments', 'frames'))
  // `>>> 0` 而不是 `& 0xffffffff`：后者在 JS 里是**有符号**的（ToInt32），于是
  // 一半的时刻会得到 `-6fca3bef` 这种名字。Python 的 `& 0xFFFFFFFF` 是无符号，
  // 而 `>>> 0`（ToUint32）才和它同义。金样当场把这一位照出来了。
  const stamp = deps.stamp ?? ((): string => (Date.now() >>> 0).toString(16))
  return {
    spec: S.GrabScanFrameDataSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const channel = typeof params['channel_index'] === 'number' ? params['channel_index'] : 0
      const direction = typeof params['direction'] === 'number' ? params['direction'] : 1
      const savePath = String(params['save_path'] ?? '').trim()

      const rec = await ctx.safeCall('Scan_FrameDataGrab', channel, direction)
      const body = rec.values ?? null
      const arr = failed(rec) ? null : parseFrameGrab(body, true) ?? parseFrameGrab(body, false)
      if (arr === null) {
        return {
          success: false,
          error: failed(rec) ? rec.error ?? '' : 'Scan_FrameDataGrab returned no usable samples',
        }
      }
      const is2D = Array.isArray(arr[0])
      const shape = is2D ? [arr.length, (arr[0] as number[]).length] : [arr.length]
      const flat = is2D ? (arr as number[][]).flat() : (arr as number[])

      let out: string
      try {
        if (savePath) {
          out = savePath
          mkdirSync(dirname(out), { recursive: true })
        } else {
          const dir = framesDir()
          mkdirSync(dir, { recursive: true })
          out = freeName(dir, `frame_ch${channel}_dir${direction}_${stamp()}`)
        }
        writeFileSync(out, encodeNpyFloat64(flat, shape))
      } catch (exc) {
        return {
          success: false,
          error: `failed to save frame .npy: ${exc instanceof Error ? exc.message : String(exc)}`,
        }
      }
      return { success: true, data: { frame_path: out, n_samples: flat.length, shape } }
    },
  }
}

/**
 * `<dir>/<base>.npy`，占用了就 `_01`、`_02`……**取第一个空的**。
 *
 * 毫秒戳自己不够唯一：背靠背发两次抓帧会落在同一毫秒里（旧仓实测连读 2000 次
 * `time.time()` 只得到两个不同值），于是第二发把第一发盖掉——那正是这段要防的事。
 * 别信钟，去问目录。
 *
 * 固定名更是不行。旧仓原先叫 `frame_ch{N}_dir{D}.npy`，一个进程里所有的抓帧共用它，
 * 2026-07-28 同时打中两头：下游在这一趟的帧落地**之前**解析了那个路径，拿上一趟的
 * 残留当本趟结果（「实际为一维 8 元素全零数组」，整个任务被打回重扫）；而这一趟的帧
 * 落地时，**毁掉了上一趟的**。同一课这个仓已经学过两遍（组合技能的断点曾按名字存，
 * 直到一次跑完的 AutoApproach 让之后每一次进针都瞬间「成功」）。
 * 共享的可变路径本身就是缺陷，在它上面加一道守卫不是修。
 */
function freeName(dir: string, base: string): string {
  let out = join(dir, `${base}.npy`)
  let n = 1
  while (existsSync(out)) {
    out = join(dir, `${base}_${String(n).padStart(2, '0')}.npy`)
    n += 1
  }
  return out
}

export const GrabScanFrameData: Skill = makeGrabScanFrameData()

// ─────────────────────────────────────────────────────────────────────────

/**
 * 递归找 `roots` 下**最近写入**的匹配文件。找不到给 `null`。
 *
 * Nanonis 自己挑目录与序号，所以「刚才那一发存成了哪个文件」唯一的答案就是
 * **调用之后立刻找最新的那个**。
 *
 * 单个目录读不动就跳过它，不是整趟失败——候选目录本来就是「可能在这儿」的清单。
 */
export function findLatestSaved(
  roots: readonly string[],
  suffix: string,
  nowS: number,
  maxAgeS: number,
): { path: string; ageS: number; sizeBytes: number } | null {
  let best: { path: string; ageS: number; sizeBytes: number } | null = null
  for (const root of roots) {
    for (const p of walk(root)) {
      if (!p.toLowerCase().endsWith(suffix.toLowerCase())) continue
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      const ageS = nowS - st.mtimeMs / 1000
      if (ageS > maxAgeS) continue
      if (best === null || ageS < best.ageS) best = { path: p, ageS, sizeBytes: st.size }
    }
  }
  return best
}

function* walk(root: string): Generator<string> {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    const p = join(root, name)
    let isDir: boolean
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      continue
    }
    if (isDir) yield* walk(p)
    else yield p
  }
}

/**
 * 把一个 `Util_SessionPathGet` 报出来的字符串归一成**一个目录**。
 *
 * 它可能报的是目录，也可能是「目录 + 文件名前缀」——后者取它的上级。两个都不是
 * 目录就给 `null`：一个不存在的路径进候选表，只会让 `searched_dirs` 说谎。
 */
export function sessionDir(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  try {
    if (statSync(s).isDirectory()) return s
  } catch {
    // 不存在或读不到 —— 试它的上级
  }
  const up = dirname(s)
  if (up === s || up === '.' || up === '') return null
  try {
    if (statSync(up).isDirectory()) return up
  } catch {
    // 同上
  }
  return null
}

/**
 * 去重 + **只留真目录**，保序。
 *
 * `searched_dirs` 是要交给调用方的事实（「我找过哪儿」）。把一个不存在的目录列进去，
 * 等于报告了一次没发生过的搜索。
 */
export function existingDirs(cands: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of cands) {
    let real: string
    try {
      real = realpathSync(resolvePath(c))
      if (!statSync(real).isDirectory()) continue
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    out.push(real)
  }
  return out
}

export interface LatestScanDeps {
  /**
   * 候选目录，**按可能性排序**，未过滤。默认只有一个：仪器报出来的 session 目录。
   *
   * 旧仓还攒了三路（落盘登记表、`<数据根>/working-sessions/`、当前样品的原位目录），
   * 三路各自依赖本仓还没有的东西，见 `spec/deviations.md` D-FRAME-1。宿主接上了
   * 就从这里给——**别在这里编一个目录**：一个没人会去创建的候选，只会让
   * `searched_dirs` 长出一行永远为空的搜索。
   */
  readonly candidateDirs?: (ctx: SkillContext) => Promise<readonly string[]>
  readonly nowS?: () => number
}

/**
 * `GetLatestScanFile` —— 定位最近写入的那个 `.sxm`。
 *
 * 一个都没找到时**照样成功**，`path` 给 `null`：「这段时间里没有新文件」是一个答案，
 * 不是一次失败。`searched_dirs` 一并交出去——否则调用方连「找过哪儿」都不知道。
 *
 * session 目录**问仪器**，不从属性里读。旧仓那个属性从来没人写过，于是存在
 * working-sessions 之外的图一律找不到（2026-06-29：`path: null`，而文件就在那儿）。
 */
export function makeGetLatestScanFile(deps: LatestScanDeps = {}): Skill {
  const nowS = deps.nowS ?? ((): number => Date.now() / 1000)
  const candidateDirs =
    deps.candidateDirs ??
    (async (ctx: SkillContext): Promise<string[]> => {
      const rec = await ctx.safeCall('Util_SessionPathGet')
      const dir = failed(rec) ? null : sessionDir(lastString(rec))
      return dir === null ? [] : [dir]
    })
  return {
    spec: S.GetLatestScanFileSpec,
    execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
      const maxAge = typeof params['max_age_s'] === 'number' ? params['max_age_s'] : 300
      const dirs = existingDirs(await candidateDirs(ctx))
      const found = findLatestSaved(dirs, '.sxm', nowS(), maxAge)
      if (found === null) {
        return { success: true, data: { path: null, searched_dirs: dirs, max_age_s: maxAge } }
      }
      return {
        success: true,
        data: {
          path: found.path,
          age_s: Math.round(found.ageS * 10) / 10,
          size_bytes: found.sizeBytes,
          searched_dirs: dirs,
        },
      }
    },
  }
}

export const GetLatestScanFile: Skill = makeGetLatestScanFile()

// ─────────────────────────────────────────────────────────────────────────

/**
 * 进程内的那一份自定义参数组存储。
 *
 * 与 `processApproachRefusalLatch` 同样是进程级的：参数组是**跨调用活着**的东西，
 * 一次工具调用建的组，下一次工具调用要能应用。落盘由宿主接 sink。
 */
export const processPresetStore = new PresetStore()

export interface PresetDeps {
  readonly store?: PresetStore
}

/**
 * `CreateZCtrlPreset` —— 建（或覆盖）一个自定义 Z 参数组。
 *
 * 全部判据在内核的 `sanitizePreset` 里：保留名、档名重名、前缀不可省略、量程、
 * 时间常数。**它从不夹紧**——超范围就拒。
 *
 * 回给模型的是**存储里现在的值**重新解析出来的来历行，不是它发过来的那几个参数。
 * 路上要是有任何东西被改动过，这里就是它显形的地方；操作员读到的是一个事实，
 * 而不是把自己的请求又听了一遍。
 *
 * ⚠️ 这个技能**只管自定义组**。进针参数与扫图档位表由用户在设置界面维护，
 * 让模型能改它们，等于让模型改自己被约束的那把尺子。
 */
export function makeCreateZCtrlPreset(deps: PresetDeps = {}): Skill {
  const store = deps.store ?? processPresetStore
  return {
    spec: S.CreateZCtrlPresetSpec,
    // `async` 不是装饰：`upsert` 里的档名来源是注入的，它抛出来的**不是**
    // `PresetRejected` 时要变成一次 rejection，而不是一次同步 throw —— 后者会
    // 从 `execute(...)` 的调用点直接炸穿，绕开每一个 `.catch`。
    execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
      let stored
      try {
        stored = store.upsert(
          {
            name: params['name'],
            p_gain: params['p_gain'],
            i_gain: params['i_gain'],
            setpoint_a: params['setpoint_a'],
            note: params['note'],
          },
          params['overwrite'] === true,
        )
      } catch (e) {
        // `PresetRejected` 是**一个值，不是一次崩溃**：那句话要原样报给用户。
        if (e instanceof PresetRejected) return { success: false, error: e.message }
        throw e
      }
      const trace = resolvePreset(stored.name, { presets: store.list() }).traceLines()
      return {
        success: true,
        data: {
          preset: stored.name,
          stored,
          trace,
          message:
            `参数组 '${stored.name}' 已保存。存储里现在的值是:\n` +
            trace.join('\n') +
            `\n\n用 ApplyZCtrlPreset('${stored.name}') 应用它。`,
        },
      }
    },
  }
}

export const CreateZCtrlPreset: Skill = makeCreateZCtrlPreset()

export const FRAMES_PRESETS: Readonly<Record<string, Skill>> = {
  GrabScanFrameData,
  GetLatestScanFile,
  CreateZCtrlPreset,
}
