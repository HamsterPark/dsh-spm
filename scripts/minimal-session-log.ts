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

/**
 * 持久会话里与某次工具调用配对的 `tool/result` 事件。dsh 0.1.7 起会话为 V4：工具结果是独立的 `role: 'tool'` 消息，
 * `toolCallId` / `isError` 在消息上（以前是 user 消息里的 `tool-result` 块）。
 */
export function pairedToolResult(events: readonly any[], callId: unknown): any | undefined {
  return events.find((event) => event.type === 'tool/result' && event.data?.message?.toolCallId === callId)
}
