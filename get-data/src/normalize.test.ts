/**
 * normalize.ts 的单元测试 —— 原料 → 成品 Item。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个文件的每一组测试都对应 Phase 3 实测踩到的一个真实坑
 * ═══════════════════════════════════════════════════════════════════════
 *   · moligod 的 `current_price` 有时是字符串 → 适配器转换 + 这里兜底
 *   · `avgPrice: 0` 是"非卖品"不是"零元" → price = null
 *   · 载具/皮肤的 `width/length` 是 0 → 除零守卫 + carryable=false
 *   · 官方 `weight` 是字符串、可能是空串
 *   · `last_update` 可能是 "N/A"
 *   · `propsDetail` 有四种完全不同的形状 → 原样保留
 *   · 官方 `grade` 理论上 0~6，实际什么都可能
 *
 * 还有这一阶段新加的两个概念：出产地覆盖合并、可获得性。
 *
 * `normalizeFromParts` 是纯函数，所以测试不需要任何 mock 或临时文件。
 */

import { describe, expect, it } from 'vitest'
import { normalizeFromParts, normalizeItems, type NormalizeOptions } from './normalize'
import type { AppliedItemAttributes } from './overrides/item-attributes'
import type { AppliedProvenance } from './overrides/provenance'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'

/* ══════════════════════════ 测试辅助 ══════════════════════════ */

function makeItem(over: Partial<SourceItem> = {}): SourceItem {
  return {
    sourceItemId: '15080050142',
    name: '海洋之泪',
    alias: null,
    description: '浑然天成，珠圆玉润的巨大天然珍珠。',
    iconUrl: 'https://example.com/a.png',
    thumbUrl: 'https://example.com/p_a.png',
    categoryCode: 'props',
    subcategory: 'collection',
    subcategoryCn: '收集品',
    thirdClass: null,
    thirdClassCn: null,
    itemSubtype: '工艺藏品',
    rawProvenance: '潮汐监狱-全地图',
    grade: 6,
    weight: 0.05,
    width: 1,
    length: 1,
    basePrice: null,
    officialAvgPrice: 33478148,
    lastUpdate: null,
    propsDetail: { type: '工艺藏品', propsSource: '潮汐监狱-全地图' },
    ...over,
  }
}

function makeQuote(over: Partial<PriceQuote> = {}): PriceQuote {
  return {
    price: 34275453,
    basePrice: 31710588,
    yesterdayAvg: 33417672,
    yesterdayLow: 27746793,
    yesterdayHigh: 36451673,
    rangeLow: 24482463,
    rangeHigh: 38083838,
    updateTime: '2026-09-28 14:24',
    ...over,
  }
}

const ALL_MAPS_SORTED = ['巴克什', '潮汐监狱', '航天基地', '零号大坝', '长弓溪谷'].sort()

/**
 * 地图名的排序依赖 ICU 的排序规则，跨 Node 版本可能不同。
 * 所以凡是断言“地图名数组”的地方都只比较**集合**，不比较顺序。
 */
function expectMapSet(actual: readonly string[] | null | undefined, expected: readonly string[]) {
  expect(actual).not.toBeNull()
  expect([...(actual ?? [])].sort()).toEqual([...expected].sort())
}

function options(over: Partial<NormalizeOptions> = {}): NormalizeOptions {
  return {
    itemSource: 'official',
    provenance: new Map(),
    attributes: new Map(),
    allMapNames: ALL_MAPS_SORTED,
    staleAfterHours: 24,
    fetchedAt: '2026-09-28T06:24:00.000Z',
    now: new Date('2026-09-28T06:30:00.000Z'),
    ...over,
  }
}

function provEntry(maps: string[] | null, source: AppliedProvenance['source']): AppliedProvenance {
  return { maps, source }
}

function attrEntry(
  availability: AppliedItemAttributes['availability'],
  note: string | null = null,
  extra: Partial<AppliedItemAttributes> = {},
): AppliedItemAttributes {
  return {
    availability,
    listable: true,
    unitsPerSlot: 1,
    seasonal: null,
    note,
    manual: true,
    ...extra,
  }
}

/* ══════════════════════════ 基本映射 ══════════════════════════ */

describe('normalizeFromParts —— 基本字段映射', () => {
  it('身份字段', () => {
    const item = normalizeFromParts(makeItem(), makeQuote(), options())
    expect(item.key).toBe('official:15080050142')
    expect(item.source).toBe('official')
    expect(item.sourceItemId).toBe('15080050142')
  })

  it('⭐ displayName 用官方名，别名单独放 alias（不拿别名当展示名）', () => {
    const item = normalizeFromParts(
      makeItem({ name: 'H70 精英头盔', alias: '铁头' }),
      makeQuote(),
      options(),
    )
    expect(item.displayName).toBe('H70 精英头盔')
    expect(item.alias).toBe('铁头')
  })

  it('空串的 alias / description / itemSubtype 被规范成 null', () => {
    const item = normalizeFromParts(
      makeItem({ alias: '  ', description: '', itemSubtype: '  ' }),
      makeQuote(),
      options(),
    )
    expect(item.alias).toBeNull()
    expect(item.description).toBeNull()
    expect(item.itemSubtype).toBeNull()
  })

  it('⭐ categoryCn 用映射表；未知代码回退到代码本身（不让网页显示空白）', () => {
    expect(normalizeFromParts(makeItem(), makeQuote(), options()).categoryCn).toBe('道具')
    expect(
      normalizeFromParts(makeItem({ categoryCode: '新大类' }), makeQuote(), options()).categoryCn,
    ).toBe('新大类')
  })

  it('⭐ subcategoryCn 缺失时回退到代码，再没有就写「未分类」', () => {
    expect(
      normalizeFromParts(makeItem({ subcategoryCn: null }), makeQuote(), options()).subcategoryCn,
    ).toBe('collection')
    expect(
      normalizeFromParts(
        makeItem({ subcategoryCn: null, subcategory: '' }),
        makeQuote(),
        options(),
      ).subcategoryCn,
    ).toBe('未分类')
  })

  it('第三级分类原样透传（消耗品才有）', () => {
    const item = normalizeFromParts(
      makeItem({ thirdClass: 'repair', thirdClassCn: '维修套件' }),
      makeQuote(),
      options(),
    )
    expect(item.thirdClass).toBe('repair')
    expect(item.thirdClassCn).toBe('维修套件')
  })

  it('⭐ propsDetail 原样保留（变长结构，不能建固定类型）', () => {
    const detail = { repairPoints: 200, repairArea: '胸甲', activeTime: '4.5' }
    const item = normalizeFromParts(
      makeItem({ propsDetail: detail }),
      makeQuote(),
      options(),
    )
    expect(item.propsDetail).toEqual(detail)
  })
})

/* ══════════════════════════ 品质 ══════════════════════════ */

describe('normalizeFromParts —— 品质收窄', () => {
  it('合法值查三张表', () => {
    const item = normalizeFromParts(makeItem({ grade: 6 }), makeQuote(), options())
    expect(item.grade).toBe(6)
    expect(item.gradeCn).toBe('红')
    expect(item.gradeTone).toBe('red')
    expect(item.gradeColor).toBe('#cb464a')
  })

  it('⭐ 超范围被夹住（源里什么都可能出现）', () => {
    expect(normalizeFromParts(makeItem({ grade: 99 }), makeQuote(), options()).grade).toBe(6)
    expect(normalizeFromParts(makeItem({ grade: -5 }), makeQuote(), options()).grade).toBe(0)
  })

  it('灰色的 grade 0（枪械/载具）映射正确', () => {
    const item = normalizeFromParts(makeItem({ grade: 0 }), makeQuote(), options())
    expect(item.gradeCn).toBe('灰')
    expect(item.gradeColor).toBe('#949595')
  })
})

/* ══════════════════════════ 占格 / 除零守卫 ══════════════════════════ */

describe('normalizeFromParts —— 占格与除零守卫', () => {
  it('正常占格算出单格价值', () => {
    const item = normalizeFromParts(
      makeItem({ width: 2, length: 2 }),
      makeQuote({ price: 377058 }),
      options(),
    )
    expect(item.slots).toBe(4)
    expect(item.pricePerSlot).toBeCloseTo(94264.5)
    expect(item.carryable).toBe(true)
  })

  it('⭐ 占格 0（载具/皮肤）→ slots=0、pricePerSlot=null、carryable=false', () => {
    const item = normalizeFromParts(
      makeItem({ width: 0, length: 0, officialAvgPrice: null }),
      null,
      options(),
    )
    expect(item.slots).toBe(0)
    expect(item.pricePerSlot).toBeNull()
    expect(item.carryable).toBe(false)
    // 关键：不能是 Infinity
    expect(Number.isFinite(item.pricePerSlot as number)).toBe(false)
  })

  it('⭐ 有价格但占格 0 → 单格价值仍是 null（不是 Infinity）', () => {
    const item = normalizeFromParts(makeItem({ width: 0, length: 1 }), makeQuote(), options())
    expect(item.slots).toBe(0)
    expect(item.pricePerSlot).toBeNull()
  })
})

/* ══════════════════════════ 价格 ══════════════════════════ */

describe('normalizeFromParts —— 价格', () => {
  it('正常价格透传', () => {
    const item = normalizeFromParts(makeItem(), makeQuote(), options())
    expect(item.price).toBe(34275453)
    expect(item.basePrice).toBe(31710588)
    expect(item.officialAvgPrice).toBe(33478148)
  })

  it('⭐ price = 0 → null（"非卖品"不是"零元"）', () => {
    const item = normalizeFromParts(makeItem(), makeQuote({ price: 0 }), options())
    expect(item.price).toBeNull()
    expect(item.pricePerSlot).toBeNull()
  })

  it('⭐ 负数价格 → null', () => {
    expect(normalizeFromParts(makeItem(), makeQuote({ price: -1 }), options()).price).toBeNull()
  })

  it('⭐ 没有价格源数据（quote=null）→ 价格字段全 null，但官方均价保留', () => {
    const item = normalizeFromParts(makeItem(), null, options())
    expect(item.price).toBeNull()
    expect(item.basePrice).toBeNull()
    expect(item.yesterdayAvg).toBeNull()
    expect(item.rangeLow).toBeNull()
    // 官方均价是独立的字段，不该受价格源影响
    expect(item.officialAvgPrice).toBe(33478148)
  })

  it('⭐ 派生指标由 metrics 统一算（今日涨幅）', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote({ price: 110, yesterdayAvg: 100 }),
      options(),
    )
    expect(item.todayChangePct).toBeCloseTo(10)
  })

  it('⭐ 昨日均价为 0 → 涨幅是 null 而不是 Infinity', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote({ price: 100, yesterdayAvg: 0 }),
      options(),
    )
    expect(item.todayChangePct).toBeNull()
  })
})

/* ══════════════════════════ 时间 ══════════════════════════ */

describe('normalizeFromParts —— 时间与陈旧判断', () => {
  it('⭐ lastUpdate 优先取价格源的时间（官方物品列表不带这个字段）', () => {
    const item = normalizeFromParts(
      makeItem({ lastUpdate: '2020-01-01 00:00' }),
      makeQuote({ updateTime: '2026-09-28 14:24' }),
      options(),
    )
    expect(item.lastUpdate).toBe('2026-09-28 14:24')
  })

  it('价格源没有时间时回退到源侧时间', () => {
    const item = normalizeFromParts(
      makeItem({ lastUpdate: '2026-09-28 10:00' }),
      makeQuote({ updateTime: null }),
      options(),
    )
    expect(item.lastUpdate).toBe('2026-09-28 10:00')
  })

  it('⭐ "N/A" 这类脏值 → null', () => {
    const item = normalizeFromParts(
      makeItem({ lastUpdate: 'N/A' }),
      makeQuote({ updateTime: 'N/A' }),
      options(),
    )
    expect(item.lastUpdate).toBeNull()
  })

  it('⭐ 24 小时前的数据算陈旧', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote({ updateTime: '2026-09-26 12:00' }),
      options(),
    )
    expect(item.stale).toBe(true)
  })

  it('刚更新的数据不算陈旧', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote({ updateTime: '2026-09-28 06:00' }),
      options(),
    )
    expect(item.stale).toBe(false)
  })

  it('fetchedAt 原样带上（用于网页显示"数据是 X 分钟前的"）', () => {
    const item = normalizeFromParts(makeItem(), makeQuote(), options())
    expect(item.fetchedAt).toBe('2026-09-28T06:24:00.000Z')
  })
})

/* ══════════════════════════ 出产地 ══════════════════════════ */

describe('normalizeFromParts —— 出产地', () => {
  it('无覆盖 + 官方有数据 → official', () => {
    const item = normalizeFromParts(makeItem(), makeQuote(), options())
    expect(item.provenanceMaps).toEqual(['潮汐监狱'])
    expect(item.provenanceSource).toBe('official')
  })

  it('无覆盖 + 官方也没有 → 两个都是 null', () => {
    const item = normalizeFromParts(makeItem({ rawProvenance: null }), makeQuote(), options())
    expect(item.provenanceMaps).toBeNull()
    expect(item.provenanceSource).toBeNull()
  })

  it('⭐ replace 覆盖 → manual', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        provenance: new Map([['15080050142', provEntry(['巴克什'], 'manual')]]),
      }),
    )
    expect(item.provenanceMaps).toEqual(['巴克什'])
    expect(item.provenanceSource).toBe('manual')
  })

  it('⭐ append 合并 → merged', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        provenance: new Map([['15080050142', provEntry(['潮汐监狱', '零号大坝'], 'merged')]]),
      }),
    )
    expectMapSet(item.provenanceMaps, ['潮汐监狱', '零号大坝'])
    expect(item.provenanceSource).toBe('merged')
  })

  it('⭐ 显式删除（人工写空数组）→ maps=null 但 source 保留 manual', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        provenance: new Map([['15080050142', provEntry(null, 'manual')]]),
      }),
    )
    expect(item.provenanceMaps).toBeNull()
    // 保留 manual 是为了让网页能区分"官方没给数据"和"你确认它没有出产地"
    expect(item.provenanceSource).toBe('manual')
  })

  it('⭐ 特殊值「全地图」在这里被展开成明确的地图名', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        provenance: new Map([['15080050142', provEntry(['全地图'], 'manual')]]),
      }),
    )
    expectMapSet(item.provenanceMaps, ALL_MAPS_SORTED)
  })
})

/* ══════════════════════════ 可获得性 ══════════════════════════ */

describe('normalizeFromParts —— 可获得性', () => {
  it('⭐ 没标注 → 默认「可摸」', () => {
    const item = normalizeFromParts(makeItem(), makeQuote(), options())
    expect(item.availability).toBe('lootable')
    expect(item.availabilityNote).toBeNull()
  })

  it('标注「不可摸」+ 理由', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        attributes: new Map([['15080050142', attrEntry('unobtainable', '只能军需处兑换')]]),
      }),
    )
    expect(item.availability).toBe('unobtainable')
    expect(item.availabilityNote).toBe('只能军需处兑换')
  })

  it('标注「已失效」', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({ attributes: new Map([['15080050142', attrEntry('expired')]]) }),
    )
    expect(item.availability).toBe('expired')
  })
})

/* ══════════════════════════ 可直接上架 / 每格单位数 ══════════════════════════ */

describe('normalizeFromParts —— 可上架交易行', () => {
  it('⭐ 没标注 → 默认可以上架', () => {
    expect(normalizeFromParts(makeItem(), makeQuote(), options()).listable).toBe(true)
  })

  it('标注为不可上架（旧赛季子弹）', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        attributes: new Map([['15080050142', attrEntry('lootable', null, { listable: false })]]),
      }),
    )
    expect(item.listable).toBe(false)
  })
})

describe('normalizeFromParts —— 每格单位数（子弹的 60 倍修正）', () => {
  it('⭐ 非弹药默认 1 → 单格价值不变', () => {
    const item = normalizeFromParts(
      makeItem({ categoryCode: 'props', width: 2, length: 2 }),
      makeQuote({ price: 1000 }),
      options(),
    )
    expect(item.unitsPerSlot).toBe(1)
    expect(item.pricePerSlot).toBe(250) // 1000 × 1 ÷ 4
  })

  it('⭐ 弹药：一个格子放 60 发 → 单格价值 ×60', () => {
    const item = normalizeFromParts(
      makeItem({ categoryCode: 'ammo', width: 1, length: 1 }),
      makeQuote({ price: 1666 }),
      options({
        attributes: new Map([['15080050142', attrEntry('lootable', null, { unitsPerSlot: 60 })]]),
      }),
    )
    expect(item.unitsPerSlot).toBe(60)
    expect(item.pricePerSlot).toBe(1666 * 60) // 99,960
  })

  it('⭐ 弹药但没标每组发数 → unitsPerSlot=null，单格价值算不出来', () => {
    const item = normalizeFromParts(
      makeItem({ categoryCode: 'ammo', width: 1, length: 1 }),
      makeQuote({ price: 1666 }),
      options({ attributes: new Map() }),
    )
    expect(item.unitsPerSlot).toBeNull()
    expect(item.pricePerSlot).toBeNull()
    // 关键：价格本身仍在，只是单格价值算不出来
    expect(item.price).toBe(1666)
  })

  it('同一口径可以有不同的每组发数（实测 6.8x51mm 有两种）', () => {
    const mk = (units: number) =>
      normalizeFromParts(
        makeItem({ categoryCode: 'ammo', width: 1, length: 1 }),
        makeQuote({ price: 100 }),
        options({
          attributes: new Map([['15080050142', attrEntry('lootable', null, { unitsPerSlot: units })]]),
        }),
      )
    expect(mk(60).pricePerSlot).toBe(6000)
    expect(mk(90).pricePerSlot).toBe(9000)
  })

  it('弹药显式标 1（比如单发不可堆叠）也尊重', () => {
    const item = normalizeFromParts(
      makeItem({ categoryCode: 'ammo', width: 1, length: 1 }),
      makeQuote({ price: 100 }),
      options({
        attributes: new Map([['15080050142', attrEntry('lootable', null, { unitsPerSlot: 1 })]]),
      }),
    )
    expect(item.pricePerSlot).toBe(100)
  })
})

/* ══════════════════════════ 赛季限定 ══════════════════════════ */

describe('normalizeFromParts —— 赛季限定', () => {
  it('⭐ 不是赛季限定时 seasonal 为 null', () => {
    expect(normalizeFromParts(makeItem(), makeQuote(), options()).seasonal).toBeNull()
  })

  it('⭐ 本季弹：可摸 + 可上架（由 seasonal 推导）', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        attributes: new Map([['15080050142', attrEntry('lootable', null, { seasonal: 'current' })]]),
      }),
    )
    expect(item.seasonal).toBe('current')
    expect(item.availability).toBe('lootable')
    expect(item.listable).toBe(true)
  })

  it('⭐ 往季弹：限时下架 + 不可上架（由 seasonal 推导）', () => {
    const item = normalizeFromParts(
      makeItem(),
      makeQuote(),
      options({
        attributes: new Map([
          ['15080050142', attrEntry('expired', null, { seasonal: 'past', listable: false })],
        ]),
      }),
    )
    expect(item.seasonal).toBe('past')
    expect(item.availability).toBe('expired')
    expect(item.listable).toBe(false)
  })
})

/* ══════════════════════════ 批量与统计 ══════════════════════════ */

describe('normalizeItems —— 批量转换与统计', () => {
  const joined = [
    { item: makeItem({ sourceItemId: '1', name: 'A' }), quote: makeQuote(), matchedBy: 'A' },
    {
      item: makeItem({ sourceItemId: '2', name: 'B', rawProvenance: null, width: 0, length: 0 }),
      quote: makeQuote({ price: null }),
      matchedBy: 'B',
    },
    { item: makeItem({ sourceItemId: '3', name: 'C', rawProvenance: null }), quote: null, matchedBy: null },
  ]

  it('统计口径正确', () => {
    const { items, stats } = normalizeItems(joined, options())
    expect(items).toHaveLength(3)
    expect(stats.total).toBe(3)
    expect(stats.withPrice).toBe(1)
    expect(stats.withPricePerSlot).toBe(1)
    expect(stats.carryable).toBe(2) // 第 2 条占格 0
    expect(stats.withProvenance).toBe(1) // 只有第 1 条官方有数据
    expect(stats.manualProvenance).toBe(0)
  })

  it('按可获得性分桶，且三桶之和等于总数', () => {
    const { stats } = normalizeItems(joined, options({
      attributes: new Map([
        ['2', attrEntry('unobtainable')],
        ['3', attrEntry('expired')],
      ]),
    }))
    expect(stats.byAvailability).toEqual({ lootable: 1, unobtainable: 1, expired: 1 })
    const sum =
      stats.byAvailability.lootable + stats.byAvailability.unobtainable + stats.byAvailability.expired
    expect(sum).toBe(stats.total)
  })

  it('人工补的出产地被计入 manualProvenance', () => {
    const { stats } = normalizeItems(joined, options({
      provenance: new Map([
        ['2', provEntry(['巴克什'], 'manual')],
        ['3', provEntry(['长弓溪谷'], 'merged')],
      ]),
    }))
    expect(stats.withProvenance).toBe(3)
    expect(stats.manualProvenance).toBe(2)
  })

  it('空输入不崩', () => {
    const { items, stats } = normalizeItems([], options())
    expect(items).toEqual([])
    expect(stats.total).toBe(0)
    expect(stats.byAvailability.lootable).toBe(0)
  })
})
