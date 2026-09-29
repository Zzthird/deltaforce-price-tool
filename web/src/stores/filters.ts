/**
 * 筛选状态 + 派生出来的表格行。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么筛选状态也放 store
 * ═══════════════════════════════════════════════════════════════════════
 * 因为它是**跨组件共享**的：FilterBar 改它，ItemsTable 读它，
 * ThresholdSlider 也要读它（"当前筛选下必摸有几条"）。
 * 三个组件共用一个状态，就是 store 的典型场景。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⭐ 交叉计数（faceted counts）—— 这一版最细的一块
 * ═══════════════════════════════════════════════════════════════════════
 * 下拉选项后面要显示条数。这个条数必须是**"我选了这个之后还剩多少"**，
 * 而不是"这个选项一共有多少"。否则会出现这种坑：
 *
 *   已经筛了「长弓溪谷 + 弹药」，下拉里却显示「道具 (711)」——
 *   你点进去，结果 0 条。因为那 711 是在**没有地图筛选时**数的。
 *
 * 正确做法叫 faceted search：数某个维度的选项时，
 * **把这个维度自己的筛选去掉，其它筛选全部保留**。
 *
 *   数「大类」时：search + subcategory + grade + map 都生效，**只有 category 不生效**
 *   数「子类」时：… 只有 subcategory 不生效（但父级 category 仍然生效）
 *
 * 实现就是下面 `pass(item, skip)` 那个 `skip` 参数。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Item, LootVerdict, MetaOption } from '@deltaforce/shared'

import { useItemsStore } from './items'
import { useMetaStore } from './meta'
import { useRulesStore } from './rules'

/** 表格里的一行 —— 比 `Item` 多了两个前端算出来的字段 */
export interface ItemRow {
  item: Item
  /** 当前 `mode` 下用于排序与判定的值 */
  metric: number | null
  /** 判定结论 */
  verdict: LootVerdict
}

/** 可以被"跳过"的筛选维度（交叉计数用） */
type Dim = 'search' | 'category' | 'subcategory' | 'thirdClass' | 'grade' | 'map'

/**
 * 排序键 —— 对应表头可以点的那几列。
 *
 * ⚠️ 排序**必须在这里做**，不能用 `el-table` 的 `sortable`。
 * 因为那个是「客户端排序」，它只排 `:data` 里的行 —— 而分页之后
 * `:data` 只有当前页的 50 行。结果就是你点「单价」排序，
 * 它把 50 行重排了，其余 1200 条纹丝不动，**而界面看起来"排好了"**。
 *
 * 所以表头用 `sortable="custom"`（只发事件、自己不排），
 * 由这里排全量筛选结果，再交给分页切片。
 */
export type SortKey = 'pricePerSlot' | 'price' | 'todayChangePct' | 'slots' | 'name'

export type SortDir = 'asc' | 'desc'

/** localStorage 的键。带版本号 —— 结构变了就换键，不会读到旧格式 */
const STORAGE_KEY = 'deltaforce.filters.v1'

/** 要持久化的东西 */
interface PersistedFilters {
  search: string
  categories: string[]
  subcategories: string[]
  thirdClasses: string[]
  grades: number[]
  maps: string[]
  verdictFilter: LootVerdict | null
  includeExcluded: boolean
  mapOnly: boolean
  sortKey: SortKey
  sortDir: SortDir
}

const SORT_KEYS: readonly SortKey[] = ['pricePerSlot', 'price', 'todayChangePct', 'slots', 'name']
const VERDICTS: readonly LootVerdict[] = ['must', 'maybe', 'skip', 'unknown']

const DEFAULTS: PersistedFilters = {
  search: '',
  categories: [],
  subcategories: [],
  thirdClasses: [],
  grades: [],
  maps: [],
  verdictFilter: null,
  includeExcluded: false,
  mapOnly: false,
  sortKey: 'pricePerSlot',
  sortDir: 'desc',
}

/** 只接受非空字符串数组（localStorage 里的东西不可信）*/
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 200)
}

/** 只接受 0~6 的整数数组 */
function asGradeArray(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 6,
  )
}

/**
 * 从 localStorage 读筛选状态。
 *
 * ⚠️ **不能信里面的内容** —— 可能是上一个版本写的、可能被手改过、
 * 也可能是别的网站同源留下的垃圾。所以逐字段校验类型与取值合法性，
 * 任何一项不对就退回默认值。
 *
 * （和 `stores/rules.ts` 读阈值是同一套做法，同一类问题的同一种防御。）
 */
function loadFilters(): PersistedFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULTS }

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    const o = parsed as Record<string, unknown>

    const verdictFilter = VERDICTS.includes(o['verdictFilter'] as LootVerdict)
      ? (o['verdictFilter'] as LootVerdict)
      : null
    const sortKey = SORT_KEYS.includes(o['sortKey'] as SortKey)
      ? (o['sortKey'] as SortKey)
      : DEFAULTS.sortKey

    return {
      // 搜索串限一下长度：万一被写了 10MB 进去，每次重算都要用
      search: typeof o['search'] === 'string' ? o['search'].slice(0, 200) : '',
      categories: asStringArray(o['categories']),
      subcategories: asStringArray(o['subcategories']),
      thirdClasses: asStringArray(o['thirdClasses']),
      grades: asGradeArray(o['grades']),
      maps: asStringArray(o['maps']),
      verdictFilter,
      includeExcluded: o['includeExcluded'] === true,
      mapOnly: o['mapOnly'] === true,
      sortKey,
      sortDir: o['sortDir'] === 'asc' ? 'asc' : 'desc',
    }
  } catch {
    // localStorage 在某些隐私模式下直接抛异常，不该让页面崩掉
    return { ...DEFAULTS }
  }
}

export const useFiltersStore = defineStore('filters', () => {
  const itemsStore = useItemsStore()
  const metaStore = useMetaStore()
  const rules = useRulesStore()

  /* ══════════════════ 筛选状态 ══════════════════ */

  const saved = loadFilters()

  const search = ref(saved.search)
  /**
   * ⭐ 分类与品质都是**多选**（数组）。
   *
   * 为什么改多选：单选的表达能力不够 —— 想同时看「收藏品 + 消耗品」
   * 或者再加上「枪械」就不行了。而参考的四个同类网站（dergame /
   * moligod / shushu / kkrb）**全部**用平铺标签 + 多选。
   *
   * 语义：**同一维度内是 OR，不同维度之间是 AND**。
   * 「大类 = 道具或弹药」且「品质 = 金或红」—— 这是所有人预期的读法。
   * 空数组 = 不限（而不是"什么都不选"）。
   */
  const categories = ref<string[]>(saved.categories)
  /** 子类（46 个，太多不适合平铺，用可搜索的多选下拉）*/
  const subcategories = ref<string[]>(saved.subcategories)
  /** 细类 */
  const thirdClasses = ref<string[]>(saved.thirdClasses)
  /** 品质 0~6 */
  const grades = ref<number[]>(saved.grades)
  /** 地图名（出产地）*/
  const maps = ref<string[]>(saved.maps)

  /**
   * 「只看该图专属」—— 把通用物资（每张图都刷得到的）也排掉。
   *
   * 为什么需要它：实测 1564 条里有 **1297 条标注是「全地图」**
   * （每张图都能刷到，如通用收集品）。所以只选地图的话，
   * 六张图各约 1300 条 —— 跟没筛差不了多少。
   * 带上这个开关，选长弓溪谷就只剩十几条**地图特产**了。
   */
  const mapOnly = ref(saved.mapOnly)

  /**
   * 只看某一档判定。`null` = 全都看。
   *
   * 单选而不是多选：实际用起来的需求就是"现在只看必摸"，
   * 点第二下取消。多选会让"我到底在看什么"变得不清楚。
   */
  const verdictFilter = ref<LootVerdict | null>(saved.verdictFilter)

  /**
   * 是否把"不可上架 / 不可摸 / 无价格"的物品也显示出来。
   *
   * 默认关掉 —— 它们不参与排序，混进来会干扰"该摸什么"的判断。
   * 但它们的信息本身有价值（"这条能摸到但卖不掉"是个结论），
   * 所以给个开关让你能查。
   */
  const includeExcluded = ref(saved.includeExcluded)

  /** 排序键与方向（表头点出来的）*/
  const sortKey = ref<SortKey>(saved.sortKey)
  const sortDir = ref<SortDir>(saved.sortDir)

  /* ══════════════════ 基础池 ══════════════════ */

  /**
   * 待筛选的物品集合。
   *
   * `itemsStore.ranked` 已经去掉了"不可上架 / 不可摸"（那是**全局**规则，
   * 不是用户筛选），这里只决定要不要把那些重新放进来看看。
   */
  const pool = computed<Item[]>(() =>
    includeExcluded.value ? itemsStore.items : itemsStore.ranked,
  )

  /* ══════════════════ 各维度的谓词 ══════════════════ */

  /**
   * 谓词写成函数（读 ref），而不是 `computed` 的布尔值。
   *
   * 为什么：它们要在 `pass(item, skip)` 里对**每一个物品**求值。
   * 如果写成一堆 computed 数组，就只能在整体上判断，没法"跳过某一维"。
   * 用函数的话，每次调用时读一次 ref —— 依然受 Vue 追踪，
   * 所以放进 computed 里照样会在依赖变化时重算。
   */
  function matchSearch(it: Item): boolean {
    const q = search.value.trim().toLowerCase()
    if (q === '') return true
    // 名字、别名、官方ID 都能搜 —— 用 ID 搜是排查问题时最常用的
    return (
      it.name.toLowerCase().includes(q) ||
      it.sourceItemId.includes(q) ||
      (it.alias !== null && it.alias.toLowerCase().includes(q))
    )
  }

  function matchCategory(it: Item): boolean {
    return categories.value.length === 0 || categories.value.includes(it.categoryCode)
  }

  function matchSubcategory(it: Item): boolean {
    // 父级已经筛过一遍，这里只判断自己 —— 交叉计数的"去掉自己"由 pass 负责
    return subcategories.value.length === 0 || subcategories.value.includes(it.subcategory)
  }

  function matchThirdClass(it: Item): boolean {
    return thirdClasses.value.length === 0 || thirdClasses.value.includes(it.thirdClass ?? '')
  }

  function matchGrade(it: Item): boolean {
    return grades.value.length === 0 || grades.value.includes(it.grade)
  }

  function matchMap(it: Item): boolean {
    if (maps.value.length === 0) return true
    const own = it.provenanceMaps
    if (own === null) return false
    // 多选地图也是 OR：选中任意一张就算中
    return maps.value.some((m) => own.includes(m))
  }

  const PREDICATES: ReadonlyArray<readonly [Dim, (it: Item) => boolean]> = [
    ['search', matchSearch],
    ['category', matchCategory],
    ['subcategory', matchSubcategory],
    ['thirdClass', matchThirdClass],
    ['grade', matchGrade],
    ['map', matchMap],
  ]

  /**
   * 这个物品是否通过筛选。`skip` 指定的维度**不参与判断**（交叉计数用）。
   *
   * ⚠️ `mapOnly` 与 `includeExcluded` 这类**开关型筛选不参与 skip** ——
   *    它们没有"选项"需要计数（不像大类/品质那样有下拉列表），
   *    所以应纳恒定生效。否则一打开"只看专属"，
   *    下拉里的数字就跟实际结果对不上了。
   */
  function pass(it: Item, skip?: Dim): boolean {
    // 开关型筛选（恒定生效，不看 skip）
    if (mapOnly.value && maps.value.length > 0 && it.provenanceUniversal) return false

    for (const [dim, fn] of PREDICATES) {
      if (dim === skip) continue
      if (!fn(it)) return false
    }
    return true
  }

  /* ══════════════════ 最终结果 ══════════════════ */

  /**
   * 过了所有筛选、但**还没按判定过滤**的行。
   * 中间结果单独留一份，是为了让判定计数不受判定过滤本身影响
   * （否则点"只看必摸"之后，其它三档的计数会全变成 0，你就没法切回去了）。
   */
  const rowsBeforeVerdict = computed<ItemRow[]>(() =>
    pool.value.filter((it) => pass(it)).map((item) => ({
      item,
      metric: rules.metricOf(item),
      verdict: rules.verdictOf(item),
    })),
  )

  /** 判定计数（给 ThresholdSlider 显示"必摸 87 条"）*/
  const verdictCounts = computed<Record<LootVerdict, number>>(() => {
    const out: Record<LootVerdict, number> = { must: 0, maybe: 0, skip: 0, unknown: 0 }
    for (const row of rowsBeforeVerdict.value) out[row.verdict] += 1
    return out
  })

  /**
   * 数值比较：**`null` 恒排最后**，不随排序方向翻到最前。
   *
   * 为什么不让它跟着方向翻：`null` 的语义是"算不出来"，
   * 把它放到最前面会让人以为"这些最值钱/最便宜"。
   */
  function compareNumber(va: number | null, vb: number | null, dir: number): number {
    if (va === null && vb === null) return 0
    if (va === null) return 1
    if (vb === null) return -1
    return (va - vb) * dir
  }

  /** 按当前 `sortKey` / `sortDir` 比较两行 */
  function compareRows(a: ItemRow, b: ItemRow): number {
    const dir = sortDir.value === 'asc' ? 1 : -1

    switch (sortKey.value) {
      case 'name':
        return a.item.name.localeCompare(b.item.name, 'zh-CN') * dir
      case 'price':
        return compareNumber(a.item.price, b.item.price, dir)
      case 'todayChangePct':
        return compareNumber(a.item.todayChangePct, b.item.todayChangePct, dir)
      case 'slots':
        // 占格是数字且必存在，不会为 null
        return (a.item.slots - b.item.slots) * dir
      case 'pricePerSlot':
        return compareNumber(a.item.pricePerSlot, b.item.pricePerSlot, dir)
    }
  }

  /** 表格最终渲染的行（已按判定过滤 + 排序）*/
  const rows = computed<ItemRow[]>(() => {
    const list =
      verdictFilter.value === null
        ? rowsBeforeVerdict.value
        : rowsBeforeVerdict.value.filter((r) => r.verdict === verdictFilter.value)

    /**
     * 排序分两档，**顺序不能反**：
     *
     *   ① **先分"已判定 / 未判定"** —— 未判定的（不可上架 / 不可摸 / 无价格）
     *      恒排最后，不管它的数字多大。
     *
     *      不这样分的话，打开"含不可上架/不可摸"之后，
     *      火箭燃料（500 万但挂不上交易行）会排到榜单最前面 ——
     *      而那个价格你根本拿不到。数字看着对，结论完全错。
     *
     *   ② 再按选中的列排。
     *
     * 末尾用名字做稳定键 —— 不然指标相同的物品顺序会在每次重算时拖动。
     */
    return [...list].sort((a, b) => {
      const au = a.verdict === 'unknown' ? 1 : 0
      const bu = b.verdict === 'unknown' ? 1 : 0
      if (au !== bu) return au - bu

      const byKey = compareRows(a, b)
      if (byKey !== 0) return byKey
      return a.item.name.localeCompare(b.item.name, 'zh-CN')
    })
  })

  /* ══════════════════ 选项（带交叉计数）══════════════════ */

  /** 通用：把物品按某个键聚合成带计数的选项 */
  function optionsFor(
    dim: Dim,
    keyOf: (it: Item) => string | null,
    labelOf: (it: Item) => string | null,
  ): MetaOption[] {
    const acc = new Map<string, MetaOption>()
    for (const it of pool.value) {
      if (!pass(it, dim)) continue
      const value = keyOf(it)
      if (value === null || value === '') continue
      const found = acc.get(value)
      if (found) found.count += 1
      else acc.set(value, { value, label: labelOf(it) ?? value, count: 1 })
    }
    // 数量相同时按中文名排序，保证顺序稳定（不然每次重算都会跳）
    return [...acc.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'),
    )
  }

  /**
   * 大类选项。
   *
   * 大类只有 5~7 个（道具/配件/弹药/防护/枪械），**全部列出**（包括 0 条的），
   * 因为"弹药现在是 0 条"本身就是有用的信息。
   * 子类/细类/地图有几十上百个，0 条的就不列了。
   */
  const categoryOptions = computed<MetaOption[]>(() => {
    const counts = optionsFor(
      'category',
      (it) => it.categoryCode,
      (it) => it.categoryCn,
    )
    const map = new Map(counts.map((o) => [o.value, o]))
    // 以后端给的完整大类清单为准，保证顺序稳定、且不会漏掉 0 条的
    return metaStore.categories.map((base) => map.get(base.value) ?? { ...base, count: 0 })
  })

  const subcategoryOptions = computed<MetaOption[]>(() =>
    optionsFor(
      'subcategory',
      (it) => it.subcategory,
      (it) => it.subcategoryCn ?? it.subcategory,
    ),
  )

  const thirdClassOptions = computed<MetaOption[]>(() =>
    optionsFor(
      'thirdClass',
      (it) => it.thirdClass,
      (it) => it.thirdClassCn ?? it.thirdClass,
    ),
  )

  const gradeOptions = computed<MetaOption[]>(() =>
    optionsFor(
      'grade',
      (it) => String(it.grade),
      (it) => it.gradeCn,
    ),
  )

  /** 地图选项也带计数 —— "这张图能刷出多少条"是很实用的信息 */
  const mapOptions = computed<MetaOption[]>(() => {
    // `provenanceMaps` 是多值字段（一条物品能出在多张图上），所以不能走
    // `optionsFor`（那个假设一个物品只落进一个桶）。这里单独数。
    const acc = new Map<string, number>()
    for (const it of pool.value) {
      if (!pass(it, 'map')) continue
      for (const m of it.provenanceMaps ?? []) {
        acc.set(m, (acc.get(m) ?? 0) + 1)
      }
    }
    return [...acc.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN'))
  })

  /* ══════════════════ 界面辅助 ══════════════════ */

  /** 当前生效的筛选条件数（给"清除筛选 (3)"用）*/
  const activeFilterCount = computed(() => {
    let n = 0
    if (search.value.trim() !== '') n += 1
    if (categories.value.length > 0) n += 1
    if (subcategories.value.length > 0) n += 1
    if (thirdClasses.value.length > 0) n += 1
    if (grades.value.length > 0) n += 1
    if (maps.value.length > 0) n += 1
    if (mapOnly.value) n += 1
    if (verdictFilter.value !== null) n += 1
    return n
  })

  /**
   * 表头排序事件 → 写回 store。
   *
   * `el-table` 的 `@sort-change` 给的是 `prop`（列标识）与 `order`（方向）。
   *
   * 点第三下时 `order` 为 `null`（Element Plus 的三态循环：降→升→取消）
   * —— 这里把它当作"回到默认排序"，于是你有一个自然的方式回到初始状态。
   */
  const PROP_TO_SORT_KEY: Readonly<Record<string, SortKey>> = {
    pricePerSlot: 'pricePerSlot',
    price: 'price',
    todayChangePct: 'todayChangePct',
    slots: 'slots',
    name: 'name',
  }

  function applySortChange(payload: {
    prop: string | null
    order: 'ascending' | 'descending' | null
  }): void {
    if (payload.order === null || payload.prop === null) {
      sortKey.value = DEFAULTS.sortKey
      sortDir.value = DEFAULTS.sortDir
      return
    }
    const key = PROP_TO_SORT_KEY[payload.prop]
    if (key === undefined) return
    sortKey.value = key
    sortDir.value = payload.order === 'ascending' ? 'asc' : 'desc'
  }

  /**
   * 逐级联动：改大类 → 清掉子类和细类。
   *
   * ⚠️ 这一步**必须做**。单选时代是因为"选弹药后子类还留着收集品 → 0 条"；
   * 改成多选后理由变了但结论一样：选了「道具 + 弹药」之后，
   * 子类里残留的「收集品」只属于道具，而界面上会显示一个
   * 不属于所有已选大类的选项 —— 得自己一格一格清。
   */
  function toggleCategory(code: string): void {
    categories.value = categories.value.includes(code)
      ? categories.value.filter((c) => c !== code)
      : [...categories.value, code]
    subcategories.value = []
    thirdClasses.value = []
  }

  /** 清空某一维（点「全部」标签）*/
  function clearCategories(): void {
    categories.value = []
    subcategories.value = []
    thirdClasses.value = []
  }

  /**
   * 改子类 → 清掉细类。
   *
   * ⚠️ 这个级联**必须放在 store 里**，不能写在组件的 `@change` 里 ——
   *    写在模板里虽然也能跑，但测试碰不到它（模板逻辑没法单测），
   *    而“改上级要清下级”正是最容易忘、忘了就静默出错的那类规则。
   */
  function setSubcategories(next: string[]): void {
    subcategories.value = next
    thirdClasses.value = []
  }

  /** 清空细类 */
  function clearThirdClasses(): void {
    thirdClasses.value = []
  }

  function toggleGrade(g: number): void {
    grades.value = grades.value.includes(g)
      ? grades.value.filter((x) => x !== g)
      : [...grades.value, g]
  }

  function toggleMap(name: string): void {
    maps.value = maps.value.includes(name)
      ? maps.value.filter((m) => m !== name)
      : [...maps.value, name]
  }

  function setVerdictFilter(value: LootVerdict | null): void {
    // 点同一个就取消 —— 这是"只看必摸"最自然的交互
    verdictFilter.value = verdictFilter.value === value ? null : value
  }

  function resetFilters(): void {
    search.value = ''
    categories.value = []
    subcategories.value = []
    thirdClasses.value = []
    grades.value = []
    maps.value = []
    mapOnly.value = false
    verdictFilter.value = null
    // 注：`includeExcluded` 与排序**不重置** —— 前者是显示偏好，
    // 后者是"我在看哪一列"，都不是筛选条件。
  }

  /* ══════════════════ 持久化 ══════════════════ */

  /**
   * 存盘。
   *
   * 为什么筛选要存：这是个反复用的工具。"选好长弓溪谷 + 只看必摸"然后
   * 刷新页面就回到全部，每次重新选一遍 —— 而拖滑块存了、筛选没存，
   * 这种不一致本身就很难理解。
   *
   * 与 `stores/rules.ts` 的阈值同一个键空间风格（带 `.v1` 版本号）。
   */
  watch(
    [
      search,
      categories,
      subcategories,
      thirdClasses,
      grades,
      maps,
      mapOnly,
      verdictFilter,
      includeExcluded,
      sortKey,
      sortDir,
    ],
    () => {
      try {
        const snapshot: PersistedFilters = {
          search: search.value,
          categories: [...categories.value],
          subcategories: [...subcategories.value],
          thirdClasses: [...thirdClasses.value],
          grades: [...grades.value],
          maps: [...maps.value],
          verdictFilter: verdictFilter.value,
          includeExcluded: includeExcluded.value,
          mapOnly: mapOnly.value,
          sortKey: sortKey.value,
          sortDir: sortDir.value,
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
      } catch {
        // 存不下（隐私模式 / 配额满）不该让界面崩 —— 只是刷新后丢设置
      }
    },
    { deep: true },
  )

  /**
   * 判定依据从"单格价值"切到"单价"时，如果当前排的就是这两个之一，
   * **跟着一起换**。
   *
   * 不跟的话会出现这种自相矛盾：按单格价值排序的列表，
   * 而右侧判定用的是单价 —— 排在前面的被判"跳过"。
   * 但如果用户已经手动点了别的列（如今日涨幅），就不插手。
   */
  watch(
    () => rules.mode,
    (mode) => {
      if (sortKey.value === 'pricePerSlot' || sortKey.value === 'price') {
        sortKey.value = mode === 'price' ? 'price' : 'pricePerSlot'
      }
    },
  )

  return {
    // 状态
    search,
    categories,
    subcategories,
    thirdClasses,
    grades,
    maps,
    mapOnly,
    verdictFilter,
    includeExcluded,
    sortKey,
    sortDir,

    // 派生
    pool,
    rows,
    rowsBeforeVerdict,
    verdictCounts,
    categoryOptions,
    subcategoryOptions,
    thirdClassOptions,
    gradeOptions,
    mapOptions,
    activeFilterCount,

    // 动作
    toggleCategory,
    clearCategories,
    setSubcategories,
    clearThirdClasses,
    toggleGrade,
    toggleMap,
    setVerdictFilter,
    applySortChange,
    resetFilters,
  }
})
