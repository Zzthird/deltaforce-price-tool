/**
 * csv.ts 的单元测试 —— CSV 读写与分隔符解析。
 *
 * 为什么值得认真测：这是**你和程序之间的接口**。它读错一个字段，
 * 你填的 100 行数据就会错位或丢失，而且症状很难发现。
 * 尤其是**带引号的字段**（地图名里带逗号、备注里带换行）很容易读错。
 */

import { describe, expect, it } from 'vitest'
import { parseCsv, rowsToObjects, splitMapList, toCsv } from './csv'

describe('toCsv —— 渲染', () => {
  it('基本渲染，行尾用 CRLF', () => {
    expect(toCsv([['a', 'b'], ['1', '2']])).toBe('\uFEFFa,b\r\n1,2\r\n')
  })

  it('⭐ 默认带 UTF-8 BOM（否则 Windows 版 Excel 打开中文乱码）', () => {
    const out = toCsv([['中文']])
    expect(out.charCodeAt(0)).toBe(0xfeff)
  })

  it('可以关掉 BOM', () => {
    expect(toCsv([['中文']], { bom: false })).toBe('中文\r\n')
  })

  it('含逗号的字段会被引号包裹', () => {
    expect(toCsv([['a,b']], { bom: false })).toBe('"a,b"\r\n')
  })

  it('字段内的双引号会翻倍', () => {
    expect(toCsv([['说"你好"']], { bom: false })).toBe('"说""你好"""\r\n')
  })

  it('含换行的字段会被引号包裹', () => {
    expect(toCsv([['第一行\n第二行']], { bom: false })).toBe('"第一行\n第二行"\r\n')
  })

  it('null / undefined 渲染成空串', () => {
    expect(toCsv([[null, undefined, 0]], { bom: false })).toBe(',,0\r\n')
  })
})

describe('parseCsv —— 解析', () => {
  it('基本解析', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('⭐ 自动去掉 BOM', () => {
    expect(parseCsv('\uFEFFa,b')).toEqual([['a', 'b']])
  })

  it('⭐ 引号内的逗号不当分隔符', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']])
  })

  it('⭐ 引号内的换行不当换行', () => {
    expect(parseCsv('"第一行\n第二行",x')).toEqual([['第一行\n第二行', 'x']])
  })

  it('⭐ 双引号转义（"" 表示一个字面双引号）', () => {
    expect(parseCsv('"说""你好""",x')).toEqual([['说"你好"', 'x']])
  })

  it('LF / CRLF / CR 三种行尾都能处理', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']])
    expect(parseCsv('a\r\nb')).toEqual([['a'], ['b']])
    expect(parseCsv('a\rb')).toEqual([['a'], ['b']])
  })

  it('最后一行没有换行也要收进来', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('空文本 → 空结果', () => {
    expect(parseCsv('')).toEqual([])
  })
})

describe('CSV 往返 —— 写出去再读回来应该一致', () => {
  it('⭐ 各种刁钻内容都能原样往返', () => {
    const rows: string[][] = [
      ['普通', '含,逗号', '含"引号', '含\n换行', '', ' 前后空格 '],
      ['第二行', 'a', 'b', 'c', 'd', 'e'],
    ]
    const back = parseCsv(toCsv(rows))
    // 注意：值里的前后空格是我们自己 trim 的，不是 CSV 规范要求的
    expect(back[0]).toEqual(rows[0])
    expect(back[1]).toEqual(rows[1])
  })
})

describe('rowsToObjects —— 按表头映射成对象', () => {
  it('正常映射', () => {
    const { header, objects } = rowsToObjects([
      ['物品名', '地图'],
      ['海洋之泪', '潮汐监狱'],
    ])
    expect(header).toEqual(['物品名', '地图'])
    expect(objects).toEqual([{ 物品名: '海洋之泪', 地图: '潮汐监狱' }])
  })

  it('表头两端空白会被去掉', () => {
    const { objects } = rowsToObjects([[' 物品名 '], ['x']])
    expect(objects[0]).toEqual({ 物品名: 'x' })
  })

  it('⭐ 整行空白的行会被跳过（Excel 常在末尾留空行）', () => {
    const { objects } = rowsToObjects([['a', 'b'], ['1', '2'], ['', ''], ['', '  ']])
    expect(objects).toHaveLength(1)
  })

  it('⭐ 行比表头短时缺的列给空串（用户在 Excel 里删过列也不崩）', () => {
    const { objects } = rowsToObjects([['a', 'b', 'c'], ['1']])
    expect(objects[0]).toEqual({ a: '1', b: '', c: '' })
  })

  it('行比表头长时多余的值被忽略', () => {
    const { objects } = rowsToObjects([['a'], ['1', '2', '3']])
    expect(objects[0]).toEqual({ a: '1' })
  })

  it('单元格值会被 trim', () => {
    const { objects } = rowsToObjects([['a'], ['  值  ']])
    expect(objects[0]).toEqual({ a: '值' })
  })
})

describe('splitMapList —— 地图名分隔符', () => {
  it('⭐ 支持各种分隔符（你在 Excel 里怎么写都行）', () => {
    const expected = ['长弓溪谷', '航天基地']
    expect(splitMapList('长弓溪谷、航天基地')).toEqual(expected)
    expect(splitMapList('长弓溪谷,航天基地')).toEqual(expected)
    expect(splitMapList('长弓溪谷，航天基地')).toEqual(expected)
    expect(splitMapList('长弓溪谷/航天基地')).toEqual(expected) // 人很自然会这么写
    expect(splitMapList('长弓溪谷／航天基地')).toEqual(expected) // 全角斜线
    expect(splitMapList('长弓溪谷|航天基地')).toEqual(expected)
    expect(splitMapList('长弓溪谷 航天基地')).toEqual(expected)
    expect(splitMapList('长弓溪谷;航天基地')).toEqual(expected)
    expect(splitMapList('长弓溪谷；航天基地')).toEqual(expected)
  })

  it('单个名字', () => {
    expect(splitMapList('全地图')).toEqual(['全地图'])
  })

  it('空串与空白 → 空数组', () => {
    expect(splitMapList('')).toEqual([])
    expect(splitMapList('   ')).toEqual([])
    expect(splitMapList('、,，')).toEqual([])
  })

  it('多余分隔符与空白会被清洗', () => {
    expect(splitMapList(' 长弓溪谷 、， 航天基地  ')).toEqual(['长弓溪谷', '航天基地'])
  })
})
