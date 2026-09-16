/**
 * `builtins.scan_frame` 的剩下三个 —— `LoadScanFrameFromFile` · `ParseRegions` ·
 * `ComputeDriftVector`。加上早就落地的 `GrabScanFrameData` 与 `CheckScanForCrash`，
 * 这个模块**收口**。
 *
 * 三个技能三种性格，而这正是它们被放在同一个 `.py` 里的原因：
 *
 * | | 碰什么 |
 * |---|---|
 * | `LoadScanFrameFromFile` | 只碰**磁盘**（`GrabScanFrameData` 的离线对应版） |
 * | `ParseRegions` | 什么都不碰（判据在 `kernel/scan-regions.ts`） |
 * | `ComputeDriftVector` | 碰**仪器**（`Scan_FrameDataGrab`）+ 磁盘上的一张参考图 |
 *
 * ## 容差表
 *
 * | 件 | 对的是 | 容差 | 推导 |
 * |---|---|---|---|
 * | `LoadScanFrameFromFile` 写出的两个 `.npy` | `sxm_oriented_frames` | **0** | 帧是从同一份 `.sxm` 字节里读出来的 float32，两边逐位相同；归位只是翻转，**不算数** |
 * | `ComputeDriftVector` 的 `shift_*_px` | `np.argmax(correlate2d)` | **0** | 它是个下标 |
 * | `ComputeDriftVector` 的 `drift_*_m` | 同上 × 像素尺寸 | **0** | 整数 × 一个浮点，一次乘法 |
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  correlate2d,
  decodeNpy,
  matOf,
  mean,
  type Mat,
} from 'dsh-spm-numerics'
import {
  encodeNpyFrame,
  parseFrameGrab,
  validateRegions,
  type Skill,
  type SkillCallRecord,
  type SkillContext,
  type SkillResultLike,
} from 'dsh-spm-kernel'
import { readSxm, sxmOrientedFrames } from 'dsh-spm-nanonis-files'
import * as S from '../generated/specs.js'
import { fail, ok } from './common.js'
import { matRows } from './paper-common.js'
import type { FramesDeps } from './frames.js'

const failed = (rec: SkillCallRecord): boolean => rec.error !== undefined && rec.error !== ''

// ──────────────────────────────────────────────────────────────────────────
// LoadScanFrameFromFile
// ──────────────────────────────────────────────────────────────────────────

/**
 * 从一张**存盘的 `.sxm`** 里取一路通道的正/反扫二维帧，各写一个 `.npy`，
 * **返回两个路径**。
 *
 * ## 它为什么存在（旧仓 2026-08-10）
 *
 * `GrabScanFrameData` 只抓**活缓冲区**（走 `Scan_FrameDataGrab`）。于是
 * 「拿一帧已经存盘的图去问正反扫一致性」这件事全仓做不了 ——
 * `CheckLineQuality` 要 `fwd_lines` / `bwd_lines` 两个数组，而唯一能产出它们的
 * 技能必须连着仪器、还得那一帧恰好还在缓冲区里。
 *
 * ## ⚠️ 交出去的帧一律经 `sxmOrientedFrames`，**不自己扒 `channels`**
 *
 * `channels[ch]["backward"]` 是 Nanonis **按采集顺序**存的块，而反扫沿 −x 采 ⇒
 * 它是**镜像的**。直接拿它跟正扫比，比的是一张图和它自己的镜像。
 * 旧仓那 76 张真机帧上这件事把判据**整个反了过来**（越坏分越高）：
 * 废帧 `_0028` 未镜像 0.9487、镜像后 0.5929；好帧 `_0060` 未镜像 0.1206、
 * 镜像后 0.9795。阈值 0.80 上，未镜像是「好帧 0/37 过、废帧 5/14 过」，
 * 镜像后是「好帧 27/37 过、废帧 0/14 过」。
 *
 * 上面那两个 `channels[…]` 的读**只用来回答「这两个方向在不在」**
 * （两条错误报文要精确到方向名），交出去的数组一律来自 `sxmOrientedFrames`。
 *
 * ## 通道选错宁可失败
 *
 * 请求的通道不在就**报错并列出有哪些**，不替调用方猜。这与
 * `paper-common.ts` 的 `pickImageChannel`（猜第一路）刻意相反 ——
 * 那个用在「只要一张图」的滤波上，这个用在「要比两路」的判据上。
 */
export function makeLoadScanFrameFromFile(deps: FramesDeps = {}): Skill {
  const framesDir = deps.framesDir ?? ((): string => join(process.cwd(), 'experiments', 'frames'))
  const stamp = deps.stamp ?? ((): string => (Date.now() >>> 0).toString(16))
  return {
    spec: S.LoadScanFrameFromFileSpec,
    execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
      const scanPath = String(params['scan_path'] ?? '').trim()
      const channel = String(params['channel'] ?? 'Z').trim() || 'Z'
      const saveDir = String(params['save_dir'] ?? '').trim()
      if (scanPath === '') return fail('scan_path 是必填的')

      let scan
      try {
        scan = readSxm(new Uint8Array(readFileSync(scanPath)), scanPath)
      } catch (e) {
        // ⚠️ 旧仓这句是 `读不了 {p}: {type(exc).__name__}: {exc}` —— 类名与那句话
        // 两半都是 Python 的（`FileNotFoundError` / `ValueError` + reader 的措辞），
        // Node 这边一个都对不上。金样两侧把这半句归一化成 `<read-error>`，
        // 而「文件不存在」与「不是个 .sxm」分不分得开由一条专门的测试钉。见 deviation。
        return fail(`读不了 ${scanPath}: ${(e as Error).name}: ${(e as Error).message}`)
      }
      const names = Object.keys(scan.channels)
      if (names.length === 0) return fail(`${scanPath} 里没有任何通道数据`)
      const block = scan.channels[channel]
      if (block === undefined) {
        return fail(
          `这个 .sxm 里没有通道 '${channel}'。它有:[${names.slice().sort()
            .map((n) => `'${n}'`).join(', ')}] —— 请指名要哪一个。` +
            '(不替你挑:挑错通道量出来的数看起来完全正常,只是量的是另一个物理量。)',
          { available_channels: names.slice().sort() },
        )
      }
      // 「缺反扫」是**一类独立的失败**，不能和「通道不存在」合并：一次只存了正扫的
      // 扫描根本回答不了正反扫一致性，而那正是调用方要问的问题。
      const missing: string[] = []
      if (block.forward === undefined) missing.push('forward')
      if (block.backward === undefined) missing.push('backward')
      if (missing.length > 0) {
        return fail(
          `通道 '${channel}' 缺 ${missing.join('/')} 方向的数据 —— ` +
            '这一帧回答不了正反扫一致性(只扫了一个方向的图就是这样)。',
          { channel, missing_directions: missing },
        )
      }

      const oriented = sxmOrientedFrames(scan, channel)
      const f = oriented.forward
      const b = oriented.backward
      if (f === null || b === null) {
        return fail(`通道 '${channel}' 几何归位后拿不到正/反扫两个方向 —— 不交未归位的帧。`)
      }
      if (f.rows !== b.rows || f.cols !== b.cols) {
        return fail(`正反扫形状不一致: (${f.rows}, ${f.cols}) vs (${b.rows}, ${b.cols}),无法逐点比较。`)
      }

      let fwdPath: string
      let bwdPath: string
      try {
        const dir = saveDir !== '' ? saveDir : framesDir()
        mkdirSync(dir, { recursive: true })
        const stem = stemOf(scanPath)
        const safeCh = channel.replace(/[^A-Za-z0-9\-_]/g, '_')
        const base = `${stem}_${safeCh}_${stamp()}`
        const picked = freeFrameBase(dir, base)
        fwdPath = join(dir, `${picked}_fwd.npy`)
        bwdPath = join(dir, `${picked}_bwd.npy`)
        writeFileSync(fwdPath, encodeNpyFrame(matRows(f)))
        writeFileSync(bwdPath, encodeNpyFrame(matRows(b)))
      } catch (e) {
        return fail(`写 .npy 失败: ${(e as Error).name}: ${(e as Error).message}`)
      }
      return ok({
        fwd_path: fwdPath,
        bwd_path: bwdPath,
        channel,
        shape: [f.rows, f.cols],
        available_channels: names.slice().sort(),
        // 说出来。读者不该靠猜来判断这两个 `.npy` 能不能直接逐点比 ——
        // 之前它们**不能**，而没有任何一个字段说得出这件事。
        orientation: 'sample_frame',
        orientation_note:
          '反扫已 fliplr 回样品坐标、:SCAN_DIR: up 已 flipud —— 两个数组可以直接逐点/互相关比较。',
        source: scanPath,
      })
    },
  }
}

/**
 * `<base>`、`<base>_01`、`<base>_02`…… **取第一个两个文件都空着的**。
 *
 * 毫秒戳自己不够唯一（旧仓实测连读 2000 次 `time.time()` 只得到两个不同值），
 * 而固定名更是一条被每次运行共享的可变路径 —— 上一次的帧会被这一次悄悄覆盖，
 * 下游读到的是别人的数据。**别信钟，去问目录**（同 `frames.ts` 的 `freeName`）。
 */
function freeFrameBase(dir: string, base: string): string {
  let name = base
  let n = 0
  while (existsSync(join(dir, `${name}_fwd.npy`)) || existsSync(join(dir, `${name}_bwd.npy`))) {
    n += 1
    name = `${base}_${String(n).padStart(2, '0')}`
  }
  return name
}

function stemOf(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const base = p.slice(cut + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

export const LoadScanFrameFromFile: Skill = makeLoadScanFrameFromFile()

// ──────────────────────────────────────────────────────────────────────────
// ParseRegions
// ──────────────────────────────────────────────────────────────────────────

/**
 * 一串 JSON 区域 → 一张归一化的表，供声明式 composite `foreach`。
 *
 * 判据全在 `kernel/scan-regions.ts`（零 numpy、零 I/O）。这一层只做两件事：
 * 解析那串 JSON，以及把拒绝拼成一句话。
 *
 * ⚠️ **`json.loads` 的异常文本不复刻**：Python 的 `json` 与 V8 的 `JSON.parse`
 * 措辞完全不同，而那一句不是判据。金样两侧归一化成 `<json-error>`。见 deviation。
 */
export const ParseRegions: Skill = {
  spec: S.ParseRegionsSpec,
  execute: async (_ctx: SkillContext, params): Promise<SkillResultLike> => {
    const raw = params['regions'] ?? ''
    let data: unknown
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (e) {
      return fail(`invalid regions JSON: ${(e as Error).message}`)
    }
    const r = validateRegions(data)
    if (!r.ok) return fail(r.error)
    return ok({ regions: r.regions, count: r.regions.length })
  },
}

// ──────────────────────────────────────────────────────────────────────────
// ComputeDriftVector
// ──────────────────────────────────────────────────────────────────────────

/**
 * 抓当前帧，与一张参考 `.npy` 做**二维互相关**，峰位 × 像素尺寸 = 漂移（米）。
 *
 * ## `correlate2d(mode='same')` 顶不掉 `phaseCrossCorrelation`
 *
 * 两者是**两个估计量**，不是两档精度（`survey-remaining.md` §3.4 第二行）：
 * 相位相关把每个频点归一化成单位模长，于是没有信号的地方由噪声投票 ——
 * `fft.ts` 抬头自己就警告「这个算法在平坦帧上会报出一个纯属虚构的位移」
 * （金样 `near_flat` 报 `(5, 5)`）。换掉不会报错，只会**静默地改掉漂移数字**，
 * 而漂移补偿会照着那个数字驱动硬件。
 *
 * 偶数核的原点差一格也是同一类事（D-NUM-19）：`correlate2d(mode='same')` 用
 * `(M−1)//2`，而 `grey_*` 用 `M//2`。这里两个输入同形状，原点由
 * `numerics.correlate2d` 负责。
 *
 * ## 尺寸对不上是**成功**，不是失败
 *
 * 旧仓在这里返回 `success=True` + `drift = 0` + 一句 `note` —— 调用方
 * （漂移跟踪 workflow）拿到 0 会「这一轮不补偿」继续跑，而一次失败会打断整条链。
 * 照移。⚠️ 但那个 `note` 字段**只在这一支出现**，成功那一支没有它 ——
 * 于是「0 是量出来的」与「0 是量不了」靠一个**键在不在**区分。照移，记一笔。
 */
export const ComputeDriftVector: Skill = {
  spec: S.ComputeDriftVectorSpec,
  execute: async (ctx: SkillContext, params): Promise<SkillResultLike> => {
    const refPath = String(params['ref_path'] ?? '')
    const scanWidthM = Number(params['scan_width_m'])
    const ch = Math.trunc(Number(params['channel_index'] ?? 0))
    const direction = Math.trunc(Number(params['direction'] ?? 1))

    let ref: Mat
    try {
      const a = decodeNpy(new Uint8Array(readFileSync(refPath)))
      const rows = a.shape.length >= 1 ? (a.shape[0] as number) : 1
      ref = matOf(rows, a.values.length / rows, a.values)
    } catch (e) {
      return fail(`cannot load reference image: ${(e as Error).message}`)
    }

    const rec = await ctx.safeCall('Scan_FrameDataGrab', ch, direction)
    const arr = failed(rec) ? null : parseFrameGrab(rec.values ?? null, false)
    if (arr === null) return fail('could not grab current scan frame')
    const flat = (Array.isArray(arr[0]) ? (arr as number[][]).flat() : arr) as number[]

    if (flat.length !== ref.rows * ref.cols) {
      return ok({
        drift_x_m: 0.0,
        drift_y_m: 0.0,
        note: `size mismatch ref=${ref.rows * ref.cols} cur=${flat.length}`,
      })
    }

    const curMean = mean(flat)
    const cur = matOf(ref.rows, ref.cols, Float64Array.from(flat, (v) => v - curMean))
    const refMean = mean(ref.data)
    const ref0 = matOf(ref.rows, ref.cols, Float64Array.from(ref.data, (v) => v - refMean))
    const corr = correlate2d(ref0, cur)
    let peak = 0
    let best = -Infinity
    for (let i = 0; i < corr.data.length; i += 1) {
      const v = corr.data[i] as number
      if (v > best) {
        best = v
        peak = i
      }
    }
    const cy = Math.floor(ref.rows / 2)
    const cx = Math.floor(ref.cols / 2)
    const dyPx = Math.floor(peak / corr.cols) - cy
    const dxPx = (peak % corr.cols) - cx
    const pixelSize = ref.cols > 0 ? scanWidthM / ref.cols : 1e-9
    return ok({
      drift_x_m: dxPx * pixelSize,
      drift_y_m: dyPx * pixelSize,
      shift_x_px: dxPx,
      shift_y_px: dyPx,
    })
  },
}

export const SCAN_FRAME_OFFLINE: Readonly<Record<string, Skill>> = {
  LoadScanFrameFromFile,
  ParseRegions,
  ComputeDriftVector,
}
