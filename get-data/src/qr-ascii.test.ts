/**
 * `qr-ascii.ts` 的单元测试 —— PNG 解码 + 终端字符画。
 *
 * ⚠️ 测试里的 PNG 是**现造**的（用 zlib 压扫描线），CRC 填 0 ——
 *    因为解码器**不校验 CRC**（那是完整性检查，不是正确性检查）。
 *
 * ⚠️ 全程不发网络请求 ✓
 */

import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { decodePngToGray, grayToAscii, pngToTerminalQr } from './qr-ascii'

/** 造一张灰度 PNG（位深 8、非隔行、颜色类型 0） */
function makeGrayPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
  filterType = 0,
): Uint8Array {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = filterType
    for (let x = 0; x < width; x += 1) {
      const v = pixel(x, y) & 0xff
      if (filterType === 1) {
        // Sub：存的是与左邻的差值
        const left = x > 0 ? pixel(x - 1, y) & 0xff : 0
        raw[y * (width + 1) + 1 + x] = (v - left) & 0xff
      } else {
        raw[y * (width + 1) + 1 + x] = v
      }
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 0 // 灰度
  ihdr[12] = 0 // 非隔行

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

describe('decodePngToGray', () => {
  it('解出一张灰度 PNG 的尺寸与像素', () => {
    const png = makeGrayPng(4, 3, (x, y) => (x + y) * 20)
    const d = decodePngToGray(png)
    expect(d).not.toBeNull()
    expect(d!.width).toBe(4)
    expect(d!.height).toBe(3)
    expect(Array.from(d!.gray.slice(0, 4))).toEqual([0, 20, 40, 60])
  })

  it('⭐ 反滤波正确（滤波类型 1 = Sub，存的是与左邻的差值）', () => {
    // 每个字节都是 +10 的差值 → 还原后应当是 10,20,30,40
    const png = makeGrayPng(4, 1, (x) => (x + 1) * 10, 1)
    const d = decodePngToGray(png)
    expect(Array.from(d!.gray)).toEqual([10, 20, 30, 40])
  })

  it('⭐ 不是 PNG → null（不抛异常 —— 画不出来就降级写文件）', () => {
    expect(decodePngToGray(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(decodePngToGray(new Uint8Array(0))).toBeNull()
  })

  it('截断的文件 → null', () => {
    const png = makeGrayPng(4, 4, () => 0)
    expect(decodePngToGray(png.subarray(0, 20))).toBeNull()
  })

  it('不支持的位深（16）→ null，而不是画成一团乱码', () => {
    const png = makeGrayPng(4, 4, () => 0)
    // 把 IHDR 的位深字节改成 16（IHDR 数据从第 16 字节开始，位深在 +8）
    const broken = Uint8Array.from(png)
    broken[8 + 4 + 4 + 8] = 16
    expect(decodePngToGray(broken)).toBeNull()
  })
})

describe('grayToAscii', () => {
  it('全黑 → 整片 █，且行数是"半块"（高 16 → 8 行）', () => {
    const png = { width: 16, height: 16, gray: new Uint8Array(256).fill(0) }
    const lines = grayToAscii(png, 16).split('\n')
    expect(lines).toHaveLength(8)
    expect(lines[0]).toBe('█'.repeat(16))
  })

  it('全白 → 全是空格', () => {
    const png = { width: 16, height: 16, gray: new Uint8Array(256).fill(255) }
    expect(grayToAscii(png, 16)).toBe(Array(8).fill(' '.repeat(16)).join('\n'))
  })

  it('⭐ 上下两半不同 → 半块字符（这是长宽比不失真的关键）', () => {
    // 4 宽 2 高 → 1 个字符行，正好跨上下两个像素
    const W = 4
    const H = 2
    const gray = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255])
    expect(grayToAscii({ width: W, height: H, gray }, 8)).toBe('▀▀▀▀')
  })

  it('⭐ 用"块内多数"而不是平均：块里过半为黑就判黑', () => {
    // 32×32 图缩到 8 列 → 4 行，每个字符格覆盖 4×4 = 16 像素
    // 左上角那个字符格的**上下两半**都设成 9 黑 7 白
    // （一个字符是 4 列 × 4 行像素；但它竖着画两个采样行，
    //   所以要让整个字符格都过半为黑，才能得到 █）
    const W = 32
    const gray = new Uint8Array(W * W).fill(255)
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if (y * 4 + x < 9) gray[y * W + x] = 0
      }
    }
    // 下半（y = 4..7）也补成 9 黑
    for (let y = 4; y < 8; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if ((y - 4) * 4 + x < 9) gray[y * W + x] = 0
      }
    }
    const art = grayToAscii({ width: W, height: W, gray }, 8)
    // 两半都是 9/16 黑 → 过半 → █（而不是被平均稀释成灰、判白）
    expect(art[0]).toBe('█')
  })

  it('太宽的图会被缩放（否则终端换行错乱、扫不出来）', () => {
    const png = { width: 400, height: 400, gray: new Uint8Array(400 * 400) }
    const lines = grayToAscii(png, 40).split('\n')
    expect(lines[0]).toHaveLength(40)
    expect(lines).toHaveLength(20)
  })
})

describe('pngToTerminalQr —— 一步到位', () => {
  it('正常的 PNG 能出字符画', () => {
    const png = makeGrayPng(8, 8, (x, y) => ((x + y) % 2 === 0 ? 0 : 255))
    const art = pngToTerminalQr(png, 8)
    expect(art).not.toBeNull()
    expect(art!.length).toBeGreaterThan(0)
  })

  it('⭐ 解不出来返回 null（调用方降级成"存成文件让你打开"）', () => {
    expect(pngToTerminalQr(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
