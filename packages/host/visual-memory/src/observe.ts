/**
 * K14 (VISUAL-HARNESS §4.6; PLAN §8.1, "D12 修订"): the files a skill call left
 * in the controller's save directory become archived frames, and the current
 * observation image travels with the call's result.
 *
 * Two pieces, which the host composes with the kernel and the skill tools:
 *
 * - {@link frameObserver} is the kernel's `SkillObserver`. Before a depth-0
 *   skill runs it makes sure it knows which `.sxm` / `.dat` files the save
 *   directory already holds; afterwards it archives every file that is new or
 *   has changed, oldest first, into the calling session's archive, and picks
 *   the frames to show: the newest new scan, then the last two new spectra
 *   (the reference's `_observation_for`).
 * - {@link observationPresenter} is the skill tool's `OutcomePresenter`. It
 *   stores the shown frames' observation images as attachments and renders
 *   them after the result text, each after its label (as `stm_inspect` does).
 *   When images cannot reach the model it says so in the text
 *   (`images_not_delivered`, VISUAL-HARNESS §4.8) instead of dropping them.
 *
 * Both read `ctx.frameArchive` at call time: in a composition without the
 * visual memory they do nothing, and the skill's result is unchanged.
 *
 * ## Which files are new
 *
 * As in the reference (VISTA-SPM `host.py::_ingest_new_files`): the directory
 * is listed, not recursively, when it is first seen, and every data file there
 * counts as known; each later listing archives what is not known yet. A file
 * that fails to load is recorded as known too, with its size and modification
 * time, so one caught while it was being written is tried again once it
 * changes. Files that appeared between calls are archived by the next call,
 * under that call's turn. The result data is not searched for paths: skills do
 * not reliably report what the controller saved (`controllerSaveDir` in
 * `dsh-spm-stm-skills` lists why).
 *
 * ## Turns
 *
 * Frame ids carry the action counter (`t<turn>`, §4.2): a call that changes the
 * instrument opens the next turn of its session's archive; a read-only call
 * files what it finds under the current turn (0 before the first action).
 */
import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ContentBlock, Context, ToolRunContext } from 'dsh-spm-compat'
import type { ObservedCall, SkillObservation, SkillObserver, SkillOutcome } from 'dsh-spm-kernel'
import { entrySummary, type FrameArchive, type FrameEntry } from './archive.js'
import {
  errorMessage,
  NO_ATTACHMENT_SERVICE,
  refToJson,
  renderViewValue,
  VIEW_OUTPUT,
  type ViewToolValue,
} from './tools.js'

/** Text key of the count of images the model will not see (as in the view tools' replies). */
export const IMAGES_NOT_DELIVERED = 'images_not_delivered'

/** Why every image is counted as not delivered on a text-only route. */
export const TEXT_ONLY_ROUTE = "the session's model accepts text only"

export interface FrameObserverOptions {
  /**
   * The directory the controller saves `.sxm` / `.dat` files into, asked before
   * every depth-0 skill call; `null` when it cannot be told. The call's own
   * `safeCall` is there to ask the instrument (`controllerSaveDir`).
   */
  readonly saveDir: (call: ObservedCall) => Promise<string | null> | string | null
}

interface DataFile {
  readonly name: string
  readonly path: string
  readonly ext: '.sxm' | '.dat'
  readonly mtimeMs: number
  /** Size and modification time: a changed file is archived again. */
  readonly sig: string
}

/** The data files directly in `dir`; a missing directory holds none. */
function listDataFiles(dir: string): { readonly files: DataFile[] } | { readonly error: string } {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return { files: [] }
    return { error: errorMessage(err) }
  }
  const files: DataFile[] = []
  for (const name of names) {
    const ext = extname(name).toLowerCase()
    if (ext !== '.sxm' && ext !== '.dat') continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (st.isFile()) files.push({ name, path, ext, mtimeMs: st.mtimeMs, sig: `${st.size}:${st.mtimeMs}` })
    } catch {
      // gone between the listing and the stat: not there
    }
  }
  return { files }
}

type BeginToken = { readonly dir: string } | { readonly error: string } | null

/** The kernel's K14 observer over the frame archive (see the module comment). */
export function frameObserver(ctx: Context, options: FrameObserverOptions): SkillObserver {
  /** Directory → data file name → signature. Shared by every session: there is one controller. */
  const known = new Map<string, Map<string, string>>()

  return {
    async begin(call): Promise<BeginToken> {
      if (ctx.get('frameArchive') === undefined) return null
      let dir: string | null
      try {
        dir = await options.saveDir(call)
      } catch (err) {
        return { error: `the save directory could not be read: ${errorMessage(err)}` }
      }
      if (dir === null) return { error: 'the controller reported no save directory' }
      if (!known.has(dir)) {
        const listing = listDataFiles(dir)
        if ('error' in listing) return { error: `${dir} could not be listed: ${listing.error}` }
        known.set(dir, new Map(listing.files.map((f) => [f.name, f.sig])))
      }
      return { dir }
    },

    async end(token, call): Promise<SkillObservation | null> {
      const svc = ctx.get('frameArchive')
      if (svc === undefined) return null
      const { archive } = svc.current()
      let turn = archive.currentTurn
      if (call.stateChanging) {
        turn += 1
        archive.setTurn(turn)
      }
      const frames: FrameEntry[] = []
      const notArchived: { file: string; error: string }[] = []
      let error: string | undefined
      const t = token as BeginToken | undefined
      if (t !== null && t !== undefined && 'error' in t) error = t.error
      if (t !== null && t !== undefined && 'dir' in t) {
        const seen = known.get(t.dir) as Map<string, string>
        const listing = listDataFiles(t.dir)
        if ('error' in listing) {
          error = `${t.dir} could not be listed: ${listing.error}`
        } else {
          const fresh = listing.files
            .filter((f) => seen.get(f.name) !== f.sig)
            .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          for (const f of fresh) {
            seen.set(f.name, f.sig)
            const added = ingest(archive, turn, f)
            if ('error' in added) notArchived.push({ file: f.name, error: added.error })
            else frames.push(added.entry)
          }
        }
      }
      // A read-only call says only what it archived; an action always reports, and
      // only an action carries a save-directory problem (once per action, not on every read).
      if (!call.stateChanging) {
        if (frames.length === 0 && notArchived.length === 0) return null
        error = undefined
      }
      const scans = frames.filter((e) => e.kind === 's')
      const spectra = frames.filter((e) => e.kind === 'd')
      return {
        frames: frames.map((e) => ({ id: e.fid, summary: entrySummary(e) })),
        show: [...scans.slice(-1), ...spectra.slice(-2)].map((e) => e.fid),
        ...(call.stateChanging && frames.length === 0 ? { latestFrame: archive.latest('s')?.fid ?? null } : {}),
        notArchived,
        ...(error === undefined ? {} : { error }),
      }
    },
  }
}

/** Archive one data file: a scan (`.sxm`) or a spectrum (`.dat`). */
function ingest(archive: FrameArchive, turn: number, f: DataFile): { readonly entry: FrameEntry } | { readonly error: string } {
  try {
    return { entry: f.ext === '.sxm' ? archive.addScan(turn, f.path) : archive.addSpectrum(turn, f.path) }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

/**
 * Whether the session's model route takes images: `false` exactly when the
 * route's model declares its input modalities without `image` — the case in
 * which dsh's LlmRuntime replaces every image with a placeholder text
 * (docs/dsh/facts.md §9.3); a model that declares nothing gets the images.
 * The route is the one the session's latest request used (its request header),
 * else the agent's options. `undefined` when it cannot be told.
 */
export async function routeTakesImages(ctx: Context, exec: ToolRunContext): Promise<boolean | undefined> {
  const agent = exec.agent
  const llm = ctx.get('llm')
  if (agent === undefined || llm === undefined) return undefined
  try {
    const config = agent.session.requestHeader()?.config
    const provider = config?.provider ?? agent.options.provider
    const model = config?.model ?? agent.options.model
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities === undefined ? true : info.inputModalities.includes('image')
  } catch {
    return undefined
  }
}

/**
 * The tool value of a skill call: its result text, then the observation
 * images of the frames K14 chose to show, stored as attachments.
 */
export async function presentObservation(ctx: Context, outcome: SkillOutcome, exec: ToolRunContext): Promise<ViewToolValue> {
  const show = outcome.observation?.show ?? []
  const svc = ctx.get('frameArchive')
  if (show.length === 0 || svc === undefined) return { text: outcome.text, images: [] }
  const { archive } = svc.current()
  const saver = ctx.get('attachments')
  const images: ViewToolValue['images'] = []
  for (const fid of show) {
    let shot: { readonly label: string; readonly png: Uint8Array }
    try {
      shot = archive.observation(fid)
    } catch (err) {
      images.push({ label: `<visual kind="current" frame="${fid}"/>`, error: errorMessage(err) })
      continue
    }
    if (saver === undefined) {
      images.push({ label: shot.label, error: NO_ATTACHMENT_SERVICE })
      continue
    }
    try {
      const ref = await saver.saveImage({ data: shot.png, mediaType: 'image/png', name: `${fid}.png` })
      images.push({ label: shot.label, attachment: refToJson(ref) })
    } catch (err) {
      images.push({ label: shot.label, error: errorMessage(err) })
    }
  }
  const stored = images.filter((im) => im.attachment !== undefined).length
  const textOnly = stored > 0 && (await routeTakesImages(ctx, exec)) === false
  const missing = textOnly ? images.length : images.length - stored
  if (missing === 0) return { text: outcome.text, images }
  return {
    text: `${outcome.text}\n${IMAGES_NOT_DELIVERED}: ${missing}${textOnly ? ` (${TEXT_ONLY_ROUTE})` : ''}`,
    images,
  }
}

/**
 * A skill call's content: the text alone when no image goes with it (exactly
 * what a skill tool without a presenter gives), else the text followed by
 * each image's label and image block.
 */
export function renderObservation(value: ViewToolValue): ContentBlock[] {
  return value.images.length === 0 ? [{ type: 'text', text: value.text }] : renderViewValue(value)
}

/** The skill tools' K14 presenter (`defineSkillTool(skill, { kernel, present })`). */
export function observationPresenter(ctx: Context): {
  readonly schema: typeof VIEW_OUTPUT
  present(outcome: SkillOutcome, exec: ToolRunContext): Promise<ViewToolValue>
  render(value: unknown): ContentBlock[]
} {
  return {
    schema: VIEW_OUTPUT,
    present: (outcome, exec) => presentObservation(ctx, outcome, exec),
    render: (value) => renderObservation(value as ViewToolValue),
  }
}
