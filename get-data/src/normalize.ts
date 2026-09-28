/**
 * normalize —— 把三方数据拼成最终的 `Item`。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它在哪里
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   官方适配器 ──┐
 *                ├─→ join（按名称）──┐
 *   价格适配器 ──┘                    ├─→ **normalize** ──→ Item[] ──→ 网页
 *   出产地覆盖 ──────────────────────┤
 *   可获得性覆盖 ────────────────────┘
 *
 * 它是**纯函数**：不碰网络、不碰文件、不读环境变量、不改入参。
 * 所有外部依赖（两个覆盖映射、已知地图名、抓取时刻）都从参数传进来。
 * 好处：单测可以直接喂数据，不需要任何 mock。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它做三类事
 * ═══════════════════════════════════════════════════════════════════════
 *  ① 补全与回退 —— 源里缺的字段用映射表补上，实在没有就回退到代码本身
 *  ② 收窄与守卫 —— 把源里的宽松值收窄成契约要求的严格类型（见下面的坑列表）
 *  ③ 组装 —— 调用 metrics.ts 算出派生指标（**绝不自己算**）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这里集中处理了 Phase 3 实测踩到的所有字段陷阱
 * ═══════════════════════════════════════════════════════════════════════
 *   · `grade` 可能是负数、小数、超范围 → clampGrade 收窄成 0~6
 *   · `weight` 是字符串、可能是空串 → 适配器已转数字，这里再兜一次
 *   · `width`/`length` 为 0（载具/皮肤）→ slots=0、pricePerSlot=null、carryable=false
 *   · `price <= 0` 是"非卖品"不是"零元" → null
 *   · `lastUpdate` 可能是 `"N/A"` → 适配器已清洗，这里再兜一次
 *   · `categoryCn`/`subcategoryCn` 缺失 → 回退到代码本身，不让网页显示空白
 */

import type {
  GradeTone,
  Item,
  ItemAvailability,
  ItemSourceId,
  ProvenanceSource,
} from '@deltaforce/shared'
import { CATEGORY_CN, GRADE_CN, GRADE_COLOR, GRADE_TONE } from './constants'
import type { JoinedItem } from './join'
import {
  clampGrade,
  computePricePerSlot,
  pickEffectivePrice,
  computeSlots,
  computeTodayChangePct,
  isCarryable,
  isItemStale,
} from './metrics'
import { resolveUnitsPerSlot, type AppliedItemAttributes } from './overrides/item-attributes'
import type { AppliedProvenance } from './overrides/provenance'
import { expandAllMaps, parseProvenanceMaps } from './provenance'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'

export interface NormalizeOptions {
  /** 主数据源 id（用于组装 `key`，如 `official:15080050142`） */
  itemSource: ItemSourceId
  /** 覆盖合并后的出产地（按 sourceItemId 索引） */
  provenance: ReadonlyMap<string, AppliedProvenance>
  /** 覆盖合并后的物品属性（可获得性 / 可上架 / 每格单位数，按 sourceItemId 索引） */
  attributes: ReadonlyMap<string, AppliedItemAttributes>
  /** 全部已知地图名 —— 用于把特殊值 `全地图` 展开成明确的地图 */
  allMapNames: readonly string[]
  /**
   * 源侧数据超过这么多小时就算"陈旧"。
   * ⚠️ 这里指的是**某一条物品的价格数据**陈旧，不是"整份快照"陈旧。
   */
  staleAfterHours: number
  /** 本次抓取的时刻（ISO 8601）。由调用方传入，便于测试时固定时间。 */
  fetchedAt: string
  /** 用于判断陈旧与否的"当前时间"；默认真实当前时间 */
  now?: Date
}

export interface NormalizeStats {
  total: number
  /** 有可用的现价 */
  withPrice: number
  /** 能算单格价值（有价格且占格 > 0） */
  withPricePerSlot: number
  /** 能塞进背包（占格 > 0） */
  carryable: number
  /** 有出产地数据 */
  withProvenance: number
  /** 其中来自人工补充/合并的 */
  manualProvenance: number
  /** 源侧数据陈旧的 */
  stale: number
  /** 按可获得性分类的计数 */
  byAvailability: Record<ItemAvailability, number>
  /** 不可上架交易行的数量 */
  notListable: number
  /** 单格价值算不出来的数量（主要是没标每组发数的弹药） */
  unitsUnknown: number
}

export interface NormalizeResult {
  items: Item[]
  stats: NormalizeStats
}

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

/** 数字兜底：只接受有限数字，其它一律 null */
function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 价格兜底：`<= 0` 视为"无价格"（实测官方与 moligod 都会出现 0） */
function priceOrNull(v: number | null | undefined): number | null {
  const n = numOrNull(v)
  return n !== null && n > 0 ? n : null
}

/** 非负整数兜底（占格用） */
function slotOrZero(v: number | null | undefined): number {
  const n = numOrNull(v)
  return n !== null && n > 0 ? Math.trunc(n) : 0
}

/** 时间字符串兜底：空串、"N/A"、"null" 之类一律当作没有 */
function timestampOrNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (t === '' || /^(n\/?a|null|undefined|-+)$/i.test(t)) return null
  return t
}

/* ══════════════════════════════════════════════════════════════════════
 * 单条转换
 * ══════════════════════════════════════════════════════════════════════ */

export function normalizeItem(joined: JoinedItem, options: NormalizeOptions): Item {
  const { item: raw, quote } = joined
  return normalizeFromParts(raw, quote, options)
}

/** 拆出来是为了让测试可以只喂 (SourceItem, PriceQuote) 两个参数 */
export function normalizeFromParts(
  raw: SourceItem,
  quote: PriceQuote | null,
  options: NormalizeOptions,
): Item {
  const now = options.now ?? new Date()

  /* ---------- 分类：源里缺中文名时回退到代码本身 ---------- */
  const categoryCn = CATEGORY_CN[raw.categoryCode] ?? raw.categoryCode
  const subcategory = raw.subcategory ?? ''
  const subcategoryCn = raw.subcategoryCn?.trim() || subcategory || '未分类'

  /* ---------- 品质：收窄成 0~6，再查三张表 ---------- */
  const grade = clampGrade(raw.grade)
  const gradeCn = GRADE_CN[grade]
  const gradeTone: GradeTone = GRADE_TONE[grade]
  const gradeColor = GRADE_COLOR[grade]

  /* ---------- 占格与可携性 ---------- */
  const width = slotOrZero(raw.width)
  const length = slotOrZero(raw.length)
  const slots = computeSlots(width, length)
  const carryable = isCarryable(slots)

  /* ---------- 价格 ---------- */
  /**
   * ⭐ 用于排序与判定的价。
   *
   * 不能用 `quote.price` 直接赋值 —— 护甲的 `quote.price` 是**基础参考价**，
   * 不是行情。`pickEffectivePrice` 会按 `ARMOR_PRICE_TIER` 改取耐久度分档里的
   * 那一档（默认「破损」，保守）。选档规则只在那里实现一份。
   */
  const price = priceOrNull(pickEffectivePrice(quote))
  const basePrice = priceOrNull(quote?.basePrice ?? null)
  const officialAvgPrice = priceOrNull(raw.officialAvgPrice)
  const yesterdayAvg = priceOrNull(quote?.yesterdayAvg ?? null)

  /* ---------- 出产地：展开特殊值 `全地图` ---------- */
  const appliedProv = options.provenance.get(raw.sourceItemId)
  /**
   * ⭐ 覆盖映射里没这条时，**回退到官方原始值**。
   *
   * 不能假设调用方一定传了完整映射（`applyProvenanceOverrides` 确实会为**每一条**
   * 物品都产出一条记录，但那是那个函数的实现细节，不该成为这里的隐含前提）。
   * 一条遗漏就会让出产地静默变成空，而且很难查 —— 这是实测出来的真 bug。
   */
  const baseMaps = appliedProv ? appliedProv.maps : parseProvenanceMaps(raw.rawProvenance)
  const provenanceMaps = expandAllMaps(baseMaps, options.allMapNames)

  let provenanceSource: ProvenanceSource | null = null
  if (appliedProv) {
    if (provenanceMaps !== null) {
      provenanceSource = appliedProv.source
    } else if (appliedProv.source === 'manual') {
      // 人工写空数组 = “官方说有，但我确认它没有”
      // 保留 manual 是为了让网页能区分“官方没给数据”和“你确认没有出产地”
      provenanceSource = 'manual'
    }
  } else if (provenanceMaps !== null) {
    provenanceSource = 'official'
  }

  /* ---------- 物品属性（可获得性 / 可上架 / 每格单位数） ---------- */
  const appliedAttr = options.attributes.get(raw.sourceItemId)
  const availability: ItemAvailability = appliedAttr?.availability ?? 'lootable'
  const listable = appliedAttr?.listable ?? true
  const unitsPerSlot = resolveUnitsPerSlot(raw.categoryCode, appliedAttr)

  /* ---------- 时间 ----------
   * ⚠️ `lastUpdate` 优先取**价格源**的时间。
   * 因为会变化的是价格；官方物品列表根本不带更新时间字段。
   */
  const lastUpdate = timestampOrNull(quote?.updateTime) ?? timestampOrNull(raw.lastUpdate)

  return {
    key: `${options.itemSource}:${raw.sourceItemId}`,
    source: options.itemSource,
    sourceItemId: raw.sourceItemId,

    name: raw.name,
    // 展示名就是官方名；别名单独放在 alias 里由网页决定怎么用
    displayName: raw.name,
    alias: raw.alias?.trim() || null,
    description: raw.description?.trim() || null,
    iconUrl: raw.iconUrl,
    thumbUrl: raw.thumbUrl,

    categoryCode: raw.categoryCode,
    categoryCn,
    subcategory,
    subcategoryCn,
    thirdClass: raw.thirdClass,
    thirdClassCn: raw.thirdClassCn?.trim() || null,
    itemSubtype: raw.itemSubtype?.trim() || null,

    provenanceMaps,
    provenanceSource,

    availability,
    availabilityNote: appliedAttr?.note ?? null,
    listable,
    unitsPerSlot,
    seasonal: appliedAttr?.seasonal ?? null,

    grade,
    gradeCn,
    gradeTone,
    gradeColor,

    price,
    basePrice,
    priceVariants: quote?.variants ? { ...quote.variants } : null,
    officialAvgPrice,
    weight: numOrNull(raw.weight),
    width,
    length,

    slots,
    pricePerSlot: computePricePerSlot(price, slots, unitsPerSlot),
    todayChangePct: computeTodayChangePct(price, yesterdayAvg),
    yesterdayAvg,
    yesterdayLow: numOrNull(quote?.yesterdayLow ?? null),
    yesterdayHigh: numOrNull(quote?.yesterdayHigh ?? null),
    rangeLow: numOrNull(quote?.rangeLow ?? null),
    rangeHigh: numOrNull(quote?.rangeHigh ?? null),

    carryable,

    lastUpdate,
    fetchedAt: options.fetchedAt,
    stale: isItemStale(lastUpdate, options.staleAfterHours, now),

    propsDetail: raw.propsDetail,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 批量转换 + 统计
 * ══════════════════════════════════════════════════════════════════════ */

export function normalizeItems(
  joined: readonly JoinedItem[],
  options: NormalizeOptions,
): NormalizeResult {
  const items: Item[] = []
  const byAvailability: Record<ItemAvailability, number> = {
    lootable: 0,
    unobtainable: 0,
    expired: 0,
  }

  let withPrice = 0
  let withPricePerSlot = 0
  let carryable = 0
  let withProvenance = 0
  let manualProvenance = 0
  let stale = 0
  let notListable = 0
  let unitsUnknown = 0

  for (const j of joined) {
    const item = normalizeFromParts(j.item, j.quote, options)
    items.push(item)

    if (item.price !== null) withPrice += 1
    if (item.pricePerSlot !== null) withPricePerSlot += 1
    if (item.carryable) carryable += 1
    if (!item.listable) notListable += 1
    if (item.unitsPerSlot === null) unitsUnknown += 1
    if (item.provenanceMaps !== null) {
      withProvenance += 1
      if (item.provenanceSource === 'manual' || item.provenanceSource === 'merged') {
        manualProvenance += 1
      }
    }
    if (item.stale) stale += 1
    byAvailability[item.availability] += 1
  }

  return {
    items,
    stats: {
      total: items.length,
      withPrice,
      withPricePerSlot,
      carryable,
      withProvenance,
      manualProvenance,
      stale,
      byAvailability,
      notListable,
      unitsUnknown,
    },
  }
}
