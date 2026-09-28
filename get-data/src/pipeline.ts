/**
 * 取数管道 —— 把「抓主数据 → 抓价格 → 按名称 join」串成一个可复用的函数。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要提取成独立模块
 * ═══════════════════════════════════════════════════════════════════════
 * 同一套流程有三个地方要用：
 *   ① `scripts/fetch-once.ts`     —— 一次性抓取（验收 / 排查）
 *   ② `scripts/provenance-todo.ts` —— 待补清单（要按单格价值排序，所以需要价格）
 *   ③ `src/refresher.ts`（Phase 6）—— 按需刷新的核心
 *
 * 如果各写各的，三次实现会慢慢长歪（一个忘了存 raw、一个忘了记失败分类…）。
 * 所以只写一份。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join as joinPath } from 'node:path'
import type { Item, ItemSourceId } from '@deltaforce/shared'
import type { AppConfig } from './config'
import { ITEM_STALE_AFTER_HOURS } from './constants'
import { HttpClient } from './http'
import { joinPrices, type JoinStats } from './join'
import type { Logger } from './logger'
import { normalizeItems, type NormalizeStats } from './normalize'
import {
  applyItemAttributesOverrides,
  checkAttributeConflicts,
  loadItemAttributesOverrides,
  type AppliedItemAttributes,
  type ApplyAttributesStats,
} from './overrides/item-attributes'
import {
  applyProvenanceOverrides,
  loadProvenanceOverrides,
  validateMapNames,
  type AppliedProvenance,
  type ApplyStats,
} from './overrides/provenance'
import { getPriceSource, isPriceSourceAvailable } from './prices/registry'
import type { PriceQuote } from './prices/types'
import { collectMapNames } from './provenance'
import { getItemSource } from './sources/registry'
import type { FetchContext, ItemFetchResult, SourceItem } from './sources/types'
import type { Snapshot } from './store'

export interface FetchEverythingOptions {
  /** 只抓主数据、不抓价格（用于验证降级路径） */
  skipPrices?: boolean
  /**
   * 原始响应的保存方式。
   * 不传时默认写到 `<dataDir>/raw/<name>`（同名覆盖，只保留最新一份）。
   */
  saveRaw?: (name: string, data: Uint8Array | string) => Promise<void>
  signal?: AbortSignal
}

export interface FetchEverythingResult {
  /** 主数据（已排除载具等硬性排除项） */
  items: SourceItem[]
  /** 价格查找表：物品名 → 价格。（skipPrices 或源不可用时为空 Map） */
  prices: Map<string, PriceQuote>
  /** 主数据源的抓取结果（含成功/失败分类，供"部分失败时保留旧数据"用） */
  itemResult: ItemFetchResult
  /** 实际的零售源标签；未使用则为 null */
  priceSourceLabel: string | null
  /** 价格口径说明，会显示在网页上 */
  priceBasis: string | null
  /**
   * 价格源是否抓取失败。
   * ⭐ 失败时上层应**沿用旧价格**，而不是把价格清空。
   * 非 null 表示失败，内容是原因。
   */
  priceFetchError: string | null
  /** 已保存的原始响应文件路径 */
  savedRaw: string[]
  /** 实际发出的 HTTP 请求次数 */
  requestCount: number
}

/** 默认的原始响应保存器：写到 `<dataDir>/raw/<name>`，自动建目录 */
export function createRawSaver(cfg: AppConfig): {
  saveRaw: (name: string, data: Uint8Array | string) => Promise<void>
  saved: string[]
} {
  const rawDir = joinPath(cfg.dataDir, 'raw')
  const saved: string[] = []
  const saveRaw = async (name: string, data: Uint8Array | string): Promise<void> => {
    const target = joinPath(rawDir, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
    saved.push(target)
  }
  return { saveRaw, saved }
}

/**
 * 跑一遍完整管道。
 *
 * 注意：**价格源失败不会让整个管道失败** —— 因为物品主数据是独立的，
 * 价格拿不到只是"价格列显示暂不可用"，物品列表照常可用。这是方案里
 * 明确要求的降级行为。
 */
export async function fetchEverything(
  cfg: AppConfig,
  logger: Logger,
  options: FetchEverythingOptions = {},
): Promise<FetchEverythingResult> {
  const http = new HttpClient(cfg, logger)
  const savedRaw: string[] = []

  const defaultSaver = createRawSaver(cfg)
  const saveRaw = options.saveRaw ?? (async (name, data) => {
    await defaultSaver.saveRaw(name, data)
  })
  // 无论用哪个 saver，都记录一份文件清单
  const recordingSaver = async (name: string, data: Uint8Array | string): Promise<void> => {
    await saveRaw(name, data)
    savedRaw.push(name)
  }

  const signal = options.signal ?? new AbortController().signal

  /* ---------------- 1. 物品主数据 ---------------- */

  const itemSource = getItemSource(cfg.itemSource)
  const itemResult = await itemSource.fetchItems({
    config: cfg,
    logger: logger.child({ source: itemSource.id }),
    http,
    signal,
    saveRaw: recordingSaver,
  } satisfies FetchContext)

  /* ---------------- 2. 价格 ---------------- */

  let prices = new Map<string, PriceQuote>()
  let priceSourceLabel: string | null = null
  let priceBasis: string | null = null
  let priceFetchError: string | null = null

  const wantPrices = options.skipPrices !== true && cfg.priceSource !== 'none'
  if (wantPrices) {
    if (!isPriceSourceAvailable(cfg.priceSource)) {
      logger.warn('配置里的价格源尚未实现，已跳过取价', { priceSource: cfg.priceSource })
    } else {
      const priceSource = getPriceSource(cfg.priceSource)
      if (priceSource) {
        priceSourceLabel = priceSource.label
        priceBasis = priceSource.priceBasis
        try {
          prices = await priceSource.fetchPrices({
            config: cfg,
            logger: logger.child({ source: priceSource.id }),
            http,
            signal,
            saveRaw: recordingSaver,
          })
        } catch (err) {
          // ⭐ 关键降级：价格源挂了不影响主数据
          const message = err instanceof Error ? err.message : String(err)
          priceFetchError = message
          logger.error('价格源抓取失败（物品主数据仍然可用）', {
            source: priceSource.id,
            error: message,
          })
          priceSourceLabel = priceSource.label
          priceBasis = priceSource.priceBasis
        }
      }
    }
  }

  return {
    items: itemResult.items,
    prices,
    itemResult,
    priceSourceLabel,
    priceBasis,
    priceFetchError,
    savedRaw: savedRaw.length > 0 ? savedRaw : defaultSaver.saved,
    requestCount: http.requestCount,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 一条龙：抓取 → join → 合并人工标注 → normalize → Item[]
 * ══════════════════════════════════════════════════════════════════════ */

export interface BuildEverythingOptions extends FetchEverythingOptions {
  /** 跳过人工覆盖（仅用于测试与诊断） */
  skipOverrides?: boolean
}

export interface BuildEverythingResult {
  /** ⭐ 最终产物：网页与 API 只用这个 */
  items: Item[]
  normalizeStats: NormalizeStats
  joinStats: JoinStats
  provenanceStats: ApplyStats
  attributesStats: ApplyAttributesStats
  /** 数据里出现过的全部地图名（供 /api/meta 与地图筛选） */
  mapNames: string[]
  /**
   * 需要提醒用户的问题。
   * 包括：覆盖文件格式错误、键没匹配上、**地图名可能是拼错的**。
   */
  warnings: string[]
  savedRaw: string[]
  requestCount: number
  fetchedAt: string
  itemSourceId: ItemSourceId
  itemSourceLabel: string
  priceSourceLabel: string | null
  priceBasis: string | null
}

export interface BuildEverythingOptions extends FetchEverythingOptions {
  /** 跳过人工覆盖（仅用于测试与诊断） */
  skipOverrides?: boolean
}

/** 纯构建的结果（不含抓取信息） */
export interface BuiltResult {
  /** ⭐ 最终产物：网页与 API 只用这个 */
  items: Item[]
  normalizeStats: NormalizeStats
  joinStats: JoinStats
  provenanceStats: ApplyStats
  attributesStats: ApplyAttributesStats
  /** 数据里出现过的全部地图名（供 /api/meta 与地图筛选） */
  mapNames: string[]
  /**
   * 需要提醒用户的问题。
   * 包括：覆盖文件格式错误、键没匹配上、**地图名可能是拼错的**。
   */
  warnings: string[]
}

export interface BuildEverythingResult extends BuiltResult {
  savedRaw: string[]
  requestCount: number
  fetchedAt: string
  itemSourceId: ItemSourceId
  itemSourceLabel: string
  priceSourceLabel: string | null
  priceBasis: string | null
  /** 价格源是否抓取失败（非 null 表示失败原因） */
  priceFetchError: string | null
}

/**
 * ⭐ 纯构建：**原料 → 成品，不抓取**。
 *
 * 这是整个项目最重要的一层复用：
 *   · `fetchAndBuild()` —— 抓取后再构建（脚本用）
 *   · `buildFromSnapshot()` —— 从本地快照构建（接口用）
 *
 * 两者走的是**同一套 join / 人工标注合并 / normalize 逻辑**，
 * 所以“同一份原料无论从哪个入口跑，结果一致”。
 *
 * 更重要的是：因为它不抓取，所以**改人工标注后不需要重新拓数据** ——
 * 重新构建一遂就能看到效果。抓取是唯一“给别人添麻烦”的动作，能省则省。
 */
export async function buildItems(
  cfg: AppConfig,
  logger: Logger,
  sourceItems: readonly SourceItem[],
  prices: ReadonlyMap<string, PriceQuote>,
  options: { fetchedAt: string; skipOverrides?: boolean },
): Promise<BuiltResult> {
  const warnings: string[] = []
  const fetchedAt = options.fetchedAt

  /* 1. 按名称 join */
  const { items: joined, stats: joinStats } = joinPrices(sourceItems, prices)

  /* 3. 合并人工标注 */
  let provenanceStats: ApplyStats = {
    totalItems: joined.length,
    overrideCount: 0,
    applied: 0,
    matchedById: 0,
    matchedByName: 0,
    keptOfficial: 0,
    newlyFilled: 0,
    explicitlyCleared: 0,
    unmatchedKeys: [],
    problems: [],
  }
  let statusStats: ApplyAttributesStats = {
    totalItems: joined.length,
    overrideCount: 0,
    applied: 0,
    matchedById: 0,
    matchedByName: 0,
    lootable: joined.length,
    unobtainable: 0,
    expired: 0,
    notListable: 0,
    unitsUnknown: 0,
    seasonalCurrent: 0,
    seasonalPast: 0,
    unmatchedKeys: [],
  }
  let provenanceMap = new Map<string, AppliedProvenance>()
  let statusMap = new Map<string, AppliedItemAttributes>()

  if (options.skipOverrides !== true) {
    const provLoad = await loadProvenanceOverrides(cfg.provenanceOverridesPath)
    const statusLoad = await loadItemAttributesOverrides(cfg.itemAttributesOverridesPath)

    for (const p of [...provLoad.problems, ...statusLoad.problems]) {
      warnings.push(`${p.key ? `[${p.key}] ` : ''}${p.message}`)
    }

    const provApplied = applyProvenanceOverrides(sourceItems, provLoad.overrides)
    const statusApplied = applyItemAttributesOverrides(sourceItems, statusLoad.overrides)
    provenanceStats = provApplied.stats
    statusStats = statusApplied.stats
    provenanceMap = provApplied.byItemId
    statusMap = statusApplied.byItemId

    for (const key of provApplied.stats.unmatchedKeys) {
      warnings.push(`出产地覆盖的键「${key}」没匹配到任何物品（名称写错或官方改名？）`)
    }
    for (const key of statusApplied.stats.unmatchedKeys) {
      warnings.push(`物品属性标注的键「${key}」没匹配到任何物品（名称写错或官方改名？）`)
    }

    /* ⭐ 赛季限定标记与显式写法是否矛盾（防止改了一列忘了另一列） */
    for (const p of checkAttributeConflicts(statusLoad.overrides)) {
      warnings.push(`[${p.key}] ${p.message}`)
    }

    /* ⭐ 地图名软校验：只警告，不阻拦 */
    const officialMapNames = collectMapNames(sourceItems)
    for (const u of validateMapNames(provLoad.overrides, officialMapNames)) {
      warnings.push(
        `地图名「${u.mapName}」在官方数据里从未出现过（可能是拼写错误），` +
          `被 ${u.usedBy} 条覆盖使用。官方数据里的地图：${officialMapNames.join('、') || '（无）'}`,
      )
    }
  }

  /* 4. normalize */
  const mapNames = collectMapNames(sourceItems)
  const { items, stats: normalizeStats } = normalizeItems(joined, {
    itemSource: cfg.itemSource,
    provenance: provenanceMap,
    attributes: statusMap,
    allMapNames: mapNames,
    staleAfterHours: ITEM_STALE_AFTER_HOURS,
    fetchedAt,
  })

  logger.debug('构建完成', {
    items: items.length,
    withPrice: normalizeStats.withPrice,
    warnings: warnings.length,
  })

  return {
    items,
    normalizeStats,
    joinStats,
    provenanceStats,
    attributesStats: statusStats,
    mapNames,
    warnings,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 两个入口
 * ══════════════════════════════════════════════════════════════════════ */

/** 抓取 + 构建（脚本用：一次性拉新数据并看到成品） */
export async function fetchAndBuild(
  cfg: AppConfig,
  logger: Logger,
  options: BuildEverythingOptions = {},
): Promise<BuildEverythingResult> {
  const fetched = await fetchEverything(cfg, logger, options)
  const itemSource = getItemSource(cfg.itemSource)
  const fetchedAt = new Date().toISOString()

  const built = await buildItems(cfg, logger, fetched.items, fetched.prices, {
    fetchedAt,
    ...(options.skipOverrides === true ? { skipOverrides: true } : {}),
  })

  return {
    ...built,
    savedRaw: fetched.savedRaw,
    requestCount: fetched.requestCount,
    fetchedAt,
    itemSourceId: cfg.itemSource,
    itemSourceLabel: itemSource.label,
    priceSourceLabel: fetched.priceSourceLabel,
    priceBasis: fetched.priceBasis,
    priceFetchError: fetched.priceFetchError,
  }
}

/**
 * 从本地快照构建（**不抓取**）。
 *
 * ⭐ 这是“改人工标注后不需要重新拓数据”的实现：
 * 快照里存的是原料，重新构建就能反映新的标注。
 * HTTP 接口（Phase 7）就走这条路。
 */
export async function buildFromSnapshot(
  cfg: AppConfig,
  logger: Logger,
  snapshot: Snapshot,
): Promise<BuiltResult> {
  const sourceItems: SourceItem[] = Object.values(snapshot.partitions).flat()
  const prices = new Map<string, PriceQuote>(Object.entries(snapshot.prices))

  return buildItems(cfg, logger, sourceItems, prices, {
    fetchedAt: snapshot.meta.fetchedAt,
  })
}
