/**
 * 名称 join —— 把"物品主数据"和"价格"拼起来。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要按名称拼
 * ═══════════════════════════════════════════════════════════════════════
 * 官方源给的是 `objectID`（如 15080050142），moligod 给的是它自己的 `id`
 * 和 `object_id`。两边的数字 ID 体系并不相通。
 *
 * 但实测发现：**两边的物品名称几乎完全一致** —— 所以名称是最可靠的 join 键。
 *
 * 为什么不做"模糊匹配"来多捞几条：
 * 模糊匹配可能把两个不同物品错配到一起（比如只差一个空格的同类物品），
 * 那种错误比"匹配不上"危险得多 —— 会让你看着一个错误的价格去做决策。
 * 所以这里只做**精确匹配（去掉首尾空白后）**，匹配不上就老实显示"暂无价格"。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要分三种结果（重要）
 * ═══════════════════════════════════════════════════════════════════════
 * 一开始我只统计一个"匹配率"，结果发现了问题：
 * 官方有 277 条非卖品，它们的名字**能**在价格源里找到，只是源里标着"无价格"。
 * 如果把这种情况也算成"没匹配上"，匹配率会显得很低，而实际上 join 是对的。
 *
 * 所以拆成三个互不重叠的桶：
 *   ① 匹配 + 有价格   ← 真正可用的数据
 *   ② 匹配 + 无价格   ← join 正确，只是这个物品本身非卖品
 *   ③ 名字找不到      ← 真正需要关注的问题（两边命名不一致或源缺条目）
 *
 * ⭐ `nameMatchRate` 用来看"两边命名是否对得上"（①②之和），
 *    `priceCoverage` 用来看"有多少物品真的能显示价格"（只有 ①）。
 */

import type { Grade } from '@deltaforce/shared'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'
import { GRADE_CN } from './constants'
import { hasEffectivePrice } from './metrics'

/** 一条拼好价格的物品 */
export interface JoinedItem {
  /** 主数据（来自物品主数据源） */
  item: SourceItem
  /** 价格（来自价格源）。名字没找到时为 null。 */
  quote: PriceQuote | null
  /** 实际用来匹配的名称；名字没找到时为 null */
  matchedBy: string | null
}

/** 用于诊断的样本 */
export interface JoinSample {
  name: string
  categoryCode: string
  subcategory: string
  /** 官方自己的均价，用于判断"本来该不该有价格" */
  officialAvgPrice: number | null
}

export interface JoinStats {
  total: number
  /** ① 匹配上且有价格 */
  matchedWithPrice: number
  /** ② 匹配上但源说无价格（非卖品） */
  matchedNoPrice: number
  /** ③ 名称在价格源里找不到 */
  notFound: number
  /** 其中靠“品质前缀”兜底找到的（修复 `.300BLK` 这类同名不同品质的物品） */
  matchedViaFallback: number
  /** 名称能找到的比例 = (①+②)/total。用来判断两份数据是否系统性错位。 */
  nameMatchRate: number
  /** 有价格的比例 = ①/total。用户真正关心的那个数。 */
  priceCoverage: number
  /** ①的名称匹配率 */
  notFoundSample: JoinSample[]
  /** ③的样本，优先列有官方均价的（说明本该有价格） */
  noPriceSample: JoinSample[]
}

export interface JoinResult {
  items: JoinedItem[]
  stats: JoinStats
}

/** 匹配时统一的规范化：只去首尾空白，不做其它变形（避免错配） */
function normalizeKey(name: string): string {
  return name.trim()
}

/**
 * ⭐ 名字**精确匹配不到**时的兜底候选。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 实测出来的坑：moligod 给“同名但不同品质”的子弹加了**品质前缀**
 * ═══════════════════════════════════════════════════════════════════
 *
 *   官方：`.300BLK` × 3 条（品质 5 / 4 / 3，官方均价 5174 / 1717 / 439）
 *   moligod：`金.300BLK`（5，5193）/ `紫.300BLK`（4，1757）/ `蓝.300BLK`（3，452）
 *
 * 三者价格差 **11 倍**。而按名称精确匹配 → **一条都配不上** → 三条子弹都没价。
 *
 * 修复方式不能放在适配器里：那里只有一个“名称 → 价格”的 Map，
 * 三个前缀拆开后映射到同一个裸名，会**三条互盖**（只剩一条）。
 * 而 join 这一层能看到物品的品质，所以能精确命中对的那一条。
 *
 * 为什么敢确信前缀 = 品质：实测前缀字符集恰好是 `{红金紫蓝绿白}`，
 * 与 `GRADE_CN` 的 7 个值一致；且拼出来的键**一定命中**且值跟官方均价
 * 相差不到 5%。
 *
 * ⚠️ 只在**精确匹配失败后**才试，不会影响现有的 1283 条匹配。
 */
function fallbackKeys(item: SourceItem): string[] {
  const name = item.name.trim()
  /**
   * `SourceItem.grade` 刻意是宽松的 `number`（原始数据可能越界，
   * 收窄成 `Grade` 是 normalize 的事）。所以这里要自己兑一下边界：
   * 越界的品质**不猜前缀**，返回空数组（宁可没价，也不要拿错档的价）。
   */
  const gradeCn: string | undefined = GRADE_CN[item.grade as Grade]
  if (!gradeCn) return []
  // 两种前缀写法都试：`金.XXX`（moligod 实际用法）与 `金XXX`（无分隔符时）
  return [`${gradeCn}.${name}`, `${gradeCn}${name}`]
}

/** 诊断样本排序：有官方均价 +2，有子类信息 +1 */
function diagnosticScore(x: JoinSample): number {
  return (x.officialAvgPrice !== null ? 2 : 0) + (x.subcategory ? 1 : 0)
}

export function joinPrices(
  sourceItems: readonly SourceItem[],
  prices: ReadonlyMap<string, PriceQuote>,
): JoinResult {
  const items: JoinedItem[] = []
  const notFoundSample: JoinSample[] = []
  const noPriceSample: JoinSample[] = []
  let matchedWithPrice = 0
  let matchedNoPrice = 0
  let matchedViaFallback = 0

  for (const item of sourceItems) {
    const key = normalizeKey(item.name)
    let quote = prices.get(key) ?? null
    let matchedBy: string | null = quote ? key : null

    // 精确匹配失败 → 试品质前缀（修复 `.300BLK` 这类同名不同品质的物品）
    if (quote === null) {
      for (const candidate of fallbackKeys(item)) {
        const hit = prices.get(candidate)
        if (hit) {
          quote = hit
          matchedBy = candidate
          matchedViaFallback += 1
          break
        }
      }
    }

    const sample: JoinSample = {
      name: item.name,
      categoryCode: item.categoryCode,
      subcategory: item.subcategoryCn ?? item.subcategory,
      officialAvgPrice: item.officialAvgPrice,
    }

    if (quote === null) {
      notFoundSample.push(sample)
    } else if (!hasEffectivePrice(quote)) {
      matchedNoPrice += 1
      noPriceSample.push(sample)
    } else {
      matchedWithPrice += 1
    }

    items.push({ item, quote, matchedBy })
  }

  const total = sourceItems.length

  return {
    items,
    stats: {
      total,
      matchedWithPrice,
      matchedNoPrice,
      notFound: notFoundSample.length,
      matchedViaFallback,
      nameMatchRate: total > 0 ? (matchedWithPrice + matchedNoPrice) / total : 0,
      priceCoverage: total > 0 ? matchedWithPrice / total : 0,
      notFoundSample: notFoundSample.sort((a, b) => diagnosticScore(b) - diagnosticScore(a)).slice(0, 20),
      noPriceSample: noPriceSample.sort((a, b) => diagnosticScore(b) - diagnosticScore(a)).slice(0, 10),
    },
  }
}
