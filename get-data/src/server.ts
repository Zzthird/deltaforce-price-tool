/**
 * Fastify HTTP 服务 —— 五个路由。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个文件的定位
 * ═══════════════════════════════════════════════════════════════════════
 * 它是**数据与网页之间的唯一界面**。网页不知道数据从哪个源来、怎么抓的、
 * 存在哪 —— 它只认这个文件吐出的 JSON（形状定义在 `shared/src/index.ts`）。
 *
 * 所以这里的每一个字段都在回答两个问题之一：
 *   · 网页要展示什么？（items / meta）
 *   · 网页要怎么解释数据的"新鲜度与可信度"？（lastFetchAt / ageSeconds /
 *     snapshotStale / refreshing / sources / warnings）
 *
 * 后一半容易被忽略，但对本项目是**核心** —— 因为价格是第三方现价、
 * 5 分钟就变，不把"这是几分钟前的数据"和"价格口径是什么"一起给网页，
 * 用户就会拿一个不知道哪来的数字做决策。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 刻意没有的东西：定时器
 * ═══════════════════════════════════════════════════════════════════════
 * 没有任何 `setInterval` / cron。刷新**只由请求触发**（见 PLAN.md §6.7）。
 * `GET /api/items` 会顺带调 `ensureFresh()`：
 *
 *   age < 15 分钟             → 什么都不做，直接返回
 *   15 ≤ age < 120 分钟       → 立即返回旧数据 + refreshing=true，后台开始抓
 *   age ≥ 120 分钟 或 无快照   → 阻塞等到抓完再返回
 *
 * 为什么这么设计：没人用网站时就不该抓。源站（个人站点 + 官方接口）
 * 不该为"你睡觉时的 8 小时"付出 96 次请求。
 *
 * ⚠️ 没有缓存：每次请求都真的重建一遍 Item。
 *    因为 `buildFromSnapshot` 会**重新读人工标注文件** —— 缓存会让
 *    "改完标注、刷新网页"看不到变化，而那是最常用的操作。
 *    实测重建 1,564 条约 30ms，单用户本地工具，不值得为它冒这个风险。
 */

import Fastify, { type FastifyInstance } from 'fastify'
import type {
  ApiErrorCode,
  ApiErrorResponse,
  ApiHealthResponse,
  ApiItemsResponse,
  ApiMetaResponse,
  ApiRefreshResponse,
  ApiSourcesResponse,
  GradeStyle,
  Item,
  LabelPalette,
  MetaOption,
  SourceStatus,
} from '@deltaforce/shared'
import type { AppConfig } from './config'
import {
  AVAILABILITY_CN,
  AVAILABILITY_DESC,
  CATEGORY_CN,
  GRADE_CN,
  GRADE_COLOR,
  GRADE_TONE,
  MIN_ACCEPTABLE_MATCH_RATE,
  PROVENANCE_SOURCE_CN,
  SEASONAL_CN,
} from './constants'
import type { Logger } from './logger'
import { buildFromSnapshot, type BuiltResult } from './pipeline'
import { listPriceSources } from './prices/registry'
import type { Refresher } from './refresher'
import { listItemSources } from './sources/registry'
import type { Snapshot } from './store'

export interface ServerDeps {
  cfg: AppConfig
  logger: Logger
  refresher: Refresher
  /** 注入式时钟（毫秒时间戳）。测试用假时钟，不依赖真实时间。 */
  now?: () => number
}

/* ══════════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════════ */

function errorBody(
  code: ApiErrorCode,
  error: string,
  extra: Omit<ApiErrorResponse, 'code' | 'error'> = {},
): ApiErrorResponse {
  return { code, error, ...extra }
}

/** 按某个键聚合物品数量，产出筛选器的下拉选项 */
function countOptions(
  items: readonly Item[],
  key: (it: Item) => string | null,
  label: (it: Item) => string | null,
): MetaOption[] {
  const acc = new Map<string, MetaOption>()
  for (const it of items) {
    const value = key(it)
    if (value === null || value === '') continue
    const existing = acc.get(value)
    if (existing) {
      existing.count += 1
    } else {
      acc.set(value, { value, label: label(it) ?? value, count: 1 })
    }
  }
  return [...acc.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/* ══════════════════════════════════════════════════════════════════════
 * 服务工厂
 * ══════════════════════════════════════════════════════════════════════ */

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { cfg, logger, refresher } = deps
  const now = deps.now ?? Date.now
  const startedAtMs = now()

  const app = Fastify({
    // Fastify 自带 pino。本项目的 logger 已经有统一格式（带 [模块] 前缀），
    // 再接一套只会让日志变成两种风格。所以关掉它，自己记。
    //
    // 注意：`logger: false` 已经意味着**连请求日志也不打**，
    // 所以这里不需要（也没法用）`disableRequestLogging` ——
    // 那个选项在 Fastify 5.2 已弃用，写了会打弃用警告。
    logger: false,
  })

  /**
   * 快照是否"陈旧"。
   *
   * ⚠️ 与 `Item.stale` 不是一回事：
   *   · `Item.stale`      = 该物品在源侧的最后更新时间超过 24 小时
   *   · `snapshotStale`   = **整份数据**已经老到不该当作"当前状态"了
   *
   * 阈值取"阻塞刷新线"（默认 120 分钟）而不是"后台刷新线"（15 分钟）：
   * 15 分钟只是个"该去后台抓一下了"的提示，那时候页面顶部的
   * "3 分钟前更新"已经说清楚了。要是 15 分钟就标 stale，
   * 这个标记会几乎永远亮着，等于没标。
   */
  const staleAfterSeconds = cfg.blockingRefreshAfterMinutes * 60
  function isSnapshotStale(ageSeconds: number | null): boolean {
    return ageSeconds === null || ageSeconds > staleAfterSeconds
  }

  /** 快照里的原始物品条目数（排除发生在抓取时，所以它就等于最终条目数） */
  function snapshotItemCount(snapshot: Snapshot | null): number {
    if (!snapshot) return 0
    return Object.values(snapshot.partitions).reduce((sum, list) => sum + list.length, 0)
  }

  /**
   * 一轮抓取的状态 → `SourceStatus` 的公共部分。
   *
   * 为什么要摊平：`RefreshState` 记的是**一轮**的成功/失败，
   * 而这一轮里物品主数据源和价格源是一起抓的。所以两个源共享
   * `lastOkAt` / `lastAttemptAt` / `consecutiveFailures` 是对的 ——
   * 如实反映"这一轮整体成功了吗"，不编造每个源各自的数字。
   */
  function roundStatus(): {
    lastOkAt: string | null
    lastAttemptAt: string | null
    lastDurationMs: number | null
    lastError: string | null
    consecutiveFailures: number
  } {
    const s = refresher.getState()
    return {
      lastOkAt: s.lastOkAt,
      lastAttemptAt: s.lastAttemptAt,
      lastDurationMs: s.lastDurationMs,
      lastError: s.lastError,
      consecutiveFailures: s.consecutiveFailures,
    }
  }

  /** 把两个注册表里的源都描述成 SourceStatus（`/api/sources` 与 `/api/meta` 共用） */
  function describeSources(snapshot: Snapshot | null): SourceStatus[] {
    const round = roundStatus()
    const itemCount = snapshotItemCount(snapshot)
    const priceCount = snapshot ? Object.keys(snapshot.prices).length : null

    const itemSources: SourceStatus[] = listItemSources().map((src) => ({
      kind: 'item',
      id: src.id,
      label: src.label,
      homepage: src.homepage,
      capabilities: src.capabilities,
      enabled: true,
      active: src.id === cfg.itemSource,
      ...round,
      itemCount: src.id === cfg.itemSource ? itemCount : null,
    }))

    const priceSources: SourceStatus[] = listPriceSources().map((src) => ({
      kind: 'price',
      id: src.id,
      label: src.label,
      homepage: src.homepage,
      capabilities: src.capabilities,
      // "已实现" ≠ "正在用"。dergame 将来实现了会出现在这里，但只有
      // cfg.priceSource 指向它时才是 active —— 网页据此让用户看到
      // "这个源可用，但你现在用的是另一个"。
      enabled: true,
      active: src.id === cfg.priceSource,
      ...round,
      itemCount: src.id === cfg.priceSource ? priceCount : null,
      /**
       * 价格口径优先用**快照里记的那个**。
       *
       * 因为这个问题回答的是"你正在看的这份数据是什么口径"，
       * 而不是"这个适配器现在声明什么"。两者通常在配置一改就分叉了
       * —— 旧快照还是旧口径，如实说出来才不误导。
       */
      priceBasis: snapshot?.meta.priceBasis ?? src.priceBasis,
    }))

    return [...itemSources, ...priceSources]
  }

  /**
   * 标签与调色板 —— **运行时常量**，`shared` 包放不下（那里只能是类型）。
   *
   * 后端是唯一定义处，网页拿到就能直接渲染品质色块与中文徽章，
   * 不需要（也不允许）自己再写一份。
   */
  const labels: LabelPalette = {
    grade: Object.fromEntries(
      Object.entries(GRADE_CN).map(([value, label]) => [
        value,
        {
          label,
          tone: GRADE_TONE[Number(value) as keyof typeof GRADE_TONE],
          color: GRADE_COLOR[Number(value) as keyof typeof GRADE_COLOR],
        } satisfies GradeStyle,
      ]),
    ),
    category: { ...CATEGORY_CN },
    availability: { ...AVAILABILITY_CN },
    availabilityDesc: { ...AVAILABILITY_DESC },
    seasonal: { ...SEASONAL_CN },
    provenanceSource: { ...PROVENANCE_SOURCE_CN },
  }

  /** 重建 Item 列表；没有快照时返回 null（调用方决定怎么回） */
  async function builtOrNull(): Promise<{ built: BuiltResult; snapshot: Snapshot } | null> {
    const snapshot = refresher.getSnapshot()
    if (!snapshot) return null
    const built = await buildFromSnapshot(cfg, logger, snapshot)
    return { built, snapshot }
  }

  /**
   * 把 warnings 与两类“必须让用户看到”的状态合并成告警。
   *
   * ⚠️ 暂停检查**不能放在 `if (built)` 里面** ——
   *    连续失败到暂停，通常同时就意味着“没有可用快照”，
   *    而那正是最需要说出这件事的时候。（写测试时拓到的真问题）
   */
  function collectWarnings(built: BuiltResult | null): string[] {
    const out: string[] = []

    if (!built) {
      out.push('还没有数据快照，抓取一次后才能评估数据源匹配情况。')
    } else {
      out.push(...built.warnings)
      const rate = built.joinStats.nameMatchRate
      if (rate < MIN_ACCEPTABLE_MATCH_RATE) {
        out.push(
          `价格源与主数据的名称匹配率只有 ${(rate * 100).toFixed(1)}%` +
            `（低于 ${(MIN_ACCEPTABLE_MATCH_RATE * 100).toFixed(0)}%）——` +
            `可能是价格源改了物品命名，请检查 prices/ 下的适配器。`,
        )
      }
    }

    /**
     * ⭐ 自动刷新被暂停了也要说。
     *
     * 因为**没有任何其他途径能让人知道这件事**：`POST /api/refresh`（手动）
     * 刻意绕过暂停（那是留给人的逃生口），所以手动刷新会一直 200，
     * 看起来一切正常 —— 而实际上后台自动刷新已经停了，
     * 数据只会停在原地，直到有人手动点。
     *
     * （这也是为什么 `POST /api/refresh` 里那个 `suspended` 分支
     *   实际上到不了 —— 留着只是为了穷尽检查。）
     */
    const failures = refresher.getState().consecutiveFailures
    if (failures >= cfg.maxConsecutiveFailures) {
      out.push(
        `已连续失败 ${failures} 次，**自动刷新已暂停**（手动刷新仍可用）。` +
          `请检查源站与网络，然后重启服务或手动刷新一次。`,
      )
    }
    return out
  }

  /* ══════════════════════════════════════════════════════════════════
   * GET /api/items —— 主接口。顺带触发按需刷新。
   * ══════════════════════════════════════════════════════════════════ */

  app.get('/api/items', async (_req, reply) => {
    const fresh = await refresher.ensureFresh()

    if (!fresh.snapshot) {
      return reply.code(503).send(
        errorBody(
          'no_snapshot',
          '还没有任何数据快照，且首次抓取没有成功 —— 请检查网络与源站状态。',
          fresh.lastError ? { detail: fresh.lastError } : {},
        ),
      )
    }

    const built = await buildFromSnapshot(cfg, logger, fresh.snapshot)

    const body: ApiItemsResponse = {
      items: built.items,
      count: built.items.length,
      itemSource: cfg.itemSource,
      priceSource: cfg.priceSource,
      lastFetchAt: fresh.snapshot.meta.fetchedAt,
      ageSeconds: fresh.ageSeconds,
      snapshotStale: isSnapshotStale(fresh.ageSeconds),
      refreshing: refresher.isRefreshing(),
    }
    return reply.send(body)
  })

  /* ══════════════════════════════════════════════════════════════════
   * GET /api/meta —— 筛选器选项 + 源状态
   * ══════════════════════════════════════════════════════════════════ */

  app.get('/api/meta', async (_req, reply) => {
    /**
     * ⚠️ 这里也调 `ensureFresh()`，契约里只写了 `/api/items` 会触发。
     *
     * 原因：前端首屏会同时要 items 和 meta，**谁先到是不确定的**。
     * 如果 meta 不触发刷新，冷启动时它可能先到 → 没有快照 → 503 →
     * 筛选器空白，而几秒后 items 就有数据了。
     * 与其要求调用方保证调用顺序，不如让这两个读接口都能当“第一个”。
     *
     * （`/api/health` 刻意**不**触发 —— 监控会频繁打它，不该每次都可能引发抓取）
     */
    await refresher.ensureFresh()

    const ctx = await builtOrNull()
    if (!ctx) {
      return reply
        .code(503)
        .send(errorBody('no_snapshot', '还没有数据快照 —— 先请求一次 /api/items 触发抓取。'))
    }
    const { built, snapshot } = ctx

    // 地图选项：按"有多少条物品会在这张图刷出"计数
    const mapCounts = new Map<string, number>()
    for (const it of built.items) {
      for (const map of it.provenanceMaps ?? []) {
        mapCounts.set(map, (mapCounts.get(map) ?? 0) + 1)
      }
    }
    const maps: MetaOption[] = [...mapCounts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))

    const body: ApiMetaResponse = {
      categories: countOptions(
        built.items,
        (it) => it.categoryCode,
        (it) => it.categoryCn || CATEGORY_CN[it.categoryCode] || it.categoryCode,
      ),
      subcategories: countOptions(
        built.items,
        (it) => it.subcategory,
        (it) => it.subcategoryCn ?? it.subcategory,
      ),
      thirdClasses: countOptions(
        built.items,
        (it) => it.thirdClass,
        (it) => it.thirdClassCn ?? it.thirdClass,
      ),
      grades: countOptions(
        built.items,
        (it) => String(it.grade),
        (it) => GRADE_CN[it.grade] ?? String(it.grade),
      ),
      maps,
      sources: describeSources(snapshot),
      priceBasis: snapshot.meta.priceBasis,
      matchRate: built.joinStats.nameMatchRate,
      labels,
    }
    return reply.send(body)
  })

  /* ══════════════════════════════════════════════════════════════════
   * GET /api/sources —— 各源健康状态（与 /api/meta 里那份同源）
   * ══════════════════════════════════════════════════════════════════ */

  app.get('/api/sources', async (_req, reply) => {
    // 同上：让 /api/sources 也能当“第一个”被调用
    await refresher.ensureFresh()

    const ctx = await builtOrNull()
    const all = describeSources(ctx?.snapshot ?? null)

    const body: ApiSourcesResponse = {
      itemSources: all.filter((s) => s.kind === 'item'),
      priceSources: all.filter((s) => s.kind === 'price'),
      activeItemSource: cfg.itemSource,
      activePriceSource: cfg.priceSource,
      matchRate: ctx?.built.joinStats.nameMatchRate ?? null,
      warnings: collectWarnings(ctx?.built ?? null),
    }
    return reply.send(body)
  })

  /* ══════════════════════════════════════════════════════════════════
   * GET /api/health —— 存活与新鲜度
   * ══════════════════════════════════════════════════════════════════ */

  app.get('/api/health', async (_req, reply) => {
    const state = refresher.getState()
    const snapshot = refresher.getSnapshot()
    const ageSeconds = refresher.ageSeconds()
    const minGapMs = cfg.minRefreshGapSeconds * 1000

    // 还要等多久才能再抓。已经过了间隔就是 null（"随时可以"）。
    let refreshEligibleAt: string | null = null
    if (state.lastAttemptAt) {
      const readyAtMs = Date.parse(state.lastAttemptAt) + minGapMs
      if (Number.isFinite(readyAtMs) && readyAtMs > now()) {
        refreshEligibleAt = new Date(readyAtMs).toISOString()
      }
    }

    const body: ApiHealthResponse = {
      // ok = "服务还能正常供数"。没有快照或最后一次抓取失败都算不健康 ——
      // 因为那意味着网页拿不到可用的数据，这时候 200 会误导监控。
      ok: snapshot !== null && state.lastError === null,
      uptimeSeconds: Math.floor((now() - startedAtMs) / 1000),
      lastFetchAt: snapshot?.meta.fetchedAt ?? state.lastOkAt,
      lastFetchOk: state.lastError === null && (state.lastOkAt !== null || snapshot !== null),
      lastError: state.lastError,
      snapshotStale: isSnapshotStale(ageSeconds),
      itemCount: snapshotItemCount(snapshot),
      ageSeconds,
      refreshing: refresher.isRefreshing(),
      refreshEligibleAt,
      consecutiveFailures: state.consecutiveFailures,
    }
    return reply.code(body.ok ? 200 : 503).send(body)
  })

  /* ══════════════════════════════════════════════════════════════════
   * POST /api/refresh —— 手动刷新（绕过失败冷却，绕不过最小间隔与单飞）
   * ══════════════════════════════════════════════════════════════════ */

  app.post('/api/refresh', async (_req, reply) => {
    const result = await refresher.refreshNow()

    switch (result.outcome) {
      case 'started': {
        const body: ApiRefreshResponse = { started: true, message: result.message }
        return reply.send(body)
      }
      case 'in_progress':
        // 409 Conflict：请求本身没问题，是**当前状态**不允许。
        // 多个标签页同时按刷新时走到这里 —— 这是单飞锁在起作用，不是错误。
        return reply
          .code(409)
          .send(errorBody('refresh_in_progress', '已经有一次抓取在进行中，等它完成即可。'))

      case 'cooldown':
      case 'too_soon':
        // 两者都用 429（限流）+ Retry-After：告诉客户端"多久之后再来"。
        // 冷却期是"上次失败了，先别再打源站"；最小间隔是"刚抓过"。
        // 对前端来说处理方式一样，所以合并成一个错误码。
        if (result.retryAfterSeconds !== undefined) {
          void reply.header('Retry-After', String(Math.ceil(result.retryAfterSeconds)))
        }
        return reply.code(429).send(
          errorBody('refresh_too_soon', result.message, {
            ...(result.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: result.retryAfterSeconds }
              : {}),
          }),
        )

      case 'suspended':
        /**
         * ⚠️ 这个分支**实际到不了** —— `refreshNow()` 走的是 `source: 'manual'`，
         *    而暂停锁刻意只拦自动刷新（手动是留给人的逃生口）。
         *    留着它是为了 switch 的穷尽检查；目的是提醒后来人：
         *    “暂停”这件事要在 `/api/sources` 的 warnings 里说，
         *    因为那里是唯一能看到它的地方。
         */
        return reply.code(503).send(
          errorBody(
            'source_error',
            `${result.message} —— 连续失败 ${refresher.getState().consecutiveFailures} 次，` +
              `请检查源站与网络后重启服务。`,
          ),
        )
    }
  })

  /* ══════════════════════════════════════════════════════════════════
   * 兜底错误处理
   * ══════════════════════════════════════════════════════════════════ */

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send(
        errorBody(
          'internal_error',
          `没有这个路由：${req.method} ${req.url}`,
          { detail: '可用：GET /api/items · /api/meta · /api/sources · /api/health · POST /api/refresh' },
        ),
      )
  })

  app.setErrorHandler((err, _req, reply) => {
    logger.error('HTTP 处理出错', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    void reply
      .code(500)
      .send(
        errorBody(
          'internal_error',
          '服务内部错误',
          err instanceof Error ? { detail: err.message } : {},
        ),
      )
  })

  return app
}
