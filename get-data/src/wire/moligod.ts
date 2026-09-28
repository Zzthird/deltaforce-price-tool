/**
 * moligod「交易行快照」的 wire 格式解密。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 协议（Phase 0 从公开前端 JS `wire-Ety7vtW.js` 读出并实测验证）
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   GET https://moligod.com/api/market/trade-house-snapshot
 *   → Content-Type: application/octet-stream
 *   → 响应头 x-trade-house-key: <密钥字符串>
 *
 *   响应体布局：
 *     byte[0]      = 版本号，必须等于 1
 *     byte[1..13]  = 12 字节 AES-GCM IV（每次加密随机）
 *     byte[13..]   = AES-GCM 密文 + 末尾 16 字节认证标签
 *
 *   密钥 = SHA-256( 响应头 x-trade-house-key 的值 )
 *   AAD  = 固定字符串 "trade-house-snapshot-v1"
 *   明文 = gzip 压缩的 JSON
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 关于这层"加密"的性质（重要，别误解）
 * ═══════════════════════════════════════════════════════════════════════
 * 密钥就明文放在响应头里，随密文一起下发；解密算法在公开的前端 JS 里，
 * 也未做混淆。所以它**不是访问控制**（没有任何身份验证），
 * 而是**摩擦装置** —— 目的是让"随手写个脚本抓一下"的人放弃。
 *
 * 意味着：技术上能解 ≠ 伦理上许可。站长的意图是"不希望被程序化访问"。
 * 本项目因此做了三条自我约束（见 PLAN.md §12）：
 *   ① 网页显著标注"数据来源 moligod.com"并加外链
 *   ② 15 分钟低频、永不并发
 *   ③ UA 带用户邮箱，便于站长联系
 * 若站长明确要求停止，改一行 .env 即可切换或停用。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么单独成文件
 * ═══════════════════════════════════════════════════════════════════════
 * 因为这是整个项目**最容易被源站改动**的一环。独立成文件 + 独立单测后，
 * 站长一改协议，测试立刻变红，而不是等到网页上价格变成 null 才发现。
 *
 * AES-GCM 是"认证加密"：密钥 / IV / AAD 三者任何一个字节错了，
 * 解密都会**直接抛错**，而不会给你一堆乱码。所以"解密成功"本身就是
 * 极强的正确性证明 —— 不存在"解出来乱码但我看不出来"的情况。
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

/** 版本号字节，协议要求必须是 1 */
export const MOLIGOD_WIRE_VERSION = 1
/** IV 长度（字节） */
export const MOLIGOD_IV_LENGTH = 12
/** AES-GCM 认证标签长度（字节） */
export const MOLIGOD_TAG_LENGTH = 16
/** 附加认证数据（Additional Authenticated Data） */
export const MOLIGOD_AAD = 'trade-house-snapshot-v1'
/** 密钥所在的响应头名 */
export const MOLIGOD_KEY_HEADER = 'x-trade-house-key'

/** 解密过程中的任何问题都抛这个，方便上层区分"是协议变了"还是"是网络问题" */
export class MoligodWireError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MoligodWireError'
  }
}

/**
 * 解密并解压 moligod 的交易行快照。
 *
 * @param body          响应体原始字节
 * @param keyHeaderValue 响应头 `x-trade-house-key` 的值
 * @returns 解析后的 JSON 对象（结构由调用方用 zod 校验）
 * @throws {MoligodWireError} 版本号不符 / 密钥或 AAD 不符 / gzip 或 JSON 损坏
 */
export function decryptMoligodSnapshot(body: Uint8Array, keyHeaderValue: string): unknown {
  if (typeof keyHeaderValue !== 'string' || keyHeaderValue.length === 0) {
    throw new MoligodWireError(
      `响应头 ${MOLIGOD_KEY_HEADER} 缺失或为空 —— 站长可能改了密钥下发方式`,
    )
  }

  const buf = Buffer.from(body)
  const minLength = 1 + MOLIGOD_IV_LENGTH + MOLIGOD_TAG_LENGTH

  if (buf.length <= minLength) {
    throw new MoligodWireError(
      `响应体太短（${buf.length} 字节，至少需要 ${minLength}）—— 可能拿到的是错误页面而不是密文`,
    )
  }

  const version = buf[0]
  if (version !== MOLIGOD_WIRE_VERSION) {
    throw new MoligodWireError(
      `wire 版本号不是 ${MOLIGOD_WIRE_VERSION}（实际是 ${version}）—— 站长改了协议，需要重新逆向`,
    )
  }

  const iv = buf.subarray(1, 1 + MOLIGOD_IV_LENGTH)
  const rest = buf.subarray(1 + MOLIGOD_IV_LENGTH)
  // 末尾 16 字节是 GCM 认证标签；浏览器的 Web Crypto 会把它附在密文尾部，
  // 而 Node 要求单独 setAuthTag() —— 这个差异坑过很多人。
  const tag = rest.subarray(rest.length - MOLIGOD_TAG_LENGTH)
  const ciphertext = rest.subarray(0, rest.length - MOLIGOD_TAG_LENGTH)

  // 密钥派生：SHA-256(响应头值)，直接作为 32 字节 raw key 使用（AES-256）
  const key = createHash('sha256').update(keyHeaderValue, 'utf8').digest()

  let compressed: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(MOLIGOD_AAD, 'utf8'))
    decipher.setAuthTag(tag)
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new MoligodWireError(
      'AES-256-GCM 认证失败 —— 密钥派生方式、AAD 字符串或 IV 位置可能已被改动',
      { cause: err },
    )
  }

  let plain: Buffer
  try {
    plain = gunzipSync(compressed)
  } catch (err) {
    throw new MoligodWireError('解密成功但 gunzip 失败 —— 明文可能不再是 gzip 压缩的', {
      cause: err,
    })
  }

  try {
    return JSON.parse(plain.toString('utf8'))
  } catch (err) {
    throw new MoligodWireError('解压成功但 JSON 解析失败 —— 明文可能换了格式', { cause: err })
  }
}
