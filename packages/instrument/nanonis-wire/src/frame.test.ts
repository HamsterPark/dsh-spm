import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ERROR_HEADER_LEN,
  HEADER_LEN,
  NAME_LEN,
  WireFrameError,
  echoMatches,
  encodeRequestFrame,
  isNeedModule,
  parseErrorSection,
  parseReplyHeader,
} from './frame.js'

/** 字节金样由 STM-Bench 的真实 codec 产出（`tools/spec-export/export_wire_fixtures.py`）。 */
const golden = JSON.parse(
  readFileSync(new URL('../../../../spec/golden/wire_frames.json', import.meta.url), 'utf8'),
) as {
  constants: Record<string, number>
  build_request_frame: Record<string, { name: string; body: string; send_response_back: boolean; frame: string }>
  reply_frames: Record<string, { raw_name: string; body: string; frame: string; body_len: number }>
  parse_request_header: Record<string, { header: string; name: string; body_size: number; send_response_back: boolean }>
}

const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex')

describe('常量与 STM-Bench 一致', () => {
  it('40 / 32 / 8', () => {
    expect({ HEADER_LEN, NAME_LEN, ERROR_HEADER_LEN }).toEqual(golden.constants)
  })
})

describe('请求成帧逐字节对齐', () => {
  // 判据是「**金样本身是良构帧**」，不是「名字放得下」。Python 的 ljust 按字符补齐，
  // 所以 `Ünicode.Verb` 虽然只有 13 字节、放得进 32，它产出的帧仍是 41 字节（错位 1）。
  // 拿错位的帧当期望值，等于把上游的 bug 抄成我们的规格。
  const fits = Object.values(golden.build_request_frame).filter(
    (c) => b(c.frame).length === HEADER_LEN + b(c.body).length,
  )
  it.each(fits.map((c) => [c.name, c] as const))('encodeRequestFrame(%s)', (_name, c) => {
    expect(hex(encodeRequestFrame(c.name, b(c.body), c.send_response_back))).toBe(hex(b(c.frame)))
  })
})

describe('名字段放不下就抛，不产出错位的帧（D-WIRE-1/2）', () => {
  it('超过 32 字节的名字', () => {
    // Python 的 ljust(32) 对 40 字符的名字不截断，帧变成 48 字节，多出的 8 个字符
    // 直接盖住 size 与 flag 字段——金样里就是这样。
    const bad = golden.build_request_frame[Object.keys(golden.build_request_frame).find((k) => k.startsWith('A'.repeat(40)))!]!
    expect(b(bad.frame).length).toBe(HEADER_LEN + 8) // 证明金样里确实是错位的
    expect(() => encodeRequestFrame('A'.repeat(40), new Uint8Array())).toThrow(WireFrameError)
  })

  it('非 ASCII 名字（Python 按字符补齐再编码，名字段会变成 33 字节）', () => {
    const bad = golden.build_request_frame[Object.keys(golden.build_request_frame).find((k) => k.startsWith('Ü'))!]!
    expect(b(bad.frame).length).toBe(HEADER_LEN + 1) // 33 字节名字段 ⇒ 整帧错位 1
    // 我们编码后是 13 字节，放得下 32，所以**不抛**——而是产出对齐的帧。
    const ours = encodeRequestFrame('Ünicode.Verb', new Uint8Array())
    expect(ours.length).toBe(HEADER_LEN)
    expect(parseReplyHeader(ours).name).toBe('Ünicode.Verb')
  })
})

describe('回复帧与错误段', () => {
  it.each(Object.entries(golden.reply_frames))('parseReplyHeader(%s)', (_label, c) => {
    const frame = b(c.frame)
    const h = parseReplyHeader(frame.slice(0, HEADER_LEN))
    expect(h.bodySize).toBe(c.body_len)
    expect(hex(h.rawName)).toBe(hex(b(c.raw_name)))
    expect(hex(frame.slice(HEADER_LEN))).toBe(hex(b(c.body)))
  })

  it('成功回复的 body 是空返回 + 零错误段', () => {
    const body = b(golden.reply_frames.ok_empty!.body)
    expect(body.length).toBe(ERROR_HEADER_LEN)
    expect(parseErrorSection(body)).toEqual({ status: 0, description: '', errorOnly: true })
  })

  it('拒绝型回复满足长度恒等式，且 NeedModule 被识别为「模块没加载」', () => {
    const body = b(golden.reply_frames.err_need_module!.body)
    const err = parseErrorSection(body)
    expect(err.errorOnly).toBe(true)
    expect(err.status).toBe(1)
    expect(body.length).toBe(ERROR_HEADER_LEN + new TextEncoder().encode(err.description).length)
    expect(isNeedModule(err.description)).toBe(true)
  })

  it('别的拒绝不是 NeedModule——处置完全相反，重连一百次也治不好没加载的模块', () => {
    for (const label of ['err_unknown', 'err_bad_args', 'err_no_desc']) {
      const err = parseErrorSection(b(golden.reply_frames[label]!.body))
      expect(isNeedModule(err.description), label).toBe(false)
    }
  })

  it('状态非零但描述为空时，仪器侧会补一句默认描述', () => {
    const raw = b(golden.reply_frames.err_no_desc!.body)
    const got = parseErrorSection(raw)
    expect(got.status).toBe(7)
    expect(got.errorOnly).toBe(true)

    // 判据是「**补了一句、而且我们逐字读得对**」，不是那句话的内容。
    //
    // 2026-09-19：STM-Bench 把这句默认描述从「Nanonis error status 7」改成了
    // 「controller error status 7」，而这里原本**写死**着前一句 —— 于是一次
    // 上游改词让一条讲「有没有补描述」的测试变红。
    //
    // 那句话是**模拟器**的，不是本仓的契约。要盯住它改没改，靠的是
    // `spec/golden/wire_frames.json` 本身在 git 里（重导出会出 diff），
    // **不是在这里抄一份**。这里只留与措辞无关的两条：非空，且长度恒等式成立。
    expect(got.description).not.toBe('')
    expect(new TextEncoder().encode(got.description).length).toBe(raw.length - ERROR_HEADER_LEN)
  })

  it('带返回字段的 body 不满足恒等式 ⇒ 明确报错，不猜', () => {
    // ok_float 的 body = float32 + 错误段，长度 12 ≠ 8 + descLen
    expect(() => parseErrorSection(b(golden.reply_frames.ok_float!.body))).toThrow(/长度恒等式/)
  })
})

describe('回声校验', () => {
  it('逐字节相同才算匹配', () => {
    const sent = encodeRequestFrame('Bias.Get', new Uint8Array()).slice(0, NAME_LEN)
    expect(echoMatches(sent, b(golden.reply_frames.ok_empty!.raw_name))).toBe(true)
    expect(echoMatches(sent, b(golden.reply_frames.err_need_module!.raw_name))).toBe(false)
  })
})

describe('请求头解析（与服务端读到的一致）', () => {
  it.each(Object.entries(golden.parse_request_header))('%s', (_label, c) => {
    const h = parseReplyHeader(b(c.header)) // 头布局前 36 字节相同
    expect(h.name).toBe(c.name)
    expect(h.bodySize).toBe(c.body_size)
  })
})
