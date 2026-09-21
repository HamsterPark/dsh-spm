import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { NativeReadProbe } from '../../../../scripts/native-probe.ts'

function reply(command: string, value: number): Buffer {
  const frame = Buffer.alloc(52)
  Buffer.from(command).copy(frame)
  frame.writeUInt32BE(12, 32)
  if (command === 'Bias.Get') frame.writeFloatBE(value, 40)
  else frame.writeUInt32BE(value, 40)
  return frame
}

describe('independent native Nanonis probe', () => {
  it('serializes fragmented responses over exactly one TCP connection and closes only at the end', async () => {
    let connections = 0, receivedFin = 0
    const commands: string[] = []
    const server = createServer((socket) => {
      connections += 1
      let input = Buffer.alloc(0)
      socket.on('end', () => { receivedFin += 1 })
      socket.on('data', (chunk) => {
        input = Buffer.concat([input, chunk])
        while (input.length >= 40) {
          const request = input.subarray(0, 40)
          input = input.subarray(40)
          const command = request.subarray(0, 32).toString().replace(/\0+$/, '')
          commands.push(command)
          expect(request.readUInt16BE(36)).toBe(1)
          const bytes = reply(command, command === 'Bias.Get' ? 1.5 : 1)
          socket.write(bytes.subarray(0, 17))
          setImmediate(() => socket.write(bytes.subarray(17)))
        }
      })
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const probe = new NativeReadProbe(port)
    try {
      expect(await Promise.all([probe.read('Scan.StatusGet'), probe.read('ZCtrl.OnOffGet'), probe.read('Bias.Get')])).toEqual([1, 1, 1.5])
      expect(await probe.read('Bias.Get')).toBe(1.5)
      expect(commands).toEqual(['Scan.StatusGet', 'ZCtrl.OnOffGet', 'Bias.Get', 'Bias.Get'])
      expect(connections).toBe(1)
      expect(receivedFin).toBe(0)
    } finally { await probe.close(); await new Promise<void>((resolve) => server.close(() => resolve())) }
    expect(receivedFin).toBe(1)
  })

  it('times out with FIN and rejects subsequent reads without reconnecting', async () => {
    let connections = 0, serverSocket: Socket | undefined
    let observedFin: () => void = () => {}
    const fin = new Promise<void>((resolve) => { observedFin = resolve })
    const server = createServer((socket) => {
      connections += 1; serverSocket = socket
      socket.on('data', () => { /* deliberately keep the request unanswered */ })
      socket.on('end', observedFin)
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const probe = new NativeReadProbe((server.address() as { port: number }).port, 60)
    try {
      await expect(probe.read('Bias.Get')).rejects.toThrow('timeout')
      await fin
      await expect(probe.read('Scan.StatusGet')).rejects.toThrow('timeout')
      expect(connections).toBe(1)
    } finally { await probe.close(); serverSocket?.end(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('rejects a wrong command echo rather than accepting its plausible numeric payload', async () => {
    const server = createServer((socket) => {
      socket.on('data', () => socket.write(reply('Scan.StatusGet', 1)))
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const probe = new NativeReadProbe((server.address() as { port: number }).port)
    try { await expect(probe.read('Bias.Get')).rejects.toThrow('wrong reply echo') }
    finally { await probe.close(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
