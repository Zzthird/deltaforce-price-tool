/**
 * overrides/item-attributes.ts 的单元测试 —— 人工物品属性标注。
 *
 * 这里装三个官方数据**不提供**、只能人工标注的属性：
 *   ① `availability` 可获得性 —— 能不能在局内摸到
 *   ② `listable`     能不能上架交易行（旧赛季子弹不能）
 *   ③ `unitsPerSlot` 一个格子放几个定价单位（子弹 = 每组发数）
 *
 * 重点测三处：
 *   · **逐字段合并**的语义（留空 = 不动，不是清空）
 *   · 弹药与非弹药的**默认值差异**（弹药不给默认 60，见下面注释）
 *   · 宽容解析（中英文、数字、各种同义词都认）
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SourceItem } from '../sources/types'
import {
  applyItemAttributesOverrides,
  checkAttributeConflicts,
  deriveFromSeasonal,
  loadItemAttributesOverrides,
  parseAvailability,
  parseListable,
  parseSeasonal,
  parseUnitsPerSlot,
  resolveUnitsPerSlot,
  serializeItemAttributesOverrides,
  type ItemAttributesOverrides,
} from './item-attributes'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'df-attr-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeJson(name: string, content: string): Promise<string> {
  const p = join(dir, name)
  await writeFile(p, content, 'utf8')
  return p
}

function makeItem(over: Partial<SourceItem> = {}): SourceItem {
  return {
    sourceItemId: '1',
    name: '某物品',
    alias: null,
    description: null,
    iconUrl: '',
    thumbUrl: null,
    categoryCode: 'props',
    subcategory: 'collection',
    subcategoryCn: '收集品',
    thirdClass: null,
    thirdClassCn: null,
    itemSubtype: null,
    rawProvenance: null,
    grade: 6,
    weight: null,
    width: 1,
    length: 1,
    basePrice: null,
    officialAvgPrice: null,
    lastUpdate: null,
    propsDetail: null,
    ...over,
  }
}

const noOverrides: ItemAttributesOverrides = { entries: new Map(), rawKeyCount: 0 }

/* ══════════════════════════ 宽容解析 ══════════════════════════ */

describe('parseAvailability —— 可获得性', () => {
  it('可摸的多种写法', () => {
    for (const s of ['可摸', '正常', '能摸', 'lootable', 'OK', '0']) {
      expect(parseAvailability(s)).toBe('lootable')
    }
  })

  it('⭐ 「限时下架」—— 曾经能拾，可能返场（旧赛季子弹）', () => {
    for (const s of ['限时下架', '下架', '赛季结束', '赛季限定', '活动限定', '活动结束']) {
      expect(parseAvailability(s)).toBe('expired')
    }
  })

  it('⭐ 「非战利品」—— 机制上不产出，不随赛季变化', () => {
    for (const s of ['非战利品', '不可拾取', '不是战利品', '只能兑换', '兑换', '制造', '任务奖励']) {
      expect(parseAvailability(s)).toBe('unobtainable')
    }
  })

  it('旧叫法仍然能认（向后兼容），但不推荐再用', () => {
    // 「已失效」/「不可摸」只说了“现在拾不到”，没表达“会不会回来”
    expect(parseAvailability('已失效')).toBe('expired')
    expect(parseAvailability('失效')).toBe('expired')
    expect(parseAvailability('已下架')).toBe('expired')
    expect(parseAvailability('不可摸')).toBe('unobtainable')
    expect(parseAvailability('摸不到')).toBe('unobtainable')
    expect(parseAvailability('unobtainable')).toBe('unobtainable')
    expect(parseAvailability('expired')).toBe('expired')
  })

  it('数字简写', () => {
    expect(parseAvailability('0')).toBe('lootable')
    expect(parseAvailability('1')).toBe('unobtainable')
    expect(parseAvailability('2')).toBe('expired')
  })

  it('认不出来 → null', () => {
    expect(parseAvailability('瞎写的')).toBeNull()
    expect(parseAvailability('')).toBeNull()
  })
})

describe('parseListable —— 能不能上架交易行', () => {
  it('⭐ 留空 → null（表示"不动"，沿用默认的"可上架"）', () => {
    expect(parseListable('')).toBeNull()
    expect(parseListable('   ')).toBeNull()
  })

  it('肯定写法', () => {
    for (const s of ['是', '可', '可以', '可上架', '能', 'true', 'yes', '1']) {
      expect(parseListable(s)).toBe(true)
    }
  })

  it('否定写法', () => {
    for (const s of ['否', '不', '不可', '不能', 'false', 'no', '0']) {
      expect(parseListable(s)).toBe(false)
    }
  })

  it('⭐「不可上架」→ false（先判否定，否则会因含「可」而被当成 true）', () => {
    // 这是真 bug：用户填了 278 行「不可上架」，原来的精确匹配全都不认
    expect(parseListable('不可上架')).toBe(false)
    expect(parseListable('不能上架')).toBe(false)
    expect(parseListable('不可交易行')).toBe(false)
    expect(parseListable('  不可上架  ')).toBe(false)
  })

  it('⭐「可上架」→ true', () => {
    expect(parseListable('可上架')).toBe(true)
    expect(parseListable('可以上架')).toBe(true)
  })

  it('认不出来 → null（不猜）', () => {
    expect(parseListable('也许')).toBeNull()
    expect(parseListable('待定')).toBeNull()
  })
})

describe('parseUnitsPerSlot —— 每组发数', () => {
  it('正整数', () => {
    expect(parseUnitsPerSlot('60')).toBe(60)
    expect(parseUnitsPerSlot(' 90 ')).toBe(90)
    expect(parseUnitsPerSlot('1')).toBe(1)
  })

  it('⭐ 留空 / 非正数 / 非数字 → null（当作"没填"）', () => {
    expect(parseUnitsPerSlot('')).toBeNull()
    expect(parseUnitsPerSlot('0')).toBeNull()
    expect(parseUnitsPerSlot('-5')).toBeNull()
    expect(parseUnitsPerSlot('六十')).toBeNull()
  })

  it('小数向下取整', () => {
    expect(parseUnitsPerSlot('60.9')).toBe(60)
  })
})

/* ══════════════════════════ resolveUnitsPerSlot ══════════════════════════ */

describe('resolveUnitsPerSlot —— 默认值规则（只此一处实现）', () => {
  it('⭐ 非弹药默认 1', () => {
    expect(resolveUnitsPerSlot('props', undefined)).toBe(1)
    expect(resolveUnitsPerSlot('gun', undefined)).toBe(1)
  })

  it('⭐ 弹药**没有**默认值 —— 返回 null（未知）', () => {
    // 这是刻意的：不给弹药默认 60，否则会把"每发价"无声无息当成"每格价"，
    // 而 1,666/格 看上去完全合理 —— 那就是我们要修的那个 bug
    expect(resolveUnitsPerSlot('ammo', undefined)).toBeNull()
  })

  it('有标注就尊重标注（弹药也不例外）', () => {
    expect(resolveUnitsPerSlot('ammo', { unitsPerSlot: 60 })).toBe(60)
    expect(resolveUnitsPerSlot('ammo', { unitsPerSlot: 90 })).toBe(90)
    expect(resolveUnitsPerSlot('props', { unitsPerSlot: 5 })).toBe(5)
  })

  it('显式 null 视为没标', () => {
    expect(resolveUnitsPerSlot('ammo', { unitsPerSlot: null })).toBeNull()
    expect(resolveUnitsPerSlot('props', { unitsPerSlot: null })).toBe(1)
  })
})

/* ══════════════════════════ load ══════════════════════════ */

describe('loadItemAttributesOverrides —— 读取与校验', () => {
  it('文件不存在 → missing，不报错', async () => {
    const r = await loadItemAttributesOverrides(join(dir, '无.json'))
    expect(r.missing).toBe(true)
    expect(r.overrides.entries.size).toBe(0)
  })

  it('简写：直接给状态字符串 = 只标可获得性', async () => {
    const p = await writeJson('a.json', JSON.stringify({ 某活动品: '已失效' }))
    const r = await loadItemAttributesOverrides(p)
    expect(r.problems).toEqual([])
    expect(r.overrides.entries.get('某活动品')).toEqual({ availability: 'expired' })
  })

  it('完整形式：三种属性都能标', async () => {
    const p = await writeJson(
      'a.json',
      JSON.stringify({
        某子弹: { availability: 'lootable', listable: false, unitsPerSlot: 90, note: '旧赛季' },
      }),
    )
    const r = await loadItemAttributesOverrides(p)
    expect(r.overrides.entries.get('某子弹')).toEqual({
      availability: 'lootable',
      listable: false,
      unitsPerSlot: 90,
      note: '旧赛季',
    })
  })

  it('只标一个属性也可以', async () => {
    const p = await writeJson('a.json', JSON.stringify({ 某子弹: { unitsPerSlot: 60 } }))
    const r = await loadItemAttributesOverrides(p)
    expect(r.overrides.entries.get('某子弹')).toEqual({ unitsPerSlot: 60 })
  })

  it('⭐ JSON 语法错误 → 报错 + 跳过全部标注（全部用默认值，不崩）', async () => {
    const p = await writeJson('a.json', '{ 坏了 }')
    const r = await loadItemAttributesOverrides(p)
    expect(r.overrides.entries.size).toBe(0)
    expect(r.problems[0]!.message).toContain('JSON 语法错误')
  })

  it('⭐ 单条格式不对 → 只跳过那一条', async () => {
    const p = await writeJson(
      'a.json',
      JSON.stringify({ 好的: '不可摸', 坏的: 123, 也坏: { unitsPerSlot: -1 }, 空的: {} }),
    )
    const r = await loadItemAttributesOverrides(p)
    expect(r.overrides.entries.size).toBe(1)
    expect(r.problems).toHaveLength(3)
  })

  it('顶层不是对象 → 报错', async () => {
    const p = await writeJson('a.json', '"不可摸"')
    const r = await loadItemAttributesOverrides(p)
    expect(r.problems[0]!.message).toContain('顶层必须是一个对象')
  })
})

/* ══════════════════════════ apply ══════════════════════════ */

describe('applyItemAttributesOverrides —— 合并（纯函数）', () => {
  it('⭐ 无标注 → 所有属性都用默认值', () => {
    const { byItemId } = applyItemAttributesOverrides([makeItem()], noOverrides)
    expect(byItemId.get('1')).toEqual({
      availability: 'lootable',
      listable: true,
      unitsPerSlot: 1,
      seasonal: null,
      note: null,
      manual: false,
    })
  })

  it('⭐ 无标注的弹药 → unitsPerSlot 是 null（算不出单格价值）', () => {
    const { byItemId, stats } = applyItemAttributesOverrides(
      [makeItem({ categoryCode: 'ammo' })],
      noOverrides,
    )
    expect(byItemId.get('1')!.unitsPerSlot).toBeNull()
    expect(stats.unitsUnknown).toBe(1)
  })

  it('标注了不可上架 + 每组发数', () => {
    const { byItemId, stats } = applyItemAttributesOverrides([makeItem({ categoryCode: 'ammo' })], {
      entries: new Map([['某物品', { listable: false, unitsPerSlot: 90 }]]),
      rawKeyCount: 1,
    })
    expect(byItemId.get('1')).toMatchObject({ listable: false, unitsPerSlot: 90, manual: true })
    expect(stats.notListable).toBe(1)
    expect(stats.unitsUnknown).toBe(0)
  })

  it('⭐ objectID 优先于物品名', () => {
    const { byItemId, stats } = applyItemAttributesOverrides([makeItem({ sourceItemId: '999' })], {
      entries: new Map([
        ['某物品', { availability: 'expired' as const }],
        ['999', { availability: 'unobtainable' as const }],
      ]),
      rawKeyCount: 2,
    })
    expect(byItemId.get('999')!.availability).toBe('unobtainable')
    expect(stats.matchedById).toBe(1)
    expect(stats.unmatchedKeys).toEqual(['某物品'])
  })

  it('统计口径对得上', () => {
    // ⚠️ 注意每个物品要有**不同的名字** —— 同名会让按名称匹配的三个物品
    //    都命中同一条覆盖（自定义匹配是优先级高于名字的）
    const items = [
      makeItem({ sourceItemId: '1', name: '道具甲' }),
      makeItem({ sourceItemId: '2', name: '子弹乙', categoryCode: 'ammo' }),
      makeItem({ sourceItemId: '3', name: '道具丙' }),
    ]
    const { stats } = applyItemAttributesOverrides(items, {
      entries: new Map([
        ['道具甲', { listable: false }],
        ['2', { unitsPerSlot: 60 }],
      ]),
      rawKeyCount: 2,
    })
    expect(stats.totalItems).toBe(3)
    expect(stats.notListable).toBe(1) // 只有「道具甲」标了不可上架
    expect(stats.unitsUnknown).toBe(0) // 乙标了 60，甲/丙非弹药默认 1
    expect(stats.matchedById).toBe(1)
    expect(stats.matchedByName).toBe(1)
    expect(stats.lootable + stats.unobtainable + stats.expired).toBe(3)
  })

  it('输入为空不崩', () => {
    const { byItemId, stats } = applyItemAttributesOverrides([], noOverrides)
    expect(byItemId.size).toBe(0)
    expect(stats.totalItems).toBe(0)
  })
})

/* ══════════════════════════ 赛季限定 ══════════════════════════ */

describe('parseSeasonal —— 赛季限定列', () => {
  it('本季的多种写法', () => {
    for (const s of ['本季', '本赛季', '当前赛季', '本季限定', '本季弹', 'current', '1']) {
      expect(parseSeasonal(s)).toBe('current')
    }
  })

  it('往季的多种写法', () => {
    for (const s of ['往季', '上季', '旧赛季', '往季限定', '往季弹', 'past', 'old', '0']) {
      expect(parseSeasonal(s)).toBe('past')
    }
  })

  it('⭐ 留空 = 不是赛季限定', () => {
    expect(parseSeasonal('')).toBeNull()
    expect(parseSeasonal('   ')).toBeNull()
  })

  it('认不出来 → null（不猜）', () => {
    expect(parseSeasonal('也许')).toBeNull()
  })
})

describe('deriveFromSeasonal —— 换季自动更新的全部逻辑', () => {
  it('⭐ 本季弹 → 可摸 + 可上架', () => {
    expect(deriveFromSeasonal('current')).toEqual({ availability: 'lootable', listable: true })
  })

  it('⭐ 往季弹 → 限时下架 + 不可上架', () => {
    expect(deriveFromSeasonal('past')).toEqual({ availability: 'expired', listable: false })
  })

  it('⭐ 不是赛季限定 → null（由默认值决定，不插手）', () => {
    expect(deriveFromSeasonal(null)).toBeNull()
  })
})

describe('applyItemAttributesOverrides —— 赛季限定推导与优先级', () => {
  it('⭐ 本季弹：不写 availability/listable 也能推导出正确状态', () => {
    const { byItemId, stats } = applyItemAttributesOverrides([makeItem({ categoryCode: 'ammo' })], {
      entries: new Map([
        ['某物品', { seasonal: 'current' as const, unitsPerSlot: 60 }],
      ]),
      rawKeyCount: 1,
    })
    expect(byItemId.get('1')).toMatchObject({
      seasonal: 'current',
      availability: 'lootable',
      listable: true,
      unitsPerSlot: 60,
    })
    expect(stats.seasonalCurrent).toBe(1)
  })

  it('⭐ 往季弹：自动变成限时下架 + 不可上架', () => {
    const { byItemId, stats } = applyItemAttributesOverrides([makeItem({ categoryCode: 'ammo' })], {
      entries: new Map([['某物品', { seasonal: 'past' as const }]]),
      rawKeyCount: 1,
    })
    expect(byItemId.get('1')).toMatchObject({
      seasonal: 'past',
      availability: 'expired',
      listable: false,
    })
    expect(stats.seasonalPast).toBe(1)
    expect(stats.expired).toBe(1)
    expect(stats.notListable).toBe(1)
  })

  it('⭐ **显式标注优先于赛季推导**（用于处理返场等例外）', () => {
    // 一颗往季弹返场了：标 seasonal=past 但显式写 listable=true
    const { byItemId } = applyItemAttributesOverrides([makeItem()], {
      entries: new Map([
        ['某物品', { seasonal: 'past' as const, listable: true, availability: 'lootable' as const }],
      ]),
      rawKeyCount: 1,
    })
    expect(byItemId.get('1')).toMatchObject({
      seasonal: 'past', // 标记保留
      listable: true, // 但显式值生效
      availability: 'lootable',
    })
  })
})

describe('checkAttributeConflicts —— 防止改了一列忘了另一列', () => {
  it('⭐ 本季弹却标了不可上架 → 报矛盾', () => {
    const problems = checkAttributeConflicts({
      entries: new Map([['某弹', { seasonal: 'current' as const, listable: false }]]),
      rawKeyCount: 1,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.key).toBe('某弹')
    expect(problems[0]!.message).toContain('以**显式写的**为准')
  })

  it('往季弹却标了可摸 → 报矛盾', () => {
    const problems = checkAttributeConflicts({
      entries: new Map([
        ['某弹', { seasonal: 'past' as const, availability: 'lootable' as const }],
      ]),
      rawKeyCount: 1,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('availability')
  })

  it('一致时不报', () => {
    const problems = checkAttributeConflicts({
      entries: new Map([
        ['某弹', { seasonal: 'past' as const, availability: 'expired' as const, listable: false }],
      ]),
      rawKeyCount: 1,
    })
    expect(problems).toEqual([])
  })

  it('没有赛季限定标记时不报', () => {
    const problems = checkAttributeConflicts({
      entries: new Map([['某物', { listable: false }]]),
      rawKeyCount: 1,
    })
    expect(problems).toEqual([])
  })

  it('同时矛盾两个字段时报两条', () => {
    const problems = checkAttributeConflicts({
      entries: new Map([
        [
          '某弹',
          { seasonal: 'current' as const, listable: false, availability: 'expired' as const },
        ],
      ]),
      rawKeyCount: 1,
    })
    expect(problems).toHaveLength(2)
  })
})

/* ══════════════════════════ ⭐ 不是子弹也能用 ══════════════════════════ */

/**
 * 用户问：“本季/往季 这个标记能用在非子弹上吗？”
 *
 * 答案：能。`seasonal` 是**通用的物品属性**，与 `categoryCode` 无关。
 * 赛季更替会让一批东西同时变状态，子弹只是其中最典型的一种；
 * 赛季限定战利品、活动限定收集品同样适用。
 *
 * 下面这组测试就是把这个答案锁进代码里。
 */
describe('⭐ 赛季限定适用于任何大类（不只弹药）', () => {
  const CASES: Array<{ label: string; categoryCode: string; subcategory: string }> = [
    { label: '弹药的', categoryCode: 'ammo', subcategory: 'ammo5.56x45' },
    { label: '收集品的', categoryCode: 'props', subcategory: 'collection' },
    { label: '消耗品的', categoryCode: 'props', subcategory: 'consume' },
    { label: '钥匙的', categoryCode: 'props', subcategory: 'key' },
    { label: '配件的', categoryCode: 'acc', subcategory: 'accScope' },
    { label: '护甲的', categoryCode: 'protect', subcategory: 'armor' },
  ]

  for (const c of CASES) {
    it(`${c.label}「本季」→ 可摸 + 可上架`, () => {
      const { byItemId } = applyItemAttributesOverrides(
        [makeItem({ categoryCode: c.categoryCode, subcategory: c.subcategory })],
        {
          entries: new Map([['某物品', { seasonal: 'current' as const }]]),
          rawKeyCount: 1,
        },
      )
      expect(byItemId.get('1')).toMatchObject({
        seasonal: 'current',
        availability: 'lootable',
        listable: true,
      })
    })

    it(`${c.label}「往季」→ 限时下架 + 不可上架`, () => {
      const { byItemId } = applyItemAttributesOverrides(
        [makeItem({ categoryCode: c.categoryCode, subcategory: c.subcategory })],
        {
          entries: new Map([['某物品', { seasonal: 'past' as const }]]),
          rawKeyCount: 1,
        },
      )
      expect(byItemId.get('1')).toMatchObject({
        seasonal: 'past',
        availability: 'expired',
        listable: false,
      })
    })
  }

  it('⭐ 非弹药的赛季物品：遇到“往季但仍能上架”的例外，可用显式写法覆盖', () => {
    const { byItemId } = applyItemAttributesOverrides(
      [makeItem({ categoryCode: 'props', subcategory: 'collection' })], // 名字默认是「某物品」
      {
        entries: new Map([
          ['某物品', { seasonal: 'past' as const, listable: true }],
        ]),
        rawKeyCount: 1,
      },
    )
    expect(byItemId.get('1')).toMatchObject({
      seasonal: 'past',
      availability: 'expired', // 推导生效：摸不到了
      listable: true, // 显式覆盖：但还能卖
    })
  })
})

/* ══════════════════════════ serialize ══════════════════════════ */

describe('serializeItemAttributesOverrides —— 序列化', () => {
  it('只写有值的字段（保持文件干净）', () => {
    const out = serializeItemAttributesOverrides({
      entries: new Map([
        ['甲', { listable: false }],
        ['乙', { unitsPerSlot: 60, note: '一组 60 发' }],
      ]),
      rawKeyCount: 2,
    })
    const parsed = JSON.parse(out)
    expect(parsed['甲']).toEqual({ listable: false })
    expect(parsed['乙']).toEqual({ unitsPerSlot: 60, note: '一组 60 发' })
  })

  it('往返一致', async () => {
    const original: ItemAttributesOverrides = {
      entries: new Map([['某子弹', { listable: false, unitsPerSlot: 90 }]]),
      rawKeyCount: 1,
    }
    const p = await writeJson('rt.json', serializeItemAttributesOverrides(original))
    const back = await loadItemAttributesOverrides(p)
    expect(back.overrides.entries.get('某子弹')).toEqual({ listable: false, unitsPerSlot: 90 })
  })
})
