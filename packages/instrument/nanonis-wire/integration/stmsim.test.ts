import { describe, expect, it } from 'vitest'
import { RoleLink, createFacade, decodeReturns, encodeArgs, parseErrorSection } from '../src/index.js'

/**
 * 对**真** stmsim 的往返。单测用假服务器造故障，这里证明我们跟真东西说得上话。
 *
 * 起模拟器（本机 PATH 里没有 python，用旧仓 venv 的绝对路径）：
 *
 *     cd D:\STM-Bench
 *     D:\...\MAST\.venv-v2-py313\Scripts\python.exe -m stmsim serve \
 *         --profile polar-spm --seed 0 --material "Au(111)" \
 *         --ports 16501,16502,16503,16504 --approached
 *
 * 然后 `STMSIM_PORT=16501 pnpm test --project integration`。
 *
 * **没设 `STMSIM_PORT` 就整组跳过**，并打印原因——不是静默跳过。
 * 课时 1.7（`instrument-stmsim` provider）会把「起停模拟器」做成 globalSetup，那时这里改成无条件跑；
 * 在那之前不重复造 spawn 逻辑。
 */
const port = Number(process.env['STMSIM_PORT'] ?? '')
const enabled = Number.isInteger(port) && port > 0
if (!enabled) {
  console.warn('[integration] 未设 STMSIM_PORT，跳过 stmsim 往返测试（见本文件头部注释）')
}

describe.skipIf(!enabled)('对真 stmsim 的往返', () => {
  async function connect(): Promise<RoleLink> {
    const link = new RoleLink({ port })
    await link.connect()
    return link
  }

  it('Bias.Get 读到一个物理上说得通的偏压', async () => {
    const link = await connect()
    try {
      const body = await link.request('Bias.Get', new Uint8Array())
      const { values, errorSection } = decodeReturns(body, ['f'])
      expect(parseErrorSection(errorSection).status).toBe(0)
      expect(typeof values[0]).toBe('number')
      expect(Math.abs(values[0] as number)).toBeLessThanOrEqual(10) // 安全包络的偏压上限
    } finally {
      await link.close()
    }
  })

  it('类型化门面走通同一条路：设偏压再读回来', async () => {
    const link = await connect()
    try {
      const typed = createFacade(async (command, args, returns) => {
        const body = await link.request(command, encodeArgs(args))
        const { values, errorSection } = decodeReturns(body, returns)
        const err = parseErrorSection(errorSection)
        if (err.status !== 0) throw new Error(`${command}: ${err.description}`)
        return values
      })

      await typed.Bias_Set(0.25)
      const [read] = await typed.Bias_Get()
      // float32 往返，别用严格相等
      expect(read).toBeCloseTo(0.25, 5)
    } finally {
      await link.close()
    }
  })

  it('优雅关闭后端口能立刻复用——强杀会永久损坏真机端口', async () => {
    const first = await connect()
    await first.request('Bias.Get', new Uint8Array())
    await first.close()

    const second = await connect()
    try {
      await expect(second.request('Bias.Get', new Uint8Array())).resolves.toBeInstanceOf(Uint8Array)
    } finally {
      await second.close()
    }
  })

  it('模拟器没实现的动词回的是错误段，不是断链', async () => {
    // stmsim 只实现 215/671；没实现的走 NotImplementedVerb ⇒ status≠0 的 error-only body。
    // 关键是**连接还活着**：这类拒绝是仪器的正常答复，不该被当成线路故障计入熔断（1.5）。
    const link = await connect()
    try {
      const body = await link.request('PLL.OnOffSet', encodeArgs([{ value: 1, fmt: 'i' }, { value: 1, fmt: 'I' }]))
      const err = parseErrorSection(body)
      expect(err.errorOnly).toBe(true)
      expect(err.status).not.toBe(0)
      expect(link.connected).toBe(true)
    } finally {
      await link.close()
    }
  })
})
