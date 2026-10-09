/**
 * GUIDE.md and WORKING.md: the notes the model writes for itself (VISUAL-HARNESS
 * D12-6, §4.4; VISTA's notes protocol).
 *
 * - `GUIDE.md` — durable, revisable understanding of the instrument, the tip and
 *   the sample for this session. It starts as `"No reliable model yet.\n"` and
 *   holds at most 64 KiB.
 * - `WORKING.md` — the current plan and state; it survives context compaction
 *   (the host re-injects it). At most 16 KiB. It does not exist until written.
 *
 * Writes replace the whole file atomically (temporary file + rename). The stored
 * text is the content with surrounding whitespace removed plus one newline, as
 * in the reference. Limits are UTF-8 bytes of the stored text (the files live
 * on disk as UTF-8); the Python reference counts characters, which is the same
 * for ASCII notes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const GUIDE_FILE = 'GUIDE.md'
export const WORKING_FILE = 'WORKING.md'
export const NOTE_FILES = [GUIDE_FILE, WORKING_FILE] as const
export type NoteFile = (typeof NOTE_FILES)[number]

export const GUIDE_INITIAL = 'No reliable model yet.\n'
export const MAX_GUIDE_BYTES = 64 * 1024
export const MAX_WORKING_BYTES = 16 * 1024

/** Invalid notes content or file name; the message says what to change. */
export class NotesError extends Error {
  override readonly name = 'NotesError'
}

export function isNoteFile(v: unknown): v is NoteFile {
  return v === GUIDE_FILE || v === WORKING_FILE
}

export function noteLimit(file: NoteFile): number {
  return file === GUIDE_FILE ? MAX_GUIDE_BYTES : MAX_WORKING_BYTES
}

export interface NoteWrite {
  readonly file: NoteFile
  /** UTF-8 bytes of the stored file. */
  readonly bytes: number
}

/** The GUIDE.md / WORKING.md store of one session. */
export class NotesStore {
  readonly root: string

  constructor(root: string, guideInitial: string = GUIDE_INITIAL) {
    this.root = root
    mkdirSync(root, { recursive: true })
    if (!existsSync(this.path(GUIDE_FILE))) this.replace(GUIDE_FILE, guideInitial)
  }

  path(file: NoteFile): string {
    return join(this.root, file)
  }

  /** The file's text, or null when WORKING.md has not been written. */
  read(file: NoteFile): string | null {
    if (!isNoteFile(file)) throw new NotesError(`file must be ${GUIDE_FILE} or ${WORKING_FILE}`)
    const p = this.path(file)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  /** Replace a file with `content`. Throws {@link NotesError} for invalid content. */
  write(file: NoteFile, content: unknown): NoteWrite {
    if (!isNoteFile(file)) throw new NotesError(`file must be ${GUIDE_FILE} or ${WORKING_FILE}`)
    if (typeof content !== 'string') throw new NotesError(`${file} content must be a string`)
    if (content.trim() === '') throw new NotesError(`${file} content must not be empty`)
    const text = `${content.trim()}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    const limit = noteLimit(file)
    if (bytes > limit) throw new NotesError(`${file} content has ${bytes} bytes of UTF-8; the limit is ${limit}`)
    this.replace(file, text)
    return { file, bytes }
  }

  private replace(file: NoteFile, text: string): void {
    const p = this.path(file)
    writeFileSync(`${p}.tmp`, text, 'utf8')
    renameSync(`${p}.tmp`, p)
  }
}
