import { describe, expect, it } from 'vitest'
import {
  buildMarketRequest,
  decodeField,
  parseIdQty,
  parseMarketResponse,
  parseRequires,
} from './market-api'

describe('⭐ 真实响应里的 URL 编码（用户实测那天抓到的）', () => {
  it('"11050004004%2C1" 要能解码成 ID 100+1', () => {
    expect(parseIdQty(decodeField('11050004004%2C1'))).toEqual({
      itemId: '11050004004',
      qty: 1,
    })
  })
  it('"…%2C1%3B…%2C1" 要能解码成两项', () => {
    expect(parseRequires('15080050007%2C1%3B15080050194%2C1')).toEqual([
      { itemId: '15080050007', qty: 1 },
      { itemId: '15080050194', qty: 1 },
    ])
  })
})

describe('parseIdQty', () => {
  it('正常 "ID,数量"', () => expect(parseIdQty('15080050007,1')).toEqual({ itemId: '15080050007', qty: 1 }))
  it('没有数量时默认 1', () => expect(parseIdQty('15080050007')).toEqual({ itemId: '15080050007', qty: 1 }))
  it('ID 不是数字 → null', () => expect(parseIdQty('abc,1')).toBeNull())
  it('数量非法 → 退回 1', () => expect(parseIdQty('100,x')?.qty).toBe(1))
})

describe('parseRequires', () => {
  it('⭐ 真实样本："铜币,1;腕带,1"', () => {
    expect(parseRequires('15080050007,1;15080050194,1')).toEqual([
      { itemId: '15080050007', qty: 1 },
      { itemId: '15080050194', qty: 1 },
    ])
  })
  it('单项', () => expect(parseRequires('15080050194,1')).toHaveLength(1))
  it('空串 → 空数组', () => expect(parseRequires('')).toEqual([]))
  it('容忍 | 与换行分隔', () => expect(parseRequires('1,1|2,1\n3,1')).toHaveLength(3))
})

/** ⭐ 用用户实测当天抓到的真响应（7 条兑换项）做样本 */
const REAL = {
  ret: 0,
  sMsg: 'ok',
  jData: {
    data: {
      data: [
        { Item: '11050004004,1', ExchangedProps: '15080050007,1;15080050194,1', IsBound: '1', BeginTime: '1790301600', EndTime: '1790906399' },
        { Item: '13130000168,1', ExchangedProps: '15080050007,1', IsBound: '1', BeginTime: '1790301600', EndTime: '1790906399' },
        { Item: '13130000164,1', ExchangedProps: '15080050194,1', IsBound: '1', BeginTime: '1790301600', EndTime: '1790906399' },
      ],
    },
  },
}

describe('parseMarketResponse', () => {
  it('⭐ 真实响应：要交的东西去重成并集（腕带 + 海盗铜币）', () => {
    const s = parseMarketResponse(REAL)
    expect(s.offers).toHaveLength(3)
    expect(s.requiredItemIds.sort()).toEqual(['15080050007', '15080050194'])
    expect(s.beginAt).toBe(1790301600)
    expect(s.endAt).toBe(1790906399)
    expect(s.offers[0]!.bound).toBe(true)
  })

  it('⭐ ret=-4000「访问人数太多」→ 报错里点明那是误导性文案', () => {
    expect(() => parseMarketResponse({ ret: -4000, sMsg: '抱歉，目前访问人数太多！' })).toThrow(
      /误导性/,
    )
  })

  it('⭐ ret=0 但 data 是空数组 → 必须报错（action=2 就是这情况，别当成功）', () => {
    expect(() =>
      parseMarketResponse({ ret: 0, sMsg: 'ok', jData: { data: { data: [] } } }),
    ).toThrow(/0 条兑换项|action 用错/)
  })

  it('结构变了（data 不是数组）→ 报错', () => {
    expect(() => parseMarketResponse({ ret: 0, jData: { data: { data: 'oops' } } })).toThrow(
      /不是数组/,
    )
  })

  it('缺 BeginTime → null，不影响解析', () => {
    const s = parseMarketResponse({
      ret: 0,
      jData: { data: { data: [{ Item: '1,1', ExchangedProps: '2,1' }] } },
    })
    expect(s.beginAt).toBeNull()
    expect(s.endAt).toBeNull()
  })
})

describe('buildMarketRequest', () => {
  it('⭐ 参数放在 POST body 里（拼在 URL 上会拿不到数据 —— 踩过）', () => {
    const r = buildMarketRequest('https://x/ide/')
    expect(r.url).toBe('https://x/ide/')
    expect(r.url).not.toContain('iChartId') // ★ 关键：不在查询串上
    expect(r.body).toContain('iChartId=530479')
    expect(r.body).toContain('sIdeToken=SwgEeH')
    expect(r.body).toContain('action=3')
  })
})
