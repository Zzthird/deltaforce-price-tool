/**
 * `utils/item.ts` 的单元测试 —— 出产地三态与涨跌幅显示。
 *
 * 这两块看着简单，但它们是"用户读到的结论"，错了不会报错，
 * 只会让界面**看起来合理地说错话**：
 *
 *   · 「每张图都出」显示成「待补」→ 你会以为这条数据缺了，而去补一个其实不用补的东西
 *   · 「待补」显示成「通用」   → 你会以为到处都能刷到，跑一圈找不到
 */

import { describe, expect, it } from 'vitest'
import type { Item } from '@deltaforce/shared'
import { describeChange, describeProvenance } from './item'

/** 只关心出产地与涨跌幅两个字段，其余给最小可用的值 */
function makeItem(over: Partial<Item> = {}): Item {
  return {
    provenanceMaps: null,
    provenanceUniversal: false,
    todayChangePct: null,
    ...over,
  } as Item
}

describe('describeProvenance —— 出产地三态', () => {
  it('⭐ 通用物资 → 「通用」，而且**不铺开地图名**', () => {
    // 这是最关键的一条：实测 1297 条是通用，铺开就是 6 个图名，
    // 那一列会变成 1297 行同样的字串 —— 等于没有信息。
    const d = describeProvenance(
      makeItem({
        provenanceUniversal: true,
        provenanceMaps: ['巴克什', '潮汐监狱', '航天基地', '零号大坝', '长弓溪谷', 'AZ3'],
      }),
    )
    expect(d.kind).toBe('universal')
    expect(d.text).toBe('通用')
    expect(d.text).not.toContain('巴克什')
  })

  it('⭐ 待补与通用**必须能区分**（一个是"不知道"，一个是"每张图都出"）', () => {
    const universal = describeProvenance(makeItem({ provenanceUniversal: true }))
    const missing = describeProvenance(makeItem({ provenanceMaps: null }))

    expect(missing.kind).toBe('missing')
    expect(missing.text).toBe('待补')
    expect(missing.text).not.toBe(universal.text)
  })

  it('特产 → 显示地图名（1~2 张全列，3 张以上缩写）', () => {
    expect(describeProvenance(makeItem({ provenanceMaps: ['长弓溪谷'] })).text).toBe('长弓溪谷')
    expect(describeProvenance(makeItem({ provenanceMaps: ['长弓溪谷', 'AZ3'] })).text).toBe(
      '长弓溪谷、AZ3',
    )
    expect(
      describeProvenance(makeItem({ provenanceMaps: ['巴克什', '潮汐监狱', '航天基地'] })).text,
    ).toBe('巴克什、潮汐监狱 等 3 张')
  })

  it('缩写时完整列表仍放在悬浮提示里（信息不丢）', () => {
    const d = describeProvenance(
      makeItem({ provenanceMaps: ['巴克什', '潮汐监狱', '航天基地'] }),
    )
    expect(d.full).toBe('巴克什、潮汐监狱、航天基地')
  })

  it('空数组按"待补"处理（不会渲染出一个空单元格让人猜）', () => {
    expect(describeProvenance(makeItem({ provenanceMaps: [] })).kind).toBe('missing')
  })

  it('通用标记优先于地图列表（两者都在时以通用为准）', () => {
    const d = describeProvenance(
      makeItem({ provenanceUniversal: true, provenanceMaps: ['长弓溪谷'] }),
    )
    expect(d.kind).toBe('universal')
  })
})

describe('describeChange —— 今日涨幅', () => {
  it('⭐ 涨用带 + 号的数字、tone=up（中国习惯：红涨）', () => {
    expect(describeChange(3.24)).toEqual({ text: '+3.2%', tone: 'up' })
  })

  it('跌用负号、tone=down', () => {
    expect(describeChange(-1.55)).toEqual({ text: '-1.6%', tone: 'down' })
  })

  it('零显示 0.0% 而不是空 —— "今天没变"与"没有数据"是两回事', () => {
    expect(describeChange(0)).toEqual({ text: '0.0%', tone: 'flat' })
  })

  it('没有数据 → —', () => {
    expect(describeChange(null)).toEqual({ text: '—', tone: 'none' })
    expect(describeChange(Number.NaN)).toEqual({ text: '—', tone: 'none' })
  })
})
