/**
 * 集市（军需处定期兑换）—— **官方接口，需要登录**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 数据来源（实测确认，见 docs/source-recon.md §十一）
 * ═══════════════════════════════════════════════════════════════════════
 *   POST https://comm.ams.game.qq.com/ide/
 *        iChartId=530479 & iSubChartId=530479 & sIdeToken=SwgEeH
 *        & action=3 & source=2
 *        Cookie: openid=…; access_token=…; acctype=qc; appid=101491592
 *
 * 返回（实测当期 7 条兑换项）：
 *   {"ret":0,"jData":{"data":[
 *     {"Item":"11050004004,1",
 *      "ExchangedProps":"15080050007,1;15080050194,1",
 *      "IsBound":"1","BeginTime":"1790301600","EndTime":"1790906399"}, …]}}
 *
 * ⚠️ **踩过的坑（两个，都是"报错与真实原因无关"）**：
 *   1. `action=1` 返回 `ret=-4000`「抱歉，目前访问人数太多！」
 *      —— 这句是**误导性的**，真实原因是参数/状态不符。
 *      我因为只试了 action=1，一度得出"集市没有官方接口"的错误结论。
 *   2. `action=2` 返回 `ret=0` 但 `data: []`（空数组）
 *      —— 看起来成功，其实不是集市。所以**别把"ret=0"当成"拿到数据了"**。
 *
 * ⚠️ 必须用 **POST + 表单参数**（参考实现如此）。用 GET 会拿到
 *    `ret=101` 之类的错误 —— 那个报错同样和"未授权"混在一起，坑过我一次。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 关键语义：不是每个兑换项都要同样的收集品
 * ═══════════════════════════════════════════════════════════════════════
 * 实测当期三种情况同时存在：
 *   · 两件都要（铜币 + 腕带）
 *   · 只要铜币
 *   · 只要腕带
 * 所以对外要给的**不是**某一个兑换项，而是**当期需要哪些收集品（并集）**
 * —— 那才是玩家要"去摸什么"的答案。
 */

import type { AppConfig } from './config'
import { HttpClient } from './http'
import type { Logger } from './logger'

const AMS_ENDPOINT = 'https://comm.ams.game.qq.com/ide/'

/** 军需处 —— `action=3` 才是集市（见文件头第 1、2 条坑）*/
export const MARKET_PARAMS = {
  iChartId: '530479',
  iSubChartId: '530479',
  sIdeToken: 'SwgEeH',
  action: '3',
  source: '2',
} as const

/** 半小时。集市是周级活动，不需要更勤。 */
export const CACHE_TTL_MS = 30 * 60 * 1000

export interface MarketRequirement {
  itemId: string
  qty: number
}

export interface MarketOffer {
  /** 兑换**得到**的物品 */
  itemId: string
  qty: number
  /** 兑换**需要交**的收集品 */
  requires: MarketRequirement[]
  /** 是否绑定（绑定的不能交易）*/
  bound: boolean
  /** Unix 秒；官方给的可能是字符串 */
  beginAt: number | null
  endAt: number | null
}

export interface MarketState {
  offers: MarketOffer[]
  /** ★ 当期需要哪些收集品（并集，去重）—— 这才是网页要展示的 */
  requiredItemIds: string[]
  /** 活动期（所有兑换项的并集范围）*/
  beginAt: number | null
  endAt: number | null
  fetchedAt: string
}

/**
 * ⚠️ 官方返回的值是 **URL 编码**的：`"11050004004%2C1"`
 *    （`%2C` = 逗号、`%3B` = 分号）。
 *    不解码的话整串都会被当成 ID → 正则校验不过 → **每条都被静默跳过** ✗
 *    （表现为"返回了 0 条兑换项"，看起来像接口没数据 ✗）
 */
export function decodeField(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** `"15080050007,1"` → `{itemId, qty}`；数量缺省为 1 */
export function parseIdQty(text: string): MarketRequirement | null {
  const parts = text.split(',')
  const itemId = (parts[0] ?? '').trim()
  if (!/^\d+$/.test(itemId)) return null
  const rawQty = (parts[1] ?? '').trim()
  const qty = rawQty === '' ? 1 : Number(rawQty)
  return { itemId, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 }
}

/** `"a,1;b,2"` → 需求列表（`;` 分隔，也容忍 `|` 和换行）*/
export function parseRequires(rawText: string): MarketRequirement[] {
  const text = decodeField(rawText)
  const out: MarketRequirement[] = []
  for (const piece of text.split(/[;|\n]/)) {
    const one = parseIdQty(piece)
    if (one) out.push(one)
  }
  return out
}

function toUnixSeconds(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * 解析接口响应（纯函数 → 可单测）。
 *
 * 对每个"看起来不对"的情况都**明确报错**，不静默返回空 ✓
 * —— 空清单在网页上会显示成"当期没有集市物品"，那是误导 ✗。
 */
export function parseMarketResponse(raw: unknown): MarketState {
  const body = raw as {
    ret?: number
    sMsg?: string
    jData?: { data?: { data?: unknown } }
  }
  if (body?.ret !== 0) {
    throw new Error(
      `军需处接口返回 ret=${String(body?.ret)}，sMsg=${body?.sMsg ?? '(空)'}` +
        '（注意：`访问人数太多` 是误导性文案，真实原因通常是 action/方法不对）',
    )
  }
  /**
   * ⚠️ 两种嵌套都见过，必须都认：
   *   · 军需处 action=3 → `jData.data` 直接是数组 ✓
   *   · 其他接口（如 config.list）→ `jData.data.data`
   *   一开始我只认了后者，于是拿到真数据却报"结构可能改了" ✗ ——
   *   **报错信息把"我认错了结构"说成了"接口改了"**，又是一次误导 ✗。
   */
  const outer = body.jData?.data as unknown
  const list = Array.isArray(outer)
    ? outer
    : Array.isArray((outer as { data?: unknown } | undefined)?.data)
      ? ((outer as { data: unknown[] }).data)
      : null
  if (list === null) {
    throw new Error(
      '军需处接口的 jData.data(.data) 不是数组 —— 实到的是：' +
        JSON.stringify(body.jData ?? null).slice(0, 200),
    )
  }

  const offers: MarketOffer[] = []
  for (const entry of list) {
    const it = entry as Record<string, unknown>
    const item = parseIdQty(decodeField(String(it['Item'] ?? '')))
    if (!item) continue
    offers.push({
      itemId: item.itemId,
      qty: item.qty,
      requires: parseRequires(String(it['ExchangedProps'] ?? '')),
      bound: String(it['IsBound'] ?? '0') === '1',
      beginAt: toUnixSeconds(it['BeginTime']),
      endAt: toUnixSeconds(it['EndTime']),
    })
  }

  if (offers.length === 0) {
    // ⚠️ `action=2` 就是这样：ret=0 但空数组。别把它当成功 ✓
    throw new Error(
      '军需处接口返回了 0 条兑换项（`action=2` 就是这样：ret=0 但 data 为空）' +
        '—— 多半是 action 用错了。' + `sMsg=${body.sMsg ?? ''}`,
    )
  }

  const required = new Set<string>()
  for (const o of offers) for (const r of o.requires) required.add(r.itemId)

  const begins = offers.map((o) => o.beginAt).filter((v): v is number => v !== null)
  const ends = offers.map((o) => o.endAt).filter((v): v is number => v !== null)

  return {
    offers,
    requiredItemIds: [...required],
    beginAt: begins.length > 0 ? Math.min(...begins) : null,
    endAt: ends.length > 0 ? Math.max(...ends) : null,
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * 请求地址 + **表单体**（纯函数 → 可单测）。
 *
 * ⚠️ 踩过的坑：参数必须放在 **POST body** 里，不能拼在 URL 查询串上 ✗。
 *    （每日密码那个接口是读查询串的，所以我一开始照抄了那种写法 ——
 *      结果军需处返回了一个结构完全不同的东西，
 *      报错只说"不是数组"，得往回查才知道是参数没被读到 ✗。）
 */
export function buildMarketRequest(endpoint: string = AMS_ENDPOINT): {
  url: string
  body: string
} {
  return { url: endpoint, body: new URLSearchParams(MARKET_PARAMS).toString() }
}

let cache: { value: MarketState; atMs: number } | null = null

/** 测试用：清掉缓存 */
export function resetMarketCache(): void {
  cache = null
}

export interface FetchMarketOptions {
  now?: () => number
  force?: boolean
  /** 登录凭据 → Cookie 头。没有登录时调用方不该调这个函数 ✓ */
  cookie: string
  /** 注入 http，测试一律不发网络请求 */
  http?: HttpClient
}

/**
 * 取集市状态（带缓存）。
 *
 * ⚠️ 失败时**不覆盖缓存** —— 上一次的结果比"没有结果"有用得多
 *    （集市是周级活动，半小时前的清单几乎一定仍然有效）。
 */
export async function fetchMarketState(
  cfg: AppConfig,
  logger: Logger,
  options: FetchMarketOptions,
): Promise<MarketState> {
  const now = options.now ?? Date.now
  if (!options.force && cache !== null && now() - cache.atMs < CACHE_TTL_MS) {
    return cache.value
  }

  const http = options.http ?? new HttpClient(cfg, logger)
  try {
    const req = buildMarketRequest()
    const res = await http.request(req.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        // 参考实现带了 Referer；官方接口会看它
        Referer: 'https://df.qq.com/',
        Cookie: options.cookie,
      },
      body: req.body,
    })
    if (!res.ok) throw new Error(`军需处接口返回 HTTP ${res.status}`)

    const state = parseMarketResponse(res.json())
    cache = { value: { ...state, fetchedAt: new Date(now()).toISOString() }, atMs: now() }
    logger.info('集市清单已更新', {
      offers: state.offers.length,
      required: state.requiredItemIds.length,
    })
    return cache.value
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (cache !== null) {
      logger.warn('取集市清单失败，沿用上一次的结果', {
        error: message,
        keptFrom: cache.value.fetchedAt,
      })
      return cache.value
    }
    throw new Error(`取集市清单失败：${message}`)
  }
}
