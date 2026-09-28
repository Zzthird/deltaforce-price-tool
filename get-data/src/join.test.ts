/**
 * join.ts 的单元测试 —— 名称匹配。
 *
 * 重点测**三段分桶**是否正确。因为如果把"匹配上但源说非卖品"错算成
 * "没匹配上"，匹配率会虚低，会让人误以为两份数据系统性错位。
 *
 * 还要测**不做模糊匹配**：那是刻意的设计（宁可显示"暂无价格"，
 * 也不要错配一个价格让你照着它做决策）。
 */

import { describe, expect, it } from 'vitest'
import { joinPrices } from './join'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'

/** 造一个最小的 SourceItem（只有 join 用得到的字段才重要） */
function makeItem(over: Partial<SourceItem> = {}): SourceItem {
  return {
    sourceItemId: '1',
    name: '海洋之泪',
    alias: null,
    description: null,
    iconUrl: '',
    thumbUrl: null,
    categoryCode: 'props',
    subcategory: 'collection',
    subcategoryCn: '收集品',
    thirdClass: null,
    thirdClassCn: null,
    itemSubtype: null,
    rawProvenance: null,
    grade: 6,
    weight: null,
    width: 1,
    length: 1,
    basePrice: null,
    officialAvgPrice: null,
    lastUpdate: null,
    propsDetail: null,
    ...over,
  }
}

function makeQuote(over: Partial<PriceQuote> = {}): PriceQuote {
  return {
    price: null,
    basePrice: null,
    yesterdayAvg: null,
    yesterdayLow: null,
    yesterdayHigh: null,
    rangeLow: null,
    rangeHigh: null,
    updateTime: null,
    ...over,
  }
}

describe('joinPrices —— 三段分桶', () => {
  it('① 匹配 + 有价格', () => {
    const prices = new Map([['海洋之泪', makeQuote({ price: 33731398 })]])
    const { items, stats } = joinPrices([makeItem({ name: '海洋之泪' })], prices)

    expect(stats.matchedWithPrice).toBe(1)
    expect(stats.matchedNoPrice).toBe(0)
    expect(stats.notFound).toBe(0)
    expect(stats.priceCoverage).toBe(1)
    expect(items[0]!.quote?.price).toBe(33731398)
  })

  it('⭐ ② 匹配 + 无价格（join 正确，只是该物品非卖品）', () => {
    const prices = new Map([['藏宝图8号', makeQuote({ price: null })]])
    const { items, stats } = joinPrices([makeItem({ name: '藏宝图8号' })], prices)

    expect(stats.matchedWithPrice).toBe(0)
    expect(stats.matchedNoPrice).toBe(1)
    expect(stats.notFound).toBe(0)
    // ⭐ 关键：名称匹配率包含这一桶，价格覆盖率不包含
    expect(stats.nameMatchRate).toBe(1)
    expect(stats.priceCoverage).toBe(0)
    expect(items[0]!.quote).not.toBeNull()
    expect(items[0]!.matchedBy).toBe('藏宝图8号')
  })

  it('③ 名字找不到', () => {
    const prices = new Map([['另一个东西', makeQuote({ price: 1 })]])
    const { items, stats } = joinPrices([makeItem({ name: '海洋之泪' })], prices)

    expect(stats.matchedWithPrice).toBe(0)
    expect(stats.matchedNoPrice).toBe(0)
    expect(stats.notFound).toBe(1)
    expect(stats.nameMatchRate).toBe(0)
    expect(items[0]!.quote).toBeNull()
    expect(items[0]!.matchedBy).toBeNull()
  })

  it('混合场景下各桶计数正确', () => {
    const prices = new Map([
      ['A', makeQuote({ price: 100 })],
      ['B', makeQuote({ price: null })],
    ])
    const { stats } = joinPrices(
      [makeItem({ name: 'A' }), makeItem({ name: 'B' }), makeItem({ name: 'C' })],
      prices,
    )
    expect(stats).toMatchObject({
      total: 3,
      matchedWithPrice: 1,
      matchedNoPrice: 1,
      notFound: 1,
    })
    expect(stats.nameMatchRate).toBeCloseTo(2 / 3)
    expect(stats.priceCoverage).toBeCloseTo(1 / 3)
  })
})

describe('joinPrices —— 匹配规则', () => {
  it('匹配前去掉首尾空白', () => {
    const prices = new Map([['海洋之泪', makeQuote({ price: 1 })]])
    const { stats } = joinPrices([makeItem({ name: '  海洋之泪  ' })], prices)
    expect(stats.matchedWithPrice).toBe(1)
  })

  it('⭐ 不做模糊匹配 —— 名称不同就是匹配不上', () => {
    // 官方叫「D6 战术头盔」，价格源只有「D6 战术头盔（全新）」
    // 这是**刻意的**：选择哪个耐久变体有歧义，猜一个会给出错误的价格
    const prices = new Map([['D6 战术头盔（全新）', makeQuote({ price: 45469 })]])
    const { stats } = joinPrices([makeItem({ name: 'D6 战术头盔' })], prices)
    expect(stats.matchedWithPrice).toBe(0)
    expect(stats.notFound).toBe(1)
  })

  it('空输入不崩，比率是 0 而不是 NaN', () => {
    const { items, stats } = joinPrices([], new Map())
    expect(items).toEqual([])
    expect(stats.total).toBe(0)
    expect(stats.nameMatchRate).toBe(0)
    expect(stats.priceCoverage).toBe(0)
  })
})

describe('joinPrices —— 诊断样本', () => {
  it('样本最多各 20 / 10 条', () => {
    const items = Array.from({ length: 50 }, (_, i) => makeItem({ name: `物品${i}` }))
    const { stats } = joinPrices(items, new Map())
    expect(stats.notFoundSample).toHaveLength(20)
  })

  it('⭐ 有官方均价的排前面（那说明"本该有价格"，诊断价值更高）', () => {
    const items = [
      makeItem({ name: '没有均价的' }),
      makeItem({ name: '有均价的', officialAvgPrice: 12345 }),
      makeItem({ name: '子类为空的', subcategoryCn: null, subcategory: '' }),
    ]
    const { stats } = joinPrices(items, new Map())
    expect(stats.notFoundSample[0]!.name).toBe('有均价的')
  })
})

/* ══════════════════════ ⭐ 品质前缀兜底（.300BLK 的坑） ══════════════════════ */

/**
 * 这一组锁住一个实测发现的 bug：
 *
 * 官方有 **3 条同名的 `.300BLK`**（品质 5 / 4 / 3，官方均价 5174 / 1717 / 439），
 * moligod 靠**加品质前缀**区分：`金.300BLK` / `紫.300BLK` / `蓝.300BLK`
 * （现价 5193 / 1757 / 452）。
 *
 * 按名称精确匹配 → **一条都配不上** → 三条子弹全都没价。
 * 而三者价格差 **11 倍**，配错了会直接把排名算错。
 *
 * 修复只能在 join 这一层做：适配器只有一个「名称 → 价格」的 Map，
 * 三个前缀拆回裸名会**互相覆盖**（只剩一条）；而 join 看得到物品的品质。
 */
describe('joinPrices —— 品质前缀兜底', () => {
  const prices = new Map<string, PriceQuote>([
    ['金.300BLK', makeQuote({ price: 5193 })],
    ['紫.300BLK', makeQuote({ price: 1757 })],
    ['蓝.300BLK', makeQuote({ price: 452 })],
  ])

  const items = [
    makeItem({ sourceItemId: '1', name: '.300BLK', grade: 5 }),
    makeItem({ sourceItemId: '2', name: '.300BLK', grade: 4 }),
    makeItem({ sourceItemId: '3', name: '.300BLK', grade: 3 }),
  ]

  it('⭐ 三条同名不同品质的子弹，各自配到**自己那一档**的价', () => {
    const { items: joined } = joinPrices(items, prices)

    expect(joined[0]!.quote!.price).toBe(5193) // 品质 5 → 金
    expect(joined[1]!.quote!.price).toBe(1757) // 品质 4 → 紫
    expect(joined[2]!.quote!.price).toBe(452) // 品质 3 → 蓝
  })

  it('⭐ 绝不能三条都配到同一条（那就是最危险的错误：看着对、其实错 11 倍）', () => {
    const { items: joined } = joinPrices(items, prices)
    const got = joined.map((j) => j.quote!.price)
    expect(new Set(got).size).toBe(3)
  })

  it('记录 matchedBy，方便事后查是走了兜底', () => {
    const { items: joined } = joinPrices(items, prices)
    expect(joined[0]!.matchedBy).toBe('金.300BLK')
    expect(joined[2]!.matchedBy).toBe('蓝.300BLK')
  })

  it('stats 里能看出走了几次兜底', () => {
    const { stats } = joinPrices(items, prices)
    expect(stats.matchedViaFallback).toBe(3)
    expect(stats.matchedWithPrice).toBe(3)
    expect(stats.notFound).toBe(0)
  })

  it('⭐ 精确匹配优先 —— 有裸名时绝不走前缀', () => {
    const withBare = new Map(prices)
    withBare.set('.300BLK', makeQuote({ price: 999 }))

    const { items: joined, stats } = joinPrices(items, withBare)

    expect(joined[0]!.quote!.price).toBe(999)
    expect(joined[0]!.matchedBy).toBe('.300BLK')
    expect(stats.matchedViaFallback).toBe(0)
  })

  it('品质越界（数据里的脏值）→ 不猜前缀，老实算没匹配上', () => {
    const weird = [makeItem({ sourceItemId: '9', name: '.300BLK', grade: 99 })]
    const { stats } = joinPrices(weird, prices)
    expect(stats.notFound).toBe(1)
    expect(stats.matchedViaFallback).toBe(0)
  })

  it('前缀拼出来的键不存在 → 仍然算没匹配上', () => {
    const only = [makeItem({ sourceItemId: '1', name: '不存在的子弹', grade: 5 })]
    const { stats } = joinPrices(only, prices)
    expect(stats.notFound).toBe(1)
    expect(stats.matchedViaFallback).toBe(0)
  })
})

/* ══════════════════════ ⭐ 有分档的护甲在统计里要算“有价” ══════════════════════ */

describe('joinPrices —— 耐久度分档的护甲', () => {
  it('⭐ 裸名无价但分档有价（那 8 件头盔）→ 算“①有价格”，不算“非卖品”', () => {
    const prices = new Map<string, PriceQuote>([
      ['D6 战术头盔', makeQuote({ price: null, variants: { 全新: 48463, 破损: 48276 } })],
    ])
    const items = [makeItem({ sourceItemId: '1', name: 'D6 战术头盔', categoryCode: 'protect' })]

    const { stats } = joinPrices(items, prices)

    expect(stats.matchedWithPrice).toBe(1)
    expect(stats.matchedNoPrice).toBe(0)
    expect(stats.notFound).toBe(0)
  })
})
