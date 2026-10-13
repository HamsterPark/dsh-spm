import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GUIDE_INITIAL, isNoteFile, MAX_GUIDE_BYTES, MAX_WORKING_BYTES, noteLimit, NotesError, NotesStore } from './notes.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function store(): NotesStore {
  const d = mkdtempSync(join(tmpdir(), 'vm-notes-'))
  dirs.push(d)
  return new NotesStore(join(d, 'notes'))
}

describe('notes store', () => {
  it('starts GUIDE.md as "No reliable model yet." and has no WORKING.md', () => {
    const s = store()
    expect(GUIDE_INITIAL).toBe('No reliable model yet.\n')
    expect(s.read('GUIDE.md')).toBe(GUIDE_INITIAL)
    expect(s.read('WORKING.md')).toBeNull()
  })

  it('replaces the whole file with trimmed content plus one newline', () => {
    const s = store()
    expect(s.write('WORKING.md', '\n  plan: scan t0003 again\n\n')).toEqual({ file: 'WORKING.md', bytes: 23 })
    expect(s.read('WORKING.md')).toBe('plan: scan t0003 again\n')
    s.write('WORKING.md', 'second')
    expect(readFileSync(s.path('WORKING.md'), 'utf8')).toBe('second\n')
    expect(existsSync(`${s.path('WORKING.md')}.tmp`)).toBe(false)
  })

  it('keeps an existing GUIDE.md when the store is reopened', () => {
    const s = store()
    s.write('GUIDE.md', 'tip is sharp')
    const again = new NotesStore(s.root)
    expect(again.read('GUIDE.md')).toBe('tip is sharp\n')
  })

  it('counts the limit in UTF-8 bytes of the stored text', () => {
    const s = store()
    expect(noteLimit('GUIDE.md')).toBe(MAX_GUIDE_BYTES)
    expect(noteLimit('WORKING.md')).toBe(MAX_WORKING_BYTES)
    expect(s.write('WORKING.md', 'x'.repeat(MAX_WORKING_BYTES - 1)).bytes).toBe(MAX_WORKING_BYTES)
    expect(() => s.write('WORKING.md', 'x'.repeat(MAX_WORKING_BYTES))).toThrow(/16385 bytes of UTF-8; the limit is 16384/)
    // three bytes per character: 5462 characters are 16387 bytes with the newline
    expect(() => s.write('WORKING.md', '针'.repeat(5462))).toThrow(NotesError)
    expect(s.write('GUIDE.md', '针'.repeat(5461)).bytes).toBe(16384)
  })

  it('refuses empty or non-string content and unknown files', () => {
    const s = store()
    expect(() => s.write('GUIDE.md', '   \n')).toThrow(/must not be empty/)
    expect(() => s.write('GUIDE.md', 42)).toThrow(/must be a string/)
    expect(() => s.write('NOTES.md' as never, 'x')).toThrow(/GUIDE\.md or WORKING\.md/)
    expect(() => s.read('NOTES.md' as never)).toThrow(NotesError)
    expect(s.read('GUIDE.md')).toBe(GUIDE_INITIAL)
    expect(isNoteFile('WORKING.md')).toBe(true)
    expect(isNoteFile('working.md')).toBe(false)
  })

  it('accepts a custom initial guide', () => {
    const d = mkdtempSync(join(tmpdir(), 'vm-notes-'))
    dirs.push(d)
    writeFileSync(join(d, 'unrelated.txt'), 'x')
    const s = new NotesStore(d, 'Start here.\n')
    expect(s.read('GUIDE.md')).toBe('Start here.\n')
  })
})
