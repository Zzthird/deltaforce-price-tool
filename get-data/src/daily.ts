/**
 * 每日地图密码 —— 官方接口的**公开**数据。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 数据来源（实测确认，见 docs/source-recon.md §九）
 * ═══════════════════════════════════════════════════════════════════════
 * 同一个官方接口族（和我们的物品主数据**同一个 host、同一个 iChartId**）：
 *
 *   POST https://comm.ams.game.qq.com/ide/
 *        ?iChartId=352143&iSubChartId=352143&sIdeToken=YWRywA
 *        &method=dfm/center.day.secret&source=2
 *
 * 返回（2026-09-29 实测）：
 *   {"ret":0,"jData":{"data":{"data":{"list":[
 *     {"mapID":1,"mapName":"零号大坝","secret":"1690"}, …]}}}}
 *
 * ⚠️ **不需要登录** —— 实测 `ret=0`，不带任何 cookie/openid/access_token。
 *    （线索来自一个第三方 PHP 项目，但它给这个接口传了 cookie 是多余的；
 *      对照实验：制造 365589 / 军需处 530479 返回 `ret=101` 确实要登录。）
 *
 * ⚠️ 密码是 **4 位数字的字符串**，可能是 `"0178"` 这种**带前导零**的 ——
 *    全程按字符串处理，转数字会把那个 0 丢掉。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么单独一个模块，而不是塞进刷新器
 * ═══════════════════════════════════════════════════════════════════════
 * 刷新器管的是"物品 + 价格"那份快照（存 `snapshot.json`，有版本号、
 * 有历史、有三道锁）。密码是**另一类东西**：
 *   · 它是**每天变一次**的，跟 15 分钟的价格刷新节奏完全不同
 *   · 它不进历史、不参与排序、也不影响任何判定
 * 硬塞进快照只会让那份数据结构更杂。所以这里用一个**独立的轻量缓存**。
 */

import type { AppConfig } from './config'
import { HttpClient } from './http'
import type { Logger } from './logger'

const AMS_ENDPOINT = 'https://comm.ams.game.qq.com/ide/'

/** 每日密码接口的参数（实测确认，与物品列表同一个 iChartId）*/
const SECRET_PARAMS = {
  iChartId: '352143',
  iSubChartId: '352143',
  sIdeToken: 'YWRywA',
  method: 'dfm/center.day.secret',
  source: '2',
} as const

export interface DailySecret {
  /** 官方给的地图 id（可能为 null —— 字段缺失时不编造）*/
  mapId: number | null
  mapName: string
  /**
   * 密码。**保持字符串** —— 可能是 `"0178"` 这种带前导零的，
   * 转成数字会变成 `178`（少一位，看错）。前端也不用补零。
   */
  secret: string
}

export interface DailySecrets {
  secrets: DailySecret[]
  /** 这一份是什么时候取到的（ISO 8601）—— 页面上要显示"数据多旧" */
  fetchedAt: string
}

/**
 * 缓存时长。
 *
 * ⚠️ 为什么不是"按天缓存"：密码是按**服务器日期**换的，而我们无法可靠地
 *    知道它几点换（也没有必要去猜）。所以用一个**保守的短 TTL** ——
 *    半小时。这样：
 *      · 白天一直开着网页，最多半小时就会拿到新密码 ✓
 *      · 不会每次刷新页面都去打源站（半小时最多 1 次请求）✓
 *      · 万一我们猜错了换密码的时刻，最多半小时后自动纠正 ✓
 */
const CACHE_TTL_MS = 30 * 60 * 1000

interface CacheEntry {
  value: DailySecrets
  atMs: number
}

let cache: CacheEntry | null = null

/** 仅供测试：清掉缓存 */
export function resetDailyCache(): void {
  cache = null
}

/** 从官方响应里取出密码列表。形状不对就抛错 —— 不猜、不返回空数组。 */
export function parseSecretsResponse(raw: unknown): DailySecret[] {
  const body = raw as {
    ret?: unknown
    jData?: { data?: { data?: { list?: unknown } } }
  }

  if (body?.ret !== 0) {
    throw new Error(`官方接口返回 ret=${String(body?.ret)}（非 0）—— 接口可能改了或需要登录`)
  }

  const list = body.jData?.data?.data?.list
  if (!Array.isArray(list)) {
    throw new Error('官方响应里找不到 jData.data.data.list —— 结构可能变了')
  }

  const out: DailySecret[] = []
  for (const raw of list) {
    const it = raw as { mapID?: unknown; mapName?: unknown; secret?: unknown }
    const mapName = typeof it.mapName === 'string' ? it.mapName.trim() : ''
    const secret = typeof it.secret === 'string' ? it.secret.trim() : String(it.secret ?? '').trim()
    if (mapName === '' || secret === '') continue

    out.push({
      mapId: typeof it.mapID === 'number' ? it.mapID : null,
      mapName,
      secret,
    })
  }

  if (out.length === 0) {
    // 抛错而不是返回空 —— 空列表会让页面显示"今天没有密码"，那是误导
    throw new Error('官方返回了 0 条密码 —— 保留上一次的结果更安全')
  }
  return out
}

/**
 * 取每日密码（带缓存）。
 *
 * 失败时**不覆盖缓存** —— 上一次的结果比"没有结果"有用得多，
 * 而且密码是按天变的，半小时前的值几乎一定是仍然正确的。
 * 这一点和刷新器对快照的处理是同一个思路（源站出错时保留旧数据）。
 */
export async function getDailySecrets(
  cfg: AppConfig,
  logger: Logger,
  options: { now?: () => number; force?: boolean } = {},
): Promise<DailySecrets> {
  const now = options.now ?? Date.now

  if (!options.force && cache !== null && now() - cache.atMs < CACHE_TTL_MS) {
    return cache.value
  }

  const http = new HttpClient(cfg, logger)
  const query = new URLSearchParams(SECRET_PARAMS).toString()

  try {
    const res = await http.request(`${AMS_ENDPOINT}?${query}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })

    if (!res.ok) {
      throw new Error(`官方接口返回 HTTP ${res.status}`)
    }

    const secrets = parseSecretsResponse(res.json())
    const value: DailySecrets = { secrets, fetchedAt: new Date(now()).toISOString() }
    cache = { value, atMs: now() }

    logger.info('每日密码已更新', { count: secrets.length })
    return value
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (cache !== null) {
      logger.warn('取每日密码失败，沿用上一次的结果', { error: message, keptFrom: cache.value.fetchedAt })
      return cache.value
    }
    throw new Error(`取每日密码失败：${message}`)
  }
}
