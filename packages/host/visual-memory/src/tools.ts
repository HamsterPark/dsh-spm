/**
 * The model-visible tools of the visual memory, defined through dsh's
 * `defineTool` (via `dsh-spm-compat`, the only door to `@deepseek-ai/*`).
 *
 * | tool | does |
 * |---|---|
 * | `stm_inspect` | re-render archived frames: region, channel, direction, flattening; spectra as line plots |
 * | `stm_read_values` | read exact archived values at cell centers; spectrum columns at bin centers |
 * | `stm_line_profile` | values and steps along a line, with an archived plot |
 * | `stm_fft_peaks` | peaks of a frame's Fourier spectrum, with a numbered spectrum image |
 * | `stm_detect_blobs` | compact bright or dark features, numbered on an image |
 * | `stm_frame_diff` | register two frames and archive their aligned difference with its values |
 * | `stm_frame_stats` | summary statistics of a frame or a region |
 * | `stm_notes_read` | read GUIDE.md or WORKING.md |
 * | `stm_notes_write` | replace GUIDE.md or WORKING.md |
 *
 * None of them touches the instrument; all are concurrency-safe (the
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
import { BACKGROUND_NM_DEFAULT, BLOBS_DEFAULT, detectBlobs, MAX_BLOBS, MIN_SEP_NM_DEFAULT } from './detect-blobs.js'
import { FFT_PEAKS_DEFAULT, fftPeaks, MAX_FFT_PEAKS, MIN_PEAK_STRENGTH } from './fft-peaks.js'
import { FLATTEN_MODES, HIGHPASS_NM_DEFAULT } from './flatten.js'
import { FRAME_DIFF_DESCRIPTION, frameDiff, frameDiffParameters } from './frame-diff.js'
import { frameStats } from './frame-stats.js'
import { lineProfile } from './line-profile.js'
import { GUIDE_FILE, MAX_GUIDE_BYTES, MAX_WORKING_BYTES, NOTE_FILES, NotesError, WORKING_FILE, type NotesStore } from './notes.js'
import { CLIP_PCT_DEFAULT, GRID_COLOUR_NAME, NAN_NAME } from './render.js'
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

export const VISUAL_TOOL_NAMES = [
  'stm_inspect',
  'stm_read_values',
  'stm_line_profile',
  'stm_fft_peaks',
  'stm_detect_blobs',
  'stm_frame_diff',
  'stm_frame_stats',
  'stm_notes_read',
  'stm_notes_write',
] as const

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

export function refToJson(ref: ImageAttachmentRef): AttachmentJson {
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

/** Output schema of a tool whose value is a {@link ViewToolValue} (also the K14 presenter's). */
export const VIEW_OUTPUT = {
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
 * Largest reply text a view tool returns. dsh's spill policy replaces a tool
 * result above its inline budget (an estimated 12,500 tokens shared by text
 * and images; about 50,000 characters of plain text) with a head/tail preview
 * (facts.md §9.1); a readout cut in the middle is worse than a refusal that
 * says to ask for less. The margin leaves room for the trailing newline
 * (spec/deviations.md D-VMEM-4; the contract test reply-budget.test.ts keeps
 * this cap and a full stm_inspect reply inside the budget).
 */
export const MAX_REPLY_BYTES = 48_000

/** Why an image was not stored when no attachment service is composed. */
export const NO_ATTACHMENT_SERVICE = 'this composition has no attachment service (ctx.attachments)'

export function errorMessage(err: unknown): string {
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
      images.push({ label: im.label, error: NO_ATTACHMENT_SERVICE })
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
    description:
      "Archived frame id, e.g. 't0007.s0' (saved scan), 't0007.p0' (partial scan), 't0007.d0' (spectrum), 't0007.m0' (derived image).",
  },
  channel: {
    type: 'string',
    description: "Scan channel, e.g. 'Z' or 'Current'. Default: the frame's default channel (Z; Current for a constant-height frame).",
  },
  direction: { type: 'string', enum: [...DIRECTIONS], description: 'Scan pass. Default forward.' },
} as const

const X_COL = { type: 'string', description: 'Spectrum only: x column (default the sweep column).' } as const

const X_RANGE = {
  type: 'array',
  items: { type: 'number' },
  description: "Spectrum only: [low, high] of the x axis, in the x column's unit as the plot shows it (bias in V, Z in pm).",
} as const

const QUESTION = {
  type: 'string',
  required: true,
  description: `The visual question these views should answer (1 to ${MAX_QUESTION_CHARS} characters).`,
} as const

function inspectTool(deps: VisualToolDeps): ToolDefinition {
  const dm = deps.displayMax ?? deps.archive.displayMax
  const drawn = deps.archive.grid
    ? `pixels never acquired are flat ${NAN_NAME}. Faint ${GRID_COLOUR_NAME} lines draw a square grid every grid_nm nm, ` +
      "counted from the top-left corner of the frame's full image along its own x and y, finer when you zoom in; " +
      'nothing else is drawn on them.'
    : `pixels never acquired are flat ${NAN_NAME}; nothing is drawn on them.`
  const spacing = deps.archive.grid ? ' the grid spacing (grid_nm),' : ''
  return defineTool({
    name: 'stm_inspect',
    description:
      'Look again at archived frames without changing the instrument. Each view re-renders one frame from its ' +
      'archived values: a saved scan, a partial scan, a spectrum or a derived image. For a scan, choose the channel, the ' +
      'direction (forward or backward), the flattening and the contrast. Omit region to see the whole frame, or ' +
      "select a rectangle in display pixels of that frame's full image (origin at the top-left corner, x to the " +
      'right, y down). The region is cropped exactly, widened to whole scan pixels, and enlarged by the largest ' +
      `whole number of image pixels per scan pixel that fits ${dm}x${dm}, without smoothing. Images are gray ` +
      `(black = low, white = high, contrast from the selected region); ${drawn} ` +
      'A spectrum view is a line plot (x_col, y_col, x_range instead of region); a derived image is cropped as ' +
      'stored. State the visual question these views ' +
      `should answer and give each view a short label. 1 to ${MAX_INSPECT_VIEWS} views per call; they are returned ` +
      'in request order, one image each, every image preceded by a label line with its index. The reply text ' +
      "gives each view's region in display pixels (region_px), the scan-frame nm of its corners (corners_nm), " +
      `the magnification, nm per image pixel,${spacing} and the values shown as black and white with the unit in the key ` +
      '(black_pm / white_pm for Z, black_pa / white_pa for current).',
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
            x_col: X_COL,
            y_col: {
              type: 'string',
              description: 'Spectrum only: one y column (default: up to the first 4 columns other than x, one panel each).',
            },
            x_range: X_RANGE,
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
      'Read exact archived values from one or more frames without changing the instrument. For a scan view, the ' +
      "region (display pixels of that frame's full image: origin at the top-left corner, x to the right, y down; " +
      'omit it for the whole frame) is divided into equal rows and columns and the archived pixel at the center ' +
      'of every cell is read: display pixel x + floor(((2c+1)*width)/(2*columns)), likewise for y. Values are ' +
      'physical and unflattened, in one unit per quantity carried by the key: values_pm for Z, values_pa for ' +
      "current, values_hz for frequency shift, values_v for voltages; rounded to the view's decimals (about " +
      "1/100 of the channel's value range); null where nothing was acquired. The reply gives the sampled " +
      'display pixels, the decimals and the scan-frame nm of the first and last sample. For a spectrum view, ' +
      "give x_range (in the x column's unit), n and y_cols instead; n samples at bin centers of the points in " +
      'x_range come back per column with column_units and column_decimals. ' +
      `1 to ${MAX_READ_VIEWS} views and at most ${MAX_READ_SAMPLES} samples (rows x columns for a scan, ` +
      'n x (1 + number of y_cols) for a spectrum, summed over views) per call; a reply longer than 48000 bytes is refused, so split ' +
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
            rows: { type: 'integer', description: `Scan frames: number of equal rows the region is divided into, 1 to ${MAX_READ_SAMPLES}.` },
            columns: { type: 'integer', description: `Scan frames: number of equal columns the region is divided into, 1 to ${MAX_READ_SAMPLES}.` },
            x_col: X_COL,
            y_cols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Spectrum only: columns to return besides x (default all).',
            },
            x_range: X_RANGE,
            n: {
              type: 'integer',
              description: `Spectrum only: number of samples at bin centers, 1 to ${MAX_READ_SAMPLES} (default: every point in x_range).`,
            },
          },
        },
      },
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('read_values', readValues(deps.archive, args), deps.attachments()),
  })
}

// ── measurement tools (vista_spm.measure) ────────────────────────────────

const MEASURE_FRAME = { type: 'string', required: true, description: "Archived scan frame id, e.g. 't0007.s0'." } as const
const MEASURE_CHANNEL = { type: 'string', description: "Channel, e.g. 'Z' or 'Current'. Default: the frame's default channel." } as const
const MEASURE_DIRECTION = { type: 'string', enum: [...DIRECTIONS], description: 'Scan pass. Default forward.' } as const

const POINT = {
  type: 'object',
  required: true,
  additionalProperties: false,
  description: "A point: either {x, y} in display pixels of the frame's full image, or {x_nm, y_nm} in scan-frame nm.",
  properties: { x: { type: 'number' }, y: { type: 'number' }, x_nm: { type: 'number' }, y_nm: { type: 'number' } },
} as const

function lineProfileTool(deps: VisualToolDeps): ToolDefinition {
  const dm = deps.displayMax ?? deps.archive.displayMax
  return defineTool({
    name: 'stm_line_profile',
    description:
      'Measure values along a straight line in one archived scan frame without changing the instrument. p1 and p2 ' +
      "are either {x, y} in display pixels of that frame's full image or {x_nm, y_nm} in scan-frame nm. The " +
      'flattened frame (default plane) is interpolated bilinearly at most one scan pixel apart and averaged across ' +
      'width_px. The reply gives distance_nm from p1 and the values (values_pm for Z, values_pa for current) per ' +
      "sample; the line's length and direction in the scan frame; the straight segments of a piecewise-linear fit " +
      '(from_nm, to_nm, slope, mean); and step candidates where the segments on either side of a short transition ' +
      'differ by at least 4 noise sigmas: position_nm along the line, the scan-frame x_nm and y_nm, the height ' +
      '(right side minus left side, e.g. height_pm) and transition_nm. A bump wider than the transition window ' +
      'appears as a rise and a fall. One plot of the profile is returned and archived as a derived frame ' +
      '(plot.frame). It measures; it does not decide what a step or a feature is. Keys carry their unit: _nm, ' +
      '_deg, _px, and for channel values _pm (Z), _pa (current), _hz (frequency shift), _v (voltage).',
    parameters: {
      frame: MEASURE_FRAME,
      p1: POINT,
      p2: POINT,
      channel: MEASURE_CHANNEL,
      direction: MEASURE_DIRECTION,
      width_px: { type: 'number', description: `Band width in display pixels averaged across the line, 1 to ${dm}. Default 1.` },
      flatten: { type: 'string', enum: [...FLATTEN_MODES], description: 'Background removed over the whole frame first (default plane).' },
      highpass_nm: {
        type: 'number',
        description: `Background width in nm for flatten='highpass': more than 0, at most ${MAX_HIGHPASS_NM}. Default ${HIGHPASS_NM_DEFAULT}.`,
      },
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('line_profile', lineProfile(deps.archive, args), deps.attachments()),
  })
}

function frameStatsTool(deps: VisualToolDeps): ToolDefinition {
  return defineTool({
    name: 'stm_frame_stats',
    description:
      "Summary statistics of one archived scan frame, or of a region of it (display pixels of the frame's full " +
      'image), without changing the instrument: mean, standard deviation, min, max and percentiles of the raw ' +
      'values; RMS roughness, mean absolute deviation and peak-to-valley after subtracting a plane fitted to the ' +
      'region; the correlation and RMS difference between the forward and backward passes (both plane-flattened) ' +
      'when both exist; a line-noise index (median absolute offset between consecutive row medians divided by the ' +
      'plane-flattened standard deviation); and the fraction of rows acquired. Keys carry their unit: _nm, _deg, ' +
      '_px, and for channel values _pm (Z), _pa (current), _hz (frequency shift), _v (voltage).',
    parameters: {
      frame: MEASURE_FRAME,
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
      channel: MEASURE_CHANNEL,
      direction: MEASURE_DIRECTION,
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('stats', frameStats(deps.archive, args), deps.attachments()),
  })
}

const MEASURE_REGION = (dm: number) =>
  ({
    type: 'object',
    additionalProperties: false,
    description: REGION_DESCRIPTION(dm),
    properties: {
      x: { type: 'integer', required: true },
      y: { type: 'integer', required: true },
      width: { type: 'integer', required: true },
      height: { type: 'integer', required: true },
    },
  }) as const

function fftPeaksTool(deps: VisualToolDeps): ToolDefinition {
  return defineTool({
    name: 'stm_fft_peaks',
    description:
      'Compute the 2-D Fourier spectrum of one archived scan frame, or of a region of it (display pixels of the ' +
      "frame's full image), without changing the instrument, and list its strongest peaks. The region is " +
      'flattened (default plane over the whole frame, then a plane over the region), Hann-windowed and ' +
      'zero-padded; the central DC lobe (2/field along each axis) is excluded. Each peak gives the spatial ' +
      'frequency k = 1/period in cycles per nm (k_per_nm, no 2 pi), the real-space period_nm, the direction of k ' +
      'in the scan frame (angle_deg, from +x toward +y, 0..180; stripes or atom rows with this period run ' +
      "perpendicular to it), its components and a strength: log-magnitude above the spectrum's 30th percentile " +
      'at the same |k|, in robust units of its lower spread. Only one peak of each +k/-k pair is listed; peaks ' +
      `weaker than ${MIN_PEAK_STRENGTH} are not. One image of the log-magnitude spectrum with the listed peaks numbered ` +
      "is returned (center = k 0, right = +x and up = +y of the frame's own axes) and archived as a derived frame " +
      '(image.frame). The spectrum is measured; whether a peak is a lattice, a reconstruction or noise is your judgement.',
    parameters: {
      frame: MEASURE_FRAME,
      region: MEASURE_REGION(deps.displayMax ?? deps.archive.displayMax),
      channel: MEASURE_CHANNEL,
      direction: MEASURE_DIRECTION,
      n_peaks: { type: 'integer', description: `Maximum number of peaks listed, 1 to ${MAX_FFT_PEAKS}. Default ${FFT_PEAKS_DEFAULT}.` },
      flatten: { type: 'string', enum: [...FLATTEN_MODES], description: 'Background removed over the whole frame first (default plane).' },
      highpass_nm: {
        type: 'number',
        description: `Background width in nm for flatten='highpass': more than 0, at most ${MAX_HIGHPASS_NM}. Default ${HIGHPASS_NM_DEFAULT}.`,
      },
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('fft_peaks', fftPeaks(deps.archive, args), deps.attachments()),
  })
}

function detectBlobsTool(deps: VisualToolDeps): ToolDefinition {
  return defineTool({
    name: 'stm_detect_blobs',
    description:
      'Find compact bright (or dark) features in one archived scan frame, or in a region of it (display pixels of ' +
      "the frame's full image), without changing the instrument. The frame is plane-flattened, a median background " +
      'of background_nm is subtracted, the residual is lightly smoothed, and local maxima above 6 robust noise ' +
      'sigmas are kept; maxima not separated by a saddle are merged; each feature is fitted with an elliptical ' +
      'Gaussian. Per blob: id, centroid in display pixels of the full frame (x_px, y_px) and in scan-frame nm ' +
      '(x_nm, y_nm), height relative to the local background (height_pm for Z, height_pa for current; negative for ' +
      "dark blobs), FWHM along the frame's x and y and along its major/minor axes (nm), elongation (major/minor), " +
      'the major axis angle (axis_angle_deg, scan frame, from +x toward +y) and whether the centroid comes from the ' +
      'Gaussian fit or from intensity moments (fit). Blobs are numbered in reading order (top to bottom, left to ' +
      'right). One image of the frame or region with numbered rings is returned and archived as a derived frame ' +
      '(image.frame); the marks exist only on that image. It counts and locates; it does not identify species or ' +
      'decide what is an atom. Keys carry their unit: _nm, _deg, _px, and for channel values _pm (Z), _pa ' +
      '(current), _hz (frequency shift), _v (voltage).',
    parameters: {
      frame: MEASURE_FRAME,
      region: MEASURE_REGION(deps.displayMax ?? deps.archive.displayMax),
      channel: MEASURE_CHANNEL,
      direction: MEASURE_DIRECTION,
      polarity: { type: 'string', enum: ['bright', 'dark'], description: 'Look for protrusions (bright, default) or depressions (dark).' },
      min_height: {
        type: 'number',
        description:
          'Only report blobs at least this high above (dark: this deep below) their local background, in the ' +
          "channel's unit (pm for Z, pA for current); 0 or more.",
      },
      min_sep_nm: {
        type: 'number',
        description: `Maxima closer than this are one candidate: more than 0, at most 100. Default ${MIN_SEP_NM_DEFAULT} nm.`,
      },
      background_nm: {
        type: 'number',
        description:
          'Width of the median background removed first: more than 0, at most 1000, and at least 3 scan pixels. ' +
          `Default ${BACKGROUND_NM_DEFAULT} nm; use a larger value for larger features.`,
      },
      max_n: { type: 'integer', description: `At most this many blobs, the highest: 1 to ${MAX_BLOBS}. Default ${BLOBS_DEFAULT}.` },
    },
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('detect_blobs', detectBlobs(deps.archive, args), deps.attachments()),
  })
}

function frameDiffTool(deps: VisualToolDeps): ToolDefinition {
  return defineTool({
    name: 'stm_frame_diff',
    description: FRAME_DIFF_DESCRIPTION,
    parameters: frameDiffParameters(deps.displayMax ?? deps.archive.displayMax),
    output: { schema: VIEW_OUTPUT, render: (_args, value) => renderViewValue(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => deliver('diff', frameDiff(deps.archive, args), deps.attachments()),
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

/** The tools, in the order the model should see them. */
export function defineVisualTools(deps: VisualToolDeps): ToolDefinition[] {
  return [
    inspectTool(deps),
    readValuesTool(deps),
    lineProfileTool(deps),
    fftPeaksTool(deps),
    detectBlobsTool(deps),
    frameDiffTool(deps),
    frameStatsTool(deps),
    notesReadTool(deps),
    notesWriteTool(deps),
  ]
}
