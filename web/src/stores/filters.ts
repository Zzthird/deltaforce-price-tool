/**
 * 筛选状态 + 派生出来的表格行。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⭐ 顶层分组：为什么「收集品 / 钥匙 / 消耗品」被提升为顶层
 * ═══════════════════════════════════════════════════════════════════════
 * 官方数据里它们是 `props`（道具）大类的**子类**。但玩家心里它们是并列的
 * 类别 —— 参考的 moligod 就是一层平铺：配件 / 子弹 / 枪械 / 收集品 /
 * 消耗品 / 钥匙 / 防具 / 载具。
 *
 * 所以前端做了一次**展示层的重组**：把这三个从 `props` 里提出来，
 * 与 `acc/ammo/protect/gun` 并列成 7 个顶层标签。
 *
 * ⚠️ `game` 的官方 ID / 三级分类仍然是唯一真相 —— 这里只是改"怎么摆"，
 *    不改数据。所以它完全可以在前端做（后端不需要知道）。
 *
 * ⚠️ 这里只写**代码**（`props`/`collection`…），**中文名从 `/api/meta` 拿**。
 *    因为 `shared` 里不能放运行时常量（AGENTS.md §5），
 *    中文标签只能由后端下发 —— 前端不写第二份。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⭐ 子类：每个已选分组各占一行
 * ═══════════════════════════════════════════════════════════════════════
 * 用户的原话：「每选择一个大类，就在大类的下方添加一个独立的行，
 * 将对应大类的子类进行平铺」—— 这是对的，而且解决了一个真问题：
 *
 *   把「道具」和「弹药」都选上时，子类清单是两者的**并集**
 *   （收集品/钥匙/消耗品 + 19 个弹药口径），混在一起**分不清谁属于谁** ✗。
 *   分行之后，归属关系是**结构性**的，不靠猜。
 *
 * 实测各分组的子类数量：收集品 0 / 消耗品 3 / 钥匙 0 / 配件 9 /
 * 弹药 19 / 防护 4 / 枪械 8 —— 都只占一行（弹药折两行），
 * 而没有子类的分组**不显示空行**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 交叉计数（faceted counts）
 * ═══════════════════════════════════════════════════════════════════════
 * 标签上的数字是「**选中它、且满足其它维度**」的物品数 ——
 * 数某维度时把**它自己**跳过（`pass(item, skip)`）。
 * 这样它不随自己这一维的已选状态变化，不会出现"选了一个之后其它全变 0"。
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
type Dim = 'search' | 'group' | 'sub' | 'grade' | 'map'

/**
 * 顶层筛选分组的定义。**只写代码，不写中文**（中文从 /api/meta 拿）。
 *
 * 顺序即界面上的显示顺序：收集品/消耗品/钥匙 在前（它们是玩家最常看的），
 * 然后是装备类。兜底的 `props` 放最后 —— 只有当官方数据里出现
 * 没被提升的子类时它才会非空。
 */
interface GroupDef {
  value: string
  categoryCode: string
  subcategory?: string
  /**
   * 这个分组的**下一级**取哪个字段。
   *
   * 三层字段分别是谁在用（都是实测出来的）：
   *   · `itemSubtype`  —— **收集品**用（9 个：工艺藏品/资料情报/家居物品/
   *                        电子物品/工具材料/医疗道具/能源燃料/身份牌/生活用品）。
   *                        实测 586 条收集品全都有值，而且与 moligod 的
   *                        「二级分类」筛选完全一致 —— 它的值**本身就是中文**，
   *                        所以不需要再翻译。
   *   · `thirdClass`   —— **消耗品**用（3 个：维修套件/药品/针剂）。
   *                        注意全项目只有 30 条带 thirdClass，全在消耗品。
   *   · `subcategory`  —— 配件/弹药/防护/枪械 用（它们还没被拆到下一层）
   *
   * ⚠️ 收集品曾经被我误判成"没有子类"—— 因为我只看了 `thirdClass`，
   *    而它的细分其实在 `itemSubtype` 里。两者是不同的字段。
   */
  nextLevel: 'subcategory' | 'thirdClass' | 'itemSubtype'
}

const GROUP_DEFS: readonly GroupDef[] = [
  { value: 'collection', categoryCode: 'props', subcategory: 'collection', nextLevel: 'itemSubtype' },
  { value: 'consume', categoryCode: 'props', subcategory: 'consume', nextLevel: 'thirdClass' },
  { value: 'key', categoryCode: 'props', subcategory: 'key', nextLevel: 'thirdClass' },
  { value: 'acc', categoryCode: 'acc', nextLevel: 'subcategory' },
  { value: 'ammo', categoryCode: 'ammo', nextLevel: 'subcategory' },
  { value: 'protect', categoryCode: 'protect', nextLevel: 'subcategory' },
  { value: 'gun', categoryCode: 'gun', nextLevel: 'subcategory' },
  /* 兜底：props 里将来若出现没被提升的子类，它们仍能被筛到 */
  { value: 'props', categoryCode: 'props', nextLevel: 'subcategory' },
]

/**
 * 一个物品属于哪个顶层分组。
 * 先匹配"带 subcategory 的具体分组"，匹配不上才落到兜底的 `props`。
 */
function groupOf(item: Item): string {
  for (const g of GROUP_DEFS) {
    if (g.categoryCode !== item.categoryCode) continue
    if (g.subcategory === undefined || g.subcategory === item.subcategory) return g.value
  }
  return item.categoryCode
}

/**
 * 取一个物品的"下一级"值（用于筛选比较）。
 *
 * ⚠️ `itemSubtype` 的值**本身就是中文**（官方接口直接给「工艺藏品」这种），
 *    所以它既当值又当标签 —— 不像 subcategory 那样还有 `subcategoryCn`。
 */
function nextLevelValue(item: Item, level: GroupDef['nextLevel']): string | null {
  switch (level) {
    case 'subcategory':
      return item.subcategory
    case 'thirdClass':
      return item.thirdClass
    case 'itemSubtype':
      return item.itemSubtype
  }
}

/** 取一个物品的"下一级"标签（给人看的）*/
function nextLevelLabel(item: Item, level: GroupDef['nextLevel']): string | null {
  switch (level) {
    case 'subcategory':
      return item.subcategoryCn ?? item.subcategory
    case 'thirdClass':
      return item.thirdClassCn ?? item.thirdClass
    case 'itemSubtype':
      // 已经是中文，直接用
      return item.itemSubtype
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

/** 排序键 —— 对应表头可以点的那几列 */
export type SortKey = 'pricePerSlot' | 'price' | 'todayChangePct' | 'slots' | 'name'
export type SortDir = 'asc' | 'desc'

/**
 * localStorage 的键。**带版本号，而且这一版换了号** ——
 * 因为筛选结构从「category / subcategory / thirdClass」变成了
 * 「group / subs」，旧数据读进来会是错的。换键比写迁移简单且更安全。
 */
const STORAGE_KEY = 'deltaforce.filters.v2'

interface PersistedFilters {
  search: string
  groups: string[]
  subs: string[]
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
  groups: [],
  subs: [],
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

/** 读筛选设置（逐字段校验，任何一项不对就退回默认）*/
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
      search: typeof o['search'] === 'string' ? o['search'].slice(0, 200) : '',
      groups: asStringArray(o['groups']),
      subs: asStringArray(o['subs']),
      grades: asGradeArray(o['grades']),
      maps: asStringArray(o['maps']),
      verdictFilter,
      includeExcluded: o['includeExcluded'] === true,
      mapOnly: o['mapOnly'] === true,
      sortKey,
      sortDir: o['sortDir'] === 'asc' ? 'asc' : 'desc',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/* ══════════════════════════════════════════════════════════════════════ */

export const useFiltersStore = defineStore('filters', () => {
  const itemsStore = useItemsStore()
  const metaStore = useMetaStore()
  const rules = useRulesStore()

  const saved = loadFilters()

  /* ══════════════════ 筛选状态 ══════════════════ */

  const search = ref(saved.search)
  /** 选中的顶层分组（见文件头的 GROUP_DEFS）。空数组 = 不限 */
  const groups = ref<string[]>(saved.groups)
  /** 选中的下一级分类（跨分组共用一个集合，但各行的「全部」只清自己那部分）*/
  const subs = ref<string[]>(saved.subs)
  /** 品质 0~6 */
  const grades = ref<number[]>(saved.grades)
  /** 地图名（出产地）*/
  const maps = ref<string[]>(saved.maps)

  /**
   * 「只看该图专属」—— 把通用物资（每张图都刷得到的）也排掉。
   * 实测 1564 条里有 1298 条是通用，所以只选地图的话六张图各约 1300 条，
   * 跟没筛差不了多少。
   */
  const mapOnly = ref(saved.mapOnly)

  /** 只看某一档判定。`null` = 全都看（点同一个再点一次取消）*/
  const verdictFilter = ref<LootVerdict | null>(saved.verdictFilter)

  /**
   * 是否把"不可上架 / 不可摸 / 无价格"的物品也显示出来。
   * 默认关 —— 它们不参与排序；但信息本身有价值（"能摸到但卖不掉"）。
   */
  const includeExcluded = ref(saved.includeExcluded)

  /** 排序键与方向（表头点出来的）*/
  const sortKey = ref<SortKey>(saved.sortKey)
  const sortDir = ref<SortDir>(saved.sortDir)

  /**
   * 子类行是否展开（用户的补充建议：整个子类区可折叠）。
   * 默认展开 —— 否则用户根本发现不了它能筛子类。
   */
  const subsExpanded = ref(true)

  /* ══════════════════ 基础池 ══════════════════ */

  const pool = computed<Item[]>(() =>
    includeExcluded.value ? itemsStore.items : itemsStore.ranked,
  )

  /* ══════════════════ 各维度的谓词 ══════════════════ */

  function matchSearch(it: Item): boolean {
    const q = search.value.trim().toLowerCase()
    if (q === '') return true
    return (
      it.name.toLowerCase().includes(q) ||
      it.sourceItemId.includes(q) ||
      (it.alias !== null && it.alias.toLowerCase().includes(q))
    )
  }

  function matchGroup(it: Item): boolean {
    return groups.value.length === 0 || groups.value.includes(groupOf(it))
  }

  /**
   * 下一级分类的筛选。
   *
   * ⚠️ 这里是**跨分组共用一个集合**的（`subs`），但各行的「全部」只移除
   *    属于自己那一行的值 —— 否则点「消耗品」的"全部"会把「配件」的
   *    子类选择也清掉，很意外。
   */
  function matchSub(it: Item): boolean {
    if (subs.value.length === 0) return true
    const g = groupDefOf(groupOf(it))
    if (g === undefined) return true
    const value = nextLevelValue(it, g.nextLevel)
    return value !== null && subs.value.includes(value)
  }

  function matchGrade(it: Item): boolean {
    if (grades.value.length === 0) return true

    /**
     * ⭐ 品质 0（「灰」）的**有条件**豁免。
     *
     * 实测：品质 0 共 68 条，**全是枪械** —— 它不是"某个品质"，
     * 而是"这件东西没有品质"（枪械没有品质等级）。
     *
     * 规则（用户两次反馈后定下的，第一次我做宽了）：
     *   · **显式选了它所属的分组**（如点了「枪械」）→ 不受品质筛选影响。
     *     此时你的意思是"我要看枪"，被一个残留的品质筛选挡住很奇怪。
     *   · **没选那个分组** → 照常被品质筛掉。
     *     否则你单看「金」的时候，枪械会跑出来白占位置。
     *     （用户原话：「在只选择单一品质时，枪械这种无品质的物品也会占位」）
     */
    if (it.grade === 0) return groups.value.includes(groupOf(it))
    return grades.value.includes(it.grade)
  }

  function matchMap(it: Item): boolean {
    if (maps.value.length === 0) return true
    const own = it.provenanceMaps
    if (own === null) return false
    return maps.value.some((m) => own.includes(m))
  }

  const PREDICATES: ReadonlyArray<readonly [Dim, (it: Item) => boolean]> = [
    ['search', matchSearch],
    ['group', matchGroup],
    ['sub', matchSub],
    ['grade', matchGrade],
    ['map', matchMap],
  ]

  /**
   * 这个物品是否通过筛选。`skip` 指定的维度**不参与判断**（交叉计数用）。
   *
   * ⚠️ `mapOnly` 与 `includeExcluded` 这类**开关型筛选不参与 skip** ——
   *    它们没有"选项"需要计数（不像分组/品质那样有下拉列表），
   *    所以恒定生效。否则一打开"只看专属"，下拉里的数字就跟结果对不上了。
   */
  function pass(it: Item, skip?: Dim): boolean {
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

  /** 判定计数（给「当前结果」那几个可点标签用）*/
  const verdictCounts = computed<Record<LootVerdict, number>>(() => {
    const out: Record<LootVerdict, number> = { must: 0, maybe: 0, skip: 0, unknown: 0 }
    for (const row of rowsBeforeVerdict.value) out[row.verdict] += 1
    return out
  })

  /* ══════════════════ 排序 ══════════════════ */

  /**
   * 数值比较：**`null` 恒排最后**，不随排序方向翻到最前。
   * `null` 的语义是"算不出来"，放最前会被误读成"最值钱/最便宜"。
   */
  function compareNumber(va: number | null, vb: number | null, dir: number): number {
    if (va === null && vb === null) return 0
    if (va === null) return 1
    if (vb === null) return -1
    return (va - vb) * dir
  }

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
        return (a.item.slots - b.item.slots) * dir
      case 'pricePerSlot':
        return compareNumber(a.item.pricePerSlot, b.item.pricePerSlot, dir)
    }
  }

  /**
   * 表格最终渲染的行（已按判定过滤 + 排序）。
   *
   * 排序分两档，**顺序不能反**：
   *   ① 先分"已判定 / 未判定" —— 未判定的（不可上架/不可摸/无价格）恒排最后，
   *      不管它的数字多大。不这样分的话，打开"含不可上架/不可摸"之后，
   *      火箭燃料（500 万但挂不上交易行）会排到榜单最前面 —— 而那个价格
   *      你根本拿不到。数字看着对，结论完全错。
   *   ② 再按选中的列排。末尾用名字做稳定键。
   */
  const rows = computed<ItemRow[]>(() => {
    const list =
      verdictFilter.value === null
        ? rowsBeforeVerdict.value
        : rowsBeforeVerdict.value.filter((r) => r.verdict === verdictFilter.value)

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

  /**
   * 顶层分组的标签（含计数）。
   *
   * 计数规则：数某个分组时**跳过分组这一维**，其余筛选照常生效 ——
   * 这样它不随自己这一维的已选状态变化（faceted search 的标准行为）。
   */
  const groupOptions = computed<MetaOption[]>(() => {
    const counts = new Map<string, number>()
    /**
     * ⭐ 标签**从物品数据本身取**，而不是去 `/api/meta` 里查。
     *
     * 为什么：`/api/meta` 的 `subcategories` 只包含**至少有一个可排序物品**
     * 的子类……更准确地说，一旦 meta 那边缺了某项，回退就会拿到
     * **大类名**（`props` → 「道具」），于是「收集品」会显示成「道具」，
     * 还和兜底分组重名 —— 界面上出现两个「道具」标签，完全看不懂。
     * （这是写测试时真踩到的：fixture 没给 meta.subcategories，
     *   断言 `label === '收集品'` 就变成了 `'道具'`。）
     *
     * 物品数据里的 `subcategoryCn` / `categoryCn` 是后端 normalize 时填的，
     * 和 meta 同源，但**一定在**（有物品就有标签）✓
     */
    const labels = new Map<string, string>()

    for (const it of pool.value) {
      if (!pass(it, 'group')) continue
      const g = groupOf(it)
      counts.set(g, (counts.get(g) ?? 0) + 1)

      if (labels.has(g)) continue
      const def = groupDefOf(g)
      labels.set(
        g,
        def?.subcategory !== undefined
          ? (it.subcategoryCn ?? it.subcategory)
          : (it.categoryCn || it.categoryCode),
      )
    }

    // 池里没有物品的分组（如某些情况下配件为 0 条）→ 从 meta 兜底，再不行用代码
    const bySub = new Map(metaStore.subcategories.map((o) => [o.value, o.label]))
    const byCat = new Map(metaStore.categories.map((o) => [o.value, o.label]))

    const out: MetaOption[] = []
    for (const def of GROUP_DEFS) {
      const count = counts.get(def.value) ?? 0
      // 兜底分组为 0 时不显示（正常情况下它永远是 0 —— 三个子类都提升了）
      if (def.value === 'props' && count === 0) continue
      const label =
        labels.get(def.value) ??
        (def.subcategory !== undefined ? bySub.get(def.subcategory) : undefined) ??
        byCat.get(def.categoryCode) ??
        def.value
      out.push({ value: def.value, label, count })
    }
    return out
  })

  /**
   * 每个分组的**下一级**选项（子类或细类）。
   *
   * 只给"被选中且真的有下一级"的分组算 ——
   * 实测：收集品有 9 个 itemSubtype、消耗品有 3 个 thirdClass、
   * 钥匙没有下一级（所以它**不会出现空行**）。
   *
   * 返回一个数组（而不是 Record），因为渲染顺序要跟 `groupOptions` 一致。
   */
  const subOptionsByGroup = computed<Array<{ group: string; label: string; options: MetaOption[] }>>(
    () => {
      const out: Array<{ group: string; label: string; options: MetaOption[] }> = []
      for (const g of groupOptions.value) {
        if (!groups.value.includes(g.value)) continue
        const def = groupDefOf(g.value)
        if (def === undefined) continue

        const acc = new Map<string, MetaOption>()
        for (const it of pool.value) {
          if (groupOf(it) !== g.value) continue
          // ⚠️ 跳过 `sub` 这一维（交叉计数），但**分组这一维要生效**
          if (!pass(it, 'sub')) continue
          const value = nextLevelValue(it, def.nextLevel)
          if (value === null || value === '') continue
          const found = acc.get(value)
          if (found) found.count += 1
          else acc.set(value, { value, label: nextLevelLabel(it, def.nextLevel) ?? value, count: 1 })
        }
        if (acc.size === 0) continue // ← 没有下一级 → 不显示空行

        out.push({
          group: g.value,
          label: g.label,
          options: [...acc.values()].sort(
            (a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'),
          ),
        })
      }
      return out
    },
  )

  /** 地图选项也带计数。`provenanceMaps` 是多值字段，所以单独数 */
  const mapOptions = computed<MetaOption[]>(() => {
    const acc = new Map<string, number>()
    for (const it of pool.value) {
      if (!pass(it, 'map')) continue
      for (const m of it.provenanceMaps ?? []) acc.set(m, (acc.get(m) ?? 0) + 1)
    }
    return [...acc.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN'))
  })

  const gradeOptions = computed<MetaOption[]>(() => {
    const acc = new Map<string, MetaOption>()
    for (const it of pool.value) {
      if (!pass(it, 'grade')) continue
      const value = String(it.grade)
      const found = acc.get(value)
      if (found) found.count += 1
      else acc.set(value, { value, label: it.gradeCn, count: 1 })
    }
    /**
     * ⚠️ **不列「灰」（品质 0）** —— 它与「枪械」分组是 1:1（实测 68 条全是枪），
     * 列出来只是多一个点击目标。想只看枪械就点「枪械」。
     */
    return [...acc.values()]
      .filter((o) => o.value !== '0')
      .sort((a, b) => Number(a.value) - Number(b.value))
  })

  /* ══════════════════ 界面辅助 ══════════════════ */

  const activeFilterCount = computed(() => {
    let n = 0
    if (search.value.trim() !== '') n += 1
    if (groups.value.length > 0) n += 1
    if (subs.value.length > 0) n += 1
    if (grades.value.length > 0) n += 1
    if (maps.value.length > 0) n += 1
    if (mapOnly.value) n += 1
    if (verdictFilter.value !== null) n += 1
    return n
  })

  /** 还能对子类做筛选的分组有几个（决定"子类筛选"开关要不要显示）*/
  const groupsWithSubs = computed(() => subOptionsByGroup.value.length)

  function groupDefOf(value: string): GroupDef | undefined {
    return GROUP_DEFS.find((g) => g.value === value)
  }

  /**
   * 切换一个顶层分组。
   *
   * ⚠️ 切分组会**清空所有子类选择**。理由：子类选项是"当前选中分组的下一级"，
   *    换了分组之后原来的子类可能根本不存在了（比如从「消耗品」切到「弹药」，
   *    「药品」这个子类就没了）。留着它会得到 0 条且看不出原因。
   */
  function toggleGroup(value: string): void {
    groups.value = groups.value.includes(value)
      ? groups.value.filter((g) => g !== value)
      : [...groups.value, value]
    subs.value = []
  }

  function clearGroups(): void {
    groups.value = []
    subs.value = []
  }

  function toggleGrade(g: number): void {
    grades.value = grades.value.includes(g)
      ? grades.value.filter((x) => x !== g)
      : [...grades.value, g]
  }

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

  function toggleSub(value: string): void {
    subs.value = subs.value.includes(value)
      ? subs.value.filter((s) => s !== value)
      : [...subs.value, value]
  }

  /** 某一行的「全部」：只清掉属于这一行的选择，不动别的行 */
  function clearSubsOf(groupValue: string): void {
    const def = groupDefOf(groupValue)
    if (def === undefined) return
    const own = new Set(
      subOptionsByGroup.value.find((r) => r.group === groupValue)?.options.map((o) => o.value) ?? [],
    )
    void def
    subs.value = subs.value.filter((s) => !own.has(s))
  }

  function setVerdictFilter(value: LootVerdict | null): void {
    verdictFilter.value = verdictFilter.value === value ? null : value
  }

  function resetFilters(): void {
    search.value = ''
    groups.value = []
    subs.value = []
    grades.value = []
    maps.value = []
    mapOnly.value = false
    verdictFilter.value = null
    // 注：`includeExcluded` 与排序**不重置** —— 前者是显示偏好，
    // 后者是"我在看哪一列"，都不是筛选条件。
  }

  /* ══════════════════ 持久化 ══════════════════ */

  watch(
    [
      search,
      groups,
      subs,
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
          groups: [...groups.value],
          subs: [...subs.value],
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
   * **跟着一起换**。不跟的话会出现"按单格价值排序、按单价判定"的自相矛盾。
   * 但用户已手动点了别的列（如今日涨幅）就不插手。
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
    groups,
    subs,
    grades,
    maps,
    mapOnly,
    verdictFilter,
    includeExcluded,
    sortKey,
    sortDir,
    subsExpanded,

    // 派生
    pool,
    rows,
    rowsBeforeVerdict,
    verdictCounts,
    groupOptions,
    subOptionsByGroup,
    groupsWithSubs,
    mapOptions,
    gradeOptions,
    activeFilterCount,

    // 动作
    toggleGroup,
    clearGroups,
    toggleSub,
    clearSubsOf,
    toggleGrade,
    setVerdictFilter,
    applySortChange,
    resetFilters,
  }
})
