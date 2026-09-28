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

import { computed, ref } from 'vue'
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

export const useFiltersStore = defineStore('filters', () => {
  const itemsStore = useItemsStore()
  const metaStore = useMetaStore()
  const rules = useRulesStore()

  /* ══════════════════ 筛选状态 ══════════════════ */

  const search = ref('')
  /** 大类 `categoryCode` */
  const category = ref<string | null>(null)
  /** 子类 `subcategory` */
  const subcategory = ref<string | null>(null)
  /** 细类 `thirdClass` */
  const thirdClass = ref<string | null>(null)
  /** 品质 0~6 */
  const grade = ref<number | null>(null)
  /** 地图名（出产地） */
  const map = ref<string | null>(null)

  /**
   * 只看某一档判定。`null` = 全都看。
   *
   * 单选而不是多选：实际用起来的需求就是"现在只看必摸"，
   * 点第二下取消。多选会让"我到底在看什么"变得不清楚。
   */
  const verdictFilter = ref<LootVerdict | null>(null)

  /**
   * 是否把"不可上架 / 不可摸 / 无价格"的物品也显示出来。
   *
   * 默认关掉 —— 它们不参与排序，混进来会干扰"该摸什么"的判断。
   * 但它们的信息本身有价值（"这条能摸到但卖不掉"是个结论），
   * 所以给个开关让你能查。
   */
  const includeExcluded = ref(false)

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
    return category.value === null || it.categoryCode === category.value
  }

  function matchSubcategory(it: Item): boolean {
    // 父级已经筛过一遍，这里只判断自己 —— 交叉计数的"去掉自己"由 pass 负责
    if (subcategory.value === null) return true
    return it.subcategory === subcategory.value
  }

  function matchThirdClass(it: Item): boolean {
    return thirdClass.value === null || it.thirdClass === thirdClass.value
  }

  function matchGrade(it: Item): boolean {
    return grade.value === null || it.grade === grade.value
  }

  function matchMap(it: Item): boolean {
    if (map.value === null) return true
    return it.provenanceMaps !== null && it.provenanceMaps.includes(map.value)
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
   */
  function pass(it: Item, skip?: Dim): boolean {
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

  /** 表格最终渲染的行（已按判定过滤 + 排序）*/
  const rows = computed<ItemRow[]>(() => {
    const list =
      verdictFilter.value === null
        ? rowsBeforeVerdict.value
        : rowsBeforeVerdict.value.filter((r) => r.verdict === verdictFilter.value)

    /**
     * 排序：按当前指标降序，`null` 排最后。
     *
     * `null` 排最后而不是排最前：`null` 的含义是"算不出来"，
     * 把它放在最前面会让人以为"这些最值钱"。
     *
     * 末尾用名字做第二排序键 —— 不然指标相同的物品顺序会在每次重算时
     * 抖动（`Array.sort` 在 V8 里虽然稳定，但输入顺序本身可能变）。
     */
    return [...list].sort((a, b) => {
      const va = a.metric
      const vb = b.metric
      if (va === null && vb === null) return a.item.name.localeCompare(b.item.name)
      if (va === null) return 1
      if (vb === null) return -1
      if (vb !== va) return vb - va
      return a.item.name.localeCompare(b.item.name)
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

  /** 当前生效的筛选条件数（给标题旁边的"清除筛选 (3)"用）*/
  const activeFilterCount = computed(() => {
    let n = 0
    if (search.value.trim() !== '') n += 1
    if (category.value !== null) n += 1
    if (subcategory.value !== null) n += 1
    if (thirdClass.value !== null) n += 1
    if (grade.value !== null) n += 1
    if (map.value !== null) n += 1
    if (verdictFilter.value !== null) n += 1
    return n
  })

  /**
   * 逐级联动：改大类 → 清掉子类和细类。
   *
   * ⚠️ 这一步**必须做**，否则会出现这种 bug：
   *   你本来筛的是「道具 / 收集品」，然后把大类改成「弹药」——
   *   子类仍然是「收集品」，于是结果 0 条，而且下拉框里显示一个
   *   不属于弹药的子类，你得一格一格手动清。
   */
  function setCategory(value: string | null): void {
    category.value = value
    subcategory.value = null
    thirdClass.value = null
  }

  function setSubcategory(value: string | null): void {
    subcategory.value = value
    thirdClass.value = null
  }

  function setVerdictFilter(value: LootVerdict | null): void {
    // 点同一个就取消 —— 这是"只看必摸"最自然的交互
    verdictFilter.value = verdictFilter.value === value ? null : value
  }

  function resetFilters(): void {
    search.value = ''
    category.value = null
    subcategory.value = null
    thirdClass.value = null
    grade.value = null
    map.value = null
    verdictFilter.value = null
  }

  return {
    // 状态
    search,
    category,
    subcategory,
    thirdClass,
    grade,
    map,
    verdictFilter,
    includeExcluded,

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
    setCategory,
    setSubcategory,
    setVerdictFilter,
    resetFilters,
  }
})
