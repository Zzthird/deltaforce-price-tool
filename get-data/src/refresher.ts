/**
 * refresher —— 按需刷新。**没有定时器。**
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么不用 7×24 定时器
 * ═══════════════════════════════════════════════════════════════════════
 * 只在**有人用网站**的时候才校验并抓取，让访问频率真正等于使用频率：
 * 每天玩 3 小时 → 月请求从 2880 次降到约 360 次；没人用 → 0 次。
 *
 * 而且判定完全是**本地计算**（读快照的 fetchedAt），零网络开销 ——
 * 只有确认过期才去碰原站。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三档状态机
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   age = now - 上次成功抓取的时刻
 *
 *   ① 无快照，或 age ≥ BLOCKING_REFRESH_AFTER_MINUTES（默认 120）
 *      → **同步等待**一次抓取，返回新数据
 *      （页面显示"正在获取最新价格…"而不是先把一周前的价格摆出来）
 *
 *   ② REFRESH_AFTER_MINUTES ≤ age < 120（默认 15）
 *      → **立即返回旧数据** + refreshing=true，后台开始抓
 *
 *   ③ age < 15 分钟
 *      → 什么都不做（静默）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三道防抖锁
 * ═══════════════════════════════════════════════════════════════════════
 *   · single-flight  —— 已经有抓取在跑 → 不再启动第二个
 *     （开 5 个标签页同时触发也只抓一次）
 *   · MIN_REFRESH_GAP_SECONDS —— 距上次尝试不足 → 拒绝
 *     （防狂点刷新 / 脚本刷接口；**手动刷新也不能突破**）
 *   · FAILURE_COOLDOWN_SECONDS —— 上次失败后的冷却期 → 自动刷新跳过
 *     （源站挂了之后不被反复打；手动刷新可绕过）
 */

import { join } from 'node:path'
import type { AppConfig } from './config'
import type { Logger } from './logger'
import { fetchEverything, type FetchEverythingResult } from './pipeline'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'
import {
  appendHistory,
  EMPTY_REFRESH_STATE,
  loadRefreshState,
  loadSnapshot,
  mergeIntoSnapshot,
  pruneHistory,
  saveRefreshState,
  saveSnapshot,
  type RefreshState,
  type Snapshot,
} from './store'

/** 本次请求落在状态机的哪一档 */
export type RefreshTier =
  /**
   * 直接把本地数据给了调用方，**没有做任何抓取动作**。
   * ⚠️ 注意：它**不代表数据新鲜** —— 数据是否陈旧看 `ageSeconds`。
   * （名字用 served 而不是 fresh，就是为了避免这个误读）
   */
  | 'served'
  /** 已返回旧数据，后台正在抓 */
  | 'background'
  /** 阻塞等待了一次抓取 */
  | 'blocking'

export interface RefresherDeps {
  cfg: AppConfig
  logger: Logger
  /**
   * 注入式时钟（毫秒时间戳）。
   * ⭐ 测试用假时钟 —— 这样测“15 分钟边界”“冷却期”不用真的等。
   */
  now?: () => number
  /**
   * 注入式抓取函数。默认是真实的 `fetchEverything`。
   * ⭐ 测试注入假日实现，这样单测**不会发网络请求**（快、不依赖外网、不打扰源站）。
   */
  fetch?: (cfg: AppConfig, logger: Logger) => Promise<FetchEverythingResult>
}

export interface EnsureFreshResult {
  snapshot: Snapshot | null
  tier: RefreshTier
  /** 是否正在抓取（后台已启动，或刚才阻塞抓取时在看它跑） */
  refreshing: boolean
  /** 快照已用了多少秒；无快照时 null */
  ageSeconds: number | null
  /** 最近一次失败原因；成功则为 null */
  lastError: string | null
  /** 这一轮里沿用旧数据的分区（部分失败时非空） */
  keptPartitions: string[]
  /** 这一轮价格表是否沿用了旧数据 */
  keptPrices: boolean
}

export type RefreshOutcome =
  /** 已启动（或已同步完成一次抓取） */
  | 'started'
  /** 已有抓取在进行中 */
  | 'in_progress'
  /** 距上次尝试不足最小间隔 */
  | 'too_soon'
  /** 上次失败后的冷却期内（仅自动刷新会命中） */
  | 'cooldown'
  /** 连续失败太多次，自动刷新已停止 */
  | 'suspended'

export interface RefreshResult {
  outcome: RefreshOutcome
  started: boolean
  message: string
  /** 被拒绝时告诉调用方还要等多少秒 */
  retryAfterSeconds?: number
}

export class Refresher {
  private readonly cfg: AppConfig
  private readonly logger: Logger
  private readonly now: () => number
  private readonly doFetch: (cfg: AppConfig, logger: Logger) => Promise<FetchEverythingResult>

  private readonly snapshotPath: string
  private readonly statePath: string
  private readonly historyDir: string

  private snapshot: Snapshot | null = null
  private state: RefreshState = { ...EMPTY_REFRESH_STATE }

  /** single-flight 锁：不为 null 表示有抓取在跑 */
  private inFlight: Promise<void> | null = null

  private initialized = false
  private keptPartitions: string[] = []
  private keptPrices = false

  constructor(deps: RefresherDeps) {
    this.cfg = deps.cfg
    this.logger = deps.logger.child({ module: 'refresher' })
    this.now = deps.now ?? (() => Date.now())
    this.doFetch = deps.fetch ?? fetchEverything
    this.snapshotPath = join(deps.cfg.dataDir, 'snapshot.json')
    this.statePath = join(deps.cfg.dataDir, 'refresh-state.json')
    this.historyDir = join(deps.cfg.dataDir, 'history')
  }

  /* ------------------------------------------------------------------ */

  /** 首次调用时读快照与状态。幂等。 */
  async init(): Promise<void> {
    if (this.initialized) return
    this.snapshot = await loadSnapshot(this.snapshotPath, { logger: this.logger })
    this.state = await loadRefreshState(this.statePath, { logger: this.logger })
    this.initialized = true
    if (this.snapshot) {
      this.logger.info('已载入本地快照', {
        items: Object.values(this.snapshot.partitions).reduce((n, a) => n + a.length, 0),
        fetchedAt: this.snapshot.meta.fetchedAt,
      })
    } else {
      this.logger.info('没有本地快照，首次请求会触发一次抓取')
    }
  }

  getSnapshot(): Snapshot | null {
    return this.snapshot
  }

  getState(): RefreshState {
    return this.state
  }

  isRefreshing(): boolean {
    return this.inFlight !== null
  }

  /** 快照已用多少秒 */
  ageSeconds(): number | null {
    if (!this.snapshot) return null
    const at = Date.parse(this.snapshot.meta.fetchedAt)
    if (!Number.isFinite(at)) return null
    return Math.max(0, Math.round((this.now() - at) / 1000))
  }

  /** 距"允许再次抓取"还有多少秒；已经是 0 表示可以抓 */
  private minGapRemainingSeconds(): number {
    if (!this.state.lastAttemptAt) return 0
    const last = Date.parse(this.state.lastAttemptAt)
    if (!Number.isFinite(last)) return 0
    const elapsed = (this.now() - last) / 1000
    return Math.max(0, Math.ceil(this.cfg.minRefreshGapSeconds - elapsed))
  }

  /** 失败冷却期内还剩多少秒；0 表示不在冷却中 */
  private cooldownRemainingSeconds(): number {
    if (this.state.consecutiveFailures === 0 || !this.state.lastAttemptAt) return 0
    const last = Date.parse(this.state.lastAttemptAt)
    if (!Number.isFinite(last)) return 0
    const elapsed = (this.now() - last) / 1000
    return Math.max(0, Math.ceil(this.cfg.failureCooldownSeconds - elapsed))
  }

  /* ------------------------------------------------------------------ */

  /**
   * 每个"要数据"的请求都走这里 —— 顺带做一次按需刷新判定。
   */
  async ensureFresh(): Promise<EnsureFreshResult> {
    await this.init()

    const age = this.ageSeconds()
    const blockingThreshold = this.cfg.blockingRefreshAfterMinutes * 60
    const refreshThreshold = this.cfg.refreshAfterMinutes * 60

    /* ① 无快照，或太旧 → 阻塞等一次抓取 */
    if (this.snapshot === null || (age !== null && age >= blockingThreshold)) {
      const reason =
        this.snapshot === null ? '还没有本地数据' : `数据已过期 ${Math.round((age ?? 0) / 60)} 分钟`
      this.logger.info('触发同步抓取', { reason })
      const result = await this.refresh({ source: 'blocking' })

      /**
       * ⭐ 专门处理“已经有人在抓”。
       *
       * `refresh()` 碰到单飞锁会**立即**返回 `in_progress`。
       * 对后台档这是对的（马上把旧数据回给用户）；
       * 但对阻塞档是错的 —— 调用方说的是“**我没有数据可用**”，
       * 此时唯一正确的做法是**等那一轮抓完**，而不是回一个空快照。
       *
       * 实测后果（Phase 7 接 HTTP 时发现的）：
       *   入口启动时先发起一个后台预热抓取，紧接着 /api/items 进来
       *   → ensureFresh 返回 in_progress + snapshot=null
       *   → 服务回 503「没有数据快照」
       *   而实际上抓取正在进行、几秒后就有数据。网页会显示成“抓取失败”。
       *
       * `waitForIdle()` 等的是同一个 `inFlight` promise，而
       * `performFetch()` 是在那个 promise **内部**给 `this.snapshot` 赋值的，
       * 所以等完之后 snapshot 一定就绪（除非那一轮真失败了）。
       */
      if (result.outcome === 'in_progress') {
        await this.waitForIdle()
        return this.buildEnsureResult('blocking')
      }

      return this.buildEnsureResult(result.started ? 'blocking' : 'served')
    }

    /* ② 有点旧 → 立即返回旧数据，后台抓 */
    if (age !== null && age >= refreshThreshold) {
      const result = await this.refresh({ source: 'auto' })
      this.logger.debug('后台刷新', { ageSeconds: age, outcome: result.outcome })
      return this.buildEnsureResult(result.started ? 'background' : 'served')
    }

    /* ③ 新鲜 → 什么都不做 */
    return this.buildEnsureResult('served')
  }

  private buildEnsureResult(tier: RefreshTier): EnsureFreshResult {
    return {
      snapshot: this.snapshot,
      tier,
      refreshing: this.inFlight !== null,
      ageSeconds: this.ageSeconds(),
      lastError: this.state.lastError,
      keptPartitions: this.keptPartitions,
      keptPrices: this.keptPrices,
    }
  }

  /**
   * 手动刷新（网页上的"刷新"按钮）。
   * **可以绕过 15 分钟判断**（那是明确意图），**但不绕过最小间隔**（防止把源站打爆）。
   */
  async refreshNow(): Promise<RefreshResult> {
    await this.init()
    return this.refresh({ source: 'manual' })
  }

  /** 等当前抓取结束（测试与关闭流程用） */
  async waitForIdle(): Promise<void> {
    if (this.inFlight) await this.inFlight
  }

  /* ------------------------------------------------------------------ */

  private async refresh(options: { source: 'manual' | 'auto' | 'blocking' }): Promise<RefreshResult> {
    /* ── 锁 1：single-flight ── */
    if (this.inFlight) {
      return {
        outcome: 'in_progress',
        started: false,
        message: '已有抓取在进行中，请稍候',
        retryAfterSeconds: this.minGapRemainingSeconds() || 5,
      }
    }

    /* ── 锁 2：最小间隔（手动也不能突破） ── */
    const gap = this.minGapRemainingSeconds()
    if (gap > 0) {
      return {
        outcome: 'too_soon',
        started: false,
        message: `刚更新过，请等 ${gap} 秒后再试`,
        retryAfterSeconds: gap,
      }
    }

    /* ── 锁 3：失败冷却 / 连续失败暂停（只拦自动刷新） ── */
    if (options.source !== 'manual') {
      const cooldown = this.cooldownRemainingSeconds()
      if (cooldown > 0) {
        return {
          outcome: 'cooldown',
          started: false,
          message: `上次抓取失败，冷却中（还剩 ${cooldown} 秒）`,
          retryAfterSeconds: cooldown,
        }
      }
      if (this.state.consecutiveFailures >= this.cfg.maxConsecutiveFailures) {
        return {
          outcome: 'suspended',
          started: false,
          message: `已连续失败 ${this.state.consecutiveFailures} 次，自动刷新已停止；可在网页上手动刷新`,
        }
      }
    }

    /* ── 真正开抓 ── */
    /**
     * ⚠️ `inFlight` 必须在**两条路径上都清掉**。
     * 之前只在后台档清，结果阻塞档抓完一次后 `inFlight` 永远是非 null
     * —— 之后所有刷新都会返回“已在抓取中”。这是写测试时抓出来的真 bug。
     */
    const run = this.performFetch().finally(() => {
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run

    if (options.source === 'blocking') {
      await run
      return {
        outcome: 'started',
        started: true,
        message: this.state.lastError ? `抓取失败：${this.state.lastError}` : '抓取完成',
      }
    }

    // 后台档：不 await（后台跑着），立即返回“已启动”
    return { outcome: 'started', started: true, message: '已开始后台抓取' }
  }

  /** 实际抓取 + 落盘。**这个函数不抛异常** —— 失败会记进 state 并保留旧快照。 */
  private async performFetch(): Promise<void> {
    const startedMs = this.now()
    this.state = {
      ...this.state,
      lastAttemptAt: new Date(startedMs).toISOString(),
    }
    await saveRefreshState(this.statePath, this.state).catch(() => {})

    try {
      const fetched = await this.doFetch(this.cfg, this.logger)

      /**
       * ⭐ **抓到 0 条 = 失败**。
       *
       * 源站改字段名时解析器会安静地返回 0 条 —— 如果只把它当成“没数据”，
       * 你会看到网页上价格全变成 `—`，却不知道原因。
       * 所以这里显式报错：保留旧快照 + 失败计数 + 冷却重试。
       */
      if (fetched.items.length === 0) {
        throw new Error('源站返回 0 条物品 —— 可能改了字段名，已保留旧快照')
      }

      const merged = mergeIntoSnapshot(this.snapshot, {
        fetchedAt: new Date(this.now()).toISOString(),
        itemSourceId: this.cfg.itemSource,
        itemSourceLabel: this.snapshot?.meta.itemSourceLabel ?? this.cfg.itemSource,
        priceSourceLabel: fetched.priceSourceLabel,
        priceBasis: fetched.priceBasis,
        items: fetched.items,
        okPartitions: fetched.itemResult.okPartitions,
        failedPartitions: fetched.itemResult.failedPartitions,
        prices: fetched.prices,
        priceFetchFailed: fetched.priceFetchError !== null || (fetched.prices.size === 0 && fetched.priceSourceLabel !== null),
        requestCount: fetched.requestCount,
        logger: this.logger,
      })

      const wrote = await saveSnapshot(this.snapshotPath, merged.snapshot, { logger: this.logger })
      if (!wrote) {
        // 0 条保护命中 —— 保留旧快照，并且**不更新内存里的快照**
        throw new Error('抓取结果为空，已保留旧快照')
      }

      this.snapshot = merged.snapshot
      this.keptPartitions = merged.keptPartitions
      this.keptPrices = merged.keptPrices

      // 历史快照（为将来的涨跌幅攒数据）—— 失败不影响主流程
      try {
        const flat = this.flattenItems()
        await appendHistory(this.historyDir, flat, new Date(this.now()))
        await pruneHistory(this.historyDir, this.cfg.historyKeepDays, new Date(this.now()))
      } catch (err) {
        this.logger.warn('写历史快照失败（不影响主流程）', { error: (err as Error).message })
      }

      const ms = this.now() - startedMs
      this.state = {
        lastAttemptAt: this.state.lastAttemptAt,
        lastOkAt: new Date(this.now()).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
        lastDurationMs: ms,
      }
      this.logger.info('抓取完成', {
        items: Object.values(merged.snapshot.partitions).reduce((n, a) => n + a.length, 0),
        keptPartitions: merged.keptPartitions.length,
        keptPrices: merged.keptPrices,
        ms,
        requests: fetched.requestCount,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.state = {
        ...this.state,
        lastError: message,
        consecutiveFailures: this.state.consecutiveFailures + 1,
        lastDurationMs: this.now() - startedMs,
      }
      this.logger.error('抓取失败（已保留旧快照）', {
        error: message,
        consecutiveFailures: this.state.consecutiveFailures,
      })
    } finally {
      await saveRefreshState(this.statePath, this.state).catch(() => {})
    }
  }

  /** 把分区里的条目摊平（给历史快照用，那边只关心 objectID 与价格） */
  private flattenItems(): Array<{ sourceItemId: string; price: number | null }> {
    if (!this.snapshot) return []
    const prices: Record<string, PriceQuote> = this.snapshot.prices
    const out: Array<{ sourceItemId: string; price: number | null }> = []
    for (const bucket of Object.values(this.snapshot.partitions)) {
      for (const item of bucket as SourceItem[]) {
        const quote = prices[item.name]
        out.push({ sourceItemId: item.sourceItemId, price: quote?.price ?? null })
      }
    }
    return out
  }
}
