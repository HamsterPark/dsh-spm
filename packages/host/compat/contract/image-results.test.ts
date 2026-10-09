/**
 * Contract: how an image travels from a tool result to a model request in
 * dsh 0.1.5-rc.2 (VISUAL-HARNESS §7, facts.md §9). Real upstream packages,
 * no stand-ins for dsh itself; only the attachment store and the model
 * adapter are minimal subclasses of dsh's own abstract classes.
 *
 * What this pins:
 * 1. a tool's `output.render` returns `{type: 'image', attachment: ImageAttachmentRef}`
 *    blocks and the dispatcher hands them on verbatim (it does not check them);
 * 2. the attachment store is the Cordis service `attachments`, `saveImage` is
 *    the per-image entry point and `saveImages` enforces the batch limits;
 * 3. `LlmRuntime` replaces every image — nested inside tool results too — with
 *    a fixed placeholder text for a route that declares text-only input, and
 *    passes images through unchanged when the route declares `image` or
 *    declares nothing.
 */
import { AttachmentStore, isAttachmentError, type ImageAttachmentLimits, type SaveImageAttachment, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  contentHasImage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  projectImagesForTextModel,
  textOnlyImageText,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type ModelModality,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context, defineTool, SystemPrompt, ToolRuntime, type ContentBlock, type ImageAttachmentRef } from '../src/index.js'

const REF = {
  attachmentId: `sha256:${'ab'.repeat(32)}`,
  mediaType: 'image/png',
  bytes: 1234,
  width: 64,
  height: 32,
  name: 't0007.s0.inspect-1.png',
} as unknown as ImageAttachmentRef

async function toolRuntime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  return ctx
}

let calls = 0
function execute(ctx: Context, name: string, args: unknown = {}) {
  calls += 1
  return ctx.tools.execute({ name, callId: `c${calls}` as ToolCallId, arguments: args, signal: new AbortController().signal })
}

describe('image blocks in a tool result', () => {
  it('render returns label + image blocks; the dispatcher keeps them verbatim and the value carries the reference', async () => {
    const ctx = await toolRuntime()
    ctx.tools.register(
      defineTool({
        name: 'probe_image',
        description: 'returns one labelled image',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [
            { type: 'text', text: '<visual kind="inspection" index="1" count="1"/>\n' },
            { type: 'image', attachment: value as unknown as ImageAttachmentRef },
          ],
        },
        execute: () => Promise.resolve(REF as never),
      }),
    )
    const res = await execute(ctx, 'probe_image')
    expect(res.isError).toBe(false)
    expect(res.content).toEqual([
      { type: 'text', text: '<visual kind="inspection" index="1" count="1"/>\n' },
      { type: 'image', attachment: REF },
    ])
    if (!res.isError) expect(res.value).toEqual(REF)
  })

  it('does not validate image blocks: a pixel-carrying (MCP-style) block passes the dispatcher unchanged', async () => {
    // So nothing upstream catches a wrong shape before an adapter reads `block.attachment`;
    // the shape is our responsibility (dsh-spm-visual-memory renders only references).
    const ctx = await toolRuntime()
    const mcpStyle = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    ctx.tools.register(
      defineTool({
        name: 'probe_mcp_image',
        description: 'returns a block of the wrong shape',
        parameters: {},
        output: { schema: { type: 'string' }, render: () => [mcpStyle as unknown as ContentBlock] },
        execute: () => Promise.resolve('x'),
      }),
    )
    const res = await execute(ctx, 'probe_mcp_image')
    expect(res.isError).toBe(false)
    expect(res.content).toEqual([mcpStyle])
  })

  it('a render that throws becomes an error result, not a crash', async () => {
    const ctx = await toolRuntime()
    ctx.tools.register(
      defineTool({
        name: 'probe_render_throws',
        description: 'render fails',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: () => {
            throw new Error('render exploded')
          },
        },
        execute: () => Promise.resolve('x'),
      }),
    )
    const res = await execute(ctx, 'probe_render_throws')
    expect(res.isError).toBe(true)
  })
})

class TestStore extends AttachmentStore {
  readonly saved: SaveImageAttachment[] = []
  get imageLimits(): ImageAttachmentLimits {
    return {
      maxImageBytes: 1 << 20,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 1 << 20,
      maxImagePixels: 1 << 22,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    }
  }
  validateImage(): Promise<void> {
    return Promise.resolve()
  }
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({ ...REF, name: input.name } as ImageAttachmentRef)
  }
  readImage(): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('not used'))
  }
}

describe('the attachment store seam', () => {
  it('is the Cordis service "attachments"', () => {
    const ctx = new Context()
    expect(ctx.get('attachments')).toBeUndefined()
    const store = new TestStore(ctx)
    // Cordis hands out a context-bound view of the instance, not the instance itself.
    const seen = ctx.get('attachments') as TestStore | undefined
    expect(seen).toBeDefined()
    expect(seen?.saved).toBe(store.saved)
  })

  it('saveImage takes {data, mediaType, name}; saveImages enforces the per-message batch limits', async () => {
    const ctx = new Context()
    const store = new TestStore(ctx)
    const png = (name: string): SaveImageAttachment => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name })
    expect(await store.saveImage(png('a.png'))).toMatchObject({ name: 'a.png' })
    expect((await store.saveImages([png('b.png'), png('c.png')])).map((r) => r.name)).toEqual(['b.png', 'c.png'])
    const err = await store.saveImages([png('d'), png('e'), png('f')]).catch((e: unknown) => e)
    expect(isAttachmentError(err)).toBe(true)
    expect((err as { code: string }).code).toBe('TOO_MANY_IMAGES')
    expect(store.saved.map((s) => s.name)).toEqual(['a.png', 'b.png', 'c.png']) // nothing of the refused batch
    const wrongType = await store.saveImages([{ data: new Uint8Array(1), mediaType: 'image/bmp' as never }]).catch((e: unknown) => e)
    expect((wrongType as { code: string }).code).toBe('UNSUPPORTED_IMAGE_TYPE')
  })
})

class RecordingAdapter extends LlmAdapter {
  readonly seen: Message[][] = []
  constructor(private readonly modalities: readonly ModelModality[] | undefined) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...(this.modalities === undefined ? {} : { inputModalities: this.modalities }) })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.seen.push(options.messages)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function history(): Message[] {
  return [
    createUserMessage({ content: [{ type: 'text', text: 'look at the frame' }], source: { kind: 'user' } }),
    createToolResultMessage({
      callId: 'call-1' as ToolCallId,
      isError: false,
      content: [
        { type: 'text', text: '{"view_count":1}\n' },
        { type: 'text', text: '<visual kind="inspection" index="1" count="1"/>\n' },
        { type: 'image', attachment: REF },
      ],
    }),
  ]
}

async function sendThrough(modalities: readonly ModelModality[] | undefined): Promise<Message[]> {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const adapter = new RecordingAdapter(modalities)
  llm.registerAdapter(['probe'], adapter)
  for await (const chunk of llm.stream({ provider: 'probe', model: 'm', messages: history() })) void chunk
  expect(adapter.seen).toHaveLength(1)
  return adapter.seen[0] as Message[]
}

function toolResultContent(messages: readonly Message[]): readonly ContentBlock[] {
  const block = messages[1]?.content[0] as { type: string; content: ContentBlock[] }
  expect(block.type).toBe('tool-result')
  return block.content
}

describe('what an adapter receives', () => {
  it('a text-only route gets a fixed placeholder instead of each image, inside the tool result', async () => {
    const content = toolResultContent(await sendThrough(['text']))
    const placeholder = '[image omitted because this model accepts text only; attachment sha256:abababab]'
    expect(textOnlyImageText(REF)).toBe(placeholder)
    expect(content).toEqual([
      { type: 'text', text: '{"view_count":1}\n' },
      { type: 'text', text: '<visual kind="inspection" index="1" count="1"/>\n' },
      { type: 'text', text: placeholder },
    ])
  })

  it('an image route, and a route that declares no modalities, get the image block unchanged', async () => {
    for (const modalities of [['text', 'image'] as const, undefined]) {
      const content = toolResultContent(await sendThrough(modalities))
      expect(content.at(-1)).toEqual({ type: 'image', attachment: REF })
    }
  })

  it('the projection helpers see images nested in tool results', () => {
    const msgs = history()
    expect(contentHasImage(msgs[1]?.content ?? [])).toBe(true)
    expect(contentHasImage(msgs[0]?.content ?? [])).toBe(false)
    const projected = projectImagesForTextModel(msgs)
    expect(contentHasImage(projected[1]?.content ?? [])).toBe(false)
    expect(projected[0]).toBe(msgs[0]) // untouched messages are not copied
  })
})
