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
import { nextTick } from 'vue'
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
    provenanceUniversal: over.provenanceUniversal ?? false,
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
  // ⭐ 刻意设成「通用物资」：每张图都能刷到。fixture 里只有两张图，
  //    所以它的 provenanceMaps 就是这两张 —— 对应真实数据里 1297 条「全地图」。
  makeItem({
    sourceItemId: '15200000111',
    name: '普通收集品',
    price: 60_000,
    grade: 3,
    gradeCn: '蓝',
    gradeTone: 'blue',
    gradeColor: '#658bce',
    provenanceMaps: ['长弓溪谷', 'AZ3'],
    provenanceUniversal: true,
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
  // 枪械（品质 0 = 「灰」）。实测 68 条枪械**全部**是品质 0，
  // 所以 fixture 里也要有一条 —— 这是真实存在的边界。
  makeItem({
    sourceItemId: '13440000002',
    name: 'M4A1突击步枪',
    categoryCode: 'gun',
    categoryCn: '枪械',
    subcategory: 'rifle',
    subcategoryCn: '步枪',
    price: 120_000,
    grade: 0,
    gradeCn: '灰',
    gradeTone: 'gray',
    gradeColor: '#949595',
  }),
  // 不可上架（有价但挂不上交易行）
  makeItem({ sourceItemId: '15200000999', name: '火箭燃料', listable: false, price: 5_000_000 }),
  // 不可摸（限时下架）
  makeItem({ sourceItemId: '37280100001', name: '旧赛季弹', availability: 'expired', price: 3_000_000 }),
  // 没有价格（名字对上了但源说是非卖品）
  makeItem({ sourceItemId: '15200000228', name: '藏宝图', price: null, pricePerSlot: null }),
]


/**
 * 装一个内存版 localStorage。
 *
 * ⚠️ vitest 默认的 node 环境**没有** localStorage，而 `loadFilters()` 会读它。
 *   所以这个桩必须**每个用例都装一次新的空版本** —— 否则上一个用例存进去的
 *   筛选会被下一个用例读出来，测试之间就不独立了。
 *
 *   实测踩到：持久化那几个用例装了桩之后，后面的用例 `loadFilters()`
 *   读到了上一次保存的 `categories: ['props','ammo']`，
 *   于是"点两次取消"的用例一开始就有两个大类 —— 症状是
 *   `expected [ 'ammo' ] to deeply equal [ 'props' ]`，看着完全不知所云。
 */
function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  })
  return store
}

beforeEach(() => {
  // 每个用例一套全新的 Pinia —— 否则上一个用例改的筛选会漏到下一个
  setActivePinia(createPinia())
  // localStorage 也要重置：`loadFilters()` 会读它，不重置就会跨用例串
  installLocalStorage()

  const items = useItemsStore()
  items.items = FIXTURE

  // categoryOptions 以后端的完整大类清单为基准，所以也要给它数据
  const meta = useMetaStore()
  meta.categories = [
    { value: 'props', label: '道具', count: 0 },
    { value: 'ammo', label: '弹药', count: 0 },
    { value: 'acc', label: '配件', count: 0 },
    { value: 'gun', label: '枪械', count: 0 },
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

describe('⭐ 分组与子类的联动', () => {
  it('⭐ 切分组会清空子类选择', () => {
    /**
     * 子类选项是"当前选中分组的下一级"，换了分组之后原来的子类可能
     * 根本不存在了（从「消耗品」切到「弹药」，「药品」这个子类就没了）。
     * 留着它会得到 0 条且看不出原因。
     */
    const filters = useFiltersStore()
    filters.groups = ['collection']
    filters.subs = ['x']

    filters.toggleGroup('ammo')
    expect(filters.subs).toEqual([])
  })

  it('点同一个分组两次 = 取消', () => {
    const filters = useFiltersStore()
    filters.toggleGroup('collection')
    expect(filters.groups).toEqual(['collection'])
    filters.toggleGroup('collection')
    expect(filters.groups).toEqual([])
  })

  it('「全部」清空分组与子类', () => {
    const filters = useFiltersStore()
    filters.groups = ['collection']
    filters.subs = ['x']
    filters.clearGroups()
    expect(filters.groups).toEqual([])
    expect(filters.subs).toEqual([])
  })
})

describe('⭐ 交叉计数 —— 选项后面的数字必须是"选了还剩多少"', () => {
  it('分组计数：没筛别的时就是池里的数', () => {
    const filters = useFiltersStore()
    const byValue = Object.fromEntries(filters.groupOptions.map((o) => [o.value, o.count]))

    // 收集品：海洋之泪 + 普通收集品 + 藏宝图（火箭燃料/旧赛季弹不在池里）
    expect(byValue['collection']).toBe(3)
    expect(byValue['key']).toBe(1) // 反应堆总控核心
    expect(byValue['ammo']).toBe(2)
    expect(byValue['gun']).toBe(1)
    // 没有物品的分组仍然列出来（"它是 0 条"本身是信息）
    expect(byValue['acc']).toBe(0)
  })

  it('⭐ 地图筛选生效后，分组计数要跟着变（不是永远显示全部）', () => {
    const filters = useFiltersStore()
    filters.maps = ['AZ3'] // 出在 AZ3 的：反应堆（key）+ 普通收集品（通用）

    const byValue = Object.fromEntries(filters.groupOptions.map((o) => [o.value, o.count]))
    expect(byValue['key']).toBe(1)
    expect(byValue['collection']).toBe(1) // 只剩普通收集品
    expect(byValue['ammo']).toBe(0)
  })

  it('⭐ 分组自己的计数不随自己这一维变化（faceted search 的核心）', () => {
    const filters = useFiltersStore()
    filters.grades = [6] // 红：海洋之泪 + 藏宝图（+ 火箭燃料/旧赛季弹不在池里）

    const byValue = Object.fromEntries(filters.groupOptions.map((o) => [o.value, o.count]))
    expect(byValue['collection']).toBe(2)
    expect(byValue['ammo']).toBe(0)

    // 再筛 collection —— 它自己的计数不该被自己影响（不是变成 0）
    filters.groups = ['collection']
    const after = Object.fromEntries(filters.groupOptions.map((o) => [o.value, o.count]))
    expect(after['collection']).toBe(2)
  })

  it('地图选项也带计数，且是多值字段（一条物品能出在多张图上）', () => {
    const filters = useFiltersStore()
    const byValue = Object.fromEntries(filters.mapOptions.map((o) => [o.value, o.count]))

    expect(byValue['长弓溪谷']).toBe(6)
    expect(byValue['AZ3']).toBe(2) // 反应堆 + 通用物资
  })
})

/* ══════════ ⭐ 子类：每个已选分组一行 ══════════ */

/**
 * 用户提的方案（实测确认可行）：每选一个大类，就在它下方加一行它的子类。
 *
 * 之前把「道具」和「弹药」都选上时，子类清单是两者的并集
 * （收集品/钥匙/消耗品 + 19 个弹药口径），混在一起分不清谁属于谁。
 * 分行之后归属关系是**结构性**的。
 */
describe('⭐ 子类行（每个已选分组一行）', () => {
  it('⭐ 只给"已选中且真的有下一级"的分组出行', () => {
    const filters = useFiltersStore()

    // 没选任何分组 → 一行都没有
    expect(filters.subOptionsByGroup).toEqual([])

    // 选「收集品」→ 实测它没有细类（349 条全是 null）→ 不该出现空行
    filters.groups = ['collection']
    expect(filters.subOptionsByGroup).toEqual([])

    // 选「弹药」→ 它有一个子类 ammo9x39 → 出现一行
    filters.groups = ['ammo']
    expect(filters.subOptionsByGroup.map((r) => r.group)).toEqual(['ammo'])
    expect(filters.subOptionsByGroup[0]!.options.map((o) => o.value)).toEqual(['ammo9x39'])
  })

  it('⭐ 多个分组 → 每个一行，且顺序与分组标签一致', () => {
    const filters = useFiltersStore()
    filters.groups = ['gun', 'ammo']

    const rows = filters.subOptionsByGroup.map((r) => r.group)
    // 顺序跟 groupOptions（界面显示顺序）走，不是跟选择顺序走
    expect(rows).toEqual(['ammo', 'gun'])
  })

  it('子类的计数是"选了这个还有几条"（不带自己这一维）', () => {
    const filters = useFiltersStore()
    filters.groups = ['ammo']
    // 两条弹药都是 ammo9x39，且没有其它筛选 → 计数 2
    expect(filters.subOptionsByGroup[0]!.options[0]!.count).toBe(2)
  })

  it('⭐ 每行的「全部」只清自己那一行，不动别的行', () => {
    const filters = useFiltersStore()
    filters.groups = ['ammo', 'gun']
    filters.subs = ['ammo9x39', 'rifle']

    // 清「弹药」那一行
    filters.clearSubsOf('ammo')
    expect(filters.subs).toEqual(['rifle']) // 枪械那行的还在

    // 清「枪械」那一行
    filters.clearSubsOf('gun')
    expect(filters.subs).toEqual([])
  })

  it('子类筛选生效（AND 语义：分组内再挑一层）', () => {
    const filters = useFiltersStore()
    filters.groups = ['ammo']
    const all = filters.rows.length

    filters.subs = ['ammo9x39']
    expect(filters.rows.length).toBe(all)

    filters.subs = ['不存在的子类']
    expect(filters.rows.length).toBe(0)
  })

  it('子类行可收起（把空间让给表格）', () => {
    const filters = useFiltersStore()
    // 默认展开 —— 否则用户发现不了它能筛子类
    expect(filters.subsExpanded).toBe(true)
  })
})

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
  it('⭐ 已判定的按指标降序，未判定的恒排最后', () => {
    const filters = useFiltersStore()
    filters.includeExcluded = true // 把"不可上架/不可摸/无价格"的也放进来

    const rows = filters.rows
    const known = rows.filter((r) => r.verdict !== 'unknown')
    const unknown = rows.filter((r) => r.verdict === 'unknown')

    // 两种都存在（否则这个测试没意义）
    expect(known.length).toBeGreaterThan(1)
    expect(unknown.length).toBeGreaterThan(0)

    // 已判定在前、未判定在后（按数组顺序，不是按 metric 大小）
    expect(rows.indexOf(unknown[0]!)).toBeGreaterThan(rows.indexOf(known[known.length - 1]!))

    // 已判定那部分指标是降序的
    const nums = known.map((r) => r.metric).filter((m): m is number => m !== null)
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i]!).toBeLessThanOrEqual(nums[i - 1]!)
    }
  })

  it('⭐ 未判定恒排最后 —— 即使它的数字更大也不行', () => {
    /**
     * 这条是真正的痛点：火箭燃料有 500 万的价，但它**挂不上交易行**，
     * 那个价格你根本拿不到。按 pricePerSlot 降序时它会理直气壮地排到
     * 榜单最前面，而结论完全错 —— 数字看着对，最危险的那种错。
     */
    const filters = useFiltersStore()
    filters.includeExcluded = true

    const fuelIndex = filters.rows.findIndex((r) => r.item.name === '火箭燃料')
    const fuel = filters.rows[fuelIndex]!

    expect(fuel.verdict).toBe('unknown')
    expect(fuel.metric).toBe(5_000_000) // 它确实有很高的价
    // 但依然在所有已判定行之后
    const lastKnown = filters.rows.map((r) => r.verdict !== 'unknown').lastIndexOf(true)
    expect(fuelIndex).toBeGreaterThan(lastKnown)
  })

  it('⭐ 排序排的是**全量**，不是当前页（分页 bug 的回归测试）', () => {
    /**
     * 这一条钉死"表头排序只排当前页"那个 bug。
     *
     * 原来的实现是 `el-table` 的 `sortable`（客户端排序）——
     * 它只排 `:data` 里的行，而分页后 `:data` 只有当前页。
     * 于是点"单价"排序时，第 2 页的东西根本不会因为
     * 比第 1 页大而浮上来。
     *
     * 现在排序在 store 里对**筛选后的全部行**做，所以：
     * 排完之后如果我按"页大小"切片，第二页第一条 <= 第一页最后一条。
     */
    const filters = useFiltersStore()
    filters.sortKey = 'pricePerSlot'
    filters.sortDir = 'desc'

    const all = filters.rows
    const PAGE_SIZE = 2
    const page1 = all.slice(0, PAGE_SIZE)
    const page2 = all.slice(PAGE_SIZE, PAGE_SIZE * 2)

    expect(page1).toHaveLength(2)
    expect(page2.length).toBeGreaterThan(0)

    const lastOfPage1 = page1[page1.length - 1]!.metric ?? -Infinity
    const firstOfPage2 = page2[0]!.metric ?? -Infinity
    expect(firstOfPage2).toBeLessThanOrEqual(lastOfPage1)

    // 而且第一页第一名必须是全局最大（已判定部分）
    const globalMax = Math.max(
      ...all.filter((r) => r.metric !== null).map((r) => r.metric as number),
    )
    expect(page1[0]!.metric).toBe(globalMax)
  })

  it('升序 / 降序都能用，且 null 不因为升序就翻到最前', () => {
    const filters = useFiltersStore()
    filters.includeExcluded = true

    filters.sortKey = 'pricePerSlot'
    filters.sortDir = 'asc'
    // 第一行不应该是 null（null 的语义是"算不出来"，放最前会被误读成"最便宜"）
    expect(filters.rows[0]!.metric).not.toBeNull()

    const nums = filters.rows
      .filter((r) => r.verdict !== 'unknown' && r.metric !== null)
      .map((r) => r.metric as number)
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i]!).toBeGreaterThanOrEqual(nums[i - 1]!)
    }
  })

  it('按名称排序（中文）', () => {
    const filters = useFiltersStore()
    filters.sortKey = 'name'
    filters.sortDir = 'asc'

    const names = filters.rows.filter((r) => r.verdict !== 'unknown').map((r) => r.item.name)
    expect(names.length).toBeGreaterThan(1)
    // 只需确认它是排过序的（中文排序规则依赖 ICU，不写死具体顺序）
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    expect(names).toEqual(sorted)
  })

  it('applySortChange —— 表头事件写回 store', () => {
    const filters = useFiltersStore()

    filters.applySortChange({ prop: 'todayChangePct', order: 'descending' })
    expect(filters.sortKey).toBe('todayChangePct')
    expect(filters.sortDir).toBe('desc')

    filters.applySortChange({ prop: 'slots', order: 'ascending' })
    expect(filters.sortKey).toBe('slots')
    expect(filters.sortDir).toBe('asc')

    // 第三下会传 order=null（Element Plus 的三态循环）→ 回到默认
    filters.applySortChange({ prop: null, order: null })
    expect(filters.sortKey).toBe('pricePerSlot')
    expect(filters.sortDir).toBe('desc')
  })

  it('切换判定依据 → 价格类排序键跟着换（避免"按 A 排、按 B 判"）', async () => {
    const rules = useRulesStore()
    const filters = useFiltersStore()

    rules.mode = 'pricePerSlot'
    await nextTick() // ⚠️ Vue 的 watch 默认是**异步**的（下一个 tick 才跑）
    expect(filters.sortKey).toBe('pricePerSlot')

    rules.mode = 'price'
    await nextTick()
    expect(filters.sortKey).toBe('price')

    rules.mode = 'pricePerSlot'
    await nextTick()
    expect(filters.sortKey).toBe('pricePerSlot')
  })

  it('⭐ 用户已手动选了非价格列时，切判定依据不插手排序', async () => {
    const rules = useRulesStore()
    const filters = useFiltersStore()

    filters.applySortChange({ prop: 'slots', order: 'descending' })
    rules.mode = 'price'
    await nextTick()

    expect(filters.sortKey).toBe('slots') // 没被改掉
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
    filters.groups = ['collection']
    filters.grades = [6]
    filters.maps = ['AZ3']
    filters.setVerdictFilter('must')
    expect(filters.activeFilterCount).toBe(5)

    filters.resetFilters()

    expect(filters.activeFilterCount).toBe(0)
    expect(filters.search).toBe('')
    expect(filters.groups).toEqual([])
    expect(filters.verdictFilter).toBeNull()
  })

  it('⚠️ 不清 `includeExcluded` —— 它是"显示偏好"，不是筛选条件', () => {
    const filters = useFiltersStore()
    filters.includeExcluded = true
    filters.groups = ['collection']

    filters.resetFilters()
    expect(filters.includeExcluded).toBe(true)
  })
})

/* ══════════════════ ⭐ 只看该图专属（mapOnly） ══════════════════ */

/**
 * 这一组对着一个实测出来的事实：
 *
 *   1564 条物品里 **1297 条标注是「全地图」** —— 每张图都能刷到。
 *   所以只选地图的话，六张图各约 1300 条，跟没筛差不了多少。
 *   加上这个开关，选长弓溪谷就只剩十几条**地图特产**。
 */
describe('⭐ 只看该图专属（mapOnly）', () => {
  it('没选地图时开关不起作用（它本来就没有意义）', () => {
    const filters = useFiltersStore()
    filters.mapOnly = true
    // 没选地图 → 结果与不开开关一致
    expect(filters.rows.length).toBe(useFiltersStore().rowsBeforeVerdict.length)
    expect(filters.rows.some((r) => r.item.provenanceUniversal)).toBe(true)
  })

  it('⭐ 选地图 + 开开关 → 通用物资被排掉', () => {
    const filters = useFiltersStore()
    filters.maps = ['AZ3']

    const withUniversal = filters.rows.length
    expect(filters.rows.some((r) => r.item.provenanceUniversal)).toBe(true)

    filters.mapOnly = true
    const withoutUniversal = filters.rows.length

    expect(filters.rows.some((r) => r.item.provenanceUniversal)).toBe(false)
    expect(withoutUniversal).toBeLessThan(withUniversal)
    // 差的就是那一条通用物资
    expect(withUniversal - withoutUniversal).toBe(1)
  })

  it('关掉开关 → 通用物资回来', () => {
    const filters = useFiltersStore()
    filters.maps = ['AZ3']
    filters.mapOnly = true
    const only = filters.rows.length

    filters.mapOnly = false
    expect(filters.rows.length).toBeGreaterThan(only)
  })

  it('⭐ 开关算作筛选条件（"清除筛选"要能清掉它）', () => {
    const filters = useFiltersStore()
    filters.maps = ['AZ3']
    filters.mapOnly = true
    expect(filters.activeFilterCount).toBe(2)

    filters.resetFilters()
    expect(filters.mapOnly).toBe(false)
    expect(filters.activeFilterCount).toBe(0)
  })

  it('⚠️ 记录一个已知行为：选地图后"待补"的物品也会被隐藏', () => {
    /**
     * `matchMap` 的规则是 `provenanceMaps.includes(地图)` —— 而"待补"的
     * 物品 `provenanceMaps` 是 `null`，所以**选地图时它会被挡住**。
     *
     * 这是刻意的：选地图的语义是"只看**已确认**会在这张图刷出的物资"，
     * 我们不知道的就不该混进来充数。
     *
     * 但它是个容易被误解的行为（"没标注不等于不会出"），
     * 所以这里把规则钉住，并且在界面上的地图下拉里写明这一点。
     */
    const filters = useFiltersStore()
    filters.maps = ['长弓溪谷']

    const map = FIXTURE.find((i) => i.name === '藏宝图')!
    expect(map.provenanceMaps).toEqual(['长弓溪谷']) // fixture 里这条是有数据的

    // 造一条"待补"的（provenanceMaps = null）来验证规则
    const items = useItemsStore()
    items.items = [
      ...FIXTURE,
      // ⚠️ 必须显式传 null —— makeItem 的默认出产地就是 ['长弓溪谷']
      makeItem({ sourceItemId: '9999', name: '无出产地物品', provenanceMaps: null }),
    ]
    expect(filters.rows.some((r) => r.item.name === '无出产地物品')).toBe(false)
  })
})

/* ══════════════════ 筛选持久化 ══════════════════ */

/**
 * 筛选状态存 localStorage。
 *
 * ⚠️ 与 localStorage 打交道有两类坑，都要测：
 *   ① **读进来的东西不可信** —— 可能是旧版本写的、被手改过、别的网站同源留下的
 *   ② **localStorage 本身可能抛异常**（隐私模式、配额满）
 */
describe('筛选持久化（localStorage）', () => {
  // ⚠️ 版本号要跟着 store 里走 —— 这一版筛选结构从 category/subcategory
  // 变成了 group/subs，所以键从 v1 换成了 v2（旧数据读进来会是错的）
  const KEY = 'deltaforce.filters.v2'

  it('⭐ 存过的筛选会被读回来', () => {
    installLocalStorage({
      [KEY]: JSON.stringify({
        search: '海洋',
        groups: ['collection'],
        subs: [],
        
        grades: [6],
        maps: ['AZ3'],
        verdictFilter: 'must',
        includeExcluded: true,
        mapOnly: true,
        sortKey: 'todayChangePct',
        sortDir: 'asc',
      }),
    })

    setActivePinia(createPinia())
    useItemsStore().items = FIXTURE
    const filters = useFiltersStore()

    expect(filters.search).toBe('海洋')
    expect(filters.groups).toEqual(['collection'])
    expect(filters.grades).toEqual([6])
    expect(filters.maps).toEqual(['AZ3'])
    expect(filters.verdictFilter).toBe('must')
    expect(filters.includeExcluded).toBe(true)
    expect(filters.mapOnly).toBe(true)
    expect(filters.sortKey).toBe('todayChangePct')
    expect(filters.sortDir).toBe('asc')
  })

  it('⭐ 非法内容一律回退默认，而且不抛异常', () => {
    installLocalStorage({
      [KEY]: JSON.stringify({
        search: 12345, // 应该是字符串
        groups: 'collection', // 应该是数组
        grades: ['gold'], // 应该是 0~6 的整数数组
        verdictFilter: 'nonsense', // 不在四个枚举里
        mapOnly: 'yes', // 应该是布尔
        sortKey: 'hack', // 不在允许的列里
        sortDir: 'sideways',
      }),
    })

    setActivePinia(createPinia())
    useItemsStore().items = FIXTURE

    const filters = useFiltersStore()
    expect(filters.search).toBe('')
    expect(filters.groups).toEqual([])
    expect(filters.grades).toEqual([])
    expect(filters.verdictFilter).toBeNull()
    expect(filters.mapOnly).toBe(false)
    expect(filters.sortKey).toBe('pricePerSlot')
    expect(filters.sortDir).toBe('desc')
  })

  it('内容根本不是 JSON → 回退默认', () => {
    installLocalStorage({ [KEY]: '{这不是 JSON' })
    setActivePinia(createPinia())
    useItemsStore().items = FIXTURE
    expect(useFiltersStore().sortKey).toBe('pricePerSlot')
  })

  it('⭐ localStorage 直接抛异常 → 页面不崩，用默认值', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('隐私模式下不允许访问')
        },
        setItem: () => {
          throw new Error('配额满')
        },
      },
    })

    setActivePinia(createPinia())
    useItemsStore().items = FIXTURE
    expect(() => useFiltersStore()).not.toThrow()
  })

  it('⭐ 改筛选会自动存盘（刷新后还在）', async () => {
    const store = installLocalStorage()
    setActivePinia(createPinia())
    useItemsStore().items = FIXTURE

    const filters = useFiltersStore()
    filters.toggleGroup('ammo')
    filters.maps = ['AZ3']
    await nextTick() // watch 默认异步

    const saved = JSON.parse(store.get(KEY)!) as Record<string, unknown>
    expect(saved['groups']).toEqual(['ammo'])
    expect(saved['maps']).toEqual(['AZ3'])
  })

  it('⭐ grade 是数组：0 与 6 合法，越界与小数被丢掉', () => {
    installLocalStorage({ [KEY]: JSON.stringify({ grades: [0, 6, 9, 3.5] }) })
    setActivePinia(createPinia())
    useItemsStore().items = FIXTURE
    // 9 与 3.5 不是合法品质，应在读取时被过滤掉；0 与 6 保留
    expect(useFiltersStore().grades).toEqual([0, 6])
  })

  it('⭐ groups 不是数组时回退空数组（localStorage 内容不可信）', () => {
    installLocalStorage({ [KEY]: JSON.stringify({ groups: 'collection' }) })
    setActivePinia(createPinia())
    useItemsStore().items = FIXTURE
    expect(useFiltersStore().groups).toEqual([])
  })
})

/* ══════════════════ ⭐ 多选筛选（同维 OR、跨维 AND） ══════════════════ */

/**
 * 这一组对应用户的原话：
 * 「我可能有的时候只想看收藏品，这是可以的，但是我如果想看收藏品和消耗品呢，
 *   如果这个时候我也想看看枪的价格呢，我觉得这就无法满足的」
 *
 * 所以大类/品质/地图从单选改成多选。语义必须钉死：
 *   · **同一维内是 OR** —— 选了道具和弹药，就是"道具**或**弹药"
 *   · **不同维之间是 AND** —— 再加品质=金，就是"（道具或弹药）**且**金"
 * 这是所有人的预期读法，也是 faceted search 的标准。
 */
describe('⭐ 多选筛选', () => {
  it('大类多选：道具 + 弹药 是并集', () => {
    const filters = useFiltersStore()

    filters.groups = ['collection']
    const onlyProps = filters.rows.length

    filters.groups = ['ammo']
    const onlyAmmo = filters.rows.length

    filters.groups = ['collection', 'ammo']
    expect(filters.rows.length).toBe(onlyProps + onlyAmmo)
  })

  it('⭐ 跨维是 AND：大类或 + 品质限定', () => {
    const filters = useFiltersStore()
    filters.groups = ['collection', 'ammo']
    const both = filters.rows.length

    filters.grades = [6] // 红
    const narrowed = filters.rows.length

    expect(narrowed).toBeLessThan(both)
    expect(
      filters.rows.every((r) => r.item.grade === 6 && ['props', 'ammo'].includes(r.item.categoryCode)),
    ).toBe(true)
  })

  it('品质多选也是 OR', () => {
    const filters = useFiltersStore()
    // ⚠️ 数的时候要**排掉品质 0 的**（枪械）—— 按新规则它不受品质筛选影响，
    //    所以在每一档里都会出现；直接比总数会多算一次。
    const countNonZero = () => filters.rows.filter((r) => r.item.grade !== 0).length

    filters.grades = [6]
    const reds = countNonZero()
    filters.grades = [2]
    const greens = countNonZero()

    filters.grades = [6, 2]
    expect(countNonZero()).toBe(reds + greens)

    // 而品质 0 的（枪械）**不该**出现在这里 —— 见下面「品质 0」那一组，
    // 这是用户明确要求的：单看某个品质时，无品质的东西不该占位
    expect(filters.rows.some((r) => r.item.grade === 0)).toBe(false)
  })

  it('地图多选：任意一张命中即算', () => {
    const filters = useFiltersStore()
    filters.maps = ['AZ3']
    const az3 = filters.rows.map((r) => r.item.name)

    filters.maps = ['长弓溪谷']
    const lg = filters.rows.map((r) => r.item.name)

    filters.maps = ['AZ3', '长弓溪谷']
    const union = filters.rows.map((r) => r.item.name)

    expect(new Set(union)).toEqual(new Set([...az3, ...lg]))
  })

  it('⭐ 点同一个标签两次 = 取消（标签的天然交互）', () => {
    const filters = useFiltersStore()

    filters.toggleGroup('collection')
    expect(filters.groups).toEqual(['collection'])

    filters.toggleGroup('collection')
    expect(filters.groups).toEqual([])
  })

  it('⚠️ 每次改大类都清空子类与细类（防止出现不存在的组合）', () => {
    const filters = useFiltersStore()
    filters.toggleGroup('collection')
    filters.groups = ['collection']
    filters.subs = ['x']

    // 再加一个大类 —— 子类里那个「收集品」只属于道具，
    // 留着会让"（道具或弹药）且收集品"看起来像是用户想要的，而其实不是
    filters.toggleGroup('ammo')
    expect(filters.subs).toEqual([])
    expect(filters.subs).toEqual([])
  })

  it('「全部」标签清空该维（含下级）', () => {
    const filters = useFiltersStore()
    filters.groups = ['collection']
    filters.groups = ['collection']

    filters.clearGroups()
    expect(filters.groups).toEqual([])
    expect(filters.subs).toEqual([])
  })

  it('⭐ 多选时交叉计数不随自己这一维的已选状态变化', () => {
    /**
     * 这是 faceted search 的关键性质，也是唯一不骗人的算法：
     * 标签上的数字是「选中它、且满足其它维度」的物品数。
     *
     * 如果它随自己的选择变化，会出现：选了「道具」之后「弹药」显示 0
     * —— 你会以为弹药没东西，而其实只是被自己的选择排除了。
     */
    const filters = useFiltersStore()

    const before = Object.fromEntries(filters.groupOptions.map((o) => [o.value, o.count]))
    filters.groups = ['collection']
    const after = Object.fromEntries(filters.groupOptions.map((o) => [o.value, o.count]))

    expect(after['props']).toBe(before['props'])
    expect(after['ammo']).toBe(before['ammo'])
  })

  it('级联清空走 store 动作（所以能测到）—— 切分组要清子类', () => {
    // ⚠️ 这个级联必须在 store 里，不能写在组件的 @change 里 ——
    //    写在模板里虽然也能跑，但测试碰不到它（模板逻辑没法单测），
    //    而"改上级要清下级"正是最容易忘、忘了就静默出错的那类规则。
    const filters = useFiltersStore()
    filters.groups = ['collection']
    filters.subs = ['x']

    filters.toggleGroup('ammo')
    expect(filters.subs).toEqual([])
    expect(filters.groups).toEqual(['collection', 'ammo'])
  })
})


/* ══════════ ⭐ 品质 0（「灰」）不是品质 —— 有条件豁免 ══════════ */

/**
 * 这一组来自用户**两次**反馈，第一次我做宽了：
 *
 *   第一次：「大类选择枪械就不要再添加一个灰色的品质选项了，
 *           当选择枪械大类时自动选择所有枪械就可以了」
 *   → 我实现成"品质 0 永远不受品质筛选"
 *
 *   第二次：「存在bug，在只选择单一品质时，枪械这种无品质的物品也会占位」
 *   → 说明豁免必须**只在显式选了枪械时生效**
 *
 * 实测依据：品质 0 共 68 条，**全是枪械**（枪械没有品质等级），
 * 与「枪械」分组是 1:1 —— 它是"缺失值"，不是"某个品质"。
 */
describe('⭐ 品质 0（灰）不是品质 —— 有条件豁免', () => {
  it('没筛品质时，枪械照常显示', () => {
    const filters = useFiltersStore()
    expect(filters.rows.some((r) => r.item.grade === 0)).toBe(true)
  })

  it('⭐ 只筛品质（没选枪械）→ 枪械**被排掉**（这是用户报的 bug）', () => {
    const filters = useFiltersStore()
    filters.grades = [5] // 金
    expect(filters.rows.some((r) => r.item.grade === 0)).toBe(false)
  })

  it('⭐ 显式选了「枪械」→ 不受品质筛选影响，全部枪械都在', () => {
    const filters = useFiltersStore()
    filters.groups = ['gun']
    filters.grades = [5] // 一个残留的品质筛选

    const guns = filters.rows.filter((r) => r.item.categoryCode === 'gun')
    expect(guns.length).toBeGreaterThan(0)
    // 而且每一个都是品质 0（枪械没有品质）—— 它们是被豁免进来的
    expect(guns.every((r) => r.item.grade === 0)).toBe(true)
  })

  it('⭐ 综合场景：收藏品(金) + 全部枪械', () => {
    const filters = useFiltersStore()
    filters.groups = ['collection', 'gun']
    filters.grades = [5]

    const guns = filters.rows.filter((r) => r.item.categoryCode === 'gun')
    expect(guns.length).toBeGreaterThan(0)
    // 收集品那边则严格按品质筛
    const collections = filters.rows.filter((r) => r.item.categoryCode === 'props')
    expect(collections.every((r) => r.item.grade === 5)).toBe(true)
  })

  it('⭐ 品质选项里不列「灰」（它与「枪械」是 1:1，纯属多余）', () => {
    const filters = useFiltersStore()
    expect(filters.gradeOptions.map((o) => o.value)).not.toContain('0')
    expect(filters.gradeOptions.map((o) => o.value)).toContain('5')
  })

  it('想只看枪械 → 用分组，不用品质', () => {
    const filters = useFiltersStore()
    filters.groups = ['gun']
    expect(filters.rows.length).toBeGreaterThan(0)
    expect(filters.rows.every((r) => r.item.categoryCode === 'gun')).toBe(true)
  })
})
