/**
 * provenance.ts 的单元测试 —— 出产地解析与展开。
 *
 * 这里最值得测的是**官方数据的脏值**：
 *   · 原始值是一整串 "长弓溪谷-钻石皇后酒店,航天基地-核心区"，要切掉点位
 *   · 实测有 "-AZ3" 这种前置横线的坏编码
 *   · 有裸的 "全地图" 这个特殊值
 *
 * 这些规则只应该有一份实现（就是这里），所以必须测死。
 */

import { describe, expect, it } from 'vitest'
import { collectMapNames, expandAllMaps, isConfirmedOnMap, parseProvenanceMaps } from './provenance'

describe('parseProvenanceMaps —— 原始串 → 地图名数组', () => {
  it('⭐ 切掉点位，只留地图名', () => {
    expect(parseProvenanceMaps('长弓溪谷-钻石皇后酒店,航天基地-核心区')).toEqual([
      '航天基地',
      '长弓溪谷',
    ])
  })

  it('⭐ 修掉 "-AZ3" 这种前置横线的脏数据（实测真实存在）', () => {
    expect(parseProvenanceMaps('-AZ3')).toEqual(['AZ3'])
  })

  it('全角横线也认', () => {
    expect(parseProvenanceMaps('巴克什—巴别塔')).toEqual(['巴克什'])
    expect(parseProvenanceMaps('巴克什－巴别塔')).toEqual(['巴克什'])
  })

  it('裸的「全地图」保留为特殊值', () => {
    expect(parseProvenanceMaps('全地图')).toEqual(['全地图'])
  })

  it('「潮汐监狱-全地图」截断成「潮汐监狱」（点位被丢掉）', () => {
    expect(parseProvenanceMaps('潮汐监狱-全地图')).toEqual(['潮汐监狱'])
  })

  it('多段会去重并排序', () => {
    expect(parseProvenanceMaps('长弓溪谷-水泥厂,长弓溪谷-行政楼,航天基地-核心区')).toEqual([
      '航天基地',
      '长弓溪谷',
    ])
  })

  it('空段与多余空白被清洗', () => {
    expect(parseProvenanceMaps('  长弓溪谷  , ,  、航天基地 ')).toEqual(['航天基地', '长弓溪谷'])
  })

  it('⭐ 解析不出任何地图 → null（不是空数组）', () => {
    // null 的语义是"没有数据"；空数组会让人误以为"确认过没有出产地"
    expect(parseProvenanceMaps('')).toBeNull()
    expect(parseProvenanceMaps('   ')).toBeNull()
    expect(parseProvenanceMaps('---')).toBeNull()
    expect(parseProvenanceMaps(',,,')).toBeNull()
    expect(parseProvenanceMaps(null)).toBeNull()
    expect(parseProvenanceMaps(undefined)).toBeNull()
  })
})

describe('expandAllMaps —— 展开特殊值「全地图」', () => {
  const allMaps = ['长弓溪谷', '航天基地', '零号大坝']

  it('⭐ 展开成全部地图（这样网页只需一句 includes 就能判断）', () => {
    expect(expandAllMaps(['全地图'], allMaps)).toEqual(['航天基地', '零号大坝', '长弓溪谷'])
  })

  it('既有具体地图又有「全地图」时，合并去重', () => {
    expect(expandAllMaps(['长弓溪谷', '全地图'], allMaps)).toEqual([
      '航天基地',
      '零号大坝',
      '长弓溪谷',
    ])
  })

  it('不含特殊值时原样返回（已排序）', () => {
    expect(expandAllMaps(['长弓溪谷'], allMaps)).toEqual(['长弓溪谷'])
  })

  it('null → null', () => {
    expect(expandAllMaps(null, allMaps)).toBeNull()
  })

  it('⭐ 空数组 → null（"显式删除"的语义）', () => {
    expect(expandAllMaps([], allMaps)).toBeNull()
  })

  it('已知地图列表为空时无法展开 → null（兜底，理论上不会发生）', () => {
    expect(expandAllMaps(['全地图'], [])).toBeNull()
  })
})

describe('collectMapNames —— 收集所有出现过的地图名', () => {
  it('⭐ 收集具体地图名，但排除特殊值「全地图」', () => {
    const items = [
      { rawProvenance: '长弓溪谷-钻石皇后酒店' },
      { rawProvenance: '航天基地-核心区,长弓溪谷-水泥厂' },
      { rawProvenance: '全地图' },
      { rawProvenance: null },
    ]
    expect(collectMapNames(items)).toEqual(['航天基地', '长弓溪谷'])
  })

  it('全部都是 null 或空 → 空数组', () => {
    expect(collectMapNames([{ rawProvenance: null }, { rawProvenance: '' }])).toEqual([])
  })
})

describe('isConfirmedOnMap —— 是否已确认会在这张图出', () => {
  it('包含该地图 → true', () => {
    expect(isConfirmedOnMap(['长弓溪谷'], '长弓溪谷')).toBe(true)
  })

  it('包含特殊值时任何地图都算确认', () => {
    expect(isConfirmedOnMap(['全地图'], '随便哪张图')).toBe(true)
  })

  it('null（没数据）或不含该图 → false', () => {
    expect(isConfirmedOnMap(null, '长弓溪谷')).toBe(false)
    expect(isConfirmedOnMap(['航天基地'], '长弓溪谷')).toBe(false)
  })
})
