/**
 * server.ts 的单元测试 —— 五个路由。
 *
 * ⭐ 用 `fastify.inject()` 而不是真的监听端口：
 *    · 不占端口，测试之间不会互相打架
 *    · 不用等 TCP 握手，整个文件跑完是毫秒级
 *    · 不用手动关服务，天然无残留
 *
 * ⭐ 抓取函数是注入的假实现 —— **测试不发任何网络请求**。
 *    这在一个"尊重数据源"的项目里尤其重要：跑一次测试就打源站一轮，
 *    是不能接受的。
 *
 * ⭐ 时钟也是注入的，所以测"15 分钟边界""刷新最小间隔"不用真的等。
 */

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ApiErrorResponse, ApiItemsResponse, ApiMetaResponse, ApiSourcesResponse } from '@deltaforce/shared'
import type { AppConfig } from './config'
import { createLogger } from './logger'
import type { FetchEverythingResult } from './pipeline'
import type { PriceQuote } from './prices/types'
import { Refresher } from './refresher'
import { buildServer } from './server'
import type { SourceItem } from './sources/types'
import { makeQuote, makeSourceItem, makeTempDir, makeTestConfig } from './test-helpers'

/* ══════════════════════════ 测试脚手架 ══════════════════════════ */

let dir: string
let nowMs: number
/** 当前用例的刷新器，`afterEach` 用它等后台抓取收尾 */
let current: Refresher | null = null

const T0 = Date.parse('2026-09-28T06:00:00.000Z')

beforeEach(async () => {
  dir = await makeTempDir('df-server-')
  nowMs = T0
  current = null
})

afterEach(async () => {
  /**
   * ⚠️ 必须先等后台抓取停下来再删临时目录。
   *
   * 因为有几个用例刻意起了一轮“不 await 的后台抓取”。
   * 那些用例里紧接着跑 `rm` 会撞上 `ENOTEMPTY`（删目录时正在往里写），
   * 让一个本来通过的用例在收尾时报错 —— 而且只在慢机器上复现，很难查。
   */
  if (current) await current.waitForIdle()
  await rm(dir, { recursive: true, force: true })
})

const advance = (seconds: number): void => {
  nowMs += seconds * 1000
}

/** 默认的一轮假抓取结果：2 条物品，1 条有价 */
function defaultFetch(items?: SourceItem[]): () => Promise<FetchEverythingResult> {
  return async () => {
    const list = items ?? [
      makeSourceItem({ sourceItemId: '1', name: '海洋之泪' }),
      makeSourceItem({
        sourceItemId: '2',
        name: '反应堆总控核心',
        categoryCode: 'props',
        subcategory: 'key',
        subcategoryCn: '钥匙',
        grade: 6,
        width: 1,
        length: 1,
      }),
    ]
    const prices = new Map<string, PriceQuote>([['海洋之泪', makeQuote({ price: 34275453 })]])
    return {
      items: list,
      prices,
      itemResult: {
        items: list,
        okPartitions: [...new Set(list.map((i) => i.categoryCode))],
        failedPartitions: [],
      },
      priceSourceLabel: 'moligod',
      priceBasis: '测试口径：现价',
      priceFetchError: null,
      savedRaw: [],
      requestCount: 8,
    }
  }
}

async function setup(options: {
  fetch?: (cfg: AppConfig, logger: ReturnType<typeof createLogger>) => Promise<FetchEverythingResult>
  cfg?: Partial<AppConfig>
  /** 注入式每日密码 —— 不注入的话 /api/daily 会真的去打官方接口 ✗ */
  daily?: () => Promise<{ secrets: Array<{ mapId: number | null; mapName: string; secret: string }>; fetchedAt: string }>
} = {}): Promise<{ app: FastifyInstance; refresher: Refresher; cfg: AppConfig }> {
  const cfg = makeTestConfig(dir, options.cfg)
  const logger = createLogger('silent')
  const refresher = new Refresher({
    cfg,
    logger,
    now: () => nowMs,
    fetch: options.fetch ?? defaultFetch(),
  })
  await refresher.init()
  const app = await buildServer({
    cfg,
    logger,
    refresher,
    now: () => nowMs,
    // 默认给一个假实现 —— 保证测试永不打网络
    daily:
      options.daily ??
      (async () => ({
        secrets: [{ mapId: 1, mapName: '零号大坝', secret: '0178' }],
        fetchedAt: new Date(nowMs).toISOString(),
      })),
  })
  current = refresher
  return { app, refresher, cfg }
}

/** 让小任务跑完（等一个 microtask/macrotask 轮次） */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** 等到刷新器真的进入"正在抓取"状态 */
async function waitForRefreshing(refresher: Refresher): Promise<void> {
  for (let i = 0; i < 200 && !refresher.isRefreshing(); i += 1) await tick()
  expect(refresher.isRefreshing()).toBe(true)
}

/* ══════════════════════════ GET /api/items ══════════════════════════ */

describe('GET /api/items', () => {
  it('冷启动（无快照）→ 阻塞抓一次，然后正常返回', async () => {
    const { app } = await setup()

    const res = await app.inject({ method: 'GET', url: '/api/items' })

    expect(res.statusCode).toBe(200)
    const body = res.json<ApiItemsResponse>()
    expect(body.count).toBe(2)
    expect(body.items).toHaveLength(2)
    expect(body.itemSource).toBe('official')
    expect(body.priceSource).toBe('moligod')
    expect(body.snapshotStale).toBe(false)
    expect(body.refreshing).toBe(false)
    expect(body.lastFetchAt).not.toBeNull()
    // ageSeconds 是刚抓完，接近 0
    expect(body.ageSeconds).toBeLessThanOrEqual(1)
  })

  it('⭐ 冷启动时后台已在抓 → 请求**等它抓完**，而不是回 503', async () => {
    // 这个场景就是入口文件 index.ts 的启动流程：先 listen、再后台预热。
    // 如果 ensureFresh 碰到单飞锁就立即返回（旧行为），
    // 此时 snapshot 还是 null → 服务会回 503「没有数据快照」，
    // 网页显示成"抓取失败"，而实际上抓取正在正常进行。
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gatedFetch = async (): Promise<FetchEverythingResult> => {
      await gate
      return defaultFetch()()
    }

    const { app, refresher } = await setup({ fetch: gatedFetch })

    // 模拟入口的"不 await 的后台预热"
    void refresher.ensureFresh()
    await waitForRefreshing(refresher)

    // 现在发一个请求：它会撞上单飞锁，必须等，而不能立刻返回 503
    const pending = app.inject({ method: 'GET', url: '/api/items' })
    await tick()
    release()

    const res = await pending
    expect(res.statusCode).toBe(200)
    expect(res.json<ApiItemsResponse>().count).toBe(2)
  })

  it('有旧但可用的快照（15~120 分钟）→ 立即返回 + refreshing=true', async () => {
    const { app } = await setup()
    await app.inject({ method: 'GET', url: '/api/items' }) // 先抓一次

    // 推进 30 分钟：超过后台刷新线(15)，未到阻塞线(120)
    advance(30 * 60)
    // 让"最小间隔"不再拦（默认 120 秒）
    const res = await app.inject({ method: 'GET', url: '/api/items' })

    expect(res.statusCode).toBe(200)
    const body = res.json<ApiItemsResponse>()
    expect(body.refreshing).toBe(true) // 后台已经开始抓了
    expect(body.ageSeconds).toBeGreaterThan(1700)
    expect(body.snapshotStale).toBe(false) // 还没到 120 分钟
  })

  it('⭐ 快照超过 120 分钟 + 重抓失败 → 返回旧数据并标记 snapshotStale', async () => {
    /**
     * 注意这里为什么必须让抓取失败：
     *
     * `/api/items` 在 age ≥ 120 分钟时会**阻塞重抓一轮**。
     * 所以正常路径下它永远不会回一个 stale 响应 —— 它会先把数据变新。
     * `snapshotStale: true` 只出现在“想重抓但抓不到，只能拿旧数据顶上”时，
     * 而这恰好是最需要这个标记的时刻：告诉网页“我现在给你的是旧数据”。
     */
    let shouldFail = false
    const flakyFetch = async (): Promise<FetchEverythingResult> => {
      if (shouldFail) throw new Error('源站挂了')
      return defaultFetch()()
    }
    const { app } = await setup({ fetch: flakyFetch })
    await app.inject({ method: 'GET', url: '/api/items' })

    shouldFail = true
    advance(121 * 60)
    const res = await app.inject({ method: 'GET', url: '/api/items' })

    expect(res.statusCode).toBe(200) // 有旧数据就该给，不是 503
    const body = res.json<ApiItemsResponse>()
    expect(body.snapshotStale).toBe(true)
    expect(body.ageSeconds).toBeGreaterThan(7200)
  })

  it('⭐ 抓取失败且无旧快照 → 503 + no_snapshot', async () => {
    const failing = async (): Promise<FetchEverythingResult> => {
      throw new Error('网络挂了')
    }
    const { app } = await setup({ fetch: failing })

    const res = await app.inject({ method: 'GET', url: '/api/items' })

    expect(res.statusCode).toBe(503)
    const body = res.json<ApiErrorResponse>()
    expect(body.code).toBe('no_snapshot')
    expect(body.detail).toContain('网络挂了')
  })

  it('每个 Item 都带齐网页要用的派生字段', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/items' })
    const item = res.json<ApiItemsResponse>().items[0]!

    // 价格与派生指标
    expect(item.price).toBe(34275453)
    expect(item.pricePerSlot).toBe(34275453) // 1 格 × 1 单位
    expect(item.slots).toBe(1)
    expect(item.unitsPerSlot).toBe(1)
    // 标签（网页不自己算）
    expect(item.gradeCn).toBe('红')
    expect(item.availability).toBe('lootable')
    expect(item.listable).toBe(true)
  })
})

/* ══════════════════════════ GET /api/meta ══════════════════════════ */

describe('GET /api/meta', () => {
  it('没有快照 → 503', async () => {
    const { app } = await setup({ fetch: async () => { throw new Error('x') } })
    const res = await app.inject({ method: 'GET', url: '/api/meta' })
    expect(res.statusCode).toBe(503)
    expect(res.json<ApiErrorResponse>().code).toBe('no_snapshot')
  })

  it('⭐ 下发的标签调色板是完整的（网页不自己写一份）', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/meta' })
    const body = res.json<ApiMetaResponse>()

    // 品质：7 档，每档有中文名 + 色系 + 色值
    expect(Object.keys(body.labels.grade)).toHaveLength(7)
    expect(body.labels.grade['5']).toEqual({ label: '金', tone: 'gold', color: '#e8a64e' })
    expect(body.labels.grade['6']!.tone).toBe('red')

    // 可获得性 / 赛季限定 / 出产地来源
    expect(body.labels.availability['expired']).toBe('限时下架')
    expect(body.labels.availabilityDesc['expired']).toContain('返场')
    expect(body.labels.seasonal).toEqual({ current: '本季', past: '往季' })
    expect(body.labels.provenanceSource['manual']).toBe('人工补录')

    // 大类中文名（官方接口只给子类中文名，这份必须后端维护）
    expect(body.labels.category['props']).toBe('道具')
  })

  it('筛选器选项带数量，且按数量降序', async () => {
    const { app } = await setup()
    const body = (await app.inject({ method: 'GET', url: '/api/meta' })).json<ApiMetaResponse>()

    const props = body.categories.find((c) => c.value === 'props')
    expect(props?.count).toBe(2)
    expect(props?.label).toBe('道具')
    // 只有一个大类
    expect(body.categories).toHaveLength(1)
  })

  it('地图选项来自出产地，并按"会刷出的物品数"计数', async () => {
    const items = [
      makeSourceItem({ sourceItemId: '1', rawProvenance: '长弓溪谷,航天基地' }),
      makeSourceItem({ sourceItemId: '2', rawProvenance: '长弓溪谷' }),
    ]
    const { app } = await setup({ fetch: defaultFetch(items) })
    const body = (await app.inject({ method: 'GET', url: '/api/meta' })).json<ApiMetaResponse>()

    const byMap = Object.fromEntries(body.maps.map((m) => [m.value, m.count]))
    expect(byMap['长弓溪谷']).toBe(2)
    expect(byMap['航天基地']).toBe(1)
    expect(body.maps[0]!.value).toBe('长弓溪谷') // 数量最多排最前
  })

  it('价格口径原样下发（网页要显示它，避免误解价格含义）', async () => {
    const { app } = await setup()
    const body = (await app.inject({ method: 'GET', url: '/api/meta' })).json<ApiMetaResponse>()
    expect(body.priceBasis).toBe('测试口径：现价')
  })
})

/* ══════════════════════════ GET /api/sources ══════════════════════════ */

describe('GET /api/sources', () => {
  it('如实报告每个源的能力与启用状态', async () => {
    const { app } = await setup()
    await app.inject({ method: 'GET', url: '/api/items' })

    const body = (await app.inject({ method: 'GET', url: '/api/sources' })).json<ApiSourcesResponse>()

    expect(body.activeItemSource).toBe('official')
    expect(body.activePriceSource).toBe('moligod')

    const item = body.itemSources[0]!
    expect(item.kind).toBe('item')
    expect(item.active).toBe(true)
    // 官方有出产地、没价格 —— 这正是"必须两个源"的原因
    expect(item.capabilities.hasProvenance).toBe(true)
    expect(item.capabilities.hasPrice).toBe(false)

    const price = body.priceSources[0]!
    expect(price.kind).toBe('price')
    expect(price.capabilities.hasPrice).toBe(true)
    expect(price.capabilities.hasDurabilityVariants).toBe(true)
    expect(price.priceBasis).toBe('测试口径：现价')
  })

  it('匹配率偏低 → 产出告警（而不是安静地让网页显示错数据）', async () => {
    // 造 20 条物品，只有 1 条能在价格表里找到 → 匹配率 5%
    const items = Array.from({ length: 20 }, (_, i) =>
      makeSourceItem({ sourceItemId: String(i), name: `物品${i}` }),
    )
    const fetch = async (): Promise<FetchEverythingResult> => ({
      items,
      prices: new Map<string, PriceQuote>([['物品0', makeQuote({ price: 1 })]]),
      itemResult: { items, okPartitions: ['props'], failedPartitions: [] },
      priceSourceLabel: 'moligod',
      priceBasis: null,
      priceFetchError: null,
      savedRaw: [],
      requestCount: 1,
    })
    const { app } = await setup({ fetch })
    await app.inject({ method: 'GET', url: '/api/items' })

    const body = (await app.inject({ method: 'GET', url: '/api/sources' })).json<ApiSourcesResponse>()

    expect(body.matchRate).toBeLessThan(0.9)
    expect(body.warnings.some((w) => w.includes('名称匹配率只有'))).toBe(true)
  })

  it('没有快照时不崩，而是给出"还没法评估"的告警', async () => {
    const { app } = await setup({ fetch: async () => { throw new Error('x') } })
    const res = await app.inject({ method: 'GET', url: '/api/sources' })

    expect(res.statusCode).toBe(200)
    const body = res.json<ApiSourcesResponse>()
    expect(body.matchRate).toBeNull()
    expect(body.warnings).toHaveLength(1)
  })
})

/* ══════════════════════════ GET /api/health ══════════════════════════ */

describe('GET /api/health', () => {
  it('有快照且无错 → 200 + ok', async () => {
    const { app } = await setup()
    await app.inject({ method: 'GET', url: '/api/items' })

    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.itemCount).toBe(2)
    expect(body.lastError).toBeNull()
    expect(body.consecutiveFailures).toBe(0)
    expect(body.refreshing).toBe(false)
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
  })

  it('⭐ 没有快照 → 503（否则监控会以为服务正常，而网页什么都拿不到）', async () => {
    const { app } = await setup({ fetch: async () => { throw new Error('源站 500') } })
    // 先触发一次失败
    await app.inject({ method: 'GET', url: '/api/items' })

    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(503)

    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.lastError).toContain('源站 500')
    expect(body.consecutiveFailures).toBe(1)
  })

  it('⭐ refreshEligibleAt：刚抓过时给出"何时才能再抓"', async () => {
    const { app } = await setup()
    await app.inject({ method: 'GET', url: '/api/items' })

    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()

    expect(body.refreshEligibleAt).not.toBeNull()
    // 默认最小间隔 120 秒
    const readyAt = Date.parse(body.refreshEligibleAt)
    expect(readyAt - nowMs).toBeCloseTo(120_000, -3)
  })

  it('已过最小间隔 → refreshEligibleAt 为 null（"随时可以"）', async () => {
    const { app } = await setup()
    await app.inject({ method: 'GET', url: '/api/items' })

    advance(200)
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()
    expect(body.refreshEligibleAt).toBeNull()
  })

  it('快照过期 → snapshotStale=true（但 ok 仍为 true，服务本身是活的）', async () => {
    const { app } = await setup()
    await app.inject({ method: 'GET', url: '/api/items' })

    advance(121 * 60)
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()
    expect(body.snapshotStale).toBe(true)
    expect(body.ok).toBe(true)
  })
})

/* ══════════════════════════ POST /api/refresh ══════════════════════════ */

describe('POST /api/refresh', () => {
  it('首次调用 → 200 started', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/refresh' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ started: true, message: '已开始后台抓取' })
  })

  it('⭐ 距上次不足最小间隔 → 429 + refresh_too_soon + Retry-After', async () => {
    const { app, refresher } = await setup()

    // ⚠️ 手动刷新是**非阻塞**的（立即返回 "已开始"）——
    //    所以必须等它抓完，否则下一次请求撞上的是单飞锁（409）
    await app.inject({ method: 'POST', url: '/api/refresh' })
    await refresher.waitForIdle()

    advance(30) // 才过 30 秒，最小间隔是 120
    const res = await app.inject({ method: 'POST', url: '/api/refresh' })

    expect(res.statusCode).toBe(429)
    const body = res.json<ApiErrorResponse>()
    expect(body.code).toBe('refresh_too_soon')
    expect(body.retryAfterSeconds).toBe(90)

    // 标准 HTTP 头，curl / 前端都能直接用
    expect(res.headers['retry-after']).toBe('90')
  })

  it('⭐ 已有抓取在进行中 → 409 + refresh_in_progress（不是错误，是单飞锁）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gatedFetch = async (): Promise<FetchEverythingResult> => {
      await gate
      return defaultFetch()()
    }
    const { app, refresher } = await setup({ fetch: gatedFetch })

    // 起一轮抓取并让它挂在半路
    void refresher.ensureFresh()
    await waitForRefreshing(refresher)

    const res = await app.inject({ method: 'POST', url: '/api/refresh' })
    expect(res.statusCode).toBe(409)
    expect(res.json<ApiErrorResponse>().code).toBe('refresh_in_progress')

    release()
    await refresher.waitForIdle()
  })

  it('⭐ 连续失败达到上限 → 自动刷新停了，但手动刷新仍可用（逃生口）', async () => {
    let calls = 0
    const { app, refresher } = await setup({
      fetch: async () => {
        calls += 1
        throw new Error('源站一直 500')
      },
    })

    // 手动刷新绕过失败冷却，把连续失败顶到上限（默认 5）
    for (let i = 0; i < 5; i += 1) {
      advance(10 * 60)
      const res = await app.inject({ method: 'POST', url: '/api/refresh' })
      expect(res.statusCode).toBe(200) // 手动刷新总是被接受
      await refresher.waitForIdle()
    }
    expect(refresher.getState().consecutiveFailures).toBe(5)

    // ① 自动刷新（ensureFresh 走的非 manual 路径）已被暂停：
    //    **一次 HTTP 都不会发**，这是这件事最要紧的地方
    const callsBefore = calls
    advance(10 * 60)
    const auto = await refresher.ensureFresh()
    expect(auto.snapshot).toBeNull()
    expect(calls).toBe(callsBefore) // 没打源站

    // ② 手动刷新仍会真的去抓 —— 这是刻意留的逃生口
    advance(10 * 60)
    const manual = await app.inject({ method: 'POST', url: '/api/refresh' })
    expect(manual.statusCode).toBe(200)
    await refresher.waitForIdle()
    expect(calls).toBe(callsBefore + 1)
  })

  it('⭐ 暂停状态必须在 /api/sources 的 warnings 里说出来', async () => {
    /**
     * 因为**没有别的途径能看到它**：手动刷新绕过暂停，所以它会一直 200，
     * 看起来一切正常 —— 而实际上后台自动刷新已经停了，
     * 数据只会停在原地直到有人手动点。
     */
    const { app, refresher } = await setup({
      fetch: async () => {
        throw new Error('源站一直 500')
      },
    })

    for (let i = 0; i < 5; i += 1) {
      advance(10 * 60)
      await app.inject({ method: 'POST', url: '/api/refresh' })
      await refresher.waitForIdle()
    }

    const body = (await app.inject({ method: 'GET', url: '/api/sources' })).json<ApiSourcesResponse>()
    expect(body.warnings.some((w) => w.includes('自动刷新已暂停'))).toBe(true)
  })
})

/* ══════════════════════════ 兜底 ══════════════════════════ */

describe('兜底路由', () => {
  it('未知路由 → 404 + 列出可用路由（而不是一个空响应）', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/nope' })

    expect(res.statusCode).toBe(404)
    const body = res.json<ApiErrorResponse>()
    expect(body.error).toContain('/api/nope')
    expect(body.detail).toContain('/api/items')
  })
})


/* ══════════════════════ GET /api/daily（每日密码） ══════════════════════ */

describe('GET /api/daily', () => {
  it('返回密码列表与取数时刻', async () => {
    const { app } = await setup({
      daily: async () => ({
        secrets: [
          { mapId: 1, mapName: '零号大坝', secret: '1690' },
          { mapId: 2, mapName: '长弓溪谷', secret: '0178' },
        ],
        fetchedAt: '2026-09-29T00:00:00.000Z',
      }),
    })

    const res = await app.inject({ method: 'GET', url: '/api/daily' })
    expect(res.statusCode).toBe(200)

    const body = res.json<{ secrets: unknown[]; fetchedAt: string }>()
    expect(body.secrets).toHaveLength(2)
    expect(body.fetchedAt).toBe('2026-09-29T00:00:00.000Z')
    // ⚠️ 前导零必须原样传下去
    expect(JSON.stringify(body.secrets)).toContain('0178')
  })

  it('⭐ 取不到时回 503（而不是一个空列表 —— 那会让人以为今天没密码）', async () => {
    const { app } = await setup({
      daily: async () => {
        throw new Error('官方接口返回 HTTP 500')
      },
    })

    const res = await app.inject({ method: 'GET', url: '/api/daily' })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('source_error')
    expect(res.json().error).toContain('HTTP 500')
  })

  it('⭐ 取密码**不会**触发物品/价格的抓取（两套数据无关）', async () => {
    let fetchCalls = 0
    const { app } = await setup({
      fetch: async () => {
        fetchCalls += 1
        return defaultFetch()()
      },
    })

    await app.inject({ method: 'GET', url: '/api/daily' })
    expect(fetchCalls).toBe(0)
  })
})
