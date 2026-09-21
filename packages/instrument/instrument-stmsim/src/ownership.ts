import { execFile } from 'node:child_process'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** OS observations, not a simulator's self-reported simulated flag. */
export interface PortOwner {
  readonly port: number
  readonly pid: number
}

export function verifyPortOwners(ports: readonly number[], owners: readonly PortOwner[], allowedPids: ReadonlySet<number>): void {
  for (const port of ports) {
    const matches = owners.filter((owner) => owner.port === port)
    if (matches.length === 0 || matches.some((owner) => !allowedPids.has(owner.pid))) {
      throw new Error(`stmsim 端口 ${port} 不属于本轮启动的进程`)
    }
  }
}

/** Windows venv python.exe can launch the interpreter as its child. */
export function descendants(pid: number, processes: readonly { pid: number; parent: number }[]): Set<number> {
  const allowed = new Set([pid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (allowed.has(process.parent) && !allowed.has(process.pid)) {
        allowed.add(process.pid)
        changed = true
      }
    }
  }
  return allowed
}

export async function assertProcessOwnsPorts(pid: number, ports: readonly number[]): Promise<void> {
  if (process.platform === 'win32') {
    // No interpolated shell text: ports/PIDs are checked in JavaScript after the OS snapshot.
    const script = "$ErrorActionPreference='Stop'; $connections = @(Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess); $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); @{connections=$connections; processes=$processes} | ConvertTo-Json -Compress -Depth 4"
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 15_000, maxBuffer: 2_000_000,
    })
    const snapshot = JSON.parse(stdout.trim()) as {
      connections: { LocalPort: number; OwningProcess: number }[]
      processes: { ProcessId: number; ParentProcessId: number }[]
    }
    if (!snapshot.processes.some((item) => item.ProcessId === pid)) throw new Error('stmsim 启动进程已经退出')
    verifyPortOwners(ports, snapshot.connections.map((item) => ({ port: item.LocalPort, pid: item.OwningProcess })),
      descendants(pid, snapshot.processes.map((item) => ({ pid: item.ProcessId, parent: item.ParentProcessId }))))
    return
  }
  if (process.platform === 'linux') {
    // The Linux interpreter is the spawned process itself. Read its socket inodes
    // and match LISTEN entries; unrelated listeners and missing ownership both fail.
    const inodes = new Set<string>()
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`)
        const match = /^socket:\[(\d+)\]$/.exec(target)
        if (match) inodes.add(match[1]!)
      } catch { /* An fd can close during the snapshot; it cannot establish ownership. */ }
    }
    const owners: PortOwner[] = []
    for (const table of ['tcp', 'tcp6']) {
      const text = await readFile(`/proc/${pid}/net/${table}`, 'utf8')
      for (const row of text.trim().split('\n').slice(1)) {
        const fields = row.trim().split(/\s+/)
        if (fields[3] !== '0A') continue
        const port = Number.parseInt(fields[1]!.split(':')[1]!, 16)
        if (ports.includes(port)) owners.push({ port, pid: inodes.has(fields[9]!) ? pid : -1 })
      }
    }
    verifyPortOwners(ports, owners, new Set([pid]))
    return
  }
  throw new Error(`stmsim 进程归属验证尚未支持 ${process.platform}`)
}
