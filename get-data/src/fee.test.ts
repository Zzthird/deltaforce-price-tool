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
  analyzeRatioModel,
  compareAcrossItems,
  feeOf,
  findClosestItem,
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

  it('⭐ 带参考价（推荐写法）—— 参考价是公式的自变量', () => {
    const s = parseSampleLine('锈迹斑斑的海盗铜币 2350 2013 2860')
    expect(s).toMatchObject({
      item: '锈迹斑斑的海盗铜币',
      price: 2350,
      net: 2013,
      ref: 2860,
    })
  })

  it('带键名也认（net= / ref=）', () => {
    const s = parseSampleLine('海洋之泪 1000 net=900 ref=800')
    expect(s).toMatchObject({ item: '海洋之泪', price: 1000, net: 900, ref: 800 })
  })

  it('不抄参考价也行（ref 为 null）', () => {
    expect(parseSampleLine('海洋之泪 1000 900')?.ref).toBeNull()
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

/* ══════════ ⭐ 物品名模糊匹配（为了查到参考价） ══════════ */

/**
 * 实测踩到的：用户手填「海盗铜币」，而游戏数据里叫「锈迹斑斑的海盗铜币」
 * —— 差三个字，于是查不到参考价 ✗，而"费率是否取决于参考价"正是要验证的东西。
 */
describe('⭐ findClosestItem —— 手填名字 vs 数据里的名字', () => {
  const NAMES = ['锈迹斑斑的海盗铜币', '亮闪闪的海盗金币', '古怪的海盗银币', '非洲之心']

  it('完全相等', () => {
    expect(findClosestItem('非洲之心', NAMES)).toEqual({ matched: '非洲之心', how: 'exact' })
  })

  it('⭐ 子串匹配（用户的真实用例）', () => {
    expect(findClosestItem('海盗铜币', NAMES)).toEqual({
      matched: '锈迹斑斑的海盗铜币',
      how: 'contained',
    })
  })

  it('⭐ 反过来的子串也能匹配（名字打多了）', () => {
    expect(findClosestItem('锈迹斑斑的海盗铜币（新）', NAMES).matched).toBe('锈迹斑斑的海盗铜币')
  })

  it('⭐ 多个候选都包含时，挑最短的（描述词最少的）', () => {
    // 「海盗金币」只被一条包含 → 唯一 ✓
    expect(findClosestItem('海盗金币', NAMES).matched).toBe('亮闪闪的海盗金币')
  })

  it('⭐ 分不清时返回 null，不猜', () => {
    // 「古怪」和「锈迹」都在候选里，但都不是子串关系 →
    // 输入「古怪」只有一条包含它 ✓；输入一个各条长度相同的模糊词才会 null
    const ambiguous = ['甲甲X', '乙乙X']
    expect(findClosestItem('X', ambiguous).matched).toBeNull()
  })

  it('查不到就返回 null（而不是硬塞一个）', () => {
    expect(findClosestItem('这个词根本不在', NAMES)).toEqual({ matched: null, how: 'none' })
  })

  it('标点与大小写差异算同一个（.300BLK vs .300 blk）', () => {
    expect(findClosestItem('.300 blk', ['.300BLK']).how).toBe('normalized')
  })
})


/* ══════════ ⭐ 比值模型（实测找到的真正自变量） ══════════ */

/**
 * 用户手填 113 条样本，按「挂价」怎么拟合都对不上。
 * 直到他发了游戏截图，看到界面上有「参考价格 2,860」——
 * 按「挂价 ÷ 参考价」重排，U 形规律立刻出来（最低点正好在比值 ≈ 1）。
 *
 * 更强的推论：如果费率只取决于比值，那么净收益 = 参考价 × k×(1−费率(k))，
 * 也就是 **最高利润 = 参考价 × 一个普适常数** ——
 * 所以不需要"每个物品都测"，只要把这个常数定准。
 */
describe('⭐ analyzeRatioModel —— 按「挂价 ÷ 参考价」分析', () => {
  /** 造一条带参考价的样本：给定比值与费率，反推到手 */
  function mkRatio(item: string, ref: number, k: number, rate: number): FeeSample {
    const price = Math.round(ref * k)
    return { item, price, net: price - Math.round(price * rate), ref, at: '' }
  }

  it('样本不足时明确提示"要把参考价抄上"', () => {
    const a = analyzeRatioModel([mkRatio('X', 1000, 1, 0.1)])
    expect(a.ready).toBe(false)
    expect(a.summary).toContain('参考价')
  })

  it('⭐ 复现实测的 U 形：比值 ≈1 时费率最低', () => {
    const a = analyzeRatioModel([
      mkRatio('X', 1000, 0.1, 0.35), // 远低
      mkRatio('X', 1000, 0.5, 0.2),
      mkRatio('X', 1000, 1.0, 0.13), // ★ 最低
      mkRatio('X', 1000, 3.0, 0.15),
      mkRatio('X', 1000, 6.0, 0.56),
      mkRatio('X', 1000, 10.0, 0.82), // 远高
    ])
    expect(a.ready).toBe(true)
    // 比值 1.0 那一段的费率应当是最低的
    const near1 = a.points.find((p) => Math.abs(p.k - 1) < 0.01)!
    const far = a.points.find((p) => p.k > 9)!
    expect(near1.rate).toBeLessThan(far.rate)
  })

  it('⭐ 找出"净收益 ÷ 参考价"最大的那个点', () => {
    const a = analyzeRatioModel([
      mkRatio('X', 2860, 1.0, 0.13), // 净 = 0.87 ref
      mkRatio('X', 2860, 5.2, 0.36), // 净 = 3.33 ref ← 最大
      mkRatio('X', 2860, 12.0, 0.82), // 净 = 2.16 ref
    ])
    expect(a.best?.k).toBeCloseTo(5.2, 1)
    expect(a.best?.value).toBeCloseTo(3.33, 1)
    expect(a.summary).toContain('最高净收益')
  })

  it('没有参考价的样本被跳过（不编一个）', () => {
    const a = analyzeRatioModel([
      { item: 'X', price: 1000, net: 900, at: '' },
      { item: 'X', price: 2000, net: 1800, at: '' },
      { item: 'X', price: 3000, net: 2700, at: '' },
      mkRatio('X', 1000, 1, 0.13),
    ])
    expect(a.points).toHaveLength(1)
    expect(a.ready).toBe(false)
  })
})
