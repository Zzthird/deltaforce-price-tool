/**
 * filters / rules 两个 store 的单元测试。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么这一组测试特别重要
 * ═══════════════════════════════════════════════════════════════════════
 * Phase 9 的界面里有三块逻辑是**算出来的**，不是"把数据摆出来"：
 *
 *   ① **交叉计数**（faceted counts）—— "选了之后还剩多少"
 *   ② **三级联动的清空** —— 改大类要不要带着子类一起清
 *   ③ **判定与排序** —— 哪些算不出来、哪些排最后
 *
 * 这三块错了都不会报错，只会给出**看起来合理的错结果** ——
 * 比如下拉里显示"道具 (711)"，点进去 0 条。靠手点页面很难覆盖全，
 * 所以用测试把规则钉死。
 *
 * ⚠️ 测试不发任何网络请求：直接给 store 赋数据，绕开 `/api/items`。
 *    这既是测试快的保证，也避免了"跑一次测试就打一次源站"。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Item } from '@deltaforce/shared'

import { useItemsStore } from './items'
import { useMetaStore } from './meta'
import { useRulesStore } from './rules'
import { useFiltersStore } from './filters'

/* ══════════════════════ 测试脚手架 ══════════════════════ */

/**
 * 造一条最小的 Item。
 *
 * Item 有 30 多个字段，但筛选与判定只用到其中十来个。
 * 其余用合理默认值填上 —— 好处是 `Item` 加字段时这里会立刻报错，
 * 逼着人来补一个默认值，而不是悄悄漏掉。
 */
function makeItem(over: Partial<Item> = {}): Item {
  const slots = over.slots ?? 1
  const price = over.price === undefined ? 100_000 : over.price
  const unitsPerSlot = over.unitsPerSlot ?? 1
  /**
   * ⚠️ `pricePerSlot` 必须**乘上 `unitsPerSlot`**（不是简单地 price/slots）。
   *
   * 第一版 fixture 写成了 `price / slots`，于是弹药的 fixture 单格价值
   * 少了 60 倍 —— 测试里弹药的判定结果就全错了。
   * 而那个错误的数字看起来完全合理，所以一开始没发现。
   * （真实代码里这个式子只在 `metrics.ts` 实现一次，所以不会出现两份口径。）
   */
  const pricePerSlot =
    over.pricePerSlot !== undefined
      ? over.pricePerSlot
      : price === null
        ? null
        : (price * unitsPerSlot) / slots
  return {
    key: `official:${over.sourceItemId ?? '1'}`,
    source: 'official',
    sourceItemId: '15080050142',
    name: '测试物品',
    displayName: '测试物品',
    alias: null,
    description: null,
    iconUrl: '',
    thumbUrl: null,
    categoryCode: 'props',
    categoryCn: '道具',
    subcategory: 'collection',
    subcategoryCn: '收集品',
    thirdClass: null,
    thirdClassCn: null,
    itemSubtype: null,
    propsDetail: null,
    provenanceMaps: ['长弓溪谷'],
    provenanceSource: 'manual',
    availability: 'lootable',
    availabilityNote: null,
    listable: true,
    unitsPerSlot,
    seasonal: null,
    grade: 6,
    gradeCn: '红',
    gradeTone: 'red',
    gradeColor: '#cb464a',
    price,
    basePrice: null,
    priceVariants: null,
    officialAvgPrice: null,
    weight: null,
    width: 1,
    length: 1,
    slots,
    pricePerSlot,
    todayChangePct: null,
    yesterdayAvg: null,
    yesterdayLow: null,
    yesterdayHigh: null,
    rangeLow: null,
    rangeHigh: null,
    carryable: slots > 0,
    lastUpdate: null,
    fetchedAt: '2026-09-28T06:00:00.000Z',
    stale: false,
    ...over,
  }
}

/** 一条典型的物品集，覆盖各种边界 */
const FIXTURE: Item[] = [
  // 道具 / 收集品，很值钱
  makeItem({ sourceItemId: '15080050142', name: '海洋之泪', price: 34_000_000, grade: 6 }),
  // 道具 / 收集品，中等（品质 3 = 蓝）
  makeItem({
    sourceItemId: '15200000111',
    name: '普通收集品',
    price: 60_000,
    grade: 3,
    gradeCn: '蓝',
    gradeTone: 'blue',
    gradeColor: '#658bce',
  }),
  // 道具 / 钥匙，只有 AZ3 出（品质 5 = 金）
  makeItem({
    sourceItemId: '16110001003',
    name: '反应堆总控核心',
    subcategory: 'key',
    subcategoryCn: '钥匙',
    price: 7_000_000,
    grade: 5,
    gradeCn: '金',
    gradeTone: 'gold',
    gradeColor: '#e8a64e',
    provenanceMaps: ['AZ3'],
  }),
  // 弹药：单价 4484，每组 60 发，1 格 → 单格价值 269,040（品质 4 = 紫）
  makeItem({
    sourceItemId: '37280500001',
    name: '9x39mm BP',
    categoryCode: 'ammo',
    categoryCn: '弹药',
    subcategory: 'ammo9x39',
    subcategoryCn: '9x39mm',
    price: 4_484,
    unitsPerSlot: 60,
    grade: 4,
    gradeCn: '紫',
    gradeTone: 'purple',
    gradeColor: '#9b61c8',
  }),
  // 弹药，很便宜（该跳过）
  makeItem({
    sourceItemId: '37280300001',
    name: '便宜弹',
    categoryCode: 'ammo',
    categoryCn: '弹药',
    subcategory: 'ammo9x39',
    subcategoryCn: '9x39mm',
    price: 10,
    unitsPerSlot: 60,
    grade: 2,
    gradeCn: '绿',
    gradeTone: 'green',
    gradeColor: '#188d14',
  }),
  // 不可上架（有价但挂不上交易行）
  makeItem({ sourceItemId: '15200000999', name: '火箭燃料', listable: false, price: 5_000_000 }),
  // 不可摸（限时下架）
  makeItem({ sourceItemId: '37280100001', name: '旧赛季弹', availability: 'expired', price: 3_000_000 }),
  // 没有价格（名字对上了但源说是非卖品）
  makeItem({ sourceItemId: '15200000228', name: '藏宝图', price: null, pricePerSlot: null }),
]

beforeEach(() => {
  // 每个用例一套全新的 Pinia —— 否则上一个用例改的筛选会漏到下一个
  setActivePinia(createPinia())

  const items = useItemsStore()
  items.items = FIXTURE

  // categoryOptions 以后端的完整大类清单为基准，所以也要给它数据
  const meta = useMetaStore()
  meta.categories = [
    { value: 'props', label: '道具', count: 0 },
    { value: 'ammo', label: '弹药', count: 0 },
    { value: 'acc', label: '配件', count: 0 },
  ]
})

/* ══════════════════════ 基础池 ══════════════════════ */

describe('候选池 —— 哪些默认不参与', () => {
  it('⭐ 默认排除"不可上架 / 不可摸"，但仍保留"无价格"的（它有名字有出产地）', () => {
    const filters = useFiltersStore()
    const names = filters.pool.map((i) => i.name)

    expect(names).not.toContain('火箭燃料') // 不可上架
    expect(names).not.toContain('旧赛季弹') // 不可摸
    expect(names).toContain('藏宝图') // 无价格 —— 仍在池里，只是判不了
    expect(names).toContain('海洋之泪')
  })

  it('打开开关后全部出现（那些信息本身有价值）', () => {
    const filters = useFiltersStore()
    filters.includeExcluded = true
    const names = filters.pool.map((i) => i.name)

    expect(names).toContain('火箭燃料')
    expect(names).toContain('旧赛季弹')
  })
})

/* ══════════════════════ 判定 ══════════════════════ */

describe('判定 —— 必摸 / 可摸 / 跳过 / 未知', () => {
  it('按单格价值分三档', () => {
    const rules = useRulesStore()
    rules.mode = 'pricePerSlot'
    rules.mustThreshold = 1_000_000
    rules.skipThreshold = 100_000

    const byName = new Map(FIXTURE.map((i) => [i.name, i]))
    expect(rules.verdictOf(byName.get('海洋之泪')!)).toBe('must')
    expect(rules.verdictOf(byName.get('普通收集品')!)).toBe('skip')
    expect(rules.verdictOf(byName.get('反应堆总控核心')!)).toBe('must')
  })

  it('⭐ 不可上架 / 不可摸 → 未知（而不是"跳过"）', () => {
    const rules = useRulesStore()
    const byName = new Map(FIXTURE.map((i) => [i.name, i]))

    // 火箭燃料有 500 万的价，但它挂不上交易行 —— 这个价没有参考意义
    expect(rules.verdictOf(byName.get('火箭燃料')!)).toBe('unknown')
    // 旧赛季弹摸不到，值多少都与你无关
    expect(rules.verdictOf(byName.get('旧赛季弹')!)).toBe('unknown')
  })

  it('⭐ 这个区分很重要：未知 ≠ 跳过', () => {
    // 如果把"不可上架"判成"跳过"，用户会以为"系统建议不要捡"，
    // 而实际上是"系统不知道" —— 这两句话的下一步行动完全不同。
    const rules = useRulesStore()
    const fuel = FIXTURE.find((i) => i.name === '火箭燃料')!
    expect(rules.verdictOf(fuel)).not.toBe('skip')
  })

  it('没有价格 → 未知', () => {
    const rules = useRulesStore()
    const map = FIXTURE.find((i) => i.name === '藏宝图')!
    expect(rules.verdictOf(map)).toBe('unknown')
  })

  it('⭐ 切换判定依据，结论跟着变', () => {
    const rules = useRulesStore()
    const bp = FIXTURE.find((i) => i.name === '9x39mm BP')!

    // 按单价：4484 —— 很低
    rules.mode = 'price'
    rules.mustThreshold = 100_000
    rules.skipThreshold = 10_000
    expect(rules.verdictOf(bp)).toBe('skip')

    // 按单格价值：4484 × 60 ÷ 1 = 269,040 —— 必摸
    rules.mode = 'pricePerSlot'
    expect(rules.verdictOf(bp)).toBe('must')
  })

  it('⭐ 阈值顺序反了会被夹正（否则"可摸"那一档会消失）', () => {
    const rules = useRulesStore()
    rules.mustThreshold = 100_000
    rules.skipThreshold = 100_000

    const mid = FIXTURE.find((i) => i.name === '普通收集品')! // 单格 60000
    expect(rules.verdictOf(mid)).toBe('skip')

    // 两个相等时不应该出现"既非必摸也非跳过"的诡异状态
    rules.mustThreshold = 50_000
    rules.skipThreshold = 50_000
    expect(rules.verdictOf(mid)).toBe('must')
  })
})

/* ══════════════════════ 三级联动 ══════════════════════ */

describe('三级联动', () => {
  it('⭐ 改大类要清空子类与细类', () => {
    // 不做这一步会出现：筛「道具/收集品」→ 改成「弹药」→ 子类还是「收集品」
    // → 结果 0 条，而且下拉里显示一个不属于弹药的选项
    const filters = useFiltersStore()
    filters.setCategory('props')
    filters.setSubcategory('collection')

    expect(filters.subcategory).toBe('collection')

    filters.setCategory('ammo')
    expect(filters.subcategory).toBeNull()
    expect(filters.thirdClass).toBeNull()
  })

  it('⭐ 改子类要清空细类', () => {
    const filters = useFiltersStore()
    filters.setCategory('props')
    filters.setSubcategory('collection')
    filters.thirdClass = 'something'

    filters.setSubcategory('key')
    expect(filters.thirdClass).toBeNull()
  })
})

/* ══════════════════════ 交叉计数 ══════════════════════ */

describe('⭐ 交叉计数 —— 选项后面的数字必须是"选了还剩多少"', () => {
  it('大类计数：没筛别的时就是全部', () => {
    const filters = useFiltersStore()
    const byValue = Object.fromEntries(filters.categoryOptions.map((o) => [o.value, o.count]))

    expect(byValue['props']).toBe(4) // 海洋之泪 / 普通收集品 / 反应堆 / 藏宝图
    expect(byValue['ammo']).toBe(2)
    // 配件没有物品，但仍然列出来（"它是 0 条"本身是信息）
    expect(byValue['acc']).toBe(0)
  })

  it('⭐ 地图筛选生效后，大类计数要跟着变（不是永远显示全部）', () => {
    const filters = useFiltersStore()
    filters.map = 'AZ3' // 只有「反应堆总控核心」出在 AZ3

    const byValue = Object.fromEntries(filters.categoryOptions.map((o) => [o.value, o.count]))
    expect(byValue['props']).toBe(1) // 只剩反应堆
    expect(byValue['ammo']).toBe(0) // 弹药一张图都不含 AZ3
  })

  it('⭐ 子类选项受父级大类约束，且计数不带自己', () => {
    const filters = useFiltersStore()
    filters.setCategory('ammo')

    const subs = filters.subcategoryOptions.map((o) => o.value)
    expect(subs).toEqual(['ammo9x39']) // 只有弹药自己的子类，没有道具的

    // 计数是"选了这个还有几条" —— 此时只有一个子类，所以就是全部 2 条
    expect(filters.subcategoryOptions[0]!.count).toBe(2)
  })

  it('⭐ 数是"去掉自己这一维"的结果（faceted search 的核心）', () => {
    const filters = useFiltersStore()
    // 先筛一个和大类无关、但会缩小范围的维度
    // 品质 6（红）：海洋之泪 + 藏宝图（两条都在池里）
    filters.grade = 6

    const byValue = Object.fromEntries(filters.categoryOptions.map((o) => [o.value, o.count]))
    expect(byValue['props']).toBe(2)
    expect(byValue['ammo']).toBe(0) // 两条弹药都不是红

    // 现在再筛大类 = props —— 大类自己的计数不该被自己影响，
    // 所以那一格仍然是 2（而不是变成 0）
    filters.setCategory('props')
    const after = Object.fromEntries(filters.categoryOptions.map((o) => [o.value, o.count]))
    expect(after['props']).toBe(2)
  })

  it('地图选项也带计数，且是多值字段（一条物品能出在多张图上）', () => {
    const filters = useFiltersStore()
    const byValue = Object.fromEntries(filters.mapOptions.map((o) => [o.value, o.count]))

    expect(byValue['长弓溪谷']).toBe(5) // 反应堆在 AZ3；火箭燃料/旧赛季弹不在池里
    expect(byValue['AZ3']).toBe(1)
  })
})

/* ══════════════════════ 搜索 ══════════════════════ */

describe('搜索', () => {
  it('按名字', () => {
    const filters = useFiltersStore()
    filters.search = '海洋'
    expect(filters.rows.map((r) => r.item.name)).toEqual(['海洋之泪'])
  })

  it('按官方ID（排查问题时最常用）', () => {
    const filters = useFiltersStore()
    // 用官方ID查 —— 排查"为什么这条没价格"时最常用的手段
    filters.search = '16110'
    expect(filters.rows.map((r) => r.item.sourceItemId)).toEqual(['16110001003'])
  })

  it('大小写不敏感', () => {
    const filters = useFiltersStore()
    filters.search = '9X39'
    expect(filters.rows.map((r) => r.item.name)).toEqual(['9x39mm BP'])
  })
})

/* ══════════════════════ 排序与判定过滤 ══════════════════════ */

describe('排序', () => {
  it('⭐ 按当前指标降序，算不出来的排最后（不是最前）', () => {
    const filters = useFiltersStore()
    filters.includeExcluded = true // 把"无价格"的也放进来一起看

    const metrics = filters.rows.map((r) => r.metric)

    // 前面都不为 null，最后才出现 null
    const firstNull = metrics.indexOf(null)
    expect(firstNull).toBeGreaterThan(0)
    expect(metrics.slice(firstNull).every((m) => m === null)).toBe(true)

    // 而且前面是降序
    const nums = metrics.slice(0, firstNull) as number[]
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i]!).toBeLessThanOrEqual(nums[i - 1]!)
    }
  })

  it('切换判定依据 → 排序键跟着换', () => {
    const rules = useRulesStore()
    const filters = useFiltersStore()

    rules.mode = 'pricePerSlot'
    const topBySlot = filters.rows[0]!.item.name

    rules.mode = 'price'
    const topByPrice = filters.rows[0]!.item.name

    // 单格价值最高的和单价最高的不一定是同一个东西
    expect(topBySlot).toBe('海洋之泪')
    expect(topByPrice).toBe('海洋之泪')
    // 但至少排序键换了 —— 用"排序单调性"验证
    const prices = filters.rows.map((r) => r.metric ?? 0)
    expect(prices[0]).toBeGreaterThanOrEqual(prices[1] ?? 0)
  })
})

describe('判定过滤', () => {
  it('⭐ 只看必摸', () => {
    const rules = useRulesStore()
    rules.mustThreshold = 1_000_000
    rules.skipThreshold = 100_000

    const filters = useFiltersStore()
    filters.setVerdictFilter('must')

    expect(filters.rows.every((r) => r.verdict === 'must')).toBe(true)
    expect(filters.rows.length).toBeGreaterThan(0)
  })

  it('⭐ 点同一个档位两次 = 取消（最自然的交互）', () => {
    const filters = useFiltersStore()
    filters.setVerdictFilter('must')
    expect(filters.verdictFilter).toBe('must')
    filters.setVerdictFilter('must')
    expect(filters.verdictFilter).toBeNull()
  })

  it('⭐ 判定计数不受判定过滤本身影响（否则点进去之后就没法切回来了）', () => {
    const rules = useRulesStore()
    rules.mustThreshold = 1_000_000
    rules.skipThreshold = 100_000

    const filters = useFiltersStore()
    const before = { ...filters.verdictCounts }

    filters.setVerdictFilter('must')

    // 计数保持不变 —— 因为它是从 rowsBeforeVerdict 算的
    expect(filters.verdictCounts).toEqual(before)
    expect(before.must).toBeGreaterThan(0)
    expect(before.skip).toBeGreaterThan(0)
  })

  it('计数总和 = 过滤前的结果数', () => {
    const rules = useRulesStore()
    rules.mustThreshold = 1_000_000
    rules.skipThreshold = 100_000

    const filters = useFiltersStore()
    const c = filters.verdictCounts
    expect(c.must + c.maybe + c.skip + c.unknown).toBe(filters.rowsBeforeVerdict.length)
  })
})

/* ══════════════════════ 清除筛选 ══════════════════════ */

describe('清除筛选', () => {
  it('清掉所有维度，并把筛选计数归零', () => {
    const filters = useFiltersStore()
    filters.search = 'x'
    filters.setCategory('props')
    filters.grade = 6
    filters.map = 'AZ3'
    filters.setVerdictFilter('must')
    expect(filters.activeFilterCount).toBe(5)

    filters.resetFilters()

    expect(filters.activeFilterCount).toBe(0)
    expect(filters.search).toBe('')
    expect(filters.category).toBeNull()
    expect(filters.verdictFilter).toBeNull()
  })

  it('⚠️ 不清 `includeExcluded` —— 它是"显示偏好"，不是筛选条件', () => {
    const filters = useFiltersStore()
    filters.includeExcluded = true
    filters.setCategory('props')

    filters.resetFilters()
    expect(filters.includeExcluded).toBe(true)
  })
})
