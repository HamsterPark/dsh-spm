/**
 * Cordis plugin entry: provides `ctx.frameArchive`, registers the four
 * visual-memory tools (VISUAL-HARNESS §4.1, §4.4) and the harness's standing
 * instructions (§4.7, `prompt.ts`).
 *
 * Not mounted by any profile or bundle yet: the bundle composes it with the
 * kernel's K14 observer and the skill tools' presenter (`observe.ts`). The
 * attachment service is optional — it is read at call time with
 * `ctx.get('attachments')`, so the tools still answer (with
 * `images_not_delivered`) in a composition without one.
 *
 * ## One visual memory per dsh session
 *
 * `config.root` holds every session's memory: `<root>/sessions/<session>/frames`
 * and `.../notes`, where `<session>` is the session id of the agent that made
 * the tool call (`exec.agent.id`; {@link sessionDirName} makes it safe as a
 * directory name). A session that is resumed later, in this process or the
 * next, finds its frames and notes again; two sessions never see each other's.
 * Calls without an agent (tests, host code, the service methods below) use
 * `<root>/frames` and `<root>/notes`, as before sessions existed.
 *
 * How a call finds its session: the plugin runs every tool dispatch
 * (`tools/execute`) inside an AsyncLocalStorage scope keyed by the call's agent,
 * and the tools' `archive` / `notes` are getters that resolve that scope when
 * they are read. So a tool reads `deps.archive` / `deps.notes` at call time,
 * inside `execute` — never at definition time. K14 runs inside the skill tool's
 * dispatch and resolves the same scope ({@link FrameArchiveService.current}).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { type Context, Service } from 'dsh-spm-compat'
import { FrameArchive, type ArchiveOptions, type DerivedMeta, type FrameEntry, type RenderOptions } from './archive.js'
import type { FrameKind } from './frame-id.js'
import { NotesStore } from './notes.js'
import { VISUAL_HARNESS_PROMPT, VISUAL_HARNESS_PROMPT_NAME, VISUAL_HARNESS_PROMPT_ORDER } from './prompt.js'
import type { ArrayInput, Direction, PartialGeometry, PartialMeta } from './scan-data.js'
import { defineVisualTools } from './tools.js'

export const name = 'mast-visual-memory'

export const inject = ['tools', 'systemPrompt']

export interface Config extends ArchiveOptions {
  /**
   * Directory of the visual memory: each dsh session's frames and notes under
   * `sessions/<session>/`, those of calls without an agent under `frames/` and `notes/`.
   */
  readonly root: string
  /** Graph paper on scan images; default true (VISTA's whole tool set, VISUAL-HARNESS §4.3). */
  readonly grid?: boolean
}

/** One session's visual memory. */
export interface SessionMemory {
  /** The dsh session (agent) id; `undefined` for calls without an agent. */
  readonly session: string | undefined
  /** Directory holding `frames/` and `notes/`. */
  readonly dir: string
  readonly archive: FrameArchive
  readonly notes: NotesStore
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * A session id as a directory name: unchanged when it is a plain name
 * (letters, digits, `_`, `-`; at most 100), otherwise a readable stem plus 16
 * hex of its SHA-256, so distinct ids never share a directory and the same id
 * always finds the same one.
 */
export function sessionDirName(session: string): string {
  if (/^[A-Za-z0-9_-]{1,100}$/.test(session) && !WINDOWS_DEVICE.test(session)) return session
  const stem = session.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'session'
  return `${stem}-${createHash('sha256').update(session, 'utf8').digest('hex').slice(0, 16)}`
}

/** `ctx.frameArchive`: the archive interface of VISUAL-HARNESS §4.1 plus the notes store. */
export class FrameArchiveService extends Service {
  /** The archive of calls without an agent (`<root>/frames`). */
  readonly archive: FrameArchive
  /** The notes of calls without an agent (`<root>/notes`). */
  readonly notes: NotesStore
  private readonly root: string
  private readonly archiveOptions: ArchiveOptions
  private readonly sessions = new Map<string, SessionMemory>()
  private readonly scope = new AsyncLocalStorage<string | undefined>()

  constructor(ctx: Context, config: Config) {
    // Checked before registering the service, so a bad config leaves no half-made `ctx.frameArchive`.
    if (typeof config?.root !== 'string' || config.root.trim() === '') {
      throw new TypeError('mast-visual-memory needs config.root: the directory of the session\'s visual memory')
    }
    super(ctx, 'frameArchive')
    this.root = config.root
    this.archiveOptions = {
      ...(config.displayMax === undefined ? {} : { displayMax: config.displayMax }),
      grid: config.grid ?? true,
    }
    this.archive = new FrameArchive(join(config.root, 'frames'), this.archiveOptions)
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

  // ── sessions ──────────────────────────────────────────────────────────

  /**
   * One session's memory, opened on first use (an existing directory is
   * restored from its index); `undefined` or `null` gives the memory of calls
   * without an agent.
   */
  session(session?: string | null): SessionMemory {
    if (session === undefined || session === null) {
      return { session: undefined, dir: this.root, archive: this.archive, notes: this.notes }
    }
    const open = this.sessions.get(session)
    if (open !== undefined) return open
    const dir = join(this.root, 'sessions', sessionDirName(session))
    const memory: SessionMemory = {
      session,
      dir,
      archive: new FrameArchive(join(dir, 'frames'), this.archiveOptions),
      notes: new NotesStore(join(dir, 'notes')),
    }
    this.sessions.set(session, memory)
    return memory
  }

  /** The memory of the tool call in progress (its agent's session); outside a call, that of calls without an agent. */
  current(): SessionMemory {
    return this.session(this.scope.getStore())
  }

  /** Run `fn` as part of a session's calls: what the plugin's `tools/execute` wrapper does for every dispatch. */
  runInSession<T>(session: string | undefined, fn: () => T): T {
    return this.scope.run(session, fn)
  }

  /** Close a session that ended: drop its open archive (and cached arrays). Its files stay; a resume reopens them. */
  release(session: string): void {
    this.sessions.delete(session)
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
  // Every tool dispatch runs in its agent's session (module comment). A
  // host-level listener receives every agent's calls.
  ctx.effect(() =>
    ctx.on('tools/execute', (exec, next) =>
      svc.runInSession(exec.agent === undefined ? undefined : String(exec.agent.id), next),
    ),
  )
  ctx.effect(() => ctx.on('agent/disposed', (payload) => svc.release(String(payload.agent.id))))
  const tools = defineVisualTools({
    // Getters, read by the tools at call time: the calling session's memory.
    get archive() {
      return svc.current().archive
    },
    get notes() {
      return svc.current().notes
    },
    attachments: () => ctx.get('attachments'),
  })
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool))
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: VISUAL_HARNESS_PROMPT_NAME,
      order: VISUAL_HARNESS_PROMPT_ORDER,
      text: VISUAL_HARNESS_PROMPT,
    }),
  )
}

export const visualMemoryProvider = { name, inject, apply }
