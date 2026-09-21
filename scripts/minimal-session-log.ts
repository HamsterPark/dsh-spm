import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

export function decodeConcatenatedZstd(source: Buffer): Buffer {
  const frames: Buffer[] = []
  let offset = 0
  while (offset < source.length) {
    const decoded = zstdDecompressSync(source.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer
      engine: { bytesWritten: number }
    }
    if (!decoded.engine.bytesWritten) throw new Error(`zstd decoder made no progress at byte ${offset}`)
    frames.push(decoded.buffer)
    offset += decoded.engine.bytesWritten
  }
  return Buffer.concat(frames)
}

export async function readSessionRows(path: string): Promise<any[]> {
  const source = await readFile(path)
  const text = path.endsWith('.zstd') ? decodeConcatenatedZstd(source).toString('utf8') : source.toString('utf8')
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}
