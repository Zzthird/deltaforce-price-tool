/**
 * store.ts 的单元测试 —— 落盘、读取、保护机制。
 *
 * 这里测的是**数据安全**：写到一半断电怎么办、源站改字段怎么办、
 * 某个分类临时失败怎么办。这三个问题都发生在"你没在看的时候"，
 * 所以必须有测试盯着。
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeQuote, makeSourceItem, makeTempDir } from './test-helpers'
import {
  appendHistory,
  groupByPartition,
  historyFilePath,
  loadHistory,
  loadRefreshState,
  loadSnapshot,
  mergeIntoSnapshot,
  pruneHistory,
  saveRefreshState,
  saveSnapshot,
  writeFileAtomic,
  EMPTY_REFRESH_STATE,
  SNAPSHOT_VERSION,
  type Snapshot,
} from './store'

let dir: string
beforeEach(async () => {
  dir = await makeTempDir('df-store-')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/* ══════════════════════════ 原子写 ══════════════════════════ */

describe('writeFileAtomic', () => {
  it('写入内容并自动建目录', async () => {
    const p = join(dir, 'a', 'b', 'x.txt')
    await writeFileAtomic(p, '你好')
    expect(await readFile(p, 'utf8')).toBe('你好')
  })

  it('⭐ 不留 .tmp 残留（rename 而不是拷贝）', async () => {
    const p = join(dir, 'x.txt')
    await writeFileAtomic(p, '内容')
    const names = await readdir(dir)
    expect(names).toContain('x.txt')
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false)
  })

  it('覆盖已有文件', async () => {
    const p = join(dir, 'x.txt')
    await writeFileAtomic(p, '旧')
    await writeFileAtomic(p, '新')
    expect(await readFile(p, 'utf8')).toBe('新')
  })
})

/* ══════════════════════════ 快照 0 条保护 ══════════════════════════ */

function makeSnapshot(): Snapshot {
  return {
    meta: {
      version: SNAPSHOT_VERSION,
      fetchedAt: '2026-09-28T06:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: 'moligod',
      priceBasis: '测试口径',
      failedPartitions: [],
      requestCount: 8,
    },
    partitions: { props: [makeSourceItem()] },
    prices: { 海洋之泪: makeQuote({ price: 100 }) },
  }
}

describe('saveSnapshot —— 写入与 0 条保护', () => {
  it('正常写入后能读回来', async () => {
    const p = join(dir, 'snap.json')
    expect(await saveSnapshot(p, makeSnapshot())).toBe(true)
    const back = await loadSnapshot(p)
    expect(back?.partitions['props']).toHaveLength(1)
    expect(back?.prices['海洋之泪']?.price).toBe(100)
  })

  it('⭐ **拒绝写入 0 条快照**（否则源站改字段时会洗掉几周的数据）', async () => {
    const p = join(dir, 'snap.json')
    const empty: Snapshot = { ...makeSnapshot(), partitions: {} }
    expect(await saveSnapshot(p, empty)).toBe(false)
    // 确认没写进去
    expect(await loadSnapshot(p)).toBeNull()
  })

  it('⭐ 0 条时**不碰**已有的好快照', async () => {
    const p = join(dir, 'snap.json')
    await saveSnapshot(p, makeSnapshot())

    const empty: Snapshot = { ...makeSnapshot(), partitions: {} }
    expect(await saveSnapshot(p, empty)).toBe(false)

    const back = await loadSnapshot(p)
    expect(back?.partitions['props']).toHaveLength(1) // 旧数据还在
  })
})

describe('loadSnapshot —— 读取与容错', () => {
  it('文件不存在 → null（首次运行的合法状态）', async () => {
    expect(await loadSnapshot(join(dir, '没有.json'))).toBeNull()
  })

  it('⭐ JSON 坏了 → null，不抛异常', async () => {
    const p = join(dir, 'bad.json')
    await writeFile(p, '{ 坏了', 'utf8')
    expect(await loadSnapshot(p)).toBeNull()
  })

  it('⭐ 版本号不符 → null（结构变过，不能当真）', async () => {
    const p = join(dir, 'old.json')
    await writeFile(p, JSON.stringify({ meta: { version: 0 }, partitions: {} }), 'utf8')
    expect(await loadSnapshot(p)).toBeNull()
  })

  it('缺少 partitions → null', async () => {
    const p = join(dir, 'bad2.json')
    await writeFile(p, JSON.stringify({ meta: { version: SNAPSHOT_VERSION } }), 'utf8')
    expect(await loadSnapshot(p)).toBeNull()
  })
})

/* ══════════════════════════ 分区与合并 ══════════════════════════ */

describe('groupByPartition', () => {
  it('按 categoryCode 分组', () => {
    const grouped = groupByPartition([
      makeSourceItem({ sourceItemId: '1', categoryCode: 'props' }),
      makeSourceItem({ sourceItemId: '2', categoryCode: 'ammo' }),
      makeSourceItem({ sourceItemId: '3', categoryCode: 'props' }),
    ])
    expect(grouped['props']).toHaveLength(2)
    expect(grouped['ammo']).toHaveLength(1)
  })

  it('categoryCode 为空时放进 unknown', () => {
    expect(groupByPartition([makeSourceItem({ categoryCode: '' })])['unknown']).toHaveLength(1)
  })
})

describe('mergeIntoSnapshot —— 部分失败时保留旧分区', () => {
  const previous: Snapshot = {
    meta: { ...makeSnapshot().meta },
    partitions: {
      props: [makeSourceItem({ sourceItemId: 'old-props' })],
      ammo: [makeSourceItem({ sourceItemId: 'old-ammo', categoryCode: 'ammo' })],
    },
    prices: { 旧物品: makeQuote({ price: 1 }) },
  }

  it('⭐ 成功的分区用新数据，失败的分区沿用旧数据', () => {
    const { snapshot, keptPartitions } = mergeIntoSnapshot(previous, {
      fetchedAt: '2026-09-28T07:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: 'moligod',
      priceBasis: null,
      items: [makeSourceItem({ sourceItemId: 'new-props' })],
      okPartitions: ['props'],
      failedPartitions: [{ key: 'ammo', error: 'HTTP 500' }],
      prices: new Map([['海洋之泪', makeQuote()]]),
      priceFetchFailed: false,
      requestCount: 7,
    })

    expect(snapshot.partitions['props']!.map((i) => i.sourceItemId)).toEqual(['new-props'])
    expect(snapshot.partitions['ammo']!.map((i) => i.sourceItemId)).toEqual(['old-ammo'])
    expect(keptPartitions).toContain('ammo')
    expect(snapshot.meta.failedPartitions).toEqual([{ key: 'ammo', error: 'HTTP 500' }])
  })

  it('⭐ 价格源失败 → 整份沿用旧价格（不是清空）', () => {
    const { snapshot, keptPrices } = mergeIntoSnapshot(previous, {
      fetchedAt: '2026-09-28T07:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: 'moligod',
      priceBasis: null,
      items: [makeSourceItem({ sourceItemId: 'new-props' })],
      okPartitions: ['props'],
      failedPartitions: [],
      prices: new Map(),
      priceFetchFailed: true,
      requestCount: 7,
    })

    expect(keptPrices).toBe(true)
    expect(snapshot.prices['旧物品']?.price).toBe(1)
  })

  it('⭐ 分区“成功”但 0 条 → 也沿用旧数据（源站可能改了字段）', () => {
    const { snapshot, keptPartitions } = mergeIntoSnapshot(previous, {
      fetchedAt: '2026-09-28T07:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: null,
      priceBasis: null,
      items: [],
      okPartitions: ['props'],
      failedPartitions: [],
      prices: new Map(),
      priceFetchFailed: false,
      requestCount: 1,
    })

    expect(snapshot.partitions['props']!.map((i) => i.sourceItemId)).toEqual(['old-props'])
    expect(keptPartitions).toContain('props')
  })

  it('没有旧快照时也能工作（首次抓取）', () => {
    const { snapshot } = mergeIntoSnapshot(null, {
      fetchedAt: '2026-09-28T07:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: null,
      priceBasis: null,
      items: [makeSourceItem({ sourceItemId: 'a' })],
      okPartitions: ['props'],
      failedPartitions: [],
      prices: new Map(),
      priceFetchFailed: false,
      requestCount: 1,
    })
    expect(snapshot.partitions['props']).toHaveLength(1)
  })
})

/* ══════════════════════════ 历史快照 ══════════════════════════ */

describe('历史快照', () => {
  const day1 = new Date(2026, 8, 28, 10, 0, 0)

  it('historyFilePath 用 YYYY-MM-DD.json', () => {
    expect(historyFilePath(dir, day1)).toBe(join(dir, '2026-09-28.json'))
  })

  it('追加：只存有价格的，同一天内按 objectID 覆盖', async () => {
    await appendHistory(dir, [{ sourceItemId: '1', price: 100 }, { sourceItemId: '2', price: null }], day1)
    await appendHistory(dir, [{ sourceItemId: '1', price: 200 }, { sourceItemId: '3', price: 300 }], day1)

    const file = await loadHistory(dir, day1)
    expect(file?.prices['1']).toBe(200) // 被覆盖成最新
    expect(file?.prices['2']).toBeUndefined() // 无价格的不存
    expect(file?.prices['3']).toBe(300)
  })

  it('不同天写不同文件', async () => {
    const day2 = new Date(2026, 8, 29, 10, 0, 0)
    await appendHistory(dir, [{ sourceItemId: '1', price: 100 }], day1)
    await appendHistory(dir, [{ sourceItemId: '1', price: 500 }], day2)
    expect((await loadHistory(dir, day1))?.prices['1']).toBe(100)
    expect((await loadHistory(dir, day2))?.prices['1']).toBe(500)
  })

  it('读不存在的日期 → null', async () => {
    expect(await loadHistory(dir, new Date(2020, 0, 1))).toBeNull()
  })

  it('⭐ 轮转：只删过期且**名字严格匹配**的文件', async () => {
    await appendHistory(dir, [{ sourceItemId: '1', price: 1 }], new Date(2026, 8, 1))
    await appendHistory(dir, [{ sourceItemId: '1', price: 1 }], new Date(2026, 8, 20))
    await appendHistory(dir, [{ sourceItemId: '1', price: 1 }], new Date(2026, 8, 28))
    // 一个不该被碰的文件
    await writeFile(join(dir, 'note.txt'), '别删我', 'utf8')
    await writeFile(join(dir, '2026-08-01.bak'), '也不是我们的命名', 'utf8')

    const removed = await pruneHistory(dir, 8, new Date(2026, 8, 28, 12, 0, 0))

    expect(removed).toEqual(['2026-09-01.json'])
    const names = await readdir(dir)
    expect(names).toContain('note.txt')
    expect(names).toContain('2026-08-01.bak')
    expect(names).toContain('2026-09-20.json')
    expect(names).toContain('2026-09-28.json')
  })

  it('目录不存在时不报错', async () => {
    expect(await pruneHistory(join(dir, '没有这个目录'), 8, day1)).toEqual([])
  })
})

/* ══════════════════════════ 运行时状态 ══════════════════════════ */

describe('抓取状态（跨重启保留）', () => {
  it('没有状态文件时返回干净的初始状态', async () => {
    expect(await loadRefreshState(join(dir, '没有.json'))).toEqual(EMPTY_REFRESH_STATE)
  })

  it('写入后能读回来（失败计数与冷却靠它跨重启）', async () => {
    const p = join(dir, 'state.json')
    await saveRefreshState(p, {
      lastAttemptAt: '2026-09-28T06:00:00.000Z',
      lastOkAt: null,
      lastError: 'HTTP 500',
      consecutiveFailures: 3,
      lastDurationMs: 1234,
    })
    const back = await loadRefreshState(p)
    expect(back.consecutiveFailures).toBe(3)
    expect(back.lastError).toBe('HTTP 500')
  })

  it('文件坏了 → 回退初始状态，不崩', async () => {
    const p = join(dir, 'bad.json')
    await mkdir(dir, { recursive: true })
    await writeFile(p, '不是 JSON', 'utf8')
    expect(await loadRefreshState(p)).toEqual(EMPTY_REFRESH_STATE)
  })
})

/* ══════════════ ⭐ 硬排除的大类必须能从快照里消失（实测连环坑） ══════════════ */

/**
 * 这一组锁住一个**实测踩到的连环坑**：
 *
 * 硬排除（`HARD_EXCLUDED_CATEGORY_CODES` = 载具 / 皮肤）看起来只是在源适配器里
 * `filter` 一下就完事 —— 但落盘时会被 store 的两道守卫**救回来**：
 *
 *   ① “分区成功但 0 条 → 可疑 → 沿用旧数据”（怕源站改了字段名）
 *   ② “不在 okPartitions 也不在 failedPartitions → 保守保留”
 *
 * 而硬排除的大类正是"永远 0 条"，于是旧快照里的 10 条皮肤被一次次搬回来，
 * 硬排除形同虚设。实测日志：
 *
 *   WARN 分区抓到 0 条，已沿用旧数据 {"partition":"skin"}
 *   DEBUG 快照已落盘 {"items":1574}   ← 本该是 1564
 *
 * 所以 store 里要有最后一道清理，且**必须在两道守卫之后**跑。
 */
describe('mergeIntoSnapshot —— 硬排除的大类/物品', () => {
  it('⭐ 旧快照里的 skin 分区会被删掉（即使源这轮也返回旧数据）', () => {
    const previous: Snapshot = {
      meta: { ...makeSnapshot().meta },
      partitions: {
        props: [makeSourceItem({ sourceItemId: 'p1' })],
        skin: [makeSourceItem({ sourceItemId: 's1', categoryCode: 'skin' })],
      },
      prices: {},
    }

    const { snapshot } = mergeIntoSnapshot(previous, {
      fetchedAt: '2026-09-28T07:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: 'moligod',
      priceBasis: null,
      items: [makeSourceItem({ sourceItemId: 'p2' })],
      okPartitions: ['props'],
      failedPartitions: [],
      prices: new Map(),
      priceFetchFailed: false,
      requestCount: 1,
    })

    expect(snapshot.partitions['skin']).toBeUndefined()
    expect(snapshot.partitions['props']!.map((i) => i.sourceItemId)).toEqual(['p2'])
  })

  it('⭐ 被排除的物品（按官方ID）也会从旧快照里清掉', () => {
    const previous: Snapshot = {
      meta: { ...makeSnapshot().meta },
      partitions: {
        acc: [
          makeSourceItem({ sourceItemId: '13020000590', categoryCode: 'acc' }),
          makeSourceItem({ sourceItemId: '13020000595', categoryCode: 'acc' }),
          makeSourceItem({ sourceItemId: '正常配件', categoryCode: 'acc' }),
        ],
      },
      prices: {},
    }

    const { snapshot } = mergeIntoSnapshot(previous, {
      fetchedAt: '2026-09-28T07:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: 'moligod',
      priceBasis: null,
      items: [],
      okPartitions: [],
      failedPartitions: [],
      prices: new Map(),
      priceFetchFailed: false,
      requestCount: 0,
    })

    expect(snapshot.partitions['acc']!.map((i) => i.sourceItemId)).toEqual(['正常配件'])
  })

  it('⭐ 排除掉的分区不参与“0 条 = 可疑”判定（否则每轮都打误导性警告）', () => {
    const previous: Snapshot = {
      meta: { ...makeSnapshot().meta },
      partitions: { skin: [makeSourceItem({ sourceItemId: 's1', categoryCode: 'skin' })] },
      prices: {},
    }

    const { keptPartitions } = mergeIntoSnapshot(previous, {
      fetchedAt: '2026-09-28T07:00:00.000Z',
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: 'moligod',
      priceBasis: null,
      items: [],
      okPartitions: ['skin'], // 源说“这个分类抓成功了”，但 0 条
      failedPartitions: [],
      prices: new Map(),
      priceFetchFailed: false,
      requestCount: 1,
    })

    expect(keptPartitions).not.toContain('skin')
  })
})
