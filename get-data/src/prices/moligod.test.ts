/**
 * moligod 价格源适配器 —— 只测**纯函数部分**。
 *
 * `fetchPrices` 本身要发 HTTP，不适合单测；但里面最容易出错的
 * “护甲耐久度分档合并”已经被抽成 `mergeConditionVariants`，
 * 所以可以用一份现成的假数据把逻辑测穷。
 */

import { describe, expect, it } from 'vitest'
import { mergeConditionVariants } from './moligod'
import type { PriceQuote } from './types'

/** 造一条只有 price 有值的报价，其余字段留空 */
function quote(price: number | null): PriceQuote {
  return {
    price,
    basePrice: null,
    yesterdayAvg: null,
    yesterdayLow: null,
    yesterdayHigh: null,
    rangeLow: null,
    rangeHigh: null,
    updateTime: null,
  }
}

function mapOf(entries: Array<[string, number | null]>): Map<string, PriceQuote> {
  return new Map(entries.map(([k, v]) => [k, quote(v)]))
}

describe('mergeConditionVariants —— 护甲耐久度分档合并', () => {
  it('⭐ 裸名存在时：三档并进 variants，price 保持原样（适配器不选档）', () => {
    const byName = mapOf([
      ['H70 精英头盔', 2163983],
      ['H70 精英头盔（全新）', 4003281],
      ['H70 精英头盔（几乎全新）', 1017434],
      ['H70 精英头盔（破损）', 707547],
    ])

    expect(mergeConditionVariants(byName)).toBe(1)

    const q = byName.get('H70 精英头盔')!
    // 关键：price 还是那个“基础参考价”，**没有被改成某一档**
    // —— 选档是 metrics.pickEffectivePrice 的事（架构铁律 1）
    expect(q.price).toBe(2163983)
    expect(q.variants).toEqual({
      全新: 4003281,
      几乎全新: 1017434,
      破损: 707547,
    })
  })

  it('⭐ 裸名不存在时：造一条空壳，price 留 null（不猜）', () => {
    const byName = mapOf([
      ['D6 战术头盔（全新）', 48463],
      ['D6 战术头盔（几乎全新）', 39607],
      ['D6 战术头盔（破损）', 48276],
    ])

    expect(mergeConditionVariants(byName)).toBe(1)

    const q = byName.get('D6 战术头盔')!
    expect(q.price).toBeNull()
    expect(q.basePrice).toBeNull()
    expect(q.variants).toEqual({ 全新: 48463, 几乎全新: 39607, 破损: 48276 })
  })

  it('⭐ variants 的键顺序固定为 全新 → 几乎全新 → 破损（与源里的插入顺序无关）', () => {
    const byName = mapOf([
      ['X（破损）', 3],
      ['X（全新）', 1],
      ['X（几乎全新）', 2],
    ])

    mergeConditionVariants(byName)

    expect(Object.keys(byName.get('X')!.variants!)).toEqual(['全新', '几乎全新', '破损'])
  })

  it('⭐ 不污染挂在其它键下的同一个对象', () => {
    // 真实情况：同一个 quote 对象同时挂在 name / display_name / alias_name 下
    const shared = quote(100)
    const byName = new Map<string, PriceQuote>([
      ['某甲（全新）', shared],
      ['某甲别名（全新）', shared],
    ])

    mergeConditionVariants(byName)

    // 裸名 `某甲` 与 `某甲别名` 各得一份（都是空壳），原来的对象不该被塞进 variants
    expect(byName.get('某甲')!.variants).toEqual({ 全新: 100 })
    expect(byName.get('某甲别名')!.variants).toEqual({ 全新: 100 })
    expect(shared.variants).toBeUndefined()
  })

  it('只有部分档位时，缺的档位不出现在 variants 里（而不是填 null）', () => {
    const byName = mapOf([
      ['X（全新）', 100],
      ['X（破损）', 50],
    ])

    mergeConditionVariants(byName)

    expect(byName.get('X')!.variants).toEqual({ 全新: 100, 破损: 50 })
    expect(Object.keys(byName.get('X')!.variants!)).toEqual(['全新', '破损'])
  })

  it('⭐ 某一档没价时保留 null（不往前一档对齐）', () => {
    // 真实情况：低品质护甲的某些档位在源里就是没有行情。
    // 保留 null → 网页该档显示 “—”；而 pickEffectivePrice 会退回 quote.price。
    const byName = mapOf([
      ['X（全新）', 100],
      ['X（几乎全新）', null],
      ['X（破损）', 50],
    ])

    mergeConditionVariants(byName)

    expect(byName.get('X')!.variants).toEqual({ 全新: 100, 几乎全新: null, 破损: 50 })
  })

  it('没有分档的普通源 → 返回 0，什么都不改', () => {
    const byName = mapOf([
      ['海洋之泪', 34275453],
      ['非洲之星', 12484244],
    ])

    expect(mergeConditionVariants(byName)).toBe(0)
    expect(byName.get('海洋之泪')!.variants).toBeUndefined()
  })

  it('名字里带括号但不是耐久度后缀的，不误伤', () => {
    const byName = mapOf([
      ['某某（限定）', 100],
      ['某某（新版）', 200],
    ])

    expect(mergeConditionVariants(byName)).toBe(0)
  })

  it('只认末尾的后缀 —— 名字中间的（破损）不算', () => {
    const byName = mapOf([['A（破损）B', 100]])

    expect(mergeConditionVariants(byName)).toBe(0)
  })

  it('⭐ 后缀前为空（名字就叫「（破损）」）时不处理', () => {
    const byName = mapOf([['（破损）', 100]])

    expect(mergeConditionVariants(byName)).toBe(0)
  })

  it('保留裸名条目原有的其它字段（yesterdayAvg / updateTime）', () => {
    const bare: PriceQuote = { ...quote(100), yesterdayAvg: 90, updateTime: '2026-09-28 19:04' }
    const byName = new Map<string, PriceQuote>([
      ['X', bare],
      ['X（破损）', quote(50)],
    ])

    mergeConditionVariants(byName)

    const q = byName.get('X')!
    expect(q.yesterdayAvg).toBe(90)
    expect(q.updateTime).toBe('2026-09-28 19:04')
    expect(q.variants).toEqual({ 破损: 50 })
  })
})
