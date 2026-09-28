/**
 * 派生指标 —— **全项目唯一实现处**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 铁律：适配器只提供原料，加工一律在这里做。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 为什么这么较真？假想一下：让 moligod 适配器和 dergame 适配器各自算
 * "单格价值"，moligod 算 `price / slots`，dergame 顺手 `Math.floor` 取整。
 * 你换个源，同一个物资的排名就变了 —— **而你说不清为什么变**。
 *
 * 这不是洁癖，是**可解释性**。所有派生口径只有一份实现，才能保证
 * "同一份原料数据，在任何源下算出同样的结果"。
 *
 * 另外，这些函数全是纯函数（无副作用、不依赖外部状态），所以可以单独写单测
 * —— Phase 5 会做。
 */

import type { Grade } from '@deltaforce/shared'
import type { ConditionTier } from './constants'
import { ARMOR_PRICE_TIER } from './constants'

/** 品质的合法取值上界 */
const MAX_GRADE = 6

/**
 * 占格总数 = 宽 × 长。
 *
 * ⚠️ 这是**除零守卫的第一道**：宽或长非正数时返回 0，
 * 让后续的 pricePerSlot 变成 null 而不是 Infinity。
 * 官方数据里 16 条载具和 10 条皮肤的 width/length 都是 0。
 */
export function computeSlots(width: number, length: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(length)) return 0
  if (width <= 0 || length <= 0) return 0
  return Math.trunc(width) * Math.trunc(length)
}

/**
 * ⭐ 从报价里挑出**真正用于排序和判定**的那个价。
 *
 * 大多数物品就是 `quote.price`（源给的现价）。
 *
 * 护甲/头盔例外：数据源按耐久度给了三档实时行情，而它的“裸名价”
 * 是**基础参考价、不是行情**（详见 `constants.ts` 里的实测记录）。
 * 此时必须改用 `variants` 里的某一档。用哪一档由 `ARMOR_PRICE_TIER` 定。
 *
 * 为什么放在这里而不在适配器里：
 * “用哪一档来排序”是**派生指标的选取规则**，不是原料。
 * 放在适配器里的话，将来换成付费源时排序结果会跟着变 ——
 * 而你说不清为什么变（架构铁律 1）。
 *
 * @param tier 想用哪一档；默认取 `ARMOR_PRICE_TIER`
 * @returns 挑不出时返回 `null`（网页显示 `—`），**绝不猜**
 */
export function pickEffectivePrice(
  quote: { price: number | null; variants?: Readonly<Record<string, number | null>> } | null,
  tier: ConditionTier = ARMOR_PRICE_TIER,
): number | null {
  if (!quote) return null

  const picked = quote.variants?.[tier]
  if (typeof picked === 'number' && Number.isFinite(picked) && picked > 0) return picked

  // 没标档、或那一档没数据 → 退回源给的现价
  return quote.price
}

/**
 * 这个报价里**到底有没有可用的价**（不管哪一档）。
 *
 * 为什么单独一个函数：join 统计“多少个物品真能显示价格”时要用。
 * 如果只看 `quote.price`，那 8 件“moligod 只给了分档、没给裸名”的头盔
 * 会被错算成“非卖品”，而它们实际上是有价的。
 */
export function hasEffectivePrice(
  quote: { price: number | null; variants?: Readonly<Record<string, number | null>> } | null,
): boolean {
  if (!quote) return false
  if (quote.price !== null) return true
  return Object.values(quote.variants ?? {}).some((v) => typeof v === 'number' && v > 0)
}

/**
 * ⭐ 单格价值 = 价格 × 每格单位数 ÷ 占格数。
 *
 * **除零守卫的第二道**：任一项非法就返回 null，绝不返回 Infinity / NaN。
 * 返回 null 的语义是“算不出来”，网页显示 `—` 并排在最后。
 *
 * @param unitsPerSlot 一个格子里能放几个定价单位。
 *        普通物品 1；子弹 = 每组发数（60 或 90）；`null` = 未知（算不出来）。
 *
 * ⚠️ 为什么必须乘 unitsPerSlot：实测交易行报的是**每发单价**，
 *    而一个格子能放 60 发。不乘就会把子弹的单格价值算低 60 倍，
 *    于是“值不值得摸”的结论会完全反过来（而那个错的数字看上去完全合理）。
 */
export function computePricePerSlot(
  price: number | null,
  slots: number,
  unitsPerSlot: number | null = 1,
): number | null {
  if (price === null || !Number.isFinite(price)) return null
  if (!Number.isFinite(slots) || slots <= 0) return null
  if (unitsPerSlot === null || !Number.isFinite(unitsPerSlot) || unitsPerSlot <= 0) return null
  return (price * unitsPerSlot) / slots
}

/**
 * ⭐ 今日涨幅百分比 = (现价 - 昨日均价) ÷ 昨日均价 × 100。
 *
 * 除零守卫：昨日均价缺失或为 0 时返回 null。
 * 注意昨日均价可能是 0（源里出现过），`0` 做分母会得到 Infinity。
 */
export function computeTodayChangePct(
  price: number | null,
  yesterdayAvg: number | null,
): number | null {
  if (price === null || !Number.isFinite(price)) return null
  if (yesterdayAvg === null || !Number.isFinite(yesterdayAvg) || yesterdayAvg <= 0) return null
  return ((price - yesterdayAvg) / yesterdayAvg) * 100
}

/**
 * 是否能塞进背包。判定规则就是"占格大于 0"。
 *
 * 这一条同时兜住了：载具（16 条）、皮肤（10 条）、以及将来任何意外
 * 出现 0 格的物品。所以规则只需一条，而不需要维护一张"不可携带物品黑名单"。
 */
export function isCarryable(slots: number): boolean {
  return Number.isFinite(slots) && slots > 0
}

/**
 * 把源里的品质原始值收窄成合法的 `Grade`。
 * 源里给的是普通 number，可能是负数、小数或超范围的值。
 */
export function clampGrade(raw: number): Grade {
  if (!Number.isFinite(raw)) return 0
  const n = Math.trunc(raw)
  if (n < 0) return 0
  if (n > MAX_GRADE) return MAX_GRADE as Grade
  return n as Grade
}

/**
 * 解析源侧的时间字符串。
 *
 * 源里给的是本地时间格式 `"2026-09-28 14:24"`（不是 ISO 8601）。
 * 注意：`new Date("2026-09-28 14:24")` 在 Node 里能解析，但行为依赖实现，
 * 所以这里显式拆解，避免不同环境结果不一致。
 */
export function parseSourceTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null

  const [, y, mo, d, h, mi, s] = m
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
  )
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 判断某条物品的**源侧数据**是否陈旧。
 *
 * ⚠️ 别与"整份快照是否陈旧"混淆（那是按需刷新的 15 分钟判定）。
 * 这里判断的是"这个物资的价格在源站已经多久没更新了"——
 * 实测官方有 2026-09-04 的数据（24 天前），必须能识别出来。
 *
 * 解析不出时间时不判定为陈旧（宁可漏报，不要把整批标成陈旧）。
 */
export function isItemStale(
  lastUpdate: string | null | undefined,
  staleAfterHours: number,
  now: Date = new Date(),
): boolean {
  const t = parseSourceTimestamp(lastUpdate)
  if (!t) return false
  const ageHours = (now.getTime() - t.getTime()) / 3_600_000
  return ageHours > staleAfterHours
}
