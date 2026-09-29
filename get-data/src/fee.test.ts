/**
 * 交易行手续费**逆向分析**的单元测试。
 *
 * ⭐ 这个文件测的是"能不能从实测样本里正确认出模型"——
 *    认错模型的后果很具体：把阶梯当成固定比例，就会算出**不存在**的
 *    "利润最高点"；反过来把固定比例当成阶梯，就会凭空造出一个最优点。
 *    两种都会给出"看着合理但错"的数字。
 */

import { describe, expect, it } from 'vitest'
import {
  analyzeFee,
  compareAcrossItems,
  feeOf,
  fmtRate,
  parseAmount,
  parseSampleLine,
  predictFee,
  rateOf,
  type FeeSample,
} from './fee'

/** 造一条样本：`net` 由费率和挂价算出来（模拟游戏里的四舍五入） */
function mk(item: string, price: number, rate: number): FeeSample {
  return { item, price, net: price - Math.round(price * rate), at: '2026-09-29T00:00:00.000Z' }
}

/* ══════════════════════════ 基础换算 ══════════════════════════ */

describe('费率的两种算法', () => {
  it('fee = 挂价 − 到手', () => {
    expect(feeOf(mk('X', 1000, 0.1))).toBe(100)
  })

  it('rate = fee / 挂价', () => {
    expect(rateOf(mk('X', 1000, 0.1))).toBeCloseTo(0.1, 6)
  })

  it('挂价 0 时不除零（返回 0，而不是 Infinity/NaN）', () => {
    expect(rateOf({ item: 'X', price: 0, net: 0, at: '' })).toBe(0)
  })

  it('fmtRate 去掉多余的 0（10.00% → 10%，12.50% → 12.5%）', () => {
    expect(fmtRate(0.1)).toBe('10%')
    expect(fmtRate(0.125)).toBe('12.5%')
    expect(fmtRate(0.1567)).toBe('15.67%')
  })
})

/* ══════════════════════════ 录入解析 ══════════════════════════ */

describe('parseAmount —— 金额输入', () => {
  it('纯数字', () => {
    expect(parseAmount('10000')).toBe(10000)
  })

  it('带千分位（交易行界面就是这么写的）', () => {
    expect(parseAmount('1,000,000')).toBe(1_000_000)
  })

  it('中文单位', () => {
    expect(parseAmount('100万')).toBe(1_000_000)
    expect(parseAmount('1.5亿')).toBe(150_000_000)
  })

  it('认不出来 → null（不猜）', () => {
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('100元')).toBeNull()
  })
})

describe('parseSampleLine —— 一行录入', () => {
  it('标准写法：物品 挂价 到手', () => {
    const s = parseSampleLine('海洋之泪 1000 900')
    expect(s).toMatchObject({ item: '海洋之泪', price: 1000, net: 900 })
  })

  it('⭐ 物品名含空格时不会被切碎', () => {
    // 「D6 战术头盔」这种名字里有空格 —— 必须从后往前取两个数值字段
    const s = parseSampleLine('D6 战术头盔 10000 9000')
    expect(s).toMatchObject({ item: 'D6 战术头盔', price: 10000, net: 9000 })
  })

  it('直接给手续费：fee=100', () => {
    const s = parseSampleLine('海洋之泪 1000 fee=100')
    expect(s).toMatchObject({ item: '海洋之泪', price: 1000, net: 900 })
  })

  it('直接给比例：r=10%', () => {
    const s = parseSampleLine('海洋之泪 1,000 r=10%')
    expect(s).toMatchObject({ item: '海洋之泪', price: 1000, net: 900 })
  })

  it('格式不对 → null', () => {
    expect(parseSampleLine('海洋之泪')).toBeNull()
    expect(parseSampleLine('海洋之泪 1000')).toBeNull()
    expect(parseSampleLine('海洋之泪 abc 900')).toBeNull()
  })
})

/* ══════════════════════════ 模型识别 ══════════════════════════ */

describe('⭐ analyzeFee —— 认出是哪种模型', () => {
  it('样本不足时不下结论', () => {
    expect(analyzeFee([]).kind).toBe('insufficient')
    expect(analyzeFee([mk('X', 1000, 0.1)]).kind).toBe('insufficient')
  })

  it('⭐ 比例恒定 → flat，并吸附到整数百分比', () => {
    const a = analyzeFee([mk('X', 1000, 0.1), mk('X', 10000, 0.1), mk('X', 100000, 0.1)])
    expect(a.kind).toBe('flat')
    expect(a.tiers).toEqual([{ upTo: null, rate: 0.1 }])
    expect(a.fitCount).toBe(3)
    expect(a.summary).toContain('不存在"利润最高点"')
  })

  it('⭐ 比例随价格跳变 → tiered，并给出档位', () => {
    const a = analyzeFee([
      mk('X', 1000, 0.1),
      mk('X', 10_000, 0.1),
      mk('X', 20_000, 0.1),
      mk('X', 60_000, 0.15),
      mk('X', 100_000, 0.15),
      mk('X', 500_000, 0.15),
    ])
    expect(a.kind).toBe('tiered')
    expect(a.tiers).toHaveLength(2)
    expect(a.tiers[0]?.rate).toBe(0.1)
    expect(a.tiers[1]?.rate).toBe(0.15)
    expect(a.tiers[1]?.upTo).toBeNull()
    expect(a.fitCount).toBe(6)
  })

  it('⭐ 档位边界给的是"落在两个已测价格之间"，并给出二分建议', () => {
    const a = analyzeFee([
      mk('X', 1000, 0.1),
      mk('X', 10_000, 0.1),
      mk('X', 20_000, 0.1), // ← 这一档最高测到 20000
      mk('X', 60_000, 0.15), // ← 这一档最低是 60000
      mk('X', 100_000, 0.15),
    ])
    expect(a.kind).toBe('tiered')
    expect(a.nextProbes).toEqual([40_000]) // (20000+60000)/2
    expect(a.summary).toContain('40,000')
  })

  it('⭐ 每个价格点比例都不同 → continuous（不能当阶梯处理）', () => {
    // 比例随价格缓慢上升：8% / 9% / 10% / 11% / 12%
    const a = analyzeFee([
      mk('X', 1_000, 0.08),
      mk('X', 2_000, 0.09),
      mk('X', 4_000, 0.1),
      mk('X', 8_000, 0.11),
      mk('X', 16_000, 0.12),
    ])
    expect(a.kind).toBe('continuous')
    expect(a.summary).toContain('连续变化')
  })

  it('模型不符时把对不上的样本列出来（而不是硬说吻合）', () => {
    const samples = [
      mk('X', 1000, 0.1),
      mk('X', 10_000, 0.1),
      mk('X', 20_000, 0.1),
      mk('X', 30_000, 0.1),
      // 这一条是"异常"：同档内比例突变
      mk('X', 40_000, 0.2),
    ]
    const a = analyzeFee(samples)
    expect(a.mismatches.length + a.fitCount).toBeLessThanOrEqual(samples.length)
    // 不论怎么聚类，都要能说出有几个吻合
    expect(a.fitCount).toBeGreaterThan(0)
  })
})

describe('predictFee —— 用模型预测', () => {
  it('单档就是 price × rate 四舍五入', () => {
    expect(predictFee(1000, [{ upTo: null, rate: 0.1 }])).toBe(100)
    expect(predictFee(1055, [{ upTo: null, rate: 0.1 }])).toBe(106) // 105.5 → 106
  })

  it('多档时按价格落档', () => {
    const tiers = [
      { upTo: 50_000, rate: 0.1 },
      { upTo: null, rate: 0.15 },
    ]
    expect(predictFee(10_000, tiers)).toBe(1000)
    expect(predictFee(50_000, tiers)).toBe(5000) // 边界含在低档
    expect(predictFee(50_001, tiers)).toBe(7500) // 50001 × 0.15 = 7500.15 → 四舍五入 7500
  })
})

/* ══════════════════════════ 跨物品 ══════════════════════════ */

describe('⭐ compareAcrossItems —— 费率是否还取决于物品', () => {
  it('同一物品的比例范围会汇总出来', () => {
    const out = compareAcrossItems([mk('甲', 1000, 0.1), mk('甲', 10_000, 0.1)])
    expect(out).toContain('甲')
    expect(out).toContain('恒为 10%')
  })

  it('⭐ 挂价接近但费率不同 → 点名警告（说明模型缺变量）', () => {
    // 搜索结果里有一条说费率"按物品参考价区间浮动" —— 那意味着
    // 同样挂 10,000，不同物品可能费率不同。这种情况必须能认出来。
    const out = compareAcrossItems([mk('甲', 10_000, 0.1), mk('乙', 10_500, 0.15)])
    expect(out).toContain('费率可能还取决于物品本身')
  })

  it('费率与物品无关时不误报', () => {
    const out = compareAcrossItems([mk('甲', 10_000, 0.1), mk('乙', 10_500, 0.1)])
    expect(out).not.toContain('取决于物品本身')
  })
})


/* ══════════ ⭐ 样本自相矛盾（最容易出现的其实是敲错） ══════════ */

/**
 * 这一组来自一次真实的踩坑：演示时我故意喂了两条矛盾的样本
 * （同样挂 10,000，一个到手 9,000、一个 9,500），
 * 工具却说「比例随价格**连续变化**」✗ —— 诊断是错的。
 *
 * 同样价格给出不同手续费，说明数据有问题，而不是有某种"模型"。
 * 这种检查必须放在所有拟合之前，否则会给出误导性结论。
 */
describe('⭐ analyzeFee —— 样本自相矛盾', () => {
  it('⭐ 同样挂价、不同手续费 → inconsistent（不是"连续变化"）', () => {
    const a = analyzeFee([
      { item: 'X', price: 10_000, net: 9_000, at: '' }, // 手续费 1000
      { item: 'X', price: 10_000, net: 9_500, at: '' }, // 手续费 500 ← 矛盾
      mk('X', 20_000, 0.1),
    ])
    expect(a.kind).toBe('inconsistent')
    expect(a.summary).toContain('同样的挂价')
    expect(a.summary).toContain('10,000')
    // 必须提示两条出路：敲错了 / 还有别的变量
    expect(a.summary).toContain('敲错')
    expect(a.summary).toContain('12 小时 / 24 小时')
  })

  it('同样挂价、同样手续费 → 不算矛盾', () => {
    const a = analyzeFee([
      { item: 'X', price: 10_000, net: 9_000, at: '' },
      { item: 'Y', price: 10_000, net: 9_000, at: '' }, // 不同物品，但手续费一样
    ])
    expect(a.kind).not.toBe('inconsistent')
  })

  it('不同挂价 → 不算矛盾（哪怕费率不同，那是另一个模型的事）', () => {
    const a = analyzeFee([mk('X', 1_000, 0.1), mk('X', 100_000, 0.15)])
    expect(a.kind).not.toBe('inconsistent')
  })
})
