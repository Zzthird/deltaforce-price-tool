/**
 * 把 PNG 图片画成**终端里的半块字符** —— 用来显示 QQ 登录二维码。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么不引现成的库
 * ═══════════════════════════════════════════════════════════════════════
 * 用户要在终端里扫二维码（而不是打开一个 PNG 文件）。常规做法是：
 *
 *   `jsqr`（从像素里解码二维码）+ `pngjs`/`sharp`（把 PNG 解成像素）
 *
 * —— **两个依赖** ✗，而且 `sharp` 还是原生模块（装起来要编译 ✗）。
 *
 * 但我们**不需要"解码"这个二维码** ✗ —— 只是要把它的**像素**画出来 ✓。
 * 而 PNG 的像素解码只需要：读 chunk → 用 zlib inflate → 反滤波。
 * **Node 自带 `zlib`** ✓，所以这整件事**零依赖** ✓✓。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 支持范围（够用就行，不支持就老实说）
 * ═══════════════════════════════════════════════════════════════════════
 * 支持：位深 8、非隔行扫描、灰度 / RGB / 调色板 / 带 alpha 的两种。
 * 不支持（返回 null，调用方**降级成写文件** ✓）：位深 1/2/4/16、隔行 PNG。
 *
 * ⚠️ 为什么返回 `null` 而不是抛异常：这是个"锦上添花"的功能 ✓ ——
 *    画不出来就退回"存成 PNG 让你打开" ✓，不该让登录流程整个失败 ✗。
 */

import { inflateSync } from 'node:zlib'

/** PNG 各颜色类型对应的通道数 */
const CHANNELS: Readonly<Record<number, number>> = {
  0: 1, // 灰度
  2: 3, // RGB
  3: 1, // 调色板（每个像素是一个索引）
  4: 2, // 灰度 + alpha
  6: 4, // RGBA
}

export interface DecodedPng {
  width: number
  height: number
  /** 每像素的灰度（0~255，0 最黑）*/
  gray: Uint8Array
}

/**
 * 解 PNG → 灰度图。不支持或数据损坏时返回 `null`。
 */
export function decodePngToGray(bytes: Uint8Array): DecodedPng | null {
  // ── ① 验签名（8 字节魔数）
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8) return null
  for (let i = 0; i < 8; i += 1) if (bytes[i] !== SIG[i]) return null

  // ── ② 逐个 chunk 读：我们要 IHDR / PLTE / IDAT
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette: Uint8Array | null = null
  const idat: Uint8Array[] = []

  while (offset + 8 <= bytes.length) {
    const len =
      ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>>
      0
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    )
    const dataStart = offset + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > bytes.length) return null // 数据不完整

    if (type === 'IHDR') {
      width = readU32(bytes, dataStart)
      height = readU32(bytes, dataStart + 4)
      bitDepth = bytes[dataStart + 8]!
      colorType = bytes[dataStart + 9]!
      interlace = bytes[dataStart + 12]!
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataStart, dataEnd)
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4 // 跳过 CRC
  }

  if (width <= 0 || height <= 0) return null
  /**
   * ⚠️ 位深只支持 1 / 2 / 4 / 8，不支持 16。
   *
   * 这个限制是**实测撞出来的**：真实登录二维码是 **1 位**灰度 PNG
   * （111×111，只有 444 字节 —— 黑白图用 1 位压得最小）✗，
   * 第一版只支持位深 8，于是渲染器直接返回 null ✗。
   * 而假的测试图片都是我按位深 8 造的 → **单测全绿但真实场景不能用** ✗。
   */
  if (![1, 2, 4, 8].includes(bitDepth)) return null
  if (interlace !== 0) return null
  const channels = CHANNELS[colorType]
  if (channels === undefined) return null
  if (colorType === 3 && palette === null) return null

  // ── ③ inflate 出原始扫描线
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))))
  } catch {
    return null
  }

  /**
   * 每行字节数。
   * ⚠️ 位深 < 8 时，**位图行会补齐到字节边界**（PNG 规范）——
   *    所以不能直接用 width*channels，否则一整张图会歪掉。
   */
  const stride = Math.ceil((width * channels * bitDepth) / 8)
  /** 反滤波的步长（字节）：即一个像素占几个字节，至少 1 */
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  if (raw.length < (stride + 1) * height) return null

  // ── ④ 逐行反滤波（PNG 的 5 种滤波器）
  const pixels = new Uint8Array(stride * height)
  let prevRow = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)

    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x]!
      const a = x >= bpp ? out[x - bpp]! : 0 // 左
      const b = prevRow[x]! // 上
      const c = x >= bpp ? prevRow[x - bpp]! : 0 // 左上
      let v: number
      switch (filter) {
        case 0:
          v = rawByte
          break
        case 1:
          v = rawByte + a
          break
        case 2:
          v = rawByte + b
          break
        case 3:
          v = rawByte + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          return null // 未知滤波类型 —— 不猜
      }
      out[x] = v & 0xff
    }
    prevRow = out
  }

  // ── ⑤ 转灰度（位深 < 8 时要从位流里抠出每个样本，并缩放到 0~255）
  const gray = new Uint8Array(width * height)
  /** 位深 n 下一个样本的最大值：1→1、2→3、4→15、8→255 */
  const maxSample = (1 << bitDepth) - 1
  const scale = 255 / maxSample

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    for (let x = 0; x < width; x += 1) {
      const sample = readSample(pixels, rowStart, x, channels, bitDepth)

      if (colorType === 0 || colorType === 4) {
        // 灰度：样本值就是亮度
        gray[y * width + x] = Math.round(sample * scale)
      } else if (colorType === 2 || colorType === 6) {
        // RGB：位深 8 时才可能走到这里（位深 < 8 的 truecolor 极罕见）
        const p = rowStart + x * channels
        gray[y * width + x] = Math.round(
          0.299 * pixels[p]! + 0.587 * pixels[p + 1]! + 0.114 * pixels[p + 2]!,
        )
      } else {
        // 调色板：样本是调色板下标
        const idx = sample * 3
        gray[y * width + x] =
          palette && palette.length >= idx + 3
            ? Math.round(0.299 * palette[idx]! + 0.587 * palette[idx + 1]! + 0.114 * palette[idx + 2]!)
            : 255
      }
    }
  }

  return { width, height, gray }
}

/**
 * 从位流里抠出第 `index` 个样本。
 *
 * ⚠️ PNG 是**高位优先**打包的（MSB first）✗ —— 反了的话整张图会变成噪声，
 *    而二维码一变噪声就扫不出来 ✗。
 */
function readSample(
  bytes: Uint8Array,
  rowStart: number,
  index: number,
  channels: number,
  bitDepth: number,
): number {
  if (bitDepth === 8) return bytes[rowStart + index * channels] ?? 255

  // 每个字节里塞了 8/bitDepth 个样本
  const perByte = 8 / bitDepth
  const sampleIndex = index * channels
  const byteAt = rowStart + Math.floor(sampleIndex / perByte)
  const slot = sampleIndex % perByte
  const byte = bytes[byteAt] ?? 0
  // 高位优先：最左边的样本占高 bits
  const shift = 8 - bitDepth * (slot + 1)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
}

/**
 * 灰度图 → 终端里的半块字符画。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 两个关键设计
 * ═══════════════════════════════════════════════════════════════════════
 * ① **用 `▀`/`▄`/`█` 半块字符**：一个字符高≈2 宽，所以一个字符画
 *    竖着的**两个**像素 → 长宽比正好 ✓（直接一像素一字符会被拉长成 2:1）
 *
 * ② **先缩放**：QR 图通常 130~200 px，而终端一般只有 80~120 列 ✗。
 *    一像素一字符会换行错乱、扫不出来 ✗。
 *    所以先按"块内多数"缩到目标宽度 —— 用**多数**而不是平均：
 *    二维码是黑白的，平均会让边缘变灰、阈值一卡就断线 ✗。
 *
 * ⚠️ 目标宽度默认 70 —— 留出边距，且 33~45 模块的二维码缩放后每个模块
 *    仍有 1~2 字符宽，手机能扫 ✓。
 */
export function grayToAscii(png: DecodedPng, targetWidth = 70): string {
  /**
   * ⚠️ 不要加“最小列数”之类的限制 —— 我第一版写了 `Math.max(8, …)`，
   *    结果小图会被**放大**成 8 列（每个像素变成好几个字符）✗，
   *    不自然也不好测。图多宽就画多宽，太小的图本来也扫不出来 ✗。
   */
  const cols = Math.min(targetWidth, png.width)
  /**
   * ⚠️ 行数要**除以 2** —— 一个字符竖着画**两个**像素（`▀`/`▄`）✓
   *
   * 这个 /2 是写单测时拓出来的：忘了它会得到两倍行数，
   * 二维码被**压扁**（长宽比 2:1）—— 手机上可能就扫不出来了 ✗。
   */
  const rows = Math.max(1, Math.round(((png.height / png.width) * cols) / 2))

  // 每个字符竖着画 2 个像素 → 需要 2×rows 个"采样点"
  const sampleRows = rows * 2

  const dark = (cx: number, cy: number): boolean => {
    // 对应的原图区块
    const x0 = Math.floor((cx * png.width) / cols)
    const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * png.width) / cols))
    const y0 = Math.floor((cy * png.height) / sampleRows)
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * png.height) / sampleRows))

    /**
     * ⭐ 用**多数**（过半为黑）而不是平均值。
     *
     * 二维码是纯黑白的，而缩放时每个字符格会覆盖原图的一小块。
     * 取平均会让块边界处的“半黑半白”变成灰色，再卡阈值就容易断线 ✗ ——
     * 而二维码断线就扫不出来了 ✗。取多数则是“跟大多数像素同色”，
     * 结构完整 ✓
     *
     * （写注释时就写的是“多数”，但第一版代码写成了平均 ✗ ——
     *   是对着单测重新看的才发现的。）
     */
    let darkCount = 0
    let total = 0
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if ((png.gray[y * png.width + x] ?? 255) < 128) darkCount += 1
        total += 1
      }
    }
    return total > 0 && darkCount * 2 > total
  }

  const out: string[] = []
  for (let r = 0; r < rows; r += 1) {
    let line = ''
    for (let c = 0; c < cols; c += 1) {
      const top = dark(c, r * 2)
      const bottom = dark(c, r * 2 + 1)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    out.push(line)
  }
  return out.join('\n')
}

/** 一步到位：PNG 字节 → 终端字符画。解不出来返回 null（调用方降级） */
export function pngToTerminalQr(bytes: Uint8Array, targetWidth?: number): string | null {
  const decoded = decodePngToGray(bytes)
  if (decoded === null) return null

  /**
   * ⭐ 宽度按**终端实际列数**自适应 —— 尽量画大一点。
   *
   * 为什么要自适应：二维码能不能扫出来，关键就看**每个模块占了几个字符**。
   * 固定 66 列时，真实登录二维码（111px、约 37 个模块）
   * 每个模块只占 ~1.8 个字符，偏紧 ✗；宽一点的终端能画到 2~3 个字符，
   * 手机好扫得多 ✓。
   *
   * 留 2 列边距：行末换行容易让二维码被折成两半 ✗。
   */
  const termCols = typeof process.stdout.columns === 'number' ? process.stdout.columns : 0
  const width = targetWidth ?? (termCols > 20 ? termCols - 2 : 80)
  return grayToAscii(decoded, width)
}
