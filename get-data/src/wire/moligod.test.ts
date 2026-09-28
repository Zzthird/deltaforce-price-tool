/**
 * wire/moligod.ts 的单元测试 —— AES-GCM 解密。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 说清这个测试能证明什么、不能证明什么（诚实）
 * ═══════════════════════════════════════════════════════════════════════
 * 这个测试**按同一个协议文档加密再解密**，所以它锁住的是：
 *   · 实现里各字段的位置（版本字节 / IV / 密文 / 认证标签）
 *   · 密钥派生方式（SHA-256）
 *   · AAD 字符串
 *   · 错误处理（版本不符 / 密钥不符 / AAD 不符 / 缺头 / 截断 / 非 gzip / 非 JSON）
 *
 * 它**不能**证明"我读懂了站长的协议" —— 因为加密和解密都是我写的，
 * 如果我误读了规范，两边会一起错。
 *
 * 那个验证已经用**真实服务器**做过了：Phase 3 对 moligod 实抓成功，
 * 解出 1718 条物品数据（见 docs/source-recon.md）。那是最强的证据。
 *
 * 所以这个测试的定位是**防回归**：站长改协议时它不会失败（真实抓取会），
 * 但我改坏解密实现时它会立刻失败。
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  MOLIGOD_AAD,
  MOLIGOD_IV_LENGTH,
  MOLIGOD_KEY_HEADER,
  MOLIGOD_TAG_LENGTH,
  MOLIGOD_WIRE_VERSION,
  MoligodWireError,
  decryptMoligodSnapshot,
} from './moligod'

/* ══════════════════════════ 构造 wire 数据 ══════════════════════════ */

interface BuildOptions {
  /** 覆盖版本字节（测版本不符） */
  version?: number
  /** 用这个字符串当密钥（测密钥不符） */
  keyText?: string
  /** 覆盖 AAD（测 AAD 不符） */
  aad?: string
  /** 明文是否先 gzip（false = 测"不是 gzip"） */
  gzip?: boolean
  /** 明文内容覆盖 */
  rawText?: string
}

/**
 * 按协议"手工"造一段 wire 数据： [版本][IV][密文][认证标签]
 * 注意这里用的是 Node 原生 crypto，不是被测代码里的逻辑。
 */
function buildWire(payload: unknown, keyText: string, options: BuildOptions = {}): Buffer {
  const plain = options.rawText ?? JSON.stringify(payload)
  const body = options.gzip === false ? Buffer.from(plain, 'utf8') : gzipSync(Buffer.from(plain, 'utf8'))

  const iv = randomBytes(MOLIGOD_IV_LENGTH)
  const key = createHash('sha256').update(options.keyText ?? keyText, 'utf8').digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(options.aad ?? MOLIGOD_AAD, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([Buffer.from([options.version ?? MOLIGOD_WIRE_VERSION]), iv, ciphertext, tag])
}

const KEY = 'test-key-abc123'
const PAYLOAD = {
  status: 'ok',
  total: 2,
  items: [
    { name: '海洋之泪', current_price: 33731398, width: 1, length: 1 },
    { name: '非洲之心', current_price: 13141314, width: 1, length: 1 },
  ],
}

/* ══════════════════════════ 正向 ══════════════════════════ */

describe('decryptMoligodSnapshot —— 正常解密', () => {
  it('⭐ 按协议造的密文能正确解回原对象', () => {
    const wire = buildWire(PAYLOAD, KEY)
    expect(decryptMoligodSnapshot(wire, KEY)).toEqual(PAYLOAD)
  })

  it('常量与实测协议一致（改错了这里会先炸）', () => {
    expect(MOLIGOD_WIRE_VERSION).toBe(1)
    expect(MOLIGOD_IV_LENGTH).toBe(12)
    expect(MOLIGOD_TAG_LENGTH).toBe(16)
    expect(MOLIGOD_AAD).toBe('trade-house-snapshot-v1')
    expect(MOLIGOD_KEY_HEADER).toBe('x-trade-house-key')
  })

  it('接受 Uint8Array（不只是 Buffer）', () => {
    const wire = buildWire(PAYLOAD, KEY)
    const asU8 = new Uint8Array(wire)
    expect(decryptMoligodSnapshot(asU8, KEY)).toEqual(PAYLOAD)
  })

  it('中文内容能正确往返（UTF-8 解码没写错）', () => {
    const wire = buildWire({ 名称: '海洋之泪·测试', 备注: '中文😀' }, KEY)
    expect(decryptMoligodSnapshot(wire, KEY)).toEqual({ 名称: '海洋之泪·测试', 备注: '中文😀' })
  })
})

/* ══════════════════════════ 错误处理 ══════════════════════════ */

describe('decryptMoligodSnapshot —— 错误处理', () => {
  it('⭐ 版本字节不是 1 → 抛错（站长改了协议）', () => {
    const wire = buildWire(PAYLOAD, KEY, { version: 2 })
    expect(() => decryptMoligodSnapshot(wire, KEY)).toThrow(MoligodWireError)
    expect(() => decryptMoligodSnapshot(wire, KEY)).toThrow(/版本号不是 1/)
  })

  it('⭐ 密钥不符 → GCM 认证失败，抛错而不是返回乱码', () => {
    const wire = buildWire(PAYLOAD, KEY, { keyText: '另一个密钥' })
    expect(() => decryptMoligodSnapshot(wire, KEY)).toThrow(MoligodWireError)
    expect(() => decryptMoligodSnapshot(wire, KEY)).toThrow(/认证失败/)
  })

  it('⭐ AAD 不符 → 同样认证失败（AAD 是 GCM 的完整性保护的一部分）', () => {
    const wire = buildWire(PAYLOAD, KEY, { aad: '错误的-aad' })
    expect(() => decryptMoligodSnapshot(wire, KEY)).toThrow(/认证失败/)
  })

  it('密钥头缺失或为空 → 明确报错', () => {
    const wire = buildWire(PAYLOAD, KEY)
    expect(() => decryptMoligodSnapshot(wire, '')).toThrow(/缺失或为空/)
  })

  it('⭐ 响应体太短（可能拿到的是错误页面）→ 明确报错', () => {
    expect(() => decryptMoligodSnapshot(new Uint8Array([]), KEY)).toThrow(/响应体太短/)
    expect(() => decryptMoligodSnapshot(new Uint8Array(10), KEY)).toThrow(/响应体太短/)
    expect(() => decryptMoligodSnapshot(new Uint8Array(29), KEY)).toThrow(/响应体太短/)
  })

  it('⭐ 明文不是 gzip → 明确报错（不是"解密失败"）', () => {
    const wire = buildWire(PAYLOAD, KEY, { gzip: false })
    expect(() => decryptMoligodSnapshot(wire, KEY)).toThrow(/gunzip 失败/)
  })

  it('⭐ 是合法 gzip 但不是 JSON → 明确报错', () => {
    const wire = buildWire(PAYLOAD, KEY, { rawText: '这不是 JSON' })
    expect(() => decryptMoligodSnapshot(wire, KEY)).toThrow(/JSON 解析失败/)
  })

  it('所有错误都是 MoligodWireError（上层可以据此区分"协议问题"和"网络问题"）', () => {
    const cases: Array<() => unknown> = [
      () => decryptMoligodSnapshot(new Uint8Array(100), KEY),
      () => decryptMoligodSnapshot(buildWire(PAYLOAD, KEY, { version: 9 }), KEY),
      () => decryptMoligodSnapshot(buildWire(PAYLOAD, KEY, { keyText: 'x' }), KEY),
      () => decryptMoligodSnapshot(buildWire(PAYLOAD, KEY, { gzip: false }), KEY),
    ]
    for (const fn of cases) {
      expect(fn).toThrow(MoligodWireError)
    }
  })
})
