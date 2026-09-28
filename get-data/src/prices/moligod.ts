/**
 * moligod 价格源适配器。
 *
 * 它是 v1 的**默认价格源**，因为实测下来它的性价比最高：
 *   · **1 次请求拿到全量 1718 条**（dergame 要 320 次）
 *   · 93KB / 轮，服务端自身缓存 5 分钟
 *   · 有现价 + 昨日均价 + 昨日高低 + 七日高低（能算涨幅，官方源给不了）
 *   · 价格是"现价"而不是"统计均价"，更接近游戏内实盘
 *
 * 代价是数据被 AES-GCM 包了一层（解密在 wire/moligod.ts）。
 * 伦理约束见那个文件的说明。
 */

import { z } from 'zod'
import type { FetchContext } from '../sources/types'
import { CONDITION_SUFFIX_RE, CONDITION_TIERS } from '../constants'
import { MOLIGOD_KEY_HEADER, MoligodWireError, decryptMoligodSnapshot } from '../wire/moligod'
import type { PriceQuote, PriceSource } from './types'

/**
 * 快照里单条物品的结构。
 *
 * 实测字段（抽样 200 条）：alias_name, base_price, category, category_cn,
 * current_price, display_name, grade, icon_url, id, item_subtype, last_update,
 * length, name, object_id, seven_day_high, seven_day_low, subcategory, width,
 * yesterday_avg_price, yesterday_high, yesterday_low
 *
 * 注意 `base_price` 实测是**字符串**（"2163983"），而 `current_price` 是数字。
 * 这是真实存在的类型陷阱，所以用 union 接受两种形态。
 */
/**
 * ⚠️⚠️ 实测发现的重要陷阱：同一个字段在同一个源里**类型不一致**。
 *
 * 1718 条里有 343 条的数值字段是**字符串**，其余 1375 条是数字：
 *
 *   {"name":"H70 精英头盔", "current_price":"2163983", ...}   ← 字符串
 *   {"name":"海洋之泪",    "current_price": 34275453,  ...}   ← 数字
 *
 * `base_price` 则**全部**是字符串。
 *
 * 所以数值字段一律用这个宽松模式接（number 或 string 或 null），
 * 再由下面的 toPrice / toFiniteOrNull 统一转换。
 * 如果按 `z.number()` 严格校验，那 343 条会被静默丢弃 ——
 * 而它们恰好是官方主数据要匹配的头盔/护甲，会连带把匹配率从 98% 拉到 78%。
 */
const lenientNumber = z.union([z.number(), z.string()]).nullish()

const MoligodItem = z.object({
  id: z.number().optional(),
  object_id: z.string().optional(),
  name: z.string(),
  display_name: z.string().nullish(),
  alias_name: z.string().nullish(),
  category: z.string().nullish(),
  category_cn: z.string().nullish(),
  subcategory: z.string().nullish(),
  item_subtype: z.string().nullish(),
  grade: z.string().nullish(),
  icon_url: z.string().nullish(),

  base_price: lenientNumber,
  current_price: lenientNumber,
  yesterday_avg_price: lenientNumber,
  yesterday_low: lenientNumber,
  yesterday_high: lenientNumber,
  seven_day_low: lenientNumber,
  seven_day_high: lenientNumber,

  width: z.number().nullish(),
  length: z.number().nullish(),
  last_update: z.string().nullish(),
})

const MoligodSnapshot = z.object({
  status: z.string().optional(),
  encoding: z.string().optional(),
  generated_at: z.number().optional(),
  ttl_seconds: z.number().optional(),
  total: z.number().optional(),
  items: z.array(z.unknown()),
})

/** 与官方源一致的价格归一化：`<= 0` 一律视为"无价格" */
function toPrice(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 可能是负数的价格字段（如区间下限），这里只要求"能转成有限数字" */
function toFiniteOrNull(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * 源侧更新时间清洗。
 * 实测这 343 条非卖品的 `last_update` 是字符串 `"N/A"` ——
 * 直接往下传会让网页显示一个叫 "N/A" 的时间，所以在这里就置空。
 */
function toUpdateTime(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed === '' || /^(n\/?a|null|undefined|-+)$/i.test(trimmed)) return null
  return trimmed
}

export const moligodPriceSource: PriceSource = {
  id: 'moligod',
  label: 'moligod',
  homepage: 'https://moligod.com/trade',
  priceBasis: 'moligod 现价（交易行最新成交参考），服务端约 5 分钟刷新',
  requestBudget: 1,

  /**
   * 实测出来的能力清单（不是按文档抄的）。
   *
   * ⚠️ `hasDurabilityVariants: true` 这个字段很关键 ——
   *    护甲的“裸名”价是**基础参考价、不是行情**，实时价在
   *    `（全新）/（几乎全新）/（破损）` 三档里（详见 constants.ts）。
   *    声明出来，网页才知道该显示三档而不是只显示一个数。
   *
   * `hasProvenance: false` —— 这是它最大的短板，也是官方接口不可替代的原因。
   */
  capabilities: {
    hasPrice: true,
    hasSlots: true,
    hasYesterdayAvg: true,
    hasYesterdayRange: true,
    hasRange: true,
    hasAlias: true,
    hasSubcategory: true,
    hasProvenance: false,
    hasDurabilityVariants: true,
  },

  async fetchPrices(ctx: FetchContext): Promise<Map<string, PriceQuote>> {
    const log = ctx.logger
    const url = `${ctx.config.moligodBaseUrl}/api/market/trade-house-snapshot`

    const res = await ctx.http.request(url, {
      headers: { Accept: '*/*' },
      signal: ctx.signal,
    })

    if (!res.ok) {
      throw new Error(`moligod 快照请求失败：HTTP ${res.status}`)
    }

    const keyHeader = res.headers.get(MOLIGOD_KEY_HEADER)
    if (!keyHeader) {
      throw new MoligodWireError(`响应里没有 ${MOLIGOD_KEY_HEADER} 头`)
    }

    // 原始密文留存 —— 万一以后协议变了，还能拿它对着一遍遍试
    await ctx.saveRaw('moligod/snapshot.bin', res.bytes())

    const payload = decryptMoligodSnapshot(res.bytes(), keyHeader)

    const parsed = MoligodSnapshot.safeParse(payload)
    if (!parsed.success) {
      throw new Error(
        `解密后的快照结构不符预期：${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`,
      )
    }

    const snap = parsed.data
    log.debug('moligod 快照已解密', {
      total: snap.total ?? snap.items.length,
      ttlSeconds: snap.ttl_seconds ?? null,
    })

    /* ---------------- 建立 名称 → 价格 的查找表 ---------------- */

    const byName = new Map<string, PriceQuote>()
    let dropped = 0
    let duplicateSkipped = 0

    for (const raw of snap.items) {
      const item = MoligodItem.safeParse(raw)
      if (!item.success) {
        dropped += 1
        continue
      }

      const m = item.data
      const quote: PriceQuote = {
        price: toPrice(m.current_price),
        basePrice: toPrice(m.base_price),
        yesterdayAvg: toPrice(m.yesterday_avg_price),
        yesterdayLow: toFiniteOrNull(m.yesterday_low),
        yesterdayHigh: toFiniteOrNull(m.yesterday_high),
        rangeLow: toFiniteOrNull(m.seven_day_low),
        rangeHigh: toFiniteOrNull(m.seven_day_high),
        updateTime: toUpdateTime(m.last_update),
      }

      // 用三个名字建索引，提高与官方主数据的匹配率（实测综合 98.4%）
      for (const key of [m.name, m.display_name, m.alias_name]) {
        if (typeof key !== 'string') continue
        const trimmed = key.trim()
        if (trimmed === '') continue

        const existing = byName.get(trimmed)
        if (existing) {
          // 重复时保留"有价格"的那一条（更可能是有用的那条）
          if (existing.price === null && quote.price !== null) {
            byName.set(trimmed, quote)
          } else {
            duplicateSkipped += 1
          }
          continue
        }
        byName.set(trimmed, quote)
      }
    }

    if (dropped > 0) log.warn('moligod 条目校验失败已丢弃', { dropped })

    const variantsMerged = mergeConditionVariants(byName)
    if (variantsMerged > 0) {
      log.info('moligod 护甲耐久度分档已合并', { armors: variantsMerged })
    }

    log.info('moligod 价格抓取完成', {
      items: snap.items.length,
      indexKeys: byName.size,
      withPrice: [...byName.values()].filter((q) => q.price !== null).length,
      withVariants: variantsMerged,
    })

    return byName
  },
}

/**
 * ⭐ 把「带耐久度后缀」的价格条目合并回**裸名**，放进 `variants`。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 为什么需要这一步
 * ═══════════════════════════════════════════════════════════════════
 * moligod 把每件护甲按耐久度拆成 3 个条目：
 *
 *   `H70 精英头盔（全新）` / `H70 精英头盔（几乎全新）` / `H70 精英头盔（破损）`
 *
 * 而官方主数据里**只有一条** `H70 精英头盔`。不管的话：
 *   · 名字对不上 → 拿不到价（实测 8 件头盔就是这样）
 *   · 而带裸名的 51 件拿到的是那个**非实盘的基础参考价**（见 constants.ts）
 *
 * 所以把三档合并回裸名，让 join 能像普通物品一样按裸名匹配。
 *
 * ⚠️ 两个容易踩的坑：
 *   1. `byName` 里同一个 quote 对象挂在 3 个键下（name/display_name/alias_name），
 *      **直接改字段会污染其它键** —— 所以一律 `{ ...quote }` 造新对象。
 *   2. 裸名条目**可能不存在**（如 `D6 战术头盔`），此时要造一条空壳，
 *      但 `price` 留 null —— 适配器**不选档**，选档是 metrics 的事。
 *
 * 抽成独立函数的另一个原因：它在 `fetchPrices` 里，而那个函数要发 HTTP，
 * 单测里不好直接调。分离出来就能用一份现成的假数据把逻辑测穷。
 *
 * @returns 合并了多少件（0 表示源里没有分档，正常情况）
 */
export function mergeConditionVariants(byName: Map<string, PriceQuote>): number {
  /** 裸名 → { 档位 → 价格 }。用 Map 而不是对象，因为档位名是中文，也是动态的 */
  const byBase = new Map<string, Map<string, number | null>>()

  for (const [key, quote] of byName) {
    const m = CONDITION_SUFFIX_RE.exec(key)
    if (!m) continue
    const base = key.slice(0, m.index)
    if (base === '') continue

    let tiers = byBase.get(base)
    if (!tiers) {
      tiers = new Map()
      byBase.set(base, tiers)
    }
    /**
     * 不需要去重：裸名是由键**去掉末尾后缀**得到的，
     * 所以“不同键 → 相同裸名”只可能发生在键完全相同的情况下，
     * 而 `byName` 是 Map —— 同一个键只有一个值。
     *
     * （最初写了一段“同档位保留有价的那条”的守卫，实测发现是**死代码**，
     *   而且它会掩盖真实数据里的怪事。删掉。）
     */
    tiers.set(m[1]!, quote.price)
  }

  let merged = 0
  for (const [base, tiers] of byBase) {
    // 按 CONDITION_TIERS 的固定顺序插入 —— 插入顺序就是网页上的显示顺序
    const variants: Record<string, number | null> = {}
    for (const tier of CONDITION_TIERS) {
      if (tiers.has(tier)) variants[tier] = tiers.get(tier)!
    }
    if (Object.keys(variants).length === 0) continue

    const bare = byName.get(base)
    byName.set(base, bare ? { ...bare, variants } : { ...EMPTY_QUOTE, variants })
    merged += 1
  }

  return merged
}

/** 一条“字段全空”的报价 —— 给只有分档、没有裸名的护甲用 */
const EMPTY_QUOTE: Omit<PriceQuote, 'variants'> = {
  price: null,
  basePrice: null,
  yesterdayAvg: null,
  yesterdayLow: null,
  yesterdayHigh: null,
  rangeLow: null,
  rangeHigh: null,
  updateTime: null,
}
