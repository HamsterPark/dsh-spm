import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { descendants, verifyPortOwners } from './ownership.js'
import { StmsimProcess } from './process.js'

describe('managed simulator OS identity', () => {
  it('rejects a missing listener and a foreign listener even when another expected port is owned', () => {
    expect(() => verifyPortOwners([18001, 18002], [{ port: 18001, pid: 42 }], new Set([42]))).toThrow(/18002/)
    expect(() => verifyPortOwners([18001], [{ port: 18001, pid: 42 }, { port: 18001, pid: 99 }], new Set([42]))).toThrow(/18001/)
  })

  it('accepts Windows venv interpreter descendants without accepting siblings or unrelated processes', () => {
    const allowed = descendants(42, [{ pid: 44, parent: 43 }, { pid: 43, parent: 42 }, { pid: 41, parent: 1 }, { pid: 42, parent: 1 }])
    expect([...allowed].sort()).toEqual([42, 43, 44])
    expect(() => verifyPortOwners([18001], [{ port: 18001, pid: 44 }], allowed)).not.toThrow()
    expect(() => verifyPortOwners([18001], [{ port: 18001, pid: 41 }], allowed)).toThrow()
  })

  it('rejects source-tree output paths before creating them or starting a process', async () => {
    const source = mkdtempSync(join(tmpdir(), 'stmsim-source-test-'))
    const forbidden = join(source, 'must-not-exist')
    try {
      const sim = new StmsimProcess({ root: source, python: 'unused', runtimeDir: forbidden })
      await expect(sim.start()).rejects.toThrow(/runtimeDir/)
      expect(existsSync(forbidden)).toBe(false)
      expect(sim.identity.pid).toBeUndefined()
    } finally { rmSync(source, { recursive: true, force: true }) }
  })
})
