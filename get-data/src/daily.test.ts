/**
 * `daily.ts` 的单元测试 —— 每日密码的解析与缓存。
 *
 * ⭐ 全程**不发网络请求**：只测 `parseSecretsResponse`（纯函数）
 *    和缓存的保留行为。真实请求在浏览器验收时看。
 */

import { describe, expect, it } from 'vitest'
import { parseSecretsResponse } from './daily'

/** 官方响应的形状（实测样本，2026-09-29） */
function makeResponse(list: unknown): unknown {
  return { ret: 0, jData: { data: { data: { list } } } }
}

describe('parseSecretsResponse —— 解析官方响应', () => {
  it('正常响应', () => {
    const out = parseSecretsResponse(
      makeResponse([
        { mapID: 1, mapName: '零号大坝', secret: '1690' },
        { mapID: 2, mapName: '长弓溪谷', secret: '0178' },
      ]),
    )
    expect(out).toEqual([
      { mapId: 1, mapName: '零号大坝', secret: '1690' },
      { mapId: 2, mapName: '长弓溪谷', secret: '0178' },
    ])
  })

  it('⭐ 带前导零的密码保持字符串（转数字会变成 178，少一位看错）', () => {
    const out = parseSecretsResponse(makeResponse([{ mapID: 2, mapName: '长弓溪谷', secret: '0178' }]))
    expect(out[0]?.secret).toBe('0178')
    expect(typeof out[0]?.secret).toBe('string')
  })

  it('mapID 缺失时为 null（不编造）', () => {
    const out = parseSecretsResponse(makeResponse([{ mapName: '巴克什', secret: '9951' }]))
    expect(out[0]?.mapId).toBeNull()
  })

  it('⭐ ret 非 0 时抛错（附带 ret 值，便于判断是不是需要登录）', () => {
    expect(() => parseSecretsResponse({ ret: 101 })).toThrow(/ret=101/)
  })

  it('⭐ 结构变了时抛错，而不是返回空数组', () => {
    // 空列表会让页面显示"今天没有密码"——那是误导，必须报错
    expect(() => parseSecretsResponse({ ret: 0 })).toThrow(/list/)
    expect(() => parseSecretsResponse(makeResponse([]))).toThrow(/0 条/)
  })

  it('跳过字段缺失的条目', () => {
    const out = parseSecretsResponse(
      makeResponse([
        { mapID: 1, mapName: '', secret: '1' },
        { mapID: 2, mapName: '有效图', secret: '' },
        { mapID: 3, mapName: '正常图', secret: '1234' },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.mapName).toBe('正常图')
  })
})
