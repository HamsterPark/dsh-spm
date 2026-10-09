/**
 * Cordis plugin entry: provides `ctx.frameArchive` and registers the four
 * visual-memory tools (VISUAL-HARNESS §4.1, §4.4).
 *
 * Not mounted by any profile or bundle yet: wiring it into K14, the IC persona
 * and the bundle is a later step of the plan (§6 step 4). The attachment service
 * is optional — it is read at call time with `ctx.get('attachments')`, so the
 * tools still answer (with `images_not_delivered`) in a composition without one.
 */
import { join } from 'node:path'
import { type Context, Service } from 'dsh-spm-compat'
import { FrameArchive, type ArchiveOptions, type DerivedMeta, type FrameEntry, type RenderOptions } from './archive.js'
import type { FrameKind } from './frame-id.js'
import { NotesStore } from './notes.js'
import type { ArrayInput, Direction, PartialGeometry, PartialMeta } from './scan-data.js'
import { defineVisualTools } from './tools.js'

export const name = 'mast-visual-memory'

export const inject = ['tools']

export interface Config extends ArchiveOptions {
  /** Directory of this session's visual memory: frames under `frames/`, notes under `notes/`. */
  readonly root: string
}

/** `ctx.frameArchive`: the archive interface of VISUAL-HARNESS §4.1 plus the notes store. */
export class FrameArchiveService extends Service {
  readonly archive: FrameArchive
  readonly notes: NotesStore

  constructor(ctx: Context, config: Config) {
    // Checked before registering the service, so a bad config leaves no half-made `ctx.frameArchive`.
    if (typeof config?.root !== 'string' || config.root.trim() === '') {
      throw new TypeError('mast-visual-memory needs config.root: the directory of the session\'s visual memory')
    }
    super(ctx, 'frameArchive')
    this.archive = new FrameArchive(join(config.root, 'frames'), config.displayMax === undefined ? {} : { displayMax: config.displayMax })
    this.notes = new NotesStore(join(config.root, 'notes'))
  }

  addScan(turn: number, path: string, meta: { readonly simS?: number } = {}): FrameEntry {
    return this.archive.addScan(turn, path, meta)
  }

  addPartial(
    turn: number,
    arrays: Readonly<Record<string, ArrayInput>>,
    meta: PartialMeta & { readonly geometry: PartialGeometry; readonly simS?: number },
  ): FrameEntry {
    return this.archive.addPartial(turn, arrays, meta)
  }

  addDerived(turn: number, png: Uint8Array, meta: DerivedMeta): FrameEntry {
    return this.archive.addDerived(turn, png, meta)
  }

  get(fid: string): FrameEntry {
    return this.archive.get(fid)
  }

  frames(filter: { readonly turn?: number; readonly kind?: FrameKind } = {}): FrameEntry[] {
    return this.archive.frames(filter)
  }

  latest(kind: FrameKind = 's'): FrameEntry | undefined {
    return this.archive.latest(kind)
  }

  index(): Record<string, unknown>[] {
    return this.archive.index()
  }

  array(fid: string, channel?: string | null, direction: Direction = 'forward') {
    return this.archive.array(fid, channel, direction)
  }

  render(fid: string, options: RenderOptions = {}) {
    return this.archive.render(fid, options)
  }

  observation(fid: string) {
    return this.archive.observation(fid)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    frameArchive: FrameArchiveService
  }
}

/**
 * Constructed directly rather than through `ctx.plugin(FrameArchiveService)`,
 * like the repo's other service plugins: the service's effects then belong to
 * this plugin and unload with it.
 */
export function apply(ctx: Context, config: Config): void {
  const svc = new FrameArchiveService(ctx, config)
  const tools = defineVisualTools({
    archive: svc.archive,
    notes: svc.notes,
    attachments: () => ctx.get('attachments'),
  })
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool))
}

export const visualMemoryProvider = { name, inject, apply }
