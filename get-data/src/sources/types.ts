/**
 * 物品主数据源的适配器契约。
 *
 * ⭐ 这是全项目的**扩展点**：加一个新源 = 写一个实现这个接口的文件
 *    + 在 registry.ts 里加一行。前端与 API 一行不改。
 *
 * 铁律：适配器**只做翻译，不做计算**。
 *   它把源站的 JSON 翻译成 SourceItem（原料字段），
 *   但绝不计算 slots / pricePerSlot / todayChangePct ——
 *   那些派生指标由 metrics.ts 统一算。
 *   否则换个源，同一个物资的排名就变了，而你说不清为什么变。
 */

import type { Grade, ItemSourceId, SourceCapabilities } from '@deltaforce/shared'
import type { AppConfig } from '../config'
import type { HttpClient } from '../http'
import type { Logger } from '../logger'

/**
 * 适配器拿到的运行环境。
 *
 * 注意 `saveRaw`：每个适配器都应该把**原始响应**存一份到 data/raw/。
 * 为什么：将来源改版、字段含义变了，你可以拿历史原始响应重新解析一遍，
 * 不用重新抓、也不用猜"数据是什么时候变的"。这是排查这类问题的唯一手段。
 *
 * 注：本接口被物品源与价格源两类适配器共用，所以定义在 sources/ 下，
 *     prices/ 从这import。
 */
export interface FetchContext {
  readonly config: AppConfig
  readonly logger: Logger
  readonly http: HttpClient
  readonly signal: AbortSignal
  saveRaw(name: string, data: Uint8Array | string): Promise<void>
}

/**
 * 适配器的产出：**只有原料，没有任何派生指标**。
 *
 * 字段全部是可空的宽松类型（`grade: number` 而不是 `Grade`），
 * 因为源站什么都可能返回。真正的收窄与校验在 normalize.ts 里做，
 * 那里会把不合法的值丢掉并记日志。
 */
export interface SourceItem {
  /** 源侧物品 ID。官方源即 objectID（字符串化）。 */
  sourceItemId: string

  /* ---- 展示信息 ---- */
  name: string
  /** 别名 / 游戏内俗称（moligod 有，官方没有） */
  alias: string | null
  description: string | null
  iconUrl: string
  /** 小图标（列表页用，省流量）。官方源对应 prePic。 */
  thumbUrl: string | null

  /* ---- 分类（三级） ---- */
  /** 大类代码：props / acc / ammo / protect / gun / vehicle / skin */
  categoryCode: string
  /** 子类代码：collection / key / consume / mandel / helmet ... */
  subcategory: string
  /** 子类中文名。官方源直接给了 secondClassCN；缺时由后端映射表补。 */
  subcategoryCn: string | null
  /** 第三级分类代码（实测只有消耗品有：repair / drug / inject） */
  thirdClass: string | null
  thirdClassCn: string | null
  /** 更细的类型说明，如"工艺藏品" */
  itemSubtype: string | null

  /* ---- 出产地（原始字符串，切分交给 provenance.ts） ---- */
  /** 官方的 `propsDetail.propsSource` 原样值，如 "长弓溪谷-钻石皇后酒店,航天基地-核心区" */
  rawProvenance: string | null

  /* ---- 品质与规格 ---- */
  /** 原始品质值，预期的合法范围是 0~6，但这里不校验 */
  grade: number
  /** 重量。源里是字符串（可能是 ""），适配器负责转成数字或 null。 */
  weight: number | null
  /** 占格：宽。可能为 0（载具/皮肤）。 */
  width: number
  /** 占格：长 */
  length: number

  /* ---- 价格原料 ---- */
  /** 源侧基准价 / 商店价 */
  basePrice: number | null
  /**
   * 官方给的统计均价。
   * ⚠️ 实测它是"近期平均交易价格"，与游戏内实盘误差大，**不参与判定**，
   *    只保留下来做对照展示。
   */
  officialAvgPrice: number | null

  /* ---- 时间 ---- */
  /** 源侧标注的最后更新时刻（原样字符串，如 "2026-09-28 14:24"） */
  lastUpdate: string | null

  /* ---- 原始数据 ---- */
  /** ⚠️ 变长结构，按 subcategory/thirdClass 形状完全不同，原样保留不建固定类型 */
  propsDetail: Record<string, unknown> | null
}

export interface ItemSource {
  readonly id: ItemSourceId
  /** 显示名，如"腾讯官方接口" */
  readonly label: string
  /** 站点首页，用于网页标注来源 */
  readonly homepage: string
  readonly capabilities: SourceCapabilities
  /** 一轮抓取需要多少次请求（用于日志与"对源站负担"的自我约束） */
  readonly requestBudget: number
  fetchItems(ctx: FetchContext): Promise<ItemFetchResult>
}

/**
 * 物品源一次抓取的结果。
 *
 * ⭐ 为什么要有「部分失败」这个概念：
 * 官方源一轮要发 7 次请求（每个大类一次）。如果其中 1~2 个失败就丢掉整批，
 * 那就是**因为一个分类的临时故障而让另外 1500 条数据白抓**。
 * 所以适配器要如实报告哪些分区成功了，让上层能用旧快照的对应分区补齐。
 */
export interface ItemFetchResult {
  items: SourceItem[]
  /**
   * 抓取成功的分区键。
   * 约定：**分区键等于 `SourceItem.categoryCode`** ——上层据此判断
   * "某个分类失败时，旧快照里哪些条目应该被保留"。
   */
  okPartitions: string[]
  /** 抓取失败的分区及原因 */
  failedPartitions: Array<{ key: string; error: string }>
}

/** 便于 normalize 收窄 grade 时复用 */
export type { Grade }
