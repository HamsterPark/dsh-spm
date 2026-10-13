/**
 * Lossless array files: `.npy` v1.0, little-endian float32 (`'<f4'`).
 *
 * The archive keeps every channel and direction exactly as the instrument wrote
 * it. `.sxm` frames are big-endian float32, so float32 is lossless for them;
 * `.npy` keeps the files readable by numpy and by the repo's own reader
 * (`decodeNpy` in `dsh-spm-numerics`). The kernel's writer only emits `'<f8'`,
 * which would double the archive's size for no information, so this module
 * writes `'<f4'` with the same header layout (`npyShapeLiteral`, data aligned
 * to 64 bytes) and reads back through `decodeNpy`.
 */
import { NPY_ALIGN, npyShapeLiteral } from 'dsh-spm-kernel'
import { decodeNpy } from 'dsh-spm-numerics'

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const

/** Shape and values disagree, or a file is not a 2-D float array. */
export class NpyShapeError extends RangeError {
  override readonly name = 'NpyShapeError'
}

/** Row-major float32 values → `.npy` bytes. */
export function encodeNpyFloat32(values: ArrayLike<number>, shape: readonly number[]): Uint8Array {
  const want = shape.reduce((a, b) => a * b, 1)
  if (values.length !== want) {
    throw new NpyShapeError(`.npy shape ${npyShapeLiteral(shape)} needs ${want} values, got ${values.length}`)
  }
  const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': ${npyShapeLiteral(shape)}, }`
  const unpadded = 10 + dict.length + 1
  const headerLen = dict.length + 1 + ((NPY_ALIGN - (unpadded % NPY_ALIGN)) % NPY_ALIGN)
  const header = dict.padEnd(headerLen - 1, ' ') + '\n'
  const out = new Uint8Array(10 + headerLen + want * 4)
  out.set(MAGIC, 0)
  out[6] = 1
  out[7] = 0
  const view = new DataView(out.buffer)
  view.setUint16(8, headerLen, true)
  for (let i = 0; i < header.length; i += 1) out[10 + i] = header.charCodeAt(i)
  let off = 10 + headerLen
  for (let i = 0; i < want; i += 1) {
    view.setFloat32(off, values[i] as number, true)
    off += 4
  }
  return out
}

export interface Float32Grid {
  readonly rows: number
  readonly cols: number
  readonly data: Float32Array
}

/** `.npy` bytes of a 2-D (or 1-D, as one row) array → float32 values. */
export function decodeNpyFloat32(bytes: Uint8Array): Float32Grid {
  const arr = decodeNpy(bytes)
  if (arr.shape.length === 1) {
    return { rows: 1, cols: arr.shape[0] as number, data: Float32Array.from(arr.values) }
  }
  if (arr.shape.length !== 2) throw new NpyShapeError(`expected a 2-D array, got shape ${JSON.stringify(arr.shape)}`)
  return { rows: arr.shape[0] as number, cols: arr.shape[1] as number, data: Float32Array.from(arr.values) }
}
