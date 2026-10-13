import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it } from 'vitest'
import type { ContentBlock, Context, ImageAttachmentRef, ImageBlock, SaveImageAttachment } from './index.js'

/**
 * Type-level pins for the image-result exports. This file lives in `src/`
 * so that `tsc -b` checks it (contract tests are not part of the build):
 * if dsh changes these shapes, or a type stops resolving and silently
 * becomes `any`, the build fails here first.
 */
type IsAny<T> = 0 extends 1 & T ? true : false

describe('image result types', () => {
  it('an ImageBlock references an attachment and is a ContentBlock', () => {
    const ref = {
      attachmentId: `sha256:${'0'.repeat(64)}`,
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    } as unknown as ImageAttachmentRef
    const block: ImageBlock = { type: 'image', attachment: ref }
    const content: ContentBlock[] = [{ type: 'text', text: 'label' }, block]
    // @ts-expect-error a pixel-carrying (MCP-style) block is not an ImageBlock
    const wrong: ImageBlock = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    const refIsTyped: IsAny<ImageAttachmentRef> = false
    expect(content).toHaveLength(2)
    expect(wrong.type).toBe('image')
    expect(refIsTyped).toBe(false)
  })

  it('ctx.attachments is typed as dsh\'s AttachmentStore and takes {data, mediaType, name}', () => {
    const storeOf = (ctx: Context): AttachmentStore => ctx.attachments
    const storeIsTyped: IsAny<Context['attachments']> = false
    const input: SaveImageAttachment = { data: new Uint8Array(1), mediaType: 'image/png', name: 't0007.s0.inspect-1.png' }
    expect(typeof storeOf).toBe('function')
    expect(storeIsTyped).toBe(false)
    expect(input.mediaType).toBe('image/png')
  })
})
