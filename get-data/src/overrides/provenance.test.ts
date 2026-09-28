/**
 * overrides/provenance.ts 的单元测试 —— 出产地覆盖。
 *
 * 这里测的是**人和程序之间的契约**，所以重点是容错：
 * 覆盖文件是手写的，一定会写错（少个逗号、值类型不对、名字打错）。
 * 程序必须**明确报错但不崩**，而且只跳过出问题的那一条。
 *
 * `applyProvenanceOverrides` 是纯函数，所以合并逻辑的测试不需要碰文件系统。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SourceItem } from '../sources/types'
import {
  applyProvenanceOverrides,
  loadProvenanceOverrides,
  serializeProvenanceOverrides,
  validateMapNames,
  type ProvenanceOverrides,
} from './provenance'

/* ══════════════════════════ 测试辅助 ══════════════════════════ */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'df-prov-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeOverrides(name: string, content: string): Promise<string> {
  const p = join(dir, name)
  await writeFile(p, content, 'utf8')
  return p
}

function makeItem(over: Partial<SourceItem> & { name: string; sourceItemId: string }): SourceItem {
  return {
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
    name: over.name,
    sourceItemId: over.sourceItemId,
  }
}

function noOverrides(): ProvenanceOverrides {
  return { entries: new Map(), rawKeyCount: 0 }
}

/* ══════════════════════════ load ══════════════════════════ */

describe('loadProvenanceOverrides —— 读取与校验', () => {
  it('文件不存在 → missing，不报错（首次运行就是这个状态）', async () => {
    const r = await loadProvenanceOverrides(join(dir, '不存在.json'))
    expect(r.missing).toBe(true)
    expect(r.problems).toEqual([])
    expect(r.overrides.entries.size).toBe(0)
  })

  it('空文件 → 视为没有覆盖', async () => {
    const p = await writeOverrides('a.json', '')
    const r = await loadProvenanceOverrides(p)
    expect(r.missing).toBe(false)
    expect(r.overrides.entries.size).toBe(0)
  })

  it('简写形式（直接给数组）= replace', async () => {
    const p = await writeOverrides(
      'a.json',
      JSON.stringify({ 鱼月徽权杖首: ['长弓溪谷', '航天基地'] }),
    )
    const r = await loadProvenanceOverrides(p)
    expect(r.problems).toEqual([])
    expect(r.overrides.entries.get('鱼月徽权杖首')).toEqual({
      mode: 'replace',
      sources: ['长弓溪谷', '航天基地'],
    })
  })

  it('完整形式（{mode, sources}）', async () => {
    const p = await writeOverrides(
      'a.json',
      JSON.stringify({ 海洋之泪: { mode: 'append', sources: ['零号大坝'] } }),
    )
    const r = await loadProvenanceOverrides(p)
    expect(r.overrides.entries.get('海洋之泪')).toEqual({
      mode: 'append',
      sources: ['零号大坝'],
    })
  })

  it('空数组（显式删除）能通过校验', async () => {
    const p = await writeOverrides('a.json', JSON.stringify({ 某物品: [] }))
    const r = await loadProvenanceOverrides(p)
    expect(r.overrides.entries.get('某物品')).toEqual({ mode: 'replace', sources: [] })
  })

  it('⭐ JSON 语法错误 → 明确报错 + 跳过全部覆盖（不崩）', async () => {
    const p = await writeOverrides('a.json', '{ "某物品": ["长弓溪谷", }')
    const r = await loadProvenanceOverrides(p)
    expect(r.overrides.entries.size).toBe(0)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]!.key).toBeNull()
    expect(r.problems[0]!.message).toContain('JSON 语法错误')
  })

  it('⭐ 顶层不是对象 → 明确报错', async () => {
    const p = await writeOverrides('a.json', '["长弓溪谷"]')
    const r = await loadProvenanceOverrides(p)
    expect(r.overrides.entries.size).toBe(0)
    expect(r.problems[0]!.message).toContain('顶层必须是一个对象')
  })

  it('⭐ 单条值类型不对 → 只跳过那一条，其余照常生效', async () => {
    const p = await writeOverrides(
      'a.json',
      JSON.stringify({
        正常条目: ['长弓溪谷'],
        坏条目: 12345,
        也坏: { mode: 'replace' }, // 缺 sources
      }),
    )
    const r = await loadProvenanceOverrides(p)
    expect(r.overrides.entries.size).toBe(1)
    expect(r.overrides.entries.has('正常条目')).toBe(true)
    expect(r.problems.map((x) => x.key).sort()).toEqual(['也坏', '坏条目'])
  })

  it('数组里混了非字符串 → 跳过那一条', async () => {
    const p = await writeOverrides('a.json', JSON.stringify({ 某物品: ['长弓溪谷', 123] }))
    const r = await loadProvenanceOverrides(p)
    expect(r.overrides.entries.size).toBe(0)
    expect(r.problems[0]!.key).toBe('某物品')
  })
})

/* ══════════════════════════ apply ══════════════════════════ */

function withOverrides(record: Record<string, unknown>): ProvenanceOverrides {
  const entries = new Map<string, { mode: 'replace' | 'append'; sources: string[] }>()
  for (const [k, v] of Object.entries(record)) {
    if (Array.isArray(v)) entries.set(k, { mode: 'replace', sources: v as string[] })
  }
  return { entries, rawKeyCount: entries.size }
}

describe('applyProvenanceOverrides —— 合并（纯函数）', () => {
  it('无覆盖 → 沿用官方值，来源标记 official', () => {
    const item = makeItem({
      name: '海洋之泪',
      sourceItemId: '15080050142',
      rawProvenance: '潮汐监狱-全地图',
    })
    const { byItemId, stats } = applyProvenanceOverrides([item], noOverrides())
    expect(byItemId.get('15080050142')).toEqual({
      maps: ['潮汐监狱'],
      source: 'official',
    })
    expect(stats.keptOfficial).toBe(1)
  })

  it('官方也没有数据 → maps 与 source 都是 null', () => {
    const item = makeItem({ name: '反应堆总控核心', sourceItemId: '15050600003' })
    const { byItemId } = applyProvenanceOverrides([item], noOverrides())
    expect(byItemId.get('15050600003')).toEqual({ maps: null, source: null })
  })

  it('⭐ replace：用人工值替换官方值', () => {
    const item = makeItem({
      name: '非洲之心',
      sourceItemId: '15080050006',
      rawProvenance: '长弓溪谷-钻石皇后酒店,航天基地-核心区',
    })
    const { byItemId, stats } = applyProvenanceOverrides(
      [item],
      withOverrides({ 非洲之心: ['巴克什'] }),
    )
    expect(byItemId.get('15080050006')).toEqual({ maps: ['巴克什'], source: 'manual' })
    expect(stats.newlyFilled).toBe(0) // 官方本来就有数据，不算"新增补齐"
  })

  it('⭐ append：官方 ∪ 人工（去重）', () => {
    const item = makeItem({
      name: '海洋之泪',
      sourceItemId: '15080050142',
      rawProvenance: '潮汐监狱-全地图',
    })
    const entries = new Map([
      ['海洋之泪', { mode: 'append' as const, sources: ['零号大坝', '潮汐监狱'] }], // 故意重复一个
    ])
    const { byItemId, stats } = applyProvenanceOverrides([item], { entries, rawKeyCount: 1 })
    // 官方 [潮汐监狱] + 人工 [零号大坝, 潮汐监狱] → 去重后两个
    expect(byItemId.get('15080050142')!.maps).toEqual(['潮汐监狱', '零号大坝'])
    expect(byItemId.get('15080050142')!.source).toBe('merged')
    expect(stats.applied).toBe(1)
    expect(stats.newlyFilled).toBe(0)
  })

  it('⭐ append 且官方无数据 → source 是 manual 而不是 merged', () => {
    const item = makeItem({ name: '反应堆总控核心', sourceItemId: '15050600003' })
    const entries = new Map([
      ['反应堆总控核心', { mode: 'append' as const, sources: ['AZ3'] }],
    ])
    const { byItemId, stats } = applyProvenanceOverrides([item], { entries, rawKeyCount: 1 })
    expect(byItemId.get('15050600003')).toEqual({ maps: ['AZ3'], source: 'manual' })
    expect(stats.newlyFilled).toBe(1) // 从"无数据"变成"有数据"
  })

  it('⭐ 空数组 = 显式删除', () => {
    const item = makeItem({
      name: '电子脚镣',
      sourceItemId: '15080050155',
      rawProvenance: '全地图',
    })
    const { byItemId, stats } = applyProvenanceOverrides(
      [item],
      withOverrides({ 电子脚镣: [] }),
    )
    expect(byItemId.get('15080050155')).toEqual({ maps: null, source: 'manual' })
    expect(stats.explicitlyCleared).toBe(1)
  })

  it('⭐ objectID 优先于物品名（同一条数据两个键都在时）', () => {
    const item = makeItem({ name: '海洋之泪', sourceItemId: '15080050142' })
    const { byItemId, stats } = applyProvenanceOverrides([item], {
      entries: new Map([
        ['海洋之泪', { mode: 'replace' as const, sources: ['按名字匹配'] }],
        ['15080050142', { mode: 'replace' as const, sources: ['按ID匹配'] }],
      ]),
      rawKeyCount: 2,
    })
    expect(byItemId.get('15080050142')!.maps).toEqual(['按ID匹配'])
    expect(stats.matchedById).toBe(1)
    expect(stats.matchedByName).toBe(0)
    // 按名字那条没被用上，所以算"没匹配上"
    expect(stats.unmatchedKeys).toContain('海洋之泪')
  })

  it('⭐ 人工值里写了点位也会被截断（复用同一份解析规则）', () => {
    const item = makeItem({ name: '镜头', sourceItemId: '15030040001' })
    const { byItemId } = applyProvenanceOverrides([item], withOverrides({ 镜头: ['长弓溪谷-哈夫克雷达站'] }))
    expect(byItemId.get('15030040001')!.maps).toEqual(['长弓溪谷'])
  })

  it('⭐ 键没匹配上任何物品 → 记进 unmatchedKeys', () => {
    const { stats } = applyProvenanceOverrides([], withOverrides({ 这个物品不存在: ['巴克什'] }))
    expect(stats.unmatchedKeys).toEqual(['这个物品不存在'])
  })

  it('输入为空不崩', () => {
    const { byItemId, stats } = applyProvenanceOverrides([], noOverrides())
    expect(byItemId.size).toBe(0)
    expect(stats.totalItems).toBe(0)
  })
})

/* ══════════════════════════ validateMapNames ══════════════════════════ */

describe('validateMapNames —— 地图名软校验', () => {
  it('⭐ 用官方数据里没见过的地图名 → 报警告', () => {
    const reports = validateMapNames(withOverrides({ 某物品: ['长弓溪'] }), ['长弓溪谷', '航天基地'])
    expect(reports).toHaveLength(1)
    expect(reports[0]!.mapName).toBe('长弓溪')
    expect(reports[0]!.usedBy).toBe(1)
    expect(reports[0]!.keys).toEqual(['某物品'])
  })

  it('见过的不报', () => {
    expect(validateMapNames(withOverrides({ 某物品: ['长弓溪谷'] }), ['长弓溪谷'])).toEqual([])
  })

  it('⭐ 特殊值「全地图」不算未知', () => {
    expect(validateMapNames(withOverrides({ 某物品: ['全地图'] }), ['长弓溪谷'])).toEqual([])
  })

  it('同一個未知地图名被多条使用时合并报告并计数', () => {
    const reports = validateMapNames(
      withOverrides({ A: ['长弓溪'], B: ['长弓溪'], C: ['另一张图'] }),
      ['长弓溪谷'],
    )
    const hu = reports.find((r) => r.mapName === '长弓溪')
    expect(hu?.usedBy).toBe(2)
    expect(hu?.keys).toEqual(['A', 'B'])
  })

  it('按被使用次数降序', () => {
    const reports = validateMapNames(
      withOverrides({ A: ['罕见的'], B: ['常见的'], C: ['常见的'] }),
      [],
    )
    expect(reports[0]!.mapName).toBe('常见的')
  })
})

/* ══════════════════════════ serialize ══════════════════════════ */

describe('serializeProvenanceOverrides —— 序列化', () => {
  it('统一用完整形式，键与地图名都排序', () => {
    const out = serializeProvenanceOverrides(
      withOverrides({ 乙: ['航天基地', '长弓溪谷'], 甲: ['巴克什'] }),
    )
    const parsed = JSON.parse(out)
    expect(Object.keys(parsed)).toEqual(['甲', '乙']) // 拼音序：甲(jia) < 乙(yi)
    expect(parsed['甲'].mode).toBe('replace')
    // 地图名同样会被排序，但**具体顺序依赖 ICU 的排序规则**（跟 Node 版本有关），
    // 所以只比较集合，不比较顺序
    expect([...parsed['乙'].sources].sort()).toEqual(['长弓溪谷', '航天基地'].sort())
  })

  it('输出的文本能被重新解析回来（往返一致）', async () => {
    const original = withOverrides({ 某物品: ['长弓溪谷'] })
    const p = await writeOverrides('rt.json', serializeProvenanceOverrides(original))
    const back = await loadProvenanceOverrides(p)
    expect(back.overrides.entries.get('某物品')).toEqual({
      mode: 'replace',
      sources: ['长弓溪谷'],
    })
  })
})
