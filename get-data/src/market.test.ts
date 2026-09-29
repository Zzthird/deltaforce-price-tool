import { describe, expect, it } from 'vitest'
import { parseMarket, resolveMarketKeys } from './market'

describe('parseMarket', () => {
  it('正常解析', () => {
    const r = parseMarket('{"updatedAt":"2026-01-01T00:00:00.000Z","keys":["腕带","15080050007"]}')
    expect(r.problems).toEqual([])
    expect(r.market.keys).toEqual(['腕带', '15080050007'])
  })

  it('不是 JSON → 报错但不抛异常', () => {
    const r = parseMarket('{oops')
    expect(r.market.keys).toEqual([])
    expect(r.problems[0]).toMatch(/不是合法 JSON/)
  })

  it('缺 keys → 报错', () => {
    expect(parseMarket('{"updatedAt":null}').problems[0]).toMatch(/缺少 keys/)
  })

  it('keys 里有空项/非字符串 → 跳过并记问题', () => {
    const r = parseMarket('{"keys":["腕带","","  ",5]}')
    expect(r.market.keys).toEqual(['腕带'])
    expect(r.problems).toHaveLength(3) // ""、"  "、5 各一条
  })
})

describe('resolveMarketKeys', () => {
  const items = [
    { sourceItemId: '15080050194', name: '腕带' },
    { sourceItemId: '15080050007', name: '锈迹斑斑的海盗铜币' },
    { sourceItemId: '1', name: '同名货' },
    { sourceItemId: '2', name: '同名货' },
  ]

  it('名字唯一 → 命中', () => {
    const r = resolveMarketKeys(['腕带'], items)
    expect(r.itemIds).toEqual(['15080050194'])
    expect(r.resolved).toEqual([{ key: '腕带', name: '腕带' }])
    expect(r.problems).toEqual([])
  })

  it('纯数字 → 当官方 ID', () => {
    expect(resolveMarketKeys(['15080050007'], items).itemIds).toEqual(['15080050007'])
  })

  it('⭐ 同名冲突 → 报错并要求用 ID（不猜）', () => {
    const r = resolveMarketKeys(['同名货'], items)
    expect(r.itemIds).toEqual([])
    expect(r.problems[0]).toMatch(/2 个同名物品.*15080050007|1 \/ 2/s)
  })

  it('找不到 → 给出包含关键词的候选', () => {
    const r = resolveMarketKeys(['海盗'], items)
    expect(r.itemIds).toEqual([])
    expect(r.problems[0]).toMatch(/锈迹斑斑的海盗铜币/)
  })

  it('ID 不存在 → 报错', () => {
    expect(resolveMarketKeys(['999'], items).problems[0]).toMatch(/999 不在物品主数据里/)
  })

  it('一次多个键：好的照收，坏的单独报', () => {
    const r = resolveMarketKeys(['腕带', '不存在的名字'], items)
    expect(r.itemIds).toEqual(['15080050194'])
    expect(r.problems).toHaveLength(1)
  })
})
