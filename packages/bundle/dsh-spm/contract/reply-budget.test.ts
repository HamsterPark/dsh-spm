/**
 * 视觉工具一次回复的体积（`MAX_REPLY_BYTES`、`MAX_INSPECT_VIEWS`，spec/deviations.md D-VMEM-4、D-VMEM-17）与
 * dsh 的 spill 预算之间的关系。
 *
 * dsh 0.1.5 的 spill 是「50 000 字节纯文本」，含图的结果不剪；0.1.7 起改为**文字与图像共用的估算 token 预算**
 * （`dsh-base` 设 `maxInlineTokens: 12500`，按单个工具结果计）。超出预算的结果，全文（图记为只读路径）转存到文件，
 * 模型拿到首尾保留的部分（图整张留或整张省）和一条指向那个文件的说明。
 *
 * 这里把本仓的两个上限钉在 dsh 的预算之下：
 *   ① 纯文本回复到 `MAX_REPLY_BYTES` 时仍在预算内；
 *   ② `stm_inspect` 一次取满 `MAX_INSPECT_VIEWS` 个视图的最坏回复仍在预算内。这一条真跑一次 `stm_inspect`
 *      （真 ToolRuntime、合成扫描帧），我们自己的回复变长时它跟着红。
 *
 * ② 的参数组合为什么是最坏情况——回复里每一处由调用方或仪器带进来的字符串都取最长：
 *   - 标签：每个视图的标签回显两次，一次在 JSON 回复的 `label` 字段，一次在那张图的 `<visual … label="…"/>` 文字里。
 *     两处都转义：JSON 把 `"` 写成 `\"`、控制字符写成 `\u00XX`；`<visual>` 把 `"`、`&`、`<`、`>` 写成 `&quot;`、
 *     `&amp;`、`&lt;`、`&gt;`。两处合计放大最多的是 `"`，所以标签取 `MAX_LABEL_CHARS` 个 `"`。
 *   - 问题文本只做校验、不回显，所以不影响体积；这里仍取满 `MAX_QUESTION_CHARS`。
 *   - 帧：局部帧（多出 `rows_acquired`、`rows_total`），扫描框远离原点、尺寸取足有效位（坐标与统计量都是最长的写法）。
 *   - 通道：本仓视觉金样里最长的扫描通道名 `Frequency Shift`（通道名来自仪器文件）。
 *   - 选项：highpass（多出 `highpass_nm`，取 %g 写法最长的值）、backward、整幅 region（多出 `magnification`，图仍是满尺寸）、
 *     clip。highpass、backward 不改变图的尺寸；只截取一部分的 region 会让图变小、总量下降，所以用整幅。
 *
 * dsh 一侧的事实，升级时按 docs/dsh/upgrades.md 第 3 步重核：
 *   - 预算：入仓 headless 组合快照里 `spill-policy` 行的 `maxInlineTokens`；
 *   - 文字估算（dsh-token-meter）：每块 ceil(字符数 / 4) + 4；
 *   - 图像价格：`deepSeekImageTokens(768, 768)` = 382（dsh-llm-deepseek 0.2.1-rc.4 的公式；本仓的依赖里没有这个包，只能写常量）；
 *   - 句柄文字：由 `requestImageHandleText`（dsh-llm）真函数生成。
 *
 * 2026-10-28 在 dsh 0.2.1-rc.4 上实测这一组合：文字 5 842 加图像 6 396，合计 12 238 token，余量 262。
 *
 * 唯一的假设是附件只读路径的长度，见 READONLY_PATH_CHARS。路径更长（DSH_HOME 很深）时，最坏回复可能越过预算：
 * dsh 把它转存到文件，模型拿到的是引用而不是内嵌的全部图。stm_inspect 是只读工具，这只让体验变差，不涉及安全。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestImageHandleText } from '@deepseek-ai/dsh-llm'
import { Context, Service, SystemPrompt, ToolRuntime, type ImageAttachmentRef } from 'dsh-spm-compat'
import {
  DISPLAY_MAX_DEFAULT,
  MAX_INSPECT_VIEWS,
  MAX_LABEL_CHARS,
  MAX_QUESTION_CHARS,
  MAX_REPLY_BYTES,
  pngSize,
  visualMemoryProvider,
} from 'dsh-spm-visual-memory'
import { describe, expect, it } from 'vitest'
import { DSH_VERSION } from '../../../../scripts/dsh-pins.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** 入仓的 headless 组合快照里 `spill-policy` 行的 `maxInlineTokens`。 */
function spillBudget(): number {
  const snapshot = readFileSync(join(repoRoot, `spec/dsh/dump-config.headless.${DSH_VERSION}.yml`), 'utf8')
  const at = snapshot.indexOf('- id: spill-policy\n')
  expect(at, '快照里找不到 spill-policy 行').toBeGreaterThanOrEqual(0)
  const found = /maxInlineTokens: (\d+)/.exec(snapshot.slice(at, at + 400))?.[1]
  expect(found, 'spill-policy 行里找不到 maxInlineTokens').toBeDefined()
  return Number(found)
}

/** dsh-token-meter 对一块文字的估算：每 4 个字符（UTF-16 码元）一个 token，每块另加 4。 */
const textTokens = (chars: number): number => Math.ceil(chars / 4) + 4

/** 外部事实：`deepSeekImageTokens(768, 768)`，dsh-llm-deepseek 0.2.1-rc.4。 */
const IMAGE_TOKENS_AT_DEFAULT_DISPLAY = 382

/**
 * 假设：附件只读路径（`<DSH_HOME>/attachments/v1/objects/<2>/<sha256>`）取 Windows 的 MAX_PATH，260 个字符。
 * 句柄文字里这条路径经 JSON 转义，真实路径里的十几个反斜杠还会各多出一个字符，合计只多几十个 token。
 */
const READONLY_PATH_CHARS = 260

class FakeAttachments extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef> {
    const { width, height } = pngSize(input.data)
    return Promise.resolve({
      attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`,
      mediaType: 'image/png', bytes: input.data.length, width, height,
      ...(input.name === undefined ? {} : { name: input.name }),
    } as unknown as ImageAttachmentRef)
  }
}

describe('视觉工具回复体积与 dsh 的 spill 预算', () => {
  it('预算读得到且是 12500（dsh 改了它，这里先红，D-VMEM-4 与 D-VMEM-17 的理由要跟着改）', () => {
    expect(spillBudget()).toBe(12_500)
  })

  it('纯文本回复到 MAX_REPLY_BYTES 时估算 token 仍低于预算', () => {
    // 一块文字；UTF-8 字节数不小于 UTF-16 码元数，所以这是上界
    expect(textTokens(MAX_REPLY_BYTES)).toBeLessThan(spillBudget())
  })

  it('stm_inspect 取满视图数的最坏回复（文字加图像）仍低于预算', async () => {
    expect(DISPLAY_MAX_DEFAULT).toBe(768) // 图像价格是按这个尺寸算的
    const root = mkdtempSync(join(tmpdir(), 'reply-budget-'))
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt).await()
      await ctx.plugin(ToolRuntime).await()
      new FakeAttachments(ctx)
      await ctx.plugin(visualMemoryProvider, { root }).await()

      // 局部帧：最后一行还没扫到；扫描框远离原点、尺寸取足有效位
      const n = 256
      const wave = (a: number, b: number, period: number): Float32Array =>
        Float32Array.from({ length: n * n }, (_, i) => (i >= n * (n - 1) ? Number.NaN : b + a * Math.sin(i / period) + 1e-3 * a * (i % 97)))
      const frame = ctx.frameArchive.archive.addPartial(0, {
        'Z/forward': { rows: n, cols: n, data: wave(1.234567e-10, 0, 7.3) },
        'Z/backward': { rows: n, cols: n, data: wave(1.234567e-10, 0, 6.1) },
        'Frequency Shift/forward': { rows: n, cols: n, data: wave(0.01, -12.345678, 5.7) },
        'Frequency Shift/backward': { rows: n, cols: n, data: wave(0.01, -12.345678, 4.3) },
      }, { geometry: { cx_nm: -1234.5678, cy_nm: -987.65432, w_nm: 12.345678, h_nm: 12.345678 } })

      const view = {
        label: '"'.repeat(MAX_LABEL_CHARS),
        frame: frame.fid,
        channel: 'Frequency Shift',
        direction: 'backward',
        flatten: 'highpass',
        highpass_nm: 0.000123457,
        region: { x: 0, y: 0, width: DISPLAY_MAX_DEFAULT, height: DISPLAY_MAX_DEFAULT },
        clip_pct: 12.3456,
      }
      const res = await ctx.tools.execute({
        name: 'stm_inspect',
        callId: 'reply-budget' as Parameters<typeof ctx.tools.execute>[0]['callId'],
        arguments: { question: '?'.repeat(MAX_QUESTION_CHARS), views: Array.from({ length: MAX_INSPECT_VIEWS }, () => view) },
        signal: new AbortController().signal,
      })
      expect(res.isError).toBe(false)

      const texts = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))
      const images = res.content.flatMap((b) => (b.type === 'image' ? [b.attachment] : []))
      expect(images).toHaveLength(MAX_INSPECT_VIEWS)
      for (const ref of images) expect([ref.width, ref.height]).toEqual([DISPLAY_MAX_DEFAULT, DISPLAY_MAX_DEFAULT])

      const readonlyPath = 'p'.repeat(READONLY_PATH_CHARS)
      const textCost = texts.reduce((t, s) => t + textTokens(s.length), 0)
      const imageCost = images.reduce(
        (t, ref) => t + IMAGE_TOKENS_AT_DEFAULT_DISPLAY + textTokens(requestImageHandleText(ref, ref, { readonlyPath }).length),
        0,
      )
      expect(textCost + imageCost, `文字 ${textCost} + 图像 ${imageCost}`).toBeLessThan(spillBudget())
      await ctx.registry.delete(visualMemoryProvider)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
