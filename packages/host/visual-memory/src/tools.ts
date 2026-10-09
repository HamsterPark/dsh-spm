/**
 * The model-visible tools of the visual memory, defined through dsh's
 * `defineTool` (via `dsh-spm-compat`, the only door to `@deepseek-ai/*`).
 *
 * | tool | does |
 * |---|---|
 * | `stm_inspect` | re-render archived frames: region, channel, direction, flattening |
 * | `stm_read_values` | read exact archived values at cell centres |
 * | `stm_notes_read` | read GUIDE.md or WORKING.md |
 * | `stm_notes_write` | replace GUIDE.md or WORKING.md |
 *
 * None of them touches the instrument; all four are concurrency-safe (the
 * archive and the notes store work synchronously inside one call, and the notes
 * files are replaced whole and atomically).
 *
 * ## How images reach the model (`docs/dsh/facts.md` §9)
 *
 * An image block references a durable attachment; it never carries pixels.
 * `execute` saves each PNG with `ctx.attachments.saveImage()` and returns the
 * references in its value; the pure `render` emits, per view, a label text block
 * followed by the image block. Labels carry the view's index and count because
 * some routes (OpenAI chat completions, DeepSeek) move all images of a tool
 * result into a following user message, where only their order is preserved;
 * every text block ends with a newline because DeepSeek joins text blocks with
 * no separator.
 *
 * ## Failures are values
 *
 * Invalid arguments and archive misses come back as a successful call whose
 * text is `{"error": …, "instrument_unchanged": true}` (the repo's convention:
 * domain failures are values, only bugs throw; spec/deviations.md D-VMEM-5).
 * Images that could not be stored
 * are reported in the text (`images_not_delivered`) instead of disappearing.
 */
import { defineTool, type ContentBlock, type ImageAttachmentRef, type ToolDefinition } from 'dsh-spm-compat'
import type { FrameArchive } from './archive.js'
import { FLATTEN_MODES, HIGHPASS_NM_DEFAULT } from './flatten.js'
import { GUIDE_FILE, MAX_GUIDE_BYTES, MAX_WORKING_BYTES, NOTE_FILES, NotesError, WORKING_FILE, type NotesStore } from './notes.js'
import { CLIP_PCT_DEFAULT, NAN_NAME } from './render.js'
import { DIRECTIONS } from './scan-data.js'
import {
  inspect,
  MAX_CLIP_PCT,
  MAX_HIGHPASS_NM,
  MAX_INSPECT_VIEWS,
  MAX_LABEL_CHARS,
  MAX_QUESTION_CHARS,
  MAX_READ_SAMPLES,
  MAX_READ_VIEWS,
  readValues,
  type ViewToolResult,
} from './views.js'

/** The slice of dsh's attachment service the tools use (`ctx.attachments`). */
export interface ImageSaver {
  saveImage(input: { data: Uint8Array; mediaType: 'image/png'; name?: string }): Promise<ImageAttachmentRef>
}

export interface VisualToolDeps {
  readonly archive: FrameArchive
  readonly notes: NotesStore
  /** The attachment service at call time; undefined when none is composed. */
  readonly attachments: () => ImageSaver | undefined
  /** Longest side of a rendered view, for the descriptions (default: the archive's). */
  readonly displayMax?: number
}

export const VISUAL_TOOL_NAMES = ['stm_inspect', 'stm_read_values', 'stm_notes_read', 'stm_notes_write'] as const

/** An {@link ImageAttachmentRef} as plain JSON (the tool value must be lossless JSON). */
export type AttachmentJson = {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

/** Value of the two view tools: the reply text and, per image, its label and attachment. */
export type ViewToolValue = {
  text: string
  images: { label: string; attachment?: AttachmentJson; error?: string }[]
}

function refToJson(ref: ImageAttachmentRef): AttachmentJson {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined
      ? {}
      : { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }),
  }
}

const VIEW_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    images: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', required: true },
          attachment: { type: 'json' },
          error: { type: 'string' },
        },
      },
    },
  },
} as const

function isImageRef(v: unknown): v is ImageAttachmentRef {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r['attachmentId'] === 'string' && typeof r['mediaType'] === 'string' && typeof r['width'] === 'number' && typeof r['height'] === 'number'
}

/** Pure rendering of a view-tool value into content blocks (exported for tests). */
export function renderViewValue(value: { readonly text: string; readonly images: readonly { readonly label: string; readonly attachment?: unknown; readonly error?: string }[] }): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: `${value.text}\n` }]
  for (const im of value.images) {
    if (isImageRef(im.attachment)) {
      blocks.push({ type: 'text', text: `${im.label}\n` }, { type: 'image', attachment: im.attachment })
    } else {
      blocks.push({ type: 'text', text: `${im.label}\n[image not delivered: ${im.error ?? 'no attachment'}]\n` })
    }
  }
  return blocks
}

/**
 * Largest reply text a view tool returns. dsh's spill policy replaces a
 * text-only tool result above 50,000 UTF-8 bytes with a head/tail preview
 * (facts.md §9.1); a readout cut in the middle is worse than a refusal that
 * says to ask for less. The margin leaves room for the trailing newline
 * (spec/deviations.md D-VMEM-4).
 */
export const MAX_REPLY_BYTES = 48_000

function errorMessage(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? `${e.code}: ` : ''
  return `${code}${typeof e?.message === 'string' ? e.message : String(err)}`
}

/** Store the images of a result and build the tool value. */
async function deliver(tool: string, result: ViewToolResult, saver: ImageSaver | undefined): Promise<ViewToolValue> {
  if (!result.ok) return { text: JSON.stringify({ error: result.error, instrument_unchanged: true }), images: [] }
  const size = Buffer.byteLength(JSON.stringify(result.reply), 'utf8')
  if (size > MAX_REPLY_BYTES) {
    const error =
      `${tool}: the reply would have ${size} bytes of text; a tool result is shown in full only up to ` +
      `${MAX_REPLY_BYTES} bytes. Ask for fewer views or fewer samples per call.`
    return { text: JSON.stringify({ error, instrument_unchanged: true }), images: [] }
  }
  const images: ViewToolValue['images'] = []
  for (const im of result.images) {
    if (saver === undefined) {
      images.push({ label: im.label, error: 'this composition has no attachment service (ctx.attachments)' })
      continue
    }
    try {
      const ref = await saver.saveImage({ data: im.png, mediaType: 'image/png', name: im.name })
      images.push({ label: im.label, attachment: refToJson(ref) })
    } catch (err) {
      images.push({ label: im.label, error: errorMessage(err) })
    }
  }
  const missing = images.filter((i) => i.attachment === undefined).length
  const reply = missing > 0 ? { ...result.reply, images_not_delivered: missing } : result.reply
  return { text: JSON.stringify(reply), images }
}

const REGION_DESCRIPTION = (dm: number): string =>
  'Rectangle in display pixels of the frame\'s full image: origin at the top-left corner, x to the right, ' +
  `y down. x and y are integers >= 0, width and height integers >= 1, and the rectangle must lie inside ` +
  `the frame's display image (at most ${dm}x${dm}; every frame summary gives its display_size).`

const COMMON_VIEW_PROPS = {
  label: { type: 'string', required: true, description: `A short name for this view (1 to ${MAX_LABEL_CHARS} characters).` },
  frame: {
    type: 'string',
    required: true,
    description: "Archived frame id, e.g. 't0007.s0' (saved scan), 't0007.p0' (partial scan), 't0007.m0' (derived image).",
  },
  channel: {
    type: 'string',
    description: "Scan channel, e.g. 'Z' or 'Current'. Default: the frame's default channel (Z; Current for a constant-height frame).",
  },
  direction: { type: 'string', enum: [...DIRECTIONS], description: 'Scan pass. Default forward.' },
} as const

const QUESTION = {
  type: 'string',
  required: true,
  description: `The visual question these views should answer (1 to ${MAX_QUESTION_CHARS} characters).`,
} as const

function inspectTool(deps: VisualToolDeps): ToolDefinition {
  const dm = deps.displayMax ?? deps.archive.displayMax
  return defineTool({
    name: 'stm_inspect',
    description:
      'Look again at archived frames without changing the instrument. Each view re-renders one frame from its ' +
      'archived values: a saved scan, a partial scan, or a derived image. For a scan, choose the channel, the ' +
      'direction (forward or backward), the flattening and the contrast. Omit region to see the whole frame, or ' +
      "select a rectangle in display pixels of that frame's full image (origin at the top-left corner, x to the " +
      'right, y down). The region is cropped exactly, widened to whole scan pixels, and enlarged by the largest ' +
      `whole number of image pixels per scan pixel that fits ${dm}x${dm}, without smoothing. Images are grey ` +
      `(black = low, white = high, contrast from the selected region); pixels never acquired are flat ${NAN_NAME}; ` +
      'nothing is drawn on them. A derived image is cropped as stored. State the visual question these views ' +
      `should answer and give each view a short label. 1 to ${MAX_INSPECT_VIEWS} views per call; they are returned ` +
      'in request order, one image each, every image preceded by a label line with its index. The reply text ' +
      "gives each view's region in display pixels and the scan-frame nm of its corners, the magnification, nm " +
      'per image pixel and the colour scale.',
    parameters: {
      question: QUESTION,
      views: {
        type: 'array',
        required: true,
        description: `1 to ${MAX_INSPECT_VIEWS} views, rendered in this order.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...COMMON_VIEW_PROPS,
            region: {
              type: 'object',
              additionalProperties: false,
              description: REGION_DESCRIPTION(dm),
              properties: {
                x: { type: 'integer', required: true },
                y: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
              },
            },
            flatten: {
              type: 'string',
              enum: [...FLATTEN_MODES],
              description:
                'Background removed before display, fitted over the whole frame: none; plane (default); line ' +
                "(plane, then each row's median offset); poly2 (2nd-order surface); highpass (median background of highpass_nm).",
            },
            highpass_nm: {
              type: 'number',
              description: `Background width in nm for flatten='highpass': more than 0, at most ${MAX_HIGHPASS_NM}. Default ${HIGHPASS_NM_DEFAULT}.`,
            },
            clip_pct: {
              type: 'number',
              description:
                `Contrast: black and white at this percentile and 100 minus it of the selected region, 0 to ${MAX_CLIP_PCT}. ` +
                `Default ${CLIP_PCT_DEFAULT}.`,
            },
          },
        },
      },
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('inspect', inspect(deps.archive, args), deps.attachments()),
  })
}

function readValuesTool(deps: VisualToolDeps): ToolDefinition {
  return defineTool({
    name: 'stm_read_values',
    description:
      'Read exact archived values from one or more frames without changing the instrument. For each view, the ' +
      "region (display pixels of that frame's full image: origin at the top-left corner, x to the right, y down; " +
      'omit it for the whole frame) is divided into equal rows and columns and the archived pixel at the centre ' +
      'of every cell is read: display pixel x + floor(((2c+1)*width)/(2*columns)), likewise for y. Values are ' +
      'physical and unflattened: Z in pm, current in pA (fA for a frame below 10 pA), frequency shift in Hz ' +
      '(mHz below 10 Hz), voltages in mV; the reply names the unit of every view. Values are rounded to 0.1 of ' +
      'that unit, null where nothing was acquired. The reply gives the sampled display pixels and the ' +
      `scan-frame nm of the first and last sample. 1 to ${MAX_READ_VIEWS} views and at most ${MAX_READ_SAMPLES} ` +
      'samples (rows x columns, summed over views) per call; a reply longer than 48000 bytes is refused, so split ' +
      'large readouts over several calls. This tool only reads values; it does not flatten, ' +
      'align, compare or interpret them. State the question and give each view a short label.',
    parameters: {
      question: QUESTION,
      views: {
        type: 'array',
        required: true,
        description: `1 to ${MAX_READ_VIEWS} views.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...COMMON_VIEW_PROPS,
            region: {
              type: 'object',
              additionalProperties: false,
              description: REGION_DESCRIPTION(deps.displayMax ?? deps.archive.displayMax),
              properties: {
                x: { type: 'integer', required: true },
                y: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
              },
            },
            rows: { type: 'integer', required: true, description: `Number of equal rows the region is divided into, 1 to ${MAX_READ_SAMPLES}.` },
            columns: { type: 'integer', required: true, description: `Number of equal columns the region is divided into, 1 to ${MAX_READ_SAMPLES}.` },
          },
        },
      },
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('read_values', readValues(deps.archive, args), deps.attachments()),
  })
}

const NOTE_FILE_PARAM = {
  type: 'string',
  required: true,
  enum: [...NOTE_FILES],
  description: `${GUIDE_FILE} (durable understanding) or ${WORKING_FILE} (current plan and state).`,
} as const

function notesReadTool(deps: VisualToolDeps): ToolDefinition {
  return defineTool({
    name: 'stm_notes_read',
    description:
      `Read one of your notes files for this session without changing the instrument: ${GUIDE_FILE}, your ` +
      `durable notes about the instrument, the tip and the sample, or ${WORKING_FILE}, your temporary state ` +
      '(the current plan and where you are in it).',
    parameters: { file: NOTE_FILE_PARAM },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      try {
        const text = deps.notes.read(args.file)
        return text ?? `${WORKING_FILE} does not exist yet.`
      } catch (err) {
        return JSON.stringify({ error: `stm_notes_read: ${errorMessage(err)}`, instrument_unchanged: true })
      }
    },
  })
}

function notesWriteTool(deps: VisualToolDeps): ToolDefinition {
  return defineTool({
    name: 'stm_notes_write',
    description:
      'Replace the complete contents of one of your notes files; this does not change the instrument. ' +
      `${GUIDE_FILE}: concise, durable, revisable understanding of the instrument, the sample and the tip for ` +
      `this session; revise it when new evidence changes what is supported. At most ${MAX_GUIDE_BYTES} bytes ` +
      `(64 KiB) of UTF-8. ${WORKING_FILE}: your temporary state — the active plan, the next expected ` +
      'observation, unresolved contradictions and the frame ids you still need. It persists until you replace ' +
      'it and survives context compaction: a fresh context receives the notes and the current observation. At ' +
      `most ${MAX_WORKING_BYTES} bytes (16 KiB) of UTF-8. Surrounding whitespace is removed; empty content is refused.`,
    parameters: {
      file: NOTE_FILE_PARAM,
      content: { type: 'string', required: true, description: 'The complete new file.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      try {
        const w = deps.notes.write(args.file, args.content)
        return JSON.stringify({ saved: w.file, bytes: w.bytes })
      } catch (err) {
        if (err instanceof NotesError) return JSON.stringify({ error: `stm_notes_write: ${err.message}`, instrument_unchanged: true })
        return JSON.stringify({ error: `stm_notes_write: ${errorMessage(err)}`, instrument_unchanged: true })
      }
    },
  })
}

/** The four tools, in the order the model should see them. */
export function defineVisualTools(deps: VisualToolDeps): ToolDefinition[] {
  return [inspectTool(deps), readValuesTool(deps), notesReadTool(deps), notesWriteTool(deps)]
}
