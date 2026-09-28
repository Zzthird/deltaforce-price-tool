/**
 * 价格源的适配器契约。
 *
 * ⭐ 为什么价格要单独一类适配器：
 *   官方接口只给"近期平均交易价格"（官方小程序自述"仅供参考，实时价请去
 *   游戏内交易行查看"），实测误差大、无法体现波动 —— 所以官方**不能做价格源**。
 *   但官方的静态数据（名称/官方ID/占格/品质/三级分类/出产地/描述/重量）
 *   是第三方没有的。于是拆开：官方出主数据，第三方出现价，两边按名称 join。
 *
 * 这个拆分的直接收益：**换价格源 = 写 1 个文件 + 注册表加 1 行**。
 * 将来换成付费的"数据帝" API 时，前端与 API 一行都不用改。
 *
 * 铁律同物品源：适配器只提供**价格原料**，不算派生指标。
 */

import type { PriceSourceId, SourceCapabilities } from '@deltaforce/shared'
import type { FetchContext } from '../sources/types'

/**
 * 一个物品的价格快照。
 *
 * 全部字段可空 —— 因为不同源能提供的字段不同，同一源对不同物品也可能缺数据。
 * 网页会依据 `SourceStatus.capabilities` 自动隐藏取不到的列，
 * 而不是显示 `undefined`。
 */
export interface PriceQuote {
  /** 当前价（哈夫币）。null = 非卖品或源没给。注意 `0` 也要归一化成 null。 */
  price: number | null
  /** 源侧基准价 / 商店价（moligod 的 `base_price`，注意它是字符串） */
  basePrice: number | null
  /** 昨日均价 —— 有它才能算"今日涨幅" */
  yesterdayAvg: number | null
  yesterdayLow: number | null
  yesterdayHigh: number | null
  /** 更长时间区间（如 7 日）的低/高 */
  rangeLow: number | null
  rangeHigh: number | null
  /** 源侧标注的更新时间（原样字符串） */
  updateTime: string | null

  /**
   * 同一物品的**多状态报价** —— 目前只有护甲/头盔用（按耐久度分三档）。
   *
   * 键是数据源给的原始状态标签（如「全新」「几乎全新」「破损」），
   * **插入顺序即显示顺序**（由适配器按 `CONDITION_TIERS` 插入）。
   * 用宽松的 `string` 做键而不是枚举：将来源多给一档时不用改类型。
   *
   * ⚠️ 有两件事分得很清楚：
   *   · **提供原料**（这个 Map）：适配器的责任
   *   · **选哪一档来排序**（见 `metrics.pickEffectivePrice`）：派生指标的选取规则
   *
   * 后者刻意不在适配器里做 —— 否则换价格源时排序会跟着变
   * （架构铁律 1：派生指标只在 `metrics.ts` 算）。
   *
   * 普通物品没有这个字段（`undefined`），表示“只有一个价”。
   */
  variants?: Readonly<Record<string, number | null>>
}

export interface PriceSource {
  readonly id: PriceSourceId
  readonly label: string
  readonly homepage: string
  /**
   * 能力声明。
   *
   * ⭐ 这是“无痛换源”的另一半：不同源能给的字段不同。
   * 网页据此**自动隐藏或降级**对应列，而不是显示 undefined。
   * 例：某个源没有昨日均价 → 网页隐藏“今日涨幅”列。
   *
   * 物品源也有同样的字段（`ItemSource.capabilities`），
   * 两边合起来决定网页上哪些列可用。
   */
  readonly capabilities: SourceCapabilities
  /**
   * 价格口径说明，会**原样显示在网页上**。
   * 因为不同源的口径不同（现价 vs 挂单价 vs 均价），不标注会误导判定。
   * 例："moligod 现价（交易行最新成交参考），5 分钟刷新"
   */
  readonly priceBasis: string
  readonly requestBudget: number
  /**
   * 抓取价格。
   *
   * 返回的 Map 的键是**物品名称**，因为与主数据源的 join 就是按名称做的
   * （实测官方与 moligod 的名称匹配率 1549/1574 = 98.4%）。
   * 一个源可以为同一个物品提供多个键（如同时用 name 和 display_name 建索引），
   * 提高匹配率。
   *
   * ⚠️ 但**名称不是唯一的** —— 实测官方有 6 组同名物品（13 条），
   * 最坑的是 `.300BLK`：3 条不同品质的子弹共用一个名字，
   * moligod 靠加品质前缀区分（`金.300BLK` / `紫.300BLK` / `蓝.300BLK`）。
   * 这种“名字对不上”的兑底不能用名称 Map 解决（会三条互盖），
   * 所以放在 `join.ts` 里做 —— 那里能看到物品的品质。
   */
  fetchPrices(ctx: FetchContext): Promise<Map<string, PriceQuote>>
}
