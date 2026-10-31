/**
 * `pxToM` 的旋转方向：正 `angleDeg` = 扫描框相对压电坐标**顺时针**转（D-ROT-1）。
 *
 * 这里不重新判断「哪个方向对」——那是参考实现用真机转角系列定下的约定——而是把
 * **`pxToM` 必须是「压电 → 帧内」的逆**钉住：谁把符号翻回去，这里当场变红。
 *
 * ⚠️ `toFrame` / `frameToPx` 在本文件里**独立写**，不调任何生产代码。往返的两半
 * 要是同源，一起翻号照样闭合。
 *
 * ⚠️ 帧心是 R(±θ) 的不动点：只验帧心的测试分不出符号（第 4 条写在这里提醒后来人）。
 */
import { describe, expect, it } from 'vitest'
import { EPS } from 'dsh-spm-numerics'
import { pxToM } from './xy-meta.js'

const NX = 256
const NY = 256
const W = 38.4e-9 // 方形像素；符号与单位无关
const H = 38.4e-9
const CX = 10e-9
const CY = -20e-9

/**
 * 往返的误差界。一趟约 12 次运算（两次旋转、一次像素化、一次反像素化），
 * 中间量都不超过 2W，每次至多 ½ ulp，加上 `cos/sin` 各 1 ulp ⇒ 约 `8·EPS·W`；
 * 再留 ×8 —— 这条测的是**符号**，翻号的误差是几十纳米，与这个界差十几个量级。
 */
const ROUND_TRIP_ABS = 64 * EPS * W

/** 压电 → 帧内（x′ 右、y′ 上）：`R(+θ)·(p − c)`。 */
function toFrame(angDeg: number, x: number, y: number): [number, number] {
  const t = (angDeg * Math.PI) / 180
  const dx = x - CX
  const dy = y - CY
  return [dx * Math.cos(t) - dy * Math.sin(t), dx * Math.sin(t) + dy * Math.cos(t)]
}

/** 帧内 → 像素：`pxToM` 里 dx/dy 定义的精确逆（行 0 = 最大 y）。 */
function frameToPx(xp: number, yp: number): [number, number] {
  return [((xp + W / 2) / W) * NX - 0.5, ((H / 2 - yp) / H) * NY - 0.5]
}

const geom = (angleDeg: number) => ({ nx: NX, ny: NY, cxM: CX, cyM: CY, wM: W, hM: H, angleDeg })

describe('pxToM 的旋转方向（D-ROT-1）', () => {
  const ANGLES = [0, 15, 30, 90, -45, 137]
  const POINTS: readonly [number, number][] = [
    [10e-9, -20e-9],
    [13e-9, -16e-9],
    [25e-9, 5e-9],
    [-3e-9, -40e-9],
  ]
  for (const ang of ANGLES) {
    for (const [xs, ys] of POINTS) {
      it(`压电 → 帧内 → 像素 → pxToM 回到原点（θ=${ang}°，(${xs * 1e9}, ${ys * 1e9}) nm）`, () => {
        const [xp, yp] = toFrame(ang, xs, ys)
        const [col, row] = frameToPx(xp, yp)
        const [gx, gy] = pxToM(col, row, geom(ang))
        expect(Math.abs(gx - xs) <= ROUND_TRIP_ABS || `x: ${gx} vs ${xs}`).toBe(true)
        expect(Math.abs(gy - ys) <= ROUND_TRIP_ABS || `y: ${gy} vs ${ys}`).toBe(true)
      })
    }
  }

  it('θ=90°：帧内 +x′（右）落到压电 −y（下），不是 +y', () => {
    // 帧心右侧 W/4、帧心那一行的像素。旧式 R(+θ) 会给 (0, +W/4)。
    const col = ((W / 4 + W / 2) / W) * NX - 0.5
    const row = (H / 2 / H) * NY - 0.5
    const [gx, gy] = pxToM(col, row, { ...geom(90), cxM: 0, cyM: 0 })
    expect(Math.abs(gx) <= ROUND_TRIP_ABS || `x: ${gx}`).toBe(true)
    expect(Math.abs(gy + W / 4) <= ROUND_TRIP_ABS || `y: ${gy}（应为 −W/4）`).toBe(true)
  })

  it('θ=0：恒等，不受符号订正影响（sin 项为零）', () => {
    const [gx, gy] = pxToM(NX - 0.5, 0, { ...geom(0), cxM: 0, cyM: 0 })
    expect(Math.abs(gx - W / 2) <= ROUND_TRIP_ABS).toBe(true)
    expect(Math.abs(gy - (H / 2 - (0.5 / NY) * H)) <= ROUND_TRIP_ABS).toBe(true)
  })

  it('帧心在任何 θ 下都映回中心 —— 所以**只验帧心的测试分不出符号**', () => {
    for (const ang of ANGLES) {
      const [gx, gy] = pxToM((NX - 1) / 2, (NY - 1) / 2, geom(ang))
      expect(Math.abs(gx - CX) <= ROUND_TRIP_ABS && Math.abs(gy - CY) <= ROUND_TRIP_ABS).toBe(true)
    }
  })
})
