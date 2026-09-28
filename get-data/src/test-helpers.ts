/**
 * 单元测试的共用辅助。
 *
 * 为什么单独一个文件：`makeSourceItem` 这种fixture 在好几个测试里都要用，
 * 每个文件各抄一份的话，改 `SourceItem` 结构时就得改好几处。
 *
 * ⚠️ 文件名不能叫 `*.test.ts`，否则 vitest 会把它当成测试文件去跑。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from './config'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'

/** 造一个最小的 SourceItem。只传你关心的字段，其余用合理默认值。 */
export function makeSourceItem(over: Partial<SourceItem> = {}): SourceItem {
  return {
    sourceItemId: '15080050142',
    name: '海洋之泪',
    alias: null,
    description: null,
    iconUrl: 'https://example.com/a.png',
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

/** 造一个价格快照 */
export function makeQuote(over: Partial<PriceQuote> = {}): PriceQuote {
  return {
    price: 100,
    basePrice: null,
    yesterdayAvg: null,
    yesterdayLow: null,
    yesterdayHigh: null,
    rangeLow: null,
    rangeHigh: null,
    updateTime: null,
    ...over,
  }
}

/** 创建一个临时目录（测试用，afterEach 里要清掉） */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/**
 * 造一个测试用配置。
 *
 * ⭐ 刻意**不调 `loadConfig()`** —— 那会去读真实的 `.env`，
 * 让测试受本机配置影响。这里所有字段都写死，测试才是可复现的。
 */
export function makeTestConfig(dataDir: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    host: '127.0.0.1',

    itemSource: 'official',
    priceSource: 'moligod',
    moligodBaseUrl: 'https://example.invalid',
    derGameBaseUrl: 'https://example.invalid',

    refreshAfterMinutes: 15,
    blockingRefreshAfterMinutes: 120,
    minRefreshGapSeconds: 120,
    failureCooldownSeconds: 300,
    maxConsecutiveFailures: 5,

    contactEmail: 'test@example.com',
    userAgent: 'DeltaForce-PriceBoard/test',
    concurrency: 1,
    requestDelayMinMs: 0,
    requestDelayMaxMs: 0,
    requestTimeoutMs: 1000,
    retryMax: 0,
    retryBaseDelayMs: 1,

    packageRoot: dataDir,
    dataDir,
    overridesDir: dataDir,
    provenanceOverridesPath: join(dataDir, 'provenance.json'),
    itemAttributesOverridesPath: join(dataDir, 'item-attributes.json'),
    historyKeepDays: 8,
    rawKeepRounds: 48,

    logLevel: 'silent',
    ...over,
  }
}
