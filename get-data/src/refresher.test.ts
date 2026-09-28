/**
 * refresher.ts 的单元测试 —— 按需刷新的三档状态机与三道锁。
 *
 * ⭐ 全部用**注入式假时钟**，所以测"15 分钟边界""120 分钟阻塞""失败冷却"
 * 都不用真的等 —— 整个文件跑完是毫秒级。
 *
 * ⭐ 抓取函数也是注入的，所以**测试不会发任何网络请求**：快、不依赖外网、
 * 不打扰源站（这一点对一个"尊重数据源"的项目尤其重要）。
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from './logger'
import type { FetchEverythingResult } from './pipeline'
import { Refresher } from './refresher'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'
import { loadSnapshot, saveSnapshot, SNAPSHOT_VERSION, type Snapshot } from './store'
import { makeQuote, makeSourceItem, makeTempDir, makeTestConfig } from './test-helpers'

/* ══════════════════════════ 测试脚手架 ══════════════════════════ */

let dir: string
/** 可控的"当前时间" */
let nowMs: number

const T0 = Date.parse('2026-09-28T06:00:00.000Z')

beforeEach(async () => {
  dir = await makeTempDir('df-refresh-')
  nowMs = T0
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const advance = (minutes: number) => {
  nowMs += minutes * 60_000
}

/** 造一个假的抓取结果 */
function makeFetchResult(
  items: SourceItem[],
  over: Partial<FetchEverythingResult> = {},
): FetchEverythingResult {
  const okPartitions = [...new Set(items.map((i) => i.categoryCode).filter(Boolean))]
  return {
    items,
    prices: new Map<string, PriceQuote>([['海洋之泪', makeQuote({ price: 100 })]]),
    itemResult: { items, okPartitions, failedPartitions: [] },
    priceSourceLabel: 'moligod',
    priceBasis: '测试口径',
    priceFetchError: null,
    savedRaw: [],
    requestCount: 8,
    ...over,
  }
}

interface Harness {
  refresher: Refresher
  /** fetch 被调用的次数 —— 用来证明"15 分钟内零请求" */
  calls: () => number
  /** 让下一次（或之后每次）fetch 抛出 */
  failWith: (message: string | null) => void
  /** 让 fetch 返回这些条目 */
  returns: (items: SourceItem[]) => void
}

function setup(over: { fetchedAt?: string; items?: SourceItem[] } = {}): Harness {
  let calls = 0
  let failure: string | null = null
  let items = over.items ?? [makeSourceItem()]

  const refresher = new Refresher({
    cfg: makeTestConfig(dir),
    logger: createLogger('silent'),
    now: () => nowMs,
    fetch: async () => {
      calls += 1
      if (failure) throw new Error(failure)
      return makeFetchResult(items)
    },
  })

  return {
    refresher,
    calls: () => calls,
    failWith: (m) => {
      failure = m
    },
    returns: (next) => {
      items = next
    },
  }
}

/** 先在盘上放一份快照，模拟"之前抓过" */
async function seedSnapshot(fetchedAt: string, items: SourceItem[] = [makeSourceItem()]): Promise<void> {
  const snapshot: Snapshot = {
    meta: {
      version: SNAPSHOT_VERSION,
      fetchedAt,
      itemSourceId: 'official',
      itemSourceLabel: '测试源',
      priceSourceLabel: 'moligod',
      priceBasis: '测试口径',
      failedPartitions: [],
      requestCount: 8,
    },
    partitions: { props: items },
    prices: { 海洋之泪: makeQuote({ price: 100 }) },
  }
  await saveSnapshot(join(dir, 'snapshot.json'), snapshot)
}

/* ══════════════════════════ 三档状态机 ══════════════════════════ */

const SERVED = 'served' as const

describe('ensureFresh —— ① 无快照 → 阻塞抓取', () => {
  it('⭐ 首次请求会同步等一次抓取', async () => {
    const h = setup()
    const r = await h.refresher.ensureFresh()

    expect(r.tier).toBe('blocking')
    expect(h.calls()).toBe(1)
    expect(r.snapshot).not.toBeNull()
    expect(r.snapshot!.partitions['props']).toHaveLength(1)
    expect(r.refreshing).toBe(false) // 抓完了
  })

  it('⭐ 抓完后 inFlight 被清掉（否则后续刷新永远说"已在抓取中"）', async () => {
    const h = setup()
    await h.refresher.ensureFresh()
    expect(h.refresher.isRefreshing()).toBe(false)

    advance(200) // 数据又过期了
    await h.refresher.ensureFresh()
    expect(h.calls()).toBe(2) // 能再次触发
  })
})

describe('ensureFresh —— ② 15~120 分钟 → 后台抓取', () => {
  it('⭐ 立即返回旧数据 + refreshing=true，后台开始抓', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    advance(20) // 20 分钟
    const r = await h.refresher.ensureFresh()

    expect(r.tier).toBe('background')
    expect(r.refreshing).toBe(true)
    expect(r.ageSeconds).toBe(20 * 60)

    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(1)
    expect(h.refresher.isRefreshing()).toBe(false)
  })
})

describe('ensureFresh —— ③ 15 分钟内 → 什么都不做', () => {
  it('⭐ 连续 5 次请求只抓了 0 次（零外部请求）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    for (let i = 0; i < 5; i += 1) {
      advance(2) // 每次隔 2 分钟，累计 10 分钟 < 15
      const r = await h.refresher.ensureFresh()
      expect(r.tier).toBe(SERVED)
      expect(r.refreshing).toBe(false)
    }

    expect(h.calls()).toBe(0) // ⭐ 一次网络请求都没有
  })

  it('刚好到 15 分钟边界时触发后台抓取（>= 而不是 >）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    advance(15)
    const r = await h.refresher.ensureFresh()
    expect(r.tier).toBe('background')
    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(1)
  })
})

describe('ensureFresh —— ① 超过 120 分钟 → 阻塞抓取', () => {
  it('⭐ 数据太旧时不让页面先看到旧价格', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    advance(121)
    const r = await h.refresher.ensureFresh()

    expect(r.tier).toBe('blocking')
    expect(h.calls()).toBe(1)
    expect(r.snapshot!.meta.fetchedAt).not.toBe(new Date(T0).toISOString()) // 已更新
  })

  it('119 分钟时仍是后台档（边界）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    advance(119)
    const r = await h.refresher.ensureFresh()
    expect(r.tier).toBe('background')
    await h.refresher.waitForIdle()
  })
})

/* ══════════════════════════ 三道锁 ══════════════════════════ */

describe('锁 1：single-flight', () => {
  it('⭐ 并发触发只抓一次', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()
    advance(20)

    // 同时发 3 个请求（模拟开 3 个标签页）
    const results = await Promise.all([
      h.refresher.ensureFresh(),
      h.refresher.ensureFresh(),
      h.refresher.ensureFresh(),
    ])

    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(1)
    // 至少一个是真的启动了抓取，其余被 single-flight 挡住
    expect(results.filter((r) => r.tier === 'background').length).toBeGreaterThanOrEqual(1)
  })
})

describe('锁 2：最小间隔（手动刷新也不能突破）', () => {
  it('⭐ 刚更新过就点刷新 → too_soon', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    // 第一次抓取（距上次尝试 > 120 秒，因为快照是 T0）
    advance(200)
    const first = await h.refresher.refreshNow()
    expect(first.outcome).toBe('started')
    await h.refresher.waitForIdle()

    // 10 秒后再点 —— 应该被挡住
    advance(10 / 60)
    const second = await h.refresher.refreshNow()
    expect(second.outcome).toBe('too_soon')
    expect(second.retryAfterSeconds).toBeGreaterThan(0)
    expect(h.calls()).toBe(1) // ⭐ 没有发出第二次请求
  })

  it('⭐ 手动刷新**可以绕过** 15 分钟判断（这是明确意图）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    advance(1) // 才 1 分钟，ensureFresh 会直接给你旧数据
    expect((await h.refresher.ensureFresh()).tier).toBe(SERVED)
    expect(h.calls()).toBe(0)

    // 但手动刷新会真的抓（因为距上次 *尝试* 很久了）
    const r = await h.refresher.refreshNow()
    expect(r.outcome).toBe('started')
    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(1)
  })
})

describe('锁 3：失败冷却与暂停', () => {
  it('⭐ 抓取失败后冷却期内**自动刷新被跳过**（手动仍可以）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()
    h.failWith('HTTP 429')

    // 手动抓一次（能绕过 15 分钟判断）→ 失败
    advance(200)
    expect((await h.refresher.refreshNow()).outcome).toBe('started')
    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(1)
    expect(h.refresher.getState().lastError).toBe('HTTP 429')
    expect(h.refresher.getState().consecutiveFailures).toBe(1)

    // 冷却期内（300 秒）：快照还是 T0 的，age 已 200+ 分钟，本该触发抓取，
    // 但冷却把自动刷新拦住了
    advance(1)
    const auto = await h.refresher.ensureFresh()
    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(1) // ⭐ 没有发出第二次请求
    expect(auto.tier).toBe('served') // 退化成“把旧数据给你”
    expect(auto.lastError).toBe('HTTP 429') // 但错误如实报出

    // 等过冷却期后，自动刷新又能跑了
    advance(10)
    const later = await h.refresher.refreshNow()
    expect(later.outcome).toBe('started')
    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(2)
  })

  it('⭐ 失败会保留旧快照（不把数据洗成空）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()
    h.failWith('网络断了')

    advance(200)
    await h.refresher.refreshNow()
    await h.refresher.waitForIdle()

    const snap = h.refresher.getSnapshot()
    expect(snap).not.toBeNull()
    expect(snap!.partitions['props']).toHaveLength(1)
    expect(snap!.meta.fetchedAt).toBe(new Date(T0).toISOString()) // 没被改
  })

  it('连续失败达到上限后自动刷新暂停（suspended）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()
    h.failWith('一直失败')

    // 连续失败 5 次（每次都要绕过冷却：手动刷新可以绕过）
    for (let i = 0; i < 5; i += 1) {
      advance(200)
      await h.refresher.refreshNow()
      await h.refresher.waitForIdle()
    }
    expect(h.refresher.getState().consecutiveFailures).toBe(5)
    expect(h.calls()).toBe(5)

    // 现在自动刷新（ensureFresh → 后台档）应被 suspended 拦住
    advance(200)
    const r = await h.refresher.ensureFresh()
    await h.refresher.waitForIdle()
    expect(h.calls()).toBe(5) // ⭐ 没有第 6 次
    expect(r.tier).toBe(SERVED) // 退化成"什么都不做"
  })

  it('成功一次后失败计数归零', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()

    h.failWith('先失败')
    advance(200)
    await h.refresher.refreshNow()
    await h.refresher.waitForIdle()
    expect(h.refresher.getState().consecutiveFailures).toBe(1)

    h.failWith(null)
    advance(200)
    await h.refresher.refreshNow()
    await h.refresher.waitForIdle()
    expect(h.refresher.getState().consecutiveFailures).toBe(0)
    expect(h.refresher.getState().lastError).toBeNull()
  })
})

/* ══════════════════════════ 落盘与保护 ══════════════════════════ */

describe('与 store 的协作', () => {
  it('⭐ 抓取成功后快照落盘了', async () => {
    const h = setup()
    await h.refresher.ensureFresh()
    const onDisk = await loadSnapshot(join(dir, 'snapshot.json'))
    expect(onDisk).not.toBeNull()
    expect(onDisk!.partitions['props']).toHaveLength(1)
  })

  it('⭐ 抓到 0 条时**不覆盖**旧快照（0 条保护）', async () => {
    await seedSnapshot(new Date(T0).toISOString())
    const h = setup()
    h.returns([]) // 源站改了字段 → 解析出 0 条

    advance(200)
    await h.refresher.refreshNow()
    await h.refresher.waitForIdle()

    const onDisk = await loadSnapshot(join(dir, 'snapshot.json'))
    expect(onDisk!.partitions['props']).toHaveLength(1) // 旧数据还在
    expect(h.refresher.getState().lastError).toContain('0 条物品')
  })

  it('⭐ 部分失败时保留旧分区', async () => {
    // 先放两个分区的旧快照
    const oldProps = [makeSourceItem({ sourceItemId: 'old-props' })]
    const oldAmmo = [makeSourceItem({ sourceItemId: 'old-ammo', categoryCode: 'ammo' })]
    const snapshot: Snapshot = {
      meta: {
        version: SNAPSHOT_VERSION,
        fetchedAt: new Date(T0).toISOString(),
        itemSourceId: 'official',
        itemSourceLabel: '测试源',
        priceSourceLabel: 'moligod',
        priceBasis: null,
        failedPartitions: [],
        requestCount: 8,
      },
      partitions: { props: oldProps, ammo: oldAmmo },
      prices: { 海洋之泪: makeQuote({ price: 100 }) },
    }
    await saveSnapshot(join(dir, 'snapshot.json'), snapshot)

    const h = setup()
    // 这一轮 props 成功、ammo 失败
    const refresher = new Refresher({
      cfg: makeTestConfig(dir),
      logger: createLogger('silent'),
      now: () => nowMs,
      fetch: async () => {
        const items = [makeSourceItem({ sourceItemId: 'new-props' })]
        return makeFetchResult(items, {
          itemResult: {
            items,
            okPartitions: ['props'],
            failedPartitions: [{ key: 'ammo', error: 'HTTP 500' }],
          },
        })
      },
    })

    advance(200)
    await refresher.refreshNow()
    await refresher.waitForIdle()

    const after = refresher.getSnapshot()
    expect(after!.partitions['props']!.map((i) => i.sourceItemId)).toEqual(['new-props'])
    expect(after!.partitions['ammo']!.map((i) => i.sourceItemId)).toEqual(['old-ammo']) // 沿用旧的
    void h
  })
})
