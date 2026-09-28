/**
 * metrics.ts 的单元测试 —— 派生指标与除零守卫。
 *
 * 这个文件是整个项目的"口径唯一实现处"，所以它的边界情况必须测穿。
 * 重点是那三条**除零守卫**：占格 0、价格缺失、昨日均价 0。
 * 如果它们失效，排行榜会被 Infinity / NaN 炸掉，而那种 bug 极难事后定位。
 */

import { describe, expect, it } from 'vitest'
import {
  clampGrade,
  computePricePerSlot,
  computeSlots,
  computeTodayChangePct,
  hasEffectivePrice,
  isCarryable,
  isItemStale,
  parseSourceTimestamp,
  pickEffectivePrice,
} from './metrics'

describe('computeSlots —— 占格总数', () => {
  it('正常相乘', () => {
    expect(computeSlots(2, 3)).toBe(6)
    expect(computeSlots(1, 1)).toBe(1)
  })

  it('⭐ 任一边为 0 → 0（除零守卫第一道）', () => {
    expect(computeSlots(0, 3)).toBe(0)
    expect(computeSlots(3, 0)).toBe(0)
    expect(computeSlots(0, 0)).toBe(0)
  })

  it('负数 → 0', () => {
    expect(computeSlots(-1, 3)).toBe(0)
    expect(computeSlots(3, -1)).toBe(0)
  })

  it('非有限数字 → 0（NaN / Infinity 不该往下传）', () => {
    expect(computeSlots(Number.NaN, 3)).toBe(0)
    expect(computeSlots(Number.POSITIVE_INFINITY, 3)).toBe(0)
  })

  it('小数向下取整', () => {
    expect(computeSlots(2.9, 1)).toBe(2)
    expect(computeSlots(1.5, 1.5)).toBe(1)
  })
})

describe('computePricePerSlot —— 单格价值', () => {
  it('正常相除', () => {
    expect(computePricePerSlot(100, 4)).toBe(25)
    expect(computePricePerSlot(377058, 4)).toBeCloseTo(94264.5)
  })

  it('⭐ 占格为 0 → null，绝不是 Infinity（除零守卫第二道）', () => {
    const r = computePricePerSlot(100, 0)
    expect(r).toBeNull()
    expect(typeof r === 'number' && Number.isFinite(r)).toBe(false)
  })

  it('价格为 null → null', () => {
    expect(computePricePerSlot(null, 4)).toBeNull()
  })

  it('占格为负或非有限 → null', () => {
    expect(computePricePerSlot(100, -1)).toBeNull()
    expect(computePricePerSlot(100, Number.NaN)).toBeNull()
  })

  it('价格为非有限 → null', () => {
    expect(computePricePerSlot(Number.NaN, 4)).toBeNull()
    expect(computePricePerSlot(Number.POSITIVE_INFINITY, 4)).toBeNull()
  })
})

describe('computeTodayChangePct —— 今日涨幅', () => {
  it('上涨为正、下跌为负', () => {
    expect(computeTodayChangePct(110, 100)).toBeCloseTo(10)
    expect(computeTodayChangePct(90, 100)).toBeCloseTo(-10)
    expect(computeTodayChangePct(100, 100)).toBeCloseTo(0)
  })

  it('⭐ 昨日均价为 0 → null，绝不是 Infinity（除零守卫第三道）', () => {
    const r = computeTodayChangePct(100, 0)
    expect(r).toBeNull()
  })

  it('任一缺失 → null', () => {
    expect(computeTodayChangePct(null, 100)).toBeNull()
    expect(computeTodayChangePct(100, null)).toBeNull()
  })

  it('昨日均价为负或非有限 → null', () => {
    expect(computeTodayChangePct(100, -5)).toBeNull()
    expect(computeTodayChangePct(100, Number.NaN)).toBeNull()
  })
})

describe('isCarryable —— 能不能塞进背包', () => {
  it('占格 > 0 才算可携带', () => {
    expect(isCarryable(1)).toBe(true)
    expect(isCarryable(16)).toBe(true)
  })

  it('⭐ 占格 0 不可携带（载具 16 条 + 皮肤 10 条就是靠这条被兜住的）', () => {
    expect(isCarryable(0)).toBe(false)
  })

  it('负数与非有限 → false', () => {
    expect(isCarryable(-1)).toBe(false)
    expect(isCarryable(Number.NaN)).toBe(false)
  })
})

describe('clampGrade —— 品质收窄', () => {
  it('合法值原样通过', () => {
    for (const g of [0, 1, 2, 3, 4, 5, 6] as const) {
      expect(clampGrade(g)).toBe(g)
    }
  })

  it('⭐ 超范围被夹到边界（源里什么都可能出现）', () => {
    expect(clampGrade(7)).toBe(6)
    expect(clampGrade(99)).toBe(6)
    expect(clampGrade(-1)).toBe(0)
    expect(clampGrade(-99)).toBe(0)
  })

  it('小数向下取整', () => {
    expect(clampGrade(3.9)).toBe(3)
  })

  it('⭐ 非有限数字 → 0（Infinity 也不能当成“最高品质”，那会误导成红色）', () => {
    expect(clampGrade(Number.NaN)).toBe(0)
    expect(clampGrade(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampGrade(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('parseSourceTimestamp —— 解析源侧时间', () => {
  it('解析 "YYYY-MM-DD HH:mm"', () => {
    const d = parseSourceTimestamp('2026-09-28 14:24')
    expect(d).not.toBeNull()
    expect(d!.getFullYear()).toBe(2026)
    expect(d!.getMonth()).toBe(8) // 0-based
    expect(d!.getDate()).toBe(28)
    expect(d!.getHours()).toBe(14)
    expect(d!.getMinutes()).toBe(24)
  })

  it('带秒也能解析', () => {
    const d = parseSourceTimestamp('2026-09-28 14:24:30')
    expect(d!.getSeconds()).toBe(30)
  })

  it('⭐ "N/A" 这类脏值 → null（moligod 实测有 343 条是 "N/A"）', () => {
    expect(parseSourceTimestamp('N/A')).toBeNull()
    expect(parseSourceTimestamp('n/a')).toBeNull()
  })

  it('空串 / null / undefined / 格式不符 → null', () => {
    expect(parseSourceTimestamp('')).toBeNull()
    expect(parseSourceTimestamp(null)).toBeNull()
    expect(parseSourceTimestamp(undefined)).toBeNull()
    expect(parseSourceTimestamp('昨天')).toBeNull()
    expect(parseSourceTimestamp('2026/09/28')).toBeNull()
  })
})

describe('isItemStale —— 源侧数据是否陈旧', () => {
  const now = new Date('2026-09-28T12:00:00')

  it('超过阈值算陈旧', () => {
    expect(isItemStale('2026-09-27 11:00', 24, now)).toBe(true) // 25 小时
    expect(isItemStale('2026-09-26 12:00', 24, now)).toBe(true) // 48 小时
  })

  it('未超过阈值不算陈旧（边界是「严格大于」，不是「大于等于」）', () => {
    expect(isItemStale('2026-09-28 11:00', 24, now)).toBe(false) // 1 小时
    expect(isItemStale('2026-09-27 12:00', 24, now)).toBe(false) // 正好 24 小时
  })

  it('⭐ 解析不出时间时**不**判定为陈旧（宁可漏报，也不要把整批标成陈旧）', () => {
    expect(isItemStale('N/A', 24, now)).toBe(false)
    expect(isItemStale(null, 24, now)).toBe(false)
    expect(isItemStale(undefined, 24, now)).toBe(false)
  })
})

/* ══════════════════════ ⭐ 护甲选档（pickEffectivePrice） ══════════════════════ */

/**
 * 这一组测的是实测发现的大坑：
 *
 * moligod 对护甲给了 4 个条目 —— 一个“裸名”（基础参考价、**不是行情**）
 * 加三个按耐久度分的实时行情。铁证：官方 avgPrice 与裸名吻合 72/85（85%）。
 *
 * 所以排序时必须**改取某一档**，而不是直接用 `quote.price`。
 * 差距不小：H70 精英头盔 全新/破损 = 5.7 倍。
 */
describe('pickEffectivePrice —— 护甲选档', () => {
  const ARMOR = {
    price: 2163983, // 裸名 = 基础参考价（非行情）
    variants: { 全新: 4003281, 几乎全新: 1017434, 破损: 707547 },
  }

  it('⭐ 有分档时取指定那一档（默认「破损」，最保守）', () => {
    expect(pickEffectivePrice(ARMOR, '破损')).toBe(707547)
    expect(pickEffectivePrice(ARMOR, '全新')).toBe(4003281)
    expect(pickEffectivePrice(ARMOR, '几乎全新')).toBe(1017434)
  })

  it('⭐ 有分档时**绝不**退回那个基础参考价', () => {
    // 指定一个不存在的档位名 → 列不了档才退回 price；
    // 但只要 variants 里有一档，就不该拿到 2163983 这个非行情值
    expect(pickEffectivePrice(ARMOR, '全新')).not.toBe(2163983)
  })

  it('普通物品（没有 variants）就是 quote.price', () => {
    expect(pickEffectivePrice({ price: 34275453 })).toBe(34275453)
    expect(pickEffectivePrice({ price: 34275453, variants: undefined })).toBe(34275453)
  })

  it('指定的档位缺数据 → 退回 quote.price（而不是当成 0）', () => {
    expect(pickEffectivePrice({ price: 1000, variants: { 全新: 3000 } }, '破损')).toBe(1000)
  })

  it('档位值是 null → 退回 quote.price', () => {
    expect(pickEffectivePrice({ price: 1000, variants: { 破损: null } }, '破损')).toBe(1000)
  })

  it('⭐ 档位值是 0 → 也当没价（0 在本项目里一律表示“无价格”，不是“零元”）', () => {
    expect(pickEffectivePrice({ price: 1000, variants: { 破损: 0 } }, '破损')).toBe(1000)
  })

  it('quote 为 null → null', () => {
    expect(pickEffectivePrice(null)).toBeNull()
  })

  it('裸名和分档都没有价 → null', () => {
    expect(pickEffectivePrice({ price: null, variants: { 破损: null } })).toBeNull()
    expect(pickEffectivePrice({ price: null })).toBeNull()
  })

  it('⭐ 把 pickEffectivePrice 的结果丢给 computePricePerSlot，才算得出单格价值', () => {
    // 这一条把两个函数串起来：选档错了，单格价值就会整体偏高（或偏低）
    const price = pickEffectivePrice(ARMOR, '破损')
    expect(computePricePerSlot(price, 9, 1)).toBeCloseTo(707547 / 9, 6)
  })
})

describe('hasEffectivePrice —— 这个报价里到底有没有可用的价', () => {
  it('⭐ 只有分档、没有裸名（那 8 件头盔）→ 算“有价”', () => {
    // 如果只看 quote.price，这 8 件会被错算成“非卖品”，而它们实际上有行情
    expect(hasEffectivePrice({ price: null, variants: { 破损: 48276 } })).toBe(true)
  })

  it('分档全是 null → 没价', () => {
    expect(hasEffectivePrice({ price: null, variants: { 破损: null, 全新: null } })).toBe(false)
  })

  it('分档里全是 0 → 没价（0 = 无价格）', () => {
    expect(hasEffectivePrice({ price: null, variants: { 破损: 0 } })).toBe(false)
  })

  it('普通物品看 price', () => {
    expect(hasEffectivePrice({ price: 100 })).toBe(true)
    expect(hasEffectivePrice({ price: null })).toBe(false)
  })

  it('quote 为 null → false', () => {
    expect(hasEffectivePrice(null)).toBe(false)
  })
})
