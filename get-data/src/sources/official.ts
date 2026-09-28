/**
 * 腾讯官方 AMS 适配器 —— 物品主数据源。
 *
 * 接口（Phase 0 实测，详见 docs/source-recon.md）：
 *
 *   GET/POST https://comm.ams.game.qq.com/ide/
 *     ?iChartId=352143&iSubChartId=352143&sIdeToken=YWRywA
 *     &method=dfm/object.list&source=2
 *     &param={"primary":"props","second":"","objectID":""}
 *
 * 实测要点：
 *   · **不需要 Cookie、不需要登录、不需要签名**（匿名请求即返回 491KB）
 *   · 无 robots.txt
 *   · ⚠️ 一次拉全量会被服务端中途断开（响应 >2.2MB）→ **必须按大类分 7 次请求**
 *   · ⚠️ 无效 method 会返回 `ret:-201 "抱歉，目前访问人数太多！"`
 *     —— 这是**误导性报错**，实际含义是方法不存在，不是限流
 *
 * 这个适配器只做三件事：发请求、校验、翻译成 SourceItem。
 * 它**不算任何派生指标**（slots / pricePerSlot / todayChangePct 由 metrics.ts 负责）。
 */

import { z } from 'zod'
import {
  HARD_EXCLUDED_CATEGORY_CODES,
  HARD_EXCLUDED_ITEM_IDS,
  OFFICIAL_CATEGORY_CODES,
} from '../constants'
import type { FetchContext, ItemFetchResult, ItemSource, SourceItem } from './types'

const AMS_ENDPOINT = 'https://comm.ams.game.qq.com/ide/'

/** 这几个参数在 Phase 0 实测得到，都是公开静态值（前端 JS 里就能看到） */
const AMS_QUERY: Readonly<Record<string, string>> = {
  iChartId: '352143',
  iSubChartId: '352143',
  sIdeToken: 'YWRywA',
  method: 'dfm/object.list',
  source: '2',
}

/* ══════════════════════════════════════════════════════════════════════
 * zod 校验模式
 * ══════════════════════════════════════════════════════════════════════
 *
 * 为什么必须校验：外部数据**不可信**。实测踩到的坑：
 *   · weight 是字符串（"2.9"），而且可能是空串 ""
 *   · avgPrice 可能是 0（含义是"无价格"，不是"零元"）
 *   · secondClassCN / thirdClass 可能整个字段都不存在
 *   · propsDetail 是变长结构，四种形状完全不同
 *
 * 用 `.nullish()` = nullable + optional，既允许 null 也允许字段缺失。
 * `propsDetail` 用 `z.record(z.unknown())` —— **不做形状约束**，
 * 否则消耗品的 34 条会被整批丢弃。
 */

const OfficialRawItem = z.object({
  objectID: z.number(),
  objectName: z.string(),

  length: z.number().nullish(),
  width: z.number().nullish(),
  grade: z.number().nullish(),
  weight: z.string().nullish(),

  primaryClass: z.string(),
  secondClass: z.string().nullish(),
  secondClassCN: z.string().nullish(),
  thirdClass: z.string().nullish(),
  thirdClassCN: z.string().nullish(),

  desc: z.string().nullish(),
  pic: z.string().nullish(),
  prePic: z.string().nullish(),
  avgPrice: z.number().nullish(),

  /** ⚠️ 变长结构，刻意不约束形状 */
  propsDetail: z.record(z.unknown()).nullish(),
})

/** 外层信封：{ ret, sMsg, jData: { data: { code, data: { list }, msg } } } */
const OfficialEnvelope = z.object({
  ret: z.number(),
  sMsg: z.string().optional(),
  jData: z
    .object({
      data: z.object({
        code: z.number(),
        data: z.object({ list: z.array(z.unknown()) }),
        msg: z.string().optional(),
      }),
    })
    .optional(),
})

/* ══════════════════════════════════════════════════════════════════════
 * 辅助函数
 * ══════════════════════════════════════════════════════════════════════ */

/** 拼查询串。注意 param 是"先 JSON 序列化、再 URL 编码"的两步动作。 */
function buildUrl(categoryCode: string): string {
  const parts = Object.entries(AMS_QUERY).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
  )
  const param = encodeURIComponent(
    JSON.stringify({ primary: categoryCode, second: '', objectID: '' }),
  )
  return `${AMS_ENDPOINT}?${parts.join('&')}&param=${param}`
}

/**
 * 重量：源里是字符串，可能是 ""。转换失败一律给 null。
 *
 * 注意不能写 `Number(v)` 就完事 —— `Number('')` 的结果是 `0`，
 * 而这里的语义是"没有重量数据"，必须给 null。
 */
function toWeight(v: string | null | undefined): number | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/**
 * 价格归一化。
 * ⚠️ `0` 必须变成 `null` —— 实测 `哈夫克脑机液-“超体”`、`特殊装备补给`
 * 等条目的 avgPrice 就是 0，含义是"无价格/非卖品"，不是"零元"。
 * 如果当成 0，它们会被排到最后一名而不是被正确标为"非卖品"。
 */
function toPrice(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  return v
}

/** 非负整数化，用于占格。非法值给 0（0 会被 carryable 判定兜住）。 */
function toSlotSize(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  return Math.trunc(v)
}

/** 从 propsDetail 里挑出 `propsSource`（出产地原始串） */
function pickRawProvenance(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail) return null
  const v = detail['propsSource']
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 从 propsDetail 里挑出 `type`（如"工艺藏品"） */
function pickItemSubtype(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail) return null
  const v = detail['type']
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 把一条通过 zod 校验的原始记录翻译成 SourceItem */
function toSourceItem(raw: z.infer<typeof OfficialRawItem>): SourceItem {
  const detail = (raw.propsDetail ?? null) as Record<string, unknown> | null
  return {
    sourceItemId: String(raw.objectID),
    name: raw.objectName,
    // 官方没有别名字段
    alias: null,
    description: raw.desc ?? null,
    iconUrl: raw.pic ?? '',
    thumbUrl: raw.prePic ?? null,

    categoryCode: raw.primaryClass,
    subcategory: raw.secondClass ?? '',
    subcategoryCn: raw.secondClassCN ?? null,
    thirdClass: raw.thirdClass ?? null,
    thirdClassCn: raw.thirdClassCN ?? null,
    itemSubtype: pickItemSubtype(detail),

    rawProvenance: pickRawProvenance(detail),

    grade: raw.grade ?? 0,
    weight: toWeight(raw.weight),
    width: toSlotSize(raw.width),
    length: toSlotSize(raw.length),

    // 官方接口里没有"基准价"这个独立字段
    basePrice: null,
    officialAvgPrice: toPrice(raw.avgPrice),

    lastUpdate: null, // 官方物品列表不带更新时间
    propsDetail: detail,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 适配器本体
 * ══════════════════════════════════════════════════════════════════════ */

export const officialItemSource: ItemSource = {
  id: 'official',
  label: '腾讯官方接口',
  homepage: 'https://df.qq.com',

  /**
   * ⚠️ `hasPrice: false` 是刻意的。
   * 官方确实有个 `avgPrice` 字段，但它是"近期平均交易价格"——
   * 官方小程序自述"仅供参考，实时交易价格请前往游戏内交易行查看"。
   * 实测与第三方现价平均差 7.4%、极端离群到 550%，**不能用于判定**。
   * 所以能力声明里如实写"没有可用价格"，网页据此不会把它当价格源用。
   */
  capabilities: {
    hasPrice: false,
    hasSlots: true,
    hasYesterdayAvg: false,
    hasYesterdayRange: false,
    hasRange: false,
    hasAlias: false,
    hasSubcategory: true,
    hasProvenance: true,
    hasDurabilityVariants: false,
  },

  /** 7 个大类 = 7 次请求 */
  requestBudget: OFFICIAL_CATEGORY_CODES.length,

  async fetchItems(ctx: FetchContext): Promise<ItemFetchResult> {
    const log = ctx.logger
    const items: SourceItem[] = []
    const okPartitions: string[] = []
    const failedPartitions: Array<{ key: string; error: string }> = []

    for (const categoryCode of OFFICIAL_CATEGORY_CODES) {
      try {
        const res = await ctx.http.request(buildUrl(categoryCode), {
          method: 'GET',
          headers: { Referer: 'https://df.qq.com/' },
          signal: ctx.signal,
        })

        // 原始响应整份留存 —— 将来官方改字段时，可以拿历史响应重新解析排查
        await ctx.saveRaw(`official/${categoryCode}.json`, res.bytes())

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        const envelope = OfficialEnvelope.safeParse(res.json())
        if (!envelope.success) {
          throw new Error(`响应信封结构不符预期：${envelope.error.issues[0]?.message ?? '未知'}`)
        }
        if (envelope.data.ret !== 0) {
          // 实测无效 method 会返回 ret:-201 + 一句误导性的"访问人数太多"
          throw new Error(`接口返回 ret=${envelope.data.ret}，sMsg=${envelope.data.sMsg ?? '(空)'}`)
        }

        const rawList = envelope.data.jData?.data?.data?.list
        if (!Array.isArray(rawList)) {
          throw new Error('响应里找不到 jData.data.data.list')
        }

        let dropped = 0
        for (const raw of rawList) {
          const parsed = OfficialRawItem.safeParse(raw)
          if (!parsed.success) {
            // 单条坏数据只丢它自己，不中断整批
            dropped += 1
            continue
          }
          items.push(toSourceItem(parsed.data))
        }

        if (dropped > 0) {
          log.warn('部分条目校验失败已丢弃', { category: categoryCode, dropped, total: rawList.length })
        }

        okPartitions.push(categoryCode)
        log.debug('分类抓取完成', { category: categoryCode, kept: rawList.length - dropped })
      } catch (err) {
        // ⭐ 关键：一个分类失败**不中断**其它分类，只记录下来
        const message = err instanceof Error ? err.message : String(err)
        failedPartitions.push({ key: categoryCode, error: message })
        log.error('分类抓取失败', { category: categoryCode, error: message })
      }
    }

    // 全部失败才抛错（否则交给上层用旧快照补齐失败的分区）
    if (okPartitions.length === 0) {
      const detail = failedPartitions.map((f) => `${f.key}: ${f.error}`).join('; ')
      throw new Error(`官方接口所有分类均抓取失败 → ${detail}`)
    }

    // 硬性排除：大类（载具/皮肤）+ 个别明确不需要的物品（按官方ID）
    const before = items.length
    const byCategory = items.filter(
      (it) => !HARD_EXCLUDED_CATEGORY_CODES.includes(it.categoryCode),
    )
    const kept = byCategory.filter((it) => !HARD_EXCLUDED_ITEM_IDS.includes(it.sourceItemId))
    const excluded = before - kept.length
    if (excluded > 0) {
      log.info('已排除不可携带的大类与个别物品', {
        excluded,
        categories: HARD_EXCLUDED_CATEGORY_CODES.join(','),
        itemIds: HARD_EXCLUDED_ITEM_IDS.join(','),
      })
    }

    log.info('官方源抓取完成', {
      kept: kept.length,
      okCategories: okPartitions.length,
      failedCategories: failedPartitions.length,
    })

    return { items: kept, okPartitions, failedPartitions }
  },
}
