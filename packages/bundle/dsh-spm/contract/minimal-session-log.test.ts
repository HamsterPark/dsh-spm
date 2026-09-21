import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeConcatenatedZstd } from '../../../../scripts/minimal-session-log.ts'

describe('minimal native session log decoder', () => {
  it('decodes every independently compressed frame', () => {
    const rows = [
      { type: 'session', id: 's1' },
      { type: 'tool/call', data: { name: 'GetBias' } },
      { type: 'tool/result', data: { callId: 'c1' } },
    ]
    const encoded = Buffer.concat(rows.map((row) => zstdCompressSync(`${JSON.stringify(row)}\n`)))

    expect(decodeConcatenatedZstd(encoded).toString('utf8').trim().split('\n').map(JSON.parse)).toEqual(rows)
  })
})
