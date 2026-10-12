/**
 * One visual memory per dsh session (plugin.ts): the tools, called through a
 * REAL dsh dispatcher with an agent on the call, read and write that agent's
 * session; calls without an agent keep the root memory; a session found again
 * later restores its frames. And the harness's standing instructions are a
 * system-prompt section (prompt.ts).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, SystemPrompt, ToolRuntime, type ToolExecutionResult } from 'dsh-spm-compat'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from './plugin.js'
import { sessionDirName } from './plugin.js'
import { VISUAL_HARNESS_PROMPT, VISUAL_HARNESS_PROMPT_NAME } from './prompt.js'
import { encodeSyntheticSxm } from './synthetic-sxm.js'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.registry.delete(plugin)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function host(root = mkdtempSync(join(tmpdir(), 'vm-sessions-'))): Promise<{ ctx: Context; root: string }> {
  if (!dirs.includes(root)) dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(plugin, { root, displayMax: 64 }).await()
  return { ctx, root }
}

let n = 0
function call(ctx: Context, name: string, args: unknown, session?: string): Promise<ToolExecutionResult> {
  n += 1
  return ctx.tools.execute({
    name,
    callId: `call-${n}` as never,
    arguments: args,
    signal: new AbortController().signal,
    ...(session === undefined ? {} : { agent: { id: session } as never }),
  })
}

const text = (r: ToolExecutionResult): string => (r.content[0] as { text: string }).text

const SXM = encodeSyntheticSxm({
  nx: 16, ny: 8, widthM: 8e-9, heightM: 4e-9, offsetXM: 0, offsetYM: 0, scanDir: 'down',
  channels: [{ name: 'Z', unit: 'm', forward: Float32Array.from({ length: 128 }, (_, i) => 1e-12 * (i % 16)) }],
})

describe('the tools read and write the calling session', () => {
  it("notes: each session has its own; calls without an agent keep the root's", async () => {
    const { ctx, root } = await host()
    await call(ctx, 'stm_notes_write', { file: 'WORKING.md', content: 'plan A' }, 'session-a')
    expect(text(await call(ctx, 'stm_notes_read', { file: 'WORKING.md' }, 'session-a'))).toBe('plan A\n')
    expect(text(await call(ctx, 'stm_notes_read', { file: 'WORKING.md' }, 'session-b'))).toBe('WORKING.md does not exist yet.')
    expect(text(await call(ctx, 'stm_notes_read', { file: 'WORKING.md' }))).toBe('WORKING.md does not exist yet.')
    expect(readFileSync(join(root, 'sessions', 'session-a', 'notes', 'WORKING.md'), 'utf8')).toBe('plan A\n')
    expect(existsSync(join(root, 'notes', 'WORKING.md'))).toBe(false)
  })

  it('frames: a session sees its own archive only', async () => {
    const { ctx } = await host()
    ctx.frameArchive.session('session-a').archive.addScanBytes(1, SXM, { sourceName: 'a.sxm' })
    const view = { question: 'q', views: [{ label: 'v', frame: 't0001.s0' }] }
    const a = await call(ctx, 'stm_inspect', view, 'session-a')
    expect(a.content.map((b) => b.type)).toEqual(['text', 'text']) // reply + label (no attachment service here)
    expect(JSON.parse(text(a))).toMatchObject({ view_count: 1 })
    const b = await call(ctx, 'stm_inspect', view, 'session-b')
    expect(JSON.parse(text(b)).error).toMatch(/no frame 't0001\.s0'; the archive is empty/)
    const none = await call(ctx, 'stm_inspect', view)
    expect(JSON.parse(text(none)).error).toMatch(/the archive is empty/)
  })

  it('outside a tool call the service resolves the memory of calls without an agent', async () => {
    const { ctx, root } = await host()
    expect(ctx.frameArchive.current().session).toBeUndefined()
    expect(ctx.frameArchive.current().dir).toBe(root)
    expect(ctx.frameArchive.runInSession('s', () => ctx.frameArchive.current().session)).toBe('s')
  })
})

describe('session directories', () => {
  it('a plain id is the directory name; any other id gets a readable stem and a hash', () => {
    expect(sessionDirName('main-session-1b9f_x')).toBe('main-session-1b9f_x')
    expect(sessionDirName('acp:session/42')).toMatch(/^acp_session_42-[0-9a-f]{16}$/)
    expect(sessionDirName('acp:session/42')).toBe(sessionDirName('acp:session/42'))
    expect(sessionDirName('acp:session/42')).not.toBe(sessionDirName('acp:session.42'))
    expect(sessionDirName('NUL')).toMatch(/^NUL-[0-9a-f]{16}$/) // a Windows device name is not a directory
    expect(sessionDirName('会话')).toMatch(/^session-[0-9a-f]{16}$/)
    expect(sessionDirName('x'.repeat(101))).toMatch(/^x{48}-[0-9a-f]{16}$/)
  })

  it('a session found again (a later process on the same root) restores its frames and notes', async () => {
    const first = await host()
    first.ctx.frameArchive.session('session-a').archive.addScanBytes(1, SXM, { sourceName: 'a.sxm' })
    await call(first.ctx, 'stm_notes_write', { file: 'GUIDE.md', content: 'tip is sharp' }, 'session-a')
    const again = await host(first.root)
    const memory = again.ctx.frameArchive.session('session-a')
    expect(memory.archive.frames().map((e) => e.fid)).toEqual(['t0001.s0'])
    expect(memory.archive.currentTurn).toBe(1)
    expect(memory.notes.read('GUIDE.md')).toBe('tip is sharp\n')
  })

  it('a disposed agent releases its open memory; its files stay and reopen', async () => {
    const { ctx } = await host()
    const open = ctx.frameArchive.session('session-a')
    open.archive.addScanBytes(1, SXM, { sourceName: 'a.sxm' })
    expect(ctx.frameArchive.session('session-a')).toBe(open)
    ;(ctx as unknown as { emit(name: string, payload: unknown): void }).emit('agent/disposed', { agent: { id: 'session-a' } })
    const reopened = ctx.frameArchive.session('session-a')
    expect(reopened).not.toBe(open)
    expect(reopened.archive.frames().map((e) => e.fid)).toEqual(['t0001.s0'])
  })
})

describe('the standing instructions', () => {
  it("are a system-prompt section with the reference's lines (pinned)", async () => {
    const { ctx } = await host()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === VISUAL_HARNESS_PROMPT_NAME)
    expect(section?.text).toBe(VISUAL_HARNESS_PROMPT)
    expect(VISUAL_HARNESS_PROMPT.split('\n\n')).toEqual([
      '# Instrument task',
      'You are operating a scanning tunnelling microscope through the tools of this session.',
      'Complete the task with as little instrument time and as few instrument actions as possible.',
      'Build and use a compact, revisable model of the instrument, the tip and the sample, and of their current ' +
        'state. Update it as new evidence changes what is supported.',
      'Before each action that changes the instrument, briefly state what you expect to see. Afterward, briefly ' +
        'state all visible changes, expected or not.',
      'Keep concise, durable, revisable understanding in `GUIDE.md`; use `WORKING.md` as a scratchpad when useful.',
      'An earlier image that is no longer shown can be looked at again with `stm_inspect`.',
    ])
  })

  it('leave with the plugin', async () => {
    const { ctx } = await host()
    await ctx.registry.delete(plugin)
    contexts.splice(contexts.indexOf(ctx), 1)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map((s) => s.name)).not.toContain(VISUAL_HARNESS_PROMPT_NAME)
  })
})
